/* omaha.js — "Omaha": Mehrspieler-Pokervariante (Pot-Limit-Regeln vereinfacht)
 * für die Kategorie "Poker & Casino" (group:'live').
 *
 * Omaha unterscheidet sich von Texas Hold'em NUR in zwei Punkten:
 *   (a) jeder Spieler bekommt 4 Hole-Cards statt 2,
 *   (b) die beste Hand MUSS GENAU 2 der 4 Hole-Cards + GENAU 3 der 5
 *       Community-Karten verwenden. → bestOmaha() prüft alle
 *       (2 aus 4) × (3 aus 5) = 6 × 10 = 60 Kombinationen und nimmt das
 *       Maximum via App.Poker.compare. (App.Poker.evalBest über alle 9 Karten
 *       wäre für Omaha FALSCH.)  Alles Übrige ist wie Hold'em.
 *
 * Architektur (Pflicht): host-autoritativ + Intents (wie chess.js/bingo.js).
 *  - Nur der HOST (bzw. der Solo-Spieler) führt die Poker-Engine und schreibt
 *    den kompletten Zustand via room.setShared(...). Alle rendern in-place aus
 *    room.on('shared'|'players', …) → DOM wird EINMAL gebaut, danach nur noch
 *    aktualisiert (kein Flackern).
 *  - Spieler senden ihre Aktion als Intent
 *    room.reportState({ seq, action:'fold'|'check'|'call'|'raise'|'allin', amount }).
 *    Der Host wendet jeden Intent GENAU EINMAL an (letzte seq je Spieler) und nur,
 *    wenn der Spieler wirklich am Zug ist.
 *  - Per-Room-Chips shared.chips[playerId] (Start 1000, App.Coins bleibt unberührt).
 *  - Eigene 4 Hole-Cards liegen unter shared.hands[playerId]; jeder Client zeigt
 *    NUR seine offen, fremde als Rückseite bis zum Showdown.
 *  - SOLO: der echte Spieler ist Host; 3 Bots füllen den Tisch. Bots (und leere
 *    Plätze) agieren nach ~800 ms heuristisch nach Handstärke.
 *
 * Blinds 10/20, Dealer-Button rotiert. Side-Pots vereinfacht (EIN Haupt-Pot).
 * cleanup() stoppt alle Timer und entfernt die Room-Listener. */
