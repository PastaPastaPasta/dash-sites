import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { MAX_FILES, networkConfig, type Network } from '@dash-sites/core';
import { EvoReader } from '@dash-sites/core/evo';
import { emptyDenylist, parseDenylist, parseDomain, type GatewayConfig } from './config.js';
import { createGateway } from './server.js';

const env = process.env;
const list = (value: string | undefined): string[] => (value ?? '').split(',').map((item) => item.trim()).filter(Boolean);
const number = (value: string | undefined, fallback: number): number => (value === undefined || value === '' ? fallback : Number(value));

export function configFromEnv(): GatewayConfig {
  const domains = list(env.GATEWAY_DOMAINS ?? 'http://localhost:8080').map(parseDomain);
  return {
    domains,
    reservedLabels: new Set(list(env.RESERVED_LABELS)),
    builderUrl: env.BUILDER_URL ?? 'https://github.com/PastaPastaPasta/dash-sites',
    extensionUrl: env.EXTENSION_URL ?? 'https://github.com/PastaPastaPasta/dash-sites/releases',
    abuseContact: env.ABUSE_CONTACT ?? 'see the repository',
    network: env.NETWORK ?? 'testnet',
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
  const network = networkConfig(config.network as Network, env.CONTRACT_ID || undefined);
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
