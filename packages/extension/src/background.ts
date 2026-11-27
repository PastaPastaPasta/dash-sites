import { loadSettings, parseTarget, redirectRules, targetForSearch, viewerUrl } from './shared.js';

declare const __SANDBOX__: boolean;

async function applyRules(): Promise<void> {
  const settings = await loadSettings();
  const rules = redirectRules(chrome.runtime.getURL('/'), settings, __SANDBOX__);
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: existing.map((rule) => rule.id), addRules: rules });
}

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

// Engines the redirect rules do not list: the search has been sent by now, so this only saves a step.
chrome.webNavigation.onBeforeNavigate.addListener((details) => {
  if (details.frameId !== 0 || details.url.startsWith(chrome.runtime.getURL('/'))) return;
  const target = targetForSearch(details.url);
  if (!target) return;
  void loadSettings().then((settings) => {
    if (settings.catchSearches) void chrome.tabs.update(details.tabId, { url: viewerUrl(target) });
  });
});
