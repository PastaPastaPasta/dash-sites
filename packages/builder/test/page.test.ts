import { describe, expect, it } from 'vitest';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';
import { buildSite, utf8, type DomainRecord, type SiteRecord } from '@dash-sites/core';
import { cleanRichText, plainText, toHtml, h } from '../src/page/markup.js';
import { BLOCKS } from '../src/page/blocks.js';
import { emptyPageModel, newBlock, PAGE_MODEL_PATH, readPageModel, serializePageModel, tidyPageModel, type PageModel } from '../src/page/model.js';
import { pageStylesheet, renderHomePage, renderSite } from '../src/page/render.js';
import { costSplit, fileCredits } from '../src/page/cost.js';
import { LEGACY_DRAFT_KEY, loadPageDraft, modelFromLegacyDraft, PAGE_DRAFT_KEY, PAGE_IMAGES_KEY, savePageDraft } from '../src/page/draft.js';
import { readPublishedPage, ReopenError } from '../src/page/reopen.js';
import type { KeyValue } from '../src/wallet.js';
import type { SiteAsset } from '../src/assets.js';

const picture: SiteAsset = { path: '/images/0a1b2c3d4e5f.webp', type: 'image/webp', bytes: new Uint8Array(60_000).map((_, i) => (i * 7919) % 251) };

/** The reference page of docs/VISUAL-BUILDER.md §3, without the widget tags (milestone 2). */
export const reference: PageModel = {
  v: 1,
  theme: 'paper',
  pages: {
    '/': [
      newBlock('header', { image: picture.path, name: 'Alice Nakamoto', tagline: 'Woodworker in Lisbon. I build small furniture and write about the tools.' }),
      newBlock('text', {
        body: '<p>I started with a borrowed chisel and a kitchen table, and ten years later the table is the only thing in the flat I did not make. This page collects the pieces I have for sale, the notes I keep on sharpening and joinery, and the places where you can find me. Everything here is paid for once and stored on Dash Platform under my name, so it stays up without a hosting bill.</p>',
      }),
      newBlock('links', {
        items: [
          { label: 'Shop: stools and side tables', url: 'https://example.com/shop' },
          { label: 'Notes on sharpening', url: '/notes/sharpening' },
          { label: 'Mastodon', url: 'https://example.social/@alice' },
          { label: 'Write to me', url: 'mailto:alice@example.com' },
        ],
      }),
      newBlock('cards', {
        items: [
          { title: 'Made to order', text: 'Each piece is cut and finished by hand in four to six weeks.', url: '' },
          { title: 'Local oak and ash', text: 'Timber comes from two sawmills within an hour of the workshop.', url: '' },
          { title: 'Pay in Dash', text: 'Send to alice.dash from any DashPay wallet, with no card fees.', url: '' },
        ],
      }),
      newBlock('footer', { text: 'alice.dash is published on Dash Platform.' }),
    ],
  },
};

function memory(): KeyValue & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return { values, getItem: (key) => values.get(key) ?? null, setItem: (key, value) => void values.set(key, value), removeItem: (key) => void values.delete(key) };
}

const file = (files: ReturnType<typeof renderSite>, path: string) => utf8.decode(files.find((f) => f.path === path)!.bytes);

