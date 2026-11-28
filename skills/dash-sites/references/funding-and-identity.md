# Funding, Authentication, and DPNS Names

How to go from nothing to a funded Dash Platform identity and a registered `.dash` name, or authenticate with an existing DashPay mobile wallet.

## Choosing a Path

Ask the user which option fits them best:

1. **DashPay Wallet Login (`dash-sites login`)** — Best when the user already has a DashPay identity and `.dash` name, on a phone or the desktop wallet. Least privilege: the wallet mints a contract-bound `AUTHENTICATION/HIGH` key scoped exclusively to `dash-sites`, with a spending cap and expiry chosen in the user's wallet.
2. **Direct L1 DASH Deposit (`scripts/fund-identity.mjs`)** — Best when starting from nothing (no DashPay wallet, no Platform identity, or needing to register a new `.dash` name) or topping up an existing identity. Lets the user send DASH from **any** wallet or exchange using their choice of a **plain Dash Core address** or a **scannable BIP21 QR code**.
3. **Browser Self-Custody (`https://bridge.thepasta.org/`)** — Best when the user wants key generation to happen in their own browser. Dash Bridge displays both a deposit address and a QR code, creates/tops up the identity client-side, and exports `identity.json`.

---

## Path A: DashPay Wallet Login

Requires DashPay for Android 11.9.2+, Dash Wallet for iOS 9.1.4+ or the desktop Dash Wallet (DashPay Desktop) 1.0.0-rc.2+ (for testnet, use the `-testnet.apk` release from `dashpay/dash-wallet`, or switch the desktop wallet to Testnet).

```sh
# Pin an existing name (recommended — skips interactive confirmation in non-TTY agent shells):
dash-sites login --network mainnet --name alice --qr login-qr.svg

# Or pin an identity ID:
dash-sites login --network mainnet --identity <44-char-base58-id> --qr login-qr.svg

# Or accept whichever wallet answers (non-TTY requires --yes if neither --name nor --identity is set):
dash-sites login --network mainnet --yes --qr login-qr.svg
```

### What `dash-sites login` Produces

