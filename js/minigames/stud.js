/* stud.js — "Seven-Card Stud": Mehrspieler-Poker im Neon-Dschungel-Look.
 *
 * Klassisches Seven-Card Stud OHNE Gemeinschaftskarten und OHNE Blinds:
 *   - Ante (5) von jedem vor der Hand.
 *   - 3rd Street: 2 verdeckte + 1 offene Karte. Der Spieler mit der NIEDRIGSTEN
 *     offenen Karte (Gleichstand ♣<♦<♥<♠) zahlt den Bring-in (10) und beginnt.
 *   - 4th/5th/6th Street: je 1 weitere OFFENE Karte, Setzrunde beginnt beim
 *     höchsten offenen (Teil-)Blatt.
 *   - 7th Street: je 1 weitere VERDECKTE Karte, letzte Setzrunde.
 *   - Showdown: beste 5 aus 7 (App.Poker.evalBest). Höchste gewinnt, Split bei
 *     Gleichstand. Vereinfacht: EIN Haupt-Pot (keine Side-Pots).
 *
 * Architektur (Pflicht): host-autoritativ + Intents (wie chess.js / craps.js).
 *   - NUR der Host (bzw. Solo = du) führt die Engine und schreibt den GESAMTEN
 *     Tisch-Zustand via room.setShared({ stud:{...} }). Alle rendern aus 'shared'.
 *   - Spieler senden Aktionen als Intent:
 *         room.reportState({ seq, action:'fold'|'check'|'call'|'raise'|'allin', amount })
 *     Der Host wendet jeden Intent GENAU EINMAL an — nur wenn der Spieler am Zug
 *     ist (zuletzt angewandte seq je Spieler gemerkt).
 *   - Per-Room-Chips: shared.chips[playerId], Start 1000 (App.Coins bleibt unberührt).
 *   - Karten-Sichtbarkeit: offene Karten liegen öffentlich in shared.up[id],
 *     verdeckte in shared.hole[id]. Jeder Client zeigt NUR seine eigenen hole
 *     offen; fremde verdeckte = Rückseite (erst im Showdown aufgedeckt).
 *   - SOLO: Host = du + 3 Bots. MULTI: echte Spieler, leere Plätze auf 3 mit Bots
 *     aufgefüllt. Bots agieren nach ~800 ms heuristisch nach sichtbarer Stärke.
 *
 * DOM wird EINMAL gebaut und danach nur in-place aktualisiert (kein Flackern).
 * cleanup() stoppt alle Timer und entfernt die Room-Listener. */
