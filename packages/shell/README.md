# Dash Sites shell

The static files every name's host serves: `index.html` (bootstrap),
`sw.js` (service worker) and the verifier: `dash-sites-verifier-<hash>.js`
(the Platform reader and the Dash SDK's JavaScript) and
`dash-sites-verifier-<hash>.wasm.br` (the SDK's WebAssembly, brotli at quality
11, which the worker decompresses itself). `shell.json` lists their SHA-256.
The build keeps the compressed WebAssembly in `node_modules/.cache`, since
compressing it takes a minute or two.

```sh
npm ci && npx tsc -b                   # the shell bundles packages/core
npm run build -w @dash-sites/shell     # NETWORK=testnet|mainnet, BUILDER_URL, CONTRACT_ID
npm run serve -w @dash-sites/shell     # http://<name>.localhost:8080/
```

A site may keep files outside Platform, at HTTPS addresses or on IPFS. The
worker fetches those itself and serves only bytes that match the proved
manifest. For IPFS it needs Helia's `@helia/verified-fetch`, which is not one
of the files above: the worker downloads the exact npm version named in
`packages/core/src/ipfs.ts` from an npm mirror when a site first needs it, and
runs it only if its SHA-256 matches. `shell.json` lists it under `fetched`.
Set `IPFS_ROUTERS` at build time to use other delegated routing services.

To host it, serve `sw.js` and the verifier's files at the root of every
`<name>.<domain>` host and `index.html` for every other path. The verifier
can be cached forever; `sw.js` and `index.html` should be revalidated.
`deploy/Caddyfile` is a working configuration.

`src/host.ts` is the logic, independent of the browser: given a request it
resolves the name, verifies and returns the file. `test/host.test.ts` covers
it, including what happens when a name changes owner and when stored state
has been tampered with; `test/elsewhere.test.ts` covers files kept outside
Platform.
