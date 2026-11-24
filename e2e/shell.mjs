// Opens a multi-page site through the shell in Chromium, with no extension, and checks that the
// gateway host sends nothing but the shell and that the site keeps working with that host blocked.
//   node e2e/shell.mjs [name] [gateway-domain] [screenshot-dir]
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS ??= '1';
const { chromium } = await import('playwright');

const name = process.argv[2] ?? 'p2p';
const gateway = process.argv[3] ?? 'id.dashhq.org';
const shots = process.argv[4];
const scheme = /^localhost(:|$)/.test(gateway) ? 'http' : 'https';
const origin = `${scheme}://${name}.${gateway}`;
const check = (ok, message) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${message}`);
  if (!ok) process.exitCode = 1;
};
if (shots) mkdirSync(shots, { recursive: true });

const profile = mkdtempSync(join(tmpdir(), 'dash-sites-shell-'));
const context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true, viewport: { width: 1280, height: 860 } });
try {
  const contacted = new Set();
  const workerFetched = new Set();
  context.on('request', (request) => {
    const url = new URL(request.url());
    contacted.add(url.host);
    if (request.serviceWorker() && url.origin === origin) workerFetched.add(url.pathname);
  });
  const isShell = (path) => path === '/' || path === '/sw.js' || /^\/dash-sites-verifier-[0-9a-f]+\.js$/.test(path);
  const page = await context.newPage();
  const fromServer = new Set();
  const elsewhere = new Set();
  page.on('response', (response) => {
    const url = new URL(response.url());
    if (url.origin !== origin) elsewhere.add(url.host);
    else if (!response.fromServiceWorker()) fromServer.add(url.pathname);
  });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));

  const started = Date.now();
  await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded' });
  check((await page.title()) === 'Loading from Dash Platform', 'the first response is the shell, which holds no site content');
  await page.waitForFunction(() => document.title !== 'Loading from Dash Platform' && document.readyState === 'complete', null, { timeout: 180000 });
  console.log(`     first visit took ${((Date.now() - started) / 1000).toFixed(1)} s`);
  const record = await page.evaluate(async () => (await fetch('/.well-known/dash/site.json')).json());
  check(record.status === 'ok' && record.servedBy === 'browser', `the browser proved ${record.name}: owner ${record.ownerId}, revision ${record.site?.revision}, block ${record.proof?.height}`);
  check(elsewhere.size === 0, `the page loaded nothing from other hosts ${[...elsewhere].join(' ')}`);

  await page.waitForLoadState('networkidle');
  const assets = await page.evaluate(async () => {
    await document.fonts.ready;
    return {
      linked: document.querySelectorAll('link[rel="stylesheet"]').length,
      styles: [...document.querySelectorAll('link[rel="stylesheet"]')].every((link) => link.sheet?.cssRules.length > 0),
      declaredFonts: document.fonts.size,
      fonts: [...document.fonts].filter((font) => font.status === 'loaded').length,
      links: [...document.querySelectorAll('a[href^="/"]')].map((a) => a.getAttribute('href')).filter((href) => href !== '/'),
    };
  });
  if (assets.linked > 0) check(assets.styles, 'stylesheets were served from verified files');
  if (assets.declaredFonts > 0) check(assets.fonts > 0, `${assets.fonts} fonts loaded`);
  if (shots) await page.screenshot({ path: join(shots, 'shell-home.png') });

  await page.evaluate(() => localStorage.setItem('dash-sites-e2e', 'kept'));
  await page.reload({ waitUntil: 'load' });
  check((await page.evaluate(() => localStorage.getItem('dash-sites-e2e'))) === 'kept', 'the site has its own storage, and it survives a reload');

  const next = assets.links[0] ?? '/';
  if (next !== '/') {
    await Promise.all([page.waitForURL(`${origin}${next}`), page.click(`a[href="${next}"]`)]);
    await page.waitForLoadState('load');
    check(true, `a link inside the site opens ${page.url()}`);
    const images = await page.evaluate(() =>
      Promise.all(
        [...document.images].map((image) => {
          image.loading = 'eager';
          return image.decode().then(() => image.naturalWidth > 0, () => false);
        }),
      ),
    );
    check(images.every(Boolean), `${images.length} images on that page decoded`);
    await page.goBack({ waitUntil: 'load' });
    check(page.url() === `${origin}/`, 'back returns to the front page');
    await page.goForward({ waitUntil: 'load' });
    check(page.url() === `${origin}${next}`, 'forward returns to the linked page');
  }
  const missing = await page.goto(`${origin}/no-such-page-${Date.now()}`, { waitUntil: 'load' });
  check(missing.status() === 404 && missing.fromServiceWorker(), 'a missing page is a 404 from the verified site, not from the server');
  check(errors.length === 0, `no script errors ${errors.join(' | ')}`);

  const redirected = await page.goto(`${origin}${next.replace(/\/$/, '')}`, { waitUntil: 'load' });
  check(redirected.ok() && page.url() === `${origin}${next}`, `a directory address without its slash redirects to ${page.url()}`);

  const served = [...fromServer, ...workerFetched];
  check(served.every(isShell), `through all of that the gateway host sent only the shell: ${[...new Set(served)].join(' ')}`);
  const others = [...contacted].filter((host) => host !== `${name}.${gateway}`).sort();
  const expected = (host) => /^\d+\.\d+\.\d+\.\d+(:1443|:443)?$/.test(host) || /^quorums\.(testnet|mainnet)\.networks\.dash\.org$/.test(host);
  check(others.length > 0 && others.every(expected), `everything else the browser contacted is a Dash Platform node or the quorum key service: ${others.join(' ')}`);

  await context.route(`${scheme}://*.${gateway}/**`, (route) => route.abort());
  await context.route(`${scheme}://${gateway}/**`, (route) => route.abort());
  const blocked = await page.goto(`${origin}/`, { waitUntil: 'load' });
  check(blocked.ok() && blocked.fromServiceWorker() && (await page.title()) !== 'Loading from Dash Platform', `with ${gateway} blocked, the site still loads: ${await page.title()}`);
  if (shots) await page.screenshot({ path: join(shots, 'shell-gateway-blocked.png') });
} finally {
  await context.close();
  rmSync(profile, { recursive: true, force: true });
}

// A private window keeps everything in memory, with tighter limits on what a worker may store.
const browser = await chromium.launch({ channel: 'chromium', headless: true });
try {
  const page = await browser.newPage();
  await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded' });
  const loaded = await page
    .waitForFunction(() => document.title !== 'Loading from Dash Platform' && document.readyState === 'complete', null, { timeout: 120000 })
    .then(() => true, () => false);
  check(loaded, `the site loads in a private window: ${loaded ? await page.title() : await page.textContent('#step')}`);
} finally {
  await browser.close();
}
