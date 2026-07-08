# WERKOS — GoBD- & DSGVO-Konformität

Dieses Dokument beschreibt, **was die Plattform technisch umsetzt** und **was der
Betreiber organisatorisch ergänzen muss**. Es ist keine Rechtsberatung; vor dem
kommerziellen Start von einem Fachanwalt/Steuerberater prüfen lassen.

---

## 1. GoBD (Grundsätze ordnungsmäßiger Buchführung in elektronischer Form)

### 1.1 Unveränderlichkeit & Nachvollziehbarkeit (technisch umgesetzt)

| Anforderung | Umsetzung |
|---|---|
| Unveränderlichkeit von Geschäftsdaten | Jede Speicherung des Betriebs-States erzeugt eine **unveränderliche Revision** (`state_revisions`, kein UPDATE/DELETE). Historische Stände bleiben abrufbar: `GET /api/gobd/revisions/<rev>` |
| Protokollierung von Änderungen | **Audit-Trail mit Hash-Kette** (`audit_log`): jeder Eintrag enthält den SHA-256 des Vorgängers. Nachträgliche Manipulation bricht die Kette und ist per `GET /api/gobd/verify` nachweisbar (im UI: Konto-Widget → „GoBD-Prüfkette verifizieren") |
| Versionierung von Belegen/Dateien | Datei-Uploads sind **versioniert** (`files`): eine neue Version überschreibt nie die alte |
| Datenzugriff (Z1–Z3 der Finanzverwaltung) | Vollständiger maschinenlesbarer Export als ZIP (`GET /api/dsgvo/export`): State (JSON), alle Dateien, Audit-Log, Revisionsliste |
| Zeitgerechte Erfassung | Auto-Sync der PWA (debounced + Intervall); jede Revision trägt Zeitstempel + Verursacher (`created_by`) |
| Datensicherung | Tägliches DB-Backup (deploy/docker-compose.yml, `backup`-Service, 30 Tage Rotation); extern sichern via restic/borg empfohlen |

### 1.2 Aufbewahrung

- Revisionen und Dateiversionen werden **nie automatisch gelöscht** (Aufbewahrungsfristen § 147 AO: 8 Jahre Buchungsbelege / 10 Jahre Bücher, Stand 2026 nach BEG IV prüfen).
- Bei DSGVO-Mandantenlöschung weist die Plattform den Inhaber explizit darauf hin, **vorher den Export zu ziehen** — ab Löschung liegt die Aufbewahrungspflicht beim Betrieb.

### 1.3 Vom Betreiber organisatorisch zu ergänzen

- **Verfahrensdokumentation** nach GoBD-Muster (AWV-Muster) erstellen — dieses Dokument + README sind die technische Basis dafür.
- Internes Kontrollsystem (IKS) beschreiben: Wer hat Admin-Zugriff, wie werden Deployments freigegeben.

---

## 2. DSGVO

### 2.1 Technische Umsetzung

| Recht/Pflicht | Umsetzung |
|---|---|
| Mandantentrennung (Art. 32) | `tenant_id` auf jeder Zeile; alle Datenzugriffe laufen über tenant-gebundene Funktionen (`server/src/db.js`); Token trägt den Mandanten-Kontext; `X-Tenant-Key`-Mismatch → 403. Durch Tests abgesichert |
| Auskunft & Portabilität (Art. 15/20) | Ein-Klick-ZIP-Export (State, Dateien, Nutzerliste, Audit-Log) im Konto-Widget |
| Löschung (Art. 17) | Inhaber-Löschung mit Passwort-Bestätigung → 30 Tage Karenz (widerruflich) → **endgültige Löschung** aller Nutzer, Dateien, Revisionen, Sessions; Tombstone dokumentiert die erfolgte Löschung |
| Datenminimierung (Art. 5) | Mitarbeiter brauchen **keine E-Mail/kein Passwort** (Magic-Link); Sessions speichern nur gekürzten User-Agent + IP für Missbrauchserkennung |
| Sicherheit der Verarbeitung (Art. 32) | scrypt-Passwort-Hashing, HMAC-signierte Access-Tokens (12 h), rotierende Refresh-Tokens (nur Hash gespeichert), Rate-Limits gegen Brute-Force, TLS via Caddy (HSTS), Security-Header, Path-Traversal-Schutz |
| Speicherort | Hosting-Blaupause: Hetzner **Deutschland**; keine Drittland-Übermittlung durch die Plattform selbst |
| Rechenschaftspflicht (Art. 5 Abs. 2) | Audit-Log protokolliert Login, Export, Löschbegehren, Tarifwechsel, Einladungen |

### 2.2 Rollenmodell (Zugriffsbeschränkung)

- `external` (Steuerberater): serverseitig **nur lesend** — Schreibversuche werden mit 403 abgelehnt.
- Einladungen sind zeitlich befristet, in der Nutzungszahl begrenzt und widerrufbar.
- Abgelaufene Testphase sperrt nur das **Schreiben** — Auskunft/Export bleiben immer möglich (kein „Daten-Geiselhaft"-Lock-in; Produktregel 7).

### 2.3 Vom Betreiber organisatorisch zu ergänzen (vor Verkaufsstart!)

1. **AV-Vertrag (Art. 28)** mit jedem Kunden-Betrieb — Muster z. B. von Bitkom; als PDF im Registrierungsprozess verlinken.
2. **Datenschutzerklärung + Impressum** auf der Login-Seite verlinken (Platzhalter im Gate-Footer vorhanden).
3. **Verzeichnis von Verarbeitungstätigkeiten (Art. 30)** führen.
4. **Unter-Auftragsverarbeiter** dokumentieren (Hetzner; später Stripe, KI-API) und in den AVV aufnehmen. Für das KI-Modul (P4): Anbieter mit EU-Datenverarbeitung bzw. Zero-Data-Retention wählen und im AVV ergänzen.
5. **TOM-Dokument** (technische und organisatorische Maßnahmen) — Abschnitt 2.1 ist die technische Grundlage.
6. Meldeprozess für Datenpannen (Art. 33: 72 h) definieren.

---

## 3. Bekannte Grenzen der V1 (ehrlich dokumentiert, mit Roadmap)

1. **State-Blob-Synchronisation:** Die PWA synchronisiert den Betriebs-State als
   Ganzes (Last-Write-Wins). Feingranulare Objekt-Rechte pro Rolle erzwingt die
   App, nicht der Server (Ausnahme: `external` = read-only, Mitarbeiter können
   keine Backups einspielen/Einladungen erstellen). **Roadmap:** Objekt-API
   (`/projects`, `/time-entries` …) — der API-Client dafür existiert bereits in
   der PWA (V10-Client), der Server ist darauf vorbereitet.
2. **2FA für Inhaber:** vorgesehen (P1), in V1 noch nicht aktiv. Kompensation:
   starke Passwort-Policy (min. 10 Zeichen), Rate-Limits, Session-Rotation.
3. **Stripe-Abbuchung:** Tarifwahl ist live, die automatische SEPA-Abbuchung
   dockt an `POST /api/billing/webhook` an (Signaturprüfung dort ergänzen,
   sobald echte Stripe-Keys existieren). Bis dahin: manuelle Rechnung + Tarif
   via Admin-API.
4. **E-Mail-Versand** (Passwort-Reset, Magic-Link per Mail): V1 verteilt Links
   per QR/Messenger durch den Chef; SMTP-Anbindung ist der nächste Ausbauschritt.
