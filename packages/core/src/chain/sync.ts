import { fromHex } from '../bytes.js';
import { bestBlockHeight, blockHeaders, masternodeListDiff, type DapiOptions } from './dapi.js';
import { DGW_WINDOW, extend, parseHeader, serializeState, stateFromHeaders, type BlockHeader, type ChainNetwork, type ChainState } from './header.js';
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
/** Masternode lists from this many different nodes must agree on a quorum key or a node before it is used. */
export const CORROBORATING_LISTS = 2;
const ASK = 6;

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
  quorums: VerifiedQuorum[];
  nodes?: NodeAddress[];
}

const quorumId = (q: VerifiedQuorum): string => `${q.llmqType}:${q.quorumHash}:${q.publicKey}`;

/**
 * One attempt from `start`. Nodes are untrusted:
 * - a node is only asked for headers up to the tip it reported, and is dropped only for data that
 *   breaks the rules (a header that does not link or lacks its work, a list that does not hash),
 *   never for being slow or short, so one node cannot get honest ones dropped;
 * - a quorum key or node is used only if masternode lists from two different nodes, each proven
 *   against a block of the verified chain, both hold it, so one node that mines a block of its own
 *   cannot slip a key in;
 * - the chain is stored `STORED_DEPTH` blocks below the tip.
 */
async function syncFrom(options: SyncOptions, start: ChainState, previous: ChainSnapshot | undefined): Promise<ChainSnapshot> {
  const dapi = options.dapi ?? { bestBlockHeight, blockHeaders, masternodeListDiff };
  const progress = options.onProgress ?? (() => undefined);
  const pool = shuffle(previous && previous.nodes.length >= 8 ? previous.nodes : options.seeds, options.random);
  if (pool.length < CORROBORATING_LISTS) throw new ChainError('not enough nodes to ask');
  let state = start;
  const recent = new Recent(state);
  const invalid = new Set<string>();

  const asked = pool.slice(0, options.ask ?? ASK);
  progress(`Asking ${asked.length} nodes for the chain tip`);
  const tips = (await Promise.allSettled(asked.map(async (node) => ({ node, height: await dapi.bestBlockHeight(node, options) }))))
    .flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []))
    .sort((a, b) => b.height - a.height);
  if (tips.length === 0) throw new ChainError('no node answered with its chain tip');

  /** Extends the verified chain toward `target` as far as nodes that claim those heights serve valid headers. */
  const extendTo = async (target: number): Promise<void> => {
    while (state.height < target) {
      const from = state.height + 1;
      const to = Math.min(state.height + RANGE, target);
      let extended = false;
      for (const { node } of tips.filter((tip) => tip.height >= to && !invalid.has(tip.node))) {
        let raws: Uint8Array[];
        try {
          progress(`Verifying block headers ${from}–${to}`);
          raws = await dapi.blockHeaders(node, from, to - from + 1, options);
        } catch {
          continue;
        }
        if (raws.length !== to - from + 1) continue;
        try {
          const result = extend(state, raws);
          state = result.state;
          recent.add(result.headers, state.height);
          extended = true;
          break;
        } catch (error) {
          invalid.add(node);
          progress(`${node} sent invalid headers: ${(error as Error).message}`);
        }
      }
      if (!extended) return;
    }
  };

  await extendTo(tips[0]?.height ?? state.height);

  progress('Proving the masternode list and quorum keys');
  const lists: ProvenList[] = [];
  const errors: string[] = [];
  for (const { node } of tips) {
    if (lists.length >= CORROBORATING_LISTS) break;
    if (invalid.has(node)) continue;
    try {
      const diff = await dapi.masternodeListDiff(node, options);
      const height = parseCoinbase(fromHex(diff.cbTx)).height;
      if (height > state.height) await extendTo(height);
      const header = recent.get(height);
      if (!header || toDisplay(header.hash) !== diff.blockHash.toLowerCase()) throw new ChainError(`its list's block ${diff.blockHash} is not at height ${height} of the verified chain`);
      const list = verifyDiff(diff, header.merkleRoot);
      const quorums = list.quorums.filter((q) => q.llmqType === PLATFORM_LLMQ[options.network]);
      lists.push({ node, height, quorums, ...(list.nodes ? { nodes: list.nodes } : {}) });
    } catch (error) {
      if (error instanceof ChainError && /does not match|not in the block|states another/.test(error.message)) invalid.add(node);
      errors.push(`${node}: ${(error as Error).message}`);
    }
  }
  if (lists.length < CORROBORATING_LISTS) throw new ChainError(`${lists.length} of the ${CORROBORATING_LISTS} masternode lists needed checked out${errors.length ? `: ${errors.join('; ')}` : ''}`);

  const counts = new Map<string, number>();
  for (const list of lists) for (const id of new Set(list.quorums.map(quorumId))) counts.set(id, (counts.get(id) ?? 0) + 1);
  const listHeight = Math.min(...lists.map((list) => list.height));
  const agreed = (lists[0] as ProvenList).quorums.filter((q) => counts.get(quorumId(q)) === lists.length);
  if (agreed.length === 0) throw new ChainError('the masternode lists share no Platform quorum');
  const current = new Set(agreed.map((q) => q.quorumHash));
  const kept = (previous?.quorums ?? []).filter((q) => !current.has(q.quorumHash));
  const nodeLists = lists.map((list) => list.nodes);
  const sharedNodes = nodeLists.every((nodes) => nodes && nodes.length > 0)
    ? (nodeLists[0] as NodeAddress[]).filter((node) => nodeLists.every((nodes) => (nodes as NodeAddress[]).includes(node)))
    : [];
  const stored = state.height - STORED_DEPTH > start.height ? recent.stateAt(options.network, state.height - STORED_DEPTH) : undefined;
  return {
    version: SNAPSHOT_VERSION,
    network: options.network,
    chain: serializeState(stored ?? start),
    listHeight,
    listBlockHash: toDisplay((recent.get(listHeight) as BlockHeader).hash),
    quorums: [...agreed.map((q) => ({ ...q, provenAt: listHeight })), ...kept].slice(0, KEEP_QUORUMS),
    nodes: sharedNodes.length >= 8 ? sharedNodes : (previous?.nodes ?? [...options.seeds]),
    syncedAt: Date.now(),
  };
}

/**
 * Brings the verified chain to the tip nodes report, and proves the Platform quorums and the
 * masternode list at blocks of that chain. Starts from the previous snapshot's chain, and from the
 * bundled checkpoint if that fails (the stored chain may be on a branch the network left).
 */
export async function syncChain(options: SyncOptions): Promise<ChainSnapshot> {
  const previous = options.previous?.network === options.network ? options.previous : undefined;
  const fromCheckpoint = (): Promise<ChainSnapshot> => syncFrom(options, stateOf(options.network, options.checkpoint), previous);
  if (!previous || previous.chain.height <= options.checkpoint.height) return fromCheckpoint();
  try {
    return await syncFrom(options, stateOf(options.network, previous.chain), previous);
  } catch (error) {
    options.onProgress?.(`Starting again from the checkpoint: ${(error as Error).message}`);
    return fromCheckpoint();
  }
}

/** The tip of a snapshot's chain, for display. */
export const snapshotTip = (snapshot: ChainSnapshot): { height: number; hash: string; time: number } => {
  const header = parseHeader(fromHex(snapshot.chain.headers[snapshot.chain.headers.length - 1] as string));
  return { height: snapshot.chain.height, hash: toDisplay(header.hash), time: header.time };
};
