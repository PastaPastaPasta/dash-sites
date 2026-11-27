import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrivateKey, wallet } from '@dashevo/evo-sdk';
import { afterEach, describe, expect, it } from 'vitest';
import {
  NETWORKS,
  assetLockFee,
  authenticateUtxo,
  buildBip21Uri,
  bytesToHex,
  compactSigToDer,
  concatBytes,
  createAssetLockTransaction,
  createP2PKHScript,
  defaultIdentityKeys,
  generateKeyPair,
  hash160,
  hexToBytes,
  isValidIdentityId,
  parseTransaction,
  qrSvg,
  qrTerminal,
  selectDepositUtxos,
  serializeTransaction,
  signAssetLockTransaction,
  txidOfRawTransaction,
} from '../../../skills/dash-sites/scripts/fund-identity.mjs';

const SCRIPT_PATH = resolve(fileURLToPath(new URL('../../../skills/dash-sites/scripts/fund-identity.mjs', import.meta.url)));

function makeFundingRawTx(pubKeyHex: string, satoshis: bigint) {
  const scriptPubKey = createP2PKHScript(hash160(hexToBytes(pubKeyHex)));
  const tx = {
    version: 2,
    txType: 0,
    vin: [
      {
        prevout: { txid: new Uint8Array(32).fill(0x11), n: 0 },
        scriptSig: new Uint8Array([0x51]),
        sequence: 0xffffffff,
      },
    ],
    vout: [{ value: satoshis, scriptPubKey }],
    lockTime: 0,
    extraPayload: new Uint8Array(0),
  };
  const raw = serializeTransaction(tx);
  const txid = txidOfRawTransaction(raw);
  return {
    raw,
    utxo: {
      txid,
      vout: 0,
      satoshis: Number(satoshis),
      scriptPubKey: bytesToHex(scriptPubKey),
    },
  };
}

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe('fund-identity helpers', () => {
  it('generates valid mainnet and testnet keypairs accepted by evo-sdk', async () => {
    for (const net of [NETWORKS.mainnet, NETWORKS.testnet]) {
      const kp = generateKeyPair(net);
      expect(kp.address.startsWith(net.network === 'mainnet' ? 'X' : 'y')).toBe(true);
      expect(await wallet.validateAddress(kp.address, net.network)).toBe(true);
      const sdkPriv = PrivateKey.fromWIF(kp.privateKeyWif);
      const fromWif = await wallet.keyPairFromWif(sdkPriv.toWIF());
      expect(fromWif.publicKey.toLowerCase()).toBe(kp.publicKeyHex.toLowerCase());
      sdkPriv.free();
    }
  });

  it('builds and validates BIP21 payment URIs and QR codes', () => {
    expect(buildBip21Uri('Xabc123')).toBe('dash:Xabc123');
    expect(buildBip21Uri('Xabc123', '0.05')).toBe('dash:Xabc123?amount=0.05');
    expect(() => buildBip21Uri('Xabc123', '0')).toThrow();
    expect(() => buildBip21Uri('Xabc123', '-1')).toThrow();
    expect(() => buildBip21Uri('Xabc123', '0.123456789')).toThrow();
    expect(() => buildBip21Uri('Xabc123', 'abc')).toThrow();

    const ascii = qrTerminal('dash:Xabc123?amount=0.05');
    expect(ascii.split('\n').length).toBeGreaterThan(10);
    const svg = qrSvg('dash:Xabc123?amount=0.05');
    expect(svg).toContain('<svg');
    expect(svg).toContain('fill="#fff"');
  });

  it('authenticates honest UTXOs and rejects tampered explorer responses', () => {
    const funding = generateKeyPair(NETWORKS.testnet);
    const other = generateKeyPair(NETWORKS.testnet);
    const { raw, utxo } = makeFundingRawTx(funding.publicKeyHex, 5_000_000n);
    const pubKey = hexToBytes(funding.publicKeyHex);

    const auth = authenticateUtxo(utxo, raw, pubKey);
    expect(auth.satoshis).toBe(5_000_000);
    expect(auth.txid).toBe(utxo.txid);

    // Tampered amount (would drain difference as miner fee)
    expect(() => authenticateUtxo({ ...utxo, satoshis: 1_000_000 }, raw, pubKey)).toThrow(/commits to 5000000/);
    // Wrong key
    expect(() => authenticateUtxo(utxo, raw, hexToBytes(other.publicKeyHex))).toThrow(/does not pay/);
    // Mismatched txid
    expect(() => authenticateUtxo({ ...utxo, txid: 'aa'.repeat(32) }, raw, pubKey)).toThrow(/does not match txid/);
    // Trailing garbage
    expect(() => parseTransaction(concatBytes(raw, new Uint8Array([0x00])))).toThrow(/trailing bytes/);
  });

  it('builds, signs, and parses a valid v3 type-8 asset-lock transaction', async () => {
    const funding = generateKeyPair(NETWORKS.testnet);
    const assetLock = generateKeyPair(NETWORKS.testnet);
    const { raw, utxo } = makeFundingRawTx(funding.publicKeyHex, 10_000_000n);
    const auth = authenticateUtxo(utxo, raw, hexToBytes(funding.publicKeyHex));

    const unsigned = createAssetLockTransaction([auth], hexToBytes(assetLock.publicKeyHex), 1000n);
    const expectedFee = assetLockFee(1, 1000n);
    expect(expectedFee).toBe(1000n);
    expect(unsigned.vout[0].value).toBe(10_000_000n - expectedFee);

    const signed = await signAssetLockTransaction(unsigned, [auth], hexToBytes(funding.privateKeyHex), hexToBytes(funding.publicKeyHex));
    const serialized = serializeTransaction(signed);
    const parsed = parseTransaction(serialized);
    expect(parsed.version).toBe(3);
    expect(parsed.txType).toBe(8);
    expect(parsed.inputCount).toBe(1);
    expect(parsed.outputs).toHaveLength(1);
    expect(parsed.outputs[0].value).toBe(10_000_000n - expectedFee);
    expect(bytesToHex(parsed.outputs[0].scriptPubKey)).toBe('6a00');

    // Dust deposit rejected
    const dust = makeFundingRawTx(funding.publicKeyHex, 50_000n);
    const authDust = authenticateUtxo(dust.utxo, dust.raw, hexToBytes(funding.publicKeyHex));
    expect(() => createAssetLockTransaction([authDust], hexToBytes(assetLock.publicKeyHex), 1000n)).toThrow(/Deposit too small/);
  });

  it('produces valid DER signatures and default identity keys compatible with dash-sites', () => {
    const compact = new Uint8Array(64).fill(0x80);
    const der = compactSigToDer(compact);
    expect(der[0]).toBe(0x30);
    expect(der[2]).toBe(0x02);
    expect(der[3]).toBe(33); // leading 0x00 padded for high bit

    const keys = defaultIdentityKeys(NETWORKS.mainnet);
    expect(keys.map((k) => `${k.id}:${k.purpose}/${k.securityLevel}`)).toEqual([
      '0:AUTHENTICATION/MASTER',
      '1:AUTHENTICATION/CRITICAL',
      '2:AUTHENTICATION/HIGH',
      '3:TRANSFER/CRITICAL',
    ]);

    expect(isValidIdentityId('GCSi8NkjXyRpLC7FsEnCfx5ntmWZ16bD2t9zc4JiT4X3')).toBe(true);
    expect(isValidIdentityId('not-an-id')).toBe(false);

    const selected = selectDepositUtxos([
      { txid: 'aa'.repeat(32), vout: 0, satoshis: 1000 },
      { txid: 'aa'.repeat(32), vout: 0, satoshis: 1000 },
      { txid: 'bb'.repeat(32), vout: 1, satoshis: 5000 },
    ]);
    expect(selected).toHaveLength(2);
    expect(selected[0].satoshis).toBe(5000);
  });

  it('CLI init/qr writes 0600 state, respects format, and refuses overwrite', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dash-sites-fund-'));
    tempDirs.push(dir);
    const stateFile = join(dir, 'pending.json');
    const qrFile = join(dir, 'deposit.svg');

    const stdout = execFileSync(
      process.execPath,
      [SCRIPT_PATH, 'init', '--network', 'testnet', '--amount', '0.05', '--format', 'address', '--qr', qrFile, '--state', stateFile],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const info = JSON.parse(stdout);
    expect(info.network).toBe('testnet');
    expect(info.mode).toBe('create');
    expect(info.address.startsWith('y')).toBe(true);
    expect(info.uri).toBe(`dash:${info.address}?amount=0.05`);
    expect(readFileSync(qrFile, 'utf8')).toContain('<svg');
    expect(statSync(stateFile).mode & 0o777).toBe(0o600);

    // Refuses overwrite
    expect(() => execFileSync(process.execPath, [SCRIPT_PATH, 'init', '--network', 'testnet', '--state', stateFile], { stdio: 'pipe' })).toThrow();

    // qr subcommand re-displays without mutating
    const qrOut = JSON.parse(
      execFileSync(process.execPath, [SCRIPT_PATH, 'qr', '--state', stateFile, '--format', 'qr'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    );
    expect(qrOut.address).toBe(info.address);
    expect(qrOut.uri).toBe(info.uri);

    // Rejects invalid --identity in top-up mode
    expect(() =>
      execFileSync(process.execPath, [SCRIPT_PATH, 'init', '--network', 'testnet', '--identity', 'bad', '--state', join(dir, 'topup.json')], { stdio: 'pipe' }),
    ).toThrow();
  });
});
