import {
  buildSite,
  collectGarbage,
  DEPLOYMENTS,
  estimateCredits,
  formatDash,
  isValidLabel,
  networkConfig,
  normalizeLabel,
  parseName,
  publishSite,
  requireOwnedName,
  resolveName,
  unpublishSite,
  type DomainRecord,
  type Network,
  type SiteBundle,
  type SiteFile,
} from '@dash-sites/core';
import type { EvoWriter } from '@dash-sites/core/evo';
import { AutoSignOut, type SignOutReason } from './sign-out.js';
import { allowanceText, clearSession, connectionId, countdown, loadSession, qrShape, quietly, saveSession, type KeyValue } from './wallet.js';
import { normalizeUpload, previewHtml, unzip, type RawFile } from './files.js';
import { browserFetchers } from './elsewhere.js';
import { keepOutside, loadOutside, onOutsideChange } from './outside.js';
import { mountOutsidePanel } from './outside-panel.js';
import { platformPrice, sizeText } from './page/cost.js';
import { mountPageTab, pageFiles, suggestReopen } from './page-tab.js';

declare const __GATEWAY_DOMAIN__: string;
declare const __NETWORK__: string;
declare const __REMEMBER_WALLET__: boolean;

const GATEWAY = __GATEWAY_DOMAIN__;
const NETWORK = __NETWORK__ as Network;
const OPEN = DEPLOYMENTS[NETWORK] !== undefined;
const CLOSED = `Publishing on ${NETWORK} is not open yet.`;

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
const message = (error: unknown): string => String((error as Error)?.message ?? error);
const loadEvo = () => import('@dash-sites/core/evo');
const loadConnect = () => import('@dash-sites/core/connect');
const SVG = 'http://www.w3.org/2000/svg';
const EXPIRY_MARGIN_MS = 5 * 60_000;
/** On dash.site the builder shares a site with every user's pages, so a sign-in never outlives its use. */
const AUTO_SIGN_OUT = !__REMEMBER_WALLET__;
const IDLE_SIGN_OUT_MS = 10 * 60_000;
const SIGNED_OUT: Record<SignOutReason, string> = {
  idle: 'You were signed out after 10 minutes without activity. Your draft is kept.',
  published: 'Published, and signed out. Sign in again to publish more changes.',
  left: '',
};
const storage = (kind: 'localStorage' | 'sessionStorage'): KeyValue | undefined => quietly(() => window[kind]);

function expiring(key: EvoWriter): boolean {
  const { expiresAt } = key.keyLimits;
  return expiresAt !== undefined && expiresAt <= Date.now() + EXPIRY_MARGIN_MS;
}

let writer: EvoWriter | undefined;
let names: DomainRecord[] = [];
let chosen: DomainRecord | undefined;
let session = 0;
let walletRequest: AbortController | undefined;
let mode: 'write' | 'upload' = 'write';
let upload: SiteFile[] = [];
let bundle: SiteBundle | undefined;
let publishing = false;
let wantedName: string | undefined;
let working = 0;
let leftSignedIn = false;
const autoSignOut = new AutoSignOut({ idleMs: IDLE_SIGN_OUT_MS, signOut: (reason) => signOut(SIGNED_OUT[reason]), busy: () => publishing || working > 0 });

const label = (): string => chosen?.label.toLowerCase() ?? 'yourname';

let outsidePanel: ReturnType<typeof mountOutsidePanel> | undefined;

/** The site as made, before any of its files are marked as kept outside Platform. */
const madeFiles = (): SiteFile[] => (mode === 'upload' ? upload : pageFiles(`${label()}.dash`));

function setLocked(id: string, locked: boolean): void {
  $(id).toggleAttribute('inert', locked);
}

let previewTimer: ReturnType<typeof setTimeout> | undefined;

