// Drives the Firefox build's renderer (no sandbox page, no site scripts) in Chromium: Playwright
// cannot load an extension into Firefox. Only the background key is changed to Chrome's form.
//   node e2e/extension-static.mjs [name] [screenshot-dir]
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const name = process.argv[2] ?? 'built4';
const shots = process.argv[3];
const check = (ok, message) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${message}`);
  if (!ok) process.exitCode = 1;
};
if (shots) mkdirSync(shots, { recursive: true });
const work = mkdtempSync(join(tmpdir(), 'dash-sites-static-'));
const extension = join(work, 'extension');
cpSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'packages', 'extension', 'build', 'firefox'), extension, { recursive: true });
const manifest = JSON.parse(readFileSync(join(extension, 'manifest.json'), 'utf8'));
manifest.background = { service_worker: 'background.js', type: 'module' };
delete manifest.browser_specific_settings;
writeFileSync(join(extension, 'manifest.json'), JSON.stringify(manifest));

const context = await chromium.launchPersistentContext(join(work, 'profile'), {
  channel: 'chromium',
  headless: true,
  viewport: { width: 1200, height: 760 },
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
});
try {
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  for (let i = 0; i < 100 && (await worker.evaluate(() => chrome.declarativeNetRequest.getDynamicRules())).length === 0; i++) await new Promise((r) => setTimeout(r, 100));
  const page = await context.newPage();
  await page.goto(`http://${name}.dash/`, { waitUntil: 'domcontentloaded' }).catch(() => undefined);
  await page.waitForFunction(() => ['ok', 'partial', 'none', 'error'].includes(document.getElementById('badge')?.dataset.kind ?? ''), null, { timeout: 240000 });
  await page.waitForSelector('#frame');
  const frame = page.frames().find((f) => f !== page.mainFrame());
  await frame.waitForFunction(() => document.body && document.body.innerText.trim().length > 0, null, { timeout: 30000 });
  const info = await frame.evaluate(() => ({ scripts: document.scripts.length, text: document.body.innerText.slice(0, 80), images: [...document.images].map((i) => i.src.slice(0, 5)) }));
  check(info.text.length > 0, `the site shows content without scripts: ${JSON.stringify(info.text.slice(0, 50))}`);
  check(info.scripts === 0, `no site script is left in the page (${info.scripts})`);
  check(info.images.every((src) => src === 'data:' || src === 'https'), `site images load from verified data: URLs (${info.images.length})`);
  check((await page.getAttribute('#mode', 'hidden')) === null, 'the details say scripts are off in this build');
  const link = await frame.evaluate(() => [...document.querySelectorAll('a[href]')].map((a) => a.getAttribute('href')).map((h) => /site\.html#[^/]+(\/.+)$/.exec(h)?.[1]).find(Boolean));
  if (link) {
    await frame.click(`a[href*="${link}"]`);
    await page.waitForFunction((p) => location.hash.includes(p), link, { timeout: 30000 }).catch(() => undefined);
    check(page.url().includes(link), `a link moves the viewer to ${page.url()}`);
  }
  if (shots) {
    await page.waitForTimeout(1000);
    for (const scheme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.waitForTimeout(300);
      await page.screenshot({ path: join(shots, `static-${scheme}.png`) });
    }
  }
} finally {
  await context.close();
  rmSync(work, { recursive: true, force: true });
}
