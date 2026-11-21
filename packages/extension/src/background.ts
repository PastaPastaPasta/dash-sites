import { loadGateway } from './settings.js';
import { redirectRule, RULE_ID, urlForInput, urlForSearch } from './shared.js';

async function applyRules(): Promise<void> {
  const { gateway } = await loadGateway();
  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [RULE_ID], addRules: [redirectRule(gateway)] });
}

const reapply = (): void => {
  applyRules().catch((error: unknown) => console.error('Dash Sites: could not install the redirect rule', error));
};

reapply();
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) reapply();
});

chrome.omnibox.setDefaultSuggestion({ description: 'Open a .dash site: type a name such as alice or alice.dash/blog' });
chrome.omnibox.onInputEntered.addListener((text, disposition) => {
  void (async () => {
    const { gateway } = await loadGateway();
    const url = urlForInput(text, gateway) ?? `${gateway.origin}/`;
    if (disposition === 'currentTab') await chrome.tabs.update({ url });
    else await chrome.tabs.create({ url, active: disposition === 'newForegroundTab' });
  })();
});

chrome.webNavigation.onBeforeNavigate.addListener((details) => {
  if (details.frameId !== 0) return;
  void (async () => {
    const { settings, gateway } = await loadGateway();
    if (!settings.catchSearches) return;
    const url = urlForSearch(details.url, gateway);
    if (url) await chrome.tabs.update(details.tabId, { url });
  })();
});
