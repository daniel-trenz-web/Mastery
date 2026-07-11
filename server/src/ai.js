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

// Universelles Schema für den KI-Einrichtungs-Assistenten: klassifiziert ein
// hochgeladenes Dokument und extrahiert die passenden strukturierten Daten.
const SETUP_DOC_TOOL = {
  name: 'einrichtung_dokument',
  description: 'Ein hochgeladenes Betriebsdokument klassifizieren und die relevanten Daten für die Systemeinrichtung strukturiert zurückgeben.',
  input_schema: {
    type: 'object',
    properties: {
      docType: {
        type: 'string',
        enum: ['gewerbeanmeldung', 'briefkopf', 'leistungsverzeichnis', 'preisliste', 'logo', 'sonstiges'],
        description: 'Art des Dokuments. gewerbeanmeldung/briefkopf → Firmendaten; leistungsverzeichnis → LV-Positionen; preisliste → Artikel mit Preisen; logo → Bild/Grafik ohne Text.',
      },
      summary: { type: 'string', description: 'Ein kurzer deutscher Satz, was erkannt wurde.' },
      company: {
        type: 'object',
        description: 'Firmen-/Stammdaten (nur bei gewerbeanmeldung/briefkopf).',
        properties: {
          name: { type: 'string' }, legalForm: { type: 'string', description: 'Rechtsform, z. B. GmbH, e.K., Einzelunternehmen' },
          owner: { type: 'string', description: 'Inhaber/Geschäftsführer' },
          street: { type: 'string' }, zip: { type: 'string' }, city: { type: 'string' },
          phone: { type: 'string' }, email: { type: 'string' }, website: { type: 'string' },
          ustId: { type: 'string', description: 'USt-IdNr. (DE…)' }, taxNumber: { type: 'string', description: 'Steuernummer' },
          iban: { type: 'string' }, bic: { type: 'string' }, bankName: { type: 'string' },
          trades: { type: 'array', items: { type: 'string' }, description: 'Gewerke/Tätigkeiten' },
        },
      },
      lvItems: {
        type: 'array', description: 'Leistungsverzeichnis-Positionen (nur bei leistungsverzeichnis).',
        items: {
          type: 'object',
          properties: {
            position: { type: 'string', description: 'Positionsnummer, falls vorhanden' },
            name: { type: 'string' }, description: { type: 'string' },
            unit: { type: 'string', description: 'Einheit (m², m, Stk, h, psch …)' },
            qty: { type: 'number' }, unitPrice: { type: 'number', description: 'Einheitspreis netto in Euro, falls erkennbar' },
          },
          required: ['name'],
        },
      },
      priceItems: {
        type: 'array', description: 'Artikel einer Lieferanten-Preisliste (nur bei preisliste).',
        items: {
          type: 'object',
          properties: {
            articleNo: { type: 'string' }, name: { type: 'string' },
            unit: { type: 'string' }, price: { type: 'number', description: 'Einzelpreis netto in Euro' },
          },
          required: ['name'],
        },
      },
      supplierName: { type: 'string', description: 'Name des Lieferanten (bei preisliste).' },
      listTitle: { type: 'string', description: 'Titel/Bezeichnung der Liste (LV oder Preisliste).' },
      confidence: { type: 'number', description: 'Lesbarkeit 0..1' },
    },
    required: ['docType', 'summary'],
  },
};

// Schema für den KI-Beratungs-Chatbot auf Website & in der App: liefert eine
// deutsche Antwort plus strukturierte Steuerinfos (Modul-Empfehlung, Kauf-CTA,
// Support-Weiterleitung), damit die UI passend reagieren kann.
const CHAT_TOOL = {
  name: 'chat_antwort',
  description: 'Freundliche, konkrete Beratungsantwort für einen Handwerksbetrieb zum Produkt werkflow — plus strukturierte Hinweise für die Oberfläche.',
  input_schema: {
    type: 'object',
    properties: {
      reply: { type: 'string', description: 'Die Antwort an den Nutzer, auf Deutsch, freundlich und konkret (max ~120 Wörter). Bei Unsicherheit ehrlich sagen und Support anbieten.' },
      suggestedModules: {
        type: 'array', description: 'Schlüssel der Module, die zur Frage passen (nur aus: planung, einkauf, zeiten, auftraege, geld, aufmass, website).',
        items: { type: 'string' },
      },
      wantsHuman: { type: 'boolean', description: 'true, wenn der Nutzer einen Menschen/Support möchte oder die Frage nicht produktbezogen beantwortbar ist (Vertrag, individuelle Preise, Beschwerde, Datenschutz-Auskunft, technisches Problem).' },
      leadIntent: { type: 'boolean', description: 'true, wenn klare Kaufabsicht erkennbar ist (fragt nach Preis für seinen Betrieb, Demo, Loslegen).' },
      topic: { type: 'string', description: 'Kurzes Stichwort zum Thema (z. B. „Preis", „Aufmaß", „DATEV", „Support").' },
    },
    required: ['reply'],
  },
};

