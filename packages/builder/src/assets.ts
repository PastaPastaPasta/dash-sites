/**
 * The files the page editor adds to a site besides its pages: today, the images. This plain list
 * is the one place they are kept; the page, the cost meter and drafts all read it from here.
 */
export interface SiteAsset {
  /** Site path, e.g. `/images/3f9a0c1d2b4e.webp`. */
  path: string;
  /** Content type, e.g. `image/webp`. */
  type: string;
  bytes: Uint8Array;
}

let assets: readonly SiteAsset[] = [];
const listeners = new Set<() => void>();

const notify = (): void => {
  for (const listener of listeners) listener();
};

export function siteAssets(): readonly SiteAsset[] {
  return assets;
}

export function setSiteAssets(next: readonly SiteAsset[]): void {
  assets = [...next];
  notify();
}

/** Adds an asset, or replaces the one at the same path. */
export function putSiteAsset(asset: SiteAsset): void {
  assets = [...assets.filter((known) => known.path !== asset.path), asset];
  notify();
}

export function findSiteAsset(path: string): SiteAsset | undefined {
  return assets.find((asset) => asset.path === path);
}

export function onSiteAssetsChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
