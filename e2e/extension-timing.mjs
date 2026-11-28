// Times how long a .dash site takes to start rendering: a cold first open, a second tab right after,
// another site, a tab after the chain state is no longer fresh, and a tab after a browser restart.
//   node e2e/extension-timing.mjs <build-dir> [name] [other-name] [stale-wait-seconds] [third-name]
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';

const build = resolve(process.argv[2] ?? 'packages/extension/build/chrome');
const name = process.argv[3] ?? 'built4';
const other = process.argv[4] ?? 'forg3';
const staleWait = Number(process.argv[5] ?? 45);
const third = process.argv[6] ?? 'd4shhq';
const work = mkdtempSync(join(tmpdir(), 'dash-sites-timing-'));
const profile = join(work, 'profile');
const launch = () =>
  chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true, args: [`--disable-extensions-except=${build}`, `--load-extension=${build}`] });

/** Milliseconds from navigation until the site's own content is in the viewer's frame. */
async function open(context, label) {
  const page = await context.newPage();
  const started = Date.now();
  await page.goto(`http://${label}.dash/`, { waitUntil: 'commit' }).catch(() => undefined);
  let ms;
  while (Date.now() - started < 240000) {
    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) continue;
      const text = await frame.evaluate(() => document.body?.innerText.trim() ?? '').catch(() => '');
      if (text) {
        ms = Date.now() - started;
        break;
      }
    }
    if (ms !== undefined) break;
    const kind = await page.evaluate(() => document.getElementById('badge')?.dataset.kind).catch(() => undefined);
    if (kind === 'error' || kind === 'none') break;
    await page.waitForTimeout(25);
  }
  const badge = await page.textContent('#badge-text').catch(() => '?');
  return { page, ms: ms ?? -1, badge };
}

const results = [];
const record = async (context, label, what) => {
  const { page, ms, badge } = await open(context, label);
  results.push({ what, ms });
  console.log(`${what.padEnd(46)} ${String(ms).padStart(6)} ms   ${badge}`);
  return page;
};

let context = await launch();
try {
  const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  for (let i = 0; i < 100 && (await sw.evaluate(() => chrome.declarativeNetRequest.getDynamicRules())).length === 0; i++) await new Promise((r) => setTimeout(r, 100));
  await record(context, name, `cold first open (${name})`);
  await record(context, name, `second tab, same site (${name})`);
  await record(context, other, `new tab, another site (${other})`);
  await new Promise((r) => setTimeout(r, staleWait * 1000));
  await record(context, name, `new tab after ${staleWait} s (${name})`);
  await context.close();
  context = await launch();
  await record(context, name, `after browser restart (${name})`);
  await record(context, other, `after restart, another site (${other})`);
  // The next morning: the stored proof is hours old, and a site never opened before.
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  await worker.evaluate(async () => {
    const all = await chrome.storage.local.get(null);
    for (const [key, value] of Object.entries(all)) if (key.startsWith('chain:')) await chrome.storage.local.set({ [key]: { ...value, syncedAt: Date.now() - 3 * 3_600_000 } });
  });
  await context.close();
  context = await launch();
  await record(context, third, `restart, proof 3 h old, new site (${third})`);
} finally {
  await context.close().catch(() => undefined);
  rmSync(work, { recursive: true, force: true });
}
console.log(JSON.stringify(results));
