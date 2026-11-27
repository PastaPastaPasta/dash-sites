# Site Authoring Rules and Complete CLI Reference

## Complete `dash-sites` CLI Reference

Build the standalone CLI bundle from `https://github.com/PastaPastaPasta/dash-sites`:

```sh
npm ci
npx tsc -b packages/core packages/gateway packages/cli && npm run bundle -w @dash-sites/cli
alias dash-sites="node $PWD/packages/cli/bundle/dash-sites.mjs"
```

### Commands

| Command | Purpose |
| --- | --- |
| `dash-sites login [--name <name>] [--identity <id>] [--qr <file.svg>] [--yes]` | Sign in with DashPay mobile wallet for a contract-bound limited key (`0600` saved session) |
| `dash-sites whoami` | Show active identity, credential source, owned `.dash` names, balance, key ID, budget, and expiry |
| `dash-sites logout` | Delete saved wallet session for `--network` |
| `dash-sites publish <dir> --name <name> [--spa] [--prune] [--grace <h>] [--brotli] [--external <file>] [--elsewhere <file>] [--dry-run]` | Pack, verify, estimate, and publish `<dir>` to `<name>.dash` |
| `dash-sites check <name>` | Verify every `--elsewhere` place of a published site still serves exact published bytes with valid CORS |
| `dash-sites point --name <name> --content <uri>` | Point `<name>.dash` at an external content URI (e.g., `ipfs://<cid>`) — note: `dash.site` does not serve bare `ipfs://` site pointers yet; use `--elsewhere` manifests instead |
| `dash-sites unpublish --name <name>` | Clear the site record's `content` so `<name>.dash` stops serving a site (records are never deleted on Platform; run `gc` later to refund chunks) |
| `dash-sites gc [--dry-run] [--grace <h>]` | Preview or delete all chunks owned by this identity that no active site record references |
| `dash-sites register <label>` | Register an instant (non-contested) `<label>.dash` DPNS name (requires unbound `AUTHENTICATION/HIGH` key; fails with wallet-login keys) |
| `dash-sites names` | List `.dash` names whose DPNS `records.identity` matches the active identity |
| `dash-sites resolve <name>` | Proof-verify and print JSON resolution status (`ok`, `no-site`, `unregistered`, `unsupported`, `invalid`), owner, revision, and content URI |
| `dash-sites fetch <name> [path] [-o <file>]` | Download and cryptographically verify a single file (default `/`) from a published site |
| `dash-sites preview <dir> [--name <name>] [--port 8080] [--spa] [--brotli] [--external <file>]` | Serve `<dir>` locally at `http://<name>.localhost:<port>/` using in-memory packing and routing |
| `dash-sites gateway [--port 8080] [--domain localhost]` | Run a local HTTP gateway serving live `*.localhost` sites from Dash Platform |
| `dash-sites contract register --schema <file>` | Operator command to register a new contract (requires `AUTHENTICATION/CRITICAL` key) |

### Common Options and Environment Variables

| Flag / Env | Default | Notes |
| --- | --- | --- |
| `--network testnet\|mainnet` | `testnet` | **Always pass `--network mainnet` for `*.dash.site`** |
| `--contract <id>` | Built-in | Built-in contract IDs: mainnet `GCSi8NkjXyRpLC7FsEnCfx5ntmWZ16bD2t9zc4JiT4X3`, testnet `CjzpdgCPJdLgVZdUu8SNacWVnrhDv34LstjPdBeJ4dT` |
| `--identity-file <file>` | — | JSON with `identityId` and `identityKeys` (`dash-bridge` / `fund-identity.mjs` format) |
| `--identity <id>` | — | Pair with `DASH_SITES_KEY`, or pin `login` |
| `DASH_SITES_KEY` | — | WIF of an `AUTHENTICATION` key (`HIGH` or `CRITICAL`) |
| `DASH_SITES_CONFIG_DIR` | `$XDG_CONFIG_HOME/dash-sites` or `~/.config/dash-sites` | Directory for saved `dash-sites login` sessions (`0600`) |
| `--spa` | `false` | Rewrite unmatched non-file paths to `/index.html` with HTTP 200 |
| `--dry-run` | `false` | Print bundle stats / cost or prune plan without writing to Platform |

Credential precedence: `--identity-file` -> `--identity` + `DASH_SITES_KEY` -> saved `dash-sites login` session for `--network`.

---

## Static Site Rules and Platform Limits

### Routing Order (`packages/core/src/serve.ts`)

