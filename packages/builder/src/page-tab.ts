import { formatDash, networkConfig, parseName, type Network, type PlaceFetchers, type SiteFile } from '@dash-sites/core';
import type { EvoReader } from '@dash-sites/core/evo';
import { onSiteAssetsChange, setSiteAssets, siteAssets } from './assets.js';
import { keepOutside, onOutsideChange, outsidePlaces, rememberOutside } from './outside.js';
import { BLOCKS } from './page/blocks.js';
import { costSplit, fileCredits, sizeText, type CostSplit } from './page/cost.js';
import { loadPageDraft, savePageDraft } from './page/draft.js';
import { imagePaths, isBlankModel, tidyPageModel, type PageModel } from './page/model.js';
import { renderSite } from './page/render.js';
import { readPublishedPage, trustedOutside } from './page/reopen.js';
import { THEMES, type Theme } from './template.js';
import type { KeyValue } from './wallet.js';

export interface PageTabOptions {
  network: Network;
  storage: KeyValue | undefined;
  siteName(): string;
  /** The identity that is signed in, if any. */
  identity(): string | undefined;
  /** How files kept outside Platform are fetched when a published page is opened again. */
  places: PlaceFetchers;
  /** Called whenever the page or its images change. */
  onChange(): void;
}

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
const message = (error: unknown): string => String((error as Error)?.message ?? error);

let options: PageTabOptions;
let model: PageModel;
let draftNote = '';
let reader: Promise<EvoReader> | undefined;

/** The files of the page being built, or none while it is empty. */
export function pageFiles(siteName: string): SiteFile[] {
  return isBlankModel(model) ? [] : renderSite(model, siteName, siteAssets());
}

function costText(split: CostSplit | undefined): string {
  if (!split) return '';
  const images = split.imageCount === 0 ? 'no images' : `${split.imageCount === 1 ? 'one image' : `${split.imageCount} images`} (${sizeText(split.imageBytes)}) about ${formatDash(split.images)}`;
  const outside = split.outsideCount === 0 ? '' : ` ${split.outsideCount === 1 ? 'One image is kept outside Platform and costs' : `${split.outsideCount} images are kept outside Platform and cost`} nothing to store on it.`;
  return `At most about ${formatDash(split.total)}: text about ${formatDash(split.text)}, ${images}.${outside}`;
}

function save(): void {
  const saved = savePageDraft(options.storage, model, siteAssets());
  draftNote =
    saved === 'saved'
      ? 'Your draft is kept in this browser.'
      : saved === 'without-images'
        ? 'Your draft is kept in this browser, but its images are too large to keep: if you reload, add them again.'
        : 'This browser does not keep drafts, so the page lasts only while this tab is open.';
}

function changed(): void {
  save();
  render();
  options.onChange();
}

export function setPageModel(next: PageModel): void {
  model = tidyPageModel(next);
  changed();
}

function renderThemes(): void {
  $('themes').replaceChildren(
    ...(Object.keys(THEMES) as Theme[]).map((theme) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.setAttribute('role', 'radio');
      button.setAttribute('aria-checked', String(model.theme === theme));
      button.textContent = THEMES[theme].label;
      button.addEventListener('click', () => setPageModel({ ...model, theme }));
      return button;
    }),
  );
}

function render(): void {
  renderThemes();
  const blocks = model.pages['/'];
  $('page-summary').textContent = blocks.length === 0 ? 'The page is empty. Open the editor to add a header, text, links and images.' : `${blocks.length} ${blocks.length === 1 ? 'block' : 'blocks'}: ${blocks.map((block) => BLOCKS[block.type].label).join(', ')}.`;
  $<HTMLButtonElement>('edit-page').textContent = blocks.length === 0 ? 'Start a page' : 'Open the editor';
  $('clear-page').hidden = blocks.length === 0;
  const stored = new Map(siteAssets().map((asset) => [asset.path, asset]));
  const used = imagePaths(model);
  const missing = used.filter((path) => !stored.has(path)).length;
  $('page-images').replaceChildren(
    ...used.flatMap((path) => {
      const asset = stored.get(path);
      if (!asset) return [];
      const item = document.createElement('li');
      const name = document.createElement('span');
      name.textContent = path;
      const size = document.createElement('span');
      size.textContent = `${sizeText(asset.bytes.length)}, ${outsidePlaces(asset.bytes).length > 0 ? 'outside Platform' : formatDash(fileCredits(asset))}`;
      item.append(name, size);
      return [item];
    }),
  );
  $('page-cost').textContent = costText(costSplit(keepOutside(pageFiles(options.siteName()))));
  $('page-draft').textContent = [missing > 0 ? `${missing === 1 ? 'One image was' : `${missing} images were`} not kept with the draft; add ${missing === 1 ? 'it' : 'them'} again in the editor.` : '', draftNote].filter(Boolean).join(' ');
}

