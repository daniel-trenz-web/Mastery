#!/usr/bin/env bash
# werkflow — Ein-Kommando-Start des SYSTEMS auf einem VPS, erreichbar über Tailscale.
# Voraussetzung: Docker + Docker Compose v2 auf dem VPS, eine ausgefüllte .env
# (siehe .env.example: mindestens TS_AUTHKEY, WERKOS_SECRET, WERKOS_ADMIN_TOKEN).
set -euo pipefail
cd "$(dirname "$0")"

COMPOSE="docker compose -f docker-compose.tailscale.yml"

if [ ! -f .env ]; then
  echo "❌ Keine .env gefunden. Bitte zuerst:  cp .env.example .env  und Werte setzen." >&2
  exit 1
fi
# shellcheck disable=SC1091
set -a; . ./.env; set +a

for v in TS_AUTHKEY WERKOS_SECRET WERKOS_ADMIN_TOKEN; do
  if [ -z "${!v:-}" ]; then echo "❌ $v ist in .env nicht gesetzt." >&2; exit 1; fi
done

echo "▶ Baue & starte das werkflow-System (Tailscale-Modus) …"
$COMPOSE up -d --build

echo "⏳ Warte auf Tailscale-Anmeldung …"
sleep 6
HOST="$($COMPOSE exec -T tailscale tailscale status --json 2>/dev/null | grep -o '\"DNSName\":\"[^\"]*\"' | head -1 | cut -d'"' -f4 | sed 's/\.$//')" || true

echo ""
echo "✅ System läuft (nur im Tailnet erreichbar)."
if [ -n "${HOST:-}" ]; then
  echo "   → App:   https://${HOST}/app"
  echo "   → Admin: https://${HOST}/admin"
else
  echo "   → Adresse:  https://<hostname>.<dein-tailnet>.ts.net   (siehe: $COMPOSE exec tailscale tailscale status)"
fi
echo ""
echo "Logs:   $COMPOSE logs -f werkos"
echo "Stop:   $COMPOSE down"
