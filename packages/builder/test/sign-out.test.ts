import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AutoSignOut, type SignOutReason } from '../src/sign-out.js';

describe('automatic sign-out', () => {
  let ended: SignOutReason[];
  let busy: boolean;
  let auto: AutoSignOut;
  beforeEach(() => {
    vi.useFakeTimers();
    ended = [];
    busy = false;
    auto = new AutoSignOut({ idleMs: 600_000, signOut: (reason) => ended.push(reason), busy: () => busy });
  });
  afterEach(() => vi.useRealTimers());

  it('signs out after 10 minutes without activity, and activity restarts the clock', () => {
    auto.signedIn();
    vi.advanceTimersByTime(590_000);
    auto.activity();
    vi.advanceTimersByTime(590_000);
    expect(ended).toEqual([]);
    vi.advanceTimersByTime(10_000);
    expect(ended).toEqual(['idle']);
  });

  it('waits for a publish in progress instead of interrupting it', () => {
    auto.signedIn();
    busy = true;
    vi.advanceTimersByTime(1_200_000);
    expect(ended).toEqual([]);
    busy = false;
    vi.advanceTimersByTime(600_000);
    expect(ended).toEqual(['idle']);
  });

  it('signs out after a publish and when the page is left, once', () => {
    auto.signedIn();
    auto.published();
    auto.left();
    vi.advanceTimersByTime(1_200_000);
    expect(ended).toEqual(['published']);
    auto.signedIn();
    auto.left();
    expect(ended).toEqual(['published', 'left']);
  });

  it('does nothing when nobody is signed in, or after a manual sign-out', () => {
    auto.published();
    auto.left();
    auto.activity();
    auto.signedIn();
    auto.signedOut();
    vi.advanceTimersByTime(1_200_000);
    auto.published();
    expect(ended).toEqual([]);
  });
});
