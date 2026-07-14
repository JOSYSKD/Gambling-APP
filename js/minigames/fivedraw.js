/* fivedraw.js — "Five-Card Draw" (Kategorie „Poker & Casino" / group:'live').
 *
 * Mehrspieler-Poker (Five-Card Draw): Blinds, eine Setzrunde, Karten tauschen,
 * zweite Setzrunde, Showdown. 2–6 Spieler; Solo gegen 3 Bots.
 *
 *  SOLO  (ctx.mode==='single'): Spieler + 3 Bots. Der Client führt die Engine
 *        selbst und rendert direkt aus dem Spielzustand G.
 *  MULTI (ctx.mode==='multi'):  HOST-AUTORITATIV wie bingo.js/chess.js. NUR der
 *        Host führt die Engine (die „Table") und schreibt den Zustand nach
 *        room.setShared. Alle anderen rendern aus room.on('shared'). Aktionen
 *        werden als Intent via room.reportState({seq,...}) gemeldet; der Host
 *        wendet jeden Intent genau EINMAL an (Sequenznummer je Spieler) und nur,
 *        wenn der Spieler auch wirklich am Zug ist. Leere/verlassene Plätze
 *        übernimmt der Host als Bot. DOM wird EINMAL gebaut und danach nur noch
 *        in-place aktualisiert → kein Flackern.
 *
 * Eigene Karten liegen in shared.hands[<spielerId>]; jeder Client zeigt nur
 * seine eigenen Karten offen, fremde bleiben verdeckt bis zum Showdown.
 *
 * cleanup() stoppt alle Timer und entfernt die Room-Listener. */
