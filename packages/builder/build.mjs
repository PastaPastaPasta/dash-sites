import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = dirname(fileURLToPath(import.meta.url));
const out = join(root, 'dist');
const require = createRequire(import.meta.url);
rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'assets'), { recursive: true });

await build({
  entryPoints: { app: join(root, 'src', 'main.ts') },
  outdir: join(out, 'assets'),
  bundle: true,
  splitting: true,
  format: 'esm',
  target: 'es2022',
  minify: true,
  legalComments: 'none',
  chunkNames: '[name]-[hash]',
  define: {
    __GATEWAY_DOMAIN__: JSON.stringify(process.env.GATEWAY_DOMAIN ?? 'id.dashhq.org'),
    __NETWORK__: JSON.stringify(process.env.NETWORK ?? 'testnet'),
  },
  logLevel: 'warning',
});

for (const file of ['index.html', 'styles.css', 'icon.svg']) cpSync(join(root, 'src', file), join(out, file));
const font = join(dirname(require.resolve('@fontsource-variable/bricolage-grotesque/package.json')), 'files', 'bricolage-grotesque-latin-wght-normal.woff2');
writeFileSync(join(out, 'assets', 'bricolage.woff2'), readFileSync(font));
writeFileSync(join(out, '.nojekyll'), '');
if (process.env.BUILDER_CNAME) writeFileSync(join(out, 'CNAME'), `${process.env.BUILDER_CNAME}\n`);
console.log(out);
