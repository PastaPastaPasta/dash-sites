import { Gunzip, gzipSync } from 'fflate';
import { concat } from './bytes.js';

/** Deterministic gzip: no timestamp, fixed level. */
export function gzip(data: Uint8Array): Uint8Array {
  return gzipSync(data, { level: 9, mtime: 0 });
}

/** Decompresses at most `maxOutput` bytes and throws on anything longer or malformed. */
export function gunzip(data: Uint8Array, maxOutput: number): Uint8Array {
  const out: Uint8Array[] = [];
  let total = 0;
  const stream = new Gunzip((chunk) => {
    total += chunk.length;
    if (total > maxOutput) throw new Error('decompressed data exceeds the declared size');
    out.push(chunk);
  });
  const STEP = 64 * 1024;
  for (let offset = 0; offset < data.length; offset += STEP) {
    const end = Math.min(offset + STEP, data.length);
    stream.push(data.subarray(offset, end), end === data.length);
  }
  if (data.length === 0) throw new Error('empty gzip stream');
  return concat(out);
}
