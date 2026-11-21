const HOST = '/.well-known/dash/';

export const short = (text, keep = 6) => (text.length > keep * 2 + 1 ? `${text.slice(0, keep)}…${text.slice(-keep)}` : text);
export const bytes = (n) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`);
export const stored = (file) => file.parts.reduce((sum, part) => sum + part[2], 0);
export const documents = (file) => new Set(file.parts.map((part) => part[0])).size;

const cache = new Map();
/** Asks whatever is serving this site, the visitor's own browser or a gateway, about Dash Platform. */
export function host(path) {
  const request = cache.get(path) ?? fetch(HOST + path).then((response) => response.json());
  if (!path.startsWith('resolve/')) cache.set(path, request);
  request.catch(() => cache.delete(path));
  return request;
}

export const record = () => host('site.json').then((answer) => (answer.status === 'ok' ? answer : Promise.reject(new Error(answer.status))));
export const manifest = () => host('manifest.json').then((answer) => (answer.files ? answer : Promise.reject(new Error('no manifest'))));

function set(id, text, title) {
  const node = document.getElementById(id);
  if (!node) return;
  node.textContent = text;
  if (title) node.title = title;
}

const SERVED = {
  gateway: 'A gateway read this from Dash Platform and checked the proof',
  browser: 'Your browser read this from Dash Platform and checked the proof',
};

/** Fills the title block and the footer from the site's own record. */
async function fill() {
  const stamp = document.getElementById('stamp');
  try {
    const r = await record();
    for (const node of document.querySelectorAll('[data-name]')) node.textContent = r.name;
    set('r-name', r.name);
    set('r-network', r.network);
    set('r-owner', r.ownerId);
    set('r-domain', r.domainId);
    set('r-site', r.site.id);
    set('r-revision', String(r.site.revision));
    set('r-published', new Date(r.site.updatedAt).toLocaleString());
    set('r-content', r.site.content.replace(/^(dash-manifest:v1:)(.{12}).*(.{12})$/, '$1$2…$3'), r.site.content);
    set('r-by', SERVED[r.servedBy] ?? SERVED.gateway);
    set('r-block', `block ${r.proof.height}`, new Date(r.proof.timeMs).toLocaleString());
    set('f-owner', short(r.ownerId, 6), r.ownerId);
    set('f-revision', String(r.site.revision));
    set('f-block', String(r.proof.height));
    if (stamp) stamp.dataset.state = 'proved';
    document.documentElement.dataset.served = r.servedBy;
  } catch {
    set('r-by', 'The record shows when this site is opened through a Dash Sites gateway');
    set('r-block', 'not read');
    if (stamp) stamp.dataset.state = 'failed';
  }
}

fill();
