import { describe, expect, it } from 'vitest';
import { fastNodes } from '../src/nodes.js';

const QUORUMS = 'https://quorums.test';
const node = (host: string, status = 'ENABLED', versionCheck = 'success') => ({ status, versionCheck, addresses: { platform_https: [host] } });

/** A fetch where each node answers after its delay in ms, or never when the delay is missing. */
function network(list: unknown[], delays: Record<string, number>) {
  const probed: string[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === `${QUORUMS}/masternodes`) return new Response(JSON.stringify({ success: true, data: list }));
    const host = new URL(url).host;
    probed.push(host);
    expect(init?.method).toBe('POST');
    expect(init?.credentials).toBe('omit');
    const delay = delays[host];
    return new Promise<Response>((resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      if (delay !== undefined) setTimeout(() => resolve(new Response(new Uint8Array(0))), delay);
    });
  }) as typeof globalThis.fetch;
  return { fetch, probed };
}

describe('fastNodes', () => {
  it('returns the first nodes to answer, fastest first, from enabled nodes that passed the version check', async () => {
    const list = [node('a:443'), node('b:443'), node('c:443'), node('d:443'), node('old:443', 'ENABLED', 'fail'), node('banned:443', 'POSE_BANNED')];
    const { fetch, probed } = network(list, { a: 40, b: 10, c: 30, d: 20, old: 1, banned: 1 });
    const nodes = await fastNodes({ quorumUrl: QUORUMS, fetch, keep: 3, random: () => 0.5 });
    expect(nodes).toEqual(['https://b:443', 'https://d:443', 'https://c:443']);
    expect(probed.sort()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('tries only as many nodes as asked', async () => {
    const list = Array.from({ length: 20 }, (_, i) => node(`n${i}:443`));
    const { fetch, probed } = network(list, Object.fromEntries(list.map((_, i) => [`n${i}`, 5])));
    await fastNodes({ quorumUrl: QUORUMS, fetch, tries: 6, keep: 4 });
    expect(probed).toHaveLength(6);
  });

  it('settles at the deadline with the nodes that answered, or none if too few did', async () => {
    const list = [node('a:443'), node('b:443'), node('c:443')];
    expect(await fastNodes({ quorumUrl: QUORUMS, fetch: network(list, { a: 5, b: 10 }).fetch, deadlineMs: 100 })).toHaveLength(2);
    expect(await fastNodes({ quorumUrl: QUORUMS, fetch: network(list, { a: 5 }).fetch, deadlineMs: 100 })).toBeUndefined();
  });

  it('gives up quietly when the masternode list cannot be read', async () => {
    const fetch = (async () => new Response('not json')) as typeof globalThis.fetch;
    expect(await fastNodes({ quorumUrl: QUORUMS, fetch })).toBeUndefined();
    const down = (async () => Promise.reject(new Error('offline'))) as typeof globalThis.fetch;
    expect(await fastNodes({ quorumUrl: QUORUMS, fetch: down })).toBeUndefined();
  });

  it('ignores addresses that are not a plain host and port', async () => {
    const list = [node('a:443'), node('b:443/evil?x'), node('c:443')];
    const { fetch, probed } = network(list, { a: 5, c: 5 });
    await fastNodes({ quorumUrl: QUORUMS, fetch });
    expect(probed.sort()).toEqual(['a', 'c']);
  });
});
