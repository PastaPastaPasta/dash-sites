import { describe, expect, it } from 'vitest';
import {
  buildSite,
  denylistFromJson,
  emptyDenylist,
  isDenied,
  networkConfig,
  parseDenylist,
  publishSite,
  readerConfig,
  resolveName,
  utf8,
  type PlatformReader,
} from '../src/index.js';
import { MemoryPlatform } from '../src/memory.js';

describe('denylist', () => {
  it('parses names, owners and contents, ignoring comments and blank lines', () => {
    const list = parseDenylist('# header\n\nname Mallory.dash  # phishing\nname evil.dash.\nowner 4EfA9Jrvv3nnCFdSf7fad59851iiTRZ6Wcu6YVJ4iSeF\ncontent dash-manifest:abc\n');
    expect([...list.names].sort()).toEqual(['ev11', 'ma110ry']);
    expect([...list.owners]).toEqual(['4EfA9Jrvv3nnCFdSf7fad59851iiTRZ6Wcu6YVJ4iSeF']);
    expect([...list.content]).toEqual(['dash-manifest:abc']);
  });

  it('stores names in DPNS normal form, so look-alike spellings are refused together', () => {
    const list = parseDenylist('name ALICE\n');
    expect(list.names.has('a11ce')).toBe(true);
    expect(parseDenylist('name a11ce').names).toEqual(list.names);
  });

  it('rejects unknown kinds and missing values', () => {
    expect(() => parseDenylist('domain alice')).toThrow(/unknown kind/);
    expect(() => parseDenylist('name')).toThrow(/missing value/);
    expect(() => parseDenylist('name   # comment only')).toThrow(/missing value/);
  });

  it('reads the published JSON form and treats anything else as an empty list', () => {
    const list = denylistFromJson({ names: ['Mallory.dash', 7], owners: ['owner-1'], content: ['dash-manifest:x'], extra: true });
    expect([...list.names]).toEqual(['ma110ry']);
    expect([...list.owners]).toEqual(['owner-1']);
    expect([...list.content]).toEqual(['dash-manifest:x']);
    for (const garbage of [null, undefined, 'names', 42, [], { names: 'alice' }, { owners: {} }]) {
      expect(denylistFromJson(garbage)).toEqual(emptyDenylist());
    }
  });

  it('matches resolutions by name, owner and content', async () => {
    const platform = new MemoryPlatform();
    platform.registerName('alice', 'alice-id');
    platform.registerName('bob', 'bob-id');
    const bundle = buildSite([{ path: '/index.html', bytes: utf8.encode('<h1>alice</h1>') }]);
    await publishSite(platform.as('alice-id'), 'alice', bundle);
    const reader = platform.as('reader');
    const alice = await resolveName(reader, 'alice');
    const bob = await resolveName(reader, 'bob');
    const carol = await resolveName(reader, 'carol');
    const invalid = await resolveName(reader, 'x');
    expect(alice.status).toBe('ok');
    expect(bob.status).toBe('no-site');
    expect(carol.status).toBe('unregistered');

    const empty = emptyDenylist();
    for (const r of [alice, bob, carol, invalid]) expect(isDenied(empty, r)).toBe(false);
    expect(isDenied(parseDenylist('name alice'), alice)).toBe(true);
    expect(isDenied(parseDenylist('name carol'), carol)).toBe(true);
    expect(isDenied(parseDenylist('name carol'), invalid)).toBe(false);
    expect(isDenied(parseDenylist('owner alice-id'), alice)).toBe(true);
    expect(isDenied(parseDenylist('owner bob-id'), bob)).toBe(true);
    expect(isDenied(parseDenylist('owner bob-id'), alice)).toBe(false);
    expect(isDenied(parseDenylist(`content ${bundle.contentUri}`), alice)).toBe(true);
    expect(isDenied(parseDenylist(`content ${bundle.contentUri}`), bob)).toBe(false);
  });
});

describe('networks without a dash-sites contract', () => {
  it('gives readers a config with no contract instead of throwing', () => {
    expect(() => networkConfig('mainnet')).toThrow(/no contract on mainnet/);
    expect(readerConfig('mainnet')).toEqual({ network: 'mainnet', contractId: '' });
    expect(readerConfig('mainnet', 'override')).toEqual({ network: 'mainnet', contractId: 'override' });
    expect(readerConfig('testnet').contractId).toBe(networkConfig('testnet').contractId);
  });

  it('resolves registered names to no-site without asking for a site record', async () => {
    const platform = new MemoryPlatform();
    platform.registerName('alice', 'alice-id');
    await publishSite(platform.as('alice-id'), 'alice', buildSite([{ path: '/index.html', bytes: utf8.encode('x') }]));
    const inner = platform.as('reader');
    let siteReads = 0;
    const reader: PlatformReader = {
      noSiteContract: true,
      getDomain: (label) => inner.getDomain(label),
      getSite: (owner, domain) => {
        siteReads += 1;
        return inner.getSite(owner, domain);
      },
      getChunks: (owner, hashes) => inner.getChunks(owner, hashes),
    };
    expect(await resolveName(reader, 'alice')).toMatchObject({ status: 'no-site', ownerId: 'alice-id' });
    expect(await resolveName(reader, 'carol')).toMatchObject({ status: 'unregistered' });
    expect(siteReads).toBe(0);
  });
});
