// Loads an unpacked Chrome build through a fresh install, an update over an older build, a reload
// and a browser restart, then opens a live name, and fails on any error the extension reports.
//   node e2e/extension-errors.mjs <build-dir> [older-build-dir | -] [name]
//
// Two sources, because neither sees everything:
// - the browser's own log (`--enable-logging`), which has every console message of the extension
//   from its very first start; the extension logs nothing unless something failed;
// - the error list chrome://extensions shows (with Developer mode on), read after each step.
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

process.env.DEBUG = [process.env.DEBUG, 'pw:browser'].filter(Boolean).join(',');
const logged = [];
const write = process.stderr.write.bind(process.stderr);
process.stderr.write = (chunk, ...rest) => {
  const text = String(chunk);
  for (const line of text.split('\n')) {
    if (/:CONSOLE:\d+\]/.test(line) && /source: chrome-extension:\/\//.test(line)) logged.push(line.replace(/^.*?:CONSOLE:\d+\] /, ''));
  }
  return /pw:browser/.test(text) ? true : write(chunk, ...rest);
};
const { chromium } = await import('playwright');

const build = resolve(process.argv[2] ?? 'packages/extension/build/chrome');
const older = process.argv[3] && process.argv[3] !== '-' ? resolve(process.argv[3]) : undefined;
const name = process.argv[4] ?? 'built4';
const check = (ok, message) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${message}`);
  if (!ok) process.exitCode = 1;
};
const work = mkdtempSync(join(tmpdir(), 'dash-sites-errors-'));
const profile = join(work, 'profile');
const extension = join(work, 'extension');
const placeholder = join(work, 'placeholder');
mkdirSync(placeholder, { recursive: true });
writeFileSync(join(placeholder, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'placeholder', version: '1' }));

const launch = (dir = extension) =>
  chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: true,
    args: ['--enable-logging=stderr', '--v=0', `--disable-extensions-except=${dir}`, `--load-extension=${dir}`],
  });
const settle = () => new Promise((r) => setTimeout(r, 3000));

async function extensionsPage(context) {
  const page = await context.newPage();
  await page.goto('chrome://extensions/');
  return page;
}

async function info(page) {
  return page.evaluate(async () => {
    const found = (await chrome.developerPrivate.getExtensionsInfo()).find((e) => e.name === 'Dash Sites');
    return found && { id: found.id, version: found.version, errors: [...found.runtimeErrors, ...found.manifestErrors].map((e) => e.message) };
  });
}

/** Checks both sources for errors since the last step. */
async function step(context, label) {
  await settle();
  const page = await extensionsPage(context);
  const found = await info(page);
  await page.close();
  const fromLog = logged.splice(0);
  const errors = [...fromLog, ...(found?.errors ?? [])];
  check(Boolean(found), `${label}: Dash Sites ${found?.version} is loaded`);
  check(errors.length === 0, `${label}: no errors${errors.length ? `: ${[...new Set(errors)].join(' | ')}` : ''}`);
  return found;
}

async function reload(context, id) {
  const page = await extensionsPage(context);
  await page.evaluate(async (extensionId) => {
    await chrome.developerPrivate.deleteExtensionErrors({ extensionId }).catch(() => undefined);
    await chrome.developerPrivate.reload(extensionId, { failQuietly: true });
  }, id);
  await page.close();
}

// chrome://extensions records errors only with Developer mode on, as it is for anyone who loads an
// unpacked build. It is turned on in a first session, before the build ever starts.
{
  const first = await launch(placeholder);
  const page = await extensionsPage(first);
  await page.evaluate(() => chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true }));
  await first.close();
  logged.length = 0;
}

cpSync(older ?? build, extension, { recursive: true });
let context = await launch();
try {
  let found = await step(context, older ? 'install of the older build' : 'fresh install');
  if (older) {
    cpSync(build, extension, { recursive: true, force: true });
    await reload(context, found.id);
    found = await step(context, 'update over the older build');
  }
  await reload(context, found.id);
  found = await step(context, 'reload');
  await context.close();
  context = await launch();
  await step(context, 'browser restart');

  const site = await context.newPage();
  await site.goto(`http://${name}.dash/`, { waitUntil: 'domcontentloaded' }).catch(() => undefined);
  await site.waitForFunction(() => ['ok', 'partial', 'none', 'error'].includes(document.getElementById('badge')?.dataset.kind ?? ''), null, { timeout: 180000 });
  const kind = await site.evaluate(() => document.getElementById('badge').dataset.kind);
  check(kind === 'ok' || kind === 'partial', `${name}.dash/ opens: ${await site.textContent('#badge-text')}`);
  await step(context, `after opening ${name}.dash`);
} finally {
  await context.close().catch(() => undefined);
  rmSync(work, { recursive: true, force: true });
}
