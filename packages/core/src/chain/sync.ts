import { fromHex } from '../bytes.js';
import { bestBlockHeight, blockHeaders, masternodeListDiff, type DapiOptions } from './dapi.js';
import { DGW_WINDOW, extend, serializeState, stateFromHeaders, type BlockHeader, type ChainNetwork, type ChainState } from './header.js';
import { PLATFORM_LLMQ, parseCoinbase, verifyDiff, type NodeAddress, type VerifiedQuorum } from './mnlist.js';
import { ChainError, LinkError, toDisplay } from './wire.js';

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

/** The DAPI calls a sync makes, replaceable in tests. */
export interface Dapi {
  bestBlockHeight: typeof bestBlockHeight;
  blockHeaders: typeof blockHeaders;
  masternodeListDiff: typeof masternodeListDiff;
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
  dapi?: Dapi;
}

const RANGE = 2000;
const KEEP_QUORUMS = 64;
const KEEP_HEADERS = 2048;
/** How far below the verified tip the stored chain stays, so a reorg of the last blocks does not strand it. */
export const STORED_DEPTH = 12;
/** A quorum key or node is used only if at least this many proven lists, and a majority of them, hold it. */
export const CORROBORATING_LISTS = 2;
/** Nodes asked for their tip in a round; two of them always come from the bundled seeds. */
const ASK = 6;
const SEEDS_PER_ROUND = 2;
const LISTS_ASKED = 4;
const ROUNDS = 2;

export const SNAPSHOT_VERSION = 1;

/** A copy of `items` in random order (Fisher-Yates). */
export function shuffle<T>(items: readonly T[], random: () => number = Math.random): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

const stateOf = (network: ChainNetwork, from: Checkpoint): ChainState => {
  if (from.network !== network) throw new ChainError('checkpoint is for another network');
  return stateFromHeaders(network, from.height, from.headers.map(fromHex));
};

/** Verified headers by height, newest kept, so a diff's block can be looked up after the chain moved on. */
class Recent {
  private readonly byHeight = new Map<number, BlockHeader>();
  constructor(state: ChainState) {
    this.add(state.window, state.height);
  }
  add(headers: readonly BlockHeader[], lastHeight: number): void {
    headers.forEach((header, i) => this.byHeight.set(lastHeight - headers.length + 1 + i, header));
    for (const height of this.byHeight.keys()) if (height <= lastHeight - KEEP_HEADERS) this.byHeight.delete(height);
  }
  get(height: number): BlockHeader | undefined {
    return this.byHeight.get(height);
  }
  /** The state at `height`, if the headers DGW needs up to it are kept. */
  stateAt(network: ChainNetwork, height: number): ChainState | undefined {
    const window: BlockHeader[] = [];
    for (let h = height - DGW_WINDOW + 1; h <= height; h++) {
      const header = this.byHeight.get(h);
      if (!header) return undefined;
      window.push(header);
    }
    return { network, height, window };
  }
}

interface ProvenList {
  node: NodeAddress;
  height: number;
  blockHash: string;
  quorums: VerifiedQuorum[];
  nodes?: NodeAddress[];
}

interface Tip {
  node: NodeAddress;
  height: number;
}

const quorumId = (q: VerifiedQuorum): string => `${q.llmqType}:${q.quorumHash}:${q.publicKey}`;

/**
 * The order nodes are asked in: each round of `ASK` takes `SEEDS_PER_ROUND` from the bundled seeds
 * and the rest from the stored list, so a stale or captured stored list cannot lock a browser out.
 */
export function nodeOrder(options: Pick<SyncOptions, 'seeds' | 'random'>, previous: Pick<ChainSnapshot, 'nodes'> | undefined): NodeAddress[] {
  const seeds = shuffle(options.seeds, options.random);
  const stored = previous && previous.nodes.length >= 8 ? shuffle(previous.nodes.filter((node) => !options.seeds.includes(node)), options.random) : [];
  const out: NodeAddress[] = [];
  while (stored.length > 0 || seeds.length > 0) {
    out.push(...seeds.splice(0, stored.length > 0 ? SEEDS_PER_ROUND : ASK), ...stored.splice(0, ASK - SEEDS_PER_ROUND));
  }
  return [...new Set(out)];
}

