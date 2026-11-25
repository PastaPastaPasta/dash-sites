export interface ProofMeta {
  height: number;
  timeMs: number;
  coreChainLockedHeight: number;
  protocolVersion: number;
}

export interface Proved<T> {
  value: T;
  meta: ProofMeta;
}

export interface DomainRecord {
  id: string;
  /** Current owner of the name: readers take the name's site from this identity's record alone. */
  ownerId: string;
  /** Label as registered, e.g. `Alice`. */
  label: string;
  normalizedLabel: string;
  /** When the name last changed owner (its creation time if it never did). */
  transferredAt: number;
}

export interface SiteRecord {
  id: string;
  /** The identity that wrote the record. Platform does not check that it owns the name; readers do. */
  ownerId: string;
  normalizedLabel: string;
  /** Format version of the record (`FORMATS.site`); 1 for records from before the field existed. */
  v: number;
  /** Absent once the writer has taken the site down: site records are never deleted. */
  content?: string;
  revision: number;
  updatedAt: number;
}

export type PublishedSite = SiteRecord & { content: string };

/** A registered name, and the site record its current owner wrote for it at any time, if any. */
export interface NameRecord {
  domain: DomainRecord;
  site?: SiteRecord;
}

/** Proof-verified reads of the records and chunks. Callers still hash every chunk. */
export interface PlatformReader {
  /** True while the network has no dash-sites contract: names resolve, sites do not exist yet. */
  readonly noSiteContract?: boolean;
  getDomain(normalizedLabel: string): Promise<Proved<DomainRecord | undefined>>;
  /**
   * A name's DPNS domain and the site record written by the identity that owns it, as one block
   * holds them. Records other identities wrote for the name are never returned. With `preload`,
   * the same read also brings up to `PRELOAD_CHUNKS` of the record's chunks, which the next
   * `getChunks` hands out without asking again.
   */
  getName(normalizedLabel: string, preload?: boolean): Promise<Proved<NameRecord | undefined>>;
  /** Chunks stored under a site record, by hash. Missing chunks are absent from the result; callers verify the bytes. */
  getChunks(siteId: string, hashes: string[]): Promise<Map<string, Uint8Array>>;
}

export interface StoredChunk {
  id: string;
  hash: string;
  /** Block time the chunk was stored at. */
  createdAt: number;
}

export interface PlatformWriter extends PlatformReader {
  readonly identityId: string;
  listSites(): Promise<SiteRecord[]>;
  /** {@link listSites} with the proof's block, the oldest when the listing took several pages. */
  listSitesProved(): Promise<Proved<SiteRecord[]>>;
  listChunks(siteId: string): Promise<StoredChunk[]>;
  /** Stores a chunk under one of this identity's site records; Platform refuses anyone else's. */
  createChunk(siteId: string, hash: string, data: Uint8Array): Promise<void>;
  /**
   * Creates this identity's site record for a name or replaces its content; without content, takes
   * the site down. Platform stores the record whoever owns the name, so callers check ownership first.
   */
  putSite(domain: DomainRecord, content?: string): Promise<SiteRecord>;
  /** This identity's site record for a name, created empty when there is none. An existing record is left as it is. */
  ensureSite(domain: DomainRecord): Promise<SiteRecord>;
  deleteChunk(id: string): Promise<void>;
  balance(): Promise<bigint>;
}