For an incoming pathname:
1. If pathname ends with `/`: serve `<path>index.html` (HTTP 200).
2. Exact file match `<path>` (HTTP 200).
3. Clean URL `.html` shorthand: `<path>.html` (HTTP 200).
4. Directory redirect: if `<path>/index.html` exists, HTTP redirect to `<path>/` (preserving query string).
5. Fallback:
   - If published with `--spa` and `/index.html` exists: serve `/index.html` (HTTP 200).
   - Else if `/404.html` exists: serve `/404.html` (HTTP 404).
   - Else host's default "not found" page.

### Built-In Verified Endpoints (`/.well-known/dash/`)

Every site on `dash.site` (or a local gateway) can fetch its own proved metadata at runtime:
- `/.well-known/dash/site.json` — proved DPNS domain, owner ID, site revision, content URI, proof height/timestamp.
- `/.well-known/dash/manifest.json` — verified site manifest (all files, hashes, sizes, external/elsewhere metadata).
- `/.well-known/dash/resolve/<name>` — resolve another `.dash` name.

### Critical Authoring Gotchas

1. **No `<a download>` links to site files:** Chrome and some other browsers bypass the verifier Service Worker on `<a href="/file.pdf" download>`, saving `dash.site`'s loading shell instead of the file. Remove the `download` attribute (let the link open the file), or fetch the file in JS and trigger a download from a `blob:` URL (`<a href="#" download>` placeholder links are allowed).
2. **No custom Service Workers:** `dash.site`'s verifier Service Worker controls the origin; registering your own Service Worker fails because the host serves the static shell for unknown paths.
3. **Static requests only:** only `GET` and `HEAD` are accepted (`POST`/`PUT`/`DELETE` are refused). Use client-side JS, external APIs, or Dash Platform SDK calls directly for interactivity.
4. **System light/dark theme:** include `<meta name="color-scheme" content="light dark">` and `color-scheme: light dark` on `:root` (using system colors like `Canvas`/`CanvasText` or `prefers-color-scheme` variables) so the page matches `dash.site`'s loading shell and the visitor's OS theme.
5. **Do not rely on `curl https://<name>.dash.site/` to test site content:** `dash.site` serves the static verifier shell over HTTP; the browser's Service Worker fetches and verifies the actual files from Dash Platform. Verify from the terminal with `dash-sites resolve` and `dash-sites fetch`.

### Limits and Automatically Skipped Files

- **Max files:** `5,000`
- **Max site size:** `50 MB` uncompressed in shell/CLI (`25 MB` in gateway process); includes `--external` files, excludes `--elsewhere` files.
- **Max `--elsewhere` file size:** `64 MiB` per file, up to `8` places per file.
- **Max manifest size:** `4 MB` uncompressed JSON / `30` gzipped chunks (`14,700 B` each).
- **Max path length:** `512` UTF-8 bytes; paths cannot contain control chars, `\`, `?`, `#`, `%`, `.`, or `..` segments.
- **Skipped automatically by `readSiteDirectory`:** `node_modules`, `.git`, `.DS_Store`, `Thumbs.db`, and all dotfiles/dotdirs **except** `.well-known`.

---

## Troubleshooting

| Symptom / Error | Cause & Fix |
| --- | --- |
| `cannot publish to <name>.dash: the name is not registered` | Name is not registered on the selected `--network` (check if you forgot `--network mainnet`). Register it first or switch `--network`. |
| `cannot confirm the answering identity without a terminal` | Running `dash-sites login` in a non-TTY shell without pinning. Pass `--name <label>`, `--identity <id>`, or `--yes`. |
| `A key from your wallet can publish sites but cannot register names` | Wallet-login keys are contract-bound to `dash-sites`. Register the name in DashPay mobile wallet, or use an unbound `identity.json` (Path B / Path C). |
| `<label>.dash is a contested name` | 3–19 chars with only `[a-zA-Z01-]`. Include a digit `2–9` or use >= 20 chars for instant registration. |
| `the identity holds X DASH, and this site costs about Y DASH` | Insufficient credits on the identity. Minimize the site (see `fee-optimization.md`) and/or top up the identity (`fund-identity.mjs init --identity <id>` or DashPay / Dash Bridge). |
| `an external file is not byte-identical to the npm package file on every CDN` | Either the local copy differs from the published npm file or one CDN serves a different file. Copy the exact file from `node_modules/<pkg>/<path>`, pin the exact version, or store it normally. |
| `it does not let other sites read it: ... Access-Control-Allow-Origin: *` | An `--elsewhere` HTTPS host lacks CORS headers. Add `Access-Control-Allow-Origin: *` on the bucket/server or host on Arweave/IPFS. |
| `pruned.deferredUntil` set / `gc` deletes 0 chunks | A site record of the identity changed within `--grace` hours (default 25h). Wait until after `deferredUntil` and run `dash-sites gc`. |
| `saved wallet login for mainnet expired` or `is no longer valid` | Re-run `dash-sites login --network mainnet --name <label>`. |
