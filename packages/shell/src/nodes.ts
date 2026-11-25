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
  /** After this, the nodes that have answered are used, or none if too few have. */
  deadlineMs?: number;
  random?: () => number;
}

const PROBE_PATH = '/org.dash.platform.dapi.v0.Platform/getDocuments';
const MIN_NODES = 2;

/**
 * Picks Platform nodes for the SDK while the verifier downloads, and leaves the browser with an open
 * connection and a cached CORS preflight to each, so the first proved queries skip both. Each node
 * gets an empty request, which it refuses at once. Resolves to the fastest that answered, in order,
 * or to undefined, in which case the SDK picks nodes itself. Which node answers does not matter to
 * the result: every answer is proof-checked against the quorum keys.
 */
export async function fastNodes(options: NodeOptions): Promise<string[] | undefined> {
  const { quorumUrl, fetch, tries = 10, keep = 4, deadlineMs = 2500, random = Math.random } = options;
  const deadline = AbortSignal.timeout(deadlineMs);
  try {
    const response = await fetch(`${quorumUrl}/masternodes`, { credentials: 'omit', signal: deadline });
    const { data } = (await response.json()) as { data?: Masternode[] };
    const hosts = (data ?? [])
      .filter((node) => node.status === 'ENABLED' && node.versionCheck === 'success')
      .map((node) => node.addresses?.platform_https?.[0])
      .filter((host): host is string => typeof host === 'string' && /^[\w.:[\]-]+$/.test(host));
    for (let i = hosts.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [hosts[i], hosts[j]] = [hosts[j] as string, hosts[i] as string];
    }
    return await new Promise<string[] | undefined>((resolve) => {
      const answered: string[] = [];
      let pending = Math.min(tries, hosts.length);
      const settle = () => resolve(answered.length >= MIN_NODES ? answered.slice(0, keep) : undefined);
      deadline.addEventListener('abort', settle, { once: true });
      if (!pending) settle();
      for (const host of hosts.slice(0, tries)) {
        const address = `https://${host}`;
        fetch(`${address}${PROBE_PATH}`, {
          method: 'POST',
          credentials: 'omit',
          headers: { 'Content-Type': 'application/grpc-web+proto', 'X-Grpc-Web': '1' },
          body: new Uint8Array(0),
          signal: deadline,
        })
          .then((reply) => {
            answered.push(address);
            return reply.body?.cancel();
          })
          .catch(() => undefined)
          .finally(() => {
            pending -= 1;
            if (answered.length >= keep || pending === 0) settle();
          });
      }
    });
  } catch {
    return undefined;
  }
}
