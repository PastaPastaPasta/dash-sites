#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const USAGE = `quick-dash-site: put a folder live on a .dash name, signed in with DashPay

  quick-dash-site.mjs cli                                   print the dash-sites CLI path (builds it once if needed)
  quick-dash-site.mjs start <dir> --name <label> [--fresh]  show the cost, then the sign-in QR code and link
  quick-dash-site.mjs finish <dir> --name <label>           wait for wallet approval, publish, verify, print the URL

Options
  --network mainnet|testnet   default mainnet
  --fresh                     ask the wallet again even if a saved sign-in works

Environment
  DASH_SITES_CLI              path to dash-sites.mjs (skips the lookup and build)
  DASH_SITES_CONFIG_DIR       where the CLI keeps the wallet sign-in (default ~/.config/dash-sites)
`;

const REPO = 'https://github.com/PastaPastaPasta/dash-sites.git';
const here = dirname(fileURLToPath(import.meta.url));

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    name: { type: 'string' },
    network: { type: 'string', default: 'mainnet' },
    fresh: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

function say(line = '') {
  process.stdout.write(`${line}\n`);
}

const network = values.network;
if (network !== 'mainnet' && network !== 'testnet') fail('--network must be mainnet or testnet');

function siteUrl(label) {
  return network === 'mainnet' ? `https://${label}.dash.site/` : `https://${label}.id.dashhq.org/`;
}

function label() {
  const raw = (values.name ?? fail('pass --name <label> (a .dash name the wallet owns)')).trim().toLowerCase().replace(/\.dash$/, '');
  if (!/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/.test(raw)) fail(`${values.name} is not a DPNS label`);
  return raw;
}

function siteDir() {
  const dir = resolve(positionals[1] ?? fail('pass the site folder'));
  if (!existsSync(join(dir, 'index.html'))) fail(`${dir} has no index.html`);
  return dir;
}

