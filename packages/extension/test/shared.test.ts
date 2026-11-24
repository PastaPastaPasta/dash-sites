import { describe, expect, it } from 'vitest';
import type { Resolution } from '@dash-sites/core';
import { readFileSync } from 'node:fs';
import { claimsFromHeaders, compare, labelForUrl, parseGateway, redirectRule, SEARCH_ORIGINS, searchRules, siteUrl, urlForInput, urlForSearch, type Gateway } from '../src/shared.js';

const gw = parseGateway('https://id.dashhq.org') as Gateway;
const local = parseGateway('http://localhost:8080') as Gateway;

describe('gateway setting', () => {
  it('accepts https and loopback http only', () => {
    expect(gw).toEqual({ origin: 'https://id.dashhq.org', protocol: 'https:', host: 'id.dashhq.org', hostname: 'id.dashhq.org' });
    expect(parseGateway('id.dashhq.org')?.origin).toBe('https://id.dashhq.org');
    expect(local.host).toBe('localhost:8080');
    for (const bad of ['http://id.dashhq.org', 'https://id.dashhq.org/path', 'https://u:p@id.dashhq.org', 'ftp://x.org', 'javascript:alert(1)', '', 'https://', 'http://127.0.0.1.evil.org']) {
      expect(parseGateway(bad), bad).toBeUndefined();
    }
  });
});

describe('redirect rule', () => {
  const rule = redirectRule(gw);
  const apply = (url: string, gateway = gw): string | undefined => {
    const r = redirectRule(gateway);
    const match = new RegExp(r.condition.regexFilter as string, 'i').exec(url);
    if (!match) return undefined;
    return (r.action.redirect?.regexSubstitution as string).replace(/\\(\d)/g, (_all, n: string) => match[Number(n)] ?? '');
  };

  it('only touches top-level and frame navigations', () => {
    expect(rule.condition.resourceTypes).toEqual(['main_frame', 'sub_frame']);
  });

  it('rewrites .dash URLs to the gateway', () => {
    expect(apply('http://alice.dash/')).toBe('https://alice.id.dashhq.org/');
    expect(apply('https://alice.dash/blog/post?x=1#top')).toBe('https://alice.id.dashhq.org/blog/post?x=1#top');
    expect(apply('http://alice.dash:8080/a')).toBe('https://alice.id.dashhq.org/a');
    expect(apply('http://alice.dash/', local)).toBe('http://alice.localhost:8080/');
  });

  it('leaves everything else alone', () => {
    for (const url of ['https://example.com/alice.dash/', 'http://blog.alice.dash/', 'http://alice.dash.evil.com/', 'http://user@alice.dash/', 'https://example.com/?u=http://alice.dash/', 'ftp://alice.dash/']) {
      expect(apply(url), url).toBeUndefined();
    }
  });
});

describe('search rule', () => {
  const apply = (url: string, gateway = gw): string | undefined => {
    const matching = searchRules(gateway).filter((r) => new RegExp(r.condition.regexFilter as string, 'i').test(url));
    expect(matching.length).toBeLessThanOrEqual(1);
    const [r] = matching;
    if (!r) return undefined;
    const substitution = (r.action.redirect?.regexSubstitution as string).replace(/\\(\d)/g, '$$$1');
    return url.replace(new RegExp(r.condition.regexFilter as string, 'i'), substitution);
  };

  it('redirects a search for exactly a .dash name before it is sent', () => {
    expect(apply('https://www.google.com/search?q=p2p.dash&oq=p2p.dash&sourceid=chrome&ie=UTF-8')).toBe('https://p2p.id.dashhq.org/');
    expect(apply('https://www.google.com/search?client=firefox-b-d&q=P2P.dash')).toBe('https://P2P.id.dashhq.org/');
    expect(apply('https://duckduckgo.com/?t=ffab&q=alice.dash')).toBe('https://alice.id.dashhq.org/');
    expect(apply('https://www.bing.com/search?q=alice.dash%2F&form=QBLH')).toBe('https://alice.id.dashhq.org/');
    expect(apply('https://search.yahoo.com/search?p=alice.dash')).toBe('https://alice.id.dashhq.org/');
    expect(apply('https://www.startpage.com/sp/search?query=alice.dash')).toBe('https://alice.id.dashhq.org/');
    expect(apply('https://alice.dash/', local)).toBeUndefined();
    expect(apply('https://www.google.com/search?q=alice.dash', local)).toBe('http://alice.localhost:8080/');
  });

  it('leaves other searches alone', () => {
    for (const url of [
      'https://www.google.com/search?q=what+is+alice.dash',
      'https://www.google.com/search?q=alice.dashboard',
      'https://www.google.com/search?q=alice.dash%2Fblog',
      'https://www.google.com/search?oq=alice.dash&q=alice',
      'https://www.google.com/maps?q=alice.dash',
      'https://www.google.com.evil.example/search?q=alice.dash',
      'https://evil.example/search?q=alice.dash',
      'http://www.google.com/search?q=alice.dash',
      'https://www.google.com/search?q=xn--abc.dash.evil',
    ]) {
      expect(apply(url), url).toBeUndefined();
    }
  });

  it('only asks for the engines it matches', () => {
    const manifest = JSON.parse(readFileSync(new URL('../static/manifest.json', import.meta.url), 'utf8')) as { optional_host_permissions: string[] };
    expect(manifest.optional_host_permissions).toEqual(SEARCH_ORIGINS);
    const rules = searchRules(gw);
    expect(new Set(rules.map((r) => r.id)).size).toBe(rules.length);
    expect(rules.every((r) => r.id !== 1 && r.condition.resourceTypes?.join() === 'main_frame' && r.condition.isUrlFilterCaseSensitive === false)).toBe(true);
  });
});

