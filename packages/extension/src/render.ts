import { parse as parseModule } from 'es-module-lexer/js';

/** A file of the site, read from Dash Platform and checked against its hash. */
export interface SiteFile {
  path: string;
  type: string;
  bytes: Uint8Array;
}

export interface Page {
  /** `https://<label>.dash`: the address the site's own URLs are resolved against. */
  origin: string;
  /** The page's address under `origin`, with its query. */
  url: string;
  /** The HTML of the page. */
  html: string;
  files: ReadonlyMap<string, SiteFile>;
}

/** Turns a file into an address the rendered page can load: a blob URL in the sandbox, a data URL elsewhere. */
export type Addresser = (type: string, bytes: Uint8Array) => string;

const isJs = (file: SiteFile): boolean => /javascript|ecmascript/.test(file.type) || /\.m?js$/.test(file.path);
const isCss = (file: SiteFile): boolean => file.type.startsWith('text/css') || file.path.endsWith('.css');
const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
const encode = (value: string): Uint8Array => new TextEncoder().encode(value);

/** The file a site URL names, as a static host would pick it. */
export function lookup(files: ReadonlyMap<string, SiteFile>, pathname: string): SiteFile | undefined {
  let path: string;
  try {
    path = decodeURIComponent(pathname);
  } catch {
    return undefined;
  }
  if (path.endsWith('/')) return files.get(`${path}index.html`);
  return files.get(path) ?? files.get(`${path}.html`) ?? files.get(`${path}/index.html`);
}

export const sameSite = (url: URL, origin: string): boolean => (url.protocol === 'https:' || url.protocol === 'http:') && url.hostname === new URL(origin).hostname;

/** Whether `url` is a fragment of the page at `here`, which a frame scrolls to instead of loading. */
export const isSameDocumentFragment = (url: URL, origin: string, here: URL): boolean =>
  sameSite(url, origin) && url.pathname === here.pathname && url.search === here.search && url.hash !== '';

/** Head markup every rendered page starts with. */
export const NO_REFERRER = '<meta name="referrer" content="no-referrer">';

