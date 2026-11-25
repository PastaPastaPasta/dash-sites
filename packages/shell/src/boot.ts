declare const __GATEWAY_DOMAIN__: string;
declare const __VERIFIER_FILES__: string[];

const label = location.hostname.split('.')[0] as string;
const step = document.getElementById('step') as HTMLElement;
const bar = document.querySelector('.bar') as HTMLElement;
const say = (text: string): void => {
  step.textContent = text;
};
let shown = 0;
const advance = (share: number, creep = false): void => {
  if (share < shown) return;
  shown = share;
  const percent = Math.round(share * 100);
  bar.classList.add('known');
  bar.classList.toggle('creep', creep);
  bar.style.setProperty('--done', `${percent}%`);
  bar.setAttribute('aria-valuenow', String(percent));
};
const fail = (text: string, title?: string): void => {
  document.body.classList.add('failed');
  (document.getElementById('title') as HTMLElement).textContent = title ?? `${location.hostname} could not be loaded`;
  if (title) document.title = title;
  const error = document.getElementById('error') as HTMLElement;
  error.textContent = text;
  error.hidden = false;
};

/** The gateway domain itself is not a name: the same static files show the landing page there. */
function landing(): boolean {
  const host = location.hostname;
  if (!__GATEWAY_DOMAIN__ || (host !== __GATEWAY_DOMAIN__ && host !== `www.${__GATEWAY_DOMAIN__}`)) return false;
  document.title = 'Dash Sites';
  document.body.classList.remove('loader');
  (document.getElementById('shell') as HTMLElement).hidden = true;
  (document.getElementById('landing') as HTMLElement).hidden = false;
  const form = document.getElementById('go') as HTMLFormElement;
  // Someone about to open a name will need the verifier; names share this domain's HTTP cache.
  const prefetch = (url: string): void => void fetch(url, { mode: 'cors', credentials: 'omit' }).then((response) => response.arrayBuffer()).catch(() => undefined);
  form.addEventListener('focusin', () => __VERIFIER_FILES__.forEach(prefetch), { once: true });
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const name = String(new FormData(form).get('name') ?? '').trim().toLowerCase().replace(/\.dash\.?$/, '');
    if (/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(name)) location.href = `https://${name}.${__GATEWAY_DOMAIN__}/`;
  });
  return true;
}

const RELOADS = 'dash-sites-reloads';
const LOOP_WINDOW_MS = 10_000;
const LOOP_LIMIT = 8;
const CLAIM_MS = 3000;
/** Reloads into the worker. Every visit and hard reload passes here once, so only a page that keeps coming back within seconds is looping. */
function reload(): void {
  const recent = (sessionStorage.getItem(RELOADS) ?? '').split(',').map(Number).filter((at) => Date.now() - at < LOOP_WINDOW_MS);
  if (recent.length >= LOOP_LIMIT) return fail('This site could not start in this tab. Reload the page to try again.');
  sessionStorage.setItem(RELOADS, [...recent, Date.now()].join(','));
  location.reload();
}

/** A hard reload skips the worker, which leaves this page uncontrolled; the active worker is asked to claim it. */
function claim(worker: ServiceWorker): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, CLAIM_MS);
    navigator.serviceWorker.addEventListener('controllerchange', () => (clearTimeout(timer), resolve()), { once: true });
    worker.postMessage({ dashSitesClaim: true });
  });
}

/** Resolves once the worker controls this page; rejects if its installation fails. */
function controlled(registration: ServiceWorkerRegistration): Promise<void> {
  return new Promise((resolve, reject) => {
    navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true });
    const worker = registration.installing ?? registration.waiting;
    worker?.addEventListener('statechange', () => {
      if (worker.state === 'redundant') reject(new Error('the verifier could not be downloaded or did not match its expected hash. Reload to try again.'));
    });
  });
}

async function start(): Promise<void> {
  (document.getElementById('name') as HTMLElement).textContent = location.hostname;
  if (!('serviceWorker' in navigator)) {
    return fail(
      'Sites here are read from Dash Platform and checked by your browser, which needs service workers. They are unavailable in this browser or window (for example a Firefox private window). Open the site in a regular window of Chrome, Edge, Firefox or Safari.',
      'This browser cannot open Dash Sites',
    );
  }
  navigator.serviceWorker.addEventListener('message', (event: MessageEvent<{ dashSitesProgress?: number }>) => {
    const share = event.data?.dashSitesProgress;
    if (typeof share !== 'number' || document.body.classList.contains('failed')) return;
    advance(share * 0.8);
    say(`Downloading the verifier, about 6 MB: ${Math.round(share * 100)}%. This happens once.`);
  });
  if (!navigator.serviceWorker.controller) {
    say('Downloading the verifier, about 6 MB. This happens once.');
    const registration = await navigator.serviceWorker.register('/sw.js');
    if (registration.active) return claim(registration.active).then(reload);
    await controlled(registration);
    advance(0.95, true);
  }
  say(`Asking Dash Platform who owns ${label}.dash and checking the proof.`);
  const response = await fetch('/.well-known/dash/site.json');
  if (response.status >= 500) {
    return fail(`Your browser could not get a proved answer about ${label}.dash from Dash Platform. Reload to try again.`, 'Dash Platform could not be reached');
  }
  const record = (await response.json()) as { proof?: { height: number } };
  if (record.proof) say(`Proved at block ${record.proof.height}. Loading the site.`);
  if (bar.classList.contains('known')) advance(1);
  reload();
}

if (!isSecureContext && location.protocol === 'http:' && __GATEWAY_DOMAIN__) location.replace(`https:${location.href.slice(5)}`);
else if (!landing()) start().catch((error: unknown) => fail(`The verifier could not start: ${error instanceof Error ? error.message : String(error)}`));
