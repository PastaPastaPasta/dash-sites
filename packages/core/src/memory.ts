import { sha256Hex } from './bytes.js';
import { normalizeLabel } from './names.js';
import type { DomainRecord, PlatformWriter, ProofMeta, Proved, SiteRecord, StoredChunk } from './platform.js';

/** An in-memory Platform for tests and local previews. */
export class MemoryPlatform {
  readonly domains = new Map<string, DomainRecord>();
  readonly sites = new Map<string, SiteRecord>();
  readonly chunks = new Map<string, { id: string; ownerId: string; hash: string; data: Uint8Array }>();
  height = 1;
  now: () => number = Date.now;
  private nextId = 1;
  private clock = 0;

  registerName(label: string, ownerId: string): DomainRecord {
    const normalizedLabel = normalizeLabel(label);
    const record = { id: `domain-${this.nextId++}`, ownerId, label, normalizedLabel, transferredAt: this.tick() };
    this.domains.set(normalizedLabel, record);
    this.height += 1;
    return record;
  }

  transferName(label: string, ownerId: string): void {
    const record = this.domains.get(normalizeLabel(label));
    if (!record) throw new Error('no such name');
    record.ownerId = ownerId;
    record.transferredAt = this.tick();
    this.height += 1;
  }

  /** A strictly increasing block time, so that "before" and "after" a transfer are distinct. */
  private tick(): number {
    this.clock = Math.max(this.clock + 1, this.now());
    return this.clock;
  }

  meta(): ProofMeta {
    return { height: this.height, timeMs: this.now(), coreChainLockedHeight: 1, protocolVersion: 14 };
  }

  as(identityId: string): PlatformWriter {
    const proved = <T>(value: T): Proved<T> => ({ value, meta: this.meta() });
    const siteKey = (ownerId: string, domainId: string) => `${ownerId}/${domainId}`;
    const chunkKey = (ownerId: string, hash: string) => `${ownerId}/${hash}`;
    return {
      identityId,
      getDomain: async (normalizedLabel) => proved(this.domains.get(normalizedLabel)),
      getSite: async (ownerId, domainId) => proved(this.sites.get(siteKey(ownerId, domainId))),
      getChunks: async (ownerId, hashes) => {
        const out = new Map<string, Uint8Array>();
        for (const hash of hashes) {
          const chunk = this.chunks.get(chunkKey(ownerId, hash));
          if (chunk) out.set(hash, chunk.data);
        }
        return out;
      },
      listSites: async () => [...this.sites.values()].filter((site) => site.ownerId === identityId),
      listChunks: async (): Promise<StoredChunk[]> =>
        [...this.chunks.values()].filter((chunk) => chunk.ownerId === identityId).map(({ id, hash }) => ({ id, hash })),
      createChunk: async (hash, data) => {
        if (sha256Hex(data) !== hash) throw new Error('chunk hash mismatch');
        const key = chunkKey(identityId, hash);
        if (this.chunks.has(key)) throw new Error('duplicate chunk');
        this.chunks.set(key, { id: `chunk-${this.nextId++}`, ownerId: identityId, hash, data });
        this.height += 1;
      },
      putSite: async (domain, content) => {
        const key = siteKey(identityId, domain.id);
        const existing = this.sites.get(key);
        const record: SiteRecord = {
          id: existing?.id ?? `site-${this.nextId++}`,
          ownerId: identityId,
          domainId: domain.id,
          content,
          revision: (existing?.revision ?? 0) + 1,
          updatedAt: this.tick(),
        };
        this.sites.set(key, record);
        this.height += 1;
        return record;
      },
      deleteSite: async (domainId) => {
        this.height += 1;
        return this.sites.delete(siteKey(identityId, domainId));
      },
      deleteChunk: async (id) => {
        for (const [key, chunk] of this.chunks) {
          if (chunk.id === id && chunk.ownerId === identityId) this.chunks.delete(key);
        }
        this.height += 1;
      },
      balance: async () => 0n,
    };
  }
}
