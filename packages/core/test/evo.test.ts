import { ensureInitialized, PrivateKey, type Document } from '@dashevo/evo-sdk';
import { ripemd160 } from '@noble/hashes/legacy.js';
import { sha256 } from '@noble/hashes/sha2.js';
import * as secp from '@noble/secp256k1';
import { base58 } from '@scure/base';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { sha256Hex, toHex } from '../src/bytes.js';
import { DPNS_CONTRACT_ID, networkConfig, readerConfig } from '../src/config.js';
import { EvoReader, EvoWriter, KeyRefused, withReadDeadline } from '../src/evo.js';
import { PRELOAD_CHUNKS } from '../src/limits.js';

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

describe('reading a name', () => {
  const SITE_ID = base58.encode(new Uint8Array(32).fill(6));
  const DOMAIN_ID = base58.encode(new Uint8Array(32).fill(4));
  const meta = { height: 9, timeMs: 6, coreChainLockedHeight: 1, protocolVersion: 14 };
  const metadata = { toJSON: () => meta };
  const name = [['normalizedParentDomainName', '==', 'dash'], ['normalizedLabel', '==', 'a11ce']];
  const domain = {
    id: { toBase58: () => DOMAIN_ID },
    ownerId: { toBase58: () => IDENTITY },
    createdAt: 2n,
    transferredAt: 3n,
    toObject: () => ({ label: 'Alice', normalizedLabel: 'a11ce' }),
  };
  const record = {
    id: { toBase58: () => SITE_ID },
    ownerId: { toBase58: () => IDENTITY },
    revision: 2n,
    updatedAt: 5n,
    toObject: () => ({ normalizedLabel: 'a11ce', content: 'ipfs://x' }),
  };
  const read = {
    domain: { id: DOMAIN_ID, ownerId: IDENTITY, label: 'Alice', normalizedLabel: 'a11ce', transferredAt: 3 },
    site: { id: SITE_ID, ownerId: IDENTITY, normalizedLabel: 'a11ce', content: 'ipfs://x', revision: 2, updatedAt: 5 },
  };
  const bytes = [new Uint8Array([1]), new Uint8Array([2]), new Uint8Array([3])];
  const hashes = bytes.map(sha256Hex);
  const chunk = (index: number) => ({ toObject: () => ({ hash: Uint8Array.from(Buffer.from(hashes[index] as string, 'hex')), d0: bytes[index] }) });
  const documents = (...found: unknown[]) => ({ kind: 'documents', documents: found });

  function reader(composite: (query: unknown) => Promise<unknown>, metas: Record<string, typeof meta> = {}) {
    const queries: Array<{ dataContractId: string; documentTypeName: string; where: unknown[][] }> = [];
    const asked: unknown[] = [];
    const sdk = {
      documents: {
        compositeWithProof: (query: unknown) => (asked.push(query), composite(query)),
        queryWithProof: async (query: (typeof queries)[number]) => {
          queries.push(query);
          const data = { domain: new Map([[DOMAIN_ID, domain]]), site: new Map([[SITE_ID, record]]) }[query.documentTypeName] ?? new Map([['c', chunk(2)]]);
          return { data, metadata: { toJSON: () => metas[query.documentTypeName] ?? meta } };
        },
      },
    };
    return { reader: new EvoReader(sdk as never, CONFIG), queries, asked };
  }
  const answer = (page: unknown[], ...subResults: unknown[]) => async () => ({ data: { pageDocuments: page, subResults }, metadata });
  const withChunks = answer([domain], documents(record), documents(chunk(0), chunk(1)));

  it('gets the domain, its owner\'s record and the chunks in one query, and asks only for chunks it was not sent', async () => {
    const { reader: platform, queries, asked } = reader(withChunks);
    expect(await platform.getName('a11ce', true)).toEqual({ value: read, meta });
    expect(asked).toEqual([
      {
        dataContractId: DPNS_CONTRACT_ID,
        documentType: 'domain',
        where: name,
        limit: 1,
        subQueries: [
          { dataContractId: CONFIG.contractId, documentType: 'site', where: name, bind: { sourceProperty: '$ownerId', field: '$ownerId' } },
          { dataContractId: CONFIG.contractId, documentType: 'chunk', bind: { source: 0, sourceProperty: '$id', field: 'site' }, limit: PRELOAD_CHUNKS },
        ],
      },
    ]);
    expect(await platform.getChunks(SITE_ID, [hashes[0] as string, hashes[1] as string])).toEqual(new Map([[hashes[0], bytes[0]], [hashes[1], bytes[1]]]));
    expect(queries).toEqual([]);

    const mixed = await platform.getChunks(SITE_ID, [hashes[0] as string, hashes[2] as string]);
    expect([...mixed.keys()].sort()).toEqual([hashes[0], hashes[2]].sort());
    expect(queries).toHaveLength(1);
    expect(queries[0]?.where).toEqual([['site', '==', SITE_ID], ['hash', 'in', [base58.encode(Buffer.from(hashes[2] as string, 'hex'))]]]);
  });

  it('asks for the record alone when no chunks are wanted', async () => {
    const { reader: platform, queries, asked } = reader(answer([domain], documents(record)));
    expect(await platform.getName('a11ce')).toEqual({ value: read, meta });
    expect((asked[0] as { subQueries: unknown[] }).subQueries).toHaveLength(1);
    expect(queries).toEqual([]);
  });

  it('tells a free name from a registered one without a site', async () => {
    expect((await reader(answer([], documents())).reader.getName('a11ce')).value).toBeUndefined();
    expect((await reader(answer([domain], documents())).reader.getName('a11ce')).value).toEqual({ domain: read.domain });
  });

  it('asks DPNS alone on a network without a dash-sites contract', async () => {
    const queries: string[] = [];
    const sdk = { documents: { queryWithProof: async (query: { documentTypeName: string }) => (queries.push(query.documentTypeName), { data: new Map([[DOMAIN_ID, domain]]), metadata }) } };
    const platform = new EvoReader(sdk as never, readerConfig('mainnet'));
    expect(platform.noSiteContract).toBe(true);
    expect((await platform.getName('a11ce', true)).value).toEqual({ domain: read.domain });
    expect(queries).toEqual(['domain']);
  });

  it('does not hand out chunks sent for another record', async () => {
    const { reader: platform, queries } = reader(withChunks);
    await platform.getName('a11ce', true);
    await platform.getChunks(base58.encode(new Uint8Array(32).fill(1)), [hashes[0] as string]);
    expect(queries).toHaveLength(1);
  });

  it('asks for the domain, then for its owner\'s record, when the combined query fails', async () => {
    const { reader: platform, queries } = reader(() => Promise.reject(new Error('unsupported')));
    expect(await platform.getName('a11ce', true)).toEqual({ value: read, meta });
    expect(queries).toEqual([
      { dataContractId: DPNS_CONTRACT_ID, documentTypeName: 'domain', where: name, limit: 1 },
      { dataContractId: CONFIG.contractId, documentTypeName: 'site', where: [...name, ['$ownerId', '==', IDENTITY]], limit: 1 },
    ]);
  });
  it('takes no record written after the block that proved the owner when it reads in two steps', async () => {
    const failing = () => Promise.reject(new Error('unsupported'));
    const before = { ...meta, height: 7, timeMs: 4 };
    const sold = reader(failing, { domain: before });
    expect(await sold.reader.getName('a11ce')).toEqual({ value: { domain: read.domain }, meta: before });

    const behind = { ...meta, height: 8 };
    expect(await reader(failing, { site: behind }).reader.getName('a11ce')).toEqual({ value: read, meta: behind });
  });

  it('refuses a name document without a time', async () => {
    const undated = { ...domain, createdAt: undefined, transferredAt: undefined };
    await expect(reader(async () => ({ data: { pageDocuments: [undated], subResults: [documents()] }, metadata })).reader.getName('a11ce')).rejects.toThrow(/no time/);
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
    const domain = { id: 'domain', ownerId: IDENTITY, label: 'Alice', normalizedLabel: 'a11ce', transferredAt: 0 };
    expect(await writer.putSite(domain)).toMatchObject({ revision: 1, normalizedLabel: 'a11ce' });

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

    stale = 2;
    const listed = writer.listSites();
    await vi.runAllTimersAsync();
    expect(await listed).toMatchObject([{ revision: 3 }]);
  });

  it('takes the record another tab created first as its own, and reports any other refusal', async () => {
    vi.useFakeTimers();
    const metadata = { toJSON: () => ({}) };
    let stored: Document | undefined;
    let visible = false;
    let refusal = 'Document has duplicate unique properties ["normalizedParentDomainName", "normalizedLabel", "$ownerId"] with other documents';
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
    const domain = { id: 'domain', ownerId: IDENTITY, label: 'Alice', normalizedLabel: 'a11ce', transferredAt: 0 };
    const ensured = writer.ensureSite(domain);
    await vi.advanceTimersByTimeAsync(2000);
    visible = true;
    await vi.runAllTimersAsync();
    expect(await ensured).toMatchObject({ revision: 1, normalizedLabel: 'a11ce' });

    visible = false;
    refusal = 'Insufficient identity balance';
    await expect(writer.ensureSite(domain)).rejects.toThrow(/Insufficient/);
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
