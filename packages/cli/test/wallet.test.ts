import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ripemd160 } from '@noble/hashes/legacy.js';
import { sha256 } from '@noble/hashes/sha2.js';
import * as secp from '@noble/secp256k1';
import { base58 } from '@scure/base';
import encodeQR from 'qr';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { networkConfig, toHex, type DomainRecord } from '@dash-sites/core';
import { type ConnectPort, type WalletRequest } from '@dash-sites/core/connect';
import { KeyPurpose, KeySecurityLevel, KeyType, sealAppConnectPayload, type AppConnectCandidate, type AppConnectIdentityKey } from '../../core/src/vendor/app-connect/index.js';
import { clearSession, configDir, connectionId, loadSession, qrSvg, qrTerminal, runWalletLogin, saveSession, sessionPath, type StoredSession } from '../src/wallet.js';

const CONFIG = networkConfig('testnet');
const CHAIN_NOW = 1_795_000_000_000;
const randomId = (): string => base58.encode(crypto.getRandomValues(new Uint8Array(32)));

const tempDirs: string[] = [];
function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dash-sites-cli-wallet-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

function mockConnectWorld(protocolVersion = 14) {
  const keys = new Map<string, AppConnectIdentityKey[]>();
  const remaining = new Map<number, bigint>();
  const rows: AppConnectCandidate[] = [];
  let nextKey = 5;
  const port: ConnectPort = {
    async getIdentityFresh(identityId) {
      return { id: identityId, publicKeys: keys.get(identityId) ?? [] };
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
    async listCandidates(_hash, _hint, _startAfter, limit) {
      return rows.slice(0, limit);
    },
    async chainClock() {
      return { timeMs: CHAIN_NOW, protocolVersion };
    },
  };
  return {
    port,
    async answer(pending: WalletRequest, options: { ownerId?: string; expiresAt?: number; remaining?: bigint } = {}) {
      const ownerId = options.ownerId ?? randomId();
      const secret = secp.utils.randomSecretKey();
      const keyId = nextKey++;
      const totalBudget = 20_000_000_000n;
      keys.set(ownerId, [
        {
          id: keyId,
          type: KeyType.ECDSA_HASH160,
          purpose: KeyPurpose.AUTHENTICATION,
          securityLevel: KeySecurityLevel.HIGH,
          data: ripemd160(sha256(secp.getPublicKey(secret, true))),
          bounds: { kind: 'singleContract', contractId: CONFIG.contractId },
          totalBudget,
          expiresAt: options.expiresAt ?? CHAIN_NOW + 30 * 86_400_000,
        },
      ]);
      remaining.set(keyId, options.remaining ?? totalBudget);
      const sealed = await sealAppConnectPayload({
        appEphemeralPubKey: pending.request.appEphemeralPubKey,
        ownerId: base58.decode(ownerId),
        slots: [secret],
      });
      rows.push({ ownerId, ...sealed });
      return { ownerId, keyId, secretHex: toHex(secret) };
    },
  };
}

describe('configDir', () => {
  it('prefers DASH_SITES_CONFIG_DIR over XDG_CONFIG_HOME', () => {
    expect(configDir({ DASH_SITES_CONFIG_DIR: '/custom/dir', XDG_CONFIG_HOME: '/xdg' })).toBe('/custom/dir');
    expect(configDir({ XDG_CONFIG_HOME: '/xdg' })).toBe('/xdg/dash-sites');
  });
});

describe('connectionId and session storage', () => {
  const sample: StoredSession = {
    v: 1,
    network: 'mainnet',
    contractId: 'GCSi8NkjXyRpLC7FsEnCfx5ntmWZ16bD2t9zc4JiT4X3',
    identityId: '7FfS68UTzjAiTNdRQhHEEZMNX2NThoj28chdPLecbMLU',
    keyId: 7,
    privateKey: 'ab'.repeat(32),
    expiresAt: CHAIN_NOW + 86_400_000,
  };

  it('persists connectionId per network and survives logout', () => {
    const dir = join(makeTempDir(), 'cfg');
    const first = connectionId(dir, 'mainnet');
    expect(first).toHaveLength(16);
    expect(connectionId(dir, 'mainnet')).toEqual(first);
    expect(connectionId(dir, 'testnet')).not.toEqual(first);

    const file = saveSession(dir, sample);
    expect(file).toBe(sessionPath(dir, 'mainnet'));
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(loadSession(dir, 'mainnet')).toEqual(sample);
    expect(loadSession(dir, 'testnet')).toBeUndefined();

    expect(clearSession(dir, 'mainnet')).toBe(true);
    expect(clearSession(dir, 'mainnet')).toBe(false);
    expect(loadSession(dir, 'mainnet')).toBeUndefined();
    expect(connectionId(dir, 'mainnet')).toEqual(first);
  });

  it('ignores unreadable or malformed session files', () => {
    const dir = makeTempDir();
    const file = saveSession(dir, sample);
    chmodSync(file, 0o600);
    expect(loadSession(dir, 'mainnet')).toEqual(sample);
    const badPath = sessionPath(dir, 'testnet');
    expect(loadSession(dir, 'testnet')).toBeUndefined();
    const brokenDir = makeTempDir();
    saveSession(brokenDir, { ...sample, network: 'testnet' });
    const raw = JSON.parse(readFileSync(sessionPath(brokenDir, 'testnet'), 'utf8')) as Record<string, unknown>;
    raw.privateKey = 'not-hex';
    saveSession(brokenDir, raw as unknown as StoredSession);
    expect(loadSession(brokenDir, 'testnet')).toBeUndefined();
    expect(badPath).toContain('session.testnet.json');
  });
});

describe('QR rendering', () => {
  const uri = 'dashpay://connect?v=2&n=m&r=AgISFYXyWOlkb3iXHasW-mHC89Hg7u5cQ2h1bmtzIG9mIGEgcmVxdWVzdCBib2R5';

  it('delegates terminal QR rendering to qr ascii output and wraps with white-on-black ANSI when colored', () => {
    const expected = encodeQR(uri, 'ascii', { ecc: 'low', border: 2 }).trimEnd();
    expect(qrTerminal(uri, { color: false })).toBe(expected);

    const colored = qrTerminal(uri, { color: true }).split('\n');
    const plainLines = expected.split('\n');
    expect(colored).toHaveLength(plainLines.length);
    for (let i = 0; i < plainLines.length; i++) {
      expect(colored[i]).toBe(`\x1b[38;5;231;48;5;16m${plainLines[i]}\x1b[0m`);
    }
  });

  it('delegates SVG QR rendering to qr svg output with a white background', () => {
    const svg = qrSvg(uri);
    const expected = encodeQR(uri, 'raw', { ecc: 'low', border: 4 });
    expect(svg).toContain(`viewBox="0 0 ${expected.length} ${expected.length}"`);
    expect(svg).toContain('<rect width="100%" height="100%" fill="#fff"/>');
    expect(svg).toContain('<path d="');
  });
});

describe('runWalletLogin', () => {
  it('saves a verified session and wipes the private key buffer', async () => {
    const dir = makeTempDir();
    const { port, answer } = mockConnectWorld();
    let seenKey: Uint8Array | undefined;
    let granted: { ownerId: string; keyId: number; secretHex: string } | undefined;
    const owned: DomainRecord[] = [{ id: 'd1', ownerId: '', label: 'pa5ta', normalizedLabel: 'pa5ta', transferredAt: CHAIN_NOW }];

    const result = await runWalletLogin({
      config: CONFIG,
      port,
      connectionId: connectionId(dir, 'testnet'),
      now: () => CHAIN_NOW,
      pollOptions: { intervalMs: 1, settleMs: 0, now: () => CHAIN_NOW },
      onRequest: (pending) => {
        void answer(pending, { remaining: 19_000_000_000n }).then((a) => {
          granted = a;
          owned[0]!.ownerId = a.ownerId;
        });
      },
      listOwnedNames: async () => owned,
      verifyWriter: async (_id, key) => {
        seenKey = key;
      },
      save: (session) => saveSession(dir, session),
    });

    expect(result.identityId).toBe(granted!.ownerId);
    expect(result.keyId).toBe(granted!.keyId);
    expect(result.names).toEqual(['pa5ta.dash']);
    expect(result.remainingBudget).toBe(19_000_000_000n);
    expect(loadSession(dir, 'testnet')?.privateKey).toBe(granted!.secretHex);
    expect(seenKey?.every((b) => b === 0)).toBe(true);
  });

  it('refuses when the answering wallet does not match the pinned name owner', async () => {
    const dir = makeTempDir();
    const { port, answer } = mockConnectWorld();
    const expectedOwner = randomId();
    const save = vi.fn(() => sessionPath(dir, 'testnet'));

    await expect(
      runWalletLogin({
        config: CONFIG,
        port,
        connectionId: connectionId(dir, 'testnet'),
        expectedIdentityId: expectedOwner,
        expectedName: 'pa5ta',
        now: () => CHAIN_NOW,
        pollOptions: { intervalMs: 1, settleMs: 0, now: () => CHAIN_NOW },
        onRequest: (pending) => {
          void answer(pending);
        },
        listOwnedNames: async () => [],
        verifyWriter: async () => {},
        save,
      }),
    ).rejects.toThrow(/does not own pa5ta\.dash/);
    expect(save).not.toHaveBeenCalled();
  });

  it('does not save when the user declines confirmation', async () => {
    const dir = makeTempDir();
    const { port, answer } = mockConnectWorld();
    const save = vi.fn(() => sessionPath(dir, 'testnet'));

    await expect(
      runWalletLogin({
        config: CONFIG,
        port,
        connectionId: connectionId(dir, 'testnet'),
        now: () => CHAIN_NOW,
        pollOptions: { intervalMs: 1, settleMs: 0, now: () => CHAIN_NOW },
        onRequest: (pending) => {
          void answer(pending);
        },
        listOwnedNames: async () => [],
        confirm: async () => false,
        verifyWriter: async () => {},
        save,
      }),
    ).rejects.toThrow(/login cancelled/);
    expect(save).not.toHaveBeenCalled();
  });

  it('refuses when Platform protocol is below App Connect minimum', async () => {
    const dir = makeTempDir();
    const { port } = mockConnectWorld(13);

    await expect(
      runWalletLogin({
        config: CONFIG,
        port,
        connectionId: connectionId(dir, 'testnet'),
        onRequest: () => {},
        listOwnedNames: async () => [],
        verifyWriter: async () => {},
        save: () => sessionPath(dir, 'testnet'),
      }),
    ).rejects.toThrow(/protocol 14/);
  });

  it('refuses keys expiring within the hour or past the five-minute margin', async () => {
    const dir = makeTempDir();
    const { port, answer } = mockConnectWorld();
    const save = vi.fn(() => sessionPath(dir, 'testnet'));

    await expect(
      runWalletLogin({
        config: CONFIG,
        port,
        connectionId: connectionId(dir, 'testnet'),
        now: () => CHAIN_NOW,
        pollOptions: { intervalMs: 1, settleMs: 0, now: () => CHAIN_NOW },
        onRequest: (pending) => {
          void answer(pending, { expiresAt: CHAIN_NOW + 60_000 });
        },
        listOwnedNames: async () => [],
        verifyWriter: async () => {},
        save,
      }),
    ).rejects.toThrow(/expires within the hour/);

    let clock = CHAIN_NOW;
    const world2 = mockConnectWorld();
    await expect(
      runWalletLogin({
        config: CONFIG,
        port: world2.port,
        connectionId: connectionId(dir, 'testnet'),
        now: () => clock,
        pollOptions: { intervalMs: 1, settleMs: 0, now: () => clock },
        onRequest: (pending) => {
          void world2.answer(pending, { expiresAt: CHAIN_NOW + 2 * 3_600_000 });
        },
        listOwnedNames: async () => [],
        confirm: async () => {
          clock = CHAIN_NOW + 2 * 3_600_000 - 60_000;
          return true;
        },
        verifyWriter: async () => {},
        save,
      }),
    ).rejects.toThrow(/expires within 5 minutes/);
    expect(save).not.toHaveBeenCalled();
  });

  it('does not save and wipes the key if writer verification fails', async () => {
    const dir = makeTempDir();
    const { port, answer } = mockConnectWorld();
    const save = vi.fn(() => sessionPath(dir, 'testnet'));
    let seenKey: Uint8Array | undefined;

    await expect(
      runWalletLogin({
        config: CONFIG,
        port,
        connectionId: connectionId(dir, 'testnet'),
        now: () => CHAIN_NOW,
        pollOptions: { intervalMs: 1, settleMs: 0, now: () => CHAIN_NOW },
        onRequest: (pending) => {
          void answer(pending);
        },
        listOwnedNames: async () => [],
        verifyWriter: async (_id, key) => {
          seenKey = key;
          throw new Error('key was disabled');
        },
        save,
      }),
    ).rejects.toThrow(/key was disabled/);
    expect(save).not.toHaveBeenCalled();
    expect(seenKey?.every((b) => b === 0)).toBe(true);
  });
});
