import { ripemd160 } from '@noble/hashes/legacy.js';
import { sha256 } from '@noble/hashes/sha2.js';
import * as secp from '@noble/secp256k1';
import { base58 } from '@scure/base';
import { describe, expect, it } from 'vitest';
import {
  AmbiguousWalletLogin,
  APP_CONNECT_LABEL,
  CREATED_AT_LEAD_MS,
  RequestExpired,
  TooManyAnswers,
  WALLET_BUDGET_CREDITS,
  WALLET_LIFETIME_MS,
  WalletGrantRefused,
  awaitWalletGrant,
  newWalletRequest,
  requestCreatedAt,
  toConnectKey,
  type ConnectPort,
  type WalletRequest,
} from '../src/connect.js';
import { networkConfig } from '../src/config.js';
import {
  KeyPurpose,
  KeySecurityLevel,
  KeyType,
  parseAppConnectUri,
  sealAppConnectPayload,
  type AppConnectCandidate,
  type AppConnectIdentityKey,
} from '../src/vendor/app-connect/index.js';

const CONFIG = networkConfig('testnet');
const CHAIN_NOW = 1_795_000_000_000;
const id = (): string => base58.encode(crypto.getRandomValues(new Uint8Array(32)));
const request = (now = CHAIN_NOW): WalletRequest => newWalletRequest(CONFIG, { connectionId: new Uint8Array(16).fill(7), chainNow: CHAIN_NOW, now });

function byBytes(a: string, b: string): number {
  const [left, right] = [base58.decode(a), base58.decode(b)];
  for (let i = 0; i < 32; i++) if (left[i] !== right[i]) return (left[i] ?? 0) - (right[i] ?? 0);
  return 0;
}

interface Answer {
  bounds?: AppConnectIdentityKey['bounds'] | null;
  totalBudget?: bigint | null;
  remaining?: bigint;
  /** The wallet's key is not on the identity for this many reads. */
  lag?: number;
  /** Extra keys sealed into the answer beyond the one that was asked for. */
  extraSlots?: number;
}

function world() {
  const keys = new Map<string, AppConnectIdentityKey[]>();
  const remaining = new Map<number, bigint>();
  const lag = new Map<string, number>();
  const rows: AppConnectCandidate[] = [];
  let nextKey = 5;
  let failingReads = 0;
  const port: ConnectPort = {
    async getIdentityFresh(identityId) {
      const left = lag.get(identityId) ?? 0;
      lag.set(identityId, left - 1);
      return { id: identityId, publicKeys: left > 0 ? [] : (keys.get(identityId) ?? []) };
    },
    async remainingBudgets(_identityId, keyIds) {
      return new Map(keyIds.map((keyId) => [keyId, remaining.get(keyId)]));
    },
    async contractKeys() {
      return [];
    },
    async groupInfo() {
      return null;
    },
    async listCandidates(_hash, _hint, startAfter, limit) {
      if (failingReads > 0) {
        failingReads -= 1;
        throw new Error('the node did not answer');
      }
      return rows
        .filter((row) => startAfter === undefined || byBytes(row.ownerId, startAfter) > 0)
        .sort((a, b) => byBytes(a.ownerId, b.ownerId))
        .slice(0, limit);
    },
    async chainClock() {
      return { timeMs: CHAIN_NOW, protocolVersion: 14 };
    },
  };
  return {
    port,
    failReads(count: number) {
      failingReads = count;
    },
    junk(pending: WalletRequest) {
      rows.push({ ownerId: id(), walletEphemeralPubKey: pending.request.appEphemeralPubKey, encryptedPayload: new Uint8Array(60).fill(1) });
    },
    async answer(pending: WalletRequest, options: Answer = {}): Promise<{ ownerId: string; keyId: number }> {
      const ownerId = id();
      const secret = secp.utils.randomSecretKey();
      const keyId = nextKey++;
      const bounds = options.bounds === undefined ? ({ kind: 'singleContract', contractId: CONFIG.contractId } as const) : options.bounds;
      const totalBudget = options.totalBudget === undefined ? 15_000_000_000n : options.totalBudget;
      keys.set(ownerId, [
        {
          id: keyId,
          type: KeyType.ECDSA_HASH160,
          purpose: KeyPurpose.AUTHENTICATION,
          securityLevel: KeySecurityLevel.HIGH,
          data: ripemd160(sha256(secp.getPublicKey(secret, true))),
          expiresAt: CHAIN_NOW + 30 * 86_400_000,
          ...(bounds ? { bounds } : {}),
          ...(totalBudget !== null ? { totalBudget } : {}),
        },
      ]);
      if (totalBudget !== null) remaining.set(keyId, options.remaining ?? totalBudget);
      if (options.lag) lag.set(ownerId, options.lag);
      const sealed = await sealAppConnectPayload({ appEphemeralPubKey: pending.request.appEphemeralPubKey, ownerId: base58.decode(ownerId), slots: [secret, ...Array.from({ length: options.extraSlots ?? 0 }, () => secp.utils.randomSecretKey())] });
      rows.push({ ownerId, ...sealed });
      return { ownerId, keyId };
    },
  };
}