const CSS_URL = /url\(\s*(['"]?)([^'")]+)\1\s*\)|@import\s+(['"])([^'"]+)\3/g;
const SKIP = /^(data:|blob:|#|about:|javascript:|mailto:)/i;

/**
 * Rewrites a page and the files it uses so that every reference into the site loads the verified
 * bytes through `address`. References elsewhere are left alone. With `scripts`, module scripts are
 * rewritten so their imports resolve to absolute site URLs, which an import map sends to the files.
 */
export class Rewriter {
  private readonly made = new Map<string, string>();
  private readonly busy = new Set<string>();

  /**
   * @param links Without scripts, where a link to an address goes instead (the viewer's own URL),
   * so a click needs no script to stay inside Dash Platform.
   */
  constructor(
    private readonly page: Page,
    private readonly address: Addresser,
    private readonly scripts: boolean,
    private readonly links?: (url: URL) => string | undefined,
  ) {}

  private resolve(ref: string, base: string): SiteFile | undefined {
    if (SKIP.test(ref.trim())) return undefined;
    let url: URL;
    try {
      url = new URL(ref.trim(), base);
    } catch {
      return undefined;
    }
    return sameSite(url, this.page.origin) ? lookup(this.page.files, url.pathname) : undefined;
  }

  /** The loadable address of a site file, or undefined when `ref` does not name one. */
  urlFor(ref: string, base: string): string | undefined {
    const file = this.resolve(ref, base);
    if (!file) return undefined;
    const hash = /#.*$/.exec(ref)?.[0] ?? '';
    return this.fileUrl(file) + (isCss(file) || isJs(file) ? '' : hash);
  }

  fileUrl(file: SiteFile): string {
    const known = this.made.get(file.path);
    if (known) return known;
    let bytes = file.bytes;
    if (isCss(file) && !this.busy.has(file.path)) {
      this.busy.add(file.path);
      bytes = encode(this.css(text(file.bytes), this.page.origin + file.path));
      this.busy.delete(file.path);
    } else if (isJs(file) && this.scripts) {
      bytes = encode(this.module(text(file.bytes), this.page.origin + file.path));
    }
    const url = this.address(file.type, bytes);
    this.made.set(file.path, url);
    return url;
  }

  css(source: string, base: string): string {
    return source.replace(CSS_URL, (whole, _q: string, url: string | undefined, quote: string | undefined, imported: string | undefined) => {
      const target = this.urlFor((url ?? imported) as string, base);
      if (!target) return whole;
      return url !== undefined ? `url("${target}")` : `@import ${quote}${target}${quote}`;
    });
  }

  /** Makes a module's relative and root-relative imports absolute site URLs. Code the lexer cannot read is left as it is. */
  module(source: string, base: string): string {
    let imports: ReturnType<typeof parseModule>[0];
    try {
      [imports] = parseModule(source);
    } catch {
      return source;
    }
    let out = '';
    let last = 0;
    for (const entry of imports) {
      if (entry.n === undefined || !/^(\.{0,2}\/)/.test(entry.n) || entry.s < 0) continue;
      let absolute: string;
      try {
        absolute = new URL(entry.n, base).href;
      } catch {
        continue;
      }
      // A static import's range is the specifier's text; a dynamic import's is the whole string literal.
      out += source.slice(last, entry.s) + (entry.d > -1 ? JSON.stringify(absolute) : absolute);
      last = entry.e;
    }
    return out + source.slice(last);
  }

  importMap(): string {
    const imports: Record<string, string> = {};
    // Keyed as `module()` writes specifiers: parsed, so percent-encoded the way URLs are.
    for (const file of this.page.files.values()) if (isJs(file)) imports[new URL(file.path, this.page.origin).href] = this.fileUrl(file);
    return JSON.stringify({ imports }).replace(/</g, '\\u003c');
  }

  /**
   * Rewrites each candidate's URL, splitting as the HTML parser does: a URL runs to whitespace and may
   * hold commas (`data:`); one that ends in commas has no descriptors.
   */
  srcset(value: string, base: string): string {
    const out: string[] = [];
    let at = 0;
    while (at < value.length) {
      while (at < value.length && /[\s,]/.test(value.charAt(at))) at++;
      if (at >= value.length) break;
      let end = at;
      while (end < value.length && !/\s/.test(value.charAt(end))) end++;
      let ref = value.slice(at, end);
      let descriptor = '';
      if (ref.endsWith(',')) {
        ref = ref.replace(/,+$/, '');
        at = end;
      } else {
        const comma = value.indexOf(',', end);
        const stop = comma < 0 ? value.length : comma;
        descriptor = value.slice(end, stop).trim();
        at = stop + 1;
      }
      const target = this.urlFor(ref, base) ?? ref;
      out.push(descriptor ? `${target} ${descriptor}` : target);
    }
    return out.join(', ');
  }

  /** Rewrites one element's references in place. */
  element(element: Element, base: string): void {
    const tag = element.localName;
    const swap = (attribute: string): void => {
      const value = element.getAttribute(attribute);
      if (value === null) return;
      const target = this.urlFor(value, base);
      if (!target) return;
      element.setAttribute(attribute, target);
      // The bytes were checked against the manifest, and a rewritten stylesheet or module no longer has the hash the site declared.
      element.removeAttribute('integrity');
    };
    /** Writes only a changed value: the sandbox rewrites again on every attribute mutation it observes. */
    const set = (attribute: string, value: string): void => {
      if (element.getAttribute(attribute) !== value) element.setAttribute(attribute, value);
    };
    if (['img', 'source', 'video', 'audio', 'track', 'embed', 'input'].includes(tag)) swap('src');
    if (tag === 'script') {
      if (!this.scripts) return;
      swap('src');
      if (!element.hasAttribute('src') && element.getAttribute('type') === 'module') element.textContent = this.module(element.textContent ?? '', base);
    }
    if (tag === 'img' || tag === 'source') {
      const candidates = element.getAttribute('srcset');
      if (candidates) set('srcset', this.srcset(candidates, base));
    }
    if (tag === 'video') swap('poster');
    if (tag === 'object') swap('data');
    if (tag === 'link' && /\b(stylesheet|icon|preload|modulepreload|apple-touch-icon|prefetch)\b/i.test(element.getAttribute('rel') ?? '')) swap('href');
    if ((tag === 'image' || tag === 'use') && element.namespaceURI === 'http://www.w3.org/2000/svg') {
      swap('href');
      swap('xlink:href');
    }
    if ((tag === 'a' || tag === 'area') && this.links) this.link(element, base);
    if ((tag === 'iframe' || tag === 'frame') && !this.scripts) this.frame(element, base);
    if (tag === 'style') {
      const css = this.css(element.textContent ?? '', base);
      if (css !== element.textContent) element.textContent = css;
    }
    const style = element.getAttribute('style');
    if (style && /url\(/.test(style)) set('style', this.css(style, base));
  }

  /**
   * Without scripts there is no sandbox page for a nested `.dash` frame to land in, and no rule
   * sends it anywhere, so its address would be looked up in DNS: it is not loaded.
   */
  private frame(element: Element, base: string): void {
    const src = element.getAttribute('src');
    if (src === null) return;
    try {
      if (!new URL(src, base).hostname.endsWith('.dash')) return;
    } catch {
      // An unparsable address is dropped too.
    }
    element.removeAttribute('src');
  }

  private link(element: Element, base: string): void {
    const href = element.getAttribute('href');
    if (href === null) return;
    let url: URL;
    try {
      url = new URL(href, base);
    } catch {
      element.removeAttribute('href');
      return;
    }
    // Checked after parsing, which strips the tabs and newlines that can hide a `javascript:` scheme.
    if (url.protocol !== 'http:' && url.protocol !== 'https:' && url.protocol !== 'mailto:') {
      element.removeAttribute('href');
      return;
    }
    if (href.trim().startsWith('#') || isSameDocumentFragment(url, this.page.origin, new URL(this.page.url))) {
      // Same page: a fragment of the frame's own document, which the base would otherwise turn into a navigation.
      element.setAttribute('href', `about:srcdoc${url.hash}`);
      return;
    }
    const target = (element.getAttribute('target') ?? '').toLowerCase();
    element.setAttribute('href', this.links?.(url) ?? url.href);
    if (target !== '_blank') element.setAttribute('target', '_top');
  }

  /**
   * The page as a complete HTML document. Its base is the page's site URL, so links and the site's
   * own scripts see site addresses; a site's own `<base>` is kept as an address under the site.
   */
  document(head: string): string {
    const doc = new DOMParser().parseFromString(this.page.html, 'text/html');
    const ownBase = doc.querySelector('base[href]')?.getAttribute('href');
    let base = this.page.url;
    if (ownBase) {
      try {
        const resolved = new URL(ownBase, this.page.url);
        if (sameSite(resolved, this.page.origin)) base = resolved.href;
      } catch {
        // An unusable base is ignored.
      }
    }
    for (const node of doc.querySelectorAll('base, meta[http-equiv]')) {
      if (node.localName === 'base' || /content-security-policy|refresh/i.test(node.getAttribute('http-equiv') ?? '')) node.remove();
    }
    for (const element of doc.querySelectorAll('*')) this.element(element, base);
    if (!this.scripts) {
      for (const script of doc.querySelectorAll('script')) script.remove();
      for (const element of doc.querySelectorAll('*')) {
        for (const attribute of [...element.attributes]) if (/^on/i.test(attribute.name)) element.removeAttribute(attribute.name);
      }
    }
    const baseElement = doc.createElement('base');
    baseElement.setAttribute('href', base);
    const extra = new DOMParser().parseFromString(`<head>${head}</head>`, 'text/html').head;
    doc.head.prepend(baseElement, ...extra.childNodes);
    if (this.scripts) {
      const map = doc.createElement('script');
      map.setAttribute('type', 'importmap');
      map.textContent = this.importMap();
      baseElement.after(map);
    }
    return `<!doctype html>\n${doc.documentElement.outerHTML}`;
  }
}

/** A data URL of the bytes. */
export function dataUrl(type: string, bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:${type};base64,${btoa(binary)}`;
}
