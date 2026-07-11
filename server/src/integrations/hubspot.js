'use strict';
// HubSpot CRM – REST-Connector (fetch-basiert, abhängigkeitsfrei).
// Anders als die Buchhaltungs-Connectoren ist HubSpot eine HOST-Anbindung:
// der Betreiber synchronisiert Leads/Mandanten als Kontakte in sein CRM.
// Auth: Private-App-Token (Bearer). Fehler-Shape wie ai.js/lexoffice.js.

const BASE = 'https://api.hubapi.com';

async function call(token, method, path, body) {
  if (!token) return { ok: false, error: 'not-configured' };
  try {
    const r = await fetch(BASE + path, {
      method,
      headers: {
        Authorization: 'Bearer ' + token,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: body != null ? JSON.stringify(body) : undefined,
    });
    const txt = await r.text();
    let data = null; try { data = txt ? JSON.parse(txt) : null; } catch (_e) { data = txt; }
    if (!r.ok) return { ok: false, error: 'api-http-' + r.status, data };
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: 'network', message: String((e && e.message) || e) };
  }
}

// Verbindung testen: ein Kontakt genügt, um Token + Scope zu prüfen.
function testConnection(token) {
  return call(token, 'GET', '/crm/v3/objects/contacts?limit=1');
}

// Nur bekannte, sinnvolle HubSpot-Standardfelder durchreichen.
const CONTACT_PROPS = ['email', 'firstname', 'lastname', 'company', 'phone', 'website', 'lifecyclestage'];
function mapContact(c) {
  const props = {};
  for (const k of CONTACT_PROPS) if (c[k] != null && String(c[k]).trim() !== '') props[k] = String(c[k]).slice(0, 250);
  // „source" ist kein Standardfeld → in hs_lead_status/notes vermeiden; als Firmenzusatz ignorieren.
  return props;
}

// Kontakte per E-Mail upserten (Batch, idProperty=email). Max 100/Batch (HubSpot-Limit).
async function syncContacts(token, contacts) {
  const valid = (contacts || []).filter((c) => c && c.email && /.+@.+\..+/.test(String(c.email)));
  if (!valid.length) return { ok: true, upserted: 0, batches: 0 };
  // Nach E-Mail deduplizieren (letzter gewinnt).
  const byEmail = new Map();
  for (const c of valid) byEmail.set(String(c.email).toLowerCase(), c);
  const inputs = [...byEmail.values()].map((c) => ({ idProperty: 'email', id: String(c.email).toLowerCase(), properties: mapContact(c) }));
  let upserted = 0, batches = 0, lastError = null;
  for (let i = 0; i < inputs.length; i += 100) {
    const chunk = inputs.slice(i, i + 100);
    const r = await call(token, 'POST', '/crm/v3/objects/contacts/batch/upsert', { inputs: chunk });
    batches++;
    if (r.ok) upserted += (r.data && r.data.results ? r.data.results.length : chunk.length);
    else lastError = r.error;
  }
  return { ok: lastError == null, upserted, batches, error: lastError || undefined };
}

function isConfigured(token) { return !!token; }

module.exports = { testConnection, syncContacts, isConfigured };
