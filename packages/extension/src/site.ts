import { decide, describeResolution, HOST_API, loadManifest, readerConfig, readFile, resolveName, siteChunks, type Manifest, type PlatformReader, type Resolution } from '@dash-sites/core';
import { ChainKeeper, pickNodes } from './chain.js';
import { asFrameMessage, type PageMessage } from './protocol.js';
import { dataUrl, NO_REFERRER, Rewriter, type SiteFile } from './render.js';
import { displayAddress, gatewayUrl, loadSettings, parseTarget, siteOrigin, targetUrl, viewerHash, viewerUrl, type Settings, type Target } from './shared.js';

/** Chrome builds render in a sandboxed extension page that runs the site's scripts; Firefox has none, so its builds render without scripts. */
declare const __SANDBOX__: boolean;
declare global {
  var dashSitesSdk: WebAssembly.Module | undefined;
}

const FRAME_SANDBOX = 'allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads';
const STATIC_SANDBOX = 'allow-popups allow-popups-to-escape-sandbox allow-top-navigation-by-user-activation';
const MAX_SITE_BYTES = 64 << 20;
const NODES = 16;

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const short = (id: string): string => (id.length > 16 ? `${id.slice(0, 8)}…${id.slice(-6)}` : id);

type Badge = 'checking' | 'ok' | 'partial' | 'none' | 'error';

function badge(kind: Badge, text: string): void {
  $('badge').dataset.kind = kind;
  $('badge-text').textContent = text;
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
}

class Viewer {
  private readonly keeper: ChainKeeper;
  private reader?: Promise<PlatformReader>;
  private site?: LoadedSite;
  private target?: Target;
  private frame?: HTMLIFrameElement;
  /** The page the sandbox gets each time it says it is ready, including after the site reloads its frame. */
  private shown?: PageMessage;
  private generation = 0;

  constructor(private readonly settings: Settings) {
    this.keeper = new ChainKeeper(settings.network, (message) => {
      if (!this.site) $('status-detail').textContent = message;
    });
  }

  private connect(): Promise<PlatformReader> {
    this.reader ??= (async () => {
      const [snapshot, module] = await Promise.all([this.keeper.get(), WebAssembly.compileStreaming(fetch(chrome.runtime.getURL('verifier.wasm')))]);
      globalThis.dashSitesSdk = module;
      const { EvoReader } = await import('@dash-sites/core/evo');
      return EvoReader.connect(readerConfig(this.settings.network), { addresses: pickNodes(snapshot.nodes, NODES), quorums: () => this.keeper.forQuorums() });
    })();
    this.reader.catch(() => {
      this.reader = undefined;
    });
    return this.reader;
  }

  private async load(label: string, generation: number): Promise<LoadedSite | undefined> {
    if (this.site?.label === label) return this.site;
    status(`Opening ${label}.dash`, 'Verifying the Dash chain from this extension’s checkpoint');
    badge('checking', 'Verifying…');
    const reader = await this.connect();
    if (generation !== this.generation) return undefined;
    $('status-detail').textContent = 'Reading the name and its site from Dash Platform, with proofs';
    const resolution = await resolveName(reader, label, { preload: true });
    if (generation !== this.generation) return undefined;
    this.describe(resolution);
    if (resolution.status !== 'ok') {
      this.unavailable(label, resolution);
      return undefined;
    }
    if (resolution.content.scheme !== 'dash-manifest') {
      this.fail(`${label}.dash is stored outside Dash Platform`, `Its owner published it at ${resolution.site.content}. This extension only opens sites stored on Dash Platform.`);
      return undefined;
    }
    const source = siteChunks(reader, resolution);
    const manifest = await loadManifest(resolution.content, source);
    const files = new Map<string, SiteFile>();
    const skipped: string[] = [];
    const paths = Object.keys(manifest.files);
    let total = 0;
    let done = 0;
    const queue = [...paths];
    const worker = async (): Promise<void> => {
      for (let path = queue.shift(); path !== undefined; path = queue.shift()) {
        const entry = manifest.files[path];
        if (!entry || entry.ext || entry.src || entry.unread) {
          skipped.push(path);
          continue;
        }
        total += entry.size;
        if (total > MAX_SITE_BYTES) throw new Error(`${label}.dash is larger than this viewer opens (${MAX_SITE_BYTES >> 20} MB)`);
        const { bytes } = await readFile(manifest, path, source);
        files.set(path, { path, type: entry.type, bytes });
        done++;
        if (generation === this.generation) $('status-detail').textContent = `Checking files against their published hashes: ${done} of ${paths.length}`;
      }
    };
    await Promise.all(Array.from({ length: 4 }, worker));
    if (generation !== this.generation) return undefined;
    // The host API every dash.site host answers, so a site that reads it works here too.
    const json = (path: string, value: unknown): void => {
      files.set(path, { path, type: 'application/json', bytes: new TextEncoder().encode(JSON.stringify(value)) });
    };
    json(`${HOST_API}site.json`, { ...describeResolution(resolution, this.settings.network), servedBy: 'browser' });
    json(`${HOST_API}manifest.json`, manifest);
    this.site = { label, resolution, manifest, files, skipped };
    return this.site;
  }

  private describe(resolution: Resolution): void {
    const snapshot = this.keeper.current;
    const rows: [string, string, string?][] = [];
    if ('ownerId' in resolution) rows.push(['Owner', short(resolution.ownerId), resolution.ownerId]);
    if ('site' in resolution) {
      rows.push(['Revision', String(resolution.site.revision)]);
      rows.push(['Published', new Date(resolution.site.updatedAt).toLocaleString()]);
    }
    if ('meta' in resolution) rows.push(['Proved at', `Platform block ${resolution.meta.height}`, new Date(resolution.meta.timeMs).toLocaleString()]);
    if (snapshot) {
      rows.push(['Quorum keys', `Core block ${snapshot.listHeight}`, snapshot.listBlockHash]);
      rows.push(['Chain checked to', `block ${snapshot.chain.height}`]);
      rows.push(['Nodes', `${snapshot.nodes.length} from the masternode list`]);
    }
    rows.push(['Network', this.settings.network]);
    facts(rows);
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
      const missing = site.skipped.length;
      badge(missing ? 'partial' : 'ok', missing ? `Verified · ${missing} file${missing === 1 ? '' : 's'} not loaded` : 'Verified from Dash Platform');
      this.render(site, url, page.html);
    } catch (error) {
      if (generation !== this.generation) return;
      this.reader = undefined;
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
          // The site moved its own frame (location.href = …): show that address instead.
          const next = parseTarget(message.url);
          if (next) this.go(next);
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
