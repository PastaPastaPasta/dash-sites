import { describe, expect, it } from 'vitest';
import { ruleInstaller, type DynamicRules } from '../src/rules.js';
import { DEFAULT_SETTINGS, redirectRules } from '../src/shared.js';

type Rule = chrome.declarativeNetRequest.Rule;
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** Chrome's dynamic rules: removals first, then additions, and an id already present is an error. */
function fakeDnr(initial: Rule[] = []): DynamicRules & { rules: Map<number, Rule> } {
  const rules = new Map(initial.map((rule) => [rule.id, rule]));
  return {
    rules,
    async getDynamicRules() {
      await tick();
      return [...rules.values()];
    },
    async updateDynamicRules({ removeRuleIds = [], addRules = [] }) {
      await tick();
      const next = new Map(rules);
      for (const id of removeRuleIds) next.delete(id);
      for (const rule of addRules) {
        if (next.has(rule.id)) throw new Error(`Rule with id ${rule.id} does not have a unique ID.`);
        next.set(rule.id, rule);
      }
      rules.clear();
      for (const [id, rule] of next) rules.set(id, rule);
    },
  };
}

const build = async (): Promise<Rule[]> => redirectRules('chrome-extension://abc/', DEFAULT_SETTINGS, true);
const ids = (dnr: { rules: Map<number, Rule> }): number[] => [...dnr.rules.keys()].sort((a, b) => a - b);
const expected = async (): Promise<number[]> => (await build()).map((rule) => rule.id).sort((a, b) => a - b);

describe('installing the redirect rules', () => {
  it('survives the worker start and onInstalled firing at once (a fresh install)', async () => {
    const dnr = fakeDnr();
    const apply = ruleInstaller(dnr, build);
    await Promise.all([apply(), apply()]);
    expect(ids(dnr)).toEqual(await expected());
  });

  it('survives two workers racing, each with its own installer', async () => {
    const dnr = fakeDnr();
    await Promise.all([ruleInstaller(dnr, build)(), ruleInstaller(dnr, build)()]);
    expect(ids(dnr)).toEqual(await expected());
  });

  it('replaces rules already installed (a reload, a browser restart)', async () => {
    const dnr = fakeDnr();
    await ruleInstaller(dnr, build)();
    await ruleInstaller(dnr, build)();
    await ruleInstaller(dnr, build)();
    expect(ids(dnr)).toEqual(await expected());
  });

  it('replaces the rules of an older version (an update over an existing install)', async () => {
    const old = { id: 1, priority: 1, action: { type: 'redirect' }, condition: { regexFilter: '^https?://([a-z0-9-]+)\\\\.dash' } } as Rule;
    const stale = { id: 42, priority: 1, action: { type: 'block' }, condition: { urlFilter: 'x' } } as Rule;
    const dnr = fakeDnr([old, stale]);
    await ruleInstaller(dnr, build)();
    expect(ids(dnr)).toEqual(await expected());
  });

  it('keeps working after a failed update', async () => {
    const dnr = fakeDnr();
    let fail = true;
    const apply = ruleInstaller(dnr, async () => {
      if (fail) throw new Error('settings unreadable');
      return build();
    });
    await expect(apply()).rejects.toThrow('settings unreadable');
    fail = false;
    await apply();
    expect(ids(dnr)).toEqual(await expected());
  });
});