describe('rich text', () => {
  it('keeps the allowed tags and drops everything else', () => {
    expect(cleanRichText('<p class="x" onclick="evil()">Hi <b>there</b> <i>you</i></p><script>alert(1)</script><style>p{}</style>')).toBe('<p>Hi <strong>there</strong> <em>you</em></p>');
    expect(cleanRichText('<h1>Big</h1><h4>Small</h4><ul><li><p>one</p></li></ul><div>plain <span>text</span></div>')).toBe('<h2>Big</h2><h3>Small</h3><ul><li><p>one</p></li></ul>plain text');
    expect(cleanRichText('<img src=x onerror=alert(1)><iframe src="https://x"></iframe><svg><script>x</script></svg>ok')).toBe('ok');
  });

  it('allows only safe links', () => {
    expect(cleanRichText('<a href="javascript:alert(1)">x</a>')).toBe('x');
    expect(cleanRichText('<a href="JaVaScRiPt&colon;alert(1)">x</a>')).toBe('x');
    expect(cleanRichText('<a href="&#106;avascript:alert(1)">x</a>')).toBe('x');
    expect(cleanRichText('<a href="data:text/html,x" target="_blank">x</a>')).toBe('x');
    expect(cleanRichText('<a target="_blank" rel="noopener" href="https://a.example/?q=1&amp;r=&quot;2&quot;">a</a>')).toBe('<a href="https://a.example/?q=1&amp;r=&quot;2&quot;">a</a>');
    expect(cleanRichText("<a href='github.com/x'>gh</a>")).toBe('<a href="https://github.com/x">gh</a>');
  });

  it('escapes text, closes what is open and is canonical', () => {
    const messy = '<p>1 < 2 &amp; 3 > 2 &lt;b&gt; <strong>bold <em>both</p> tail &copy; &#x1F600; &#0;';
    const clean = cleanRichText(messy);
    expect(clean).toBe('<p>1 &lt; 2 &amp; 3 &gt; 2 &lt;b&gt; <strong>bold <em>both</em></strong></p> tail &amp;copy; \u{1F600} �');
    expect(cleanRichText(clean)).toBe(clean);
    expect(cleanRichText('<p>"quotes" and \'apostrophes\'</p>')).toBe('<p>"quotes" and \'apostrophes\'</p>');
    expect(cleanRichText('<!-- <script>x</script> -->a<a href="https://x.example"><a href="https://y.example">b</a>c')).toBe('a<a href="https://x.example">b</a>c');
    expect(plainText('<h2>A &amp; B</h2><p>c</p>')).toBe('A & B c');
  });
});

describe('page model', () => {
  it('round-trips through its canonical JSON', () => {
    const json = serializePageModel(reference);
    expect(readPageModel(JSON.parse(json))).toEqual(tidyPageModel(reference));
    expect(serializePageModel(readPageModel(JSON.parse(json)))).toBe(json);
    expect(JSON.parse(json).pages['/'][0]).toEqual({ type: 'header', props: { image: picture.path, name: 'Alice Nakamoto', tagline: reference.pages['/'][0]!.props.tagline } });
    expect(serializePageModel({ v: 1, theme: 'night', pages: { '/': [newBlock('divider')] } })).toBe('{"v":1,"theme":"night","pages":{"/":[{"type":"divider"}]}}');
  });

  it('refuses anything unexpected', () => {
    const good = JSON.parse(serializePageModel(reference));
    const bad = (change: (m: any) => void): unknown => {
      const copy = structuredClone(good);
      change(copy);
      return copy;
    };
    const cases: Array<[unknown, RegExp]> = [
      [null, /not an object/],
      [[], /not an object/],
      [bad((m) => (m.v = 2)), /version 2 is not supported/],
      [bad((m) => delete m.v), /version undefined/],
      [bad((m) => (m.theme = 'neon')), /unknown theme/],
      [bad((m) => (m.extra = 1)), /unknown field "extra"/],
      [bad((m) => (m.pages['/about'] = [])), /unknown field "\/about"/],
      [bad((m) => (m.pages['/'] = {})), /not a list of blocks/],
      [bad((m) => m.pages['/'].push({ type: 'poll', props: {} })), /unknown block type "poll"/],
      [bad((m) => m.pages['/'].push({ type: 'toString' })), /unknown block type "toString"/],
      [bad((m) => m.pages['/'].push({ type: 'divider', id: 'x' })), /unknown field "id"/],
      [bad((m) => (m.pages['/'][0].props.name = 7)), /\[0\]\.props\.name: not text/],
      [bad((m) => (m.pages['/'][0].props.onclick = 'x')), /unknown field "onclick"/],
      [bad((m) => (m.pages['/'][0].props.name = 'x'.repeat(121))), /longer than 120/],
      [bad((m) => (m.pages['/'][0].props.image = 'https://tracker.example/p.gif')), /not an image of this site/],
      [bad((m) => (m.pages['/'][0].props.image = '/images/../index.html')), /not an image of this site/],
      [bad((m) => (m.pages['/'][2].props.items[1].url = 'javascript:alert(1)')), /items\[1\]\.url: not a web, mail or site address/],
      [bad((m) => (m.pages['/'][2].props.items = 'x')), /not a list/],
      [bad((m) => (m.pages['/'][2].props.items = Array(41).fill({ label: 'a', url: '/a' }))), /more than 40 items/],
      [bad((m) => (m.pages['/'][2].props.items[0] = [1])), /not an object/],
      [bad((m) => (m.pages['/'] = Array(101).fill({ type: 'divider' }))), /more than 100 blocks/],
    ];
    for (const [input, problem] of cases) expect(() => readPageModel(input), String(problem)).toThrow(problem);
  });

  it('cleans rich text when reading, and repair drops only the broken blocks', () => {
    const read = readPageModel({ v: 1, theme: 'paper', pages: { '/': [{ type: 'text', props: { body: '<p onclick="x">hi</p><script>bad()</script>' } }] } });
    expect(read.pages['/'][0]).toEqual({ type: 'text', props: { body: '<p>hi</p>' } });
    const repaired = readPageModel({ v: 1, theme: 'paper', pages: { '/': [{ type: 'divider' }, { type: 'poll' }, { type: 'button', props: { url: 'javascript:x' } }, { type: 'footer', props: { text: 'f' } }] } }, { repair: true });
    expect(repaired.pages['/'].map((b) => b.type)).toEqual(['divider', 'footer']);
  });

  it('tidies the editor state into a publishable model', () => {
    const tidy = tidyPageModel({ theme: 'bogus', pages: { '/': [{ type: 'header', props: { id: 'header-1', name: '  Bob  ', image: 'https://x/y.png', extra: 1 } }, { type: 'nope' }, { type: 'button', props: { label: 'Go', url: 'javascript:x' } }] } });
    expect(tidy).toEqual({ v: 1, theme: 'paper', pages: { '/': [{ type: 'header', props: { image: '', name: 'Bob', tagline: '' } }, { type: 'button', props: { label: 'Go', url: '' } }] } });
  });
});

