// Builds the reference page of docs/VISUAL-BUILDER.md §3 in the page editor of the built builder
// (dist-site, as dash.site/new serves it, with its Content-Security-Policy), with no network.
//   npm run build && node e2e/page-editor.mjs [screenshot-dir]
// Checks: no policy violations, no request to any other host, the editor loads only when opened,
// the published HTML matches what the editor shows and is about the size the prototype measured.
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { brotliCompressSync, constants, deflateSync, gzipSync } from 'node:zlib';
import { build } from 'esbuild';
import { zipSync } from 'fflate';
import { chromium } from 'playwright';
import { closeEditor, fillItems, openEditor, typeInPlace } from './page-editor-steps.mjs';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const site = join(repo, 'packages', 'builder', 'dist-site');
const shots = process.argv[2];
if (shots) mkdirSync(shots, { recursive: true });
const check = (ok, message) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${message}`);
  if (!ok) process.exitCode = 1;
};
const brotli = (bytes) => brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).length;
const gzip = (bytes) => gzipSync(bytes, { level: 9 }).length;

// The policy of dash.site/new (packages/builder/build.mjs) and of the builder's own meta tag.
const HEADER_CSP =
  "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline' data:; img-src 'self' data:; font-src 'self'; connect-src https:; frame-src 'self' about: data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const META_CSP =
  "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline' data:; img-src 'self' data:; font-src 'self'; connect-src https:; frame-src 'self' about: data:; base-uri 'none'; form-action 'none'";
// Measured for the Puck prototype in docs/VISUAL-BUILDER.md §3: the reference page as published.
const PROTOTYPE = { raw: 2286, gzip: 1254, brotli: 943 };

if (!existsSync(join(site, '_headers'))) throw new Error('build first: npm run build');
const headers = readFileSync(join(site, '_headers'), 'utf8');
const served = Object.fromEntries([...headers.split('\n/new/')[0].matchAll(/^ {2}([\w-]+): (.*)$/gm)].map((m) => [m[1], m[2]]));
check(served['Content-Security-Policy'] === HEADER_CSP, 'dash.site/new is served with the same Content-Security-Policy as before');
const index = readFileSync(join(site, 'new', 'index.html'), 'utf8');
check(index.includes(`content="${META_CSP}"`), 'the builder page carries the same policy in its meta tag');

function png(width, height) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (bytes) => {
    let c = 0xffffffff;
    for (const b of bytes) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, 'latin1');
    data.copy(out, 8);
    out.writeUInt32BE(crc(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
  };
  const raw = Buffer.alloc((width * 3 + 1) * height);
  let seed = 7;
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0;
    for (let x = 0; x < width; x++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const noise = (seed >> 16) % 24;
      const at = y * (width * 3 + 1) + 1 + x * 3;
      const grain = 30 * Math.sin(x / 23 + 4 * Math.sin(y / 61));
      raw[at] = Math.min(255, 150 + grain + noise);
      raw[at + 1] = Math.min(255, 100 + grain * 0.7 + noise);
      raw[at + 2] = Math.min(255, 55 + grain * 0.4 + noise);
    }
  }
  const head = Buffer.alloc(13);
  head.writeUInt32BE(width, 0);
  head.writeUInt32BE(height, 4);
  head[8] = 8;
  head[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', head), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const work = mkdtempSync(join(tmpdir(), 'page-editor-'));
const photo = join(work, 'alice.png');
writeFileSync(photo, png(1200, 900));
await build({ entryPoints: [join(repo, 'packages', 'builder', 'src', 'page', 'render.ts')], bundle: true, platform: 'node', format: 'esm', outfile: join(work, 'render.mjs'), logLevel: 'warning' });
const { renderSite } = await import(pathToFileURL(join(work, 'render.mjs')).href);

// These two need HTTPS, which this local server does not have.
const plain = Object.fromEntries(Object.entries(served).filter(([name]) => !['Cross-Origin-Opener-Policy', 'Strict-Transport-Security'].includes(name)));
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
const server = createServer((req, res) => {
  let path = normalize(new URL(req.url, 'http://x').pathname);
  if (path === '/new') path = '/new/index.html';
  const file = join(site, path);
  if (!file.startsWith(site) || !existsSync(file) || !statSync(file).isFile()) return res.writeHead(404).end();
  res.writeHead(200, { ...plain, 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream' });
  res.end(readFileSync(file));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const host = `builder.test:${server.address().port}`;
const browser = await chromium.launch({ args: ['--host-resolver-rules=MAP builder.test 127.0.0.1'] });

const violations = [];
const outside = [];
const requested = [];
async function open({ phone = false, dark = false, draft } = {}) {
  const context = await browser.newContext({ viewport: phone ? { width: 390, height: 844 } : { width: 1280, height: 800 }, colorScheme: dark ? 'dark' : 'light', hasTouch: phone, isMobile: phone });
  await context.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.host === host || url.protocol === 'data:') return route.continue();
    outside.push(route.request().url());
    return route.abort();
  });
  await context.addInitScript((saved) => {
    document.addEventListener('securitypolicyviolation', (event) => console.error(`CSP violation: ${event.violatedDirective} ${event.blockedURI}`));
    if (saved && window === window.top) for (const [key, value] of Object.entries(saved)) localStorage.setItem(key, value);
  }, draft);
  const page = await context.newPage();
  page.on('console', (m) => m.type() === 'error' && violations.push(m.text()));
  page.on('pageerror', (e) => violations.push(`page error: ${e.message}`));
  page.on('request', (r) => requested.push(r.url()));
  await page.goto(`http://${host}/new`);
  await page.waitForSelector('#edit-page');
  return page;
}

