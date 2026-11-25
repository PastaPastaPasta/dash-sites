import { safeUrl, THEMES, type Theme } from '../template.js';
import { cleanRichText } from './markup.js';

export const PAGE_MODEL_VERSION = 1;
/** Where a built page keeps its model, so the owner can open it again for editing. */
export const PAGE_MODEL_PATH = '/dash-site.json';
export const IMAGE_PATH = /^\/images\/[a-z0-9][a-z0-9-]{0,63}\.(webp|jpg|png|gif)$/;
export const MAX_BLOCKS = 100;
const MAX_URL = 2048;
const MAX_RICH = 20000;

type Field = { kind: 'text'; max: number } | { kind: 'rich' } | { kind: 'url' } | { kind: 'image' } | { kind: 'list'; max: number; item: Record<string, Field> };

const text = (max: number) => ({ kind: 'text', max }) as const;
const RICH = { kind: 'rich' } as const;
const URL_FIELD = { kind: 'url' } as const;
const IMAGE = { kind: 'image' } as const;
const list = <T extends Record<string, Field>>(max: number, item: T) => ({ kind: 'list', max, item }) as const;

export const SCHEMAS = {
  header: { image: IMAGE, name: text(120), tagline: text(300) },
  text: { body: RICH },
  links: { items: list(40, { label: text(120), url: URL_FIELD }) },
  image: { src: IMAGE, alt: text(300), caption: text(300) },
  cards: { items: list(12, { title: text(120), text: text(600), url: URL_FIELD }) },
  button: { label: text(80), url: URL_FIELD },
  divider: {},
  footer: { text: text(300) },
} as const satisfies Record<string, Record<string, Field>>;

export type BlockType = keyof typeof SCHEMAS;
export const BLOCK_TYPES = Object.keys(SCHEMAS) as BlockType[];

type ValueOf<F> = F extends { kind: 'list'; item: infer I } ? Array<PropsOf<I>> : string;
type PropsOf<S> = { [K in keyof S]: ValueOf<S[K]> };
export type BlockProps<T extends BlockType = BlockType> = PropsOf<(typeof SCHEMAS)[T]>;
export type Block<T extends BlockType = BlockType> = T extends BlockType ? { type: T; props: BlockProps<T> } : never;

export interface PageModel {
  v: typeof PAGE_MODEL_VERSION;
  theme: Theme;
  pages: { '/': Block[] };
}

export class PageModelError extends Error {
  constructor(where: string, problem: string) {
    super(`${where}: ${problem}`);
    this.name = 'PageModelError';
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isBlockType = (value: unknown): value is BlockType => typeof value === 'string' && Object.hasOwn(SCHEMAS, value);

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[], where: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new PageModelError(where, `unknown field "${key}"`);
}

function readValue(field: Field, value: unknown, where: string): unknown {
  if (field.kind === 'list') {
    if (value === undefined) return [];
    if (!Array.isArray(value)) throw new PageModelError(where, 'not a list');
    if (value.length > field.max) throw new PageModelError(where, `more than ${field.max} items`);
    return value.map((item, index) => readProps(field.item, item, `${where}[${index}]`));
  }
  if (value === undefined) return '';
  if (typeof value !== 'string') throw new PageModelError(where, 'not text');
  switch (field.kind) {
    case 'text':
      if (value.length > field.max) throw new PageModelError(where, `longer than ${field.max} characters`);
      return value;
    case 'rich':
      if (value.length > MAX_RICH) throw new PageModelError(where, `longer than ${MAX_RICH} characters`);
      return cleanRichText(value);
    case 'url':
      if (value.length > MAX_URL || (value.trim() !== '' && !safeUrl(value))) throw new PageModelError(where, 'not a web, mail or site address');
      return value;
    case 'image':
      if (value !== '' && !IMAGE_PATH.test(value)) throw new PageModelError(where, 'not an image of this site');
      return value;
  }
}

function readProps(schema: Record<string, Field>, value: unknown, where: string): Record<string, unknown> {
  if (value === undefined) value = {};
  if (!isRecord(value)) throw new PageModelError(where, 'not an object');
  onlyKeys(value, Object.keys(schema), where);
  const props: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(schema)) props[key] = readValue(field, value[key], `${where}.${key}`);
  return props;
}

function readBlock(value: unknown, where: string): Block {
  if (!isRecord(value)) throw new PageModelError(where, 'not a block');
  onlyKeys(value, ['type', 'props'], where);
  if (!isBlockType(value.type)) throw new PageModelError(where, `unknown block type ${JSON.stringify(value.type)}`);
  return { type: value.type, props: readProps(SCHEMAS[value.type], value.props, `${where}.props`) } as Block;
}

/**
 * Reads a page model from parsed JSON. It may come from a published site, so anything unexpected
 * is refused. With `repair`, a block that fails is dropped instead (for drafts kept in this browser).
 */
