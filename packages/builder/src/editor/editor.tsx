import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createUsePuck, Puck, useGetPuck, type Config, type Data, type Fields } from '@puckeditor/core';
import puckCss from '@puckeditor/core/no-external.css';
import { formatDash } from '@dash-sites/core';
import { THEMES, type Theme } from '../template.js';
import { BLOCKS } from '../page/blocks.js';
import { BLOCK_TYPES, newBlock, tidyPageModel, type Block, type BlockType, type PageModel } from '../page/model.js';
import { pageStylesheet, renderSite, viewBlock } from '../page/render.js';
import { costSplit } from '../page/cost.js';
import { siteAssets } from '../assets.js';
import { toReact } from './react-view.js';
import { ImageField, imageUrl, useAssets } from './image-field.js';
import { EDITOR_CSS, scopeCss } from './style.js';

export interface EditorOptions {
  model: PageModel;
  siteName(): string;
  onChange(model: PageModel): void;
  onClose(): void;
}

const CANVAS = 'dsp';
const ZONE = 'root:default-zone';
const ThemeContext = createContext<Theme>('paper');
const usePuck = createUsePuck();

const text = (label: string, inline = true) => ({ type: 'text', label, contentEditable: inline }) as const;
const area = (label: string, inline = true) => ({ type: 'textarea', label, contentEditable: inline }) as const;
const image = (label: string, kind: 'picture' | 'image') => ({
  type: 'custom',
  label,
  render: ({ value, onChange }: { value: string; onChange: (value: string) => void }) => <ImageField value={value ?? ''} onChange={onChange} kind={kind} label={label} />,
}) as const;

const FIELDS: { [T in BlockType]: Fields } = {
  header: { name: text('Name'), tagline: area('Tagline'), image: image('Picture', 'picture') },
  text: {
    body: {
      type: 'richtext',
      label: 'Text',
      contentEditable: true,
      options: { heading: { levels: [2, 3] }, textAlign: false, codeBlock: false, code: false, horizontalRule: false },
    },
  },
  links: {
    items: {
      type: 'array',
      label: 'Links',
      max: 40,
      arrayFields: { label: text('Label', false), url: text('Address', false) },
      defaultItemProps: { label: 'A link', url: 'https://' },
      getItemSummary: (item: { label?: string }) => item.label || 'Link',
    },
  },
  image: { src: image('Image', 'image'), caption: text('Caption'), alt: text('Description for screen readers', false) },
  cards: {
    items: {
      type: 'array',
      label: 'Cards',
      max: 12,
      arrayFields: { title: text('Title', false), text: area('Text', false), url: text('Link (optional)', false) },
      defaultItemProps: { title: 'A card', text: 'A sentence or two about it.', url: '' },
      getItemSummary: (item: { title?: string }) => item.title || 'Card',
    },
  },
  button: { label: text('Label'), url: text('Address', false) },
  divider: {},
  footer: { text: text('Text') },
};

const DEFAULTS: { [T in BlockType]: Block<T>['props'] } = {
  header: newBlock('header', { name: 'Your name', tagline: 'One line about you or your project.' }).props,
  text: newBlock('text', { body: '<p>Say what this page is about. Select text to make it bold, add a link or a heading.</p>' }).props,
  links: newBlock('links', { items: [{ label: 'Write to me', url: 'mailto:you@example.com' }] }).props,
  image: newBlock('image').props,
  cards: newBlock('cards', { items: [1, 2, 3].map((n) => ({ title: `Card ${n}`, text: 'A sentence or two about it.', url: '' })) }).props,
  button: newBlock('button', { label: 'Get in touch', url: 'mailto:you@example.com' }).props,
  divider: {},
  footer: newBlock('footer', { text: 'Published on Dash Platform.' }).props,
};

/** What a new, empty page starts as. */
export function starterPage(theme: Theme): PageModel {
  return { v: 1, theme, pages: { '/': (['header', 'text', 'links', 'footer'] as const).map((type) => ({ type, props: structuredClone(DEFAULTS[type]) }) as Block) } };
}

function BlockView({ type, props }: { type: BlockType; props: Record<string, unknown> }) {
  useAssets();
  return <>{toReact(viewBlock({ type, props } as Block, { src: imageUrl }))}</>;
}

function Canvas({ children }: { children?: ReactNode }) {
  const theme = useContext(ThemeContext);
  const css = useMemo(() => scopeCss(pageStylesheet(theme, BLOCK_TYPES), `.${CANVAS}`), [theme]);
  return (
    <div className={CANVAS}>
      <style>{css}</style>
      <main>{children}</main>
    </div>
  );
}

const config: Config = {
  categories: {
    page: { title: 'Blocks', components: ['header', 'text', 'links', 'image', 'cards', 'button', 'divider', 'footer'] },
  },
  components: Object.fromEntries(
    BLOCK_TYPES.map((type) => [
      type,
      {
        label: BLOCKS[type].label,
        fields: FIELDS[type],
        defaultProps: DEFAULTS[type],
        render: (props: Record<string, unknown>) => <BlockView type={type} props={props} />,
      },
    ]),
  ),
  root: { fields: {}, render: Canvas },
};

const toPuck = (model: PageModel): Data => ({
  root: { props: {} },
  content: model.pages['/'].map((block, index) => ({ type: block.type, props: { id: `${block.type}-${index}`, ...structuredClone(block.props) } })),
});

const fromPuck = (data: Data, theme: Theme): PageModel => tidyPageModel({ theme, pages: { '/': (data.content ?? []).map((item) => ({ type: item.type, props: item.props })) } });

