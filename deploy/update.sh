#!/usr/bin/env bash
# WERKOS — Update auf dem Server: neuesten Stand von main holen und neu starten.
# Wird auch vom GitHub-Auto-Deploy (.github/workflows/deploy.yml) aufgerufen.
set -euo pipefail
DIR=/opt/werkos
git -C "$DIR" pull --ff-only
cd "$DIR/deploy"
docker compose up -d --build
docker image prune -f >/dev/null
echo "✅ WERKOS aktualisiert: $(git -C "$DIR" log --oneline -1)"
