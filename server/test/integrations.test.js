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

const xrechnung = require('../src/integrations/xrechnung');
const sepa = require('../src/integrations/sepa');
const gaeb = require('../src/integrations/gaeb');
const gobd = require('../src/integrations/gobd');
const payroll = require('../src/integrations/payroll');
const ical = require('../src/integrations/ical');
const weather = require('../src/integrations/weather');

test('Ausgangs-E-Rechnung: XRechnung + ZUGFeRD Round-Trip', () => {
  const inv = { number: '2026-0042', date: '2026-02-01', dueDate: '2026-02-15',
    lines: [{ name: 'Arbeit', qty: 10, unit: 'HUR', unitPrice: 55, vatRate: 19 }, { name: 'Material', qty: 1, unitPrice: 200, vatRate: 19 }] };
  const seller = { name: 'Elektro Müller GmbH', address: 'Hauptstr. 5', zip: '70173', city: 'Stuttgart', vatId: 'DE123456789', iban: 'DE89370400440532013000' };
  const buyer = { name: 'Familie Schmidt' };
  const xr = einvoice.parseEInvoice(Buffer.from(xrechnung.buildXRechnung(inv, seller, buyer)), 'application/xml');
  assert.equal(xr.ok, true);
  assert.equal(xr.data.invoiceNumber, '2026-0042');
  assert.equal(xr.data.net, 750);
  assert.equal(xr.data.gross, 892.5);
  assert.equal(xr.data.iban, 'DE89370400440532013000');
  const cii = einvoice.parseEInvoice(Buffer.from(xrechnung.buildZugferdCii(inv, seller, buyer)), 'application/xml');
  assert.equal(cii.ok, true);
  assert.equal(cii.data.gross, 892.5);
  assert.equal(cii.data.iban, 'DE89370400440532013000');
});

test('SEPA: pain.001 Überweisung + pain.008 Lastschrift', () => {
  const ct = sepa.buildCreditTransfer({ debtor: { name: 'Betrieb', iban: 'DE89370400440532013000' }, executionDate: '2026-03-01',
    payments: [{ endToEndId: 'RE-1', amount: 142.80, name: 'Raab Karcher', iban: 'DE12500105170648489890', remittance: 'RE-1' }], now: new Date(2026, 1, 20) });
  assert.ok(/pain\.001\.001\.03/.test(ct));
  assert.ok(/<CtrlSum>142\.80<\/CtrlSum>/.test(ct));
  const dd = sepa.buildDirectDebit({ creditor: { name: 'Betrieb', iban: 'DE89370400440532013000', creditorId: 'DE98ZZZ09999999999' }, collectionDate: '2026-03-05',
    payments: [{ amount: 892.50, name: 'Schmidt', iban: 'DE12500105170648489890', mandateId: 'M1', mandateDate: '2025-01-01' }], now: new Date(2026, 1, 20) });
  assert.ok(/pain\.008\.001\.02/.test(dd));
  assert.ok(dd.includes('DE98ZZZ09999999999'));
});

test('GAEB: LV parsen + D84-Angebot exportieren (Round-Trip)', () => {
  const src = '<GAEB xmlns="http://www.gaeb.de/GAEB_DA_XML/DA83/3.2"><PrjInfo><NamePrj>Kita</NamePrj></PrjInfo><Award><DP>83</DP><BoQ><BoQBody><Itemlist>' +
    '<Item ID="0001"><RNoPart>01</RNoPart><RNoPart>0010</RNoPart><Qty>100.000</Qty><QU>m2</QU><Description><CompleteText><DetailTxt><Text><p><span>Estrich</span></p></Text></DetailTxt></CompleteText></Description></Item>' +
    '</Itemlist></BoQBody></BoQ></Award></GAEB>';
  const p = gaeb.parseGaeb(src);
  assert.equal(p.itemCount, 1);
  assert.equal(p.items[0].pos, '01.0010');
  assert.equal(p.items[0].qty, 100);
  assert.equal(p.items[0].text, 'Estrich');
  const d84 = gaeb.buildGaebD84([Object.assign({}, p.items[0], { up: 35 })], { now: new Date(2026, 0, 1) });
  assert.ok(/DA84\/3\.2/.test(d84));
  assert.equal(gaeb.parseGaeb(d84).items[0].total, 3500);
});

test('GoBD/GDPdU-Prüferexport: index.xml + CSV', () => {
  const files = gobd.buildGobdExport({ supplierName: 'X', range: { from: '2026-01-01', to: '2026-12-31' },
    outgoing: [{ number: '2026-0042', date: '2026-02-01', party: 'Schmidt', net: 750, vat: 142.5, gross: 892.5 }], incoming: [] });
  assert.ok(files['index.xml'].includes('<!DOCTYPE DataSet'));
  assert.ok(files['index.xml'].includes('<VariablePrimaryKey/>'));
  assert.ok(files['ausgangsrechnungen.csv'].includes('"892,50"'));
});

test('Lohn-Export: generisches CSV + DATEV-LODAS', () => {
  const csv = payroll.buildPayrollCsv([{ personalNr: '100', name: 'A', hours: 160, overtime: 8, hourlyRate: 25 }]);
  assert.ok(csv.includes('"4200,00"'));
  assert.ok(payroll.buildDatevLohn([{ personalNr: '100', lohnart: '200', wert: 160 }], {}).includes('Ziel=LODAS'));
});

test('iCal-Feed: gültiges VCALENDAR mit Escaping', () => {
  const ics = ical.buildICal([{ summary: 'Baustelle', start: '2026-03-01T08:00', end: '2026-03-01T16:00', description: 'a; b' }], { name: 'werkflow' });
  assert.ok(ics.startsWith('BEGIN:VCALENDAR'));
  assert.ok(ics.includes('DTSTART:20260301T080000'));
  assert.ok(ics.includes('DESCRIPTION:a\\; b'));
});

test('Wetter: open-meteo-Antwort → Bautagebuch-Zusammenfassung', () => {
  const w = weather.summarizeDaily({ daily: { time: ['2026-02-20'], weathercode: [61], temperature_2m_max: [8.2], temperature_2m_min: [2.1], precipitation_sum: [4.5] } }, '2026-02-20');
  assert.equal(w.text, 'leichter Regen');
  assert.equal(w.tempMax, 8.2);
  assert.ok(w.summary.includes('Niederschlag 4.5 mm'));
});