export function readPageModel(value: unknown, options: { repair?: boolean } = {}): PageModel {
  if (!isRecord(value)) throw new PageModelError('page', 'not an object');
  if (typeof value.v === 'number' && Number.isInteger(value.v) && value.v > PAGE_MODEL_VERSION) throw new PageModelError('page.v', `version ${value.v} was made with a newer builder than this one; reload the builder to get the latest`);
  if (value.v !== PAGE_MODEL_VERSION) throw new PageModelError('page.v', `version ${JSON.stringify(value.v)} is not supported`);
  onlyKeys(value, ['v', 'theme', 'pages'], 'page');
  if (typeof value.theme !== 'string' || !Object.hasOwn(THEMES, value.theme)) throw new PageModelError('page.theme', `unknown theme ${JSON.stringify(value.theme)}`);
  if (!isRecord(value.pages)) throw new PageModelError('page.pages', 'not an object');
  onlyKeys(value.pages, ['/'], 'page.pages');
  const home = value.pages['/'];
  if (!Array.isArray(home)) throw new PageModelError('page.pages["/"]', 'not a list of blocks');
  if (home.length > MAX_BLOCKS) throw new PageModelError('page.pages["/"]', `more than ${MAX_BLOCKS} blocks`);
  const blocks: Block[] = [];
  home.forEach((block, index) => {
    try {
      blocks.push(readBlock(block, `page.pages["/"][${index}]`));
    } catch (error) {
      if (!options.repair) throw error;
    }
  });
  return { v: PAGE_MODEL_VERSION, theme: value.theme as Theme, pages: { '/': blocks } };
}

/** Rich text cut so that its cleaned form, which closes what the cut left open, still fits. */
function fitRichText(value: string): string {
  let keep = Math.min(value.length, MAX_RICH);
  for (;;) {
    const clean = cleanRichText(value.slice(0, keep)).trim();
    if (clean.length <= MAX_RICH) return clean;
    keep = Math.min(keep - 1, Math.floor((keep * MAX_RICH) / clean.length));
  }
}

function tidyValue(field: Field, value: unknown): unknown {
  if (field.kind === 'list') return Array.isArray(value) ? value.slice(0, field.max).map((item) => tidyProps(field.item, item)) : [];
  if (typeof value !== 'string') return '';
  switch (field.kind) {
    case 'text':
      return value.trim().slice(0, field.max);
    case 'rich':
      return fitRichText(value);
    case 'url':
      return value.length <= MAX_URL && safeUrl(value) ? value.trim() : '';
    case 'image':
      return IMAGE_PATH.test(value) ? value : '';
  }
}

function tidyProps(schema: Record<string, Field>, value: unknown): Record<string, unknown> {
  const source = isRecord(value) ? value : {};
  const props: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(schema)) props[key] = tidyValue(field, source[key]);
  return props;
}

/**
 * The model as it is published: text trimmed, rich text cleaned, unsafe addresses left out, and
 * fields in a fixed order. Takes anything shaped like a model, such as the editor's state.
 */
export function tidyPageModel(model: { theme?: unknown; pages?: { '/'?: ReadonlyArray<{ type: unknown; props?: unknown }> } }): PageModel {
  const theme = typeof model.theme === 'string' && Object.hasOwn(THEMES, model.theme) ? (model.theme as Theme) : 'paper';
  const blocks = (model.pages?.['/'] ?? [])
    .filter((block): block is { type: BlockType; props?: unknown } => isBlockType(block.type))
    .slice(0, MAX_BLOCKS)
    .map((block) => ({ type: block.type, props: tidyProps(SCHEMAS[block.type], block.props) }) as Block);
  return { v: PAGE_MODEL_VERSION, theme, pages: { '/': blocks } };
}

function compactValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => compactProps(item as Record<string, unknown>));
  return value;
}

function compactProps(props: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(props)) {
    if (value === '' || (Array.isArray(value) && value.length === 0)) continue;
    out[key] = compactValue(value);
  }
  return out;
}

/** Canonical JSON for a model: the same page always gives the same bytes. Empty fields are left out. */
export function serializePageModel(model: PageModel): string {
  const tidy = tidyPageModel(model);
  return JSON.stringify({
    v: tidy.v,
    theme: tidy.theme,
    pages: {
      '/': tidy.pages['/'].map((block) => {
        const props = compactProps(block.props as Record<string, unknown>);
        return Object.keys(props).length > 0 ? { type: block.type, props } : { type: block.type };
      }),
    },
  });
}

export function emptyPageModel(theme: Theme = 'auto'): PageModel {
  return { v: PAGE_MODEL_VERSION, theme, pages: { '/': [] } };
}

export const isBlankModel = (model: PageModel): boolean => model.pages['/'].length === 0;

export function newBlock<T extends BlockType>(type: T, props: Partial<BlockProps<T>> = {}): Block<T> {
  return { type, props: { ...tidyProps(SCHEMAS[type], {}), ...props } } as unknown as Block<T>;
}

/** Image paths the model refers to, in page order. */
export function imagePaths(model: PageModel): string[] {
  const paths: string[] = [];
  for (const block of model.pages['/']) {
    const path = block.type === 'header' ? block.props.image : block.type === 'image' ? block.props.src : '';
    if (path && !paths.includes(path)) paths.push(path);
  }
  return paths;
}
