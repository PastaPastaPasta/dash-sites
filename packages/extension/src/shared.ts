import { parseName, type Network } from '@dash-sites/core';

export interface Settings {
  network: Network;
  /** Turn a search for exactly `alice.dash` into a visit to the site. */
  catchSearches: boolean;
  /** Offer a gateway when Dash Platform cannot be read directly. Off unless the user turns it on. */
  gatewayFallback: boolean;
  /** Origin of the gateway's bare domain, e.g. `https://dash.site`. Only used with `gatewayFallback`. */
  gateway: string;
}

export const DEFAULT_SETTINGS: Settings = { network: 'mainnet', catchSearches: true, gatewayFallback: false, gateway: '' };

/** A site address the viewer shows: the name, and the path and query under it. */
export interface Target {
  label: string;
  /** Starts with `/`; percent-encoded as in a URL. */
  path: string;
  search: string;
}

export const siteOrigin = (label: string): string => `https://${label}.dash`;
export const targetUrl = (target: Target): string => `${siteOrigin(target.label)}${target.path}${target.search}`;

/**
 * `alice`, `alice.dash`, `alice.dash/blog?x`, `http://alice.dash/blog` or a search engine's
 * `alice.dash%2Fblog`, to a target. Anything else is not a `.dash` address.
 */
