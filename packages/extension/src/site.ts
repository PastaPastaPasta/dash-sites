import { decide, describeResolution, HOST_API, type Manifest, type Resolution } from '@dash-sites/core';
import type { ChainSnapshot } from '@dash-sites/core/chain';
import { getSite, siteKey, type CachedSite } from './cache.js';
import { asFrameMessage, SITE_PORT, type OpenResult, type PageMessage, type WorkerReply } from './protocol.js';
import { dataUrl, NO_REFERRER, Rewriter, type SiteFile } from './render.js';
import { chainKey, displayAddress, gatewayUrl, loadSettings, parseTarget, siteOrigin, targetUrl, viewerHash, viewerUrl, type Settings, type Target } from './shared.js';

/** Chrome builds render in a sandboxed extension page that runs the site's scripts; Firefox has none, so its builds render without scripts. */
declare const __SANDBOX__: boolean;

const FRAME_SANDBOX = 'allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads';
const STATIC_SANDBOX = 'allow-popups allow-popups-to-escape-sandbox allow-top-navigation-by-user-activation';
/** A site Dash Platform proved current this recently is shown from the cache at once, and checked again behind it. */
const SERVE_CACHED_MS = 10 * 60_000;

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const short = (id: string): string => (id.length > 16 ? `${id.slice(0, 8)}…${id.slice(-6)}` : id);

type Badge = 'checking' | 'ok' | 'partial' | 'none' | 'error';

function badge(kind: Badge, text: string): void {
  $('badge').dataset.kind = kind;
  $('badge-text').textContent = text;
  // The text is hidden on narrow screens; the button keeps its name.
  $('badge').setAttribute('aria-label', `${text}. Show the verification details`);
}

function status(title: string, detail = '', kind: Badge = 'checking'): void {
  $('frame-slot').replaceChildren();
  $('status').hidden = false;
  $('status').dataset.kind = kind;
  $('status-title').textContent = title;
  $('status-detail').textContent = detail;
  $('status-actions').replaceChildren();
}

function action(label: string, onClick: () => void, quiet = false): void {
  const button = document.createElement('button');
  button.textContent = label;
  if (quiet) button.className = 'quiet';
  button.addEventListener('click', onClick);
  $('status-actions').append(button);
}

function facts(rows: [string, string, string?][]): void {
  const list = $('facts');
  list.replaceChildren();
  for (const [label, value, full] of rows) {
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.textContent = value;
    dd.title = full ?? value;
    list.append(dt, dd);
  }
}

interface LoadedSite {
  label: string;
  resolution: Extract<Resolution, { status: 'ok' }>;
  manifest: Manifest;
  files: Map<string, SiteFile>;
  /** Files listed in the manifest that this extension did not load: they are stored outside Dash Platform. */
  skipped: string[];
  /** Shown from the cache, and not yet checked again since. */
  cached: boolean;
  /** When Dash Platform last proved this record current. */
  checkedAt: number;
}

function ago(ms: number): string {
  const minutes = Math.round((Date.now() - ms) / 60000);
  return minutes < 1 ? 'just now' : `${minutes} min ago`;
}

/** Asks the background worker to open a name. Its progress messages go to `onProgress`. */
function request(label: string, onProgress: (message: string) => void): Promise<OpenResult> {
  return new Promise<OpenResult>((resolve, reject) => {
    const port = chrome.runtime.connect({ name: SITE_PORT });
    let settled = false;
    const settle = (finish: () => void): void => {
      if (settled) return;
      settled = true;
      port.disconnect();
      finish();
    };
    port.onMessage.addListener((message: WorkerReply) => {
      if (message.type === 'progress') onProgress(message.message);
      else if (message.type === 'result') settle(() => resolve(message.result));
      else settle(() => reject(new Error(message.message)));
    });
    port.onDisconnect.addListener(() => settle(() => reject(new WorkerStopped())));
    port.postMessage({ type: 'open', label });
  });
}

class WorkerStopped extends Error {
  constructor() {
    super('The extension’s background worker stopped before it answered.');
  }
}

/** `request`, asked again once if the worker stopped mid-way (the browser may stop an idle worker). */
async function open(label: string, onProgress: (message: string) => void): Promise<OpenResult> {
  try {
    return await request(label, onProgress);
  } catch (error) {
    if (!(error instanceof WorkerStopped)) throw error;
    return request(label, onProgress);
  }
}

