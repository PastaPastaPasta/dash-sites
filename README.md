# Dash Sites

Websites on Dash Platform names. The owner of a DPNS name such as `alice.dash`
publishes a static site under it, and anyone can open it. The files, the
record that points at them and the name itself are all documents on Dash
Platform; there is no web host.

| | |
| --- | --- |
| Sites, mainnet | https://dash.site/ (`alice.dash.site`): a static site with no backend |
| Make and publish a site, mainnet | https://dash.site/new |
| Sites, testnet | https://id.dashhq.org/ (`alice.id.dashhq.org`), showcase at https://p2p.id.dashhq.org/ |
| Make and publish a site, testnet | https://dash-sites.thepasta.org/ |
| Extension | [latest release](https://github.com/PastaPastaPasta/dash-sites/releases/latest) |
| Design | [docs/DESIGN.md](docs/DESIGN.md) |

The data contract is `CjzpdgCPJdLgVZdUu8SNacWVnrhDv34LstjPdBeJ4dT` on
testnet (`DEPLOYMENTS` in `packages/core/src/config.ts`). It is not registered
on mainnet yet. Until it is, every mainnet name reads as having no site, so
dash.site is not redeployed from `main`. The earlier contracts (mainnet
`5cDiGVXZzsLs5e8Tqyje9UR5corRxjHFck7VxC6k7m4s`, testnet
`3JRHRkyYZiwGS6xYQwNq2shemQ5mhGv36yK6VBweVtzx`) are no longer read. How
formats and the contract change later is in
[docs/VERSIONING.md](docs/VERSIONING.md).

## How a name opens on dash.site

dash.site is a static site with no backend service. It runs as two
assets-only Cloudflare Workers (`dash-site` for every host and
`dash-site-app` for `/new`), so no code runs on any request. Every host under it,
`alice.dash.site` included, gets the same few files: a small page, a service
worker (`sw.js`) and the verifier. The page holds no site content. When you
open `https://alice.dash.site/`, your browser does the rest:

1. The page installs the service worker and shows "Loading alice.dash.site…"
   with a progress bar. Technical detail sits behind "Details", and on errors.
2. The worker loads the verifier (the Dash SDK built to WebAssembly). While it
   downloads, the worker picks fast Platform nodes from the masternode list
   at `quorums.mainnet.networks.dash.org`.
3. The worker uses Platform proofs to check who owns `alice.dash` and which
   site record that owner published. It then fetches the files from Platform
   nodes and checks each one against the SHA-256 in the proved manifest
   before the page gets it.

The bare `dash.site` is the landing page. Typing a name there goes to
`https://<name>.dash.site/`. Each name is its own origin, with its own
storage and service worker. Crawlers, link previews and command-line
clients get the static page, not the site. A browser without service
workers is told it cannot open Dash Sites. What is still trusted is
in [the design doc](docs/DESIGN.md#6-security): the page you were sent, the
quorum key service the Dash SDK uses, and Dash Platform's validators.

Names on the testnet host `id.dashhq.org` open the same way. Its landing
page, and the copies served to crawlers, link previews and command-line
clients (chosen by User-Agent), come from the fallback process in
`packages/gateway`. With the extension you can type `alice.dash` instead.

**Speed.**

- The verifier is a 5.7 MB WebAssembly file (brotli quality 11) and a script
  of about 0.2 MB compressed. Both have content-hashed names and are cached
  as `immutable`.
- A first visit to `d4shhq.dash.site` takes a median of about 1 to 1.5 s on a
  fast connection and 2.4 to 2.6 s at 50 Mbit/s (measured from a cloud
  sandbox).
- Repeat visits are served by the installed worker.
- The page, `sw.js` and `shell.json` are sent as `no-cache`, so a new or
  blocking worker takes effect on the next visit.

**Theme.** Every dash.site page, from the loading page and errors to the
landing page and `/new`, follows the system light or dark theme
(`color-scheme: light dark`, with system colors or a light and dark
palette). [AGENTS.md](AGENTS.md) makes
this a rule for new pages.

**Abuse reports and blocking.** The landing page and the loading page link
to "Report abuse" (this repository's issues). dash.site cannot change or
remove anything on Dash Platform, but it can stop opening a name. None is
blocked today. When one needs to be, route the name's host to a second
assets-only Worker that serves
`packages/shell/src/denied-sw.js` as `/sw.js` and an "unavailable" page for
everything else. The new `sw.js` clears the site from browsers that already
have it ([DESIGN §8](docs/DESIGN.md#dashsite-static-files-only)). `id.dashhq.org` has an
operator denylist (`dash-sites-deny`) for names, owners and content
([DESIGN](docs/DESIGN.md#operator-denylist-droplet-gateways)). A self-hosted shell has neither.

## Publish a site

**In the browser**: open https://dash.site/new for mainnet (publishing there
opens once the contract is registered on mainnet), or the
[testnet builder](https://dash-sites.thepasta.org/). Choose **Sign in with
DashPay**, scan the code with the DashPay app (More, Tools, Connections, Scan
QR) and approve. On a phone, the button under the code opens the wallet
instead. The wallet gives the page a key that can only write Dash Sites
documents, with a spending limit and an end date you set on the approval
screen. The wallet's own keys never leave it. Then pick a name you own, write
a page or upload a folder or zip, and publish. You see the fee before anything
is sent.

- Wallets: DashPay for Android 11.9.2 or later and Dash Wallet for iOS 9.1.4
  or later. Testnet needs DashPay's testnet build, the `-testnet.apk` on the
  [DashPay Wallet releases](https://github.com/dashpay/dash-wallet/releases/latest).
- A wallet sign-in cannot register names, because its key is limited to Dash
  Sites. Register a name in the wallet, or use the key sign-in below.
- **Sign in with a private key instead** takes an identity id (or name) and an
  authentication key, or an identity file. The key stays in the page.

**From a terminal** (testnet by default, `--network mainnet` for mainnet):

```sh
npm ci && npm run build
alias dash-sites="node $PWD/packages/cli/bundle/dash-sites.mjs"

dash-sites preview ./my-site                      # http://preview.localhost:8080/
dash-sites publish ./my-site --name alice --identity-file identity.json
dash-sites resolve alice
dash-sites publish ./my-site --name alice --identity-file identity.json \
  --brotli --external external.json             # version 2: see below
dash-sites publish ./my-site --name alice --identity-file identity.json --prune
dash-sites gc --identity-file identity.json --dry-run   # what would be deleted, and the refund
dash-sites gc --identity-file identity.json       # reclaim storage of old versions
```

`--prune` deletes, after the new record is written, the chunks of releases older than the
one it replaced. The site being published keeps its current and previous release; other
sites of the identity keep only their current release. `gc` deletes every
chunk no site record of the identity references. Both delete nothing while a site record
of the identity changed less than `--grace` hours ago (default 25, past the gateway's 24-hour
stale cache): a browser or gateway may still be serving the release a record replaced.
`gc --dry-run` lists the chunks `gc` would delete and the refund; `publish --dry-run` plans
no pruning. Only the identity's own chunks are listed and deleted; other identities' chunks
are never read as references or touched.

Before deleting, the site records are read again from a block at least three minutes newer
than the one the plan was made from (waiting for one if needed), and nothing is deleted if
they changed since the plan, or if any record has content this version cannot read. So a
publish one lagging node did not show is seen before anything goes. The grace period is
measured in Platform's block time, not this machine's clock. A prune that cannot run is
reported in the publish output; the new site is live regardless. The builder does not let
you delete files while it publishes, or publish while it deletes. What is not covered:
**publishing for the same identity from two places at once** (another tab, the builder and
the CLI) while one of them deletes, so run one publisher at a time; and `unpublish`, after
which the removed site's chunks count as unused at once. An identity that updates some site
more often than the grace period never prunes on publish; run `gc` in a quiet period.

`--identity-file` takes the identity JSON that dash-bridge writes. You can
also use `--identity <id>` with `DASH_SITES_KEY=<WIF>`. Storage costs about
0.3 DASH per megabyte, paid once. Deleting a chunk refunds its storage fee less
what Platform has already paid out to masternodes: 0.125% per mainnet epoch (9.125 days)
in the first year, so about 99.9% after a day and 94.9% after a year. The delete itself
pays a processing fee that is not refunded: the chunk tree stores documents in its nodes,
so a delete rewrites the nodes above it, about 58M credits a chunk in a tree of a thousand
chunks. What comes back net is about three quarters of what the chunks cost.
Get testnet funds at https://faucet.thepasta.org. Run `dash-sites` with no
arguments for every command.

`--external external.json` names files of published npm packages that the site
ships unmodified (`{"/path/in/site": {"npm": "pkg", "version": "1.2.3", "path":
"dist/file"}}`, exact versions only). They are not stored: readers fetch them from
cdn.jsdelivr.net, then unpkg.com, and use them only if their SHA-384, recorded in
the proved manifest, matches; `publish` refuses unless both CDNs serve each file
byte for byte. `--brotli` stores a file as brotli when that is smaller than gzip;
the result depends on Node's bundled brotli, so a different Node version can give
different chunks. Either option makes the manifest version 2, which needs a
current shell, gateway or extension; older ones refuse the site as a whole.
dash.site reads version 2. On 2026-11-25 the testnet host `id.dashhq.org` and
extension 0.1.0, the latest release, were older builds that refuse it. An
external file counts toward the site size limit like a stored one (50 MB in the
shell and extension, 25 MB in the gateway process).

Files that are not on npm can stay off Platform too. `publish --elsewhere places.json` takes a map
of site paths to the places that hold them, each an `https://` address or an
`ipfs://` CID. Platform then stores only the file's size and hash, and a
visitor's browser fetches the file from the first place that serves exactly
those bytes. `dash-sites check alice` asks every such place of a published
site. A site with such a file has a version 3 manifest, which needs a shell,
gateway or CLI from this change on. See
[the design doc](docs/DESIGN.md#manifest-version-3-files-kept-at-places).

```json
{ "/img/hero.webp": ["ipfs://bafy…", "https://media.example.com/hero.webp"] }
```

A site can read its own proved record at `/.well-known/dash/site.json` and
its file list at `/.well-known/dash/manifest.json`, whoever serves it. Sites
are static: requests other than GET and HEAD are refused, and a site cannot
register a service worker of its own. A browser fetches a worker script
from the host, which answers every path except its own few files with the
static page, so the registration fails.

## Install the extension

1. Download `dash-sites-extension-chrome-<version>.zip` from the releases
   page and unzip it.
2. Open `chrome://extensions`, turn on Developer mode and choose "Load
   unpacked".
3. Type `p2p.dash` in the address bar, or `dash`, a space and a name.

The Firefox build is `dash-sites-extension-firefox-<version>.zip`; load it
from `about:debugging` with "Load Temporary Add-on". There are no store
listings yet. The steps are in [packages/extension](packages/extension/README.md).

## Develop

| Path | What |
| --- | --- |
| `packages/core` | Protocol library: names, manifest, packing, resolution, publishing, Platform access |
| `packages/shell` | The static page, service worker and verifier that every name's host serves |
| `packages/builder` | The page at `/new` on dash.site, and the testnet builder |
| `packages/gateway` | The landing page, fallback process and resolve API on `id.dashhq.org` |
| `packages/cli` | `dash-sites` command |
| `packages/extension` | Browser extension (Chromium and Firefox, MV3) |
| `packages/showcase` | The showcase site, `built4.dash` on mainnet (testnet's `p2p.dash` runs an earlier revision) |
| `contract/` | The `dash-sites` data contract |
| `deploy/` | dash.site Workers (`deploy/cloudflare`) and the testnet droplet |
| `e2e/` | Browser tests against live names |

```sh
npm ci
npm run build       # everything, including the extension zips
npm run typecheck
npm test            # unit tests
npm run lint
```

`npm run e2e:shell` opens a live name in a fresh Chromium profile. It fails
unless the host sent only the static page, every other host the browser
contacted is a Dash Platform node or the quorum key service, and the site
still loads with the host blocked. `e2e:extension` opens a live name through
the extension, and `e2e:builder` publishes through the testnet builder and
reads the page back.

```sh
npx playwright install chromium
npm run e2e:shell                      # p2p.dash through id.dashhq.org
npm run e2e:shell -- d4shhq dash.site  # a mainnet name through dash.site
npm run e2e:extension
npm run e2e:builder -- identity.json <label>  # a name the identity owns; publishes on testnet (spends testnet credits)
```

`E2E_COLOR_SCHEME=dark` runs `e2e:builder` in the dark theme, for its screenshots.

**dash.site on your machine.** Build both Workers' files the way
`deploy/cloudflare/deploy.sh` does. The subshell keeps these settings out of
later testnet builds:

```sh
( export NETWORK=mainnet GATEWAY_DOMAIN=dash.site DENYLIST=0 \
    BUILDER_URL=https://dash.site/new PEER_GATEWAY="testnet https://id.dashhq.org"
  npx tsc -b && node packages/shell/build.mjs && SITE=1 node packages/builder/build.mjs )
```

Then run one Worker at a time with Wrangler. Run the static page and test a
name against it:

```sh
npx --yes wrangler@4 dev --config deploy/cloudflare/wrangler.jsonc --port 8787 --local-protocol https
E2E_HOST_MAP=127.0.0.1:8787 npm run e2e:shell -- d4shhq dash.site
```

Run the `/new` page and open http://localhost:8788/new:

```sh
npx --yes wrangler@4 dev --config deploy/cloudflare/app.jsonc --port 8788
```

To serve the static page without Cloudflare, run `npm run build` (a testnet
build) and then `npm run serve -w @dash-sites/shell`. Open
`http://<name>.localhost:8080/`.

## Deploy

- **dash.site** (both Workers, `dash-site` and `dash-site-app`):
  `CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… deploy/cloudflare/deploy.sh`.
  It builds for mainnet and deploys `app.jsonc` and then `wrangler.jsonc`.
  Cache headers are set in each build's `_headers`. Files with hashed names
  are `immutable`; the pages and `sw.js` are `no-cache`.
- **Testnet builder**: GitHub Pages, deployed by `.github/workflows/pages.yml`
  on every push to `main`.
- **id.dashhq.org**: `deploy/provision.sh <domain> <ipv4>` prepares an Ubuntu
  host (Caddy, Node, and a wildcard certificate by DNS-01 with no DNS
  credentials on the host). Point both A and AAAA records at the host; the
  DNS-01 responder listens on the IPv4 address given, so give the
  `_acme-challenge` NS host (`ns-dash-sites`) an A record only. `deploy/deploy.sh <ssh-target>` installs the
  shell, the fallback process and the Caddy configuration. DNS and moving
  domains are covered in [DESIGN §8](docs/DESIGN.md#8-hosting).

## Versions and upgrades

Every stored object says which version of its format it is: the site record
and each chunk (`v`), the content URI (`dash-manifest:v1:`) and the manifest
(`v`).

- **Readers:** they read every version up to their own, forever, and frozen
  fixtures in the tests hold them to it. A site published in a newer format
  than a reader knows gets a "needs a newer version" page instead of a broken
  site, and the dash.site worker then looks for an update.
- **Writers:** they use the lowest version that holds a site, so readers that
  are behind still open it.
- **The page:** `/sw.js` is never cached, so a deploy reaches every browser on
  its next visit, and the kill switch keeps working.
- **The contract:** an update can only add or loosen. A change that needs a new
  contract has both contracts read side by side.

[docs/VERSIONING.md](docs/VERSIONING.md) has the rules, the version registry
and the upgrade steps.

## Planned

These are open PRs and are not live:

- [#16](https://github.com/PastaPastaPasta/dash-sites/pull/16): a block editor
  in the builder, and large files kept outside Platform.

## License

MIT
