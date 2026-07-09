'use strict';
// Verschlüsselung sensibler Daten "at rest" (Bank-Tokens/Referenzen, API-Keys).
// AES-256-GCM mit aus dem Server-Secret abgeleitetem Schlüssel. Authentifiziert
// (GCM-Tag) — Manipulation am Ciphertext wird bei der Entschlüsselung erkannt.

const crypto = require('crypto');
const cfg = require('./config');

function keyFor(purpose) {
  return crypto.createHash('sha256').update('werkflow:enc:' + (purpose || '') + ':' + cfg.SECRET).digest();
}

// -> "v1:<base64(iv|tag|ciphertext)>"
function encrypt(plaintext, purpose) {
  const key = keyFor(purpose);
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(String(plaintext == null ? '' : plaintext), 'utf8'), c.final()]);
  const tag = c.getAuthTag();
  return 'v1:' + Buffer.concat([iv, tag, ct]).toString('base64');
}

function decrypt(token, purpose) {
  if (typeof token !== 'string' || token.indexOf('v1:') !== 0) return null;
  try {
    const buf = Buffer.from(token.slice(3), 'base64');
    const iv = buf.subarray(0, 12), tag = buf.subarray(12, 28), ct = buf.subarray(28);
    const d = crypto.createDecipheriv('aes-256-gcm', keyFor(purpose), iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
  } catch (_e) { return null; }
}

// Objekt verschlüsselt ablegen / lesen (JSON).
function sealJson(obj, purpose) { return encrypt(JSON.stringify(obj || {}), purpose); }
function openJson(token, purpose) { const s = decrypt(token, purpose); if (s == null) return null; try { return JSON.parse(s); } catch (_e) { return null; } }

module.exports = { encrypt, decrypt, sealJson, openJson };
