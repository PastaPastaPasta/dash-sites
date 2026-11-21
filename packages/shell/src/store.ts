import type { Saved, Store } from './host.js';

const CACHE = 'dash-sites-host';
const STATE = '/state';
const chunkKey = (hash: string): string => `/chunk/${hash}`;

/** Keeps host state and verified chunks in the origin's Cache Storage. */
export class BrowserStore implements Store {
  private cache(): Promise<Cache> {
    return caches.open(CACHE);
  }

  async loadState(): Promise<Saved | undefined> {
    const response = await (await this.cache()).match(STATE);
    return response ? ((await response.json()) as Saved) : undefined;
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
    for (const name of await caches.keys()) await caches.delete(name);
    const databases = (await indexedDB.databases?.().catch(() => [])) ?? [];
    for (const { name } of databases) if (name) indexedDB.deleteDatabase(name);
    const cookies = (globalThis as { cookieStore?: { getAll(): Promise<Array<{ name: string }>>; delete(name: string): Promise<void> } }).cookieStore;
    if (cookies) for (const cookie of await cookies.getAll().catch(() => [])) await cookies.delete(cookie.name).catch(() => undefined);
  }
}
