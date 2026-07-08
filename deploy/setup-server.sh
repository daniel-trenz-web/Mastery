#!/usr/bin/env bash
# WERKOS — Erst-Einrichtung auf einem frischen Linux-Server (IONOS VPS, Hetzner, …)
# Getestet für Ubuntu 22.04/24.04 und Debian 12. Als root ausführen:
#
#   curl -fsSL https://raw.githubusercontent.com/daniel-trenz-web/Mastery/main/deploy/setup-server.sh -o setup.sh
#   bash setup.sh app.deine-domain.de
#
# Danach läuft WERKOS unter https://app.deine-domain.de (TLS automatisch).
set -euo pipefail

DOMAIN="${1:-}"
REPO="${WERKOS_REPO:-https://github.com/daniel-trenz-web/Mastery.git}"
DIR=/opt/werkos

if [ -z "$DOMAIN" ]; then
  echo "Aufruf: bash setup.sh <domain>   (z. B. bash setup.sh app.meine-firma.de)"
  echo "WICHTIG: Der DNS-A-Record der Domain muss bereits auf die IP dieses Servers zeigen."
  exit 1
fi

echo "▶ 1/6 System aktualisieren …"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq && apt-get upgrade -y -qq

echo "▶ 2/6 Docker installieren (falls fehlt) …"
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
fi
docker compose version >/dev/null 2>&1 || apt-get install -y -qq docker-compose-plugin

echo "▶ 3/6 Firewall (ufw): SSH + HTTP/HTTPS freigeben …"
if command -v ufw >/dev/null 2>&1; then
  ufw allow OpenSSH >/dev/null || true
  ufw allow 80/tcp >/dev/null && ufw allow 443/tcp >/dev/null
  yes | ufw enable >/dev/null || true
fi
echo "   Hinweis IONOS: Falls die Cloud-Panel-Firewall aktiv ist, dort ebenfalls 80 + 443 öffnen!"

echo "▶ 4/6 Repository nach $DIR klonen …"
if [ -d "$DIR/.git" ]; then
  git -C "$DIR" pull --ff-only
else
  git clone "$REPO" "$DIR"
fi

echo "▶ 5/6 Secrets erzeugen und .env schreiben …"
cd "$DIR/deploy"
if [ ! -f .env ]; then
  SECRET=$(openssl rand -base64 48 | tr -d '\n')
  ADMIN=$(openssl rand -hex 24)
  cat > .env <<EOF
WERKOS_DOMAIN=$DOMAIN
WERKOS_BASE_URL=https://$DOMAIN
WERKOS_SECRET=$SECRET
WERKOS_ADMIN_TOKEN=$ADMIN
EOF
  chmod 600 .env
  echo "   .env angelegt."
else
  echo "   .env existiert bereits — bleibt unangetastet."
fi

echo "▶ 6/6 Container bauen und starten …"
docker compose up -d --build

ADMIN_TOKEN=$(grep '^WERKOS_ADMIN_TOKEN=' .env | cut -d= -f2)
IP=$(hostname -I 2>/dev/null | awk '{print $1}')
echo
echo "══════════════════════════════════════════════════════════════"
echo "✅ WERKOS läuft!"
echo
echo "   Website:        https://$DOMAIN/"
echo "   App:            https://$DOMAIN/app"
echo "   Admin-Zentrale: https://$DOMAIN/admin"
echo "   Admin-Token:    $ADMIN_TOKEN"
echo "                   (sicher aufbewahren — steht auch in $DIR/deploy/.env)"
echo
echo "   Falls die Seite nicht lädt: DNS prüfen (A-Record → $IP)"
echo "   und im IONOS-Cloud-Panel die Ports 80/443 freigeben."
echo
echo "   Update später:  bash $DIR/deploy/update.sh"
echo "══════════════════════════════════════════════════════════════"
