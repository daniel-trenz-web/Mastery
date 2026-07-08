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

**Seitenstruktur:**

| Pfad | Inhalt |
|---|---|
| `/` | Marketing-Website (Funktionen, Preise, FAQ, Demo-Formular mit DSGVO-Consent) |
| `/app` | die Anwendung (Login/Registrierung, PWA) |
| `/angebot#<token>` | öffentliche Angebotsseite (Kunde unterschreibt) |
| `/admin` | Betreiber-Konsole (Tarife, Modul-Overrides, Leads) |
| `/impressum`, `/datenschutz` | Rechtsseiten (Platzhalter vor Go-Live füllen!) |

**Demo-Zugang von der Website:** Das Formular (Name, Firma, E-Mail, Consent-
Checkbox) legt sofort einen echten Testbetrieb an (14 Tage, alle Module),
zeigt einmalig die Zugangsdaten und leitet eingeloggt in die App. Der Lead
wird mit Consent-Zeitstempel + IP gespeichert (Art. 7 DSGVO) und ist unter
`GET /api/admin/leads` abrufbar bzw. löschbar.

Mitarbeiter kommen **ohne Passwort** per Einladungs-Link/QR dazu
(Konto-Widget unten links → „Mitarbeiter einladen").

## Tests

```bash
cd server && node --test test/   # 16 Integrationstests
```

Abgedeckt: Mandantentrennung, Auth (Token-Fälschung, Refresh-Rotation,
Brute-Force-Limit), Rollen (Mitarbeiter/Steuerberater), GoBD (unveränderliche
Revisionen, Audit-Hash-Kette inkl. Manipulationserkennung), DSGVO (Export,
Löschung mit Karenzfrist), Tarif-Gating, Path-Traversal, ZIP-Restore.

## Module & Tarife (ein Preis pro Betrieb — niemals pro Nutzer)

**5 schlanke Module**, die je einen eigenen Kaufgrund haben:

| Modul | Inhalt (App-Bereiche) |
|---|---|
| Zeiten & Team | Mitarbeiter, Kolonnen, Tickets, Auswertungen |
| Aufträge & Baustelle | Berichte/Bautagebuch, Mängel, LVs, Controlling-Cockpit |
| Angebote & Rechnungen | Angebote inkl. **Kunden-Link mit Unterschrift**, Rechnungen |
| Einsatzplanung | Kalender / Drag-&-Drop-Planung |
| Einkauf & Lager | Lieferanten, Bestellungen, Eingangsrechnungen, Lager |

| Tarif | Preis/Monat | Module |
|---|---|---|
| Testphase | 0 € (14 Tage) | alle 5 |
| START | 15 € | Zeiten & Team |
| BETRIEB | 35 € | + Aufträge, + Angebote/Rechnungen |
| BETRIEB PLUS | 59 € | alle 5 |

**Freischaltung:** Der Tarifabschluss schaltet die Module **automatisch** frei
(Navigation der App passt sich sofort an). Zusätzlich kann der **Betreiber**
in der Konsole unter `/admin` (Zugriff via `WERKOS_ADMIN_TOKEN`) pro Mandant
einzelne Module übersteuern — freischalten oder sperren, unabhängig vom Tarif.
Zahlungsabwicklung (Stripe SEPA) dockt an `POST /api/billing/webhook` an.

## Angebots-Links (Kunde unterschreibt per Handy)

Im Angebot: **„📲 Kunden-Link (WhatsApp)"** → WERKOS erzeugt einen öffentlichen
Link (`/angebot#<token>`), teilbar per WhatsApp/Kopieren/QR. Der Kunde sieht das
Angebot mobiloptimiert, **unterschreibt mit dem Finger** und nimmt verbindlich
an (oder lehnt mit Kommentar ab). Die Antwort fließt **automatisch** in den
Angebots-Status der App zurück (inkl. Name, Zeitstempel, Anmerkung); die
Unterschrift ist im Konto-Widget abrufbar und die Annahme steht revisionssicher
im GoBD-Audit-Trail. Links sind zeitlich befristet und jederzeit widerrufbar.

## Kein Doppel-Login

Die WERKOS-Anmeldung steuert den App-Modus automatisch: Inhaber/Büro → Admin,
Steuerberater → Lese-Modus, Mitarbeiter → Mitarbeiter-Ansicht (Zuordnung über
das Mitarbeiter-Profil mit gleichem Namen, sonst Lese-Modus).

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
