/* oddoneout.js — "Finde den Fehler": Odd-One-Out im Neon-Dschungel.
 *
 * IDEE      Ein Raster aus identischen Kacheln — nur EINE weicht minimal ab
 *           (leicht andere Farbe oder ein ganz ähnliches Emoji). So schnell
 *           wie möglich die Ausreisser-Kachel antippen, dann kommt sofort die
 *           nächste Runde: Raster wird grösser, Unterschied kleiner.
 * STEUERUNG Nur Tippen/Klicken (pointerdown) — funktioniert auf Maus + Touch.
 * PUNKTE    Treffer = Grundwert (60 + 8·Runde) + Tempobonus (bis ~325, je
 *           schneller desto mehr), alles mal Combo (x1.0 … x2.0, +0.1 je
 *           Treffer in Folge). Danebengetippt = −50 Punkte, Combo weg und
 *           ~0,8 s Sperre. Gespielt wird 60 Sekunden.
 * SOLO      Rekordjagd (App.Storage 'best_oddoneout') gegen drei Bots mit
 *           unterschiedlichen Stufen (Faultier / Kolibri / Luchs). Die Bots
 *           "suchen" mit einer Denkzeit, die von Rasterfläche, Rundennummer
 *           und ihrer Skill-Stufe abhängt, und vertippen sich auch mal.
 * MULTI     Alle starten synchron (round.startAt aus dem Room-Snapshot).
 *           Genau dieses startAt ist der Seed für den deterministischen
 *           Zufall → jeder bekommt in Runde N exakt dasselbe Raster (fair).
 *           Punkte laufen per room.reportScore in die Live-Rangliste, am
 *           Ende Podest via App.MG.endScreen.
 * SYNC      Kein Host-Zustand nötig: gleiche Seed-Funktion auf jedem Gerät.
 *           Alle Timer laufen über Wall-Clock (room.now / Date.now) →
 *           Tab-Wechsel-sicher, keine Frame-Zählerei.
 */
