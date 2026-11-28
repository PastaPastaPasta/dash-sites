import { buildSite, estimateCost, estimateCredits, formatDash, MAX_SITE_BYTES, PackError, type CostEstimate, type FeeModel, type SiteBundle, type SiteFile } from '@dash-sites/core';

let fees: FeeModel | undefined;
let failed = false;
const listeners = new Set<() => void>();
const changed = (): void => {
  for (const listener of listeners) listener();
};

/** Platform's fees, once the SDK has computed them; every price here is unknown until then. */
export function setFees(model: FeeModel): void {
  fees = model;
  changed();
}

export function failFees(): void {
  failed = true;
  changed();
}

export function onFeesChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export const currentFees = (): FeeModel | undefined => fees;

/** What to show in place of a price while the fees are unknown. */
export const pendingCostText = (): string => (failed ? 'This browser could not work out what publishing costs.' : 'Working out what publishing costs…');

/** The upper estimate for publishing `bundle` when nothing of it is stored yet. */
export function siteCost(bundle: SiteBundle): CostEstimate | undefined {
  if (!fees) return undefined;
  try {
    return estimateCost(bundle, fees);
  } catch {
    failed = true;
    return undefined;
  }
}

const known = new WeakMap<Uint8Array, bigint>();

/** What storing one file costs on its own: its chunks, without the site record or the manifest. */
export function fileCredits(file: SiteFile): bigint | undefined {
  if (file.src) return 0n;
  if (!fees) return undefined;
  const cached = known.get(file.bytes);
  if (cached !== undefined) return cached;
  const bundle = buildSite([{ path: '/f', bytes: file.bytes, type: file.type ?? 'application/octet-stream' }]);
  const own = [...bundle.chunks.keys()].filter((hash) => !bundle.manifestChunks.includes(hash));
  const credits = estimateCost(bundle, fees, own).chunks;
  known.set(file.bytes, credits);
  return credits;
}

/** What storing one file on Platform costs, as text; nothing when the file is too large for Platform. */
export function platformPrice(file: SiteFile): string | undefined {
  if (file.bytes.length > MAX_SITE_BYTES) return undefined;
  try {
    const credits = fileCredits(file);
    return credits === undefined ? undefined : formatDash(credits);
  } catch (error) {
    if (error instanceof PackError) return undefined;
    throw error;
  }
}

export interface CostSplit {
  total: bigint;
  /** The pages, the page model, the manifest and the site record. */
  text: bigint;
  images: bigint;
  imageCount: number;
  imageBytes: number;
  /** Images kept outside Platform, which cost nothing to store on it. */
  outsideCount: number;
}

const isImage = (file: SiteFile): boolean => (file.type ?? '').startsWith('image/');

/** The upper estimate for publishing `files` from scratch, split into images and everything else. */
export function costSplit(files: SiteFile[]): CostSplit | undefined {
  if (files.length === 0 || !fees) return undefined;
  let total: bigint;
  try {
    total = estimateCredits(buildSite(files), fees);
  } catch (error) {
    if (error instanceof PackError) return undefined;
    throw error;
  }
  const all = files.filter(isImage);
  const pictures = all.filter((file) => !file.src);
  const images = pictures.reduce((sum, file) => sum + (fileCredits(file) ?? 0n), 0n);
  return {
    total,
    images,
    text: total > images ? total - images : 0n,
    imageCount: pictures.length,
    imageBytes: pictures.reduce((sum, file) => sum + file.bytes.length, 0),
    outsideCount: all.length - pictures.length,
  };
}

export const sizeText = (n: number): string => (n < 10_240 ? `${(n / 1024).toFixed(1)} KB` : n < 1e6 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`);
