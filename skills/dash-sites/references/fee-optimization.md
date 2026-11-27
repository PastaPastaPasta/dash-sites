# Minimizing Fees and Optimizing `dash.site` Performance

Dash Platform charges a one-time storage fee per byte stored in documents (refundable on delete, minus epoch decay and non-refundable processing fees). Small, well-packed sites cost pennies and load in under a second; unoptimized sites with raw images or unbundled libraries can easily cost 10–100x more.

## Exact Cost Model

From `packages/core/src/cost.ts` and `packages/core/src/limits.ts`:

- **Unit:** `1 DASH = 100,000,000,000 credits` (`1e11`).
- **Chunk size:** `14,700 bytes` per chunk document (3 fields x 4,900 bytes).
- **Upper-bound publish estimate (`estimateCredits`):**
  - Site record: `110,000,000 credits` (~`0.0011 DASH` on first publish; replacing an existing record costs `< 0.0001 DASH`).
  - Each new chunk: `50,000,000 credits` (`0.0005 DASH`) + `28,500 credits` per stored byte.
- **Rule of thumb:** **~0.30–0.32 DASH per stored megabyte** (after compression).

| Stored (compressed) size | Approx. chunks | Approx. one-time publish cost | Cold-load queries |
| --- | --- | --- | --- |
| 10 KB (single page) | 2 (1 data + 1 manifest) | ~0.0050 DASH | 1 composite query |
| 50 KB (small site) | 5 | ~0.018 DASH | 1 composite query |
| 100 KB | 8 | ~0.034 DASH | 1 composite query |
| 450 KB | 32 | ~0.145 DASH | **1 composite query (preload cap)** |
| 1 MB | 72 | ~0.32 DASH | 2+ queries |
| 5 MB | 357 | ~1.60 DASH | 5+ queries |

### The 32-Chunk Fast-Load Threshold (`PRELOAD_CHUNKS = 32`)

When a visitor opens `https://<name>.dash.site/`, the shell issues a single composite Platform proof query that returns the DPNS `domain`, the `site` record, and up to **32 chunks** (~470 KB compressed, manifest included) in one round trip. Keeping a site at or under 32 chunks minimizes both **fees** and **cold-load latency**.

Always check the exact numbers before publishing:

```sh
dash-sites publish ./site --name <label> --network mainnet --brotli --dry-run
```

---

## Fee-Reduction Levers (Highest Impact First)

### 1. Keep Large Media and Binaries Off Platform (`--elsewhere`, Manifest v3)

Never store photos, videos, PDFs, audio, or multi-megabyte bundles on Platform when they can live at an external URI while keeping full cryptographic verification.

`--elsewhere places.json` tells `dash-sites` to store **only** the file's size, SHA-256 hash, and a list of up to 8 places (`https://` URLs or `ipfs://<cid>`) in the manifest. Visitors' browsers fetch the file from the first working place and **reject any response whose size or SHA-256 does not match the proved manifest**.

```json
{
  "/img/hero.webp": [
    "ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi",
    "https://media.example.com/hero.webp"
  ],
  "/docs/whitepaper.pdf": [
    "https://arweave.net/<tx-id>"
  ]
}
```

```sh
dash-sites publish ./site --name <label> --network mainnet --brotli --elsewhere places.json
# Later, audit that every external place still serves the exact published bytes:
dash-sites check <label> --network mainnet
```

