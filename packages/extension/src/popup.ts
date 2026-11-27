import type { ChainSnapshot } from '@dash-sites/core/chain';
import { chainKey, loadSettings, parseTarget, viewerUrl } from './shared.js';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

function ago(ms: number): string {
  const minutes = Math.round((Date.now() - ms) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`;
}

async function main(): Promise<void> {
  const settings = await loadSettings();
  $('network').textContent = settings.network;
  $('options').addEventListener('click', () => void chrome.runtime.openOptionsPage());
  const input = $<HTMLInputElement>('name');
  input.addEventListener('input', () => input.setCustomValidity(''));
  $<HTMLFormElement>('open').addEventListener('submit', (event) => {
    event.preventDefault();
    const target = parseTarget(input.value);
    if (!target) {
      input.setCustomValidity('Enter a name such as alice.dash');
      input.reportValidity();
      return;
    }
    void chrome.tabs.create({ url: viewerUrl(target) });
    window.close();
  });
  const key = chainKey(settings.network);
  const snapshot = (await chrome.storage.local.get(key))[key] as ChainSnapshot | undefined;
  const chain = $('chain');
  if (snapshot) {
    chain.innerHTML = '';
    const strong = document.createElement('b');
    strong.textContent = `block ${snapshot.listHeight.toLocaleString()}`;
    chain.append('Dash chain verified to ', strong, `, ${ago(snapshot.syncedAt)}. ${snapshot.quorums.length} Platform quorum keys proven; ${snapshot.nodes.length} nodes known.`);
  } else {
    chain.textContent = 'The first site you open verifies the Dash chain from the checkpoint in this release.';
  }
  input.focus();
}

void main();
