/* crossyroad.js — "Straßen-Hopser": Crossy Road / Frogger im Neon-Dschungel.
 *
 * IDEE
 *   Ein Frosch 🐸 hüpft feldweise nach vorne (nach oben) über einen endlosen
 *   Streifen aus Gras, Straßen (fahrende Autos) und Flüssen (treibende
 *   Baumstämme). Auto berührt = überfahren. Wasser ohne Stamm = ertrunken.
 *   Auf einem Stamm reitet man mit — treibt er raus, wird man weggespült.
 *   Die Kamera scrollt mit dem Frosch mit; von unten kriecht ein fressender
 *   Rand nach (rote Gefahren-Kante). Wer stehen bleibt, sinkt hinein = weg.
 *   Weiter vorne = mehr Strecke = mehr Punkte. Schwieriger je weiter man kommt.
 *
 * STEUERUNG
 *   Tastatur: ⬆/W/Leertaste = vor, ⬇/S = zurück, ⬅/A · ➡/D = seitlich.
 *   Touch: über die Fläche wischen ODER das Neon-Steuerkreuz unter dem Feld.
 *   (Halten am Steuerkreuz wiederholt den Sprung.)
 *
 * PUNKTE
 *   Strecke = weiteste erreichte Reihe. Solo: Einzelleben, endlos, Bestwert
 *   in App.Storage('best_crossyroad'), plus drei Bot-Frösche als Renn-Rivalen
 *   (verschiedene Stufen) mit lokaler Live-Rangliste.
 *
 * SYNC-MODELL (Multiplayer, 2–8 Spieler)
 *   Kein Positions-Sync nötig: alle bekommen aus round.startAt denselben Seed
 *   und dieselbe Serverzeit-Basis, daraus werden die Hindernis-Muster rein
 *   deterministisch berechnet (gleiche Autos/Stämme für alle → fair). Jeder
 *   steuert seinen eigenen Frosch; gemeldet wird per room.reportScore(strecke)
 *   die weiteste Strecke. 2 Minuten lang, Live-Rangliste + Podest am Ende.
 *   Tod im Multiplayer = kurzer Platsch, dann Respawn am unteren Rand (die
 *   Bestmarke bleibt) → man spielt die vollen 2 Minuten weiter.
 *
 * Alle Timer/Animationen laufen über Wall-Clock (Date.now bzw. room.now),
 * rAF nur zum Zeichnen, Physik mit echtem dt → Tab-Wechsel-sicher.
 * cleanup() stoppt wirklich alles (rAF, Timer, Intervalle, Listener, room.off).
 */
