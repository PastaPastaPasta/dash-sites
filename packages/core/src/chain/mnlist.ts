import { base58check } from '@scure/base';
import { fromHex, sha256 } from '../bytes.js';
import type { ChainNetwork } from './header.js';
import { ChainError, Reader, Writer, compareBytes, equalBytes, fromDisplay, merkleRoot, sha256d, toDisplay } from './wire.js';

/** The LLMQ type whose quorums sign Platform state on each network. */
export const PLATFORM_LLMQ: Record<ChainNetwork, number> = { mainnet: 4, testnet: 6 };

/** Member count of each LLMQ type, which a commitment's bitsets are serialized with. */
const LLMQ_SIZE: Record<number, number> = { 1: 50, 2: 400, 3: 400, 4: 100, 5: 60, 6: 25, 100: 3, 101: 12, 102: 12, 103: 4, 104: 3, 105: 3, 106: 3, 107: 3 };

/** One entry of `protx diff`'s masternode list, as DAPI forwards it. */
export interface MnListEntry {
  nVersion: number;
  nType: number;
  proRegTxHash: string;
  confirmedHash: string;
  service: string;
  addresses?: Record<string, string[]>;
  pubKeyOperator: string;
  votingAddress: string;
  isValid: boolean;
  platformHTTPPort?: number;
  platformNodeID?: string;
}

export interface QuorumCommitment {
  version: number;
  llmqType: number;
  quorumHash: string;
  quorumIndex?: number;
  signersCount: number;
  signers: string;
  validMembersCount: number;
  validMembers: string;
  quorumPublicKey: string;
  quorumVvecHash: string;
  quorumSig: string;
  membersSig: string;
}

export interface MnListDiff {
  baseBlockHash: string;
  blockHash: string;
  cbTxMerkleTree: string;
  cbTx: string;
  mnList: MnListEntry[];
  newQuorums: QuorumCommitment[];
  merkleRootMNList: string;
  merkleRootQuorums: string;
}

export interface VerifiedQuorum {
  llmqType: number;
  quorumHash: string;
  publicKey: string;
  validMembers: number;
}

/** A Platform node a masternode list names, as `https://host:port`. */
export type NodeAddress = string;

