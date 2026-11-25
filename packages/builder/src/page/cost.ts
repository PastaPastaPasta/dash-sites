import { buildSite, estimateCredits, PackError, type SiteFile } from '@dash-sites/core';

const known = new WeakMap<Uint8Array, bigint>();

/** What storing one file costs on its own: its chunks, without the site record or the manifest. */
export function fileCredits(file: SiteFile): bigint {
  if (file.src) return 0n;
  const cached = known.get(file.bytes);
  if (cached !== undefined) return cached;
  const bundle = buildSite([{ path: '/f', bytes: file.bytes, type: file.type ?? 'application/octet-stream' }]);
  const own = [...bundle.chunks.keys()].filter((hash) => !bundle.manifestChunks.includes(hash));
  const credits = estimateCredits(bundle, own) - estimateCredits(bundle, []);
  known.set(file.bytes, credits);
  return credits;
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
  if (files.length === 0) return undefined;
  let total: bigint;
  try {
    total = estimateCredits(buildSite(files));
  } catch (error) {
    if (error instanceof PackError) return undefined;
    throw error;
  }
  const all = files.filter(isImage);
  const pictures = all.filter((file) => !file.src);
  const images = pictures.reduce((sum, file) => sum + fileCredits(file), 0n);
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
