'use strict';
// Unit-Tests für die Schnittstellen-Module (reine Logik, kein Netzwerk).
const { test } = require('node:test');
const assert = require('node:assert');

const einvoice = require('../src/integrations/einvoice');
const bank = require('../src/integrations/bankstatements');
const { reconcile } = require('../src/integrations/reconcile');
const datev = require('../src/integrations/datev');
const datanorm = require('../src/integrations/datanorm');
const ugl = require('../src/integrations/ugl');
const ids = require('../src/integrations/ids');
const sitegen = require('../src/integrations/sitegen');

test('E-Rechnung: ZUGFeRD/CII wird korrekt gelesen', () => {
  const cii = `<rsm:CrossIndustryInvoice xmlns:rsm="u" xmlns:ram="r" xmlns:udt="d">
   <rsm:ExchangedDocument><ram:ID>RE-1</ram:ID><ram:IssueDateTime><udt:DateTimeString format="102">20260115</udt:DateTimeString></ram:IssueDateTime></rsm:ExchangedDocument>
   <rsm:SupplyChainTradeTransaction>
    <ram:IncludedSupplyChainTradeLineItem><ram:SpecifiedTradeProduct><ram:Name>Kabel</ram:Name></ram:SpecifiedTradeProduct>
     <ram:SpecifiedLineTradeAgreement><ram:NetPriceProductTradePrice><ram:ChargeAmount>1.20</ram:ChargeAmount></ram:NetPriceProductTradePrice></ram:SpecifiedLineTradeAgreement>
     <ram:SpecifiedLineTradeDelivery><ram:BilledQuantity unitCode="MTR">100</ram:BilledQuantity></ram:SpecifiedLineTradeDelivery></ram:IncludedSupplyChainTradeLineItem>
    <ram:ApplicableHeaderTradeAgreement><ram:SellerTradeParty><ram:Name>Raab Karcher</ram:Name></ram:SellerTradeParty></ram:ApplicableHeaderTradeAgreement>
    <ram:ApplicableHeaderTradeSettlement><ram:CreditorFinancialAccount><ram:IBANID>DE89370400440532013000</ram:IBANID></ram:CreditorFinancialAccount>
     <ram:SpecifiedTradeSettlementHeaderMonetarySummation><ram:TaxBasisTotalAmount>120.00</ram:TaxBasisTotalAmount><ram:TaxTotalAmount>22.80</ram:TaxTotalAmount><ram:GrandTotalAmount>142.80</ram:GrandTotalAmount></ram:SpecifiedTradeSettlementHeaderMonetarySummation></ram:ApplicableHeaderTradeSettlement>
   </rsm:SupplyChainTradeTransaction></rsm:CrossIndustryInvoice>`;
  const r = einvoice.parseEInvoice(Buffer.from(cii), 'application/xml');
  assert.equal(r.ok, true);
  assert.equal(r.data.invoiceNumber, 'RE-1');
  assert.equal(r.data.issueDate, '2026-01-15');
  assert.equal(r.data.supplier.name, 'Raab Karcher');
  assert.equal(r.data.iban, 'DE89370400440532013000');
  assert.equal(r.data.gross, 142.8);
  assert.equal(r.data.positions[0].qty, 100);
});

test('E-Rechnung: XRechnung/UBL wird korrekt gelesen', () => {
  const ubl = `<Invoice xmlns:cac="c" xmlns:cbc="b"><cbc:ID>XR-7</cbc:ID><cbc:IssueDate>2026-02-01</cbc:IssueDate>
   <cac:AccountingSupplierParty><cac:Party><cac:PartyLegalEntity><cbc:RegistrationName>Wuerth</cbc:RegistrationName></cac:PartyLegalEntity></cac:Party></cac:AccountingSupplierParty>
   <cac:TaxTotal><cbc:TaxAmount>38.00</cbc:TaxAmount></cac:TaxTotal>
   <cac:LegalMonetaryTotal><cbc:TaxExclusiveAmount>200.00</cbc:TaxExclusiveAmount><cbc:TaxInclusiveAmount>238.00</cbc:TaxInclusiveAmount></cac:LegalMonetaryTotal>
   <cac:InvoiceLine><cbc:InvoicedQuantity unitCode="C62">10</cbc:InvoicedQuantity><cbc:LineExtensionAmount>200.00</cbc:LineExtensionAmount><cac:Item><cbc:Name>Schrauben</cbc:Name></cac:Item></cac:InvoiceLine></Invoice>`;
  const r = einvoice.parseEInvoice(Buffer.from(ubl), 'application/xml');
  assert.equal(r.ok, true);
  assert.equal(r.data.invoiceNumber, 'XR-7');
  assert.equal(r.data.supplier.name, 'Wuerth');
  assert.equal(r.data.net, 200);
  assert.equal(r.data.gross, 238);
  assert.equal(r.data.positions[0].name, 'Schrauben');
});

