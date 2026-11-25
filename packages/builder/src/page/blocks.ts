import { safeUrl } from '../template.js';
import { cleanRichText, h, type Child, type Element } from './markup.js';
import type { BlockProps, BlockType } from './model.js';

export interface ViewContext {
  /** The address an image of the site is shown from. */
  src(path: string): string | undefined;
}

export interface BlockDefinition<T extends BlockType> {
  label: string;
  /** Rules this block needs, written for the published page. */
  css: string;
  view(props: BlockProps<T>, context: ViewContext): Element | null;
}

/**
 * In the editor, a text field edited in place arrives as an opaque node instead of a string; views
 * only test it with `present` and pass it on, so the same view serves the editor and the page.
 */
export const present = (value: unknown): boolean => typeof value !== 'string' || value.trim() !== '';
const rich = (value: string): Child => (typeof value === 'string' ? { html: cleanRichText(value) } : value);
const href = (url: string): string | undefined => (typeof url === 'string' ? safeUrl(url) : undefined);

export const BASE_CSS = '*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font-size:18px;line-height:1.6}main{max-width:38rem;margin:0 auto;padding:12vh 20px 80px;container-type:inline-size;overflow-wrap:anywhere}a{color:var(--accent)}';

export const BLOCKS: { [T in BlockType]: BlockDefinition<T> } = {
  header: {
    label: 'Profile header',
    css: '.me{width:96px;height:96px;border-radius:50%;object-fit:cover;display:block;margin:0 0 28px}h1{font-size:clamp(2.2rem,9cqi,3.4rem);line-height:1.05;margin:0 0 .4em}.tagline{font-size:1.2rem;color:var(--muted);margin:0 0 2em}',
    view: ({ image, name, tagline }, context) =>
      h(
        'header',
        null,
        image && context.src(image) ? h('img', { class: 'me', src: context.src(image), alt: '' }) : null,
        h('h1', null, name),
        present(tagline) ? h('p', { class: 'tagline' }, tagline) : null,
      ),
  },
  text: {
    label: 'Text',
    css: 'h2{font-size:1.4rem;margin:2em 0 .5em}h3{font-size:1.15rem;margin:1.6em 0 .4em}blockquote{margin:1em 0;padding-left:1em;border-left:3px solid var(--line);color:var(--muted)}',
    view: ({ body }) => h('div', { class: 'tx' }, rich(body)),
  },
  links: {
    label: 'Link list',
    css: '.links{list-style:none;padding:0;margin:2.5em 0 0;border-top:1px solid var(--line)}.links li{border-bottom:1px solid var(--line)}.links a{display:block;padding:14px 0;text-decoration:none}',
    view: ({ items }) => {
      const shown = items.filter((item) => present(item.label) || present(item.url));
      return shown.length === 0 ? null : h('ul', { class: 'links' }, ...shown.map((item) => h('li', null, h('a', { href: href(item.url) }, present(item.label) ? item.label : item.url))));
    },
  },
  image: {
    label: 'Image',
    css: 'figure{margin:2em 0}figure img{display:block;max-width:100%;height:auto;border-radius:4px}figcaption{font-size:.85rem;color:var(--muted);margin-top:.5em}',
    view: ({ src, alt, caption }, context) => {
      const url = src ? context.src(src) : undefined;
      if (!url) return null;
      return h('figure', null, h('img', { src: url, alt: typeof alt === 'string' ? alt : '' }), present(caption) ? h('figcaption', null, caption) : null);
    },
  },
  cards: {
    label: 'Columns of cards',
    css: '.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(10rem,1fr));gap:20px;margin:2em 0}.cards h3{font-size:1.05rem;margin:0 0 6px}.cards p{margin:0;font-size:.95rem;color:var(--muted)}',
    view: ({ items }) => {
      const shown = items.filter((item) => present(item.title) || present(item.text));
      if (shown.length === 0) return null;
      return h(
        'div',
        { class: 'cards' },
        ...shown.map((item) => {
          const link = href(item.url);
          return h('div', null, h('h3', null, link ? h('a', { href: link }, item.title) : item.title), present(item.text) ? h('p', null, item.text) : null);
        }),
      );
    },
  },
  button: {
    label: 'Button',
    css: '.btn{display:inline-block;margin:1.2em 0;padding:.6em 1.3em;border-radius:6px;background:var(--accent);color:var(--bg);font-weight:600;text-decoration:none}',
    view: ({ label, url }) => h('p', null, h('a', { class: 'btn', href: href(url) }, label)),
  },
  divider: {
    label: 'Divider',
    css: 'hr{border:0;border-top:1px solid var(--line);margin:2.5em 0}',
    view: () => h('hr', null),
  },
  footer: {
    label: 'Footer',
    css: 'footer{margin-top:4em;font-size:.8rem;color:var(--muted)}',
    view: ({ text }) => h('footer', null, text),
  },
};
