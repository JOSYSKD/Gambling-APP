/* poker.js — Online-Poker mit Raum-Code, bis zu 12 Spieler.
 * Vier klassische Varianten: Texas Hold'em, Omaha, Seven Card Stud, Five Card Draw.
 * (Exotischere Varianten wie Razz, Hi-Lo, Badugi o.ä. sind bewusst nicht enthalten —
 *  siehe PR-Beschreibung für die Begründung.)
 *
 * Architektur (analog zu connect4.js, aber mit host-exklusivem Karten-Handling):
 *  - Öffentlicher Zustand liegt komplett in room.shared (net.js repliziert ihn an
 *    alle Clients). Da es keinen echten Server gibt, sind Handkarten technisch für
 *    jeden Client einsehbar (Trust-Modell wie bei den anderen Minigames) — die UI
 *    zeigt fremde Karten aber nur verdeckt, bis zum Showdown.
 *  - Spieler-AKTIONEN (Fold/Check/Call/Bet/Raise, Draw-Wunsch) berechnet der
 *    handelnde Client selbst und schreibt das Ergebnis per room.setShared() —
 *    genau wie beim Zug in "4 Gewinnt".
 *  - KARTEN geben (Deck mischen/ziehen, neue Straße aufdecken, Draw-Ersatzkarten,
 *    neue Hand starten) macht ausschließlich der Host, weil nur er das Deck lokal
 *    hält (das Deck selbst wird NICHT repliziert, sonst könnte jeder Client die
 *    nächsten Karten im Voraus sehen). Andere Clients lösen das per
 *    `drawRequest` aus, der Host verarbeitet ihn reaktiv.
 *  - Verlässt der Host mitten in einer Hand den Raum (neuer Host ohne eigenes
 *    Deck), wird die Hand sauber abgebrochen (Einsätze zurückerstattet) statt
 *    einzufrieren.
 */
