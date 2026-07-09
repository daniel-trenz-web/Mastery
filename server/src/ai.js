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

function isConfigured() { return !!cfg.AI_API_KEY; }

// buffer: Bilddaten, mediaType: z. B. 'image/jpeg'
async function extractDeliveryNote(buffer, mediaType) {
  if (!isConfigured()) return { configured: false };
  if (buffer.length > cfg.MAX_AI_IMAGE_BYTES) {
    return { configured: true, ok: false, error: 'image-too-large' };
  }
  const body = {
    model: cfg.AI_MODEL,
    max_tokens: 1500,
    tools: [DELIVERY_NOTE_TOOL],
    tool_choice: { type: 'tool', name: 'lieferschein_erfassen' },
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType || 'image/jpeg', data: buffer.toString('base64') } },
        { type: 'text', text: 'Erfasse diesen Lieferschein / Wareneingang strukturiert. Nur tatsächlich lesbare Positionen; unsichere Mengen konservativ. Preise nur, wenn eindeutig netto erkennbar.' },
      ],
    }],
  };
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

module.exports = { isConfigured, extractDeliveryNote };
