/// <reference lib="webworker" />
import { denylistFromJson, isDenied, readerConfig, toHex, type Denylist, type Network, type PlatformReader, type Resolution } from '@dash-sites/core';
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
  const response = await fetch(__VERIFIER__);
  if (!response.ok) throw new Error(`the verifier could not be downloaded (${response.status})`);
  const bytes = await response.arrayBuffer();
  if (!(await matches(bytes))) throw new Error('the verifier does not match the hash this worker was built with');
  await cache?.put(__VERIFIER__, new Response(bytes, { headers: { 'Content-Type': 'text/javascript' } })).catch(() => undefined);
  return new TextDecoder().decode(bytes);
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
const DENYLIST_FRESH_MS = 60_000;
let denylist: { at: number; list?: Denylist } | undefined;

/**
 * The hosting operator's denylist, fetched from the gateway and reused for a minute. If the gateway
 * cannot be reached the last list stays in force, or none: the site keeps working without the gateway.
 */
async function hostedDenied(resolution: Resolution): Promise<boolean> {
  if (!denylist || Date.now() - denylist.at >= DENYLIST_FRESH_MS) {
    let list = denylist?.list;
    try {
      const response = await fetch(DENYLIST_URL, { cache: 'no-store' });
      if (response.ok) list = denylistFromJson(await response.json());
    } catch {
      // keep the last list
    }
    denylist = { at: Date.now(), list };
  }
  return denylist.list ? isDenied(denylist.list, resolution) : false;
}

const host = new SiteHost({
  label: self.location.hostname.split('.')[0] as string,
  network: __NETWORK__,
  reader: connect,
  store: new BrowserStore(__VERIFIER__),
  builderUrl: __BUILDER_URL__,
  onOwnerChange: () => void resetClients(),
  denied: __DENYLIST__ ? hostedDenied : undefined,
  log: (entry) => console.warn('dash-sites', entry),
});

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
