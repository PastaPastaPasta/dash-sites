import { ensureInitialized, PrivateKey, type Document } from '@dashevo/evo-sdk';
import { ripemd160 } from '@noble/hashes/legacy.js';
import { sha256 } from '@noble/hashes/sha2.js';
import * as secp from '@noble/secp256k1';
import { base58 } from '@scure/base';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { sha256Hex, toHex } from '../src/bytes.js';
import { networkConfig } from '../src/config.js';
import { EvoReader, EvoWriter, KeyRefused, withReadDeadline } from '../src/evo.js';

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

describe('reading a site', () => {
  const SITE_ID = base58.encode(new Uint8Array(32).fill(6));
  const metadata = { toJSON: () => ({ height: 9, timeMs: 1, coreChainLockedHeight: 1, protocolVersion: 14 }) };
  const record = {
    id: { toBase58: () => SITE_ID },
    ownerId: { toBase58: () => IDENTITY },
    revision: 2n,
    updatedAt: 5n,
    toObject: () => ({ label: 'Alice', normalizedLabel: 'a11ce', content: 'ipfs://x' }),
  };
  const bytes = [new Uint8Array([1]), new Uint8Array([2]), new Uint8Array([3])];
  const hashes = bytes.map(sha256Hex);
  const chunk = (index: number) => ({ toObject: () => ({ hash: Uint8Array.from(Buffer.from(hashes[index] as string, 'hex')), d0: bytes[index] }) });

  function reader(composite: () => Promise<unknown>) {
    const queries: Array<{ documentTypeName: string; where: unknown[][] }> = [];
    const documents = {
      compositeWithProof: composite,
      queryWithProof: async (query: { documentTypeName: string; where: unknown[][] }) => {
        queries.push(query);
        const data = query.documentTypeName === 'site' ? new Map([[SITE_ID, record]]) : new Map([['c', chunk(2)]]);
        return { data, metadata };
      },
    };
    return { reader: new EvoReader({ documents } as never, CONFIG), queries };
  }
  const withChunks = async () => ({ data: { pageDocuments: [record], subResults: [{ kind: 'documents', documents: [chunk(0), chunk(1)] }] }, metadata });

  it('gets the record and its chunks in one query, and asks only for chunks it was not sent', async () => {
    const { reader: platform, queries } = reader(withChunks);
    const site = await platform.getSite('a11ce', true);
    expect(site).toEqual({ value: { id: SITE_ID, ownerId: IDENTITY, label: 'Alice', normalizedLabel: 'a11ce', content: 'ipfs://x', revision: 2, updatedAt: 5 }, meta: { height: 9, timeMs: 1, coreChainLockedHeight: 1, protocolVersion: 14 } });
    expect(await platform.getChunks(SITE_ID, [hashes[0] as string, hashes[1] as string])).toEqual(new Map([[hashes[0], bytes[0]], [hashes[1], bytes[1]]]));
    expect(queries).toEqual([]);

    const mixed = await platform.getChunks(SITE_ID, [hashes[0] as string, hashes[2] as string]);
    expect([...mixed.keys()].sort()).toEqual([hashes[0], hashes[2]].sort());
    expect(queries).toHaveLength(1);
    expect(queries[0]?.where).toEqual([['site', '==', SITE_ID], ['hash', 'in', [base58.encode(Buffer.from(hashes[2] as string, 'hex'))]]]);
  });

  it('does not hand out chunks sent for another record', async () => {
    const { reader: platform, queries } = reader(withChunks);
    await platform.getSite('a11ce', true);
    await platform.getChunks(base58.encode(new Uint8Array(32).fill(1)), [hashes[0] as string]);
    expect(queries).toHaveLength(1);
  });

  it('reads the record alone when the combined query fails, and when no chunks are wanted', async () => {
    const failing = reader(() => Promise.reject(new Error('unsupported')));
    expect((await failing.reader.getSite('a11ce', true)).value?.id).toBe(SITE_ID);
    expect(failing.queries.map((query) => query.documentTypeName)).toEqual(['site']);

    let composites = 0;
    const plain = reader(async () => {
      composites += 1;
      return withChunks();
    });
    await plain.reader.getSite('a11ce');
    expect(composites).toBe(0);
    expect(plain.queries.map((query) => query.documentTypeName)).toEqual(['site']);
  });
});

