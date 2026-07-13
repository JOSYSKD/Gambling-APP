/* snake.js — "Dschungel-Schlange": klassisches Snake als Zeit-Wettrennen.
 * Steuere deine leuchtende Neon-Schlange über ein 20x20-Feld, friss glühende
 * Früchte (+10 & wachsen) und weiche dir selbst aus. Wände sind Durchgänge
 * (Wrap-around). Beißt du dich, gibt es nur eine kurze Pause + Reset der Länge
 * — die Punkte bleiben und die Runde läuft weiter bis die Zeit (90 s) um ist.
 * Wer am Ende die meisten Punkte hat, gewinnt.
 * Steuerung: Pfeiltasten/WASD, 4 Touch-Buttons und Wischen auf dem Feld.
 * Singleplayer (mit Bestwert) + Multiplayer (synchroner Start via room.now,
 * Live-Rangliste, Podest). Die Bewegung läuft über einen Wall-Clock-Tick
 * (rAF + Zeitprüfung), der Rundentimer über App.MG.roundTimer -> Tab-sicher. */
(function () {
  'use strict';
  window.App = window.App || {}; App.Minigames = App.Minigames || {};
  var UI = App.UI, el = UI.el, MG = App.MG;

  var GRID = 20;            // Felder pro Seite
  var START_LEN = 3;        // Start-/Reset-Länge
  var POINTS = 10;          // Punkte pro Frucht
  var DURATION = 90;        // Sekunden Rundenzeit
  var BASE_STEP = 178;      // ms pro Schritt (Startgeschwindigkeit)
  var MIN_STEP = 82;        // ms pro Schritt (Maximalgeschwindigkeit)
  var STEP_DECR = 4.2;      // ms schneller pro gewachsenem Segment
  var CRASH_PAUSE = 780;    // ms Pause nach Selbstbiss

  var FRUITS = [
    { e: '🍎', c: '#ff4d6d' }, { e: '🍊', c: '#ff9f1c' }, { e: '🍋', c: '#ffd23f' },
    { e: '🍓', c: '#ff4d6d' }, { e: '🍇', c: '#b06bff' }, { e: '🫐', c: '#4d9dff' },
    { e: '🥝', c: '#9dff7a' }, { e: '🍒', c: '#ff4d6d' }, { e: '🍑', c: '#ff9f6b' }
  ];

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  App.Minigames.snake = {
    id: 'snake', title: 'Dschungel-Schlange', icon: '🐍', order: 9,
    subtitle: 'Friss und wachse, weiche dir nicht selbst aus',
    single: true, multi: true, minPlayers: 2, maxPlayers: 8,

    render: function (root, ctx) {
      injectStyle();
      var isMulti = ctx.mode === 'multi';

      /* ---- Aufräum-Register (ALLES muss in cleanup weg) ---- */
      var raf = 0, tos = [], stops = [], winHandlers = [], dead = false;
      function after(ms, fn) { var t = setTimeout(fn, ms); tos.push(t); return t; }
      function addWin(type, fn) { window.addEventListener(type, fn); winHandlers.push({ t: type, f: fn }); }
      function clearRound() {
        if (raf) cancelAnimationFrame(raf); raf = 0;
        tos.forEach(clearTimeout); tos = [];
        stops.forEach(function (f) { try { f(); } catch (e) {} }); stops = [];
        winHandlers.forEach(function (h) { window.removeEventListener(h.t, h.f); }); winHandlers = [];
      }
      function cleanup() { dead = true; clearRound(); }

      /* ---- Runden-Zustand ---- */
      var snake, prevSnake, dir, nextDir, fruit, fruitIx, score, stepInterval;
      var lastStep = 0, paused = false, finished = false, crashes = 0;
      var ripples = [];
      var g = null, cvs = null, cell = 0;
      var hudScore = null, hudTimer = null, hudLen = null, stageEl = null;

      /* ---- Start ---- */
      if (isMulti) {
        var snap = ctx.room.snapshot() || {};
        var startAt = (snap.round && snap.round.startAt) || (ctx.room.now() + 3000);
        stops.push(MG.countdown(root, startAt, function () { play(startAt); }, ctx.room.now));
      } else {
        startSingle();
      }
      return { cleanup: cleanup };

      /* Singleplayer startet sofort — nur ein kurzer 3-2-1-Vorlauf zur Orientierung. */
      function startSingle() {
        clearRound(); finished = false;
        var s = Date.now() + 3000;
        stops.push(MG.countdown(root, s, function () { play(s); }));
      }

      /* ===================== SPIEL AUFBAUEN ===================== */
      function play(startAt) {
        clearRound();
        finished = false; paused = false; crashes = 0; ripples = [];
        score = 0;
        resetSnake();
        placeFruit();
        var endAt = startAt + DURATION * 1000;

        /* --- HUD --- */
        hudScore = el('div', { class: 'snk-score big-readout' }, ['0']);
        hudLen = el('div', { class: 'snk-len' }, ['🐍 ' + snake.length]);
        hudTimer = el('div', { class: 'mg-timer snk-timer' }, [MG.mmss(DURATION)]);
        var hud = el('div', { class: 'snk-hud glass' }, [
          el('div', { class: 'snk-hud-cell' }, [el('span', { class: 'snk-hud-l' }, ['Punkte']), hudScore]),
          el('div', { class: 'snk-hud-cell snk-hud-mid' }, [el('span', { class: 'snk-hud-l' }, ['Länge']), hudLen]),
          el('div', { class: 'snk-hud-cell snk-hud-right' }, [el('span', { class: 'snk-hud-l' }, ['Zeit']), hudTimer])
        ]);

        /* --- Spielfeld (Canvas) --- */
        cvs = el('canvas', { class: 'snk-canvas' });
        stageEl = el('div', { class: 'snk-stage' }, [cvs]);
        g = cvs.getContext('2d');

        /* --- Touch-Steuerkreuz --- */
        function padBtn(cls, glyph, nx, ny) {
          var b = el('button', { class: 'snk-pad ' + cls, type: 'button' }, [glyph]);
          b.addEventListener('pointerdown', function (e) { if (e && e.preventDefault) e.preventDefault(); setDir(nx, ny); });
          return b;
        }
        var pad = el('div', { class: 'snk-dpad' }, [
          padBtn('snk-up', '▲', 0, -1),
          padBtn('snk-left', '◀', -1, 0),
          padBtn('snk-down', '▼', 0, 1),
          padBtn('snk-right', '▶', 1, 0)
        ]);

        var pieces = [hud, stageEl, pad,
          el('p', { class: 'hint-text snk-hint' }, ['Pfeiltasten / WASD · Wischen · Steuerkreuz — Wände sind Durchgänge'])
        ];

        /* --- Live-Rangliste (multi) --- */
        var board = null;
        if (isMulti) {
          board = MG.liveBoard(ctx.room, ctx.me.id);
          stops.push(board.stop);
          pieces.push(el('div', { class: 'glass snk-board-wrap' }, [
            el('div', { class: 'mg-field-title' }, ['🏆 Rangliste']),
            board.root
          ]));
          ctx.room.reportScore(0);
        }

        var layout = el('div', { class: 'snk-layout' }, pieces);
        root.innerHTML = ''; root.appendChild(layout);

        /* --- Eingaben --- */
        addWin('keydown', onKey);
        addWin('resize', resize);
        bindSwipe(cvs);
        resize();

        /* --- Rundentimer (Wall-Clock, Tab-sicher) --- */
        stops.push(MG.roundTimer(endAt, function (left) {
          hudTimer.textContent = MG.mmss(Math.ceil(left));
          hudTimer.classList.toggle('snk-urgent', left <= 10.5);
        }, finish, isMulti ? ctx.room.now : null));

        /* --- Bewegungs-Loop --- */
        lastStep = Date.now();
        loop();
      }

      /* ===================== BEWEGUNGS-LOOP ===================== */
      function loop() {
        if (dead || finished) return;
        raf = requestAnimationFrame(loop);
        var now = Date.now();

        if (!paused) {
          var elapsed = now - lastStep;
          // Nach Tab-Wechsel/Ruhe keinen riesigen Nachhol-Sprung machen.
          if (elapsed > stepInterval * 4) { lastStep = now - stepInterval; }
          var guard = 0;
          while (!paused && now - lastStep >= stepInterval && guard < 4) { step(); lastStep += stepInterval; guard++; }
        }
        var t = paused ? 1 : clamp((now - lastStep) / stepInterval, 0, 1);
        draw(t, now);
      }

      /* Ein logischer Schritt der Schlange. */
      function step() {
        // Richtung übernehmen (nie 180°-Wende).
        if (!(nextDir.x === -dir.x && nextDir.y === -dir.y)) dir = nextDir;

        var head = snake[0];
        var nx = (head.x + dir.x + GRID) % GRID;   // Wrap-around
        var ny = (head.y + dir.y + GRID) % GRID;

        // Selbstkollision? (der Schwanz weicht gleich, zählt also nicht)
        var hit = false;
        for (var i = 0; i < snake.length - 1; i++) {
          if (snake[i].x === nx && snake[i].y === ny) { hit = true; break; }
        }
        if (hit) { crash(); return; }

        prevSnake = snakeCopy();
        snake.unshift({ x: nx, y: ny });

        if (nx === fruit.x && ny === fruit.y) {
          score += POINTS;
          ripples.push({ x: fruit.x, y: fruit.y, t0: Date.now(), c: FRUITS[fruitIx].c });
          if (hudScore) hudScore.textContent = MG.fmt(score);
          if (hudLen) hudLen.textContent = '🐍 ' + snake.length;
          if (isMulti) ctx.room.reportScore(score);
          placeFruit();
        } else {
          snake.pop();
        }
        recalcSpeed();
      }

      function crash() {
        crashes++;
        paused = true;
        UI.toast('Autsch! Länge zurückgesetzt 🐍💥', 'lose');
        after(CRASH_PAUSE, function () {
          if (dead || finished) return;
          resetSnake();
          // Frucht nicht auf der Schlange lassen.
          if (onSnake(fruit.x, fruit.y)) placeFruit();
          paused = false;
          lastStep = Date.now();
        });
      }

      /* ===================== ZUSTANDS-HELFER ===================== */
      function resetSnake() {
        var cx = Math.floor(GRID / 2), cy = Math.floor(GRID / 2);
        snake = [];
        for (var i = 0; i < START_LEN; i++) snake.push({ x: cx - i, y: cy });
        prevSnake = snakeCopy();
        dir = { x: 1, y: 0 };
        nextDir = { x: 1, y: 0 };
        recalcSpeed();
        if (hudLen) hudLen.textContent = '🐍 ' + snake.length;
      }
      function snakeCopy() { return snake.map(function (s) { return { x: s.x, y: s.y }; }); }
      function recalcSpeed() { stepInterval = Math.max(MIN_STEP, BASE_STEP - (snake.length - START_LEN) * STEP_DECR); }
      function onSnake(x, y) {
        for (var i = 0; i < snake.length; i++) if (snake[i].x === x && snake[i].y === y) return true;
        return false;
      }
      function placeFruit() {
        var free = [];
        for (var x = 0; x < GRID; x++) for (var y = 0; y < GRID; y++) if (!onSnake(x, y)) free.push({ x: x, y: y });
        var p = free.length ? free[(Math.random() * free.length) | 0] : { x: 0, y: 0 };
        fruit = { x: p.x, y: p.y };
        fruitIx = (Math.random() * FRUITS.length) | 0;
      }

      /* ===================== EINGABE ===================== */
      function setDir(nx, ny) {
        if (paused || finished || dead) return;
        if (nx === -dir.x && ny === -dir.y) return;   // keine 180°-Wende
        nextDir = { x: nx, y: ny };
      }
      function onKey(e) {
        var k = e.key;
        var handled = true;
        if (k === 'ArrowUp' || k === 'w' || k === 'W') setDir(0, -1);
        else if (k === 'ArrowDown' || k === 's' || k === 'S') setDir(0, 1);
        else if (k === 'ArrowLeft' || k === 'a' || k === 'A') setDir(-1, 0);
        else if (k === 'ArrowRight' || k === 'd' || k === 'D') setDir(1, 0);
        else handled = false;
        if (handled && e.preventDefault) e.preventDefault();
      }
      function bindSwipe(target) {
        var sx = 0, sy = 0, active = false;
        target.addEventListener('pointerdown', function (e) {
          active = true; sx = e.clientX; sy = e.clientY;
          if (e.preventDefault) e.preventDefault();
        });
        target.addEventListener('pointerup', function (e) {
          if (!active) return; active = false;
          var dx = e.clientX - sx, dy = e.clientY - sy;
          if (Math.abs(dx) < 22 && Math.abs(dy) < 22) return;   // Tap, keine Wischgeste
          if (Math.abs(dx) > Math.abs(dy)) setDir(dx > 0 ? 1 : -1, 0);
          else setDir(0, dy > 0 ? 1 : -1);
        });
        target.addEventListener('pointercancel', function () { active = false; });
      }

      /* ===================== ZEICHNEN ===================== */
      function resize() {
        if (!cvs || !stageEl) return;
        var box = stageEl.clientWidth || 320;
        var size = clamp(Math.floor(box), 240, 480);
        var dpr = window.devicePixelRatio || 1;
        cvs.width = Math.round(size * dpr);
        cvs.height = Math.round(size * dpr);
        cvs.style.width = size + 'px';
        cvs.style.height = size + 'px';
        cell = cvs.width / GRID;
      }

      function draw(tt, now) {
        if (!g || !cvs) return;
        var W = cvs.width, H = cvs.height;

        // Hintergrund
        var bg = g.createRadialGradient(W / 2, H * 0.25, 10, W / 2, H / 2, W * 0.8);
        bg.addColorStop(0, '#0b2d1d'); bg.addColorStop(1, '#04140c');
        g.fillStyle = bg; g.fillRect(0, 0, W, H);

        // dezentes Gitter
        g.lineWidth = Math.max(1, cell * 0.02);
        g.strokeStyle = 'rgba(57,255,20,0.06)';
        g.beginPath();
        for (var i = 1; i < GRID; i++) {
          g.moveTo(i * cell, 0); g.lineTo(i * cell, H);
          g.moveTo(0, i * cell); g.lineTo(W, i * cell);
        }
        g.stroke();

        drawRipples(now);
        drawFruit(now);
        drawSnake(tt);
      }

      function drawRipples(now) {
        for (var i = ripples.length - 1; i >= 0; i--) {
          var r = ripples[i];
          var age = (now - r.t0) / 360;
          if (age >= 1) { ripples.splice(i, 1); continue; }
          var cx = (r.x + 0.5) * cell, cy = (r.y + 0.5) * cell;
          g.beginPath();
          g.arc(cx, cy, cell * (0.3 + age * 0.9), 0, Math.PI * 2);
          g.strokeStyle = 'rgba(157,255,122,' + (0.7 * (1 - age)) + ')';
          g.lineWidth = cell * 0.14 * (1 - age);
          g.stroke();
        }
      }

      function drawFruit(now) {
        var f = FRUITS[fruitIx];
        var pulse = 1 + 0.08 * Math.sin(now / 200);
        var cx = (fruit.x + 0.5) * cell, cy = (fruit.y + 0.5) * cell;
        var rad = cell * 0.44 * pulse;
        g.save();
        g.shadowColor = f.c; g.shadowBlur = cell * 0.9;
        var grad = g.createRadialGradient(cx - rad * 0.3, cy - rad * 0.3, rad * 0.1, cx, cy, rad);
        grad.addColorStop(0, '#ffffff'); grad.addColorStop(0.5, f.c); grad.addColorStop(1, f.c);
        g.fillStyle = grad;
        g.beginPath(); g.arc(cx, cy, rad, 0, Math.PI * 2); g.fill();
        g.restore();
        // Emoji obendrauf
        g.font = Math.round(cell * 0.72) + 'px serif';
        g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillText(f.e, cx, cy + cell * 0.04);
      }

      function drawSnake(tt) {
        // Interpolierte Pixel-Mittelpunkte aller Segmente.
        var pts = [];
        for (var j = 0; j < snake.length; j++) {
          var to = snake[j];
          var from = prevSnake[Math.min(j, prevSnake.length - 1)];
          var dx = to.x - from.x, dy = to.y - from.y, px, py;
          if (Math.abs(dx) > 1 || Math.abs(dy) > 1) { px = to.x; py = to.y; }   // Wrap: nicht quer ziehen
          else { px = from.x + dx * tt; py = from.y + dy * tt; }
          pts.push({ x: (px + 0.5) * cell, y: (py + 0.5) * cell });
        }
        if (!pts.length) return;

        var bodyCol = paused ? '#ff4d6d' : '#2fe814';
        var coreCol = paused ? '#ff9fb3' : '#c9ffb0';

        // Körper als glühende Linie (an Wrap-Kanten in Teilstücke zerlegen).
        g.lineJoin = 'round'; g.lineCap = 'round';
        g.save();
        g.shadowColor = paused ? '#ff4d6d' : '#39ff14';
        g.shadowBlur = cell * 0.7;
        strokePath(pts, cell * 0.74, bodyCol);
        g.restore();
        strokePath(pts, cell * 0.34, coreCol);

        // Kopf
        var head = pts[0];
        var hr = cell * 0.46;
        g.save();
        g.shadowColor = paused ? '#ff4d6d' : '#39ff14';
        g.shadowBlur = cell * 0.8;
        g.fillStyle = paused ? '#ff6b83' : '#7dff54';
        g.beginPath(); g.arc(head.x, head.y, hr, 0, Math.PI * 2); g.fill();
        g.restore();

        // Augen (nach Blickrichtung)
        var perpx = -dir.y, perpy = dir.x;
        var ax = dir.x * hr * 0.32, ay = dir.y * hr * 0.32;
        var er = hr * 0.26;
        [-1, 1].forEach(function (sgn) {
          var ex = head.x + ax + perpx * hr * 0.42 * sgn;
          var ey = head.y + ay + perpy * hr * 0.42 * sgn;
          g.fillStyle = '#04140c';
          g.beginPath(); g.arc(ex, ey, er, 0, Math.PI * 2); g.fill();
          g.fillStyle = '#e9fff0';
          g.beginPath(); g.arc(ex - er * 0.2, ey - er * 0.2, er * 0.42, 0, Math.PI * 2); g.fill();
        });
      }

      function strokePath(pts, width, color) {
        g.strokeStyle = color; g.lineWidth = width;
        g.beginPath(); g.moveTo(pts[0].x, pts[0].y);
        for (var i = 1; i < pts.length; i++) {
          var a = pts[i - 1], b = pts[i];
          var d = Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
          if (d > cell * 1.6) g.moveTo(b.x, b.y);   // Wrap-Sprung: nicht verbinden
          else g.lineTo(b.x, b.y);
        }
        g.stroke();
        // Einzel-Segment sichtbar machen (z. B. direkt nach Reset ohne Bewegung).
        if (pts.length === 1) { g.beginPath(); g.arc(pts[0].x, pts[0].y, width / 2, 0, Math.PI * 2); g.fillStyle = color; g.fill(); }
      }

      /* ===================== ENDE ===================== */
      function finish() {
        if (finished || dead) return;
        finished = true;
        clearRound();
        if (isMulti) {
          ctx.room.reportScore(score);
          after(1200, function () {
            if (dead) return;
            MG.endScreen(root, { players: ctx.room.players(), meId: ctx.me.id, onExit: ctx.onExit });
          });
        } else {
          var best = App.Storage.get('best_snake', 0), nb = score > best;
          if (nb) App.Storage.set('best_snake', score);
          MG.endScreen(root, {
            title: 'Zeit um! 🐍', score: score, best: best, newBest: nb,
            label: nb ? 'Neuer Rekord! 🎉' : 'Punkte · Bestwert: ' + MG.fmt(best),
            onExit: ctx.onExit, onAgain: startSingle
          });
        }
      }
    }
  };

  /* ===================== STYLES ===================== */
  function injectStyle() {
    UI.injectStyle('mg-snake-css', [
      '.snk-layout{display:flex;flex-direction:column;gap:14px;align-items:stretch;}',
      /* HUD */
      '.snk-hud{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px 18px;}',
      '.snk-hud-cell{display:flex;flex-direction:column;gap:2px;min-width:60px;}',
      '.snk-hud-mid{align-items:center;}',
      '.snk-hud-right{align-items:flex-end;}',
      '.snk-hud-l{font-size:11px;text-transform:uppercase;letter-spacing:1px;color:var(--muted);}',
      '.snk-score{font-size:clamp(24px,6.5vw,40px);line-height:1;color:var(--neon);text-shadow:0 0 14px rgba(57,255,20,.5);font-variant-numeric:tabular-nums;}',
      '.snk-len{font-weight:900;font-size:clamp(16px,4.5vw,22px);color:var(--leaf);font-variant-numeric:tabular-nums;}',
      '.snk-timer{font-size:clamp(20px,5vw,28px);font-variant-numeric:tabular-nums;}',
      '.snk-timer.snk-urgent{color:var(--danger,#ff4d6d);animation:snk-pulse .6s ease-in-out infinite;}',
      '@keyframes snk-pulse{0%,100%{opacity:1}50%{opacity:.45}}',
      /* Spielfeld */
      '.snk-stage{display:flex;justify-content:center;align-items:center;width:100%;}',
      '.snk-canvas{display:block;border-radius:16px;border:1px solid var(--stroke,rgba(57,255,20,.25));',
      'box-shadow:0 0 22px rgba(57,255,20,.14),inset 0 0 40px rgba(0,0,0,.4);',
      'touch-action:none;user-select:none;-webkit-user-select:none;-webkit-touch-callout:none;cursor:pointer;max-width:100%;}',
      /* Steuerkreuz */
      '.snk-dpad{display:grid;grid-template-columns:repeat(3,64px);grid-template-rows:repeat(2,64px);',
      'gap:8px;justify-content:center;margin:2px auto 0;}',
      '.snk-pad{font-size:24px;font-weight:900;border-radius:14px;cursor:pointer;font-family:inherit;',
      'background:rgba(9,32,21,.85);border:1px solid var(--stroke,rgba(57,255,20,.3));color:var(--leaf);',
      'display:flex;align-items:center;justify-content:center;touch-action:none;user-select:none;',
      '-webkit-user-select:none;transition:transform .06s,box-shadow .12s;}',
      '.snk-pad:active{transform:scale(.9);box-shadow:0 0 16px rgba(57,255,20,.5);background:rgba(20,60,38,.95);}',
      '.snk-up{grid-column:2;grid-row:1;}',
      '.snk-left{grid-column:1;grid-row:2;}',
      '.snk-down{grid-column:2;grid-row:2;}',
      '.snk-right{grid-column:3;grid-row:2;}',
      '.snk-hint{text-align:center;margin:0;}',
      '.snk-board-wrap{padding:14px;display:flex;flex-direction:column;gap:8px;max-height:260px;overflow-y:auto;}',
      '@media(max-width:380px){.snk-dpad{grid-template-columns:repeat(3,56px);grid-template-rows:repeat(2,56px);}}'
    ].join(''));
  }
})();
