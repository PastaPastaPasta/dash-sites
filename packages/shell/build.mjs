import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = dirname(fileURLToPath(import.meta.url));
const out = join(root, 'dist');
const network = process.env.NETWORK ?? 'testnet';
const sourceUrl = process.env.SOURCE_URL ?? 'https://github.com/PastaPastaPasta/dash-sites';
const builderUrl = process.env.BUILDER_URL ?? 'https://dash-sites.thepasta.org/';
// Hosted gateways only (deploy.sh sets it when the host has a denylist): the worker honours the
// operator's denylist and a notice page is built for names refused by host.
const hosted = process.env.DENYLIST === '1';
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const common = { bundle: true, format: 'iife', target: 'es2022', minify: true, legalComments: 'none', logLevel: 'warning' };
const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const verifier = (await build({ ...common, entryPoints: [join(root, 'src', 'verifier.ts')], write: false })).outputFiles[0].contents;
const verifierName = `dash-sites-verifier-${sha256(verifier).slice(0, 16)}.js`;
writeFileSync(join(out, verifierName), verifier);
await build({
  ...common,
  entryPoints: { sw: join(root, 'src', 'sw.ts') },
  outdir: out,
  define: {
    __NETWORK__: JSON.stringify(network),
    __CONTRACT_ID__: JSON.stringify(process.env.CONTRACT_ID ?? ''),
    __BUILDER_URL__: JSON.stringify(builderUrl),
    __VERIFIER__: JSON.stringify(`/${verifierName}`),
    __VERIFIER_SHA256__: JSON.stringify(sha256(verifier)),
    __DENYLIST__: JSON.stringify(hosted),
  },
});
copyFileSync(join(root, 'src', 'denied-sw.js'), join(out, 'denied-sw.js'));
const boot = await build({ ...common, entryPoints: [join(root, 'src', 'boot.ts')], write: false });
const { DENIED_TITLE, PAGE_STYLE, deniedDetail, messagePage } = await import('@dash-sites/core');
if (hosted) writeFileSync(join(out, 'unavailable.html'), messagePage('451', DENIED_TITLE, deniedDetail('this name'), { builderUrl }));
const script = boot.outputFiles[0].text.trim();
const csp = `default-src 'none'; script-src 'sha256-${createHash('sha256').update(script).digest('base64')}'; style-src 'unsafe-inline'; connect-src 'self'; worker-src 'self'; form-action 'none'; base-uri 'none'`;
const html = readFileSync(join(root, 'src', 'index.html'), 'utf8')
  .replace('/*STYLE*/', () => PAGE_STYLE)
  .replace('/*BOOT*/', () => script)
  .replace('__CSP__', () => csp)
  .replaceAll('__NETWORK__', network)
  .replaceAll('__SOURCE_URL__', sourceUrl);
writeFileSync(join(out, 'index.html'), html);

const hashes = Object.fromEntries(['index.html', 'sw.js', verifierName].map((file) => [file, sha256(readFileSync(join(out, file)))]));
writeFileSync(join(out, 'shell.json'), `${JSON.stringify({ network, hosted, files: hashes }, null, 2)}\n`);
console.log(out, hashes);
