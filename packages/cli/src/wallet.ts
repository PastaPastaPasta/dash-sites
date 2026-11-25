import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fromHex, isHash, toHex, type DomainRecord, type Network, type NetworkConfig } from '@dash-sites/core';
import {
  APP_CONNECT_MIN_PROTOCOL,
  awaitWalletGrant,
  newWalletRequest,
  type AwaitGrantOptions,
  type ConnectPort,
  type PollStatus,
  type WalletGrant,
  type WalletRequest,
} from '@dash-sites/core/connect';
import encodeQR from 'qr';

const EXPIRY_MARGIN_MS = 5 * 60_000;

export interface StoredSession {
  v: 1;
  network: Network;
  contractId: string;
  identityId: string;
  keyId: number;
  privateKey: string;
  expiresAt: number;
}

export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.DASH_SITES_CONFIG_DIR) return env.DASH_SITES_CONFIG_DIR;
  return join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'dash-sites');
}

export function sessionPath(dir: string, network: Network): string {
  return join(dir, `session.${network}.json`);
}

function connectionPath(dir: string, network: Network): string {
  return join(dir, `connection.${network}`);
}

function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    // Non-POSIX filesystems may ignore chmod.
  }
}

function writePrivateFile(path: string, content: string): void {
  const tmp = `${path}.tmp.${process.pid}.${randomBytes(4).toString('hex')}`;
  writeFileSync(tmp, content, { mode: 0o600, flag: 'wx' });
  try {
    try {
      chmodSync(tmp, 0o600);
    } catch {
      // Non-POSIX filesystems may ignore chmod.
    }
    renameSync(tmp, path);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      // Best-effort cleanup of temp file.
    }
    throw error;
  }
}

export function connectionId(dir: string, network: Network): Uint8Array {
  const path = connectionPath(dir, network);
  try {
    const saved = readFileSync(path, 'utf8').trim();
    if (/^[0-9a-f]{32}$/.test(saved)) return fromHex(saved);
  } catch {
    // No saved connection id yet.
  }
  const fresh = new Uint8Array(randomBytes(16));
  ensurePrivateDir(dir);
  writePrivateFile(path, `${toHex(fresh)}\n`);
  return fresh;
}

export function saveSession(dir: string, session: StoredSession): string {
  ensurePrivateDir(dir);
  const path = sessionPath(dir, session.network);
  writePrivateFile(path, `${JSON.stringify(session, null, 2)}\n`);
  return path;
}

export function loadSession(dir: string, network: Network): StoredSession | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(sessionPath(dir, network), 'utf8'));
  } catch {
    return undefined;
  }
  if (raw === null || typeof raw !== 'object') return undefined;
  const candidate = raw as Record<string, unknown>;
  if (
    candidate.v !== 1 ||
    candidate.network !== network ||
    typeof candidate.contractId !== 'string' ||
    !candidate.contractId ||
    typeof candidate.identityId !== 'string' ||
    !candidate.identityId ||
    typeof candidate.keyId !== 'number' ||
    !Number.isInteger(candidate.keyId) ||
    candidate.keyId < 0 ||
    !isHash(candidate.privateKey) ||
    typeof candidate.expiresAt !== 'number' ||
    !Number.isFinite(candidate.expiresAt)
  ) {
    return undefined;
  }
  return {
    v: 1,
    network,
    contractId: candidate.contractId,
    identityId: candidate.identityId,
    keyId: candidate.keyId,
    privateKey: candidate.privateKey,
    expiresAt: candidate.expiresAt,
  };
}

export function clearSession(dir: string, network: Network): boolean {
  try {
    unlinkSync(sessionPath(dir, network));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return false;
    throw error;
  }
}

export function qrTerminal(uri: string, options: { color?: boolean } = {}): string {
  const rows = encodeQR(uri, 'raw', { ecc: 'low', border: 2 });
  const color = options.color ?? false;
  const lines: string[] = [];
  for (let y = 0; y < rows.length; y += 2) {
    const top = rows[y] ?? [];
    const bottom = rows[y + 1];
    let line = '';
    for (let x = 0; x < top.length; x++) {
      const darkTop = Boolean(top[x]);
      const darkBottom = Boolean(bottom?.[x]);
      if (darkTop && darkBottom) line += '█';
      else if (darkTop) line += '▀';
      else if (darkBottom) line += '▄';
      else line += ' ';
    }
    lines.push(color ? `\x1b[30;47m${line}\x1b[0m` : line);
  }
  return lines.join('\n');
}

