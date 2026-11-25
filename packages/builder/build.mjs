import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
// SITE=1 builds dash.site's /new (this builder) for the dash-site-app Worker.
const site = process.env.SITE === '1';
const out = join(root, site ? 'dist-site' : 'dist');
const app = site ? join(out, 'new') : out;
rmSync(out, { recursive: true, force: true });
mkdirSync(join(app, 'assets'), { recursive: true });

const result = await build({
  entryPoints: { app: join(root, 'src', 'main.ts') },
  entryNames: '[name]-[hash]',
  absWorkingDir: root,
  metafile: true,
  outdir: join(app, 'assets'),
  bundle: true,
  splitting: true,
  format: 'esm',
  target: 'es2022',
  minify: true,
  legalComments: 'none',
  chunkNames: 'c/[name]-[hash]',
  define: {
    __GATEWAY_DOMAIN__: JSON.stringify(process.env.GATEWAY_DOMAIN ?? 'id.dashhq.org'),
    __NETWORK__: JSON.stringify(process.env.NETWORK ?? 'testnet'),
    __REMEMBER_WALLET__: JSON.stringify(!site),
  },
  logLevel: 'warning',
});

// Everything under assets/ is named for its content, so it can be cached for good; only index.html revalidates.
const fingerprint = (name, bytes) => {
  const [base, ext] = name.split(/\.(?=[^.]+$)/);
  const file = `${base}-${createHash('sha256').update(bytes).digest('hex').slice(0, 12)}.${ext}`;
  writeFileSync(join(app, 'assets', file), bytes);
  return `assets/${file}`;
};
const fontFile = join(dirname(require.resolve('@fontsource-variable/bricolage-grotesque/package.json')), 'files', 'bricolage-grotesque-latin-wght-normal.woff2');
const font = fingerprint('bricolage.woff2', readFileSync(fontFile));
const css = readFileSync(join(root, 'src', 'styles.css'), 'utf8');
if (!css.includes('url(assets/bricolage.woff2)')) throw new Error('builder: styles.css no longer loads the font from assets/bricolage.woff2');
const styles = fingerprint('styles.css', css.replace('url(assets/bricolage.woff2)', `url(${font.slice('assets/'.length)})`));
const icon = fingerprint('icon.svg', readFileSync(join(root, 'src', 'icon.svg')));
const script = Object.entries(result.metafile.outputs).find(([, output]) => output.entryPoint)?.[0];
if (!script) throw new Error('builder: no app entry in the esbuild output');
const assets = { 'styles.css': styles, 'icon.svg': icon, 'assets/app.js': `assets/${script.split('/').pop()}` };
const html = readFileSync(join(root, 'src', 'index.html'), 'utf8').replace(/(href|src)="(styles\.css|icon\.svg|assets\/app\.js)"/g, (_, attr, path) => `${attr}="${assets[path]}"`);
if (Object.values(assets).some((path) => !html.includes(`"${path}"`))) throw new Error('builder: index.html no longer links every asset');
writeFileSync(join(app, 'index.html'), html);

if (site) {
  // /new is served without a trailing slash, so the page's relative links are made absolute.
  const page = readFileSync(join(app, 'index.html'), 'utf8').replace(/(href|src)="(assets\/[^"]+)"/g, '$1="/new/$2"').replace('<a class="mark" href="./">', '<a class="mark" href="/">');
  writeFileSync(join(app, 'index.html'), page);
  // /publish was a separate name-check page; /new does all of it now, so old links land there.
  writeFileSync(join(out, '_redirects'), '/publish /new 301\n/publish/* /new 301\n');
  const csp = [
    "default-src 'none'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "worker-src 'self' blob:",
    "style-src 'self' 'unsafe-inline' data:",
    "img-src 'self' data:",
    "font-src 'self'",
    'connect-src https:',
    "frame-src 'self' about: data:",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
  writeFileSync(
    join(out, '_headers'),
    `/*
  Content-Security-Policy: ${csp}
  X-Frame-Options: DENY
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
  Cross-Origin-Opener-Policy: same-origin
  Permissions-Policy: camera=(), microphone=(), geolocation=()
  Strict-Transport-Security: max-age=31536000; includeSubDomains
  Origin-Agent-Cluster: ?1
/new
  Cache-Control: no-cache
/new/assets/*
  Cache-Control: public, max-age=31536000, immutable
`,
  );
} else {
  writeFileSync(join(out, '.nojekyll'), '');
  if (process.env.BUILDER_CNAME) writeFileSync(join(out, 'CNAME'), `${process.env.BUILDER_CNAME}\n`);
}
console.log(out);
