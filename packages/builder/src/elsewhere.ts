import {
  fetchPinned,
  httpsFetcher,
  IPFS_GLOBAL,
  IPFS_MODULE,
  parsePlace,
  sha256Hex,
  toHex,
  tryPlace,
  utf8,
  type PlaceFetcher,
  type PlaceFetchers,
} from '@dash-sites/core';

/** A file of the site that its owner wants kept outside Platform. */
export interface OutsideFile {
  path: string;
  type: string;
  bytes: Uint8Array;
}

/** An S3-style bucket: Cloudflare R2, or any other store that speaks the same protocol. */
export interface Bucket {
  /** The API address, without the bucket: `https://<account>.r2.cloudflarestorage.com`. */
  endpoint: string;
  bucket: string;
  /** `auto` on R2. */
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Where the bucket's files are public: `https://media.example.com`. */
  publicUrl: string;
  /** Put before every file's name in the bucket, such as `site/`. */
  prefix?: string;
}

export const BUCKET_CORS = (origin: string): string =>
  JSON.stringify([{ AllowedOrigins: ['*'], AllowedMethods: ['GET', 'HEAD'], AllowedHeaders: ['*'] }, { AllowedOrigins: [origin], AllowedMethods: ['PUT'], AllowedHeaders: ['*'] }], null, 2);

const encodeSegment = (segment: string): string => encodeURIComponent(segment).replace(/[!*'()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const encodeKey = (key: string): string => key.split('/').map(encodeSegment).join('/');

async function hmac(key: Uint8Array, message: string): Promise<Uint8Array> {
  const imported = await crypto.subtle.importKey('raw', key as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', imported, utf8.encode(message) as BufferSource));
}

export interface SignedRequest {
  method: string;
  url: URL;
  /** Headers to sign besides `host`, lower case. */
  headers: Record<string, string>;
  payloadSha256: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  now: Date;
}

/** The `Authorization` header of AWS Signature Version 4 for an S3 request. */
export async function signS3(request: SignedRequest): Promise<string> {
  const stamp = request.now.toISOString().replace(/[-:]|\.\d{3}/g, '');
  const day = stamp.slice(0, 8);
  const headers: Record<string, string> = { ...request.headers, host: request.url.host };
  const names = Object.keys(headers).sort();
  const query = [...request.url.searchParams]
    .map(([name, value]) => `${encodeSegment(name)}=${encodeSegment(value)}`)
    .sort()
    .join('&');
  const canonical = [request.method, request.url.pathname, query, ...names.map((name) => `${name}:${(headers[name] as string).trim()}`), '', names.join(';'), request.payloadSha256].join('\n');
  const scope = `${day}/${request.region}/s3/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', stamp, scope, sha256Hex(utf8.encode(canonical))].join('\n');
  let key = utf8.encode(`AWS4${request.secretAccessKey}`);
  for (const part of [day, request.region, 's3', 'aws4_request']) key = await hmac(key, part);
  return `AWS4-HMAC-SHA256 Credential=${request.accessKeyId}/${scope},SignedHeaders=${names.join(';')},Signature=${toHex(await hmac(key, toSign))}`;
}

function httpsBase(value: string, what: string): string {
  const place = parsePlace(value.trim().replace(/\/+$/, '') + '/');
  if (place?.kind !== 'https' || new URL(place.uri).search !== '') throw new Error(`${what} must be an https:// address`);
  return place.uri;
}

/** The name a file gets in a bucket: its hash, so that a file is never replaced by a different one. */
export function bucketKey(prefix: string | undefined, file: OutsideFile): string {
  const extension = /\.[A-Za-z0-9]{1,8}$/.exec(file.path)?.[0] ?? '';
  const clean = (prefix ?? '').trim().replace(/^\/+/, '');
  if (!/^[A-Za-z0-9._/-]*$/.test(clean) || clean.split('/').includes('..')) throw new Error('the folder may hold letters, digits, dots, dashes and slashes only');
  return `${clean}${sha256Hex(file.bytes)}${extension.toLowerCase()}`;
}

/** Uploads a file to a bucket and returns the public address it will have. */
export async function uploadToBucket(bucket: Bucket, file: OutsideFile, options: { fetch?: typeof fetch; now?: () => Date } = {}): Promise<string> {
  const key = bucketKey(bucket.prefix, file);
  const name = bucket.bucket.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9.-]{1,62}$/.test(name)) throw new Error('that is not a bucket name');
  const url = new URL(`${encodeSegment(name)}/${encodeKey(key)}`, httpsBase(bucket.endpoint, 'the bucket API address'));
  const publicUrl = `${httpsBase(bucket.publicUrl, 'the public address')}${encodeKey(key)}`;
  const now = (options.now ?? (() => new Date()))();
  const payloadSha256 = sha256Hex(file.bytes);
  const signed = { 'x-amz-content-sha256': payloadSha256, 'x-amz-date': now.toISOString().replace(/[-:]|\.\d{3}/g, '') };
  const authorization = await signS3({ method: 'PUT', url, headers: signed, payloadSha256, region: bucket.region.trim() || 'auto', accessKeyId: bucket.accessKeyId.trim(), secretAccessKey: bucket.secretAccessKey.trim(), now });
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(url, { method: 'PUT', headers: { ...signed, authorization, 'content-type': file.type }, body: file.bytes as BodyInit, credentials: 'omit', referrerPolicy: 'no-referrer' });
  } catch {
    throw new Error('the bucket could not be reached. Check the API address, and that the bucket allows uploads from this page (its CORS rules)');
  }
  if (!response.ok) throw new Error(`the bucket refused the upload (${response.status}${response.status === 403 ? ': check the keys and that they may write to this bucket' : ''})`);
  return publicUrl;
}

