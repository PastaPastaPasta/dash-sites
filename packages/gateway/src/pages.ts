import type { GatewayConfig } from './config.js';

const escapeHtml = (text: string): string =>
  text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);

const STYLE = `
:root{color-scheme:light dark;--bg:#f7f8fa;--fg:#0b1220;--muted:#5b6577;--card:#fff;--line:#dfe3ea;--accent:#008de4}
@media (prefers-color-scheme:dark){:root{--bg:#0b0f17;--fg:#e8ecf3;--muted:#98a2b3;--card:#121824;--line:#232c3d;--accent:#3aa9f0}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:640px;margin:0 auto;padding:12vh 16px 48px}
h1{font-size:28px;line-height:1.2;margin:0 0 12px;letter-spacing:-.01em}
p{margin:0 0 14px;color:var(--muted)}a{color:var(--accent)}
code{font:14px ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--card);border:1px solid var(--line);border-radius:6px;padding:1px 6px;overflow-wrap:anywhere}
form{display:flex;gap:8px;margin:22px 0}
input{flex:1;min-width:0;font:inherit;padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--fg)}
button{font:inherit;font-weight:600;padding:10px 16px;border:0;border-radius:8px;background:var(--accent);color:#fff;cursor:pointer}
.status{font:600 13px ui-monospace,monospace;color:var(--muted);letter-spacing:.06em;text-transform:uppercase;margin-bottom:10px}
footer{margin-top:40px;font-size:13px;color:var(--muted)}
`;

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${escapeHtml(title)}</title><style>${STYLE}</style></head><body><main>${body}</main></body></html>`;
}

export function landingPage(config: GatewayConfig, domainHost: string): string {
  const name = escapeHtml(domainHost);
  return page(
    'Dash Sites gateway',
    `<div class="status">Dash Sites · ${escapeHtml(config.network)}</div>
<h1>Websites on Dash Platform names</h1>
<p>This gateway serves the site published under a DPNS name. <code>alice.dash</code> is at <code>alice.${name}</code>. Names and site records are read from Dash Platform with cryptographic proofs, and every file is checked against the hash its owner published.</p>
<form id="go"><input name="name" placeholder="alice.dash" autocomplete="off" autocapitalize="none" spellcheck="false" aria-label="DPNS name"><button>Open</button></form>
<p><a href="${escapeHtml(config.builderUrl)}">Publish a site</a> · <a href="${escapeHtml(config.extensionUrl)}">Browser extension</a></p>
<footer>The gateway operator does not author or review these sites. Report abuse: ${escapeHtml(config.abuseContact)}.</footer>
<script>
document.getElementById('go').addEventListener('submit',function(e){e.preventDefault();
var n=this.name.value.trim().toLowerCase().replace(/\\.dash\\.?$/,'');
if(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(n))location.href=location.protocol+'//'+n+'.'+location.host+'/';
else this.name.focus();});
</script>`,
  );
}

export function messagePage(status: string, title: string, detail: string, config: GatewayConfig): string {
  return page(
    title,
    `<div class="status">${escapeHtml(status)}</div><h1>${escapeHtml(title)}</h1><p>${detail}</p>
<footer><a href="${escapeHtml(config.builderUrl)}">Publish a site on a Dash Platform name</a></footer>`,
  );
}

export { escapeHtml };
