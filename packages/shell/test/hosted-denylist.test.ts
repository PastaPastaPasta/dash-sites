import { describe, expect, it } from 'vitest';
import type { Resolution } from '@dash-sites/core';
import { hostedDenylist } from '../src/hosted-denylist.js';

const name = (normalized: string) => ({ status: 'unregistered', normalized }) as unknown as Resolution;

function setup(lists: Array<unknown>, saved?: unknown) {
  let time = 0;
  const calls = { fetch: 0, saved: [] as unknown[] };
  let release: (() => void) | undefined;
  const denied = hostedDenylist({
    fetchList: async () => {
      calls.fetch += 1;
      const next = lists.shift();
      if (next === 'hang') await new Promise<void>((resolve) => (release = resolve));
      if (next instanceof Error) throw next;
      return next === 'hang' ? undefined : next;
    },
    load: async () => saved,
    save: async (value) => void calls.saved.push(value),
    now: () => time,
    freshMs: 60_000,
  });
  return { denied, calls, tick: (ms: number) => (time += ms), release: () => release?.() };
}

describe('hostedDenylist', () => {
  it('refuses listed names and saves the fetched list', async () => {
    const { denied, calls } = setup([{ names: ['alice'] }]);
    expect(await denied(name('a11ce'))).toBe(true);
    expect(await denied(name('b0b'))).toBe(false);
    expect(calls.fetch).toBe(1);
    expect(calls.saved).toEqual([{ names: ['alice'] }]);
  });

  it('answers from the saved list on start without waiting for the gateway', async () => {
    const { denied, calls, release } = setup(['hang'], { names: ['alice'] });
    expect(await denied(name('a11ce'))).toBe(true);
    expect(calls.fetch).toBe(1);
    release();
  });

  it('keeps the saved list when the gateway cannot be reached', async () => {
    const { denied } = setup([new Error('offline')], { names: ['alice'] });
    expect(await denied(name('a11ce'))).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await denied(name('a11ce'))).toBe(true);
  });

  it('serves without a list when there is neither a gateway nor a saved list', async () => {
    const { denied } = setup([undefined]);
    expect(await denied(name('a11ce'))).toBe(false);
  });

  it('keeps the last list while one shared refresh runs in the background', async () => {
    const { denied, calls, tick, release } = setup([{ names: ['alice'] }, 'hang']);
    expect(await denied(name('a11ce'))).toBe(true);
    tick(60_000);
    const answers = await Promise.all([denied(name('a11ce')), denied(name('a11ce')), denied(name('a11ce'))]);
    expect(answers).toEqual([true, true, true]);
    expect(calls.fetch).toBe(2);
    release();
  });

  it('picks up a removal after the refresh completes', async () => {
    const { denied, tick } = setup([{ names: ['alice'] }, { names: [] }]);
    expect(await denied(name('a11ce'))).toBe(true);
    tick(60_000);
    await denied(name('a11ce'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await denied(name('a11ce'))).toBe(false);
  });
});
