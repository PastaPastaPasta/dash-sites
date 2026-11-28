import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, brotliDecompressSync, constants } from 'node:zlib';
import { build } from 'esbuild';
import { evoWasmPlugin } from '../../scripts/evo-wasm.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const out = join(root, 'dist');
const network = process.env.NETWORK ?? 'testnet';
const sourceUrl = process.env.SOURCE_URL ?? 'https://github.com/PastaPastaPasta/dash-sites';
const builderUrl = process.env.BUILDER_URL ?? 'https://dash-sites.thepasta.org/';
// Hosted gateways only (deploy.sh sets it when the host has a denylist): the worker honours the
// operator's denylist and a notice page is built for names refused by host.
const hosted = process.env.DENYLIST === '1';
// Static deployments only (no gateway process): the domain whose bare host shows the landing page.
const gatewayDomain = (process.env.GATEWAY_DOMAIN ?? '').toLowerCase();
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const common = { bundle: true, format: 'iife', target: 'es2022', minify: true, legalComments: 'none', logLevel: 'warning' };
const onlyNetwork = { __ONLY_NETWORK__: JSON.stringify(network) };
const sha256 = (data) => createHash('sha256').update(data).digest('hex');

/**
 * The Dash SDK bundle carries its WebAssembly inline as base64 of gzip, which costs 9 MB on the wire.
 * The verifier build takes it out and serves it as a separate file compressed with brotli at the
 * highest level (Cloudflare recompresses assets at a low level and ignores a file's own
 * Content-Encoding, so the worker decompresses it). The SDK's init then uses the module the worker
 * compiled from those bytes after checking their hash.
 */
let sdkWasm;
const sdkPlugin = evoWasmPlugin((wasm) => {
  sdkWasm = wasm;
});

const require = createRequire(import.meta.url);
const decoderWasm = readFileSync(require.resolve('brotli-dec-wasm/web/bg.wasm'));
const verifier = (
  await build({
    ...common,
    entryPoints: [join(root, 'src', 'verifier.ts')],
    write: false,
    plugins: [sdkPlugin],
    define: { ...onlyNetwork, __BROTLI_DECODER__: JSON.stringify(decoderWasm.toString('base64')) },
  })
).outputFiles[0].contents;
if (!sdkWasm) throw new Error('evo-sdk: the verifier build did not load the SDK bundle');
const verifierName = `dash-sites-verifier-${sha256(verifier).slice(0, 16)}.js`;
writeFileSync(join(out, verifierName), verifier);

/**
 * Brotli at quality 11 takes a minute or two, so the result is kept per input hash, and checked on
 * every build. The file is named for the WebAssembly it holds: that is what the worker checks, and
 * another brotli encoder may produce different bytes for it.
 */
