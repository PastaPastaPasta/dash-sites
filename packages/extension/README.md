# Dash Sites extension

Opens `alice.dash` straight from Dash Platform. The extension verifies the Dash
chain from a checkpoint it ships with, proves the Platform quorum keys from
that chain, reads the name, its site record and its files from Platform nodes
with proofs, checks every file's hash, and renders the site in a sandbox. At
run time it uses no gateway, static host, DNS name, CDN or quorum service:
every request goes to a Dash node by IP address.

```sh
npm ci && npm run build
# packages/extension/build/chrome, packages/extension/build/firefox, and a zip of each
npm run e2e:extension           # Chromium: opens forg3.dash, a search, a name with no site
npm run e2e:extension-static    # the Firefox build's script-free renderer, driven in Chromium
npm run e2e:resolve -- forg3    # the same resolution in Node, logging every host contacted
```

Load `build/chrome` unpacked from `chrome://extensions`, or `build/firefox`
from `about:debugging`.

## How a name opens

```
alice.dash ──DNR──▶ site.html#alice.dash/            (extension page, privileged)
                     │ 1. headers since the checkpoint (DAPI Core, by IP)
                     │ 2. masternode list + quorums, checked against the block
                     │ 3. EvoSDK, quorum keys answered in-page from step 2
                     │ 4. DPNS name + site record + chunks, with proofs
                     │ 5. every file checked against the manifest's SHA-256
                     ▼
                 sandbox.html (Chrome: opaque origin, sandbox CSP, no chrome.*)
                 static frame (Firefox: opaque origin, no scripts)
```

### 1–2. Quorum keys from the chain, not from a server

`@dash-sites/core/chain` does this, and `src/chain.ts` keeps the result in
`chrome.storage.local` so the next visit only checks new blocks.

- **Checkpoint.** `CHECKPOINTS` in `packages/core/src/chain/checkpoints.ts`
  holds the last 24 headers up to a recent block for mainnet and testnet.
  `npm run chain:checkpoint` refreshes it for a release. It reaches the new
  checkpoint by verifying every header from the old one, so a release can only
  move the checkpoint along the chain the previous release trusted.
