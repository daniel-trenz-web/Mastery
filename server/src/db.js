'use strict';
// Datenhaltung: SQLite (node:sqlite, ohne externe Abhängigkeiten).
// JEDE geschäftsrelevante Tabelle trägt tenant_id — die Datenschicht erzwingt
// Mandantentrennung, weil ALLE Zugriffe über die hier definierten, bereits
// tenant-gebundenen Funktionen laufen (kein freies SQL in den Routen).
//
// Produktionspfad: Das Schema ist bewusst PostgreSQL-kompatibel gehalten
// (TEXT/INTEGER/BLOB, keine SQLite-Spezialitäten) — Migration auf Postgres
// mit Row-Level-Security ist in docs/DEPLOYMENT.md beschrieben.

const { DatabaseSync } = require('node:sqlite');
const zlib = require('zlib');
const { DB_FILE } = require('./config');
const { id, nowIso, sha256 } = require('./util');

const db = new DatabaseSync(DB_FILE);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS tenants (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  plan          TEXT NOT NULL DEFAULT 'TRIAL',
  trial_ends_at TEXT,
  status        TEXT NOT NULL DEFAULT 'active',   -- active | deletion_pending | deleted
  delete_after  TEXT,                             -- DSGVO: Ende der Karenzfrist
  created_at    TEXT NOT NULL,
  settings_json TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL REFERENCES tenants(id),
  email         TEXT,                             -- NULL bei Magic-Link-Mitarbeitern
  name          TEXT NOT NULL,
  role          TEXT NOT NULL,                    -- owner | office | employee | external
  pass_hash     TEXT,
  status        TEXT NOT NULL DEFAULT 'active',
  created_at    TEXT NOT NULL,
  last_login_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS users_email ON users(email) WHERE email IS NOT NULL;
CREATE INDEX IF NOT EXISTS users_tenant ON users(tenant_id);

CREATE TABLE IF NOT EXISTS sessions (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id),
  tenant_id    TEXT NOT NULL REFERENCES tenants(id),
  refresh_hash TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  revoked_at   TEXT,
  ip           TEXT, ua TEXT
);
CREATE INDEX IF NOT EXISTS sessions_hash ON sessions(refresh_hash);

