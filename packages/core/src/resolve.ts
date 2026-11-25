import { parseContentUri, type ContentRef } from './content.js';
import { parseName } from './names.js';
import type { DomainRecord, PlatformReader, ProofMeta, SiteRecord } from './platform.js';
import type { ChunkSource } from './reader.js';

interface Named {
  normalized: string;
  meta: ProofMeta;
}

interface Owned extends Named {
  domain: DomainRecord;
  /** The one host label a name is served under: the registered label, lowercased. */
  canonicalLabel: string;
  ownerId: string;
}

export type Resolution =
  | { status: 'invalid' }
  | ({ status: 'unregistered' } & Named)
  | ({ status: 'no-site' } & Owned)
  | ({ status: 'unsupported'; site: SiteRecord } & Owned)
  | ({ status: 'ok'; site: SiteRecord; content: ContentRef } & Owned);

/**
 * Resolves a name to its site record. The site is the one published by the name's current
 * owner (`$ownerId` of the DPNS domain document) since the name last changed hands; documents
 * by anyone else, or from before the transfer, are never served.
 */
export async function resolveName(reader: PlatformReader, input: string): Promise<Resolution> {
  const name = parseName(input);
  if (!name) return { status: 'invalid' };
  const domain = await reader.getDomain(name.normalized);
  if (!domain.value) return { status: 'unregistered', normalized: name.normalized, meta: domain.meta };
  if (domain.value.normalizedLabel !== name.normalized) throw new Error('DPNS answered with a different name');
  const ownerId = domain.value.ownerId;
  const site = reader.noSiteContract ? { value: undefined, meta: domain.meta } : await reader.getSite(ownerId, domain.value.id);
  const base = {
    normalized: name.normalized,
    domain: domain.value,
    canonicalLabel: domain.value.label.toLowerCase(),
    ownerId,
    meta: site.meta,
  };
  if (!site.value || site.value.updatedAt < domain.value.transferredAt) return { status: 'no-site', ...base };
  if (site.value.ownerId !== ownerId || site.value.domainId !== domain.value.id) throw new Error('Platform answered with a different site');
  const content = parseContentUri(site.value.content);
  if (!content) return { status: 'unsupported', ...base, site: site.value };
  return { status: 'ok', ...base, site: site.value, content };
}

/** Where the chunks of a resolved site are stored. Every reader of a site's files asks through this. */
export const siteChunks = (reader: PlatformReader, resolution: Extract<Resolution, { status: 'ok' }>): ChunkSource => (hashes) => reader.getChunks(resolution.ownerId, hashes);

/**
 * What a host tells a site about a name: the answer of `site.json` and `resolve/<name>` under
 * `HOST_API`, the same whether a gateway or the visitor's own browser did the proving.
 */
export function describeResolution(resolution: Resolution, network: string): Record<string, unknown> {
  if (resolution.status === 'invalid') return { status: 'invalid' };
  const out: Record<string, unknown> = {
    status: resolution.status,
    network,
    normalized: resolution.normalized,
    proof: { height: resolution.meta.height, timeMs: resolution.meta.timeMs },
  };
  if (resolution.status === 'unregistered') return out;
  out.name = `${resolution.canonicalLabel}.dash`;
  out.ownerId = resolution.ownerId;
  out.domainId = resolution.domain.id;
  out.transferredAt = resolution.domain.transferredAt;
  if (resolution.status === 'no-site') return out;
  out.site = { id: resolution.site.id, revision: resolution.site.revision, updatedAt: resolution.site.updatedAt, content: resolution.site.content };
  return out;
}

/** The proved facts a host attaches to every file of a site. The extension compares them with its own answer. */
export function dashHeaders(resolution: Extract<Resolution, { status: 'ok' }>): Record<string, string> {
  return {
    'X-Dash-Name': `${resolution.canonicalLabel}.dash`,
    'X-Dash-Owner': resolution.ownerId,
    'X-Dash-Site-Revision': String(resolution.site.revision),
    'X-Dash-Content': resolution.site.content,
    'X-Dash-Proof-Height': String(resolution.meta.height),
  };
}
