---
name: dash-sites
description: Publish, update, optimize, and manage static websites on Dash Platform names (*.dash.site / *.dash) from scratch, including funding or authenticating with DASH via DashPay mobile wallet login, a Dash Core address, or a QR code (user's choice), registering a DPNS name, minimizing Platform storage fees, and reclaiming storage refunds. Use when asked to build, deploy, publish, update, optimize, or manage a dash.site or .dash website.
---

# Dash Sites (`dash.site`)

Deploy and maintain static websites bound to Dash Platform Name Service (DPNS) names (`alice.dash` -> `https://alice.dash.site/` on mainnet, `https://alice.id.dashhq.org/` on testnet). Every site record and file chunk is stored on Dash Platform and verified in the visitor's browser with Platform proofs and SHA-256 hashes; `dash.site` itself is a static shell with no backend server.

> **Default network pitfall:** the `dash-sites` CLI defaults to `--network testnet`. Always pass `--network mainnet` when publishing a live `*.dash.site` site.

## End-to-End Workflow (From Nothing to Live Site)

Follow these steps in order. Never skip the dry-run cost estimate before asking the user for funds or publishing.

### 1. Install and Build the CLI

Requires Node.js >= 22, `npm`, and `git`. If `dash-sites` is not already available locally, clone the repository and build just the CLI bundle (takes a few seconds; full `npm run build` also builds the browser shell/extension and takes ~1 minute):

```sh
git clone https://github.com/PastaPastaPasta/dash-sites.git
cd dash-sites
npm ci
npx tsc -b packages/core packages/gateway packages/cli && npm run bundle -w @dash-sites/cli
```

Run the CLI via `node <repo>/packages/cli/bundle/dash-sites.mjs` (referred to below as `dash-sites`).

### 2. Prepare, Optimize, and Dry-Run the Site First

Estimate the exact storage cost **before** asking the user for DASH so you request the right amount (plus a small buffer).

1. **Follow `dash.site` static constraints:**
   - Static files only (`GET`/`HEAD`; no backend, no POST endpoints, no custom Service Worker).
   - Include `/index.html`. Follow the visitor's system theme (`<meta name="color-scheme" content="light dark">` and `color-scheme: light dark` on `:root`).
   - **Never use `<a download>` for site files**: browsers such as Chrome bypass the verifier Service Worker on download links and save `dash.site`'s loading shell instead. Remove `download` (or generate a `blob:` URL in JS).
   - Keep internal links valid (`publish` warns about missing targets and download links).
2. **Minimize storage fees** (~0.3 DASH per stored MB; 14,700-byte chunks; keep total chunks <= 32 / ~470 KB compressed for a single-query cold load):
   - Minify HTML/CSS/JS; delete `.map` files, docs, and unused assets; pre-optimize binary assets (WebP/AVIF, SVGO-minified SVG, subset WOFF2) because `dash-sites` does not re-compress `png`, `jpeg`, `gif`, `webp`, `avif`, `woff`, `woff2`, `audio/*`, `video/*`, `zip`, or `pdf`.
   - Use `--brotli` for text/SVG/JSON/WASM (typically 15–25% smaller than gzip; manifest v2, supported on `dash.site`).
   - Offload unmodified npm libraries/fonts/WASM with `--external external.json` (manifest v2; verified by SHA-384 from jsDelivr/unpkg).
   - Offload large media/binaries (> ~50 KB) with `--elsewhere places.json` (manifest v3; HTTPS with `Access-Control-Allow-Origin: *` such as Cloudflare R2/S3/Arweave, or `ipfs://<cid>`; verified by SHA-256, up to 64 MiB/file).
   - See [references/fee-optimization.md](references/fee-optimization.md) for the exact credit formula, compatibility matrix, and optimization recipes.
3. **Dry-run and preview locally:**
   ```sh
   dash-sites publish ./site --name <label> --network mainnet --brotli --dry-run
   dash-sites preview ./site --name <label> --port 8080
   ```
   Check the printed file count, stored bytes, chunk count, link warnings, and estimated DASH cost.

### 3. Authenticate or Get DASH from the User (User's Choice)

Ask the user which setup they have and how they want to authorize or pay. Never invent keys without persisting them first, and never print, log, or commit private keys or identity files.

| Situation | Path | How the user interacts |
| --- | --- | --- |
| User already has **DashPay mobile wallet** with an identity & `.dash` name | **Path A: Wallet login** (recommended when available; least privilege) | Scans QR code or opens `dashpay://connect` link in DashPay |
| Starting from **nothing** (no DashPay / no identity / needs a new `.dash` name) or **topping up** an identity | **Path B: Direct DASH deposit** via `scripts/fund-identity.mjs` | Sends DASH using their choice of **plain Dash address** or **BIP21 QR code** |
| User prefers to generate and hold keys in their own browser | **Path C: Dash Bridge** (`https://bridge.thepasta.org/?network=mainnet`) | Browser shows both address & QR code; user exports `identity.json` |

#### Path A — DashPay Mobile Wallet Login (Contract-Bound Limited Key)

Best when the user already owns a `.dash` name in DashPay (Android 11.9.2+ or iOS 9.1.4+). The wallet issues a contract-bound `AUTHENTICATION/HIGH` key with a spending budget and expiry; full wallet keys never leave the phone.

```sh
# In non-interactive agent shells, pin --name <label> (or --identity <id>, or --yes).
dash-sites login --network mainnet --name <label> --qr login-qr.svg
dash-sites whoami --network mainnet
```

Give the user the QR code (terminal ASCII or `login-qr.svg`, converted to PNG if their chat UI prefers images) and/or the `dashpay://connect` URI. Wait for approval (10-minute code expiry).

> **Limitation:** a wallet-login key is bound solely to the `dash-sites` contract and **cannot register new DPNS names**. If the user needs a new `.dash` name, they must register it in DashPay first, or use Path B / Path C.

#### Path B — Fund a Fresh Identity (or Top Up) via Address or QR Code

Ask the user whether they prefer a **plain Dash Core address** (`--format address`), a **scannable BIP21 QR code** (`--format qr`, optionally `--qr deposit.svg`), or **both** (`--format both`).

Calculate the suggested `--amount`: dry-run site cost + ~0.015 DASH buffer (covers DPNS name registration, site record, and L1/Platform fees; minimum ~0.01 DASH for a tiny site).

```sh
# 1. Generate keys, save 0600 state file BEFORE showing address/QR (add --identity <id> to top up):
node <skill-dir>/scripts/fund-identity.mjs init \
  --network mainnet \
  --amount 0.05 \
  --format both \
  --qr deposit-qr.svg \
  --state ~/.config/dash-sites/funding-mainnet.json

# 2. After the user sends DASH, complete the asset-lock + ChainLock + identity registration:
node <skill-dir>/scripts/fund-identity.mjs complete \
  --state ~/.config/dash-sites/funding-mainnet.json \
  --out ~/.config/dash-sites/identity-mainnet.json
```

`complete` authenticates the deposit UTXO against raw tx bytes, signs and broadcasts a Dash Core v3 type-8 asset-lock transaction, waits for 1 Core block (~2.5 min) plus Platform ChainLock, creates (or tops up) the identity, and writes `identity.json` (`0600`) in the exact format `dash-sites --identity-file` accepts. It is crash-safe and idempotent: if interrupted or timed out, re-run `complete` with the same `--state` file.

See [references/funding-and-identity.md](references/funding-and-identity.md) for Path C (Dash Bridge), testnet faucet staging, key management, and recovery details.

### 4. Register or Verify the DPNS Name

Check availability or list names owned by the active credentials:

```sh
dash-sites resolve <label> --network mainnet
dash-sites names --network mainnet [--identity-file <identity.json>]
```

DPNS naming rules:
- 3–63 chars of `[a-zA-Z0-9-]`, no leading/trailing `-`, no `--` in positions 3–4 (`xn--` rejected), no subdomains (`blog.alice.dash` is invalid).
- Case-insensitive and homograph-normalized (`o` -> `0`, `i`/`l` -> `1`).
- **Contested vs. instant names:** labels of 3–19 characters containing only `[a-zA-Z01-]` are **contested** (require a masternode vote and deposit; `dash-sites register` refuses them). Include at least one digit `2–9` **or** make the label >= 20 characters for instant registration:

```sh
dash-sites register <label> --network mainnet --identity-file ~/.config/dash-sites/identity-mainnet.json
```

### 5. Publish and Verify

Publish with either a saved wallet session (`dash-sites login`), `--identity-file <file>`, or `--identity <id>` with `DASH_SITES_KEY=<WIF>`:

```sh
dash-sites publish ./site \
  --name <label> \
  --network mainnet \
  --brotli \
  [--spa] \
  [--external external.json] \
  [--elsewhere places.json] \
  [--identity-file ~/.config/dash-sites/identity-mainnet.json]
```

Verify immediately after publishing:

```sh
dash-sites resolve <label> --network mainnet
dash-sites fetch <label> /index.html --network mainnet > /dev/null
# If the site uses --elsewhere:
dash-sites check <label> --network mainnet
```

The site is live at `https://<label>.dash.site/` (mainnet) or `https://<label>.id.dashhq.org/` (testnet). Note that `curl https://<label>.dash.site/` returns the static verifier shell, not the site's HTML; use `dash-sites fetch` or a real browser to read rendered content.

### 6. Update, Reclaim Fees (`--prune` / `gc`), and Unpublish

- **Updating:** run `dash-sites publish` again with the updated directory. Identical 14,700-byte chunks are automatically reused at zero upload cost (`reused` in output).
- **Reclaiming storage refunds (~75% net):**
  - Inline on publish: add `--prune` (keeps the new release and the one it replaced; deletes chunks of older releases).
  - Standalone cleanup:
    ```sh
    dash-sites gc --network mainnet --dry-run [--identity-file ...]
    dash-sites gc --network mainnet [--identity-file ...]
    ```
  - **Grace period (`--grace`, default 25 hours, measured in Platform block time):** neither `--prune` nor `gc` deletes anything while any site record of the identity changed less than `--grace` hours ago, and both wait ~3 minutes to re-read site records from a newer block before deleting.
  - **Never run two publishers concurrently** for the same identity while pruning or running `gc`.
- **Taking down a site:** `dash-sites unpublish --name <label> --network mainnet` (clears the site record's `content`; run `gc` after `--grace` to reclaim chunk refunds).
- **Logout / revoke wallet session:** `dash-sites logout --network mainnet` (deletes local session; to revoke immediately on-chain, remove "Dash Sites" in DashPay's Connections screen).

## Security Guardrails

- Store `identity.json`, `funding-*.json`, and `session.*.json` with mode `0600` **outside** the website directory and **outside** any git repository.
- Never paste WIF private keys inline into shared logs, chat transcripts, commits, or public repos.
- Always confirm the target network (`mainnet` vs. `testnet`) before requesting real DASH or broadcasting writes.

## Reference Docs

- [references/funding-and-identity.md](references/funding-and-identity.md) — DashPay login, `fund-identity.mjs` (address/QR/top-up/resume), Dash Bridge, testnet faucet, DPNS name rules, `identity.json` schema.
- [references/fee-optimization.md](references/fee-optimization.md) — Exact credit math, 14,700 B chunking, 32-chunk preload threshold, `--brotli`, `--external`, `--elsewhere`, asset optimization, manifest v1/v2/v3 compatibility, and storage refund decay.
- [references/site-authoring-and-cli.md](references/site-authoring-and-cli.md) — Complete CLI flags/env reference, static routing rules, `/.well-known/dash/*` endpoints, link-check gotchas, limits, and troubleshooting.