test('Bank: CAMT.053 mit Vorzeichen & Verwendungszweck', () => {
  const camt = `<Document><BkToCstmrStmt><Stmt><Acct><Id><IBAN>DE12500105170648489890</IBAN></Id></Acct>
   <Ntry><Amt Ccy="EUR">142.80</Amt><CdtDbtInd>DBIT</CdtDbtInd><BookgDt><Dt>2026-02-16</Dt></BookgDt>
    <NtryDtls><TxDtls><RltdPties><Cdtr><Nm>Raab Karcher</Nm></Cdtr></RltdPties><RmtInf><Ustrd>Rechnung RE-1</Ustrd></RmtInf></TxDtls></NtryDtls></Ntry>
   </Stmt></BkToCstmrStmt></Document>`;
  const t = bank.parseCamt053(camt);
  assert.equal(t.length, 1);
  assert.equal(t[0].amount, -142.8);
  assert.equal(t[0].counterparty, 'Raab Karcher');
  assert.equal(t[0].reference, 'Rechnung RE-1');
});

test('Bank: MT940 SEPA-Subfelder', () => {
  const mt = [':25:50010517/0648489890', ':61:2602160216DR142,80NTRFNONREF',
    ':86:177?00LASTSCHRIFT?20EREF+RE-1?21SVWZ+Rechnung RE-1?32Raab Karcher', '-'].join('\n');
  const t = bank.parseMt940(mt);
  assert.equal(t.length, 1);
  assert.equal(t[0].amount, -142.8);
  assert.equal(t[0].endToEndId, 'RE-1');
  assert.equal(t[0].counterparty, 'Raab Karcher');
  assert.equal(t[0].reference, 'Rechnung RE-1');
});

test('Bank: CSV (deutsches Format) mit Soll/Haben', () => {
  const csv = 'Buchungstag;Auftraggeber/Empfänger;Verwendungszweck;Betrag\n18.02.2026;Familie Schmidt;Ihre Rechnung 2026-0042;2.380,00';
  const t = bank.parseBankCsv(csv);
  assert.equal(t[0].amount, 2380);
  assert.equal(t[0].date, '2026-02-18');
  assert.equal(t[0].counterparty, 'Familie Schmidt');
});

test('Zahlungsabgleich: exakte Zuordnung + Vorzeichenprüfung', () => {
  const tx = [
    { date: 'x', amount: -142.80, counterparty: 'Raab Karcher', reference: 'RE-1', endToEndId: 'RE-1' },
    { date: 'y', amount: 2380.00, counterparty: 'Familie Schmidt', reference: 'Rechnung 2026-0042', endToEndId: '' },
  ];
  const items = [
    { id: 'a', kind: 'incoming', number: 'RE-1', amount: 142.80, party: 'Raab Karcher' },
    { id: 'b', kind: 'outgoing', number: '2026-0042', amount: 2380.00, party: 'Familie Schmidt' },
  ];
  const r = reconcile(tx, items);
  assert.equal(r.autoCount, 2);
  // Falsches Vorzeichen darf nicht matchen
  const r2 = reconcile([{ date: 'x', amount: -2380, counterparty: 'Familie Schmidt', reference: '2026-0042' }], [items[1]]);
  assert.equal(r2.matches.length, 0);
});

