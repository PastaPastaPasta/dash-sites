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
- Domain documents cannot be replaced, but their owner can delete them
  (`canBeDeleted: true`). From protocol 14 a document id is never produced
  twice, so a name registered again after a deletion is a new document with a
  new `$id`, and nothing published under the old id is served for it.
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

### What registration fixes

The contract's id and owner are permanent, and the owner can only add to it.
Platform's protocol 14 update rules (`validate_update` in rs-dpp 5.0.3) decide
what:

| An update can | An update cannot |
| --- | --- |
| Add a document type, with indexes, fees and moderator abilities of its own | Add, change or remove an index of `site` or `chunk` |
| Add an optional property to `site` or `chunk`, or a required one marked `requiredSince` | Remove a property, or stop requiring one (`name` stays required) |
| Raise `maxLength` and `maxItems` (a chunk field up to Platform's 5,120-byte limit), remove a `pattern` | Change a `pattern`, or whether `site` and `chunk` documents can be replaced, deleted or transferred |
| List properties under `immutable` | Give `site` or `chunk` a time to live, a fee, a token cost, a count or a `refersTo` check |
| Add tokens, keywords and a description | Let moderators delete `site` or `chunk` documents, start a banlist or a suspension list, hand moderation to an elected team, keep the contract's history, or make it read-only |

Three things follow from registering the contract as it is, and stay true of
`site` and `chunk` for good:

- **Only its owner can delete a document or be stopped from writing one.**
  The contract declares no `moderation`. A gateway can refuse to serve a site
  (§8), but no one can take it off Platform, and a publisher cannot be barred
  from the contract. What stays possible is a later document type whose
  documents the contract owner, or moderators it appoints, may delete.
- **Publishing pays Platform's fees and nothing else.** Neither type has an
  action fee or a token cost. A paid tier is a new document type.
- **Platform does not check that a publisher owns the name.** `domainId`
  carries no `refersTo`, so anyone may write a `site` document for any domain
  id; the resolution rule (§4) is what ignores it. A list of sites built from
  the `updated` index must prove each name's owner the same way.

`packages/core/test/contract.test.ts` parses the contract with Platform's
rules and holds these terms, so a change to the schema file is a deliberate
one.

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
  domain from user sites): sign in with a mobile wallet (below), or with an
  identity id or name plus an AUTHENTICATION key (HIGH or CRITICAL) that never
  leaves the page; choose a DPNS name (or register one, with a key sign-in);
  build a site from a template with a Markdown editor, or drop in a
  folder/zip of a static site; preview; see the cost estimate; publish with
  per-chunk progress.
- **CLI** `dash-sites`: `publish <dir> --name alice`, `point --content
  ipfs://<cid>`, `register`, `names`, `resolve`, `fetch`, `unpublish`, `gc`
  (delete unreferenced chunks), `preview` (serve a folder locally as a
  gateway would), `gateway` (run the server-rendered gateway locally).
- Both use `@dashevo/evo-sdk` (wasm) directly against DAPI. There is no
  publishing server.

**Signing in with a mobile wallet** is the builder's first choice. It is App
Connect v2, the `dashpay://connect` flow that DashPay for Android (11.9.2) and
Dash Wallet for iOS (9.1.4) answer and that Dash Forge and Yappr use. The
protocol code is theirs, vendored unchanged in
`packages/core/src/vendor/app-connect/`; what Dash Sites asks for is in
`packages/core/src/connect.ts`.

1. The builder makes a one-time key pair and shows a request as a QR code
   (and, on a phone, as a link that opens the wallet). The request asks for
   **one key**: AUTHENTICATION, HIGH, bound to the dash-sites contract
   (`singleContract`), proposing a budget of 0.2 DASH and 90 days. The app id
   is the dash-sites contract, so the wallet's rule that the bound contract
   and the app share an owner holds by construction. It carries a connection
   id (16 random bytes this browser keeps), no encryption binding and no
   callback URL.
