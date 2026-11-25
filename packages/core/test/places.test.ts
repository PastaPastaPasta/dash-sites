import { describe, expect, it } from 'vitest';
import {
  buildSite,
  ContentError,
  decodeManifest,
  ElsewhereError,
  encodeManifest,
  fetchPinned,
  httpsFetcher,
  ipfsFetcher,
  IPFS_MODULE,
  ManifestError,
  MAX_ELSEWHERE_FILE_BYTES,
  moduleUrls,
  PackError,
  parsePlace,
  readElsewhere,
  readFile,
  sha256Hex,
  startIpfs,
  UNKNOWN_PLACE,
  utf8,
  validateManifest,
  WRONG_BYTES,
  type Manifest,
  type PlaceFetchers,
  type SiteFile,
} from '../src/index.js';

const text = (s: string) => utf8.encode(s);
const big = new Uint8Array(40000).map((_, i) => (i * 7) % 251);
const FILES: SiteFile[] = [
  { path: '/index.html', bytes: text('<h1>hi</h1>'.repeat(100)) },
  { path: '/a.js', bytes: text('console.log(1)') },
  { path: '/b.bin', bytes: big },
];
const CID = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi';
const HTTPS = 'https://media.example.com/b.bin';
const IPFS = `ipfs://${CID}`;
const elsewhere = (src: string[]): SiteFile[] => FILES.map((file) => (file.path === '/b.bin' ? { ...file, src } : file));
const noChunks = async () => new Map<string, Uint8Array>();
const chunksOf = (bundle: ReturnType<typeof buildSite>) => async (hashes: string[]) => new Map(hashes.map((hash) => [hash, bundle.chunks.get(hash) as Uint8Array]));
const serving = (answers: Record<string, Uint8Array | number | Error>, seen: Array<[string, RequestInit]> = []) =>
  (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push([String(input), init ?? {}]);
    const answer = answers[String(input)];
    if (answer instanceof Error) throw answer;
    if (typeof answer === 'number' || answer === undefined) return new Response(null, { status: answer ?? 404 });
    return new Response(answer as BodyInit);
  }) as typeof fetch;
const using = (answers: Record<string, Uint8Array | number | Error>, seen?: Array<[string, RequestInit]>): PlaceFetchers => ({ https: httpsFetcher({ fetch: serving(answers, seen) }) });
const reading = (manifest: Manifest, fetchers: PlaceFetchers) =>
  readFile(manifest, '/b.bin', noChunks, (path, file) => readElsewhere(path, file, fetchers));
const canonical = (value: unknown): Uint8Array => {
  const sort = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(sort) : v !== null && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort((v as Record<string, unknown>)[k])])) : v;
  return utf8.encode(JSON.stringify(sort(value)));
};

