'use strict';
// Krypto- und Hilfsfunktionen: Passwort-Hashing (scrypt), signierte Tokens (HMAC),
// IDs, Zeit. Bewusst ohne externe Abhängigkeiten — nur Node-Bordmittel.

const crypto = require('crypto');
const { SECRET } = require('./config');

function id(prefix) {
  return (prefix ? prefix + '_' : '') + crypto.randomBytes(12).toString('base64url');
}

function nowIso() { return new Date().toISOString(); }

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// --- Passwörter: scrypt mit Salt, konstante Vergleichszeit ---------------
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(pw), salt, 32, { N: 16384, r: 8, p: 1 });
  return 'scrypt$' + salt.toString('base64') + '$' + hash.toString('base64');
}

function verifyPassword(pw, stored) {
  try {
    const [algo, saltB64, hashB64] = String(stored).split('$');
    if (algo !== 'scrypt') return false;
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(hashB64, 'base64');
    const actual = crypto.scryptSync(String(pw), salt, expected.length, { N: 16384, r: 8, p: 1 });
    return crypto.timingSafeEqual(expected, actual);
  } catch (_e) { return false; }
}

// --- Access-Tokens: kompaktes signiertes Format (payload.signature) -------
// Kein externes JWT nötig: base64url(JSON) + HMAC-SHA256.
function signToken(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  return body + '.' + sig;
}

function verifyToken(token) {
  try {
    const [body, sig] = String(token).split('.');
    if (!body || !sig) return null;
    const expected = crypto.createHmac('sha256', SECRET).update(body).digest();
    const given = Buffer.from(sig, 'base64url');
    if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload.exp || Date.now() > payload.exp) return null;
    return payload;
  } catch (_e) { return null; }
}

// Opake Tokens (Refresh, Magic-Link): nur der SHA256-Hash wird gespeichert.
function opaqueToken() {
  const t = crypto.randomBytes(32).toString('base64url');
  return { token: t, hash: sha256(t) };
}

// --- Einfache In-Memory-Rate-Limits (pro Schlüssel) -----------------------
const buckets = new Map();
function rateLimit(key, maxHits, windowMs) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || now > b.reset) { b = { count: 0, reset: now + windowMs }; buckets.set(key, b); }
  b.count++;
  if (buckets.size > 50000) buckets.clear(); // Speicher-Schutz
  return b.count <= maxHits;
}

// E-Mail-Normalisierung + simple Validierung
function normEmail(e) { return String(e || '').trim().toLowerCase(); }
function isEmail(e) { return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e); }

module.exports = {
  id, nowIso, sha256, hashPassword, verifyPassword,
  signToken, verifyToken, opaqueToken, rateLimit, normEmail, isEmail,
};
