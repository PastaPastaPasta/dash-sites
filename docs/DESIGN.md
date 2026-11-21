# Dash Sites: websites on DPNS names

Status: implemented on testnet. Date: 2026-11-21. Testnet contract: `3JRHRkyYZiwGS6xYQwNq2shemQ5mhGv36yK6VBweVtzx`.

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
  A transfer or purchase changes only `$ownerId`, `$revision` and
  `$transferredAt`; `records.identity` still names the original identity. On
  protocol 14 `records.identity` is not even checked against the registrant
  when the name is created.
- Domain documents cannot be replaced or deleted, so a name has exactly one
  document, with one `$id`, for as long as it exists.
- `domain` has no index on `$ownerId`. "Names I own" can only be listed through
  `records.identity`, which misses names that were bought or received.
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
| **Platform documents** (chunks) | yes (new documents) | field ≤ 5,120 B, transition ≤ 20,480 B, one document per transition; measured on testnet at about 27,450 credits per byte plus 24 M per chunk, so about 0.3 DASH per MB; deleting a chunk refunds most of it | only a Platform identity | yes: proofs for the record, hashes for content |
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
   pages, small apps (tens to hundreds of KB; 100 KB costs about 0.03 DASH).
3. Large sites can point the same record at `ipfs://<cid>`. The record format,
   CLI (`dash-sites point`) and resolver accept it today; the gateway does not
   serve IPFS content yet and says so. The scheme list is open, so `ar://` can
   follow without a contract change.

### The `dash-sites` contract

Two document types ([`contract/dash-sites.v1.json`](../contract/dash-sites.v1.json)).
Anyone may create documents; what counts is decided by the resolution rule
(§4), not by who got there first.

```
site      mutable, deletable, not transferable
  domainId 32 bytes  $id of the DPNS domain document the site is published under
  name     string    normalized name, for display only (readers trust domainId)
  content  string    content URI, printable ASCII, ≤ 2048 chars
  unique index ($ownerId, domainId)

chunk     immutable, deletable, not transferable
  hash     32 bytes  sha256(d0 ‖ d1 ‖ d2)
  d0,d1,d2 bytes     up to 4,900 each (14,700 per chunk)
  unique index ($ownerId, hash)
```

A site is keyed by the domain document's id, not by the label. A label key
could not be changed later (indexes are fixed once documents exist), is capped
at 63 characters, and could not tell `blog.alice.dash` from `blog.dash`. The
document id works for a name at any depth, so subdomain names can be added
without a new contract.

The key is not globally unique on purpose. A global unique index would let
anyone squat Alice's slot in this contract before she publishes. With
`($ownerId, domainId)` each identity has its own slot, and only the slot of the
name's current DPNS owner is ever read.

Chunks are keyed per owner for the same reason: nobody can occupy or delete a
chunk another publisher depends on. Chunks are deletable so that a publisher
can reclaim the storage refund after replacing a site. Neither type can be
transferred, so nobody can plant a document in someone else's slot.

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

A manifest must be in canonical form (sorted keys, no whitespace), so one
site has one content URI and republishing it unchanged stores nothing.

Limits a reader enforces: manifest ≤ 30 chunks (441 KB compressed) and ≤ 4 MB
decoded, ≤ 5,000 files, site ≤ 50 MB decoded, path ≤ 512 bytes. Decompression
stops at the declared size. The gateway sets lower limits (25 MB per site).

## 4. Resolution

Input: a name, e.g. `Alice.dash` (or a gateway host label).

1. **Normalize** the label (lowercase; `o→0`, `i,l→1`); reject anything that is
   not a valid DPNS label, and labels of the `xn--` form (see §6). v1 handles
   second-level names (`label.dash`) only.
2. **Name**: query DPNS `domain` where `normalizedParentDomainName == "dash"`
   and `normalizedLabel == <label>`, with proof. No document: the name is not
   registered.
3. **Controller**: the domain document's **`$ownerId`**. Not
   `records.identity`: that field never changes, so after a sale it still names
   the seller, who must not keep the website. The SDK's `dpns.resolveName`
   reads `records.identity` and is not used.
4. **Site record**: query `site` where `$ownerId == controller` and
   `domainId == <domain $id>`, with proof. No document: the name has no site.
   A site record last updated before the name's `$transferredAt` is ignored,
   so a name that returns to a previous owner does not bring an old site back.
5. **Content**: by scheme. For `dash-manifest`, fetch the manifest chunks
   (`$ownerId == controller`, `hash in […]`, 100 per query), verify, parse;
   then fetch the chunks of the requested file, verify, decode.

Both proofs are absence-capable: "no such name" and "no site" are proved too.
A contested name has no domain document until it is awarded, so it resolves as
unregistered.

**Canonical host.** Several spellings normalize to one name. To give a name one
origin, the canonical host label is the domain document's `label` lowercased
(`Alice` → `alice`); the gateway redirects every other spelling (`a1ice`,
`ALICE`) to it.

