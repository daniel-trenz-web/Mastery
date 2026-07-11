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
process.env.WERKOS_LOGIN_IP_LIMIT = '1000'; // Pro-E-Mail-Limit bleibt aktiv (Brute-Force-Test)

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

// Kaufabschluss-Helfer: Tarif mit Rechnungsdaten + AGB-Zustimmung aktivieren
async function checkout(token, plan) {
  const r = await api('POST', '/api/billing/checkout', {
    token,
    body: {
      plan, acceptTerms: true,
      billing: { company: 'Test GmbH', address: 'Teststr. 1', zip: '12345', city: 'Berlin', email: 'billing@test.de', payMethod: 'invoice' },
    },
  });
  assert.equal(r.status, 201, 'checkout ' + plan + ': ' + JSON.stringify(r.data));
  return r;
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
  const cp = await checkout(s.accessToken, 'BETRIEB');
  assert.deepEqual(cp.data.tenant.modules, ['zeiten', 'auftraege', 'geld']);
  const w2 = await api('POST', '/api/t/state', { token: s.accessToken, raw: '{"x":1}' });
  assert.equal(w2.status, 200);

  // Ungültiger Tarif abgelehnt
  const bad = await api('POST', '/api/billing/checkout', { token: s.accessToken, body: { plan: 'TRIAL', acceptTerms: true } });
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

// ---------------------------------------------------------------------------
test('Module: Tarif schaltet automatisch frei, Host-Override gewinnt', async () => {
  const s = await register('Module GmbH', 'module@test.de');

  // Testphase: alle 5 Module
  let acc = await api('GET', '/api/account', { token: s.accessToken });
  assert.deepEqual(acc.data.tenant.modules.sort(), ['auftraege', 'einkauf', 'geld', 'planung', 'zeiten']);
  assert.ok(acc.data.tenant.moduleCatalog.zeiten.appModules.includes('employees'));

  // START: nur zeiten (automatisch mit Tarifwahl)
  await checkout(s.accessToken, 'START');
  acc = await api('GET', '/api/account', { token: s.accessToken });
  assert.deepEqual(acc.data.tenant.modules, ['zeiten']);

  // Host schaltet zusätzlich "geld" frei, sperrt "zeiten" (Tri-State: true→on, false→off normalisiert)
  const ov = await api('POST', '/api/admin/tenants/' + s.tenant.id + '/modules', {
    headers: { 'X-Admin-Token': 'test-admin-token' },
    body: { overrides: { geld: true, zeiten: false, quatsch: true } },
  });
  assert.equal(ov.status, 200);
  assert.deepEqual(ov.data.effective_modules, ['geld'], 'Override: +geld, -zeiten, unbekannte Keys ignoriert');
  // module_states: geld nutzbar, zeiten ausgeblendet, restliche gesperrt (Standard)
  assert.equal(ov.data.module_states.geld, 'on');
  assert.equal(ov.data.module_states.zeiten, 'off');
  assert.equal(ov.data.module_states.auftraege, 'locked', 'nicht im Tarif, kein Override → sichtbar-gesperrt');

  // Account liefert moduleStates für die App
  acc = await api('GET', '/api/account', { token: s.accessToken });
  assert.equal(acc.data.tenant.moduleStates.geld, 'on');
  assert.equal(acc.data.tenant.moduleStates.zeiten, 'off');

  // Tri-State per {module,state}: zeiten von 'off' auf 'locked' (sichtbar, aber gesperrt)
  const lock = await api('POST', '/api/admin/tenants/' + s.tenant.id + '/modules', {
    headers: { 'X-Admin-Token': 'test-admin-token' },
    body: { module: 'zeiten', state: 'locked' },
  });
  assert.equal(lock.status, 200);
  assert.equal(lock.data.module_states.zeiten, 'locked', 'jetzt sichtbar-gesperrt statt aus');

  // Upgrade auf BETRIEB: Tarif-Module + Overrides kombiniert
  await checkout(s.accessToken, 'BETRIEB');
  acc = await api('GET', '/api/account', { token: s.accessToken });
  assert.deepEqual(acc.data.tenant.modules.sort(), ['auftraege', 'geld'], 'zeiten bleibt per Override gesperrt (locked ≠ nutzbar)');
  assert.equal(acc.data.tenant.moduleStates.zeiten, 'locked');

  // 'default' entfernt Override → zeiten fällt auf Tarif (BETRIEB enthält zeiten) zurück
  const reset = await api('POST', '/api/admin/tenants/' + s.tenant.id + '/modules', {
    headers: { 'X-Admin-Token': 'test-admin-token' },
    body: { module: 'zeiten', state: 'default' },
  });
  assert.equal(reset.data.module_states.zeiten, 'on', 'ohne Override greift der Tarif → nutzbar');

  // Admin-Liste zeigt Overrides (normalisiert) + effektive Module + module_states
  const list = await api('GET', '/api/admin/tenants', { headers: { 'X-Admin-Token': 'test-admin-token' } });
  const me = list.data.tenants.find((t) => t.id === s.tenant.id);
  assert.deepEqual(me.module_overrides, { geld: 'on' }, 'zeiten-Override wurde per default entfernt');
  assert.equal(me.module_states.geld, 'on');
});

// ---------------------------------------------------------------------------
test('Angebots-Link: teilen → Kunde nimmt mit Unterschrift an → Status beim Mandanten', async () => {
  const s = await register('Angebots GmbH', 'angebot@test.de');
  const payload = {
    number: 'AN-2026-0042', title: 'Badsanierung', date: '2026-07-01', validUntil: '2026-08-01',
    kunde: 'Familie Müller', vatRate: 19, net: 1000, ust: 190, gross: 1190,
    items: [{ nr: 1, name: 'Fliesen legen', qty: 10, unit: 'm²', price: 100 }],
  };

  // Teilen (owner)
  const share = await api('POST', '/api/t/offers/share', { token: s.accessToken, body: { angebotId: 'ang1', payload } });
  assert.equal(share.status, 201, JSON.stringify(share.data));
  const token = share.data.url.split('#')[1];
  assert.ok(token && token.length >= 20);

  // Kunde ruft öffentlich ab (ohne Login!)
  const pub = await api('GET', '/api/public/offer/' + token);
  assert.equal(pub.status, 200);
  assert.equal(pub.data.firma, 'Angebots GmbH');
  assert.equal(pub.data.status, 'open');
  assert.equal(pub.data.offer.gross, 1190);

  // Annahme ohne Unterschrift → abgelehnt
  const noSig = await api('POST', '/api/public/offer/' + token + '/respond', { body: { action: 'accept', name: 'Hans Müller' } });
  assert.equal(noSig.status, 400);

  // Annahme mit Unterschrift (Mini-PNG)
  const png = 'data:image/png;base64,' + Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 1, 2, 3]).toString('base64');
  const acc = await api('POST', '/api/public/offer/' + token + '/respond', {
    body: { action: 'accept', name: 'Hans Müller', comment: 'Bitte ab KW 32', signature: png },
  });
  assert.equal(acc.status, 200);
  assert.equal(acc.data.status, 'accepted');

  // Doppelte Antwort blockiert
  const dup = await api('POST', '/api/public/offer/' + token + '/respond', { body: { action: 'decline', name: 'X Y' } });
  assert.equal(dup.status, 409);

  // Mandant sieht Antwort inkl. Unterschrift
  const links = await api('GET', '/api/t/offers/links', { token: s.accessToken });
  assert.equal(links.data.links.length, 1);
  const l = links.data.links[0];
  assert.equal(l.status, 'accepted');
  assert.equal(l.responder_name, 'Hans Müller');
  assert.equal(l.responder_comment, 'Bitte ab KW 32');
  assert.equal(l.has_signature, 1);
  const sig = await api('GET', '/api/t/offers/links/' + l.id + '/signature', { token: s.accessToken });
  assert.equal(sig.status, 200);
  assert.ok(Buffer.isBuffer(sig.data) && sig.data.length > 8);

  // Annahme ist im GoBD-Audit-Trail
  const audit = await api('GET', '/api/gobd/audit', { token: s.accessToken });
  assert.ok(audit.data.entries.some((e) => e.action === 'angebot.accepted'));

  // Fremder Mandant sieht NICHTS davon (Isolation)
  const other = await register('Fremd GmbH', 'fremd-angebot@test.de');
  const otherLinks = await api('GET', '/api/t/offers/links', { token: other.accessToken });
  assert.equal(otherLinks.data.links.length, 0);
  const otherSig = await api('GET', '/api/t/offers/links/' + l.id + '/signature', { token: other.accessToken });
  assert.equal(otherSig.status, 404);
});

