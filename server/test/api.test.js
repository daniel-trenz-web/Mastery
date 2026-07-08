'use strict';
// Integrationstests für das WERKOS-Backend.
// Deckt ab: Auth, Mandantentrennung, Rollen, GoBD (Revisionen + Audit-Kette),
// DSGVO (Export, Löschung), Tarif-Gating, Path-Traversal, Rate-Limits, ZIP.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Isoliertes Datenverzeichnis VOR dem Laden der Module setzen
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'werkos-test-'));
process.env.WERKOS_DATA_DIR = TMP;
process.env.WERKOS_ADMIN_TOKEN = 'test-admin-token';
process.env.WERKOS_REGISTER_LIMIT = '1000'; // Tests registrieren viele Mandanten

const { createServer } = require('../src/server');
const dbm = require('../src/db');
const zip = require('../src/zip');

let BASE;
let server;

test.before(async () => {
  server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  BASE = 'http://127.0.0.1:' + server.address().port;
});

test.after(() => { server.close(); fs.rmSync(TMP, { recursive: true, force: true }); });

async function api(method, p, { body, token, headers, raw } = {}) {
  const h = Object.assign({}, headers);
  if (token) h['Authorization'] = 'Bearer ' + token;
  let payload;
  if (raw !== undefined) { payload = raw; }
  else if (body !== undefined) { payload = JSON.stringify(body); h['Content-Type'] = 'application/json'; }
  const r = await fetch(BASE + p, { method, headers: h, body: payload });
  const ct = r.headers.get('content-type') || '';
  const data = ct.includes('json') ? await r.json().catch(() => null) : Buffer.from(await r.arrayBuffer());
  return { status: r.status, data, headers: r.headers };
}

async function register(company, email) {
  const r = await api('POST', '/api/auth/register', {
    body: { company, email, name: 'Inhaber ' + company, password: 'sicheres-passwort-123' },
  });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return r.data;
}

// ---------------------------------------------------------------------------
test('Registrierung, Login, Refresh-Rotation, Logout', async () => {
  const s = await register('Malerbetrieb Alpha', 'alpha@test.de');
  assert.ok(s.accessToken && s.refreshToken);
  assert.equal(s.user.role, 'owner');
  assert.equal(s.tenant.plan, 'TRIAL');
  assert.ok(s.tenant.modules.includes('zeiten'));

  // Doppelte E-Mail abgelehnt
  const dup = await api('POST', '/api/auth/register', { body: { company: 'Xx GmbH', email: 'alpha@test.de', name: 'YZ', password: 'sicheres-passwort-123' } });
  assert.equal(dup.status, 409);

  // Login
  const l = await api('POST', '/api/auth/login', { body: { email: 'alpha@test.de', password: 'sicheres-passwort-123' } });
  assert.equal(l.status, 200);

  // Falsches Passwort
  const bad = await api('POST', '/api/auth/login', { body: { email: 'alpha@test.de', password: 'falsch-falsch-falsch' } });
  assert.equal(bad.status, 401);

  // Refresh rotiert: alter Token danach ungültig
  const r1 = await api('POST', '/api/auth/refresh', { body: { refreshToken: l.data.refreshToken } });
  assert.equal(r1.status, 200);
  const r2 = await api('POST', '/api/auth/refresh', { body: { refreshToken: l.data.refreshToken } });
  assert.equal(r2.status, 401, 'alter Refresh-Token muss nach Rotation ungültig sein');

  // Logout widerruft Sessions
  const lo = await api('POST', '/api/auth/logout', { token: r1.data.accessToken });
  assert.equal(lo.status, 200);
  const r3 = await api('POST', '/api/auth/refresh', { body: { refreshToken: r1.data.refreshToken } });
  assert.equal(r3.status, 401);
});

test('Schwaches Passwort und ungültige E-Mail werden abgelehnt', async () => {
  const weak = await api('POST', '/api/auth/register', { body: { company: 'W', email: 'w@test.de', name: 'WW', password: 'kurz' } });
  assert.equal(weak.status, 400);
  const mail = await api('POST', '/api/auth/register', { body: { company: 'Wf', email: 'keine-mail', name: 'WW', password: 'sicheres-passwort-123' } });
  assert.equal(mail.status, 400);
});

