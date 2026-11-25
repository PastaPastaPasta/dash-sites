import { describe, expect, it } from 'vitest';
import {
  buildSite,
  CHUNK_SIZE,
  collectGarbage,
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
      ['version', (m) => (m.v = 2)],
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

  it('never shows a record written by an identity that does not own the name', async () => {
    const platform = setup();
    const reader = platform.as('anyone');
    const mallory = platform.as('mallory-id');
    const alice = platform.domains.get('a11ce')!;
    await mallory.putSite(alice, 'ipfs://bafymallory');
    expect(await mallory.listSites()).toHaveLength(1);
    expect(await resolveName(reader, 'alice.dash')).toMatchObject({ status: 'no-site', ownerId: 'alice-id' });

    const bundle = buildSite(SITE);
    await publishSite(platform.as('alice-id'), 'alice', bundle);
    await mallory.putSite(alice, 'ipfs://bafynewer');
    expect(await resolveName(reader, 'alice.dash')).toMatchObject({ status: 'ok', ownerId: 'alice-id', site: { ownerId: 'alice-id', content: bundle.contentUri } });
  });

  it('refuses an answer whose site record is not the name owner\'s', async () => {
    const platform = setup();
    const inner = platform.as('anyone');
    await platform.as('mallory-id').putSite(platform.domains.get('a11ce')!, 'ipfs://bafymallory');
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
    await platform.as('alice-id').putSite(platform.domains.get('a11ce')!, 'ipfs://bafyold');
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
    expect(await collectGarbage(alice)).toBe(aliceSite.chunks.size);

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

  it('does not count a record written before the identity owned the name', async () => {
    const platform = setup();
    await platform.as('dave-id').putSite({ id: '', ownerId: '', label: 'dave', normalizedLabel: 'dave', transferredAt: 0 }, 'ipfs://bafyearly');
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

  it('stores chunks under the owner\'s site record, and nobody else can add to it', async () => {
    const platform = setup();
    const bundle = buildSite(SITE);
    const { site } = await publishSite(platform.as('alice-id'), 'alice', bundle);
    expect((await platform.as('anyone').getChunks(site.id, [...bundle.chunks.keys()])).size).toBe(bundle.chunks.size);
    const [hash, data] = [...buildSite([{ path: '/index.html', bytes: text('mallory') }]).chunks][0]!;
    await expect(platform.as('mallory-id').createChunk(site.id, hash, data)).rejects.toThrow(/did not write site record/);
  });

  it('collects chunks no site references', async () => {
    const platform = setup();
    const alice = platform.as('alice-id');
    const v1 = buildSite(SITE);
    const v2 = buildSite([{ path: '/index.html', bytes: text('new') }]);
    await publishSite(alice, 'alice', v1);
    await publishSite(alice, 'alice', v2);
    const before = (await stored(alice)).length;
    const deleted = await collectGarbage(alice);
    expect(deleted).toBe(v1.chunks.size);
    expect((await stored(alice)).length).toBe(before - deleted);
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
    await collectGarbage(alice);
    expect((await stored(alice)).map((c) => c.hash).sort()).toEqual([...kept.chunks.keys()].sort());

    platform.transferName('second', 'carol-id');
    expect(await collectGarbage(alice)).toBe(kept.chunks.size);
    expect(await stored(alice)).toEqual([]);
  });

  it('keeps the chunks of a served site when a node answers from before its record was written', async () => {
    const platform = setup();
    const alice = platform.as('alice-id');
    await publishSite(alice, 'alice', buildSite(SITE));
    const earlier = { ...platform.meta(), timeMs: 0 };
    const previousOwner = { domain: { ...platform.domains.get('a11ce')!, ownerId: 'bob-id' } };
    for (const value of [undefined, previousOwner]) {
      expect(await collectGarbage({ ...alice, getName: async () => ({ value, meta: earlier }) })).toBe(0);
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
    await expect(publishSite(alice, 'alice', buildSite(SITE))).rejects.toThrow(/costs about/);
    expect(await alice.listSites()).toEqual([]);
  });
});