- **Terminal QR code** on `stderr` (compact UTF-8 half-block QR).
- **`dashpay://connect?...` URI** on `stderr` (works as a deep link on mobile).
- **SVG QR file** when `--qr <file.svg>` is passed (crisp white-backed SVG; convert to PNG if the user's interface displays PNGs better, e.g., with `rsvg-convert` or `magick`).
- Requests a key bound to the `dash-sites` contract proposing a 0.2 DASH budget and 90-day lifetime (the user can adjust both on their wallet approval screen).
- The request code expires in **10 minutes**. Keep the QR code and URI private: if more than one identity answers the same request, login aborts for safety.
- Saves the session (`0600`) to `$DASH_SITES_CONFIG_DIR/session.<network>.json` (default `$XDG_CONFIG_HOME/dash-sites` or `~/.config/dash-sites`), plus a per-network `connection.<network>` ID so re-logging in cleanly replaces the prior key in the wallet.

### Checking Allowance and Logging Out

```sh
dash-sites whoami --network mainnet
dash-sites logout --network mainnet
```

`logout` deletes the local session file. To revoke the key on-chain before expiry, the user removes **"Dash Sites"** from their wallet's **More -> Tools -> Connections** screen.

### Contract-Bound Limitation

Wallet-login keys are bound to `dash-sites` only:
- **Can do:** `publish`, `point`, `unpublish`, `gc`, `names`, `whoami`.
- **Cannot do:** `register` (DPNS is a separate system contract) or `contract register`. Register the `.dash` name inside DashPay first, or use Path B / Path C.

---

## Path B: Direct DASH Funding via Address or QR Code (`scripts/fund-identity.mjs`)

Use `scripts/fund-identity.mjs` (next to `SKILL.md`) to create a brand-new Platform identity or top up an existing identity by accepting L1 DASH from any wallet or exchange. It uses only packages already installed in the `dash-sites` repository (`@dashevo/evo-sdk`, `@noble/hashes`, `@noble/secp256k1`, `@scure/base`, `qr`).

### How Much DASH to Ask For

Run `dash-sites publish <dir> --name <label> --network mainnet --dry-run` first, then ask for:

| Item | Approximate Cost |
| --- | --- |
| Identity creation + Core asset-lock tx fee | ~0.001–0.002 DASH |
| Instant (non-contested) DPNS name registration | ~0.0007–0.0008 DASH (the SDK prices its preorder and domain at about 76.5 M credits; one was measured at about 65 M) |
| First site record + chunks | Dry-run estimate (~0.35 DASH per stored MB) |
| **Recommended buffer** | Add **~0.015–0.02 DASH** on top of the dry-run site estimate (minimum **0.01 DASH** for a minimal single-page site) |

Minimum deposit enforced by `fund-identity.mjs`: **0.00101 DASH** (100,000 duffs locked + 1,000 duffs Core relay fee).

### Step 1: Ask the User Their Preferred Payment Format, Then Run `init`

Ask whether the user wants:
- A **plain Dash Core address** (`--format address`) — `X...` on mainnet, `y...` on testnet,
- A **QR code** (`--format qr`, with `--qr <file.svg>`) — encodes the BIP21 URI `dash:<address>?amount=<amount>`, or
- **Both** (`--format both`).

```sh
# Create a new identity:
node <skill-dir>/scripts/fund-identity.mjs init \
  --network mainnet \
  --amount 0.05 \
  --format both \
  --qr /tmp/dash-deposit.svg \
  --state ~/.config/dash-sites/funding-mainnet.json

# Or top up an existing identity:
node <skill-dir>/scripts/fund-identity.mjs init \
  --network mainnet \
  --identity <44-char-base58-id> \
  --amount 0.05 \
  --format address \
  --state ~/.config/dash-sites/topup-mainnet.json
```

`init` generates fresh keys and atomically writes the `0600` state file **before** printing the address/QR, and refuses to overwrite an existing state file. To re-display the address or QR later without generating new keys:

```sh
node <skill-dir>/scripts/fund-identity.mjs qr --state ~/.config/dash-sites/funding-mainnet.json --format qr --qr /tmp/dash-deposit.svg
```

### Step 2: Check Status or Complete Registration / Top-Up

Once the user sends DASH, run `complete` (default wait: 900 seconds; pass `--no-wait` to check once without polling):

```sh
node <skill-dir>/scripts/fund-identity.mjs complete \
  --state ~/.config/dash-sites/funding-mainnet.json \
  --out ~/.config/dash-sites/identity-mainnet.json
```

What `complete` does safely under the hood:
1. Polls Dash Insight API (`insight.dash.org` on mainnet, `insight.testnet.networks.dash.org` on testnet) for UTXOs at the funding address.
2. **Authenticates every UTXO against `/rawtx/<txid>`**: verifies `sha256d(rawTx) === txid`, parses the DIP-2 raw transaction, and confirms the output's exact value and P2PKH script match before signing (prevents an explorer from misreporting input amounts and draining the difference as miner fee).
3. Builds and signs a Dash Core v3 type-8 Asset Lock transaction (1 duff/byte, min 1,000 duffs, hard cap 10,000 duffs, low-S DER ECDSA).
4. Saves `assetLockTxid` and `assetLockRawTxHex` to the `0600` state file **before** broadcasting.
5. Broadcasts via Insight and waits for 1 Core block confirmation (~2.5 minutes).
6. Connects to Dash Platform via `@dashevo/evo-sdk` (trusted proof mode) and waits until `coreChainLockedHeight >= assetLockBlockHeight`.
7. Submits a `ChainAssetLockProof` to create the new identity (writing `identity.json` with mode `0600`) or top up `--identity` (prints the new balance and writes no `identity.json`; continue using the credentials you already hold for that identity).

### Crash Safety and Resuming

Every stage is persisted to `--state`. If a network error, shell timeout, or Ctrl-C occurs at any point, inspect progress with `status` and re-run `complete` with the same `--state` file:

```sh
node <skill-dir>/scripts/fund-identity.mjs status --state ~/.config/dash-sites/funding-mainnet.json
node <skill-dir>/scripts/fund-identity.mjs complete --state ~/.config/dash-sites/funding-mainnet.json --out ~/.config/dash-sites/identity-mainnet.json
```

Keep the state file until `complete` succeeds and `dash-sites whoami --network mainnet --identity-file identity.json` confirms the identity and balance.

---

## Path C: Browser Self-Custody via Dash Bridge

If the user prefers to generate and control their mnemonic/keys in their own browser:
- **Mainnet:** `https://bridge.thepasta.org/?network=mainnet`
- **Testnet:** `https://bridge.thepasta.org/`

The bridge runs client-side, shows both a deposit address and QR code, bridges Core DASH to Platform credits, lets the user register a DPNS name, and exports an `identity.json` backup directly compatible with `dash-sites --identity-file`.

### `identity.json` Format Expected by `dash-sites`

```json
{
  "identityId": "<44-char-base58-identity-id>",
  "identityKeys": [
    { "id": 0, "purpose": "AUTHENTICATION", "securityLevel": "MASTER", "keyType": "ECDSA_SECP256K1", "privateKeyWif": "..." },
    { "id": 1, "purpose": "AUTHENTICATION", "securityLevel": "CRITICAL", "keyType": "ECDSA_SECP256K1", "privateKeyWif": "..." },
    { "id": 2, "purpose": "AUTHENTICATION", "securityLevel": "HIGH", "keyType": "ECDSA_SECP256K1", "privateKeyWif": "..." },
    { "id": 3, "purpose": "TRANSFER", "securityLevel": "CRITICAL", "keyType": "ECDSA_SECP256K1", "privateKeyWif": "..." }
  ]
}
```

- Normal publishing (`publish`, `point`, `unpublish`, `gc`, `register`) requires an **`AUTHENTICATION` / `HIGH`** key (or `CRITICAL` if passed via `DASH_SITES_KEY`).
- Alternatively, pass `--identity <id>` and set `DASH_SITES_KEY=<WIF>` in the environment (avoid putting WIFs directly in command history).

---

## Staging on Testnet (Free tDASH)

Before spending mainnet DASH on a complex build:
1. Run `fund-identity.mjs init --network testnet --amount 0.1 --state /tmp/test-funding.json`.
2. Fund the generated `y...` address from `https://faucet.thepasta.org` or `https://faucet.dashhq.org`.
3. Run `fund-identity.mjs complete`, register a testnet name, and test `publish` / `resolve` / `fetch` with `--network testnet`.
4. Note: testnet's hosted gateway `id.dashhq.org` may lag behind mainnet `dash.site` on manifest v2/v3 support (`--brotli`, `--external`, `--elsewhere`); test those with `dash-sites preview` or `dash-sites fetch`.

---

## DPNS Name Rules and Registration

Check whether a label is available first:

```sh
dash-sites resolve <label> --network mainnet
# "status": "unregistered" means the label is available.
```

Rules enforced by DPNS and `dash-sites`:
- **Format:** 3–63 ASCII characters `[a-zA-Z0-9-]`, cannot start or end with `-`, cannot have `--` at positions 3–4 (punycode `xn--` rejected).
- **No subdomains:** every name is `<label>.dash` (no `blog.alice.dash`).
- **Homograph normalization:** lowercased, `o` -> `0`, `i`/`l` -> `1`. Thus `alice`, `Alice`, and `a1ice` normalize to the same name (`a11ce`).
- **Contested vs. instant names:**
  - **Contested:** 3–19 characters containing only letters, `0`, `1`, and `-`. Requires a masternode vote and deposit; `dash-sites register` refuses contested names by default.
  - **Instant (recommended for fast deploys):** contains at least one digit `2–9` (e.g., `my-app-2026`, `d4sh-docs`, `site7`) **or** is 20–63 characters long. Registers immediately in seconds:

```sh
dash-sites register <label> --network mainnet --identity-file ~/.config/dash-sites/identity-mainnet.json
```

Names are transferable and tradeable on DPNS. `dash.site` proves the current owner on every load and ignores site records written before the name's latest `$transferredAt`. Note that `dash-sites names` queries `records.identity`, so names received via transfer/purchase may not appear in `names` even though `resolve` and `publish` recognize ownership by `$ownerId`.
