import { readFileSync } from 'node:fs';
import { sha256Hex, utf8 } from '../../../src/bytes.js';
import { formatContentUri } from '../../../src/content.js';
import type { ExternalSource } from '../../../src/external.js';
import { gzip } from '../../../src/gzip.js';
import type { MemoryPlatform } from '../../../src/memory.js';
import type { SiteRecord } from '../../../src/platform.js';

export interface FormatFixture {
  about: string;
  record: { v: number; content: string };
  manifestVersion: number;
  /** sha256 of every file the site serves, by path. */
  files: Record<string, string>;
  /** Stored chunks, base64, by hash. */
  chunks: Record<string, string>;
  /** Files of npm packages the site names but does not store, base64, by `package@version/path`. */
  external?: Record<string, string>;
}

export const FIXTURES = ['site-v1', 'site-v2'] as const;

const fromBase64 = (data: string): Uint8Array => Uint8Array.from(Buffer.from(data, 'base64'));

export function readFixture(name: (typeof FIXTURES)[number]): FormatFixture {
  return JSON.parse(readFileSync(new URL(`./${name}.json`, import.meta.url), 'utf8')) as FormatFixture;
}

/** Stores a fixture's record and chunks for `label`, owned by `ownerId`, as a writer of its time did. */
export async function storeFixture(platform: MemoryPlatform, fixture: FormatFixture, label: string, ownerId: string): Promise<SiteRecord> {
  const domain = platform.registerName(label, ownerId);
  const writer = platform.as(ownerId);
  const record = await writer.ensureSite(domain);
  for (const [hash, data] of Object.entries(fixture.chunks)) await writer.createChunk(record.id, hash, fromBase64(data));
  const site = await writer.putSite(domain, fixture.record.content);
  site.v = fixture.record.v;
  return site;
}

/** Serves a fixture's npm files the way the npm CDNs would. */
export const fixtureExternal =
  (fixture: FormatFixture): ExternalSource =>
  async (asset) => {
    const key = `${asset.npm}@${asset.version}/${asset.path}`;
    const data = fixture.external?.[key];
    if (!data) throw new Error(`no such npm file: ${key}`);
    return fromBase64(data);
  };

/** Points `site` at a manifest of format `version`, stored as its owner would store one. */
export async function storeManifestVersion(platform: MemoryPlatform, site: SiteRecord, version: number): Promise<void> {
  const piece = gzip(utf8.encode(JSON.stringify({ v: version, chunks: [], files: {} })));
  const hash = sha256Hex(piece);
  await platform.as(site.ownerId).createChunk(site.id, hash, piece);
  site.content = formatContentUri({ scheme: 'dash-manifest', chunks: [hash] });
}