class Viewer {
  private site?: LoadedSite;
  private target?: Target;
  private frame?: HTMLIFrameElement;
  /** The page the sandbox gets each time it says it is ready, including after the site reloads its frame. */
  private shown?: PageMessage;
  private generation = 0;

  constructor(private readonly settings: Settings) {}

  private loaded(cached: CachedSite, fromCache: boolean): LoadedSite {
    const files = new Map(cached.files.map((file) => [file.path, file]));
    // The host API every dash.site host answers, so a site that reads it works here too.
    const json = (path: string, value: unknown): void => {
      files.set(path, { path, type: 'application/json', bytes: new TextEncoder().encode(JSON.stringify(value)) });
    };
    json(`${HOST_API}site.json`, { ...describeResolution(cached.resolution, this.settings.network), servedBy: 'browser' });
    json(`${HOST_API}manifest.json`, cached.manifest);
    return { label: cached.resolution.canonicalLabel, resolution: cached.resolution, manifest: cached.manifest, files, skipped: cached.skipped, cached: fromCache, checkedAt: cached.checkedAt };
  }

  private async load(label: string, generation: number): Promise<LoadedSite | undefined> {
    if (this.site?.label === label) return this.site;
    const key = siteKey(this.settings.network, label);
    const cached = await getSite(key);
    if (generation !== this.generation) return undefined;
    if (cached && Date.now() - cached.checkedAt < SERVE_CACHED_MS) {
      this.site = this.loaded(cached, true);
      this.describe(cached.resolution, cached.checkedAt);
      void this.revalidate(label);
      return this.site;
    }
    status(`Opening ${label}.dash`, 'Asking the extension for the proven Dash chain state');
    badge('checking', 'Verifying…');
    const result = await open(label, (message) => {
      if (generation === this.generation && !this.site) $('status-detail').textContent = message;
    });
    if (generation !== this.generation) return undefined;
    if (result.kind === 'unavailable') {
      this.describe(result.resolution);
      this.unavailable(label, result.resolution);
      return undefined;
    }
    if (result.kind === 'external') {
      this.fail(`${label}.dash is stored outside Dash Platform`, `Its owner published it at ${result.content}. This extension only opens sites stored on Dash Platform.`);
      return undefined;
    }
    const fresh = await getSite(result.key);
    if (!fresh) throw new Error('The extension read the site but could not keep it. Try again.');
    if (generation !== this.generation) return undefined;
    this.site = this.loaded(fresh, false);
    this.describe(fresh.resolution, fresh.checkedAt);
    return this.site;
  }

  /** Checks a site shown from the cache against Dash Platform, and shows what changed if anything did. */
  private async revalidate(label: string): Promise<void> {
    let result: OpenResult;
    try {
      result = await open(label, () => undefined);
    } catch {
      if (this.site?.label === label && this.site.cached) badge(this.site.skipped.length ? 'partial' : 'ok', `Verified ${ago(this.site.checkedAt)} · could not check for updates`);
      return;
    }
    if (this.site?.label !== label || !this.target || this.target.label !== label) return;
    if (result.kind === 'site' && !result.changed) {
      const fresh = await getSite(result.key);
      this.site.cached = false;
      if (fresh) {
        this.site.checkedAt = fresh.checkedAt;
        this.describe(fresh.resolution, fresh.checkedAt);
      }
      this.verified(this.site);
      return;
    }
    // A newer revision, or no site any more: show what Dash Platform proves now.
    this.site = undefined;
    void this.show(this.target);
  }

  private verified(site: LoadedSite): void {
    const missing = site.skipped.length;
    const checking = site.cached ? ' · checking for updates' : '';
    badge(missing ? 'partial' : 'ok', missing ? `Verified · ${missing} file${missing === 1 ? '' : 's'} not loaded${checking}` : `Verified from Dash Platform${checking}`);
  }

