import { BrotliDecStream, BrotliStreamResultCode, initSync } from 'brotli-dec-wasm/web';

/** Turns brotli input into output as it arrives; `done` once the stream has ended. */
export interface Inflater {
  push(input: Uint8Array): Uint8Array[];
  readonly done: boolean;
  free(): void;
}

const OUTPUT_CHUNK = 1 << 20;
let decoderReady = false;

/** `decoder` gives the decompressor's own WebAssembly, needed only the first time. */
export function brotliInflater(decoder: () => BufferSource): Inflater {
  if (!decoderReady) {
    initSync({ module: decoder() });
    decoderReady = true;
  }
  const stream = new BrotliDecStream();
  let done = false;
  return {
    get done() {
      return done;
    },
    push(input) {
      const out: Uint8Array[] = [];
      for (;;) {
        if (done) {
          if (input.length) throw new Error('the compressed data continues past its end');
          return out;
        }
        const result = stream.dec(input, OUTPUT_CHUNK);
        const { code, buf } = result;
        const used = result.input_offset;
        result.free();
        if (buf.length) out.push(buf);
        input = input.subarray(used);
        if (code === BrotliStreamResultCode.ResultSuccess) done = true;
        else if (code === BrotliStreamResultCode.NeedsMoreInput) {
          if (input.length) throw new Error('the decompressor stopped before the end of its input');
          return out;
        }
      }
    },
    free: () => stream.free(),
  };
}
