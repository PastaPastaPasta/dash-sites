import {
  ContentError,
  ExternalAssetError,
  cdnSource,
  integrityOfAsync,
  type ExternalSource,
  HOST_API,
  ManifestError,
  DENIED_TITLE,
  dashHeaders,
  deniedDetail,
  decide,
  describeResolution,
  escapeHtml,
  hostPage,
  loadManifest,
  messagePage,
  nameFromPath,
  readFile,
  resolveName,
  sha256Hex,
  type ChunkSource,
  type Manifest,
  type PlatformReader,
  type Resolution,
} from '@dash-sites/core';

/**
 * What the host keeps between runs. Site code shares the origin and can rewrite or delete it,
 * so it is never the source of what is served: it only tells a new worker which owner the
 * browser's stored data belongs to. Missing or malformed state means "unknown", which is
 * treated as a change of owner.
 */
export interface Saved {
  /** Owner and transfer time of the name when its data was last cleared. */
  epoch: string;
  /** Page storage the worker cannot reach still holds a previous owner's data. */
  resetPending: boolean;
}

export function parseSaved(value: unknown): Saved | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { epoch, resetPending } = value as Record<string, unknown>;
  return typeof epoch === 'string' && typeof resetPending === 'boolean' ? { epoch, resetPending } : undefined;
}

export interface Store {
  /** Whatever was saved, unchecked. */
  loadState(): Promise<unknown>;
  saveState(state: Saved): Promise<void>;
  getChunk(hash: string): Promise<Uint8Array | undefined>;
  putChunk(hash: string, data: Uint8Array): Promise<void>;
  /** Removes everything the origin has stored that a worker can reach. */
  wipe(): Promise<void>;
}

export interface Reply {
  status: number;
  headers: Record<string, string>;
  body?: Uint8Array | string;
}

export interface HostRequest {
  url: URL;
  /** A page load, as opposed to a request made by a page. */
  navigation: boolean;
  /** A page load in a tab or window of its own, not in a frame. Defaults to `navigation`. */
  topLevel?: boolean;
  range?: string | null;
  /** Keeps the worker alive for work that outlives the reply. */
  waitUntil?: (work: Promise<unknown>) => void;
}

export interface HostOptions {
  /** The first label of the host the site is served under. */
  label: string;
  network: string;
  reader: () => Promise<PlatformReader>;
  store: Store;
  builderUrl: string;
  now?: () => number;
  /** The name changed owner while this worker was serving it: open pages show the previous owner's site. */
  onOwnerChange?: () => void;
  nonce?: () => string;
  /** Hosted gateways only: whether the operator has stopped serving this name, owner or content. */
  denied?: (resolution: Resolution) => Promise<boolean>;
  log?: (entry: Record<string, unknown>) => void;
  /** Where external npm assets are fetched from; defaults to the npm CDNs. Bytes are checked either way. */
  external?: ExternalSource;
}

type Ok = Extract<Resolution, { status: 'ok' }>;

const FRESH_MS = 30_000;
export const RESET_PATH = `${HOST_API}reset`;
/** Where a page goes to have its storage cleared before returning to `url`. */
export const resetLocation = (url: URL): string => `${RESET_PATH}#${encodeURIComponent(url.pathname + url.search)}`;

const epochOf = (resolution: Resolution): string => ('ownerId' in resolution ? `${resolution.ownerId}.${resolution.domain.transferredAt}` : '');

const resetPage = (nonce: string): string =>
  hostPage(
    'Clearing old data',
    `<h1>One moment</h1><p>Data a previous owner of this name may have stored in this browser is being removed.</p>
<script>
try{localStorage.clear();sessionStorage.clear();}catch(e){}
document.cookie.split(';').forEach(function(c){document.cookie=c.split('=')[0].trim()+'=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/';});
function back(){var to=location.origin+'/';try{var u=new URL(decodeURIComponent(location.hash.slice(1)),location.origin);if(u.origin===location.origin)to=u.href;}catch(e){}location.replace(to);}
fetch('${RESET_PATH}?done=${nonce}',{cache:'no-store'}).then(back,back);
</script>`,
  );

/**
 * Serves one name's site from Dash Platform. Runs wherever the proofs are checked: in the
 * visitor's browser as a service worker, with `reader` talking to Platform nodes directly.
 */
