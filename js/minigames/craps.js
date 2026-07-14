/* craps.js — "Craps": Multiplayer-Würfel-Casino im Neon-Dschungel-Look.
 * Vereinfachtes Craps: jede Runde wetten alle auf PASS LINE oder DON'T PASS,
 * dann wirft der Tisch (Host) zwei Würfel.  Come-Out entscheidet sofort
 * (7/11, 2/3, 12) oder legt einen POINT fest — danach wird weitergewürfelt,
 * bis der Point ODER die 7 fällt.
 *
 * Architektur (Pflicht): host-autoritativ + Intents.
 *  - NUR der Host würfelt und verrechnet Chips; er schreibt den ganzen
 *    Tisch-Zustand via room.setShared({craps:{...}}).
 *  - Spieler senden ihre Wette als Intent:
 *        room.reportState({ seq, bet:'pass'|'dontpass', amount })
 *    Der Host liest room.players()[i].state und wendet jeden Intent GENAU
 *    EINMAL an (zuletzt angewandte seq je Spieler gemerkt).
 *  - Per-Room-Chips: shared.chips[playerId], Start 1000 (App.Coins bleibt unberührt).
 *  - SOLO: Host = du, dazu 3–4 Bots, die jede Runde zufällig plausibel wetten.
 *
 * Hinweis Klassen-Präfix: cuberoll.js belegt bereits ".cr-"; um Kollisionen zu
 * vermeiden nutzt dieses Spiel den engeren Präfix ".crp-".
 * cleanup() stoppt alle Timer und entfernt die Room-Listener. */
