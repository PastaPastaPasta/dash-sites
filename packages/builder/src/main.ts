import {
  buildSite,
  collectGarbage,
  contentTypeFor,
  estimateCredits,
  formatDash,
  isValidLabel,
  networkConfig,
  parseName,
  publishSite,
  requireOwnedName,
  type DomainRecord,
  type Network,
  type SiteBundle,
  type SiteFile,
} from '@dash-sites/core';
import type { EvoWriter } from '@dash-sites/core/evo';
import { allowanceText, clearSession, connectionId, countdown, loadSession, qrShape, quietly, saveSession, type KeyValue } from './wallet.js';
import { dataUrl, normalizeUpload, previewHtml, unzip, type RawFile } from './files.js';
import { EMPTY_DRAFT, isBlank, renderPage, THEMES, type PageDraft, type Theme } from './template.js';

declare const __GATEWAY_DOMAIN__: string;
declare const __NETWORK__: string;

const GATEWAY = __GATEWAY_DOMAIN__;
const NETWORK = __NETWORK__ as Network;
const DRAFT_KEY = 'dash-sites.draft';
const PICTURE_TYPES: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/svg+xml': 'svg' };

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
const message = (error: unknown): string => String((error as Error)?.message ?? error);
const loadEvo = () => import('@dash-sites/core/evo');
const loadConnect = () => import('@dash-sites/core/connect');
const SVG = 'http://www.w3.org/2000/svg';
const EXPIRY_MARGIN_MS = 5 * 60_000;
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
const draft: PageDraft = loadDraft();
let upload: SiteFile[] = [];
let bundle: SiteBundle | undefined;
let publishing = false;

function loadDraft(): PageDraft {
  try {
    const saved = JSON.parse(localStorage.getItem(DRAFT_KEY) ?? 'null') as Partial<PageDraft> | null;
    if (saved) return { ...EMPTY_DRAFT, ...saved, links: Array.isArray(saved.links) ? saved.links : [], theme: saved.theme && saved.theme in THEMES ? saved.theme : 'paper', picture: undefined };
  } catch {
    // an unreadable draft is dropped
  }
  return { ...EMPTY_DRAFT, links: [] };
}

function saveDraft(): void {
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify({ ...draft, picture: undefined }));
  } catch {
    // the draft still lives in this tab
  }
}

const label = (): string => chosen?.label.toLowerCase() ?? 'yourname';

function files(): SiteFile[] {
  if (mode === 'upload') return upload;
  return isBlank(draft) ? [] : renderPage(draft, `${label()}.dash`);
}

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
  setLocked('step-content', !writer || !chosen);
  setLocked('step-publish', !writer || !chosen);

  const current = files();
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
    cost.textContent = mode === 'write' ? 'Write something in step 3 first.' : 'Add your site in step 3 first.';
  } else {
    const kb = Math.max(1, Math.round(bundle.stats.storedBytes / 1024));
    const noIndex = bundle.manifest.files['/index.html'] ? '' : ' There is no index.html at the top, so the home page will be empty.';
    cost.textContent = `${bundle.stats.files} ${bundle.stats.files === 1 ? 'file' : 'files'}, ${kb} KB to store. This costs at most about ${formatDash(estimateCredits(bundle))}; parts already stored are not paid for again.${noIndex}`;
  }
  const button = $<HTMLButtonElement>('publish');
  button.disabled = !bundle || !chosen || publishing;
  button.textContent = chosen ? `Publish to ${label()}.dash` : 'Publish';

  clearTimeout(previewTimer);
  previewTimer = setTimeout(renderPreview, 150);
}

function renderPreview(): void {
  const frame = $<HTMLIFrameElement>('frame');
  let html: string | undefined;
  if (mode === 'write') {
    const picture = draft.picture ? dataUrl(draft.picture.bytes, contentTypeFor(`x.${draft.picture.ext}`)) : undefined;
    const page = renderPage(draft, `${label()}.dash`, picture)[0] as SiteFile;
    html = new TextDecoder().decode(page.bytes);
  } else {
    html = previewHtml(upload);
  }
  frame.srcdoc = html ?? '<body style="font:15px system-ui;color:#667;display:grid;place-items:center;height:90vh;margin:0">Your home page will show here.</body>';
}

async function refreshBalance(): Promise<void> {
  const current = writer;
  if (!current) return;
  const [balance, remaining] = await Promise.all([current.balance(), current.remainingBudget()]);
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
  $('names-empty').hidden = names.length > 0 || !writer;
}