test('Angebots-Link: Widerruf und Modul-Gate', async () => {
  const s = await register('Widerruf GmbH', 'widerruf@test.de');
  const share = await api('POST', '/api/t/offers/share', { token: s.accessToken, body: { payload: { number: 'AN-1', gross: 100, items: [] } } });
  const token = share.data.url.split('#')[1];

  // Widerruf → Kunde sieht 404
  await api('POST', '/api/t/offers/links/' + share.data.linkId + '/revoke', { token: s.accessToken });
  const pub = await api('GET', '/api/public/offer/' + token);
  assert.equal(pub.status, 404);

  // START-Tarif hat kein "geld" → Teilen blockiert
  await checkout(s.accessToken, 'START');
  const blocked = await api('POST', '/api/t/offers/share', { token: s.accessToken, body: { payload: { number: 'AN-2', items: [] } } });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.data.error, 'module-not-active');

  // Mitarbeiter dürfen nicht teilen
  await checkout(s.accessToken, 'BETRIEB');
  const inv = await api('POST', '/api/auth/invite', { token: s.accessToken, body: { role: 'employee' } });
  const emp = await api('POST', '/api/auth/magic', { body: { token: inv.data.url.split('#invite=')[1] } });
  const empShare = await api('POST', '/api/t/offers/share', { token: emp.data.accessToken, body: { payload: { number: 'AN-3', items: [] } } });
  assert.equal(empShare.status, 403);

  // Ungültiger Token → 404 (kein Enumerieren)
  const bogus = await api('GET', '/api/public/offer/' + 'A'.repeat(43));
  assert.equal(bogus.status, 404);
});

