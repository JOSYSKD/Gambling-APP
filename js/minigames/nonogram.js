/* nonogram.js — "Nonogramm" (Picross) im Neon-Dschungel.
 *
 * IDEE:     Ein Gitter (5×5 -> 8×8 -> 10×10) mit Zahlen-Hinweisen an Zeilen und
 *           Spalten. Die Zahlen sagen, wie lang die zusammenhängenden Blöcke
 *           sind. Wer richtig füllt, deckt Stück für Stück ein kleines
 *           Pixelbild auf (Herz, Katze, Rakete …). Bild gelöst -> nächstes.
 *
 * STEUERUNG: Tippen/Klicken färbt ein Feld, Ziehen malt eine ganze Reihe.
 *           Zwei Modi über die Knöpfe: 🟩 Füllen / ❌ Markieren (Merk-Kreuz).
 *           Rechtsklick markiert direkt, Tastatur: [Leer]/[X] wechselt den Modus,
 *           [1] = Füllen, [2] = Markieren. Alles auch per Touch (pointer-Events).
 *
 * PUNKTE:   Pro gelöstem Bild = Grundwert (5×5:100 / 8×8:250 / 10×10:400)
 *           + Tempo-Bonus (4 Punkte je Sekunde unter der Par-Zeit)
 *           − 25 je Fehler, aber nie unter 30 % des Grundwerts.
 *           Falsch gefülltes Feld = Fehler (wird als ❌ aufgedeckt),
 *           3 Fehler = 5 s Sperre. Runde dauert 4 Minuten.
 *
 * SYNC:     Multiplayer — der Host würfelt EINEN Seed und verteilt ihn per
 *           room.setShared({ non: { seed } }); alle Clients bauen daraus lokal
 *           dieselbe Bilder-Reihenfolge (seeded RNG + seeded Mischen der
 *           Bild-Bibliothek), also exakt dasselbe Rätsel für jeden. Sollte der
 *           Seed beim Start noch fehlen, dient die (für alle identische)
 *           round.startAt als Notnagel; ein später eintreffender Seed wird nur
 *           übernommen, solange noch nichts gelöst ist -> Handler idempotent.
 *           Gespielt wird jeder für sich, gemeldet wird nur der Punktestand
 *           (room.reportScore) -> Live-Rangliste. Alle Timer laufen über
 *           Wall-Clock (room.now / Date.now) -> Tab-Wechsel-sicher.
 *
 * SOLO:     Gleiche 4 Minuten, Punktejagd gegen den eigenen Rekord
 *           (App.Storage 'best_nonogram'), Rekord steht sichtbar im Kopf.
 */
