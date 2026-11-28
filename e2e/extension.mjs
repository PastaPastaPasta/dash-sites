// Loads the built Chrome extension and opens live mainnet names with no gateway.
//   node e2e/extension.mjs [name] [screenshot-dir]
// Fails if a .dash page reaches any host by name (DNS), or a search for a .dash name reaches the engine.
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const name = process.argv[2] ?? 'forg3';
const shots = process.argv[3];
const extension = join(dirname(fileURLToPath(import.meta.url)), '..', 'packages', 'extension', 'build', 'chrome');
const check = (ok, message) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${message}`);
  if (!ok) process.exitCode = 1;
};
if (shots) mkdirSync(shots, { recursive: true });
const IP = /^(\d+\.\d+\.\d+\.\d+|\[[0-9a-f:]+\])$/i;

const work = mkdtempSync(join(tmpdir(), 'dash-sites-native-'));
const context = await chromium.launchPersistentContext(join(work, 'profile'), {
  channel: 'chromium',
  headless: true,
  viewport: { width: 1200, height: 760 },
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
});
const hosts = new Map();
// A redirect rule shows as an internal 307 the browser made up; only real answers count.
const internal = async (response) => response.status() === 307 && Boolean((await response.allHeaders())['non-authoritative-reason']);
context.on('response', async (response) => {
  if (await internal(response)) return;
  const url = new URL(response.url());
  if (url.protocol === 'https:' || url.protocol === 'http:') hosts.set(url.hostname, (hosts.get(url.hostname) ?? 0) + 1);
});
const settled = (page) =>
  page.waitForFunction(() => ['ok', 'partial', 'none', 'error'].includes(document.getElementById('badge')?.dataset.kind ?? ''), null, { timeout: 240000 });

try {
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  const id = new URL(worker.url()).host;
  for (let i = 0; i < 100 && (await worker.evaluate(() => chrome.declarativeNetRequest.getDynamicRules())).length === 0; i++) await new Promise((r) => setTimeout(r, 100));
  const viewer = `chrome-extension://${id}/site.html`;
  const outcome = await worker.evaluate(async (url) => {
    try {
      return JSON.stringify(await chrome.declarativeNetRequest.testMatchOutcome({ url, type: 'main_frame' }));
    } catch (error) {
      return String(error);
    }
  }, `https://www.google.com/search?q=${name}.dash&oq=${name}.dash&sourceid=chrome&ie=UTF-8`);
  console.log(`     rules for a Google search: ${outcome}; ${(await worker.evaluate(() => chrome.declarativeNetRequest.getDynamicRules())).length} rules`);

  const page = await context.newPage();
  const started = Date.now();
  await page.goto(`http://${name}.dash/`, { waitUntil: 'domcontentloaded' });
  check(page.url() === `${viewer}#${name}.dash/`, `http://${name}.dash/ opens the viewer: ${page.url()}`);
  await settled(page);
  const kind = await page.evaluate(() => document.getElementById('badge').dataset.kind);
  check(kind === 'ok' || kind === 'partial', `${name}.dash verified (${kind}) in ${Math.round((Date.now() - started) / 1000)} s: ${await page.textContent('#badge-text')}`);
  if (kind === 'error') console.log(`     ${await page.textContent('#status-title')}: ${await page.textContent('#status-detail')}`);
  await page.waitForSelector('#frame', { timeout: 30000 }).catch(() => undefined);
  let frame;
  for (let i = 0; i < 50 && !frame; i++, await page.waitForTimeout(100)) frame = page.frames().find((f) => f.url().startsWith(`chrome-extension://${id}/sandbox.html`));
  if (frame) await frame.waitForFunction(() => document.body && document.body.innerText.trim().length > 0, null, { timeout: 30000 }).catch(() => undefined);
  check(Boolean(frame), 'the site renders in the sandbox page');
  if (frame) {
    await frame.waitForLoadState('load');
    const info = await frame.evaluate(() => ({
      origin: self.origin,
      chrome: typeof globalThis.chrome?.runtime?.id,
      text: document.body?.innerText.slice(0, 120) ?? '',
      storage: (() => {
        localStorage.setItem('k', 'v');
        return localStorage.getItem('k');
      })(),
    }));
    check(info.origin === 'null', `the site runs in an opaque origin (${info.origin})`);
    check(info.chrome === 'undefined', 'the site has no extension APIs');
    check(info.text.length > 0, `the site shows content: ${JSON.stringify(info.text.slice(0, 60))}`);
    check(info.storage === 'v', 'localStorage works (in memory)');
    const failures = [];
    const onFailed = (request) => {
      if (new URL(request.url()).hostname.endsWith('.dash')) failures.push(request.failure()?.errorText);
    };
    context.on('requestfailed', onFailed);
    await frame.evaluate(() => new Promise((resolve) => {
      const img = document.createElement('img');
      img.onerror = img.onload = () => resolve(undefined);
      img.src = '/definitely-not-a-file.png';
      document.body.append(img);
    }));
    await page.waitForTimeout(500);
    context.off('requestfailed', onFailed);
    check(failures.length > 0 && failures.every((text) => /BLOCKED_BY_CLIENT/.test(text ?? '')), `an image the site lacks is blocked before DNS: ${failures.join(', ') || 'no request seen'}`);
    const record = await frame.evaluate(async () => (await fetch('/.well-known/dash/site.json')).json());
    check(record.status === 'ok' && record.servedBy === 'browser', `the site reads the host API: ${record.name}, proved at block ${record.proof?.height}`);
  }
  const title = await page.title();
  check(title.includes(`${name}.dash`), `tab title: ${title}`);
  if (shots) {
    await frame?.waitForFunction(() => document.fonts.ready.then(() => true)).catch(() => undefined);
    await page.waitForTimeout(1500);
    for (const scheme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.waitForTimeout(300);
      await page.screenshot({ path: join(shots, `viewer-${scheme}.png`) });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.waitForTimeout(300);
      await page.screenshot({ path: join(shots, `viewer-phone-${scheme}.png`) });
      await page.setViewportSize({ width: 1200, height: 760 });
      await page.click('#badge');
      await page.screenshot({ path: join(shots, `viewer-details-${scheme}.png`) });
      await page.click('#badge');
    }
  }

  // A navigation inside the site, if it links to another page of itself.
  if (frame) {
    const href = await frame.evaluate(() => [...document.querySelectorAll('a[href]')].map((a) => a.href).find((h) => new URL(h).hostname.endsWith('.dash') && new URL(h).pathname !== '/'));
    if (href) {
      await frame.evaluate((h) => [...document.querySelectorAll('a[href]')].find((a) => a.href === h).click(), href);
      await page.waitForFunction((p) => location.hash.includes(p), new URL(href).pathname, { timeout: 30000 }).catch(() => undefined);
      check(page.url().includes(new URL(href).pathname), `a link inside the site moves the viewer to ${page.url()}`);
    } else console.log('skip no internal link to follow');
  }

  // A site that moves its own frame lands in the sandbox again, which asks the viewer for that address.
  await page.goto(`${viewer}#${name}.dash/`);
  await settled(page);
  await page.waitForSelector('#frame');
  let moved;
  for (let i = 0; i < 50 && !moved; i++, await page.waitForTimeout(100)) moved = page.frames().find((f) => f.url().startsWith(`chrome-extension://${id}/sandbox.html`));
  await moved?.waitForFunction(() => document.body && document.body.innerText.trim().length > 0, null, { timeout: 30000 }).catch(() => undefined);
  await moved?.evaluate(() => void (location.href = new URL('/no-such-page', document.baseURI).href)).catch(() => undefined);
  await page.waitForFunction(() => location.hash.endsWith('/no-such-page'), null, { timeout: 30000 }).catch(() => undefined);
  check(page.url().endsWith('/no-such-page'), `a site that sets location.href moves the viewer: ${page.url()}`);
  let base = '';
  for (let i = 0; i < 100 && !base.endsWith('/no-such-page'); i++, await page.waitForTimeout(100)) {
    const again = page.frames().find((f) => f.url().startsWith(`chrome-extension://${id}/sandbox.html`));
    base = (await again?.evaluate(() => (document.body?.innerText ? document.baseURI : '')).catch(() => '')) ?? '';
  }
  check(base.endsWith('/no-such-page'), `and the sandbox shows that address: ${base}`);

  const search = await context.newPage();
  const engine = [];
  search.on('response', async (response) => {
    if (new URL(response.url()).hostname.endsWith('google.com') && !(await internal(response))) engine.push(`${response.status()} ${response.url()}`);
  });
  search.on('requestfailed', (request) => console.log(`     failed: ${request.url().slice(0, 100)} ${request.failure()?.errorText}`));
  search.on('framenavigated', (frame) => frame === search.mainFrame() && console.log(`     navigated: ${frame.url().slice(0, 100)}`));
  // The redirect to the extension aborts Playwright's navigation; the tab still ends at the viewer.
  await search.goto(`https://www.google.com/search?q=${name}.dash&oq=${name}.dash&sourceid=chrome&ie=UTF-8`, { waitUntil: 'domcontentloaded' }).catch(() => undefined);
  await search.waitForURL(/^chrome-extension:/, { timeout: 10000 }).catch(() => undefined);
  check(search.url() === `${viewer}#${name}.dash`, `a Google search for ${name}.dash opens the viewer: ${search.url()}`);
  check(engine.length === 0, `the search never reached Google (${engine.join(', ') || 'no responses'})`);
  await search.close();

  const none = await context.newPage();
  await none.goto('https://p2p.dash/some/path?x=1', { waitUntil: 'domcontentloaded' }).catch(() => undefined);
  await settled(none);
  check((await none.textContent('#status-title'))?.includes('has no site'), `p2p.dash: ${await none.textContent('#status-title')}`);
  if (shots) {
    for (const scheme of ['light', 'dark']) {
      await none.emulateMedia({ colorScheme: scheme });
      await none.screenshot({ path: join(shots, `no-site-${scheme}.png`) });
    }
  }
  await none.close();

  const popup = await context.newPage();
  await popup.setViewportSize({ width: 330, height: 220 });
  await popup.goto(`chrome-extension://${id}/popup.html`);
  await popup.waitForFunction(() => document.getElementById('chain').textContent.length > 0);
  check((await popup.textContent('#chain')).includes('verified to'), `popup: ${await popup.textContent('#chain')}`);
  if (shots) {
    for (const scheme of ['light', 'dark']) {
      await popup.emulateMedia({ colorScheme: scheme });
      await popup.screenshot({ path: join(shots, `popup-${scheme}.png`) });
    }
    const options = await context.newPage();
    await options.goto(`chrome-extension://${id}/options.html`);
    for (const scheme of ['light', 'dark']) {
      await options.emulateMedia({ colorScheme: scheme });
      await options.screenshot({ path: join(shots, `options-${scheme}.png`) });
    }
  }

  const named = [...hosts.keys()].filter((host) => !IP.test(host) && !/(^|\.)google\.com$/.test(host));
  check(named.length === 0, `hosts reached by name: ${named.join(', ') || 'none'} (${[...hosts.keys()].filter((h) => IP.test(h)).length} nodes by IP)`);
} finally {
  await context.close();
  rmSync(work, { recursive: true, force: true });
}
