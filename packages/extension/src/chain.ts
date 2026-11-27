import type { Network } from '@dash-sites/core';
import { CHECKPOINTS, SEEDS, SNAPSHOT_VERSION, syncChain, type ChainSnapshot } from '@dash-sites/core/chain';

/** A snapshot younger than this is used as it is; the SDK asks again when it meets a newer quorum. */
const FRESH_MS = 30_000;

const key = (network: Network): string => `chain:${network}`;

async function stored(network: Network): Promise<ChainSnapshot | undefined> {
  const value = (await chrome.storage.local.get(key(network)))[key(network)] as ChainSnapshot | undefined;
  return value?.version === SNAPSHOT_VERSION && value.network === network ? value : undefined;
}

/**
 * The proven chain state for a network, synced from the last one this browser verified (or from the
 * bundled checkpoint) when it is older than a few seconds. Concurrent callers share one sync.
 */
export class ChainKeeper {
  private snapshot?: ChainSnapshot;
  private running?: Promise<ChainSnapshot>;

  constructor(
    private readonly network: Network,
    private readonly onProgress: (message: string) => void = () => undefined,
  ) {}

  get current(): ChainSnapshot | undefined {
    return this.snapshot;
  }

  async get(): Promise<ChainSnapshot> {
    this.snapshot ??= await stored(this.network);
    if (this.snapshot && Date.now() - this.snapshot.syncedAt < FRESH_MS) return this.snapshot;
    return this.sync();
  }

  sync(): Promise<ChainSnapshot> {
    this.running ??= (async () => {
      const checkpoint = CHECKPOINTS[this.network];
      const seeds = SEEDS[this.network];
      if (!checkpoint || !seeds) throw new Error(`This build has no checkpoint for ${this.network}`);
      try {
        const previous = this.snapshot ?? (await stored(this.network));
        const next = await syncChain({ network: this.network, checkpoint, seeds, ...(previous ? { previous } : {}), onProgress: this.onProgress });
        this.snapshot = next;
        await chrome.storage.local.set({ [key(this.network)]: next });
        return next;
      } finally {
        this.running = undefined;
      }
    })();
    return this.running;
  }
}

/** Up to `count` nodes of the list, in random order. */
export function pickNodes(nodes: readonly string[], count: number): string[] {
  const pool = [...nodes];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j] as string, pool[i] as string];
  }
  return pool.slice(0, count);
}
