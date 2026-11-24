// A scripted stand-in for a mobile wallet answering an App Connect v2 sign-in request, for tests.
// Like DashPay for Android it adds one ECDSA_HASH160 authentication key bound to the requested
// contract, with a budget and an expiry, in a master-signed identity update, then publishes the
// sealed key as a loginKeyResponse document. It broadcasts: use a testnet identity of your own.
//   node e2e/wallet-responder.mjs <identity.json> '<dashpay://connect?...>'
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { ContractBounds, Document, IdentityPublicKey, IdentityPublicKeyInCreation, IdentitySigner, PrivateKey } from '@dashevo/evo-sdk';
import { ripemd160 } from '@noble/hashes/legacy.js';
import { sha256 } from '@noble/hashes/sha2.js';
import * as secp from '@noble/secp256k1';
import { base58 } from '@scure/base';
import { APP_CONNECT_CONTRACT_ID } from '../packages/core/dist/connect.js';
import { connectSdk } from '../packages/core/dist/evo.js';
import { appConnectRequestHash, checkAppConnectRequestAge, parseAppConnectUri, sealAppConnectPayload } from '../packages/core/dist/vendor/app-connect/index.js';

const NETWORKS = { testnet: 'testnet', mainnet: 'mainnet' };

function keyOf(record, level) {
  const found = record.identityKeys.find((key) => key.purpose === 'AUTHENTICATION' && key.securityLevel === level);
  if (!found) throw new Error(`the identity file has no ${level} authentication key`);
  return found;
}

/** Approves `uri` as the identity in `identityFile`. Returns what was granted. */
export async function approve({ identityFile, uri, budget, expiresAt, now = Date.now() }) {
  const record = JSON.parse(readFileSync(identityFile, 'utf8'));
  const { request, network } = parseAppConnectUri(uri);
  if (!NETWORKS[network] || record.network !== network) throw new Error(`the request is for ${network}, the identity is on ${record.network}`);
  const age = checkAppConnectRequestAge(request.createdAt, now);
  if (age !== null) throw new Error(`the request is ${age}`);
  const [binding, ...more] = request.authBindings;
  if (!binding || more.length > 0 || request.encBindings.length > 0) throw new Error('this wallet grants exactly one key');
  if (binding.kind !== 'singleContract' || base58.encode(binding.id) !== base58.encode(request.appId)) throw new Error('the key must be bound to the app contract');
  if (request.identityHint && base58.encode(request.identityHint) !== record.identityId) throw new Error('the request names another identity');

  const sdk = await connectSdk({ network, contractId: '' });
  const identity = await sdk.identities.fetch(record.identityId);
  const keyId = Math.max(...identity.publicKeys.map((key) => key.keyId)) + 1;
  const secret = secp.utils.randomSecretKey();
  const granted = { budget: budget ?? binding.totalBudget, expiresAt: expiresAt ?? binding.expiresAt };
  const added = new IdentityPublicKeyInCreation({
    keyId,
    purpose: 'authentication',
    securityLevel: 'high',
    keyType: 'ecdsa_hash160',
    data: ripemd160(sha256(secp.getPublicKey(secret, true))),
    contractBounds: ContractBounds.SingleContract(base58.encode(binding.id)),
    totalBudget: granted.budget,
    expiresAt: BigInt(granted.expiresAt),
  });
  const master = new IdentitySigner();
  master.addKey(PrivateKey.fromWIF(keyOf(record, 'MASTER').privateKeyWif));
  master.addKey(PrivateKey.fromBytes(secret, network));
  await sdk.identities.update({ identity, addPublicKeys: [added], signer: master });

  const sealed = await sealAppConnectPayload({ appEphemeralPubKey: request.appEphemeralPubKey, ownerId: base58.decode(record.identityId), slots: [secret] });
  const high = keyOf(record, 'HIGH');
  const identityKey = new IdentityPublicKey({ keyId: high.id, purpose: high.purpose, securityLevel: high.securityLevel, keyType: high.keyType, isReadOnly: false, data: Buffer.from(high.publicKeyHex, 'hex') });
  const signer = new IdentitySigner();
  signer.addKey(PrivateKey.fromWIF(high.privateKeyWif));
  const base = new Document({ properties: {}, documentTypeName: 'loginKeyResponse', dataContractId: APP_CONNECT_CONTRACT_ID, ownerId: record.identityId });
  const document = Document.fromObject(
    { ...base.toObject(), appEphemeralPubKeyHash: appConnectRequestHash(request), walletEphemeralPubKey: sealed.walletEphemeralPubKey, encryptedPayload: sealed.encryptedPayload },
    sdk.wasm.version(),
  );
  await sdk.documents.create({ document, identityKey, signer });
  return { identityId: record.identityId, keyId, label: request.label, ...granted };
}

/** Disables keys this wallet added, so a test leaves nothing live behind. */
export async function revoke({ identityFile, keyIds }) {
  const record = JSON.parse(readFileSync(identityFile, 'utf8'));
  const sdk = await connectSdk({ network: record.network, contractId: '' });
  const identity = await sdk.identities.fetch(record.identityId);
  const live = identity.publicKeys.filter((key) => keyIds.includes(key.keyId) && key.disabledAt === undefined).map((key) => key.keyId);
  if (live.length === 0) return [];
  const master = new IdentitySigner();
  master.addKey(PrivateKey.fromWIF(keyOf(record, 'MASTER').privateKeyWif));
  await sdk.identities.update({ identity, disablePublicKeys: live, signer: master });
  return live;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [identityFile, uri] = process.argv.slice(2);
  if (!identityFile || !uri) throw new Error("usage: wallet-responder.mjs <identity.json> '<dashpay://connect?...>'");
  const granted = await approve({ identityFile, uri });
  console.log(`approved "${granted.label}" as ${granted.identityId}: key ${granted.keyId}, budget ${granted.budget} credits, until ${new Date(granted.expiresAt).toISOString()}`);
  process.exit(0);
}
