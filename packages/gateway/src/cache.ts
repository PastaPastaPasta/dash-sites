/** A map bounded by total weight; the least recently used entries go first. */
export class LruCache<V> {
  private readonly entries = new Map<string, { value: V; weight: number }>();
  private total = 0;

  constructor(
    private readonly maxWeight: number,
    private readonly weigh: (value: V) => number = () => 1,
  ) {}

  get(key: string): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: V): void {
    const existing = this.entries.get(key);
    if (existing) {
      this.total -= existing.weight;
      this.entries.delete(key);
    }
    const weight = this.weigh(value);
    if (weight > this.maxWeight) return;
    this.entries.set(key, { value, weight });
    this.total += weight;
    for (const [oldest, entry] of this.entries) {
      if (this.total <= this.maxWeight) break;
      this.entries.delete(oldest);
      this.total -= entry.weight;
    }
  }

  delete(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.total -= entry.weight;
  }

  get size(): number {
    return this.entries.size;
  }
}

export interface Timed<V> {
  value: V;
  fetchedAt: number;
  /** True when the value is older than the fresh window, or is being served because a refresh failed. */
  stale: boolean;
}

export interface RefreshOptions<V> {
  freshMs: number;
  /** How long a value may be served while a refresh runs in the background. */
  staleMs: number;
  /** How long a value may be served when refreshing fails. */
  errorMs: number;
  maxEntries: number;
  now?: () => number;
  /** Returns false to keep the cached value instead of `next`, e.g. when `next` is older state. */
  accept?: (next: V, previous: V) => boolean;
}

/**
 * Caches the result of `load` per key. Fresh values are returned as they are; stale ones are
 * returned at once and refreshed in the background; and when Platform cannot be reached the
 * last value keeps being served for `errorMs`.
 */
export class RefreshingCache<V> {
  private readonly values: LruCache<{ value: V; fetchedAt: number }>;
  private readonly pending = new Map<string, Promise<V>>();
  private readonly now: () => number;

  constructor(
    private readonly load: (key: string) => Promise<V>,
    private readonly options: RefreshOptions<V>,
  ) {
    this.values = new LruCache(options.maxEntries);
    this.now = options.now ?? Date.now;
  }

  private refresh(key: string): Promise<V> {
    let pending = this.pending.get(key);
    if (!pending) {
      pending = this.load(key)
        .then((next) => {
          const previous = this.values.get(key);
          const value = previous && this.options.accept && !this.options.accept(next, previous.value) ? previous.value : next;
          this.values.set(key, { value, fetchedAt: this.now() });
          return value;
        })
        .finally(() => this.pending.delete(key));
      this.pending.set(key, pending);
    }
    return pending;
  }

  async get(key: string): Promise<Timed<V>> {
    const cached = this.values.get(key);
    const age = cached ? this.now() - cached.fetchedAt : Infinity;
    if (cached && age <= this.options.freshMs) return { ...cached, stale: false };
    if (cached && age <= this.options.staleMs) {
      this.refresh(key).catch(() => {});
      return { ...cached, stale: true };
    }
    try {
      return { value: await this.refresh(key), fetchedAt: this.now(), stale: false };
    } catch (error) {
      if (cached && age <= this.options.errorMs) return { ...cached, stale: true };
      throw error;
    }
  }

  invalidate(key: string): void {
    this.values.delete(key);
  }
}
