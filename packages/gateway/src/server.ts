import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import {
  CHUNK_SIZE,
  ContentError,
  dashHeaders,
  decide,
  describeResolution,
  escapeHtml,
  HOST_API,
  loadManifest,
  ManifestError,
  matchHost,
  messagePage,
  nameFromPath,
  normalizeLabel,
  readFile,
  resolveName,
  sha256Hex,
  type ChunkSource,
  type ContentRef,
  type Manifest,
  type PlatformReader,
  type Resolution,
} from '@dash-sites/core';
import { LruCache, RefreshingCache } from './cache.js';
import { siteOrigin, type GatewayConfig, type GatewayDomain } from './config.js';
import { landingPage } from './pages.js';

const EPOCH_COOKIE = '__Host-dash-epoch';
const SECOND = 1000;

type ManifestRef = Extract<ContentRef, { scheme: 'dash-manifest' }>;
type Ok = Extract<Resolution, { status: 'ok' }>;

interface Reply {
  status: number;
  headers: Record<string, string>;
  body?: Uint8Array | string;
}

export interface GatewayOptions {
  reader: PlatformReader;
  config: GatewayConfig;
  now?: () => number;
  log?: (line: Record<string, unknown>) => void;
}

function clientAddress(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = String(req.headers['x-forwarded-for'] ?? '').split(',').pop()?.trim();
    if (forwarded) return forwarded;
  }
  return req.socket.remoteAddress ?? 'unknown';
}

class RateLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();

  constructor(
    private readonly perMinute: number,
    private readonly now: () => number,
  ) {}

  allow(address: string): boolean {
    if (this.perMinute <= 0) return true;
    const now = this.now();
    if (this.windows.size > 50000) this.windows.clear();
    const window = this.windows.get(address);
    if (!window || now - window.start >= 60 * SECOND) {
      this.windows.set(address, { start: now, count: 1 });
      return true;
    }
    window.count += 1;
    return window.count <= this.perMinute;
  }
}

function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return undefined;
}

function acceptsGzip(req: IncomingMessage): boolean {
  return /(^|,)\s*gzip\s*(;(?!\s*q=0(\.0*)?\s*(,|$))|,|$)/i.test(String(req.headers['accept-encoding'] ?? ''));
}