test('Demo-Zugang: Kontaktdaten + DSGVO-Consent → Testbetrieb + Lead', async () => {
  // Ohne Consent → abgelehnt, kein Account
  const noConsent = await api('POST', '/api/public/demo', {
    body: { name: 'Lead Person', company: 'Lead GmbH', email: 'lead@test.de', consent: false },
  });
  assert.equal(noConsent.status, 400);
  assert.equal(noConsent.data.error, 'consent-required');

  // Mit Consent → Tenant + Session + Einmal-Passwort
  const d = await api('POST', '/api/public/demo', {
    body: { name: 'Lead Person', company: 'Lead GmbH', email: 'lead@test.de', phone: '+49 123', message: 'Stundenzettel nerven', consent: true },
  });
  assert.equal(d.status, 201, JSON.stringify(d.data));
  assert.ok(d.data.accessToken && d.data.password && d.data.password.startsWith('werkos-'));
  assert.equal(d.data.user.role, 'owner');
  assert.equal(d.data.tenant.plan, 'TRIAL');

  // Login mit dem Einmal-Passwort funktioniert
  const login = await api('POST', '/api/auth/login', { body: { email: 'lead@test.de', password: d.data.password } });
  assert.equal(login.status, 200);

  // Lead gespeichert mit Consent-Nachweis (Zeitpunkt + IP)
  const leads = await api('GET', '/api/admin/leads', { headers: { 'X-Admin-Token': 'test-admin-token' } });
  const lead = leads.data.leads.find((l) => l.email === 'lead@test.de');
  assert.ok(lead, 'Lead muss gespeichert sein');
  assert.ok(lead.consent_at && lead.consent_ip);
  assert.equal(lead.message, 'Stundenzettel nerven');
  assert.equal(lead.tenant_id, d.data.tenant.id);

  // Doppelte E-Mail → Hinweis statt zweitem Account
  const dup = await api('POST', '/api/public/demo', {
    body: { name: 'Lead Person', company: 'Lead GmbH', email: 'lead@test.de', consent: true },
  });
  assert.equal(dup.status, 409);

  // DSGVO: Lead per Admin löschbar
  await api('DELETE', '/api/admin/leads/' + lead.id, { headers: { 'X-Admin-Token': 'test-admin-token' } });
  const leads2 = await api('GET', '/api/admin/leads', { headers: { 'X-Admin-Token': 'test-admin-token' } });
  assert.ok(!leads2.data.leads.some((l) => l.id === lead.id));
});

