import { describe, expect, it } from 'vitest';
import { checkLinks, describeLinkProblem, utf8, type SiteFile } from '../src/index.js';

const site = (pages: Record<string, string>): SiteFile[] => Object.entries(pages).map(([path, text]) => ({ path, bytes: utf8.encode(text) }));

describe('checkLinks', () => {
  it('reports a download link to a file the upload does not have', () => {
    const files = site({ '/index.html': '<a class="button" href="cv.pdf" download="someone-cv.pdf">CV</a>', '/site.css': '' });
    const problems = checkLinks(files);
    expect(problems).toEqual([{ page: '/index.html', link: 'cv.pdf', missing: true, download: true }]);
    expect(describeLinkProblem(problems[0]!)).toContain('Add the file and remove the download attribute');
  });

  it('reads srcset the way browsers do', () => {
    const files = site({
      '/index.html': '<img src="a.png" srcset="data:image/gif;base64,R0lGOD,lh 1x, a.png?v=1,2 2x,b.png">',
      '/a.png': '',
    });
    expect(checkLinks(files)).toEqual([{ page: '/index.html', link: 'b.png', missing: true, download: false }]);
  });

  it('leaves download links that a script points at a blob alone, but not a named download of the page', () => {
    const files = site({ '/index.html': '<a id="save" href="#" download>Save</a><a href="?x=1" download>Save</a><a href="/index.html" download="page.html">Page</a>' });
    expect(checkLinks(files)).toEqual([{ page: '/index.html', link: '/index.html', missing: false, download: true }]);
  });

  it('uses the first <base> with an href, even an empty one', () => {
    const files = site({ '/index.html': '<base href=""><base href="https://cdn.example/"><img src="gone.png">' });
    expect(checkLinks(files)).toEqual([{ page: '/index.html', link: 'gone.png', missing: true, download: false }]);
  });

  it('skips raw text correctly after letters that lowercase to more than one character', () => {
    const before = 'İ'.repeat(20);
    const files = site({
      '/hidden.html': `${before}<script>x</script><script>var s = "<img src='gone.png'>";</script>`,
      '/shown.html': `<p>${'İstanbul '.repeat(30)}</p><script>x</script><a href="gone.html">`,
    });
    expect(checkLinks(files)).toEqual([{ page: '/shown.html', link: 'gone.html', missing: true, download: false }]);
  });

  it('uses only the first <base>, for links before it too', () => {
    const files = site({ '/index.html': '<img src="a.png"><base href="/assets/"><base href="/other/"><img src="b.png">', '/assets/a.png': '', '/assets/b.png': '' });
    expect(checkLinks(files)).toEqual([]);
  });

  it('stays fast on text full of unclosed angle brackets', () => {
    const files = site({ '/index.html': "if a<b it's fine. ".repeat(20000) + '<' + 'a'.repeat(65536) + '!<a href="gone.html">' });
    const started = Date.now();
    expect(checkLinks(files).map((p) => p.link)).toEqual(['gone.html']);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('accepts links that the host answers', () => {
    const files = site({
      '/index.html': `<link rel="stylesheet" href="/site.css"><a href="about">About</a><a href="blog/">Blog</a><a href="docs">Docs</a>
        <a href="#top">Top</a><a href="?q=1">Query</a><a href="">Self</a><img src="img/a.png" srcset="img/a.png 1x, img/a@2x.png 2x">
        <a href="https://example.com/x.pdf">Elsewhere</a><a href="//cdn.example/x.js">CDN</a><a href="mailto:a@b.c">Mail</a>
        <a href="data:text/plain,hi">Data</a><a href="/.well-known/dash/site.json">Record</a><a href="a&amp;b.txt">Amp</a>`,
      '/site.css': '',
      '/about.html': '',
      '/blog/index.html': '<a href="../index.html">Home</a><a href="post.html">Post</a>',
      '/blog/post.html': '',
      '/docs/index.html': '',
      '/img/a.png': '',
      '/img/a@2x.png': '',
      '/a&b.txt': '',
    });
    expect(checkLinks(files)).toEqual([]);
  });

  it('resolves links against the page and its <base>', () => {
    const files = site({
      '/blog/index.html': '<a href="post.html">Post</a>',
      '/docs/index.html': '<base href="/assets/"><img src="logo.png">',
      '/blog/post.html': '',
    });
    expect(checkLinks(files)).toEqual([{ page: '/docs/index.html', link: 'logo.png', missing: true, download: false }]);
  });

  it('ignores markup inside comments, scripts and styles, and non-HTML files', () => {
    const files = site({
      '/index.html': '<!--><!---><!-- <a href="gone.html"> --><script>const s = "<img src=\'gone.png\'>";</script><style>a::after{content:"<a href=x>"}</style><p title="a>b">ok</p>',
      '/notes.txt': '<a href="gone.html">',
    });
    expect(checkLinks(files)).toEqual([]);
  });

  it('treats a 404.html fallback as missing, and an SPA fallback as missing only for file names', () => {
    const files = site({ '/index.html': '<a href="/route">Route</a><a href="/app.js">App</a>', '/404.html': '' });
    expect(checkLinks(files).map((p) => p.link)).toEqual(['/route', '/app.js']);
    expect(checkLinks(files, { spa: true }).map((p) => p.link)).toEqual(['/app.js']);
  });

  it('reports a download link even when the file exists, once per page and link', () => {
    const files = site({ '/index.html': '<a href="cv.pdf" download>CV</a><a href="cv.pdf" download>CV again</a>', '/cv.pdf': '' });
    const problems = checkLinks(files);
    expect(problems).toEqual([{ page: '/index.html', link: 'cv.pdf', missing: false, download: true }]);
    expect(describeLinkProblem(problems[0]!)).toContain('Remove the download attribute');
  });
});
