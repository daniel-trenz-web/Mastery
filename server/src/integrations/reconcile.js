'use strict';
// Zahlungsabgleich: ordnet Bank-Transaktionen offenen Rechnungen zu.
// Reine Funktion. Kunde/Client entscheidet final; hier wird nur vorgeschlagen.
//
// openItems: [{ id, kind:'outgoing'|'incoming', number, amount, party }]
//   outgoing = Ausgangsrechnung (wir bekommen Geld → positive Transaktion)
//   incoming = Eingangsrechnung (wir zahlen → negative Transaktion)
// transactions: normalisierte Bank-Transaktionen (siehe bankstatements.js)

function normalizeRef(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}
function normalizeName(s) {
  return String(s || '').toLowerCase().replace(/\b(gmbh|kg|ag|ohg|ug|co|mbh|e\.?k\.?|gbr)\b/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}
function numberInText(number, ...texts) {
  const n = normalizeRef(number);
  if (n.length < 3) return false;
  const hay = texts.map(normalizeRef).join('|');
  return hay.indexOf(n) >= 0;
}
function nameMatch(a, b) {
  a = normalizeName(a); b = normalizeName(b);
  if (!a || !b) return false;
  if (a === b) return true;
  const aw = a.split(' ').filter((w) => w.length >= 3);
  const bw = new Set(b.split(' ').filter((w) => w.length >= 3));
  const common = aw.filter((w) => bw.has(w)).length;
  return common >= 1 && common >= Math.min(aw.length, bw.size) * 0.5;
}

// Score einer möglichen Zuordnung (0..100). >=80 = sicher (Auto), 50..79 = Vorschlag.
function scoreMatch(tx, item) {
  // Vorzeichen muss zur Rechnungsart passen
  if (item.kind === 'outgoing' && tx.amount <= 0) return null;
  if (item.kind === 'incoming' && tx.amount >= 0) return null;
  const txAbs = Math.abs(tx.amount);
  const target = Math.abs(Number(item.amount) || 0);
  if (target <= 0) return null;
  const diff = Math.abs(txAbs - target);
  const amountExact = diff < 0.005;
  const amountClose = diff <= Math.max(0.02, target * 0.001); // 2 Cent oder 0,1 %
  const refHit = numberInText(item.number, tx.reference, tx.endToEndId);
  const partyHit = nameMatch(tx.counterparty, item.party);

  let score = 0;
  const reasons = [];
  if (amountExact) { score += 55; reasons.push('Betrag exakt'); }
  else if (amountClose) { score += 45; reasons.push('Betrag ~gleich'); }
  else return null; // ohne Betragsnähe kein Match
  if (refHit) { score += 35; reasons.push('Rechnungsnummer im Verwendungszweck'); }
  if (partyHit) { score += 20; reasons.push(item.kind === 'outgoing' ? 'Kundenname passt' : 'Lieferantenname passt'); }
  if (score > 100) score = 100;
  return { score, reasons };
}

// Gibt beste Zuordnungen zurück (greedy, jede Rechnung/Transaktion nur einmal).
function reconcile(transactions, openItems, opts) {
  const options = opts || {};
  const autoThreshold = options.autoThreshold != null ? options.autoThreshold : 80;
  const suggestThreshold = options.suggestThreshold != null ? options.suggestThreshold : 50;

  const candidates = [];
  transactions.forEach((tx, ti) => {
    openItems.forEach((item) => {
      const sc = scoreMatch(tx, item);
      if (sc && sc.score >= suggestThreshold) {
        candidates.push({ txIndex: ti, tx, itemId: item.id, item, score: sc.score, reasons: sc.reasons });
      }
    });
  });
  candidates.sort((a, b) => b.score - a.score);

  const usedTx = new Set(), usedItem = new Set();
  const matches = [];
  for (const c of candidates) {
    if (usedTx.has(c.txIndex) || usedItem.has(c.itemId)) continue;
    usedTx.add(c.txIndex); usedItem.add(c.itemId);
    matches.push({
      txIndex: c.txIndex,
      itemId: c.itemId,
      kind: c.item.kind,
      number: c.item.number,
      amount: c.tx.amount,
      date: c.tx.date,
      counterparty: c.tx.counterparty,
      reference: c.tx.reference,
      score: c.score,
      auto: c.score >= autoThreshold,
      reasons: c.reasons,
    });
  }
  const unmatchedTx = transactions.map((_, i) => i).filter((i) => !usedTx.has(i));
  return {
    matches,
    autoCount: matches.filter((m) => m.auto).length,
    suggestCount: matches.filter((m) => !m.auto).length,
    unmatchedTxIndexes: unmatchedTx,
  };
}

module.exports = { reconcile, scoreMatch };
