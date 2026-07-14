/* poker-eval.js — gemeinsame Poker-Bausteine für alle Poker-Spiele (App.Poker).
 *
 * Karten als 2-Zeichen-String: Rang + Farbe.
 *   Rang: '2'..'9','T','J','Q','K','A'   Farbe: 's','h','d','c' (♠♥♦♣)
 *
 * API:
 *   App.Poker.makeDeck()            -> Array aller 52 Karten
 *   App.Poker.shuffle(arr)          -> mischt in-place (Fisher-Yates) und gibt arr zurück
 *   App.Poker.rankVal(card)         -> 2..14 (A=14)
 *   App.Poker.suitOf(card)          -> 's'|'h'|'d'|'c'
 *   App.Poker.SUIT_SYM              -> {s:'♠',h:'♥',d:'♦',c:'♣'}
 *   App.Poker.eval5(cards5)         -> {cat:0..8, tie:[...], cards:[...]}  (genau 5 Karten)
 *   App.Poker.evalBest(cards)       -> beste 5-Karten-Bewertung aus 5..7 Karten
 *   App.Poker.compare(a,b)          -> -1|0|1 (a<b|=|a>b)
 *   App.Poker.handName(ev)          -> deutscher Name des Blatts
 *
 * Kategorien (cat): 0 High Card, 1 Paar, 2 Zwei Paare, 3 Drilling, 4 Straße,
 *   5 Flush, 6 Full House, 7 Vierling, 8 Straight Flush (inkl. Royal Flush). */
(function () {
  'use strict';
  window.App = window.App || {};

  var RANKS = '23456789TJQKA';
  var SUITS = ['s', 'h', 'd', 'c'];
  var SUIT_SYM = { s: '♠', h: '♥', d: '♦', c: '♣' };
  var CAT_NAME = ['Höchste Karte', 'Paar', 'Zwei Paare', 'Drilling', 'Straße', 'Flush', 'Full House', 'Vierling', 'Straight Flush'];

  function rankVal(card) { return RANKS.indexOf(card[0]) + 2; }
  function suitOf(card) { return card[1]; }

  function makeDeck() {
    var d = [];
    for (var r = 0; r < RANKS.length; r++) for (var s = 0; s < SUITS.length; s++) d.push(RANKS[r] + SUITS[s]);
    return d;
  }
  function shuffle(arr) {
    for (var i = arr.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }

  /* Bewertet GENAU 5 Karten. */
  function eval5(cards) {
    var vals = cards.map(rankVal).sort(function (a, b) { return b - a; });
    var suits = cards.map(suitOf);
    var isFlush = suits[0] === suits[1] && suits[1] === suits[2] && suits[2] === suits[3] && suits[3] === suits[4];

    // Häufigkeiten je Rang
    var count = {};
    vals.forEach(function (v) { count[v] = (count[v] || 0) + 1; });
    // Gruppen: [count, rankValue], sortiert nach count desc, dann rank desc
    var groups = Object.keys(count).map(function (k) { return [count[k], +k]; });
    groups.sort(function (a, b) { return b[0] - a[0] || b[1] - a[1]; });

    // Straße erkennen (inkl. Rad A-2-3-4-5)
    var uniq = Object.keys(count).map(Number).sort(function (a, b) { return b - a; });
    var straightHigh = 0;
    if (uniq.length === 5) {
      if (uniq[0] - uniq[4] === 4) straightHigh = uniq[0];
      else if (uniq[0] === 14 && uniq[1] === 5 && uniq[2] === 4 && uniq[3] === 3 && uniq[4] === 2) straightHigh = 5; // Rad
    }

    var cat, tie;
    if (straightHigh && isFlush) { cat = 8; tie = [straightHigh]; }
    else if (groups[0][0] === 4) { cat = 7; tie = [groups[0][1], groups[1][1]]; }
    else if (groups[0][0] === 3 && groups[1][0] === 2) { cat = 6; tie = [groups[0][1], groups[1][1]]; }
    else if (isFlush) { cat = 5; tie = vals.slice(); }
    else if (straightHigh) { cat = 4; tie = [straightHigh]; }
    else if (groups[0][0] === 3) { cat = 3; tie = [groups[0][1], groups[1][1], groups[2][1]]; }
    else if (groups[0][0] === 2 && groups[1][0] === 2) { cat = 2; tie = [Math.max(groups[0][1], groups[1][1]), Math.min(groups[0][1], groups[1][1]), groups[2][1]]; }
    else if (groups[0][0] === 2) { cat = 1; tie = [groups[0][1], groups[1][1], groups[2][1], groups[3][1]]; }
    else { cat = 0; tie = vals.slice(); }

    return { cat: cat, tie: tie, cards: cards.slice() };
  }

  function compare(a, b) {
    if (a.cat !== b.cat) return a.cat < b.cat ? -1 : 1;
    for (var i = 0; i < Math.max(a.tie.length, b.tie.length); i++) {
      var x = a.tie[i] || 0, y = b.tie[i] || 0;
      if (x !== y) return x < y ? -1 : 1;
    }
    return 0;
  }

  // Alle 5er-Kombinationen aus n Karten
  function combos5(cards) {
    var n = cards.length, res = [];
    if (n <= 5) { res.push(cards.slice()); return res; }
    for (var a = 0; a < n - 4; a++)
      for (var b = a + 1; b < n - 3; b++)
        for (var c = b + 1; c < n - 2; c++)
          for (var d = c + 1; d < n - 1; d++)
            for (var e = d + 1; e < n; e++)
              res.push([cards[a], cards[b], cards[c], cards[d], cards[e]]);
    return res;
  }
  function evalBest(cards) {
    var combos = combos5(cards), best = null;
    for (var i = 0; i < combos.length; i++) {
      var ev = eval5(combos[i]);
      if (!best || compare(ev, best) > 0) best = ev;
    }
    return best;
  }

  function handName(ev) {
    if (ev.cat === 8) return ev.tie[0] === 14 ? 'Royal Flush' : 'Straight Flush';
    return CAT_NAME[ev.cat];
  }

  App.Poker = {
    RANKS: RANKS, SUITS: SUITS, SUIT_SYM: SUIT_SYM, CAT_NAME: CAT_NAME,
    makeDeck: makeDeck, shuffle: shuffle, rankVal: rankVal, suitOf: suitOf,
    eval5: eval5, evalBest: evalBest, compare: compare, handName: handName
  };
})();
