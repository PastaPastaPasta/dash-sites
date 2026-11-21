import { unzipSync } from 'fflate';
import { contentTypeFor, isValidPath, utf8, type SiteFile } from '@dash-sites/core';

export interface RawFile {
  /** Path as the browser or archive reports it, e.g. `my-site/css/a.css`. */
  path: string;
  bytes: Uint8Array;
}

const SKIP = /(^|\/)(node_modules|__MACOSX|\.git)(\/|$)|(^|\/)(\.DS_Store|Thumbs\.db)$/;

/**
 * Turns picked files into site files: drops junk and dotfiles (except `.well-known`), and removes
 * the folder everything sits in when the site's index.html is inside it.
 */
export function normalizeUpload(raw: RawFile[]): { files: SiteFile[]; skipped: string[] } {
  const skipped: string[] = [];
  let entries = raw
    .map((file) => ({ path: file.path.replace(/\\/g, '/').replace(/^\/+/, ''), bytes: file.bytes }))
    .filter((file) => {
      const hidden = file.path.split('/').some((segment) => segment.startsWith('.') && segment !== '.well-known');
      if (!SKIP.test(file.path) && !hidden) return true;
      skipped.push(file.path);
      return false;
    });
  for (;;) {
    if (entries.length === 0 || entries.some((file) => file.path === 'index.html')) break;
    const top = entries[0]?.path.split('/')[0] as string;
    if (!entries.every((file) => file.path.startsWith(`${top}/`))) break;
    entries = entries.map((file) => ({ path: file.path.slice(top.length + 1), bytes: file.bytes }));
  }
  const files: SiteFile[] = [];
  for (const file of entries) {
    const path = `/${file.path}`;
    if (isValidPath(path)) files.push({ path, bytes: file.bytes });
    else skipped.push(file.path);
  }
  return { files, skipped };
}

export function unzip(bytes: Uint8Array): RawFile[] {
  return Object.entries(unzipSync(bytes))
    .filter(([path]) => !path.endsWith('/'))
    .map(([path, data]) => ({ path, bytes: data }));
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export function dataUrl(bytes: Uint8Array, type: string): string {
  return `data:${type.split(';')[0]};base64,${toBase64(bytes)}`;
}

const PREVIEW_ASSET_LIMIT = 3 * 1024 * 1024;

/** The home page with the site's own images and stylesheets inlined, so it can be shown without a server. */
export function previewHtml(files: SiteFile[]): string | undefined {
  const index = files.find((file) => file.path === '/index.html');
  if (!index) return undefined;
  const byPath = new Map(files.map((file) => [file.path, file]));
  let budget = PREVIEW_ASSET_LIMIT;
  let html: string;
  try {
    html = utf8.decode(index.bytes);
  } catch {
    return undefined;
  }
  return html.replace(/\b(src|href)=(["'])([^"'#?]+)\2/g, (whole, attribute: string, quote: string, reference: string) => {
    if (/^([a-z][a-z0-9+.-]*:|\/\/)/i.test(reference)) return whole;
    const file = byPath.get(new URL(reference, 'http://site.invalid/').pathname);
    if (!file || /\.html?$/.test(file.path) || file.bytes.length > budget) return whole;
    budget -= file.bytes.length;
    return `${attribute}=${quote}${dataUrl(file.bytes, file.type ?? contentTypeFor(file.path))}${quote}`;
  });
}
