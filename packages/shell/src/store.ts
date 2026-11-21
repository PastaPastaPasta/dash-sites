import type { Saved, Store } from './host.js';

const CACHE = 'dash-sites-host';
const STATE = '/state';
const chunkKey = (hash: string): string => `/chunk/${hash}`;

/** Keeps host state and verified chunks in the origin's Cache Storage. */
export class BrowserStore implements Store {
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
      async () => Promise.all((await caches.keys()).map((name) => caches.delete(name))),
      async () => {
        for (const { name } of (await indexedDB.databases?.()) ?? []) if (name) indexedDB.deleteDatabase(name);
      },
      async () => {
        const root = (await navigator.storage.getDirectory()) as FileSystemDirectoryHandle & { keys(): AsyncIterable<string> };
        for await (const name of root.keys()) await root.removeEntry(name, { recursive: true });
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
    await Promise.all(steps.map((step) => step().catch(() => undefined)));
  }
}
