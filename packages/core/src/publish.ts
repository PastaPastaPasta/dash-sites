import { parseContentUri } from './content.js';
import { isNewer, refuseNewer } from './formats.js';
import { estimateCredits, formatDash, type FeeModel } from './cost.js';
import { parseName } from './names.js';
import type { SiteBundle } from './pack.js';
import type { DomainRecord, PlatformWriter, Proved, SiteRecord, StoredChunk } from './platform.js';
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
  /** With `prune`: the chunks of releases before the one replaced, deleted after the record changed. */
  pruned?: PruneResult;
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
  options: { prune?: PruneOptions & PruneRunOptions; fees?: FeeModel } = {},
): Promise<PublishResult> {
  onProgress({ step: 'check' });
  const domain = await requireOwnedName(writer, name);
  const before = await writer.balance();
  const existing = (await writer.listSites()).find((site) => site.normalizedLabel === domain.normalizedLabel);
  const needed = !existing && options.fees ? estimateCredits(bundle, options.fees) : 0n;
  if (before < needed) throw new Error(`the identity holds ${formatDash(before)}, and this site costs about ${formatDash(needed)} to store`);
  const record = existing ?? (await writer.ensureSite(domain));
  // An older writer must not rewrite a newer record, which would drop what it cannot read; refuse before paying for chunks.
  refuseNewer('site', record.v);
  const all = [...bundle.chunks.keys()];
  const present = await storedHashes(writer, record.id, all);
  const missing = all.filter((hash) => !present.has(hash));
  let uploaded = 0;
  const upload = async (hashes: string[], total: number) => {
    for (const hash of hashes) {
      await writer.createChunk(record.id, hash, bundle.chunks.get(hash) as Uint8Array);
      uploaded += 1;
      onProgress({ step: 'upload', done: uploaded, total, hash });
    }
  };
  await upload(missing, missing.length);
  // A chunk reused from an earlier release may have been deleted by a gc in another tab during the upload.
  const still = await storedHashes(writer, record.id, [...present]);
  const lost = [...present].filter((hash) => !still.has(hash));
  await upload(lost, missing.length + lost.length);
  let replaced: SiteRecord | undefined;
  let replacedError: string | undefined;
  if (options.prune) {
    try {
      replaced = (await writer.listSites()).find((site) => site.id === record.id);
    } catch (error) {
      replacedError = String((error as Error)?.message ?? error);
    }
  }
  onProgress({ step: 'record' });
  const site = await writer.putSite(domain, bundle.contentUri);
  // The record is live whatever happens to the prune, so a prune that cannot run is reported, not thrown.
  let pruned: PruneResult | undefined;
  if (options.prune) {
    try {
      if (replacedError) throw new PruneError(`the record being replaced could not be read (${replacedError})`);
      // A node behind the chain can answer with an older record; only the one this write replaced will do.
      if (replaced ? replaced.id !== site.id || replaced.revision !== site.revision - 1 : site.revision !== 1) {
        throw new PruneError('the record read before publishing is not the one this publish replaced');
      }
      const plan = await planPrune(writer, { ...options.prune, keep: [...all, ...(options.prune.keep ?? [])], published: { site, replaced } });
      pruned = await prune(writer, plan, options.prune);
    } catch (error) {
      pruned = { remove: [], bytes: 0, kept: 0, sites: [], provedAt: 0, startedAt: 0, deleted: 0, failed: [], skipped: String((error as Error)?.message ?? error) };
    }
  }
  onProgress({ step: 'done' });
  return { site, uploaded, reused: present.size - lost.length, creditsSpent: before - (await writer.balance()), ...(pruned ? { pruned } : {}) };
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
 * How long a site record must have been live before the chunks it replaced are deleted. Readers
 * that resolved the name just before an update still fetch them: a service worker reuses an answer
 * for 30 seconds, a gateway serves a cached one for up to 24 hours when Platform is unreachable,
 * and a lagging node can prove an older record.
 */
export const DEFAULT_PRUNE_GRACE_MS = 25 * 60 * 60 * 1000;

/** How many times, 1.5 s apart, a listing is read again until it shows a write this process made. */
const LIST_ATTEMPTS = 12;

export class PruneError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PruneError';
  }
}

export interface PruneOptions {
  /** Chunks to keep besides those the identity's site records reference, e.g. a release being published. */
  keep?: Iterable<string>;
  graceMs?: number;
  now?: number;
  /**
   * A record this process just wrote, and the record it replaced. The listing is read until it
   * shows the write, so it is not older than it; the replaced release is kept and its age, not the
   * new record's, is what the grace period applies to.
   */
  published?: { site: SiteRecord; replaced?: SiteRecord };
}

