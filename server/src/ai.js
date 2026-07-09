'use strict';
// KI-Dienst — Abstraktionsschicht über die Claude-API (Vision).
// Zentrale Stelle für alle Module: liest Lieferscheine/Belege aus Fotos
// strukturiert aus. Human-in-the-Loop: Die KI schlägt vor, der Mensch bestätigt.
//
// Ohne konfigurierten API-Key liefert extractDeliveryNote { configured:false }
// zurück — die App fällt dann sauber auf manuelle Erfassung zurück
// (Foto bleibt als Beleg, Mengen tippt der Nutzer).

const cfg = require('./config');

// JSON-Schema, das die KI zurückgeben soll (per Tool-Use erzwungen)
const DELIVERY_NOTE_TOOL = {
  name: 'lieferschein_erfassen',
  description: 'Strukturierte Daten eines fotografierten Lieferscheins / Wareneingangs zurückgeben.',
  input_schema: {
    type: 'object',
    properties: {
      supplier: { type: 'string', description: 'Name des Lieferanten/Händlers' },
      documentNumber: { type: 'string', description: 'Lieferschein-/Belegnummer, falls erkennbar' },
      date: { type: 'string', description: 'Datum im Format YYYY-MM-DD, falls erkennbar' },
      positions: {
        type: 'array',
        description: 'Alle Material-/Warenpositionen',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Artikelbezeichnung' },
            qty: { type: 'number', description: 'Menge' },
            unit: { type: 'string', description: 'Einheit (Stk, m, kg, l, Paket …)' },
            price: { type: 'number', description: 'Einzelpreis netto in Euro, falls erkennbar (sonst 0)' },
          },
          required: ['name', 'qty'],
        },
      },
      confidence: { type: 'number', description: 'Selbsteinschätzung der Lesbarkeit 0..1' },
    },
    required: ['positions'],
  },
};

// Schema für strukturierte Eingangsrechnungs-Erfassung (Beleg-Foto/-PDF)
const INCOMING_INVOICE_TOOL = {
  name: 'eingangsrechnung_erfassen',
  description: 'Strukturierte Daten einer Eingangs-/Lieferantenrechnung (Foto oder PDF) zurückgeben.',
  input_schema: {
    type: 'object',
    properties: {
      supplier: { type: 'string', description: 'Name des Lieferanten/Rechnungsstellers' },
      invoiceNumber: { type: 'string', description: 'Rechnungsnummer' },
      invoiceDate: { type: 'string', description: 'Rechnungsdatum YYYY-MM-DD' },
      dueDate: { type: 'string', description: 'Fälligkeitsdatum YYYY-MM-DD, falls erkennbar' },
      iban: { type: 'string', description: 'IBAN des Rechnungsstellers, falls erkennbar' },
      vatId: { type: 'string', description: 'USt-IdNr. des Lieferanten, falls erkennbar' },
      net: { type: 'number', description: 'Nettobetrag gesamt in Euro' },
      vat: { type: 'number', description: 'USt-Betrag gesamt in Euro' },
      gross: { type: 'number', description: 'Bruttobetrag gesamt in Euro' },
      positions: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            qty: { type: 'number' },
            unit: { type: 'string' },
            unitPrice: { type: 'number', description: 'Einzelpreis netto in Euro' },
            lineNet: { type: 'number', description: 'Positionssumme netto in Euro' },
          },
          required: ['name'],
        },
      },
      confidence: { type: 'number' },
    },
    required: ['gross'],
  },
};

// Schema für generierte Website-Inhalte (SEO-Texte). Das Rendering in valides,
// DSGVO-konformes HTML übernimmt der Server (sitegen.js) — die KI liefert nur Text.
const WEBSITE_TOOL = {
  name: 'website_inhalt',
  description: 'SEO-optimierte deutsche Website-Texte für einen Handwerks-/Dienstleistungsbetrieb erzeugen.',
  input_schema: {
    type: 'object',
    properties: {
      seoTitle: { type: 'string', description: 'Title-Tag, max 60 Zeichen, mit Ort' },
      metaDescription: { type: 'string', description: 'Meta-Description, 140-160 Zeichen' },
      keywords: { type: 'array', items: { type: 'string' } },
      heroHeadline: { type: 'string' },
      heroSubline: { type: 'string' },
      aboutTitle: { type: 'string' },
      aboutText: { type: 'string', description: 'Über-uns-Text, 2-4 Sätze' },
      services: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, text: { type: 'string' }, icon: { type: 'string', description: 'ein passendes Emoji' } }, required: ['title', 'text'] } },
      usps: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, text: { type: 'string' } }, required: ['title'] } },
      faq: { type: 'array', items: { type: 'object', properties: { q: { type: 'string' }, a: { type: 'string' } }, required: ['q', 'a'] } },
      ctaText: { type: 'string' },
    },
    required: ['seoTitle', 'metaDescription', 'heroHeadline', 'services'],
  },
};