(function () {
  'use strict';
  window.App = window.App || {}; App.Minigames = App.Minigames || {};
  var UI = App.UI, el = UI.el;

  injectStyle();

  var DURATION = 240;          // s Rundenzeit
  var MAX_ERRORS = 3;          // Fehler bis zur Sperre
  var LOCK_MS = 5000;          // Dauer der Sperre
  var BASE = { 5: 100, 8: 250, 10: 400 };   // Grundwert je Bildgröße
  var PAR = { 5: 40, 8: 100, 10: 160 };     // Par-Zeit in Sekunden

  /* ================= Bild-Bibliothek (# = gefüllt) ================= */
  var PICS = {
    5: [
      { n: 'Herz', e: '💚', g: ['.#.#.', '#####', '#####', '.###.', '..#..'] },
      { n: 'Stern', e: '⭐', g: ['..#..', '.###.', '#####', '.###.', '#...#'] },
      { n: 'Gesicht', e: '🙂', g: ['.###.', '#.#.#', '#####', '#...#', '.###.'] },
      { n: 'Baum', e: '🌳', g: ['..#..', '.###.', '#####', '..#..', '..#..'] },
      { n: 'Pilz', e: '🍄', g: ['.###.', '#####', '#####', '..#..', '..#..'] },
      { n: 'Krone', e: '👑', g: ['#.#.#', '#####', '#####', '#####', '#.#.#'] },
      { n: 'Blatt', e: '🍃', g: ['..##.', '.###.', '####.', '###..', '#....'] },
      { n: 'Haus', e: '🏠', g: ['..#..', '.###.', '#####', '#...#', '#.#.#'] }
    ],
    8: [
      { n: 'Herz', e: '💚', g: ['.##..##.', '########', '########', '########', '########', '.######.', '..####..', '...##...'] },
      { n: 'Stern', e: '⭐', g: ['...##...', '...##...', '.######.', '########', '.######.', '..####..', '.##..##.', '##....##'] },
      { n: 'Katze', e: '🐱', g: ['#......#', '##....##', '########', '#.####.#', '########', '###..###', '.######.', '..####..'] },
      { n: 'Baum', e: '🌳', g: ['...##...', '..####..', '.######.', '########', '.######.', '..####..', '...##...', '...##...'] },
      { n: 'Pilz', e: '🍄', g: ['..####..', '.######.', '########', '########', '..####..', '...##...', '...##...', '..####..'] },
      { n: 'Rakete', e: '🚀', g: ['...##...', '..####..', '..####..', '..####..', '.######.', '########', '..#..#..', '...##...'] },
      { n: 'Fisch', e: '🐟', g: ['.....##.', '..###.##', '.#######', '########', '########', '.#######', '..###.##', '.....##.'] },
      { n: 'Blume', e: '🌺', g: ['.##..##.', '########', '.######.', '..####..', '...##...', '..###...', '...##...', '..####..'] },
      { n: 'Krone', e: '👑', g: ['#..##..#', '#.####.#', '########', '########', '########', '########', '#.#..#.#', '########'] },
      { n: 'Geist', e: '👻', g: ['..####..', '.######.', '########', '#.####.#', '########', '########', '########', '#.#..#.#'] }
    ],
    10: [
      { n: 'Herz', e: '💚', g: ['..##..##..', '.########.', '##########', '##########', '##########', '##########', '.########.', '..######..', '...####...', '....##....'] },
      { n: 'Stern', e: '⭐', g: ['....##....', '....##....', '...####...', '.########.', '##########', '.########.', '..######..', '..##..##..', '.##....##.', '##......##'] },
      { n: 'Katze', e: '🐱', g: ['##......##', '###....###', '##########', '##########', '#.######.#', '##########', '####..####', '##########', '.########.', '..######..'] },
      { n: 'Baum', e: '🌳', g: ['....##....', '...####...', '..######..', '.########.', '##########', '.########.', '..######..', '....##....', '....##....', '...####...'] },
      { n: 'Pilz', e: '🍄', g: ['...####...', '.########.', '##########', '##########', '##########', '..######..', '....##....', '....##....', '...####...', '..######..'] },
      { n: 'Rakete', e: '🚀', g: ['....##....', '...####...', '...####...', '..######..', '..######..', '.########.', '##########', '...#..#...', '...#..#...', '....##....'] },
      { n: 'Geist', e: '👻', g: ['...####...', '..######..', '.########.', '##########', '##.####.##', '##.####.##', '##########', '##########', '##########', '#.#.##.#.#'] },
      { n: 'Blume', e: '🌺', g: ['..##..##..', '.########.', '.########.', '..######..', '...####...', '....##....', '...###....', '....##....', '....###...', '...####...'] },
      { n: 'Krone', e: '👑', g: ['#...##...#', '#..####..#', '#.######.#', '##########', '##########', '##########', '##########', '#.#....#.#', '##########', '##########'] }
    ]
  };

  /* ================= Seeded RNG + Generator ================= */

  /* Deterministischer Zufall (mulberry32) — gleicher Seed = gleiche Bilder. */
  function rngFrom(seed) {
    var s = (seed >>> 0) || 1;
    return function () {
      s = (s + 0x6D2B79F5) >>> 0;
      var t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function shuffled(len, rnd) {
    var a = [], i, j, t;
    for (i = 0; i < len; i++) a.push(i);
    for (i = a.length - 1; i > 0; i--) { j = Math.floor(rnd() * (i + 1)); t = a[i]; a[i] = a[j]; a[j] = t; }
    return a;
  }
  function gridFromRows(rows) {
    var g = [], y, x;
    for (y = 0; y < rows.length; y++) {
      g[y] = [];
      for (x = 0; x < rows[y].length; x++) g[y][x] = rows[y].charAt(x) === '#' ? 1 : 0;
    }
    return g;
  }

  /* Zeichnet ein paar zufällige, links-rechts gespiegelte Kleckse. */
  function drawBlobs(size, rnd) {
    var g = [], y, x, b, half = Math.ceil(size / 2);
    for (y = 0; y < size; y++) { g[y] = []; for (x = 0; x < size; x++) g[y][x] = 0; }
    var blobs = 2 + Math.floor(rnd() * 3);
    for (b = 0; b < blobs; b++) {
      var cx = Math.floor(rnd() * half), cy = 1 + Math.floor(rnd() * (size - 2));
      var r = 1 + rnd() * (size / 4.5), rr = r * r;
      for (y = 0; y < size; y++) {
        for (x = 0; x < half; x++) {
          var dx = x - cx, dy = y - cy;
          if (dx * dx + dy * dy <= rr) { g[y][x] = 1; g[y][size - 1 - x] = 1; }
        }
      }
    }
    return g;
  }

  /* Generator: gespiegeltes Zufalls-Pixelbild. Wird gebraucht, wenn die
     Bibliothek einer Größe aufgebraucht ist. Es wird so lange neu gewürfelt,
     bis die Füll-Dichte im spielbaren Bereich liegt — ein komplett volles oder
     fast leeres Gitter wäre kein Rätsel (alle Hinweise wären trivial).
     Alles läuft über den übergebenen Seed-RNG -> bei allen gleich. */
  function genPicture(size, rnd) {
    var best = null, bestOff = Infinity, a, g, d;
    for (a = 0; a < 14; a++) {
      g = drawBlobs(size, rnd);
      d = countFilled(g) / (size * size);
      if (d >= 0.25 && d <= 0.6) { best = g; break; }
      var off = Math.abs(d - 0.42);
      if (off < bestOff) { bestOff = off; best = g; }
    }
    return { name: 'Zufalls-Klecks', emoji: '🌀', grid: best };
  }

  /* ================= Hinweise ================= */
  function runsOf(line) {
    var out = [], run = 0, i;
    for (i = 0; i < line.length; i++) {
      if (line[i]) run++;
      else { if (run) out.push(run); run = 0; }
    }
    if (run) out.push(run);
    if (!out.length) out.push(0);
    return out;
  }
  function computeClues(g, n) {
    var rows = [], cols = [], y, x, line;
    for (y = 0; y < n; y++) rows.push(runsOf(g[y]));
    for (x = 0; x < n; x++) { line = []; for (y = 0; y < n; y++) line.push(g[y][x]); cols.push(runsOf(line)); }
    return { rows: rows, cols: cols };
  }
  function countFilled(g) {
    var c = 0, y, x;
    for (y = 0; y < g.length; y++) for (x = 0; x < g[y].length; x++) c += g[y][x];
    return c;
  }

  /* Bild Nr. i wird immer nur aus Seed + Index abgeleitet -> alle Geräte
     bekommen ohne weiteren Netzverkehr exakt dasselbe Rätsel. */
  function sizeForIndex(i) { return i === 0 ? 5 : (i <= 2 ? 8 : 10); }
  function makeDecks(seed) {
    return {
      5: shuffled(PICS[5].length, rngFrom(seed + 11)),
      8: shuffled(PICS[8].length, rngFrom(seed + 22)),
      10: shuffled(PICS[10].length, rngFrom(seed + 33))
    };
  }
  function puzzleAt(seed, decks, i) {
    var size = sizeForIndex(i), k = 0, j, pic, src;
    for (j = 0; j < i; j++) if (sizeForIndex(j) === size) k++;
    var deck = decks[size];
    if (k < deck.length) {
      src = PICS[size][deck[k]];
      pic = { name: src.n, emoji: src.e, grid: gridFromRows(src.g) };
    } else {
      pic = genPicture(size, rngFrom(seed + 7919 * (i + 1)));
    }
    pic.size = size;
    pic.clues = computeClues(pic.grid, size);
    pic.count = countFilled(pic.grid);
    return pic;
  }

  /* ================= Spiel ================= */
  App.Minigames.nonogram = {
    id: 'nonogram', title: 'Nonogramm', icon: '🖼️', order: 158,
    subtitle: 'Zahlen lesen, Pixelbilder aufdecken',
    single: true, multi: true, minPlayers: 2, maxPlayers: 8,

    render: function (root, ctx) {
      var isMulti = ctx.mode === 'multi';
      var nowFn = isMulti ? ctx.room.now : function () { return Date.now(); };

      var dead = false;
      var stops = [];        // Room-Listener + Countdown (nur cleanup)
      var roundStops = [];   // Timer/Listener der laufenden Runde
      var pending = [];      // setTimeout-IDs

      /* Zustand */
      var seed = 0, decks = null, started = false, finished = false;
      var score = 0, solved = 0, errors = 0, filled = 0;
      var mode = 'fill', locked = false, lockTimer = null;
      var puz = null, puzIndex = 0, puzStart = 0, endAt = 0;
      var state = [], cells = [], cellBase = [], rowClueEls = [], colClueEls = [];
      var dragging = false, dragAct = 'fill', dragLast = -1;
      var refs = {};

      function after(ms, fn) { var t = setTimeout(function () { if (!dead) fn(); }, ms); pending.push(t); return t; }
      function clearPending() { pending.forEach(clearTimeout); pending = []; }
      function stopAll(list) { list.forEach(function (f) { try { f(); } catch (e) {} }); list.length = 0; }
      function stopRound() { stopAll(roundStops); }
      function cleanup() { dead = true; clearPending(); stopRound(); stopAll(stops); }

      /* ---------- Start ---------- */
      if (isMulti) {
        var snap = ctx.room.snapshot() || {};
        var startAt = (snap.round && snap.round.startAt) || (ctx.room.now() + 3000);
        var sh0 = snap.shared || {};
        if (sh0.non && sh0.non.seed) seed = sh0.non.seed >>> 0;
        if (!seed && ctx.room.isHost()) {
          seed = (Math.floor(Math.random() * 1000000000) + 1) >>> 0;
          ctx.room.setShared({ non: { seed: seed } });
        }
        var onShared = function (s) {
          if (dead || !s || !s.non || !s.non.seed) return;
          var ns = s.non.seed >>> 0;
          if (ns === seed) return;                       // Heartbeat -> nichts tun
          if (started && solved > 0) return;             // läuft schon -> nicht mehr umstellen
          seed = ns;
          if (started) { decks = makeDecks(seed); newPuzzle(0); }   // ganz am Anfang: Rätsel angleichen
        };
        ctx.room.on('shared', onShared);
        stops.push(function () { ctx.room.off('shared', onShared); });
        stops.push(App.MG.countdown(root, startAt, function () {
          if (!seed) seed = (startAt % 2147483647) >>> 0 || 1;   // Notnagel: startAt hat jeder
          play(startAt);
        }, ctx.room.now));
      } else {
        play(nowFn());
      }
      return { cleanup: cleanup };

      /* ===================== Runde ===================== */
      function play(startAt) {
        clearPending(); stopRound();
        started = true; finished = false;
        score = 0; solved = 0; errors = 0; mode = 'fill'; locked = false; lockTimer = null;
        if (!seed) seed = (Math.floor(Math.random() * 1000000000) + 1) >>> 0;
        decks = makeDecks(seed);
        endAt = startAt + DURATION * 1000;

        buildLayout();
        newPuzzle(0);
        if (isMulti) ctx.room.reportScore(0);

        roundStops.push(App.MG.roundTimer(endAt, function (left) {
          refs.timer.textContent = App.MG.mmss(left);
          if (left <= 15) refs.timer.classList.add('non-urgent');
        }, finish, isMulti ? ctx.room.now : null));
      }

      /* ---------- Grundgerüst ---------- */
      function buildLayout() {
        refs = {};
        refs.score = el('div', { class: 'non-score' }, ['0']);
        refs.pic = el('div', { class: 'non-pic' }, ['#1']);
        refs.timer = el('div', { class: 'mg-timer' }, [App.MG.mmss(DURATION)]);
        var best = isMulti ? 0 : App.Storage.get('best_nonogram', 0);
        var head = el('div', { class: 'non-head glass' }, [
          el('div', { class: 'non-hcell' }, [el('span', { class: 'non-hl' }, ['Punkte']), refs.score]),
          el('div', { class: 'non-hcell non-hmid' }, [el('span', { class: 'non-hl' }, ['Bild']), refs.pic]),
          el('div', { class: 'non-hcell non-hright' }, [el('span', { class: 'non-hl' }, ['Zeit']), refs.timer])
        ]);

        var hint = el('p', { class: 'hint-text non-rules' }, [
          'Zahlen = Blöcke am Stück · Ziehen malt mehrere Felder · Rechtsklick oder ❌-Modus markiert · 3 Fehler = 5 s Pause'
        ]);

        /* Brett + Overlays */
        refs.board = el('div', { class: 'non-boardhost' });
        refs.lockNum = el('div', { class: 'non-lock-num' }, ['5']);
        refs.lock = el('div', { class: 'non-lock' }, [
          el('div', { class: 'non-lock-ico' }, ['🚫']),
          el('div', { class: 'non-lock-t' }, ['Zu viele Fehler!']),
          refs.lockNum
        ]);
        refs.solvedIco = el('div', { class: 'non-sv-ico' }, ['🎉']);
        refs.solvedName = el('div', { class: 'non-sv-name neon' }, ['']);
        refs.solvedPts = el('div', { class: 'non-sv-pts' }, ['']);
        refs.solvedSub = el('div', { class: 'non-sv-sub' }, ['']);
        refs.solved = el('div', { class: 'non-solved' }, [refs.solvedIco, refs.solvedName, refs.solvedPts, refs.solvedSub]);
        var wrap = el('div', { class: 'non-boardwrap glass' }, [refs.board, refs.lock, refs.solved]);

        /* Werkzeugleiste */
        refs.bFill = el('button', {
          class: 'btn btn-ghost non-mode is-on', type: 'button',
          onclick: function () { setMode('fill'); }
        }, ['🟩 Füllen']);
        refs.bMark = el('button', {
          class: 'btn btn-ghost non-mode', type: 'button',
          onclick: function () { setMode('mark'); }
        }, ['❌ Markieren']);
        refs.dots = [];
        var dotBox = el('div', { class: 'non-dots' });
        for (var d = 0; d < MAX_ERRORS; d++) { var dot = el('span', { class: 'non-dot' }); refs.dots.push(dot); dotBox.appendChild(dot); }
        var errBox = el('div', { class: 'non-errbox' }, [el('span', { class: 'non-hl' }, ['Fehler']), dotBox]);
        var tools = el('div', { class: 'non-tools glass' }, [
          el('div', { class: 'non-modes' }, [refs.bFill, refs.bMark]), errBox
        ]);

        /* Rangliste (multi) bzw. Rekord (solo) */
        var side = null;
        if (isMulti) {
          var board = App.MG.liveBoard(ctx.room, ctx.me.id);
          roundStops.push(board.stop);
          side = el('div', { class: 'non-side glass' }, [el('div', { class: 'mg-field-title' }, ['🏆 Rangliste']), board.root]);
        } else {
          side = el('div', { class: 'non-side non-solo glass' }, [
            el('span', { class: 'chip' }, ['🏅 Rekord: ' + App.MG.fmt(best)]),
            el('span', { class: 'chip' }, ['🖼️ Gelöst: ', refs.soloSolved = el('b', { class: 'non-solo-v' }, ['0'])])
          ]);
        }

        root.innerHTML = '';
        root.appendChild(el('div', { class: 'non-layout' }, [head, hint, wrap, tools, side]));

        /* Eingabe: Tastatur + globales pointerup (Drag-Ende ausserhalb des Bretts) */
        function keyHandler(e) {
          if (dead || finished) return;
          var k = e.key;
          if (k === ' ' || k === 'x' || k === 'X') { e.preventDefault(); setMode(mode === 'fill' ? 'mark' : 'fill'); }
          else if (k === '1') setMode('fill');
          else if (k === '2') setMode('mark');
        }
        document.addEventListener('keydown', keyHandler);
        function upHandler() { dragging = false; dragLast = -1; }
        window.addEventListener('pointerup', upHandler);
        window.addEventListener('pointercancel', upHandler);
        roundStops.push(function () {
          document.removeEventListener('keydown', keyHandler);
          window.removeEventListener('pointerup', upHandler);
          window.removeEventListener('pointercancel', upHandler);
        });
      }

      function setMode(m) {
        if (mode !== m && App.Audio) App.Audio.sfx('click');
        mode = m;
        refs.bFill.classList.toggle('is-on', m === 'fill');
        refs.bMark.classList.toggle('is-on', m === 'mark');
      }

      /* ---------- neues Rätsel ---------- */
      function newPuzzle(i) {
        puzIndex = i;
        puz = puzzleAt(seed, decks, i);
        var n = puz.size, k;
        state = []; for (k = 0; k < n * n; k++) state.push(0);
        filled = 0; errors = 0; locked = false;
        if (lockTimer) { clearInterval(lockTimer); lockTimer = null; }
        puzStart = nowFn();
        refs.pic.textContent = '#' + (i + 1) + ' · ' + n + '×' + n;
        refs.lock.classList.remove('is-on');
        refs.solved.classList.remove('is-on');
        updateDots();
        renderBoard();
      }

      function renderBoard() {
        var n = puz.size, cl = puz.clues, x, y, i;
        var maxRow = 1, maxCol = 1;
        for (i = 0; i < n; i++) {
          if (cl.rows[i].length > maxRow) maxRow = cl.rows[i].length;
          if (cl.cols[i].length > maxCol) maxCol = cl.cols[i].length;
        }
        var grid = el('div', { class: 'non-grid non-n' + n });
        grid.style.gridTemplateColumns = 'calc(' + maxRow + ' * 1.15em + .4em) repeat(' + n + ',1fr)';
        grid.style.gridTemplateRows = 'calc(' + maxCol + ' * 1.2em + .4em) repeat(' + n + ',auto)';

        function nums(list) {
          return list.map(function (v) { return el('span', { class: 'non-num' }, [String(v)]); });
        }
        function sepR(x2) { return ((x2 + 1) % 5 === 0 && x2 < n - 1) ? ' non-sepr' : ''; }
        function sepB(y2) { return ((y2 + 1) % 5 === 0 && y2 < n - 1) ? ' non-sepb' : ''; }

        grid.appendChild(el('div', { class: 'non-corner' }, ['🖼️']));
        colClueEls = [];
        for (x = 0; x < n; x++) {
          var cc = el('div', { class: 'non-cc' + sepR(x) }, nums(cl.cols[x]));
          colClueEls.push(cc); grid.appendChild(cc);
        }
        cells = []; cellBase = []; rowClueEls = [];
        for (y = 0; y < n; y++) {
          var rc = el('div', { class: 'non-rc' + sepB(y) }, nums(cl.rows[y]));
          rowClueEls.push(rc); grid.appendChild(rc);
          for (x = 0; x < n; x++) {
            var idx = y * n + x;
            var base = 'non-cell' + sepR(x) + sepB(y);
            var b = el('button', { class: base, type: 'button', dataset: { i: String(idx) }, 'aria-label': 'Feld ' + (x + 1) + '/' + (y + 1) });
            cellBase.push(base); cells.push(b); grid.appendChild(b);
          }
        }

        grid.addEventListener('pointerdown', onDown);
        grid.addEventListener('pointermove', onMove);
        grid.addEventListener('contextmenu', onCtx);

        refs.board.innerHTML = '';
        refs.board.appendChild(grid);
        refs.grid = grid;
      }

      /* ---------- Eingabe auf dem Brett ---------- */
      function cellAt(e) {
        var t = document.elementFromPoint(e.clientX, e.clientY);
        if (!t || !t.classList || !t.classList.contains('non-cell')) return -1;
        var v = t.dataset ? t.dataset.i : null;
        return v == null ? -1 : parseInt(v, 10);
      }
      function onDown(e) {
        if (e.button === 2) return;               // Rechtsklick läuft über contextmenu
        var i = cellAt(e);
        if (i < 0) return;
        e.preventDefault();
        var act = mode;
        if (mode === 'mark' && state[i] === 2) act = 'unmark';
        dragging = true; dragAct = act; dragLast = -1;
        apply(i, act);
      }
      function onMove(e) {
        if (!dragging) return;
        var i = cellAt(e);
        if (i < 0 || i === dragLast) return;
        e.preventDefault();
        apply(i, dragAct);
      }
      function onCtx(e) {
        var i = cellAt(e);
        e.preventDefault();
        if (i < 0) return;
        apply(i, state[i] === 2 ? 'unmark' : 'mark');
      }

      function apply(i, act) {
        if (dead || finished || locked || !puz) return;
        dragLast = i;
        var n = puz.size, y = Math.floor(i / n), x = i % n;
        var sol = puz.grid[y][x];
        if (act === 'fill') {
          if (state[i] !== 0) return;
          if (sol === 1) {
            state[i] = 1; filled++;
            paintCell(i, 'non-pop');
            refreshLines(y, x);
            if (App.Audio) App.Audio.blip(430 + (x + y) * 14, 0.03);
            if (filled >= puz.count) solve();
          } else {
            state[i] = 2;
            paintCell(i, 'non-wrong');
            errors++; updateDots();
            if (App.Audio) App.Audio.sfx('error');
            if (errors >= MAX_ERRORS) lock();
          }
        } else if (act === 'mark') {
          if (state[i] !== 0) return;
          state[i] = 2; paintCell(i, 'non-pop');
          if (App.Audio) App.Audio.blip(260, 0.025);
        } else if (act === 'unmark') {
          if (state[i] !== 2) return;
          state[i] = 0; paintCell(i, null);
          if (App.Audio) App.Audio.blip(190, 0.025);
        }
      }

      function paintCell(i, anim) {
        var c = cells[i];
        if (!c) return;
        var cls = cellBase[i] + (state[i] === 1 ? ' is-fill' : state[i] === 2 ? ' is-mark' : '');
        c.className = cls;
        if (anim) { void c.offsetWidth; c.className = cls + ' ' + anim; }
      }

      /* Fertige Zeile/Spalte abhaken — die gefüllten Felder sind immer korrekt,
         also reicht der Vergleich der Anzahl. */
      function refreshLines(y, x) {
        var n = puz.size, k, cnt = 0, need = 0;
        for (k = 0; k < n; k++) { if (state[y * n + k] === 1) cnt++; need += puz.grid[y][k]; }
        rowClueEls[y].classList.toggle('is-done', cnt === need);
        cnt = 0; need = 0;
        for (k = 0; k < n; k++) { if (state[k * n + x] === 1) cnt++; need += puz.grid[k][x]; }
        colClueEls[x].classList.toggle('is-done', cnt === need);
      }

      function updateDots() {
        refs.dots.forEach(function (d, i) { d.classList.toggle('is-on', i < errors); });
      }

      /* ---------- Sperre nach 3 Fehlern ---------- */
      function lock() {
        locked = true;
        var until = nowFn() + LOCK_MS;
        dragging = false;
        if (App.Audio) App.Audio.sfx('bust');
        refs.lockNum.textContent = String(Math.ceil(LOCK_MS / 1000));
        refs.lock.classList.add('is-on');
        if (lockTimer) clearInterval(lockTimer);
        lockTimer = setInterval(function () {
          if (dead) { clearInterval(lockTimer); return; }
          var left = Math.ceil((until - nowFn()) / 1000);
          if (left <= 0) {
            clearInterval(lockTimer); lockTimer = null;
            locked = false; errors = 0; updateDots();
            refs.lock.classList.remove('is-on');
            if (App.Audio) App.Audio.sfx('ding');
            return;
          }
          refs.lockNum.textContent = String(left);
        }, 100);
        var mine = lockTimer;
        roundStops.push(function () { clearInterval(mine); });
      }

      /* ---------- Bild gelöst ---------- */
      function solve() {
        var n = puz.size, i;
        var used = (nowFn() - puzStart) / 1000;
        var base = BASE[n] || 200, par = PAR[n] || 90;
        var tempo = Math.max(0, Math.round((par - used) * 4));
        var pen = errors * 25;
        var pts = Math.max(Math.round(base * 0.3), base + tempo - pen);
        score += pts; solved++;

        /* Rest als ❌ aufdecken + Welle über die gefüllten Felder */
        for (i = 0; i < state.length; i++) if (state[i] === 0) { state[i] = 2; paintCell(i, null); }
        for (i = 0; i < cells.length; i++) {
          if (state[i] === 1) {
            cells[i].style.animationDelay = ((Math.floor(i / n) + (i % n)) * 24) + 'ms';
            cells[i].className = cellBase[i] + ' is-fill non-reveal';
          }
        }
        for (i = 0; i < n; i++) { rowClueEls[i].classList.add('is-done'); colClueEls[i].classList.add('is-done'); }

        refs.score.textContent = App.MG.fmt(score);
        refs.score.classList.remove('non-bump'); void refs.score.offsetWidth; refs.score.classList.add('non-bump');
        if (refs.soloSolved) refs.soloSolved.textContent = String(solved);
        if (isMulti) ctx.room.reportScore(score);
        if (App.Audio) App.Audio.sfx('win');

        refs.solvedIco.textContent = puz.emoji;
        refs.solvedName.textContent = puz.name;
        refs.solvedPts.textContent = '+' + App.MG.fmt(pts);
        refs.solvedSub.textContent = 'Grundwert ' + base + ' · Tempo +' + tempo + (pen ? ' · Fehler −' + pen : '');
        refs.solved.classList.add('is-on');

        after(1900, function () {
          if (finished || dead) return;
          newPuzzle(puzIndex + 1);
        });
      }

      /* ===================== Ende ===================== */
      function finish() {
        if (finished || dead) return;
        finished = true;
        locked = true; dragging = false;
        clearPending(); stopRound();
        if (App.Audio) App.Audio.sfx('cashout');

        if (isMulti) {
          ctx.room.reportScore(score);
          after(900, function () {
            App.MG.endScreen(root, { players: ctx.room.players(), meId: ctx.me.id, onExit: ctx.onExit });
          });
        } else {
          var best = App.Storage.get('best_nonogram', 0);
          var nb = score > best;
          if (nb) App.Storage.set('best_nonogram', score);
          App.MG.endScreen(root, {
            score: score, best: best, newBest: nb,
            label: solved + (solved === 1 ? ' Bild' : ' Bilder') + ' gelöst' +
              (nb ? ' · neuer Rekord! 🎉' : ' · Bestwert: ' + App.MG.fmt(best)),
            onExit: ctx.onExit,
            onAgain: function () { finished = false; play(Date.now()); }
          });
        }
      }
    }
  };

  /* ===================== STYLES ===================== */
  function injectStyle() {
    UI.injectStyle('mg-nonogram-css', [
      '.non-layout{display:flex;flex-direction:column;gap:10px;}',
      /* Kopf */
      '.non-head{display:flex;justify-content:space-between;align-items:center;padding:10px 16px;gap:12px;}',
      '.non-hcell{display:flex;flex-direction:column;gap:2px;min-width:0;}',
      '.non-hmid{text-align:center;}',
      '.non-hright{text-align:right;}',
      '.non-hl{color:var(--muted);font-size:10px;text-transform:uppercase;letter-spacing:1.4px;}',
      '.non-score{font-size:clamp(22px,5.5vw,34px);font-weight:900;color:var(--gold);line-height:1;',
      'text-shadow:0 0 12px rgba(255,210,63,.45);font-variant-numeric:tabular-nums;}',
      '.non-pic{font-size:clamp(15px,3.6vw,20px);font-weight:800;color:var(--aqua);text-shadow:0 0 10px rgba(51,230,208,.4);line-height:1.2;}',
      '.non-head .mg-timer{font-size:clamp(17px,4.4vw,24px);}',
      '.mg-timer.non-urgent{color:var(--danger-2);animation:non-pulse .7s infinite;}',
      '.non-bump{animation:non-bump .3s ease;}',
      '.non-rules{margin:0;text-align:center;font-size:11.5px;line-height:1.4;}',
      /* Brett */
      '.non-boardwrap{position:relative;padding:12px 10px;overflow:hidden;}',
      '.non-boardhost{display:flex;justify-content:center;}',
      '.non-grid{display:grid;gap:2px;margin:0 auto;max-width:100%;touch-action:none;',
      'user-select:none;-webkit-user-select:none;-webkit-tap-highlight-color:transparent;}',
      '.non-n5{font-size:16px;width:min(88vw,330px);}',
      '.non-n8{font-size:13px;width:min(92vw,390px);}',
      '.non-n10{font-size:clamp(9px,2.5vw,12px);width:min(94vw,430px);}',
      '.non-corner{display:flex;align-items:center;justify-content:center;font-size:1.1em;opacity:.5;}',
      /* Hinweise */
      '.non-cc{display:flex;flex-direction:column;align-items:center;justify-content:flex-end;gap:.05em;padding-bottom:.25em;}',
      '.non-rc{display:flex;align-items:center;justify-content:flex-end;gap:.3em;padding-right:.3em;}',
      '.non-num{font-weight:800;color:var(--aqua-soft);font-variant-numeric:tabular-nums;line-height:1.1;}',
      '.non-cc.is-done .non-num,.non-rc.is-done .non-num{color:var(--muted);opacity:.5;text-decoration:line-through;}',
      '.non-cc.is-done,.non-rc.is-done{transition:opacity .2s;}',
      '.non-sepr{box-shadow:1px 0 0 0 var(--stroke-2);}',
      '.non-sepb{box-shadow:0 1px 0 0 var(--stroke-2);}',
      '.non-sepr.non-sepb{box-shadow:1px 0 0 0 var(--stroke-2),0 1px 0 0 var(--stroke-2);}',
      /* Felder */
      '.non-cell{aspect-ratio:1;min-width:0;padding:0;border-radius:4px;cursor:pointer;',
      'background:rgba(7,28,18,.75);border:1px solid var(--stroke);font-family:inherit;font-size:1em;',
      'transition:background .1s ease,border-color .1s ease;touch-action:none;}',
      '.non-cell:hover{background:rgba(57,255,20,.14);border-color:var(--stroke-2);}',
      '.non-cell.is-fill{background:linear-gradient(155deg,var(--neon-soft),var(--neon));border-color:#eaffe2;',
      'box-shadow:0 0 7px rgba(57,255,20,.45);}',
      '.non-cell.is-mark{background:rgba(7,28,18,.5);border-color:var(--stroke);position:relative;}',
      '.non-cell.is-mark::after{content:"✕";position:absolute;inset:0;display:flex;align-items:center;',
      'justify-content:center;color:var(--muted);font-weight:900;font-size:1em;}',
      '.non-pop{animation:non-pop .18s ease;}',
      '.non-wrong{animation:non-wrong .4s ease;}',
      '.non-reveal{animation:non-reveal .5s ease both;}',
      /* Overlays */
      '.non-lock,.non-solved{position:absolute;inset:0;display:none;flex-direction:column;align-items:center;',
      'justify-content:center;gap:6px;text-align:center;padding:16px;backdrop-filter:blur(3px);z-index:3;}',
      '.non-lock.is-on,.non-solved.is-on{display:flex;animation:non-fade .18s ease both;}',
      '.non-lock{background:rgba(40,4,12,.78);}',
      '.non-lock-ico{font-size:40px;filter:drop-shadow(0 0 12px rgba(255,77,109,.7));}',
      '.non-lock-t{font-weight:900;color:var(--danger-2);letter-spacing:1px;}',
      '.non-lock-num{font-size:52px;font-weight:900;color:#fff;line-height:1;text-shadow:0 0 18px rgba(255,77,109,.7);',
      'font-variant-numeric:tabular-nums;animation:non-pulse 1s infinite;}',
      '.non-solved{background:rgba(4,18,11,.82);}',
      '.non-sv-ico{font-size:52px;line-height:1;animation:non-bump .5s ease;filter:drop-shadow(0 0 14px rgba(57,255,20,.5));}',
      '.non-sv-name{font-size:24px;font-weight:900;letter-spacing:1px;}',
      '.non-sv-pts{font-size:34px;font-weight:900;color:var(--gold);text-shadow:0 0 16px rgba(255,210,63,.5);',
      'font-variant-numeric:tabular-nums;animation:non-pop .35s ease;}',
      '.non-sv-sub{font-size:11.5px;color:var(--muted);}',
      /* Werkzeuge */
      '.non-tools{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 12px;flex-wrap:wrap;}',
      '.non-modes{display:flex;gap:8px;}',
      '.non-mode{font-size:13px;padding:8px 12px;}',
      '.non-mode.is-on{border-color:var(--neon);color:#eaffe2;background:rgba(57,255,20,.16);',
      'box-shadow:0 0 14px rgba(57,255,20,.3);}',
      '.non-errbox{display:flex;align-items:center;gap:8px;}',
      '.non-dots{display:flex;gap:5px;}',
      '.non-dot{width:12px;height:12px;border-radius:50%;border:1px solid var(--stroke-2);background:rgba(7,28,18,.8);',
      'transition:background .15s,box-shadow .15s;}',
      '.non-dot.is-on{background:var(--danger);border-color:var(--danger-2);box-shadow:0 0 10px rgba(255,77,109,.7);}',
      /* Seitenleiste */
      '.non-side{padding:12px;display:flex;flex-direction:column;gap:8px;}',
      '.non-side .mg-scoreboard{max-height:210px;overflow-y:auto;}',
      '.non-solo{flex-direction:row;justify-content:center;gap:10px;flex-wrap:wrap;}',
      '.non-solo-v{color:var(--leaf);}',
      /* Animationen */
      '@keyframes non-pop{0%{transform:scale(.6)}60%{transform:scale(1.14)}100%{transform:scale(1)}}',
      '@keyframes non-bump{0%{transform:scale(1)}40%{transform:scale(1.18)}100%{transform:scale(1)}}',
      '@keyframes non-pulse{0%,100%{opacity:1}50%{opacity:.4}}',
      '@keyframes non-fade{from{opacity:0;transform:scale(.97)}to{opacity:1;transform:scale(1)}}',
      '@keyframes non-reveal{0%{transform:scale(1);filter:brightness(1)}45%{transform:scale(1.22);filter:brightness(1.9)}100%{transform:scale(1);filter:brightness(1)}}',
      '@keyframes non-wrong{0%{background:var(--danger);transform:scale(1.1)}',
      '35%{transform:translateX(-3px)}65%{transform:translateX(3px)}100%{transform:translateX(0)}}'
    ].join(''));
  }
})();
