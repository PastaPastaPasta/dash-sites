import { readFileSync, watchFile } from 'node:fs';
import { createServer } from 'node:http';
import { MAX_FILES, readerConfig, type Network } from '@dash-sites/core';
import { EvoReader } from '@dash-sites/core/evo';
import { emptyDenylist, parseDenylist, parseDomain, type GatewayConfig } from './config.js';
import { createGateway } from './server.js';

const env = process.env;
const list = (value: string | undefined): string[] => (value ?? '').split(',').map((item) => item.trim()).filter(Boolean);
const number = (value: string | undefined, fallback: number): number => (value === undefined || value === '' ? fallback : Number(value));

function peerFromEnv(value: string | undefined): GatewayConfig['peer'] {
  const [network, url] = (value ?? '').trim().split(/\s+/);
  if (!network || !url) return undefined;
  try {
    if (/^https?:$/.test(new URL(url).protocol)) return { network, url };
  } catch {
    // reported below
  }
  console.log(JSON.stringify({ event: 'peer-gateway-ignored', value }));
  return undefined;
}

export function configFromEnv(): GatewayConfig {
  const domains = list(env.GATEWAY_DOMAINS ?? 'http://localhost:8080').map(parseDomain);
  const network = (env.NETWORK ?? 'testnet') as Network;
  return {
    domains,
    reservedLabels: new Set(list(env.RESERVED_LABELS)),
    builderUrl: env.BUILDER_URL ?? 'https://github.com/PastaPastaPasta/dash-sites',
    extensionUrl: env.EXTENSION_URL ?? 'https://github.com/PastaPastaPasta/dash-sites/releases',
    abuseContact: env.ABUSE_CONTACT ?? 'see the repository',
    network,
    sitesLive: readerConfig(network, env.CONTRACT_ID).contractId !== '',
    peer: peerFromEnv(env.PEER_GATEWAY),
    denylist: env.DENYLIST_FILE ? parseDenylist(readFileSync(env.DENYLIST_FILE, 'utf8')) : emptyDenylist(),
    maxSiteBytes: number(env.MAX_SITE_BYTES, 25 * 1024 * 1024),
    maxFiles: number(env.MAX_FILES, MAX_FILES),
    rateLimitPerMinute: number(env.RATE_LIMIT_PER_MINUTE, 600),
    trustProxy: env.TRUST_PROXY === '1',
    chunkCacheBytes: number(env.CHUNK_CACHE_MB, 256) * 1024 * 1024,
  };
}

async function main(): Promise<void> {
  const config = configFromEnv();
  const network = readerConfig(config.network as Network, env.CONTRACT_ID);
  const denylistFile = env.DENYLIST_FILE;
  if (denylistFile) {
    watchFile(denylistFile, { interval: 5000 }, () => {
      try {
        config.denylist = parseDenylist(readFileSync(denylistFile, 'utf8'));
        console.log(JSON.stringify({ event: 'denylist-reloaded', names: config.denylist.names.size, owners: config.denylist.owners.size, content: config.denylist.content.size }));
      } catch (error) {
        console.log(JSON.stringify({ event: 'denylist-rejected', error: String((error as Error)?.message ?? error) }));
      }
    });
  }
  const reader = await EvoReader.connect(network);
  const log = env.LOG_REQUESTS === '0' ? (line: Record<string, unknown>) => line.event !== 'request' && console.log(JSON.stringify(line)) : (line: Record<string, unknown>) => console.log(JSON.stringify(line));
  const server = createServer(createGateway({ reader, config, log }));
  server.headersTimeout = 15000;
  server.requestTimeout = 30000;
  const port = number(env.PORT, 8080);
  const host = env.HOST ?? '127.0.0.1';
  server.listen(port, host, () => {
    console.log(JSON.stringify({ event: 'listening', host, port, network: network.network, contractId: network.contractId, domains: config.domains.map((d) => d.origin) }));
  });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => server.close(() => process.exit(0)));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