- **Headers.** `Core/subscribeToBlockHeadersWithChainLocks` from DAPI nodes.
  Each header must link to the previous one, carry exactly the DarkGravityWave
  difficulty (with testnet's minimum-difficulty rules), meet it with its X11
  hash, be later than the median of the last 11, and be less than two hours
  ahead.
  - Six nodes are asked for their tip. Once the extension knows at least 8
    nodes from a proven list, two of every six still come from the bundled
    seeds.
  - Each node is asked only for headers up to the height it claims: its tip, or
    the block of a list it sent.
  - A node that times out or answers short goes to the back of the queue. It is
    dropped only for data that breaks these rules. So a node that claims a
    higher tip can neither get honest ones dropped nor stall the sync.
  - The chain is stored 12 blocks below the verified tip. If nodes' headers do
    not follow the stored chain (it was on a branch the network left), the sync
    starts again from the checkpoint, and drops the quorum keys and nodes the
    stranded chain proved. A network failure does not trigger this.
- **Masternode list and quorums.** `Core/subscribeToMasternodeList` returns
  Core's `protx diff` from genesis to the tip, as CBOR. The list is accepted
  only if:
  - the coinbase is proven into that block's merkle root by its partial merkle
    tree;
  - the block is on the verified header chain;
  - the quorum commitments hash to the coinbase's `merkleRootQuorums`;
  - the masternode entries hash to `merkleRootMNList`.
  The quorum keys are covered by the quorum root, and the member count is taken
  from the hashed bitset. Evonode addresses are covered by the masternode list
  root: from the extended addresses of version 3 entries, and from `service`
  and `platformHTTPPort` of version 2 entries. Version 1 entries hash neither
  the type nor the port, so they are not used. A list whose masternode root
  does not match still gives its quorums, but no nodes.
- **Lists must agree.** Each round of tips waits for a bundled seed to answer
  (or for 2.5 s), so a stored list that answers fastest cannot keep the seeds
  out. Lists are then asked from one seed and from nodes picked at random, not
  by speed, plus a spare. The round ends once two lists check out and the
  seed's has arrived (or 5 s after that, if the seed is slow); slower requests
  are cancelled. Each list must be proven against a block of the verified
  chain, and a quorum key (or a node) is used only if **every** proven list
  holds it. A node that mines one block of its own, with a forged quorum in its
  coinbase, therefore cannot get that quorum used unless it also controls every
  other list, the seed's included. Quorums proven by earlier syncs are kept as
  "previous" quorums, so responses signed by a quorum that just rotated out
  still verify.
- **Into the SDK.** evo-sdk 5.1.0 in trusted mode is pointed at
  `https://quorums.dash-sites.invalid`. A `fetch` hook (`withLocalQuorums`)
  answers `/quorums` and `/previous` from the proven list, so that request
  never leaves the background worker. When the SDK meets a quorum it has no key for, it asks
  again, and the hook syncs the chain if the list is more than 30 s old. If
  that sync fails, the stored keys are used.

### One proof for every tab

The background worker does all of this once, for every tab:

- **The proven chain state** is kept in `chrome.storage.local` and used as soon
  as it exists, whatever its age. It is refreshed in the background once it is
  10 minutes old, and when the SDK meets a quorum it has no key for (at most
  every 30 s). A sync already running is joined, not repeated. Each sync starts
  from the stored chain and checks only the new headers; DAPI serves the
  masternode list only as a diff from genesis, so two lists of about 1.3 MB are
  read each time.
- **One SDK**, with the verifier compiled once, connected to nodes of the proven
  list that answered a probe within 2.5 s (probed again if all of them fail).
- **Nothing runs for ordinary browsing.** The worker proves the chain only when
  a viewer asks it to open a name. A viewer that waits pings the worker every
  20 s, so Chrome does not stop it mid-read. "Forget the verified chain" in the
  settings also stops work already running from storing anything.
- **Sites** are read and checked once and kept in IndexedDB (up to 40, least
  recently used dropped; a check that finds a site unchanged rewrites only its
  small metadata record). A viewer shows a site Dash Platform proved current in
  the last 10 minutes at once, from that store, and asks the worker to check it
  again behind it ("checking for updates" in the badge). A newer revision is
  shown when it arrives; a site that is gone is removed. Opens of one name from
  several tabs share one read.

Measured in headless Chromium on mainnet, time until a site's content is on
screen:

| Open | Before | Now |
| --- | --- | --- |
| First open in a new profile | 4.2–6.0 s | 1.2–2.3 s |
| Second tab, same site | 0.64–0.66 s | 0.09–0.12 s |
| New tab, another site | 0.64–8.6 s | 0.12–0.35 s |
| New tab after 45 s | 3.1–4.2 s (proves again) | 0.08–0.11 s |
| After a browser restart | 0.65–1.7 s | 0.11–0.15 s |
| Restart with a 3-hour-old proof, a site never opened | 7.7 s | 1.0–2.3 s |


### 3–5. Reading the site

This is the resolution the gateway shell uses (`resolveName`, `loadManifest`,
`readFile` from `@dash-sites/core`), with `queryWithProof` on every read. All
files are read and hash-checked before the first render. Files a manifest
keeps outside Platform (`ext`: npm CDNs, `src`: IPFS or URLs) are not loaded,
and the badge says how many were skipped.

### Node discovery without DNS

`SEEDS` (next to the checkpoint) lists up to 48 evonode HTTPS endpoints as IP
addresses, taken from a masternode list proven at the checkpoint. After the
first sync, the extension uses every valid evonode in the latest proven list
instead, keeping only nodes most lists hold. Both IPv4 and IPv6 are handled:
`https://[v6]:port` comes from the extended addresses of version 3 entries, and from `service` before that. On
mainnet today every evonode advertises IPv4 only. Nodes are untrusted: a node
that sends invalid headers or a list that does not hash is dropped. A node
that sends an old tip only delays the sync: others are asked for the higher
headers.

## Typing `alice.dash`, per browser

| What is typed | Chrome | Firefox |
| --- | --- | --- |
| `alice.dash` | `.dash` is not a TLD Chrome knows, so the omnibox runs a search. A DNR rule matches the search URL of the engines in `SEARCH_ENGINES` (Google ccTLDs in the host permissions, Bing, DuckDuckGo, Brave, Yahoo, Ecosia, Startpage, Kagi, Qwant) when the query is exactly a `.dash` address, and redirects before the request is sent. Tested: no response from Google. | Same: Firefox searches for names under unknown suffixes, and the same DNR rules apply. |
| `alice.dash/`, `http://alice.dash/blog` | Parsed as a URL. A DNR `main_frame` rule redirects to the viewer before any DNS lookup. Tested. | Same. |
| `dash alice` (keyword, then space) | `omnibox` API. | Same API. |
| Another search engine (Yandex, Baidu, Naver, Seznam, Mojeek, Presearch, You.com, AOL, Ask, MetaGer, Swisscows, Yahoo Japan), or a listed engine the extension has no host access to (a Google domain not in its host permissions, or access the user withheld) | `webNavigation.onBeforeNavigate` sees the search URL and opens the viewer. By then the engine has the query. | Same. |

Every other request to a `.dash` address (an image, style, media file or fetch
the viewer has no file for, such as a missing file or one kept outside
Platform) is blocked by a DNR rule before DNS. This is tested in Chromium.
Firefox gets the same rule, but whether Firefox applies DNR to requests from
the extension's own pages is not verified (Playwright cannot load extensions
into Firefox).

