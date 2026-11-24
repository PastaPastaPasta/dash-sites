import type { EvoSDK, IdentityPublicKey } from '@dashevo/evo-sdk';
import * as secp from '@noble/secp256k1';
import { base58, base64 } from '@scure/base';
import { fromHex } from './bytes.js';
import type { NetworkConfig } from './config.js';
import {
  APP_CONNECT_MAX_REQUEST_AGE_MS,
  KeySecurityLevel,
  appConnectCandidateKey,
  appConnectSlotCount,
  appConnectPollDelayMs,
  appConnectRequestHash,
  buildAppConnectUri,
  listAppConnectCandidates,
  verifyAppConnectCandidate,
  type AppConnectCandidate,
  type AppConnectGrant,
  type AppConnectIdentityKey,
  type AppConnectIdentityPort,
  type AppConnectKeyBounds,
  type AppConnectRejectReason,
  type AppConnectRequest,
  type AppConnectResponsePort,
} from './vendor/app-connect/index.js';

/** The App Connect system contract: the same id on every network from protocol 14. */
export const APP_CONNECT_CONTRACT_ID = 'H8F9mP1BM55TE1ShsxPZHzhyinaMdY9bMmP85mkDhcJJ';
export const APP_CONNECT_MIN_PROTOCOL = 14;
export const APP_CONNECT_LABEL = 'Dash Sites';
/** What a request proposes; the wallet's owner sets the final figures on the approval sheet. */
export const WALLET_BUDGET_CREDITS = 20_000_000_000n;
export const WALLET_LIFETIME_MS = 90 * 86_400_000;
/** Wallets refuse a request dated more than 2 minutes ahead of their clock. */
export const CREATED_AT_LEAD_MS = 90_000;
const SETTLE_MS = 3000;

export interface ChainClock {
  timeMs: number;
  protocolVersion: number;
}

export interface ConnectPort extends AppConnectIdentityPort, AppConnectResponsePort {
  chainClock(): Promise<ChainClock>;
}

function keyBounds(key: IdentityPublicKey): AppConnectKeyBounds | undefined | null {
  const bounds = key.contractBounds;
  if (!bounds) return undefined;
  let json: { $type?: unknown; id?: unknown; documentTypeName?: unknown };
  try {
    json = bounds.toJSON() as typeof json;
  } catch {
    return null;
  }
  if (typeof json.id !== 'string') return null;
  if (json.$type === 'singleContract') return { kind: 'singleContract', contractId: json.id };
  if (json.$type === 'contractGroup') return { kind: 'contractGroup', groupId: json.id };
  if (json.$type === 'documentType' && typeof json.documentTypeName === 'string') {
    return { kind: 'documentType', contractId: json.id, documentTypeName: json.documentTypeName };
  }
  return null;
}

/** Null for a key that cannot be read in full: an unreadable bound must never look unbound. */
export function toConnectKey(key: IdentityPublicKey): AppConnectIdentityKey | null {
  const bounds = keyBounds(key);
  const hex = String(key.data).toLowerCase();
  const data = /^(?:[0-9a-f]{2})+$/.test(hex) ? fromHex(hex) : null;
  if (bounds === null || data === null || key.keyTypeNumber === undefined) return null;
  return {
    id: key.keyId,
    type: key.keyTypeNumber,
    purpose: key.purposeNumber,
    securityLevel: key.securityLevelNumber,
    data,
    ...(key.disabledAt !== undefined ? { disabledAt: Number(key.disabledAt) } : {}),
    ...(bounds !== undefined ? { bounds } : {}),
    ...(key.totalBudget !== undefined ? { totalBudget: key.totalBudget } : {}),
    ...(key.expiresAt !== undefined ? { expiresAt: Number(key.expiresAt) } : {}),
  };
}

function connectKeys(keys: IdentityPublicKey[]): AppConnectIdentityKey[] {
  return keys.flatMap((key) => {
    const mapped = toConnectKey(key);
    return mapped ? [mapped] : [];
  });
}

function compareIds(a: string, b: string): number {
  const left = base58.decode(a);
  const right = base58.decode(b);
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    const difference = (left[i] ?? 0) - (right[i] ?? 0);
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
}

