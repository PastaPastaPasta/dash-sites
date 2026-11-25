import { describe, expect, it } from 'vitest';
import { networkConfig, toHex, utf8 } from '@dash-sites/core';
import {
  encodeCompositeNameQuery,
  GET_DOCUMENTS_PATH,
  GET_EPOCHS_INFO_BODY,
  GET_EPOCHS_INFO_PATH,
  grpcStatusFromResponse,
  PlatformPrefetch,
} from '../src/prefetch.js';

const QUORUMS = 'https://quorums.test';
const MAINNET = networkConfig('mainnet');

function grpcOk(payload: Uint8Array = new Uint8Array([1, 2, 3])): Uint8Array {
  const dataFrame = new Uint8Array(5 + payload.length);
  new DataView(dataFrame.buffer).setUint32(1, payload.length, false);
  dataFrame.set(payload, 5);
  const trailerText = utf8.encode('grpc-status:0\r\n');
  const trailerFrame = new Uint8Array(5 + trailerText.length);
  trailerFrame[0] = 0x80;
  new DataView(trailerFrame.buffer).setUint32(1, trailerText.length, false);
  trailerFrame.set(trailerText, 5);
  const out = new Uint8Array(dataFrame.length + trailerFrame.length);
  out.set(dataFrame, 0);
  out.set(trailerFrame, dataFrame.length);
  return out;
}

describe('encodeCompositeNameQuery', () => {
  it('produces the exact gRPC-web protobuf frame for a mainnet name with chunk preload', () => {
    const encoded = encodeCompositeNameQuery(MAINNET.contractId, 'd4shhq', true);
    expect(toHex(encoded)).toBe(
      '000000013612b3020a20e668c659af66aee1e72c186dde7b5b7e0a1d712a09c40d5721f622bf53c531551206646f6d61696e1a240a1a6e6f726d616c697a6564506172656e74446f6d61696e4e616d651a062a04646173681a1b0a0f6e6f726d616c697a65644c6162656c1a082a06643473686871280140014a007281010a20e1cdc31c907cdf54f462369e55565fea8ee4384b7500220fb446fbfc77f15cba1204736974651a240a1a6e6f726d616c697a6564506172656e74446f6d61696e4e616d651a062a04646173681a1b0a0f6e6f726d616c697a65644c6162656c1a082a066434736868713a141208246f776e657249641a08246f776e65724964723a0a20e1cdc31c907cdf54f462369e55565fea8ee4384b7500220fb446fbfc77f15cba12056368756e6b28203a0d080112032469641a0473697465',
    );
  });

  it('omits the chunk subquery when preload is false', () => {
    const withPreload = encodeCompositeNameQuery(MAINNET.contractId, 'd4shhq', true);
    const withoutPreload = encodeCompositeNameQuery(MAINNET.contractId, 'd4shhq', false);
    expect(withoutPreload.length).toBeLessThan(withPreload.length);
    const payloadLen = new DataView(withoutPreload.buffer).getUint32(1, false);
    expect(payloadLen).toBe(withoutPreload.length - 5);
  });
});

describe('grpcStatusFromResponse', () => {
  it('reads grpc-status from headers or from a gRPC-web trailer frame', () => {
    expect(grpcStatusFromResponse(new Response(null, { headers: { 'grpc-status': '14' } }), new Uint8Array(0))).toBe('14');
    const okBytes = grpcOk();
    expect(grpcStatusFromResponse(new Response(okBytes as BodyInit), okBytes)).toBe('0');
  });
});

