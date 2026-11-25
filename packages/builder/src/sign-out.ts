/** Why a sign-in ended on its own. */
export type SignOutReason = 'published' | 'idle' | 'left';

export interface AutoSignOutOptions {
  idleMs: number;
  signOut: (reason: SignOutReason) => void;
  /** True while a publish or another signed action runs: the idle clock waits for it. */
  busy: () => boolean;
  now?: () => number;
}

/**
 * Ends a sign-in after a publish, after `idleMs` without activity, and when the page is left. On
 * dash.site the builder shares a site with every user's pages, so a sign-in never outlives its use.
 * Idle time is wall-clock time: a timer alone stops while the device sleeps.
 */
export class AutoSignOut {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private active = false;
  private last = 0;
  private readonly now: () => number;

  constructor(private readonly options: AutoSignOutOptions) {
    this.now = options.now ?? Date.now;
  }

  signedIn(): void {
    this.active = true;
    this.last = this.now();
    this.schedule();
  }

  /** Any use of the page restarts the idle clock, unless the page has already been idle too long. */
  activity(): void {
    if (!this.active || this.expired()) return;
    this.last = this.now();
    this.schedule();
  }

  /** Signs out if the page was idle too long, for when it becomes visible again or wakes up. */
  check(): boolean {
    return this.active && this.expired();
  }

  published(): void {
    this.end('published');
  }

  /** The page is being left: everything is cleared, signed in or not. */
  left(): void {
    this.signedOut();
    this.options.signOut('left');
  }

  /** The sign-in ended some other way, such as the Sign out button. */
  signedOut(): void {
    this.active = false;
    clearTimeout(this.timer);
  }

  private expired(): boolean {
    if (this.now() - this.last < this.options.idleMs) return false;
    if (this.options.busy()) {
      this.last = this.now();
      this.schedule();
      return false;
    }
    this.end('idle');
    return true;
  }

  private schedule(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.expired() || this.schedule(), Math.max(1000, this.last + this.options.idleMs - this.now()));
  }

  private end(reason: SignOutReason): void {
    if (!this.active) return;
    this.signedOut();
    this.options.signOut(reason);
  }
}
