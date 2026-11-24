import { escapeHtml, hostPage } from '@dash-sites/core';
import type { GatewayConfig } from './config.js';

export function landingPage(config: GatewayConfig, domainHost: string): string {
  const name = escapeHtml(domainHost);
  const peer = config.peer ? ` · <a href="${escapeHtml(config.peer.url)}">${escapeHtml(config.peer.network)}: ${escapeHtml(new URL(config.peer.url).host)}</a>` : '';
  return hostPage(
    'Dash Sites gateway',
    `<div class="status">Dash Sites · ${escapeHtml(config.network)}</div>
<h1>Websites on Dash Platform names</h1>
<p><code>alice.dash</code> is at <code>alice.${name}</code>. This gateway sends your browser a small verifier and nothing else. Your browser reads the name, its site record and its files from Dash Platform, checks the proofs and every file's hash, and shows the site.</p>
<form id="go"><input name="name" placeholder="alice.dash" autocomplete="off" autocapitalize="none" spellcheck="false" aria-label="DPNS name"><button>Open</button></form>
${config.sitesLive ? '' : `<p>Publishing on ${escapeHtml(config.network)} has not opened yet. Names already resolve here, and a name's site appears as soon as its owner publishes one.</p>`}
<p><a href="${escapeHtml(config.builderUrl)}">Publish a site</a> · <a href="${escapeHtml(config.extensionUrl)}">Browser extension</a>${peer}</p>
<footer>The gateway operator does not author or review these sites. Report abuse: ${escapeHtml(config.abuseContact)}.</footer>
<script>
document.getElementById('go').addEventListener('submit',function(e){e.preventDefault();
var n=this.name.value.trim().toLowerCase().replace(/\\.dash\\.?$/,'');
if(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(n))location.href=location.protocol+'//'+n+'.'+location.host+'/';
else this.name.focus();});
</script>`,
  );
}
