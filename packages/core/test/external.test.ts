import { brotliCompressSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  buildSite,
  cdnSource,
  ContentError,
  decodeManifest,
  encodeManifest,
  ExternalAssetError,
  externalUrls,
  integrityOf,
  isExternalAsset,
  PackError,
  readFile,
  checkExternalAssets,
  utf8,
  validateManifest,
  type SiteFile,
} from '../src/index.js';

const text = (s: string) => utf8.encode(s);
const big = new Uint8Array(40000).map((_, i) => (i * 7) % 251);
const FILES: SiteFile[] = [
  { path: '/index.html', bytes: text('<h1>hi</h1>'.repeat(100)) },
  { path: '/a.js', bytes: text('console.log(1)') },
  { path: '/b.bin', bytes: big },
];
const EXT = { '/b.bin': { npm: '@dashevo/wasm-sdk', version: '5.0.0-rc.8', path: 'dist/raw/wasm_sdk_bg.wasm' } };
const brotli = (data: Uint8Array) => new Uint8Array(brotliCompressSync(data));
const noChunks = async () => new Map<string, Uint8Array>();

describe('manifest versions', () => {
  it('keeps a site without new features at version 1, byte for byte as before', () => {
    // Content URIs computed with the code before external assets and brotli existed.
    expect(buildSite(FILES).contentUri).toBe('dash-manifest:v1:ba353a13f3f8db0bfc814e7a0d37204acd74e13fc2165833c604d21c02765363');
    expect(buildSite(FILES, { spa: true }).contentUri).toBe('dash-manifest:v1:62db2ee52de0c633b7bb90e04e69dabb5f3f4aa8b39c587db23eccf501a2e69f');
    expect(buildSite(FILES).manifest.v).toBe(1);
  });

  it('uses version 2 only for external assets or brotli, and rejects them in version 1', () => {
    const ext = buildSite(FILES, { external: EXT });
    expect(ext.manifest.v).toBe(2);
    expect(ext.manifest.files['/b.bin']).toMatchObject({ parts: [], ext: { ...EXT['/b.bin'], integrity: integrityOf(big) } });
    expect(decodeManifest(encodeManifest(ext.manifest))).toEqual(ext.manifest);
    expect(() => validateManifest({ ...ext.manifest, v: 1 })).toThrow(/unknown key ext/);

    const br = buildSite(FILES, { brotli });
    expect(br.manifest.v).toBe(2);
    expect(br.manifest.files['/index.html']?.enc).toBe('br');
    expect(() => validateManifest({ ...br.manifest, v: 1 })).toThrow(/bad enc/);
    expect(() => validateManifest({ ...buildSite(FILES).manifest, v: 2 })).toThrow(/without a version 2 feature/);
  });

  it('pins exact versions and safe paths only', () => {
    const base = { npm: 'pkg', version: '1.2.3', path: 'dist/a.wasm', integrity: integrityOf(big) };
    expect(isExternalAsset(base)).toBe(true);
    expect(isExternalAsset({ ...base, version: '5.0.0-rc.8' })).toBe(true);
    for (const version of ['^1.2.3', '~1.2.3', 'latest', '1.2', '1.2.x', '>=1.0.0', '1.2.3 || 2.0.0', '1.2.3+build', '1.0.0-01', '01.2.3']) {
      expect(isExternalAsset({ ...base, version })).toBe(false);
    }
    for (const path of ['../x', '/abs', 'a/../b', 'a//b', 'a?b', 'a#b', 'a%2e', '+esm', 'dist/+esm']) expect(isExternalAsset({ ...base, path })).toBe(false);
    expect(isExternalAsset({ ...base, path: 'dist/a+b.js' })).toBe(true);
    for (const npm of ['Upper', '../x', '@scope', 'a b']) expect(isExternalAsset({ ...base, npm })).toBe(false);
    expect(isExternalAsset({ ...base, integrity: 'sha256-abc' })).toBe(false);
    expect(isExternalAsset({ ...base, extra: 1 })).toBe(false);
    expect(() => buildSite(FILES, { external: { '/b.bin': { ...EXT['/b.bin'], version: 'latest' } } })).toThrow(PackError);
    expect(() => buildSite(FILES, { external: { '/b.bin': { ...EXT['/b.bin'], integrity: integrityOf(text('other')) } } })).toThrow(/does not match/);
    expect(() => buildSite(FILES, { external: { '/missing.bin': EXT['/b.bin'] } })).toThrow(/not a file of the site/);
  });

  it('builds CDN addresses from the pinned package and nothing else', () => {
    expect(externalUrls({ ...EXT['/b.bin'], integrity: integrityOf(big) })).toEqual([
      'https://cdn.jsdelivr.net/npm/@dashevo/wasm-sdk@5.0.0-rc.8/dist/raw/wasm_sdk_bg.wasm',
      'https://unpkg.com/@dashevo/wasm-sdk@5.0.0-rc.8/dist/raw/wasm_sdk_bg.wasm',
    ]);
  });
});

