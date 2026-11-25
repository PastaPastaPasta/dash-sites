// Confirms that the npm mirrors and the npm registry all hold the module the shell pins by hash.
// Run after changing IPFS_MODULE in packages/core/src/ipfs.ts:  npx tsc -b && node scripts/check-pins.mjs
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { IPFS_MODULE, moduleUrls } from '../packages/core/dist/index.js';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const get = async (url) => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
};

/** The one file of a package tarball, read without unpacking the rest. */
function fromTarball(tarball, file) {
  const tar = gunzipSync(tarball);
  for (let offset = 0; offset + 512 <= tar.length; ) {
    const name = tar.subarray(offset, offset + 100).toString().replace(/\0.*$/, '');
    const prefix = tar.subarray(offset + 345, offset + 500).toString().replace(/\0.*$/, '');
    const size = parseInt(tar.subarray(offset + 124, offset + 136).toString().trim() || '0', 8);
    if ((prefix ? `${prefix}/${name}` : name) === `package/${file}`) return tar.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  throw new Error(`${file} is not in the tarball`);
}

let failed = false;
const report = (where, bytes) => {
  const ok = bytes.length === IPFS_MODULE.size && sha256(bytes) === IPFS_MODULE.sha256;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${where}  ${bytes.length} bytes  ${sha256(bytes)}`);
  failed ||= !ok;
};
for (const url of moduleUrls(IPFS_MODULE)) report(url, await get(url));
const meta = JSON.parse((await get(`https://registry.npmjs.org/${IPFS_MODULE.package}/${IPFS_MODULE.version}`)).toString());
report(meta.dist.tarball, fromTarball(await get(meta.dist.tarball), IPFS_MODULE.file));
console.log(`     ${IPFS_MODULE.package} ${IPFS_MODULE.version}, license ${meta.license}`);
process.exit(failed ? 1 : 0);
