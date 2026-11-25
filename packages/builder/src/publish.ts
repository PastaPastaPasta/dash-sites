import { parseName, readerConfig, type Network } from '@dash-sites/core';
import type { EvoReader } from '@dash-sites/core/evo';

declare const __GATEWAY_DOMAIN__: string;
declare const __NETWORK__: string;

const GATEWAY = __GATEWAY_DOMAIN__;
const NETWORK = __NETWORK__ as Network;
const CREDITS_PER_DASH = 1e11;
const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;

const cost = (size: number): number => (size * 28_500 + Math.ceil(size / 14_700) * 50_000_000 + 110_000_000) / CREDITS_PER_DASH;
const dash = (amount: number): string => `${amount < 0.01 ? amount.toFixed(4) : amount.toFixed(3)} DASH`;
const sizeText = (n: number): string => (n < 10_240 ? `${(n / 1024).toFixed(1)} KB` : n < 1e6 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`);

let reader: Promise<EvoReader> | undefined;
function connect(): Promise<EvoReader> {
  reader ??= import('@dash-sites/core/evo')
    .then((evo) => evo.EvoReader.connect(readerConfig(NETWORK)))
    .catch((error: unknown) => {
      reader = undefined;
      throw error;
    });
  return reader;
}

if (location.protocol === 'http:' && location.hostname === GATEWAY) location.replace(`https:${location.href.slice(5)}`);

const input = $<HTMLInputElement>('name');
const answer = $('answer');
const say = (...nodes: Array<Node | string>): void => answer.replaceChildren(...nodes);
const span = (tag: string, text: string, className?: string): HTMLElement => Object.assign(document.createElement(tag), { textContent: text, className: className ?? '' });

function point(label: string | undefined): void {
  const hash = label ? `&name=${encodeURIComponent(label)}` : '';
  $<HTMLAnchorElement>('go-wallet').href = `/new#signin=wallet${hash}`;
  $<HTMLAnchorElement>('go-key').href = `/new#signin=key${hash}`;
  $('where').textContent = `${label ?? 'yourname'}.${GATEWAY}`;
  $('command').textContent = `dash-sites publish ./my-site --name ${label ?? 'alice'} --network ${NETWORK}`;
}

let turn = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
input.addEventListener('focus', () => void connect().catch(() => {}), { once: true });
input.addEventListener('input', () => {
  const mine = ++turn;
  clearTimeout(timer);
  const typed = input.value.trim();
  if (!typed) {
    point(undefined);
    return say();
  }
  const name = parseName(typed);
  if (!name) {
    point(undefined);
    return say(span('span', 'Use 3 to 63 letters, digits and hyphens, starting and ending with a letter or digit.', 'bad'));
  }
  point(name.label);
  const full = `${name.label}.dash`;
  const notes: string[] = [];
  if (name.normalized !== name.label) notes.push(` The network stores it as ${name.normalized}, so look-alike spellings are the same name.`);
  if (/^[a-z01-]{3,19}$/.test(name.normalized)) notes.push(' Short names made only of letters and hyphens are contested: masternodes vote on who gets them, so register those in your wallet.');
  say(`Asking Dash Platform about ${full}…`);
  timer = setTimeout(() => {
    void (async () => {
      try {
        const platform = await connect();
        const domain = (await platform.getDomain(name.normalized)).value;
        if (mine !== turn) return;
        if (!domain) return say(span('mark', `${full} is free`), ...notes);
        const site = platform.noSiteContract ? undefined : (await platform.getSite(name.normalized)).value;
        if (mine !== turn) return;
        if (site?.content !== undefined) {
          const url = `https://${site.label.toLowerCase()}.${GATEWAY}/`;
          return say(`${full} is taken and has a site. `, Object.assign(document.createElement('a'), { href: url, textContent: 'Visit it', target: '_blank', rel: 'noopener' }));
        }
        say(`${full} is registered and has no site yet. ${platform.noSiteContract ? `Publishing on ${NETWORK} is not open yet.` : 'If it is yours, sign in below to publish one.'}`);
      } catch {
        if (mine === turn) say(span('span', `Could not reach Dash Platform to check ${full}. The editor checks again when you sign in.`, 'bad'));
      }
    })();
  }, 350);
});

const slider = $<HTMLInputElement>('size');
const sizeAt = (position: number): number => Math.round(5_000 * 2000 ** (position / 100));
function price(): void {
  const size = sizeAt(Number(slider.value));
  $('cost').textContent = dash(cost(size));
  $('cost-note').textContent = `for a ${sizeText(size)} site. A one-page site written in the editor costs about ${dash(cost(6_000))}.`;
}
slider.addEventListener('input', price);
$('network').textContent = NETWORK;
price();
point(undefined);