  private describe(resolution: Resolution, checkedAt?: number): void {
    const rows: [string, string, string?][] = [];
    if ('ownerId' in resolution) rows.push(['Owner', short(resolution.ownerId), resolution.ownerId]);
    if ('site' in resolution) {
      rows.push(['Revision', String(resolution.site.revision)]);
      rows.push(['Published', new Date(resolution.site.updatedAt).toLocaleString()]);
    }
    if ('meta' in resolution) rows.push(['Proved at', `Platform block ${resolution.meta.height}`, new Date(resolution.meta.timeMs).toLocaleString()]);
    if (checkedAt) rows.push(['Checked', ago(checkedAt), new Date(checkedAt).toLocaleString()]);
    rows.push(['Network', this.settings.network]);
    facts(rows);
    const key = chainKey(this.settings.network);
    void chrome.storage.local.get(key).then((stored) => {
      const snapshot = stored[key] as ChainSnapshot | undefined;
      if (!snapshot) return;
      const network = rows.pop() as [string, string];
      facts([...rows, ['Quorum keys', `Core block ${snapshot.listHeight}`, snapshot.listBlockHash], ['Nodes', `${snapshot.nodes.length} from the masternode list`], network]);
    });
  }

  private unavailable(label: string, resolution: Resolution): void {
    const titles: Record<string, [string, string]> = {
      invalid: [`${label}.dash is not a valid name`, 'Dash names are 3 to 63 letters, digits and hyphens.'],
      unregistered: [`${label}.dash is not registered`, 'Dash Platform proves that no one has registered this name.'],
      'no-site': [`${label}.dash has no site`, 'The name is registered, and its owner has not published a site.'],
      unsupported: [`${label}.dash needs a newer extension`, 'The owner published the site in a format this version cannot read.'],
    };
    const [title, detail] = titles[resolution.status] ?? ['No site', ''];
    badge(resolution.status === 'invalid' ? 'error' : 'none', resolution.status === 'invalid' ? 'Invalid name' : 'Proved: no site');
    status(title, detail, 'none');
    document.title = `${label}.dash`;
  }

  private fail(title: string, detail: string): void {
    badge('error', 'Not verified');
    status(title, detail, 'error');
    const target = this.target;
    const fallback = target ? gatewayUrl(this.settings, target) : undefined;
    if (target) action('Try again', () => void this.show(target, true));
    if (fallback) action(`Open on ${new URL(fallback).host.replace(/^[^.]+\./, '')}`, () => location.assign(fallback), true);
  }

  /** The page to show at `url`: a site file, or a page this viewer makes for a file that is not HTML. */
  private page(site: LoadedSite, url: URL): { html: string; status: number } | { redirect: string } {
    const decision = decide(site.manifest, url.pathname, url.search);
    if (decision.kind === 'redirect') return { redirect: new URL(decision.location, url).href };
    const file = decision.kind === 'file' ? site.files.get(decision.path) : undefined;
    if (!file) {
      const missing = decision.kind === 'file' && site.skipped.includes(decision.path);
      const body = missing ? 'This file is stored outside Dash Platform, and this extension only loads files from Dash Platform.' : 'This site has no page at this address.';
      return { html: `<!doctype html><title>Not found</title><style>body{font:16px system-ui;margin:4rem auto;max-width:36rem;padding:0 1rem}</style><h1>Not found</h1><p>${body}</p>`, status: 404 };
    }
    if (/^text\/html/.test(file.type)) return { html: new TextDecoder().decode(file.bytes), status: decision.kind === 'file' ? decision.status : 200 };
    const name = file.path.split('/').pop() ?? file.path;
    const inner = file.type.startsWith('image/') ? `<img src="${file.path}" alt="" style="max-width:100%">` : `<p><a href="${file.path}" download="${name}">Download ${name}</a></p>`;
    return { html: `<!doctype html><title>${name}</title><body style="margin:1rem;font:15px system-ui">${inner}</body>`, status: 200 };
  }

  async show(target: Target, retry = false): Promise<void> {
    const generation = ++this.generation;
    this.target = target;
    if (retry) this.site = undefined;
    $<HTMLInputElement>('address').value = displayAddress(target);
    try {
      const site = await this.load(target.label, generation);
      if (!site || generation !== this.generation) return;
      const url = new URL(targetUrl(target));
      const page = this.page(site, url);
      if ('redirect' in page) {
        const next = parseTarget(page.redirect);
        if (next) this.go(next, true);
        return;
      }
      this.verified(site);
      this.render(site, url, page.html);
    } catch (error) {
      if (generation !== this.generation) return;
      this.fail(`Could not open ${target.label}.dash`, (error as Error)?.message ?? String(error));
    }
  }

