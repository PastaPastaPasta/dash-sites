import { describe, expect, it } from 'vitest';
import {
  buildSite,
  FORMATS,
  loadManifest,
  NewerFormatError,
  publishPointer,
  publishSite,
  readFile,
  resolveName,
  sha256Hex,
  utf8,
  unpublishSite,
  type Resolution,
} from '../src/index.js';
import { MemoryPlatform } from '../src/memory.js';
import { FIXTURES, fixtureExternal, readFixture, storeFixture, storeManifestVersion } from './fixtures/formats/load.js';

const ok = (resolution: Resolution) => {
  if (resolution.status !== 'ok' || resolution.content.scheme !== 'dash-manifest') throw new Error(`expected a stored site, got ${resolution.status}`);
  return resolution as Extract<Resolution, { status: 'ok' }> & { content: { scheme: 'dash-manifest'; chunks: string[] } };
};

describe('stored formats', () => {
  for (const name of FIXTURES) {
    it(`still reads ${name}, a site stored by an earlier version`, async () => {
      const fixture = readFixture(name);
      const platform = new MemoryPlatform();
      await storeFixture(platform, fixture, 'fixture', 'owner-id');
      const resolution = ok(await resolveName(platform.as('anyone'), 'fixture'));
      expect(resolution.site.content).toBe(fixture.record.content);
      const source = (hashes: string[]) => platform.as('anyone').getChunks(resolution.site.id, hashes);
      const manifest = await loadManifest(resolution.content, source);
      expect(manifest.v).toBe(fixture.manifestVersion);
      expect(Object.keys(manifest.files).sort()).toEqual(Object.keys(fixture.files).sort());
      for (const [path, sha256] of Object.entries(fixture.files)) {
        const file = await readFile(manifest, path, source, { external: fixtureExternal(fixture) });
        expect(sha256Hex(file.bytes)).toBe(sha256);
      }
    });
  }

  it('reads every format up to the versions it claims', () => {
    expect(FORMATS).toEqual({ site: 1, chunk: 1, contentUri: 1, manifest: 2 });
    const versions = FIXTURES.map((name) => readFixture(name).manifestVersion);
    for (let v = 1; v <= FORMATS.manifest; v++) expect(versions).toContain(v);
  });

  it('writes the lowest version that holds a site, so readers that are behind still open it', async () => {
    const platform = new MemoryPlatform();
    platform.registerName('plain', 'owner-id');
    const bundle = buildSite([{ path: '/index.html', bytes: utf8.encode('<p>plain</p>') }]);
    expect(bundle.manifest.v).toBe(1);
    expect(bundle.contentUri.startsWith('dash-manifest:v1:')).toBe(true);
    const writer = platform.as('owner-id');
    const site = await writer.putSite(platform.domains.get('p1a1n')!, bundle.contentUri);
    expect(site.v).toBe(1);
  });
});

describe('newer formats', () => {
  const stored = async () => {
    const fixture = readFixture('site-v1');
    const platform = new MemoryPlatform();
    const site = await storeFixture(platform, fixture, 'fixture', 'owner-id');
    return { platform, site, reader: platform.as('anyone') };
  };

  it('calls a site record of a newer format newer, not missing or broken', async () => {
    const { reader, site } = await stored();
    site.v = FORMATS.site + 1;
    expect(await resolveName(reader, 'fixture')).toMatchObject({ status: 'unsupported', reason: 'newer' });
    delete site.content;
    expect(await resolveName(reader, 'fixture')).toMatchObject({ status: 'unsupported', reason: 'newer' });
  });

  it('tells a content URI of a later version from one this project never defined', async () => {
    const { reader, site } = await stored();
    site.content = site.content!.replace('dash-manifest:v1:', `dash-manifest:v${FORMATS.contentUri + 1}:`);
    expect(await resolveName(reader, 'fixture')).toMatchObject({ status: 'unsupported', reason: 'newer' });
    site.content = 'https://example.com/site';
    expect(await resolveName(reader, 'fixture')).toMatchObject({ status: 'unsupported', reason: 'unknown' });
  });

  it('refuses a manifest of a newer version as newer, not as damaged', async () => {
    const { platform, site, reader } = await stored();
    await storeManifestVersion(platform, site, FORMATS.manifest + 1);
    const resolution = ok(await resolveName(reader, 'fixture'));
    const error = await loadManifest(resolution.content, (hashes) => reader.getChunks(site.id, hashes)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NewerFormatError);
    expect(error).toMatchObject({ format: 'manifest', version: FORMATS.manifest + 1 });
  });

  it('does not let this version rewrite a record of a newer format, which would drop what it cannot read', async () => {
    const { platform, site } = await stored();
    site.v = FORMATS.site + 1;
    const writer = platform.as('owner-id');
    const chunks = platform.chunks.size;
    const bundle = buildSite([{ path: '/index.html', bytes: utf8.encode('<p>older writer</p>') }]);
    await expect(publishSite(writer, 'fixture', bundle)).rejects.toBeInstanceOf(NewerFormatError);
    expect(platform.chunks.size).toBe(chunks);
    await expect(unpublishSite(writer, 'fixture')).rejects.toBeInstanceOf(NewerFormatError);
    await expect(publishPointer(writer, 'fixture', `ipfs://${'b'.repeat(59)}`)).rejects.toBeInstanceOf(NewerFormatError);
    expect(site.v).toBe(FORMATS.site + 1);
  });

  it('refuses a chunk of a newer format as newer', async () => {
    const { platform, site, reader } = await stored();
    for (const chunk of platform.chunks.values()) if (chunk.siteId === site.id) chunk.v = FORMATS.chunk + 1;
    const resolution = ok(await resolveName(reader, 'fixture'));
    await expect(loadManifest(resolution.content, (hashes) => reader.getChunks(site.id, hashes))).rejects.toBeInstanceOf(NewerFormatError);
  });
});
