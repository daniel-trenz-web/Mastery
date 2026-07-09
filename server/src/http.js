'use strict';
// HTTP-Helfer: Body-Parsing mit Limits, JSON-Antworten, Auth-Middleware.

const { verifyToken } = require('./util');
const dbm = require('./db');

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) {
        reject(Object.assign(new Error('payload-too-large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req, maxBytes) {
  const buf = await readBody(req, maxBytes);
  if (!buf.length) return {};
  try { return JSON.parse(buf.toString('utf8')); }
  catch (_e) { throw Object.assign(new Error('invalid-json'), { status: 400 }); }
}

function send(res, status, obj, headers) {
  const body = typeof obj === 'string' || Buffer.isBuffer(obj) ? obj : JSON.stringify(obj);
  res.writeHead(status, Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  }, headers || {}));
  res.end(body);
  return res; // wahrheitswert, damit Aufrufer "behandelt" erkennen können
}

function err(res, status, code, extra) {
  return send(res, status, Object.assign({ error: code }, extra || {}));
}

function clientIp(req) {
  const xf = req.headers['x-forwarded-for'];
  return (xf ? String(xf).split(',')[0].trim() : req.socket.remoteAddress) || 'unknown';
}

// Auth: Bearer-Token prüfen, User + Tenant laden, Mandanten-Kontext erzwingen.
// Rückgabe null (Antwort bereits gesendet) oder { user, tenant, payload }.
function requireAuth(req, res) {
  const h = req.headers['authorization'] || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  const payload = token && verifyToken(token);
  if (!payload || payload.typ !== 'access') { err(res, 401, 'unauthorized'); return null; }
  const user = dbm.getUser(payload.uid);
  if (!user || user.status !== 'active') { err(res, 401, 'unauthorized'); return null; }
  const tenant = dbm.getTenant(user.tenant_id);
  if (!tenant || tenant.status === 'deleted') { err(res, 403, 'tenant-unavailable'); return null; }
  // Defense-in-depth: Wenn der Client einen X-Tenant-Key mitsendet, MUSS er zum
  // Token passen — verhindert versehentliche Kontext-Vermischung im Client.
  const tk = req.headers['x-tenant-key'];
  if (tk && tk !== tenant.id) { err(res, 403, 'tenant-mismatch'); return null; }
  return { user, tenant, payload };
}

function requireRole(ctx, res, roles) {
  if (!roles.includes(ctx.user.role)) { err(res, 403, 'forbidden-role'); return false; }
  return true;
}

// Schreibzugriff nur mit aktivem Abo/Testphase; Lesen + Export bleiben IMMER
// möglich (DSGVO-Auskunft & GoBD-Zugriff dürfen nicht am Abo hängen).
function requireWritable(ctx, res, PLANS) {
  if (ctx.user.role === 'external') { err(res, 403, 'read-only-role'); return false; }
  const t = ctx.tenant;
  if (t.status !== 'active') {
    err(res, 403, t.status === 'suspended' ? 'tenant-suspended' : 'tenant-deletion-pending');
    return false;
  }
  if (t.plan === 'TRIAL' && t.trial_ends_at && new Date(t.trial_ends_at).getTime() < Date.now()) {
    err(res, 402, 'trial-expired', { hint: 'Bitte Tarif wählen (START/BETRIEB/BETRIEB PLUS).' });
    return false;
  }
  if (!PLANS[t.plan]) { err(res, 402, 'no-active-plan'); return false; }
  return true;
}

module.exports = { readBody, readJson, send, err, clientIp, requireAuth, requireRole, requireWritable };