// Schema für das KI-Aufmaß aus einem Grundriss/Plan (Foto oder PDF): erzeugt
// eine Aufmaßtabelle mit Raumnummern und Maßen, damit Umfang/Flächen automatisch
// berechnet werden, wenn nichts von Hand erfasst wurde.
const FLOOR_PLAN_TOOL = {
  name: 'grundriss_aufmass',
  description: 'Aus einem Grundriss / Bauplan (Foto oder PDF) eine strukturierte Aufmaßtabelle mit Räumen, Raumnummern und Maßen ableiten.',
  input_schema: {
    type: 'object',
    properties: {
      scale: { type: 'string', description: 'Erkannter Maßstab, z. B. „1:100" oder „unbekannt".' },
      unit: { type: 'string', description: 'Einheit der Maße im Plan (m oder cm). Gib Maße in Metern zurück.' },
      rooms: {
        type: 'array',
        description: 'Alle erkennbaren Räume/Flächen im Plan.',
        items: {
          type: 'object',
          properties: {
            number: { type: 'string', description: 'Raumnummer laut Plan (z. B. „1", „01", „EG.02"), falls vorhanden.' },
            name: { type: 'string', description: 'Raumbezeichnung (z. B. Wohnzimmer, Bad, Flur).' },
            length: { type: 'number', description: 'Länge in Metern, falls aus Bemaßung/Maßstab ableitbar.' },
            width: { type: 'number', description: 'Breite in Metern.' },
            height: { type: 'number', description: 'Raumhöhe in Metern, falls angegeben (sonst weglassen).' },
            area: { type: 'number', description: 'Grundfläche in m², falls direkt angeschrieben oder aus L×B berechenbar.' },
            perimeter: { type: 'number', description: 'Umfang in m, falls ableitbar.' },
            note: { type: 'string', description: 'Kurzer Hinweis bei Unsicherheit (z. B. „Maß geschätzt").' },
          },
          required: ['name'],
        },
      },
      confidence: { type: 'number', description: 'Selbsteinschätzung der Lesbarkeit/Genauigkeit 0..1.' },
      warnings: { type: 'array', items: { type: 'string' }, description: 'Wichtige Vorbehalte (z. B. „kein Maßstab erkennbar — Maße bitte prüfen").' },
    },
    required: ['rooms'],
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

// KI-Einrichtungs-Assistent: ein hochgeladenes Dokument (Foto/PDF) klassifizieren
// und die für die Systemeinrichtung relevanten Daten strukturiert extrahieren.
// hint: optionaler Typ-Hinweis vom Nutzer ('gewerbeanmeldung'|'leistungsverzeichnis'|'preisliste'|…).
async function extractSetupDocument(buffer, mediaType, hint) {
  if (!isConfigured()) return { configured: false };
  if (buffer.length > cfg.MAX_AI_IMAGE_BYTES) return { configured: true, ok: false, error: 'file-too-large' };
  const hintTxt = hint ? ('\nDer Nutzer vermutet: „' + String(hint).slice(0, 40) + '". Prüfe das, korrigiere bei Bedarf.') : '';
  return callClaude({
    model: cfg.AI_MODEL,
    max_tokens: 4000,
    tools: [SETUP_DOC_TOOL],
    tool_choice: { type: 'tool', name: 'einrichtung_dokument' },
    messages: [{
      role: 'user',
      content: [
        mediaBlock(buffer, mediaType),
        {
          type: 'text',
          text: 'Dies ist ein Betriebsdokument für die Ersteinrichtung einer Handwerker-Software. '
            + 'Bestimme die Dokumentart und extrahiere NUR die tatsächlich erkennbaren Daten '
            + '(Firmenstammdaten, LV-Positionen oder Lieferanten-Preisliste). Erfinde nichts. '
            + 'Beträge in Euro netto.' + hintTxt,
        },
      ],
    }],
  });
}

// KI-Beratungs-Chatbot: beantwortet Produktfragen von (potenziellen) Kunden.
// history: [{role:'user'|'assistant', text}], context: {price info, moduleCatalog}.
// Ohne Key → { configured:false } (die UI zeigt dann direkt das Support-Formular).
const CHAT_SYSTEM = 'Du bist der freundliche Produktberater von „werkflow", einer modularen '
  + 'Handwerker-Software für deutsche Handwerks- und Baubetriebe (GoBD-/DSGVO-konform). '
  + 'Module: Einsatzplanung (planung), Einkauf & Lager (einkauf), Zeiten & Team (zeiten), '
  + 'Aufträge & Baustelle (auftraege), Angebote & Rechnungen inkl. E-Rechnung/DATEV (geld), '
  + 'Aufmaß & Raumplan (aufmass), Website-Baukasten (website). Jedes Modul hat einen eigenen '
  + 'Monatspreis, bei mehreren Modulen gibt es Mengenrabatt; Abrechnung pro Betrieb, nicht pro Nutzer. '
  + '14 Tage kostenlos testen, keine Installation (läuft im Browser), Einrichtung per KI aus hochgeladenen '
  + 'Dokumenten. Antworte kurz, ehrlich und konkret auf Deutsch. Erfinde keine Preise/Zusagen — bei '
  + 'individuellen Preisen, Verträgen, Beschwerden, Rechts-/Datenschutzauskünften oder technischen '
  + 'Problemen biete die Weiterleitung an einen Menschen an (wantsHuman=true).';

async function chatReply(history, context) {
  if (!isConfigured()) return { configured: false };
  const msgs = (Array.isArray(history) ? history : [])
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.text === 'string')
    .slice(-12)
    .map((m) => ({ role: m.role, content: [{ type: 'text', text: String(m.text).slice(0, 2000) }] }));
  if (!msgs.length || msgs[msgs.length - 1].role !== 'user') return { configured: true, ok: false, error: 'no-user-message' };
  const ctx = context && Object.keys(context).length ? ('\n\nKontext (Preise/Module dieses Interessenten):\n' + JSON.stringify(context).slice(0, 4000)) : '';
  return callClaude({
    model: cfg.AI_MODEL,
    max_tokens: 700,
    system: CHAT_SYSTEM + ctx,
    tools: [CHAT_TOOL],
    tool_choice: { type: 'tool', name: 'chat_antwort' },
    messages: msgs,
  });
}

// KI-Aufmaß: Grundriss/Plan (Foto oder PDF) → Aufmaßtabelle mit Räumen & Maßen.
async function extractFloorPlan(buffer, mediaType, hint) {
  if (!isConfigured()) return { configured: false };
  if (buffer.length > cfg.MAX_AI_IMAGE_BYTES) return { configured: true, ok: false, error: 'file-too-large' };
  const hintTxt = hint ? ('\nHinweis des Nutzers: „' + String(hint).slice(0, 80) + '".') : '';
  return callClaude({
    model: cfg.AI_MODEL,
    max_tokens: 4000,
    tools: [FLOOR_PLAN_TOOL],
    tool_choice: { type: 'tool', name: 'grundriss_aufmass' },
    messages: [{
      role: 'user',
      content: [
        mediaBlock(buffer, mediaType),
        {
          type: 'text',
          text: 'Dies ist ein Grundriss / Bauplan. Leite eine Aufmaßtabelle ab: pro Raum Raumnummer, '
            + 'Bezeichnung und — soweit aus Bemaßung oder Maßstab ableitbar — Länge, Breite, Höhe, Fläche (m²) '
            + 'und Umfang (m). Gib Maße in Metern. Rechne nur, was der Plan hergibt; markiere Geschätztes im '
            + 'note-Feld und nenne fehlende Angaben in warnings. Erfinde keine Maße.' + hintTxt,
        },
      ],
    }],
  });
}

module.exports = { isConfigured, extractDeliveryNote, extractIncomingInvoice, generateWebsiteContent, extractSetupDocument, chatReply, extractFloorPlan };
