# Dash Sites: websites on DPNS names

Status: implemented on testnet. Date: 2026-11-21. Testnet contract: `3JRHRkyYZiwGS6xYQwNq2shemQ5mhGv36yK6VBweVtzx`.

Dash Sites lets the owner of a DPNS name (`alice.dash`) publish a static website
under that name, and lets anyone open it:

- in any browser, at `https://alice.<gateway-domain>/` (interim
  `alice.id.dashhq.org`, later `alice.dash.dev`). The gateway host sends a
  static shell; the visitor's browser reads the site from Dash Platform and
  verifies it. The server does not serve site content on that path;
- in a browser with the extension, by typing `alice.dash` or following a
  `http://alice.dash/` link;
- from the command line or a shell served from their own machine, with no
  third party's server involved.

It has three parts that share one protocol library: a **builder** (web app and
CLI) that publishes, a **gateway** (a static shell with a service worker, plus
a small server-rendered fallback) that opens sites in any browser, and an
**extension** that resolves `.dash` names.

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
- **Service Worker Gateway** (`inbrowser.link`, helia-service-worker-gateway):
  every subdomain serves the same static page, which installs a service
  worker. The worker runs the IPFS client in the browser, fetches and verifies
  blocks itself, and answers every request on that origin. The server hosts
  only the static files, and trust in content moves from the gateway operator
  to verification in the browser. Dash Sites' gateway follows this model.

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
  (delete unreferenced chunks), `preview` (serve a folder locally as a
  gateway would), `gateway` (run the server-rendered gateway locally).
- Both use `@dashevo/evo-sdk` (wasm) directly against DAPI. There is no
  publishing server.

### Gateway

The gateway is a static shell. Every host `<label>.<domain>` serves the same
three files, whatever the name: a bootstrap page, a small service worker, and
the verifier (the Dash SDK, about 9 MB compressed, content-hashed and cached
as immutable). The server holds no site content and makes no Platform
queries for browsers.

- **First visit**: the bootstrap page registers the service worker for that
  origin and reloads. From then on the worker answers every navigation and
  subresource request on the origin, so relative links, CSS, scripts, images
  and back/forward work as on any site, and the address bar shows a real
  `https://alice.<domain>/` URL.
- **What the worker does**: §4, in the browser. It takes the name from its
  own hostname, proves the DPNS document and the owner's site record over
  DAPI, loads the manifest, fetches the chunks a request needs, and checks
  every chunk and file against its SHA-256 before answering. Anything that
  does not verify is refused.
- **What the browser contacts**: the gateway host for the shell; Dash Platform
  evonodes (`<ip>:1443`, from the address list compiled into the SDK); and
  the quorum key service `quorums.<network>.networks.dash.org` (see §6).
  Nothing else. `e2e/shell.mjs` asserts this list in Chromium.
- **Caching**: a proved answer is reused for 30 s, then served while a fresh
  one is fetched. Verified chunks are kept in the origin's Cache Storage and
  re-hashed on every read. A worker that has just started serves nothing
  until Platform has answered: it keeps no record of the last site, because
  site code shares the origin and could have rewritten it, and showing a
  remembered site would run that code before the check (§6). The cost is one
  proof query (about a second) on the first page load after the browser has
  stopped the worker, and no offline viewing.
- **Serving**: GET/HEAD only. `/` → `/index.html`; `/dir/` →
  `/dir/index.html`; `/page` → `/page.html` when present; missing → the site's
  `/404.html` with status 404; `spa` fallback; single byte ranges. Content
  type from the manifest, with `nosniff`.
- **Host API**: under `/.well-known/dash/` on its own origin a site can read
  `site.json` (its proved record, and `servedBy`: `browser` or `gateway`),
  `manifest.json`, and `resolve/<name>`. A page therefore does not need to
  know which host serves it. The showcase site uses this to show its own
  record.
- **After the first visit** the gateway is not needed: the worker is installed
  and keeps serving from Platform if the gateway host is unreachable.
  Browsers re-fetch `/sw.js` to look for updates, at most daily.
