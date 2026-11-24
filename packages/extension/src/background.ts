import { loadGateway } from './settings.js';
import { redirectRule, RULE_ID, SEARCH_ENGINES, SEARCH_ORIGINS, SEARCH_RULE_IDS, searchRules, urlForInput, urlForSearch } from './shared.js';

const searchPatterns = SEARCH_ENGINES.map((engine) => new RegExp(engine.regex, 'i'));

async function applyRules(): Promise<void> {
  const { settings, gateway } = await loadGateway();
  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [RULE_ID], addRules: [redirectRule(gateway)] });
  const catchEarly = settings.catchSearches && (await chrome.permissions.contains({ origins: SEARCH_ORIGINS }));
  const stale = (await chrome.declarativeNetRequest.getDynamicRules()).map((rule) => rule.id).filter((id) => id !== RULE_ID);
  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: stale, addRules: catchEarly ? searchRules(gateway) : [] });
}

let applying = Promise.resolve();
const reapply = (): void => {
  applying = applying.then(applyRules).catch((error: unknown) => console.error('Dash Sites: could not install the redirect rules', error));
};

reapply();
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) reapply();
});
chrome.permissions.onAdded.addListener(reapply);
chrome.permissions.onRemoved.addListener(reapply);

// Firefox for Android has no omnibox.
if (chrome.omnibox) {
  chrome.omnibox.setDefaultSuggestion({ description: 'Open a .dash site: type a name such as alice or alice.dash/blog' });
  chrome.omnibox.onInputEntered.addListener((text, disposition) => {
    void (async () => {
      const { gateway } = await loadGateway();
      const url = urlForInput(text, gateway) ?? `${gateway.origin}/`;
      if (disposition === 'currentTab') await chrome.tabs.update({ url });
      else await chrome.tabs.create({ url, active: disposition === 'newForegroundTab' });
    })();
  });
}

chrome.webNavigation.onBeforeNavigate.addListener((details) => {
  if (details.frameId !== 0) return;
  void (async () => {
    const { settings, gateway } = await loadGateway();
    if (!settings.catchSearches) return;
    if (searchPatterns.some((pattern) => pattern.test(details.url))) {
      const installed = await chrome.declarativeNetRequest.getDynamicRules();
      if (installed.some((rule) => SEARCH_RULE_IDS.includes(rule.id))) return;
    }
    const url = urlForSearch(details.url, gateway);
    if (url) await chrome.tabs.update(details.tabId, { url });
  })();
});
