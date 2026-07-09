'use strict';
// Ausgehende E-Rechnung erzeugen (EN 16931): XRechnung (UBL Invoice) und
// ZUGFeRD/Factur-X (CII CrossIndustryInvoice). Pflicht im deutschen B2B-Verkehr.
// Reine Funktion, keine externen Abhängigkeiten. Das erzeugte XML ist mit dem
// vorhandenen einvoice-Parser wieder einlesbar (Round-Trip).

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function n2(v) { return (Math.round((Number(v) || 0) * 100) / 100).toFixed(2); }
function isoDate(d) { const m = String(d || '').match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? m[1] + '-' + m[2] + '-' + m[3] : ''; }
function ymd(d) { const i = isoDate(d); return i ? i.replace(/-/g, '') : ''; }

// Normalisiert Rechnung: berechnet fehlende Summen/USt-Aufteilung aus den Positionen.
function normalize(invoice) {
  const inv = Object.assign({ currency: 'EUR', lines: [] }, invoice);
  const lines = inv.lines.map(function (l, i) {
    const qty = Number(l.qty) || 0, up = Number(l.unitPrice) || 0;
    const lineNet = l.lineNet != null ? Number(l.lineNet) : Math.round(qty * up * 100) / 100;
    return { id: l.id || (i + 1), name: l.name || '', qty: qty, unit: l.unit || 'C62', unitPrice: up, lineNet: lineNet, vatRate: l.vatRate != null ? Number(l.vatRate) : 19 };
  });
  const byRate = {};
  lines.forEach(function (l) { byRate[l.vatRate] = (byRate[l.vatRate] || 0) + l.lineNet; });
  const breakdown = Object.keys(byRate).map(function (r) {
    const base = Math.round(byRate[r] * 100) / 100;
    return { rate: Number(r), base: base, amount: Math.round(base * Number(r)) / 100 };
  });
  const net = inv.net != null ? Number(inv.net) : Math.round(lines.reduce(function (s, l) { return s + l.lineNet; }, 0) * 100) / 100;
  const vat = inv.vat != null ? Number(inv.vat) : Math.round(breakdown.reduce(function (s, b) { return s + b.amount; }, 0) * 100) / 100;
  const gross = inv.gross != null ? Number(inv.gross) : Math.round((net + vat) * 100) / 100;
  return { number: inv.number || '', date: isoDate(inv.date), dueDate: isoDate(inv.dueDate), currency: inv.currency,
    buyerReference: inv.buyerReference || '', note: inv.note || '', lines: lines, breakdown: breakdown, net: net, vat: vat, gross: gross };
}

function partyUbl(tag, p) {
  p = p || {};
  return '<cac:' + tag + '><cac:Party>' +
    (p.email ? '<cbc:EndpointID schemeID="EM">' + esc(p.email) + '</cbc:EndpointID>' : '') +
    '<cac:PostalAddress><cbc:StreetName>' + esc(p.address || '') + '</cbc:StreetName>' +
    '<cbc:CityName>' + esc(p.city || '') + '</cbc:CityName>' +
    '<cbc:PostalZone>' + esc(p.zip || '') + '</cbc:PostalZone>' +
    '<cac:Country><cbc:IdentificationCode>' + esc(p.country || 'DE') + '</cbc:IdentificationCode></cac:Country></cac:PostalAddress>' +
    (p.vatId ? '<cac:PartyTaxScheme><cbc:CompanyID>' + esc(p.vatId) + '</cbc:CompanyID><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:PartyTaxScheme>' : '') +
    '<cac:PartyLegalEntity><cbc:RegistrationName>' + esc(p.name || '') + '</cbc:RegistrationName></cac:PartyLegalEntity>' +
    (p.email || p.phone ? '<cac:Contact>' + (p.name ? '<cbc:Name>' + esc(p.name) + '</cbc:Name>' : '') + (p.phone ? '<cbc:Telephone>' + esc(p.phone) + '</cbc:Telephone>' : '') + (p.email ? '<cbc:ElectronicMail>' + esc(p.email) + '</cbc:ElectronicMail>' : '') + '</cac:Contact>' : '') +
    '</cac:Party></cac:' + tag + '>';
}