export interface VerifiedMnList {
  blockHash: string;
  /** Core height the coinbase states. */
  height: number;
  quorums: VerifiedQuorum[];
  /** HTTPS endpoints of valid evonodes. Undefined if an entry has a form this version cannot hash, so the list is not proven. */
  nodes?: NodeAddress[];
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const hex = (value: unknown, what: string): string => {
  if (typeof value !== 'string' || !/^([0-9a-f]{2})*$/i.test(value)) throw new ChainError(`${what} is not hex`);
  return value.toLowerCase();
};
const sizedHex = (value: unknown, length: number, what: string, error = `${what} has the wrong length`): Uint8Array => {
  const bytes = fromHex(hex(value, what));
  if (bytes.length !== length) throw new ChainError(error);
  return bytes;
};

/** Checks the shape of a diff before anything reads it. Only the fields this module uses are checked. */
export function asDiff(value: unknown): MnListDiff {
  if (!isObject(value)) throw new ChainError('masternode list diff is not an object');
  for (const key of ['baseBlockHash', 'blockHash', 'cbTxMerkleTree', 'cbTx', 'merkleRootMNList', 'merkleRootQuorums']) hex(value[key], key);
  if (!Array.isArray(value.mnList) || !Array.isArray(value.newQuorums)) throw new ChainError('masternode list diff has no lists');
  if (!/^0{64}$/.test(value.baseBlockHash as string)) throw new ChainError('masternode list diff is not from genesis');
  return value as unknown as MnListDiff;
}

const llmqSize = (type: number): number => {
  const size = Number.isInteger(type) ? LLMQ_SIZE[type] : undefined;
  if (size === undefined) throw new ChainError(`unknown LLMQ type ${type}`);
  return size;
};

export function serializeCommitment(q: QuorumCommitment): Uint8Array {
  if (![1, 2, 3, 4].includes(q.version)) throw new ChainError(`unknown quorum commitment version ${String(q.version)}`);
  const size = llmqSize(q.llmqType);
  const bitset = (value: string, what: string): Uint8Array => sizedHex(value, Math.ceil(size / 8), what, `${what} of a type ${q.llmqType} quorum has the wrong length`);
  const w = new Writer().u16(q.version).u8(q.llmqType).bytes(fromDisplay(q.quorumHash));
  if (q.version === 2 || q.version === 4) {
    const index = q.quorumIndex ?? 0;
    w.u16(index < 0 ? index + 0x10000 : index);
  }
  w.compactSize(size).bytes(bitset(q.signers, 'signers')).compactSize(size).bytes(bitset(q.validMembers, 'validMembers'));
  w.bytes(sizedHex(q.quorumPublicKey, 48, 'quorumPublicKey')).bytes(fromDisplay(q.quorumVvecHash));
  return w.bytes(sizedHex(q.quorumSig, 96, 'quorumSig')).bytes(sizedHex(q.membersSig, 96, 'membersSig')).finish();
}

const PURPOSE: Record<string, number> = { core_p2p: 0, platform_p2p: 1, platform_https: 2 };
const ADDRESS = /^(?:\[([0-9a-f:]+)\]|([0-9.]+)):(\d{1,5})$/i;

function ipv4(text: string): Uint8Array | undefined {
  const parts = text.split('.');
  if (parts.length !== 4 || parts.some((p) => !/^\d{1,3}$/.test(p) || Number(p) > 255)) return undefined;
  return Uint8Array.from(parts.map(Number));
}

export function ipv6(text: string): Uint8Array | undefined {
  const halves = text.split('::');
  if (halves.length > 2) return undefined;
  const parse = (part: string): string[] => (part === '' ? [] : part.split(':'));
  const head = parse(halves[0] as string);
  const rest = halves.length === 2 ? parse(halves[1] as string) : [];
  if (halves.length === 2 ? head.length + rest.length > 7 : head.length !== 8) return undefined;
  const groups = [...head, ...Array<string>(8 - head.length - rest.length).fill('0'), ...rest];
  if (groups.some((g) => !/^[0-9a-f]{1,4}$/i.test(g))) return undefined;
  const out = new Uint8Array(16);
  groups.forEach((group, i) => {
    const word = parseInt(group, 16);
    out[i * 2] = word >> 8;
    out[i * 2 + 1] = word & 255;
  });
  return out;
}

function parseAddress(text: string): { v4?: Uint8Array; v6?: Uint8Array; port: number } {
  const match = ADDRESS.exec(text);
  if (!match) throw new ChainError(`unsupported address ${text}`);
  const port = Number(match[3]);
  if (port > 65535) throw new ChainError(`bad port in ${text}`);
  if (match[2] !== undefined) {
    const v4 = ipv4(match[2]);
    if (!v4) throw new ChainError(`bad IPv4 address ${text}`);
    return { v4, port };
  }
  const v6 = ipv6(match[1] as string);
  if (!v6) throw new ChainError(`bad IPv6 address ${text}`);
  return { v6, port };
}

/** CService in the legacy form: 16 bytes of IPv6 (IPv4 mapped) and a big-endian port. */
function legacyService(text: string): Uint8Array {
  const { v4, v6, port } = parseAddress(text);
  const ip = new Uint8Array(16);
  if (v4) ip.set([0xff, 0xff, ...v4], 10);
  else ip.set(v6 as Uint8Array);
  return new Writer().bytes(ip).u16be(port).finish();
}

/** ExtNetInfo version 1: purposes in order, each with BIP155 (addrv2) services. */
function extNetInfo(addresses: Record<string, string[]>): Uint8Array {
  const purposes = Object.keys(addresses).map((key) => {
    const id = PURPOSE[key];
    if (id === undefined) throw new ChainError(`unknown address purpose ${key}`);
    return [id, addresses[key] as string[]] as const;
  });
  purposes.sort((a, b) => a[0] - b[0]);
  const w = new Writer().u8(1).compactSize(purposes.length);
  for (const [id, list] of purposes) {
    w.u8(id).compactSize(list.length);
    for (const text of list) {
      const { v4, v6, port } = parseAddress(text);
      w.u8(0x01);
      if (v4) w.u8(1).compactSize(4).bytes(v4);
      else w.u8(2).compactSize(16).bytes(v6 as Uint8Array);
      w.u16be(port);
    }
  }
  return w.finish();
}

const votingKey = base58check(sha256);

export function serializeEntry(entry: MnListEntry): Uint8Array {
  const w = new Writer().bytes(fromDisplay(entry.proRegTxHash)).bytes(fromDisplay(entry.confirmedHash));
  w.bytes(entry.nVersion >= 3 ? extNetInfo(entry.addresses ?? {}) : legacyService(entry.service));
  const operator = sizedHex(entry.pubKeyOperator, 48, 'pubKeyOperator', 'operator key has the wrong length');
  const voting = votingKey.decode(entry.votingAddress);
  if (voting.length !== 21) throw new ChainError('voting address has the wrong length');
  w.bytes(operator).bytes(voting.subarray(1)).u8(entry.isValid ? 1 : 0);
  if (entry.nVersion >= 2) {
    w.u16(entry.nType);
    if (entry.nType === 1) {
      if (entry.nVersion < 3) w.u16(entry.platformHTTPPort ?? 0);
      w.bytes(sizedHex(entry.platformNodeID, 20, 'platformNodeID', 'platform node id has the wrong length').reverse());
    }
  }
  return w.finish();
}

interface Coinbase {
  txid: Uint8Array;
  height: number;
  merkleRootMNList: Uint8Array;
  merkleRootQuorums: Uint8Array;
}

/** A coinbase special transaction (type 5) and the roots its payload commits to. */
export function parseCoinbase(raw: Uint8Array): Coinbase {
  const r = new Reader(raw);
  const versionWord = r.u32();
  if ((versionWord & 0xffff) < 3 || versionWord >>> 16 !== 5) throw new ChainError('not a coinbase special transaction');
  const inputs = r.compactSize();
  for (let i = 0; i < inputs; i++) {
    r.bytes(36);
    r.varBytes();
    r.u32();
  }
  const outputs = r.compactSize();
  for (let i = 0; i < outputs; i++) {
    r.bytes(8);
    r.varBytes();
  }
  r.u32();
  const payload = new Reader(r.varBytes());
  if (!r.done) throw new ChainError('trailing bytes after the coinbase');
  const version = payload.u16();
  if (version < 2) throw new ChainError('coinbase payload predates quorum roots');
  const height = payload.u32();
  const merkleRootMNList = payload.bytes(32);
  const merkleRootQuorums = payload.bytes(32);
  return { txid: sha256d(raw), height, merkleRootMNList, merkleRootQuorums };
}

/** Root of a CPartialMerkleTree that must prove exactly one transaction, the first: the coinbase. */
export function partialMerkleRoot(raw: Uint8Array, txid: Uint8Array): Uint8Array {
  const r = new Reader(raw);
  const total = r.u32();
  const hashCount = r.compactSize();
  if (total === 0 || total > 1 << 20 || hashCount > total) throw new ChainError('bad partial merkle tree');
  const hashes = Array.from({ length: hashCount }, () => r.bytes(32));
  const flagBytes = r.varBytes(1 << 16);
  if (!r.done) throw new ChainError('trailing bytes after the partial merkle tree');
  const bits: boolean[] = [];
  for (const byte of flagBytes) for (let i = 0; i < 8; i++) bits.push(((byte >> i) & 1) === 1);
  let height = 0;
  while ((total + (1 << height) - 1) >> height > 1) height++;
  const width = (level: number): number => (total + (1 << level) - 1) >> level;
  let bitUsed = 0;
  let hashUsed = 0;
  const matched: number[] = [];
  const walk = (level: number, position: number): Uint8Array => {
    if (bitUsed >= bits.length) throw new ChainError('partial merkle tree runs out of flags');
    const parent = bits[bitUsed++] as boolean;
    if (level === 0 || !parent) {
      if (hashUsed >= hashes.length) throw new ChainError('partial merkle tree runs out of hashes');
      const hash = hashes[hashUsed++] as Uint8Array;
      if (level === 0 && parent) matched.push(position);
      return hash;
    }
    const left = walk(level - 1, position * 2);
    const right = position * 2 + 1 < width(level - 1) ? walk(level - 1, position * 2 + 1) : left;
    if (position * 2 + 1 < width(level - 1) && equalBytes(left, right)) throw new ChainError('partial merkle tree has a duplicate branch');
    return sha256d(new Writer().bytes(left).bytes(right).finish());
  };
  const root = walk(height, 0);
  if (Math.ceil(bitUsed / 8) !== flagBytes.length || hashUsed !== hashes.length) throw new ChainError('partial merkle tree has unused data');
  if (matched.length !== 1 || matched[0] !== 0 || !equalBytes(hashes[0] as Uint8Array, txid)) throw new ChainError('partial merkle tree does not prove the coinbase');
  return root;
}

/**
 * HTTPS endpoints of valid evonodes, from the fields the list's root covers: the extended addresses
 * of version 3 entries, and the service host with the Platform HTTP port before that. The `addresses`
 * Core prints for older entries is derived, not hashed, so it is not read.
 */
function httpsAddresses(entry: MnListEntry): string[] {
  if (entry.nVersion >= 3) return entry.addresses?.platform_https ?? [];
  const host = /^(.*):\d+$/.exec(entry.service)?.[1];
  return host && entry.platformHTTPPort ? [`${host}:${entry.platformHTTPPort}`] : [];
}

function nodeAddresses(entries: readonly MnListEntry[]): NodeAddress[] {
  const out: NodeAddress[] = [];
  for (const entry of entries) {
    // Version 1 entries hash neither the type nor the Platform port.
    if (entry.nVersion < 2 || entry.nType !== 1 || !entry.isValid) continue;
    for (const address of httpsAddresses(entry)) {
      try {
        const parsed = parseAddress(address);
        if (parsed.port === 0 || (parsed.v4 && parsed.v4.every((b) => b === 0)) || (parsed.v6 && parsed.v6.every((b) => b === 0))) continue;
        out.push(`https://${address}`);
      } catch {
        // An address form this version does not know: the node is skipped.
      }
    }
  }
  return out;
}

/** Sorts `entries` by proRegTxHash and returns their merkle root, or undefined if one has a form this version cannot serialize. */
const bitCount = (bytes: Uint8Array): number => bytes.reduce((count, byte) => {
  let bits = byte;
  let n = count;
  while (bits) {
    n += bits & 1;
    bits >>= 1;
  }
  return n;
}, 0);

function mnListRoot(entries: MnListEntry[]): Uint8Array | undefined {
  try {
    entries.sort((a, b) => compareBytes(fromDisplay(a.proRegTxHash), fromDisplay(b.proRegTxHash)));
    return merkleRoot(entries.map((e) => sha256d(serializeEntry(e))));
  } catch (error) {
    if (error instanceof ChainError) return undefined;
    throw error;
  }
}

/**
 * Verifies a full masternode list diff against a block's merkle root: the coinbase must be the
 * block's first transaction, and the quorum list must hash to the root the coinbase commits to.
 * The masternode list is checked against its root too; if it does not match, or holds an entry this
 * version cannot serialize, `nodes` is left out instead of failing: nodes are untrusted in any case,
 * and a new entry format should not stop quorum keys from being proven.
 */
export function verifyDiff(diff: MnListDiff, headerMerkleRoot: Uint8Array): VerifiedMnList {
  const coinbase = parseCoinbase(fromHex(hex(diff.cbTx, 'cbTx')));
  if (!equalBytes(partialMerkleRoot(fromHex(diff.cbTxMerkleTree), coinbase.txid), headerMerkleRoot)) throw new ChainError('the coinbase is not in the block');
  if (toDisplay(coinbase.merkleRootQuorums) !== diff.merkleRootQuorums.toLowerCase()) throw new ChainError('the diff states another quorum root than its coinbase');
  const commitments = diff.newQuorums.map((q) => sha256d(serializeCommitment(q))).sort(compareBytes);
  if (!equalBytes(merkleRoot(commitments), coinbase.merkleRootQuorums)) throw new ChainError('the quorum list does not match the root in the coinbase');
  // The member count comes from the hashed bitset, not the diff's own count.
  const quorums = diff.newQuorums.map((q) => ({ llmqType: q.llmqType, quorumHash: q.quorumHash.toLowerCase(), publicKey: q.quorumPublicKey.toLowerCase(), validMembers: bitCount(fromHex(q.validMembers)) }));
  const entries = [...diff.mnList];
  const listRoot = mnListRoot(entries);
  const nodes = listRoot && equalBytes(listRoot, coinbase.merkleRootMNList) ? nodeAddresses(entries) : undefined;
  return { blockHash: diff.blockHash.toLowerCase(), height: coinbase.height, quorums, ...(nodes ? { nodes } : {}) };
}