function brotli(data) {
  const cached = join(root, 'node_modules', '.cache', `sdk-${sha256(data)}.q11w24.br`);
  const fits = (packed) => brotliDecompressSync(packed).equals(data);
  if (existsSync(cached)) {
    const packed = readFileSync(cached);
    if (fits(packed)) return packed;
  }
  const packed = brotliCompressSync(data, {
    params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_LGWIN]: 24, [constants.BROTLI_PARAM_SIZE_HINT]: data.length },
  });
  if (!fits(packed)) throw new Error('brotli did not round-trip the SDK WebAssembly');
  mkdirSync(dirname(cached), { recursive: true });
  writeFileSync(`${cached}.tmp`, packed);
  renameSync(`${cached}.tmp`, cached);
  return packed;
}
const sdkPacked = brotli(sdkWasm);
const sdkName = `dash-sites-verifier-${sha256(sdkWasm).slice(0, 16)}.wasm.br`;
writeFileSync(join(out, sdkName), sdkPacked);
// On a static deployment every name's worker fetches the verifier from the bare domain, so the
// browser downloads it once for all names (they are one site for the HTTP cache).
const assetUrl = (name) => (gatewayDomain ? `https://${gatewayDomain}/${name}` : `/${name}`);
const verifierUrl = assetUrl(verifierName);
const sdkUrl = assetUrl(sdkName);
copyFileSync(join(root, 'src', 'denied-sw.js'), join(out, 'denied-sw.js'));
const boot = await build({
  ...common,
  entryPoints: [join(root, 'src', 'boot.ts')],
  write: false,
  define: { ...onlyNetwork, __GATEWAY_DOMAIN__: JSON.stringify(gatewayDomain), __VERIFIER_FILES__: JSON.stringify([verifierUrl, sdkUrl]) },
});
const { DENIED_TITLE, DEPLOYMENTS, FORMATS, IPFS_MODULE, PAGE_STYLE, deniedDetail, escapeHtml, messagePage, moduleUrls, readerConfig } = await import('@dash-sites/core');
const abuseContact = process.env.ABUSE_CONTACT ?? `${sourceUrl}/issues`;
const abuseHref = /^(https?|mailto):/i.test(abuseContact) ? abuseContact : /^[^\s@/]+@[^\s@/]+$/.test(abuseContact) ? `mailto:${abuseContact}` : '';
const reportAbuse = abuseHref ? `<a href="${escapeHtml(abuseHref)}">Report abuse</a>` : `Report abuse: ${escapeHtml(abuseContact)}`;
const howItWorks = `<a href="${escapeHtml(sourceUrl)}">How it works</a>`;
// Only a static deployment (GATEWAY_DOMAIN set) has no backend; a hosted one also runs a fallback process.
const loadingNotice = gatewayDomain
  ? `${escapeHtml(gatewayDomain)} is a static page with no backend service. Your browser builds this site from what its author published to Dash Platform, a decentralized network. ${escapeHtml(gatewayDomain)} does not host, own, control or endorse it. ${howItWorks} · ${reportAbuse}`
  : `This page is the same for every name. It holds no site content. ${howItWorks} · ${reportAbuse}`;
if (hosted) writeFileSync(join(out, 'unavailable.html'), messagePage('451', DENIED_TITLE, deniedDetail('this name'), { builderUrl }));
const script = boot.outputFiles[0].text.trim();

