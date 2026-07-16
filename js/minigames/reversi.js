/* reversi.js — "Reversi" (Othello) auf 8x8 im Neon-Dschungel-Look.
 *
 * IDEE      Wer einen Stein so setzt, dass gegnerische Steine in einer geraden
 *           Linie zwischen dem neuen Stein und einem eigenen Stein eingeschlossen
 *           werden, dreht diese Reihen um. Ein Zug ist nur erlaubt, wenn er
 *           mindestens einen Stein dreht. Wer keinen Zug hat, setzt aus (Hinweis
 *           wird angezeigt). Sind beide blockiert oder ist das Brett voll,
 *           gewinnt die Mehrheit der Steine.
 * STEUERUNG Antippen/Klicken eines Feldes mit grünem Punkt (= gültiger Zug).
 *           Die möglichen Züge werden immer nur dem Spieler gezeigt, der dran ist.
 *           Das Umdrehen läuft als 3D-Flip-Animation, gestaffelt vom gesetzten
 *           Stein nach außen.
 * PUNKTE    Live-Steinzähler + Verhältnis-Balken oben.
 *           SOLO:  Punkte = eigene Steine x 10 + Vorsprung x 15 (+400 Sieg / +150
 *                  Remis), mal Stufen-Faktor (Leicht 1 / Mittel 1.7 / Schwer 2.6).
 *                  Bestwert in App.Storage('best_reversi').
 *           MULTI: gemeldete Punktzahl = eigene Steine → Podest am Ende.
 * SOLO      Gegen einen Bot mit Alpha-Beta-Suche + Positionsbewertung (Ecken sehr
 *           wertvoll, Felder neben freien Ecken schlecht, Mobilität, Endspiel =
 *           exakte Steinzahl). 3 Stufen: 🌱 Leicht, 🐆 Mittel, 🐅 Schwer.
 * SYNC      Rundenbasiert über room.shared:
 *           { order:[dunkelId, hellId], board:[64], turn:<playerId>, lastMove,
 *             moveNo, passing:<playerId|null>, over, winner }.
 *           Wer zieht, schreibt das Ergebnis (Brett + nächster Spieler); nur der
 *           Host schaltet nach einem Aussetzer weiter. Alle Handler sind
 *           idempotent (Diff-Rendering), Heartbeat-Events bauen nichts neu auf.
 *           Start-Countdown über room.now() → alle Geräte synchron.
 * cleanup() beendet alle Timeouts und entfernt jeden room.on-Listener. */
