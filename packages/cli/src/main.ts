import { readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { parseArgs } from 'node:util';
import {
  buildSite,
  collectGarbage,
  estimateCredits,
  formatDash,
  loadManifest,
  networkConfig,
  parseName,
  publishPointer,
  publishSite,
  readElsewhere,
  readFile,
  decide,
  requireOwnedName,
  resolveName,
  type Network,
  type NetworkConfig,
  type PlatformReader,
} from '@dash-sites/core';
import { MemoryPlatform } from '@dash-sites/core/memory';
import { EvoReader, EvoWriter, registerContract, type Credentials } from '@dash-sites/core/evo';
import { createGateway, emptyDenylist, parseDomain } from '@dash-sites/gateway';
import { readSiteDirectory } from './files.js';
import { checkPlaces, cliPlaces, parsePlaceMap, storeElsewhere, type CliPlaces } from './places.js';

const USAGE = `dash-sites: websites on Dash Platform names

  dash-sites publish <dir> --name <name> [--spa] [--dry-run]   publish a folder as <name>.dash
      [--elsewhere <file>]                                     keep some files outside Platform (see below)
  dash-sites check <name>                                      ask every outside place of a site for its file
  dash-sites point --name <name> --content ipfs://<cid>        point a name at content stored elsewhere
  dash-sites unpublish --name <name>                           remove the site record
  dash-sites gc                                                delete stored chunks no site uses
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
    const bundle = buildSite(files, { spa: values.spa });
    const { elsewhere } = bundle.stats;
    console.error(`${bundle.stats.files - elsewhere.files} files, ${bundle.stats.bytes} bytes (${bundle.stats.storedBytes} stored) in ${bundle.stats.chunks} chunks`);
    if (elsewhere.files > 0) console.error(`${elsewhere.files} files, ${elsewhere.bytes} bytes kept outside Platform`);
    if (!bundle.manifest.files['/index.html']) console.error('warning: the site has no /index.html');
    console.error(`estimated cost if nothing is stored yet: ${formatDash(estimateCredits(bundle))}`);
    if (values['dry-run']) return print({ content: bundle.contentUri, stats: bundle.stats });
    const writer = await EvoWriter.connectAs(network(), credentials());
    const result = await publishSite(writer, name, bundle, (progress) => {
      if (progress.step === 'upload') console.error(`uploaded chunk ${progress.done}/${progress.total}`);
    });
    print({ name: `${parseName(name)?.label}.dash`, content: result.site.content, revision: result.site.revision, uploaded: result.uploaded, reused: result.reused, spent: formatDash(result.creditsSpent) });
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
    const before = await writer.balance();
    const deleted = await collectGarbage(writer, (hash) => console.error(`deleted chunk ${hash}`));
    print({ deleted, refunded: formatDash((await writer.balance()) - before) });
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
    const source = (hashes: string[]) => reader.getChunks(resolution.ownerId, hashes);
    const manifest = await loadManifest(resolution.content, source);
    const decision = decide(manifest, positionals[2] ?? '/');
    if (decision.kind !== 'file') fail(`no file at ${positionals[2] ?? '/'}`);
    const { fetchers } = outside(resolution.canonicalLabel);
    const { bytes } = await readFile(manifest, decision.path, source, (path, file) => readElsewhere(path, file, fetchers));
    if (values.output) writeFileSync(values.output, bytes);
    else await new Promise<void>((resolve, reject) => process.stdout.write(bytes, (error) => (error ? reject(error) : resolve())));
  },

  async check() {
    const name = positionals[1] ?? fail('check needs a name');
    const reader = await EvoReader.connect(network());
    const resolution = await resolveName(reader, name);
    if (resolution.status !== 'ok' || resolution.content.scheme !== 'dash-manifest') fail(`${name} does not resolve to a site stored on Platform (${resolution.status})`);
    const manifest = await loadManifest(resolution.content, (hashes) => reader.getChunks(resolution.ownerId, hashes));
    const count = Object.values(manifest.files).filter((file) => file.src).length;
    if (count === 0) return console.log(`${resolution.canonicalLabel}.dash keeps every file on Platform`);
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
    await publishSite(writer, label, buildSite(await readSiteDirectory(dir), { spa: values.spa }));
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
