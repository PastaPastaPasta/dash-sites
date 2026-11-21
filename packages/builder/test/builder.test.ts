import { describe, expect, it } from 'vitest';
import { buildSite, utf8 } from '@dash-sites/core';
import { zipSync } from 'fflate';
import { normalizeUpload, previewHtml, unzip } from '../src/files.js';
import { EMPTY_DRAFT, isBlank, renderPage, safeUrl } from '../src/template.js';

const text = (s: string) => utf8.encode(s);
const html = (files: ReturnType<typeof renderPage>) => utf8.decode(files.find((f) => f.path === '/index.html')!.bytes);

describe('page template', () => {
  it('renders a page that packs into a site', () => {
    const files = renderPage({ ...EMPTY_DRAFT, title: 'Alice', tagline: 'Builds things', body: '## Now\n\nWorking on *Dash*.', links: [{ label: 'Code', url: 'github.com/alice' }] }, 'alice.dash');
    const page = html(files);
    expect(page).toContain('<h1>Alice</h1>');
    expect(page).toContain('<h2>Now</h2>');
    expect(page).toContain('<a href="https://github.com/alice">Code</a>');
    expect(files.map((f) => f.path).sort()).toEqual(['/404.html', '/index.html']);
    expect(buildSite(files).stats.files).toBe(2);
  });

  it('escapes text fields and drops unsafe links', () => {
    const page = html(renderPage({ ...EMPTY_DRAFT, title: '<script>x</script>', tagline: '"quoted" & <b>', links: [{ label: 'bad', url: 'javascript:alert(1)' }, { label: '<i>ok</i>', url: 'https://ok.example/?a=1&b=2' }] }, 'alice.dash'));
    expect(page).toContain('<h1>&lt;script&gt;x&lt;/script&gt;</h1>');
    expect(page).toContain('&quot;quoted&quot; &amp; &lt;b&gt;');
    expect(page).not.toContain('javascript:');
    expect(page).toContain('href="https://ok.example/?a=1&amp;b=2">&lt;i&gt;ok&lt;/i&gt;');
  });

  it('includes the picture, and uses the name when there is no title', () => {
    const files = renderPage({ ...EMPTY_DRAFT, picture: { bytes: text('png'), ext: 'png' } }, 'alice.dash');
    expect(html(files)).toContain('<h1>alice.dash</h1>');
    expect(html(files)).toContain('src="picture.png"');
    expect(files.some((f) => f.path === '/picture.png')).toBe(true);
    expect(html(renderPage({ ...EMPTY_DRAFT, picture: { bytes: text('png'), ext: 'png' } }, 'a', 'data:x'))).toContain('src="data:x"');
  });

  it('knows a blank draft and a safe link', () => {
    expect(isBlank(EMPTY_DRAFT)).toBe(true);
    expect(isBlank({ ...EMPTY_DRAFT, body: 'x' })).toBe(false);
    expect(safeUrl('mailto:a@b.co')).toBe('mailto:a@b.co');
    expect(safeUrl('/about')).toBe('/about');
    expect(safeUrl('data:text/html,x')).toBeUndefined();
    expect(safeUrl('not a link')).toBeUndefined();
  });
});

describe('uploads', () => {
  it('strips the wrapping folder and junk', () => {
    const { files, skipped } = normalizeUpload([
      { path: 'my-site/index.html', bytes: text('<h1>x</h1>') },
      { path: 'my-site/css/a.css', bytes: text('a{}') },
      { path: 'my-site/.git/config', bytes: text('x') },
      { path: 'my-site/.DS_Store', bytes: text('x') },
      { path: 'my-site/.well-known/security.txt', bytes: text('x') },
      { path: 'my-site/node_modules/x/index.js', bytes: text('x') },
    ]);
    expect(files.map((f) => f.path).sort()).toEqual(['/.well-known/security.txt', '/css/a.css', '/index.html']);
    expect(skipped.length).toBe(3);
  });

  it('keeps folders when index.html is already at the top', () => {
    const { files } = normalizeUpload([{ path: 'index.html', bytes: text('x') }, { path: 'blog/index.html', bytes: text('y') }]);
    expect(files.map((f) => f.path).sort()).toEqual(['/blog/index.html', '/index.html']);
  });

  it('reads zip archives', () => {
    const archive = zipSync({ 'site/index.html': text('<p>zip</p>'), 'site/img/': new Uint8Array(), 'site/img/a.png': text('png') });
    const { files } = normalizeUpload(unzip(archive));
    expect(files.map((f) => f.path).sort()).toEqual(['/img/a.png', '/index.html']);
  });

  it('inlines local assets into the preview and leaves the rest', () => {
    const preview = previewHtml([
      { path: '/index.html', bytes: text('<link rel="stylesheet" href="css/a.css"><img src="/img/a.png"><a href="about.html">a</a><script src="https://cdn.example/x.js"></script><img src="missing.png">') },
      { path: '/css/a.css', bytes: text('a{}') },
      { path: '/img/a.png', bytes: text('png') },
      { path: '/about.html', bytes: text('x') },
    ]) as string;
    expect(preview).toContain('href="data:text/css;base64,');
    expect(preview).toContain('src="data:image/png;base64,');
    expect(preview).toContain('href="about.html"');
    expect(preview).toContain('src="https://cdn.example/x.js"');
    expect(preview).toContain('src="missing.png"');
    expect(previewHtml([{ path: '/a.txt', bytes: text('x') }])).toBeUndefined();
  });
});
