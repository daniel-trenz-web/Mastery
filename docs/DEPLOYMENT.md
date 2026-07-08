# WERKOS — Produktions-Deployment (Hetzner, Deutschland)

## 1. Voraussetzungen

- Hetzner Cloud-Server (CX22 reicht für die ersten ~200 Betriebe), Ubuntu 24.04
- Domain mit A/AAAA-Record auf den Server (z. B. `app.werkos.de`)
- Docker + Docker-Compose-Plugin installiert

## 2. Installation

```bash
git clone <repo> werkos && cd werkos/deploy
cp .env.example .env
# Secrets erzeugen und in .env eintragen:
openssl rand -base64 48   # → WERKOS_SECRET
openssl rand -hex 24      # → WERKOS_ADMIN_TOKEN
# WERKOS_DOMAIN + WERKOS_BASE_URL auf die echte Domain setzen
docker compose up -d --build
```

Caddy holt automatisch ein Let's-Encrypt-Zertifikat und setzt HSTS.
Die App ist danach unter `https://<domain>/` erreichbar; Registrierung ist offen
(14-Tage-Testphase, Rate-Limit 10 Registrierungen/Stunde/IP).

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