describe('manifest version 2', () => {
  it('keeps a site with every file on Platform at version 1, byte for byte as before', () => {
    expect(buildSite(FILES).contentUri).toBe('dash-manifest:v1:ba353a13f3f8db0bfc814e7a0d37204acd74e13fc2165833c604d21c02765363');
    expect(buildSite(FILES, { spa: true }).contentUri).toBe('dash-manifest:v1:62db2ee52de0c633b7bb90e04e69dabb5f3f4aa8b39c587db23eccf501a2e69f');
    expect(buildSite(FILES).manifest.v).toBe(1);
    expect(buildSite(FILES).stats.elsewhere).toEqual({ files: 0, bytes: 0 });
  });

  it('lists where a file is instead of storing it', () => {
    const all = buildSite(FILES);
    const bundle = buildSite(elsewhere([IPFS, HTTPS]));
    expect(bundle.manifest.v).toBe(2);
    expect(bundle.manifest.files['/b.bin']).toEqual({ type: 'application/octet-stream', size: big.length, sha256: sha256Hex(big), parts: [], src: [IPFS, HTTPS] });
    expect(bundle.stats).toMatchObject({ files: 3, bytes: all.stats.bytes - big.length, elsewhere: { files: 1, bytes: big.length } });
    expect(bundle.stats.storedBytes).toBeLessThan(all.stats.storedBytes);
    expect(decodeManifest(encodeManifest(bundle.manifest))).toEqual(bundle.manifest);
    expect(() => validateManifest({ ...bundle.manifest, v: 1 })).toThrow(/unknown key src/);
  });

  it('does not count files stored elsewhere against the size a site may store', () => {
    const limits = { maxSiteBytes: 10_000, maxFiles: 10 };
    expect(() => buildSite(FILES, { limits })).toThrow(PackError);
    const bundle = buildSite(elsewhere([HTTPS]), { limits });
    expect(decodeManifest(encodeManifest(bundle.manifest), limits)).toEqual(bundle.manifest);
  });

  it('writes only places it can fetch', () => {
    for (const src of [[], ['http://media.example.com/b.bin'], ['https://user:pw@media.example.com/b.bin'], ['ar://abc'], ['ipfs://short'], [`${IPFS}?x=1`], [HTTPS, HTTPS], Array(9).fill(0).map((_, i) => `${HTTPS}?${i}`)]) {
      expect(() => buildSite(elsewhere(src)), JSON.stringify(src)).toThrow(PackError);
    }
    expect(() => buildSite([{ path: '/empty.bin', bytes: new Uint8Array(0), src: [HTTPS] }])).toThrow(/empty/);
    expect(buildSite(elsewhere(['https://MEDIA.example.com/b.bin'])).manifest.files['/b.bin']?.src).toEqual([HTTPS]);
    expect(() => buildSite(elsewhere([`https://media.example.com/${'"'.repeat(1000)}`]))).toThrow(PackError);
  });

  it('rejects a malformed list of places', () => {
    const { manifest } = buildSite(elsewhere([HTTPS]));
    const withFile = (patch: Record<string, unknown>) => ({ ...manifest, files: { ...manifest.files, '/b.bin': { ...manifest.files['/b.bin'], ...patch } } });
    for (const patch of [
      { src: [] },
      { src: 'https://media.example.com/b.bin' },
      { src: ['not a uri'] },
      { src: ['HTTPS://media.example.com/b.bin'] },
      { src: [HTTPS, HTTPS] },
      { src: Array(9).fill(0).map((_, i) => `${HTTPS}?${i}`) },
      { src: [`https://media.example.com/${'a'.repeat(2048)}`] },
      { parts: [[0, 0, 10]] },
      { enc: 'gzip' },
      { size: 0 },
      { size: MAX_ELSEWHERE_FILE_BYTES + 1 },
    ]) {
      expect(() => validateManifest(withFile(patch)), JSON.stringify(patch).slice(0, 80)).toThrow(ManifestError);
    }
  });
});

describe('forward compatibility', () => {
  const bundle = buildSite(elsewhere([HTTPS]));
  const later = {
    ...bundle.manifest,
    theme: { color: '#000' },
    files: {
      ...bundle.manifest.files,
      '/index.html': { ...bundle.manifest.files['/index.html'], enc: 'zstd' },
      '/a.js': { ...bundle.manifest.files['/a.js'], pieces: ['aa'] },
      '/b.bin': { ...bundle.manifest.files['/b.bin'], src: ['ar://kZ9', 'blossom:abc', HTTPS], pieces: ['bb'] },
    },
  };

  it('reads a version 2 manifest that carries things added later', async () => {
    const manifest = decodeManifest(canonical(later));
    expect(manifest).not.toHaveProperty('theme');
    expect(manifest.files['/a.js']).toEqual(bundle.manifest.files['/a.js']);
    expect(manifest.files['/b.bin']?.src).toEqual(['ar://kZ9', 'blossom:abc', HTTPS]);
    expect((await readFile(manifest, '/a.js', chunksOf(bundle))).bytes).toEqual(FILES[1]?.bytes);
    expect((await reading(manifest, using({ [HTTPS]: big }))).bytes).toEqual(big);
  });

  it('refuses only the file whose encoding it does not know', async () => {
    const manifest = decodeManifest(canonical(later));
    await expect(readFile(manifest, '/index.html', chunksOf(bundle))).rejects.toThrow(/a form this version cannot read/);
  });

  it('refuses a file only when it knows none of its places', async () => {
    const manifest = validateManifest({ ...later, files: { ...later.files, '/b.bin': { ...later.files['/b.bin'], src: ['ar://kZ9'] } } });
    const error = await reading(manifest, using({})).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ElsewhereError);
    expect((error as ElsewhereError).attempts).toEqual([{ place: 'ar://kZ9', problem: UNKNOWN_PLACE }]);
  });

  it('still holds version 1 and the canonical form strictly', () => {
    expect(() => validateManifest({ ...buildSite(FILES).manifest, theme: {} })).toThrow(/unknown key theme/);
    expect(() => validateManifest({ ...bundle.manifest, v: 3 })).toThrow(/unsupported version/);
    expect(() => decodeManifest(utf8.encode(JSON.stringify(later)))).toThrow(/canonical/);
    expect(() => decodeManifest(utf8.encode(`${utf8.decode(canonical(later))} `))).toThrow(/canonical/);
  });
});

