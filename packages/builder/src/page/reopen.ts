import { contentTypeFor, ElsewhereError, loadManifest, parseContentUri, parsePlace, readElsewhere, readFile, utf8, type ChunkSource, type DomainRecord, type PlaceFetchers, type Proved, type SiteRecord } from '@dash-sites/core';
import type { SiteAsset } from '../assets.js';
import { imagePaths, PAGE_MODEL_PATH, readPageModel, type PageModel } from './model.js';

export interface PublishedSource {
  getSite(ownerId: string, domainId: string): Promise<Proved<SiteRecord | undefined>>;
  getChunks(ownerId: string, hashes: string[]): Promise<Map<string, Uint8Array>>;
}

export class ReopenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReopenError';
  }
}

export interface PublishedPage {
  model: PageModel;
  assets: SiteAsset[];
  /** Images the site keeps outside Platform: the hash of each and the places it lists that this version can fetch. */
  outside: Array<{ sha256: string; places: string[] }>;
  /** Images kept outside Platform that none of their places served. */
  lost: string[];
}

/**
 * Whose places a reopened page may bring into this browser: only a site the signed-in identity
 * owns. Anyone can publish a page that lists places of their choosing for bytes they copied.
 */
export const trustedOutside = (page: PublishedPage, domain: DomainRecord, identity: string | undefined): PublishedPage['outside'] =>
  identity !== undefined && identity === domain.ownerId ? page.outside : [];

/** Reads the page model and images of the site published under `domain`, as the editor saved them. */
export async function readPublishedPage(source: PublishedSource, domain: DomainRecord, places: PlaceFetchers = {}): Promise<PublishedPage> {
  const name = `${domain.label.toLowerCase()}.dash`;
  const site = (await source.getSite(domain.ownerId, domain.id)).value;
  if (!site || site.updatedAt < domain.transferredAt) throw new ReopenError(`${name} has no site.`);
  const ref = parseContentUri(site.content);
  if (ref?.scheme !== 'dash-manifest') throw new ReopenError(`The site at ${name} is not stored in a way this builder can read.`);
  const chunks: ChunkSource = (hashes) => source.getChunks(site.ownerId, hashes);
  const manifest = await loadManifest(ref, chunks);
  if (!manifest.files[PAGE_MODEL_PATH]) throw new ReopenError(`The site at ${name} was not made with the page editor, so there is nothing to open. Upload its files instead.`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(utf8.decode((await readFile(manifest, PAGE_MODEL_PATH, chunks)).bytes));
  } catch {
    throw new ReopenError(`The page stored at ${name} cannot be read.`);
  }
  const model = readPageModel(parsed);
  const assets: SiteAsset[] = [];
  const outside: PublishedPage['outside'] = [];
  const lost: string[] = [];
  for (const path of imagePaths(model)) {
    const entry = manifest.files[path];
    if (!entry) continue;
    try {
      const { bytes } = await readFile(manifest, path, chunks, (at, file) => readElsewhere(at, file, places));
      assets.push({ path, type: contentTypeFor(path), bytes });
      const known = (entry.src ?? []).flatMap((place) => parsePlace(place)?.uri ?? []);
      if (known.length > 0) outside.push({ sha256: entry.sha256, places: known });
    } catch (error) {
      if (!(error instanceof ElsewhereError)) throw error;
      lost.push(path);
    }
  }
  return { model, assets, outside, lost };
}
