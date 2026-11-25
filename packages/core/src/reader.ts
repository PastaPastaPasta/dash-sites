import { decompress as brotliDecompress } from 'brotli/decompress';
import { concat, sha256Hex } from './bytes.js';
import { cdnSource, integrityOf, type ExternalSource } from './external.js';
import type { ContentRef } from './content.js';
import { gunzip } from './gzip.js';
import { CHUNK_SIZE, DEFAULT_LIMITS, MAX_MANIFEST_BYTES, type Limits } from './limits.js';
import { decodeManifest, type Manifest, type ManifestFile } from './manifest.js';

/** Returns chunks by hash. Results are untrusted: the reader hashes every chunk. */
export type ChunkSource = (hashes: string[]) => Promise<Map<string, Uint8Array>>;

export class ContentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContentError';
  }
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

/** Reads one file of a manifest and checks it against the manifest's size and hash. */
export async function readFile(manifest: Manifest, path: string, source: ChunkSource, external: ExternalSource = defaultExternal): Promise<FileContent> {
  const file = manifest.files[path];
  if (!file) throw new ContentError(`no such file: ${path}`);
  if (file.ext) {
    const bytes = await external(file.ext, file.size);
    if (bytes.length !== file.size || integrityOf(bytes) !== file.ext.integrity || sha256Hex(bytes) !== file.sha256) {
      throw new ContentError(`${path} does not match its hash`);
    }
    return { file, bytes, stored: bytes };
  }
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
      bytes = file.enc === 'gzip' ? gunzip(stored, file.size) : brotliDecompress(stored, file.size);
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
