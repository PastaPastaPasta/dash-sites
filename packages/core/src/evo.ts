import {
  DataContract,
  Document,
  EvoSDK,
  IdentityPublicKey,
  IdentitySigner,
  PrivateKey,
  wallet,
} from '@dashevo/evo-sdk';
import { ripemd160 } from '@noble/hashes/legacy';
import { base58 } from '@scure/base';
import { concat, fromHex, sha256, toHex } from './bytes.js';
import { DPNS_CONTRACT_ID, type NetworkConfig } from './config.js';
import { CHUNK_FIELD_SIZE, CHUNK_SIZE } from './limits.js';
import { DASH_TLD } from './names.js';
import type { DomainRecord, PlatformReader, PlatformWriter, ProofMeta, Proved, SiteRecord, StoredChunk } from './platform.js';

const PAGE = 100;
const PROTOCOL_VERSION = 14;

type Where = [string, string, unknown];

interface ProvedDocuments {
  data: Map<string, Document | undefined>;
  metadata: { toJSON(): Record<string, unknown> };
}

function toMeta(metadata: ProvedDocuments['metadata']): ProofMeta {
  const json = metadata.toJSON();
  return {
    height: Number(json.height),
    timeMs: Number(json.timeMs),
    coreChainLockedHeight: Number(json.coreChainLockedHeight),
    protocolVersion: Number(json.protocolVersion),
  };
}

function toDomain(id: string, document: Document): DomainRecord {
  const object = document.toObject() as Record<string, unknown>;
  return {
    id,
    ownerId: document.ownerId.toBase58(),
    label: String(object.label),
    normalizedLabel: String(object.normalizedLabel),
    transferredAt: Number(document.transferredAt ?? document.createdAt ?? 0),
  };
}

function toSite(id: string, document: Document): SiteRecord {
  const object = document.toObject() as Record<string, unknown>;
  return {
    id,
    ownerId: document.ownerId.toBase58(),
    domainId: base58.encode(object.domainId as Uint8Array),
    content: String(object.content),
    revision: Number(document.revision ?? 1),
    updatedAt: Number(document.updatedAt ?? 0),
  };
}

function chunkData(object: Record<string, unknown>): Uint8Array {
  const fields = [object.d0, object.d1, object.d2].filter((field): field is Uint8Array => field instanceof Uint8Array);
  return concat(fields);
}

export interface ConnectOptions {
  /** DAPI addresses to use instead of the network's own list. */
  addresses?: string[];
  timeoutMs?: number;
}

export async function connectSdk(config: NetworkConfig, options: ConnectOptions = {}): Promise<EvoSDK> {
  const sdk = new EvoSDK({
    network: config.network,
    trusted: true,
    ...(options.addresses ? { addresses: options.addresses } : {}),
    settings: { connectTimeoutMs: 10000, timeoutMs: options.timeoutMs ?? 30000, retries: 4 },
  });
  await sdk.connect();
  return sdk;
}

/** Reads through the Evo SDK. Every query is proof-verified against the network's quorum keys. */
export class EvoReader implements PlatformReader {
  constructor(
    protected readonly sdk: EvoSDK,
    protected readonly config: NetworkConfig,
  ) {}

  static async connect(config: NetworkConfig, options?: ConnectOptions): Promise<EvoReader> {
    return new EvoReader(await connectSdk(config, options), config);
  }

  protected async query(contractId: string, type: string, where: Where[], extra: Record<string, unknown> = {}): Promise<ProvedDocuments> {
    const query = { dataContractId: contractId, documentTypeName: type, where, ...extra };
    return (await this.sdk.documents.queryWithProof(query as never)) as unknown as ProvedDocuments;
  }

  private async one<T>(result: ProvedDocuments, convert: (id: string, document: Document) => T): Promise<Proved<T | undefined>> {
    const meta = toMeta(result.metadata);
    for (const [id, document] of result.data) {
      if (document) return { value: convert(id, document), meta };
    }
    return { value: undefined, meta };
  }

  async getDomain(normalizedLabel: string): Promise<Proved<DomainRecord | undefined>> {
    const where: Where[] = [
      ['normalizedParentDomainName', '==', DASH_TLD],
      ['normalizedLabel', '==', normalizedLabel],
    ];
    return this.one(await this.query(DPNS_CONTRACT_ID, 'domain', where, { limit: 1 }), toDomain);
  }

  async getSite(ownerId: string, domainId: string): Promise<Proved<SiteRecord | undefined>> {
    return this.one(await this.siteDocuments(ownerId, domainId), toSite);
  }

