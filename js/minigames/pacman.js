/* pacman.js — "Labyrinth-Fresser": Pac-Man-artiges Neon-Dschungel-Minispiel.
 *
 * IDEE:  Ein festes Canvas-Labyrinth voller Punkte (+4 Kraftpillen in den Ecken).
 *        Friss alle Punkte, weiche 3 Geistern aus. Nach einer Kraftpille flüchten
 *        die Geister und sind kurz fressbar (Bonus-Kette 200/400/800/1600).
 *        Alle Punkte weg -> nächstes Level (schneller, kürzere Angst-Zeit). 3 Leben.
 *
 * STEUERUNG: Wischen über das Feld, Pfeiltasten oder WASD, oder das Neon-Steuerkreuz
 *        unter dem Feld. Am Handy immer per Touch bedienbar.
 *
 * PUNKTE: Punkt 10 · Kraftpille 50 · Geist fressen 200/400/800/1600 · Level-Bonus.
 *
 * KI:    3 Geister mit Persönlichkeit. Wechsel aus "Jagen" (Ziel = Pac / 4 Felder
 *        vor Pac / Clyde-artig aus der Nähe fliehen) und "Streuen" (eigene Ecke),
 *        an jeder Kreuzung Richtung mit kleinstem Abstand zum Ziel, kein Umdrehen.
 *        Kraftpille -> zufälliges Flüchten. Gefressen -> Augen kehren ins Haus.
 *
 * SOLO:  3 Leben, Bestwert in best_pacman. Bei 0 Leben -> Endscreen.
 * MULTI: Gleiches Labyrinth, jeder spielt SEIN Feld gleichzeitig, 2 Minuten.
 *        Punkte laufen weiter (bei 0 Leben startet die Jagd neu, Punkte bleiben),
 *        meiste Punkte per reportScore, Live-Rangliste. Start & Timer über
 *        room.now (Server-Zeit), Zufall aus round.startAt geseedet -> fair.
 *
 * cleanup() stoppt rAF, alle Timer, Listener und meldet room.off für jedes room.on. */
