#!/usr/bin/env bash
# Builds the static shell for dash.site and deploys it as an assets-only Cloudflare Worker.
#   CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… deploy/cloudflare/deploy.sh
# dash.site serves mainnet names; NETWORK=testnet deploys a testnet build instead.
set -euo pipefail
cd "$(dirname "$0")/../.."
export NETWORK=${NETWORK:-mainnet} GATEWAY_DOMAIN=dash.site DENYLIST=0
# The hosted builder publishes on testnet; mainnet visitors are pointed at the publishing docs instead.
if [ "$NETWORK" = mainnet ]; then
  export PEER_GATEWAY="testnet https://id.dashhq.org" BUILDER_URL="https://github.com/PastaPastaPasta/dash-sites#publish-a-site"
else
  unset PEER_GATEWAY BUILDER_URL
fi
npx tsc -b
node packages/shell/build.mjs >/dev/null
cat packages/shell/dist/shell.json
npx --yes wrangler@4 deploy --config deploy/cloudflare/wrangler.jsonc