  protected siteDocuments(ownerId: string, domainId: string): Promise<ProvedDocuments> {
    const where: Where[] = [
      ['$ownerId', '==', ownerId],
      ['domainId', '==', domainId],
    ];
    return this.query(this.config.contractId, 'site', where, { limit: 1 });
  }

  async getChunks(ownerId: string, hashes: string[]): Promise<Map<string, Uint8Array>> {
    const out = new Map<string, Uint8Array>();
    const wanted = [...new Set(hashes)];
    for (let i = 0; i < wanted.length; i += PAGE) {
      const batch = wanted.slice(i, i + PAGE).map((hash) => base58.encode(fromHex(hash)));
      const where: Where[] = [
        ['$ownerId', '==', ownerId],
        ['hash', 'in', batch],
      ];
      const result = await this.query(this.config.contractId, 'chunk', where, { orderBy: [['hash', 'asc']], limit: PAGE });
      for (const document of result.data.values()) {
        if (!document) continue;
        const object = document.toObject() as Record<string, unknown>;
        out.set(toHex(object.hash as Uint8Array), chunkData(object));
      }
    }
    return out;
  }

  /** Names whose identity record is `identityId` and which that identity still owns. */
  async listOwnedNames(identityId: string): Promise<DomainRecord[]> {
    const where: Where[] = [['records.identity', '==', identityId]];
    const result = await this.query(DPNS_CONTRACT_ID, 'domain', where, { limit: PAGE });
    const out: DomainRecord[] = [];
    for (const [id, document] of result.data) {
      if (!document) continue;
      const object = document.toObject() as Record<string, unknown>;
      if (object.normalizedParentDomainName !== DASH_TLD) continue;
      const domain = toDomain(id, document);
      if (domain.ownerId === identityId) out.push(domain);
    }
    return out;
  }

  async identityBalance(identityId: string): Promise<bigint> {
    return BigInt((await this.sdk.identities.balance(identityId)) ?? 0n);
  }
}

export interface Credentials {
  identityId: string;
  /** WIF of an AUTHENTICATION key of the identity, security level HIGH or CRITICAL. */
  privateKeyWif: string;
}

interface SigningKey {
  identityKey: IdentityPublicKey;
  signer: IdentitySigner;
}

function hash160Hex(publicKeyHex: string): string {
  return toHex(ripemd160(sha256(fromHex(publicKeyHex))));
}

async function signingKey(sdk: EvoSDK, credentials: Credentials, levels: string[]): Promise<SigningKey> {
  const identity = await sdk.identities.fetch(credentials.identityId);
  if (!identity) throw new Error(`identity ${credentials.identityId} does not exist`);
  let publicKeyHex: string;
  try {
    publicKeyHex = (await wallet.keyPairFromWif(credentials.privateKeyWif)).publicKey;
  } catch {
    throw new Error('the private key is not a valid WIF');
  }
  const candidates = [publicKeyHex.toLowerCase(), hash160Hex(publicKeyHex)];
  const matches = identity.publicKeys.filter((key) => candidates.includes(String(key.data).toLowerCase()) && key.disabledAt === undefined);
  if (matches.length === 0) throw new Error('the private key does not belong to this identity');
  const usable = matches.find((key) => key.purpose === 'AUTHENTICATION' && levels.includes(key.securityLevel));
  if (!usable) {
    const found = matches.map((key) => `${key.purpose}/${key.securityLevel}`).join(', ');
    throw new Error(`this key is ${found}; an AUTHENTICATION key of level ${levels.join(' or ')} is needed`);
  }
  const signer = new IdentitySigner();
  signer.addKey(PrivateKey.fromWIF(credentials.privateKeyWif));
  return { identityKey: usable, signer };
}

function field(data: Uint8Array, index: number): Uint8Array | undefined {
  const start = index * CHUNK_FIELD_SIZE;
  return start < data.length ? data.subarray(start, start + CHUNK_FIELD_SIZE) : undefined;
}

/** Reads and writes as one identity. */
export class EvoWriter extends EvoReader implements PlatformWriter {
  private constructor(
    sdk: EvoSDK,
    config: NetworkConfig,
    readonly identityId: string,
    private readonly key: SigningKey,
  ) {
    super(sdk, config);
  }

  static async connectAs(config: NetworkConfig, credentials: Credentials, options?: ConnectOptions): Promise<EvoWriter> {
    const sdk = await connectSdk(config, options);
    return new EvoWriter(sdk, config, credentials.identityId, await signingKey(sdk, credentials, ['HIGH', 'CRITICAL']));
  }

  private newDocument(type: string, properties: Record<string, unknown>): Document {
    const base = new Document({
      properties: {},
      documentTypeName: type,
      dataContractId: this.config.contractId,
      ownerId: this.identityId,
    } as never);
    return Document.fromObject({ ...(base.toObject() as object), ...properties } as never, this.sdk.wasm.version() as never);
  }

