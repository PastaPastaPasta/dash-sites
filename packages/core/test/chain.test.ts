import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { fromHex } from '../src/bytes.js';
import { decodeCbor } from '../src/chain/cbor.js';
import { fields } from '../src/chain/dapi.js';
import { bitsFromTarget, extend, parseHeader, stateFromHeaders, targetFromBits, type ChainNetwork } from '../src/chain/header.js';
import { asDiff, ipv6, PLATFORM_LLMQ, verifyDiff, type MnListDiff } from '../src/chain/mnlist.js';
import { answerQuorumRequest, LOCAL_QUORUM_URL, withLocalQuorums } from '../src/chain/quorums.js';
import { STORED_DEPTH, syncChain, type ChainSnapshot, type Checkpoint, type Dapi } from '../src/chain/sync.js';
import { toDisplay } from '../src/chain/wire.js';

const fixture = (name: string): Buffer => readFileSync(new URL(`./fixtures/chain/${name}`, import.meta.url));
const headers = (network: ChainNetwork): { height: number; raws: Uint8Array[] } => {
  const json = JSON.parse(fixture(`${network}-headers.json`).toString()) as { height: number; headers: string[] };
  return { height: json.height, raws: json.headers.map(fromHex) };
};
const diff = (): MnListDiff => asDiff(JSON.parse(gunzipSync(fixture('testnet-diff.json.gz')).toString()));
// Header times are checked against the clock; the fixtures are from November 2026.
const NOW = 1_800_000_000;

describe('block headers', () => {
  for (const network of ['mainnet', 'testnet'] as const) {
    it(`verifies 200 ${network} headers from a 24-header checkpoint`, () => {
      const { height, raws } = headers(network);
      const start = stateFromHeaders(network, height - 200, raws.slice(0, 24));
      const { state, headers: accepted } = extend(start, raws.slice(24), NOW);
      expect(state.height).toBe(height);
      expect(accepted).toHaveLength(200);
    });
  }

  it('refuses a header with a changed nonce, difficulty or link', () => {
    const { height, raws } = headers('mainnet');
    const start = stateFromHeaders('mainnet', height - 200, raws.slice(0, 24));
    const next = Uint8Array.from(raws[24] as Uint8Array);
    next[79] ^= 1;
    expect(() => extend(start, [next], NOW)).toThrow(/proof of work/);
    const easier = Uint8Array.from(raws[24] as Uint8Array);
    new DataView(easier.buffer).setUint32(72, 0x1e0fffff, true);
    expect(() => extend(start, [easier], NOW)).toThrow(/DGW requires/);
    expect(() => extend(start, [raws[25] as Uint8Array], NOW)).toThrow(/does not follow/);
  });

  it('refuses headers from the future', () => {
    const { height, raws } = headers('mainnet');
    const start = stateFromHeaders('mainnet', height - 200, raws.slice(0, 24));
    expect(() => extend(start, raws.slice(24, 30), parseHeader(raws[24] as Uint8Array).time - 3 * 3600)).toThrow(/future/);
  });

  it('round-trips compact difficulty', () => {
    for (const bits of [0x1e0fffff, 0x1a0b4f2c, 0x1b0404cb]) expect(bitsFromTarget(targetFromBits(bits))).toBe(bits);
    expect(() => targetFromBits(0x04923456)).toThrow(/negative/);
  });
});

