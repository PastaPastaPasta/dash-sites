import { utf8 } from './bytes.js';
import { httpsFetcher, tryPlace, type VerifiedFetch } from './places.js';

/** A file of a public npm package, named by exact version and checked against a SHA-256. */
export interface PinnedModule {
  package: string;
  version: string;
  file: string;
  sha256: string;
  size: number;
}

/**
 * The IPFS client: Helia's verified-fetch as its authors publish it for browsers. Nothing that
 * serves Dash Sites carries this file. Whoever needs it downloads it from an npm mirror and runs
 * it only when it matches this hash, so the mirrors are relied on to answer, not trusted.
 */
export const IPFS_MODULE: PinnedModule = {
  package: '@helia/verified-fetch',
  version: '8.1.2',
  file: 'dist/index.min.js',
  sha256: '7fbcbd965554f92712fb0cba5b16a2c4b935f50d8541b8ba4a7e32d586e29407',
  size: 1244097,
};
/** The name the module gives itself where there is no module system. */
export const IPFS_GLOBAL = 'HeliaVerifiedFetch';

export const NPM_MIRRORS = ['https://cdn.jsdelivr.net/npm/', 'https://unpkg.com/'];

export const moduleUrls = (module: PinnedModule): string[] => NPM_MIRRORS.map((mirror) => `${mirror}${module.package}@${module.version}/${module.file}`);

/** Downloads a pinned module from the first mirror that serves the pinned bytes. */
export async function fetchPinned(module: PinnedModule, options: { fetch?: typeof fetch } = {}): Promise<Uint8Array> {
  const problems: string[] = [];
  for (const url of moduleUrls(module)) {
    const result = await tryPlace(url, module, { https: httpsFetcher(options) });
    if ('bytes' in result) return result.bytes;
    problems.push(`${new URL(url).host}: ${result.problem}`);
  }
  throw new Error(`${module.package} ${module.version} could not be downloaded (${problems.join('; ')})`);
}

export interface IpfsOptions {
  /** Services asked which peers hold a CID. Defaults to the one the IPFS project runs. */
  routers?: string[];
}

interface HeliaModule {
  createVerifiedFetch(init: { gateways: string[]; routers?: string[] }): Promise<VerifiedFetch>;
}

/**
 * Starts the IPFS client from the pinned module's bytes, which the caller has checked. Content comes
 * from the peers that hold it: recursive gateways are turned off.
 */
export function startIpfs(source: Uint8Array, options: IpfsOptions = {}): Promise<VerifiedFetch> {
  const module: { exports: Partial<HeliaModule> } = { exports: {} };
  new Function('module', utf8.decode(source))(module);
  if (typeof module.exports.createVerifiedFetch !== 'function') throw new Error('the IPFS module is not the one this version was built for');
  return module.exports.createVerifiedFetch({ gateways: [], ...(options.routers?.length ? { routers: options.routers } : {}) });
}
