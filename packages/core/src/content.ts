import { isHash } from './bytes.js';
import { MAX_CONTENT_URI_LENGTH, MAX_MANIFEST_CHUNKS } from './limits.js';

export type ContentRef =
  | { scheme: 'dash-manifest'; chunks: string[] }
  | { scheme: 'ipfs'; cid: string };

const MANIFEST_PREFIX = 'dash-manifest:v1:';
const IPFS_PREFIX = 'ipfs://';
const CID = /^[a-zA-Z0-9]{46,128}$/;

export function formatContentUri(ref: ContentRef): string {
  const uri = ref.scheme === 'ipfs' ? `${IPFS_PREFIX}${ref.cid}` : `${MANIFEST_PREFIX}${ref.chunks.join(',')}`;
  if (parseContentUri(uri) === undefined) throw new Error('content reference cannot be encoded');
  return uri;
}

/** Returns undefined for a URI this version does not understand. */
export function parseContentUri(uri: string): ContentRef | undefined {
  if (uri.length === 0 || uri.length > MAX_CONTENT_URI_LENGTH) return undefined;
  if (uri.startsWith(MANIFEST_PREFIX)) {
    const chunks = uri.slice(MANIFEST_PREFIX.length).split(',');
    if (chunks.length === 0 || chunks.length > MAX_MANIFEST_CHUNKS) return undefined;
    if (!chunks.every(isHash)) return undefined;
    if (new Set(chunks).size !== chunks.length) return undefined;
    return { scheme: 'dash-manifest', chunks };
  }
  if (uri.startsWith(IPFS_PREFIX)) {
    const cid = uri.slice(IPFS_PREFIX.length);
    if (!CID.test(cid)) return undefined;
    return { scheme: 'ipfs', cid };
  }
  return undefined;
}
