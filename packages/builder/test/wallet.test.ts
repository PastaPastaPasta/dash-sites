import encodeQR from 'qr';
import { describe, expect, it } from 'vitest';
import { allowanceText, clearSession, connectionId, countdown, loadSession, qrShape, saveSession, type KeyValue } from '../src/wallet.js';

function memory(): KeyValue & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return { values, getItem: (key) => values.get(key) ?? null, setItem: (key, value) => void values.set(key, value), removeItem: (key) => void values.delete(key) };
}

const broken: KeyValue = {
  getItem() {
    throw new Error('blocked');
  },
  setItem() {
    throw new Error('blocked');
  },
  removeItem() {
    throw new Error('blocked');
  },
};

describe('connection id', () => {
  it('is kept per network, so a wallet can replace the key it gave this browser before', () => {
    const store = memory();
    const first = connectionId(store, 'testnet');
    expect(first).toHaveLength(16);
    expect(connectionId(store, 'testnet')).toEqual(first);
    expect(connectionId(store, 'mainnet')).not.toEqual(first);
  });

  it('still works without storage', () => {
    expect(connectionId(undefined, 'testnet')).toHaveLength(16);
    expect(connectionId(broken, 'testnet')).toHaveLength(16);
  });
});

describe('wallet session', () => {
  const session = { identityId: 'AkhihKhRLGjKB1WTdUG7BWrGnTaTTHcMzdSBsKSJ5GNm', privateKey: new Uint8Array(32).fill(9) };

  it('survives a reload and ends on sign-out', () => {
    const store = memory();
    saveSession(store, 'testnet', session);
    expect(loadSession(store, 'testnet')).toEqual(session);
    expect(loadSession(store, 'mainnet')).toBeUndefined();
    clearSession(store, 'testnet');
    expect(loadSession(store, 'testnet')).toBeUndefined();
  });

  it('drops what it cannot read', () => {
    const store = memory();
    store.values.set('dash-sites.wallet.testnet', '{"identityId":"x","key":"zz"}');
    expect(loadSession(store, 'testnet')).toBeUndefined();
    store.values.set('dash-sites.wallet.testnet', 'not json');
    expect(loadSession(store, 'testnet')).toBeUndefined();
    expect(loadSession(broken, 'testnet')).toBeUndefined();
    expect(() => saveSession(broken, 'testnet', session)).not.toThrow();
    expect(() => clearSession(broken, 'testnet')).not.toThrow();
  });
});

describe('sign-in code', () => {
  it('draws exactly the modules of the QR code', () => {
    const uri = 'dashpay://connect?v=2&n=t&r=AgISFYXyWOlkb3iXHasW-mHC89Hg7u5cQ2h1bmtzIG9mIGEgcmVxdWVzdCBib2R5';
    const expected = encodeQR(uri, 'raw', { ecc: 'low', border: 4 });
    const shape = qrShape(uri);
    expect(shape.size).toBe(expected.length);
    const drawn = expected.map((row) => row.map(() => false));
    for (const [, x, y, width] of shape.path.matchAll(/M(\d+) (\d+)h(\d+)v1h-\d+z/g)) {
      for (let i = 0; i < Number(width); i++) (drawn[Number(y)] as boolean[])[Number(x) + i] = true;
    }
    expect(drawn).toEqual(expected);
  });
});

describe('wording', () => {
  it('counts down in minutes and seconds', () => {
    expect(countdown(600_000)).toBe('10:00');
    expect(countdown(61_500)).toBe('1:02');
    expect(countdown(-5)).toBe('0:00');
  });

  it('says what the wallet allows', () => {
    expect(allowanceText(19_876_000_000n, Date.UTC(2027, 1, 22, 12))).toMatch(/^0\.19876 DASH until .*2027/);
  });
});
