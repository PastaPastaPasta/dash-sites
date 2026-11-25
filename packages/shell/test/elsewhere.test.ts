import { describe, expect, it } from 'vitest';
import { buildSite, httpsFetcher, publishSite, sha256Hex, utf8, type PlaceFetchers, type SiteFile } from '@dash-sites/core';
import { MemoryPlatform } from '@dash-sites/core/memory';
import { RESET_PATH, SiteHost, type Reply, type Saved, type Store } from '../src/host.js';

const photo = new Uint8Array(60000).map((_, i) => (i * 31) % 253);
const HTTPS = 'https://media.example.com/photo.webp';
const MIRROR = 'https://mirror.example.org/photo.webp';
const files: SiteFile[] = [
  { path: '/index.html', bytes: utf8.encode('<img src="/photo.webp">') },
  { path: '/photo.webp', bytes: photo, src: [HTTPS, MIRROR] },
];

class MemoryStore implements Store {
  state?: unknown;
  chunks = new Map<string, Uint8Array>();
  loadState = async () => this.state;
  saveState = async (state: Saved) => void (this.state = state);
  getChunk = async (hash: string) => this.chunks.get(hash);
  putChunk = async (hash: string, data: Uint8Array) => void this.chunks.set(hash, data);
  wipe = async () => this.chunks.clear();
}

async function serve(answers: Record<string, Uint8Array | number>, places?: (fetchers: PlaceFetchers) => PlaceFetchers | undefined) {
  const platform = new MemoryPlatform();
  platform.registerName('alice', 'alice-id');
  await publishSite(platform.as('alice-id'), 'alice', buildSite(files));
  const store = new MemoryStore();
  const asked: string[] = [];
  const logged: Array<Record<string, unknown>> = [];
  const fetchers: PlaceFetchers = {
    https: httpsFetcher({
      fetch: (async (input: RequestInfo | URL) => {
        asked.push(String(input));
        const answer = answers[String(input)];
        return typeof answer === 'object' ? new Response(answer as BodyInit) : new Response(null, { status: answer ?? 404 });
      }) as typeof fetch,
    }),
  };
  const host = new SiteHost({
    label: 'alice',
    network: 'testnet',
    reader: async () => platform.as('reader'),
    store,
    places: places ? places(fetchers) : fetchers,
    builderUrl: 'https://builder.example/',
    nonce: () => 'nonce',
    log: (entry) => logged.push(entry),
  });
  const get = (path: string, range?: string): Promise<Reply> => host.respond({ url: new URL(path, 'https://alice.id.example.org'), navigation: !/\.(json|webp)$|[?]done=/.test(path), range });
  await get('/');
  await get(RESET_PATH);
  await get(`${RESET_PATH}?done=nonce`);
  return { get, store, asked, logged };
}

describe('files stored outside Platform', () => {
  it('are served from the place that has them, with the headers of any other file', async () => {
    const { get, asked } = await serve({ [HTTPS]: photo });
    const reply = await get('/photo.webp');
    expect(reply.status).toBe(200);
    expect(reply.body).toEqual(photo);
    expect(reply.headers).toMatchObject({ 'Content-Type': 'image/webp', ETag: `"${sha256Hex(photo)}"`, 'X-Content-Type-Options': 'nosniff' });
    expect(asked).toEqual([HTTPS]);
    const part = await get('/photo.webp', 'bytes=10-19');
    expect(part.status).toBe(206);
    expect(part.body).toEqual(photo.subarray(10, 20));
  });

  it('are kept in the browser once checked, and checked again on every read', async () => {
    const { get, store, asked } = await serve({ [HTTPS]: photo });
    await get('/photo.webp');
    await get('/photo.webp');
    expect(asked).toEqual([HTTPS]);
    expect(store.chunks.get(sha256Hex(photo))).toEqual(photo);

    store.chunks.set(sha256Hex(photo), utf8.encode('swapped by site code'));
    expect((await get('/photo.webp')).body).toEqual(photo);
    expect(asked).toEqual([HTTPS, HTTPS]);
  });

  it('are downloaded once for requests that arrive together', async () => {
    const { get, asked } = await serve({ [HTTPS]: photo });
    const replies = await Promise.all([get('/photo.webp'), get('/photo.webp'), get('/photo.webp', 'bytes=0-9')]);
    expect(replies.map((reply) => reply.status)).toEqual([200, 200, 206]);
    expect(asked).toEqual([HTTPS]);
  });

  it('are not downloaded again while the browser is still keeping the first copy', async () => {
    const { get, asked, store } = await serve({ [HTTPS]: photo });
    let finish = (): void => undefined;
    const slow = new Promise<void>((resolve) => (finish = resolve));
    const put = store.putChunk;
    store.putChunk = async (hash, data) => {
      await slow;
      return put(hash, data);
    };
    expect((await get('/photo.webp')).status).toBe(200);
    expect((await get('/photo.webp', 'bytes=0-9')).status).toBe(206);
    expect(asked).toEqual([HTTPS]);
    finish();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect((await get('/photo.webp')).status).toBe(200);
    expect(asked).toEqual([HTTPS]);
  });

  it('fall back to the next place when one serves other bytes', async () => {
    const { get, asked, store } = await serve({ [HTTPS]: utf8.encode('replaced'), [MIRROR]: photo });
    expect((await get('/photo.webp')).body).toEqual(photo);
    expect(asked).toEqual([HTTPS, MIRROR]);
    expect([...store.chunks.values()].some((bytes) => utf8.encode('replaced').every((byte, i) => bytes[i] === byte) && bytes.length === 8)).toBe(false);
  });

  it('fail alone: the page that uses them still loads', async () => {
    const { get, logged, store } = await serve({ [HTTPS]: 500 });
    const missing = await get('/photo.webp');
    expect(missing.status).toBe(502);
    expect(String(missing.body)).toMatch(/keeps this file outside Dash Platform/);
    expect(String(missing.body)).not.toMatch(/media\.example\.com/);
    expect(logged.at(-1)).toMatchObject({ event: 'elsewhere-failed', path: '/photo.webp', attempts: [{ place: HTTPS }, { place: MIRROR }] });
    expect(store.chunks.has(sha256Hex(photo))).toBe(false);
    const page = await get('/');
    expect(page.status).toBe(200);
    expect(utf8.decode(page.body as Uint8Array)).toContain('<img');
  });

  it('are not fetched by a host that was given no way to', async () => {
    const { get, asked } = await serve({ [HTTPS]: photo }, () => undefined);
    expect((await get('/photo.webp')).status).toBe(502);
    expect(asked).toEqual([]);
  });

  it('are listed in the manifest the site can read', async () => {
    const { get } = await serve({});
    const manifest = JSON.parse(String((await get('/.well-known/dash/manifest.json')).body));
    expect(manifest.v).toBe(2);
    expect(manifest.files['/photo.webp']).toMatchObject({ size: photo.length, sha256: sha256Hex(photo), parts: [], src: [HTTPS, MIRROR] });
  });
});
