#!/usr/bin/env node
/**
 * Create or top up a Dash Platform identity from L1 DASH via a plain address or BIP21 QR code.
 *
 * Uses only dependencies already installed in the dash-sites repository:
 * @dashevo/evo-sdk, @noble/hashes, @noble/secp256k1, @scure/base, qr.
 *
 * Subcommands:
 *   init      Generate keys, save a 0600 state file, and show the funding address and/or QR code.
 *   qr        Re-display the funding address and/or QR code for an existing state file.
 *   status    Check deposit UTXOs, asset-lock confirmation, and Platform chain-lock height.
 *   complete  Authenticate deposit UTXOs, broadcast the asset-lock tx, wait for ChainLock,
 *             and create (or top up) the Dash Platform identity. Safe to re-run to resume.
 */
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { AssetLockProof, EvoSDK, Identity, IdentityPublicKey, IdentitySigner, OutPoint, PrivateKey } from '@dashevo/evo-sdk';
import { ripemd160 } from '@noble/hashes/legacy.js';
import { sha256 } from '@noble/hashes/sha2.js';
import * as secp from '@noble/secp256k1';
import { base58 } from '@scure/base';
import encodeQR from 'qr';

const TX_VERSION = 3;
const TX_TYPE_ASSET_LOCK = 8;
const SIGHASH_ALL = 0x01;
const MIN_RELAY_FEE_PER_BYTE = 1n;
const MAX_P2PKH_INPUT_SIZE = 148n;
const ASSET_LOCK_BASE_SIZE = 58n;
const MAX_COMPACT_SIZE = 0x02000000;
const MAX_MONEY = 21_000_000n * 100_000_000n;
const DUFFS_PER_DASH = 100_000_000n;
const CREDITS_PER_DASH = 100_000_000_000n;

export const MAX_ASSET_LOCK_INPUTS = 60;
export const MAX_ASSET_LOCK_FEE = 10_000n;
export const MIN_LOCK_DUFFS = 100_000n; // 0.001 DASH

export const NETWORKS = {
  mainnet: {
    network: 'mainnet',
    insightApiUrl: 'https://insight.dash.org/insight-api',
    addressPrefix: 76,
    wifPrefix: 204,
    minFee: 1000n,
  },
  testnet: {
    network: 'testnet',
    insightApiUrl: 'https://insight.testnet.networks.dash.org/insight-api',
    addressPrefix: 140,
    wifPrefix: 239,
    minFee: 1000n,
  },
};

const USAGE = `fund-identity: create or top up a Dash Platform identity from L1 DASH

  node fund-identity.mjs init [--network testnet|mainnet] [--amount <DASH>] [--format address|qr|both]
                              [--qr <file.svg>] [--identity <id>] --state <state.json>
  node fund-identity.mjs qr --state <state.json> [--format address|qr|both] [--qr <file.svg>]
  node fund-identity.mjs status --state <state.json>
  node fund-identity.mjs complete --state <state.json> [--out <identity.json>] [--wait <seconds>] [--no-wait]

Options
  --network testnet|mainnet   Dash network (default: testnet)
  --amount <DASH>             Suggested payment amount for the BIP21 URI / QR code (e.g. 0.05)
  --format address|qr|both    How to present the payment request to the user (default: both)
  --qr <file.svg>             Also write the BIP21 QR code as an SVG file
  --identity <id>             Top up an existing Platform identity instead of creating a new one
  --state <file>              Private 0600 state file for crash-safe resume (default: ./dash-funding.<network>.json)
  --out <file>                Where to write identity.json in create mode (default: ./identity.<network>.json)
  --wait <seconds>            Max seconds to wait for deposit / confirmation / ChainLock (default: 900)
  --no-wait                   Check once and exit without polling
  -h, --help                  Show this help
`;