(function () {
  'use strict';
  window.App = window.App || {}; App.Minigames = App.Minigames || {};
  var UI = App.UI, el = UI.el;

  /* ---- Virtuelles Spielfeld (feste Koordinaten, Canvas skaliert per CSS) ---- */
  var CELL = 60;                 // virtuelle px pro Feld
  var COLS = 9;                  // Spalten
  var VIS_ROWS = 9;              // sichtbare Reihen
  var W = COLS * CELL;           // 540
  var H = VIS_ROWS * CELL;       // 540
  var SAFE_ROWS = 2;             // erste Reihen immer Gras (Startbank)
  var ANCHOR = 5.4;             // Reihen, die der Frosch unterhalb der Oberkante sitzt
  var EAT_MARGIN = 0.85;         // ab hier frisst der nachrückende Rand
  var FROG_HALF = 0.34;          // halbe Frosch-Breite (Feldeinheiten) für Treffer
  var HOP_MS = 115;              // Dauer einer Sprung-Animation
  var MULTI_SECONDS = 120;       // 2 Minuten Multiplayer-Runde
  var REPORT_MS = 200;           // Drossel fürs Score-Melden
  var BOARD_MS = 220;            // Drossel fürs Ranglisten-Neuzeichnen (Solo)

  /* Bot-Rivalen (nur Solo): Name, Emoji, Reaktionsstufe, Geduld. */
  var BOT_DEFS = [
    { name: 'Flitzi',  emoji: '🦎', tint: '#7ff3e6', interval: 210, react: 0.40, patience: 0.10 },
    { name: 'Pieps',   emoji: '🐤', tint: '#ffd23f', interval: 300, react: 0.62, patience: 0.30 },
    { name: 'Grummel', emoji: '🐢', tint: '#9dff7a', interval: 440, react: 0.88, patience: 0.55 }
  ];

  injectStyle();

  /* ================= reine, deterministische Welt-Erzeugung ================= */
  /* mulberry32 pro Reihe: aus (seed,r) ein eigener Zufallsstrom → alle Clients
     berechnen identische Reihen. */
  function rowRng(seed, r) {
    var s = (Math.imul((r + 1) | 0, 0x9e3779b1) ^ (seed | 0)) >>> 0;
    return function () {
      s = (s + 0x6D2B79F5) >>> 0;
      var t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function difficultyAt(r) { var d = (r - SAFE_ROWS) / 95; if (d < 0) d = 0; if (d > 1) d = 1; return d; }
  function edgeSpeed(r) { return 0.5 + 1.15 * difficultyAt(r); }   // Reihen/Sekunde des fressenden Rands

  function makeLane(seed, r) {
    if (r <= SAFE_ROWS) return { type: 'grass', trees: [], treeEmoji: '🌳', shade: (r & 1) };
    var rng = rowRng(seed, r);
    var diff = difficultyAt(r);
    var pick = rng();
    var roadW = 0.40 + 0.08 * diff, waterW = 0.24 + 0.02 * diff;
    var type = (pick < roadW) ? 'road' : (pick < roadW + waterW) ? 'water' : 'grass';

    if (type === 'grass') {
      var trees = [], used = {}, n = Math.floor(rng() * 2.6);   // 0..2 Hindernisse
      for (var k = 0; k < n; k++) { var c = Math.floor(rng() * COLS); if (!used[c]) { used[c] = 1; trees.push(c); } }
      var temoji = ['🌳', '🌲', '🪨'][Math.floor(rng() * 3)];
      return { type: 'grass', trees: trees, treeEmoji: temoji, shade: (r & 1) };
    }
    var dir = rng() < 0.5 ? -1 : 1;
    if (type === 'road') {
      var truck = rng() < 0.28;
      var objLen = truck ? 2 : 1;
      var speed = (1.9 + 2.4 * diff) * (0.85 + rng() * 0.5);
      var spacing = objLen + (2.4 - 0.7 * diff) + rng() * 2.0;
      if (spacing < objLen + 1.15) spacing = objLen + 1.15;
      if (spacing > objLen + 4.5) spacing = objLen + 4.5;
      var pal = ['#ff4d6d', '#ff8098', '#ff9f45', '#c86bff', '#4db5ff', '#ffd23f'];
      return { type: 'road', dir: dir, speed: speed, objLen: objLen, spacing: spacing, phase: rng() * spacing, truck: truck, color: pal[Math.floor(rng() * pal.length)] };
    }
    var oLen = 2 + Math.floor(rng() * 2);      // Stämme 2..3 lang
    var wspeed = (1.0 + 1.15 * diff) * (0.85 + rng() * 0.45);
    var wspacing = oLen + (1.6 - 0.3 * diff) + rng() * 1.7;
    if (wspacing < oLen + 1.2) wspacing = oLen + 1.2;
    if (wspacing > oLen + 3.4) wspacing = oLen + 3.4;
    return { type: 'water', dir: dir, speed: wspeed, objLen: oLen, spacing: wspacing, phase: rng() * wspacing };
  }

  /* Zentren aller Hindernisse einer Lane zur Zeit "elapsed" (Feldeinheiten). */
  function objectsInLane(L, elapsed) {
    var off = L.phase + L.dir * L.speed * elapsed;
    var sp = L.spacing;
    var base = off - Math.floor(off / sp) * sp;   // off mod sp in [0,sp)
    var arr = [];
    for (var x = base - sp; x < COLS + sp; x += sp) arr.push(x);
    return arr;
  }

  /* Spalten-Reihenfolge von der Mitte nach außen (für Respawn-Suche). */
  var CENTER_ORDER = (function () {
    var mid = Math.floor(COLS / 2), a = [mid];
    for (var d = 1; d <= COLS; d++) { if (mid - d >= 0) a.push(mid - d); if (mid + d <= COLS - 1) a.push(mid + d); }
    return a;
  })();

  App.Minigames.crossyroad = {
    id: 'crossyroad', title: 'Straßen-Hopser', icon: '🐸', order: 138,
    subtitle: 'Über Straßen & Flüsse hüpfen – nicht trödeln!',
    single: true, multi: true, minPlayers: 2, maxPlayers: 8,

    render: function (root, ctx) {
      var isMulti = ctx.mode === 'multi';
      var nowFn = isMulti ? function () { return ctx.room.now(); } : function () { return Date.now(); };

      /* ---- Aufräum-Buchhaltung ---- */
      var gone = false, raf = null, last = 0;
      var timers = [], stops = [], listeners = [];
      function after(ms, fn) { var t = setTimeout(function () { if (!gone) fn(); }, ms); timers.push(t); return t; }
      function addL(target, type, fn, opts) { target.addEventListener(type, fn, opts); listeners.push({ t: target, ty: type, fn: fn, opts: opts }); }
      function stopLoop() { if (raf) { cancelAnimationFrame(raf); raf = null; } }
      function cleanup() {
        gone = true; state = 'over';
        stopLoop();
        timers.forEach(clearTimeout); timers = [];
        stops.forEach(function (f) { try { f(); } catch (e) {} }); stops = [];
        listeners.forEach(function (l) { try { l.t.removeEventListener(l.ty, l.fn, l.opts); } catch (e) {} }); listeners = [];
      }

      /* ---- Laufzeit-Zustand (wird in play() frisch gesetzt) ---- */
      var state = 'boot';          // 'countdown'|'playing'|'dead'|'over'
      var seed = 0, originMs = 0, endAt = 0;
      var laneCache = {};
      var camTopRow = 0;
      var player = null, bots = [];
      var score = 0, best = 0, reportedScore = -1, lastReport = 0, lastBoard = 0;
      var ctx2d = null, canvas = null, distEl = null, timerEl = null, board = null, soloBoardEl = null;
      var deadInfo = null, bumpAt = 0;

      function getLane(r) { var L = laneCache[r]; if (!L) { L = makeLane(seed, r); laneCache[r] = L; } return L; }
      function elapsedNow() { return (nowFn() - originMs) / 1000; }
      function clampCol(x) { return Math.max(0.5, Math.min(COLS - 0.5, x)); }
      function yTop(r) { return (camTopRow - r) * CELL; }
      function easeHop(t) { return t < 0 ? 0 : t > 1 ? 1 : t * (2 - t); }

      /* ================= Start ================= */
      if (isMulti) {
        var snap = ctx.room.snapshot() || {};
        var startAt = (snap.round && snap.round.startAt) || (ctx.room.now() + 3000);
        stops.push(App.MG.countdown(root, startAt, function () { play(startAt); }, ctx.room.now));
      } else {
        play(Date.now());
      }
      return { cleanup: cleanup };

      /* ================= Spiel aufbauen / (neu) starten ================= */
      function play(startTime) {
        stopLoop();
        laneCache = {};
        seed = isMulti ? Math.floor(startTime) : ((Date.now() ^ Math.floor(Math.random() * 0x7fffffff)) | 0);
        originMs = isMulti ? startTime : Date.now();
        endAt = originMs + MULTI_SECONDS * 1000;
        score = 0; reportedScore = -1; lastReport = 0; lastBoard = 0; deadInfo = null;
        best = App.Storage.get('best_crossyroad', 0) || 0;

        player = { row: 0, x: (Math.floor(COLS / 2)) + 0.5, visRow: 0, visX: (Math.floor(COLS / 2)) + 0.5, hopLift: 0, onLog: false, alive: true, hop: { active: false, fromX: 0, fromRow: 0, t0: 0 } };
        camTopRow = player.row + ANCHOR;
        bots = isMulti ? [] : makeBots();

        buildStage();
        setupInput();
        state = 'playing';

        if (isMulti) {
          try { ctx.room.reportScore(0); } catch (e) {}
          stops.push(App.MG.roundTimer(endAt, function (leftSec) {
            if (!timerEl) return;
            timerEl.textContent = App.MG.mmss(leftSec);
            timerEl.classList.toggle('cro-urgent', leftSec <= 10);
          }, finishMulti, ctx.room.now));
        }

        last = nowFn();
        raf = requestAnimationFrame(frame);
      }

      function makeBots() {
        return BOT_DEFS.map(function (d) {
          return {
            name: d.name, emoji: d.emoji, tint: d.tint,
            interval: d.interval, react: d.react, patience: d.patience,
            row: 0, x: (Math.floor(COLS / 2)) + 0.5, visRow: 0, visX: (Math.floor(COLS / 2)) + 0.5,
            hopLift: 0, onLog: false, dist: 0, decideAt: nowFn() + 400 + Math.random() * 400,
            hop: { active: false, fromX: 0, fromRow: 0, t0: 0 }
          };
        });
      }

      /* ================= DOM ================= */
      function buildStage() {
        distEl = el('div', { class: 'cro-big' }, ['0']);
        var rightVal = isMulti ? (timerEl = el('div', { class: 'mg-timer cro-timerval' }, [App.MG.mmss(MULTI_SECONDS)]))
                               : el('div', { class: 'cro-big cro-best' }, [String(best)]);
        var head = el('div', { class: 'cro-head glass' }, [
          el('div', { class: 'cro-head-cell' }, [el('span', { class: 'cro-head-l' }, ['🏁 Strecke']), distEl]),
          el('div', { class: 'cro-head-cell cro-head-r' }, [
            el('span', { class: 'cro-head-l' }, [isMulti ? '⏱ Zeit' : '⭐ Rekord']),
            rightVal
          ])
        ]);

        canvas = el('canvas', { class: 'cro-canvas', width: W, height: H });
        var stage = el('div', { class: 'cro-stage' }, [canvas]);

        var dpad = el('div', { class: 'cro-dpad' }, [
          dbtn('cro-up', '⬆', 'up'),
          dbtn('cro-left', '⬅', 'left'),
          dbtn('cro-right', '➡', 'right'),
          dbtn('cro-down', '⬇', 'down')
        ]);

        var hint = el('div', { class: 'cro-hint hint-text' },
          ['Wischen oder Steuerkreuz · weich Autos aus, reite Stämme · nicht stehen bleiben!']);

        var boardWrap;
        if (isMulti) {
          board = App.MG.liveBoard(ctx.room, ctx.me.id, { format: function (v) { return (Math.round(v || 0)) + ' m'; } });
          stops.push(board.stop);
          boardWrap = el('div', { class: 'cro-board-wrap glass' }, [
            el('div', { class: 'mg-field-title' }, ['🏆 Rangliste']), board.root
          ]);
        } else {
          soloBoardEl = el('div', { class: 'mg-scoreboard' });
          boardWrap = el('div', { class: 'cro-board-wrap glass' }, [
            el('div', { class: 'mg-field-title' }, ['🏆 Frosch-Rennen']), soloBoardEl
          ]);
        }

        var wrap = el('div', { class: 'cro-wrap' }, [head, stage, dpad, hint, boardWrap]);
        root.innerHTML = ''; root.appendChild(wrap);
        ctx2d = canvas.getContext('2d');
        if (!isMulti) updateSoloBoard();
      }

      function dbtn(cls, glyph, dir) {
        var b = el('button', { class: 'cro-btn ' + cls, type: 'button', 'aria-label': dir }, [glyph]);
        bindHold(b, dir);
        return b;
      }
      function bindHold(btn, dir) {
        var rep = null;
        function stopRep() { if (rep) { clearInterval(rep); rep = null; } }
        function press(e) {
          if (e && e.preventDefault) e.preventDefault();
          attemptMove(dir);
          stopRep();
          rep = setInterval(function () { if (!gone && state === 'playing' && player && player.alive) attemptMove(dir); }, 165);
        }
        addL(btn, 'pointerdown', press);
        addL(btn, 'pointerup', stopRep);
        addL(btn, 'pointerleave', stopRep);
        addL(btn, 'pointercancel', stopRep);
        stops.push(stopRep);
      }

      /* ================= Eingabe ================= */
      function setupInput() {
        var onKey = function (e) {
          var k = e.key;
          var dir = null;
          if (k === 'ArrowUp' || k === 'w' || k === 'W' || k === ' ' || k === 'Spacebar') dir = 'up';
          else if (k === 'ArrowDown' || k === 's' || k === 'S') dir = 'down';
          else if (k === 'ArrowLeft' || k === 'a' || k === 'A') dir = 'left';
          else if (k === 'ArrowRight' || k === 'd' || k === 'D') dir = 'right';
          if (dir) { e.preventDefault(); attemptMove(dir); }
        };
        addL(document, 'keydown', onKey);

        /* Wischen auf der Fläche — feuert schon während der Bewegung erneut. */
        var swActive = false, sx = 0, sy = 0, swMoved = false;
        var TH = 26;
        addL(canvas, 'pointerdown', function (e) { swActive = true; swMoved = false; sx = e.clientX; sy = e.clientY; });
        addL(canvas, 'pointermove', function (e) {
          if (!swActive) return;
          var dx = e.clientX - sx, dy = e.clientY - sy;
          if (Math.max(Math.abs(dx), Math.abs(dy)) < TH) return;
          swMoved = true;
          if (Math.abs(dx) > Math.abs(dy)) attemptMove(dx > 0 ? 'right' : 'left');
          else attemptMove(dy > 0 ? 'down' : 'up');
          sx = e.clientX; sy = e.clientY;    // Ursprung nachziehen → mehrfaches Wischen
        });
        var endSwipe = function (e) { if (swActive && !swMoved) attemptMove('up'); swActive = false; };
        addL(canvas, 'pointerup', endSwipe);
        addL(canvas, 'pointercancel', function () { swActive = false; });
      }

      function bump() {
        bumpAt = nowFn();
        if (App.Audio) App.Audio.blip(150, 0.07, { type: 'square', peak: 0.05 });
      }

      function attemptMove(dir) {
        if (gone || state !== 'playing' || !player || !player.alive) return;
        var nr = player.row, nx = player.x;
        if (dir === 'up') nr = player.row + 1;
        else if (dir === 'down') nr = Math.max(0, player.row - 1);
        else if (dir === 'left') { var lc = Math.round(player.x - 0.5) - 1; if (lc < 0) { bump(); return; } nx = lc + 0.5; }
        else if (dir === 'right') { var rc = Math.round(player.x - 0.5) + 1; if (rc > COLS - 1) { bump(); return; } nx = rc + 0.5; }

        var L = getLane(nr);
        /* auf Nicht-Wasser immer auf Spaltenmitte einrasten */
        if (L.type !== 'water') nx = clampCol(Math.round(nx - 0.5) + 0.5);
        /* Baum/Fels blockiert das Feld */
        if (L.type === 'grass' && L.trees.indexOf(Math.round(nx - 0.5)) >= 0) { bump(); return; }

        startHop(player, nx, nr, true);
        if (App.Audio) App.Audio.sfx('step');
        if (player.row > score) {
          score = player.row;
          if (distEl) { distEl.textContent = String(score); distEl.classList.remove('cro-pop'); void distEl.offsetWidth; distEl.classList.add('cro-pop'); }
          if (score % 5 === 0 && App.Audio) App.Audio.sfx('point');
        }
      }

      function startHop(ent, nx, nr, isPlayer) {
        ent.hop.fromX = (ent.visX != null) ? ent.visX : ent.x;
        ent.hop.fromRow = (ent.visRow != null) ? ent.visRow : ent.row;
        ent.hop.t0 = nowFn();
        ent.hop.active = true;
        ent.x = nx; ent.row = nr; ent.onLog = false;
      }

      /* ================= Haupt-Loop ================= */
      function frame() {
        if (gone) { raf = null; return; }
        var now = nowFn();
        var dt = (now - last) / 1000; if (dt < 0) dt = 0; if (dt > 0.05) dt = 0.05; last = now;

        if (state === 'playing') {
          updatePlayer(dt);
          if (player.alive) {
            if (!isMulti) updateBots(dt, now);
            updateCamera(dt);
            checkEdge();
            maybeReport(now);
            if (!isMulti) maybeBoard(now);
          }
        }
        updateHopVisual(player, now);
        if (!isMulti) for (var i = 0; i < bots.length; i++) updateHopVisual(bots[i], now);

        draw(now);
        raf = requestAnimationFrame(frame);
      }

      function updatePlayer(dt) {
        var L = getLane(player.row), elapsed = elapsedNow();
        if (L.type === 'road') {
          player.onLog = false;
          var objs = objectsInLane(L, elapsed), half = L.objLen / 2 + FROG_HALF;
          for (var i = 0; i < objs.length; i++) if (Math.abs(player.x - objs[i]) < half) { die('car'); return; }
        } else if (L.type === 'water') {
          var objs2 = objectsInLane(L, elapsed), ride = null, hl = L.objLen / 2 - 0.06;
          for (var j = 0; j < objs2.length; j++) if (Math.abs(player.x - objs2[j]) < hl) { ride = objs2[j]; break; }
          if (ride == null) { die('water'); return; }
          player.onLog = true;
          var drift = L.dir * L.speed * dt;
          player.x += drift; if (player.hop.active) player.hop.fromX += drift;
          if (player.x < 0.42 || player.x > COLS - 0.42) { die('swept'); return; }
        } else {
          player.onLog = false;
        }
      }

      function updateCamera(dt) {
        camTopRow += edgeSpeed(player.row) * dt;             // Rand kriecht immer nach
        var follow = player.row + ANCHOR;
        if (follow > camTopRow) camTopRow += (follow - camTopRow) * Math.min(1, dt * 7);
      }

      function checkEdge() {
        if (player.row < (camTopRow - VIS_ROWS) + EAT_MARGIN) die('edge');
      }

      function updateHopVisual(ent, now) {
        if (!ent) return;
        if (ent.hop && ent.hop.active) {
          var tt = (now - ent.hop.t0) / HOP_MS; if (tt >= 1) { tt = 1; ent.hop.active = false; }
          var e = easeHop(tt);
          ent.visX = ent.hop.fromX + (ent.x - ent.hop.fromX) * e;
          ent.visRow = ent.hop.fromRow + (ent.row - ent.hop.fromRow) * e;
          ent.hopLift = Math.sin(Math.PI * tt);
        } else {
          ent.visX = ent.x; ent.visRow = ent.row; ent.hopLift = 0;
        }
      }

      function maybeReport(now) {
        if (!isMulti) return;
        if (score > reportedScore && now - lastReport > REPORT_MS) {
          lastReport = now; reportedScore = score;
          try { ctx.room.reportScore(score); } catch (e) {}
        }
      }
      function maybeBoard(now) {
        if (now - lastBoard < BOARD_MS) return;
        lastBoard = now; updateSoloBoard();
      }

      /* ================= Tod / Respawn / Ende ================= */
      function die(cause) {
        if (!player.alive) return;
        player.alive = false; state = 'dead';
        deadInfo = { cause: cause, x: player.visX, row: player.visRow, at: nowFn() };
        if (App.Audio) {
          if (cause === 'car') App.Audio.sfx('explosion');
          else if (cause === 'edge') App.Audio.sfx('lose');
          else { App.Audio.sfx('bust'); App.Audio.sweep(420, 120, 0.28); }
        }
        if (isMulti) {
          try { ctx.room.reportScore(score); } catch (e) {}
          after(950, function () { if (!gone) respawn(); });
        } else {
          after(720, finishSolo);
        }
      }

      function respawn() {
        if (gone || state === 'over') return;
        var spot = findGrassSpot(Math.ceil(camTopRow - VIS_ROWS) + 2);
        player.row = spot.r; player.x = spot.x; player.visRow = spot.r; player.visX = spot.x;
        player.onLog = false; player.alive = true; player.hop.active = false; player.hopLift = 0;
        camTopRow = player.row + ANCHOR;
        deadInfo = null; state = 'playing';
        if (App.Audio) App.Audio.sfx('start');
      }

      function findGrassSpot(fromR) {
        for (var r = fromR; r < fromR + 60; r++) {
          var L = getLane(r);
          if (L.type === 'grass') {
            for (var i = 0; i < CENTER_ORDER.length; i++) {
              var c = CENTER_ORDER[i];
              if (L.trees.indexOf(c) < 0) return { r: r, x: c + 0.5 };
            }
          }
        }
        return { r: fromR, x: Math.floor(COLS / 2) + 0.5 };
      }

      function finishSolo() {
        if (gone || state === 'over') return;
        state = 'over'; stopLoop();
        var nb = score > best;
        if (nb) App.Storage.set('best_crossyroad', score);
        if (App.Scores) { try { App.Scores.submitCurrent(score); } catch (e) {} }
        var causeTxt = deadInfo ? ({ car: 'Überfahren! 🚗', water: 'Ertrunken! 💧', swept: 'Weggespült! 🌊', edge: 'Vom Rand gefressen! 🌑' }[deadInfo.cause] || '') : '';
        App.MG.endScreen(root, {
          score: score, best: best, newBest: nb,
          format: function (v) { return (Math.round(v || 0)) + ' m'; },
          label: causeTxt + (nb ? ' · Neuer Rekord! 🎉' : ' · Bestwert: ' + best + ' m'),
          onExit: ctx.onExit,
          onAgain: function () { play(Date.now()); }
        });
      }

      function finishMulti() {
        if (gone || state === 'over') return;
        state = 'over';
        try { ctx.room.reportScore(score); } catch (e) {}
        after(900, function () {
          if (gone) return;
          stopLoop();
          App.MG.endScreen(root, {
            players: ctx.room.players(), meId: ctx.me.id,
            format: function (v) { return (Math.round(v || 0)) + ' m'; },
            onExit: ctx.onExit
          });
        });
      }

      /* ================= Bot-KI (nur Solo) ================= */
      function updateBots(dt, now) {
        var elapsed = elapsedNow(), bottom = camTopRow - VIS_ROWS;
        for (var b = 0; b < bots.length; b++) {
          var bot = bots[b], L = getLane(bot.row);
          if (L.type === 'water') {
            var objs = objectsInLane(L, elapsed), ride = null, hl = L.objLen / 2 - 0.06;
            for (var i = 0; i < objs.length; i++) if (Math.abs(bot.x - objs[i]) < hl) { ride = objs[i]; break; }
            if (ride == null) { botRespawn(bot); continue; }
            bot.onLog = true;
            var d = L.dir * L.speed * dt;
            bot.x += d; if (bot.hop.active) bot.hop.fromX += d;
            if (bot.x < 0.5 || bot.x > COLS - 0.5) bot.x = clampCol(bot.x);
          } else if (L.type === 'road') {
            bot.onLog = false;
            var objs2 = objectsInLane(L, elapsed), half = L.objLen / 2 + FROG_HALF + 0.05, hit = false;
            for (var j = 0; j < objs2.length; j++) if (Math.abs(bot.x - objs2[j]) < half) { hit = true; break; }
            if (hit) { botRespawn(bot); continue; }
          } else bot.onLog = false;

          if (now >= bot.decideAt) botDecide(bot, now, elapsed, bottom);
          if (bot.row < bottom - 0.5) botRespawn(bot);
        }
      }

      function botDecide(bot, now, elapsed, bottom) {
        bot.decideAt = now + bot.interval * (0.75 + Math.random() * 0.6);
        var edgeFar = (bot.row - bottom) > 3.2;

        if (botCanEnter(bot.row + 1, bot.x, elapsed, bot.react)) {
          if (edgeFar && Math.random() < bot.patience) return;   // manchmal abwarten
          return botHop(bot, bot.x, bot.row + 1);
        }
        var lc = Math.round(bot.x - 0.5) - 1, rc = Math.round(bot.x - 0.5) + 1, opts = [];
        if (lc >= 0 && botCanEnter(bot.row, lc + 0.5, elapsed, 0) && botCanEnter(bot.row + 1, lc + 0.5, elapsed, bot.react)) opts.push(lc + 0.5);
        if (rc <= COLS - 1 && botCanEnter(bot.row, rc + 0.5, elapsed, 0) && botCanEnter(bot.row + 1, rc + 0.5, elapsed, bot.react)) opts.push(rc + 0.5);
        if (opts.length) return botHop(bot, opts[Math.floor(Math.random() * opts.length)], bot.row);

        if (!edgeFar && botClearNow(bot.row + 1, bot.x, elapsed)) return botHop(bot, bot.x, bot.row + 1);

        /* auf einem Stamm treibend nach innen ausweichen, um nicht rauszutreiben */
        if (getLane(bot.row).type === 'water') {
          if (bot.x < 2 && lc + 1 >= 0) botHop(bot, bot.x + 1, bot.row);
          else if (bot.x > COLS - 2) botHop(bot, bot.x - 1, bot.row);
        }
      }

      function botCanEnter(row, x, elapsed, react) {
        var L = getLane(row);
        if (L.type === 'grass') return L.trees.indexOf(Math.round(x - 0.5)) < 0;
        if (L.type === 'road') {
          var half = L.objLen / 2 + FROG_HALF + 0.1, samples = [0, react * 0.5, react];
          for (var s = 0; s < samples.length; s++) {
            var objs = objectsInLane(L, elapsed + samples[s]);
            for (var i = 0; i < objs.length; i++) if (Math.abs(x - objs[i]) < half) return false;
          }
          return true;
        }
        if (L.type === 'water') {
          var objs2 = objectsInLane(L, elapsed), hl = L.objLen / 2 - 0.15;
          for (var j = 0; j < objs2.length; j++) if (Math.abs(x - objs2[j]) < hl) return true;
          return false;
        }
        return true;
      }
      function botClearNow(row, x, elapsed) {
        var L = getLane(row);
        if (L.type === 'grass') return L.trees.indexOf(Math.round(x - 0.5)) < 0;
        if (L.type === 'road') {
          var objs = objectsInLane(L, elapsed), half = L.objLen / 2 + FROG_HALF + 0.1;
          for (var i = 0; i < objs.length; i++) if (Math.abs(x - objs[i]) < half) return false;
          return true;
        }
        if (L.type === 'water') {
          var objs2 = objectsInLane(L, elapsed), hl = L.objLen / 2 - 0.15;
          for (var j = 0; j < objs2.length; j++) if (Math.abs(x - objs2[j]) < hl) return true;
          return false;
        }
        return true;
      }
      function botHop(bot, nx, nr) {
        var L = getLane(nr), fx = nx;
        if (L.type !== 'water') fx = clampCol(Math.round(nx - 0.5) + 0.5);
        startHop(bot, fx, nr, false);
        if (nr > bot.dist) bot.dist = nr;
      }
      function botRespawn(bot) {
        var spot = findGrassSpot(Math.ceil(camTopRow - VIS_ROWS) + 2);
        bot.row = spot.r; bot.x = spot.x; bot.visRow = spot.r; bot.visX = spot.x;
        bot.onLog = false; bot.hop.active = false; bot.hopLift = 0; bot.decideAt = nowFn() + 150;
        if (spot.r > bot.dist) bot.dist = spot.r;
      }

      function updateSoloBoard() {
        if (!soloBoardEl) return;
        var rows = [{ name: (ctx.me && ctx.me.name) || 'Du', emoji: '🐸', dist: score, me: true }];
        bots.forEach(function (b) { rows.push({ name: b.name, emoji: b.emoji, dist: b.dist, me: false }); });
        rows.sort(function (a, b) { return b.dist - a.dist; });
        soloBoardEl.innerHTML = '';
        rows.forEach(function (p, i) {
          soloBoardEl.appendChild(el('div', { class: 'mg-sb-row p' + (i + 1) + (p.me ? ' me' : '') }, [
            el('span', { class: 'mg-sb-rank' }, ['' + (i + 1)]),
            el('span', { class: 'mg-sb-name' }, [p.emoji + ' ' + p.name + (p.me ? ' (du)' : '')]),
            el('span', { class: 'mg-sb-score' }, [String(p.dist) + ' m'])
          ]));
        });
      }

      /* ================= Zeichnen ================= */
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

      function draw(now) {
        var g = ctx2d; if (!g) return;
        g.clearRect(0, 0, W, H);
        var top = Math.ceil(camTopRow) + 1;
        var bot = Math.floor(camTopRow - VIS_ROWS) - 1;
        for (var r = bot; r <= top; r++) drawLane(g, r);
        if (!isMulti) for (var i = 0; i < bots.length; i++) drawEntity(g, bots[i], false);
        drawPlayer(g);
        if (state === 'dead' && deadInfo) drawSplat(g);
        drawEdge(g, now);
        drawTopFade(g);
      }

      function drawLane(g, r) {
        var L = getLane(r), y = yTop(r);
        if (y > H + CELL || y < -CELL * 2) return;
        if (L.type === 'grass') {
          g.fillStyle = L.shade ? '#0e3320' : '#0b2a1a'; g.fillRect(0, y, W, CELL);
          g.fillStyle = 'rgba(57,255,20,.07)'; g.fillRect(0, y, W, 2);
          if (L.trees.length) {
            g.save(); g.textAlign = 'center'; g.textBaseline = 'middle';
            g.font = (CELL * 0.7) + 'px "Segoe UI Emoji","Noto Color Emoji",system-ui,sans-serif';
            for (var i = 0; i < L.trees.length; i++) g.fillText(L.treeEmoji, (L.trees[i] + 0.5) * CELL, y + CELL * 0.54);
            g.restore();
          }
        } else if (L.type === 'road') {
          g.fillStyle = '#12181d'; g.fillRect(0, y, W, CELL);
          g.fillStyle = 'rgba(0,0,0,.28)'; g.fillRect(0, y, W, 3); g.fillRect(0, y + CELL - 3, W, 3);
          g.save(); g.strokeStyle = 'rgba(157,255,122,.26)'; g.lineWidth = 3; g.setLineDash([16, 16]);
          g.beginPath(); g.moveTo(0, y + CELL / 2); g.lineTo(W, y + CELL / 2); g.stroke(); g.restore();
          var objs = objectsInLane(L, elapsedNow());
          for (var c = 0; c < objs.length; c++) drawCar(g, L, objs[c], y);
        } else {
          var grd = g.createLinearGradient(0, y, 0, y + CELL);
          grd.addColorStop(0, '#06303a'); grd.addColorStop(1, '#052330');
          g.fillStyle = grd; g.fillRect(0, y, W, CELL);
          g.save(); g.strokeStyle = 'rgba(127,243,230,.13)'; g.lineWidth = 2; g.setLineDash([10, 14]);
          g.beginPath(); g.moveTo(0, y + CELL * 0.32); g.lineTo(W, y + CELL * 0.32);
          g.moveTo(0, y + CELL * 0.7); g.lineTo(W, y + CELL * 0.7); g.stroke(); g.restore();
          var objs2 = objectsInLane(L, elapsedNow());
          for (var d = 0; d < objs2.length; d++) drawLog(g, L, objs2[d], y);
        }
      }

      function drawCar(g, L, xo, y) {
        var w = L.objLen * CELL * 0.9, h = CELL * 0.6, cx = xo * CELL, left = cx - w / 2, top = y + (CELL - h) / 2;
        if (left > W + 20 || left + w < -20) return;
        g.save();
        g.shadowColor = L.color; g.shadowBlur = 14;
        g.fillStyle = L.color; roundRect(g, left, top, w, h, 10); g.fill();
        g.shadowBlur = 0;
        g.fillStyle = 'rgba(255,255,255,.22)'; roundRect(g, left + w * 0.12, top + h * 0.16, w * 0.76, h * 0.34, 6); g.fill();
        g.fillStyle = 'rgba(255,255,210,.92)';
        var hx = L.dir > 0 ? left + w - 5 : left + 1;
        g.fillRect(hx, top + h * 0.18, 4, 5); g.fillRect(hx, top + h * 0.62, 4, 5);
        g.restore();
      }

      function drawLog(g, L, xo, y) {
        var w = L.objLen * CELL * 0.94, h = CELL * 0.62, cx = xo * CELL, left = cx - w / 2, top = y + (CELL - h) / 2;
        if (left > W + 20 || left + w < -20) return;
        g.save();
        g.fillStyle = '#5a3a20'; roundRect(g, left, top, w, h, 12); g.fill();
        g.strokeStyle = 'rgba(138,90,48,.9)'; g.lineWidth = 2; roundRect(g, left, top, w, h, 12); g.stroke();
        g.fillStyle = '#75492a';
        g.beginPath(); g.arc(left + 9, top + h / 2, h * 0.22, 0, Math.PI * 2); g.fill();
        g.beginPath(); g.arc(left + w - 9, top + h / 2, h * 0.22, 0, Math.PI * 2); g.fill();
        g.fillStyle = 'rgba(57,255,20,.22)'; g.fillRect(left, top, w, 2);
        g.restore();
      }

      function drawPlayer(g) {
        var shake = (nowFn() - bumpAt) < 160;
        var jitter = shake ? (Math.random() * 2 - 1) * 3 : 0;
        drawEntity(g, player, true, jitter);
      }

      function drawEntity(g, ent, isPlayer, jitter) {
        if (ent.visRow == null) return;
        var yc = yTop(ent.visRow);
        if (yc < -CELL || yc > H + CELL) return;
        var px = ent.visX * CELL + (jitter || 0);
        var lift = ent.hopLift || 0;
        var py = yc + CELL / 2 - lift * CELL * 0.28;
        /* Schatten am Boden */
        g.save(); g.globalAlpha = isPlayer ? 0.4 : 0.28; g.fillStyle = '#000';
        g.beginPath(); g.ellipse(ent.visX * CELL, yc + CELL * 0.74, CELL * 0.26, CELL * 0.11, 0, 0, Math.PI * 2); g.fill(); g.restore();
        /* Figur mit Squash/Stretch */
        var sx = 1 - 0.12 * lift, sy = 1 + 0.16 * lift;
        g.save();
        g.translate(px, py); g.scale(sx, sy);
        g.globalAlpha = isPlayer ? 1 : 0.92;
        g.shadowColor = isPlayer ? 'rgba(57,255,20,.85)' : ent.tint || 'rgba(255,255,255,.5)';
        g.shadowBlur = isPlayer ? 15 : 9;
        g.textAlign = 'center'; g.textBaseline = 'middle';
        g.font = (CELL * (isPlayer ? 0.72 : 0.6)) + 'px "Segoe UI Emoji","Noto Color Emoji",system-ui,sans-serif';
        g.fillText(isPlayer ? '🐸' : ent.emoji, 0, 0);
        g.restore();
      }

      function drawEdge(g, now) {
        var crestRow = (camTopRow - VIS_ROWS) + EAT_MARGIN;
        var crestY = yTop(crestRow);
        var y0 = crestY - CELL * 0.55;
        if (y0 < H) {
          var grd = g.createLinearGradient(0, y0, 0, H);
          grd.addColorStop(0, 'rgba(20,0,6,0)');
          grd.addColorStop(0.4, 'rgba(70,4,18,.55)');
          grd.addColorStop(1, 'rgba(130,6,28,.94)');
          g.fillStyle = grd; g.fillRect(0, y0, W, H - y0);
        }
        /* pulsierende Gefahren-Wellenkante */
        var pulse = 0.5 + 0.5 * Math.sin(now / 150);
        g.save();
        g.strokeStyle = 'rgba(255,77,109,' + (0.45 + 0.45 * pulse).toFixed(3) + ')';
        g.lineWidth = 3; g.shadowColor = '#ff4d6d'; g.shadowBlur = 16;
        g.beginPath();
        for (var x = 0; x <= W; x += 12) {
          var yy = crestY + Math.sin((x / 40) + now / 200) * 5;
          if (x === 0) g.moveTo(x, yy); else g.lineTo(x, yy);
        }
        g.stroke(); g.restore();
        /* Warnhinweis, wenn der Frosch dem Rand nahe ist */
        if (player && player.alive) {
          var distRows = player.row - crestRow;
          if (distRows < 1.8) {
            g.save();
            g.globalAlpha = 0.55 + 0.45 * pulse;
            g.fillStyle = '#ff8098'; g.textAlign = 'center'; g.textBaseline = 'bottom';
            g.font = '900 ' + Math.round(CELL * 0.34) + 'px system-ui,sans-serif';
            g.fillText('NICHT STEHEN BLEIBEN!', W / 2, crestY - 6);
            g.restore();
          }
        }
      }

      function drawSplat(g) {
        var glyph = ({ car: '💥', water: '💦', swept: '🌊', edge: '🌑' })[deadInfo.cause] || '💥';
        var x = deadInfo.x * CELL, y = yTop(deadInfo.row) + CELL / 2;
        var t = Math.min(1, (nowFn() - deadInfo.at) / 260);
        g.save();
        g.translate(x, y); g.scale(1 + t * 0.45, 1 + t * 0.45);
        g.globalAlpha = 1;
        g.shadowColor = 'rgba(255,120,150,.8)'; g.shadowBlur = 18;
        g.textAlign = 'center'; g.textBaseline = 'middle';
        g.font = (CELL * 0.8) + 'px "Segoe UI Emoji","Noto Color Emoji",system-ui,sans-serif';
        g.fillText(glyph, 0, 0);
        g.restore();
      }

      function drawTopFade(g) {
        var grd = g.createLinearGradient(0, 0, 0, CELL * 1.1);
        grd.addColorStop(0, 'rgba(3,10,7,.85)'); grd.addColorStop(1, 'rgba(3,10,7,0)');
        g.fillStyle = grd; g.fillRect(0, 0, W, CELL * 1.1);
      }
    }
  };

  /* ================= STYLES ================= */
  function injectStyle() {
    UI.injectStyle('mg-crossyroad-css', [
      '.cro-wrap{display:flex;flex-direction:column;gap:12px;align-items:stretch;max-width:470px;margin:0 auto;}',
      '.cro-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 18px;}',
      '.cro-head-cell{display:flex;flex-direction:column;gap:2px;min-width:0;}',
      '.cro-head-r{text-align:right;align-items:flex-end;}',
      '.cro-head-l{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:1px;font-weight:800;}',
      '.cro-big{font-size:clamp(24px,6.5vw,38px);font-weight:900;color:var(--neon);text-shadow:0 0 14px rgba(57,255,20,.5);line-height:1;font-variant-numeric:tabular-nums;}',
      '.cro-best{color:var(--gold);text-shadow:0 0 12px rgba(255,210,63,.45);}',
      '.cro-timerval{font-size:clamp(20px,5.5vw,30px);}',
      '.mg-timer.cro-urgent{color:var(--danger);animation:cro-pulse .7s infinite;}',
      '.cro-pop{animation:cro-pop .3s ease;}',
      '@keyframes cro-pop{0%{transform:scale(1)}40%{transform:scale(1.22)}100%{transform:scale(1)}}',
      '@keyframes cro-pulse{0%,100%{opacity:1}50%{opacity:.4}}',
      /* Spielfeld */
      '.cro-stage{width:100%;max-width:420px;margin:0 auto;aspect-ratio:1/1;position:relative;}',
      '.cro-canvas{display:block;width:100%;height:100%;border-radius:16px;',
      'border:2px solid rgba(57,255,20,.35);background:#04140c;',
      'box-shadow:0 0 42px rgba(57,255,20,.2),inset 0 0 60px rgba(57,255,20,.05);',
      'touch-action:none;user-select:none;-webkit-user-select:none;-webkit-tap-highlight-color:transparent;cursor:pointer;}',
      /* Steuerkreuz */
      '.cro-dpad{display:grid;grid-template-columns:repeat(3,58px);grid-template-rows:repeat(2,52px);gap:8px;justify-content:center;align-content:center;margin:2px auto 0;}',
      '.cro-btn{display:flex;align-items:center;justify-content:center;font-size:24px;border-radius:14px;',
      'background:rgba(9,32,21,.75);border:1px solid var(--stroke-2);color:var(--leaf);cursor:pointer;',
      'font-family:inherit;user-select:none;-webkit-user-select:none;-webkit-tap-highlight-color:transparent;touch-action:none;',
      'transition:transform .08s,box-shadow .15s,border-color .15s,background .15s;}',
      '.cro-btn:hover{border-color:var(--neon);box-shadow:0 0 14px rgba(57,255,20,.3);}',
      '.cro-btn:active{transform:scale(.9);background:rgba(57,255,20,.18);box-shadow:0 0 20px rgba(57,255,20,.45);}',
      '.cro-up{grid-column:2;grid-row:1;color:var(--neon);}',
      '.cro-left{grid-column:1;grid-row:2;}',
      '.cro-down{grid-column:2;grid-row:2;}',
      '.cro-right{grid-column:3;grid-row:2;}',
      '.cro-hint{text-align:center;}',
      '.cro-board-wrap{padding:12px 14px;display:flex;flex-direction:column;gap:8px;}',
      '.cro-board-wrap .mg-scoreboard{max-height:260px;overflow-y:auto;}'
    ].join(''));
  }
})();