export interface PrunePlan {
  /**
   * Chunks of this identity that no site record it shows references and that were stored before the
   * grace period, with the record each is stored under and its size.
   */
  remove: Array<StoredChunk & { siteId: string; bytes: number }>;
  bytes: number;
  kept: number;
  /** The site records the plan was made from, as `id revision content`, so a delete can check nothing changed. */
  sites: string[];
  /** Set while a site record is younger than the grace period: the plan may be shown, not carried out. */
  deferredUntil?: number;
  /** Block time of the listing the plan was made from, and the local time it was made. */
  provedAt: number;
  startedAt: number;
}

/**
 * Before deleting, the site records are read again from a block at least this much later than the
 * one the plan was made from (and later than when the plan was made, by the local clock), so that a
 * publish a lagging node did not show the plan is seen before anything is deleted.
 */
export const PRUNE_RECHECK_MS = 3 * 60 * 1000;
const RECHECK_LOCAL_MARGIN_MS = 30 * 1000;
const RECHECK_POLL_MS = 15 * 1000;
const RECHECK_GIVE_UP_MS = 10 * 60 * 1000;

export interface PruneRunOptions {
  onDelete?: (hash: string) => void;
  recheckMs?: number;
  /** Waits between re-reads; and the local clock. For tests. */
  sleep?: (ms: number) => Promise<void>;
  clock?: () => number;
}

export interface PruneResult extends PrunePlan {
  deleted: number;
  /** Chunks whose delete failed, with the error. */
  failed: string[];
  /** Why nothing was deleted, when the plan could not be made or carried out. */
  skipped?: string;
}

const snapshot = (sites: SiteRecord[]): string[] => sites.map((site) => `${site.id} ${site.revision} ${site.content ?? ''}`).sort();

async function listSettled(writer: PlatformWriter, published?: SiteRecord): Promise<Proved<SiteRecord[]>> {
  let listed = await writer.listSitesProved();
  const shows = (sites: SiteRecord[]) => !published || sites.some((site) => site.id === published.id && site.revision >= published.revision);
  for (let attempt = 1; attempt < LIST_ATTEMPTS && !shows(listed.value); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    listed = await writer.listSitesProved();
  }
  if (!shows(listed.value)) throw new PruneError('the site listing does not show the record just written yet');
  return listed;
}

/**
 * Whether a record of this identity is the one its name shows. A record that is not stays unshown
 * until its owner writes it again (a new revision, which stops a prune that planned without it).
 * A node answering from a block before the record's last write cannot tell, so the record counts as shown.
 */
async function shown(writer: PlatformWriter, site: SiteRecord): Promise<boolean> {
  const domain = await writer.getDomain(site.normalizedLabel);
  if (domain.meta.timeMs < site.updatedAt) return true;
  return domain.value ? isCurrent(domain.value, site) : false;
}

/** The chunks each site record of the identity still needs, by record id. Every listed record has an entry. */
async function referenced(writer: PlatformWriter, sites: SiteRecord[]): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>();
  const showing = new Map<string, boolean>();
  for (const site of sites) {
    const keep = out.get(site.id) ?? new Set<string>();
    out.set(site.id, keep);
    if (isNewer('site', site.v)) throw new PruneError(`site record ${site.id} is in format ${site.v}, newer than this version reads; nothing is deleted`);
    if (site.content === undefined) continue;
    if (!showing.has(site.id)) showing.set(site.id, await shown(writer, site));
    if (!showing.get(site.id)) continue;
    const ref = parseContentUri(site.content);
    if (ref?.scheme === 'ipfs') continue;
    if (ref?.scheme !== 'dash-manifest') throw new PruneError(`site record ${site.id} has content this version cannot read (${site.content.slice(0, 40)}); nothing is deleted`);
    let manifest;
    try {
      manifest = await loadManifest(ref, (hashes) => writer.getChunks(site.id, hashes));
    } catch (error) {
      throw new PruneError(`the manifest of site record ${site.id} cannot be read (${String((error as Error)?.message ?? error)}); nothing is deleted`);
    }
    if (manifest.partial) throw new PruneError(`the manifest of site record ${site.id} holds something this version does not know; nothing is deleted`);
    for (const hash of referencedChunks(ref, manifest)) keep.add(hash);
  }
  return out;
}

/**
 * Lists the chunks the identity can delete: chunks stored under one of its site records that the
 * record no longer references, or that a record its name no longer shows (the name changed hands,
 * or the record was taken down) still holds. Chunks are stored under the record they belong to,
 * so no other record can use them. While any of
 * its records changed within the grace period, the chunks that record replaced cannot be told
 * apart from the rest, so the plan is marked deferred and `prune` refuses it. A record whose
 * content cannot be read stops the plan, rather than letting its chunks count as unused.
 */
