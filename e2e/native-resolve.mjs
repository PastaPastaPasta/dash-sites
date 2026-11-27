// Resolves a name the way the extension does, in Node: verify the chain from the bundled checkpoint,
process.on('uncaughtException', (e) => { console.log('UNCAUGHT', e?.message ?? e, String(e?.stack ?? '').split('\n').slice(0,3).map(l=>l.slice(0,200)).join(' | ')); process.exit(2); });
process.on('unhandledRejection', (e) => { console.log('UNHANDLED', e?.message ?? e); process.exit(2); });
// prove the quorum keys, then read the name with proofs. Fails if any request goes to a host name.
//   node e2e/native-resolve.mjs [name] [network]
import { readerConfig, resolveName } from '@dash-sites/core';
import { CHECKPOINTS, SEEDS, syncChain } from '@dash-sites/core/chain';
import { EvoReader } from '@dash-sites/core/evo';

const name = process.argv[2] ?? 'dash';
const network = process.argv[3] ?? 'mainnet';
const hosts = new Set();
const real = globalThis.fetch.bind(globalThis);
globalThis.fetch = (input, init) => {
  hosts.add(new URL(input instanceof Request ? input.url : String(input)).hostname);
  return real(input, init);
};

const started = Date.now();
let snapshot = await syncChain({ network, checkpoint: CHECKPOINTS[network], seeds: SEEDS[network], onProgress: (m) => console.log(`  ${m}`) });
console.log(`chain ${snapshot.chain.height}, list ${snapshot.listHeight}, ${snapshot.quorums.length} quorums, ${snapshot.nodes.length} nodes, ${Date.now() - started} ms`);
let refreshes = 0;
const source = async () => {
  if (Date.now() - snapshot.syncedAt > 30000) {
    refreshes++;
    snapshot = await syncChain({ network, checkpoint: CHECKPOINTS[network], seeds: SEEDS[network], previous: snapshot });
  }
  return snapshot;
};
const pick = [...snapshot.nodes].sort(() => Math.random() - 0.5).slice(0, 12);
let resolution;
try {
  const reader = await EvoReader.connect(readerConfig(network), { addresses: pick, quorums: source });
  resolution = await resolveName(reader, name);
} catch (error) {
  console.log('FAILED', error?.message ?? String(error), error?.kind ?? '', String(error?.stack ?? '').slice(0, 300));
  console.log('hosts', [...hosts].join(' '));
  process.exit(1);
}
console.log(JSON.stringify({ status: resolution.status, owner: resolution.ownerId, revision: resolution.site?.revision, height: resolution.meta?.height }));
const named = [...hosts].filter((host) => !/^(\d+\.\d+\.\d+\.\d+|\[[0-9a-f:]+\])$/i.test(host) && host !== 'quorums.dash-sites.invalid');
console.log(`hosts contacted: ${hosts.size}; by name: ${named.join(', ') || 'none'}; quorum refreshes: ${refreshes}`);
if (named.length || resolution.status === 'invalid') process.exit(1);
process.exit(0);
