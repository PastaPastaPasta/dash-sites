import { base58 } from '@scure/base';
import { concat, DASH_TLD, DPNS_CONTRACT_ID, PRELOAD_CHUNKS, toHex, utf8 } from '@dash-sites/core';

export const GET_EPOCHS_INFO_PATH = '/org.dash.platform.dapi.v0.Platform/getEpochsInfo';
export const GET_DOCUMENTS_PATH = '/org.dash.platform.dapi.v0.Platform/getDocuments';
export const GET_EPOCHS_INFO_BODY = new Uint8Array([0, 0, 0, 0, 10, 10, 8, 10, 0, 16, 1, 24, 1, 32, 1]);

const HOST = /^([a-z\d.-]+|\[[\da-f:.]+\]):\d{1,5}$/i;
const GRPC_HEADERS = {
  Accept: 'application/grpc-web+proto',
  'Content-Type': 'application/grpc-web+proto',
  'X-Grpc-Web': '1',
};
const CACHE_TTL_MS = 30_000;
const LIST_LIMIT_MS = 1500;
const DOC_HEDGE_DELAY_MS = 180;
const DOC_TIMEOUT_MS = 3500;

interface Masternode {
  status?: string;
  versionCheck?: string;
  addresses?: { platform_https?: string[] };
}

interface CachedResponse {
  url: string;
  status: number;
  statusText: string;
  headers: Array<[string, string]>;
  body: Uint8Array;
  at: number;
}