function isIdentifier(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    return base58.decode(value).length === 32;
  } catch {
    return false;
  }
}

function bytesOf(value: unknown): Uint8Array {
  return value instanceof Uint8Array ? value : new Uint8Array(0);
}

interface ResponseDocument {
  ownerId: { toBase58(): string };
  toObject(): Record<string, unknown>;
}

/**
 * A row whose bytes do not read is kept with empty bytes, which the verifier refuses: dropping it
 * would shorten the page, and the poller takes a short page for the last one.
 */
function candidateOf(document: ResponseDocument): AppConnectCandidate {
  const ownerId = document.ownerId.toBase58();
  if (!isIdentifier(ownerId)) throw new Error('an App Connect answer has no readable owner');
  const object = document.toObject();
  return { ownerId, walletEphemeralPubKey: bytesOf(object.walletEphemeralPubKey), encryptedPayload: bytesOf(object.encryptedPayload) };
}

/** The reads sign-in needs, each one proof-verified by the SDK. */
export function connectPort(sdk: EvoSDK): ConnectPort {
  return {
    async getIdentityFresh(identityId) {
      const identity = await sdk.identities.fetch(identityId);
      return identity ? { id: identityId, publicKeys: connectKeys(identity.publicKeys) } : null;
    },

    async remainingBudgets(identityId, keyIds) {
      const budgets = await sdk.identities.keysRemainingBudgets(identityId, keyIds);
      const out = new Map<number, bigint | undefined>();
      for (const [keyId, remaining] of budgets) out.set(Number(keyId), remaining ?? undefined);
      return out;
    },

    async contractKeys(identityId, contractId, purpose) {
      const entries = await sdk.identities.contractKeys({ identityIds: [identityId], contractId, purposes: [purpose] } as never);
      const entry = entries.find((found) => found.identityId.toBase58() === identityId);
      return entry ? connectKeys(entry.keys) : [];
    },

    async groupInfo() {
      return null;
    },

    async listCandidates(requestHash, hint, startAfter, limit) {
      const where: unknown[][] = [['appEphemeralPubKeyHash', '==', base64.encode(requestHash)]];
      if (hint !== undefined) where.push(['$ownerId', '==', hint]);
      else if (startAfter !== undefined) where.push(['$ownerId', '>', startAfter]);
      const query = {
        dataContractId: APP_CONNECT_CONTRACT_ID,
        documentTypeName: 'loginKeyResponse',
        where,
        orderBy: [
          ['appEphemeralPubKeyHash', 'asc'],
          ['$ownerId', 'asc'],
        ],
        limit,
      };
      const rows = (await sdk.documents.query(query as never)) as unknown as Map<string, ResponseDocument | undefined>;
      return [...rows.values()]
        .filter((row): row is ResponseDocument => row !== undefined)
        .map(candidateOf)
        .sort((a, b) => compareIds(a.ownerId, b.ownerId));
    },

    async chainClock() {
      const { metadata } = await sdk.protocol.versionUpgradeStateWithProof();
      const timeMs = Number(metadata.timeMs);
      if (!Number.isSafeInteger(timeMs) || timeMs <= 0) throw new Error('Platform returned no block time');
      return { timeMs, protocolVersion: metadata.protocolVersion };
    },
  };
}

/** The device's clock, held between the chain's time and 90 seconds past it. */
export function requestCreatedAt(now: number, chainNow: number): number {
  return Math.min(Math.max(now, chainNow), chainNow + CREATED_AT_LEAD_MS);
}

export interface WalletRequest {
  request: AppConnectRequest;
  /** `dashpay://connect` link: shown as a QR code, or opened on a phone that has the wallet. */
  uri: string;
  requestHash: Uint8Array;
  /** This device's clock when the request was made. */
  createdAt: number;
  expiresAt: number;
  chainTimeAtCreation: number;
  appEphemeralPriv: Uint8Array;
}

export interface WalletRequestOptions {
  /** 16 random bytes kept by this browser: the wallet disables its previous key for the same id. */
  connectionId: Uint8Array;
  chainNow: number;
  now?: number;
}

/**
 * Asks a wallet for one key: AUTHENTICATION, HIGH, bound to the dash-sites contract, with a budget
 * and an expiry. Such a key signs site and chunk documents and nothing else.
 */