(function () {
  'use strict';
  window.App = window.App || {}; App.Minigames = App.Minigames || {};
  var UI = App.UI, el = UI.el, E = App.PokerEngine, fmt = function (n) { return App.MG.fmt(n); };

  injectStyle();

  var VARIANTS = {
    holdem: {
      id: 'holdem', label: "Texas Hold'em", icon: '♠️', order: 40, minPlayers: 2, maxPlayers: 12,
      holeCards: 2, community: true, streets: ['preflop', 'flop', 'turn', 'river'],
      startStack: 1000, smallBlind: 10, bigBlind: 20,
      subtitle: 'Der Klassiker – 2 Handkarten + Board, bis zu 12 Spieler'
    },
    omaha: {
      id: 'omaha', label: 'Omaha', icon: '♣️', order: 41, minPlayers: 2, maxPlayers: 10,
      holeCards: 4, community: true, omahaRule: true, streets: ['preflop', 'flop', 'turn', 'river'],
      startStack: 1000, smallBlind: 10, bigBlind: 20,
      subtitle: '4 Handkarten, genau 2 zählen fürs Blatt – bis zu 10 Spieler'
    },
    stud: {
      id: 'stud', label: 'Seven Card Stud', icon: '♦️', order: 42, minPlayers: 2, maxPlayers: 7,
      stud: true, streets: ['third', 'fourth', 'fifth', 'sixth', 'seventh'],
      startStack: 1000, ante: 5, bringIn: 10, smallBet: 20,
      subtitle: '7 Karten, kein gemeinsames Board – bis zu 7 Spieler (Kartendeck-Limit)'
    },
    draw: {
      id: 'draw', label: 'Five Card Draw', icon: '♥️', order: 43, minPlayers: 2, maxPlayers: 8,
      draw: true, streets: ['bet1', 'draw', 'bet2'],
      startStack: 1000, smallBlind: 10, bigBlind: 20,
      subtitle: '5 Karten, einmal tauschen erlaubt – bis zu 8 Spieler'
    }
  };
  var STREET_NAMES = {
    preflop: 'Preflop', flop: 'Flop', turn: 'Turn', river: 'River',
    third: '3. Straße', fourth: '4. Straße', fifth: '5. Straße', sixth: '6. Straße', seventh: '7. Straße',
    bet1: 'Setzrunde 1', draw: 'Karten tauschen', bet2: 'Setzrunde 2', showdown: 'Showdown'
  };
  var SUIT_RANK = { c: 0, d: 1, h: 2, s: 3 };
  var NEXT_HAND_DELAY = 6000;

  /* ===================== reine Hilfsfunktionen (deck-frei) ===================== */
  function logPush(sh, entry) { return (sh.log || []).concat([entry]).slice(-30); }
  function cmpArr(a, b) { var len = Math.max(a.length, b.length); for (var i = 0; i < len; i++) { var x = a[i] || 0, y = b[i] || 0; if (x !== y) return x - y; } return 0; }

  function buildToActQueue(seatOrder, startPos, folded, allIn, excludeId) {
    var n = seatOrder.length, q = [];
    for (var i = 0; i < n; i++) {
      var id = seatOrder[(startPos + i) % n];
      if (id === excludeId) continue;
      if (!folded[id] && !allIn[id]) q.push(id);
    }
    return q;
  }
  function buildDrawQueue(seatOrder, startPos, folded) {
    var n = seatOrder.length, q = [];
    for (var i = 0; i < n; i++) {
      var id = seatOrder[(startPos + i) % n];
      if (!folded[id]) q.push(id);
    }
    return q;
  }
  function preflopFirstPos(n) { var bbPos = n === 2 ? 1 : 2; return (bbPos + 1) % n; }
  function sbPos(n) { return n === 2 ? 0 : 1; }
  function bbPos(n) { return n === 2 ? 1 : 2; }

  function pay(sh, id, amt) {
    amt = Math.min(amt, sh.stacks[id] || 0);
    sh.stacks[id] = (sh.stacks[id] || 0) - amt;
    sh.contributed[id] = (sh.contributed[id] || 0) + amt;
    sh.pot = (sh.pot || 0) + amt;
    if (sh.stacks[id] <= 0) { sh.stacks[id] = 0; sh.allIn[id] = true; }
    return amt;
  }
  function postBlind(sh, id, amt) { sh.bets[id] = pay(sh, id, amt); }
  function resetStreetBets(sh) { sh.bets = {}; sh.currentBet = 0; }

  function upScore(cardStrs) {
    var objs = cardStrs.map(E.parseCard);
    var ranks = objs.map(function (c) { return c.r; }).sort(function (a, b) { return b - a; });
    var counts = {}; ranks.forEach(function (r) { counts[r] = (counts[r] || 0) + 1; });
    var groups = Object.keys(counts).map(Number).map(function (r) { return { r: r, c: counts[r] }; });
    groups.sort(function (a, b) { return b.c - a.c || b.r - a.r; });
    var score = [];
    groups.forEach(function (g) { score.push(g.c * 20 + g.r); });
    return score;
  }
  function lowestUpCard(sh, ids) {
    var best = null, bestKey = null;
    ids.forEach(function (id) {
      var c = E.parseCard(sh.studCards[id].up[0]);
      var key = c.r * 10 + SUIT_RANK[c.s];
      if (bestKey === null || key < bestKey) { bestKey = key; best = id; }
    });
    return best;
  }
  function bestShowing(sh, ids) {
    var best = null, bestId = null, bestLast = null;
    ids.forEach(function (id) {
      var up = sh.studCards[id].up;
      var sc = upScore(up);
      var last = E.parseCard(up[up.length - 1]);
      var better = !best || cmpArr(sc, best) > 0 || (cmpArr(sc, best) === 0 && SUIT_RANK[last.s] > SUIT_RANK[bestLast.s]);
      if (better) { best = sc; bestId = id; bestLast = last; }
    });
    return bestId;
  }

  /* Klont den vollständigen Shared-State (nur so lässt sich jede Aktion als
     ein einziges room.setShared() ohne vergessene Teilschlüssel verschicken). */
  function cloneSh(sh) {
    function cloneMap(m) { var o = {}; Object.keys(m || {}).forEach(function (k) { o[k] = m[k]; }); return o; }
    function cloneStudMap(m) {
      var o = {}; Object.keys(m || {}).forEach(function (k) { o[k] = { down: (m[k].down || []).slice(), up: (m[k].up || []).slice() }; });
      return o;
    }
    function cloneHoleMap(m) { var o = {}; Object.keys(m || {}).forEach(function (k) { o[k] = (m[k] || []).slice(); }); return o; }
    return {
      variant: sh.variant, handNum: sh.handNum, seatOrder: (sh.seatOrder || []).slice(),
      stacks: cloneMap(sh.stacks), folded: cloneMap(sh.folded), allIn: cloneMap(sh.allIn),
      bets: cloneMap(sh.bets), contributed: cloneMap(sh.contributed),
      community: (sh.community || []).slice(), holeCards: cloneHoleMap(sh.holeCards), studCards: cloneStudMap(sh.studCards),
      pot: sh.pot || 0, currentBet: sh.currentBet || 0, minRaise: sh.minRaise || 0, lastRaiserId: sh.lastRaiserId || null,
      toAct: (sh.toAct || []).slice(), street: sh.street || null, streetIdx: sh.streetIdx == null ? -1 : sh.streetIdx,
      result: sh.result || null, log: (sh.log || []).slice(), gameOver: !!sh.gameOver,
      drawRequest: sh.drawRequest || null, nextHandAt: sh.nextHandAt || null
    };
  }

  /* ===================== Spieler-Aktionen (client-seitig berechnet) ===================== */
  function applyFold(sh, id) {
    sh.folded[id] = true;
    sh.toAct = sh.toAct.filter(function (x) { return x !== id; });
    sh.log = logPush(sh, { a: 'fold', id: id });
  }
  function applyCheck(sh, id) {
    sh.toAct = sh.toAct.filter(function (x) { return x !== id; });
    sh.log = logPush(sh, { a: 'check', id: id });
  }
  function applyCall(sh, id) {
    var owe = sh.currentBet - (sh.bets[id] || 0);
    var pd = pay(sh, id, Math.max(0, owe));
    sh.bets[id] = (sh.bets[id] || 0) + pd;
    sh.toAct = sh.toAct.filter(function (x) { return x !== id; });
    sh.log = logPush(sh, { a: (pd < owe ? 'allincall' : 'call'), id: id, amt: pd });
  }
  function applyBetRaise(sh, id, toAmount) {
    var have = sh.bets[id] || 0;
    var stack = sh.stacks[id] || 0;
    var target = Math.min(toAmount, have + stack);
    var delta = Math.max(0, target - have);
    var wasOpen = sh.currentBet === 0;
    sh.stacks[id] = stack - delta;
    sh.bets[id] = have + delta;
    sh.contributed[id] = (sh.contributed[id] || 0) + delta;
    sh.pot = (sh.pot || 0) + delta;
    if (sh.stacks[id] <= 0) { sh.stacks[id] = 0; sh.allIn[id] = true; }
    if (sh.bets[id] > sh.currentBet) {
      // Echte Erhöhung -> Aktion öffnet sich für alle anderen erneut.
      var raiseSize = sh.bets[id] - sh.currentBet;
      if (raiseSize > sh.minRaise) sh.minRaise = raiseSize;
      sh.currentBet = sh.bets[id];
      sh.lastRaiserId = id;
      sh.toAct = buildToActQueue(sh.seatOrder, sh.seatOrder.indexOf(id), sh.folded, sh.allIn, id);
      sh.log = logPush(sh, { a: (wasOpen ? 'bet' : 'raise'), id: id, amt: sh.bets[id] });
    } else {
      // Kurzer All-in unterhalb des aktuellen Einsatzes -> zählt wie ein Call, öffnet die Runde NICHT erneut.
      sh.toAct = sh.toAct.filter(function (x) { return x !== id; });
      sh.log = logPush(sh, { a: 'allincall', id: id, amt: sh.bets[id] });
    }
  }

  /* ===================== Host: Karten/Deck (pro Tisch-Session lokal) ===================== */
  function makeTableEngine(V) {
    var handDeck = [], muckPile = [], dealtHandNum = -1;

    function draw(n) {
      if (handDeck.length < n && muckPile.length) { handDeck = handDeck.concat(E.shuffle(muckPile)); muckPile = []; }
      return handDeck.splice(0, n);
    }
    function computeSeatOrder(playersList, stacks, dealerAnchorId) {
      var eligible = playersList.filter(function (p) { return stacks[p.id] == null || stacks[p.id] > 0; }).map(function (p) { return p.id; });
      if (!eligible.length) return [];
      var startIdx = 0;
      if (dealerAnchorId) { var i = eligible.indexOf(dealerAnchorId); startIdx = i >= 0 ? (i + 1) % eligible.length : 0; }
      return eligible.slice(startIdx).concat(eligible.slice(0, startIdx));
    }
    function postAntesOrBlinds(sh) {
      var n = sh.seatOrder.length;
      if (V.stud) {
        sh.seatOrder.forEach(function (id) { pay(sh, id, V.ante); });
      } else {
        var sb = sh.seatOrder[sbPos(n)], bb = sh.seatOrder[bbPos(n)];
        postBlind(sh, sb, V.smallBlind); postBlind(sh, bb, V.bigBlind);
        sh.currentBet = V.bigBlind;
      }
    }
    function dealInitial(sh) {
      if (V.community) sh.seatOrder.forEach(function (id) { sh.holeCards[id] = draw(V.holeCards); });
      else if (V.stud) sh.seatOrder.forEach(function (id) { sh.studCards[id] = { down: draw(2), up: draw(1) }; });
      else if (V.draw) sh.seatOrder.forEach(function (id) { sh.holeCards[id] = draw(5); });
    }

    function beginStreet(sh, idx) {
      sh.streetIdx = idx; sh.street = V.streets[idx];
      var n = sh.seatOrder.length;
      var nonFolded = sh.seatOrder.filter(function (id) { return !sh.folded[id]; });
      var canAct = nonFolded.filter(function (id) { return !sh.allIn[id]; });
      sh.lastRaiserId = null;

      if (V.community) {
        if (idx === 1) sh.community = sh.community.concat(draw(3));
        else if (idx === 2 || idx === 3) sh.community = sh.community.concat(draw(1));
        if (idx > 0) resetStreetBets(sh);
        sh.minRaise = V.bigBlind;
        var firstPos = idx === 0 ? preflopFirstPos(n) : (1 % n);
        sh.toAct = canAct.length > 1 ? buildToActQueue(sh.seatOrder, firstPos, sh.folded, sh.allIn) : [];
      } else if (V.stud) {
        if (idx === 0) {
          var bringId = lowestUpCard(sh, nonFolded);
          var amt = pay(sh, bringId, V.bringIn);
          sh.bets[bringId] = amt; sh.currentBet = amt; sh.minRaise = V.smallBet;
          sh.toAct = canAct.length > 1 ? buildToActQueue(sh.seatOrder, sh.seatOrder.indexOf(bringId), sh.folded, sh.allIn, bringId) : [];
        } else {
          if (idx < 4) nonFolded.forEach(function (id) { sh.studCards[id].up = sh.studCards[id].up.concat(draw(1)); });
          else nonFolded.forEach(function (id) { sh.studCards[id].down = sh.studCards[id].down.concat(draw(1)); });
          resetStreetBets(sh);
          sh.minRaise = V.smallBet;
          var firstId = bestShowing(sh, nonFolded);
          sh.toAct = canAct.length > 1 ? buildToActQueue(sh.seatOrder, sh.seatOrder.indexOf(firstId), sh.folded, sh.allIn) : [];
        }
      } else if (V.draw) {
        if (idx === 0) {
          sh.minRaise = V.bigBlind;
          var fp = preflopFirstPos(n);
          sh.toAct = canAct.length > 1 ? buildToActQueue(sh.seatOrder, fp, sh.folded, sh.allIn) : [];
        } else if (idx === 1) {
          sh.toAct = buildDrawQueue(sh.seatOrder, 1 % n, sh.folded);
        } else if (idx === 2) {
          resetStreetBets(sh); sh.minRaise = V.bigBlind;
          sh.toAct = canAct.length > 1 ? buildToActQueue(sh.seatOrder, 1 % n, sh.folded, sh.allIn) : [];
        }
      }
    }

    function startHand(prevSh, playersList) {
      var stacks = (prevSh && prevSh.stacks) || {};
      var dealerAnchor = (prevSh && prevSh.seatOrder && prevSh.seatOrder.length) ? prevSh.seatOrder[0] : null;
      var seatOrder = computeSeatOrder(playersList, stacks, dealerAnchor);
      var newStacks = {};
      playersList.forEach(function (p) { newStacks[p.id] = stacks[p.id] != null ? stacks[p.id] : V.startStack; });

      var sh = {
        variant: V.id, handNum: (prevSh ? prevSh.handNum : 0) + 1, seatOrder: seatOrder, stacks: newStacks,
        folded: {}, allIn: {}, bets: {}, contributed: {}, toAct: [],
        community: [], holeCards: {}, studCards: {},
        pot: 0, currentBet: 0, minRaise: V.bigBlind || V.bringIn || 20, lastRaiserId: null,
        result: null, log: [], gameOver: false, street: null, streetIdx: -1, drawRequest: null, nextHandAt: null
      };
      if (seatOrder.length < 2) { sh.gameOver = true; dealtHandNum = sh.handNum; return sh; }

      handDeck = E.shuffle(E.makeDeck()); muckPile = [];
      dealtHandNum = sh.handNum;
      postAntesOrBlinds(sh);
      dealInitial(sh);
      beginStreet(sh, 0);
      return sh;
    }

    function resolveShowdown(sh) {
      var contenders = sh.seatOrder.filter(function (id) { return !sh.folded[id]; });
      var handsById = {};
      contenders.forEach(function (id) {
        var best;
        if (V.community) {
          var hole = sh.holeCards[id].map(E.parseCard), board = sh.community.map(E.parseCard);
          best = V.omahaRule ? E.bestOmahaHand(hole, board) : E.bestHand(hole.concat(board));
        } else if (V.stud) {
          best = E.bestHand(sh.studCards[id].down.concat(sh.studCards[id].up).map(E.parseCard));
        } else {
          best = E.bestHand(sh.holeCards[id].map(E.parseCard));
        }
        handsById[id] = best;
      });
      var pots = E.computeSidePots(sh.contributed, sh.folded);
      var awarded = {}, potResults = [];
      pots.forEach(function (pot) {
        var best = null, winners = [];
        pot.eligible.forEach(function (id) {
          var sc = handsById[id].score;
          if (!best || E.cmpScore(sc, best) > 0) { best = sc; winners = [id]; }
          else if (E.cmpScore(sc, best) === 0) winners.push(id);
        });
        var share = Math.floor(pot.amount / winners.length);
        var rem = pot.amount - share * winners.length;
        winners.forEach(function (id, i) { awarded[id] = (awarded[id] || 0) + share + (i < rem ? 1 : 0); });
        potResults.push({ amount: pot.amount, winners: winners, score: best });
      });
      Object.keys(awarded).forEach(function (id) { sh.stacks[id] = (sh.stacks[id] || 0) + awarded[id]; });
      var reveals = {};
      contenders.forEach(function (id) {
        reveals[id] = { cards: handsById[id].cards.map(function (c) { return c.str; }), desc: E.describe(handsById[id].score) };
      });
      sh.result = { reveals: reveals, pots: potResults, awarded: awarded, contenders: contenders };
      sh.street = 'showdown'; sh.pot = 0;
    }
    function awardUncontested(sh) {
      var winnerId = sh.seatOrder.filter(function (id) { return !sh.folded[id]; })[0];
      var total = sh.pot;
      sh.stacks[winnerId] = (sh.stacks[winnerId] || 0) + total;
      sh.result = { uncontested: true, winnerId: winnerId, amount: total, reveals: {}, pots: [], awarded: {} };
      sh.street = 'showdown'; sh.pot = 0;
    }
    function processDrawRequest(sh) {
      var req = sh.drawRequest;
      if (!req || sh.toAct[0] !== req.id) { sh.drawRequest = null; return; }
      var hand = sh.holeCards[req.id] || [];
      var discards = (req.discards || []).filter(function (i) { return i >= 0 && i < hand.length; });
      var keep = hand.filter(function (c, i) { return discards.indexOf(i) < 0; });
      muckPile = muckPile.concat(discards.map(function (i) { return hand[i]; }));
      var fresh = draw(discards.length);
      sh.holeCards[req.id] = keep.concat(fresh);
      sh.toAct = sh.toAct.slice(1);
      sh.drawRequest = null;
      sh.log = logPush(sh, { a: 'draw', id: req.id, n: discards.length });
    }

    return {
      startHand: startHand, beginStreet: beginStreet, resolveShowdown: resolveShowdown,
      awardUncontested: awardUncontested, processDrawRequest: processDrawRequest,
      dealtHandNum: function () { return dealtHandNum; }
    };
  }

  /* ===================== UI ===================== */
  function renderPoker(V, root, ctx) {
    var room = ctx.room, destroyed = false, curShared = null, timers = [];
    var engine = makeTableEngine(V);
    var nextHandTimer = null;
    var selDiscard = {}; // Draw-Variante: gewählte Kartenindizes zum Tauschen (lokal, vor dem Absenden)

    function after(ms, fn) { var t = setTimeout(function () { if (!destroyed) fn(); }, ms); timers.push(t); return t; }
    function clearTimers() { timers.forEach(clearTimeout); timers = []; if (nextHandTimer) { clearTimeout(nextHandTimer); nextHandTimer = null; } }

    function nameOf(id) {
      var p = room.players().filter(function (x) { return x.id === id; })[0];
      return p ? p.name : '???';
    }
    function myId() { return ctx.me.id; }

    /* ---- Host: reaktive Automatik ---- */
    function hostTick(sh) {
      if (!room.isHost() || destroyed) return;
      if (!sh || sh.gameOver) return;
      if (room.players().length < 2) return;

      if (sh.street && engine.dealtHandNum() !== sh.handNum) {
        // Host-Wechsel mitten in einer Hand: kein eigenes Deck vorhanden -> sauber abbrechen, Einsätze zurück.
        var s2 = cloneSh(sh);
        s2.seatOrder.forEach(function (id) { s2.stacks[id] = (s2.stacks[id] || 0) + (s2.contributed[id] || 0); s2.contributed[id] = 0; });
        s2.pot = 0; s2.result = { aborted: true, reveals: {}, pots: [], awarded: {} }; s2.street = 'showdown';
        scheduleNextHand(s2);
        room.setShared(s2);
        return;
      }
      if (sh.result) { scheduleNextHand(sh); return; }

      var nonFolded = sh.seatOrder.filter(function (id) { return !sh.folded[id]; });
      if (nonFolded.length <= 1) { var s3 = cloneSh(sh); engine.awardUncontested(s3); scheduleNextHand(s3); room.setShared(s3); return; }

      if (V.draw && sh.street === 'draw' && sh.drawRequest) {
        var s4 = cloneSh(sh); engine.processDrawRequest(s4); room.setShared(s4); return;
      }
      if (sh.toAct.length === 0) {
        var s5 = cloneSh(sh);
        if (s5.streetIdx + 1 < V.streets.length) engine.beginStreet(s5, s5.streetIdx + 1);
        else engine.resolveShowdown(s5);
        if (s5.result) scheduleNextHand(s5);
        room.setShared(s5);
      }
    }
    function scheduleNextHand(sh) {
      if (nextHandTimer) return;
      var targetHand = sh.handNum;
      sh.nextHandAt = room.now() + NEXT_HAND_DELAY;
      nextHandTimer = setTimeout(function () {
        nextHandTimer = null;
        if (destroyed || !room.isHost()) return;
        var latest = room.snapshot() && room.snapshot().shared;
        if (!latest || latest.handNum !== targetHand || !latest.result) return;
        var freshPlayers = room.players();
        var newSh = engine.startHand(latest, freshPlayers);
        room.setShared(newSh);
      }, NEXT_HAND_DELAY);
    }
    function hostNewGame() {
      if (!room.isHost()) return;
      var newSh = engine.startHand(null, room.players());
      room.setShared(newSh);
    }

    /* ---- Client: Aktionen ---- */
    function doAction(kind, amount) {
      if (!curShared || curShared.toAct[0] !== myId()) return;
      var sh = cloneSh(curShared), id = myId();
      if (kind === 'fold') applyFold(sh, id);
      else if (kind === 'check') { if (sh.currentBet !== (sh.bets[id] || 0)) { UI.toast('Erst callen oder folden', 'info'); return; } applyCheck(sh, id); }
      else if (kind === 'call') applyCall(sh, id);
      else if (kind === 'allin') applyBetRaise(sh, id, (sh.bets[id] || 0) + (sh.stacks[id] || 0));
      else if (kind === 'bet') applyBetRaise(sh, id, amount);
      room.setShared(sh);
    }
    function submitDraw() {
      if (!curShared || curShared.toAct[0] !== myId()) return;
      var idxs = Object.keys(selDiscard).map(Number);
      room.setShared({ drawRequest: { id: myId(), discards: idxs } });
      selDiscard = {};
    }

    /* ---- Rendering ---- */
    function cardEl(str, small) {
      var c = E.parseCard(str), red = E.isRed(c.s);
      return el('div', { class: 'pk-card' + (red ? ' red' : '') + (small ? ' sm' : '') }, [
        el('span', { class: 'pk-rank' }, [E.rankChar(c.r)]), el('span', { class: 'pk-suit' }, [E.suitSymbol(c.s)])
      ]);
    }
    function cardBackEl(small) { return el('div', { class: 'pk-card back' + (small ? ' sm' : '') }, ['🂠']); }

    function actionLabel(a) {
      var nm = nameOf(a.id);
      if (a.a === 'fold') return nm + ' foldet';
      if (a.a === 'check') return nm + ' checkt';
      if (a.a === 'call') return nm + ' callt ' + fmt(a.amt);
      if (a.a === 'allincall') return nm + ' callt all-in (' + fmt(a.amt) + ')';
      if (a.a === 'bet') return nm + ' setzt ' + fmt(a.amt);
      if (a.a === 'raise') return nm + ' erhöht auf ' + fmt(a.amt);
      if (a.a === 'draw') return nm + ' tauscht ' + a.n + ' Karte' + (a.n === 1 ? '' : 'n');
      return nm;
    }

    function seatBadges(sh, id) {
      var n = sh.seatOrder.length, badges = [];
      if (sh.seatOrder[0] === id) badges.push(el('span', { class: 'pk-badge dealer' }, ['D']));
      if (!V.stud) {
        if (sh.seatOrder[sbPos(n)] === id) badges.push(el('span', { class: 'pk-badge' }, ['SB']));
        if (sh.seatOrder[bbPos(n)] === id) badges.push(el('span', { class: 'pk-badge' }, ['BB']));
      }
      if (sh.folded[id]) badges.push(el('span', { class: 'pk-badge fold' }, ['Fold']));
      else if (sh.allIn[id]) badges.push(el('span', { class: 'pk-badge allin' }, ['All-in']));
      return badges;
    }

    function seatCardsEl(sh, id, showAll) {
      var mine = id === myId();
      var reveal = showAll || mine;
      if (V.community || V.draw) {
        var hole = sh.holeCards[id] || [];
        if (!hole.length) return el('div', { class: 'pk-seat-cards' });
        return el('div', { class: 'pk-seat-cards' }, hole.map(function (c) { return reveal ? cardEl(c, true) : cardBackEl(true); }));
      }
      if (V.stud) {
        var sc = sh.studCards[id] || { down: [], up: [] };
        var downEls = sc.down.map(function (c) { return reveal ? cardEl(c, true) : cardBackEl(true); });
        var upEls = sc.up.map(function (c) { return cardEl(c, true); });
        return el('div', { class: 'pk-seat-cards' }, downEls.concat(upEls));
      }
      return el('div', { class: 'pk-seat-cards' });
    }

    function seatEl(sh, id) {
      var isMe = id === myId(), isTurn = sh.toAct[0] === id && !sh.result;
      var bet = sh.bets[id] || 0, stack = sh.stacks[id] || 0;
      var showAll = !!(sh.result && sh.result.contenders && sh.result.contenders.indexOf(id) >= 0);
      return el('div', { class: 'pk-seat glass' + (isMe ? ' me' : '') + (isTurn ? ' turn' : '') + (sh.folded[id] ? ' folded' : '') }, [
        el('div', { class: 'pk-seat-head' }, [
          el('span', { class: 'pk-seat-name' }, [nameOf(id) + (isMe ? ' (du)' : '')]),
          el('div', { class: 'pk-seat-badges' }, seatBadges(sh, id))
        ]),
        seatCardsEl(sh, id, showAll),
        sh.result && sh.result.reveals && sh.result.reveals[id] ? el('div', { class: 'pk-seat-desc' }, [sh.result.reveals[id].desc]) : null,
        el('div', { class: 'pk-seat-foot' }, [
          el('span', { class: 'pk-seat-stack' }, ['💰 ' + fmt(stack)]),
          bet > 0 ? el('span', { class: 'pk-seat-bet' }, ['🔸 ' + fmt(bet)]) : null
        ])
      ]);
    }

    function communityEl(sh) {
      if (!V.community) return null;
      var slots = [];
      for (var i = 0; i < 5; i++) slots.push(sh.community[i] ? cardEl(sh.community[i]) : el('div', { class: 'pk-card empty' }));
      return el('div', { class: 'pk-community' }, slots);
    }

    function myDrawCardsEl(sh) {
      var hand = sh.holeCards[myId()] || [];
      var isMyTurn = sh.toAct[0] === myId() && sh.street === 'draw';
      var cardsEl = hand.map(function (c, i) {
        var picked = !!selDiscard[i];
        var card = cardEl(c);
        var wrap = el('div', { class: 'pk-draw-card' + (picked ? ' picked' : '') }, [card, el('div', { class: 'pk-draw-flag' }, [picked ? 'Tauschen' : 'Behalten'])]);
        if (isMyTurn) wrap.addEventListener('click', function () { if (picked) delete selDiscard[i]; else selDiscard[i] = true; renderAll(); });
        return wrap;
      });
      return el('div', { class: 'pk-mine' }, [
        el('div', { class: 'pk-field-title' }, ['Deine Karten' + (isMyTurn ? ' — anklicken zum Tauschen' : '')]),
        el('div', { class: 'pk-mine-row' }, cardsEl),
        isMyTurn ? el('button', { class: 'btn btn-primary btn-block', type: 'button', onclick: submitDraw }, [Object.keys(selDiscard).length ? ('Karten tauschen (' + Object.keys(selDiscard).length + ')') : 'Karten behalten (Stand pat)']) : null
      ]);
    }
    function myHandEl(sh) {
      var mine = (V.community ? sh.holeCards[myId()] : (V.stud ? (sh.studCards[myId()] ? sh.studCards[myId()].down.concat(sh.studCards[myId()].up) : []) : sh.holeCards[myId()])) || [];
      if (!mine.length) return null;
      return el('div', { class: 'pk-mine' }, [
        el('div', { class: 'pk-field-title' }, ['Deine Karten']),
        el('div', { class: 'pk-mine-row' }, mine.map(function (c) { return cardEl(c); }))
      ]);
    }

    function actionBar(sh) {
      var id = myId();
      if (sh.result || sh.toAct[0] !== id) return null;
      if (V.draw && sh.street === 'draw') return null; // eigene Draw-UI übernimmt das
      var myBet = sh.bets[id] || 0, stack = sh.stacks[id] || 0, toCall = sh.currentBet - myBet;
      var minTotal = sh.currentBet + sh.minRaise, maxTotal = myBet + stack;
      var amountInput = el('input', { class: 'text-input pk-amount', type: 'number', min: Math.min(minTotal, maxTotal), max: maxTotal, step: 1, value: String(Math.min(minTotal, maxTotal)) });
      var btns = [];
      btns.push(el('button', { class: 'btn btn-ghost', type: 'button', onclick: function () { doAction('fold'); } }, ['✖ Fold']));
      if (toCall <= 0) btns.push(el('button', { class: 'btn btn-aqua', type: 'button', onclick: function () { doAction('check'); } }, ['✔ Check']));
      else btns.push(el('button', { class: 'btn btn-aqua', type: 'button', onclick: function () { doAction('call'); } }, ['Call ' + fmt(Math.min(toCall, stack))]));
      if (stack > 0) {
        btns.push(el('button', { class: 'btn btn-primary', type: 'button', onclick: function () {
          var lo = Math.min(minTotal, maxTotal);
          var raw = Math.floor(Number(amountInput.value) || 0);
          var v = Math.max(lo, Math.min(maxTotal, raw));
          doAction('bet', v);
        } }, [sh.currentBet > 0 ? 'Erhöhen' : 'Setzen']));
        btns.push(el('button', { class: 'btn btn-gold', type: 'button', onclick: function () { doAction('allin'); } }, ['🔥 All-in']));
      }
      return el('div', { class: 'pk-actions' }, [
        stack > 0 ? el('div', { class: 'pk-amount-row' }, [amountInput, el('span', { class: 'hint-text' }, ['min ' + fmt(Math.min(minTotal, maxTotal)) + ' · max ' + fmt(maxTotal)])]) : null,
        el('div', { class: 'pk-action-btns' }, btns)
      ]);
    }

    function showdownEl(sh) {
      if (!sh.result) return null;
      var r = sh.result, lines = [];
      if (r.aborted) lines.push(el('p', {}, ['Hand abgebrochen (Host-Wechsel) — Einsätze wurden zurückerstattet.']));
      else if (r.uncontested) lines.push(el('p', {}, [nameOf(r.winnerId) + ' gewinnt ' + fmt(r.amount) + ' Coins (alle anderen haben gefoldet).']));
      else (r.pots || []).forEach(function (p, i) {
        var names = p.winners.map(nameOf).join(' & ');
        lines.push(el('p', {}, [(p.winners.length > 1 ? 'Split-' : '') + 'Pot ' + (i + 1) + ': ' + names + ' gewinnt ' + fmt(p.amount) + ' mit ' + E.describe(p.score) + '.']));
      });
      return el('div', { class: 'pk-showdown glass' }, [el('h3', { class: 'neon' }, ['🏆 Showdown']), el('div', { class: 'pk-showdown-lines' }, lines), el('p', { class: 'hint-text' }, ['Nächste Hand startet automatisch …'])]);
    }

    function gameOverEl(sh) {
      var standings = room.players().map(function (p) { return { id: p.id, name: p.name, stack: (sh.stacks && sh.stacks[p.id]) || 0 }; })
        .sort(function (a, b) { return b.stack - a.stack; });
      return el('div', { class: 'pk-showdown glass' }, [
        el('h3', { class: 'neon' }, ['🏁 Spiel beendet']),
        el('div', { class: 'pk-showdown-lines' }, standings.map(function (s, i) { return el('p', {}, [(i + 1) + '. ' + s.name + ' — ' + fmt(s.stack)]); })),
        room.isHost() ? el('button', { class: 'btn btn-primary btn-block', type: 'button', onclick: hostNewGame }, ['🔄 Neues Spiel']) : el('p', { class: 'hint-text' }, ['Warte auf den Host …'])
      ]);
    }

    function logEl(sh) {
      var entries = (sh.log || []).slice(-8).reverse();
      return el('div', { class: 'pk-log' }, entries.map(function (a) { return el('div', { class: 'pk-log-line' }, [actionLabel(a)]); }));
    }

    function waitingEl(msg) {
      return el('div', { class: 'pk-wait glass' }, [el('div', { class: 'pk-wait-icon' }, [V.icon]), el('h3', { class: 'neon' }, [V.label]), el('p', { class: 'hint-text' }, [msg]), el('button', { class: 'btn btn-ghost', type: 'button', onclick: ctx.onExit }, ['Zurück zur Lobby'])]);
    }

    function renderAll() {
      if (destroyed) return;
      root.innerHTML = '';
      var sh = curShared;
      if (room.players().length < 2) { root.appendChild(waitingEl('Warte auf mindestens 2 Spieler …')); return; }
      if (!sh || !sh.seatOrder || !sh.seatOrder.length) {
        if (room.isHost()) {
          var freshSh = engine.startHand(null, room.players());
          room.setShared(freshSh);
          return; // setShared löst beim Host synchron ein erneutes onShared()/renderAll() aus
        }
        root.appendChild(waitingEl('Tisch wird eröffnet …')); return;
      }
      if (sh.gameOver) { root.appendChild(gameOverEl(sh)); return; }

      var wrap = el('div', { class: 'pk-wrap' });
      wrap.appendChild(el('div', { class: 'pk-head' }, [
        el('span', { class: 'pk-head-title' }, [V.icon + ' ' + V.label + ' · Hand #' + sh.handNum]),
        el('span', { class: 'pk-head-street' }, [STREET_NAMES[sh.street] || '']),
        el('span', { class: 'pk-head-pot' }, ['Pot: ' + fmt(sh.pot)])
      ]));
      var commEl = communityEl(sh); if (commEl) wrap.appendChild(commEl);

      var seatsRow = el('div', { class: 'pk-seats' }, sh.seatOrder.map(function (id) { return seatEl(sh, id); }));
      wrap.appendChild(seatsRow);

      if (!sh.result && sh.toAct[0]) {
        wrap.appendChild(el('div', { class: 'pk-turnline' }, [sh.toAct[0] === myId() ? 'Du bist dran' : (nameOf(sh.toAct[0]) + ' ist dran')]));
      }

      if (sh.result) wrap.appendChild(showdownEl(sh));
      else if (V.draw && sh.street === 'draw') { if (sh.toAct[0] === myId()) wrap.appendChild(myDrawCardsEl(sh)); else { var mh = myHandEl(sh); mh && wrap.appendChild(mh); wrap.appendChild(el('p', { class: 'hint-text' }, ['Warte, bis alle getauscht haben …'])); } }
      else {
        var mh2 = myHandEl(sh); mh2 && wrap.appendChild(mh2);
        var bar = actionBar(sh); bar && wrap.appendChild(bar);
      }

      wrap.appendChild(logEl(sh));
      root.appendChild(wrap);
    }

    /* ---- Room-Events ---- */
    function onShared(sh) {
      if (destroyed) return;
      curShared = sh || null;
      renderAll();
      if (room.isHost()) hostTick(curShared);
    }
    function onPlayers() { if (destroyed) return; renderAll(); if (room.isHost()) hostTick(curShared); }

    room.on('shared', onShared);
    room.on('players', onPlayers);
    var snap = room.snapshot();
    onShared(snap ? snap.shared : null);

    return { cleanup: function () { destroyed = true; clearTimers(); room.off('shared', onShared); room.off('players', onPlayers); } };
  }

  Object.keys(VARIANTS).forEach(function (key) {
    var V = VARIANTS[key];
    App.Minigames['poker_' + key] = {
      id: 'poker_' + key, title: '🃏 Poker – ' + V.label, icon: V.icon, order: V.order,
      subtitle: V.subtitle, single: false, multi: true, minPlayers: V.minPlayers, maxPlayers: V.maxPlayers,
      render: function (root, ctx) { return renderPoker(V, root, ctx); }
    };
  });

  /* ===================== Styles ===================== */
  function injectStyle() {
    UI.injectStyle('mg-poker-css', [
      '.pk-wrap{display:flex;flex-direction:column;gap:14px;max-width:900px;margin:0 auto;}',
      '.pk-head{display:flex;flex-wrap:wrap;gap:10px;align-items:center;justify-content:space-between;padding:10px 14px;border-radius:12px;background:rgba(9,32,21,.6);border:1px solid var(--stroke);}',
      '.pk-head-title{font-weight:800;}',
      '.pk-head-street{color:var(--aqua-soft);font-weight:700;}',
      '.pk-head-pot{color:var(--gold);font-weight:800;}',
      '.pk-community{display:flex;gap:8px;justify-content:center;padding:10px;flex-wrap:wrap;}',
      '.pk-card{width:44px;height:62px;border-radius:8px;background:linear-gradient(160deg,#fdfdfd,#e8e8e8);display:flex;flex-direction:column;align-items:center;justify-content:center;font-weight:900;color:#111;box-shadow:0 2px 6px rgba(0,0,0,.4);flex:0 0 auto;}',
      '.pk-card.sm{width:34px;height:48px;font-size:12px;}',
      '.pk-card .pk-rank{font-size:16px;line-height:1;}',
      '.pk-card .pk-suit{font-size:14px;line-height:1;}',
      '.pk-card.red{color:var(--danger);}',
      '.pk-card.back{background:repeating-linear-gradient(45deg,#0a2a1c,#0a2a1c 4px,#123a26 4px,#123a26 8px);color:transparent;border:1px solid var(--stroke-2);}',
      '.pk-card.empty{background:rgba(0,0,0,.25);border:1px dashed var(--stroke);box-shadow:none;}',
      '.pk-seats{display:flex;flex-wrap:wrap;gap:10px;justify-content:center;}',
      '.pk-seat{padding:10px;width:170px;display:flex;flex-direction:column;gap:6px;opacity:.85;transition:.2s;}',
      '.pk-seat.me{border-color:var(--stroke-2);opacity:1;}',
      '.pk-seat.turn{box-shadow:0 0 16px rgba(57,255,20,.5);border-color:var(--neon);opacity:1;}',
      '.pk-seat.folded{opacity:.45;}',
      '.pk-seat-head{display:flex;justify-content:space-between;align-items:center;gap:6px;}',
      '.pk-seat-name{font-weight:700;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.pk-seat-badges{display:flex;gap:4px;}',
      '.pk-badge{font-size:10px;font-weight:800;padding:2px 5px;border-radius:6px;background:rgba(9,32,21,.9);border:1px solid var(--stroke-2);color:var(--gold);}',
      '.pk-badge.dealer{color:#fff;background:rgba(51,230,208,.25);}',
      '.pk-badge.fold{color:var(--danger-2);}',
      '.pk-badge.allin{color:var(--gold);}',
      '.pk-seat-cards{display:flex;gap:4px;flex-wrap:wrap;}',
      '.pk-seat-desc{font-size:11px;color:var(--aqua-soft);font-weight:700;}',
      '.pk-seat-foot{display:flex;justify-content:space-between;font-size:12px;color:var(--muted);font-weight:700;}',
      '.pk-seat-stack{color:var(--leaf);}',
      '.pk-seat-bet{color:var(--gold);}',
      '.pk-turnline{text-align:center;font-weight:800;color:var(--neon);}',
      '.pk-mine{display:flex;flex-direction:column;gap:8px;align-items:center;}',
      '.pk-field-title{font-size:13px;font-weight:800;color:var(--leaf);text-transform:uppercase;letter-spacing:1px;}',
      '.pk-mine-row{display:flex;gap:8px;flex-wrap:wrap;justify-content:center;}',
      '.pk-draw-card{display:flex;flex-direction:column;align-items:center;gap:4px;cursor:pointer;padding:6px;border-radius:10px;border:1px solid transparent;}',
      '.pk-draw-card.picked{border-color:var(--danger);background:rgba(255,77,109,.12);}',
      '.pk-draw-flag{font-size:10px;font-weight:700;color:var(--muted);}',
      '.pk-draw-card.picked .pk-draw-flag{color:var(--danger-2);}',
      '.pk-actions{display:flex;flex-direction:column;gap:10px;max-width:520px;margin:0 auto;width:100%;}',
      '.pk-amount-row{display:flex;gap:10px;align-items:center;}',
      '.pk-amount{width:120px;}',
      '.pk-action-btns{display:flex;gap:8px;flex-wrap:wrap;justify-content:center;}',
      '.pk-showdown{padding:18px;text-align:center;max-width:520px;margin:0 auto;display:flex;flex-direction:column;gap:8px;}',
      '.pk-showdown-lines p{margin:2px 0;font-weight:700;}',
      '.pk-log{display:flex;flex-direction:column;gap:2px;max-width:520px;margin:0 auto;width:100%;opacity:.8;}',
      '.pk-log-line{font-size:12px;color:var(--muted);}',
      '.pk-wait{max-width:420px;margin:24px auto;padding:34px;text-align:center;display:flex;flex-direction:column;gap:14px;align-items:center;}',
      '.pk-wait-icon{font-size:50px;}',
      '.btn-gold{background:linear-gradient(160deg,#ffe07a,var(--gold));color:#231a02;border:none;}'
    ].join(''));
  }
})();
