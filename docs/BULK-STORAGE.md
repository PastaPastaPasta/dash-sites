# Bulk storage outside Dash Platform

Status: proposal, nothing built. Date: 2026-11-25. Scope: the static stack
only (`dash.site`, the builder, the CLI).

Storing a file on Dash Platform costs about 0.3 DASH per MB. That suits
pages and is prohibitive for photos, media and large scripts. A site needs a
way to keep its big files somewhere cheaper without giving up the guarantee
that visitors get exactly what the owner published.

## Recommendation

1. **One mechanism.** A file in a site's manifest may be stored elsewhere.
   The manifest stays on Platform and is proved as today. For such a file it
   keeps the size and the SHA-256, and lists where the bytes can be fetched.
   The shell tries each place in order and serves only bytes that match. A
   provider is relied on to be available, never trusted for content.
2. **Two kinds of place, and no more**: an HTTPS address, and an IPFS CID.
   Everything on the list below is one or the other, so the shell never
   learns a provider's name.
3. **IPFS through Helia, from the peers that hold the file**, not through a
   gateway. Tested below: it works in a browser and in a service worker.
4. **Uploading belongs to the builder and the CLI, not the shell.** Start
   with "say where the file is", which works for every provider on day one.
   Then add built-in upload for the two most likely to be used.
5. **Fold the SDK-from-npm branch into this.** `feat/external-assets` is the
   same idea for one provider. Generalised before it lands, the shell gets
   one addition, once, and it covers both.

## The manifest entry

```json
"/img/hero.webp": {
  "type": "image/webp", "size": 184211, "sha256": "…", "parts": [],
  "src": ["ipfs://bafy…", "https://media.example.com/hero.webp"]
}
```

- `size` and `sha256` are already in every manifest entry. `src` is the
  only new field, and its presence is what makes a manifest version 2.
- The SDK becomes two HTTPS addresses, jsDelivr and unpkg. The branch's
  npm-specific fields (package, version, path) and its second hash (SHA-384)
  are not needed.
- A file can list several places. The site's address for the file does not
  change: pages still say `/img/hero.webp`.

## What the shell does

- **HTTPS**: a plain GET with no cookies, following redirects (Arweave's
  gateway redirects every file to a subdomain), reading at most `size`
  bytes. The host must allow other sites to read it (CORS).
- **IPFS**: Helia fetches the blocks from the peers that have them and
  checks them against the CID; the shell then checks the whole file against
  the manifest's SHA-256 like any other.
- Bytes that match are kept in the site's storage and checked again on every
  read, as the branch does today. If no place gives matching bytes, that one
  file fails and the rest of the site is served.
- Helia is its own file, pinned by hash in `sw.js` like the verifier, and
  loaded only when a site lists an IPFS place. The path that loads an
  ordinary site does not change.

## Helia without a gateway: what was measured

`@helia/verified-fetch` 8.1.2, headless Chromium, recursive gateways turned
off (`gateways: []`).

| Test | Result |
| --- | --- |
| A 120 KB image widely held on IPFS, from a page | fetched and verified in 0.7 s |
| The same, from inside a service worker | 0.9 s |
| Three files from Lighthouse's documentation | 1.0 to 1.5 s each |
| Where the bytes came from | `bitswap.pinata.cloud` and `bitswap.filebase.io` over WebSockets, Filecoin storage providers over HTTPS, and individual peers with browser-reachable addresses |
| Size of the module | 1.36 MB, 303 KB compressed |

Three things to know:

- **Finding who holds a file still uses one service.** A browser cannot walk
  IPFS's lookup network itself, so Helia asks `delegated-ipfs.dev`, run by
  the IPFS project, which answers with a list of peers. The bytes then come
  from those peers. The address is a setting, and it is the one part of this
  likely to need changing over the years.
- **A service worker has no WebRTC.** WebSockets, WebTransport and HTTPS
  work there, and were enough in every test.
- **Not tested**: large files, Safari and Firefox, and a file freshly pinned
  on each provider by us (these were files already on the network).

## Providers