test('DATEV: EXTF-Buchungsstapel hat 125 Spalten + korrekten Kopf', () => {
  const bookings = datev.invoicesToBookings([
    { kind: 'outgoing', number: '2026-0042', date: '2026-02-01', gross: 2380, party: 'Schmidt', debitor: 10001 },
  ], { skr: '03' });
  const csv = datev.buildBuchungsstapel(bookings, { beraterNr: '1', mandantNr: '2', now: new Date(2026, 6, 9) });
  const lines = csv.split('\r\n').filter(Boolean);
  assert.equal(lines[0].split(';')[0], '"EXTF"');
  assert.equal(lines[0].split(';')[3], '"Buchungsstapel"');
  assert.equal(lines[1].split(';').length, datev.COLS);
  assert.equal(lines[2].split(';').length, datev.COLS);
  assert.equal(lines[2].split(';')[0], '2380,00');
  assert.equal(lines[2].split(';')[1], 'S');
  assert.equal(lines[2].split(';')[9], '0102'); // Belegdatum DDMM
});

test('Katalog: DATANORM-A-Satz + CSV', () => {
  const dn = datanorm.parseDatanorm('A;A;123456;1;Kabel NYM;3x1,5;2;125;;Mtr;1');
  assert.equal(dn[0].artNr, '123456');
  assert.equal(dn[0].name, 'Kabel NYM 3x1,5');
  assert.equal(dn[0].priceEur, 1.25);
  const csv = datanorm.parseCatalogCsv('Artikelnummer;Bezeichnung;Einheit;Preis\nA-100;Kabel;m;1,20');
  assert.equal(csv[0].artNr, 'A-100');
  assert.equal(csv[0].priceEur, 1.2);
});

test('UGL: Bestellung erzeugen und zurücklesen (Round-Trip)', () => {
  const text = ugl.buildUglOrder({ number: 'B-1', kommission: 'BV Test', lieferantenNr: 'L1',
    items: [{ nr: 1, articleNo: '123456', qty: 100, unit: 'Mtr', price: 1.25, name: 'Kabel' }] },
    { kundenNr: 'K9', now: new Date(2026, 1, 16, 9, 30, 0) });
  const p = ugl.parseUgl(text);
  assert.equal(p.belegart, 'BES');
  assert.equal(p.number, 'B-1');
  assert.equal(p.positions[0].articleNo, '123456');
  assert.equal(p.positions[0].qty, 100);
  assert.equal(p.positions[0].price, 1.25);
});

test('IDS: Warenkorb-Rückgabe (urlencoded + XML)', () => {
  const form = ids.parseBasketReturn('ARTNR[1]=123&MENGE[1]=2&PREIS[1]=1,25&KURZTEXT[1]=Kabel&ME[1]=Mtr', 'application/x-www-form-urlencoded');
  assert.equal(form.count, 1);
  assert.equal(form.positions[0].artNr, '123');
  assert.equal(form.positions[0].qty, 2);
  assert.equal(form.positions[0].price, 1.25);
  const x = ids.parseBasketReturn('<Order><ITEM><ARTNR>9</ARTNR><MENGE>3</MENGE><PREIS>10,00</PREIS></ITEM></Order>', 'text/xml');
  assert.equal(x.positions[0].artNr, '9');
  assert.equal(x.positions[0].price, 10);
});

test('Website-Generator: valides HTML, SEO, Consent, Rechtstexte, 3 Vorlagen', () => {
  const biz = { companyName: 'Elektro Müller GmbH', city: 'Stuttgart', email: 'info@x.de', vatId: 'DE123', address: 'Hauptstr. 5', zip: '70173' };
  const input = { companyName: 'Elektro Müller GmbH', branche: 'Elektro', city: 'Stuttgart', services: ['Installation', 'Smart Home'] };
  for (const template of ['modern', 'bold', 'classic']) {
    const r = sitegen.renderSite(null, biz, { template, input, canonical: 'https://x.de/index.html' });
    const idx = r.pages['index.html'];
    assert.ok(idx.startsWith('<!doctype html>'));
    assert.ok(idx.includes('<meta name="description"'));
    assert.ok(idx.includes('"@type":"LocalBusiness"'));
    assert.ok(idx.includes('id="cc"')); // Cookie-Consent
    assert.ok(r.pages['impressum.html'].includes('§ 5 DDG'));
    assert.ok(r.pages['datenschutz.html'].includes('Art. 15 DSGVO'));
    assert.ok(r['sitemap.xml'].includes('<loc>'));
  }
  // XSS-Schutz
  const rx = sitegen.renderSite(null, { companyName: '<script>x</script>' }, { input: { companyName: '<script>x</script>' } });
  assert.ok(!rx.pages['index.html'].includes('<script>x</script>'));
});
