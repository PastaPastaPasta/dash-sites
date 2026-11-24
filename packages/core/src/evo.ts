import {
  DataContract,
  Document,
  EvoSDK,
  IdentityPublicKey,
  IdentitySigner,
  PrivateKey,
  wallet,
} from '@dashevo/evo-sdk';
import { ripemd160 } from '@noble/hashes/legacy.js';
import { base58 } from '@scure/base';
import { concat, fromHex, sha256, toHex } from './bytes.js';
import { DPNS_CONTRACT_ID, type NetworkConfig } from './config.js';
import { KNOWN_CONTRACTS } from './known-contracts.js';
import { CHUNK_FIELD_SIZE, CHUNK_SIZE } from './limits.js';
import { DASH_TLD, isValidLabel, normalizeLabel } from './names.js';
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
  /** Fetch every contract from the network instead of starting from the bundled snapshots. */
  fetchContracts?: boolean;
}

export const knownContract = (bytes: string): DataContract => DataContract.fromBase64(bytes, false, PROTOCOL_VERSION);

/**
 * Seeds the SDK with the bundled DPNS and dash-sites contracts, so the first queries need no contract
 * fetch, then checks in the background that they are still the network's current versions and
 * replaces any that are not.
 */
async function seedContracts(sdk: EvoSDK, config: NetworkConfig): Promise<void> {
  const known = Object.entries(KNOWN_CONTRACTS[config.network] ?? {});
  for (const [, { bytes }] of known) {
    try {
      await sdk.contracts.addKnown(knownContract(bytes));
    } catch {
      // Unusable snapshot: queries fetch the contract as before.
    }
  }
  if (known.length === 0) return;
  void (async () => {
    const latest = await sdk.contracts.getLatestVersions({ contractIds: known.map(([id]) => id) });
    const stale = known.filter(([id, { version }]) => latest.get(id) !== undefined && latest.get(id)?.version !== version).map(([id]) => id);
    if (stale.length === 0) return;
    for (const entry of (await sdk.contracts.getLatestVersions({ contractIds: stale, includeContracts: true })).values()) {
      if (entry?.dataContract) await sdk.contracts.addKnown(entry.dataContract);
    }
  })().catch(() => undefined);
}

/** How long a Platform read may wait for its response headers before it counts as failed. */
export const READ_DEADLINE_MS = 8000;
const PLATFORM_READ = /\/org\.dash\.platform\.dapi\.v0\.Platform\/get[A-Za-z]+$/;

/**
 * The SDK's own request timeout is not enforced in browsers: a node that accepts the connection and
 * never answers holds a query for minutes. This fetch aborts a Platform read that has no response
 * headers after `deadlineMs`, so the SDK bans that node and retries on another. Writes, which wait
 * for a block, and every other request pass through untouched.
 */
export function withReadDeadline(inner: typeof fetch, deadlineMs = READ_DEADLINE_MS): typeof fetch {
  return (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), 'https://local/');
    if (!PLATFORM_READ.test(url.pathname)) return inner(input, init);
    const deadline = new AbortController();
    const caller = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    if (caller?.aborted) deadline.abort(caller.reason);
    else caller?.addEventListener('abort', () => deadline.abort(caller.reason), { once: true });
    const timer = setTimeout(() => deadline.abort(new Error(`no answer from ${url.host} within ${deadlineMs} ms`)), deadlineMs);
    return inner(input, { ...init, signal: deadline.signal }).finally(() => clearTimeout(timer));
  };
}

let deadlineInstalled = false;
function installReadDeadline(): void {
  if (deadlineInstalled || typeof globalThis.fetch !== 'function') return;
  deadlineInstalled = true;
  globalThis.fetch = withReadDeadline(globalThis.fetch.bind(globalThis));
}