const QUICK = { intervalMs: 1, settleMs: 0 };

describe('sign-in request', () => {
  it('asks for one high key bound to the dash-sites contract, with a budget and an expiry', () => {
    const pending = request();
    expect(pending.uri).toMatch(/^dashpay:\/\/connect\?v=2&n=t&r=[A-Za-z0-9_-]+$/);
    const parsed = parseAppConnectUri(pending.uri);
    expect(parsed.network).toBe('testnet');
    expect(parsed.request.label).toBe(APP_CONNECT_LABEL);
    expect(base58.encode(parsed.request.appId)).toBe(CONFIG.contractId);
    expect(parsed.request.encBindings).toEqual([]);
    expect(parsed.request.authBindings).toHaveLength(1);
    const [binding] = parsed.request.authBindings;
    expect(binding?.kind).toBe('singleContract');
    expect(base58.encode(binding?.id ?? new Uint8Array())).toBe(CONFIG.contractId);
    expect(binding?.securityLevel).toBe(KeySecurityLevel.HIGH);
    expect(binding?.totalBudget).toBe(WALLET_BUDGET_CREDITS);
    expect(binding?.expiresAt).toBe(CHAIN_NOW + WALLET_LIFETIME_MS);
    expect(parsed.request.connectionId).toEqual(new Uint8Array(16).fill(7));
    expect(parsed.callbackUrl).toBeUndefined();
  });

  it('uses a new key for every request', () => {
    expect(request().uri).not.toBe(request().uri);
  });

  it('dates the request by the chain, never more than 90 seconds past it', () => {
    expect(requestCreatedAt(CHAIN_NOW + 5_000, CHAIN_NOW)).toBe(CHAIN_NOW + 5_000);
    expect(requestCreatedAt(CHAIN_NOW + 240_000, CHAIN_NOW)).toBe(CHAIN_NOW + CREATED_AT_LEAD_MS);
    expect(requestCreatedAt(CHAIN_NOW - 60_000, CHAIN_NOW)).toBe(CHAIN_NOW);
    expect(parseAppConnectUri(request(CHAIN_NOW + 240_000).uri).request.createdAt).toBe(CHAIN_NOW + CREATED_AT_LEAD_MS);
  });
});

