import { describe, expect, it } from 'vitest';
import { buildSite, normalizeLabel, publishSite, utf8, type PlatformReader, type Resolution, type SiteFile } from '@dash-sites/core';
import { MemoryPlatform } from '@dash-sites/core/memory';
import { parseRange, RESET_PATH, resetLocation, SiteHost, type HostRequest, type Reply, type Saved, type Store } from '../src/host.js';

const text = (s: string) => utf8.encode(s);
const site = (title: string): SiteFile[] => [
  { path: '/index.html', bytes: text(`<h1>${title}</h1>`.repeat(30)) },
  { path: '/blog/index.html', bytes: text('<p>blog</p>') },
  { path: '/404.html', bytes: text('<p>custom missing</p>') },
  { path: '/app.js', bytes: text('console.log(1)') },
];

class MemoryStore implements Store {
  state?: Saved;
  chunks = new Map<string, Uint8Array>();
  wipes = 0;
  loadState = async () => this.state && (JSON.parse(JSON.stringify(this.state)) as Saved);
  saveState = async (state: Saved) => void (this.state = JSON.parse(JSON.stringify(state)) as Saved);
  getChunk = async (hash: string) => this.chunks.get(hash);
  putChunk = async (hash: string, data: Uint8Array) => void this.chunks.set(hash, data);
  wipe = async () => {
    this.wipes += 1;
    this.chunks.clear();
    this.state = undefined;
  };
}

class Harness {
  platform = new MemoryPlatform();
  store = new MemoryStore();
  clock = 1_000_000;
  reads = 0;
  chunkReads = 0;
  down = false;
  changes: string[] = [];
  background: Promise<unknown>[] = [];
  host = this.start();

  constructor() {
    this.platform.now = () => this.clock;
  }

  /** A new host over the same store: the worker was stopped and started again. */
  start(label = 'alice'): SiteHost {
    const inner = this.platform.as('reader');
    const reader: PlatformReader = {
      getDomain: async (name) => {
        this.reads += 1;
        if (this.down) throw new Error('platform down');
        return inner.getDomain(name);
      },
      getSite: (owner, domain) => inner.getSite(owner, domain),
      getChunks: (owner, hashes) => {
        this.chunkReads += 1;
        return inner.getChunks(owner, hashes);
      },
    };
    this.host = new SiteHost({
      label,
      network: 'testnet',
      reader: async () => reader,
      store: this.store,
      builderUrl: 'https://builder.example/',
      now: () => this.clock,
      onChange: (kind) => this.changes.push(kind),
    });
    return this.host;
  }

  async publish(owner: string, title: string, label = 'alice'): Promise<void> {
    if (!this.platform.domains.has(normalizeLabel(label))) this.platform.registerName(label, owner);
    await publishSite(this.platform.as(owner), label, buildSite(site(title)));
  }

  get(path: string, extra: Partial<HostRequest> = {}): Promise<Reply> {
    const navigation = extra.navigation ?? !/\.(js|json)$/.test(path);
    return this.host.respond({ url: new URL(path, 'https://alice.id.example.org'), navigation, waitUntil: (work) => this.background.push(work), ...extra });
  }

  async settle(): Promise<void> {
    await Promise.all(this.background.splice(0));
  }
}

const body = (reply: Reply): string => (typeof reply.body === 'string' ? reply.body : utf8.decode(reply.body ?? new Uint8Array()));

