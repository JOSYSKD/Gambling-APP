/* poker.js — Online-Poker über Raum-Code, bis zu 12 Spieler.
 * Vier klassische Varianten: Texas Hold'em, Omaha, Seven Card Stud, Five Card Draw.
 * Nutzt js/poker-engine.js (Hand-Bewertung/Side-Pots) und den Raum-Code-Mechanismus
 * aus net.js. Jede Aktion (Fold/Check/Call/Bet/Raise, Karten tauschen) wird direkt vom
 * handelnden Spieler über room.setShared() geschrieben — dasselbe Muster wie bei
 * connect4.js. Nur das AUSTEILEN von Karten ist host-exklusiv, weil nur der Host das
 * Kartendeck im Speicher hält (es wird nicht repliziert, damit niemand vorab hineinschaut).
 * Wechselt der Host mitten in einer Hand (z. B. weil der bisherige Host den Tisch
 * verlässt), erkennt der neue Host das über hand.dealHolder, storniert die laufende
 * Hand (Einsätze werden zurückerstattet) und teilt sofort neu.
 */
(function () {
  'use strict';
  window.App = window.App || {};
  App.Minigames = App.Minigames || {};
  var UI = App.UI, el = UI.el, PE = App.PokerEngine;

  var START_STACK = 1000;
  var DEFAULT_MIN_BET = 20;
  var SUIT_SYMBOL = { s: '♠', h: '♥', d: '♦', c: '♣' };
  var SUIT_RED = { h: true, d: true };
  var STREET_LABEL = {
    preflop: 'Vor dem Flop', flop: 'Flop', turn: 'Turn', river: 'River',
    predraw: 'Setzrunde', postdraw: 'Letzte Setzrunde',
    '3rd': '3. Straße', '4th': '4. Straße', '5th': '5. Straße', '6th': '6. Straße', '7th': '7. Straße'
  };

  injectStyle();

  var VARIANTS = [
    {
      key: 'holdem', id: 'poker_holdem', title: "Poker: Texas Hold'em", icon: '♠️', order: 30,
      subtitle: "Bis zu 12 Spieler — 2 Handkarten + 5 Gemeinschaftskarten", minPlayers: 2, maxPlayers: 12,
      holeCount: 2, board: true, smallBlind: 10, bigBlind: 20, smallBet: 20
    },
    {
      key: 'omaha', id: 'poker_omaha', title: 'Poker: Omaha', icon: '♣️', order: 31,
      subtitle: 'Bis zu 10 Spieler — 4 Handkarten, genau 2 zählen ins Blatt', minPlayers: 2, maxPlayers: 10,
      holeCount: 4, board: true, omaha: true, smallBlind: 10, bigBlind: 20, smallBet: 20
    },
    {
      key: 'stud', id: 'poker_stud', title: 'Poker: Seven Card Stud', icon: '♦️', order: 32,
      subtitle: 'Bis zu 7 Spieler — 7 Karten, kein Gemeinschaftsboard', minPlayers: 2, maxPlayers: 7,
      stud: true, ante: 10, bringIn: 15, smallBet: 20
    },
    {
      key: 'draw', id: 'poker_draw', title: 'Poker: Five Card Draw', icon: '♥️', order: 33,
      subtitle: 'Bis zu 8 Spieler — 5 Karten + eine Tausch-Phase', minPlayers: 2, maxPlayers: 8,
      draw: true, smallBlind: 10, bigBlind: 20, smallBet: 20
    }
  ];

  VARIANTS.forEach(function (cfg) {
    App.Minigames[cfg.id] = {
      id: cfg.id, title: cfg.title, icon: cfg.icon, order: cfg.order, subtitle: cfg.subtitle,
      single: false, multi: true, minPlayers: cfg.minPlayers, maxPlayers: cfg.maxPlayers,
      render: function (root, ctx) { return renderTable(root, ctx, cfg); }
    };
  });

  /* ============================ reine Helfer ============================ */
  function deepClone(x) { return JSON.parse(JSON.stringify(x)); }
  function afterId(order, id) {
    var idx = order.indexOf(id);
    if (idx < 0) return order.slice();
    return order.slice(idx + 1).concat(order.slice(0, idx));
  }
  function rotate(order, startIdx) { return order.slice(startIdx).concat(order.slice(0, startIdx)); }
  function firstActive(list, folded, allIn, includeAllIn) {
    for (var i = 0; i < list.length; i++) {
      var id = list[i];
      if (!folded[id] && (includeAllIn || !allIn[id])) return id;
    }
    return null;
  }
  function fmtChips(n) { return Math.round(n || 0).toLocaleString('de-DE'); }

  function nextDealerId(table) {
    var arr = table.participants;
    var idx = arr.map(function (p) { return p.id; }).indexOf(table.dealerId);
    for (var i = 1; i <= arr.length; i++) {
      var cand = arr[(idx + i + arr.length) % arr.length];
      if (!cand.out) return cand.id;
    }
    return table.dealerId;
  }
  function handOrderFrom(table) {
    var arr = table.participants;
    var idx = arr.map(function (p) { return p.id; }).indexOf(table.dealerId);
    var out = [];
    for (var i = 0; i < arr.length; i++) {
      var cand = arr[(idx + i + arr.length) % arr.length];
      if (!cand.out) out.push(cand.id);
    }
    return out;
  }
  function participantOf(table, id) {
    for (var i = 0; i < table.participants.length; i++) if (table.participants[i].id === id) return table.participants[i];
    return null;
  }
  function showingGroups(cards) {
    var byRank = {};
    (cards || []).forEach(function (c) { byRank[c.r] = (byRank[c.r] || 0) + 1; });
    return Object.keys(byRank).map(Number).map(function (r) { return { r: r, n: byRank[r] }; })
      .sort(function (a, b) { return b.n - a.n || b.r - a.r; });
  }
  function cmpShowing(a, b) {
    var n = Math.max(a.length, b.length);
    for (var i = 0; i < n; i++) {
      var A = a[i] || { n: 0, r: 0 }, B = b[i] || { n: 0, r: 0 };
      if (A.n !== B.n) return A.n - B.n;
      if (A.r !== B.r) return A.r - B.r;
    }
    return 0;
  }
  function bestShowingId(hand, order) {
    var bestId = null, bestGroups = null;
    order.forEach(function (id) {
      if (hand.folded[id]) return;
      var g = showingGroups(hand.hands[id].up);
      if (!bestGroups || cmpShowing(g, bestGroups) > 0) { bestGroups = g; bestId = id; }
    });
    return bestId;
  }
  function lowestUpCard(hand, order) {
    var bestId = order[0], bestR = hand.hands[order[0]].up[0].r;
    order.forEach(function (id) {
      var r = hand.hands[id].up[0].r;
      if (r < bestR) { bestR = r; bestId = id; }
    });
    return bestId;
  }
  function evaluateHand(cfg, hand, id) {
    if (cfg.omaha) return PE.bestOmaha(hand.hands[id], hand.board);
    if (cfg.board) return PE.bestOf(hand.hands[id].concat(hand.board));
    if (cfg.stud) return PE.bestOf(hand.hands[id].hole.concat(hand.hands[id].up));
    return PE.bestOf(hand.hands[id]);
  }
  function isLastStreet(cfg, street) {
    if (cfg.stud) return street === '7th';
    if (cfg.draw) return street === 'postdraw';
    return street === 'river';
  }

  /* ============================ Host: Hand-Aufbau ============================ */
  function postBlind(table, hand, order, cfg) {
    var sbId = order.length === 2 ? order[0] : order[1];
    var bbId = order.length === 2 ? order[1] : order[2];
    function post(id, amt) {
      var p = participantOf(table, id);
      var actual = Math.min(amt, p.stack);
      p.stack -= actual; hand.betStreet[id] = actual; hand.totalContrib[id] = (hand.totalContrib[id] || 0) + actual;
      if (p.stack === 0) hand.allIn[id] = true;
    }
    post(sbId, cfg.smallBlind);
    post(bbId, cfg.bigBlind);
    hand.currentBet = cfg.bigBlind;
    hand.minRaise = cfg.bigBlind;
  }

  function freshHand(order, myId) {
    return {
      dealHolder: myId, order: order.slice(), folded: {}, allIn: {}, betStreet: {}, totalContrib: {},
      currentBet: 0, minRaise: DEFAULT_MIN_BET, turn: null, needsAction: [], board: [], hands: {}, log: [],
      street: null, drawSelections: {}, result: null, foldWinner: null
    };
  }

  function logMsg(hand, table, pid, text) {
    var p = participantOf(table, pid);
    hand.log = (hand.log || []).concat([{ n: p ? p.name : '?', t: text }]).slice(-10);
  }

  function enterDrawSelect(hand, order) {
    hand.needsAction = rotate(order, order.length > 1 ? 1 : 0).filter(function (id) { return !hand.folded[id]; });
    hand.turn = hand.needsAction[0] || null;
    hand.drawSelections = {};
  }

  /* Nächster Akteur: erstes Element nach der aktuellen Reihenfolge, das noch in
     needsAction steht (und weder gefoldet noch — sofern relevant — all-in ist). */
  function nextActorGeneric(hand, includeAllIn) {
    if (!hand.needsAction.length) return null;
    var rot = afterId(hand.order, hand.turn).concat([hand.turn]);
    for (var i = 0; i < rot.length; i++) {
      var id = rot[i];
      if (hand.needsAction.indexOf(id) >= 0 && !hand.folded[id] && (includeAllIn || !hand.allIn[id])) return id;
    }
    return null;
  }

  /* Wird von JEDEM Client aufgerufen (kein Deck nötig): entscheidet, ob die Setzrunde
     weitergeht, in die Tauschphase, zum Showdown oder zum nächsten Host-Deal wechselt. */
  function closeStreetIfDone(cfg, shared) {
    var hand = shared.hand;
    var alive = hand.order.filter(function (id) { return !hand.folded[id]; });
    if (alive.length <= 1) { hand.turn = null; hand.needsAction = []; hand.foldWinner = alive[0] || null; shared.stage = 'showdown'; return; }
    if (hand.needsAction.length !== 0) { hand.turn = nextActorGeneric(hand, false); return; }
    hand.turn = null;
    if (cfg.draw && hand.street === 'predraw') {
      enterDrawSelect(hand, hand.order);
      shared.stage = hand.turn ? 'draw-select' : 'showdown';
    } else {
      shared.stage = isLastStreet(cfg, hand.street) ? 'showdown' : 'dealing';
    }
  }

  /* Host-only: Deck-abhängig, wird ausschließlich innerhalb von onSharedUpdate (isHost) gerufen. */
  function settleStreetStart(cfg, shared, startId, hostCtx) {
    var hand = shared.hand, order = hand.order;
    var alive = order.filter(function (id) { return !hand.folded[id]; });
    if (alive.length <= 1) { hand.turn = null; hand.needsAction = []; hand.foldWinner = alive[0] || null; shared.stage = 'showdown'; hostCtx.write(shared); return; }
    var acting = order.filter(function (id) { return !hand.folded[id] && !hand.allIn[id]; });
    if (acting.length < 2) {
      if (cfg.draw && hand.street === 'predraw') {
        enterDrawSelect(hand, order);
        shared.stage = hand.turn ? 'draw-select' : 'showdown';
        hostCtx.write(shared);
        return;
      }
      hostRunOutRemaining(cfg, shared, hostCtx);
      return;
    }
    var startIdx = order.indexOf(startId);
    hand.needsAction = rotate(order, startIdx < 0 ? 0 : startIdx).filter(function (id) { return !hand.folded[id] && !hand.allIn[id]; });
    hand.turn = hand.needsAction[0] || null;
    shared.stage = 'betting';
    hostCtx.write(shared);
  }

  function resetStreetBetting(hand, cfg) {
    hand.betStreet = {}; hand.currentBet = 0; hand.minRaise = cfg.smallBet || DEFAULT_MIN_BET;
  }

  function hostRunOutRemaining(cfg, shared, hostCtx) {
    var hand = shared.hand, order = hand.order, deck = hostCtx.deck;
    if (cfg.board) {
      while (hand.street !== 'river') {
        if (hand.street === 'preflop') hand.board = deck.splice(0, 3);
        else hand.board = hand.board.concat(deck.splice(0, 1));
        hand.street = hand.street === 'preflop' ? 'flop' : (hand.street === 'flop' ? 'turn' : 'river');
      }
    } else if (cfg.stud) {
      while (hand.street !== '7th') {
        var nextStreet = { '3rd': '4th', '4th': '5th', '5th': '6th', '6th': '7th' }[hand.street];
        order.forEach(function (id) {
          if (hand.folded[id]) return;
          if (nextStreet === '7th') hand.hands[id].hole = hand.hands[id].hole.concat(deck.splice(0, 1));
          else hand.hands[id].up = hand.hands[id].up.concat(deck.splice(0, 1));
        });
        hand.street = nextStreet;
      }
    }
    hand.turn = null; hand.needsAction = []; shared.stage = 'showdown';
    hostCtx.write(shared);
  }

  function hostStartHand(cfg, shared, hostCtx) {
    var table = shared.table;
    var alive = table.participants.filter(function (p) { return !p.out; });
    if (alive.length < 2) { shared.hand = null; shared.stage = 'ended'; hostCtx.write(shared); return; }

    table.dealerId = nextDealerId(table);
    table.handNo = (table.handNo || 0) + 1;
    var order = handOrderFrom(table);
    var deck = PE.shuffle(PE.makeDeck());
    hostCtx.deck = deck;

    var hand = freshHand(order, hostCtx.myId);
    shared.hand = hand;

    if (cfg.stud) {
      order.forEach(function (id) {
        var p = participantOf(table, id);
        var a = Math.min(cfg.ante, p.stack); p.stack -= a; hand.totalContrib[id] = a;
      });
      order.forEach(function (id) { hand.hands[id] = { hole: deck.splice(0, 2), up: deck.splice(0, 1) }; });
      hand.street = '3rd';
      var bringId = lowestUpCard(hand, order);
      var bp = participantOf(table, bringId);
      var bi = Math.min(cfg.bringIn, bp.stack);
      bp.stack -= bi; hand.betStreet[bringId] = bi; hand.totalContrib[bringId] = (hand.totalContrib[bringId] || 0) + bi; hand.currentBet = bi;
      if (bp.stack === 0) hand.allIn[bringId] = true;
      var rest = afterId(order, bringId).filter(function (id) { return !hand.folded[id] && !hand.allIn[id]; });
      if (!rest.length) { hand.turn = null; shared.stage = 'showdown'; hostCtx.write(shared); }
      else { hand.needsAction = rest; hand.turn = rest[0]; shared.stage = 'betting'; hostCtx.write(shared); }
      return;
    }

    var holeCount = cfg.draw ? 5 : cfg.holeCount;
    order.forEach(function (id) { hand.hands[id] = deck.splice(0, holeCount); });
    postBlind(table, hand, order, cfg);
    hand.street = cfg.draw ? 'predraw' : 'preflop';
    var startIdx = order.length === 2 ? 0 : 3 % order.length;
    settleStreetStart(cfg, shared, order[startIdx], hostCtx);
  }

  function hostDealNext(cfg, shared, hostCtx) {
    var hand = shared.hand, order = hand.order, deck = hostCtx.deck;
    if (!deck) { hostAbortHand(shared, hostCtx); return; }

    if (cfg.board) {
      if (hand.street === 'preflop') { hand.board = deck.splice(0, 3); hand.street = 'flop'; }
      else if (hand.street === 'flop') { hand.board = hand.board.concat(deck.splice(0, 1)); hand.street = 'turn'; }
      else { hand.board = hand.board.concat(deck.splice(0, 1)); hand.street = 'river'; }
      resetStreetBetting(hand, cfg);
      var startId = firstActive(rotate(order, order.length > 1 ? 1 : 0), hand.folded, hand.allIn, false) || order[0];
      settleStreetStart(cfg, shared, startId, hostCtx);
    } else if (cfg.stud) {
      var nextStreet = { '3rd': '4th', '4th': '5th', '5th': '6th', '6th': '7th' }[hand.street];
      order.forEach(function (id) {
        if (hand.folded[id]) return;
        if (nextStreet === '7th') hand.hands[id].hole = hand.hands[id].hole.concat(deck.splice(0, 1));
        else hand.hands[id].up = hand.hands[id].up.concat(deck.splice(0, 1));
      });
      hand.street = nextStreet;
      resetStreetBetting(hand, cfg);
      var bestId = bestShowingId(hand, order);
      var bestIdx = order.indexOf(bestId);
      var sId = firstActive(rotate(order, bestIdx < 0 ? 0 : bestIdx), hand.folded, hand.allIn, false) || bestId;
      settleStreetStart(cfg, shared, sId, hostCtx);
    } else if (cfg.draw) {
      order.forEach(function (id) {
        if (hand.folded[id]) return;
        var idxs = hand.drawSelections[id] || [];
        if (!idxs.length) return;
        var keep = hand.hands[id].filter(function (c, i) { return idxs.indexOf(i) < 0; });
        hand.hands[id] = keep.concat(deck.splice(0, idxs.length));
      });
      hand.street = 'postdraw';
      resetStreetBetting(hand, cfg);
      var startId2 = firstActive(rotate(order, order.length > 1 ? 1 : 0), hand.folded, hand.allIn, false) || order[0];
      settleStreetStart(cfg, shared, startId2, hostCtx);
    }
  }

  function hostShowdown(cfg, shared, hostCtx) {
    var hand = shared.hand, table = shared.table, order = hand.order;
    var winnersLog = [];

    if (hand.foldWinner) {
      var potAll = 0;
      order.forEach(function (id) { potAll += hand.totalContrib[id] || 0; });
      var p = participantOf(table, hand.foldWinner);
      if (p) p.stack += potAll;
      winnersLog.push({ id: hand.foldWinner, amount: potAll, reason: 'alle anderen haben gefoldet' });
    } else {
      var entries = order.map(function (id) { return { id: id, contributed: hand.totalContrib[id] || 0, folded: !!hand.folded[id] }; });
      var pots = PE.sidePots(entries);
      pots.forEach(function (pot) {
        if (!pot.eligible.length || pot.amount <= 0) return;
        var scored = pot.eligible.map(function (id) { return { id: id, score: evaluateHand(cfg, hand, id) }; });
        scored.sort(function (a, b) { return PE.cmpScore(b.score, a.score); });
        var top = scored.filter(function (s) { return PE.cmpScore(s.score, scored[0].score) === 0; });
        var share = Math.floor(pot.amount / top.length);
        var rest = pot.amount - share * top.length;
        top.forEach(function (s, i) {
          var p2 = participantOf(table, s.id);
          var amt = share + (i === 0 ? rest : 0);
          if (p2) p2.stack += amt;
          winnersLog.push({ id: s.id, amount: amt, reason: PE.describe(s.score) });
        });
      });
    }

    table.participants.forEach(function (p) { if (p.stack <= 0) { p.stack = 0; p.out = true; } });
    hand.result = { winners: winnersLog, revealAll: !hand.foldWinner };
    hand.turn = null; hand.needsAction = [];
    shared.stage = 'result';
    hostCtx.write(shared);

    var aliveNow = table.participants.filter(function (p) { return !p.out; });
    hostCtx.scheduleNext(shared, aliveNow.length < 2 ? 3200 : 4200);
  }

  function hostAbortHand(shared, hostCtx) {
    var hand = shared.hand, table = shared.table;
    if (hand && shared.stage !== 'result') {
      (hand.order || []).forEach(function (id) {
        var p = participantOf(table, id);
        if (p) p.stack += hand.totalContrib[id] || 0;
      });
    }
    shared.hand = null; shared.stage = 'between';
    hostCtx.write(shared);
    hostCtx.scheduleNext(shared, 1200);
  }

  /* ============================ generische Spieler-Aktionen ============================ */
  function applyAction(cfg, shared, pid, action, amount) {
    var hand = shared.hand;
    if (!hand || hand.turn !== pid) return null;
    var table = shared.table;
    var participant = participantOf(table, pid);
    if (!participant) return null;
    var cur = hand.currentBet || 0;
    var mine = hand.betStreet[pid] || 0;

    function removeNeeds() { var i = hand.needsAction.indexOf(pid); if (i >= 0) hand.needsAction.splice(i, 1); }

    if (action === 'fold') {
      hand.folded[pid] = true; removeNeeds(); logMsg(hand, table, pid, 'foldet');
    } else if (action === 'check') {
      if (mine !== cur) return null;
      removeNeeds(); logMsg(hand, table, pid, 'checkt');
    } else if (action === 'call') {
      var need = cur - mine;
      var pay = Math.min(need, participant.stack);
      participant.stack -= pay; mine += pay; hand.betStreet[pid] = mine; hand.totalContrib[pid] = (hand.totalContrib[pid] || 0) + pay;
      if (participant.stack === 0) hand.allIn[pid] = true;
      removeNeeds(); logMsg(hand, table, pid, pay > 0 ? ('callt ' + fmtChips(pay)) : 'checkt');
    } else if (action === 'bet' || action === 'raise' || action === 'allin') {
      var target = action === 'allin' ? mine + participant.stack : Math.max(Math.floor(amount) || 0, 0);
      target = Math.min(target, mine + participant.stack);
      var delta = target - mine;
      if (delta <= 0) return null;
      participant.stack -= delta; mine = target; hand.betStreet[pid] = mine; hand.totalContrib[pid] = (hand.totalContrib[pid] || 0) + delta;
      if (participant.stack === 0) hand.allIn[pid] = true;
      if (mine > cur) {
        var raiseSize = mine - cur;
        hand.currentBet = mine;
        if (raiseSize >= (hand.minRaise || 1)) hand.minRaise = raiseSize;
        hand.needsAction = hand.order.filter(function (id) { return id !== pid && !hand.folded[id] && !hand.allIn[id]; });
        logMsg(hand, table, pid, (cur > 0 ? 'erhöht auf ' : 'setzt ') + fmtChips(mine));
      } else {
        removeNeeds(); logMsg(hand, table, pid, 'geht all-in (' + fmtChips(mine) + ')');
      }
    } else return null;

    return shared;
  }

  function applyDrawSelect(cfg, shared, pid, idxs) {
    var hand = shared.hand;
    if (!hand || hand.turn !== pid) return null;
    idxs = (idxs || []).filter(function (i) { return i >= 0 && i < (hand.hands[pid] || []).length; });
    hand.drawSelections[pid] = idxs;
    var i2 = hand.needsAction.indexOf(pid); if (i2 >= 0) hand.needsAction.splice(i2, 1);
    logMsg(hand, shared.table, pid, idxs.length ? ('tauscht ' + idxs.length + ' Karte(n)') : 'behält alle Karten');
    if (hand.needsAction.length === 0) { hand.turn = null; shared.stage = 'dealing'; }
    else { hand.turn = nextActorGeneric(hand, true); }
    return shared;
  }

  /* ============================ Kartendarstellung ============================ */
  function cardEl(card, opts) {
    opts = opts || {};
    if (!card) return el('div', { class: 'pk-card pk-card-back' });
    var red = !!SUIT_RED[card.s];
    return el('div', { class: 'pk-card' + (red ? ' pk-red' : '') + (opts.small ? ' pk-card-sm' : '') }, [
      el('span', { class: 'pk-card-r' }, [PE.rankLabel(card.r)]),
      el('span', { class: 'pk-card-s' }, [SUIT_SYMBOL[card.s]])
    ]);
  }
  function cardRow(cards, opts) { return el('div', { class: 'pk-cardrow' }, (cards || []).map(function (c) { return cardEl(c, opts); })); }

  /* ============================ Tisch rendern ============================ */
  function renderTable(root, ctx, cfg) {
    var room = ctx.room, me = ctx.me;
    var destroyed = false;
    var pendingTimer = null;
    var hostCtx = {
      deck: null,
      myId: room.id,
      write: function (shared) { room.setShared({ table: shared.table, hand: shared.hand, stage: shared.stage }); },
      scheduleNext: function (shared, delay) { scheduleNextHand(shared, delay); }
    };

    function isHost() { return room.isHost(); }
    function currentShared() { var snap = room.snapshot(); return (snap && snap.shared && snap.shared.stage) ? snap.shared : null; }

    function scheduleNextHand(shared, delay) {
      if (pendingTimer) clearTimeout(pendingTimer);
      pendingTimer = setTimeout(function () {
        pendingTimer = null;
        if (destroyed || !isHost()) return;
        var snap = currentShared() || shared;
        hostStartHand(cfg, deepClone(snap), hostCtx);
      }, delay || 1500);
    }

    function initGameIfHost() {
      if (!isHost()) return;
      var snap = room.snapshot();
      if (snap && snap.shared && snap.shared.stage) return;
      var players = room.players().slice(0, cfg.maxPlayers);
      if (players.length < 2) { UI.toast('Mindestens 2 Spieler nötig', 'lose'); ctx.onExit(); return; }
      var table = {
        participants: players.map(function (p) { return { id: p.id, name: p.name || 'Spieler', stack: START_STACK, out: false }; }),
        dealerId: players[players.length - 1].id, handNo: 0
      };
      hostCtx.deck = null;
      hostStartHand(cfg, { table: table, hand: null, stage: 'between' }, hostCtx);
    }

    function onSharedUpdate(sharedVal) {
      if (destroyed) return;
      renderState(sharedVal);
      if (!sharedVal || !sharedVal.table) return;
      if (!isHost()) return;
      if (sharedVal.hand && sharedVal.hand.dealHolder && sharedVal.hand.dealHolder !== room.id) {
        hostAbortHand(deepClone(sharedVal), hostCtx);
        return;
      }
      if (sharedVal.stage === 'dealing') hostDealNext(cfg, deepClone(sharedVal), hostCtx);
      else if (sharedVal.stage === 'showdown') hostShowdown(cfg, deepClone(sharedVal), hostCtx);
      else if (sharedVal.stage === 'between' && !sharedVal.hand) scheduleNextHand(sharedVal, 800);
    }

    function submitAction(action, amount) {
      var snap = currentShared();
      if (!snap || !snap.hand) return;
      var shared = deepClone(snap);
      var result = applyAction(cfg, shared, room.id, action, amount);
      if (!result) { UI.toast('Ungültiger Zug', 'info'); return; }
      closeStreetIfDone(cfg, shared);
      room.setShared({ table: shared.table, hand: shared.hand, stage: shared.stage });
    }
    function submitDraw(idxs) {
      var snap = currentShared();
      if (!snap || !snap.hand) return;
      var shared = deepClone(snap);
      var result = applyDrawSelect(cfg, shared, room.id, idxs);
      if (!result) { UI.toast('Nicht dein Zug', 'info'); return; }
      room.setShared({ table: shared.table, hand: shared.hand, stage: shared.stage });
    }

    /* ---------- UI-Zustand ---------- */
    var wrap = el('div', { class: 'pk-wrap' });
    root.innerHTML = ''; root.appendChild(wrap);
    var selectedDiscards = {};
    var lastSig; // verhindert Neuaufbau des DOM bei reinen Heartbeat-Updates (kein echter Zustandswechsel)

    function renderState(shared) {
      if (destroyed) return;
      var sig = shared ? JSON.stringify(shared) : null;
      if (sig === lastSig) return;
      lastSig = sig;
      wrap.innerHTML = '';
      if (!shared || !shared.table) {
        wrap.appendChild(el('div', { class: 'glass pk-wait' }, ['Warte auf Host …']));
        return;
      }
      var table = shared.table, hand = shared.hand;

      wrap.appendChild(el('div', { class: 'pk-head' }, [
        el('div', { class: 'pk-head-l' }, ['Hand #' + (table.handNo || 0) + (hand && hand.street ? ' · ' + (STREET_LABEL[hand.street] || hand.street) : '')]),
        el('div', { class: 'pk-head-r' }, ['🪙 Pot: ' + fmtChips(potTotal(hand))])
      ]));

      if (shared.stage === 'ended') { renderEnded(table); return; }
      if (!hand) { wrap.appendChild(el('div', { class: 'glass pk-wait' }, ['Nächste Hand wird ausgeteilt …'])); return; }

      if (cfg.board && hand.board && hand.board.length) wrap.appendChild(cardRow(hand.board));

      wrap.appendChild(renderSeats(table, hand, shared.stage));

      if (hand.log && hand.log.length) {
        wrap.appendChild(el('div', { class: 'pk-log' }, hand.log.slice(-6).map(function (l) {
          return el('div', { class: 'pk-log-row' }, [l.n + ' ' + l.t]);
        })));
      }

      if (shared.stage === 'result' && hand.result) renderResult(hand.result, table);
      else if (shared.stage === 'draw-select' && hand.turn === me.id) renderDrawUI(hand, table.handNo);
      else if (shared.stage === 'betting' && hand.turn === me.id) renderActionBar(hand, table);
      else if (hand.turn && hand.turn !== me.id) {
        var waitingP = participantOf(table, hand.turn);
        wrap.appendChild(el('div', { class: 'hint-text pk-turn-hint' }, ['Warte auf ' + (waitingP ? waitingP.name : '…') + ' …']));
      }
    }

    function potTotal(hand) {
      if (!hand) return 0;
      var sum = 0;
      Object.keys(hand.totalContrib || {}).forEach(function (k) { sum += hand.totalContrib[k] || 0; });
      return sum;
    }

    function renderSeats(table, hand, stage) {
      var list = el('div', { class: 'pk-seats' });
      table.participants.forEach(function (p) {
        var inHand = hand.order.indexOf(p.id) >= 0;
        var folded = !!hand.folded[p.id];
        var allIn = !!hand.allIn[p.id];
        var isMe = p.id === me.id;
        var tags = [];
        if (table.dealerId === p.id) tags.push('D');
        if (p.id === hand.turn) tags.push('▶');
        var cardsNode = null;
        if (inHand && !folded) {
          if (cfg.stud) {
            var hh2 = hand.hands[p.id] || { hole: [], up: [] };
            var holeReveal = isMe || (stage === 'result' && hand.result && hand.result.revealAll);
            cardsNode = el('div', { class: 'pk-cardrow' },
              hh2.hole.map(function (c) { return holeReveal ? cardEl(c, { small: true }) : cardEl(null, { small: true }); })
                .concat(hh2.up.map(function (c) { return cardEl(c, { small: true }); })));
          } else {
            var cs = hand.hands[p.id] || [];
            var reveal = isMe || (stage === 'result' && hand.result && hand.result.revealAll);
            cardsNode = el('div', { class: 'pk-cardrow' }, cs.map(function (c) { return reveal ? cardEl(c, { small: true }) : cardEl(null, { small: true }); }));
          }
        }
        list.appendChild(el('div', { class: 'pk-seat' + (isMe ? ' me' : '') + (folded ? ' folded' : '') + (p.out ? ' out' : '') }, [
          el('div', { class: 'pk-seat-top' }, [
            el('span', { class: 'pk-seat-name' }, [p.name + (isMe ? ' (du)' : '') + (tags.length ? ' ' + tags.join(' ') : '')]),
            el('span', { class: 'pk-seat-stack' }, ['🪙 ' + fmtChips(p.stack)])
          ]),
          cardsNode,
          el('div', { class: 'pk-seat-bottom' }, [
            p.out ? el('span', { class: 'pk-badge pk-badge-out' }, ['raus']) :
              folded ? el('span', { class: 'pk-badge' }, ['gefoldet']) :
                allIn ? el('span', { class: 'pk-badge pk-badge-allin' }, ['all-in']) :
                  (hand.betStreet[p.id] ? el('span', { class: 'pk-badge pk-badge-bet' }, ['Einsatz: ' + fmtChips(hand.betStreet[p.id])]) : null)
          ])
        ]));
      });
      return list;
    }

    function renderResult(result, table) {
      wrap.appendChild(el('div', { class: 'glass pk-result' }, [
        el('div', { class: 'neon' }, ['Ergebnis']),
        el('div', {}, result.winners.map(function (w) {
          var p = participantOf(table, w.id);
          return el('div', { class: 'pk-result-row' }, [(p ? p.name : '?') + ': +' + fmtChips(w.amount) + ' 🪙 — ' + w.reason]);
        }))
      ]));
    }

    function renderEnded(table) {
      var ranked = table.participants.slice().sort(function (a, b) { return (b.stack || 0) - (a.stack || 0); });
      wrap.appendChild(el('div', { class: 'glass pk-endscreen' }, [
        el('h2', { class: 'neon' }, [ranked[0] && ranked[0].id === me.id ? '🎉 Du hast gewonnen!' : '🏁 Spiel vorbei']),
        el('div', { class: 'pk-standings' }, ranked.map(function (p, i) {
          return el('div', { class: 'pk-sb-row' }, [
            el('span', {}, ['#' + (i + 1) + ' ' + p.name + (p.id === me.id ? ' (du)' : '')]),
            el('span', {}, ['🪙 ' + fmtChips(p.stack)])
          ]);
        })),
        el('div', { class: 'controls-row' }, [
          el('button', { class: 'btn btn-ghost', type: 'button', onclick: ctx.onExit }, ['Zurück zur Lobby'])
        ])
      ]));
    }

    function renderActionBar(hand, table) {
      var cur = hand.currentBet || 0, mine = hand.betStreet[me.id] || 0, need = cur - mine;
      var participant = participantOf(table, me.id) || { stack: 0 };
      var minRaiseTo = cur + Math.max(hand.minRaise || DEFAULT_MIN_BET, 1);
      var maxTo = mine + participant.stack;
      var amountInput = el('input', { class: 'text-input pk-amt-input', type: 'number', min: Math.min(minRaiseTo, maxTo), max: maxTo, value: Math.min(minRaiseTo, maxTo) });

      var bar = el('div', { class: 'glass pk-actionbar' }, [
        el('div', { class: 'pk-action-row' }, [
          el('button', { class: 'btn btn-ghost', type: 'button', onclick: function () { submitAction('fold'); } }, ['Fold']),
          need > 0
            ? el('button', { class: 'btn btn-aqua', type: 'button', onclick: function () { submitAction('call'); } }, ['Call ' + fmtChips(Math.min(need, participant.stack))])
            : el('button', { class: 'btn btn-aqua', type: 'button', onclick: function () { submitAction('check'); } }, ['Check']),
          el('button', { class: 'btn btn-primary', type: 'button', onclick: function () { submitAction('allin'); } }, ['All-in (' + fmtChips(participant.stack) + ')'])
        ]),
        maxTo > minRaiseTo ? el('div', { class: 'pk-action-row' }, [
          amountInput,
          el('button', { class: 'btn btn-primary', type: 'button', onclick: function () {
            var v = Math.max(minRaiseTo, Math.min(maxTo, Math.floor(Number(amountInput.value) || 0)));
            submitAction(cur > 0 ? 'raise' : 'bet', v);
          } }, [cur > 0 ? 'Erhöhen' : 'Setzen'])
        ]) : null
      ]);
      wrap.appendChild(bar);
    }

    function renderDrawUI(hand, handNo) {
      if (selectedDiscards._handNo !== handNo) { selectedDiscards = { _handNo: handNo }; }
      var cards = hand.hands[me.id] || [];
      selectedDiscards[me.id] = selectedDiscards[me.id] || [];
      var row = el('div', { class: 'pk-cardrow pk-draw-row' }, cards.map(function (c, i) {
        var picked = selectedDiscards[me.id].indexOf(i) >= 0;
        var cardNode = cardEl(c);
        cardNode.classList.toggle('pk-picked', picked);
        cardNode.addEventListener('click', function () {
          var arr = selectedDiscards[me.id];
          var pos = arr.indexOf(i);
          if (pos >= 0) arr.splice(pos, 1); else arr.push(i);
          cardNode.classList.toggle('pk-picked');
        });
        return cardNode;
      }));
      wrap.appendChild(el('div', { class: 'glass pk-actionbar' }, [
        el('p', { class: 'hint-text' }, ['Karten antippen zum Tauschen, dann bestätigen.']),
        row,
        el('div', { class: 'pk-action-row' }, [
          el('button', { class: 'btn btn-primary', type: 'button', onclick: function () {
            var idxs = selectedDiscards[me.id] || [];
            submitDraw(idxs);
          } }, ['Bestätigen'])
        ])
      ]));
    }

    room.on('shared', onSharedUpdate);
    var snap0 = room.snapshot();
    renderState(snap0 && snap0.shared);
    initGameIfHost();

    return {
      cleanup: function () {
        destroyed = true;
        room.off('shared', onSharedUpdate);
        if (pendingTimer) clearTimeout(pendingTimer);
      }
    };
  }

  /* ============================ Styles ============================ */
  function injectStyle() {
    UI.injectStyle('poker-css', [
      '.pk-wrap{display:flex;flex-direction:column;gap:12px;max-width:760px;margin:0 auto;}',
      '.pk-wait{padding:24px;text-align:center;}',
      '.pk-head{display:flex;justify-content:space-between;align-items:center;padding:10px 16px;border-radius:14px;background:rgba(9,32,21,.7);border:1px solid var(--stroke);font-weight:700;}',
      '.pk-cardrow{display:flex;gap:6px;flex-wrap:wrap;}',
      '.pk-card{width:40px;height:56px;border-radius:8px;background:linear-gradient(160deg,#0f3020,#071a10 78%);border:2px solid var(--stroke-2);display:flex;flex-direction:column;align-items:center;justify-content:center;font-weight:900;color:var(--text);line-height:1;}',
      '.pk-card-sm{width:32px;height:46px;font-size:12px;}',
      '.pk-card.pk-red{color:#ff6d8a;}',
      '.pk-card-back{background:repeating-linear-gradient(135deg,#0a2c1c 0 8px,#082418 8px 16px);border-color:var(--stroke);}',
      '.pk-card-r{font-size:14px;}',
      '.pk-card-s{font-size:14px;}',
      '.pk-card.pk-picked{outline:3px solid var(--gold);transform:translateY(-6px);}',
      '.pk-seats{display:flex;flex-direction:column;gap:8px;}',
      '.pk-seat{padding:10px 12px;border-radius:14px;background:rgba(9,32,21,.55);border:1px solid var(--stroke);display:flex;flex-direction:column;gap:6px;}',
      '.pk-seat.me{border-color:var(--stroke-2);box-shadow:0 0 12px rgba(57,255,20,.12);}',
      '.pk-seat.folded{opacity:.5;}',
      '.pk-seat.out{opacity:.35;}',
      '.pk-seat-top{display:flex;justify-content:space-between;font-weight:700;}',
      '.pk-seat-bottom{min-height:18px;font-size:12px;color:var(--muted);}',
      '.pk-badge{padding:2px 8px;border-radius:999px;background:rgba(9,32,21,.8);border:1px solid var(--stroke);}',
      '.pk-badge-bet{color:var(--gold);border-color:rgba(255,210,63,.4);}',
      '.pk-badge-allin{color:#ff6d8a;border-color:rgba(255,109,138,.4);}',
      '.pk-badge-out{color:var(--muted);}',
      '.pk-log{padding:8px 12px;border-radius:12px;background:rgba(4,16,10,.6);border:1px solid var(--stroke);font-size:12px;color:var(--muted);display:flex;flex-direction:column;gap:2px;max-height:110px;overflow-y:auto;}',
      '.pk-actionbar{padding:14px;display:flex;flex-direction:column;gap:10px;}',
      '.pk-action-row{display:flex;gap:8px;flex-wrap:wrap;align-items:center;}',
      '.pk-amt-input{width:120px;}',
      '.pk-turn-hint{text-align:center;}',
      '.pk-result{padding:14px;display:flex;flex-direction:column;gap:6px;}',
      '.pk-result-row{font-size:14px;}',
      '.pk-endscreen{padding:24px;text-align:center;display:flex;flex-direction:column;gap:12px;}',
      '.pk-standings{display:flex;flex-direction:column;gap:6px;}',
      '.pk-sb-row{display:flex;justify-content:space-between;padding:6px 12px;border-radius:10px;background:rgba(9,32,21,.6);border:1px solid var(--stroke);}'
    ].join(''));
  }
})();