function etagMatches(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  return header.split(',').some((value) => {
    const tag = value.trim().replace(/^W\//, '');
    return tag === etag || tag === '*';
  });
}

export function createGateway(options: GatewayOptions): RequestListener {
  const { reader, config } = options;
  const now = options.now ?? Date.now;
  const log = options.log ?? (() => {});
  const hosts = config.domains.map((domain) => domain.host);
  const domainByHost = new Map(config.domains.map((domain) => [domain.host, domain]));
  const deniedNames = new Set([...config.denylist.names].map(normalizeLabel));
  const limiter = new RateLimiter(config.rateLimitPerMinute, now);
  const limits = { maxSiteBytes: config.maxSiteBytes, maxFiles: config.maxFiles };

  const resolutions = new RefreshingCache<Resolution>((name) => resolveName(reader, name), {
    freshMs: 30 * SECOND,
    staleMs: 5 * 60 * SECOND,
    errorMs: 24 * 60 * 60 * SECOND,
    maxEntries: 20000,
    now,
    accept: (next, previous) => !('meta' in next && 'meta' in previous) || next.meta.height >= previous.meta.height,
  });
  const manifests = new LruCache<Manifest>(500);
  const chunks = new LruCache<Uint8Array>(config.chunkCacheBytes, (data) => data.length);
  const files = new LruCache<{ bytes: Uint8Array; stored: Uint8Array }>(config.chunkCacheBytes / 4, (file) => file.bytes.length + file.stored.length);

  const chunkSource = (ownerId: string): ChunkSource => async (hashes) => {
    const out = new Map<string, Uint8Array>();
    const missing: string[] = [];
    for (const hash of hashes) {
      const cached = chunks.get(hash);
      if (cached) out.set(hash, cached);
      else missing.push(hash);
    }
    if (missing.length > 0) {
      for (const [hash, data] of await reader.getChunks(ownerId, missing)) {
        if (data.length > CHUNK_SIZE || sha256Hex(data) !== hash) continue;
        chunks.set(hash, data);
        out.set(hash, data);
      }
    }
    return out;
  };

  async function manifestFor(resolution: Ok, ref: ManifestRef): Promise<Manifest> {
    const key = `${resolution.ownerId}:${resolution.site.content}`;
    let manifest = manifests.get(key);
    if (!manifest) {
      manifest = await loadManifest(ref, chunkSource(resolution.ownerId), limits);
      manifests.set(key, manifest);
    }
    return manifest;
  }

  const baseHeaders = (domain: GatewayDomain): Record<string, string> => ({
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Origin-Agent-Cluster': '?1',
    ...(domain.origin.startsWith('https:') ? { 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' } : {}),
  });

  const html = (status: number, body: string, domain: GatewayDomain, extra: Record<string, string> = {}): Reply => ({
    status,
    headers: { ...baseHeaders(domain), 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; form-action 'none'; frame-ancestors 'none'", ...extra },
    body,
  });

  const json = (status: number, value: unknown, domain: GatewayDomain): Reply => ({
    status,
    headers: { ...baseHeaders(domain), 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify(value),
  });

  function describe(resolution: Resolution, domain: GatewayDomain): Record<string, unknown> {
    const out = describeResolution(resolution, config.network);
    if ('canonicalLabel' in resolution) out.url = `${siteOrigin(domain, resolution.canonicalLabel)}/`;
    return out;
  }

  async function lookup(rawName: string, domain: GatewayDomain): Promise<Reply> {
    const parsed = nameFromPath(rawName);
    if (!parsed) return json(400, { status: 'invalid' }, domain);
    return json(200, describe((await resolutions.get(parsed.normalized)).value, domain), domain);
  }

  async function apex(req: IncomingMessage, url: URL, domain: GatewayDomain): Promise<Reply> {
    if (url.pathname === '/') return html(200, landingPage(config, new URL(domain.origin).host), domain);
    if (url.pathname === '/healthz') return { status: 200, headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }, body: 'ok\n' };
    const match = /^\/api\/resolve\/([^/]+)$/.exec(url.pathname);
    if (match) return lookup(match[1] as string, domain);
    return html(404, messagePage('404', 'Not found', 'There is nothing at this address.', config), domain);
  }

  async function site(req: IncomingMessage, url: URL, domain: GatewayDomain, label: string, normalized: string): Promise<Reply> {
    const dashName = `${escapeHtml(label)}.dash`;
    if (url.pathname.startsWith('/.well-known/acme-challenge/')) return { status: 404, headers: { 'Content-Type': 'text/plain' }, body: 'not found\n' };
    const denied = () => html(451, messagePage('451', 'Unavailable on this gateway', `The operator of this gateway does not serve <code>${dashName}</code>. The site itself is on Dash Platform and other gateways may serve it.`, config), domain);
    if (deniedNames.has(normalized)) return denied();

    const cached = await resolutions.get(normalized);
    const resolution = cached.value;
    const blocked =
      'ownerId' in resolution && (config.denylist.owners.has(resolution.ownerId) || ('site' in resolution && config.denylist.content.has(resolution.site.content)));
    if (url.pathname.startsWith(HOST_API) && !blocked) {
      const path = url.pathname.slice(HOST_API.length);
      if (path === 'site.json') return json(200, { ...describe(resolution, domain), servedBy: 'gateway' }, domain);
      if (path.startsWith('resolve/')) return lookup(path.slice('resolve/'.length), domain);
      if (path !== 'manifest.json') return json(404, { status: 'not-found' }, domain);
    }
    if (resolution.status === 'invalid') return html(404, messagePage('404', 'Not a DPNS name', 'This host is not a valid Dash Platform name.', config), domain);
    if (resolution.status === 'unregistered') {
      return html(404, messagePage('Not registered', `${dashName} is not registered`, 'Nobody owns this name on Dash Platform yet.', config), domain);
    }
    if (label !== resolution.canonicalLabel) {
      return { status: 308, headers: { ...baseHeaders(domain), Location: `${siteOrigin(domain, resolution.canonicalLabel)}${url.pathname}${url.search}`, 'Cache-Control': 'public, max-age=300' } };
    }
    if (config.denylist.owners.has(resolution.ownerId)) return denied();
    if (resolution.status === 'no-site') {
      return html(404, messagePage('No site', `${dashName} has no site yet`, `The name is registered, and its owner has not published a site. If it is yours, <a href="${escapeHtml(config.builderUrl)}">publish one</a>.`, config), domain);
    }
    if (config.denylist.content.has(resolution.site.content)) return denied();
    const unsupported = () => html(502, messagePage('Unsupported', `${dashName} cannot be served here`, `Its site record points at <code>${escapeHtml(resolution.site.content.slice(0, 80))}</code>, which this gateway does not serve.`, config), domain);
    if (resolution.status === 'unsupported' || resolution.content.scheme !== 'dash-manifest') return unsupported();

    const headers: Record<string, string> = {
      ...baseHeaders(domain),
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Expose-Headers': 'ETag, X-Dash-Name, X-Dash-Owner, X-Dash-Site-Revision, X-Dash-Content, X-Dash-Proof-Height, X-Dash-Stale',
      'Accept-Ranges': 'none',
      ...dashHeaders(resolution),
      ...(cached.stale ? { 'X-Dash-Stale': '1' } : {}),
    };

    const epoch = `${resolution.ownerId}.${resolution.domain.transferredAt}`;
    const isDocument = req.headers['sec-fetch-dest'] === 'document';
    const isWorkerScript = req.headers['service-worker'] === 'script' || req.headers['sec-fetch-dest'] === 'serviceworker';
    const epochChanged = (isDocument || isWorkerScript) && readCookie(req.headers.cookie, EPOCH_COOKIE) !== epoch;
    if (epochChanged) {
      headers['Clear-Site-Data'] = '"cache", "storage"';
      headers['Set-Cookie'] = `${EPOCH_COOKIE}=${epoch}; Path=/; Max-Age=31536000; Secure; HttpOnly; SameSite=Lax`;
    }
    const cacheControl = epochChanged ? 'private, no-cache' : 'public, max-age=60, no-transform';

    let manifest: Manifest;
    try {
      manifest = await manifestFor(resolution, resolution.content);
    } catch (error) {
      if (!(error instanceof ContentError) && !(error instanceof ManifestError)) throw error;
      log({ event: 'bad-manifest', name: normalized, error: error.message });
      return html(502, messagePage('Unavailable', `${dashName} cannot be served`, 'Its published content is incomplete or does not match the hashes its owner published.', config), domain);
    }

    if (url.pathname === `${HOST_API}manifest.json`) return json(200, manifest, domain);

    const decision = decide(manifest, url.pathname, url.search);
    if (decision.kind === 'redirect') return { status: 301, headers: { ...headers, Location: decision.location, 'Cache-Control': cacheControl } };
    if (decision.kind === 'not-found') {
      return html(404, messagePage('404', 'Page not found', `<code>${dashName}</code> has no page at this address.`, config), domain, headers);
    }

    const entry = manifest.files[decision.path];
    if (!entry) throw new Error('decision names a file the manifest does not have');
    const etag = `"${entry.sha256}"`;
    Object.assign(headers, { 'Content-Type': entry.type, ETag: etag, 'Cache-Control': cacheControl, Vary: 'Accept-Encoding' });
    if (decision.status === 200 && !epochChanged && etagMatches(req.headers['if-none-match'], etag)) return { status: 304, headers };

    let content = files.get(entry.sha256);
    if (!content) {
      try {
        const read = await readFile(manifest, decision.path, chunkSource(resolution.ownerId));
        content = { bytes: read.bytes, stored: read.stored };
      } catch (error) {
        if (!(error instanceof ContentError)) throw error;
        log({ event: 'bad-file', name: normalized, path: decision.path, error: error.message });
        return html(502, messagePage('Unavailable', 'This file cannot be served', 'Its stored content is incomplete or does not match the hash its owner published.', config), domain);
      }
      files.set(entry.sha256, content);
    }
    if (entry.enc === 'gzip' && acceptsGzip(req)) return { status: decision.status, headers: { ...headers, 'Content-Encoding': 'gzip' }, body: content.stored };
    return { status: decision.status, headers, body: content.bytes };
  }

  async function handle(req: IncomingMessage): Promise<Reply> {
    const plain = (status: number, body: string, extra: Record<string, string> = {}): Reply => ({ status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...extra }, body });
    if (req.method !== 'GET' && req.method !== 'HEAD') return plain(405, 'method not allowed\n', { Allow: 'GET, HEAD' });
    const match = matchHost(req.headers.host, hosts);
    if (match.kind === 'unknown') return plain(421, 'this gateway does not serve that host\n');
    const domain = domainByHost.get(match.domain) as GatewayDomain;
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://gateway.invalid');
    } catch {
      return plain(400, 'bad request\n');
    }
    if (!(req.url ?? '').startsWith('/')) return plain(400, 'bad request\n');
    if (!limiter.allow(clientAddress(req, config.trustProxy))) return plain(429, 'too many requests\n', { 'Retry-After': '60' });
    if (match.kind === 'apex') return apex(req, url, domain);
    if (match.kind === 'invalid' || config.reservedLabels.has(match.label)) {
      return html(404, messagePage('404', 'Not a DPNS name', 'This host is not a Dash Platform name this gateway serves.', config), domain);
    }
    return site(req, url, domain, match.label, match.normalized);
  }

  return (req: IncomingMessage, res: ServerResponse) => {
    const started = now();
    handle(req)
      .catch((error: unknown): Reply => {
        log({ event: 'error', host: req.headers.host, url: req.url, error: String((error as Error)?.message ?? error) });
        return { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'Retry-After': '30' }, body: 'Dash Platform cannot be reached right now. Try again shortly.\n' };
      })
      .then((reply) => {
        const body = typeof reply.body === 'string' ? Buffer.from(reply.body) : reply.body;
        const headers: Record<string, string | number> = { ...reply.headers };
        if (body && reply.status !== 304) headers['Content-Length'] = body.length;
        res.writeHead(reply.status, headers);
        res.end(req.method === 'HEAD' || reply.status === 304 ? undefined : body);
        log({ event: 'request', host: req.headers.host, url: req.url, status: reply.status, ms: now() - started });
      });
  };
}
