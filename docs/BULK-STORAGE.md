# Bulk storage outside Dash Platform

Status: built in this PR for the static stack (`dash.site`, the builder, the
CLI). Date: 2026-11-25. The format is specified in
[DESIGN.md](DESIGN.md#files-kept-outside-platform-manifest-version-2); this
page records why it has that shape, what was measured, and what is left.

Storing a file on Dash Platform costs about 0.3 DASH per MB. That suits pages
and is prohibitive for photos, media and large scripts. A site can now keep
its big files somewhere cheaper without giving up the guarantee that visitors
get exactly what the owner published.

## What was decided

| Question | Answer |
| --- | --- |
| How many mechanisms? | One. A file's manifest entry lists where the file is; Platform keeps its size and SHA-256; the shell serves only bytes that match |
| Which kinds of place? | Two: an `https://` address and an `ipfs://` CID. Providers are a matter for uploading only, so the shell never learns a provider's name |
| IPFS through a gateway? | No. Helia fetches blocks from the providers that hold them, with recursive gateways turned off |
| Where does the IPFS client come from? | From npm, by hash, the same way a site takes the Dash SDK. It is not a file of whoever hosts the shell |
| The earlier `feat/external-assets` branch? | Folded in. Its npm-only entry became two HTTPS places, so the format is settled once |
| Later changes? | The format is built to take them without breaking older shells (below) |

## The manifest entry

```json
"/img/hero.webp": {
  "type": "image/webp", "size": 184211, "sha256": "…", "parts": [],
  "src": ["ipfs://bafy…", "https://media.example.com/hero.webp"]
}
```

`src` is the only new field, and its presence is what makes a manifest
version 2. Pages still say `/img/hero.webp`. A site with every file on
Platform still produces a version 1 manifest, byte for byte as before.

## Room for later changes

A version 2 reader:

- ignores keys it does not know, in the manifest and in a file entry;
- skips places whose kind it does not know, and uses the ones it does;
- refuses only the files it cannot read, and serves the rest: a file whose
  encoding it does not know, whose `src` is in a form it does not know, or
  whose parts do not add up to its size, which is how a file stored under a
  key added later looks. [DESIGN.md](DESIGN.md) §3 lists every case.

So a later shell can add a kind of place (`ar://`, a Blossom hash), a hash
per piece so large media can be served in ranges, or another encoding, and a
shell someone set up years earlier keeps serving every file it still
understands. Only a change older readers must not ignore raises the version.
Places are URIs for the same reason: a new kind is a new scheme, not a new
field.

## What the shell does

- **HTTPS**: a plain GET with no cookies and no referrer, following redirects
  (Arweave's gateway answers every file with one), reading at most `size`
  bytes. The host must allow other sites to read it (CORS).
- **IPFS**: `@helia/verified-fetch` 8.1.2 with `gateways: []`. The worker
  downloads the module's published browser build from jsDelivr or unpkg the
  first time a site asks for a file at an IPFS place, and runs it only if its
  SHA-256 matches the constant in `packages/core/src/ipfs.ts`. Both mirrors and
  the npm tarball serve the same bytes (1.24 MB, 300 KB compressed).
- Verified bytes are kept in the browser and checked again on every read. If
  no place serves the file, that one request fails and the rest of the site
  is served.
- The path that loads a site with every file on Platform is unchanged: the
  verifier's two files have the same hashes as before this change.

## Measured

The demo site `elsewhere-demo-2511.dash` on testnet keeps three files outside
Platform. Opened through a locally built shell in headless Chromium
(`npm run e2e:elsewhere`):

| | |
| --- | --- |
| First visit, including the verifier, the IPFS client and all files | 4.4 s without the large file, 10.7 s with it |
| A 68 KB image at an HTTPS address | served with the published hash |
| A 120 KB image on IPFS | served with the published hash; no recursive gateway contacted |
| The 26.7 MB Dash SDK WebAssembly, listed at jsDelivr and unpkg | fetched and checked in 1.6 s |
| Reload | all three from the browser's own verified copies, no request |
| Stored on Platform for the whole site | 463 bytes, 0.0015 DASH. Storing the three files there would have cost about 8 DASH |

Also measured: the same pinned module fetches IPFS content in Node (the CLI
uses it for `check`) and in a worker under the builder's Content Security
Policy, including files held only by Pinata and by Filecoin storage
providers, each in 1.3 to 3.8 s.

The builder's panel was run against testnet as well
(`outside-demo-2511.dash`): a three-file upload that would have cost 0.056
DASH with everything on Platform. The browser fetched the 66 KB image from
its HTTPS address in 0.4 s and the 117 KB image from IPFS in 2.0 to 2.8 s,
matched both, and the site published for 0.0018 DASH.

Three things to know:

- **Finding who holds a file uses one service.** A browser cannot walk IPFS's
  lookup network itself, so Helia asks `delegated-ipfs.dev`, run by the IPFS
  project, which answers with a list of providers. The bytes then come from
  those providers. Building the shell with `IPFS_ROUTERS` set uses other
  services. Helia also resolves some providers' addresses through a public
  DNS-over-HTTPS resolver (Cloudflare's or Google's).
- **A service worker has no WebRTC.** HTTPS, WebSockets and WebTransport
  work there, and were enough in every test.
- **Not tested**: Safari and Firefox, and a file freshly pinned by us on each
  provider (these were files already on the network).

## Providers

| Provider | Kind of place | Paying | Notes |
| --- | --- | --- | --- |
| **Cloudflare R2**, and any S3-style bucket | HTTPS | 10 GB free, then $0.015 per GB a month; no charge for downloads | The bucket needs a public custom domain (`r2.dev` addresses are rate limited) and a CORS rule. The owner can delete the file; the hash stops it being replaced |
| **IPFS pinning**: Pinata, Filebase, Lighthouse, a node of your own | IPFS | Pinata 1 GB free, Lighthouse 5 GB free; monthly plans after that | Lasts while the pin is paid for |
| **Arweave** | HTTPS, through its gateways | Paid once, kept for good; small files are free through Turbo; the price floats | The only one that matches Platform's pay-once model. `arweave.net` allows reading from other sites |
| **npm**, for scripts published there | HTTPS | Free | List both mirrors: jsDelivr and unpkg |

Also covered without more work, because they serve HTTPS or IPFS: Backblaze,
Storj, a plain web server, Storacha and Blossom servers. Not supported:
Walrus, Swarm, Sia and BitTorrent, each of which would need its own client in
the shell.

## Uploading

Uploading is the builder's and the CLI's job, never the shell's.

- **Say where it is** works for every provider. Upload the file with the
  provider's own tools, then give its address or CID.
  - CLI: `dash-sites publish <dir> --name <name> --elsewhere places.json`,
    where the file maps site paths to places. Before publishing it asks every
    place for the file, and stops if one does not serve it or does not allow
    reading from other sites. A file that is not in the folder is taken from
    its first place.
  - `dash-sites check <name>` asks every place of a published site, so an
    owner can find a lapsed pin or a deleted object.
- **Built-in upload in the builder**, for the two chosen as the most useful
  pair, one of each kind:
  - an **S3-style bucket** (Cloudflare R2 and anything else that speaks the
    protocol): one signed PUT, the file named by its hash;
  - **Pinata**: one authenticated upload that returns a CID.
  The key or token is typed into the builder and kept in memory only. After
  an upload the builder asks the place for the file, as a visitor's browser
  will, before it marks the file as kept outside.
- The builder's panel is "Keep large files outside Dash Platform" in step 3.
  It lists the files of 8 KB or more, for a built page and for an uploaded
  site alike, with what each costs on Platform. A file's places are
  remembered in the browser by the file's hash, so a changed file goes back
  on Platform until its new version has a place. Places come only from what
  the owner confirmed in the panel, or from a site of the owner's own that
  they reopen while signed in.
- Arweave upload needs a funded wallet key in the page, so it is not built;
  an Arweave file is added by its address.

## Limits and risks

| | |
| --- | --- |
| A file kept elsewhere can disappear | The page itself is on Platform and still loads; the missing file does not. List more than one place per file, and run `dash-sites check` |
| Visitors' browsers contact hosts the owner chose | True of any site today: a page can already link to any address, with no check at all. This adds the check, and sends no cookies or referrer |
| The whole file is hashed | It is downloaded in full before any of it is served, so a file is capped at 64 MiB. Fine for images, documents and scripts; not for streaming video. A hash per piece, with range requests, is the addition the format leaves room for |
| The IPFS client is large and comes from npm | It is loaded only for IPFS places and only if its hash matches. If both mirrors are down, IPFS places fail and HTTPS places still load |
| The site record can already say `ipfs://<cid>` for a whole site | Still unserved. A manifest whose files are all elsewhere does the same job and keeps the proved manifest |
| The hosted testnet server | Does not fetch outside files, and answers them with an error. It is being retired |

## Left to do

- Uploads from the builder to R2 and to Pinata have not been run against
  live accounts. The bucket upload was run against a local S3 server and
  both against stand-ins in the browser test. Giving the address of a file
  that is already online was run for real, over HTTPS and over IPFS.
- How soon a file just pinned at Pinata can be found by other IPFS clients
  is not measured. The builder waits 90 seconds, then lets the owner keep
  the place unconfirmed.
- Safari and Firefox.
- Hashes per piece and range requests, for media. Until then the shell checks
  a kept file's hash on every read, including each range a player asks for.
- The places a browser remembers are kept per browser, not per identity, and
  only for the 300 files most recently moved.
