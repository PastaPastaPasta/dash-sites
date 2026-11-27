import x11 from '@dashevo/x11-hash-js';
import { toHex } from '../bytes.js';
import { ChainError, Reader, equalBytes, toDisplay } from './wire.js';

export type ChainNetwork = 'mainnet' | 'testnet';

export interface BlockHeader {
  version: number;
  prevHash: Uint8Array;
  merkleRoot: Uint8Array;
  time: number;
  bits: number;
  nonce: number;
  /** X11 of the 80 bytes, in internal byte order. */
  hash: Uint8Array;
  raw: Uint8Array;
}

export const HEADER_SIZE = 80;
/** Blocks DarkGravityWave looks back over. A state keeps this many headers, which also covers median time past. */
export const DGW_WINDOW = 24;
const MEDIAN_SPAN = 11;
const TARGET_SPACING = 150;
const MAX_FUTURE_SECONDS = 2 * 60 * 60;
const POW_LIMIT = (1n << 236n) - 1n;

export function parseHeader(raw: Uint8Array): BlockHeader {
  if (raw.length !== HEADER_SIZE) throw new ChainError(`a block header is ${HEADER_SIZE} bytes, got ${raw.length}`);
  const reader = new Reader(raw);
  const version = reader.u32();
  const prevHash = reader.bytes(32);
  const merkleRoot = reader.bytes(32);
  const time = reader.u32();
  const bits = reader.u32();
  const nonce = reader.u32();
  return { version, prevHash, merkleRoot, time, bits, nonce, hash: Uint8Array.from(x11.digest(Array.from(raw), 1, 1)), raw };
}

const littleEndian = (bytes: Uint8Array): bigint => {
  let value = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) value = (value << 8n) | BigInt(bytes[i] as number);
  return value;
};

/** The target a compact `nBits` stands for. Negative or overflowing encodings are invalid. */
export function targetFromBits(bits: number): bigint {
  const size = bits >>> 24;
  let word = BigInt(bits & 0x007fffff);
  if (bits & 0x00800000 && word !== 0n) throw new ChainError('negative difficulty target');
  if (word !== 0n && (size > 34 || (word > 0xffn && size > 33) || (word > 0xffffn && size > 32))) throw new ChainError('difficulty target overflows');
  if (size <= 3) return word >> BigInt(8 * (3 - size));
  word <<= BigInt(8 * (size - 3));
  return word;
}

export function bitsFromTarget(target: bigint): number {
  let size = target === 0n ? 0 : Math.ceil(target.toString(16).length / 2);
  let compact = size <= 3 ? Number(target << BigInt(8 * (3 - size))) : Number(target >> BigInt(8 * (size - 3)));
  if (compact & 0x00800000) {
    compact >>>= 8;
    size += 1;
  }
  return (compact | (size << 24)) >>> 0;
}

/** Chain work a header adds, as Core counts it. */
export const workOf = (bits: number): bigint => {
  const target = targetFromBits(bits);
  return (~target & ((1n << 256n) - 1n)) / (target + 1n) + 1n;
};

/** Dash's DarkGravityWave v3 over the last 24 headers, oldest first, with the testnet minimum-difficulty rules. */
export function nextBits(window: readonly BlockHeader[], time: number, network: ChainNetwork): number {
  if (window.length !== DGW_WINDOW) throw new ChainError(`difficulty needs the last ${DGW_WINDOW} headers`);
  const last = window[window.length - 1] as BlockHeader;
  const limit = bitsFromTarget(POW_LIMIT);
  if (network === 'testnet') {
    if (time > last.time + 2 * 60 * 60) return limit;
    if (time > last.time + TARGET_SPACING * 4) {
      const relaxed = targetFromBits(last.bits) * 10n;
      return relaxed > POW_LIMIT ? limit : bitsFromTarget(relaxed);
    }
  }
  let average = 0n;
  for (let count = 1; count <= DGW_WINDOW; count++) {
    const target = targetFromBits((window[DGW_WINDOW - count] as BlockHeader).bits);
    average = count === 1 ? target : (average * BigInt(count) + target) / BigInt(count + 1);
  }
  const span = DGW_WINDOW * TARGET_SPACING;
  const actual = Math.min(Math.max(last.time - (window[0] as BlockHeader).time, Math.trunc(span / 3)), span * 3);
  let next = (average * BigInt(actual)) / BigInt(span);
  if (next > POW_LIMIT) next = POW_LIMIT;
  return bitsFromTarget(next);
}

/** A verified chain position: the height of the last header and the headers DGW needs to extend it. */
export interface ChainState {
  network: ChainNetwork;
  height: number;
  /** The last `DGW_WINDOW` headers, oldest first. */
  window: BlockHeader[];
}

export const tipOf = (state: ChainState): BlockHeader => state.window[state.window.length - 1] as BlockHeader;

export function stateFromHeaders(network: ChainNetwork, height: number, raws: readonly Uint8Array[]): ChainState {
  if (raws.length !== DGW_WINDOW) throw new ChainError(`a checkpoint holds ${DGW_WINDOW} headers`);
  const window = raws.map(parseHeader);
  for (let i = 1; i < window.length; i++) {
    if (!equalBytes((window[i] as BlockHeader).prevHash, (window[i - 1] as BlockHeader).hash)) throw new ChainError('checkpoint headers do not link');
  }
  return { network, height, window };
}

/**
 * Extends a verified state with headers that must follow it directly. Each header must link to the
 * one before, carry exactly the difficulty DGW requires, meet it with its X11 hash, and keep
 * timestamps after the median of the previous eleven and less than two hours ahead of now.
 * Returns the new state and the accepted headers.
 */
export function extend(state: ChainState, raws: readonly Uint8Array[], nowSeconds = Math.floor(Date.now() / 1000)): { state: ChainState; headers: BlockHeader[]; work: bigint } {
  const window = [...state.window];
  let height = state.height;
  let work = 0n;
  const headers: BlockHeader[] = [];
  for (const raw of raws) {
    const header = parseHeader(raw);
    const previous = window[window.length - 1] as BlockHeader;
    if (!equalBytes(header.prevHash, previous.hash)) throw new ChainError(`header ${height + 1} does not follow ${toDisplay(previous.hash)}`);
    const expected = nextBits(window, header.time, state.network);
    if (header.bits !== expected) throw new ChainError(`header ${height + 1} has difficulty ${header.bits.toString(16)}, DGW requires ${expected.toString(16)}`);
    if (littleEndian(header.hash) > targetFromBits(header.bits)) throw new ChainError(`header ${height + 1} does not meet its proof of work`);
    const times = window.slice(-MEDIAN_SPAN).map((h) => h.time).sort((a, b) => a - b);
    if (header.time <= (times[Math.floor(times.length / 2)] as number)) throw new ChainError(`header ${height + 1} is older than the median of the previous ${MEDIAN_SPAN}`);
    if (header.time > nowSeconds + MAX_FUTURE_SECONDS) throw new ChainError(`header ${height + 1} is from the future`);
    window.push(header);
    window.shift();
    height += 1;
    work += workOf(header.bits);
    headers.push(header);
  }
  return { state: { network: state.network, height, window }, headers, work };
}

export const serializeState = (state: ChainState): { network: ChainNetwork; height: number; headers: string[] } => ({
  network: state.network,
  height: state.height,
  headers: state.window.map((h) => toHex(h.raw)),
});