(function () {
  'use strict';
  window.App = window.App || {}; App.Minigames = App.Minigames || {};
  var UI = App.UI, el = UI.el, P = App.Poker;

  injectStyle();

  /* ---------- Konstanten ---------- */
  var MINP = 2;
  var SB = 10, BB = 20;             // Small / Big Blind
  var START = 1000;                 // Start-Chips je Spieler
  var TURN_MS = 25000;              // Zug-Timer (Auto-Check/Fold)
  var SHOWDOWN_MS = 5400;           // Anzeige-Dauer Showdown
  var FOLDWIN_MS = 2600;            // Anzeige-Dauer bei Sieg durch Aufgeben
  var TICK = 250;                   // Host-/Render-Takt
  var BOT_MIN = 650, BOT_SPAN = 750;// Bot-Denkzeit ~0.65–1.4 s

  var BOT_POOL = [
    { id: 'bot1', name: '🤖 Coco' }, { id: 'bot2', name: '🦜 Rio' },
    { id: 'bot3', name: '🐒 Momo' }, { id: 'bot4', name: '🦥 Sly' }
  ];

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function copyMap(o) { var m = {}; Object.keys(o || {}).forEach(function (k) { m[k] = o[k]; }); return m; }
  function copyHands(o) { var m = {}; Object.keys(o || {}).forEach(function (k) { m[k] = (o[k] || []).slice(); }); return m; }

  /* ---------- Omaha-Handbewertung: GENAU 2 Hole + 3 Board ---------- */
  function kcombos(arr, k) {
    var res = [], n = arr.length;
    (function rec(start, cur) {
      if (cur.length === k) { res.push(cur.slice()); return; }
      for (var i = start; i < n; i++) { cur.push(arr[i]); rec(i + 1, cur); cur.pop(); }
    })(0, []);
    return res;
  }
  function bestOmaha(hole, board) {
    if (!hole || hole.length < 4 || !board || board.length < 3) return null;
    var hc = kcombos(hole, 2), bc = kcombos(board, 3), best = null;
    for (var i = 0; i < hc.length; i++) {
      for (var j = 0; j < bc.length; j++) {
        var ev = P.eval5(hc[i].concat(bc[j]));
        if (!best || P.compare(ev, best) > 0) best = ev;
      }
    }
    return best;
  }
  function handNameOf(hole, board) { var ev = bestOmaha(hole, board); return ev ? P.handName(ev) : ''; }

  /* ---------- Bot-Heuristik ---------- */
  function preflopStrength(hole) {
    if (!hole || hole.length < 4) return 0.3;
    var vals = hole.map(P.rankVal).sort(function (a, b) { return b - a; });
    var suits = hole.map(P.suitOf), s = 0, k;
    s += ((vals[0] - 2) / 12) * 0.25 + ((vals[1] - 2) / 12) * 0.15;
    var cnt = {}; vals.forEach(function (v) { cnt[v] = (cnt[v] || 0) + 1; });
    var pairs = 0, trips = false;
    for (k in cnt) { if (cnt[k] >= 2) pairs++; if (cnt[k] >= 3) trips = true; }
    s += Math.min(pairs, 2) * 0.12; if (trips) s -= 0.06;
    var sc = {}; suits.forEach(function (x) { sc[x] = (sc[x] || 0) + 1; });
    var pairedSuits = 0, quadSuit = false;
    for (k in sc) { if (sc[k] >= 2) pairedSuits++; if (sc[k] >= 4) quadSuit = true; }
    s += pairedSuits * 0.06; if (quadSuit) s -= 0.05;
    var gap = vals[0] - vals[3]; if (gap <= 4) s += 0.10; else if (gap <= 6) s += 0.05;
    return clamp(s + 0.05, 0.05, 0.95);
  }
  function handStrength(hole, board) {
    if (board && board.length >= 3) {
      var ev = bestOmaha(hole, board); if (!ev) return preflopStrength(hole);
      var top = (ev.tie[0] || 0) / 14;
      return clamp((ev.cat / 8) * 0.85 + top * 0.12 + 0.03, 0.02, 0.99);
    }
    return preflopStrength(hole);
  }

  App.Minigames.omaha = {
    id: 'omaha', title: 'Omaha', icon: '🃏', order: 23,
    subtitle: '4 Hole-Cards — nutze genau 2 davon + 3 vom Board',
    single: true, multi: true, minPlayers: 2, maxPlayers: 6, group: 'live',

    render: function (root, ctx) {
      var isMulti = ctx.mode === 'multi';
      var room = ctx.room, me = ctx.me;
      var nowFn = isMulti ? function () { return room.now(); } : function () { return Date.now(); };

      /* ---- Laufzeit-Status ---- */
      var destroyed = false, timers = [], loopTimer = null;
      var G = null;                 // autoritativer Zustand (Host/Solo)
      var hosting = false;
      var lastShared = null;
      var bots = [];                // nur Solo
      var mySeq = 0, lastSeq = {};  // Intent-Sequenzen
      var botActAt = Infinity;      // Host: wann der aktuelle Bot handelt
      var onSharedFn = null, onPlayersFn = null;

      /* ---- lokaler UI-Status ---- */
      var curView = null, T = null, waitRefs = null;
      var seatEls = {}, seatSig = null;
      var raiseVal = 0, myPending = false, myPendingAt = 0, lastToastHand = -1, lastScoredHand = -1;

      function every(ms, fn) { var t = setInterval(fn, ms); timers.push(t); return t; }
      function after(ms, fn) { var t = setTimeout(fn, ms); timers.push(t); return t; }
      function stopTimers() { timers.forEach(clearInterval); timers.forEach(clearTimeout); timers = []; }
      function amHost() { return isMulti ? !!(room && room.isHost()) : true; }

      run();
      return { cleanup: cleanup };

      /* ======================================================= *
       *  Ablauf
       * ======================================================= */
      function run() {
        if (isMulti) {
          var snap = room.snapshot();
          if (snap && snap.shared) lastShared = snap.shared;
          onSharedFn = function (sh) { if (destroyed) return; lastShared = sh; render(); };
          onPlayersFn = function () { if (destroyed) return; if (amHost()) { maybeInitHost(nowFn()); processIntents(); } render(); };
          room.on('shared', onSharedFn); room.on('players', onPlayersFn);
          maybeInitHost(nowFn());
        } else {
          setupBots();
          initHostFresh(nowFn());
        }
        loopTimer = every(TICK, loop);
        render();
      }
      function loop() {
        if (destroyed) return;
        if (amHost() || !isMulti) hostStep();
        render();
      }

      function setupBots() { bots = BOT_POOL.slice(0, 3).map(function (b) { return { id: b.id, name: b.name }; }); }
      function isBot(id) { for (var i = 0; i < bots.length; i++) if (bots[i].id === id) return true; return false; }
      function getPlayers() { if (isMulti) return room.players(); return [{ id: me.id, name: me.name }].concat(bots); }
      function nameMap() { var m = {}; getPlayers().forEach(function (p) { m[p.id] = p.name; }); return m; }
      function nameOf(id, nm) { nm = nm || nameMap(); return nm[id] || 'Spieler'; }
      function seatedIds() { if (isMulti) return room.players().map(function (p) { return p.id; }); return [me.id].concat(bots.map(function (b) { return b.id; })); }

      /* ======================================================= *
       *  Host-Lifecycle
       * ======================================================= */
      function seedSeqs() { room.players().forEach(function (p) { lastSeq[p.id] = (p.state && typeof p.state.seq === 'number') ? p.state.seq : 0; }); }
      function maybeInitHost(now) {
        if (!isMulti || !amHost() || G) return;
        if (room.players().length < MINP) return;
        initHostFresh(now);
      }
      function initHostFresh(now) {
        G = { handId: 0, button: null, chips: {} };
        hosting = true;
        if (isMulti) seedSeqs();
        startHand(now);
      }
      function becomeHost() {
        hosting = true;
        if (G) return;
        var s = lastShared;
        if (s && s.order && s.order.length) {
          G = {
            handId: s.handId || 0, button: s.button || 0, order: (s.order || []).slice(),
            chips: copyMap(s.chips), hands: copyHands(s.hands), board: (s.board || []).slice(),
            deck: (s.deck || []).slice(), pot: s.pot || 0, bets: copyMap(s.bets),
            folded: copyMap(s.folded), allin: copyMap(s.allin), acted: copyMap(s.acted),
            currentBet: s.currentBet || 0, minRaise: s.minRaise || BB,
            phase: s.phase || 'betting', street: s.street || 'preflop',
            toAct: s.toAct || null, turnEndsAt: s.turnEndsAt || (nowFn() + TURN_MS),
            result: s.result || null, handOverAt: s.handOverAt || 0, lastAction: s.lastAction || null
          };
          if (isMulti) seedSeqs();
          botActAt = Infinity;
          pushShared();
        } else {
          initHostFresh(nowFn());
        }
      }

      /* ======================================================= *
       *  Poker-Engine (nur Host/Solo)
       * ======================================================= */
      function contenders() { return G.order.filter(function (id) { return !G.folded[id]; }); }
      function canActIds() { return G.order.filter(function (id) { return !G.folded[id] && !G.allin[id] && (G.chips[id] || 0) > 0; }); }
      function dealTo(target) { while (G.board.length < target && G.deck.length) G.board.push(G.deck.pop()); }

      function commit(seat, amt) {
        var id = G.order[seat];
        amt = Math.max(0, Math.min(Math.round(amt), G.chips[id] || 0));
        G.chips[id] = (G.chips[id] || 0) - amt;
        G.bets[id] = (G.bets[id] || 0) + amt;
        G.pot += amt;
        if ((G.chips[id] || 0) <= 0) { G.chips[id] = 0; G.allin[id] = true; }
      }
      function reopen(id) { G.order.forEach(function (pid) { if (pid !== id && !G.folded[pid]) G.acted[pid] = false; }); }

      /* nächster Sitz nach `after`, der noch handeln MUSS (nicht gefoldet/all-in
         und entweder noch nicht gehandelt oder Einsatz < currentBet). -1 = Runde fertig. */
      function nextSeatToAct(after) {
        var n = G.order.length;
        for (var k = 1; k <= n; k++) {
          var s = (after + k) % n, id = G.order[s];
          if (G.folded[id] || G.allin[id]) continue;
          if (!G.acted[id] || (G.bets[id] || 0) < G.currentBet) return s;
        }
        return -1;
      }
      function assignTurn(seat) {
        var id = G.order[seat];
        G.toAct = id; G.turnEndsAt = nowFn() + TURN_MS;
        botActAt = isBot(id) ? (nowFn() + BOT_MIN + Math.random() * BOT_SPAN) : Infinity;
      }
      function resetStreet() { G.order.forEach(function (id) { G.bets[id] = 0; G.acted[id] = false; }); }

      function startHand(now) {
        now = now || nowFn();
        var ids = seatedIds();
        if (ids.length < MINP) { G.order = ids; G.phase = 'waiting'; G.toAct = null; pushShared(); return; }
        ids = ids.slice(0, 6);
        var n = ids.length;
        G.order = ids;
        ids.forEach(function (id) { if (G.chips[id] == null) G.chips[id] = START; if (G.chips[id] <= 0) G.chips[id] = START; });
        if (G.button == null) G.button = (Math.random() * n) | 0; else G.button = (G.button + 1) % n;
        G.button = G.button % n;

        G.folded = {}; G.allin = {}; G.acted = {}; G.bets = {}; G.hands = {};
        G.board = []; G.pot = 0; G.result = null; G.lastAction = null;
        G.currentBet = BB; G.minRaise = BB; G.phase = 'betting'; G.street = 'preflop';

        var deck = P.shuffle(P.makeDeck());
        ids.forEach(function (id) { G.hands[id] = [deck.pop(), deck.pop(), deck.pop(), deck.pop()]; });
        G.deck = deck;

        var sbSeat, bbSeat;
        if (n === 2) { sbSeat = G.button; bbSeat = (G.button + 1) % n; }
        else { sbSeat = (G.button + 1) % n; bbSeat = (G.button + 2) % n; }
        commit(sbSeat, SB); commit(bbSeat, BB); G.currentBet = BB;
        G.handId = (G.handId || 0) + 1;

        var s = nextSeatToAct(bbSeat);
        if (s < 0) { dealTo(5); G.street = 'river'; showdown(); return; }
        assignTurn(s); pushShared();
      }

      function applyAction(id, action, amount) {
        if (!G || G.phase !== 'betting' || G.toAct !== id) return;
        var seat = G.order.indexOf(id); if (seat < 0) return;
        if (G.folded[id] || G.allin[id]) return;
        var cb = G.currentBet, myBet = G.bets[id] || 0, chips = G.chips[id] || 0, mr = G.minRaise;

        if (action === 'fold') {
          G.folded[id] = true; G.acted[id] = true; G.lastAction = { id: id, action: 'fold' };
        } else if (action === 'check' && myBet >= cb) {
          G.acted[id] = true; G.lastAction = { id: id, action: 'check' };
        } else if (action === 'allin') {
          var before = cb; commit(seat, chips); G.acted[id] = true;
          if ((G.bets[id] || 0) > before) { G.currentBet = G.bets[id]; reopen(id); }
          G.lastAction = { id: id, action: 'allin', amount: G.bets[id] };
        } else if (action === 'raise') {
          var maxTotal = myBet + chips, target = Math.round(amount) || 0, minTarget = cb + mr;
          if (target > maxTotal) target = maxTotal;
          if (target < minTarget && target < maxTotal) target = Math.min(minTarget, maxTotal);
          if (target <= myBet) {                               // effektiv nur Call/Check
            var need = Math.max(0, Math.min(cb - myBet, chips)); commit(seat, need); G.acted[id] = true;
            G.lastAction = { id: id, action: need > 0 ? 'call' : 'check', amount: need };
          } else {
            var before2 = cb; commit(seat, target - myBet); G.acted[id] = true;
            if ((G.bets[id] || 0) > before2) { G.currentBet = G.bets[id]; reopen(id); }
            G.lastAction = { id: id, action: 'raise', amount: G.bets[id] };
          }
        } else {                                               // call (Default)
          var need2 = Math.max(0, Math.min(cb - myBet, chips)); commit(seat, need2); G.acted[id] = true;
          G.lastAction = { id: id, action: need2 > 0 ? 'call' : 'check', amount: need2 };
        }
        afterAction(seat);
      }

      function afterAction(seat) {
        if (contenders().length <= 1) { showdown(); return; }
        var next = nextSeatToAct(seat);
        if (next >= 0) { assignTurn(next); pushShared(); return; }
        if (G.street === 'river') { showdown(); return; }
        endStreet();
      }

      function endStreet() {
        var ns = G.street === 'preflop' ? 'flop' : G.street === 'flop' ? 'turn' : 'river';
        resetStreet();
        if (canActIds().length <= 1) { dealTo(5); G.street = 'river'; showdown(); return; }
        if (ns === 'flop') dealTo(3); else dealTo(G.board.length + 1);
        G.street = ns; G.currentBet = 0; G.minRaise = BB;
        var s = nextSeatToAct(G.button);
        if (s < 0) { dealTo(5); G.street = 'river'; showdown(); return; }
        assignTurn(s); pushShared();
      }

      function showdown() {
        var now = nowFn(), cont = contenders(), potWas = G.pot, result;
        if (cont.length === 1) {
          var w = cont[0]; G.chips[w] = (G.chips[w] || 0) + G.pot;
          result = { winners: [w], amounts: {}, byFold: true, potWas: potWas };
          result.amounts[w] = potWas;
        } else {
          var best = null, evs = {};
          cont.forEach(function (id) { var ev = bestOmaha(G.hands[id], G.board); evs[id] = ev; if (!best || P.compare(ev, best) > 0) best = ev; });
          var winners = cont.filter(function (id) { return P.compare(evs[id], best) === 0; });
          var share = Math.floor(G.pot / winners.length), rem = G.pot - share * winners.length;
          var amounts = {};
          winners.forEach(function (id, idx) { var amt = share + (idx === 0 ? rem : 0); G.chips[id] = (G.chips[id] || 0) + amt; amounts[id] = amt; });
          result = { winners: winners, amounts: amounts, byFold: false, potWas: potWas, handName: P.handName(best) };
        }
        G.pot = 0; G.toAct = null; G.phase = 'showdown'; G.result = result;
        G.handOverAt = now + (result.byFold ? FOLDWIN_MS : SHOWDOWN_MS);
        botActAt = Infinity;
        pushShared();
      }

      /* ======================================================= *
       *  Host-Takt: Bots, Zug-Timer, Hand-Wechsel, Intents
       * ======================================================= */
      function hostStep() {
        if (isMulti && amHost() && !hosting) becomeHost();
        if (isMulti && !amHost()) { hosting = false; return; }
        maybeInitHost(nowFn());
        if (!G) return;
        processIntents();
        var now = nowFn();
        if (G.phase === 'betting') {
          if (G.toAct == null) return;
          if (isBot(G.toAct)) {
            if (now >= botActAt) { var d = botDecide(G.toAct); applyAction(G.toAct, d.action, d.amount); }
          } else if (now >= (G.turnEndsAt || 0)) {
            var canCheck = (G.bets[G.toAct] || 0) >= G.currentBet;
            applyAction(G.toAct, canCheck ? 'check' : 'fold');
          }
        } else if (G.phase === 'showdown') {
          if (now >= (G.handOverAt || 0)) startHand(now);
        }
      }
      function processIntents() {
        if (!isMulti || !amHost() || !G) return;
        room.players().forEach(function (p) {
          if (p.id === me.id) return;
          var st = p.state;
          if (st && typeof st.seq === 'number' && st.seq > (lastSeq[p.id] || 0)) {
            lastSeq[p.id] = st.seq;
            if (G.phase === 'betting' && G.toAct === p.id) applyAction(p.id, st.action, st.amount);
          }
        });
      }
      function botDecide(id) {
        var hole = G.hands[id] || [], strength = handStrength(hole, G.board);
        var cb = G.currentBet, myBet = G.bets[id] || 0, chips = G.chips[id] || 0, mr = G.minRaise;
        var toCall = Math.max(0, cb - myBet), maxTotal = myBet + chips, r = Math.random();
        if (toCall <= 0) {
          if (strength > 0.66 && r < 0.6 && maxTotal >= cb + mr) return { action: 'raise', amount: botRaiseTo(id, strength) };
          return { action: 'check' };
        }
        var callAll = toCall >= chips, potOdds = toCall / (G.pot + toCall);
        if (strength < 0.30 && (potOdds > 0.12 || toCall > chips * 0.25) && r < 0.85) return { action: 'fold' };
        if (strength > 0.80 && r < 0.55 && maxTotal >= cb + mr && !callAll) return { action: 'raise', amount: botRaiseTo(id, strength) };
        if (callAll) { if (strength > 0.55 || toCall < chips * 0.4 || r < 0.45) return { action: 'call' }; return { action: 'fold' }; }
        return { action: 'call' };
      }
      function botRaiseTo(id, strength) {
        var cb = G.currentBet, mr = G.minRaise, myBet = G.bets[id] || 0, chips = G.chips[id] || 0;
        var mult = strength > 0.9 ? 3 : strength > 0.75 ? 2 : 1;
        var to = cb + mr * mult + (Math.random() < 0.3 ? mr : 0), maxTotal = myBet + chips;
        return Math.min(to, maxTotal);
      }

      /* ======================================================= *
       *  Netzwerk-Push / View-Auswahl
       * ======================================================= */
      function pushShared() {
        if (!isMulti || !amHost() || !G) return;
        room.setShared({
          handId: G.handId, phase: G.phase, street: G.street, button: G.button, order: G.order,
          chips: G.chips, hands: G.hands, board: G.board, deck: G.deck, pot: G.pot, bets: G.bets,
          folded: G.folded, allin: G.allin, acted: G.acted, currentBet: G.currentBet, minRaise: G.minRaise,
          toAct: G.toAct, turnEndsAt: G.turnEndsAt, result: G.result, handOverAt: G.handOverAt, lastAction: G.lastAction
        });
      }
      function view() { if ((amHost() || !isMulti) && G) return G; return lastShared || {}; }

      /* ======================================================= *
       *  Eigene Aktion senden
       * ======================================================= */
      function act(action, amount) {
        var v = view();
        if (v.phase !== 'betting' || v.toAct !== me.id) return;
        if (amHost() || !isMulti) { applyAction(me.id, action, amount); }
        else { mySeq++; room.reportState({ seq: mySeq, action: action, amount: amount || 0 }); myPending = true; myPendingAt = nowFn(); }
        render();
      }

      /* ======================================================= *
       *  Rendern
       * ======================================================= */
      function render() {
        if (destroyed) return;
        if (isMulti && room.players().length < MINP) { ensureWait(); paintWait(false); return; }
        var v = view();
        if (!v || !v.order || !v.order.length || v.phase === 'waiting') { ensureWait(); paintWait(true); return; }
        ensureTable(); paintTable(v);
      }

      /* ---- Warteraum ---- */
      function ensureWait() {
        if (curView === 'wait') return;
        curView = 'wait';
        var count = el('div', { class: 'om-big neon' }, ['1 / ' + MINP]);
        var msg = el('p', { class: 'om-sub' }, ['']);
        waitRefs = { count: count, msg: msg };
        root.innerHTML = '';
        root.appendChild(el('div', { class: 'om-panel glass' }, [
          el('div', { class: 'om-wait-icon' }, ['🃏']),
          el('h2', { class: 'neon' }, ['Omaha']),
          count, msg,
          el('div', { class: 'om-actions' }, [el('button', { class: 'btn btn-ghost', type: 'button', onclick: ctx.onExit }, ['Zurück zur Lobby'])])
        ]));
      }
      function paintWait(starting) {
        var n = isMulti ? room.players().length : 1;
        waitRefs.count.textContent = n + ' / ' + MINP;
        waitRefs.msg.textContent = starting ? 'Spiel startet gleich …' : 'Warte auf Mitspieler …';
      }

      /* ---- Tisch aufbauen (EINMAL) ---- */
      function ensureTable() {
        if (curView === 'table') return;
        curView = 'table';
        var hand = el('div', { class: 'om-hand' }, ['Hand 1']);
        var street = el('div', { class: 'om-streetpill' }, ['Preflop']);
        var top = el('div', { class: 'om-top' }, [
          el('div', { class: 'om-brand neon' }, ['🃏 Omaha']),
          el('div', { class: 'om-top-right' }, [hand, street])
        ]);

        var comm = [], commRow = el('div', { class: 'om-community' });
        for (var i = 0; i < 5; i++) { var c = el('div', { class: 'om-card om-empty' }); comm.push(c); commRow.appendChild(c); }
        var pot = el('div', { class: 'om-pot' }, ['Pot: 0']);
        var felt = el('div', { class: 'om-felt glass' }, [commRow, pot]);

        var blatt = el('div', { class: 'om-blatt' }, ['']);
        var status = el('div', { class: 'om-status' }, ['']);
        var seats = el('div', { class: 'om-seats' });

        var fold = el('button', { class: 'btn btn-danger om-abtn', type: 'button' }, ['Fold']);
        var check = el('button', { class: 'btn om-abtn', type: 'button' }, ['Check']);
        var call = el('button', { class: 'btn btn-aqua om-abtn', type: 'button' }, ['Mitgehen']);
        var allin = el('button', { class: 'btn om-abtn om-allin', type: 'button' }, ['All-In']);
        var slider = el('input', { class: 'om-slider', type: 'range', min: '0', max: '100', value: '0', step: String(SB) });
        var raiseBtn = el('button', { class: 'btn btn-primary om-abtn', type: 'button' }, ['Erhöhen']);
        var raiseWrap = el('div', { class: 'om-raise' }, [slider, raiseBtn]);
        var btnRow = el('div', { class: 'om-abtns' }, [fold, check, call, raiseWrap, allin]);
        var timerFill = el('div', { class: 'om-timer-fill' });
        var action = el('div', { class: 'om-action glass' }, [el('div', { class: 'om-timer' }, [timerFill]), btnRow]);

        var back = el('button', { class: 'btn btn-ghost', type: 'button', onclick: ctx.onExit }, ['← Zurück']);
        var wrapEl = el('div', { class: 'om-wrap' }, [top, felt, blatt, status, action, seats, el('div', { class: 'om-foot' }, [back])]);
        root.innerHTML = ''; root.appendChild(wrapEl);

        T = {
          hand: hand, street: street, comm: comm, pot: pot, felt: felt, blatt: blatt, status: status, seats: seats,
          action: action, fold: fold, check: check, call: call, allin: allin, slider: slider, raiseBtn: raiseBtn,
          raiseWrap: raiseWrap, timerFill: timerFill
        };
        seatSig = null; seatEls = {};

        fold.onclick = function () { act('fold'); };
        check.onclick = function () { act('check'); };
        call.onclick = function () { act('call'); };
        raiseBtn.onclick = function () { act('raise', raiseVal); };
        allin.onclick = function () { act('allin'); };
        slider.oninput = function () {
          raiseVal = +slider.value || 0;
          var v = view(), cb = v.currentBet || 0, maxTotal = ((v.bets || {})[me.id] || 0) + ((v.chips || {})[me.id] || 0);
          raiseBtn.textContent = (cb > 0 ? 'Erhöhen auf ' : 'Setzen ') + raiseVal + (raiseVal >= maxTotal ? ' (All-In)' : '');
        };
      }

      function ensureSeats(order) {
        var sig = order.join('|'); if (sig === seatSig) return;
        seatSig = sig; seatEls = {}; T.seats.innerHTML = '';
        order.forEach(function (id) {
          var nameEl = el('div', { class: 'om-seat-name' }, ['']);
          var dealer = el('span', { class: 'om-dealer' }, ['D']);
          var badge = el('span', { class: 'om-badge' }, ['']);
          var head = el('div', { class: 'om-seat-head' }, [nameEl, dealer, badge]);
          var cards = [], cwrap = el('div', { class: 'om-seat-cards' });
          for (var i = 0; i < 4; i++) { var cd = el('div', { class: 'om-card om-mini om-empty' }); cards.push(cd); cwrap.appendChild(cd); }
          var hn = el('div', { class: 'om-seat-hn' }, ['']);
          var chips = el('span', { class: 'om-seat-chips' }, ['💰 0']);
          var bet = el('span', { class: 'om-seat-bet' }, ['']);
          var foot = el('div', { class: 'om-seat-foot' }, [chips, bet]);
          var rootEl = el('div', { class: 'om-seat' }, [head, cwrap, hn, foot]);
          seatEls[id] = { root: rootEl, name: nameEl, dealer: dealer, badge: badge, cards: cards, hn: hn, chips: chips, bet: bet };
          T.seats.appendChild(rootEl);
        });
      }

      /* Karte zeichnen: mode 'face' | 'back' | 'empty' (mit Caching gegen Flackern) */
      function paintCard(cardEl, card, mode) {
        var base = cardEl.classList.contains('om-mini') ? 'om-card om-mini ' : 'om-card ';
        if (mode === 'empty') { if (cardEl._mode !== 'empty') { cardEl.className = base + 'om-empty'; cardEl.innerHTML = ''; } cardEl._mode = 'empty'; cardEl._card = null; return; }
        if (mode === 'back') { if (cardEl._mode !== 'back') { cardEl.className = base + 'om-back'; cardEl.innerHTML = ''; } cardEl._mode = 'back'; cardEl._card = null; return; }
        if (cardEl._mode === 'face' && cardEl._card === card) return;
        var r = card[0], s = card[1], red = (s === 'h' || s === 'd');
        cardEl.className = base + (red ? 'om-red' : 'om-dark');
        cardEl.innerHTML = '';
        cardEl.appendChild(el('span', { class: 'om-c-r' }, [r === 'T' ? '10' : r]));
        cardEl.appendChild(el('span', { class: 'om-c-s' }, [P.SUIT_SYM[s]]));
        cardEl._mode = 'face'; cardEl._card = card;
      }

      function paintTable(v) {
        var nm = nameMap(), order = v.order || [];
        var bets = v.bets || {}, chips = v.chips || {}, hands = v.hands || {}, folded = v.folded || {}, allin = v.allin || {};
        if (v.toAct !== me.id) { myPending = false; }

        T.hand.textContent = 'Hand ' + (v.handId || 1);
        T.street.textContent = v.phase === 'showdown' ? 'Showdown' : streetLabel(v.street);
        T.pot.textContent = 'Pot: ' + (v.pot || 0);

        for (var i = 0; i < 5; i++) { var b = v.board && v.board[i]; paintCard(T.comm[i], b || null, b ? 'face' : 'empty'); }

        ensureSeats(order);
        var dealerId = order[v.button];
        order.forEach(function (id) {
          var refs = seatEls[id]; if (!refs) return;
          var isMe = id === me.id, isFold = !!folded[id], isAll = !!allin[id];
          var isTurn = v.toAct === id && v.phase === 'betting';
          var isWin = v.phase === 'showdown' && v.result && v.result.winners.indexOf(id) >= 0;
          refs.name.textContent = nameOf(id, nm) + (isMe ? ' (du)' : '');
          refs.chips.textContent = '💰 ' + (chips[id] || 0);
          var bet = bets[id] || 0;
          refs.bet.textContent = bet > 0 ? ('Einsatz ' + bet) : '';
          refs.bet.style.display = bet > 0 ? '' : 'none';
          refs.dealer.style.display = id === dealerId ? '' : 'none';

          var badge = '', bcls = '';
          if (isFold) { badge = 'Fold'; bcls = 'fold'; }
          else if (isAll) { badge = 'All-In'; bcls = 'allin'; }
          else if (isTurn) { badge = '● Zug'; bcls = 'turn'; }
          refs.badge.textContent = badge; refs.badge.className = 'om-badge ' + bcls; refs.badge.style.display = badge ? '' : 'none';

          var hand = hands[id];
          var revealShow = v.phase === 'showdown' && v.result && !v.result.byFold && !isFold;
          var reveal = isMe || revealShow;
          for (var k = 0; k < 4; k++) {
            var c = hand && hand[k];
            if (!c || (isFold && !isMe)) paintCard(refs.cards[k], null, 'empty');
            else if (reveal) paintCard(refs.cards[k], c, 'face');
            else paintCard(refs.cards[k], c, 'back');
          }
          if (revealShow && hand && v.board && v.board.length >= 5) {
            refs.hn.textContent = handNameOf(hand, v.board); refs.hn.style.display = '';
          } else { refs.hn.style.display = 'none'; }

          refs.root.className = 'om-seat' + (isMe ? ' me' : '') + (isFold ? ' folded' : '') +
            (isTurn ? ' act' : '') + (isWin ? ' winner' : '') + (isAll && !isFold ? ' isallin' : '');
        });

        // Eigenes aktuelles Blatt
        var myHole = hands[me.id];
        if (myHole && !folded[me.id] && v.board && v.board.length >= 3) T.blatt.textContent = '🖐 Dein Blatt: ' + handNameOf(myHole, v.board);
        else if (myHole && !folded[me.id]) T.blatt.textContent = '🖐 Deine 4 Hole-Cards — nutze genau 2 + 3 vom Board';
        else if (myHole) T.blatt.textContent = '🚫 Du hast gefoldet';
        else T.blatt.textContent = '';

        paintStatus(v, nm);
        paintAction(v);
        handleResultToast(v, nm);
        countOwnWin(v);
      }

      /* Bestenliste: client-seitig aus dem gerenderten Ergebnis — genau 1× pro Hand,
         nur wenn ICH (me.id) unter den winners bin. Jeder Client zählt für sich. */
      function countOwnWin(v) {
        if (v.phase !== 'showdown' || !v.result || !v.result.winners || v.handId === lastScoredHand) return;
        lastScoredHand = v.handId;
        if (v.result.winners.indexOf(me.id) >= 0 && App.Scores && App.Scores.winCurrent) App.Scores.winCurrent();
      }

      function streetLabel(st) { return st === 'preflop' ? 'Preflop' : st === 'flop' ? 'Flop' : st === 'turn' ? 'Turn' : 'River'; }

      function paintStatus(v, nm) {
        if (v.phase === 'showdown' && v.result) {
          var res = v.result, names = res.winners.map(function (id) { return nameOf(id, nm); });
          T.status.textContent = res.byFold
            ? ('🏆 ' + names.join(' & ') + ' gewinnt den Pot (' + (res.potWas || 0) + ')')
            : ('🏆 ' + names.join(' & ') + ' gewinnt mit ' + (res.handName || '') + ' (' + (res.potWas || 0) + ')');
          T.status.className = 'om-status win'; return;
        }
        if (v.toAct == null) { T.status.textContent = '…'; T.status.className = 'om-status'; return; }
        var cd = Math.max(0, Math.ceil(((v.turnEndsAt || 0) - nowFn()) / 1000));
        if (v.toAct === me.id) { T.status.textContent = '➡ Du bist am Zug · ' + cd + 's'; T.status.className = 'om-status you'; }
        else { T.status.textContent = nameOf(v.toAct, nm) + ' ist am Zug · ' + cd + 's'; T.status.className = 'om-status'; }
      }

      function paintAction(v) {
        if (myPending && (nowFn() - myPendingAt) > 3000) myPending = false;
        var mine = v.phase === 'betting' && v.toAct === me.id && !myPending;
        T.action.style.display = mine ? '' : 'none';
        if (!mine) return;
        var myBet = (v.bets || {})[me.id] || 0, myChips = (v.chips || {})[me.id] || 0, cb = v.currentBet || 0, mr = v.minRaise || BB;
        var toCall = Math.max(0, Math.min(cb - myBet, myChips));
        var canCheck = myBet >= cb, maxTotal = myBet + myChips, minRaiseTo = cb + mr;
        var canRaise = myChips > 0 && maxTotal >= minRaiseTo;

        T.check.style.display = canCheck ? '' : 'none';
        T.call.style.display = (!canCheck && toCall > 0) ? '' : 'none';
        T.call.textContent = 'Mitgehen ' + toCall + (toCall >= myChips && toCall > 0 ? ' (All-In)' : '');

        T.raiseWrap.style.display = canRaise ? '' : 'none';
        if (canRaise) {
          T.slider.min = minRaiseTo; T.slider.max = maxTotal; T.slider.step = SB;
          if (raiseVal < minRaiseTo || raiseVal > maxTotal) raiseVal = minRaiseTo;
          T.slider.value = raiseVal;
          T.raiseBtn.textContent = (cb > 0 ? 'Erhöhen auf ' : 'Setzen ') + raiseVal + (raiseVal >= maxTotal ? ' (All-In)' : '');
        }
        T.allin.style.display = myChips > 0 ? '' : 'none';
        T.allin.textContent = 'All-In (' + myChips + ')';

        var frac = clamp(((v.turnEndsAt || 0) - nowFn()) / TURN_MS, 0, 1);
        T.timerFill.style.width = (frac * 100) + '%';
        T.timerFill.className = 'om-timer-fill' + (frac < 0.3 ? ' low' : '');
      }

      function handleResultToast(v, nm) {
        if (v.phase === 'showdown' && v.result && v.handId !== lastToastHand) {
          lastToastHand = v.handId;
          var res = v.result;
          if (res.winners.indexOf(me.id) >= 0) UI.toast('🎉 Gewonnen: +' + (res.amounts[me.id] || res.potWas || 0) + ' Chips', 'win');
          else UI.toast(nameOf(res.winners[0], nm) + ' gewinnt die Hand', 'lose');
        }
      }

      /* ======================================================= *
       *  Aufräumen
       * ======================================================= */
      function cleanup() {
        destroyed = true;
        stopTimers();
        if (isMulti && room) {
          if (onSharedFn) room.off('shared', onSharedFn);
          if (onPlayersFn) room.off('players', onPlayersFn);
        }
        onSharedFn = null; onPlayersFn = null;
      }
    }
  };

  /* ===================== CSS ===================== */
  function injectStyle() {
    UI.injectStyle('mg-omaha-css', [
      '.om-wrap{display:flex;flex-direction:column;gap:14px;max-width:760px;margin:0 auto;}',
      '.om-top{display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;}',
      '.om-brand{font-weight:900;font-size:20px;}',
      '.om-top-right{display:flex;align-items:center;gap:10px;}',
      '.om-hand{font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;font-weight:800;}',
      '.om-streetpill{display:inline-flex;align-items:center;padding:6px 14px;border-radius:999px;font-weight:900;font-size:13px;border:1px solid var(--stroke-2);background:rgba(9,32,21,.6);color:var(--aqua-soft);}',

      /* Filz / Community */
      '.om-felt{padding:20px 16px;display:flex;flex-direction:column;gap:14px;align-items:center;background:radial-gradient(circle at 50% 35%,rgba(11,54,34,.85),rgba(4,16,10,.92));border:1px solid var(--stroke-2);}',
      '.om-community{display:flex;gap:8px;justify-content:center;flex-wrap:wrap;}',
      '.om-pot{font-weight:900;font-size:clamp(16px,4.4vw,22px);color:var(--gold);text-shadow:0 0 12px rgba(255,210,63,.4);font-variant-numeric:tabular-nums;}',

      /* Karten */
      '.om-card{width:clamp(40px,11vw,58px);height:clamp(56px,15.4vw,82px);border-radius:9px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1px;background:#f4fbf5;border:1px solid rgba(0,0,0,.2);box-shadow:0 3px 8px rgba(0,0,0,.4);user-select:none;-webkit-user-select:none;position:relative;transition:transform .12s;}',
      '.om-card.om-mini{width:clamp(30px,8.2vw,42px);height:clamp(42px,11.4vw,60px);border-radius:7px;}',
      '.om-c-r{font-weight:900;font-size:clamp(16px,4.6vw,24px);line-height:1;}',
      '.om-card.om-mini .om-c-r{font-size:clamp(13px,3.6vw,18px);}',
      '.om-c-s{font-size:clamp(15px,4.2vw,22px);line-height:1;}',
      '.om-card.om-mini .om-c-s{font-size:clamp(12px,3.4vw,17px);}',
      '.om-red{color:#d61f3f;} .om-dark{color:#14212b;}',
      '.om-empty{background:rgba(4,16,10,.55);border:1px dashed var(--stroke);box-shadow:none;}',
      '.om-back{background:repeating-linear-gradient(45deg,#0b3d24,#0b3d24 6px,#0f5231 6px,#0f5231 12px);border:1px solid var(--stroke-2);box-shadow:0 3px 8px rgba(0,0,0,.4),inset 0 0 0 3px rgba(4,16,10,.7),inset 0 0 0 4px var(--neon);}',

      /* Blatt / Status */
      '.om-blatt{text-align:center;font-weight:800;font-size:13px;color:var(--leaf);min-height:18px;}',
      '.om-status{text-align:center;font-weight:900;font-size:clamp(15px,4vw,19px);min-height:24px;color:var(--aqua);}',
      '.om-status.you{color:var(--neon);text-shadow:0 0 10px rgba(57,255,20,.45);}',
      '.om-status.win{color:var(--gold);text-shadow:0 0 12px rgba(255,210,63,.5);}',

      /* Aktionsleiste */
      '.om-action{padding:12px 14px;display:flex;flex-direction:column;gap:10px;border:1px solid var(--stroke-2);box-shadow:var(--glow-soft);}',
      '.om-timer{height:6px;border-radius:999px;background:rgba(4,16,10,.7);overflow:hidden;}',
      '.om-timer-fill{height:100%;width:100%;border-radius:999px;background:linear-gradient(90deg,var(--aqua),var(--neon));transition:width .25s linear;}',
      '.om-timer-fill.low{background:linear-gradient(90deg,var(--danger),var(--gold));}',
      '.om-abtns{display:flex;flex-wrap:wrap;gap:8px;align-items:stretch;}',
      '.om-abtn{flex:1 1 auto;min-width:96px;padding:12px 10px;font-weight:900;font-size:14px;}',
      '.om-allin{color:var(--gold);border-color:rgba(255,210,63,.55);background:rgba(40,32,6,.7);}',
      '.om-raise{flex:2 1 220px;display:flex;gap:8px;align-items:center;min-width:200px;}',
      '.om-slider{flex:1;-webkit-appearance:none;appearance:none;height:8px;border-radius:999px;background:rgba(9,32,21,.9);border:1px solid var(--stroke-2);outline:none;}',
      '.om-slider::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:20px;height:20px;border-radius:50%;background:var(--neon);box-shadow:0 0 10px rgba(57,255,20,.6);cursor:pointer;border:2px solid #04160c;}',
      '.om-slider::-moz-range-thumb{width:20px;height:20px;border-radius:50%;background:var(--neon);box-shadow:0 0 10px rgba(57,255,20,.6);cursor:pointer;border:2px solid #04160c;}',
      '.om-raise .om-abtn{flex:0 0 auto;min-width:0;white-space:nowrap;}',

      /* Sitze */
      '.om-seats{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px;}',
      '.om-seat{display:flex;flex-direction:column;gap:7px;padding:10px 11px;border-radius:14px;background:rgba(9,32,21,.6);border:1px solid var(--stroke);transition:border-color .18s,box-shadow .18s,opacity .18s;}',
      '.om-seat.me{border-color:var(--stroke-2);box-shadow:var(--glow-soft);}',
      '.om-seat.act{border-color:var(--neon);box-shadow:0 0 0 1px var(--neon),0 0 16px rgba(57,255,20,.32);}',
      '.om-seat.folded{opacity:.5;}',
      '.om-seat.isallin{border-color:var(--gold);}',
      '.om-seat.winner{border-color:var(--gold);box-shadow:0 0 20px rgba(255,210,63,.5);}',
      '.om-seat-head{display:flex;align-items:center;gap:6px;}',
      '.om-seat-name{flex:1;font-weight:800;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;}',
      '.om-dealer{flex:0 0 auto;width:19px;height:19px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-size:11px;font-weight:900;color:#04160c;background:var(--gold);box-shadow:0 0 8px rgba(255,210,63,.5);}',
      '.om-badge{flex:0 0 auto;font-size:10px;font-weight:900;padding:2px 7px;border-radius:999px;text-transform:uppercase;letter-spacing:.5px;border:1px solid var(--stroke);color:var(--muted);}',
      '.om-badge.turn{color:var(--neon);border-color:var(--stroke-2);}',
      '.om-badge.allin{color:var(--gold);border-color:rgba(255,210,63,.5);background:rgba(40,32,6,.6);}',
      '.om-badge.fold{color:var(--muted);}',
      '.om-seat-cards{display:flex;gap:4px;justify-content:center;}',
      '.om-seat-hn{text-align:center;font-size:11px;font-weight:800;color:var(--gold);min-height:14px;}',
      '.om-seat-foot{display:flex;justify-content:space-between;align-items:center;gap:6px;}',
      '.om-seat-chips{font-weight:900;color:var(--gold);font-variant-numeric:tabular-nums;font-size:13px;}',
      '.om-seat-bet{font-size:11px;font-weight:800;color:var(--aqua);font-variant-numeric:tabular-nums;}',
      '.om-foot{display:flex;justify-content:center;margin-top:4px;}',

      /* Warteraum / Panel */
      '.om-panel{padding:28px 22px;text-align:center;display:flex;flex-direction:column;gap:14px;align-items:center;max-width:460px;margin:0 auto;}',
      '.om-wait-icon{font-size:52px;animation:om-bob 2.4s ease-in-out infinite;filter:drop-shadow(0 0 12px rgba(57,255,20,.4));}',
      '@keyframes om-bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-7px)}}',
      '.om-big{font-size:clamp(23px,7vw,36px);font-weight:900;line-height:1.15;margin:0;}',
      '.om-sub{color:var(--muted);margin:0;}',
      '.om-actions{display:flex;gap:10px;justify-content:center;flex-wrap:wrap;margin-top:4px;}'
    ].join(''));
  }
})();
