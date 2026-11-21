import { matchHost, parseName, type Resolution } from '@dash-sites/core';

export const RULE_ID = 1;
export const DEFAULT_GATEWAY = 'https://id.dashhq.org';

export interface Settings {
  /** Origin of the gateway's bare domain, e.g. `https://id.dashhq.org` or `http://localhost:8080`. */
  gateway: string;
  /** Turn a search for `alice.dash` into a visit to the site. */
  catchSearches: boolean;
  network: 'testnet' | 'mainnet';
}

export const DEFAULT_SETTINGS: Settings = { gateway: DEFAULT_GATEWAY, catchSearches: true, network: 'testnet' };

export interface Gateway {
  origin: string;
  protocol: 'https:' | 'http:';
  /** Host with port, as it appears in URLs. */
  host: string;
  hostname: string;
}

const LOOPBACK = /^(localhost|[a-z0-9-]+\.localhost)$/;

/** A gateway must be https, or plain http on this machine. */
export function parseGateway(input: string): Gateway | undefined {
  let url: URL;
  try {
    url = new URL(/^[a-z]+:\/\//i.test(input.trim()) ? input.trim() : `https://${input.trim()}`);
  } catch {
    return undefined;
  }
  if (url.pathname !== '/' || url.search || url.hash || url.username || url.password) return undefined;
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK.test(url.hostname))) return undefined;
  if (!/^[a-z0-9.-]+$/.test(url.hostname) || !url.hostname.includes('.') && url.hostname !== 'localhost') return undefined;
  return { origin: url.origin, protocol: url.protocol as Gateway['protocol'], host: url.host, hostname: url.hostname };
}

export function siteUrl(gateway: Gateway, label: string, path = '/'): string {
  return `${gateway.protocol}//${label}.${gateway.host}${path.startsWith('/') ? path : `/${path}`}`;
}

/**
 * Sends navigations to `http(s)://<label>.dash/…` to the gateway instead. The pattern has no
 * counted repetition (Chrome caps a compiled rule at 2 KB); the gateway rejects invalid labels.
 */
export function redirectRule(gateway: Gateway): chrome.declarativeNetRequest.Rule {
  return {
    id: RULE_ID,
    priority: 1,
    action: { type: 'redirect', redirect: { regexSubstitution: `${gateway.protocol}//\\1.${gateway.host}\\2` } },
    condition: {
      regexFilter: '^https?://([a-z0-9-]+)\\.dash(?::[0-9]+)?(/.*)?$',
      resourceTypes: ['main_frame', 'sub_frame'],
    },
  } as chrome.declarativeNetRequest.Rule;
}

/** `alice`, `alice.dash`, `alice.dash/blog` or `http://alice.dash/blog` to a gateway URL. */
export function urlForInput(input: string, gateway: Gateway): string | undefined {
  const text = input.trim().replace(/^https?:\/\//i, '');
  const slash = text.indexOf('/');
  const host = slash < 0 ? text : text.slice(0, slash);
  const path = slash < 0 ? '/' : text.slice(slash);
  const name = parseName(host);
  if (!name || /\s/.test(path)) return undefined;
  return siteUrl(gateway, name.label, path);
}

const SEARCH_HOSTS = /^(www\.)?(google\.[a-z.]{2,6}|bing\.com|duckduckgo\.com|search\.brave\.com|search\.yahoo\.com|ecosia\.org|startpage\.com|kagi\.com)$/;

/** The gateway URL for a search-engine URL whose query is exactly a `.dash` name. */
export function urlForSearch(searchUrl: string, gateway: Gateway): string | undefined {
  let url: URL;
  try {
    url = new URL(searchUrl);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' || !SEARCH_HOSTS.test(url.hostname)) return undefined;
  const query = (url.searchParams.get('q') ?? url.searchParams.get('query') ?? url.searchParams.get('p') ?? '').trim();
  if (!/^[a-z0-9-]+\.dash(\/\S*)?$/i.test(query)) return undefined;
  return urlForInput(query, gateway);
}

/** The label of the `.dash` site a tab URL shows through this gateway. */
export function labelForUrl(tabUrl: string, gateway: Gateway): string | undefined {
  let url: URL;
  try {
    url = new URL(tabUrl);
  } catch {
    return undefined;
  }
  if (url.protocol !== gateway.protocol) return undefined;
  const match = matchHost(url.host, [gateway.hostname]);
  if (match.kind !== 'site' || url.host !== `${match.label}.${gateway.host}`) return undefined;
  return match.label;
}

/** What the gateway said about the site it served, from its `X-Dash-*` headers. */
export interface Claims {
  owner?: string;
  content?: string;
  revision?: number;
}

export function claimsFromHeaders(headers: { get(name: string): string | null }): Claims {
  const revision = Number(headers.get('x-dash-site-revision'));
  return {
    owner: headers.get('x-dash-owner') ?? undefined,
    content: headers.get('x-dash-content') ?? undefined,
    revision: Number.isFinite(revision) && revision > 0 ? revision : undefined,
  };
}

export type Verdict =
  | { kind: 'match'; detail: string }
  | { kind: 'behind'; detail: string }
  | { kind: 'mismatch'; detail: string }
  | { kind: 'none'; detail: string };

/** Compares what the gateway served with what Dash Platform proves. */
export function compare(claims: Claims, resolution: Resolution): Verdict {
  const serves = claims.content !== undefined;
  switch (resolution.status) {
    case 'invalid':
      return { kind: 'none', detail: 'This is not a valid Dash Platform name.' };
    case 'unregistered':
      return serves
        ? { kind: 'mismatch', detail: 'The gateway serves a site, but Dash Platform proves this name is not registered.' }
        : { kind: 'none', detail: 'Dash Platform proves this name is not registered.' };
    case 'no-site':
      return serves
        ? { kind: 'mismatch', detail: 'The gateway serves a site, but Dash Platform proves the owner has published none.' }
        : { kind: 'none', detail: 'The name is registered and its owner has not published a site.' };
    case 'unsupported':
    case 'ok': {
      const site = resolution.site;
      if (!serves) return { kind: 'none', detail: 'The owner has published a site, and this gateway is not serving it.' };
      if (claims.owner !== resolution.ownerId) {
        return { kind: 'mismatch', detail: `The gateway names owner ${claims.owner ?? 'nobody'}; Dash Platform proves the owner is ${resolution.ownerId}.` };
      }
      if (claims.content === site.content) return { kind: 'match', detail: 'The gateway serves the site record Dash Platform proves.' };
      if ((claims.revision ?? 0) < site.revision) {
        return { kind: 'behind', detail: `The gateway serves revision ${claims.revision ?? '?'}; the owner has published revision ${site.revision}. Gateways catch up within a few minutes.` };
      }
      return { kind: 'mismatch', detail: 'The gateway serves different content from the site record Dash Platform proves.' };
    }
  }
}