- **Limits of the model**: a site cannot register its own service worker (the
  origin's worker is the shell), and requests other than GET and HEAD get 405.
  Private windows in Firefox have no service workers; the bootstrap page says
  so.
- **Server-rendered fallback**: the earlier design, a Node process that
  resolves, verifies and serves content itself, still runs behind the same
  hosts for clients that cannot run the shell: crawlers, link previews and
  command-line tools, selected by `User-Agent`. It also serves the landing
  page and a JSON resolve API on the bare domain. Browsers never reach it for
  site content; stopping the process leaves sites working (`e2e/shell.mjs`
  passes against a host whose process is stopped).
- **Hosts, DNS, TLS**: wildcard `*.<domain>` and the apex, DNS-only, to the
  host. One wildcard certificate by ACME DNS-01; the host answers the
  challenge itself through an NS delegation of `_acme-challenge`, so no
  DNS-provider credentials live there. A CAA record limits issuance to DNS-01
  and `/.well-known/acme-challenge/` is never served from a site, so a site
  cannot obtain a certificate for its own hostname.
- **Abuse**: the shell holds no content, so the operator refuses a name by
  host: a 451 notice, and a replacement `/sw.js` that removes the installed
  worker (`deploy/denied.caddy.example`). The fallback process keeps its
  denylist by name, owner and content hash. A takedown removes a site from
  this gateway, not from Platform, and a browser that never checks back for
  a worker update keeps its copy.
- **Self-hosting**: the shell is three static files and works from any static
  host with a wildcard name, including `*.localhost`
  (`npm run serve -w @dash-sites/shell`).

### Extension (Chromium MV3; Firefox MV3 build from the same source)

- **Navigation**: a declarativeNetRequest rule redirects `http(s)://<label>.dash/…`
  to `https://<label>.<gateway>/…`, for page and frame navigations only. That
  host is the shell, so the site is fetched from Platform and verified in the
  browser; the extension does not route content through anyone's server. The
  omnibox keyword `dash` opens a name directly. Chrome treats a bare
  `alice.dash` as a search because `.dash` is not a TLD it knows, so the
  extension also watches navigations (the `webNavigation` permission) and
  turns a search for exactly a `.dash` name into a visit. That can be turned
  off in the settings.
- **Why not serve sites from the extension itself.** Bundling the shell would
  remove the dependency on a static host, and was evaluated:
  - An extension page (`chrome-extension://<id>/…`) is one origin for every
    site. Site code there would have the extension's privileges, so it must
    be sandboxed, and a sandboxed frame has an opaque origin: no storage, no
    cookies, no service worker, and its requests are not seen by the
    extension's worker, so every URL in HTML, CSS and scripts would have to
    be rewritten to blobs. The address bar would show the extension URL.
  - Chrome gives extensions no way to answer a request for a web origin with
    their own bytes, and a service-worker script cannot be redirected, so an
    extension cannot install the shell on `alice.<gateway>` without that host
    answering.
  - Firefox can rewrite response bodies (`webRequest.filterResponseData`) and
    proxy `*.dash` (`proxy.onRequest`), which would keep `alice.dash` in the
    address bar. It still needs some server to answer the proxied request,
    and `http://alice.dash` is not a secure context (no service workers, no
    WebCrypto), so the extension would have to answer every request itself.
    Not built.
  Real per-name origins with storage, a real URL, and verification in the
  browser were judged worth more than removing the static host, whose role is
  now three public files. The remaining dependency is bounded: the gateway
  setting accepts any shell host, including one on the user's own machine
  (`http://localhost:8080`), which is the no-third-party setup; and after
  the first visit a site works without the host.
- **Independent check**: the popup resolves the current site with its own
  copy of the SDK, with proofs over DAPI, and compares the result with what
  the page was served: the `X-Dash-*` facts (owner, revision, content URI)
  and the SHA-256 of the page's file against the proved manifest. It reads
  those from inside the tab, the only place a request takes the path the page
  did. This catches a shell that is stale or broken. It is not a defence
  against a hostile shell, which controls that same path, and a site's own
  script could interfere with the reading; the owner, revision and proof
  height the popup shows come from the extension's own query either way.

## 6. Security

- **Who controls a site**: the DPNS name's current `$ownerId`, proved. A site
  document from anyone else is never read.
- **Where trust sits.** Content trust rests on verification in the visitor's
  browser, not on the gateway's server. A lying DAPI node cannot change a
  site, and neither can the gateway's fallback process, which browsers do not
  use. What remains trusted:
  1. **The shell.** The code that verifies is delivered by the gateway host. A
     dishonest or compromised host could send a different worker, to new
     visitors or as an update. Mitigations: the shell is the same for every
     name and built reproducibly from the repository; `shell.json` beside it
     lists the SHA-256 of each file; the bootstrap page carries a CSP that
     allows only its own script by hash; the verifier file is content-hashed.
     None of these binds the host. Subresource Integrity cannot pin a
     service-worker script, and browsers offer no way to pin one. The fix
     available today is to serve the shell from a host the user controls
     (their own machine). Signed, pinned web bundles would close it for
     public hosts if browsers ship them.
  2. **Quorum public keys.** SDK 5.0.3 verifies proofs against quorum public
     keys it downloads from `quorums.<network>.networks.dash.org`, a service
     run by Dash Core Group, over TLS. Whoever controls that service, together
     with a lying DAPI node, could forge a proof. The evonode addresses are
     compiled into the SDK, so no seed service is contacted. The SDK's
     `verified` mode, which proves quorum keys from the Core chain, removes
     this once it is in a release; until then it is the one centralized
     service in the path, and it is not ours.
  3. **Dash Platform's validators**, as for every Platform application.
- **A name that changes hands**: one origin per name means a buyer's site would
  inherit what browsers stored for the seller's site. The worker saves one
  fact between runs: the owner epoch (`<owner>.<transferredAt>`) the origin's
  stored data belongs to. On start it proves the current epoch before serving
  anything and compares. If they differ, or the saved value is missing or
  malformed, it deletes the origin's Cache Storage, IndexedDB databases,
  private file system, storage buckets, push subscription and script-visible
  cookies, then sends the next page load through a reset page that clears
  `localStorage` and `sessionStorage`. The reset stays pending until that
  page reports back with a one-time code, and the page is served only while a
  reset is pending, so a link cannot erase a site's data and a frame cannot
  dismiss the reset. A first visit goes through the same reset once.
  - The previous owner's code cannot suppress this by deleting or corrupting
    the saved value: unknown means reset, and none of its code runs in a
    fresh worker before the check.
  - Residual: a page of the previous owner's site that is open at the moment
    of the transfer keeps running until the worker's next check (within 30 s
    of the next request) navigates it away. In that window it can still
    write to storage, including the saved epoch. Closing that fully needs an
    origin per owner epoch rather than per name.
  - Not cleared: permissions the visitor granted the origin (notifications,
    camera, location), which script cannot revoke, and cookies a site set
    with a `Path` other than `/`, which script can only see from under that
    path. `Clear-Site-Data: "cookies"` would remove them, but it acts on the
    whole registrable domain, so it has to wait for the gateway domain to be
    on the Public Suffix List.