export function newWalletRequest(config: NetworkConfig, options: WalletRequestOptions): WalletRequest {
  const now = options.now ?? Date.now();
  const contract = base58.decode(config.contractId);
  const appEphemeralPriv = secp.utils.randomSecretKey();
  const request: AppConnectRequest = {
    appEphemeralPubKey: secp.getPublicKey(appEphemeralPriv, true),
    appId: contract,
    label: APP_CONNECT_LABEL,
    authBindings: [
      {
        kind: 'singleContract',
        id: contract,
        securityLevel: KeySecurityLevel.HIGH,
        totalBudget: WALLET_BUDGET_CREDITS,
        expiresAt: options.chainNow + WALLET_LIFETIME_MS,
      },
    ],
    encBindings: [],
    createdAt: requestCreatedAt(now, options.chainNow),
    connectionId: options.connectionId,
  };
  return {
    request,
    uri: buildAppConnectUri(request, config.network),
    requestHash: appConnectRequestHash(request),
    createdAt: now,
    expiresAt: now + APP_CONNECT_MAX_REQUEST_AGE_MS,
    chainTimeAtCreation: options.chainNow,
    appEphemeralPriv,
  };
}

export class AmbiguousWalletLogin extends Error {
  constructor(readonly identityIds: readonly string[]) {
    super('More than one identity answered this sign-in request, so someone else saw the code. Start again and keep the code private.');
    this.name = 'AmbiguousWalletLogin';
  }
}

export class RequestExpired extends Error {
  constructor() {
    super('This sign-in request expired. Start a new one.');
    this.name = 'RequestExpired';
  }
}

export class TooManyAnswers extends Error {
  constructor() {
    super('Too many answers reached this sign-in request to check them all. Start again and keep the code private.');
    this.name = 'TooManyAnswers';
  }
}

const REFUSED: Partial<Record<AppConnectRejectReason, string>> = {
  'key-disabled': 'The key your wallet sent is already disabled.',
  'key-expired': 'The key your wallet sent expires within the hour.',
  'budget-exhausted': 'The key your wallet sent has no budget left.',
  'key-limits': 'The key your wallet sent has no spending limit or no expiry.',
  'key-level': 'The key your wallet sent can do more than Dash Sites asked for.',
  'key-master': 'Your wallet sent its master key.',
  'key-unmatched': 'The key your wallet sent is for something other than Dash Sites.',
  'key-unbound': 'The key your wallet sent is not limited to Dash Sites.',
};

export class WalletGrantRefused extends Error {
  constructor(readonly reason: AppConnectRejectReason) {
    super(`${REFUSED[reason] ?? "Your wallet's answer does not match what Dash Sites asked for."} It was not used. Start again.`);
    this.name = 'WalletGrantRefused';
  }
}

const cancelled = (): Error => new DOMException('cancelled', 'AbortError');

/** Cuts the poll's wait short, for when the tab is looked at again. */
export class PollTrigger {
  private wake: (() => void) | undefined;
  private pending = false;

  fire(): void {
    if (this.wake) this.wake();
    else this.pending = true;
  }

