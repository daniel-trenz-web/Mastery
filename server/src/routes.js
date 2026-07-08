'use strict';
// Alle API-Routen. Aufbau:
//   /api/auth/*     — Registrierung, Login, Refresh, Magic-Links
//   /api/account    — Konto/Tarif/Module (für die PWA)
//   /api/t/*        — Mandanten-Daten-API (kompatibel zum Sync-Protokoll der PWA:
//                     /ping, /state, /files/<pfad>, /restore-zip)
//   /api/gobd/*     — Audit-Trail, Revisionen, Ketten-Verifikation
//   /api/dsgvo/*    — Datenexport, Löschung
//   /api/admin/*    — Plattform-Betreiber (X-Admin-Token)

const cfg = require('./config');
const dbm = require('./db');
const zip = require('./zip');
const {
  id, nowIso, hashPassword, verifyPassword, signToken, opaqueToken,
  rateLimit, normEmail, isEmail, sha256,
} = require('./util');
const {
  readBody, readJson, send, err, clientIp, requireAuth, requireRole, requireWritable,
} = require('./http');

// --------------------------------------------------------------------------
// Session-Erzeugung (Access- + Refresh-Token)
// --------------------------------------------------------------------------
function issueSession(user, tenant, req) {
  const access = signToken({
    typ: 'access', uid: user.id, tid: tenant.id, role: user.role,
    exp: Date.now() + cfg.ACCESS_TTL_MS,
  });
  const { token: refresh, hash } = opaqueToken();
  dbm.createSession({
    userId: user.id, tenantId: tenant.id, refreshHash: hash,
    expiresAt: new Date(Date.now() + cfg.REFRESH_TTL_MS).toISOString(),
    ip: clientIp(req), ua: String(req.headers['user-agent'] || '').slice(0, 200),
  });
  return {
    accessToken: access,
    refreshToken: refresh,
    user: { id: user.id, name: user.name, email: user.email, role: user.role },
    tenant: accountInfo(tenant),
  };
}

// Effektive Module = Tarif-Module + Host-Overrides (Betreiber kann pro Mandant
// einzelne Module zusätzlich freischalten oder sperren).
function effectiveModules(tenant) {
  const plan = cfg.PLANS[tenant.plan];
  const set = new Set(plan ? plan.modules : []);
  const overrides = (dbm.getTenantSettings(tenant.id).moduleOverrides) || {};
  for (const [k, v] of Object.entries(overrides)) {
    if (!cfg.MODULES[k]) continue;
    if (v === true) set.add(k); else if (v === false) set.delete(k);
  }
  return [...set];
}

function moduleAllowed(tenant, key) { return effectiveModules(tenant).includes(key); }

function accountInfo(tenant) {
  const plan = cfg.PLANS[tenant.plan] || null;
  const trialEnds = tenant.trial_ends_at ? new Date(tenant.trial_ends_at).getTime() : 0;
  return {
    id: tenant.id, name: tenant.name, plan: tenant.plan,
    planLabel: plan ? plan.label : tenant.plan,
    modules: effectiveModules(tenant),
    moduleCatalog: cfg.MODULES,
    priceEur: plan ? plan.priceEur : null,
    trialEndsAt: tenant.trial_ends_at,
    trialExpired: tenant.plan === 'TRIAL' && trialEnds > 0 && trialEnds < Date.now(),
    status: tenant.status,
    storageGb: plan ? plan.storageGb : 0,
  };
}

// Öffentliche Basis-URL für Magic-Links: explizit konfiguriert oder aus dem
// Request abgeleitet (hinter Caddy via X-Forwarded-Proto).
function baseUrl(req) {
  if (cfg.BASE_URL) return cfg.BASE_URL;
  const proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
  const host = req.headers.host || 'localhost';
  return proto + '://' + host;
}

// Pfad-Normalisierung für Datei-API — verhindert Path-Traversal.
// WICHTIG: erst vollständig dekodieren, DANN auf Traversal filtern —
// sonst überlebt z. B. "..%2F.." als ein Segment die Prüfung.
function safePath(raw) {
  let s = String(raw).replace(/\\/g, '/');
  try { s = s.split('/').map((seg) => decodeURIComponent(seg)).join('/'); } catch (_e) {}
  const parts = s.split('/').filter((seg) => seg && seg !== '.' && seg !== '..');
  if (!parts.length) return null;
  const p = parts.join('/');
  if (p.includes('\0') || p.length > 512) return null;
  return p;
}

