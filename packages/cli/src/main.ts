import { readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { parseArgs } from 'node:util';
import { brotliCompressSync, constants as zlib } from 'node:zlib';
import { decompress as brotliDecompress } from 'brotli/decompress';
import {
  buildSite,
  DEFAULT_PRUNE_GRACE_MS,
  checkExternalAssets,
  type BuildOptions,
  estimateCredits,
  formatDash,
  loadManifest,
  networkConfig,
  parseName,
  planPrune,
  prune,
  refundCredits,
  type PrunePlan,
  publishPointer,
  publishSite,
  readElsewhere,
  readFile,
  decide,
  requireOwnedName,
  resolveName,
  siteChunks,
  type Network,
  type NetworkConfig,
  type PlatformReader,
  type SiteBundle,
} from '@dash-sites/core';
import { MemoryPlatform } from '@dash-sites/core/memory';
import { EvoReader, EvoWriter, registerContract, type Credentials } from '@dash-sites/core/evo';
import { createGateway, emptyDenylist, parseDomain } from '@dash-sites/gateway';
import { readSiteDirectory } from './files.js';
import { checkPlaces, cliPlaces, parsePlaceMap, storeElsewhere, type CliPlaces } from './places.js';

const USAGE = `dash-sites: websites on Dash Platform names

  dash-sites publish <dir> --name <name> [--spa] [--prune] [--brotli] [--external <file>] [--elsewhere <file>] [--dry-run]
                                                               publish a folder as <name>.dash
  dash-sites check <name>                                      ask every outside place of a site for its file
  dash-sites point --name <name> --content ipfs://<cid>        point a name at content stored elsewhere
  dash-sites unpublish --name <name>                           remove the site record
  dash-sites gc [--dry-run]                                    delete stored chunks no site uses
  dash-sites register <label>                                  register <label>.dash for this identity
  dash-sites names                                             list the names this identity owns
  dash-sites resolve <name>                                    show what a name resolves to (JSON)
  dash-sites fetch <name> [path] [-o file]                     download one file, verified
  dash-sites preview <dir> [--name <name>] [--port 8080]       serve a folder locally the way a gateway would
  dash-sites gateway [--port 8080] [--domain localhost]        serve *.localhost from this machine
  dash-sites contract register --schema <file>                 register the data contract (operators)

Options
  --network testnet|mainnet     default testnet
  --contract <id>               dash-sites contract id, if not the built-in one
  --identity-file <file>        identity JSON with identityId and identityKeys (as dash-bridge writes)
  --identity <id>               identity id; the key comes from DASH_SITES_KEY (WIF)
  --prune                       after publishing, delete chunks of releases before the one replaced
  --grace <hours>               gc and --prune delete nothing until every site record is this old (default 25)
  --brotli                      store a file as brotli when that is smaller than gzip (needs a current shell)
  --external <file>             JSON {"/site/path": {"npm": "pkg", "version": "1.2.3", "path": "dist/file"}}:
                                files not stored, fetched by readers from npm CDNs and checked by SHA-384

Environment
  DASH_SITES_KEY                WIF of an AUTHENTICATION key (HIGH or CRITICAL) of the identity

Files kept outside Platform
  --elsewhere takes a JSON file that maps site paths to the places holding them, each an
  https:// address or an ipfs:// CID:  { "/img/hero.webp": ["ipfs://bafy...", "https://media.example.com/hero.webp"] }
  Platform then stores only the file's size, its hash and that list. Visitors' browsers fetch the
  file from the first place that serves those exact bytes. Upload the file with your provider's own
  tools first: publish asks every place and stops if one does not serve it. A file that is not in
  the folder is taken from its first place. An https:// place must allow reading from other sites.
`;

interface IdentityFile {
  identityId: string;
  identityKeys: Array<{ purpose: string; securityLevel: string; privateKeyWif: string }>;
}

function fail(message: string): never {
  console.error(`dash-sites: ${message}`);
  process.exit(1);
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    name: { type: 'string' },
    network: { type: 'string', default: 'testnet' },
    contract: { type: 'string' },
    'identity-file': { type: 'string' },
    identity: { type: 'string' },
    content: { type: 'string' },
    schema: { type: 'string' },
    port: { type: 'string', default: '8080' },
    domain: { type: 'string', default: 'localhost' },
    output: { type: 'string', short: 'o' },
    elsewhere: { type: 'string' },
    spa: { type: 'boolean', default: false },
    prune: { type: 'boolean', default: false },
    grace: { type: 'string', default: String(DEFAULT_PRUNE_GRACE_MS / 3_600_000) },
    brotli: { type: 'boolean', default: false },
    external: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

function credentials(level: 'HIGH' | 'CRITICAL' = 'HIGH'): Credentials {
  const file = values['identity-file'];
  if (file) {
    const identity = JSON.parse(readFileSync(file, 'utf8')) as IdentityFile;
    const key = identity.identityKeys?.find((k) => k.purpose === 'AUTHENTICATION' && k.securityLevel === level);
    if (!identity.identityId || !key) fail(`${file} has no identity id or no AUTHENTICATION/${level} key`);
    return { identityId: identity.identityId, privateKeyWif: key.privateKeyWif };
  }
  const privateKeyWif = process.env.DASH_SITES_KEY;
  if (!values.identity || !privateKeyWif) fail('pass --identity-file, or --identity with DASH_SITES_KEY set');
  return { identityId: values.identity, privateKeyWif };
}

function network(): NetworkConfig {
  if (values.network !== 'testnet' && values.network !== 'mainnet') fail('--network must be testnet or mainnet');
  return networkConfig(values.network as Network, values.contract);
}

function requireName(): string {
  if (!values.name || !parseName(values.name)) fail('--name must be a DPNS name such as alice or alice.dash');
  return values.name;
}

let places: CliPlaces | undefined;
/** The origin a site is served on decides nothing here; it only makes storage hosts answer as they would a browser. */
const outside = (label = 'site'): CliPlaces => (places ??= cliPlaces(`https://${label.toLowerCase()}.dash.site`));
function graceMs(): number {
  const text = String(values.grace ?? '').trim();
  const hours = Number(text);
  if (text === '' || !Number.isFinite(hours) || hours < 0) fail('--grace must be a number of hours');
  return hours * 3_600_000;
}

/** What a prune plan deletes and roughly returns: a delete in the epoch of the store, and one a mainnet year later. */
function describePlan(plan: PrunePlan): Record<string, unknown> {
  return {
    ...(plan.deferredUntil !== undefined ? { deferredUntil: new Date(plan.deferredUntil).toISOString() } : {}),
    chunks: plan.remove.length,
    bytes: plan.bytes,
    kept: plan.kept,
    storageRefundSameEpoch: formatDash(refundCredits(plan.bytes, 0)),
    storageRefundAfterOneYear: formatDash(refundCredits(plan.bytes, 40)),
    note: 'storage refund before the processing fee each delete pays, which is never refunded (about 15-20% of the refund in a chunk tree of a thousand documents)',
    remove: plan.remove.map((chunk) => `${chunk.hash} ${chunk.bytes}`),
  };
}

/**
 * Brotli at the highest quality, with a window no larger than the file needs (readers allocate the
 * window to decode). A file that does not decode back exactly with the readers' own decoder is
 * returned unchanged, so it is stored as gzip instead.
 */
function brotli(data: Uint8Array): Uint8Array {
  const window = Math.min(24, Math.max(10, Math.ceil(Math.log2(Math.max(data.length, 1)))));
  const compressed = new Uint8Array(brotliCompressSync(data, { params: { [zlib.BROTLI_PARAM_QUALITY]: 11, [zlib.BROTLI_PARAM_LGWIN]: window, [zlib.BROTLI_PARAM_SIZE_HINT]: data.length } }));
  try {
    const decoded = brotliDecompress(compressed, data.length);
    if (decoded.length === data.length && decoded.every((byte, i) => byte === data[i])) return compressed;
  } catch {
    // stored as gzip below
  }
  return data;
}

function buildOptions(): BuildOptions {
  const external = values.external ? (JSON.parse(readFileSync(values.external, 'utf8')) as BuildOptions['external']) : undefined;
  return { spa: values.spa, ...(values.brotli ? { brotli } : {}), ...(external ? { external } : {}) };
}

/** Refuses the site unless every npm CDN serves each external file with its integrity. */
async function checkExternal(bundle: SiteBundle): Promise<void> {
  const results = await checkExternalAssets(bundle.manifest.files);
  for (const r of results) console.error(`${r.result.padEnd(11)} ${r.path} <- ${r.url}${r.detail ? ` (${r.detail})` : ''}`);
  if (results.some((r) => r.result === 'mismatch')) fail('an external file is not byte-identical to the npm package file on every CDN; store it instead');
  if (results.some((r) => r.result === 'unreachable')) fail('an npm CDN could not be reached; try again');
}

const print = (value: unknown): void => console.log(JSON.stringify(value, (_key, v) => (typeof v === 'bigint' ? v.toString() : v), 2));

async function serve(reader: PlatformReader, announce?: string): Promise<never> {
  const port = Number(values.port);
  const config = {
    domains: [parseDomain(`http://${values.domain}:${port}`)],
    reservedLabels: new Set<string>(),
    builderUrl: 'https://github.com/PastaPastaPasta/dash-sites',
    extensionUrl: 'https://github.com/PastaPastaPasta/dash-sites/releases',
    abuseContact: 'this is a local gateway',
    network: values.network as string,
    sitesLive: true,
    denylist: emptyDenylist(),
    maxSiteBytes: 50 * 1024 * 1024,
    maxFiles: 5000,
    rateLimitPerMinute: 0,
    trustProxy: false,
    chunkCacheBytes: 256 * 1024 * 1024,
  };
  createServer(createGateway({ reader, config })).listen(port, '127.0.0.1', () => {
    console.error(announce ?? `gateway on http://${values.domain}:${port}/ (sites at http://<name>.${values.domain}:${port}/)`);
  });
  return new Promise(() => {});
}

const commands: Record<string, () => Promise<void>> = {
  async publish() {
    const dir = positionals[1] ?? fail('publish needs a directory');
    const name = requireName();
    let files = await readSiteDirectory(dir);
    if (values.elsewhere) {
      const map = parsePlaceMap(JSON.parse(readFileSync(values.elsewhere, 'utf8')));
      files = await storeElsewhere(files, map, outside(parseName(name)?.label).fetchers, (line) => console.error(line));
    }
    const bundle = buildSite(files, buildOptions());
    await checkExternal(bundle);
    const { elsewhere } = bundle.stats;
    console.error(`${bundle.stats.files - elsewhere.files} files, ${bundle.stats.bytes} bytes (${bundle.stats.storedBytes} stored) in ${bundle.stats.chunks} chunks`);
    if (elsewhere.files > 0) console.error(`${elsewhere.files} files, ${elsewhere.bytes} bytes kept outside Platform`);
    if (!bundle.manifest.files['/index.html']) console.error('warning: the site has no /index.html');
    console.error(`estimated cost if nothing is stored yet: ${formatDash(estimateCredits(bundle))}`);
    if (values['dry-run']) return print({ content: bundle.contentUri, stats: bundle.stats });
    const writer = await EvoWriter.connectAs(network(), credentials());
    if (values.prune) console.error('after the record is written, --prune checks the site records again from a newer block before deleting (a few minutes)');
    const result = await publishSite(
      writer,
      name,
      bundle,
      (progress) => {
        if (progress.step === 'upload') console.error(`uploaded chunk ${progress.done}/${progress.total}`);
      },
      values.prune ? { prune: { graceMs: graceMs() } } : {},
    );
    print({
      name: `${parseName(name)?.label}.dash`,
      content: result.site.content,
      revision: result.site.revision,
      uploaded: result.uploaded,
      reused: result.reused,
      spent: formatDash(result.creditsSpent),
      ...(result.pruned
        ? {
            pruned: {
              deleted: result.pruned.deleted,
              failed: result.pruned.failed,
              skipped: result.pruned.skipped,
              ...(result.pruned.deleted > 0 ? describePlan(result.pruned) : result.pruned.deferredUntil !== undefined ? { deferredUntil: new Date(result.pruned.deferredUntil).toISOString() } : {}),
            },
          }
        : {}),
    });
  },

  async point() {
    const name = requireName();
    const content = values.content ?? fail('point needs --content');
    const writer = await EvoWriter.connectAs(network(), credentials());
    print(await publishPointer(writer, name, content));
  },

  async unpublish() {
    const name = requireName();
    const writer = await EvoWriter.connectAs(network(), credentials());
    const domain = await requireOwnedName(writer, name);
    print({ removed: await writer.deleteSite(domain.id) });
  },

  async gc() {
    const writer = await EvoWriter.connectAs(network(), credentials());
    const plan = await planPrune(writer, { graceMs: graceMs() });
    if (values['dry-run']) return print({ dryRun: true, ...describePlan(plan) });
    const before = await writer.balance();
    console.error('checking the site records again from a newer block before deleting (a few minutes)');
    const result = await prune(writer, plan, (hash) => console.error(`deleted chunk ${hash}`));
    print({ deleted: result.deleted, failed: result.failed, skipped: result.skipped, refunded: formatDash((await writer.balance()) - before) });
  },

  async register() {
    const label = positionals[1] ?? fail('register needs a label');
    const writer = await EvoWriter.connectAs(network(), credentials());
    print(await writer.registerName(label));
  },

  async names() {
    const who = credentials();
    const reader = await EvoReader.connect(network());
    print((await reader.listOwnedNames(who.identityId)).map((domain) => `${domain.label}.dash`));
  },

  async resolve() {
    const name = positionals[1] ?? fail('resolve needs a name');
    print(await resolveName(await EvoReader.connect(network()), name));
  },

  async fetch() {
    const name = positionals[1] ?? fail('fetch needs a name');
    const reader = await EvoReader.connect(network());
    const resolution = await resolveName(reader, name);
    if (resolution.status !== 'ok' || resolution.content.scheme !== 'dash-manifest') fail(`${name} does not resolve to a site stored on Platform (${resolution.status})`);
    const source = siteChunks(reader, resolution);
    const manifest = await loadManifest(resolution.content, source);
    const decision = decide(manifest, positionals[2] ?? '/');
    if (decision.kind !== 'file') fail(`no file at ${positionals[2] ?? '/'}`);
    const { fetchers } = outside(resolution.canonicalLabel);
    const { bytes } = await readFile(manifest, decision.path, source, { elsewhere: (path, file) => readElsewhere(path, file, fetchers) });
    if (values.output) writeFileSync(values.output, bytes);
    else await new Promise<void>((resolve, reject) => process.stdout.write(bytes, (error) => (error ? reject(error) : resolve())));
  },

  async check() {
    const name = positionals[1] ?? fail('check needs a name');
    const reader = await EvoReader.connect(network());
    const resolution = await resolveName(reader, name);
    if (resolution.status !== 'ok' || resolution.content.scheme !== 'dash-manifest') fail(`${name} does not resolve to a site stored on Platform (${resolution.status})`);
    const manifest = await loadManifest(resolution.content, siteChunks(reader, resolution));
    const unread = Object.entries(manifest.files).filter(([, file]) => file.unread);
    for (const [path, file] of unread) console.log(`FAIL ${path}  ${file.unread}`);
    if (unread.length > 0) process.exitCode = 1;
    const count = Object.values(manifest.files).filter((file) => file.src).length;
    if (count === 0) return console.log(unread.length > 0 ? 'some files are stored in a form this version cannot read' : `${resolution.canonicalLabel}.dash keeps every file on Platform`);
    const good = await checkPlaces(manifest.files, outside(resolution.canonicalLabel).fetchers, (line) => console.log(line));
    console.log(good ? `every one of the ${count} files kept outside Platform can be loaded` : 'some files cannot be loaded from any place they list');
    if (!good) process.exitCode = 1;
  },

  async gateway() {
    await serve(await EvoReader.connect(network()));
  },

  async preview() {
    const dir = positionals[1] ?? fail('preview needs a directory');
    const label = (parseName(values.name ?? 'preview') ?? fail('--name must be a DPNS name such as alice')).label;
    const platform = new MemoryPlatform();
    platform.registerName(label, 'preview-identity');
    const writer = platform.as('preview-identity');
    await publishSite(writer, label, buildSite(await readSiteDirectory(dir), buildOptions()));
    await serve(writer, `http://${label.toLowerCase()}.${values.domain}:${values.port}/`);
  },

  async contract() {
    if (positionals[1] !== 'register') fail('usage: dash-sites contract register --schema <file>');
    const schema = JSON.parse(readFileSync(values.schema ?? fail('contract register needs --schema'), 'utf8'));
    if (values.network !== 'testnet' && values.network !== 'mainnet') fail('--network must be testnet or mainnet');
    print({ contractId: await registerContract(values.network, credentials('CRITICAL'), schema) });
  },
};

const command = commands[positionals[0] ?? ''];
if (values.help || !command) {
  console.log(USAGE);
  process.exit(values.help || positionals.length === 0 ? 0 : 1);
}
command().then(
  () => {
    if (places?.ipfsStarted()) process.exit(process.exitCode ?? 0);
  },
  (error: unknown) => fail(String((error as Error)?.message ?? error)),
);
