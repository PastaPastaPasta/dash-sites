# Dash Sites: websites on DPNS names

Status: implemented on testnet. Date: 2026-11-21. Testnet contract: `CjzpdgCPJdLgVZdUu8SNacWVnrhDv34LstjPdBeJ4dT` (registered 2026-11-25).

Dash Sites lets the owner of a DPNS name (`alice.dash`) publish a static website
under that name, and lets anyone open it:

- in any browser, at `https://alice.<domain>/` (mainnet `alice.dash.site`,
  testnet `alice.id.dashhq.org`). The host sends a static shell; the visitor's browser reads the site from Dash Platform and
  verifies it. The server does not serve site content on that path;
- in a browser with the extension, by typing `alice.dash` or following a
  `http://alice.dash/` link;
- from the command line or a shell served from their own machine, with no
  third party's server involved.

It has three parts that share one protocol library: a **builder** (web app and
CLI) that publishes, a **gateway** (a static shell with a service worker, plus
a small server-rendered fallback) that opens sites in any browser, and an
**extension** that resolves `.dash` names. On mainnet the shell is served as
the static site dash.site, with no fallback process (§8); of the hosted
deployments, only the testnet host `id.dashhq.org` runs the gateway process.

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
- Domain documents cannot be replaced. The schema lets their owner delete
  them (`canBeDeleted: true`), but on protocol 14 Platform refuses the delete
  ("Action is not allowed", tried on testnet): a name leaves its owner only by
  a transfer or a sale. The protocol 15 pre-releases, from Platform
  5.1.0-dev.2, let the owner delete a name, or tombstone it so that it cannot
  be registered again.
- `domain` has no index on `$ownerId`. "Names I own" can only be listed through
  `records.identity`, which misses names that were bought or received.
- Names are unique on `(normalizedParentDomainName, normalizedLabel)`.
  Normalization lowercases and maps `o→0`, `i→1`, `l→1`, so `alice`, `Alice`
  and `a1ice` are the same name.
- Labels of 3 to 19 characters from `[a-zA-Z01-]` are **contested**: masternodes
  vote, and the domain document exists only once the contest is won.
- A label is 3 to 63 characters of `[a-zA-Z0-9-]`, not starting or ending with
  `-`: always a valid DNS label.
- Every name is `<label>.dash`; DPNS has no `blog.alice.dash`.
  - `parentDomainName` must be one label with no dot, and only the contract
    owner can create a top-level domain. Genesis creates `dash`, the only one
    today.
  - Platform rejects a second-level name that allows subdomains (the
    `create_domain_data_trigger` in `rs-drive-abci`).
  - Dash Sites accepts only `<label>` or `<label>.dash` (`parseName` in
    `packages/core/src/names.ts`).

## 3. Storage and addressing

### Options

| | Mutable | Size and cost | Publisher needs | Verifiable |
| --- | --- | --- | --- | --- |
| **Platform documents** (chunks) | yes (new documents) | field ≤ 5,120 B, transition ≤ 20,480 B, one document per transition; measured on testnet at about 28,300 credits per byte plus 36 M per chunk, so about 0.3 DASH per MB; deleting a chunk refunds most of it | only a Platform identity | yes: proofs for the record, hashes for content |
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

Two document types ([`contract/dash-sites.v2.json`](../contract/dash-sites.v2.json)). Each carries a format version `v`; how formats and the contract change later is in [VERSIONING.md](VERSIONING.md).

```
site      mutable, never deleted, not transferable; only the name's owner writes it
  normalizedParentDomainName string  "dash"
  normalizedLabel            string  the DPNS name, e.g. a11ce; refers to the DPNS domain and its owner
  content                    string  content URI, printable ASCII, ≤ 2048 chars; absent: no site
  v                          integer format version, 1
  unique index (normalizedParentDomainName, normalizedLabel, $ownerId)
  unique index ($ownerId, normalizedParentDomainName, normalizedLabel)
  index        ($updatedAt), counted, so a proved count of records changed in a time range is possible

chunk     immutable, deletable, not transferable
  site     32 bytes  $id of the site record the chunk belongs to; carries an owner check
  hash     32 bytes  sha256(d0 ‖ d1 ‖ d2)
  d0,d1,d2 bytes     up to 4,900 each (14,700 per chunk)
  v        integer   format version, 1
  $createdAt         required, so gc keeps chunks a publish is still uploading
  unique index (site, hash)
```

