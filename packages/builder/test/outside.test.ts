import { beforeEach, describe, expect, it } from 'vitest';
import { buildSite, utf8, type SiteFile } from '@dash-sites/core';
import { keepOutside, loadOutside, onOutsideChange, outsidePlaces, readOutside, rememberOutside, setOutsidePlaces } from '../src/outside.js';

const photo = new Uint8Array(30000).map((_, i) => (i * 11) % 249);
const files = (): SiteFile[] => [
  { path: '/index.html', bytes: utf8.encode('<img src="/photo.webp">') },
  { path: '/photo.webp', bytes: photo },
];
const HTTPS = 'https://media.example.com/photo.webp';
const IPFS = 'ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi';

function memory(): { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void; data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (key) => data.get(key) ?? null, setItem: (key, value) => void data.set(key, value), removeItem: (key) => void data.delete(key) };
}

describe('files kept outside Platform', () => {
  beforeEach(() => loadOutside(memory()));

  it('are marked by what they hold, so a changed file goes back on Platform', () => {
    const before = buildSite(files());
    setOutsidePlaces(photo, [HTTPS, IPFS, HTTPS]);
    expect(outsidePlaces(photo)).toEqual([HTTPS, IPFS]);
    const bundle = buildSite(keepOutside(files()));
    expect(bundle.manifest.v).toBe(2);
    expect(bundle.manifest.files['/photo.webp']).toMatchObject({ parts: [], src: [HTTPS, IPFS] });
    expect(bundle.stats.storedBytes).toBeLessThan(before.stats.storedBytes);

    const edited = files().map((file) => (file.path === '/photo.webp' ? { ...file, bytes: photo.slice(1) } : file));
    expect(buildSite(keepOutside(edited)).manifest.v).toBe(1);
    const moved = files().map((file) => (file.path === '/photo.webp' ? { ...file, path: '/img/hero.webp' } : file));
    expect(buildSite(keepOutside(moved)).manifest.files['/img/hero.webp']?.src).toEqual([HTTPS, IPFS]);
  });

  it('go back on Platform when their places are removed', () => {
    let changes = 0;
    const stop = onOutsideChange(() => (changes += 1));
    setOutsidePlaces(photo, [HTTPS]);
    setOutsidePlaces(photo, []);
    stop();
    setOutsidePlaces(photo, [HTTPS]);
    setOutsidePlaces(photo, []);
    expect(changes).toBe(2);
    expect(outsidePlaces(photo)).toEqual([]);
    expect(keepOutside(files())).toEqual(files());
  });

  it('are remembered in the browser, and a damaged record is ignored', () => {
    const storage = memory();
    loadOutside(storage);
    setOutsidePlaces(photo, [HTTPS]);
    loadOutside(storage);
    expect(outsidePlaces(photo)).toEqual([HTTPS]);
    expect([...storage.data.values()].join()).not.toMatch(/secret|key/i);

    for (const damaged of ['{', '[]', '"x"', JSON.stringify({ nothash: [HTTPS] }), JSON.stringify({ ['a'.repeat(64)]: ['javascript:alert(1)', 7] })]) {
      storage.data.set('dash-sites.outside', damaged);
      loadOutside(storage);
      expect(keepOutside(files())).toEqual(files());
    }
    expect(readOutside({ ['a'.repeat(64)]: [HTTPS, 'ar://x', HTTPS] })).toEqual(new Map([['a'.repeat(64), [HTTPS]]]));
    loadOutside(undefined);
    setOutsidePlaces(photo, [HTTPS]);
    expect(outsidePlaces(photo)).toEqual([HTTPS]);
  });

  it('take the places a published site already lists', () => {
    const { manifest } = buildSite([{ path: '/photo.webp', bytes: photo, src: [IPFS] }]);
    const entry = manifest.files['/photo.webp']!;
    rememberOutside(entry.sha256, entry.src!);
    expect(buildSite(keepOutside(files())).manifest.files['/photo.webp']?.src).toEqual([IPFS]);
  });

  it('add a published site’s places to the ones already known, and never replace them', () => {
    setOutsidePlaces(photo, [HTTPS]);
    const { manifest } = buildSite([{ path: '/photo.webp', bytes: photo, src: [IPFS, HTTPS] }]);
    rememberOutside(manifest.files['/photo.webp']!.sha256, manifest.files['/photo.webp']!.src!);
    expect(outsidePlaces(photo)).toEqual([HTTPS, IPFS]);
  });

  it('never hold more places for a file than a site may list', () => {
    const many = Array.from({ length: 12 }, (_, i) => `${HTTPS}?${i}`);
    setOutsidePlaces(photo, many);
    expect(outsidePlaces(photo)).toEqual(many.slice(0, 8));
    rememberOutside(buildSite(files()).manifest.files['/photo.webp']!.sha256, [IPFS]);
    expect(outsidePlaces(photo)).toEqual(many.slice(0, 8));
    expect(() => buildSite(keepOutside(files()))).not.toThrow();
    expect(readOutside({ ['a'.repeat(64)]: many }).get('a'.repeat(64))).toEqual(many.slice(0, 8));
  });
});