CREATE TABLE IF NOT EXISTS magic_links (
  id         TEXT PRIMARY KEY,
  tenant_id  TEXT NOT NULL REFERENCES tenants(id),
  created_by TEXT NOT NULL,
  role       TEXT NOT NULL DEFAULT 'employee',
  name       TEXT,
  token_hash TEXT NOT NULL,
  max_uses   INTEGER NOT NULL DEFAULT 1,
  uses       INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS magic_hash ON magic_links(token_hash);

-- GoBD: Jede Speicherung des Betriebs-States ist eine UNVERÄNDERLICHE Revision
-- (gzip-komprimiert). Es gibt kein UPDATE/DELETE auf dieser Tabelle.
CREATE TABLE IF NOT EXISTS state_revisions (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id  TEXT NOT NULL REFERENCES tenants(id),
  rev        INTEGER NOT NULL,
  sha256     TEXT NOT NULL,
  size       INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  data_gz    BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS staterev_tenant ON state_revisions(tenant_id, rev);

-- Dateien (Belege, Fotos, PDFs): versioniert, alte Versionen bleiben erhalten (GoBD).
CREATE TABLE IF NOT EXISTS files (
  id           TEXT PRIMARY KEY,
  tenant_id    TEXT NOT NULL REFERENCES tenants(id),
  path         TEXT NOT NULL,
  version      INTEGER NOT NULL,
  size         INTEGER NOT NULL,
  sha256       TEXT NOT NULL,
  content_type TEXT,
  created_at   TEXT NOT NULL,
  created_by   TEXT NOT NULL,
  data         BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS files_tenant_path ON files(tenant_id, path, version);

-- Angebots-Links: Kunde öffnet Angebot per Link, unterschreibt und nimmt an/lehnt ab.
-- payload_json ist ein UNVERÄNDERLICHER Snapshot des Angebots zum Zeitpunkt des Teilens
-- (GoBD: der Kunde nimmt genau diesen Stand an).
CREATE TABLE IF NOT EXISTS offer_links (
  id             TEXT PRIMARY KEY,
  tenant_id      TEXT NOT NULL REFERENCES tenants(id),
  token_hash     TEXT NOT NULL,
  angebot_id     TEXT,
  number         TEXT,
  payload_json   TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'open',  -- open | accepted | declined | revoked
  created_at     TEXT NOT NULL,
  created_by     TEXT NOT NULL,
  expires_at     TEXT NOT NULL,
  opened_at      TEXT,
  responded_at   TEXT,
  responder_name TEXT,
  responder_comment TEXT,
  responder_ip   TEXT,
  signature_png  BLOB
);
CREATE INDEX IF NOT EXISTS offer_token ON offer_links(token_hash);
CREATE INDEX IF NOT EXISTS offer_tenant ON offer_links(tenant_id, created_at);

-- Abonnements: der Kaufabschluss eines Mandanten. price_eur ist ein SNAPSHOT
-- (erlaubt individuelle Vertriebspreise, Bestandsschutz bei Preiserhöhungen).
CREATE TABLE IF NOT EXISTS subscriptions (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL REFERENCES tenants(id),
  plan          TEXT NOT NULL,
  price_eur     REAL NOT NULL,
  billing_json  TEXT NOT NULL DEFAULT '{}',   -- Firma, Anschrift, USt-ID, Zahlweise
  source        TEXT NOT NULL DEFAULT 'website', -- website | sales_offer | admin
  status        TEXT NOT NULL DEFAULT 'active',  -- active | cancelled
  created_at    TEXT NOT NULL,
  created_by    TEXT,
  cancelled_at  TEXT
);
CREATE INDEX IF NOT EXISTS subs_tenant ON subscriptions(tenant_id, created_at);

-- Vertriebs-Angebote: WIR (Betreiber) schicken beratenen Interessenten ein
-- persönliches Abo-Angebot (ggf. Sonderpreis) — online abschließbar.
CREATE TABLE IF NOT EXISTS sales_offers (
  id           TEXT PRIMARY KEY,
  token_hash   TEXT NOT NULL,
  company      TEXT NOT NULL,
  contact_name TEXT,
  email        TEXT NOT NULL,
  phone        TEXT,
  plan         TEXT NOT NULL,
  price_eur    REAL NOT NULL,
  message      TEXT,
  valid_until  TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'open',  -- open | accepted | revoked
  created_at   TEXT NOT NULL,
  accepted_at  TEXT,
  tenant_id    TEXT
);
CREATE INDEX IF NOT EXISTS salesoffer_token ON sales_offers(token_hash);

-- Demo-/Kontakt-Anfragen von der Website (Leads) — DSGVO: nur mit Consent,
-- Zeitstempel + IP als Nachweis der Einwilligung (Art. 7 Abs. 1 DSGVO).
CREATE TABLE IF NOT EXISTS leads (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  company      TEXT,
  email        TEXT NOT NULL,
  phone        TEXT,
  message      TEXT,
  consent_at   TEXT NOT NULL,
  consent_ip   TEXT,
  source       TEXT NOT NULL DEFAULT 'demo',
  tenant_id    TEXT,
  created_at   TEXT NOT NULL
);

-- GoBD-Audit-Trail: fortlaufende Hash-Kette pro Mandant. Manipulation einzelner
-- Einträge macht die Kette ab diesem Punkt ungültig (prüfbar via /api/gobd/verify).
CREATE TABLE IF NOT EXISTS audit_log (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id   TEXT NOT NULL,
  ts          TEXT NOT NULL,
  actor       TEXT NOT NULL,
  action      TEXT NOT NULL,
  detail_json TEXT NOT NULL DEFAULT '{}',
  prev_hash   TEXT NOT NULL,
  hash        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_tenant ON audit_log(tenant_id, seq);
`);

// ---------------------------------------------------------------------------
// Audit (GoBD)
// ---------------------------------------------------------------------------
const qLastAudit = db.prepare('SELECT hash FROM audit_log WHERE tenant_id = ? ORDER BY seq DESC LIMIT 1');
const qInsAudit = db.prepare('INSERT INTO audit_log (tenant_id, ts, actor, action, detail_json, prev_hash, hash) VALUES (?,?,?,?,?,?,?)');

function audit(tenantId, actor, action, detail) {
  const ts = nowIso();
  const detailJson = JSON.stringify(detail || {});
  const prev = qLastAudit.get(tenantId);
  const prevHash = prev ? prev.hash : 'GENESIS';
  const hash = sha256(prevHash + '|' + tenantId + '|' + ts + '|' + actor + '|' + action + '|' + detailJson);
  qInsAudit.run(tenantId, ts, actor, action, detailJson, prevHash, hash);
}

function auditList(tenantId, limit, offset) {
  return db.prepare('SELECT seq, ts, actor, action, detail_json, prev_hash, hash FROM audit_log WHERE tenant_id = ? ORDER BY seq ASC LIMIT ? OFFSET ?')
    .all(tenantId, limit || 1000, offset || 0);
}

function auditVerify(tenantId) {
  const rows = db.prepare('SELECT * FROM audit_log WHERE tenant_id = ? ORDER BY seq ASC').all(tenantId);
  let prevHash = 'GENESIS';
  for (const r of rows) {
    const expect = sha256(prevHash + '|' + r.tenant_id + '|' + r.ts + '|' + r.actor + '|' + r.action + '|' + r.detail_json);
    if (r.prev_hash !== prevHash || r.hash !== expect) {
      return { ok: false, brokenAtSeq: r.seq, entries: rows.length };
    }
    prevHash = r.hash;
  }
  return { ok: true, entries: rows.length };
}

// ---------------------------------------------------------------------------
// Tenants & Users
// ---------------------------------------------------------------------------
function createTenant({ name, trialEndsAt }) {
  const t = { id: id('t'), name, created_at: nowIso() };
  db.prepare('INSERT INTO tenants (id, name, plan, trial_ends_at, created_at) VALUES (?,?,?,?,?)')
    .run(t.id, name, 'TRIAL', trialEndsAt, t.created_at);
  return getTenant(t.id);
}
function getTenant(tid) { return db.prepare('SELECT * FROM tenants WHERE id = ?').get(tid) || null; }
function setTenantPlan(tid, plan) { db.prepare('UPDATE tenants SET plan = ? WHERE id = ?').run(plan, tid); }
function setTenantStatus(tid, status, deleteAfter) {
  db.prepare('UPDATE tenants SET status = ?, delete_after = ? WHERE id = ?').run(status, deleteAfter || null, tid);
}
function listTenants() {
  return db.prepare(`SELECT t.*, (SELECT COUNT(*) FROM users u WHERE u.tenant_id = t.id) AS user_count,
    (SELECT MAX(rev) FROM state_revisions s WHERE s.tenant_id = t.id) AS last_rev FROM tenants t ORDER BY t.created_at`).all();
}

function createUser({ tenantId, email, name, role, passHash }) {
  const u = { id: id('u'), created_at: nowIso() };
  db.prepare('INSERT INTO users (id, tenant_id, email, name, role, pass_hash, created_at) VALUES (?,?,?,?,?,?,?)')
    .run(u.id, tenantId, email || null, name, role, passHash || null, u.created_at);
  return getUser(u.id);
}
function getUser(uid) { return db.prepare('SELECT * FROM users WHERE id = ?').get(uid) || null; }
function getUserByEmail(email) { return db.prepare('SELECT * FROM users WHERE email = ?').get(email) || null; }
function touchLogin(uid) { db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(nowIso(), uid); }
function listUsers(tenantId) {
  return db.prepare('SELECT id, email, name, role, status, created_at, last_login_at FROM users WHERE tenant_id = ?').all(tenantId);
}

// ---------------------------------------------------------------------------
// Sessions (Refresh-Tokens)
// ---------------------------------------------------------------------------
function createSession({ userId, tenantId, refreshHash, expiresAt, ip, ua }) {
  const sid = id('s');
  db.prepare('INSERT INTO sessions (id, user_id, tenant_id, refresh_hash, created_at, expires_at, ip, ua) VALUES (?,?,?,?,?,?,?,?)')
    .run(sid, userId, tenantId, refreshHash, nowIso(), expiresAt, ip || null, ua || null);
  return sid;
}
function findSessionByRefresh(hash) {
  return db.prepare('SELECT * FROM sessions WHERE refresh_hash = ? AND revoked_at IS NULL').get(hash) || null;
}
function rotateSession(sid, newHash, expiresAt) {
  db.prepare('UPDATE sessions SET refresh_hash = ?, expires_at = ? WHERE id = ?').run(newHash, expiresAt, sid);
}
function revokeSession(sid) { db.prepare('UPDATE sessions SET revoked_at = ? WHERE id = ?').run(nowIso(), sid); }
function revokeUserSessions(uid) { db.prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(nowIso(), uid); }

// ---------------------------------------------------------------------------
// Magic-Links (Mitarbeiter-Zugang ohne Passwort)
// ---------------------------------------------------------------------------
function createMagicLink({ tenantId, createdBy, role, name, tokenHash, maxUses, expiresAt }) {
  const mid = id('ml');
  db.prepare('INSERT INTO magic_links (id, tenant_id, created_by, role, name, token_hash, max_uses, expires_at, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(mid, tenantId, createdBy, role, name || null, tokenHash, maxUses || 1, expiresAt, nowIso());
  return mid;
}
function findMagicLink(tokenHash) {
  return db.prepare('SELECT * FROM magic_links WHERE token_hash = ? AND revoked_at IS NULL').get(tokenHash) || null;
}
function useMagicLink(mid) { db.prepare('UPDATE magic_links SET uses = uses + 1 WHERE id = ?').run(mid); }
function listMagicLinks(tenantId) {
  return db.prepare('SELECT id, role, name, max_uses, uses, expires_at, revoked_at, created_at FROM magic_links WHERE tenant_id = ?').all(tenantId);
}
function revokeMagicLink(tenantId, mid) {
  db.prepare('UPDATE magic_links SET revoked_at = ? WHERE id = ? AND tenant_id = ?').run(nowIso(), mid, tenantId);
}

// Modul-Overrides des Betreibers (Host): { modulKey: true|false } in settings_json.
// true = zusätzlich freigeschaltet, false = trotz Tarif gesperrt.
function getTenantSettings(tid) {
  const t = getTenant(tid);
  try { return t ? JSON.parse(t.settings_json || '{}') : {}; } catch (_e) { return {}; }
}
function setTenantModuleOverrides(tid, overrides) {
  const s = getTenantSettings(tid);
  s.moduleOverrides = overrides || {};
  db.prepare('UPDATE tenants SET settings_json = ? WHERE id = ?').run(JSON.stringify(s), tid);
}

// ---------------------------------------------------------------------------
// Abonnements
// ---------------------------------------------------------------------------
function createSubscription({ tenantId, plan, priceEur, billing, source, createdBy }) {
  // Nur EIN aktives Abo pro Mandant: vorheriges als abgelöst markieren
  db.prepare("UPDATE subscriptions SET status = 'cancelled', cancelled_at = ? WHERE tenant_id = ? AND status = 'active'")
    .run(nowIso(), tenantId);
  const sid = id('sub');
  db.prepare(`INSERT INTO subscriptions (id, tenant_id, plan, price_eur, billing_json, source, created_at, created_by)
    VALUES (?,?,?,?,?,?,?,?)`)
    .run(sid, tenantId, plan, priceEur, JSON.stringify(billing || {}), source || 'website', nowIso(), createdBy || null);
  return sid;
}
function getActiveSubscription(tenantId) {
  return db.prepare("SELECT * FROM subscriptions WHERE tenant_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1").get(tenantId) || null;
}
function cancelSubscription(tenantId) {
  db.prepare("UPDATE subscriptions SET status = 'cancelled', cancelled_at = ? WHERE tenant_id = ? AND status = 'active'")
    .run(nowIso(), tenantId);
}
function platformStats() {
  const t = db.prepare("SELECT COUNT(*) AS n FROM tenants WHERE status != 'deleted'").get().n;
  const trials = db.prepare("SELECT COUNT(*) AS n FROM tenants WHERE plan = 'TRIAL' AND status != 'deleted'").get().n;
  const paying = db.prepare(`SELECT COUNT(DISTINCT tenant_id) AS n FROM subscriptions s
    JOIN tenants tn ON tn.id = s.tenant_id WHERE s.status = 'active' AND tn.status != 'deleted'`).get().n;
  const mrr = db.prepare(`SELECT COALESCE(SUM(s.price_eur),0) AS m FROM subscriptions s
    JOIN tenants tn ON tn.id = s.tenant_id WHERE s.status = 'active' AND tn.status != 'deleted'`).get().m;
  const leads = db.prepare('SELECT COUNT(*) AS n FROM leads').get().n;
  const offersOpen = db.prepare("SELECT COUNT(*) AS n FROM sales_offers WHERE status = 'open'").get().n;
  return { tenants: t, trials, paying, mrrEur: mrr, leads, salesOffersOpen: offersOpen };
}

// ---------------------------------------------------------------------------
// Vertriebs-Angebote (Betreiber → Interessent)
// ---------------------------------------------------------------------------
function createSalesOffer({ tokenHash, company, contactName, email, phone, plan, priceEur, message, validUntil }) {
  const oid = id('so');
  db.prepare(`INSERT INTO sales_offers (id, token_hash, company, contact_name, email, phone, plan, price_eur, message, valid_until, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(oid, tokenHash, company, contactName || null, email, phone || null, plan, priceEur, message || null, validUntil, nowIso());
  return oid;
}
function findSalesOfferByToken(tokenHash) {
  return db.prepare('SELECT * FROM sales_offers WHERE token_hash = ?').get(tokenHash) || null;
}
function listSalesOffers() {
  return db.prepare('SELECT * FROM sales_offers ORDER BY created_at DESC LIMIT 500').all();
}
function acceptSalesOffer(oid, tenantId) {
  db.prepare("UPDATE sales_offers SET status = 'accepted', accepted_at = ?, tenant_id = ? WHERE id = ? AND status = 'open'")
    .run(nowIso(), tenantId, oid);
}
function revokeSalesOffer(oid) {
  db.prepare("UPDATE sales_offers SET status = 'revoked' WHERE id = ? AND status = 'open'").run(oid);
}

// ---------------------------------------------------------------------------
// Leads (Demo-Anfragen von der Website)
// ---------------------------------------------------------------------------
function createLead({ name, company, email, phone, message, consentIp, source, tenantId }) {
  const lid = id('ld');
  db.prepare(`INSERT INTO leads (id, name, company, email, phone, message, consent_at, consent_ip, source, tenant_id, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(lid, name, company || null, email, phone || null, message || null, nowIso(), consentIp || null, source || 'demo', tenantId || null, nowIso());
  return lid;
}
function listLeads() {
  return db.prepare('SELECT * FROM leads ORDER BY created_at DESC LIMIT 1000').all();
}
function deleteLead(lid) { db.prepare('DELETE FROM leads WHERE id = ?').run(lid); }

// ---------------------------------------------------------------------------
// Angebots-Links
// ---------------------------------------------------------------------------
function createOfferLink({ tenantId, createdBy, tokenHash, angebotId, number, payloadJson, expiresAt }) {
  const oid = id('ol');
  db.prepare(`INSERT INTO offer_links (id, tenant_id, token_hash, angebot_id, number, payload_json, created_at, created_by, expires_at)
    VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(oid, tenantId, tokenHash, angebotId || null, number || null, payloadJson, nowIso(), createdBy, expiresAt);
  return oid;
}
function findOfferLinkByToken(tokenHash) {
  return db.prepare('SELECT * FROM offer_links WHERE token_hash = ?').get(tokenHash) || null;
}
function getOfferLink(tenantId, oid) {
  return db.prepare('SELECT * FROM offer_links WHERE tenant_id = ? AND id = ?').get(tenantId, oid) || null;
}
function listOfferLinks(tenantId) {
  return db.prepare(`SELECT id, angebot_id, number, status, created_at, expires_at, opened_at,
    responded_at, responder_name, responder_comment,
    (signature_png IS NOT NULL) AS has_signature
    FROM offer_links WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 500`).all(tenantId);
}
function markOfferOpened(oid) {
  db.prepare('UPDATE offer_links SET opened_at = COALESCE(opened_at, ?) WHERE id = ?').run(nowIso(), oid);
}
function respondOfferLink(oid, { status, name, comment, ip, signature }) {
  db.prepare(`UPDATE offer_links SET status = ?, responded_at = ?, responder_name = ?,
    responder_comment = ?, responder_ip = ?, signature_png = ? WHERE id = ? AND status = 'open'`)
    .run(status, nowIso(), name || null, comment || null, ip || null, signature || null, oid);
}
function revokeOfferLink(tenantId, oid) {
  db.prepare("UPDATE offer_links SET status = 'revoked' WHERE tenant_id = ? AND id = ? AND status = 'open'").run(tenantId, oid);
}

// ---------------------------------------------------------------------------
// State-Revisionen (GoBD-unveränderlich)
// ---------------------------------------------------------------------------
const qLastRev = db.prepare('SELECT rev, sha256 FROM state_revisions WHERE tenant_id = ? ORDER BY rev DESC LIMIT 1');

function saveStateRevision(tenantId, userId, jsonBuf) {
  const hash = sha256(jsonBuf);
  const last = qLastRev.get(tenantId);
  if (last && last.sha256 === hash) return { rev: last.rev, unchanged: true };
  const rev = (last ? last.rev : 0) + 1;
  db.prepare('INSERT INTO state_revisions (tenant_id, rev, sha256, size, created_at, created_by, data_gz) VALUES (?,?,?,?,?,?,?)')
    .run(tenantId, rev, hash, jsonBuf.length, nowIso(), userId, zlib.gzipSync(jsonBuf));
  return { rev, unchanged: false };
}

function loadState(tenantId, rev) {
  const row = rev
    ? db.prepare('SELECT * FROM state_revisions WHERE tenant_id = ? AND rev = ?').get(tenantId, rev)
    : db.prepare('SELECT * FROM state_revisions WHERE tenant_id = ? ORDER BY rev DESC LIMIT 1').get(tenantId);
  if (!row) return null;
  return { rev: row.rev, sha256: row.sha256, created_at: row.created_at, json: zlib.gunzipSync(row.data_gz) };
}

function listRevisions(tenantId, limit) {
  return db.prepare('SELECT rev, sha256, size, created_at, created_by FROM state_revisions WHERE tenant_id = ? ORDER BY rev DESC LIMIT ?')
    .all(tenantId, limit || 100);
}

// ---------------------------------------------------------------------------
// Dateien (versioniert)
// ---------------------------------------------------------------------------
function putFile(tenantId, userId, filePath, contentType, data) {
  const last = db.prepare('SELECT version FROM files WHERE tenant_id = ? AND path = ? ORDER BY version DESC LIMIT 1').get(tenantId, filePath);
  const version = (last ? last.version : 0) + 1;
  const fid = id('f');
  db.prepare('INSERT INTO files (id, tenant_id, path, version, size, sha256, content_type, created_at, created_by, data) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(fid, tenantId, filePath, version, data.length, sha256(data), contentType || 'application/octet-stream', nowIso(), userId, data);
  return { id: fid, version };
}

function getFile(tenantId, filePath, version) {
  return version
    ? db.prepare('SELECT * FROM files WHERE tenant_id = ? AND path = ? AND version = ?').get(tenantId, filePath, version) || null
    : db.prepare('SELECT * FROM files WHERE tenant_id = ? AND path = ? ORDER BY version DESC LIMIT 1').get(tenantId, filePath) || null;
}

function listFiles(tenantId) {
  return db.prepare(`SELECT path, MAX(version) AS version, COUNT(*) AS versions, SUM(size) AS total_size,
    MAX(created_at) AS updated_at FROM files WHERE tenant_id = ? GROUP BY path ORDER BY path`).all(tenantId);
}

function tenantStorageBytes(tenantId) {
  const f = db.prepare('SELECT COALESCE(SUM(size),0) AS s FROM files WHERE tenant_id = ?').get(tenantId).s;
  const st = db.prepare('SELECT COALESCE(SUM(size),0) AS s FROM state_revisions WHERE tenant_id = ?').get(tenantId).s;
  return f + st;
}

// ---------------------------------------------------------------------------
// DSGVO: endgültige Löschung eines Mandanten (nach Karenzfrist)
// ---------------------------------------------------------------------------
function purgeTenant(tenantId) {
  const tx = db.prepare.bind(db);
  db.exec('BEGIN');
  try {
    tx('DELETE FROM leads WHERE tenant_id = ?').run(tenantId); // DSGVO: Lead-Daten mitlöschen
    tx('DELETE FROM subscriptions WHERE tenant_id = ?').run(tenantId);
    tx("UPDATE sales_offers SET company = '[gelöscht]', contact_name = NULL, email = '[gelöscht]', phone = NULL WHERE tenant_id = ?").run(tenantId);
    tx('DELETE FROM offer_links WHERE tenant_id = ?').run(tenantId);
    tx('DELETE FROM files WHERE tenant_id = ?').run(tenantId);
    tx('DELETE FROM state_revisions WHERE tenant_id = ?').run(tenantId);
    tx('DELETE FROM sessions WHERE tenant_id = ?').run(tenantId);
    tx('DELETE FROM magic_links WHERE tenant_id = ?').run(tenantId);
    tx('DELETE FROM users WHERE tenant_id = ?').run(tenantId);
    // Mandant bleibt als Lösch-Tombstone erhalten (Nachweis der Löschung),
    // personenbeziehbare Felder werden entfernt.
    tx("UPDATE tenants SET name = '[gelöscht]', status = 'deleted', settings_json = '{}' WHERE id = ?").run(tenantId);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

function purgeDueTenants() {
  const due = db.prepare("SELECT id FROM tenants WHERE status = 'deletion_pending' AND delete_after <= ?").all(nowIso());
  for (const t of due) { purgeTenant(t.id); audit(t.id, 'system', 'tenant.purged', {}); }
  return due.length;
}

module.exports = {
  db, audit, auditList, auditVerify,
  createTenant, getTenant, setTenantPlan, setTenantStatus, listTenants,
  getTenantSettings, setTenantModuleOverrides,
  createLead, listLeads, deleteLead,
  createSubscription, getActiveSubscription, cancelSubscription, platformStats,
  createSalesOffer, findSalesOfferByToken, listSalesOffers, acceptSalesOffer, revokeSalesOffer,
  createOfferLink, findOfferLinkByToken, getOfferLink, listOfferLinks,
  markOfferOpened, respondOfferLink, revokeOfferLink,
  createUser, getUser, getUserByEmail, touchLogin, listUsers,
  createSession, findSessionByRefresh, rotateSession, revokeSession, revokeUserSessions,
  createMagicLink, findMagicLink, useMagicLink, listMagicLinks, revokeMagicLink,
  saveStateRevision, loadState, listRevisions,
  putFile, getFile, listFiles, tenantStorageBytes,
  purgeTenant, purgeDueTenants,
};