function refresh(): void {
  $('addr-label').textContent = label();
  $('addr-label').classList.toggle('blank', !chosen);
  $('addr-url').textContent = `${label()}.${GATEWAY}`;
  $('preview-url').textContent = `${label()}.${GATEWAY}`;
  setLocked('step-name', !writer);
  setLocked('step-publish', !writer || !chosen);
  $<HTMLButtonElement>('signout').disabled = publishing || working > 0;
  // Deleting unused files while a publish uploads could delete the new release's files before its
  // record points at them, and a publish during a delete could reuse a file being deleted.
  for (const id of ['gc', 'unpublish']) $<HTMLButtonElement>(id).disabled = publishing || working > 0;

  const made = madeFiles();
  outsidePanel?.show(made);
  const current = keepOutside(made);
  bundle = undefined;
  $('content-error').textContent = '';
  if (current.length > 0) {
    try {
      bundle = buildSite(current);
    } catch (error) {
      $('content-error').textContent = message(error);
    }
  }
  const cost = $('cost');
  if (!bundle) {
    cost.textContent = mode === 'write' ? 'Build a page in step 3 first.' : 'Add your site in step 3 first.';
  } else if (!writer || !chosen) {
    cost.textContent = writer ? 'Pick a name in step 2 to publish this.' : 'Sign in and pick a name to publish this. Your draft is kept.';
  } else {
    const kb = Math.max(1, Math.round(bundle.stats.storedBytes / 1024));
    const noIndex = bundle.manifest.files['/index.html'] ? '' : ' There is no index.html at the top, so the home page will be empty.';
    const { elsewhere } = bundle.stats;
    const outside = elsewhere.files === 0 ? '' : ` ${elsewhere.files === 1 ? 'One file' : `${elsewhere.files} files`} (${sizeText(elsewhere.bytes)}) ${elsewhere.files === 1 ? 'is' : 'are'} kept outside Platform.`;
    cost.textContent = `${bundle.stats.files} ${bundle.stats.files === 1 ? 'file' : 'files'}, ${kb} KB to store. This costs about ${formatDash(estimateCredits(bundle))}; parts already stored are not paid for again.${outside}${noIndex}`;
  }
  const button = $<HTMLButtonElement>('publish');
  button.disabled = !bundle || !chosen || publishing || working > 0;
  button.textContent = chosen ? `Publish to ${label()}.dash` : 'Publish';

  clearTimeout(previewTimer);
  previewTimer = setTimeout(renderPreview, 150);
}

function renderPreview(): void {
  const frame = $<HTMLIFrameElement>('frame');
  const html = previewHtml(keepOutside(madeFiles()));
  frame.srcdoc = html ?? '<body style="color-scheme:light dark;background:Canvas;color:GrayText;color:color-mix(in srgb,CanvasText 62%,Canvas);font:15px system-ui;display:grid;place-items:center;height:90vh;margin:0">Your home page will show here.</body>';
}

async function refreshBalance(): Promise<void> {
  const current = writer;
  if (!current) return;
  const [balance, remaining] = await Promise.all([current.balance(), current.remainingBudget().catch(() => undefined)]);
  if (current !== writer) return;
  $('balance').textContent = formatDash(balance);
  const { expiresAt } = current.keyLimits;
  const limited = remaining !== undefined && expiresAt !== undefined;
  $('allowance').hidden = !limited;
  if (limited) $('allowance-left').textContent = allowanceText(remaining, expiresAt);
}

function renderNames(): void {
  const box = $('names');
  box.replaceChildren(
    ...names.map((domain) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.setAttribute('role', 'radio');
      button.setAttribute('aria-checked', String(domain.id === chosen?.id));
      button.textContent = `${domain.label.toLowerCase()}.dash`;
      button.addEventListener('click', () => void choose(domain));
      return button;
    }),
  );
  $('names-empty').hidden = names.length > 0 || !writer || writer.keyLimits.bound;
}

async function choose(domain: DomainRecord): Promise<void> {
  if (!names.some((known) => known.id === domain.id)) names.push(domain);
  chosen = domain;
  suggestReopen(label());
  $('result').hidden = true;
  $('site-status').textContent = '';
  renderNames();
  refresh();
  if (!writer) return;
  const resolved = await resolveName(writer, domain.normalizedLabel);
  if (chosen?.id !== domain.id) return;
  $('site-status').textContent = 'site' in resolved
    ? `${label()}.dash has a site already (revision ${resolved.site.revision}, ${new Date(resolved.site.updatedAt).toLocaleDateString()}). Publishing replaces it.`
    : `${label()}.dash has no site yet.`;
}

