import { ruleInstaller } from './rules.js';
import { loadSettings, parseTarget, redirectRules, targetForSearch, viewerUrl } from './shared.js';

declare const __SANDBOX__: boolean;

const applyRules = ruleInstaller(chrome.declarativeNetRequest, async () => redirectRules(chrome.runtime.getURL('/'), await loadSettings(), __SANDBOX__));

const reapply = (): void => {
  applyRules().catch((error: unknown) => console.error('Dash Sites: could not install the redirect rules', error));
};

reapply();
chrome.runtime.onInstalled.addListener(reapply);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) reapply();
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