- **Stored chunks are not trusted**: site code can write to the origin's
  Cache Storage, so the worker re-hashes every chunk it reads from there. A
  poisoned entry is a cache miss.
- **Origin isolation**: one site per subdomain, so `localStorage`, IndexedDB,
  and permissions are per name. The canonical-host redirect keeps a name from
  having several origins.
- **Cookies and the parent domain**: until the gateway domain is on the Public
  Suffix List, every site is same-site with everything else under the
  registrable domain. A site can set a cookie for the parent domain
  (`Domain=dashhq.org`) that sibling hosts then receive, read such cookies, or
  set so many that sibling hosts reject requests. The shell reads no cookies.
  The builder, which handles identity keys, is therefore on a different
  registrable domain (`thepasta.org`). The interim domain shares `dashhq.org`
  with other apps; the lasting fix is a dedicated registrable domain for user
  content, on the PSL (see §8). The PSL has a cost here: browsers partition
  the HTTP cache by site, so once each name is its own site, each name's
  first visit downloads the verifier again.
- **Phishing and reputation**: user content under `dash.dev` shares its
  reputation with it (Safe Browsing flags by registrable domain unless the
  suffix is on the PSL). Recommendation for the final domain: PSL entry before
  launch, or a dedicated domain.
- **Homographs**: DPNS normalization collapses `o/0`, `i/l/1`. Labels are
  ASCII, but DPNS allows `xn--…` labels, which browsers display as Unicode;
  the shell, gateway, CLI, builder and extension refuse them.