async function openEditor(): Promise<void> {
  const button = $<HTMLButtonElement>('edit-page');
  const text = button.textContent;
  button.disabled = true;
  button.textContent = 'Loading the editor…';
  $('page-error').textContent = '';
  try {
    const editor = await import('./editor/editor.js');
    if (isBlankModel(model)) setPageModel(editor.starterPage(model.theme));
    editor.openEditor({
      model,
      siteName: options.siteName,
      onChange: setPageModel,
      onClose: () => button.focus(),
    });
  } catch (error) {
    $('page-error').textContent = `The editor did not load: ${message(error)}`;
  } finally {
    button.disabled = false;
    button.textContent = text;
  }
}

async function reopen(input: string): Promise<void> {
  const status = $('reopen-status');
  const name = parseName(input);
  if (!name) {
    status.textContent = 'Enter a name such as alice.dash.';
    return;
  }
  if (!isBlankModel(model) && !confirm(`Replace the page you are building with the one published at ${name.label}.dash?`)) return;
  const button = $<HTMLFormElement>('reopen-form').querySelector('button') as HTMLButtonElement;
  button.disabled = true;
  status.textContent = `Reading ${name.label}.dash from Dash Platform…`;
  try {
    reader ??= import('@dash-sites/core/evo').then((evo) => evo.EvoReader.connect(networkConfig(options.network)));
    const connected = await reader.catch((error: unknown) => {
      reader = undefined;
      throw error;
    });
    const opened = await readPublishedPage(connected, `${name.label}.dash`, options.places);
    const trusted = trustedOutside(opened, options.identity());
    for (const file of trusted) rememberOutside(file.sha256, file.places);
    setSiteAssets(opened.assets);
    setPageModel(opened.model);
    const outside = opened.outside.length - trusted.length;
    const unkept = outside === 0 ? '' : ` ${outside === 1 ? 'One image is' : `${outside} images are`} kept outside Platform. Publishing would store ${outside === 1 ? 'it' : 'them'} on Platform: to keep ${outside === 1 ? 'it' : 'them'} outside, sign in as the owner and open the site again.`;
    const lost = opened.lost.length === 0 ? '' : ` ${opened.lost.length === 1 ? 'One image is' : `${opened.lost.length} images are`} kept outside Platform and could not be fetched (${opened.lost.join(', ')}); add ${opened.lost.length === 1 ? 'it' : 'them'} again in the editor.`;
    status.textContent = `Opened the page published at ${opened.name}. Publishing again stores only what changed.${unkept}${lost}`;
  } catch (error) {
    status.textContent = message(error);
  } finally {
    button.disabled = false;
  }
}

export function mountPageTab(given: PageTabOptions): void {
  options = given;
  const draft = loadPageDraft(options.storage);
  model = draft.model;
  setSiteAssets(draft.assets);
  onSiteAssetsChange(changed);
  onOutsideChange(render);
  render();
  $('edit-page').addEventListener('click', () => void openEditor());
  $('clear-page').addEventListener('click', () => {
    if (confirm('Remove every block and start over? This cannot be undone.')) {
      setSiteAssets([]);
      setPageModel({ ...model, pages: { '/': [] } });
    }
  });
  $('reopen-name').addEventListener('input', (event) => delete (event.target as HTMLElement).dataset.suggested);
  $<HTMLFormElement>('reopen-form').addEventListener('submit', (event) => {
    event.preventDefault();
    void reopen($<HTMLInputElement>('reopen-name').value);
  });
}

/** Suggests the chosen name for reopening, unless the owner typed another. */
export function suggestReopen(label: string | undefined): void {
  const input = $<HTMLInputElement>('reopen-name');
  if (label && (!input.value || input.dataset.suggested === 'true')) {
    input.value = `${label}.dash`;
    input.dataset.suggested = 'true';
  }
}
