import { describe, expect, it } from 'vitest';
import { buildSite, cdnSource, integrityOf, normalizeLabel, publishSite, utf8, type PlatformReader, type SiteFile } from '@dash-sites/core';
import { MemoryPlatform } from '@dash-sites/core/memory';
import { parseRange, RESET_PATH, resetLocation, SiteHost, type HostOptions, type HostRequest, type Reply, type Saved, type Store } from '../src/host.js';

const text = (s: string) => utf8.encode(s);
const site = (title: string): SiteFile[] => [
  { path: '/index.html', bytes: text(`<h1>${title}</h1>`.repeat(30)) },
  { path: '/blog/index.html', bytes: text('<p>blog</p>') },
  { path: '/404.html', bytes: text('<p>custom missing</p>') },
  { path: '/app.js', bytes: text('console.log(1)') },
];

class MemoryStore implements Store {
  state?: unknown;
  chunks = new Map<string, Uint8Array>();
  wipes = 0;
  loadState = async () => this.state;
  saveState = async (state: Saved) => void (this.state = JSON.parse(JSON.stringify(state)));
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
  ownerChanges = 0;
  nonces = 0;
  background: Promise<unknown>[] = [];
  denied?: HostOptions['denied'];
  external?: HostOptions['external'];
  host = this.start();

  constructor() {
    this.platform.now = () => this.clock;
  }

  /** A new host over the same store: the worker was stopped and started again. */
  start(label = 'alice'): SiteHost {
    const inner = this.platform.as('reader');
    const reader: PlatformReader = {
      getDomain: (name) => inner.getDomain(name),
      getName: async (name) => {
        this.reads += 1;
        if (this.down) throw new Error('platform down');
        return inner.getName(name);
      },
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
      onOwnerChange: () => void (this.ownerChanges += 1),
      nonce: () => `nonce-${++this.nonces}`,
      denied: this.denied,
      external: this.external,
    });
    return this.host;
  }

  async publish(owner: string, title: string, label = 'alice'): Promise<void> {
    if (!this.platform.domains.has(normalizeLabel(label))) this.platform.registerName(label, owner);
    await publishSite(this.platform.as(owner), label, buildSite(site(title)));
  }

  get(path: string, extra: Partial<HostRequest> = {}): Promise<Reply> {
    const navigation = extra.navigation ?? !/\.(js|json)$|[?]done=/.test(path);
    return this.host.respond({ url: new URL(path, 'https://alice.id.example.org'), navigation, waitUntil: (work) => this.background.push(work), ...extra });
  }

  /** What a browser does when a page load is sent to the reset page: load it, let it report back. */
  async reset(redirect: Reply): Promise<void> {
    expect(redirect.status).toBe(302);
    expect(redirect.headers.Location).toMatch(/^\/\.well-known\/dash\/reset#/);
    const page = await this.get(RESET_PATH);
    expect(page.status).toBe(200);
    const code = /done=([\w-]+)/.exec(body(page))?.[1];
    expect((await this.get(`${RESET_PATH}?done=${code}`)).status).toBe(204);
  }

  /** A first visit: nothing is known about the browser's stored data, so it is cleared once. */
  async open(): Promise<void> {
    await this.reset(await this.get('/'));
  }

  async settle(): Promise<void> {
    await Promise.all(this.background.splice(0));
  }
}

/** Runs the reset page's script against a fake page and returns where it sends the browser. */
async function resetTarget(page: Reply, hash: string): Promise<string> {
  const script = /<script>([\s\S]*)<\/script>/.exec(body(page))?.[1] as string;
  let target = '';
  const location = { hash, origin: 'https://alice.id.example.org', replace: (to: string) => void (target = to) };
  const storage = { clear: () => undefined };
  new Function('localStorage', 'sessionStorage', 'document', 'location', 'fetch', script)(storage, storage, { cookie: '' }, location, () => Promise.resolve());
  await new Promise((resolve) => setTimeout(resolve, 0));
  return target;
}

const body = (reply: Reply): string => (typeof reply.body === 'string' ? reply.body : utf8.decode(reply.body ?? new Uint8Array()));

describe('hosted denylist', () => {
  it('refuses a denied name with a 451 page and a 451 host API answer', async () => {
    const h = new Harness();
    await h.publish('alice-id', 'one');
    const asked: string[] = [];
    h.denied = async (resolution) => {
      asked.push(resolution.status);
      return 'ownerId' in resolution && resolution.ownerId === 'alice-id';
    };
    h.start();
    const page = await h.get('/');
    expect(page.status).toBe(451);
    expect(body(page)).toContain('Unavailable on this gateway');
    expect(body(page)).not.toContain('<h1>one</h1>');
    const api = await h.get('/.well-known/dash/site.json');
    expect(api.status).toBe(451);
    expect(JSON.parse(body(api))).toEqual({ status: 'unavailable' });
    expect(asked).toContain('ok');
  });

  it('serves normally when the hook allows the name or there is no hook', async () => {
    for (const denied of [async () => false, undefined]) {
      const h = new Harness();
      await h.publish('alice-id', 'one');
      h.denied = denied;
      h.start();
      await h.open();
      const page = await h.get('/');
      expect(page.status).toBe(200);
      expect(body(page)).toContain('<h1>one</h1>');
    }
  });
});

