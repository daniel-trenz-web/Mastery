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
const ai = require('./ai');
const mail = require('./mail');
const einvoice = require('./integrations/einvoice');
const bankstmt = require('./integrations/bankstatements');
const { reconcile } = require('./integrations/reconcile');
const datev = require('./integrations/datev');
const datanorm = require('./integrations/datanorm');
const ugl = require('./integrations/ugl');
const ids = require('./integrations/ids');
const lexoffice = require('./integrations/lexoffice');
const sitegen = require('./integrations/sitegen');
const xrechnung = require('./integrations/xrechnung');
const gaeb = require('./integrations/gaeb');
const sepa = require('./integrations/sepa');
const gobd = require('./integrations/gobd');
const payroll = require('./integrations/payroll');
const ical = require('./integrations/ical');
const weather = require('./integrations/weather');
const psd2 = require('./integrations/psd2');
const secure = require('./secure');
const stripe = require('./stripe');
const zipm = require('./zip');
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

// Effektive Module = Tarif-Module + aktive Add-on-Grants (Trials/Käufe) +
// Host-Overrides. Reihenfolge: Grants ergänzen, Overrides gewinnen zuletzt
// (sperren/freischalten unabhängig von allem).
function effectiveModules(tenant) {
  const plan = cfg.PLANS[tenant.plan];
  const set = new Set(plan ? plan.modules : []);
  for (const g of dbm.activeGrants(tenant.id)) {
    if (cfg.MODULES[g.module_key]) set.add(g.module_key);
  }
  const overrides = (dbm.getTenantSettings(tenant.id).moduleOverrides) || {};
  for (const [k, v] of Object.entries(overrides)) {
    if (!cfg.MODULES[k]) continue;
    // Tri-State: 'on' schaltet frei, 'off'/'locked' machen unnutzbar (locked bleibt sichtbar).
    if (v === true || v === 'on') set.add(k);
    else if (v === false || v === 'off' || v === 'locked') set.delete(k);
  }
  return [...set];
}

function moduleAllowed(tenant, key) { return effectiveModules(tenant).includes(key); }

// Dreistufiger Sichtbarkeits-/Nutzungs-Status je Modul für den Mandanten:
//   'on'     = freigeschaltet (sichtbar & nutzbar)
//   'locked' = sichtbar, aber gesperrt (läuft im Hintergrund, sofort freischaltbar) — Standard
//   'off'    = ausgeblendet (für den Mandanten unsichtbar)
function moduleStates(tenant) {
  const usable = new Set(effectiveModules(tenant));
  const overrides = (dbm.getTenantSettings(tenant.id).moduleOverrides) || {};
  const states = {};
  for (const key of Object.keys(cfg.MODULES)) {
    const ov = overrides[key];
    if (ov === 'off' || ov === false) states[key] = 'off';
    else if (usable.has(key)) states[key] = 'on';
    else states[key] = 'locked'; // Standard: sichtbar-gesperrt (auch bei ov==='locked')
  }
  return states;
}

// --- Modul×Mitarbeiter-Preismodell -----------------------------------------
// Preis = f(Anzahl verkaufbarer, freigeschalteter Module, Mitarbeiter-Staffel).
// Die Mitarbeiterzahl kommt aus den Tenant-Settings (vom Client gepflegt),
// Standard 1 (kleinster Betrieb → günstigste Staffel).
function tenantEmployees(tenant) {
  const n = Number((dbm.getTenantSettings(tenant.id) || {}).employeeCount);
  return n >= 1 ? Math.floor(n) : 1;
}
// Aktuell freigeschaltete, verkaufbare Module (Schnittmenge mit SELLABLE_MODULES).
function sellableActive(tenant) {
  const eff = new Set(effectiveModules(tenant));
  return cfg.SELLABLE_MODULES.filter((k) => eff.has(k));
}
// Vollständiges Preisbild eines Mandanten + Upsell-Preis je noch nicht
// gebuchtem Modul (Mehrpreis + neuer Paketpreis), damit die App den Preis
// beim Klick auf ein gesperrtes Modul sofort ohne Rückfrage anzeigen kann.
function pricingInfo(tenant) {
  const employees = tenantEmployees(tenant);
  const tierIdx = cfg.employeeTierIndex(employees);
  const active = sellableActive(tenant);
  const count = active.length;
  const monthlyEur = cfg.modulePrice(count, employees);
  const upsell = {};
  for (const k of cfg.SELLABLE_MODULES) {
    if (active.includes(k)) continue;
    const next = cfg.modulePrice(count + 1, employees);
    upsell[k] = {
      addEur: next - monthlyEur,   // Mehrpreis für DIESES Modul
      newTotalEur: next,           // neuer Paketpreis danach
      newCount: count + 1,
    };
  }
  return {
    employees,
    tier: cfg.EMPLOYEE_TIERS[tierIdx].short,
    tierLabel: cfg.EMPLOYEE_TIERS[tierIdx].label,
    activeModules: active,
    moduleCount: count,
    monthlyEur,
    maxModules: cfg.SELLABLE_MODULES.length,
    upsell,
  };
}

// Stripe-Referenzen des Mandanten (in settings_json abgelegt — migrationsfrei).
function stripeIds(tenant) {
  const s = dbm.getTenantSettings(tenant.id) || {};
  return { customerId: s.stripeCustomerId || null, subscriptionId: s.stripeSubscriptionId || null };
}

// Stripe-Webhook-Events verarbeiten (nach erfolgreicher Signaturprüfung).
// Idempotent gehalten: doppelte Zustellung schadet nicht.
function handleStripeEvent(event) {
  const obj = event && event.data && event.data.object;
  if (!obj) return;
  const tenantId = obj.metadata && obj.metadata.tenantId;
  if (event.type === 'checkout.session.completed') {
    if (!tenantId) return;
    const tenant = dbm.getTenant(tenantId);
    if (!tenant) return;
    // Stripe-Referenzen sichern (für Upsell-Proration + spätere Events).
    if (obj.customer) dbm.setTenantSetting(tenantId, 'stripeCustomerId', obj.customer);
    if (obj.subscription) dbm.setTenantSetting(tenantId, 'stripeSubscriptionId', obj.subscription);
    const pending = (dbm.getTenantSettings(tenantId) || {}).pendingCheckout || {};
    const kind = (obj.metadata && obj.metadata.kind) || pending.kind;
    if (kind === 'plan') {
      const plan = (obj.metadata && obj.metadata.plan) || pending.plan;
      if (!cfg.PLANS[plan]) return;
      const billing = pending.billing || { company: tenant.name, payMethod: 'card' };
      const subId = dbm.createSubscription({
        tenantId, plan, priceEur: pending.amountEur != null ? pending.amountEur : cfg.PLANS[plan].priceEur,
        billing, source: 'website', createdBy: 'stripe:webhook',
      });
      dbm.setTenantPlan(tenantId, plan);
      dbm.setTenantStatus(tenantId, 'active', null);
      dbm.setTenantSetting(tenantId, 'pendingCheckout', null);
      dbm.audit(tenantId, 'stripe', 'billing.checkout-paid', { subId, plan, provider: 'stripe', stripeSubscription: obj.subscription });
    } else if (kind === 'module') {
      const key = (obj.metadata && obj.metadata.module) || pending.module;
      if (!cfg.MODULES[key]) return;
      dbm.grantModule({ tenantId, moduleKey: key, status: 'active', priceEur: pending.addEur != null ? pending.addEur : null, createdBy: 'stripe:webhook', note: 'gekauft' });
      const after = pricingInfo(dbm.getTenant(tenantId));
      dbm.setTenantSetting(tenantId, 'pendingCheckout', null);
      dbm.audit(tenantId, 'stripe', 'module.purchased-paid', { module: key, newMonthlyEur: after.monthlyEur, provider: 'stripe', stripeSubscription: obj.subscription });
    }
  } else if (event.type === 'customer.subscription.deleted') {
    // Abo bei Stripe beendet (Zahlungsausfall/Kündigung) → Lesemodus.
    if (!tenantId) return;
    const tenant = dbm.getTenant(tenantId);
    if (!tenant) return;
    dbm.cancelSubscription(tenantId);
    dbm.setTenantSetting(tenantId, 'stripeSubscriptionId', null);
    dbm.audit(tenantId, 'stripe', 'billing.subscription-ended', { provider: 'stripe', reason: obj.cancellation_details && obj.cancellation_details.reason });
  } else if (event.type === 'invoice.payment_failed') {
    if (!tenantId) return;
    dbm.audit(tenantId, 'stripe', 'billing.payment-failed', { provider: 'stripe', invoice: obj.id });
  }
}

// Aufbereitete Grant-Infos für die Anzeige (Trial-Countdown, Kauf-CTA)
function grantInfo(tenant) {
  const planModules = (cfg.PLANS[tenant.plan] || {}).modules || [];
  return dbm.activeGrants(tenant.id).map((g) => ({
    module: g.module_key,
    label: (cfg.MODULES[g.module_key] || {}).label || g.module_key,
    status: g.status,
    expiresAt: g.expires_at,
    daysLeft: g.expires_at ? Math.max(0, Math.ceil((new Date(g.expires_at).getTime() - Date.now()) / 864e5)) : null,
    inPlan: planModules.includes(g.module_key),
    addonPriceEur: (cfg.MODULES[g.module_key] || {}).addonPriceEur || null,
  }));
}

