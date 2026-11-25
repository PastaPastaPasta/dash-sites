import { sha384 } from '@noble/hashes/sha2.js';
import { base64 } from '@scure/base';

/**
 * A file a site does not store: a file of a published npm package, named by exact version and
 * pinned by its SHA-384 (Subresource Integrity form). The hash, in the manifest the owner proved on
 * Platform, is what is trusted; the CDNs below only carry the bytes, and bytes that do not match
 * are never served.
 */
export interface ExternalAsset {
  /** Package name, e.g. `@dashevo/wasm-sdk`. */
  npm: string;
  /** Exact version, e.g. `5.0.0-rc.8`: never a range or a tag. */
  version: string;
  /** File inside the package, e.g. `dist/raw/wasm_sdk_bg.wasm`. */
  path: string;
  /** `sha384-<base64>` of the file's bytes. */
  integrity: string;
}

/** The npm CDNs an external asset is fetched from, in order. Nothing else is ever contacted for one. */
export const EXTERNAL_ORIGINS = ['https://cdn.jsdelivr.net', 'https://unpkg.com'] as const;

const NPM_NAME = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const PRERELEASE_ID = '(0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)';
const EXACT_VERSION = new RegExp(`^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(-${PRERELEASE_ID}(\\.${PRERELEASE_ID})*)?$`);
/** A file of the package as published: no `+` segments (jsDelivr's generated `/+esm` and the like). */
const PATH_SEGMENT = /^[A-Za-z0-9._@-][A-Za-z0-9._@+-]*$/;
const INTEGRITY = /^sha384-[A-Za-z0-9+/]{64}$/;

export function isExternalAsset(value: unknown): value is ExternalAsset {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const asset = value as Record<string, unknown>;
  if (Object.keys(asset).some((key) => !['npm', 'version', 'path', 'integrity'].includes(key))) return false;
  const { npm, version, path, integrity } = asset;
  return (
    typeof npm === 'string' &&
    npm.length <= 214 &&
    NPM_NAME.test(npm) &&
    typeof version === 'string' &&
    version.length <= 64 &&
    EXACT_VERSION.test(version) &&
    typeof path === 'string' &&
    path.length <= 256 &&
    path.split('/').every((segment) => PATH_SEGMENT.test(segment) && segment !== '.' && segment !== '..') &&
    typeof integrity === 'string' &&
    INTEGRITY.test(integrity)
  );
}

function sri(digest: Uint8Array): string {
  return `sha384-${base64.encode(digest)}`;
}

export function integrityOf(bytes: Uint8Array): string {
  return sri(sha384(bytes));
}

/** {@link integrityOf} with the platform's native SHA-384 where there is one: a large file is hashed on every load. */
export async function integrityOfAsync(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return integrityOf(bytes);
  return sri(new Uint8Array(await subtle.digest('SHA-384', bytes as BufferSource)));
}

export function externalUrls(asset: ExternalAsset): string[] {
  const spec = `${asset.npm}@${asset.version}/${asset.path}`;
  return [`${EXTERNAL_ORIGINS[0]}/npm/${spec}`, `${EXTERNAL_ORIGINS[1]}/${spec}`];
}

/** Returns an external asset's bytes, already checked against its integrity, or throws. */
export type ExternalSource = (asset: ExternalAsset, size: number) => Promise<Uint8Array>;

export class ExternalAssetError extends Error {
  /** True when some CDN answered with bytes that did not match. */
  readonly mismatch: boolean;
  /** True when every CDN answered that it has no such file (the version was unpublished, say). */
  readonly missing: boolean;

  constructor(
    readonly asset: ExternalAsset,
    readonly attempts: string[],
  ) {
    super(`${asset.npm}@${asset.version}/${asset.path} could not be fetched with the published hash (${attempts.join('; ')})`);
    this.name = 'ExternalAssetError';
    this.mismatch = attempts.some((attempt) => attempt.endsWith('hash mismatch') || attempt.endsWith('wrong size'));
    this.missing = !this.mismatch && attempts.length > 0 && attempts.every((attempt) => /HTTP (404|410)$/.test(attempt));
  }
}

/** A CDN gets this long to answer with headers, and this long between two parts of the body, before the next CDN is tried. */
export const EXTERNAL_HEADERS_TIMEOUT_MS = 15_000;
export const EXTERNAL_IDLE_TIMEOUT_MS = 30_000;

