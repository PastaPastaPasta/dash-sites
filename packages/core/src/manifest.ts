import { isHash, utf8 } from './bytes.js';
import { isExternalAsset, type ExternalAsset } from './external.js';
import {
  CHUNK_SIZE,
  DEFAULT_LIMITS,
  MAX_ELSEWHERE_FILE_BYTES,
  MAX_PATH_BYTES,
  MAX_PLACES,
  MAX_SITE_CHUNKS,
  MAX_TYPE_LENGTH,
  type Limits,
} from './limits.js';
import { isPlaceUri } from './places.js';

/** `[chunkIndex, offset, length]`: a slice of one chunk. */
export type Part = [number, number, number];

export interface ManifestFile {
  type: string;
  /** Length of the decoded file. */
  size: number;
  /** sha256 of the decoded file, hex. */
  sha256: string;
  /** How the stored bytes are compressed: gzip, or brotli (manifest version 2). A reader refuses a file whose encoding it does not know. */
  enc?: string;
  parts: Part[];
  /** Manifest version 2: a file of a published npm package that the site does not store. `parts` is empty. */
  ext?: ExternalAsset;
  /** Manifest version 2: places outside Platform that hold the file, as URIs, tried in order. `parts` is empty. */
  src?: string[];
  /** Set by a reader for an entry it cannot serve, with the reason. Never written. */
  unread?: string;
}

/**
 * Version 1 is every manifest published before files kept outside Platform and brotli. A manifest
 * that uses either is version 2, so readers that only know version 1 refuse it as a whole, and
 * older collectors that cannot read it delete nothing.
 *
 * A version 2 reader ignores keys it does not know, skips places whose kind it does not know, and
 * refuses only the files it cannot read: an encoding it does not know, places in a form it does
 * not know, or bytes it has no parts for. Later additions so leave older readers serving
 * everything they still understand. A change they must not ignore raises the version.
 */
export interface Manifest {
  v: 1 | 2;
  chunks: string[];
  files: Record<string, ManifestFile>;
  spa?: boolean;
}

export class ManifestError extends Error {
  constructor(message: string) {
    super(`invalid manifest: ${message}`);
    this.name = 'ManifestError';
  }
}

const CONTENT_TYPE = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*(; ?[A-Za-z0-9-]+=[A-Za-z0-9._-]+)*$/;

export function isValidContentType(type: string): boolean {
  return type.length <= MAX_TYPE_LENGTH && CONTENT_TYPE.test(type);
}