function showRegistration(offered: boolean): void {
  $('register').hidden = !offered;
  $('register-hint').hidden = !offered;
  $('wallet-names').hidden = offered;
}

async function enter(connected: EvoWriter, attempt: number): Promise<void> {
  const owned = await connected.listOwnedNames(connected.identityId).catch((error: unknown) => {
    connected.forget();
    throw error;
  });
  if (attempt !== session) {
    connected.forget();
    return;
  }
  writer = connected;
  $('signed-out').textContent = '';
  if (AUTO_SIGN_OUT) autoSignOut.signedIn();
  $('who').textContent = connected.identityId;
  $('signin-ways').hidden = true;
  $('step-signin').querySelector<HTMLElement>('.done')!.hidden = false;
  showRegistration(!connected.keyLimits.bound);
  names = owned;
  chosen = undefined;
  renderNames();
  refresh();
  await refreshBalance().catch(() => {});
  const wanted = names.find((domain) => normalizeLabel(domain.label) === wantedName);
  if (wanted) $<HTMLInputElement>('new-label').value = '';
  const preferred = wanted ?? (names.length === 1 ? names[0] : undefined);
  if (attempt === session && !chosen && preferred) await choose(preferred).catch(() => {});
}

async function signIn(identity: string, key: string): Promise<void> {
  const error = $('signin-error');
  if (!OPEN) {
    error.textContent = CLOSED;
    return;
  }
  const button = $<HTMLButtonElement>('signin-button');
  cancelWallet();
  const attempt = ++session;
  error.textContent = '';
  button.disabled = true;
  button.textContent = 'Signing in…';
  try {
    const evo = await loadEvo();
    const config = networkConfig(NETWORK);
    let identityId = identity.trim();
    if (!/^[1-9A-HJ-NP-Za-km-z]{42,44}$/.test(identityId)) {
      const name = parseName(identityId);
      if (!name) throw new Error('Enter an identity ID, or a name such as alice.dash.');
      const domain = (await (await evo.EvoReader.connect(config)).getDomain(name.normalized)).value;
      if (!domain) throw new Error(`${name.label}.dash is not registered on ${NETWORK}.`);
      identityId = domain.ownerId;
    }
    const connected = await evo.EvoWriter.connectAs(config, { identityId, privateKeyWif: key.trim() });
    if (attempt !== session) {
      connected.forget();
      return;
    }
    $<HTMLInputElement>('key').value = '';
    await enter(connected, attempt);
    if (attempt === session) clearSession(storage('sessionStorage'), NETWORK);
  } catch (caught) {
    if (attempt === session) error.textContent = message(caught);
  } finally {
    button.disabled = false;
    button.textContent = 'Sign in';
  }
}

function showWallet(step: 'start' | 'request' | 'confirm'): void {
  for (const name of ['start', 'request', 'confirm']) $(`wallet-${name}`).hidden = name !== step;
  $('key-signin').hidden = step !== 'start';
}

function cancelWallet(): void {
  walletRequest?.abort();
  walletRequest = undefined;
  $('wallet-qr').replaceChildren();
  $<HTMLAnchorElement>('wallet-link').removeAttribute('href');
  $('wallet-progress').textContent = '';
  $('wallet-error').textContent = '';
  $<HTMLButtonElement>('wallet-button').disabled = false;
  showWallet('start');
}

function drawCode(uri: string): void {
  const shape = qrShape(uri);
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', `0 0 ${shape.size} ${shape.size}`);
  svg.setAttribute('shape-rendering', 'crispEdges');
  const path = document.createElementNS(SVG, 'path');
  path.setAttribute('d', shape.path);
  path.setAttribute('fill', '#000');
  svg.append(path);
  $('wallet-qr').replaceChildren(svg);
}

function confirmed(signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const listening = new AbortController();
    const settle = (finish: () => void) => (): void => {
      listening.abort();
      finish();
    };
    const options = { signal: listening.signal };
    $('wallet-continue').addEventListener('click', settle(() => resolve(true)), options);
    $('wallet-reject').addEventListener('click', settle(() => resolve(false)), options);
    signal.addEventListener('abort', settle(() => reject(new DOMException('cancelled', 'AbortError'))), options);
  });
}

