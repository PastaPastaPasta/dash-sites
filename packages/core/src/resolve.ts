import { parseContentUri, type ContentRef } from './content.js';
import { isNewer } from './formats.js';
import { parseName } from './names.js';
import type { DomainRecord, PlatformReader, ProofMeta, PublishedSite, SiteRecord } from './platform.js';
import type { ChunkSource } from './reader.js';

interface Named {
  normalized: string;
  meta: ProofMeta;
}

interface Owned extends Named {
  /** The one host label a name is served under: the registered label, lowercased. */
  canonicalLabel: string;
  /** The identity that owns the name. A site shown for the name is the record this identity wrote. */
  ownerId: string;
  domain: DomainRecord;
}

export type Resolution =
  | { status: 'invalid' }
  | ({ status: 'unregistered' } & Named)
  | ({ status: 'no-site' } & Owned)
  /** `newer`: a later version of this code reads it. `unknown`: content this project does not define. */
  | ({ status: 'unsupported'; reason: 'newer' | 'unknown'; site: PublishedSite } & Owned)
  | ({ status: 'ok'; site: PublishedSite; content: ContentRef } & Owned);

/** Whether `site` is the record a name shows: its owner's, written since the name came to that owner. */
export const isCurrent = (domain: DomainRecord, site: SiteRecord): boolean => site.ownerId === domain.ownerId && site.updatedAt >= domain.transferredAt;

/**
 * Resolves a name with one proved read: its DPNS domain, the site record written by the identity
 * that owns the domain, and with `preload` the first chunks stored under that record. Platform
 * stores a site record from any identity, so the owner check is this read's: it looks the record
 * up by the domain's owner, and one proof covers the domain and the record as the same block holds
 * them. A name that changes hands shows nothing of the previous owner from that block on, and a
 * name that comes back to an identity does not bring back what it published before.
 */
export async function resolveName(reader: PlatformReader, input: string, options: { preload?: boolean } = {}): Promise<Resolution> {
  const name = parseName(input);
  if (!name) return { status: 'invalid' };
  const normalized = name.normalized;
  const { value, meta } = await reader.getName(normalized, options.preload);
  if (!value) return { status: 'unregistered', normalized, meta };
  const { domain, site } = value;
  if (domain.normalizedLabel !== normalized) throw new Error('DPNS answered with a different name');
  if (site && (site.normalizedLabel !== normalized || site.ownerId !== domain.ownerId)) throw new Error('Platform answered with a different site');
  const base = { normalized, domain, canonicalLabel: domain.label.toLowerCase(), ownerId: domain.ownerId, meta };
  if (!site || !isCurrent(domain, site)) return { status: 'no-site', ...base };
  const published = { ...site, content: site.content ?? '' };
  if (isNewer('site', site.v)) return { status: 'unsupported', reason: 'newer', ...base, site: published };
  if (site.content === undefined) return { status: 'no-site', ...base };
  const content = parseContentUri(site.content);
  if (!content) return { status: 'unsupported', reason: contentUriIsNewer(site.content) ? 'newer' : 'unknown', ...base, site: published };
  return { status: 'ok', ...base, site: published, content };
}

/** Where the chunks of a resolved site are read from. */
export const siteChunks = (reader: PlatformReader, resolution: Extract<Resolution, { status: 'ok' }>): ChunkSource => (hashes) => reader.getChunks(resolution.site.id, hashes);

/** Whether a content URI is a `dash-manifest` form of a later version than this code reads. */
function contentUriIsNewer(uri: string): boolean {
  const version = /^dash-manifest:v([1-9][0-9]{0,8}):/.exec(uri)?.[1];
  return version !== undefined && isNewer('contentUri', Number(version));
}

/**
 * What a browser's storage for a name belongs to. When it changes, the name has changed hands, and
 * a host clears what the previous owner's site stored.
 */
export const ownerEpoch = (resolution: Resolution): string => ('ownerId' in resolution ? `${resolution.ownerId}.${resolution.domain.transferredAt}` : '');

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
  if (resolution.status === 'unsupported') out.reason = resolution.reason;
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