describe('blocks', () => {
  const src = (path: string) => path;
  const html = (block: ReturnType<typeof newBlock>) => {
    const view = (BLOCKS[block.type].view as (p: unknown, c: unknown) => ReturnType<typeof h> | null)(block.props, { src });
    return view ? toHtml(view) : '';
  };

  it('renders each block type', () => {
    expect(html(newBlock('header', { image: '/images/a.webp', name: 'Al', tagline: 'Hi' }))).toBe('<header><img class="me" src="/images/a.webp" alt=""><h1>Al</h1><p class="tagline">Hi</p></header>');
    expect(html(newBlock('header', { name: 'Al' }))).toBe('<header><h1>Al</h1></header>');
    expect(html(newBlock('text', { body: '<p>a</p>' }))).toBe('<div class="tx"><p>a</p></div>');
    expect(html(newBlock('links', { items: [{ label: 'A', url: 'a.example' }, { label: '', url: '/b' }, { label: '', url: '' }] }))).toBe('<ul class="links"><li><a href="https://a.example">A</a></li><li><a href="/b">/b</a></li></ul>');
    expect(html(newBlock('links'))).toBe('');
    expect(html(newBlock('image', { src: '/images/a.webp', alt: 'A chair', caption: 'Oak' }))).toBe('<figure><img src="/images/a.webp" alt="A chair"><figcaption>Oak</figcaption></figure>');
    expect(html(newBlock('image'))).toBe('');
    expect(html(newBlock('cards', { items: [{ title: 'T', text: 'x', url: '' }, { title: 'L', text: '', url: '/l' }] }))).toBe('<div class="cards"><div><h3>T</h3><p>x</p></div><div><h3><a href="/l">L</a></h3></div></div>');
    expect(html(newBlock('button', { label: 'Buy', url: 'https://shop.example' }))).toBe('<p><a class="btn" href="https://shop.example">Buy</a></p>');
    expect(html(newBlock('button', { label: 'Buy', url: 'javascript:x' }))).toBe('<p><a class="btn">Buy</a></p>');
    expect(html(newBlock('divider'))).toBe('<hr>');
    expect(html(newBlock('footer', { text: 'f' }))).toBe('<footer>f</footer>');
  });

  it('escapes every text field and attribute', () => {
    const evil = '"><script>alert(1)</script>';
    const out = [
      html(newBlock('header', { name: evil, tagline: evil })),
      html(newBlock('links', { items: [{ label: evil, url: 'https://a.example/"onmouseover="x' }] })),
      html(newBlock('image', { src: '/images/a.webp', alt: evil, caption: evil })),
      html(newBlock('cards', { items: [{ title: evil, text: evil, url: '' }] })),
      html(newBlock('button', { label: evil, url: '/' })),
      html(newBlock('footer', { text: evil })),
      html(newBlock('text', { body: evil })),
    ].join('');
    expect(out).not.toContain('<script');
    expect(out).not.toContain('"onmouseover');
    expect(out).toContain('&quot;&gt;&lt;script&gt;');
    expect(out).toContain('href="https://a.example/&quot;onmouseover=&quot;x"');
  });
});

