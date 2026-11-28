import { parseName } from '@dash-sites/core';
import { SITE_PORT, type ViewerRequest, type WorkerReply } from './protocol.js';
import { ruleInstaller } from './rules.js';
import { resetServices, serviceFor } from './service.js';
import { chainKey, loadSettings, parseTarget, redirectRules, targetForSearch, viewerUrl } from './shared.js';

declare const __SANDBOX__: boolean;

const applyRules = ruleInstaller(chrome.declarativeNetRequest, async () => redirectRules(chrome.runtime.getURL('/'), await loadSettings(), __SANDBOX__));

const reapply = (): void => {
  applyRules().catch((error: unknown) => console.error('Dash Sites: could not install the redirect rules', error));
};

reapply();
chrome.runtime.onInstalled.addListener(reapply);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.settings) reapply();
  // "Forget the verified chain" in the settings removes the stored proof: the next open proves it again.
  if ([chainKey('mainnet'), chainKey('testnet')].some((key) => key in changes && changes[key]?.newValue === undefined)) resetServices();
});

chrome.omnibox.setDefaultSuggestion({ description: 'Open a .dash site from Dash Platform: type a name such as alice or alice.dash/blog' });
chrome.omnibox.onInputEntered.addListener((text, disposition) => {
  const target = parseTarget(text);
  const url = target ? viewerUrl(target) : chrome.runtime.getURL('site.html');
  if (disposition === 'currentTab') void chrome.tabs.update({ url });
  else void chrome.tabs.create({ url, active: disposition === 'newForegroundTab' });
});

// Engines the redirect rules cannot act on: the search has been sent by now, so this only saves a step.
chrome.webNavigation.onBeforeNavigate.addListener((details) => {
  if (details.frameId !== 0 || details.url.startsWith(chrome.runtime.getURL('/'))) return;
  if (!targetForSearch(details.url, () => false)) return;
  void (async () => {
    const held = await chrome.permissions.contains({ origins: [`${new URL(details.url).origin}/*`] }).catch(() => false);
    const target = targetForSearch(details.url, () => held);
    if (target && (await loadSettings()).catchSearches) await chrome.tabs.update(details.tabId, { url: viewerUrl(target) });
  })();
});

// Viewers ask here to open a name: the chain proof, the SDK and each site's read are shared by all tabs.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== SITE_PORT) return;
  if (port.sender?.id !== chrome.runtime.id || !port.sender.url?.startsWith(chrome.runtime.getURL('site.html'))) {
    port.disconnect();
    return;
  }
  let open = true;
  port.onDisconnect.addListener(() => {
    open = false;
  });
  const reply = (message: WorkerReply): void => {
    if (open) port.postMessage(message);
  };
  port.onMessage.addListener((message: ViewerRequest) => {
    if (message?.type !== 'open') return;
    const name = typeof message.label === 'string' ? parseName(message.label) : undefined;
    // The viewer names the network it keys its cache by, so both always mean the same one.
    if (!name || (message.network !== 'mainnet' && message.network !== 'testnet')) return reply({ type: 'error', message: 'not a .dash name' });
    serviceFor(message.network)
      .open(name.label, (progress) => reply({ type: 'progress', message: progress }))
      .then(
        (result) => reply({ type: 'result', result }),
        (error: unknown) => reply({ type: 'error', message: (error as Error)?.message ?? String(error) }),
      );
  });
});