(function () {
  'use strict';
  window.App = window.App || {}; App.Minigames = App.Minigames || {};
  var UI = App.UI, el = UI.el;

  injectStyle();

  /* ===================== Konstanten ===================== */
  var DARK = 1, LIGHT = 2;                       // Steinfarben
  var DX = [1, 1, 0, -1, -1, -1, 0, 1];
  var DY = [0, 1, 1, 1, 0, -1, -1, -1];

  /* Klassische Positionsbewertung: Ecken top, Nachbarfelder der Ecken giftig. */
  var WEIGHT = [
    120, -20, 20, 5, 5, 20, -20, 120,
    -20, -40, -5, -5, -5, -5, -40, -20,
    20, -5, 15, 3, 3, 15, -5, 20,
    5, -5, 3, 3, 3, 3, -5, 5,
    5, -5, 3, 3, 3, 3, -5, 5,
    20, -5, 15, 3, 3, 15, -5, 20,
    -20, -40, -5, -5, -5, -5, -40, -20,
    120, -20, 20, 5, 5, 20, -20, 120
  ];
  var CORNERS = [0, 7, 56, 63];
  var CORNER_ADJ = [[1, 8, 9], [6, 14, 15], [48, 49, 57], [54, 55, 62]];

  var LEVELS = {
    leicht: { key: 'leicht', name: 'Leicht', icon: '🌱', desc: 'Frischling — greift oft daneben', depth: 1, rnd: 0.55, mult: 1 },
    mittel: { key: 'mittel', name: 'Mittel', icon: '🐆', desc: 'Jäger — denkt ein paar Züge voraus', depth: 3, rnd: 0.14, mult: 1.7 },
    schwer: { key: 'schwer', name: 'Schwer', icon: '🐅', desc: 'Panther — jagt Ecken und rechnet das Endspiel aus', depth: 4, rnd: 0, mult: 2.6 }
  };
  var LEVEL_ORDER = ['leicht', 'mittel', 'schwer'];
  var NODE_CAP = 260000;                          // Notbremse für die Suche
  var RULES_TEXT = 'Schließe gegnerische Reihen zwischen zwei eigenen Steinen ein — sie drehen sich um. Punkte = mögliche Züge. Kein Zug? Du setzt aus. Am Ende gewinnt die Mehrheit.';

  /* ===================== Brett-Logik ===================== */
  function startBoard() {
    var b = [], i;
    for (i = 0; i < 64; i++) b.push(0);
    b[27] = LIGHT; b[28] = DARK; b[35] = DARK; b[36] = LIGHT;   // d4/e4/d5/e5
    return b;
  }
  function other(c) { return c === DARK ? LIGHT : DARK; }

  /* Liste der Steine, die ein Zug auf idx für Farbe c umdreht (null = ungültig). */
  function flipsAt(board, idx, c) {
    if (board[idx] !== 0) return null;
    var x = idx % 8, y = (idx / 8) | 0, foe = other(c), res = null;
    for (var d = 0; d < 8; d++) {
      var cx = x + DX[d], cy = y + DY[d], buf = null, hit = false;
      while (cx >= 0 && cx < 8 && cy >= 0 && cy < 8) {
        var p = cy * 8 + cx, v = board[p];
        if (v === 0) break;
        if (v === c) { hit = !!buf; break; }
        if (v === foe) { (buf = buf || []).push(p); cx += DX[d]; cy += DY[d]; }
      }
      if (hit && buf) { res = res || []; for (var k = 0; k < buf.length; k++) res.push(buf[k]); }
    }
    return res;
  }
  /* Schnelle Gültigkeitsprüfung ohne Listen-Allokation (für die Suche). */
  function canPlace(board, idx, c) {
    if (board[idx] !== 0) return false;
    var x = idx % 8, y = (idx / 8) | 0, foe = other(c);
    for (var d = 0; d < 8; d++) {
      var cx = x + DX[d], cy = y + DY[d], n = 0;
      while (cx >= 0 && cx < 8 && cy >= 0 && cy < 8) {
        var v = board[cy * 8 + cx];
        if (v === foe) { n++; cx += DX[d]; cy += DY[d]; continue; }
        if (v === c && n > 0) return true;
        break;
      }
    }
    return false;
  }
  function moveList(board, c) {
    var r = [];
    for (var i = 0; i < 64; i++) if (board[i] === 0 && canPlace(board, i, c)) r.push(i);
    return r;
  }
  function countMoves(board, c) {
    var n = 0;
    for (var i = 0; i < 64; i++) if (board[i] === 0 && canPlace(board, i, c)) n++;
    return n;
  }
  function applied(board, idx, c) {
    var nb = board.slice(), f = flipsAt(board, idx, c);
    nb[idx] = c;
    if (f) for (var i = 0; i < f.length; i++) nb[f[i]] = c;
    return nb;
  }
  function counts(board) {
    var o = { d: 0, l: 0, empty: 0 };
    for (var i = 0; i < 64; i++) { var v = board[i]; if (v === DARK) o.d++; else if (v === LIGHT) o.l++; else o.empty++; }
    return o;
  }
  function chebyshev(a, b) {
    if (a < 0 || b < 0) return 0;
    return Math.max(Math.abs((a % 8) - (b % 8)), Math.abs(((a / 8) | 0) - ((b / 8) | 0)));
  }
  /* Brett aus shared robust einlesen (manche Backends liefern Listen als Objekt). */
  function normBoard(raw) {
    if (!raw) return null;
    var b = [], i, v;
    for (i = 0; i < 64; i++) {
      v = raw[i];
      if (v !== 0 && v !== DARK && v !== LIGHT) return null;
      b.push(v);
    }
    return b;
  }

  /* ===================== Bot: Bewertung + Alpha-Beta ===================== */
  var nodes = 0;

  function finalScore(board, me) {
    var c = counts(board), mine = me === DARK ? c.d : c.l, foe = me === DARK ? c.l : c.d;
    if (mine > foe) return 100000 + (mine - foe);
    if (mine < foe) return -100000 - (foe - mine);
    return 0;
  }
  function evaluate(board, me, foe, empty) {
    var mine = 0, theirs = 0, pos = 0, i, v;
    for (i = 0; i < 64; i++) {
      v = board[i];
      if (v === 0) continue;
      if (v === me) { mine++; pos += WEIGHT[i]; } else { theirs++; pos -= WEIGHT[i]; }
    }
    /* Felder neben einer bereits besetzten Ecke sind nicht mehr gefährlich. */
    for (i = 0; i < 4; i++) {
      var ci = CORNERS[i];
      if (board[ci] === 0) continue;
      var adj = CORNER_ADJ[i];
      for (var j = 0; j < 3; j++) {
        var ai = adj[j], av = board[ai];
        if (av === 0) continue;
        var repl = (av === board[ci]) ? 12 : 4;
        pos += (av === me ? 1 : -1) * (repl - WEIGHT[ai]);
      }
    }
    if (empty <= 8) return (mine - theirs) * 140 + pos * 0.2;      // Endspiel: Steine zählen
    var a = countMoves(board, me), b = countMoves(board, foe);
    var mob = (a + b) ? 90 * (a - b) / (a + b) : 0;
    var diff = (mine + theirs) ? 12 * (mine - theirs) / (mine + theirs) : 0;
    return pos + mob + diff;
  }
  /* Zugreihenfolge nach statischem Gewicht → deutlich mehr Alpha-Beta-Schnitte. */
  function ordered(list) {
    return list.slice().sort(function (a, b) { return WEIGHT[b] - WEIGHT[a]; });
  }
  function search(board, cur, me, foe, depth, alpha, beta) {
    nodes++;
    var c = counts(board), empty = c.empty;
    if (empty === 0) return finalScore(board, me);
    if (depth <= 0 || nodes > NODE_CAP) return evaluate(board, me, foe, empty);
    var list = moveList(board, cur);
    if (!list.length) {
      var opp = other(cur);
      if (!countMoves(board, opp)) return finalScore(board, me);      // beide blockiert
      return search(board, opp, me, foe, depth - 1, alpha, beta);      // aussetzen
    }
    list = ordered(list);
    var i, val;
    if (cur === me) {
      var best = -Infinity;
      for (i = 0; i < list.length; i++) {
        val = search(applied(board, list[i], cur), foe, me, foe, depth - 1, alpha, beta);
        if (val > best) best = val;
        if (best > alpha) alpha = best;
        if (alpha >= beta) break;
      }
      return best;
    }
    var worst = Infinity;
    for (i = 0; i < list.length; i++) {
      val = search(applied(board, list[i], cur), me, me, foe, depth - 1, alpha, beta);
      if (val < worst) worst = val;
      if (worst < beta) beta = worst;
      if (alpha >= beta) break;
    }
    return worst;
  }
  /* Bester Zug des Bots für Farbe c auf der gewählten Stufe. */
  function botMove(board, c, lvl) {
    var list = moveList(board, c);
    if (!list.length) return -1;
    if (list.length === 1) return list[0];
    if (lvl.rnd > 0 && Math.random() < lvl.rnd) return list[Math.floor(Math.random() * list.length)];
    var empty = counts(board).empty;
    var depth = lvl.depth;
    if (lvl.key === 'schwer' && empty <= 10) depth = empty;            // Endspiel exakt ausrechnen
    else if (lvl.key === 'mittel' && empty <= 8) depth = empty;
    nodes = 0;
    var foe = other(c), best = -Infinity, move = list[0], alpha = -Infinity;
    var ord = ordered(list);
    for (var i = 0; i < ord.length; i++) {
      var val = search(applied(board, ord[i], c), foe, c, foe, depth - 1, alpha, Infinity);
      if (val > best) { best = val; move = ord[i]; }
      if (best > alpha) alpha = best;
    }
    return move;
  }

  /* ===================== Ansicht (Solo + Multi teilen sich das Layout) ===================== */
  function buildLayout(onCell) {
    var phase = el('div', { class: 'rvs-phase' }, ['60 Felder frei']);
    var top = el('div', { class: 'rvs-top' }, [el('div', { class: 'rvs-brand neon' }, ['⚫ Reversi']), phase]);

    var dName = el('div', { class: 'rvs-nm' }, ['—']);
    var dCount = el('div', { class: 'rvs-ct' }, ['2']);
    var dChip = el('div', { class: 'rvs-chip rvs-chip-d' }, [
      el('span', { class: 'rvs-mini-disc rvs-mini-d' }),
      el('div', { class: 'rvs-info' }, [dName, el('div', { class: 'rvs-sub' }, ['Schwarz'])]),
      dCount
    ]);
    var lName = el('div', { class: 'rvs-nm' }, ['—']);
    var lCount = el('div', { class: 'rvs-ct' }, ['2']);
    var lChip = el('div', { class: 'rvs-chip rvs-chip-l' }, [
      el('span', { class: 'rvs-mini-disc rvs-mini-l' }),
      el('div', { class: 'rvs-info' }, [lName, el('div', { class: 'rvs-sub' }, ['Weiß'])]),
      lCount
    ]);
    var chips = el('div', { class: 'rvs-chips' }, [dChip, lChip]);

    var barD = el('div', { class: 'rvs-bar-d' }), barL = el('div', { class: 'rvs-bar-l' });
    var bar = el('div', { class: 'rvs-bar' }, [barD, barL]);

    var status = el('div', { class: 'rvs-status you' }, ['']);
    var pass = el('div', { class: 'rvs-pass' }, ['']);

    var grid = el('div', { class: 'rvs-board' });
    var cells = [], slots = [], discs = [], state = [];
    for (var i = 0; i < 64; i++) {
      (function (idx) {
        var disc = el('span', { class: 'rvs-disc' }, [
          el('span', { class: 'rvs-face rvs-face-d' }), el('span', { class: 'rvs-face rvs-face-l' })
        ]);
        var slot = el('span', { class: 'rvs-slot' }, [disc]);
        var cell = el('button', {
          class: 'rvs-cell', type: 'button', 'aria-label': 'Feld ' + (idx + 1),
          onclick: function () { onCell(idx); }
        }, [slot, el('span', { class: 'rvs-hint' })]);
        cells.push(cell); slots.push(slot); discs.push(disc); state.push(0);
        grid.appendChild(cell);
      })(i);
    }

    var actions = el('div', { class: 'controls-row rvs-actions' });
    var wrap = el('div', { class: 'rvs-wrap' }, [
      top, chips, bar, status, pass,
      el('div', { class: 'rvs-boardwrap' }, [grid]),
      el('p', { class: 'hint-text rvs-rules' }, [RULES_TEXT]),
      actions
    ]);
    return {
      root: wrap, phase: phase, grid: grid, status: status, pass: pass, actions: actions,
      dChip: dChip, dName: dName, dCount: dCount, lChip: lChip, lName: lName, lCount: lCount,
      barD: barD, barL: barL, cells: cells, slots: slots, discs: discs, state: state, first: true
    };
  }

  /* view-model → DOM, rein per Diff (kein Neuaufbau → kein Flackern, idempotent) */
  function updateLayout(refs, vm) {
    var c = counts(vm.board), i;
    refs.phase.textContent = c.empty + ' Felder frei';
    refs.dName.textContent = vm.darkName;
    refs.lName.textContent = vm.lightName;
    refs.dCount.textContent = String(c.d);
    refs.lCount.textContent = String(c.l);
    refs.dChip.classList.toggle('active', !vm.over && vm.turn === DARK);
    refs.lChip.classList.toggle('active', !vm.over && vm.turn === LIGHT);
    refs.dChip.classList.toggle('me', vm.myColor === DARK);
    refs.lChip.classList.toggle('me', vm.myColor === LIGHT);

    var tot = (c.d + c.l) || 1;
    refs.barD.style.width = (c.d / tot * 100) + '%';
    refs.barL.style.width = (c.l / tot * 100) + '%';

    refs.status.textContent = vm.status.text;
    refs.status.className = 'rvs-status ' + vm.status.cls;
    refs.pass.textContent = vm.passText || '';
    refs.pass.classList.toggle('show', !!vm.passText);

    refs.grid.classList.toggle('rvs-live', !!vm.canPlay);
    refs.grid.classList.toggle('rvs-turn-l', vm.turn === LIGHT);

    var hints = vm.hints || {};
    var placed = -1, flipped = 0;
    for (i = 0; i < 64; i++) {
      var v = vm.board[i], prev = refs.state[i];
      if (v !== prev) {
        var disc = refs.discs[i], slot = refs.slots[i];
        if (prev === 0) {
          /* neuer Stein: ohne Dreh-Animation auf die richtige Seite setzen, dann Pop */
          disc.style.transition = 'none';
          disc.style.transitionDelay = '0ms';
          disc.classList.toggle('is-l', v === LIGHT);
          void disc.offsetWidth;
          disc.style.transition = '';
          slot.classList.add('is-on');
          slot.classList.remove('rvs-pop'); void slot.offsetWidth;
          if (!refs.first) { slot.classList.add('rvs-pop'); placed = i; }
        } else {
          /* Umdrehen: gestaffelt vom gesetzten Stein nach außen */
          disc.style.transitionDelay = (60 + chebyshev(i, vm.lastMove) * 55) + 'ms';
          disc.classList.toggle('is-l', v === LIGHT);
          flipped++;
        }
        refs.state[i] = v;
      }
      refs.cells[i].classList.toggle('rvs-can', !!hints[i]);
      refs.cells[i].classList.toggle('rvs-last', i === vm.lastMove && v !== 0);
    }
    if (App.Audio && !refs.first) {
      if (placed >= 0) App.Audio.sfx('chip');
      if (flipped > 0) App.Audio.sweep(240, 300 + Math.min(flipped, 8) * 70, 0.22);
    }
    refs.first = false;
  }

  /* ===================== Registrierung ===================== */
  App.Minigames.reversi = {
    id: 'reversi', title: 'Reversi', icon: '⚫', order: 103,
    subtitle: 'Dreh die Steine — die Mehrheit gewinnt',
    single: true, multi: true, minPlayers: 2, maxPlayers: 2,

    render: function (root, ctx) {
      var dead = false;
      var timers = [];                  // laufende setTimeout-IDs
      var stops = [];                   // stop()/off()-Funktionen (App.MG + room.on)

      function after(ms, fn) { var t = setTimeout(function () { if (!dead) fn(); }, ms); timers.push(t); return t; }
      function clearTimers() { timers.forEach(clearTimeout); timers = []; }
      function stopHelpers() { stops.forEach(function (f) { try { f(); } catch (e) {} }); stops = []; }
      function cleanup() { dead = true; clearTimers(); stopHelpers(); }

      if (ctx.mode === 'multi' && ctx.room) startMulti(); else startSolo();
      return { cleanup: cleanup };

      /* =========================================================
       *  SOLO — gegen den Bot
       * ========================================================= */
      function startSolo() {
        var lvl = LEVELS[App.Storage.get('reversi_level', 'mittel')] || LEVELS.mittel;
        var st = null, refs = null;
        var ME = DARK, BOT = LIGHT;                 // Schwarz beginnt = der Mensch

        chooseLevel();

        /* ---- Stufenwahl ---- */
        function chooseLevel() {
          clearTimers();
          var best = App.Storage.get('best_reversi', 0);
          var btns = LEVEL_ORDER.map(function (key) {
            var L = LEVELS[key];
            return el('button', {
              class: 'rvs-lvl rvs-lvl-' + key + (lvl.key === key ? ' sel' : ''), type: 'button',
              onclick: function () {
                lvl = L; App.Storage.set('reversi_level', key);
                if (App.Audio) App.Audio.sfx('select');
                playSolo();
              }
            }, [
              el('span', { class: 'rvs-lvl-icon' }, [L.icon]),
              el('span', { class: 'rvs-lvl-txt' }, [
                el('span', { class: 'rvs-lvl-nm' }, [L.name]),
                el('span', { class: 'rvs-lvl-ds' }, [L.desc])
              ])
            ]);
          });
          root.innerHTML = '';
          root.appendChild(el('div', { class: 'rvs-panel glass' }, [
            el('div', { class: 'rvs-panel-icon' }, ['⚫']),
            el('h2', { class: 'neon' }, ['Reversi']),
            el('p', { class: 'hint-text' }, ['Du spielst Schwarz und beginnst. Wähle deinen Gegner:']),
            el('div', { class: 'rvs-levels' }, btns),
            el('p', { class: 'hint-text' }, ['🏆 Bestwert: ' + App.MG.fmt(best) + ' Punkte']),
            el('p', { class: 'hint-text rvs-rules' }, [RULES_TEXT]),
            el('div', { class: 'controls-row' }, [
              el('button', { class: 'btn btn-ghost', type: 'button', onclick: ctx.onExit }, ['Zurück'])
            ])
          ]));
        }

        /* ---- Partie ---- */
        function playSolo() {
          clearTimers();
          st = { board: startBoard(), turn: DARK, lastMove: -1, passing: 0, over: false, thinking: false };
          refs = buildLayout(onCell);
          refs.actions.appendChild(el('button', { class: 'btn btn-ghost', type: 'button', onclick: playSolo }, ['🔄 Neu starten']));
          refs.actions.appendChild(el('button', { class: 'btn btn-ghost', type: 'button', onclick: chooseLevel }, ['🎚️ Stufe wechseln']));
          root.innerHTML = ''; root.appendChild(refs.root);
          paint();
        }

        function onCell(i) {
          if (dead || !st || st.over || st.thinking || st.passing) return;
          if (st.turn !== ME) return;
          var f = flipsAt(st.board, i, ME);
          if (!f) {
            if (App.Audio) App.Audio.sfx('error');
            refs.grid.classList.remove('rvs-shake'); void refs.grid.offsetWidth; refs.grid.classList.add('rvs-shake');
            return;
          }
          place(i, ME);
        }
        function place(i, color) {
          st.board = applied(st.board, i, color);
          st.lastMove = i;
          advance(color);
        }
        /* Nach einem Zug von `color`: nächsten Spieler bestimmen bzw. aussetzen lassen. */
        function advance(color) {
          var next = other(color);
          if (countMoves(st.board, next)) { st.turn = next; st.passing = 0; paint(); maybeBot(); return; }
          if (!countMoves(st.board, color)) { st.over = true; st.turn = 0; paint(); after(1100, finishSolo); return; }
          st.passing = next; st.turn = color;                 // Gegner muss aussetzen, ich bleibe dran
          paint();
          if (App.Audio) App.Audio.sfx('info');
          after(1600, function () {
            if (!st || st.over) return;
            st.passing = 0; paint(); maybeBot();
          });
        }
        function maybeBot() {
          if (dead || !st || st.over || st.turn !== BOT || st.passing) return;
          st.thinking = true; paint();
          after(420 + Math.random() * 260, function () {
            if (!st || st.over || st.turn !== BOT) return;
            var m = botMove(st.board.slice(), BOT, lvl);
            st.thinking = false;
            if (m < 0) { advance(BOT); return; }
            place(m, BOT);
          });
        }

        function paint() {
          var mine = st.turn === ME && !st.over && !st.passing && !st.thinking;
          var hints = {};
          if (mine) moveList(st.board, ME).forEach(function (i) { hints[i] = true; });
          updateLayout(refs, {
            board: st.board, myColor: ME, turn: st.over ? 0 : st.turn, lastMove: st.lastMove,
            over: st.over, canPlay: mine, hints: hints,
            darkName: 'Du', lightName: 'Bot · ' + lvl.name,
            passText: st.passing ? (st.passing === ME ? '⏭️ Du kannst nicht ziehen — du setzt aus' : '⏭️ Der Bot kann nicht ziehen — er setzt aus') : '',
            status: soloStatus()
          });
        }
        function soloStatus() {
          if (st.over) return { text: '🏁 Brett zu — wird ausgezählt …', cls: 'done' };
          if (st.passing) return { text: 'Aussetzen …', cls: 'pass' };
          if (st.thinking) return { text: lvl.icon + ' Bot denkt nach …', cls: 'opp' };
          if (st.turn === ME) {
            var n = countMoves(st.board, ME);
            return { text: 'Du bist dran · ' + n + (n === 1 ? ' Zug möglich' : ' Züge möglich'), cls: 'you' };
          }
          return { text: 'Bot ist dran', cls: 'opp' };
        }

        function finishSolo() {
          if (dead) return;
          var c = counts(st.board), mine = c.d, foe = c.l;
          var won = mine > foe, draw = mine === foe;
          var score = Math.round((mine * 10 + Math.max(0, mine - foe) * 15 + (won ? 400 : draw ? 150 : 0)) * lvl.mult);
          var best = App.Storage.get('best_reversi', 0);
          var nb = score > best;
          if (nb) App.Storage.set('best_reversi', score);
          if (App.Audio) App.Audio.sfx(won ? 'win' : draw ? 'ding' : 'lose');
          if (won && App.Scores) { try { App.Scores.winCurrent(); } catch (e) {} }
          App.MG.endScreen(root, {
            score: score, best: best, newBest: nb,
            title: won ? '🏆 Gewonnen!' : draw ? '🤝 Unentschieden' : '💀 Verloren',
            label: mine + ' : ' + foe + ' Steine · Stufe ' + lvl.name + (nb ? ' · neuer Rekord! 🎉' : ' · Bestwert: ' + App.MG.fmt(best)),
            onExit: ctx.onExit,
            onAgain: playSolo
          });
        }
      }

      /* =========================================================
       *  MULTI — Zustand in room.shared, Start via Countdown
       * ========================================================= */
      function startMulti() {
        var room = ctx.room, me = ctx.me;
        var snap = room.snapshot() || {};
        var startAt = (snap.round && snap.round.startAt) || (room.now() + 3000);
        stops.push(App.MG.countdown(root, startAt, function () { play(startAt); }, room.now));

        function play() {
          var refs = buildLayout(onCell);
          root.innerHTML = ''; root.appendChild(refs.root);

          /* shared robust einlesen: Brett/Reihenfolge immer als echte Arrays */
          function norm(sh) {
            if (!sh) return null;
            var o = Object.assign({}, sh);
            var b = normBoard(sh.board);
            if (b) o.board = b;
            if (sh.order && !Array.isArray(sh.order)) o.order = [sh.order[0], sh.order[1]];
            return o;
          }
          var lastShared = norm((room.snapshot() || {}).shared);
          var initDone = false, endShown = false, passHandled = -1, reported = -1;

          function onShared(sh) { if (dead) return; lastShared = norm(sh); sync(); }
          function onPlayers() { if (dead) return; sync(); }
          room.on('shared', onShared);
          room.on('players', onPlayers);
          stops.push(function () { room.off('shared', onShared); room.off('players', onPlayers); });
          sync();

          /* ---- Farb-Zuordnung ---- */
          function colorOf(id, sh) { var i = sh && sh.order ? sh.order.indexOf(id) : -1; return i === 0 ? DARK : i === 1 ? LIGHT : 0; }
          function idOfColor(c, sh) { return c === DARK ? sh.order[0] : sh.order[1]; }
          function nameOf(players, id, fallback) {
            for (var i = 0; i < players.length; i++) if (players[i].id === id) return players[i].name;
            return fallback;
          }

          function sync() {
            var players = room.players();
            var sh = lastShared;
            if (!sh || !sh.board || sh.board.length !== 64 || !sh.order || sh.order.length !== 2) {
              if (players.length >= 2 && room.isHost() && !initDone) initShared(players);
              refs.status.textContent = players.length >= 2 ? 'Spiel wird vorbereitet …' : 'Warte auf den Gegner …';
              refs.status.className = 'rvs-status opp';
              return;
            }
            if (sh.over && !endShown) { showEnd(sh, players); return; }
            if (endShown) return;
            var myColor = colorOf(me.id, sh);
            var turnColor = colorOf(sh.turn, sh);
            var myTurn = sh.turn === me.id && !sh.passing && myColor !== 0;
            var hints = {};
            if (myTurn) moveList(sh.board, myColor).forEach(function (i) { hints[i] = true; });
            updateLayout(refs, {
              board: sh.board, myColor: myColor, turn: turnColor,
              lastMove: (typeof sh.lastMove === 'number') ? sh.lastMove : -1,
              over: false, canPlay: myTurn, hints: hints,
              darkName: nameOf(players, sh.order[0], 'Spieler 1') + (myColor === DARK ? ' (du)' : ''),
              lightName: nameOf(players, sh.order[1], 'Spieler 2') + (myColor === LIGHT ? ' (du)' : ''),
              passText: sh.passing ? (sh.passing === me.id ? '⏭️ Du kannst nicht ziehen — du setzt aus'
                : '⏭️ ' + nameOf(players, sh.passing, 'Der Gegner') + ' kann nicht ziehen — Aussetzen') : '',
              status: multiStatus(sh, players, myColor, myTurn)
            });
            reportMine(sh, myColor);
            hostPass(sh);
          }

          function multiStatus(sh, players, myColor, myTurn) {
            if (players.length < 2) return { text: 'Warte auf den Gegner …', cls: 'opp' };
            if (myColor === 0) return { text: 'Du schaust zu', cls: 'opp' };
            if (sh.passing) return { text: 'Aussetzen …', cls: 'pass' };
            if (myTurn) {
              var n = countMoves(sh.board, myColor);
              return { text: 'Du bist dran · ' + n + (n === 1 ? ' Zug möglich' : ' Züge möglich'), cls: 'you' };
            }
            return { text: nameOf(players, sh.turn, 'Der Gegner') + ' ist dran …', cls: 'opp' };
          }

          function initShared(players) {
            initDone = true;
            room.setShared({
              order: [players[0].id, players[1].id], board: startBoard(),
              turn: players[0].id, lastMove: -1, moveNo: 0, passing: null, over: false, winner: null
            });
          }

          /* eigene Steinzahl melden → Podest/Bestenliste am Ende stimmen */
          function reportMine(sh, myColor) {
            if (!myColor) return;
            var c = counts(sh.board), n = myColor === DARK ? c.d : c.l;
            if (n === reported) return;
            reported = n;
            room.reportScore(n);
          }

          /* Zug setzen: wer zieht, schreibt das Ergebnis. */
          function onCell(i) {
            var sh = lastShared;
            if (dead || !sh || !sh.board || sh.over || endShown) return;
            var myColor = colorOf(me.id, sh);
            if (!myColor) return;                                   // Zuschauer
            if (sh.turn !== me.id || sh.passing) { UI.toast('Warte — du bist nicht dran', 'info'); return; }
            var f = flipsAt(sh.board, i, myColor);
            if (!f) {
              if (App.Audio) App.Audio.sfx('error');
              refs.grid.classList.remove('rvs-shake'); void refs.grid.offsetWidth; refs.grid.classList.add('rvs-shake');
              return;
            }
            var board = applied(sh.board, i, myColor);
            var foe = other(myColor), foeId = idOfColor(foe, sh);
            var patch = { board: board, lastMove: i, moveNo: (sh.moveNo || 0) + 1, turn: foeId, passing: null };
            if (!countMoves(board, foe)) {
              if (!countMoves(board, myColor)) {                    // beide blockiert → Ende
                patch.over = true; patch.winner = winnerOf(board, sh);
              } else {
                patch.passing = foeId;                              // Gegner setzt aus (Host schaltet zurück)
              }
            }
            if (counts(board).empty === 0) { patch.over = true; patch.winner = winnerOf(board, sh); patch.passing = null; }
            room.setShared(patch);
          }

          function winnerOf(board, sh) {
            var c = counts(board);
            if (c.d === c.l) return 'draw';
            return c.d > c.l ? sh.order[0] : sh.order[1];
          }

          /* Nur der Host schaltet nach einem Aussetzer weiter (einmal pro Zug). */
          function hostPass(sh) {
            if (!room.isHost() || sh.over || !sh.passing) return;
            var mv = sh.moveNo || 0;
            if (passHandled === mv) return;
            passHandled = mv;
            after(1700, function () {
              var cur = lastShared;
              if (!cur || cur.over || !cur.passing || (cur.moveNo || 0) !== mv) return;
              room.setShared({ turn: cur.passing === cur.order[0] ? cur.order[1] : cur.order[0], passing: null });
            });
          }

          function showEnd(sh, players) {
            if (endShown) return;
            endShown = true;
            var myColor = colorOf(me.id, sh);
            var c = counts(sh.board);
            /* Schlussbild noch kurz zeigen, dann Podest */
            updateLayout(refs, {
              board: sh.board, myColor: myColor, turn: 0,
              lastMove: (typeof sh.lastMove === 'number') ? sh.lastMove : -1,
              over: true, canPlay: false, hints: {},
              darkName: nameOf(players, sh.order[0], 'Spieler 1') + (myColor === DARK ? ' (du)' : ''),
              lightName: nameOf(players, sh.order[1], 'Spieler 2') + (myColor === LIGHT ? ' (du)' : ''),
              passText: '',
              status: { text: '🏁 Brett zu — ' + c.d + ' : ' + c.l, cls: 'done' }
            });
            if (myColor) room.reportScore(myColor === DARK ? c.d : c.l);
            var iWon = sh.winner === me.id;
            if (App.Audio) App.Audio.sfx(sh.winner === 'draw' ? 'ding' : iWon ? 'win' : 'lose');
            if (iWon && App.Scores) { try { App.Scores.winCurrent(); } catch (e) {} }
            after(1600, function () {
              App.MG.endScreen(root, { players: room.players(), meId: me.id, onExit: ctx.onExit });
            });
          }
        }
      }
    }
  };

  /* ===================== CSS ===================== */
  function injectStyle() {
    UI.injectStyle('mg-reversi-css', [
      '.rvs-wrap{display:flex;flex-direction:column;gap:10px;max-width:420px;margin:0 auto;}',
      '.rvs-top{display:flex;justify-content:space-between;align-items:center;gap:10px;}',
      '.rvs-brand{font-weight:900;font-size:18px;}',
      '.rvs-phase{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;font-weight:800;}',
      /* Steinzähler */
      '.rvs-chips{display:flex;gap:10px;}',
      '.rvs-chip{flex:1;min-width:0;display:flex;align-items:center;gap:9px;padding:8px 11px;border-radius:14px;background:rgba(9,32,21,.6);border:1px solid var(--stroke);transition:border-color .15s,box-shadow .15s;}',
      '.rvs-chip .rvs-info{flex:1;min-width:0;display:flex;flex-direction:column;line-height:1.15;}',
      '.rvs-chip .rvs-nm{font-weight:800;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      '.rvs-chip .rvs-sub{font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;}',
      '.rvs-chip .rvs-ct{font-size:24px;font-weight:900;font-variant-numeric:tabular-nums;}',
      '.rvs-chip-d .rvs-ct{color:var(--leaf);}',
      '.rvs-chip-l .rvs-ct{color:var(--aqua);}',
      '.rvs-chip.me .rvs-nm{color:var(--aqua-soft);}',
      '.rvs-chip.active{border-color:var(--neon);background:rgba(19,68,42,.75);box-shadow:0 0 0 1px var(--neon),0 0 18px rgba(57,255,20,.3);}',
      '.rvs-chip.active .rvs-mini-disc{animation:rvs-bob .9s ease-in-out infinite;}',
      '.rvs-mini-disc{width:22px;height:22px;border-radius:50%;flex:0 0 auto;}',
      '.rvs-mini-d{background:radial-gradient(circle at 34% 28%,#46e07d,#0b3019 80%);border:1px solid rgba(57,255,20,.7);box-shadow:0 0 8px rgba(57,255,20,.35);}',
      '.rvs-mini-l{background:radial-gradient(circle at 34% 28%,#f2fffb,#6fd9cc 76%);border:1px solid rgba(255,255,255,.7);box-shadow:0 0 8px rgba(51,230,208,.45);}',
      '@keyframes rvs-bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-3px)}}',
      /* Verhältnis-Balken */
      '.rvs-bar{display:flex;height:7px;border-radius:5px;overflow:hidden;background:rgba(4,16,10,.8);border:1px solid var(--stroke);}',
      '.rvs-bar-d{background:linear-gradient(90deg,#0d3a22,var(--neon));transition:width .45s cubic-bezier(.3,.9,.3,1);box-shadow:0 0 8px rgba(57,255,20,.5);}',
      '.rvs-bar-l{background:linear-gradient(90deg,var(--aqua),var(--aqua-soft));transition:width .45s cubic-bezier(.3,.9,.3,1);box-shadow:0 0 8px rgba(51,230,208,.5);}',
      /* Status */
      '.rvs-status{text-align:center;font-weight:900;font-size:clamp(14px,4vw,18px);min-height:24px;}',
      '.rvs-status.you{color:var(--neon);text-shadow:0 0 10px rgba(57,255,20,.4);}',
      '.rvs-status.opp{color:var(--aqua);}',
      '.rvs-status.pass{color:var(--gold);}',
      '.rvs-status.done{color:var(--gold);text-shadow:0 0 12px rgba(255,210,63,.5);}',
      '.rvs-pass{max-height:0;opacity:0;overflow:hidden;text-align:center;font-weight:800;font-size:13px;color:var(--gold);',
      'background:rgba(255,210,63,.08);border-radius:10px;transition:max-height .25s ease,opacity .25s ease,padding .25s ease;padding:0 10px;}',
      '.rvs-pass.show{max-height:44px;opacity:1;padding:7px 10px;border:1px solid rgba(255,210,63,.35);}',
      /* Brett */
      '.rvs-boardwrap{display:flex;justify-content:center;}',
      '.rvs-board{display:grid;grid-template-columns:repeat(8,1fr);gap:3px;width:100%;max-width:340px;padding:8px;border-radius:16px;',
      'background:radial-gradient(circle at 50% 28%,rgba(13,60,38,.95),rgba(3,14,9,.98));border:2px solid var(--stroke-2);',
      'box-shadow:0 0 30px rgba(57,255,20,.15),inset 0 0 44px rgba(0,0,0,.55);touch-action:manipulation;}',
      '.rvs-board.rvs-shake{animation:rvs-shake .3s ease;}',
      '.rvs-cell{position:relative;aspect-ratio:1/1;padding:0;border-radius:6px;border:1px solid rgba(57,255,20,.13);',
      'background:linear-gradient(160deg,rgba(8,34,21,.92),rgba(3,15,9,.94));cursor:default;',
      'transition:border-color .15s,box-shadow .15s,transform .1s;}',
      '.rvs-board.rvs-live .rvs-cell.rvs-can{cursor:pointer;border-color:rgba(57,255,20,.45);}',
      '.rvs-board.rvs-live .rvs-cell.rvs-can:hover{border-color:var(--neon);box-shadow:inset 0 0 16px rgba(57,255,20,.28);transform:translateY(-1px);}',
      '.rvs-board.rvs-live .rvs-cell.rvs-can:active{transform:scale(.94);}',
      '.rvs-cell.rvs-last{border-color:var(--gold);box-shadow:0 0 0 1px rgba(255,210,63,.6),0 0 12px rgba(255,210,63,.3);}',
      /* Steine (3D-Flip) */
      '.rvs-slot{position:absolute;left:8%;top:8%;right:8%;bottom:8%;transform:scale(0);opacity:0;pointer-events:none;}',
      '.rvs-slot.is-on{transform:scale(1);opacity:1;}',
      '.rvs-slot.rvs-pop{animation:rvs-pop .26s cubic-bezier(.2,1.5,.4,1) both;}',
      '.rvs-disc{position:absolute;left:0;top:0;right:0;bottom:0;transform-style:preserve-3d;transition:transform .42s cubic-bezier(.45,.05,.25,1);}',
      '.rvs-disc.is-l{transform:rotateY(180deg);}',
      '.rvs-face{position:absolute;left:0;top:0;right:0;bottom:0;border-radius:50%;backface-visibility:hidden;-webkit-backface-visibility:hidden;}',
      '.rvs-face-d{background:radial-gradient(circle at 34% 28%,#46e07d,#0b3019 80%);border:1px solid rgba(57,255,20,.7);',
      'box-shadow:inset 0 -3px 6px rgba(0,0,0,.55),0 0 10px rgba(57,255,20,.4);}',
      '.rvs-face-l{transform:rotateY(180deg);background:radial-gradient(circle at 34% 28%,#f4fffc,#5fd3c5 76%);',
      'border:1px solid rgba(255,255,255,.75);box-shadow:inset 0 -2px 5px rgba(0,60,60,.35),0 0 10px rgba(51,230,208,.45);}',
      /* Zug-Punkte */
      '.rvs-hint{position:absolute;left:50%;top:50%;width:28%;height:28%;margin:-14% 0 0 -14%;border-radius:50%;',
      'background:var(--neon);opacity:0;transform:scale(.3);transition:opacity .15s,transform .15s;pointer-events:none;}',
      '.rvs-board.rvs-live .rvs-can .rvs-hint{opacity:.6;transform:scale(1);box-shadow:0 0 9px var(--neon);animation:rvs-hint 1.5s ease-in-out infinite;}',
      '.rvs-board.rvs-live.rvs-turn-l .rvs-can .rvs-hint{background:var(--aqua);box-shadow:0 0 9px var(--aqua);}',
      '@keyframes rvs-hint{0%,100%{opacity:.35;transform:scale(.8)}50%{opacity:.85;transform:scale(1.1)}}',
      '@keyframes rvs-pop{0%{transform:scale(.2)}70%{transform:scale(1.16)}100%{transform:scale(1)}}',
      '@keyframes rvs-shake{0%,100%{transform:translateX(0)}25%{transform:translateX(-6px)}75%{transform:translateX(6px)}}',
      '.rvs-rules{font-size:11px;line-height:1.5;text-align:center;margin:0;}',
      '.rvs-actions{margin-top:2px;}',
      /* Stufenwahl */
      '.rvs-panel{padding:26px 20px;text-align:center;display:flex;flex-direction:column;gap:12px;align-items:center;max-width:420px;margin:0 auto;}',
      '.rvs-panel-icon{width:54px;height:54px;border-radius:50%;background:radial-gradient(circle at 34% 28%,#46e07d,#0b3019 80%);',
      'border:2px solid var(--stroke-2);box-shadow:0 0 22px rgba(57,255,20,.35);display:flex;align-items:center;justify-content:center;font-size:0;}',
      '.rvs-levels{display:flex;flex-direction:column;gap:9px;width:100%;}',
      '.rvs-lvl{display:flex;align-items:center;gap:12px;padding:11px 13px;border-radius:14px;text-align:left;font-family:inherit;',
      'background:rgba(9,32,21,.6);border:1px solid var(--stroke);color:var(--text);cursor:pointer;transition:.15s;}',
      '.rvs-lvl:hover{border-color:var(--neon);box-shadow:0 0 16px rgba(57,255,20,.25);transform:translateY(-1px);}',
      '.rvs-lvl.sel{border-color:var(--neon);box-shadow:0 0 0 1px var(--neon),0 0 18px rgba(57,255,20,.3);}',
      '.rvs-lvl-icon{font-size:26px;line-height:1;filter:drop-shadow(0 0 6px rgba(0,0,0,.5));}',
      '.rvs-lvl-txt{display:flex;flex-direction:column;gap:2px;min-width:0;}',
      '.rvs-lvl-nm{font-weight:900;font-size:15px;}',
      '.rvs-lvl-ds{font-size:11px;color:var(--muted);}',
      '.rvs-lvl-mittel .rvs-lvl-nm{color:var(--aqua);}',
      '.rvs-lvl-schwer .rvs-lvl-nm{color:var(--gold);}'
    ].join(''));
  }
})();