async function signInWithWallet(): Promise<void> {
  if (!OPEN) {
    $('wallet-error').textContent = CLOSED;
    return;
  }
  cancelWallet();
  const attempt = ++session;
  const abort = new AbortController();
  walletRequest = abort;
  const error = $('wallet-error');
  const progress = $('wallet-progress');
  const status = $('wallet-status');
  $('signin-error').textContent = '';
  $<HTMLButtonElement>('wallet-button').disabled = true;
  progress.textContent = 'Connecting to Dash Platform…';
  let timer: ReturnType<typeof setInterval> | undefined;
  let wake: (() => void) | undefined;
  let saved = false;
  try {
    const [evo, connect] = await Promise.all([loadEvo(), loadConnect()]);
    const config = networkConfig(NETWORK);
    const sdk = await evo.connectSdk(config);
    const port = connect.connectPort(sdk);
    const clock = await port.chainClock();
    if (abort.signal.aborted) return;
    if (clock.protocolVersion < connect.APP_CONNECT_MIN_PROTOCOL) {
      throw new Error(`Wallet sign-in needs Platform protocol ${connect.APP_CONNECT_MIN_PROTOCOL}, and ${NETWORK} runs ${clock.protocolVersion}. Sign in with a private key instead.`);
    }
    const pending = connect.newWalletRequest(config, { connectionId: connectionId(storage('localStorage'), NETWORK), chainNow: clock.timeMs });
    drawCode(pending.uri);
    const link = $<HTMLAnchorElement>('wallet-link');
    link.href = pending.uri;
    link.hidden = !matchMedia('(pointer: coarse)').matches;
    progress.textContent = '';
    showWallet('request');

    const tick = (): void => {
      $('wallet-countdown').textContent = `This code works for ${countdown(pending.expiresAt - Date.now())}.`;
    };
    const say = (state: string): void => {
      if (status.textContent !== state) status.textContent = state;
    };
    say('Waiting for your wallet.');
    tick();
    timer = setInterval(tick, 1000);
    const trigger = new connect.PollTrigger();
    wake = (): void => {
      if (document.visibilityState === 'visible') trigger.fire();
    };
    window.addEventListener('focus', wake);
    document.addEventListener('visibilitychange', wake);
    const grant = await connect.awaitWalletGrant(port, pending, {
      signal: abort.signal,
      trigger,
      onStatus: (poll) => say(poll === 'answered' ? 'Your wallet answered. Checking its key.' : poll === 'incomplete-read' ? 'Could not read every answer, trying again.' : 'Waiting for your wallet.'),
    });
    try {
      clearInterval(timer);
      $('wallet-qr').replaceChildren();
      link.removeAttribute('href');
      const owned = await new evo.EvoReader(sdk, config).listOwnedNames(grant.identityId).catch(() => []);
      if (abort.signal.aborted) return;
      $('wallet-name').textContent = owned.length > 0 ? owned.map((domain) => `${domain.label}.dash`).join(', ') : 'an identity with no name';
      $('wallet-identity').textContent = grant.identityId;
      $('wallet-terms').textContent = allowanceText(grant.remainingBudget, grant.expiresAt);
      showWallet('confirm');
      if (!(await confirmed(abort.signal))) {
        cancelWallet();
        error.textContent = 'Nothing was signed in. If your own wallet approved a request, start again and keep the code private.';
        return;
      }
      progress.textContent = 'Signing in…';
      const connected = await evo.EvoWriter.on(sdk, config, { identityId: grant.identityId, privateKey: grant.privateKey });
      if (attempt !== session || expiring(connected)) {
        connected.forget();
        if (attempt !== session) return;
        throw new Error('The key your wallet approved has run out. Start again.');
      }
      if (__REMEMBER_WALLET__) {
        saveSession(storage('sessionStorage'), NETWORK, { identityId: grant.identityId, privateKey: grant.privateKey });
        saved = true;
      }
      grant.privateKey.fill(0);
      await enter(connected, attempt);
      if (attempt === session) cancelWallet();
    } finally {
      grant.privateKey.fill(0);
    }
  } catch (caught) {
    if (attempt !== session || abort.signal.aborted) return;
    if (saved) clearSession(storage('sessionStorage'), NETWORK);
    cancelWallet();
    error.textContent = message(caught);
  } finally {
    clearInterval(timer);
    if (wake) {
      window.removeEventListener('focus', wake);
      document.removeEventListener('visibilitychange', wake);
    }
  }
}

