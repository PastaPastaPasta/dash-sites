# Dash Sites

Websites on Dash Platform names. The owner of a DPNS name such as `alice.dash`
publishes a static site under it, and anyone can open it. The files, the
record that points at them and the name itself are all documents on Dash
Platform; there is no web host.

| | |
| --- | --- |
| Showcase site | https://p2p.id.dashhq.org/ (`p2p.dash`, testnet) |
| Gateway | https://id.dashhq.org/ |
| Builder | https://dash-sites.thepasta.org/ |
| Extension | [latest release](https://github.com/PastaPastaPasta/dash-sites/releases/latest) |
| Design | [docs/DESIGN.md](docs/DESIGN.md) |

Everything runs on **testnet** today. The data contract is
`3JRHRkyYZiwGS6xYQwNq2shemQ5mhGv36yK6VBweVtzx`.

## How a site is opened

`https://alice.id.dashhq.org/` answers with the same small page for every
name. It installs a service worker, and the worker does the rest in your
browser: it proves who owns `alice.dash` and what site record that owner
published, fetches the files from Dash Platform nodes, checks every file
against the SHA-256 in the proved manifest, and serves them to the page. The
gateway's server sends no site content and is not needed after the first
visit.

With the extension you type `alice.dash` instead and land on the same thing.

What is still trusted, and why, is in [the design doc](docs/DESIGN.md#6-security):
the shell you were sent, the quorum key service the Dash SDK uses, and Dash
Platform's validators.

### Check that no backend is involved

```sh
npm ci && npm run build
npx playwright install chromium
npm run e2e:shell          # p2p.dash through id.dashhq.org, no extension
npm run e2e:extension      # the same through the extension
```

`e2e/shell.mjs` opens the site in a fresh Chromium profile and fails unless
the gateway host sent only the shell, every other host the browser contacted
is a Dash Platform node or the quorum key service, and the site still loads
with the gateway host blocked. It also passes while the gateway's own content
process is stopped (`systemctl stop dash-sites-gateway` on the host).

To do it by hand: open the site once, then block `id.dashhq.org` (DevTools →
Network → Block request domain, or `/etc/hosts`) and reload. To avoid the
public host altogether, serve the shell yourself:

```sh
npm run serve -w @dash-sites/shell     # http://<name>.localhost:8080/
```

and set the extension's gateway to `http://localhost:8080`.

## Publish a site

**In the browser**: open the [builder](https://dash-sites.thepasta.org/) and
choose **Sign in with DashPay**. Scan the code with the DashPay app (More,
Tools, Connections, Scan QR) and approve it; on a phone, the button under the
code opens the wallet instead. The wallet gives the page a key that can only
write Dash Sites documents, with a spending limit and an end date you set on
the approval screen, and its own keys never leave it. Then pick a name you
own, write a page or upload a folder or zip, and publish. You see the fee
before anything is sent.

- Wallets: DashPay for Android 11.9.2 or later and Dash Wallet for iOS 9.1.4
  or later. On testnet, use DashPay's testnet build, the `-testnet.apk` on the
  [DashPay Wallet releases](https://github.com/dashpay/dash-wallet/releases/latest).
- A wallet sign-in cannot register names (the key is limited to Dash Sites).
  Register a name in the wallet, or use the key sign-in below.
- **Sign in with a private key instead** takes an identity id (or name) and an
  authentication key, or an identity file. That key stays in the page.

**From a terminal**:

```sh
npm ci && npm run build
alias dash-sites="node $PWD/packages/cli/bundle/dash-sites.mjs"

dash-sites preview ./my-site                      # http://preview.localhost:8080/
dash-sites publish ./my-site --name alice --identity-file identity.json
dash-sites resolve alice
dash-sites gc --identity-file identity.json       # reclaim storage of old versions
```

`--identity-file` takes the identity JSON that dash-bridge writes; `--identity <id>` with `DASH_SITES_KEY=<WIF>` works too. Storage costs
about 0.3 DASH per megabyte, paid once; deleting old chunks refunds most of it.
Testnet funds: https://faucet.thepasta.org.

A site can read its own proved record at `/.well-known/dash/site.json` and its
file list at `/.well-known/dash/manifest.json`, whoever serves it. Sites are
static: requests other than GET and HEAD are refused, and a site cannot
register a service worker of its own.

## Install the extension

Download `dash-sites-extension-chrome-<version>.zip` from the releases page,
unzip it, open `chrome://extensions`, turn on Developer mode and choose "Load
unpacked". Then type `p2p.dash` in the address bar, or `dash`, a space and a
name. The Firefox build is `dash-sites-extension-firefox-<version>.zip`
(`about:debugging` → "Load Temporary Add-on"). Store listings are not
published yet; the steps are in [packages/extension](packages/extension/README.md).

## Repository

| Path | What |
| --- | --- |
| `packages/core` | Protocol library: names, manifest, packing, resolution, publishing, Platform access |
| `packages/shell` | The static shell: bootstrap page, service worker, verifier |
| `packages/gateway` | Server-rendered fallback, landing page and resolve API |
| `packages/cli` | `dash-sites` command |
| `packages/builder` | Web builder (static) |
| `packages/extension` | Browser extension (Chromium and Firefox, MV3) |
| `packages/showcase` | The site published at `p2p.dash` |
| `contract/` | The `dash-sites` data contract |
| `deploy/` | Gateway host provisioning and deployment |
| `e2e/` | Browser tests against live names |

```sh
npm ci
npm run build       # everything, including the extension zips
npm test            # unit tests
npm run lint
```

## Run a gateway

`deploy/provision.sh <domain> <ipv4>` prepares an Ubuntu host (Caddy, Node,
a wildcard certificate by DNS-01 with no DNS credentials on the host), and
`deploy/deploy.sh <ssh-target>` installs the shell, the fallback process and
the Caddy configuration. DNS records and the steps for moving to another
domain such as `dash.dev` are in [docs/DESIGN.md](docs/DESIGN.md#8-hosting).

Mainnet needs the contract registered once by a funded mainnet identity
(`dash-sites contract register --schema contract/dash-sites.v1.json --network
mainnet`), its id added to `packages/core/src/config.ts`, and `NETWORK=mainnet`
on the gateway host and in the builder's build.

## License

MIT
