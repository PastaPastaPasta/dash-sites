import { parsePlace, type PlaceFetchers, type SiteFile } from '@dash-sites/core';
import { BUCKET_CORS, browserFetchers, confirmPlaces, readPlaces, uploadToBucket, uploadToPinata, type Bucket, type OutsideFile } from './elsewhere.js';
import { fileHash, outsidePlaces, setOutsidePlaces } from './outside.js';

export interface OutsidePanelOptions {
  /** This page's origin, which a bucket must let upload to it. */
  origin: string;
  /** What storing a file on Platform costs, as text. */
  price(file: SiteFile): string;
  size(bytes: number): string;
  fetchers?: PlaceFetchers;
  /** How long to keep asking IPFS for a file that was only just pinned. */
  patienceMs?: number;
}

type Method = 'address' | 'bucket' | 'pinata';

/** Files smaller than this cost too little on Platform to be worth a second place to depend on. */
const WORTH_MOVING = 8 * 1024;
const SHOWN = 40;

const METHODS: Array<[Method, string, string]> = [
  ['address', 'It is already online', 'Upload the file with your storage provider, then give its address or IPFS CID here.'],
  ['bucket', 'Upload to a bucket', 'Cloudflare R2, or any other store that speaks the S3 protocol.'],
  ['pinata', 'Pin on IPFS with Pinata', 'The file is pinned to IPFS through your Pinata account.'],
];

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & { class?: string } = {}, ...children: Array<Node | string>): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  const { class: className, ...rest } = props;
  Object.assign(node, rest);
  if (className) node.className = className;
  node.append(...children);
  return node;
}

const placeLabel = (uri: string): string => {
  const place = parsePlace(uri);
  if (place?.kind === 'https') return new URL(place.uri).host;
  if (place?.kind === 'ipfs') return `IPFS ${place.cid.slice(0, 10)}…`;
  return uri;
};

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The part of the builder where an owner moves large files off Platform. It only changes where a
 * file is kept: every place is asked for the file, the way a visitor's browser will ask, before
 * the file is marked as kept outside.
 */
