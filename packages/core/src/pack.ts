import { concat, sha256Hex } from './bytes.js';
import { formatContentUri } from './content.js';
import { gzip } from './gzip.js';
import { CHUNK_SIZE, DEFAULT_LIMITS, MAX_ELSEWHERE_FILE_BYTES, MAX_MANIFEST_BYTES, MAX_MANIFEST_CHUNKS, MAX_PLACES, type Limits } from './limits.js';
import { encodeManifest, isValidContentType, isValidPath, type Manifest, type ManifestFile, type Part } from './manifest.js';
import { contentTypeFor, isCompressible } from './mime.js';
import { parsePlace } from './places.js';

export interface SiteFile {
  /** Absolute site path, e.g. `/index.html`. */
  path: string;
  bytes: Uint8Array;
  /** Defaults to a type derived from the extension. */
  type?: string;
  /**
   * Places outside Platform that hold these bytes. The file is then not stored on Platform: the
   * manifest keeps its size, its hash and this list.
   */
  src?: string[];
}

export interface SiteBundle {
  manifest: Manifest;
  /** Hashes of the chunks holding the gzip-compressed manifest, in order. */
  manifestChunks: string[];
  contentUri: string;
  /** Every chunk to store, manifest chunks included, by hash. */
  chunks: Map<string, Uint8Array>;
  /** `bytes` and `storedBytes` count the files stored on Platform; `elsewhere` counts the rest. */
  stats: { files: number; bytes: number; storedBytes: number; chunks: number; elsewhere: { files: number; bytes: number } };
}

export class PackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PackError';
  }
}

class ChunkWriter {
  readonly table: string[] = [];
  readonly chunks = new Map<string, Uint8Array>();
  private readonly index = new Map<string, number>();
  private open: Uint8Array[] = [];
  private openLength = 0;
  private openParts: Part[] = [];

  /** Adds one complete chunk and returns its table index. */
  add(data: Uint8Array): number {
    const hash = sha256Hex(data);
    const existing = this.index.get(hash);
    if (existing !== undefined) return existing;
    const index = this.table.length;
    this.table.push(hash);
    this.index.set(hash, index);
    this.chunks.set(hash, data);
    return index;
  }

  /** Appends a small item to the shared chunk being filled; the returned part is completed by `flush`. */
  pack(data: Uint8Array): Part {
    if (this.openLength + data.length > CHUNK_SIZE) this.flush();
    const part: Part = [-1, this.openLength, data.length];
    this.open.push(data);
    this.openLength += data.length;
    this.openParts.push(part);
    return part;
  }

  flush(): void {
    if (this.openLength === 0) return;
    const index = this.add(concat(this.open));
    for (const part of this.openParts) part[0] = index;
    this.open = [];
    this.openLength = 0;
    this.openParts = [];
  }
}

function fail(message: string): never {
  throw new PackError(message);
}

function split(data: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let offset = 0; offset < data.length; offset += CHUNK_SIZE) out.push(data.subarray(offset, offset + CHUNK_SIZE));
  return out;
}

/**
 * Turns a set of files into the chunks and manifest to publish. The result depends only on the
 * files, so publishing the same site twice stores nothing new.
 */
export function buildSite(files: SiteFile[], options: { spa?: boolean; limits?: Limits } = {}): SiteBundle {
  const limits = options.limits ?? DEFAULT_LIMITS;
  if (files.length === 0) throw new PackError('a site needs at least one file');
  if (files.length > limits.maxFiles) throw new PackError(`too many files (${files.length}, limit ${limits.maxFiles})`);
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const writer = new ChunkWriter();
  const entries: Record<string, ManifestFile> = {};
  let bytes = 0;
  let storedBytes = 0;
  const elsewhere = { files: 0, bytes: 0 };

  for (const file of sorted) {
    if (!isValidPath(file.path)) throw new PackError(`invalid path: ${file.path}`);
    if (entries[file.path]) throw new PackError(`duplicate path: ${file.path}`);
    const type = file.type ?? contentTypeFor(file.path);
    if (!isValidContentType(type)) throw new PackError(`invalid content type for ${file.path}: ${type}`);
    if (file.src) {
      if (file.src.length === 0 || file.src.length > MAX_PLACES) throw new PackError(`${file.path} needs between 1 and ${MAX_PLACES} places`);
      const places = file.src.map((uri) => parsePlace(uri)?.uri ?? fail(`${file.path}: not an https:// address or an ipfs:// CID: ${uri}`));
      if (new Set(places).size !== places.length) throw new PackError(`${file.path} lists a place twice`);
      if (file.bytes.length === 0) throw new PackError(`${file.path} is empty, so it cannot be stored elsewhere`);
      if (file.bytes.length > MAX_ELSEWHERE_FILE_BYTES) throw new PackError(`${file.path} is larger than ${MAX_ELSEWHERE_FILE_BYTES} bytes`);
      elsewhere.files++;
      elsewhere.bytes += file.bytes.length;
      entries[file.path] = { type, size: file.bytes.length, sha256: sha256Hex(file.bytes), parts: [], src: places };
      continue;
    }
    bytes += file.bytes.length;
    if (bytes > limits.maxSiteBytes) throw new PackError(`site is larger than ${limits.maxSiteBytes} bytes`);

    let stored = file.bytes;
    let enc: 'gzip' | undefined;
    if (file.bytes.length > 0 && isCompressible(type)) {
      const compressed = gzip(file.bytes);
      if (compressed.length < file.bytes.length) {
        stored = compressed;
        enc = 'gzip';
      }
    }
    storedBytes += stored.length;

    const parts: Part[] = [];
    const full = stored.length - (stored.length % CHUNK_SIZE);
    for (const piece of split(stored.subarray(0, full))) parts.push([writer.add(piece), 0, piece.length]);
    if (stored.length > full) parts.push(writer.pack(stored.subarray(full)));
    entries[file.path] = { type, size: file.bytes.length, sha256: sha256Hex(file.bytes), parts, ...(enc ? { enc } : {}) };
  }
  writer.flush();

  const manifest: Manifest = { v: elsewhere.files > 0 ? 2 : 1, chunks: writer.table, files: entries, ...(options.spa ? { spa: true } : {}) };
  const encoded = encodeManifest(manifest);
  if (encoded.length > MAX_MANIFEST_BYTES) throw new PackError('manifest is too large');
  const manifestPieces = split(gzip(encoded));
  if (manifestPieces.length > MAX_MANIFEST_CHUNKS) throw new PackError('manifest is too large');
  const chunks = new Map(writer.chunks);
  const manifestChunks: string[] = [];
  for (const piece of manifestPieces) {
    const hash = sha256Hex(piece);
    manifestChunks.push(hash);
    chunks.set(hash, piece);
  }
  return {
    manifest,
    manifestChunks,
    contentUri: formatContentUri({ scheme: 'dash-manifest', chunks: manifestChunks }),
    chunks,
    stats: { files: sorted.length, bytes, storedBytes, chunks: chunks.size, elsewhere },
  };
}
