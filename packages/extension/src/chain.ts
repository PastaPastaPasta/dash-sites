import type { Network } from '@dash-sites/core';
import { CHECKPOINTS, SEEDS, SNAPSHOT_VERSION, syncChain, type ChainSnapshot } from '@dash-sites/core/chain';
import { chainKey } from './shared.js';

/** The SDK asks again when it meets a quorum it has no key for; the chain is not proven again sooner than this. */
const REFRESH_FLOOR_MS = 30_000;
/** A stored proof older than this is used as it is and refreshed in the background. */
const BACKGROUND_REFRESH_MS = 10 * 60_000;

async function stored(network: Network): Promise<ChainSnapshot | undefined> {
  const value = (await chrome.storage.local.get(chainKey(network)))[chainKey(network)] as ChainSnapshot | undefined;
  return value?.version === SNAPSHOT_VERSION && value.network === network ? value : undefined;
}

/**
 * The proven chain state for a network, kept by the background worker for every tab and stored
 * across restarts. One sync runs at a time; callers that arrive while it runs wait for it and get
 * its progress.
 */
export class ChainKeeper {
  private snapshot?: ChainSnapshot;
  private running?: Promise<ChainSnapshot>;
  private readonly listeners = new Set<(message: string) => void>();

  constructor(private readonly network: Network) {}

  private async current(): Promise<ChainSnapshot | undefined> {
    this.snapshot ??= await stored(this.network);
    return this.snapshot;
  }

  /**
   * The proven keys for opening a site: the stored ones at once, whatever their age (the SDK asks
   * for newer ones when a response needs them), refreshed in the background once they are a while
   * old. Only a browser that never proved the chain waits for a sync.
   */
  async get(progress?: (message: string) => void): Promise<ChainSnapshot> {
    const current = await this.current();
    if (!current) return this.sync(progress);
    if (Date.now() - current.syncedAt > BACKGROUND_REFRESH_MS) this.sync().catch(() => undefined);
    return current;
  }

  /** Refreshes a stored proof that is a while old, in the background. Does nothing for a browser that never proved the chain. */
  async warm(): Promise<void> {
    const current = await this.current();
    if (current && Date.now() - current.syncedAt > BACKGROUND_REFRESH_MS) await this.sync();
  }

  /** For the SDK when it meets a quorum it has no key for: a new proof, or the stored keys if that fails. */
  async refresh(): Promise<ChainSnapshot> {
    const current = await this.current();
    if (current && Date.now() - current.syncedAt < REFRESH_FLOOR_MS) return current;
    try {
      return await this.sync();
    } catch (error) {
      if (current) return current;
      throw error;
    }
  }

  sync(progress?: (message: string) => void): Promise<ChainSnapshot> {
    if (progress) this.listeners.add(progress);
    this.running ??= (async () => {
      try {
        const checkpoint = CHECKPOINTS[this.network];
        const seeds = SEEDS[this.network];
        if (!checkpoint || !seeds) throw new Error(`This build has no checkpoint for ${this.network}`);
        const previous = await this.current();
        const next = await syncChain({
          network: this.network,
          checkpoint,
          seeds,
          ...(previous ? { previous } : {}),
          onProgress: (message) => {
            for (const listener of this.listeners) listener(message);
          },
        });
        this.snapshot = next;
        await chrome.storage.local.set({ [chainKey(this.network)]: next });
        return next;
      } finally {
        this.running = undefined;
        this.listeners.clear();
      }
    })();
    return this.running;
  }
}
