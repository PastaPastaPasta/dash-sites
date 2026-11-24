import { loadSettings, saveSettings } from './settings.js';
import type { Network } from '@dash-sites/core';
import { DEFAULT_GATEWAY, parseGateway, SEARCH_ORIGINS } from './shared.js';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

async function main(): Promise<void> {
  const settings = await loadSettings();
  const gateway = $<HTMLInputElement>('gateway');
  const searches = $<HTMLInputElement>('searches');
  const network = $<HTMLSelectElement>('network');
  gateway.value = settings.gateway;
  searches.checked = settings.catchSearches;
  network.value = settings.network;
  $('reset').addEventListener('click', () => {
    gateway.value = DEFAULT_GATEWAY;
  });
  $<HTMLFormElement>('form').addEventListener('submit', (event) => {
    event.preventDefault();
    const parsed = parseGateway(gateway.value);
    const status = $('status');
    if (parsed) void (searches.checked ? chrome.permissions.request({ origins: SEARCH_ORIGINS }) : chrome.permissions.remove({ origins: SEARCH_ORIGINS })).catch(() => false);
    if (!parsed) {
      status.dataset.ok = 'false';
      status.textContent = 'A gateway is an https address, or http on localhost, with no path.';
      return;
    }
    void saveSettings({ gateway: parsed.origin, catchSearches: searches.checked, network: network.value as Network }).then(() => {
      gateway.value = parsed.origin;
      status.dataset.ok = 'true';
      status.textContent = `Saved. alice.dash now opens ${parsed.protocol}//alice.${parsed.host}/`;
    });
  });
}

void main();
