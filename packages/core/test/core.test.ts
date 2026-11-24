import { describe, expect, it } from 'vitest';
import {
  buildSite,
  CHUNK_SIZE,
  collectGarbage,
  DEFAULT_PRUNE_GRACE_MS,
  planPrune,
  refundCredits,
  ContentError,
  decide,
  decodeManifest,
  encodeManifest,
  formatContentUri,
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
  utf8,
  validateManifest,
  type ContentRef,
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
    expect(second.site.revision).toBe(2);

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

  it('ignores a site published by someone who does not own the name', async () => {
    const platform = setup();
    await platform.as('mallory-id').putSite(platform.domains.get('a11ce')!, buildSite(SITE).contentUri);
    expect((await resolveName(platform.as('anyone'), 'alice.dash')).status).toBe('no-site');
  });

  it('follows the name when it changes hands', async () => {
    const platform = setup();
    await publishSite(platform.as('alice-id'), 'alice', buildSite(SITE));
    platform.transferName('alice', 'carol-id');
    expect((await resolveName(platform.as('anyone'), 'alice.dash')).status).toBe('no-site');
    const carolSite = buildSite([{ path: '/index.html', bytes: text('carol') }]);
    await publishSite(platform.as('carol-id'), 'alice', carolSite);
    const resolved = await resolveName(platform.as('anyone'), 'alice.dash');
    expect(resolved.status === 'ok' && resolved.site.content).toBe(carolSite.contentUri);
  });

  it('does not bring back an old site when a name returns to a previous owner', async () => {
    const platform = setup();
    await publishSite(platform.as('alice-id'), 'alice', buildSite(SITE));
    platform.transferName('alice', 'carol-id');
    platform.transferName('alice', 'alice-id');
    expect((await resolveName(platform.as('anyone'), 'alice.dash')).status).toBe('no-site');
    await publishSite(platform.as('alice-id'), 'alice', buildSite(SITE));
    expect((await resolveName(platform.as('anyone'), 'alice.dash')).status).toBe('ok');
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
    const before = (await alice.listChunks()).length;

    const early = await collectGarbage(alice, { now });
    expect(early.deleted).toBe(0);
    expect(early.deferredUntil).toBeGreaterThan(now);
    expect((await alice.listChunks()).length).toBe(before);

    now += DEFAULT_PRUNE_GRACE_MS + 1000;
    const result = await collectGarbage(alice, { now });
    expect(result.deleted).toBe(v1.chunks.size);
    expect(result.bytes).toBe([...v1.chunks.values()].reduce((sum, chunk) => sum + chunk.length, 0));
    expect((await alice.listChunks()).map((c) => c.hash).sort()).toEqual([...v2.chunks.keys()].sort());
  });

  it('prunes on publish only releases older than the one replaced', async () => {
    const platform = setup();
    let now = Date.now() + 1_000_000;
    platform.now = () => now;
    const alice = platform.as('alice-id');
    const release = (n: number) => buildSite([...SITE.slice(1), { path: '/index.html', bytes: text(`release ${n}`) }, { path: `/r${n}.bin`, bytes: random(CHUNK_SIZE + 10, n + 7) }]);
    const [v1, v2, v3, v4] = [1, 2, 3, 4].map(release) as [ReturnType<typeof release>, ReturnType<typeof release>, ReturnType<typeof release>, ReturnType<typeof release>];
    const hashes = async () => new Set((await alice.listChunks()).map((c) => c.hash));
    const only = (a: typeof v1, ...others: Array<typeof v1>) => [...a.chunks.keys()].filter((h) => others.every((o) => !o.chunks.has(h)));

    await publishSite(alice, 'alice', v1, undefined, { prune: { now } });
    now += 60_000;
    // v1 went live a minute ago: replacing it keeps it, and nothing older exists.
    const second = await publishSite(alice, 'alice', v2, undefined, { prune: { now } });
    expect(second.pruned?.deferredUntil).toBeDefined();
    now += 60_000;
    // v2 went live a minute ago: v1's own chunks are still kept.
    const third = await publishSite(alice, 'alice', v3, undefined, { prune: { now } });
    expect(third.pruned?.deleted).toBe(0);
    for (const h of only(v1, v2, v3)) expect((await hashes()).has(h)).toBe(true);

    now += DEFAULT_PRUNE_GRACE_MS + 1000;
    const fourth = await publishSite(alice, 'alice', v4, undefined, { prune: { now } });
    const left = await hashes();
    // v3 (replaced now) and v4 stay; v1 and v2 go, except chunks they share with v3 or v4.
    for (const h of [...v3.chunks.keys(), ...v4.chunks.keys()]) expect(left.has(h)).toBe(true);
    for (const h of [...only(v1, v3, v4), ...only(v2, v3, v4)]) expect(left.has(h)).toBe(false);
    expect(fourth.pruned?.deleted).toBe(new Set([...only(v1, v3, v4), ...only(v2, v3, v4)]).size);
    const resolved = await resolveName(platform.as('anyone'), 'alice.dash');
    expect(resolved.status === 'ok' && resolved.site.content).toBe(v4.contentUri);
  });

  it('keeps chunks another site of the identity uses and never touches another identity', async () => {
    const platform = setup();
    let now = Date.now() + 1_000_000;
    platform.now = () => now;
    platform.registerName('alice2', 'alice-id');
    const alice = platform.as('alice-id');
    const bob = platform.as('bob-id');
    const shared = buildSite(SITE);
    await publishSite(alice, 'alice', shared);
    await publishSite(alice, 'alice2', shared);
    await publishSite(bob, 'bob', shared);
    await publishSite(alice, 'alice', buildSite([{ path: '/index.html', bytes: text('other') }]));
    await publishSite(bob, 'bob', buildSite([{ path: '/index.html', bytes: text('bob other') }]));
    now += DEFAULT_PRUNE_GRACE_MS + 1000;

    const plan = await planPrune(alice, { now });
    expect(plan.remove).toEqual([]);
    expect((await collectGarbage(alice, { now })).deleted).toBe(0);
    for (const h of shared.chunks.keys()) expect((await bob.getChunks('bob-id', [h])).has(h)).toBe(true);
    expect((await collectGarbage(bob, { now })).deleted).toBe(shared.chunks.size);
    for (const h of shared.chunks.keys()) expect((await alice.getChunks('alice-id', [h])).has(h)).toBe(true);
  });

  it('estimates refunds from the storage fee distribution table', () => {
    const fee = 27_000n * 1_000_000n;
    expect(refundCredits(1_000_000, 0)).toBe((fee * 99_875n) / 100_000n);
    expect(refundCredits(1_000_000, 3)).toBe((fee * 99_500n) / 100_000n);
    expect(refundCredits(1_000_000, 40)).toBe((fee * 94_880n) / 100_000n);
    expect(refundCredits(1_000_000, 2_000)).toBe(0n);
  });
});
