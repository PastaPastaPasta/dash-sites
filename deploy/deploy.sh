#!/usr/bin/env bash
# Builds the shell and the gateway process and installs both on the gateway host.
#   deploy.sh <ssh-target> [ssh options...]
set -euo pipefail
TARGET=${1:?ssh target, e.g. root@gateway-host}
shift
cd "$(dirname "$0")/.."

read -r DOMAIN NETWORK BUILDER_URL RESERVED DENYLIST_FILE CONTRACT_ID < <(ssh "$@" "$TARGET" '. /etc/dash-sites/gateway.env; echo "${GATEWAY_DOMAINS%%,*} ${NETWORK:-testnet} ${BUILDER_URL:--} ${RESERVED_LABELS:-www} ${DENYLIST_FILE:--} ${CONTRACT_ID:-}"')
[ "$BUILDER_URL" = - ] && unset BUILDER_URL
RESERVED_HOSTS=$(echo "$RESERVED" | tr ',' '\n' | sed "s/\$/.$DOMAIN/" | tr '\n' ' ')

npx tsc -b
npm run bundle -w @dash-sites/gateway
export NETWORK CONTRACT_ID
# A host with a denylist is a hosted gateway: its shell honours the operator's denylist.
DENYLIST=0
[ "$DENYLIST_FILE" != - ] && DENYLIST=1
export DENYLIST
[ -n "${BUILDER_URL:-}" ] && export BUILDER_URL
node packages/shell/build.mjs >/dev/null
node -e '
const { readFileSync, readdirSync, writeFileSync } = require("node:fs");
const { brotliCompressSync, constants } = require("node:zlib");
for (const file of readdirSync("packages/shell/dist").filter((name) => name.endsWith(".js"))) {
  const data = readFileSync(`packages/shell/dist/${file}`);
  writeFileSync(`packages/shell/dist/${file}.br`, brotliCompressSync(data, { params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: data.length } }));
}'
sed -e "s/__RESERVED_HOSTS__/$RESERVED_HOSTS/" -e "s/__DOMAIN__/$DOMAIN/g" deploy/Caddyfile > packages/shell/dist/Caddyfile

ssh "$@" "$TARGET" 'rm -rf /opt/dash-sites/shell.new && mkdir -p /opt/dash-sites/shell.new && touch /etc/dash-sites/denied.caddy'
scp "$@" packages/gateway/bundle/gateway.mjs "$TARGET:/opt/dash-sites/gateway.mjs.new"
scp "$@" deploy/dash-sites-deny "$TARGET:/usr/local/bin/dash-sites-deny.new.mjs"
scp "$@" -r packages/shell/dist/. "$TARGET:/opt/dash-sites/shell.new/"
ssh "$@" "$TARGET" "DOMAIN=$DOMAIN bash -s" <<'REMOTE'
set -e
mv /opt/dash-sites/shell.new/Caddyfile /etc/caddy/Caddyfile.new
HOSTED=$(. /etc/dash-sites/gateway.env; [ -n "${DENYLIST_FILE:-}" ] && echo 1 || true)
if [ -n "$HOSTED" ]; then node /usr/local/bin/dash-sites-deny.new.mjs list >/dev/null || { echo "denylist does not parse; nothing changed" >&2; exit 1; }; fi
caddy validate --adapter caddyfile --config /etc/caddy/Caddyfile.new >/dev/null 2>&1 || { echo "Caddyfile does not validate" >&2; exit 1; }
rm -rf /opt/dash-sites/shell.old
[ -d /opt/dash-sites/shell ] && mv /opt/dash-sites/shell /opt/dash-sites/shell.old
mv /opt/dash-sites/shell.new /opt/dash-sites/shell
chmod -R a+rX /opt/dash-sites/shell
mv /etc/caddy/Caddyfile.new /etc/caddy/Caddyfile
mv /opt/dash-sites/gateway.mjs.new /opt/dash-sites/gateway.mjs
chmod 755 /usr/local/bin/dash-sites-deny.new.mjs
mv /usr/local/bin/dash-sites-deny.new.mjs /usr/local/bin/dash-sites-deny
systemctl restart dash-sites-gateway
systemctl reload caddy
if [ -n "$HOSTED" ]; then dash-sites-deny apply || echo "WARNING: dash-sites-deny apply failed; the deploy itself is done" >&2; fi
sleep 4
systemctl is-active dash-sites-gateway
curl -fsS -H "Host: $DOMAIN" http://127.0.0.1:8080/healthz
cat /opt/dash-sites/shell/shell.json
REMOTE