**Requirements and limits for `--elsewhere`:**
- Upload the files with your provider's own tools first. `publish` verifies every listed place before writing to Platform and aborts if any place fails.
- If a file listed in `places.json` is omitted from the local folder, `publish` downloads it from the first working place to hash it.
- **HTTPS CORS required:** every `https://` host (and any redirect hop) must return `Access-Control-Allow-Origin: *` (or the site's origin). Browsers send `credentials: 'omit'` and `referrerPolicy: 'no-referrer'`.
- **Good hosts:**
  - **Arweave** (`https://arweave.net/<tx-id>`): pay-once permanent storage, CORS enabled; matches Platform's pay-once model.
  - **Cloudflare R2 / S3-compatible buckets** with a public custom domain and CORS rule (`r2.dev` URLs are rate-limited).
  - **IPFS pinning** (Pinata, Filebase, Lighthouse, Storacha, or your own node): list an `ipfs://<cid>` URI. Note: browsers download a hash-pinned `@helia/verified-fetch` client (~300 KB compressed) on first IPFS load; pairing `ipfs://` with an `https://` mirror improves availability and speed.
- **Caps:** up to **64 MiB per file**, up to **8 places per file**; `--elsewhere` files do **not** count toward the 50 MB site-size cap.
- Whole-file hashing means streaming range requests are not yet supported; keep video/audio concise or link out.

### 2. Offload Unmodified npm Packages (`--external`, Manifest v2)

For unmodified files from published npm packages (e.g., `@fontsource/*` WOFF2 fonts, JS libraries, WASM modules such as `@dashevo/wasm-sdk`), use `--external external.json`:

```json
{
  "/fonts/ibm-plex-sans-latin-400-normal.woff2": {
    "npm": "@fontsource/ibm-plex-sans",
    "version": "5.3.0",
    "path": "files/ibm-plex-sans-latin-400-normal.woff2"
  }
}
```

```sh
dash-sites publish ./site --name <label> --network mainnet --brotli --external external.json
```

**Rules for `--external`:**
- Exact semver version only (no ranges, no tags, no `+esm` generated endpoints).
- The exact file **must also exist** in the local `<dir>` at that site path so `publish` can compute its SHA-384 and SHA-256.
- `publish` checks both `https://cdn.jsdelivr.net/npm/<pkg>@<ver>/<path>` and `https://unpkg.com/<pkg>@<ver>/<path>` and refuses unless **both** CDNs serve byte-identical files.
- **Limit caveat:** `--external` files **still count** toward the site's total uncompressed size limit (`50 MB` in the shell/CLI, `25 MB` in the gateway process), even though they cost 0 storage chunks on Platform.

### 3. Enable Brotli Compression (`--brotli`, Manifest v2)

By default, `dash-sites` compresses compressible files with gzip (when smaller than raw). Adding `--brotli` runs Node's Brotli at quality 11 and stores whichever of raw, gzip, or brotli is smallest.

- Typically saves **15–25%** on HTML, CSS, JS, JSON, SVG, and WASM compared to gzip.
- Note: Brotli output depends on Node's bundled Brotli version; publishing the same source from a different Node major version can produce different compressed bytes (and therefore new chunk hashes).

### 4. Optimize Site Assets Before Packing

`dash-sites` automatically skips compression for extensions it treats as already compressed (`packages/core/src/mime.ts`):
`png`, `jpg`/`jpeg`, `gif`, `webp`, `avif`, `woff`, `woff2`, `mp3`, `ogg`, `wav`, `mp4`, `webm`, `zip`, `pdf`.

Therefore, optimize these **before** running `publish`:
- **Images:** convert PNG/JPEG to **WebP** or **AVIF** (often 50–80% smaller), resize to exact rendered dimensions (never ship 4000px photos for 600px cards), and strip EXIF metadata. Prefer crisp, SVGO-minified **SVG** for icons, logos, and diagrams (SVGs *are* Brotli/gzip compressed).
- **Fonts:** prefer system font stacks (`system-ui, -apple-system, sans-serif`) for zero font cost. If custom fonts are needed, use `@fontsource/*` via `--external` or subset WOFF2 to the needed glyph range.
- **HTML/CSS/JS:** minify and tree-shake; strip source maps (`*.map`), non-legal comments, unused CSS, and dead assets while preserving required third-party license notices (either in the bundle or in an accompanying `LICENSES.txt`). Do not ship `README.md`, test fixtures, or raw design files in the publish directory.
- **Single-page sites:** inlining small CSS/JS directly into `index.html` shrinks the manifest and improves Brotli cross-file compression.

### 5. Manifest Version Compatibility Matrix

`dash-sites` automatically writes the **lowest** manifest version needed by the site:

| Manifest Version | Triggered By | Supported By |
| --- | --- | --- |
| **v1** | Plain + gzip files stored on Platform | All shells, `dash.site`, `id.dashhq.org`, extension v0.1.0+, CLI |
| **v2** | `--brotli` or `--external` | `dash.site` (mainnet), current CLI/shell builds. Older `id.dashhq.org` / extension v0.1.0 refuse v2 |
| **v3** | `--elsewhere` | `dash.site` (mainnet), current CLI/shell builds (open format for forward compatibility) |

For mainnet `*.dash.site`, v2 and v3 are live and recommended whenever they save fees.

---

## Chunk Packing, Updates, and Reclaiming Storage Refunds

### How Chunk Reuse Works on Updates

`buildSite` (`packages/core/src/pack.ts`) processes files sorted lexicographically by path:
- **Full chunks:** any 14,700-byte slice of a file becomes its own standalone chunk keyed by `sha256(chunk)`. If you don't edit that file, its full chunks are **reused for free** (`reused` in publish output).
- **Shared tail/small-file chunks:** files smaller than 14,700 bytes (and the remainder tail of larger files) are packed sequentially into shared 14,700-byte chunks. Changing one small file changes the shared chunk it lives in (and any neighbors sharing that chunk).
- **Manifest chunks:** the gzipped manifest itself is stored in 1–30 chunks (`dash-manifest:v1:<hash>,...`); every update that changes any file hash writes a new manifest chunk (~0.0006–0.001 DASH for a small manifest).

**Practical tip for frequent updates:** keep large static assets in separate files (their 14,700 B full chunks stay untouched across HTML/CSS edits), and avoid changing file paths unnecessarily.

### Reclaiming Storage with `--prune` and `dash-sites gc`

Deleting unused chunks refunds Platform's storage fee (`27,000 credits/byte`) minus:
1. **Epoch payout decay:** 0.125% per mainnet epoch (9.125 days; 40 epochs/year) in year 1 — so **~99.9% gross after 1 day**, **~94.9% gross after 1 year** (testnet epochs are 1 hour).
2. **Non-refundable delete processing fee:** deleting a chunk rewrites tree nodes above it (~15–20% of the storage refund in a ~1,000-chunk tree).
- **Net refund:** roughly **~75% of original chunk storage cost** comes back to the identity balance.

Commands:

```sh
# Delete chunks of releases older than the one being replaced (keeps current + previous release):
dash-sites publish ./site --name <label> --network mainnet --brotli --prune

# Preview everything unused across all sites owned by this identity:
dash-sites gc --network mainnet --dry-run

# Delete all unreferenced chunks and print the net DASH refunded:
dash-sites gc --network mainnet
```

### Grace Period and Safety Rules

- **Default `--grace 25` (hours, measured in Platform block time):** neither `--prune` nor `gc` deletes anything while any site record of the identity changed less than `--grace` hours ago (protects visitors/caches still resolving the replaced release) or for chunks created within `--grace` hours.
- **3-minute recheck wait:** before deleting, the CLI waits for a Platform block at least 3 minutes newer than the plan block and re-reads all site records; if anything changed, it aborts deletion safely.
- **Frequent updaters:** if you publish more often than every 25 hours, `--prune` will defer (`deferredUntil` in JSON output) while still publishing the new site; run `dash-sites gc` during a quiet window (or lower `--grace` only if you are sure no stale caches rely on older chunks).
- **Concurrency warning:** **never run two publishers or `gc` processes for the same identity at the same time.**
