/* floodit.js — "Farb-Flut" (Flood-It) im Neon-Dschungel.
 *
 * IDEE
 *   Ein Gitter aus zufälligen Farbfeldern. Von der Ecke oben links (🌊) aus
 *   flutet man: wählt man eine der 6 Farben, nimmt das zusammenhängende
 *   Startgebiet diese Farbe an und schluckt alle angrenzenden gleichfarbigen
 *   Felder. Ziel: das GANZE Feld in möglichst WENIGEN Zügen einfärben.
 *   Jedes Feld hat ein Zug-Limit (Greedy-Lösung + Puffer, deterministisch aus
 *   dem Seed) — gelöst unter Limit -> sofort das nächste Feld.
 *
 * STEUERUNG
 *   Farbknopf antippen/klicken · direkt auf ein Feld tippen wählt dessen Farbe
 *   (Touch + Maus über pointerdown) · Tasten 1–6.
 *
 * PUNKTE
 *   Gelöst = 100 + 25 je übrigem Zug (× Schwierigkeits-Faktor im Solo).
 *   Limit ausgeschöpft ohne Lösung = 0 Punkte, nächstes Feld. 3 Minuten Zeit.
 *
 * SYNC-MODELL
 *   MULTI: Der Host würfelt EINEN Seed und verteilt ihn per room.setShared
 *          ({fldSeed}). Jeder erzeugt daraus lokal exakt dieselbe Feld-Folge
 *          (Feld i = puzzleFor(seed, i)) inkl. identischem Zug-Limit — jeder
 *          spielt in seinem Tempo, alle bekommen dieselben Rätsel. Punkte über
 *          room.reportScore -> Live-Rangliste (App.MG.liveBoard).
 *   SOLO:  Punktejagd gegen best_floodit, dazu 2–3 Bots (echter Greedy- bzw.
 *          2-Zug-Lookahead-Löser mit Fehlerquote + menschlichem Tempo) auf
 *          derselben Feld-Folge in einer eigenen Live-Rangliste.
 *
 * Alle Timer laufen über Wall-Clock (Date.now / room.now), rAF nur zum Zeichnen.
 * cleanup() stoppt rAF, Timeouts, Listener und meldet alle room.on wieder ab. */
