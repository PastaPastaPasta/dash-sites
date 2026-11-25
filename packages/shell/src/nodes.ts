import type { PlatformReader } from '@dash-sites/core';

/** The masternode list from the quorum service the SDK uses for its trusted context. */
interface Masternode {
  status?: string;
  versionCheck?: string;
  addresses?: { platform_https?: string[] };
}

export interface NodeOptions {
  /** `https://quorums.<network>.networks.dash.org`. */
  quorumUrl: string;
  fetch: typeof fetch;
  /** Nodes tried at once. */
  tries?: number;
  /** Answers to wait for. */
  keep?: number;
  /** This long after the list arrives, the nodes that have answered are used, or none if too few have. */
  deadlineMs?: number;
}

const PROBE_PATH = '/org.dash.platform.dapi.v0.Platform/getDocuments';
/** Today every entry is `<ipv4>:443`, which is also all `e2e/shell.mjs` accepts. */
const HOST = /^([a-z\d.-]+|\[[\da-f:.]+\]):\d{1,5}$/i;
const LIST_LIMIT_MS = 1500;
const MIN_NODES = 2;
const UNAVAILABLE = '14';

/**
 * Picks Platform nodes for the SDK while the verifier downloads, and leaves the browser with an open
 * connection and a cached CORS preflight to each, so the first proved queries skip both. Each node
 * gets an empty request, which DAPI refuses at once. Resolves to the first that answered, or to
 * undefined, in which case the SDK picks nodes itself. Which node answers cannot change what is
 * shown, only whether and how fast it arrives: every answer is proof-checked.
 */
export async function fastNodes(options: NodeOptions): Promise<string[] | undefined> {
  const { quorumUrl, fetch, tries = 10, keep = 4, deadlineMs = 2500 } = options;
  const stop = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const response = await fetch(`${quorumUrl}/masternodes`, { credentials: 'omit', signal: AbortSignal.timeout(LIST_LIMIT_MS) });
    const { data } = (await response.json()) as { data?: Masternode[] };
    const hosts = (data ?? [])
      .filter((node) => node.status === 'ENABLED' && node.versionCheck === 'success')
      .map((node) => node.addresses?.platform_https?.[0])
      .filter((host): host is string => typeof host === 'string' && HOST.test(host));
    for (let i = hosts.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [hosts[i], hosts[j]] = [hosts[j] as string, hosts[i] as string];
    }
    return await new Promise<string[] | undefined>((resolve) => {
      const answered: string[] = [];
      const settle = () => resolve(answered.length >= MIN_NODES ? answered.slice(0, keep) : undefined);
      stop.signal.addEventListener('abort', settle, { once: true });
      timer = setTimeout(() => stop.abort(), deadlineMs);
      const probes = hosts.slice(0, tries).map(async (host) => {
        const address = `https://${host}`;
        const reply = await fetch(`${address}${PROBE_PATH}`, {
          method: 'POST',
          credentials: 'omit',
          headers: { 'Content-Type': 'application/grpc-web+proto', 'X-Grpc-Web': '1' },
          body: new Uint8Array(0),
          signal: stop.signal,
        });
        if (reply.ok && reply.headers.get('grpc-status') !== UNAVAILABLE) {
          answered.push(address);
          if (answered.length >= keep) settle();
        }
        await reply.body?.cancel();
      });
      void Promise.allSettled(probes).then(settle);
    });
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
    stop.abort();
  }
}

/**
 * The reader on the picked nodes. Its first failure calls `unpin`, which moves the worker to a reader
 * on the SDK's own node list: a short outage can get the few picked nodes banned, where the full list
 * would have absorbed it. A query that failed because every picked node was banned is retried there.
 */
export function unpinOnFailure(inner: PlatformReader, unpin: () => Promise<PlatformReader>): PlatformReader {
  const run = async <T>(query: (reader: PlatformReader) => Promise<T>): Promise<T> => {
    try {
      return await query(inner);
    } catch (error) {
      const next = unpin();
      const message = (error as { message?: unknown } | undefined)?.message;
      if (typeof message === 'string' && /no available addresses/i.test(message)) return query(await next);
      next.catch(() => undefined);
      throw error;
    }
  };
  return {
    get noSiteContract() {
      return inner.noSiteContract;
    },
    getDomain: (label) => run((reader) => reader.getDomain(label)),
    getSite: (ownerId, domainId) => run((reader) => reader.getSite(ownerId, domainId)),
    getChunks: (ownerId, hashes) => run((reader) => reader.getChunks(ownerId, hashes)),
  };
}
