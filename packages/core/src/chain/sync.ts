import { fromHex } from '../bytes.js';
import { bestBlockHeight, blockHeaders, masternodeListDiff, type DapiOptions } from './dapi.js';
import { extend, parseHeader, serializeState, stateFromHeaders, type BlockHeader, type ChainNetwork, type ChainState } from './header.js';
import { PLATFORM_LLMQ, parseCoinbase, verifyDiff, type NodeAddress, type VerifiedQuorum } from './mnlist.js';
import { ChainError, toDisplay } from './wire.js';

export interface Checkpoint {
  network: ChainNetwork;
  /** Height of the last header. */
  height: number;
  /** The last 24 headers up to and including `height`, hex. */
  headers: string[];
}

export interface StoredQuorum extends VerifiedQuorum {
  /** Core height of the list it was last proven in. */
  provenAt: number;
}

/** What a sync proved, kept between sessions so the next one starts from it. */
export interface ChainSnapshot {
  version: 1;
  network: ChainNetwork;
  /** The verified header chain's tip and the headers DGW needs to extend it. */
  chain: Checkpoint;
  /** Block whose masternode list the quorums come from. */
  listHeight: number;
  listBlockHash: string;
  /** Platform quorums of the latest list first, then older ones still kept. */
  quorums: StoredQuorum[];
  /** Platform endpoints from the chain-verified masternode list. */
  nodes: NodeAddress[];
  /** Wall-clock time of the sync, ms. */
  syncedAt: number;
}

export interface SyncOptions extends DapiOptions {
  network: ChainNetwork;
  checkpoint: Checkpoint;
  /** Nodes to ask when the snapshot has none: the bundled seeds. */
  seeds: readonly NodeAddress[];
  previous?: ChainSnapshot;
  /** Nodes asked for their tip at once. */
  ask?: number;
  onProgress?: (message: string) => void;
  random?: () => number;
}

const RANGE = 2000;
const KEEP_QUORUMS = 64;
const KEEP_HEADERS = 2048;

export const SNAPSHOT_VERSION = 1;

function shuffle<T>(items: readonly T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

const startState = (options: SyncOptions): ChainState => {
  const from = options.previous?.network === options.network && options.previous.chain.height >= options.checkpoint.height ? options.previous.chain : options.checkpoint;
  if (from.network !== options.network) throw new ChainError('checkpoint is for another network');
  return stateFromHeaders(options.network, from.height, from.headers.map(fromHex));
};

/** Verified headers by height, newest kept, so a diff's block can be looked up after the chain moved on. */
class Recent {
  private readonly byHeight = new Map<number, BlockHeader>();
  constructor(state: ChainState) {
    state.window.forEach((header, i) => this.byHeight.set(state.height - state.window.length + 1 + i, header));
  }
  add(headers: readonly BlockHeader[], lastHeight: number): void {
    headers.forEach((header, i) => this.byHeight.set(lastHeight - headers.length + 1 + i, header));
    for (const height of this.byHeight.keys()) if (height <= lastHeight - KEEP_HEADERS) this.byHeight.delete(height);
  }
  get(height: number): BlockHeader | undefined {
    return this.byHeight.get(height);
  }
}

/**
 * Brings the verified chain to the tip some node reports, and proves the Platform quorums and the
 * masternode list at a block of that chain. Nodes are untrusted: a header that breaks the rules or
 * a list that does not hash to its block's coinbase fails the node, and another is tried.
 */
export async function syncChain(options: SyncOptions): Promise<ChainSnapshot> {
  const random = options.random ?? Math.random;
  const progress = options.onProgress ?? (() => undefined);
  const pool = shuffle(options.previous?.network === options.network && options.previous.nodes.length >= 8 ? options.previous.nodes : options.seeds, random);
  if (pool.length === 0) throw new ChainError('no nodes to ask');
  let state = startState(options);
  const recent = new Recent(state);
  const failed = new Set<string>();

  const asked = pool.slice(0, options.ask ?? 4);
  progress(`Asking ${asked.length} nodes for the chain tip`);
  const tips = (await Promise.allSettled(asked.map(async (node) => ({ node, height: await bestBlockHeight(node, options) }))))
    .flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []))
    .sort((a, b) => b.height - a.height);
  if (tips.length === 0) throw new ChainError('no node answered with its chain tip');

  /** Extends the chain to `target`, fetching ranges from the nodes that answered, in order. */
  const extendTo = async (target: number, nodes: string[]): Promise<void> => {
    while (state.height < target) {
      const from = state.height + 1;
      const count = Math.min(RANGE, target - state.height);
      let done = false;
      for (const node of nodes) {
        if (failed.has(node)) continue;
        try {
          progress(`Verifying block headers ${from}–${from + count - 1} of ${target}`);
          const raws = await blockHeaders(node, from, count, options);
          const result = extend(state, raws);
          state = result.state;
          recent.add(result.headers, state.height);
          done = true;
          break;
        } catch (error) {
          failed.add(node);
          progress(`${node} failed: ${(error as Error).message}`);
        }
      }
      if (!done) throw new ChainError(`no node served valid headers from ${from}`);
    }
  };

  const errors: string[] = [];
  for (const { node, height } of tips) {
    if (failed.has(node)) continue;
    try {
      if (height < state.height) throw new ChainError(`tip ${height} is behind the verified chain at ${state.height}`);
      await extendTo(height, [node, ...tips.map((t) => t.node).filter((n) => n !== node)]);
      progress('Proving the masternode list and quorum keys');
      const diff = await masternodeListDiff(node, options);
      const claimed = parseCoinbase(fromHex(diff.cbTx)).height;
      if (claimed > state.height) await extendTo(claimed, [node]);
      const header = recent.get(claimed);
      if (!header || toDisplay(header.hash) !== diff.blockHash.toLowerCase()) throw new ChainError(`the list's block ${diff.blockHash} is not at height ${claimed} of the verified chain`);
      const list = verifyDiff(diff, header.merkleRoot);
      const platform = list.quorums.filter((q) => q.llmqType === PLATFORM_LLMQ[options.network]);
      if (platform.length === 0) throw new ChainError('the list has no Platform quorums');
      const current = new Set(platform.map((q) => q.quorumHash));
      const kept = (options.previous?.network === options.network ? options.previous.quorums : []).filter((q) => !current.has(q.quorumHash));
      return {
        version: SNAPSHOT_VERSION,
        network: options.network,
        chain: serializeState(state),
        listHeight: claimed,
        listBlockHash: list.blockHash,
        quorums: [...platform.map((q) => ({ ...q, provenAt: claimed })), ...kept].slice(0, KEEP_QUORUMS),
        nodes: list.nodes && list.nodes.length > 0 ? list.nodes : (options.previous?.nodes ?? [...options.seeds]),
        syncedAt: Date.now(),
      };
    } catch (error) {
      failed.add(node);
      errors.push(`${node}: ${(error as Error).message}`);
    }
  }
  throw new ChainError(`could not prove the quorum keys: ${errors.join('; ')}`);
}

/** The tip of a snapshot's chain, for display. */
export const snapshotTip = (snapshot: ChainSnapshot): { height: number; hash: string; time: number } => {
  const header = parseHeader(fromHex(snapshot.chain.headers[snapshot.chain.headers.length - 1] as string));
  return { height: snapshot.chain.height, hash: toDisplay(header.hash), time: header.time };
};
