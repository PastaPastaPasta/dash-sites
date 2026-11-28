// Runs in sandbox.html: a page Chrome serves with an opaque origin, no extension APIs and the
// manifest's sandbox CSP, inside an iframe that is sandboxed again by the viewer. It receives one
// page of a site from the viewer, rewrites it to load the verified files, and replaces itself with it.
import type { FrameMessage, PageMessage } from './protocol.js';
import { isSameDocumentFragment, lookup, NO_REFERRER, Rewriter, sameSite, type SiteFile } from './render.js';

const parentOrigin = `chrome-extension://${location.host}`;
const post = (message: FrameMessage): void => window.parent.postMessage(message, parentOrigin);
const blob = (type: string, bytes: Uint8Array): Blob => new Blob([bytes as Uint8Array<ArrayBuffer>], { type });
const blobUrl = (type: string, bytes: Uint8Array): string => URL.createObjectURL(blob(type, bytes));

class MemoryStorage {
  private readonly items = new Map<string, string>();
  get length(): number {
    return this.items.size;
  }
  key(index: number): string | null {
    return [...this.items.keys()][index] ?? null;
  }
  getItem(key: string): string | null {
    return this.items.get(String(key)) ?? null;
  }
  setItem(key: string, value: string): void {
    this.items.set(String(key), String(value));
  }
  removeItem(key: string): void {
    this.items.delete(String(key));
  }
  clear(): void {
    this.items.clear();
  }
}

function isPage(data: unknown): data is PageMessage {
  const page = data as PageMessage;
  return (
    typeof page === 'object' &&
    page !== null &&
    page.type === 'page' &&
    typeof page.origin === 'string' &&
    typeof page.url === 'string' &&
    typeof page.html === 'string' &&
    Array.isArray(page.files) &&
    page.files.every((f: SiteFile) => typeof f.path === 'string' && typeof f.type === 'string' && f.bytes instanceof Uint8Array)
  );
}

/** Replaces the page's network, storage and history APIs. Returns what attaches the event listeners, which `document.open()` erases. */
function install(page: PageMessage, files: Map<string, SiteFile>): () => void {
  let current = page.url;
  const raw = new Map<string, string>();
  const rawUrl = (file: SiteFile): string => {
    let url = raw.get(file.path);
    if (!url) {
      url = blobUrl(file.type, file.bytes);
      raw.set(file.path, url);
    }
    return url;
  };
  const siteUrl = (input: string): URL | undefined => {
    try {
      const url = new URL(input, document.baseURI);
      return sameSite(url, page.origin) ? url : undefined;
    } catch {
      return undefined;
    }
  };

  const realFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url = siteUrl(input instanceof Request ? input.url : String(input));
    if (!url) return realFetch(input, init);
    const file = lookup(files, url.pathname);
    if (!file) return Promise.resolve(new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain' } }));
    return Promise.resolve(new Response(blob(file.type, file.bytes), { status: 200, headers: { 'Content-Type': file.type } }));
  };
  const open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
    const site = siteUrl(String(url));
    const file = site ? lookup(files, site.pathname) : undefined;
    const target = site ? (file ? rawUrl(file) : 'data:text/plain,') : url;
    return (open as (...args: unknown[]) => void).call(this, method, target, ...(rest.length ? rest : [true]));
  } as typeof XMLHttpRequest.prototype.open;

  for (const name of ['localStorage', 'sessionStorage'] as const) {
    try {
      void window[name].length;
    } catch {
      Object.defineProperty(window, name, { value: new MemoryStorage(), configurable: true });
    }
  }

  const fakeHistory = (url: string | URL | null | undefined): void => {
    if (url === null || url === undefined) return;
    const next = siteUrl(String(url));
    if (!next) throw new DOMException('A history entry must stay on this site', 'SecurityError');
    current = next.href;
    post({ type: 'location', url: current });
  };
  history.pushState = (_state: unknown, _title: string, url?: string | URL | null) => fakeHistory(url);
  history.replaceState = (_state: unknown, _title: string, url?: string | URL | null) => fakeHistory(url);

  // `open` is the window's own property, not the prototype's: keep the real one before replacing it.
  const realOpen = window.open.bind(window);
  window.open = ((url?: string | URL, target?: string, features?: string) => {
    const site = url === undefined ? undefined : siteUrl(String(url));
    if (site && (!target || target === '_self')) {
      post({ type: 'navigate', url: site.href });
      return null;
    }
    return realOpen(url, target, features);
  }) as typeof window.open;

  return () => {
    window.addEventListener('click', (event) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = (event.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
      if (!anchor || anchor.hasAttribute('download')) return;
      const target = anchor.getAttribute('target');
      if (target && !['_self', '_top', '_parent'].includes(target.toLowerCase())) return;
      let url: URL;
      try {
        url = new URL(anchor.getAttribute('href') ?? '', document.baseURI);
      } catch {
        return;
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
      event.preventDefault();
      if (isSameDocumentFragment(url, page.origin, new URL(current))) {
        document.getElementById(decodeURIComponent(url.hash.slice(1)))?.scrollIntoView();
        return;
      }
      post(url.hostname.endsWith('.dash') ? { type: 'navigate', url: url.href } : { type: 'leave', url: url.href });
    });

    window.addEventListener('submit', (event) => {
      if (event.defaultPrevented) return;
      event.preventDefault();
      const form = event.target as HTMLFormElement;
      if ((form.method || 'get').toLowerCase() !== 'get') return;
      const url = siteUrl(form.getAttribute('action') || current);
      if (!url) return;
      url.search = new URLSearchParams(new FormData(form) as unknown as Record<string, string>).toString();
      post({ type: 'navigate', url: url.href });
    });
  };
}

function watch(rewriter: Rewriter): void {
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === 'attributes' && record.target instanceof Element) rewriter.element(record.target, document.baseURI);
      for (const node of record.addedNodes) {
        if (!(node instanceof Element)) continue;
        rewriter.element(node, document.baseURI);
        for (const child of node.querySelectorAll('*')) rewriter.element(child, document.baseURI);
      }
    }
    post({ type: 'title', title: document.title });
  });
  observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['src', 'srcset', 'href', 'style', 'poster'] });
}

let shown = false;
window.addEventListener('message', (event) => {
  if (shown || event.source !== window.parent || event.origin !== parentOrigin || !isPage(event.data)) return;
  shown = true;
  const page = event.data;
  const files = new Map(page.files.map((file) => [file.path, file]));
  const rewriter = new Rewriter({ ...page, files }, blobUrl, true);
  const html = rewriter.document(NO_REFERRER);
  const listen = install(page, files);
  document.open();
  document.write(html);
  document.close();
  listen();
  watch(rewriter);
  post({ type: 'title', title: document.title });
});

post({ type: 'ready', url: location.hash.slice(1) });