// ---------------------------------------------------------------------------
test('SALES: Checkout mit Rechnungsdaten, Abo sichtbar, Kündigung', async () => {
  const s = await register('Kauf GmbH', 'kauf@test.de');

  // Ohne AGB-Zustimmung → abgelehnt
  const noTerms = await api('POST', '/api/billing/checkout', {
    token: s.accessToken,
    body: { plan: 'BETRIEB', billing: { company: 'K', address: 'A 1', zip: '1', city: 'B', email: 'x@y.de' } },
  });
  assert.equal(noTerms.status, 400);
  assert.equal(noTerms.data.error, 'terms-required');

  // Ohne Adresse → abgelehnt
  const noAddr = await api('POST', '/api/billing/checkout', {
    token: s.accessToken, body: { plan: 'BETRIEB', acceptTerms: true, billing: { company: 'Kauf GmbH', email: 'x@y.de' } },
  });
  assert.equal(noAddr.status, 400);
  assert.equal(noAddr.data.error, 'address-required');

  // Vollständiger Kauf
  const ck = await checkout(s.accessToken, 'BETRIEB');
  assert.equal(ck.data.tenant.plan, 'BETRIEB');
  assert.equal(ck.data.tenant.subscription.priceEur, 35);

  // Abo-Details abrufbar (inkl. Rechnungsdaten)
  const sub = await api('GET', '/api/billing/subscription', { token: s.accessToken });
  assert.equal(sub.data.subscription.plan, 'BETRIEB');
  assert.equal(sub.data.subscription.billing.city, 'Berlin');
  assert.equal(sub.data.subscription.source, 'website');

  // Kauf ist im GoBD-Audit-Trail (mit Terms-Nachweis)
  const audit = await api('GET', '/api/gobd/audit', { token: s.accessToken });
  const ckEntry = audit.data.entries.find((e) => e.action === 'billing.checkout');
  assert.ok(ckEntry && JSON.parse(ckEntry.detail_json).termsAccepted === true);

  // Upgrade ersetzt das Abo (nur EIN aktives)
  await checkout(s.accessToken, 'BETRIEB_PLUS');
  const sub2 = await api('GET', '/api/billing/subscription', { token: s.accessToken });
  assert.equal(sub2.data.subscription.plan, 'BETRIEB_PLUS');
  assert.equal(sub2.data.subscription.price_eur, 59);

  // Kündigung: falsches Passwort → 401; korrekt → Lese-Modus
  const badCancel = await api('POST', '/api/billing/cancel', { token: s.accessToken, body: { password: 'falsch' } });
  assert.equal(badCancel.status, 401);
  const cancel = await api('POST', '/api/billing/cancel', { token: s.accessToken, body: { password: 'sicheres-passwort-123' } });
  assert.equal(cancel.status, 200);
  const subAfter = await api('GET', '/api/billing/subscription', { token: s.accessToken });
  assert.equal(subAfter.data.subscription, null);
  // Export bleibt möglich (kein Lock-in)
  const ex = await api('GET', '/api/dsgvo/export', { token: s.accessToken });
  assert.equal(ex.status, 200);
});

