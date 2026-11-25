import { sha256Hex } from './bytes.js';
import { FORMATS, refuseNewer } from './formats.js';
import { normalizeLabel } from './names.js';
import type { DomainRecord, PlatformWriter, ProofMeta, Proved, SiteRecord, StoredChunk } from './platform.js';

/** An in-memory Platform for tests and local previews. Like Platform, it stores a site record only from the identity that owns the name. */
export class MemoryPlatform {
  readonly domains = new Map<string, DomainRecord>();
  readonly sites = new Map<string, SiteRecord>();
  readonly chunks = new Map<string, { id: string; ownerId: string; siteId: string; hash: string; data: Uint8Array; v: number; createdAt: number }>();
  height = 1;
  funds = 10n ** 12n;
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

  /** A strictly increasing block time. */
  private tick(): number {
    this.clock = Math.max(this.clock + 1, this.now());
    return this.clock;
  }

  meta(): ProofMeta {
    return { height: this.height, timeMs: Math.max(this.clock, this.now()), coreChainLockedHeight: 1, protocolVersion: 14 };
  }

  as(identityId: string): PlatformWriter {
    const proved = <T>(value: T): Proved<T> => ({ value, meta: this.meta() });
    const siteKey = (ownerId: string, normalizedLabel: string) => `${ownerId}/${normalizedLabel}`;
    const chunkKey = (siteId: string, hash: string) => `${siteId}/${hash}`;
    const ownSite = (siteId: string) => [...this.sites.values()].some((site) => site.id === siteId && site.ownerId === identityId);
    const writer: PlatformWriter = {
      identityId,
      getDomain: async (normalizedLabel) => proved(this.domains.get(normalizedLabel)),
      getName: async (normalizedLabel) => {
        const domain = this.domains.get(normalizedLabel);
        const site = domain && this.sites.get(siteKey(domain.ownerId, normalizedLabel));
        return proved(domain && { domain: { ...domain }, ...(site ? { site } : {}) });
      },
      getChunks: async (siteId, hashes) => {
        const out = new Map<string, Uint8Array>();
        for (const hash of hashes) {
          const chunk = this.chunks.get(chunkKey(siteId, hash));
          if (!chunk) continue;
          refuseNewer('chunk', chunk.v);
          out.set(hash, chunk.data);
        }
        return out;
      },
      listSites: async () => [...this.sites.values()].filter((site) => site.ownerId === identityId),
      listSitesProved: async () => proved([...this.sites.values()].filter((site) => site.ownerId === identityId)),
      listChunks: async (siteId): Promise<StoredChunk[]> =>
        [...this.chunks.values()].filter((chunk) => chunk.siteId === siteId).map(({ id, hash, createdAt }) => ({ id, hash, createdAt })),
      createChunk: async (siteId, hash, data) => {
        if (sha256Hex(data) !== hash) throw new Error('chunk hash mismatch');
        if (!ownSite(siteId)) throw new Error(`${identityId} did not write site record ${siteId}`);
        const key = chunkKey(siteId, hash);
        if (this.chunks.has(key)) throw new Error('duplicate chunk');
        this.chunks.set(key, { id: `chunk-${this.nextId++}`, ownerId: identityId, siteId, hash, data, v: FORMATS.chunk, createdAt: this.tick() });
        this.height += 1;
      },
      putSite: async (domain, content) => {
        if (this.domains.get(domain.normalizedLabel)?.ownerId !== identityId) throw new Error(`${identityId} does not own ${domain.normalizedLabel}.dash, so Platform refuses its site record`);
        const key = siteKey(identityId, domain.normalizedLabel);
        const existing = this.sites.get(key);
        if (existing) refuseNewer('site', existing.v);
        const record: SiteRecord = {
          id: existing?.id ?? `site-${this.nextId++}`,
          ownerId: identityId,
          normalizedLabel: domain.normalizedLabel,
          v: FORMATS.site,
          ...(content === undefined ? {} : { content }),
          revision: (existing?.revision ?? 0) + 1,
          updatedAt: this.tick(),
        };
        this.sites.set(key, record);
        this.height += 1;
        return record;
      },
      ensureSite: async (domain) => this.sites.get(siteKey(identityId, domain.normalizedLabel)) ?? writer.putSite(domain),
      deleteChunk: async (id) => {
        for (const [key, chunk] of this.chunks) {
          if (chunk.id === id && chunk.ownerId === identityId) this.chunks.delete(key);
        }
        this.height += 1;
      },
      balance: async () => this.funds,
    };
    return writer;
  }
}