function stateDir(name) {
  const base = process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state');
  const dir = join(base, 'quick-dash-site', `${network}-${name}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function cliPath() {
  if (process.env.DASH_SITES_CLI) {
    if (!existsSync(process.env.DASH_SITES_CLI)) fail(`DASH_SITES_CLI points at ${process.env.DASH_SITES_CLI}, which does not exist`);
    return process.env.DASH_SITES_CLI;
  }
  const inRepo = resolve(here, '../../../packages/cli/bundle/dash-sites.mjs');
  if (existsSync(inRepo)) return inRepo;
  const cache = join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'quick-dash-site', 'dash-sites');
  const bundle = join(cache, 'packages/cli/bundle/dash-sites.mjs');
  if (existsSync(bundle)) return bundle;
  console.error('building the dash-sites CLI once (about a minute)…');
  const steps = [
    ['git', ['clone', '--depth', '1', REPO, cache]],
    ['npm', ['ci', '--no-audit', '--no-fund'], cache],
    ['npx', ['tsc', '-b', 'packages/core', 'packages/gateway', 'packages/cli'], cache],
    ['npm', ['run', 'bundle', '-w', '@dash-sites/cli'], cache],
  ];
  if (existsSync(join(cache, '.git'))) steps.shift();
  for (const [cmd, args, cwd] of steps) {
    const run = spawnSync(cmd, args, { cwd, stdio: ['ignore', 'ignore', 'inherit'] });
    if (run.status !== 0) fail(`${cmd} ${args.join(' ')} failed`);
  }
  return bundle;
}

function cli(args, options = {}) {
  return spawnSync(process.execPath, [cliPath(), ...args, '--network', network], { encoding: 'utf8', maxBuffer: 64 << 20, ...options });
}

function json(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function clock(ms) {
  const date = new Date(ms);
  const local = date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
  return `${local} (${date.toISOString().slice(11, 16)} UTC)`;
}

function estimate(dir, name) {
  const run = cli(['publish', dir, '--name', name, '--brotli', '--dry-run']);
  if (run.status !== 0) fail(`dry run failed:\n${run.stderr.trim()}`);
  const lines = run.stderr.split('\n').map((line) => line.trim()).filter(Boolean);
  return {
    size: lines.find((line) => /\bfiles?, \d+ bytes/.test(line)),
    cost: lines.find((line) => line.startsWith('estimated cost'))?.replace(/^estimated cost if nothing is stored yet: /, ''),
    warnings: lines.filter((line) => line.startsWith('warning:')),
  };
}

function signedInFor(name) {
  const run = cli(['whoami']);
  const who = run.status === 0 ? json(run.stdout) : undefined;
  return who && Array.isArray(who.names) && who.names.includes(`${name}.dash`) ? who : undefined;
}

async function waitForRequest(logFile, pid) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const log = existsSync(logFile) ? readFileSync(logFile, 'utf8') : '';
    const uri = log.match(/dashpay:\/\/\S+/)?.[0];
    if (uri) {
      const qr = log.split('\n').filter((line) => line.length > 10 && /^[█▀▄ ]+$/.test(line));
      return { uri, qr: qr.join('\n') };
    }
    if (!alive(pid)) fail(`sign-in did not start:\n${log.trim()}`);
    await new Promise((done) => setTimeout(done, 250));
  }
  fail('sign-in did not start within 90 seconds');
}

async function start() {
  const dir = siteDir();
  const name = label();
  const state = stateDir(name);

  const plan = estimate(dir, name);
  say(`Site: ${dir}`);
  say(`Name: ${name}.dash on ${network} -> ${siteUrl(name)}`);
  if (plan.size) say(`Size: ${plan.size}`);
  say(`Estimated cost: ${plan.cost ?? 'unknown (fee model did not load)'} (Platform storage fees, paid from the identity's credits)`);
  for (const warning of plan.warnings) say(warning);

  const previous = json(existsSync(join(state, 'request.json')) ? readFileSync(join(state, 'request.json'), 'utf8') : '');
  if (previous?.pid && alive(previous.pid)) process.kill(previous.pid, 'SIGINT');
  rmSync(join(state, 'request.json'), { force: true });

  if (!values.fresh) {
    const who = signedInFor(name);
    if (who) {
      say('');
      say(`Already signed in as ${who.identityId}, which owns ${name}.dash. No QR code needed.`);
      say(`Next: node ${fileURLToPath(import.meta.url)} finish ${dir} --name ${name}${network === 'mainnet' ? '' : ` --network ${network}`}`);
      return;
    }
  }

  const logFile = join(state, 'login.log');
  const outFile = join(state, 'login.json');
  const svgFile = join(state, 'login-qr.svg');
  rmSync(outFile, { force: true });
  const errFd = openSync(logFile, 'w', 0o600);
  const outFd = openSync(outFile, 'w', 0o600);
  const child = spawn(process.execPath, [cliPath(), 'login', '--name', name, '--qr', svgFile, '--network', network], {
    detached: true,
    stdio: ['ignore', outFd, errFd],
    env: { ...process.env, NO_COLOR: '1' },
  });
  child.unref();
  closeSync(errFd);
  closeSync(outFd);

  const { uri, qr } = await waitForRequest(logFile, child.pid);
  const expiresAt = Date.now() + 10 * 60_000;
  writeFileSync(join(state, 'request.json'), `${JSON.stringify({ pid: child.pid, expiresAt, name, network, dir })}\n`, { mode: 0o600 });

  say('');
  say('Scan with DashPay (More -> Tools -> Connections -> Scan QR):');
  say('```');
  say(qr);
  say('```');
  say(`[Open in DashPay](${uri})`);
  say('');
  say(uri);
  say('');
  say(`QR code image: ${svgFile}`);
  say(`Expires at ${clock(expiresAt)}. The wallet gives this tool a key that can only write dash-sites records.`);
  say(`Next: node ${fileURLToPath(import.meta.url)} finish ${dir} --name ${name}${network === 'mainnet' ? '' : ` --network ${network}`}`);
}

async function finish() {
  const dir = siteDir();
  const name = label();
  const state = stateDir(name);
  const request = json(existsSync(join(state, 'request.json')) ? readFileSync(join(state, 'request.json'), 'utf8') : '');

  if (request?.pid) {
    if (alive(request.pid)) console.error(`waiting for wallet approval (code expires at ${clock(request.expiresAt)})…`);
    while (alive(request.pid)) await new Promise((done) => setTimeout(done, 500));
    const grant = json(readFileSync(join(state, 'login.json'), 'utf8'));
    rmSync(join(state, 'request.json'), { force: true });
    if (!grant?.identityId) {
      const log = readFileSync(join(state, 'login.log'), 'utf8').split('\n').filter((line) => line && !/^[█▀▄ ]+$/.test(line) && !line.startsWith('dashpay://'));
      fail(`sign-in did not finish: ${log.slice(-3).join(' / ')}\nRun start again for a new code.`);
    }
    say(`Signed in: ${grant.identityId} (${grant.names.join(', ') || 'no names'}), allowance ${grant.remainingBudget}`);
  } else if (!signedInFor(name)) {
    fail('not signed in; run start first');
  }

  console.error(`publishing to ${name}.dash on ${network}…`);
  const published = cli(['publish', dir, '--name', name, '--brotli'], { stdio: ['ignore', 'pipe', 'inherit'] });
  const result = json(published.stdout);
  if (published.status !== 0 || !result?.content) fail('publish failed (see above)');
  say(`Published ${result.name} revision ${result.revision}: ${result.uploaded} chunks uploaded, ${result.reused} reused, spent ${result.spent}`);

  const check = json(cli(['resolve', name]).stdout);
  if (check?.site?.content !== result.content) fail(`published, but ${name}.dash does not resolve to the new content yet; try: dash-sites resolve ${name} --network ${network}`);
  say('Verified on Platform with proofs.');
  say('');
  say(`LIVE: ${siteUrl(name)}`);
}

const commands = {
  cli: async () => say(cliPath()),
  start,
  finish,
};

if (values.help || !commands[positionals[0]]) {
  process.stdout.write(USAGE);
  process.exit(values.help ? 0 : 1);
}
await commands[positionals[0]]();