/** Keeps what a majority of the lists, and at least `CORROBORATING_LISTS` of them, hold. */
export function agreed<T>(lists: T[][], id: (item: T) => string): T[] {
  const need = Math.max(CORROBORATING_LISTS, Math.floor(lists.length / 2) + 1);
  const counts = new Map<string, number>();
  for (const list of lists) for (const key of new Set(list.map(id))) counts.set(key, (counts.get(key) ?? 0) + 1);
  const seen = new Set<string>();
  return lists.flat().filter((item) => {
    const key = id(item);
    if ((counts.get(key) ?? 0) < need || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * One attempt from `start`. Nodes are untrusted:
 * - a node is asked for headers only up to the height it claims (its reported tip, or the block of a
 *   list it sent), is moved to the back after a timeout or a short answer, and is dropped only for
 *   data that breaks the rules, so one node can neither get honest ones dropped nor stall the sync;
 * - lists come from up to `LISTS_ASKED` nodes picked at random, not by the tip they claim, and a
 *   quorum key or node is used only if a majority of the proven lists hold it;
 * - the chain is stored `STORED_DEPTH` blocks below the tip.
 * Throws a `LinkError` if the nodes' headers do not follow `start`: the stored chain is stranded.
 */
async function syncFrom(options: SyncOptions, start: ChainState, previous: ChainSnapshot | undefined): Promise<ChainSnapshot> {
  const dapi = options.dapi ?? { bestBlockHeight, blockHeaders, masternodeListDiff };
  const progress = options.onProgress ?? (() => undefined);
  const pool = nodeOrder(options, previous);
  if (pool.length < CORROBORATING_LISTS) throw new ChainError('not enough nodes to ask');
  let state = start;
  const recent = new Recent(state);
  const tips: Tip[] = [];
  const invalid = new Set<string>();
  const listed = new Set<string>();
  const lists: ProvenList[] = [];
  const errors: string[] = [];
  let unlinked = 0;
  const usable = (): Tip[] => tips.filter((tip) => !invalid.has(tip.node));
  const demote = (tip: Tip): void => {
    tips.splice(tips.indexOf(tip), 1);
    tips.push(tip);
  };

  /** Extends the verified chain toward `target` as far as nodes that claim those heights serve valid headers. */
  const extendTo = async (target: number): Promise<void> => {
    while (state.height < target) {
      const from = state.height + 1;
      const to = Math.min(state.height + RANGE, target);
      let extended = false;
      for (const tip of usable().filter((candidate) => candidate.height >= to)) {
        let raws: Uint8Array[];
        try {
          progress(`Verifying block headers ${from}–${to}`);
          raws = await dapi.blockHeaders(tip.node, from, to - from + 1, options);
        } catch {
          demote(tip);
          continue;
        }
        if (raws.length !== to - from + 1) {
          demote(tip);
          continue;
        }
        try {
          const result = extend(state, raws);
          state = result.state;
          recent.add(result.headers, state.height);
          extended = true;
          break;
        } catch (error) {
          invalid.add(tip.node);
          if (error instanceof LinkError && from === start.height + 1) unlinked++;
          progress(`${tip.node} sent invalid headers: ${(error as Error).message}`);
        }
      }
      if (!extended) return;
    }
  };

  for (let round = 0; round < ROUNDS && lists.length < CORROBORATING_LISTS; round++) {
    const asked = pool.slice(round * ASK, (round + 1) * ASK);
    if (asked.length === 0) break;
    progress(`Asking ${asked.length} nodes for the chain tip`);
    const answers = await Promise.allSettled(asked.map(async (node) => ({ node, height: await dapi.bestBlockHeight(node, options) })));
    for (const answer of answers) if (answer.status === 'fulfilled') tips.push(answer.value);
    if (tips.length === 0) continue;
    await extendTo(Math.max(...usable().map((tip) => tip.height), state.height));

    progress('Proving the masternode lists and quorum keys');
    const picked = shuffle(usable().filter((tip) => !listed.has(tip.node)), options.random).slice(0, LISTS_ASKED - lists.length);
    const diffs = await Promise.all(
      picked.map(async (tip) => {
        listed.add(tip.node);
        try {
          return { tip, diff: await dapi.masternodeListDiff(tip.node, options) };
        } catch (error) {
          demote(tip);
          errors.push(`${tip.node}: ${(error as Error).message}`);
          return undefined;
        }
      }),
    );
    for (const fetched of diffs) {
      if (!fetched) continue;
      const { tip, diff } = fetched;
      let height: number;
      try {
        height = parseCoinbase(fromHex(diff.cbTx)).height;
      } catch (error) {
        invalid.add(tip.node);
        errors.push(`${tip.node}: ${(error as Error).message}`);
        continue;
      }
      // The node holds the list's block, which may be newer than the tip it reported a moment ago.
      tip.height = Math.max(tip.height, height);
      if (height > state.height) await extendTo(height);
      const header = recent.get(height);
      if (!header || toDisplay(header.hash) !== diff.blockHash.toLowerCase()) {
        errors.push(`${tip.node}: its list's block ${diff.blockHash} is not at height ${height} of the verified chain`);
        continue;
      }
      try {
        const list = verifyDiff(diff, header.merkleRoot);
        const quorums = list.quorums.filter((q) => q.llmqType === PLATFORM_LLMQ[options.network]);
        lists.push({ node: tip.node, height, blockHash: list.blockHash, quorums, ...(list.nodes ? { nodes: list.nodes } : {}) });
      } catch (error) {
        invalid.add(tip.node);
        errors.push(`${tip.node}: ${(error as Error).message}`);
      }
    }
  }
  if (lists.length < CORROBORATING_LISTS) {
    const message = `${lists.length} of the ${CORROBORATING_LISTS} masternode lists needed checked out${errors.length ? `: ${errors.join('; ')}` : ''}`;
    throw state.height === start.height && unlinked >= CORROBORATING_LISTS ? new LinkError(message) : new ChainError(message);
  }

  const quorums = agreed(lists.map((list) => list.quorums), quorumId);
  if (quorums.length === 0) throw new ChainError('the masternode lists share no Platform quorum');
  const oldest = lists.reduce((low, list) => (list.height < low.height ? list : low));
  const current = new Set(quorums.map((q) => q.quorumHash));
  const kept = (previous?.quorums ?? []).filter((q) => !current.has(q.quorumHash));
  const nodeLists = lists.flatMap((list) => (list.nodes && list.nodes.length > 0 ? [list.nodes] : []));
  const nodes = nodeLists.length >= CORROBORATING_LISTS ? agreed(nodeLists, (node) => node) : [];
  const stored = state.height - STORED_DEPTH > start.height ? recent.stateAt(options.network, state.height - STORED_DEPTH) : undefined;
  return {
    version: SNAPSHOT_VERSION,
    network: options.network,
    chain: serializeState(stored ?? start),
    listHeight: oldest.height,
    listBlockHash: oldest.blockHash,
    quorums: [...quorums.map((q) => ({ ...q, provenAt: oldest.height })), ...kept].slice(0, KEEP_QUORUMS),
    nodes: nodes.length >= 8 ? nodes : previous && previous.nodes.length > 0 ? previous.nodes : [...options.seeds],
    syncedAt: Date.now(),
  };
}

/**
 * Brings the verified chain to the tip nodes report, and proves the Platform quorums and the
 * masternode list at blocks of that chain. Starts from the previous snapshot's chain, and from the
 * bundled checkpoint only if nodes' headers do not follow it (it was on a branch the network left).
 */
export async function syncChain(options: SyncOptions): Promise<ChainSnapshot> {
  const previous = options.previous?.network === options.network ? options.previous : undefined;
  const fromCheckpoint = (from: ChainSnapshot | undefined): Promise<ChainSnapshot> => syncFrom(options, stateOf(options.network, options.checkpoint), from);
  if (!previous || previous.chain.height <= options.checkpoint.height) return fromCheckpoint(previous);
  try {
    return await syncFrom(options, stateOf(options.network, previous.chain), previous);
  } catch (error) {
    if (!(error instanceof LinkError)) throw error;
    options.onProgress?.(`Starting again from the checkpoint: ${error.message}`);
    // What the stranded chain proved belongs to a branch the network left: its keys and nodes go too.
    return fromCheckpoint(undefined);
  }
}