describe('PlatformPrefetch', () => {
  it('prefetches quorums, epochs, and composite documents in parallel and serves each once via wrapFetch', async () => {
    const calls: string[] = [];
    const epochBytes = grpcOk(new Uint8Array([9, 8, 7]));
    const docBytes = grpcOk(new Uint8Array([4, 5, 6]));

    const mockFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      calls.push(url);
      if (url === `${QUORUMS}/quorums`) return new Response('{"quorums":1}', { status: 200 });
      if (url === `${QUORUMS}/previous`) return new Response('{"previous":1}', { status: 200 });
      if (url === `${QUORUMS}/masternodes`) {
        return new Response(
          JSON.stringify({
            data: [
              { status: 'ENABLED', versionCheck: 'success', addresses: { platform_https: ['1.1.1.1:443'] } },
              { status: 'ENABLED', versionCheck: 'success', addresses: { platform_https: ['2.2.2.2:443'] } },
            ],
          }),
        );
      }
      if (url.endsWith(GET_EPOCHS_INFO_PATH)) {
        const delay = url.includes('1.1.1.1') ? 5 : 25;
        await new Promise((r) => setTimeout(r, delay));
        return new Response(epochBytes as BodyInit, { status: 200, headers: { 'content-type': 'application/grpc-web+proto' } });
      }
      if (url.endsWith(GET_DOCUMENTS_PATH)) {
        return new Response(docBytes as BodyInit, { status: 200, headers: { 'content-type': 'application/grpc-web+proto' } });
      }
      expect(init).toBeDefined();
      return new Response(null, { status: 404 });
    }) as typeof fetch;

    const prefetch = new PlatformPrefetch({
      quorumUrl: QUORUMS,
      fetch: mockFetch,
      contractId: MAINNET.contractId,
      normalizedLabel: 'd4shhq',
      preload: true,
    });
    prefetch.start();

    const addresses = await prefetch.takeAddresses(500, 2);
    expect(addresses).toEqual(['https://1.1.1.1:443', 'https://2.2.2.2:443']);

    let liveCalls = 0;
    const wrapped = prefetch.wrapFetch((async () => {
      liveCalls += 1;
      return new Response('live');
    }) as typeof fetch);

    const quorumsRes = await wrapped(`${QUORUMS}/quorums`);
    expect(quorumsRes.url).toBe(`${QUORUMS}/quorums`);
    expect(await quorumsRes.text()).toBe('{"quorums":1}');
    const prevRes = await wrapped(`${QUORUMS}/previous`);
    expect(prevRes.url).toBe(`${QUORUMS}/previous`);
    expect(await prevRes.text()).toBe('{"previous":1}');

    const epochRes = await wrapped(
      new Request(`https://2.2.2.2:443${GET_EPOCHS_INFO_PATH}`, { method: 'POST', body: GET_EPOCHS_INFO_BODY }),
    );
    expect(epochRes.url).toMatch(/^https:\/\/[12]\.[12]\.[12]\.[12]:443\/org\.dash\.platform\.dapi\.v0\.Platform\/getEpochsInfo$/);
    expect(new Uint8Array(await epochRes.arrayBuffer())).toEqual(epochBytes);

    const docQuery = encodeCompositeNameQuery(MAINNET.contractId, 'd4shhq', true);
    const docRes = await wrapped(
      new Request(`https://2.2.2.2:443${GET_DOCUMENTS_PATH}`, { method: 'POST', body: docQuery }),
    );
    expect(docRes.url).toMatch(GET_DOCUMENTS_PATH);
    expect(new Uint8Array(await docRes.arrayBuffer())).toEqual(docBytes);
    expect(liveCalls).toBe(0);

    // Second identical call bypasses consumed cache and goes live (retries never see stale data)
    expect(await (await wrapped(new Request(`https://2.2.2.2:443${GET_DOCUMENTS_PATH}`, { method: 'POST', body: docQuery }))).text()).toBe('live');
    expect(liveCalls).toBe(1);
    expect(calls.some((c) => c.endsWith(GET_DOCUMENTS_PATH))).toBe(true);
  });

  it('returns already-answered nodes on grace timeout instead of discarding them', async () => {
    const epochBytes = grpcOk();
    const mockFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === `${QUORUMS}/masternodes`) {
        return new Response(
          JSON.stringify({
            data: [
              { status: 'ENABLED', versionCheck: 'success', addresses: { platform_https: ['1.1.1.1:443'] } },
              { status: 'ENABLED', versionCheck: 'success', addresses: { platform_https: ['2.2.2.2:443'] } },
            ],
          }),
        );
      }
      if (url.includes('1.1.1.1')) return new Response(epochBytes as BodyInit, { status: 200 });
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    }) as typeof fetch;

    const prefetch = new PlatformPrefetch({ quorumUrl: QUORUMS, fetch: mockFetch });
    prefetch.start();
    const addresses = await prefetch.takeAddresses(60, 2);
    expect(addresses).toEqual(['https://1.1.1.1:443']);
  });
});
