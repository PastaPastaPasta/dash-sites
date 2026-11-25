import { concat, sha256Hex } from './bytes.js';
import { formatContentUri } from './content.js';
import { gzip } from './gzip.js';
import { CHUNK_SIZE, DEFAULT_LIMITS, MAX_MANIFEST_BYTES, MAX_MANIFEST_CHUNKS, type Limits } from './limits.js';
import { encodeManifest, isValidContentType, isValidPath, type Manifest, type ManifestFile, type Part } from './manifest.js';
import { contentTypeFor, isCompressible } from './mime.js';
import { integrityOf, isExternalAsset, type ExternalAsset } from './external.js';

export interface SiteFile {
  /** Absolute site path, e.g. `/index.html`. */
  path: string;
  bytes: Uint8Array;
  /** Defaults to a type derived from the extension. */
  type?: string;
}

export interface SiteBundle {
  manifest: Manifest;
  /** Hashes of the chunks holding the gzip-compressed manifest, in order. */
  manifestChunks: string[];
  contentUri: string;
  /** Every chunk to store, manifest chunks included, by hash. */
  chunks: Map<string, Uint8Array>;
  stats: { files: number; bytes: number; storedBytes: number; chunks: number };
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

function split(data: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let offset = 0; offset < data.length; offset += CHUNK_SIZE) out.push(data.subarray(offset, offset + CHUNK_SIZE));
  return out;
}

/**
 * Turns a set of files into the chunks and manifest to publish. The result depends only on the
 * files, so publishing the same site twice stores nothing new.
 */
export interface BuildOptions {
  spa?: boolean;
  limits?: Limits;
  /**
   * Files not to store, by site path: each is a file of a published npm package, which readers
   * fetch from an npm CDN and check against the file's SHA-384. The integrity is checked here
   * against the local file, so a site only names a package file it actually contains.
   */
  external?: Record<string, Omit<ExternalAsset, 'integrity'> & { integrity?: string }>;
  /** A brotli compressor; when given, a compressible file is stored as brotli if that is smaller than gzip. */
  brotli?: (data: Uint8Array) => Uint8Array;
}

export function buildSite(files: SiteFile[], options: BuildOptions = {}): SiteBundle {
  const limits = options.limits ?? DEFAULT_LIMITS;
  if (files.length === 0) throw new PackError('a site needs at least one file');
  if (files.length > limits.maxFiles) throw new PackError(`too many files (${files.length}, limit ${limits.maxFiles})`);
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const writer = new ChunkWriter();
  const entries: Record<string, ManifestFile> = {};
  let bytes = 0;
  let storedBytes = 0;

  for (const file of sorted) {
    if (!isValidPath(file.path)) throw new PackError(`invalid path: ${file.path}`);
    if (entries[file.path]) throw new PackError(`duplicate path: ${file.path}`);
    const type = file.type ?? contentTypeFor(file.path);
    if (!isValidContentType(type)) throw new PackError(`invalid content type for ${file.path}: ${type}`);
    bytes += file.bytes.length;
    if (bytes > limits.maxSiteBytes) throw new PackError(`site is larger than ${limits.maxSiteBytes} bytes`);

    const named = options.external?.[file.path];
    if (named) {
      const ext = { npm: named.npm, version: named.version, path: named.path, integrity: integrityOf(file.bytes) };
      if (!isExternalAsset(ext)) throw new PackError(`bad external asset for ${file.path}: give an npm package, an exact version and a path`);
      if (named.integrity !== undefined && named.integrity !== ext.integrity) throw new PackError(`${file.path} does not match the integrity given for ${named.npm}@${named.version}/${named.path}`);
      entries[file.path] = { type, size: file.bytes.length, sha256: sha256Hex(file.bytes), parts: [], ext };
      continue;
    }

    let stored = file.bytes;
    let enc: 'gzip' | 'br' | undefined;
    if (file.bytes.length > 0 && isCompressible(type)) {
      const compressed = gzip(file.bytes);
      if (compressed.length < file.bytes.length) {
        stored = compressed;
        enc = 'gzip';
      }
      const br = options.brotli?.(file.bytes);
      if (br && br.length < stored.length) {
        stored = br;
        enc = 'br';
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

  for (const path of Object.keys(options.external ?? {})) {
    if (!entries[path]?.ext) throw new PackError(`external asset ${path} is not a file of the site`);
  }
  const v2 = Object.values(entries).some((entry) => entry.ext || entry.enc === 'br');
  const manifest: Manifest = { v: v2 ? 2 : 1, chunks: writer.table, files: entries, ...(options.spa ? { spa: true } : {}) };
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
    stats: { files: sorted.length, bytes, storedBytes, chunks: chunks.size },
  };
}
