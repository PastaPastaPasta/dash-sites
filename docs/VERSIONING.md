# Versioning

Sites are stored on Dash Platform for as long as their owners keep them there.
The code that reads them (the dash.site page and its service worker, the
testnet gateway, the extension, the CLI) is replaced many times in that span.
This file holds the rules that keep every stored site loadable after each
change. It also lists every format version that has been written.

## Rules

1. **Every stored object says which version of its format it is.** The site
   record and each chunk carry `v`, the content URI carries `vN`, and the
   manifest carries `v`. The page model a builder saves (#16) carries its
   own `v`.
2. **A version number is taken in the table below, in the same PR that first
   writes it.** No two changes may use the same number. A reader that only
   knows one meaning would misread the other.
3. **Readers read every version up to their own, forever.** Support for a
   version that has been written to mainnet is never removed. Each version
   has a frozen fixture that the tests load with the current code (see
   [Tests](#tests)).
4. **Writers write the lowest version that can hold what they store.** A
   plain site is still written as manifest version 1, so readers that are
   behind still open it. Only a site that needs a newer feature pays the
   cost of a newer format.
5. **A reader refuses a version newer than its own, as a whole and with a
   clear message.** It never serves part of such a site. A newer format can
   change the meaning of fields an older reader would otherwise misread.
6. **Any change to a format raises its version**, including adding an
   optional key. Version 1 and 2 manifests reject unknown keys, so this rule
   is what makes rule 5 safe.
7. **A new chunk format also raises the manifest or content URI version.**
   Readers meet chunks one file at a time, so a newer chunk alone would be
   refused file by file, after other files were served. A newer manifest is
   refused before any file is served.

## Registry

| Format | Where the version is | Versions written | Meaning | Newest reader |
| --- | --- | --- | --- | --- |
| Site record | `v` in the `site` document | 1 | The `content` URI, or no `content` for a site taken down | `FORMATS.site` in `packages/core/src/formats.ts` |
| Chunk | `v` in the `chunk` document | 1 | The bytes are `d0` then `d1` then `d2`; `hash` is their SHA-256 | `FORMATS.chunk` |
| Content URI | `dash-manifest:vN:` | 1 | A gzip-compressed manifest split over the listed chunks of the same site record. (`ipfs://<cid>` is a pointer form with no version.) | `FORMATS.contentUri` |
| Manifest | `v` in the manifest | 1, 2 | 1: files stored in chunks, plain or gzip. 2: adds `enc: "br"` (brotli) and `ext` (a file of a published npm package that the site does not store), from #25 | `FORMATS.manifest` |
| Page model | `v` in `/dash-site.json` | 1, proposed in #16 | The builder's block list | `PAGE_MODEL_VERSION` in #16 |
| Widgets | `v` attribute on each tag, proposed in #16 | none yet | | |

Taken and not yet written:

- **Manifest 3:** for #16's files kept outside Platform (`src`). #16 currently
  calls this version 2, which #25 already uses on `main`, so #16 has to move
  to 3 before it merges.

Records written before the `v` field existed count as version 1. The only
ones are on the testnet contract `zVqSAuc1…`, which has no `v` field. That
contract has to be registered again, or updated, before this branch ships (see
[Pending decisions](#pending-decisions)).

## What a reader does with each version

| What it finds | dash.site page and worker | Testnet gateway | CLI |
| --- | --- | --- | --- |
| A version it reads | Serves the site | Serves the site | Reads the site |
| A newer version (`reason: 'newer'`, or `NewerFormatError`) | "*name* needs a newer version of this page", HTTP 502. It asks the browser to check for a newer worker (`registration.update()`); a reload then gets it | "needs a newer gateway", HTTP 502 | `resolve` answers `unsupported` with `reason: "newer"`. `fetch` stops with "unsupported: a newer format than this version reads" for a record or content URI, and "format N is newer than this version reads" for a manifest or chunk |
| A content URI this project never defined (`reason: 'unknown'`) | "cannot be shown here" | "cannot be served here" | `unsupported` with `reason: "unknown"`; `fetch` says "content this project does not define" |
| A malformed object at a known version | "incomplete or does not match the hashes its owner published" | Same | An "invalid manifest" or content error |

The extension shows no site content itself. It compares the record the page
claims with its own proved read, so it needs no format support beyond the
site record.

Writers never rewrite what they cannot read:

- `publish`, `unpublish` and a pointer publish refuse a name whose record is in
  a newer format, before any chunk is paid for. Rewriting it would drop the
  fields the newer format added.
- `gc` and `publish --prune` delete nothing while any of the identity's
  records is in a format they cannot read.
- They also keep every chunk stored within the grace period (by the chunk's
  `$createdAt`; a chunk without one is never deleted), so a publish still
  uploading in another tab keeps the chunks its record does not reference
  yet. A publish that reuses older chunks checks again, just before it writes
  the record, that they are still stored, and stores again any a `gc` deleted
  meanwhile.

## Changing the contract

The contract (`contract/dash-sites.v2.json`) is registered by its owner
identity. Platform lets that owner update it, unless it was registered
read-only. Platform checks each update against the version it replaces.
Sources are from `dashpay/platform` at `v5.1.0-rc.1`, the same rules on
protocols 14 and 15:

| An update can | An update cannot |
| --- | --- |
| Add a document type | Remove a document type ([`validate_update/common/mod.rs:122`](https://github.com/dashpay/platform/blob/fd2565020656fa444b1e1c247e5ca65ef7541bca/packages/rs-dpp/src/data_contract/methods/validate_update/common/mod.rs#L122)) |
| Add a property: optional, or required only for documents created after the update (`requiredSince`). From protocol 15 a new property goes after the existing ones, which keep their order ([`v2/nested_members.rs:44`](https://github.com/dashpay/platform/blob/fd2565020656fa444b1e1c247e5ca65ef7541bca/packages/rs-dpp/src/data_contract/document_type/methods/validate_update/v2/nested_members.rs#L44)) ([`document_type/.../validate_update/v1/mod.rs:763`](https://github.com/dashpay/platform/blob/fd2565020656fa444b1e1c247e5ca65ef7541bca/packages/rs-dpp/src/data_contract/document_type/methods/validate_update/v1/mod.rs#L763)) | Remove a property, make an existing one required, or stop requiring one. A system field such as `$createdAt` can never become required later |
| Loosen a limit: raise `maxLength` or `maxItems`, lower `minLength`, drop a `pattern` ([`rule_set.rs`](https://github.com/dashpay/platform/blob/fd2565020656fa444b1e1c247e5ca65ef7541bca/packages/rs-json-schema-compatibility-validator/src/rules/rule_set.rs#L423)) | Tighten a limit, change a `pattern`, or change `additionalProperties`. Resize a fixed-size byte array (`minItems` = `maxItems`, like `site` and `hash`), whose stored layout depends on it ([`common/mod.rs:30`](https://github.com/dashpay/platform/blob/fd2565020656fa444b1e1c247e5ca65ef7541bca/packages/rs-dpp/src/data_contract/document_type/methods/validate_update/common/mod.rs#L30)) |
| Change descriptions and comments | Add, remove or change an index on an existing type ([`v1/mod.rs:107`](https://github.com/dashpay/platform/blob/fd2565020656fa444b1e1c247e5ca65ef7541bca/packages/rs-dpp/src/data_contract/document_type/methods/validate_update/v1/mod.rs#L107)) |
| | Change whether documents are mutable, deletable or transferable, or change how a stored value is encoded |
| | Make the contract read-only later, or change anything once it is read-only ([`config/.../validate_update/v0/mod.rs:17`](https://github.com/dashpay/platform/blob/fd2565020656fa444b1e1c247e5ca65ef7541bca/packages/rs-dpp/src/data_contract/config/methods/validate_update/v0/mod.rs#L17)) |

**Inside the same contract** (no migration):

- **New features** go in as a new document type, or a new optional property
  plus a higher record `v`. The higher `v` matters when older readers must not
  ignore the property. A property that is only informational needs no new
  `v`.
- **New ways of storing files** go in the manifest (a new manifest `v`) and
  need no contract change at all. #25 and #16 work this way.

**A new contract** is needed only for a change in the right-hand column. The
usual case is a new index for a new kind of query. The transition works like
this:

1. Register the new contract. Add its id to `DEPLOYMENTS` next to the old one.
   Readers read both:
   - A name shows the new contract's record when its owner wrote one since
     the name came to them.
   - Otherwise it shows the old contract's record.
   - The fallback costs one more query, and only for names not yet moved.
2. Publishing writes only to the new contract. The builder and CLI offer to
   move a site, which means publishing it again: new chunks, paid once.
   - A cheaper move is possible if the new contract defines a content URI
     that points at a record and its chunks in the old contract. A moved site
     then costs one small record.
   - This has to be designed into the new contract before it ships.
3. The old contract is read for as long as any name still has a record only
   there. Under rule 3, that means forever.

The step from the first contracts (testnet `3JRHRkyY…`, mainnet `5cDiGV…`) to
this one breaks that promise once. It happens before launch, while mainnet
holds a single site. From the registration of this contract on mainnet on,
the transition above is the only way to change contracts.

## The page, the service worker and the verifier

How new code reaches browsers, and why old code cannot get stuck:

- **`/sw.js` is never cached.** `_headers` sends `no-cache`, and browsers check
  the worker script on every navigation. A new deploy changes `sw.js`, so
  the browser installs the new worker on the next visit. The worker calls
  `skipWaiting()` and `clients.claim()`, so it takes over at once.
- **The verifier is pinned by hash.** Each `sw.js` names its verifier files by
  content hash (`dash-sites-verifier-<hash>.js` and `.wasm.br`) and checks
  their bytes. They are `immutable`, so a browser caches them for a year and
  a worker can never run with a verifier from another build. A new worker
  deletes the old build's cached verifier when it activates.
- **An old worker may outlive its verifier on the server.** If the browser has
  evicted its cached copy, the next page load fails once. The same navigation
  already installed the new worker, so a reload works.
- **Pages stay revalidating.** The page, `shell.json` and `/new` are
  `no-cache`. Only files named for their content are `immutable`.

**What must never change**, because the kill switch for a blocked name depends
on it:

- The worker stays at `/sw.js` with scope `/`.
- `/sw.js` stays uncacheable.
- A blocked host answers `/sw.js` with `denied-sw.js`, which removes the
  installed worker ([DESIGN §8](DESIGN.md#8-hosting)).

A new build that changed any of these would leave workers already installed
in browsers out of reach.

**Old sites keep loading after any deploy.** Every build carries the readers
for every format (rule 3), and the fixture tests run against the same code
the worker is built from.

**dash.site must not be deployed from a build that reads less than the live
one.** Deploying an older build would make sites published with newer formats
show "needs a newer version" until the next deploy. `shell.json` lists the
build's files and the format versions it reads (`formats`). Compare that with
the live `https://dash.site/shell.json` before a rollback.

## What the builder saves

The builder (#16) stores what it needs to open a page again in the site
itself, as `/dash-site.json`, with its own `v` (the page model version):

- A builder opens every version up to its own and saves in its own.
- A page saved by a newer builder is refused with a message to reload. It is
  never half-read.
- Widgets a site embeds carry a version on each tag. The write endpoint keeps
  answering every widget version it ever shipped.

#16 has the details (its §5.1.1). Its versions go in the registry above like
any other format.

## Tests

`packages/core/test/fixtures/formats/` holds one frozen site per stored
format version, with the chunk bytes as they were written:

- `site-v1.json` is a version 1 manifest.
- `site-v2.json` is a version 2 manifest with brotli and an npm file.

The fixture tests:

- `packages/core/test/formats.test.ts` loads each fixture with the current
  core, file by file against the recorded SHA-256s.
- `packages/shell/test/host.test.ts` serves each fixture through the
  service-worker host the same way.
- Both check that a newer record, content URI, manifest or chunk is refused
  as newer: the "Update needed" page, and a request for a newer worker.

When a PR adds a format version, it adds a fixture for it, generated once by
the code that writes it. Fixtures are never regenerated or edited. A fixture
that stops loading means a reader broke.

## Pending decisions

- **Whether the mainnet contract is registered updatable (Platform's default)
  or read-only.**
  - Read-only means nobody, its owner included, can ever change it. Every
    future feature that needs the contract would then need a new contract
    and the transition above.
  - Updatable lets new document types and optional properties go in later.
    An update can only add or loosen, never break stored documents.
  - The choice is made at registration and cannot be made read-only later.
  - This branch registers it updatable.
- **How the testnet contract `zVqSAuc1…` gets `v` and the chunk
  `$createdAt`.** Both are on-chain testnet writes and wait for a go.
  - Register a new testnet contract from this schema, and replace the id in
    `DEPLOYMENTS`, the bundled snapshot, the README and DESIGN. The few test
    sites on `zVqSAuc1…` are published again.
  - Or update `zVqSAuc1…` in place. `v` would then be required only from the
    update on (`requiredSince`), which the mainnet schema would not carry, so
    testnet and mainnet would differ. The chunk `$createdAt` cannot be added
    this way at all.
  - Registering again is the cleaner choice and is assumed here.