- **Contested names**: resolve only after the masternode vote awards them.
- **Builder keys**: the key stays in the page's memory and is never stored;
  the builder is on a different registrable domain from user sites and sets a
  strict CSP (no inline or third-party script, no third-party requests except
  to Dash Platform nodes).
- **Gateway host hardening**: the fallback process has bounded sizes
  everywhere, normalizes paths before lookup, derives no filesystem paths
  from requests, runs as an unprivileged systemd service with a locked-down
  sandbox, and holds no keys or DNS credentials.

## 7. Networks

Testnet first: the contract is registered on testnet and all three surfaces
default to it. The network, contract id and gateway domains are configuration.
Mainnet needs a funded mainnet identity to register the contract (about 0.17
DASH), then the contract id in `packages/core/src/config.ts` and
`NETWORK=mainnet` on a gateway. It is otherwise the same deployment.

## 8. Hosting

| Piece | Where | Why |
| --- | --- | --- |
| Gateway | DigitalOcean droplet `dash-sites-gateway` (1 GB, nyc3): Caddy serving the static shell on every name's host, the fallback process as a systemd service, and `agnos` for certificates | Wildcard TLS on a two-level name needs our own terminator; Cloudflare's free certificate covers only `*.dashhq.org`. The shell alone could sit on any static host with wildcard names |
| DNS | Cloudflare zone `dashhq.org`: `id` and `*.id` to the droplet (DNS-only), `_acme-challenge.id` delegated to the droplet, CAA for Let's Encrypt DNS-01 | Existing access |
| Certificate | Let's Encrypt wildcard for `id.dashhq.org` and `*.id.dashhq.org`, renewed daily-checked by a systemd timer. `agnos` answers the DNS-01 challenge itself on port 53 during a renewal, so the host holds no DNS credentials | |
| Builder | GitHub Pages from the repo, `dash-sites.thepasta.org` | Static, free, deploys from CI, different registrable domain from user sites |
| Extension | Zip on GitHub Releases; store listing later | Store accounts are the user's |

`deploy/provision.sh` sets up a fresh host and `deploy/deploy.sh` installs
the shell, the fallback process and the Caddy configuration.

**Moving to `dash.dev`.** The shell reads the name from whatever host it is
served on, so it needs no change. The gateway domain is `GATEWAY_DOMAINS` on
the host, a build setting of the builder, and a user setting of the extension.

1. Decide the host. Serving sites directly under `dash.dev` puts user content
   on the same registrable domain as dash.dev's own pages, with the cookie and
   reputation problems of §6, and names such as `wallet.dash.dev` would look
   official. A dedicated domain on the Public Suffix List avoids that. If it
   must be `dash.dev`, reserve its existing hostnames in `RESERVED_LABELS`.
2. DNS for the new domain: wildcard and apex records to the gateway, and the
   `_acme-challenge` NS delegation and CAA records as for `id.dashhq.org`.
3. Provision the certificate for the new domain (`deploy/provision.sh
   <domain> <ip>`), put the domain first in `GATEWAY_DOMAINS`, and run
   `deploy/deploy.sh`, which renders the Caddy configuration for it.
4. Rebuild the builder with `GATEWAY_DOMAIN` and release the extension with
   the new default.
5. Retire the old domain: serve `denied-sw.js` as its `/sw.js` so installed
   workers remove themselves, and redirect its hosts to the new domain. What
   a site stored in the browser under the old origin does not move with it.

## 9. Out of scope for v1

Subdomain names (`blog.alice.dash`), custom DNS domains pointing at a name
(DNSLink in reverse), serving `ipfs://` content from the gateway, Arweave,
private sites, a site directory, a site's own service worker, form posts,
serving sites from inside the extension, starting contested-name votes from
the builder.
