import { ensureInitialized, PrivateKey } from '@dashevo/evo-sdk';
import { ripemd160 } from '@noble/hashes/legacy.js';
import { sha256 } from '@noble/hashes/sha2.js';
import * as secp from '@noble/secp256k1';
import { base58 } from '@scure/base';
import { beforeAll, describe, expect, it } from 'vitest';
import { toHex } from '../src/bytes.js';
import { networkConfig } from '../src/config.js';
import { EvoWriter, KeyRefused, withReadDeadline } from '../src/evo.js';

const CONFIG = networkConfig('testnet');
const IDENTITY = base58.encode(new Uint8Array(32).fill(4));
const OTHER_CONTRACT = base58.encode(new Uint8Array(32).fill(5));
const SECRET = new Uint8Array(32).fill(3);
const PUBLIC = secp.getPublicKey(SECRET, true);
const bounds = (json: unknown) => ({ toJSON: () => json });
const DASH_SITES = bounds({ $type: 'singleContract', id: CONFIG.contractId });

function key(over: Record<string, unknown> = {}) {
  return { keyId: 7, data: toHex(ripemd160(sha256(PUBLIC))), purpose: 'AUTHENTICATION', securityLevel: 'HIGH', disabledAt: undefined, contractBounds: DASH_SITES, totalBudget: 20_000_000_000n, expiresAt: 1_800_000_000_000n, ...over };
}

function sdkWith(keys: unknown[] | null, budgets = new Map<number, bigint>([[7, 19_000_000_000n]])) {
  return {
    identities: {
      fetch: async () => (keys ? { publicKeys: keys } : undefined),
      keysRemainingBudgets: async () => budgets,
    },
  } as never;
}

const signIn = (keys: unknown[] | null, credentials: object = { privateKey: SECRET }) => EvoWriter.on(sdkWith(keys), CONFIG, { identityId: IDENTITY, ...credentials });

beforeAll(() => ensureInitialized());

describe('signing key', () => {
  it('takes a wallet key bound to the dash-sites contract, as bytes or as WIF', async () => {
    const writer = await signIn([key()]);
    expect(writer.keyLimits).toEqual({ keyId: 7, bound: true, totalBudget: 20_000_000_000n, expiresAt: 1_800_000_000_000 });
    expect(await writer.remainingBudget()).toBe(19_000_000_000n);
    const wif = PrivateKey.fromBytes(SECRET, 'testnet').toWIF();
    expect((await signIn([key()], { privateKeyWif: wif })).keyLimits.keyId).toBe(7);
  });

  it('takes an ordinary key, which has no limits', async () => {
    const writer = await signIn([key({ data: toHex(PUBLIC), contractBounds: undefined, totalBudget: undefined, expiresAt: undefined })]);
    expect(writer.keyLimits).toEqual({ keyId: 7, bound: false });
    expect(await writer.remainingBudget()).toBeUndefined();
  });

  it.each([
    ['bound to another contract', key({ contractBounds: bounds({ $type: 'singleContract', id: OTHER_CONTRACT }) })],
    ['bound to one document type', key({ contractBounds: bounds({ $type: 'documentType', id: CONFIG.contractId, documentTypeName: 'site' }) })],
    ['whose bounds cannot be read', key({ contractBounds: { toJSON: () => { throw new Error('unreadable'); } } })],
    ['that was disabled', key({ disabledAt: 5n })],
    ['of too low a level', key({ securityLevel: 'MEDIUM' })],
    ['of another identity', key({ data: 'ab'.repeat(20) })],
  ])('refuses a key %s', async (_name, onChain) => {
    await expect(signIn([onChain])).rejects.toBeInstanceOf(KeyRefused);
  });

  it('refuses an identity that does not exist, and tells that apart from a failed read', async () => {
    await expect(signIn(null)).rejects.toBeInstanceOf(KeyRefused);
    const failing = { identities: { fetch: async () => Promise.reject(new Error('the node did not answer')) } } as never;
    const failed = await EvoWriter.on(failing, CONFIG, { identityId: IDENTITY, privateKey: SECRET }).catch((error: unknown) => error);
    expect(failed).toBeInstanceOf(Error);
    expect(failed).not.toBeInstanceOf(KeyRefused);
  });

  it('will not register a name with a wallet key', async () => {
    await expect((await signIn([key()])).registerName('alice2')).rejects.toThrow(/cannot register names/);
  });

  it('notices that its key was disabled', async () => {
    const keys = [key()];
    const writer = await signIn(keys);
    expect(await writer.keyLive()).toBe(true);
    keys[0] = key({ disabledAt: 9n });
    expect(await writer.keyLive()).toBe(false);
  });
});

describe('Platform read deadline', () => {
  const silent: typeof fetch = (_input, init) =>
    new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal?.reason)));
  const node = 'https://203.0.113.9:443/org.dash.platform.dapi.v0.Platform';

  it('fails a read that gets no answer in time, naming the node', async () => {
    await expect(withReadDeadline(silent, 20)(`${node}/getDocuments`, { method: 'POST' })).rejects.toThrow('no answer from 203.0.113.9 within 20 ms');
  });

  it('leaves writes and other requests alone', async () => {
    let calls = 0;
    const answered: typeof fetch = async (_input, init) => {
      calls += 1;
      expect(init?.signal).toBeUndefined();
      return new Response('ok');
    };
    const guarded = withReadDeadline(answered, 20);
    await guarded(`${node}/waitForStateTransitionResult`, { method: 'POST' });
    await guarded(`${node}/broadcastStateTransition`, { method: 'POST' });
    await guarded('https://quorums.mainnet.networks.dash.org/quorums');
    expect(calls).toBe(3);
  });

  it('keeps the caller able to cancel, and does not cut off an answer that came in time', async () => {
    const caller = new AbortController();
    const pending = withReadDeadline(silent, 10_000)(`${node}/getDataContract`, { signal: caller.signal });
    caller.abort(new Error('cancelled'));
    await expect(pending).rejects.toThrow('cancelled');
    const answered = await withReadDeadline(async () => new Response('proof'), 20)(`${node}/getDocuments`);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(await answered.text()).toBe('proof');
  });
});