/** A site path is absolute, has no empty, `.` or `..` segment, and no characters a URL path cannot carry literally. */
export function isValidPath(path: string): boolean {
  if (!path.startsWith('/') || path.length < 2) return false;
  if (utf8.encode(path).length > MAX_PATH_BYTES) return false;
  if (/[\u0000-\u001f\u007f\\?#%]/.test(path)) return false;
  return path
    .slice(1)
    .split('/')
    .every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

function isUint(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) out[key] = sortKeys((value as Record<string, unknown>)[key]);
    return out;
  }
  return value;
}

export function storedLength(file: ManifestFile): number {
  let total = 0;
  for (const part of file.parts) total += part[2];
  return total;
}

const ENCODING = /^[a-z0-9-]{1,16}$/;
const ENCODINGS = ['gzip', 'br'];

const UNREAD_PLACES = 'lists where it is stored in a form this version cannot read';
const UNREAD_BOTH = 'is stored in more than one way at once, which this version cannot read';
const UNREAD_SIZE = 'is empty, or larger than this version loads from outside Platform';
const UNREAD_PARTS = 'is stored in a form this version cannot read';

function placesProblem(file: Record<string, unknown>): string | undefined {
  const src = file.src;
  if (!Array.isArray(src) || src.length === 0 || src.length > MAX_PLACES || !src.every(isPlaceUri) || new Set(src).size !== src.length) return UNREAD_PLACES;
  if ((file.parts as unknown[]).length > 0 || file.enc !== undefined || file.ext !== undefined) return UNREAD_BOTH;
  if (file.size === 0 || (file.size as number) > MAX_ELSEWHERE_FILE_BYTES) return UNREAD_SIZE;
  return undefined;
}

/** Whether any file needs manifest version 2: one kept outside Platform, or brotli. */
export function usesVersion2(files: Record<string, ManifestFile>): boolean {
  return Object.values(files).some((file) => file.ext !== undefined || file.src !== undefined || file.enc === 'br');
}

export function validateManifest(input: unknown, limits: Limits = DEFAULT_LIMITS): Manifest {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new ManifestError('not an object');
  const raw = input as Record<string, unknown>;
  if (raw.v !== 1 && raw.v !== 2) throw new ManifestError('unsupported version');
  const strict = raw.v === 1;
  let later = false;
  for (const key of Object.keys(raw)) {
    if (['v', 'chunks', 'files', 'spa'].includes(key)) continue;
    if (strict) throw new ManifestError(`unknown key ${key}`);
    later = true;
  }
  if (raw.spa !== undefined && typeof raw.spa !== 'boolean') throw new ManifestError('spa is not a boolean');
  const chunks = raw.chunks;
  if (!Array.isArray(chunks) || chunks.length > MAX_SITE_CHUNKS) throw new ManifestError('bad chunk table');
  if (!chunks.every(isHash)) throw new ManifestError('bad chunk hash');
  if (new Set(chunks).size !== chunks.length) throw new ManifestError('duplicate chunk hash');

  const files = raw.files;
  if (files === null || typeof files !== 'object' || Array.isArray(files)) throw new ManifestError('files is not an object');
  const entries = Object.entries(files as Record<string, unknown>);
  if (entries.length > limits.maxFiles) throw new ManifestError('too many files');

  let total = 0;
  const out: Record<string, ManifestFile> = {};
  for (const [path, value] of entries) {
    if (!isValidPath(path)) throw new ManifestError(`bad path ${JSON.stringify(path)}`);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new ManifestError(`bad entry ${path}`);
    const file = value as Record<string, unknown>;
    for (const key of Object.keys(file)) {
      if (['type', 'size', 'sha256', 'enc', 'parts', ...(strict ? [] : ['ext', 'src'])].includes(key)) continue;
      if (strict) throw new ManifestError(`unknown key ${key} in ${path}`);
      later = true;
    }
    if (typeof file.type !== 'string' || !isValidContentType(file.type)) throw new ManifestError(`bad type in ${path}`);
    if (!isUint(file.size)) throw new ManifestError(`bad size in ${path}`);
    if (!isHash(file.sha256)) throw new ManifestError(`bad sha256 in ${path}`);
    if (file.enc !== undefined && (strict ? file.enc !== 'gzip' : typeof file.enc !== 'string' || !ENCODING.test(file.enc))) throw new ManifestError(`bad enc in ${path}`);
    if (file.ext !== undefined) {
      if (!isExternalAsset(file.ext)) throw new ManifestError(`bad ext in ${path}`);
      if (file.enc !== undefined || !Array.isArray(file.parts) || file.parts.length !== 0) throw new ManifestError(`ext with stored parts in ${path}`);
    }
    if (!Array.isArray(file.parts)) throw new ManifestError(`bad parts in ${path}`);
    const entry = { type: file.type, size: file.size, sha256: file.sha256, parts: [] };
    if (!strict && file.src !== undefined) {
      const unread = placesProblem(file);
      out[path] = unread ? { ...entry, unread } : { ...entry, src: [...(file.src as string[])] };
      continue;
    }
    const parts: Part[] = [];
    let stored = 0;
    for (const part of file.parts) {
      if (!Array.isArray(part) || part.length !== 3 || !part.every(isUint)) throw new ManifestError(`bad part in ${path}`);
      const [index, offset, length] = part as Part;
      if (index >= chunks.length || length === 0 || offset + length > CHUNK_SIZE) throw new ManifestError(`part out of range in ${path}`);
      parts.push([index, offset, length]);
      stored += length;
    }
    if (file.enc === undefined && file.ext === undefined && stored !== file.size) {
      if (strict) throw new ManifestError(`size mismatch in ${path}`);
      out[path] = { ...entry, unread: UNREAD_PARTS };
      continue;
    }
    if (stored > limits.maxSiteBytes) throw new ManifestError(`file too large: ${path}`);
    total += file.size;
    if (total > limits.maxSiteBytes) throw new ManifestError('site too large');
    const ext = file.ext as ExternalAsset | undefined;
    out[path] = {
      ...entry,
      parts,
      ...(file.enc ? { enc: file.enc as string } : {}),
      ...(ext ? { ext: { npm: ext.npm, version: ext.version, path: ext.path, integrity: ext.integrity } } : {}),
    };
  }
  const known = Object.values(out).every((file) => !file.unread && (file.enc === undefined || ENCODINGS.includes(file.enc)));
  if (!strict && !later && known && !usesVersion2(out)) throw new ManifestError('version 2 without a version 2 feature');
  return { v: raw.v, chunks: chunks as string[], files: out, ...(raw.spa ? { spa: true } : {}) };
}

/** Canonical form: keys sorted, no whitespace, UTF-8. */
export function encodeManifest(manifest: Manifest): Uint8Array {
  const valid = validateManifest(manifest);
  for (const [path, file] of Object.entries(valid.files)) {
    const unread = manifest.files[path]?.unread ?? file.unread;
    if (unread) throw new ManifestError(`${path} ${unread}`);
    if (file.enc !== undefined && !ENCODINGS.includes(file.enc)) throw new ManifestError(`bad enc in ${path}`);
  }
  return utf8.encode(JSON.stringify(sortKeys(valid)));
}

export function decodeManifest(bytes: Uint8Array, limits: Limits = DEFAULT_LIMITS): Manifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(utf8.decode(bytes));
  } catch {
    throw new ManifestError('not UTF-8 JSON');
  }
  const manifest = validateManifest(parsed, limits);
  const canonical = manifest.v === 1 ? encodeManifest(manifest) : utf8.encode(JSON.stringify(sortKeys(parsed)));
  if (canonical.length !== bytes.length || canonical.some((byte, i) => byte !== bytes[i])) throw new ManifestError('not in canonical form');
  return manifest;
}
