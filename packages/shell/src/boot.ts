declare const __GATEWAY_DOMAIN__: string;
declare const __VERIFIER__: string;

const label = location.hostname.split('.')[0] as string;
const step = document.getElementById('step') as HTMLElement;
const bar = document.querySelector('.bar') as HTMLElement;
const say = (text: string): void => {
  step.textContent = text;
};
const fail = (text: string, title?: string): void => {
  document.body.classList.add('failed');
  if (title) {
    (document.getElementById('title') as HTMLElement).textContent = title;
    document.title = title;
  }
  say(text);
};

/** The gateway domain itself is not a name: the same static files show the landing page there. */
function landing(): boolean {
  const host = location.hostname;
  if (!__GATEWAY_DOMAIN__ || (host !== __GATEWAY_DOMAIN__ && host !== `www.${__GATEWAY_DOMAIN__}`)) return false;
  document.title = 'Dash Sites';
  (document.getElementById('shell') as HTMLElement).hidden = true;
  (document.getElementById('landing') as HTMLElement).hidden = false;
  const form = document.getElementById('go') as HTMLFormElement;
  // Someone about to open a name will need the verifier; names share this domain's HTTP cache.
  form.addEventListener('focusin', () => void fetch(__VERIFIER__, { mode: 'cors', credentials: 'omit' }).then((response) => response.arrayBuffer()).catch(() => undefined), { once: true });
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const name = String(new FormData(form).get('name') ?? '').trim().toLowerCase().replace(/\.dash\.?$/, '');
    if (/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(name)) location.href = `https://${name}.${__GATEWAY_DOMAIN__}/`;
  });
  return true;
}

const TRIES = 'dash-sites-boot';
const RETRY_WINDOW_MS = 30_000;
function reload(): void {
  const [count, since] = (sessionStorage.getItem(TRIES) ?? '0:0').split(':').map(Number) as [number, number];
  const recent = Date.now() - since < RETRY_WINDOW_MS;
  if (recent && count >= 3) return fail('The verifier is installed but is not answering for this page. Close this tab and open the site again.');
  sessionStorage.setItem(TRIES, recent ? `${count + 1}:${since}` : `1:${Date.now()}`);
  location.reload();
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
  (document.getElementById('name') as HTMLElement).textContent = `${label}.dash`;
  if (!('serviceWorker' in navigator)) {
    return fail(
      'Sites here are read from Dash Platform and checked by your browser, which needs service workers. They are unavailable in this browser or window (for example a Firefox private window). Open the site in a regular window of Chrome, Edge, Firefox or Safari.',
      'This browser cannot open Dash Sites',
    );
  }
  navigator.serviceWorker.addEventListener('message', (event: MessageEvent<{ dashSitesProgress?: number }>) => {
    const share = event.data?.dashSitesProgress;
    if (typeof share !== 'number') return;
    bar.classList.add('known');
    bar.style.setProperty('--done', `${Math.round(share * 100)}%`);
    say(`Downloading the verifier, about 9 MB: ${Math.round(share * 100)}%. This happens once.`);
  });
  if (!navigator.serviceWorker.controller) {
    say('Downloading the verifier, about 9 MB. This happens once.');
    const registration = await navigator.serviceWorker.register('/sw.js');
    if (registration.active) return reload();
    await controlled(registration);
    bar.classList.remove('known');
  }
  say(`Asking Dash Platform who owns ${label}.dash and checking the proof.`);
  const response = await fetch('/.well-known/dash/site.json');
  if (response.status >= 500) {
    return fail(`Your browser could not get a proved answer about ${label}.dash from Dash Platform. Reload to try again.`, 'Dash Platform could not be reached');
  }
  const record = (await response.json()) as { proof?: { height: number } };
  if (record.proof) say(`Proved at block ${record.proof.height}. Loading the site.`);
  reload();
}

if (!isSecureContext && location.protocol === 'http:' && __GATEWAY_DOMAIN__) location.replace(`https:${location.href.slice(5)}`);
else if (!landing()) start().catch((error: unknown) => fail(`The verifier could not start: ${error instanceof Error ? error.message : String(error)}`));
