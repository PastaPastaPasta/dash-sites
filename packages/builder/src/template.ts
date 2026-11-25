import { marked } from 'marked';
import { utf8, type SiteFile } from '@dash-sites/core';

export type Theme = 'auto' | 'paper' | 'night' | 'signal';

export interface PageLink {
  label: string;
  url: string;
}

export interface Picture {
  bytes: Uint8Array;
  /** `png`, `jpg`, `webp`, `gif` or `svg`. */
  ext: string;
}

export interface PageDraft {
  title: string;
  tagline: string;
  /** Markdown. */
  body: string;
  links: PageLink[];
  theme: Theme;
  picture?: Picture;
}

export const EMPTY_DRAFT: PageDraft = { title: '', tagline: '', body: '', links: [], theme: 'paper' };

export const THEMES: Record<Theme, { label: string; css: string }> = {
  /** Follows each visitor's light or dark setting. One flat rule, because the page's stylesheet is filtered rule by rule. */
  auto: {
    label: 'Auto',
    css: ':root{color-scheme:light dark;--bg:light-dark(#f6f7f9,#0d1420);--fg:light-dark(#141a22,#e9eef6);--muted:light-dark(#5b6577,#93a1b5);--line:light-dark(#dde2ea,#243247);--accent:light-dark(#0b5cad,#6cc2ff)}body{font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}h1{font-weight:700;letter-spacing:-.03em}',
  },
  paper: {
    label: 'Paper',
    css: ':root{--bg:#f6f4ef;--fg:#1c1b19;--muted:#6b675e;--line:#dcd7cb;--accent:#0b5cad}body{font-family:Georgia,"Iowan Old Style","Times New Roman",serif}h1{font-weight:400;letter-spacing:-.02em}',
  },
  night: {
    label: 'Night',
    css: ':root{--bg:#0d1420;--fg:#e9eef6;--muted:#93a1b5;--line:#243247;--accent:#6cc2ff}body{font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}h1{font-weight:700;letter-spacing:-.03em}',
  },
  signal: {
    label: 'Signal',
    css: ':root{--bg:#ffe45c;--fg:#141414;--muted:#4a4424;--line:#14141433;--accent:#141414}body{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}h1{font-weight:800;text-transform:lowercase;letter-spacing:-.04em}a{text-decoration-thickness:2px}',
  },
};

const BASE_CSS =
  '*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}body{margin:0;background:var(--bg);color:var(--fg);font-size:18px;line-height:1.6}' +
  'main{max-width:38rem;margin:0 auto;padding:12vh 20px 80px}img.me{width:96px;height:96px;border-radius:50%;object-fit:cover;display:block;margin:0 0 28px}' +
  'h1{font-size:clamp(2.2rem,7vw,3.4rem);line-height:1.05;margin:0 0 .4em}p.tagline{font-size:1.2rem;color:var(--muted);margin:0 0 2em}' +
  'a{color:var(--accent)}article{overflow-wrap:anywhere}article h2{font-size:1.4rem;margin:2em 0 .5em}article img{max-width:100%}article pre{overflow:auto;padding:12px;border:1px solid var(--line)}' +
  'ul.links{list-style:none;padding:0;margin:2.5em 0 0;border-top:1px solid var(--line)}ul.links li{border-bottom:1px solid var(--line)}ul.links a{display:block;padding:14px 0;text-decoration:none}ul.links a:hover{text-decoration:underline}' +
  'footer{margin-top:4em;font-size:.8rem;color:var(--muted)}';

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

/** Links may be web addresses, mail addresses, or paths within the site. */
export function safeUrl(url: string): string | undefined {
  const trimmed = url.trim();
  if (/^(https?:\/\/|mailto:)[^\s]+$/i.test(trimmed)) return trimmed;
  if (/^\/[^\s]*$/.test(trimmed)) return trimmed;
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+(\/[^\s]*)?$/i.test(trimmed)) return `https://${trimmed}`;
  return undefined;
}

export function isBlank(draft: PageDraft): boolean {
  return !draft.title.trim() && !draft.tagline.trim() && !draft.body.trim() && draft.links.length === 0 && !draft.picture;
}

function document(title: string, theme: Theme, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${THEMES[theme].css}${BASE_CSS}</style>
</head>
<body>
<main>
${body}
</main>
</body>
</html>
`;
}

/** The files of a one-page site. `pictureSrc` overrides the picture's address, for previews. */
export function renderPage(draft: PageDraft, name: string, pictureSrc?: string): SiteFile[] {
  const title = draft.title.trim() || name;
  const parts: string[] = [];
  if (draft.picture) parts.push(`<img class="me" src="${escapeHtml(pictureSrc ?? `picture.${draft.picture.ext}`)}" alt="">`);
  parts.push(`<h1>${escapeHtml(title)}</h1>`);
  if (draft.tagline.trim()) parts.push(`<p class="tagline">${escapeHtml(draft.tagline.trim())}</p>`);
  if (draft.body.trim()) parts.push(`<article>${marked.parse(draft.body, { async: false })}</article>`);
  const links = draft.links
    .map((link) => ({ label: link.label.trim(), url: safeUrl(link.url) }))
    .filter((link): link is PageLink => Boolean(link.url));
  if (links.length > 0) {
    parts.push(`<ul class="links">${links.map((link) => `<li><a href="${escapeHtml(link.url)}">${escapeHtml(link.label || link.url)}</a></li>`).join('')}</ul>`);
  }
  parts.push(`<footer>${escapeHtml(name)} is published on Dash Platform.</footer>`);
  const files: SiteFile[] = [
    { path: '/index.html', bytes: utf8.encode(document(title, draft.theme, parts.join('\n'))) },
    { path: '/404.html', bytes: utf8.encode(document(`Not found: ${title}`, draft.theme, `<h1>Nothing here</h1>\n<p class="tagline"><a href="/">Back to ${escapeHtml(title)}</a></p>`)) },
  ];
  if (draft.picture) files.push({ path: `/picture.${draft.picture.ext}`, bytes: draft.picture.bytes });
  return files;
}