describe('places', () => {
  it('knows HTTPS addresses and IPFS CIDs', () => {
    expect(parsePlace('https://Media.Example.com/a b.png')).toBeUndefined();
    expect(parsePlace('https://Media.Example.com/a%20b.png')).toEqual({ kind: 'https', uri: 'https://media.example.com/a%20b.png' });
    expect(parsePlace(IPFS)).toEqual({ kind: 'ipfs', uri: IPFS, cid: CID, path: '' });
    expect(parsePlace(`${IPFS}/img/hero.webp`)).toEqual({ kind: 'ipfs', uri: `${IPFS}/img/hero.webp`, cid: CID, path: '/img/hero.webp' });
    expect(parsePlace('ipfs://QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG')?.kind).toBe('ipfs');
    for (const uri of ['http://media.example.com/a', 'https://u:p@media.example.com/a', 'https://', 'ipfs://', 'ipfs://not-a-cid', `${IPFS}#frag`, 'ar://abc', 'data:text/plain,hi', '']) {
      expect(parsePlace(uri), uri).toBeUndefined();
    }
  });

  it('serves a file only when a place gives the published bytes', async () => {
    const { manifest } = buildSite(elsewhere([HTTPS]));
    const seen: Array<[string, RequestInit]> = [];
    expect((await reading(manifest, using({ [HTTPS]: big }, seen))).bytes).toEqual(big);
    expect(seen[0]?.[1]).toMatchObject({ credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'follow' });

    const tampered = big.slice();
    tampered[9] = (tampered[9] as number) ^ 0x80;
    const problem = async (answer: Uint8Array | number | Error) => ((await reading(manifest, using({ [HTTPS]: answer })).catch((e: unknown) => e)) as ElsewhereError).attempts?.[0]?.problem;
    expect(await problem(tampered)).toBe(WRONG_BYTES);
    expect(await problem(big.subarray(0, 100))).toBe(WRONG_BYTES);
    expect(await problem(new Uint8Array([...big, 1]))).toMatch(/more bytes/);
    expect(await problem(404)).toBe('it answered 404');
    expect(await problem(new TypeError('failed to fetch'))).toMatch(/could not be reached/);
  });

  it('tries the places in order and stops at the first that works', async () => {
    const mirror = 'https://mirror.example.org/b.bin';
    const { manifest } = buildSite(elsewhere([HTTPS, mirror, IPFS]));
    const seen: Array<[string, RequestInit]> = [];
    expect((await reading(manifest, using({ [HTTPS]: 503, [mirror]: big }, seen))).bytes).toEqual(big);
    expect(seen.map(([url]) => url)).toEqual([HTTPS, mirror]);

    const error = (await reading(manifest, using({ [mirror]: text('other') })).catch((e: unknown) => e)) as ElsewhereError;
    expect(error).toBeInstanceOf(ContentError);
    expect(error.attempts).toEqual([
      { place: HTTPS, problem: 'it answered 404' },
      { place: mirror, problem: WRONG_BYTES },
      { place: IPFS, problem: UNKNOWN_PLACE },
    ]);
  });

  it('checks what it is handed even when the fetching is done by someone else', async () => {
    const { manifest } = buildSite(elsewhere([HTTPS]));
    await expect(readFile(manifest, '/b.bin', noChunks, async () => text('other'))).rejects.toThrow(/does not match its hash/);
    await expect(readFile(manifest, '/b.bin', noChunks)).rejects.toThrow(ElsewhereError);
  });

  it('gives up on a download that stalls', async () => {
    const { manifest } = buildSite(elsewhere([HTTPS]));
    const stalled = (async () => new Response(new ReadableStream<Uint8Array>({ start: (controller) => controller.enqueue(big.subarray(0, 10)) }))) as typeof fetch;
    const error = (await reading(manifest, { https: httpsFetcher({ fetch: stalled, idleMs: 20 }) }).catch((e: unknown) => e)) as ElsewhereError;
    expect(error.attempts[0]?.problem).toBe('the download stalled');
  });

  it('moves on from a place that never answers, even one that ignores being told to stop', async () => {
    const mirror = 'https://mirror.example.org/b.bin';
    const { manifest } = buildSite(elsewhere([IPFS, HTTPS, mirror]));
    const never = new Promise<never>(() => undefined);
    const deaf = (async (input: RequestInfo | URL) => (String(input) === HTTPS ? never : new Response(big as BodyInit))) as typeof fetch;
    const fetchers: PlaceFetchers = { https: httpsFetcher({ fetch: deaf, idleMs: 20 }), ipfs: ipfsFetcher(() => never, { waitMs: 20 }) };
    expect((await reading(manifest, fetchers)).bytes).toEqual(big);
    const { manifest: only } = buildSite(elsewhere([IPFS, HTTPS]));
    expect(((await reading(only, fetchers).catch((e: unknown) => e)) as ElsewhereError).attempts.map(({ problem }) => problem)).toEqual(['it did not answer', 'it did not answer']);
  });

  it('fetches IPFS places through the IPFS client, started on first use', async () => {
    const { manifest } = buildSite(elsewhere([IPFS]));
    let started = 0;
    const asked: string[] = [];
    const ipfs = ipfsFetcher(async () => {
      started += 1;
      return async (resource) => {
        asked.push(resource);
        return new Response(big as BodyInit);
      };
    });
    expect(started).toBe(0);
    expect((await reading(manifest, { ipfs })).bytes).toEqual(big);
    expect(asked).toEqual([IPFS]);
    const none = ipfsFetcher(async () => async () => new Response(null, { status: 504 }));
    expect(((await reading(manifest, { ipfs: none }).catch((e: unknown) => e)) as ElsewhereError).attempts[0]?.problem).toBe('it answered 504');
  });
});