describe('writing a site record', () => {
  afterEach(() => vi.useRealTimers());

  it('replaces the record it wrote even when a node still answers from before the write', async () => {
    vi.useFakeTimers();
    const metadata = { toJSON: () => ({}) };
    const writes: string[] = [];
    let stored: Document | undefined;
    let stale = 0;
    const sdk = {
      ...(sdkWith([key()]) as object),
      wasm: { version: () => 14 },
      documents: {
        queryWithProof: async () => ({ data: new Map(stored && stale-- <= 0 ? [['id', stored]] : []), metadata }),
        create: async ({ document }: { document: Document }) => {
          writes.push('create');
          stored = document;
        },
        replace: async ({ document }: { document: Document }) => {
          writes.push('replace');
          stored = document;
        },
      },
    };
    const writer = await EvoWriter.on(sdk as never, CONFIG, { identityId: IDENTITY, privateKey: SECRET });
    const domain = { id: 'domain', ownerId: IDENTITY, label: 'Alice', normalizedLabel: 'a11ce' };
    expect(await writer.putSite(domain)).toMatchObject({ revision: 1, label: 'Alice' });

    stale = 2;
    const second = writer.putSite(domain, 'ipfs://x');
    await vi.runAllTimersAsync();
    expect(await second).toMatchObject({ revision: 2, content: 'ipfs://x' });

    const third = writer.putSite(domain);
    await vi.runAllTimersAsync();
    const down = await third;
    expect(down.revision).toBe(3);
    expect(down.content).toBeUndefined();
    expect(writes).toEqual(['create', 'replace', 'replace']);
    expect(await writer.ensureSite(domain)).toMatchObject({ revision: 3 });
    expect(writes).toHaveLength(3);
  });

  it('takes the record another tab created first as its own, and reports any other refusal', async () => {
    vi.useFakeTimers();
    const metadata = { toJSON: () => ({}) };
    let stored: Document | undefined;
    let visible = false;
    let refusal = 'Document has duplicate unique properties ["$ownerId"] with other documents';
    const sdk = {
      ...(sdkWith([key()]) as object),
      wasm: { version: () => 14 },
      documents: {
        queryWithProof: async () => ({ data: new Map(stored && visible ? [['id', stored]] : []), metadata }),
        create: async ({ document }: { document: Document }) => {
          stored = document;
          throw new Error(refusal);
        },
      },
    };
    const writer = await EvoWriter.on(sdk as never, CONFIG, { identityId: IDENTITY, privateKey: SECRET });
    const domain = { id: 'domain', ownerId: IDENTITY, label: 'Alice', normalizedLabel: 'a11ce' };
    const ensured = writer.ensureSite(domain);
    await vi.advanceTimersByTimeAsync(2000);
    visible = true;
    await vi.runAllTimersAsync();
    expect(await ensured).toMatchObject({ revision: 1, label: 'Alice' });

    visible = false;
    refusal = "the document's $ownerId does not agree with the referenced document's $ownerId";
    await expect(writer.ensureSite(domain)).rejects.toThrow(/does not agree/);
  });
});

describe('Platform read deadline', () => {
  const silent: typeof fetch = (_input, init) =>
    new Promise((_resolve, reject) => {
      if (init?.signal?.aborted) reject(init.signal.reason);
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
    });
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

  it('handles the Request the SDK sends, with its own signal and body', async () => {
    let body = '';
    const seen: typeof fetch = async (input, init) => {
      body = await (input as Request).clone().text();
      return silent(input, init);
    };
    const own = new AbortController();
    const request = () => new Request(`${node}/getDocuments`, { method: 'POST', body: 'query', signal: own.signal });
    await expect(withReadDeadline(seen, 20)(request())).rejects.toThrow('within 20 ms');
    expect(body).toBe('query');
    const pending = withReadDeadline(seen, 10_000)(request());
    own.abort(new Error('sdk cancelled'));
    await expect(pending).rejects.toThrow('sdk cancelled');
  });
});