// XRechnung (UBL 2.1, EN 16931 / KoSIT-Profil)
function buildXRechnung(invoice, seller, buyer) {
  const inv = normalize(invoice), cur = inv.currency;
  const lines = inv.lines.map(function (l) {
    return '<cac:InvoiceLine><cbc:ID>' + esc(l.id) + '</cbc:ID>' +
      '<cbc:InvoicedQuantity unitCode="' + esc(l.unit) + '">' + n2(l.qty) + '</cbc:InvoicedQuantity>' +
      '<cbc:LineExtensionAmount currencyID="' + cur + '">' + n2(l.lineNet) + '</cbc:LineExtensionAmount>' +
      '<cac:Item><cbc:Name>' + esc(l.name) + '</cbc:Name>' +
      '<cac:ClassifiedTaxCategory><cbc:ID>S</cbc:ID><cbc:Percent>' + n2(l.vatRate) + '</cbc:Percent><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:ClassifiedTaxCategory></cac:Item>' +
      '<cac:Price><cbc:PriceAmount currencyID="' + cur + '">' + n2(l.unitPrice) + '</cbc:PriceAmount></cac:Price></cac:InvoiceLine>';
  }).join('');
  const taxSub = inv.breakdown.map(function (b) {
    return '<cac:TaxSubtotal><cbc:TaxableAmount currencyID="' + cur + '">' + n2(b.base) + '</cbc:TaxableAmount>' +
      '<cbc:TaxAmount currencyID="' + cur + '">' + n2(b.amount) + '</cbc:TaxAmount>' +
      '<cac:TaxCategory><cbc:ID>S</cbc:ID><cbc:Percent>' + n2(b.rate) + '</cbc:Percent><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:TaxCategory></cac:TaxSubtotal>';
  }).join('');
  return '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<ubl:Invoice xmlns:ubl="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">' +
    '<cbc:CustomizationID>urn:cen.eu:en16931:2017#compliant#urn:xoev-de:kosit:standard:xrechnung_2.3</cbc:CustomizationID>' +
    '<cbc:ProfileID>urn:fdc:peppol.eu:2017:poacc:billing:01:1.0</cbc:ProfileID>' +
    '<cbc:ID>' + esc(inv.number) + '</cbc:ID>' +
    '<cbc:IssueDate>' + inv.date + '</cbc:IssueDate>' +
    (inv.dueDate ? '<cbc:DueDate>' + inv.dueDate + '</cbc:DueDate>' : '') +
    '<cbc:InvoiceTypeCode>380</cbc:InvoiceTypeCode>' +
    (inv.note ? '<cbc:Note>' + esc(inv.note) + '</cbc:Note>' : '') +
    '<cbc:DocumentCurrencyCode>' + cur + '</cbc:DocumentCurrencyCode>' +
    '<cbc:BuyerReference>' + esc(inv.buyerReference || (buyer && buyer.reference) || inv.number) + '</cbc:BuyerReference>' +
    partyUbl('AccountingSupplierParty', seller) +
    partyUbl('AccountingCustomerParty', buyer) +
    ((seller && seller.iban) ? '<cac:PaymentMeans><cbc:PaymentMeansCode>58</cbc:PaymentMeansCode><cac:PayeeFinancialAccount><cbc:ID>' + esc(seller.iban) + '</cbc:ID>' + (seller.bic ? '<cac:FinancialInstitutionBranch><cbc:ID>' + esc(seller.bic) + '</cbc:ID></cac:FinancialInstitutionBranch>' : '') + '</cac:PayeeFinancialAccount></cac:PaymentMeans>' : '') +
    '<cac:TaxTotal><cbc:TaxAmount currencyID="' + cur + '">' + n2(inv.vat) + '</cbc:TaxAmount>' + taxSub + '</cac:TaxTotal>' +
    '<cac:LegalMonetaryTotal>' +
    '<cbc:LineExtensionAmount currencyID="' + cur + '">' + n2(inv.net) + '</cbc:LineExtensionAmount>' +
    '<cbc:TaxExclusiveAmount currencyID="' + cur + '">' + n2(inv.net) + '</cbc:TaxExclusiveAmount>' +
    '<cbc:TaxInclusiveAmount currencyID="' + cur + '">' + n2(inv.gross) + '</cbc:TaxInclusiveAmount>' +
    '<cbc:PayableAmount currencyID="' + cur + '">' + n2(inv.gross) + '</cbc:PayableAmount></cac:LegalMonetaryTotal>' +
    lines + '</ubl:Invoice>';
}