test('SALES: Admin sperrt/entsperrt, verlängert Testphase, sieht Details', async () => {
  const s = await register('Sperr GmbH', 'sperr@test.de');
  const A = { headers: { 'X-Admin-Token': 'test-admin-token' } };

  // Sperren → Schreiben blockiert, Lesen erlaubt
  const susp = await api('POST', '/api/admin/tenants/' + s.tenant.id + '/status', { ...A, body: { status: 'suspended' } });
  assert.equal(susp.status, 200);
  const w = await api('POST', '/api/t/state', { token: s.accessToken, raw: '{"x":1}' });
  assert.equal(w.status, 403);
  assert.equal(w.data.error, 'tenant-suspended');
  const rr = await api('GET', '/api/t/state', { token: s.accessToken });
  assert.equal(rr.status, 200);

  // Entsperren
  await api('POST', '/api/admin/tenants/' + s.tenant.id + '/status', { ...A, body: { status: 'active' } });
  const w2 = await api('POST', '/api/t/state', { token: s.accessToken, raw: '{"x":1}' });
  assert.equal(w2.status, 200);

  // Testphase verlängern
  const before = dbm.getTenant(s.tenant.id).trial_ends_at;
  const ext = await api('POST', '/api/admin/tenants/' + s.tenant.id + '/trial', { ...A, body: { days: 30 } });
  assert.equal(ext.status, 200);
  assert.ok(new Date(ext.data.trialEndsAt) > new Date(before));

  // Mandanten-Detail
  const det = await api('GET', '/api/admin/tenants/' + s.tenant.id, A);
  assert.equal(det.status, 200);
  assert.equal(det.data.users.length, 1);
  assert.ok(Array.isArray(det.data.recentAudit));
});

test('SALES: Vertriebs-Angebot mit Sonderpreis → Online-Abschluss → aktiver Kunde', async () => {
  const A = { headers: { 'X-Admin-Token': 'test-admin-token' } };

  // Admin erstellt persönliches Angebot: BETRIEB_PLUS für 39 € statt 59 €
  const create = await api('POST', '/api/admin/sales-offers', {
    ...A,
    body: { company: 'Beratener Betrieb GmbH', contactName: 'Willi Wunsch', email: 'willi@beraten.de', phone: '0171 1', plan: 'BETRIEB_PLUS', priceEur: 39, message: 'Wie am Telefon besprochen: Sonderpreis für Sie.', days: 14 },
  });
  assert.equal(create.status, 201, JSON.stringify(create.data));
  assert.equal(create.data.priceEur, 39);
  const token = create.data.url.split('#')[1];

  // Interessent ruft Angebot öffentlich auf
  const pub = await api('GET', '/api/public/sales-offer/' + token);
  assert.equal(pub.status, 200);
  assert.equal(pub.data.priceEur, 39);
  assert.equal(pub.data.listPriceEur, 59);
  assert.ok(pub.data.message.includes('Sonderpreis'));

  // Abschluss ohne Zustimmungen → abgelehnt
  const noC = await api('POST', '/api/public/sales-offer/' + token + '/accept', { body: { password: 'sicheres-passwort-123' } });
  assert.equal(noC.status, 400);

  // Verbindlicher Abschluss
  const acc = await api('POST', '/api/public/sales-offer/' + token + '/accept', {
    body: { password: 'wunsch-passwort-123', consent: true, acceptTerms: true },
  });
  assert.equal(acc.status, 201, JSON.stringify(acc.data));
  assert.equal(acc.data.tenant.plan, 'BETRIEB_PLUS');
  assert.equal(acc.data.tenant.subscription.priceEur, 39, 'Sonderpreis muss im Abo stehen');
  assert.equal(acc.data.user.role, 'owner');

  // Kunde kann sofort arbeiten (kein Trial-Gate) und sich später einloggen
  const w = await api('POST', '/api/t/state', { token: acc.data.accessToken, raw: '{"projekt":1}' });
  assert.equal(w.status, 200);
  const login = await api('POST', '/api/auth/login', { body: { email: 'willi@beraten.de', password: 'wunsch-passwort-123' } });
  assert.equal(login.status, 200);

  // Doppelter Abschluss blockiert; Angebot als angenommen markiert
  const dup = await api('POST', '/api/public/sales-offer/' + token + '/accept', { body: { password: 'x'.repeat(12), consent: true, acceptTerms: true } });
  assert.equal(dup.status, 409);
  const list = await api('GET', '/api/admin/sales-offers', A);
  const mine = list.data.offers.find((o) => o.email === 'willi@beraten.de');
  assert.equal(mine.status, 'accepted');
  assert.equal(mine.tenant_id, acc.data.tenant.id);

  // Lead automatisch angelegt (Vertriebshistorie)
  const leads = await api('GET', '/api/admin/leads', A);
  assert.ok(leads.data.leads.some((l) => l.email === 'willi@beraten.de' && l.source === 'sales-offer'));

  // MRR in der Übersicht enthält den Sonderpreis
  const ov = await api('GET', '/api/admin/overview', A);
  assert.ok(ov.data.stats.mrrEur >= 39);
  assert.ok(ov.data.stats.paying >= 1);

  // Widerruf eines anderen Angebots → öffentlich nicht mehr abrufbar
  const c2 = await api('POST', '/api/admin/sales-offers', { ...A, body: { company: 'Widerruf AG', email: 'w2@x.de', plan: 'START' } });
  const t2 = c2.data.url.split('#')[1];
  await api('POST', '/api/admin/sales-offers/' + c2.data.offerId + '/revoke', A);
  const gone = await api('GET', '/api/public/sales-offer/' + t2);
  assert.equal(gone.status, 404);
});

