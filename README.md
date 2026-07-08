# WERKOS — Das modulare Betriebssystem für Kleinstbetriebe (SaaS)

**Eine PWA, eine Datenbasis, ein Preis pro Betrieb.** Dieses Repository enthält die
komplette, verkaufsfähige SaaS-Plattform: die Handwerks-PWA (`web/`) plus das
mandantenfähige Backend (`server/`), GoBD- und DSGVO-konform, inklusive
Deployment für Hetzner (Deutschland).

## Architektur

```
┌───────────────────────────────────────────────────────────┐
│  web/app.html   — die PWA (Projekte, Zeiten, Angebote,     │
│                   Rechnungen, Stundenzettel …)             │
│  web/saas.js    — SaaS-Bootstrap: Login/Registrierung,     │
│                   Magic-Links, Konto-Widget, Tarifwahl     │
├───────────────────────────────────────────────────────────┤
│  server/        — Multi-Tenant-Backend (Node ≥22.5,        │
│                   ZERO Dependencies)                       │
│   /api/auth/*   — Registrierung, Login, Refresh, Invites   │
│   /api/t/*      — Mandanten-Daten: state, files, restore   │
│   /api/gobd/*   — Audit-Trail (Hash-Kette), Revisionen     │
│   /api/dsgvo/*  — Datenexport (ZIP), Löschung m. Karenz    │
│   /api/admin/*  — Plattform-Betreiber (X-Admin-Token)      │
├───────────────────────────────────────────────────────────┤
│  SQLite (WAL) — 1 Datei, tenant_id auf jeder Zeile;        │
│  Migrationspfad → PostgreSQL + RLS in docs/DEPLOYMENT.md   │
└───────────────────────────────────────────────────────────┘
```

**Grundsatz:** Ein Deployment, eine DB, ein Repo — kein Microservice-Zoo.
Module sind Feature-Flags pro Tarif auf derselben Datenbasis.

## Schnellstart (lokal)

```bash
node server/src/index.js        # → http://localhost:4000
```

Im Browser öffnen → **Betrieb registrieren** (14 Tage Testphase, alle Module,
ohne Zahlungsdaten). Mitarbeiter kommen **ohne Passwort** per Einladungs-Link/QR
dazu (Konto-Widget unten links → „Mitarbeiter einladen").

## Tests

```bash
cd server && node --test test/   # 16 Integrationstests
```

Abgedeckt: Mandantentrennung, Auth (Token-Fälschung, Refresh-Rotation,
Brute-Force-Limit), Rollen (Mitarbeiter/Steuerberater), GoBD (unveränderliche
Revisionen, Audit-Hash-Kette inkl. Manipulationserkennung), DSGVO (Export,
Löschung mit Karenzfrist), Tarif-Gating, Path-Traversal, ZIP-Restore.

## Tarife (ein Preis pro Betrieb — niemals pro Nutzer)

| Tarif | Preis/Monat | Module |
|---|---|---|
| Testphase | 0 € (14 Tage) | alle |
| START | 15 € | Zeiten |
| BETRIEB | 35 € | Zeiten, Aufträge, Geld |
| BETRIEB PLUS | 59 € | alle inkl. Planung, Compliance, KI |

Tarifwahl im Konto-Widget; Zahlungsabwicklung (Stripe SEPA) dockt an
`POST /api/billing/webhook` an — siehe `server/src/routes.js`.

## Rollen

| Rolle | Zugang | Rechte |
|---|---|---|
| owner | E-Mail + Passwort | alles inkl. Tarif, Löschung, Export |
| office | Einladung | Daten schreiben, Mitarbeiter einladen |
| employee | Magic-Link/QR, **kein Passwort** | Betriebsdaten nutzen (App-gesteuert) |
| external (Steuerberater) | Magic-Link | **nur lesen** + Audit + Export |

## Compliance

GoBD (Unveränderlichkeit, Nachvollziehbarkeit, Datenzugriff) und DSGVO
(Auskunft, Export, Löschung, AVV, TOMs) sind in **docs/COMPLIANCE.md**
dokumentiert — inklusive dessen, was organisatorisch noch vom Betreiber
kommen muss (AV-Vertrag, Verfahrensdokumentation unterschreiben usw.).

## Produktion

Hetzner + Docker + Caddy (automatisches TLS): **docs/DEPLOYMENT.md**.

```bash
cd deploy && cp .env.example .env   # Secrets setzen
docker compose up -d
```

## Erstumzug aus der Einzelplatz-Version

Bestehende Nutzer der Einzelplatz-PWA spielen ihr Voll-Backup (ZIP) nach dem
Login über die vorhandene Funktion „Voll-Backup auf Server einspielen" ein —
der Server übernimmt `state.json` + alle Dateien in den eigenen Mandanten
(`POST /api/t/restore-zip`).

## Repo-Struktur

```
web/            PWA + saas.js + Bibliotheken (self-hosted, gepinnt)
server/src/     Backend (config, util, zip, db, http, routes, server, index)
server/test/    Integrationstests (node --test)
deploy/         Dockerfile, docker-compose, Caddyfile, .env.example
docs/           DEPLOYMENT.md, COMPLIANCE.md
```
