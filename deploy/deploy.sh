#!/usr/bin/env bash
# Builds the gateway bundle and installs it on the gateway host.
#   deploy.sh <ssh-target> [ssh options...]
set -euo pipefail
TARGET=${1:?ssh target, e.g. root@gateway-host}
shift
cd "$(dirname "$0")/.."
npm run build
npm run bundle -w @dash-sites/gateway
scp "$@" packages/gateway/bundle/gateway.mjs "$TARGET:/opt/dash-sites/gateway.mjs.new"
ssh "$@" "$TARGET" 'mv /opt/dash-sites/gateway.mjs.new /opt/dash-sites/gateway.mjs && systemctl restart dash-sites-gateway && sleep 4 && systemctl is-active dash-sites-gateway && curl -fsS -H "Host: $(. /etc/dash-sites/gateway.env; echo ${GATEWAY_DOMAINS%%,*})" http://127.0.0.1:8080/healthz'
