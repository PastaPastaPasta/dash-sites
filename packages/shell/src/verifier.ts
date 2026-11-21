import type { NetworkConfig, PlatformReader } from '@dash-sites/core';
import { EvoReader } from '@dash-sites/core/evo';

export type Connect = (config: NetworkConfig) => Promise<PlatformReader>;

/** The Dash SDK, kept out of the worker's own script: the worker fetches it, checks its hash and evaluates it. */
(globalThis as { dashSitesConnect?: Connect }).dashSitesConnect = (config) => EvoReader.connect(config);