  wait(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(cancelled());
      if (this.pending) {
        this.pending = false;
        return resolve();
      }
      const end = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        this.wake = undefined;
      };
      const onAbort = (): void => {
        end();
        reject(cancelled());
      };
      const done = (): void => {
        end();
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.wake = done;
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
}

/** A verified key from a wallet. Whose wallet answered is not proven: the user confirms the identity. */
export interface WalletGrant {
  identityId: string;
  privateKey: Uint8Array;
  keyId: number;
  totalBudget: bigint;
  remainingBudget: bigint;
  expiresAt: number;
}

export type PollStatus = 'waiting' | 'answered' | 'incomplete-read';

export interface AwaitGrantOptions {
  signal?: AbortSignal;
  trigger?: PollTrigger;
  now?: () => number;
  intervalMs?: number;
  settleMs?: number;
  onStatus?: (status: PollStatus) => void;
}

/** A payload of the wrong length was never opened; one of the right length with too many keys was. */
function opened(reason: AppConnectRejectReason, candidate: AppConnectCandidate): boolean {
  return reason !== 'decrypt' && (reason !== 'framing' || appConnectSlotCount(candidate.encryptedPayload.length) !== null);
}

function grantOf(grant: AppConnectGrant): WalletGrant {
  const [main, ...others] = grant.authKeys;
  const totalBudget = main?.key.totalBudget;
  const expiresAt = main?.key.expiresAt;
  const remainingBudget = main?.remainingBudget;
  if (main?.role !== 'singleContract' || others.length > 0 || grant.encryptionKeys.length > 0 || totalBudget === undefined || expiresAt === undefined || remainingBudget === undefined) {
    for (const key of [...grant.authKeys, ...grant.encryptionKeys]) key.privateKey.fill(0);
    throw new WalletGrantRefused(main?.role !== 'singleContract' ? 'key-unmatched' : 'key-limits');
  }
  return { identityId: grant.identityId, privateKey: main.privateKey, keyId: main.key.id, totalBudget, remainingBudget, expiresAt };
}

/**
 * Polls until one identity's answer verifies, then keeps reading for a few seconds in case a
 * second identity answers too. Every answer that opens with this request's key counts as a
 * responder, usable or not, so a quick stranger cannot win over the owner's slower wallet; a read
 * that fails never counts as "nobody else answered".
 */
export async function awaitWalletGrant(port: ConnectPort, pending: WalletRequest, options: AwaitGrantOptions = {}): Promise<WalletGrant> {
  const now = options.now ?? Date.now;
  const settleMs = options.settleMs ?? SETTLE_MS;
  const trigger = options.trigger ?? new PollTrigger();
  const answered = new Map<string, WalletGrant | WalletGrantRefused | null>();
  const notAnswers = new Set<string>();
  let cleanSince = 0;
  let firstAt = 0;
  try {
    for (;;) {
      if (options.signal?.aborted) throw cancelled();
      const readAt = now();
      const page = await listAppConnectCandidates(port, pending.requestHash).catch(() => null);
      if (page?.truncated) throw new TooManyAnswers();
      for (const candidate of page?.candidates ?? []) {
        if (answered.get(candidate.ownerId)) continue;
        const contents = appConnectCandidateKey(candidate);
        if (notAnswers.has(contents)) continue;
        let answer: WalletGrant | WalletGrantRefused | null = null;
        try {
          const verdict = await verifyAppConnectCandidate({
            request: pending.request,
            appEphemeralPrivateKey: pending.appEphemeralPriv,
            candidate,
            identity: port,
            now: pending.chainTimeAtCreation + (now() - pending.createdAt),
          });
          if (!verdict.ok && !opened(verdict.reason, candidate)) {
            notAnswers.add(contents);
            continue;
          }
          if (verdict.ok) answer = grantOf(verdict.grant);
          else if (!verdict.retryable) answer = new WalletGrantRefused(verdict.reason);
        } catch (error) {
          if (error instanceof WalletGrantRefused) answer = error;
        }
        answered.set(candidate.ownerId, answer);
        if (answer !== null && firstAt === 0) firstAt = now();
      }
      if (answered.size > 1) throw new AmbiguousWalletLogin([...answered.keys()]);
      const time = now();
      if (page === null) cleanSince = 0;
      else if (cleanSince === 0) cleanSince = readAt;
      options.onStatus?.(page === null ? 'incomplete-read' : answered.size > 0 ? 'answered' : 'waiting');
      const only = [...answered.values()].find((answer) => answer !== null);
      if (only && cleanSince !== 0 && readAt - Math.max(firstAt, cleanSince) >= settleMs) {
        if (only instanceof WalletGrantRefused) throw only;
        if (options.signal?.aborted) throw cancelled();
        return only;
      }
      const delay = options.intervalMs ?? appConnectPollDelayMs(time - pending.createdAt);
      if (time >= pending.expiresAt || delay === null) throw new RequestExpired();
      await trigger.wait(delay, options.signal);
    }
  } catch (error) {
    for (const answer of answered.values()) if (answer && !(answer instanceof WalletGrantRefused)) answer.privateKey.fill(0);
    throw error;
  } finally {
    pending.appEphemeralPriv.fill(0);
  }
}