describe('the pinned IPFS module', () => {
  const source = text('module.exports = { createVerifiedFetch: async (init) => async (resource) => new Response(JSON.stringify({ init, resource })) };');
  const module = { package: '@scope/pkg', version: '1.2.3', file: 'dist/index.min.js', sha256: sha256Hex(source), size: source.length };
  const [first, second] = moduleUrls(module) as [string, string];

  it('comes from an npm mirror by exact version', () => {
    expect([first, second]).toEqual(['https://cdn.jsdelivr.net/npm/@scope/pkg@1.2.3/dist/index.min.js', 'https://unpkg.com/@scope/pkg@1.2.3/dist/index.min.js']);
    expect(IPFS_MODULE.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(IPFS_MODULE.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is used only when it matches the pinned hash, from whichever mirror serves it', async () => {
    expect(await fetchPinned(module, { fetch: serving({ [first]: source }) })).toEqual(source);
    expect(await fetchPinned(module, { fetch: serving({ [first]: text('evil()'), [second]: source }) })).toEqual(source);
    await expect(fetchPinned(module, { fetch: serving({ [first]: text('evil()'), [second]: 500 }) })).rejects.toThrow(/cdn\.jsdelivr\.net: .*not the file.*unpkg\.com: it answered 500/);
  });

  it('starts with recursive gateways turned off', async () => {
    const verifiedFetch = await startIpfs(source, { routers: ['https://router.example'] });
    expect(await (await verifiedFetch(IPFS)).json()).toEqual({ init: { gateways: [], routers: ['https://router.example'] }, resource: IPFS });
    expect(await (await (await startIpfs(source))(IPFS)).json()).toEqual({ init: { gateways: [] }, resource: IPFS });
    expect(() => startIpfs(text('module.exports = {};'))).toThrow(/not the one this version was built for/);
  });
});