(function () {
  'use strict';
  window.App = window.App || {}; App.Minigames = App.Minigames || {};
  var UI = App.UI, el = UI.el, MG = App.MG;

  injectStyle();

  /* ---- Konstanten ---- */
  var START_CHIPS = 1000;
  var ANTE = 5;
  var BRING_IN = 10;
  var MIN_RAISE = 20;
  var TURN_MS = 25000;       // Zug-Timer (Auto-Check/Fold)
  var SHOWDOWN_MS = 5200;    // Showdown-Banner
  var FOLDWIN_MS = 2600;     // "alle gefoldet" kurz zeigen
  var RUNOUT_MS = 1300;      // Takt beim Aufdecken wenn alle All-in
  var TICK_MS = 140;
  var BOT_FILL = 3;          // Zieltisch-Größe in Multi (leere Plätze → Bots)
  var SOLO_BOTS = 3;
  var SUIT_ORDER = { c: 0, d: 1, h: 2, s: 3 };  // ♣<♦<♥<♠
  var STREET_NAME = { 3: '3rd Street', 4: '4th Street', 5: '5th Street', 6: '6th Street', 7: '7th Street' };
  var CAT_SHORT = ['Höchste Karte', 'Paar', 'Zwei Paare', 'Drilling', 'Straße', 'Flush', 'Full House', 'Vierling', 'Straight Flush'];

  var BOT_POOL = [
    { id: '_b1', name: '🦜 Coco' }, { id: '_b2', name: '🐒 Momo' },
    { id: '_b3', name: '🐍 Kaa' }, { id: '_b4', name: '🐆 Zara' },
    { id: '_b5', name: '🦎 Rex' }
  ];

  /* ---- kleine reine Helfer ---- */
  function rankVal(c) { return App.Poker.rankVal(c); }
  function suitOf(c) { return App.Poker.suitOf(c); }
  function rankLabel(c) { return c[0] === 'T' ? '10' : c[0]; }
  function shuffleArr(a) { for (var i = a.length - 1; i > 0; i--) { var j = (Math.random() * (i + 1)) | 0; var t = a[i]; a[i] = a[j]; a[j] = t; } return a; }
  function pickBots(n) { return shuffleArr(BOT_POOL.slice()).slice(0, Math.max(0, n)).map(function (b) { return { id: b.id, name: b.name }; }); }
  function copyObj(o) { var r = {}; for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) r[k] = o[k]; return r; }
  function copyArrMap(o) { var r = {}; for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) r[k] = (o[k] || []).slice(); return r; }
  function fmt(n) { return (MG && MG.fmt) ? MG.fmt(n) : String(n); }

  /* Vergleichs-Schlüssel für "wer zeigt das höchste Teil-Blatt" (offene Karten). */
  function showKey(cards) {
    var vals = cards.map(rankVal), count = {};
    vals.forEach(function (v) { count[v] = (count[v] || 0) + 1; });
    var groups = Object.keys(count).map(function (k) { return [count[k], +k]; })
      .sort(function (a, b) { return b[0] - a[0] || b[1] - a[1]; });
    var top = groups[0] ? groups[0][0] : 1;
    var second = groups[1] ? groups[1][0] : 0;
    var cat = top === 4 ? 7 : top === 3 ? 3 : (top === 2 && second === 2) ? 2 : top === 2 ? 1 : 0;
    var key = [cat];
    groups.forEach(function (g) { key.push(g[1]); });
    // Suit-Feintiebreak über höchste Karte
    var topRank = Math.max.apply(null, vals), ts = 0;
    cards.forEach(function (c) { if (rankVal(c) === topRank) ts = Math.max(ts, SUIT_ORDER[suitOf(c)]); });
    key.push(ts / 10);
    return key;
  }
  function cmpKey(a, b) {
    for (var i = 0; i < Math.max(a.length, b.length); i++) { var x = a[i] || 0, y = b[i] || 0; if (x !== y) return x < y ? -1 : 1; }
    return 0;
  }
  function cmpBring(a, b) {   // -1 wenn a die "niedrigere" (bring-in-pflichtige) Karte ist
    var ra = rankVal(a), rb = rankVal(b);
    if (ra !== rb) return ra < rb ? -1 : 1;
    var sa = SUIT_ORDER[suitOf(a)], sb = SUIT_ORDER[suitOf(b)];
    return sa < sb ? -1 : sa > sb ? 1 : 0;
  }
  function catShort(ev) { if (!ev) return '—'; if (ev.cat === 8) return (ev.tie[0] === 14 ? 'Royal Flush' : 'Straight Flush'); return CAT_SHORT[ev.cat]; }

  App.Minigames.stud = {
    id: 'stud', title: 'Seven-Card Stud', icon: '🂭', order: 24,
    subtitle: 'Klassiker ohne Gemeinschaftskarten — offene & verdeckte Karten',
    single: true, multi: true, minPlayers: 2, maxPlayers: 6, group: 'live',

    render: function (root, ctx) {
      var isMulti = ctx.mode === 'multi';
      var room = ctx.room;
      var me = { id: ctx.me.id, name: ctx.me.name || 'Du' };
      var nowFn = isMulti ? function () { return room.now(); } : function () { return Date.now(); };
      function amHost() { return isMulti ? !!(room && room.isHost()) : true; }

      var destroyed = false, timer = null, cdStop = null;
      var sharedL = null, playersL = null;
      var lastShared = isMulti ? ((room.snapshot() && room.snapshot().shared) || null) : null;

      var G = null;                 // autoritativer Zustand (Host/Solo)
      var lastSeq = {};             // zuletzt angewandte Intent-seq je Spieler
      var mySeq = 0;

      // Render-Zustand
      var built = false, refs = {}, seatRefs = {}, seatKey = '';
      var myRaise = MIN_RAISE, lastTurnKey = '', pendingKey = '', endBuiltHand = -1;
      var lastCountedHand = -1;     // Bestenliste: zuletzt gezählte Sieg-Hand (Guard)

      start();
      return { cleanup: cleanup };

      /* ==================== Ablauf ==================== */
      function start() {
        if (isMulti) {
          sharedL = function (sh) { lastShared = sh; };
          playersL = function () { /* loop pollt jede Runde neu */ };
          room.on('shared', sharedL);
          room.on('players', playersL);
          var snap = room.snapshot() || {};
          var startAt = (snap.round && snap.round.startAt) || (room.now() + ((MG && MG.MULTI_START_DELAY) || 3000));
          cdStop = MG.countdown(root, startAt, begin, function () { return room.now(); });
        } else {
          begin();
        }
      }
      function begin() {
        if (destroyed) return;
        cdStop = null;
        buildUI();
        timer = setInterval(loop, TICK_MS);
        loop();
      }

      function loop() {
        if (destroyed) return;
        var now = nowFn();
        if (amHost()) {
          if (!G) ensureHostState(now);
          ensureChips();
          if (isMulti) pollIntents();
          hostStep(now);
        }
        render(currentView(), now);
      }
      function renderNow() { render(currentView(), nowFn()); }
      function currentView() { return amHost() ? G : ((lastShared && lastShared.stud) || null); }

      /* ==================== Host-Setup / Migration ==================== */
      function freshG() {
        return {
          hand: 0, phase: 'idle', street: 3, chips: {}, up: {}, hole: {},
          folded: {}, allin: {}, bet: {}, acted: {}, pot: 0, currentBet: 0,
          toAct: null, order: [], bringInId: null, deadline: 0, botAt: 0,
          runoutAt: 0, showdownAt: 0, lastAction: null, results: null, msg: '',
          botList: [], deck: []
        };
      }
      function setupBots() {
        var real = isMulti ? room.players().length : 1;
        var need = isMulti ? Math.max(0, BOT_FILL - real) : SOLO_BOTS;
        G.botList = pickBots(need);
      }
      function ensureHostState(now) {
        var sh = lastShared && lastShared.stud;
        if (isMulti && sh && sh.order && sh.order.length) becomeHost(now, sh);
        else { G = freshG(); setupBots(); startHand(now); }
      }
      function remainingDeck() {
        var used = {};
        G.order.forEach(function (id) {
          (G.up[id] || []).forEach(function (c) { used[c] = 1; });
          (G.hole[id] || []).forEach(function (c) { used[c] = 1; });
        });
        return shuffleArr(App.Poker.makeDeck().filter(function (c) { return !used[c]; }));
      }
      function becomeHost(now, sh) {
        G = freshG();
        G.hand = sh.hand || 1; G.phase = sh.phase || 'betting'; G.street = sh.street || 3;
        G.chips = copyObj(sh.chips || {}); G.up = copyArrMap(sh.up || {}); G.hole = copyArrMap(sh.hole || {});
        G.folded = copyObj(sh.folded || {}); G.allin = copyObj(sh.allin || {}); G.bet = copyObj(sh.bet || {});
        G.pot = sh.pot || 0; G.currentBet = sh.currentBet || 0; G.toAct = sh.toAct || null;
        G.order = (sh.order || []).slice(); G.bringInId = sh.bringInId || null;
        G.results = sh.results || null; G.msg = sh.msg || '';
        G.botList = (sh.bots || []).map(function (id) { return { id: id, name: (sh.seatNames && sh.seatNames[id]) || 'Bot' }; });
        G.acted = {}; G.order.forEach(function (id) { G.acted[id] = (G.bet[id] || 0) === G.currentBet; });
        G.deck = remainingDeck();
        if (G.phase === 'betting') { G.deadline = now + TURN_MS; G.botAt = isBot(G.toAct) ? now + botMs() : 0; }
        else if (G.phase === 'runout') G.runoutAt = now + RUNOUT_MS;
        else if (G.phase === 'showdown') G.showdownAt = now + SHOWDOWN_MS;
        ensureChips();
        pushShared();
      }

      function participants() {
        var real = isMulti
          ? room.players().map(function (p) { return { id: p.id, name: p.name || 'Spieler' }; })
          : [{ id: me.id, name: me.name }];
        return real.concat((G && G.botList) ? G.botList : []);
      }
      function isBot(id) { return !!(G && G.botList && G.botList.some(function (b) { return b.id === id; })); }
      function nameOf(id) {
        var ps = participants();
        for (var i = 0; i < ps.length; i++) if (ps[i].id === id) return ps[i].name;
        return 'Spieler';
      }
      function ensureChips() {
        if (!G) return;
        participants().forEach(function (p) { if (G.chips[p.id] == null) G.chips[p.id] = START_CHIPS; });
      }
      function botMs() { return 700 + Math.random() * 500; }

      /* ==================== Hand-Ablauf (Host) ==================== */
      function startHand(now) {
        ensureChips();
        var seated = participants().filter(function (p) { return (G.chips[p.id] || 0) > 0; });
        if (seated.length < 2) { gameOver(now); return; }

        G.hand = (G.hand || 0) + 1;
        G.order = seated.map(function (p) { return p.id; });
        G.up = {}; G.hole = {}; G.folded = {}; G.allin = {}; G.bet = {}; G.acted = {};
        G.order.forEach(function (id) { G.up[id] = []; G.hole[id] = []; G.folded[id] = false; G.allin[id] = false; G.bet[id] = 0; G.acted[id] = false; });
        G.currentBet = 0; G.pot = 0; G.results = null; G.street = 3; G.lastAction = null;
        G.deck = shuffleArr(App.Poker.makeDeck());

        // Ante
        G.order.forEach(function (id) {
          var a = Math.min(ANTE, G.chips[id]);
          G.chips[id] -= a; G.pot += a; if (G.chips[id] <= 0) G.allin[id] = true;
        });
        // 3rd Street: 2 verdeckt + 1 offen
        G.order.forEach(function (id) { G.hole[id].push(G.deck.pop()); G.hole[id].push(G.deck.pop()); });
        G.order.forEach(function (id) { G.up[id].push(G.deck.pop()); });

        // Bring-in: niedrigste offene Karte (unter zahlungsfähigen Spielern)
        var cand = G.order.filter(function (id) { return G.chips[id] > 0 && !G.allin[id]; });
        var pool = cand.length ? cand : G.order.slice();
        var bring = pool[0];
        pool.forEach(function (id) { if (cmpBring(G.up[id][0], G.up[bring][0]) < 0) bring = id; });
        G.bringInId = bring;
        var bi = Math.min(BRING_IN, G.chips[bring]);
        G.chips[bring] -= bi; G.bet[bring] = bi; G.pot += bi; G.currentBet = bi; G.acted[bring] = true;
        if (G.chips[bring] <= 0) G.allin[bring] = true;

        G.phase = 'betting';
        G.msg = 'Neue Hand · 3rd Street — Bring-in: ' + nameOf(bring);
        advance(now, bring);   // erster echter Zug nach dem Bring-in
      }

      function dealStreet() {
        var active = G.order.filter(function (id) { return !G.folded[id]; });
        active.forEach(function (id) {
          var c = G.deck.pop(); if (!c) return;
          if (G.street === 7) G.hole[id].push(c); else G.up[id].push(c);
        });
      }

      function needsToAct(id) {
        return !G.folded[id] && !G.allin[id] && (!G.acted[id] || (G.bet[id] || 0) < G.currentBet);
      }
      function nextActor(fromId) {
        var n = G.order.length, start = G.order.indexOf(fromId);
        for (var k = 1; k <= n; k++) { var id = G.order[((start + k) % n + n) % n]; if (needsToAct(id)) return id; }
        return null;
      }
      function firstNeeds(startId) {
        var n = G.order.length, start = G.order.indexOf(startId);
        for (var k = 0; k < n; k++) { var id = G.order[(start + k) % n]; if (needsToAct(id)) return id; }
        return startId;
      }
      function highShowId(ids) {
        var best = ids[0], bk = showKey(G.up[best]);
        ids.forEach(function (id) { var k = showKey(G.up[id]); if (cmpKey(k, bk) > 0) { bk = k; best = id; } });
        return best;
      }
      function resetActed(exceptId) {
        G.order.forEach(function (pid) { G.acted[pid] = false; });
        G.acted[exceptId] = true;
      }
      function setToAct(id, now) {
        G.toAct = id; G.deadline = now + TURN_MS; G.botAt = isBot(id) ? now + botMs() : 0;
        pushShared();
      }

      function advance(now, lastId) {
        var active = G.order.filter(function (id) { return !G.folded[id]; });
        if (active.length <= 1) { endHand(active[0], now); return; }
        var next = nextActor(lastId);
        if (next) { setToAct(next, now); return; }
        // Setzrunde komplett
        var canAct = active.filter(function (id) { return !G.allin[id]; });
        if (G.street >= 7) { showdown(now); return; }
        if (canAct.length <= 1) { beginRunout(now); return; }
        advanceStreet(now);
      }

      function advanceStreet(now) {
        G.street++; dealStreet();
        G.order.forEach(function (id) { G.bet[id] = 0; G.acted[id] = false; });
        G.currentBet = 0; G.lastAction = null;
        var active = G.order.filter(function (id) { return !G.folded[id]; });
        var firstId = highShowId(active);
        var toId = firstNeeds(firstId);
        G.msg = STREET_NAME[G.street] + ' — ' + nameOf(firstId) + ' zeigt das höchste Blatt';
        setToAct(toId, now);
      }

      function beginRunout(now) {
        G.phase = 'runout'; G.runoutAt = now + RUNOUT_MS; G.toAct = null;
        G.msg = 'Alle All-in — Karten werden aufgedeckt …';
        pushShared();
      }

      function showdown(now) {
        var active = G.order.filter(function (id) { return !G.folded[id]; });
        var evals = {}, best = null, winners = [];
        active.forEach(function (id) {
          var ev = App.Poker.evalBest(G.up[id].concat(G.hole[id]));
          evals[id] = { cat: ev.cat, tie: ev.tie.slice() };
          if (!best || App.Poker.compare(ev, best) > 0) { best = ev; winners = [id]; }
          else if (App.Poker.compare(ev, best) === 0) winners.push(id);
        });
        var pot = G.pot;
        var share = Math.floor(pot / winners.length), rem = pot - share * winners.length;
        winners.forEach(function (id, i) { G.chips[id] += share + (i < rem ? 1 : 0); });
        G.results = { showdown: true, evals: evals, winners: winners, pot: pot, share: share };
        G.pot = 0; G.phase = 'showdown'; G.showdownAt = now + SHOWDOWN_MS; G.toAct = null;
        var wn = winners.map(nameOf).join(', ');
        G.msg = '🏆 ' + wn + ' gewinnt ' + fmt(pot) + ' mit ' + catShort(evals[winners[0]]);
        pushShared();
      }

      function endHand(winnerId, now) {
        var pot = G.pot;
        G.chips[winnerId] = (G.chips[winnerId] || 0) + pot;
        G.results = { showdown: false, winners: [winnerId], pot: pot };
        G.pot = 0; G.phase = 'showdown'; G.showdownAt = now + FOLDWIN_MS; G.toAct = null;
        G.msg = '🏆 ' + nameOf(winnerId) + ' gewinnt ' + fmt(pot) + ' (alle anderen gefoldet)';
        pushShared();
      }

      function nextHandOrOver(now) {
        var solvent = participants().filter(function (p) { return (G.chips[p.id] || 0) > 0; });
        if (solvent.length < 2) { gameOver(now); return; }
        startHand(now);
      }
      function gameOver(now) {
        var parts = participants(), winner = parts[0];
        parts.forEach(function (p) { if ((G.chips[p.id] || 0) > (G.chips[winner.id] || 0)) winner = p; });
        G.phase = 'gameover'; G.toAct = null;
        G.results = { gameover: true, winner: winner.id };
        G.msg = '🎉 ' + winner.name + ' räumt den Tisch ab!';
        pushShared();
      }
      function rematch() {
        if (!amHost() || !G) return;
        participants().forEach(function (p) { G.chips[p.id] = START_CHIPS; });
        startHand(nowFn());
      }

      /* ==================== Host-Zustandsmaschine ==================== */
      function hostStep(now) {
        if (!G) return;
        if (G.phase === 'betting') {
          if (!G.toAct) return;
          if (G.folded[G.toAct] || G.allin[G.toAct]) { advance(now, G.toAct); return; }
          if (isBot(G.toAct)) { if (now >= G.botAt) applyAction(G.toAct, botDecision(G.toAct)); }
          else if (now >= G.deadline) {
            var toCall = G.currentBet - (G.bet[G.toAct] || 0);
            applyAction(G.toAct, { type: toCall > 0 ? 'fold' : 'check' });
          }
        } else if (G.phase === 'runout') {
          if (now >= G.runoutAt) {
            G.street++; dealStreet();
            if (G.street >= 7) showdown(now);
            else { G.runoutAt = now + RUNOUT_MS; pushShared(); }
          }
        } else if (G.phase === 'showdown') {
          if (now >= G.showdownAt) nextHandOrOver(now);
        }
      }

      /* ==================== Aktionen anwenden ==================== */
      function applyAction(id, act) {
        if (!G || G.phase !== 'betting' || G.toAct !== id) return;
        if (G.folded[id] || G.allin[id]) return;
        var chips = G.chips[id] || 0;
        var toCall = G.currentBet - (G.bet[id] || 0);
        var type = act.type;

        if (type === 'fold') {
          G.folded[id] = true;
        } else if (type === 'check') {
          if (toCall > 0) { G.folded[id] = true; }   // ungültiger Check → sicher folden
          else G.acted[id] = true;
        } else if (type === 'call') {
          var pay = Math.min(toCall, chips);
          G.chips[id] -= pay; G.bet[id] = (G.bet[id] || 0) + pay; G.pot += pay;
          if (G.chips[id] <= 0) G.allin[id] = true;
          G.acted[id] = true;
        } else if (type === 'raise') {
          var maxTotal = (G.bet[id] || 0) + chips;
          var target = Math.round(act.amount || 0);
          var minTarget = G.currentBet + MIN_RAISE;
          if (target < minTarget) target = minTarget;
          if (target >= maxTotal) {
            G.chips[id] = 0; G.bet[id] = maxTotal; G.pot += chips; G.allin[id] = true;
          } else {
            var p2 = target - (G.bet[id] || 0); G.chips[id] -= p2; G.bet[id] = target; G.pot += p2;
          }
          if (G.bet[id] > G.currentBet) { G.currentBet = G.bet[id]; resetActed(id); }
          G.acted[id] = true;
        } else if (type === 'allin') {
          var payA = chips; G.chips[id] = 0; G.bet[id] = (G.bet[id] || 0) + payA; G.pot += payA; G.allin[id] = true;
          if (G.bet[id] > G.currentBet) { G.currentBet = G.bet[id]; resetActed(id); }
          G.acted[id] = true;
        } else return;

        G.lastAction = { id: id, type: type };
        advance(nowFn(), id);
      }

      function pollIntents() {
        if (!G || G.phase !== 'betting') return;
        room.players().forEach(function (p) {
          if (p.id === me.id) return;                  // eigener Zug läuft direkt über UI
          var st = p.state;
          if (!st || typeof st.seq !== 'number') return;
          if (st.seq > (lastSeq[p.id] || 0) && G.toAct === p.id) {
            lastSeq[p.id] = st.seq;
            applyAction(p.id, { type: st.action, amount: st.amount });
          }
        });
      }

      function sendAction(act) {
        var v = currentView();
        if (!v || v.phase !== 'betting' || v.toAct !== me.id) return;
        if (amHost()) { applyAction(me.id, act); renderNow(); }
        else { mySeq++; pendingKey = turnKey(v); room.reportState({ seq: mySeq, action: act.type, amount: act.amount || 0 }); renderNow(); }
      }

      /* ==================== Bots ==================== */
      function handStrength(cards) {
        if (cards.length >= 5) {
          var ev = App.Poker.evalBest(cards);
          return Math.min(1, 0.22 + ev.cat * 0.1 + (((ev.tie && ev.tie[0]) || 0) / 14) * 0.05);
        }
        var k = showKey(cards), cat = k[0], high = k[1] || 0;
        return Math.min(1, 0.1 + cat * 0.17 + (high / 14) * 0.16);
      }
      function botDecision(id) {
        var cards = (G.up[id] || []).concat(G.hole[id] || []);
        var chips = G.chips[id] || 0;
        var toCall = Math.max(0, G.currentBet - (G.bet[id] || 0));
        var strength = Math.max(0, Math.min(1, handStrength(cards) + (Math.random() * 0.14 - 0.07)));
        if (chips <= 0) return { type: 'check' };
        if (toCall <= 0) {
          if (strength > 0.6 && chips >= MIN_RAISE && Math.random() < 0.5) {
            var t = Math.min(G.currentBet + MIN_RAISE + (Math.random() < 0.3 ? MIN_RAISE : 0), (G.bet[id] || 0) + chips);
            return { type: 'raise', amount: t };
          }
          return { type: 'check' };
        }
        if (toCall >= chips) {   // Call = All-in
          if (strength > 0.55 || (toCall <= chips * 0.5 && strength > 0.4)) return { type: 'call' };
          return { type: 'fold' };
        }
        if (strength > 0.8 && chips > toCall + MIN_RAISE && Math.random() < 0.45) {
          var tr = Math.min(G.currentBet + MIN_RAISE + (Math.random() < 0.4 ? MIN_RAISE : 0), (G.bet[id] || 0) + chips);
          return { type: 'raise', amount: tr };
        }
        var odds = toCall / (G.pot + toCall);
        if (strength > 0.34 || odds < 0.18) return { type: 'call' };
        if (strength > 0.22 && Math.random() < 0.4) return { type: 'call' };
        return { type: 'fold' };
      }

      /* ==================== Netzwerk-Push ==================== */
      function pushShared() {
        if (!isMulti || !amHost() || !G) return;
        var names = {}; participants().forEach(function (p) { names[p.id] = p.name; });
        room.setShared({
          stud: {
            hand: G.hand, phase: G.phase, street: G.street,
            chips: copyObj(G.chips), up: copyArrMap(G.up), hole: copyArrMap(G.hole),
            folded: copyObj(G.folded), allin: copyObj(G.allin), bet: copyObj(G.bet),
            pot: G.pot, currentBet: G.currentBet, toAct: G.toAct || null,
            order: G.order.slice(), bringInId: G.bringInId || null,
            deadline: G.deadline || 0, lastAction: G.lastAction || null,
            results: G.results || null, msg: G.msg || '',
            bots: (G.botList || []).map(function (b) { return b.id; }),
            seatNames: names
          }
        });
      }

      /* ==================== UI-Aufbau ==================== */
      function buildUI() {
        var backBtn = el('button', { class: 'btn btn-ghost btn-sm st-back', type: 'button', onclick: ctx.onExit }, ['← Zurück']);
        var head = el('div', { class: 'st-head' }, [el('div', { class: 'st-title neon' }, ['🂭 Seven-Card Stud']), backBtn]);

        var potEl = el('div', { class: 'st-pot-n' }, ['0']);
        var pot = el('div', { class: 'st-pot' }, [el('div', { class: 'st-pot-l' }, ['POT']), potEl]);
        var msg = el('div', { class: 'st-banner gold' }, ['Willkommen am Tisch!']);
        var turnInfo = el('div', { class: 'st-turn' }, ['']);
        var center = el('div', { class: 'st-center glass' }, [pot, msg, turnInfo]);

        var seatsEl = el('div', { class: 'st-seats' });

        // Aktionsleiste
        var timerFill = el('div', { class: 'st-tm-fill' });
        var timerSecs = el('div', { class: 'st-tm-secs' }, ['–']);
        var timer = el('div', { class: 'st-tm' }, [el('div', { class: 'st-tm-bar' }, [timerFill]), timerSecs]);

        var foldBtn = el('button', { class: 'st-act st-fold', type: 'button', onclick: function () { sendAction({ type: 'fold' }); } }, ['Fold']);
        var checkBtn = el('button', { class: 'st-act st-check', type: 'button', onclick: onCheckCall }, ['Check']);
        var raiseRange = el('input', { class: 'st-range', type: 'range', min: MIN_RAISE, max: MIN_RAISE * 4, step: 10, value: MIN_RAISE });
        raiseRange.addEventListener('input', function () { myRaise = parseInt(raiseRange.value, 10) || MIN_RAISE; updateRaiseLabel(currentView()); });
        var raiseVal = el('div', { class: 'st-range-v' }, ['']);
        var raiseBtn = el('button', { class: 'st-act st-raise', type: 'button', onclick: function () { sendAction({ type: 'raise', amount: myRaise }); } }, ['Erhöhen']);
        var allinBtn = el('button', { class: 'st-act st-allin', type: 'button', onclick: function () { sendAction({ type: 'allin' }); } }, ['All-In']);

        var raiseWrap = el('div', { class: 'st-raise-wrap' }, [
          el('div', { class: 'st-range-row' }, [raiseRange, raiseVal]),
          el('div', { class: 'st-btn-row' }, [raiseBtn, allinBtn])
        ]);
        var actionBar = el('div', { class: 'st-actions glass' }, [
          timer,
          el('div', { class: 'st-btn-row' }, [foldBtn, checkBtn]),
          raiseWrap
        ]);
        actionBar.style.display = 'none';

        var myHand = el('div', { class: 'st-myhand' }, ['']);

        var wrap = el('div', { class: 'st-wrap' }, [head, center, seatsEl, myHand, actionBar]);
        root.innerHTML = ''; root.appendChild(wrap);

        refs = {
          wrap: wrap, potEl: potEl, msg: msg, turnInfo: turnInfo, seatsEl: seatsEl,
          actionBar: actionBar, timerFill: timerFill, timerSecs: timerSecs,
          foldBtn: foldBtn, checkBtn: checkBtn, raiseRange: raiseRange, raiseVal: raiseVal,
          raiseBtn: raiseBtn, allinBtn: allinBtn, raiseWrap: raiseWrap, myHand: myHand
        };
        seatRefs = {}; seatKey = ''; built = true;
      }

      function onCheckCall() {
        var v = currentView(); if (!v) return;
        var toCall = (v.currentBet || 0) - (v.bet[me.id] || 0);
        sendAction({ type: toCall > 0 ? 'call' : 'check' });
      }

      /* ==================== Rendern ==================== */
      function nmFn(v) {
        var names = v.seatNames || null;
        return function (id) { return (names && names[id]) ? names[id] : (amHost() ? nameOf(id) : 'Spieler'); };
      }
      function shouldReveal(v, id) { return v.phase === 'showdown' && v.results && v.results.showdown && !v.folded[id]; }

      function render(v, now) {
        if (!built) return;
        if (!v || !v.order || !v.order.length) {
          refs.msg.textContent = 'Warte auf den Tisch …';
          refs.turnInfo.textContent = '';
          refs.actionBar.style.display = 'none';
          return;
        }
        refs.potEl.textContent = fmt(v.pot || 0);
        refs.msg.textContent = v.msg || '';
        updateTurnInfo(v);
        updateSeats(v);
        updateActionBar(v, now);
        updateMyHand(v);
        handleEndOverlay(v);
        maybeCountWin(v);
      }

      // Zählt GENAU EINEN Sieg pro gewonnener Hand für den lokal eingeloggten
      // Spieler. Läuft client-seitig beim Rendern: jeder Client rendert 'shared'
      // und prüft me.id für sich → keine Fremd-/Host-Zählung. v.hand ist die
      // stabile Hand-Kennung (steckt in shared, +1 je startHand).
      function maybeCountWin(v) {
        if (v.phase !== 'showdown' || !v.results) return;   // nur echter Hand-Abschluss (Showdown ODER Fold-Win)
        var winners = v.results.winners || [];
        if (winners.indexOf(me.id) < 0) return;             // nur eigener Sieg (nie Fold-Verlust/Bots)
        if (v.hand === lastCountedHand) return;             // Guard gegen Mehrfach-Render
        lastCountedHand = v.hand;
        if (App.Scores && App.Scores.winCurrent) App.Scores.winCurrent();
      }

      function updateTurnInfo(v) {
        var t = '';
        if (v.phase === 'betting' && v.toAct) {
          var nm = nmFn(v);
          t = v.toAct === me.id ? 'Du bist am Zug' : (nm(v.toAct) + ' ist am Zug');
        } else if (v.phase === 'runout') t = 'Aufdecken …';
        else if (v.phase === 'showdown') t = 'Showdown';
        refs.turnInfo.textContent = t;
        refs.turnInfo.className = 'st-turn' + (v.phase === 'betting' && v.toAct === me.id ? ' you' : '');
      }

      function updateSeats(v) {
        var key = v.order.join(',');
        if (key !== seatKey) { rebuildSeats(v); seatKey = key; }
        var nm = nmFn(v);
        var winners = (v.results && v.results.winners) || [];
        v.order.forEach(function (id) {
          var sr = seatRefs[id]; if (!sr) return;
          sr.nameEl.textContent = nm(id) + (id === me.id ? ' (du)' : '');
          sr.chipsEl.textContent = '🪙 ' + fmt(v.chips[id] != null ? v.chips[id] : START_CHIPS);

          var betAmt = v.bet[id] || 0;
          if (betAmt > 0) { sr.betEl.style.display = ''; sr.betEl.textContent = '+' + fmt(betAmt); }
          else sr.betEl.style.display = 'none';

          var st = '', stCls = 'st-seat-status';
          if (v.folded[id]) { st = 'Fold'; stCls += ' fold'; }
          else if (v.allin[id]) { st = 'All-In'; stCls += ' allin'; }
          else if (v.phase === 'betting' && v.toAct === id) { st = '● am Zug'; stCls += ' act'; }
          else if (id === v.bringInId && v.street === 3 && v.phase === 'betting') { st = 'Bring-in'; stCls += ' bring'; }
          sr.statusEl.textContent = st; sr.statusEl.className = stCls;

          var isWin = winners.indexOf(id) >= 0 && (v.phase === 'showdown');
          sr.root.classList.toggle('active', v.phase === 'betting' && v.toAct === id);
          sr.root.classList.toggle('folded', !!v.folded[id]);
          sr.root.classList.toggle('winner', isWin);
          sr.root.classList.toggle('me', id === me.id);

          // Karten
          var reveal = (id === me.id) || shouldReveal(v, id);
          syncCards(sr.holeEl, sr.holeCards, v.hole[id] || [], reveal);
          syncCards(sr.upEl, sr.upCards, v.up[id] || [], true);

          // Blatt-Name im Showdown
          if (v.phase === 'showdown' && v.results && v.results.showdown && v.results.evals && v.results.evals[id] && !v.folded[id]) {
            sr.handEl.style.display = ''; sr.handEl.textContent = catShort(v.results.evals[id]);
          } else sr.handEl.style.display = 'none';
        });
      }
      function rebuildSeats(v) {
        refs.seatsEl.innerHTML = ''; seatRefs = {};
        var nm = nmFn(v);
        v.order.forEach(function (id) {
          var nameEl = el('span', { class: 'st-seat-name' }, [nm(id)]);
          var chipsEl = el('span', { class: 'st-seat-chips' }, ['🪙 0']);
          var betEl = el('span', { class: 'st-seat-bet' }, ['']); betEl.style.display = 'none';
          var statusEl = el('span', { class: 'st-seat-status' }, ['']);
          var handEl = el('span', { class: 'st-seat-hand' }, ['']); handEl.style.display = 'none';
          var holeEl = el('div', { class: 'st-cardgroup st-hole' });
          var upEl = el('div', { class: 'st-cardgroup st-up' });
          var seat = el('div', { class: 'st-seat' }, [
            el('div', { class: 'st-seat-top' }, [nameEl, chipsEl]),
            el('div', { class: 'st-cards' }, [holeEl, upEl]),
            el('div', { class: 'st-seat-bottom' }, [statusEl, handEl, betEl])
          ]);
          refs.seatsEl.appendChild(seat);
          seatRefs[id] = { root: seat, nameEl: nameEl, chipsEl: chipsEl, betEl: betEl, statusEl: statusEl, handEl: handEl, holeEl: holeEl, upEl: upEl, holeCards: [], upCards: [] };
        });
      }
      function syncCards(container, arr, cards, faceUp) {
        while (arr.length < cards.length) { var c = el('div', { class: 'st-card st-deal' }); container.appendChild(c); arr.push({ el: c, sig: '' }); }
        while (arr.length > cards.length) { var last = arr.pop(); if (last.el.parentNode) last.el.parentNode.removeChild(last.el); }
        for (var i = 0; i < cards.length; i++) setCardEl(arr[i], cards[i], faceUp);
      }
      function setCardEl(obj, card, faceUp) {
        var sig = card + (faceUp ? 'f' : 'b');
        if (obj.sig === sig) return; obj.sig = sig;
        var e = obj.el; e.innerHTML = '';
        if (!faceUp) { e.className = 'st-card back'; return; }
        var s = suitOf(card), red = (s === 'h' || s === 'd');
        e.className = 'st-card ' + (red ? 'red' : 'dark');
        e.appendChild(el('span', { class: 'st-r' }, [rankLabel(card)]));
        e.appendChild(el('span', { class: 'st-s' }, [App.Poker.SUIT_SYM[s]]));
      }

      function turnKey(v) { return v.hand + '|' + v.street + '|' + v.toAct + '|' + v.currentBet + '|' + v.deadline; }

      function updateActionBar(v, now) {
        var seated = v.order.indexOf(me.id) >= 0;
        var myTurn = seated && v.phase === 'betting' && v.toAct === me.id && !v.folded[me.id] && !v.allin[me.id];
        if (!myTurn) { refs.actionBar.style.display = 'none'; return; }

        var tk = turnKey(v);
        if (tk !== lastTurnKey) { lastTurnKey = tk; myRaise = 0; if (pendingKey && pendingKey !== tk) pendingKey = ''; }
        // Intent gesendet und noch nicht verrechnet → kurz "gesendet" zeigen
        if (!amHost() && pendingKey === tk) {
          refs.actionBar.style.display = '';
          setBtnsDisabled(true);
          refs.timerSecs.textContent = '…';
          var remP = Math.max(0, (v.deadline || 0) - now);
          refs.timerFill.style.width = (remP / TURN_MS * 100).toFixed(1) + '%';
          return;
        }
        setBtnsDisabled(false);
        refs.actionBar.style.display = '';

        var chips = v.chips[me.id] || 0, myBet = v.bet[me.id] || 0, cur = v.currentBet || 0;
        var toCall = Math.max(0, cur - myBet);

        // Check / Call
        if (toCall <= 0) { refs.checkBtn.textContent = 'Check'; refs.checkBtn.classList.remove('call'); }
        else {
          var callAmt = Math.min(toCall, chips);
          refs.checkBtn.textContent = 'Call ' + fmt(callAmt) + (callAmt >= chips ? ' (All-In)' : '');
          refs.checkBtn.classList.add('call');
        }

        // Erhöhen
        var maxTotal = myBet + chips;
        var minTotal = cur + MIN_RAISE;
        var canRaise = maxTotal >= minTotal && chips > toCall;
        if (canRaise) {
          refs.raiseWrap.style.display = '';
          refs.raiseRange.min = String(minTotal);
          refs.raiseRange.max = String(maxTotal);
          refs.raiseRange.step = '10';
          if (!myRaise || myRaise < minTotal || myRaise > maxTotal) myRaise = minTotal;
          refs.raiseRange.value = String(myRaise);
          refs.raiseBtn.textContent = (cur > 0 ? 'Erhöhen' : 'Setzen');
          updateRaiseLabel(v);
        } else refs.raiseWrap.style.display = 'none';

        // All-In immer möglich (solange Chips)
        refs.allinBtn.style.display = chips > 0 ? '' : 'none';
        refs.allinBtn.textContent = 'All-In (' + fmt(chips) + ')';

        // Timer
        var rem = Math.max(0, (v.deadline || 0) - now);
        refs.timerFill.style.width = (rem / TURN_MS * 100).toFixed(1) + '%';
        refs.timerSecs.textContent = Math.ceil(rem / 1000) + 's';
        refs.timerFill.classList.toggle('low', rem < 6000);
      }
      function updateRaiseLabel(v) {
        if (!v) return;
        var myBet = v.bet[me.id] || 0;
        var cost = Math.max(0, myRaise - myBet);
        refs.raiseVal.textContent = 'auf ' + fmt(myRaise) + '  (+' + fmt(cost) + ')';
      }
      function setBtnsDisabled(d) {
        refs.foldBtn.disabled = d; refs.checkBtn.disabled = d;
        refs.raiseBtn.disabled = d; refs.allinBtn.disabled = d; refs.raiseRange.disabled = d;
      }

      function updateMyHand(v) {
        var up = v.up[me.id] || [], hole = v.hole[me.id] || [];
        var cards = up.concat(hole);
        if (v.order.indexOf(me.id) < 0 || v.folded[me.id] || !cards.length) {
          refs.myHand.textContent = v.order.indexOf(me.id) < 0 ? 'Du schaust zu' : (v.folded[me.id] ? 'Du hast gefoldet' : '');
          refs.myHand.className = 'st-myhand muted';
          return;
        }
        var label;
        if (cards.length >= 5) label = App.Poker.handName(App.Poker.evalBest(cards));
        else { var k = showKey(cards); label = CAT_SHORT[k[0]] || 'Höchste Karte'; }
        refs.myHand.textContent = 'Dein Blatt: ' + label;
        refs.myHand.className = 'st-myhand';
      }

      function handleEndOverlay(v) {
        if (v.phase === 'gameover' && v.results && v.results.gameover) {
          if (endBuiltHand === v.hand) return;
          endBuiltHand = v.hand;
          showGameOver(v);
        } else if (v.phase !== 'gameover') {
          endBuiltHand = -1;
          var old = refs.wrap.querySelector('.st-over'); if (old) old.parentNode.removeChild(old);
        }
      }
      function showGameOver(v) {
        var old = refs.wrap.querySelector('.st-over'); if (old) old.parentNode.removeChild(old);
        var nm = nmFn(v);
        var iWon = v.results.winner === me.id;
        var actions = [];
        if (amHost()) actions.push(el('button', { class: 'btn btn-primary btn-lg', type: 'button', onclick: rematch }, ['Neues Spiel']));
        actions.push(el('button', { class: 'btn btn-ghost btn-lg', type: 'button', onclick: ctx.onExit }, ['Zurück zur Lobby']));
        var card = el('div', { class: 'st-over-card glass' }, [
          el('div', { class: 'st-over-emoji' }, [iWon ? '🏆' : '🎉']),
          el('h2', { class: 'st-over-title neon' }, [iWon ? 'Du räumst den Tisch ab!' : (nm(v.results.winner) + ' gewinnt den Tisch')]),
          el('p', { class: 'st-over-sub' }, [iWon ? 'Alle Chips gehören dir.' : 'Nächstes Mal knackst du den Tisch!']),
          el('div', { class: 'st-over-actions' }, actions)
        ]);
        if (!amHost()) card.appendChild(el('p', { class: 'st-over-hint' }, ['Der Host kann ein neues Spiel starten.']));
        refs.wrap.appendChild(el('div', { class: 'st-over' }, [card]));
      }

      /* ==================== Aufräumen ==================== */
      function cleanup() {
        destroyed = true;
        if (timer) { clearInterval(timer); timer = null; }
        if (cdStop) { try { cdStop(); } catch (e) {} cdStop = null; }
        if (isMulti && room) {
          if (sharedL) room.off('shared', sharedL);
          if (playersL) room.off('players', playersL);
        }
        sharedL = null; playersL = null;
      }
    }
  };

  /* ==================== CSS ==================== */
  function injectStyle() {
    UI.injectStyle('mg-stud-css', [
      '.st-wrap{display:flex;flex-direction:column;gap:14px;max-width:760px;margin:0 auto;position:relative;}',
      '.st-head{display:flex;align-items:center;justify-content:space-between;gap:10px;}',
      '.st-title{font-weight:900;font-size:clamp(18px,4.6vw,22px);}',
      '.st-back{padding:6px 12px;font-size:13px;}',

      '.st-center{padding:14px;display:flex;flex-direction:column;align-items:center;gap:8px;border:1px solid var(--stroke-2,var(--stroke));}',
      '.st-pot{display:flex;flex-direction:column;align-items:center;gap:2px;}',
      '.st-pot-l{font-size:11px;font-weight:800;letter-spacing:2px;color:var(--muted);text-transform:uppercase;}',
      '.st-pot-n{font-size:clamp(26px,8vw,40px);font-weight:900;color:var(--gold);text-shadow:0 0 16px rgba(255,210,63,.45);font-variant-numeric:tabular-nums;line-height:1;}',
      '.st-banner{text-align:center;font-weight:900;font-size:clamp(14px,4vw,18px);min-height:24px;line-height:1.25;}',
      '.st-banner.gold{color:var(--gold);text-shadow:0 0 12px rgba(255,210,63,.4);}',
      '.st-turn{font-size:13px;font-weight:800;color:var(--aqua,#33e6d0);min-height:16px;}',
      '.st-turn.you{color:var(--neon);text-shadow:0 0 10px rgba(57,255,20,.4);}',

      '.st-seats{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:10px;}',
      '.st-seat{display:flex;flex-direction:column;gap:8px;padding:10px 12px;border-radius:14px;background:rgba(9,32,21,.6);border:1px solid var(--stroke);transition:border-color .15s,box-shadow .2s,opacity .2s;}',
      '.st-seat.me{border-color:var(--stroke-2);box-shadow:var(--glow-soft);background:rgba(9,32,21,.85);}',
      '.st-seat.active{border-color:var(--neon);box-shadow:0 0 0 1px var(--neon),0 0 16px rgba(57,255,20,.3);}',
      '.st-seat.folded{opacity:.42;}',
      '.st-seat.winner{border-color:var(--gold);box-shadow:0 0 18px rgba(255,210,63,.5);}',
      '.st-seat-top{display:flex;align-items:center;justify-content:space-between;gap:8px;}',
      '.st-seat-name{font-weight:800;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.st-seat-chips{font-weight:900;font-size:13px;color:var(--leaf);font-variant-numeric:tabular-nums;white-space:nowrap;}',
      '.st-cards{display:flex;align-items:flex-end;gap:8px;min-height:56px;flex-wrap:wrap;}',
      '.st-cardgroup{display:flex;gap:3px;}',
      '.st-up{padding-left:6px;border-left:1px dashed rgba(120,200,150,.28);}',
      '.st-seat-bottom{display:flex;align-items:center;gap:8px;min-height:18px;}',
      '.st-seat-status{font-size:11px;font-weight:800;color:var(--muted);}',
      '.st-seat-status.act{color:var(--neon);}',
      '.st-seat-status.allin{color:var(--gold);}',
      '.st-seat-status.fold{color:var(--danger);}',
      '.st-seat-status.bring{color:var(--aqua,#33e6d0);}',
      '.st-seat-hand{font-size:11px;font-weight:900;color:var(--gold);}',
      '.st-seat-bet{margin-left:auto;font-size:11px;font-weight:900;color:#04160c;background:linear-gradient(180deg,var(--neon-soft,#8aff6a),var(--neon));padding:2px 8px;border-radius:999px;font-variant-numeric:tabular-nums;}',

      /* Karten */
      '.st-card{width:34px;height:48px;border-radius:6px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1px;font-weight:900;background:linear-gradient(160deg,#fbfff8,#e7f2ea);box-shadow:0 2px 6px rgba(0,0,0,.4);border:1px solid rgba(0,0,0,.15);user-select:none;-webkit-user-select:none;}',
      // Eigene Karten (Hole- & offene Karten) deutlich größer als die der Mitspieler.
      '.st-seat.me .st-card{width:clamp(42px,12vw,54px);height:clamp(59px,17vw,76px);border-radius:8px;box-shadow:0 4px 12px rgba(0,0,0,.5),0 0 0 1px rgba(57,255,20,.25);}',
      '.st-card .st-r{font-size:15px;line-height:1;}',
      '.st-card .st-s{font-size:14px;line-height:1;}',
      '.st-card.red{color:#d3283d;}',
      '.st-card.dark{color:#0c1a12;}',
      '.st-card.back{background:repeating-linear-gradient(45deg,#0c3a24,#0c3a24 4px,#12492e 4px,#12492e 8px);border:1px solid var(--neon);box-shadow:0 2px 6px rgba(0,0,0,.4),inset 0 0 8px rgba(57,255,20,.25);}',
      '.st-card.st-deal{animation:st-deal .28s ease;}',
      '@keyframes st-deal{0%{transform:translateY(-10px) rotate(-6deg);opacity:0;}100%{transform:none;opacity:1;}}',

      '.st-myhand{text-align:center;font-weight:900;font-size:clamp(14px,4vw,17px);color:var(--neon);text-shadow:0 0 10px rgba(57,255,20,.35);min-height:20px;}',
      '.st-myhand.muted{color:var(--muted);text-shadow:none;font-weight:700;}',

      /* Aktionsleiste */
      '.st-actions{padding:14px;display:flex;flex-direction:column;gap:12px;border:1px solid var(--stroke-2,var(--stroke));}',
      '.st-tm{display:flex;align-items:center;gap:8px;}',
      '.st-tm-bar{flex:1;height:8px;border-radius:6px;background:rgba(0,0,0,.4);overflow:hidden;border:1px solid var(--stroke);}',
      '.st-tm-fill{height:100%;width:100%;border-radius:6px;background:linear-gradient(90deg,var(--gold),var(--neon));transition:width .12s linear;}',
      '.st-tm-fill.low{background:linear-gradient(90deg,var(--danger),var(--gold));}',
      '.st-tm-secs{font-weight:900;font-size:14px;color:var(--aqua,#33e6d0);min-width:34px;text-align:right;font-variant-numeric:tabular-nums;}',
      '.st-btn-row{display:flex;gap:10px;}',
      '.st-act{flex:1;padding:12px 8px;border-radius:12px;font-weight:900;font-size:15px;cursor:pointer;font-family:inherit;color:var(--text);border:2px solid var(--stroke-2,var(--stroke));background:rgba(9,32,21,.85);transition:transform .08s,box-shadow .15s,border-color .15s;}',
      '.st-act:active:not(:disabled){transform:scale(.96);}',
      '.st-act:disabled{opacity:.45;cursor:not-allowed;}',
      '.st-fold{border-color:rgba(255,77,109,.5);color:#ff9fae;}',
      '.st-fold:hover:not(:disabled){box-shadow:0 0 14px rgba(255,77,109,.35);}',
      '.st-check{border-color:var(--aqua,#33e6d0);color:var(--aqua,#33e6d0);}',
      '.st-check.call{color:#04160c;background:linear-gradient(180deg,#7ff0e2,var(--aqua,#33e6d0));border-color:var(--aqua,#33e6d0);}',
      '.st-raise-wrap{display:flex;flex-direction:column;gap:10px;}',
      '.st-range-row{display:flex;align-items:center;gap:10px;}',
      '.st-range{flex:1;accent-color:var(--neon);height:6px;}',
      '.st-range-v{font-weight:900;font-size:13px;color:var(--leaf);min-width:120px;text-align:right;font-variant-numeric:tabular-nums;}',
      '.st-raise{color:#04160c;background:linear-gradient(180deg,var(--neon-soft,#8aff6a),var(--neon));border-color:var(--neon);box-shadow:var(--glow-soft);}',
      '.st-allin{color:var(--gold);border-color:var(--gold);}',
      '.st-allin:hover:not(:disabled){box-shadow:0 0 14px rgba(255,210,63,.4);}',

      /* Game-Over-Overlay */
      '.st-over{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(2,10,6,.78);backdrop-filter:blur(3px);border-radius:14px;z-index:30;animation:st-fade .2s ease;}',
      '@keyframes st-fade{from{opacity:0}to{opacity:1}}',
      '.st-over-card{padding:26px 22px;text-align:center;display:flex;flex-direction:column;gap:12px;align-items:center;max-width:90%;}',
      '.st-over-emoji{font-size:58px;filter:drop-shadow(0 0 14px rgba(255,210,63,.5));}',
      '.st-over-title{font-size:clamp(20px,6vw,30px);font-weight:900;line-height:1.15;margin:0;}',
      '.st-over-sub{color:var(--muted);margin:0;}',
      '.st-over-actions{display:flex;gap:10px;justify-content:center;flex-wrap:wrap;margin-top:4px;}',
      '.st-over-hint{color:var(--muted);font-size:12px;margin:6px 0 0;}'
    ].join(''));
  }
})();
