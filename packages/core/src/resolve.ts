import { parseContentUri, type ContentRef } from './content.js';
import { parseName } from './names.js';
import type { PlatformReader, ProofMeta, PublishedSite } from './platform.js';

interface Named {
  normalized: string;
  meta: ProofMeta;
}

interface Owned extends Named {
  /** The one host label a name is served under: the registered label, lowercased. */
  canonicalLabel: string;
  /** The identity that wrote the name's site record; for a name without one, the name's owner. */
  ownerId: string;
}

export type Resolution =
  | { status: 'invalid' }
  | ({ status: 'unregistered' } & Named)
  | ({ status: 'no-site' } & Owned)
  | ({ status: 'unsupported'; site: PublishedSite } & Owned)
  | ({ status: 'ok'; site: PublishedSite; content: ContentRef } & Owned);

/**
 * Resolves a name with one proved read: the site record written last for it, and with
 * `preload` the first chunks stored under that record in the same read. Platform takes a
 * site record only from the identity that owns the DPNS name at that moment and never deletes
 * one, so the last record is the last word of the last owner who published. A name that changes
 * hands keeps the previous owner's site until the new owner writes a record. DPNS is read only
 * for a name without a record, to tell a registered name from a free one.
 */
export async function resolveName(reader: PlatformReader, input: string, options: { preload?: boolean } = {}): Promise<Resolution> {
  const name = parseName(input);
  if (!name) return { status: 'invalid' };
  const normalized = name.normalized;
  const site = reader.noSiteContract ? undefined : await reader.getSite(normalized, options.preload);
  if (site?.value) {
    const record = site.value;
    if (record.normalizedLabel !== normalized) throw new Error('Platform answered with a different site');
    const base = { normalized, canonicalLabel: record.label.toLowerCase(), ownerId: record.ownerId, meta: site.meta };
    if (record.content === undefined) return { status: 'no-site', ...base };
    const published = { ...record, content: record.content };
    const content = parseContentUri(record.content);
    if (!content) return { status: 'unsupported', ...base, site: published };
    return { status: 'ok', ...base, site: published, content };
  }
  const domain = await reader.getDomain(normalized);
  if (!domain.value) return { status: 'unregistered', normalized, meta: domain.meta };
  if (domain.value.normalizedLabel !== normalized) throw new Error('DPNS answered with a different name');
  return { status: 'no-site', normalized, canonicalLabel: domain.value.label.toLowerCase(), ownerId: domain.value.ownerId, meta: domain.meta };
}

/**
 * What a browser's storage for a name belongs to. When it changes, a new owner has published,
 * and a host clears what the previous owner's site stored.
 */
export const ownerEpoch = (resolution: Resolution): string => ('ownerId' in resolution ? resolution.ownerId : '');

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