async function resumeWallet(): Promise<void> {
  const saved = OPEN ? loadSession(storage('sessionStorage'), NETWORK) : undefined;
  if (!saved) return;
  const attempt = ++session;
  const button = $<HTMLButtonElement>('wallet-button');
  button.disabled = true;
  $('wallet-progress').textContent = 'Signing you back in…';
  try {
    const evo = await loadEvo();
    const connected = await evo.EvoWriter.connectAs(networkConfig(NETWORK), saved);
    if (expiring(connected)) {
      connected.forget();
      throw new evo.KeyRefused('expired');
    }
    await enter(connected, attempt);
    if (attempt === session) $('wallet-progress').textContent = '';
  } catch (caught) {
    if (attempt !== session) return;
    const ended = (caught as Error)?.name === 'KeyRefused';
    if (ended) clearSession(storage('sessionStorage'), NETWORK);
    $('wallet-progress').textContent = '';
    $('wallet-error').textContent = ended
      ? 'Your wallet sign-in has ended: its key expired or was removed. Sign in again.'
      : `Could not sign you back in: ${message(caught)} Reload the page to try again.`;
  } finally {
    saved.privateKey.fill(0);
    button.disabled = false;
  }
}

function signOut(reason = ''): void {
  session += 1;
  cancelWallet();
  clearSession(storage('sessionStorage'), NETWORK);
  writer?.forget();
  writer = undefined;
  outsidePanel?.forget();
  names = [];
  chosen = undefined;
  autoSignOut.signedOut();
  $<HTMLInputElement>('key').value = '';
  $('signin-ways').hidden = false;
  $('step-signin').querySelector<HTMLElement>('.done')!.hidden = true;
  $('signed-out').textContent = reason;
  $('allowance').hidden = true;
  $('balance').textContent = '';
  $('result').hidden = true;
  $('site-status').textContent = '';
  $('manage-status').textContent = '';
  showRegistration(true);
  renderNames();
  refresh();
}

async function withName(action: (writer: EvoWriter) => Promise<DomainRecord>, button: HTMLButtonElement, busyText: string): Promise<void> {
  const signer = writer;
  if (!signer) return;
  const error = $('name-error');
  const text = button.textContent;
  error.textContent = '';
  button.disabled = true;
  button.textContent = busyText;
  working += 1;
  refresh();
  try {
    const domain = await action(signer);
    if (signer !== writer) return;
    await choose(domain);
    await refreshBalance();
  } catch (caught) {
    if (signer === writer) error.textContent = message(caught);
  } finally {
    working -= 1;
    button.disabled = false;
    button.textContent = text;
    refresh();
  }
}

function setMode(next: 'write' | 'upload'): void {
  mode = next;
  $('tab-write').setAttribute('aria-selected', String(next === 'write'));
  $('tab-upload').setAttribute('aria-selected', String(next === 'upload'));
  $('panel-write').hidden = next !== 'write';
  $('panel-upload').hidden = next !== 'upload';
  $('result').hidden = true;
  refresh();
}

function setUpload(raw: RawFile[]): void {
  const { files: accepted, skipped } = normalizeUpload(raw);
  upload = accepted;
  const total = accepted.reduce((sum, file) => sum + file.bytes.length, 0);
  $('upload-status').textContent = accepted.length === 0 ? 'No usable files were found.' : `${accepted.length} files, ${Math.max(1, Math.round(total / 1024))} KB${skipped.length ? `; ${skipped.length} hidden or junk files left out` : ''}.`;
  $('upload-files').replaceChildren(
    ...accepted.slice(0, 200).map((file) => {
      const item = document.createElement('li');
      const path = document.createElement('span');
      path.textContent = file.path;
      const size = document.createElement('span');
      size.textContent = `${file.bytes.length.toLocaleString()} B`;
      item.append(path, size);
      return item;
    }),
  );
  refresh();
}