(function () {
  'use strict';
  window.App = window.App || {}; App.Minigames = App.Minigames || {};
  var UI = App.UI, el = UI.el, MG = App.MG;

  injectStyle();

  /* ---- Konstanten ---- */
  var START_CHIPS = 1000;
  var BET_MS = 6000;          // Wett-Fenster
  var COMEOUT_WINDUP = 850;   // kurze Spannung vor dem Come-Out-Wurf
  var POINT_FIRST_MS = 1500;  // Pause nach Point-Festlegung
  var POINT_ROLL_MS = 1800;   // Takt der Point-Würfe
  var RESOLVE_MS = 2600;      // Auszahlungs-Banner
  var TICK_MS = 120;
  var STAKES = [50, 100, 250];

  /* Punkte-Positionen (3×3-Raster, Zellen 1..9) je Augenzahl. */
  var PIP_MAP = {
    1: [5], 2: [1, 9], 3: [1, 5, 9], 4: [1, 3, 7, 9],
    5: [1, 3, 5, 7, 9], 6: [1, 4, 7, 3, 6, 9]
  };

  var BOT_POOL = [
    { id: 'b1', name: '🦜 Coco' }, { id: 'b2', name: '🐒 Momo' },
    { id: 'b3', name: '🐍 Kaa' }, { id: 'b4', name: '🐆 Zara' },
    { id: 'b5', name: '🦎 Rex' }
  ];
  function shuffle(a) { for (var i = a.length - 1; i > 0; i--) { var j = (Math.random() * (i + 1)) | 0; var t = a[i]; a[i] = a[j]; a[j] = t; } return a; }
  function pickBots() { var p = shuffle(BOT_POOL.slice()); var n = 3 + ((Math.random() * 2) | 0); return p.slice(0, n).map(function (b) { return { id: b.id, name: b.name }; }); }
  function clampInt(v, lo, hi) { v = Math.round(Number(v) || 0); return v < lo ? lo : (v > hi ? hi : v); }
  function d6() { return 1 + ((Math.random() * 6) | 0); }

  /* ---- reine Craps-Logik ---- */
  function outcomeFor(side, sum, isComeOut, point) {
    if (isComeOut) {
      if (sum === 7 || sum === 11) return side === 'pass' ? 'win' : 'lose';
      if (sum === 2 || sum === 3) return side === 'pass' ? 'lose' : 'win';
      if (sum === 12) return side === 'pass' ? 'lose' : 'push';
      return null; // Point wird gelegt
    }
    if (sum === point) return side === 'pass' ? 'win' : 'lose';
    if (sum === 7) return side === 'pass' ? 'lose' : 'win';
    return null; // weiter würfeln
  }
  function bannerFor(isComeOut, sum, point) {
    if (isComeOut) {
      if (sum === 7 || sum === 11) return { msg: '🎲 ' + sum + ' · Natural! Pass Line gewinnt', kind: 'good' };
      if (sum === 2 || sum === 3) return { msg: '🎲 ' + sum + ' · Craps! Don’t Pass gewinnt', kind: 'aqua' };
      return { msg: '🎲 12 · Craps — Don’t Pass Push', kind: 'gold' };
    }
    if (sum === point) return { msg: '🎯 Point ' + point + ' getroffen! Pass Line gewinnt', kind: 'good' };
    return { msg: '💀 Sieben! Don’t Pass gewinnt', kind: 'danger' };
  }

  App.Minigames.craps = {
    id: 'craps', title: 'Craps', icon: '🎲', order: 31,
    subtitle: 'Pass oder Don’t Pass — würfle die 7 nicht zur falschen Zeit',
    single: true, multi: true, minPlayers: 2, maxPlayers: 8, group: 'live',

    render: function (root, ctx) {
      var isMulti = ctx.mode === 'multi';
      var room = ctx.room;
      var me = { id: ctx.me.id, name: ctx.me.name || 'Du' };
      var nowFn = isMulti ? function () { return room.now(); } : function () { return Date.now(); };
      function amHost() { return isMulti ? !!(room && room.isHost()) : true; }

      var destroyed = false, timer = null, cdStop = null;
      var sharedL = null, playersL = null;
      var lastShared = isMulti ? ((room.snapshot() && room.snapshot().shared) || null) : null;

      var G = null;                    // autoritativer Zustand (Host/Solo)
      var mySide = null, myAmount = 50, mySeq = 0, lastSeq = {};
      var BOTS = isMulti ? [] : pickBots();

      // DOM-Referenzen (einmal gebaut, dann nur in-place aktualisiert)
      var built = false, refs = {}, rowRefs = {}, rowKey = '';
      var lastRollSeq = -1, lastResolveRound = -1, lastBetRound = -1;

      start();
      return { cleanup: cleanup };

      /* ==================== Ablauf ==================== */
      function start() {
        if (isMulti) {
          sharedL = function (sh) { lastShared = sh; };
          playersL = function () { /* Host pollt Intents im loop */ };
          room.on('shared', sharedL);
          room.on('players', playersL);
          var snap = room.snapshot() || {};
          var startAt = (snap.round && snap.round.startAt) || (room.now() + (MG.MULTI_START_DELAY || 3000));
          cdStop = MG.countdown(root, startAt, begin, function () { return room.now(); });
        } else {
          begin();
        }
      }

      function begin() {
        if (destroyed) return;
        cdStop = null;
        buildUI();
        if (amHost()) initHost();
        timer = setInterval(loop, TICK_MS);
        loop();
      }

      function freshG() {
        return {
          round: 0, phase: 'betting', betEndsAt: 0, dice: null, point: 0,
          rollSeq: 0, lastSum: 0, chips: {}, bets: {}, results: null,
          msg: '', msgKind: 'gold', botPlan: {}, rollAt: 0, resolveAt: 0
        };
      }
      function initHost() { G = freshG(); ensureChips(); newBettingRound(nowFn()); }

      function participants() {
        if (isMulti) return room.players().map(function (p) { return { id: p.id, name: p.name || 'Spieler' }; });
        return [me].concat(BOTS);
      }
      function ensureChips() {
        if (!G) return;
        participants().forEach(function (p) { if (G.chips[p.id] == null) G.chips[p.id] = START_CHIPS; });
      }

      function loop() {
        if (destroyed) return;
        var now = nowFn();
        if (amHost()) {
          if (!G) becomeHost(now);
          ensureChips();
          if (isMulti) pollIntents();
          hostStep(now);
        }
        render(currentView(), now);
      }
      function renderNow() { render(currentView(), nowFn()); }
      function currentView() { return amHost() ? G : ((lastShared && lastShared.craps) || null); }

      /* ==================== Host-Zustandsmaschine ==================== */
      function hostStep(now) {
        if (!G) return;
        if (G.phase === 'betting') {
          if (!isMulti) commitDueBots(now);
          if (now >= G.betEndsAt) toComeOut(now);
        } else if (G.phase === 'comeout') {
          if (now >= G.rollAt) rollDice(now, true);
        } else if (G.phase === 'point') {
          if (now >= G.rollAt) rollDice(now, false);
        } else if (G.phase === 'resolve') {
          if (now >= G.resolveAt) newBettingRound(now);
        }
      }

      function newBettingRound(now) {
        G.round = (G.round || 0) + 1;
        G.phase = 'betting'; G.betEndsAt = now + BET_MS;
        G.point = 0; G.bets = {}; G.results = null;
        G.msg = G.round === 1 ? 'Platziert eure Wetten!' : 'Neue Runde — platziert eure Wetten!';
        G.msgKind = 'gold';
        if (!isMulti) planBots(now);
        pushShared();
      }

      function toComeOut(now) {
        G.phase = 'comeout'; G.rollAt = now + COMEOUT_WINDUP;
        G.msg = 'Come Out — gleich wird geworfen …'; G.msgKind = 'muted';
        pushShared();
      }

      function rollDice(now, isComeOut) {
        var d1 = d6(), d2 = d6(), sum = d1 + d2;
        G.dice = [d1, d2]; G.rollSeq++; G.lastSum = sum;
        if (isComeOut) {
          if (sum === 7 || sum === 11 || sum === 2 || sum === 3 || sum === 12) resolveRound(now, true, sum);
          else establishPoint(now, sum);
        } else {
          if (sum === G.point || sum === 7) resolveRound(now, false, sum);
          else { G.rollAt = now + POINT_ROLL_MS; G.msg = '🎲 ' + sum + ' — weiter würfeln …'; G.msgKind = 'aqua'; pushShared(); }
        }
      }

      function establishPoint(now, sum) {
        G.point = sum; G.phase = 'point'; G.rollAt = now + POINT_FIRST_MS;
        G.msg = '🎯 Point ist ' + sum + ' — triff den Point, nicht die 7!'; G.msgKind = 'aqua';
        pushShared();
      }

      function resolveRound(now, isComeOut, sum) {
        var results = {};
        Object.keys(G.bets).forEach(function (pid) {
          var b = G.bets[pid];
          var out = outcomeFor(b.bet, sum, isComeOut, G.point);
          if (out == null) return;
          var delta = out === 'win' ? b.amount : out === 'lose' ? -b.amount : 0;
          G.chips[pid] = (G.chips[pid] || 0) + delta;
          results[pid] = { outcome: out, delta: delta, side: b.bet, amount: b.amount };
        });
        G.results = results;
        G.phase = 'resolve'; G.resolveAt = now + RESOLVE_MS;
        var bk = bannerFor(isComeOut, sum, G.point);
        G.msg = bk.msg; G.msgKind = bk.kind;
        pushShared();
      }

      /* ==================== Intents / Wetten ==================== */
      function applyBet(pid, side, amount) {
        if (!G || G.phase !== 'betting') return;
        if (side !== 'pass' && side !== 'dontpass') return;
        var ch = G.chips[pid] || 0; if (ch <= 0) return;
        G.bets[pid] = { bet: side, amount: clampInt(amount, 1, ch) };
        pushShared();
      }
      function pollIntents() {
        if (!G) return;
        room.players().forEach(function (p) {
          if (p.id === me.id) return;                 // eigene Wette läuft direkt
          var st = p.state;
          if (!st || typeof st.seq !== 'number') return;
          if (st.seq > (lastSeq[p.id] || 0)) {
            if (G.phase === 'betting') {               // sonst: gilt fürs nächste Fenster
              lastSeq[p.id] = st.seq;
              applyBet(p.id, st.bet, st.amount);
            }
          }
        });
      }
      function sendBet() {
        var v = currentView(); var ch = (v && v.chips && v.chips[me.id]) || 0;
        if (!mySide || ch <= 0) return;
        var amt = clampInt(myAmount, 1, ch);
        if (amHost()) applyBet(me.id, mySide, amt);
        else { mySeq++; room.reportState({ seq: mySeq, bet: mySide, amount: amt }); }
      }

      /* ==================== Bots (nur Solo) ==================== */
      function botAmount(ch) {
        var opts = STAKES.filter(function (s) { return s <= ch; });
        var amt = opts.length ? opts[(Math.random() * opts.length) | 0] : ch;
        if (Math.random() < 0.15) amt = Math.min(ch, Math.max(50, Math.floor(ch / 2 / 10) * 10));
        return Math.min(amt, ch);
      }
      function planBots(now) {
        G.botPlan = {};
        BOTS.forEach(function (b) {
          var ch = G.chips[b.id] || 0; if (ch <= 0) return;
          if (Math.random() < 0.88) {
            G.botPlan[b.id] = {
              side: Math.random() < 0.55 ? 'pass' : 'dontpass',
              amount: botAmount(ch),
              at: now + 500 + Math.random() * (BET_MS - 1400),
              done: false
            };
          }
        });
      }
      function commitDueBots(now) {
        Object.keys(G.botPlan).forEach(function (id) {
          var p = G.botPlan[id]; if (p.done || now < p.at) return;
          p.done = true;
          var ch = G.chips[id] || 0; if (ch <= 0) return;
          G.bets[id] = { bet: p.side, amount: Math.min(p.amount, ch) };
          pushShared();
        });
      }

      /* ==================== Host-Migration ==================== */
      function becomeHost(now) {
        G = freshG();
        var s = lastShared && lastShared.craps;
        if (s) {
          G.round = s.round || 1; G.phase = s.phase || 'betting';
          G.betEndsAt = s.betEndsAt || (now + BET_MS);
          G.point = s.point || 0; G.chips = Object.assign({}, s.chips || {});
          G.bets = Object.assign({}, s.bets || {}); G.dice = s.dice || null;
          G.rollSeq = s.rollSeq || 0; G.lastSum = s.lastSum || 0;
          G.results = s.results || null; G.msg = s.msg || ''; G.msgKind = s.msgKind || 'gold';
          if (G.phase === 'comeout' || G.phase === 'point') G.rollAt = now + POINT_ROLL_MS;
          if (G.phase === 'resolve') G.resolveAt = now + RESOLVE_MS;
        }
        ensureChips();
      }

      /* ==================== Netzwerk-Push ==================== */
      function pushShared() {
        if (!isMulti || !amHost() || !G) return;
        room.setShared({
          craps: {
            phase: G.phase, round: G.round, betEndsAt: G.betEndsAt,
            dice: G.dice ? G.dice.slice() : null, point: G.point,
            rollSeq: G.rollSeq, lastSum: G.lastSum,
            chips: Object.assign({}, G.chips), bets: copyBets(G.bets),
            results: G.results ? copyResults(G.results) : null,
            msg: G.msg, msgKind: G.msgKind
          }
        });
      }
      function copyBets(o) { var r = {}; Object.keys(o).forEach(function (k) { r[k] = { bet: o[k].bet, amount: o[k].amount }; }); return r; }
      function copyResults(o) { var r = {}; Object.keys(o).forEach(function (k) { var x = o[k]; r[k] = { outcome: x.outcome, delta: x.delta, side: x.side, amount: x.amount }; }); return r; }

      /* ==================== UI-Aufbau ==================== */
      function buildDie() {
        var cells = [];
        var faceKids = [];
        for (var i = 0; i < 9; i++) {
          var dot = el('span', { class: 'crp-dot' });
          var cell = el('span', { class: 'crp-cell' }, [dot]);
          cells.push(cell); faceKids.push(cell);
        }
        var rootEl = el('div', { class: 'crp-die' }, faceKids);
        return { root: rootEl, cells: cells };
      }
      function setDie(die, value) {
        for (var i = 1; i <= 9; i++) {
          var on = value && PIP_MAP[value] && PIP_MAP[value].indexOf(i) >= 0;
          die.cells[i - 1].classList.toggle('on', !!on);
        }
      }

      function buildUI() {
        var backBtn = el('button', { class: 'btn btn-ghost btn-sm crp-back', type: 'button', onclick: ctx.onExit }, ['← Zurück']);
        var head = el('div', { class: 'crp-head' }, [
          el('div', { class: 'crp-title neon' }, ['🎲 Craps']),
          backBtn
        ]);

        var bannerEl = el('div', { class: 'crp-banner gold' }, ['Willkommen am Tisch!']);
        var phaseEl = el('div', { class: 'crp-phase' }, ['—']);

        var die1 = buildDie(), die2 = buildDie();
        var pointBadge = el('div', { class: 'crp-point' }, ['POINT –']);
        pointBadge.style.display = 'none';
        var sumEl = el('div', { class: 'crp-sum' }, ['—']);
        var stage = el('div', { class: 'crp-stage glass' }, [
          phaseEl,
          el('div', { class: 'crp-dice' }, [die1.root, die2.root]),
          el('div', { class: 'crp-stage-foot' }, [sumEl, pointBadge])
        ]);

        // --- Wett-Panel ---
        var passBtn = el('button', { class: 'crp-side pass', type: 'button', onclick: function () { onSide('pass'); } }, [
          el('span', { class: 'crp-side-t' }, ['PASS LINE']),
          el('span', { class: 'crp-side-s' }, ['gewinnt 7/11 · verliert 2/3/12'])
        ]);
        var dontBtn = el('button', { class: 'crp-side dont', type: 'button', onclick: function () { onSide('dontpass'); } }, [
          el('span', { class: 'crp-side-t' }, ['DON’T PASS']),
          el('span', { class: 'crp-side-s' }, ['umgekehrt · 12 = Push'])
        ]);
        var sides = el('div', { class: 'crp-sides' }, [passBtn, dontBtn]);

        var stakeBtns = STAKES.map(function (s) {
          return el('button', { class: 'crp-stake', type: 'button', dataset: { v: String(s) }, onclick: function () { onStake(s); } }, [String(s)]);
        });
        var maxBtn = el('button', { class: 'crp-stake crp-max', type: 'button', onclick: onMax }, ['Max']);
        var stakes = el('div', { class: 'crp-stakes' }, stakeBtns.concat([maxBtn]));

        var cdBar = el('div', { class: 'crp-cd-fill' });
        var cdSecs = el('div', { class: 'crp-cd-secs' }, ['–']);
        var cd = el('div', { class: 'crp-cd' }, [
          el('div', { class: 'crp-cd-bar' }, [cdBar]), cdSecs
        ]);

        var myBet = el('div', { class: 'crp-mybet' }, ['Wähle Seite + Einsatz']);
        var myBetChips = el('div', { class: 'crp-mychips' }, ['Deine Chips: ' + START_CHIPS]);

        var betPanel = el('div', { class: 'crp-bet glass' }, [
          el('div', { class: 'crp-bet-head' }, [myBetChips, cd]),
          sides, stakes, myBet
        ]);

        // --- Spielerliste ---
        var playersEl = el('div', { class: 'crp-players' });

        var legend = el('div', { class: 'crp-legend' }, [
          'Pass Line: Come-Out 7/11 gewinnt, 2/3/12 verliert · sonst wird der Point wiederholt gewürfelt (Point = Sieg, 7 = Aus). Don’t Pass ist die Gegenwette (12 = Push).'
        ]);

        var wrap = el('div', { class: 'crp-wrap' }, [head, bannerEl, stage, betPanel, playersEl, legend]);
        root.innerHTML = ''; root.appendChild(wrap);

        refs = {
          wrap: wrap, bannerEl: bannerEl, phaseEl: phaseEl,
          die1: die1, die2: die2, sumEl: sumEl, pointBadge: pointBadge,
          betPanel: betPanel, sideBtns: { pass: passBtn, dontpass: dontBtn },
          stakeBtns: stakeBtns, maxBtn: maxBtn, cdBar: cdBar, cdSecs: cdSecs,
          myBet: myBet, myBetChips: myBetChips, playersEl: playersEl
        };
        rowRefs = {}; rowKey = '';
        built = true;
      }

      /* ==================== Eingaben ==================== */
      function myChipsOf(v) { return (v && v.chips && v.chips[me.id]) || 0; }
      function onSide(s) {
        var v = currentView(); if (!v || v.phase !== 'betting') return;
        if (myChipsOf(v) <= 0) { UI.toast('Keine Chips — du schaust zu', 'info'); return; }
        mySide = s; if (!myAmount) myAmount = 50;
        sendBet(); renderNow();
      }
      function onStake(val) {
        var v = currentView(); if (!v || v.phase !== 'betting') return;
        var ch = myChipsOf(v); if (ch <= 0) { UI.toast('Keine Chips — du schaust zu', 'info'); return; }
        myAmount = clampInt(val, 1, ch);
        if (mySide) sendBet();
        renderNow();
      }
      function onMax() { var v = currentView(); onStake(myChipsOf(v)); }

      /* ==================== Rendern ==================== */
      function render(v, now) {
        if (!built) return;
        if (!v) {
          refs.phaseEl.textContent = 'WARTE';
          refs.bannerEl.textContent = 'Warte auf den Tisch …';
          refs.bannerEl.className = 'crp-banner muted';
          return;
        }
        // Banner + Phase
        refs.bannerEl.textContent = v.msg || '';
        refs.bannerEl.className = 'crp-banner ' + (v.msgKind || 'gold');
        refs.phaseEl.textContent =
          v.phase === 'betting' ? 'WETTEN' :
          v.phase === 'comeout' ? 'COME OUT' :
          v.phase === 'point' ? ('POINT ' + v.point) : 'AUSZAHLUNG';

        // Würfel
        if (v.rollSeq !== lastRollSeq) {
          lastRollSeq = v.rollSeq;
          [refs.die1, refs.die2].forEach(function (d) { d.root.classList.remove('rolling'); void d.root.offsetWidth; d.root.classList.add('rolling'); });
        }
        var dv = v.dice;
        setDie(refs.die1, dv ? dv[0] : null);
        setDie(refs.die2, dv ? dv[1] : null);
        refs.sumEl.textContent = dv ? ('Summe ' + (dv[0] + dv[1])) : '—';
        if (v.point > 0) { refs.pointBadge.style.display = ''; refs.pointBadge.textContent = 'POINT ' + v.point; }
        else refs.pointBadge.style.display = 'none';

        // neue Wettrunde → lokale Auswahl zurücksetzen
        if (v.phase === 'betting' && v.round !== lastBetRound) { lastBetRound = v.round; mySide = null; }

        updateBetPanel(v, now);
        updatePlayers(v);
        handleResolveToast(v);
      }

      function updateBetPanel(v, now) {
        var betting = v.phase === 'betting';
        var myChips = myChipsOf(v);
        var canBet = betting && myChips > 0;
        refs.betPanel.classList.toggle('is-betting', betting);

        if (betting) {
          var rem = Math.max(0, v.betEndsAt - now);
          refs.cdBar.style.width = (rem / BET_MS * 100).toFixed(1) + '%';
          refs.cdSecs.textContent = Math.ceil(rem / 1000) + 's';
        } else {
          refs.cdBar.style.width = '0%';
          refs.cdSecs.textContent = '–';
        }

        refs.sideBtns.pass.classList.toggle('active', mySide === 'pass');
        refs.sideBtns.dontpass.classList.toggle('active', mySide === 'dontpass');
        refs.sideBtns.pass.disabled = !canBet;
        refs.sideBtns.dontpass.disabled = !canBet;

        var amt = clampInt(myAmount, 1, Math.max(1, myChips));
        refs.stakeBtns.forEach(function (b) {
          b.disabled = !canBet;
          b.classList.toggle('active', canBet && !!mySide && Number(b.dataset.v) === amt);
        });
        refs.maxBtn.disabled = !canBet;
        refs.maxBtn.classList.toggle('active', canBet && !!mySide && amt === myChips && myChips > 0);

        refs.myBetChips.textContent = 'Deine Chips: ' + MG.fmt(myChips);
        var mb = v.bets && v.bets[me.id];
        if (mb) {
          refs.myBet.textContent = 'Deine Wette: ' + (mb.bet === 'pass' ? 'Pass Line' : 'Don’t Pass') + ' · ' + mb.amount + ' Chips';
          refs.myBet.className = 'crp-mybet placed';
        } else {
          refs.myBet.className = 'crp-mybet';
          refs.myBet.textContent = !betting ? (myChips > 0 ? 'Warte auf die nächste Wettrunde …' : 'Keine Chips — du schaust zu')
            : (myChips > 0 ? 'Wähle Seite + Einsatz' : 'Keine Chips — du schaust zu');
        }
      }

      function updatePlayers(v) {
        var parts = participants();
        var key = parts.map(function (p) { return p.id; }).join('|');
        if (key !== rowKey) { rebuildRows(parts); rowKey = key; }
        parts.forEach(function (p) {
          var r = rowRefs[p.id]; if (!r) return;
          var ch = (v.chips && v.chips[p.id] != null) ? v.chips[p.id] : START_CHIPS;
          var bet = v.bets && v.bets[p.id];
          var res = v.results && v.results[p.id];
          r.name.textContent = p.name + (p.id === me.id ? ' (du)' : '');
          r.chips.textContent = MG.fmt(ch);
          if (bet) {
            r.bet.textContent = (bet.bet === 'pass' ? 'Pass ' : 'Don’t ') + bet.amount;
            r.bet.className = 'crp-tag ' + (bet.bet === 'pass' ? 'pass' : 'dont');
          } else {
            r.bet.textContent = ch > 0 ? '—' : '💤';
            r.bet.className = 'crp-tag none';
          }
          if (v.phase === 'resolve' && res) {
            r.delta.style.display = '';
            r.delta.textContent = (res.delta > 0 ? '+' : '') + res.delta;
            r.delta.className = 'crp-delta ' + (res.outcome === 'win' ? 'win' : res.outcome === 'lose' ? 'lose' : 'push');
          } else {
            r.delta.style.display = 'none';
          }
          r.root.classList.toggle('me', p.id === me.id);
          r.root.classList.toggle('broke', ch <= 0);
        });
      }
      function rebuildRows(parts) {
        refs.playersEl.innerHTML = ''; rowRefs = {};
        parts.forEach(function (p) {
          var name = el('span', { class: 'crp-p-name' }, [p.name]);
          var bet = el('span', { class: 'crp-tag none' }, ['—']);
          var chips = el('span', { class: 'crp-p-chips' }, ['0']);
          var delta = el('span', { class: 'crp-delta' }, ['']);
          delta.style.display = 'none';
          var rootEl = el('div', { class: 'crp-prow' }, [name, bet, el('span', { class: 'crp-p-coin' }, ['🪙']), chips, delta]);
          refs.playersEl.appendChild(rootEl);
          rowRefs[p.id] = { root: rootEl, name: name, bet: bet, chips: chips, delta: delta };
        });
      }

      function handleResolveToast(v) {
        if (v.phase === 'resolve' && v.round !== lastResolveRound) {
          lastResolveRound = v.round;
          var r = v.results && v.results[me.id];
          if (r) {
            if (r.outcome === 'win') {
              UI.toast('Gewonnen! +' + r.delta + ' Chips', 'win');
              // Bestenliste: eigene gewonnene Wette; lastResolveRound-Guard → genau einmal pro Runde je Client
              if (App.Scores) App.Scores.winCurrent();
            }
            else if (r.outcome === 'lose') UI.toast('Verloren ' + r.delta + ' Chips', 'lose');
            else UI.toast('Push — Einsatz zurück', 'info');
          }
        }
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
    UI.injectStyle('mg-craps-css', [
      '.crp-wrap{display:flex;flex-direction:column;gap:14px;max-width:520px;margin:0 auto;}',
      '.crp-head{display:flex;align-items:center;justify-content:space-between;gap:10px;}',
      '.crp-title{font-weight:900;font-size:20px;}',
      '.crp-back{padding:6px 12px;font-size:13px;}',

      '.crp-banner{text-align:center;font-weight:900;font-size:clamp(15px,4.4vw,20px);min-height:26px;line-height:1.25;transition:color .15s;}',
      '.crp-banner.good{color:var(--neon);text-shadow:0 0 12px rgba(57,255,20,.45);}',
      '.crp-banner.aqua{color:var(--aqua,#33e6d0);text-shadow:0 0 10px rgba(51,230,208,.35);}',
      '.crp-banner.gold{color:var(--gold);text-shadow:0 0 12px rgba(255,210,63,.4);}',
      '.crp-banner.danger{color:var(--danger);text-shadow:0 0 12px rgba(255,77,109,.5);}',
      '.crp-banner.muted{color:var(--muted);}',

      '.crp-stage{padding:16px;display:flex;flex-direction:column;align-items:center;gap:12px;border:1px solid var(--stroke-2,var(--stroke));}',
      '.crp-phase{font-size:12px;font-weight:800;letter-spacing:2px;color:var(--muted);text-transform:uppercase;}',
      '.crp-dice{display:flex;gap:18px;perspective:600px;}',
      '.crp-die{width:clamp(56px,15vw,80px);height:clamp(56px,15vw,80px);display:grid;grid-template-columns:repeat(3,1fr);grid-template-rows:repeat(3,1fr);gap:2px;padding:11px;border-radius:16px;',
      'background:radial-gradient(120% 120% at 30% 22%,#12472e,#05170e);border:1px solid var(--stroke-2,var(--stroke));',
      'box-shadow:inset 0 0 22px rgba(57,255,20,.14),0 6px 16px rgba(0,0,0,.45);}',
      '.crp-die.rolling{animation:crp-roll .5s cubic-bezier(.3,.7,.4,1);}',
      '@keyframes crp-roll{0%{transform:rotate(-16deg) scale(.9);}30%{transform:rotate(12deg) scale(1.08);}55%{transform:rotate(-8deg) scale(.98);}100%{transform:rotate(0) scale(1);}}',
      '.crp-cell{display:grid;place-items:center;}',
      '.crp-dot{width:clamp(9px,2.6vw,14px);height:clamp(9px,2.6vw,14px);border-radius:50%;background:radial-gradient(circle at 35% 30%,var(--leaf),var(--neon));',
      'box-shadow:0 0 7px rgba(57,255,20,.8),inset 0 -2px 3px rgba(0,0,0,.45);opacity:0;transform:scale(.4);transition:opacity .12s,transform .12s;}',
      '.crp-cell.on .crp-dot{opacity:1;transform:scale(1);}',
      '.crp-stage-foot{display:flex;align-items:center;gap:12px;min-height:26px;}',
      '.crp-sum{font-weight:800;color:var(--leaf);font-size:15px;}',
      '.crp-point{font-weight:900;font-size:13px;padding:4px 12px;border-radius:999px;color:#04160c;background:linear-gradient(180deg,#ffe07a,var(--gold));box-shadow:0 0 14px rgba(255,210,63,.45);letter-spacing:1px;}',

      '.crp-bet{padding:14px;display:flex;flex-direction:column;gap:12px;border:1px solid var(--stroke);}',
      '.crp-bet-head{display:flex;align-items:center;justify-content:space-between;gap:10px;}',
      '.crp-mychips{font-weight:800;color:var(--leaf);font-size:13px;}',
      '.crp-cd{display:flex;align-items:center;gap:8px;min-width:120px;flex:1;max-width:200px;}',
      '.crp-cd-bar{flex:1;height:8px;border-radius:6px;background:rgba(0,0,0,.4);overflow:hidden;border:1px solid var(--stroke);}',
      '.crp-cd-fill{height:100%;width:0%;border-radius:6px;background:linear-gradient(90deg,var(--danger),var(--gold),var(--neon));transition:width .12s linear;}',
      '.crp-cd-secs{font-weight:900;font-size:14px;color:var(--aqua,#33e6d0);min-width:30px;text-align:right;font-variant-numeric:tabular-nums;}',
      '.crp-bet:not(.is-betting) .crp-cd-bar{opacity:.35;}',

      '.crp-sides{display:grid;grid-template-columns:1fr 1fr;gap:10px;}',
      '.crp-side{display:flex;flex-direction:column;align-items:center;gap:3px;padding:12px 8px;border-radius:14px;cursor:pointer;font-family:inherit;color:var(--text);',
      'background:rgba(9,32,21,.85);border:2px solid var(--stroke-2,var(--stroke));transition:transform .08s,box-shadow .15s,border-color .15s;}',
      '.crp-side:active:not(:disabled){transform:scale(.96);}',
      '.crp-side:disabled{opacity:.45;cursor:not-allowed;}',
      '.crp-side-t{font-weight:900;font-size:15px;letter-spacing:.5px;}',
      '.crp-side-s{font-size:10px;color:var(--muted);text-align:center;line-height:1.2;}',
      '.crp-side.pass.active{border-color:var(--neon);box-shadow:0 0 16px rgba(57,255,20,.4);background:rgba(20,55,30,.9);}',
      '.crp-side.pass.active .crp-side-t{color:var(--neon);}',
      '.crp-side.dont.active{border-color:var(--aqua,#33e6d0);box-shadow:0 0 16px rgba(51,230,208,.4);background:rgba(12,45,50,.9);}',
      '.crp-side.dont.active .crp-side-t{color:var(--aqua,#33e6d0);}',

      '.crp-stakes{display:flex;gap:8px;flex-wrap:wrap;}',
      '.crp-stake{flex:1;min-width:56px;height:44px;border-radius:12px;font-size:16px;font-weight:900;cursor:pointer;font-family:inherit;',
      'color:var(--text);border:1px solid var(--stroke);background:rgba(9,32,21,.7);transition:.12s;}',
      '.crp-stake:hover:not(:disabled){border-color:var(--stroke-2);box-shadow:var(--glow-soft);transform:translateY(-1px);}',
      '.crp-stake:disabled{opacity:.4;cursor:not-allowed;}',
      '.crp-stake.active{color:#04160c;background:linear-gradient(180deg,var(--neon-soft,#8aff6a),var(--neon));border-color:var(--neon);box-shadow:var(--glow);}',
      '.crp-max{color:var(--gold);}',
      '.crp-max.active{color:#04160c;}',

      '.crp-mybet{text-align:center;font-weight:800;font-size:13px;color:var(--muted);min-height:18px;}',
      '.crp-mybet.placed{color:var(--neon);text-shadow:0 0 10px rgba(57,255,20,.35);}',

      '.crp-players{display:flex;flex-direction:column;gap:7px;}',
      '.crp-prow{display:grid;grid-template-columns:1fr auto 18px auto auto;align-items:center;gap:8px;padding:8px 12px;border-radius:12px;',
      'background:rgba(9,32,21,.6);border:1px solid var(--stroke);transition:border-color .15s,opacity .2s;}',
      '.crp-prow.me{border-color:var(--stroke-2);box-shadow:var(--glow-soft);}',
      '.crp-prow.broke{opacity:.5;}',
      '.crp-p-name{font-weight:800;font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.crp-p-coin{font-size:13px;opacity:.85;}',
      '.crp-p-chips{font-weight:900;color:var(--leaf);font-variant-numeric:tabular-nums;min-width:44px;text-align:right;}',
      '.crp-tag{font-size:11px;font-weight:900;padding:3px 9px;border-radius:999px;white-space:nowrap;}',
      '.crp-tag.none{color:var(--muted);background:rgba(0,0,0,.25);}',
      '.crp-tag.pass{color:#04160c;background:linear-gradient(180deg,var(--neon-soft,#8aff6a),var(--neon));}',
      '.crp-tag.dont{color:#04211f;background:linear-gradient(180deg,#7ff0e2,var(--aqua,#33e6d0));}',
      '.crp-delta{font-weight:900;font-size:13px;font-variant-numeric:tabular-nums;min-width:44px;text-align:right;}',
      '.crp-delta.win{color:var(--neon);}',
      '.crp-delta.lose{color:var(--danger);}',
      '.crp-delta.push{color:var(--gold);}',

      '.crp-legend{font-size:11px;color:var(--muted);line-height:1.4;text-align:center;padding:0 4px;}'
    ].join(''));
  }
})();