async function choose(domain: DomainRecord): Promise<void> {
  if (!names.some((known) => known.id === domain.id)) names.push(domain);
  chosen = domain;
  $('result').hidden = true;
  $('site-status').textContent = '';
  renderNames();
  refresh();
  if (!writer) return;
  const site = (await writer.getSite(writer.identityId, domain.id)).value;
  if (chosen?.id !== domain.id) return;
  const live = site && site.updatedAt >= domain.transferredAt;
  $('site-status').textContent = live
    ? `${label()}.dash has a site already (revision ${site.revision}, ${new Date(site.updatedAt).toLocaleDateString()}). Publishing replaces it.`
    : `${label()}.dash has no site yet.`;
}

function showRegistration(offered: boolean): void {
  $('register').hidden = !offered;
  $('register-hint').hidden = !offered;
  $('wallet-names').hidden = offered;
}

async function enter(connected: EvoWriter, attempt: number): Promise<void> {
  const owned = await connected.listOwnedNames(connected.identityId);
  if (attempt !== session) return;
  writer = connected;
  $('who').textContent = connected.identityId;
  $('signin-ways').hidden = true;
  $('step-signin').querySelector<HTMLElement>('.done')!.hidden = false;
  showRegistration(!connected.keyLimits.bound);
  names = owned;
  chosen = undefined;
  renderNames();
  refresh();
  await refreshBalance().catch(() => {});
  if (names.length === 1) await choose(names[0] as DomainRecord).catch(() => {});
}