describe('masternode list', () => {
  const { raws } = headers('testnet');
  const block = parseHeader(raws[raws.length - 1] as Uint8Array);

  it('proves the quorum list and the masternode list against the block', () => {
    const list = verifyDiff(diff(), block.merkleRoot);
    expect(list.blockHash).toBe(toDisplay(block.hash));
    const platform = list.quorums.filter((q) => q.llmqType === PLATFORM_LLMQ.testnet);
    expect(platform.length).toBeGreaterThanOrEqual(20);
    expect(platform[0]?.publicKey).toMatch(/^[0-9a-f]{96}$/);
    expect(list.nodes?.length).toBeGreaterThan(10);
    expect(list.nodes?.every((node) => /^https:\/\/(\d+\.\d+\.\d+\.\d+|\[[0-9a-f:]+\]):\d+$/.test(node))).toBe(true);
  });

  it('refuses a changed quorum key', () => {
    const changed = diff();
    const quorum = changed.newQuorums.find((q) => q.llmqType === PLATFORM_LLMQ.testnet);
    if (!quorum) throw new Error('no quorum');
    quorum.quorumPublicKey = `${quorum.quorumPublicKey.slice(0, -2)}00`;
    expect(() => verifyDiff(changed, block.merkleRoot)).toThrow(/quorum list does not match/);
  });

  it('refuses a dropped quorum and a list for another block', () => {
    const dropped = diff();
    dropped.newQuorums.pop();
    expect(() => verifyDiff(dropped, block.merkleRoot)).toThrow(/quorum list does not match/);
    expect(() => verifyDiff(diff(), parseHeader(raws[raws.length - 2] as Uint8Array).merkleRoot)).toThrow(/not in the block/);
  });

  it('drops the nodes of a list with a changed masternode address', () => {
    const changed = diff();
    const extended = changed.mnList.find((m) => m.nType === 1 && m.nVersion >= 3 && m.addresses?.platform_https?.length);
    if (!extended?.addresses?.platform_https) throw new Error('no version 3 evonode');
    extended.addresses.platform_https[0] = '1.2.3.4:443';
    const forged = verifyDiff(changed, block.merkleRoot);
    expect(forged.nodes).toBeUndefined();
    expect(forged.quorums.length).toBeGreaterThan(0);
    const legacy = diff();
    const old = legacy.mnList.find((m) => m.nType === 1 && m.nVersion === 2);
    if (!old) throw new Error('no version 2 evonode');
    old.platformHTTPPort = 8443;
    expect(verifyDiff(legacy, block.merkleRoot).nodes).toBeUndefined();
  });

  it('parses IPv6 addresses', () => {
    expect(Array.from(ipv6('2001:db8::1') ?? [])).toEqual([0x20, 0x01, 0x0d, 0xb8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
    expect(ipv6('::')).toEqual(new Uint8Array(16));
    expect(ipv6('1:2:3')).toBeUndefined();
    expect(ipv6('1::2::3')).toBeUndefined();
  });
});

describe('wire formats', () => {
  it('decodes CBOR maps, arrays and scalars', () => {
    const bytes = Uint8Array.from([0xa3, 0x61, 0x61, 0x01, 0x61, 0x62, 0x82, 0xf5, 0xf6, 0x61, 0x63, 0x39, 0x01, 0x00]);
    expect(decodeCbor(bytes)).toEqual({ a: 1, b: [true, null], c: -257 });
    expect(() => decodeCbor(Uint8Array.from([0x82, 0x01]))).toThrow(/longer than its input|truncated/);
    expect(() => decodeCbor(Uint8Array.from([0x63, 0x61]))).toThrow(/truncated/);
    expect(() => decodeCbor(Uint8Array.from([0x01, 0x02]))).toThrow(/trailing/);
  });

  it('reads protobuf fields', () => {
    expect(fields(Uint8Array.from([0x08, 0x96, 0x01, 0x12, 0x02, 0xaa, 0xbb]))).toEqual([
      { number: 1, value: 150 },
      { number: 2, value: Uint8Array.from([0xaa, 0xbb]) },
    ]);
  });
});

describe('local quorum service', () => {
  const quorum = (hash: string, provenAt: number) => ({ llmqType: 6, quorumHash: hash, publicKey: 'ab'.repeat(48), validMembers: 25, provenAt });
  const snapshot = { listHeight: 100, quorums: [quorum('11'.repeat(32), 100), quorum('22'.repeat(32), 90)] } as unknown as ChainSnapshot;

  it('answers the SDK in the quorum service format', async () => {
    const current = await (await answerQuorumRequest(new URL(`${LOCAL_QUORUM_URL}/quorums`), async () => snapshot)).json();
    expect(current).toEqual({ success: true, data: [{ quorum_hash: '11'.repeat(32), key: 'ab'.repeat(48), height: 100, valid_members_count: 25 }] });
    const previous = await (await answerQuorumRequest(new URL(`${LOCAL_QUORUM_URL}/previous`), async () => snapshot)).json();
    expect(previous.data.quorums.map((q: { quorum_hash: string }) => q.quorum_hash)).toEqual(['22'.repeat(32)]);
  });

  it('never sends a quorum request to the network', async () => {
    const sent: string[] = [];
    const hooked = withLocalQuorums(async (input) => {
      sent.push(String(input));
      return new Response('');
    }, async () => snapshot);
    await hooked(`${LOCAL_QUORUM_URL}/quorums`);
    await hooked('https://1.2.3.4:443/x');
    expect(sent).toEqual(['https://1.2.3.4:443/x']);
  });
});

describe('syncing from several nodes', () => {
  const { height: tip, raws } = headers('testnet');
  const first = tip - raws.length + 1;
  const toHex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');
  const checkpoint: Checkpoint = { network: 'testnet', height: first + 23, headers: raws.slice(0, 24).map(toHex) };

  interface FakeNode {
    tip?: number;
    headers?: (from: number, count: number) => Uint8Array[];
    diff?: () => MnListDiff;
  }
  function dapi(nodes: Record<string, FakeNode>): Dapi {
    const node = (address: string): FakeNode => nodes[address] ?? {};
    return {
      bestBlockHeight: async (address) => node(address).tip ?? tip,
      blockHeaders: async (address, from, count) => {
        const custom = node(address).headers;
        if (custom) return custom(from, count);
        if (from + count - 1 > (node(address).tip ?? tip)) throw new Error('count exceeds chain tip');
        return raws.slice(from - first, from - first + count);
      },
      masternodeListDiff: async (address) => (node(address).diff ?? diff)(),
    };
  }
  const sync = (nodes: Record<string, FakeNode>, previous?: ChainSnapshot) =>
    syncChain({ network: 'testnet', checkpoint, seeds: Object.keys(nodes), dapi: dapi(nodes), ...(previous ? { previous } : {}), random: () => 0.5 });

  it('proves the quorum keys with two honest nodes and stores the chain below the tip', async () => {
    const snapshot = await sync({ a: {}, b: {} });
    expect(snapshot.listHeight).toBe(tip);
    expect(snapshot.chain.height).toBe(tip - STORED_DEPTH);
    expect(snapshot.quorums.length).toBeGreaterThanOrEqual(20);
    expect(snapshot.nodes.length).toBeGreaterThan(10);
  });

  it('needs a second node whose list checks out', async () => {
    await expect(sync({ a: {} })).rejects.toThrow(/not enough nodes/);
    const tampered = (): MnListDiff => {
      const changed = diff();
      changed.newQuorums.pop();
      return changed;
    };
    await expect(sync({ a: {}, b: { diff: tampered } })).rejects.toThrow(/1 of the 2 masternode lists/);
  });

  it('does not let a node with an inflated tip get honest nodes dropped', async () => {
    const snapshot = await sync({ liar: { tip: tip + 1_000_000, headers: () => [] }, a: {}, b: {} });
    expect(snapshot.listHeight).toBe(tip);
  });

  it('drops a node that sends invalid headers and uses the others', async () => {
    const bad = (from: number, count: number): Uint8Array[] =>
      raws.slice(from - first, from - first + count).map((raw, i) => {
        const copy = Uint8Array.from(raw);
        if (i === count - 1) copy[79] ^= 1;
        return copy;
      });
    const snapshot = await sync({ bad: { headers: bad }, a: {}, b: {} });
    expect(snapshot.listHeight).toBe(tip);
  });

  it('starts again from the checkpoint when the stored chain is on a branch the nodes left', async () => {
    const good = await sync({ a: {}, b: {} });
    // A stored chain whose headers are real but labelled 30 blocks higher: nothing the nodes send follows it.
    const stranded: ChainSnapshot = { ...good, chain: { network: 'testnet', height: tip - 70, headers: raws.slice(100, 124).map(toHex) } };
    const snapshot = await sync({ a: {}, b: {} }, stranded);
    expect(snapshot.listHeight).toBe(tip);
  });
});
