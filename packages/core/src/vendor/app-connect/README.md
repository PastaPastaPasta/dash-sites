# App Connect v2 protocol code

The request codec, response crypto, answer poller and grant verifier for signing in with a mobile
Dash wallet (the `dashpay://connect` flow of DashPay for Android and Dash Wallet for iOS). It is the
module Dash Forge and Yappr use, copied so the three apps speak the protocol identically.

- Source: `forge-web/lib/vendor/platform-auth/app-connect/` in
  [PastaPastaPasta/dash-forge](https://github.com/PastaPastaPasta/dash-forge) at `31789a80`, which
  is [PastaPastaPasta/platform-auth](https://github.com/PastaPastaPasta/platform-auth)
  `src/app-connect/` at `a627708` plus Forge's `dashpay://connect` carrier.
- Protocol: platform-auth `docs/APP_CONNECT_PROFILE.md`.
- Changes made here: relative imports carry a `.js` extension (this repo compiles with NodeNext),
  and the tests live in `packages/core/test/app-connect/` with their import paths adjusted.
  Nothing else differs, so the module's own tests and test vectors run in `npm test`.

Do not edit these files for Dash Sites' needs; what Dash Sites asks a wallet for is in
`packages/core/src/connect.ts`. To update, copy the files again and repeat the two changes above.
