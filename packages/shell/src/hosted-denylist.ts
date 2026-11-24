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
 * Whether the hosting operator has stopped serving a name. A list older than `freshMs` is used while
 * one shared refresh runs in the background. Without the gateway the last list stays in force, or none:
 * the site keeps working without the gateway.
 */
export function hostedDenylist(options: HostedDenylistOptions): (resolution: Resolution) => Promise<boolean> {
  const now = options.now ?? Date.now;
  const freshMs = options.freshMs ?? 60_000;
  let current: { at: number; list?: Denylist } | undefined;
  let refreshing: Promise<void> | undefined;

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
        return;
      }
      const saved = current?.list ? undefined : await quietly(options.load);
      current = { at: now(), list: current?.list ?? (saved === undefined ? undefined : denylistFromJson(saved)) };
    })().finally(() => {
      refreshing = undefined;
    }));

  return async (resolution) => {
    if (!current) await refresh();
    else if (now() - current.at >= freshMs) void refresh();
    return current?.list ? isDenied(current.list, resolution) : false;
  };
}
