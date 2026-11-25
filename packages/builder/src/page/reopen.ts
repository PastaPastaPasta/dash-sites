import { contentTypeFor, loadManifest, parseContentUri, readFile, utf8, type ChunkSource, type DomainRecord, type Proved, type SiteRecord } from '@dash-sites/core';
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

/** Reads the page model and images of the site published under `domain`, as the editor saved them. */
export async function readPublishedPage(source: PublishedSource, domain: DomainRecord): Promise<{ model: PageModel; assets: SiteAsset[] }> {
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
  for (const path of imagePaths(model)) {
    if (!manifest.files[path]) continue;
    const { bytes } = await readFile(manifest, path, chunks);
    assets.push({ path, type: contentTypeFor(path), bytes });
  }
  return { model, assets };
}
