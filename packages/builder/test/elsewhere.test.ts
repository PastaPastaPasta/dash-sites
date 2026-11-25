import { describe, expect, it } from 'vitest';
import { httpsFetcher, sha256Hex, utf8 } from '@dash-sites/core';
import { bucketKey, confirmPlaces, PINATA_UPLOAD, readPlaces, signS3, uploadToBucket, uploadToPinata, type Bucket, type OutsideFile } from '../src/elsewhere.js';

const photo: OutsideFile = { path: '/img/Hero Shot.WEBP', type: 'image/webp', bytes: new Uint8Array(5000).map((_, i) => (i * 13) % 251) };
const hash = sha256Hex(photo.bytes);
const bucket: Bucket = {
  endpoint: 'https://account.r2.cloudflarestorage.com/',
  bucket: 'media',
  region: 'auto',
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'secret',
  publicUrl: 'https://media.example.com',
  prefix: 'site/',
};
const CID = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi';

describe('signing a bucket request', () => {
  // The worked example in Amazon's "Signature Calculations for the Authorization Header" for S3.
  it('matches the published example for PUT Object', async () => {
    const body = utf8.encode('Welcome to Amazon S3.');
    const authorization = await signS3({
      method: 'PUT',
      url: new URL('https://examplebucket.s3.amazonaws.com/test%24file.text'),
      headers: { date: 'Fri, 24 May 2013 00:00:00 GMT', 'x-amz-date': '20130524T000000Z', 'x-amz-storage-class': 'REDUCED_REDUNDANCY', 'x-amz-content-sha256': sha256Hex(body) },
      payloadSha256: sha256Hex(body),
      region: 'us-east-1',
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      now: new Date('2013-05-24T00:00:00Z'),
    });
    expect(authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request,SignedHeaders=date;host;x-amz-content-sha256;x-amz-date;x-amz-storage-class,Signature=98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd',
    );
  });

  it('matches the published example for a request with a query', async () => {
    const empty = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
    const authorization = await signS3({
      method: 'GET',
      url: new URL('https://examplebucket.s3.amazonaws.com/?max-keys=2&prefix=J'),
      headers: { 'x-amz-date': '20130524T000000Z', 'x-amz-content-sha256': empty },
      payloadSha256: empty,
      region: 'us-east-1',
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      now: new Date('2013-05-24T00:00:00Z'),
    });
    expect(authorization).toMatch(/Signature=34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7$/);
  });
});

describe('uploading to a bucket', () => {
  it('names a file by its hash, under the folder asked for', () => {
    expect(bucketKey('site/', photo)).toBe(`site/${hash}.webp`);
    expect(bucketKey(undefined, { ...photo, path: '/LICENSE' })).toBe(hash);
    expect(bucketKey('/a/b/', photo)).toBe(`a/b/${hash}.webp`);
    for (const prefix of ['../x/', 'a b/', 'a?b', 'a/../b/']) expect(() => bucketKey(prefix, photo)).toThrow(/folder/);
  });

  it('sends one signed PUT and returns the public address', async () => {
    const sent: Array<[string, RequestInit]> = [];
    const place = await uploadToBucket(bucket, photo, {
      now: () => new Date('2026-11-25T01:02:03.456Z'),
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        sent.push([String(input), init ?? {}]);
        return new Response(null, { status: 200 });
      }) as typeof fetch,
    });
    expect(place).toBe(`https://media.example.com/site/${hash}.webp`);
    expect(sent).toHaveLength(1);
    const [url, init] = sent[0] as [string, RequestInit];
    expect(url).toBe(`https://account.r2.cloudflarestorage.com/media/site/${hash}.webp`);
    expect(init).toMatchObject({ method: 'PUT', credentials: 'omit', body: photo.bytes });
    const headers = init.headers as Record<string, string>;
    expect(headers).toMatchObject({ 'content-type': 'image/webp', 'x-amz-content-sha256': hash, 'x-amz-date': '20261125T010203Z' });
    expect(headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20261125\/auto\/s3\/aws4_request,SignedHeaders=host;x-amz-content-sha256;x-amz-date,Signature=[0-9a-f]{64}$/);
    expect(headers.authorization).not.toContain('secret');
  });

  it('explains a refusal, and refuses settings that are not addresses', async () => {
    const answering = (status: number) => ({ fetch: (async () => new Response(null, { status })) as typeof fetch });
    await expect(uploadToBucket(bucket, photo, answering(403))).rejects.toThrow(/refused the upload \(403: check the keys/);
    await expect(uploadToBucket(bucket, photo, answering(500))).rejects.toThrow(/refused the upload \(500\)/);
    await expect(uploadToBucket(bucket, photo, { fetch: (async () => Promise.reject(new TypeError('Failed to fetch'))) as typeof fetch })).rejects.toThrow(/CORS rules/);
    await expect(uploadToBucket({ ...bucket, endpoint: 'http://minio.local:9000' }, photo, answering(200))).rejects.toThrow(/API address must be an https/);
    await expect(uploadToBucket({ ...bucket, publicUrl: 'media.example.com' }, photo, answering(200))).rejects.toThrow(/public address must be an https/);
    await expect(uploadToBucket({ ...bucket, bucket: 'a/b' }, photo, answering(200))).rejects.toThrow(/bucket name/);
  });
});

