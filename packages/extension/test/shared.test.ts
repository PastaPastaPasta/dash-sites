import { describe, expect, it } from 'vitest';
import { asFrameMessage } from '../src/protocol.js';
import { DEFAULT_SETTINGS, gatewayUrl, parseTarget, redirectRules, targetForSearch, viewerHash } from '../src/shared.js';

const BASE = 'chrome-extension://abc/';

/** Applies the rules as the browser would: the first matching rule's substitution, with RE2 syntax JS also reads. */
function redirect(url: string, type: 'main_frame' | 'sub_frame' = 'main_frame', settings = DEFAULT_SETTINGS): string | undefined {
  const rules = redirectRules(BASE, settings, true).sort((a, b) => (b.priority ?? 1) - (a.priority ?? 1));
  for (const rule of rules) {
    if (!rule.condition.resourceTypes?.includes(type as chrome.declarativeNetRequest.ResourceType)) continue;
    const pattern = new RegExp(rule.condition.regexFilter as string, rule.condition.isUrlFilterCaseSensitive === false ? 'i' : '');
    const match = pattern.exec(url);
    if (!match) continue;
    return (rule.action.redirect?.regexSubstitution as string).replace(/\\(\d)/g, (_, n: string) => match[Number(n)] ?? '');
  }
  return undefined;
}

describe('targets', () => {
  it('parses names, paths and queries', () => {
    expect(parseTarget('alice')).toEqual({ label: 'alice', path: '/', search: '' });
    expect(parseTarget('Alice.DASH/blog/a b')).toEqual({ label: 'alice', path: '/blog/a%20b', search: '' });
    expect(parseTarget('http://alice.dash:80/blog?x=1#top')).toEqual({ label: 'alice', path: '/blog', search: '?x=1' });
    expect(parseTarget('alice.dash%2Fblog')).toEqual({ label: 'alice', path: '/blog', search: '' });
    expect(parseTarget('alice.dash.')).toEqual({ label: 'alice', path: '/', search: '' });
    expect(parseTarget('alice.com')).toBeUndefined();
    expect(parseTarget('a.b.dash')).toBeUndefined();
    expect(parseTarget('')).toBeUndefined();
    expect(viewerHash({ label: 'alice', path: '/blog', search: '?x=1' })).toBe('#alice.dash/blog?x=1');
  });
});

describe('redirect rules', () => {
  it('send .dash addresses to the viewer before any DNS lookup', () => {
    expect(redirect('http://alice.dash/')).toBe(`${BASE}site.html#alice.dash/`);
    expect(redirect('https://Alice.dash/blog?x=1')).toBe(`${BASE}site.html#Alice.dash/blog?x=1`);
    expect(redirect('http://alice.dash')).toBe(`${BASE}site.html#alice.dash`);
    expect(redirect('http://alice.dash./')).toBe(`${BASE}site.html#alice.dash/`);
    expect(redirect('https://alice.dash.site/')).toBeUndefined();
    expect(redirect('https://alice.dashboard.com/')).toBeUndefined();
  });

  it('send a site frame that navigates itself back to the sandbox', () => {
    expect(redirect('https://alice.dash/next', 'sub_frame')).toBe(`${BASE}sandbox.html#https://alice.dash/next`);
  });

  it('catch a search for exactly a .dash name before it is sent', () => {
    expect(redirect('https://www.google.com/search?q=alice.dash&oq=alice.dash&sourceid=chrome&ie=UTF-8')).toBe(`${BASE}site.html#alice.dash`);
    expect(redirect('https://www.google.co.uk/search?client=firefox-b-d&q=alice.dash')).toBe(`${BASE}site.html#alice.dash`);
    expect(redirect('https://www.bing.com/search?q=alice.dash%2Fblog&form=QBLH')).toBe(`${BASE}site.html#alice.dash%2Fblog`);
    expect(redirect('https://duckduckgo.com/?t=ffab&q=alice.dash')).toBe(`${BASE}site.html#alice.dash`);
    expect(redirect('https://search.yahoo.com/search?p=alice.dash')).toBe(`${BASE}site.html#alice.dash`);
    expect(redirect('https://www.startpage.com/sp/search?query=alice.dash')).toBe(`${BASE}site.html#alice.dash`);
    expect(parseTarget(decodeURIComponent('alice.dash%2Fblog'))).toEqual({ label: 'alice', path: '/blog', search: '' });
  });

  it('leave other searches alone', () => {
    expect(redirect('https://www.google.com/search?q=what+is+alice.dash')).toBeUndefined();
    expect(redirect('https://www.google.com/search?q=alice.dashboard')).toBeUndefined();
    expect(redirect('https://www.google.com/search?q=alice.dash+price')).toBeUndefined();
    expect(redirect('https://www.google.com/search?oq=alice.dash&q=cats')).toBeUndefined();
    expect(redirect('https://evil.example/search?q=alice.dash')).toBeUndefined();
    expect(redirect('https://www.google.com/search?q=alice.dash', 'main_frame', { ...DEFAULT_SETTINGS, catchSearches: false })).toBeUndefined();
  });

  it('fall back only for engines the rules do not list', () => {
    expect(targetForSearch('https://yandex.ru/search/?text=alice.dash')).toEqual({ label: 'alice', path: '/', search: '' });
    expect(targetForSearch('https://www.baidu.com/s?wd=alice.dash')).toEqual({ label: 'alice', path: '/', search: '' });
    // Google ccTLDs the host permissions do not cover reach the fallback; the ones they cover are redirected by the rules.
    expect(targetForSearch('https://www.google.com.mx/search?q=alice.dash', () => false)).toEqual({ label: 'alice', path: '/', search: '' });
    expect(targetForSearch('https://www.google.com/search?q=alice.dash')).toBeUndefined();
    expect(targetForSearch('https://yandex.ru/search/?text=alice+dash')).toBeUndefined();
    expect(targetForSearch('https://github.com/search?q=alice.dash')).toBeUndefined();
    expect(targetForSearch('https://shop.example/?q=alice.dash')).toBeUndefined();
  });
});

describe('gateway fallback', () => {
  it('is off unless turned on', () => {
    const target = { label: 'alice', path: '/a', search: '?b' };
    expect(gatewayUrl({ ...DEFAULT_SETTINGS, gateway: 'https://dash.site' }, target)).toBeUndefined();
    expect(gatewayUrl({ ...DEFAULT_SETTINGS, gatewayFallback: true, gateway: 'https://dash.site' }, target)).toBe('https://alice.dash.site/a?b');
    expect(gatewayUrl({ ...DEFAULT_SETTINGS, gatewayFallback: true, gateway: 'http://example.com' }, target)).toBeUndefined();
  });
});

describe('frame messages', () => {
  it('accept only known, well-formed requests', () => {
    expect(asFrameMessage({ type: 'navigate', url: 'https://a.dash/' })).toEqual({ type: 'navigate', url: 'https://a.dash/', replace: false });
    expect(asFrameMessage({ type: 'title', title: 'x'.repeat(500) })).toEqual({ type: 'title', title: 'x'.repeat(200) });
    expect(asFrameMessage({ type: 'navigate' })).toBeUndefined();
    expect(asFrameMessage({ type: 'eval', url: 'x' })).toBeUndefined();
    expect(asFrameMessage('navigate')).toBeUndefined();
  });
});