2. The wallet's owner sees the app id, their username, the budget and the
   expiry, may change both limits, and approves. The wallet adds the key to
   the identity in one master-signed update (disabling the key it gave the
   same connection id before) and publishes it, encrypted to the request's
   key, as a `loginKeyResponse` document in the App Connect system contract.
3. The builder polls that contract with proved reads, decrypts each answer
   and checks it against the identity on chain: the key is live, bound to
   exactly the dash-sites contract, HIGH, has a budget and an expiry, is not
   about to expire and has budget left. Anything else is refused.
4. The builder asks "A wallet answered as `alice.dash`: continue?" before it
   uses the key.

The request's `CREATED_AT` is this device's clock held between the chain's
latest block time and 90 seconds past it: wallets refuse a request dated more
than two minutes ahead, and blocks can be minutes apart.

What the key can and cannot do: it signs `site` and `chunk` documents of the
dash-sites contract, so it can publish, replace and take down sites and
delete stored files. Platform refuses it for anything else, so it cannot
register or transfer names, move credits, or touch another app; the builder
hides name registration for a wallet sign-in and points to the wallet. It
stops working at its expiry or when its budget is spent, and the owner can
end it at any time by removing the connection in the wallet. A browser has
one live key per network: signing in again, in this tab or another, makes the
wallet replace the earlier key, and a tab still holding the old one is told
so when it next publishes.

### Gateway

The gateway is a static shell. Every host `<label>.<domain>` serves the same
files, whatever the name: a bootstrap page, a small service worker, and
the verifier, cached as immutable. The verifier is two files: a script (the
Platform reader, the SDK's JavaScript and a brotli decompressor, about 0.2 MB
compressed) and the SDK's WebAssembly, compressed with brotli at quality 11
(about 5.7 MB; the SDK's own bundle inlines it as base64 of gzip, which cost
9 MB on the wire). It is compressed ahead of time because Cloudflare
recompresses static assets at a low level and ignores a file's own
`Content-Encoding`; the worker decompresses it while it downloads. The
worker fetches both files itself, checks each against a SHA-256 built into
the worker (for the WebAssembly, of the decompressed bytes) before running
or instantiating anything, and keeps them in Cache Storage; browsers will not
store a worker script that large for a private window. The verifier build
patches the SDK bundle to drop the inline copy and to instantiate the module
the worker compiled; the build stops if the bundle no longer has the shape
the patch expects. The compressed file is named for the WebAssembly it
holds, so `sw.js` does not depend on the brotli encoder that built it. On a static deployment (`GATEWAY_DOMAIN`)
every name's worker fetches the verifier from the bare domain
(`https://dash.site/dash-sites-verifier-<hash>.js` and `….wasm.br`, CORS-enabled), so the
browser downloads it once for every name: until the domain is on the PSL all
names are one site, which is how browsers partition their HTTP cache. The
landing page starts that download when someone focuses its name box, and the
worker reports download progress to the bootstrap page. The server holds no site content and makes no Platform
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
  evonodes (`<ip>:443`, from the masternode list of the quorum key service);
  and the quorum key service `quorums.<network>.networks.dash.org` (see §6).
  Nothing else. `e2e/shell.mjs` asserts this list in Chromium.
