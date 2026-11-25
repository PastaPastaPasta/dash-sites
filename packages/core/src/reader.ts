import { concat, sha256Hex } from './bytes.js';
import { cdnSource, integrityOfAsync, type ExternalSource } from './external.js';
import type { ContentRef } from './content.js';
import { gunzip } from './gzip.js';
import { CHUNK_SIZE, DEFAULT_LIMITS, MAX_MANIFEST_BYTES, type Limits } from './limits.js';
import { decodeManifest, type Manifest, type ManifestFile } from './manifest.js';
import { matchesFile, tryPlace, type PlaceAttempt, type PlaceFetchers } from './places.js';

/** Returns chunks by hash. Results are untrusted: the reader hashes every chunk. */
export type ChunkSource = (hashes: string[]) => Promise<Map<string, Uint8Array>>;

export class ContentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContentError';
  }
}

/** No place a file lists served the bytes its owner published. The rest of the site is unaffected. */
export class ElsewhereError extends ContentError {
  constructor(
    readonly path: string,
    readonly attempts: PlaceAttempt[],
  ) {
    super(`${path} could not be loaded from where it is stored: ${attempts.map(({ place, problem }) => `${place}: ${problem}`).join('; ')}`);
    this.name = 'ElsewhereError';
  }
}

/** Fetches a file kept outside Platform from the first of its places that serves the published bytes. */
export async function readElsewhere(path: string, file: ManifestFile, fetchers: PlaceFetchers): Promise<Uint8Array> {
  const attempts: PlaceAttempt[] = [];
  for (const place of file.src ?? []) {
    const result = await tryPlace(place, file, fetchers);
    if ('bytes' in result) return result.bytes;
    attempts.push({ place, problem: result.problem });
  }
  throw new ElsewhereError(path, attempts);
}

async function fetchVerified(source: ChunkSource, hashes: string[]): Promise<Map<string, Uint8Array>> {
  const wanted = [...new Set(hashes)];
  const got = wanted.length === 0 ? new Map<string, Uint8Array>() : await source(wanted);
  const out = new Map<string, Uint8Array>();
  for (const hash of wanted) {
    const data = got.get(hash);
    if (!data) throw new ContentError(`chunk ${hash} is not stored`);
    if (data.length > CHUNK_SIZE || sha256Hex(data) !== hash) throw new ContentError(`chunk ${hash} does not match its hash`);
    out.set(hash, data);
  }
  return out;
}

export async function loadManifest(
  ref: Extract<ContentRef, { scheme: 'dash-manifest' }>,
  source: ChunkSource,
  limits: Limits = DEFAULT_LIMITS,
): Promise<Manifest> {
  const chunks = await fetchVerified(source, ref.chunks);
  const compressed = concat(ref.chunks.map((hash) => chunks.get(hash) as Uint8Array));
  let encoded: Uint8Array;
  try {
    encoded = gunzip(compressed, MAX_MANIFEST_BYTES);
  } catch (error) {
    throw new ContentError(`manifest cannot be decompressed: ${(error as Error).message}`);
  }
  return decodeManifest(encoded, limits);
}

export interface FileContent {
  file: ManifestFile;
  /** The decoded file. */
  bytes: Uint8Array;
  /** The bytes as stored: compressed when `file.enc` is set, else the same as `bytes`. */
  stored: Uint8Array;
}

const defaultExternal = cdnSource();

/** Where the files a site does not store come from. */
export interface Outside {
  /** Fetches a file of an npm package (`ext`). Defaults to the npm CDNs. */
  external?: ExternalSource;
  /** Fetches a file kept at places (`src`). Defaults to fetching nothing. */
  elsewhere?: (path: string, file: ManifestFile) => Promise<Uint8Array>;
}

/** Reads one file of a manifest and checks it against the manifest's size and hash. */
export async function readFile(manifest: Manifest, path: string, source: ChunkSource, outside: Outside = {}): Promise<FileContent> {
  const file = manifest.files[path];
  if (!file) throw new ContentError(`no such file: ${path}`);
  if (file.unread) throw new ContentError(`${path} ${file.unread}`);
  if (file.ext) {
    const bytes = await (outside.external ?? defaultExternal)(file.ext, file.size);
    if (!(await matchesFile(bytes, file)) || (await integrityOfAsync(bytes)) !== file.ext.integrity) throw new ContentError(`${path} does not match its hash`);
    return { file, bytes, stored: bytes };
  }
  if (file.src) {
    const bytes = await (outside.elsewhere ?? ((at, entry) => readElsewhere(at, entry, {})))(path, file);
    if (!(await matchesFile(bytes, file))) throw new ContentError(`${path} does not match its hash`);
    return { file, bytes, stored: bytes };
  }
  if (file.enc !== undefined && file.enc !== 'gzip' && file.enc !== 'br') throw new ContentError(`${path} is stored in a form this version cannot read`);
  const hashes = file.parts.map(([index]) => manifest.chunks[index] as string);
  const chunks = await fetchVerified(source, hashes);
  const pieces: Uint8Array[] = [];
  for (const [index, offset, length] of file.parts) {
    const chunk = chunks.get(manifest.chunks[index] as string) as Uint8Array;
    if (offset + length > chunk.length) throw new ContentError(`${path} reads past the end of a chunk`);
    pieces.push(chunk.subarray(offset, offset + length));
  }
  const stored = concat(pieces);
  let bytes = stored;
  if (file.enc) {
    try {
      bytes = file.enc === 'gzip' ? gunzip(stored, file.size) : (await import('brotli/decompress')).decompress(stored, file.size);
    } catch (error) {
      throw new ContentError(`${path} cannot be decompressed: ${(error as Error).message}`);
    }
  }
  if (bytes.length !== file.size || sha256Hex(bytes) !== file.sha256) throw new ContentError(`${path} does not match its hash`);
  return { file, bytes, stored };
}

/** Every chunk hash a site needs: its manifest chunks and its content chunks. */
export function referencedChunks(ref: Extract<ContentRef, { scheme: 'dash-manifest' }>, manifest: Manifest): Set<string> {
  return new Set([...ref.chunks, ...manifest.chunks]);
}
