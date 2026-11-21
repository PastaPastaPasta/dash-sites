export type Network = 'testnet' | 'mainnet';

export const DPNS_CONTRACT_ID = 'GWRSAVFMjXx8HpQFaNJMqBV7MBgMK4br5UESsB4S31Ec';

export interface NetworkConfig {
  network: Network;
  /** Id of the dash-sites data contract on this network. */
  contractId: string;
}

/** Where the dash-sites contract is registered. Mainnet has no deployment yet. */
export const DEPLOYMENTS: Partial<Record<Network, NetworkConfig>> = {
  testnet: { network: 'testnet', contractId: '3JRHRkyYZiwGS6xYQwNq2shemQ5mhGv36yK6VBweVtzx' },
};

export function networkConfig(network: Network, contractId?: string): NetworkConfig {
  const config = contractId ? { network, contractId } : DEPLOYMENTS[network];
  if (!config) throw new Error(`dash-sites has no contract on ${network}; pass a contract id`);
  return config;
}
