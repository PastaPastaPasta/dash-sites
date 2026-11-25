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
  /** Current owner of the name; Platform lets only this identity write the name's site. */
  ownerId: string;
  /** Label as registered, e.g. `Alice`. */
  label: string;
  normalizedLabel: string;
}

export interface SiteRecord {
  id: string;
  /** The identity that wrote the record, which owned the name when it did. */
  ownerId: string;
  /** Label of the name as registered in DPNS, e.g. `Alice`. */
  label: string;
  normalizedLabel: string;
  /** Absent once the owner has taken the site down: site records are never deleted. */
  content?: string;
  revision: number;
  updatedAt: number;
}

export type PublishedSite = SiteRecord & { content: string };

/** Proof-verified reads of the records and chunks. Callers still hash every chunk. */
export interface PlatformReader {
  /** True while the network has no dash-sites contract: names resolve, sites do not exist yet. */
  readonly noSiteContract?: boolean;
  getDomain(normalizedLabel: string): Promise<Proved<DomainRecord | undefined>>;
  /**
   * The site record written last for a name. Platform takes a write only from the name's owner.
   * With `preload`, the same query also brings up to `PRELOAD_CHUNKS` of the record's chunks,
   * which the next `getChunks` hands out without asking again.
   */
  getSite(normalizedLabel: string, preload?: boolean): Promise<Proved<SiteRecord | undefined>>;
  /** Chunks stored under a site record, by hash. Missing chunks are absent from the result; callers verify the bytes. */
  getChunks(siteId: string, hashes: string[]): Promise<Map<string, Uint8Array>>;
}

export interface StoredChunk {
  id: string;
  hash: string;
}

export interface PlatformWriter extends PlatformReader {
  readonly identityId: string;
  listSites(): Promise<SiteRecord[]>;
  listChunks(siteId: string): Promise<StoredChunk[]>;
  /** Stores a chunk under one of this identity's site records; Platform refuses anyone else's. */
  createChunk(siteId: string, hash: string, data: Uint8Array): Promise<void>;
  /** Creates this identity's site record for a name or replaces its content; without content, takes the site down. */
  putSite(domain: DomainRecord, content?: string): Promise<SiteRecord>;
  deleteChunk(id: string): Promise<void>;
  balance(): Promise<bigint>;
}
