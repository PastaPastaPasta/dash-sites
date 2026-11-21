import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gunzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildSite, publishSite, utf8, type PlatformReader, type SiteFile } from '@dash-sites/core';
import { MemoryPlatform } from '@dash-sites/core/memory';
import { createGateway, emptyDenylist, parseDenylist, parseDomain, RefreshingCache, type GatewayConfig } from '../src/index.js';

const text = (s: string) => utf8.encode(s);
const SITE: SiteFile[] = [
  { path: '/index.html', bytes: text('<h1>alice</h1>'.repeat(40)) },
  { path: '/about.html', bytes: text('<p>about</p>') },
  { path: '/blog/index.html', bytes: text('<p>blog</p>') },
  { path: '/404.html', bytes: text('<p>custom missing</p>') },
  { path: '/app.js', bytes: text('console.log(1)') },
  { path: '/sw.js', bytes: text('self.x=1') },
];

interface Response {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

function config(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    domains: [parseDomain('https://id.example.org'), parseDomain('http://localhost:8080')],
    reservedLabels: new Set(['www']),
    builderUrl: 'https://builder.example/',
    extensionUrl: 'https://ext.example/',
    abuseContact: 'abuse@example.org',
    network: 'testnet',
    denylist: emptyDenylist(),
    maxSiteBytes: 1024 * 1024,
    maxFiles: 100,
    rateLimitPerMinute: 0,
    trustProxy: false,
    chunkCacheBytes: 8 * 1024 * 1024,
    ...overrides,
  };
}

class Harness {
  platform = new MemoryPlatform();
  clock = 1_000_000;
  reads = 0;
  failReads = false;
  private server?: Server;
  private port = 0;

  async start(overrides: Partial<GatewayConfig> = {}): Promise<this> {
    this.platform.now = () => this.clock;
    const inner = this.platform.as('reader');
    const reader: PlatformReader = {
      getDomain: async (label) => {
        this.reads += 1;
        if (this.failReads) throw new Error('platform down');
        return inner.getDomain(label);
      },
      getSite: (owner, domain) => inner.getSite(owner, domain),
      getChunks: (owner, hashes) => inner.getChunks(owner, hashes),
    };
    this.server = createServer(createGateway({ reader, config: config(overrides), now: () => this.clock }));
    await new Promise<void>((resolve) => this.server?.listen(0, '127.0.0.1', resolve));
    this.port = (this.server.address() as AddressInfo).port;
    return this;
  }

  stop(): Promise<void> {
    return new Promise((resolve) => this.server?.close(() => resolve()));
  }

  get(host: string, path: string, headers: Record<string, string> = {}, method = 'GET'): Promise<Response> {
    return new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: this.port, path, method, headers: { host, ...headers } }, (res) => {
        const parts: Buffer[] = [];
        res.on('data', (part: Buffer) => parts.push(part));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(parts) }));
      });
      req.on('error', reject);
      req.end();
    });
  }
}

