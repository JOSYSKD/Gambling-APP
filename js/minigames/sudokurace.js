/* sudokurace.js — "Sudoku-Duell": Wettrennen durch ein 9x9-Sudoku im Neon-Dschungel.
 *
 * SPIELIDEE : Alle lösen dasselbe, garantiert eindeutig lösbare Sudoku. Wer die
 *             meisten Zellen richtig füllt (und am schnellsten fertig ist), gewinnt.
 * GENERATOR : Komplett in dieser Datei — gelöstes Gitter per Backtracking (MRV +
 *             zufällige Kandidaten-Reihenfolge), danach Zellen in zufälliger Reihen-
 *             folge entfernen und nach jedem Schritt die Eindeutigkeit prüfen
 *             (Lösungen zählen, Abbruch bei 2). 3 Stufen über die Zahl der Vorgaben.
 * STEUERUNG : Zelle antippen/anklicken oder mit den Pfeiltasten wählen, Zahl über
 *             Tastatur (1–9) oder den Ziffernblock setzen. N = Notizen-Modus
 *             (kleine Kandidaten), 0/Entf/Rücktaste oder ⌫ = radieren.
 *             Zeile, Spalte und Block der aktiven Zelle werden dezent hervorgehoben,
 *             gleiche Zahlen leuchten mit. Richtig gesetzte Zellen sind fix.
 * FEHLER    : Falsche Zahl = rot + Herz weg. Bei 3 Fehlern 20 s Sperre (Brett
 *             gesperrt, Countdown-Overlay), danach sind die Herzen wieder voll.
 * PUNKTE    : korrekt gefüllte Zellen × 20; komplett gelöst = +1000 Bonus
 *             + Zeitbonus (verbleibende Sekunden × 5).
 * SOLO      : Zeitjagd gegen den eigenen Rekord — Stufe wählen (Leicht/Mittel/Schwer),
 *             Rekordzeit je Stufe + Bestpunktzahl werden gespeichert und angezeigt.
 * MULTI     : Der Host würfelt während des Countdowns EIN Rätsel aus und verteilt
 *             Rätsel + Lösung als 81-Zeichen-Strings via room.setShared() — alle
 *             spielen exakt dasselbe Brett. Jeder rechnet seinen Fortschritt lokal
 *             und meldet ihn per room.reportScore() / room.reportState({pct,done}).
 *             Daraus baut sich die Live-Rangliste mit Prozent-Balken. Alle Timer
 *             laufen über room.now() (Server-Zeit) -> synchron & Tab-sicher.
 *             Sind alle fertig, endet die Runde vorzeitig.
 *
 * cleanup() setzt dead=true und beendet Timer, Tastatur-Listener und alle room.on(). */