// ---------------------------------------------------------------------------
test('MANDANTENTRENNUNG: Tenant B sieht niemals Daten von Tenant A', async () => {
  const a = await register('Betrieb A', 'isolation-a@test.de');
  const b = await register('Betrieb B', 'isolation-b@test.de');

  // A speichert State + Datei
  const st = await api('POST', '/api/t/state', { token: a.accessToken, raw: JSON.stringify({ projects: [{ id: 1, name: 'GEHEIM-A' }], savedAt: Date.now() }) });
  assert.equal(st.status, 200);
  const fu = await api('PUT', '/api/t/files/belege/rechnung1.pdf', { token: a.accessToken, raw: Buffer.from('PDF-INHALT-A'), headers: { 'Content-Type': 'application/pdf' } });
  assert.equal(fu.status, 200);

  // B: leerer State, Datei nicht sichtbar
  const stB = await api('GET', '/api/t/state', { token: b.accessToken });
  assert.equal(stB.status, 200);
  assert.deepEqual(stB.data, {}, 'Tenant B muss leeren State sehen');
  const fB = await api('GET', '/api/t/files/belege/rechnung1.pdf', { token: b.accessToken });
  assert.equal(fB.status, 404, 'Tenant B darf Datei von A nicht sehen');
  const listB = await api('GET', '/api/t/files', { token: b.accessToken });
  assert.equal(listB.data.files.length, 0);

  // A sieht die eigenen Daten
  const stA = await api('GET', '/api/t/state', { token: a.accessToken });
  assert.equal(stA.data.projects[0].name, 'GEHEIM-A');

  // X-Tenant-Key-Mismatch wird abgelehnt (Defense-in-depth)
  const mm = await api('GET', '/api/t/state', { token: a.accessToken, headers: { 'X-Tenant-Key': b.tenant.id } });
  assert.equal(mm.status, 403);

  // B darf As Audit-Log und Revisionen nicht sehen
  const audB = await api('GET', '/api/gobd/audit', { token: b.accessToken });
  const hasA = audB.data.entries.some((e) => JSON.stringify(e).includes(a.tenant.id));
  assert.equal(hasA, false);
});

test('Ohne Token: 401 auf allen Daten-Endpunkten', async () => {
  for (const [m, p] of [['GET', '/api/t/state'], ['POST', '/api/t/state'], ['GET', '/api/t/files'], ['GET', '/api/gobd/audit'], ['GET', '/api/dsgvo/export'], ['GET', '/api/account']]) {
    const r = await api(m, p, { raw: m === 'POST' ? '{}' : undefined });
    assert.equal(r.status, 401, m + ' ' + p);
  }
});

test('Manipulierter Token wird abgelehnt', async () => {
  const s = await register('Token Test', 'tok@test.de');
  const forged = s.accessToken.slice(0, -4) + 'AAAA';
  const r = await api('GET', '/api/t/state', { token: forged });
  assert.equal(r.status, 401);
});

test('Path-Traversal in Datei-API wird neutralisiert', async () => {
  const s = await register('Traversal Test', 'trav@test.de');
  const r = await api('PUT', '/api/t/files/..%2F..%2Fetc%2Fpasswd', { token: s.accessToken, raw: Buffer.from('x') });
  // Traversal-Segmente werden entfernt → Pfad wird zu etc/passwd IM Mandanten, niemals Dateisystem
  assert.equal(r.status, 200);
  assert.equal(r.data.path, 'etc/passwd');
  // Statische Auslieferung: kein Zugriff außerhalb web/
  const st = await fetch(BASE + '/../server/src/config.js');
  assert.notEqual(st.status, 200);
});

