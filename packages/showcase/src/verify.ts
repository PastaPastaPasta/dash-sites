import { loadManifest, networkConfig, readFile, resolveName, sha256Hex, type Network } from '@dash-sites/core';
import { EvoReader } from '@dash-sites/core/evo';

export type Report = (ok: boolean, text: string) => void;

/**
 * Checks the site this page belongs to without trusting the gateway that served it: proves the
 * name and the site record against Dash Platform, reads every file from Platform, and compares
 * each one with what the gateway serves.
 */
export async function verify(label: string, network: Network, report: Report): Promise<boolean> {
  const reader = await EvoReader.connect(networkConfig(network));
  report(true, `Connected to Dash Platform ${network} from this browser`);
  const resolution = await resolveName(reader, label);
  if (resolution.status !== 'ok' || resolution.content.scheme !== 'dash-manifest') {
    report(false, `Platform has no stored site for ${label}.dash (${resolution.status})`);
    return false;
  }
  report(true, `Proved at block ${resolution.meta.height}: ${resolution.canonicalLabel}.dash belongs to ${resolution.ownerId}`);
  report(true, `Proved: that identity's site record, revision ${resolution.site.revision}`);
  const source = (hashes: string[]) => reader.getChunks(resolution.ownerId, hashes);
  const manifest = await loadManifest(resolution.content, source);
  const paths = Object.keys(manifest.files).sort();
  report(true, `Manifest matches the hash in the record and lists ${paths.length} files`);
  let good = 0;
  for (const path of paths) {
    const published = (await readFile(manifest, path, source)).file.sha256;
    const response = await fetch(path, { cache: 'no-store' });
    const served = sha256Hex(new Uint8Array(await response.arrayBuffer()));
    if (response.ok && served === published) good++;
    else report(false, `${path}: the gateway served different bytes than the owner published`);
  }
  if (good === paths.length) report(true, `All ${good} files read from Platform match what this gateway served, byte for byte`);
  return good === paths.length;
}
