import type { PlatformReader } from '@dash-sites/core';
import { describe, expect, it, vi } from 'vitest';
import { fastNodes, unpinOnFailure } from '../src/nodes.js';

const QUORUMS = 'https://quorums.test';
const node = (host: string, status = 'ENABLED', versionCheck = 'success') => ({ status, versionCheck, addresses: { platform_https: [host] } });

type Answer = number | { after: number; status?: number; grpcStatus?: string } | 'refuse';

/** A fetch where each node answers as described, or never when it is missing. */
function network(list: unknown[], answers: Record<string, Answer>, listDelay = 0) {
  const probes: Array<{ host: string; init?: RequestInit }> = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === `${QUORUMS}/masternodes`) {
      await new Promise((resolve, reject) => {
        setTimeout(resolve, listDelay);
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
      return new Response(JSON.stringify({ success: true, data: list }));
    }
    const host = new URL(url).hostname;
    probes.push({ host, init });
    const answer = answers[host];
    if (answer === 'refuse') throw new TypeError('Failed to fetch');
    return new Promise<Response>((resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      if (answer === undefined) return;
      const { after, status = 200, grpcStatus = '13' } = typeof answer === 'number' ? { after: answer } : answer;
      setTimeout(() => resolve(new Response(new Uint8Array(0), { status, headers: { 'grpc-status': grpcStatus } })), after);
    });
  }) as typeof globalThis.fetch;
  return { fetch, probes };
}

describe('fastNodes', () => {
  it('returns the first enabled, version-checked nodes to answer, after an empty grpc-web request to each', async () => {
    const list = [node('a:443'), node('b:443'), node('c:443'), node('d:443'), node('old:443', 'ENABLED', 'fail'), node('banned:443', 'POSE_BANNED')];
    const { fetch, probes } = network(list, { a: 400, b: 100, c: 300, d: 200, old: 1, banned: 1 });
    expect(await fastNodes({ quorumUrl: QUORUMS, fetch, keep: 3 })).toEqual(['https://b:443', 'https://d:443', 'https://c:443']);
    expect(probes.map((probe) => probe.host).sort()).toEqual(['a', 'b', 'c', 'd']);
    for (const { init } of probes) {
      expect(init?.method).toBe('POST');
      expect(init?.credentials).toBe('omit');
      expect((init?.body as Uint8Array).length).toBe(0);
    }
  });

  it('tries only as many nodes as asked, and stops the rest once it has enough', async () => {
    const list = Array.from({ length: 20 }, (_, i) => node(`n${i}:443`));
    const { fetch, probes } = network(list, Object.fromEntries(list.map((_, i) => [`n${i}`, 5 + i])));
    expect(await fastNodes({ quorumUrl: QUORUMS, fetch, tries: 6, keep: 2 })).toHaveLength(2);
    expect(probes).toHaveLength(6);
    expect(probes.every(({ init }) => init?.signal?.aborted)).toBe(true);
  });

  it('does not count nodes that answer with an error or as unavailable', async () => {
    const list = [node('a:443'), node('b:443'), node('c:443'), node('d:443')];
    const answers: Record<string, Answer> = { a: { after: 1, status: 503 }, b: { after: 1, grpcStatus: '14' }, c: 5, d: 10 };
    expect(await fastNodes({ quorumUrl: QUORUMS, fetch: network(list, answers).fetch })).toEqual(['https://c:443', 'https://d:443']);
  });

  it('settles at the deadline with the nodes that answered, or none if too few did', async () => {
    const list = [node('a:443'), node('b:443'), node('c:443')];
    expect(await fastNodes({ quorumUrl: QUORUMS, fetch: network(list, { a: 5, b: 10 }).fetch, deadlineMs: 100 })).toHaveLength(2);
    expect(await fastNodes({ quorumUrl: QUORUMS, fetch: network(list, { a: 5 }).fetch, deadlineMs: 100 })).toBeUndefined();
  });

  it('settles at once when every probe fails', async () => {
    const list = [node('a:443'), node('b:443')];
    const started = Date.now();
    expect(await fastNodes({ quorumUrl: QUORUMS, fetch: network(list, { a: 'refuse', b: 'refuse' }).fetch, deadlineMs: 5000 })).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('gives up quietly when the masternode list is slow or cannot be read', async () => {
    const slow = network([node('a:443'), node('b:443')], { a: 1, b: 1 }, 2000);
    expect(await fastNodes({ quorumUrl: QUORUMS, fetch: slow.fetch })).toBeUndefined();
    expect(slow.probes).toHaveLength(0);
    expect(await fastNodes({ quorumUrl: QUORUMS, fetch: (async () => new Response('not json')) as typeof fetch })).toBeUndefined();
    expect(await fastNodes({ quorumUrl: QUORUMS, fetch: (async () => Promise.reject(new Error('offline'))) as typeof fetch })).toBeUndefined();
  });

  it('ignores addresses that are not a plain host and port', async () => {
    const list = [node('a:443'), node('b:443/evil?x'), node('user@c:443'), node('d:443')];
    const { fetch, probes } = network(list, { a: 5, d: 5 });
    await fastNodes({ quorumUrl: QUORUMS, fetch });
    expect(probes.map((probe) => probe.host).sort()).toEqual(['a', 'd']);
  });
});

function fakeReader(fail?: Error): PlatformReader {
  const answer = async () => {
    if (fail) throw fail;
    return { value: undefined, meta: { height: 1 } } as never;
  };
  return { getDomain: answer, getSite: answer, getChunks: async () => (fail ? Promise.reject(fail) : new Map()) };
}

describe('unpinOnFailure', () => {
  it('passes answers through and leaves the picked nodes in place', async () => {
    const unpin = vi.fn();
    await unpinOnFailure(fakeReader(), unpin).getDomain('alice');
    expect(unpin).not.toHaveBeenCalled();
  });

  it('unpins on a failure and passes the failure on', async () => {
    const unpin = vi.fn(async () => fakeReader());
    await expect(unpinOnFailure(fakeReader(new Error('proof did not verify')), unpin).getSite('o', 'd')).rejects.toThrow(/proof/);
    expect(unpin).toHaveBeenCalledOnce();
  });

  it('retries on the full list when every picked node is banned', async () => {
    const full = fakeReader();
    const spy = vi.spyOn(full, 'getChunks');
    const unpin = vi.fn(async () => full);
    const banned = { message: 'no available addresses to retry, last error: timeout' } as unknown as Error;
    expect(await unpinOnFailure(fakeReader(banned), unpin).getChunks('o', ['h'])).toEqual(new Map());
    expect(spy).toHaveBeenCalledWith('o', ['h']);
  });
});
