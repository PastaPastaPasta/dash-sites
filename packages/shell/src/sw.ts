/// <reference lib="webworker" />
import { readerConfig, toHex, type Network, type PlatformReader } from '@dash-sites/core';
import { hostedDenylist } from './hosted-denylist.js';
import { resetLocation, SiteHost, type Reply } from './host.js';
import { BrowserStore, SHELL_CACHE } from './store.js';
import type { Connect } from './verifier.js';

declare const self: ServiceWorkerGlobalScope & { dashSitesConnect?: Connect };
declare const __VERIFIER__: string;
declare const __VERIFIER_SHA256__: string;
declare const __NETWORK__: string;
declare const __CONTRACT_ID__: string;
declare const __BUILDER_URL__: string;
declare const __DENYLIST__: boolean;
declare const __VERIFIER_SIZE__: number;
declare const __BOOT_PAGE__: string;

const matches = async (bytes: ArrayBuffer): Promise<boolean> => toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))) === __VERIFIER_SHA256__;

/**
 * The verifier's source, checked against the hash this worker was built with. It is fetched by the
 * worker and kept in Cache Storage rather than imported as a worker script, because browsers refuse
 * to store a script this large for a private window. Site code can write to that cache, hence the check.
 */
async function verifierSource(): Promise<string> {
  const cache = await caches.open(SHELL_CACHE).catch(() => undefined);
  const kept = await (await cache?.match(__VERIFIER__))?.arrayBuffer();
  if (kept && (await matches(kept))) return new TextDecoder().decode(kept);
  // Retried past the HTTP cache: one bad response cached as immutable would otherwise break every name.
  let bytes = await fetchVerifier('default').catch(() => undefined);
  if (!bytes || !(await matches(bytes))) bytes = await fetchVerifier('reload');
  if (!(await matches(bytes))) throw new Error('the verifier does not match the hash this worker was built with');
  await cache?.put(__VERIFIER__, new Response(bytes, { headers: { 'Content-Type': 'text/javascript' } })).catch(() => undefined);
  return new TextDecoder().decode(bytes);
}

async function fetchVerifier(mode: RequestCache): Promise<ArrayBuffer> {
  const response = await fetch(__VERIFIER__, { cache: mode });
  if (!response.ok || !response.body) throw new Error(`the verifier could not be downloaded (${response.status})`);
  return download(response.body);
}

/** Reads the verifier and tells open pages how far the download has got. */
async function download(body: ReadableStream<Uint8Array>): Promise<ArrayBuffer> {
  const bytes = new Uint8Array(__VERIFIER_SIZE__);
  let loaded = 0;
  let told = 0;
  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (loaded + value.length > bytes.length) {
      await reader.cancel();
      throw new Error('the verifier is larger than the one this worker was built with');
    }
    bytes.set(value, loaded);
    loaded += value.length;
    if (Date.now() - told > 100) {
      told = Date.now();
      void progress(loaded / bytes.length);
    }
  }
  return loaded === bytes.length ? bytes.buffer : bytes.buffer.slice(0, loaded);
}

async function progress(share: number): Promise<void> {
  for (const client of await self.clients.matchAll({ type: 'window', includeUncontrolled: true })) client.postMessage({ dashSitesProgress: share });
}

let reader: Promise<PlatformReader> | undefined;
function connect(): Promise<PlatformReader> {
  reader ??= Promise.resolve()
    .then(async () => {
      if (!self.dashSitesConnect) (0, eval)(await verifierSource());
      return (self.dashSitesConnect as Connect)(readerConfig(__NETWORK__ as Network, __CONTRACT_ID__));
    })
    .catch((error: unknown) => {
      reader = undefined;
      throw error;
    });
  return reader;
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
  store: new BrowserStore(__VERIFIER__),
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

self.addEventListener('install', (event) => event.waitUntil(verifierSource().then(() => self.skipWaiting())));
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
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