(function () {
  'use strict';
  window.App = window.App || {}; App.Minigames = App.Minigames || {};
  var UI = App.UI, el = UI.el;

  injectStyle();

  /* ---------------- Konstanten ---------------- */
  var DURATION = 180;            // s Rundenzeit (3 Minuten)
  var NCOL = 6;                  // Farben
  var ANIM_MS = 170;             // Dauer einer Zell-Animation
  var WAVE_MS = 34;              // Verzögerung je Wellen-Ring

  var COLORS = [
    { hex: '#39ff14', rgb: [57, 255, 20] },   // 1 Neon-Grün
    { hex: '#33e6d0', rgb: [51, 230, 208] },  // 2 Aqua
    { hex: '#ffd23f', rgb: [255, 210, 63] },  // 3 Gold
    { hex: '#ff4d6d', rgb: [255, 77, 109] },  // 4 Blüten-Rot
    { hex: '#a45cff', rgb: [164, 92, 255] },  // 5 Orchideen-Lila
    { hex: '#3b8cff', rgb: [59, 140, 255] }   // 6 Lagunen-Blau
  ];

  var DIFFS = [
    { key: 'easy', name: 'Ruhig', icon: '🌱', n: 12, slack: 5, mult: 0.8,
      bots: [{ nm: '🦜 Tukan', ms: 2700, skill: 1, err: 0.20 }, { nm: '🐢 Kroko', ms: 3100, skill: 1, err: 0.26 }],
      info: '12×12 · viel Luft beim Zug-Limit · gemütliche Bots' },
    { key: 'norm', name: 'Normal', icon: '🌊', n: 14, slack: 3, mult: 1,
      bots: [{ nm: '🐍 Mamba', ms: 2000, skill: 2, err: 0.10 }, { nm: '🦜 Tukan', ms: 2400, skill: 1, err: 0.14 }],
      info: '14×14 · Standard-Limit · flotte Bots' },
    { key: 'hard', name: 'Profi', icon: '🔥', n: 16, slack: 1, mult: 1.3,
      bots: [{ nm: '🐆 Panther', ms: 1450, skill: 2, err: 0.02 }, { nm: '🐍 Mamba', ms: 1750, skill: 2, err: 0.06 }, { nm: '🦇 Fledi', ms: 2100, skill: 1, err: 0.12 }],
      info: '16×16 · knappes Limit · starke Bots' }
  ];
  var MULTI_DIFF = { key: 'multi', n: 14, slack: 3, mult: 1, bots: [] };

  /* ---------------- Zufall (seed-basiert, überall gleich) ---------------- */
  function rngFrom(seed) {
    var s = (seed >>> 0) || 0x9e3779b9;
    return function () {
      s = (s + 0x6D2B79F5) | 0;
      var t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function freshSeed() { return (Math.floor(Math.random() * 4294967295) ^ (Date.now() & 0xffffff)) >>> 0; }
  function seedFor(base, idx) {
    var r = rngFrom(((base >>> 0) ^ Math.imul(idx + 1, 0x9E3779B1)) >>> 0);
    r(); r();
    return Math.floor(r() * 4294967295) >>> 0;
  }

  /* ---------------- reine Brett-Logik ---------------- */
  function makeBoard(n, rng) {
    var b = [], i;
    for (i = 0; i < n * n; i++) b.push(Math.floor(rng() * NCOL) % NCOL);
    return b;
  }
  /* Zusammenhängendes Gebiet ab Ecke oben links. -> {mask, size} */
  function regionOf(b, n) {
    var mask = [], i, total = n * n;
    for (i = 0; i < total; i++) mask.push(0);
    var c = b[0], q = [0], size = 0;
    mask[0] = 1;
    while (q.length) {
      var p = q.pop(); size++;
      var x = p % n, y = (p - x) / n;
      if (x > 0 && !mask[p - 1] && b[p - 1] === c) { mask[p - 1] = 1; q.push(p - 1); }
      if (x < n - 1 && !mask[p + 1] && b[p + 1] === c) { mask[p + 1] = 1; q.push(p + 1); }
      if (y > 0 && !mask[p - n] && b[p - n] === c) { mask[p - n] = 1; q.push(p - n); }
      if (y < n - 1 && !mask[p + n] && b[p + n] === c) { mask[p + n] = 1; q.push(p + n); }
    }
    return { mask: mask, size: size };
  }
  /* Färbt das Gebiet um und liefert das gewachsene Gebiet. */
  function applyColor(b, n, c) {
    var r = regionOf(b, n), i;
    for (i = 0; i < b.length; i++) if (r.mask[i]) b[i] = c;
    return regionOf(b, n);
  }
  /* Gebietsgröße NACH dem Zug c (ohne b zu verändern). */
  function sizeAfter(b, n, c) { return applyColor(b.slice(), n, c).size; }

  /* Bester Zug. depth 1 = Greedy, depth 2 = ein Zug Vorausschau.
     ohneRnd = deterministisch (Tie-Break auf kleinsten Index). */
  function bestColor(b, n, depth) {
    var cur = b[0], best = -1, bestVal = -1, bestTie = -1, c, c2;
    for (c = 0; c < NCOL; c++) {
      if (c === cur) continue;
      var b2 = b.slice();
      var r1 = applyColor(b2, n, c);
      var val = r1.size, tie = r1.size;
      if (depth > 1 && r1.size < n * n) {
        var deep = -1;
        for (c2 = 0; c2 < NCOL; c2++) {
          if (c2 === c) continue;
          var s2 = sizeAfter(b2, n, c2);
          if (s2 > deep) deep = s2;
        }
        val = deep;
      }
      if (val > bestVal || (val === bestVal && tie > bestTie)) { bestVal = val; bestTie = tie; best = c; }
    }
    if (best < 0) best = (cur + 1) % NCOL;
    return best;
  }
  /* Deterministische Greedy-Lösung -> Zug-Zahl (Basis für das Limit). */
  function greedySolve(b0, n) {
    var b = b0.slice(), moves = 0, total = n * n;
    while (moves < 400) {
      var r = regionOf(b, n);
      if (r.size >= total) break;
      var c = bestColor(b, n, 1);
      applyColor(b, n, c);
      moves++;
    }
    return moves;
  }
  /* Feld Nr. idx aus dem Seed — bei allen Spielern identisch. */
  function puzzleFor(seed, idx, n, slack) {
    var rng = rngFrom(seedFor(seed, idx));
    var b = makeBoard(n, rng), par = greedySolve(b, n), tries = 0;
    while (par < 5 && tries < 10) { b = makeBoard(n, rng); par = greedySolve(b, n); tries++; }
    return { b: b, n: n, par: par, limit: par + slack };
  }

  function mixRgb(a, bb, t) {
    return 'rgb(' + Math.round(a[0] + (bb[0] - a[0]) * t) + ',' +
      Math.round(a[1] + (bb[1] - a[1]) * t) + ',' + Math.round(a[2] + (bb[2] - a[2]) * t) + ')';
  }
  function rgba(rgb, a) { return 'rgba(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ',' + a + ')'; }

  /* ===================================================================
   *  SPIEL
   * =================================================================== */
  App.Minigames.floodit = {
    id: 'floodit', title: 'Farb-Flut', icon: '🌊', order: 159,
    subtitle: 'Flute das Feld in möglichst wenigen Zügen',
    single: true, multi: true, minPlayers: 2, maxPlayers: 8,

    render: function (root, ctx) {
      var isMulti = ctx.mode === 'multi';
      var nowFn = isMulti ? ctx.room.now : function () { return Date.now(); };

      var dead = false;
      var stops = [];        // stop()-Funktionen (Countdown, Timer, Listener)
      var pending = [];      // laufende setTimeout-IDs
      var handlers = [];     // {evt, fn} für room.off()
      var raf = 0;

      /* Laufender Zustand */
      var diff = DIFFS[1], seed = 0, score = 0, solved = 0, boardIdx = 0;
      var finished = false, locked = true, endAt = 0;
      var col = [], mask = [], N = 14, limit = 0, moves = 0, regSize = 1, par = 0;
      var aT0 = [], aFrom = [], aKind = [];
      var bots = [];

      /* DOM */
      var canvas = null, c2d = null, cssW = 0, curDpr = 0;
      var fieldEl, movesEl, ptsEl, timerEl, barIn, cbtns = [], boardWrap, sideBox, colorsRow;

      function after(ms, fn) { var t = setTimeout(function () { if (!dead) fn(); }, ms); pending.push(t); return t; }
      function clearPending() { pending.forEach(clearTimeout); pending = []; }
      function stopHelpers() { stops.forEach(function (f) { try { f(); } catch (e) {} }); stops = []; }
      function onRoom(evt, fn) { ctx.room.on(evt, fn); handlers.push({ evt: evt, fn: fn }); }
      function offAll() {
        handlers.forEach(function (h) { try { ctx.room.off(h.evt, h.fn); } catch (e) {} });
        handlers = [];
      }
      function stopRaf() { if (raf) { cancelAnimationFrame(raf); raf = 0; } }
      function cleanup() { dead = true; stopRaf(); clearPending(); stopHelpers(); if (isMulti) offAll(); }
      function sfx(n) { if (App.Audio) App.Audio.sfx(n); }
      function blip(f, d) { if (App.Audio && App.Audio.blip) App.Audio.blip(f, d); }
      function amHost() { return !!ctx.isHost || (isMulti && ctx.room.isHost()); }
      function sharedNow() { var s = isMulti && ctx.room.snapshot(); return (s && s.shared) || null; }

      /* ---------------- Einstieg ---------------- */
      if (isMulti) {
        var snap = ctx.room.snapshot() || {};
        var startAt = (snap.round && snap.round.startAt) || (ctx.room.now() + 3000);
        stops.push(App.MG.countdown(root, startAt, function () { startMulti(startAt); }, ctx.room.now));
        if (amHost()) after(60, hostMakeSeed);      // Host würfelt schon im Countdown
      } else {
        showMenu();
      }
      return { cleanup: cleanup };

      /* ================= MEHRSPIELER ================= */
      function hostMakeSeed() {
        if (dead) return;
        var sh = sharedNow();
        if (sh && sh.fldSeed) return;               // schon verteilt
        ctx.room.setShared({ fldSeed: freshSeed() });
      }

      function startMulti(startAt) {
        if (dead) return;
        var loaded = false;
        diff = MULTI_DIFF;

        root.innerHTML = '';
        root.appendChild(el('div', { class: 'fld-menu glass' }, [
          el('div', { class: 'fld-card-ic fld-spin' }, ['🌊']),
          el('h2', { class: 'neon' }, ['Felder werden verteilt …']),
          el('p', { class: 'hint-text' }, ['Alle bekommen exakt dieselbe Feld-Folge.'])
        ]));

        function tryLoad(fallback) {
          if (dead || loaded) return;               // idempotent: 'shared' feuert sehr oft
          var sh = sharedNow();
          var s = (sh && sh.fldSeed) || fallback || 0;
          if (!s) return;
          loaded = true;
          seed = s >>> 0;
          play(startAt);
        }
        onRoom('shared', function () { tryLoad(0); });
        tryLoad(0);

        /* Notnagel: Host ist weg, bevor er verteilt hat. */
        after(6000, function () { if (!loaded && amHost()) hostMakeSeed(); });
        after(10000, function () { tryLoad(((startAt % 4294967291) + 7) >>> 0); });   // kennen alle gleich
      }

      /* ================= SOLO-MENÜ ================= */
      function showMenu() {
        clearPending(); stopHelpers(); stopRaf();
        finished = false; locked = true;

        var best = App.Storage.get('best_floodit', 0);
        var cards = DIFFS.map(function (d) {
          return el('button', {
            class: 'fld-card', type: 'button',
            onclick: function () { sfx('select'); diff = d; seed = freshSeed(); play(Date.now()); }
          }, [
            el('div', { class: 'fld-card-ic' }, [d.icon]),
            el('div', { class: 'fld-card-nm neon' }, [d.name]),
            el('div', { class: 'fld-card-in' }, [d.info])
          ]);
        });

        root.innerHTML = '';
        root.appendChild(el('div', { class: 'fld-menu glass' }, [
          el('div', { class: 'fld-card-ic' }, ['🌊']),
          el('h2', { class: 'neon' }, ['Farb-Flut']),
          el('p', { class: 'hint-text' }, [
            'Von der Ecke oben links fluten: Farbe wählen → dein Gebiet färbt sich um und schluckt alle gleichfarbigen Nachbarn. Färbe das ganze Feld unter dem Zug-Limit — in 3 Minuten so viele Felder wie möglich.'
          ]),
          el('div', { class: 'fld-cards' }, cards),
          el('div', { class: 'chip' }, ['🏆 Bestwert: ' + App.MG.fmt(best)]),
          el('div', { class: 'controls-row' }, [
            el('button', { class: 'btn btn-ghost', type: 'button', onclick: ctx.onExit }, ['Zurück'])
          ])
        ]));
      }

      /* ================= AUFBAU DER SPIELANSICHT ================= */
      function play(startAt) {
        clearPending(); stopHelpers(); stopRaf();
        score = 0; solved = 0; boardIdx = 0; finished = false; locked = false;
        endAt = startAt + DURATION * 1000;
        N = diff.n;

        fieldEl = el('div', { class: 'fld-hv' }, ['1']);
        movesEl = el('div', { class: 'fld-hv fld-mv' }, ['0/0']);
        ptsEl = el('div', { class: 'fld-hv fld-pts' }, ['0']);
        timerEl = el('div', { class: 'mg-timer' }, [App.MG.mmss(DURATION)]);
        var head = el('div', { class: 'fld-head glass' }, [
          el('div', { class: 'fld-hc' }, [el('span', { class: 'fld-hl' }, ['Feld']), fieldEl]),
          el('div', { class: 'fld-hc' }, [el('span', { class: 'fld-hl' }, ['Züge']), movesEl]),
          el('div', { class: 'fld-hc' }, [el('span', { class: 'fld-hl' }, ['Punkte']), ptsEl]),
          el('div', { class: 'fld-hc fld-hc-r' }, [el('span', { class: 'fld-hl' }, ['Zeit']), timerEl])
        ]);

        barIn = el('div', { class: 'fld-bar-in' });
        var bar = el('div', { class: 'fld-bar' }, [barIn]);

        canvas = el('canvas', { class: 'fld-canvas' });
        c2d = canvas.getContext('2d');
        boardWrap = el('div', { class: 'fld-boardwrap' }, [canvas]);

        cbtns = [];
        var i;
        for (i = 0; i < NCOL; i++) cbtns.push(makeColorBtn(i));
        colorsRow = el('div', { class: 'fld-colors' }, cbtns);

        var rule = el('p', { class: 'hint-text fld-rule' }, [
          '🌊 Ecke oben links flutet · Farbe wählen (oder ein Feld antippen · Tasten 1–6) · alles gleichfarbig = gelöst'
        ]);

        /* Rangliste: Multi = echte Live-Rangliste, Solo = Bots */
        var boardCtl = null;
        if (isMulti) {
          boardCtl = App.MG.liveBoard(ctx.room, ctx.me.id);
          stops.push(boardCtl.stop);
          sideBox = el('div', { class: 'fld-side glass' }, [
            el('div', { class: 'mg-field-title' }, ['🏆 Rangliste']), boardCtl.root
          ]);
        } else {
          bots = diff.bots.map(function (cfg) { return makeBot(cfg); });
          sideBox = el('div', { class: 'fld-side glass' }, [
            el('div', { class: 'mg-field-title' }, ['🏆 Rangliste']), el('div', { class: 'mg-scoreboard' })
          ]);
        }

        root.innerHTML = '';
        root.appendChild(el('div', { class: 'fld-layout' }, [head, bar, boardWrap, colorsRow, rule, sideBox]));

        /* --- Eingabe --- */
        canvas.addEventListener('pointerdown', onCanvasDown);
        function keyHandler(e) {
          var k = e.key;
          if (k >= '1' && k <= String(NCOL)) { e.preventDefault(); pick(parseInt(k, 10) - 1); }
        }
        document.addEventListener('keydown', keyHandler);
        stops.push(function () { document.removeEventListener('keydown', keyHandler); });
        function onResize() { fit(); }
        window.addEventListener('resize', onResize);
        stops.push(function () { window.removeEventListener('resize', onResize); });

        loadPuzzle(0);
        fit();
        drawLoop();
        renderSolo();

        /* --- Rundentimer (Wall-Clock, Tab-sicher) --- */
        stops.push(App.MG.roundTimer(endAt, function (left) {
          timerEl.textContent = App.MG.mmss(left);
          if (left <= 15) timerEl.classList.add('fld-urgent');
        }, finish, isMulti ? ctx.room.now : null));

        if (isMulti) ctx.room.reportScore(0);
      }

      function makeColorBtn(c) {
        var b = el('button', {
          class: 'fld-cbtn', type: 'button', title: 'Farbe ' + (c + 1),
          style: 'background:' + COLORS[c].hex + ';box-shadow:0 0 16px ' + rgba(COLORS[c].rgb, 0.5) + ';',
          onclick: function () { pick(c); }
        }, [String(c + 1)]);
        return b;
      }

      /* ================= FELD LADEN ================= */
      function loadPuzzle(idx) {
        var p = puzzleFor(seed, idx, N, diff.slack);
        boardIdx = idx;
        col = p.b.slice(); limit = p.limit; par = p.par; moves = 0;
        var r = regionOf(col, N);
        mask = r.mask; regSize = r.size;
        aT0 = []; aFrom = []; aKind = [];
        var i;
        for (i = 0; i < col.length; i++) { aT0.push(0); aFrom.push(col[i]); aKind.push('idle'); }
        updateHud();
      }

      function updateHud() {
        if (!fieldEl) return;
        fieldEl.textContent = String(boardIdx + 1);
        movesEl.textContent = moves + '/' + limit;
        var left = limit - moves;
        movesEl.className = 'fld-hv fld-mv' + (left <= 3 ? ' fld-low' : '');
        ptsEl.textContent = App.MG.fmt(score);
        var pct = regSize / (N * N);
        barIn.style.width = Math.round(pct * 100) + '%';
        cbtns.forEach(function (b, i) {
          if (i === col[0]) b.classList.add('is-cur'); else b.classList.remove('is-cur');
        });
      }

      /* ================= ZUG ================= */
      function onCanvasDown(e) {
        e.preventDefault();
        if (locked || finished || dead || !cssW) return;
        var r = canvas.getBoundingClientRect();
        var x = Math.floor((e.clientX - r.left) / (r.width / N));
        var y = Math.floor((e.clientY - r.top) / (r.height / N));
        if (x < 0 || y < 0 || x >= N || y >= N) return;
        pick(col[y * N + x]);
      }

      function pick(c) {
        if (locked || finished || dead) return;
        if (c < 0 || c >= NCOL) return;
        if (c === col[0]) {                       // gleiche Farbe = kein Zug
          sfx('error');
          var b = cbtns[c];
          if (b) { b.classList.remove('fld-shake'); void b.offsetWidth; b.classList.add('fld-shake'); }
          return;
        }
        doMove(c);
      }

      function doMove(c) {
        var now = Date.now(), i;
        var before = mask, total = N * N;

        /* alte Gebiets-Zellen färben sich um */
        for (i = 0; i < total; i++) {
          if (before[i]) { aFrom[i] = col[i]; aKind[i] = 'recolor'; aT0[i] = now; col[i] = c; }
        }
        /* neu geschlucktes Gebiet + Wellen-Verzögerung ab dem alten Rand */
        var after2 = regionOf(col, N);
        var dist = [], q = [];
        for (i = 0; i < total; i++) dist.push(-1);
        for (i = 0; i < total; i++) if (before[i]) { dist[i] = 0; q.push(i); }
        var qi = 0;
        while (qi < q.length) {
          var p = q[qi++], x = p % N, y = (p - x) / N, d = dist[p];
          var nb = [];
          if (x > 0) nb.push(p - 1);
          if (x < N - 1) nb.push(p + 1);
          if (y > 0) nb.push(p - N);
          if (y < N - 1) nb.push(p + N);
          for (var k = 0; k < nb.length; k++) {
            var m = nb[k];
            if (dist[m] < 0 && after2.mask[m] && !before[m]) { dist[m] = d + 1; q.push(m); }
          }
        }
        for (i = 0; i < total; i++) {
          if (after2.mask[i] && !before[i]) {
            aKind[i] = 'join'; aFrom[i] = c;
            aT0[i] = now + Math.max(0, dist[i]) * WAVE_MS;
          }
        }

        var gained = after2.size - regSize;
        mask = after2.mask; regSize = after2.size;
        moves++;
        updateHud();

        if (App.Audio && App.Audio.blip) blip(300 + Math.min(600, gained * 8), 0.05);
        else sfx('click');

        if (regSize >= total) { onSolved(); }
        else if (moves >= limit) { onFailed(); }
      }

      function onSolved() {
        locked = true;
        solved++;
        var left = limit - moves;
        var pts = Math.round(diff.mult * (100 + 25 * left));
        score += pts;
        updateHud();
        sfx('win');
        toast('🌊 Gelöst in ' + moves + ' Zügen · +' + pts, false);
        if (isMulti) ctx.room.reportScore(score);
        renderSolo();
        after(820, function () {
          if (finished || nowFn() >= endAt) return;
          loadPuzzle(boardIdx + 1);
          locked = false;
          sfx('whoosh');
        });
      }

      function onFailed() {
        locked = true;
        sfx('lose');
        toast('Zug-Limit erreicht · nächstes Feld', true);
        after(1000, function () {
          if (finished || nowFn() >= endAt) return;
          loadPuzzle(boardIdx + 1);
          locked = false;
        });
      }

      function toast(txt, bad) {
        if (!boardWrap) return;
        var t = el('div', { class: 'fld-toast' + (bad ? ' is-bad' : '') }, [txt]);
        boardWrap.appendChild(t);
        after(950, function () { if (t.parentNode) t.parentNode.removeChild(t); });
      }

      /* ================= BOTS (nur Solo) ================= */
      function makeBot(cfg) {
        var bot = {
          name: cfg.nm, ms: cfg.ms, skill: cfg.skill, err: cfg.err,
          score: 0, solved: 0, idx: 0, moves: 0, limit: 0, b: null,
          nextAt: Date.now() + 900 + Math.random() * 900
        };
        botLoad(bot, 0);
        return bot;
      }
      function botLoad(bot, idx) {
        var p = puzzleFor(seed, idx, N, diff.slack);
        bot.idx = idx; bot.b = p.b.slice(); bot.limit = p.limit; bot.moves = 0;
      }
      function botTick(now) {
        var changed = false;
        bots.forEach(function (bot) {
          if (now < bot.nextAt) return;
          var c;
          if (Math.random() < bot.err) {            // menschlicher Fehlgriff
            var cand = [];
            for (var i = 0; i < NCOL; i++) if (i !== bot.b[0]) cand.push(i);
            c = cand[Math.floor(Math.random() * cand.length)];
          } else {
            c = bestColor(bot.b, N, bot.skill);
          }
          var r = applyColor(bot.b, N, c);
          bot.moves++;
          bot.nextAt = now + bot.ms * (0.72 + Math.random() * 0.56);
          if (r.size >= N * N) {
            var left = bot.limit - bot.moves;
            bot.score += Math.round(diff.mult * (100 + 25 * left));
            bot.solved++;
            botLoad(bot, bot.idx + 1);
            bot.nextAt = now + 800 + Math.random() * 500;
            changed = true;
          } else if (bot.moves >= bot.limit) {
            botLoad(bot, bot.idx + 1);
            bot.nextAt = now + 900 + Math.random() * 500;
          }
        });
        return changed;
      }
      /* Solo-Rangliste (nutzt die gemeinsamen .mg-sb-*-Bausteine) */
      function renderSolo() {
        if (isMulti || !sideBox) return;
        var list = sideBox.querySelector('.mg-scoreboard');
        if (!list) return;
        var rows = [{ name: 'Du', score: score, me: true }];
        bots.forEach(function (b) { rows.push({ name: b.name, score: b.score, me: false }); });
        rows.sort(function (a, b) { return b.score - a.score; });
        list.innerHTML = '';
        rows.forEach(function (p, i) {
          list.appendChild(el('div', { class: 'mg-sb-row p' + (i + 1) + (p.me ? ' me' : '') }, [
            el('span', { class: 'mg-sb-rank' }, ['' + (i + 1)]),
            el('span', { class: 'mg-sb-name' }, [p.name + (p.me ? ' (du)' : '')]),
            el('span', { class: 'mg-sb-score' }, [App.MG.fmt(p.score)])
          ]));
        });
      }
      function myPlace() {
        var better = 0;
        bots.forEach(function (b) { if (b.score > score) better++; });
        return better + 1;
      }

      /* ================= ZEICHNEN ================= */
      function fit() {
        if (!canvas || !boardWrap) return;
        var dpr = Math.min(2, window.devicePixelRatio || 1);
        var w = Math.max(160, Math.round(canvas.clientWidth || boardWrap.clientWidth || 320));
        if (w === cssW && dpr === curDpr) return;
        cssW = w; curDpr = dpr;
        canvas.style.height = w + 'px';
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(w * dpr);
        c2d.setTransform(dpr, 0, 0, dpr, 0, 0);
      }

      function roundRect(g, x, y, w, h, r) {
        if (r > w / 2) r = w / 2;
        g.beginPath();
        g.moveTo(x + r, y);
        g.lineTo(x + w - r, y); g.quadraticCurveTo(x + w, y, x + w, y + r);
        g.lineTo(x + w, y + h - r); g.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
        g.lineTo(x + r, y + h); g.quadraticCurveTo(x, y + h, x, y + h - r);
        g.lineTo(x, y + r); g.quadraticCurveTo(x, y, x + r, y);
        g.closePath();
      }

      function drawLoop() {
        raf = requestAnimationFrame(function () {
          if (dead) return;
          fit();
          if (!isMulti && !finished && bots.length) { if (botTick(Date.now())) renderSolo(); }
          draw();
          if (!dead) drawLoop();
        });
      }

      function draw() {
        if (!c2d || !cssW || !col.length) return;
        var g = c2d, now = Date.now(), s = cssW / N, gap = Math.max(1, s * 0.07);
        g.clearRect(0, 0, cssW, cssW);

        var vis = [], i;
        for (i = 0; i < col.length; i++) vis.push(mask[i] && (aKind[i] !== 'join' || now >= aT0[i]) ? 1 : 0);

        for (i = 0; i < col.length; i++) {
          var x = i % N, y = (i - x) / N;
          var target = COLORS[col[i]].rgb;
          var p = aT0[i] ? (now - aT0[i]) / ANIM_MS : 1;
          var fill, sc = 1, ring = 0;
          if (aKind[i] === 'recolor' && p < 1) {
            var t = p < 0 ? 0 : p;
            fill = mixRgb(COLORS[aFrom[i]].rgb, target, t * t * (3 - 2 * t));
            sc = 1 - 0.10 * Math.sin(Math.PI * (t < 0 ? 0 : t));
          } else if (aKind[i] === 'join' && p < 1) {
            fill = 'rgb(' + target[0] + ',' + target[1] + ',' + target[2] + ')';
            if (p >= 0) { sc = 1 + 0.20 * Math.sin(Math.PI * p); ring = 1 - p; }
          } else {
            fill = 'rgb(' + target[0] + ',' + target[1] + ',' + target[2] + ')';
          }

          var cw = s - gap * 2, cx = x * s + gap, cy = y * s + gap;
          var d = (cw * (sc - 1)) / 2;
          g.save();
          if (vis[i]) { g.shadowColor = rgba(target, 0.75); g.shadowBlur = Math.min(14, s * 0.45); }
          g.fillStyle = fill;
          roundRect(g, cx - d, cy - d, cw + d * 2, cw + d * 2, Math.max(2, s * 0.2));
          g.fill();
          g.restore();

          if (!vis[i]) {                      // Felder außerhalb des Gebiets etwas dunkler
            g.fillStyle = 'rgba(2,10,6,0.30)';
            roundRect(g, cx, cy, cw, cw, Math.max(2, s * 0.2));
            g.fill();
          }
          if (ring > 0) {                     // Pop-Ring beim Verschlucken
            g.strokeStyle = 'rgba(255,255,255,' + (0.85 * ring).toFixed(3) + ')';
            g.lineWidth = Math.max(1, s * 0.09);
            roundRect(g, cx - d, cy - d, cw + d * 2, cw + d * 2, Math.max(2, s * 0.2));
            g.stroke();
          }
        }

        /* Umriss des gefluteten Gebiets */
        g.strokeStyle = 'rgba(255,255,255,0.9)';
        g.lineWidth = Math.max(1.2, s * 0.06);
        g.beginPath();
        for (i = 0; i < vis.length; i++) {
          if (!vis[i]) continue;
          var vx = i % N, vy = (i - vx) / N, X = vx * s, Y = vy * s;
          if (vy === 0 || !vis[i - N]) { g.moveTo(X, Y); g.lineTo(X + s, Y); }
          if (vy === N - 1 || !vis[i + N]) { g.moveTo(X, Y + s); g.lineTo(X + s, Y + s); }
          if (vx === 0 || !vis[i - 1]) { g.moveTo(X, Y); g.lineTo(X, Y + s); }
          if (vx === N - 1 || !vis[i + 1]) { g.moveTo(X + s, Y); g.lineTo(X + s, Y + s); }
        }
        g.stroke();

        /* Quell-Ecke markieren */
        g.font = Math.round(s * 0.62) + 'px system-ui,sans-serif';
        g.textAlign = 'center'; g.textBaseline = 'middle';
        g.globalAlpha = 0.9;
        g.fillText('🌊', s / 2, s / 2);
        g.globalAlpha = 1;
      }

      /* ================= ENDE ================= */
      function finish() {
        if (finished || dead) return;
        finished = true; locked = true;
        clearPending(); stopHelpers(); stopRaf();

        if (isMulti) {
          ctx.room.reportScore(score);
          after(900, function () {
            App.MG.endScreen(root, { players: ctx.room.players(), meId: ctx.me.id, onExit: ctx.onExit });
          });
        } else {
          var best = App.Storage.get('best_floodit', 0);
          var nb = score > best;
          if (nb) App.Storage.set('best_floodit', score);
          if (nb) sfx('jackpot');
          var place = myPlace(), total = bots.length + 1;
          App.MG.endScreen(root, {
            score: score, best: best, newBest: nb,
            label: solved + ' Feld' + (solved === 1 ? '' : 'er') + ' geflutet · Platz ' + place + ' von ' + total +
              (nb ? ' · neuer Rekord! 🎉' : ' · Bestwert: ' + App.MG.fmt(best)),
            onExit: ctx.onExit,
            onAgain: function () { finished = false; showMenu(); }
          });
        }
      }
    }
  };

  /* ===================== STYLES ===================== */
  function injectStyle() {
    UI.injectStyle('mg-floodit-css', [
      '.fld-layout{display:flex;flex-direction:column;gap:10px;}',
      /* Kopfzeile */
      '.fld-head{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:10px 16px;flex-wrap:wrap;}',
      '.fld-hc{display:flex;flex-direction:column;gap:1px;min-width:0;}',
      '.fld-hc-r{text-align:right;}',
      '.fld-hl{font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;}',
      '.fld-hv{font-size:clamp(16px,4.4vw,24px);font-weight:900;line-height:1.1;font-variant-numeric:tabular-nums;color:var(--leaf);}',
      '.fld-hv.fld-pts{color:var(--gold);text-shadow:0 0 12px rgba(255,210,63,.45);}',
      '.fld-hv.fld-mv{color:var(--aqua);text-shadow:0 0 10px rgba(51,230,208,.4);}',
      '.fld-hv.fld-mv.fld-low{color:var(--danger);text-shadow:0 0 10px rgba(255,77,109,.5);animation:fld-pulse .8s infinite;}',
      '.fld-head .mg-timer{font-size:clamp(16px,4.4vw,24px);}',
      '.fld-head .mg-timer.fld-urgent{color:var(--danger);animation:fld-pulse .7s infinite;}',
      /* Fortschrittsbalken */
      '.fld-bar{height:7px;border-radius:99px;background:rgba(255,255,255,.07);border:1px solid var(--stroke);overflow:hidden;}',
      '.fld-bar-in{height:100%;width:0;border-radius:99px;background:linear-gradient(90deg,var(--aqua),var(--neon));box-shadow:0 0 12px var(--stroke-2);transition:width .2s ease;}',
      /* Spielfeld */
      '.fld-boardwrap{position:relative;display:flex;justify-content:center;}',
      '.fld-canvas{display:block;width:100%;max-width:min(430px,46vh);border-radius:18px;border:1px solid var(--stroke);',
      'background:radial-gradient(circle at 50% 40%,#08281a,#03100a 75%);touch-action:none;cursor:pointer;',
      '-webkit-tap-highlight-color:transparent;box-shadow:0 0 30px rgba(0,0,0,.5),inset 0 0 40px rgba(57,255,20,.06);}',
      /* Farbknöpfe */
      '.fld-colors{display:grid;grid-template-columns:repeat(6,1fr);gap:8px;max-width:430px;width:100%;margin:0 auto;}',
      '.fld-cbtn{height:clamp(44px,8.5vw,54px);border-radius:14px;border:2px solid rgba(255,255,255,.22);cursor:pointer;',
      'font-family:inherit;font-weight:900;font-size:15px;color:rgba(3,14,8,.62);display:flex;align-items:center;justify-content:center;',
      '-webkit-tap-highlight-color:transparent;touch-action:manipulation;transition:transform .1s ease,opacity .15s,filter .15s;}',
      '.fld-cbtn:hover{transform:translateY(-2px);}',
      '.fld-cbtn:active{transform:scale(.92);}',
      '.fld-cbtn.is-cur{opacity:.3;filter:grayscale(.5);cursor:default;box-shadow:none !important;transform:none;}',
      '.fld-shake{animation:fld-shake .3s ease;}',
      '.fld-rule{margin:0;text-align:center;font-size:12px;}',
      /* Toast über dem Feld */
      '.fld-toast{position:absolute;left:50%;top:50%;z-index:3;pointer-events:none;white-space:nowrap;',
      'padding:12px 20px;border-radius:14px;background:rgba(3,14,8,.92);border:1px solid var(--stroke-2);',
      'font-weight:900;font-size:clamp(14px,3.6vw,20px);color:var(--neon);text-shadow:0 0 14px rgba(57,255,20,.6);',
      'animation:fld-toast .95s ease forwards;}',
      '.fld-toast.is-bad{color:var(--danger);border-color:var(--danger);text-shadow:0 0 14px rgba(255,77,109,.6);}',
      /* Rangliste */
      '.fld-side{padding:12px 14px;display:flex;flex-direction:column;gap:8px;}',
      '.fld-side .mg-scoreboard{max-height:240px;overflow-y:auto;}',
      /* Menü */
      '.fld-menu{padding:26px 22px;text-align:center;display:flex;flex-direction:column;gap:12px;align-items:center;max-width:560px;margin:0 auto;}',
      '.fld-menu h2{margin:0;}',
      '.fld-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;width:100%;}',
      '.fld-card{padding:14px 12px;border-radius:16px;border:1px solid var(--stroke);background:rgba(4,18,10,.55);',
      'cursor:pointer;font-family:inherit;color:#fff;display:flex;flex-direction:column;gap:4px;align-items:center;',
      'transition:transform .12s ease,border-color .15s,box-shadow .15s;}',
      '.fld-card:hover{transform:translateY(-3px);border-color:var(--stroke-2);box-shadow:0 0 22px var(--stroke-2);}',
      '.fld-card-ic{font-size:34px;line-height:1;filter:drop-shadow(0 0 12px var(--stroke-2));}',
      '.fld-card-nm{font-weight:900;font-size:17px;}',
      '.fld-card-in{font-size:12px;color:var(--muted);}',
      '.fld-spin{animation:fld-spin 2.4s linear infinite;}',
      /* Animationen */
      '@keyframes fld-pulse{0%,100%{opacity:1}50%{opacity:.4}}',
      '@keyframes fld-shake{0%,100%{transform:translateX(0)}25%{transform:translateX(-6px)}75%{transform:translateX(6px)}}',
      '@keyframes fld-spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}',
      '@keyframes fld-toast{0%{opacity:0;transform:translate(-50%,-28%) scale(.82)}22%{opacity:1;transform:translate(-50%,-50%) scale(1)}75%{opacity:1;transform:translate(-50%,-50%) scale(1)}100%{opacity:0;transform:translate(-50%,-78%) scale(1)}}'
    ].join(''));
  }
})();