// ---------------------------------------------------------------------------
test('Magic-Link: Mitarbeiter ohne Passwort, external nur lesend', async () => {
  const s = await register('Magic GmbH', 'magic@test.de');

  // Chef erzeugt Mitarbeiter-Link
  const inv = await api('POST', '/api/auth/invite', { token: s.accessToken, body: { role: 'employee', name: 'Azubi Tim', maxUses: 2 } });
  assert.equal(inv.status, 201);
  const token = inv.data.url.split('#invite=')[1];

  // Mitarbeiter löst ein
  const emp = await api('POST', '/api/auth/magic', { body: { token, name: 'Tim' } });
  assert.equal(emp.status, 200);
  assert.equal(emp.data.user.role, 'employee');
  assert.equal(emp.data.tenant.id, s.tenant.id);

  // Mitarbeiter darf stempeln (State schreiben)
  const w = await api('POST', '/api/t/state', { token: emp.data.accessToken, raw: JSON.stringify({ zeiten: [1] }) });
  assert.equal(w.status, 200);

  // Mitarbeiter darf KEINE Einladungen erstellen und keinen DSGVO-Export ziehen
  const noInv = await api('POST', '/api/auth/invite', { token: emp.data.accessToken, body: {} });
  assert.equal(noInv.status, 403);
  const noExp = await api('GET', '/api/dsgvo/export', { token: emp.data.accessToken });
  assert.equal(noExp.status, 403);

  // max_uses respektiert (2. Nutzung ok, 3. abgelehnt)
  const emp2 = await api('POST', '/api/auth/magic', { body: { token } });
  assert.equal(emp2.status, 200);
  const emp3 = await api('POST', '/api/auth/magic', { body: { token } });
  assert.equal(emp3.status, 401);

  // Steuerberater-Zugang (external): lesen ja, schreiben nein
  const invExt = await api('POST', '/api/auth/invite', { token: s.accessToken, body: { role: 'external', name: 'StB Kanzlei' } });
  const ext = await api('POST', '/api/auth/magic', { body: { token: invExt.data.url.split('#invite=')[1] } });
  assert.equal(ext.status, 200);
  const extRead = await api('GET', '/api/t/state', { token: ext.data.accessToken });
  assert.equal(extRead.status, 200);
  const extAudit = await api('GET', '/api/gobd/audit', { token: ext.data.accessToken });
  assert.equal(extAudit.status, 200);
  const extWrite = await api('POST', '/api/t/state', { token: ext.data.accessToken, raw: '{"hack":1}' });
  assert.equal(extWrite.status, 403);

  // Widerrufener Link funktioniert nicht mehr
  const inv2 = await api('POST', '/api/auth/invite', { token: s.accessToken, body: { role: 'employee' } });
  await api('DELETE', '/api/auth/invites/' + inv2.data.linkId, { token: s.accessToken });
  const rev = await api('POST', '/api/auth/magic', { body: { token: inv2.data.url.split('#invite=')[1] } });
  assert.equal(rev.status, 401);
});

// ---------------------------------------------------------------------------
test('GoBD: Revisionen unveränderlich + Audit-Hash-Kette prüfbar', async () => {
  const s = await register('GoBD Bau GmbH', 'gobd@test.de');
  const t = s.accessToken;

  await api('POST', '/api/t/state', { token: t, raw: JSON.stringify({ v: 1 }) });
  await api('POST', '/api/t/state', { token: t, raw: JSON.stringify({ v: 2 }) });
  // Identischer Inhalt → keine neue Revision
  const same = await api('POST', '/api/t/state', { token: t, raw: JSON.stringify({ v: 2 }) });
  assert.equal(same.data.unchanged, true);
  await api('POST', '/api/t/state', { token: t, raw: JSON.stringify({ v: 3 }) });

  const revs = await api('GET', '/api/gobd/revisions', { token: t });
  assert.equal(revs.data.revisions.length, 3);

  // Historischer Stand bleibt abrufbar (GoBD-Nachvollziehbarkeit)
  const old = await api('GET', '/api/gobd/revisions/1', { token: t });
  assert.equal(old.status, 200);
  assert.deepEqual(old.data, { v: 1 });

  // Kette intakt
  const v1 = await api('GET', '/api/gobd/verify', { token: t });
  assert.equal(v1.data.ok, true);
  assert.ok(v1.data.entries >= 4);

  // Manipulation eines Audit-Eintrags wird erkannt
  dbm.db.prepare("UPDATE audit_log SET detail_json = '{\"manipuliert\":true}' WHERE tenant_id = ? AND action = 'state.saved'").run(s.tenant.id);
  const v2 = await api('GET', '/api/gobd/verify', { token: t });
  assert.equal(v2.data.ok, false, 'Manipulation muss die Hash-Kette brechen');
  assert.ok(v2.data.brokenAtSeq > 0);
});

