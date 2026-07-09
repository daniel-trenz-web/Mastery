'use strict';
// E-Rechnung lesen: ZUGFeRD / Factur-X (CII, UN/CEFACT CrossIndustryInvoice)
// und XRechnung (UBL Invoice ODER CII). Gibt eine normalisierte Rechnung zurück.
// Reine Funktion, keine Netzwerk-/Datei-Zugriffe. Für PDF/A-3 (ZUGFeRD) wird die
// eingebettete XML best-effort aus dem PDF-Puffer extrahiert (unkomprimiert).

const xml = require('../xml');

function num(v) {
  if (v == null) return 0;
  const s = String(v).replace(/\s/g, '').replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.');
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}
function isoDate(v) {
  if (!v) return '';
  const s = String(v).trim();
  if (/^\d{8}$/.test(s)) return s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8); // format 102
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? m[1] + '-' + m[2] + '-' + m[3] : s;
}

// ---- CII (ZUGFeRD / Factur-X / XRechnung-CII) --------------------------------
function parseCii(root) {
  const doc = xml.find(root, 'ExchangedDocument');
  const tx = xml.find(root, 'SupplyChainTradeTransaction') || root;
  const agreement = xml.find(tx, 'ApplicableHeaderTradeAgreement');
  const settle = xml.find(tx, 'ApplicableHeaderTradeSettlement');

  const seller = agreement && xml.find(agreement, 'SellerTradeParty');
  const buyer = agreement && xml.find(agreement, 'BuyerTradeParty');

  const inv = {
    format: 'zugferd-cii',
    invoiceNumber: xml.text(doc, 'ID'),
    issueDate: isoDate(ciiDate(doc)),
    dueDate: '',
    currency: (settle && xml.text(settle, 'InvoiceCurrencyCode')) || 'EUR',
    supplier: {
      name: seller ? xml.text(seller, 'Name') : '',
      vatId: sellerVat(seller),
    },
    buyer: { name: buyer ? xml.text(buyer, 'Name') : '' },
    iban: '',
    positions: [],
    net: 0, vat: 0, gross: 0, payable: 0,
  };

  if (settle) {
    const terms = xml.find(settle, 'SpecifiedTradePaymentTerms');
    if (terms) inv.dueDate = isoDate(ciiDate(terms));
    const acct = xml.find(settle, 'CreditorFinancialAccount');
    if (acct) inv.iban = xml.text(acct, 'IBANID') || xml.text(acct, 'IBAN');
    const sum = xml.find(settle, 'SpecifiedTradeSettlementHeaderMonetarySummation');
    if (sum) {
      inv.net = num(xml.text(sum, 'TaxBasisTotalAmount'));
      inv.vat = num(xml.text(sum, 'TaxTotalAmount'));
      inv.gross = num(xml.text(sum, 'GrandTotalAmount'));
      inv.payable = num(xml.text(sum, 'DuePayableAmount')) || inv.gross;
    }
  }

  const lines = xml.findAll(tx, 'IncludedSupplyChainTradeLineItem');
  for (const li of lines) {
    const prod = xml.find(li, 'SpecifiedTradeProduct');
    const delivery = xml.find(li, 'SpecifiedLineTradeDelivery');
    const lineSettle = xml.find(li, 'SpecifiedLineTradeSettlement');
    const priceEl = xml.find(li, 'NetPriceProductTradePrice');
    const qtyEl = delivery && xml.find(delivery, 'BilledQuantity');
    inv.positions.push({
      name: prod ? xml.text(prod, 'Name') : '',
      articleNo: prod ? (xml.text(prod, 'SellerAssignedID') || xml.text(prod, 'GlobalID')) : '',
      qty: qtyEl ? num(qtyEl.text) : 0,
      unit: qtyEl ? (qtyEl.attrs.unitCode || '') : '',
      unitPrice: priceEl ? num(xml.text(priceEl, 'ChargeAmount')) : 0,
      lineNet: lineSettle ? num(xml.text(lineSettle, 'LineTotalAmount')) : 0,
    });
  }
  return inv;
}
function ciiDate(node) {
  const dt = node && xml.find(node, 'DateTimeString');
  if (dt && dt.text) return dt.text.trim();
  // Fallbacks für unterschiedliche Elementnamen
  const alt = node && (xml.find(node, 'IssueDateTime') || xml.find(node, 'DueDateDateTime'));
  return alt ? xml.text(alt) : '';
}
function sellerVat(seller) {
  if (!seller) return '';
  const regs = xml.findAll(seller, 'SpecifiedTaxRegistration');
  for (const r of regs) {
    const id = xml.find(r, 'ID');
    if (id && id.attrs && id.attrs.schemeID === 'VA') return (id.text || '').trim();
  }
  return regs.length ? xml.text(regs[0], 'ID') : '';
}

