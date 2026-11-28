type Rule = chrome.declarativeNetRequest.Rule;

/** The part of `chrome.declarativeNetRequest` that installs dynamic rules. */
export interface DynamicRules {
  getDynamicRules(): Promise<Rule[]>;
  updateDynamicRules(options: { removeRuleIds?: number[]; addRules?: Rule[] }): Promise<void>;
}

/**
 * Returns a function that replaces the extension's dynamic rules with `build()`'s. Calls run one
 * after another, and each update removes every rule present and every id it adds, so calls that
 * overlap (the worker starting while `onInstalled` fires) or repeat (a reload, an update over an
 * older install) never add an id twice.
 */
export function ruleInstaller(dnr: DynamicRules, build: () => Promise<Rule[]>): () => Promise<void> {
  let queue: Promise<void> = Promise.resolve();
  return () => {
    const run = queue.then(async () => {
      const rules = await build();
      const existing = await dnr.getDynamicRules();
      const removeRuleIds = [...new Set([...existing.map((rule) => rule.id), ...rules.map((rule) => rule.id)])];
      await dnr.updateDynamicRules({ removeRuleIds, addRules: rules });
    });
    queue = run.catch(() => undefined);
    return run;
  };
}
