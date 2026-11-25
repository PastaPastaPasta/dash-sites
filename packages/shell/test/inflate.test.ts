import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { brotliCompressSync, constants } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { brotliInflater } from '../src/inflate.js';

const decoder = () => readFileSync(createRequire(import.meta.url).resolve('brotli-dec-wasm/web/bg.wasm'));
const original = Buffer.concat([randomBytes(1 << 20), Buffer.alloc(3 << 20, 7), randomBytes(1 << 19)]);
const packed = brotliCompressSync(original, { params: { [constants.BROTLI_PARAM_QUALITY]: 5, [constants.BROTLI_PARAM_LGWIN]: 24 } });

function inflateIn(chunkSize: number, input = packed) {
  const inflater = brotliInflater(decoder);
  const out: Uint8Array[] = [];
  try {
    for (let at = 0; at < input.length; at += chunkSize) out.push(...inflater.push(input.subarray(at, at + chunkSize), Infinity));
    return { bytes: Buffer.concat(out), done: inflater.done };
  } finally {
    inflater.free();
  }
}

describe('brotli inflater', () => {
  it.each([1 << 10, 64 << 10, 1 << 22])('restores the original from %i-byte pieces', (size) => {
    const { bytes, done } = inflateIn(size);
    expect(done).toBe(true);
    expect(bytes.equals(original)).toBe(true);
  });

  it('is not done when the input is cut short', () => {
    const { bytes, done } = inflateIn(64 << 10, packed.subarray(0, packed.length - 1000));
    expect(done).toBe(false);
    expect(bytes.length).toBeLessThan(original.length);
  });

  it('refuses data after the end of the stream', () => {
    expect(() => inflateIn(64 << 10, Buffer.concat([packed, Buffer.from([1, 2, 3])]))).toThrow(/past its end/);
  });

  it('stops as soon as the output would pass its limit', () => {
    const inflater = brotliInflater(decoder);
    try {
      expect(() => inflater.push(packed, original.length - 1)).toThrow(/larger than expected/);
    } finally {
      inflater.free();
    }
  });

  it('refuses input that is not brotli', () => {
    expect(() => inflateIn(64 << 10, Buffer.from('<!doctype html><title>not brotli</title>'.repeat(100)))).toThrow();
  });
});
