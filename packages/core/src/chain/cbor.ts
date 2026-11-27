import { ChainError } from './wire.js';

const MAX_DEPTH = 16;

/** Decodes the CBOR DAPI wraps Core's JSON answers in: maps, arrays, strings, numbers, booleans, null. */
export function decodeCbor(bytes: Uint8Array): unknown {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = new TextDecoder('utf-8', { fatal: true });
  let offset = 0;
  const need = (n: number): void => {
    if (offset + n > bytes.length) throw new ChainError('truncated CBOR');
  };
  const argument = (info: number): number => {
    if (info < 24) return info;
    const size = info === 24 ? 1 : info === 25 ? 2 : info === 26 ? 4 : info === 27 ? 8 : 0;
    if (size === 0) throw new ChainError('indefinite or reserved CBOR length');
    need(size);
    let value: number;
    if (size === 1) value = view.getUint8(offset);
    else if (size === 2) value = view.getUint16(offset);
    else if (size === 4) value = view.getUint32(offset);
    else {
      const big = view.getBigUint64(offset);
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new ChainError('CBOR integer too large');
      value = Number(big);
    }
    offset += size;
    return value;
  };
  const item = (depth: number): unknown => {
    if (depth > MAX_DEPTH) throw new ChainError('CBOR nested too deeply');
    need(1);
    const initial = bytes[offset++] as number;
    const major = initial >> 5;
    const info = initial & 31;
    if (major === 7) {
      if (info === 20) return false;
      if (info === 21) return true;
      if (info === 22 || info === 23) return null;
      if (info === 25) {
        need(2);
        const half = view.getUint16(offset);
        offset += 2;
        const exponent = (half >> 10) & 31;
        const fraction = half & 1023;
        const sign = half & 0x8000 ? -1 : 1;
        if (exponent === 0) return sign * 2 ** -14 * (fraction / 1024);
        if (exponent === 31) return fraction ? NaN : sign * Infinity;
        return sign * 2 ** (exponent - 15) * (1 + fraction / 1024);
      }
      if (info === 26) {
        need(4);
        const value = view.getFloat32(offset);
        offset += 4;
        return value;
      }
      if (info === 27) {
        need(8);
        const value = view.getFloat64(offset);
        offset += 8;
        return value;
      }
      throw new ChainError('unsupported CBOR simple value');
    }
    const value = argument(info);
    switch (major) {
      case 0:
        return value;
      case 1:
        return -1 - value;
      case 2:
      case 3: {
        need(value);
        const slice = bytes.subarray(offset, offset + value);
        offset += value;
        return major === 2 ? slice : text.decode(slice);
      }
      case 4: {
        if (value > bytes.length - offset) throw new ChainError('CBOR array longer than its input');
        const out: unknown[] = [];
        for (let i = 0; i < value; i++) out.push(item(depth + 1));
        return out;
      }
      case 5: {
        if (value > bytes.length - offset) throw new ChainError('CBOR map longer than its input');
        const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
        for (let i = 0; i < value; i++) {
          const key = item(depth + 1);
          if (typeof key !== 'string') throw new ChainError('CBOR map key is not a string');
          out[key] = item(depth + 1);
        }
        return out;
      }
      default:
        throw new ChainError('unsupported CBOR tag');
    }
  };
  const result = item(0);
  if (offset !== bytes.length) throw new ChainError('trailing bytes after CBOR');
  return result;
}
