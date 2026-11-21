#!/usr/bin/env bash
# Provisions a fresh Ubuntu 24.04 host as a Dash Sites gateway. Run as root; safe to run again.
#   provision.sh <gateway-domain> <public-ipv4>
set -euo pipefail

DOMAIN=${1:?gateway domain, e.g. id.dashhq.org}
PUBLIC_IP=${2:?public IPv4 of this host}
AGNOS_VERSION=v0.1.1

export DEBIAN_FRONTEND=noninteractive

if ! swapon --show | grep -q /swapfile; then
  fallocate -l 1G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

apt-get update -q
apt-get install -y -q curl ca-certificates gnupg ufw unattended-upgrades debian-keyring debian-archive-keyring apt-transport-https

if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -q nodejs
fi

if ! command -v caddy >/dev/null; then
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -q
  apt-get install -y -q caddy
fi

for bin in agnos agnos-generate-accounts-keys; do
  if [ ! -x /usr/local/bin/$bin ]; then
    curl -fsSL -o /usr/local/bin/$bin "https://github.com/krtab/agnos/releases/download/${AGNOS_VERSION}/${bin}_amd64"
    chmod 755 /usr/local/bin/$bin
  fi
done

id dashsites >/dev/null 2>&1 || useradd --system --home /var/lib/dash-sites --shell /usr/sbin/nologin dashsites
install -d -o root -g root -m 755 /opt/dash-sites /etc/dash-sites
install -d -o root -g caddy -m 750 /etc/dash-sites/tls
install -d -o root -g root -m 700 /etc/dash-sites/acme
install -d -o dashsites -g dashsites -m 750 /var/lib/dash-sites
[ -f /etc/dash-sites/denylist.txt ] || printf '# name <label> | owner <identity id> | content <content URI>\n' > /etc/dash-sites/denylist.txt

cat > /etc/dash-sites/agnos.toml <<TOML
dns_listen_addr = "${PUBLIC_IP}:53"

[[accounts]]
email = "hostmaster@${DOMAIN}"
private_key_path = "/etc/dash-sites/acme/account.pem"

[[accounts.certificates]]
domains = ["${DOMAIN}", "*.${DOMAIN}"]
fullchain_output_file = "/etc/dash-sites/tls/fullchain.pem"
key_output_file = "/etc/dash-sites/tls/key.pem"
renewal_days_advance = 30
TOML
[ -f /etc/dash-sites/acme/account.pem ] || agnos-generate-accounts-keys --key-size 4096 --no-confirm /etc/dash-sites/agnos.toml

cat > /etc/systemd/system/dash-sites-cert.service <<'UNIT'
[Unit]
Description=Renew the Dash Sites wildcard certificate (ACME DNS-01 answered by this host)
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/local/bin/agnos --no-staging --no-color /etc/dash-sites/agnos.toml
ExecStartPost=/bin/sh -c 'chgrp caddy /etc/dash-sites/tls/*.pem && chmod 640 /etc/dash-sites/tls/*.pem && (systemctl reload caddy || true)'
UNIT

cat > /etc/systemd/system/dash-sites-cert.timer <<'UNIT'
[Unit]
Description=Daily check of the Dash Sites wildcard certificate

[Timer]
OnCalendar=daily
RandomizedDelaySec=2h
Persistent=true

[Install]
WantedBy=timers.target
UNIT

cat > /etc/systemd/system/dash-sites-gateway.service <<'UNIT'
[Unit]
Description=Dash Sites gateway
After=network-online.target
Wants=network-online.target

[Service]
User=dashsites
Group=dashsites
EnvironmentFile=/etc/dash-sites/gateway.env
ExecStart=/usr/bin/node --max-old-space-size=384 /opt/dash-sites/gateway.mjs
Restart=always
RestartSec=3
MemoryMax=700M
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
PrivateDevices=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictAddressFamilies=AF_INET AF_INET6
RestrictNamespaces=true
LockPersonality=true
CapabilityBoundingSet=
SystemCallArchitectures=native
ReadWritePaths=/var/lib/dash-sites

[Install]
WantedBy=multi-user.target
UNIT

mkdir -p /opt/dash-sites/shell
touch /etc/dash-sites/denied.caddy

ufw allow 22/tcp >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443 >/dev/null
ufw allow 53 >/dev/null
ufw --force enable >/dev/null

systemctl daemon-reload
systemctl enable --now dash-sites-cert.timer >/dev/null
echo "provisioned ${DOMAIN}; run deploy.sh to install the shell, the gateway process and the Caddy configuration"
