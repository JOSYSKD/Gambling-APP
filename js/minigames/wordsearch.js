/* wordsearch.js — "Wort-Suche": Wortsuchraetsel im Neon-Dschungel.
 *
 * IDEE      Ein 12x12-Buchstabengitter versteckt 12 deutsche Woerter aus einer
 *           eingebauten Liste (>150 Woerter, Themen Dschungel / Tiere / Alltag).
 *           Die Woerter liegen waagrecht, senkrecht und diagonal — vorwaerts
 *           wie rueckwaerts. Der Rest ist mit haeufigkeitsgewichteten
 *           Zufallsbuchstaben aufgefuellt (Tarnung).
 * STEUERUNG Ueber die Buchstaben ziehen (pointerdown / pointermove / pointerup,
 *           Maus + Touch gleichermassen). Die Auswahl rastet automatisch auf
 *           eine der 8 Richtungen ein. Treffer = Zellen bleiben leuchtend
 *           markiert, das Wort wird aus der Liste gestrichen.
 * PUNKTE    Wort = (50 + 12 x Buchstaben) + Tempo-Bonus (halbe Restsekunden)
 *           + Combo-Bonus (Funde binnen 12 s: 25/50/.../125).
 *           Alle Woerter gefunden = 300 + 4 x Restsekunden Abschluss-Bonus.
 *           Rundenzeit 4 Minuten.
 * SOLO      Punktejagd gegen den eigenen Rekord (best_wordsearch), dazu drei
 *           Bots (Kolibri / Jaguar / Faultier) in der Live-Rangliste. Die Bots
 *           suchen zeitbasiert: lange Woerter fallen ihnen frueher auf, Diagonalen
 *           und Rueckwaerts-Woerter dauern laenger, die letzten Woerter werden
 *           zaeher — dazu Streuung, damit es nicht nach Metronom wirkt.
 * SYNC      Alle bekommen DASSELBE Gitter: der Host verteilt einen Seed per
 *           room.setShared({ wsr: { seed } }), alle bauen daraus lokal identisch
 *           (mulberry32). Notnagel, falls der Seed noch nicht da ist:
 *           round.startAt — den kennt jeder. Punkte per reportScore (Live-
 *           Rangliste), Fertig-Meldung per reportState({done:true}); sind alle
 *           fertig, endet die Runde vorzeitig. Alle Timer laufen ueber
 *           Wall-Clock (room.now bzw. Date.now) -> Tab-Wechsel-sicher.
 */
