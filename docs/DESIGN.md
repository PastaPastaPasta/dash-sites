# Dash Sites: websites on DPNS names

Status: design v1 (testnet). Date: 2026-11-21.

Dash Sites lets the owner of a DPNS name (`alice.dash`) publish a static website
under that name, and lets anyone open it:

- in any browser, through a DNS gateway: `https://alice.<gateway-domain>/`
  (interim `alice.id.dashhq.org`, later `alice.dash.dev`);
- in a browser with the extension, by typing `alice.dash` or following a
  `http://alice.dash/` link;
- from the command line or their own gateway, with no trusted third party.

It has three parts that share one protocol library: a **builder** (web app and
CLI) that publishes, a **gateway** that serves, and an **extension** that
resolves `.dash` names.

## 1. Prior art

### IPFS

- **Path gateway** `https://gw/ipfs/<cid>/…` puts every site on one origin, so
  sites can read each other's storage. **Subdomain gateways**
  `https://<cid>.ipfs.dweb.link/…` fix that: one origin per content root.
- **Mutable names**: IPNS keys (`<key>.ipns.<gw>`) and **DNSLink**
  (`_dnslink.example.com TXT "dnslink=/ipfs/<cid>"`), resolved by the gateway.
  A DNSLink name with dots is inlined into one DNS label
  (`en-wikipedia--on--ipfs-org.ipns.dweb.link`) because a wildcard certificate
  covers exactly one label.
- **Trust**: a public gateway is trusted for content. A local node, or a client
  that fetches blocks and checks them against the CID (trustless gateway
  responses), is not. IPFS Companion redirects requests to a local node when
  there is one, else to a public gateway.
- Gateway domains go on the **Public Suffix List** so browsers treat each
  subdomain as its own site for cookies.

### ENS (eth.limo, eth.link)

- The name's resolver stores a `contenthash` (EIP-1577): `ipfs://`, `ipns://`,
  `ar://`, `bzz://`.
- `*.eth.limo` is wildcard DNS to a fleet that resolves the name on Ethereum,
  then proxies the content from IPFS/Arweave backends, behind a wildcard
  certificate. The gateway is trusted both for resolution and content.

### dash-website-tool (DWT)

`dashpay/dash-platform-website` publishes dash.dev to Platform. Ideas kept: a
well-known contract found by a constant id, an owner check on every document
the gateway serves, an integrity map per upload. What we do differently:

| DWT | Dash Sites |
| --- | --- |
| Registry keyed by a free-form `domain`, first come first served (squattable) | Bound to DPNS: the name's owner controls the site, nothing to squat |
| One data contract per site (0.1+ DASH each) | One shared contract; a site is documents in it |
| Content on Lighthouse/Arweave/R2 with a server-side upload pipeline | Content on Platform itself (or IPFS by CID); publishing needs only an identity key |
| Reads not proof-verified; gateway trusted | Name and site record read with Platform proofs; content checked by hash |
| Local Express+React tool with SSH/Cloudflare credentials | Static web app and a CLI; no servers or secrets to publish |

DWT is a private repository with operational credentials committed to it, so
Dash Sites is a separate codebase, not a fork.

## 2. What DPNS allows

The DPNS `domain` document (contract `GWRSAVFM…31Ec`):

- `records` allows only `identity` (`additionalProperties: false`), and domain
  documents are immutable (`documentsMutable: false`). A content pointer cannot
  be added to the name. **A companion contract is required.**
- Documents are transferable and tradeable (`transferable: 1`, `tradeMode: 1`).
  After a transfer `$ownerId` is the new owner while `records.identity` still
  names the original identity.
- Names are unique on `(normalizedParentDomainName, normalizedLabel)`.
  Normalization lowercases and maps `o→0`, `i→1`, `l→1`, so `alice`, `Alice`
  and `a1ice` are the same name.
- Labels of 3 to 19 characters from `[a-zA-Z01-]` are **contested**: masternodes
  vote, and the domain document exists only once the contest is won.
- A label is 3 to 63 characters of `[a-zA-Z0-9-]`, not starting or ending with
  `-`: always a valid DNS label.

## 3. Storage and addressing

### Options