// ---------------------------------------------------------------------------
test('MODUL-TRIALS: Host gewährt Add-on-Test, läuft ab, ist kaufbar', async () => {
  const s = await register('Trial-Modul GmbH', 'trialmod@test.de');
  const A = { headers: { 'X-Admin-Token': 'test-admin-token' } };
  await checkout(s.accessToken, 'START'); // nur 'zeiten'

  let acc = await api('GET', '/api/account', { token: s.accessToken });
  assert.deepEqual(acc.data.tenant.modules, ['zeiten']);

  // Host gewährt einkauf als 7-Tage-Trial
  const gr = await api('POST', '/api/admin/tenants/' + s.tenant.id + '/grant', { ...A, body: { module: 'einkauf', days: 7 } });
  assert.equal(gr.status, 201);
  assert.ok(gr.data.effective_modules.includes('einkauf'));

  acc = await api('GET', '/api/account', { token: s.accessToken });
  assert.deepEqual(acc.data.tenant.modules.sort(), ['einkauf', 'zeiten']);
  const grant = acc.data.tenant.grants.find((g) => g.module === 'einkauf');
  assert.equal(grant.status, 'trial');
  assert.ok(grant.daysLeft >= 6 && grant.daysLeft <= 7);
  assert.equal(grant.inPlan, false);
  assert.equal(grant.addonPriceEur, 10);

  // Ungültiges Modul abgelehnt
  const bad = await api('POST', '/api/admin/tenants/' + s.tenant.id + '/grant', { ...A, body: { module: 'quatsch', days: 5 } });
  assert.equal(bad.status, 400);

  // Trial abgelaufen → Modul automatisch weg (rein über expires_at)
  dbm.db.prepare("UPDATE module_grants SET expires_at = '2000-01-01T00:00:00Z' WHERE tenant_id = ? AND module_key = 'einkauf'").run(s.tenant.id);
  acc = await api('GET', '/api/account', { token: s.accessToken });
  assert.deepEqual(acc.data.tenant.modules, ['zeiten'], 'abgelaufener Trial fällt automatisch weg');

  // Neuer Trial, diesmal kaufen → dauerhaft aktiv
  await api('POST', '/api/admin/tenants/' + s.tenant.id + '/grant', { ...A, body: { module: 'einkauf', days: 3 } });
  const buy = await api('POST', '/api/billing/buy-module', { token: s.accessToken, body: { module: 'einkauf', acceptTerms: true } });
  assert.equal(buy.status, 201, JSON.stringify(buy.data));
  acc = await api('GET', '/api/account', { token: s.accessToken });
  const bought = acc.data.tenant.grants.find((g) => g.module === 'einkauf');
  assert.equal(bought.status, 'active');
  assert.equal(bought.daysLeft, null, 'gekauft = kein Ablauf');

  // Kauf ohne AGB abgelehnt; Kauf eines Tarif-Moduls abgelehnt
  const noTerms = await api('POST', '/api/billing/buy-module', { token: s.accessToken, body: { module: 'planung' } });
  assert.equal(noTerms.status, 400);
  const inPlan = await api('POST', '/api/billing/buy-module', { token: s.accessToken, body: { module: 'zeiten', acceptTerms: true } });
  assert.equal(inPlan.status, 409);

  // MRR = START 15 + Add-on einkauf 10 = 25
  const ov = await api('GET', '/api/admin/overview', A);
  assert.ok(ov.data.stats.mrrEur >= 25);

  // Host widerruft den gekauften Grant → Modul weg
  const rev = await api('DELETE', '/api/admin/tenants/' + s.tenant.id + '/grant/einkauf', A);
  assert.equal(rev.status, 200);
  acc = await api('GET', '/api/account', { token: s.accessToken });
  assert.deepEqual(acc.data.tenant.modules, ['zeiten']);

  // Isolation: anderer Mandant hat keine Grants
  const other = await register('Ohne-Grant GmbH', 'nogrant@test.de');
  const oacc = await api('GET', '/api/account', { token: other.accessToken });
  assert.equal((oacc.data.tenant.grants || []).length, 0);
});

