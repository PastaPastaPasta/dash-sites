import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AutoSignOut, type SignOutReason } from '../src/sign-out.js';

describe('automatic sign-out', () => {
  let ended: SignOutReason[];
  let busy: boolean;
  let clock: number;
  let auto: AutoSignOut;
  const pass = (ms: number) => {
    clock += ms;
    vi.advanceTimersByTime(ms);
  };
  beforeEach(() => {
    vi.useFakeTimers();
    ended = [];
    busy = false;
    clock = 1_000_000;
    auto = new AutoSignOut({ idleMs: 600_000, signOut: (reason) => ended.push(reason), busy: () => busy, now: () => clock });
  });
  afterEach(() => vi.useRealTimers());

  it('signs out after 10 minutes without activity, and activity restarts the clock', () => {
    auto.signedIn();
    pass(590_000);
    auto.activity();
    pass(590_000);
    expect(ended).toEqual([]);
    pass(10_000);
    expect(ended).toEqual(['idle']);
  });

  it('counts time the device slept, when timers did not run', () => {
    auto.signedIn();
    clock += 8 * 3600_000;
    auto.activity();
    expect(ended).toEqual(['idle']);
    auto.signedIn();
    clock += 8 * 3600_000;
    expect(auto.check()).toBe(true);
    expect(ended).toEqual(['idle', 'idle']);
  });

  it('waits for a publish or other signed action instead of interrupting it', () => {
    auto.signedIn();
    busy = true;
    pass(1_200_000);
    expect(ended).toEqual([]);
    busy = false;
    pass(600_000);
    expect(ended).toEqual(['idle']);
  });

  it('signs out after a publish once, and clears on leaving even when nobody is signed in', () => {
    auto.signedIn();
    auto.published();
    pass(1_200_000);
    expect(ended).toEqual(['published']);
    auto.left();
    expect(ended).toEqual(['published', 'left']);
  });

  it('does nothing on its own when nobody is signed in, or after a manual sign-out', () => {
    auto.published();
    auto.activity();
    auto.signedIn();
    auto.signedOut();
    pass(1_200_000);
    auto.published();
    expect(auto.check()).toBe(false);
    expect(ended).toEqual([]);
  });
});
