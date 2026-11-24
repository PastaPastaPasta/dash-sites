import { formatDash, fromHex, isHash, toHex, type Network } from '@dash-sites/core';
import encodeQR from 'qr';

export interface KeyValue {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Browsers may refuse storage outright; the page then works without it. */
export function quietly<T>(run: () => T): T | undefined {
  try {
    return run();
  } catch {
    return undefined;
  }
}

/**
 * 16 random bytes this browser keeps per network. A wallet that approves a sign-in disables the
 * key it gave the same connection before, so signing in again never leaves an old key live.
 */
export function connectionId(storage: KeyValue | undefined, network: Network): Uint8Array {
  const name = `dash-sites.connection.${network}`;
  const saved = quietly(() => storage?.getItem(name)) ?? '';
  if (/^[0-9a-f]{32}$/.test(saved)) return fromHex(saved);
  const fresh = crypto.getRandomValues(new Uint8Array(16));
  quietly(() => storage?.setItem(name, toHex(fresh)));
  return fresh;
}

export interface SavedSession {
  identityId: string;
  privateKey: Uint8Array;
}

const sessionName = (network: Network): string => `dash-sites.wallet.${network}`;

/** Keeps a wallet's key for this tab only, so a reload does not need another approval. */
export function saveSession(storage: KeyValue | undefined, network: Network, session: SavedSession): void {
  quietly(() => storage?.setItem(sessionName(network), JSON.stringify({ identityId: session.identityId, key: toHex(session.privateKey) })));
}

export function loadSession(storage: KeyValue | undefined, network: Network): SavedSession | undefined {
  const saved = quietly(() => JSON.parse(storage?.getItem(sessionName(network)) ?? 'null') as { identityId?: unknown; key?: unknown } | null);
  return saved && typeof saved.identityId === 'string' && isHash(saved.key) ? { identityId: saved.identityId, privateKey: fromHex(saved.key) } : undefined;
}

export function clearSession(storage: KeyValue | undefined, network: Network): void {
  quietly(() => storage?.removeItem(sessionName(network)));
}

export interface QrShape {
  size: number;
  path: string;
}

/** The code as one SVG path on a `size` by `size` grid, quiet zone included. */
export function qrShape(text: string): QrShape {
  const rows = encodeQR(text, 'raw', { ecc: 'low', border: 4 });
  let path = '';
  rows.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      if (!row[x]) {
        x += 1;
        continue;
      }
      let end = x;
      while (row[end]) end += 1;
      path += `M${x} ${y}h${end - x}v1h${x - end}z`;
      x = end;
    }
  });
  return { size: rows.length, path };
}

export function allowanceText(remaining: bigint, expiresAt: number): string {
  const until = new Date(expiresAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  return `${formatDash(remaining)} until ${until}`;
}

export function countdown(msLeft: number): string {
  const seconds = Math.max(0, Math.ceil(msLeft / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