Remaining leaks: the browser itself may resolve `alice.dash` in DNS while you
type, through Chrome's omnibox preconnect or Firefox's "did you mean" check.
The extension cannot stop that. Turning off page preloading in the browser
does. Search catching can be turned off in the settings.

## Origin, CSP and storage

- **The viewer** (`site.html`) is an extension page. Its CSP is
  `script-src 'self' 'wasm-unsafe-eval'; object-src 'none'; base-uri 'none'`,
  and it refuses to run in a frame. It has the extension APIs, reads checked
  sites from the extension's IndexedDB, and never runs site code. The SDK and
  the chain proof run in the background worker; only `site.html` pages may ask
  it to open a name.
- **Chrome: `sandbox.html`.** A manifest sandbox page: an opaque origin with
  no `chrome.*` APIs. It sits in an `<iframe sandbox="allow-scripts
  allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals
  allow-downloads">`, with no `allow-same-origin` and no top navigation. Its
  CSP comes from `content_security_policy.sandbox`: scripts from inline,
  `blob:` and `eval` only (no remote scripts); `connect-src`, images and media
  may use `https:`; `form-action 'none'`.
  - The viewer sends the page and the verified files by `postMessage` to that
    frame only. The sandbox accepts one message, from its parent, from the
    extension's origin.
  - The sandbox rewrites the page so every site URL loads a `blob:` of the
    verified bytes: `src`, `srcset`, stylesheets, CSS `url()` and `@import`,
    and module imports (made absolute, then resolved by an import map).
  - The page is set with `<base href="https://alice.dash/…">`, so links and
    `new URL()` see site addresses.
  - `fetch` and `XMLHttpRequest` to the site's own URLs are answered from the
    verified files.
  - Same-site links, `GET` forms, `window.open` and the history API are passed
    to the viewer, which keeps its own URL (`site.html#alice.dash/path`) in
    step.
  - Messages from the sandbox are shape-checked (`asFrameMessage`). They can
    only ask the viewer to show another `.dash` address, set the title, or
    leave for an `http(s)` URL.
- **Firefox** has no sandboxed extension pages, and MV3 forbids inline and
  `blob:` scripts on extension pages. So Firefox renders without site
  scripts:
  - The page goes into an `<iframe sandbox="allow-popups
    allow-popups-to-escape-sandbox allow-top-navigation-by-user-activation">`
    as `srcdoc`: an opaque origin with scripting off.
  - Files are inlined as `data:` URLs.
  - Links are rewritten to the viewer's own URL with `target=_top`, so they
    work with no script.
  - The details panel says scripts are off.