function Meter({ model, siteName }: { model: PageModel; siteName: string }) {
  useAssets();
  const split = costSplit(renderSite(model, siteName, siteAssets()));
  if (!split) return <span className="ed-cost">Empty page</span>;
  return (
    <span className="ed-cost" aria-live="polite" title="Upper estimate for publishing this page from scratch">
      <b>{formatDash(split.total)}</b>
      <span className="ed-split">
        text {formatDash(split.text)}, {split.imageCount === 0 ? 'no images' : `${split.imageCount === 1 ? 'one image' : `${split.imageCount} images`} ${formatDash(split.images)}`}
      </span>
    </span>
  );
}

/** Adds a block after the selected one, or before the footer: a way to add blocks without dragging. */
function AddBlock() {
  const getPuck = useGetPuck();
  const add = (type: string): void => {
    const { appState, dispatch, selectedItem, getSelectorForId } = getPuck();
    const content = appState.data.content ?? [];
    const selected = selectedItem ? getSelectorForId(selectedItem.props.id as string) : undefined;
    const footer = content.findLastIndex((item) => item.type === 'footer');
    const index = selected?.zone === ZONE ? selected.index + 1 : footer >= 0 && type !== 'footer' ? footer : content.length;
    dispatch({ type: 'insert', componentType: type, destinationIndex: index, destinationZone: ZONE });
    dispatch({ type: 'setUi', ui: { itemSelector: { index, zone: ZONE } } });
  };
  return (
    <select
      className="ed-add"
      aria-label="Add a block"
      value=""
      onChange={(event) => {
        if (event.target.value) add(event.target.value);
        event.target.value = '';
      }}
    >
      <option value="">Add a block…</option>
      {BLOCK_TYPES.map((type) => (
        <option key={type} value={type}>
          {BLOCKS[type].label}
        </option>
      ))}
    </select>
  );
}

function Bar({ theme, chooseTheme, model, siteName, done }: { theme: Theme; chooseTheme: (theme: Theme) => void; model: PageModel; siteName: string; done: () => void }) {
  const history = usePuck((state) => state.history);
  return (
    <div className="ed-bar">
      <div className="ed-group">
        <b className="ed-title">Your page</b>
        <button type="button" className="ed-icon" onClick={history.back} disabled={!history.hasPast} aria-label="Undo" title="Undo">
          ↶
        </button>
        <button type="button" className="ed-icon" onClick={history.forward} disabled={!history.hasFuture} aria-label="Redo" title="Redo">
          ↷
        </button>
        <AddBlock />
      </div>
      <div className="ed-group">
        <div className="chips ed-themes" role="radiogroup" aria-label="Look">
          {(Object.keys(THEMES) as Theme[]).map((name) => (
            <button key={name} type="button" role="radio" aria-checked={theme === name} onClick={() => chooseTheme(name)}>
              {THEMES[name].label}
            </button>
          ))}
        </div>
        <Meter model={model} siteName={siteName} />
        <button type="button" className="ed-done" onClick={done}>
          Done
        </button>
      </div>
    </div>
  );
}

function Editor({ options, close }: { options: EditorOptions; close: () => void }) {
  const [theme, setTheme] = useState<Theme>(options.model.theme);
  const [model, setModel] = useState(options.model);
  const initial = useMemo(() => toPuck(options.model), [options.model]);
  const latest = useRef<Data>(initial);
  const themeNow = useRef(theme);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const report = useCallback(
    (next: PageModel, now = false) => {
      setModel(next);
      clearTimeout(timer.current);
      if (now) options.onChange(next);
      else timer.current = setTimeout(() => options.onChange(next), 250);
    },
    [options],
  );

  const done = (): void => {
    clearTimeout(timer.current);
    options.onChange(fromPuck(latest.current, themeNow.current));
    close();
  };

  const chooseTheme = (next: Theme): void => {
    themeNow.current = next;
    setTheme(next);
    report(fromPuck(latest.current, next), true);
  };

  return (
    <ThemeContext.Provider value={theme}>
      <Puck
        config={config}
        data={initial}
        iframe={{ enabled: false }}
        height="100%"
        onChange={(data) => {
          latest.current = data;
          report(fromPuck(data, themeNow.current));
        }}
        overrides={{
          header: () => <Bar theme={theme} chooseTheme={chooseTheme} model={model} siteName={options.siteName()} done={done} />,
        }}
      />
    </ThemeContext.Provider>
  );
}

let root: Root | undefined;
let host: HTMLElement | undefined;

/** Opens the editor over the builder. Changes reach `onChange` as they happen. */
export function openEditor(options: EditorOptions): void {
  if (!document.getElementById('editor-style')) {
    const style = document.createElement('style');
    style.id = 'editor-style';
    style.textContent = puckCss + EDITOR_CSS;
    document.head.append(style);
  }
  root?.unmount();
  host?.remove();
  const element = document.createElement('div');
  element.className = 'ed';
  element.setAttribute('role', 'dialog');
  element.setAttribute('aria-modal', 'true');
  element.setAttribute('aria-label', 'Page editor');
  document.body.append(element);
  document.documentElement.classList.add('editing');
  host = element;
  root = createRoot(element);
  const close = (): void => {
    root?.unmount();
    root = undefined;
    element.remove();
    host = undefined;
    document.documentElement.classList.remove('editing');
    options.onClose();
  };
  root.render(<Editor options={options} close={close} />);
}

