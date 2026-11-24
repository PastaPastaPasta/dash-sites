import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
// SITE=1 builds dash.site's /new (this builder) and /publish pages for the dash-site-app Worker.
const site = process.env.SITE === '1';
const out = join(root, site ? 'dist-site' : 'dist');
const app = site ? join(out, 'new') : out;
rmSync(out, { recursive: true, force: true });
mkdirSync(join(app, 'assets'), { recursive: true });

await build({
  entryPoints: { app: join(root, 'src', 'main.ts'), ...(site && { publish: join(root, 'src', 'publish.ts') }) },
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

for (const file of ['index.html', 'styles.css', 'icon.svg']) cpSync(join(root, 'src', file), join(app, file));
const font = join(dirname(require.resolve('@fontsource-variable/bricolage-grotesque/package.json')), 'files', 'bricolage-grotesque-latin-wght-normal.woff2');
writeFileSync(join(app, 'assets', 'bricolage.woff2'), readFileSync(font));

if (site) {
  // /new is served without a trailing slash, so the page's relative links are made absolute.
  const page = readFileSync(join(app, 'index.html'), 'utf8').replace(/(href|src)="(styles\.css|icon\.svg|assets\/app\.js)"/g, '$1="/new/$2"').replace('<a class="mark" href="./">', '<a class="mark" href="/">');
  writeFileSync(join(app, 'index.html'), page);
  const publish = join(out, 'publish');
  cpSync(join(root, 'src', 'publish'), publish, { recursive: true });
  const showcase = join(root, '..', 'showcase', 'site');
  cpSync(join(showcase, 'fonts'), join(publish, 'fonts'), { recursive: true });
  cpSync(join(showcase, 'img', 'mark.svg'), join(publish, 'mark.svg'));
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
/new/assets/c/*
  Cache-Control: public, max-age=31536000, immutable
`,
  );
} else {
  writeFileSync(join(out, '.nojekyll'), '');
  if (process.env.BUILDER_CNAME) writeFileSync(join(out, 'CNAME'), `${process.env.BUILDER_CNAME}\n`);
}
console.log(out);
