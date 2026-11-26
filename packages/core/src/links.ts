import { utf8 } from './bytes.js';
import { contentTypeFor } from './mime.js';
import type { SiteFile } from './pack.js';
import { decide, HOST_API } from './serve.js';

export interface LinkProblem {
  /** The page the link is on, e.g. `/index.html`. */
  page: string;
  /** The link as the page writes it. */
  link: string;
  /**
   * `missing`: no file in the site answers it. `download`: an `<a download>` link, which browsers
   * such as Chrome fetch without asking the verifier that serves the site, so they save dash.site's
   * loading page instead of the file.
   */
  kind: 'missing' | 'download';
}

interface Tag {
  name: string;
  attributes: Map<string, string>;
}

const ORIGIN = 'https://site.invalid';
const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title']);
const TAG = /<([a-zA-Z][a-zA-Z0-9-]*)((?:[^<>"']|"[^"]*"|'[^']*')*)>/g;
const ATTRIBUTE = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
const ENTITY = /&(?:#x([0-9a-f]+)|#(\d+)|(amp|quot|apos|lt|gt));/gi;
const NAMED: Record<string, string> = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>' };

function decodeEntities(value: string): string {
  return value.replace(ENTITY, (whole, hex: string | undefined, dec: string | undefined, name: string | undefined) => {
    if (name) return NAMED[name.toLowerCase()] ?? whole;
    const code = hex ? parseInt(hex, 16) : Number(dec);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });
}

function tags(html: string): Tag[] {
  const text = html.replace(/<!--(?:-?>|[\s\S]*?-->)/g, '');
  const out: Tag[] = [];
  TAG.lastIndex = 0;
  for (let match = TAG.exec(text); match; match = TAG.exec(text)) {
    const name = (match[1] as string).toLowerCase();
    const attributes = new Map<string, string>();
    for (const attribute of (match[2] ?? '').matchAll(ATTRIBUTE)) {
      const key = (attribute[1] as string).toLowerCase();
      if (!attributes.has(key)) attributes.set(key, decodeEntities(attribute[2] ?? attribute[3] ?? attribute[4] ?? ''));
    }
    out.push({ name, attributes });
    if (RAW_TEXT.has(name)) {
      const end = new RegExp(`</${name}`, 'gi');
      end.lastIndex = TAG.lastIndex;
      const close = end.exec(text);
      if (!close) break;
      TAG.lastIndex = close.index;
    }
  }
  return out;
}

/** The URLs of a srcset, read the way the HTML standard reads one, so commas inside a URL stay in it. */
function srcsetUrls(srcset: string): string[] {
  const out: string[] = [];
  let at = 0;
  while (at < srcset.length) {
    while (at < srcset.length && /[\s,]/.test(srcset[at] as string)) at++;
    const start = at;
    while (at < srcset.length && !/\s/.test(srcset[at] as string)) at++;
    let url = srcset.slice(start, at);
    if (url.endsWith(',')) url = url.replace(/,+$/, '');
    else while (at < srcset.length && srcset[at] !== ',') at++;
    if (url) out.push(url);
  }
  return out;
}

function references({ name, attributes }: Tag): string[] {
  const out: string[] = [];
  if (name === 'base') return out;
  for (const key of ['href', 'src', 'poster']) {
    const value = attributes.get(key)?.trim();
    if (value) out.push(value);
  }
  const srcset = name === 'img' || name === 'source' ? attributes.get('srcset') : undefined;
  if (srcset) out.push(...srcsetUrls(srcset));
  return out;
}

function parse(link: string, base: URL): URL | undefined {
  try {
    return new URL(link, base);
  } catch {
    return undefined;
  }
}

/**
 * Finds links in a site's HTML pages that will not work on dash.site: links to paths no file in
 * the site answers, and download links. Only links within the site are checked.
 */
export function checkLinks(files: readonly SiteFile[], options: { spa?: boolean } = {}): LinkProblem[] {
  const present = { files: Object.fromEntries(files.map((file) => [file.path, true])) };
  const problems: LinkProblem[] = [];
  const seen = new Set<string>();
  const report = (problem: LinkProblem): void => {
    const key = `${problem.kind}\0${problem.page}\0${problem.link}`;
    if (seen.has(key)) return;
    seen.add(key);
    problems.push(problem);
  };
  for (const file of files) {
    if (!(file.type ?? contentTypeFor(file.path)).startsWith('text/html')) continue;
    let html: string;
    try {
      html = utf8.decode(file.bytes);
    } catch {
      continue;
    }
    const page = new URL(file.path, ORIGIN);
    const found = tags(html);
    // A browser uses the first <base href> for the whole page, links before it included.
    const baseHref = found.find((tag) => tag.name === 'base' && tag.attributes.get('href')?.trim())?.attributes.get('href')?.trim();
    const base = (baseHref && parse(baseHref, page)) || page;
    for (const tag of found) {
      for (const link of references(tag)) {
        const url = parse(link, base);
        if (!url || url.origin !== ORIGIN || url.pathname.startsWith(HOST_API)) continue;
        const answer = decide(present, url.pathname);
        const missing = answer.kind === 'not-found' || (answer.kind === 'file' && answer.status === 404);
        // In a single-page app index.html answers every path, so only links that name a file are checked.
        if (missing && (!options.spa || /\.[^/]+$/.test(url.pathname))) report({ page: file.path, link, kind: 'missing' });
        // A download link back to the page itself is a placeholder that a script points at a blob: URL.
        const toPage = url.pathname === page.pathname;
        if ((tag.name === 'a' || tag.name === 'area') && tag.attributes.has('download') && tag.attributes.get('href')?.trim() === link && !toPage) {
          report({ page: file.path, link, kind: 'download' });
        }
      }
    }
  }
  return problems;
}

/** One line telling the site's author what is wrong with a link and what to do. */
export function describeLinkProblem(problem: LinkProblem): string {
  if (problem.kind === 'missing') return `${problem.page} links to ${problem.link}, which is not in the site. Add the file, or visitors get a "not found" page instead.`;
  return `${problem.page} has a download link to ${problem.link}. Browsers such as Chrome save download links without asking the verifier that serves the site, so visitors get dash.site's loading page instead of the file. Remove the download attribute: the link then opens the file, and visitors can save it from there.`;
}
