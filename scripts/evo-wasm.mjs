import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

/** Exactly one match of `pattern` in `text`, or the build stops: the SDK bundle changed shape. */
function only(text, pattern, what) {
  const found = [...text.matchAll(new RegExp(pattern.source, 'g'))];
  if (found.length !== 1) throw new Error(`evo-sdk: expected one ${what}, found ${found.length}; update the patch in scripts/evo-wasm.mjs`);
  return found[0];
}

/**
 * The Dash SDK bundle carries its WebAssembly inline as base64 of gzip. This esbuild plugin takes
 * it out and hands the bytes to `onWasm`, and makes the SDK's init use the compiled module the page
 * puts at `globalThis.dashSitesSdk` instead.
 */
export function evoWasmPlugin(onWasm) {
  return {
    name: 'evo-sdk-wasm',
    setup(b) {
      b.onLoad({ filter: /[\\/]@dashevo[\\/]evo-sdk[\\/]dist[\\/]evo-sdk\.module\.js$/ }, ({ path }) => {
        let code = readFileSync(path, 'utf8');
        const inline = only(code, /const ([\w$]+)="(H4sI[A-Za-z0-9+/=]+)"/, 'inline WebAssembly');
        const wasm = gunzipSync(Buffer.from(inline[2], 'base64'));
        if (wasm.readUInt32BE(0) !== 0x0061736d) throw new Error('evo-sdk: the inline payload is not WebAssembly');
        onWasm(wasm);
        code = code.replace(inline[0], () => `const ${inline[1]}=""`);
        const init = only(code, /async function ([\w$]+)\(([\w$]+)\)\{if\(([\w$]+)\)\{if\(void 0===\2\)\{return [\w$]+\(\{module:await [\w$]+\(\)\}\)\}return ([\w$]+)\(\2\)\}/, 'WebAssembly init');
        const [whole, , arg, , instantiate] = init;
        code = code.replace(whole, () => whole.replace('{', () => `{if(void 0===${arg})return ${instantiate}({module_or_path:globalThis.dashSitesSdk});`));
        return { contents: code, loader: 'js' };
      });
    },
  };
}

/**
 * `@dashevo/x11-hash-js` reads `this.hi` in a plain function of groestl.js where it means `x.hi`.
 * Run as a CommonJS module in sloppy mode `this` is the global object and the value is masked away;
 * bundled as ES modules it is strict mode and throws. The fix gives the same bytes.
 */
export function x11StrictPlugin() {
  return {
    name: 'x11-strict',
    setup(b) {
      b.onLoad({ filter: /[\\/]@dashevo[\\/]x11-hash-js[\\/]lib[\\/]groestl\.js$/ }, ({ path }) => {
        const code = readFileSync(path, 'utf8');
        const pattern = /toMoveDown = this\.hi << bitsOff32/g;
        if ((code.match(pattern) ?? []).length !== 1) throw new Error('x11-hash-js: groestl.js changed; update x11StrictPlugin in scripts/evo-wasm.mjs');
        return { contents: code.replace(pattern, 'toMoveDown = x.hi << bitsOff32'), loader: 'js' };
      });
    },
  };
}
