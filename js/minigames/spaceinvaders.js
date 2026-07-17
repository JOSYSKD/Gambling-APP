/* spaceinvaders.js — "Dschungel-Invasion": Space Invaders im Neon-Dschungel.
 *
 * IDEE:  Unten dein Neon-Schiff, oben ein Block anrückender Käfer (Insekten-
 *        Invasion). Die Formation pendelt seitlich, fällt bei jedem Wandkontakt
 *        tiefer und wirft Bomben. Ballere die Reihen ab (obere Reihen = mehr
 *        Punkte), nutze die zerstörbaren Deckungen und schnapp dir das goldene
 *        Bonus-Ufo (🪲). Welle leer -> nächste, schnellere Welle. 3 Leben, aus
 *        bei Leben 0 oder wenn die Käfer die Invasionslinie erreichen.
 *
 * STEUERUNG:  ◀ ▶ bewegen, 🔥 schießen (auch als Halte-Auto-Feuer).
 *             Tastatur: Pfeile / A D bewegen, Leertaste / ↑ schießen.
 *             Touch: Finger auf die Fläche legen -> Schiff folgt + feuert;
 *             oder die drei großen Buttons benutzen.
 *
 * PUNKTE:  Käfer je nach Reihe 10–50, Bonus-Ufo 100–300, Welle geschafft +100·Welle.
 *          SOLO: Bestwert unter App.Storage 'best_spaceinvaders'.
 *
 * SYNC-MODELL (Punkte-Rennen, wie reflex.js):  Alle spielen gleichzeitig 2 min
 *          dieselben Wellen. Der Wellen-/Bomben-/Ufo-Zufall wird aus
 *          snapshot().round.startAt geseedet (mulberry32) -> für alle fair und
 *          identisch. Jeder simuliert lokal und meldet nur seinen Punktestand
 *          via room.reportScore(); Live-Rangliste über App.MG.liveBoard.
 *          Zeit/Countdown laufen über room.now() (Wall-Clock, Tab-sicher).
 *          Stirbt man im Multi, geht's mit gleichem Punktestand von Welle 1
 *          weiter, bis die 2 Minuten um sind. cleanup() beendet wirklich alles. */