- **Choosing nodes**: while the verifier downloads, the worker reads that
  masternode list (enabled nodes that passed the service's version check),
  sends an empty request to 10 random ones, and gives the SDK the first 4 to
  answer healthily (`packages/shell/src/nodes.ts`). Each document query then
  finds an open connection and a cached CORS preflight (DAPI allows 20 days;
  Chrome keeps 2 hours) instead of paying for both on a random, possibly
  distant node. With fewer than 2 answers within 2.5 s of the list, or if
  the pick is not done 0.6 s after the verifier is ready, the SDK chooses
  nodes itself. After the first failed query on the picked nodes, the worker
  moves to the SDK's own list for the rest of its life, so a short outage
  that gets the few picked nodes banned does not stall it. Which node
  answers cannot change what is shown beyond the SDK's tolerance for a node
  that is a little behind, as before: every answer is proof-checked. The
  cost is that the 10 probed operators see the visitor's address and the
  site's origin, and 4 of them see one visit's lookups rather than a random
  spread.
- **Caching**: a proved answer is reused for 30 s, then served while a fresh
  one is fetched. Verified chunks are kept in the origin's Cache Storage and
  re-hashed on every read. A worker that has just started serves nothing
  until Platform has answered: it keeps no record of the last site, because
  site code shares the origin and could have rewritten it, and showing a
  remembered site would run that code before the check (§6). The cost is one
  proof query (about a second) on the first page load after the browser has
  stopped the worker, and no offline viewing. Until that answer arrives, a
  page load gets the bootstrap page, built into the worker, which shows
  progress and loads the site once the name is proved.
- **Contracts**: the readers start from snapshots of the DPNS and dash-sites
  contracts bundled in the verifier (`scripts/snapshot-contracts.mjs`), so
  proving a name needs two queries, not four. A background query checks that
  the snapshots are still the contracts' current versions and replaces any
  that are not.
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
  worker. The fallback process and, on hosted gateways, the browser's worker
  keep a denylist by name, owner and content hash (§8, operator denylist). A takedown removes a site from
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
     visitors or as an update. What narrows this: the shell is the same for
     every name and built reproducibly from the repository; `sw.js` (about
     40 KB) contains the SHA-256 of the verifier's files and refuses to run one that
     does not match, so `sw.js` is the only file whose honesty matters, and
     browsers replace an installed worker only when `sw.js` itself changes;
     `shell.json` beside it lists the SHA-256 of each file for anyone
     comparing a host against a build; the bootstrap page carries a CSP that
     allows only its own script by hash. None of these binds the host: a
     browser cannot be told to pin a service-worker script, and Subresource
     Integrity does not apply to one. The fix available today is to serve the
     shell from a host the user controls (their own machine). Signed, pinned
     web bundles would close it for public hosts if browsers ship them.
  2. **Quorum public keys.** SDK 5.0.3 verifies proofs against quorum public
     keys it downloads from `quorums.<network>.networks.dash.org`, a service
     run by Dash Core Group, over TLS. Whoever controls that service, together
     with a lying DAPI node, could forge a proof. The evonode addresses come
     from the same service's masternode list, so it adds no other party. The SDK's
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
  - Residual: a page of the previous owner's site that is still open when
    the name is transferred. A well-behaved one is navigated to the reset
    page by the worker's next check. A hostile one can avoid that: it stops
    making requests so the browser stops the worker, watches Platform for
    the transfer itself, and writes the new epoch into the saved state, so
    the next worker sees nothing to reset. For as long as that tab stays
    open the reset can be skipped. This cannot be fixed within one origin;
    it needs an origin per owner epoch rather than per name.
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
  The testnet builder, which handles identity keys, is therefore on a different
  registrable domain (`thepasta.org`). The mainnet builder at `dash.site/new`
  is not: it is served on the bare host only, never on a name's host, with
  `frame-ancestors 'none'`, COOP and `Origin-Agent-Cluster`, and needs no
  cookies; a site can still make it fail for a visitor by cookie bombing,
  until `dash.site` is on the PSL. The interim domain shares `dashhq.org`
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
- **Builder keys**: a pasted key stays in the page's memory and is never
  stored. A key from a wallet is kept in `sessionStorage`, so a reload does
  not need another approval; it is gone when the tab closes or on sign-out,
  and it is the limited key described in §5, not a key of the wallet. On
  `dash.site/new` it is not kept at all, and a reload asks the wallet again.
  The builder sets a
  strict CSP (no inline or third-party script, no third-party requests except
  to Dash Platform nodes); wallet sign-in needed no change to it, and the
  preview frame is sandboxed without scripts.
- **Who answered a wallet sign-in**: the request names no website and anyone
  who sees the code can answer it from their own identity. The builder
  therefore refuses a request that two identities answered (every answer that
  decrypts counts, usable or not, and a failed read never counts as "nobody
  else"), always shows the answering name and identity for confirmation, and
  tells the user to scan only a code shown on its own address. A lookalike
  page can show a code with the same app id and label; what it would get is
  the same limited key. Signing out forgets the key in the browser but cannot
  disable it on chain: the next sign-in from the same browser does (same
  connection id), and so does removing the connection in the wallet.
- **Gateway host hardening**: the fallback process has bounded sizes
  everywhere, normalizes paths before lookup, derives no filesystem paths
  from requests, runs as an unprivileged systemd service with a locked-down
  sandbox, and holds no keys or DNS credentials.

## 7. Networks

Testnet first: the contract is registered on testnet and all three surfaces
default to it. The network, contract id and gateway domains are configuration.
The mainnet contract, `5cDiGVXZzsLs5e8Tqyje9UR5corRxjHFck7VxC6k7m4s`, was
registered from the same schema (about 0.17 DASH) and is in
`packages/core/src/config.ts`; `NETWORK=mainnet` selects it. It is otherwise
the same deployment.
Registering is final in the ways §3 lists under "What registration fixes".

A gateway runs on a network before its contract exists: the reader proves
names as usual and every registered name resolves to "no site yet", and the
landing page says publishing has not opened.

## 8. Hosting

| Network | Gateway | Runs on |
| --- | --- | --- |
| Mainnet | `dash.site`, `*.dash.site` | Cloudflare Worker `dash-site`, static assets only |
| Mainnet publishing | `dash.site/new*`, `dash.site/publish*` | Cloudflare Worker `dash-site-app`, static assets only: the builder and the publish page, on the bare host only so no site origin serves a page that takes keys; CSP with `frame-ancestors 'none'` |
| Testnet | `id.dashhq.org`, `*.id.dashhq.org` | DigitalOcean droplet `dash-sites-gateway` (Caddy + fallback process) |

| Piece | Where | Why |
| --- | --- | --- |
| `dash.site` | An assets-only Cloudflare Worker (`deploy/cloudflare`): no Worker script, so no request runs code and static asset requests are free and unmetered. Routes `dash.site/*` and `*.dash.site/*`; `not_found_handling: single-page-application` answers every path with the shell | No server to run. Cloudflare's free certificate covers `dash.site` and `*.dash.site` |
| `id.dashhq.org` | A 1 GB droplet: Caddy serving the static shell on every name's host, the fallback process as a systemd service, and `agnos` for certificates | Wildcard TLS on a two-level name needs our own terminator; Cloudflare's free certificate covers only `*.dashhq.org` |
| DNS | Zone `dash.site`: apex and `*` proxied A `192.0.2.1` and AAAA `100::` (placeholders; the Worker routes answer, over IPv4 and IPv6). Zone `dashhq.org`: `id` and `*.id` to the testnet droplet (DNS-only), `_acme-challenge.id` delegated to the droplet, CAA for Let's Encrypt DNS-01 | Existing access |
| Builder | GitHub Pages from the repo, `dash-sites.thepasta.org` | Static, free, deploys from CI, different registrable domain from user sites |
| Extension | Zip on GitHub Releases; store listing later | Store accounts are the user's |

`deploy/cloudflare/deploy.sh` builds the shell for `dash.site` and deploys the
Worker (`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`; mainnet by default). `deploy/provision.sh` sets up a
droplet and `deploy/deploy.sh` installs the shell, the fallback process and the
Caddy configuration on it.

### dash.site: static files only

Every host under `dash.site` gets the same files: `index.html` (the boot page),
`sw.js` (the service worker) and the verifier. The boot page installs the
worker, which reads and verifies the site in the browser, exactly as on a
droplet gateway. What changes without a server:

- **Origins stay separate.** Each name is still its own host,
  `alice.dash.site`, so each site has its own origin, storage and service
  worker (§6). Only the bare `dash.site` and `www.dash.site` are not names: the
  boot page shows the landing page there and installs nothing.
- **No fallback process.** Crawlers, link previews and command-line clients
  get the boot page, not a rendered copy of the site. A browser without
  service workers (a Firefox private window, for one) gets a plain page saying
  so. Over plain `http://` (no service workers outside a secure context) the
  boot page moves to `https://` itself, since the Worker cannot redirect.
- **No operator denylist in the build.** The `dash.site` build leaves the
  denylist out (`DENYLIST` unset). Blocking is done in front of it instead.
- **Caching.** `_headers` sends `Cache-Control: no-cache` for everything but
  the content-addressed verifier, so a browser revalidates `/sw.js` on every
  navigation and a new worker, or a kill-switch worker, takes effect on the
  next visit.

**Blocking a name on dash.site, when needed.** Route the exact host,
`badname.dash.site/*`, to a second assets-only Worker; Cloudflare uses the
most specific route, so it wins over `*.dash.site/*`. That Worker serves two
files and runs no script:

- `/sw.js`: `packages/shell/src/denied-sw.js`, a worker that deletes the
  origin's Cache Storage, unregisters itself and reloads open pages (the
  site's IndexedDB and localStorage stay in the browser). A visitor whose
  browser already has the site's worker gets this on its next update check:
  a browser keeps an installed worker when an update fails, so the blocked
  host must answer `/sw.js` with this file rather than an error.
- everything else: a plain "unavailable on this gateway" page
  (`not_found_handling: single-page-application` with that page as
  `index.html`).

Adding a name is a PR that adds its route to that Worker's `wrangler.jsonc`,
then a deploy. Use the registered label in lowercase: the worker serves a
site only on its canonical host and redirects look-alike spellings there, so
other spellings need no route. Keep Rocket Loader, Email Obfuscation and
automatic Web Analytics off on the zone: they rewrite the boot page and break
its script hash. The site stays on Platform and other gateways may
serve it.

### Operator denylist (droplet gateways)

A droplet gateway can stop serving a name, an owner identity or a content
URI. On the host:

```sh
ssh root@id.dashhq.org dash-sites-deny add name foo "reason"
ssh root@id.dashhq.org dash-sites-deny add owner <identity id> "reason"
ssh root@id.dashhq.org dash-sites-deny add content <content URI> "reason"
ssh root@id.dashhq.org dash-sites-deny list
ssh root@id.dashhq.org dash-sites-deny remove name foo
```

The list is `DENYLIST_FILE` (`/etc/dash-sites/denylist.txt`). Each change
takes effect in three places:

- Caddy refuses a denied name by host at once, in every DPNS look-alike
  spelling (a `header_regexp Host` matcher): a 451 notice
  (`unavailable.html`), and a `/sw.js` that removes an installed worker.
  `dash-sites-deny` regenerates `/etc/dash-sites/denied.caddy`, validates the
  configuration and reloads Caddy, and keeps the old file if Caddy rejects it
  (the list itself is already updated for the next two places).
- The fallback process (crawlers, command-line clients) re-reads the file
  within 5 seconds and answers 451.
- Browsers with the worker already installed fetch
  `/.well-known/dash-gateway/denylist.json` at most once a minute, so owners
  and contents, which have no host to refuse, are refused within 60 seconds.
  The worker answers from the list it has, or the one an earlier worker saved
  in Cache Storage, while one refresh runs in the background, and gives up on a
  fetch after 5 seconds. Only a browser with no saved list waits for that fetch.
- A list the gateway process cannot parse is logged and ignored: on a reload
  it keeps the previous list, and on start it runs with none. `deploy.sh` and
  `dash-sites-deny` refuse such a list before it is written.

Names are matched in DPNS normal form, so look-alike spellings are refused
together, and `remove name` removes every spelling. Every line of the list is
checked; a line that is not a DPNS label, an identity id or a content URI
without spaces or `#` stops the change, and `deploy.sh` checks the list
before it swaps anything. A denial removes a site from this gateway only; the site stays on
Platform and other gateways may serve it. The check in the worker is built
only for hosted gateways (`DENYLIST=1`); a self-hosted shell has none.

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