export const PINATA_UPLOAD = 'https://uploads.pinata.cloud/v3/files';

/** Pins a file with Pinata and returns its IPFS place. */
export async function uploadToPinata(jwt: string, file: OutsideFile, options: { fetch?: typeof fetch } = {}): Promise<string> {
  const form = new FormData();
  form.append('file', new Blob([file.bytes as BlobPart], { type: file.type }), file.path.split('/').pop() ?? 'file');
  form.append('network', 'public');
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(PINATA_UPLOAD, { method: 'POST', headers: { authorization: `Bearer ${jwt.trim()}` }, body: form, credentials: 'omit', referrerPolicy: 'no-referrer' });
  } catch {
    throw new Error('Pinata could not be reached');
  }
  if (!response.ok) throw new Error(`Pinata refused the upload (${response.status}${response.status === 401 || response.status === 403 ? ': check the key and that it may write files' : ''})`);
  const cid = ((await response.json().catch(() => undefined)) as { data?: { cid?: unknown } } | undefined)?.data?.cid;
  const place = typeof cid === 'string' ? parsePlace(`ipfs://${cid}`) : undefined;
  if (!place) throw new Error('Pinata answered without a CID');
  return place.uri;
}

const IPFS_WORKER = `
const ready = self.${IPFS_GLOBAL}.createVerifiedFetch({ gateways: [] });
self.onmessage = async ({ data: { id, uri, size, waitMs } }) => {
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), waitMs);
  try {
    const response = await (await ready)(uri, { signal: stop.signal });
    if (!response.ok) throw new Error('it answered ' + response.status);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > size) throw new Error('it serves more bytes than the file that was published');
    self.postMessage({ id, bytes }, [bytes.buffer]);
  } catch (error) {
    self.postMessage({ id, problem: stop.signal.aborted ? 'no peer that holds it answered' : String(error && error.message || error) });
  } finally {
    clearTimeout(timer);
  }
};
`;

/**
 * Fetches IPFS places in a worker of its own. The IPFS client is downloaded from npm and started
 * only if it matches the pinned hash; in a worker it cannot reach the page, which holds the key.
 */
export function ipfsInWorker(options: { waitMs?: number; fetch?: typeof fetch } = {}): PlaceFetcher {
  let worker: Promise<Worker> | undefined;
  let next = 0;
  const waiting = new Map<number, { resolve: (bytes: Uint8Array) => void; reject: (error: Error) => void }>();
  const start = async (): Promise<Worker> => {
    const source = await fetchPinned(IPFS_MODULE, options);
    const started = new Worker(URL.createObjectURL(new Blob([source as BlobPart, IPFS_WORKER], { type: 'text/javascript' })));
    started.onmessage = ({ data }: MessageEvent<{ id: number; bytes?: Uint8Array; problem?: string }>) => {
      const request = waiting.get(data.id);
      waiting.delete(data.id);
      if (data.bytes) request?.resolve(data.bytes);
      else request?.reject(new Error(data.problem ?? 'the IPFS client failed'));
    };
    started.onerror = () => {
      for (const request of waiting.values()) request.reject(new Error('the IPFS client could not start'));
      waiting.clear();
      worker = undefined;
    };
    return started;
  };
  return async (uri, size) => {
    worker ??= start().catch((error: unknown) => {
      worker = undefined;
      throw error;
    });
    const running = await worker;
    return new Promise((resolve, reject) => {
      const id = next++;
      waiting.set(id, { resolve, reject });
      running.postMessage({ id, uri, size, waitMs: options.waitMs ?? 60_000 });
    });
  };
}

/** How the builder fetches places: as a visitor's browser will, so a host that browsers cannot read fails here. */
export const browserFetchers = (): PlaceFetchers => ({ https: httpsFetcher(), ipfs: ipfsInWorker() });

export interface PlaceResult {
  place: string;
  /** Absent when the place serves the file. */
  problem?: string;
}

/** Asks each place for the file and says which ones serve it. */
export async function confirmPlaces(file: OutsideFile, places: string[], fetchers: PlaceFetchers): Promise<PlaceResult[]> {
  const expected = { size: file.bytes.length, sha256: sha256Hex(file.bytes) };
  return Promise.all(
    places.map(async (place) => {
      const result = await tryPlace(place, expected, fetchers);
      if ('bytes' in result) return { place };
      const https = parsePlace(place)?.kind === 'https' && result.problem.startsWith('it could not be reached');
      return { place, problem: https ? 'it could not be reached, or it does not let other sites read it (it must send Access-Control-Allow-Origin: *)' : result.problem };
    }),
  );
}

/** Splits what an owner typed or pasted into places, and says which entries are not one. */
export function readPlaces(input: string): { places: string[]; unknown: string[] } {
  const places: string[] = [];
  const unknown: string[] = [];
  for (const entry of input.split(/[\s,]+/).filter(Boolean)) {
    const place = parsePlace(/^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{58,})$/.test(entry) ? `ipfs://${entry}` : entry);
    if (!place) unknown.push(entry);
    else if (!places.includes(place.uri)) places.push(place.uri);
  }
  return { places, unknown };
}
