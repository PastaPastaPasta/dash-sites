import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  fetchPinned,
  httpsFetcher,
  ipfsFetcher,
  IPFS_MODULE,
  isValidPath,
  matchesFile,
  MAX_ELSEWHERE_FILE_BYTES,
  parsePlace,
  sha256Hex,
  startIpfs,
  tryPlace,
  UNKNOWN_PLACE,
  type PlaceFetchers,
  type SiteFile,
  type VerifiedFetch,
} from '@dash-sites/core';

const cacheDir = (): string => join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'dash-sites');

/** The IPFS client, downloaded from npm once and checked against its pinned hash on every start. */
async function ipfsModule(): Promise<Uint8Array> {
  const path = join(cacheDir(), `${IPFS_MODULE.sha256}.js`);
  const kept = await readFile(path).then(
    (data) => new Uint8Array(data),
    () => undefined,
  );
  if (kept && (await matchesFile(kept, IPFS_MODULE))) return kept;
  const source = await fetchPinned(IPFS_MODULE);
  await mkdir(cacheDir(), { recursive: true })
    .then(() => writeFile(`${path}.tmp`, source))
    .then(() => rename(`${path}.tmp`, path))
    .catch(() => undefined);
  return source;
}

export interface CliPlaces {
  fetchers: PlaceFetchers;
  /** Whether the IPFS client was started; it keeps connections open, so the process must be ended. */
  ipfsStarted(): boolean;
}

/**
 * Fetches places the way a visitor's browser will. A browser reads another site's file only when
 * that site allows it, so an HTTPS place that does not say so is reported here, before publishing.
 */
export function cliPlaces(origin: string): CliPlaces {
  let ipfs: Promise<VerifiedFetch> | undefined;
  const https = async (uri: string, size: number): Promise<Uint8Array> => {
    let readable = true;
    const asBrowser: typeof fetch = async (input, init) => {
      const response = await fetch(input, { ...init, headers: { Origin: origin } });
      const allowed = response.headers.get('access-control-allow-origin');
      readable = allowed === '*' || allowed === origin;
      return response;
    };
    const bytes = await httpsFetcher({ fetch: asBrowser })(uri, size);
    if (!readable) throw new Error('it does not let other sites read it: it must answer with Access-Control-Allow-Origin: *');
    return bytes;
  };
  return {
    fetchers: {
      https,
      ipfs: ipfsFetcher(() => (ipfs ??= ipfsModule().then((source) => startIpfs(source)))),
    },
    ipfsStarted: () => ipfs !== undefined,
  };
}

export function parsePlaceMap(input: unknown): Map<string, string[]> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new Error('--elsewhere needs a JSON object of site paths to lists of places');
  const out = new Map<string, string[]>();
  for (const [key, value] of Object.entries(input)) {
    const path = key.startsWith('/') ? key : `/${key}`;
    const places = typeof value === 'string' ? [value] : value;
    if (!isValidPath(path)) throw new Error(`--elsewhere: ${key} is not a site path`);
    if (!Array.isArray(places) || places.length === 0 || !places.every((place) => typeof place === 'string')) throw new Error(`--elsewhere: ${key} needs a place or a list of places`);
    out.set(path, places as string[]);
  }
  return out;
}

export type Report = (line: string) => void;

/**
 * Marks the files of `map` as stored elsewhere, after making sure every place listed for a file
 * serves it. A file that is not in the folder is downloaded from its first place that answers, and
 * what that place serves becomes the file.
 */
export async function storeElsewhere(files: SiteFile[], map: Map<string, string[]>, fetchers: PlaceFetchers, report: Report): Promise<SiteFile[]> {
  const byPath = new Map(files.map((file) => [file.path, file]));
  const problems: string[] = [];
  for (const [path, places] of map) {
    let bytes = byPath.get(path)?.bytes;
    for (const place of places) {
      if (!bytes) {
        const result = await tryFirst(place, fetchers);
        if ('problem' in result) {
          problems.push(`${path}: ${place}: ${result.problem}`);
          continue;
        }
        bytes = result.bytes;
        report(`${path}: taken from ${place} (${bytes.length} bytes, sha256 ${sha256Hex(bytes)})`);
        continue;
      }
      const result = await tryPlace(place, { size: bytes.length, sha256: sha256Hex(bytes) }, fetchers);
      if ('problem' in result) problems.push(`${path}: ${place}: ${result.problem}`);
      else report(`${path}: ${place} serves it`);
    }
    if (bytes) byPath.set(path, { ...byPath.get(path), path, bytes, src: places });
  }
  if (problems.length > 0) throw new Error(`not every place serves its file:\n  ${problems.join('\n  ')}`);
  return [...byPath.values()];
}

/** Downloads a file whose size and hash are not known yet. */
async function tryFirst(uri: string, fetchers: PlaceFetchers): Promise<{ bytes: Uint8Array } | { problem: string }> {
  const place = parsePlace(uri);
  const fetcher = place && fetchers[place.kind];
  if (!place || !fetcher) return { problem: UNKNOWN_PLACE };
  try {
    const bytes = await fetcher(place.uri, MAX_ELSEWHERE_FILE_BYTES);
    return bytes.length > 0 ? { bytes } : { problem: 'it serves an empty file' };
  } catch (error) {
    return { problem: String((error as Error)?.message ?? error) };
  }
}

/** Asks every place of every file stored elsewhere, and returns whether each file has one that serves it. */
export async function checkPlaces(files: Record<string, { size: number; sha256: string; src?: string[] }>, fetchers: PlaceFetchers, report: Report): Promise<boolean> {
  let good = true;
  for (const [path, file] of Object.entries(files).sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (!file.src) continue;
    let serving = 0;
    for (const place of file.src) {
      const result = await tryPlace(place, file, fetchers);
      if ('bytes' in result) serving += 1;
      report(`${'bytes' in result ? 'ok  ' : 'FAIL'} ${path}  ${place}${'problem' in result ? `  (${result.problem})` : ''}`);
    }
    if (serving === 0) good = false;
  }
  return good;
}
