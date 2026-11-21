# Dash Sites shell

The three static files every name's host serves: `index.html` (bootstrap),
`sw.js` (service worker) and `dash-sites-verifier-<hash>.js` (the Dash SDK
and the Platform reader). `shell.json` lists their SHA-256.

```sh
npm run build -w @dash-sites/shell     # NETWORK=testnet|mainnet, BUILDER_URL, CONTRACT_ID
npm run serve -w @dash-sites/shell     # http://<name>.localhost:8080/
```

To host it, serve `sw.js` and the verifier at the root of every
`<name>.<domain>` host and `index.html` for every other path. The verifier
can be cached forever; `sw.js` and `index.html` should be revalidated.
`deploy/Caddyfile` is a working configuration.

`src/host.ts` is the logic, independent of the browser: given a request it
resolves the name, verifies and returns the file. `test/host.test.ts` covers
it, including what happens when a name changes owner and when stored state
has been tampered with.
