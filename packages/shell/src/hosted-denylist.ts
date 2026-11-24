import { denylistFromJson, isDenied, type Denylist, type Resolution } from '@dash-sites/core';

export interface HostedDenylistOptions {
  /** The operator's published list, or undefined when the gateway cannot be reached. */
  fetchList: () => Promise<unknown>;
  /** The last list this browser saw, kept across worker restarts. */
  load: () => Promise<unknown>;
  save: (value: unknown) => Promise<void>;
  now?: () => number;
  freshMs?: number;
}

/**
 * Whether the hosting operator has stopped serving a name. A list older than `freshMs`, or the one
 * saved by an earlier worker, is used while one shared refresh runs in the background. Only a browser
 * with no saved list waits for the gateway; without the gateway it serves with no list.
 */
export function hostedDenylist(options: HostedDenylistOptions): (resolution: Resolution) => Promise<boolean> {
  const now = options.now ?? Date.now;
  const freshMs = options.freshMs ?? 60_000;
  let current: { at: number; list?: Denylist } | undefined;
  let refreshing: Promise<void> | undefined;
  let starting: Promise<void> | undefined;

  const quietly = async (read: () => Promise<unknown>): Promise<unknown> => {
    try {
      return await read();
    } catch {
      return undefined;
    }
  };

  const refresh = (): Promise<void> =>
    (refreshing ??= (async () => {
      const fetched = await quietly(options.fetchList);
      if (fetched !== undefined) {
        current = { at: now(), list: denylistFromJson(fetched) };
        await quietly(() => options.save(fetched));
      } else {
        current = { at: now(), list: current?.list };
      }
    })().finally(() => {
      refreshing = undefined;
    }));

  const start = async (): Promise<void> => {
    const saved = await quietly(options.load);
    if (saved === undefined) return refresh();
    current ??= { at: -Infinity, list: denylistFromJson(saved) };
    void refresh();
  };

  return async (resolution) => {
    if (!current) await (starting ??= start());
    else if (now() - current.at >= freshMs) void refresh();
    return current?.list ? isDenied(current.list, resolution) : false;
  };
}
