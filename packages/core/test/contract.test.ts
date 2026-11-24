import { readFileSync } from 'node:fs';
import { documentCreateCost, ensureInitialized } from '@dashevo/evo-sdk';
import { base58 } from '@scure/base';
import { beforeAll, describe, expect, it } from 'vitest';
import { parseContract } from '../src/evo.js';
import {
  CHUNK_FIELD_SIZE,
  CHUNK_FIELDS,
  CHUNK_SIZE,
  estimateCredits,
  formatContentUri,
  MAX_CONTENT_URI_LENGTH,
  MAX_MANIFEST_CHUNKS,
  sha256Hex,
  type SiteBundle,
} from '../src/index.js';

const PROTOCOL_VERSION = 14;
const OWNER = base58.encode(new Uint8Array(32).fill(8));
const ID = base58.encode(new Uint8Array(32).fill(7));

interface Property {
  position: number;
  pattern?: string;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
}
type DocumentTypeSchema = Record<string, unknown> & { properties: Record<string, Property> };
type Schemas = Record<string, DocumentTypeSchema>;

const schemas = (): Schemas => JSON.parse(readFileSync(new URL('../../../contract/dash-sites.v1.json', import.meta.url), 'utf8')) as Schemas;
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
        canBeDeleted: true,
        transferable: 0,
        tradeMode: 0,
        additionalProperties: false,
        required: ['domainId', 'name', 'content', '$createdAt', '$updatedAt'],
        indices: [
          { name: 'ownerAndDomain', properties: [{ $ownerId: 'asc' }, { domainId: 'asc' }], unique: true },
          { name: 'updated', properties: [{ $updatedAt: 'asc' }] },
        ],
        positions: { domainId: 0, name: 1, content: 2 },
      },
      chunk: {
        type: 'object',
        documentsMutable: false,
        canBeDeleted: true,
        transferable: 0,
        tradeMode: 0,
        additionalProperties: false,
        required: ['hash', 'd0'],
        indices: [{ name: 'ownerAndHash', properties: [{ $ownerId: 'asc' }, { hash: 'asc' }], unique: true }],
        positions: { hash: 0, d0: 1, d1: 2, d2: 3 },
      },
    });
  });

  it('is the schema its cost was measured on', () => {
    expect(sha256Hex(new TextEncoder().encode(JSON.stringify(schemas())))).toBe('eb43d5de673e9090e3d78ab9631006e0d1a2e34d2921292ebe1aec44a52f210c');
  });

  it('cannot give moderators a say without declaring moderation when it is created', () => {
    const moderated = schemas();
    (moderated.chunk as DocumentTypeSchema).moderatorAbilities = { delete: true };
    expect(() => parseContract(OWNER, ID, moderated)).toThrow(/moderation/);
  });

  it('holds what the readers and writers expect', () => {
    const { site, chunk } = schemas() as { site: DocumentTypeSchema; chunk: DocumentTypeSchema };
    const fields = Object.keys(chunk.properties).filter((key) => key !== 'hash');
    expect(fields).toHaveLength(CHUNK_FIELDS);
    for (const key of fields) expect(chunk.properties[key]).toMatchObject({ minItems: 1, maxItems: CHUNK_FIELD_SIZE });

    const content = site.properties.content as Property;
    expect(content.maxLength).toBe(MAX_CONTENT_URI_LENGTH);
    const longest = formatContentUri({ scheme: 'dash-manifest', chunks: Array.from({ length: MAX_MANIFEST_CHUNKS }, (_, i) => sha256Hex(new Uint8Array([i]))) });
    expect(longest.length).toBeLessThanOrEqual(MAX_CONTENT_URI_LENGTH);
    for (const uri of [longest, `ipfs://${'b'.repeat(128)}`]) expect(uri).toMatch(new RegExp(content.pattern as string));

    const name = site.properties.name as Property;
    for (const value of [`${'a'.repeat(63)}.dash`, 'b10g.a11ce.dash']) {
      expect(value).toMatch(new RegExp(name.pattern as string));
      expect(value.length).toBeLessThanOrEqual(name.maxLength as number);
    }
  });

  it('costs what the publisher is quoted, and a delete refunds most of the storage', () => {
    const contract = registered();
    const chunk = documentCreateCost(contract, 'chunk', { fields: { d0: { length: CHUNK_FIELD_SIZE }, d1: { length: CHUNK_FIELD_SIZE }, d2: { length: CHUNK_FIELD_SIZE } } }, PROTOCOL_VERSION);
    const site = documentCreateCost(contract, 'site', { fields: { name: { length: 10 }, content: { length: 81 } } }, PROTOCOL_VERSION);
    const quoted = estimateCredits({ chunks: new Map([['', new Uint8Array(CHUNK_SIZE)]]) } as SiteBundle);
    expect(BigInt(chunk.storage.credits.newValues + site.storage.credits.newValues)).toBeLessThanOrEqual(quoted);
    expect(chunk.refund.afterOneYear.knownValues / chunk.storage.credits.knownValues).toBeGreaterThan(0.9);
  });
});
