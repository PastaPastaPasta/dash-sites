// Publishes a page through the built web builder and reads it back from the gateway.
//   node e2e/builder.mjs <identity.json> <label> [gateway-domain] [screenshot-dir] [--wallet] [--url=<builder>]
// With --wallet it signs in the way a phone does: the scripted wallet in wallet-responder.mjs answers
// the page's sign-in code as the identity in the file, which must already own <label>.dash.
import { createReadStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { closeEditor, fillItems, openEditor, typeInPlace } from './page-editor-steps.mjs';

const args = process.argv.slice(2);
const flags = args.filter((arg) => arg.startsWith('--'));
const [identityFile, label, gateway = 'id.dashhq.org', shots] = args.filter((arg) => !arg.startsWith('--'));
if (!identityFile || !label) throw new Error('usage: builder.mjs <identity.json> <label> [gateway-domain] [screenshot-dir] [--wallet] [--url=<builder>]');
const withWallet = flags.includes('--wallet');
const builderUrl = flags.find((flag) => flag.startsWith('--url='))?.slice(6);
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
// E2E_HOST_MAP=127.0.0.1:8787 sends the gateway domain to a local `wrangler dev --local-protocol https`.
const hostMap = process.env.E2E_HOST_MAP ? [`--host-resolver-rules=MAP ${gateway} ${process.env.E2E_HOST_MAP}, MAP *.${gateway} ${process.env.E2E_HOST_MAP}`, '--ignore-certificate-errors'] : [];
const browser = await chromium.launch({ args: hostMap });
const grantedKeys = [];
const signedIn = async (page) => {
  await page.waitForSelector('#step-signin .done:not([hidden])', { timeout: 90000 });
  await page.waitForFunction(() => document.getElementById('balance')?.textContent !== '', undefined, { timeout: 60000 });
};
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const problems = [];
  page.on('console', (m) => m.type() === 'error' && problems.push(m.text()));
  page.on('pageerror', (e) => problems.push(e.message));
  await page.goto(builderUrl ?? `http://127.0.0.1:${server.address().port}/`);
  check(await page.isVisible('#wallet-button'), 'signing in with a mobile wallet is the first choice, with the private key form folded away');
  if (shots) await page.screenshot({ path: join(shots, 'builder-start.png') });

  if (withWallet) {
    const { approve } = await import('./wallet-responder.mjs');
    await page.click('#wallet-button');
    await page.waitForSelector('#wallet-request:not([hidden]) #wallet-qr svg', { timeout: 90000 });
    const uri = await page.getAttribute('#wallet-link', 'href');
    check(/^dashpay:\/\/connect\?v=2&n=[mt]&r=[A-Za-z0-9_-]+$/.test(uri ?? ''), `the page shows a sign-in code for ${uri?.slice(0, 34)}…`);
    if (shots) await page.screenshot({ path: join(shots, 'builder-wallet-code.png') });
    const granted = await approve({ identityFile, uri });
    grantedKeys.push(granted.keyId);
    check(granted.label === 'Dash Sites', `the wallet approved "${granted.label}": key ${granted.keyId} of ${granted.identityId}`);
    await page.waitForSelector('#wallet-confirm:not([hidden])', { timeout: 120000 });
    check((await page.textContent('#wallet-identity')) === granted.identityId, `the page asks before continuing as ${await page.textContent('#wallet-name')}, with ${await page.textContent('#wallet-terms')} to spend`);
    if (shots) await page.screenshot({ path: join(shots, 'builder-wallet-confirm.png') });
    await page.click('#wallet-continue');
    await signedIn(page);
    check(await page.isVisible('#allowance'), `signed in with the wallet's key: ${await page.textContent('#allowance-left')}`);
    check(!(await page.isVisible('#register')), 'a wallet sign-in does not offer to register names');
    await page.reload();
    await signedIn(page);
    check((await page.textContent('#who')) === granted.identityId, 'a reload keeps the wallet sign-in for this tab');
  } else {
    await page.setInputFiles('#identity-file', identityFile);
    await signedIn(page);
  }
  check(true, `signed in as ${await page.textContent('#who')}, balance ${await page.textContent('#balance')}`);

  const chip = page.locator('#names button', { hasText: new RegExp(`^${label}\\.dash$`) });
  if ((await chip.count()) === 0) {
    if (withWallet) throw new Error(`the identity does not own ${label}.dash, and a wallet sign-in cannot register it`);
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
  await openEditor(page);
  await typeInPlace(page, '.dsp h1', 'Made with the Dash Sites builder');
  await typeInPlace(page, '.dsp .tagline', 'A page written in a browser and stored on Dash Platform.');
  await typeInPlace(page, '.dsp .tx', `This page was published from the web builder by its end-to-end test. Build stamp: ${stamp}`);
  await fillItems(page, '.links', [{ label: 'Source code', url: 'github.com/PastaPastaPasta/dash-sites' }]);
  await page.click('.ed-themes button:has-text("Night")');
  await closeEditor(page);
  await page.waitForTimeout(400);
  const preview = await page.frameLocator('#frame').locator('h1').textContent();
  check(preview === 'Made with the Dash Sites builder', `the preview shows the page: ${preview}`);
  check(/costs about/.test(await page.textContent('#cost')), `cost: ${await page.textContent('#cost')}`);
  if (shots) await page.screenshot({ path: join(shots, 'builder-ready.png') });

  await page.click('#publish');
  await page.waitForSelector('#result:not([hidden]), #publish-error:not(:empty)', { timeout: 240000 });
  const error = await page.textContent('#publish-error');
  check(!error, `published: ${error || (await page.textContent('#publish-status'))}`);
  if (shots) await page.screenshot({ path: join(shots, 'builder-published.png'), fullPage: true });
  check(problems.length === 0, `no page errors${problems.length ? `: ${problems.join(' | ')}` : ''}`);

  const url = `https://${label}.${gateway}/`;
  const live = await browser.newPage({ viewport: { width: 1100, height: 700 } });
  let body = '';
  for (let i = 0; i < 20 && !body.includes(stamp); i++) {
    await live.goto(url, { waitUntil: 'domcontentloaded' });
    await live.waitForFunction(() => document.title !== 'Loading from Dash Platform' && document.readyState === 'complete', null, { timeout: 180000 });
    body = await live.content();
    if (!body.includes(stamp)) await live.waitForTimeout(5000);
  }
  check(body.includes(stamp), `${url} shows the page that was just published, read from Dash Platform by the browser`);
  if (shots) await live.screenshot({ path: join(shots, 'builder-live.png') });

  const fresh = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  await fresh.goto(builderUrl ?? `http://127.0.0.1:${server.address().port}/`);
  await fresh.click('#reopen summary');
  await fresh.fill('#reopen-name', `${label}.dash`);
  await fresh.click('#reopen-form button');
  await fresh.waitForFunction(() => /^(Opened|.*(not|no|cannot))/.test(document.getElementById('reopen-status')?.textContent ?? '') && !/^Reading/.test(document.getElementById('reopen-status').textContent), undefined, { timeout: 180000 });
  check(/^Opened the page published at/.test(await fresh.textContent('#reopen-status')), `another browser, not signed in, opens the published page for editing: ${await fresh.textContent('#reopen-status')}`);
  check((await fresh.textContent('#page-summary')) === (await page.textContent('#page-summary')) && (await fresh.textContent('#themes button[aria-checked=true]')) === 'Night', `with its blocks and its look: ${await fresh.textContent('#page-summary')}`);
  await fresh.context().close();
  if (withWallet) {
    await page.click('#signout');
    check(await page.isVisible('#wallet-button'), 'signing out returns to the sign-in choice');
    check((await page.isVisible('#register')) && !(await page.isVisible('#wallet-names')) && !(await page.isVisible('#names-empty')), 'and the name step forgets the wallet session');
    await page.reload();
    check(await page.isVisible('#wallet-button'), 'and a reload stays signed out');
  }
} finally {
  await browser.close();
  server.close();
  if (grantedKeys.length > 0) {
    const { revoke } = await import('./wallet-responder.mjs');
    console.log(`     disabled the test key ${await revoke({ identityFile, keyIds: grantedKeys })}`);
  }
}