export function concatBytes(...arrays) {
  const total = arrays.reduce((sum, a) => sum + a.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
}

export function hexToBytes(hex) {
  if (typeof hex !== 'string' || hex.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(hex)) {
    throw new Error('Invalid hex string');
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function bytesToHex(bytes) {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

export function reverseBytes(bytes) {
  const out = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) out[i] = bytes[bytes.length - 1 - i];
  return out;
}

export function hash256(bytes) {
  return sha256(sha256(bytes));
}

export function hash160(bytes) {
  return ripemd160(sha256(bytes));
}

export function base58CheckEncode(payload) {
  const checksum = hash256(payload).subarray(0, 4);
  return base58.encode(concatBytes(payload, checksum));
}

export function privateKeyToWif(privKey, wifPrefix) {
  if (privKey.length !== 32) throw new Error('Private key must be 32 bytes');
  return base58CheckEncode(concatBytes(new Uint8Array([wifPrefix]), privKey, new Uint8Array([0x01])));
}

export function publicKeyToAddress(pubKey, addressPrefix) {
  return base58CheckEncode(concatBytes(new Uint8Array([addressPrefix]), hash160(pubKey)));
}

export function generateKeyPair(net) {
  const privKey = secp.utils.randomSecretKey();
  const pubKey = secp.getPublicKey(privKey, true);
  return {
    privateKeyHex: bytesToHex(privKey),
    privateKeyWif: privateKeyToWif(privKey, net.wifPrefix),
    publicKeyHex: bytesToHex(pubKey),
    address: publicKeyToAddress(pubKey, net.addressPrefix),
  };
}

export function buildBip21Uri(address, amountDash) {
  if (amountDash === undefined || amountDash === '') return `dash:${address}`;
  const trimmed = String(amountDash).trim();
  if (!/^\d+(?:\.\d{1,8})?$/.test(trimmed) || Number(trimmed) <= 0) {
    throw new Error(`Invalid --amount "${amountDash}": use a positive DASH amount with up to 8 decimals (e.g. 0.05)`);
  }
  return `dash:${address}?amount=${trimmed}`;
}

export function qrTerminal(uri, { color = false } = {}) {
  const ascii = encodeQR(uri, 'ascii', { ecc: 'low', border: 2 }).trimEnd();
  if (!color) return ascii;
  return ascii
    .split('\n')
    .map((line) => `\x1b[38;5;231;48;5;16m${line}\x1b[0m`)
    .join('\n');
}

export function qrSvg(uri) {
  const svg = encodeQR(uri, 'svg', { ecc: 'low', border: 4 });
  return `${svg.replace('>', ' shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/>')}\n`;
}

export function formatDashFromDuffs(duffs) {
  const value = BigInt(duffs);
  const whole = value / DUFFS_PER_DASH;
  const frac = (value % DUFFS_PER_DASH).toString().padStart(8, '0').replace(/0+$/, '') || '0';
  return `${whole}.${frac} DASH`;
}

export function formatDashFromCredits(credits) {
  const value = BigInt(credits);
  const whole = value / CREDITS_PER_DASH;
  const frac = (value % CREDITS_PER_DASH).toString().padStart(11, '0').slice(0, 5);
  return `${whole}.${frac} DASH`;
}

function serCompactSize(n) {
  if (n < 253) return new Uint8Array([n]);
  if (n <= 0xffff) {
    const out = new Uint8Array(3);
    out[0] = 253;
    new DataView(out.buffer).setUint16(1, n, true);
    return out;
  }
  const out = new Uint8Array(5);
  out[0] = 254;
  new DataView(out.buffer).setUint32(1, n, true);
  return out;
}

function serVarBytes(bytes) {
  return concatBytes(serCompactSize(bytes.length), bytes);
}

function serInt32(n) {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setInt32(0, n, true);
  return out;
}

function serUint32(n) {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n, true);
  return out;
}

function serInt64(n) {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigInt64(0, BigInt(n), true);
  return out;
}

export function createP2PKHScript(pubKeyHash) {
  if (pubKeyHash.length !== 20) throw new Error('Public key hash must be 20 bytes');
  return new Uint8Array([0x76, 0xa9, 0x14, ...pubKeyHash, 0x88, 0xac]);
}

export function createOpReturnScript() {
  return new Uint8Array([0x6a, 0x00]);
}

export function serializeTransaction(tx) {
  const parts = [];
  parts.push(serInt32(tx.version | (tx.txType << 16)));
  parts.push(serCompactSize(tx.vin.length));
  for (const input of tx.vin) {
    parts.push(input.prevout.txid, serUint32(input.prevout.n), serVarBytes(input.scriptSig), serUint32(input.sequence));
  }
  parts.push(serCompactSize(tx.vout.length));
  for (const output of tx.vout) {
    parts.push(serInt64(output.value), serVarBytes(output.scriptPubKey));
  }
  parts.push(serUint32(tx.lockTime));
  if (tx.txType !== 0 && tx.extraPayload.length > 0) {
    parts.push(serVarBytes(tx.extraPayload));
  }
  return concatBytes(...parts);
}

export function txidOfRawTransaction(raw) {
  return bytesToHex(reverseBytes(hash256(raw)));
}

export function parseTransaction(raw) {
  let offset = 0;
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const advance = (n) => {
    if (offset + n > raw.length) throw new Error('Raw transaction is truncated');
    const start = offset;
    offset += n;
    return start;
  };
  const uint8 = () => view.getUint8(advance(1));
  const uint16 = () => view.getUint16(advance(2), true);
  const uint32 = () => view.getUint32(advance(4), true);
  const int64 = () => view.getBigInt64(advance(8), true);
  const compactSize = () => {
    const first = uint8();
    if (first < 253) return first;
    let n;
    let min;
    if (first === 253) {
      n = uint16();
      min = 253;
    } else if (first === 254) {
      n = uint32();
      min = 0x10000;
    } else {
      throw new Error('Raw transaction has an oversized length prefix');
    }
    if (n < min || n > MAX_COMPACT_SIZE) throw new Error('Raw transaction has an invalid length prefix');
    return n;
  };
  const varBytes = () => {
    const len = compactSize();
    const start = advance(len);
    return raw.slice(start, start + len);
  };

  const versionField = uint32();
  const version = (versionField << 16) >> 16;
  const txType = versionField >>> 16;
  const inputCount = compactSize();
  for (let i = 0; i < inputCount; i++) {
    advance(36);
    varBytes();
    advance(4);
  }
  const outputCount = compactSize();
  const outputs = [];
  for (let i = 0; i < outputCount; i++) {
    const value = int64();
    if (value < 0n || value > MAX_MONEY) throw new Error(`Raw transaction output ${i} out of range`);
    outputs.push({ value, scriptPubKey: varBytes() });
  }
  const lockTime = uint32();
  if (version >= TX_VERSION && txType !== 0) varBytes();
  if (offset !== raw.length) throw new Error('Raw transaction has trailing bytes');
  return { version, txType, inputCount, outputs, lockTime };
}

export function authenticateUtxo(utxo, rawTx, depositPublicKey) {
  if (typeof utxo.txid !== 'string' || !/^[0-9a-f]{64}$/i.test(utxo.txid)) {
    throw new Error('Explorer returned a malformed deposit txid');
  }
  const txid = utxo.txid.toLowerCase();
  if (!Number.isSafeInteger(utxo.vout) || utxo.vout < 0) {
    throw new Error('Explorer returned a malformed deposit output index');
  }
  if (txidOfRawTransaction(rawTx) !== txid) {
    throw new Error(`Raw transaction from explorer does not match txid ${txid}`);
  }
  const { outputs } = parseTransaction(rawTx);
  const output = outputs[utxo.vout];
  if (!output) throw new Error(`Deposit tx ${txid} has no output ${utxo.vout}`);
  const expectedScript = bytesToHex(createP2PKHScript(hash160(depositPublicKey)));
  const scriptPubKey = bytesToHex(output.scriptPubKey);
  if (scriptPubKey !== expectedScript) {
    throw new Error(`Deposit output ${txid}:${utxo.vout} does not pay this funding address`);
  }
  const satoshis = Number(output.value);
  if (utxo.satoshis !== satoshis) {
    throw new Error(`Explorer reported ${utxo.satoshis} duffs for ${txid}:${utxo.vout}, but raw tx commits to ${satoshis}`);
  }
  if (typeof utxo.scriptPubKey !== 'string' || utxo.scriptPubKey.toLowerCase() !== scriptPubKey) {
    throw new Error(`Explorer scriptPubKey disagrees with raw tx for ${txid}:${utxo.vout}`);
  }
  return { ...utxo, txid, satoshis, scriptPubKey };
}

export function assetLockFee(inputCount, minFee = 1000n) {
  const size = ASSET_LOCK_BASE_SIZE + BigInt(inputCount) * MAX_P2PKH_INPUT_SIZE;
  const relayFee = size * MIN_RELAY_FEE_PER_BYTE;
  return relayFee > minFee ? relayFee : minFee;
}

export function selectDepositUtxos(utxos) {
  const unique = new Map();
  for (const u of utxos) {
    const key = `${String(u.txid).toLowerCase()}:${u.vout}`;
    if (!unique.has(key)) unique.set(key, u);
  }
  return [...unique.values()].sort((a, b) => b.satoshis - a.satoshis).slice(0, MAX_ASSET_LOCK_INPUTS);
}

export function createAssetLockTransaction(utxos, assetLockPubKey, minFee = 1000n) {
  if (minFee <= 0n || minFee > MAX_ASSET_LOCK_FEE) {
    throw new Error(`Asset lock fee ${minFee} outside (0, ${MAX_ASSET_LOCK_FEE}]`);
  }
  if (utxos.length === 0 || utxos.length > MAX_ASSET_LOCK_INPUTS) {
    throw new Error(`An asset lock spends 1 to ${MAX_ASSET_LOCK_INPUTS} UTXOs, got ${utxos.length}`);
  }
  const seen = new Set();
  for (const u of utxos) {
    if (!Number.isSafeInteger(u.satoshis) || u.satoshis <= 0) throw new Error('Invalid UTXO satoshis');
    const key = `${String(u.txid).toLowerCase()}:${u.vout}`;
    if (seen.has(key)) throw new Error(`Duplicate UTXO ${key}`);
    seen.add(key);
  }
  const fee = assetLockFee(utxos.length, minFee);
  const totalIn = utxos.reduce((sum, u) => sum + BigInt(u.satoshis), 0n);
  const lockAmount = totalIn - fee;
  if (lockAmount < MIN_LOCK_DUFFS) {
    throw new Error(`Deposit too small (${formatDashFromDuffs(totalIn)}); send at least ${formatDashFromDuffs(MIN_LOCK_DUFFS + fee)}`);
  }

  const vin = utxos.map((u) => ({
    prevout: { txid: reverseBytes(hexToBytes(u.txid)), n: u.vout },
    scriptSig: new Uint8Array(0),
    sequence: 0xffffffff,
  }));
  const vout = [{ value: lockAmount, scriptPubKey: createOpReturnScript() }];
  const creditOutput = { value: lockAmount, scriptPubKey: createP2PKHScript(hash160(assetLockPubKey)) };
  const extraPayload = concatBytes(
    new Uint8Array([1]),
    serCompactSize(1),
    serInt64(creditOutput.value),
    serVarBytes(creditOutput.scriptPubKey),
  );
  return { version: TX_VERSION, txType: TX_TYPE_ASSET_LOCK, vin, vout, lockTime: 0, extraPayload };
}

function derEncodeInt(bytes) {
  let i = 0;
  while (i < bytes.length - 1 && bytes[i] === 0) i++;
  const trimmed = bytes.subarray(i);
  const needsZero = trimmed[0] >= 0x80;
  const out = new Uint8Array(2 + trimmed.length + (needsZero ? 1 : 0));
  out[0] = 0x02;
  out[1] = trimmed.length + (needsZero ? 1 : 0);
  if (needsZero) {
    out[2] = 0x00;
    out.set(trimmed, 3);
  } else {
    out.set(trimmed, 2);
  }
  return out;
}

export function compactSigToDer(compact64) {
  if (compact64.length !== 64) throw new Error('Expected 64-byte compact signature');
  const r = derEncodeInt(compact64.subarray(0, 32));
  const s = derEncodeInt(compact64.subarray(32, 64));
  return concatBytes(new Uint8Array([0x30, r.length + s.length]), r, s);
}

export function signatureHash(tx, inputIndex, scriptCode) {
  const copy = {
    ...tx,
    vin: tx.vin.map((input, i) => ({
      prevout: { txid: new Uint8Array(input.prevout.txid), n: input.prevout.n },
      scriptSig: i === inputIndex ? scriptCode : new Uint8Array(0),
      sequence: input.sequence,
    })),
    vout: tx.vout.map((o) => ({ value: o.value, scriptPubKey: new Uint8Array(o.scriptPubKey) })),
    extraPayload: new Uint8Array(tx.extraPayload),
  };
  return hash256(concatBytes(serializeTransaction(copy), serUint32(SIGHASH_ALL)));
}

export async function signAssetLockTransaction(tx, utxos, fundingPrivKey, fundingPubKey) {
  if (utxos.length !== tx.vin.length) throw new Error('UTXO count does not match transaction inputs');
  const totalIn = utxos.reduce((sum, u) => sum + BigInt(u.satoshis), 0n);
  const totalOut = tx.vout.reduce((sum, o) => sum + o.value, 0n);
  const fee = totalIn - totalOut;
  if (fee <= 0n || fee > MAX_ASSET_LOCK_FEE) {
    throw new Error(`Refusing to sign: implicit fee ${fee} duffs outside (0, ${MAX_ASSET_LOCK_FEE}]`);
  }

  const signedVin = [];
  for (let i = 0; i < tx.vin.length; i++) {
    const prevTxid = bytesToHex(reverseBytes(tx.vin[i].prevout.txid));
    if (prevTxid !== utxos[i].txid.toLowerCase() || tx.vin[i].prevout.n !== utxos[i].vout) {
      throw new Error(`UTXO ${i} does not match transaction input`);
    }
    const sighash = signatureHash(tx, i, hexToBytes(utxos[i].scriptPubKey));
    const compact = await secp.signAsync(sighash, fundingPrivKey, { prehash: false, lowS: true });
    if (!(await secp.verifyAsync(compact, sighash, fundingPubKey, { prehash: false, lowS: true }))) {
      throw new Error('Self-verification of signed asset lock input failed');
    }
    const derWithHashType = concatBytes(compactSigToDer(compact), new Uint8Array([SIGHASH_ALL]));
    const scriptSig = concatBytes(
      new Uint8Array([derWithHashType.length]),
      derWithHashType,
      new Uint8Array([fundingPubKey.length]),
      fundingPubKey,
    );
    signedVin.push({ ...tx.vin[i], scriptSig });
  }
  return { ...tx, vin: signedVin };
}

export function defaultIdentityKeys(net) {
  const specs = [
    { id: 0, purpose: 'AUTHENTICATION', securityLevel: 'MASTER', keyType: 'ECDSA_SECP256K1' },
    { id: 1, purpose: 'AUTHENTICATION', securityLevel: 'CRITICAL', keyType: 'ECDSA_SECP256K1' },
    { id: 2, purpose: 'AUTHENTICATION', securityLevel: 'HIGH', keyType: 'ECDSA_SECP256K1' },
    { id: 3, purpose: 'TRANSFER', securityLevel: 'CRITICAL', keyType: 'ECDSA_SECP256K1' },
  ];
  return specs.map((spec) => {
    const kp = generateKeyPair(net);
    return { ...spec, privateKeyWif: kp.privateKeyWif, publicKeyHex: kp.publicKeyHex };
  });
}

function writePrivateAtomic(filePath, content) {
  mkdirSync(dirname(resolve(filePath)), { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.tmp.${process.pid}.${randomBytes(4).toString('hex')}`;
  writeFileSync(tmp, content, { mode: 0o600, flag: 'wx' });
  try {
    try {
      chmodSync(tmp, 0o600);
    } catch {
      // Non-POSIX filesystems may ignore chmod.
    }
    renameSync(tmp, filePath);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      // Best-effort cleanup.
    }
    throw error;
  }
}

function writePrivateJson(filePath, value) {
  writePrivateAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function fetchJson(url, init) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(20_000) });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}: ${text.slice(0, 300)}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Non-JSON response from ${url}: ${text.slice(0, 200)}`);
  }
}

async function insightUtxos(net, address) {
  const data = await fetchJson(`${net.insightApiUrl}/addr/${address}/utxo`);
  if (!Array.isArray(data)) throw new Error('Unexpected Insight UTXO response');
  return data;
}

async function insightRawTx(net, txid) {
  const data = await fetchJson(`${net.insightApiUrl}/rawtx/${txid}`);
  if (typeof data?.rawtx !== 'string') throw new Error(`Insight /rawtx/${txid} missing rawtx`);
  return hexToBytes(data.rawtx);
}

async function insightTx(net, txid) {
  try {
    return await fetchJson(`${net.insightApiUrl}/tx/${txid}`);
  } catch (error) {
    if (String(error).includes('HTTP 404')) return undefined;
    throw error;
  }
}

async function insightBroadcast(net, rawTxHex) {
  try {
    const res = await fetchJson(`${net.insightApiUrl}/tx/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rawtx: rawTxHex }),
    });
    return res.txid;
  } catch (error) {
    const msg = String(error?.message ?? error);
    if (/already in block chain|txn-already-known|Transaction already in block/i.test(msg)) return undefined;
    throw error;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function displayPaymentRequest(state, { format, qrPath }) {
  const uri = buildBip21Uri(state.funding.address, state.suggestedAmountDash);
  const useColor = Boolean(process.stderr.isTTY && !process.env.NO_COLOR);
  const showAddress = format === 'address' || format === 'both';
  const showQr = format === 'qr' || format === 'both';

  console.error('');
  if (showAddress) {
    console.error(`Dash ${state.network} deposit address:`);
    console.error(`  ${state.funding.address}`);
    if (state.suggestedAmountDash) console.error(`Suggested amount: ${state.suggestedAmountDash} DASH`);
  }
  if (showQr) {
    console.error('');
    console.error(qrTerminal(uri, { color: useColor }));
    console.error('');
    console.error(`Payment URI: ${uri}`);
  }
  if (qrPath) {
    mkdirSync(dirname(resolve(qrPath)), { recursive: true });
    writeFileSync(qrPath, qrSvg(uri));
    console.error(`Wrote QR SVG to ${qrPath}`);
  }
  console.error('');
}

function getNetwork(name) {
  const net = NETWORKS[name];
  if (!net) throw new Error(`--network must be testnet or mainnet (got "${name}")`);
  return net;
}

export function isValidIdentityId(id) {
  if (typeof id !== 'string' || !id) return false;
  try {
    return base58.decode(id).length === 32;
  } catch {
    return false;
  }
}

async function cmdInit(values) {
  const net = getNetwork(values.network);
  const format = values.format;
  if (!['address', 'qr', 'both'].includes(format)) throw new Error('--format must be address, qr, or both');
  if (values.identity !== undefined && !isValidIdentityId(values.identity)) {
    throw new Error(`Invalid --identity "${values.identity}": expected a 32-byte base58 Platform identity ID`);
  }
  const statePath = values.state ?? `./dash-funding.${net.network}.json`;
  if (existsSync(statePath)) {
    throw new Error(`State file ${statePath} already exists. Refusing to overwrite existing keys; use "qr", "status", or "complete", or pass a different --state path.`);
  }
  if (values.amount !== undefined) buildBip21Uri('Xplaceholder', values.amount);

  const mode = values.identity ? 'topup' : 'create';
  const state = {
    v: 1,
    network: net.network,
    mode,
    createdAt: new Date().toISOString(),
    ...(values.identity ? { targetIdentityId: values.identity } : {}),
    ...(values.amount ? { suggestedAmountDash: String(values.amount).trim() } : {}),
    funding: generateKeyPair(net),
    assetLock: generateKeyPair(net),
    ...(mode === 'create' ? { identityKeys: defaultIdentityKeys(net) } : {}),
  };

  writePrivateJson(statePath, state);
  displayPaymentRequest(state, { format, qrPath: values.qr });

  const uri = buildBip21Uri(state.funding.address, state.suggestedAmountDash);
  console.log(
    JSON.stringify(
      {
        network: state.network,
        mode: state.mode,
        ...(state.targetIdentityId ? { targetIdentityId: state.targetIdentityId } : {}),
        address: state.funding.address,
        uri,
        ...(state.suggestedAmountDash ? { suggestedAmountDash: state.suggestedAmountDash } : {}),
        stateFile: resolve(statePath),
        ...(values.qr ? { qrSvgFile: resolve(values.qr) } : {}),
      },
      null,
      2,
    ),
  );
}

async function cmdQr(values) {
  if (!values.state) throw new Error('qr requires --state <state.json>');
  const format = values.format;
  if (!['address', 'qr', 'both'].includes(format)) throw new Error('--format must be address, qr, or both');
  const state = JSON.parse(readFileSync(values.state, 'utf8'));
  displayPaymentRequest(state, { format, qrPath: values.qr });
  console.log(
    JSON.stringify(
      {
        network: state.network,
        mode: state.mode,
        address: state.funding.address,
        uri: buildBip21Uri(state.funding.address, state.suggestedAmountDash),
        ...(values.qr ? { qrSvgFile: resolve(values.qr) } : {}),
      },
      null,
      2,
    ),
  );
}

async function cmdStatus(values) {
  if (!values.state) throw new Error('status requires --state <state.json>');
  const state = JSON.parse(readFileSync(values.state, 'utf8'));
  const net = getNetwork(state.network);
  const utxos = await insightUtxos(net, state.funding.address);
  const totalDuffs = utxos.reduce((sum, u) => sum + BigInt(u.satoshis), 0n);
  const out = {
    network: state.network,
    mode: state.mode,
    address: state.funding.address,
    utxoCount: utxos.length,
    depositBalance: formatDashFromDuffs(totalDuffs),
    assetLockTxid: state.assetLockTxid ?? null,
    assetLockBlockHeight: state.assetLockBlockHeight ?? null,
    identityId: state.identityId ?? state.targetIdentityId ?? null,
    completedAt: state.completedAt ?? null,
  };
  if (state.assetLockTxid) {
    const tx = await insightTx(net, state.assetLockTxid);
    out.assetLockConfirmations = tx?.confirmations ?? 0;
    if (tx?.blockheight > 0) out.assetLockBlockHeight = tx.blockheight;
  }
  console.log(JSON.stringify(out, null, 2));
}

async function cmdComplete(values) {
  if (!values.state) throw new Error('complete requires --state <state.json>');
  const statePath = values.state;
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  const net = getNetwork(state.network);
  const outPath = values.out ?? `./identity.${net.network}.json`;
  const waitSeconds = values['no-wait'] ? 0 : Number(values.wait);
  if (!Number.isFinite(waitSeconds) || waitSeconds < 0) throw new Error('--wait must be a non-negative number of seconds');
  const deadline = Date.now() + waitSeconds * 1000;

  if (state.completedAt) {
    console.error(`Already completed at ${state.completedAt}.`);
    console.log(
      JSON.stringify(
        {
          network: state.network,
          mode: state.mode,
          identityId: state.identityId ?? state.targetIdentityId,
          ...(state.mode === 'create' && existsSync(outPath) ? { identityFile: resolve(outPath) } : {}),
          completedAt: state.completedAt,
        },
        null,
        2,
      ),
    );
    return;
  }

  if (state.mode === 'create' && existsSync(outPath)) {
    let existingOut;
    try {
      existingOut = JSON.parse(readFileSync(outPath, 'utf8'));
    } catch {
      existingOut = null;
    }
    if (!existingOut || (state.identityId && existingOut.identityId !== state.identityId) || (!state.identityId && existingOut.identityId)) {
      throw new Error(`Output file ${outPath} already exists (identity ${existingOut?.identityId ?? 'unknown'}). Pass a different --out path so it is not overwritten.`);
    }
  }

  // Step 1: Wait for deposit and broadcast the asset-lock transaction (once).
  if (!state.assetLockTxid) {
    console.error(`Waiting for DASH deposit at ${state.funding.address} (${net.network})…`);
    let rawUtxos = [];
    for (;;) {
      rawUtxos = await insightUtxos(net, state.funding.address);
      if (rawUtxos.length > 0) break;
      if (Date.now() >= deadline) throw new Error(`No deposit received at ${state.funding.address} yet. Re-run complete once funded.`);
      await sleep(5000);
    }

    const selected = selectDepositUtxos(rawUtxos);
    const fundingPubKey = hexToBytes(state.funding.publicKeyHex);
    const fundingPrivKey = hexToBytes(state.funding.privateKeyHex);
    const assetLockPubKey = hexToBytes(state.assetLock.publicKeyHex);

    const authenticated = [];
    for (const utxo of selected) {
      const rawTx = await insightRawTx(net, utxo.txid);
      authenticated.push(authenticateUtxo(utxo, rawTx, fundingPubKey));
    }

    const unsigned = createAssetLockTransaction(authenticated, assetLockPubKey, net.minFee);
    const signed = await signAssetLockTransaction(unsigned, authenticated, fundingPrivKey, fundingPubKey);
    const rawSigned = serializeTransaction(signed);
    const txid = txidOfRawTransaction(rawSigned);

    state.assetLockTxid = txid;
    state.assetLockRawTxHex = bytesToHex(rawSigned);
    state.lockAmountDuffs = unsigned.vout[0].value.toString();
    writePrivateJson(statePath, state);
    console.error(`Signed asset-lock tx ${txid} (${formatDashFromDuffs(state.lockAmountDuffs)}); broadcasting…`);
  }

  if (!state.broadcastedAt) {
    const alreadySeen = await insightTx(net, state.assetLockTxid);
    if (!alreadySeen) await insightBroadcast(net, state.assetLockRawTxHex);
    state.broadcastedAt = new Date().toISOString();
    writePrivateJson(statePath, state);
    console.error(`Broadcast asset-lock tx ${state.assetLockTxid}. Waiting for 1 Core block (~2.5 min)…`);
  }

  // Step 2: Wait for 1 Core block confirmation.
  if (!state.assetLockBlockHeight) {
    for (;;) {
      const tx = await insightTx(net, state.assetLockTxid);
      if (tx && tx.confirmations >= 1 && tx.blockheight > 0) {
        state.assetLockBlockHeight = tx.blockheight;
        writePrivateJson(statePath, state);
        console.error(`Asset-lock tx confirmed in Core block ${tx.blockheight}.`);
        break;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Asset-lock tx ${state.assetLockTxid} is not confirmed in a block yet. Re-run complete in 2-3 minutes.`);
      }
      await sleep(10_000);
    }
  }

  // Step 3: Wait for Dash Platform to ChainLock that Core block height.
  console.error(`Connecting to Dash Platform (${net.network}) and waiting for coreChainLockedHeight >= ${state.assetLockBlockHeight}…`);
  const sdk = new EvoSDK({ network: net.network, trusted: true, settings: { connectTimeoutMs: 10_000, timeoutMs: 30_000, retries: 4 } });
  await sdk.connect();

  let chainLockedHeight = 0;
  for (;;) {
    const { metadata } = await sdk.protocol.versionUpgradeStateWithProof();
    chainLockedHeight = Number(metadata.coreChainLockedHeight);
    if (chainLockedHeight >= state.assetLockBlockHeight) {
      console.error(`Platform coreChainLockedHeight reached ${chainLockedHeight}.`);
      break;
    }
    if (Date.now() >= deadline) {
      throw new Error(`Platform coreChainLockedHeight is ${chainLockedHeight}, waiting for ${state.assetLockBlockHeight}. Re-run complete shortly.`);
    }
    await sleep(10_000);
  }

  // Step 4: Create or top up the Platform identity using the Chain Asset Lock proof.
  const proof = AssetLockProof.createChainAssetLockProof(chainLockedHeight, new OutPoint(state.assetLockTxid, 0));
  const assetLockPrivateKey = PrivateKey.fromWIF(state.assetLock.privateKeyWif);

  if (state.mode === 'create') {
    const identityId = proof.createIdentityId().toString();
    const existing = await sdk.identities.fetch(identityId);
    if (!existing) {
      const identity = new Identity(identityId);
      const signer = new IdentitySigner();
      for (const k of state.identityKeys) {
        identity.addPublicKey(
          new IdentityPublicKey({
            keyId: k.id,
            purpose: k.purpose.toLowerCase(),
            securityLevel: k.securityLevel.toLowerCase(),
            keyType: k.keyType.toLowerCase(),
            isReadOnly: false,
            data: hexToBytes(k.publicKeyHex),
          }),
        );
        signer.addKeyFromWif(k.privateKeyWif);
      }
      console.error(`Registering Platform identity ${identityId}…`);
      await sdk.identities.create({ identity, assetLockProof: proof, assetLockPrivateKey, signer });
    } else {
      console.error(`Identity ${identityId} already exists on Platform.`);
    }

    const balance = BigInt((await sdk.identities.balance(identityId)) ?? 0n);
    const identityDoc = {
      network: state.network,
      identityId,
      createdAt: new Date().toISOString(),
      assetLockTxid: state.assetLockTxid,
      identityKeys: state.identityKeys,
    };
    writePrivateJson(outPath, identityDoc);
    state.identityId = identityId;
    state.completedAt = new Date().toISOString();
    writePrivateJson(statePath, state);

    console.log(
      JSON.stringify(
        {
          network: state.network,
          mode: 'create',
          identityId,
          balance: formatDashFromCredits(balance),
          assetLockTxid: state.assetLockTxid,
          identityFile: resolve(outPath),
        },
        null,
        2,
      ),
    );
    return;
  }

  // Top-up mode
  const identity = await sdk.identities.fetch(state.targetIdentityId);
  if (!identity) throw new Error(`Identity ${state.targetIdentityId} not found on ${state.network}`);
  console.error(`Topping up Platform identity ${state.targetIdentityId}…`);
  const newBalance = BigInt(await sdk.identities.topUp({ identity, assetLockProof: proof, assetLockPrivateKey }));
  state.completedAt = new Date().toISOString();
  writePrivateJson(statePath, state);

  console.log(
    JSON.stringify(
      {
        network: state.network,
        mode: 'topup',
        identityId: state.targetIdentityId,
        balance: formatDashFromCredits(newBalance),
        assetLockTxid: state.assetLockTxid,
      },
      null,
      2,
    ),
  );
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      network: { type: 'string', default: 'testnet' },
      amount: { type: 'string' },
      format: { type: 'string', default: 'both' },
      qr: { type: 'string' },
      identity: { type: 'string' },
      state: { type: 'string' },
      out: { type: 'string' },
      wait: { type: 'string', default: '900' },
      'no-wait': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  const cmd = positionals[0];
  if (values.help || !cmd) {
    console.log(USAGE);
    process.exit(values.help || !cmd ? 0 : 1);
  }
  const handlers = { init: cmdInit, qr: cmdQr, status: cmdStatus, complete: cmdComplete };
  const fn = handlers[cmd];
  if (!fn) {
    console.error(`fund-identity: unknown command "${cmd}"\n`);
    console.error(USAGE);
    process.exit(1);
  }
  await fn(values);
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(`fund-identity: ${error?.message ?? error}`);
    process.exit(1);
  });
}