describe('site host', () => {
  it('serves files, directory indexes and the 404 page from proved content', async () => {
    const h = new Harness();
    await h.publish('alice-id', 'one');
    const index = await h.get('/');
    expect(index.status).toBe(200);
    expect(index.headers['Content-Type']).toBe('text/html; charset=utf-8');
    expect(index.headers['X-Dash-Name']).toBe('alice.dash');
    expect(body(index)).toContain('<h1>one</h1>');
    expect((await h.get('/blog')).headers.Location).toBe('/blog/');
    expect(body(await h.get('/blog/'))).toBe('<p>blog</p>');
    const missing = await h.get('/nope');
    expect(missing.status).toBe(404);
    expect(body(missing)).toBe('<p>custom missing</p>');
    expect(h.reads).toBe(1);
  });

  it('answers the host API as the browser', async () => {
    const h = new Harness();
    await h.publish('alice-id', 'one');
    const record = JSON.parse(body(await h.get('/.well-known/dash/site.json')));
    expect(record).toMatchObject({ status: 'ok', name: 'alice.dash', ownerId: 'alice-id', network: 'testnet', servedBy: 'browser' });
    expect(Object.keys(JSON.parse(body(await h.get('/.well-known/dash/manifest.json'))).files)).toContain('/app.js');
    expect(JSON.parse(body(await h.get('/.well-known/dash/resolve/nobody')))).toMatchObject({ status: 'unregistered' });
    expect((await h.get('/.well-known/dash/resolve/x')).status).toBe(400);
    expect((await h.get('/.well-known/dash/other.json')).status).toBe(404);
  });

  it('explains names without a site and sends look-alike hosts to the registered spelling', async () => {
    const nobody = new Harness();
    nobody.start('nobody');
    expect((await nobody.get('/')).status).toBe(404);
    const h = new Harness();
    h.platform.registerName('alice', 'alice-id');
    expect(body(await h.get('/'))).toContain('has no site yet');
    h.store = new MemoryStore();
    h.start('a1ice');
    const redirect = await h.get('/blog/?q=1');
    expect(redirect.status).toBe(308);
    expect(redirect.headers.Location).toBe('https://alice.id.example.org/blog/?q=1');
  });

  it('keeps answers for 30 seconds, then checks again without making the page wait', async () => {
    const h = new Harness();
    await h.publish('alice-id', 'one');
    await h.get('/');
    h.clock += 29_000;
    await h.get('/');
    expect(h.reads).toBe(1);
    await h.publish('alice-id', 'two');
    h.clock += 2_000;
    expect(body(await h.get('/'))).toContain('one');
    await h.settle();
    expect(h.reads).toBe(2);
    expect(body(await h.get('/'))).toContain('two');
    expect(h.changes).toEqual([]);
  });

  it('shows a saved site at once after a restart, checks it anyway, and reloads when it changed', async () => {
    const h = new Harness();
    await h.publish('alice-id', 'one');
    await h.get('/');
    await h.publish('alice-id', 'two');
    h.start();
    h.reads = 0;
    expect(body(await h.get('/'))).toContain('one');
    await h.settle();
    expect(h.reads).toBe(1);
    expect(h.changes).toEqual(['content']);
    expect(body(await h.get('/'))).toContain('two');
  });

  it('does not let saved state postpone the check, whatever it claims', async () => {
    const h = new Harness();
    await h.publish('alice-id', 'one');
    await h.get('/');
    const forged = h.store.state as Saved;
    (forged.resolution as Extract<Resolution, { status: 'ok' }>).meta.height = Number.MAX_SAFE_INTEGER;
    h.platform.transferName('alice', 'bob-id');
    await h.publish('bob-id', 'bob');
    h.start();
    await h.get('/');
    await h.settle();
    expect(body(await h.get('/app.js'))).toBe('console.log(1)');
    expect(JSON.parse(body(await h.get('/.well-known/dash/site.json'))).ownerId).toBe('bob-id');
  });

  it('wipes stored data and clears page storage when the name changes owner', async () => {
    const h = new Harness();
    await h.publish('alice-id', 'one');
    await h.get('/');
    await h.settle();
    expect(h.store.chunks.size).toBeGreaterThan(0);
    h.platform.transferName('alice', 'bob-id');
    h.clock += 60_000;
    expect(body(await h.get('/'))).toContain('one');
    await h.settle();
    expect(h.store.wipes).toBe(1);
    expect(h.changes).toEqual(['owner']);
    const reset = await h.get('/blog/?x=1');
    expect(reset.status).toBe(302);
    expect(reset.headers.Location).toBe(resetLocation(new URL('https://alice.id.example.org/blog/?x=1')));
    expect(reset.headers.Location).toBe('/.well-known/dash/reset#%2Fblog%2F%3Fx%3D1');
    expect(body(await h.get(RESET_PATH))).toContain('localStorage.clear()');
    expect(body(await h.get('/'))).toContain('has no site yet');
    await h.publish('bob-id', 'bob');
    h.clock += 60_000;
    await h.get('/');
    await h.settle();
    expect(body(await h.get('/'))).toContain('bob');
    expect(h.store.wipes).toBe(1);
  });

  it('never serves a stored chunk that does not match its hash', async () => {
    const h = new Harness();
    await h.publish('alice-id', 'one');
    await h.get('/');
    await h.settle();
    for (const hash of h.store.chunks.keys()) h.store.chunks.set(hash, text('poison'));
    h.start();
    h.chunkReads = 0;
    expect(body(await h.get('/'))).toContain('<h1>one</h1>');
    expect(h.chunkReads).toBeGreaterThan(0);
  });

  it('reads stored chunks without asking Platform again', async () => {
    const h = new Harness();
    await h.publish('alice-id', 'one');
    await h.get('/');
    await h.get('/app.js');
    await h.settle();
    h.start();
    h.chunkReads = 0;
    expect(body(await h.get('/app.js'))).toBe('console.log(1)');
    expect(h.chunkReads).toBe(0);
  });

  it('ignores an answer older than one it already proved', async () => {
    const h = new Harness();
    await h.publish('alice-id', 'one');
    await h.get('/');
    h.platform.height -= 5;
    h.clock += 60_000;
    await h.get('/');
    await h.settle();
    expect(JSON.parse(body(await h.get('/.well-known/dash/site.json'))).proof.height).toBeGreaterThan(h.platform.height);
  });

  it('keeps serving a saved site when Platform cannot be reached, and says so when it has nothing', async () => {
    const h = new Harness();
    await h.publish('alice-id', 'one');
    await h.get('/');
    await h.settle();
    h.down = true;
    h.start();
    expect(body(await h.get('/'))).toContain('one');
    await h.settle();
    h.store.state = undefined;
    h.start();
    const reply = await h.get('/');
    expect(reply.status).toBe(503);
    expect(body(reply)).toContain('could not be reached');
  });

  it('serves byte ranges', async () => {
    const h = new Harness();
    await h.publish('alice-id', 'one');
    const part = await h.get('/app.js', { range: 'bytes=0-6' });
    expect(part.status).toBe(206);
    expect(part.headers['Content-Range']).toBe('bytes 0-6/14');
    expect(body(part)).toBe('console');
    expect((await h.get('/app.js', { range: 'bytes=50-' })).status).toBe(416);
    expect(parseRange('bytes=-4', 10)).toEqual([6, 9]);
    expect(parseRange('bytes=2-', 10)).toEqual([2, 9]);
    expect(parseRange('items=1-2', 10)).toBeUndefined();
  });
});