  private async all(type: string, orderBy: string): Promise<Array<[string, Document]>> {
    const out: Array<[string, Document]> = [];
    let startAfter: string | undefined;
    for (;;) {
      const where: Where[] = [['$ownerId', '==', this.identityId]];
      const extra = { orderBy: [[orderBy, 'asc']], limit: PAGE, ...(startAfter ? { startAfter } : {}) };
      const result = await this.query(this.config.contractId, type, where, extra);
      const page = [...result.data].filter((entry): entry is [string, Document] => entry[1] !== undefined);
      out.push(...page);
      if (page.length < PAGE) return out;
      startAfter = page[page.length - 1]?.[0];
    }
  }

  async listSites(): Promise<SiteRecord[]> {
    return (await this.all('site', 'domainId')).map(([id, document]) => toSite(id, document));
  }

  async listChunks(): Promise<StoredChunk[]> {
    return (await this.all('chunk', 'hash')).map(([id, document]) => ({
      id,
      hash: toHex((document.toObject() as Record<string, unknown>).hash as Uint8Array),
    }));
  }

  async createChunk(hash: string, data: Uint8Array): Promise<void> {
    if (data.length === 0 || data.length > CHUNK_SIZE) throw new Error('chunk size out of range');
    const properties: Record<string, unknown> = { hash: fromHex(hash) };
    for (const index of [0, 1, 2]) {
      const part = field(data, index);
      if (part) properties[`d${index}`] = part;
    }
    for (let attempt = 0; ; attempt++) {
      try {
        await this.sdk.documents.create({ document: this.newDocument('chunk', properties), ...this.key });
        return;
      } catch (error) {
        if ((await this.getChunks(this.identityId, [hash])).has(hash)) return;
        if (attempt >= 2) throw error;
      }
    }
  }

  async putSite(domain: DomainRecord, content: string): Promise<SiteRecord> {
    const existing = [...(await this.siteDocuments(this.identityId, domain.id)).data].find((entry) => entry[1] !== undefined);
    if (existing?.[1]) {
      const object = existing[1].toObject() as Record<string, unknown>;
      const next = { ...object, content, $revision: BigInt((object.$revision as bigint | number | undefined) ?? 1) + 1n };
      const document = Document.fromObject(next as never, this.sdk.wasm.version() as never);
      await this.sdk.documents.replace({ document, ...this.key });
    } else {
      const properties = { domainId: base58.decode(domain.id), name: `${domain.normalizedLabel}.${DASH_TLD}`, content };
      await this.sdk.documents.create({ document: this.newDocument('site', properties), ...this.key });
    }
    const stored = (await this.getSite(this.identityId, domain.id)).value;
    if (!stored || stored.content !== content) throw new Error('the site record was not stored');
    return stored;
  }

  async deleteSite(domainId: string): Promise<boolean> {
    const site = (await this.getSite(this.identityId, domainId)).value;
    if (!site) return false;
    await this.deleteDocument('site', site.id);
    return true;
  }

  deleteChunk(id: string): Promise<void> {
    return this.deleteDocument('chunk', id);
  }

  private async deleteDocument(type: string, id: string): Promise<void> {
    const document = { id, ownerId: this.identityId, dataContractId: this.config.contractId, documentTypeName: type };
    await this.sdk.documents.delete({ document, ...this.key });
  }

  balance(): Promise<bigint> {
    return this.identityBalance(this.identityId);
  }
}

function contractIdFor(ownerId: string, nonce: bigint): string {
  const encoded = new Uint8Array(8);
  new DataView(encoded.buffer).setBigUint64(0, nonce);
  return base58.encode(sha256(sha256(concat([base58.decode(ownerId), encoded]))));
}

/** Registers the dash-sites contract and returns its id. Needs a CRITICAL authentication key. */
export async function registerContract(
  network: NetworkConfig['network'],
  credentials: Credentials,
  documentSchemas: unknown,
  options?: ConnectOptions,
): Promise<string> {
  const sdk = await connectSdk({ network, contractId: '' }, options);
  const key = await signingKey(sdk, credentials, ['CRITICAL']);
  const nonce = (BigInt((await sdk.identities.nonce(credentials.identityId)) ?? 0n) & 0xffffffffffn) + 1n;
  const id = contractIdFor(credentials.identityId, nonce);
  const json = { $formatVersion: '1', id, ownerId: credentials.identityId, version: 1, documentSchemas };
  const dataContract = DataContract.fromJSON(json as never, true, PROTOCOL_VERSION as never);
  await sdk.contracts.publish({ dataContract, ...key });
  return id;
}
