'use strict';
// Zentrale Konfiguration — alles über Umgebungsvariablen steuerbar.
// In Produktion (Docker/Hetzner) werden diese Werte über docker-compose / .env gesetzt.

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const DATA_DIR = process.env.WERKOS_DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

// Geheimschlüssel für Token-Signaturen. In Produktion MUSS WERKOS_SECRET gesetzt sein.
// Für Entwicklung wird ein Schlüssel generiert und in data/ persistiert (damit
// Sessions einen Neustart überleben).
function loadOrCreateSecret() {
  if (process.env.WERKOS_SECRET) return process.env.WERKOS_SECRET;
  const f = path.join(DATA_DIR, '.secret');
  try { return fs.readFileSync(f, 'utf8').trim(); } catch (_e) {}
  const s = crypto.randomBytes(48).toString('base64url');
  fs.writeFileSync(f, s, { mode: 0o600 });
  return s;
}

module.exports = {
  PORT: Number(process.env.PORT || 4000),
  HOST: process.env.HOST || '0.0.0.0',
  DATA_DIR,
  DB_FILE: process.env.WERKOS_DB || path.join(DATA_DIR, 'werkos.sqlite'),
  SECRET: loadOrCreateSecret(),
  // Plattform-Admin-Token (für Betreiber-Endpunkte). Leer = Admin-API deaktiviert.
  ADMIN_TOKEN: process.env.WERKOS_ADMIN_TOKEN || '',
  // Öffentliche Basis-URL (für Magic-Links in E-Mails/QR-Codes).
  // Wenn nicht gesetzt, wird sie pro Request aus Host/Proto abgeleitet.
  BASE_URL: process.env.WERKOS_BASE_URL || '',
  WEB_DIR: process.env.WERKOS_WEB_DIR || path.join(__dirname, '..', '..', 'web'),

  // Token-Laufzeiten
  ACCESS_TTL_MS: 12 * 3600 * 1000,        // Access-Token: 12 h
  REFRESH_TTL_MS: 30 * 24 * 3600 * 1000,  // Refresh-Token: 30 Tage
  INVITE_TTL_MS: 14 * 24 * 3600 * 1000,   // Einladungslinks: 14 Tage Standard

  // Limits
  MAX_STATE_BYTES: 64 * 1024 * 1024,   // 64 MB State-JSON (Foto-lastige Betriebe)
  MAX_FILE_BYTES: 50 * 1024 * 1024,    // 50 MB pro Einzeldatei
  MAX_ZIP_BYTES: 512 * 1024 * 1024,    // 512 MB Voll-Restore

  // DSGVO: Frist bis zur endgültigen Löschung nach Kündigung des Mandanten
  DELETE_GRACE_DAYS: 30,

  // Modul-Katalog — bewusst schlank: 5 Module, die je einen Kaufgrund haben.
  // appModules = welche Funktionsbereiche der PWA das WERKOS-Modul freischaltet
  // (die PWA blendet Tabs über state.modules[key] ein/aus).
  MODULES: {
    zeiten:    { label: 'Zeiten & Team',         desc: 'Mitarbeiter, Stundenzettel, Kolonnen, Auswertungen', appModules: ['employees', 'kolonnen', 'tickets', 'wochen'] },
    auftraege: { label: 'Aufträge & Baustelle',  desc: 'Berichte/Bautagebuch, Mängel, LVs, Controlling-Cockpit', appModules: ['reports', 'maengel', 'lv', 'cockpit'] },
    geld:      { label: 'Angebote & Rechnungen', desc: 'Angebote mit Kunden-Link & Unterschrift, Rechnungen, Mahnwesen', appModules: ['angebote', 'rechnungen'] },
    planung:   { label: 'Einsatzplanung',        desc: 'Kalender, Mitarbeiter & Aufträge per Drag & Drop planen', appModules: ['calendar'] },
    einkauf:   { label: 'Einkauf & Lager',       desc: 'Lieferanten, Bestellungen, Eingangsrechnungen, Lager', appModules: ['einkauf'] },
  },

  // Tarife — ein Preis pro Betrieb, niemals pro Nutzer (Produktregel Nr. 6).
  // Abschluss eines Tarifs schaltet die Module AUTOMATISCH frei; zusätzlich kann
  // der Betreiber (Host) pro Mandant einzelne Module übersteuern (Admin-Konsole).
  PLANS: {
    TRIAL:        { label: 'Testphase',    priceEur: 0,  maxEmployees: 15, storageGb: 5,  modules: ['zeiten', 'auftraege', 'geld', 'planung', 'einkauf'] },
    START:        { label: 'START',        priceEur: 15, maxEmployees: 5,  storageGb: 2,  modules: ['zeiten'] },
    BETRIEB:      { label: 'BETRIEB',      priceEur: 35, maxEmployees: 10, storageGb: 10, modules: ['zeiten', 'auftraege', 'geld'] },
    BETRIEB_PLUS: { label: 'BETRIEB PLUS', priceEur: 59, maxEmployees: 15, storageGb: 25, modules: ['zeiten', 'auftraege', 'geld', 'planung', 'einkauf'] },
  },
  TRIAL_DAYS: 14,

  // Angebots-Links (Kunde nimmt per Unterschrift an)
  OFFER_LINK_DAYS: 30,             // Standard-Gültigkeit
  MAX_OFFER_PAYLOAD: 512 * 1024,   // Angebots-Snapshot (JSON)
  MAX_SIGNATURE_BYTES: 300 * 1024, // Unterschrift-PNG

  // Rate-Limits (pro IP); für Tests via Env übersteuerbar
  REGISTER_LIMIT_PER_HOUR: Number(process.env.WERKOS_REGISTER_LIMIT || 10),
};
