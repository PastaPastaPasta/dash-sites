import { readFileSync } from 'node:fs';
import { documentCreateCost, ensureInitialized } from '@dashevo/evo-sdk';
import { base58 } from '@scure/base';
import { beforeAll, describe, expect, it } from 'vitest';
import { DEPLOYMENTS, DPNS_CONTRACT_ID, readerConfig } from '../src/config.js';
import { knownContract, loadFeeModel, parseContract } from '../src/evo.js';
import { KNOWN_CONTRACTS } from '../src/known-contracts.js';
import {
  CHUNK_FIELD_SIZE,
  CHUNK_FIELDS,
  CHUNK_SIZE,
  DASH_TLD,
  estimateCredits,
  formatContentUri,
  isValidLabel,
  MAX_CONTENT_URI_LENGTH,
  MAX_MANIFEST_CHUNKS,
  normalizeLabel,
  sha256Hex,
  type SiteBundle,
} from '../src/index.js';

const PROTOCOL_VERSION = 14;
const OWNER = base58.encode(new Uint8Array(32).fill(8));
const ID = base58.encode(new Uint8Array(32).fill(7));

interface Property {
  position: number;
  refersTo?: unknown;
  pattern?: string;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
}
type DocumentTypeSchema = Record<string, unknown> & { properties: Record<string, Property> };
type Schemas = Record<string, DocumentTypeSchema>;

const schemas = (): Schemas => JSON.parse(readFileSync(new URL('../../../contract/dash-sites.v2.json', import.meta.url), 'utf8')) as Schemas;
const registered = () => parseContract(OWNER, ID, schemas());

beforeAll(() => ensureInitialized());

