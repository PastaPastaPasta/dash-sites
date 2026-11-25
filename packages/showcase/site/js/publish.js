import { bytes, host, manifest, stored } from './site.js';

const CREDITS_PER_DASH = 1e11;
const cost = (size) => (size * 27_500 + Math.ceil(size / 14_700) * 28_000_000 + 60_000_000) / CREDITS_PER_DASH;
const dash = (amount) => `${amount < 0.01 ? amount.toFixed(4) : amount.toFixed(3)} DASH`;

const input = document.getElementById('name');
const answer = document.getElementById('answer');
const normalize = (label) => label.toLowerCase().replace(/o/g, '0').replace(/[il]/g, '1');
const valid = (label) => /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/i.test(label) && label.slice(2, 4) !== '--';
const say = (...nodes) => answer.replaceChildren(...nodes);
const mark = (text) => Object.assign(document.createElement('mark'), { textContent: text });

let turn = 0;
input.addEventListener('input', () => {
  const mine = ++turn;
  const label = input.value.trim().replace(/\.dash$/i, '');
  if (!label) return say();
  if (!valid(label)) return say('Use 3 to 63 letters, digits and hyphens, starting and ending with a letter or digit.');
  const name = `${label.toLowerCase()}.dash`;
  const normalized = normalize(label);
  const notes = [];
  if (normalized !== label.toLowerCase()) notes.push(` The network stores it as ${normalized}, so look-alike spellings are the same name.`);
  if (/^[a-z01-]{3,19}$/.test(normalized)) notes.push(' Short names made only of letters and hyphens are contested: masternodes vote on who gets them.');
  say(`Asking Dash Platform about ${name}`);
  setTimeout(async () => {
    if (mine !== turn) return;
    try {
      const found = await host(`resolve/${encodeURIComponent(label)}`);
      if (mine !== turn) return;
      if (found.status === 'unregistered') return say(mark(`${name} is free`), ' Register it in the wallet, or sign in with a key, before you publish.', ...notes);
      if (found.status === 'invalid') return say(`${name} is not a valid name.`);
      if (found.status === 'no-site') return say(`${name} is registered and has no site yet.`);
      const site = `${found.name.replace(/\.dash$/, '')}.${location.host.split('.').slice(1).join('.')}`;
      const link = Object.assign(document.createElement('a'), { href: found.url ?? `${location.protocol}//${site}/`, textContent: 'Visit it' });
      say(`${name} is taken and has a site. `, link);
    } catch {
      if (mine === turn) say(`Could not reach Dash Platform to check ${name}. The builder will tell you when you sign in.`);
    }
  }, 350);
});

const slider = document.getElementById('size');
const output = document.getElementById('cost');
const note = document.getElementById('cost-note');
const sizeAt = (position) => Math.round(5_000 * 2000 ** (position / 100));
let own = '';
function price() {
  const size = sizeAt(Number(slider.value));
  output.textContent = dash(cost(size));
  note.textContent = `for a ${size < 1e6 ? bytes(size) : `${(size / 1048576).toFixed(1)} MB`} site.${own}`;
}
slider.addEventListener('input', price);
price();
manifest().then((data) => {
  const total = Object.values(data.files).reduce((sum, file) => sum + stored(file), 0);
  own = ` This site takes ${bytes(total)} and cost about ${dash(cost(total))}.`;
  price();
});