export async function connectSdk(config: NetworkConfig, options: ConnectOptions = {}): Promise<EvoSDK> {
  installReadDeadline();
  const sdk = new EvoSDK({
    network: config.network,
    trusted: true,
    ...(options.addresses ? { addresses: options.addresses } : {}),
    settings: { connectTimeoutMs: 10000, timeoutMs: options.timeoutMs ?? 30000, retries: 4 },
  });
  await sdk.connect();
  if (!options.fetchContracts) await seedContracts(sdk, config);
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

  get noSiteContract(): boolean {
    return !this.config.contractId;
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
    if (this.noSiteContract) return out;
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
  /** An AUTHENTICATION key of the identity, security level HIGH or CRITICAL: its WIF, or its 32 bytes. */
  privateKeyWif?: string;
  privateKey?: Uint8Array;
}

interface SigningKey {
  identityKey: IdentityPublicKey;
  signer: IdentitySigner;
}

/** What the signing key is allowed to do. A key from a wallet is bound to this contract and limited. */
export interface KeyLimits {
  keyId: number;
  /** True when the key signs only for the dash-sites contract, so it cannot register names. */
  bound: boolean;
  totalBudget?: bigint;
  expiresAt?: number;
}

function boundContract(key: IdentityPublicKey): string | undefined | null {
  const bounds = key.contractBounds;
  if (!bounds) return undefined;
  try {
    const json = bounds.toJSON() as { $type?: unknown; id?: unknown };
    return json.$type === 'singleContract' && typeof json.id === 'string' ? json.id : null;
  } catch {
    return null;
  }
}

function hash160Hex(publicKeyHex: string): string {
  return toHex(ripemd160(sha256(fromHex(publicKeyHex))));
}

/** The key cannot sign for this identity, as opposed to a read that failed. */
export class KeyRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KeyRefused';
  }
}

function quietlyFree(value: { free(): void }): void {
  try {
    value.free();
  } catch {
    // already freed
  }
}

async function signingKey(sdk: EvoSDK, config: NetworkConfig, credentials: Credentials, levels: string[]): Promise<SigningKey> {
  const identity = await sdk.identities.fetch(credentials.identityId);
  if (!identity) throw new KeyRefused(`identity ${credentials.identityId} does not exist`);
  let privateKey: PrivateKey;
  let publicKeyHex: string;
  try {
    privateKey = credentials.privateKey ? PrivateKey.fromBytes(credentials.privateKey, config.network) : PrivateKey.fromWIF(credentials.privateKeyWif ?? '');
    publicKeyHex = (await wallet.keyPairFromWif(privateKey.toWIF())).publicKey;
  } catch {
    throw new KeyRefused('the private key is not a valid WIF');
  }
  const candidates = [publicKeyHex.toLowerCase(), hash160Hex(publicKeyHex)];
  const matches = identity.publicKeys.filter((key) => candidates.includes(String(key.data).toLowerCase()) && key.disabledAt === undefined);
  if (matches.length === 0) throw new KeyRefused('the private key does not belong to this identity, or the key was disabled');
  const usable = matches.find((key) => key.purpose === 'AUTHENTICATION' && levels.includes(key.securityLevel));
  if (!usable) {
    const found = matches.map((key) => `${key.purpose}/${key.securityLevel}`).join(', ');
    throw new KeyRefused(`this key is ${found}; an AUTHENTICATION key of level ${levels.join(' or ')} is needed`);
  }
  const bound = boundContract(usable);
  if (bound !== undefined && bound !== config.contractId) throw new KeyRefused('this key is limited to another app, so it cannot publish sites');
  const signer = new IdentitySigner();
  signer.addKey(privateKey);
  quietlyFree(privateKey);
  return { identityKey: usable, signer };
}

