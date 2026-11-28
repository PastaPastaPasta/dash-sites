import { brotliCompressSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import {
  buildSite,
  CHUNK_SIZE,
  collectGarbage,
  DEFAULT_PRUNE_GRACE_MS,
  planPrune,
  PRUNE_RECHECK_MS,
  prune,
  type PlatformWriter,
  refundCredits,
  estimateCost,
  formatCredits,
  readerConfig,
  ContentError,
  decide,
  decodeManifest,
  encodeManifest,
  formatContentUri,
  isCurrent,
  gunzip,
  gzip,
  loadManifest,
  matchHost,
  normalizeLabel,
  parseContentUri,
  parseName,
  publishSite,
  readFile,
  resolveName,
  sha256Hex,
  unpublishSite,
  utf8,
  validateManifest,
  type ContentRef,
  type PlatformReader,
  type PlatformWriter,
  type SiteFile,
} from '../src/index.js';
import { loadFeeModel, nameRegistrationCredits } from '../src/evo.js';
import { MemoryPlatform } from '../src/memory.js';

const text = (s: string) => utf8.encode(s);

function random(length: number, seed = 1): Uint8Array {
  const out = new Uint8Array(length);
  let x = seed;
  for (let i = 0; i < length; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    out[i] = x >> 16;
  }
  return out;
}

const SITE: SiteFile[] = [
  { path: '/index.html', bytes: text('<h1>hello</h1>'.repeat(50)) },
  { path: '/about.html', bytes: text('<p>about</p>') },
  { path: '/blog/index.html', bytes: text('<p>blog</p>') },
  { path: '/404.html', bytes: text('<p>missing</p>') },
  { path: '/img/big.png', bytes: random(CHUNK_SIZE * 2 + 1234) },
  { path: '/empty.txt', bytes: new Uint8Array() },
];

describe('names', () => {
  it('normalizes like DPNS', () => {
    expect(normalizeLabel('Alice')).toBe('a11ce');
    expect(normalizeLabel('BOB-lol')).toBe('b0b-101');
  });

  it('parses names and rejects what DPNS would', () => {
    expect(parseName('Alice.dash')).toEqual({ label: 'alice', normalized: 'a11ce' });
    expect(parseName('alice')).toEqual({ label: 'alice', normalized: 'a11ce' });
    expect(parseName('alice.dash.')).toEqual({ label: 'alice', normalized: 'a11ce' });
    for (const bad of ['', 'ab', '-abc', 'abc-', 'a_b', 'alice.eth', 'blog.alice.dash', 'a'.repeat(64), 'älice', 'xn--80ak6aa92e', 'ab--cd']) {
      expect(parseName(bad), bad).toBeUndefined();
    }
  });

  it('matches hosts against gateway domains', () => {
    const domains = ['id.dashhq.org', 'localhost'];
    expect(matchHost('Alice.id.dashhq.org:443', domains)).toEqual({ kind: 'site', domain: 'id.dashhq.org', label: 'alice', normalized: 'a11ce' });
    expect(matchHost('id.dashhq.org', domains)).toEqual({ kind: 'apex', domain: 'id.dashhq.org' });
    expect(matchHost('alice.localhost:8080', domains).kind).toBe('site');
    expect(matchHost('a.b.id.dashhq.org', domains).kind).toBe('invalid');
    expect(matchHost('x.id.dashhq.org', domains).kind).toBe('invalid');
    expect(matchHost('evilid.dashhq.org', domains).kind).toBe('unknown');
    expect(matchHost('alice.example.com', domains).kind).toBe('unknown');
    expect(matchHost(undefined, domains).kind).toBe('unknown');
  });
});

describe('content URIs', () => {
  it('round-trips', () => {
    const ref: ContentRef = { scheme: 'dash-manifest', chunks: [sha256Hex(text('a')), sha256Hex(text('b'))] };
    expect(parseContentUri(formatContentUri(ref))).toEqual(ref);
    expect(parseContentUri('ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi')).toEqual({
      scheme: 'ipfs',
      cid: 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi',
    });
  });

  it('rejects what it does not understand', () => {
    const hash = sha256Hex(text('a'));
    for (const bad of ['', 'https://example.com', 'dash-manifest:v2:' + hash, 'dash-manifest:v1:', `dash-manifest:v1:${hash},${hash}`, 'dash-manifest:v1:' + hash.toUpperCase(), 'ipfs://../x', 'ipfs://cid/path']) {
      expect(parseContentUri(bad), bad).toBeUndefined();
    }
    expect(parseContentUri('dash-manifest:v1:' + Array.from({ length: 31 }, (_, i) => sha256Hex(text(String(i)))).join(','))).toBeUndefined();
  });
});

describe('gzip', () => {
  it('is deterministic and bounded on output', () => {
    const data = text('x'.repeat(100000));
    expect(gzip(data)).toEqual(gzip(data));
    expect(gunzip(gzip(data), data.length)).toEqual(data);
    expect(() => gunzip(gzip(data), data.length - 1)).toThrow();
    expect(() => gunzip(text('not gzip'), 100)).toThrow();
  });
});

describe('pack and read', () => {
  const bundle = buildSite(SITE);
  const source = async (hashes: string[]) => new Map(hashes.filter((h) => bundle.chunks.has(h)).map((h) => [h, bundle.chunks.get(h) as Uint8Array]));

  it('is deterministic and keeps chunks within the limit', () => {
    const again = buildSite([...SITE].reverse());
    expect(again.contentUri).toBe(bundle.contentUri);
    for (const [hash, data] of bundle.chunks) {
      expect(data.length).toBeLessThanOrEqual(CHUNK_SIZE);
      expect(sha256Hex(data)).toBe(hash);
    }
  });

  it('packs small files into shared chunks', () => {
    const small = ['/index.html', '/about.html', '/blog/index.html', '/404.html'].map((p) => bundle.manifest.files[p]?.parts[0]?.[0]);
    expect(new Set(small).size).toBe(1);
    expect(bundle.manifest.files['/img/big.png']?.parts.length).toBe(3);
    expect(bundle.manifest.files['/empty.txt']?.parts).toEqual([]);
  });

  it('round-trips every file through the manifest', async () => {
    const ref = parseContentUri(bundle.contentUri) as Extract<ContentRef, { scheme: 'dash-manifest' }>;
    const manifest = await loadManifest(ref, source);
    expect(manifest).toEqual(bundle.manifest);
    for (const file of SITE) {
      const content = await readFile(manifest, file.path, source);
      expect(content.bytes).toEqual(file.bytes);
      expect(content.file.type).toMatch(/\//);
    }
    expect((await readFile(manifest, '/index.html', source)).file.enc).toBe('gzip');
    expect((await readFile(manifest, '/img/big.png', source)).file.enc).toBeUndefined();
  });

  it('rejects a substituted or missing chunk', async () => {
    const ref = parseContentUri(bundle.contentUri) as Extract<ContentRef, { scheme: 'dash-manifest' }>;
    const tampered = async (hashes: string[]) => new Map(hashes.map((h) => [h, random(100, 7)]));
    await expect(loadManifest(ref, tampered)).rejects.toThrow(ContentError);
    await expect(readFile(bundle.manifest, '/index.html', tampered)).rejects.toThrow(ContentError);
    await expect(readFile(bundle.manifest, '/index.html', async () => new Map())).rejects.toThrow(/not stored/);
  });

  it('rejects a file whose bytes do not match its declared hash', async () => {
    const manifest = structuredClone(bundle.manifest);
    (manifest.files['/about.html'] as { sha256: string }).sha256 = sha256Hex(text('other'));
    await expect(readFile(manifest, '/about.html', source)).rejects.toThrow(/does not match/);
  });

  it('rejects invalid input', () => {
    expect(() => buildSite([])).toThrow();
    expect(() => buildSite([{ path: 'index.html', bytes: text('x') }])).toThrow(/invalid path/);
    expect(() => buildSite([{ path: '/a/../b', bytes: text('x') }])).toThrow(/invalid path/);
    expect(() => buildSite([{ path: '/a', bytes: text('x'), type: 'text/html\r\nSet-Cookie: x=1' }])).toThrow(/content type/);
    expect(() => buildSite(SITE, { limits: { maxSiteBytes: 100, maxFiles: 10 } })).toThrow(/larger/);
  });
});

describe('manifest validation', () => {
  const base = buildSite(SITE).manifest;
  const mutate = (fn: (m: any) => void) => {
    const copy = structuredClone(base) as any;
    fn(copy);
    return copy;
  };

  it('accepts its own canonical encoding', () => {
    expect(decodeManifest(encodeManifest(base))).toEqual(base);
  });

  it('rejects malformed manifests', () => {
    const cases: Array<[string, (m: any) => void]> = [
      ['version', (m) => (m.v = 3)],
      ['extra key', (m) => (m.extra = 1)],
      ['chunk hash', (m) => (m.chunks[0] = 'zz')],
      ['duplicate chunk', (m) => m.chunks.push(m.chunks[0])],
      ['relative path', (m) => (m.files['x'] = m.files['/about.html'])],
      ['dot segment', (m) => (m.files['/a/./b'] = m.files['/about.html'])],
      ['backslash', (m) => (m.files['/a\\b'] = m.files['/about.html'])],
      ['percent', (m) => (m.files['/a%2fb'] = m.files['/about.html'])],
      ['header injection', (m) => (m.files['/about.html'].type = 'text/html\r\nX: y')],
      ['part index', (m) => (m.files['/about.html'].parts[0][0] = 999)],
      ['part length', (m) => (m.files['/about.html'].parts[0][2] = CHUNK_SIZE + 1)],
      ['negative offset', (m) => (m.files['/about.html'].parts[0][1] = -1)],
      ['size mismatch', (m) => (m.files['/img/big.png'].size += 1)],
      ['enc', (m) => (m.files['/about.html'].enc = 'br')],
      ['spa type', (m) => (m.spa = 'yes')],
    ];
    for (const [name, fn] of cases) expect(() => validateManifest(mutate(fn)), name).toThrow();
    expect(() => validateManifest(base, { maxSiteBytes: 10, maxFiles: 100 })).toThrow(/too large/);
    expect(() => validateManifest(base, { maxSiteBytes: 1e9, maxFiles: 2 })).toThrow(/too many/);
    expect(() => decodeManifest(text('{'))).toThrow();
    const spaced = text(JSON.stringify(JSON.parse(utf8.decode(encodeManifest(base))), null, 1));
    expect(() => decodeManifest(spaced)).toThrow(/canonical/);
  });
});

describe('serving decisions', () => {
  const manifest = buildSite(SITE).manifest;
  const spa = buildSite(SITE, { spa: true }).manifest;
  const bare = buildSite([{ path: '/index.html', bytes: text('x') }]).manifest;

  it('maps paths to files', () => {
    expect(decide(manifest, '/')).toEqual({ kind: 'file', path: '/index.html', status: 200 });
    expect(decide(manifest, '/about.html')).toEqual({ kind: 'file', path: '/about.html', status: 200 });
    expect(decide(manifest, '/about')).toEqual({ kind: 'file', path: '/about.html', status: 200 });
    expect(decide(manifest, '/blog/')).toEqual({ kind: 'file', path: '/blog/index.html', status: 200 });
    expect(decide(manifest, '/blog', '?a=1')).toEqual({ kind: 'redirect', location: '/blog/?a=1' });
    expect(decide(manifest, '/img/big.png')).toEqual({ kind: 'file', path: '/img/big.png', status: 200 });
  });

  it('falls back to the 404 page, the SPA index, or nothing', () => {
    expect(decide(manifest, '/nope')).toEqual({ kind: 'file', path: '/404.html', status: 404 });
    expect(decide(spa, '/nope/deep')).toEqual({ kind: 'file', path: '/index.html', status: 200 });
    expect(decide(bare, '/nope')).toEqual({ kind: 'not-found' });
  });

  it('never escapes the site', () => {
    for (const path of ['/../etc/passwd', '/%2e%2e/x', '/a/%2e%2e/index.html', '/a%2fb', '/a%5cb', '/%00', '//evil.example/', '/%zz']) {
      const decision = decide(bare, path);
      expect(decision, path).toEqual({ kind: 'not-found' });
    }
    expect(decide(manifest, '//evil.example')).toEqual({ kind: 'file', path: '/404.html', status: 404 });
  });
});

describe('resolve and publish', () => {
  const setup = () => {
    const platform = new MemoryPlatform();
    platform.registerName('Alice', 'alice-id');
    platform.registerName('bob', 'bob-id');
    return platform;
  };

  it('publishes, resolves and reuses chunks', async () => {
    const platform = setup();
    const alice = platform.as('alice-id');
    const bundle = buildSite(SITE);
    const first = await publishSite(alice, 'alice.dash', bundle);
    expect(first.uploaded).toBe(bundle.chunks.size);
    const second = await publishSite(alice, 'ALICE', bundle);
    expect(second.uploaded).toBe(0);
    expect(second.site.revision).toBe(3);

    const resolved = await resolveName(alice, 'a1ice.dash');
    expect(resolved.status).toBe('ok');
    if (resolved.status !== 'ok') return;
    expect(resolved.canonicalLabel).toBe('alice');
    expect(resolved.ownerId).toBe('alice-id');
    expect(resolved.site.content).toBe(bundle.contentUri);
  });

  it('reports the other outcomes', async () => {
    const platform = setup();
    const reader = platform.as('anyone');
    expect((await resolveName(reader, 'x')).status).toBe('invalid');
    expect((await resolveName(reader, 'carol.dash')).status).toBe('unregistered');
    expect((await resolveName(reader, 'bob.dash')).status).toBe('no-site');
    await platform.as('bob-id').putSite(platform.domains.get('b0b')!, 'gopher://old');
    expect((await resolveName(reader, 'bob.dash')).status).toBe('unsupported');
  });

  it('refuses to publish to a name the identity does not own', async () => {
    const platform = setup();
    await expect(publishSite(platform.as('bob-id'), 'alice', buildSite(SITE))).rejects.toThrow(/owned by alice-id/);
    await expect(publishSite(platform.as('bob-id'), 'carol', buildSite(SITE))).rejects.toThrow(/not registered/);
  });

  it('resolves a name with one read, whatever the answer', async () => {
    const platform = setup();
    await publishSite(platform.as('alice-id'), 'alice', buildSite(SITE));
    const inner = platform.as('anyone');
    const reads: string[] = [];
    const reader: PlatformReader = {
      getDomain: (label) => (reads.push('domain'), inner.getDomain(label)),
      getName: (label) => (reads.push('name'), inner.getName(label)),
      getChunks: (owner, hashes) => inner.getChunks(owner, hashes),
    };
    expect((await resolveName(reader, 'alice.dash')).status).toBe('ok');
    expect((await resolveName(reader, 'bob.dash')).status).toBe('no-site');
    expect((await resolveName(reader, 'carol.dash')).status).toBe('unregistered');
    expect(reads).toEqual(['name', 'name', 'name']);
  });

  it('never shows a record written by an identity that does not own the name now', async () => {
    const platform = setup();
    const reader = platform.as('anyone');
    const mallory = platform.as('mallory-id');
    await expect(mallory.putSite(platform.domains.get('a11ce')!, 'ipfs://bafymallory')).rejects.toThrow(/does not own/);
    platform.transferName('alice', 'mallory-id');
    await mallory.putSite(platform.domains.get('a11ce')!, 'ipfs://bafymallory');
    platform.transferName('alice', 'alice-id');
    expect(await mallory.listSites()).toHaveLength(1);
    expect(await resolveName(reader, 'alice.dash')).toMatchObject({ status: 'no-site', ownerId: 'alice-id' });

    const bundle = buildSite(SITE);
    await publishSite(platform.as('alice-id'), 'alice', bundle);
    await expect(mallory.putSite(platform.domains.get('a11ce')!, 'ipfs://bafynewer')).rejects.toThrow(/does not own/);
    expect(await resolveName(reader, 'alice.dash')).toMatchObject({ status: 'ok', ownerId: 'alice-id', site: { ownerId: 'alice-id', content: bundle.contentUri } });
  });

  it('refuses an answer whose site record is not the name owner\'s', async () => {
    const platform = setup();
    const inner = platform.as('anyone');
    platform.transferName('alice', 'mallory-id');
    await platform.as('mallory-id').putSite(platform.domains.get('a11ce')!, 'ipfs://bafymallory');
    platform.transferName('alice', 'alice-id');
    const [forged] = await platform.as('mallory-id').listSites();
    const lying: PlatformReader = { ...inner, getName: async (label) => ({ value: { domain: (await inner.getDomain(label)).value!, site: forged! }, meta: platform.meta() }) };
    await expect(resolveName(lying, 'alice.dash')).rejects.toThrow(/different site/);
  });

  it('stops showing the previous owner\'s site in the block a name changes hands', async () => {
    const platform = setup();
    const reader = platform.as('anyone');
    const aliceSite = buildSite(SITE);
    await publishSite(platform.as('alice-id'), 'alice', aliceSite);
    platform.transferName('alice', 'carol-id');
    expect(await resolveName(reader, 'alice.dash')).toMatchObject({ status: 'no-site', ownerId: 'carol-id', canonicalLabel: 'alice' });
    await expect(publishSite(platform.as('alice-id'), 'alice', buildSite(SITE))).rejects.toThrow(/owned by carol-id/);
    await expect(platform.as('alice-id').putSite(platform.domains.get('a11ce')!, 'ipfs://bafyold')).rejects.toThrow(/does not own/);
    expect((await resolveName(reader, 'alice.dash')).status).toBe('no-site');
    expect(await unpublishSite(platform.as('carol-id'), 'alice')).toBe(false);

    const carolSite = buildSite([{ path: '/index.html', bytes: text('carol') }]);
    await publishSite(platform.as('carol-id'), 'alice', carolSite);
    expect(await resolveName(reader, 'alice.dash')).toMatchObject({ status: 'ok', ownerId: 'carol-id', site: { content: carolSite.contentUri } });
  });

  it('does not bring an identity\'s earlier site back when the name returns to it', async () => {
    const platform = setup();
    const reader = platform.as('anyone');
    const alice = platform.as('alice-id');
    const aliceSite = buildSite(SITE);
    await publishSite(alice, 'alice', aliceSite);
    platform.transferName('alice', 'carol-id');
    platform.transferName('alice', 'alice-id');
    expect(await resolveName(reader, 'alice.dash')).toMatchObject({ status: 'no-site', ownerId: 'alice-id' });
    expect(await unpublishSite(alice, 'alice')).toBe(false);
    expect((await collectGarbage(alice, gcLater(platform))).deleted).toBe(aliceSite.chunks.size);

    await publishSite(alice, 'alice', aliceSite);
    expect(await resolveName(reader, 'alice.dash')).toMatchObject({ status: 'ok', ownerId: 'alice-id', site: { content: aliceSite.contentUri } });
  });

  it('counts a record written in the block the name came to its owner, and none from before', () => {
    const domain = { id: 'd', ownerId: 'alice-id', label: 'Alice', normalizedLabel: 'a11ce', transferredAt: 100 };
    const site = { id: 's', ownerId: 'alice-id', normalizedLabel: 'a11ce', content: 'ipfs://x', revision: 1, updatedAt: 100 };
    expect(isCurrent(domain, site)).toBe(true);
    expect(isCurrent(domain, { ...site, updatedAt: 99 })).toBe(false);
    expect(isCurrent(domain, { ...site, ownerId: 'bob-id' })).toBe(false);
  });

  it('does not count a record written before the name was deleted and registered again', async () => {
    const platform = setup();
    const dave = platform.registerName('dave', 'dave-id');
    await platform.as('dave-id').putSite(dave, 'ipfs://bafyearly');
    platform.domains.delete('dave');
    platform.registerName('dave', 'dave-id');
    expect(await resolveName(platform.as('anyone'), 'dave.dash')).toMatchObject({ status: 'no-site', ownerId: 'dave-id' });
  });

  it('lets the owner take a site down', async () => {
    const platform = setup();
    const alice = platform.as('alice-id');
    await publishSite(alice, 'alice', buildSite(SITE));
    expect(await unpublishSite(alice, 'alice')).toBe(true);
    expect(await resolveName(platform.as('anyone'), 'alice.dash')).toMatchObject({ status: 'no-site', ownerId: 'alice-id', canonicalLabel: 'alice' });
    expect(await unpublishSite(alice, 'alice')).toBe(false);
    await expect(unpublishSite(platform.as('bob-id'), 'alice')).rejects.toThrow(/owned by alice-id/);
  });

  const stored = async (writer: PlatformWriter) => (await Promise.all((await writer.listSites()).map((site) => writer.listChunks(site.id)))).flat();
  const holds = async (writer: PlatformWriter, hash: string) => (await stored(writer)).some((chunk) => chunk.hash === hash);
  /** Moves Platform's clock past the grace period and the re-check margin, and returns prune options for that time. */
  const gcLater = (platform: ReturnType<typeof setup>) => {
    const t = Date.now() + 1e9;
    platform.now = () => t;
    return { now: t, recheckMs: 0 };
  };

  it('stores chunks under the owner\'s site record, and nobody else can add to it', async () => {
    const platform = setup();
    const bundle = buildSite(SITE);
    const { site } = await publishSite(platform.as('alice-id'), 'alice', bundle);
    expect((await platform.as('anyone').getChunks(site.id, [...bundle.chunks.keys()])).size).toBe(bundle.chunks.size);
    const [hash, data] = [...buildSite([{ path: '/index.html', bytes: text('mallory') }]).chunks][0]!;
    await expect(platform.as('mallory-id').createChunk(site.id, hash, data)).rejects.toThrow(/did not write site record/);
  });

  it('collects chunks no site references once every record is past the grace period', async () => {
    const platform = setup();
    let now = Date.now() + 1_000_000;
    platform.now = () => now;
    const alice = platform.as('alice-id');
    const v1 = buildSite(SITE);
    const v2 = buildSite([{ path: '/index.html', bytes: text('new') }]);
    await publishSite(alice, 'alice', v1);
    await publishSite(alice, 'alice', v2);
    const before = (await stored(alice)).length;

    const early = await collectGarbage(alice, { now, recheckMs: 0 });
    expect(early.deleted).toBe(0);
    expect(early.deferredUntil).toBeGreaterThan(now);
    expect((await stored(alice)).length).toBe(before);

    now += DEFAULT_PRUNE_GRACE_MS + 1000;
    const result = await collectGarbage(alice, { now, recheckMs: 0 });
    expect(result.deleted).toBe(v1.chunks.size);
    expect(result.bytes).toBe([...v1.chunks.values()].reduce((sum, chunk) => sum + chunk.length, 0));
    expect((await stored(alice)).map((c) => c.hash).sort()).toEqual([...v2.chunks.keys()].sort());
  });

  it('collects the chunks of a site taken down, and of a name that changed hands', async () => {
    const platform = setup();
    platform.registerName('second', 'alice-id');
    const alice = platform.as('alice-id');
    const kept = buildSite([{ path: '/index.html', bytes: text('kept') }]);
    await publishSite(alice, 'alice', buildSite(SITE));
    await publishSite(alice, 'second', kept);
    await unpublishSite(alice, 'alice');
    await collectGarbage(alice, gcLater(platform));
    expect((await stored(alice)).map((c) => c.hash).sort()).toEqual([...kept.chunks.keys()].sort());

    platform.transferName('second', 'carol-id');
    expect((await collectGarbage(alice, gcLater(platform))).deleted).toBe(kept.chunks.size);
    expect(await stored(alice)).toEqual([]);
  });

  it('keeps the chunks of a served site when a node answers from before its record was written', async () => {
    const platform = setup();
    const alice = platform.as('alice-id');
    await publishSite(alice, 'alice', buildSite(SITE));
    const earlier = { ...platform.meta(), timeMs: 0 };
    const previousOwner = { domain: { ...platform.domains.get('a11ce')!, ownerId: 'bob-id' } };
    for (const value of [undefined, previousOwner]) {
      expect((await collectGarbage({ ...alice, getDomain: async () => ({ value: value?.domain, meta: earlier }) }, gcLater(platform))).deleted).toBe(0);
    }
    expect((await resolveName(alice, 'alice')).status).toBe('ok');
  });

  it('leaves the site up while a new version uploads, even when a node does not show the record yet', async () => {
    const platform = setup();
    const alice = platform.as('alice-id');
    await publishSite(alice, 'alice', buildSite(SITE));
    const behind = { ...alice, listSites: async () => [] };
    const during: string[] = [];
    const next = buildSite([{ path: '/index.html', bytes: text('next') }]);
    await publishSite(behind, 'alice', next, (progress) => {
      if (progress.step === 'upload') void resolveName(alice, 'alice').then((resolution) => during.push(resolution.status));
    });
    expect(during.length).toBeGreaterThan(0);
    expect(new Set(during)).toEqual(new Set(['ok']));
    expect(await resolveName(alice, 'alice')).toMatchObject({ status: 'ok', site: { content: next.contentUri, revision: 3 } });
  });

  it('writes nothing on a first publish the identity cannot pay for', async () => {
    const platform = setup();
    platform.funds = 1n;
    const alice = platform.as('alice-id');
    const fees = await loadFeeModel(readerConfig('testnet'));
    await expect(publishSite(alice, 'alice', buildSite(SITE), undefined, { fees })).rejects.toThrow(/costs about/);
    expect(await alice.listSites()).toEqual([]);
  });

  it('prunes on publish only releases older than the one replaced', async () => {
    const platform = setup();
    let now = Date.now() + 1_000_000;
    platform.now = () => now;
    const alice = platform.as('alice-id');
    const release = (n: number) => buildSite([...SITE.slice(1), { path: '/index.html', bytes: text(`release ${n}`) }, { path: `/r${n}.bin`, bytes: random(CHUNK_SIZE + 10, n + 7) }]);
    const [v1, v2, v3, v4] = [1, 2, 3, 4].map(release) as [ReturnType<typeof release>, ReturnType<typeof release>, ReturnType<typeof release>, ReturnType<typeof release>];
    const hashes = async () => new Set((await stored(alice)).map((c) => c.hash));
    const only = (a: typeof v1, ...others: Array<typeof v1>) => [...a.chunks.keys()].filter((h) => others.every((o) => !o.chunks.has(h)));

    await publishSite(alice, 'alice', v1, undefined, { prune: { now, recheckMs: 0 } });
    now += 60_000;
    // v1 went live a minute ago: replacing it keeps it, and nothing older exists.
    const second = await publishSite(alice, 'alice', v2, undefined, { prune: { now, recheckMs: 0 } });
    expect(second.pruned?.deferredUntil).toBeDefined();
    now += 60_000;
    // v2 went live a minute ago: v1's own chunks are still kept.
    const third = await publishSite(alice, 'alice', v3, undefined, { prune: { now, recheckMs: 0 } });
    expect(third.pruned?.deleted).toBe(0);
    for (const h of only(v1, v2, v3)) expect((await hashes()).has(h)).toBe(true);

    now += DEFAULT_PRUNE_GRACE_MS + 1000;
    const fourth = await publishSite(alice, 'alice', v4, undefined, { prune: { now, recheckMs: 0 } });
    const left = await hashes();
    // v3 (replaced now) and v4 stay; v1 and v2 go, except chunks they share with v3 or v4.
    for (const h of [...v3.chunks.keys(), ...v4.chunks.keys()]) expect(left.has(h)).toBe(true);
    for (const h of [...only(v1, v3, v4), ...only(v2, v3, v4)]) expect(left.has(h)).toBe(false);
    expect(fourth.pruned?.deleted).toBe(new Set([...only(v1, v3, v4), ...only(v2, v3, v4)]).size);
    const resolved = await resolveName(platform.as('anyone'), 'alice.dash');
    expect(resolved.status === 'ok' && resolved.site.content).toBe(v4.contentUri);
  });

  it('keeps what each of the identity\'s records uses and never touches another identity', async () => {
    const platform = setup();
    let now = Date.now() + 1_000_000;
    platform.now = () => now;
    platform.registerName('alice2', 'alice-id');
    const alice = platform.as('alice-id');
    const bob = platform.as('bob-id');
    const shared = buildSite(SITE);
    const other = buildSite([{ path: '/index.html', bytes: text('other') }]);
    await publishSite(alice, 'alice', shared);
    await publishSite(alice, 'alice2', shared);
    await publishSite(bob, 'bob', shared);
    await publishSite(alice, 'alice', other);
    await publishSite(bob, 'bob', buildSite([{ path: '/index.html', bytes: text('bob other') }]));
    now += DEFAULT_PRUNE_GRACE_MS + 1000;

    const aliceRecord = (await alice.listSites()).find((site) => site.normalizedLabel === 'a11ce')!;
    const plan = await planPrune(alice, { now });
    const gone = [...shared.chunks.keys()].filter((hash) => !other.chunks.has(hash));
    expect(plan.remove.every((chunk) => chunk.siteId === aliceRecord.id)).toBe(true);
    expect(plan.remove.map((chunk) => chunk.hash).sort()).toEqual(gone.sort());
    expect((await collectGarbage(alice, { now, recheckMs: 0 })).deleted).toBe(gone.length);
    expect((await resolveName(platform.as('anyone'), 'alice2.dash')).status).toBe('ok');
    const alice2 = (await alice.listSites()).find((site) => site.normalizedLabel === 'a11ce2')!;
    expect((await alice.listChunks(alice2.id)).length).toBe(shared.chunks.size);
    for (const h of shared.chunks.keys()) expect(await holds(bob, h)).toBe(true);
    expect((await collectGarbage(bob, { now, recheckMs: 0 })).deleted).toBe(shared.chunks.size);
  });

  it('keeps every chunk of a version 2 site (brotli and npm files)', async () => {
    const platform = setup();
    let now = Date.now() + 1_000_000;
    platform.now = () => now;
    platform.registerName('alice2', 'alice-id');
    const alice = platform.as('alice-id');
    const wasm = new Uint8Array(40000).map((_, i) => (i * 7) % 251);
    const v2 = buildSite([...SITE, { path: '/page.html', bytes: text('<p>v2</p>'.repeat(200)) }, { path: '/sdk.wasm', bytes: wasm }], {
      brotli: (data) => new Uint8Array(brotliCompressSync(data)),
      external: { '/sdk.wasm': { npm: '@dashevo/wasm-sdk', version: '5.0.0-rc.8', path: 'dist/raw/wasm_sdk_bg.wasm' } },
    });
    expect(v2.manifest.v).toBe(2);
    expect(Object.values(v2.manifest.files).some((file) => file.enc === 'br')).toBe(true);
    await publishSite(alice, 'alice2', v2);
    const old = buildSite([{ path: '/index.html', bytes: text('old') }]);
    const current = buildSite([{ path: '/index.html', bytes: text('new') }]);
    await publishSite(alice, 'alice', old);
    await publishSite(alice, 'alice', current);
    now += DEFAULT_PRUNE_GRACE_MS + 1000;
    const plan = await planPrune(alice, { now });
    for (const hash of v2.chunks.keys()) expect(plan.remove.some((chunk) => chunk.hash === hash)).toBe(false);
    const gone = [...old.chunks.keys()].filter((hash) => !v2.chunks.has(hash) && !current.chunks.has(hash));
    expect(plan.remove.map((chunk) => chunk.hash).sort()).toEqual(gone.sort());
    expect((await collectGarbage(alice, { now, recheckMs: 0 })).deleted).toBe(gone.length);
    for (const hash of v2.chunks.keys()) expect((await holds(alice, hash))).toBe(true);
  });

  it('keeps every chunk of a site with files kept at places, and deletes nothing while a manifest holds something it does not know', async () => {
    const platform = setup();
    let now = Date.now() + 1_000_000;
    platform.now = () => now;
    platform.registerName('alice2', 'alice-id');
    platform.registerName('alice3', 'alice-id');
    const alice = platform.as('alice-id');
    const photo = new Uint8Array(40000).map((_, i) => (i * 7) % 251);
    const placed = buildSite([...SITE, { path: '/photo.bin', bytes: photo, src: ['https://media.example.com/photo.bin'] }]);
    expect(placed.manifest.v).toBe(3);
    await publishSite(alice, 'alice2', placed);
    const later = buildSite([{ path: '/index.html', bytes: text('<p>later</p>'.repeat(300)) }, { path: '/photo.bin', bytes: photo, src: ['https://media.example.com/photo.bin'] }]);
    const entry = later.manifest.files['/photo.bin']!;
    const unreadable = { ...later.manifest, files: { ...later.manifest.files, '/photo.bin': { ...entry, src: Array.from({ length: 9 }, (_, i) => `https://media.example.com/${i}`) } } };
    const sort = (v: unknown): unknown => (Array.isArray(v) ? v.map(sort) : v !== null && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort((v as Record<string, unknown>)[k])])) : v);
    const piece = gzip(utf8.encode(JSON.stringify(sort(unreadable))));
    const old = buildSite([{ path: '/index.html', bytes: text('old') }]);
    const current = buildSite([{ path: '/index.html', bytes: text('new') }]);
    await publishSite(alice, 'alice', old);
    await publishSite(alice, 'alice', current);
    now += DEFAULT_PRUNE_GRACE_MS + 1000;
    const plan = await planPrune(alice, { now });
    for (const hash of placed.chunks.keys()) expect(plan.remove.some((chunk) => chunk.hash === hash)).toBe(false);
    expect(plan.remove.length).toBeGreaterThan(0);

    const third = (await alice.getDomain('a11ce3')).value!;
    const record = await alice.ensureSite(third);
    for (const [hash, data] of later.chunks) await alice.createChunk(record.id, hash, data);
    await alice.createChunk(record.id, sha256Hex(piece), piece);
    await alice.putSite(third, formatContentUri({ scheme: 'dash-manifest', chunks: [sha256Hex(piece)] }));
    now += DEFAULT_PRUNE_GRACE_MS + 1000;
    await expect(planPrune(alice, { now })).rejects.toThrow(/holds something this version does not know/);
    await expect(collectGarbage(alice, { now, recheckMs: 0 })).rejects.toThrow(/nothing is deleted/);
    for (const hash of [...old.chunks.keys(), ...later.manifest.chunks]) expect(await holds(alice, hash)).toBe(true);
  });

  it('deletes nothing while a site manifest fails validation', async () => {
    const platform = setup();
    let now = Date.now() + 1_000_000;
    platform.now = () => now;
    platform.registerName('alice2', 'alice-id');
    const alice = platform.as('alice-id');
    await publishSite(alice, 'alice', buildSite([{ path: '/index.html', bytes: text('old') }]));
    await publishSite(alice, 'alice', buildSite([{ path: '/index.html', bytes: text('new') }]));
    const future = { ...buildSite(SITE).manifest, v: 3 };
    const piece = gzip(utf8.encode(JSON.stringify(future)));
    const hash = sha256Hex(piece);
    const domain2 = (await alice.getDomain('a11ce2')).value!;
    await alice.createChunk((await alice.ensureSite(domain2)).id, hash, piece);
    await alice.putSite(domain2, formatContentUri({ scheme: 'dash-manifest', chunks: [hash] }));
    now += DEFAULT_PRUNE_GRACE_MS + 1000;
    await expect(planPrune(alice, { now })).rejects.toThrow(/cannot be read/);
    await expect(collectGarbage(alice, { now, recheckMs: 0 })).rejects.toThrow(/cannot be read/);
  });

  const aged = () => {
    const platform = setup();
    let now = Date.now() + 1_000_000;
    platform.now = () => now;
    return { platform, alice: platform.as('alice-id'), later: () => (now += DEFAULT_PRUNE_GRACE_MS + 1000), now: () => now };
  };

  it('deletes nothing when the site listing it planned from was behind', async () => {
    const { platform, alice, later, now } = aged();
    const v1 = buildSite(SITE);
    await publishSite(alice, 'alice', v1);
    const stale = await alice.listSites();
    const v2 = buildSite([{ path: '/index.html', bytes: text('v2') }]);
    await publishSite(alice, 'alice', v2);
    await publishSite(alice, 'alice', buildSite([{ path: '/index.html', bytes: text('v3') }]));
    later();
    let calls = 0;
    const lagging: PlatformWriter = { ...alice, listSitesProved: async () => (calls++ === 0 ? { value: stale, meta: platform.meta() } : alice.listSitesProved()) };
    const result = await prune(lagging, await planPrune(lagging, { now: now() }), { recheckMs: 0 });
    expect(result.deleted).toBe(0);
    expect(result.skipped).toMatch(/changed since the plan/);
    expect((await resolveName(platform.as('anyone'), 'alice.dash')).status).toBe('ok');
  });

  it('refuses to plan over a record it cannot read, and still publishes', async () => {
    const { platform, alice, later, now } = aged();
    platform.registerName('alice2', 'alice-id');
    await publishSite(alice, 'alice2', buildSite(SITE));
    const site = [...platform.sites.values()].find((record) => record.ownerId === 'alice-id') as { content: string };
    site.content = site.content.replace('dash-manifest:v1:', 'dash-manifest:v9:');
    later();
    await expect(planPrune(alice, { now: now() })).rejects.toThrow(/cannot read/);
    const v1 = buildSite([{ path: '/index.html', bytes: text('one') }]);
    const result = await publishSite(alice, 'alice', v1, undefined, { prune: { now: now(), recheckMs: 0 } });
    expect(result.pruned?.skipped).toMatch(/cannot read/);
    expect(result.pruned?.deleted).toBe(0);
    const resolved = await resolveName(platform.as('anyone'), 'alice.dash');
    expect(resolved.status === 'ok' && resolved.site.content).toBe(v1.contentUri);
  });

  it('skips ipfs records and keeps chunks a concurrent publish starts using', async () => {
    const { platform, alice, later, now } = aged();
    platform.registerName('alice2', 'alice-id');
    platform.registerName('alice3', 'alice-id');
    const old = buildSite(SITE);
    await publishSite(alice, 'alice', old);
    await publishSite(alice, 'alice', buildSite([{ path: '/index.html', bytes: text('new') }]));
    await alice.putSite((await alice.getDomain('a11ce3')).value!, 'ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi');
    later();
    const plan = await planPrune(alice, { now: now() });
    expect(plan.remove.length).toBe(old.chunks.size);
    await publishSite(alice, 'alice2', old);
    const result = await prune(alice, plan, { recheckMs: 0 });
    expect(result.deleted).toBe(0);
    for (const hash of old.chunks.keys()) expect((await holds(alice, hash))).toBe(true);
  });

  it('reports chunks whose delete fails and keeps the publish', async () => {
    const { alice, later, now } = aged();
    for (const n of [1, 2]) await publishSite(alice, 'alice', buildSite([{ path: '/index.html', bytes: text(`v${n}`) }]));
    later();
    const failing: PlatformWriter = { ...alice, deleteChunk: async () => { throw new Error('node unavailable'); } };
    const v3 = buildSite([{ path: '/index.html', bytes: text('v3') }]);
    const result = await publishSite(failing, 'alice', v3, undefined, { prune: { now: now(), recheckMs: 0 } });
    expect(result.site.content).toBe(v3.contentUri);
    expect(result.pruned?.deleted).toBe(0);
    expect(result.pruned?.failed.length).toBeGreaterThan(0);
  });

  it('lets a dry run list what a deferred plan would delete', async () => {
    const { alice, later, now } = aged();
    const v1 = buildSite(SITE);
    await publishSite(alice, 'alice', v1);
    later();
    await publishSite(alice, 'alice', buildSite([{ path: '/index.html', bytes: text('new') }]));
    const plan = await planPrune(alice, { now: now() });
    expect(plan.deferredUntil).toBeDefined();
    expect(plan.remove.length).toBe(v1.chunks.size);
    expect((await prune(alice, plan, { recheckMs: 0 })).deleted).toBe(0);
    expect((await collectGarbage(alice, { now: now(), graceMs: 0, recheckMs: 0 })).deleted).toBe(v1.chunks.size);
  });

  it('skips the prune when the record read before publishing is stale', async () => {
    const { alice, later, now } = aged();
    const v1 = buildSite([{ path: '/index.html', bytes: text('v1') }, { path: '/a.bin', bytes: random(CHUNK_SIZE + 5, 3) }]);
    const v2 = buildSite([{ path: '/index.html', bytes: text('v2') }, { path: '/b.bin', bytes: random(CHUNK_SIZE + 5, 4) }]);
    await publishSite(alice, 'alice', v1);
    const stale = await alice.listSites();
    later();
    await publishSite(alice, 'alice', v2);
    const lagging: PlatformWriter = { ...alice, listSites: async () => stale };
    const v3 = buildSite([{ path: '/index.html', bytes: text('v3') }]);
    const result = await publishSite(lagging, 'alice', v3, undefined, { prune: { now: now() + 60_000, recheckMs: 0 } });
    expect(result.pruned?.deleted).toBe(0);
    expect(result.pruned?.skipped).toMatch(/not the one this publish replaced/);
    for (const hash of v2.chunks.keys()) expect((await holds(alice, hash))).toBe(true);
  });

  it('prunes when republishing identical content', async () => {
    const { alice, later, now } = aged();
    const v1 = buildSite([{ path: '/index.html', bytes: text('v1') }]);
    const v2 = buildSite([{ path: '/index.html', bytes: text('v2') }]);
    await publishSite(alice, 'alice', v1);
    await publishSite(alice, 'alice', v2);
    later();
    await publishSite(alice, 'alice', v2, undefined, { prune: { now: now(), recheckMs: 0 } });
    later();
    const result = await publishSite(alice, 'alice', v2, undefined, { prune: { now: now(), recheckMs: 0 } });
    expect(result.pruned?.skipped).toBeUndefined();
    expect((await stored(alice)).map((c) => c.hash).sort()).toEqual([...v2.chunks.keys()].sort());
  });

  it('keeps chunks stored within the grace period, which a publish still uploading has not referenced yet', async () => {
    const { platform, alice, later, now } = aged();
    await publishSite(alice, 'alice', buildSite(SITE));
    later();
    const record = await alice.ensureSite(platform.domains.get('a11ce')!);
    const next = buildSite([{ path: '/index.html', bytes: text('uploading') }]);
    for (const [hash, data] of next.chunks) await alice.createChunk(record.id, hash, data);
    expect((await collectGarbage(alice, { now: now(), recheckMs: 0 })).deleted).toBe(0);
    for (const hash of next.chunks.keys()) expect(await holds(alice, hash)).toBe(true);
    later();
    expect((await collectGarbage(alice, { now: now(), recheckMs: 0 })).deleted).toBe(next.chunks.size);
  });

  it('stores again a reused chunk that a gc deleted while the publish was uploading', async () => {
    const { platform, alice, later } = aged();
    const v1 = buildSite(SITE);
    await publishSite(alice, 'alice', v1);
    await publishSite(alice, 'alice', buildSite([{ path: '/index.html', bytes: text('v2') }]));
    later();
    const v3 = buildSite([...SITE, { path: '/new.txt', bytes: text('new') }]);
    const reused = [...v1.chunks.keys()].filter((hash) => v3.chunks.has(hash));
    expect(reused.length).toBeGreaterThan(0);
    let raced = false;
    const racing: PlatformWriter = {
      ...alice,
      createChunk: async (siteId, hash, data) => {
        if (!raced) for (const [key, chunk] of platform.chunks) if (reused.includes(chunk.hash)) platform.chunks.delete(key);
        raced = true;
        return alice.createChunk(siteId, hash, data);
      },
    };
    const result = await publishSite(racing, 'alice', v3);
    expect(result.uploaded + result.reused).toBe(v3.chunks.size);
    expect(result.reused).toBe(0);
    for (const hash of v3.chunks.keys()) expect(await holds(alice, hash)).toBe(true);
  });

  it('waits for a re-read from a block later than the plan before deleting, so a lagging node cannot hide a publish', async () => {
    const { platform, alice, later } = aged();
    const v1 = buildSite(SITE);
    await publishSite(alice, 'alice', v1);
    later();
    const v1Listing = await alice.listSitesProved();
    // A node that has not seen v2 answers the plan and any re-read from before the plan + 3 minutes.
    const v2 = buildSite([{ path: '/index.html', bytes: text('v2') }]);
    await publishSite(alice, 'alice', v2);
    const planBlock = v1Listing.meta.timeMs;
    const lagging: PlatformWriter = {
      ...alice,
      listSitesProved: async () => (platform.now() < planBlock + PRUNE_RECHECK_MS ? v1Listing : alice.listSitesProved()),
    };
    const plan = await planPrune(lagging, { now: platform.meta().timeMs, graceMs: 0 });
    expect(plan.remove.map((c) => c.hash).sort()).toEqual([...v2.chunks.keys()].sort());
    let slept = 0;
    const result = await prune(lagging, plan, { sleep: async (ms) => { slept += ms; platform.now = (() => { const t = platform.now() + ms; return () => t; })(); }, clock: () => 0 });
    expect(slept).toBeGreaterThanOrEqual(PRUNE_RECHECK_MS);
    expect(result.deleted).toBe(0);
    expect(result.skipped).toMatch(/changed since the plan/);
    for (const hash of v2.chunks.keys()) expect((await holds(alice, hash))).toBe(true);
  });

  it('gives up rather than delete when no node answers from a recent enough block', async () => {
    const { alice, later, now } = aged();
    for (const n of [1, 2]) await publishSite(alice, 'alice', buildSite([{ path: '/index.html', bytes: text(`v${n}`) }]));
    later();
    const frozen = await alice.listSitesProved();
    const stuck: PlatformWriter = { ...alice, listSitesProved: async () => frozen };
    const plan = await planPrune(stuck, { now: now() });
    let t = 0;
    const result = await prune(stuck, plan, { sleep: async (ms) => void (t += ms), clock: () => t });
    expect(result.deleted).toBe(0);
    expect(result.skipped).toMatch(/recent enough block/);
  });

  it("measures the grace period in Platform's time, not the local clock", async () => {
    const { alice } = aged();
    for (const n of [1, 2]) await publishSite(alice, 'alice', buildSite([{ path: '/index.html', bytes: text(`v${n}`) }]));
    // No `now` given: a local clock days ahead must not make a minutes-old record look old.
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.now() + 3 * 24 * 60 * 60 * 1000);
      const plan = await planPrune(alice);
      expect(plan.deferredUntil).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('prices a publish with the SDK fee model of the bundled contract', async () => {
    for (const network of ['testnet', 'mainnet'] as const) {
      const fees = await loadFeeModel(readerConfig(network));
      expect(fees.chunk(100)).toBeGreaterThan(27_000n * 100n);
      expect(fees.chunk(14_700)).toBeGreaterThan(27_000n * 14_700n);
      expect(fees.chunk(14_700)).toBeLessThan(fees.chunk(100) * 147n);
      const bundle = buildSite(SITE);
      const cost = estimateCost(bundle, fees);
      expect(cost.chunkCount).toBe(bundle.chunks.size);
      expect(cost.total).toBe(cost.siteRecord + cost.chunks);
      expect(estimateCost(bundle, fees, []).total).toBe(cost.siteRecord);
      const name = await nameRegistrationCredits(readerConfig(network));
      expect(name).toBeGreaterThan(0n);
      expect(name).toBeLessThan(1_000_000_000n);
    }
  });

  it('writes credits with thousands separators', () => {
    expect(formatCredits(0n)).toBe('0');
    expect(formatCredits(999n)).toBe('999');
    expect(formatCredits(3_222_000_920n)).toBe('3,222,000,920');
  });

  it('estimates refunds from the storage fee distribution table', () => {
    const fee = 27_000n * 1_000_000n;
    expect(refundCredits(1_000_000, 0)).toBe((fee * 99_875n) / 100_000n);
    expect(refundCredits(1_000_000, 3)).toBe((fee * 99_500n) / 100_000n);
    expect(refundCredits(1_000_000, 40)).toBe((fee * 94_880n) / 100_000n);
    expect(refundCredits(1_000_000, 2_000)).toBe(0n);
  });
});
