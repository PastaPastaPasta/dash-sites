import type { ChainSnapshot, StoredQuorum } from './sync.js';

/**
 * Where the SDK is told its quorum service is. The name cannot resolve (`.invalid`), and no request
 * to it leaves the page: the fetch hook answers it from keys this page proved itself.
 */
export const LOCAL_QUORUM_URL = 'https://quorums.dash-sites.invalid';

/** Proven quorum keys. It may sync again: the SDK asks for it when it meets a quorum it has no key for. */
export type SnapshotSource = () => Promise<ChainSnapshot>;

const quorumData = (q: StoredQuorum, height: number) => ({ quorum_hash: q.quorumHash, key: q.publicKey, height, valid_members_count: q.validMembers });

/** A response that reports `url` as its own: the SDK's HTTP client parses `Response.url`, which a constructed response leaves empty. */
function answer(url: URL, body: string, status = 200): Response {
  const response = new Response(body, { status, headers: { 'Content-Type': status === 200 ? 'application/json' : 'text/plain' } });
  Object.defineProperty(response, 'url', { value: url.href });
  return response;
}

/** The answer to a request under {@link LOCAL_QUORUM_URL}, in the format of Dash's quorum service. */
export async function answerQuorumRequest(url: URL, source: SnapshotSource): Promise<Response> {
  const json = (body: unknown): Response => answer(url, JSON.stringify(body));
  if (url.pathname === '/masternodes') return json({ success: true, data: [] });
  const snapshot = await source();
  const current = snapshot.quorums.filter((q) => q.provenAt === snapshot.listHeight);
  const older = snapshot.quorums.filter((q) => q.provenAt !== snapshot.listHeight);
  if (url.pathname === '/quorums') return json({ success: true, data: current.map((q) => quorumData(q, snapshot.listHeight)) });
  if (url.pathname === '/previous') return json({ success: true, data: { height: snapshot.listHeight, quorums: older.map((q) => quorumData(q, q.provenAt)) } });
  return answer(url, 'not found', 404);
}

/** Wraps a fetch so that requests to {@link LOCAL_QUORUM_URL} are answered here and never sent. */
export function withLocalQuorums(inner: typeof fetch, source: SnapshotSource): typeof fetch {
  return (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), 'https://local.invalid/');
    if (url.origin === LOCAL_QUORUM_URL) return answerQuorumRequest(url, source);
    return inner(input, init);
  };
}