**Freshness.** Proofs carry the block height and time inside the signed state.
The SDK refuses an answer whose block time is more than 31 minutes from the
clock (observed during a testnet stall: every read failed until blocks
resumed). On top of that the gateway never replaces a cached resolution with
one proved at a lower height.

**When Platform is unreachable.** A site should not go down because the chain
stalls. The gateway keeps serving the last resolution it proved for up to 24
hours and marks those responses `X-Dash-Stale: 1`; a name it has never
resolved gets a 503.

**Shared code.** These rules, the manifest and path rules, and the serving
decisions live once in `@dash-sites/core`; the gateway, the CLI, the builder
and the extension all call the same functions.

## 5. Surfaces

### Builder

- **Web app** (static, hosted on GitHub Pages, on a different registrable
  domain from user sites): sign in with identity id or
  name plus an AUTHENTICATION key (HIGH or CRITICAL) that never leaves the
  page; choose or register a DPNS name; build a site from a template with a
  Markdown editor, or drop in a folder/zip of a static site; preview; see the
  cost estimate; publish with per-chunk progress.
- **CLI** `dash-sites`: `publish <dir> --name alice`, `point --content
  ipfs://<cid>`, `register`, `names`, `resolve`, `fetch`, `unpublish`, `gc`
  (delete unreferenced chunks), `gateway` (run a local gateway).
- Both use `@dashevo/evo-sdk` (wasm) directly against DAPI. There is no
  publishing server.

### Gateway

A Node HTTP service behind Caddy, which terminates TLS.

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
  verified chunks and files in bounded in-memory caches, keyed by hash.
  Responses carry `ETag` (the file hash) and `Cache-Control: public,
  max-age=60`. A change shows up within about a minute.
- **Serving**: GET/HEAD only. `/` → `/index.html`; `/dir/` →
  `/dir/index.html`; `/page` → `/page.html` when present; missing → the site's
  `/404.html` with status 404; `spa` fallback. Content type from the manifest.
- **Headers**: `X-Content-Type-Options: nosniff`, `Referrer-Policy`, HSTS,
  `Origin-Agent-Cluster: ?1`, and the proved facts `X-Dash-Name`,
  `X-Dash-Owner`, `X-Dash-Site-Revision`, `X-Dash-Content`,
  `X-Dash-Proof-Height`. The only cookie is the owner-epoch cookie of §6.
- **ACME**: `/.well-known/acme-challenge/` is never served from a site, and a
  CAA record limits issuance to DNS-01, so a site cannot obtain a certificate
  for its own gateway hostname.
- **Abuse**: a denylist (name, owner identity, or content hash) answers 451;
  per-IP rate limits; size limits; an abuse contact on the landing page. A
  takedown removes a site from this gateway, not from Platform.

### Extension (Chromium MV3; Firefox MV3 build from the same source)

- **Navigation**: a declarativeNetRequest rule redirects `http(s)://<label>.dash/…`
  to `https://<label>.<gateway>/…`, for page and frame navigations only. The
  omnibox keyword `dash` opens a name directly. Chrome treats a bare
  `alice.dash` as a search because `.dash` is not a TLD it knows, so the
  extension also watches navigations (the `webNavigation` permission) and
  turns a search for exactly a `.dash` name into a visit. That can be turned
  off in the settings.
- **Gateway choice**: default public gateway; the user can set another,
  including a local one (`dash-sites gateway` on `*.localhost`), which is the
  trustless setup, as with IPFS Companion and a local node.
- **Independent check**: the popup resolves the current site itself, with
  proofs over DAPI, compares the gateway's `X-Dash-*` claims (owner, revision,
  content URI) with the proved record, and checks the page's file against the
  hash in the proved manifest. This catches a gateway that is stale, broken or
  serving a different site. It is an audit, not enforcement: the popup fetches
  the page again, so a gateway built to deceive could answer that fetch
  honestly, and MV3 cannot inspect the bytes a tab received.
- Rejected: a PAC proxy that keeps `http://alice.dash` in the address bar. It
  gives an insecure context (no service workers, no WebCrypto) and no TLS.

## 6. Security

- **Who controls a site**: the DPNS name's current `$ownerId`, proved. A site
  document from anyone else is never read.
- **Proofs vs trust**: the gateway verifies proofs, so a lying DAPI node cannot
  change a site. A browser user without the extension trusts the gateway
  operator and its TLS, exactly as with eth.limo and dweb.link. Users who do
  not want that run a local gateway (`dash-sites gateway`, on `*.localhost`).
  One trusted party remains in every setup today: SDK 5.0.3 takes the quorum
  public keys that proofs are checked against from the network's quorum
  service. The SDK's `verified` mode, which proves those keys from a
  checkpoint, removes it once it is in a release.
