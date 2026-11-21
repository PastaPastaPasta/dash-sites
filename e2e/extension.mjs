// Loads the built extension into Chromium and checks it against a live name.
//   node e2e/extension.mjs [name] [gateway-domain] [screenshot-dir]
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const name = process.argv[2] ?? 'demo2026';
const gateway = process.argv[3] ?? 'id.dashhq.org';
const shots = process.argv[4];
const extension = join(dirname(fileURLToPath(import.meta.url)), '..', 'packages', 'extension', 'build', 'chrome');
const check = (ok, message) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${message}`);
  if (!ok) process.exitCode = 1;
};
if (shots) mkdirSync(shots, { recursive: true });

const context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'dash-sites-e2e-')), {
  channel: 'chromium',
  headless: true,
  viewport: { width: 1100, height: 700 },
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
});
try {
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  const id = new URL(worker.url()).host;
  for (let i = 0; i < 100 && (await worker.evaluate(() => chrome.declarativeNetRequest.getDynamicRules())).length === 0; i++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const expected = `https://${name}.${gateway}/`;

  const page = await context.newPage();
  await page.goto(`http://${name}.dash/`, { waitUntil: 'load' });
  check(page.url() === expected, `http://${name}.dash/ loads ${page.url()}`);
  check((await page.content()).length > 50, 'the site has content');
  if (shots) await page.screenshot({ path: join(shots, 'site.png') });

  await page.goto(`https://${name}.dash/?x=1`, { waitUntil: 'load' });
  check(page.url() === `${expected}?x=1`, `https://${name}.dash/?x=1 keeps its query: ${page.url()}`);

  await page.goto('about:blank');
  await page.evaluate((url) => void (location.href = url), `https://duckduckgo.com/?q=${name}.dash`);
  for (let i = 0; i < 200 && page.url() !== expected; i++) await new Promise((resolve) => setTimeout(resolve, 100));
  check(page.url() === expected, `a search for ${name}.dash opens the site: ${page.url()}`);

  const popup = await context.newPage();
  await popup.setViewportSize({ width: 340, height: 420 });
  await popup.goto(`chrome-extension://${id}/popup.html?url=${encodeURIComponent(expected)}`);
  await popup.waitForSelector('#state:not([data-kind=checking])', { timeout: 60000 });
  const kind = await popup.getAttribute('#state', 'data-kind');
  check(kind === 'match', `popup verdict: ${kind}: ${await popup.textContent('#detail')}`);
  await popup.waitForSelector('#audit:not(:empty)', { timeout: 60000 }).catch(() => {});
  check((await popup.getAttribute('#audit', 'data-ok')) === 'true', `file audit: ${await popup.textContent('#audit')}`);
  if (shots) await popup.screenshot({ path: join(shots, 'popup.png') });

  const none = await context.newPage();
  await none.goto(`chrome-extension://${id}/popup.html?url=${encodeURIComponent('https://example.com/')}`);
  await none.waitForSelector('#state[data-kind=none]', { timeout: 10000 });
  check(true, 'popup on another site says it is not a .dash site');
} finally {
  await context.close();
}
