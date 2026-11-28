import type { Network } from '@dash-sites/core';
import { clearSites } from './cache.js';
import { chainKey, loadSettings, parseGateway, saveSettings } from './shared.js';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

function say(ok: boolean, text: string): void {
  $('status').dataset.ok = String(ok);
  $('status').textContent = text;
}

async function main(): Promise<void> {
  const settings = await loadSettings();
  const network = $<HTMLSelectElement>('network');
  const searches = $<HTMLInputElement>('searches');
  const fallback = $<HTMLInputElement>('fallback');
  const gateway = $<HTMLInputElement>('gateway');
  network.value = settings.network;
  searches.checked = settings.catchSearches;
  fallback.checked = settings.gatewayFallback;
  gateway.value = settings.gateway;
  $<HTMLFormElement>('form').addEventListener('submit', (event) => {
    event.preventDefault();
    const parsed = gateway.value.trim() ? parseGateway(gateway.value) : undefined;
    if (fallback.checked && !parsed) return say(false, 'Enter the domain as an https address with no path, such as dash.site.');
    void saveSettings({ network: network.value as Network, catchSearches: searches.checked, gatewayFallback: fallback.checked, gateway: parsed?.origin ?? '' }).then(() => {
      gateway.value = parsed?.origin ?? '';
      say(true, 'Saved.');
    });
  });
  $('reset-chain').addEventListener('click', () => {
    void Promise.all([chrome.storage.local.remove([chainKey('mainnet'), chainKey('testnet')]), clearSites()]).then(() =>
      say(true, 'The next site you open verifies the chain again from the bundled checkpoint.'),
    );
  });
}

void main();
