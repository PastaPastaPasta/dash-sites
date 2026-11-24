#!/usr/bin/env bash
# Builds the static shell for dash.site and the /new and /publish pages, and deploys each as an
# assets-only Cloudflare Worker.
#   CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… deploy/cloudflare/deploy.sh
# dash.site serves mainnet names; NETWORK=testnet deploys a testnet build instead.
set -euo pipefail
cd "$(dirname "$0")/../.."
export NETWORK=${NETWORK:-mainnet} GATEWAY_DOMAIN=dash.site DENYLIST=0
export BUILDER_URL="https://dash.site/new" PUBLISH_URL="https://dash.site/publish"
if [ "$NETWORK" = mainnet ]; then export PEER_GATEWAY="testnet https://id.dashhq.org"; else unset PEER_GATEWAY; fi
npx tsc -b
node packages/shell/build.mjs >/dev/null
SITE=1 node packages/builder/build.mjs >/dev/null
cat packages/shell/dist/shell.json
npx --yes wrangler@4 deploy --config deploy/cloudflare/app.jsonc
npx --yes wrangler@4 deploy --config deploy/cloudflare/wrangler.jsonc
