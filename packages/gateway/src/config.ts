import type { Denylist } from '@dash-sites/core';

export { emptyDenylist, parseDenylist, type Denylist } from '@dash-sites/core';

export interface GatewayDomain {
  /** Host without port, lowercase: `id.dashhq.org`. */
  host: string;
  /** Origin of the bare domain as browsers reach it: `https://id.dashhq.org`. */
  origin: string;
}

export interface GatewayConfig {
  domains: GatewayDomain[];
  /** Hosts that are not sites even though they match `<label>.<domain>`, e.g. `www`. */
  reservedLabels: Set<string>;
  builderUrl: string;
  extensionUrl: string;
  abuseContact: string;
  network: string;
  /** The network has a dash-sites contract; without one, names resolve and no site exists yet. */
  sitesLive: boolean;
  /** The same service on the other network, e.g. `{ network: 'testnet', url: 'https://id.dashhq.org' }`. */
  peer?: { network: string; url: string };
  /** Replaced in place when the operator's denylist file changes. */
  denylist: Denylist;
  /** Largest site, in decoded bytes, this gateway serves. */
  maxSiteBytes: number;
  maxFiles: number;
  /** Requests per minute per client address; 0 turns the limit off. */
  rateLimitPerMinute: number;
  /** Read the client address from X-Forwarded-For. Only behind a proxy that sets it. */
  trustProxy: boolean;
  chunkCacheBytes: number;
}

/** Parses `id.dashhq.org` or `http://localhost:8080` into a gateway domain. */
export function parseDomain(entry: string): GatewayDomain {
  const withScheme = /^https?:\/\//.test(entry) ? entry : `https://${entry}`;
  const url = new URL(withScheme);
  if (url.pathname !== '/' || url.search || url.hash || url.username) throw new Error(`invalid gateway domain: ${entry}`);
  return { host: url.hostname.toLowerCase(), origin: url.origin };
}

export function siteOrigin(domain: GatewayDomain, label: string): string {
  const url = new URL(domain.origin);
  url.hostname = `${label}.${url.hostname}`;
  return url.origin;
}
