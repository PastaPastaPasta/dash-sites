import { utf8, type SiteFile } from '@dash-sites/core';
import { THEMES, type Theme } from '../template.js';
import type { SiteAsset } from '../assets.js';
import { BASE_CSS, BLOCKS, type ViewContext } from './blocks.js';
import { escapeText, h, toHtml, type Element } from './markup.js';
import { BLOCK_TYPES, imagePaths, PAGE_MODEL_PATH, serializePageModel, tidyPageModel, type Block, type BlockType, type PageModel } from './model.js';

const ALWAYS = new Set(['html', 'body', 'main']);

function selectorMatches(selector: string, body: string): boolean {
  return selector.split(',').some((one) =>
    (one.match(/\.[\w-]+|(?<![\w.:-])[a-z][a-z0-9]*/g) ?? []).every((token) =>
      token.startsWith('.') ? new RegExp(`class="(?:[^"]* )?${token.slice(1)}(?: [^"]*)?"`).test(body) : ALWAYS.has(token) || new RegExp(`<${token}[\\s>]`).test(body),
    ),
  );
}

/**
 * The theme, the base rules, and the rules of each block type used, in a fixed order. Given the
 * page's body, rules for elements and classes the body does not have are left out as well.
 */
export function pageStylesheet(theme: Theme, used: Iterable<BlockType>, body?: string): string {
  const wanted = new Set(used);
  const css = THEMES[theme].css + BASE_CSS + BLOCK_TYPES.filter((type) => wanted.has(type)).map((type) => BLOCKS[type].css).join('');
  if (body === undefined) return css;
  return css
    .split('}')
    .filter((rule) => rule && selectorMatches(rule.slice(0, rule.indexOf('{')), body))
    .map((rule) => `${rule}}`)
    .join('');
}

export function viewBlock(block: Block, context: ViewContext): Element | null {
  return (BLOCKS[block.type].view as (props: unknown, context: ViewContext) => Element | null)(block.props, context);
}

function pageTitle(blocks: Block[], siteName: string): string {
  const header = blocks.find((block) => block.type === 'header' && block.props.name);
  return header?.type === 'header' ? header.props.name : siteName;
}

function documentHtml(title: string, css: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeText(title)}</title>
<style>${css}</style>
</head>
<body>
<main>
${body}
</main>
</body>
</html>
`;
}

/** The home page alone. `src` maps image paths to the addresses to show them from. */
export function renderHomePage(model: PageModel, siteName: string, src: (path: string) => string | undefined = (path) => path): string {
  const tidy = tidyPageModel(model);
  const blocks = tidy.pages['/'];
  const context: ViewContext = { src };
  const body = blocks
    .map((block) => viewBlock(block, context))
    .filter((part): part is Element => part !== null)
    .map(toHtml)
    .join('\n');
  return documentHtml(pageTitle(blocks, siteName), pageStylesheet(tidy.theme, blocks.map((block) => block.type), body), body);
}

/**
 * The files of a site built in the editor: the home page, a not-found page, the page model for
 * later editing, and the images the page uses. The same model always gives the same bytes.
 */
export function renderSite(model: PageModel, siteName: string, assets: readonly SiteAsset[]): SiteFile[] {
  const tidy = tidyPageModel(model);
  const byPath = new Map(assets.map((asset) => [asset.path, asset]));
  const images = imagePaths(tidy).flatMap((path) => byPath.get(path) ?? []);
  const stored = new Set(images.map((image) => image.path));
  const index = renderHomePage(tidy, siteName, (path) => (stored.has(path) ? path : undefined));
  const title = pageTitle(tidy.pages['/'], siteName);
  const notFound = [h('h1', null, 'Nothing here'), h('p', { class: 'tagline' }, h('a', { href: '/' }, `Back to ${title}`))].map(toHtml).join('\n');
  const missing = documentHtml(`Not found: ${title}`, pageStylesheet(tidy.theme, ['header'], notFound), notFound);
  return [
    { path: '/index.html', bytes: utf8.encode(index) },
    { path: '/404.html', bytes: utf8.encode(missing) },
    { path: PAGE_MODEL_PATH, bytes: utf8.encode(serializePageModel(tidy)) },
    ...images.map((image) => ({ path: image.path, bytes: image.bytes, type: image.type })),
  ];
}
