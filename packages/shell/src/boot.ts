const label = location.hostname.split('.')[0] as string;
const step = document.getElementById('step') as HTMLElement;
const say = (text: string): void => {
  step.textContent = text;
};
const fail = (text: string): void => {
  document.body.classList.add('failed');
  say(text);
};
(document.getElementById('name') as HTMLElement).textContent = `${label}.dash`;

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
      if (worker.state === 'redundant') reject(new Error('the verifier could not be downloaded. Reload to try again.'));
    });
  });
}

async function start(): Promise<void> {
  if (!('serviceWorker' in navigator)) {
    return fail('This browser cannot run the verifier here: service workers are unavailable, as in a Firefox private window.');
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

start().catch((error: unknown) => fail(`The verifier could not start: ${error instanceof Error ? error.message : String(error)}`));
