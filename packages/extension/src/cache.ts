import { normalizeLabel, type Manifest, type Network, type Resolution } from '@dash-sites/core';
import type { SiteFile } from './render.js';

/** A site the background worker read and checked, kept for every tab and across restarts. */
export interface CachedSite {
  key: string;
  network: Network;
  resolution: Extract<Resolution, { status: 'ok' }>;
  manifest: Manifest;
  files: SiteFile[];
  /** Files the manifest lists that are stored outside Dash Platform, which this extension does not load. */
  skipped: string[];
  /** When Dash Platform last proved this record is the name's current site (wall clock, ms). */
  checkedAt: number;
  usedAt: number;
}

const DB = 'dash-sites';
const STORE = 'sites';
const MAX_SITES = 40;

export const siteKey = (network: Network, label: string): string => `${network}:${normalizeLabel(label)}`;

let db: Promise<IDBDatabase> | undefined;
function open(): Promise<IDBDatabase> {
  db ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: 'key' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('could not open the site cache'));
  });
  db.catch(() => {
    db = undefined;
  });
  return db;
}

function run<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T> | undefined): Promise<T | undefined> {
  return open().then(
    (database) =>
      new Promise<T | undefined>((resolve, reject) => {
        const transaction = database.transaction(STORE, mode);
        const request = work(transaction.objectStore(STORE));
        transaction.oncomplete = () => resolve(request?.result);
        transaction.onerror = () => reject(transaction.error ?? new Error('site cache transaction failed'));
        transaction.onabort = () => reject(transaction.error ?? new Error('site cache transaction aborted'));
      }),
  );
}

export async function getSite(key: string): Promise<CachedSite | undefined> {
  try {
    return (await run<CachedSite>('readonly', (store) => store.get(key))) ?? undefined;
  } catch {
    return undefined;
  }
}

/** Stores a site, then drops the least recently used beyond `MAX_SITES`. */
export async function putSite(site: CachedSite): Promise<void> {
  await run('readwrite', (store) => store.put(site));
  const all = (await run<CachedSite[]>('readonly', (store) => store.getAll())) ?? [];
  const extra = all.sort((a, b) => b.usedAt - a.usedAt).slice(MAX_SITES);
  if (extra.length > 0) {
    await run('readwrite', (store) => {
      for (const old of extra) store.delete(old.key);
      return undefined;
    });
  }
}

export async function clearSites(): Promise<void> {
  await run('readwrite', (store) => store.clear());
}

export async function deleteSite(key: string): Promise<void> {
  await run('readwrite', (store) => store.delete(key));
}