export class SiteHost {
  private readonly now: () => number;
  private answer?: { resolution: Resolution; at: number };
  private saved?: Saved;
  private refreshing?: Promise<Resolution>;
  private resetNonce?: string;
  private readonly manifests = new Map<string, Promise<Manifest>>();

  constructor(private readonly options: HostOptions) {
    this.now = options.now ?? Date.now;
  }

  /** Whether Platform has answered since this host started. */
  get proved(): boolean {
    return this.answer !== undefined;
  }

  /** Starts the first check, or joins the one under way. */
  prove(): Promise<Resolution> {
    return this.refresh();
  }

  /**
   * The site to serve now. A new worker serves nothing until Platform has answered: a site kept
   * from an earlier run could be a previous owner's, and running its code would let it tamper
   * with the saved state before the check finishes. After that, answers are reused for 30
   * seconds and then refreshed without making the page wait.
   */
  private async current(request: HostRequest): Promise<Resolution> {
    if (!this.answer) return this.refresh();
    if (this.now() - this.answer.at >= FRESH_MS) {
      const work = this.refresh().catch((error: unknown) => this.options.log?.({ event: 'refresh-failed', error: String(error) }));
      request.waitUntil?.(work);
    }
    return this.answer.resolution;
  }

  private refresh(): Promise<Resolution> {
    this.refreshing ??= this.check().finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }

  private async check(): Promise<Resolution> {
    const resolution = await resolveName(await this.options.reader(), this.options.label);
    const before = this.answer?.resolution;
    if (before && 'meta' in resolution && 'meta' in before && resolution.meta.height < before.meta.height) return before;
    if (!before) this.saved = parseSaved(await this.options.store.loadState().catch(() => undefined));
    const epoch = epochOf(resolution);
    const ownerChanged = (before ? epochOf(before) : this.saved?.epoch) !== epoch;
    if (ownerChanged) {
      await this.options.store.wipe().catch((error: unknown) => this.options.log?.({ event: 'wipe-failed', error: String(error) }));
      this.manifests.clear();
      this.saved = { epoch, resetPending: true };
      await this.options.store.saveState(this.saved).catch(() => undefined);
    }
    this.answer = { resolution, at: this.now() };
    if (ownerChanged && before) this.options.onOwnerChange?.();
    return resolution;
  }