export function qrSvg(uri: string): string {
  const rows = encodeQR(uri, 'raw', { ecc: 'low', border: 4 });
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
  const size = rows.length;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges"><rect width="${size}" height="${size}" fill="#fff"/><path d="${path}" fill="#000"/></svg>\n`;
}

export interface WalletLoginInput {
  config: NetworkConfig;
  port: ConnectPort;
  connectionId: Uint8Array;
  listOwnedNames: (identityId: string) => Promise<DomainRecord[]>;
  verifyWriter: (identityId: string, privateKey: Uint8Array) => Promise<void>;
  save: (session: StoredSession) => string;
  onRequest: (pending: WalletRequest) => void;
  onStatus?: (status: PollStatus) => void;
  expectedIdentityId?: string;
  expectedName?: string;
  confirm?: (grant: WalletGrant, owned: DomainRecord[]) => Promise<boolean>;
  signal?: AbortSignal;
  pollOptions?: AwaitGrantOptions;
  now?: () => number;
}

export interface WalletLoginResult {
  network: Network;
  identityId: string;
  names: string[];
  keyId: number;
  totalBudget: bigint;
  remainingBudget: bigint;
  expiresAt: number;
  sessionFile: string;
}

export async function runWalletLogin(input: WalletLoginInput): Promise<WalletLoginResult> {
  const now = input.now ?? Date.now;
  const clock = await input.port.chainClock();
  if (clock.protocolVersion < APP_CONNECT_MIN_PROTOCOL) {
    throw new Error(`wallet sign-in needs Platform protocol ${APP_CONNECT_MIN_PROTOCOL}, and ${input.config.network} runs ${clock.protocolVersion}`);
  }
  const pending = newWalletRequest(input.config, { connectionId: input.connectionId, chainNow: clock.timeMs, now: now() });
  let grant: WalletGrant;
  try {
    input.onRequest(pending);
    grant = await awaitWalletGrant(input.port, pending, {
      ...input.pollOptions,
      ...(input.signal ? { signal: input.signal } : {}),
      ...(input.onStatus ? { onStatus: input.onStatus } : {}),
    });
  } finally {
    pending.appEphemeralPriv.fill(0);
  }
  try {
    if (input.expectedIdentityId && grant.identityId !== input.expectedIdentityId) {
      throw new Error(
        input.expectedName
          ? `the answering wallet (${grant.identityId}) does not own ${input.expectedName}.dash (owned by ${input.expectedIdentityId}); nothing was saved`
          : `the answering wallet is ${grant.identityId}, not ${input.expectedIdentityId}; nothing was saved`,
      );
    }
    const owned = await input.listOwnedNames(grant.identityId).catch(() => []);
    if (input.confirm && !(await input.confirm(grant, owned))) {
      throw new Error('login cancelled; nothing was saved');
    }
    if (grant.expiresAt <= now() + EXPIRY_MARGIN_MS) {
      throw new Error('the key your wallet approved expires within 5 minutes; start again');
    }
    await input.verifyWriter(grant.identityId, grant.privateKey);
    const sessionFile = input.save({
      v: 1,
      network: input.config.network,
      contractId: input.config.contractId,
      identityId: grant.identityId,
      keyId: grant.keyId,
      privateKey: toHex(grant.privateKey),
      expiresAt: grant.expiresAt,
    });
    return {
      network: input.config.network,
      identityId: grant.identityId,
      names: owned.map((domain) => `${domain.label}.dash`),
      keyId: grant.keyId,
      totalBudget: grant.totalBudget,
      remainingBudget: grant.remainingBudget,
      expiresAt: grant.expiresAt,
      sessionFile,
    };
  } finally {
    grant.privateKey.fill(0);
  }
}
