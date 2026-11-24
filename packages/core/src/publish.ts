import { parseContentUri } from './content.js';
import { parseName } from './names.js';
import type { SiteBundle } from './pack.js';
import type { DomainRecord, PlatformWriter, SiteRecord, StoredChunk } from './platform.js';
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
  /** With `prune`: the chunks of releases before the one replaced, deleted after the record changed. */
  pruned?: PrunePlan & { deleted: number };
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
  options: { prune?: PruneOptions } = {},
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
  // Planned while the record still names the release being replaced, so that release is kept
  // and only older ones go, once the record being replaced has been live for the grace period.
  const plan = options.prune ? await planPrune(writer, { ...options.prune, keep: [...all, ...(options.prune.keep ?? [])] }) : undefined;
  onProgress({ step: 'record' });
  const site = await writer.putSite(domain, bundle.contentUri);
  const pruned = plan ? { ...plan, deleted: await prune(writer, plan) } : undefined;
  onProgress({ step: 'done' });
  return { site, uploaded: missing.length, reused: present.size, creditsSpent: before - (await writer.balance()), ...(pruned ? { pruned } : {}) };
}

/** Points a name at content stored elsewhere, e.g. `ipfs://<cid>`. */
export async function publishPointer(writer: PlatformWriter, name: string, contentUri: string): Promise<SiteRecord> {
  if (!parseContentUri(contentUri)) throw new Error(`unsupported content URI: ${contentUri}`);
  return writer.putSite(await requireOwnedName(writer, name), contentUri);
}

/**
 * How long a site record must have been live before the chunks it replaced are deleted. Readers
 * that resolved the name just before an update (a service worker reuses an answer for 30 seconds,
 * a gateway caches longer, a lagging node can prove an older record) still fetch the old chunks.
 */
export const DEFAULT_PRUNE_GRACE_MS = 24 * 60 * 60 * 1000;

export interface PruneOptions {
  /** Chunks to keep besides those the identity's site records reference, e.g. a release about to be published. */
  keep?: Iterable<string>;
  graceMs?: number;
  now?: number;
}

export interface PrunePlan {
  /** Chunks of this identity that no site record references, with their stored size. */
  remove: Array<StoredChunk & { bytes: number }>;
  bytes: number;
  kept: number;
  /** Set when nothing may be deleted yet: a site record changed less than the grace period before. */
  deferredUntil?: number;
}

/**
 * Finds the chunks the identity can delete: its own chunks that no site record of the identity
 * references (chunks are read by owner, so no other identity's site can use them). While any of
 * its records changed within the grace period, the chunks that record replaced cannot be told
 * apart from the rest, so nothing is deleted.
 */
export async function planPrune(writer: PlatformWriter, options: PruneOptions = {}): Promise<PrunePlan> {
  const graceMs = options.graceMs ?? DEFAULT_PRUNE_GRACE_MS;
  const now = options.now ?? Date.now();
  const sites = await writer.listSites();
  const newest = Math.max(0, ...sites.map((site) => site.updatedAt));
  if (graceMs > 0 && newest > now - graceMs) return { remove: [], bytes: 0, kept: 0, deferredUntil: newest + graceMs };

  const keep = new Set<string>(options.keep);
  const source = (hashes: string[]) => writer.getChunks(writer.identityId, hashes);
  for (const site of sites) {
    const ref = parseContentUri(site.content);
    if (ref?.scheme !== 'dash-manifest') continue;
    for (const hash of referencedChunks(ref, await loadManifest(ref, source))) keep.add(hash);
  }
  const stored = await writer.listChunks();
  const unused = stored.filter((chunk) => !keep.has(chunk.hash));
  const sizes = new Map<string, number>();
  for (let i = 0; i < unused.length; i += QUERY_BATCH) {
    for (const [hash, data] of await source(unused.slice(i, i + QUERY_BATCH).map((chunk) => chunk.hash))) sizes.set(hash, data.length);
  }
  const remove = unused.map((chunk) => ({ ...chunk, bytes: sizes.get(chunk.hash) ?? 0 }));
  return { remove, bytes: remove.reduce((sum, chunk) => sum + chunk.bytes, 0), kept: stored.length - remove.length };
}

/** Deletes the chunks a plan lists, and returns how many were deleted. */
export async function prune(writer: PlatformWriter, plan: PrunePlan, onDelete: (hash: string) => void = () => {}): Promise<number> {
  for (const chunk of plan.remove) {
    await writer.deleteChunk(chunk.id);
    onDelete(chunk.hash);
  }
  return plan.remove.length;
}

/** Deletes the chunks no site of this identity references, once every record is older than the grace period. */
export async function collectGarbage(writer: PlatformWriter, options: PruneOptions & { onDelete?: (hash: string) => void } = {}): Promise<PrunePlan & { deleted: number }> {
  const plan = await planPrune(writer, options);
  return { ...plan, deleted: await prune(writer, plan, options.onDelete) };
}
