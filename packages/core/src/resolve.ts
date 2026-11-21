import { parseContentUri, type ContentRef } from './content.js';
import { parseName } from './names.js';
import type { DomainRecord, PlatformReader, ProofMeta, SiteRecord } from './platform.js';

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
  const site = await reader.getSite(ownerId, domain.value.id);
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
