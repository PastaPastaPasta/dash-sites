import type { NetworkConfig, PlatformReader } from '@dash-sites/core';
import { EvoReader } from '@dash-sites/core/evo';
import { brotliInflater, type Inflater } from './inflate.js';

declare const __BROTLI_DECODER__: string;

export interface Verifier {
  /** A decompressor for the SDK's WebAssembly, which is served compressed with brotli. */
  inflater(): Inflater;
  /**
   * Starts the Dash SDK on `sdk`, a module the worker compiled from bytes matching its pinned hash,
   * using `addresses` as its Platform nodes when given.
   */
  connect(config: NetworkConfig, sdk: WebAssembly.Module, addresses?: string[]): Promise<PlatformReader>;
}

/** The Dash SDK, kept out of the worker's own script: the worker fetches it, checks its hash and evaluates it. */
(globalThis as { dashSitesVerifier?: Verifier }).dashSitesVerifier = {
  inflater: () => brotliInflater(() => Uint8Array.from(atob(__BROTLI_DECODER__), (c) => c.charCodeAt(0))),
  connect(config, sdk, addresses) {
    (globalThis as { dashSitesSdk?: WebAssembly.Module }).dashSitesSdk = sdk;
    return EvoReader.connect(config, { addresses });
  },
};