(function () {
  'use strict';
  window.App = window.App || {}; App.Minigames = App.Minigames || {};
  var UI = App.UI, el = UI.el;

  /* ---- Virtuelles Spielfeld (feste Koordinaten, Canvas skaliert per CSS) ---- */
  var W = 600, H = 640;
  var COLS = 8, ROWS = 5;
  var COLW = 58, ROWH = 46, AW = 38, AH = 30;     // Alien-Raster + Größe
  var SHIP_W = 46, SHIP_H = 20, SHIP_Y = H - 40;
  var SHIP_SPEED = 340;                            // px/s Schiff
  var BULLET_SPEED = 640;                          // px/s Schuss nach oben
  var BOMB_BASE_SPEED = 190;                       // px/s Alien-Bombe
  var FIRE_CD = 250;                               // ms Feuer-Pause
  var MAX_BULLETS = 3;                             // gleichzeitige Schüsse
  var INVASION_Y = H - 96;                         // erreichen Käfer diese Linie -> verloren
  var MATCH_TIME = 120;                            // s Rundenzeit (Multi)
  var REPORT_MS = 300;                             // ms Drossel für reportScore
  var ROW_POINTS = [50, 40, 30, 20, 10];           // Punkte pro Reihe (oben = mehr)
  var ROW_EMOJI = ['🦋', '🐝', '🦟', '🐛', '🐜'];
  var UFO_EMOJI = '🪲';
  var EMOJI_FONT = '26px "Segoe UI Emoji","Apple Color Emoji","Noto Color Emoji",system-ui,sans-serif';

  injectStyle();

  App.Minigames.spaceinvaders = {
    id: 'spaceinvaders', title: 'Dschungel-Invasion', icon: '👾', order: 133,
    subtitle: 'Ballere die Käfer-Invasion aus dem Dschungel',
    single: true, multi: true, minPlayers: 2, maxPlayers: 8,

    render: function (root, ctx) {
      var isMulti = ctx.mode === 'multi';
      var timeNow = isMulti ? function () { return ctx.room.now(); } : function () { return Date.now(); };

      /* ---- Laufzeit ---- */
      var dead = false, finished = false;
      var raf = null, last = 0;
      var stops = [];          // stop()-Funktionen (App.MG-Bausteine / room.off)
      var listeners = [];       // {t,ty,fn,opts}
      var pending = [];         // setTimeout-IDs
      var g = null, rng = null; // Spielzustand + geseedeter Zufall
      var ctx2d = null, canvas = null;
      var hudWave, hudScore, hudLives, hudTimer, boardHelper, invBtns;
      var held = { left: false, right: false, fire: false };
      var drag = { active: false, x: 0 };
      var endAt = 0, lastReportAt = 0, scoreDirty = false;

      /* ---- Aufräum-Helfer (wie reflex/pong) ---- */
      function after(ms, fn) { var t = setTimeout(function () { if (!dead) fn(); }, ms); pending.push(t); return t; }
      function clearPending() { pending.forEach(clearTimeout); pending = []; }
      function addL(t, ty, fn, opts) { t.addEventListener(ty, fn, opts); listeners.push({ t: t, ty: ty, fn: fn, opts: opts }); }
      function removeL() { listeners.forEach(function (l) { try { l.t.removeEventListener(l.ty, l.fn, l.opts); } catch (e) {} }); listeners = []; }
      function stopHelpers() { stops.forEach(function (f) { try { f(); } catch (e) {} }); stops = []; }
      function cleanup() {
        dead = true;
        if (raf) { cancelAnimationFrame(raf); raf = null; }
        clearPending(); stopHelpers(); removeL();
      }

      /* ---- Start (Punkte-Rennen: Seed + Zeit aus round.startAt) ---- */
      if (isMulti) {
        var snap = ctx.room.snapshot() || {};
        var startAt = (snap.round && snap.round.startAt) || (ctx.room.now() + 3000);
        stops.push(App.MG.countdown(root, startAt, function () { play(startAt); }, ctx.room.now));
      } else {
        play(Date.now());
      }
      return { cleanup: cleanup };

      /* ===================== Seeded RNG (mulberry32) ===================== */
      function makeRng(seed) {
        var s = (seed >>> 0) || 1;
        return function () {
          s = (s + 0x6D2B79F5) | 0;
          var t = Math.imul(s ^ (s >>> 15), 1 | s);
          t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
          return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
      }

      /* ===================== SPIEL-START ===================== */
      function play(startAtMs) {
        clearPending(); stopHelpers(); removeL();
        finished = false;
        rng = makeRng(Math.floor(startAtMs));
        endAt = startAtMs + MATCH_TIME * 1000;

        buildDOM();
        setupCanvas();
        g = newGame();
        for (var si = 0; si < 44; si++) {
          g.stars.push({ x: Math.random() * W, y: 14 + Math.random() * (INVASION_Y - 30), ph: Math.random() * 6.283, r: 0.6 + Math.random() * 1.3 });
        }
        attachInput();
        startWave(1, timeNow());

        if (isMulti) {
          try { ctx.room.reportScore(0); } catch (e) {}
          stops.push(App.MG.roundTimer(endAt, function (left) {
            if (!hudTimer) return;
            hudTimer.textContent = App.MG.mmss(left);
            if (left <= 10) hudTimer.classList.add('inv-urgent');
          }, finishMulti, ctx.room.now));
        }
        last = timeNow();
        raf = requestAnimationFrame(frame);
      }

      function newGame() {
        return {
          wave: 1, score: 0, lives: 3,
          shipX: W / 2,
          bullets: [], bombs: [], particles: [], stars: [],
          aliens: [], fx: 0, fy: 0, dir: 1, totalAliens: 0,
          ufo: null, nextUfoAt: 0, nextBombAt: 0,
          bunkers: [],
          phase: 'play', deadAt: 0, waveClearAt: 0,
          lastFireAt: 0, invUntil: 0, shake: 0
        };
      }

      function startWave(wave, now) {
        g.wave = wave;
        g.aliens = [];
        var gridW = (COLS - 1) * COLW + AW;
        g.fx = (W - gridW) / 2;
        g.fy = 64 + Math.min(wave - 1, 4) * 10;   // je Welle etwas tiefer
        g.dir = 1;
        for (var r = 0; r < ROWS; r++) {
          for (var c = 0; c < COLS; c++) {
            g.aliens.push({ c: c, r: r, alive: true, pts: ROW_POINTS[r], emoji: ROW_EMOJI[r] });
          }
        }
        g.totalAliens = ROWS * COLS;
        g.bullets = []; g.bombs = [];
        g.ufo = null;
        g.bunkers = buildBunkers();
        g.phase = 'play';
        g.invUntil = now + 800;                    // kurze Start-Schonzeit
        g.nextUfoAt = now + 9000 + rng() * 9000;
        g.nextBombAt = now + 700 + rng() * 800;
        if (hudWave) hudWave.textContent = String(wave);
        updateLives();
      }

      function buildBunkers() {
        var arr = [], count = 4, cols = 6, rows = 3, bw = 11;
        var bunkerW = cols * bw;
        var gap = (W - count * bunkerW) / (count + 1);
        var by = H - 150;
        for (var b = 0; b < count; b++) {
          var ox = gap + b * (bunkerW + gap);
          for (var r = 0; r < rows; r++) {
            for (var c = 0; c < cols; c++) {
              if (r === rows - 1 && (c === 2 || c === 3)) continue;   // kleine Tür unten
              arr.push({ x: ox + c * bw, y: by + r * bw, w: bw, h: bw, hp: 2 });
            }
          }
        }
        return arr;
      }

      /* ===================== FRAME-LOOP ===================== */
      function frame() {
        if (dead) { raf = null; return; }
        var now = timeNow();
        var dt = (now - last) / 1000; if (dt < 0) dt = 0; if (dt > 0.05) dt = 0.05; last = now;
        if (!finished && g) update(dt, now);
        if (g) draw(now);
        if (!finished && !dead) raf = requestAnimationFrame(frame); else raf = null;
      }

      /* ===================== UPDATE ===================== */
      function update(dt, now) {
        if (g.phase === 'dead') {
          updateParticles(dt);
          if (now - g.deadAt > 1300) {
            if (isMulti) { if (now < endAt) softReset(now); }
            else finishSolo();
          }
          if (g.shake > 0) { g.shake -= dt * 60; if (g.shake < 0) g.shake = 0; }
          return;
        }
        if (g.phase === 'waveclear') {
          updateParticles(dt);
          if (now - g.waveClearAt > 1400) startWave(g.wave + 1, now);
          return;
        }

        moveShip(dt);
        if (held.fire) tryFire(now);
        updateBullets(dt);
        updateFormation(dt, now);
        updateUfo(dt, now);
        updateBombs(dt);
        spawnBombs(now);
        collide(now);
        updateParticles(dt);
        if (g.shake > 0) { g.shake -= dt * 60; if (g.shake < 0) g.shake = 0; }

        if (g.phase === 'play' && aliveCount() === 0) {
          g.phase = 'waveclear'; g.waveClearAt = now;
          addScore(100 * g.wave);
          if (App.Audio) App.Audio.sfx('levelup');
          return;
        }
        if (isMulti && scoreDirty && now - lastReportAt >= REPORT_MS) {
          lastReportAt = now; scoreDirty = false;
          try { ctx.room.reportScore(g.score); } catch (e) {}
        }
      }

      /* Nach dem Tod im Multi: gleicher Punktestand, frische 3 Leben, Welle 1. */
      function softReset(now) {
        g.lives = 3; g.shipX = W / 2;
        g.bullets = []; g.bombs = []; g.ufo = null; g.particles = [];
        startWave(1, now);
        if (App.Audio) App.Audio.sfx('start');
      }

      function moveShip(dt) {
        var minX = 24 + SHIP_W / 2, maxX = W - 24 - SHIP_W / 2;
        if (drag.active) {
          var target = Math.max(minX, Math.min(maxX, drag.x));
          var d = target - g.shipX, step = SHIP_SPEED * 1.7 * dt;
          if (Math.abs(d) <= step) g.shipX = target; else g.shipX += (d > 0 ? 1 : -1) * step;
        } else {
          var dir = (held.right ? 1 : 0) - (held.left ? 1 : 0);
          g.shipX += dir * SHIP_SPEED * dt;
        }
        g.shipX = Math.max(minX, Math.min(maxX, g.shipX));
      }

      function tryFire(now) {
        if (g.phase !== 'play') return;
        if (now - g.lastFireAt < FIRE_CD) return;
        if (g.bullets.length >= MAX_BULLETS) return;
        g.lastFireAt = now;
        g.bullets.push({ x: g.shipX, y: SHIP_Y - SHIP_H });
        if (App.Audio) App.Audio.blip(720, 0.05, { type: 'square', peak: 0.05 });
      }

      function updateBullets(dt) {
        for (var i = g.bullets.length - 1; i >= 0; i--) {
          var b = g.bullets[i]; b.y -= BULLET_SPEED * dt;
          if (b.y < -14) g.bullets.splice(i, 1);
        }
      }

      function updateFormation(dt, now) {
        var alive = aliveList();
        if (!alive.length) return;
        var frac = 1 - alive.length / g.totalAliens;
        var speed = (24 + (g.wave - 1) * 7) * (1 + frac * 2.2);
        g.fx += g.dir * speed * dt;
        var minx = Infinity, maxx = -Infinity, i, ax;
        for (i = 0; i < alive.length; i++) { ax = alienX(alive[i]); if (ax < minx) minx = ax; if (ax + AW > maxx) maxx = ax + AW; }
        var pad = 16;
        if (maxx > W - pad) { g.fx -= (maxx - (W - pad)); g.dir = -1; dropDown(now); }
        else if (minx < pad) { g.fx += (pad - minx); g.dir = 1; dropDown(now); }
      }

      function dropDown(now) {
        g.fy += 20;
        if (App.Audio) App.Audio.blip(170, 0.04, { type: 'sine', peak: 0.03 });
        var alive = aliveList(), lowest = -Infinity, i, ay;
        for (i = 0; i < alive.length; i++) { ay = alienY(alive[i]) + AH; if (ay > lowest) lowest = ay; }
        if (lowest >= INVASION_Y) triggerDeath(now);
      }

      function updateUfo(dt, now) {
        if (g.ufo) {
          g.ufo.x += g.ufo.vx * dt;
          if (g.ufo.x < -40 || g.ufo.x > W + 40) g.ufo = null;
        } else if (now >= g.nextUfoAt) {
          var fromLeft = rng() < 0.5;
          g.ufo = { x: fromLeft ? -30 : W + 30, y: 38, vx: (fromLeft ? 1 : -1) * (110 + rng() * 45), pts: 100 + Math.floor(rng() * 5) * 50 };
          g.nextUfoAt = now + 12000 + rng() * 10000;
          if (App.Audio) App.Audio.blip(440, 0.28, { type: 'sawtooth', peak: 0.03 });
        }
      }

      function spawnBombs(now) {
        if (now < g.nextBombAt) return;
        var alive = aliveList();
        if (!alive.length) return;
        // pro Spalte den untersten Käfer sammeln, dann eine Spalte auswürfeln
        var low = {}, keys = [], i, a;
        for (i = 0; i < alive.length; i++) {
          a = alive[i];
          if (!low[a.c]) { low[a.c] = a; keys.push(a.c); }
          else if (a.r > low[a.c].r) low[a.c] = a;
        }
        var shooter = low[keys[Math.floor(rng() * keys.length)]];
        g.bombs.push({ x: alienX(shooter) + AW / 2, y: alienY(shooter) + AH, vy: BOMB_BASE_SPEED + g.wave * 10 + rng() * 40, wob: rng() * 6.28 });
        var interval = Math.max(340, 1150 - g.wave * 80) * (0.6 + rng() * 0.9);
        g.nextBombAt = now + interval;
        if (App.Audio) App.Audio.blip(300, 0.05, { type: 'triangle', peak: 0.03 });
      }

      function updateBombs(dt) {
        for (var i = g.bombs.length - 1; i >= 0; i--) {
          var b = g.bombs[i]; b.y += b.vy * dt; b.wob += dt * 10;
          if (b.y > H + 12) g.bombs.splice(i, 1);
        }
      }

      /* ===================== KOLLISIONEN ===================== */
      function collide(now) {
        var i, j;
        // Spieler-Schüsse: Ufo -> Käfer -> Deckung
        for (i = g.bullets.length - 1; i >= 0; i--) {
          var b = g.bullets[i], hit = false;
          if (g.ufo && b.x >= g.ufo.x - 18 && b.x <= g.ufo.x + 18 && b.y <= g.ufo.y + 16 && b.y >= g.ufo.y - 16) {
            addScore(g.ufo.pts); spawnBurst(g.ufo.x, g.ufo.y, '#ffd23f', 12);
            if (App.Audio) App.Audio.sfx('jackpot');
            g.ufo = null; hit = true;
          }
          if (!hit) {
            var alive = aliveList();
            for (j = 0; j < alive.length; j++) {
              var a = alive[j], ax = alienX(a), ay = alienY(a);
              if (b.x >= ax && b.x <= ax + AW && b.y <= ay + AH && b.y >= ay) {
                a.alive = false; addScore(a.pts); spawnBurst(ax + AW / 2, ay + AH / 2, '#7dff5e', 8);
                if (App.Audio) App.Audio.sfx('hit');
                hit = true; break;
              }
            }
          }
          if (!hit) hit = hitBunker(b.x, b.y);
          if (hit) g.bullets.splice(i, 1);
        }
        // Alien-Bomben: Deckung -> Schiff
        for (i = g.bombs.length - 1; i >= 0; i--) {
          var bo = g.bombs[i];
          if (hitBunker(bo.x, bo.y)) { g.bombs.splice(i, 1); continue; }
          if (now >= g.invUntil && bo.x >= g.shipX - SHIP_W / 2 && bo.x <= g.shipX + SHIP_W / 2 && bo.y >= SHIP_Y - SHIP_H && bo.y <= SHIP_Y + 6) {
            g.bombs.splice(i, 1); hitShip(now); continue;
          }
          if (bo.y > H + 12) g.bombs.splice(i, 1);
        }
      }

      function hitBunker(x, y) {
        for (var i = 0; i < g.bunkers.length; i++) {
          var bl = g.bunkers[i];
          if (x >= bl.x && x <= bl.x + bl.w && y >= bl.y && y <= bl.y + bl.h) {
            bl.hp--; spawnBurst(x, y, '#33e6d0', 3);
            if (bl.hp <= 0) g.bunkers.splice(i, 1);
            return true;
          }
        }
        return false;
      }

      function hitShip(now) {
        g.lives--; g.shake = 10; g.invUntil = now + 1500;
        spawnBurst(g.shipX, SHIP_Y, '#ff4d6d', 14);
        if (App.Audio) App.Audio.sfx('explosion');
        updateLives();
        if (g.lives <= 0) triggerDeath(now);
      }

      function triggerDeath(now) {
        if (g.phase !== 'play') return;
        g.phase = 'dead'; g.deadAt = now; g.shake = 16;
        spawnBurst(g.shipX, SHIP_Y, '#ff8098', 22);
        if (App.Audio) App.Audio.sfx(isMulti ? 'lose' : 'bust');
        if (isMulti) { try { ctx.room.reportScore(g.score); } catch (e) {} }
      }

      /* ===================== KLEINE HELFER ===================== */
      function alienX(a) { return g.fx + a.c * COLW; }
      function alienY(a) { return g.fy + a.r * ROWH; }
      function aliveList() { var r = [], i; for (i = 0; i < g.aliens.length; i++) if (g.aliens[i].alive) r.push(g.aliens[i]); return r; }
      function aliveCount() { var n = 0, i; for (i = 0; i < g.aliens.length; i++) if (g.aliens[i].alive) n++; return n; }
      function addScore(n) { g.score += n; scoreDirty = true; if (hudScore) hudScore.textContent = App.MG.fmt(g.score); }

      function spawnBurst(x, y, color, n) {
        for (var i = 0; i < n; i++) {
          var a = Math.random() * 6.283, sp = 40 + Math.random() * 150;
          g.particles.push({ x: x, y: y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 0.4 + Math.random() * 0.45, age: 0, color: color });
        }
        if (g.particles.length > 220) g.particles.splice(0, g.particles.length - 220);
      }
      function updateParticles(dt) {
        for (var i = g.particles.length - 1; i >= 0; i--) {
          var p = g.particles[i]; p.age += dt; p.x += p.vx * dt; p.y += p.vy * dt; p.vy += 200 * dt;
          if (p.age >= p.life) g.particles.splice(i, 1);
        }
      }

      /* ===================== RENDERING ===================== */
      function setupCanvas() { ctx2d = canvas.getContext('2d'); }
      function roundRect(gg, x, y, w, h, r) {
        r = Math.min(r, w / 2, h / 2);
        gg.beginPath();
        gg.moveTo(x + r, y);
        gg.arcTo(x + w, y, x + w, y + h, r);
        gg.arcTo(x + w, y + h, x, y + h, r);
        gg.arcTo(x, y + h, x, y, r);
        gg.arcTo(x, y, x + w, y, r);
        gg.closePath();
      }

      function draw(now) {
        var gx = ctx2d; if (!gx) return;
        var sx = 0, sy = 0;
        if (g.shake > 0) { sx = (Math.random() * 2 - 1) * g.shake * 0.5; sy = (Math.random() * 2 - 1) * g.shake * 0.5; }
        gx.setTransform(1, 0, 0, 1, 0, 0);
        gx.clearRect(0, 0, W, H);
        var grd = gx.createLinearGradient(0, 0, 0, H);
        grd.addColorStop(0, '#06180e'); grd.addColorStop(1, '#020c07');
        gx.fillStyle = grd; gx.fillRect(0, 0, W, H);

        gx.save();
        gx.translate(sx, sy);
        gx.strokeStyle = 'rgba(57,255,20,0.18)'; gx.lineWidth = 3; roundRect(gx, 5, 5, W - 10, H - 10, 16); gx.stroke();
        drawStars(now);
        // Invasionslinie
        gx.save(); gx.strokeStyle = 'rgba(255,77,109,0.28)'; gx.lineWidth = 2; gx.setLineDash([10, 12]);
        gx.beginPath(); gx.moveTo(14, INVASION_Y); gx.lineTo(W - 14, INVASION_Y); gx.stroke(); gx.restore();
        drawBunkers();
        drawUfo();
        drawAliens(now);
        drawBombs();
        drawBullets();
        drawShip(now);
        drawParticles();
        gx.restore();

        drawOverlay(now);
      }

      function drawStars(now) {
        var gx = ctx2d; gx.save();
        for (var i = 0; i < g.stars.length; i++) {
          var s = g.stars[i], a = 0.12 + 0.24 * (0.5 + 0.5 * Math.sin(now / 700 + s.ph));
          gx.fillStyle = 'rgba(157,255,122,' + a.toFixed(3) + ')';
          gx.beginPath(); gx.arc(s.x, s.y, s.r, 0, 6.283); gx.fill();
        }
        gx.restore();
      }

      function drawBunkers() {
        var gx = ctx2d;
        for (var i = 0; i < g.bunkers.length; i++) {
          var bl = g.bunkers[i];
          gx.fillStyle = bl.hp >= 2 ? 'rgba(57,255,20,0.82)' : 'rgba(224,138,60,0.9)';
          gx.fillRect(bl.x, bl.y, bl.w - 1, bl.h - 1);
        }
      }

      function drawUfo() {
        if (!g.ufo) return;
        var gx = ctx2d;
        gx.save(); gx.font = EMOJI_FONT; gx.textAlign = 'center'; gx.textBaseline = 'middle';
        gx.shadowColor = 'rgba(255,210,63,.85)'; gx.shadowBlur = 16;
        gx.fillText(UFO_EMOJI, g.ufo.x, g.ufo.y); gx.restore();
      }

      function drawAliens(now) {
        var gx = ctx2d; gx.save();
        gx.font = EMOJI_FONT; gx.textAlign = 'center'; gx.textBaseline = 'middle';
        gx.shadowColor = 'rgba(57,255,20,.45)'; gx.shadowBlur = 8;
        var bob = Math.sin(now / 220) * 3, alive = aliveList();
        for (var i = 0; i < alive.length; i++) {
          var a = alive[i], ax = alienX(a) + AW / 2, ay = alienY(a) + AH / 2 + (a.c % 2 ? bob : -bob);
          gx.fillText(a.emoji, ax, ay);
        }
        gx.restore();
      }

      function drawBombs() {
        var gx = ctx2d; gx.save(); gx.shadowColor = 'rgba(255,77,109,.9)'; gx.shadowBlur = 10; gx.fillStyle = '#ff6b83';
        for (var i = 0; i < g.bombs.length; i++) {
          var b = g.bombs[i], wob = Math.sin(b.wob) * 3;
          gx.beginPath();
          gx.moveTo(b.x + wob, b.y - 6); gx.lineTo(b.x + 4 + wob, b.y);
          gx.lineTo(b.x + wob, b.y + 6); gx.lineTo(b.x - 4 + wob, b.y);
          gx.closePath(); gx.fill();
        }
        gx.restore();
      }

      function drawBullets() {
        var gx = ctx2d; gx.save(); gx.shadowColor = 'rgba(57,255,20,.9)'; gx.shadowBlur = 12; gx.fillStyle = '#eaffe0';
        for (var i = 0; i < g.bullets.length; i++) { var b = g.bullets[i]; roundRect(gx, b.x - 2, b.y, 4, 15, 2); gx.fill(); }
        gx.restore();
      }

      function drawShip(now) {
        var gx = ctx2d, x = g.shipX, y = SHIP_Y;
        var blink = (now < g.invUntil) && (Math.floor(now / 120) % 2 === 0);
        gx.save();
        gx.globalAlpha = blink ? 0.35 : 1;
        gx.shadowColor = 'rgba(51,230,208,.9)'; gx.shadowBlur = 16; gx.fillStyle = '#7ff3e6';
        gx.beginPath();
        gx.moveTo(x, y - SHIP_H);
        gx.lineTo(x + SHIP_W / 2, y + 4);
        gx.lineTo(x + SHIP_W / 4, y + 4);
        gx.lineTo(x, y - 2);
        gx.lineTo(x - SHIP_W / 4, y + 4);
        gx.lineTo(x - SHIP_W / 2, y + 4);
        gx.closePath(); gx.fill();
        gx.fillStyle = '#eaffe0'; gx.fillRect(x - 2, y - SHIP_H - 6, 4, 9);
        gx.restore();
      }

      function drawParticles() {
        var gx = ctx2d; gx.save();
        for (var i = 0; i < g.particles.length; i++) {
          var p = g.particles[i], a = 1 - p.age / p.life; if (a < 0) a = 0;
          gx.globalAlpha = a; gx.fillStyle = p.color;
          gx.beginPath(); gx.arc(p.x, p.y, 2.3, 0, 6.283); gx.fill();
        }
        gx.restore();
      }

      function drawOverlay(now) {
        if (g.phase === 'waveclear') banner('WELLE ' + g.wave + ' GESCHAFFT', 'Nächste Welle …', '#39ff14');
        else if (g.phase === 'dead') {
          if (isMulti && now < endAt) banner('ERWISCHT!', 'Neustart …', '#ff4d6d');
          else if (!isMulti) banner('GAME OVER', 'Welle ' + g.wave + ' · ' + App.MG.fmt(g.score) + ' Punkte', '#ff4d6d');
        }
      }
      function banner(title, sub, color) {
        var gx = ctx2d; gx.save();
        gx.fillStyle = 'rgba(2,10,7,0.58)'; gx.fillRect(0, H / 2 - 62, W, 124);
        gx.textAlign = 'center'; gx.textBaseline = 'middle';
        gx.fillStyle = color; gx.shadowColor = color; gx.shadowBlur = 18;
        gx.font = '900 40px "Segoe UI",system-ui,Arial,sans-serif'; gx.fillText(title, W / 2, H / 2 - 12);
        gx.shadowBlur = 0; gx.fillStyle = 'rgba(230,255,230,.82)';
        gx.font = '700 18px "Segoe UI",system-ui,Arial,sans-serif'; gx.fillText(sub, W / 2, H / 2 + 24);
        gx.restore();
      }

      /* ===================== DOM-AUFBAU ===================== */
      function buildDOM() {
        hudWave = el('div', { class: 'inv-stat-v' }, ['1']);
        hudScore = el('div', { class: 'inv-stat-v inv-score' }, ['0']);
        hudLives = el('div', { class: 'inv-lives' }, []);
        hudTimer = isMulti ? el('div', { class: 'mg-timer inv-timer' }, [App.MG.mmss(MATCH_TIME)]) : null;

        var cells = [
          el('div', { class: 'inv-stat' }, [el('span', { class: 'inv-stat-l' }, ['Welle']), hudWave]),
          el('div', { class: 'inv-stat' }, [el('span', { class: 'inv-stat-l' }, ['Punkte']), hudScore]),
          el('div', { class: 'inv-stat' }, [el('span', { class: 'inv-stat-l' }, ['Leben']), hudLives])
        ];
        if (isMulti) cells.push(el('div', { class: 'inv-stat inv-stat-time' }, [el('span', { class: 'inv-stat-l' }, ['Zeit']), hudTimer]));
        var head = el('div', { class: 'inv-head glass' }, cells);

        canvas = el('canvas', { class: 'inv-canvas', width: W, height: H });
        var stage = el('div', { class: 'inv-stage' }, [canvas]);

        var btnL = el('button', { class: 'inv-ctrl inv-ctrl-move', type: 'button', 'aria-label': 'Links' }, ['◀']);
        var btnFire = el('button', { class: 'inv-ctrl inv-ctrl-fire', type: 'button', 'aria-label': 'Schießen' }, ['🔥']);
        var btnR = el('button', { class: 'inv-ctrl inv-ctrl-move', type: 'button', 'aria-label': 'Rechts' }, ['▶']);
        var controls = el('div', { class: 'inv-controls' }, [btnL, btnFire, btnR]);
        invBtns = { l: btnL, r: btnR, f: btnFire };

        var hint = el('div', { class: 'inv-hint hint-text' }, ['◀ ▶ bewegen · 🔥 schießen · Tasten: Pfeile / A D + Leertaste · obere Reihen = mehr Punkte']);

        var boardWrap = null;
        if (isMulti) {
          boardHelper = App.MG.liveBoard(ctx.room, ctx.me.id);
          stops.push(boardHelper.stop);
          boardWrap = el('div', { class: 'inv-board glass' }, [el('div', { class: 'mg-field-title' }, ['🏆 Rangliste']), boardHelper.root]);
        }

        root.innerHTML = '';
        root.appendChild(el('div', { class: 'inv-wrap' }, [head, stage, controls, hint, boardWrap]));
      }

      function updateLives() {
        if (!hudLives) return;
        hudLives.innerHTML = '';
        var n = g ? g.lives : 3;
        for (var i = 0; i < 3; i++) hudLives.appendChild(el('span', { class: 'inv-heart' + (i < n ? '' : ' off') }, ['🛡️']));
      }

      /* ===================== EINGABE ===================== */
      function cx(e) { var r = canvas.getBoundingClientRect(); return (e.clientX - r.left) / r.width * W; }
      function attachInput() {
        var B = invBtns;
        addL(B.l, 'pointerdown', function (e) { e.preventDefault(); held.left = true; });
        addL(B.r, 'pointerdown', function (e) { e.preventDefault(); held.right = true; });
        addL(B.f, 'pointerdown', function (e) { e.preventDefault(); held.fire = true; tryFire(timeNow()); });
        var release = function () { held.left = held.right = held.fire = false; };
        addL(document, 'pointerup', release);
        addL(document, 'pointercancel', release);

        // Fläche: Finger auf/über die Fläche -> Schiff folgt + Auto-Feuer
        addL(canvas, 'pointerdown', function (e) { e.preventDefault(); drag.active = true; held.fire = true; drag.x = cx(e); tryFire(timeNow()); }, { passive: false });
        addL(canvas, 'pointermove', function (e) { if (drag.active) { e.preventDefault(); drag.x = cx(e); } }, { passive: false });
        var end = function () { drag.active = false; held.fire = false; };
        addL(canvas, 'pointerup', end);
        addL(canvas, 'pointercancel', end);
        addL(canvas, 'pointerleave', end);

        var kd = function (e) {
          var k = e.key;
          if (k === 'ArrowLeft' || k === 'a' || k === 'A') { held.left = true; e.preventDefault(); }
          else if (k === 'ArrowRight' || k === 'd' || k === 'D') { held.right = true; e.preventDefault(); }
          else if (k === ' ' || k === 'Spacebar' || k === 'ArrowUp' || k === 'w' || k === 'W') { held.fire = true; tryFire(timeNow()); e.preventDefault(); }
        };
        var ku = function (e) {
          var k = e.key;
          if (k === 'ArrowLeft' || k === 'a' || k === 'A') held.left = false;
          else if (k === 'ArrowRight' || k === 'd' || k === 'D') held.right = false;
          else if (k === ' ' || k === 'Spacebar' || k === 'ArrowUp' || k === 'w' || k === 'W') held.fire = false;
        };
        addL(document, 'keydown', kd);
        addL(document, 'keyup', ku);
      }

      /* ===================== ENDE ===================== */
      function finishSolo() {
        if (finished) return; finished = true;
        if (raf) { cancelAnimationFrame(raf); raf = null; }
        stopHelpers(); removeL(); clearPending();
        var best = App.Storage.get('best_spaceinvaders', 0);
        var nb = g.score > best;
        if (nb) App.Storage.set('best_spaceinvaders', g.score);
        if (App.Audio) App.Audio.sfx(nb ? 'win' : 'info');
        App.MG.endScreen(root, {
          score: g.score, best: best, newBest: nb,
          label: 'Welle ' + g.wave + ' erreicht' + (nb ? ' · neuer Rekord! 🎉' : ' · Bestwert: ' + App.MG.fmt(best)),
          onExit: ctx.onExit,
          onAgain: function () { finished = false; play(Date.now()); }
        });
      }

      function finishMulti() {
        if (finished) return; finished = true;
        if (raf) { cancelAnimationFrame(raf); raf = null; }
        if (g) { try { ctx.room.reportScore(g.score); } catch (e) {} }
        stopHelpers(); removeL(); clearPending();
        if (App.Audio) App.Audio.sfx('win');
        after(900, function () {
          App.MG.endScreen(root, { players: ctx.room.players(), meId: ctx.me.id, onExit: ctx.onExit });
        });
      }
    }
  };

  /* ===================== STYLES ===================== */
  function injectStyle() {
    UI.injectStyle('mg-spaceinvaders-css', [
      '.inv-wrap{display:flex;flex-direction:column;gap:12px;align-items:stretch;}',
      /* Kopf-HUD */
      '.inv-head{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 16px;flex-wrap:wrap;}',
      '.inv-stat{display:flex;flex-direction:column;gap:2px;min-width:0;text-align:center;flex:1;}',
      '.inv-stat-l{color:var(--muted);font-size:10px;text-transform:uppercase;letter-spacing:1.5px;font-weight:800;}',
      '.inv-stat-v{font-size:clamp(20px,5.4vw,30px);font-weight:900;color:var(--leaf);line-height:1;font-variant-numeric:tabular-nums;}',
      '.inv-score{color:var(--gold);text-shadow:0 0 12px rgba(255,210,63,.4);}',
      '.inv-lives{display:flex;gap:3px;justify-content:center;font-size:clamp(15px,4vw,20px);line-height:1;min-height:22px;}',
      '.inv-heart{filter:drop-shadow(0 0 5px rgba(51,230,208,.5));transition:opacity .2s;}',
      '.inv-heart.off{opacity:.18;filter:grayscale(1);}',
      '.inv-timer{font-size:clamp(18px,5vw,26px);color:var(--aqua);}',
      '.mg-timer.inv-urgent{color:var(--danger-2);animation:inv-pulse .7s infinite;}',
      /* Spielfeld */
      '.inv-stage{width:100%;max-width:440px;margin:0 auto;aspect-ratio:600 / 640;position:relative;}',
      '.inv-canvas{display:block;width:100%;height:100%;border-radius:16px;',
      'border:2px solid rgba(57,255,20,.35);background:#04140c;',
      'box-shadow:0 0 42px rgba(57,255,20,.2),inset 0 0 60px rgba(57,255,20,.05);',
      'touch-action:none;user-select:none;-webkit-user-select:none;-webkit-tap-highlight-color:transparent;cursor:crosshair;}',
      /* Touch-Steuerung */
      '.inv-controls{display:flex;gap:12px;justify-content:center;align-items:stretch;max-width:440px;margin:0 auto;width:100%;}',
      '.inv-ctrl{flex:1;min-height:58px;border-radius:16px;border:1px solid var(--stroke-2);',
      'background:rgba(9,32,21,.72);color:var(--leaf);font-size:24px;font-weight:900;cursor:pointer;',
      'display:flex;align-items:center;justify-content:center;touch-action:none;user-select:none;',
      '-webkit-user-select:none;-webkit-tap-highlight-color:transparent;transition:transform .08s,box-shadow .15s,background .15s;}',
      '.inv-ctrl:active{transform:scale(.95);}',
      '.inv-ctrl-move{color:var(--aqua-soft);}',
      '.inv-ctrl-move:active{background:rgba(51,230,208,.18);box-shadow:0 0 18px rgba(51,230,208,.35);}',
      '.inv-ctrl-fire{flex:1.5;font-size:28px;border-color:var(--neon);color:#eaffe2;',
      'background:linear-gradient(180deg,rgba(57,255,20,.28),rgba(9,32,21,.72));box-shadow:0 0 16px rgba(57,255,20,.3);}',
      '.inv-ctrl-fire:active{background:linear-gradient(180deg,rgba(57,255,20,.5),rgba(9,32,21,.72));box-shadow:0 0 26px rgba(57,255,20,.6);}',
      '.inv-hint{text-align:center;}',
      '.inv-board{padding:12px 14px;display:flex;flex-direction:column;gap:8px;max-width:440px;margin:0 auto;width:100%;}',
      '.inv-board .mg-scoreboard{max-height:240px;overflow-y:auto;}',
      '@keyframes inv-pulse{0%,100%{opacity:1}50%{opacity:.4}}'
    ].join(''));
  }
})();
