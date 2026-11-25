/// <reference lib="webworker" />
import {
  fetchPinned,
  httpsFetcher,
  ipfsFetcher,
  IPFS_MODULE,
  matchesFile,
  readerConfig,
  startIpfs,
  toHex,
  type Network,
  type PlatformReader,
} from '@dash-sites/core';
import { hostedDenylist } from './hosted-denylist.js';
import { resetLocation, SiteHost, type Reply } from './host.js';
import { BrowserStore, SHELL_CACHE } from './store.js';
import type { Inflater } from './inflate.js';
import { fastNodes, unpinOnFailure } from './nodes.js';
import type { Verifier } from './verifier.js';

declare const self: ServiceWorkerGlobalScope & { dashSitesVerifier?: Verifier };
declare const __VERIFIER__: Pinned;
declare const __SDK__: Pinned;
declare const __NETWORK__: string;
declare const __CONTRACT_ID__: string;
declare const __BUILDER_URL__: string;
declare const __DENYLIST__: boolean;
declare const __BOOT_PAGE__: string;
declare const __IPFS_ROUTERS__: string[];

/** A file this worker was built with: where it is served, and the SHA-256 and size of its bytes. */
interface Pinned {
  url: string;
  sha256: string;
  size: number;
}

const matches = async (bytes: Uint8Array, file: Pinned): Promise<boolean> =>
  toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource))) === file.sha256;

const VERIFIER_URLS = [__VERIFIER__.url, __SDK__.url];

/**
 * The verifier is two files: its script, and the Dash SDK's WebAssembly served compressed with brotli.
 * The worker fetches both and keeps them in Cache Storage rather than importing them, because browsers
 * refuse to store a script this large for a private window. Site code can write to that cache, so
 * every read is checked against the hash this worker was built with, and nothing runs before that.
 */
async function loadVerifier(): Promise<{ verifier: Verifier; sdk: WebAssembly.Module }> {
  void pickNodes();
  const cache = await caches.open(SHELL_CACHE).catch(() => undefined);
  const keptSdk = kept(cache, __SDK__);
  // The SDK is most of the bytes, so its download starts while the script is still coming.
  const early = new AbortController();
  const sdkResponse = keptSdk.then((bytes) => (bytes ? undefined : fetch(__SDK__.url, { signal: early.signal }))).catch(() => undefined);
  let verifier: Verifier;
  try {
    const source = (await kept(cache, __VERIFIER__)) ?? (await downloadChecked(cache, __VERIFIER__, (body) => collect(body, __VERIFIER__.size)));
    (0, eval)(new TextDecoder().decode(source));
    verifier = self.dashSitesVerifier as Verifier;
  } catch (error) {
    early.abort();
    throw error;
  }
  const wasm = (await keptSdk) ?? (await downloadChecked(cache, __SDK__, (body) => inflate(body, verifier.inflater()), await sdkResponse));
  return { verifier, sdk: await WebAssembly.compile(wasm as BufferSource) };
}

/** A stored copy that matches; one that cannot be read or does not match is dropped. */
async function kept(cache: Cache | undefined, file: Pinned): Promise<Uint8Array | undefined> {
  const response = await cache?.match(file.url).catch(() => undefined);
  if (!response) return undefined;
  const bytes = await response.arrayBuffer().then(
    (buffer) => new Uint8Array(buffer),
    () => undefined,
  );
  if (bytes && (await matches(bytes, file))) return bytes;
  await cache?.delete(file.url).catch(() => undefined);
  return undefined;
}

/** Retried past the HTTP cache: one bad response cached as immutable would otherwise break every name. */
async function downloadChecked(
  cache: Cache | undefined,
  file: Pinned,
  decode: (body: ReadableStream<Uint8Array>) => Promise<Uint8Array>,
  first?: Response,
): Promise<Uint8Array> {
  const attempt = async (response: Response | Promise<Response>): Promise<Uint8Array | undefined> => {
    const { ok, status, body } = await response;
    if (!ok || !body) throw new Error(`the verifier could not be downloaded (${status})`);
    const bytes = await decode(body);
    return (await matches(bytes, file)) ? bytes : undefined;
  };
  const bytes = (await attempt(first ?? fetch(file.url)).catch(() => undefined)) ?? (await attempt(fetch(file.url, { cache: 'reload' })));
  if (!bytes) throw new Error('the verifier does not match the hash this worker was built with');
  await cache?.put(file.url, new Response(bytes as BodyInit)).catch(() => undefined);
  return bytes;
}

