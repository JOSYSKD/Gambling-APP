/* horserace.js — "Pferderennen": Casino-Wettspiel für die Kategorie
 * "Poker & Casino" (group:'live'). 5 Pferde mit festen Quoten laufen um die
 * Wette — setze auf ein Pferd und fiebere beim Rennen mit.
 *
 * Architektur (Pflicht): host-autoritativ + Intents.
 *  - Nur der HOST führt das Rennen, verrechnet Gewinne/Verluste und schreibt
 *    den kompletten Zustand via room.setShared({phase, chips, bets, positions,
 *    winnerHorse, ...}).  Alle rendern in-place aus 'shared' (kein Flackern).
 *  - Spieler senden ihre Wette als Intent room.reportState({seq, horse, amount}).
 *    Der Host wendet jeden Intent genau EINMAL an (letzte seq je Spieler).
 *  - Per-Room-Chips shared.chips[playerId] (Start 1000, App.Coins bleibt unberührt).
 *  - SOLO: der echte Spieler ist Host; 3–4 Bots wetten zufällig mit.
 *
 * cleanup() stoppt alle Timer und entfernt die Room-Listener. */
(function () {
  'use strict';
  window.App = window.App || {}; App.Minigames = App.Minigames || {};
  var UI = App.UI, el = UI.el;

  injectStyle();

  /* ---------- Statische Spieldaten ---------- */
  var HORSES = [
    { name: 'Dschungel-Blitz', odds: 2.3 },
    { name: 'Neon-Nelly',      odds: 3.7 },
    { name: 'Ranken-Renner',   odds: 5.5 },
    { name: 'Papagei',         odds: 8.5 },
    { name: 'Goldhuf',         odds: 13 }
  ];
  var ODDS = HORSES.map(function (h) { return h.odds; });
  /* Echte Sieg-Wahrscheinlichkeiten, an die Quoten gekoppelt (RTP je Pferd ~92 %).
     Der alte Ansatz (Speed-Faktor 1.0→0.65 je Quote) war kaputt: über ~55 Ticks
     mittelt sich der Zufall raus, der Favorit gewann 73 % (EV +45 %!) und die
     Außenseiter konnten NIE gewinnen. Jetzt wird der Sieger vor dem Start mit
     WIN_P gezogen und das Rennen passend choreographiert — jede Wette hat
     denselben fairen Hausvorteil. */
  var WIN_P = [0.40, 0.25, 0.17, 0.11, 0.07];
  function drawWinner() {
    var r = Math.random(), acc = 0;
    for (var i = 0; i < WIN_P.length; i++) { acc += WIN_P[i]; if (r <= acc) return i; }
    return WIN_P.length - 1;
  }
  var raceSpeed = null;   // host-lokal: effektives Tempo je Pferd im aktuellen Rennen

  var FINISH = 100;                 // Ziel-Distanz
  var START_CHIPS = 1000;           // Start-Chips je Spieler
  var REBUY = 250;                  // Bankrott-Bonus zu Rundenbeginn
  var BET_MS = 6500;                // Wett-Fenster (~6 s)
  var RESULT_MS = 4500;             // Anzeige des Zieleinlaufs
  var TICK = 150;                   // Host-/Render-Takt (Rennen rückt hier vor)
  var RACE_MIN = 1.8, RACE_SPAN = 4.4; // Schrittweite je Tick (vor Speed-Faktor)
  var STAKES = [50, 100, 250];      // Einsatz-Buttons (+ MAX)

  var BOT_POOL = [
    { id: 'bot1', name: '🤖 Coco' }, { id: 'bot2', name: '🦜 Rio' },
    { id: 'bot3', name: '🐒 Momo' }, { id: 'bot4', name: '🦥 Sly' }
  ];

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function chipsOf(v, id) { return (v && v.chips && v.chips[id]) || 0; }
  function copyBets(b) { var o = {}; Object.keys(b || {}).forEach(function (k) { o[k] = { horse: b[k].horse, amount: b[k].amount }; }); return o; }
  function shuffle(a) { for (var i = a.length - 1; i > 0; i--) { var j = (Math.random() * (i + 1)) | 0; var t = a[i]; a[i] = a[j]; a[j] = t; } return a; }
  function weightedHorse() {           // Bots bevorzugen leicht die Favoriten
    var w = ODDS.map(function (o) { return 1 / o; }), sum = 0, i;
    for (i = 0; i < w.length; i++) sum += w[i];
    var r = Math.random() * sum, acc = 0;
    for (i = 0; i < w.length; i++) { acc += w[i]; if (r <= acc) return i; }
    return 0;
  }

  App.Minigames.horserace = {
    id: 'horserace', title: 'Pferderennen', icon: '🐎', order: 32,
    subtitle: 'Setze auf ein Pferd und fiebere mit beim Rennen',
    single: true, multi: true, minPlayers: 2, maxPlayers: 8, group: 'live',

    render: function (root, ctx) {
      var isMulti = ctx.mode === 'multi';
      var room = ctx.room, me = ctx.me;
      var nowFn = isMulti ? function () { return room.now(); } : function () { return Date.now(); };

      /* ---- Laufzeit-Status ---- */
      var destroyed = false, timers = [];
      var G = null;                 // autoritativer Zustand (Host/Solo)
      var hosting = false;
      var lastShared = null;
      var bots = [];                // nur Solo
      var mySeq = 0, lastSeq = {};  // Intent-Sequenzen
      var mySelHorse = null;        // lokal gewähltes Pferd
      var myOptimistic = null;      // optimistische eigene Wette (bis shared echot)
      var onSharedFn = null, onPlayersFn = null;
      /* Transitions-Tracking (Toasts / Reset) */
      var lastPhase = null, lastRound = null, prevMyChips = 0;

      /* ---- DOM-Referenzen (einmal aufgebaut) ---- */
      var wrap = null, roundEl, phasePill, phaseTextEl, cdEl, statusEl;
      var laneRefs = [], chipsEl, selEl, stakeRow, stakeBtns = [], maxBtn, curBetEl, betNoteEl;
      var playersEl, prowEls = {};

      function every(ms, fn) { var t = setInterval(fn, ms); timers.push(t); return t; }
      function after(ms, fn) { var t = setTimeout(fn, ms); timers.push(t); return t; }
      function stopTimers() { timers.forEach(clearInterval); timers.forEach(clearTimeout); timers = []; }
      function amHost() { return isMulti ? (room && room.isHost()) : true; }

      run();
      return { cleanup: cleanup };

      /* ==================== Ablauf ==================== */
      function run() {
        buildUI();
        if (isMulti) {
          var snap = room.snapshot();
          if (snap && snap.shared) lastShared = snap.shared;
          onSharedFn = function (sh) { if (!destroyed) { lastShared = sh; render(view()); } };
          onPlayersFn = function () { onPlayers(); };
          room.on('shared', onSharedFn);
          room.on('players', onPlayersFn);
          if (amHost()) initHostFresh(nowFn());
        } else {
          setupBots();
          initHostFresh(nowFn());
        }
        every(TICK, loop);
        render(view());
      }

      function loop() {
        if (destroyed) return;
        if (amHost() || !isMulti) hostStep();
        render(view());
      }

      function setupBots() {
        var n = 3 + (Math.random() < 0.5 ? 1 : 0);           // 3–4 Bots
        bots = shuffle(BOT_POOL.slice()).slice(0, n);
      }

      /* ==================== Host-Lifecycle ==================== */
      function getPlayers() {
        if (isMulti) return room.players();
        return [{ id: me.id, name: me.name }].concat(bots);
      }
      function getPlayerIds() { return getPlayers().map(function (p) { return p.id; }); }

      function ensureChips() {         // neue Spieler bekommen Start-Chips
        if (!G) return false;
        var changed = false;
        getPlayerIds().forEach(function (id) { if (G.chips[id] == null) { G.chips[id] = START_CHIPS; changed = true; } });
        return changed;
      }
      function seedSeqs() {
        room.players().forEach(function (p) { if (p.state && typeof p.state.seq === 'number') lastSeq[p.id] = p.state.seq; });
      }

      function initHostFresh(now) {
        G = {
          phase: 'betting', round: 1, chips: {}, bets: {},
          positions: [0, 0, 0, 0, 0], winnerHorse: null,
          phaseEndsAt: now + BET_MS, lastWin: null
        };
        ensureChips();
        hosting = true;
        if (isMulti) { seedSeqs(); pushShared(); }
        else scheduleBotBets(now);
      }

      function becomeHost() {          // Host-Wechsel: Zustand aus shared übernehmen
        hosting = true;
        if (G) return;
        var s = lastShared, now = nowFn();
        if (s && s.phase) {
          G = {
            phase: s.phase, round: s.round || 1,
            chips: Object.assign({}, s.chips || {}), bets: Object.assign({}, s.bets || {}),
            positions: (s.positions || [0, 0, 0, 0, 0]).slice(),
            winnerHorse: (s.winnerHorse == null ? null : s.winnerHorse),
            phaseEndsAt: s.phaseEndsAt || (now + BET_MS), lastWin: s.lastWin || null
          };
          ensureChips();
          if (isMulti) { seedSeqs(); pushShared(); }
        } else {
          initHostFresh(now);
        }
      }

      /* ==================== Host-Simulation ==================== */
      function hostStep() {
        if (isMulti && amHost() && !hosting) becomeHost();
        if (isMulti && !amHost()) { hosting = false; return; }
        if (!G) return;
        var now = nowFn();
        if (G.phase === 'betting') { if (now >= G.phaseEndsAt) lockAndStart(now); }
        else if (G.phase === 'race') { raceTick(now); }
        else if (G.phase === 'result') { if (now >= G.phaseEndsAt) nextRound(now); }
      }

      function lockAndStart(now) {      // Wetten schließen, Einsätze abziehen
        Object.keys(G.bets).forEach(function (id) {
          var b = G.bets[id], ch = G.chips[id] || 0;
          if (b.amount > ch) b.amount = ch;
          if (b.amount <= 0) { delete G.bets[id]; return; }
          G.chips[id] = ch - b.amount;
        });
        G.positions = [0, 0, 0, 0, 0]; G.winnerHorse = null; G.phase = 'race';
        // Sieger jetzt ziehen (quotengerecht) und das Rennen darauf zuschneiden:
        // der Gezogene läuft mit Tempo 1, alle anderen mit 0.66–0.82. Per
        // Monte-Carlo verifiziert: <0.5 % Überraschungssieger, RTP je Pferd
        // 0.92–0.94 (engere Tempi ließen Außenseiter zu oft "aus Versehen"
        // gewinnen -> deren RTP wäre über 1 gerutscht).
        var w = drawWinner();
        raceSpeed = HORSES.map(function () { return 0.66 + Math.random() * 0.16; });
        raceSpeed[w] = 1;
        pushShared();
      }

      function raceTick(now) {
        var maxPos = -1, winner = -1;
        for (var i = 0; i < 5; i++) {
          G.positions[i] += (raceSpeed ? raceSpeed[i] : 1) * (RACE_MIN + Math.random() * RACE_SPAN);
          if (G.positions[i] >= FINISH && G.positions[i] > maxPos) { maxPos = G.positions[i]; winner = i; }
        }
        if (winner >= 0) finishRace(now, winner);
        else pushShared();
      }

      function finishRace(now, winner) {
        for (var i = 0; i < 5; i++) if (G.positions[i] > FINISH) G.positions[i] = FINISH;
        G.winnerHorse = winner;
        var payouts = {};
        Object.keys(G.bets).forEach(function (id) {
          var b = G.bets[id]; if (!b) return;
          if (b.horse === winner) {
            var gross = Math.round(b.amount * ODDS[winner]);     // Einsatz × Quote (brutto)
            G.chips[id] = (G.chips[id] || 0) + gross;
            payouts[id] = gross - b.amount;                      // Netto für die Anzeige
          } else {
            payouts[id] = -b.amount;
          }
        });
        G.lastWin = { horse: winner, odds: ODDS[winner], payouts: payouts, bets: copyBets(G.bets) };
        G.phase = 'result'; G.phaseEndsAt = now + RESULT_MS;
        pushShared();
      }

      function nextRound(now) {
        G.round++;
        ensureChips();
        getPlayerIds().forEach(function (id) { if ((G.chips[id] || 0) <= 0) G.chips[id] = REBUY; }); // Bankrott-Bonus
        G.bets = {}; G.positions = [0, 0, 0, 0, 0]; G.winnerHorse = null; G.lastWin = null;
        G.phase = 'betting'; G.phaseEndsAt = now + BET_MS;
        pushShared();
        if (!isMulti) scheduleBotBets(now);
      }

      function scheduleBotBets(now) {   // Solo: Bots wetten gestaffelt
        bots.forEach(function (bot) {
          after(500 + Math.random() * 3200, function () {
            if (destroyed || !G || G.phase !== 'betting') return;
            var ch = G.chips[bot.id] || 0; if (ch <= 0) return;
            var pool = STAKES.filter(function (a) { return a <= ch; });
            var amount = pool.length ? pool[(Math.random() * pool.length) | 0] : ch;
            applyBet(bot.id, weightedHorse(), amount);
          });
        });
      }

      /* ==================== Intents / Wetten ==================== */
      function onPlayers() {
        if (destroyed) return;
        if (amHost() && G) {
          if (ensureChips()) pushShared();
          room.players().forEach(function (p) {
            if (p.id === me.id) return;                 // eigene Wette läuft direkt
            var st = p.state;
            if (st && typeof st.seq === 'number' && st.seq > (lastSeq[p.id] || 0)) {
              lastSeq[p.id] = st.seq;
              if (typeof st.horse === 'number') applyBet(p.id, st.horse, st.amount);
            }
          });
        }
        render(view());
      }

      // Nur auf Host/Solo — autoritativ auf G.
      function applyBet(id, horse, amount) {
        if (!G || G.phase !== 'betting') return;
        horse = horse | 0; if (horse < 0 || horse > 4) return;
        ensureChips();
        var ch = G.chips[id] || 0; if (ch <= 0) return;
        amount = clamp(Math.round(amount) || 0, 1, ch);
        G.bets[id] = { horse: horse, amount: amount };
        pushShared();
      }

      function placeBet(horse, amount) {
        if (horse == null) { UI.toast('Wähle zuerst ein Pferd 🐎', 'info'); return; }
        var v = view();
        if (v.phase !== 'betting') { UI.toast('Wetten ist geschlossen', 'info'); return; }
        var ch = chipsOf(v, me.id);
        if (ch <= 0) { UI.toast('Keine Chips übrig', 'info'); return; }
        amount = Math.min(Math.round(amount) || 0, ch);
        if (amount <= 0) return;
        if (amHost() || !isMulti) applyBet(me.id, horse, amount);
        else { mySeq++; room.reportState({ seq: mySeq, horse: horse, amount: amount }); }
        myOptimistic = { horse: horse, amount: amount };
        render(view());
      }
      function placeBetMax() { placeBet(mySelHorse, chipsOf(view(), me.id)); }

      function selectHorse(i) {
        var v = view();
        if (v.phase !== 'betting') { UI.toast('Das Rennen läuft schon', 'info'); return; }
        if (chipsOf(v, me.id) <= 0) { UI.toast('Keine Chips übrig', 'info'); return; }
        mySelHorse = i;
        render(view());
      }

      /* ==================== Netzwerk-Push ==================== */
      function pushShared() {
        if (!isMulti || !amHost() || !G) return;
        room.setShared({
          phase: G.phase, round: G.round, chips: G.chips, bets: G.bets,
          positions: G.positions, winnerHorse: G.winnerHorse,
          phaseEndsAt: G.phaseEndsAt, lastWin: G.lastWin
        });
      }

      /* ==================== View-Auswahl ==================== */
      function view() {
        if ((amHost() || !isMulti) && G) return G;
        var s = lastShared || {};
        return {
          phase: s.phase || 'betting', round: s.round || 1,
          chips: s.chips || {}, bets: s.bets || {},
          positions: s.positions || [0, 0, 0, 0, 0],
          winnerHorse: (s.winnerHorse == null ? null : s.winnerHorse),
          phaseEndsAt: s.phaseEndsAt || 0, lastWin: s.lastWin || null
        };
      }

      /* ==================== UI-Aufbau ==================== */
      function buildUI() {
        roundEl = el('div', { class: 'hr-round' }, ['Rennen 1']);
        phaseTextEl = el('span', { class: 'hr-pill-txt' }, ['🎲 Wetten']);
        cdEl = el('span', { class: 'hr-pill-cd' }, ['']);
        phasePill = el('div', { class: 'hr-pill' }, [phaseTextEl, cdEl]);
        var head = el('div', { class: 'hr-head' }, [
          el('div', { class: 'hr-brand neon' }, ['🐎 Pferderennen']),
          el('div', { class: 'hr-head-right' }, [roundEl, phasePill])
        ]);

        var track = el('div', { class: 'hr-track glass' });
        laneRefs = [];
        HORSES.forEach(function (h, i) {
          var runner = el('div', { class: 'hr-runner' }, ['🐎']);
          var fill = el('div', { class: 'hr-fill' });
          var strip = el('div', { class: 'hr-strip' }, [fill, el('div', { class: 'hr-flag' }, ['🏁']), runner]);
          var mark = el('span', { class: 'hr-lmark' }, ['●']);
          var info = el('div', { class: 'hr-linfo' }, [
            el('span', { class: 'hr-lnum' }, [String(i + 1)]),
            el('span', { class: 'hr-lname' }, [h.name]),
            el('span', { class: 'hr-lodds' }, [h.odds.toFixed(1) + '×']),
            mark
          ]);
          var lane = el('button', {
            class: 'hr-lane hr-lane-' + i, type: 'button',
            onclick: (function (idx) { return function () { selectHorse(idx); }; })(i)
          }, [info, strip]);
          track.appendChild(lane);
          laneRefs.push({ lane: lane, runner: runner, fill: fill, mark: mark });
        });

        statusEl = el('div', { class: 'hr-status' }, ['']);

        chipsEl = el('div', { class: 'hr-chips' }, ['💰 1000']);
        selEl = el('div', { class: 'hr-sel' }, ['Wähle ein Pferd ↑']);
        stakeRow = el('div', { class: 'hr-stakes' });
        stakeBtns = [];
        STAKES.forEach(function (a) {
          var b = el('button', {
            class: 'hr-stake', type: 'button',
            onclick: (function (amt) { return function () { placeBet(mySelHorse, amt); }; })(a)
          }, ['+' + a]);
          stakeBtns.push(b); stakeRow.appendChild(b);
        });
        maxBtn = el('button', { class: 'hr-stake hr-stake-max', type: 'button', onclick: function () { placeBetMax(); } }, ['MAX']);
        stakeRow.appendChild(maxBtn);
        curBetEl = el('div', { class: 'hr-curbet' }, ['Noch keine Wette']);
        betNoteEl = el('div', { class: 'hr-betnote' }, ['']);
        var betBox = el('div', { class: 'hr-bet glass' }, [
          el('div', { class: 'hr-bet-top' }, [chipsEl, selEl]),
          stakeRow, curBetEl, betNoteEl
        ]);

        playersEl = el('div', { class: 'hr-players' });

        wrap = el('div', { class: 'hr-wrap' }, [
          head, track, statusEl, betBox,
          el('div', { class: 'hr-pl-title' }, ['🏇 Wettende']),
          playersEl,
          el('div', { class: 'hr-foot' }, [
            el('button', { class: 'btn btn-ghost', type: 'button', onclick: ctx.onExit }, ['← Zurück'])
          ])
        ]);
        root.innerHTML = ''; root.appendChild(wrap);
      }

      /* ==================== Rendern (in-place) ==================== */
      function render(v) {
        if (!wrap) return;
        var now = nowFn(), myId = me.id;
        var myChips = chipsOf(v, myId);
        var iAmIn = getPlayerIds().indexOf(myId) >= 0;
        var cd = Math.max(0, Math.ceil(((v.phaseEndsAt || 0) - now) / 1000));

        roundEl.textContent = 'Rennen ' + (v.round || 1);

        phasePill.className = 'hr-pill hr-pill-' + v.phase;
        if (v.phase === 'betting') { phaseTextEl.textContent = '🎲 Wetten'; cdEl.textContent = cd + 's'; cdEl.style.display = ''; }
        else if (v.phase === 'race') { phaseTextEl.textContent = '🏇 Läuft'; cdEl.style.display = 'none'; }
        else { phaseTextEl.textContent = '🏁 Ziel'; cdEl.textContent = cd + 's'; cdEl.style.display = ''; }

        var myBet = (v.bets && v.bets[myId]) ? v.bets[myId] : (v.phase === 'betting' ? myOptimistic : null);
        var running = v.phase === 'race';
        for (var i = 0; i < 5; i++) {
          var r = laneRefs[i];
          var pct = clamp(((v.positions && v.positions[i]) || 0) / FINISH * 100, 0, 100);
          var left = (2 + pct * 0.92);
          r.runner.style.left = left + '%';
          r.fill.style.width = left + '%';
          var isSel = (v.phase === 'betting' && mySelHorse === i);
          var isMyBet = !!(myBet && myBet.horse === i);
          var isWin = (v.phase === 'result' && v.winnerHorse === i);
          r.lane.className = 'hr-lane hr-lane-' + i + (isSel ? ' sel' : '') + (isMyBet ? ' mybet' : '') +
            (isWin ? ' win' : '') + (running ? ' running' : '') + (v.phase === 'betting' ? ' open' : '');
          r.mark.style.visibility = isMyBet ? 'visible' : 'hidden';
          r.runner.classList.toggle('run', running);
          r.runner.classList.toggle('cheer', isWin);
        }

        statusEl.className = 'hr-status hr-status-' + v.phase;
        if (v.phase === 'betting') {
          statusEl.textContent = 'Setze auf dein Pferd – noch ' + cd + 's';
        } else if (v.phase === 'race') {
          statusEl.textContent = 'Und sie sind gestartet! 🏇💨';
        } else if (v.phase === 'result' && v.winnerHorse != null) {
          var net = (v.lastWin && v.lastWin.payouts) ? v.lastWin.payouts[myId] : undefined;
          var mine = (net == null) ? ' · keine Wette' : (net > 0 ? ' · du: +' + net + ' 🎉' : ' · du: ' + net);
          statusEl.textContent = '🏁 ' + HORSES[v.winnerHorse].name + ' gewinnt! (' + ODDS[v.winnerHorse].toFixed(1) + '×)' + mine;
          statusEl.classList.toggle('hr-win', net > 0);
          statusEl.classList.toggle('hr-lose', net != null && net < 0);
        }

        // Wett-Steuerung
        chipsEl.textContent = '💰 ' + myChips;
        var canBet = v.phase === 'betting' && myChips > 0 && iAmIn;
        selEl.textContent = mySelHorse != null
          ? ('Gewählt: ' + HORSES[mySelHorse].name + ' (' + ODDS[mySelHorse].toFixed(1) + '×)')
          : (canBet ? 'Wähle ein Pferd ↑' : '—');
        stakeBtns.forEach(function (b, idx) { b.disabled = !canBet || STAKES[idx] > myChips; });
        maxBtn.disabled = !canBet; maxBtn.textContent = 'MAX (' + myChips + ')';

        if (myBet) {
          curBetEl.textContent = '✔ ' + myBet.amount + ' auf ' + HORSES[myBet.horse].name +
            ' (' + ODDS[myBet.horse].toFixed(1) + '×) → mögl. ' + Math.round(myBet.amount * ODDS[myBet.horse]);
          curBetEl.className = 'hr-curbet has';
        } else {
          curBetEl.textContent = canBet ? 'Noch keine Wette' : '—';
          curBetEl.className = 'hr-curbet';
        }

        if (canBet) {
          stakeRow.style.display = ''; betNoteEl.style.display = 'none';
        } else {
          stakeRow.style.display = 'none'; betNoteEl.style.display = '';
          betNoteEl.textContent = v.phase === 'race' ? '🔒 Wetten geschlossen – viel Glück!'
            : v.phase === 'result' ? '🏁 Nächste Wettrunde gleich …'
              : (myChips <= 0 ? '💸 Pleite – nächste Runde gibt es einen Bonus.' : 'Warte auf die nächste Wettrunde …');
        }

        renderPlayers(v);
        handleTransitions(v, myChips);
      }

      function renderPlayers(v) {
        var list = getPlayers(), seen = {};
        list.forEach(function (p) {
          seen[p.id] = true;
          var r = prowEls[p.id];
          if (!r) {
            var nameEl = el('span', { class: 'hr-pname' }, ['']);
            var betEl = el('span', { class: 'hr-pbet' }, ['—']);
            var pchips = el('span', { class: 'hr-pchips' }, ['💰 0']);
            var rootEl = el('div', { class: 'hr-prow' }, [nameEl, betEl, pchips]);
            r = { root: rootEl, nameEl: nameEl, betEl: betEl, chipsEl: pchips };
            prowEls[p.id] = r; playersEl.appendChild(rootEl);
          }
          r.nameEl.textContent = p.name + (p.id === me.id ? ' (du)' : '');
          r.chipsEl.textContent = '💰 ' + chipsOf(v, p.id);
          if (v.phase === 'result' && v.lastWin && v.lastWin.payouts) {
            var net = v.lastWin.payouts[p.id];
            if (net == null) { r.betEl.textContent = '—'; r.betEl.className = 'hr-pbet'; }
            else { r.betEl.textContent = (net > 0 ? '+' : '') + net; r.betEl.className = 'hr-pbet ' + (net > 0 ? 'up' : (net < 0 ? 'down' : '')); }
          } else {
            var b = v.bets && v.bets[p.id];
            if (b) { r.betEl.textContent = HORSES[b.horse].name.split('-')[0] + ' · ' + b.amount; r.betEl.className = 'hr-pbet bet'; }
            else { r.betEl.textContent = '—'; r.betEl.className = 'hr-pbet'; }
          }
          r.root.className = 'hr-prow' + (p.id === me.id ? ' me' : '');
        });
        Object.keys(prowEls).forEach(function (id) {
          if (!seen[id]) { var rr = prowEls[id]; if (rr.root.parentNode) rr.root.parentNode.removeChild(rr.root); delete prowEls[id]; }
        });
      }

      function handleTransitions(v, myChips) {
        if (lastRound === null) { lastRound = v.round; lastPhase = v.phase; prevMyChips = myChips; return; }
        if (v.round !== lastRound) {
          mySelHorse = null; myOptimistic = null;
          if (prevMyChips <= 0 && myChips > 0) UI.toast('💸 Bankrott-Bonus: +' + myChips + ' Chips', 'win');
        }
        if (v.phase !== lastPhase) {
          if (v.phase === 'race' && lastPhase === 'betting') { myOptimistic = null; UI.toast('Und los! 🏇', 'info'); }
          if (v.phase === 'result' && v.lastWin && v.lastWin.payouts) {
            var net = v.lastWin.payouts[me.id];
            if (net > 0) {
              UI.toast('🎉 Gewonnen: +' + net + ' Chips', 'win');
              // Bestenliste: eigenes Pferd hat gewonnen (net>0); Phasen-Guard → genau einmal pro Runde je Client
              if (App.Scores) App.Scores.winCurrent();
            }
            else if (net != null && net < 0) UI.toast('Verloren: ' + net + ' Chips', 'lose');
          }
        }
        lastRound = v.round; lastPhase = v.phase; prevMyChips = myChips;
      }

      /* ==================== Aufräumen ==================== */
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
    UI.injectStyle('mg-horserace-css', [
      '.hr-wrap{display:flex;flex-direction:column;gap:14px;max-width:640px;margin:0 auto;}',
      '.hr-head{display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;}',
      '.hr-brand{font-weight:900;font-size:20px;}',
      '.hr-head-right{display:flex;align-items:center;gap:10px;}',
      '.hr-round{font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;font-weight:800;}',
      '.hr-pill{display:inline-flex;align-items:center;gap:8px;padding:6px 12px;border-radius:999px;font-weight:900;font-size:13px;border:1px solid var(--stroke);background:rgba(9,32,21,.6);}',
      '.hr-pill-cd{font-variant-numeric:tabular-nums;color:var(--text);}',
      '.hr-pill-betting{border-color:var(--stroke-2);box-shadow:0 0 14px rgba(57,255,20,.25);}',
      '.hr-pill-race{border-color:var(--gold);color:var(--gold);box-shadow:0 0 16px rgba(255,210,63,.4);animation:hr-blink 1s steps(2) infinite;}',
      '.hr-pill-result{border-color:var(--aqua);color:var(--aqua);}',
      '@keyframes hr-blink{50%{opacity:.5}}',

      /* Rennbahn */
      '.hr-track{display:flex;flex-direction:column;gap:8px;padding:14px;}',
      '.hr-lane-0{--acc:var(--neon);} .hr-lane-1{--acc:var(--aqua);} .hr-lane-2{--acc:var(--gold);} .hr-lane-3{--acc:var(--leaf);} .hr-lane-4{--acc:var(--danger);}',
      '.hr-lane{display:grid;grid-template-columns:minmax(116px,32%) 1fr;align-items:center;gap:10px;padding:6px;border-radius:12px;border:2px solid transparent;background:transparent;text-align:left;font-family:inherit;color:var(--text);cursor:default;width:100%;transition:border-color .15s,background .15s;}',
      '.hr-lane.open{cursor:pointer;}',
      '@media(hover:hover){.hr-lane.open:hover{border-color:var(--acc);background:rgba(9,32,21,.5);}}',
      '.hr-lane.sel{border-color:var(--acc);background:rgba(9,32,21,.6);box-shadow:0 0 14px rgba(57,255,20,.15);}',
      '.hr-lane.mybet{background:rgba(9,32,21,.5);}',
      '.hr-lane.win{border-color:var(--gold);background:rgba(40,32,6,.55);box-shadow:0 0 20px rgba(255,210,63,.4);}',
      '.hr-linfo{display:flex;align-items:center;gap:6px;min-width:0;}',
      '.hr-lnum{flex:0 0 auto;width:20px;height:20px;display:inline-flex;align-items:center;justify-content:center;border-radius:6px;font-size:11px;font-weight:900;color:#04160c;background:var(--acc);}',
      '.hr-lname{font-weight:800;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0;}',
      '.hr-lodds{flex:0 0 auto;font-weight:900;font-size:12px;color:var(--acc);}',
      '.hr-lmark{flex:0 0 auto;color:var(--acc);font-size:11px;filter:drop-shadow(0 0 4px var(--acc));}',
      '.hr-strip{position:relative;height:34px;border-radius:10px;background:rgba(4,16,10,.7);border:1px solid var(--stroke);overflow:hidden;}',
      '.hr-fill{position:absolute;left:0;top:0;bottom:0;width:2%;background:linear-gradient(90deg,transparent,var(--acc));opacity:.18;transition:width .15s linear;}',
      '.hr-flag{position:absolute;right:6px;top:50%;transform:translateY(-50%);font-size:18px;opacity:.85;filter:drop-shadow(0 0 6px rgba(255,210,63,.5));}',
      '.hr-runner{position:absolute;left:2%;top:50%;transform:translate(-50%,-50%);font-size:22px;line-height:1;transition:left .15s linear;filter:drop-shadow(0 2px 4px rgba(0,0,0,.5));}',
      '.hr-runner.run{animation:hr-gallop .28s ease-in-out infinite;}',
      '@keyframes hr-gallop{50%{transform:translate(-50%,-64%) rotate(-4deg);}}',
      '.hr-runner.cheer{animation:hr-cheer .5s ease-in-out infinite;}',
      '@keyframes hr-cheer{0%,100%{transform:translate(-50%,-50%) scale(1);}50%{transform:translate(-50%,-72%) scale(1.2);}}',

      /* Status-Banner */
      '.hr-status{text-align:center;font-weight:900;font-size:clamp(15px,4vw,19px);min-height:24px;color:var(--aqua);transition:color .15s;}',
      '.hr-status-race{color:var(--gold);text-shadow:0 0 12px rgba(255,210,63,.4);}',
      '.hr-status.hr-win{color:var(--neon);text-shadow:0 0 12px rgba(57,255,20,.5);}',
      '.hr-status.hr-lose{color:var(--danger);}',

      /* Wett-Box */
      '.hr-bet{padding:14px 16px;display:flex;flex-direction:column;gap:10px;}',
      '.hr-bet-top{display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;}',
      '.hr-chips{font-weight:900;font-size:18px;color:var(--gold);text-shadow:0 0 10px rgba(255,210,63,.3);}',
      '.hr-sel{font-weight:800;font-size:13px;color:var(--leaf);}',
      '.hr-stakes{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;}',
      '.hr-stake{padding:12px 6px;border-radius:12px;font-family:inherit;font-weight:900;font-size:15px;color:var(--text);background:rgba(9,32,21,.85);border:2px solid var(--stroke-2);cursor:pointer;transition:transform .08s,box-shadow .15s,border-color .15s;user-select:none;-webkit-user-select:none;}',
      '.hr-stake:not(:disabled):active{transform:scale(.94);}',
      '@media(hover:hover){.hr-stake:not(:disabled):hover{border-color:var(--neon);box-shadow:0 0 14px rgba(57,255,20,.35);}}',
      '.hr-stake:disabled{opacity:.38;cursor:not-allowed;}',
      '.hr-stake-max{color:var(--gold);border-color:rgba(255,210,63,.5);font-size:13px;}',
      '.hr-curbet{text-align:center;font-weight:800;font-size:13px;color:var(--muted);min-height:18px;}',
      '.hr-curbet.has{color:var(--neon);}',
      '.hr-betnote{text-align:center;font-weight:800;font-size:13px;color:var(--aqua-soft);min-height:18px;}',

      /* Spielerliste */
      '.hr-pl-title{font-size:13px;font-weight:800;color:var(--leaf);text-transform:uppercase;letter-spacing:1px;}',
      '.hr-players{display:flex;flex-direction:column;gap:6px;}',
      '.hr-prow{display:grid;grid-template-columns:1fr auto auto;align-items:center;gap:10px;padding:8px 12px;border-radius:10px;background:rgba(9,32,21,.6);border:1px solid var(--stroke);}',
      '.hr-prow.me{border-color:var(--stroke-2);box-shadow:var(--glow-soft,0 0 12px rgba(57,255,20,.2));}',
      '.hr-pname{font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.hr-pbet{font-size:12px;font-weight:800;color:var(--muted);font-variant-numeric:tabular-nums;}',
      '.hr-pbet.bet{color:var(--aqua);}',
      '.hr-pbet.up{color:var(--neon);} .hr-pbet.down{color:var(--danger);}',
      '.hr-pchips{font-weight:900;color:var(--gold);font-variant-numeric:tabular-nums;font-size:13px;}',
      '.hr-foot{display:flex;justify-content:center;margin-top:4px;}'
    ].join(''));
  }
})();