describe('gateway', () => {
  const h = new Harness();
  let contentUri = '';

  beforeAll(async () => {
    h.platform.registerName('Alice', 'alice-id');
    h.platform.registerName('bob', 'bob-id');
    h.platform.registerName('mallory', 'mallory-id');
    const bundle = buildSite(SITE);
    contentUri = bundle.contentUri;
    await publishSite(h.platform.as('alice-id'), 'alice', bundle);
    await publishSite(h.platform.as('mallory-id'), 'mallory', buildSite([{ path: '/index.html', bytes: text('evil') }]));
    await h.start({ denylist: parseDenylist('name mallory.dash # phishing\n') });
  });
  afterAll(() => h.stop());

  it('serves a site with proof and security headers', async () => {
    const res = await h.get('alice.id.example.org', '/');
    expect(res.status).toBe(200);
    expect(res.body.toString()).toContain('<h1>alice</h1>');
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-dash-name']).toBe('alice.dash');
    expect(res.headers['x-dash-owner']).toBe('alice-id');
    expect(res.headers['x-dash-content']).toBe(contentUri);
    expect(res.headers['strict-transport-security']).toContain('includeSubDomains');
    expect(res.headers['origin-agent-cluster']).toBe('?1');
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(res.headers['content-encoding']).toBeUndefined();
  });

  it('serves stored gzip to clients that accept it', async () => {
    const res = await h.get('alice.id.example.org', '/index.html', { 'accept-encoding': 'gzip, br' });
    expect(res.headers['content-encoding']).toBe('gzip');
    expect(gunzipSync(res.body).toString()).toContain('<h1>alice</h1>');
    const refused = await h.get('alice.id.example.org', '/index.html', { 'accept-encoding': 'gzip;q=0, identity' });
    expect(refused.headers['content-encoding']).toBeUndefined();
  });

  it('answers conditional and HEAD requests', async () => {
    const first = await h.get('alice.id.example.org', '/app.js');
    const etag = String(first.headers.etag);
    expect(etag).toMatch(/^"[0-9a-f]{64}"$/);
    const again = await h.get('alice.id.example.org', '/app.js', { 'if-none-match': etag });
    expect(again.status).toBe(304);
    expect(again.body.length).toBe(0);
    const head = await h.get('alice.id.example.org', '/app.js', {}, 'HEAD');
    expect(head.status).toBe(200);
    expect(head.headers['content-length']).toBe(String(first.body.length));
    expect(head.body.length).toBe(0);
  });

  it('maps clean URLs, directories and missing pages', async () => {
    expect((await h.get('alice.id.example.org', '/about')).body.toString()).toBe('<p>about</p>');
    const dir = await h.get('alice.id.example.org', '/blog?x=1');
    expect(dir.status).toBe(301);
    expect(dir.headers.location).toBe('/blog/?x=1');
    expect((await h.get('alice.id.example.org', '/blog/')).body.toString()).toBe('<p>blog</p>');
    const missing = await h.get('alice.id.example.org', '/nope');
    expect(missing.status).toBe(404);
    expect(missing.body.toString()).toBe('<p>custom missing</p>');
    expect((await h.get('alice.id.example.org', '/%2e%2e/%2e%2e/etc/passwd')).status).toBe(404);
  });

  it('redirects other spellings of a name to its one origin', async () => {
    const res = await h.get('a1ice.id.example.org', '/about?x=1');
    expect(res.status).toBe(308);
    expect(res.headers.location).toBe('https://alice.id.example.org/about?x=1');
    const local = await h.get('ALICE.localhost:8080', '/');
    expect(local.status).toBe(200);
    const localOther = await h.get('a11ce.localhost:8080', '/');
    expect(localOther.headers.location).toBe('http://alice.localhost:8080/');
  });

  it('explains names without a site, unregistered names and bad hosts', async () => {
    const noSite = await h.get('bob.id.example.org', '/');
    expect(noSite.status).toBe(404);
    expect(noSite.body.toString()).toContain('has no site yet');
    const unregistered = await h.get('carol.id.example.org', '/');
    expect(unregistered.status).toBe(404);
    expect(unregistered.body.toString()).toContain('is not registered');
    expect((await h.get('a.b.id.example.org', '/')).status).toBe(404);
    expect((await h.get('xn--80ak6aa92e.id.example.org', '/')).status).toBe(404);
    expect((await h.get('www.id.example.org', '/')).status).toBe(404);
    expect((await h.get('alice.other.example', '/')).status).toBe(421);
    expect((await h.get('alice.id.example.org', '/', {}, 'POST')).status).toBe(405);
  });

  it('never answers ACME challenges for a site', async () => {
    expect((await h.get('alice.id.example.org', '/.well-known/acme-challenge/token')).status).toBe(404);
  });

  it('refuses denied names', async () => {
    const res = await h.get('mallory.id.example.org', '/');
    expect(res.status).toBe(451);
    expect(res.body.toString()).not.toContain('evil');
  });

  it('serves the landing page and the resolve API on the bare domain', async () => {
    const landing = await h.get('id.example.org', '/');
    expect(landing.status).toBe(200);
    expect(landing.body.toString()).toContain('alice.id.example.org');
    const api = await h.get('id.example.org', '/api/resolve/Alice.dash');
    expect(api.status).toBe(200);
    const body = JSON.parse(api.body.toString());
    expect(body).toMatchObject({ status: 'ok', name: 'alice.dash', ownerId: 'alice-id', url: 'https://alice.id.example.org/', site: { content: contentUri } });
    expect((await h.get('id.example.org', '/api/resolve/x')).status).toBe(400);
    const own = JSON.parse((await h.get('alice.id.example.org', '/.well-known/dash/site.json')).body.toString());
    expect(own).toMatchObject({ status: 'ok', name: 'alice.dash', servedBy: 'gateway', site: { content: contentUri } });
    const manifest = await h.get('alice.id.example.org', '/.well-known/dash/manifest.json');
    expect(Object.keys(JSON.parse(manifest.body.toString()).files)).toContain('/index.html');
    const other = await h.get('alice.id.example.org', '/.well-known/dash/resolve/nobody');
    expect(JSON.parse(other.body.toString())).toMatchObject({ status: 'unregistered' });
    expect((await h.get('alice.id.example.org', '/.well-known/dash/other')).status).toBe(404);
    const nobody = await h.get('nobody.id.example.org', '/.well-known/dash/site.json');
    expect(nobody.status).toBe(200);
    expect(JSON.parse(nobody.body.toString())).toMatchObject({ status: 'unregistered', servedBy: 'gateway' });
    expect((await h.get('id.example.org', '/healthz')).body.toString()).toBe('ok\n');
  });

  it('clears site data when the owner epoch cookie is missing or old, on navigations and worker scripts only', async () => {
    const nav = await h.get('alice.id.example.org', '/', { 'sec-fetch-dest': 'document' });
    expect(nav.headers['clear-site-data']).toBe('"cache", "storage"');
    const cookie = String((nav.headers['set-cookie'] as string[])[0]);
    expect(cookie).toMatch(/^__Host-dash-epoch=alice-id\.\d+; Path=\/; Max-Age=\d+; Secure; HttpOnly; SameSite=Lax$/);
    expect(nav.headers['cache-control']).toBe('private, no-cache');
    const pair = cookie.split(';')[0] as string;

    const next = await h.get('alice.id.example.org', '/', { 'sec-fetch-dest': 'document', cookie: pair });
    expect(next.headers['clear-site-data']).toBeUndefined();
    expect(next.headers['set-cookie']).toBeUndefined();

    const sub = await h.get('alice.id.example.org', '/app.js', { 'sec-fetch-dest': 'script' });
    expect(sub.headers['clear-site-data']).toBeUndefined();

    const worker = await h.get('alice.id.example.org', '/sw.js', { 'service-worker': 'script', cookie: '__Host-dash-epoch=seller-id.1' });
    expect(worker.headers['clear-site-data']).toBe('"cache", "storage"');
  });
});

