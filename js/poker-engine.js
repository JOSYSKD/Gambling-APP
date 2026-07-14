/* poker-engine.js — reine Karten-/Bewertungslogik für alle Poker-Varianten.
 * Keine Netz-/UI-Abhängigkeiten, damit sie auf jedem Client identisch läuft.
 *
 * Karten als Strings: Rang + Farbe, z.B. "Ah" (Herz-Ass), "Tc" (Kreuz-Zehn).
 * Ränge: 2-9,T,J,Q,K,A. Farben: s(pik) h(erz) d(karo) c(reuz).
 *
 * Score-Array (evaluate5): [kategorie(0-8), tiebreaks...], höher = besser.
 * 0 Hochkarte · 1 Paar · 2 Zwei Paare · 3 Drilling · 4 Straße · 5 Flush ·
 * 6 Full House · 7 Vierling · 8 Straight Flush
 */
(function () {
  'use strict';
  window.App = window.App || {};

  var RANK_CHARS = '23456789TJQKA';
  var SUITS = ['s', 'h', 'd', 'c'];
  var SUIT_SYMBOL = { s: '♠', h: '♥', d: '♦', c: '♣' };
  var CAT_NAMES = ['Hochkarte', 'Ein Paar', 'Zwei Paare', 'Drilling', 'Straße', 'Flush', 'Full House', 'Vierling', 'Straight Flush'];

  function makeDeck() {
    var deck = [];
    for (var s = 0; s < SUITS.length; s++) {
      for (var r = 0; r < RANK_CHARS.length; r++) deck.push(RANK_CHARS[r] + SUITS[s]);
    }
    return deck;
  }
  function shuffle(deck) {
    for (var i = deck.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = deck[i]; deck[i] = deck[j]; deck[j] = t;
    }
    return deck;
  }
  function parseCard(str) {
    return { r: RANK_CHARS.indexOf(str[0]) + 2, s: str[1], str: str };
  }
  function rankChar(r) { return RANK_CHARS[r - 2]; }
  function suitSymbol(s) { return SUIT_SYMBOL[s] || s; }
  function isRed(s) { return s === 'h' || s === 'd'; }

  function combinations(arr, k) {
    var res = [];
    function rec(start, cur) {
      if (cur.length === k) { res.push(cur.slice()); return; }
      for (var i = start; i < arr.length; i++) { cur.push(arr[i]); rec(i + 1, cur); cur.pop(); }
    }
    rec(0, []);
    return res;
  }

  /* Bewertet genau 5 Kartenobjekte ({r,s}). */
  function evaluate5(cards) {
    var ranks = cards.map(function (c) { return c.r; }).sort(function (a, b) { return b - a; });
    var suits = cards.map(function (c) { return c.s; });
    var isFlush = suits.every(function (s) { return s === suits[0]; });

    var counts = {};
    ranks.forEach(function (r) { counts[r] = (counts[r] || 0) + 1; });
    var groups = Object.keys(counts).map(Number).map(function (r) { return { r: r, c: counts[r] }; });
    groups.sort(function (a, b) { return b.c - a.c || b.r - a.r; });

    var uniq = {};
    ranks.forEach(function (r) { uniq[r] = true; });
    var straightHigh = null;
    for (var h = 14; h >= 5; h--) {
      if (h === 5) {
        if (uniq[5] && uniq[4] && uniq[3] && uniq[2] && uniq[14]) { straightHigh = 5; break; }
      } else {
        var ok = true;
        for (var i = 0; i < 5; i++) if (!uniq[h - i]) { ok = false; break; }
        if (ok) { straightHigh = h; break; }
      }
    }

    if (isFlush && straightHigh) return [8, straightHigh];
    if (groups[0].c === 4) return [7, groups[0].r, groups[1].r];
    if (groups[0].c === 3 && groups[1] && groups[1].c >= 2) return [6, groups[0].r, groups[1].r];
    if (isFlush) return [5].concat(ranks);
    if (straightHigh) return [4, straightHigh];
    if (groups[0].c === 3) return [3, groups[0].r, groups[1].r, groups[2].r];
    if (groups[0].c === 2 && groups[1] && groups[1].c === 2) return [2, groups[0].r, groups[1].r, groups[2].r];
    if (groups[0].c === 2) return [1, groups[0].r, groups[1].r, groups[2].r, groups[3].r];
    return [0].concat(ranks);
  }

  function cmpScore(a, b) {
    var len = Math.max(a.length, b.length);
    for (var i = 0; i < len; i++) {
      var x = a[i] || 0, y = b[i] || 0;
      if (x !== y) return x - y;
    }
    return 0;
  }

  /* Bestes 5er-Blatt aus >=5 Karten (Texas Hold'em / Stud: alle Karten frei kombinierbar). */
  function bestHand(cardObjs) {
    if (cardObjs.length <= 5) return { score: evaluate5(cardObjs), cards: cardObjs };
    var best = null;
    combinations(cardObjs, 5).forEach(function (c) {
      var sc = evaluate5(c);
      if (!best || cmpScore(sc, best.score) > 0) best = { score: sc, cards: c };
    });
    return best;
  }

  /* Omaha: exakt 2 der 4 Handkarten + exakt 3 der 5 Boardkarten. */
  function bestOmahaHand(holeObjs, boardObjs) {
    var best = null;
    combinations(holeObjs, 2).forEach(function (hc) {
      combinations(boardObjs, 3).forEach(function (bc) {
        var five = hc.concat(bc);
        var sc = evaluate5(five);
        if (!best || cmpScore(sc, best.score) > 0) best = { score: sc, cards: five };
      });
    });
    return best;
  }

  function describe(score) { return CAT_NAMES[score[0]]; }

  /* Side-Pot-Berechnung: contributed = {id: Gesamteinsatz dieser Hand},
   * folded = {id: true}. Liefert Pots [{amount, eligible:[ids]}], vom
   * kleinsten (Haupt-)Pot zum größten Side-Pot aufsteigend sortiert. */
  function computeSidePots(contributed, folded) {
    var entries = Object.keys(contributed)
      .map(function (id) { return { id: id, amt: contributed[id] || 0 }; })
      .filter(function (e) { return e.amt > 0; });
    var levels = [];
    entries.forEach(function (e) { if (levels.indexOf(e.amt) < 0) levels.push(e.amt); });
    levels.sort(function (a, b) { return a - b; });
    var pots = [], prev = 0;
    levels.forEach(function (level) {
      var layer = level - prev;
      var contributors = entries.filter(function (e) { return e.amt >= level; });
      var total = layer * contributors.length;
      var eligible = contributors.filter(function (e) { return !folded[e.id]; }).map(function (e) { return e.id; });
      if (total > 0 && eligible.length) pots.push({ amount: total, eligible: eligible });
      else if (total > 0 && pots.length) pots[pots.length - 1].amount += total; // niemand berechtigt -> an vorherigen Pot
      prev = level;
    });
    return pots;
  }

  App.PokerEngine = {
    makeDeck: makeDeck, shuffle: shuffle, parseCard: parseCard,
    rankChar: rankChar, suitSymbol: suitSymbol, isRed: isRed,
    evaluate5: evaluate5, cmpScore: cmpScore, bestHand: bestHand, bestOmahaHand: bestOmahaHand,
    computeSidePots: computeSidePots,
    describe: describe, catNames: CAT_NAMES
  };
})();
