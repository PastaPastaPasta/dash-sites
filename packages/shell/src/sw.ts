/// <reference lib="webworker" />
import { readerConfig, toHex, type Network, type PlatformReader } from '@dash-sites/core';
import { hostedDenylist } from './hosted-denylist.js';
import { resetLocation, SiteHost, type Reply } from './host.js';
import { BrowserStore, SHELL_CACHE } from './store.js';
import type { Inflater } from './inflate.js';
import type { Verifier } from './verifier.js';

declare const self: ServiceWorkerGlobalScope & { dashSitesVerifier?: Verifier };
declare const __VERIFIER__: Pinned;
declare const __SDK__: Pinned & { packedSize: number };
declare const __NETWORK__: string;
declare const __CONTRACT_ID__: string;
declare const __BUILDER_URL__: string;
declare const __DENYLIST__: boolean;
declare const __BOOT_PAGE__: string;

/** A file this worker was built with: where it is served, and the SHA-256 and size of its bytes. */
interface Pinned {
  url: string;
  sha256: string;
  size: number;
}

const matches = async (bytes: Uint8Array, file: Pinned): Promise<boolean> =>
  toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource))) === file.sha256;

/**
 * The verifier is two files: its script, and the Dash SDK's WebAssembly served compressed with brotli.
 * The worker fetches both and keeps them in Cache Storage rather than importing them, because browsers
 * refuse to store a script this large for a private window. Site code can write to that cache, so
 * every read is checked against the hash this worker was built with, and nothing runs before that.
 */
async function loadVerifier(): Promise<{ verifier: Verifier; sdk: WebAssembly.Module }> {
  const cache = await caches.open(SHELL_CACHE).catch(() => undefined);
  const keptSdk = kept(cache, __SDK__);
  // The SDK is most of the bytes, so its download starts while the script is still coming.
  const sdkResponse = keptSdk.then((bytes) => (bytes ? undefined : fetch(__SDK__.url)));
  sdkResponse.catch(() => undefined);
  const source = (await kept(cache, __VERIFIER__)) ?? (await downloadChecked(cache, __VERIFIER__, 'text/javascript', (body) => collect(body, __VERIFIER__.size)));
  (0, eval)(new TextDecoder().decode(source));
  const verifier = self.dashSitesVerifier as Verifier;
  const wasm =
    (await keptSdk) ??
    (await downloadChecked(cache, __SDK__, 'application/wasm', (body) => inflate(body, verifier.inflater()), await sdkResponse.catch(() => undefined)));
  return { verifier, sdk: await WebAssembly.compile(wasm as BufferSource) };
}

async function kept(cache: Cache | undefined, file: Pinned): Promise<Uint8Array | undefined> {
  const response = await cache?.match(file.url).catch(() => undefined);
  const bytes = response && new Uint8Array(await response.arrayBuffer());
  return bytes && (await matches(bytes, file)) ? bytes : undefined;
}

/** Retried past the HTTP cache: one bad response cached as immutable would otherwise break every name. */
async function downloadChecked(
  cache: Cache | undefined,
  file: Pinned,
  type: string,
  read: (body: ReadableStream<Uint8Array>) => Promise<Uint8Array>,
  first?: Response,
): Promise<Uint8Array> {
  const attempt = async (response: Response | Promise<Response>): Promise<Uint8Array | undefined> => {
    const { ok, status, body } = await response;
    if (!ok || !body) throw new Error(`the verifier could not be downloaded (${status})`);
    const bytes = await read(body);
    return (await matches(bytes, file)) ? bytes : undefined;
  };
  const bytes = (await attempt(first ?? fetch(file.url)).catch(() => undefined)) ?? (await attempt(fetch(file.url, { cache: 'reload' })));
  if (!bytes) throw new Error('the verifier does not match the hash this worker was built with');
  await cache?.put(file.url, new Response(bytes as BodyInit, { headers: { 'Content-Type': type } })).catch(() => undefined);
  return bytes;
}

/** Reads a download into a buffer of the size the worker was built with, reporting progress. */
async function collect(body: ReadableStream<Uint8Array>, size: number): Promise<Uint8Array> {
  const bytes = new Uint8Array(size);
  let loaded = 0;
  await read(body, (chunk) => {
    if (loaded + chunk.length > size) throw new Error('the verifier is larger than the one this worker was built with');
    bytes.set(chunk, loaded);
    loaded += chunk.length;
  });
  return bytes.subarray(0, loaded);
}

/** Decompresses the SDK as it arrives, into a buffer of the size the worker was built with. */
async function inflate(body: ReadableStream<Uint8Array>, inflater: Inflater): Promise<Uint8Array> {
  const bytes = new Uint8Array(__SDK__.size);
  let loaded = 0;
  try {
    await read(body, (chunk) => {
      for (const out of inflater.push(chunk)) {
        if (loaded + out.length > bytes.length) throw new Error('the verifier is larger than the one this worker was built with');
        bytes.set(out, loaded);
        loaded += out.length;
      }
    });
    if (!inflater.done) throw new Error('the verifier download was cut short');
  } finally {
    inflater.free();
  }
  return bytes.subarray(0, loaded);
}

const PROGRESS_TOTAL = __VERIFIER__.size + __SDK__.packedSize;
let received = 0;
let told = 0;

async function read(body: ReadableStream<Uint8Array>, each: (chunk: Uint8Array) => void): Promise<void> {
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      each(value);
      received += value.length;
      if (Date.now() - told > 100) {
        told = Date.now();
        void progress(Math.min(1, received / PROGRESS_TOTAL));
      }
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }
}

async function progress(share: number): Promise<void> {
  for (const client of await self.clients.matchAll({ type: 'window', includeUncontrolled: true })) client.postMessage({ dashSitesProgress: share });
}

let loading: ReturnType<typeof loadVerifier> | undefined;
function load(): ReturnType<typeof loadVerifier> {
  loading ??= loadVerifier().catch((error: unknown) => {
    loading = undefined;
    throw error;
  });
  return loading;
}

let reader: Promise<PlatformReader> | undefined;
function connect(): Promise<PlatformReader> {
  reader ??= load()
    .then(({ verifier, sdk }) => verifier.connect(readerConfig(__NETWORK__ as Network, __CONTRACT_ID__), sdk))
    .catch((error: unknown) => {
      reader = undefined;
      throw error;
    });
  return reader;
}

/** Earlier versions' verifier files are dropped once this worker is in charge. */
async function pruneShellCache(): Promise<void> {
  const cache = await caches.open(SHELL_CACHE);
  const current = new Set([__VERIFIER__.url, __SDK__.url].map((url) => new URL(url, self.location.href).href));
  for (const request of await cache.keys()) {
    if (new URL(request.url).pathname.startsWith('/dash-sites-verifier-') && !current.has(request.url)) await cache.delete(request);
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
  store: new BrowserStore([__VERIFIER__.url, __SDK__.url]),
  builderUrl: __BUILDER_URL__,
  onOwnerChange: () => void resetClients(),
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
