// Opens a site that keeps files outside Platform through a local shell in Chromium, and checks
// that the worker fetched them from the places the manifest lists and served only matching bytes.
//   node packages/shell/build.mjs && node e2e/elsewhere.mjs [name] [screenshot-dir]
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
process.env.PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS ??= '1';
const { chromium } = await import('playwright');

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const name = process.argv[2] ?? 'elsewhere-demo-2511';
const shots = process.argv[3];
const port = await new Promise((resolve) => {
  const probe = createServer().listen(0, '127.0.0.1', () => {
    const free = probe.address().port;
    probe.close(() => resolve(free));
  });
});
const origin = `http://${name}.localhost:${port}`;
const check = (ok, message) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${message}`);
  if (!ok) process.exitCode = 1;
};
if (shots) mkdirSync(shots, { recursive: true });

const server = spawn(process.execPath, [join(root, 'packages/shell/serve.mjs'), String(port)], { stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((resolve) => server.stdout.once('data', resolve));
const profile = mkdtempSync(join(tmpdir(), 'dash-sites-elsewhere-'));
const context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true, viewport: { width: 1100, height: 900 } });
try {
  const byWorker = [];
  context.on('request', (request) => {
    if (request.serviceWorker()) byWorker.push(request.url());
  });
  const page = await context.newPage();
  const fromPage = new Set();
  page.on('request', (request) => {
    if (!request.url().startsWith(origin)) fromPage.add(new URL(request.url()).host);
  });

  const started = Date.now();
  await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.title !== 'Loading from Dash Platform' && document.readyState === 'complete', null, { timeout: 240000 });
  await page.waitForFunction(() => [...document.images].every((image) => image.complete), null, { timeout: 120000 });
  console.log(`     first visit took ${((Date.now() - started) / 1000).toFixed(1)} s`);

  const manifest = await page.evaluate(async () => (await fetch('/.well-known/dash/manifest.json')).json());
  const outside = Object.entries(manifest.files).filter(([, file]) => file.src);
  check(manifest.v === 2 && outside.length > 0, `the manifest is version ${manifest.v} and keeps ${outside.length} files outside Platform`);
  check(fromPage.size === 0, `the page itself asked no other host for anything ${[...fromPage].join(' ')}`);

  for (const [path, file] of outside) {
    const began = Date.now();
    const served = await page.evaluate(async (at) => {
      const response = await fetch(at, { cache: 'no-store' });
      const digest = await crypto.subtle.digest('SHA-256', await response.arrayBuffer());
      return { status: response.status, type: response.headers.get('content-type'), sha256: [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('') };
    }, path);
    const took = `${((Date.now() - began) / 1000).toFixed(1)} s`;
    check(served.status === 200 && served.sha256 === file.sha256 && served.type === file.type, `${path} (${file.size} bytes, from ${file.src.map((uri) => uri.split(':')[0]).join(', ')}) is served with the published hash, in ${took}`);
  }
  const images = await page.evaluate(() => [...document.images].map((image) => ({ id: image.id, width: image.naturalWidth })));
  check(images.length > 0 && images.every((image) => image.width > 0), `the page shows its images: ${images.map((image) => `${image.id} ${image.width}px`).join(', ')}`);

  const hosts = [...new Set(byWorker.map((url) => new URL(url).host))];
  const onIpfs = (uri) => uri.startsWith('ipfs://');
  const module = byWorker.filter((url) => /@helia\//.test(url));
  if (outside.some(([, file]) => file.src.some(onIpfs))) {
    if (outside.some(([, file]) => file.src.every(onIpfs))) check(module.length > 0, 'a file kept only on IPFS made the worker load the IPFS client');
    check(module.every((url) => /^https:\/\/(cdn\.jsdelivr\.net\/npm|unpkg\.com)\/@helia\/verified-fetch@/.test(url)), `the IPFS client came from an npm mirror${module[0] ? `: ${module[0]}` : ', or was not needed'}`);
    check(!hosts.some((host) => /(^|\.)(ipfs\.io|dweb\.link|trustless-gateway\.link|4everland\.io)$/.test(host)), 'no recursive IPFS gateway was asked');
  } else {
    check(module.length === 0, 'a site with no IPFS place does not download the IPFS client');
  }
  console.log(`     the worker contacted: ${hosts.filter((host) => !host.endsWith(`localhost:${port}`)).join(', ')}`);

  const before = byWorker.length;
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => [...document.images].every((image) => image.complete && image.naturalWidth > 0), null, { timeout: 60000 });
  const again = byWorker.slice(before).filter((url) => outside.some(([, file]) => file.src.includes(url)) || /@helia\//.test(url));
  check(again.length === 0, `a reload shows the images from the browser's own verified copies ${again.join(' ')}`);
  if (shots) await page.screenshot({ path: join(shots, 'elsewhere.png'), fullPage: true });
} finally {
  await context.close();
  server.kill();
  rmSync(profile, { recursive: true, force: true });
}
