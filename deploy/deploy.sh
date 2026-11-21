#!/usr/bin/env bash
# Builds the shell and the gateway process and installs both on the gateway host.
#   deploy.sh <ssh-target> [ssh options...]
set -euo pipefail
TARGET=${1:?ssh target, e.g. root@gateway-host}
shift
cd "$(dirname "$0")/.."

remote_env() { ssh "$@" "$TARGET" ". /etc/dash-sites/gateway.env; echo \"\${GATEWAY_DOMAINS%%,*} \${NETWORK:-testnet} \${BUILDER_URL:-} \${CONTRACT_ID:-}\""; }
read -r DOMAIN NETWORK BUILDER_URL CONTRACT_ID < <(remote_env "$@")

npx tsc -b
npm run bundle -w @dash-sites/gateway
export NETWORK CONTRACT_ID
[ -n "$BUILDER_URL" ] && export BUILDER_URL
node packages/shell/build.mjs >/dev/null
node -e '
const { readFileSync, readdirSync, writeFileSync } = require("node:fs");
const { brotliCompressSync, constants } = require("node:zlib");
for (const file of readdirSync("packages/shell/dist").filter((name) => name.endsWith(".js"))) {
  const data = readFileSync(`packages/shell/dist/${file}`);
  writeFileSync(`packages/shell/dist/${file}.br`, brotliCompressSync(data, { params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: data.length } }));
}'
sed "s/__DOMAIN__/$DOMAIN/g" deploy/Caddyfile > packages/shell/dist/Caddyfile

ssh "$@" "$TARGET" 'rm -rf /opt/dash-sites/shell.new && mkdir -p /opt/dash-sites/shell.new && touch /etc/dash-sites/denied.caddy'
scp "$@" packages/gateway/bundle/gateway.mjs "$TARGET:/opt/dash-sites/gateway.mjs.new"
scp "$@" -r packages/shell/dist/. "$TARGET:/opt/dash-sites/shell.new/"
ssh "$@" "$TARGET" '
set -e
mv /opt/dash-sites/shell.new/Caddyfile /etc/caddy/Caddyfile.new
caddy validate --adapter caddyfile --config /etc/caddy/Caddyfile.new >/dev/null 2>&1 || { echo "Caddyfile does not validate" >&2; exit 1; }
rm -rf /opt/dash-sites/shell.old
[ -d /opt/dash-sites/shell ] && mv /opt/dash-sites/shell /opt/dash-sites/shell.old
mv /opt/dash-sites/shell.new /opt/dash-sites/shell
chmod -R a+rX /opt/dash-sites/shell
mv /etc/caddy/Caddyfile.new /etc/caddy/Caddyfile
mv /opt/dash-sites/gateway.mjs.new /opt/dash-sites/gateway.mjs
systemctl restart dash-sites-gateway
systemctl reload caddy
sleep 4
systemctl is-active dash-sites-gateway
curl -fsS -H "Host: $(. /etc/dash-sites/gateway.env; echo ${GATEWAY_DOMAINS%%,*})" http://127.0.0.1:8080/healthz
cat /opt/dash-sites/shell/shell.json'