describe('the contract to register', () => {
  it('is accepted by Platform, updatable and not moderated', () => {
    const contract = registered().toJSON() as { config: Record<string, unknown>; tokens: object; groups: object };
    expect(contract.config).toMatchObject({
      readonly: false,
      canBeDeleted: false,
      keepsHistory: false,
      documentsKeepHistoryContractDefault: false,
      documentsMutableContractDefault: true,
      documentsCanBeDeletedContractDefault: true,
    });
    expect(contract.config.moderation ?? undefined).toBeUndefined();
    expect(contract.tokens).toEqual({});
    expect(contract.groups).toEqual({});
  });

  it('keeps the terms an update can never change', () => {
    const terms = Object.fromEntries(Object.entries(schemas()).map(([name, { properties, ...rest }]) => [name, { ...rest, positions: Object.fromEntries(Object.entries(properties).map(([key, property]) => [key, property.position])) }]));
    expect(terms).toEqual({
      site: {
        type: 'object',
        documentsMutable: true,
        canBeDeleted: false,
        immutable: ['normalizedParentDomainName'],
        transferable: 0,
        tradeMode: 0,
        additionalProperties: false,
        required: ['normalizedParentDomainName', 'normalizedLabel', 'v', '$createdAt', '$updatedAt'],
        indices: [
          { name: 'nameAndOwner', properties: [{ normalizedParentDomainName: 'asc' }, { normalizedLabel: 'asc' }, { $ownerId: 'asc' }], unique: true },
          { name: 'ownerAndName', properties: [{ $ownerId: 'asc' }, { normalizedParentDomainName: 'asc' }, { normalizedLabel: 'asc' }], unique: true },
          { name: 'updated', properties: [{ $updatedAt: 'asc' }], countable: 'countable', rangeCountable: true },
        ],
        positions: { normalizedParentDomainName: 0, normalizedLabel: 1, content: 2, v: 3 },
      },
      chunk: {
        type: 'object',
        documentsMutable: false,
        canBeDeleted: true,
        transferable: 0,
        tradeMode: 0,
        additionalProperties: false,
        required: ['site', 'hash', 'd0', 'v', '$createdAt'],
        indices: [{ name: 'siteAndHash', properties: [{ site: 'asc' }, { hash: 'asc' }], unique: true }],
        positions: { site: 0, hash: 1, d0: 2, d1: 3, d2: 4, v: 5 },
      },
    });
  });

  it('is the schema its cost was measured on', () => {
    expect(sha256Hex(new TextEncoder().encode(JSON.stringify(schemas())))).toBe('9bce2ef65f17706f1f5b753041e3bac13738d168b9b9cc7c4ad434159f4a46dc');
  });

  it('is the contract registered on testnet', () => {
    const { bytes } = KNOWN_CONTRACTS.testnet?.[DEPLOYMENTS.testnet?.contractId as string] as { bytes: string };
    expect((knownContract(bytes).toJSON() as { documentSchemas: unknown }).documentSchemas).toEqual(schemas());
  });

  it('gives every document type a required format version', () => {
    for (const type of Object.values(schemas())) {
      expect(type.properties.v).toMatchObject({ type: 'integer', minimum: 1, maximum: 65535 });
      expect(type.required).toContain('v');
    }
  });

  it('has Platform take a site record only from the owner of its DPNS name, and refers to nothing else outside itself', () => {
    const parsed = (registered().toJSON() as { documentSchemas: Schemas }).documentSchemas;
    const references = Object.values(parsed).flatMap((type) => Object.values(type.properties).flatMap((property) => (property.refersTo ? [property.refersTo] : [])));
    expect(references).toEqual([
      { type: 'permanentDocument', documentType: 'site', where: { $ownerId: '$ownerId' } },
      {
        type: 'deletableDocument',
        contractId: DPNS_CONTRACT_ID,
        documentType: 'domain',
        findBy: { normalizedParentDomainName: 'normalizedParentDomainName', normalizedLabel: '.' },
        where: { $ownerId: '$ownerId' },
      },
    ]);
  });

  it('declares DPNS names deletable, as the DPNS contract on each network does: a mismatch stops every site write', () => {
    for (const network of ['testnet', 'mainnet'] as const) {
      const { bytes } = KNOWN_CONTRACTS[network]?.[DPNS_CONTRACT_ID] as { bytes: string };
      const domain = (knownContract(bytes).toJSON() as { documentSchemas: { domain: { canBeDeleted?: boolean } } }).documentSchemas.domain;
      expect(domain.canBeDeleted).toBe(true);
    }
  });

  it('has Platform take a chunk only from the identity that wrote its site record', () => {
    const parsed = (registered().toJSON() as { documentSchemas: Schemas }).documentSchemas;
    expect((parsed.chunk as DocumentTypeSchema).properties.site?.refersTo).toEqual({ type: 'permanentDocument', documentType: 'site', where: { $ownerId: '$ownerId' } });
  });

  it('cannot give moderators a say without declaring moderation when it is created', () => {
    const moderated = schemas();
    (moderated.chunk as DocumentTypeSchema).moderatorAbilities = { delete: true };
    expect(() => parseContract(OWNER, ID, moderated)).toThrow(/moderation/);
  });

  it('holds what the readers and writers expect', () => {
    const { site, chunk } = schemas() as { site: DocumentTypeSchema; chunk: DocumentTypeSchema };
    const fields = Object.keys(chunk.properties).filter((key) => /^d\d$/.test(key));
    expect(fields).toHaveLength(CHUNK_FIELDS);
    for (const key of fields) expect(chunk.properties[key]).toMatchObject({ minItems: 1, maxItems: CHUNK_FIELD_SIZE });

    const content = site.properties.content as Property;
    expect(content.maxLength).toBe(MAX_CONTENT_URI_LENGTH);
    const longest = formatContentUri({ scheme: 'dash-manifest', chunks: Array.from({ length: MAX_MANIFEST_CHUNKS }, (_, i) => sha256Hex(new Uint8Array([i]))) });
    expect(longest.length).toBeLessThanOrEqual(MAX_CONTENT_URI_LENGTH);
    for (const uri of [longest, `ipfs://${'b'.repeat(128)}`]) expect(uri).toMatch(new RegExp(content.pattern as string));

    for (const label of ['Alice', 'b0b', `${'L'.repeat(62)}9`]) {
      expect(isValidLabel(label)).toBe(true);
      expect(normalizeLabel(label)).toMatch(new RegExp(site.properties.normalizedLabel?.pattern as string));
    }
    expect(DASH_TLD).toMatch(new RegExp(site.properties.normalizedParentDomainName?.pattern as string));
    for (const key of ['normalizedLabel', 'normalizedParentDomainName']) expect(site.properties[key]?.maxLength).toBe(63);
  });

  it('costs what the publisher is quoted, and a delete refunds most of the storage', async () => {
    const contract = registered();
    const chunk = documentCreateCost(contract, 'chunk', { fields: { site: { length: 32 }, d0: { length: CHUNK_FIELD_SIZE }, d1: { length: CHUNK_FIELD_SIZE }, d2: { length: CHUNK_FIELD_SIZE } } }, PROTOCOL_VERSION);
    const site = documentCreateCost(contract, 'site', { fields: { normalizedParentDomainName: { length: 4 }, normalizedLabel: { length: 63 }, content: { length: 81 } } }, PROTOCOL_VERSION);
    const fees = await loadFeeModel(readerConfig('mainnet'));
    const deployed = knownContract(KNOWN_CONTRACTS.mainnet![DEPLOYMENTS.mainnet!.contractId]!.bytes);
    const full = documentCreateCost(deployed, 'chunk', { fields: { d0: { length: CHUNK_FIELD_SIZE }, d1: { length: CHUNK_FIELD_SIZE }, d2: { length: CHUNK_FIELD_SIZE } } }, PROTOCOL_VERSION);
    const small = documentCreateCost(deployed, 'chunk', { fields: { d0: { length: 100 }, d1: { present: false }, d2: { present: false } } }, PROTOCOL_VERSION);
    expect(fees.chunk(CHUNK_SIZE)).toBe(BigInt(full.totalCredits.newValues));
    expect(fees.chunk(100)).toBe(BigInt(small.totalCredits.newValues));
    const quoted = estimateCredits({ contentUri: 'x'.repeat(81), chunks: new Map([['', new Uint8Array(CHUNK_SIZE)]]) } as SiteBundle, fees);
    expect(BigInt(chunk.storage.credits.newValues + site.storage.credits.newValues)).toBeLessThanOrEqual(quoted);
    expect(chunk.refund.afterOneYear.knownValues / chunk.storage.credits.knownValues).toBeGreaterThan(0.9);
  });
});

describe('bundled contract snapshots', () => {
  it('decode, and each is the contract and version it is filed under', () => {
    for (const [network, contracts] of Object.entries(KNOWN_CONTRACTS)) {
      const deployed = DEPLOYMENTS[network as 'testnet' | 'mainnet']?.contractId;
      expect(Object.keys(contracts ?? {})).toEqual([DPNS_CONTRACT_ID, ...(deployed ? [deployed] : [])]);
      for (const [id, { version, bytes }] of Object.entries(contracts ?? {})) {
        const contract = knownContract(bytes);
        expect(contract.id.toBase58()).toBe(id);
        expect(Number(contract.version)).toBe(version);
      }
    }
  });
});
