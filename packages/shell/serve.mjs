import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = join(dirname(fileURLToPath(import.meta.url)), 'dist');
const port = Number(process.argv[2] ?? 8080);
if (!existsSync(join(dist, 'sw.js'))) throw new Error('build the shell first: npm run build -w @dash-sites/shell');
const scripts = new Set(readdirSync(dist).filter((file) => file.endsWith('.js')));

createServer((req, res) => {
  const name = (req.url ?? '/').split('?')[0].slice(1);
  const file = scripts.has(name) ? name : 'index.html';
  const path = join(dist, file);
  res.writeHead(200, {
    'Content-Type': file === 'index.html' ? 'text/html; charset=utf-8' : file.endsWith('.br') ? 'application/octet-stream' : 'text/javascript; charset=utf-8',
    'Content-Length': statSync(path).size,
    'Cache-Control': file.startsWith('dash-sites-verifier-') ? 'public, max-age=31536000, immutable' : 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  });
  createReadStream(path).pipe(res);
}).listen(port, '127.0.0.1', () => console.log(`shell on http://<name>.localhost:${port}/`));
