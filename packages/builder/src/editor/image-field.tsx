import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { formatDash } from '@dash-sites/core';
import { findSiteAsset, onSiteAssetsChange, putSiteAsset, siteAssets } from '../assets.js';
import { dataUrl } from '../files.js';
import { sizeText } from '../page/cost.js';
import { ACCEPTED_IMAGES, DEFAULT_SIDE, IMAGE_SIDES, makeVariants, PICTURE_SIDES, pickDefault, variantsOf, type ImageVariant } from '../page/images.js';

const urls = new WeakMap<Uint8Array, string>();

/** A data address for an image of the site: the builder's policy allows no other kind in the page. */
export function imageUrl(path: string): string | undefined {
  const asset = findSiteAsset(path);
  if (!asset) return undefined;
  let url = urls.get(asset.bytes);
  if (!url) {
    url = dataUrl(asset.bytes, asset.type);
    urls.set(asset.bytes, url);
  }
  return url;
}

export const useAssets = () => useSyncExternalStore(onSiteAssetsChange, siteAssets);

const describe = (variant: { width: number; height: number; bytes: Uint8Array; credits: bigint }): string => `${variant.width} × ${variant.height}, ${sizeText(variant.bytes.length)}, ${formatDash(variant.credits)}`;

export function ImageField({ value, onChange, kind, label }: { value: string; onChange: (path: string) => void; kind: 'picture' | 'image'; label: string }) {
  useAssets();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [options, setOptions] = useState<ImageVariant[] | undefined>(() => (value ? variantsOf(value) : undefined));
  useEffect(() => setOptions(value ? variantsOf(value) : undefined), [value]);
  const asset = value ? findSiteAsset(value) : undefined;
  const current = useMemo(() => options?.find((variant) => variant.path === value), [options, value]);

  const add = async (file: File | undefined): Promise<void> => {
    if (!file) return;
    setBusy(true);
    setError('');
    try {
      const made = await makeVariants(file, kind === 'picture' ? PICTURE_SIDES : IMAGE_SIDES);
      const chosen = pickDefault(made, DEFAULT_SIDE[kind]);
      putSiteAsset(chosen);
      setOptions(made);
      onChange(chosen.path);
    } catch (caught) {
      setError(String((caught as Error)?.message ?? caught));
    } finally {
      setBusy(false);
    }
  };

  const shrink = async (): Promise<void> => {
    if (!asset) return;
    setBusy(true);
    try {
      setOptions(await makeVariants(new Blob([asset.bytes as BlobPart], { type: asset.type }), kind === 'picture' ? PICTURE_SIDES : IMAGE_SIDES, asset));
    } catch (caught) {
      setError(String((caught as Error)?.message ?? caught));
    } finally {
      setBusy(false);
    }
  };

  const pick = (path: string): void => {
    const variant = options?.find((option) => option.path === path);
    if (!variant) return;
    putSiteAsset(variant);
    onChange(variant.path);
  };

  return (
    <div className="ed-image">
      <span className="ed-label">{label}</span>
      {asset ? <img className={kind === 'picture' ? 'ed-thumb round' : 'ed-thumb'} src={imageUrl(asset.path)} alt="" /> : null}
      {value && !asset ? <p className="ed-note">This image was not kept with the draft. Choose it again.</p> : null}
      {asset && current ? (
        <label className="ed-size">
          <span>Size and price</span>
          <select value={value} onChange={(event) => pick(event.target.value)}>
            {options?.map((variant) => (
              <option key={variant.path} value={variant.path}>
                {describe(variant)}
              </option>
            ))}
          </select>
        </label>
      ) : asset ? (
        <p className="ed-note">
          {sizeText(asset.bytes.length)}.{' '}
          <button type="button" className="ed-link" onClick={() => void shrink()} disabled={busy}>
            Show smaller sizes
          </button>
        </p>
      ) : null}
      <div className="ed-row">
        <label className="ed-pick">
          {busy ? 'Resizing…' : asset ? 'Choose another' : 'Choose a picture'}
          <input type="file" accept={ACCEPTED_IMAGES} disabled={busy} onChange={(event) => void add(event.target.files?.[0]).finally(() => (event.target.value = ''))} />
        </label>
        {value ? (
          <button type="button" className="ed-link" onClick={() => onChange('')}>
            Remove
          </button>
        ) : null}
      </div>
      {error ? <p className="ed-error">{error}</p> : null}
      <p className="ed-note">Images are resized and stored as WebP in your site. They cost more than anything else on a page, so pick the smallest size that looks right.</p>
    </div>
  );
}