| Provider | Kind of place | Paying | Notes |
| --- | --- | --- | --- |
| **Cloudflare R2**, and any S3-style bucket | HTTPS | 10 GB free, then $0.015 per GB a month; no charge for downloads | The bucket needs a public custom domain (`r2.dev` addresses are rate limited) and a CORS rule. The owner can delete the file; the hash stops it being replaced |
| **IPFS pinning**: Pinata, Filebase, Lighthouse, a node of your own | IPFS | Pinata 1 GB free, Lighthouse 5 GB free; monthly plans after that | Lasts while the pin is paid for. Pinata and Filebase both answered browsers directly in the test |
| **Arweave** | HTTPS, through its gateways | Paid once, kept for good; files up to 105 KiB are free through Turbo; the price floats, tens of dollars per GiB | The only one that matches Platform's pay-once model. A browser can only reach Arweave through a gateway, which is fine here because the hash is checked. `arweave.net` allows reading from other sites. Paid by card or other coins, not Dash |
| **Lighthouse** | IPFS | Subscriptions; its pay-once plan has been retired | Its own gateway is now for paying accounts only, so fetching from peers is what makes it usable here |

Also looked at, and already covered without more work because they serve
HTTPS or IPFS: Backblaze, Storj, a plain web server, Storacha, and Blossom
servers (which address files by SHA-256, the hash a manifest already holds).
Not proposed: Walrus, Swarm, Sia and BitTorrent, each of which would need
its own client in the shell.

## Uploading

- **Step one, for everything: say where it is.** The owner uploads with the
  provider's own tools and gives the builder or the CLI the address or CID.
  The builder fetches it once, records its size and hash, and from then on
  it is checked like any other file.
- **Then built-in upload for two**:
  - an **S3-style bucket**, one code path that covers R2 and Filebase (which
    pins to IPFS and returns the CID);
  - **Pinata**, a single authenticated upload that returns a CID.
- Arweave upload needs a funded wallet key in the page, so it waits; until
  then an Arweave file is added by its address.
- The owner's provider token is typed into the builder and kept in memory
  only, like a pasted key. The builder asks for a token limited to one
  bucket or to uploads.

## Limits and risks

| | |
| --- | --- |
| A file stored elsewhere can disappear | The page itself is on Platform and still loads; the missing file does not. List more than one place per file. A `dash-sites check` command confirms every place still serves matching bytes |
| Visitors' browsers contact hosts the owner chose | True of any site today: a page can already link to any address, with no check at all. This adds the check |
| The whole file is hashed | It must be downloaded in full before any of it is served. Fine for images, documents and scripts; not for streaming video. Hashes per piece, with range requests, can follow |
| A cap per file | Needed so a manifest cannot make a browser download without end. The SDK is 27 MB, so the cap sits above that |
| Helia is large and changes often | It is separate, pinned and loaded on demand. A host that would rather not carry it can leave it out, and files that also list an HTTPS place still load |
| The site record can already say `ipfs://<cid>` for a whole site | Leave that unserved. A manifest whose files are all elsewhere does the same job and keeps the proved manifest |

## Phases

| | What ships |
| --- | --- |
| **B1** | `src` in the manifest (the branch, generalised), HTTPS places in the shell, a CLI option, and "say where it is" in the builder. Covers R2, Arweave and the SDK |
| **B2** | IPFS places through the Helia module |
| **B3** | Built-in upload in the builder: S3-style buckets and Pinata |

B1 is the shell change the widget plan already needs
([VISUAL-BUILDER.md §5.4](VISUAL-BUILDER.md#54-the-sdk-by-hash-from-npm)), so
doing it in this shape costs nothing extra there.

## Decisions wanted

1. **Two kinds of place (HTTPS and IPFS), with providers handled only when
   uploading?** Recommended: yes.
2. **Generalise `feat/external-assets` to `src` before it lands**, so the
   manifest format is settled once? Recommended: yes.
3. **Helia as a separate module of the shell, loaded on demand.** It is the
   largest thing this adds to what a host serves, and it depends on a lookup
   service. The alternative is IPFS through HTTPS gateways only, which needs
   no new code and is what you said you would rather avoid.
4. **Which uploads to build in first.** Recommended: S3-style buckets and
   Pinata.
