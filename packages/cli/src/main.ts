import { readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline/promises';
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
  fromHex,
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
  readerConfig,
  decide,
  resolveName,
  siteChunks,
  unpublishSite,
  type Network,
  type NetworkConfig,
  type PlatformReader,
  type SiteBundle,
} from '@dash-sites/core';
import { connectPort } from '@dash-sites/core/connect';
import { MemoryPlatform } from '@dash-sites/core/memory';
import { connectSdk, EvoReader, EvoWriter, KeyRefused, registerContract, type Credentials } from '@dash-sites/core/evo';
import { createGateway, emptyDenylist, parseDomain } from '@dash-sites/gateway';
import { readSiteDirectory } from './files.js';
import { checkPlaces, cliPlaces, parsePlaceMap, storeElsewhere, type CliPlaces } from './places.js';
import { clearSession, configDir, connectionId, loadSession, qrSvg, qrTerminal, runWalletLogin, saveSession, sessionPath } from './wallet.js';

const USAGE = `dash-sites: websites on Dash Platform names

  dash-sites login [--name <name>] [--identity <id>] [--qr <file.svg>] [--yes]
                                                               sign in with DashPay mobile wallet for a limited key
  dash-sites whoami                                            show the signed-in identity, names and key allowance
  dash-sites logout                                            remove the saved wallet login for this network
  dash-sites publish <dir> --name <name> [--spa] [--prune] [--brotli] [--external <file>] [--elsewhere <file>] [--dry-run]
                                                               publish a folder as <name>.dash
  dash-sites check <name>                                      ask every outside place of a site for its file
  dash-sites point --name <name> --content ipfs://<cid>        point a name at content stored elsewhere
  dash-sites unpublish --name <name>                           take the site down
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
  --identity <id>               identity id; the key comes from DASH_SITES_KEY (WIF), or pins login
  --qr <file>                   also write the login QR code as an SVG file
  -y, --yes                     skip the interactive confirmation prompt on login
  --prune                       after publishing, delete chunks of releases before the one replaced
  --grace <hours>               gc and --prune delete nothing until every site record is this old, and keep chunks younger than this (default 25)
  --brotli                      store a file as brotli when that is smaller than gzip (needs a current shell)
  --external <file>             JSON {"/site/path": {"npm": "pkg", "version": "1.2.3", "path": "dist/file"}}:
                                files not stored, fetched by readers from npm CDNs and checked by SHA-384

Environment
  DASH_SITES_KEY                WIF of an AUTHENTICATION key (HIGH or CRITICAL) of the identity
  DASH_SITES_CONFIG_DIR         directory for saved wallet logins (default $XDG_CONFIG_HOME/dash-sites or ~/.config/dash-sites)

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

interface ResolvedCredentials {
  credentials: Credentials;
  source: 'identity-file' | 'env' | 'wallet-session';
  sessionFile?: string;
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
    qr: { type: 'string' },
    yes: { type: 'boolean', short: 'y', default: false },
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

function network(reading = false): NetworkConfig {
  if (values.network !== 'testnet' && values.network !== 'mainnet') fail('--network must be testnet or mainnet');
  return (reading ? readerConfig : networkConfig)(values.network as Network, values.contract);
}

function resolveCredentials(level: 'HIGH' | 'CRITICAL' = 'HIGH'): ResolvedCredentials {
  const file = values['identity-file'];
  if (file) {
    const identity = JSON.parse(readFileSync(file, 'utf8')) as IdentityFile;
    const key = identity.identityKeys?.find((k) => k.purpose === 'AUTHENTICATION' && k.securityLevel === level);
    if (!identity.identityId || !key) fail(`${file} has no identity id or no AUTHENTICATION/${level} key`);
    return { credentials: { identityId: identity.identityId, privateKeyWif: key.privateKeyWif }, source: 'identity-file' };
  }
  const privateKeyWif = process.env.DASH_SITES_KEY;
  if (values.identity || privateKeyWif) {
    if (!values.identity || !privateKeyWif) fail('pass both --identity and DASH_SITES_KEY');
    return { credentials: { identityId: values.identity, privateKeyWif }, source: 'env' };
  }
  if (level === 'HIGH') {
    const config = network();
    const dir = configDir();
    const saved = loadSession(dir, config.network);
    if (saved) {
      if (saved.contractId !== config.contractId) {
        fail(`saved wallet login for ${config.network} is for contract ${saved.contractId}, not ${config.contractId}; run "dash-sites login --network ${config.network}"`);
      }
      if (saved.expiresAt <= Date.now()) {
        fail(`saved wallet login for ${config.network} expired on ${new Date(saved.expiresAt).toISOString()}; run "dash-sites login --network ${config.network}"`);
      }
      return {
        credentials: { identityId: saved.identityId, privateKey: fromHex(saved.privateKey) },
        source: 'wallet-session',
        sessionFile: sessionPath(dir, config.network),
      };
    }
    fail(`not signed in on ${config.network}; run "dash-sites login --network ${config.network}", or pass --identity-file or --identity with DASH_SITES_KEY`);
  }
  fail('pass --identity-file, or --identity with DASH_SITES_KEY set');
}

async function withWriter<T>(run: (writer: EvoWriter, resolved: ResolvedCredentials) => Promise<T>): Promise<T> {
  const config = network();
  const resolved = resolveCredentials('HIGH');
  let writer: EvoWriter;
  try {
    writer = await EvoWriter.connectAs(config, resolved.credentials);
  } catch (error) {
    if (error instanceof KeyRefused && resolved.source === 'wallet-session') {
      fail(`saved wallet login for ${config.network} is no longer valid (${error.message}); run "dash-sites login --network ${config.network}"`);
    }
    throw error;
  } finally {
    resolved.credentials.privateKey?.fill(0);
  }
  try {
    return await run(writer, resolved);
  } finally {
    writer.forget();
  }
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

/** The site a name shows, with its manifest, or the reason it has none that this version reads. */
async function storedSite(name: string) {
  const reader = await EvoReader.connect(network(true));
  const resolution = await resolveName(reader, name, { preload: true });
  if (resolution.status !== 'ok' || resolution.content.scheme !== 'dash-manifest') {
    const why = resolution.status === 'unsupported' ? `${resolution.status}: ${resolution.reason === 'newer' ? 'a newer format than this version reads' : 'content this project does not define'}` : resolution.status;
    return fail(`${name} does not resolve to a site stored on Platform (${why})`);
  }
  const source = siteChunks(reader, resolution);
  return { resolution, source, manifest: await loadManifest(resolution.content, source) };
}

async function promptConfirm(question: string, signal: AbortSignal): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await rl.question(question, { signal });
    return /^y(?:es)?$/i.test(answer.trim());
  } catch (error) {
    if ((error as Error)?.name === 'AbortError') throw new DOMException('cancelled', 'AbortError');
    throw error;
  } finally {
    rl.close();
  }
}

const commands: Record<string, () => Promise<void>> = {
  async login() {
    const config = network();
    const parsedName = values.name ? (parseName(values.name) ?? fail('--name must be a DPNS name such as alice or alice.dash')) : undefined;
    const pinnedIdentity = values.identity?.trim() || undefined;
    const needsConfirm = !values.yes && !parsedName && !pinnedIdentity;
    if (needsConfirm && !process.stdin.isTTY) {
      fail('cannot confirm the answering identity without a terminal; pass --name <name>, --identity <id>, or --yes');
    }

    const abort = new AbortController();
    const onSigint = (): void => abort.abort();
    process.on('SIGINT', onSigint);
    try {
      console.error(`connecting to Dash Platform (${config.network})…`);
      const sdk = await connectSdk(config);
      const reader = new EvoReader(sdk, config);
      let expectedIdentityId = pinnedIdentity;
      let expectedName: string | undefined;
      if (parsedName) {
        const domain = (await reader.getDomain(parsedName.normalized)).value;
        if (!domain) fail(`${parsedName.label}.dash is not registered on ${config.network}`);
        if (expectedIdentityId && domain.ownerId !== expectedIdentityId) {
          fail(`${parsedName.label}.dash is owned by ${domain.ownerId}, not ${expectedIdentityId}`);
        }
        expectedIdentityId = domain.ownerId;
        expectedName = domain.label;
      }

      const dir = configDir();
      let lastStatus: string | undefined;
      const result = await runWalletLogin({
        config,
        port: connectPort(sdk),
        connectionId: connectionId(dir, config.network),
        ...(expectedIdentityId ? { expectedIdentityId } : {}),
        ...(expectedName ? { expectedName } : {}),
        signal: abort.signal,
        onRequest: (pending) => {
          const useColor = Boolean(process.stderr.isTTY && !process.env.NO_COLOR);
          console.error('');
          console.error(qrTerminal(pending.uri, { color: useColor }));
          console.error('');
          console.error('Scan with DashPay (More -> Tools -> Connections -> Scan QR), or open:');
          console.error(pending.uri);
          if (values.qr) {
            writeFileSync(values.qr, qrSvg(pending.uri));
            console.error(`wrote QR SVG to ${values.qr}`);
          }
          console.error('Code expires in 10 minutes. Waiting for wallet approval…');
        },
        onStatus: (status) => {
          if (status === lastStatus) return;
          lastStatus = status;
          if (status === 'answered') console.error('wallet answered; checking key…');
          else if (status === 'incomplete-read') console.error('could not read every answer; trying again…');
        },
        listOwnedNames: (identityId) => reader.listOwnedNames(identityId),
        ...(needsConfirm
          ? {
              confirm: async (grant, owned) => {
                const ownedNames = owned.length > 0 ? owned.map((domain) => `${domain.label}.dash`).join(', ') : '(no registered names)';
                const until = new Date(grant.expiresAt).toISOString().slice(0, 10);
                console.error(`\nWallet answered:`);
                console.error(`  identity:  ${grant.identityId}`);
                console.error(`  names:     ${ownedNames}`);
                console.error(`  allowance: ${formatDash(grant.remainingBudget)} until ${until}`);
                return promptConfirm('Save this wallet login? [y/N] ', abort.signal);
              },
            }
          : {}),
        verifyWriter: async (identityId, privateKey) => {
          const connected = await EvoWriter.on(sdk, config, { identityId, privateKey });
          connected.forget();
        },
        save: (session) => saveSession(dir, session),
      });

      print({
        network: result.network,
        identityId: result.identityId,
        names: result.names,
        keyId: result.keyId,
        totalBudget: formatDash(result.totalBudget),
        remainingBudget: formatDash(result.remainingBudget),
        expiresAt: new Date(result.expiresAt).toISOString(),
        sessionFile: result.sessionFile,
      });
    } finally {
      process.off('SIGINT', onSigint);
    }
  },

  async whoami() {
    const config = network();
    await withWriter(async (writer, resolved) => {
      const [owned, balance, remaining] = await Promise.all([
        writer.listOwnedNames(writer.identityId),
        writer.balance(),
        writer.remainingBudget().catch(() => undefined),
      ]);
      const { keyId, bound, totalBudget, expiresAt } = writer.keyLimits;
      print({
        network: config.network,
        source: resolved.source,
        identityId: writer.identityId,
        names: owned.map((domain) => `${domain.label}.dash`),
        balance: formatDash(balance),
        keyId,
        bound,
        ...(totalBudget !== undefined ? { totalBudget: formatDash(totalBudget) } : {}),
        ...(remaining !== undefined ? { remainingBudget: formatDash(remaining) } : {}),
        ...(expiresAt !== undefined ? { expiresAt: new Date(expiresAt).toISOString() } : {}),
        ...(resolved.sessionFile ? { sessionFile: resolved.sessionFile } : {}),
      });
    });
  },

  async logout() {
    const config = network();
    const removed = clearSession(configDir(), config.network);
    if (removed) {
      console.error('removed saved session; to revoke the key immediately before it expires, remove "Dash Sites" in your wallet\'s Connections screen');
    }
    print({ network: config.network, removed });
  },

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
    await withWriter(async (writer) => {
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
    });
  },

  async point() {
    const name = requireName();
    const content = values.content ?? fail('point needs --content');
    await withWriter(async (writer) => {
      print(await publishPointer(writer, name, content));
    });
  },

  async unpublish() {
    const name = requireName();
    await withWriter(async (writer) => {
      print({ removed: await unpublishSite(writer, name) });
    });
  },

  async gc() {
    await withWriter(async (writer) => {
      const plan = await planPrune(writer, { graceMs: graceMs() });
      if (values['dry-run']) return print({ dryRun: true, ...describePlan(plan) });
      const before = await writer.balance();
      console.error('checking the site records again from a newer block before deleting (a few minutes)');
      const result = await prune(writer, plan, (hash) => console.error(`deleted chunk ${hash}`));
      print({ deleted: result.deleted, failed: result.failed, skipped: result.skipped, refunded: formatDash((await writer.balance()) - before) });
    });
  },

  async register() {
    const label = positionals[1] ?? fail('register needs a label');
    await withWriter(async (writer) => {
      print(await writer.registerName(label));
    });
  },

  async names() {
    const resolved = resolveCredentials();
    try {
      const reader = await EvoReader.connect(network(true));
      print((await reader.listOwnedNames(resolved.credentials.identityId)).map((domain) => `${domain.label}.dash`));
    } finally {
      resolved.credentials.privateKey?.fill(0);
    }
  },

  async resolve() {
    const name = positionals[1] ?? fail('resolve needs a name');
    print(await resolveName(await EvoReader.connect(network(true)), name));
  },

  async fetch() {
    const { resolution, source, manifest } = await storedSite(positionals[1] ?? fail('fetch needs a name'));
    const decision = decide(manifest, positionals[2] ?? '/');
    if (decision.kind !== 'file') fail(`no file at ${positionals[2] ?? '/'}`);
    const { fetchers } = outside(resolution.canonicalLabel);
    const { bytes } = await readFile(manifest, decision.path, source, { elsewhere: (path, file) => readElsewhere(path, file, fetchers) });
    if (values.output) writeFileSync(values.output, bytes);
    else await new Promise<void>((resolve, reject) => process.stdout.write(bytes, (error) => (error ? reject(error) : resolve())));
  },

  async check() {
    const { resolution, manifest } = await storedSite(positionals[1] ?? fail('check needs a name'));
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
    await serve(await EvoReader.connect(network(true)));
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
    print({ contractId: await registerContract(values.network, resolveCredentials('CRITICAL').credentials, schema) });
  },
};

const command = commands[positionals[0] ?? ''];
if (values.help || !command) {
  console.log(USAGE);
  process.exit(values.help || positionals.length === 0 ? 0 : 1);
}
command().then(
  async () => {
    if (!places?.ipfsStarted()) return;
    for (const stream of [process.stdout, process.stderr]) await new Promise((written) => stream.write('', written));
    process.exit(process.exitCode ?? 0);
  },
  (error: unknown) => fail(String((error as Error)?.message ?? error)),
);