describe('uploading to Pinata', () => {
  it('pins the file publicly and returns its IPFS place', async () => {
    const sent: Array<[string, RequestInit]> = [];
    const place = await uploadToPinata(' jwt-token ', photo, {
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        sent.push([String(input), init ?? {}]);
        return Response.json({ data: { cid: CID, size: photo.bytes.length } });
      }) as typeof fetch,
    });
    expect(place).toBe(`ipfs://${CID}`);
    const [url, init] = sent[0] as [string, RequestInit];
    expect(url).toBe(PINATA_UPLOAD);
    expect(init.headers).toEqual({ authorization: 'Bearer jwt-token' });
    const form = init.body as FormData;
    expect(form.get('network')).toBe('public');
    const file = form.get('file') as File;
    expect([file.name, file.type, file.size]).toEqual(['Hero Shot.WEBP', 'image/webp', photo.bytes.length]);
  });

  it('explains a refusal and rejects an answer without a CID', async () => {
    const answering = (response: Response) => ({ fetch: (async () => response) as typeof fetch });
    await expect(uploadToPinata('jwt', photo, answering(new Response(null, { status: 401 })))).rejects.toThrow(/refused the upload \(401: check the key/);
    await expect(uploadToPinata('jwt', photo, answering(Response.json({ data: {} })))).rejects.toThrow(/without a CID/);
    await expect(uploadToPinata('jwt', photo, answering(Response.json({ data: { cid: '../../etc' } })))).rejects.toThrow(/without a CID/);
  });
});

describe('places an owner gives', () => {
  it('reads addresses and bare CIDs, and names what is neither', () => {
    expect(readPlaces(`https://media.example.com/a.webp\n${CID}, ipfs://${CID}/a.webp  QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG http://x.example/a ar://abc`)).toEqual({
      places: ['https://media.example.com/a.webp', `ipfs://${CID}`, `ipfs://${CID}/a.webp`, 'ipfs://QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG'],
      unknown: ['http://x.example/a', 'ar://abc'],
    });
    expect(readPlaces(`${CID} ipfs://${CID}`).places).toEqual([`ipfs://${CID}`]);
  });

  it('are each asked for the file before they are accepted', async () => {
    const good = 'https://media.example.com/a.webp';
    const other = 'https://old.example.com/a.webp';
    const blocked = 'https://nocors.example.com/a.webp';
    const fetchers = {
      https: httpsFetcher({
        fetch: (async (input: RequestInfo | URL) => {
          if (String(input) === blocked) throw new TypeError('Failed to fetch');
          return new Response((String(input) === good ? photo.bytes : utf8.encode('older file')) as BodyInit);
        }) as typeof fetch,
      }),
    };
    const results = await confirmPlaces(photo, [good, other, blocked, `ipfs://${CID}`], fetchers);
    expect(results[0]).toEqual({ place: good });
    expect(results[1]?.problem).toMatch(/not the file/);
    expect(results[2]?.problem).toMatch(/Access-Control-Allow-Origin/);
    expect(results[3]?.problem).toMatch(/does not load this kind/);
  });
});
