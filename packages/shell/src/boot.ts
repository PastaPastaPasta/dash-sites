declare const __GATEWAY_DOMAIN__: string;

const label = location.hostname.split('.')[0] as string;
const step = document.getElementById('step') as HTMLElement;
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
      'Sites here are read from Dash Platform and checked by your browser, which needs service workers. They are unavailable in this browser or window (for example a Firefox private window). Open the site in a regular window of Chrome, Edge, Firefox or Safari, or use the Dash Sites browser extension.',
      'This browser cannot open Dash Sites',
    );
  }
  say('Downloading the verifier, about 9 MB. This happens once.');
  const registration = await navigator.serviceWorker.register('/sw.js');
  if (!navigator.serviceWorker.controller) {
    if (registration.active) return reload();
    await controlled(registration);
  }
  say(`Asking Dash Platform who owns ${label}.dash and checking the proof.`);
  const record = (await (await fetch('/.well-known/dash/site.json')).json()) as { proof?: { height: number } };
  if (record.proof) say(`Proved at block ${record.proof.height}. Loading the site.`);
  reload();
}

if (!landing()) start().catch((error: unknown) => fail(`The verifier could not start: ${error instanceof Error ? error.message : String(error)}`));