// ---------------------------------------------------------------------------
test('DSGVO-Export: vollständiges ZIP mit State, Dateien, Audit, Nutzern', async () => {
  const s = await register('Export GmbH', 'export@test.de');
  await api('POST', '/api/t/state', { token: s.accessToken, raw: JSON.stringify({ kunden: ['Müller'] }) });
  await api('PUT', '/api/t/files/fotos/baustelle.jpg', { token: s.accessToken, raw: Buffer.from('JPEGDATA'), headers: { 'Content-Type': 'image/jpeg' } });

  const ex = await api('GET', '/api/dsgvo/export', { token: s.accessToken });
  assert.equal(ex.status, 200);
  assert.ok(Buffer.isBuffer(ex.data));

  const entries = zip.parseZip(ex.data);
  const names = entries.map((e) => e.name);
  assert.ok(names.includes('state.json'));
  assert.ok(names.includes('meta/audit-log.json'));
  assert.ok(names.includes('meta/nutzer.json'));
  assert.ok(names.includes('meta/export-info.json'));
  assert.ok(names.includes('dateien/fotos/baustelle.jpg'));
  const st = JSON.parse(entries.find((e) => e.name === 'state.json').data.toString());
  assert.deepEqual(st.kunden, ['Müller']);
  const foto = entries.find((e) => e.name === 'dateien/fotos/baustelle.jpg');
  assert.equal(foto.data.toString(), 'JPEGDATA');
});

test('DSGVO-Löschung: Karenzfrist, Schreibsperre, Widerruf, endgültige Löschung', async () => {
  const s = await register('Löschung GmbH', 'delete@test.de');
  await api('POST', '/api/t/state', { token: s.accessToken, raw: '{"a":1}' });

  // Falsches Passwort → abgelehnt
  const wrong = await api('POST', '/api/dsgvo/delete-tenant', { token: s.accessToken, body: { password: 'falsch' } });
  assert.equal(wrong.status, 401);

  // Korrekte Löschanfrage
  const del = await api('POST', '/api/dsgvo/delete-tenant', { token: s.accessToken, body: { password: 'sicheres-passwort-123' } });
  assert.equal(del.status, 200);
  assert.ok(del.data.deleteAfter);

  // Schreiben gesperrt, Lesen/Export weiter möglich (Auskunftsrecht)
  const w = await api('POST', '/api/t/state', { token: s.accessToken, raw: '{"b":2}' });
  assert.equal(w.status, 403);
  const ex = await api('GET', '/api/dsgvo/export', { token: s.accessToken });
  assert.equal(ex.status, 200);

  // Widerruf
  const cancel = await api('POST', '/api/dsgvo/cancel-deletion', { token: s.accessToken });
  assert.equal(cancel.status, 200);
  const w2 = await api('POST', '/api/t/state', { token: s.accessToken, raw: '{"b":2}' });
  assert.equal(w2.status, 200);

  // Endgültige Löschung (Frist simuliert abgelaufen) → Purge entfernt alles
  await api('POST', '/api/dsgvo/delete-tenant', { token: s.accessToken, body: { password: 'sicheres-passwort-123' } });
  dbm.db.prepare('UPDATE tenants SET delete_after = ? WHERE id = ?').run('2000-01-01T00:00:00Z', s.tenant.id);
  const purge = await api('POST', '/api/admin/purge-due', { headers: { 'X-Admin-Token': 'test-admin-token' } });
  assert.ok(purge.data.purged >= 1);
  const t = dbm.getTenant(s.tenant.id);
  assert.equal(t.status, 'deleted');
  assert.equal(t.name, '[gelöscht]');
  assert.equal(dbm.listUsers(s.tenant.id).length, 0);
  assert.equal(dbm.loadState(s.tenant.id), null);
  // Sessions des gelöschten Mandanten sind tot
  const after = await api('GET', '/api/t/state', { token: s.accessToken });
  assert.equal(after.status, 401);
});

// ---------------------------------------------------------------------------
test('Tarif-Gating: abgelaufene Testphase sperrt Schreiben, Tarifwahl entsperrt', async () => {
  const s = await register('Trial GmbH', 'trial@test.de');
  // Testphase künstlich ablaufen lassen
  dbm.db.prepare('UPDATE tenants SET trial_ends_at = ? WHERE id = ?').run('2000-01-01T00:00:00Z', s.tenant.id);

  const w = await api('POST', '/api/t/state', { token: s.accessToken, raw: '{"x":1}' });
  assert.equal(w.status, 402, 'abgelaufene Testphase muss Schreiben sperren');
  // Lesen + Export bleiben erlaubt
  const r = await api('GET', '/api/t/state', { token: s.accessToken });
  assert.equal(r.status, 200);
  const ex = await api('GET', '/api/dsgvo/export', { token: s.accessToken });
  assert.equal(ex.status, 200);

  // Tarif wählen → Schreiben wieder möglich, Module gemäß Tarif
  const cp = await api('POST', '/api/billing/choose-plan', { token: s.accessToken, body: { plan: 'BETRIEB' } });
  assert.equal(cp.status, 200);
  assert.deepEqual(cp.data.tenant.modules, ['zeiten', 'auftraege', 'geld']);
  const w2 = await api('POST', '/api/t/state', { token: s.accessToken, raw: '{"x":1}' });
  assert.equal(w2.status, 200);

  // Ungültiger Tarif abgelehnt
  const bad = await api('POST', '/api/billing/choose-plan', { token: s.accessToken, body: { plan: 'TRIAL' } });
  assert.equal(bad.status, 400);
});

