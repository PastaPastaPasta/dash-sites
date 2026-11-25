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

export function integrityOf(bytes: Uint8Array): string {
  return `sha384-${base64.encode(sha384(bytes))}`;
}

/** {@link integrityOf} with the platform's native SHA-384 where there is one: a large file is hashed on every load. */
export async function integrityOfAsync(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return integrityOf(bytes);
  return `sha384-${base64.encode(new Uint8Array(await subtle.digest('SHA-384', bytes as BufferSource)))}`;
}

export function externalUrls(asset: ExternalAsset): string[] {
  const spec = `${asset.npm}@${asset.version}/${asset.path}`;
  return [`${EXTERNAL_ORIGINS[0]}/npm/${spec}`, `${EXTERNAL_ORIGINS[1]}/${spec}`];
}

/** Returns an external asset's bytes, already checked against its integrity, or throws. */
export type ExternalSource = (asset: ExternalAsset, size: number) => Promise<Uint8Array>;

export class ExternalAssetError extends Error {
  /** True when some CDN answered with bytes that did not match, false when none could be reached. */
  readonly mismatch: boolean;

  constructor(
    readonly asset: ExternalAsset,
    readonly attempts: string[],
  ) {
    super(`${asset.npm}@${asset.version}/${asset.path} could not be fetched with the published hash (${attempts.join('; ')})`);
    this.name = 'ExternalAssetError';
    this.mismatch = attempts.some((attempt) => attempt.endsWith('hash mismatch') || attempt.endsWith('wrong size'));
  }
}

async function readCapped(response: Response, size: number): Promise<Uint8Array | undefined> {
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    return bytes.length === size ? bytes : undefined;
  }
  const out = new Uint8Array(size);
  let at = 0;
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
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

/**
 * Fetches an external asset from each CDN in turn and returns the first copy whose SHA-384 matches.
 * Redirects are refused, so a response can only come from the origins listed above.
 */
export function cdnSource(fetchImpl: typeof fetch = (input, init) => fetch(input, init)): ExternalSource {
  return async (asset, size) => {
    const attempts: string[] = [];
    for (const url of externalUrls(asset)) {
      const origin = new URL(url).origin;
      try {
        const response = await fetchImpl(url, { redirect: 'error', credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store' });
        if (!response.ok) {
          attempts.push(`${origin}: HTTP ${response.status}`);
          continue;
        }
        const bytes = await readCapped(response, size);
        if (!bytes) {
          attempts.push(`${origin}: wrong size`);
          continue;
        }
        if ((await integrityOfAsync(bytes)) !== asset.integrity) {
          attempts.push(`${origin}: hash mismatch`);
          continue;
        }
        return bytes;
      } catch (error) {
        attempts.push(`${origin}: ${String((error as Error)?.message ?? error)}`);
      }
    }
    throw new ExternalAssetError(asset, attempts);
  };
}

/**
 * Before publishing: fetches every external asset of a manifest from every CDN. The site is safe
 * to publish only if each CDN serves each file with its integrity, so a file one CDN generates on
 * the fly (and could change) is caught here rather than by readers later.
 */
export async function checkExternalAssets(
  files: Record<string, { size: number; ext?: ExternalAsset }>,
  fetchImpl: typeof fetch = (input, init) => fetch(input, init),
): Promise<Array<{ path: string; url: string; result: 'ok' | 'mismatch' | 'unreachable'; detail?: string }>> {
  const out: Array<{ path: string; url: string; result: 'ok' | 'mismatch' | 'unreachable'; detail?: string }> = [];
  for (const [path, file] of Object.entries(files)) {
    if (!file.ext) continue;
    for (const url of externalUrls(file.ext)) {
      try {
        const response = await fetchImpl(url, { redirect: 'error', credentials: 'omit', cache: 'no-store' });
        if (!response.ok) {
          out.push({ path, url, result: response.status === 404 ? 'mismatch' : 'unreachable', detail: `HTTP ${response.status}` });
          continue;
        }
        const bytes = await readCapped(response, file.size);
        const ok = bytes !== undefined && (await integrityOfAsync(bytes)) === file.ext.integrity;
        out.push({ path, url, result: ok ? 'ok' : 'mismatch' });
      } catch (error) {
        out.push({ path, url, result: 'unreachable', detail: String((error as Error)?.message ?? error) });
      }
    }
  }
  return out;
}