(function () {
  'use strict';
  window.App = window.App || {}; App.Minigames = App.Minigames || {};
  var UI = App.UI, el = UI.el;

  injectStyle();

  var N = 12;                 // Gitter 12x12
  var WORD_COUNT = 12;        // versteckte Woerter pro Raetsel
  var DURATION = 240;         // Sekunden Rundenzeit (4 Minuten)
  var COMBO_MS = 12000;       // Zeitfenster fuer den Combo-Bonus
  var COLORS = 6;             // Anzahl der Fund-Farben (wsr-c0 .. wsr-c5)

  /* Die 8 Richtungen: [dr, dc] */
  var DIRS = [
    [0, 1], [0, -1], [1, 0], [-1, 0],
    [1, 1], [1, -1], [-1, 1], [-1, -1]
  ];

  /* ---------- Wortliste (deutsch, ohne Umlaute/ss-Fallen, 4–10 Buchstaben) ---------- */
  var WORDS = [
    /* Dschungel & Natur */
    'DSCHUNGEL', 'LIANE', 'PALME', 'FARN', 'MOOS', 'BLATT', 'BAUM', 'WURZEL', 'RINDE',
    'ZWEIG', 'DICKICHT', 'NEBEL', 'REGEN', 'SUMPF', 'FLUSS', 'WASSER', 'TEICH', 'INSEL',
    'SAND', 'STEIN', 'FELSEN', 'BERG', 'WALD', 'PILZ', 'GRAS', 'DORN', 'KAKTUS',
    'ORCHIDEE', 'BAMBUS', 'MANGROVE', 'LAGUNE', 'VULKAN', 'GEWITTER', 'MONSUN',
    'SCHATTEN', 'LICHTUNG', 'PFAD', 'NEST', 'HONIG', 'NEKTAR', 'HARZ', 'KOKOSNUSS',
    'DATTEL', 'DAMPF', 'WOLKE', 'STURM', 'ERDE', 'LEHM', 'RANKE', 'KRONE',
    /* Tiere */
    'TIGER', 'AFFE', 'GORILLA', 'SCHLANGE', 'PAPAGEI', 'TUKAN', 'JAGUAR', 'LEOPARD',
    'PANTHER', 'ELEFANT', 'NASHORN', 'KROKODIL', 'FROSCH', 'ECHSE', 'LEGUAN', 'PYTHON',
    'KOBRA', 'SPINNE', 'SKORPION', 'AMEISE', 'TERMITE', 'MOSKITO', 'LIBELLE', 'RAUPE',
    'WESPE', 'BIENE', 'HORNISSE', 'FLEDERMAUS', 'FAULTIER', 'TAPIR', 'PUMA', 'OZELOT',
    'KAIMAN', 'PIRANHA', 'FISCH', 'DELFIN', 'OTTER', 'BIBER', 'LAMA', 'ZEBRA',
    'GIRAFFE', 'WOLF', 'FUCHS', 'HIRSCH', 'HASE', 'IGEL', 'MAUS', 'RATTE', 'EULE',
    'FALKE', 'ADLER', 'GEIER', 'REIHER', 'FLAMINGO', 'PELIKAN', 'KOLIBRI', 'SPECHT',
    'STORCH', 'SCHWAN', 'ENTE', 'GANS', 'HUHN', 'TAUBE', 'RABE', 'AMSEL', 'MEISE',
    'SCHNECKE', 'REGENWURM', 'QUALLE', 'KRABBE', 'HUMMER', 'KORALLE', 'SEESTERN',
    'MUSCHEL', 'ROBBE', 'PINGUIN', 'KAMEL', 'ESEL', 'PFERD', 'KATZE', 'HUND',
    'SCHAF', 'ZIEGE', 'SCHWEIN', 'PONY', 'MARDER', 'DACHS', 'ILTIS',
    /* Alltag */
    'KAFFEE', 'BROT', 'MILCH', 'ZUCKER', 'SALZ', 'PFEFFER', 'NUDELN', 'SUPPE', 'SALAT',
    'APFEL', 'BIRNE', 'BANANE', 'TRAUBE', 'ZITRONE', 'ORANGE', 'MELONE', 'ERDBEERE',
    'KIRSCHE', 'PFLAUME', 'TOMATE', 'GURKE', 'KAROTTE', 'ZWIEBEL', 'KARTOFFEL', 'REIS',
    'KUCHEN', 'TELLER', 'GABEL', 'MESSER', 'TASSE', 'FLASCHE', 'PFANNE', 'TOPF',
    'FENSTER', 'STUHL', 'TISCH', 'SOFA', 'LAMPE', 'TEPPICH', 'SPIEGEL', 'SCHRANK',
    'BETT', 'KISSEN', 'DECKE', 'WECKER', 'HANDY', 'TASTATUR', 'RUCKSACK', 'FAHRRAD',
    'STRASSE', 'AUTO', 'BAHNHOF', 'FLUGZEUG', 'SCHIFF', 'GARTEN', 'BALKON', 'TREPPE',
    'KELLER', 'DACH', 'MAUER', 'ZAUN', 'BRIEF', 'ZEITUNG', 'BLEISTIFT', 'PAPIER',
    'SCHERE', 'KLEBER', 'PINSEL', 'FARBE', 'MUSIK', 'GITARRE', 'KLAVIER', 'TROMMEL',
    'KAMERA', 'URLAUB', 'STRAND', 'SOMMER', 'WINTER', 'HERBST', 'MORGEN', 'ABEND',
    'FREUND', 'SCHULE', 'ARBEIT', 'FERIEN', 'MARKT', 'LADEN', 'GELD', 'KARTE',
    'SPIEL', 'BALL', 'PUPPE', 'DRACHEN', 'LATERNE', 'KERZE', 'FEUER', 'RAUCH'
  ];

  /* Haeufigkeitsgewichtetes Alphabet fuer die Fuellbuchstaben (deutsch). */
  var FILLER = 'EEEEEEEEEEEEEEEENNNNNNNNNNIIIIIIIIISSSSSSSRRRRRRAAAAAATTTTTTDDDDDHHHHHUUUUULLLLLCCCCGGGMMMOOOBBWWFFKKZZPVJYXQ';

  /* ---------- Seed-Zufall (mulberry32) — gleicher Seed = gleiches Gitter ---------- */
  function rng(seed) {
    var a = (seed >>> 0) || 1;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t = t ^ (t + Math.imul(t ^ (t >>> 7), t | 61));
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function hash32(x) {
    x = (x >>> 0) || 1;
    x = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
    x = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
    return ((x ^ (x >>> 16)) >>> 0) || 1;
  }
  function shuffled(arr, rnd) {
    var a = arr.slice(), i, j, t;
    for (i = a.length - 1; i > 0; i--) {
      j = Math.floor(rnd() * (i + 1));
      t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  /* Umlaute wegnormalisieren — Sicherheitsnetz, falls die Liste mal waechst. */
  function normWord(w) {
    return String(w).toUpperCase()
      .replace(/Ä/g, 'AE').replace(/Ö/g, 'OE').replace(/Ü/g, 'UE')
      .replace(/ß/g, 'SS').replace(/[^A-Z]/g, '');
  }

  /* ---------- Generator: Woerter platzieren + Rest auffuellen ---------- */
  function makePuzzle(seed) {
    var rnd = rng(seed);
    var grid = [];               // N*N Buchstaben ('' = noch frei)
    var i;
    for (i = 0; i < N * N; i++) grid.push('');

    var pool = shuffled(WORDS, rnd).map(normWord).filter(function (w) {
      return w.length >= 4 && w.length <= N - 2;
    });
    var placed = [], used = {};

    /* Richtungen durchmischen und reihum benutzen -> garantierter Mix aus
       waagrecht / senkrecht / diagonal / rueckwaerts. */
    var dirBag = shuffled(DIRS, rnd), dirAt = 0;
    function nextDir() {
      if (dirAt >= dirBag.length) { dirBag = shuffled(DIRS, rnd); dirAt = 0; }
      return dirBag[dirAt++];
    }

    for (i = 0; i < pool.length && placed.length < WORD_COUNT; i++) {
      var w = pool[i];
      if (used[w]) continue;
      var p = tryPlace(grid, w, nextDir(), rnd);
      if (!p) p = tryPlace(grid, w, null, rnd);      // zweiter Versuch: freie Richtungswahl
      if (p) { placed.push(p); used[w] = true; }
    }

    /* Rest mit gewichteten Zufallsbuchstaben fuellen. */
    for (i = 0; i < N * N; i++) {
      if (grid[i] === '') grid[i] = FILLER.charAt(Math.floor(rnd() * FILLER.length));
    }
    return { grid: grid, words: placed };
  }

  /* Versucht ein Wort zu platzieren. dir = feste Richtung oder null (zufaellig). */
  function tryPlace(grid, word, dir, rnd) {
    var tries = 260, t, k;
    for (t = 0; t < tries; t++) {
      var d = dir || DIRS[Math.floor(rnd() * DIRS.length)];
      var dr = d[0], dc = d[1];
      var r0 = Math.floor(rnd() * N), c0 = Math.floor(rnd() * N);
      var r1 = r0 + dr * (word.length - 1), c1 = c0 + dc * (word.length - 1);
      if (r1 < 0 || r1 >= N || c1 < 0 || c1 >= N) continue;
      var cells = [], ok = true, overlap = 0;
      for (k = 0; k < word.length; k++) {
        var idx = (r0 + dr * k) * N + (c0 + dc * k);
        var cur = grid[idx];
        if (cur !== '' && cur !== word.charAt(k)) { ok = false; break; }
        if (cur !== '') overlap++;
        cells.push(idx);
      }
      /* Voll ueberdeckte Woerter waeren unsichtbar -> ablehnen. */
      if (!ok || overlap >= word.length) continue;
      for (k = 0; k < word.length; k++) grid[cells[k]] = word.charAt(k);
      return {
        word: word, cells: cells,
        diag: dr !== 0 && dc !== 0,
        back: dc < 0 || (dc === 0 && dr < 0)
      };
    }
    return null;
  }

  /* ---------- Punkte (identisch fuer Mensch und Bot) ---------- */
  function wordPoints(len, secLeft, streak) {
    var base = 50 + 12 * len;
    var speed = Math.round(Math.max(0, secLeft) / 2);
    var combo = Math.min(streak, 5) * 25;
    return base + speed + combo;
  }
  function finishBonus(secLeft) { return 300 + Math.round(Math.max(0, secLeft) * 4); }

  /* ---------- kleine Solo-Rangliste (gleiche Optik wie App.MG.liveBoard) ---------- */
  function localBoard(rows, meId) {
    var rootEl = el('div', { class: 'mg-scoreboard' });
    function update(list) {
      var ps = list.slice().sort(function (a, b) { return (b.score || 0) - (a.score || 0); });
      rootEl.innerHTML = '';
      ps.forEach(function (p, i) {
        rootEl.appendChild(el('div', { class: 'mg-sb-row p' + (i + 1) + (p.id === meId ? ' me' : '') }, [
          el('span', { class: 'mg-sb-rank' }, ['' + (i + 1)]),
          el('span', { class: 'mg-sb-name' }, [p.name + (p.id === meId ? ' (du)' : '')]),
          el('span', { class: 'mg-sb-score' }, [App.MG.fmt(p.score || 0)])
        ]));
      });
    }
    update(rows);
    return { root: rootEl, update: update };
  }

  App.Minigames.wordsearch = {
    id: 'wordsearch', title: 'Wort-Suche', icon: '🔠', order: 162,
    subtitle: 'Zieh die versteckten Wörter aus dem Gitter',
    single: true, multi: true, minPlayers: 2, maxPlayers: 8,

    render: function (root, ctx) {
      var isMulti = ctx.mode === 'multi';
      var nowFn = isMulti ? ctx.room.now : function () { return Date.now(); };

      var dead = false;
      var stops = [];          // Aufraeum-Funktionen (Listener, Timer, room.off)
      var roundStops = [];     // dito, aber nur fuer die laufende Runde
      var pending = [];        // laufende setTimeout-IDs

      var seed = 0, started = false, finished = false;

      /* Zustand der laufenden Runde */
      var puzzle = null, foundColor = null, foundWords = null, foundCount = 0;
      var score = 0, streak = 0, lastFindAt = 0, endAt = 0, iAmDone = false;
      var bots = [];

      /* DOM */
      var refs = null;
      /* Auswahl per Zeiger */
      var dragging = false, dragPointer = null, startIdx = -1, selPath = [];

      function after(ms, fn) { var t = setTimeout(function () { if (!dead) fn(); }, ms); pending.push(t); return t; }
      function clearPending() { pending.forEach(clearTimeout); pending = []; }
      function stopAll(list) { list.forEach(function (f) { try { f(); } catch (e) {} }); list.length = 0; }
      function cleanup() { dead = true; clearPending(); stopAll(roundStops); stopAll(stops); }

      /* ===================== Start ===================== */
      if (isMulti) {
        var snap = ctx.room.snapshot() || {};
        var startAt = (snap.round && snap.round.startAt) || (ctx.room.now() + 3000);
        var sh0 = snap.shared || {};
        if (sh0.wsr && sh0.wsr.seed) seed = sh0.wsr.seed >>> 0;
        if (!seed && ctx.room.isHost()) {
          seed = (Math.floor(Math.random() * 1000000000) + 1) >>> 0;
          try { ctx.room.setShared({ wsr: { seed: seed } }); } catch (e) {}
        }
        /* Heartbeats feuern staendig -> Handler muss idempotent sein. */
        var onShared = function (s) {
          if (dead || !s || !s.wsr || !s.wsr.seed) return;
          var ns = s.wsr.seed >>> 0;
          if (ns === seed) return;                     // nichts Neues
          if (started && foundCount > 0) return;       // laeuft schon -> nicht umbauen
          seed = ns;
          if (started) { buildRound(endAt - DURATION * 1000); }
        };
        ctx.room.on('shared', onShared);
        stops.push(function () { ctx.room.off('shared', onShared); });

        /* Sind alle fertig -> Runde endet vorzeitig. */
        var onPlayers = function () {
          if (dead || finished || !started) return;
          var ps = ctx.room.players();
          if (!ps.length) return;
          var allDone = ps.every(function (p) { return p.state && p.state.done; });
          if (allDone) finish();
        };
        ctx.room.on('players', onPlayers);
        stops.push(function () { ctx.room.off('players', onPlayers); });

        stops.push(App.MG.countdown(root, startAt, function () {
          if (!seed) seed = hash32(Math.floor(startAt / 1000));   // Notnagel: startAt kennt jeder
          play(startAt);
        }, ctx.room.now));
      } else {
        play(nowFn());
      }
      return { cleanup: cleanup };

      /* ===================== Runde ===================== */
      function play(startAt) {
        clearPending(); stopAll(roundStops);
        started = true; finished = false; iAmDone = false;
        if (!seed) seed = (Math.floor(Math.random() * 1000000000) + 1) >>> 0;
        endAt = startAt + DURATION * 1000;

        buildLayout();
        buildRound(startAt);

        if (isMulti) { ctx.room.reportScore(0); ctx.room.reportState({ done: false, found: 0 }); }

        roundStops.push(App.MG.roundTimer(endAt, function (left) {
          refs.timer.textContent = App.MG.mmss(left);
          if (left <= 30) refs.timer.classList.add('wsr-urgent');
        }, finish, isMulti ? ctx.room.now : null));

        if (!isMulti) startBots();
      }

      /* Gitter + Wortliste (neu) aufbauen — Layout bleibt stehen. */
      function buildRound(startAt) {
        puzzle = makePuzzle(seed);
        foundColor = [];
        foundWords = {};
        foundCount = 0; score = 0; streak = 0; lastFindAt = 0;
        for (var i = 0; i < N * N; i++) foundColor.push(-1);
        renderGrid();
        renderWords();
        updateHead();
        if (isMulti) ctx.room.reportScore(0);
      }

      /* ---------- Layout ---------- */
      function buildLayout() {
        var scoreEl = el('div', { class: 'wsr-score' }, ['0']);
        var progEl = el('div', { class: 'wsr-prog' }, ['0 / ' + WORD_COUNT]);
        var timerEl = el('div', { class: 'mg-timer' }, [App.MG.mmss(DURATION)]);
        var head = el('div', { class: 'wsr-head glass' }, [
          el('div', { class: 'wsr-head-cell' }, [el('span', { class: 'wsr-head-l' }, ['Punkte']), scoreEl]),
          el('div', { class: 'wsr-head-cell wsr-head-mid' }, [el('span', { class: 'wsr-head-l' }, ['Gefunden']), progEl]),
          el('div', { class: 'wsr-head-cell wsr-head-right' }, [el('span', { class: 'wsr-head-l' }, ['Zeit']), timerEl])
        ]);

        var banner = el('div', { class: 'wsr-banner' }, ['']);
        var board = el('div', { class: 'wsr-board' });
        var pops = el('div', { class: 'wsr-pops' });
        var boardBox = el('div', { class: 'wsr-board-box' }, [board, pops]);
        var rule = el('div', { class: 'wsr-rule hint-text' }, [
          '🖐️ Zieh über die Buchstaben — waagrecht, senkrecht oder diagonal, auch rückwärts.'
        ]);
        var boardCol = el('div', { class: 'wsr-board-col' }, [banner, boardBox, rule]);

        var wordsEl = el('div', { class: 'wsr-words' });
        var wordsBox = el('div', { class: 'wsr-panel glass' }, [
          el('div', { class: 'mg-field-title' }, ['🔍 Gesuchte Wörter']), wordsEl
        ]);

        var boardWrap = null, board2 = null, lb = null;
        if (isMulti) {
          lb = App.MG.liveBoard(ctx.room, ctx.me.id);
          roundStops.push(lb.stop);
          board2 = lb.root;
        } else {
          var rows = [{ id: ctx.me.id, name: ctx.me.name || 'Du', score: 0 }];
          bots.forEach(function (b) { rows.push({ id: b.id, name: b.name, score: 0 }); });
          lb = localBoard(rows, ctx.me.id);
          board2 = lb.root;
        }
        boardWrap = el('div', { class: 'wsr-panel glass' }, [
          el('div', { class: 'mg-field-title' }, ['🏆 Rangliste']), board2
        ]);

        var side = el('div', { class: 'wsr-side' }, [wordsBox, boardWrap]);
        var main = el('div', { class: 'wsr-main' }, [boardCol, side]);
        var wrap = el('div', { class: 'wsr-wrap' }, [head, main]);

        root.innerHTML = ''; root.appendChild(wrap);

        refs = {
          score: scoreEl, prog: progEl, timer: timerEl, banner: banner,
          board: board, pops: pops, words: wordsEl, cells: [], chips: {}, lb: lb
        };

        /* Zellen anlegen */
        var i;
        for (i = 0; i < N * N; i++) {
          var c = el('div', { class: 'wsr-cell' }, ['']);
          refs.cells.push(c);
          board.appendChild(c);
        }
        bindPointer(board);
      }

      /* ---------- Zeichnen ---------- */
      function renderGrid() {
        for (var i = 0; i < N * N; i++) {
          var c = refs.cells[i];
          c.textContent = puzzle.grid[i];
          c.className = 'wsr-cell' + (foundColor[i] >= 0 ? ' wsr-found wsr-c' + foundColor[i] : '');
        }
      }
      function paintSelection() {
        var i;
        for (i = 0; i < refs.cells.length; i++) refs.cells[i].classList.remove('wsr-sel');
        for (i = 0; i < selPath.length; i++) refs.cells[selPath[i]].classList.add('wsr-sel');
      }
      function renderWords() {
        refs.words.innerHTML = '';
        refs.chips = {};
        puzzle.words.slice().sort(function (a, b) {
          return a.word.length - b.word.length || (a.word < b.word ? -1 : 1);
        }).forEach(function (p) {
          var chip = el('span', { class: 'wsr-word' + (foundWords[p.word] ? ' is-found' : '') }, [p.word]);
          refs.chips[p.word] = chip;
          refs.words.appendChild(chip);
        });
      }
      function updateHead() {
        refs.score.textContent = App.MG.fmt(score);
        refs.prog.textContent = foundCount + ' / ' + puzzle.words.length;
      }
      function bumpScore() {
        refs.score.classList.remove('wsr-bump');
        void refs.score.offsetWidth;
        refs.score.classList.add('wsr-bump');
      }
      function updateBoard() {
        if (isMulti) { refs.lb.update(); return; }
        var rows = [{ id: ctx.me.id, name: ctx.me.name || 'Du', score: score }];
        bots.forEach(function (b) { rows.push({ id: b.id, name: b.name, score: b.score }); });
        refs.lb.update(rows);
      }

      /* Punkte-Popup ueber dem Brett */
      function popAt(idx, text, kind) {
        var r = Math.floor(idx / N), c = idx % N;
        var p = el('div', { class: 'wsr-pop' + (kind ? ' wsr-pop-' + kind : '') }, [text]);
        p.style.left = ((c + 0.5) / N * 100) + '%';
        p.style.top = ((r + 0.5) / N * 100) + '%';
        refs.pops.appendChild(p);
        after(900, function () { if (p.parentNode) p.parentNode.removeChild(p); });
      }

      /* ---------- Eingabe: Maus + Touch ueber Pointer-Events ---------- */
      function bindPointer(board) {
        function cellAt(clientX, clientY) {
          var rect = board.getBoundingClientRect();
          if (!rect.width || !rect.height) return -1;
          var c = Math.floor((clientX - rect.left) / (rect.width / N));
          var r = Math.floor((clientY - rect.top) / (rect.height / N));
          if (r < 0) r = 0; if (r > N - 1) r = N - 1;
          if (c < 0) c = 0; if (c > N - 1) c = N - 1;
          return r * N + c;
        }
        function onDown(e) {
          if (dead || finished || iAmDone || dragging) return;
          if (e.button !== undefined && e.button !== 0 && e.pointerType === 'mouse') return;
          e.preventDefault();
          dragging = true; dragPointer = e.pointerId;
          startIdx = cellAt(e.clientX, e.clientY);
          selPath = [startIdx];
          paintSelection();
          try { board.setPointerCapture(e.pointerId); } catch (err) {}
          if (App.Audio) App.Audio.sfx('click');
        }
        function onMove(e) {
          if (!dragging || e.pointerId !== dragPointer) return;
          e.preventDefault();
          var idx = cellAt(e.clientX, e.clientY);
          var path = snapPath(startIdx, idx);
          if (path.length !== selPath.length || path[path.length - 1] !== selPath[selPath.length - 1]) {
            selPath = path; paintSelection();
          }
        }
        function onUp(e) {
          if (!dragging || e.pointerId !== dragPointer) return;
          e.preventDefault();
          dragging = false; dragPointer = null;
          try { board.releasePointerCapture(e.pointerId); } catch (err) {}
          var path = selPath.slice();
          selPath = []; paintSelection();
          if (path.length >= 2) checkPath(path);
        }
        function onCancel() {
          if (!dragging) return;
          dragging = false; dragPointer = null;
          selPath = []; paintSelection();
        }
        board.addEventListener('pointerdown', onDown);
        board.addEventListener('pointermove', onMove);
        board.addEventListener('pointerup', onUp);
        board.addEventListener('pointercancel', onCancel);
        roundStops.push(function () {
          board.removeEventListener('pointerdown', onDown);
          board.removeEventListener('pointermove', onMove);
          board.removeEventListener('pointerup', onUp);
          board.removeEventListener('pointercancel', onCancel);
        });
      }

      /* Rastet die Auswahl auf eine der 8 Richtungen ein. */
      function snapPath(a, b) {
        if (a < 0 || b < 0) return [];
        var r0 = Math.floor(a / N), c0 = a % N, r1 = Math.floor(b / N), c1 = b % N;
        var dr = r1 - r0, dc = c1 - c0;
        if (dr === 0 && dc === 0) return [a];
        var adr = Math.abs(dr), adc = Math.abs(dc), sr = 0, sc = 0, len;
        if (adr > adc * 2) { sr = dr > 0 ? 1 : -1; sc = 0; len = adr; }
        else if (adc > adr * 2) { sr = 0; sc = dc > 0 ? 1 : -1; len = adc; }
        else { sr = dr > 0 ? 1 : -1; sc = dc > 0 ? 1 : -1; len = Math.max(adr, adc); }
        var path = [], k, r, c;
        for (k = 0; k <= len; k++) {
          r = r0 + sr * k; c = c0 + sc * k;
          if (r < 0 || r >= N || c < 0 || c >= N) break;
          path.push(r * N + c);
        }
        return path;
      }

      /* ---------- Treffer-Pruefung ---------- */
      function checkPath(path) {
        var fwd = '', k;
        for (k = 0; k < path.length; k++) fwd += puzzle.grid[path[k]];
        var rev = fwd.split('').reverse().join('');

        var hit = null;
        for (k = 0; k < puzzle.words.length; k++) {
          var w = puzzle.words[k].word;
          if (w === fwd || w === rev) { hit = puzzle.words[k]; break; }
        }
        if (!hit) { flashBad(path); return; }
        if (foundWords[hit.word]) {                     // schon gefunden
          if (App.Audio) App.Audio.sfx('info');
          popAt(path[0], 'schon gefunden', 'info');
          return;
        }
        acceptWord(hit, path);
      }

      function flashBad(path) {
        if (App.Audio) App.Audio.sfx('error');
        streak = 0;
        path.forEach(function (i) {
          var c = refs.cells[i];
          c.classList.add('wsr-bad');
          after(340, function () { c.classList.remove('wsr-bad'); });
        });
      }

      function acceptWord(hit, path) {
        var secLeft = Math.max(0, (endAt - nowFn()) / 1000);
        var t = nowFn();
        streak = (lastFindAt && (t - lastFindAt) <= COMBO_MS) ? streak + 1 : 1;
        lastFindAt = t;

        var pts = wordPoints(hit.word.length, secLeft, streak - 1);
        score += pts;
        foundWords[hit.word] = true;
        foundCount++;

        var col = (foundCount - 1) % COLORS;
        var cells = path.length === hit.word.length ? path : hit.cells;
        cells.forEach(function (i) {
          if (foundColor[i] < 0) foundColor[i] = col;
          var c = refs.cells[i];
          c.className = 'wsr-cell wsr-found wsr-c' + foundColor[i] + ' wsr-pop-in';
        });

        var chip = refs.chips[hit.word];
        if (chip) { chip.classList.add('is-found'); }
        popAt(cells[Math.floor(cells.length / 2)], '+' + pts, 'good');
        if (streak >= 2) popAt(cells[0], '🔥 Combo x' + Math.min(streak, 6), 'combo');
        bumpScore();
        updateHead();
        if (App.Audio) { App.Audio.sfx('point'); if (streak >= 3) App.Audio.blip(880 + streak * 60, 0.08); }
        if (isMulti) { ctx.room.reportScore(score); ctx.room.reportState({ done: false, found: foundCount }); }
        updateBoard();

        if (foundCount >= puzzle.words.length) completeAll(secLeft);
      }

      /* Alle Woerter gefunden */
      function completeAll(secLeft) {
        var bonus = finishBonus(secLeft);
        score += bonus;
        iAmDone = true;
        bumpScore(); updateHead();
        if (App.Audio) { App.Audio.sfx('win'); App.Audio.sweep(440, 1320, 0.5); }
        popAt(Math.floor(N * N / 2), '+' + bonus + ' Abschluss!', 'big');

        if (isMulti) {
          ctx.room.reportScore(score);
          ctx.room.reportState({ done: true, found: foundCount });
          updateBoard();
          refs.banner.className = 'wsr-banner is-on';
          refs.banner.textContent = '🎉 Alle Wörter gefunden! Warte auf die anderen …';
          /* Runde endet ueber den Timer oder sobald alle fertig gemeldet haben. */
        } else {
          updateBoard();
          refs.banner.className = 'wsr-banner is-on';
          refs.banner.textContent = '🎉 Alle Wörter gefunden!';
          after(1100, finish);
        }
      }

      /* ===================== Bots (nur Solo) ===================== */
      function startBots() {
        bots = [
          { id: 'bot_k', name: '🤖 Kolibri', base: 9.5, score: 0, streak: 0, last: 0, left: null, nextAt: 0, done: false },
          { id: 'bot_j', name: '🤖 Jaguar', base: 13, score: 0, streak: 0, last: 0, left: null, nextAt: 0, done: false },
          { id: 'bot_f', name: '🤖 Faultier', base: 18, score: 0, streak: 0, last: 0, left: null, nextAt: 0, done: false }
        ];
        var total = puzzle.words.length;
        bots.forEach(function (b) {
          /* Eigene Restliste, lange Woerter zuerst — die stechen im Gitter heraus. */
          b.left = puzzle.words.slice().sort(function (x, y) { return y.word.length - x.word.length; });
          b.nextAt = Date.now() + planDelay(b, b.left[0], total, total);
        });
        updateBoard();

        var t = setInterval(function () {
          if (dead || finished) return;
          var now = Date.now();
          var secLeft = Math.max(0, (endAt - now) / 1000);
          var changed = false;
          bots.forEach(function (b) {
            if (b.done || now < b.nextAt || !b.left.length) return;
            /* Bevorzugt lange Woerter, aber nicht stur der Reihe nach. */
            var pick = Math.floor(Math.pow(Math.random(), 1.7) * b.left.length);
            var w = b.left.splice(pick, 1)[0];
            b.streak = (b.last && (now - b.last) <= COMBO_MS) ? b.streak + 1 : 1;
            b.last = now;
            b.score += wordPoints(w.word.length, secLeft, b.streak - 1);
            changed = true;
            if (!b.left.length) { b.score += finishBonus(secLeft); b.done = true; return; }
            b.nextAt = now + planDelay(b, b.left[0], b.left.length, puzzle.words.length);
          });
          if (changed) updateBoard();
        }, 250);
        roundStops.push(function () { clearInterval(t); });
      }

      /* Plausible Suchdauer: lange Woerter schneller, Diagonale/Rueckwaerts zaeher,
         die letzten Woerter deutlich muehsamer, dazu ordentlich Streuung. */
      function planDelay(bot, w, remaining, total) {
        var len = w ? w.word.length : 6;
        var lenF = len >= 8 ? 0.78 : (len <= 4 ? 1.3 : 1.0);
        var dirF = 1;
        if (w && w.diag) dirF *= 1.28;
        if (w && w.back) dirF *= 1.18;
        var scarcity = 1 + 0.9 * (1 - remaining / Math.max(1, total));
        var jitter = 0.6 + Math.random() * 0.9;
        return bot.base * lenF * dirF * scarcity * jitter * 1000;
      }

      /* ===================== Ende ===================== */
      function finish() {
        if (finished || dead) return;
        finished = true;
        clearPending();
        stopAll(roundStops);

        if (isMulti) {
          ctx.room.reportScore(score);
          ctx.room.reportState({ done: true, found: foundCount });
          after(1000, function () {
            App.MG.endScreen(root, { players: ctx.room.players(), meId: ctx.me.id, onExit: ctx.onExit });
          });
        } else {
          var best = App.Storage.get('best_wordsearch', 0);
          var nb = score > best;
          if (nb) App.Storage.set('best_wordsearch', score);

          /* Platzierung gegen die Bots — nur als Info-Zeile. */
          var all = [{ id: ctx.me.id, score: score }];
          bots.forEach(function (b) { all.push({ id: b.id, score: b.score }); });
          all.sort(function (a, b) { return b.score - a.score; });
          var place = 1;
          for (var i = 0; i < all.length; i++) if (all[i].id === ctx.me.id) place = i + 1;

          var label = foundCount + ' / ' + (puzzle ? puzzle.words.length : WORD_COUNT) + ' Wörtern · Platz '
            + place + ' von ' + all.length
            + (nb ? ' · neuer Rekord! 🎉' : ' · Bestwert: ' + App.MG.fmt(best));
          if (App.Audio) App.Audio.sfx(place === 1 ? 'win' : 'lose');
          App.MG.endScreen(root, {
            score: score, best: best, newBest: nb, label: label,
            onExit: ctx.onExit,
            onAgain: function () {
              finished = false; started = false;
              seed = (Math.floor(Math.random() * 1000000000) + 1) >>> 0;
              play(Date.now());
            }
          });
        }
      }
    }
  };

  /* ===================== STYLES ===================== */
  function injectStyle() {
    UI.injectStyle('mg-wordsearch-css', [
      '.wsr-wrap{display:flex;flex-direction:column;gap:12px;}',
      /* Kopfzeile */
      '.wsr-head{display:flex;justify-content:space-between;align-items:center;padding:10px 16px;gap:12px;}',
      '.wsr-head-cell{display:flex;flex-direction:column;gap:1px;min-width:0;}',
      '.wsr-head-mid{text-align:center;}',
      '.wsr-head-right{text-align:right;}',
      '.wsr-head-l{color:var(--muted);font-size:10px;text-transform:uppercase;letter-spacing:1px;}',
      '.wsr-score{font-size:clamp(20px,5vw,32px);font-weight:900;color:var(--gold);line-height:1;',
      'text-shadow:0 0 12px rgba(255,210,63,.45);font-variant-numeric:tabular-nums;}',
      '.wsr-prog{font-size:clamp(18px,4.4vw,26px);font-weight:900;color:var(--aqua);line-height:1;',
      'text-shadow:0 0 12px rgba(51,230,208,.4);font-variant-numeric:tabular-nums;}',
      '.wsr-head .mg-timer{font-size:clamp(18px,4.4vw,26px);}',
      '.mg-timer.wsr-urgent{color:var(--danger);animation:wsr-pulse .8s infinite;}',
      '.wsr-bump{animation:wsr-bump .3s ease;}',
      /* Aufteilung */
      '.wsr-main{display:grid;grid-template-columns:minmax(0,1fr) 250px;gap:14px;align-items:start;}',
      '.wsr-board-col{display:flex;flex-direction:column;gap:8px;min-width:0;}',
      '.wsr-side{display:flex;flex-direction:column;gap:12px;min-width:0;}',
      '@media (max-width:820px){.wsr-main{grid-template-columns:1fr;}}',
      /* Banner */
      '.wsr-banner{display:none;}',
      '.wsr-banner.is-on{display:block;padding:8px 12px;border-radius:12px;text-align:center;font-weight:800;',
      'color:#04160c;background:linear-gradient(90deg,var(--neon),var(--aqua));',
      'box-shadow:0 0 24px rgba(57,255,20,.45);animation:wsr-in .35s ease both;}',
      /* Brett */
      '.wsr-board-box{position:relative;width:100%;max-width:min(100%,460px);margin:0 auto;}',
      '.wsr-board{display:grid;grid-template-columns:repeat(12,1fr);gap:0;padding:0;width:100%;',
      'aspect-ratio:1/1;border-radius:16px;overflow:hidden;background:radial-gradient(circle at 50% 40%,#0a2418,#04120b 80%);',
      'border:2px solid var(--stroke-2);box-shadow:0 0 30px rgba(57,255,20,.18),inset 0 0 50px rgba(0,0,0,.5);',
      'touch-action:none;user-select:none;-webkit-user-select:none;-webkit-tap-highlight-color:transparent;cursor:crosshair;}',
      '.wsr-cell{box-sizing:border-box;border:1px solid rgba(120,200,150,.10);display:flex;align-items:center;',
      'justify-content:center;font-weight:800;font-size:clamp(11px,2.6vw,19px);color:#d6f7e2;line-height:1;',
      'transition:background .12s ease,color .12s ease,transform .12s ease;pointer-events:none;}',
      '.wsr-cell.wsr-sel{background:rgba(51,230,208,.34);color:#fff;transform:scale(1.06);',
      'box-shadow:inset 0 0 10px rgba(51,230,208,.7);border-radius:6px;}',
      '.wsr-cell.wsr-bad{background:rgba(255,77,109,.42);color:#fff;animation:wsr-shake .3s ease;}',
      '.wsr-cell.wsr-found{color:#04160c;font-weight:900;}',
      '.wsr-cell.wsr-pop-in{animation:wsr-cellpop .34s cubic-bezier(.2,.9,.3,1.3);}',
      /* Fund-Farben */
      '.wsr-c0{background:rgba(57,255,20,.72);}',
      '.wsr-c1{background:rgba(51,230,208,.72);}',
      '.wsr-c2{background:rgba(255,210,63,.75);}',
      '.wsr-c3{background:rgba(196,120,255,.7);color:#fff !important;}',
      '.wsr-c4{background:rgba(255,140,60,.72);}',
      '.wsr-c5{background:rgba(120,200,255,.72);}',
      /* Popups */
      '.wsr-pops{position:absolute;inset:0;pointer-events:none;overflow:visible;}',
      '.wsr-pop{position:absolute;transform:translate(-50%,-50%);font-weight:900;white-space:nowrap;',
      'font-size:clamp(13px,3vw,19px);color:var(--neon);text-shadow:0 0 12px rgba(57,255,20,.8),0 2px 6px rgba(0,0,0,.8);',
      'animation:wsr-pop .9s ease-out forwards;}',
      '.wsr-pop-good{color:var(--gold);text-shadow:0 0 12px rgba(255,210,63,.9),0 2px 6px rgba(0,0,0,.8);}',
      '.wsr-pop-combo{color:var(--aqua);font-size:clamp(11px,2.4vw,15px);}',
      '.wsr-pop-info{color:var(--muted);font-size:clamp(11px,2.4vw,15px);text-shadow:0 2px 6px rgba(0,0,0,.9);}',
      '.wsr-pop-big{color:#fff;font-size:clamp(16px,4vw,26px);text-shadow:0 0 18px var(--neon),0 2px 8px rgba(0,0,0,.9);}',
      /* Regelzeile */
      '.wsr-rule{margin:0;text-align:center;font-size:12px;}',
      /* Panels */
      '.wsr-panel{padding:12px;display:flex;flex-direction:column;gap:8px;}',
      '.wsr-words{display:flex;flex-wrap:wrap;gap:6px;max-height:200px;overflow-y:auto;}',
      '.wsr-word{padding:4px 9px;border-radius:999px;border:1px solid var(--stroke);background:rgba(4,20,12,.7);',
      'font-size:12px;font-weight:800;letter-spacing:.5px;color:var(--leaf);transition:all .25s ease;}',
      '.wsr-word.is-found{color:var(--muted);border-color:rgba(120,200,150,.16);text-decoration:line-through;',
      'opacity:.45;animation:wsr-strike .4s ease;}',
      '.wsr-panel .mg-scoreboard{max-height:210px;overflow-y:auto;}',
      /* Animationen */
      '@keyframes wsr-bump{0%{transform:scale(1)}40%{transform:scale(1.22)}100%{transform:scale(1)}}',
      '@keyframes wsr-pulse{0%,100%{opacity:1}50%{opacity:.4}}',
      '@keyframes wsr-shake{0%,100%{transform:translateX(0)}25%{transform:translateX(-3px)}75%{transform:translateX(3px)}}',
      '@keyframes wsr-cellpop{0%{transform:scale(1)}45%{transform:scale(1.32)}100%{transform:scale(1)}}',
      '@keyframes wsr-pop{0%{opacity:0;transform:translate(-50%,-50%) scale(.6)}',
      '20%{opacity:1;transform:translate(-50%,-70%) scale(1.1)}',
      '100%{opacity:0;transform:translate(-50%,-190%) scale(1)}}',
      '@keyframes wsr-strike{0%{transform:scale(1)}40%{transform:scale(1.14)}100%{transform:scale(1)}}',
      '@keyframes wsr-in{from{opacity:0;transform:translateY(-8px)}to{opacity:1;transform:translateY(0)}}'
    ].join(''));
  }
})();
