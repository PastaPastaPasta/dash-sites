import { parseContentUri } from './content.js';
import { parseName } from './names.js';
import type { SiteBundle } from './pack.js';
import type { DomainRecord, PlatformWriter, SiteRecord } from './platform.js';
import { loadManifest, referencedChunks } from './reader.js';

export class NotOwnerError extends Error {
  constructor(name: string, reason: string) {
    super(`cannot publish to ${name}.dash: ${reason}`);
    this.name = 'NotOwnerError';
  }
}

export type PublishProgress =
  | { step: 'check' }
  | { step: 'upload'; done: number; total: number; hash: string }
  | { step: 'record' }
  | { step: 'done' };

export interface PublishResult {
  site: SiteRecord;
  uploaded: number;
  reused: number;
  creditsSpent: bigint;
}

const QUERY_BATCH = 100;

async function storedHashes(writer: PlatformWriter, hashes: string[]): Promise<Set<string>> {
  const present = new Set<string>();
  for (let i = 0; i < hashes.length; i += QUERY_BATCH) {
    const found = await writer.getChunks(writer.identityId, hashes.slice(i, i + QUERY_BATCH));
    for (const hash of found.keys()) present.add(hash);
  }
  return present;
}

/** Checks that the writer's identity owns `name`, and returns its domain record. */
export async function requireOwnedName(writer: PlatformWriter, name: string): Promise<DomainRecord> {
  const parsed = parseName(name);
  if (!parsed) throw new NotOwnerError(name, 'not a valid DPNS name');
  const domain = await writer.getDomain(parsed.normalized);
  if (!domain.value) throw new NotOwnerError(parsed.label, 'the name is not registered');
  if (domain.value.ownerId !== writer.identityId) throw new NotOwnerError(parsed.label, `it is owned by ${domain.value.ownerId}`);
  return domain.value;
}

/** Uploads the chunks the owner does not already store, then points the name at the new manifest. */
export async function publishSite(
  writer: PlatformWriter,
  name: string,
  bundle: SiteBundle,
  onProgress: (progress: PublishProgress) => void = () => {},
): Promise<PublishResult> {
  onProgress({ step: 'check' });
  const domain = await requireOwnedName(writer, name);
  const before = await writer.balance();
  const all = [...bundle.chunks.keys()];
  const present = await storedHashes(writer, all);
  const missing = all.filter((hash) => !present.has(hash));
  let done = 0;
  for (const hash of missing) {
    await writer.createChunk(hash, bundle.chunks.get(hash) as Uint8Array);
    done += 1;
    onProgress({ step: 'upload', done, total: missing.length, hash });
  }
  onProgress({ step: 'record' });
  const site = await writer.putSite(domain, bundle.contentUri);
  onProgress({ step: 'done' });
  return { site, uploaded: missing.length, reused: present.size, creditsSpent: before - (await writer.balance()) };
}

/** Points a name at content stored elsewhere, e.g. `ipfs://<cid>`. */
export async function publishPointer(writer: PlatformWriter, name: string, contentUri: string): Promise<SiteRecord> {
  if (!parseContentUri(contentUri)) throw new Error(`unsupported content URI: ${contentUri}`);
  return writer.putSite(await requireOwnedName(writer, name), contentUri);
}

/** Deletes the chunks no site of this identity references, and returns how many were deleted. */
export async function collectGarbage(writer: PlatformWriter, onDelete: (hash: string) => void = () => {}): Promise<number> {
  const keep = new Set<string>();
  const source = (hashes: string[]) => writer.getChunks(writer.identityId, hashes);
  for (const site of await writer.listSites()) {
    const ref = parseContentUri(site.content);
    if (ref?.scheme !== 'dash-manifest') continue;
    for (const hash of referencedChunks(ref, await loadManifest(ref, source))) keep.add(hash);
  }
  let deleted = 0;
  for (const chunk of await writer.listChunks()) {
    if (keep.has(chunk.hash)) continue;
    await writer.deleteChunk(chunk.id);
    onDelete(chunk.hash);
    deleted += 1;
  }
  return deleted;
}
