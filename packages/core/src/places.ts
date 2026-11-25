import { sha256Hex, toHex } from './bytes.js';
import { MAX_PLACE_LENGTH } from './limits.js';

/**
 * A place is where a file kept outside Platform can be fetched, written as a URI. The manifest
 * holds the file's size and SHA-256, so a place is relied on to answer, never trusted for content.
 */
export type Place = { kind: 'https'; uri: string } | { kind: 'ipfs'; uri: string; cid: string; path: string };
export type PlaceKind = Place['kind'];

const URI = /^[a-z][a-z0-9+.-]*:[\x21-\x7e]+$/;
const CID = /^[a-zA-Z0-9]{46,128}$/;
const IPFS = /^ipfs:\/\/([^/?#]+)((?:\/[^?#]*)?)$/;

/** Whether a manifest may list `value`: any URI, including kinds this version cannot fetch. */
export function isPlaceUri(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_PLACE_LENGTH && URI.test(value);
}

/** Returns undefined for a place this version does not fetch. */
export function parsePlace(uri: string): Place | undefined {
  if (!isPlaceUri(uri)) return undefined;
  if (uri.startsWith('https://')) {
    let url: URL;
    try {
      url = new URL(uri);
    } catch {
      return undefined;
    }
    if (url.protocol !== 'https:' || url.hostname === '' || url.username !== '' || url.password !== '' || !isPlaceUri(url.href)) return undefined;
    return { kind: 'https', uri: url.href };
  }
  const ipfs = IPFS.exec(uri);
  if (ipfs && CID.test(ipfs[1] as string)) return { kind: 'ipfs', uri, cid: ipfs[1] as string, path: ipfs[2] as string };
  return undefined;
}

/** Fetches one kind of place. It returns at most `size` bytes and throws when it cannot. */
export type PlaceFetcher = (uri: string, size: number) => Promise<Uint8Array>;
export type PlaceFetchers = Partial<Record<PlaceKind, PlaceFetcher>>;

export interface PlaceAttempt {
  place: string;
  problem: string;
}

export const UNKNOWN_PLACE = 'this version does not load this kind of place';
export const WRONG_BYTES = 'what it serves is not the file that was published';

/** SHA-256 through the platform's own implementation where there is one: these files run to tens of megabytes. */
export async function digestHex(data: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  return subtle ? toHex(new Uint8Array(await subtle.digest('SHA-256', data as BufferSource))) : sha256Hex(data);
}

export const matchesFile = async (bytes: Uint8Array, file: { size: number; sha256: string }): Promise<boolean> =>
  bytes.length === file.size && (await digestHex(bytes)) === file.sha256;

/** Asks one place for a file and reports what was wrong, or undefined when it served the file. */
export async function tryPlace(
  uri: string,
  file: { size: number; sha256: string },
  fetchers: PlaceFetchers,
): Promise<{ bytes: Uint8Array } | { problem: string }> {
  const place = parsePlace(uri);
  const fetcher = place && fetchers[place.kind];
  if (!place || !fetcher) return { problem: UNKNOWN_PLACE };
  try {
    const bytes = await fetcher(place.uri, file.size);
    return (await matchesFile(bytes, file)) ? { bytes } : { problem: WRONG_BYTES };
  } catch (error) {
    return { problem: String((error as Error)?.message ?? error) };
  }
}

/** A download slower than this on average is given up, so a place cannot hold a request open for good. */
const SLOWEST_BYTES_PER_SECOND = 32 * 1024;

/** Reads `body` into a buffer of `size` bytes, giving up when it is longer, stalls for `idleMs` or crawls. */
export async function readCapped(body: ReadableStream<Uint8Array>, size: number, idleMs: number, abort?: () => void): Promise<Uint8Array> {
  const reader = body.getReader();
  const deadline = Date.now() + idleMs + (size / SLOWEST_BYTES_PER_SECOND) * 1000;
  let loaded = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const bytes = new Uint8Array(size);
    for (;;) {
      const stalled = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('the download stalled')), idleMs);
      });
      const { done, value } = await Promise.race([reader.read(), stalled]);
      clearTimeout(timer);
      if (done) return bytes.subarray(0, loaded);
      if (loaded + value.length > size) throw new Error('it serves more bytes than the file that was published');
      if (Date.now() > deadline) throw new Error('the download was too slow');
      bytes.set(value, loaded);
      loaded += value.length;
    }
  } catch (error) {
    clearTimeout(timer);
    await reader.cancel().catch(() => undefined);
    abort?.();
    throw error;
  }
}

export const PLACE_IDLE_MS = 30_000;

/**
 * Runs a fetch-like call for a place and reads its answer. The call gets `waitMs` to answer, whether
 * or not it honours the signal, so one place that hangs cannot keep the next from being tried.
 */
async function download(call: (signal: AbortSignal) => Promise<Response>, size: number, waitMs: number, idleMs: number): Promise<Uint8Array> {
  const stop = new AbortController();
  let waiting: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_resolve, reject) => {
    waiting = setTimeout(() => {
      stop.abort();
      reject(new Error('it did not answer'));
    }, waitMs);
  });
  let response: Response;
  try {
    const answer = call(stop.signal);
    answer.catch(() => undefined);
    response = await Promise.race([answer, late]);
  } catch (error) {
    throw new Error(stop.signal.aborted ? 'it did not answer' : `it could not be reached (${String((error as Error)?.message ?? error)})`);
  } finally {
    clearTimeout(waiting);
  }
  if (!response.ok || !response.body) {
    stop.abort();
    throw new Error(`it answered ${response.status}`);
  }
  return readCapped(response.body, size, idleMs, () => stop.abort());
}

/**
 * Fetches an HTTPS place: a plain GET that sends no cookies and no referrer. Redirects are followed,
 * because some hosts answer every file with one, and that is safe when the bytes are checked.
 */
export function httpsFetcher(options: { fetch?: typeof fetch; idleMs?: number } = {}): PlaceFetcher {
  const idleMs = options.idleMs ?? PLACE_IDLE_MS;
  return (uri, size) =>
    download((signal) => (options.fetch ?? fetch)(uri, { credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'follow', signal }), size, idleMs, idleMs);
}

/** Fetches IPFS content by CID and checks it against the CID. `@helia/verified-fetch` provides one. */
export type VerifiedFetch = (resource: string, init?: { signal?: AbortSignal }) => Promise<Response>;

export const IPFS_WAIT_MS = 60_000;

/** Fetches an IPFS place through `load`, which starts the IPFS client the first time it is needed. */
export function ipfsFetcher(load: () => Promise<VerifiedFetch>, options: { waitMs?: number; idleMs?: number } = {}): PlaceFetcher {
  return (uri, size) => download(async (signal) => (await load())(uri, { signal }), size, options.waitMs ?? IPFS_WAIT_MS, options.idleMs ?? PLACE_IDLE_MS);
}
