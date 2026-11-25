import { contentTypeFor, ElsewhereError, loadManifest, parsePlace, readElsewhere, readFile, resolveName, utf8, type ChunkSource, type PlaceFetchers, type PlatformReader } from '@dash-sites/core';
import type { SiteAsset } from '../assets.js';
import { imagePaths, PAGE_MODEL_PATH, readPageModel, type PageModel } from './model.js';

export class ReopenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReopenError';
  }
}

export interface PublishedPage {
  /** The name as registered, such as `alice.dash`. */
  name: string;
  /** The identity that owns the name, and so published the page. */
  ownerId: string;
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
export const trustedOutside = (page: PublishedPage, identity: string | undefined): PublishedPage['outside'] =>
  identity !== undefined && identity === page.ownerId ? page.outside : [];

/**
 * Reads the page model and images of the site a name shows, as the editor saved them. The name is
 * resolved the way a visitor's browser resolves it, so only its current owner's site is opened.
 */
export async function readPublishedPage(reader: PlatformReader, input: string, places: PlaceFetchers = {}): Promise<PublishedPage> {
  const resolution = await resolveName(reader, input);
  if (resolution.status === 'invalid') throw new ReopenError('Enter a name such as alice.dash.');
  if (resolution.status === 'unregistered') throw new ReopenError(`${input} is not registered.`);
  const name = `${resolution.canonicalLabel}.dash`;
  if (resolution.status === 'no-site') throw new ReopenError(`${name} has no site.`);
  if (resolution.status !== 'ok' || resolution.content.scheme !== 'dash-manifest') throw new ReopenError(`The site at ${name} is not stored in a way this builder can read.`);
  const chunks: ChunkSource = (hashes) => reader.getChunks(resolution.ownerId, hashes);
  const manifest = await loadManifest(resolution.content, chunks);
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
  return { name, ownerId: resolution.ownerId, model, assets, outside, lost };
}
