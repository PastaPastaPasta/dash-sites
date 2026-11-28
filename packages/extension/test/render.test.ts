import { describe, expect, it } from 'vitest';
import { Rewriter, type SiteFile } from '../src/render.js';

const file = (path: string, type: string, text = ''): SiteFile => ({ path, type, bytes: new TextEncoder().encode(text) });
const files = new Map([file('/a.png', 'image/png'), file('/b c.png', 'image/png'), file('/app.js', 'text/javascript', "import './lib/x y.js';"), file('/lib/x y.js', 'text/javascript')].map((f) => [f.path, f]));
const rewriter = (): Rewriter => new Rewriter({ origin: 'https://alice.dash', url: 'https://alice.dash/', html: '', files }, (_type, bytes) => `blob:${bytes.length}:${Math.random().toString(36).slice(2, 6)}`, true);

describe('rewriting a page', () => {
  it('rewrites srcset candidates, keeping URLs that hold commas', () => {
    const r = rewriter();
    const out = r.srcset('/a.png 1x, data:image/png;base64,AA,BB 2x,/b%20c.png 3x', 'https://alice.dash/');
    const parts = out.split(', ');
    expect(parts).toHaveLength(3);
    expect(parts[0]).toMatch(/^blob:\S+ 1x$/);
    expect(parts[1]).toBe('data:image/png;base64,AA,BB 2x');
    expect(parts[2]).toMatch(/^blob:\S+ 3x$/);
    expect(r.srcset('/a.png,', 'https://alice.dash/')).toMatch(/^blob:\S+$/);
  });

  it('maps module URLs as module specifiers are written: percent-encoded', () => {
    const r = rewriter();
    const map = JSON.parse(r.importMap()) as { imports: Record<string, string> };
    expect(Object.keys(map.imports).sort()).toEqual(['https://alice.dash/app.js', 'https://alice.dash/lib/x%20y.js']);
    expect(r.module("import './lib/x y.js'; import('./lib/x y.js');", 'https://alice.dash/app.js')).toBe(
      'import \'https://alice.dash/lib/x%20y.js\'; import("https://alice.dash/lib/x%20y.js");',
    );
  });
});