/**
 * Reads a download into a buffer of the size the worker was built with. `transform` gets each chunk
 * and the room left, and `tell` hears how full the buffer is.
 */
async function collect(
  body: ReadableStream<Uint8Array>,
  size: number,
  transform: (chunk: Uint8Array, room: number) => Iterable<Uint8Array> = (chunk) => [chunk],
  tell?: (share: number) => void,
): Promise<Uint8Array> {
  const bytes = new Uint8Array(size);
  let loaded = 0;
  let told = 0;
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return bytes.subarray(0, loaded);
      for (const out of transform(value, size - loaded)) {
        if (loaded + out.length > size) throw new Error('the verifier is larger than the one this worker was built with');
        bytes.set(out, loaded);
        loaded += out.length;
      }
      if (tell && Date.now() - told > 100) {
        told = Date.now();
        tell(loaded / size);
      }
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }
}

/** Decompresses the SDK as it arrives and tells open pages how far it has got. */
async function inflate(body: ReadableStream<Uint8Array>, inflater: Inflater): Promise<Uint8Array> {
  try {
    const bytes = await collect(body, __SDK__.size, (chunk, room) => inflater.push(chunk, room), (share) => void progress(share));
    if (!inflater.done) throw new Error('the verifier download was cut short');
    return bytes;
  } finally {
    inflater.free();
  }
}

async function progress(share: number): Promise<void> {
  for (const client of await self.clients.matchAll({ type: 'window', includeUncontrolled: true })) client.postMessage({ dashSitesProgress: share });
}

/** Shares one run of `start` until it fails; the next call after a failure starts again. */
function retryable<T>(start: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | undefined;
  return () =>
    (pending ??= start().catch((error: unknown) => {
      pending = undefined;
      throw error;
    }));
}

const QUORUM_URL = __NETWORK__ === 'mainnet' || __NETWORK__ === 'testnet' ? `https://quorums.${__NETWORK__}.networks.dash.org` : '';
/** How long a worker whose verifier is ready waits for the node pick; a restarted worker gets here fast. */
const NODE_GRACE_MS = 600;
let nodes: Promise<string[] | undefined> | undefined;
/** Started with the verifier download, so that by the time the SDK runs its nodes are warm. */
function pickNodes(): Promise<string[] | undefined> {
  nodes ??= QUORUM_URL ? fastNodes({ quorumUrl: QUORUM_URL, fetch: (input, init) => fetch(input, init) }) : Promise.resolve(undefined);
  return nodes;
}

const load = retryable(loadVerifier);
let pinned = true;
let reader: Promise<PlatformReader> | undefined;

function connect(): Promise<PlatformReader> {
  reader ??= open().catch((error: unknown) => {
    reader = undefined;
    throw error;
  });
  return reader;
}

async function open(): Promise<PlatformReader> {
  const { verifier, sdk } = await load();
  const grace = new Promise<undefined>((resolve) => setTimeout(resolve, NODE_GRACE_MS));
  const addresses = pinned ? await Promise.race([pickNodes(), grace]) : undefined;
  const opened = await verifier.connect(readerConfig(__NETWORK__ as Network, __CONTRACT_ID__), sdk, addresses);
  return addresses ? unpinOnFailure(opened, unpin) : opened;
}

/** From the first failure on the picked nodes on, this worker uses the SDK's own node list. */
function unpin(): Promise<PlatformReader> {
  if (pinned) {
    pinned = false;
    reader = undefined;
  }
  return connect();
}

/** Where this worker keeps its copy of the IPFS client, which it downloads from npm by hash. */
const IPFS_KEY = `/dash-sites-module-${IPFS_MODULE.sha256}`;
const KEPT_URLS = [...VERIFIER_URLS, IPFS_KEY];

/**
 * The IPFS client is fetched the first time a site asks for a file at an IPFS place, and never
 * for a site that lists none. Like the verifier, the stored copy is checked on every read.
 */