test('KI-Lieferschein: ohne Key sauberer Fallback, Modul-Gate greift', async () => {
  const s = await register('KI-Beleg GmbH', 'kibeleg@test.de');
  const A = { headers: { 'X-Admin-Token': 'test-admin-token' } };
  // Kleines gültiges JPEG-Byte-Muster
  const img = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0, 16, 0x4A, 0x46, 0x49, 0x46, 0, 1, 1]);

  // START-Tarif hat kein einkauf → Modul-Gate blockt
  await checkout(s.accessToken, 'START');
  const blocked = await api('POST', '/api/t/ai/delivery-note', { token: s.accessToken, raw: img, headers: { 'Content-Type': 'image/jpeg' } });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.data.error, 'module-not-active');

  // einkauf freischalten → Endpoint erreichbar, ohne KI-Key: configured:false (Fallback)
  await api('POST', '/api/admin/tenants/' + s.tenant.id + '/grant', { ...A, body: { module: 'einkauf', days: 7 } });
  const r = await api('POST', '/api/t/ai/delivery-note', { token: s.accessToken, raw: img, headers: { 'Content-Type': 'image/jpeg' } });
  assert.equal(r.status, 200);
  assert.equal(r.data.configured, false);
  assert.ok(r.data.hint.includes('manuell'));
});

test('Statische Auslieferung: Website, PWA und Bibliotheken erreichbar', async () => {
  // / ist jetzt die Marketing-Website
  const site = await fetch(BASE + '/');
  assert.equal(site.status, 200);
  const siteHtml = await site.text();
  assert.ok(siteHtml.includes('Dein ganzer Betrieb'), 'Startseite = Marketing-Website');
  assert.ok(siteHtml.includes('Datenschutzerklärung'), 'Consent-Text vorhanden');
  // Unterseiten + Rechtsseiten
  for (const [p, marker] of [
    ['/funktionen', 'Aufmaß &amp; Raumplan'],
    ['/preise', 'Leistungsvergleich'],
    ['/faq', 'Fragen &amp; Antworten'],
    ['/impressum', '§ 5 DDG'],
    ['/datenschutz', 'Art. 15'],
  ]) {
    const lr = await fetch(BASE + p);
    assert.equal(lr.status, 200, p);
    assert.ok((await lr.text()).includes(marker), p + ' Inhalt');
  }
  const css = await fetch(BASE + '/site.css');
  assert.equal(css.status, 200, 'site.css');
  // Die PWA liegt unter /app
  const r = await fetch(BASE + '/app');
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.ok(html.includes('saas.js'), '/app = PWA');
  const lib = await fetch(BASE + '/lib/qrcode.min.js');
  assert.equal(lib.status, 200);
  const saas = await fetch(BASE + '/saas.js');
  assert.equal(saas.status, 200, 'saas.js (Login-Bootstrap) muss ausgeliefert werden');
  const offer = await fetch(BASE + '/angebot');
  assert.equal(offer.status, 200, 'öffentliche Angebotsseite muss erreichbar sein');
  assert.ok((await offer.text()).includes('Unterschrift'));
  const admin = await fetch(BASE + '/admin');
  assert.equal(admin.status, 200, 'Betreiber-Konsole muss erreichbar sein');
  const abo = await fetch(BASE + '/abo');
  assert.equal(abo.status, 200, 'Vertriebs-Angebotsseite muss erreichbar sein');
  assert.ok((await abo.text()).includes('kostenpflichtig'), '/abo: Abschluss-Text vorhanden');
  const fav = await fetch(BASE + '/favicon.ico');
  assert.equal(fav.status, 200, 'Favicon-Route');
});