async function signIn(identity: string, key: string): Promise<void> {
  const error = $('signin-error');
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
    if (attempt !== session) return;
    $<HTMLInputElement>('key').value = '';
    clearSession(storage('sessionStorage'), NETWORK);
    await enter(connected, attempt);
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

    let state = 'Waiting for your wallet';
    const tick = (): void => {
      status.textContent = `${state}. This code works for ${countdown(pending.expiresAt - Date.now())}.`;
    };
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
      onStatus: (poll) => {
        state = poll === 'answered' ? 'Your wallet answered. Checking its key' : poll === 'incomplete-read' ? 'Could not read every answer, trying again' : 'Waiting for your wallet';
        tick();
      },
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
      if (attempt !== session) return;
      saveSession(storage('sessionStorage'), NETWORK, { identityId: grant.identityId, privateKey: grant.privateKey });
      await enter(connected, attempt);
      if (attempt === session) cancelWallet();
    } finally {
      grant.privateKey.fill(0);
    }
  } catch (caught) {
    if (attempt !== session || (caught as Error)?.name === 'AbortError') return;
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
  const saved = loadSession(storage('sessionStorage'), NETWORK);
  if (!saved) return;
  const attempt = ++session;
  const button = $<HTMLButtonElement>('wallet-button');
  button.disabled = true;
  $('wallet-progress').textContent = 'Signing you back in…';
  try {
    const evo = await loadEvo();
    const connected = await evo.EvoWriter.connectAs(networkConfig(NETWORK), saved);
    if (expiring(connected)) throw new evo.KeyRefused('expired');
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

function signOut(): void {
  session += 1;
  cancelWallet();
  clearSession(storage('sessionStorage'), NETWORK);
  writer = undefined;
  names = [];
  chosen = undefined;
  $('signin-ways').hidden = false;
  $('step-signin').querySelector<HTMLElement>('.done')!.hidden = true;
  $('allowance').hidden = true;
  $('result').hidden = true;
  $('site-status').textContent = '';
  showRegistration(true);
  renderNames();
  refresh();
}

async function withName(action: (writer: EvoWriter) => Promise<DomainRecord>, button: HTMLButtonElement, busyText: string): Promise<void> {
  if (!writer) return;
  const error = $('name-error');
  const text = button.textContent;
  error.textContent = '';
  button.disabled = true;
  button.textContent = busyText;
  try {
    await choose(await action(writer));
    await refreshBalance();
  } catch (caught) {
    error.textContent = message(caught);
  } finally {
    button.disabled = false;
    button.textContent = text;
  }
}

function renderLinks(): void {
  $('links').replaceChildren(
    ...draft.links.map((link, index) => {
      const row = document.createElement('div');
      row.className = 'linkrow';
      const name = Object.assign(document.createElement('input'), { type: 'text', value: link.label, placeholder: 'Label' });
      name.setAttribute('aria-label', 'Link label');
      const url = Object.assign(document.createElement('input'), { type: 'text', value: link.url, placeholder: 'https://…' });
      url.setAttribute('aria-label', 'Link address');
      const remove = Object.assign(document.createElement('button'), { type: 'button', className: 'quiet', textContent: 'Remove' });
      const update = (): void => {
        draft.links[index] = { label: name.value, url: url.value };
        saveDraft();
        refresh();
      };
      name.addEventListener('input', update);
      url.addEventListener('input', update);
      remove.addEventListener('click', () => {
        draft.links.splice(index, 1);
        saveDraft();
        renderLinks();
        refresh();
      });
      row.append(name, url, remove);
      return row;
    }),
  );
}

function renderThemes(): void {
  $('themes').replaceChildren(
    ...(Object.keys(THEMES) as Theme[]).map((theme) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.setAttribute('role', 'radio');
      button.setAttribute('aria-checked', String(draft.theme === theme));
      button.textContent = THEMES[theme].label;
      button.addEventListener('click', () => {
        draft.theme = theme;
        saveDraft();
        renderThemes();
        refresh();
      });
      return button;
    }),
  );
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
  if (!writer || !chosen || !bundle || publishing) return;
  if (expiring(writer)) {
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
    const result = await publishSite(writer, chosen.label, bundle, (step) => {
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
    $('result-dash').textContent = `${published}.dash`;
    $('result').hidden = false;
    if (label() === published) $('site-status').textContent = `${published}.dash has a site (revision ${result.site.revision}). Publishing again replaces it.`;
  } catch (caught) {
    status.textContent = '';
    const live = writer?.keyLimits.bound ? await writer.keyLive().catch(() => true) : true;
    error.textContent =
      live === false
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
  if (!writer || !chosen) return;
  const status = $('manage-status');
  button.disabled = true;
  status.textContent = 'Working…';
  try {
    status.textContent = await action(writer, chosen);
    await refreshBalance();
  } catch (caught) {
    status.textContent = message(caught);
  } finally {
    button.disabled = false;
  }
}

function start(): void {
  $('net').textContent = NETWORK;
  $<HTMLInputElement>('title').value = draft.title;
  $<HTMLInputElement>('tagline').value = draft.tagline;
  $<HTMLTextAreaElement>('body').value = draft.body;
  renderLinks();
  renderThemes();

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
  $('signout').addEventListener('click', signOut);
  $('wallet-button').addEventListener('click', () => void signInWithWallet());
  $('wallet-cancel').addEventListener('click', () => {
    session += 1;
    cancelWallet();
  });
  $('wallet-origin').textContent = location.host;
  $('wallet-testnet').hidden = NETWORK !== 'testnet';

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
  for (const field of ['title', 'tagline', 'body'] as const) {
    $<HTMLInputElement>(field).addEventListener('input', (event) => {
      draft[field] = (event.target as HTMLInputElement).value;
      saveDraft();
      refresh();
    });
  }
  $('add-link').addEventListener('click', () => {
    draft.links.push({ label: '', url: '' });
    renderLinks();
  });
  $<HTMLInputElement>('picture').addEventListener('change', (event) => {
    const file = (event.target as HTMLInputElement).files?.[0];
    const ext = file ? PICTURE_TYPES[file.type] : undefined;
    if (!file || !ext) return;
    void readFile(file).then((bytes) => {
      draft.picture = { bytes, ext };
      $('picture-remove').hidden = false;
      refresh();
    });
  });
  $('picture-remove').addEventListener('click', () => {
    draft.picture = undefined;
    $<HTMLInputElement>('picture').value = '';
    $('picture-remove').hidden = true;
    refresh();
  });

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
      const removed = await w.deleteSite(domain.id);
      $('site-status').textContent = `${label()}.dash has no site.`;
      return removed ? 'The site is down. Its files stay stored until you delete them.' : 'There was no site to take down.';
    });
  });
  $<HTMLButtonElement>('gc').addEventListener('click', (event) => {
    void manage(event.currentTarget as HTMLButtonElement, async (w) => {
      const deleted = await collectGarbage(w);
      return deleted === 0 ? 'Nothing to delete: every stored file is in use.' : `Deleted ${deleted} unused ${deleted === 1 ? 'part' : 'parts'}.`;
    });
  });

  refresh();
  void resumeWallet();
  const idle = (window as { requestIdleCallback?: (fn: () => void) => void }).requestIdleCallback ?? ((fn: () => void) => setTimeout(fn, 1500));
  idle(() => void Promise.all([loadEvo(), loadConnect()]).catch(() => {}));
}

start();
