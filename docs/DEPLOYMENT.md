# WERKOS — Produktions-Deployment (IONOS, Hetzner & Co.)

## 0. „Live testen" über Tailscale (schnellster Weg, ohne Domain)

Für interne Tests: **das System (App + API + Admin) läuft auf dem VPS und ist
nur über euer Tailscale-Netz erreichbar** — kein öffentliches DNS, keine offenen
Ports, automatisches HTTPS. Die Marketing-**Website** bleibt getrennt (statisch,
z. B. GitHub Pages) und wird von den Marketing-Routen des Systems angesteuert.

**Einmalig — Tailscale-Auth-Key holen:** Tailscale Admin-Konsole →
*Settings → Keys → Generate auth key* (Reusable empfohlen).

**Auf dem VPS** (Docker + Compose v2 vorausgesetzt):

```bash
git clone https://github.com/daniel-trenz-web/Mastery.git /opt/werkflow
cd /opt/werkflow/deploy
cp .env.example .env
#  in .env mindestens setzen:
#    TS_AUTHKEY=tskey-auth-…            (Tailscale Auth-Key)
#    WERKOS_SECRET=$(openssl rand -base64 48)
#    WERKOS_ADMIN_TOKEN=$(openssl rand -hex 24)   (= dein Admin-Login)
#    WERKOS_AI_KEY=sk-ant-…            (optional: schaltet KI-Chatbot & KI-Aufmaß scharf)
./tailscale-up.sh
```

Danach ist das System **nur für Geräte in eurem Tailnet** erreichbar unter:

- **App / Demozugang:** `https://werkflow-system.<euer-tailnet>.ts.net/app`
- **Admin-Zentrale:** `https://werkflow-system.<euer-tailnet>.ts.net/admin`
  (Login mit dem `WERKOS_ADMIN_TOKEN` aus der `.env`)

Der Demozugang funktioniert wie auf der Website: E-Mail eingeben → es wird
sofort ein 14-Tage-Testbetrieb mit Zugangsdaten angelegt. Trennung von der
Website steuert `WERKOS_SYSTEM_ONLY=true` + `WERKOS_MARKETING_URL` (die
`/`, `/preise`, … leiten dann auf die öffentliche Website um).

> Compose-Datei: `deploy/docker-compose.tailscale.yml` · Sidecar-Config:
> `deploy/tailscale/serve.json`. Stoppen: `docker compose -f docker-compose.tailscale.yml down`.

---

## 1. Voraussetzungen

- Ein **VPS/Cloud-Server** mit Ubuntu 22.04/24.04 oder Debian 12 und Root-SSH
  (IONOS VPS ab ~2 GB RAM reicht für die ersten ~200 Betriebe).
  ⚠ Ein IONOS **Webhosting-Paket** reicht NICHT — dort läuft kein Node/Docker;
  es muss ein „VPS" bzw. „Cloud Server" sein.
- Eine Domain oder Subdomain (z. B. `app.deine-firma.de`)

## 2. Schnell-Installation (ein Script)

**Schritt 1 — DNS:** Im Domain-Verwaltungsbereich (z. B. IONOS → Domains → DNS)
einen **A-Record** anlegen: `app` → `<IP deines Servers>`. (IPv6 vorhanden?
Zusätzlich AAAA-Record.)

**Schritt 2 — auf dem Server** (per SSH als root):

```bash
curl -fsSL https://raw.githubusercontent.com/daniel-trenz-web/Mastery/main/deploy/setup-server.sh -o setup.sh
bash setup.sh app.deine-firma.de
```

Das Script installiert Docker, öffnet die Firewall (80/443), klont das Repo
nach `/opt/werkos`, erzeugt die Secrets (`.env`) und startet alles. Am Ende
zeigt es dir die URLs **und deinen Admin-Token** an.

**IONOS-Besonderheit:** Wenn im IONOS-Cloud-Panel eine eigene Firewall-Policy
aktiv ist, dort ebenfalls die Ports **80 + 443 (TCP)** freigeben — sonst
bekommt Caddy kein TLS-Zertifikat.

Caddy holt automatisch ein Let's-Encrypt-Zertifikat und setzt HSTS. Danach:

| URL | Inhalt |
|---|---|
| `https://app.deine-firma.de/` | Website |
| `…/app` | die Anwendung |
| `…/admin` | Admin-Zentrale (Token aus der Installation) |

## 3. Weiterbearbeiten: Auto-Deploy bei jedem Merge

Damit Änderungen aus der Entwicklung automatisch auf dem Server landen:

1. Auf dem Server ein Deploy-Schlüsselpaar erzeugen:
   ```bash
   ssh-keygen -t ed25519 -f ~/.ssh/werkos_deploy -N ""
   cat ~/.ssh/werkos_deploy.pub >> ~/.ssh/authorized_keys
   cat ~/.ssh/werkos_deploy   # ← privaten Schlüssel kopieren
   ```
2. Im GitHub-Repo → **Settings → Secrets and variables → Actions** drei
   Secrets anlegen: `DEPLOY_HOST` (Server-IP), `DEPLOY_USER` (`root`),
   `DEPLOY_SSH_KEY` (der private Schlüssel aus Schritt 1).

Ab dann gilt: **Merge auf `main` → Server aktualisiert sich selbst**
(Workflow „Server-Deploy"). Ohne die Secrets wird der Schritt einfach
übersprungen. Manuell geht jederzeit: `bash /opt/werkos/deploy/update.sh`.
Kundendaten bleiben bei Updates unangetastet (eigenes Docker-Volume).

## 3. Betrieb

### Backups (GoBD-Pflicht!)

Der `backup`-Service legt täglich eine Kopie der SQLite-DB unter
`deploy/backups/` ab (30 Tage Rotation). **Zusätzlich extern sichern**, z. B.:

```bash
# restic Richtung Hetzner Storage Box (verschlüsselt, DE)
restic -r sftp:uXXXXX@uXXXXX.your-storagebox.de:werkos backup deploy/backups
```

Wiederherstellung: Container stoppen, `werkos.sqlite` ins Volume zurückkopieren, starten.

### Plattform-Admin

```bash
# Mandanten auflisten
curl -H "X-Admin-Token: $TOKEN" https://<domain>/api/admin/tenants
# Tarif setzen (z. B. nach Zahlungseingang per Rechnung)
curl -X POST -H "X-Admin-Token: $TOKEN" -H 'Content-Type: application/json' \
  -d '{"plan":"BETRIEB"}' https://<domain>/api/admin/tenants/<tenant-id>/plan
# Fällige DSGVO-Löschungen sofort ausführen (läuft sonst täglich automatisch)
curl -X POST -H "X-Admin-Token: $TOKEN" https://<domain>/api/admin/purge-due
```

### Updates

```bash
git pull && cd deploy && docker compose up -d --build
```

Kein Migrationsschritt nötig — das Schema wird per `CREATE TABLE IF NOT EXISTS`
gepflegt; neue Spalten kommen als Migrationsblock in `server/src/db.js`.

## 4. Skalierungspfad (bewusst einfach halten)

| Stufe | Wann | Was |
|---|---|---|
| 1 (jetzt) | bis ~500 Betriebe | 1 Server, SQLite WAL, tägliche Backups |
| 2 | ~500–2000 Betriebe | größerer Server (RAM/NVMe), Litestream-Replikation der SQLite auf S3-kompatiblen Speicher (Hetzner Object Storage) |
| 3 | >2000 Betriebe oder Team >1 | Migration auf **PostgreSQL mit Row-Level-Security**: Schema ist kompatibel gehalten (TEXT/INTEGER/BLOB, keine SQLite-Spezialitäten). RLS-Policy: `tenant_id = current_setting('app.tenant')`. Dateien nach S3 auslagern (`files.data` → Objektspeicher-Key) |

## 5. Monitoring & Sicherheit

- `docker compose logs -f werkos` — strukturierte Fehlerausgabe
- Healthcheck im Container (`HEALTHCHECK` im Dockerfile)
- Fail2ban optional; die App bringt eigene Rate-Limits für Login/Registrierung mit
- Server-Härtung: SSH nur mit Key, ufw (80/443/22), unattended-upgrades

## 6. Lokale Entwicklung

```bash
node server/src/index.js       # Port 4000, Daten in server/data/
cd server && node --test test/ # Testsuite
```