const readFile = async (file: File): Promise<Uint8Array> => new Uint8Array(await file.arrayBuffer());

async function fromFileList(list: FileList | File[]): Promise<void> {
  const picked = [...list];
  const only = picked[0];
  if (picked.length === 1 && only && /\.zip$/i.test(only.name)) return setUpload(unzip(await readFile(only)));
  setUpload(await Promise.all(picked.map(async (file) => ({ path: file.webkitRelativePath || file.name, bytes: await readFile(file) }))));
}

async function fromDrop(items: DataTransferItemList): Promise<void> {
  const entries = [...items].map((item) => item.webkitGetAsEntry?.()).filter((entry): entry is FileSystemEntry => Boolean(entry));
  const out: RawFile[] = [];
  const walk = async (entry: FileSystemEntry): Promise<void> => {
    if (entry.isFile) {
      const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject));
      out.push({ path: entry.fullPath.replace(/^\//, ''), bytes: await readFile(file) });
      return;
    }
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
      if (batch.length === 0) break;
      for (const child of batch) await walk(child);
    }
  };
  for (const entry of entries) await walk(entry);
  const only = out[0];
  if (out.length === 1 && only && /\.zip$/i.test(only.path)) return setUpload(unzip(only.bytes));
  setUpload(out);
}

async function publish(): Promise<void> {
  const signer = writer;
  if (!signer || !chosen || !bundle || publishing || working > 0) return;
  if (expiring(signer)) {
    $('publish-error').textContent = 'Your wallet sign-in has run out. Sign out, sign in with DashPay again, then publish.';
    return;
  }
  const published = chosen.label.toLowerCase();
  const url = `https://${published}.${GATEWAY}/`;
  const status = $('publish-status');
  const error = $('publish-error');
  const progress = $<HTMLProgressElement>('progress');
  publishing = true;
  error.textContent = '';
  $('result').hidden = true;
  progress.hidden = false;
  progress.removeAttribute('value');
  status.textContent = 'Checking what is already stored…';
  refresh();
  try {
    const result = await publishSite(signer, chosen.label, bundle, (step) => {
      if (step.step === 'upload') {
        progress.max = step.total;
        progress.value = step.done;
        status.textContent = `Storing part ${step.done} of ${step.total}…`;
      } else if (step.step === 'record') {
        status.textContent = `Pointing ${published}.dash at the new site…`;
      }
    });
    status.textContent = `Stored ${result.uploaded} new ${result.uploaded === 1 ? 'part' : 'parts'}, reused ${result.reused}. Cost ${formatDash(result.creditsSpent)}.`;
    const link = $<HTMLAnchorElement>('result-link');
    link.href = url;
    link.textContent = `${published}.${GATEWAY}`;
    $('result').hidden = false;
    if (label() === published) $('site-status').textContent = `${published}.dash has a site (revision ${result.site.revision}). Publishing again replaces it.`;
    if (signer === writer) {
      autoSignOut.published();
      if (!writer) {
        const open = document.createElement('a');
        open.href = url;
        open.target = '_blank';
        open.rel = 'noopener';
        open.textContent = `${published}.${GATEWAY}`;
        $('signed-out').replaceChildren('Published. Open ', open, '. You were signed out; sign in again to publish more changes.');
      }
    }
  } catch (caught) {
    status.textContent = '';
    const live = signer.keyLimits.bound ? await signer.keyLive().catch(() => true) : true;
    if (signer !== writer) return;
    error.textContent =
      !live
        ? 'Publishing stopped: your wallet sign-in has ended. Its key was removed in the wallet or replaced by a newer sign-in from this browser. Sign out, then sign in with DashPay again; what was stored is kept.'
        : `Publishing stopped: ${message(caught)} What was stored is kept, so publishing again continues from here.`;
  } finally {
    publishing = false;
    progress.hidden = true;
    refresh();
    await refreshBalance().catch(() => {});
  }
}

