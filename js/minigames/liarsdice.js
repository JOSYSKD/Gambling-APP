/* liarsdice.js — "Lügen-Würfel" (Liar's Dice / Meiern) im Neon-Dschungel-Look.
 *
 * SPIELIDEE:
 *   Jeder startet mit 5 Würfeln und würfelt verdeckt (nur die eigenen sieht man).
 *   Reihum wird geboten: "es gibt mindestens N Würfel mit Augenzahl X". Jedes
 *   Gebot muss höher sein — mehr Würfel ODER gleiche Anzahl mit höherer Augenzahl.
 *   Einser (⚀) sind Joker und zählen für jede Augenzahl (deshalb bietet man nur
 *   auf Werte 2–6). Statt zu bieten kann man den Vorgänger ANZWEIFELN: alle decken
 *   auf, gezählt werden alle passenden Würfel + Joker. Lag der Bieter zu hoch
 *   (Bluff), verliert er einen Würfel; lag der Zweifler daneben, verliert dieser.
 *   Wer keine Würfel mehr hat, ist raus. Der Letzte mit Würfeln gewinnt.
 *
 * STEUERUNG:
 *   Auf dem eigenen Zug: Anzahl mit − / + einstellen, Augenzahl (2–6) wählen,
 *   "Bieten" — oder "Anzweifeln", wenn man dem letzten Gebot nicht glaubt.
 *
 * PUNKTE:
 *   Solo: Punktzahl aus Sieg + besiegten Bots + überlebten Runden, skaliert mit
 *   der Schwierigkeit (Bestwert in App.Storage 'best_liarsdice').
 *   Multi: jeder meldet eine Überlebens-Kennzahl (restliche Würfel + Runden) als
 *   Score -> Podest über App.MG.endScreen.
 *
 * SYNC-MODELL (Multiplayer, rundenbasiert über room.shared):
 *   shared = { order, counts, round, turn, starter, bid, history, phase,
 *              reveal, chal, winner }.  Die EIGENEN Würfel liegen NIE im geteilten
 *   Zustand — jeder würfelt lokal (bei jeder neuen 'round') und meldet die Würfel
 *   ERST beim Aufdecken per room.reportState({dice,drRound}). Der Host sammelt
 *   dann alle gemeldeten Würfel, wertet aus und schreibt das Ergebnis in shared.
 *   Gebote setzt der jeweils aktive Spieler direkt via room.setShared (wie
 *   tictactoe). Zeit/Countdown laufen über room.now() (synchron). cleanup()
 *   stoppt alle Timer/Intervalle und entfernt jeden room.on-Listener. */
