import { decodeCbor } from './cbor.js';
import { asDiff, type MnListDiff } from './mnlist.js';
import { ChainError } from './wire.js';

const CORE = '/org.dash.platform.dapi.v0.Core/';
const MAX_MESSAGE = 16 << 20;

function varint(value: number): number[] {
  const out: number[] = [];
  while (value > 127) {
    out.push((value & 127) | 128);
    value = Math.floor(value / 128);
  }
  out.push(value);
  return out;
}

const frame = (message: number[]): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array(5 + message.length);
  new DataView(out.buffer).setUint32(1, message.length);
  out.set(message, 5);
  return out;
};

interface Field {
  number: number;
  value: number | Uint8Array;
}

/** The top-level fields of a protobuf message: varints and length-delimited fields only. */
export function fields(bytes: Uint8Array): Field[] {
  const out: Field[] = [];
  let offset = 0;
  const read = (): number => {
    let value = 0;
    let scale = 1;
    for (let i = 0; i < 10; i++) {
      if (offset >= bytes.length) throw new ChainError('truncated protobuf');
      const byte = bytes[offset++] as number;
      value += (byte & 127) * scale;
      if (!(byte & 128)) return value;
      scale *= 128;
    }
    throw new ChainError('protobuf varint too long');
  };
  while (offset < bytes.length) {
    const key = read();
    const type = key % 8;
    const number = Math.floor(key / 8);
    if (type === 0) out.push({ number, value: read() });
    else if (type === 2) {
      const length = read();
      if (offset + length > bytes.length) throw new ChainError('truncated protobuf field');
      out.push({ number, value: bytes.subarray(offset, offset + length) });
      offset += length;
    } else throw new ChainError(`unsupported protobuf wire type ${type}`);
  }
  return out;
}

function grpcError(headers: Headers | Map<string, string>, where: string): ChainError | undefined {
  const status = headers.get('grpc-status');
  if (status === null || status === undefined || status === '0') return undefined;
  const message = decodeURIComponent(headers.get('grpc-message') ?? '');
  return new ChainError(`${where}: gRPC status ${status}${message ? ` (${message})` : ''}`);
}

/** Messages of a gRPC-web response, in order, as they arrive. Throws on a gRPC error status. */
async function* messages(response: Response, where: string): AsyncGenerator<Uint8Array> {
  if (!response.ok) throw new ChainError(`${where}: HTTP ${response.status}`);
  const early = grpcError(response.headers, where);
  if (early) throw early;
  if (!response.body) return;
  const reader = response.body.getReader();
  let buffer = new Uint8Array(0);
  try {
    for (;;) {
      while (buffer.length >= 5) {
        const length = new DataView(buffer.buffer, buffer.byteOffset).getUint32(1);
        if (length > MAX_MESSAGE) throw new ChainError(`${where}: message too large`);
        if (buffer.length < 5 + length) break;
        const flag = buffer[0] as number;
        const body = buffer.slice(5, 5 + length);
        buffer = buffer.slice(5 + length);
        if (flag & 0x80) {
          const trailers = new Map<string, string>();
          for (const line of new TextDecoder().decode(body).split('\r\n')) {
            const colon = line.indexOf(':');
            if (colon > 0) trailers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
          }
          const error = grpcError(trailers, where);
          if (error) throw error;
          return;
        }
        yield body;
      }
      const { value, done } = await reader.read();
      if (done) {
        if (buffer.length > 0) throw new ChainError(`${where}: truncated response`);
        return;
      }
      const next = new Uint8Array(buffer.length + value.length);
      next.set(buffer);
      next.set(value, buffer.length);
      buffer = next;
    }
  } finally {
    reader.cancel().catch(() => undefined);
  }
}

export interface DapiOptions {
  fetch?: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
}

function call(node: string, method: string, message: number[], options: DapiOptions): Promise<Response> {
  const signals = [AbortSignal.timeout(options.timeoutMs ?? 20000), ...(options.signal ? [options.signal] : [])];
  return (options.fetch ?? fetch)(`${node}${CORE}${method}`, {
    method: 'POST',
    credentials: 'omit',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/grpc-web+proto', 'X-Grpc-Web': '1' },
    body: frame(message),
    signal: AbortSignal.any(signals),
  });
}

export async function bestBlockHeight(node: string, options: DapiOptions = {}): Promise<number> {
  for await (const message of messages(await call(node, 'getBestBlockHeight', [], options), `${node} getBestBlockHeight`)) {
    const height = fields(message).find((f) => f.number === 1)?.value;
    if (typeof height === 'number') return height;
  }
  throw new ChainError(`${node} getBestBlockHeight: no height`);
}

/** `count` raw headers from `fromHeight` on, in order. A node that sends fewer or more fails. */
export async function blockHeaders(node: string, fromHeight: number, count: number, options: DapiOptions = {}): Promise<Uint8Array[]> {
  const where = `${node} headers ${fromHeight}+${count}`;
  const out: Uint8Array[] = [];
  const response = await call(node, 'subscribeToBlockHeadersWithChainLocks', [0x10, ...varint(fromHeight), 0x18, ...varint(count)], options);
  for await (const message of messages(response, where)) {
    for (const field of fields(message)) {
      if (field.number !== 1 || !(field.value instanceof Uint8Array)) continue;
      for (const header of fields(field.value)) if (header.number === 1 && header.value instanceof Uint8Array) out.push(header.value);
      if (out.length > count) throw new ChainError(`${where}: too many headers`);
    }
    if (out.length === count) return out;
  }
  if (out.length !== count) throw new ChainError(`${where}: got ${out.length} headers`);
  return out;
}

/** The masternode list and quorums at the node's tip, as a diff from genesis. */
export async function masternodeListDiff(node: string, options: DapiOptions = {}): Promise<MnListDiff> {
  const where = `${node} masternode list`;
  for await (const message of messages(await call(node, 'subscribeToMasternodeList', [], options), where)) {
    const diff = fields(message).find((f) => f.number === 1)?.value;
    if (diff instanceof Uint8Array) return asDiff(decodeCbor(diff));
  }
  throw new ChainError(`${where}: no list`);
}