(function () {
  'use strict';
  window.App = window.App || {}; App.Minigames = App.Minigames || {};
  var UI = App.UI, el = UI.el;

  injectStyle();

  /* ---- Stufen: Schwierigkeit = Zahl der Vorgaben (weniger = härter) ---- */
  var LEVELS = {
    leicht: { key: 'leicht', name: 'Leicht', icon: '🌱', clues: 42, time: 480 },
    mittel: { key: 'mittel', name: 'Mittel', icon: '🌿', clues: 34, time: 720 },
    schwer: { key: 'schwer', name: 'Schwer', icon: '🔥', clues: 27, time: 1080 }
  };
  var MULTI_DIFF = 'mittel';      // Stufe im Mehrspieler-Rennen
  var MULTI_TIME = 600;           // s Rundenzeit im Mehrspieler (10 Minuten)
  var LOCK_MS = 20000;            // Sperre nach 3 Fehlern
  var MAX_ERRORS = 3;
  var ALL_BITS = 0x3FE;           // Bits 1..9

  /* ===================================================================
   *  SUDOKU-GENERATOR (rein, ohne DOM)
   * =================================================================== */
  function boxOf(i) { return Math.floor(i / 27) * 3 + Math.floor((i % 9) / 3); }
  function popcount(x) { var n = 0; while (x) { x &= x - 1; n++; } return n; }
  function shuffle(a) {
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1)), t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }
  function emptyGrid() { var g = [], i; for (i = 0; i < 81; i++) g.push(0); return g; }

  /* Belegungs-Bitmasken je Zeile/Spalte/Block aus einem Gitter aufbauen. */
  function masks(g) {
    var rows = [], cols = [], boxes = [], i;
    for (i = 0; i < 9; i++) { rows.push(0); cols.push(0); boxes.push(0); }
    for (i = 0; i < 81; i++) {
      var v = g[i];
      if (!v) continue;
      var bit = 1 << v;
      rows[Math.floor(i / 9)] |= bit; cols[i % 9] |= bit; boxes[boxOf(i)] |= bit;
    }
    return { rows: rows, cols: cols, boxes: boxes };
  }

  /* Sucht die freie Zelle mit den wenigsten Kandidaten (MRV).
     Rückgabe: {idx, mask, count} — idx=-1 heißt Gitter voll, count=0 heißt Sackgasse. */
  function pickCell(g, m) {
    var best = -1, bestMask = 0, bestCount = 10;
    for (var i = 0; i < 81; i++) {
      if (g[i]) continue;
      var cand = (~(m.rows[Math.floor(i / 9)] | m.cols[i % 9] | m.boxes[boxOf(i)])) & ALL_BITS;
      var cnt = popcount(cand);
      if (cnt === 0) return { idx: i, mask: 0, count: 0 };
      if (cnt < bestCount) { bestCount = cnt; best = i; bestMask = cand; if (cnt === 1) break; }
    }
    return { idx: best, mask: bestMask, count: bestCount };
  }
  function setCell(g, m, i, v) {
    var bit = 1 << v;
    g[i] = v; m.rows[Math.floor(i / 9)] |= bit; m.cols[i % 9] |= bit; m.boxes[boxOf(i)] |= bit;
  }
  function unsetCell(g, m, i, v) {
    var bit = 1 << v;
    g[i] = 0; m.rows[Math.floor(i / 9)] &= ~bit; m.cols[i % 9] &= ~bit; m.boxes[boxOf(i)] &= ~bit;
  }

  /* Füllt ein leeres Gitter zufällig, aber regelkonform (= fertige Lösung). */
  function fillGrid(g, m) {
    var p = pickCell(g, m);
    if (p.idx < 0) return true;
    if (p.count === 0) return false;
    var vals = [], v;
    for (v = 1; v <= 9; v++) if (p.mask & (1 << v)) vals.push(v);
    shuffle(vals);
    for (var k = 0; k < vals.length; k++) {
      setCell(g, m, p.idx, vals[k]);
      if (fillGrid(g, m)) return true;
      unsetCell(g, m, p.idx, vals[k]);
    }
    return false;
  }

  /* Zählt Lösungen bis maximal `limit` (limit=2 reicht für die Eindeutigkeit). */
  function countSolutions(g, m, limit) {
    var p = pickCell(g, m);
    if (p.idx < 0) return 1;
    if (p.count === 0) return 0;
    var total = 0;
    for (var v = 1; v <= 9; v++) {
      if (!(p.mask & (1 << v))) continue;
      setCell(g, m, p.idx, v);
      total += countSolutions(g, m, limit - total);
      unsetCell(g, m, p.idx, v);
      if (total >= limit) return total;
    }
    return total;
  }
  function isUnique(g) {
    var copy = g.slice();
    return countSolutions(copy, masks(copy), 2) === 1;
  }

  /* Erzeugt ein Rätsel mit möglichst genau `clues` Vorgaben.
     Nach jedem Entfernen wird die Eindeutigkeit geprüft — bleibt sie nicht
     erhalten, kommt die Zahl zurück. Rückgabe: {puzzle, solution, clues}. */
  function makePuzzle(clues) {
    var solution = emptyGrid();
    fillGrid(solution, masks(solution));
    var puzzle = solution.slice();
    var order = [], i;
    for (i = 0; i < 81; i++) order.push(i);
    shuffle(order);
    var left = 81, target = Math.max(17, clues);
    for (i = 0; i < order.length && left > target; i++) {
      var idx = order[i], keep = puzzle[idx];
      if (!keep) continue;
      puzzle[idx] = 0;
      if (isUnique(puzzle)) left--; else puzzle[idx] = keep;
    }
    return { puzzle: puzzle, solution: solution, clues: left };
  }

  /* 81 Ziffern <-> String (kompakte Übertragung via setShared) */
  function enc(g) { var s = '', i; for (i = 0; i < 81; i++) s += String(g[i] || 0); return s; }
  function dec(s) {
    var g = [], i;
    for (i = 0; i < 81; i++) { var n = parseInt(String(s).charAt(i), 10); g.push(isNaN(n) ? 0 : n); }
    return g;
  }
  function validStr(s) { return typeof s === 'string' && s.length === 81 && /^[0-9]{81}$/.test(s); }

  /* ===================================================================
   *  SPIEL
   * =================================================================== */
  App.Minigames.sudokurace = {
    id: 'sudokurace', title: 'Sudoku-Duell', icon: '🔢', order: 115,
    subtitle: 'Wer knackt das Zahlenrätsel zuerst?',
    single: true, multi: true, minPlayers: 2, maxPlayers: 6,

    render: function (root, ctx) {
      var isMulti = ctx.mode === 'multi';
      var nowFn = isMulti ? function () { return ctx.room.now(); } : function () { return Date.now(); };
      var tNow = isMulti ? ctx.room.now : null;      // nowFn für App.MG-Bausteine

      var dead = false, finished = false;
      var stops = [];        // stop()-Funktionen (Countdown, Timer, Listener)
      var pending = [];      // laufende setTimeout-IDs
      var handlers = [];     // {evt, fn} für room.off()

      var st = null;                 // Spielzustand (siehe startGame)
      var cellEls = [], numBtns = [];
      var timerEl, scoreEl, pctEl, heartsEl, barEl, statusEl, boardEl, boardWrap,
          lockEl, lockNum, notesBtn, listEl, diffEl;
      var allDoneQueued = false;

      function after(ms, fn) { var t = setTimeout(function () { if (!dead) fn(); }, ms); pending.push(t); return t; }
      function clearPending() { pending.forEach(clearTimeout); pending = []; }
      function stopHelpers() { stops.forEach(function (f) { try { f(); } catch (e) {} }); stops = []; }
      function onRoom(evt, fn) { ctx.room.on(evt, fn); handlers.push({ evt: evt, fn: fn }); }
      function offAll() {
        handlers.forEach(function (h) { try { ctx.room.off(h.evt, h.fn); } catch (e) {} });
        handlers = [];
      }
      function cleanup() { dead = true; clearPending(); stopHelpers(); if (isMulti) offAll(); }
      function sfx(n) { if (App.Audio) App.Audio.sfx(n); }
      function blip(f, d) { if (App.Audio && App.Audio.blip) App.Audio.blip(f, d); }

      /* ---------------- Einstieg ---------------- */
      if (isMulti) {
        var snap = ctx.room.snapshot() || {};
        var startAt = (snap.round && snap.round.startAt) || (ctx.room.now() + 3000);
        stops.push(App.MG.countdown(root, startAt, function () { startMulti(startAt); }, ctx.room.now));
        /* Host erzeugt das Rätsel während des Countdowns (kurz verzögert, damit
           der Countdown zuerst gezeichnet wird) und teilt es allen mit. */
        if (amHost()) after(60, hostMakePuzzle);
      } else {
        showSoloMenu();
      }
      return { cleanup: cleanup };

      function amHost() { return !!ctx.isHost || (ctx.room && ctx.room.isHost()); }
      function hostMakePuzzle() {
        if (dead) return;
        var sh = sharedNow();
        if (sh && validStr(sh.sdkPuz)) return;                 // schon verteilt
        var made = makePuzzle(LEVELS[MULTI_DIFF].clues);
        ctx.room.setShared({
          sdkPuz: enc(made.puzzle), sdkSol: enc(made.solution),
          sdkDiff: MULTI_DIFF, sdkClues: made.clues
        });
      }
      function sharedNow() { var s = ctx.room.snapshot(); return (s && s.shared) || null; }

      /* ================= MEHRSPIELER-START ================= */
      function startMulti(startAt) {
        if (dead) return;
        var endAt = startAt + MULTI_TIME * 1000;
        var loaded = false;

        /* Warte-Ansicht, bis das Rätsel des Hosts da ist. */
        root.innerHTML = '';
        root.appendChild(el('div', { class: 'sdk-menu glass' }, [
          el('div', { class: 'sdk-menu-ic sdk-spin' }, ['🔢']),
          el('h2', { class: 'neon' }, ['Rätsel wird verteilt …']),
          el('p', { class: 'hint-text' }, ['Alle bekommen exakt dasselbe Sudoku.'])
        ]));

        function tryLoad() {
          if (dead || loaded) return;                  // idempotent: 'shared' feuert oft
          var sh = sharedNow();
          if (!sh || !validStr(sh.sdkPuz) || !validStr(sh.sdkSol)) return;
          loaded = true;
          var lv = LEVELS[sh.sdkDiff] || LEVELS[MULTI_DIFF];
          startGame({
            puz: dec(sh.sdkPuz), sol: dec(sh.sdkSol), diff: lv.key,
            clues: sh.sdkClues || lv.clues, startAt: startAt, endAt: endAt
          });
        }
        onRoom('shared', tryLoad);
        tryLoad();

        /* Notnagel: Host weg, bevor er verteilt hat -> neuer Host würfelt selbst. */
        after(12000, function () { if (!loaded && amHost()) hostMakePuzzle(); });
      }

      /* ================= SOLO-MENÜ ================= */
      function showSoloMenu() {
        clearPending(); stopHelpers();
        finished = false; st = null; allDoneQueued = false;

        var cards = ['leicht', 'mittel', 'schwer'].map(function (key) {
          var lv = LEVELS[key];
          var bt = App.Storage.get('bestT_sudokurace_' + key, 0);
          return el('button', {
            class: 'sdk-lvl sdk-lvl-' + key, type: 'button',
            onclick: function () { sfx('select'); startSolo(key); }
          }, [
            el('span', { class: 'sdk-lvl-ic' }, [lv.icon]),
            el('span', { class: 'sdk-lvl-txt' }, [
              el('span', { class: 'sdk-lvl-nm' }, [lv.name]),
              el('span', { class: 'sdk-lvl-sub' }, [lv.clues + ' Vorgaben · ' + App.MG.mmss(lv.time) + ' Zeit'])
            ]),
            el('span', { class: 'sdk-lvl-rec' }, [bt ? '🏅 ' + App.MG.mmss(bt / 1000) : '– –'])
          ]);
        });

        root.innerHTML = '';
        root.appendChild(el('div', { class: 'sdk-menu glass' }, [
          el('div', { class: 'sdk-menu-ic' }, ['🔢']),
          el('h2', { class: 'neon' }, ['Sudoku-Duell']),
          el('p', { class: 'hint-text' }, ['Zeitjagd gegen deinen eigenen Rekord. Je weniger Vorgaben, desto mehr Zellen – und desto mehr Punkte.']),
          el('div', { class: 'sdk-lvls' }, cards),
          el('p', { class: 'sdk-menu-best' }, ['🏆 Bestpunktzahl: ' + App.MG.fmt(App.Storage.get('best_sudokurace', 0))]),
          el('div', { class: 'controls-row' }, [
            el('button', { class: 'btn btn-ghost', type: 'button', onclick: ctx.onExit }, ['Zurück'])
          ])
        ]));
      }

      function startSolo(key) {
        clearPending(); stopHelpers();
        root.innerHTML = '';
        root.appendChild(el('div', { class: 'sdk-menu glass' }, [
          el('div', { class: 'sdk-menu-ic sdk-spin' }, ['🔢']),
          el('h2', { class: 'neon' }, ['Rätsel wird erzeugt …']),
          el('p', { class: 'hint-text' }, ['Garantiert eindeutig lösbar – das prüft der Generator für jede entfernte Zahl.'])
        ]));
        after(60, function () {
          var lv = LEVELS[key];
          var made = makePuzzle(lv.clues);
          var s = nowFn();
          startGame({
            puz: made.puzzle, sol: made.solution, diff: key, clues: made.clues,
            startAt: s, endAt: s + lv.time * 1000
          });
        });
      }

      /* ================= SPIEL AUFBAUEN ================= */
      function startGame(cfg) {
        if (dead) return;
        clearPending(); stopHelpers();
        finished = false; allDoneQueued = false;

        var i;
        st = {
          sol: cfg.sol, given: [], val: cfg.puz.slice(), notes: [], wrong: [],
          sel: -1, notesMode: false, errors: 0, lockUntil: 0,
          score: 0, solved: false, timeBonus: 0, solveMs: 0,
          diff: cfg.diff, clues: cfg.clues, startAt: cfg.startAt, endAt: cfg.endAt,
          fillable: 0
        };
        for (i = 0; i < 81; i++) {
          st.given.push(cfg.puz[i] !== 0);
          st.wrong.push(false);
          st.notes.push([false, false, false, false, false, false, false, false, false, false]);
          if (cfg.puz[i] === 0) st.fillable++;
        }

        buildLayout();
        paint(); updateHead();
        if (isMulti) { ctx.room.reportScore(0); ctx.room.reportState({ pct: 0, done: 0 }); }

        /* Rundenuhr (Wall-Clock / Server-Zeit) */
        stops.push(App.MG.roundTimer(st.endAt, function (left) {
          timerEl.textContent = App.MG.mmss(left);
          timerEl.classList.toggle('sdk-urgent', left <= 30);
        }, finish, tNow));

        /* Tastatur */
        document.addEventListener('keydown', onKey);
        stops.push(function () { document.removeEventListener('keydown', onKey); });

        /* Live-Rangliste */
        if (isMulti) { onRoom('players', onPlayers); updateList(); }
      }

      function buildLayout() {
        var lv = LEVELS[st.diff];
        cellEls = []; numBtns = [];

        /* --- Kopfzeile --- */
        timerEl = el('div', { class: 'mg-timer sdk-timer' }, [App.MG.mmss((st.endAt - nowFn()) / 1000)]);
        scoreEl = el('div', { class: 'sdk-hv sdk-hv-score' }, ['0']);
        pctEl = el('div', { class: 'sdk-hv sdk-hv-pct' }, ['0 %']);
        heartsEl = el('div', { class: 'sdk-hearts' });
        var head = el('div', { class: 'sdk-head glass' }, [
          el('div', { class: 'sdk-hcell' }, [el('span', { class: 'sdk-hl' }, ['Zeit']), timerEl]),
          el('div', { class: 'sdk-hcell' }, [el('span', { class: 'sdk-hl' }, ['Punkte']), scoreEl]),
          el('div', { class: 'sdk-hcell' }, [el('span', { class: 'sdk-hl' }, ['Fortschritt']), pctEl]),
          el('div', { class: 'sdk-hcell' }, [el('span', { class: 'sdk-hl' }, ['Fehler']), heartsEl])
        ]);
        barEl = el('div', { class: 'sdk-bar-fill' });
        var bar = el('div', { class: 'sdk-bar' }, [barEl]);

        diffEl = el('span', { class: 'chip sdk-diff sdk-diff-' + st.diff }, [
          lv.icon + ' ' + lv.name + ' · ' + st.clues + ' Vorgaben'
        ]);
        var top = el('div', { class: 'sdk-top' }, [
          el('div', { class: 'sdk-brand neon' }, ['🔢 Sudoku-Duell']), diffEl
        ]);

        statusEl = el('div', { class: 'sdk-status' }, [isMulti ? 'Los! Alle haben dasselbe Rätsel.' : 'Los geht\'s – schlag deine Rekordzeit!']);

        /* --- Brett --- */
        boardEl = el('div', { class: 'sdk-board' });
        for (var i = 0; i < 81; i++) {
          (function (idx) {
            var vEl = el('span', { class: 'sdk-v' });
            var nWrap = el('span', { class: 'sdk-notes' });
            var nEls = [];
            for (var k = 1; k <= 9; k++) {
              var n = el('span', { class: 'sdk-n' }, [String(k)]);
              nEls.push(n); nWrap.appendChild(n);
            }
            var btn = el('button', { class: 'sdk-cell', type: 'button' }, [vEl, nWrap]);
            btn.addEventListener('pointerdown', function (e) {
              if (e && e.preventDefault) e.preventDefault();
              selectCell(idx);
            });
            cellEls.push({ btn: btn, v: vEl, notes: nEls });
            boardEl.appendChild(btn);
          })(i);
        }
        lockNum = el('div', { class: 'sdk-lock-num' }, ['20s']);
        lockEl = el('div', { class: 'sdk-lock' }, [
          el('div', { class: 'sdk-lock-ic' }, ['🔒']),
          el('div', { class: 'sdk-lock-t' }, ['3 Fehler – Brett gesperrt']),
          lockNum
        ]);
        boardWrap = el('div', { class: 'sdk-boardwrap' }, [boardEl, lockEl]);

        /* --- Ziffernblock --- */
        var pad = el('div', { class: 'sdk-pad' });
        for (var v = 1; v <= 9; v++) {
          (function (num) {
            var left = el('span', { class: 'sdk-np-left' }, ['9']);
            var b = el('button', {
              class: 'sdk-np', type: 'button',
              onclick: function () { place(num); }
            }, [el('span', { class: 'sdk-np-d' }, [String(num)]), left]);
            numBtns.push({ btn: b, left: left });
            pad.appendChild(b);
          })(v);
        }
        pad.appendChild(el('button', {
          class: 'sdk-np sdk-np-del', type: 'button', onclick: erase
        }, [el('span', { class: 'sdk-np-d' }, ['⌫'])]));

        notesBtn = el('button', {
          class: 'btn btn-ghost sdk-notesbtn', type: 'button', onclick: toggleNotes
        }, ['📝 Notizen: Aus']);

        var tools = el('div', { class: 'controls-row sdk-tools' }, [notesBtn]);

        var rules = el('p', { class: 'hint-text sdk-rules' }, [
          'Zelle wählen (Klick/Pfeiltasten) · 1–9 setzen · N = Notizen · Entf = löschen · ' +
          MAX_ERRORS + ' Fehler = 20 s Sperre · richtige Zellen sind fix'
        ]);

        var kids = [top, head, bar, statusEl, boardWrap, tools, pad, rules];
        if (isMulti) {
          listEl = el('div', { class: 'sdk-list' });
          kids.push(el('div', { class: 'sdk-listwrap glass' }, [
            el('div', { class: 'mg-field-title' }, ['🏆 Rangliste']), listEl
          ]));
        }
        root.innerHTML = '';
        root.appendChild(el('div', { class: 'sdk-wrap' }, kids));
      }

      /* ================= ZUSTAND / PUNKTE ================= */
      function isLocked() { return st && st.lockUntil > nowFn(); }
      function correctCount() {
        var n = 0;
        for (var i = 0; i < 81; i++) if (!st.given[i] && st.val[i] && st.val[i] === st.sol[i]) n++;
        return n;
      }
      function pctDone() { return st.fillable ? Math.round(correctCount() / st.fillable * 100) : 100; }
      function recalcScore() { st.score = correctCount() * 20 + (st.solved ? 1000 + st.timeBonus : 0); }
      function report() {
        if (!isMulti || dead) return;
        ctx.room.reportScore(st.score);
        ctx.room.reportState({ pct: pctDone(), done: st.solved ? 1 : 0 });
      }
      function isSolved() {
        for (var i = 0; i < 81; i++) if (st.val[i] !== st.sol[i]) return false;
        return true;
      }

      /* ================= EINGABE ================= */
      function selectCell(i) {
        if (dead || finished || !st) return;
        if (st.sel === i) return;
        st.sel = i;
        blip(520, 0.04);
        paint();
      }
      function toggleNotes() {
        if (dead || finished || !st) return;
        st.notesMode = !st.notesMode;
        sfx('click');
        notesBtn.textContent = '📝 Notizen: ' + (st.notesMode ? 'An' : 'Aus');
        notesBtn.classList.toggle('sdk-notes-on', st.notesMode);
        setStatus(st.notesMode ? 'Notizen-Modus: 1–9 setzt kleine Kandidaten.' : 'Notizen-Modus aus.', '');
      }
      function bump(i, cls) {
        var b = cellEls[i].btn;
        b.classList.remove(cls); void b.offsetWidth; b.classList.add(cls);
      }
      function usable(i) {
        if (dead || finished || !st || st.solved) return false;
        if (isLocked()) { sfx('error'); setStatus('Gesperrt – kurz durchatmen …', 'bad'); return false; }
        if (i < 0) { setStatus('Erst eine Zelle wählen.', 'info'); sfx('error'); return false; }
        if (st.given[i]) { sfx('error'); setStatus('Vorgabe – die steht fest.', 'info'); return false; }
        if (st.val[i] && !st.wrong[i]) { sfx('error'); setStatus('Schon richtig gelöst.', 'info'); return false; }
        return true;
      }

      function place(v) {
        var i = st ? st.sel : -1;
        if (!usable(i)) return;
        if (st.notesMode) {
          if (st.val[i]) { st.val[i] = 0; st.wrong[i] = false; }   // falsche Zahl weicht der Notiz
          st.notes[i][v] = !st.notes[i][v];
          blip(st.notes[i][v] ? 700 : 420, 0.05);
          paint(); return;
        }
        st.notes[i] = [false, false, false, false, false, false, false, false, false, false];
        st.val[i] = v;
        if (v === st.sol[i]) {
          st.wrong[i] = false;
          clearPeerNotes(i, v);
          recalcScore();
          paint(); updateHead(); bump(i, 'sdk-pop');
          sfx('point');
          setStatus('Richtig! +20 Punkte', 'good');
          if (isSolved()) doSolved(); else report();
        } else {
          st.wrong[i] = true;
          paint(); updateHead(); bump(i, 'sdk-shake');
          sfx('error');
          addError();
        }
      }
      function erase() {
        var i = st ? st.sel : -1;
        if (!usable(i)) return;
        var had = st.val[i] || hasNotes(i);
        st.val[i] = 0; st.wrong[i] = false;
        st.notes[i] = [false, false, false, false, false, false, false, false, false, false];
        if (had) blip(300, 0.06);
        paint(); updateHead();
      }
      function hasNotes(i) {
        for (var k = 1; k <= 9; k++) if (st.notes[i][k]) return true;
        return false;
      }
      /* Nach einer richtigen Zahl den Kandidaten aus Zeile/Spalte/Block räumen. */
      function clearPeerNotes(i, v) {
        var r = Math.floor(i / 9), c = i % 9, b = boxOf(i);
        for (var j = 0; j < 81; j++) {
          if (j === i) continue;
          if (Math.floor(j / 9) === r || j % 9 === c || boxOf(j) === b) st.notes[j][v] = false;
        }
      }

      function addError() {
        st.errors++;
        updateHead();
        if (st.errors >= MAX_ERRORS) startLock();
        else setStatus('Falsch! Noch ' + (MAX_ERRORS - st.errors) + ' Fehler bis zur Sperre.', 'bad');
      }
      function startLock() {
        st.lockUntil = nowFn() + LOCK_MS;
        st.sel = -1;
        sfx('bust');
        setStatus('3 Fehler – 20 Sekunden Sperre!', 'bad');
        boardWrap.classList.add('sdk-is-locked');
        paint();
        stops.push(App.MG.roundTimer(st.lockUntil, function (left) {
          lockNum.textContent = Math.ceil(left) + 's';
        }, function () {
          if (dead || finished || !st) return;
          st.errors = 0; st.lockUntil = 0;
          boardWrap.classList.remove('sdk-is-locked');
          sfx('ding');
          setStatus('Frei! Die Herzen sind wieder voll.', 'good');
          updateHead(); paint();
        }, tNow));
      }

      function doSolved() {
        st.solved = true;
        st.solveMs = Math.max(0, nowFn() - st.startAt);
        st.timeBonus = Math.max(0, Math.round((st.endAt - nowFn()) / 1000) * 5);
        recalcScore();
        report();
        updateHead();
        sfx('jackpot');
        boardEl.classList.add('sdk-win');
        for (var i = 0; i < 81; i++) {
          cellEls[i].btn.style.animationDelay = ((Math.floor(i / 9) + (i % 9)) * 45) + 'ms';
        }
        setStatus('🎉 Gelöst in ' + App.MG.mmss(st.solveMs / 1000) + ' · +1000 Bonus · +' +
          st.timeBonus + ' Zeitbonus' + (isMulti ? ' · warte auf die anderen …' : ''), 'good');
        if (!isMulti) after(1800, finish);
      }

      /* ================= ANSICHT ================= */
      function setStatus(text, cls) {
        if (!statusEl) return;
        statusEl.textContent = text;
        statusEl.className = 'sdk-status' + (cls ? ' sdk-st-' + cls : '');
      }
      function updateHead() {
        scoreEl.textContent = App.MG.fmt(st.score);
        var p = pctDone();
        pctEl.textContent = p + ' %';
        barEl.style.width = p + '%';
        barEl.classList.toggle('sdk-bar-done', st.solved);
        heartsEl.innerHTML = '';
        for (var k = 0; k < MAX_ERRORS; k++) {
          heartsEl.appendChild(el('span', {
            class: 'sdk-heart' + (k < MAX_ERRORS - st.errors ? '' : ' sdk-heart-out')
          }, [k < MAX_ERRORS - st.errors ? '❤️' : '🖤']));
        }
        for (var v = 1; v <= 9; v++) {
          var rest = 9 - placedCount(v);
          var nb = numBtns[v - 1];
          nb.left.textContent = String(Math.max(0, rest));
          nb.btn.classList.toggle('sdk-np-done', rest <= 0);
        }
      }
      function placedCount(v) {
        var n = 0;
        for (var i = 0; i < 81; i++) if (st.val[i] === v && !st.wrong[i]) n++;
        return n;
      }
      function paint() {
        var sel = st.sel;
        var sr = sel >= 0 ? Math.floor(sel / 9) : -1;
        var sc = sel >= 0 ? sel % 9 : -1;
        var sb = sel >= 0 ? boxOf(sel) : -1;
        var selV = (sel >= 0 && !st.wrong[sel]) ? st.val[sel] : 0;
        for (var i = 0; i < 81; i++) {
          var ref = cellEls[i], v = st.val[i];
          var cls = 'sdk-cell';
          if (i % 9 === 2 || i % 9 === 5) cls += ' sdk-br';
          if (Math.floor(i / 9) === 2 || Math.floor(i / 9) === 5) cls += ' sdk-bb';
          if (st.given[i]) cls += ' sdk-given';
          if (st.wrong[i]) cls += ' sdk-wrong';
          else if (v && !st.given[i]) cls += ' sdk-ok';
          if (i === sel) cls += ' sdk-sel';
          else if (sr >= 0 && (Math.floor(i / 9) === sr || i % 9 === sc || boxOf(i) === sb)) cls += ' sdk-peer';
          if (selV && v === selV && !st.wrong[i]) cls += ' sdk-same';
          ref.btn.className = cls;
          ref.v.textContent = v ? String(v) : '';
          for (var k = 1; k <= 9; k++) {
            ref.notes[k - 1].style.visibility = (!v && st.notes[i][k]) ? 'visible' : 'hidden';
          }
        }
      }

      /* --- Live-Rangliste mit Prozent-Balken (multi) --- */
      function onPlayers() {
        if (dead || finished || !st) return;
        updateList();
        var ps = ctx.room.players();
        if (!ps.length || allDoneQueued) return;
        var all = ps.every(function (p) { return p.state && p.state.done; });
        if (all) { allDoneQueued = true; after(1500, finish); }
      }
      function updateList() {
        if (!listEl) return;
        var ps = ctx.room.players().slice().sort(function (a, b) { return (b.score || 0) - (a.score || 0); });
        listEl.innerHTML = '';
        ps.forEach(function (p, i) {
          var pc = (p.state && typeof p.state.pct === 'number') ? Math.max(0, Math.min(100, p.state.pct)) : 0;
          var done = !!(p.state && p.state.done);
          listEl.appendChild(el('div', { class: 'sdk-row sdk-row-' + (i + 1) + (p.id === ctx.me.id ? ' sdk-me' : '') }, [
            el('span', { class: 'sdk-rk' }, [String(i + 1)]),
            el('span', { class: 'sdk-nm' }, [(p.name || 'Spieler') + (p.id === ctx.me.id ? ' (du)' : '')]),
            el('span', { class: 'sdk-prog' }, [
              el('span', { class: 'sdk-prog-fill' + (done ? ' sdk-prog-done' : ''), style: 'width:' + pc + '%' })
            ]),
            el('span', { class: 'sdk-pc' }, [done ? '✅' : pc + '%']),
            el('span', { class: 'sdk-sc' }, [App.MG.fmt(p.score || 0)])
          ]));
        });
      }

      /* ================= TASTATUR ================= */
      function onKey(e) {
        if (dead || finished || !st) return;
        var t = e.target;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
        var k = e.key;
        if (k >= '1' && k <= '9') { e.preventDefault(); place(parseInt(k, 10)); return; }
        if (k === '0' || k === 'Delete' || k === 'Backspace') { e.preventDefault(); erase(); return; }
        if (k === 'n' || k === 'N') { e.preventDefault(); toggleNotes(); return; }
        var i = st.sel < 0 ? 40 : st.sel, tgt = -1;
        if (k === 'ArrowUp') tgt = i - 9;
        else if (k === 'ArrowDown') tgt = i + 9;
        else if (k === 'ArrowLeft') tgt = (i % 9 === 0) ? i : i - 1;
        else if (k === 'ArrowRight') tgt = (i % 9 === 8) ? i : i + 1;
        else return;
        e.preventDefault();
        if (st.sel < 0) tgt = 40;
        if (tgt >= 0 && tgt <= 80) selectCell(tgt);
      }

      /* ================= ENDE ================= */
      function finish() {
        if (finished || dead || !st) return;
        finished = true;
        clearPending(); stopHelpers();
        if (boardWrap) boardWrap.classList.remove('sdk-is-locked');
        recalcScore();

        if (isMulti) {
          report();
          setStatus(st.solved ? 'Gelöst! 🎉' : 'Zeit um!', st.solved ? 'good' : 'bad');
          after(1100, function () {
            App.MG.endScreen(root, { players: ctx.room.players(), meId: ctx.me.id, onExit: ctx.onExit });
          });
          return;
        }

        /* Solo: Bestpunktzahl + Rekordzeit je Stufe */
        var score = st.score, diff = st.diff, lv = LEVELS[diff];
        var best = App.Storage.get('best_sudokurace', 0);
        var nb = score > best;
        if (nb) App.Storage.set('best_sudokurace', score);

        var label;
        if (st.solved) {
          var tKey = 'bestT_sudokurace_' + diff;
          var bt = App.Storage.get(tKey, 0);
          var newT = !bt || st.solveMs < bt;
          if (newT) App.Storage.set(tKey, st.solveMs);
          label = lv.name + ' gelöst in ' + App.MG.mmss(st.solveMs / 1000) +
            (newT ? ' · neue Rekordzeit! ⏱️' : ' · Rekordzeit: ' + App.MG.mmss(bt / 1000));
        } else {
          label = lv.name + ' · ' + pctDone() + ' % geschafft – Zeit war um.';
        }
        label += nb ? ' · neue Bestpunktzahl! 🎉' : ' · Bestpunktzahl: ' + App.MG.fmt(best);

        App.MG.endScreen(root, {
          score: score, best: best, newBest: nb, label: label,
          onExit: ctx.onExit,
          onAgain: function () { showSoloMenu(); }
        });
      }
    }
  };

  /* ===================================================================
   *  STYLES  (alle Klassen mit sdk-Präfix)
   * =================================================================== */
  function injectStyle() {
    UI.injectStyle('mg-sudokurace-css', [
      '.sdk-wrap{display:flex;flex-direction:column;gap:12px;max-width:420px;margin:0 auto;}',

      /* --- Kopf --- */
      '.sdk-top{display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;}',
      '.sdk-brand{font-weight:900;font-size:17px;}',
      '.sdk-diff{font-size:11px;font-weight:800;letter-spacing:.4px;}',
      '.sdk-diff-leicht{color:var(--leaf);}',
      '.sdk-diff-mittel{color:var(--aqua);}',
      '.sdk-diff-schwer{color:var(--gold);}',
      '.sdk-head{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:10px 12px;}',
      '.sdk-hcell{display:flex;flex-direction:column;gap:2px;align-items:center;min-width:0;flex:1;}',
      '.sdk-hl{color:var(--muted);font-size:9px;text-transform:uppercase;letter-spacing:1px;font-weight:800;}',
      '.sdk-hv{font-size:clamp(15px,4.4vw,21px);font-weight:900;line-height:1;font-variant-numeric:tabular-nums;}',
      '.sdk-hv-score{color:var(--gold);text-shadow:0 0 10px rgba(255,210,63,.4);}',
      '.sdk-hv-pct{color:var(--leaf);}',
      '.sdk-timer{font-size:clamp(15px,4.4vw,21px);line-height:1;font-variant-numeric:tabular-nums;}',
      '.sdk-timer.sdk-urgent{color:var(--danger);animation:sdk-pulse .7s infinite;}',
      '.sdk-hearts{display:flex;gap:2px;line-height:1;font-size:13px;}',
      '.sdk-heart{transition:transform .2s,filter .2s;filter:drop-shadow(0 0 5px rgba(255,77,109,.5));}',
      '.sdk-heart-out{filter:none;opacity:.5;transform:scale(.85);}',

      /* --- Fortschrittsbalken --- */
      '.sdk-bar{height:5px;border-radius:99px;background:rgba(4,16,10,.8);border:1px solid var(--stroke);overflow:hidden;}',
      '.sdk-bar-fill{height:100%;width:0%;border-radius:99px;background:linear-gradient(90deg,var(--aqua),var(--neon));',
      'box-shadow:0 0 12px rgba(57,255,20,.55);transition:width .3s cubic-bezier(.2,.8,.3,1);}',
      '.sdk-bar-fill.sdk-bar-done{background:linear-gradient(90deg,var(--gold),var(--neon));animation:sdk-shimmer 1.4s ease-in-out infinite;}',

      '.sdk-status{text-align:center;font-weight:800;font-size:13px;min-height:18px;color:var(--muted);transition:color .15s;}',
      '.sdk-st-good{color:var(--neon);text-shadow:0 0 10px rgba(57,255,20,.4);}',
      '.sdk-st-bad{color:var(--danger);text-shadow:0 0 10px rgba(255,77,109,.4);}',
      '.sdk-st-info{color:var(--aqua);}',

      /* --- Brett --- */
      '.sdk-boardwrap{position:relative;width:100%;max-width:360px;margin:0 auto;}',
      '.sdk-board{display:grid;grid-template-columns:repeat(9,1fr);grid-template-rows:repeat(9,1fr);',
      'aspect-ratio:1/1;width:100%;border:2px solid var(--stroke-2);border-radius:12px;overflow:hidden;',
      'background:rgba(4,16,10,.72);box-shadow:0 0 26px rgba(57,255,20,.12),inset 0 0 40px rgba(0,0,0,.35);',
      'touch-action:manipulation;}',
      '.sdk-cell{position:relative;box-sizing:border-box;padding:0;margin:0;display:flex;align-items:center;',
      'justify-content:center;background:transparent;color:var(--text);font-family:inherit;cursor:pointer;',
      'border:0;border-right:1px solid var(--stroke);border-bottom:1px solid var(--stroke);',
      'user-select:none;-webkit-user-select:none;-webkit-tap-highlight-color:transparent;',
      'transition:background .12s,box-shadow .15s;}',
      '.sdk-cell.sdk-br{border-right:2px solid var(--stroke-2);}',
      '.sdk-cell.sdk-bb{border-bottom:2px solid var(--stroke-2);}',
      '.sdk-v{font-size:clamp(14px,4.6vw,22px);font-weight:800;line-height:1;font-variant-numeric:tabular-nums;',
      'pointer-events:none;transition:color .12s;}',
      '.sdk-cell.sdk-given{background:rgba(9,32,21,.75);cursor:default;}',
      '.sdk-cell.sdk-given .sdk-v{color:var(--silver);font-weight:900;}',
      '.sdk-cell.sdk-ok .sdk-v{color:var(--neon);text-shadow:0 0 8px rgba(57,255,20,.5);}',
      '.sdk-cell.sdk-wrong{background:rgba(255,77,109,.16);}',
      '.sdk-cell.sdk-wrong .sdk-v{color:var(--danger);text-shadow:0 0 9px rgba(255,77,109,.6);}',
      '.sdk-cell.sdk-peer{background:rgba(51,230,208,.07);}',
      '.sdk-cell.sdk-given.sdk-peer{background:rgba(30,60,48,.8);}',
      '.sdk-cell.sdk-same{background:rgba(255,210,63,.14);}',
      '.sdk-cell.sdk-same .sdk-v{text-shadow:0 0 10px rgba(255,210,63,.6);}',
      '.sdk-cell.sdk-sel{background:rgba(57,255,20,.2);box-shadow:inset 0 0 0 2px var(--neon),0 0 16px rgba(57,255,20,.35);z-index:2;}',
      '.sdk-cell:not(.sdk-given):hover{background:rgba(57,255,20,.1);}',
      '.sdk-cell.sdk-pop .sdk-v{animation:sdk-pop .26s cubic-bezier(.2,.9,.3,1.4);}',
      '.sdk-cell.sdk-shake{animation:sdk-shake .3s ease;}',
      '.sdk-board.sdk-win .sdk-cell{animation:sdk-wave .7s ease both;}',

      /* Notizen */
      '.sdk-notes{position:absolute;inset:1px;display:grid;grid-template-columns:repeat(3,1fr);',
      'grid-template-rows:repeat(3,1fr);pointer-events:none;}',
      '.sdk-n{display:flex;align-items:center;justify-content:center;font-size:clamp(6px,1.8vw,9px);',
      'font-weight:800;line-height:1;color:var(--aqua);opacity:.85;visibility:hidden;}',

      /* Sperre */
      '.sdk-lock{position:absolute;inset:0;display:none;flex-direction:column;align-items:center;justify-content:center;',
      'gap:6px;border-radius:12px;background:rgba(6,10,8,.86);backdrop-filter:blur(3px);z-index:5;text-align:center;padding:12px;}',
      '.sdk-boardwrap.sdk-is-locked .sdk-lock{display:flex;animation:sdk-fade .2s ease;}',
      '.sdk-boardwrap.sdk-is-locked .sdk-board{pointer-events:none;filter:grayscale(.6);}',
      '.sdk-lock-ic{font-size:38px;line-height:1;animation:sdk-pulse 1.1s infinite;}',
      '.sdk-lock-t{font-weight:900;color:var(--danger);font-size:14px;}',
      '.sdk-lock-num{font-size:34px;font-weight:900;color:var(--gold);font-variant-numeric:tabular-nums;',
      'text-shadow:0 0 14px rgba(255,210,63,.5);}',

      /* --- Ziffernblock --- */
      '.sdk-tools{margin:0;}',
      '.sdk-notesbtn{font-size:13px;padding:8px 14px;}',
      '.sdk-notesbtn.sdk-notes-on{border-color:var(--aqua);color:var(--aqua);box-shadow:0 0 14px rgba(51,230,208,.35);}',
      '.sdk-pad{display:grid;grid-template-columns:repeat(5,1fr);gap:7px;max-width:360px;width:100%;margin:0 auto;}',
      '.sdk-np{position:relative;min-height:46px;border-radius:12px;border:1px solid var(--stroke);',
      'background:rgba(9,32,21,.65);color:var(--text);font-family:inherit;cursor:pointer;display:flex;',
      'align-items:center;justify-content:center;padding:0;-webkit-tap-highlight-color:transparent;',
      'touch-action:manipulation;transition:transform .1s,border-color .15s,box-shadow .15s,opacity .2s;}',
      '.sdk-np-d{font-size:20px;font-weight:900;line-height:1;color:var(--leaf);}',
      '.sdk-np-left{position:absolute;top:3px;right:5px;font-size:9px;font-weight:800;color:var(--muted);line-height:1;}',
      '.sdk-np:hover{border-color:var(--neon);box-shadow:0 0 14px rgba(57,255,20,.3);transform:translateY(-2px);}',
      '.sdk-np:active{transform:scale(.94);}',
      '.sdk-np.sdk-np-done{opacity:.34;}',
      '.sdk-np.sdk-np-done .sdk-np-d{color:var(--muted);}',
      '.sdk-np-del .sdk-np-d{color:var(--danger);}',
      '.sdk-np-del:hover{border-color:var(--danger);box-shadow:0 0 14px rgba(255,77,109,.3);}',
      '.sdk-rules{font-size:11px;text-align:center;margin:0;line-height:1.5;}',

      /* --- Rangliste --- */
      '.sdk-listwrap{padding:12px;display:flex;flex-direction:column;gap:8px;}',
      '.sdk-list{display:flex;flex-direction:column;gap:5px;max-height:230px;overflow-y:auto;}',
      '.sdk-row{display:flex;align-items:center;gap:7px;padding:6px 9px;border-radius:10px;',
      'background:rgba(9,32,21,.55);border:1px solid var(--stroke);font-size:12px;}',
      '.sdk-row.sdk-me{border-color:var(--neon);box-shadow:0 0 12px rgba(57,255,20,.22);}',
      '.sdk-rk{width:16px;text-align:center;font-weight:900;color:var(--muted);flex:none;}',
      '.sdk-row-1 .sdk-rk{color:var(--gold);}',
      '.sdk-row-2 .sdk-rk{color:var(--silver);}',
      '.sdk-row-3 .sdk-rk{color:var(--bronze);}',
      '.sdk-nm{flex:1;min-width:0;font-weight:800;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      '.sdk-row.sdk-me .sdk-nm{color:var(--aqua);}',
      '.sdk-prog{flex:none;width:58px;height:6px;border-radius:99px;background:rgba(4,16,10,.9);',
      'border:1px solid var(--stroke);overflow:hidden;}',
      '.sdk-prog-fill{display:block;height:100%;border-radius:99px;background:linear-gradient(90deg,var(--aqua),var(--neon));',
      'transition:width .35s cubic-bezier(.2,.8,.3,1);}',
      '.sdk-prog-fill.sdk-prog-done{background:var(--gold);box-shadow:0 0 10px rgba(255,210,63,.7);}',
      '.sdk-pc{flex:none;width:34px;text-align:right;font-weight:800;color:var(--leaf);font-variant-numeric:tabular-nums;}',
      '.sdk-sc{flex:none;width:44px;text-align:right;font-weight:900;color:var(--gold);font-variant-numeric:tabular-nums;}',

      /* --- Menü / Warten --- */
      '.sdk-menu{padding:26px 20px;text-align:center;display:flex;flex-direction:column;gap:12px;',
      'align-items:center;max-width:420px;margin:0 auto;animation:sdk-fade .3s ease both;}',
      '.sdk-menu h2{margin:0;}',
      '.sdk-menu-ic{font-size:50px;line-height:1;filter:drop-shadow(0 0 14px rgba(57,255,20,.45));}',
      '.sdk-menu-ic.sdk-spin{animation:sdk-spin 1.6s linear infinite;}',
      '.sdk-menu-best{margin:0;font-size:12px;font-weight:800;color:var(--gold);}',
      '.sdk-lvls{display:flex;flex-direction:column;gap:9px;width:100%;}',
      '.sdk-lvl{display:flex;align-items:center;gap:11px;width:100%;padding:11px 13px;border-radius:14px;',
      'border:1px solid var(--stroke);background:rgba(9,32,21,.6);color:var(--text);font-family:inherit;',
      'cursor:pointer;text-align:left;transition:transform .12s,border-color .15s,box-shadow .15s;}',
      '.sdk-lvl:hover{transform:translateY(-2px);border-color:var(--neon);box-shadow:0 0 18px rgba(57,255,20,.3);}',
      '.sdk-lvl:active{transform:scale(.98);}',
      '.sdk-lvl-ic{font-size:24px;line-height:1;flex:none;}',
      '.sdk-lvl-txt{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px;}',
      '.sdk-lvl-nm{font-weight:900;font-size:15px;}',
      '.sdk-lvl-sub{font-size:11px;color:var(--muted);}',
      '.sdk-lvl-rec{flex:none;font-size:11px;font-weight:800;color:var(--gold);font-variant-numeric:tabular-nums;}',
      '.sdk-lvl-leicht .sdk-lvl-nm{color:var(--leaf);}',
      '.sdk-lvl-mittel .sdk-lvl-nm{color:var(--aqua);}',
      '.sdk-lvl-schwer .sdk-lvl-nm{color:var(--gold);}',

      /* --- Animationen --- */
      '@keyframes sdk-pop{0%{transform:scale(.4);opacity:.3}70%{transform:scale(1.3)}100%{transform:scale(1);opacity:1}}',
      '@keyframes sdk-shake{0%,100%{transform:translateX(0)}25%{transform:translateX(-4px)}75%{transform:translateX(4px)}}',
      '@keyframes sdk-pulse{0%,100%{opacity:1}50%{opacity:.4}}',
      '@keyframes sdk-fade{from{opacity:0}to{opacity:1}}',
      '@keyframes sdk-spin{to{transform:rotate(360deg)}}',
      '@keyframes sdk-shimmer{0%,100%{filter:brightness(1)}50%{filter:brightness(1.5)}}',
      '@keyframes sdk-wave{0%{background:transparent}40%{background:rgba(255,210,63,.5);transform:scale(1.06)}100%{background:transparent;transform:scale(1)}}'
    ].join(''));
  }
})();
