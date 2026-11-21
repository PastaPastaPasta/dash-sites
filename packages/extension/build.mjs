import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = dirname(fileURLToPath(import.meta.url));
const out = join(root, 'build');
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
rmSync(out, { recursive: true, force: true });

function icons(dir) {
  mkdirSync(join(dir, 'icons'), { recursive: true });
  for (const size of [16, 32, 48, 128]) {
    const s = size / 128;
    const n = (v) => (v * s).toFixed(2);
    execFileSync('magick', [
      '-size', `${size}x${size}`, 'xc:none',
      '-fill', '#008de4', '-draw', `roundrectangle 0,0 ${size - 1},${size - 1} ${n(28)},${n(28)}`,
      '-fill', 'none', '-stroke', 'white', '-strokewidth', n(11), '-draw', `circle ${n(56)},${n(56)} ${n(56)},${n(27)}`,
      '-stroke', 'none', '-fill', 'white', '-draw', `circle ${n(102)},${n(100)} ${n(102)},${n(89)}`,
      join(dir, 'icons', `${size}.png`),
    ]);
  }
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
  icons(dir);
  const manifest = JSON.parse(readFileSync(join(root, 'static', 'manifest.json'), 'utf8'));
  manifest.version = version;
  if (target === 'firefox') {
    manifest.background = { scripts: ['background.js'], type: 'module' };
    manifest.browser_specific_settings = { gecko: { id: 'dash-sites@thepasta.org', strict_min_version: '128.0' } };
    delete manifest.minimum_chrome_version;
  }
  writeFileSync(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  const zip = join(out, `dash-sites-extension-${target}-${version}.zip`);
  execFileSync('zip', ['-q', '-r', '-X', zip, '.'], { cwd: dir });
  console.log(zip);
}
