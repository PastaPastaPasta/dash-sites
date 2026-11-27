import { cpSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const SDK = 'https://cdn.jsdelivr.net/npm/@dashevo/evo-sdk@5.1.0/dist/evo-sdk.module.js';
// Loaded only for a file stored as brotli, which this site never is.
const BROTLI = 'https://cdn.jsdelivr.net/npm/brotli@2.1.0/decompress.js/+esm';
const root = dirname(fileURLToPath(import.meta.url));
const out = join(root, 'dist');
rmSync(out, { recursive: true, force: true });
cpSync(join(root, 'site'), out, { recursive: true });

await build({
  entryPoints: { verify: join(root, 'src', 'verify.ts') },
  outdir: join(out, 'js'),
  bundle: true,
  format: 'esm',
  target: 'es2022',
  minify: true,
  legalComments: 'none',
  define: { __ONLY_NETWORK__: JSON.stringify(process.env.NETWORK ?? 'mainnet') },
  plugins: [
    {
      name: 'sdk-from-cdn',
      setup(build) {
        build.onResolve({ filter: /^@dashevo\/evo-sdk$/ }, () => ({ path: SDK, external: true }));
        build.onResolve({ filter: /^brotli\/decompress$/ }, () => ({ path: BROTLI, external: true }));
      },
    },
  ],
  logLevel: 'warning',
});
console.log(out);
