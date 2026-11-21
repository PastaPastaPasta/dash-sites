export interface GatewayDomain {
  /** Host without port, lowercase: `id.dashhq.org`. */
  host: string;
  /** Origin of the bare domain as browsers reach it: `https://id.dashhq.org`. */
  origin: string;
}

export interface Denylist {
  names: Set<string>;
  owners: Set<string>;
  content: Set<string>;
}

export interface GatewayConfig {
  domains: GatewayDomain[];
  /** Hosts that are not sites even though they match `<label>.<domain>`, e.g. `www`. */
  reservedLabels: Set<string>;
  builderUrl: string;
  extensionUrl: string;
  abuseContact: string;
  network: string;
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

export function emptyDenylist(): Denylist {
  return { names: new Set(), owners: new Set(), content: new Set() };
}

/** One entry per line: `name alice`, `owner <identity id>`, `content <content URI>`. `#` starts a comment. */
export function parseDenylist(text: string): Denylist {
  const list = emptyDenylist();
  for (const raw of text.split('\n')) {
    const line = raw.replace(/#.*/, '').trim();
    if (!line) continue;
    const [kind, value] = line.split(/\s+/, 2);
    if (!value) throw new Error(`denylist: missing value in "${raw}"`);
    if (kind === 'name') list.names.add(value.toLowerCase().replace(/\.dash$/, ''));
    else if (kind === 'owner') list.owners.add(value);
    else if (kind === 'content') list.content.add(value);
    else throw new Error(`denylist: unknown kind "${kind}"`);
  }
  return list;
}
