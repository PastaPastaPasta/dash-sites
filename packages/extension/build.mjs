import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { zipSync } from 'fflate';

const root = dirname(fileURLToPath(import.meta.url));
const out = join(root, 'build');
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
rmSync(out, { recursive: true, force: true });

function tree(dir, prefix = '') {
  const out = {};
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) Object.assign(out, tree(path, `${prefix}${entry.name}/`));
    else out[`${prefix}${entry.name}`] = [new Uint8Array(readFileSync(path)), { mtime: new Date('2026-01-01T00:00:00Z') }];
  }
  return out;
}

for (const target of ['chrome', 'firefox']) {
  const dir = join(out, target);
  mkdirSync(dir, { recursive: true });
  await build({
    entryPoints: ['background', 'popup', 'options'].map((name) => join(root, 'src', `${name}.ts`)),
    outdir: dir,
    bundle: true,
    splitting: true,
    format: 'esm',
    target: target === 'chrome' ? 'chrome116' : 'firefox128',
    chunkNames: 'chunks/[name]-[hash]',
    minify: true,
    legalComments: 'none',
    logLevel: 'warning',
  });
  cpSync(join(root, 'static'), dir, { recursive: true });
  const manifest = JSON.parse(readFileSync(join(root, 'static', 'manifest.json'), 'utf8'));
  manifest.version = version;
  if (target === 'firefox') {
    manifest.background = { scripts: ['background.js'], type: 'module' };
    manifest.browser_specific_settings = { gecko: { id: 'dash-sites@thepasta.org', strict_min_version: '128.0' } };
    delete manifest.minimum_chrome_version;
  }
  writeFileSync(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  const zip = join(out, `dash-sites-extension-${target}-${version}.zip`);
  writeFileSync(zip, zipSync(tree(dir), { level: 9 }));
  console.log(zip);
}