describe('waiting for the wallet', () => {
  it('returns the key a wallet granted, and wipes the request key', async () => {
    const { port, answer } = world();
    const pending = request(Date.now());
    const granted = await answer(pending, { remaining: 14_000_000_000n });
    const grant = await awaitWalletGrant(port, pending, QUICK);
    expect(grant.identityId).toBe(granted.ownerId);
    expect(grant.keyId).toBe(granted.keyId);
    expect(grant.totalBudget).toBe(15_000_000_000n);
    expect(grant.remainingBudget).toBe(14_000_000_000n);
    expect(grant.expiresAt).toBe(CHAIN_NOW + 30 * 86_400_000);
    expect(grant.privateKey).toHaveLength(32);
    expect(pending.appEphemeralPriv.every((byte) => byte === 0)).toBe(true);
  });

  it('ignores rows that are not answers to this request', async () => {
    const { port, answer, junk } = world();
    const pending = request(Date.now());
    junk(pending);
    const granted = await answer(pending);
    expect((await awaitWalletGrant(port, pending, QUICK)).identityId).toBe(granted.ownerId);
  });

  it('waits for a key the node does not show yet', async () => {
    const { port, answer } = world();
    const pending = request(Date.now());
    const granted = await answer(pending, { lag: 3 });
    const seen: string[] = [];
    const grant = await awaitWalletGrant(port, pending, { ...QUICK, onStatus: (status) => seen.push(status) });
    expect(grant.keyId).toBe(granted.keyId);
    expect(seen.filter((status) => status === 'answered').length).toBeGreaterThan(1);
  });

  it('refuses when two identities answer, even if only one key is usable', async () => {
    const { port, answer } = world();
    const pending = request(Date.now());
    await answer(pending);
    await answer(pending, { bounds: null });
    await expect(awaitWalletGrant(port, pending, QUICK)).rejects.toBeInstanceOf(AmbiguousWalletLogin);
    expect(pending.appEphemeralPriv.every((byte) => byte === 0)).toBe(true);
  });

  it.each([
    ['is not bound to anything', { bounds: null }, 'key-unbound'],
    ['is bound to another contract', { bounds: { kind: 'singleContract', contractId: id() } as const }, 'key-unmatched'],
    ['has no budget', { totalBudget: null }, 'key-limits'],
    ['has spent its budget', { remaining: 0n }, 'budget-exhausted'],
  ])('refuses a key that %s', async (_name, options, reason) => {
    const { port, answer } = world();
    const pending = request(Date.now());
    await answer(pending, options);
    const refused = await awaitWalletGrant(port, pending, QUICK).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(WalletGrantRefused);
    expect((refused as WalletGrantRefused).reason).toBe(reason);
  });

  it('does not take a failed read for nobody else answering', async () => {
    const { port, answer, failReads } = world();
    const pending = request(Date.now());
    await answer(pending);
    failReads(3);
    const seen: string[] = [];
    await awaitWalletGrant(port, pending, { ...QUICK, onStatus: (status) => seen.push(status) });
    expect(seen.slice(0, 3)).toEqual(['incomplete-read', 'incomplete-read', 'incomplete-read']);
    expect(seen.at(-1)).toBe('answered');
  });

  it('keeps reading for a while after the first answer, so a second identity is still caught', async () => {
    const { port, answer } = world();
    const pending = request(Date.now());
    await answer(pending);
    let clock = Date.now();
    let polls = 0;
    const waiting = awaitWalletGrant(port, pending, {
      intervalMs: 1,
      settleMs: 1000,
      now: () => clock,
      onStatus: () => {
        if (++polls === 1) void answer(pending).then(() => (clock += 2000));
      },
    });
    await expect(waiting).rejects.toBeInstanceOf(AmbiguousWalletLogin);
  });

  it('returns the only answer once the wait is over', async () => {
    const { port, answer } = world();
    const pending = request(Date.now());
    const granted = await answer(pending);
    let clock = Date.now();
    let polls = 0;
    const grant = await awaitWalletGrant(port, pending, {
      intervalMs: 1,
      settleMs: 1000,
      now: () => clock,
      onStatus: () => {
        if (++polls === 3) clock += 1000;
      },
    });
    expect(grant.identityId).toBe(granted.ownerId);
    expect(polls).toBe(4);
  });

  it('does not let the wait run out while reads fail', async () => {
    const { port, answer, failReads } = world();
    const pending = request(Date.now());
    await answer(pending);
    let clock = Date.now();
    let polls = 0;
    const waiting = awaitWalletGrant(port, pending, {
      intervalMs: 1,
      settleMs: 1000,
      now: () => clock,
      onStatus: () => {
        if (++polls !== 1) return;
        failReads(Number.MAX_SAFE_INTEGER);
        clock += 5000;
        void answer(pending).then(() => failReads(0));
      },
    });
    await expect(waiting).rejects.toBeInstanceOf(AmbiguousWalletLogin);
  });

  it('does not hand over a key after being cancelled', async () => {
    const { port, answer } = world();
    const pending = request(Date.now());
    await answer(pending);
    const abort = new AbortController();
    const waiting = awaitWalletGrant(port, pending, { ...QUICK, signal: abort.signal, onStatus: () => abort.abort() });
    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('counts an answer that opens but holds too many keys as a second responder', async () => {
    const { port, answer } = world();
    const pending = request(Date.now());
    await answer(pending);
    await answer(pending, { extraSlots: 1 });
    await expect(awaitWalletGrant(port, pending, QUICK)).rejects.toBeInstanceOf(AmbiguousWalletLogin);
  });

  it('measures the wait from when a read began, not from when it came back', async () => {
    const { port, answer } = world();
    const pending = request(Date.now());
    await answer(pending);
    let clock = Date.now();
    let reads = 0;
    const slow: ConnectPort = {
      ...port,
      async listCandidates(...args) {
        const seen = await port.listCandidates(...args);
        if (++reads === 2) {
          await answer(pending);
          clock += 5000;
        }
        return seen;
      },
    };
    await expect(awaitWalletGrant(slow, pending, { intervalMs: 1, settleMs: 1000, now: () => clock })).rejects.toBeInstanceOf(AmbiguousWalletLogin);
  });

  it('gives up on more answers than it will read', async () => {
    const { port, junk } = world();
    const pending = request(Date.now());
    for (let i = 0; i < 21; i++) junk(pending);
    await expect(awaitWalletGrant(port, pending, QUICK)).rejects.toBeInstanceOf(TooManyAnswers);
  });

  it('expires after ten minutes', async () => {
    const { port } = world();
    const pending = request(Date.now());
    let clock = Date.now();
    const now = (): number => (clock += 4 * 60_000);
    await expect(awaitWalletGrant(port, pending, { ...QUICK, now })).rejects.toBeInstanceOf(RequestExpired);
  });

  it('stops when cancelled', async () => {
    const { port } = world();
    const abort = new AbortController();
    const waiting = awaitWalletGrant(port, request(Date.now()), { signal: abort.signal });
    abort.abort();
    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('identity keys', () => {
  const key = (over: Record<string, unknown>) =>
    ({ keyId: 9, keyTypeNumber: 2, purposeNumber: 0, securityLevelNumber: 2, data: 'ab'.repeat(20), disabledAt: undefined, contractBounds: undefined, totalBudget: undefined, expiresAt: undefined, ...over }) as never;
  const bounds = (json: unknown) => ({ toJSON: () => json });

  it('reads a bound, limited key', () => {
    const mapped = toConnectKey(key({ contractBounds: bounds({ $type: 'singleContract', id: CONFIG.contractId }), totalBudget: 5n, expiresAt: 99n }));
    expect(mapped).toMatchObject({ id: 9, type: 2, bounds: { kind: 'singleContract', contractId: CONFIG.contractId }, totalBudget: 5n, expiresAt: 99 });
    expect(mapped?.data).toHaveLength(20);
  });

  it('drops a key whose bounds it cannot read, so it never looks unbound', () => {
    expect(toConnectKey(key({ contractBounds: bounds({ $type: 'somethingNew', id: CONFIG.contractId }) }))).toBeNull();
    expect(toConnectKey(key({ contractBounds: { toJSON: () => { throw new Error('unreadable'); } } }))).toBeNull();
    expect(toConnectKey(key({}))).not.toBeNull();
  });

  it('reads key data in either case, and drops what is not hex', () => {
    expect(toConnectKey(key({ data: 'AB'.repeat(20) }))?.data).toEqual(new Uint8Array(20).fill(0xab));
    expect(toConnectKey(key({ data: 'not hex' }))).toBeNull();
  });
});
