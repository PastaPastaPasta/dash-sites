import { sha256 as nobleSha256 } from '@noble/hashes/sha2';

const HEX = /^[0-9a-f]*$/;

export function sha256(data: Uint8Array): Uint8Array {
  return nobleSha256(data);
}

export function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

export function fromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !HEX.test(hex)) throw new Error('invalid hex');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function sha256Hex(data: Uint8Array): string {
  return toHex(sha256(data));
}

export function isHash(value: unknown): value is string {
  return typeof value === 'string' && value.length === 64 && HEX.test(value);
}

export function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

export const utf8 = {
  encode: (s: string): Uint8Array => new TextEncoder().encode(s),
  decode: (b: Uint8Array): string => new TextDecoder('utf-8', { fatal: true }).decode(b),
};