(function () {
  'use strict';
  window.App = window.App || {}; App.Minigames = App.Minigames || {};
  var UI = App.UI, el = UI.el;

  injectStyle();

  var START_DICE = 5;      // Würfel pro Spieler zu Beginn
  var REVEAL_MS = 4500;    // Anzeigedauer der Aufdeck-Runde
  var BOT_DELAY = 1150;    // Denkpause der Bots (Solo)
  var DICE_FACE = [null, '⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];
  var assign = Object.assign;

  /* ===================== reine Spiel-Logik ===================== */
  function rollN(n) { var a = [], i; for (i = 0; i < n; i++) a.push(1 + Math.floor(Math.random() * 6)); return a; }
  /* zählt Würfel mit Augenzahl value (2..6) inkl. Joker (Einser) */
  function countMatch(dice, value) { var c = 0, i; if (!dice) return 0; for (i = 0; i < dice.length; i++) { if (dice[i] === value || dice[i] === 1) c++; } return c; }
  /* a echt höher als b? (b darf null sein = Eröffnung) */
  function isHigher(a, b) { if (!a) return false; if (!b) return a.count >= 1; return a.count > b.count || (a.count === b.count && a.value > b.value); }
  /* kleinstes legales höheres Gebot (oder null, wenn keins mehr passt) */
  function minHigher(bid, total) {
    if (!bid) return { count: 1, value: 2 };
    var c, v;
    if (bid.value < 6) { c = bid.count; v = bid.value + 1; } else { c = bid.count + 1; v = 2; }
    if (c > total) return null;
    return { count: c, value: v };
  }
  function sumCounts(order, counts, present) { var s = 0; order.forEach(function (id) { if ((counts[id] || 0) > 0 && present[id]) s += counts[id]; }); return s; }
  function aliveList(order, counts, present) { return order.filter(function (id) { return (counts[id] || 0) > 0 && present[id]; }); }
  function nextAlive(order, counts, present, fromId) {
    var n = order.length, idx = order.indexOf(fromId), i, id;
    if (idx < 0) idx = 0;
    for (i = 1; i <= n; i++) { id = order[(idx + i) % n]; if ((counts[id] || 0) > 0 && present[id]) return id; }
    return fromId;
  }
  function playerById(players, id) { for (var i = 0; i < players.length; i++) if (players[i].id === id) return players[i]; return null; }

  /* ===================== Bot-KI (Solo) ===================== */
  function nCk(n, k) { if (k < 0 || k > n) return 0; if (k === 0 || k === n) return 1; k = Math.min(k, n - k); var r = 1, i; for (i = 0; i < k; i++) r = r * (n - i) / (i + 1); return r; }
  /* P(X >= k) mit X ~ Binomial(n, p) — Wahrscheinlichkeit, dass die verdeckten
     Würfel genug Treffer liefern (p = 1/3, da Zielzahl ODER Joker passt). */
  function binomAtLeast(n, p, k) { if (k <= 0) return 1; if (k > n) return 0; var sum = 0, i; for (i = k; i <= n; i++) sum += nCk(n, i) * Math.pow(p, i) * Math.pow(1 - p, n - i); return sum; }

  var DIFF = {
    easy: { chalP: 0.13, risk: 0.35, bluff: 0.10, noise: 1.1 },
    medium: { chalP: 0.24, risk: 0.75, bluff: 0.18, noise: 0.60 },
    hard: { chalP: 0.34, risk: 1.10, bluff: 0.24, noise: 0.25 }
  };

  /* Entscheidung eines Bots: eigenes Blatt myDice, total = alle Würfel im Spiel,
     U = verdeckte Fremdwürfel, bid = aktuelles Gebot (oder null), diff = Stufe. */
  function botDecide(myDice, total, U, bid, diff) {
    function ownM(v) { return countMatch(myDice, v); }
    var v, c;
    if (!bid) {
      // Eröffnung: auf die eigene stärkste Augenzahl setzen
      var bestV = 2, bestC = -1;
      for (v = 2; v <= 6; v++) { c = ownM(v); if (c > bestC) { bestC = c; bestV = v; } }
      var exp = bestC + U / 3;
      var count = Math.round(exp * 0.72 + (Math.random() - 0.5) * diff.noise);
      if (count < 1) count = 1; if (count > total) count = total;
      if (Math.random() < diff.bluff && count < total) count++;
      return { action: 'bid', count: count, value: bestV };
    }
    if (bid.count > total) return { action: 'challenge' };   // unmöglich -> immer zweifeln
    var need = bid.count - ownM(bid.value);
    var pTrue = binomAtLeast(U, 1 / 3, need);
    var noisyP = pTrue + (Math.random() * 2 - 1) * 0.15 * diff.noise;
    if (noisyP < 0) noisyP = 0; if (noisyP > 1) noisyP = 1;
    // mögliche höhere Gebote sammeln, das risikoärmste merken
    var cands = [], vv;
    if (bid.value < 6) for (vv = bid.value + 1; vv <= 6; vv++) cands.push({ count: bid.count, value: vv });
    for (vv = 2; vv <= 6; vv++) cands.push({ count: bid.count + 1, value: vv });
    var best = null, bestRisk = 1e9;
    cands.forEach(function (cd) { if (cd.count > total) return; var support = ownM(cd.value) + U / 3; var risk = cd.count - support; if (risk < bestRisk) { bestRisk = risk; best = cd; } });
    if (noisyP < diff.chalP) return { action: 'challenge' };
    var tol = diff.risk + (Math.random() < diff.bluff ? 1 : 0);
    if (best && bestRisk <= tol) return { action: 'bid', count: best.count, value: best.value };
    if (noisyP < 0.5) return { action: 'challenge' };
    if (best) return { action: 'bid', count: best.count, value: best.value };
    return { action: 'challenge' };
  }

  /* ===================== View-Model (rein) ===================== */
  function buildVM(p) {
    var players = p.order.map(function (id) {
      var cnt = p.counts[id] || 0;
      return { id: id, name: p.nameOf(id), count: cnt, turn: (p.phase === 'bidding' && p.turn === id), me: (id === p.myId), out: cnt <= 0, absent: !p.present[id] };
    });
    var total = sumCounts(p.order, p.counts, p.present);
    var bid = p.bid ? { count: p.bid.count, value: p.bid.value, name: p.nameOf(p.bid.by) } : null;
    var history = (p.history || []).map(function (h) { return { name: p.nameOf(h.by), count: h.count, value: h.value }; });
    var reveal = null;
    if (p.reveal) {
      var r = p.reveal;
      reveal = {
        value: r.value, needed: r.needed, actual: r.actual,
        challenger: p.nameOf(r.challenger), loser: p.nameOf(r.loser), bidTrue: (r.actual >= r.needed),
        entries: (r.order || []).map(function (id) { return { name: p.nameOf(id), me: (id === p.myId), dice: (r.dice && r.dice[id]) || [] }; })
      };
    }
    var status;
    if (p.phase === 'reveal') status = { text: '🔍 Würfel werden aufgedeckt …', cls: 'info' };
    else if (p.phase === 'roundEnd') { var lz = p.reveal ? p.reveal.loser : null; status = (lz === p.myId) ? { text: 'Du verlierst einen Würfel 😬', cls: 'lose' } : { text: (p.nameOf(lz) || '') + ' verliert einen Würfel', cls: 'info' }; }
    else if (p.spectator) status = { text: '👀 Du schaust zu', cls: 'info' };
    else if (p.out) status = { text: '💀 Ausgeschieden – schau zu, wer gewinnt', cls: 'lose' };
    else if (p.phase === 'bidding' && p.turn === p.myId) status = { text: p.bid ? 'Du bist dran – höher bieten oder anzweifeln' : 'Du bist dran – eröffne die Runde', cls: 'you' };
    else status = { text: (p.nameOf(p.turn) || 'Gegner') + ' überlegt …', cls: 'opp' };
    var canAct = (!p.spectator && !p.out && p.phase === 'bidding' && p.turn === p.myId);
    return {
      round: p.round, totalDice: total, players: players, bid: bid, history: history,
      phase: p.phase, reveal: reveal, myDice: (p.spectator || p.out) ? null : p.myDice,
      spectator: p.spectator, out: p.out, status: status, canAct: canAct
    };
  }

  /* ===================== Registrierung + render ===================== */
  App.Minigames.liarsdice = {
    id: 'liarsdice', title: 'Lügen-Würfel', icon: '🤥', order: 129,
    subtitle: 'Bluff-Duell mit Würfeln – wer glaubt dir?',
    single: true, multi: true, minPlayers: 2, maxPlayers: 6,

    render: function (root, ctx) {
      var isMulti = ctx.mode === 'multi';
      var dead = false, timers = [], stops = [], rollIv = null, refs = null;

      function after(ms, fn) { var t = setTimeout(function () { if (!dead) fn(); }, ms); timers.push(t); return t; }
      function clearTimers() { timers.forEach(clearTimeout); timers = []; }
      function stopAll() { stops.forEach(function (f) { try { f(); } catch (e) {} }); stops = []; }
      function cleanup() { dead = true; clearTimers(); stopAll(); if (rollIv) { clearInterval(rollIv); rollIv = null; } }

      /* ---------- gemeinsame DOM-Bausteine ---------- */
      function setMyDie(span, val) { span.textContent = DICE_FACE[val] || '?'; span.className = 'lrd-die lrd-mydie' + (val === 1 ? ' joker' : ''); }
      function startRoll(row, dice) {
        if (!row) return;
        if (rollIv) { clearInterval(rollIv); rollIv = null; }
        if (App.Audio) App.Audio.sfx('roll');
        var start = Date.now(), dur = 650, sp = row.children;
        rollIv = setInterval(function () {
          if (dead) { clearInterval(rollIv); rollIv = null; return; }
          var t = Date.now() - start, i;
          if (t < dur) { for (i = 0; i < sp.length; i++) { sp[i].textContent = DICE_FACE[1 + Math.floor(Math.random() * 6)]; sp[i].className = 'lrd-die lrd-mydie lrd-spin'; } }
          else { clearInterval(rollIv); rollIv = null; for (i = 0; i < sp.length; i++) setMyDie(sp[i], dice[i]); }
        }, 60);
      }

      function buildLayout() {
        var roundEl = el('div', { class: 'lrd-round' }, ['Runde 1']);
        var totalEl = el('div', { class: 'lrd-total' }, ['']);
        var top = el('div', { class: 'lrd-top glass' }, [
          el('div', { class: 'lrd-brand neon' }, ['🎲 Lügen-Würfel']),
          el('div', { class: 'lrd-top-r' }, [roundEl, totalEl])
        ]);
        var playersEl = el('div', { class: 'lrd-players' });
        var bidEl = el('div', { class: 'lrd-bidbar glass' });
        var revealEl = el('div', { class: 'lrd-reveal' });
        var handEl = el('div', { class: 'lrd-hand glass' });
        var controlsEl = el('div', { class: 'lrd-ctlwrap' });
        var statusEl = el('div', { class: 'lrd-status' }, ['']);
        var historyEl = el('div', { class: 'lrd-history' });
        var rules = el('div', { class: 'lrd-rules hint-text' }, ['Biete „mind. N × Augenzahl" — höher = mehr Würfel oder gleiche Anzahl mit höherer Zahl. ⚀ Einser sind Joker (zählen für alles). Glaubst du nicht? Zweifle an!']);
        var wrap = el('div', { class: 'lrd-wrap' }, [
          top, statusEl, playersEl, bidEl, revealEl, handEl, controlsEl,
          el('details', { class: 'lrd-hist-wrap' }, [el('summary', {}, ['Gebots-Verlauf']), historyEl]),
          rules
        ]);
        root.innerHTML = ''; root.appendChild(wrap);
        refs = { roundEl: roundEl, totalEl: totalEl, playersEl: playersEl, bidEl: bidEl, revealEl: revealEl, handEl: handEl, controlsEl: controlsEl, statusEl: statusEl, historyEl: historyEl, handRow: null, handCount: -1, lastRound: -999 };
      }

      function updateHand(vm) {
        var handEl = refs.handEl;
        if (vm.myDice == null) {
          handEl.innerHTML = '';
          handEl.appendChild(el('div', { class: 'lrd-hand-empty' }, [vm.spectator ? '👀 Du schaust nur zu – keine Würfel' : (vm.out ? '💀 Du bist ausgeschieden' : '—')]));
          refs.handCount = -1; refs.lastRound = vm.round; return;
        }
        if (refs.handCount !== vm.myDice.length) {
          handEl.innerHTML = '';
          handEl.appendChild(el('div', { class: 'lrd-hand-label' }, ['Deine Würfel']));
          var row = el('div', { class: 'lrd-hand-row' });
          for (var i = 0; i < vm.myDice.length; i++) row.appendChild(el('span', { class: 'lrd-die lrd-mydie' }, ['?']));
          handEl.appendChild(row);
          refs.handRow = row; refs.handCount = vm.myDice.length;
        }
        var animate = (vm.round !== refs.lastRound) && vm.phase === 'bidding';
        if (animate) startRoll(refs.handRow, vm.myDice);
        else { var sp = refs.handRow.children; for (var j = 0; j < sp.length; j++) setMyDie(sp[j], vm.myDice[j]); }
        refs.lastRound = vm.round;
      }

      function buildControls(bid, total, onBid, onChallenge) {
        var mh = minHigher(bid, total);
        var pc = mh ? mh.count : null, pv = mh ? mh.value : null;
        var countEl = el('span', { class: 'lrd-count' }, ['–']);
        var prevFace = el('span', { class: 'lrd-prevface' }, ['']);
        var valBtns = {}, valWrap = el('div', { class: 'lrd-values' });
        for (var v = 2; v <= 6; v++) {
          (function (vv) {
            var b = el('button', { class: 'lrd-valbtn', type: 'button', onclick: function () { setVal(vv); } }, [DICE_FACE[vv]]);
            valBtns[vv] = b; valWrap.appendChild(b);
          })(v);
        }
        var minus = el('button', { class: 'btn btn-ghost lrd-step', type: 'button', onclick: function () { if (pc != null) setCount(pc - 1); } }, ['−']);
        var plus = el('button', { class: 'btn btn-ghost lrd-step', type: 'button', onclick: function () { if (pc != null) setCount(pc + 1); } }, ['+']);
        var bidBtn = el('button', { class: 'btn btn-primary lrd-bidbtn', type: 'button', onclick: function () { if (pc && pv && isHigher({ count: pc, value: pv }, bid)) { if (App.Audio) App.Audio.sfx('select'); onBid(pc, pv); } } }, ['✔ Bieten']);
        var chalBtn = el('button', { class: 'btn btn-danger lrd-chalbtn', type: 'button', onclick: function () { if (bid) onChallenge(); } }, ['🔍 Anzweifeln']);
        function minCountFor(val) { if (!bid) return 1; return val > bid.value ? bid.count : bid.count + 1; }
        function setVal(val) { pv = val; var mc = minCountFor(val); if (pc == null || pc < mc) pc = mc; if (pc > total) pc = total; refresh(); }
        function setCount(c) { var mc = minCountFor(pv); if (c < mc) c = mc; if (c > total) c = total; pc = c; refresh(); }
        function refresh() {
          countEl.textContent = (pc == null ? '–' : String(pc));
          prevFace.textContent = (pv == null ? '' : DICE_FACE[pv]);
          for (var vx = 2; vx <= 6; vx++) valBtns[vx].classList.toggle('sel', vx === pv);
          var legal = pc != null && pv != null && isHigher({ count: pc, value: pv }, bid) && pc <= total;
          bidBtn.disabled = !legal;
          chalBtn.disabled = !bid;
        }
        refresh();
        var stepper = el('div', { class: 'lrd-stepper' }, [minus, el('div', { class: 'lrd-countbox' }, [countEl, el('span', { class: 'lrd-x' }, ['×']), prevFace]), plus]);
        return el('div', { class: 'lrd-controls' }, [
          el('div', { class: 'lrd-ctl-row' }, [stepper, valWrap]),
          el('div', { class: 'lrd-ctl-btns' }, [chalBtn, bidBtn])
        ]);
      }

      function updateView(vm, handlers) {
        if (!refs) return;
        refs.roundEl.textContent = 'Runde ' + vm.round;
        refs.totalEl.textContent = vm.totalDice + ' Würfel gesamt';
        // Spieler-Panels
        refs.playersEl.innerHTML = '';
        vm.players.forEach(function (pl) {
          var cls = 'lrd-pl' + (pl.turn ? ' turn' : '') + (pl.me ? ' me' : '') + (pl.out ? ' out' : '') + (pl.absent && !pl.out ? ' absent' : '');
          var backs = el('div', { class: 'lrd-backs' });
          if (pl.out) backs.appendChild(el('span', { class: 'lrd-outx' }, ['✖']));
          else for (var i = 0; i < pl.count; i++) backs.appendChild(el('span', { class: 'lrd-back' }, ['🎲']));
          refs.playersEl.appendChild(el('div', { class: cls }, [
            el('div', { class: 'lrd-pl-name' }, [pl.name + (pl.me ? ' (du)' : '') + (pl.absent && !pl.out ? ' 📴' : '')]),
            backs,
            el('div', { class: 'lrd-pl-cnt' }, [pl.out ? 'raus' : (pl.count + ' Würfel')])
          ]));
        });
        // Gebots-Leiste
        refs.bidEl.innerHTML = '';
        if (vm.bid) {
          refs.bidEl.appendChild(el('div', { class: 'lrd-bid-main' }, [
            el('span', { class: 'lrd-bid-n' }, ['mind. ' + vm.bid.count + ' ×']),
            el('span', { class: 'lrd-bid-face' }, [DICE_FACE[vm.bid.value]])
          ]));
          refs.bidEl.appendChild(el('div', { class: 'lrd-bid-by' }, [vm.bid.name + ' hat geboten']));
        } else {
          refs.bidEl.appendChild(el('div', { class: 'lrd-bid-empty' }, ['Noch kein Gebot – eröffne die Runde']));
        }
        // Verlauf
        refs.historyEl.innerHTML = '';
        vm.history.forEach(function (h) {
          refs.historyEl.appendChild(el('div', { class: 'lrd-hrow' }, [el('span', { class: 'lrd-hn' }, [h.name]), el('span', {}, ['mind. ' + h.count + ' × ' + DICE_FACE[h.value]])]));
        });
        if (!vm.history.length) refs.historyEl.appendChild(el('div', { class: 'lrd-hrow' }, ['—']));
        // Aufdecken
        refs.revealEl.innerHTML = '';
        if (vm.reveal) {
          var r = vm.reveal;
          var head = el('div', { class: 'lrd-rv-head' }, [
            el('div', { class: 'lrd-rv-title' }, ['🔍 Aufgedeckt!']),
            el('div', { class: 'lrd-rv-claim' }, [r.challenger + ' zweifelt: „mind. ' + r.needed + ' × ' + DICE_FACE[r.value] + '"']),
            el('div', { class: 'lrd-rv-count' }, ['Gezählt: ', el('b', {}, [String(r.actual)]), ' × ' + DICE_FACE[r.value] + ' (mit Joker ⚀)'])
          ]);
          var rows = el('div', { class: 'lrd-rv-rows' });
          r.entries.forEach(function (en) {
            var dl = el('div', { class: 'lrd-rv-dice' });
            en.dice.forEach(function (d) {
              var match = (d === r.value || d === 1);
              dl.appendChild(el('span', { class: 'lrd-die lrd-rv-die' + (match ? ' match' : '') + (d === 1 ? ' joker' : '') }, [DICE_FACE[d]]));
            });
            rows.appendChild(el('div', { class: 'lrd-rv-row' + (en.me ? ' me' : '') }, [el('div', { class: 'lrd-rv-nm' }, [en.name + (en.me ? ' (du)' : '')]), dl]));
          });
          var verdict = el('div', { class: 'lrd-rv-verdict' }, [(r.bidTrue ? 'Gebot stimmt – falsch gezweifelt! ' : 'Bluff aufgeflogen! ') + r.loser + ' verliert einen Würfel.']);
          refs.revealEl.appendChild(el('div', { class: 'lrd-rv glass' }, [head, rows, verdict]));
        }
        // eigene Hand
        updateHand(vm);
        // Steuerung
        refs.controlsEl.innerHTML = '';
        if (vm.canAct) refs.controlsEl.appendChild(buildControls(vm.bid, vm.totalDice, handlers.onBid, handlers.onChallenge));
        // Status
        refs.statusEl.textContent = vm.status.text;
        refs.statusEl.className = 'lrd-status ' + vm.status.cls;
      }

      /* ---------- Einstieg ---------- */
      if (isMulti) startMulti(); else showDifficulty();
      return { cleanup: cleanup };

      /* ======================================================= *
       *  SOLO — gegen 3 Bots mit Wahrscheinlichkeits-KI
       * ======================================================= */
      function showDifficulty() {
        function diffBtn(key, title, desc) {
          return el('button', { class: 'btn lrd-diff-btn lrd-' + key, type: 'button', onclick: function () { if (App.Audio) App.Audio.sfx('select'); startSolo(key); } }, [
            el('span', { class: 'lrd-diff-t' }, [title]), el('span', { class: 'lrd-diff-d' }, [desc])
          ]);
        }
        root.innerHTML = '';
        root.appendChild(el('div', { class: 'lrd-diff glass' }, [
          el('div', { class: 'lrd-diff-emoji' }, ['🎲']),
          el('h2', { class: 'neon' }, ['Lügen-Würfel']),
          el('p', { class: 'hint-text' }, ['Bluffe dich durch! Wähle die Stärke deiner 3 Bot-Gegner.']),
          el('div', { class: 'lrd-diff-btns' }, [
            diffBtn('easy', '😌 Leicht', 'Vorsichtige Bots, selten Bluff'),
            diffBtn('medium', '🎯 Mittel', 'Rechnen mit, bluffen ab und zu'),
            diffBtn('hard', '🔥 Schwer', 'Scharfe Wahrscheinlichkeits-KI')
          ]),
          el('div', { class: 'lrd-rules hint-text' }, ['Ziel: als Letzter noch Würfel haben. ⚀ Einser sind Joker.'])
        ]));
      }

      function startSolo(diffKey) {
        clearTimers(); if (rollIv) { clearInterval(rollIv); rollIv = null; }
        var diff = DIFF[diffKey];
        var meName = (ctx.me && ctx.me.name) ? ctx.me.name : 'Du';
        var order = ['me', 'b1', 'b2', 'b3'];
        var isBot = { me: false, b1: true, b2: true, b3: true };
        var nameMap = { me: meName, b1: '🤖 Ananas', b2: '🤖 Kokos', b3: '🤖 Mango' };
        var present = { me: true, b1: true, b2: true, b3: true };
        var counts = { me: START_DICE, b1: START_DICE, b2: START_DICE, b3: START_DICE };
        var dice = {};
        var st = { round: 0, turn: 'me', starter: 'me', bid: null, history: [], phase: 'bidding', reveal: null };
        var survived = 0, botsBeaten = 0;

        buildLayout();
        function nameOf(id) { return nameMap[id] || 'Spieler'; }
        function alive() { return aliveList(order, counts, present); }
        function rollAll() { order.forEach(function (id) { if (counts[id] > 0) dice[id] = rollN(counts[id]); }); }
        function paint() {
          updateView(buildVM({ order: order, counts: counts, present: present, nameOf: nameOf, bid: st.bid, history: st.history, phase: st.phase, turn: st.turn, round: st.round, reveal: st.reveal, myId: 'me', myDice: dice['me'] || [], spectator: false, out: counts['me'] <= 0 }),
            { onBid: onHumanBid, onChallenge: onHumanChallenge });
        }
        function startRound(starter) {
          st.round++; rollAll(); st.bid = null; st.history = []; st.phase = 'bidding'; st.reveal = null; st.turn = starter; st.starter = starter;
          if (counts['me'] > 0) survived++;
          paint();
          if (isBot[st.turn]) scheduleBot();
        }
        function onHumanBid(count, value) {
          if (dead || st.phase !== 'bidding' || st.turn !== 'me') return;
          if (!isHigher({ count: count, value: value }, st.bid)) return;
          if (App.Audio) App.Audio.sfx('chip');
          st.bid = { count: count, value: value, by: 'me' }; st.history.push({ by: 'me', count: count, value: value });
          st.turn = nextAlive(order, counts, present, 'me'); paint(); if (isBot[st.turn]) scheduleBot();
        }
        function onHumanChallenge() {
          if (dead || st.phase !== 'bidding' || st.turn !== 'me' || !st.bid) return;
          doReveal('me', st.bid.by);
        }
        function scheduleBot() {
          after(BOT_DELAY, function () {
            if (dead || st.phase !== 'bidding') return;
            var id = st.turn; if (!isBot[id]) return;
            var total = sumCounts(order, counts, present), U = total - counts[id];
            var dec = botDecide(dice[id], total, U, st.bid, diff);
            if (dec.action === 'challenge' && st.bid) { doReveal(id, st.bid.by); return; }
            var b = dec;
            if (!isHigher({ count: b.count, value: b.value }, st.bid)) { var mh = minHigher(st.bid, total); if (!mh) { doReveal(id, st.bid.by); return; } b = mh; }
            if (App.Audio) App.Audio.sfx('click');
            st.bid = { count: b.count, value: b.value, by: id }; st.history.push({ by: id, count: b.count, value: b.value });
            st.turn = nextAlive(order, counts, present, id); paint(); if (isBot[st.turn]) scheduleBot();
          });
        }
        function doReveal(challenger, challenged) {
          st.phase = 'reveal';
          var al = alive();
          var value = st.bid.value, needed = st.bid.count, actual = 0, diceById = {};
          al.forEach(function (id) { actual += countMatch(dice[id], value); diceById[id] = dice[id].slice(); });
          var bidTrue = actual >= needed;
          var loser = bidTrue ? challenger : challenged;
          st.reveal = { challenger: challenger, challenged: challenged, value: value, needed: needed, actual: actual, loser: loser, order: al.slice(), dice: diceById };
          counts[loser] = Math.max(0, counts[loser] - 1);
          if (App.Audio) App.Audio.sfx('deal');
          paint();
          after(650, function () { if (App.Audio) App.Audio.sfx(loser === 'me' ? 'bust' : 'ding'); });
          after(REVEAL_MS, function () {
            if (dead) return;
            if (counts[loser] === 0 && loser !== 'me') botsBeaten++;
            var al2 = aliveList(order, counts, present);
            if (counts['me'] <= 0) return endSolo(false);
            if (al2.length <= 1) return endSolo(true);
            var nextStarter = counts[loser] > 0 ? loser : nextAlive(order, counts, present, loser);
            startRound(nextStarter);
          });
        }
        function endSolo(win) {
          if (dead) return;
          var mult = diffKey === 'hard' ? 1.9 : (diffKey === 'medium' ? 1.4 : 1);
          var score = Math.round(((win ? 500 : 0) + botsBeaten * 80 + survived * 10) * mult);
          if (win && App.Scores) { try { App.Scores.winCurrent(); } catch (e) {} }
          if (App.Audio) App.Audio.sfx(win ? 'win' : 'lose');
          var best = App.Storage.get('best_liarsdice', 0), nb = score > best;
          if (nb) App.Storage.set('best_liarsdice', score);
          var dl = diffKey === 'hard' ? 'Schwer' : (diffKey === 'medium' ? 'Mittel' : 'Leicht');
          App.MG.endScreen(root, {
            score: score, best: best, newBest: nb,
            label: dl + ' · ' + (win ? ('Gewonnen — ' + botsBeaten + ' Bots besiegt! 🏆') : 'Ausgeschieden — nächstes Mal!') + (nb ? ' · neuer Rekord!' : ''),
            onExit: ctx.onExit,
            onAgain: function () { startSolo(diffKey); }
          });
        }
        startRound('me');
      }

      /* ======================================================= *
       *  MULTI — Host-koordiniert über room.shared
       * ======================================================= */
      function startMulti() {
        var room = ctx.room, me = ctx.me;
        var minP = App.Minigames.liarsdice.minPlayers || 2;
        var proceeded = false;

        // lokaler Zustand (NICHT im geteilten Zustand!)
        var myDice = null, myRolledRound = -1, reportedRound = -1, survived = 0, lastScore = -1;
        var initDone = false, pendingResolveRound = -1, pendingAdvanceRound = -1;
        var lastShared = null, lastSig = '', built = false, endShown = false;

        function maybeStart() {
          if (proceeded || dead) return;
          var ps = room.players();
          if (ps.length >= minP) { proceeded = true; beginCountdown(); }
          else showWaiting(ps);
        }
        var ph = function () { maybeStart(); };
        room.on('players', ph); stops.push(function () { room.off('players', ph); });
        maybeStart();

        function beginCountdown() {
          var snap = room.snapshot() || {};
          var startAt = (snap.round && snap.round.startAt) || (room.now() + 3000);
          stops.push(App.MG.countdown(root, startAt, function () { startGame(); }, room.now));
        }

        function startGame() {
          buildLayout(); built = true;
          lastShared = (room.snapshot() && room.snapshot().shared) || null;
          var sh1 = function (sh) { if (dead) return; lastShared = sh; sync(); };
          var ph2 = function () { if (dead) return; sync(); };
          room.on('shared', sh1); room.on('players', ph2);
          stops.push(function () { room.off('shared', sh1); room.off('players', ph2); });
          sync();
        }

        function presentSet() { var s = {}; room.players().forEach(function (p) { s[p.id] = true; }); return s; }
        function nameOfFn() { var m = {}; room.players().forEach(function (p) { m[p.id] = p.name; }); return function (id) { return m[id] || 'Spieler'; }; }

        function initShared(players) {
          initDone = true;
          var order = players.map(function (p) { return p.id; });
          var counts = {}; order.forEach(function (id) { counts[id] = START_DICE; });
          room.setShared({ order: order, counts: counts, round: 1, turn: order[0], starter: order[0], bid: null, history: [], phase: 'bidding', reveal: null, chal: null, winner: null });
        }

        function sync() {
          if (dead || !built) return;
          var players = room.players();
          var present = {}; players.forEach(function (p) { present[p.id] = true; });
          var sh = lastShared;
          if (!sh || !sh.order) {
            if (room.isHost() && !initDone) initShared(players);
            if (refs) { refs.statusEl.textContent = '🎲 Würfel werden gemischt …'; refs.statusEl.className = 'lrd-status info'; }
            return;
          }
          var order = sh.order, counts = sh.counts || {};
          var participant = order.indexOf(me.id) >= 0;
          var myCount = counts[me.id] || 0;
          var out = participant && myCount <= 0;
          var spectator = !participant;

          // lokal für neue Runde würfeln
          if (participant && myCount > 0 && sh.round !== myRolledRound) { myDice = rollN(myCount); myRolledRound = sh.round; reportedRound = -1; survived++; }
          if (participant && myCount <= 0) myDice = [];

          // Überlebens-Score melden (nur bei Änderung -> kein Update-Sturm)
          var myScore = (participant ? myCount : 0) * 1000 + survived;
          if (myScore !== lastScore) { lastScore = myScore; try { room.reportScore(myScore); } catch (e) {} }

          // beim Aufdecken die eigenen Würfel melden (genau einmal pro Runde)
          if (sh.phase === 'reveal' && participant && myCount > 0 && reportedRound !== sh.round && myDice) {
            reportedRound = sh.round; try { room.reportState({ dice: myDice, drRound: sh.round }); } catch (e) {}
          }

          if (room.isHost()) hostTick(sh, players, present);

          if (sh.phase === 'gameOver') { showEnd(sh); return; }

          var nameOf = nameOfFn();
          var vm = buildVM({ order: order, counts: counts, present: present, nameOf: nameOf, bid: sh.bid || null, history: sh.history || [], phase: sh.phase, turn: sh.turn, round: sh.round, reveal: sh.reveal || null, myId: me.id, myDice: myDice, spectator: spectator, out: out });
          var sig = sh.phase + '|' + sh.round + '|' + sh.turn + '|' + JSON.stringify(sh.bid || null) + '|' + ((sh.history || []).length) + '|' + JSON.stringify(counts) + '|' + (sh.reveal ? '1' : '0') + '|' + Object.keys(present).sort().join(',');
          if (sig === lastSig) return;   // Heartbeat/Score-Update -> kein Neuaufbau
          lastSig = sig;
          updateView(vm, { onBid: onBid, onChallenge: onChallenge });
        }

        /* ---- Host: Aufdecken auswerten + Runden weiterschalten ---- */
        function hostTick(sh, players, present) {
          var order = sh.order, counts = sh.counts || {};
          var al = aliveList(order, counts, present);
          if (sh.phase === 'bidding') {
            if (al.length <= 1) { room.setShared({ phase: 'gameOver', winner: al[0] || null }); return; }
            if (al.indexOf(sh.turn) < 0) { var nt = nextAlive(order, counts, present, sh.turn); if (nt !== sh.turn) room.setShared({ turn: nt }); }
            return;
          }
          if (sh.phase === 'reveal' && !sh.reveal) {
            if (pendingResolveRound === sh.round) return;
            var ready = true;
            al.forEach(function (id) { var p = playerById(players, id); if (!(p && p.state && p.state.drRound === sh.round && p.state.dice)) ready = false; });
            if (!ready) return;
            pendingResolveRound = sh.round;
            resolveReveal(sh, players, al);
            return;
          }
          if (sh.phase === 'roundEnd' && sh.reveal) {
            if (pendingAdvanceRound === sh.round) return;
            pendingAdvanceRound = sh.round;
            after(REVEAL_MS, function () { if (!dead) advance(sh.round); });
            return;
          }
        }
        function resolveReveal(sh, players, al) {
          var value = sh.bid.value, needed = sh.bid.count, actual = 0, diceById = {};
          al.forEach(function (id) { var p = playerById(players, id); var dl = (p && p.state && p.state.dice) || []; diceById[id] = dl; actual += countMatch(dl, value); });
          var bidTrue = actual >= needed;
          var challenger = sh.chal ? sh.chal.challenger : null;
          var challenged = sh.chal ? sh.chal.challenged : sh.bid.by;
          var loser = bidTrue ? challenger : challenged;
          var counts = assign({}, sh.counts); counts[loser] = Math.max(0, (counts[loser] || 0) - 1);
          if (App.Audio) App.Audio.sfx('deal');
          room.setShared({ phase: 'roundEnd', counts: counts, reveal: { value: value, needed: needed, actual: actual, loser: loser, challenger: challenger, challenged: challenged, order: al.slice(), dice: diceById } });
        }
        function advance(roundNo) {
          var sh = lastShared; if (!sh || sh.round !== roundNo || sh.phase !== 'roundEnd') return;
          var players = room.players(), present = {}; players.forEach(function (p) { present[p.id] = true; });
          var order = sh.order, counts = sh.counts || {};
          var al = aliveList(order, counts, present);
          if (al.length <= 1) { room.setShared({ phase: 'gameOver', winner: al[0] || null }); return; }
          var loser = sh.reveal ? sh.reveal.loser : null;
          var nextStarter = (loser && counts[loser] > 0 && present[loser]) ? loser : nextAlive(order, counts, present, loser || sh.turn);
          room.setShared({ round: sh.round + 1, turn: nextStarter, starter: nextStarter, bid: null, history: [], phase: 'bidding', reveal: null, chal: null });
        }

        /* ---- Aktionen des lokalen Spielers ---- */
        function onBid(count, value) {
          var sh = lastShared; if (dead || !sh || sh.phase !== 'bidding' || sh.turn !== me.id) return;
          if (!isHigher({ count: count, value: value }, sh.bid || null)) return;
          var total = sumCounts(sh.order, sh.counts || {}, presentSet());
          if (count > total) return;
          var hist = (sh.history || []).slice(); hist.push({ by: me.id, count: count, value: value });
          var nt = nextAlive(sh.order, sh.counts || {}, presentSet(), me.id);
          if (App.Audio) App.Audio.sfx('chip');
          room.setShared({ bid: { count: count, value: value, by: me.id }, history: hist, turn: nt });
        }
        function onChallenge() {
          var sh = lastShared; if (dead || !sh || sh.phase !== 'bidding' || sh.turn !== me.id || !sh.bid) return;
          if (App.Audio) App.Audio.sfx('whoosh');
          room.setShared({ phase: 'reveal', chal: { challenger: me.id, challenged: sh.bid.by } });
        }

        /* ---- Warte- und End-Ansichten ---- */
        function showWaiting(ps) {
          root.innerHTML = '';
          root.appendChild(el('div', { class: 'lrd-wait glass' }, [
            el('div', { class: 'lrd-wait-emoji' }, ['🎲']),
            el('h3', { class: 'neon' }, ['Lügen-Würfel']),
            el('p', { class: 'hint-text' }, ['Warte auf Mitspieler … (' + ps.length + ')']),
            el('div', { class: 'controls-row' }, [el('button', { class: 'btn btn-ghost', type: 'button', onclick: ctx.onExit }, ['Zurück zur Lobby'])])
          ]));
        }
        function showEnd(sh) {
          if (endShown) return; endShown = true;
          var iWon = sh.winner === me.id;
          if (iWon && App.Scores) { try { App.Scores.winCurrent(); } catch (e) {} }
          if (App.Audio) App.Audio.sfx(iWon ? 'win' : 'lose');
          after(400, function () { App.MG.endScreen(root, { players: room.players(), meId: me.id, onExit: ctx.onExit }); });
        }
      }
    }
  };

  /* ===================== STYLES ===================== */
  function injectStyle() {
    UI.injectStyle('mg-liarsdice-css', [
      '.lrd-wrap{display:flex;flex-direction:column;gap:12px;max-width:600px;margin:0 auto;}',
      '.lrd-top{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 16px;}',
      '.lrd-brand{font-weight:900;font-size:clamp(16px,4.5vw,20px);}',
      '.lrd-top-r{display:flex;flex-direction:column;align-items:flex-end;line-height:1.2;}',
      '.lrd-round{font-weight:900;color:var(--leaf);font-size:14px;}',
      '.lrd-total{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;}',
      '.lrd-status{text-align:center;font-weight:900;font-size:clamp(15px,4.2vw,19px);min-height:24px;transition:color .15s;}',
      '.lrd-status.you{color:var(--neon);text-shadow:0 0 10px rgba(57,255,20,.4);}',
      '.lrd-status.opp{color:var(--aqua);}',
      '.lrd-status.info{color:var(--aqua-soft);}',
      '.lrd-status.win{color:var(--gold);}',
      '.lrd-status.lose{color:var(--danger);}',
      '.lrd-players{display:flex;flex-wrap:wrap;gap:8px;justify-content:center;}',
      '.lrd-pl{flex:1 1 120px;min-width:106px;max-width:180px;display:flex;flex-direction:column;align-items:center;gap:5px;padding:9px 8px;border-radius:14px;background:rgba(9,32,21,.6);border:1px solid var(--stroke);transition:.18s;}',
      '.lrd-pl.me{border-color:var(--aqua);}',
      '.lrd-pl.turn{border-color:var(--neon);box-shadow:0 0 0 1px var(--neon),0 0 18px rgba(57,255,20,.35);}',
      '.lrd-pl.out{opacity:.45;filter:grayscale(.5);}',
      '.lrd-pl.absent{opacity:.5;}',
      '.lrd-pl-name{font-weight:800;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%;}',
      '.lrd-pl.me .lrd-pl-name{color:var(--aqua);}',
      '.lrd-backs{display:flex;flex-wrap:wrap;gap:3px;justify-content:center;min-height:20px;}',
      '.lrd-back{font-size:15px;filter:drop-shadow(0 0 4px rgba(57,255,20,.35));}',
      '.lrd-outx{color:var(--danger);font-weight:900;font-size:18px;}',
      '.lrd-pl-cnt{font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;}',
      '.lrd-pl.turn .lrd-pl-cnt{color:var(--neon);}',
      '.lrd-bidbar{display:flex;flex-direction:column;align-items:center;gap:2px;padding:12px;text-align:center;}',
      '.lrd-bid-main{display:flex;align-items:center;gap:8px;}',
      '.lrd-bid-n{font-size:clamp(20px,6vw,30px);font-weight:900;color:var(--gold);text-shadow:0 0 12px rgba(255,210,63,.4);}',
      '.lrd-bid-face{font-size:clamp(30px,9vw,46px);line-height:1;color:#eaffe0;filter:drop-shadow(0 0 8px rgba(57,255,20,.5));}',
      '.lrd-bid-by{font-size:12px;color:var(--muted);}',
      '.lrd-bid-empty{color:var(--muted);font-weight:700;}',
      '.lrd-rv{padding:14px;display:flex;flex-direction:column;gap:10px;border:1px solid var(--stroke-2);animation:lrd-pop .3s ease;}',
      '.lrd-rv-head{text-align:center;display:flex;flex-direction:column;gap:3px;}',
      '.lrd-rv-title{font-weight:900;font-size:20px;color:var(--gold);text-shadow:0 0 12px rgba(255,210,63,.4);}',
      '.lrd-rv-claim{font-size:13px;color:var(--aqua-soft);}',
      '.lrd-rv-count{font-size:14px;color:var(--leaf);}',
      '.lrd-rv-count b{color:var(--gold);font-size:18px;}',
      '.lrd-rv-rows{display:flex;flex-direction:column;gap:6px;}',
      '.lrd-rv-row{display:flex;align-items:center;gap:8px;padding:5px 8px;border-radius:10px;background:rgba(4,16,10,.5);}',
      '.lrd-rv-row.me{border:1px solid var(--aqua);}',
      '.lrd-rv-nm{font-size:12px;font-weight:800;flex:0 0 88px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--muted);}',
      '.lrd-rv-dice{display:flex;flex-wrap:wrap;gap:4px;}',
      '.lrd-rv-die{font-size:24px;line-height:1;opacity:.5;}',
      '.lrd-rv-die.match{opacity:1;color:var(--neon);text-shadow:0 0 10px rgba(57,255,20,.6);}',
      '.lrd-rv-die.joker.match{color:var(--gold);text-shadow:0 0 10px rgba(255,210,63,.6);}',
      '.lrd-rv-verdict{text-align:center;font-weight:800;font-size:13px;color:#fff;}',
      '.lrd-hand{display:flex;flex-direction:column;align-items:center;gap:8px;padding:14px;min-height:70px;}',
      '.lrd-hand-label{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:2px;}',
      '.lrd-hand-row{display:flex;flex-wrap:wrap;gap:8px;justify-content:center;}',
      '.lrd-die{line-height:1;}',
      '.lrd-mydie{font-size:clamp(34px,10vw,54px);color:#eaffe0;filter:drop-shadow(0 2px 6px rgba(0,0,0,.5));transition:transform .1s;}',
      '.lrd-mydie.joker{color:var(--gold);text-shadow:0 0 14px rgba(255,210,63,.6);}',
      '.lrd-mydie.lrd-spin{animation:lrd-spin .18s linear infinite;}',
      '@keyframes lrd-spin{0%{transform:rotate(-12deg) scale(.9)}50%{transform:rotate(12deg) scale(1.05)}100%{transform:rotate(-12deg) scale(.9)}}',
      '.lrd-hand-empty{color:var(--muted);font-weight:700;padding:8px;text-align:center;}',
      '.lrd-controls{display:flex;flex-direction:column;gap:10px;padding:12px;border-radius:16px;background:rgba(6,24,16,.6);border:1px solid var(--stroke);}',
      '.lrd-ctl-row{display:flex;align-items:center;justify-content:center;gap:12px;flex-wrap:wrap;}',
      '.lrd-stepper{display:flex;align-items:center;gap:6px;}',
      '.lrd-step{min-width:44px;font-size:22px;font-weight:900;padding:6px 0;}',
      '.lrd-countbox{display:flex;align-items:center;gap:5px;min-width:104px;justify-content:center;padding:4px 10px;border-radius:12px;background:rgba(4,16,10,.7);border:1px solid var(--stroke-2);}',
      '.lrd-count{font-size:26px;font-weight:900;color:var(--gold);font-variant-numeric:tabular-nums;}',
      '.lrd-x{color:var(--muted);font-weight:900;}',
      '.lrd-prevface{font-size:30px;line-height:1;color:#eaffe0;}',
      '.lrd-values{display:flex;gap:6px;flex-wrap:wrap;justify-content:center;}',
      '.lrd-valbtn{width:46px;height:46px;font-size:26px;line-height:1;display:flex;align-items:center;justify-content:center;border-radius:12px;background:rgba(4,16,10,.7);border:2px solid var(--stroke);color:var(--silver);cursor:pointer;font-family:inherit;transition:.12s;-webkit-tap-highlight-color:transparent;}',
      '.lrd-valbtn:hover{border-color:var(--neon);}',
      '.lrd-valbtn.sel{border-color:var(--neon);background:rgba(57,255,20,.14);color:#eaffe0;box-shadow:0 0 12px rgba(57,255,20,.35);}',
      '.lrd-ctl-btns{display:flex;gap:10px;justify-content:center;}',
      '.lrd-bidbtn,.lrd-chalbtn{flex:1;max-width:220px;}',
      '.lrd-hist-wrap{background:rgba(6,24,16,.4);border-radius:12px;padding:2px 12px;border:1px solid var(--stroke);}',
      '.lrd-hist-wrap summary{cursor:pointer;font-size:12px;color:var(--muted);font-weight:800;padding:6px 0;text-transform:uppercase;letter-spacing:1px;}',
      '.lrd-history{display:flex;flex-direction:column;gap:3px;max-height:150px;overflow-y:auto;padding-bottom:6px;}',
      '.lrd-hrow{display:flex;justify-content:space-between;gap:10px;font-size:12px;color:var(--leaf);padding:2px 0;border-bottom:1px solid rgba(57,255,20,.08);}',
      '.lrd-hn{color:var(--muted);}',
      '.lrd-rules{text-align:center;font-size:11.5px;line-height:1.5;}',
      '.lrd-wait{padding:40px;text-align:center;display:flex;flex-direction:column;gap:10px;align-items:center;max-width:440px;margin:0 auto;}',
      '.lrd-wait-emoji{font-size:52px;animation:lrd-bob 1.6s ease-in-out infinite;filter:drop-shadow(0 0 14px rgba(57,255,20,.5));}',
      '@keyframes lrd-bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-8px)}}',
      '@keyframes lrd-pop{0%{transform:scale(.9);opacity:0}100%{transform:scale(1);opacity:1}}',
      '.lrd-diff{padding:28px 22px;text-align:center;display:flex;flex-direction:column;gap:12px;align-items:center;max-width:460px;margin:0 auto;}',
      '.lrd-diff-emoji{font-size:52px;animation:lrd-bob 2s ease-in-out infinite;}',
      '.lrd-diff-btns{display:flex;flex-direction:column;gap:10px;width:100%;}',
      '.lrd-diff-btn{display:flex;flex-direction:column;gap:2px;padding:14px;align-items:flex-start;text-align:left;border:1px solid var(--stroke);background:rgba(9,32,21,.6);}',
      '.lrd-diff-btn:hover{border-color:var(--neon);transform:translateY(-2px);}',
      '.lrd-diff-t{font-weight:900;font-size:16px;color:#eaffe0;}',
      '.lrd-diff-d{font-size:12px;color:var(--muted);}',
      '.lrd-easy:hover{box-shadow:0 0 16px rgba(57,255,20,.3);}',
      '.lrd-medium:hover{box-shadow:0 0 16px rgba(51,230,208,.3);}',
      '.lrd-hard:hover{box-shadow:0 0 16px rgba(255,77,109,.35);}'
    ].join(''));
  }
})();
