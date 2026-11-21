import { loadGateway } from './settings.js';
import { claimsFromHeaders, compare, labelForUrl, urlForInput, type Verdict } from './shared.js';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const short = (id: string): string => (id.length > 16 ? `${id.slice(0, 8)}…${id.slice(-6)}` : id);

function show(verdict: Verdict['kind'] | 'checking' | 'error', title: string, detail: string): void {
  $('state').dataset.kind = verdict;
  $('title').textContent = title;
  $('detail').textContent = detail;
}

function row(label: string, value: string, full = value): void {
  const dt = document.createElement('dt');
  dt.textContent = label;
  const dd = document.createElement('dd');
  dd.textContent = value;
  dd.title = full;
  $('facts').append(dt, dd);
}

const TITLES: Record<Verdict['kind'], string> = {
  match: 'Verified against Dash Platform',
  behind: 'Gateway is behind',
  mismatch: 'Does not match Dash Platform',
  none: 'No site',
};

async function main(): Promise<void> {
  const { settings, gateway } = await loadGateway();
  $('gateway').textContent = gateway.host;
  $<HTMLAnchorElement>('options').addEventListener('click', () => chrome.runtime.openOptionsPage());
  $<HTMLFormElement>('open').addEventListener('submit', (event) => {
    event.preventDefault();
    const url = urlForInput($<HTMLInputElement>('name').value, gateway);
    if (url) void chrome.tabs.create({ url });
    else $<HTMLInputElement>('name').setCustomValidity('Enter a name such as alice.dash');
  });

  const override = new URLSearchParams(location.search).get('url');
  const tabUrl = override ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.url ?? '';
  const label = labelForUrl(tabUrl, gateway);
  if (!label) {
    show('none', 'Not a .dash site', 'Open a site by name below, or type “dash”, a space and a name in the address bar.');
    return;
  }
  $('site').textContent = `${label}.dash`;
  show('checking', 'Checking…', 'Reading the name and its site record from Dash Platform, with proofs.');

  const page = new URL(tabUrl);
  const [response, verify] = await Promise.all([fetch(tabUrl, { method: 'GET', cache: 'no-store', credentials: 'omit' }), import('./verify.js')]);
  const claims = claimsFromHeaders(response.headers);
  const resolution = await verify.resolve(label, settings.network);
  const verdict = compare(claims, resolution);
  show(verdict.kind, TITLES[verdict.kind], verdict.detail);
  if (resolution.status === 'invalid') return;
  if ('ownerId' in resolution) row('Owner', short(resolution.ownerId), resolution.ownerId);
  if ('site' in resolution) {
    row('Revision', String(resolution.site.revision));
    row('Published', new Date(resolution.site.updatedAt).toLocaleString());
  }
  row('Proved at', `block ${resolution.meta.height}`, new Date(resolution.meta.timeMs).toLocaleString());
  row('Network', settings.network);

  if (verdict.kind !== 'match' || resolution.status !== 'ok') return;
  const audit = await verify.auditFile(resolution, page.pathname, new Uint8Array(await response.arrayBuffer()), settings.network);
  const line = $('audit');
  line.dataset.ok = String(audit.ok);
  line.textContent = audit.ok ? `This page's file (${audit.path}) matches the hash its owner published.` : audit.reason;
  if (!audit.ok) show('mismatch', TITLES.mismatch, audit.reason);
}

main().catch((error: unknown) => show('error', 'Could not check', String((error as Error)?.message ?? error)));
