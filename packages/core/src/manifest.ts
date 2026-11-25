import { isHash, utf8 } from './bytes.js';
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
  /** How the stored bytes are encoded. `gzip` is the only encoding this version reads. */
  enc?: string;
  parts: Part[];
  /** Places outside Platform that hold the file, as URIs, tried in order. The file then has no parts. */
  src?: string[];
}

/**
 * Version 2 adds `src`. A version 2 reader ignores keys it does not know, skips places whose kind it
 * does not know, and refuses only the files whose encoding it does not know, so later additions
 * leave older readers serving everything they still understand. A change they must not ignore
 * raises the version.
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

function validatePlaces(value: unknown, path: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_PLACES) throw new ManifestError(`bad src in ${path}`);
  if (!value.every(isPlaceUri)) throw new ManifestError(`bad place in ${path}`);
  if (new Set(value).size !== value.length) throw new ManifestError(`duplicate place in ${path}`);
  return [...(value as string[])];
}

export function validateManifest(input: unknown, limits: Limits = DEFAULT_LIMITS): Manifest {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new ManifestError('not an object');
  const raw = input as Record<string, unknown>;
  if (raw.v !== 1 && raw.v !== 2) throw new ManifestError('unsupported version');
  const strict = raw.v === 1;
  for (const key of Object.keys(raw)) {
    if (strict && !['v', 'chunks', 'files', 'spa'].includes(key)) throw new ManifestError(`unknown key ${key}`);
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
      if (strict && !['type', 'size', 'sha256', 'enc', 'parts'].includes(key)) throw new ManifestError(`unknown key ${key} in ${path}`);
    }
    if (typeof file.type !== 'string' || !isValidContentType(file.type)) throw new ManifestError(`bad type in ${path}`);
    if (!isUint(file.size)) throw new ManifestError(`bad size in ${path}`);
    if (!isHash(file.sha256)) throw new ManifestError(`bad sha256 in ${path}`);
    if (file.enc !== undefined && (strict ? file.enc !== 'gzip' : typeof file.enc !== 'string' || !ENCODING.test(file.enc))) throw new ManifestError(`bad enc in ${path}`);
    if (!Array.isArray(file.parts)) throw new ManifestError(`bad parts in ${path}`);
    if (file.src !== undefined) {
      const src = validatePlaces(file.src, path);
      if (file.parts.length > 0 || file.enc !== undefined) throw new ManifestError(`${path} is stored elsewhere and also on Platform`);
      if (file.size === 0 || file.size > MAX_ELSEWHERE_FILE_BYTES) throw new ManifestError(`bad size in ${path}`);
      out[path] = { type: file.type, size: file.size, sha256: file.sha256, parts: [], src };
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
    if (file.enc === undefined && stored !== file.size) throw new ManifestError(`size mismatch in ${path}`);
    if (stored > limits.maxSiteBytes) throw new ManifestError(`file too large: ${path}`);
    total += file.size;
    if (total > limits.maxSiteBytes) throw new ManifestError('site too large');
    out[path] = { type: file.type, size: file.size, sha256: file.sha256, parts, ...(file.enc ? { enc: file.enc as string } : {}) };
  }
  return { v: raw.v, chunks: chunks as string[], files: out, ...(raw.spa ? { spa: true } : {}) };
}

/** Canonical form: keys sorted, no whitespace, UTF-8. */
export function encodeManifest(manifest: Manifest): Uint8Array {
  return utf8.encode(JSON.stringify(sortKeys(validateManifest(manifest))));
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
