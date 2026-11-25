import { parseContentUri } from './content.js';
import { estimateCredits, formatDash } from './cost.js';
import { parseName } from './names.js';
import type { SiteBundle } from './pack.js';
import type { DomainRecord, PlatformWriter, SiteRecord } from './platform.js';
import { loadManifest, referencedChunks } from './reader.js';
import { isCurrent, resolveName } from './resolve.js';

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

async function storedHashes(writer: PlatformWriter, siteId: string, hashes: string[]): Promise<Set<string>> {
  const present = new Set<string>();
  for (let i = 0; i < hashes.length; i += QUERY_BATCH) {
    const found = await writer.getChunks(siteId, hashes.slice(i, i + QUERY_BATCH));
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

/**
 * Uploads the chunks the site does not already store, then points the name at the new manifest.
 * Chunks are stored under the owner's site record, so a first publish writes that record empty
 * before the chunks.
 */
export async function publishSite(
  writer: PlatformWriter,
  name: string,
  bundle: SiteBundle,
  onProgress: (progress: PublishProgress) => void = () => {},
): Promise<PublishResult> {
  onProgress({ step: 'check' });
  const domain = await requireOwnedName(writer, name);
  const before = await writer.balance();
  const existing = (await writer.listSites()).find((site) => site.normalizedLabel === domain.normalizedLabel);
  if (!existing && before < estimateCredits(bundle)) throw new Error(`the identity holds ${formatDash(before)}, and this site costs about ${formatDash(estimateCredits(bundle))} to store`);
  const record = existing ?? (await writer.ensureSite(domain));
  const all = [...bundle.chunks.keys()];
  const present = await storedHashes(writer, record.id, all);
  const missing = all.filter((hash) => !present.has(hash));
  let done = 0;
  for (const hash of missing) {
    await writer.createChunk(record.id, hash, bundle.chunks.get(hash) as Uint8Array);
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

/**
 * Takes down the site of a name the writer owns by writing its record without content: Platform
 * never deletes a site record. Returns false when there was no site.
 */
export async function unpublishSite(writer: PlatformWriter, name: string): Promise<boolean> {
  const domain = await requireOwnedName(writer, name);
  const { status } = await resolveName(writer, domain.normalizedLabel);
  if (status !== 'ok' && status !== 'unsupported') return false;
  await writer.putSite(domain);
  return true;
}

/**
 * Deletes the chunks this identity's sites no longer use, and returns how many were deleted.
 * A record keeps the chunks of its site while it is the record the name shows. An answer that
 * says otherwise counts only when it is from a block as late as the record: a node can answer
 * from an earlier one.
 */
export async function collectGarbage(writer: PlatformWriter, onDelete: (hash: string) => void = () => {}): Promise<number> {
  let deleted = 0;
  for (const site of await writer.listSites()) {
    const name = await writer.getName(site.normalizedLabel);
    const read = name.value?.site;
    const record = read?.id === site.id && read.revision > site.revision ? read : site;
    const shown = name.value ? isCurrent(name.value.domain, record) : false;
    const ref = (shown || name.meta.timeMs < record.updatedAt) && record.content !== undefined ? parseContentUri(record.content) : undefined;
    const keep = ref?.scheme === 'dash-manifest' ? referencedChunks(ref, await loadManifest(ref, (hashes) => writer.getChunks(site.id, hashes))) : new Set<string>();
    for (const chunk of await writer.listChunks(site.id)) {
      if (keep.has(chunk.hash)) continue;
      await writer.deleteChunk(chunk.id);
      onDelete(chunk.hash);
      deleted += 1;
    }
  }
  return deleted;
}
