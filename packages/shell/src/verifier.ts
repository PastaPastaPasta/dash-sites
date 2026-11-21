import type { NetworkConfig, PlatformReader } from '@dash-sites/core';
import { EvoReader } from '@dash-sites/core/evo';

export type Connect = (config: NetworkConfig) => Promise<PlatformReader>;

/** The Dash SDK, kept out of the worker's own script so that starting the worker does not load it. */
(globalThis as { dashSitesConnect?: Connect }).dashSitesConnect = (config) => EvoReader.connect(config);