function isConfigured() { return !!cfg.AI_API_KEY; }

async function callClaude(body) {
  try {
    const r = await fetch(cfg.AI_BASE_URL + '/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': cfg.AI_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      return { configured: true, ok: false, error: 'api-http-' + r.status, detail: t.slice(0, 200) };
    }
    const data = await r.json();
    const toolUse = (data.content || []).find((c) => c.type === 'tool_use');
    if (!toolUse) return { configured: true, ok: false, error: 'no-structured-output' };
    return { configured: true, ok: true, data: toolUse.input };
  } catch (e) {
    return { configured: true, ok: false, error: 'network', detail: String(e.message || e) };
  }
}

// Bild-/PDF-Content-Block je nach MIME
function mediaBlock(buffer, mediaType) {
  const mt = (mediaType || 'image/jpeg').split(';')[0];
  if (mt === 'application/pdf') {
    return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buffer.toString('base64') } };
  }
  return { type: 'image', source: { type: 'base64', media_type: mt, data: buffer.toString('base64') } };
}

// buffer: Bilddaten, mediaType: z. B. 'image/jpeg'
async function extractDeliveryNote(buffer, mediaType) {
  if (!isConfigured()) return { configured: false };
  if (buffer.length > cfg.MAX_AI_IMAGE_BYTES) return { configured: true, ok: false, error: 'image-too-large' };
  return callClaude({
    model: cfg.AI_MODEL,
    max_tokens: 1500,
    tools: [DELIVERY_NOTE_TOOL],
    tool_choice: { type: 'tool', name: 'lieferschein_erfassen' },
    messages: [{
      role: 'user',
      content: [
        mediaBlock(buffer, mediaType),
        { type: 'text', text: 'Erfasse diesen Lieferschein / Wareneingang strukturiert. Nur tatsächlich lesbare Positionen; unsichere Mengen konservativ. Preise nur, wenn eindeutig netto erkennbar.' },
      ],
    }],
  });
}

// Eingangsrechnung aus Foto/PDF strukturiert lesen (Fallback, wenn keine E-Rechnung-XML vorliegt)
async function extractIncomingInvoice(buffer, mediaType) {
  if (!isConfigured()) return { configured: false };
  if (buffer.length > cfg.MAX_AI_IMAGE_BYTES) return { configured: true, ok: false, error: 'file-too-large' };
  return callClaude({
    model: cfg.AI_MODEL,
    max_tokens: 2000,
    tools: [INCOMING_INVOICE_TOOL],
    tool_choice: { type: 'tool', name: 'eingangsrechnung_erfassen' },
    messages: [{
      role: 'user',
      content: [
        mediaBlock(buffer, mediaType),
        { type: 'text', text: 'Erfasse diese Eingangs-/Lieferantenrechnung strukturiert. Achte auf Rechnungsnummer, Datum, Fälligkeit, IBAN, Netto/USt/Brutto und die Positionen. Beträge in Euro.' },
      ],
    }],
  });
}

// SEO-Website-Texte aus dem Kunden-Workflow generieren
async function generateWebsiteContent(input) {
  if (!isConfigured()) return { configured: false };
  const brief = JSON.stringify(input || {}, null, 2).slice(0, 12000);
  return callClaude({
    model: cfg.AI_MODEL,
    max_tokens: 3000,
    tools: [WEBSITE_TOOL],
    tool_choice: { type: 'tool', name: 'website_inhalt' },
    messages: [{
      role: 'user',
      content: [{
        type: 'text',
        text: 'Erzeuge SEO-optimierte, professionelle deutsche Website-Texte für diesen Betrieb. '
          + 'Verkaufsstark, konkret, ohne Floskeln, mit lokalem SEO-Bezug (Ort einbauen). '
          + 'Nutze die angegebenen Leistungen/Produkte. Erfinde keine Fakten (Zertifikate, Jahre), '
          + 'die nicht im Brief stehen.\n\nBrief:\n' + brief,
      }],
    }],
  });
}

module.exports = { isConfigured, extractDeliveryNote, extractIncomingInvoice, generateWebsiteContent };