| | Mutable | Size and cost | Publisher needs | Verifiable |
| --- | --- | --- | --- | --- |
| **Platform documents** (chunks) | yes (new documents) | field ≤ 5,120 B, transition ≤ 20,480 B, one document per transition; about 0.39 DASH per MB (27,000 credits/byte storage, plus about 140 M credits per chunk) | only a Platform identity | yes: proofs for the record, hashes for content |
| **IPFS** (CID in the record) | pointer is mutable | unlimited, free to address; pinning costs | a pinning service or node | yes: CID |
| **Arweave** | pointer is mutable | pay once per byte | AR/Turbo credits | yes: tx id + hash |
| **HTTPS host + hash** | pointer is mutable | free | a web host | hash only; availability is the host's |

### Decision: hybrid, with Platform as the default

1. The site record is a document in a **companion contract** (`dash-sites`),
   holding a content URI. This is the DPNS equivalent of ENS `contenthash`.
2. Default content store is **Platform itself**: files are split into
   content-addressed `chunk` documents. One identity, one fee currency, no
   second account, and every byte is verifiable back to a quorum signature.
   This suits what DPNS names are mostly used for: personal pages, project
   pages, small apps (tens to hundreds of KB; 100 KB costs about 0.04 DASH).
3. Large sites use `ipfs://<cid>` in the same record. The gateway fetches from
   IPFS and verifies against the CID. The scheme list is open, so `ar://` can
   follow without a contract change.

### The `dash-sites` contract

Two document types. Anyone may create documents; what counts is decided by the
resolution rule (§4), not by who got there first.

```
site      mutable, deletable
  name     string   the DPNS normalizedLabel, e.g. "a11ce"
  content  string   content URI (≤ 2048 chars)
  unique index (ownerId, name)

chunk     immutable, deletable
  hash     32 bytes  sha256(d0 ‖ d1 ‖ d2)
  d0,d1,d2 bytes     up to 4,900 each (14,700 per chunk)
  unique index (ownerId, hash)
```

`site.name` is not globally unique on purpose. A global unique index would let
anyone squat `alice` in this contract before Alice publishes. With
`(ownerId, name)` each identity has its own slot, and only the slot of the
name's current DPNS owner is ever read.

Chunks are keyed per owner for the same reason: nobody can occupy or delete a
chunk another publisher depends on. Chunks are deletable so that a publisher
can reclaim the storage refund after replacing a site.

### Content URIs

- `dash-manifest:v1:<hex>[,<hex>…]`: the sha256 hashes of the chunks that hold
  the site manifest, in order, owned by the site's owner in this contract.
- `ipfs://<cid>`: a UnixFS directory.

### Manifest (Platform storage)

Canonical JSON, gzip-compressed, stored as chunks:

```json
{
  "v": 1,
  "chunks": ["<hex sha256>", "…"],
  "files": {
    "/index.html": { "type": "text/html; charset=utf-8", "size": 1834,
                     "sha256": "<hex>", "enc": "gzip",
                     "parts": [[0, 0, 912]] }
  },
  "spa": false
}
```

- `chunks` is the table of chunk hashes; `parts` are `[chunkIndex, offset,
  length]` slices, concatenated in order to give the stored bytes. Small files
  are packed together into shared chunks; a large file spans several.
- `enc: "gzip"` means the stored bytes are gzip; `size` and `sha256` are of the
  decoded file.
- `spa: true` serves `/index.html` for unknown paths.

Every reader checks: chunk bytes hash to the chunk hash in the table, and the
decoded file hashes to `sha256`. Chunk hashes are fixed by the manifest, the
manifest's chunks by the site record, and the site record by a Platform proof.
So only the two small record reads need proofs; chunks can come from any cache.

Republishing uploads only chunks whose hash the owner does not already have.

Limits a reader enforces: manifest ≤ 2 MB, ≤ 5,000 files, site ≤ 50 MB decoded,
path ≤ 512 bytes. The gateway may set lower limits.

## 4. Resolution

Input: a name, e.g. `Alice.dash` (or a gateway host label).

1. **Normalize** the label (lowercase; `o→0`, `i,l→1`); reject anything that is
   not a valid DPNS label. v1 handles second-level names (`label.dash`) only.