- **Storage.** A site gets in-memory `localStorage` and `sessionStorage` (an
  opaque origin has none), so nothing persists across page loads. Cookies,
  IndexedDB and service workers are not available. The extension stores only
  settings and the proven chain snapshot. Nothing is sent anywhere else.
- **Address bar.** It shows `chrome-extension://…/site.html#alice.dash/path`.
  The viewer's own bar shows `alice.dash/path`.

## Known limits

- **Trust model is SPV plus the coinbase commitment, from several nodes.** The
  extension checks proof of work, difficulty and every Merkle root. It does not
  check ChainLock signatures or the quorum commitments' BLS signatures. To
  commit a fake quorum key, an attacker must control every node whose list the
  extension uses, including a bundled seed (unless the seed does not answer
  within 5 s), and mine a block at full mainnet difficulty with the forged
  quorum in its coinbase. Fixing this fully takes
  ChainLock checks against quorums proven earlier, or Core's DIP 175 quorum
  proofs (`getquorumproofchain`) served by DAPI. The bundled verifier already
  checks those proofs (`WasmVerifiedContext`); DAPI does not serve them yet.
- **Testnet** lets anyone mine a minimum-difficulty block when ten minutes
  pass without one, so its proof of work protects almost nothing. Use testnet
  for testing only.
- **Fingerprinting.** `site.html` and `sandbox.html` are web-accessible (the
  redirect rules need that), so a web page can detect that the extension is
  installed.
- **First run.** Headers stream at about 250 per second from one node. Mainnet
  makes about 550 blocks a day, so a checkpoint a month old costs about a
  minute on first run. Releases should refresh the checkpoint, and later
  visits only check new blocks.
- **Single-page apps.** In Chrome, a sandboxed page's `location` is the
  sandbox's address, so routers that read `location.pathname` see
  `/sandbox.html`. Hash routers and multi-page sites work. Firefox runs no
  site scripts.
- **Size.** The verifier WebAssembly is 31.6 MB, and each zip is about
  11.3 MB. The background worker compiles it once each time the browser starts
  the worker.

## Permissions

| Permission | Why |
| --- | --- |
| `declarativeNetRequestWithHostAccess`, host access to `*.dash` and the listed search engines | Redirect `.dash` addresses and searches for exactly a `.dash` name to the viewer, before the request leaves the browser |
| `webNavigation` | Catch a search for a `.dash` name on engines the rules do not list. Optional in settings |
| `storage` | Settings, and the proven chain state, so the next visit only checks new blocks |

No host permission is needed for Dash nodes: DAPI answers cross-origin
requests. No telemetry, and no requests except to Dash nodes by IP. The
fallback to a web domain (for example `dash.site`) is off unless turned on in
the settings. Even then, it is only offered as a button when Platform cannot
be read.

## Publishing to the stores

These need the publisher's own accounts.

**Chrome Web Store**

1. Register at https://chrome.google.com/webstore/devconsole (one-time fee).
2. "New item", upload `dash-sites-extension-chrome-<version>.zip`.
3. Listing: description from `static/manifest.json`, screenshots of a site and
   of the popup (1280×800), the 128 px icon from `static/icons`.
4. Privacy: single purpose "open and verify websites published on Dash
   Platform names"; justify each permission with the table above; declare
   that no user data is collected.

**Firefox Add-ons**

1. Sign in at https://addons.mozilla.org/developers/.
2. "Submit a New Add-on", upload `dash-sites-extension-firefox-<version>.zip`.
   The add-on id is `dash-sites@thepasta.org`.
3. The bundle is minified, so attach the source (this repository at the
   release tag) and the build command `npm ci && npm run build`.
   `web-ext lint` reports two `DANGEROUS_EVAL` warnings, both in the SDK's
   wasm-bindgen glue.