/** Reads until `done` accepts the answer: a node can answer from the block before a write. */
async function settled<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  let value = await read();
  for (let attempt = 0; attempt < 12 && !done(value); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    value = await read();
  }
  return value;
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
    return EvoWriter.on(await connectSdk(config, options), config, credentials);
  }

  /** As `connectAs`, over a connection that is already open. */
  static async on(sdk: EvoSDK, config: NetworkConfig, credentials: Credentials): Promise<EvoWriter> {
    return new EvoWriter(sdk, config, credentials.identityId, await signingKey(sdk, config, credentials, ['HIGH', 'CRITICAL']));
  }

  /** Drops the signing key held in the SDK's memory. The writer cannot sign afterwards. */
  forget(): void {
    quietlyFree(this.key.signer);
  }

  get keyLimits(): KeyLimits {
    const key = this.key.identityKey;
    return {
      keyId: key.keyId,
      bound: key.contractBounds !== undefined,
      ...(key.totalBudget !== undefined ? { totalBudget: key.totalBudget } : {}),
      ...(key.expiresAt !== undefined ? { expiresAt: Number(key.expiresAt) } : {}),
    };
  }

  /** Credits the signing key may still spend; undefined for a key without a budget. */
  async remainingBudget(): Promise<bigint | undefined> {
    const { keyId, totalBudget } = this.keyLimits;
    if (totalBudget === undefined) return undefined;
    for (const [id, left] of await this.sdk.identities.keysRemainingBudgets(this.identityId, [keyId])) if (Number(id) === keyId) return left ?? undefined;
    return undefined;
  }

  /** False once the signing key was disabled, as a wallet does when it replaces or removes a connection. */
  async keyLive(): Promise<boolean> {
    const identity = await this.sdk.identities.fetch(this.identityId);
    return identity?.publicKeys.some((key) => key.keyId === this.key.identityKey.keyId && key.disabledAt === undefined) ?? false;
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
    const stored = await settled(
      async () => (await this.getSite(this.identityId, domain.id)).value,
      (site) => site?.content === content,
    );
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

  /**
   * Registers `label`.dash for this identity. Contested names (3 to 19 characters of letters,
   * 0, 1 and -) go to a masternode vote and cost a deposit, so they are refused unless asked for.
   */
  async registerName(label: string, options: { allowContested?: boolean } = {}): Promise<DomainRecord> {
    if (!isValidLabel(label)) throw new Error(`${label} is not a name Dash Sites can serve`);
    if (this.keyLimits.bound) throw new Error('A key from your wallet can publish sites but cannot register names. Register the name in your wallet.');
    if (!options.allowContested && (await this.sdk.dpns.isContestedUsername(label))) {
      throw new Error(`${label}.dash is a contested name: it needs a masternode vote and a deposit. Names with a digit from 2 to 9, or 20 characters or more, register at once.`);
    }
    const identity = await this.sdk.identities.fetch(this.identityId);
    if (!identity) throw new Error(`identity ${this.identityId} does not exist`);
    await this.sdk.dpns.registerName({ label, identity, ...this.key });
    const domain = await settled(
      async () => (await this.getDomain(normalizeLabel(label))).value,
      (found) => found !== undefined,
    );
    if (!domain || domain.ownerId !== this.identityId) throw new Error(`${label}.dash was not registered to this identity`);
    return domain;
  }
}

function contractIdFor(ownerId: string, nonce: bigint): string {
  const encoded = new Uint8Array(8);
  new DataView(encoded.buffer).setBigUint64(0, nonce);
  return base58.encode(sha256(sha256(concat([base58.decode(ownerId), encoded]))));
}

/**
 * The contract as it is registered: version 1, with no `config`, so Platform's defaults apply.
 * Throws when Platform's rules for the protocol version refuse the schemas.
 */
export function parseContract(ownerId: string, id: string, documentSchemas: unknown): DataContract {
  const json = { $formatVersion: '1', id, ownerId, version: 1, documentSchemas };
  return DataContract.fromJSON(json as never, true, PROTOCOL_VERSION as never);
}

/** Registers the dash-sites contract and returns its id. Needs a CRITICAL authentication key. */
export async function registerContract(
  network: NetworkConfig['network'],
  credentials: Credentials,
  documentSchemas: unknown,
  options?: ConnectOptions,
): Promise<string> {
  const config = { network, contractId: '' };
  const sdk = await connectSdk(config, options);
  const key = await signingKey(sdk, config, credentials, ['CRITICAL']);
  const nonce = (BigInt((await sdk.identities.nonce(credentials.identityId)) ?? 0n) & 0xffffffffffn) + 1n;
  const id = contractIdFor(credentials.identityId, nonce);
  const dataContract = parseContract(credentials.identityId, id, documentSchemas);
  await sdk.contracts.publish({ dataContract, ...key });
  return id;
}