(function () {
  'use strict';
  window.App = window.App || {}; App.Minigames = App.Minigames || {};
  var UI = App.UI, el = UI.el;

  injectStyle();

  /* ===================== Labyrinth (fest, geprüft zusammenhängend) ===================== */
  var MAZE = [
    "####################",
    "#o.......##.......o#",
    "#.###.##.##.##.###.#",
    "#........  ........#",
    "#.#.###.#  #.###.#.#",
    "#.#.....#  #.....#.#",
    "#.#.##.##--##.##.#.#",
    ".....#.#    #.#.....",
    "#.#.##.######.##.#.#",
    "#.#..............#.#",
    "#.#.###.#..#.###.#.#",
    "#..................#",
    "#.###.##.##.##.###.#",
    "#o.......##.......o#",
    "####################"
  ];
  var ROWS = MAZE.length, COLS = MAZE[0].length;   // 15 x 20
  var CELL = 24;
  var VW = COLS * CELL, VH = ROWS * CELL;           // 480 x 360

  var LEFT = { dx: -1, dy: 0 }, RIGHT = { dx: 1, dy: 0 }, UP = { dx: 0, dy: -1 }, DOWN = { dx: 0, dy: 1 };
  var ORDER = [UP, LEFT, DOWN, RIGHT];              // klassische Vorrangfolge bei Gleichstand

  /* Haus-Zone: Tür + Ausgangs-Schacht + Innenraum. Pac darf nie hinein;
     Geister nur als Augen / beim Verlassen / im Haus. */
  var HZ = {};
  [[3, 9], [3, 10], [4, 9], [4, 10], [5, 9], [5, 10], [6, 9], [6, 10], [7, 8], [7, 9], [7, 10], [7, 11]]
    .forEach(function (t) { HZ[t[0] + '_' + t[1]] = 1; });

  var WALLS = [];
  (function () {
    for (var r = 0; r < ROWS; r++) for (var c = 0; c < COLS; c++) if (MAZE[r].charAt(c) === '#') WALLS.push([r, c]);
  })();

  function wrapC(c) { return ((c % COLS) + COLS) % COLS; }
  function charAt(r, c) { if (r < 0 || r >= ROWS) return '#'; return MAZE[r].charAt(wrapC(c)); }
  function isWall(r, c) { return charAt(r, c) === '#'; }
  function inHouse(r, c) { return !!HZ[r + '_' + wrapC(c)]; }
  function canPac(r, c) { if (r < 0 || r >= ROWS) return false; if (isWall(r, c)) return false; if (inHouse(r, c)) return false; return true; }
  function canGhost(state, r, c) {
    if (r < 0 || r >= ROWS) return false;
    if (isWall(r, c)) return false;
    if (inHouse(r, c)) return state === 'exit' || state === 'eyes' || state === 'home';
    return true;
  }

  /* ===================== gitter-genaue Bewegung (Wall-Clock-dt) ===================== */
  function stepEntity(e, dt, decide) {
    var dist = e.speed * dt, guard = 0;
    while (dist > 1e-9 && guard++ < 240) {
      var cx = Math.round(e.x), cy = Math.round(e.y);
      var atCenter = Math.abs(e.x - cx) < 1e-6 && Math.abs(e.y - cy) < 1e-6;
      if (atCenter) {
        e.x = cx; e.y = cy;
        decide(e, cx, cy);
        if (!e.dir) return;
      }
      if (e.dir.dx !== 0) {
        var nx = e.dir.dx > 0 ? Math.floor(e.x + 1e-9) + 1 : Math.ceil(e.x - 1e-9) - 1;
        var mv = Math.min(dist, Math.abs(nx - e.x));
        e.x += e.dir.dx * mv; dist -= mv;
        if (e.x < -0.0001) e.x += COLS; else if (e.x >= COLS - 0.0001) e.x -= COLS;
        if (Math.abs(e.x - Math.round(e.x)) < 1e-6) e.x = Math.round(e.x);
      } else {
        var ny = e.dir.dy > 0 ? Math.floor(e.y + 1e-9) + 1 : Math.ceil(e.y - 1e-9) - 1;
        var mv2 = Math.min(dist, Math.abs(ny - e.y));
        e.y += e.dir.dy * mv2; dist -= mv2;
        if (Math.abs(e.y - Math.round(e.y)) < 1e-6) e.y = Math.round(e.y);
      }
    }
  }

  function wrapDX(a, b) { var d = a - b; if (d > COLS / 2) d -= COLS; else if (d < -COLS / 2) d += COLS; return d; }
  function distTo(x, y, tx, ty) { var dx = wrapDX(x, tx), dy = y - ty; return dx * dx + dy * dy; }

  /* ===================== Spiel ===================== */
  App.Minigames.pacman = {
    id: 'pacman', title: 'Labyrinth-Fresser', icon: '🟡', order: 136,
    subtitle: 'Friss alles, flieh vor den Geistern!',
    single: true, multi: true, minPlayers: 2, maxPlayers: 8,

    render: function (root, ctx) {
      var isMulti = ctx.mode === 'multi';
      var nowFn = isMulti ? ctx.room.now : function () { return Date.now(); };

      var dead = false, raf = null, last = 0;
      var stops = [], timers = [], listeners = [];
      var rng = mulberry(isMulti ? (((ctx.room.snapshot() && ctx.room.snapshot().round && ctx.room.snapshot().round.startAt) || nowFn()) >>> 0) : (Date.now() >>> 0));
      var lastNet = 0;

      var g2d = null, refs = null;
      var game = null;

      function after(ms, fn) { var t = setTimeout(function () { if (!dead) fn(); }, ms); timers.push(t); return t; }
      function clearTimers() { timers.forEach(clearTimeout); timers = []; }
      function addL(t, ty, fn, o) { t.addEventListener(ty, fn, o); listeners.push({ t: t, ty: ty, fn: fn, o: o }); }
      function removeListeners() { listeners.forEach(function (l) { try { l.t.removeEventListener(l.ty, l.fn, l.o); } catch (e) {} }); listeners = []; }
      function stopLoop() { if (raf) { cancelAnimationFrame(raf); raf = null; } if (game) game.running = false; }
      function stopHelpers() { stops.forEach(function (f) { try { f(); } catch (e) {} }); stops = []; }
      function cleanup() { dead = true; stopLoop(); clearTimers(); stopHelpers(); removeListeners(); }

      /* ---- Start ---- */
      if (isMulti) {
        var snap = ctx.room.snapshot() || {};
        var startAt = (snap.round && snap.round.startAt) || (ctx.room.now() + 3000);
        stops.push(App.MG.countdown(root, startAt, function () { play(startAt); }, ctx.room.now));
      } else {
        play(nowFn());
      }
      return { cleanup: cleanup };

      /* ===================== Aufbau ===================== */
      function play(startAt) {
        clearTimers(); stopHelpers(); removeListeners(); stopLoop();

        game = {
          running: true, score: 0, level: 1, lives: 3,
          dots: null, pelletsLeft: 0,
          pac: null, ghosts: null,
          freezeUntil: 0, levelStartAt: 0, frightUntil: 0, frightDur: 0, ghostChain: 0,
          dying: false, over: false, popups: [], msg: '', msgUntil: 0,
          startAt: startAt, endAt: startAt + 120000
        };

        buildUI();
        refillDots();
        resetPositions(nowFn(), 1500);
        setMsg('BEREIT!', 1400);

        if (isMulti) {
          ctx.room.reportScore(0);
          var board = App.MG.liveBoard(ctx.room, ctx.me.id);
          stops.push(board.stop);
          refs.boardBody.innerHTML = ''; refs.boardBody.appendChild(board.root);
          stops.push(App.MG.roundTimer(game.endAt, function (leftSec) {
            refs.timer.textContent = App.MG.mmss(leftSec);
            if (leftSec <= 15) refs.timer.classList.add('pac-urgent');
          }, finishMulti, ctx.room.now));
        }

        last = nowFn();
        raf = requestAnimationFrame(frame);
      }

      function buildUI() {
        var score = el('div', { class: 'pac-stat-v pac-score' }, ['0']);
        var level = el('div', { class: 'pac-stat-v pac-level' }, ['1']);
        var lives = el('div', { class: 'pac-lives' }, []);
        var timer = el('div', { class: 'mg-timer pac-timer' }, [isMulti ? '2:00' : '']);

        var hudCells = [
          el('div', { class: 'pac-stat' }, [el('div', { class: 'pac-stat-l' }, ['Punkte']), score]),
          el('div', { class: 'pac-stat' }, [el('div', { class: 'pac-stat-l' }, ['Level']), level]),
          el('div', { class: 'pac-stat pac-stat-lives' }, [el('div', { class: 'pac-stat-l' }, ['Leben']), lives])
        ];
        if (isMulti) hudCells.push(el('div', { class: 'pac-stat pac-stat-timer' }, [el('div', { class: 'pac-stat-l' }, ['Zeit']), timer]));
        var hud = el('div', { class: 'pac-hud glass' }, hudCells);

        var canvas = el('canvas', { class: 'pac-canvas', width: VW, height: VH });
        var stage = el('div', { class: 'pac-stage' }, [canvas]);

        var hint = el('div', { class: 'pac-hint hint-text' },
          ['Wische · Pfeiltasten / WASD · Steuerkreuz — 🟡 friss alles, ⭐ Kraftpille macht Geister fressbar']);

        var dpad = buildDpad();

        var boardWrap = null, boardBody = null;
        if (isMulti) {
          boardBody = el('div', { class: 'pac-board-body' });
          boardWrap = el('div', { class: 'pac-board-wrap glass' }, [
            el('div', { class: 'mg-field-title' }, ['🏆 Rangliste']), boardBody
          ]);
        }

        var wrap = el('div', { class: 'pac-wrap' }, [hud, stage, hint, dpad, boardWrap]);
        root.innerHTML = ''; root.appendChild(wrap);

        g2d = canvas.getContext('2d');
        refs = { score: score, level: level, lives: lives, timer: timer, canvas: canvas, boardBody: boardBody };

        attachInput(canvas);
      }

      function buildDpad() {
        function b(dirVec, glyph, cls) {
          var btn = el('button', { class: 'pac-dbtn ' + cls, type: 'button', 'aria-label': 'Richtung' }, [glyph]);
          var press = function (e) { if (e && e.preventDefault) e.preventDefault(); setWant(dirVec); btn.classList.remove('pac-dbtn-hit'); void btn.offsetWidth; btn.classList.add('pac-dbtn-hit'); };
          addL(btn, 'pointerdown', press);
          return btn;
        }
        var spacer = function () { return el('div', { class: 'pac-dspace' }); };
        return el('div', { class: 'pac-dpad' }, [
          spacer(), b(UP, '▲', 'pac-up'), spacer(),
          b(LEFT, '◀', 'pac-left'), el('div', { class: 'pac-dcenter' }, ['🟡']), b(RIGHT, '▶', 'pac-right'),
          spacer(), b(DOWN, '▼', 'pac-down'), spacer()
        ]);
      }

      function setWant(v) { if (game && game.pac) game.pac.want = v; }

      function attachInput(canvas) {
        var keyMap = { ArrowUp: UP, ArrowDown: DOWN, ArrowLeft: LEFT, ArrowRight: RIGHT, w: UP, W: UP, s: DOWN, S: DOWN, a: LEFT, A: LEFT, d: RIGHT, D: RIGHT };
        var onKey = function (e) { var v = keyMap[e.key]; if (v) { e.preventDefault(); setWant(v); } };
        addL(document, 'keydown', onKey);

        var sx = 0, sy = 0, swiping = false, fired = false;
        var TH = 20;
        var down = function (e) { swiping = true; fired = false; sx = e.clientX; sy = e.clientY; };
        var move = function (e) {
          if (!swiping || fired) return;
          var dx = e.clientX - sx, dy = e.clientY - sy;
          if (Math.abs(dx) < TH && Math.abs(dy) < TH) return;
          if (Math.abs(dx) > Math.abs(dy)) setWant(dx > 0 ? RIGHT : LEFT); else setWant(dy > 0 ? DOWN : UP);
          fired = true;
        };
        var up = function () { swiping = false; };
        addL(canvas, 'pointerdown', down);
        addL(canvas, 'pointermove', move);
        addL(canvas, 'pointerup', up);
        addL(canvas, 'pointercancel', up);
      }

      /* ===================== Zustand setzen ===================== */
      function refillDots() {
        game.dots = []; game.pelletsLeft = 0;
        for (var r = 0; r < ROWS; r++) {
          var row = [];
          for (var c = 0; c < COLS; c++) {
            var ch = MAZE[r].charAt(c);
            var v = ch === 'o' ? 2 : ch === '.' ? 1 : 0;
            row.push(v); if (v) game.pelletsLeft++;
          }
          game.dots.push(row);
        }
      }

      function mkGhost(type, col, color, corner) {
        return {
          type: type, x: col, y: 7, homeX: col, homeY: 7, color: color, corner: corner,
          dir: UP, state: 'home', frightened: false, bobDir: type % 2 ? 1 : -1, eyePhase: 0, exitAt: 0, speed: 0
        };
      }

      function resetPositions(now, readyMs) {
        game.pac = { x: 9, y: 11, dir: null, want: null, face: LEFT, speed: 0 };
        game.ghosts = [
          mkGhost(0, 9, '#ff4d6d', { c: 18, r: 1 }),
          mkGhost(1, 10, '#ff8ec6', { c: 1, r: 1 }),
          mkGhost(2, 8, '#33e6d0', { c: 1, r: 13 })
        ];
        game.frightUntil = 0; game.ghostChain = 0; game.dying = false;
        var base = now + readyMs;
        game.freezeUntil = base;
        game.levelStartAt = base;
        for (var i = 0; i < game.ghosts.length; i++) game.ghosts[i].exitAt = base + i * 1500;
        game.frightDur = Math.max(2200, Math.round(6000 * Math.pow(0.82, game.level - 1)));
      }

      function setMsg(t, ms) { game.msg = t; game.msgUntil = nowFn() + ms; }

      /* ===================== Frame-Loop ===================== */
      function frame() {
        if (dead || !game || !game.running) { raf = null; return; }
        var now = nowFn();
        var dt = (now - last) / 1000; if (dt < 0) dt = 0; if (dt > 0.05) dt = 0.05; last = now;

        if (!game.over && now >= game.freezeUntil && !game.dying) {
          updatePac(dt, now);
          for (var i = 0; i < game.ghosts.length; i++) updateGhost(game.ghosts[i], dt, now);
          handleCollisions(now);
          if (game.pelletsLeft <= 0) levelUp(now);
        }
        if (isMulti) maybeReport(now);
        draw(now);
        raf = requestAnimationFrame(frame);
      }

      function maybeReport(now) {
        if (now - lastNet < 300) return;
        lastNet = now;
        try { ctx.room.reportScore(game.score); } catch (e) {}
      }

      /* ===================== Pac ===================== */
      function updatePac(dt, now) {
        var p = game.pac;
        p.speed = 6.3 * lf();
        if (p.want && p.dir && p.want.dx === -p.dir.dx && p.want.dy === -p.dir.dy) { p.dir = p.want; p.want = null; }
        stepEntity(p, dt, pacDecide);
        if (p.dir) p.face = p.dir;
        var tr = Math.round(p.y), tc = wrapC(Math.round(p.x));
        if (tr >= 0 && tr < ROWS) { var d = game.dots[tr][tc]; if (d) eatDot(tr, tc, d, now); }
      }
      function pacDecide(e, cx, cy) {
        if (e.want && canPac(cy + e.want.dy, cx + e.want.dx)) { e.dir = e.want; e.want = null; return; }
        if (e.dir && canPac(cy + e.dir.dy, cx + e.dir.dx)) return;
        e.dir = null;
      }
      function eatDot(tr, tc, d, now) {
        game.dots[tr][tc] = 0; game.pelletsLeft--;
        if (d === 2) { game.score += 50; triggerFright(now); if (App.Audio) App.Audio.sfx('powerup'); }
        else {
          game.score += 10;
          if (now - (game.lastWaka || 0) > 90) { game.lastWaka = now; if (App.Audio) App.Audio.blip(game.wakaHi ? 540 : 380, 0.05, { type: 'square', peak: 0.05 }); game.wakaHi = !game.wakaHi; }
        }
      }
      function triggerFright(now) {
        game.frightUntil = now + game.frightDur; game.ghostChain = 0;
        for (var i = 0; i < game.ghosts.length; i++) {
          var g = game.ghosts[i];
          if (g.state === 'active') { g.frightened = true; g.dir = { dx: -g.dir.dx, dy: -g.dir.dy }; }
        }
      }
      function frightActive(now) { return now < game.frightUntil; }

      /* ===================== Geister ===================== */
      function lf() { return Math.min(1 + (game.level - 1) * 0.05, 1.6); }

      function updateGhost(g, dt, now) {
        if (g.state === 'home') {
          g.speed = 0;
          g.y += g.bobDir * 2.2 * dt;
          if (g.y > g.homeY + 0.34) { g.y = g.homeY + 0.34; g.bobDir = -1; }
          if (g.y < g.homeY - 0.34) { g.y = g.homeY - 0.34; g.bobDir = 1; }
          if (now >= g.exitAt) { g.state = 'exit'; g.y = g.homeY; g.x = g.homeX; g.dir = UP; }
          return;
        }
        if (g.state === 'exit') {
          g.speed = 5.2;
          stepEntity(g, dt, function (e, cx, cy) { ghostNav(e, cx, cy, 'exit', { c: 9, r: 1 }, now); });
          if (Math.round(g.y) <= 3) { g.state = 'active'; g.frightened = frightActive(now); }
          return;
        }
        if (g.state === 'eyes') {
          g.speed = 12;
          var tgt = g.eyePhase === 0 ? { c: 9, r: 3 } : { c: 9, r: 7 };
          stepEntity(g, dt, function (e, cx, cy) { ghostNav(e, cx, cy, 'eyes', tgt, now); });
          var er = Math.round(g.y), ec = Math.round(g.x);
          if (g.eyePhase === 0 && er <= 3 && (ec === 9 || ec === 10)) g.eyePhase = 1;
          if (g.eyePhase === 1 && er >= 7) { g.state = 'home'; g.eyePhase = 0; g.frightened = false; g.exitAt = now + 700; g.bobDir = g.type % 2 ? 1 : -1; }
          return;
        }
        // active
        g.frightened = g.frightened && frightActive(now);
        g.speed = g.frightened ? 3.6 : Math.min(5.7 * lf(), 8.4);
        var mode = g.frightened ? 'fright' : 'active';
        stepEntity(g, dt, function (e, cx, cy) { ghostNav(e, cx, cy, mode, ghostTarget(e, now), now); });
      }

      function ghostTarget(g, now) {
        var p = game.pac, ptC = Math.round(p.x), ptR = Math.round(p.y);
        var sub = globalSub(now);
        if (sub === 'scatter') return { c: g.corner.c, r: g.corner.r };
        var face = p.face || LEFT;
        if (g.type === 0) return { c: ptC, r: ptR };
        if (g.type === 1) return { c: ptC + face.dx * 4, r: ptR + face.dy * 4 };
        // type 2: Clyde — nah dran? -> in die eigene Ecke fliehen
        var d = distTo(g.x, g.y, ptC, ptR);
        return d > 16 ? { c: ptC, r: ptR } : { c: g.corner.c, r: g.corner.r };
      }
      function globalSub(now) {
        var t = (now - game.levelStartAt) / 1000;
        if (t < 7) return 'scatter';
        if (t < 20) return 'chase';
        if (t < 27) return 'scatter';
        if (t < 40) return 'chase';
        if (t < 44) return 'scatter';
        return 'chase';
      }

      function ghostNav(e, cx, cy, mode, target, now) {
        var rev = e.dir ? { dx: -e.dir.dx, dy: -e.dir.dy } : null;
        var i, d, nr, nc;
        if (mode === 'fright') {
          var opts = [];
          for (i = 0; i < ORDER.length; i++) {
            d = ORDER[i];
            if (rev && d.dx === rev.dx && d.dy === rev.dy) continue;
            if (canGhost('fright', cy + d.dy, cx + d.dx)) opts.push(d);
          }
          if (!opts.length) for (i = 0; i < ORDER.length; i++) { d = ORDER[i]; if (canGhost('fright', cy + d.dy, cx + d.dx)) opts.push(d); }
          e.dir = opts.length ? opts[Math.floor(rng() * opts.length)] : e.dir;
          return;
        }
        var best = null, bestD = Infinity;
        for (i = 0; i < ORDER.length; i++) {
          d = ORDER[i];
          if (rev && d.dx === rev.dx && d.dy === rev.dy) continue;
          nr = cy + d.dy; nc = cx + d.dx;
          if (!canGhost(mode, nr, nc)) continue;
          var dd = distTo(wrapC(nc), nr, target.c, target.r);
          if (dd < bestD) { bestD = dd; best = d; }
        }
        if (!best) {
          for (i = 0; i < ORDER.length; i++) {
            d = ORDER[i]; nr = cy + d.dy; nc = cx + d.dx;
            if (!canGhost(mode, nr, nc)) continue;
            var dd2 = distTo(wrapC(nc), nr, target.c, target.r);
            if (dd2 < bestD) { bestD = dd2; best = d; }
          }
        }
        e.dir = best || e.dir;
      }

      /* ===================== Kollision / Leben ===================== */
      function handleCollisions(now) {
        var p = game.pac;
        for (var i = 0; i < game.ghosts.length; i++) {
          var g = game.ghosts[i];
          if (g.state !== 'active') continue;
          var dx = wrapDX(p.x, g.x), dy = p.y - g.y;
          if (dx * dx + dy * dy > 0.5 * 0.5) continue;
          if (g.frightened) {
            g.state = 'eyes'; g.frightened = false; g.eyePhase = 0;
            var pts = 200 * Math.pow(2, Math.min(game.ghostChain, 3));
            game.ghostChain++; game.score += pts;
            addPopup(g.x, g.y, '+' + pts);
            if (App.Audio) App.Audio.sfx('coin');
          } else {
            pacDie(now); return;
          }
        }
      }

      function pacDie(now) {
        if (game.dying) return;
        game.dying = true; game.lives--;
        game.freezeUntil = now + 1100;
        setMsg('ERWISCHT!', 1100);
        if (App.Audio) App.Audio.sfx('explosion');
        after(1200, function () {
          game.dying = false;
          if (game.lives <= 0) {
            if (isMulti) { resetPositions(nowFn(), 1300); setMsg('NEUE JAGD!', 1200); game.level = 1; game.lives = 3; refillDots(); }
            else { gameOver(); }
          } else {
            resetPositions(nowFn(), 1200); setMsg('BEREIT!', 1100);
          }
        });
      }

      function levelUp(now) {
        game.level++;
        game.score += 60;
        if (App.Audio) App.Audio.sfx('levelup');
        setMsg('LEVEL ' + game.level, 1500);
        refillDots();
        resetPositions(now, 1500);
      }

      function addPopup(x, y, text) { game.popups.push({ x: (x + 0.5) * CELL, y: (y + 0.5) * CELL, text: text, born: Date.now() }); }

      /* ===================== Ende ===================== */
      function gameOver() {
        game.over = true; stopLoop();
        var best = App.Storage.get('best_pacman', 0);
        var nb = game.score > best;
        if (nb) App.Storage.set('best_pacman', game.score);
        if (App.Audio) App.Audio.sfx(nb ? 'win' : 'lose');
        App.MG.endScreen(root, {
          score: game.score, best: best, newBest: nb,
          label: 'Level ' + game.level + (nb ? ' · neuer Rekord! 🎉' : ' · Bestwert: ' + App.MG.fmt(best)),
          onExit: ctx.onExit,
          onAgain: function () { play(nowFn()); }
        });
      }
      function finishMulti() {
        if (game.over) return;
        game.over = true; stopLoop();
        try { ctx.room.reportScore(game.score); } catch (e) {}
        after(300, function () {
          App.MG.endScreen(root, { players: ctx.room.players(), meId: ctx.me.id, onExit: ctx.onExit });
        });
      }

      /* ===================== Zeichnen ===================== */
      function draw(now) {
        var g = g2d; if (!g) return;
        var t = Date.now();
        g.clearRect(0, 0, VW, VH);
        var grd = g.createLinearGradient(0, 0, 0, VH);
        grd.addColorStop(0, '#06180e'); grd.addColorStop(1, '#020c07');
        g.fillStyle = grd; g.fillRect(0, 0, VW, VH);

        drawWalls(g);
        drawDots(g, t);
        drawGhosts(g, now, t);
        drawPac(g, t);
        drawPopups(g);
        drawMsg(g, now);
        updateHud(now);
      }

      function drawWalls(g) {
        g.save();
        for (var i = 0; i < WALLS.length; i++) {
          var r = WALLS[i][0], c = WALLS[i][1];
          var x = c * CELL + 2.5, y = r * CELL + 2.5, w = CELL - 5, h = CELL - 5;
          roundRect(g, x, y, w, h, 6);
          g.fillStyle = 'rgba(9,46,26,0.92)'; g.fill();
          g.lineWidth = 2; g.strokeStyle = 'rgba(57,255,20,0.55)';
          g.shadowColor = 'rgba(57,255,20,0.5)'; g.shadowBlur = 7; g.stroke();
        }
        g.restore();
        // Tür
        g.save();
        g.strokeStyle = 'rgba(255,142,198,0.85)'; g.lineWidth = 3; g.shadowColor = 'rgba(255,142,198,0.6)'; g.shadowBlur = 8;
        g.beginPath(); g.moveTo(9 * CELL + 3, 6 * CELL + CELL / 2); g.lineTo(11 * CELL - 3, 6 * CELL + CELL / 2); g.stroke();
        g.restore();
      }

      function drawDots(g, t) {
        for (var r = 0; r < ROWS; r++) for (var c = 0; c < COLS; c++) {
          var d = game.dots[r][c]; if (!d) continue;
          var x = (c + 0.5) * CELL, y = (r + 0.5) * CELL;
          if (d === 2) {
            var pulse = 0.6 + 0.4 * Math.sin(t * 0.006);
            g.save(); g.fillStyle = '#ffd23f'; g.shadowColor = 'rgba(255,210,63,0.9)'; g.shadowBlur = 12 * pulse;
            g.beginPath(); g.arc(x, y, 5 + pulse * 1.6, 0, Math.PI * 2); g.fill(); g.restore();
          } else {
            g.save(); g.fillStyle = '#bdf7a0'; g.shadowColor = 'rgba(157,255,122,0.5)'; g.shadowBlur = 4;
            g.beginPath(); g.arc(x, y, 2.4, 0, Math.PI * 2); g.fill(); g.restore();
          }
        }
      }

      function drawPac(g, t) {
        var p = game.pac, x = (p.x + 0.5) * CELL, y = (p.y + 0.5) * CELL, R = CELL * 0.46;
        var face = p.face || LEFT;
        var ang = Math.atan2(face.dy, face.dx);
        var moving = !!p.dir && game && nowFn() >= game.freezeUntil && !game.dying;
        var open;
        if (game.dying) {
          var k = Math.min(1, (nowFn() - (game.freezeUntil - 1100)) / 1000);
          open = 0.02 + k * 0.98;                 // Mund geht beim Sterben auf -> verschwindet
        } else {
          open = moving ? (0.06 + 0.28 * (0.5 + 0.5 * Math.sin(t * 0.02))) : 0.14;
        }
        g.save();
        g.translate(x, y); g.rotate(ang);
        g.fillStyle = '#ffd23f'; g.shadowColor = 'rgba(255,210,63,0.75)'; g.shadowBlur = 16;
        if (game.dying && open > 0.98) { g.restore(); return; }
        g.beginPath();
        g.moveTo(0, 0);
        g.arc(0, 0, R, open * Math.PI, (2 - open) * Math.PI);
        g.closePath(); g.fill();
        // Auge
        g.rotate(-ang);
        g.fillStyle = '#0a2410';
        g.beginPath(); g.arc(face.dx * 2 - face.dy * 0, -R * 0.42, R * 0.14, 0, Math.PI * 2); g.fill();
        g.restore();
      }

      function drawGhosts(g, now, t) {
        for (var i = 0; i < game.ghosts.length; i++) {
          var gh = game.ghosts[i];
          var x = (gh.x + 0.5) * CELL, y = (gh.y + 0.5) * CELL, R = CELL * 0.46;
          var eyesOnly = gh.state === 'eyes';
          var frightened = gh.state === 'active' && gh.frightened;
          if (!eyesOnly) {
            var body;
            if (frightened) {
              var rem = game.frightUntil - now;
              body = (rem < 2000 && Math.floor(t / 210) % 2) ? '#eef3ff' : '#2b57e6';
            } else body = gh.color;
            drawGhostBody(g, x, y, R, body, t + i * 120);
          }
          drawGhostEyes(g, x, y, R, gh.dir || LEFT, frightened, eyesOnly, t, gh, now);
        }
      }
      function drawGhostBody(g, x, y, R, color, t) {
        g.save();
        g.fillStyle = color; g.shadowColor = color; g.shadowBlur = 12;
        g.beginPath();
        g.arc(x, y - R * 0.08, R, Math.PI, 0);
        var baseY = y + R * 0.82, feet = 4, span = R * 2, step = span / feet;
        g.lineTo(x + R, baseY);
        var wob = Math.sin(t * 0.012) * 1.4;
        for (var k = 0; k < feet; k++) {
          var fx = x + R - step * k;
          var midY = baseY - (k % 2 === 0 ? 5 + wob : -wob);
          g.lineTo(fx - step / 2, midY);
          g.lineTo(fx - step, baseY);
        }
        g.closePath(); g.fill();
        g.restore();
      }
      function drawGhostEyes(g, x, y, R, dir, frightened, eyesOnly, t, gh, now) {
        if (frightened && !eyesOnly) {
          var rem = game.frightUntil - now, flash = rem < 2000 && Math.floor(t / 210) % 2;
          g.save(); g.fillStyle = flash ? '#ff4d6d' : '#eaffe0'; g.shadowBlur = 0;
          g.beginPath(); g.arc(x - R * 0.34, y - R * 0.1, R * 0.13, 0, Math.PI * 2); g.arc(x + R * 0.34, y - R * 0.1, R * 0.13, 0, Math.PI * 2); g.fill();
          g.strokeStyle = flash ? '#ff4d6d' : '#eaffe0'; g.lineWidth = 2;
          g.beginPath();
          var yy = y + R * 0.28;
          g.moveTo(x - R * 0.5, yy);
          for (var w = 0; w <= 6; w++) g.lineTo(x - R * 0.5 + w * (R / 6), yy + (w % 2 ? -3 : 3));
          g.stroke(); g.restore();
          return;
        }
        var ex = R * 0.34, ey = -R * 0.1, er = R * 0.24, pr = R * 0.12;
        g.save();
        g.fillStyle = '#f7fffb'; g.shadowBlur = 0;
        g.beginPath(); g.ellipse(x - ex, y + ey, er * 0.82, er, 0, 0, Math.PI * 2); g.ellipse(x + ex, y + ey, er * 0.82, er, 0, 0, Math.PI * 2); g.fill();
        g.fillStyle = eyesOnly ? '#2b57e6' : '#0a1a3a';
        var px = dir.dx * er * 0.4, py = dir.dy * er * 0.4;
        g.beginPath(); g.arc(x - ex + px, y + ey + py, pr, 0, Math.PI * 2); g.arc(x + ex + px, y + ey + py, pr, 0, Math.PI * 2); g.fill();
        g.restore();
      }

      function drawPopups(g) {
        var t = Date.now();
        for (var i = game.popups.length - 1; i >= 0; i--) {
          var p = game.popups[i], age = t - p.born;
          if (age > 850) { game.popups.splice(i, 1); continue; }
          var a = 1 - age / 850;
          g.save(); g.globalAlpha = a; g.fillStyle = '#33e6d0'; g.font = '900 15px ' + FONT; g.textAlign = 'center';
          g.shadowColor = 'rgba(51,230,208,0.8)'; g.shadowBlur = 8;
          g.fillText(p.text, p.x, p.y - 6 - age * 0.02); g.restore();
        }
      }

      function drawMsg(g, now) {
        if (now >= game.msgUntil || !game.msg) return;
        g.save();
        g.textAlign = 'center'; g.textBaseline = 'middle';
        g.font = '900 30px ' + FONT;
        g.fillStyle = 'rgba(4,12,8,0.55)'; g.fillRect(0, VH / 2 - 30, VW, 60);
        g.fillStyle = '#ffd23f'; g.shadowColor = 'rgba(255,210,63,0.7)'; g.shadowBlur = 16;
        g.fillText(game.msg, VW / 2, VH / 2);
        g.restore();
      }

      function updateHud(now) {
        refs.score.textContent = App.MG.fmt(game.score);
        refs.level.textContent = String(game.level);
        var want = Math.max(0, game.lives);
        if (refs.lives.childNodes.length !== want) {
          refs.lives.innerHTML = '';
          for (var i = 0; i < want; i++) refs.lives.appendChild(el('span', { class: 'pac-life' }, ['🟡']));
        }
      }
    }
  };

  var FONT = '"Segoe UI",system-ui,Roboto,Arial,sans-serif';
  function mulberry(seed) {
    var s = seed >>> 0;
    return function () {
      s = (s + 0x6D2B79F5) | 0;
      var t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
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

  /* ===================== STYLES ===================== */
  function injectStyle() {
    UI.injectStyle('mg-pacman-css', [
      '.pac-wrap{display:flex;flex-direction:column;gap:12px;align-items:stretch;max-width:520px;margin:0 auto;}',
      '.pac-hud{display:flex;align-items:center;justify-content:space-around;gap:10px;padding:10px 14px;flex-wrap:wrap;}',
      '.pac-stat{display:flex;flex-direction:column;align-items:center;gap:2px;min-width:0;}',
      '.pac-stat-l{font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;}',
      '.pac-stat-v{font-size:clamp(20px,5.4vw,26px);font-weight:900;line-height:1;font-variant-numeric:tabular-nums;}',
      '.pac-score{color:var(--gold);text-shadow:0 0 12px rgba(255,210,63,.45);}',
      '.pac-level{color:var(--aqua);text-shadow:0 0 10px rgba(51,230,208,.4);}',
      '.pac-lives{display:flex;gap:3px;min-height:22px;align-items:center;}',
      '.pac-life{font-size:17px;line-height:1;filter:drop-shadow(0 0 5px rgba(255,210,63,.6));}',
      '.pac-timer{font-size:clamp(18px,5vw,24px);}',
      '.mg-timer.pac-urgent{color:var(--danger-2);animation:pac-pulse .7s infinite;}',
      '.pac-stage{width:100%;max-width:440px;margin:0 auto;position:relative;}',
      '.pac-canvas{display:block;width:100%;height:auto;border-radius:16px;border:2px solid rgba(57,255,20,.32);',
      'background:#04140c;box-shadow:0 0 40px rgba(57,255,20,.2),inset 0 0 50px rgba(57,255,20,.05);',
      'touch-action:none;user-select:none;-webkit-user-select:none;-webkit-tap-highlight-color:transparent;}',
      '.pac-hint{text-align:center;font-size:12px;line-height:1.35;}',
      /* Steuerkreuz */
      '.pac-dpad{display:grid;grid-template-columns:repeat(3,58px);grid-template-rows:repeat(3,52px);gap:8px;justify-content:center;margin:2px auto 0;touch-action:none;}',
      '.pac-dspace{}',
      '.pac-dbtn{display:flex;align-items:center;justify-content:center;font-size:22px;font-weight:900;color:#04160c;',
      'border-radius:14px;border:1px solid var(--stroke-2);cursor:pointer;font-family:inherit;',
      'background:linear-gradient(180deg,var(--neon-soft),var(--neon));box-shadow:0 4px 14px rgba(57,255,20,.28),inset 0 0 10px rgba(255,255,255,.2);',
      'user-select:none;-webkit-user-select:none;-webkit-tap-highlight-color:transparent;touch-action:none;transition:transform .08s;}',
      '.pac-dbtn:active{transform:scale(.9);}',
      '.pac-dbtn-hit{animation:pac-hit .18s ease;}',
      '.pac-dcenter{display:flex;align-items:center;justify-content:center;font-size:20px;opacity:.85;filter:drop-shadow(0 0 6px rgba(255,210,63,.6));}',
      '.pac-board-wrap{padding:12px 14px;display:flex;flex-direction:column;gap:8px;}',
      '.pac-board-body .mg-scoreboard{max-height:240px;overflow-y:auto;}',
      '@keyframes pac-pulse{0%,100%{opacity:1}50%{opacity:.4}}',
      '@keyframes pac-hit{0%{filter:brightness(1.8)}100%{filter:brightness(1)}}',
      '@media(max-width:430px){.pac-dpad{grid-template-columns:repeat(3,52px);grid-template-rows:repeat(3,46px);}.pac-dbtn{font-size:19px;}}'
    ].join(''));
  }
})();