class StalledError extends Error {}

function withTimeout<T>(work: Promise<T>, ms: number, onTimeout: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stalled = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onTimeout();
      reject(new StalledError(`no answer within ${ms / 1000} s`));
    }, ms);
  });
  return Promise.race([work, stalled]).finally(() => clearTimeout(timer));
}

async function readCapped(response: Response, size: number, idleMs = EXTERNAL_IDLE_TIMEOUT_MS): Promise<Uint8Array | undefined> {
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    return bytes.length === size ? bytes : undefined;
  }
  const out = new Uint8Array(size);
  let at = 0;
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await withTimeout(reader.read(), idleMs, () => void reader.cancel().catch(() => undefined));
    if (done) break;
    if (at + value.length > size) {
      await reader.cancel().catch(() => undefined);
      return undefined;
    }
    out.set(value, at);
    at += value.length;
  }
  return at === size ? out : undefined;
}

type Fetched = { bytes: Uint8Array } | { status: number } | { failure: 'wrong size' | 'hash mismatch' };

/**
 * One CDN request for an external asset: the bytes only when they have exactly `size` bytes and
 * match the asset's integrity. Redirects are refused, so a response can only come from `url`'s origin.
 */
export interface ExternalTimeouts {
  headersMs?: number;
  idleMs?: number;
}

async function fetchChecked(fetchImpl: typeof fetch, url: string, asset: ExternalAsset, size: number, timeouts: ExternalTimeouts = {}): Promise<Fetched> {
  const abort = new AbortController();
  const response = await withTimeout(
    fetchImpl(url, { redirect: 'error', credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store', signal: abort.signal }),
    timeouts.headersMs ?? EXTERNAL_HEADERS_TIMEOUT_MS,
    () => abort.abort(),
  );
  if (!response.ok) return { status: response.status };
  const bytes = await readCapped(response, size, timeouts.idleMs);
  if (!bytes) return { failure: 'wrong size' };
  if ((await integrityOfAsync(bytes)) !== asset.integrity) return { failure: 'hash mismatch' };
  return { bytes };
}

function errorText(error: unknown): string {
  return String((error as Error)?.message ?? error);
}

/** Fetches an external asset from each CDN in turn and returns the first copy whose SHA-384 matches. */
export function cdnSource(fetchImpl: typeof fetch = (input, init) => fetch(input, init), timeouts: ExternalTimeouts = {}): ExternalSource {
  return async (asset, size) => {
    const attempts: string[] = [];
    for (const url of externalUrls(asset)) {
      const origin = new URL(url).origin;
      try {
        const fetched = await fetchChecked(fetchImpl, url, asset, size, timeouts);
        if ('bytes' in fetched) return fetched.bytes;
        attempts.push(`${origin}: ${'status' in fetched ? `HTTP ${fetched.status}` : fetched.failure}`);
      } catch (error) {
        attempts.push(`${origin}: ${errorText(error)}`);
      }
    }
    throw new ExternalAssetError(asset, attempts);
  };
}

export interface ExternalCheck {
  path: string;
  url: string;
  result: 'ok' | 'mismatch' | 'unreachable';
  detail?: string;
}

/**
 * Before publishing: fetches every external asset of a manifest from every CDN. The site is safe
 * to publish only if each CDN serves each file with its integrity, so a file one CDN generates on
 * the fly (and could change) is caught here rather than by readers later.
 */
export async function checkExternalAssets(
  files: Record<string, { size: number; ext?: ExternalAsset }>,
  fetchImpl: typeof fetch = (input, init) => fetch(input, init),
): Promise<ExternalCheck[]> {
  const out: ExternalCheck[] = [];
  for (const [path, file] of Object.entries(files)) {
    if (!file.ext) continue;
    for (const url of externalUrls(file.ext)) {
      try {
        const fetched = await fetchChecked(fetchImpl, url, file.ext, file.size);
        if ('status' in fetched) {
          out.push({ path, url, result: fetched.status === 404 ? 'mismatch' : 'unreachable', detail: `HTTP ${fetched.status}` });
        } else {
          out.push({ path, url, result: 'bytes' in fetched ? 'ok' : 'mismatch' });
        }
      } catch (error) {
        out.push({ path, url, result: 'unreachable', detail: errorText(error) });
      }
    }
  }
  return out;
}