describe('site host', () => {
  it('serves files, directory indexes and the 404 page from proved content', async () => {
    const h = new Harness();
    await h.publish('alice-id', 'one');
    await h.open();
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
    await h.open();
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
    await nobody.open();
    expect((await nobody.get('/')).status).toBe(404);
    const h = new Harness();
    h.platform.registerName('alice', 'alice-id');
    await h.open();
    expect(body(await h.get('/'))).toContain('has no site yet');
    h.start('a1ice');
    const redirect = await h.get('/blog/?q=1');
    expect(redirect.status).toBe(308);
    expect(redirect.headers.Location).toBe('https://alice.id.example.org/blog/?q=1');
  });

  it('keeps answers for 30 seconds, then checks again without making the page wait', async () => {
    const h = new Harness();
    await h.publish('alice-id', 'one');
    await h.open();
    h.clock += 29_000;
    await h.get('/');
    expect(h.reads).toBe(1);
    await h.publish('alice-id', 'two');
    h.clock += 2_000;
    expect(body(await h.get('/'))).toContain('one');
    await h.settle();
    expect(h.reads).toBe(2);
    expect(body(await h.get('/'))).toContain('two');
    expect(h.ownerChanges).toBe(0);
    expect(h.store.wipes).toBe(1);
  });

  it('serves nothing from an earlier run before Platform has answered', async () => {
    const h = new Harness();
    await h.publish('alice-id', 'one');
    await h.open();
    await h.publish('alice-id', 'two');
    h.start();
    h.reads = 0;
    expect(body(await h.get('/'))).toContain('two');
    expect(h.reads).toBe(1);
    expect(h.store.wipes).toBe(1);
  });

  it('clears the data of a previous owner on the first page load after a restart', async () => {
    const h = new Harness();
    await h.publish('alice-id', 'one');
    await h.open();
    h.platform.transferName('alice', 'bob-id');
    await h.publish('bob-id', 'bob');
    h.start();
    await h.reset(await h.get('/blog/?x=1'));
    expect(h.store.wipes).toBe(2);
    expect(body(await h.get('/'))).toContain('bob');
  });

  it('treats saved state it cannot read as a change of owner, whatever a site wrote there', async () => {
    for (const forged of [undefined, null, 'x', { resolution: null }, { epoch: 7, resetPending: false }, { epoch: 'alice-id.1', resetPending: 'no' }, { resolution: { status: 'invalid' }, resetPending: false }]) {
      const h = new Harness();
      await h.publish('alice-id', 'one');
      await h.open();
      h.platform.transferName('alice', 'bob-id');
      await h.publish('bob-id', 'bob');
      h.store.state = forged;
      h.start();
      await h.reset(await h.get('/'));
      expect(h.store.wipes, JSON.stringify(forged)).toBe(2);
      expect(body(await h.get('/'))).toContain('bob');
    }
  });

  it('resets open pages when the name changes hands while the worker is running', async () => {
    const h = new Harness();
    await h.publish('alice-id', 'one');
    await h.open();
    await h.get('/');
    await h.settle();
    expect(h.store.chunks.size).toBeGreaterThan(0);
    h.platform.transferName('alice', 'bob-id');
    h.clock += 60_000;
    expect(body(await h.get('/'))).toContain('one');
    await h.settle();
    expect(h.ownerChanges).toBe(1);
    expect(h.store.wipes).toBe(2);
    expect(h.store.chunks.size).toBe(0);
    await h.reset(await h.get('/blog/?x=1'));
    expect(body(await h.get('/'))).toContain('has no site yet');
  });

  it('keeps the site and its data when another identity writes a record for the name', async () => {
    const h = new Harness();
    await h.publish('alice-id', 'one');
    await h.open();
    await h.get('/');
    await h.settle();
    const wipes = h.store.wipes;
    await h.platform.as('mallory-id').putSite(h.platform.domains.get('a11ce')!, 'ipfs://bafymallory');
    h.clock += 60_000;
    await h.get('/');
    await h.settle();
    expect(body(await h.get('/'))).toContain('one');
    expect(h.ownerChanges).toBe(0);
    expect(h.store.wipes).toBe(wipes);
  });

  it('keeps a reset pending until the reset page itself reports back', async () => {
    const h = new Harness();
    await h.publish('alice-id', 'one');
    const first = await h.get('/blog/?x=1');
    expect(first.headers.Location).toBe(resetLocation(new URL('https://alice.id.example.org/blog/?x=1')));
    expect(first.headers.Location).toBe('/.well-known/dash/reset#%2Fblog%2F%3Fx%3D1');
    expect((await h.get(RESET_PATH, { navigation: false })).status).toBe(302);
    expect((await h.get(`${RESET_PATH}?done=guess`)).status).toBe(204);
    expect((await h.get('/')).status).toBe(302);
    const page = await h.get(RESET_PATH);
    expect(page.headers['Content-Security-Policy']).toContain("frame-ancestors 'none'");
    expect(body(page)).toContain('localStorage.clear()');
    await h.get(`${RESET_PATH}?done=nonce-1`);
    expect((await h.get('/')).status).toBe(200);
    const later = await h.get(RESET_PATH);
    expect(later.status).toBe(302);
    expect(later.headers.Location).toBe('/');
  });

  it('returns from the reset page only to an address on the same site', async () => {
    const h = new Harness();
    await h.publish('alice-id', 'one');
    await h.get('/');
    const page = await h.get(RESET_PATH);
    const origin = 'https://alice.id.example.org';
    expect(await resetTarget(page, '#%2Fblog%2F%3Fx%3D1')).toBe(`${origin}/blog/?x=1`);
    const hostile = ['#%2F%5Cevil.example', '#%2F%2Fevil.example', '#%2F.%2F%2Fevil.example%2Fx', '#%2F..%2F%2Fevil.example', `#${encodeURIComponent(`${origin}//evil.example`)}`, '#%2F%09%2Fevil.example', '#https%3A%2F%2Fevil.example%2F', '#javascript%3Aalert(1)', '#%E0%A4%A', ''];
    for (const hash of hostile) {
      const target = await resetTarget(page, hash);
      expect(target.startsWith(`${origin}/`), `${hash} -> ${target}`).toBe(true);
      expect(new URL(target).origin, hash).toBe(origin);
    }
  });

  it('does not let a frame take part in a reset', async () => {
    const h = new Harness();
    await h.publish('alice-id', 'one');
    const framed = await h.get('/', { topLevel: false });
    expect(framed.status).toBe(503);
    expect(body(framed)).toContain('cannot be shown in a frame yet');
    const page = await h.get(RESET_PATH);
    expect((await h.get(RESET_PATH, { topLevel: false })).status).toBe(302);
    expect(body(await h.get(RESET_PATH))).toBe(body(page));
    await h.get(`${RESET_PATH}?done=nonce-1`);
    expect((await h.get('/', { topLevel: false })).status).toBe(200);
  });

  it('never serves a stored chunk that does not match its hash', async () => {
    const h = new Harness();
    await h.publish('alice-id', 'one');
    await h.open();
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
    await h.open();
    await h.get('/');
    await h.get('/app.js');
    await h.settle();
    h.start();
    h.chunkReads = 0;
    expect(body(await h.get('/app.js'))).toBe('console.log(1)');
    expect(h.chunkReads).toBe(0);
  });

  it('says whether it has proved the name yet, and shares one check between callers', async () => {
    const h = new Harness();
    await h.publish('alice-id', 'one');
    const host = h.start();
    expect(host.proved).toBe(false);
    const [first, second] = await Promise.all([host.prove(), host.prove()]);
    expect(first).toBe(second);
    expect(h.reads).toBe(1);
    expect(host.proved).toBe(true);
    h.down = true;
    const restarted = h.start();
    await expect(restarted.prove()).rejects.toThrow('platform down');
    expect(restarted.proved).toBe(false);
  });

  it('ignores an answer older than one it already proved', async () => {
    const h = new Harness();
    await h.publish('alice-id', 'one');
    await h.open();
    h.platform.height -= 5;
    h.clock += 60_000;
    await h.get('/');
    await h.settle();
    expect(JSON.parse(body(await h.get('/.well-known/dash/site.json'))).proof.height).toBeGreaterThan(h.platform.height);
  });

  it('keeps serving what it proved when Platform stops answering, and says so when it has proved nothing', async () => {
    const h = new Harness();
    await h.publish('alice-id', 'one');
    await h.open();
    h.down = true;
    h.clock += 60_000;
    expect(body(await h.get('/'))).toContain('one');
    await h.settle();
    h.start();
    const reply = await h.get('/');
    expect(reply.status).toBe(503);
    expect(body(reply)).toContain('could not be reached');
    const api = await h.get('/.well-known/dash/site.json');
    expect(api.status).toBe(503);
    expect(JSON.parse(body(api))).toEqual({ status: 'unavailable' });
  });

  it('serves byte ranges', async () => {
    const h = new Harness();
    await h.publish('alice-id', 'one');
    const part = await h.get('/app.js', { range: 'bytes=0-6' });
    expect(part.status).toBe(206);
    expect(part.headers['Content-Range']).toBe('bytes 0-6/14');
    expect(body(part)).toBe('console');
    expect((await h.get('/app.js', { range: 'bytes=50-' })).status).toBe(416);
    expect((await h.get('/app.js', { range: 'bytes=5-3' })).status).toBe(200);
    expect(parseRange('bytes=-4', 10)).toEqual([6, 9]);
    expect(parseRange('bytes=2-', 10)).toEqual([2, 9]);
    expect(parseRange('items=1-2', 10)).toBeUndefined();
  });
});

describe('external npm assets', () => {
  const wasm = new Uint8Array(40_000).map((_, i) => (i * 7) % 251);
  const files = (): SiteFile[] => [...site('ext'), { path: '/sdk.wasm', bytes: wasm }];
  const ext = { '/sdk.wasm': { npm: '@dashevo/wasm-sdk', version: '5.0.0-rc.8', path: 'dist/raw/wasm_sdk_bg.wasm' } };

  async function setup(serve: (url: string) => Uint8Array | number) {
    const h = new Harness();
    const fetched: string[] = [];
    h.external = cdnSource(async (input) => {
      const url = String(input);
      fetched.push(url);
      const answer = serve(url);
      return typeof answer === 'number' ? new Response(null, { status: answer }) : new Response(answer);
    });
    h.host = h.start();
    h.platform.registerName('alice', 'owner');
    await publishSite(h.platform.as('owner'), 'alice', buildSite(files(), { external: ext }));
    await h.open();
    return { h, fetched };
  }

  it('serves the file from the first npm CDN once its hash matches, and keeps it', async () => {
    const { h, fetched } = await setup(() => wasm);
    const reply = await h.get('/sdk.wasm', { navigation: false });
    expect(reply.status).toBe(200);
    expect(reply.body).toEqual(wasm);
    expect(fetched).toEqual(['https://cdn.jsdelivr.net/npm/@dashevo/wasm-sdk@5.0.0-rc.8/dist/raw/wasm_sdk_bg.wasm']);
    expect((await h.get('/sdk.wasm', { navigation: false })).status).toBe(200);
    expect(fetched.length).toBe(1);
    expect((await h.get('/')).status).toBe(200);
  });

  it('falls back to the second CDN when the first is down or wrong', async () => {
    for (const first of [503, new Uint8Array(wasm.length)]) {
      const { h, fetched } = await setup((url) => (url.startsWith('https://cdn.jsdelivr.net/') ? first : wasm));
      const reply = await h.get('/sdk.wasm', { navigation: false });
      expect(reply.status).toBe(200);
      expect(reply.body).toEqual(wasm);
      expect(fetched.map((url) => new URL(url).origin)).toEqual(['https://cdn.jsdelivr.net', 'https://unpkg.com']);
    }
  });

  it('refuses a file no CDN serves with the published hash, and says why', async () => {
    const tampered = wasm.slice();
    tampered[123] ^= 1;
    const { h } = await setup(() => tampered);
    const reply = await h.get('/sdk.wasm', { navigation: false });
    expect(reply.status).toBe(502);
    expect(body(reply)).toMatch(/no copy matched the fingerprint/);
    expect(body(reply)).toMatch(/Nothing from it ran/);
  });

  it('says the file could not be downloaded when no CDN answers', async () => {
    const { h } = await setup(() => 503);
    const reply = await h.get('/sdk.wasm', { navigation: false });
    expect(reply.status).toBe(502);
    expect(body(reply)).toMatch(/could not be downloaded/);
    expect(body(reply)).not.toMatch(/fingerprint/);
  });

  it('says the file is gone when every CDN answers 404', async () => {
    const { h } = await setup(() => 404);
    const reply = await h.get('/sdk.wasm', { navigation: false });
    expect(body(reply)).toMatch(/no longer have it/);
  });

  it('does not trust a kept copy that was changed', async () => {
    const { h, fetched } = await setup(() => wasm);
    await h.get('/sdk.wasm', { navigation: false });
    await h.settle();
    const key = `ext/${integrityOf(wasm)}`;
    const kept = h.store.chunks.get(key) as Uint8Array;
    kept[0] ^= 1;
    expect((await h.get('/sdk.wasm', { navigation: false })).body).toEqual(wasm);
    expect(fetched.length).toBe(2);
  });
});