// --------------------------------------------------------------------------
// Haupt-Router
// --------------------------------------------------------------------------
async function handleApi(req, res, pathname) {
  const m = req.method;

  // ---------- AUTH ----------
  if (pathname === '/api/auth/register' && m === 'POST') {
    if (!rateLimit('reg:' + clientIp(req), cfg.REGISTER_LIMIT_PER_HOUR, 3600e3)) return err(res, 429, 'rate-limited');
    const b = await readJson(req, 64e3);
    const email = normEmail(b.email);
    const company = String(b.company || '').trim();
    const name = String(b.name || '').trim();
    const password = String(b.password || '');
    if (!isEmail(email)) return err(res, 400, 'invalid-email');
    if (company.length < 2) return err(res, 400, 'invalid-company');
    if (name.length < 2) return err(res, 400, 'invalid-name');
    if (password.length < 10) return err(res, 400, 'password-too-short', { hint: 'Mindestens 10 Zeichen.' });
    if (dbm.getUserByEmail(email)) return err(res, 409, 'email-exists');
    const tenant = dbm.createTenant({
      name: company,
      trialEndsAt: new Date(Date.now() + cfg.TRIAL_DAYS * 864e5).toISOString(),
    });
    const user = dbm.createUser({ tenantId: tenant.id, email, name, role: 'owner', passHash: hashPassword(password) });
    dbm.audit(tenant.id, user.id, 'tenant.created', { company, email });
    dbm.touchLogin(user.id);
    return send(res, 201, issueSession(user, tenant, req));
  }

  if (pathname === '/api/auth/login' && m === 'POST') {
    const b = await readJson(req, 16e3);
    const email = normEmail(b.email);
    if (!rateLimit('login:' + clientIp(req), 20, 900e3) || !rateLimit('login:' + email, 10, 900e3)) {
      return err(res, 429, 'rate-limited');
    }
    const user = email && dbm.getUserByEmail(email);
    if (!user || !user.pass_hash || !verifyPassword(b.password, user.pass_hash) || user.status !== 'active') {
      return err(res, 401, 'invalid-credentials');
    }
    const tenant = dbm.getTenant(user.tenant_id);
    if (!tenant || tenant.status === 'deleted') return err(res, 403, 'tenant-unavailable');
    dbm.touchLogin(user.id);
    dbm.audit(tenant.id, user.id, 'auth.login', { ip: clientIp(req) });
    return send(res, 200, issueSession(user, tenant, req));
  }

  if (pathname === '/api/auth/refresh' && m === 'POST') {
    const b = await readJson(req, 16e3);
    const hash = sha256(String(b.refreshToken || ''));
    const sess = dbm.findSessionByRefresh(hash);
    if (!sess || new Date(sess.expires_at).getTime() < Date.now()) return err(res, 401, 'invalid-refresh');
    const user = dbm.getUser(sess.user_id);
    const tenant = user && dbm.getTenant(user.tenant_id);
    if (!user || user.status !== 'active' || !tenant || tenant.status === 'deleted') return err(res, 401, 'invalid-refresh');
    // Rotation: alter Refresh-Token wird ungültig
    const { token: newRefresh, hash: newHash } = opaqueToken();
    dbm.rotateSession(sess.id, newHash, new Date(Date.now() + cfg.REFRESH_TTL_MS).toISOString());
    const access = signToken({ typ: 'access', uid: user.id, tid: tenant.id, role: user.role, exp: Date.now() + cfg.ACCESS_TTL_MS });
    return send(res, 200, {
      accessToken: access, refreshToken: newRefresh,
      user: { id: user.id, name: user.name, email: user.email, role: user.role },
      tenant: accountInfo(tenant),
    });
  }

  if (pathname === '/api/auth/logout' && m === 'POST') {
    const ctx = requireAuth(req, res); if (!ctx) return;
    dbm.revokeUserSessions(ctx.user.id);
    dbm.audit(ctx.tenant.id, ctx.user.id, 'auth.logout', {});
    return send(res, 200, { ok: true });
  }

  // Magic-Link einlösen → Mitarbeiter-Session (legt beim ersten Mal den User an)
  if (pathname === '/api/auth/magic' && m === 'POST') {
    if (!rateLimit('magic:' + clientIp(req), 30, 900e3)) return err(res, 429, 'rate-limited');
    const b = await readJson(req, 16e3);
    const link = dbm.findMagicLink(sha256(String(b.token || '')));
    if (!link || new Date(link.expires_at).getTime() < Date.now() || link.uses >= link.max_uses) {
      return err(res, 401, 'invalid-invite');
    }
    const tenant = dbm.getTenant(link.tenant_id);
    if (!tenant || tenant.status !== 'active') return err(res, 403, 'tenant-unavailable');
    const displayName = String(b.name || link.name || 'Mitarbeiter').trim().slice(0, 80);
    const user = dbm.createUser({ tenantId: tenant.id, email: null, name: displayName, role: link.role });
    dbm.useMagicLink(link.id);
    dbm.touchLogin(user.id);
    dbm.audit(tenant.id, user.id, 'auth.magic-link-used', { linkId: link.id, name: displayName, role: link.role });
    return send(res, 200, issueSession(user, tenant, req));
  }

  // Einladungs-Link erzeugen (Chef/Büro)
  if (pathname === '/api/auth/invite' && m === 'POST') {
    const ctx = requireAuth(req, res); if (!ctx) return;
    if (!requireRole(ctx, res, ['owner', 'office'])) return;
    const b = await readJson(req, 16e3);
    const role = ['employee', 'office', 'external'].includes(b.role) ? b.role : 'employee';
    if (role === 'office' && ctx.user.role !== 'owner') return err(res, 403, 'only-owner-invites-office');
    const { token, hash } = opaqueToken();
    const expiresAt = new Date(Date.now() + Math.min(Number(b.days) || 14, 90) * 864e5).toISOString();
    const linkId = dbm.createMagicLink({
      tenantId: ctx.tenant.id, createdBy: ctx.user.id, role,
      name: String(b.name || '').slice(0, 80) || null,
      tokenHash: hash, maxUses: Math.min(Math.max(Number(b.maxUses) || 1, 1), 50), expiresAt,
    });
    dbm.audit(ctx.tenant.id, ctx.user.id, 'invite.created', { linkId, role, expiresAt });
    return send(res, 201, { url: baseUrl(req) + '/app#invite=' + token, expiresAt, role, linkId });
  }

  if (pathname === '/api/auth/invites' && m === 'GET') {
    const ctx = requireAuth(req, res); if (!ctx) return;
    if (!requireRole(ctx, res, ['owner', 'office'])) return;
    return send(res, 200, { invites: dbm.listMagicLinks(ctx.tenant.id) });
  }

  if (pathname.startsWith('/api/auth/invites/') && m === 'DELETE') {
    const ctx = requireAuth(req, res); if (!ctx) return;
    if (!requireRole(ctx, res, ['owner', 'office'])) return;
    const mid = pathname.split('/').pop();
    dbm.revokeMagicLink(ctx.tenant.id, mid);
    dbm.audit(ctx.tenant.id, ctx.user.id, 'invite.revoked', { linkId: mid });
    return send(res, 200, { ok: true });
  }

  // Demo-Zugang von der Website: Kontaktdaten + DSGVO-Consent → sofort nutzbarer
  // Testbetrieb (14 Tage, alle Module) + einmalig angezeigtes Passwort.
  if (pathname === '/api/public/demo' && m === 'POST') {
    if (!rateLimit('demo:' + clientIp(req), 5, 3600e3)) return err(res, 429, 'rate-limited');
    const b = await readJson(req, 32e3);
    const email = normEmail(b.email);
    const name = String(b.name || '').trim();
    const company = String(b.company || '').trim();
    if (b.consent !== true) return err(res, 400, 'consent-required', { hint: 'Bitte Datenschutzerklärung zustimmen.' });
    if (!isEmail(email)) return err(res, 400, 'invalid-email');
    if (name.length < 2) return err(res, 400, 'invalid-name');
    if (company.length < 2) return err(res, 400, 'invalid-company');
    if (dbm.getUserByEmail(email)) return err(res, 409, 'email-exists', { hint: 'Diese E-Mail hat bereits einen Zugang — bitte anmelden.' });
    // Gut lesbares Einmal-Passwort (wird dem Nutzer einmalig angezeigt)
    const password = 'werkos-' + id().slice(0, 10);
    const tenant = dbm.createTenant({
      name: company,
      trialEndsAt: new Date(Date.now() + cfg.TRIAL_DAYS * 864e5).toISOString(),
    });
    const user = dbm.createUser({ tenantId: tenant.id, email, name, role: 'owner', passHash: hashPassword(password) });
    dbm.createLead({
      name, company, email, phone: String(b.phone || '').slice(0, 60),
      message: String(b.message || '').slice(0, 2000),
      consentIp: clientIp(req), source: 'website-demo', tenantId: tenant.id,
    });
    dbm.audit(tenant.id, user.id, 'tenant.created', { company, email, source: 'website-demo', consent: true });
    dbm.touchLogin(user.id);
    const session = issueSession(user, tenant, req);
    return send(res, 201, Object.assign({ password }, session));
  }

  // ---------- KONTO ----------
  if (pathname === '/api/account' && m === 'GET') {
    const ctx = requireAuth(req, res); if (!ctx) return;
    return send(res, 200, {
      user: { id: ctx.user.id, name: ctx.user.name, email: ctx.user.email, role: ctx.user.role },
      tenant: accountInfo(ctx.tenant),
      users: ['owner', 'office'].includes(ctx.user.role) ? dbm.listUsers(ctx.tenant.id) : undefined,
      storageBytes: dbm.tenantStorageBytes(ctx.tenant.id),
      plans: cfg.PLANS,
    });
  }

  // Tarifwahl. V1: direkte Aktivierung + Audit (Zahlung via SEPA/Stripe folgt —
  // die Webhook-Route unten ist der Andockpunkt).
  if (pathname === '/api/billing/choose-plan' && m === 'POST') {
    const ctx = requireAuth(req, res); if (!ctx) return;
    if (!requireRole(ctx, res, ['owner'])) return;
    const b = await readJson(req, 16e3);
    const plan = String(b.plan || '');
    if (!cfg.PLANS[plan] || plan === 'TRIAL') return err(res, 400, 'invalid-plan');
    dbm.setTenantPlan(ctx.tenant.id, plan);
    dbm.audit(ctx.tenant.id, ctx.user.id, 'billing.plan-changed', { from: ctx.tenant.plan, to: plan });
    return send(res, 200, { ok: true, tenant: accountInfo(dbm.getTenant(ctx.tenant.id)) });
  }

  // Stripe-Webhook-Andockpunkt (Signaturprüfung folgt mit echten Stripe-Keys)
  if (pathname === '/api/billing/webhook' && m === 'POST') {
    await readBody(req, 1e6);
    return send(res, 200, { received: true });
  }

  // ---------- MANDANTEN-DATEN-API (PWA-Sync-Protokoll) ----------
  if (pathname === '/api/t/ping' && m === 'GET') {
    const ctx = requireAuth(req, res); if (!ctx) return;
    return send(res, 200, { ok: true, service: 'werkos', tenant: ctx.tenant.id, time: nowIso() });
  }

  if (pathname === '/api/t/state' && m === 'GET') {
    const ctx = requireAuth(req, res); if (!ctx) return;
    const st = dbm.loadState(ctx.tenant.id);
    if (!st) return send(res, 200, {});
    return send(res, 200, st.json, { 'X-State-Rev': String(st.rev), ETag: '"' + st.sha256 + '"' });
  }

  if (pathname === '/api/t/state' && m === 'POST') {
    const ctx = requireAuth(req, res); if (!ctx) return;
    if (!requireWritable(ctx, res, cfg.PLANS)) return;
    const buf = await readBody(req, cfg.MAX_STATE_BYTES);
    let parsed;
    try { parsed = JSON.parse(buf.toString('utf8')); } catch (_e) { return err(res, 400, 'invalid-json'); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return err(res, 400, 'state-must-be-object');
    const r = dbm.saveStateRevision(ctx.tenant.id, ctx.user.id, buf);
    if (!r.unchanged) dbm.audit(ctx.tenant.id, ctx.user.id, 'state.saved', { rev: r.rev, size: buf.length });
    return send(res, 200, { ok: true, rev: r.rev, unchanged: !!r.unchanged });
  }

  if (pathname.startsWith('/api/t/files/') && (m === 'PUT' || m === 'GET')) {
    const ctx = requireAuth(req, res); if (!ctx) return;
    const p = safePath(pathname.slice('/api/t/files/'.length));
    if (!p) return err(res, 400, 'invalid-path');
    if (m === 'PUT') {
      if (!requireWritable(ctx, res, cfg.PLANS)) return;
      const plan = cfg.PLANS[ctx.tenant.plan];
      const quota = (plan ? plan.storageGb : 1) * 1e9;
      if (dbm.tenantStorageBytes(ctx.tenant.id) > quota) return err(res, 507, 'storage-quota-exceeded');
      const data = await readBody(req, cfg.MAX_FILE_BYTES);
      const r = dbm.putFile(ctx.tenant.id, ctx.user.id, p, req.headers['content-type'], data);
      dbm.audit(ctx.tenant.id, ctx.user.id, 'file.saved', { path: p, version: r.version, size: data.length });
      return send(res, 200, { ok: true, path: p, version: r.version });
    }
    const f = dbm.getFile(ctx.tenant.id, p);
    if (!f) return err(res, 404, 'not-found');
    // node:sqlite liefert BLOBs als Uint8Array — für send() in Buffer wandeln
    return send(res, 200, Buffer.from(f.data), { 'Content-Type': f.content_type || 'application/octet-stream', ETag: '"' + f.sha256 + '"' });
  }

  if (pathname === '/api/t/files' && m === 'GET') {
    const ctx = requireAuth(req, res); if (!ctx) return;
    return send(res, 200, { files: dbm.listFiles(ctx.tenant.id) });
  }

  // Voll-Backup einspielen (Erstumzug aus der Einzelplatz-Version):
  // ZIP mit state.json + Dateien wird mandantenbezogen übernommen.
  if (pathname === '/api/t/restore-zip' && m === 'POST') {
    const ctx = requireAuth(req, res); if (!ctx) return;
    if (!requireRole(ctx, res, ['owner', 'office'])) return;
    if (!requireWritable(ctx, res, cfg.PLANS)) return;
    const buf = await readBody(req, cfg.MAX_ZIP_BYTES);
    let entries;
    try { entries = zip.parseZip(buf); } catch (e) { return err(res, 400, 'invalid-zip', { detail: e.message }); }
    let files = 0, stateRev = null;
    for (const e of entries) {
      const p = safePath(e.name);
      if (!p) continue;
      if (p === 'state.json') {
        try { JSON.parse(e.data.toString('utf8')); } catch (_x) { continue; }
        stateRev = dbm.saveStateRevision(ctx.tenant.id, ctx.user.id, e.data).rev;
      } else {
        dbm.putFile(ctx.tenant.id, ctx.user.id, p, null, e.data);
        files++;
      }
    }
    dbm.audit(ctx.tenant.id, ctx.user.id, 'restore.zip', { files, stateRev, zipBytes: buf.length });
    return send(res, 200, { ok: true, files, stateRev });
  }

  // ---------- ANGEBOTS-LINKS (Kunde signiert per Link) ----------
  // Mandant erzeugt einen öffentlichen Link zu einem Angebots-Snapshot.
  if (pathname === '/api/t/offers/share' && m === 'POST') {
    const ctx = requireAuth(req, res); if (!ctx) return;
    if (!requireRole(ctx, res, ['owner', 'office'])) return;
    if (!requireWritable(ctx, res, cfg.PLANS)) return;
    if (!moduleAllowed(ctx.tenant, 'geld')) return err(res, 403, 'module-not-active', { module: 'geld' });
    const b = await readJson(req, cfg.MAX_OFFER_PAYLOAD);
    if (!b.payload || typeof b.payload !== 'object') return err(res, 400, 'payload-required');
    const { token, hash } = opaqueToken();
    const days = Math.min(Math.max(Number(b.days) || cfg.OFFER_LINK_DAYS, 1), 90);
    const expiresAt = new Date(Date.now() + days * 864e5).toISOString();
    const linkId = dbm.createOfferLink({
      tenantId: ctx.tenant.id, createdBy: ctx.user.id, tokenHash: hash,
      angebotId: String(b.angebotId || '').slice(0, 80) || null,
      number: String(b.payload.number || '').slice(0, 60) || null,
      payloadJson: JSON.stringify(b.payload), expiresAt,
    });
    dbm.audit(ctx.tenant.id, ctx.user.id, 'angebot.link-created', { linkId, number: b.payload.number, expiresAt });
    return send(res, 201, { linkId, url: baseUrl(req) + '/angebot#' + token, expiresAt });
  }

  if (pathname === '/api/t/offers/links' && m === 'GET') {
    const ctx = requireAuth(req, res); if (!ctx) return;
    if (!requireRole(ctx, res, ['owner', 'office'])) return;
    return send(res, 200, { links: dbm.listOfferLinks(ctx.tenant.id) });
  }

  const offRevoke = pathname.match(/^\/api\/t\/offers\/links\/([^/]+)\/revoke$/);
  if (offRevoke && m === 'POST') {
    const ctx = requireAuth(req, res); if (!ctx) return;
    if (!requireRole(ctx, res, ['owner', 'office'])) return;
    dbm.revokeOfferLink(ctx.tenant.id, offRevoke[1]);
    dbm.audit(ctx.tenant.id, ctx.user.id, 'angebot.link-revoked', { linkId: offRevoke[1] });
    return send(res, 200, { ok: true });
  }

  const offSig = pathname.match(/^\/api\/t\/offers\/links\/([^/]+)\/signature$/);
  if (offSig && m === 'GET') {
    const ctx = requireAuth(req, res); if (!ctx) return;
    if (!requireRole(ctx, res, ['owner', 'office', 'external'])) return;
    const link = dbm.getOfferLink(ctx.tenant.id, offSig[1]);
    if (!link || !link.signature_png) return err(res, 404, 'not-found');
    return send(res, 200, Buffer.from(link.signature_png), { 'Content-Type': 'image/png' });
  }

  // ÖFFENTLICH (ohne Login): Kunde ruft Angebot auf und antwortet.
  const pubOffer = pathname.match(/^\/api\/public\/offer\/([A-Za-z0-9_-]{20,})$/);
  if (pubOffer && m === 'GET') {
    if (!rateLimit('pubof:' + clientIp(req), 120, 900e3)) return err(res, 429, 'rate-limited');
    const link = dbm.findOfferLinkByToken(sha256(pubOffer[1]));
    if (!link || link.status === 'revoked') return err(res, 404, 'not-found');
    const tenant = dbm.getTenant(link.tenant_id);
    if (!tenant || tenant.status !== 'active') return err(res, 404, 'not-found');
    const expired = new Date(link.expires_at).getTime() < Date.now();
    if (link.status === 'open' && !expired) dbm.markOfferOpened(link.id);
    let payload = null;
    try { payload = JSON.parse(link.payload_json); } catch (_e) {}
    return send(res, 200, {
      firma: tenant.name, status: link.status, expired,
      expiresAt: link.expires_at, respondedAt: link.responded_at,
      responderName: link.responder_name, offer: payload,
    });
  }

  const pubRespond = pathname.match(/^\/api\/public\/offer\/([A-Za-z0-9_-]{20,})\/respond$/);
  if (pubRespond && m === 'POST') {
    if (!rateLimit('pubre:' + clientIp(req), 15, 900e3)) return err(res, 429, 'rate-limited');
    const b = await readJson(req, cfg.MAX_SIGNATURE_BYTES + 32e3);
    const link = dbm.findOfferLinkByToken(sha256(pubRespond[1]));
    if (!link || link.status === 'revoked') return err(res, 404, 'not-found');
    if (link.status !== 'open') return err(res, 409, 'already-responded');
    if (new Date(link.expires_at).getTime() < Date.now()) return err(res, 410, 'link-expired');
    const action = b.action === 'accept' ? 'accepted' : (b.action === 'decline' ? 'declined' : null);
    if (!action) return err(res, 400, 'invalid-action');
    const name = String(b.name || '').trim().slice(0, 120);
    if (!name) return err(res, 400, 'name-required');
    let signature = null;
    if (action === 'accepted') {
      const durl = String(b.signature || '');
      if (!durl.startsWith('data:image/png;base64,')) return err(res, 400, 'signature-required');
      try { signature = Buffer.from(durl.slice(22), 'base64'); } catch (_e) { return err(res, 400, 'signature-invalid'); }
      if (!signature.length || signature.length > cfg.MAX_SIGNATURE_BYTES) return err(res, 400, 'signature-invalid');
    }
    dbm.respondOfferLink(link.id, {
      status: action, name, comment: String(b.comment || '').slice(0, 2000),
      ip: clientIp(req), signature,
    });
    // GoBD/Vertragsschluss: Annahme mit Zeitstempel, Name und IP im Audit-Trail
    dbm.audit(link.tenant_id, 'kunde:' + name, 'angebot.' + action, {
      linkId: link.id, number: link.number, ip: clientIp(req), hasSignature: !!signature,
    });
    return send(res, 200, { ok: true, status: action });
  }

  // ---------- GoBD ----------
  if (pathname === '/api/gobd/audit' && m === 'GET') {
    const ctx = requireAuth(req, res); if (!ctx) return;
    if (!requireRole(ctx, res, ['owner', 'office', 'external'])) return;
    const u = new URL(req.url, 'http://x');
    return send(res, 200, {
      entries: dbm.auditList(ctx.tenant.id, Number(u.searchParams.get('limit')) || 1000, Number(u.searchParams.get('offset')) || 0),
    });
  }

  if (pathname === '/api/gobd/verify' && m === 'GET') {
    const ctx = requireAuth(req, res); if (!ctx) return;
    return send(res, 200, dbm.auditVerify(ctx.tenant.id));
  }

  if (pathname === '/api/gobd/revisions' && m === 'GET') {
    const ctx = requireAuth(req, res); if (!ctx) return;
    if (!requireRole(ctx, res, ['owner', 'office', 'external'])) return;
    return send(res, 200, { revisions: dbm.listRevisions(ctx.tenant.id) });
  }

  const revMatch = pathname.match(/^\/api\/gobd\/revisions\/(\d+)$/);
  if (revMatch && m === 'GET') {
    const ctx = requireAuth(req, res); if (!ctx) return;
    if (!requireRole(ctx, res, ['owner', 'office', 'external'])) return;
    const st = dbm.loadState(ctx.tenant.id, Number(revMatch[1]));
    if (!st) return err(res, 404, 'not-found');
    return send(res, 200, st.json, { 'X-State-Rev': String(st.rev) });
  }

  // ---------- DSGVO ----------
  // Vollständiger Datenexport (Art. 15/20 DSGVO + GoBD-Datenzugriff Z3):
  // aktueller State, alle Revisionen-Metadaten, alle Dateien, Audit-Log, Nutzerliste.
  if (pathname === '/api/dsgvo/export' && m === 'GET') {
    const ctx = requireAuth(req, res); if (!ctx) return;
    if (!requireRole(ctx, res, ['owner', 'external'])) return;
    const entries = [];
    const st = dbm.loadState(ctx.tenant.id);
    if (st) entries.push({ name: 'state.json', data: st.json });
    entries.push({ name: 'meta/revisionen.json', data: Buffer.from(JSON.stringify(dbm.listRevisions(ctx.tenant.id, 100000), null, 2)) });
    entries.push({ name: 'meta/audit-log.json', data: Buffer.from(JSON.stringify(dbm.auditList(ctx.tenant.id, 1000000, 0), null, 2)) });
    entries.push({ name: 'meta/nutzer.json', data: Buffer.from(JSON.stringify(dbm.listUsers(ctx.tenant.id), null, 2)) });
    entries.push({
      name: 'meta/export-info.json',
      data: Buffer.from(JSON.stringify({
        exportiert_am: nowIso(), mandant: ctx.tenant.id, firma: ctx.tenant.name,
        angefordert_von: ctx.user.id, format: 'WERKOS DSGVO/GoBD-Export v1',
      }, null, 2)),
    });
    for (const f of dbm.listFiles(ctx.tenant.id)) {
      const file = dbm.getFile(ctx.tenant.id, f.path);
      if (file) entries.push({ name: 'dateien/' + f.path, data: file.data });
    }
    dbm.audit(ctx.tenant.id, ctx.user.id, 'dsgvo.export', { entries: entries.length });
    const zipBuf = zip.buildZip(entries);
    return send(res, 200, zipBuf, {
      'Content-Type': 'application/zip',
      'Content-Disposition': 'attachment; filename="werkos-export-' + ctx.tenant.id + '.zip"',
    });
  }

  // Mandanten-Löschung (Art. 17 DSGVO): Karenzfrist, danach endgültige Löschung.
  if (pathname === '/api/dsgvo/delete-tenant' && m === 'POST') {
    const ctx = requireAuth(req, res); if (!ctx) return;
    if (!requireRole(ctx, res, ['owner'])) return;
    const b = await readJson(req, 16e3);
    if (!ctx.user.pass_hash || !verifyPassword(b.password, ctx.user.pass_hash)) return err(res, 401, 'password-required');
    const deleteAfter = new Date(Date.now() + cfg.DELETE_GRACE_DAYS * 864e5).toISOString();
    dbm.setTenantStatus(ctx.tenant.id, 'deletion_pending', deleteAfter);
    dbm.audit(ctx.tenant.id, ctx.user.id, 'dsgvo.deletion-requested', { deleteAfter });
    return send(res, 200, { ok: true, deleteAfter, hint: 'Endgültige Löschung nach ' + cfg.DELETE_GRACE_DAYS + ' Tagen. Bis dahin per Support widerrufbar. Hinweis: Handels-/steuerrechtliche Aufbewahrungspflichten (§ 147 AO) liegen ab Löschung beim Betrieb — vorher Export ziehen!' });
  }

  if (pathname === '/api/dsgvo/cancel-deletion' && m === 'POST') {
    const ctx = requireAuth(req, res); if (!ctx) return;
    if (!requireRole(ctx, res, ['owner'])) return;
    if (ctx.tenant.status !== 'deletion_pending') return err(res, 400, 'not-pending');
    dbm.setTenantStatus(ctx.tenant.id, 'active', null);
    dbm.audit(ctx.tenant.id, ctx.user.id, 'dsgvo.deletion-cancelled', {});
    return send(res, 200, { ok: true });
  }

  // ---------- PLATTFORM-ADMIN ----------
  if (pathname.startsWith('/api/admin/')) {
    if (!cfg.ADMIN_TOKEN || req.headers['x-admin-token'] !== cfg.ADMIN_TOKEN) return err(res, 401, 'unauthorized');
    if (pathname === '/api/admin/tenants' && m === 'GET') {
      const tenants = dbm.listTenants().map((t) => Object.assign({}, t, {
        effective_modules: effectiveModules(t),
        module_overrides: dbm.getTenantSettings(t.id).moduleOverrides || {},
      }));
      return send(res, 200, { tenants, plans: cfg.PLANS, moduleCatalog: cfg.MODULES });
    }
    // Host schaltet Module pro Mandant frei/sperrt sie (unabhängig vom Tarif)
    const modMatch = pathname.match(/^\/api\/admin\/tenants\/([^/]+)\/modules$/);
    if (modMatch && m === 'POST') {
      const b = await readJson(req, 16e3);
      const t = dbm.getTenant(modMatch[1]);
      if (!t) return err(res, 404, 'not-found');
      const overrides = {};
      for (const [k, v] of Object.entries(b.overrides || {})) {
        if (cfg.MODULES[k] && typeof v === 'boolean') overrides[k] = v;
      }
      dbm.setTenantModuleOverrides(t.id, overrides);
      dbm.audit(t.id, 'platform-admin', 'modules.overridden', { overrides });
      return send(res, 200, { ok: true, effective_modules: effectiveModules(dbm.getTenant(t.id)) });
    }
    const planMatch = pathname.match(/^\/api\/admin\/tenants\/([^/]+)\/plan$/);
    if (planMatch && m === 'POST') {
      const b = await readJson(req, 16e3);
      if (!cfg.PLANS[b.plan]) return err(res, 400, 'invalid-plan');
      const t = dbm.getTenant(planMatch[1]);
      if (!t) return err(res, 404, 'not-found');
      dbm.setTenantPlan(t.id, b.plan);
      dbm.audit(t.id, 'platform-admin', 'billing.plan-changed', { to: b.plan });
      return send(res, 200, { ok: true });
    }
    if (pathname === '/api/admin/purge-due' && m === 'POST') {
      return send(res, 200, { purged: dbm.purgeDueTenants() });
    }
    if (pathname === '/api/admin/leads' && m === 'GET') return send(res, 200, { leads: dbm.listLeads() });
    const leadDel = pathname.match(/^\/api\/admin\/leads\/([^/]+)$/);
    if (leadDel && m === 'DELETE') { dbm.deleteLead(leadDel[1]); return send(res, 200, { ok: true }); }
    return err(res, 404, 'not-found');
  }

  return err(res, 404, 'not-found');
}

module.exports = { handleApi };