  /**
   * The page that clears what only a page can reach. It is served, with a one-time code, only to
   * a top-level page load while a reset is pending, and the reset stays pending until that page
   * reports back with the code, so a link to this address cannot erase a site's data and a frame can
   * neither dismiss the reset nor replace the code of one in progress.
   */
  private async reset(request: HostRequest): Promise<Reply> {
    const done = request.url.searchParams.get('done');
    if (done !== null) {
      if (this.saved?.resetPending && done === this.resetNonce) {
        this.saved = { ...this.saved, resetPending: false };
        this.resetNonce = undefined;
        await this.options.store.saveState(this.saved).catch(() => undefined);
      }
      return { status: 204, headers: { 'Cache-Control': 'no-store' } };
    }
    if (!(request.topLevel ?? request.navigation) || !this.saved?.resetPending) return { status: 302, headers: { Location: '/', 'Cache-Control': 'no-store' } };
    this.resetNonce ??= (this.options.nonce ?? (() => crypto.randomUUID()))();
    return {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'",
      },
      body: resetPage(this.resetNonce),
    };
  }

  private chunks(ownerId: string): ChunkSource {
    return async (hashes) => {
      const out = new Map<string, Uint8Array>();
      const missing: string[] = [];
      for (const hash of new Set(hashes)) {
        const kept = await this.options.store.getChunk(hash).catch(() => undefined);
        if (kept && sha256Hex(kept) === hash) out.set(hash, kept);
        else missing.push(hash);
      }
      if (missing.length === 0) return out;
      for (const [hash, data] of await (await this.options.reader()).getChunks(ownerId, missing)) {
        if (sha256Hex(data) !== hash) continue;
        out.set(hash, data);
        void this.options.store.putChunk(hash, data).catch(() => undefined);
      }
      return out;
    };
  }

  /** External npm assets, kept in the origin's storage once verified and checked again whenever they are read back. */
  private external(): ExternalSource {
    const fetchExternal = this.options.external ?? cdnSource();
    return async (asset, size) => {
      const key = `ext/${asset.integrity}`;
      const kept = await this.options.store.getChunk(key).catch(() => undefined);
      if (kept && kept.length === size && (await integrityOfAsync(kept)) === asset.integrity) return kept;
      const bytes = await fetchExternal(asset, size);
      void this.options.store.putChunk(key, bytes).catch(() => undefined);
      return bytes;
    };
  }

  private manifestFor(resolution: Ok): Promise<Manifest> {
    const ref = resolution.content;
    if (ref.scheme !== 'dash-manifest') return Promise.reject(new ContentError('not stored on Dash Platform'));
    const key = `${resolution.ownerId}/${resolution.site.content}`;
    let manifest = this.manifests.get(key);
    if (!manifest) {
      manifest = loadManifest(ref, this.chunks(resolution.ownerId));
      this.manifests.set(key, manifest);
      manifest.catch(() => this.manifests.delete(key));
    }
    return manifest;
  }

  private page(status: number, label: string, title: string, detail: string): Reply {
    return {
      status,
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'none'; frame-ancestors 'none'" },
      body: messagePage(label, title, detail, this.options),
    };
  }

  private json(status: number, value: unknown): Reply {
    return { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }, body: JSON.stringify(value) };
  }

  private async lookup(rawName: string): Promise<Reply> {
    const parsed = nameFromPath(rawName);
    if (!parsed) return this.json(400, { status: 'invalid' });
    return this.json(200, describeResolution(await resolveName(await this.options.reader(), parsed.normalized), this.options.network));
  }

  async respond(request: HostRequest): Promise<Reply> {
    const { url } = request;
    const dashName = `${escapeHtml(this.options.label)}.dash`;
    let resolution: Resolution;
    try {
      resolution = await this.current(request);
    } catch (error) {
      this.options.log?.({ event: 'resolve-failed', error: String(error) });
      if (url.pathname.startsWith(HOST_API)) return this.json(503, { status: 'unavailable' });
      return this.page(503, 'Unavailable', 'Dash Platform could not be reached', `Your browser could not get a proved answer about <code>${dashName}</code> from Dash Platform. Reload to try again.`);
    }
    if (url.pathname === RESET_PATH) return this.reset(request);
    if (await this.options.denied?.(resolution)) {
      if (url.pathname.startsWith(HOST_API)) return this.json(451, { status: 'unavailable' });
      return this.page(451, '451', DENIED_TITLE, deniedDetail(dashName));
    }
    if (request.navigation && this.saved?.resetPending) {
      if (request.topLevel ?? true) return { status: 302, headers: { Location: resetLocation(url), 'Cache-Control': 'no-store' } };
      return this.page(503, 'Unavailable', `${dashName} cannot be shown in a frame yet`, 'Open it in a tab of its own first, so that data left in this browser by a previous owner of the name can be removed.');
    }
    if (url.pathname.startsWith(HOST_API)) {
      const path = url.pathname.slice(HOST_API.length);
      if (path === 'site.json') return this.json(200, { ...describeResolution(resolution, this.options.network), servedBy: 'browser' });
      if (path.startsWith('resolve/')) return this.lookup(path.slice('resolve/'.length));
      if (path !== 'manifest.json') return this.json(404, { status: 'not-found' });
    }
    if (resolution.status === 'invalid') return this.page(404, '404', 'Not a DPNS name', 'This host is not a valid Dash Platform name.');
    if (resolution.status === 'unregistered') return this.page(404, 'Not registered', `${dashName} is not registered`, 'Nobody owns this name on Dash Platform yet.');
    if (resolution.canonicalLabel !== this.options.label) {
      const target = new URL(url.href);
      target.hostname = [resolution.canonicalLabel, ...url.hostname.split('.').slice(1)].join('.');
      return { status: 308, headers: { Location: target.href } };
    }
    if (resolution.status === 'no-site') {
      return this.page(404, 'No site', `${dashName} has no site yet`, `The name is registered, and its owner has not published a site. If it is yours, <a href="${escapeHtml(this.options.builderUrl)}">publish one</a>.`);
    }
    if (resolution.status === 'unsupported' || resolution.content.scheme !== 'dash-manifest') {
      return this.page(502, 'Unsupported', `${dashName} cannot be shown here`, `Its site record points at <code>${escapeHtml(resolution.site.content.slice(0, 80))}</code>, which this gateway does not load.`);
    }

    let manifest: Manifest;
    try {
      manifest = await this.manifestFor(resolution);
    } catch (error) {
      if (!(error instanceof ContentError) && !(error instanceof ManifestError)) throw error;
      return this.page(502, 'Unavailable', `${dashName} cannot be shown`, 'Its published content is incomplete or does not match the hashes its owner published.');
    }
    if (url.pathname === `${HOST_API}manifest.json`) return this.json(200, manifest);

    const decision = decide(manifest, url.pathname, url.search);
    if (decision.kind === 'redirect') return { status: 301, headers: { Location: decision.location } };
    if (decision.kind === 'not-found') return this.page(404, '404', 'Page not found', `<code>${dashName}</code> has no page at this address.`);
    let file: Awaited<ReturnType<typeof readFile>>;
    try {
      file = await readFile(manifest, decision.path, this.chunks(resolution.ownerId), this.external());
    } catch (error) {
      if (error instanceof ExternalAssetError) {
        this.options.log?.({ event: 'external-refused', asset: `${error.asset.npm}@${error.asset.version}/${error.asset.path}`, attempts: error.attempts });
        const name = escapeHtml(`${error.asset.npm}@${error.asset.version}`);
        const [title, detail] = error.mismatch
          ? [
              'Part of this site could not be checked',
              `This site uses a file from the npm package <code>${name}</code>. Your browser fetched it from public npm mirrors, and no copy matched the fingerprint its owner published on Dash Platform, so it was not used. Nothing from it ran. Reload in a little while; if it keeps happening, tell the site's owner.`,
            ]
          : error.missing
            ? [
                'Part of this site is no longer available',
                `This site uses a file from the npm package <code>${name}</code>, and the public npm mirrors (cdn.jsdelivr.net, unpkg.com) no longer have it. Nothing from it ran. Tell the site's owner: the site needs to be published again.`,
              ]
            : [
                'Part of this site could not be downloaded',
                `This site uses a file from the npm package <code>${name}</code>, which your browser could not download from the public npm mirrors (cdn.jsdelivr.net, unpkg.com). Nothing from it ran. Check your connection, or whether something blocks those addresses, and reload.`,
              ];
        return this.page(502, 'Not loaded', title, detail);
      }
      if (!(error instanceof ContentError)) throw error;
      return this.page(502, 'Unavailable', 'This file cannot be shown', 'Its stored content is incomplete or does not match the hash its owner published.');
    }
    const headers: Record<string, string> = {
      'Content-Type': file.file.type,
      ETag: `"${file.file.sha256}"`,
      'Cache-Control': 'no-store',
      'Accept-Ranges': 'bytes',
      'X-Content-Type-Options': 'nosniff',
      ...dashHeaders(resolution),
    };
    const range = decision.status === 200 ? parseRange(request.range, file.bytes.length) : undefined;
    if (range === 'unsatisfiable') return { status: 416, headers: { ...headers, 'Content-Range': `bytes */${file.bytes.length}` } };
    if (range) {
      return { status: 206, headers: { ...headers, 'Content-Range': `bytes ${range[0]}-${range[1]}/${file.bytes.length}` }, body: file.bytes.subarray(range[0], range[1] + 1) };
    }
    return { status: decision.status, headers, body: file.bytes };
  }
}

/** Parses a single `bytes=` range. Anything else, including a range that ends before it starts, is answered with the whole file. */
export function parseRange(header: string | null | undefined, size: number): [number, number] | 'unsatisfiable' | undefined {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header?.trim() ?? '');
  if (!match || (match[1] === '' && match[2] === '')) return undefined;
  if (match[1] === '') {
    const length = Math.min(Number(match[2]), size);
    return length > 0 ? [size - length, size - 1] : 'unsatisfiable';
  }
  const start = Number(match[1]);
  if (match[2] !== '' && Number(match[2]) < start) return undefined;
  const end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1);
  return start < size ? [start, end] : 'unsatisfiable';
}
