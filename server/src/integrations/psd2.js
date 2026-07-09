'use strict';
// Sichere Bankanbindung über PSD2-Kontoinformationsdienst (AIS).
// Implementierung: GoCardless Bank Account Data (ehem. Nordigen), BaFin-reguliert.
// Der Bank-Login findet BEI DER BANK statt (SCA/TAN) — wir speichern KEIN
// Bank-Passwort, nur die Requisition-/Konto-Referenzen (verschlüsselt). Read-only.
// Abstrahiert über eine Basis-URL; austauschbar gegen finAPI/Tink.

const cfg = require('../config');

function isConfigured() { return !!(cfg.PSD2_SECRET_ID && cfg.PSD2_SECRET_KEY); }
function base() { return (cfg.PSD2_BASE_URL || 'https://bankaccountdata.gocardless.com').replace(/\/$/, ''); }

async function req(method, path, body, token) {
  try {
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
    if (token) headers.Authorization = 'Bearer ' + token;
    const r = await fetch(base() + path, { method: method, headers: headers, body: body != null ? JSON.stringify(body) : undefined });
    const txt = await r.text();
    let data = null; try { data = txt ? JSON.parse(txt) : null; } catch (_e) { data = txt; }
    if (!r.ok) return { ok: false, status: r.status, error: 'api-http-' + r.status, data: data };
    return { ok: true, status: r.status, data: data };
  } catch (e) {
    return { ok: false, error: 'network', message: String(e && e.message || e) };
  }
}

// Kurzlebiges Zugriffstoken aus unseren (Server-)Zugangsdaten holen.
async function getToken() {
  if (!isConfigured()) return { ok: false, error: 'not-configured' };
  const r = await req('POST', '/api/v2/token/new/', { secret_id: cfg.PSD2_SECRET_ID, secret_key: cfg.PSD2_SECRET_KEY });
  if (!r.ok) return r;
  return { ok: true, access: r.data.access, refresh: r.data.refresh };
}

async function listInstitutions(country, token) {
  const r = await req('GET', '/api/v2/institutions/?country=' + encodeURIComponent(country || 'de'), null, token);
  if (!r.ok) return r;
  return { ok: true, institutions: (r.data || []).map(function (i) { return { id: i.id, name: i.name, bic: i.bic || '', logo: i.logo || '' }; }) };
}

// Requisition = Einwilligungs-/Verknüpfungsvorgang. Liefert den Bank-Login-Link.
async function createRequisition(opts, token) {
  const o = opts || {};
  const r = await req('POST', '/api/v2/requisitions/', {
    institution_id: o.institutionId,
    redirect: o.redirect,
    reference: o.reference,
    user_language: 'DE',
  }, token);
  if (!r.ok) return r;
  return { ok: true, id: r.data.id, link: r.data.link, status: r.data.status };
}

async function getRequisition(id, token) {
  const r = await req('GET', '/api/v2/requisitions/' + encodeURIComponent(id) + '/', null, token);
  if (!r.ok) return r;
  return { ok: true, id: r.data.id, status: r.data.status, accounts: r.data.accounts || [], institutionId: r.data.institution_id };
}

async function deleteRequisition(id, token) {
  return req('DELETE', '/api/v2/requisitions/' + encodeURIComponent(id) + '/', null, token);
}

async function getAccountDetails(accountId, token) {
  const r = await req('GET', '/api/v2/accounts/' + encodeURIComponent(accountId) + '/details/', null, token);
  if (!r.ok) return r;
  const a = (r.data && r.data.account) || {};
  return { ok: true, iban: a.iban || '', name: a.name || a.ownerName || '', currency: a.currency || 'EUR' };
}

async function getTransactions(accountId, dateFrom, token) {
  const q = dateFrom ? '?date_from=' + encodeURIComponent(dateFrom) : '';
  const r = await req('GET', '/api/v2/accounts/' + encodeURIComponent(accountId) + '/transactions/' + q, null, token);
  if (!r.ok) return r;
  return { ok: true, transactions: normalizeTransactions(r.data), raw: r.data };
}

// GoCardless/Nordigen-Transaktionsformat → unser normalisiertes Format (rein, testbar)
function normalizeTransactions(json) {
  const t = (json && json.transactions) || {};
  const booked = t.booked || [];
  return booked.map(function (x) {
    const amount = parseFloat((x.transactionAmount && x.transactionAmount.amount) || '0') || 0;
    const ref = Array.isArray(x.remittanceInformationUnstructuredArray)
      ? x.remittanceInformationUnstructuredArray.join(' ')
      : (x.remittanceInformationUnstructured || '');
    return {
      txId: x.transactionId || x.internalTransactionId || '',
      date: (x.bookingDate || x.valueDate || '').slice(0, 10),
      valueDate: (x.valueDate || '').slice(0, 10),
      amount: Math.round(amount * 100) / 100,
      currency: (x.transactionAmount && x.transactionAmount.currency) || 'EUR',
      counterparty: amount < 0 ? (x.creditorName || '') : (x.debtorName || ''),
      counterpartyIban: (x.creditorAccount && x.creditorAccount.iban) || (x.debtorAccount && x.debtorAccount.iban) || '',
      reference: String(ref).replace(/\s+/g, ' ').trim(),
      endToEndId: x.endToEndId || '',
      source: 'psd2',
    };
  });
}

module.exports = {
  isConfigured, getToken, listInstitutions, createRequisition, getRequisition,
  deleteRequisition, getAccountDetails, getTransactions, normalizeTransactions,
};