(function () {
  'use strict';
  window.App = window.App || {}; App.Minigames = App.Minigames || {};
  var UI = App.UI, el = UI.el, P = App.Poker, fmt = UI.formatCoins;

  injectStyle();

  /* ===================== Konstanten ===================== */
  var SMALL_BLIND = 10, BIG_BLIND = 20, MIN_RAISE = 20;   // minRaise = Big Blind
  var START_CHIPS = 1000, MAX_SEATS = 6;
  var TURN_MS = 25000;        // Zug-Timer für Menschen
  var BOT_MS = 850;           // Bot-Denkzeit
  var SHOWDOWN_MS = 4600;     // Anzeigedauer nach Showdown
  var FOLD_MS = 2400;         // Anzeigedauer, wenn alle bis auf einen folden

  /* ===================== Karten-Helfer ===================== */
  function rankLabel(card) { var r = card[0]; return r === 'T' ? '10' : r; }
  function isRed(card) { var s = P.suitOf(card); return s === 'h' || s === 'd'; }
  function cardInner(card) {
    var r = rankLabel(card), sym = P.SUIT_SYM[P.suitOf(card)];
    return '<span class="fd-corner tl">' + r + '<br>' + sym + '</span>' +
      '<span class="fd-center"><span class="fd-c-rank">' + r + '</span><span class="fd-c-suit">' + sym + '</span></span>' +
      '<span class="fd-corner br">' + r + '<br>' + sym + '</span>';
  }
  /* Karte in-place setzen (nur bei Änderung → kein Flackern) */
  function renderCard(node, card, faceUp) {
    var sig = (faceUp && card ? card : '#') + (faceUp ? 'U' : 'D');
    if (node._sig === sig) return;
    node._sig = sig;
    if (!faceUp || !card) {
      node.className = node._base + ' back';
      node.innerHTML = '<span class="fd-back-emoji">🌴</span>';
    } else {
      node.className = node._base + ' ' + (isRed(card) ? 'red' : 'dark');
      node.innerHTML = cardInner(card);
    }
  }

  /* ===================== Bot-Heuristik ===================== */
  function handScore(ev) {
    var c = ev.cat, hi = ev.tie[0] || 2;
    if (c >= 8) return 1.0;
    if (c === 7) return 0.97;
    if (c === 6) return 0.93;
    if (c === 5) return 0.88;
    if (c === 4) return 0.82;
    if (c === 3) return 0.70;
    if (c === 2) return 0.56;
    if (c === 1) return 0.30 + (hi - 2) / 12 * 0.16;   // Paar 0.30 … ~0.46
    return 0.10 + (hi - 2) / 12 * 0.14;                // Höchste Karte 0.10 … ~0.24
  }
  function discardExcept(keepIdx) {
    var d = [];
    for (var i = 0; i < 5; i++) if (keepIdx.indexOf(i) < 0) d.push(i);
    return d;
  }
  function fourToStraight(vals) {
    for (var drop = 0; drop < 5; drop++) {
      var keep = [0, 1, 2, 3, 4].filter(function (i) { return i !== drop; });
      var vs = keep.map(function (i) { return vals[i]; });
      var seen = {}, ok = true;
      vs.forEach(function (v) { if (seen[v]) ok = false; seen[v] = 1; });
      if (!ok) continue;
      var mx = Math.max.apply(null, vs), mn = Math.min.apply(null, vs);
      if (mx - mn <= 4) return keep;
      var vs2 = vs.map(function (v) { return v === 14 ? 1 : v; });   // Ass als 1 (Rad)
      var seen2 = {}, ok2 = true;
      vs2.forEach(function (v) { if (seen2[v]) ok2 = false; seen2[v] = 1; });
      if (ok2 && Math.max.apply(null, vs2) - Math.min.apply(null, vs2) <= 4) return keep;
    }
    return null;
  }
  /* welche Karten-Indizes ein Bot abwirft (Paare/Drillinge/Draws behalten) */
  function botDiscards(hand) {
    var ev = P.eval5(hand);
    if (ev.cat >= 4) return [];                                    // Straße+ steht
    var vals = hand.map(P.rankVal), suits = hand.map(P.suitOf);
    var cnt = {}; vals.forEach(function (v, i) { (cnt[v] = cnt[v] || []).push(i); });
    var ranks = Object.keys(cnt).map(Number);
    if (ev.cat === 3) { var t3 = []; ranks.forEach(function (r) { if (cnt[r].length === 3) t3 = cnt[r]; }); return discardExcept(t3); }
    if (ev.cat === 2) { var kp = []; ranks.forEach(function (r) { if (cnt[r].length === 2) kp = kp.concat(cnt[r]); }); return discardExcept(kp); }
    if (ev.cat === 1) { var pr = []; ranks.forEach(function (r) { if (cnt[r].length === 2) pr = cnt[r]; }); return discardExcept(pr); }
    var scnt = {}; suits.forEach(function (s, i) { (scnt[s] = scnt[s] || []).push(i); });
    var flush4 = null; Object.keys(scnt).forEach(function (s) { if (scnt[s].length === 4) flush4 = scnt[s]; });
    if (flush4) return discardExcept(flush4);
    var st4 = fourToStraight(vals);
    if (st4) return discardExcept(st4);
    var maxV = Math.max.apply(null, vals), mi = vals.indexOf(maxV);
    if (maxV >= 11) return discardExcept([mi]);                    // hohe Karte halten
    return [0, 1, 2, 3, 4];                                        // sonst alles ziehen
  }

  /* ===================== Engine ("Table") ===================== */
  /* seats: [{id,name,bot}], opts:{getHumans:fn|null, chips:{id:num}|null} */
  function newTable(seats, opts) {
    opts = opts || {};
    var G = {
      seats: seats.slice(), chips: {}, hands: {}, button: -1, handNo: 0, phase: 'idle',
      pot: 0, currentBet: 0, bets: {}, acted: {}, folded: {}, allIn: {}, inHand: {},
      discard: {}, drawn: {}, deck: [], muck: [], toAct: null, drawTurn: null,
      toActSince: 0, deadline: 0, nextAt: 0, showAll: false, result: null, v: 0
    };
    G.seats.forEach(function (s) { G.chips[s.id] = (opts.chips && typeof opts.chips[s.id] === 'number') ? opts.chips[s.id] : START_CHIPS; });

    function bump() { G.v++; }
    function seatIdx(id) { for (var i = 0; i < G.seats.length; i++) if (G.seats[i].id === id) return i; return -1; }
    function inHandPred(i) { return G.inHand[G.seats[i].id]; }
    function canAct(i) { var s = G.seats[i]; return !!(s && G.inHand[s.id] && !G.folded[s.id] && !G.allIn[s.id]); }
    function notFoldedCount() { var c = 0; G.seats.forEach(function (s) { if (G.inHand[s.id] && !G.folded[s.id]) c++; }); return c; }

    function nextIdxWith(fromIdx, pred) {
      var n = G.seats.length;
      for (var k = 1; k <= n; k++) { var i = ((fromIdx < 0 ? -1 : fromIdx) + k) % n; if (i < 0) i += n; if (pred(i)) return i; }
      return fromIdx >= 0 ? fromIdx : 0;
    }
    function findActor(fromIdx) {
      var n = G.seats.length;
      for (var k = 1; k <= n; k++) {
        var i = ((fromIdx < 0 ? -1 : fromIdx) + k) % n; if (i < 0) i += n;
        var s = G.seats[i]; if (!canAct(i)) continue;
        if (!G.acted[s.id] || G.bets[s.id] < G.currentBet) return i;
      }
      return -1;
    }
    function findDrawer(fromIdx) {
      var n = G.seats.length;
      for (var k = 1; k <= n; k++) {
        var i = ((fromIdx < 0 ? -1 : fromIdx) + k) % n; if (i < 0) i += n;
        var s = G.seats[i]; if (G.inHand[s.id] && !G.folded[s.id] && !G.drawn[s.id]) return i;
      }
      return -1;
    }
    function commit(id, amount) {
      var a = Math.min(Math.max(0, Math.round(amount)), G.chips[id]);
      G.chips[id] -= a; G.bets[id] += a; G.pot += a;
      if (G.chips[id] <= 0) G.allIn[id] = true;
      return a;
    }
    function resetActedExcept(id) { G.seats.forEach(function (s) { if (s.id !== id) G.acted[s.id] = false; }); }
    function drawCard() {
      if (!G.deck.length) { if (G.muck.length) { G.deck = P.shuffle(G.muck); G.muck = []; } else return null; }
      return G.deck.pop();
    }

    /* verlassene Menschen → Bot, neue Menschen → freier Platz */
    function refreshSeats() {
      if (!opts.getHumans) return;
      var humans = opts.getHumans() || [];
      var present = {}; humans.forEach(function (h) { present[h.id] = h; });
      G.seats.forEach(function (s) {
        if (!s.bot) { if (present[s.id]) s.name = present[s.id].name || s.name; else s.bot = true; }
      });
      humans.forEach(function (h) {
        if (seatIdx(h.id) < 0 && G.seats.length < MAX_SEATS) {
          G.seats.push({ id: h.id, name: h.name || 'Spieler', bot: false });
          G.chips[h.id] = START_CHIPS;
        }
      });
    }

    function startHand(now) {
      refreshSeats();
      var withChips = G.seats.filter(function (s) { return G.chips[s.id] > 0; });
      if (withChips.length < 2) { endTable(); return; }
      G.handNo++;
      G.pot = 0; G.currentBet = 0; G.showAll = false; G.result = null;
      G.bets = {}; G.acted = {}; G.folded = {}; G.allIn = {}; G.inHand = {}; G.discard = {}; G.drawn = {}; G.hands = {}; G.muck = [];
      G.seats.forEach(function (s) {
        G.bets[s.id] = 0; G.acted[s.id] = false; G.folded[s.id] = false; G.allIn[s.id] = false;
        G.inHand[s.id] = G.chips[s.id] > 0; G.discard[s.id] = -1; G.drawn[s.id] = false;
      });
      G.button = nextIdxWith(G.button, function (i) { return G.chips[G.seats[i].id] > 0; });
      var deck = P.shuffle(P.makeDeck());
      G.seats.forEach(function (s) { if (G.inHand[s.id]) G.hands[s.id] = [deck.pop(), deck.pop(), deck.pop(), deck.pop(), deck.pop()]; });
      G.deck = deck;
      var sb = nextIdxWith(G.button, inHandPred);
      var bb = nextIdxWith(sb, inHandPred);
      commit(G.seats[sb].id, SMALL_BLIND);
      commit(G.seats[bb].id, BIG_BLIND);
      G.currentBet = Math.max(G.bets[G.seats[sb].id], G.bets[G.seats[bb].id]);
      G.phase = 'betting1';
      G.toAct = null; G.drawTurn = null;
      beginBetting(bb, now);
      bump();
    }

    function beginBetting(afterIdx, now) {
      var idx = findActor(afterIdx);
      if (idx < 0) { advanceAfterBetting(now); return; }
      G.toAct = G.seats[idx].id; G.toActSince = now; G.deadline = now + TURN_MS;
    }
    function afterActionAdvance(actorIdx, now) {
      if (notFoldedCount() === 1) { endByFold(now); return; }
      var nxt = findActor(actorIdx);
      if (nxt < 0) advanceAfterBetting(now);
      else { G.toAct = G.seats[nxt].id; G.toActSince = now; G.deadline = now + TURN_MS; }
    }
    function advanceAfterBetting(now) {
      if (G.phase === 'betting1') startDraw(now);
      else showdown(now);
    }

    function applyBet(id, action, amount, now) {
      if (id !== G.toAct || (G.phase !== 'betting1' && G.phase !== 'betting2')) return false;
      var i = seatIdx(id); if (!canAct(i)) return false;
      if (action === 'fold') { G.folded[id] = true; }
      else if (action === 'check') { if (G.bets[id] !== G.currentBet) { commit(id, G.currentBet - G.bets[id]); } }
      else if (action === 'call') { commit(id, G.currentBet - G.bets[id]); }
      else if (action === 'raise') {
        var to = Math.round(amount) || 0, maxTo = G.bets[id] + G.chips[id], minTo = G.currentBet + MIN_RAISE;
        if (to > maxTo) to = maxTo;
        if (to < minTo) to = (maxTo >= minTo) ? minTo : maxTo;
        commit(id, to - G.bets[id]);
        if (G.bets[id] > G.currentBet) { G.currentBet = G.bets[id]; resetActedExcept(id); }
      } else if (action === 'allin') {
        commit(id, G.chips[id]);
        if (G.bets[id] > G.currentBet) { G.currentBet = G.bets[id]; resetActedExcept(id); }
      } else return false;
      G.acted[id] = true;
      afterActionAdvance(i, now);
      bump();
      return true;
    }

    function startDraw(now) {
      G.phase = 'draw'; G.toAct = null;
      G.seats.forEach(function (s) { if (G.inHand[s.id] && !G.folded[s.id]) { G.drawn[s.id] = false; G.discard[s.id] = -1; } });
      var idx = findDrawer(G.button);
      if (idx < 0) { startBetting2(now); return; }
      G.drawTurn = G.seats[idx].id; G.toActSince = now; G.deadline = now + TURN_MS;
    }
    function applyDraw(id, discardArr, now) {
      if (id !== G.drawTurn || G.phase !== 'draw') return false;
      if (!G.inHand[id] || G.folded[id]) return false;
      var hand = G.hands[id] || [], disc = [], i;
      for (i = 0; i < (discardArr || []).length; i++) {
        var d = discardArr[i]; if (d >= 0 && d < 5 && disc.indexOf(d) < 0) disc.push(d);
      }
      var keep = [], thrown = [];
      for (i = 0; i < 5; i++) { if (disc.indexOf(i) < 0) keep.push(hand[i]); else thrown.push(hand[i]); }
      var need = 5 - keep.length;
      for (i = 0; i < need; i++) { var c = drawCard(); keep.push(c || thrown.pop()); }
      G.muck = G.muck.concat(thrown);
      G.hands[id] = keep;
      G.discard[id] = need; G.drawn[id] = true;
      var nxt = findDrawer(seatIdx(id));
      if (nxt < 0) startBetting2(now);
      else { G.drawTurn = G.seats[nxt].id; G.toActSince = now; G.deadline = now + TURN_MS; }
      bump();
      return true;
    }

    function startBetting2(now) {
      G.phase = 'betting2'; G.currentBet = 0; G.drawTurn = null; G.toAct = null;
      G.seats.forEach(function (s) { G.bets[s.id] = 0; G.acted[s.id] = false; });
      beginBetting(G.button, now);
    }

    function showdown(now) {
      G.phase = 'handover'; G.showAll = true; G.toAct = null; G.drawTurn = null;
      var contenders = G.seats.filter(function (s) { return G.inHand[s.id] && !G.folded[s.id]; });
      var best = null, evBy = {}, names = {};
      contenders.forEach(function (s) {
        var ev = P.eval5(G.hands[s.id]); evBy[s.id] = ev; names[s.id] = P.handName(ev);
        if (!best || P.compare(ev, best) > 0) best = ev;
      });
      var winners = contenders.filter(function (s) { return P.compare(evBy[s.id], best) === 0; }).map(function (s) { return s.id; });
      var potWon = G.pot, share = Math.floor(G.pot / winners.length), rem = G.pot - share * winners.length;
      winners.forEach(function (wid, k) { G.chips[wid] += share + (k === 0 ? rem : 0); });
      G.pot = 0;
      G.result = { winners: winners, names: names, byFold: false, potWon: potWon };
      G.nextAt = now + SHOWDOWN_MS;
    }
    function endByFold(now) {
      G.phase = 'handover'; G.showAll = false; G.toAct = null; G.drawTurn = null;
      var winId = null; G.seats.forEach(function (s) { if (G.inHand[s.id] && !G.folded[s.id]) winId = s.id; });
      var potWon = G.pot;
      if (winId != null) G.chips[winId] += G.pot;
      G.pot = 0;
      G.result = { winners: winId != null ? [winId] : [], names: {}, byFold: true, potWon: potWon };
      G.nextAt = now + FOLD_MS;
    }
    function endTable() {
      var best = G.seats[0];
      G.seats.forEach(function (s) { if (G.chips[s.id] > G.chips[best.id]) best = s; });
      G.phase = 'over'; G.showAll = false; G.toAct = null; G.drawTurn = null;
      G.result = { winners: [best.id], names: {}, table: true, potWon: 0 };
    }

    function botBet(id) {
      var ev = P.eval5(G.hands[id]), s = handScore(ev);
      var toCall = G.currentBet - G.bets[id], chips = G.chips[id], r = Math.random();
      if (toCall <= 0) {
        if (s > 0.70 && r < 0.65) return raiseMove(id, s);
        if (s > 0.45 && r < 0.28) return raiseMove(id, s);
        return { action: 'check' };
      }
      if (chips <= toCall) { return (s > 0.55 || r < 0.12) ? { action: 'allin' } : { action: 'fold' }; }
      var potOdds = toCall / (G.pot + toCall);
      if (s > 0.80) return r < 0.45 ? raiseMove(id, s) : { action: 'call' };
      if (s > 0.55) return r < 0.15 ? raiseMove(id, s) : { action: 'call' };
      if (s > 0.34) return (potOdds < 0.28 || r < 0.40) ? { action: 'call' } : { action: 'fold' };
      if (r < 0.05) return raiseMove(id, s);                 // seltener Bluff
      if (potOdds < 0.12 && r < 0.5) return { action: 'call' };
      return { action: 'fold' };
    }
    function raiseMove(id, s) {
      var chips = G.chips[id], maxTo = G.bets[id] + chips;
      var to = Math.round((G.currentBet + MIN_RAISE + (0.3 + s * 1.2) * G.currentBet) / 10) * 10;
      if (to >= maxTo || s > 0.95) return { action: 'allin' };
      if (to < G.currentBet + MIN_RAISE) to = G.currentBet + MIN_RAISE;
      return { action: 'raise', amount: to };
    }

    function tick(now) {
      var before = G.v;
      if (G.phase === 'handover') { if (now >= G.nextAt) startHand(now); return G.v !== before; }
      if (G.phase === 'over' || G.phase === 'idle') return false;
      if (G.phase === 'betting1' || G.phase === 'betting2') {
        var id = G.toAct; if (id == null) return false;
        var s = G.seats[seatIdx(id)];
        if (s && s.bot) { if (now - G.toActSince >= BOT_MS) { var mv = botBet(id); applyBet(id, mv.action, mv.amount, now); } }
        else if (now >= G.deadline) { if (G.bets[id] === G.currentBet) applyBet(id, 'check', 0, now); else applyBet(id, 'fold', 0, now); }
      } else if (G.phase === 'draw') {
        var did = G.drawTurn; if (did == null) return false;
        var ds = G.seats[seatIdx(did)];
        if (ds && ds.bot) { if (now - G.toActSince >= BOT_MS) applyDraw(did, botDiscards(G.hands[did]), now); }
        else if (now >= G.deadline) applyDraw(did, [], now);
      }
      return G.v !== before;
    }
    function submit(id, intent, now) {
      if (!intent) return false;
      if (intent.type === 'bet') return applyBet(id, intent.action, intent.amount || 0, now);
      if (intent.type === 'draw') return applyDraw(id, intent.discard || [], now);
      return false;
    }

    return { G: G, startHand: startHand, submit: submit, tick: tick, seatIdx: seatIdx };
  }

  /* für shared: Engine-Zustand ohne Deck/Muck (kein Leak, kleiner) */
  function serialize(G) {
    return {
      seats: G.seats, chips: G.chips, hands: G.hands, button: G.button, handNo: G.handNo,
      phase: G.phase, pot: G.pot, currentBet: G.currentBet, bets: G.bets, acted: G.acted,
      folded: G.folded, allIn: G.allIn, inHand: G.inHand, discard: G.discard, drawn: G.drawn,
      toAct: G.toAct, drawTurn: G.drawTurn, toActSince: G.toActSince, deadline: G.deadline,
      nextAt: G.nextAt, showAll: G.showAll, result: G.result
    };
  }

  /* ===================== Layout (EINMAL bauen) ===================== */
  function buildLayout(H) {
    var brand = el('div', { class: 'fd-brand neon' }, ['🎴 Five-Card Draw']);
    var status = el('div', { class: 'fd-status' }, ['']);
    var back = el('button', { class: 'btn btn-ghost fd-back', type: 'button', onclick: H.exit }, ['← Zurück']);
    var top = el('div', { class: 'fd-top' }, [back, brand, status]);

    var potEl = el('div', { class: 'fd-pot-v' }, ['0']);
    var potBox = el('div', { class: 'fd-pot' }, [el('div', { class: 'fd-pot-l' }, ['POT']), potEl, el('div', { class: 'fd-pot-c' }, ['🪙'])]);
    var seatsWrap = el('div', { class: 'fd-seats' });
    var table = el('div', { class: 'fd-table glass' }, [seatsWrap, potBox]);

    /* eigene Hand */
    var myCards = [];
    var mySlots = [0, 1, 2, 3, 4].map(function (i) {
      var badge = el('div', { class: 'fd-badge' }, ['TAUSCH']);
      var card = el('button', { class: 'fd-card', type: 'button', onclick: function () { H.card(i); } });
      card._base = 'fd-card'; myCards.push(card);
      return el('div', { class: 'fd-slot' }, [badge, card]);
    });
    var myHandRow = el('div', { class: 'fd-hand' }, mySlots);
    var myName = el('div', { class: 'fd-myhand-name' }, ['']);
    var myBox = el('div', { class: 'fd-mybox' }, [myHandRow, myName]);

    /* Zug-Timer */
    var timerFill = el('div', { class: 'fd-timer-fill' });
    var timerBar = el('div', { class: 'fd-timer' }, [timerFill]);

    /* Aktionsleiste — Setzen */
    var foldBtn = el('button', { class: 'btn btn-danger fd-abtn', type: 'button', onclick: H.fold }, ['Fold']);
    var ccBtn = el('button', { class: 'btn btn-aqua fd-abtn', type: 'button', onclick: H.cc }, ['Check']);
    var raiseInput = el('input', { class: 'fd-raise-range', type: 'range', min: '0', max: '100', value: '0', step: '10' });
    var raiseLabel = el('div', { class: 'fd-raise-label' }, ['']);
    var raiseBtn = el('button', { class: 'btn btn-primary fd-abtn', type: 'button', onclick: H.raise }, ['Erhöhen']);
    var raiseWrap = el('div', { class: 'fd-raise-wrap' }, [el('div', { class: 'fd-raise-ctl' }, [raiseInput, raiseLabel]), raiseBtn]);
    var allinBtn = el('button', { class: 'btn btn-primary fd-abtn fd-allin', type: 'button', onclick: H.allin }, ['All-in']);
    var betBar = el('div', { class: 'fd-actionbar glass' }, [
      el('div', { class: 'fd-abtn-row' }, [foldBtn, ccBtn, allinBtn]),
      raiseWrap
    ]);
    raiseInput.addEventListener('input', function () { if (raiseLabel._fmt) raiseLabel.textContent = raiseLabel._fmt(parseInt(raiseInput.value, 10)); });

    /* Aktionsleiste — Tauschen */
    var drawBtn = el('button', { class: 'btn btn-primary fd-abtn', type: 'button', onclick: H.draw }, ['Tauschen (0)']);
    var standBtn = el('button', { class: 'btn btn-aqua fd-abtn', type: 'button', onclick: H.stand }, ['Stehen bleiben']);
    var drawBar = el('div', { class: 'fd-actionbar glass' }, [
      el('div', { class: 'fd-draw-hint' }, ['Karten anklicken zum Tauschen markieren']),
      el('div', { class: 'fd-abtn-row' }, [standBtn, drawBtn])
    ]);

    var overlay = el('div', { class: 'fd-overlay', hidden: true });

    var root = el('div', { class: 'fd-wrap' }, [top, table, timerBar, myBox, betBar, drawBar, overlay]);

    return {
      root: root, status: status, potEl: potEl, seatsWrap: seatsWrap, seatEls: {}, _seatSig: null,
      myCards: myCards, mySlots: mySlots, myHandRow: myHandRow, myName: myName, myBox: myBox,
      timerBar: timerBar, timerFill: timerFill,
      betBar: betBar, drawBar: drawBar, foldBtn: foldBtn, ccBtn: ccBtn,
      raiseWrap: raiseWrap, raiseInput: raiseInput, raiseLabel: raiseLabel, raiseBtn: raiseBtn, allinBtn: allinBtn,
      drawBtn: drawBtn, standBtn: standBtn, overlay: overlay,
      sel: [false, false, false, false, false], _myDrawKey: null, _overKey: null,
      _lastCountedHand: -1
    };
  }

  function seatName(view, id) {
    var s = (view.seats || []).filter(function (x) { return x.id === id; })[0];
    return s ? s.name : '—';
  }

  /* Sitz-Kachel bauen */
  function makeSeatEl(seat, meId) {
    var dealer = el('span', { class: 'fd-d' }, ['D']);
    var nameEl = el('span', { class: 'fd-s-name' }, [seat.name + (seat.id === meId ? ' (du)' : '')]);
    var chipsEl = el('span', { class: 'fd-s-chips' }, ['0']);
    var betEl = el('div', { class: 'fd-s-bet' }, ['']);
    var statusEl = el('div', { class: 'fd-s-status' }, ['']);
    var cards = [];
    var cardRow = el('div', { class: 'fd-s-cards' }, [0, 1, 2, 3, 4].map(function () {
      var c = el('div', { class: 'fd-mini' }); c._base = 'fd-mini'; cards.push(c); return c;
    }));
    var head = el('div', { class: 'fd-s-head' }, [dealer, nameEl, chipsEl]);
    var root = el('div', { class: 'fd-seat' + (seat.id === meId ? ' me' : '') + (seat.bot ? ' bot' : '') }, [head, cardRow, betEl, statusEl]);
    return { root: root, dealer: dealer, nameEl: nameEl, chipsEl: chipsEl, betEl: betEl, statusEl: statusEl, cards: cards };
  }
  function updateSeatEl(se, seat, view, meId, buttonId, now) {
    if (!se) return;
    var id = seat.id;
    se.dealer.style.visibility = (id === buttonId) ? 'visible' : 'hidden';
    se.chipsEl.textContent = fmt(view.chips ? (view.chips[id] || 0) : 0);
    var bet = view.bets ? (view.bets[id] || 0) : 0;
    se.betEl.textContent = bet > 0 ? ('Einsatz ' + fmt(bet)) : '';
    se.betEl.style.visibility = bet > 0 ? 'visible' : 'hidden';

    var folded = view.folded && view.folded[id];
    var allIn = view.allIn && view.allIn[id];
    var inHand = view.inHand && view.inHand[id];
    var isTurn = (view.toAct === id) || (view.drawTurn === id);
    var st = '', cls = 'fd-s-status';
    if (!inHand) { st = 'sitzt aus'; }
    else if (folded) { st = 'Fold'; cls += ' fold'; }
    else if (allIn) { st = 'ALL-IN'; cls += ' allin'; }
    else if (view.phase === 'draw' && view.drawTurn === id) { st = 'tauscht …'; cls += ' turn'; }
    else if (view.phase === 'draw' && view.drawn && view.drawn[id]) { st = 'tauscht ' + (view.discard[id] || 0); }
    else if (isTurn) { st = 'am Zug'; cls += ' turn'; }
    se.statusEl.textContent = st;
    se.statusEl.className = cls;

    var winner = view.result && view.result.winners && view.result.winners.indexOf(id) >= 0;
    se.root.classList.toggle('active', !!isTurn && !view.result);
    se.root.classList.toggle('winner', !!winner && (view.phase === 'handover' || view.phase === 'over'));
    se.root.classList.toggle('is-fold', !!folded);

    var reveal = inHand && (id === meId || (view.showAll && !folded));
    var hand = view.hands ? view.hands[id] : null;
    for (var i = 0; i < 5; i++) {
      se.cards[i].style.visibility = inHand ? 'visible' : 'hidden';
      renderCard(se.cards[i], hand ? hand[i] : null, reveal);
    }
  }

  function ensureSeatEls(refs, seats, meId) {
    var sig = seats.map(function (s) { return s.id + (s.bot ? 'B' : 'H'); }).join(',');
    if (refs._seatSig === sig) return;
    refs._seatSig = sig; refs.seatEls = {}; refs.seatsWrap.innerHTML = '';
    seats.forEach(function (s) { var se = makeSeatEl(s, meId); refs.seatEls[s.id] = se; refs.seatsWrap.appendChild(se.root); });
  }

  /* ===================== Rendern (in-place) ===================== */
  function paintTable(refs, view, meId, now) {
    view = view || {};
    var seats = view.seats || [];
    var meSeated = seats.some(function (s) { return s.id === meId; });
    var buttonId = seats[view.button] ? seats[view.button].id : null;

    refs.potEl.textContent = fmt(view.pot || 0);
    ensureSeatEls(refs, seats, meId);
    seats.forEach(function (s) { updateSeatEl(refs.seatEls[s.id], s, view, meId, buttonId, now); });

    refs.status.textContent = statusText(view, meId, meSeated);
    refs.status.className = 'fd-status ' + statusCls(view, meId);

    /* eigene Hand */
    var showMine = meSeated && view.inHand && view.inHand[meId] && view.hands && view.hands[meId];
    refs.myBox.hidden = !meSeated;
    var myDrawTurn = meSeated && view.phase === 'draw' && view.drawTurn === meId && !(view.folded && view.folded[meId]);
    if (myDrawTurn) {
      var key = 'd' + view.handNo;
      if (refs._myDrawKey !== key) { refs.sel = [false, false, false, false, false]; refs._myDrawKey = key; }
    }
    var myHand = showMine ? view.hands[meId] : null;
    refs.myHandRow.classList.toggle('can-pick', myDrawTurn);
    for (var i = 0; i < 5; i++) {
      renderCard(refs.myCards[i], myHand ? myHand[i] : null, !!myHand);
      refs.mySlots[i].classList.toggle('picked', myDrawTurn && refs.sel[i]);
    }
    if (showMine) { var ev = P.eval5(view.hands[meId]); refs.myName.textContent = 'Dein Blatt: ' + P.handName(ev); refs.myName.hidden = false; }
    else { refs.myName.hidden = true; }

    updateBars(refs, view, meId, meSeated);
    updateTimer(refs, view, meId, meSeated, now);
    updateOverlay(refs, view, meId);
    maybeCountWin(refs, view, meId);
  }

  /* Bestenliste: zählt GENAU EINEN Sieg pro gewonnener Hand für den lokalen
     Spieler. Läuft client-seitig beim Rendern (Solo + jeder Multi-Client für
     sich, meId = ctx.me.id). Guard liegt auf refs (pro Instanz); view.handNo ist
     die stabile Hand-Kennung (steckt in serialize/shared, +1 je startHand).
     'handover' deckt Showdown UND Fold-Win ab; 'over' (Tisch-Ende) zählt NICHT. */
  function maybeCountWin(refs, view, meId) {
    if (!view || view.phase !== 'handover' || !view.result) return;
    var winners = view.result.winners || [];
    if (winners.indexOf(meId) < 0) return;                 // nur eigener Sieg (nie Fold-Verlust/Bots)
    if (view.handNo === refs._lastCountedHand) return;     // Guard gegen Mehrfach-Render
    refs._lastCountedHand = view.handNo;
    if (App.Scores && App.Scores.winCurrent) App.Scores.winCurrent();
  }

  function statusText(view, meId, meSeated) {
    if (view.phase === 'over') { var wt = view.result && view.result.winners && view.result.winners[0]; return '🏁 ' + seatName(view, wt) + ' gewinnt den Tisch!'; }
    if (view.result && view.phase === 'handover') {
      var ws = view.result.winners || [], pot = view.result.potWon || 0;
      if (!ws.length) return 'Neue Hand …';
      if (view.result.byFold) return '🏆 ' + seatName(view, ws[0]) + ' gewinnt ' + fmt(pot) + ' 🪙';
      if (ws.length > 1) return '🤝 Split Pot · ' + fmt(pot) + ' 🪙';
      var nm = view.result.names ? view.result.names[ws[0]] : '';
      return '🏆 ' + seatName(view, ws[0]) + ' gewinnt ' + fmt(pot) + ' 🪙 · ' + nm;
    }
    if (!meSeated) return 'Du schaust zu …';
    if (view.phase === 'draw') return view.drawTurn === meId ? 'Dein Zug: Karten tauschen' : (seatName(view, view.drawTurn) + ' tauscht …');
    if (view.phase === 'betting1' || view.phase === 'betting2') return view.toAct === meId ? 'Du bist am Zug' : (seatName(view, view.toAct) + ' ist am Zug');
    return 'Neue Hand …';
  }
  function statusCls(view, meId) {
    if (view.phase === 'over' || (view.result && view.phase === 'handover')) {
      var ws = view.result ? (view.result.winners || []) : [];
      return ws.indexOf(meId) >= 0 ? 'win' : 'draw';
    }
    if ((view.toAct === meId || view.drawTurn === meId) && meId) return 'you';
    return 'opp';
  }

  function updateBars(refs, view, meId, meSeated) {
    var betTurn = meSeated && (view.phase === 'betting1' || view.phase === 'betting2') &&
      view.toAct === meId && !(view.folded && view.folded[meId]) && !(view.allIn && view.allIn[meId]);
    var drawTurn = meSeated && view.phase === 'draw' && view.drawTurn === meId && !(view.folded && view.folded[meId]);
    refs.betBar.hidden = !betTurn;
    refs.drawBar.hidden = !drawTurn;

    if (betTurn) {
      var myBet = view.bets[meId] || 0, cur = view.currentBet || 0, chips = view.chips[meId] || 0;
      var toCall = Math.max(0, cur - myBet), maxTo = myBet + chips;
      if (toCall <= 0) { refs.ccBtn.textContent = 'Check'; refs.ccBtn.dataset.act = 'check'; }
      else { refs.ccBtn.textContent = (toCall >= chips ? 'Call ' + fmt(chips) + ' (All-in)' : 'Call ' + fmt(toCall)); refs.ccBtn.dataset.act = 'call'; }
      refs.ccBtn.disabled = false; refs.foldBtn.disabled = false;

      var minTo = cur + MIN_RAISE;
      if (maxTo >= minTo && chips > toCall) {
        refs.raiseWrap.hidden = false;
        refs.raiseInput.min = String(minTo); refs.raiseInput.max = String(maxTo);
        var v = parseInt(refs.raiseInput.value, 10);
        if (!(v >= minTo && v <= maxTo)) v = minTo;
        refs.raiseInput.value = String(v);
        refs.raiseLabel._fmt = function (x) { return 'auf ' + fmt(x) + ' 🪙' + (x >= maxTo ? ' (All-in)' : ''); };
        refs.raiseLabel.textContent = refs.raiseLabel._fmt(v);
        refs.raiseBtn.disabled = false;
      } else { refs.raiseWrap.hidden = true; }
      refs.allinBtn.disabled = chips <= 0;
      refs.allinBtn.textContent = 'All-in (' + fmt(chips) + ')';
    }
    if (drawTurn) {
      var n = 0; for (var i = 0; i < 5; i++) if (refs.sel[i]) n++;
      refs.drawBtn.textContent = n > 0 ? ('Tauschen (' + n + ')') : 'Tauschen (0)';
    }
  }

  function updateTimer(refs, view, meId, meSeated, now) {
    var myTurn = meSeated && ((view.toAct === meId && (view.phase === 'betting1' || view.phase === 'betting2')) ||
      (view.drawTurn === meId && view.phase === 'draw')) && !(view.folded && view.folded[meId]);
    if (!myTurn || !view.deadline) { refs.timerBar.hidden = true; return; }
    refs.timerBar.hidden = false;
    var rem = Math.max(0, view.deadline - now), pct = Math.max(0, Math.min(100, rem / TURN_MS * 100));
    refs.timerFill.style.width = pct + '%';
    refs.timerFill.classList.toggle('low', rem < 6000);
  }

  function updateOverlay(refs, view, meId) {
    if (view.phase !== 'over') { if (refs._overKey !== null) { refs._overKey = null; refs.overlay.hidden = true; refs.overlay.innerHTML = ''; } return; }
    var key = 'over' + view.handNo;
    if (refs._overKey === key) return;
    refs._overKey = key;
    var wid = view.result && view.result.winners && view.result.winners[0];
    var iWon = wid === meId;
    var actions = [];
    if (refs._canRestart) actions.push(el('button', { class: 'btn btn-primary btn-lg', type: 'button', onclick: refs._onRestart }, ['🔄 Neue Runde']));
    actions.push(el('button', { class: 'btn btn-ghost btn-lg', type: 'button', onclick: refs._onExit }, ['Zurück']));
    refs.overlay.innerHTML = '';
    refs.overlay.appendChild(el('div', { class: 'fd-over-card glass ' + (iWon ? 'win' : 'lose') }, [
      el('div', { class: 'fd-over-emoji' }, [iWon ? '🏆' : '🃏']),
      el('h2', { class: 'fd-over-title neon' }, [iWon ? 'Du gewinnst den Tisch!' : (seatName(view, wid) + ' gewinnt den Tisch')]),
      el('p', { class: 'fd-over-sub' }, [iWon ? 'Alle Chips abgeräumt — starke Session!' : 'Nächstes Mal räumst du ab!']),
      el('div', { class: 'fd-over-actions' }, actions)
    ]));
    refs.overlay.hidden = false;
  }

  /* ===================== Modul ===================== */
  App.Minigames.fivedraw = {
    id: 'fivedraw', title: 'Five-Card Draw', icon: '🎴', order: 25,
    subtitle: '5 Karten, einmal tauschen, bestes Blatt gewinnt',
    single: true, multi: true, minPlayers: 2, maxPlayers: 6, group: 'live',

    render: function (root, ctx) {
      var destroyed = false, timers = [];
      function every(ms, fn) { var t = setInterval(fn, ms); timers.push(t); return t; }
      function clearTimers() { timers.forEach(clearInterval); timers = []; }

      if (ctx.mode === 'multi' && ctx.room) return renderMulti();
      return renderSolo();

      /* ========================= SOLO ========================= */
      function renderSolo() {
        var me = ctx.me;
        var table = null, refs = null;
        function now() { return Date.now(); }
        function freshTable() {
          return newTable([
            { id: me.id, name: me.name || 'Du', bot: false },
            { id: 'b0', name: 'Bot Kaa', bot: true },
            { id: 'b1', name: 'Bot Baloo', bot: true },
            { id: 'b2', name: 'Bot Shir', bot: true }
          ], { getHumans: null });
        }
        function dispatch(intent) { if (destroyed || !table) return; table.submit(me.id, intent, now()); repaint(); }
        function repaint() { if (!destroyed && table && refs) paintTable(refs, table.G, me.id, now()); }
        var H = handlers(dispatch, refs_get, repaint, function restart() { table = freshTable(); table.startHand(now()); refs._overKey = null; repaint(); });
        function refs_get() { return refs; }

        table = freshTable();
        refs = buildLayout(H);
        refs._canRestart = true; refs._onRestart = H.restart; refs._onExit = ctx.onExit;
        root.innerHTML = ''; root.appendChild(refs.root);
        table.startHand(now());
        repaint();
        every(200, function () { if (destroyed || !table) return; table.tick(now()); repaint(); });

        return { cleanup: function () { destroyed = true; clearTimers(); } };
      }

      /* ========================= MULTI ========================= */
      function renderMulti() {
        var room = ctx.room, me = ctx.me;
        var lastShared = (room.snapshot() && room.snapshot().shared) || null;
        var table = null, refs = null, curView = null, waitRefs = null;
        var lastPush = -1, lastSeq = {}, mySeq = 0;

        function now() { return room.now(); }
        function humans() { return room.players().map(function (p) { return { id: p.id, name: p.name }; }); }

        function dispatch(intent) {
          if (destroyed) return;
          if (room.isHost()) { if (table) { table.submit(me.id, intent, now()); hostLoop(); } }
          else { mySeq++; room.reportState(Object.assign({ seq: mySeq }, intent)); }
        }
        function repaint() {
          if (destroyed || !refs) return;
          var view = room.isHost() && table ? table.G : lastShared;
          if (view) paintTable(refs, view, me.id, now());
        }
        function restart() {
          if (!room.isHost()) return;
          var seats = table ? table.G.seats.filter(function (s) { return !s.bot; }).map(function (s) { return { id: s.id, name: s.name, bot: false }; }) : humans();
          if (!seats.length) seats = humans();
          table = newTable(seats, { getHumans: humans });
          table.startHand(now());
          refs._overKey = null; lastPush = -1; hostLoop();
        }
        var H = handlers(dispatch, function () { return refs; }, repaint, restart);

        function ensureGameView() {
          if (curView === 'game') return;
          curView = 'game';
          refs = buildLayout(H);
          refs._canRestart = room.isHost(); refs._onRestart = H.restart; refs._onExit = ctx.onExit;
          root.innerHTML = ''; root.appendChild(refs.root);
        }
        function showWaiting(count) {
          if (curView !== 'wait') {
            curView = 'wait';
            var cEl = el('div', { class: 'fd-wait-c neon' }, ['1 / ' + (ctx.minPlayers || 2)]);
            var mEl = el('p', { class: 'fd-wait-m' }, ['']);
            waitRefs = { c: cEl, m: mEl };
            root.innerHTML = '';
            root.appendChild(el('div', { class: 'fd-panel glass' }, [
              el('div', { class: 'fd-wait-icon' }, ['🎴']),
              el('h2', { class: 'neon' }, ['Five-Card Draw']),
              cEl, mEl,
              el('div', { class: 'fd-over-actions' }, [el('button', { class: 'btn btn-ghost', type: 'button', onclick: ctx.onExit }, ['Zurück zur Lobby'])])
            ]));
          }
          waitRefs.c.textContent = count + ' / 2';
          waitRefs.m.textContent = count >= 2 ? 'Spiel startet gleich …' : 'Warte auf Mitspieler …';
        }

        function makeHostTable() {
          var seats;
          if (lastShared && lastShared.seats && lastShared.seats.length) {
            seats = lastShared.seats.map(function (s) { return { id: s.id, name: s.name, bot: s.bot }; });
          } else {
            seats = humans().slice(0, MAX_SEATS).map(function (h) { return { id: h.id, name: h.name, bot: false }; });
          }
          var chips = (lastShared && lastShared.chips) ? lastShared.chips : null;
          return newTable(seats, { getHumans: humans, chips: chips });
        }
        function processIntents() {
          if (!table) return;
          room.players().forEach(function (p) {
            if (p.id === me.id) return;
            var st = p.state; if (!st || typeof st.seq !== 'number') return;
            if (lastSeq[p.id] === undefined) lastSeq[p.id] = 0;
            if (st.seq > lastSeq[p.id]) { lastSeq[p.id] = st.seq; table.submit(p.id, st, now()); }
          });
        }

        function hostLoop() {
          if (destroyed) return;
          var players = room.players();
          if (players.length < 2 && !table) { showWaiting(players.length); return; }
          if (!table) { table = makeHostTable(); table.startHand(now()); lastPush = -1; }
          processIntents();
          table.tick(now());
          if (table.G.v !== lastPush) { lastPush = table.G.v; room.setShared(serialize(table.G)); }
          ensureGameView();
          repaint();
        }
        function clientLoop() {
          if (destroyed) return;
          if (!lastShared || !lastShared.seats) { showWaiting(room.players().length); return; }
          ensureGameView();
          repaint();
        }
        function loop() { if (destroyed) return; if (room.isHost()) hostLoop(); else clientLoop(); }

        function onShared(sh) { if (destroyed) return; lastShared = sh; loop(); }
        function onPlayers() { if (destroyed) return; loop(); }
        room.on('shared', onShared); room.on('players', onPlayers);
        every(200, loop);
        loop();

        return {
          cleanup: function () {
            destroyed = true; clearTimers();
            room.off('shared', onShared); room.off('players', onPlayers);
          }
        };
      }

      /* gemeinsame Button-Handler (Setzen/Tauschen/Karten) */
      function handlers(dispatch, getRefs, repaint, restart) {
        return {
          card: function (i) {
            var refs = getRefs(); if (!refs) return;
            if (!refs.myHandRow.classList.contains('can-pick')) return;
            refs.sel[i] = !refs.sel[i]; repaint();
          },
          fold: function () { dispatch({ type: 'bet', action: 'fold' }); },
          cc: function () { var refs = getRefs(); dispatch({ type: 'bet', action: (refs && refs.ccBtn.dataset.act) || 'check' }); },
          raise: function () { var refs = getRefs(); dispatch({ type: 'bet', action: 'raise', amount: refs ? parseInt(refs.raiseInput.value, 10) : 0 }); },
          allin: function () { dispatch({ type: 'bet', action: 'allin' }); },
          draw: function () {
            var refs = getRefs(); if (!refs) return;
            var d = []; for (var i = 0; i < 5; i++) if (refs.sel[i]) d.push(i);
            dispatch({ type: 'draw', discard: d });
          },
          stand: function () { dispatch({ type: 'draw', discard: [] }); },
          restart: restart,
          exit: ctx.onExit
        };
      }
    }
  };

  /* ===================== CSS ===================== */
  function injectStyle() {
    UI.injectStyle('mg-fivedraw-css', [
      '.fd-wrap{display:flex;flex-direction:column;gap:14px;max-width:820px;margin:0 auto;position:relative;}',
      '.fd-top{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}',
      '.fd-back{padding:7px 12px;font-size:13px;}',
      '.fd-brand{font-weight:900;font-size:19px;flex:0 0 auto;}',
      '.fd-status{flex:1;text-align:right;font-weight:900;font-size:clamp(13px,3.4vw,16px);min-height:20px;color:var(--aqua);}',
      '.fd-status.you{color:var(--neon);text-shadow:0 0 10px rgba(57,255,20,.4);}',
      '.fd-status.opp{color:var(--aqua);}',
      '.fd-status.win{color:var(--gold);text-shadow:0 0 12px rgba(255,210,63,.5);}',
      '.fd-status.draw{color:var(--gold);}',
      /* Tisch */
      '.fd-table{position:relative;padding:16px;background:radial-gradient(circle at 50% 40%,rgba(14,74,44,.55),rgba(4,20,12,.72));}',
      '.fd-seats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;}',
      '.fd-seat{border-radius:14px;padding:9px 10px;background:rgba(6,24,16,.72);border:1px solid var(--stroke);display:flex;flex-direction:column;gap:6px;transition:border-color .2s,box-shadow .2s,opacity .2s;}',
      '.fd-seat.me{border-color:var(--stroke-2);box-shadow:var(--glow-soft);}',
      '.fd-seat.active{border-color:var(--neon);box-shadow:0 0 0 1px var(--neon),0 0 16px rgba(57,255,20,.32);}',
      '.fd-seat.winner{border-color:var(--gold);box-shadow:0 0 18px rgba(255,210,63,.5);}',
      '.fd-seat.is-fold{opacity:.5;}',
      '.fd-s-head{display:flex;align-items:center;gap:6px;}',
      '.fd-d{flex:0 0 auto;width:18px;height:18px;border-radius:50%;background:var(--gold);color:#231a00;font-size:11px;font-weight:900;display:flex;align-items:center;justify-content:center;box-shadow:0 0 8px rgba(255,210,63,.6);}',
      '.fd-s-name{flex:1;font-weight:800;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      '.fd-s-chips{font-weight:900;color:var(--leaf);font-variant-numeric:tabular-nums;font-size:13px;}',
      '.fd-s-chips::after{content:" 🪙";font-size:10px;}',
      '.fd-s-cards{display:flex;gap:3px;}',
      '.fd-mini{width:20px;height:28px;border-radius:4px;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:900;background:linear-gradient(158deg,#fff,#e6f1ea);color:#14202b;border:1px solid rgba(0,0,0,.28);line-height:1;overflow:hidden;}',
      '.fd-mini.red{color:#d21f3c;}.fd-mini.dark{color:#14202b;}',
      '.fd-mini .fd-corner,.fd-mini .fd-center .fd-c-suit{display:none;}',
      '.fd-mini .fd-center{position:static;flex-direction:row;gap:0;}',
      '.fd-mini .fd-c-rank{font-size:11px;}',
      '.fd-mini.back{background:repeating-linear-gradient(45deg,rgba(57,255,20,.16) 0 4px,transparent 4px 8px),radial-gradient(circle at 50% 40%,#0e4a2c,#05271a);border-color:rgba(57,255,20,.45);color:var(--leaf);}',
      '.fd-back-emoji{font-size:11px;}',
      '.fd-s-bet{font-size:11px;font-weight:800;color:var(--aqua-soft);min-height:14px;}',
      '.fd-s-status{font-size:11px;font-weight:800;color:var(--muted);min-height:14px;text-transform:uppercase;letter-spacing:.5px;}',
      '.fd-s-status.turn{color:var(--neon);}.fd-s-status.fold{color:var(--danger-2);}.fd-s-status.allin{color:var(--gold);}',
      /* Pot */
      '.fd-pot{margin:14px auto 2px;display:flex;align-items:center;justify-content:center;gap:8px;padding:8px 20px;border-radius:999px;background:rgba(4,16,10,.7);border:1px solid var(--stroke-2);width:fit-content;}',
      '.fd-pot-l{font-size:11px;font-weight:900;letter-spacing:2px;color:var(--muted);}',
      '.fd-pot-v{font-size:clamp(20px,5.5vw,28px);font-weight:900;color:var(--gold);text-shadow:0 0 12px rgba(255,210,63,.5);font-variant-numeric:tabular-nums;}',
      '.fd-pot-c{font-size:18px;}',
      /* eigene Hand */
      '.fd-mybox{display:flex;flex-direction:column;gap:8px;align-items:center;}',
      '.fd-hand{display:flex;gap:clamp(6px,2vw,12px);justify-content:center;flex-wrap:wrap;}',
      '.fd-slot{position:relative;padding-top:22px;}',
      '.fd-badge{position:absolute;top:0;left:50%;transform:translateX(-50%) translateY(4px);opacity:0;pointer-events:none;font-size:10px;font-weight:900;letter-spacing:1px;color:#231a00;background:linear-gradient(180deg,var(--gold),#e0a800);padding:2px 9px;border-radius:999px;transition:opacity .16s,transform .16s;white-space:nowrap;}',
      '.fd-slot.picked .fd-badge{opacity:1;transform:translateX(-50%) translateY(0);}',
      '.fd-card{position:relative;width:clamp(52px,15vw,72px);height:clamp(75px,21vw,102px);border-radius:10px;background:linear-gradient(158deg,#fff,#e6f1ea);border:1px solid rgba(0,0,0,.28);box-shadow:0 6px 15px rgba(0,0,0,.45);color:#14202b;font-weight:800;padding:0;font-family:inherit;cursor:default;user-select:none;-webkit-user-select:none;transition:transform .16s,box-shadow .16s,border-color .16s;}',
      '.fd-card.red{color:#d21f3c;}.fd-card.dark{color:#14202b;}',
      '.fd-hand.can-pick .fd-card{cursor:pointer;}',
      '.fd-hand.can-pick .fd-card:hover{transform:translateY(-4px);box-shadow:0 12px 22px rgba(0,0,0,.5);border-color:var(--gold);}',
      '.fd-slot.picked .fd-card{transform:translateY(-9px);border-color:var(--gold);box-shadow:0 10px 22px rgba(0,0,0,.5),0 0 0 2px var(--gold),0 0 18px rgba(255,210,63,.5);}',
      '.fd-corner{position:absolute;font-size:clamp(11px,3.2vw,14px);line-height:.9;text-align:center;font-weight:900;}',
      '.fd-corner.tl{top:6px;left:6px;}.fd-corner.br{bottom:6px;right:6px;transform:rotate(180deg);}',
      '.fd-center{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;}',
      '.fd-c-rank{font-size:clamp(19px,5.6vw,26px);line-height:1;font-weight:900;}',
      '.fd-c-suit{font-size:clamp(15px,4.4vw,21px);line-height:1;}',
      '.fd-card.back{color:var(--leaf);display:grid;place-items:center;border-color:rgba(57,255,20,.5);background:repeating-linear-gradient(45deg,rgba(57,255,20,.12) 0 7px,transparent 7px 14px),radial-gradient(circle at 50% 42%,#0e4a2c,#05271a);box-shadow:0 6px 15px rgba(0,0,0,.45),inset 0 0 0 2px rgba(57,255,20,.22);}',
      '.fd-card.back .fd-back-emoji{font-size:26px;filter:drop-shadow(0 0 7px var(--neon));}',
      '.fd-myhand-name{font-weight:800;color:var(--leaf);font-size:14px;text-align:center;min-height:18px;}',
      /* Timer */
      '.fd-timer{height:7px;border-radius:999px;background:rgba(4,16,10,.7);border:1px solid var(--stroke);overflow:hidden;}',
      '.fd-timer-fill{height:100%;width:100%;background:linear-gradient(90deg,var(--neon),var(--aqua));transition:width .25s linear;}',
      '.fd-timer-fill.low{background:linear-gradient(90deg,var(--danger),var(--danger-2));}',
      /* Aktionsleiste */
      '.fd-actionbar{padding:14px;display:flex;flex-direction:column;gap:12px;}',
      '.fd-abtn-row{display:flex;gap:10px;flex-wrap:wrap;justify-content:center;}',
      '.fd-abtn{flex:1;min-width:120px;}',
      '.fd-raise-wrap{display:flex;gap:12px;align-items:center;flex-wrap:wrap;}',
      '.fd-raise-ctl{flex:1;min-width:180px;display:flex;flex-direction:column;gap:4px;}',
      '.fd-raise-range{width:100%;accent-color:var(--neon);}',
      '.fd-raise-label{font-size:13px;font-weight:800;color:var(--gold);text-align:center;}',
      '.fd-draw-hint{font-size:12px;color:var(--muted);text-align:center;}',
      /* Wartepanel + Over-Overlay */
      '.fd-panel{padding:28px 22px;text-align:center;display:flex;flex-direction:column;gap:14px;align-items:center;max-width:460px;margin:0 auto;}',
      '.fd-wait-icon{font-size:50px;filter:drop-shadow(0 0 12px rgba(57,255,20,.4));animation:fd-bob 2.2s ease-in-out infinite;}',
      '@keyframes fd-bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-6px)}}',
      '.fd-wait-c{font-size:clamp(24px,7vw,34px);font-weight:900;}',
      '.fd-wait-m{color:var(--muted);margin:0;}',
      '.fd-overlay{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(2,10,6,.74);backdrop-filter:blur(3px);border-radius:14px;z-index:20;animation:fd-fade .2s ease;}',
      '@keyframes fd-fade{from{opacity:0}to{opacity:1}}',
      '.fd-over-card{padding:26px 22px;text-align:center;display:flex;flex-direction:column;gap:12px;align-items:center;max-width:90%;}',
      '.fd-over-card.win{box-shadow:0 0 34px rgba(255,210,63,.4);}',
      '.fd-over-card.lose{box-shadow:0 0 28px rgba(255,77,109,.22);}',
      '.fd-over-emoji{font-size:52px;filter:drop-shadow(0 0 14px rgba(255,210,63,.5));}',
      '.fd-over-title{font-size:clamp(20px,6vw,30px);font-weight:900;line-height:1.15;margin:0;}',
      '.fd-over-sub{color:var(--muted);margin:0;}',
      '.fd-over-actions{display:flex;gap:10px;justify-content:center;flex-wrap:wrap;margin-top:4px;}'
    ].join(''));
  }
})();