async function manage(button: HTMLButtonElement, action: (writer: EvoWriter, domain: DomainRecord) => Promise<string>): Promise<void> {
  const signer = writer;
  if (!signer || !chosen || publishing || working > 0) return;
  const status = $('manage-status');
  button.disabled = true;
  working += 1;
  refresh();
  status.textContent = 'Working…';
  try {
    const done = await action(signer, chosen);
    if (signer === writer) status.textContent = done;
    await refreshBalance();
  } catch (caught) {
    if (signer === writer) status.textContent = message(caught);
  } finally {
    working -= 1;
    refresh();
  }
}

/** Another page can send a visitor here as `#signin=wallet|key&name=alice`. */
function takeHandoff(): void {
  const wanted = new URLSearchParams(location.hash.slice(1));
  const how = wanted.get('signin');
  if (!how && !wanted.has('name')) return;
  history.replaceState(null, '', location.pathname + location.search);
  wantedName = parseName(wanted.get('name') ?? '')?.normalized;
  const typed = parseName(wanted.get('name') ?? '')?.label;
  if (typed) $<HTMLInputElement>('new-label').value = typed;
  if (how === 'key') {
    $<HTMLDetailsElement>('key-signin').open = true;
    $('identity').focus();
  } else if (how === 'wallet') {
    void signInWithWallet();
  }
}

