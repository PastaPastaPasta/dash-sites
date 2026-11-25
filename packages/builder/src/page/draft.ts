import { marked } from 'marked';
import type { SiteAsset } from '../assets.js';
import { safeUrl, THEMES, type Theme } from '../template.js';
import type { KeyValue } from '../wallet.js';
import { cleanRichText } from './markup.js';
import { emptyPageModel, IMAGE_PATH, imagePaths, newBlock, PAGE_MODEL_VERSION, readPageModel, serializePageModel, type Block, type PageModel } from './model.js';

export const PAGE_DRAFT_KEY = 'dash-sites.page';
export const PAGE_IMAGES_KEY = 'dash-sites.page-images';
/** Drafts of the form that came before the editor. */
export const LEGACY_DRAFT_KEY = 'dash-sites.draft';
/** Browsers give a site about 5 MB of storage, counted in UTF-16 characters. */
const IMAGE_BUDGET = 1_500_000;

const IMAGE_TYPES: Record<string, string> = { webp: 'image/webp', jpg: 'image/jpeg', png: 'image/png', gif: 'image/gif' };

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

const str = (value: unknown): string => (typeof value === 'string' ? value : '');

/** A draft of the old form (title, tagline, Markdown, links, look) as a header, a text block and a link list. */
export function modelFromLegacyDraft(value: unknown): PageModel | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const old = value as Record<string, unknown>;
  const theme = typeof old.theme === 'string' && Object.hasOwn(THEMES, old.theme) ? (old.theme as Theme) : 'paper';
  const model = emptyPageModel(theme);
  const blocks: Block[] = model.pages['/'];
  const name = str(old.title).trim().slice(0, 120);
  const tagline = str(old.tagline).trim().slice(0, 300);
  if (name || tagline) blocks.push(newBlock('header', { name, tagline }));
  const body = str(old.body).trim();
  if (body) blocks.push(newBlock('text', { body: cleanRichText(marked.parse(body, { async: false })).trim() }));
  const links = (Array.isArray(old.links) ? old.links : [])
    .map((link: unknown) => ({ label: str((link as Record<string, unknown>)?.label).trim().slice(0, 120), url: str((link as Record<string, unknown>)?.url).trim() }))
    .filter((link) => link.url && safeUrl(link.url) && link.url.length <= 2048)
    .slice(0, 40);
  if (links.length > 0) blocks.push(newBlock('links', { items: links }));
  return blocks.length > 0 ? model : undefined;
}

export interface LoadedDraft {
  model: PageModel;
  assets: SiteAsset[];
  /** Images the draft refers to that this browser did not keep. */
  missingImages: number;
  /** This browser holds a draft from a newer builder, which is left as it is. */
  newer: boolean;
}

function read(store: KeyValue | undefined, key: string): unknown {
  try {
    return JSON.parse(store?.getItem(key) ?? 'null');
  } catch {
    return null;
  }
}

const isNewer = (saved: unknown): boolean => typeof saved === 'object' && saved !== null && Number((saved as { v?: unknown }).v) > PAGE_MODEL_VERSION;

export function loadPageDraft(store: KeyValue | undefined): LoadedDraft {
  const saved = read(store, PAGE_DRAFT_KEY);
  if (isNewer(saved)) return { model: emptyPageModel(), assets: [], missingImages: 0, newer: true };
  let model: PageModel | undefined;
  if (saved) {
    try {
      model = readPageModel(saved, { repair: true });
    } catch {
      model = undefined;
    }
  }
  if (!model) {
    const legacy = modelFromLegacyDraft(read(store, LEGACY_DRAFT_KEY));
    return { model: legacy ?? emptyPageModel(), assets: [], missingImages: 0, newer: false };
  }
  const stored = read(store, PAGE_IMAGES_KEY);
  const assets: SiteAsset[] = [];
  let missingImages = 0;
  for (const path of imagePaths(model)) {
    const data = typeof stored === 'object' && stored !== null ? (stored as Record<string, unknown>)[path] : undefined;
    const ext = path.slice(path.lastIndexOf('.') + 1);
    try {
      if (typeof data !== 'string' || !IMAGE_PATH.test(path)) throw new Error('missing');
      assets.push({ path, type: IMAGE_TYPES[ext] ?? 'application/octet-stream', bytes: fromBase64(data) });
    } catch {
      missingImages += 1;
    }
  }
  return { model, assets, missingImages, newer: false };
}

/**
 * Keeps the draft in this browser. Images go too when they fit; the result says whether they did.
 * A draft from a newer builder is never written over: this version cannot read what it would lose.
 */
export function savePageDraft(store: KeyValue | undefined, model: PageModel, assets: readonly SiteAsset[]): 'saved' | 'without-images' | 'failed' | 'newer' {
  if (!store) return 'failed';
  if (isNewer(read(store, PAGE_DRAFT_KEY))) return 'newer';
  try {
    store.setItem(PAGE_DRAFT_KEY, serializePageModel(model));
  } catch {
    return 'failed';
  }
  const used = new Set(imagePaths(model));
  const kept = assets.filter((asset) => used.has(asset.path));
  if (kept.reduce((size, asset) => size + 4 * Math.ceil(asset.bytes.length / 3), 0) <= IMAGE_BUDGET) {
    try {
      store.setItem(PAGE_IMAGES_KEY, JSON.stringify(Object.fromEntries(kept.map((asset) => [asset.path, toBase64(asset.bytes)]))));
      return 'saved';
    } catch {
      // too large for this browser's storage
    }
  }
  try {
    store.removeItem(PAGE_IMAGES_KEY);
  } catch {
    return 'failed';
  }
  return used.size === 0 ? 'saved' : 'without-images';
}
