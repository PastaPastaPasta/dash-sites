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

/** What is read and written on every check and eviction: small, without the files. */
type Meta = Pick<CachedSite, 'key' | 'network' | 'resolution' | 'checkedAt' | 'usedAt'>;
type Content = Pick<CachedSite, 'key' | 'manifest' | 'files' | 'skipped'>;

const DB = 'dash-sites';
const META = 'meta';
const CONTENT = 'content';
const MAX_SITES = 40;

export const siteKey = (network: Network, label: string): string => `${network}:${normalizeLabel(label)}`;

let db: Promise<IDBDatabase> | undefined;
function open(): Promise<IDBDatabase> {
  db ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB, 2);
    request.onupgradeneeded = () => {
      const database = request.result;
      for (const name of [...database.objectStoreNames]) database.deleteObjectStore(name);
      database.createObjectStore(META, { keyPath: 'key' });
      database.createObjectStore(CONTENT, { keyPath: 'key' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('could not open the site cache'));
  });
  db.catch(() => {
    db = undefined;
  });
  return db;
}

function run<T>(mode: IDBTransactionMode, work: (meta: IDBObjectStore, content: IDBObjectStore) => IDBRequest<T> | undefined): Promise<T | undefined> {
  return open().then(
    (database) =>
      new Promise<T | undefined>((resolve, reject) => {
        const transaction = database.transaction([META, CONTENT], mode);
        const request = work(transaction.objectStore(META), transaction.objectStore(CONTENT));
        transaction.oncomplete = () => resolve(request?.result);
        transaction.onerror = () => reject(transaction.error ?? new Error('site cache transaction failed'));
        transaction.onabort = () => reject(transaction.error ?? new Error('site cache transaction aborted'));
      }),
  );
}

export async function getMeta(key: string): Promise<Meta | undefined> {
  try {
    return (await run<Meta>('readonly', (meta) => meta.get(key))) ?? undefined;
  } catch {
    return undefined;
  }
}

export async function getSite(key: string): Promise<CachedSite | undefined> {
  try {
    let meta: IDBRequest<Meta | undefined> | undefined;
    const content = await run<Content | undefined>('readonly', (metaStore, contentStore) => {
      meta = metaStore.get(key);
      return contentStore.get(key);
    });
    const found = meta?.result;
    return found && content ? { ...found, ...content } : undefined;
  } catch {
    return undefined;
  }
}

/** Stores a site, then drops the least recently used beyond `MAX_SITES`. Only metadata is read for that. */
export async function putSite(site: CachedSite): Promise<void> {
  const { manifest, files, skipped, ...meta } = site;
  await run('readwrite', (metaStore, contentStore) => {
    contentStore.put({ key: site.key, manifest, files, skipped });
    return metaStore.put(meta);
  });
  const all = (await run<Meta[]>('readonly', (metaStore) => metaStore.getAll())) ?? [];
  const extra = all.sort((a, b) => b.usedAt - a.usedAt).slice(MAX_SITES);
  if (extra.length > 0) {
    await run('readwrite', (metaStore, contentStore) => {
      for (const old of extra) {
        metaStore.delete(old.key);
        contentStore.delete(old.key);
      }
      return undefined;
    });
  }
}

/** Records a new proof that the stored site is still current, without rewriting its files. */
export async function touchSite(key: string, resolution: Meta['resolution'], at: number): Promise<void> {
  const meta = await getMeta(key);
  if (!meta) return;
  await run('readwrite', (metaStore) => metaStore.put({ ...meta, resolution, checkedAt: at, usedAt: at }));
}

export async function deleteSite(key: string): Promise<void> {
  await run('readwrite', (metaStore, contentStore) => {
    contentStore.delete(key);
    return metaStore.delete(key);
  });
}

export async function clearSites(): Promise<void> {
  await run('readwrite', (metaStore, contentStore) => {
    contentStore.clear();
    return metaStore.clear();
  });
}
