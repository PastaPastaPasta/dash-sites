import { bytes, documents, manifest, short, stored } from './site.js';

const NS = 'http://www.w3.org/2000/svg';
const el = (name, attrs = {}) => {
  const node = document.createElementNS(NS, name);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  return node;
};

/** Splits a rectangle among items in proportion to their weight, halving the list each time. */
function layout(items, x, y, w, h, out) {
  if (items.length === 1) return void out.push({ ...items[0], x, y, w, h });
  const total = items.reduce((sum, item) => sum + item.weight, 0);
  let split = 1;
  for (let sum = items[0].weight; split < items.length - 1 && sum + items[split].weight / 2 < total / 2; split++) sum += items[split].weight;
  const first = items.slice(0, split);
  const share = first.reduce((sum, item) => sum + item.weight, 0) / total;
  if (w >= h) {
    layout(first, x, y, w * share, h, out);
    layout(items.slice(split), x + w * share, y, w * (1 - share), h, out);
  } else {
    layout(first, x, y, w, h * share, out);
    layout(items.slice(split), x, y + h * share, w, h * (1 - share), out);
  }
}

/** Draws the site as a floor plan: one room per file, sized by the bytes it takes on Platform. */
export async function drawPlan(svg, readout) {
  const data = await manifest();
  const files = Object.entries(data.files).map(([path, file]) => ({ path, file, size: stored(file) }));
  const total = files.reduce((sum, item) => sum + item.size, 0);
  const items = files.map((item) => ({ ...item, weight: Math.max(item.size, total * 0.018) })).sort((a, b) => b.weight - a.weight);
  const narrow = svg.clientWidth < 560;
  const W = narrow ? 360 : 1000;
  const H = narrow ? 540 : 600;
  const edge = narrow ? 6 : 14;
  const rooms = [];
  layout(items, edge, edge, W - 2 * edge, H - 2 * edge, rooms);

  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.replaceChildren();
  const defs = el('defs');
  const hatch = el('pattern', { id: 'hatch', width: 9, height: 9, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' });
  hatch.append(el('line', { x1: 0, y1: 0, x2: 0, y2: 9, stroke: 'rgb(143 176 234 / .3)', 'stroke-width': 1.5 }));
  defs.append(hatch);
  svg.append(defs);

  const describe = (room) => {
    const count = documents(room.file);
    const size = room.file.enc ? `${bytes(room.file.size)}, stored as ${bytes(room.size)} of gzip` : bytes(room.file.size);
    readout.replaceChildren(
      Object.assign(document.createElement('b'), { textContent: room.path }),
      ` is ${size} in ${count} ${count === 1 ? 'document' : 'documents'}. SHA-256 ${short(room.file.sha256, 10)}`,
    );
  };
  rooms.forEach((room, i) => {
    const rect = el('rect', { x: room.x + 3, y: room.y + 3, width: Math.max(1, room.w - 6), height: Math.max(1, room.h - 6), class: `room${room.file.enc ? ' gz' : ''}`, tabindex: 0, role: 'link', 'aria-label': `${room.path}, ${bytes(room.file.size)}` });
    rect.style.setProperty('--len', String(2 * (room.w + room.h)));
    rect.style.setProperty('--i', String(i));
    rect.addEventListener('pointerenter', () => describe(room));
    rect.addEventListener('focus', () => describe(room));
    rect.addEventListener('click', () => open(room.path, '_blank'));
    rect.addEventListener('keydown', (event) => event.key === 'Enter' && open(room.path, '_blank'));
    svg.append(rect);
    const fits = (label) => room.w > label.length * 8.4 + 20 && room.h > 44;
    const name = [room.path.slice(1), room.path.split('/').pop()].find(fits);
    if (name) {
      const text = el('text', { x: room.x + 14, y: room.y + 28 });
      text.textContent = name;
      const dim = el('text', { x: room.x + 14, y: room.y + 45, class: 'dim' });
      dim.textContent = bytes(room.size);
      svg.append(text, dim);
    }
  });
  readout.textContent = `${files.length} files, ${bytes(total)} stored in ${data.chunks.length} documents. Point at a room. Hatched rooms are stored compressed.`;
  return { files: files.length, documents: data.chunks.length, total };
}
