/* poker-engine.js — reine Poker-Logik, unabhängig von Netz/UI.
 * Deck, Hand-Bewertung (Hold'em/Omaha/Stud/Draw) und Side-Pot-Berechnung.
 * Wird sowohl im Browser (window.App.PokerEngine) als auch für einen
 * schnellen Node-Selbsttest genutzt (module.exports).
 */
(function (root) {
  'use strict';

  var SUITS = ['s', 'h', 'd', 'c'];
  var RANK_NAMES = { 11: 'B', 12: 'D', 13: 'K', 14: 'A' };
  var CAT_NAMES = ['', 'Hoechste Karte', 'Ein Paar', 'Zwei Paare', 'Drilling', 'Straße', 'Flush', 'Full House', 'Vierling', 'Straight Flush'];

  function rankLabel(r) { return RANK_NAMES[r] || String(r); }
  function cardLabel(c) { return rankLabel(c.r) + c.s; }

  function makeDeck() {
    var deck = [];
    for (var s = 0; s < SUITS.length; s++) {
      for (var r = 2; r <= 14; r++) deck.push({ r: r, s: SUITS[s] });
    }
    return deck;
  }

  function shuffle(deck, rng) {
    rng = rng || Math.random;
    for (var i = deck.length - 1; i > 0; i--) {
      var j = Math.floor(rng() * (i + 1));
      var t = deck[i]; deck[i] = deck[j]; deck[j] = t;
    }
    return deck;
  }

  function combos(arr, k) {
    var out = [];
    function rec(start, chosen) {
      if (chosen.length === k) { out.push(chosen.slice()); return; }
      for (var i = start; i < arr.length; i++) {
        chosen.push(arr[i]);
        rec(i + 1, chosen);
        chosen.pop();
      }
    }
    rec(0, []);
    return out;
  }

  /** Bewertet genau 5 Karten. Rückgabe: { cat, tie:[...], cards } — höher ist besser. */
  function score5(cards) {
    var byRank = {};
    cards.forEach(function (c) { byRank[c.r] = (byRank[c.r] || 0) + 1; });
    var ranksDesc = Object.keys(byRank).map(Number).sort(function (a, b) { return b - a; });
    var isFlush = cards.every(function (c) { return c.s === cards[0].s; });

    var uniq = ranksDesc.slice();
    var isStraight = false, straightHigh = 0;
    if (uniq.length === 5) {
      if (uniq[0] - uniq[4] === 4) { isStraight = true; straightHigh = uniq[0]; }
      else if (uniq[0] === 14 && uniq[1] === 5 && uniq[2] === 4 && uniq[3] === 3 && uniq[4] === 2) {
        isStraight = true; straightHigh = 5; // Rad: A-2-3-4-5
      }
    }

    var groups = ranksDesc.map(function (r) { return { r: r, n: byRank[r] }; })
      .sort(function (a, b) { return b.n - a.n || b.r - a.r; });

    var cat, tie;
    if (isStraight && isFlush) { cat = 9; tie = [straightHigh]; }
    else if (groups[0].n === 4) { cat = 8; tie = [groups[0].r, groups[1].r]; }
    else if (groups[0].n === 3 && groups[1] && groups[1].n === 2) { cat = 7; tie = [groups[0].r, groups[1].r]; }
    else if (isFlush) { cat = 6; tie = ranksDesc.slice(0, 5); }
    else if (isStraight) { cat = 5; tie = [straightHigh]; }
    else if (groups[0].n === 3) { cat = 4; tie = [groups[0].r].concat(groups.slice(1).map(function (g) { return g.r; })); }
    else if (groups[0].n === 2 && groups[1] && groups[1].n === 2) {
      var pairs = [groups[0].r, groups[1].r].sort(function (a, b) { return b - a; });
      var kicker = groups[2] ? groups[2].r : 0;
      cat = 3; tie = [pairs[0], pairs[1], kicker];
    } else if (groups[0].n === 2) {
      cat = 2; tie = [groups[0].r].concat(groups.slice(1).map(function (g) { return g.r; }));
    } else { cat = 1; tie = ranksDesc.slice(0, 5); }

    return { cat: cat, tie: tie, cards: cards.slice() };
  }

  function cmpScore(a, b) {
    if (a.cat !== b.cat) return a.cat - b.cat;
    for (var i = 0; i < Math.max(a.tie.length, b.tie.length); i++) {
      var av = a.tie[i] || 0, bv = b.tie[i] || 0;
      if (av !== bv) return av - bv;
    }
    return 0;
  }

  /** Beste 5-Karten-Hand aus 5-7 beliebigen Karten (Hold'em, Stud, Draw). */
  function bestOf(cards) {
    if (cards.length <= 5) return score5(cards);
    var best = null;
    combos(cards, 5).forEach(function (c) {
      var s = score5(c);
      if (!best || cmpScore(s, best) > 0) best = s;
    });
    return best;
  }

  /** Omaha: exakt 2 von 4 Handkarten + exakt 3 von 5 Boardkarten. */
  function bestOmaha(hole, board) {
    var best = null;
    combos(hole, 2).forEach(function (h2) {
      combos(board, 3).forEach(function (b3) {
        var s = score5(h2.concat(b3));
        if (!best || cmpScore(s, best) > 0) best = s;
      });
    });
    return best;
  }

  function describe(score) {
    var name = CAT_NAMES[score.cat];
    return name + ' (' + score.tie.map(rankLabel).join('-') + ')';
  }

  /**
   * Side-Pots aus den Einsätzen einer Hand berechnen.
   * entries: [{ id, contributed, folded }]  (contributed = Summe aller Einsätze dieser Hand)
   * Rückgabe: [{ amount, eligible:[id,...] }] in aufsteigender Ebenen-Reihenfolge.
   */
  function sidePots(entries) {
    var active = entries.filter(function (e) { return e.contributed > 0; });
    var levels = Array.from(new Set(active.map(function (e) { return e.contributed; })))
      .sort(function (a, b) { return a - b; });
    var pots = [], prev = 0;
    levels.forEach(function (level) {
      var layer = level - prev;
      var payers = active.filter(function (e) { return e.contributed >= level; });
      var amount = layer * payers.length;
      var eligible = payers.filter(function (e) { return !e.folded; }).map(function (e) { return e.id; });
      if (amount > 0) pots.push({ amount: amount, eligible: eligible });
      prev = level;
    });
    // Pots ohne Gewinn-Berechtigte (alle Beteiligten gefoldet) an den vorherigen Pot anhängen,
    // damit niemand ausgeschlossenes Geld "verschwindet".
    for (var i = pots.length - 1; i >= 0; i--) {
      if (pots[i].eligible.length === 0 && pots.length > 1) {
        var merge = i > 0 ? i - 1 : i + 1;
        if (pots[merge]) { pots[merge].amount += pots[i].amount; pots.splice(i, 1); }
      }
    }
    return pots;
  }

  var PokerEngine = {
    SUITS: SUITS,
    makeDeck: makeDeck,
    shuffle: shuffle,
    combos: combos,
    score5: score5,
    cmpScore: cmpScore,
    bestOf: bestOf,
    bestOmaha: bestOmaha,
    sidePots: sidePots,
    rankLabel: rankLabel,
    cardLabel: cardLabel,
    describe: describe
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = PokerEngine;
  if (root) { root.App = root.App || {}; root.App.PokerEngine = PokerEngine; }
})(typeof window !== 'undefined' ? window : null);
