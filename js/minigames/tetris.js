/* tetris.js — "Neon-Tetris": der Klassiker im Neon-Dschungel-Look.
 *
 * IDEE:    10x20-Feld, die 7 Standard-Tetrominos (I O T S Z J L) fallen herab.
 *          Volle Reihen verschwinden, Level & Fallgeschwindigkeit steigen mit den
 *          gelöschten Reihen. Vorschau auf die nächsten 3 Steine + ein Halten-Slot.
 *
 * STEUERUNG (Tastatur):  ← → bewegen · ↑ / X drehen · Y/Z linksdrehen ·
 *          ↓ sanft fallen · Leertaste Hard-Drop · C / Shift Halten.
 * STEUERUNG (Handy/iPad): sichtbare Tasten unter dem Feld (◀ ⟳ ▶ / ⬇ ⤓ ⟲Halten).
 *          Zusätzlich: auf dem Feld wischen (links/rechts bewegen, runter = sanft,
 *          kurzes Tippen = drehen, schneller Wisch nach unten = Drop).
 *
 * PUNKTE:  1/2/3/4 Reihen = 100/300/500/800 × Level. Sanftes Fallen +1 pro Feld,
 *          Hard-Drop +2 pro Feld. Level = 1 + gelöschte_Reihen/10.
 *
 * SYNC-MODELL:
 *   SOLO   : Highscore-Jagd gegen best_tetris. Eigener Seed (zufällig) für den
 *            7-Bag-Randomizer. Game Over → Endscreen mit Punkten/Bestwert.
 *   MULTI  : ALLE bekommen exakt dieselbe Stein-Reihenfolge — Seed aus
 *            snapshot().round.startAt, eigener 7-Bag-Randomizer im File (kein
 *            Netz-Traffic für die Steine). 2 Minuten Zeit, jeder spielt sein
 *            eigenes Feld, höchste Punkte gewinnen (room.reportScore + Live-
 *            Rangliste). Wer vorher oben blockiert, wartet aufs Rundenende.
 *   Alle Timer laufen über Wall-Clock (Date.now bzw. room.now) → tab-sicher;
 *   requestAnimationFrame nur zum Zeichnen. cleanup() beendet wirklich alles. */
