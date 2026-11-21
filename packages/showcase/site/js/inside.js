import { bytes, manifest, record, short, stored } from './site.js';

const cell = (text, className) => Object.assign(document.createElement('td'), { textContent: text, className: className ?? '' });

manifest().then((data) => {
  const rows = Object.entries(data.files).map(([path, file]) => {
    const row = document.createElement('tr');
    const link = Object.assign(document.createElement('a'), { href: path, textContent: path });
    const name = document.createElement('td');
    name.append(link);
    const documents = new Set(file.parts.map((part) => part[0])).size;
    row.append(name, cell(file.type.split(';')[0]), cell(bytes(file.size), 'num'), cell(file.enc ? `${bytes(stored(file))} gzip` : bytes(stored(file)), 'num'), cell(String(documents), 'num'), cell(short(file.sha256, 8)));
    row.lastChild.title = file.sha256;
    return row;
  });
  document.getElementById('files').replaceChildren(...rows);
});

const button = document.getElementById('check');
const log = document.getElementById('log');
const report = (ok, text) => log.append(Object.assign(document.createElement('li'), { textContent: text, className: ok ? 'ok' : 'bad' }));

button.addEventListener('click', async () => {
  button.disabled = true;
  log.replaceChildren();
  log.append(Object.assign(document.createElement('li'), { textContent: 'Downloading the Dash SDK and connecting' }));
  try {
    const [{ verify }, r] = await Promise.all([import('./verify.js'), record()]);
    await verify(r.name.replace(/\.dash$/, ''), r.network, report);
  } catch (error) {
    report(false, `The check could not finish: ${error.message}`);
  }
  button.disabled = false;
  button.textContent = 'Check again';
});