export function mountOutsidePanel(root: HTMLElement, options: OutsidePanelOptions): { show(files: SiteFile[]): void } {
  const fetchers = options.fetchers ?? browserFetchers();
  let method: Method = 'address';
  let files: SiteFile[] = [];
  const busy = new Map<string, string>();
  const problems = new Map<string, string>();
  const unconfirmed = new Map<string, string>();
  const typed = new Map<string, string>();

  const field = (label: string, input: HTMLInputElement, hint?: string): HTMLElement => el('label', {}, label, ...(hint ? [el('span', { class: 'soft' }, hint)] : []), input);
  const text = (placeholder: string, secret = false): HTMLInputElement => el('input', { type: secret ? 'password' : 'text', placeholder, spellcheck: false, autocomplete: 'off', autocapitalize: 'none' });

  const bucket = {
    endpoint: text('https://<account>.r2.cloudflarestorage.com'),
    bucket: text('media'),
    region: text('auto'),
    accessKeyId: text('Access key ID'),
    secretAccessKey: text('Secret access key', true),
    publicUrl: text('https://media.example.com'),
    prefix: text('site/'),
  };
  const jwt = text('Pinata key (JWT)', true);
  const bucketSettings = (): Bucket => ({
    endpoint: bucket.endpoint.value,
    bucket: bucket.bucket.value,
    region: bucket.region.value || 'auto',
    accessKeyId: bucket.accessKeyId.value,
    secretAccessKey: bucket.secretAccessKey.value,
    publicUrl: bucket.publicUrl.value,
    prefix: bucket.prefix.value,
  });

  const settings: Record<Method, HTMLElement> = {
    address: el('div', {}, el('p', { class: 'hint' }, 'Works with any host that serves the file over https:// and lets other sites read it, and with any IPFS pinning service. Arweave files work by their address.')),
    bucket: el(
      'div',
      { class: 'outside-fields' },
      field('Bucket API address', bucket.endpoint),
      field('Bucket name', bucket.bucket),
      field('Region', bucket.region, 'auto on R2'),
      field('Access key ID', bucket.accessKeyId),
      field('Secret access key', bucket.secretAccessKey),
      field('Public address', bucket.publicUrl, 'the bucket’s custom domain'),
      field('Folder', bucket.prefix, 'optional'),
      el('p', { class: 'hint' }, 'Use a key that may only write to this bucket. It stays in this tab and is not stored or sent anywhere but the bucket.'),
      el('details', {}, el('summary', {}, 'The bucket must allow this page to upload and every site to read'), el('p', { class: 'hint' }, 'Set this as the bucket’s CORS policy:'), el('pre', { class: 'outside-code' }, BUCKET_CORS(options.origin))),
    ),
    pinata: el(
      'div',
      { class: 'outside-fields' },
      field('Pinata key', jwt, 'the JWT of an API key that may write files'),
      el('p', { class: 'hint' }, 'It stays in this tab and is not stored or sent anywhere but Pinata. The file stays on IPFS for as long as your Pinata account keeps it pinned.'),
    ),
  };

  const chooser = el('div', { class: 'chips' });
  chooser.setAttribute('role', 'radiogroup');
  chooser.setAttribute('aria-label', 'Where the files go');
  const explain = el('p', { class: 'hint' });
  const settingsBox = el('div');
  const all = el('button', { type: 'button', class: 'second', hidden: true });
  const list = el('ul', { class: 'files outside-files' });
  const note = el('p', { class: 'hint' });
  root.replaceChildren(
    el('p', { class: 'hint' }, 'Storing on Dash Platform costs about 0.3 DASH per MB. A photo or a large script can be kept somewhere cheaper. Platform then stores only its size and hash, and a visitor’s browser shows the file only if it matches.'),
    chooser,
    explain,
    settingsBox,
    el('div', { class: 'actions' }, all),
    list,
    note,
  );

  const asOutside = (file: SiteFile): OutsideFile => ({ path: file.path, type: file.type ?? 'application/octet-stream', bytes: file.bytes });

  async function confirm(file: SiteFile, place: string): Promise<string | undefined> {
    const patient = parsePlace(place)?.kind === 'ipfs' && method === 'pinata';
    const until = Date.now() + (patient ? (options.patienceMs ?? 90_000) : 0);
    for (;;) {
      const [result] = await confirmPlaces(asOutside(file), [place], fetchers);
      if (!result?.problem) return undefined;
      if (Date.now() >= until) return result.problem;
      busy.set(fileHash(file.bytes), 'Pinned. Waiting for IPFS to find it…');
      render();
      await wait(Math.min(8000, Math.max(0, until - Date.now())));
    }
  }

  function keep(file: SiteFile, places: string[]): void {
    const hash = fileHash(file.bytes);
    typed.delete(hash);
    busy.delete(hash);
    problems.delete(hash);
    unconfirmed.delete(hash);
    setOutsidePlaces(file.bytes, [...outsidePlaces(file.bytes), ...places]);
  }

  async function move(file: SiteFile, typed = ''): Promise<void> {
    const hash = fileHash(file.bytes);
    if (busy.has(hash)) return;
    problems.delete(hash);
    unconfirmed.delete(hash);
    try {
      if (method === 'address') {
        const { places, unknown } = readPlaces(typed);
        if (unknown.length > 0) throw new Error(`${unknown[0]} is not an https:// address or an IPFS CID`);
        if (places.length === 0) throw new Error('Give the address or the IPFS CID of the file');
        busy.set(hash, 'Asking for the file…');
        render();
        const failed = (await confirmPlaces(asOutside(file), places, fetchers)).find((result) => result.problem);
        if (failed) throw new Error(`${placeLabel(failed.place)}: ${failed.problem}`);
        return keep(file, places);
      }
      busy.set(hash, method === 'bucket' ? 'Uploading…' : 'Pinning…');
      render();
      const place = method === 'bucket' ? await uploadToBucket(bucketSettings(), asOutside(file)) : await uploadToPinata(jwt.value, asOutside(file));
      busy.set(hash, 'Uploaded. Asking for the file back…');
      render();
      const problem = await confirm(file, place);
      if (!problem) return keep(file, [place]);
      unconfirmed.set(hash, place);
      throw new Error(`It was uploaded, but ${placeLabel(place)} did not serve it back: ${problem}`);
    } catch (error) {
      problems.set(hash, String((error as Error)?.message ?? error));
    } finally {
      busy.delete(hash);
      render();
    }
  }

  const candidates = (): SiteFile[] => files.filter((file) => file.bytes.length >= WORTH_MOVING || outsidePlaces(file.bytes).length > 0).sort((a, b) => b.bytes.length - a.bytes.length);

  function row(file: SiteFile): HTMLElement {
    const hash = fileHash(file.bytes);
    const places = outsidePlaces(file.bytes);
    const working = busy.get(hash);
    const head = el('div', { class: 'outside-head' }, el('span', {}, file.path), el('span', {}, places.length > 0 ? `${options.size(file.bytes.length)}, outside Platform` : `${options.size(file.bytes.length)}, ${options.price(file)} on Platform`));
    const item = el('li', {}, head);
    if (places.length > 0) item.append(el('div', { class: 'outside-places' }, `Kept at ${places.map(placeLabel).join(' and ')}`));
    const actions = el('div', { class: 'outside-actions' });
    if (working) {
      actions.append(el('span', { class: 'status' }, working));
    } else {
      const again = places.length > 0;
      if (method === 'address') {
        const input = text('https://… or an IPFS CID');
        input.setAttribute('aria-label', `Address or CID of ${file.path}`);
        input.dataset.file = hash;
        input.value = typed.get(hash) ?? '';
        input.addEventListener('input', () => typed.set(hash, input.value));
        const form = el('form', { class: 'inline' }, input, el('button', { class: 'second' }, again ? 'Add a place' : 'Check and keep outside'));
        form.addEventListener('submit', (event) => {
          event.preventDefault();
          void move(file, input.value);
        });
        actions.append(form);
      } else {
        const go = el('button', { type: 'button', class: 'second' }, again ? (method === 'bucket' ? 'Also upload here' : 'Also pin here') : method === 'bucket' ? 'Upload and keep outside' : 'Pin and keep outside');
        go.addEventListener('click', () => void move(file));
        actions.append(go);
      }
      const pending = unconfirmed.get(hash);
      if (pending) {
        const anyway = el('button', { type: 'button', class: 'quiet' }, 'Keep it outside anyway');
        anyway.addEventListener('click', () => keep(file, [pending]));
        actions.append(anyway);
      }
      if (again) {
        const back = el('button', { type: 'button', class: 'quiet' }, 'Store on Platform instead');
        back.addEventListener('click', () => {
          problems.delete(hash);
          setOutsidePlaces(file.bytes, []);
        });
        actions.append(back);
      }
    }
    item.append(actions);
    const problem = problems.get(hash);
    if (problem) item.append(el('p', { class: 'error' }, problem));
    return item;
  }

  function render(): void {
    chooser.replaceChildren(
      ...METHODS.map(([value, label]) => {
        const button = el('button', { type: 'button' }, label);
        button.setAttribute('role', 'radio');
        button.setAttribute('aria-checked', String(method === value));
        button.addEventListener('click', () => {
          method = value;
          render();
        });
        return button;
      }),
    );
    explain.textContent = METHODS.find(([value]) => value === method)?.[2] ?? '';
    if (settingsBox.firstChild !== settings[method]) settingsBox.replaceChildren(settings[method]);
    const shown = candidates();
    const waiting = shown.filter((file) => outsidePlaces(file.bytes).length === 0);
    all.hidden = method === 'address' || waiting.length < 2;
    all.textContent = `${method === 'bucket' ? 'Upload' : 'Pin'} all ${waiting.length} and keep them outside`;
    all.disabled = busy.size > 0;
    all.onclick = async () => {
      for (const file of waiting) await move(file);
    };
    const focused = document.activeElement instanceof HTMLInputElement && list.contains(document.activeElement) ? document.activeElement : undefined;
    list.replaceChildren(...shown.slice(0, SHOWN).map(row));
    if (focused?.dataset.file) {
      const again = list.querySelector<HTMLInputElement>(`input[data-file="${focused.dataset.file}"]`);
      again?.focus();
      again?.setSelectionRange(focused.selectionStart, focused.selectionEnd);
    }
    note.textContent =
      files.length === 0
        ? 'Add your site first; its larger files are listed here.'
        : shown.length === 0
          ? 'This site has no file large enough to be worth moving.'
          : shown.length > SHOWN
            ? `The ${SHOWN} largest of ${shown.length} files are listed.`
            : '';
  }

  render();
  return {
    show(next) {
      files = next;
      render();
    },
  };
}
