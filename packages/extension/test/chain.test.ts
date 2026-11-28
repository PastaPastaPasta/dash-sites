import { beforeEach, describe, expect, it, vi } from 'vitest';

const syncChain = vi.fn();
vi.mock('@dash-sites/core/chain', async (original) => ({ ...(await original<object>()), syncChain: (...args: unknown[]) => syncChain(...args) }));

const store = new Map<string, unknown>();
(globalThis as unknown as { chrome: unknown }).chrome = {
  storage: {
    local: {
      get: async (key: string) => (store.has(key) ? { [key]: store.get(key) } : {}),
      set: async (items: Record<string, unknown>) => {
        for (const [key, value] of Object.entries(items)) store.set(key, value);
      },
    },
  },
};

const { ChainKeeper } = await import('../src/chain.js');
const snapshot = (syncedAt: number, listHeight = 1) => ({ version: 1, network: 'mainnet', syncedAt, listHeight, quorums: [], nodes: [], chain: {}, listBlockHash: '' });
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('the chain keeper', () => {
  beforeEach(() => {
    store.clear();
    syncChain.mockReset();
  });

  it('proves the chain once for callers that arrive together, and stores it', async () => {
    let finish: (value: unknown) => void = () => undefined;
    syncChain.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const keeper = new ChainKeeper('mainnet');
    const progress: string[] = [];
    const calls = [keeper.get((m) => progress.push(`a:${m}`)), keeper.get((m) => progress.push(`b:${m}`)), keeper.refresh()];
    await tick();
    syncChain.mock.calls[0]?.[0].onProgress('headers');
    finish(snapshot(Date.now(), 7));
    const results = await Promise.all(calls);
    expect(syncChain).toHaveBeenCalledTimes(1);
    expect(results.map((r) => r.listHeight)).toEqual([7, 7, 7]);
    expect(progress).toEqual(['a:headers', 'b:headers']);
    expect((store.get('chain:mainnet') as { listHeight: number }).listHeight).toBe(7);
  });

  it('serves a stored proof at once, whatever its age, and refreshes an old one behind it', async () => {
    store.set('chain:mainnet', snapshot(Date.now() - 60_000, 3));
    const keeper = new ChainKeeper('mainnet');
    expect((await keeper.get()).listHeight).toBe(3);
    expect(syncChain).not.toHaveBeenCalled();

    store.set('chain:mainnet', snapshot(Date.now() - 3 * 3_600_000, 3));
    syncChain.mockResolvedValue(snapshot(Date.now(), 4));
    const old = new ChainKeeper('mainnet');
    expect((await old.get()).listHeight).toBe(3);
    await tick();
    expect(syncChain).toHaveBeenCalledTimes(1);
  });

  it('proves again for the SDK at most every 30 s, and keeps the stored keys if that fails', async () => {
    store.set('chain:mainnet', snapshot(Date.now() - 5_000, 3));
    const keeper = new ChainKeeper('mainnet');
    expect((await keeper.refresh()).listHeight).toBe(3);
    expect(syncChain).not.toHaveBeenCalled();

    store.set('chain:mainnet', snapshot(Date.now() - 60_000, 3));
    syncChain.mockRejectedValue(new Error('no node answered'));
    expect((await new ChainKeeper('mainnet').refresh()).listHeight).toBe(3);
    expect(syncChain).toHaveBeenCalledTimes(1);
  });

  it('does nothing as the worker starts for a browser that never proved the chain', async () => {
    await new ChainKeeper('mainnet').warm();
    expect(syncChain).not.toHaveBeenCalled();
  });
});