const ABOUT =
  'I started with a borrowed chisel and a kitchen table, and ten years later the table is the only thing in the flat I did not make. This page collects the pieces I have for sale, the notes I keep on sharpening and joinery, and the places where you can find me. Everything here is paid for once and stored on Dash Platform under my name, so it stays up without a hosting bill.';

try {
  const page = await open();
  check(!requested.some((url) => /\/c\/editor-/.test(url)), 'the builder loads without the editor');

  await openEditor(page);
  check(requested.some((url) => /\/c\/editor-/.test(url)), 'opening the page editor loads it');
  await typeInPlace(page, '.dsp h1', 'Alice Nakamoto');
  await typeInPlace(page, '.dsp .tagline', 'Woodworker in Lisbon. I build small furniture and write about the tools.');
  await page.locator('.dsp header').click();
  await page.setInputFiles('.ed-image:visible input[type=file]', photo);
  await page.waitForSelector('.ed-size:visible select', { timeout: 30000 });
  const sizes = await page.locator('.ed-size:visible option').allTextContents();
  check(sizes.length >= 2 && sizes.every((text) => /\d+ × \d+, [\d.]+ KB, 0\.\d{5} DASH/.test(text)), `the picture is offered in ${sizes.length} sizes with their prices: ${sizes.join(' | ')}`);
  await page.selectOption('.ed-size:visible select', { index: 0 });
  await page.waitForSelector('.dsp img.me[src^="data:image/"]');
  await typeInPlace(page, '.dsp .tx', ABOUT);
  await fillItems(page, '.links', [
    { label: 'Shop: stools and side tables', url: 'https://example.com/shop' },
    { label: 'Notes on sharpening', url: '/notes/sharpening' },
    { label: 'Mastodon', url: 'https://example.social/@alice' },
    { label: 'Write to me', url: 'mailto:alice@example.com' },
  ]);
  await page.locator('.dsp .links').click();
  await page.selectOption('.ed-add', 'cards');
  await page.waitForSelector('.dsp .cards');
  await fillItems(page, '.cards', [
    { title: 'Made to order', text: 'Each piece is cut and finished by hand in four to six weeks.' },
    { title: 'Local oak and ash', text: 'Timber comes from two sawmills within an hour of the workshop.' },
    { title: 'Pay in Dash', text: 'Send to alice.dash from any DashPay wallet, with no card fees.' },
  ]);
  await typeInPlace(page, '.dsp footer', 'alice.dash is published on Dash Platform.');
  await page.click('.ed-themes button:has-text("Night")');
  await page.click('.ed-themes button:has-text("Paper")');
  await page.waitForTimeout(600);
  check(/^0\.\d{5} DASH/.test(await page.textContent('.ed-cost b')), `the editor shows the cost while editing: ${(await page.textContent('.ed-cost')).replace(/\s+/g, ' ')}`);
  const canvas = (await page.locator('.dsp main').innerText()).replace(/\s+/g, ' ').trim();
  await page.locator('.dsp header img').click();
  await page.locator('.dsp header').evaluate((element) => element.scrollIntoView({ block: 'start' }));
  await page.waitForTimeout(400);
  if (shots) await page.screenshot({ path: join(shots, 'editor-desktop-light.png') });
  await closeEditor(page);

  check((await page.textContent('#page-summary')) === '5 blocks: Profile header, Text, Link list, Columns of cards, Footer.', `the builder lists the page: ${await page.textContent('#page-summary')}`);
  check(/text about 0\.\d{5} DASH, one image \([\d.]+ KB\) about 0\.\d{5} DASH/.test(await page.textContent('#page-cost')), `and splits its cost: ${await page.textContent('#page-cost')}`);
  check((await page.locator('#page-images li').count()) === 1, `and lists the image with its price: ${await page.textContent('#page-images li')}`);
  await page.waitForTimeout(400);
  if (shots) await page.screenshot({ path: join(shots, 'builder-page-tab.png'), fullPage: true });

  const stored = await page.evaluate(() => ({ model: localStorage.getItem('dash-sites.page'), images: localStorage.getItem('dash-sites.page-images') }));
  const model = JSON.parse(stored.model);
  const images = Object.entries(JSON.parse(stored.images)).map(([path, data]) => ({ path, type: 'image/webp', bytes: new Uint8Array(Buffer.from(data, 'base64')) }));
  check(model.v === 1 && model.pages['/'].length === 5 && images.length === 1 && images[0].path === model.pages['/'][0].props.image, `the draft keeps the page model (${stored.model.length} bytes) and its image (${images[0]?.bytes.length} bytes, ${images[0]?.path})`);
  const files = renderSite(model, 'yourname.dash', images);
  const html = Buffer.from(files.find((f) => f.path === '/index.html').bytes);
  const again = Buffer.from(renderSite(JSON.parse(stored.model), 'yourname.dash', images).find((f) => f.path === '/index.html').bytes);
  check(html.equals(again), 'the same model gives the same bytes');
  const srcdoc = await page.getAttribute('#frame', 'srcdoc');
  const asPublished = srcdoc.replace(/src="data:image\/webp;base64,([^"]+)"/g, (whole, data) => `src="${images.find((image) => Buffer.from(image.bytes).toString('base64') === data)?.path ?? whole}"`);
  check(asPublished === html.toString(), 'the preview is the published page');
  const shown = (await page.frameLocator('#frame').locator('main').innerText()).replace(/\s+/g, ' ').trim();
  check(shown === canvas, 'the editor shows the same text as the published page');
  check(!/<script|<link|@import|url\(/i.test(html.toString()) && html.toString().split('<style>').length === 2, 'the published page has one stylesheet, no script and no outside fonts');
  const size = { raw: html.length, gzip: gzip(html), brotli: brotli(html) };
  const within = (key) => size[key] <= PROTOTYPE[key] * 1.2;
  check(within('raw') && within('gzip') && within('brotli'), `the reference page is ${size.raw} bytes, ${size.gzip} gzip, ${size.brotli} brotli (prototype: ${PROTOTYPE.raw}, ${PROTOTYPE.gzip}, ${PROTOTYPE.brotli})`);
  const modelFile = Buffer.from(files.find((f) => f.path === '/dash-site.json').bytes);
  console.log(`     page model /dash-site.json: ${modelFile.length} bytes, ${gzip(modelFile)} gzip; picture ${images[0].bytes.length} bytes`);

  if (shots) {
    for (const theme of ['paper', 'night', 'signal']) {
      const view = await browser.newPage({ viewport: { width: 900, height: 1000 } });
      const themed = renderSite({ ...model, theme }, 'alice.dash', images).find((f) => f.path === '/index.html');
      const inline = Buffer.from(themed.bytes).toString().replace(/src="(\/images\/[^"]+)"/g, (_, path) => `src="data:image/webp;base64,${Buffer.from(images.find((i) => i.path === path).bytes).toString('base64')}"`);
      await view.setContent(inline);
      await view.screenshot({ path: join(shots, `page-${theme}.png`), fullPage: true });
      await view.close();
    }
  }

  await page.reload();
  await page.waitForSelector('#edit-page');
  check((await page.textContent('#page-summary')).startsWith('5 blocks') && (await page.locator('#page-images li').count()) === 1, 'a reload keeps the draft and its image');
  await page.click('#tab-upload');
  const zip = join(work, 'site.zip');
  writeFileSync(zip, zipSync({ 'my-site/index.html': new TextEncoder().encode('<h1>Uploaded</h1>'), 'my-site/a.css': new TextEncoder().encode('h1{}') }));
  await page.setInputFiles('#pick-zip', zip);
  await page.waitForFunction(() => /^2 files/.test(document.getElementById('upload-status')?.textContent ?? ''));
  await page.frameLocator('#frame').locator('h1:has-text("Uploaded")').waitFor({ timeout: 5000 }).catch(() => {});
  check((await page.frameLocator('#frame').locator('h1').textContent()) === 'Uploaded', 'the upload tab still works');
  await page.click('#tab-write');
  await page.frameLocator('#frame').locator('h1:has-text("Alice")').waitFor({ timeout: 5000 }).catch(() => {});
  check((await page.frameLocator('#frame').locator('h1').textContent()) === 'Alice Nakamoto', 'and switching back shows the built page');
  await page.context().close();

  const legacy = await open({ draft: { 'dash-sites.draft': JSON.stringify({ title: 'Old page', tagline: 'From the form', body: 'Some *text*.', links: [{ label: 'Code', url: 'github.com/x' }], theme: 'night' }) } });
  check((await legacy.textContent('#page-summary')) === '3 blocks: Profile header, Text, Link list.', 'a draft of the old form opens as a header, a text block and a link list');
  check((await legacy.getAttribute('#themes button[aria-checked=true]', 'textContent').catch(() => null)) !== undefined && (await legacy.textContent('#themes button[aria-checked=true]')) === 'Night', 'with its look');
  await legacy.context().close();

  for (const dark of [false, true]) {
    const phone = await open({ phone: true, dark, draft: { 'dash-sites.page': stored.model, 'dash-sites.page-images': stored.images } });
    await openEditor(phone);
    await phone.locator('.dsp h1').tap();
    await phone.waitForTimeout(300);
    await phone.selectOption('.ed-add', 'button');
    await phone.waitForSelector('.dsp .btn');
    check(await phone.isVisible('.ed-done'), `on a phone${dark ? ' in dark mode' : ''} the editor adds blocks and keeps Done and the cost in view`);
    if (shots) await phone.screenshot({ path: join(shots, `editor-phone-${dark ? 'dark' : 'light'}.png`) });
    await phone.context().close();
  }
  const darkDesktop = await open({ dark: true, draft: { 'dash-sites.page': stored.model, 'dash-sites.page-images': stored.images } });
  await openEditor(darkDesktop);
  await darkDesktop.locator('.dsp header img').click();
  await darkDesktop.click('.ed-image:visible button:has-text("Show smaller sizes")');
  await darkDesktop.waitForSelector('.ed-size:visible select', { timeout: 30000 });
  const kept = await darkDesktop.locator('.ed-size:visible option').allTextContents();
  check(kept.length >= 1 && (await darkDesktop.inputValue('.ed-size:visible select')) === model.pages['/'][0].props.image, `an image reloaded from the draft can be made smaller: ${kept.join(' | ')}`);
  await darkDesktop.locator('.dsp .cards').click();
  await darkDesktop.click('.ed-themes button:has-text("Night")');
  await darkDesktop.waitForTimeout(500);
  if (shots) await darkDesktop.screenshot({ path: join(shots, 'editor-desktop-dark.png') });
  await darkDesktop.context().close();

  check(violations.length === 0, `no policy violations or page errors${violations.length ? `: ${[...new Set(violations)].join(' | ')}` : ''}`);
  check(outside.length === 0, `no request to any other host${outside.length ? `: ${[...new Set(outside)].join(' ')}` : ''}`);

  const assets = join(site, 'new', 'assets');
  const imports = (file) => [...readFileSync(join(assets, file), 'utf8').matchAll(/(?:from|import)\s*\(?\s*"\.\/((?:c\/)?[\w.-]+\.js)"/g)].map((m) => (file.startsWith('c/') && !m[1].startsWith('c/') ? `c/${m[1]}` : m[1]));
  const reach = (start, dynamic) => {
    const seen = new Set();
    const visit = (file) => {
      if (seen.has(file)) return;
      seen.add(file);
      const text = readFileSync(join(assets, file), 'utf8');
      const found = dynamic ? imports(file) : [...text.matchAll(/from\s*"\.\/((?:c\/)?[\w.-]+\.js)"|import\s*"\.\/((?:c\/)?[\w.-]+\.js)"/g)].map((m) => m[1] ?? m[2]).map((f) => (file.startsWith('c/') && !f.startsWith('c/') ? `c/${f}` : f));
      for (const next of found) visit(next);
    };
    visit(start);
    return seen;
  };
  const sign = reach('app.js', false);
  const entry = `c/${readdirSync(join(assets, 'c')).find((name) => name.startsWith('editor-'))}`;
  const editorFiles = [...reach(entry, true)].filter((file) => !sign.has(file) && !/\/(evo|connect)-/.test(file));
  const sum = (files, fn) => files.reduce((total, file) => total + fn(readFileSync(join(assets, file))), 0);
  console.log(`     builder page script: ${sum([...sign], (b) => b.length)} bytes, ${sum([...sign], brotli)} brotli (${sign.size} files)`);
  console.log(`     editor, loaded when opened: ${sum(editorFiles, (b) => b.length)} bytes, ${sum(editorFiles, brotli)} brotli (${editorFiles.length} files)`);
} finally {
  await browser.close();
  server.close();
  rmSync(work, { recursive: true, force: true });
}
