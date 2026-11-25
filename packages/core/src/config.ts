export type Network = 'testnet' | 'mainnet';

export const DPNS_CONTRACT_ID = 'GWRSAVFMjXx8HpQFaNJMqBV7MBgMK4br5UESsB4S31Ec';

export interface NetworkConfig {
  network: Network;
  /** Id of the dash-sites data contract on this network. */
  contractId: string;
}

/** Where the dash-sites contract is registered. */
export const DEPLOYMENTS: Partial<Record<Network, NetworkConfig>> = {
  testnet: { network: 'testnet', contractId: 'zVqSAuc1SosVqcXHTvrigRdeiVyHh3i7dTpMFbRVU3L' },
};

/**
 * The config a reader uses. Unlike `networkConfig` it accepts a network with no contract yet:
 * such a reader still proves names, and every name resolves to "no site".
 */
export function readerConfig(network: Network, contractId?: string): NetworkConfig {
  return { network, contractId: contractId || DEPLOYMENTS[network]?.contractId || '' };
}

export function networkConfig(network: Network, contractId?: string): NetworkConfig {
  const config = contractId ? { network, contractId } : DEPLOYMENTS[network];
  if (!config) throw new Error(`dash-sites has no contract on ${network}; pass a contract id`);
  return config;
}
