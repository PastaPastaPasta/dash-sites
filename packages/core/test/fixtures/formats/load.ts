import { readFileSync } from 'node:fs';
import type { ExternalSource } from '../../../src/external.js';
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

export function readFixture(name: (typeof FIXTURES)[number]): FormatFixture {
  return JSON.parse(readFileSync(new URL(`./${name}.json`, import.meta.url), 'utf8')) as FormatFixture;
}

/** Stores a fixture's record and chunks for `label`, owned by `ownerId`, as a writer of its time did. */
export async function storeFixture(platform: MemoryPlatform, fixture: FormatFixture, label: string, ownerId: string): Promise<SiteRecord> {
  const domain = platform.registerName(label, ownerId);
  const writer = platform.as(ownerId);
  const record = await writer.ensureSite(domain);
  for (const [hash, data] of Object.entries(fixture.chunks)) await writer.createChunk(record.id, hash, Uint8Array.from(Buffer.from(data, 'base64')));
  const site = await writer.putSite(domain, fixture.record.content);
  site.v = fixture.record.v;
  return site;
}

/** Serves a fixture's npm files the way the npm CDNs would. */
export const fixtureExternal =
  (fixture: FormatFixture): ExternalSource =>
  async (asset) => {
    const data = fixture.external?.[`${asset.npm}@${asset.version}/${asset.path}`];
    if (!data) throw new Error(`no such npm file: ${asset.npm}@${asset.version}/${asset.path}`);
    return Uint8Array.from(Buffer.from(data, 'base64'));
  };
