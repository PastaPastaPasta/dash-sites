export const escapeHtml = (text: string): string =>
  text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);

export const PAGE_STYLE = `
:root{color-scheme:light dark;--bg:Canvas;--fg:CanvasText;--card:Canvas;--muted:#5b6577;--line:#8a94a6;--accent:#0072c6;--on-accent:#fff}
@media (prefers-color-scheme:dark){:root{--muted:#a3adbd;--line:#5a6476;--accent:#5ab4f2;--on-accent:#04121f}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:640px;margin:0 auto;padding:12vh 16px 48px}
h1{font-size:28px;line-height:1.2;margin:0 0 12px;letter-spacing:-.01em}
p{margin:0 0 14px;color:var(--muted)}a{color:var(--accent)}
code{font:14px ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--card);border:1px solid var(--line);border-radius:6px;padding:1px 6px;overflow-wrap:anywhere}
form{display:flex;gap:8px;margin:22px 0}
input{flex:1;min-width:0;font:inherit;padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--fg)}
button{font:inherit;font-weight:600;padding:10px 16px;border:0;border-radius:8px;background:var(--accent);color:var(--on-accent);cursor:pointer}
.status{font:600 13px ui-monospace,monospace;color:var(--muted);letter-spacing:.06em;text-transform:uppercase;margin-bottom:10px}
footer{margin-top:40px;font-size:13px;color:var(--muted)}
`;

/** A page the host itself shows, as opposed to one a site published. `body` is trusted HTML. */
export function hostPage(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><meta name="robots" content="noindex"><title>${escapeHtml(title)}</title><style>${PAGE_STYLE}</style></head><body><main>${body}</main></body></html>`;
}

/** `detail` is trusted HTML: escape anything in it that came from outside. */
export function messagePage(status: string, title: string, detail: string, links: { builderUrl: string }): string {
  return hostPage(
    title,
    `<div class="status">${escapeHtml(status)}</div><h1>${escapeHtml(title)}</h1><p>${detail}</p>
<footer><a href="${escapeHtml(links.builderUrl)}">Publish a site on a Dash Platform name</a></footer>`,
  );
}
