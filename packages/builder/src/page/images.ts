import { sha256Hex } from '@dash-sites/core';
import type { SiteAsset } from '../assets.js';

export interface ImageVariant extends SiteAsset {
  width: number;
  height: number;
}

/** Longest side, in pixels, of the sizes offered: a profile picture shows at 96 px, an image at up to 600. */
export const PICTURE_SIDES = [96, 192, 384];
export const IMAGE_SIDES = [480, 800, 1200, 1600];
export const DEFAULT_SIDE = { picture: 192, image: 800 };
export const ACCEPTED_IMAGES = 'image/png,image/jpeg,image/webp,image/gif';

const variants = new Map<string, ImageVariant[]>();

/** The other sizes made for an image, so the owner can switch between them. */
export const variantsOf = (path: string): ImageVariant[] | undefined => variants.get(path);

async function encode(bitmap: ImageBitmap, side: number): Promise<ImageVariant> {
  const scale = Math.min(1, side / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('This browser cannot resize images.');
  context.imageSmoothingQuality = 'high';
  context.drawImage(bitmap, 0, 0, width, height);
  const blob = (await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/webp', 0.8))) ?? undefined;
  const webp = blob?.type === 'image/webp' ? blob : undefined;
  const result = webp ?? (await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.82)));
  if (!result) throw new Error('This browser could not encode the image.');
  const bytes = new Uint8Array(await result.arrayBuffer());
  const ext = webp ? 'webp' : 'jpg';
  const type = webp ? 'image/webp' : 'image/jpeg';
  const path = `/images/${sha256Hex(bytes).slice(0, 16)}.${ext}`;
  return { path, type, bytes, width, height };
}

/**
 * Re-encodes an image at each of `sides` that is not larger than the image itself, as WebP where
 * the browser can (JPEG otherwise). Returns the variants from small to large; each one knows the others.
 * With `current`, the image is one already in the site: it is kept as the largest choice, and only
 * smaller sizes are made.
 */
export async function makeVariants(source: Blob, sides: number[], current?: SiteAsset): Promise<ImageVariant[]> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(source);
  } catch {
    throw new Error('That file is not an image this browser can read. Use a PNG, JPEG, WebP or GIF.');
  }
  try {
    const longest = Math.max(bitmap.width, bitmap.height);
    const wanted = [...new Set(sides.map((side) => Math.min(side, longest)))].filter((side) => !current || side < longest).sort((a, b) => a - b);
    const made: ImageVariant[] = [];
    for (const side of wanted) made.push(await encode(bitmap, side));
    if (current) made.push({ ...current, width: bitmap.width, height: bitmap.height });
    const unique = made.filter((variant, index) => made.findIndex((other) => other.path === variant.path) === index);
    for (const variant of unique) variants.set(variant.path, unique);
    return unique;
  } finally {
    bitmap.close();
  }
}

export const pickDefault = (made: ImageVariant[], side: number): ImageVariant => made.filter((variant) => Math.max(variant.width, variant.height) <= side).at(-1) ?? (made[0] as ImageVariant);