describe('published page', () => {
  it('has one stylesheet with only the rules of the blocks used, and no script', () => {
    const files = renderSite(reference, 'alice.dash', [picture]);
    const page = file(files, '/index.html');
    expect(page.match(/<style>/g)).toHaveLength(1);
    expect(page).not.toMatch(/<script|<link|@import|url\(|https:\/\/fonts/i);
    expect(page).toContain(BLOCKS.cards.css);
    expect(page).toContain(BLOCKS.links.css);
    expect(page).not.toContain(BLOCKS.button.css);
    expect(page).not.toContain(BLOCKS.image.css);
    expect(page).not.toContain('hr{');
    expect(page).toContain('<title>Alice Nakamoto</title>');
    expect(page).toContain(`<img class="me" src="${picture.path}" alt="">`);
    expect(page).not.toMatch(/[}>]h2\{|blockquote\{/);
    expect(pageStylesheet('night', ['divider'])).toBe(`${pageStylesheet('night', [])}${BLOCKS.divider.css}`);
    const withHeadings = renderHomePage({ v: 1, theme: 'paper', pages: { '/': [newBlock('text', { body: '<h2>A</h2><blockquote>q</blockquote>' })] } }, 'a.dash');
    expect(withHeadings).toMatch(/}h2\{.*}blockquote\{/);
    expect(withHeadings).not.toMatch(/}h3\{|\.cards|footer\{/);
  });

  it('is deterministic, keeps the 404 page and stores the model and the images used', () => {
    const a = renderSite(reference, 'alice.dash', [picture, { path: '/images/unused.webp', type: 'image/webp', bytes: new Uint8Array(5) }]);
    const b = renderSite(structuredClone(reference), 'alice.dash', [picture]);
    expect(a.map((f) => f.path)).toEqual(['/index.html', '/404.html', PAGE_MODEL_PATH, picture.path]);
    expect(a.map((f) => [f.path, [...f.bytes].join()])).toEqual(b.map((f) => [f.path, [...f.bytes].join()]));
    expect(buildSite(a).contentUri).toBe(buildSite(b).contentUri);
    expect(file(a, '/404.html')).toContain('<h1>Nothing here</h1>');
    expect(file(a, '/404.html')).toContain('<a href="/">Back to Alice Nakamoto</a>');
    expect(readPageModel(JSON.parse(file(a, PAGE_MODEL_PATH)))).toEqual(tidyPageModel(reference));
  });

  it('leaves out images that are not stored, and uses the site name as the title', () => {
    const files = renderSite(reference, 'alice.dash', []);
    expect(files.map((f) => f.path)).not.toContain(picture.path);
    expect(file(files, '/index.html')).not.toContain('<img');
    expect(file(renderSite({ v: 1, theme: 'signal', pages: { '/': [newBlock('divider')] } }, 'bob.dash', []), '/index.html')).toContain('<title>bob.dash</title>');
  });

  it('is within 20% of the size the prototype measured for the reference page, and costs at most 0.002 DASH without its photo', () => {
    const page = renderHomePage(reference, 'alice.dash');
    expect(utf8.encode(page).length).toBeLessThan(2286 * 1.2);
    expect(gzipSync(page, { level: 9 }).length).toBeLessThan(1254 * 1.2);
    expect(brotliCompressSync(page, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).length).toBeLessThan(943 * 1.2);
    const text = renderSite({ ...reference, pages: { '/': reference.pages['/'].slice(1) } }, 'alice.dash', []);
    expect(costSplit(text)!.total).toBeLessThanOrEqual(200_000_000n);
    expect(utf8.encode(serializePageModel(reference)).length).toBeLessThan(1700);
  });
});

describe('cost', () => {
  it('splits text and images', () => {
    const files = renderSite(reference, 'alice.dash', [picture]);
    const split = costSplit(files)!;
    expect(split.imageCount).toBe(1);
    expect(split.imageBytes).toBe(60_000);
    expect(split.images).toBe(fileCredits({ path: picture.path, bytes: picture.bytes, type: picture.type }));
    expect(split.images).toBe(60_000n * 27_500n + 5n * 28_000_000n);
    expect(split.text + split.images).toBe(split.total);
    expect(split.text).toBeGreaterThan(60_000_000n);
    expect(costSplit([])).toBeUndefined();
  });
});

describe('drafts', () => {
  it('converts a draft of the old form', () => {
    const model = modelFromLegacyDraft({ title: 'Alice', tagline: 'Builds', body: '## Now\n\nWorking on *Dash*. <script>x</script>', links: [{ label: 'Code', url: 'github.com/alice' }, { label: 'bad', url: 'javascript:x' }], theme: 'night' })!;
    expect(model.theme).toBe('night');
    expect(model.pages['/']).toEqual([
      { type: 'header', props: { image: '', name: 'Alice', tagline: 'Builds' } },
      { type: 'text', props: { body: '<h2>Now</h2>\n<p>Working on <em>Dash</em>. </p>' } },
      { type: 'links', props: { items: [{ label: 'Code', url: 'github.com/alice' }] } },
    ]);
    expect(modelFromLegacyDraft({ title: '', body: '', links: [] })).toBeUndefined();
    expect(modelFromLegacyDraft('x')).toBeUndefined();
  });

  it('loads the old draft when there is no new one, and saves and loads the new one with its images', () => {
    const store = memory();
    expect(loadPageDraft(store).model).toEqual(emptyPageModel());
    store.setItem(LEGACY_DRAFT_KEY, JSON.stringify({ title: 'Old', tagline: '', body: '', links: [], theme: 'signal' }));
    expect(loadPageDraft(store).model.pages['/'][0]).toEqual(newBlock('header', { name: 'Old' }));
    expect(savePageDraft(store, reference, [picture])).toBe('saved');
    const loaded = loadPageDraft(store);
    expect(loaded.model).toEqual(tidyPageModel(reference));
    expect(loaded.assets).toEqual([picture]);
    expect(loaded.missingImages).toBe(0);
  });

  it('keeps the page but not the images when they do not fit', () => {
    const store = memory();
    const big = { ...picture, bytes: new Uint8Array(1_200_000) };
    expect(savePageDraft(store, reference, [big])).toBe('without-images');
    expect(store.values.has(PAGE_IMAGES_KEY)).toBe(false);
    const loaded = loadPageDraft(store);
    expect(loaded.model).toEqual(tidyPageModel(reference));
    expect(loaded.missingImages).toBe(1);
    const full: KeyValue = { ...memory(), setItem: (key) => { if (key === PAGE_IMAGES_KEY) throw new Error('quota'); } };
    expect(savePageDraft(full, reference, [picture])).toBe('without-images');
    expect(savePageDraft(undefined, reference, [])).toBe('failed');
    store.setItem(PAGE_DRAFT_KEY, '{broken');
    expect(loadPageDraft(store).model).toEqual(emptyPageModel());
  });
});

describe('reopening a published page', () => {
  const domain: DomainRecord = { id: 'dom1', ownerId: 'owner1', label: 'Alice', normalizedLabel: 'a11ce', transferredAt: 1000 };
  const source = (files: ReturnType<typeof renderSite>, updatedAt = 2000) => {
    const bundle = buildSite(files);
    const site: SiteRecord = { id: 's', ownerId: 'owner1', domainId: 'dom1', content: bundle.contentUri, revision: 1, updatedAt };
    return {
      getSite: async (ownerId: string, domainId: string) => ({ value: ownerId === 'owner1' && domainId === 'dom1' ? site : undefined, proof: undefined as never }),
      getChunks: async (_owner: string, hashes: string[]) => new Map(hashes.flatMap((hash) => (bundle.chunks.has(hash) ? [[hash, bundle.chunks.get(hash)!] as const] : []))),
    };
  };

  it('reads back the model and its images', async () => {
    const opened = await readPublishedPage(source(renderSite(reference, 'alice.dash', [picture])), domain);
    expect(opened.model).toEqual(tidyPageModel(reference));
    expect(opened.assets).toEqual([picture]);
  });

  it('says why a site cannot be opened', async () => {
    await expect(readPublishedPage(source([{ path: '/index.html', bytes: utf8.encode('<h1>hand made</h1>') }]), domain)).rejects.toThrow(/not made with the page editor/);
    await expect(readPublishedPage(source(renderSite(reference, 'alice.dash', []), 500), domain)).rejects.toThrow(ReopenError);
    await expect(readPublishedPage(source([{ path: PAGE_MODEL_PATH, bytes: utf8.encode('{"v":9}') }]), domain)).rejects.toThrow(/version 9/);
    await expect(readPublishedPage(source([{ path: PAGE_MODEL_PATH, bytes: utf8.encode('nope') }]), domain)).rejects.toThrow(/cannot be read/);
  });
});