export function parseTarget(input: string): Target | undefined {
  let text = input.trim().replace(/^https?:\/\//i, '');
  if (/^[a-z0-9-]+(\.dash)?\.?%2f/i.test(text)) text = text.replace(/%2f/i, '/');
  const cut = text.search(/[/?#]/);
  const host = (cut < 0 ? text : text.slice(0, cut)).replace(/:\d+$/, '').replace(/\.$/, '');
  const name = parseName(host);
  if (!name) return undefined;
  let url: URL;
  try {
    url = new URL(cut < 0 ? '/' : text.slice(cut), 'https://x.invalid/');
  } catch {
    return undefined;
  }
  return { label: name.label, path: url.pathname, search: url.search };
}

/** The viewer's own hash for a target: `#alice.dash/blog?x`. */
export const viewerHash = (target: Target): string => `#${target.label}.dash${target.path}${target.search}`;
export const viewerUrl = (target: Target): string => chrome.runtime.getURL(`site.html${viewerHash(target)}`);

/** A target as the viewer's address box shows it: `alice.dash`, `alice.dash/blog?x`. */
export const displayAddress = (target: Target): string => `${target.label}.dash${target.path === '/' ? '' : target.path}${target.search}`;

/** Where the extension keeps a network's chain snapshot. */
export const chainKey = (network: Network): string => `chain:${network}`;

export const RULE_IDS = { direct: 1, frame: 2, subresources: 3, searchBase: 100 } as const;

const LABEL = '([a-zA-Z0-9-]+)';
/** `http(s)://<label>.dash[.][:port][/path?query]` and nothing longer: `alice.dash.site` is not a `.dash` address. */
const DIRECT = `^https?://${LABEL}\\.dash\\.?(?::[0-9]+)?(/[^#]*)?(?:#.*)?$`;

/** Search engines whose result URL carries the typed text in one query parameter. */
export const SEARCH_ENGINES: { name: string; prefix: string; param: string }[] = [
  { name: 'Google', prefix: 'https?://(?:www\\.)?google\\.[a-z]{2,3}(?:\\.[a-z]{2})?/search\\?', param: 'q' },
  { name: 'Bing', prefix: 'https?://(?:www\\.)?bing\\.com/search\\?', param: 'q' },
  { name: 'DuckDuckGo', prefix: 'https?://(?:html\\.)?duckduckgo\\.com/(?:html/?)?\\?', param: 'q' },
  { name: 'Brave', prefix: 'https?://search\\.brave\\.com/search\\?', param: 'q' },
  { name: 'Yahoo', prefix: 'https?://(?:[a-z]+\\.)?search\\.yahoo\\.com/search\\?', param: 'p' },
  { name: 'Ecosia', prefix: 'https?://www\\.ecosia\\.org/search\\?', param: 'q' },
  { name: 'Startpage', prefix: 'https?://(?:www\\.)?startpage\\.com/(?:do|sp)/search\\?', param: 'query' },
  { name: 'Kagi', prefix: 'https?://kagi\\.com/search\\?', param: 'q' },
  { name: 'Qwant', prefix: 'https?://(?:www\\.)?qwant\\.com/\\?', param: 'q' },
];

type Rule = chrome.declarativeNetRequest.Rule;

/**
 * The redirect rules, given the extension's own base URL. They act before a request leaves the
 * browser: a `.dash` address is never looked up in DNS, and a search for exactly a `.dash` name is
 * never sent to the search engine.
 */
export function redirectRules(base: string, settings: Settings, sandbox: boolean): Rule[] {
  const viewer = `${base}site.html#`;
  const rules: Rule[] = [
    {
      id: RULE_IDS.direct,
      priority: 2,
      action: { type: 'redirect', redirect: { regexSubstitution: `${viewer}\\1.dash\\2` } },
      condition: { regexFilter: DIRECT, resourceTypes: ['main_frame'], isUrlFilterCaseSensitive: false },
    } as Rule,
  ];
  // A site's own address that no file answered (a missing file, one kept outside Platform) must not
  // reach DNS either: images, styles, media, fetches and the rest are blocked outright.
  rules.push({
    id: RULE_IDS.subresources,
    priority: 2,
    action: { type: 'block' },
    condition: {
      regexFilter: `^https?://[a-zA-Z0-9-]+\\.dash\\.?(?::[0-9]+)?(?:[/?#].*)?$`,
      // Without the sandbox (Firefox) no rule sends a nested .dash frame anywhere, so it is blocked too.
      excludedResourceTypes: sandbox ? ['main_frame', 'sub_frame'] : ['main_frame'],
      isUrlFilterCaseSensitive: false,
    },
  } as Rule);
  if (sandbox) {
    // A site page that navigates its own frame lands back in the sandbox, which asks the viewer for that address.
    rules.push({
      id: RULE_IDS.frame,
      priority: 2,
      action: { type: 'redirect', redirect: { regexSubstitution: `${base}sandbox.html#https://\\1.dash\\2` } },
      condition: { regexFilter: DIRECT, resourceTypes: ['sub_frame'], isUrlFilterCaseSensitive: false },
    } as Rule);
  }
  if (settings.catchSearches) {
    SEARCH_ENGINES.forEach((engine, i) => {
      rules.push({
        id: RULE_IDS.searchBase + i,
        priority: 1,
        action: { type: 'redirect', redirect: { regexSubstitution: `${viewer}\\1.dash\\2` } },
        condition: {
          regexFilter: `^${engine.prefix}(?:[^#]*&)?${engine.param}=${LABEL}\\.dash((?:/|%2[fF])[^&#+%]*)?(?:[&#].*)?$`,
          resourceTypes: ['main_frame'],
          isUrlFilterCaseSensitive: false,
        },
      } as Rule);
    });
  }
  return rules;
}

const SEARCH_PARAMS = ['q', 'query', 'p', 'text', 'wd'];
/** Other search engines whose results the fallback acts on. Only these: on other sites `?q=x.dash` is not a search the browser made. */
const FALLBACK_SEARCH_HOSTS = /(^|\.)(yandex\.[a-z]{2,3}(\.[a-z]{2})?|baidu\.com|search\.naver\.com|search\.seznam\.cz|mojeek\.com|presearch\.com|you\.com|search\.aol\.com|ask\.com|metager\.org|swisscows\.com|search\.yahoo\.co\.jp)$/;

/**
 * The target for a search URL whose query is exactly a `.dash` address, when no redirect rule acted
 * on it: a fallback engine, or a listed engine whose host the extension cannot act on (`ruleActs`).
 * By then the engine has the request; the rules are what keeps a search private.
 */
export function targetForSearch(searchUrl: string, ruleActs: (url: URL) => boolean = () => true): Target | undefined {
  let url: URL;
  try {
    url = new URL(searchUrl);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:') return undefined;
  const listed = SEARCH_ENGINES.some((engine) => new RegExp(`^${engine.prefix}`, 'i').test(searchUrl));
  if (listed ? ruleActs(url) : !FALLBACK_SEARCH_HOSTS.test(url.hostname)) return undefined;
  for (const param of SEARCH_PARAMS) {
    const query = url.searchParams.get(param)?.trim();
    if (query && /^[a-z0-9-]+\.dash(\/\S*)?$/i.test(query)) return parseTarget(query);
  }
  return undefined;
}

/** A gateway must be https, or plain http on this machine. */
export function parseGateway(input: string): { origin: string; host: string; protocol: string } | undefined {
  let url: URL;
  try {
    url = new URL(/^[a-z]+:\/\//i.test(input.trim()) ? input.trim() : `https://${input.trim()}`);
  } catch {
    return undefined;
  }
  if (url.pathname !== '/' || url.search || url.hash || url.username || url.password) return undefined;
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && /^(localhost|[a-z0-9-]+\.localhost)$/.test(url.hostname))) return undefined;
  if (!url.hostname.includes('.') && url.hostname !== 'localhost') return undefined;
  return { origin: url.origin, host: url.host, protocol: url.protocol };
}

/** The gateway's address for a target, when the user turned the fallback on. */
export function gatewayUrl(settings: Settings, target: Target): string | undefined {
  const gateway = settings.gatewayFallback ? parseGateway(settings.gateway) : undefined;
  return gateway ? `${gateway.protocol}//${target.label}.${gateway.host}${target.path}${target.search}` : undefined;
}

export async function loadSettings(): Promise<Settings> {
  const stored = (await chrome.storage.local.get('settings')).settings as Partial<Settings> | undefined;
  return { ...DEFAULT_SETTINGS, ...stored };
}

export async function saveSettings(settings: Settings): Promise<void> {
  await chrome.storage.local.set({ settings });
}