2. **Name**: query DPNS `domain` where `normalizedParentDomainName == "dash"`
   and `normalizedLabel == <label>`, with proof. No document: the name is not
   registered.
3. **Controller**: the domain document's **`$ownerId`**. Not
   `records.identity`: that field is immutable, so after a sale it still names
   the seller, who must not keep the website.
4. **Site record**: query `site` where `$ownerId == controller` and
   `name == <label>`, with proof. No document: the name has no site.
5. **Content**: by scheme. For `dash-manifest`, fetch the manifest chunks
   (`$ownerId == controller`, `hash in […]`), verify, parse; then fetch the
   chunks of the requested file, verify, decode.

Both proofs are absence-capable: "no such name" and "no site" are proved too.
A contested name has no domain document until it is awarded, so it resolves as
unregistered.

**Canonical host.** Several spellings normalize to one name. To give a name one
origin, the canonical host label is the domain document's `label` lowercased
(`Alice` → `alice`); the gateway and extension redirect every other spelling
(`a1ice`, `ALICE`) to it.

**Freshness.** Proofs carry the block height and time. A reader rejects a
response whose block time is more than 30 minutes old (the SDK's stale-node
check also applies), and never accepts a site record with a lower `$revision`
than one it has already seen for that owner in its cache window.

## 5. Surfaces

### Builder

- **Web app** (static, hosted on GitHub Pages): sign in with identity id or
  name plus an AUTHENTICATION key (HIGH or CRITICAL) that never leaves the
  page; choose or register a DPNS name; build a site from a template with a
  Markdown editor, or drop in a folder/zip of a static site; preview; see the
  cost estimate; publish with per-chunk progress.
- **CLI** `dash-sites`: `publish <dir> --name alice`, `publish --ipfs <cid>`,
  `resolve`, `unpublish`, `gc` (delete unreferenced chunks), `estimate`,
  `gateway` (run a local gateway).
- Both use `@dashevo/evo-sdk` (wasm) directly against DAPI. There is no
  publishing server.

### Gateway

A Node HTTP service behind a TLS terminator.

- **Hosts**: `GATEWAY_DOMAINS` is a list (`id.dashhq.org`, later `dash.dev`).
  `<label>.<domain>` serves the site; the bare domain serves a landing page and
  a JSON resolve API. Moving domains is a config and DNS change.
- **DNS**: wildcard `*.id.dashhq.org` and the apex, DNS-only, to the gateway.
- **TLS**: one wildcard certificate (`id.dashhq.org`, `*.id.dashhq.org`) by
  ACME DNS-01. The gateway host answers the challenge itself:
  `_acme-challenge.id.dashhq.org` is delegated to a challenge-only DNS
  responder on the host, so no DNS-provider credentials live there.
- **Resolution**: §4 with proof verification (`trusted` quorum keys today;
  the SDK's `verified` mode, which proves quorum keys from a checkpoint, when
  it ships in a release).
- **Caching**: name and site record for 30 s (stale-while-revalidate 5 min);
  chunks forever (they are immutable) in a bounded disk cache. Responses carry
  `ETag` (the file hash) and `Cache-Control: public, max-age=60`.
- **Serving**: GET/HEAD only. `/` → `/index.html`; `/dir/` →
  `/dir/index.html`; `/page` → `/page.html` when present; missing → the site's
  `/404.html` with status 404; `spa` fallback. Content type from the manifest.
- **Headers**: `X-Content-Type-Options: nosniff`, `Referrer-Policy`,
  `X-Dash-Name`, `X-Dash-Owner`, `X-Dash-Site-Revision`, `X-Dash-Content`.
  Request cookies are ignored and `Set-Cookie` is never sent.
- **Abuse**: a denylist (name, owner identity, or content hash) answers 451;
  per-IP rate limits; size limits; an abuse contact on the landing page. A
  takedown removes a site from this gateway, not from Platform.

### Extension (Chromium MV3; Firefox MV3 build from the same source)

- **Navigation**: a declarativeNetRequest rule redirects `http(s)://<label>.dash/…`
  to `https://<label>.<gateway>/…`. A typed `alice.dash` that the browser
  turned into a search is caught and redirected. The omnibox keyword `dash`
  opens a name directly.
