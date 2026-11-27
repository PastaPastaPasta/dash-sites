import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { zipSync } from 'fflate';
import { evoWasmPlugin, x11StrictPlugin } from '../../scripts/evo-wasm.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const out = join(root, 'build');
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
rmSync(out, { recursive: true, force: true });

function tree(dir, prefix = '') {
  const files = {};
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) Object.assign(files, tree(path, `${prefix}${entry.name}/`));
    else files[`${prefix}${entry.name}`] = [new Uint8Array(readFileSync(path)), { mtime: new Date('2026-01-01T00:00:00Z') }];
  }
  return files;
}

for (const target of ['chrome', 'firefox']) {
  const dir = join(out, target);
  mkdirSync(dir, { recursive: true });
  const sandbox = target === 'chrome';
  let wasm;
  const common = { bundle: true, minify: true, legalComments: 'none', logLevel: 'warning', target: sandbox ? 'chrome124' : 'firefox128', define: { __SANDBOX__: String(sandbox) } };
  await build({
    ...common,
    entryPoints: ['background', 'site', 'popup', 'options'].map((name) => join(root, 'src', `${name}.ts`)),
    outdir: dir,
    splitting: true,
    format: 'esm',
    chunkNames: 'chunks/[name]-[hash]',
    plugins: [evoWasmPlugin((bytes) => (wasm = bytes)), x11StrictPlugin()],
  });
  if (!wasm) throw new Error('the extension build did not load the SDK');
  writeFileSync(join(dir, 'verifier.wasm'), wasm);
  if (sandbox) await build({ ...common, entryPoints: [join(root, 'src', 'sandbox.ts')], outdir: dir, format: 'iife' });
  cpSync(join(root, 'static'), dir, { recursive: true });
  const manifest = JSON.parse(readFileSync(join(root, 'static', 'manifest.json'), 'utf8'));
  manifest.version = version;
  if (!sandbox) {
    delete manifest.sandbox;
    delete manifest.content_security_policy.sandbox;
    delete manifest.minimum_chrome_version;
    manifest.web_accessible_resources[0].resources = ['site.html'];
    manifest.background = { scripts: ['background.js'], type: 'module' };
    manifest.browser_specific_settings = { gecko: { id: 'dash-sites@thepasta.org', strict_min_version: '128.0', data_collection_permissions: { required: ['none'] } } };
    rmSync(join(dir, 'sandbox.html'));
  }
  writeFileSync(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  const zip = join(out, `dash-sites-extension-${target}-${version}.zip`);
  writeFileSync(zip, zipSync(tree(dir), { level: 9 }));
  console.log(zip);
}
