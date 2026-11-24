#!/usr/bin/env bash
# Builds the static shell for dash.site and deploys it as an assets-only Cloudflare Worker.
#   CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… deploy/cloudflare/deploy.sh
# dash.site serves mainnet names; NETWORK=testnet deploys a testnet build instead.
set -euo pipefail
cd "$(dirname "$0")/../.."
export NETWORK=${NETWORK:-mainnet} GATEWAY_DOMAIN=dash.site DENYLIST=0
if [ "$NETWORK" = mainnet ]; then export PEER_GATEWAY="testnet https://id.dashhq.org"; else unset PEER_GATEWAY; fi
npx tsc -b
node packages/shell/build.mjs >/dev/null
cat packages/shell/dist/shell.json
npx --yes wrangler@4 deploy --config deploy/cloudflare/wrangler.jsonc
