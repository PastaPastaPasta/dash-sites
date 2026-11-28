import { shuffle } from '@dash-sites/core/chain';

const PROBE_PATH = '/org.dash.platform.dapi.v0.Platform/getDocuments';
const UNAVAILABLE = '14';
const MIN_NODES = 2;

export interface ProbeOptions {
  /** Nodes probed at once. */
  tries?: number;
  /** Answers to wait for. */
  keep?: number;
  /** After this, the nodes that answered are used, or the fallback if too few did. */
  deadlineMs?: number;
  fetch?: typeof fetch;
}

/**
 * Nodes of the proven list that answer now. Each gets an empty Platform request, which DAPI refuses
 * at once; the first to answer are used, so a node that is down or slow does not cost the SDK a
 * read deadline. Answers prove nothing: every read is still proof-checked. With too few answers,
 * a random pick of the list is used as before.
 */
export async function respondingNodes(nodes: readonly string[], fallback: number, options: ProbeOptions = {}): Promise<string[]> {
  const { tries = 10, deadlineMs = 2500 } = options;
  const keep = Math.max(options.keep ?? 6, MIN_NODES);
  const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
  const stop = new AbortController();
  const answered: string[] = [];
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, deadlineMs);
    const probes = shuffle(nodes)
      .slice(0, tries)
      .map(async (node) => {
        const reply = await fetcher(`${node}${PROBE_PATH}`, {
          method: 'POST',
          credentials: 'omit',
          headers: { 'Content-Type': 'application/grpc-web+proto', 'X-Grpc-Web': '1' },
          body: new Uint8Array(0),
          signal: stop.signal,
        });
        await reply.body?.cancel();
        if (reply.ok && reply.headers.get('grpc-status') !== UNAVAILABLE) {
          answered.push(node);
          if (answered.length >= keep) resolve();
        }
      });
    void Promise.allSettled(probes).then(() => resolve());
    stop.signal.addEventListener('abort', () => clearTimeout(timer));
  });
  stop.abort();
  return answered.length >= MIN_NODES ? answered.slice(0, keep) : shuffle(nodes).slice(0, fallback);
}