describe('typed input and searches', () => {
  it('turns names into gateway URLs', () => {
    expect(urlForInput('alice', gw)).toBe('https://alice.id.dashhq.org/');
    expect(urlForInput(' Alice.dash/Blog?x=1 ', gw)).toBe('https://alice.id.dashhq.org/Blog?x=1');
    expect(urlForInput('http://alice.dash/a', local)).toBe('http://alice.localhost:8080/a');
    for (const bad of ['', 'al', 'alice.eth', 'two words', 'alice.dash/a b', 'xn--abc.dash']) expect(urlForInput(bad, gw), bad).toBeUndefined();
  });

  it('catches a search for exactly a .dash name', () => {
    expect(urlForSearch('https://www.google.com/search?q=alice.dash&sourceid=chrome', gw)).toBe('https://alice.id.dashhq.org/');
    expect(urlForSearch('https://duckduckgo.com/?q=alice.dash%2Fblog', gw)).toBe('https://alice.id.dashhq.org/blog');
    expect(urlForSearch('https://www.google.co.uk/search?q=alice.dash', gw)).toBe('https://alice.id.dashhq.org/');
    for (const url of ['https://www.google.com/search?q=what+is+alice.dash', 'https://www.google.com/search?q=alice', 'https://evil.example/search?q=alice.dash', 'https://google.com.evil.example/search?q=alice.dash', 'not a url']) {
      expect(urlForSearch(url, gw), url).toBeUndefined();
    }
  });

  it('recognises a site shown through the gateway', () => {
    expect(labelForUrl('https://alice.id.dashhq.org/blog', gw)).toBe('alice');
    expect(labelForUrl('http://alice.localhost:8080/', local)).toBe('alice');
    for (const url of ['https://id.dashhq.org/', 'https://a.b.id.dashhq.org/', 'http://alice.id.dashhq.org/', 'https://alice.id.dashhq.org.evil.com/', 'http://alice.localhost:9090/', 'chrome://newtab/']) {
      expect(labelForUrl(url, url.includes('localhost') ? local : gw), url).toBeUndefined();
    }
    expect(siteUrl(gw, 'alice', 'x')).toBe('https://alice.id.dashhq.org/x');
  });
});

describe('verdicts', () => {
  const meta = { height: 1, timeMs: 1, coreChainLockedHeight: 1, protocolVersion: 14 };
  const domain = { id: 'd', ownerId: 'alice-id', label: 'alice', normalizedLabel: 'a11ce', transferredAt: 1 };
  const owned = { normalized: 'a11ce', domain, canonicalLabel: 'alice', ownerId: 'alice-id', meta };
  const site = { id: 's', ownerId: 'alice-id', domainId: 'd', content: 'dash-manifest:v1:aa', revision: 3, updatedAt: 2 };
  const ok: Resolution = { status: 'ok', ...owned, site, content: { scheme: 'dash-manifest', chunks: ['aa'] } };
  const headers = (h: Record<string, string>) => claimsFromHeaders({ get: (name) => h[name] ?? null });

  it('matches when owner and content agree', () => {
    expect(compare(headers({ 'x-dash-owner': 'alice-id', 'x-dash-content': site.content, 'x-dash-site-revision': '3' }), ok).kind).toBe('match');
  });

  it('flags a gateway that is behind, or serving something else', () => {
    expect(compare(headers({ 'x-dash-owner': 'alice-id', 'x-dash-content': 'dash-manifest:v1:bb', 'x-dash-site-revision': '2' }), ok).kind).toBe('behind');
    expect(compare(headers({ 'x-dash-owner': 'alice-id', 'x-dash-content': 'dash-manifest:v1:bb', 'x-dash-site-revision': '3' }), ok).kind).toBe('mismatch');
    expect(compare(headers({ 'x-dash-owner': 'mallory-id', 'x-dash-content': site.content, 'x-dash-site-revision': '3' }), ok).kind).toBe('mismatch');
  });

  it('flags a site served for a name that has none', () => {
    const served = headers({ 'x-dash-owner': 'alice-id', 'x-dash-content': site.content });
    expect(compare(served, { status: 'no-site', ...owned }).kind).toBe('mismatch');
    expect(compare(served, { status: 'unregistered', normalized: 'a11ce', meta }).kind).toBe('mismatch');
    expect(compare(headers({}), { status: 'no-site', ...owned }).kind).toBe('none');
    expect(compare(headers({}), ok).kind).toBe('none');
  });
});