function landingHtml() {
  if (!gatewayDomain) return '';
  const domain = escapeHtml(gatewayDomain);
  const [peerNetwork, peerUrl] = (process.env.PEER_GATEWAY ?? '').trim().split(/\s+/);
  const peer = peerNetwork && peerUrl ? ` · <a href="${escapeHtml(peerUrl)}">${escapeHtml(peerNetwork)}: ${escapeHtml(new URL(peerUrl).host)}</a>` : '';
  const live = readerConfig(network, process.env.CONTRACT_ID).contractId !== '';
  return `<div class="status">Dash Sites · ${escapeHtml(network)}</div>
<h1>Websites on Dash Platform names</h1>
<p><code>alice.dash</code> is at <code>alice.${domain}</code>. These pages are static files with no server behind them. Your browser reads the name, its site record and its files from Dash Platform, checks the proofs and every file's hash, and shows the site.</p>
<form id="go"><input name="name" placeholder="alice.dash" autocomplete="off" autocapitalize="none" spellcheck="false" aria-label="DPNS name"><button>Open</button></form>
${live ? '' : `<p>Publishing on ${escapeHtml(network)} has not opened yet. Names already resolve here, and a name's site appears as soon as its owner publishes one.</p>`}
<p><a href="${escapeHtml(builderUrl)}">Make a site</a>${peer}</p>
<footer>${domain} is a static page with no backend service. When you open a name here, your browser builds the site from what its author published to Dash Platform, a decentralized network. ${domain} does not host, own, control or review these sites, and does not condone or endorse them. It cannot change or remove anything on Dash Platform, but it can stop opening a name here. ${reportAbuse}</footer>`;
}
const preconnects = [
  ...(gatewayDomain ? [`<link rel="preconnect" href="https://${escapeHtml(gatewayDomain)}" crossorigin>`] : []),
  ...(network === 'mainnet' || network === 'testnet' ? [`<link rel="preconnect" href="https://quorums.${escapeHtml(network)}.networks.dash.org" crossorigin>`] : []),
].join('\n');
const csp = `default-src 'none'; script-src 'sha256-${createHash('sha256').update(script).digest('base64')}'; style-src 'unsafe-inline'; connect-src 'self'; worker-src 'self'; form-action 'none'; base-uri 'none'`;
const html = readFileSync(join(root, 'src', 'index.html'), 'utf8')
  .replace('/*STYLE*/', () => PAGE_STYLE)
  .replace('/*BOOT*/', () => script)
  .replace('__CSP__', () => csp)
  .replace('<!--PRECONNECT-->', () => preconnects)
  .replace('<!--LANDING-->', () => landingHtml())
  .replace('<!--NOTICE-->', () => loadingNotice)
  .replaceAll('__NETWORK__', () => network);
writeFileSync(join(out, 'index.html'), html);
const noJsBrotliPlugin = {
  name: 'no-js-brotli',
  setup(b) {
    b.onResolve({ filter: /^brotli\/decompress$/ }, () => ({ path: 'brotli-stub', namespace: 'stub' }));
    b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
      contents: 'export function decompress() { throw new Error("brotli decoder must be supplied by the worker"); }',
      loader: 'js',
    }));
  },
};
await build({
  ...common,
  entryPoints: { sw: join(root, 'src', 'sw.ts') },
  outdir: out,
  plugins: [noJsBrotliPlugin],
  define: {
    ...onlyNetwork,
    __NETWORK__: JSON.stringify(network),
    __CONTRACT_ID__: JSON.stringify(process.env.CONTRACT_ID ?? ''),
    __BUILDER_URL__: JSON.stringify(builderUrl),
    __VERIFIER__: JSON.stringify({ url: verifierUrl, sha256: sha256(verifier), size: verifier.length }),
    __SDK__: JSON.stringify({ url: sdkUrl, sha256: sha256(sdkWasm), size: sdkWasm.length }),
    __DENYLIST__: JSON.stringify(hosted),
    __BOOT_PAGE__: JSON.stringify(html),
    // Services asked which peers hold an IPFS CID; empty keeps the IPFS client's own default.
    __IPFS_ROUTERS__: JSON.stringify((process.env.IPFS_ROUTERS ?? '').split(/[\s,]+/).filter(Boolean)),
  },
});
const foreign = Object.values(DEPLOYMENTS).filter((d) => d.network !== network).map((d) => d.contractId);
for (const file of ['sw.js', verifierName]) {
  const text = readFileSync(join(out, file), 'utf8');
  if (foreign.some((id) => text.includes(id))) throw new Error(`shell: ${file} carries another network's contract id`);
}
if (gatewayDomain) {
  writeFileSync(
    join(out, '_headers'),
    `/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  Strict-Transport-Security: max-age=31536000; includeSubDomains
  Cache-Control: no-cache, no-transform
/sw.js
  ! Cache-Control
  Cache-Control: no-cache
/dash-sites-verifier-*
  ! Cache-Control
  Cache-Control: public, max-age=31536000, immutable
  Access-Control-Allow-Origin: *
`,
  );
}

const hashes = Object.fromEntries(['index.html', 'sw.js', verifierName, sdkName].map((file) => [file, sha256(readFileSync(join(out, file)))]));
// `fetched` is what the worker downloads from elsewhere, by hash, when a site needs it: no host of the shell serves it.
const fetched = { ipfs: { urls: moduleUrls(IPFS_MODULE), sha256: IPFS_MODULE.sha256 } };
writeFileSync(join(out, 'shell.json'), `${JSON.stringify({ network, hosted, gatewayDomain, formats: FORMATS, files: hashes, fetched }, null, 2)}\n`);
console.log(out, hashes);