// ZUGFeRD / Factur-X (CII, EN 16931 Profil)
function buildZugferdCii(invoice, seller, buyer) {
  const inv = normalize(invoice), cur = inv.currency;
  seller = seller || {}; buyer = buyer || {};
  const lines = inv.lines.map(function (l, i) {
    return '<ram:IncludedSupplyChainTradeLineItem>' +
      '<ram:AssociatedDocumentLineDocument><ram:LineID>' + esc(l.id) + '</ram:LineID></ram:AssociatedDocumentLineDocument>' +
      '<ram:SpecifiedTradeProduct><ram:Name>' + esc(l.name) + '</ram:Name></ram:SpecifiedTradeProduct>' +
      '<ram:SpecifiedLineTradeAgreement><ram:NetPriceProductTradePrice><ram:ChargeAmount>' + n2(l.unitPrice) + '</ram:ChargeAmount></ram:NetPriceProductTradePrice></ram:SpecifiedLineTradeAgreement>' +
      '<ram:SpecifiedLineTradeDelivery><ram:BilledQuantity unitCode="' + esc(l.unit) + '">' + n2(l.qty) + '</ram:BilledQuantity></ram:SpecifiedLineTradeDelivery>' +
      '<ram:SpecifiedLineTradeSettlement><ram:ApplicableTradeTax><ram:TypeCode>VAT</ram:TypeCode><ram:CategoryCode>S</ram:CategoryCode><ram:RateApplicablePercent>' + n2(l.vatRate) + '</ram:RateApplicablePercent></ram:ApplicableTradeTax>' +
      '<ram:SpecifiedTradeSettlementLineMonetarySummation><ram:LineTotalAmount>' + n2(l.lineNet) + '</ram:LineTotalAmount></ram:SpecifiedTradeSettlementLineMonetarySummation></ram:SpecifiedLineTradeSettlement>' +
      '</ram:IncludedSupplyChainTradeLineItem>';
  }).join('');
  const taxes = inv.breakdown.map(function (b) {
    return '<ram:ApplicableTradeTax><ram:CalculatedAmount>' + n2(b.amount) + '</ram:CalculatedAmount><ram:TypeCode>VAT</ram:TypeCode><ram:BasisAmount>' + n2(b.base) + '</ram:BasisAmount><ram:CategoryCode>S</ram:CategoryCode><ram:RateApplicablePercent>' + n2(b.rate) + '</ram:RateApplicablePercent></ram:ApplicableTradeTax>';
  }).join('');
  return '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<rsm:CrossIndustryInvoice xmlns:rsm="urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100" xmlns:ram="urn:un:unece:uncefact:data:standard:ReusableAggregateBusinessInformationEntity:100" xmlns:udt="urn:un:unece:uncefact:data:standard:UnqualifiedDataType:100">' +
    '<rsm:ExchangedDocumentContext><ram:GuidelineSpecifiedDocumentContextParameter><ram:ID>urn:cen.eu:en16931:2017</ram:ID></ram:GuidelineSpecifiedDocumentContextParameter></rsm:ExchangedDocumentContext>' +
    '<rsm:ExchangedDocument><ram:ID>' + esc(inv.number) + '</ram:ID><ram:TypeCode>380</ram:TypeCode>' +
    '<ram:IssueDateTime><udt:DateTimeString format="102">' + ymd(inv.date) + '</udt:DateTimeString></ram:IssueDateTime></rsm:ExchangedDocument>' +
    '<rsm:SupplyChainTradeTransaction>' + lines +
    '<ram:ApplicableHeaderTradeAgreement>' +
    '<ram:SellerTradeParty><ram:Name>' + esc(seller.name || '') + '</ram:Name>' +
    '<ram:PostalTradeAddress><ram:PostcodeCode>' + esc(seller.zip || '') + '</ram:PostcodeCode><ram:LineOne>' + esc(seller.address || '') + '</ram:LineOne><ram:CityName>' + esc(seller.city || '') + '</ram:CityName><ram:CountryID>' + esc(seller.country || 'DE') + '</ram:CountryID></ram:PostalTradeAddress>' +
    (seller.vatId ? '<ram:SpecifiedTaxRegistration><ram:ID schemeID="VA">' + esc(seller.vatId) + '</ram:ID></ram:SpecifiedTaxRegistration>' : '') + '</ram:SellerTradeParty>' +
    '<ram:BuyerTradeParty><ram:Name>' + esc(buyer.name || '') + '</ram:Name></ram:BuyerTradeParty></ram:ApplicableHeaderTradeAgreement>' +
    '<ram:ApplicableHeaderTradeDelivery/>' +
    '<ram:ApplicableHeaderTradeSettlement>' +
    (seller.iban ? '<ram:SpecifiedTradeSettlementPaymentMeans><ram:TypeCode>58</ram:TypeCode><ram:PayeePartyCreditorFinancialAccount><ram:IBANID>' + esc(seller.iban) + '</ram:IBANID></ram:PayeePartyCreditorFinancialAccount></ram:SpecifiedTradeSettlementPaymentMeans>' : '') +
    '<ram:InvoiceCurrencyCode>' + cur + '</ram:InvoiceCurrencyCode>' + taxes +
    (inv.dueDate ? '<ram:SpecifiedTradePaymentTerms><ram:DueDateDateTime><udt:DateTimeString format="102">' + ymd(inv.dueDate) + '</udt:DateTimeString></ram:DueDateDateTime></ram:SpecifiedTradePaymentTerms>' : '') +
    '<ram:SpecifiedTradeSettlementHeaderMonetarySummation>' +
    '<ram:LineTotalAmount>' + n2(inv.net) + '</ram:LineTotalAmount>' +
    '<ram:TaxBasisTotalAmount>' + n2(inv.net) + '</ram:TaxBasisTotalAmount>' +
    '<ram:TaxTotalAmount currencyID="' + cur + '">' + n2(inv.vat) + '</ram:TaxTotalAmount>' +
    '<ram:GrandTotalAmount>' + n2(inv.gross) + '</ram:GrandTotalAmount>' +
    '<ram:DuePayableAmount>' + n2(inv.gross) + '</ram:DuePayableAmount>' +
    '</ram:SpecifiedTradeSettlementHeaderMonetarySummation></ram:ApplicableHeaderTradeSettlement>' +
    '</rsm:SupplyChainTradeTransaction></rsm:CrossIndustryInvoice>';
}

module.exports = { buildXRechnung, buildZugferdCii, normalize };
