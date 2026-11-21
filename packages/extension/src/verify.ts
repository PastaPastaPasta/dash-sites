import { decide, loadManifest, networkConfig, readFile, resolveName, type Resolution } from '@dash-sites/core';
import { EvoReader } from '@dash-sites/core/evo';

let reader: Promise<EvoReader> | undefined;

function connect(network: 'testnet' | 'mainnet'): Promise<EvoReader> {
  reader ??= EvoReader.connect(networkConfig(network));
  return reader;
}

/** Resolves a name against Dash Platform, with proofs, without asking the gateway. */
export async function resolve(label: string, network: 'testnet' | 'mainnet'): Promise<Resolution> {
  return resolveName(await connect(network), label);
}

export type Audit = { ok: true; path: string; sha256: string } | { ok: false; reason: string };

/** Checks the SHA-256 of what the page was served for `pathname` against the file the owner published. */
export async function auditFile(resolution: Resolution, pathname: string, servedSha256: string, network: 'testnet' | 'mainnet'): Promise<Audit> {
  if (resolution.status !== 'ok' || resolution.content.scheme !== 'dash-manifest') return { ok: false, reason: 'This site is not stored on Dash Platform.' };
  const source = async (hashes: string[]) => (await connect(network)).getChunks(resolution.ownerId, hashes);
  const manifest = await loadManifest(resolution.content, source);
  const decision = decide(manifest, pathname);
  if (decision.kind !== 'file') return { ok: false, reason: 'The published site has no file at this address.' };
  const expected = (await readFile(manifest, decision.path, source)).file.sha256;
  if (servedSha256 !== expected) return { ok: false, reason: `This page was served different bytes for ${decision.path} than the owner published.` };
  return { ok: true, path: decision.path, sha256: expected };
}