// ---- UBL (XRechnung) ---------------------------------------------------------
function parseUbl(root) {
  const supplierParty = xml.byPath(root, ['AccountingSupplierParty', 'Party']) || partyUnder(root, 'AccountingSupplierParty');
  const buyerParty = xml.byPath(root, ['AccountingCustomerParty', 'Party']) || partyUnder(root, 'AccountingCustomerParty');

  const inv = {
    format: 'xrechnung-ubl',
    invoiceNumber: directText(root, 'ID'),
    issueDate: isoDate(directText(root, 'IssueDate')),
    dueDate: isoDate(directText(root, 'DueDate')),
    currency: directText(root, 'DocumentCurrencyCode') || 'EUR',
    supplier: { name: partyName(supplierParty), vatId: partyVat(supplierParty) },
    buyer: { name: partyName(buyerParty) },
    iban: '',
    positions: [],
    net: 0, vat: 0, gross: 0, payable: 0,
  };

  const pm = xml.find(root, 'PaymentMeans');
  if (pm) {
    const acct = xml.find(pm, 'PayeeFinancialAccount');
    if (acct) inv.iban = xml.text(acct, 'ID');
  }
  const total = xml.find(root, 'LegalMonetaryTotal');
  if (total) {
    inv.net = num(xml.text(total, 'TaxExclusiveAmount'));
    inv.gross = num(xml.text(total, 'TaxInclusiveAmount'));
    inv.payable = num(xml.text(total, 'PayableAmount')) || inv.gross;
  }
  const taxTotal = xml.find(root, 'TaxTotal');
  if (taxTotal) inv.vat = num(xml.text(taxTotal, 'TaxAmount'));
  if (!inv.vat && inv.gross && inv.net) inv.vat = Math.round((inv.gross - inv.net) * 100) / 100;

  const lines = xml.findAll(root, 'InvoiceLine').concat(xml.findAll(root, 'CreditNoteLine'));
  for (const li of lines) {
    const item = xml.find(li, 'Item');
    const price = xml.find(li, 'Price');
    const qtyEl = xml.find(li, 'InvoicedQuantity') || xml.find(li, 'CreditedQuantity');
    inv.positions.push({
      name: item ? xml.text(item, 'Name') : '',
      articleNo: item ? sellerItemId(item) : '',
      qty: qtyEl ? num(qtyEl.text) : 0,
      unit: qtyEl ? (qtyEl.attrs.unitCode || '') : '',
      unitPrice: price ? num(xml.text(price, 'PriceAmount')) : 0,
      lineNet: num(xml.text(li, 'LineExtensionAmount')),
    });
  }
  return inv;
}
function partyUnder(root, wrapperLocal) {
  const w = xml.find(root, wrapperLocal);
  return w ? xml.find(w, 'Party') : null;
}
function partyName(party) {
  if (!party) return '';
  const le = xml.find(party, 'PartyLegalEntity');
  if (le) { const n = xml.text(le, 'RegistrationName'); if (n) return n; }
  const pn = xml.find(party, 'PartyName');
  return pn ? xml.text(pn, 'Name') : '';
}
function partyVat(party) {
  if (!party) return '';
  const schemes = xml.findAll(party, 'PartyTaxScheme');
  return schemes.length ? xml.text(schemes[0], 'CompanyID') : '';
}
function sellerItemId(item) {
  const s = xml.find(item, 'SellersItemIdentification');
  return s ? xml.text(s, 'ID') : '';
}
function directText(root, local) {
  // Nur Kinder auf oberster Ebene (nicht rekursiv) — verhindert Verwechslung mit Zeilen-IDs
  const c = xml.children(root, local);
  return c.length ? (c[0].text || '').trim() : '';
}

// ---- Öffentliche API ---------------------------------------------------------
function parseEInvoiceXml(xmlStr) {
  const root = xml.parseXml(xmlStr);
  const cii = xml.find(root, 'CrossIndustryInvoice');
  if (cii) return parseCii(cii);
  const ubl = xml.find(root, 'Invoice') || xml.find(root, 'CreditNote');
  if (ubl) return parseUbl(ubl);
  return null;
}

// ZUGFeRD-PDF: eingebettete XML aus dem Puffer holen (unkomprimierte Einbettung).
function extractXmlFromPdf(buffer) {
  const s = Buffer.isBuffer(buffer) ? buffer.toString('latin1') : String(buffer);
  const patterns = [
    /<[\w.-]*:?CrossIndustryInvoice[\s\S]*?<\/[\w.-]*:?CrossIndustryInvoice\s*>/,
    /<[\w.-]*:?Invoice[\s\S]*?<\/[\w.-]*:?Invoice\s*>/,
  ];
  for (const re of patterns) {
    const m = s.match(re);
    if (m) return Buffer.from(m[0], 'latin1').toString('utf8');
  }
  return null;
}

// Haupt-Einstieg: nimmt Rohpuffer + MIME, liefert { ok, format, data } oder { ok:false }
function parseEInvoice(buffer, mediaType) {
  const mt = (mediaType || '').toLowerCase();
  try {
    if (mt.includes('xml') || looksLikeXml(buffer)) {
      const inv = parseEInvoiceXml(bufToStr(buffer));
      if (inv && inv.invoiceNumber != null) return { ok: true, format: inv.format, data: inv };
    }
    if (mt.includes('pdf') || isPdf(buffer)) {
      const embedded = extractXmlFromPdf(buffer);
      if (embedded) {
        const inv = parseEInvoiceXml(embedded);
        if (inv) return { ok: true, format: inv.format + '+pdf', data: inv };
      }
      return { ok: false, error: 'pdf-no-embedded-xml' }; // → KI-Fallback beim Aufrufer
    }
    const inv = parseEInvoiceXml(bufToStr(buffer));
    if (inv) return { ok: true, format: inv.format, data: inv };
  } catch (e) {
    return { ok: false, error: 'parse-error', message: String(e && e.message || e) };
  }
  return { ok: false, error: 'unknown-format' };
}
function bufToStr(b) { return Buffer.isBuffer(b) ? b.toString('utf8') : String(b); }
function looksLikeXml(b) { const s = bufToStr(b).slice(0, 200).trim(); return s.startsWith('<'); }
function isPdf(b) { return Buffer.isBuffer(b) && b.slice(0, 5).toString('latin1') === '%PDF-'; }

module.exports = { parseEInvoice, parseEInvoiceXml, extractXmlFromPdf };
