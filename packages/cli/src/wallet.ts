import { randomBytes } from 'node:crypto';
import { chmodSync, linkSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
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
  const readSaved = (): Uint8Array | undefined => {
    try {
      const saved = readFileSync(path, 'utf8').trim();
      return /^[0-9a-f]{32}$/.test(saved) ? fromHex(saved) : undefined;
    } catch {
      return undefined;
    }
  };
  const existing = readSaved();
  if (existing) return existing;
  const fresh = new Uint8Array(randomBytes(16));
  const content = `${toHex(fresh)}\n`;
  ensurePrivateDir(dir);
  const tmp = `${path}.tmp.${process.pid}.${randomBytes(4).toString('hex')}`;
  writeFileSync(tmp, content, { mode: 0o600, flag: 'wx' });
  try {
    try {
      chmodSync(tmp, 0o600);
    } catch {
      // Non-POSIX filesystems may ignore chmod.
    }
    linkSync(tmp, path);
    return fresh;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'EEXIST') {
      const raced = readSaved();
      if (raced) return raced;
      writePrivateFile(path, content);
      return fresh;
    }
    throw error;
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      // Best-effort cleanup of temp file.
    }
  }
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
  const ascii = encodeQR(uri, 'ascii', { ecc: 'low', border: 2 }).trimEnd();
  if (!options.color) return ascii;
  return ascii
    .split('\n')
    .map((line) => `\x1b[38;5;231;48;5;16m${line}\x1b[0m`)
    .join('\n');
}

export function qrSvg(uri: string): string {
  const svg = encodeQR(uri, 'svg', { ecc: 'low', border: 4 });
  return `${svg.replace('>', ' shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/>')}\n`;
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
  const clockReadAt = now();
  if (clock.protocolVersion < APP_CONNECT_MIN_PROTOCOL) {
    throw new Error(`wallet sign-in needs Platform protocol ${APP_CONNECT_MIN_PROTOCOL}, and ${input.config.network} runs ${clock.protocolVersion}`);
  }
  const pending = newWalletRequest(input.config, { connectionId: input.connectionId, chainNow: clock.timeMs, now: clockReadAt });
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
    const chainNow = clock.timeMs + Math.max(0, now() - clockReadAt);
    if (grant.expiresAt <= chainNow + EXPIRY_MARGIN_MS) {
      throw new Error('the key your wallet approved expires within 5 minutes; start again');
    }
    if (input.signal?.aborted) throw new DOMException('cancelled', 'AbortError');
    await input.verifyWriter(grant.identityId, grant.privateKey);
    if (input.signal?.aborted) throw new DOMException('cancelled', 'AbortError');
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
