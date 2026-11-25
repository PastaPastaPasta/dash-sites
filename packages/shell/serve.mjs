import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, constants } from 'node:zlib';

const dist = join(dirname(fileURLToPath(import.meta.url)), 'dist');
const port = Number(process.argv[2] ?? 8080);
if (!existsSync(join(dist, 'sw.js'))) throw new Error('build the shell first: npm run build -w @dash-sites/shell');
const scripts = new Set(readdirSync(dist).filter((file) => /\.(js|br)$/.test(file)));
const cache = new Map();

function load(file) {
  let entry = cache.get(file);
  if (!entry) {
    const raw = readFileSync(join(dist, file));
    const br = file.endsWith('.js') ? brotliCompressSync(raw, { params: { [constants.BROTLI_PARAM_QUALITY]: 6 } }) : undefined;
    entry = { raw, br };
    cache.set(file, entry);
  }
  return entry;
}

createServer((req, res) => {
  const name = (req.url ?? '/').split('?')[0].slice(1);
  const file = scripts.has(name) ? name : 'index.html';
  const entry = load(file);
  const useBr = entry.br && String(req.headers['accept-encoding'] ?? '').includes('br');
  const body = useBr ? entry.br : entry.raw;
  const headers = {
    'Content-Type': file === 'index.html' ? 'text/html; charset=utf-8' : file.endsWith('.br') ? 'application/octet-stream' : 'text/javascript; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': file.startsWith('dash-sites-verifier-') ? 'public, max-age=31536000, immutable' : file === 'sw.js' ? 'no-cache' : 'no-cache, no-transform',
    'X-Content-Type-Options': 'nosniff',
    ...(entry.br ? { Vary: 'Accept-Encoding' } : {}),
    ...(useBr ? { 'Content-Encoding': 'br' } : {}),
  };
  res.writeHead(200, headers);
  res.end(body);
}).listen(port, '127.0.0.1', () => console.log(`shell on http://<name>.localhost:${port}/`));