function start(): void {
  $('net').textContent = NETWORK;
  $('net-note').textContent = OPEN ? `This builder publishes on ${NETWORK}.` : CLOSED;
  for (const id of ['signin-button', 'wallet-button']) $<HTMLButtonElement>(id).disabled = !OPEN;
  const places = browserFetchers();
  loadOutside(storage('localStorage'));
  mountPageTab({ network: NETWORK, storage: storage('localStorage'), siteName: () => `${label()}.dash`, identity: () => writer?.identityId, places, onChange: refresh });
  const price = (file: SiteFile): string | undefined => {
    const costs = platformPrice(file);
    return costs && `about ${costs} on Platform`;
  };
  outsidePanel = mountOutsidePanel($('outside-panel'), { origin: location.origin, price, size: sizeText, fetchers: places });
  onOutsideChange(refresh);

  $<HTMLFormElement>('signin').addEventListener('submit', (event) => {
    event.preventDefault();
    void signIn($<HTMLInputElement>('identity').value, $<HTMLInputElement>('key').value);
  });
  $<HTMLInputElement>('identity-file').addEventListener('change', (event) => {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    void file.text().then((text) => {
      try {
        const parsed = JSON.parse(text) as { identityId?: string; identityKeys?: Array<{ purpose?: string; securityLevel?: string; privateKeyWif?: string }> };
        const key = ['HIGH', 'CRITICAL'].map((level) => parsed.identityKeys?.find((k) => k.purpose === 'AUTHENTICATION' && k.securityLevel === level)).find(Boolean);
        if (!parsed.identityId || !key?.privateKeyWif) throw new Error('missing');
        $<HTMLInputElement>('identity').value = parsed.identityId;
        return signIn(parsed.identityId, key.privateKeyWif);
      } catch {
        $('signin-error').textContent = 'That file is not an identity file: it needs an identityId and a high or critical authentication key.';
        return undefined;
      }
    });
  });
  $('signout').addEventListener('click', () => signOut('Signed out.'));
  $('auto-signout').hidden = !AUTO_SIGN_OUT;
  if (AUTO_SIGN_OUT) {
    for (const type of ['pointerdown', 'keydown', 'input', 'wheel', 'touchstart']) document.addEventListener(type, () => autoSignOut.activity(), { passive: true, capture: true });
    document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && autoSignOut.check());
    window.addEventListener('pagehide', (event) => {
      leftSignedIn = writer !== undefined;
      $<HTMLInputElement>('key').value = '';
      // A pending DashPay request survives a hand-off to the wallet app; only a page kept in the
      // back/forward cache, or a signed-in one, is cleared.
      if (leftSignedIn || event.persisted) autoSignOut.left();
    });
    window.addEventListener('pageshow', (event) => {
      if (event.persisted && leftSignedIn) $('signed-out').textContent = 'You were signed out when you left this page. Your draft is kept.';
    });
  }
  $('wallet-button').addEventListener('click', () => void signInWithWallet());
  $('wallet-cancel').addEventListener('click', () => {
    session += 1;
    cancelWallet();
  });
  $('wallet-origin').textContent = location.host;
  if (__NETWORK__ === 'testnet') $('wallet-testnet').hidden = false;

  $<HTMLFormElement>('register').addEventListener('submit', (event) => {
    event.preventDefault();
    const value = $<HTMLInputElement>('new-label').value.trim().replace(/\.dash$/i, '');
    if (!isValidLabel(value)) {
      $('name-error').textContent = 'A name is 3 to 63 letters, digits or hyphens, and does not start or end with a hyphen.';
      return;
    }
    const button = (event.target as HTMLFormElement).querySelector('button') as HTMLButtonElement;
    void withName((w) => w.registerName(value), button, 'Registering…').then(() => {
      if (chosen?.label.toLowerCase() === value.toLowerCase()) $<HTMLInputElement>('new-label').value = '';
    });
  });
  $<HTMLFormElement>('other').addEventListener('submit', (event) => {
    event.preventDefault();
    const button = (event.target as HTMLFormElement).querySelector('button') as HTMLButtonElement;
    void withName((w) => requireOwnedName(w, $<HTMLInputElement>('other-name').value), button, 'Checking…');
  });

  $('tab-write').addEventListener('click', () => setMode('write'));
  $('tab-upload').addEventListener('click', () => setMode('upload'));

  const drop = $('drop');
  drop.addEventListener('dragover', (event) => {
    event.preventDefault();
    drop.classList.add('over');
  });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (event) => {
    event.preventDefault();
    drop.classList.remove('over');
    if (event.dataTransfer) void fromDrop(event.dataTransfer.items).catch((error) => ($('content-error').textContent = message(error)));
  });
  for (const id of ['pick-folder', 'pick-zip']) {
    $<HTMLInputElement>(id).addEventListener('change', (event) => {
      const list = (event.target as HTMLInputElement).files;
      if (list?.length) void fromFileList(list).catch((error) => ($('content-error').textContent = message(error)));
    });
  }

  $('publish').addEventListener('click', () => void publish());
  $<HTMLButtonElement>('unpublish').addEventListener('click', (event) => {
    if (!confirm(`Take down the site at ${label()}.dash? The name stays yours.`)) return;
    void manage(event.currentTarget as HTMLButtonElement, async (w, domain) => {
      const removed = await unpublishSite(w, domain.label);
      $('site-status').textContent = `${label()}.dash has no site.`;
      return removed ? 'The site is down. Its files stay stored; "Delete files no site uses" removes them for good, at once.' : 'There was no site to take down.';
    });
  });
  $<HTMLButtonElement>('gc').addEventListener('click', (event) => {
    void manage(event.currentTarget as HTMLButtonElement, async (w) => {
      const { deleted, deferredUntil, skipped, failed } = await collectGarbage(w);
      if (deferredUntil !== undefined) return `Nothing deleted yet: a site changed recently, and visitors may still load its previous files. Try again after ${new Date(deferredUntil).toLocaleString()}.`;
      if (skipped) return `Nothing deleted: ${skipped}.`;
      if (failed.length > 0) return `Deleted ${deleted} unused ${deleted === 1 ? 'part' : 'parts'}; ${failed.length} could not be deleted. Try again later.`;
      return deleted === 0 ? 'Nothing to delete: every stored file is in use or was stored too recently.' : `Deleted ${deleted} unused ${deleted === 1 ? 'part' : 'parts'}.`;
    });
  });

  refresh();
  if (__REMEMBER_WALLET__) void resumeWallet();
  takeHandoff();
  const idle = (window as { requestIdleCallback?: (fn: () => void) => void }).requestIdleCallback ?? ((fn: () => void) => setTimeout(fn, 1500));
  idle(() => void Promise.all([loadEvo(), loadConnect()]).catch(() => {}));
}

if (location.protocol === 'http:' && location.hostname === GATEWAY) location.replace(`https:${location.href.slice(5)}`);
else start();
