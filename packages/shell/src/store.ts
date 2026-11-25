import type { Saved, Store } from './host.js';

const CACHE = 'dash-sites-host';
/** Holds the verifier, which the worker checks against a pinned hash every time it reads it. */
export const SHELL_CACHE = 'dash-sites-shell';
const STATE = '/state';
const chunkKey = (hash: string): string => `/chunk/${hash}`;
/** A step of a wipe that has not finished by then is left behind rather than holding up every request. */
const WIPE_LIMIT_MS = 5000;

/** Keeps host state and verified chunks in the origin's Cache Storage. */
export class BrowserStore implements Store {
  /** `keptUrls` are the entries a wipe keeps, so that a reset does not download the verifier again. */
  constructor(private readonly keptUrls: string[]) {}

  private cache(): Promise<Cache> {
    return caches.open(CACHE);
  }

  async loadState(): Promise<unknown> {
    const response = await (await this.cache()).match(STATE);
    return response ? response.json() : undefined;
  }

  async saveState(state: Saved): Promise<void> {
    await (await this.cache()).put(STATE, new Response(JSON.stringify(state), { headers: { 'Content-Type': 'application/json' } }));
  }

  async getChunk(hash: string): Promise<Uint8Array | undefined> {
    const response = await (await this.cache()).match(chunkKey(hash));
    return response ? new Uint8Array(await response.arrayBuffer()) : undefined;
  }

  async putChunk(hash: string, data: Uint8Array): Promise<void> {
    await (await this.cache()).put(chunkKey(hash), new Response(data as BodyInit));
  }

  async wipe(): Promise<void> {
    const steps: Array<() => Promise<unknown>> = [
      async () => Promise.all((await caches.keys()).filter((name) => name !== SHELL_CACHE).map((name) => caches.delete(name))),
      async () => {
        const shell = await caches.open(SHELL_CACHE);
        const keep = new Set(this.keptUrls.map((url) => new URL(url, location.href).href));
        for (const request of await shell.keys()) if (!keep.has(request.url)) await shell.delete(request);
      },
      async () => {
        for (const { name } of (await indexedDB.databases?.()) ?? []) if (name) indexedDB.deleteDatabase(name);
      },
      async () => {
        const root = (await navigator.storage.getDirectory()) as FileSystemDirectoryHandle & { keys(): AsyncIterable<string> };
        for await (const name of root.keys()) await root.removeEntry(name, { recursive: true }).catch(() => undefined);
      },
      async () => {
        const buckets = (navigator as { storageBuckets?: { keys(): Promise<string[]>; delete(name: string): Promise<void> } }).storageBuckets;
        for (const name of (await buckets?.keys()) ?? []) await buckets?.delete(name);
      },
      async () => (await (globalThis as unknown as ServiceWorkerGlobalScope).registration.pushManager.getSubscription())?.unsubscribe(),
      async () => {
        const cookies = (globalThis as { cookieStore?: { getAll(): Promise<Array<{ name: string }>>; delete(name: string): Promise<void> } }).cookieStore;
        for (const cookie of (await cookies?.getAll()) ?? []) await cookies?.delete(cookie.name);
      },
    ];
    const limit = new Promise((resolve) => setTimeout(resolve, WIPE_LIMIT_MS));
    await Promise.all(steps.map((step) => Promise.race([step().catch(() => undefined), limit])));
  }
}