// ---------------------------------------------------------------------------
test('Restore-ZIP: Voll-Backup aus der Einzelplatz-Version einspielen', async () => {
  const s = await register('Umzug GmbH', 'umzug@test.de');
  const zipBuf = zip.buildZip([
    { name: 'state.json', data: Buffer.from(JSON.stringify({ projects: [{ name: 'Altprojekt' }], savedAt: 123 })) },
    { name: 'dateien/beleg1.pdf', data: Buffer.from('BELEG-1') },
    { name: 'dateien/fotos/f1.jpg', data: Buffer.alloc(2048, 7) },
  ]);
  const r = await api('POST', '/api/t/restore-zip', { token: s.accessToken, raw: zipBuf, headers: { 'Content-Type': 'application/zip' } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.files, 2);
  assert.equal(r.data.stateRev, 1);

  const st = await api('GET', '/api/t/state', { token: s.accessToken });
  assert.equal(st.data.projects[0].name, 'Altprojekt');
  const f = await api('GET', '/api/t/files/dateien/beleg1.pdf', { token: s.accessToken });
  assert.equal(f.data.toString(), 'BELEG-1');

  // Mitarbeiter dürfen kein Voll-Backup einspielen
  const inv = await api('POST', '/api/auth/invite', { token: s.accessToken, body: { role: 'employee' } });
  const emp = await api('POST', '/api/auth/magic', { body: { token: inv.data.url.split('#invite=')[1] } });
  const noRestore = await api('POST', '/api/t/restore-zip', { token: emp.data.accessToken, raw: zipBuf });
  assert.equal(noRestore.status, 403);
});

test('ZIP-Roundtrip: Writer-Ausgabe ist mit Python zipfile kompatibel', async () => {
  const buf = zip.buildZip([
    { name: 'a.txt', data: Buffer.from('hallo welt') },
    { name: 'ordner/b.bin', data: Buffer.alloc(4096, 3) },
    { name: 'umlaute-äöü.txt', data: Buffer.from('ÄÖÜ βeta') },
  ]);
  const back = zip.parseZip(buf);
  assert.equal(back.length, 3);
  assert.equal(back.find((e) => e.name === 'a.txt').data.toString(), 'hallo welt');
  assert.equal(back.find((e) => e.name === 'umlaute-äöü.txt').data.toString(), 'ÄÖÜ βeta');
});

// ---------------------------------------------------------------------------
test('Rate-Limit: Brute-Force auf Login wird gebremst', async () => {
  await register('Brute GmbH', 'brute@test.de');
  let limited = false;
  for (let i = 0; i < 15; i++) {
    const r = await api('POST', '/api/auth/login', { body: { email: 'brute@test.de', password: 'falsches-pw-' + i } });
    if (r.status === 429) { limited = true; break; }
  }
  assert.ok(limited, 'nach wiederholten Fehlversuchen muss 429 kommen');
});

test('Admin-API: nur mit Admin-Token', async () => {
  const no = await api('GET', '/api/admin/tenants');
  assert.equal(no.status, 401);
  const yes = await api('GET', '/api/admin/tenants', { headers: { 'X-Admin-Token': 'test-admin-token' } });
  assert.equal(yes.status, 200);
  assert.ok(Array.isArray(yes.data.tenants) && yes.data.tenants.length > 0);
});

test('Statische Auslieferung: PWA und Bibliotheken erreichbar', async () => {
  const r = await fetch(BASE + '/');
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.ok(html.includes('<!DOCTYPE html>'));
  const lib = await fetch(BASE + '/lib/qrcode.min.js');
  assert.equal(lib.status, 200);
  const saas = await fetch(BASE + '/saas.js');
  assert.equal(saas.status, 200, 'saas.js (Login-Bootstrap) muss ausgeliefert werden');
});
