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
function reload(): void {
  const tries = Number(sessionStorage.getItem(TRIES) ?? 0);
  if (tries >= 3) return fail('The verifier is installed but is not answering for this page. Close this tab and open the site again.');
  sessionStorage.setItem(TRIES, String(tries + 1));
  location.reload();
}

async function start(): Promise<void> {
  if (!('serviceWorker' in navigator)) {
    return fail('This browser cannot run the verifier here: service workers are unavailable, as in a Firefox private window.');
  }
  say('Downloading the verifier, about 9 MB. This happens once.');
  const registration = await navigator.serviceWorker.register('/sw.js');
  if (!navigator.serviceWorker.controller) {
    if (registration.active) return reload();
    await new Promise((resolve) => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }));
  }
  say(`Asking Dash Platform who owns ${label}.dash and checking the proof.`);
  const record = (await (await fetch('/.well-known/dash/site.json')).json()) as { proof?: { height: number } };
  if (record.proof) say(`Proved at block ${record.proof.height}. Loading the site.`);
  reload();
}

start().catch((error: unknown) => fail(`The verifier could not start: ${error instanceof Error ? error.message : String(error)}`));
