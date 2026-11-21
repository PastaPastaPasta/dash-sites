import {
  ContentError,
  HOST_API,
  ManifestError,
  dashHeaders,
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

/** What the host keeps between runs. Site code shares the origin and can rewrite it, so nothing here is trusted: see `current`. */
export interface Saved {
  resolution: Resolution;
  /** Page storage the worker cannot reach still holds the previous owner's data. */
  resetPending: boolean;
}

export interface Store {
  loadState(): Promise<Saved | undefined>;
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
  /** A check against Platform found a different site than the one already shown. */
  onChange?: (kind: 'content' | 'owner') => void;
  log?: (entry: Record<string, unknown>) => void;
}

type Ok = Extract<Resolution, { status: 'ok' }>;

const FRESH_MS = 30_000;
/** How long after showing a saved site a newer one may replace it by reloading the page. */
const RELOAD_WINDOW_MS = 20_000;
export const RESET_PATH = `${HOST_API}reset`;
/** Where a page goes to have its storage cleared before returning to `url`. */
export const resetLocation = (url: URL): string => `${RESET_PATH}#${encodeURIComponent(url.pathname + url.search)}`;

const epochOf = (resolution: Resolution): string | undefined =>
  'ownerId' in resolution ? `${resolution.ownerId}.${resolution.domain.transferredAt}` : undefined;
const contentOf = (resolution: Resolution): string => ('site' in resolution ? resolution.site.content : resolution.status);

const RESET_PAGE = hostPage(
  'Clearing old data',
  `<h1>One moment</h1><p>This name has a new owner. Data the previous owner's site stored in this browser is being removed.</p>
<script>
try{localStorage.clear();sessionStorage.clear();}catch(e){}
document.cookie.split(';').forEach(function(c){document.cookie=c.split('=')[0].trim()+'=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/';});
var to=decodeURIComponent(location.hash.slice(1));
location.replace(to.charAt(0)==='/'&&to.charAt(1)!=='/'?to:'/');
</script>`,
);

/**
 * Serves one name's site from Dash Platform. Runs wherever the proofs are checked: in the
 * visitor's browser as a service worker, with `reader` talking to Platform nodes directly.
 */
export class SiteHost {
  private readonly now: () => number;
  /** Set once Platform has answered in this run; saved state never counts. */
  private proved?: { resolution: Resolution; at: number };
  private saved?: Saved;
  private loaded = false;
  private refreshing?: Promise<Resolution>;
  private shownSavedAt = 0;
  private readonly manifests = new Map<string, Promise<Manifest>>();

  constructor(private readonly options: HostOptions) {
    this.now = options.now ?? Date.now;
  }

  /**
   * The site to serve now. Saved state is shown at once and checked against Platform in the
   * background every time, whatever its age says, because the previous owner's code could have written it.
   */
  private async current(request: HostRequest): Promise<Resolution> {
    if (this.proved) {
      if (this.now() - this.proved.at >= FRESH_MS) this.background(request);
      return this.proved.resolution;
    }
    if (!this.loaded) {
      this.saved = await this.options.store.loadState().catch(() => undefined);
      this.loaded = true;
    }
    if (!this.saved) return this.refresh();
    if (request.navigation) this.shownSavedAt = this.now();
    this.background(request);
    return this.saved.resolution;
  }

  private background(request: HostRequest): void {
    const work = this.refresh().catch((error: unknown) => this.options.log?.({ event: 'refresh-failed', error: String(error) }));
    request.waitUntil?.(work);
  }

  private refresh(): Promise<Resolution> {
    this.refreshing ??= this.check().finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }

  private async check(): Promise<Resolution> {
    const resolution = await resolveName(await this.options.reader(), this.options.label);
    if (this.proved && 'meta' in resolution && 'meta' in this.proved.resolution && resolution.meta.height < this.proved.resolution.meta.height) {
      return this.proved.resolution;
    }
    const before = this.proved?.resolution ?? this.saved?.resolution;
    const ownerChanged = before !== undefined && epochOf(before) !== undefined && epochOf(before) !== epochOf(resolution);
    const contentChanged = before !== undefined && contentOf(before) !== contentOf(resolution);
    if (ownerChanged) {
      await this.options.store.wipe();
      this.manifests.clear();
    }
    this.proved = { resolution, at: this.now() };
    this.saved = { resolution, resetPending: ownerChanged || (this.saved?.resetPending ?? false) };
    await this.options.store.saveState(this.saved).catch(() => undefined);
    if (ownerChanged) this.options.onChange?.('owner');
    else if (contentChanged && this.now() - this.shownSavedAt < RELOAD_WINDOW_MS) this.options.onChange?.('content');
    return resolution;
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
    if (url.pathname === RESET_PATH) {
      return { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }, body: RESET_PAGE };
    }
    const dashName = `${escapeHtml(this.options.label)}.dash`;
    let resolution: Resolution;
    try {
      resolution = await this.current(request);
    } catch (error) {
      this.options.log?.({ event: 'resolve-failed', error: String(error) });
      return this.page(503, 'Unavailable', 'Dash Platform could not be reached', `Your browser could not get a proved answer about <code>${dashName}</code> from Dash Platform. Reload to try again.`);
    }
    if (request.navigation && this.saved?.resetPending) {
      this.saved = { ...this.saved, resetPending: false };
      await this.options.store.saveState(this.saved).catch(() => undefined);
      return { status: 302, headers: { Location: resetLocation(url), 'Cache-Control': 'no-store' } };
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
      file = await readFile(manifest, decision.path, this.chunks(resolution.ownerId));
    } catch (error) {
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

/** Parses a single `bytes=` range. Anything else is answered with the whole file. */
export function parseRange(header: string | null | undefined, size: number): [number, number] | 'unsatisfiable' | undefined {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header?.trim() ?? '');
  if (!match || (match[1] === '' && match[2] === '')) return undefined;
  if (match[1] === '') {
    const length = Math.min(Number(match[2]), size);
    return length > 0 ? [size - length, size - 1] : 'unsatisfiable';
  }
  const start = Number(match[1]);
  const end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1);
  return start < size && start <= end ? [start, end] : 'unsatisfiable';
}