(function () {
  'use strict';
  window.App = window.App || {}; App.Minigames = App.Minigames || {};
  var UI = App.UI, el = UI.el;

  injectStyle();

  /* ---------- deterministischer Zufall (mulberry32) ---------- */
  function rngFrom(seed) {
    var a = seed | 0;
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  /* Seed + Rundennummer → eigener, stabiler Zufallsstrom pro Runde. */
  function roundRng(seed, level) {
    var h = (seed | 0) ^ Math.imul(level + 1, 0x9E3779B1);
    h = Math.imul(h ^ (h >>> 13), 0x85EBCA6B);
    return rngFrom(h ^ (h >>> 16));
  }

  /* ---------- Emoji-Paare nach Ähnlichkeit (0 = leicht … 2 = fies) ---------- */
  var EMOJI_TIERS = [
    [['🍏', '🍎'], ['🐸', '🐢'], ['🌞', '🌝'], ['🔵', '🟣'], ['🍋', '🍊'], ['🐝', '🐞']],
    [['🌿', '🍀'], ['🐱', '🐶'], ['⭐', '🌟'], ['🍒', '🍓'], ['🌊', '💧'], ['🦎', '🐊']],
    [['😀', '😃'], ['😺', '😸'], ['🙂', '😊'], ['🌑', '🌚'], ['🐇', '🐰'], ['🥝', '🥑']]
  ];

  /* ---------- Runden-Rezept (nur aus Seed + Level → überall gleich) ---------- */
  function makeRound(seed, level) {
    var r = roundRng(seed, level);
    var size = Math.min(8, 3 + Math.floor((level - 1) / 2));
    var cells = size * size;
    var oddIndex = Math.floor(r() * cells);
    if (oddIndex >= cells) oddIndex = cells - 1;
    var round = { level: level, size: size, cells: cells, oddIndex: oddIndex };

    if (level % 3 === 0) {
      /* Emoji-Runde: ähnliches Paar, mit steigender Runde fieser */
      var tier = level < 5 ? 0 : (level < 10 ? 1 : 2);
      var pool = EMOJI_TIERS[tier];
      var pair = pool[Math.floor(r() * pool.length) % pool.length];
      var flip = r() < 0.5;
      round.type = 'emoji';
      round.base = flip ? pair[1] : pair[0];
      round.odd = flip ? pair[0] : pair[1];
      round.label = 'Emoji';
    } else {
      /* Farb-Runde: Unterschied schrumpft exponentiell mit dem Level */
      var h = Math.floor(r() * 360);
      var s = 52 + Math.floor(r() * 26);
      var l = 44 + Math.floor(r() * 16);
      var fade = Math.pow(0.86, level - 1);
      var dh = Math.max(4, 42 * fade) * (r() < 0.5 ? -1 : 1);
      var dl = Math.max(1.8, 15 * fade) * (r() < 0.5 ? -1 : 1);
      round.type = 'color';
      round.base = hsl(h, s, l);
      round.odd = hsl((h + dh + 360) % 360, s, clamp(l + dl, 12, 88));
      round.label = 'Farbe';
    }
    return round;
  }
  function hsl(h, s, l) { return 'hsl(' + Math.round(h) + ',' + Math.round(s) + '%,' + Math.round(l * 10) / 10 + '%)'; }
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

  /* ---------- gemeinsame Punkteformel (Spieler wie Bots) ---------- */
  function scoreFor(level, ms, combo) {
    var base = 60 + level * 8;
    var bonus = Math.max(0, Math.round((2600 - ms) / 8));
    return Math.round((base + bonus) * combo);
  }
  var PENALTY = 50, LOCK_MS = 800, DURATION = 60;

  App.Minigames.oddoneout = {
    id: 'oddoneout', title: 'Finde den Fehler', icon: '🔍', order: 170,
    subtitle: 'Eine Kachel ist anders – finde sie sofort!',
    single: true, multi: true, minPlayers: 2, maxPlayers: 8,

    render: function (root, ctx) {
      var isMulti = ctx.mode === 'multi';
      var nowFn = isMulti ? ctx.room.now : function () { return Date.now(); };
      var perf = (window.performance && performance.now)
        ? function () { return performance.now(); }
        : function () { return Date.now(); };

      var dead = false;
      var stops = [];      // stop()-Funktionen (App.MG-Bausteine, Listener, Intervalle)
      var pending = [];    // laufende setTimeout-IDs

      /* Spielzustand */
      var score = 0, combo = 1, level = 1, hits = 0, misses = 0, bestMs = Infinity;
      var round = null, shownAt = 0, locked = false, finished = false, seed = 0;

      /* DOM */
      var stage, board, scoreEl, comboEl, timerEl, infoEl, statHits, statBest, flash;
      var bots = [], botTick = null, boardList = null;

      function after(ms, fn) { var t = setTimeout(function () { if (!dead) fn(); }, ms); pending.push(t); return t; }
      function clearPending() { pending.forEach(clearTimeout); pending = []; }
      function stopHelpers() { stops.forEach(function (f) { try { f(); } catch (e) {} }); stops = []; }
      function cleanup() { dead = true; clearPending(); stopHelpers(); }

      /* ---- Start: im Multi exakt nach dem Muster aus reflex.js ---- */
      if (isMulti) {
        var snap = ctx.room.snapshot() || {};
        var startAt = (snap.round && snap.round.startAt) || (ctx.room.now() + 3000);
        stops.push(App.MG.countdown(root, startAt, function () { play(startAt); }, ctx.room.now));
      } else {
        play(Date.now());
      }
      return { cleanup: cleanup };

      /* ===================== SPIEL ===================== */
      function play(startAt) {
        clearPending(); stopHelpers();
        score = 0; combo = 1; level = 1; hits = 0; misses = 0; bestMs = Infinity;
        locked = false; finished = false;
        seed = startAt | 0;                       // im Multi bei allen identisch
        var endAt = startAt + DURATION * 1000;

        /* --- Kopfzeile --- */
        scoreEl = el('div', { class: 'odd-score' }, ['0']);
        comboEl = el('div', { class: 'odd-combo' }, ['x1.0']);
        timerEl = el('div', { class: 'mg-timer' }, [App.MG.mmss(DURATION)]);
        var head = el('div', { class: 'odd-head glass' }, [
          el('div', { class: 'odd-head-cell' }, [el('span', { class: 'odd-head-l' }, ['Punkte']), scoreEl]),
          el('div', { class: 'odd-head-cell odd-head-mid' }, [el('span', { class: 'odd-head-l' }, ['Combo']), comboEl]),
          el('div', { class: 'odd-head-cell odd-head-right' }, [el('span', { class: 'odd-head-l' }, ['Zeit']), timerEl])
        ]);

        /* --- Spielfläche --- */
        infoEl = el('div', { class: 'odd-info' }, ['Runde 1 · 3×3 · Farbe']);
        board = el('div', { class: 'odd-board' });
        flash = el('div', { class: 'odd-flash' }, ['']);
        stage = el('div', { class: 'odd-stage glass' }, [infoEl, board, flash]);

        /* --- Statistik --- */
        statHits = el('div', { class: 'odd-stat-v' }, ['0']);
        statBest = el('div', { class: 'odd-stat-v' }, ['–']);
        var stats = el('div', { class: 'odd-stats glass' }, [
          el('div', { class: 'odd-stat' }, [el('div', { class: 'odd-stat-l' }, ['🎯 Treffer']), statHits]),
          el('div', { class: 'odd-stat' }, [el('div', { class: 'odd-stat-l' }, ['⚡ Schnellste']), statBest])
        ]);

        var hint = el('p', { class: 'hint-text odd-hint' }, [
          '🔍 Tippe die Kachel, die anders ist – je schneller, desto mehr Punkte. Daneben = −' + PENALTY + ' und kurze Sperre.'
        ]);

        /* --- Rangliste: Multi live aus dem Room, Solo gegen Bots --- */
        var boardWrap = null;
        if (isMulti) {
          var lb = App.MG.liveBoard(ctx.room, ctx.me.id);
          stops.push(lb.stop);
          boardWrap = el('div', { class: 'odd-board-wrap glass' }, [
            el('div', { class: 'mg-field-title' }, ['🏆 Rangliste']), lb.root
          ]);
          boardList = null;
        } else {
          boardList = el('div', { class: 'mg-scoreboard' });
          boardWrap = el('div', { class: 'odd-board-wrap glass' }, [
            el('div', { class: 'mg-field-title' }, ['🏆 Jagd auf die Bots']), boardList
          ]);
        }

        root.innerHTML = '';
        root.appendChild(el('div', { class: 'odd-layout' }, [head, stage, stats, hint, boardWrap]));

        if (isMulti) {
          ctx.room.reportScore(0);
        } else {
          setupBots(startAt);
          renderSoloBoard();
        }

        /* --- Rundentimer (Wall-Clock) --- */
        var tnf = isMulti ? ctx.room.now : null;
        stops.push(App.MG.roundTimer(endAt, function (left) {
          timerEl.textContent = App.MG.mmss(left);
          if (left <= 10) timerEl.classList.add('odd-urgent'); else timerEl.classList.remove('odd-urgent');
        }, finish, tnf));

        newRound();
      }

      /* ---------- Raster aufbauen ---------- */
      function newRound() {
        if (dead || finished) return;
        round = makeRound(seed, level);
        board.innerHTML = '';
        board.className = 'odd-board';
        void board.offsetWidth;               // Reflow → Einblend-Animation startet neu
        board.classList.add('odd-in');
        board.style.gridTemplateColumns = 'repeat(' + round.size + ', 1fr)';
        var fsize = round.type === 'emoji'
          ? 'font-size:clamp(11px,' + (52 / round.size).toFixed(1) + 'vw,' + Math.round(260 / round.size) + 'px);'
          : '';
        var i;
        for (i = 0; i < round.cells; i++) {
          var isOdd = i === round.oddIndex;
          var val = isOdd ? round.odd : round.base;
          var style = fsize + (round.type === 'color' ? 'background:' + val + ';' : '');
          var cell = el('button', {
            class: 'odd-cell odd-cell-' + round.type, type: 'button',
            style: style, 'aria-label': 'Kachel ' + (i + 1),
            dataset: { i: String(i) }
          }, [round.type === 'emoji' ? val : '']);
          cell.addEventListener('pointerdown', onCellDown);
          board.appendChild(cell);
        }
        infoEl.textContent = 'Runde ' + level + ' · ' + round.size + '×' + round.size + ' · ' + round.label;
        shownAt = perf();
        locked = false;
        board.classList.remove('odd-locked');
      }

      /* ---------- Eingabe ---------- */
      function onCellDown(e) {
        if (e && e.preventDefault) e.preventDefault();
        if (dead || finished || locked || !round) return;
        var cell = e.currentTarget;
        var idx = parseInt(cell.dataset.i, 10);
        if (idx === round.oddIndex) hit(cell);
        else miss(cell);
      }

      function hit(cell) {
        var ms = Math.max(0, Math.round(perf() - shownAt));
        var pts = scoreFor(level, ms, combo);
        score += pts; hits++;
        if (ms < bestMs) bestMs = ms;
        combo = Math.min(2, Math.round((combo + 0.1) * 10) / 10);
        locked = true;

        cell.classList.add('odd-hit');
        popAt(cell, '+' + pts, 'odd-pop-good');
        bump(scoreEl); scoreEl.textContent = App.MG.fmt(score);
        comboEl.textContent = 'x' + combo.toFixed(1);
        comboEl.classList.toggle('odd-combo-hot', combo >= 1.5);
        bump(comboEl);
        statHits.textContent = String(hits);
        statBest.textContent = bestMs + ' ms';
        if (App.Audio) { App.Audio.sfx('point'); if (combo >= 1.8) App.Audio.blip(880, 0.06); }
        if (isMulti) ctx.room.reportScore(score);

        level++;
        after(150, newRound);
      }

      function miss(cell) {
        misses++;
        score = Math.max(0, score - PENALTY);
        combo = 1;
        locked = true;

        cell.classList.add('odd-wrong');
        popAt(cell, '−' + PENALTY, 'odd-pop-bad');
        scoreEl.textContent = App.MG.fmt(score);
        comboEl.textContent = 'x1.0';
        comboEl.classList.remove('odd-combo-hot');
        board.classList.add('odd-locked');
        showFlash('Daneben! −' + PENALTY);
        if (App.Audio) App.Audio.sfx('error');
        if (isMulti) ctx.room.reportScore(score);

        after(LOCK_MS, function () {
          if (dead || finished || !round) return;
          cell.classList.remove('odd-wrong');
          board.classList.remove('odd-locked');
          hideFlash();
          locked = false;
          /* Zeitmessung läuft weiter — die Strafe kostet also auch Tempobonus. */
        });
      }

      /* ---------- kleine Effekte ---------- */
      function bump(node) {
        if (!node) return;
        node.classList.remove('odd-bump'); void node.offsetWidth; node.classList.add('odd-bump');
      }
      function popAt(cell, text, cls) {
        if (!stage || !board) return;
        var x = board.offsetLeft + cell.offsetLeft + cell.offsetWidth / 2;
        var y = board.offsetTop + cell.offsetTop + cell.offsetHeight / 2;
        var pop = el('span', { class: 'odd-pop ' + cls, style: 'left:' + x + 'px;top:' + y + 'px;' }, [text]);
        stage.appendChild(pop);
        after(760, function () { if (pop.parentNode) pop.parentNode.removeChild(pop); });
      }
      function showFlash(t) { if (flash) { flash.textContent = t; flash.classList.add('on'); } }
      function hideFlash() { if (flash) flash.classList.remove('on'); }

      /* ===================== SOLO-BOTS ===================== */
      /* Jeder Bot sucht mit einer Denkzeit aus Rasterfläche, Rundennummer und
         Skill (0..1) und vertippt sich gelegentlich — genau wie ein Mensch. */
      function setupBots(startAt) {
        var r = rngFrom((startAt | 0) ^ 0x5bf03635);
        bots = [
          { name: '🦥 Faultier', skill: 0.34 },
          { name: '🐦 Kolibri', skill: 0.62 },
          { name: '🐆 Luchs', skill: 0.86 }
        ].map(function (b) {
          b.score = 0; b.combo = 1; b.level = 1; b.rng = rngFrom(Math.floor(r() * 1e9));
          b.nextAt = 0; b.plannedMs = 0; b.willMiss = false;
          schedule(b, startAt);
          return b;
        });
        botTick = setInterval(function () {
          if (dead || finished) return;
          var now = Date.now(), changed = false;
          bots.forEach(function (b) {
            while (!finished && now >= b.nextAt) {
              if (b.willMiss) {
                b.score = Math.max(0, b.score - PENALTY);
                b.combo = 1;
                schedule(b, b.nextAt + LOCK_MS);      // Strafe kostet den Bot auch Zeit
              } else {
                b.score += scoreFor(b.level, b.plannedMs, b.combo);
                b.combo = Math.min(2, Math.round((b.combo + 0.1) * 10) / 10);
                b.level++;
                schedule(b, b.nextAt);
              }
              changed = true;
            }
          });
          if (changed) renderSoloBoard();
        }, 120);
        stops.push(function () { if (botTick) clearInterval(botTick); botTick = null; });
      }
      function schedule(b, fromMs) {
        var size = Math.min(8, 3 + Math.floor((b.level - 1) / 2));
        var cells = size * size;
        var think = (240 + cells * (34 - 22 * b.skill)) * (1 + b.level * 0.05) * (0.75 + b.rng() * 0.55);
        var missP = Math.min(0.34, 0.05 + (1 - b.skill) * 0.14 + b.level * 0.008);
        b.willMiss = b.rng() < missP;
        b.plannedMs = Math.round(think);
        b.nextAt = fromMs + b.plannedMs;
      }
      function soloRanking() {
        var rows = [{ name: App.Leaderboard ? App.Leaderboard.getPlayerName() : 'Du', score: score, me: true }];
        bots.forEach(function (b) { rows.push({ name: b.name, score: b.score, me: false }); });
        rows.sort(function (a, b) { return b.score - a.score; });
        return rows;
      }
      function renderSoloBoard() {
        if (!boardList) return;
        var rows = soloRanking();
        boardList.innerHTML = '';
        rows.forEach(function (p, i) {
          boardList.appendChild(el('div', { class: 'mg-sb-row p' + (i + 1) + (p.me ? ' me' : '') }, [
            el('span', { class: 'mg-sb-rank' }, ['' + (i + 1)]),
            el('span', { class: 'mg-sb-name' }, [p.name + (p.me ? ' (du)' : '')]),
            el('span', { class: 'mg-sb-score' }, [App.MG.fmt(p.score)])
          ]));
        });
      }

      /* ===================== ENDE ===================== */
      function finish() {
        if (finished || dead) return;
        finished = true;
        locked = true;
        clearPending();
        stopHelpers();
        if (App.Audio) App.Audio.sfx('whoosh');

        if (isMulti) {
          ctx.room.reportScore(score);
          after(900, function () {
            App.MG.endScreen(root, { players: ctx.room.players(), meId: ctx.me.id, onExit: ctx.onExit });
          });
        } else {
          var rows = soloRanking();
          var place = 1;
          rows.forEach(function (p, i) { if (p.me) place = i + 1; });
          var best = App.Storage.get('best_oddoneout', 0);
          var nb = score > best;
          if (nb) App.Storage.set('best_oddoneout', score);
          if (App.Audio) App.Audio.sfx(place === 1 ? 'win' : 'lose');
          var label = 'Platz ' + place + ' von ' + rows.length + ' · ' + hits + ' Treffer, ' + misses + ' daneben'
            + (nb ? ' · neuer Rekord! 🎉' : ' · Bestwert: ' + App.MG.fmt(best));
          App.MG.endScreen(root, {
            score: score, best: best, newBest: nb, label: label,
            onExit: ctx.onExit,
            onAgain: function () { finished = false; play(Date.now()); }
          });
        }
      }
    }
  };

  /* ===================== STYLES ===================== */
  function injectStyle() {
    UI.injectStyle('mg-oddoneout-css', [
      '.odd-layout{display:flex;flex-direction:column;gap:12px;}',
      /* Kopfzeile */
      '.odd-head{display:flex;justify-content:space-between;align-items:center;padding:11px 18px;gap:12px;}',
      '.odd-head-cell{display:flex;flex-direction:column;gap:2px;min-width:0;}',
      '.odd-head-mid{text-align:center;}',
      '.odd-head-right{text-align:right;}',
      '.odd-head-l{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:1px;}',
      '.odd-score{font-size:clamp(22px,5.5vw,36px);font-weight:900;color:var(--gold);line-height:1;',
      'text-shadow:0 0 12px rgba(255,210,63,.45);font-variant-numeric:tabular-nums;}',
      '.odd-combo{font-size:clamp(18px,4.5vw,28px);font-weight:900;color:var(--aqua);line-height:1;',
      'font-variant-numeric:tabular-nums;transition:color .2s,text-shadow .2s;}',
      '.odd-combo-hot{color:var(--neon);text-shadow:0 0 14px rgba(57,255,20,.65);}',
      '.odd-head .mg-timer{font-size:clamp(18px,4.5vw,26px);}',
      '.mg-timer.odd-urgent{color:var(--danger-2);animation:odd-pulse .7s infinite;}',
      /* Spielfläche */
      '.odd-stage{position:relative;padding:14px;display:flex;flex-direction:column;align-items:center;gap:10px;overflow:hidden;}',
      '.odd-info{font-size:12px;font-weight:800;letter-spacing:1px;text-transform:uppercase;color:var(--leaf);',
      'text-shadow:0 0 10px var(--stroke-2);}',
      '.odd-board{display:grid;gap:clamp(3px,1vw,7px);width:100%;max-width:min(86vw,420px);aspect-ratio:1/1;',
      'touch-action:manipulation;transition:opacity .18s,filter .18s;}',
      '.odd-board.odd-in{animation:odd-grid-in .22s cubic-bezier(.2,.8,.3,1) both;}',
      '.odd-board.odd-locked{opacity:.5;filter:grayscale(.5);pointer-events:none;}',
      '.odd-cell{position:relative;border-radius:clamp(6px,1.6vw,12px);border:1px solid rgba(4,16,10,.55);',
      'padding:0;margin:0;font-family:inherit;line-height:1;cursor:pointer;overflow:hidden;',
      'display:flex;align-items:center;justify-content:center;color:#eaffe2;',
      '-webkit-tap-highlight-color:transparent;user-select:none;-webkit-user-select:none;',
      'box-shadow:inset 0 0 0 1px rgba(255,255,255,.06);transition:transform .1s ease,box-shadow .12s ease;}',
      '.odd-cell:active{transform:scale(.94);}',
      '.odd-cell-emoji{background:rgba(9,32,21,.85);border-color:var(--stroke);}',
      '.odd-cell.odd-hit{animation:odd-hit .3s ease both;box-shadow:0 0 22px var(--neon),inset 0 0 0 2px #eaffe2;z-index:2;}',
      '.odd-cell.odd-wrong{animation:odd-shake .3s ease;box-shadow:0 0 20px var(--danger),inset 0 0 0 2px var(--danger);z-index:2;}',
      /* Punkte-Pop + Strafhinweis */
      '.odd-pop{position:absolute;transform:translate(-50%,-50%);font-size:clamp(16px,4vw,24px);font-weight:900;',
      'pointer-events:none;z-index:5;animation:odd-pop .75s cubic-bezier(.2,.8,.3,1) both;font-variant-numeric:tabular-nums;}',
      '.odd-pop-good{color:var(--neon);text-shadow:0 0 12px rgba(57,255,20,.8),0 2px 6px rgba(0,0,0,.6);}',
      '.odd-pop-bad{color:var(--danger-2);text-shadow:0 0 12px rgba(255,77,109,.8),0 2px 6px rgba(0,0,0,.6);}',
      '.odd-flash{position:absolute;left:50%;top:52%;transform:translate(-50%,-50%) scale(.9);opacity:0;',
      'padding:10px 22px;border-radius:14px;background:rgba(60,4,16,.88);border:1px solid var(--danger);',
      'color:#fff;font-weight:900;font-size:clamp(16px,4.4vw,24px);letter-spacing:1px;pointer-events:none;z-index:6;',
      'box-shadow:0 0 30px rgba(255,77,109,.45);transition:opacity .14s ease,transform .14s ease;}',
      '.odd-flash.on{opacity:1;transform:translate(-50%,-50%) scale(1);}',
      /* Statistik + Hinweis + Rangliste */
      '.odd-stats{display:flex;gap:12px;padding:10px 16px;justify-content:space-around;}',
      '.odd-stat{display:flex;flex-direction:column;align-items:center;gap:2px;}',
      '.odd-stat-l{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;}',
      '.odd-stat-v{font-size:clamp(16px,4vw,22px);font-weight:900;color:var(--leaf);font-variant-numeric:tabular-nums;}',
      '.odd-hint{margin:0;text-align:center;}',
      '.odd-board-wrap{padding:13px;display:flex;flex-direction:column;gap:8px;}',
      '.odd-board-wrap .mg-scoreboard{max-height:260px;overflow-y:auto;}',
      '.odd-bump{animation:odd-bump .3s ease;}',
      /* Animationen */
      '@keyframes odd-grid-in{from{opacity:0;transform:scale(.965);}to{opacity:1;transform:scale(1);}}',
      '@keyframes odd-hit{0%{transform:scale(1);}45%{transform:scale(1.22);}100%{transform:scale(1);}}',
      '@keyframes odd-shake{0%,100%{transform:translateX(0);}25%{transform:translateX(-6px);}75%{transform:translateX(6px);}}',
      '@keyframes odd-pop{0%{opacity:0;transform:translate(-50%,-50%) scale(.7);}',
      '25%{opacity:1;transform:translate(-50%,-90%) scale(1.1);}',
      '100%{opacity:0;transform:translate(-50%,-190%) scale(1);}}',
      '@keyframes odd-bump{0%{transform:scale(1);}40%{transform:scale(1.18);}100%{transform:scale(1);}}',
      '@keyframes odd-pulse{0%,100%{opacity:1;}50%{opacity:.4;}}',
      '@media (max-width:520px){.odd-stage{padding:10px;}.odd-board{max-width:min(92vw,420px);}}'
    ].join(''));
  }
})();