- **A name that changes hands**: one origin per name means a buyer's site would
  inherit what browsers stored for the seller's site, and the seller's service
  worker would keep running. The gateway sets one host-only cookie,
  `__Host-dash-epoch=<owner>.<transferredAt>`. A page or service-worker
  request whose cookie is missing or different is answered with
  `Clear-Site-Data: "cache", "storage"`, which also unregisters service
  workers. A visitor who returns after a sale starts clean on first load; an
  old service worker dies at the browser's next update check (within a day).
- **Origin isolation**: one site per subdomain, so `localStorage`, IndexedDB,
  service workers and permissions are per name. The canonical-host redirect
  keeps a name from having several origins.
- **Cookies and the parent domain**: until the gateway domain is on the Public
  Suffix List, every site is same-site with everything else under the
  registrable domain. A site can set a cookie for the parent domain
  (`Domain=dashhq.org`) that sibling hosts then receive, read such cookies, or
  set so many that sibling hosts reject requests. The gateway itself reads
  only its `__Host-` cookie, which a subdomain cannot overwrite. The builder,
  which handles identity keys, is therefore on a different registrable domain
  (`thepasta.org`). The interim domain shares `dashhq.org` with other apps;
  the lasting fix is a dedicated registrable domain for user content, on the
  PSL (see §8).
- **Phishing and reputation**: user content under `dash.dev` shares its
  reputation with it (Safe Browsing flags by registrable domain unless the
  suffix is on the PSL). Recommendation for the final domain: PSL entry before
  launch, or a dedicated domain.
- **Homographs**: DPNS normalization collapses `o/0`, `i/l/1`. Labels are
  ASCII, but DPNS allows `xn--…` labels, which browsers display as Unicode;
  the gateway, CLI, builder and extension refuse them.
- **Contested names**: resolve only after the masternode vote awards them.
- **Builder keys**: the key stays in the page's memory and is never stored;
  the builder is on a different registrable domain from user sites and sets a
  strict CSP (no inline or third-party script, no third-party requests except
  to Dash Platform nodes).
- **Gateway hardening**: bounded sizes everywhere, paths normalized before
  lookup, no filesystem paths derived from requests, runs as an unprivileged systemd
  service with a locked-down sandbox, holds no keys or DNS credentials.

## 7. Networks

Testnet first: the contract is registered on testnet and all three surfaces
default to it. The network, contract id and gateway domains are configuration.
Mainnet needs a funded mainnet identity to register the contract (about 0.17
DASH), then the contract id in `packages/core/src/config.ts` and
`NETWORK=mainnet` on a gateway. It is otherwise the same deployment.

## 8. Hosting

| Piece | Where | Why |
| --- | --- | --- |
| Gateway | DigitalOcean droplet `dash-sites-gateway` (1 GB, nyc3): the gateway as a systemd service, Caddy, and `agnos` for certificates | Wildcard TLS on a two-level name needs our own terminator; Cloudflare's free certificate covers only `*.dashhq.org` |
| DNS | Cloudflare zone `dashhq.org`: `id` and `*.id` to the droplet (DNS-only), `_acme-challenge.id` delegated to the droplet, CAA for Let's Encrypt DNS-01 | Existing access |
| Certificate | Let's Encrypt wildcard for `id.dashhq.org` and `*.id.dashhq.org`, renewed daily-checked by a systemd timer. `agnos` answers the DNS-01 challenge itself on port 53 during a renewal, so the host holds no DNS credentials | |
| Builder | GitHub Pages from the repo, `dash-sites.thepasta.org` | Static, free, deploys from CI, different registrable domain from user sites |
| Extension | Zip on GitHub Releases; store listing later | Store accounts are the user's |

`deploy/provision.sh` sets up a fresh host and `deploy/deploy.sh` installs a
new gateway build.

**Moving to `dash.dev`.** The gateway serves every domain in
`GATEWAY_DOMAINS`, and the builder and extension take the gateway domain as a
build setting and a user setting.

1. Decide the host. Serving sites directly under `dash.dev` puts user content
   on the same registrable domain as dash.dev's own pages, with the cookie and
   reputation problems of §6, and names such as `wallet.dash.dev` would look
   official. A dedicated domain on the Public Suffix List avoids that. If it
   must be `dash.dev`, reserve its existing hostnames in `RESERVED_LABELS`.
2. DNS for the new domain: wildcard and apex records to the gateway, and the
   `_acme-challenge` NS delegation and CAA records as for `id.dashhq.org`.
3. Add the domain to `GATEWAY_DOMAINS` and to `deploy/provision.sh`'s
   certificate, redeploy.
4. Rebuild the builder with `GATEWAY_DOMAIN`, release the extension with the
   new default, and redirect the old domain's hosts to the new one so that a
   name keeps a single origin.

## 9. Out of scope for v1

Subdomain names (`blog.alice.dash`), custom DNS domains pointing at a name
(DNSLink in reverse), serving `ipfs://` content from the gateway, Arweave,
private sites, a site directory, a service-worker verifying client, starting
contested-name votes from the builder.