function accountInfo(tenant) {
  const plan = cfg.PLANS[tenant.plan] || null;
  const trialEnds = tenant.trial_ends_at ? new Date(tenant.trial_ends_at).getTime() : 0;
  const sub = dbm.getActiveSubscription(tenant.id);
  return {
    subscription: sub ? { plan: sub.plan, priceEur: sub.price_eur, since: sub.created_at, payMethod: (JSON.parse(sub.billing_json || '{}').payMethod) || 'invoice' } : null,
    id: tenant.id, name: tenant.name, plan: tenant.plan,
    planLabel: plan ? plan.label : tenant.plan,
    modules: effectiveModules(tenant),
    moduleStates: moduleStates(tenant),
    moduleCatalog: cfg.MODULES,
    grants: grantInfo(tenant),
    pricing: pricingInfo(tenant),
    sellableModules: cfg.SELLABLE_MODULES,
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
    if (!rateLimit('login:' + clientIp(req), cfg.LOGIN_IP_LIMIT, 900e3) || !rateLimit('login:' + email, 10, 900e3)) {
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

  // KAUFABSCHLUSS: Tarif + Rechnungsdaten + AGB-Zustimmung → aktives Abo.
  // Zahlweise V1: Kauf auf Rechnung (B2B-üblich) oder SEPA (Mandat folgt);
  // automatische Abbuchung via Stripe dockt am Webhook unten an.
  if (pathname === '/api/billing/checkout' && m === 'POST') {
    const ctx = requireAuth(req, res); if (!ctx) return;
    if (!requireRole(ctx, res, ['owner'])) return;
    const b = await readJson(req, 32e3);
    const plan = String(b.plan || '');
    if (!cfg.PLANS[plan] || plan === 'TRIAL') return err(res, 400, 'invalid-plan');
    if (b.acceptTerms !== true) return err(res, 400, 'terms-required', { hint: 'Bitte AGB und AV-Vertrag zustimmen.' });
    const bill = b.billing || {};
    const billing = {
      company: String(bill.company || ctx.tenant.name).trim().slice(0, 160),
      address: String(bill.address || '').trim().slice(0, 200),
      zip: String(bill.zip || '').trim().slice(0, 12),
      city: String(bill.city || '').trim().slice(0, 80),
      ustId: String(bill.ustId || '').trim().slice(0, 32),
      email: normEmail(bill.email || ctx.user.email || ''),
      payMethod: bill.payMethod === 'sepa' ? 'sepa' : 'invoice',
    };
    if (billing.company.length < 2) return err(res, 400, 'invalid-company');
    if (!billing.address || !billing.zip || !billing.city) return err(res, 400, 'address-required');
    if (!isEmail(billing.email)) return err(res, 400, 'invalid-email');

    // Preis nach Modul×MA-Matrix (für die Module des Tarifs); Fallback Tarifpreis.
    const planModules = (cfg.PLANS[plan].modules || []).filter((k) => cfg.SELLABLE_MODULES.includes(k));
    const amountEur = cfg.modulePrice(planModules.length, tenantEmployees(ctx.tenant)) || cfg.PLANS[plan].priceEur;

    // Mit Stripe: echte Zahlung über gehostete Checkout-Seite (Karte + SEPA).
    // Freischaltung erst nach bestätigter Zahlung (Webhook checkout.session.completed).
    if (stripe.isConfigured()) {
      try {
        const ids = stripeIds(ctx.tenant);
        const session = await stripe.createCheckoutSession({
          amountEur,
          productName: 'werkflow ' + plan + ' (' + planModules.length + ' Module)',
          tenantId: ctx.tenant.id,
          customerId: ids.customerId || undefined,
          customerEmail: ids.customerId ? undefined : billing.email,
          successUrl: baseUrl(req) + '/app?checkout=success',
          cancelUrl: baseUrl(req) + '/app?checkout=cancel',
          metadata: { kind: 'plan', plan: plan },
        });
        // Rechnungsdaten für den Webhook zwischenspeichern (nicht in Stripe-Metadata).
        dbm.setTenantSetting(ctx.tenant.id, 'pendingCheckout', { kind: 'plan', plan, billing, sessionId: session.id, amountEur });
        dbm.audit(ctx.tenant.id, ctx.user.id, 'billing.checkout-started', { plan, amountEur, provider: 'stripe', sessionId: session.id });
        return send(res, 200, { ok: true, checkoutUrl: session.url, provider: 'stripe' });
      } catch (e) {
        return err(res, 502, 'stripe-error', { hint: 'Zahlungsanbieter nicht erreichbar: ' + (e.message || 'unbekannt') });
      }
    }

    // Ohne Stripe: Kauf auf Rechnung / SEPA-Mandat per E-Mail (manueller Einzug).
    const subId = dbm.createSubscription({
      tenantId: ctx.tenant.id, plan, priceEur: cfg.PLANS[plan].priceEur,
      billing, source: 'website', createdBy: ctx.user.id,
    });
    dbm.setTenantPlan(ctx.tenant.id, plan);
    dbm.setTenantStatus(ctx.tenant.id, 'active', null);
    dbm.audit(ctx.tenant.id, ctx.user.id, 'billing.checkout', {
      subId, plan, priceEur: cfg.PLANS[plan].priceEur, payMethod: billing.payMethod, termsAccepted: true, ip: clientIp(req),
    });
    return send(res, 201, {
      ok: true, subscriptionId: subId,
      tenant: accountInfo(dbm.getTenant(ctx.tenant.id)),
      hint: billing.payMethod === 'sepa'
        ? 'Abo aktiv. Das SEPA-Mandat senden wir dir per E-Mail zu.'
        : 'Abo aktiv. Du erhältst eine Rechnung per E-Mail — zahlbar innerhalb 14 Tagen.',
    });
  }

  if (pathname === '/api/billing/subscription' && m === 'GET') {
    const ctx = requireAuth(req, res); if (!ctx) return;
    if (!requireRole(ctx, res, ['owner'])) return;
    const sub = dbm.getActiveSubscription(ctx.tenant.id);
    return send(res, 200, { subscription: sub ? Object.assign({}, sub, { billing_json: undefined, billing: JSON.parse(sub.billing_json || '{}') }) : null });
  }

  // Kündigung: Abo endet, Betrieb fällt auf Lese-Zugriff zurück (Export bleibt!)
  if (pathname === '/api/billing/cancel' && m === 'POST') {
    const ctx = requireAuth(req, res); if (!ctx) return;
    if (!requireRole(ctx, res, ['owner'])) return;
    const b = await readJson(req, 16e3);
    if (!ctx.user.pass_hash || !verifyPassword(b.password, ctx.user.pass_hash)) return err(res, 401, 'password-required');
    dbm.cancelSubscription(ctx.tenant.id);
    dbm.setTenantPlan(ctx.tenant.id, 'TRIAL'); // abgelaufene Testphase = Lesemodus
    dbm.audit(ctx.tenant.id, ctx.user.id, 'billing.cancelled', {});
    return send(res, 200, { ok: true, hint: 'Abo gekündigt. Lesen und Datenexport bleiben jederzeit möglich.' });
  }

  // Add-on-Modul KAUFEN: aus einem laufenden Trial (oder direkt) wird ein
  // dauerhafter Grant. Nur sinnvoll für Module, die NICHT schon im Tarif sind.
  // Preis-Auskunft für Self-Service-Upsell: Was kostet es, EIN Modul dazuzubuchen?
  // Body: { module, employees? }. Aktualisiert optional die Mitarbeiterzahl
  // (Staffel) und liefert Mehrpreis + neuen Paketpreis — ohne etwas zu kaufen.
  if (pathname === '/api/billing/module-quote' && m === 'POST') {
    const ctx = requireAuth(req, res); if (!ctx) return;
    const b = await readJson(req, 16e3);
    if (b.employees != null && Number(b.employees) >= 1) {
      dbm.setTenantSetting(ctx.tenant.id, 'employeeCount', Math.floor(Number(b.employees)));
    }
    const tenant = dbm.getTenant(ctx.tenant.id);
    const key = String(b.module || '');
    const mod = cfg.MODULES[key];
    if (!mod) return err(res, 400, 'invalid-module');
    const pr = pricingInfo(tenant);
    const owned = pr.activeModules.includes(key);
    const up = pr.upsell[key] || { addEur: 0, newTotalEur: pr.monthlyEur, newCount: pr.moduleCount };
    return send(res, 200, {
      module: key, label: mod.label, sellable: cfg.SELLABLE_MODULES.includes(key),
      owned, employees: pr.employees, tier: pr.tier, tierLabel: pr.tierLabel,
      currentCount: pr.moduleCount, currentMonthlyEur: pr.monthlyEur,
      addEur: up.addEur, newCount: up.newCount, newMonthlyEur: up.newTotalEur,
    });
  }

  if (pathname === '/api/billing/buy-module' && m === 'POST') {
    const ctx = requireAuth(req, res); if (!ctx) return;
    if (!requireRole(ctx, res, ['owner'])) return;
    if (!requireWritable(ctx, res, cfg.PLANS)) return;
    const b = await readJson(req, 16e3);
    const key = String(b.module || '');
    const mod = cfg.MODULES[key];
    if (!mod) return err(res, 400, 'invalid-module');
    if ((cfg.PLANS[ctx.tenant.plan] || {}).modules.includes(key)) return err(res, 409, 'already-in-plan');
    if (b.acceptTerms !== true) return err(res, 400, 'terms-required');
    // Mitarbeiterzahl (Staffel) ggf. aktualisieren, bevor der Paketpreis fixiert wird.
    if (b.employees != null && Number(b.employees) >= 1) {
      dbm.setTenantSetting(ctx.tenant.id, 'employeeCount', Math.floor(Number(b.employees)));
    }
    const before = pricingInfo(dbm.getTenant(ctx.tenant.id));
    // Verkaufbare Module: Paketpreis (Mehrpreis + neuer Gesamtpreis). Legacy-Module: Einzel-Add-on.
    const sellable = cfg.SELLABLE_MODULES.includes(key);
    const up = before.upsell[key];
    const addEur = sellable && up ? up.addEur : (mod.addonPriceEur || 0);
    const newTotalEur = sellable && up ? up.newTotalEur : (before.monthlyEur + addEur);

    // Mit Stripe: echte Zahlung.
    if (stripe.isConfigured()) {
      const ids = stripeIds(ctx.tenant);
      if (ids.subscriptionId) {
        // Bestehendes Abo → Modul sofort freischalten und die Subscription
        // anteilig (Proration) auf den neuen Paketpreis heben.
        dbm.grantModule({ tenantId: ctx.tenant.id, moduleKey: key, status: 'active', priceEur: addEur, createdBy: ctx.user.id, note: 'gekauft' });
        const after = pricingInfo(dbm.getTenant(ctx.tenant.id));
        try {
          await stripe.updateSubscriptionPrice({
            subscriptionId: ids.subscriptionId,
            amountEur: after.monthlyEur,
            productName: 'werkflow — ' + after.moduleCount + ' Module (' + after.tierLabel + ')',
          });
        } catch (e) {
          // Zahlungs-Update fehlgeschlagen → Freischaltung zurücknehmen, sauber melden.
          dbm.revokeGrant(ctx.tenant.id, key);
          return err(res, 502, 'stripe-error', { hint: 'Freischaltung abgebrochen: ' + (e.message || 'Zahlungsanbieter-Fehler') });
        }
        dbm.audit(ctx.tenant.id, ctx.user.id, 'module.purchased', { module: key, addEur, newMonthlyEur: after.monthlyEur, moduleCount: after.moduleCount, provider: 'stripe', proration: true, termsAccepted: true });
        return send(res, 201, {
          ok: true, tenant: accountInfo(dbm.getTenant(ctx.tenant.id)), addEur, newMonthlyEur: after.monthlyEur,
          hint: mod.label + ' freigeschaltet — neuer Paketpreis ' + after.monthlyEur + ' €/Monat (anteilig über Stripe berechnet).',
        });
      }
      // Noch kein Abo → einmalig über die Stripe-Checkout-Seite bezahlen;
      // Freischaltung erst nach bestätigter Zahlung (Webhook).
      try {
        const session = await stripe.createCheckoutSession({
          amountEur: newTotalEur,
          productName: 'werkflow — ' + (before.moduleCount + 1) + ' Module (' + before.tierLabel + ')',
          tenantId: ctx.tenant.id,
          customerId: ids.customerId || undefined,
          customerEmail: ids.customerId ? undefined : (ctx.user.email || undefined),
          successUrl: baseUrl(req) + '/app?checkout=success',
          cancelUrl: baseUrl(req) + '/app?checkout=cancel',
          metadata: { kind: 'module', module: key },
        });
        dbm.setTenantSetting(ctx.tenant.id, 'pendingCheckout', { kind: 'module', module: key, sessionId: session.id, addEur, newTotalEur });
        dbm.audit(ctx.tenant.id, ctx.user.id, 'module.checkout-started', { module: key, newMonthlyEur: newTotalEur, provider: 'stripe', sessionId: session.id });
        return send(res, 200, { ok: true, checkoutUrl: session.url, provider: 'stripe', addEur, newMonthlyEur: newTotalEur });
      } catch (e) {
        return err(res, 502, 'stripe-error', { hint: 'Zahlungsanbieter nicht erreichbar: ' + (e.message || 'unbekannt') });
      }
    }

    // Ohne Stripe: sofort freischalten, Abrechnung auf Rechnung.
    dbm.grantModule({ tenantId: ctx.tenant.id, moduleKey: key, status: 'active', priceEur: addEur, createdBy: ctx.user.id, note: 'gekauft' });
    const after = pricingInfo(dbm.getTenant(ctx.tenant.id));
    dbm.audit(ctx.tenant.id, ctx.user.id, 'module.purchased', { module: key, addEur, newMonthlyEur: after.monthlyEur, moduleCount: after.moduleCount, termsAccepted: true });
    const hint = sellable
      ? mod.label + ' freigeschaltet — neuer Paketpreis ' + after.monthlyEur + ' €/Monat (' + after.moduleCount + ' Module, ' + after.tierLabel + ', auf Rechnung).'
      : mod.label + ' dauerhaft freigeschaltet (+' + addEur + ' €/Monat, auf Rechnung).';
    return send(res, 201, { ok: true, tenant: accountInfo(dbm.getTenant(ctx.tenant.id)), addEur, newMonthlyEur: after.monthlyEur, hint });
  }

  // Stripe-Webhook: bestätigt Zahlungen und schaltet frei. Signaturgeprüft.
  if (pathname === '/api/billing/webhook' && m === 'POST') {
    const raw = await readBody(req, 1e6);
    // Ohne konfiguriertes Webhook-Secret bleibt es ein No-Op-Andockpunkt.
    if (!cfg.STRIPE_WEBHOOK_SECRET) return send(res, 200, { received: true, ignored: 'no-webhook-secret' });
    let event;
    try {
      event = stripe.verifyWebhook(raw, req.headers['stripe-signature']);
    } catch (e) {
      return err(res, 400, 'invalid-signature', { hint: e.message });
    }
    try {
      handleStripeEvent(event);
    } catch (e) {
      // Verarbeitungsfehler protokollieren, aber 200 geben (Stripe re-queued sonst endlos).
      try { dbm.audit('platform', 'stripe', 'webhook.error', { type: event && event.type, error: String(e && e.message) }); } catch (_e) {}
    }
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

  // KI liest einen fotografierten Lieferschein → strukturierte Positionen
  // (Human-in-the-Loop: die App zeigt das Ergebnis zur Korrektur, bevor gebucht wird).
  // Ohne KI-Key: { configured:false } → App fällt auf manuelle Erfassung zurück.
  if (pathname === '/api/t/ai/delivery-note' && m === 'POST') {
    const ctx = requireAuth(req, res); if (!ctx) return;
    if (!requireWritable(ctx, res, cfg.PLANS)) return;
    if (!moduleAllowed(ctx.tenant, 'einkauf')) return err(res, 403, 'module-not-active', { module: 'einkauf' });
    if (!ai.isConfigured()) return send(res, 200, { configured: false, hint: 'KI-Beleglesen ist nicht aktiviert — bitte Positionen manuell erfassen (Foto bleibt als Beleg gespeichert).' });
    const buf = await readBody(req, cfg.MAX_AI_IMAGE_BYTES + 1024);
    const ctype = req.headers['content-type'] || 'image/jpeg';
    const result = await ai.extractDeliveryNote(buf, ctype.split(';')[0]);
    dbm.audit(ctx.tenant.id, ctx.user.id, 'ai.delivery-note', { ok: !!result.ok, positions: result.data ? (result.data.positions || []).length : 0 });
    return send(res, 200, result);
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

  // ---------- VERTRIEBS-ANGEBOTE (Betreiber → beratener Interessent) ----------
  // Öffentlich: Interessent ruft sein persönliches Abo-Angebot auf.
  const soGet = pathname.match(/^\/api\/public\/sales-offer\/([A-Za-z0-9_-]{20,})$/);
  if (soGet && m === 'GET') {
    if (!rateLimit('soget:' + clientIp(req), 60, 900e3)) return err(res, 429, 'rate-limited');
    const o = dbm.findSalesOfferByToken(sha256(soGet[1]));
    if (!o || o.status === 'revoked') return err(res, 404, 'not-found');
    const plan = cfg.PLANS[o.plan] || {};
    return send(res, 200, {
      company: o.company, contactName: o.contact_name, plan: o.plan,
      planLabel: plan.label, listPriceEur: plan.priceEur, priceEur: o.price_eur,
      modules: (plan.modules || []).map((k) => (cfg.MODULES[k] || {}).label || k),
      maxEmployees: plan.maxEmployees, storageGb: plan.storageGb,
      message: o.message, validUntil: o.valid_until, status: o.status,
      expired: new Date(o.valid_until).getTime() < Date.now(),
    });
  }

  // Öffentlich: Angebot verbindlich annehmen → Betrieb + aktives Abo entstehen.
  const soAccept = pathname.match(/^\/api\/public\/sales-offer\/([A-Za-z0-9_-]{20,})\/accept$/);
  if (soAccept && m === 'POST') {
    if (!rateLimit('soacc:' + clientIp(req), 10, 900e3)) return err(res, 429, 'rate-limited');
    const b = await readJson(req, 32e3);
    const o = dbm.findSalesOfferByToken(sha256(soAccept[1]));
    if (!o || o.status === 'revoked') return err(res, 404, 'not-found');
    if (o.status !== 'open') return err(res, 409, 'already-accepted');
    if (new Date(o.valid_until).getTime() < Date.now()) return err(res, 410, 'offer-expired');
    if (b.consent !== true || b.acceptTerms !== true) return err(res, 400, 'consent-required');
    const password = String(b.password || '');
    if (password.length < 10) return err(res, 400, 'password-too-short');
    const name = String(b.name || o.contact_name || 'Inhaber').trim().slice(0, 120);
    if (dbm.getUserByEmail(o.email)) return err(res, 409, 'email-exists', { hint: 'Für diese E-Mail existiert bereits ein Zugang — bitte anmelden, wir schalten den Tarif dann um.' });
    const tenant = dbm.createTenant({ name: o.company, trialEndsAt: null });
    const user = dbm.createUser({ tenantId: tenant.id, email: o.email, name, role: 'owner', passHash: hashPassword(password) });
    dbm.createSubscription({ tenantId: tenant.id, plan: o.plan, priceEur: o.price_eur, billing: { company: o.company, email: o.email, payMethod: 'invoice' }, source: 'sales_offer', createdBy: 'sales-offer:' + o.id });
    dbm.setTenantPlan(tenant.id, o.plan);
    dbm.acceptSalesOffer(o.id, tenant.id);
    dbm.createLead({ name, company: o.company, email: o.email, phone: o.phone, message: 'Vertriebs-Angebot angenommen (' + o.plan + ', ' + o.price_eur + ' €)', consentIp: clientIp(req), source: 'sales-offer', tenantId: tenant.id });
    dbm.audit(tenant.id, user.id, 'tenant.created', { source: 'sales-offer', offerId: o.id, plan: o.plan, priceEur: o.price_eur, termsAccepted: true, ip: clientIp(req) });
    dbm.touchLogin(user.id);
    // Tenant frisch laden — der Tarif wurde soeben gesetzt
    return send(res, 201, issueSession(user, dbm.getTenant(tenant.id), req));
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
    // Plattform-Übersicht: KPIs für die Admin-Zentrale
    if (pathname === '/api/admin/overview' && m === 'GET') {
      return send(res, 200, { stats: dbm.platformStats(), plans: cfg.PLANS, moduleCatalog: cfg.MODULES });
    }

    if (pathname === '/api/admin/tenants' && m === 'GET') {
      const tenants = dbm.listTenants().map((t) => {
        const sub = dbm.getActiveSubscription(t.id);
        return Object.assign({}, t, {
          effective_modules: effectiveModules(t),
          module_states: moduleStates(t),
          module_overrides: dbm.getTenantSettings(t.id).moduleOverrides || {},
          grants: grantInfo(t),
          subscription: sub ? { plan: sub.plan, price_eur: sub.price_eur, source: sub.source, since: sub.created_at, billing: JSON.parse(sub.billing_json || '{}') } : null,
          storage_bytes: dbm.tenantStorageBytes(t.id),
        });
      });
      return send(res, 200, { tenants, plans: cfg.PLANS, moduleCatalog: cfg.MODULES });
    }

    // Mandanten-Detail: Nutzer, Abo, letzte Aktivitäten
    const tDetail = pathname.match(/^\/api\/admin\/tenants\/([^/]+)$/);
    if (tDetail && m === 'GET') {
      const t = dbm.getTenant(tDetail[1]);
      if (!t) return err(res, 404, 'not-found');
      const sub = dbm.getActiveSubscription(t.id);
      return send(res, 200, {
        tenant: Object.assign({}, t, { effective_modules: effectiveModules(t) }),
        users: dbm.listUsers(t.id),
        subscription: sub ? Object.assign({}, sub, { billing_json: undefined, billing: JSON.parse(sub.billing_json || '{}') }) : null,
        storageBytes: dbm.tenantStorageBytes(t.id),
        revisions: dbm.listRevisions(t.id, 5),
        recentAudit: dbm.auditList(t.id, 20, Math.max(0, dbm.auditVerify(t.id).entries - 20)),
      });
    }

    // Testphase verlängern (Sales-Werkzeug)
    const tTrial = pathname.match(/^\/api\/admin\/tenants\/([^/]+)\/trial$/);
    if (tTrial && m === 'POST') {
      const b = await readJson(req, 16e3);
      const t = dbm.getTenant(tTrial[1]);
      if (!t) return err(res, 404, 'not-found');
      const days = Math.min(Math.max(Number(b.days) || 14, 1), 90);
      const base = Math.max(Date.now(), t.trial_ends_at ? new Date(t.trial_ends_at).getTime() : 0);
      const until = new Date(base + days * 864e5).toISOString();
      dbm.db.prepare('UPDATE tenants SET trial_ends_at = ? WHERE id = ?').run(until, t.id);
      dbm.audit(t.id, 'platform-admin', 'trial.extended', { days, until });
      return send(res, 200, { ok: true, trialEndsAt: until });
    }

    // Sperren/Entsperren (z. B. bei Zahlungsverzug) — Lesen + Export bleiben möglich
    const tStatus = pathname.match(/^\/api\/admin\/tenants\/([^/]+)\/status$/);
    if (tStatus && m === 'POST') {
      const b = await readJson(req, 16e3);
      const t = dbm.getTenant(tStatus[1]);
      if (!t || t.status === 'deleted') return err(res, 404, 'not-found');
      if (!['active', 'suspended'].includes(b.status)) return err(res, 400, 'invalid-status');
      dbm.setTenantStatus(t.id, b.status, b.status === 'active' ? null : t.delete_after);
      dbm.audit(t.id, 'platform-admin', 'tenant.' + (b.status === 'active' ? 'reactivated' : 'suspended'), {});
      return send(res, 200, { ok: true });
    }

    // Vertriebs-Angebote verwalten
    if (pathname === '/api/admin/sales-offers' && m === 'GET') {
      return send(res, 200, { offers: dbm.listSalesOffers() });
    }
    if (pathname === '/api/admin/sales-offers' && m === 'POST') {
      const b = await readJson(req, 32e3);
      const email = normEmail(b.email);
      if (!isEmail(email)) return err(res, 400, 'invalid-email');
      if (String(b.company || '').trim().length < 2) return err(res, 400, 'invalid-company');
      if (!cfg.PLANS[b.plan] || b.plan === 'TRIAL') return err(res, 400, 'invalid-plan');
      const priceEur = b.priceEur != null ? Number(b.priceEur) : cfg.PLANS[b.plan].priceEur;
      if (!(priceEur >= 0 && priceEur <= 999)) return err(res, 400, 'invalid-price');
      const { token, hash } = opaqueToken();
      const validUntil = new Date(Date.now() + Math.min(Math.max(Number(b.days) || 14, 1), 90) * 864e5).toISOString();
      const oid = dbm.createSalesOffer({
        tokenHash: hash, company: String(b.company).trim().slice(0, 160),
        contactName: String(b.contactName || '').trim().slice(0, 120) || null,
        email, phone: String(b.phone || '').trim().slice(0, 60) || null,
        plan: b.plan, priceEur, message: String(b.message || '').slice(0, 2000) || null, validUntil,
      });
      return send(res, 201, { offerId: oid, url: baseUrl(req) + '/abo#' + token, validUntil, priceEur });
    }
    const soRevoke = pathname.match(/^\/api\/admin\/sales-offers\/([^/]+)\/revoke$/);
    if (soRevoke && m === 'POST') { dbm.revokeSalesOffer(soRevoke[1]); return send(res, 200, { ok: true }); }

    // Modul-Trial gewähren (Host stellt Zusatzmodul für Zeitraum kostenlos frei)
    const grMatch = pathname.match(/^\/api\/admin\/tenants\/([^/]+)\/grant$/);
    if (grMatch && m === 'POST') {
      const b = await readJson(req, 16e3);
      const t = dbm.getTenant(grMatch[1]);
      if (!t) return err(res, 404, 'not-found');
      if (!cfg.MODULES[b.module]) return err(res, 400, 'invalid-module');
      const status = b.status === 'active' ? 'active' : 'trial';
      const g = dbm.grantModule({
        tenantId: t.id, moduleKey: b.module, status,
        priceEur: status === 'active' ? cfg.MODULES[b.module].addonPriceEur : null,
        days: b.days, createdBy: 'platform-admin', note: b.note || 'Host-Trial',
      });
      dbm.audit(t.id, 'platform-admin', 'module.granted', { module: b.module, status, days: b.days, expiresAt: g.expiresAt });
      return send(res, 201, { ok: true, expiresAt: g.expiresAt, effective_modules: effectiveModules(dbm.getTenant(t.id)) });
    }
    const grRevoke = pathname.match(/^\/api\/admin\/tenants\/([^/]+)\/grant\/([^/]+)$/);
    if (grRevoke && m === 'DELETE') {
      dbm.revokeGrant(grRevoke[1], grRevoke[2]);
      dbm.audit(grRevoke[1], 'platform-admin', 'module.grant-revoked', { module: grRevoke[2] });
      return send(res, 200, { ok: true });
    }
    // Host schaltet Module pro Mandant frei/sperrt/blendet aus (Tri-State, unabhängig vom Tarif).
    // Body: { overrides: { key: 'on'|'locked'|'off' } }  ODER  { module, state }.
    const modMatch = pathname.match(/^\/api\/admin\/tenants\/([^/]+)\/modules$/);
    if (modMatch && m === 'POST') {
      const b = await readJson(req, 16e3);
      const t = dbm.getTenant(modMatch[1]);
      if (!t) return err(res, 404, 'not-found');
      const cur = Object.assign({}, dbm.getTenantSettings(t.id).moduleOverrides || {});
      const norm = (v) => (v === true ? 'on' : v === false ? 'off' : (['on', 'locked', 'off'].includes(v) ? v : null));
      const apply = (k, v) => {
        if (!cfg.MODULES[k]) return;
        const s = norm(v);
        if (s === null || s === 'default') delete cur[k]; // 'default' entfernt Override → Standard (locked bzw. Tarif)
        else cur[k] = s;
      };
      if (b.module) apply(b.module, b.state);
      for (const [k, v] of Object.entries(b.overrides || {})) apply(k, v);
      dbm.setTenantModuleOverrides(t.id, cur);
      dbm.audit(t.id, 'platform-admin', 'modules.overridden', { overrides: cur });
      const tn = dbm.getTenant(t.id);
      return send(res, 200, { ok: true, effective_modules: effectiveModules(tn), module_states: moduleStates(tn) });
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

  // ==========================================================================
  // Schnittstellen & Buchhaltung + Website-Generator
  // ==========================================================================
  const integ = await handleIntegrations(req, res, pathname, m);
  if (integ !== undefined) return integ;

  return err(res, 404, 'not-found');
}

// Basis-URL des Requests (für Hook-/Webhook-Rücksprung-Links)
function reqBaseUrl(req) {
  if (cfg.BASE_URL) return cfg.BASE_URL.replace(/\/$/, '');
  const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0];
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost';
  return proto + '://' + host;
}
function accountingAllowed(tenant) { return moduleAllowed(tenant, 'buchhaltung'); }

// Liefert undefined, wenn keine Integrations-Route passt (→ Aufrufer macht 404).
async function handleIntegrations(req, res, pathname, m) {
  // ---- Öffentliche Website-Auslieferung: /api/public/site/<slug>[/<page>] ----
  const siteView = pathname.match(/^\/api\/public\/site\/([a-z0-9-]{2,64})(?:\/([a-z0-9-]+\.(?:html|xml|txt)))?$/);
  if (siteView && m === 'GET') {
    if (!rateLimit('site:' + clientIp(req), 300, 900e3)) return err(res, 429, 'rate-limited');
    const site = dbm.findPublishedSite(siteView[1]);
    if (!site) return err(res, 404, 'not-found');
    const page = siteView[2] || 'index.html';
    if (page === 'sitemap.xml') return send(res, 200, site.pages['sitemap.xml'] || '', { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=300' });
    if (page === 'robots.txt') return send(res, 200, site.pages['robots.txt'] || 'User-agent: *\nAllow: /\n', { 'Content-Type': 'text/plain; charset=utf-8' });
    const html = site.pages[page];
    if (html == null) return err(res, 404, 'not-found');
    return send(res, 200, html, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=300' });
  }

  // ---- Eingehende Webhooks (kein Login; Signatur + gehashtes Inbox-Token) ----
  const inboundInv = pathname.match(/^\/api\/public\/inbound\/invoice\/([A-Za-z0-9_-]{16,})$/);
  if (inboundInv && m === 'POST') {
    if (!rateLimit('inb:' + clientIp(req), 120, 900e3)) return err(res, 429, 'rate-limited');
    if (!cfg.INBOUND_WEBHOOK_SECRET || req.headers['x-werkflow-signature'] !== cfg.INBOUND_WEBHOOK_SECRET) return err(res, 401, 'bad-signature');
    const owner = dbm.findTenantByInboxToken('invoice_inbox', sha256(inboundInv[1]));
    if (!owner) return err(res, 404, 'unknown-inbox');
    const buf = await readBody(req, cfg.MAX_FILE_BYTES + 1024);
    const ctype = (req.headers['content-type'] || '').split(';')[0];
    let parsed = einvoice.parseEInvoice(buf, ctype);
    let via = parsed.ok ? parsed.format : 'ki';
    let data = parsed.ok ? parsed.data : null;
    if (!parsed.ok && ai.isConfigured()) {
      const r = await ai.extractIncomingInvoice(buf, ctype || 'application/pdf');
      if (r.ok) data = r.data;
    }
    const iid = dbm.addInboxItem({ tenantId: owner.tenant_id, kind: 'invoice', source: 'email', payload: { via, data, ok: !!data } });
    // Weiterleitung an Steuerberater, falls konfiguriert
    const stb = safeParse(dbm.getIntegration(owner.tenant_id, 'invoice_inbox') || {}).forwardTo;
    if (stb && mail.isConfigured()) {
      const r = await mail.sendMail({ to: stb, subject: 'Eingangsrechnung' + (data && data.invoiceNumber ? ' ' + data.invoiceNumber : ''), text: 'Automatische Weiterleitung durch werkflow.', attachments: [{ filename: 'rechnung' + (ctype.includes('pdf') ? '.pdf' : '.xml'), contentType: ctype || 'application/octet-stream', content: buf }] });
      dbm.logMail({ tenantId: owner.tenant_id, recipient: stb, subject: 'Eingangsrechnung-Weiterleitung', kind: 'stb-forward', status: r.ok ? 'sent' : 'failed', error: r.ok ? '' : r.error });
    }
    return send(res, 200, { ok: true, inboxId: iid, parsed: !!data });
  }
  const inboundIds = pathname.match(/^\/api\/public\/ids\/return\/([A-Za-z0-9_-]{16,})$/);
  if (inboundIds && m === 'POST') {
    if (!rateLimit('idsr:' + clientIp(req), 120, 900e3)) return err(res, 429, 'rate-limited');
    const owner = dbm.findTenantByInboxToken('ids', sha256(inboundIds[1]));
    if (!owner) return err(res, 404, 'unknown-inbox');
    const buf = await readBody(req, 2e6);
    const ctype = req.headers['content-type'] || '';
    const basket = ids.parseBasketReturn(buf.toString('utf8'), ctype);
    const iid = dbm.addInboxItem({ tenantId: owner.tenant_id, kind: 'order', source: 'ids', payload: basket });
    return send(res, 200, { ok: true, inboxId: iid, positions: basket.count });
  }
  const inboundBank = pathname.match(/^\/api\/public\/bank\/push\/([A-Za-z0-9_-]{16,})$/);
  if (inboundBank && m === 'POST') {
    if (!rateLimit('bankp:' + clientIp(req), 120, 900e3)) return err(res, 429, 'rate-limited');
    if (!cfg.INBOUND_WEBHOOK_SECRET || req.headers['x-werkflow-signature'] !== cfg.INBOUND_WEBHOOK_SECRET) return err(res, 401, 'bad-signature');
    const owner = dbm.findTenantByInboxToken('bank', sha256(inboundBank[1]));
    if (!owner) return err(res, 404, 'unknown-inbox');
    const b = await readJson(req, 4e6);
    const txs = Array.isArray(b.transactions) ? b.transactions : [];
    const iid = dbm.addInboxItem({ tenantId: owner.tenant_id, kind: 'bank-tx', source: 'psd2', payload: { transactions: txs } });
    return send(res, 200, { ok: true, inboxId: iid, count: txs.length });
  }

  // ---- Öffentlicher iCal-Feed (abonnierbar in Google/Apple/Outlook) ----
  const icalFeed = pathname.match(/^\/api\/public\/ical\/([A-Za-z0-9_-]{16,})\.ics$/);
  if (icalFeed && m === 'GET') {
    if (!rateLimit('ical:' + clientIp(req), 300, 900e3)) return err(res, 429, 'rate-limited');
    const owner = dbm.findTenantByInboxToken('ical', sha256(icalFeed[1]));
    if (!owner) return err(res, 404, 'not-found');
    const conf = safeParse(owner);
    const ics = ical.buildICal(conf.events || [], { name: conf.name || 'werkflow Kalender' });
    return send(res, 200, ics, { 'Content-Type': 'text/calendar; charset=utf-8', 'Cache-Control': 'public, max-age=300' });
  }

  // ---- Ab hier: authentifizierte Mandanten-Endpunkte ----
  if (!pathname.startsWith('/api/t/')) return undefined;

  // Integrations-Übersicht & Konfiguration
  if (pathname === '/api/t/integrations' && m === 'GET') {
    const ctx = requireAuth(req, res); if (!ctx) return null;
    if (!accountingAllowed(ctx.tenant) && !moduleAllowed(ctx.tenant, 'website')) return err(res, 403, 'module-not-active', { module: 'buchhaltung' });
    const conns = dbm.listIntegrations(ctx.tenant.id).map((c) => ({ kind: c.kind, config: redact(safeParse(c)), hasInbox: !!c.inbox_token_hash, status: c.status, updatedAt: c.updated_at }));
    return send(res, 200, { integrations: conns, inboxCount: dbm.listInbox(ctx.tenant.id, 'new').length, mailConfigured: mail.isConfigured(), aiConfigured: ai.isConfigured() });
  }
  const integSet = pathname.match(/^\/api\/t\/integrations\/([a-z_]+)$/);
  if (integSet && m === 'PUT') {
    const ctx = requireAuth(req, res); if (!ctx) return null;
    if (!requireWritable(ctx, res, cfg.PLANS)) return null;
    if (!accountingAllowed(ctx.tenant)) return err(res, 403, 'module-not-active', { module: 'buchhaltung' });
    const kind = integSet[1];
    const b = await readJson(req, 32e3);
    let tokenHash; let address;
    if (b.regenerateInboxToken || (['invoice_inbox', 'ids', 'bank'].includes(kind) && !(dbm.getIntegration(ctx.tenant.id, kind) || {}).inbox_token_hash)) {
      const t = opaqueToken();
      tokenHash = t.hash;
      address = inboxAddressFor(kind, t.token, ctx.tenant, req);
      b._inboxTokenOnce = undefined;
    }
    const saved = dbm.setIntegration(ctx.tenant.id, kind, b.config || {}, tokenHash);
    dbm.audit(ctx.tenant.id, ctx.user.id, 'integration.configured', { kind });
    return send(res, 200, { ok: true, kind, hasInbox: !!saved.inbox_token_hash, inboxAddress: address });
  }

  // Inbox: abholen / übernehmen / verwerfen
  if (pathname === '/api/t/inbox' && m === 'GET') {
    const ctx = requireAuth(req, res); if (!ctx) return null;
    return send(res, 200, { items: dbm.listInbox(ctx.tenant.id, 'new') });
  }
  const inboxAct = pathname.match(/^\/api\/t\/inbox\/([^/]+)\/(import|dismiss)$/);
  if (inboxAct && m === 'POST') {
    const ctx = requireAuth(req, res); if (!ctx) return null;
    if (!requireWritable(ctx, res, cfg.PLANS)) return null;
    const ok = dbm.setInboxStatus(ctx.tenant.id, inboxAct[1], inboxAct[2] === 'import' ? 'imported' : 'dismissed');
    return ok ? send(res, 200, { ok: true }) : err(res, 404, 'not-found');
  }

  // Katalog-Import (DATANORM/CSV)
  if (pathname === '/api/t/purchasing/catalog' && m === 'POST') {
    const ctx = requireAuth(req, res); if (!ctx) return null;
    if (!requireWritable(ctx, res, cfg.PLANS)) return null;
    if (!moduleAllowed(ctx.tenant, 'einkauf') && !accountingAllowed(ctx.tenant)) return err(res, 403, 'module-not-active', { module: 'einkauf' });
    const buf = await readBody(req, cfg.MAX_FILE_BYTES);
    const parsed = datanorm.parseCatalog(buf, req.headers['content-type'] || '');
    return send(res, 200, { ok: true, format: parsed.format, count: parsed.articles.length, articles: parsed.articles.slice(0, 5000) });
  }
  // IDS-Punchout starten
  if (pathname === '/api/t/purchasing/ids/punchout' && m === 'POST') {
    const ctx = requireAuth(req, res); if (!ctx) return null;
    if (!accountingAllowed(ctx.tenant)) return err(res, 403, 'module-not-active', { module: 'buchhaltung' });
    const conn = safeParse(dbm.getIntegration(ctx.tenant.id, 'ids') || {});
    const b = await readJson(req, 8e3);
    const connection = Object.assign({}, conn, b.connection || {});
    // Rücksprung an unseren IDS-Return-Webhook mit dem Inbox-Token des Mandanten
    const rec = dbm.getIntegration(ctx.tenant.id, 'ids');
    const hookUrl = reqBaseUrl(req) + '/api/public/ids/return/' + (b.hookToken || 'CONFIGURE-TOKEN');
    return send(res, 200, ids.buildPunchout(connection, { hookUrl }));
  }
  // UGL-Bestelldatei erzeugen
  if (pathname === '/api/t/purchasing/ugl' && m === 'POST') {
    const ctx = requireAuth(req, res); if (!ctx) return null;
    if (!accountingAllowed(ctx.tenant)) return err(res, 403, 'module-not-active', { module: 'buchhaltung' });
    const b = await readJson(req, 512e3);
    const text = ugl.buildUglOrder(b.order || {}, b.meta || {});
    return send(res, 200, text, { 'Content-Type': 'text/plain; charset=utf-8' });
  }

  // E-Rechnung parsen (XML/PDF) – Upload
  if (pathname === '/api/t/invoices/parse' && m === 'POST') {
    const ctx = requireAuth(req, res); if (!ctx) return null;
    if (!accountingAllowed(ctx.tenant)) return err(res, 403, 'module-not-active', { module: 'buchhaltung' });
    const buf = await readBody(req, cfg.MAX_FILE_BYTES);
    const ctype = (req.headers['content-type'] || '').split(';')[0];
    let parsed = einvoice.parseEInvoice(buf, ctype);
    if (parsed.ok) return send(res, 200, { ok: true, via: parsed.format, data: parsed.data });
    if (ai.isConfigured()) {
      const r = await ai.extractIncomingInvoice(buf, ctype || 'application/pdf');
      if (r.ok) return send(res, 200, { ok: true, via: 'ki', data: r.data });
      return send(res, 200, { ok: false, via: 'ki', error: r.error || 'ki-failed' });
    }
    return send(res, 200, { ok: false, error: parsed.error || 'no-einvoice', configured: false });
  }

  // Bank: Kontoauszug importieren + Zahlungsabgleich
  if (pathname === '/api/t/bank/import' && m === 'POST') {
    const ctx = requireAuth(req, res); if (!ctx) return null;
    if (!accountingAllowed(ctx.tenant)) return err(res, 403, 'module-not-active', { module: 'buchhaltung' });
    const buf = await readBody(req, cfg.MAX_FILE_BYTES);
    const out = bankstmt.parseStatement(buf, req.headers['content-type'] || '');
    return send(res, 200, { ok: true, format: out.format, count: out.transactions.length, transactions: out.transactions });
  }
  if (pathname === '/api/t/bank/reconcile' && m === 'POST') {
    const ctx = requireAuth(req, res); if (!ctx) return null;
    if (!accountingAllowed(ctx.tenant)) return err(res, 403, 'module-not-active', { module: 'buchhaltung' });
    const b = await readJson(req, 4e6);
    return send(res, 200, reconcile(b.transactions || [], b.openItems || [], b.opts || {}));
  }

  // DATEV-Export
  if (pathname === '/api/t/datev/export' && m === 'POST') {
    const ctx = requireAuth(req, res); if (!ctx) return null;
    if (!accountingAllowed(ctx.tenant)) return err(res, 403, 'module-not-active', { module: 'buchhaltung' });
    const b = await readJson(req, 4e6);
    const bookings = b.bookings || datev.invoicesToBookings(b.items || [], b.cfg || {});
    const csv = datev.buildBuchungsstapel(bookings, b.meta || {});
    dbm.audit(ctx.tenant.id, ctx.user.id, 'datev.export', { rows: bookings.length });
    return send(res, 200, csv, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="EXTF_Buchungsstapel.csv"' });
  }

  // Lexoffice: Verbindung testen / Beleg übertragen
  if (pathname === '/api/t/lexoffice/test' && m === 'POST') {
    const ctx = requireAuth(req, res); if (!ctx) return null;
    if (!accountingAllowed(ctx.tenant)) return err(res, 403, 'module-not-active', { module: 'buchhaltung' });
    const key = (safeParse(dbm.getIntegration(ctx.tenant.id, 'lexoffice') || {}).apiKey) || '';
    return send(res, 200, await lexoffice.testConnection(key));
  }
  if (pathname === '/api/t/lexoffice/push' && m === 'POST') {
    const ctx = requireAuth(req, res); if (!ctx) return null;
    if (!requireWritable(ctx, res, cfg.PLANS)) return null;
    if (!accountingAllowed(ctx.tenant)) return err(res, 403, 'module-not-active', { module: 'buchhaltung' });
    const key = (safeParse(dbm.getIntegration(ctx.tenant.id, 'lexoffice') || {}).apiKey) || '';
    const b = await readJson(req, 256e3);
    const r = await lexoffice.pushVoucher(key, b.invoice || {}, b.kind || 'salesinvoice');
    dbm.audit(ctx.tenant.id, ctx.user.id, 'lexoffice.push', { ok: r.ok });
    return send(res, 200, r);
  }

  // E-Mail-Versand (Angebote/Rechnungen)
  if (pathname === '/api/t/mail/send' && m === 'POST') {
    const ctx = requireAuth(req, res); if (!ctx) return null;
    if (!requireWritable(ctx, res, cfg.PLANS)) return null;
    if (!moduleAllowed(ctx.tenant, 'geld') && !accountingAllowed(ctx.tenant)) return err(res, 403, 'module-not-active', { module: 'geld' });
    if (!mail.isConfigured()) return send(res, 200, { ok: false, configured: false, hint: 'E-Mail-Versand nicht konfiguriert – Link teilen als Alternative.' });
    const b = await readJson(req, cfg.MAX_MAIL_ATTACH_BYTES + 64e3);
    if (!b.to || !b.subject) return err(res, 400, 'to-and-subject-required');
    const atts = (b.attachments || []).map((a) => ({ filename: a.filename, contentType: a.contentType, content: Buffer.from(String(a.contentBase64 || ''), 'base64') }));
    const from = (safeParse(dbm.getIntegration(ctx.tenant.id, 'mail') || {}).from) || cfg.SMTP_FROM;
    const r = await mail.sendMail({ to: b.to, cc: b.cc, subject: b.subject, text: b.text || '', html: b.html, replyTo: b.replyTo || from, from, fromName: b.fromName, attachments: atts });
    dbm.logMail({ tenantId: ctx.tenant.id, recipient: Array.isArray(b.to) ? b.to.join(',') : b.to, subject: b.subject, kind: b.kind || 'mail', status: r.ok ? 'sent' : 'failed', error: r.ok ? '' : (r.error || '') });
    dbm.audit(ctx.tenant.id, ctx.user.id, 'mail.sent', { kind: b.kind || 'mail', ok: r.ok });
    return send(res, 200, r);
  }

  // ---- Website-Generator ----
  if (pathname === '/api/t/sites' && m === 'GET') {
    const ctx = requireAuth(req, res); if (!ctx) return null;
    if (!moduleAllowed(ctx.tenant, 'website')) return err(res, 403, 'module-not-active', { module: 'website' });
    return send(res, 200, { sites: dbm.listSites(ctx.tenant.id), baseUrl: reqBaseUrl(req) + '/api/public/site/' });
  }
  if (pathname === '/api/t/sites/generate' && m === 'POST') {
    const ctx = requireAuth(req, res); if (!ctx) return null;
    if (!requireWritable(ctx, res, cfg.PLANS)) return null;
    if (!moduleAllowed(ctx.tenant, 'website')) return err(res, 403, 'module-not-active', { module: 'website' });
    const b = await readJson(req, 256e3);
    const input = b.input || {};
    const biz = b.business || input;
    let aiContent = null; let aiUsed = false;
    if (ai.isConfigured() && b.useAi !== false) {
      const r = await ai.generateWebsiteContent(input);
      if (r.ok) { aiContent = r.data; aiUsed = true; }
    }
    let slug = sitegen.slugify(b.slug || biz.companyName || biz.name || 'website');
    let n = 1; while (dbm.slugTaken(slug, ctx.tenant.id)) slug = sitegen.slugify((biz.companyName || 'website')) + '-' + (++n);
    const canonical = reqBaseUrl(req) + '/api/public/site/' + slug + '/index.html';
    const rendered = sitegen.renderSite(aiContent, biz, { template: b.template || 'modern', input, canonical });
    const pages = Object.assign({}, rendered.pages, { 'sitemap.xml': rendered['sitemap.xml'], 'robots.txt': rendered['robots.txt'] });
    const siteId = dbm.upsertSite({ id: b.id || undefined, tenantId: ctx.tenant.id, slug, template: rendered.template, status: 'draft', input, content: rendered.content, pages });
    dbm.audit(ctx.tenant.id, ctx.user.id, 'site.generated', { slug, aiUsed });
    return send(res, 201, { ok: true, id: siteId, slug, template: rendered.template, aiUsed, previewUrl: reqBaseUrl(req) + '/api/public/site/' + slug + '/index.html', content: rendered.content });
  }
  const siteId = pathname.match(/^\/api\/t\/sites\/([^/]+)$/);
  if (siteId && m === 'GET') {
    const ctx = requireAuth(req, res); if (!ctx) return null;
    if (!moduleAllowed(ctx.tenant, 'website')) return err(res, 403, 'module-not-active', { module: 'website' });
    const site = dbm.getSite(ctx.tenant.id, siteId[1]);
    return site ? send(res, 200, { site }) : err(res, 404, 'not-found');
  }
  const sitePub = pathname.match(/^\/api\/t\/sites\/([^/]+)\/(publish|unpublish)$/);
  if (sitePub && m === 'POST') {
    const ctx = requireAuth(req, res); if (!ctx) return null;
    if (!requireWritable(ctx, res, cfg.PLANS)) return null;
    if (!moduleAllowed(ctx.tenant, 'website')) return err(res, 403, 'module-not-active', { module: 'website' });
    const site = dbm.getSite(ctx.tenant.id, sitePub[1]);
    if (!site) return err(res, 404, 'not-found');
    const b = await readJson(req, 8e3).catch(() => ({}));
    if (b && b.domain !== undefined) site.domain = String(b.domain || '').toLowerCase().replace(/[^a-z0-9.-]/g, '');
    site.status = sitePub[2] === 'publish' ? 'published' : 'draft';
    site.tenantId = ctx.tenant.id;
    dbm.upsertSite(site);
    dbm.audit(ctx.tenant.id, ctx.user.id, 'site.' + sitePub[2], { slug: site.slug, domain: site.domain });
    return send(res, 200, { ok: true, status: site.status, publicUrl: reqBaseUrl(req) + '/api/public/site/' + site.slug + '/index.html', domain: site.domain });
  }

  // ---- Ausgangs-E-Rechnung erzeugen (XRechnung / ZUGFeRD) ----
  if (pathname === '/api/t/invoices/emit' && m === 'POST') {
    const ctx = requireAuth(req, res); if (!ctx) return null;
    if (!moduleAllowed(ctx.tenant, 'geld') && !accountingAllowed(ctx.tenant)) return err(res, 403, 'module-not-active', { module: 'geld' });
    const b = await readJson(req, 512e3);
    const xml = b.format === 'zugferd' ? xrechnung.buildZugferdCii(b.invoice || {}, b.seller || {}, b.buyer || {}) : xrechnung.buildXRechnung(b.invoice || {}, b.seller || {}, b.buyer || {});
    const name = (b.format === 'zugferd' ? 'zugferd-' : 'xrechnung-') + ((b.invoice && b.invoice.number) || 'rechnung') + '.xml';
    return send(res, 200, xml, { 'Content-Type': 'application/xml; charset=utf-8', 'Content-Disposition': 'attachment; filename="' + name + '"' });
  }

  // ---- GAEB: LV einlesen / D84-Angebot exportieren ----
  if (pathname === '/api/t/gaeb/parse' && m === 'POST') {
    const ctx = requireAuth(req, res); if (!ctx) return null;
    if (!moduleAllowed(ctx.tenant, 'lv') && !accountingAllowed(ctx.tenant)) return err(res, 403, 'module-not-active', { module: 'lv' });
    const buf = await readBody(req, cfg.MAX_FILE_BYTES);
    return send(res, 200, gaeb.parseGaeb(buf.toString('utf8')));
  }
  if (pathname === '/api/t/gaeb/export' && m === 'POST') {
    const ctx = requireAuth(req, res); if (!ctx) return null;
    if (!moduleAllowed(ctx.tenant, 'lv') && !accountingAllowed(ctx.tenant)) return err(res, 403, 'module-not-active', { module: 'lv' });
    const b = await readJson(req, 4e6);
    const xml = gaeb.buildGaebD84(b.items || [], b.meta || {});
    return send(res, 200, xml, { 'Content-Type': 'application/xml; charset=utf-8', 'Content-Disposition': 'attachment; filename="angebot-d84.X84"' });
  }

  // ---- SEPA: Überweisung / Lastschrift ----
  if (pathname === '/api/t/sepa/credit-transfer' && m === 'POST') {
    const ctx = requireAuth(req, res); if (!ctx) return null;
    if (!accountingAllowed(ctx.tenant)) return err(res, 403, 'module-not-active', { module: 'buchhaltung' });
    const b = await readJson(req, 2e6);
    const xml = sepa.buildCreditTransfer(b);
    dbm.audit(ctx.tenant.id, ctx.user.id, 'sepa.credit-transfer', { count: (b.payments || []).length });
    return send(res, 200, xml, { 'Content-Type': 'application/xml; charset=utf-8', 'Content-Disposition': 'attachment; filename="sepa-ueberweisung.xml"' });
  }
  if (pathname === '/api/t/sepa/direct-debit' && m === 'POST') {
    const ctx = requireAuth(req, res); if (!ctx) return null;
    if (!accountingAllowed(ctx.tenant)) return err(res, 403, 'module-not-active', { module: 'buchhaltung' });
    const b = await readJson(req, 2e6);
    const xml = sepa.buildDirectDebit(b);
    dbm.audit(ctx.tenant.id, ctx.user.id, 'sepa.direct-debit', { count: (b.payments || []).length });
    return send(res, 200, xml, { 'Content-Type': 'application/xml; charset=utf-8', 'Content-Disposition': 'attachment; filename="sepa-lastschrift.xml"' });
  }

  // ---- GoBD/GDPdU-Prüferexport (ZIP: index.xml + CSVs) ----
  if (pathname === '/api/t/gobd/export' && m === 'POST') {
    const ctx = requireAuth(req, res); if (!ctx) return null;
    if (!accountingAllowed(ctx.tenant)) return err(res, 403, 'module-not-active', { module: 'buchhaltung' });
    const b = await readJson(req, 8e6);
    const files = gobd.buildGobdExport({ supplierName: ctx.tenant.name, range: b.range || {}, outgoing: b.outgoing || [], incoming: b.incoming || [] });
    const zipBuf = zipm.buildZip(Object.keys(files).map(function (n) { return { name: n, data: files[n] }; }));
    dbm.audit(ctx.tenant.id, ctx.user.id, 'gobd.export', { from: (b.range || {}).from, to: (b.range || {}).to });
    return send(res, 200, zipBuf, { 'Content-Type': 'application/zip', 'Content-Disposition': 'attachment; filename="GoBD-Export.zip"' });
  }

  // ---- Lohn-Export ----
  if (pathname === '/api/t/payroll/export' && m === 'POST') {
    const ctx = requireAuth(req, res); if (!ctx) return null;
    if (!moduleAllowed(ctx.tenant, 'zeiten') && !accountingAllowed(ctx.tenant)) return err(res, 403, 'module-not-active', { module: 'zeiten' });
    const b = await readJson(req, 4e6);
    const csv = b.format === 'datev' ? payroll.buildDatevLohn(b.entries || [], b.meta || {}) : payroll.buildPayrollCsv(b.entries || [], b.meta || {});
    return send(res, 200, csv, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="lohn-export.csv"' });
  }

  // ---- iCal-Feed: Termine hinterlegen + Abo-Adresse ----
  if (pathname === '/api/t/ical/publish' && m === 'POST') {
    const ctx = requireAuth(req, res); if (!ctx) return null;
    if (!requireWritable(ctx, res, cfg.PLANS)) return null;
    if (!moduleAllowed(ctx.tenant, 'calendar') && !accountingAllowed(ctx.tenant)) return err(res, 403, 'module-not-active', { module: 'calendar' });
    const b = await readJson(req, 4e6);
    let rec = dbm.getIntegration(ctx.tenant.id, 'ical');
    let token = b.token;
    let tokenHash = rec && rec.inbox_token_hash;
    if (!tokenHash || b.regenerate) { const t = opaqueToken(); token = t.token; tokenHash = t.hash; }
    dbm.setIntegration(ctx.tenant.id, 'ical', { events: (b.events || []).slice(0, 5000), name: b.name || 'werkflow Kalender' }, tokenHash);
    const url = token ? (reqBaseUrl(req) + '/api/public/ical/' + token + '.ics') : undefined;
    return send(res, 200, { ok: true, feedUrl: url, count: (b.events || []).length });
  }

  // ---- Sichere PSD2-Bankanbindung (AIS, read-only, Bank-Login bei der Bank) ----
  if (pathname === '/api/t/bank/psd2/institutions' && m === 'GET') {
    const ctx = requireAuth(req, res); if (!ctx) return null;
    if (!accountingAllowed(ctx.tenant)) return err(res, 403, 'module-not-active', { module: 'buchhaltung' });
    if (!psd2.isConfigured()) return send(res, 200, { configured: false });
    const tk = await psd2.getToken(); if (!tk.ok) return send(res, 200, { configured: true, ok: false, error: tk.error });
    const u = new URL(req.url, 'http://x');
    const r = await psd2.listInstitutions(u.searchParams.get('country') || 'de', tk.access);
    return send(res, 200, Object.assign({ configured: true }, r));
  }
  if (pathname === '/api/t/bank/psd2/connect' && m === 'POST') {
    const ctx = requireAuth(req, res); if (!ctx) return null;
    if (!requireWritable(ctx, res, cfg.PLANS)) return null;
    if (!accountingAllowed(ctx.tenant)) return err(res, 403, 'module-not-active', { module: 'buchhaltung' });
    if (!psd2.isConfigured()) return send(res, 200, { configured: false });
    const b = await readJson(req, 8e3);
    if (!b.institutionId) return err(res, 400, 'institution-required');
    const tk = await psd2.getToken(); if (!tk.ok) return send(res, 200, { ok: false, error: tk.error });
    const reference = 'wf-' + ctx.tenant.id.slice(0, 10) + '-' + Date.now();
    const redirect = reqBaseUrl(req) + '/app?bank=connected';
    const r = await psd2.createRequisition({ institutionId: b.institutionId, redirect: redirect, reference: reference }, tk.access);
    if (!r.ok) return send(res, 200, { ok: false, error: r.error, detail: r.data });
    savePsd2(ctx.tenant.id, { requisitionId: r.id, institutionId: b.institutionId, institutionName: b.institutionName || '', status: r.status || 'CR', accountIds: [], connectedAt: nowIso(), seenTxIds: [] });
    dbm.audit(ctx.tenant.id, ctx.user.id, 'bank.psd2.connect', { institution: b.institutionId });
    return send(res, 200, { ok: true, link: r.link });
  }
  if (pathname === '/api/t/bank/psd2/status' && m === 'GET') {
    const ctx = requireAuth(req, res); if (!ctx) return null;
    if (!accountingAllowed(ctx.tenant)) return err(res, 403, 'module-not-active', { module: 'buchhaltung' });
    const st = loadPsd2(ctx.tenant.id);
    if (!st) return send(res, 200, { connected: false });
    if (psd2.isConfigured() && st.requisitionId && st.status !== 'LN') {
      const tk = await psd2.getToken();
      if (tk.ok) {
        const rq = await psd2.getRequisition(st.requisitionId, tk.access);
        if (rq.ok) {
          st.status = rq.status; st.accountIds = rq.accounts || [];
          // Konto-Details (IBAN) nachladen
          st.accounts = [];
          for (const aid of st.accountIds) { const d = await psd2.getAccountDetails(aid, tk.access); st.accounts.push({ id: aid, iban: d.ok ? d.iban : '', name: d.ok ? d.name : '' }); }
          savePsd2(ctx.tenant.id, st);
        }
      }
    }
    return send(res, 200, { connected: st.status === 'LN', status: st.status, institutionName: st.institutionName, accounts: st.accounts || (st.accountIds || []).map(function (id) { return { id: id }; }), lastSync: st.lastSync || null });
  }
  if (pathname === '/api/t/bank/psd2/sync' && m === 'POST') {
    const ctx = requireAuth(req, res); if (!ctx) return null;
    if (!requireWritable(ctx, res, cfg.PLANS)) return null;
    if (!accountingAllowed(ctx.tenant)) return err(res, 403, 'module-not-active', { module: 'buchhaltung' });
    const st = loadPsd2(ctx.tenant.id);
    if (!st || st.status !== 'LN') return send(res, 200, { ok: false, error: 'not-linked' });
    const tk = await psd2.getToken(); if (!tk.ok) return send(res, 200, { ok: false, error: tk.error });
    const seen = new Set(st.seenTxIds || []);
    const dateFrom = st.lastSync ? st.lastSync.slice(0, 10) : undefined;
    let fresh = [];
    for (const aid of (st.accountIds || [])) {
      const r = await psd2.getTransactions(aid, dateFrom, tk.access);
      if (r.ok) r.transactions.forEach(function (t) { const key = t.txId || (t.date + '|' + t.amount + '|' + t.reference); if (!seen.has(key)) { seen.add(key); fresh.push(t); } });
    }
    st.seenTxIds = Array.from(seen).slice(-3000);
    st.lastSync = nowIso();
    savePsd2(ctx.tenant.id, st);
    if (fresh.length) dbm.addInboxItem({ tenantId: ctx.tenant.id, kind: 'bank-tx', source: 'psd2', payload: { transactions: fresh } });
    dbm.audit(ctx.tenant.id, ctx.user.id, 'bank.psd2.sync', { added: fresh.length });
    return send(res, 200, { ok: true, added: fresh.length });
  }
  if (pathname === '/api/t/bank/psd2/disconnect' && m === 'POST') {
    const ctx = requireAuth(req, res); if (!ctx) return null;
    if (!requireWritable(ctx, res, cfg.PLANS)) return null;
    const st = loadPsd2(ctx.tenant.id);
    if (st && st.requisitionId && psd2.isConfigured()) { const tk = await psd2.getToken(); if (tk.ok) await psd2.deleteRequisition(st.requisitionId, tk.access); }
    dbm.setIntegration(ctx.tenant.id, 'bank_psd2', {}, null);
    dbm.audit(ctx.tenant.id, ctx.user.id, 'bank.psd2.disconnect', {});
    return send(res, 200, { ok: true });
  }

  // ---- Wetter fürs Bautagebuch (open-meteo, live) ----
  const weatherReq = pathname.match(/^\/api\/t\/weather$/);
  if (weatherReq && m === 'GET') {
    const ctx = requireAuth(req, res); if (!ctx) return null;
    const u = new URL(req.url, 'http://x');
    const place = u.searchParams.get('place') || '';
    const date = u.searchParams.get('date') || '';
    if (!place) return err(res, 400, 'place-required');
    return send(res, 200, await weather.fetchWeather(place, date));
  }

  return undefined;
}

function safeParse(row) { try { return JSON.parse(row.config_json || '{}'); } catch (_e) { return {}; } }
// PSD2-Status verschlüsselt lesen/schreiben (AES-256-GCM, pro Mandant gebunden)
function loadPsd2(tenantId) {
  const rec = dbm.getIntegration(tenantId, 'bank_psd2');
  if (!rec) return null;
  const c = safeParse(rec);
  return c.enc ? secure.openJson(c.enc, 'psd2:' + tenantId) : null;
}
function savePsd2(tenantId, state) {
  dbm.setIntegration(tenantId, 'bank_psd2', { enc: secure.sealJson(state, 'psd2:' + tenantId) });
}
function redact(cfgObj) {
  const c = Object.assign({}, cfgObj);
  for (const k of Object.keys(c)) if (/key|pass|secret|token/i.test(k) && c[k]) c[k] = '••••';
  return c;
}
function inboxAddressFor(kind, token, tenant, req) {
  if (kind === 'invoice_inbox') return 'rechnung.' + token.slice(0, 12) + '@' + (cfg.SITE_BASE_DOMAIN || 'inbound.werkflow.de');
  return reqBaseUrl(req) + '/api/public/' + (kind === 'ids' ? 'ids/return' : 'bank/push') + '/' + token;
}

module.exports = { handleApi };
