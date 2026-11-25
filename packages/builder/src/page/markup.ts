import { escapeHtml, safeUrl } from '../template.js';

export type Attrs = Record<string, string | undefined>;

export interface Element {
  tag: string;
  attrs: Attrs;
  children: Child[];
}

/** HTML that has already been through `cleanRichText`. */
export interface Raw {
  html: string;
}

export type Child = string | Element | Raw | null | undefined | false | Child[];

export function h(tag: string, attrs: Attrs | null, ...children: Child[]): Element {
  return { tag, attrs: attrs ?? {}, children };
}

export const isElement = (child: unknown): child is Element => typeof child === 'object' && child !== null && 'tag' in child && 'children' in child;
export const isRaw = (child: unknown): child is Raw => typeof child === 'object' && child !== null && 'html' in child && !('tag' in child);

const VOID = new Set(['img', 'br', 'hr', 'meta', 'link']);

export const escapeText = (text: string): string => text.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'));

export function toHtml(child: Child): string {
  if (child === null || child === undefined || child === false) return '';
  if (typeof child === 'string') return escapeText(child);
  if (Array.isArray(child)) return child.map(toHtml).join('');
  if (isRaw(child)) return child.html;
  if (!isElement(child)) throw new Error('cannot render this node as HTML');
  const attrs = Object.entries(child.attrs)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([name, value]) => ` ${name}="${escapeHtml(value)}"`)
    .join('');
  return VOID.has(child.tag) ? `<${child.tag}${attrs}>` : `<${child.tag}${attrs}>${toHtml(child.children)}</${child.tag}>`;
}

const RICH_TAGS: Record<string, string> = {
  p: 'p',
  h1: 'h2',
  h2: 'h2',
  h3: 'h3',
  h4: 'h3',
  h5: 'h3',
  h6: 'h3',
  strong: 'strong',
  b: 'strong',
  em: 'em',
  i: 'em',
  u: 'u',
  s: 's',
  del: 's',
  strike: 's',
  code: 'code',
  a: 'a',
  ul: 'ul',
  ol: 'ol',
  li: 'li',
  br: 'br',
  hr: 'hr',
  blockquote: 'blockquote',
};
const DROP_CONTENT = new Set(['script', 'style', 'template', 'textarea', 'title', 'noscript', 'iframe', 'object', 'svg', 'math']);
const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]+);/gi, (whole, name: string) => {
    if (name[0] !== '#') return NAMED[name.toLowerCase()] ?? whole;
    const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : '�';
  });
}

function hrefOf(attributes: string): string | undefined {
  const match = /(?:^|\s)href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i.exec(attributes);
  if (!match) return undefined;
  return safeUrl(decodeEntities(match[1] ?? match[2] ?? match[3] ?? ''));
}

/**
 * Cuts HTML down to paragraphs, two heading levels, emphasis, lists, quotes and links to safe
 * addresses. Everything else is dropped, text is re-escaped, and the result is canonical:
 * cleaning it again returns it unchanged.
 */
export function cleanRichText(html: string): string {
  const out: string[] = [];
  const open: string[] = [];
  let dropping: string | undefined;
  const token = /<!--[\s\S]*?(?:-->|$)|<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:[^>"']|"[^"]*"|'[^']*')*)>|<[!?/][^>]*>?/g;
  let last = 0;
  const text = (chunk: string): void => {
    if (!dropping && chunk) out.push(escapeText(decodeEntities(chunk)));
  };
  for (let match = token.exec(html); match; match = token.exec(html)) {
    text(html.slice(last, match.index));
    last = token.lastIndex;
    const name = match[2]?.toLowerCase();
    if (!name) continue;
    const closing = match[1] === '/';
    if (dropping) {
      if (closing && name === dropping) dropping = undefined;
      continue;
    }
    if (DROP_CONTENT.has(name)) {
      if (!closing && !/\/\s*$/.test(match[3] ?? '')) dropping = name;
      continue;
    }
    const tag = RICH_TAGS[name];
    if (!tag) continue;
    if (VOID.has(tag)) {
      if (!closing) out.push(`<${tag}>`);
      continue;
    }
    if (closing) {
      const at = open.lastIndexOf(tag);
      if (at < 0) continue;
      while (open.length > at) out.push(`</${open.pop()}>`);
      continue;
    }
    if (tag === 'a') {
      if (open.includes('a')) continue;
      const href = hrefOf(match[3] ?? '');
      out.push(href ? `<a href="${escapeHtml(href)}">` : '<a>');
    } else {
      out.push(`<${tag}>`);
    }
    open.push(tag);
  }
  text(html.slice(last));
  while (open.length > 0) out.push(`</${open.pop()}>`);
  return out.join('').replace(/<a>([\s\S]*?)<\/a>/g, '$1');
}

/** The text of cleaned rich text, for titles and summaries. */
export function plainText(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}