(function () {
  'use strict';
  window.App = window.App || {}; App.Minigames = App.Minigames || {};
  var UI = App.UI, el = UI.el;

  injectStyle();

  /* ================= Spielfeld-Konstanten ================= */
  var COLS = 10, ROWS = 20, CELL = 30;
  var BW = COLS * CELL, BH = ROWS * CELL;          // Canvas-Auflösung (virtuell)
  var PCELL = 15;                                   // Zellgröße in den Vorschauen
  var HW = 68, HH = 68;                             // Halten-Canvas
  var NW = 68, NH = 162;                            // Nächste-Canvas (3 Slots)
  var LOCK_DELAY = 500;                             // ms bis ein liegender Stein festfriert
  var MAX_RESETS = 15;                              // max. Lock-Verzögerungen durch Drehen/Ziehen
  var SOFT_MS = 40;                                 // Fall-Intervall bei „sanft fallen"
  var CLEAR_MS = 190;                               // ms Aufblitz-Animation voller Reihen
  var MATCH_TIME = 120;                             // s im Mehrspieler
  var LINE_SCORES = [0, 100, 300, 500, 800];       // 0/1/2/3/4 Reihen

  /* Neon-Dschungel-Farben je Stein (Index = Steinnummer, 0 = leer) */
  var COLORS = [
    null,
    '#33e6d0',  // 1 I – Aqua
    '#ffd23f',  // 2 O – Gold
    '#c17bff',  // 3 T – Violett
    '#39ff14',  // 4 S – Neon-Grün
    '#ff4d6d',  // 5 Z – Rot
    '#4d8bff',  // 6 J – Blau
    '#ff9f43'   // 7 L – Orange
  ];

  /* Basis-Matrizen der 7 Tetrominos (SRS-Spawn-Lage) */
  var SHAPES = [
    { id: 1, m: [[0, 0, 0, 0], [1, 1, 1, 1], [0, 0, 0, 0], [0, 0, 0, 0]] }, // I
    { id: 2, m: [[1, 1], [1, 1]] },                                          // O
    { id: 3, m: [[0, 1, 0], [1, 1, 1], [0, 0, 0]] },                         // T
    { id: 4, m: [[0, 1, 1], [1, 1, 0], [0, 0, 0]] },                         // S
    { id: 5, m: [[1, 1, 0], [0, 1, 1], [0, 0, 0]] },                         // Z
    { id: 6, m: [[1, 0, 0], [1, 1, 1], [0, 0, 0]] },                         // J
    { id: 7, m: [[0, 0, 1], [1, 1, 1], [0, 0, 0]] }                          // L
  ];
  /* Einfache Wand-Kicks (fühlt sich gut an, reicht für ein Casual-Tetris) */
  var KICKS = [[0, 0], [-1, 0], [1, 0], [0, -1], [-2, 0], [2, 0], [-1, -1], [1, -1]];

  function rotateMatrix(m) {
    var n = m.length, r = [], y, x, row;
    for (y = 0; y < n; y++) { row = []; for (x = 0; x < n; x++) { row.push(m[n - 1 - x][y]); } r.push(row); }
    return r;
  }
  function toCells(m) {
    var c = [], y, x;
    for (y = 0; y < m.length; y++) for (x = 0; x < m.length; x++) if (m[y][x]) c.push([x, y]);
    return c;
  }
  /* PIECES[type] = { id, box, states:[cells0..cells3] } */
  var PIECES = SHAPES.map(function (s) {
    var states = [], m = s.m, r;
    for (r = 0; r < 4; r++) { states.push(toCells(m)); m = rotateMatrix(m); }
    return { id: s.id, box: s.m.length, states: states };
  });

  /* Deterministischer PRNG (mulberry32) – gleicher Seed = gleiche Stein-Reihenfolge */
  function makeRng(seed) {
    var s = seed >>> 0;
    return function () {
      s = (s + 0x6D2B79F5) | 0;
      var t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* ================= kleine Zeichen-Helfer ================= */
  function roundRect(g, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
  }
  /* Ein einzelner Neon-Block. mode: 'solid' | 'ghost' | 'flash' */
  function block(g, x, y, size, hex, mode) {
    var pad = Math.max(1, Math.round(size * 0.06));
    var r = Math.max(3, Math.round(size * 0.18));
    var ix = x + pad, iy = y + pad, iw = size - 2 * pad, ih = size - 2 * pad;
    if (mode === 'ghost') {
      g.save(); g.globalAlpha = 0.32; g.lineWidth = 2; g.strokeStyle = hex;
      roundRect(g, ix, iy, iw, ih, r); g.stroke(); g.restore();
      return;
    }
    g.save();
    g.fillStyle = hex; roundRect(g, ix, iy, iw, ih, r); g.fill();
    g.fillStyle = 'rgba(255,255,255,0.16)';               // Glanz oben
    roundRect(g, ix, iy, iw, ih * 0.44, r); g.fill();
    g.lineWidth = 1; g.strokeStyle = 'rgba(255,255,255,0.30)';
    roundRect(g, ix + 0.5, iy + 0.5, iw - 1, ih - 1, r); g.stroke();
    if (mode === 'flash') { g.fillStyle = 'rgba(255,255,255,0.8)'; roundRect(g, ix, iy, iw, ih, r); g.fill(); }
    g.restore();
  }
  function inArr(a, v) { for (var i = 0; i < a.length; i++) if (a[i] === v) return true; return false; }
  /* Punkte mit Tausenderpunkt (deutsch) */
  function grp(n) {
    n = Math.round(n); var s = String(n), out = '', c = 0, i;
    for (i = s.length - 1; i >= 0; i--) { out = s.charAt(i) + out; if (++c % 3 === 0 && i > 0) out = '.' + out; }
    return out;
  }
  function intervalFor(level) { return Math.max(60, Math.round(800 * Math.pow(0.82, level - 1))); }

  /* ================================================================= */
  App.Minigames.tetris = {
    id: 'tetris', title: 'Neon-Tetris', icon: '🟦', order: 131,
    subtitle: 'Reihen räumen im Neon-Dschungel — Solo oder Duell',
    single: true, multi: true, minPlayers: 2, maxPlayers: 8,

    render: function (root, ctx) {
      var isMulti = ctx.mode === 'multi';
      var nowFn = isMulti ? function () { return ctx.room.now(); } : function () { return Date.now(); };

      /* ---- Laufzeit-Ressourcen (werden in cleanup/teardownRun beseitigt) ---- */
      var dead = false, finished = false;
      var raf = null;
      var timers = [], intervals = [], stops = [], listeners = [];

      function after(ms, fn) { var id = setTimeout(function () { if (!dead) fn(); }, ms); timers.push(id); return id; }
      function setIv(fn, ms) { var id = setInterval(fn, ms); intervals.push(id); return id; }
      function clearIv(id) { var i = intervals.indexOf(id); if (i >= 0) intervals.splice(i, 1); clearInterval(id); }
      function addL(t, ty, fn, opts) { t.addEventListener(ty, fn, opts); listeners.push({ t: t, ty: ty, fn: fn, opts: opts }); }
      function teardownRun() {
        if (raf) { cancelAnimationFrame(raf); raf = null; }
        timers.forEach(clearTimeout); timers = [];
        intervals.forEach(clearInterval); intervals = [];
        stops.forEach(function (f) { try { f(); } catch (e) {} }); stops = [];
        listeners.forEach(function (l) { try { l.t.removeEventListener(l.ty, l.fn, l.opts); } catch (e) {} }); listeners = [];
      }
      function cleanup() { dead = true; teardownRun(); }

      /* ---- Spielzustand (pro Runde neu in play() gesetzt) ---- */
      var grid, piece, holdType, holdUsed, queue, rng, bag;
      var score, lines, level, over, dropInterval, lastDrop, lockAt, lockResets, softDrop, clearing;
      var ctxBoard, ctxHold, ctxNext;
      var scoreEl, levelEl, linesEl, timerEl, overlay, overlayEmoji, overlayT, overlaySub;

      /* ---- Start ---- */
      if (isMulti) {
        var snap = ctx.room.snapshot() || {};
        var startAt = (snap.round && snap.round.startAt) || (ctx.room.now() + 3000);
        stops.push(App.MG.countdown(root, startAt, function () { play(startAt); }, ctx.room.now));
      } else {
        play(nowFn());
      }
      return { cleanup: cleanup };

      /* =================================================================
       *  Eine komplette Partie aufbauen und starten.
       *  startAt: im Multi = Server-Startzeit (auch der Seed). Solo = jetzt.
       * ================================================================= */
      function play(startAt) {
        teardownRun();
        finished = false; over = false; softDrop = false; clearing = null;
        score = 0; lines = 0; level = 1; dropInterval = intervalFor(1);
        holdType = -1; holdUsed = false; queue = [];

        var seed = isMulti ? (startAt >>> 0)
          : (((Date.now() >>> 0) ^ (Math.floor(Math.random() * 0xffffffff) >>> 0)) >>> 0);
        rng = makeRng(seed);
        bag = [];

        grid = [];
        for (var r = 0; r < ROWS; r++) { var row = []; for (var c = 0; c < COLS; c++) row.push(0); grid.push(row); }

        buildView(startAt);
        ensureQueue();
        spawn();
        lastDrop = nowFn(); lockAt = 0; lockResets = 0;

        raf = requestAnimationFrame(frame);
      }

      /* ---- 7-Bag-Randomizer + Vorschau-Queue ---- */
      function drawFromBag() {
        if (!bag.length) {
          bag = [0, 1, 2, 3, 4, 5, 6];
          for (var i = bag.length - 1; i > 0; i--) {
            var j = Math.floor(rng() * (i + 1));
            var t = bag[i]; bag[i] = bag[j]; bag[j] = t;
          }
        }
        return bag.shift();
      }
      function ensureQueue() { while (queue.length < 5) queue.push(drawFromBag()); }
      function spawnX(type) { return Math.floor((COLS - PIECES[type].box) / 2); }

      function spawn() {
        var t = queue.shift(); ensureQueue();
        piece = { type: t, rot: 0, x: spawnX(t), y: 0 };
        holdUsed = false; lockAt = 0; lockResets = 0; lastDrop = nowFn();
        if (collide(piece.type, piece.rot, piece.x, piece.y)) gameOver();
      }

      /* ---- Kollision / Manipulation ---- */
      function collide(type, rot, nx, ny) {
        var cells = PIECES[type].states[rot], i, cx, cy;
        for (i = 0; i < cells.length; i++) {
          cx = nx + cells[i][0]; cy = ny + cells[i][1];
          if (cx < 0 || cx >= COLS || cy >= ROWS) return true;
          if (cy >= 0 && grid[cy][cx]) return true;
        }
        return false;
      }
      function noteManip() {
        if (over || !piece) return;
        if (collide(piece.type, piece.rot, piece.x, piece.y + 1)) {
          if (lockResets < MAX_RESETS) { lockAt = nowFn() + LOCK_DELAY; lockResets++; }
        }
      }
      function move(dx) {
        if (over || finished || !piece || clearing) return;
        if (!collide(piece.type, piece.rot, piece.x + dx, piece.y)) {
          piece.x += dx; noteManip();
          if (App.Audio) App.Audio.blip(300, 0.03);
        }
      }
      function rotate(dir) {
        if (over || finished || !piece || clearing) return;
        var nrot = (piece.rot + (dir > 0 ? 1 : 3)) % 4, i, kx, ky;
        for (i = 0; i < KICKS.length; i++) {
          kx = KICKS[i][0]; ky = KICKS[i][1];
          if (!collide(piece.type, nrot, piece.x + kx, piece.y + ky)) {
            piece.x += kx; piece.y += ky; piece.rot = nrot; noteManip();
            if (App.Audio) App.Audio.blip(520, 0.04);
            return;
          }
        }
        if (App.Audio) App.Audio.blip(160, 0.03);   // blockiert
      }
      function softStep() {
        if (over || finished || !piece || clearing) return;
        if (!collide(piece.type, piece.rot, piece.x, piece.y + 1)) { piece.y++; score++; lastDrop = nowFn(); }
      }
      function hardDrop() {
        if (over || finished || !piece || clearing) return;
        var d = 0;
        while (!collide(piece.type, piece.rot, piece.x, piece.y + 1)) { piece.y++; d++; }
        if (d > 0) score += d * 2;
        if (App.Audio) App.Audio.sfx('hit');
        lockPiece(nowFn());
      }
      function doHold() {
        if (over || finished || !piece || clearing || holdUsed) return;
        var cur = piece.type;
        if (holdType < 0) { holdType = cur; spawn(); }
        else {
          var h = holdType; holdType = cur;
          piece = { type: h, rot: 0, x: spawnX(h), y: 0 };
          lastDrop = nowFn(); lockAt = 0; lockResets = 0;
          if (collide(piece.type, piece.rot, piece.x, piece.y)) { gameOver(); return; }
        }
        holdUsed = true;
        if (App.Audio) App.Audio.sfx('select');
      }

      /* ---- Stein festsetzen + Reihen prüfen ---- */
      function lockPiece(now) {
        var cells = PIECES[piece.type].states[piece.rot], id = PIECES[piece.type].id, i, cx, cy;
        for (i = 0; i < cells.length; i++) {
          cx = piece.x + cells[i][0]; cy = piece.y + cells[i][1];
          if (cy >= 0 && cy < ROWS && cx >= 0 && cx < COLS) grid[cy][cx] = id;
        }
        piece = null; lockResets = 0; lockAt = 0;
        if (App.Audio) App.Audio.sfx('step');

        var full = fullRows();
        if (full.length) {
          clearing = { rows: full, until: now + CLEAR_MS };
          if (App.Audio) App.Audio.sfx(full.length >= 4 ? 'jackpot' : 'ding');
          if (full.length >= 4 && UI.toast) UI.toast('TETRIS! 🟦 +' + grp(800 * level), 'win');
        } else {
          pushScore();
          spawn();
        }
      }
      function fullRows() {
        var res = [], r, c, ok;
        for (r = 0; r < ROWS; r++) {
          ok = true;
          for (c = 0; c < COLS; c++) if (!grid[r][c]) { ok = false; break; }
          if (ok) res.push(r);
        }
        return res;
      }
      function finalizeClear() {
        var rows = clearing.rows, n = rows.length, newg = [], r, c, er;
        for (r = 0; r < ROWS; r++) if (!inArr(rows, r)) newg.push(grid[r]);
        while (newg.length < ROWS) { er = []; for (c = 0; c < COLS; c++) er.push(0); newg.unshift(er); }
        grid = newg;
        lines += n;
        score += LINE_SCORES[n] * level;
        var nl = 1 + Math.floor(lines / 10);
        if (nl > level) {
          level = nl; dropInterval = intervalFor(level);
          if (App.Audio) App.Audio.sfx('levelup');
          if (UI.toast) UI.toast('Level ' + level + ' ⚡', 'info');
        }
        clearing = null;
        pushScore();
        spawn();
      }
      function pushScore() { if (isMulti && !dead) { try { ctx.room.reportScore(score); } catch (e) {} } }

      /* ---- Game Over ---- */
      function gameOver() {
        if (over) return;
        over = true; piece = null;
        if (App.Audio) App.Audio.sfx('explosion');
        showOverlay('💥', 'Game Over', isMulti ? 'Warte aufs Rundenende …' : 'Dein Ergebnis wird berechnet …');
        if (isMulti) { pushScore(); }
        else { after(1100, finishSolo); }
      }
      function finishSolo() {
        if (finished) return; finished = true;
        var best = App.Storage.get('best_tetris', 0);
        var nb = score > best;
        if (nb) App.Storage.set('best_tetris', score);
        App.MG.endScreen(root, {
          score: score, best: best, newBest: nb,
          format: grp,
          label: 'Level ' + level + ' · ' + lines + ' Reihen' + (nb ? ' · Neuer Rekord! 🎉' : ' · Bestwert: ' + grp(best)),
          onExit: ctx.onExit,
          onAgain: function () { over = false; finished = false; play(nowFn()); }
        });
      }
      function finishMulti() {
        if (finished) return; finished = true;
        if (!over) { over = true; }
        pushScore();
        if (raf) { cancelAnimationFrame(raf); raf = null; }
        after(1000, function () {
          App.MG.endScreen(root, { players: ctx.room.players(), meId: ctx.me.id, format: grp, onExit: ctx.onExit });
        });
      }

      /* ================= Haupt-Loop ================= */
      function update(now) {
        if (over || finished) return;
        if (clearing) { if (now >= clearing.until) finalizeClear(); return; }
        if (!piece) return;
        if (collide(piece.type, piece.rot, piece.x, piece.y + 1)) {   // liegt auf
          if (lockAt === 0) lockAt = now + LOCK_DELAY;
          if (now >= lockAt) { lockPiece(now); return; }
        } else {
          lockAt = 0; lockResets = 0;
          var iv = softDrop ? Math.min(SOFT_MS, dropInterval) : dropInterval;
          if (now - lastDrop >= iv) { lastDrop = now; piece.y++; if (softDrop) score++; }
        }
      }
      function frame() {
        raf = null;
        if (dead || finished) return;
        update(nowFn());
        if (dead || finished) return;
        draw();
        if (!over) raf = requestAnimationFrame(frame);
      }

      /* ================= Zeichnen ================= */
      function draw() {
        drawBoard();
        drawHold();
        drawNext();
        if (scoreEl) scoreEl.textContent = grp(score);
        if (levelEl) levelEl.textContent = String(level);
        if (linesEl) linesEl.textContent = String(lines);
      }
      function drawBoard() {
        var g = ctxBoard; if (!g) return;
        var grd = g.createLinearGradient(0, 0, 0, BH);
        grd.addColorStop(0, '#06180e'); grd.addColorStop(1, '#03110a');
        g.fillStyle = grd; g.fillRect(0, 0, BW, BH);
        // dezentes Gitter
        g.save(); g.strokeStyle = 'rgba(120,255,170,0.06)'; g.lineWidth = 1;
        var i;
        for (i = 1; i < COLS; i++) { g.beginPath(); g.moveTo(i * CELL, 0); g.lineTo(i * CELL, BH); g.stroke(); }
        for (i = 1; i < ROWS; i++) { g.beginPath(); g.moveTo(0, i * CELL); g.lineTo(BW, i * CELL); g.stroke(); }
        g.restore();
        // liegende Steine
        var r, c, v, isClear;
        for (r = 0; r < ROWS; r++) {
          isClear = clearing && inArr(clearing.rows, r);
          for (c = 0; c < COLS; c++) {
            v = grid[r][c];
            if (v) block(g, c * CELL, r * CELL, CELL, COLORS[v], isClear ? 'flash' : 'solid');
          }
        }
        // Ghost + aktiver Stein
        if (piece && !clearing) {
          var hex = COLORS[PIECES[piece.type].id];
          var cells = PIECES[piece.type].states[piece.rot];
          var gy = piece.y;
          while (!collide(piece.type, piece.rot, piece.x, gy + 1)) gy++;
          var k, cx, cy;
          for (k = 0; k < cells.length; k++) {
            cy = gy + cells[k][1]; cx = piece.x + cells[k][0];
            if (cy >= 0) block(g, cx * CELL, cy * CELL, CELL, hex, 'ghost');
          }
          g.save(); g.shadowColor = hex; g.shadowBlur = 10;
          for (k = 0; k < cells.length; k++) {
            cy = piece.y + cells[k][1]; cx = piece.x + cells[k][0];
            if (cy >= 0) block(g, cx * CELL, cy * CELL, CELL, hex, 'solid');
          }
          g.restore();
        }
      }
      function drawMiniBg(g, w, h) {
        g.clearRect(0, 0, w, h);
        g.fillStyle = 'rgba(4,16,10,0.55)'; g.fillRect(0, 0, w, h);
      }
      function drawPieceAt(g, x0, y0, w, h, type, cell, alpha) {
        var cells = PIECES[type].states[0], i, cx, cy;
        var minx = 9, maxx = -9, miny = 9, maxy = -9;
        for (i = 0; i < cells.length; i++) {
          cx = cells[i][0]; cy = cells[i][1];
          if (cx < minx) minx = cx; if (cx > maxx) maxx = cx;
          if (cy < miny) miny = cy; if (cy > maxy) maxy = cy;
        }
        var pw = (maxx - minx + 1) * cell, ph = (maxy - miny + 1) * cell;
        var ox = x0 + (w - pw) / 2 - minx * cell, oy = y0 + (h - ph) / 2 - miny * cell;
        g.save(); if (alpha != null) g.globalAlpha = alpha;
        for (i = 0; i < cells.length; i++) block(g, ox + cells[i][0] * cell, oy + cells[i][1] * cell, cell, COLORS[PIECES[type].id], 'solid');
        g.restore();
      }
      function drawHold() {
        var g = ctxHold; if (!g) return;
        drawMiniBg(g, HW, HH);
        if (holdType >= 0) drawPieceAt(g, 0, 0, HW, HH, holdType, PCELL, holdUsed ? 0.4 : 1);
      }
      function drawNext() {
        var g = ctxNext; if (!g) return;
        drawMiniBg(g, NW, NH);
        var slot = NH / 3, i;
        for (i = 0; i < 3; i++) if (queue[i] != null) drawPieceAt(g, 0, i * slot, NW, slot, queue[i], PCELL, 1);
      }
      function showOverlay(emoji, title, sub) {
        if (!overlay) return;
        overlayEmoji.textContent = emoji;
        overlayT.textContent = title;
        overlaySub.textContent = sub;
        overlay.style.display = 'flex';
      }

      /* ================= Ansicht aufbauen ================= */
      function buildView(startAt) {
        /* HUD */
        scoreEl = el('div', { class: 'tet-stat-v tet-v-score' }, ['0']);
        levelEl = el('div', { class: 'tet-stat-v tet-v-lvl' }, ['1']);
        linesEl = el('div', { class: 'tet-stat-v tet-v-lines' }, ['0']);
        var hudCells = [
          el('div', { class: 'tet-stat' }, [el('span', { class: 'tet-stat-l' }, ['Punkte']), scoreEl]),
          el('div', { class: 'tet-stat' }, [el('span', { class: 'tet-stat-l' }, ['Level']), levelEl]),
          el('div', { class: 'tet-stat' }, [el('span', { class: 'tet-stat-l' }, ['Reihen']), linesEl])
        ];
        if (isMulti) {
          timerEl = el('div', { class: 'mg-timer tet-v-time' }, ['2:00']);
          hudCells.push(el('div', { class: 'tet-stat' }, [el('span', { class: 'tet-stat-l' }, ['Zeit']), timerEl]));
        }
        var hud = el('div', { class: 'tet-hud glass' }, hudCells);

        /* Feld + Overlay */
        var canvas = el('canvas', { class: 'tet-board', width: BW, height: BH });
        overlayEmoji = el('div', { class: 'tet-over-emoji' }, ['💥']);
        overlayT = el('div', { class: 'tet-over-t' }, ['Game Over']);
        overlaySub = el('div', { class: 'tet-over-s hint-text' }, ['']);
        overlay = el('div', { class: 'tet-over' }, [overlayEmoji, overlayT, overlaySub]);
        overlay.style.display = 'none';
        var boardWrap = el('div', { class: 'tet-boardwrap' }, [canvas, overlay]);

        /* Seitenspalte: Halten + Nächste */
        var holdCanvas = el('canvas', { class: 'tet-mini-c', width: HW, height: HH });
        var nextCanvas = el('canvas', { class: 'tet-mini-c', width: NW, height: NH });
        var side = el('div', { class: 'tet-side' }, [
          el('div', { class: 'tet-mini glass' }, [el('div', { class: 'tet-mini-l' }, ['Halten']), holdCanvas]),
          el('div', { class: 'tet-mini glass' }, [el('div', { class: 'tet-mini-l' }, ['Nächste']), nextCanvas])
        ]);

        var main = el('div', { class: 'tet-main' }, [boardWrap, side]);

        var hint = el('div', { class: 'tet-hint hint-text' }, [
          '◀ ▶ bewegen · ⟳ drehen · ⬇ sanft · ⤓ Drop · Halten tauscht — am Handy die Tasten unten oder aufs Feld wischen'
        ]);

        /* Touch-/Klick-Steuerung */
        var bLeft = tbtn('◀', 'tet-tbtn');
        var bRot = tbtn('⟳', 'tet-tbtn tet-tbtn-rot');
        var bRight = tbtn('▶', 'tet-tbtn');
        var bSoft = tbtn('⬇', 'tet-tbtn tet-tbtn-soft');
        var bDrop = tbtn('⤓', 'tet-tbtn tet-tbtn-drop');
        var bHold = tbtn('⟲', 'tet-tbtn tet-tbtn-hold');
        var touch = el('div', { class: 'tet-touch' }, [bLeft, bRot, bRight, bSoft, bDrop, bHold]);

        var parts = [hud, main, hint, touch];

        /* Live-Rangliste (nur Multi) */
        if (isMulti) {
          var board = App.MG.liveBoard(ctx.room, ctx.me.id, { format: grp });
          stops.push(board.stop);
          parts.push(el('div', { class: 'tet-live glass' }, [
            el('div', { class: 'mg-field-title' }, ['🏆 Rangliste']), board.root
          ]));
        }

        root.innerHTML = '';
        root.appendChild(el('div', { class: 'tet-wrap' }, parts));

        ctxBoard = canvas.getContext('2d');
        ctxHold = holdCanvas.getContext('2d');
        ctxNext = nextCanvas.getContext('2d');

        /* --- Tasten-Verdrahtung --- */
        repeatBtn(bLeft, function () { move(-1); });
        repeatBtn(bRight, function () { move(1); });
        tapBtn(bRot, function () { rotate(1); });
        tapBtn(bDrop, function () { hardDrop(); });
        tapBtn(bHold, function () { doHold(); });
        holdBtn(bSoft, function (on) { softDrop = on; });

        /* --- Tastatur --- */
        addL(document, 'keydown', onKeyDown);
        addL(document, 'keyup', onKeyUp);
        addL(window, 'blur', function () { softDrop = false; });

        /* --- Wisch-Gesten auf dem Feld --- */
        attachGestures(canvas);

        /* --- Rundentimer (Multi, Wall-Clock) --- */
        if (isMulti) {
          var endAt = startAt + MATCH_TIME * 1000;
          stops.push(App.MG.roundTimer(endAt, function (left) {
            if (timerEl) { timerEl.textContent = App.MG.mmss(left); if (left <= 10) timerEl.classList.add('tet-urgent'); }
          }, finishMulti, ctx.room.now));
        }
      }

      /* Einzelner Steuerungs-Knopf */
      function tbtn(label, cls) { return el('button', { class: cls, type: 'button', 'aria-label': label }, [label]); }

      /* Knopf mit Auto-Wiederholung (DAS) für ◀ ▶ */
      function repeatBtn(btnEl, action) {
        var delayT = null, repIv = null;
        function stop() { if (delayT) { clearTimeout(delayT); delayT = null; } if (repIv) { clearIv(repIv); repIv = null; } }
        function start(e) {
          if (e && e.preventDefault) e.preventDefault();
          stop(); action();
          delayT = after(220, function () { repIv = setIv(function () { if (dead) { clearIv(repIv); repIv = null; return; } action(); }, 55); });
        }
        addL(btnEl, 'pointerdown', start);
        addL(btnEl, 'pointerup', stop);
        addL(btnEl, 'pointerleave', stop);
        addL(btnEl, 'pointercancel', stop);
      }
      /* Einmal-Aktion pro Druck */
      function tapBtn(btnEl, action) {
        addL(btnEl, 'pointerdown', function (e) { if (e && e.preventDefault) e.preventDefault(); action(); });
      }
      /* Halten-Knopf (an bei Druck, aus beim Loslassen) für ⬇ */
      function holdBtn(btnEl, setter) {
        function on(e) { if (e && e.preventDefault) e.preventDefault(); setter(true); btnEl.classList.add('is-on'); }
        function off() { setter(false); btnEl.classList.remove('is-on'); }
        addL(btnEl, 'pointerdown', on);
        addL(btnEl, 'pointerup', off);
        addL(btnEl, 'pointerleave', off);
        addL(btnEl, 'pointercancel', off);
      }

      /* Tastatur */
      function onKeyDown(e) {
        if (dead || over || finished) return;
        var k = e.key;
        if (k === 'ArrowLeft' || k === 'a' || k === 'A') { move(-1); e.preventDefault(); }
        else if (k === 'ArrowRight' || k === 'd' || k === 'D') { move(1); e.preventDefault(); }
        else if (k === 'ArrowUp' || k === 'x' || k === 'X' || k === 'w' || k === 'W') { if (!e.repeat) rotate(1); e.preventDefault(); }
        else if (k === 'y' || k === 'Y' || k === 'z' || k === 'Z' || k === 'Control') { if (!e.repeat) rotate(-1); e.preventDefault(); }
        else if (k === 'ArrowDown' || k === 's' || k === 'S') { softDrop = true; e.preventDefault(); }
        else if (k === ' ' || k === 'Spacebar') { if (!e.repeat) hardDrop(); e.preventDefault(); }
        else if (k === 'Shift' || k === 'c' || k === 'C') { if (!e.repeat) doHold(); e.preventDefault(); }
      }
      function onKeyUp(e) {
        var k = e.key;
        if (k === 'ArrowDown' || k === 's' || k === 'S') softDrop = false;
      }

      /* Wisch-Gesten: waagerecht = bewegen, runter = sanft, Tippen = drehen,
         schneller Wisch nach unten = Hard-Drop. */
      function attachGestures(canvas) {
        var active = false, sx = 0, sy = 0, lx = 0, ly = 0, st = 0, step = 24, moved = false, dropped = false;
        function down(e) {
          if (over || finished) return;
          active = true; moved = false; dropped = false;
          var rct = canvas.getBoundingClientRect();
          step = Math.max(16, rct.width / COLS);
          sx = lx = e.clientX; sy = ly = e.clientY; st = Date.now();
          e.preventDefault();
        }
        function moveG(e) {
          if (!active) return;
          e.preventDefault();
          var dx = e.clientX - lx;
          while (Math.abs(dx) >= step) {
            if (dx > 0) { move(1); lx += step; dx -= step; } else { move(-1); lx -= step; dx += step; }
            moved = true;
          }
          var dyl = e.clientY - ly;
          while (dyl >= step) { softStep(); ly += step; dyl -= step; moved = true; }
        }
        function up(e) {
          if (!active) return;
          active = false;
          var totX = e.clientX - sx, totY = e.clientY - sy, dt = Date.now() - st;
          if (!moved && Math.abs(totX) < 12 && Math.abs(totY) < 12 && dt < 260) { rotate(1); return; }
          if (!dropped && totY > step * 4 && Math.abs(totX) < step * 2 && dt < 220) { dropped = true; hardDrop(); }
        }
        addL(canvas, 'pointerdown', down);
        addL(canvas, 'pointermove', moveG);
        addL(canvas, 'pointerup', up);
        addL(canvas, 'pointercancel', function () { active = false; });
        addL(canvas, 'pointerleave', function () { active = false; });
      }
    }
  };

  /* ===================== STYLES ===================== */
  function injectStyle() {
    UI.injectStyle('mg-tetris-css', [
      '.tet-wrap{display:flex;flex-direction:column;gap:10px;max-width:560px;margin:0 auto;}',
      /* HUD */
      '.tet-hud{display:flex;justify-content:space-around;align-items:center;gap:8px;padding:9px 14px;flex-wrap:wrap;}',
      '.tet-stat{display:flex;flex-direction:column;align-items:center;gap:1px;min-width:0;}',
      '.tet-stat-l{font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;font-weight:800;}',
      '.tet-stat-v{font-size:clamp(18px,5vw,26px);font-weight:900;line-height:1;font-variant-numeric:tabular-nums;}',
      '.tet-v-score{color:var(--gold);text-shadow:0 0 12px rgba(255,210,63,.4);}',
      '.tet-v-lvl{color:var(--neon);text-shadow:0 0 10px rgba(57,255,20,.4);}',
      '.tet-v-lines{color:var(--leaf);}',
      '.tet-hud .mg-timer{font-size:clamp(18px,5vw,26px);}',
      '.mg-timer.tet-urgent{color:var(--danger);animation:tet-pulse .7s infinite;}',
      /* Feld + Seite */
      '.tet-main{display:flex;gap:10px;justify-content:center;align-items:flex-start;}',
      '.tet-boardwrap{position:relative;flex:0 0 auto;}',
      '.tet-board{display:block;height:min(54vh,520px);width:auto;aspect-ratio:1 / 2;border-radius:14px;',
      'border:2px solid rgba(57,255,20,.35);background:#04140c;',
      'box-shadow:0 0 34px rgba(57,255,20,.20),inset 0 0 50px rgba(57,255,20,.05);',
      'touch-action:none;user-select:none;-webkit-user-select:none;-webkit-tap-highlight-color:transparent;}',
      '.tet-over{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;',
      'border-radius:14px;background:rgba(3,12,8,.82);backdrop-filter:blur(2px);text-align:center;padding:14px;}',
      '.tet-over-emoji{font-size:clamp(40px,12vw,64px);line-height:1;filter:drop-shadow(0 0 14px rgba(255,77,109,.5));}',
      '.tet-over-t{font-size:clamp(22px,6vw,32px);font-weight:900;color:var(--danger);text-shadow:0 0 14px rgba(255,77,109,.5);}',
      '.tet-over-s{margin:0;}',
      '.tet-side{display:flex;flex-direction:column;gap:8px;width:clamp(74px,20vw,108px);flex:0 0 auto;}',
      '.tet-mini{padding:7px;display:flex;flex-direction:column;gap:5px;align-items:center;}',
      '.tet-mini-l{font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;font-weight:800;align-self:flex-start;}',
      '.tet-mini-c{width:100%;height:auto;display:block;}',
      /* Hinweis */
      '.tet-hint{text-align:center;line-height:1.35;margin:0;}',
      /* Touch-Tasten */
      '.tet-touch{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;width:100%;max-width:420px;margin:0 auto;}',
      '.tet-tbtn{height:clamp(46px,8.5vw,58px);border-radius:14px;border:1px solid var(--stroke);',
      'background:rgba(9,32,21,.72);color:var(--text);font-size:clamp(20px,5.5vw,26px);font-weight:900;',
      'cursor:pointer;display:flex;align-items:center;justify-content:center;line-height:1;',
      'user-select:none;-webkit-user-select:none;-webkit-tap-highlight-color:transparent;touch-action:manipulation;',
      'transition:transform .08s,border-color .12s,box-shadow .12s,background .12s;}',
      '.tet-tbtn:active{transform:scale(.94);border-color:var(--neon);box-shadow:inset 0 0 18px rgba(57,255,20,.18);}',
      '.tet-tbtn-rot{color:var(--aqua);border-color:rgba(51,230,208,.4);}',
      '.tet-tbtn-drop{color:var(--gold);border-color:rgba(255,210,63,.4);}',
      '.tet-tbtn-hold{color:var(--leaf);border-color:rgba(157,255,122,.4);}',
      '.tet-tbtn-soft.is-on{border-color:var(--neon);box-shadow:0 0 0 1px var(--neon),inset 0 0 18px rgba(57,255,20,.2);color:var(--neon);}',
      /* Live-Rangliste */
      '.tet-live{padding:12px 14px;display:flex;flex-direction:column;gap:8px;}',
      '.tet-live .mg-scoreboard{max-height:220px;overflow-y:auto;}',
      '@keyframes tet-pulse{0%,100%{opacity:1}50%{opacity:.4}}'
    ].join(''));
  }
})();
