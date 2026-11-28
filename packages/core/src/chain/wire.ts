import { concat, fromHex, sha256, toHex } from '../bytes.js';

export class ChainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChainError';
  }
}

/** Headers that do not link to the chain they should extend: the sender is on another branch, or the stored chain is. */
export class LinkError extends ChainError {
  constructor(message: string) {
    super(message);
    this.name = 'LinkError';
  }
}

export const sha256d = (data: Uint8Array): Uint8Array => sha256(sha256(data));

/** A hash as Core prints it (byte-reversed hex) to its internal byte order, and back. */
export const fromDisplay = (hex: string): Uint8Array => {
  if (!/^[0-9a-f]{64}$/i.test(hex)) throw new ChainError(`not a 32-byte hash: ${hex.slice(0, 80)}`);
  return fromHex(hex.toLowerCase()).reverse();
};
export const toDisplay = (hash: Uint8Array): string => toHex(Uint8Array.from(hash).reverse());

export function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return (a[i] as number) - (b[i] as number);
  return a.length - b.length;
}

export const equalBytes = (a: Uint8Array, b: Uint8Array): boolean => compareBytes(a, b) === 0;

/** Bitcoin's merkle root: pairs hashed with sha256d, the last of an odd level paired with itself. */
export function merkleRoot(leaves: Uint8Array[]): Uint8Array {
  if (leaves.length === 0) return new Uint8Array(32);
  let level = leaves;
  while (level.length > 1) {
    const next: Uint8Array[] = [];
    for (let i = 0; i < level.length; i += 2) next.push(sha256d(concat([level[i] as Uint8Array, (level[i + 1] ?? level[i]) as Uint8Array])));
    level = next;
  }
  return level[0] as Uint8Array;
}

export class Reader {
  private offset = 0;
  private readonly view: DataView;
  constructor(private readonly data: Uint8Array) {
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  }
  get done(): boolean {
    return this.offset === this.data.length;
  }
  get position(): number {
    return this.offset;
  }
  private need(n: number): void {
    if (this.offset + n > this.data.length) throw new ChainError('truncated data');
  }
  u8(): number {
    this.need(1);
    return this.view.getUint8(this.offset++);
  }
  u16(): number {
    this.need(2);
    const value = this.view.getUint16(this.offset, true);
    this.offset += 2;
    return value;
  }
  u32(): number {
    this.need(4);
    const value = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return value;
  }
  bytes(n: number): Uint8Array {
    this.need(n);
    const out = this.data.subarray(this.offset, this.offset + n);
    this.offset += n;
    return out;
  }
  compactSize(): number {
    const first = this.u8();
    if (first < 253) return first;
    if (first === 253) return this.u16();
    if (first === 254) return this.u32();
    const low = this.u32();
    const high = this.u32();
    if (high !== 0) throw new ChainError('compact size too large');
    return low;
  }
  varBytes(max = 1 << 20): Uint8Array {
    const n = this.compactSize();
    if (n > max) throw new ChainError('field too large');
    return this.bytes(n);
  }
}

export class Writer {
  private readonly parts: Uint8Array[] = [];
  u8(value: number): this {
    this.parts.push(Uint8Array.of(value & 0xff));
    return this;
  }
  u16(value: number): this {
    this.parts.push(Uint8Array.of(value & 0xff, (value >> 8) & 0xff));
    return this;
  }
  u16be(value: number): this {
    this.parts.push(Uint8Array.of((value >> 8) & 0xff, value & 0xff));
    return this;
  }
  compactSize(value: number): this {
    if (value < 253) return this.u8(value);
    if (value <= 0xffff) return this.u8(253).u16(value);
    throw new ChainError('compact size too large');
  }
  bytes(data: Uint8Array): this {
    this.parts.push(data);
    return this;
  }
  finish(): Uint8Array {
    return concat(this.parts);
  }
}