const loadIpfs = retryable(async () => {
  const cache = await caches.open(SHELL_CACHE).catch(() => undefined);
  const stored = await cache
    ?.match(IPFS_KEY)
    .then((response) => response?.arrayBuffer())
    .catch(() => undefined);
  const kept = stored && new Uint8Array(stored);
  if (kept && (await matchesFile(kept, IPFS_MODULE))) return startIpfs(kept, { routers: __IPFS_ROUTERS__ });
  const source = await fetchPinned(IPFS_MODULE);
  await cache?.put(IPFS_KEY, new Response(source as BodyInit)).catch(() => undefined);
  return startIpfs(source, { routers: __IPFS_ROUTERS__ });
});

/** Earlier versions' verifier and module files are dropped once this worker is in charge. */
async function pruneShellCache(): Promise<void> {
  const cache = await caches.open(SHELL_CACHE);
  const current = new Set(KEPT_URLS.map((url) => new URL(url, self.location.href).href));
  for (const request of await cache.keys()) {
    if (/^\/dash-sites-(verifier|module)-/.test(new URL(request.url).pathname) && !current.has(request.url)) await cache.delete(request);
  }
}

async function resetClients(): Promise<void> {
  for (const client of await self.clients.matchAll({ type: 'window' })) {
    await client.navigate(resetLocation(new URL(client.url))).catch(() => undefined);
  }
}

const DENYLIST_URL = '/.well-known/dash-gateway/denylist.json';

/** Only the droplet build has an operator denylist; the static build drops this code. */
const hostedDenied = __DENYLIST__
  ? hostedDenylist({
      fetchList: async () => {
        const response = await fetch(DENYLIST_URL, { cache: 'no-store', signal: AbortSignal.timeout(5000) });
        return response.ok ? ((await response.json()) as unknown) : undefined;
      },
      load: async () => (await (await caches.open(SHELL_CACHE)).match(DENYLIST_URL))?.json() as Promise<unknown>,
      save: async (value) => (await caches.open(SHELL_CACHE)).put(DENYLIST_URL, new Response(JSON.stringify(value))),
    })
  : undefined;

const host = new SiteHost({
  label: self.location.hostname.split('.')[0] as string,
  network: __NETWORK__,
  reader: connect,
  store: new BrowserStore(KEPT_URLS),
  places: { https: httpsFetcher(), ipfs: ipfsFetcher(loadIpfs) },
  builderUrl: __BUILDER_URL__,
  onOwnerChange: () => void resetClients(),
  onNewerFormat: () => void self.registration.update().catch(() => undefined),
  denied: hostedDenied,
  log: (entry) => console.warn('dash-sites', entry),
});

/**
 * A new worker serves nothing from a site until Platform has answered. Meanwhile a page load gets the
 * same progress page the first visit shows, which waits for the answer and then loads the site.
 */
const BOOT_HEADERS = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };

/** A response built in a worker has no address of its own, so a relative `Location` is made absolute here. */
function toResponse(reply: Reply, request: Request): Response {
  const headers = reply.headers.Location ? { ...reply.headers, Location: new URL(reply.headers.Location, request.url).href } : reply.headers;
  return new Response(request.method === 'HEAD' || reply.body === undefined ? null : (reply.body as BodyInit), { status: reply.status, headers });
}

self.addEventListener('install', (event) => event.waitUntil(load().then(() => self.skipWaiting())));
self.addEventListener('activate', (event) => event.waitUntil(Promise.all([self.clients.claim(), pruneShellCache().catch(() => undefined)])));
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    event.respondWith(new Response('This site is read-only: it has no server to send data to.\n', { status: 405, headers: { Allow: 'GET, HEAD' } }));
    return;
  }
  if (request.mode === 'navigate' && request.destination === 'document' && !host.proved) {
    event.respondWith(new Response(__BOOT_PAGE__, { headers: BOOT_HEADERS }));
    event.waitUntil(host.prove().catch(() => undefined));
    return;
  }
  event.respondWith(
    host
      .respond({ url, navigation: request.mode === 'navigate', topLevel: request.destination === 'document', range: request.headers.get('range'), waitUntil: (work) => event.waitUntil(work) })
      .then((reply) => toResponse(reply, request))
      .catch((error: unknown) => {
        console.error('dash-sites', error);
        return new Response('The verifier failed while loading this file.\n', { status: 500, headers: { 'Content-Type': 'text/plain' } });
      }),
  );
});