- **Gateway choice**: default public gateway; the user can set another,
  including a local one (`dash-sites gateway` on `*.localhost`), which is the
  trustless setup, as with IPFS Companion and a local node.
- **Independent check**: the extension resolves the current site itself, with
  proofs over DAPI, and compares the gateway's `X-Dash-*` claims (owner,
  revision, content URI) with the proved record. The popup shows the result.
  It can also audit the files a gateway serves against the proved manifest.
  This catches a gateway that serves a stale or different site, but it is an
  audit, not enforcement: MV3 cannot intercept and replace response bodies.
- Rejected: a PAC proxy that keeps `http://alice.dash` in the address bar. It
  gives an insecure context (no service workers, no WebCrypto) and no TLS.

## 6. Security

- **Who controls a site**: the DPNS name's current `$ownerId`, proved. A site
  document from anyone else is never read.
- **Proofs vs trust**: the gateway verifies proofs, so a lying DAPI node cannot
  change a site. A browser user without the extension trusts the gateway
  operator and its TLS, exactly as with eth.limo and dweb.link. Users who do
  not want that run a local gateway.
- **Origin isolation**: one site per subdomain, so `localStorage`, IndexedDB,
  service workers and permissions are per name. The canonical-host redirect
  keeps a name from having several origins.
- **Cookies**: until the gateway domain is on the Public Suffix List, a site
  can set a cookie for the parent domain (`Domain=id.dashhq.org`, or
  `dashhq.org`) that other subdomains then send. The gateway ignores cookies,
  but other apps on the parent domain could be targeted with cookie tossing.
  Mitigations: submit the gateway domain to the PSL; prefer a dedicated
  registrable domain for user content; apps on the parent domain use `__Host-`
  cookies.
- **Phishing and reputation**: user content under `dash.dev` shares its
  reputation with it (Safe Browsing flags by registrable domain unless the
  suffix is on the PSL). Recommendation for the final domain: PSL entry before
  launch, or a dedicated domain.
- **Homographs**: DPNS normalization collapses `o/0`, `i/l/1`; labels are
  ASCII, so there are no IDN homographs. The gateway shows nothing for names
  that do not exist.
- **Contested names**: resolve only after the masternode vote awards them.
- **Builder keys**: keys stay in the page's memory (optionally the browser's
  session storage); the builder is on a different origin from user sites and
  sets a strict CSP.
- **Gateway hardening**: bounded sizes everywhere, paths normalized before
  lookup, no filesystem paths derived from requests, runs unprivileged in a
  container, holds no keys or DNS credentials.

## 7. Networks

Testnet first: the contract is registered on testnet and all three surfaces
default to it. The network, contract id and gateway domains are configuration.
Mainnet needs a funded mainnet identity to register the contract (about 0.17
DASH) and is otherwise the same deployment with different config.

## 8. Hosting

| Piece | Where | Why |
| --- | --- | --- |
| Gateway | A small DigitalOcean droplet (the account that already runs the agent-managed Dash services), Docker Compose: gateway, Caddy, challenge DNS | Wildcard TLS on a two-level name needs our own terminator; Cloudflare's free certificate covers only `*.dashhq.org` |
| DNS | Cloudflare zone `dashhq.org`: `id` and `*.id` A records (DNS-only), `_acme-challenge.id` delegation | Existing access |
| Builder | GitHub Pages from the repo, `sites.dashhq.org` | Static, free, deploys from CI |
| Extension | Release zip on GitHub; store listing later | Store accounts are the user's |

**Moving to `dash.dev`**: add `dash.dev` to `GATEWAY_DOMAINS`; add a wildcard
record `*.dash.dev` to the gateway. `dash.dev` is on Cloudflare, whose
universal certificate already covers `*.dash.dev`, so the record can be
proxied and the gateway needs only an origin certificate. Existing hostnames
(`www`, `docs`, …) keep precedence over the wildcard and are reserved in the
gateway config.

## 9. Out of scope for v1

Subdomain names (`blog.alice.dash`), custom DNS domains pointing at a name
(DNSLink in reverse), server-side anything, private sites, a site directory,
a service-worker verifying client, Arweave.