  private render(site: LoadedSite, url: URL, html: string): void {
    $('status').hidden = true;
    document.title = `${site.resolution.canonicalLabel}.dash`;
    const frame = document.createElement('iframe');
    frame.id = 'frame';
    frame.title = `${site.label}.dash`;
    frame.setAttribute('referrerpolicy', 'no-referrer');
    this.frame = frame;
    const page: PageMessage = { type: 'page', origin: siteOrigin(site.label), url: url.href, html, files: [...site.files.values()] };
    if (__SANDBOX__) {
      frame.setAttribute('sandbox', FRAME_SANDBOX);
      frame.src = chrome.runtime.getURL(`sandbox.html#${url.href}`);
      this.shown = page;
    } else {
      frame.setAttribute('sandbox', STATIC_SANDBOX);
      const linkTo = (link: URL): string | undefined => {
        const next = link.hostname.endsWith('.dash') ? parseTarget(link.href) : undefined;
        return next ? viewerUrl(next) : undefined;
      };
      const rewriter = new Rewriter({ origin: page.origin, url: page.url, html, files: site.files }, dataUrl, false, linkTo);
      frame.srcdoc = rewriter.document(NO_REFERRER);
    }
    $('frame-slot').replaceChildren(frame);
  }

  /** Messages from the sandbox, which runs the site's code: only shape-checked requests are honoured. */
  onMessage(event: MessageEvent): void {
    if (!this.frame || event.source !== this.frame.contentWindow || event.origin !== 'null') return;
    const message = asFrameMessage(event.data);
    if (!message || !this.target) return;
    switch (message.type) {
      case 'ready': {
        const page = this.shown;
        if (!page) return;
        if (message.url && message.url !== page.url) {
          // The site moved its own frame (location.href = …): show that address instead. The frame's
          // own navigation already made a history entry, so this one replaces the current entry.
          const next = parseTarget(message.url);
          if (next) this.go(next, true);
          return;
        }
        this.frame.contentWindow?.postMessage(page, '*');
        return;
      }
      case 'navigate': {
        const next = parseTarget(message.url);
        if (next) this.go(next, message.replace);
        return;
      }
      case 'location': {
        const next = parseTarget(message.url);
        if (next && next.label === this.target.label) {
          this.target = next;
          history.replaceState(null, '', viewerHash(next));
          $<HTMLInputElement>('address').value = displayAddress(next);
        }
        return;
      }
      case 'title': {
        const title = message.title.trim();
        document.title = title ? `${title} · ${this.target.label}.dash` : `${this.target.label}.dash`;
        return;
      }
      case 'leave': {
        const url = new URL(message.url);
        if (url.protocol === 'https:' || url.protocol === 'http:') location.assign(url.href);
        return;
      }
    }
  }

  go(target: Target, replace = false): void {
    const hash = viewerHash(target);
    if (location.hash === hash) return void this.show(target);
    if (replace) history.replaceState(null, '', hash);
    else history.pushState(null, '', hash);
    void this.show(target);
  }
}

async function main(): Promise<void> {
  if (window.top !== window) {
    document.body.textContent = '';
    return;
  }
  const settings = await loadSettings();
  const viewer = new Viewer(settings);
  window.addEventListener('message', (event) => viewer.onMessage(event));
  $('badge').addEventListener('click', () => {
    const open = $('details').hidden;
    $('details').hidden = !open;
    $('badge').setAttribute('aria-expanded', String(open));
  });
  $<HTMLFormElement>('go').addEventListener('submit', (event) => {
    event.preventDefault();
    const target = parseTarget($<HTMLInputElement>('address').value);
    if (target) viewer.go(target);
    else $<HTMLInputElement>('address').setCustomValidity('Enter a name such as alice.dash');
  });
  $<HTMLInputElement>('address').addEventListener('input', (event) => (event.target as HTMLInputElement).setCustomValidity(''));
  $('settings').addEventListener('click', () => void chrome.runtime.openOptionsPage());
  if (!__SANDBOX__) $('mode').hidden = false;
  const open = (): void => {
    // The hash is already percent-encoded (the redirect rules copy the request's path as it is), so it is parsed, not decoded.
    const target = parseTarget(location.hash.slice(1));
    if (target) void viewer.show(target);
    else {
      badge('none', 'No site open');
      status('Open a .dash site', 'Type a name such as alice.dash in the box above, or in the address bar.', 'none');
      $<HTMLInputElement>('address').focus();
    }
  };
  window.addEventListener('popstate', open);
  open();
}

void main();
