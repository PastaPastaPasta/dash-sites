// Publishes a page through the built web builder and reads it back from the gateway.
//   node e2e/builder.mjs <identity.json> <label> [gateway-domain] [screenshot-dir]
import { createReadStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const [identityFile, label, gateway = 'id.dashhq.org', shots] = process.argv.slice(2);
if (!identityFile || !label) throw new Error('usage: builder.mjs <identity.json> <label> [gateway-domain] [screenshot-dir]');
const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'packages', 'builder', 'dist');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
const check = (ok, message) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${message}`);
  if (!ok) process.exitCode = 1;
};
if (shots) mkdirSync(shots, { recursive: true });

const server = createServer((req, res) => {
  const path = normalize(new URL(req.url, 'http://x').pathname);
  const file = join(dist, path.endsWith('/') ? `${path}index.html` : path);
  if (!file.startsWith(dist) || !existsSync(file) || !statSync(file).isFile()) return res.writeHead(404).end();
  res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream' });
  createReadStream(file).pipe(res);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const problems = [];
  page.on('console', (m) => m.type() === 'error' && problems.push(m.text()));
  page.on('pageerror', (e) => problems.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  if (shots) await page.screenshot({ path: join(shots, 'builder-start.png') });

  await page.setInputFiles('#identity-file', identityFile);
  await page.waitForSelector('#step-signin .done:not([hidden])', { timeout: 90000 });
  await page.waitForFunction(() => document.getElementById('balance')?.textContent !== '', undefined, { timeout: 60000 });
  check(true, `signed in as ${await page.textContent('#who')}, balance ${await page.textContent('#balance')}`);

  const chip = page.locator('#names button', { hasText: new RegExp(`^${label}\\.dash$`) });
  if ((await chip.count()) === 0) {
    await page.fill('#new-label', label);
    await page.click('#register button');
    await Promise.race([chip.waitFor({ timeout: 120000 }), page.waitForSelector('#name-error:not(:empty)', { timeout: 120000 })]);
    const failed = await page.textContent('#name-error');
    if (failed) throw new Error(`registering ${label}.dash failed: ${failed}`);
    check(true, `registered ${label}.dash`);
  }
  await chip.click();
  await page.waitForSelector('#step-content:not([inert])');
  check((await page.textContent('#addr-label')) === label, `the address shows ${label}.dash`);

  const stamp = new Date().toISOString();
  await page.fill('#title', 'Made with the Dash Sites builder');
  await page.fill('#tagline', 'A page written in a browser and stored on Dash Platform.');
  await page.fill('#body', `## What this is\n\nThis page was published from the web builder by its end-to-end test.\n\nBuild stamp: \`${stamp}\``);
  await page.click('#add-link');
  await page.fill('#links input[aria-label="Link label"]', 'Source code');
  await page.fill('#links input[aria-label="Link address"]', 'github.com/PastaPastaPasta/dash-sites');
  await page.click('#themes button:has-text("Night")');
  await page.waitForTimeout(400);
  const preview = await page.frameLocator('#frame').locator('h1').textContent();
  check(preview === 'Made with the Dash Sites builder', `the preview shows the page: ${preview}`);
  check(/costs at most about/.test(await page.textContent('#cost')), `cost: ${await page.textContent('#cost')}`);
  if (shots) await page.screenshot({ path: join(shots, 'builder-ready.png') });

  await page.click('#publish');
  await page.waitForSelector('#result:not([hidden]), #publish-error:not(:empty)', { timeout: 240000 });
  const error = await page.textContent('#publish-error');
  check(!error, `published: ${error || (await page.textContent('#publish-status'))}`);
  if (shots) await page.screenshot({ path: join(shots, 'builder-published.png'), fullPage: true });
  check(problems.length === 0, `no page errors${problems.length ? `: ${problems.join(' | ')}` : ''}`);

  const url = `https://${label}.${gateway}/`;
  let body = '';
  for (let i = 0; i < 40 && !body.includes(stamp); i++) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    body = await fetch(url).then((r) => r.text()).catch(() => '');
  }
  check(body.includes(stamp), `${url} serves the page that was just published`);
  if (shots) {
    const live = await browser.newPage({ viewport: { width: 1100, height: 700 } });
    await live.goto(url);
    await live.screenshot({ path: join(shots, 'builder-live.png') });
  }
} finally {
  await browser.close();
  server.close();
}
