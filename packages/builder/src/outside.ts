import { parsePlace, sha256Hex, type SiteFile } from '@dash-sites/core';
import { quietly, type KeyValue } from './wallet.js';

/**
 * Which files the owner keeps outside Platform, and where. Places are remembered by the file's
 * hash, so they follow the bytes: change the file and it is stored on Platform again until its
 * new version has a place of its own.
 */
const KEY = 'dash-sites.outside';
const REMEMBERED = 300;

const hashes = new WeakMap<Uint8Array, string>();
const listeners = new Set<() => void>();
let kept = new Map<string, string[]>();
let storage: KeyValue | undefined;

export function fileHash(bytes: Uint8Array): string {
  let hash = hashes.get(bytes);
  if (!hash) {
    hash = sha256Hex(bytes);
    hashes.set(bytes, hash);
  }
  return hash;
}

export function readOutside(saved: unknown): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (saved === null || typeof saved !== 'object' || Array.isArray(saved)) return out;
  for (const [hash, places] of Object.entries(saved)) {
    if (!/^[0-9a-f]{64}$/.test(hash) || !Array.isArray(places)) continue;
    const known = places.flatMap((place) => {
      const parsed = typeof place === 'string' ? parsePlace(place) : undefined;
      return parsed ? [parsed.uri] : [];
    });
    if (known.length > 0) out.set(hash, [...new Set(known)]);
  }
  return out;
}

export function loadOutside(from: KeyValue | undefined): void {
  storage = from;
  kept = readOutside(quietly(() => JSON.parse(storage?.getItem(KEY) ?? 'null') as unknown));
}

export function outsidePlaces(bytes: Uint8Array): string[] {
  return kept.get(fileHash(bytes)) ?? [];
}

/** Sets where a file is kept; an empty list stores it on Platform again. */
export function setOutsidePlaces(bytes: Uint8Array, places: string[], hash = fileHash(bytes)): void {
  kept.delete(hash);
  if (places.length > 0) kept.set(hash, [...new Set(places)]);
  while (kept.size > REMEMBERED) kept.delete(kept.keys().next().value as string);
  quietly(() => storage?.setItem(KEY, JSON.stringify(Object.fromEntries(kept))));
  for (const listener of listeners) listener();
}

/** Adds the places the owner's own published site lists for a file, by hash, to any already known. */
export function rememberOutside(hash: string, places: string[]): void {
  setOutsidePlaces(new Uint8Array(0), [...(kept.get(hash) ?? []), ...places], hash);
}

/** The same files, with the ones kept outside Platform marked so that they are not stored on it. */
export function keepOutside(files: SiteFile[]): SiteFile[] {
  if (kept.size === 0) return files;
  return files.map((file) => {
    const places = file.bytes.length > 0 ? kept.get(fileHash(file.bytes)) : undefined;
    return places ? { ...file, src: places } : file;
  });
}

export function onOutsideChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