function encodeVarint(value: number): Uint8Array {
  const out: number[] = [];
  let v = value >>> 0;
  while (v >= 0x80) {
    out.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  out.push(v);
  return new Uint8Array(out);
}

function fieldVarint(field: number, value: number): Uint8Array {
  return concat([encodeVarint((field << 3) | 0), encodeVarint(value)]);
}

function fieldBytes(field: number, data: Uint8Array): Uint8Array {
  return concat([encodeVarint((field << 3) | 2), encodeVarint(data.length), data]);
}

function fieldString(field: number, value: string): Uint8Array {
  return fieldBytes(field, utf8.encode(value));
}

function whereEqString(column: string, value: string): Uint8Array {
  const val = fieldString(5, value);
  return concat([fieldString(1, column), fieldBytes(3, val)]);
}

function grpcWebFrame(payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(5 + payload.length);
  new DataView(out.buffer).setUint32(1, payload.length, false);
  out.set(payload, 5);
  return out;
}

export function encodeCompositeNameQuery(contractId: string, normalizedLabel: string, preload: boolean): Uint8Array {
  const dpnsId = base58.decode(DPNS_CONTRACT_ID);
  const siteContractId = base58.decode(contractId);
  const whereParent = fieldBytes(3, whereEqString('normalizedParentDomainName', DASH_TLD));
  const whereLabel = fieldBytes(3, whereEqString('normalizedLabel', normalizedLabel));

  const ownerBind = concat([fieldString(2, '$ownerId'), fieldString(3, '$ownerId')]);
  const siteSub = concat([
    fieldBytes(1, siteContractId),
    fieldString(2, 'site'),
    whereParent,
    whereLabel,
    fieldBytes(7, ownerBind),
  ]);

  const parts: Uint8Array[] = [
    fieldBytes(1, dpnsId),
    fieldString(2, 'domain'),
    whereParent,
    whereLabel,
    fieldVarint(5, 1),
    fieldVarint(8, 1),
    fieldBytes(9, new Uint8Array(0)),
    fieldBytes(14, siteSub),
  ];

  if (preload) {
    const chunkBind = concat([fieldVarint(1, 1), fieldString(2, '$id'), fieldString(3, 'site')]);
    const chunkSub = concat([
      fieldBytes(1, siteContractId),
      fieldString(2, 'chunk'),
      fieldVarint(5, PRELOAD_CHUNKS),
      fieldBytes(7, chunkBind),
    ]);
    parts.push(fieldBytes(14, chunkSub));
  }

  return grpcWebFrame(fieldBytes(2, concat(parts)));
}

export function grpcStatusFromResponse(reply: Response, body: Uint8Array): string | undefined {
  const header = reply.headers.get('grpc-status');
  if (header !== null) return header.trim();
  let offset = 0;
  while (offset + 5 <= body.length) {
    const flag = body[offset] as number;
    const len = new DataView(body.buffer, body.byteOffset + offset + 1, 4).getUint32(0, false);
    offset += 5;
    if (offset + len > body.length) break;
    if (flag & 0x80) {
      const trailers = utf8.decode(body.subarray(offset, offset + len));
      const match = /^grpc-status:\s*([^\r\n]+)/im.exec(trailers);
      if (match) return match[1]?.trim();
    }
    offset += len;
  }
  return undefined;
}

function toCached(url: string, reply: Response, body: Uint8Array, now: () => number): CachedResponse {
  return {
    url: reply.url || url,
    status: reply.status,
    statusText: reply.statusText,
    headers: [...reply.headers.entries()],
    body,
    at: now(),
  };
}

function fromCached(entry: CachedResponse): Response {
  const response = new Response(entry.body as BodyInit, {
    status: entry.status,
    statusText: entry.statusText,
    headers: entry.headers,
  });
  Object.defineProperty(response, 'url', { value: entry.url });
  return response;
}

export interface PrefetchOptions {
  quorumUrl: string;
  fetch: typeof fetch;
  contractId?: string;
  normalizedLabel?: string;
  preload?: Promise<boolean> | boolean;
  tries?: number;
  keep?: number;
  deadlineMs?: number;
  now?: () => number;
}

export class PlatformPrefetch {
  private readonly now: () => number;
  private readonly getCache = new Map<string, Promise<CachedResponse | undefined>>();
  private readonly postCache = new Map<string, Promise<CachedResponse | undefined>>();
  private readonly answered: string[] = [];
  private readonly waiters: Array<() => void> = [];
  private probesDone = false;
  private stop = new AbortController();
  private started = false;
  private docStarted = false;
  private docHedged = false;

  constructor(private readonly options: PrefetchOptions) {
    this.now = options.now ?? Date.now;
  }

  start(): void {
    if (this.started || !this.options.quorumUrl) return;
    this.started = true;
    const { quorumUrl, fetch } = this.options;
    this.prefetchGet(`${quorumUrl}/quorums`);
    this.prefetchGet(`${quorumUrl}/previous`);
    void this.runNodeRace(fetch);
  }

  private prefetchGet(url: string): void {
    const work = this.options
      .fetch(url, { credentials: 'omit', signal: AbortSignal.timeout(LIST_LIMIT_MS) })
      .then(async (reply) => {
        if (!reply.ok) return undefined;
        const body = new Uint8Array(await reply.arrayBuffer());
        return toCached(url, reply, body, this.now);
      })
      .catch(() => undefined);
    this.getCache.set(url, work);
  }

  private notify(): void {
    for (const wake of this.waiters.splice(0)) wake();
  }

  private async runNodeRace(fetch: typeof globalThis.fetch): Promise<void> {
    const { quorumUrl, tries = 14, keep = 3, deadlineMs = 2500 } = this.options;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let resolveEpoch!: (entry: CachedResponse | undefined) => void;
    const epochKey = `${GET_EPOCHS_INFO_PATH}:${toHex(GET_EPOCHS_INFO_BODY)}`;
    let epochSettled = false;
    this.postCache.set(
      epochKey,
      new Promise<CachedResponse | undefined>((resolve) => {
        resolveEpoch = (entry) => {
          if (epochSettled) return;
          epochSettled = true;
          resolve(entry);
        };
      }),
    );

    try {
      const listUrl = `${quorumUrl}/masternodes`;
      const [response, preload] = await Promise.all([
        fetch(listUrl, { credentials: 'omit', signal: AbortSignal.timeout(LIST_LIMIT_MS) }),
        Promise.resolve(this.options.preload ?? true),
      ]);
      const listBytes = new Uint8Array(await response.arrayBuffer());
      if (response.ok) this.getCache.set(listUrl, Promise.resolve(toCached(listUrl, response, listBytes, this.now)));
      const { data } = JSON.parse(utf8.decode(listBytes)) as { data?: Masternode[] };
      const hosts = (data ?? [])
        .filter((node) => node.status === 'ENABLED' && node.versionCheck === 'success')
        .map((node) => node.addresses?.platform_https?.[0])
        .filter((host): host is string => typeof host === 'string' && HOST.test(host));
      for (let i = hosts.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [hosts[i], hosts[j]] = [hosts[j] as string, hosts[i] as string];
      }

      const candidates = hosts.slice(0, tries).map((host) => `https://${host}`);
      this.startDocPrefetch(candidates.slice(0, 4), preload);

      timer = setTimeout(() => this.stop.abort(), deadlineMs);
      const probes = candidates.map(async (address) => {
        try {
          const url = `${address}${GET_EPOCHS_INFO_PATH}`;
          const reply = await fetch(url, {
            method: 'POST',
            credentials: 'omit',
            headers: GRPC_HEADERS,
            body: GET_EPOCHS_INFO_BODY,
            signal: this.stop.signal,
          });
          if (!reply.ok) {
            await reply.body?.cancel().catch(() => undefined);
            return;
          }
          const body = new Uint8Array(await reply.arrayBuffer());
          const grpcStatus = grpcStatusFromResponse(reply, body);
          if (grpcStatus !== '0' || body.length <= 5) return;
          this.answered.push(address);
          resolveEpoch(toCached(url, reply, body, this.now));
          this.notify();
          if (this.answered.length >= keep) this.stop.abort();
        } catch {
          // Probe failed or aborted.
        }
      });
      await Promise.allSettled(probes);
    } catch {
      // Masternode list unavailable; SDK uses its own list.
    } finally {
      clearTimeout(timer);
      this.probesDone = true;
      resolveEpoch(undefined);
      this.notify();
    }
  }

  private startDocPrefetch(initialAddresses: string[], preload: boolean): void {
    if (this.docStarted || !this.options.contractId || !this.options.normalizedLabel || initialAddresses.length === 0) return;
    this.docStarted = true;
    const { contractId, normalizedLabel, fetch } = this.options;
    const reqBody = encodeCompositeNameQuery(contractId, normalizedLabel, preload);
    const key = `${GET_DOCUMENTS_PATH}:${toHex(reqBody)}`;
    const controller = new AbortController();
    let settled = false;

    const work = new Promise<CachedResponse | undefined>((resolve) => {
      const finish = (entry: CachedResponse | undefined) => {
        if (settled) return;
        settled = true;
        clearTimeout(hedgeTimer);
        clearTimeout(limitTimer);
        controller.abort();
        resolve(entry);
      };

      const tried = new Set<string>();
      let inFlight = 0;

      const queryNode = async (address: string): Promise<void> => {
        inFlight += 1;
        try {
          const url = `${address}${GET_DOCUMENTS_PATH}`;
          const reply = await fetch(url, {
            method: 'POST',
            credentials: 'omit',
            headers: GRPC_HEADERS,
            body: reqBody as BodyInit,
            signal: controller.signal,
          });
          if (!reply.ok) {
            await reply.body?.cancel().catch(() => undefined);
            return;
          }
          const body = new Uint8Array(await reply.arrayBuffer());
          if (grpcStatusFromResponse(reply, body) === '0' && body.length > 5) {
            finish(toCached(url, reply, body, this.now));
          }
        } catch {
          // Query failed or aborted.
        } finally {
          inFlight -= 1;
          if (!settled && inFlight === 0 && !launchAnswered() && this.probesDone) finish(undefined);
        }
      };

      const launch = (address: string): void => {
        if (settled || tried.has(address)) return;
        tried.add(address);
        void queryNode(address);
      };

      const launchAnswered = (): boolean => {
        const next = this.answered.find((addr) => !tried.has(addr));
        if (!next) return false;
        launch(next);
        return true;
      };

      for (const address of initialAddresses) launch(address);

      const watchWinner = () => {
        if (settled) return;
        if (this.answered.length > 0 && !tried.has(this.answered[0] as string)) {
          launch(this.answered[0] as string);
        } else if (!this.probesDone) {
          this.waiters.push(watchWinner);
        }
      };
      this.waiters.push(watchWinner);

      const hedgeTimer = setTimeout(() => {
        if (settled || this.docHedged) return;
        this.docHedged = true;
        launchAnswered();
      }, DOC_HEDGE_DELAY_MS);

      const limitTimer = setTimeout(() => finish(undefined), DOC_TIMEOUT_MS);
    });

    this.postCache.set(key, work);
  }

  /**
   * Returns warmed node addresses once `minReady` have answered, or after `graceMs` returns
   * whatever nodes have already answered (never throwing away healthy nodes on timeout).
   */
  async takeAddresses(graceMs = 400, minReady = 2): Promise<string[] | undefined> {
    if (!this.started) this.start();
    const keep = this.options.keep ?? 4;
    if (this.answered.length >= minReady || this.probesDone) {
      if (this.answered.length >= minReady) this.stop.abort();
      return this.answered.length > 0 ? this.answered.slice(0, keep) : undefined;
    }
    await new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve();
      };
      const check = () => {
        if (this.answered.length >= minReady || this.probesDone) finish();
        else this.waiters.push(check);
      };
      const timer = setTimeout(finish, graceMs);
      this.waiters.push(check);
    });
    if (this.answered.length > 0) this.stop.abort();
    return this.answered.length > 0 ? this.answered.slice(0, keep) : undefined;
  }

  wrapFetch(inner: typeof fetch): typeof fetch {
    return async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();

      if (method === 'GET') {
        const pending = this.getCache.get(url);
        if (pending) {
          this.getCache.delete(url);
          const hit = await pending;
          if (hit && this.now() - hit.at <= CACHE_TTL_MS) return fromCached(hit);
        }
        return inner(input, init);
      }

      if (method === 'POST') {
        const pathname = new URL(url, 'https://local/').pathname;
        if (pathname === GET_EPOCHS_INFO_PATH || pathname === GET_DOCUMENTS_PATH) {
          const req = input instanceof Request ? input : new Request(input, init);
          const reqBytes = new Uint8Array(await req.clone().arrayBuffer());
          const key = `${pathname}:${toHex(reqBytes)}`;
          const pending = this.postCache.get(key);
          if (pending) {
            this.postCache.delete(key);
            const hit = await pending;
            if (hit && this.now() - hit.at <= CACHE_TTL_MS) return fromCached(hit);
          }
          return inner(req);
        }
      }

      return inner(input, init);
    };
  }
}