**Only the owner of a name can write its site record, and readers check the
owner again.** `normalizedLabel` carries a `refersTo` into DPNS:

```
refersTo: { type: deletableDocument, contractId: <DPNS>, documentType: domain,
            findBy: { normalizedParentDomainName, normalizedLabel },
            where: { $ownerId: $ownerId } }
```

Consensus finds the name's `domain` document and refuses a create or replace
of a `site` document unless the writer is the name's `$ownerId` in that
block. Nobody can write a record for a name they do not own, or for a name
nobody has registered. A replace is checked the same way, so the previous
owner of a name that changed hands, or was deleted, can no longer change its
record. `normalizedParentDomainName` is immutable; `normalizedLabel` cannot
be, because Platform refuses a contract that lists a property carrying a
`deletableDocument` reference as immutable (5.1.0-rc.1). A replace can move a
record to another name only if its writer owns that name too, and a reader
then finds it under that name.

Readers do not rely on that alone. A reader never asks for "the site of a
name". It asks for the name's DPNS `domain` document and, in the same query,
for the `site` document whose `$ownerId` is that document's `$ownerId` (§4).
Platform answers both from one block under one proof, so what a reader shows
is the record of the identity that owns the name in that block, or nothing.
The write-time check says the writer owned the name when it wrote; the record
stays after the name is sold, transferred, deleted or tombstoned, and only
the read-time check keeps the previous owner's site from showing. Measured
against the live testnet, the read-time check adds no measurable time to a
resolve (PR #14), so both stay.

The reference ties every site write to DPNS in one way that matters. A
`refersTo` declares whether the target type's documents can be deleted
(`deletableDocument` or `permanentDocument`), and Platform compares the
declaration with the DPNS contract on every create and replace, not only at
registration, and refuses the write when they differ
([`document_reference_validation/v0/mod.rs:1329`](https://github.com/dashpay/platform/blob/5e9aff1c4835299773095494a7a1c53506d5b0f9/packages/rs-drive-abci/src/execution/validation/state_transition/state_transitions/batch/action_validation/document/document_reference_validation/v0/mod.rs#L1329),
[`document_reference_kind.rs:46`](https://github.com/dashpay/platform/blob/5e9aff1c4835299773095494a7a1c53506d5b0f9/packages/rs-drive-abci/src/execution/validation/state_transition/common/document_reference_kind.rs#L46),
Platform 5.0.3). A contract update cannot change a `refersTo`
([`rule_set.rs:1164`](https://github.com/dashpay/platform/blob/5e9aff1c4835299773095494a7a1c53506d5b0f9/packages/rs-json-schema-compatibility-validator/src/rules/rule_set.rs#L1164)).
DPNS declares names deletable (`canBeDeleted: true`) on protocol 14 and in
5.1.0-rc.1. During the protocol 15 pre-releases they were permanent in
5.1.0-dev.1
([DPNS v3, line 4](https://github.com/dashpay/platform/blob/5b73d83b50d721d008d638cbcea265f526b19f22/packages/dpns-contract/schema/v3/dpns-contract-documents.json#L4))
and deletable again from 5.1.0-dev.2
([line 4](https://github.com/dashpay/platform/blob/46d633940da19dfc70b6f75d0596a00d9b819f8b/packages/dpns-contract/schema/v3/dpns-contract-documents.json#L4)).
If a protocol version ever makes DPNS names permanent, this contract stops
taking site writes for good, the take-down included, and sites move to a new
contract. This risk was accepted for the owner check at write time;
`contract.test.ts` checks the DPNS snapshots of both networks for it.

What Platform does enforce on a site record: each identity has one record per
name (the unique index), so nobody can occupy another identity's slot. Records
cannot be transferred or traded, so none can be handed to another identity.
The time in `$updatedAt` is the block time, set by consensus, not by the
writer.

**Site records are never deleted** (`canBeDeleted: false`). Taking a site
down is a replace that leaves `content` out; the record stays and says "no
site". A record's `$id` is therefore a fixed address for the chunks stored
under it.

**Chunks belong to a site record, and Platform checks that.** `site` carries
`refersTo: { type: permanentDocument, documentType: site, where:
{ $ownerId: $ownerId } }`: consensus refuses a chunk unless the record exists
and the writer is the identity that wrote it. So everything stored under a
record's id was put there by the record's writer, and a reader needs no owner
filter when it reads a site's chunks. The reference stays inside this
contract, where the kind it declares is fixed by this contract's own schema:
a site record is a `permanentDocument` because it is never deleted. Chunks
are immutable, deletable so that a publisher can reclaim the storage refund
after replacing a site, and cannot be transferred. The same bytes used by two
names are stored once under each record.

Because the record is found by the name and its owner, and chunks by their
record, **one query reads a site**: a composite query whose page is the
name's DPNS `domain` document, whose first sub-query is `site WHERE <name>
AND $ownerId IN <the page's $ownerId>`, and whose second is `chunk WHERE site
IN <that record's $id>` (§4). Platform answers all three under one proof.

What Platform cannot or does not enforce, and readers check:

- **The writer of a site record owns the name now**, as above.
- **The record was written during the current ownership.** A record whose
  `$updatedAt` is earlier than the domain document's `$transferredAt` (its
  creation time for a name that never changed hands) is ignored. An identity
  that gets a name back, or registers a name it had written a record for,
  shows nothing until it writes the record again.
- **A chunk's bytes match its `hash`.** Platform has no rule that computes a
  hash of a stored byte array, so every reader hashes what it receives. A
  wrong chunk harms only its own publisher's site.
- **`content` names a manifest that exists.** A record pointing at chunks
  that were never stored, or deleted since, fails to load for that name only.

### What registration fixes

The contract's id and owner are permanent, and the owner can only add to it.
Platform's protocol 14 update rules (`validate_update` in rs-dpp 5.0.3) decide
what:

| An update can | An update cannot |
| --- | --- |
| Add a document type, with indexes, fees and moderator abilities of its own | Add, change or remove an index of `site` or `chunk` |
| Add an optional property to `site` or `chunk`, or a required one marked `requiredSince`; a new property may carry a `refersTo` check | Remove a property, or stop requiring one |
| Raise `maxLength` and `maxItems` (a chunk field up to Platform's 5,120-byte limit), remove a `pattern` | Give an existing property a `refersTo` check, or change or remove the one on `site.normalizedLabel` or `chunk.site` |
| List properties under `immutable`, except `normalizedLabel`: Platform 5.1.0-rc.1 refuses an immutable property whose `deletableDocument` reference is found by `findBy` | Change a `pattern`, or whether `site` and `chunk` documents can be replaced, deleted, transferred or traded |
| Add tokens, keywords and a description | Give `site` or `chunk` a time to live, a fee, a token cost or a doctype-level count |
| | Let moderators delete `site` or `chunk` documents, start a banlist or a suspension list, hand moderation to an elected team, keep the contract's history, or make it read-only |

Four things follow from registering the contract as it is, and stay true of
`site` and `chunk` for good:

- **Platform takes a site record only from the owner of the name.** If a
  protocol version makes DPNS names permanent, Platform refuses every site
  write instead, take-downs included (above). A record outlives the
  ownership it was written under; the resolution rule (§4) ignores it then.
  A list of sites built from the `updated` index must prove each name's
  owner the same way.
- **A site record cannot be removed from Platform, by anyone.** Its writer
  can empty it while it owns the name. Once the name is sold, transferred or
  deleted, the previous owner can no longer change the record under that
  name, so its last `content` stays there for good, unread. It can still
  move the record onto another name it owns and has no record for, and
  empty it there. Its chunks can still be deleted with `gc`.
- **Nobody can be stopped from publishing.** The contract declares no
  `moderation`. A gateway can refuse to serve a site (§8), but a publisher
  cannot be barred from the contract. What stays possible is a later document
  type whose documents the contract owner, or moderators it appoints, may
  delete.
- **Publishing pays Platform's fees and nothing else.** Neither type has an
  action fee or a token cost. A paid tier is a new document type.

`packages/core/test/contract.test.ts` parses the contract with Platform's
rules and holds these terms, so a change to the schema file is a deliberate
one.

Measured on testnet at protocol 14 on this schema: registering the contract
cost about 0.1814 DASH, the first site record for a name 0.0006 DASH, a
replace under 0.0001 DASH, and a write Platform refuses about 0.000014 DASH.
Measured on an earlier schema, before chunks carried `v` and `$createdAt`,
which add a few bytes each: a full chunk (14,700 bytes) cost 0.0046 DASH, a
one-page site 0.0014 DASH to publish and a 440 KB site 0.135 DASH.

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
So only the record read needs a proof; chunks can come from any cache.

A first publish writes the owner's site record without content, since chunks
are stored under it, then the chunks, then the record's content. Republishing
uploads only chunks whose hash the record does not already hold.

A manifest must be in canonical form (sorted keys, no whitespace), so one
site has one content URI and republishing it unchanged stores nothing.

Limits a reader enforces: manifest ≤ 30 chunks (441 KB compressed) and ≤ 4 MB
decoded, ≤ 5,000 files, site ≤ 50 MB decoded, path ≤ 512 bytes. Decompression
stops at the declared size. The gateway sets lower limits (25 MB per site).

### Manifest version 2: external npm assets and brotli

Storing a byte on Platform costs about 0.27 DASH per MB, once. A site that ships
an unmodified file of a published npm package (a 26 MB SDK wasm, say) can name
it instead of storing it:

```json
"/_next/static/wasm/wasm_sdk_bg.e9693c35d34d68e7.wasm": {
  "type": "application/wasm", "size": 26513399, "sha256": "<hex>", "parts": [],
  "ext": { "npm": "@dashevo/wasm-sdk", "version": "5.0.0-rc.8",
           "path": "dist/raw/wasm_sdk_bg.wasm",
           "integrity": "sha384-w5Q3Aw54F8HwCjSPF/bX+BQwWEP0e6bea4S63gs3+d/R7kbQQI9OpZPvHj4wCbVG" } }
```

and a file may be stored as brotli (`"enc": "br"`), which is a third smaller
than gzip for JavaScript and HTML.

**Trust model.** The SHA-384 (and the SHA-256 beside it) sit in the manifest,
which is fixed by the site record, which a Platform proof fixes: that hash is
the root of trust, exactly as for stored chunks. The npm CDNs are transport
only. A reader fetches `https://cdn.jsdelivr.net/npm/<pkg>@<version>/<path>`,
then `https://unpkg.com/<pkg>@<version>/<path>`, refuses redirects, reads at
most `size` bytes, and serves the file only if both hashes match; otherwise it
tries the next CDN, and with none left it serves an error page instead of the
file, so nothing from it runs. A CDN can withhold the file (the site then
cannot load that file) but cannot change it. Versions are exact (no ranges or
tags), so what a name resolves to never changes without a new site record. The
shell keeps a verified copy in Cache Storage and checks it again on every read,
since site code can write there. The CDNs are the only hosts contacted for an
external asset; the worker's own requests to Platform nodes go to their IP
addresses, so a header CSP on the worker could not be narrower than `https:`,
and the allowlist is enforced in code instead.

**Privacy.** Opening a site with an external asset tells jsDelivr and unpkg
the visitor's IP address and which package file they fetched, and the request
carries the site's origin (`Origin` header), as for any cross-origin fetch. A
CDN that does not answer within 15 seconds, or stalls for 30 seconds while
sending, is skipped for the next.

**Compatibility.** A manifest that uses neither feature stays version 1 and
byte-identical to before. One that uses either is version 2. Readers that only
know version 1 (older shells, gateways and extensions) reject version 2 whole,
showing their "cannot be shown" page, and the older `gc` stops with an error
instead of deleting chunks it cannot account for. `dash-sites publish
--external <map>` checks each named file against the local copy and against the
CDNs before publishing, and `--brotli` is opt-in.

### Manifest version 3: files kept at places

A file that is not on npm (a photo, a video, a script of the site's own) can
also stay off Platform. Its entry says where the file is instead of holding
it:

```json
"/img/hero.webp": { "type": "image/webp", "size": 184211, "sha256": "<hex>",
                    "parts": [],
                    "src": ["ipfs://bafy…", "https://media.example.com/hero.webp"] }
```

- `src` lists places as URIs, tried in order. Two kinds are fetched today: an
  `https://` address and an `ipfs://` CID (with an optional path). The entry
  has no parts and no `enc`. A manifest with any such file has `"v": 3`; one
  without stays at version 1 or 2, so older readers still open it. A file of
  an npm package uses `ext` above instead, so there is one way to keep each
  kind of file, and a version 3 manifest may hold both.
- The manifest is still proved, so `size` and `sha256` are the owner's. The
  shell serves the file only when a place returns exactly those bytes. A place
  is relied on to answer, never trusted for content, and the site's address
  for the file does not change.
- **HTTPS**: a plain GET with no cookies and no referrer, following redirects,
  reading at most `size` bytes. The host must let other sites read the file
  (`Access-Control-Allow-Origin: *`).
- **IPFS**: through Helia's `@helia/verified-fetch` with recursive gateways
  turned off, so blocks come from the providers that hold them and are checked
  against the CID before the whole file is checked against `sha256`. Finding
  the providers uses a delegated routing service (`delegated-ipfs.dev` unless
  the shell is built with `IPFS_ROUTERS`).
- The IPFS client is not a file of the shell's host. Its exact npm version and
  SHA-256 are constants in `packages/core/src/ipfs.ts`. The worker downloads it
  from jsDelivr or unpkg the first time a site asks for a file at an IPFS
  place, runs it only if the hash matches, and keeps it in Cache Storage,
  checking it again on every read. A site with no IPFS place never fetches it.
- Verified files are kept in the origin's Cache Storage under their hash and
  checked again on every read. If no place serves the file, that request gets
  a 502 and the rest of the site is unaffected.
- A file kept outside is read whole before any of it is served, so it is
  capped at 64 MiB, with at most 8 places. It does not count against the 50 MB
  a site may store on Platform.

**Staying compatible.** Versions 1 and 2 are closed: a key a reader does not
know makes the manifest invalid. Version 3 is open. Its reader ignores keys it
does not know (in the manifest and in a file entry) and skips places whose
kind it does not know. It refuses only the files it cannot read, each with a
502 of its own:

- a file whose `enc` it does not know;
- a file whose `src` is in a form it does not know: not a list of 1 to 8
  different URIs, given together with parts, an `enc` or an `ext`, or for a
  file that is empty or larger than 64 MiB;
- a file whose parts do not add up to its size, which is how a file stored
  under a key added later looks to it.

So a later shell can add a kind of place, a hash per piece for streaming,
another encoding, or another way to store a file, and an older shell keeps
serving everything it still understands. A change that older readers must not
ignore raises `v`, and a reader refuses a version above its own as a whole.
`ext` stays strict in every version: an entry that
names an npm file in a form this version does not accept makes the whole
manifest invalid, as before. A writer only emits what its own version reads,
and refuses to write an entry it would refuse to read.

Two rules keep deleting safe across versions. Every chunk a manifest uses on
Platform is listed in its `chunks`, whatever is added later. And `gc` and
`--prune` delete nothing for an identity while one of its manifests holds
something they do not know (a key they ignored, a file they cannot read), so
an older collector never deletes what a newer manifest may still need.

## 4. Resolution

Input: a name, e.g. `Alice.dash` (or a gateway host label).

1. **Normalize** the label (lowercase; `o→0`, `i,l→1`); reject anything that is
   not a valid DPNS label, and labels of the `xn--` form (see §6). v1 handles
   second-level names (`label.dash`) only.
2. **Name and site record, in one query**: a composite query
   (`documents.compositeWithProof`), with proof.
   - The page is DPNS `domain` where `normalizedParentDomainName == "dash"`
     and `normalizedLabel == <label>`, limit 1.
   - The first sub-query is `site` in the dash-sites contract, with the same
     two clauses fixed and `$ownerId` bound to the page document's `$ownerId`.
     The three properties are a unique index, so it finds one record or none.
   - A reader with nothing cached adds a second sub-query: `chunk` where
     `site` is bound to that record's `$id`, limit 32. The name, the record
     and up to 32 of its chunks (470 KB) arrive in one round trip under one
     proof, which is the whole of most sites. A refresh leaves it out.

   What the answer means:
   - No domain document: the name is not registered.
   - The owner is the domain document's **`$ownerId`**, not
     `records.identity`: that field never changes, so after a sale it still
     names the seller. The SDK's `dpns.resolveName` reads `records.identity`
     and is not used.
   - No site document, one without `content`, or one last written before the
     domain's `$transferredAt` (§3): the name has no site.
   - Otherwise its `content` is the site.

   Platform derives the sub-queries from the page it proves and merges them
   into one proof over one state root; the SDK derives them again from the
   proved page and refuses an answer that differs
   ([`composite_document_query/mod.rs:14-32`](https://github.com/dashpay/platform/blob/5e9aff1c4835299773095494a7a1c53506d5b0f9/packages/rs-drive/src/query/composite_document_query/mod.rs#L14-L32),
   Platform 5.0.3). A sub-query may name another contract
   ([`composite_document.rs:84`](https://github.com/dashpay/platform/blob/5e9aff1c4835299773095494a7a1c53506d5b0f9/packages/wasm-sdk/src/queries/composite_document.rs#L84)).
   A node that cannot answer the composite query is asked for the domain
   document and then for the record by name and owner, two proved reads. The
   record must have been last written no later than the block that proved
   the owner, so the answer is still what one block held. A record written
   later means the reads straddled a write: they are tried once more, and
   then the read fails rather than show a live site as missing.
3. **Content**: by scheme. For `dash-manifest`, take the manifest chunks from
   what step 2 brought, or fetch them (`site == <record $id>`, `hash in […]`,
   100 per query), verify, parse; then the chunks of the requested file the
   same way, verify, decode. A site of more than 32 chunks costs one or two
   further queries.

The proof is absence-capable: "no such name" and "no record" are proved too,
in the same single query. A contested name has no domain document until it is
awarded, so it resolves as unregistered.

**A name that changes hands** shows nothing of the previous owner from the
block of the transfer: the page then names the new owner, and the new
owner's record is the only one looked up. The previous owner's record and
chunks stay stored and unread. The previous owner can delete the chunks
(`gc`) but can no longer change the record (§3).

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

- **Web app** (static: the testnet builder on GitHub Pages, on a different
  registrable domain from user sites; the mainnet builder at `dash.site/new`,
  on the same domain, with the cookie and PSL caveats in §6): sign in with a mobile wallet (below), or with an
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
- **What the browser contacts**: the host for the shell; Dash Platform
  evonodes (`<ip>:443`, from the masternode list of the quorum key service);
  the quorum key service `quorums.<network>.networks.dash.org` (see §6); and,
  only for a site whose manifest names external npm files (§3),
  `cdn.jsdelivr.net`, and `unpkg.com` if jsDelivr fails. For a site that keeps
  files at places (§3) it also contacts those places: the HTTPS hosts the
  manifest lists and, for a file at an IPFS place, the npm CDNs for the IPFS
  client, the routing service and the providers that hold the file. Nothing
  else. `e2e/shell.mjs` asserts this list in Chromium for a site without
  external files; `e2e/elsewhere.mjs` prints the hosts the worker contacted
  for a site that keeps files at places and asserts that no recursive IPFS
  gateway is among them.
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
  proving a name needs one query, not three. A background query checks that
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

Since 0.2.0 the extension opens names with no gateway, static host or DNS at
run time. This replaces the earlier plan here, which redirected `.dash` to a
gateway's shell. The details are in
[packages/extension/README.md](../packages/extension/README.md). In short:

- **Navigation.** declarativeNetRequest rules send `http(s)://<label>.dash/…`
  to the extension's viewer page before any DNS lookup. They do the same for a
  search for exactly a `.dash` name on the listed engines, before the search
  is sent. The omnibox keyword `dash` opens a name directly.
- **Trust.** The extension verifies the Dash header chain from a checkpoint
  bundled with each release: X11 proof of work and DarkGravityWave. It then
  checks the masternode list and quorums DAPI streams against that chain's
  coinbase roots, and answers the SDK's quorum key requests from that proof.
  No quorum service is asked. A key is used only if lists from two different
  nodes both hold it. Every Platform read is then proof-verified as before. The
  known gap is that ChainLock and commitment signatures are not checked: the
  model is SPV plus the coinbase commitment, from two nodes. The README covers
  this and the way to close it (DIP 175 proofs over DAPI).
- **Nodes.** A bundled IP seed list, then the evonodes of the latest proven
  masternode list.
- **Rendering.** The objections listed here before still hold: one extension
  origin, so sites must be sandboxed; an opaque origin; URLs rewritten to
  blobs. The extension accepts those costs:
  - Chrome renders in a manifest sandbox page inside a sandboxed frame, with
    in-memory storage.
  - Firefox has no sandbox pages, so it renders without site scripts.
  - Single-page apps that read `location.pathname` do not work yet.

## 6. Security

- **Who controls a site**: the DPNS name's current `$ownerId`, proved.
  Platform refuses a site record from anyone but the owner, and a record
  left from an earlier owner is never read.
- **Where trust sits.** Content trust rests on verification in the visitor's
  browser, not on the gateway's server. A lying DAPI node cannot change a
  site, and neither can the gateway's fallback process, which browsers do not
  use. What remains trusted:
  1. **The shell.** The code that verifies is delivered by the gateway host. A
     dishonest or compromised host could send a different worker, to new
     visitors or as an update. What narrows this: the shell is the same for
     every name and built reproducibly from the repository; `sw.js` (about
     150 KB) contains the SHA-256 of the verifier's files and refuses to run one that
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
    the name changes hands. A well-behaved one is navigated to the reset
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
- **Files kept outside Platform**: the storage host can withhold a file, and
  cannot change it: only bytes matching the proved size and SHA-256 are
  served, and the browser's kept copy is checked again on every read. Visitors'
  browsers contact the hosts the owner listed (and, for IPFS, the routing
  service and the providers), which see the visitor's address. That is no more
  than a page linking to those hosts directly would cause, and requests carry
  no cookies and no referrer. The IPFS client is code the worker downloads, so
  it is run only when its SHA-256 matches the constant the worker was built
  with; an npm mirror can refuse to serve it, which costs IPFS places and
  nothing else.
- **The IPFS client runs inside the worker**: it is about 1.2 MB of
  third-party code (Helia and libp2p), far more than the rest of the worker,
  and it runs with the worker's own authority, in the same place that decides
  which bytes are served. Its output is still checked against the proved
  SHA-256, so a wrong answer from it is refused. A flaw in it that lets a
  hostile provider or routing service run code, though, would run as the
  worker of that one name: it could serve that name's visitors bytes the
  owner never published until the worker is replaced, and it could change
  what the worker keeps in that browser for the name (the marker of who owns
  it, the saved denylist), which lasts longer. Three things bound
  this. The worker loads the client only for a site that lists an IPFS place,
  so a site without one never runs it. Each name is its own origin with its
  own worker, so other names are out of reach. And the client is pinned by
  hash, so it changes only when the shell does.

  The shell keeps the client all the same. What it returns is never trusted,
  so the risk left is code execution from data inside a JavaScript library.
  The worker already takes that kind of risk with the Platform SDK, and
  handles it the same way: an exact version, pinned by hash. The pinned build
  has no `eval` and builds no code from what it downloads. Leaving IPFS out
  would also mean changing the shell for the first site that wants an IPFS
  place, and until then every file kept outside would depend on one HTTPS
  host staying up. An owner who wants none of this lists HTTPS places only,
  and the client is never loaded for that site.
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
- **Phishing and reputation**: user content under `dash.site` shares its
  reputation with `dash.site/new` (Safe Browsing flags by registrable domain
  unless the suffix is on the PSL). `dash.site` is not on the PSL yet; an
  entry, or a dedicated domain on the PSL, is the recommended fix.
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
On mainnet the contract is `GCSi8NkjXyRpLC7FsEnCfx5ntmWZ16bD2t9zc4JiT4X3`,
registered from `contract/dash-sites.v2.json` on 2026-11-25 for 0.1814 DASH
and selected by `NETWORK=mainnet`. `5cDiGVXZzsLs5e8Tqyje9UR5corRxjHFck7VxC6k7m4s`
was registered from the first schema, which keyed a site by the domain
document's id and needed two reads per name; it is superseded and this code
does not read it. Registration is final in the ways §3 lists under
"What registration fixes".

**Protocol versions.** Reads and writes both need the DPNS `domain` type, found
by its unique `(normalizedParentDomainName, normalizedLabel)` index, and its
`$ownerId`. Writes also need `domain` documents to stay deletable (§3), and
reads need `$transferredAt`. All of this holds on protocol 14 and in the
protocol 15 pre-releases.

[`contract/platform-upgrade-test.patch`](../contract/platform-upgrade-test.patch)
is a test for dashpay/platform, not part of Platform itself. Applied to tag
`v5.1.0-rc.1` it registers DPNS names and this contract on a protocol 14
chain, runs the upgrade to protocol 15 and repeats every kind of write on the
far side: a site record is created, replaced with and without content, a
chunk is stored and deleted. On both protocols Platform refuses a site record
for a name another identity owns or nobody registered, a chunk under another
identity's record, a second record for one name, a replace that moves a
record onto a name its writer does not own, and a replace by the previous
owner after the name is transferred. On protocol 14 it takes a move onto
another name the writer owns. On protocol 15 it also refuses the delete of a record, a change
of parent domain, and any write once the name is deleted. Each refusal is
checked against the consensus error it should raise. On both protocols a
contested name takes no site record, its contenders' included, until the
vote awards it. It also parses the schema with the full validation of both
versions.
All of it passed on the final schema on 2026-11-25. To run it against a
later Platform:

```
git apply <dash-sites>/contract/platform-upgrade-test.patch
DASH_SITES_SCHEMA=<dash-sites>/contract/dash-sites.v2.json RUST_MIN_STACK=268435456 \
  cargo test -p drive-abci --lib dash_sites_ -- --nocapture
```

A gateway runs on a network before its contract exists: the reader proves
names as usual and every registered name resolves to "no site yet", and the
landing page says publishing has not opened.

## 8. Hosting

| Network | Host | Runs on |
| --- | --- | --- |
| Mainnet | `dash.site`, `*.dash.site` | Cloudflare Worker `dash-site`, static assets only |
| Mainnet publishing | `dash.site/new*`, `dash.site/publish*` | Cloudflare Worker `dash-site-app`, static assets only: the builder (`/publish` redirects to `/new`), on the bare host only so no site origin serves a page that takes keys; CSP with `frame-ancestors 'none'` |
| Testnet | `id.dashhq.org`, `*.id.dashhq.org` | DigitalOcean droplet `dash-sites-gateway` (Caddy + fallback process) |

| Piece | Where | Why |
| --- | --- | --- |
| `dash.site` | An assets-only Cloudflare Worker (`deploy/cloudflare`): no Worker script, so no request runs code and static asset requests are free and unmetered. Routes `dash.site/*` and `*.dash.site/*`; `not_found_handling: single-page-application` answers every path with the shell | No server to run. Cloudflare's free certificate covers `dash.site` and `*.dash.site` |
| `id.dashhq.org` | A 1 GB droplet: Caddy serving the static shell on every name's host, the fallback process as a systemd service, and `agnos` for certificates | Wildcard TLS on a two-level name needs our own terminator; Cloudflare's free certificate covers only `*.dashhq.org` |
| DNS | Zone `dash.site`: apex and `*` proxied A `192.0.2.1` and AAAA `100::` (placeholders; the Worker routes answer, over IPv4 and IPv6). Zone `dashhq.org`: `id` and `*.id`, A and AAAA, to the testnet droplet (DNS-only), `_acme-challenge.id` delegated to the droplet (its NS host `ns-dash-sites` has an A record only; the DNS-01 responder listens on IPv4), CAA for Let's Encrypt DNS-01 | Existing access |
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
- **Caching.** Every file named for its content is cached for a year as
  `immutable`: the two verifier files, and everything under `/new/assets/`
  (the builder's script chunks, stylesheet, font and icon). The entry points
  stay `no-cache`, so they are revalidated (a 304 when unchanged) on every
  visit: the shell's `index.html` and `/sw.js`, `/new` itself, and
  `shell.json`. That keeps the kill switch: a new worker, or the blocking
  Worker's page and `/sw.js`, takes effect on the next visit. A shell cached
  for even a minute could keep a blocked host's visitors on the old page
  until it expired, so there is no `max-age` or `stale-while-revalidate` on
  the entry points.

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
- everything else: a plain "unavailable" page
  (`not_found_handling: single-page-application` with that page as
  `index.html`).

That Worker and its page are not in the repository yet; no name is blocked.

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

**Moving a droplet gateway to a new domain (such as `dash.dev`).** The shell reads the name from whatever host it is
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

Custom DNS domains pointing at a name
(DNSLink in reverse), serving `ipfs://` content from the gateway, Arweave,
private sites, a site directory, a site's own service worker, form posts,
serving sites from inside the extension, starting contested-name votes from
the builder.
