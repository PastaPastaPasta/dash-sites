/** Why a sign-in ended on its own. */
export type SignOutReason = 'published' | 'idle' | 'left';

export interface AutoSignOutOptions {
  idleMs: number;
  signOut: (reason: SignOutReason) => void;
  /** True while a publish is running: the idle clock waits for it instead of interrupting it. */
  busy: () => boolean;
}

/**
 * Ends a sign-in after a publish, after `idleMs` without activity, and when the page is left. On
 * dash.site the builder shares a site with every user's pages, so a sign-in never outlives its use.
 */
export class AutoSignOut {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private active = false;

  constructor(private readonly options: AutoSignOutOptions) {}

  signedIn(): void {
    this.active = true;
    this.activity();
  }

  /** Any use of the page restarts the idle clock. */
  activity(): void {
    if (!this.active) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => (this.options.busy() ? this.activity() : this.end('idle')), this.options.idleMs);
  }

  published(): void {
    this.end('published');
  }

  left(): void {
    this.end('left');
  }

  /** The sign-in ended some other way, such as the Sign out button. */
  signedOut(): void {
    this.active = false;
    clearTimeout(this.timer);
  }

  private end(reason: SignOutReason): void {
    if (!this.active) return;
    this.signedOut();
    this.options.signOut(reason);
  }
}
