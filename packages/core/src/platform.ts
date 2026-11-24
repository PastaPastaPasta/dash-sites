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
  /** Current owner of the name; this identity controls the site. */
  ownerId: string;
  /** Label as registered, e.g. `Alice`. */
  label: string;
  normalizedLabel: string;
  /** When the name last changed owner (its creation time if it never did). */
  transferredAt: number;
}

export interface SiteRecord {
  id: string;
  ownerId: string;
  /** Id of the DPNS domain document the site is published under. */
  domainId: string;
  content: string;
  revision: number;
  updatedAt: number;
}

/** Proof-verified reads of the records, and unproved reads of content-addressed chunks. */
export interface PlatformReader {
  /** True while the network has no dash-sites contract: names resolve, sites do not exist yet. */
  readonly noSiteContract?: boolean;
  getDomain(normalizedLabel: string): Promise<Proved<DomainRecord | undefined>>;
  getSite(ownerId: string, domainId: string): Promise<Proved<SiteRecord | undefined>>;
  /** Chunks of `ownerId` by hash. Missing chunks are absent from the result; callers verify the bytes. */
  getChunks(ownerId: string, hashes: string[]): Promise<Map<string, Uint8Array>>;
}

export interface StoredChunk {
  id: string;
  hash: string;
}

export interface PlatformWriter extends PlatformReader {
  readonly identityId: string;
  listSites(): Promise<SiteRecord[]>;
  listChunks(): Promise<StoredChunk[]>;
  createChunk(hash: string, data: Uint8Array): Promise<void>;
  /** Creates the site record for a name or replaces its content. */
  putSite(domain: DomainRecord, content: string): Promise<SiteRecord>;
  deleteSite(domainId: string): Promise<boolean>;
  deleteChunk(id: string): Promise<void>;
  balance(): Promise<bigint>;
}