describe('manifest checks', () => {
  it('rejects an external file that also has stored parts or an encoding', () => {
    const { manifest } = buildSite(FILES, { external: EXT });
    const entry = manifest.files['/b.bin']!;
    expect(() => validateManifest({ ...manifest, files: { ...manifest.files, '/b.bin': { ...entry, parts: [[0, 0, 1]] } } })).toThrow(/ext with stored parts/);
    expect(() => validateManifest({ ...manifest, files: { ...manifest.files, '/b.bin': { ...entry, enc: 'gzip' } } })).toThrow(/ext with stored parts/);
  });
});

describe('publishing checks', () => {
  it('requires every CDN to serve each external file with its hash', async () => {
    const { manifest } = buildSite(FILES, { external: EXT });
    const ok = await checkExternalAssets(manifest.files, async () => new Response(big));
    expect(ok.map((r) => r.result)).toEqual(['ok', 'ok']);
    const generated = await checkExternalAssets(manifest.files, async (url) => (String(url).includes('unpkg') ? new Response(null, { status: 404 }) : new Response(big)));
    expect(generated.map((r) => r.result)).toEqual(['ok', 'mismatch']);
    const down = await checkExternalAssets(manifest.files, async () => {
      throw new TypeError('fetch failed');
    });
    expect(down.map((r) => r.result)).toEqual(['unreachable', 'unreachable']);
  });
});

describe('stalled CDNs', () => {
  it('falls through to the next CDN when one never answers or stops sending', async () => {
    const { manifest } = buildSite(FILES, { external: EXT });
    const hang = cdnSource(
      async (url) => (String(url).includes('jsdelivr') ? new Promise<Response>(() => {}) : new Response(big)),
      { headersMs: 20, idleMs: 20 },
    );
    expect((await readFile(manifest, '/b.bin', noChunks, hang)).bytes).toEqual(big);
    const trickle = cdnSource(
      async (url) =>
        String(url).includes('jsdelivr')
          ? new Response(new ReadableStream({ start: (c) => c.enqueue(big.subarray(0, 10)) }))
          : new Response(big),
      { headersMs: 20, idleMs: 20 },
    );
    expect((await readFile(manifest, '/b.bin', noChunks, trickle)).bytes).toEqual(big);
  });

  it('says when every CDN no longer has the file', async () => {
    const { manifest } = buildSite(FILES, { external: EXT });
    const gone = cdnSource(async () => new Response(null, { status: 404 }));
    const error = await readFile(manifest, '/b.bin', noChunks, gone).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ExternalAssetError);
    expect((error as ExternalAssetError).missing).toBe(true);
    expect((error as ExternalAssetError).mismatch).toBe(false);
  });

  it('keeps the v1 content URI prefix for a version 2 manifest, which older collectors parse', () => {
    expect(buildSite(FILES, { external: EXT }).contentUri.startsWith('dash-manifest:v1:')).toBe(true);
    expect(buildSite(FILES, { brotli }).contentUri.startsWith('dash-manifest:v1:')).toBe(true);
  });
});

describe('reading', () => {
  it('decodes brotli files and refuses output larger than the declared size', async () => {
    const bundle = buildSite(FILES, { brotli });
    const source = async (hashes: string[]) => new Map(hashes.map((hash) => [hash, bundle.chunks.get(hash) as Uint8Array]));
    expect((await readFile(bundle.manifest, '/index.html', source)).bytes).toEqual(FILES[0]?.bytes);
    const lying = { ...bundle.manifest, files: { ...bundle.manifest.files, '/index.html': { ...bundle.manifest.files['/index.html']!, size: 10 } } };
    await expect(readFile(lying, '/index.html', source)).rejects.toThrow(ContentError);
  });

  it('serves an external file only with the published hash', async () => {
    const { manifest } = buildSite(FILES, { external: EXT });
    const serving = (bytes: Uint8Array, status = 200) => cdnSource(async () => new Response(status === 200 ? bytes : null, { status }));
    expect((await readFile(manifest, '/b.bin', noChunks, serving(big))).bytes).toEqual(big);
    const tampered = big.slice();
    tampered[9] ^= 0x80;
    await expect(readFile(manifest, '/b.bin', noChunks, serving(tampered))).rejects.toThrow(ExternalAssetError);
    await expect(readFile(manifest, '/b.bin', noChunks, serving(big, 404))).rejects.toThrow(/HTTP 404/);
    await expect(readFile(manifest, '/b.bin', noChunks, serving(new Uint8Array([...big, 1])))).rejects.toThrow(/wrong size/);
    // A compressed transfer reports its compressed length; only the decoded bytes are counted.
    const encoded = cdnSource(async () => new Response(big, { headers: { 'content-length': '7', 'content-encoding': 'br' } }));
    expect((await readFile(manifest, '/b.bin', noChunks, encoded)).bytes).toEqual(big);
    // An external source that skips the check is caught by the reader.
    await expect(readFile(manifest, '/b.bin', noChunks, async () => tampered)).rejects.toThrow(ContentError);
  });

  it('never follows a redirect away from the CDN', async () => {
    const { manifest } = buildSite(FILES, { external: EXT });
    const inits: RequestInit[] = [];
    const source = cdnSource(async (_url, init) => {
      inits.push(init ?? {});
      throw new TypeError('redirect refused');
    });
    await expect(readFile(manifest, '/b.bin', noChunks, source)).rejects.toThrow(ExternalAssetError);
    expect(inits.every((init) => init.redirect === 'error' && init.credentials === 'omit')).toBe(true);
  });
});