describe('gateway resilience', () => {
  it('keeps serving the last known site while Platform is unreachable, and follows changes after', async () => {
    const h = await new Harness().start();
    try {
      h.platform.registerName('alice', 'alice-id');
      await publishSite(h.platform.as('alice-id'), 'alice', buildSite([{ path: '/index.html', bytes: text('v1') }]));
      expect((await h.get('alice.id.example.org', '/')).body.toString()).toBe('v1');
      const reads = h.reads;
      await h.get('alice.id.example.org', '/');
      expect(h.reads).toBe(reads);

      await publishSite(h.platform.as('alice-id'), 'alice', buildSite([{ path: '/index.html', bytes: text('v2') }]));
      h.clock += 10 * 60 * 1000;
      expect((await h.get('alice.id.example.org', '/')).body.toString()).toBe('v2');

      h.failReads = true;
      h.clock += 60 * 60 * 1000;
      const stale = await h.get('alice.id.example.org', '/');
      expect(stale.status).toBe(200);
      expect(stale.headers['x-dash-stale']).toBe('1');
      expect((await h.get('never-seen.id.example.org', '/')).status).toBe(503);

      h.failReads = false;
      h.platform.transferName('alice', 'carol-id');
      h.clock += 10 * 60 * 1000;
      const sold = await h.get('alice.id.example.org', '/');
      expect(sold.status).toBe(404);
      expect(sold.body.toString()).toContain('has no site yet');
    } finally {
      await h.stop();
    }
  });

  it('rate limits per client', async () => {
    const h = await new Harness().start({ rateLimitPerMinute: 3 });
    try {
      const statuses = [];
      for (let i = 0; i < 5; i++) statuses.push((await h.get('id.example.org', '/healthz')).status);
      expect(statuses).toEqual([200, 200, 200, 429, 429]);
    } finally {
      await h.stop();
    }
  });
});

describe('RefreshingCache', () => {
  it('keeps the newer state when a refresh returns older state', async () => {
    let clock = 0;
    const answers = [{ height: 5 }, { height: 3 }, { height: 9 }];
    const cache = new RefreshingCache(async () => answers.shift() as { height: number }, {
      freshMs: 10,
      staleMs: 10,
      errorMs: 1000,
      maxEntries: 10,
      now: () => clock,
      accept: (next, previous) => next.height >= previous.height,
    });
    expect((await cache.get('k')).value.height).toBe(5);
    clock += 100;
    expect((await cache.get('k')).value.height).toBe(5);
    clock += 100;
    expect((await cache.get('k')).value.height).toBe(9);
  });
});