export async function planPrune(writer: PlatformWriter, options: PruneOptions = {}): Promise<PrunePlan> {
  const graceMs = options.graceMs ?? DEFAULT_PRUNE_GRACE_MS;
  const startedAt = Date.now();
  const { published } = options;
  const listed = await listSettled(writer, published?.site);
  const sites = listed.value;
  // The grace period is measured in Platform's time (the listing's block), not this machine's clock.
  const now = options.now ?? listed.meta.timeMs;
  const ages = sites.map((site) => (site.id === published?.site.id ? (published.replaced?.updatedAt ?? 0) : site.updatedAt));
  const newest = Math.max(0, ...ages);

  const records = published?.replaced ? [...sites, published.replaced] : sites;
  const keep = await referenced(writer, records);
  const extra = new Set(options.keep ?? []);
  const stored: Array<StoredChunk & { siteId: string }> = [];
  for (const site of sites) for (const chunk of await writer.listChunks(site.id)) stored.push({ ...chunk, siteId: site.id });
  // A chunk stored within the grace period may belong to a publish still uploading, whose record does not reference it yet.
  const unused = stored.filter((chunk) => chunk.createdAt <= now - graceMs && !extra.has(chunk.hash) && !keep.get(chunk.siteId)?.has(chunk.hash));
  const sizes = new Map<string, number>();
  for (const site of sites) {
    const hashes = unused.filter((chunk) => chunk.siteId === site.id).map((chunk) => chunk.hash);
    for (let i = 0; i < hashes.length; i += QUERY_BATCH) {
      for (const [hash, data] of await writer.getChunks(site.id, hashes.slice(i, i + QUERY_BATCH))) sizes.set(`${site.id} ${hash}`, data.length);
    }
  }
  const remove = unused.map((chunk) => ({ ...chunk, bytes: sizes.get(`${chunk.siteId} ${chunk.hash}`) ?? 0 }));
  return {
    remove,
    bytes: remove.reduce((sum, chunk) => sum + chunk.bytes, 0),
    kept: stored.length - remove.length,
    sites: snapshot(records),
    provedAt: listed.meta.timeMs,
    startedAt,
    ...(graceMs > 0 && newest > now - graceMs ? { deferredUntil: newest + graceMs } : {}),
  };
}

/**
 * Deletes the chunks a plan lists. The site records are read again first, from a block at least
 * {@link PRUNE_RECHECK_MS} after the plan's (waiting for one if needed), and nothing is deleted if
 * they changed since the plan (another publish, or a first listing from a node behind the chain);
 * a chunk a record references now is never deleted.
 */
export async function prune(writer: PlatformWriter, plan: PrunePlan, options: PruneRunOptions | ((hash: string) => void) = {}): Promise<PruneResult> {
  const run = typeof options === 'function' ? { onDelete: options } : options;
  const onDelete = run.onDelete ?? (() => {});
  const sleep = run.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const clock = run.clock ?? Date.now;
  const result = (deleted: number, failed: string[], skipped?: string): PruneResult => ({ ...plan, deleted, failed, ...(skipped ? { skipped } : {}) });
  if (plan.deferredUntil !== undefined) return result(0, [], 'a site record changed within the grace period');
  if (plan.remove.length === 0) return result(0, []);
  const fresh = Math.max(plan.provedAt + (run.recheckMs ?? PRUNE_RECHECK_MS), plan.startedAt + RECHECK_LOCAL_MARGIN_MS);
  const giveUp = clock() + RECHECK_GIVE_UP_MS;
  let listed = await writer.listSitesProved();
  while (listed.meta.timeMs < fresh) {
    if (clock() >= giveUp) return result(0, [], 'no Platform node answered from a recent enough block to check the site records again; try again later');
    await sleep(RECHECK_POLL_MS);
    listed = await writer.listSitesProved();
  }
  const sites = listed.value;
  const now = snapshot(sites);
  if (now.some((entry) => !plan.sites.includes(entry))) return result(0, [], 'the site records changed since the plan was made; plan again');
  const keep = await referenced(writer, sites);
  let deleted = 0;
  const failed: string[] = [];
  for (const chunk of plan.remove) {
    if (keep.get(chunk.siteId)?.has(chunk.hash) ?? true) continue;
    try {
      await writer.deleteChunk(chunk.id);
      onDelete(chunk.hash);
      deleted += 1;
    } catch (error) {
      failed.push(`${chunk.hash}: ${String((error as Error)?.message ?? error)}`);
    }
  }
  return result(deleted, failed);
}

/** Deletes the chunks no site this identity shows references, once every record is older than the grace period. */
export async function collectGarbage(writer: PlatformWriter, options: PruneOptions & PruneRunOptions = {}): Promise<PruneResult> {
  return prune(writer, await planPrune(writer, options), options);
}
