/// <reference lib="webworker" />
import { networkConfig, type Network, type PlatformReader } from '@dash-sites/core';
import { RESET_PATH, SiteHost, type Reply } from './host.js';
import { BrowserStore } from './store.js';
import type { Connect } from './verifier.js';

declare const self: ServiceWorkerGlobalScope & { dashSitesConnect?: Connect };
declare const __VERIFIER__: string;
declare const __NETWORK__: string;
declare const __CONTRACT_ID__: string;
declare const __BUILDER_URL__: string;

let reader: Promise<PlatformReader> | undefined;
function connect(): Promise<PlatformReader> {
  reader ??= Promise.resolve()
    .then(() => {
      if (!self.dashSitesConnect) importScripts(__VERIFIER__);
      return (self.dashSitesConnect as Connect)(networkConfig(__NETWORK__ as Network, __CONTRACT_ID__ || undefined));
    })
    .catch((error: unknown) => {
      reader = undefined;
      throw error;
    });
  return reader;
}

async function reloadClients(kind: 'content' | 'owner'): Promise<void> {
  for (const client of await self.clients.matchAll({ type: 'window' })) {
    const url = new URL(client.url);
    const target = kind === 'owner' ? `${RESET_PATH}#${encodeURIComponent(url.pathname + url.search)}` : client.url;
    await client.navigate(target).catch(() => undefined);
  }
}

const host = new SiteHost({
  label: self.location.hostname.split('.')[0] as string,
  network: __NETWORK__,
  reader: connect,
  store: new BrowserStore(),
  builderUrl: __BUILDER_URL__,
  onChange: (kind) => void reloadClients(kind),
  log: (entry) => console.warn('dash-sites', entry),
});

function toResponse(reply: Reply, head: boolean): Response {
  const bodiless = head || reply.status === 204 || reply.status === 304 || reply.body === undefined;
  return new Response(bodiless ? null : (reply.body as BodyInit), { status: reply.status, headers: reply.headers });
}

self.addEventListener('install', () => {
  importScripts(__VERIFIER__);
  void self.skipWaiting();
});
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
      .respond({ url, navigation: request.mode === 'navigate', range: request.headers.get('range'), waitUntil: (work) => event.waitUntil(work) })
      .then((reply) => toResponse(reply, request.method === 'HEAD'))
      .catch((error: unknown) => {
        console.error('dash-sites', error);
        return new Response('The verifier failed while loading this file.\n', { status: 500, headers: { 'Content-Type': 'text/plain' } });
      }),
  );
});
