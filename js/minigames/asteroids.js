/* asteroids.js — "Asteroiden": klassisches Vektor-Weltraumspiel im Neon-Dschungel-Look.
 *
 * IDEE
 *   Ein Raumschiff im All (Canvas mit Rand-Wrap). Große Asteroiden zerbrechen bei einem
 *   Treffer in zwei mittlere, mittlere in zwei kleine – je kleiner, desto mehr Punkte.
 *   Alle Asteroiden weg -> neue, größere Welle. Gelegentlich fliegt ein UFO ein, das auf
 *   dich zurückschießt (200 Punkte). 3 Leben, jede Kollision kostet ein Leben und gibt
 *   kurze Unverwundbarkeit (blinkendes Schiff).
 *
 * STEUERUNG
 *   Tastatur: ◀▶ / A D = drehen, ▲ / W = Schub, Leertaste/Enter = feuern (Halten = Dauerfeuer).
 *   Touch:    Bildschirm-Buttons unten (drehen links/rechts, Schub 🚀, Feuer 💥) – Halten wirkt.
 *
 * PUNKTE
 *   Großer Asteroid 20 · mittlerer 50 · kleiner 100 · UFO 200.
 *
 * SYNC-MODELL
 *   SOLO : endlos gegen den eigenen Rekord (best_asteroids), Spiel endet bei 0 Leben.
 *   MULTI: Punkte-Rennen über 2 Minuten, meiste Punkte gewinnt, Live-Rangliste.
 *          Jeder spielt sein eigenes Feld, ABER alle bekommen denselben Spawn: die Welle-
 *          und UFO-Startwerte kommen aus einem Seed, der aus round.startAt abgeleitet wird
 *          (deterministischer PRNG). So ist das Rennen fair. Punkte via room.reportScore
 *          (gedrosselt), Rangliste via App.MG.liveBoard, Rundenzeit via App.MG.roundTimer –
 *          alles über die Server-Wall-Clock (room.now), also Tab-Wechsel-sicher.
 *
 * Aufräumen: cleanup() stoppt rAF, alle Timer, alle DOM/Window-Listener und die Room-Listener;
 *            ein dead-Flag verhindert, dass nach dem Aufräumen noch ein Callback etwas tut.
 */
(function () {
  'use strict';
  window.App = window.App || {}; App.Minigames = App.Minigames || {};
  var UI = App.UI, el = UI.el;

  /* ---- virtuelles Spielfeld (feste Koordinaten, Canvas skaliert per CSS) ---- */
  var W = 900, H = 600;
  var LIVES = 3;
  var ROUND_MS = 120000;                 // 2 Minuten im Multiplayer
  var SHIP_R = 15, SHIP_HIT = 12;        // Schiffsgröße / Trefferradius
  var ROT = 3.7;                         // rad/s Drehgeschwindigkeit
  var THRUST = 340;                      // px/s^2 Beschleunigung
  var DRAG = 0.55;                       // Reibung pro Sekunde (leichtes Ausgleiten)
  var MAX_SPEED = 470;                   // px/s Deckel
  var BULLET_SPEED = 560, BULLET_LIFE = 1050, FIRE_MS = 230, MAX_BULLETS = 6;
  var INVULN = 2600, INVULN_START = 2000, RESPAWN_MS = 1100;
  var UFO_R = 17, UFO_SPEED = 135, UFO_SHOT_MS = 1400, UFO_BULLET_SPEED = 270;
  var UFO_FIRST = 17000, UFO_EVERY = 23000;   // ms: erstes UFO / Abstand
  var PTS = { 3: 20, 2: 50, 1: 100 };

  injectStyle();

  App.Minigames.asteroids = {
    id: 'asteroids', title: 'Asteroiden', icon: '☄️', order: 134,
    subtitle: 'Fliegen, drehen, schießen – zersprenge das Feld!',
    single: true, multi: true, minPlayers: 2, maxPlayers: 8,

    render: function (root, ctx) {
      var isMulti = ctx.mode === 'multi';
      var timeNow = isMulti ? function () { return ctx.room.now(); } : function () { return Date.now(); };

      /* ---- Laufzeit ---- */
      var dead = false, raf = null, last = 0;
      var stops = [];        // langlebige stop()-Funktionen (Countdown)
      var playStops = [];    // pro Runde: Rundentimer, Live-Rangliste
      var listeners = [];    // {t,ty,fn,opts}
      var timers = [];       // setTimeout-IDs

      /* ---- DOM ---- */
      var g2d = null, canvasEl = null, overlayEl = null;
      var scoreEl = null, livesEl = null, waveEl = null, timerEl = null, bestEl = null;
      var stars = [];

      /* ---- Eingabe (Halte-Zustand für Tasten UND Touch-Buttons) ---- */
      var input = { left: false, right: false, thrust: false, fire: false };

      /* ---- Spielzustand + Determinismus ---- */
      var S = null, baseSeed = 0, t0 = 0, endAt = 0, shake = 0;
      var bannerToken = 0, lastReport = 0, lastReported = -1;

      /* ===================== Helfer: Aufräumen ===================== */
      function addL(t, ty, fn, opts) { t.addEventListener(ty, fn, opts); listeners.push({ t: t, ty: ty, fn: fn, opts: opts }); }
      function removeAllL() { listeners.forEach(function (l) { try { l.t.removeEventListener(l.ty, l.fn, l.opts); } catch (e) {} }); listeners = []; }
      function addStop(fn) { if (fn) stops.push(fn); }
      function stopPlay() { playStops.forEach(function (f) { try { f(); } catch (e) {} }); playStops = []; }
      function after(ms, fn) { var t = setTimeout(function () { if (!dead) fn(); }, ms); timers.push(t); return t; }
      function cleanup() {
        dead = true;
        if (raf) { cancelAnimationFrame(raf); raf = null; }
        timers.forEach(clearTimeout); timers = [];
        stopPlay();
        stops.forEach(function (f) { try { f(); } catch (e) {} }); stops = [];
        removeAllL();
      }

      /* ===================== Start ===================== */
      if (isMulti) {
        var snap = ctx.room.snapshot() || {};
        var startAt = (snap.round && snap.round.startAt) || (ctx.room.now() + 3000);
        addStop(App.MG.countdown(root, startAt, function () { play(startAt); }, ctx.room.now));
      } else {
        play(timeNow());
      }
      return { cleanup: cleanup };

      /* ===================== Runde aufbauen ===================== */
      function play(startAt) {
        if (raf) { cancelAnimationFrame(raf); raf = null; }
        removeAllL(); stopPlay();
        input.left = input.right = input.thrust = input.fire = false;
        t0 = startAt; endAt = startAt + ROUND_MS;
        baseSeed = seedFromTime(startAt) ^ (isMulti ? 0 : 0x5c0ffee);
        shake = 0; lastReport = 0; lastReported = -1; bannerToken = 0;

        S = newGame();
        buildStage();
        attachInput();
        spawnWave(1);

        if (isMulti) {
          ctx.room.reportScore(0);
          playStops.push(App.MG.roundTimer(endAt, function (left) {
            if (!timerEl) return;
            timerEl.textContent = App.MG.mmss(left);
            if (left <= 10) timerEl.classList.add('ast-urgent');
          }, finish, ctx.room.now));
        }

        last = timeNow();
        raf = requestAnimationFrame(frame);
      }

      function newGame() {
        return {
          ship: newShip(),
          bullets: [], asteroids: [], ufo: null, ufoBullets: [], parts: [],
          lives: LIVES, score: 0, wave: 0,
          over: false, out: false,
          nextFireAt: 0, ufoCount: 0, respawnAt: 0, waveClearAt: 0
        };
      }
      function newShip() {
        return { x: W / 2, y: H / 2, vx: 0, vy: 0, angle: 0, alive: true, invulnUntil: timeNow() + INVULN_START };
      }

      /* ===================== deterministischer Zufall ===================== */
      function seedFromTime(ms) { return (Math.floor(ms) % 2147483647) >>> 0; }
      function makeRng(seed) {
        var s = seed >>> 0;
        return function () {
          s = (s + 0x6d2b79f5) | 0;
          var t = Math.imul(s ^ (s >>> 15), 1 | s);
          t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
          return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
      }

      /* ===================== Wellen & Asteroiden ===================== */
      function makeAsteroid(size, rng, x, y) {
        rng = rng || Math.random;
        var r = size === 3 ? 46 : size === 2 ? 27 : 16;
        var spd = size === 3 ? (38 + rng() * 36) : size === 2 ? (60 + rng() * 48) : (92 + rng() * 70);
        var dir = rng() * Math.PI * 2;
        var verts = size === 3 ? 12 : size === 2 ? 10 : 8;
        var shape = [];
        for (var i = 0; i < verts; i++) shape.push(0.72 + rng() * 0.46);
        return {
          x: (x == null ? rng() * W : x), y: (y == null ? rng() * H : y),
          vx: Math.cos(dir) * spd, vy: Math.sin(dir) * spd,
          r: r, size: size, shape: shape, ang: rng() * Math.PI * 2, spin: (rng() * 2 - 1) * 1.4
        };
      }
      function spawnWave(n) {
        S.wave = n;
        var count = Math.min(2 + n, 9);
        // MULTI: seeded (jede Welle für alle gleich) · SOLO: freier Zufall
        var rng = isMulti ? makeRng((baseSeed ^ Math.imul(n, 0x9e3779b1)) >>> 0) : Math.random;
        for (var i = 0; i < count; i++) {
          var px, py, tries = 0;
          do { px = rng() * W; py = rng() * H; tries++; } while (tries < 24 && dist(px, py, W / 2, H / 2) < 185);
          S.asteroids.push(makeAsteroid(3, rng, px, py));
        }
        banner('Welle ' + n, 1150);
        if (App.Audio && n > 1) App.Audio.sfx('levelup');
      }

      function destroyAsteroid(idx, award) {
        var a = S.asteroids[idx];
        if (award) S.score += (PTS[a.size] || 0);
        spawnParts(a.x, a.y, a.size === 3 ? 14 : a.size === 2 ? 10 : 7, astColor(a.size));
        S.asteroids.splice(idx, 1);
        if (a.size > 1) {
          for (var k = 0; k < 2; k++) {
            var b = makeAsteroid(a.size - 1, Math.random, a.x, a.y);
            var d = Math.random() * Math.PI * 2;
            b.vx += Math.cos(d) * 26; b.vy += Math.sin(d) * 26;
            S.asteroids.push(b);
          }
        }
        shake = Math.min(shake + (a.size === 3 ? 7 : 4), 14);
        if (App.Audio) App.Audio.sfx(a.size === 3 ? 'explosion' : 'pop');
      }

      /* ===================== UFO ===================== */
      function updateUfo(now, dt) {
        var due = t0 + UFO_FIRST + S.ufoCount * UFO_EVERY;
        if (!S.ufo && now >= due) { spawnUfo(S.ufoCount); S.ufoCount++; }
        var u = S.ufo; if (!u) return;
        u.x += u.vx * dt;
        u.wig += dt;
        u.y += Math.cos(u.wig * 2.1) * 34 * dt;
        if (u.y < UFO_R) u.y = UFO_R; else if (u.y > H - UFO_R) u.y = H - UFO_R;
        if (S.ship.alive && !S.over && !S.out && now >= u.nextShotAt) { ufoShoot(u, now); u.nextShotAt = now + UFO_SHOT_MS; }
        if ((u.dir > 0 && u.x > W + 40) || (u.dir < 0 && u.x < -40)) S.ufo = null;
      }
      function spawnUfo(index) {
        var rng = isMulti ? makeRng((baseSeed ^ 0x51ed270b ^ Math.imul(index + 1, 0x85ebca6b)) >>> 0) : Math.random;
        var dir = rng() < 0.5 ? 1 : -1;
        var y = 90 + rng() * (H - 180);
        S.ufo = { x: dir > 0 ? -30 : W + 30, y: y, vx: dir * UFO_SPEED, dir: dir, wig: rng() * 6, nextShotAt: timeNow() + 850, r: UFO_R };
        if (App.Audio) App.Audio.sfx('whoosh');
      }
      function ufoShoot(u, now) {
        var sh = S.ship;
        var tt = dist(u.x, u.y, sh.x, sh.y) / UFO_BULLET_SPEED;      // Vorhalt auf die Schiffsbewegung
        var tx = sh.x + sh.vx * tt * 0.6, ty = sh.y + sh.vy * tt * 0.6;
        var ang = Math.atan2(ty - u.y, tx - u.x);
        var spread = Math.max(0.05, 0.34 - S.wave * 0.035);          // wird pro Welle genauer
        ang += (Math.random() * 2 - 1) * spread;
        S.ufoBullets.push({ x: u.x, y: u.y, vx: Math.cos(ang) * UFO_BULLET_SPEED, vy: Math.sin(ang) * UFO_BULLET_SPEED, dieAt: now + 2600 });
        if (App.Audio) App.Audio.blip(240, 0.08, { type: 'sawtooth', peak: 0.05 });
      }
      function killUfo() {
        if (!S.ufo) return;
        S.score += 200;
        spawnParts(S.ufo.x, S.ufo.y, 18, '#ff5d6d');
        shake = Math.min(shake + 10, 18);
        S.ufo = null;
        if (App.Audio) App.Audio.sfx('jackpot');
      }

      /* ===================== Schiff & Schüsse ===================== */
      function fire(now) {
        if (S.bullets.length >= MAX_BULLETS) return;
        var sh = S.ship, dx = Math.sin(sh.angle), dy = -Math.cos(sh.angle);
        S.bullets.push({ x: sh.x + dx * SHIP_R, y: sh.y + dy * SHIP_R, vx: dx * BULLET_SPEED + sh.vx * 0.4, vy: dy * BULLET_SPEED + sh.vy * 0.4, dieAt: now + BULLET_LIFE });
        S.nextFireAt = now + FIRE_MS;
        if (App.Audio) App.Audio.blip(680, 0.05, { type: 'square', peak: 0.045 });
      }
      function updateShip(now, dt) {
        var sh = S.ship;
        if (!sh.alive) return;
        if (input.left) sh.angle -= ROT * dt;
        if (input.right) sh.angle += ROT * dt;
        if (input.thrust) { sh.vx += Math.sin(sh.angle) * THRUST * dt; sh.vy += -Math.cos(sh.angle) * THRUST * dt; }
        var fr = 1 - DRAG * dt; if (fr < 0) fr = 0;
        sh.vx *= fr; sh.vy *= fr;
        var sp = Math.hypot(sh.vx, sh.vy);
        if (sp > MAX_SPEED) { sh.vx *= MAX_SPEED / sp; sh.vy *= MAX_SPEED / sp; }
        sh.x += sh.vx * dt; sh.y += sh.vy * dt; wrap(sh);
        if (input.fire && now >= S.nextFireAt) fire(now);
      }
      function loseLife(now) {
        var sh = S.ship; if (!sh.alive) return;
        S.lives--;
        sh.alive = false;
        spawnParts(sh.x, sh.y, 24, '#ff5d6d');
        shake = Math.min(shake + 16, 20);
        if (App.Audio) App.Audio.sfx('explosion');
        if (S.lives <= 0) { S.respawnAt = 0; after(1000, function () { if (isMulti) outOfLives(); else gameOver(); }); }
        else { S.respawnAt = now + RESPAWN_MS; }
      }
      function respawnShip(now) {
        var sh = S.ship;
        sh.x = W / 2; sh.y = H / 2; sh.vx = 0; sh.vy = 0; sh.angle = 0; sh.alive = true;
        sh.invulnUntil = now + INVULN;
        if (App.Audio) App.Audio.sfx('powerup');
      }

      /* ===================== Bewegung ===================== */
      function updateBullets(dt, now) {
        for (var i = S.bullets.length - 1; i >= 0; i--) {
          var b = S.bullets[i];
          if (now >= b.dieAt) { S.bullets.splice(i, 1); continue; }
          b.x += b.vx * dt; b.y += b.vy * dt; wrap(b);
        }
      }
      function updateUfoBullets(dt, now) {
        for (var i = S.ufoBullets.length - 1; i >= 0; i--) {
          var b = S.ufoBullets[i];
          if (now >= b.dieAt) { S.ufoBullets.splice(i, 1); continue; }
          b.x += b.vx * dt; b.y += b.vy * dt; wrap(b);
        }
      }
      function updateAsteroids(dt) {
        for (var i = 0; i < S.asteroids.length; i++) {
          var a = S.asteroids[i];
          a.x += a.vx * dt; a.y += a.vy * dt; a.ang += a.spin * dt; wrap(a);
        }
      }
      function updateParts(dt, now) {
        for (var i = S.parts.length - 1; i >= 0; i--) {
          var p = S.parts[i];
          if (now >= p.end) { S.parts.splice(i, 1); continue; }
          p.x += p.vx * dt; p.y += p.vy * dt;
          var f = 1 - 1.4 * dt; if (f < 0) f = 0; p.vx *= f; p.vy *= f;
        }
      }
      function spawnParts(x, y, n, color) {
        for (var i = 0; i < n; i++) {
          var a = Math.random() * Math.PI * 2, sp = 40 + Math.random() * 180, dur = 300 + Math.random() * 420;
          S.parts.push({ x: x, y: y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, end: timeNow() + dur, dur: dur, color: color });
          if (S.parts.length > 170) S.parts.shift();
        }
      }

      /* ===================== Kollisionen ===================== */
      function collide(now) {
        var sh = S.ship, bi, ai;
        for (bi = S.bullets.length - 1; bi >= 0; bi--) {
          var b = S.bullets[bi], hit = false;
          for (ai = S.asteroids.length - 1; ai >= 0; ai--) {
            var a = S.asteroids[ai];
            if (dist(b.x, b.y, a.x, a.y) < a.r) { destroyAsteroid(ai, true); S.bullets.splice(bi, 1); hit = true; break; }
          }
          if (hit) continue;
          if (S.ufo && dist(b.x, b.y, S.ufo.x, S.ufo.y) < S.ufo.r + 2) { killUfo(); S.bullets.splice(bi, 1); }
        }
        if (!sh.alive || now < sh.invulnUntil || S.over || S.out) return;
        for (ai = S.asteroids.length - 1; ai >= 0; ai--) {
          if (dist(sh.x, sh.y, S.asteroids[ai].x, S.asteroids[ai].y) < S.asteroids[ai].r + SHIP_HIT * 0.6) { loseLife(now); return; }
        }
        for (var ui = S.ufoBullets.length - 1; ui >= 0; ui--) {
          if (dist(sh.x, sh.y, S.ufoBullets[ui].x, S.ufoBullets[ui].y) < SHIP_HIT) { S.ufoBullets.splice(ui, 1); loseLife(now); return; }
        }
        if (S.ufo && dist(sh.x, sh.y, S.ufo.x, S.ufo.y) < S.ufo.r + SHIP_HIT) { killUfo(); loseLife(now); }
      }

      /* ===================== Hauptschleife ===================== */
      function frame() {
        if (dead) { raf = null; return; }
        var now = timeNow();
        var dt = (now - last) / 1000; if (dt < 0) dt = 0; if (dt > 0.05) dt = 0.05; last = now;

        if (!S.over && !S.out) {
          updateShip(now, dt);
          if (!S.ship.alive && S.lives > 0 && S.respawnAt && now >= S.respawnAt) respawnShip(now);
          updateBullets(dt, now);
          updateAsteroids(dt);
          updateUfo(now, dt);
          updateUfoBullets(dt, now);
          updateParts(dt, now);
          collide(now);
          if (S.asteroids.length === 0) {
            if (S.waveClearAt === 0) S.waveClearAt = now + 1500;
            else if (now >= S.waveClearAt) { S.waveClearAt = 0; spawnWave(S.wave + 1); }
          }
          if (isMulti && S.score !== lastReported && now - lastReport > 250) {
            lastReport = now; lastReported = S.score; try { ctx.room.reportScore(S.score); } catch (e) {}
          }
        } else {
          updateAsteroids(dt);
          updateParts(dt, now);
        }

        if (shake > 0) { shake -= dt * 42; if (shake < 0) shake = 0; }
        draw(now);
        raf = requestAnimationFrame(frame);
      }

      /* ===================== Ende ===================== */
      function gameOver() {   // nur SOLO
        if (S.over) return;
        S.over = true;
        if (raf) { cancelAnimationFrame(raf); raf = null; }
        var best = App.Storage.get('best_asteroids', 0);
        var nb = S.score > best;
        if (nb) App.Storage.set('best_asteroids', S.score);
        if (App.Audio) App.Audio.sfx(nb ? 'jackpot' : 'lose');
        App.MG.endScreen(root, {
          score: S.score, best: best, newBest: nb,
          label: (nb ? 'Neuer Rekord! 🎉' : 'Bestwert: ' + App.MG.fmt(best)) + ' · Welle ' + S.wave,
          onExit: ctx.onExit,
          onAgain: function () { play(timeNow()); }
        });
      }
      function outOfLives() {  // nur MULTI: Schiff verbraucht, aber Runde läuft weiter bis zum Zeitablauf
        if (S.out || S.over) return;
        S.out = true;
        try { ctx.room.reportScore(S.score); } catch (e) {}
        if (App.Audio) App.Audio.sfx('lose');
        banner('Ausgeschieden – ' + App.MG.fmt(S.score) + ' Punkte', 0, 'ast-banner-out');
      }
      function finish() {      // nur MULTI: 2 Minuten vorbei
        if (S.over) return;
        S.over = true;
        stopPlay();
        if (raf) { cancelAnimationFrame(raf); raf = null; }
        try { ctx.room.reportScore(S.score); } catch (e) {}
        after(500, function () {
          App.MG.endScreen(root, { players: ctx.room.players(), meId: ctx.me.id, onExit: ctx.onExit });
        });
      }

      /* ===================== Rendering ===================== */
      function draw(now) {
        var g = g2d; if (!g) return;
        g.setTransform(1, 0, 0, 1, 0, 0);
        g.clearRect(0, 0, W, H);
        var grd = g.createLinearGradient(0, 0, 0, H);
        grd.addColorStop(0, '#06170e'); grd.addColorStop(1, '#020a06');
        g.fillStyle = grd; g.fillRect(0, 0, W, H);

        var sx = 0, sy = 0;
        if (shake > 0) { sx = (Math.random() * 2 - 1) * shake; sy = (Math.random() * 2 - 1) * shake; }
        g.save(); g.translate(sx, sy);

        // Sternenhintergrund
        for (var i = 0; i < stars.length; i++) {
          var st = stars[i];
          g.globalAlpha = st.a; g.fillStyle = st.c;
          g.beginPath(); g.arc(st.x, st.y, st.r, 0, Math.PI * 2); g.fill();
        }
        g.globalAlpha = 1;

        // Feldrahmen
        g.save(); g.strokeStyle = 'rgba(57,255,20,0.18)'; g.lineWidth = 3;
        roundRect(g, 6, 6, W - 12, H - 12, 16); g.stroke(); g.restore();

        // Asteroiden
        for (i = 0; i < S.asteroids.length; i++) drawAsteroid(g, S.asteroids[i]);
        // Schuss-Trails
        g.save(); g.fillStyle = '#eaffe0'; g.shadowColor = '#39ff14'; g.shadowBlur = 10;
        for (i = 0; i < S.bullets.length; i++) { var bb = S.bullets[i]; g.beginPath(); g.arc(bb.x, bb.y, 2.7, 0, Math.PI * 2); g.fill(); }
        g.restore();
        // UFO + UFO-Schüsse
        drawUfo(g);
        g.save(); g.fillStyle = '#ffd23f'; g.shadowColor = '#ff5d6d'; g.shadowBlur = 10;
        for (i = 0; i < S.ufoBullets.length; i++) { var ub = S.ufoBullets[i]; g.beginPath(); g.arc(ub.x, ub.y, 3, 0, Math.PI * 2); g.fill(); }
        g.restore();
        // Schiff
        drawShip(g, now);
        // Partikel
        for (i = 0; i < S.parts.length; i++) {
          var p = S.parts[i], al = (p.end - now) / p.dur; if (al < 0) al = 0;
          g.globalAlpha = al; g.fillStyle = p.color;
          g.beginPath(); g.arc(p.x, p.y, 2, 0, Math.PI * 2); g.fill();
        }
        g.globalAlpha = 1;
        g.restore();

        updateHud();
      }
      function drawAt(x, y, r, fn) {
        var xs = [x], ys = [y];
        if (x < r) xs.push(x + W); else if (x > W - r) xs.push(x - W);
        if (y < r) ys.push(y + H); else if (y > H - r) ys.push(y - H);
        for (var a = 0; a < xs.length; a++) for (var b = 0; b < ys.length; b++) fn(xs[a], ys[b]);
      }
      function drawAsteroid(g, a) {
        var col = astColor(a.size);
        drawAt(a.x, a.y, a.r + 4, function (x, y) {
          g.save(); g.translate(x, y); g.rotate(a.ang);
          g.beginPath();
          for (var i = 0; i < a.shape.length; i++) {
            var ang = (i / a.shape.length) * Math.PI * 2, rr = a.r * a.shape[i];
            var px = Math.cos(ang) * rr, py = Math.sin(ang) * rr;
            if (i === 0) g.moveTo(px, py); else g.lineTo(px, py);
          }
          g.closePath();
          g.fillStyle = 'rgba(10,26,16,0.55)'; g.fill();
          g.lineWidth = 2.2; g.strokeStyle = col; g.shadowColor = col; g.shadowBlur = 12; g.stroke();
          g.restore();
        });
      }
      function drawUfo(g) {
        var u = S.ufo; if (!u) return;
        drawAt(u.x, u.y, u.r + 6, function (x, y) {
          g.save(); g.translate(x, y);
          g.lineWidth = 2.4; g.strokeStyle = '#ff5d6d'; g.shadowColor = '#ff5d6d'; g.shadowBlur = 16;
          g.beginPath(); g.ellipse(0, 2, u.r, u.r * 0.5, 0, 0, Math.PI * 2);
          g.fillStyle = 'rgba(255,93,109,0.15)'; g.fill(); g.stroke();
          g.beginPath(); g.strokeStyle = '#4fe6d6'; g.shadowColor = '#4fe6d6';
          g.arc(0, -2, u.r * 0.5, Math.PI, 0); g.stroke();
          g.restore();
        });
      }
      function drawShip(g, now) {
        var sh = S.ship; if (!sh.alive) return;
        var inv = now < sh.invulnUntil;
        drawAt(sh.x, sh.y, SHIP_R + 8, function (x, y) {
          g.save(); g.translate(x, y); g.rotate(sh.angle);
          g.globalAlpha = inv ? (0.45 + 0.35 * Math.sin(now / 70)) : 1;
          if (input.thrust) {
            var f = 6 + Math.random() * 11;
            g.beginPath(); g.moveTo(-6, SHIP_R * 0.6); g.lineTo(0, SHIP_R * 0.6 + f); g.lineTo(6, SHIP_R * 0.6);
            g.fillStyle = '#ffd23f'; g.shadowColor = '#ff9b2f'; g.shadowBlur = 14; g.fill();
          }
          g.beginPath();
          g.moveTo(0, -SHIP_R);
          g.lineTo(SHIP_R * 0.82, SHIP_R * 0.9);
          g.lineTo(0, SHIP_R * 0.5);
          g.lineTo(-SHIP_R * 0.82, SHIP_R * 0.9);
          g.closePath();
          g.fillStyle = 'rgba(57,255,20,0.18)'; g.fill();
          g.lineWidth = 2.4; g.strokeStyle = '#eaffe0'; g.shadowColor = '#39ff14'; g.shadowBlur = 16; g.stroke();
          g.restore();
        });
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

      /* ===================== HUD & Overlay ===================== */
      function updateHud() {
        if (scoreEl) scoreEl.textContent = App.MG.fmt(S.score);
        if (livesEl) livesEl.textContent = livesStr(S.lives);
        if (waveEl) waveEl.textContent = String(S.wave);
      }
      function banner(text, ms, extra) {
        if (!overlayEl) return;
        overlayEl.className = 'ast-overlay show' + (extra ? ' ' + extra : '');
        overlayEl.innerHTML = '';
        overlayEl.appendChild(el('div', { class: 'ast-banner' }, [text]));
        var tok = ++bannerToken;
        if (ms) after(ms, function () { if (tok === bannerToken && overlayEl) overlayEl.className = 'ast-overlay'; });
      }

      /* ===================== Bühne aufbauen ===================== */
      function buildStage() {
        // Sterne einmalig würfeln (nur Deko)
        stars = [];
        for (var s = 0; s < 74; s++) {
          stars.push({ x: Math.random() * W, y: Math.random() * H, r: 0.5 + Math.random() * 1.4, a: 0.2 + Math.random() * 0.55, c: Math.random() < 0.25 ? '#8dff6a' : '#bfeede' });
        }

        scoreEl = el('div', { class: 'ast-val ast-val-score' }, ['0']);
        livesEl = el('div', { class: 'ast-val ast-val-lives' }, [livesStr(LIVES)]);
        waveEl = el('div', { class: 'ast-val ast-val-wave' }, ['1']);

        var headCells = [
          el('div', { class: 'ast-cell' }, [el('span', { class: 'ast-cell-l' }, ['Punkte']), scoreEl]),
          el('div', { class: 'ast-cell' }, [el('span', { class: 'ast-cell-l' }, ['Leben']), livesEl]),
          el('div', { class: 'ast-cell' }, [el('span', { class: 'ast-cell-l' }, ['Welle']), waveEl])
        ];
        if (isMulti) {
          timerEl = el('div', { class: 'mg-timer ast-timer' }, ['2:00']);
          headCells.push(el('div', { class: 'ast-cell ast-cell-r' }, [el('span', { class: 'ast-cell-l' }, ['Zeit']), timerEl]));
        } else {
          var best = App.Storage.get('best_asteroids', 0);
          bestEl = el('div', { class: 'ast-val ast-val-best' }, [App.MG.fmt(best)]);
          headCells.push(el('div', { class: 'ast-cell ast-cell-r' }, [el('span', { class: 'ast-cell-l' }, ['Rekord']), bestEl]));
        }
        var head = el('div', { class: 'ast-head glass' }, headCells);

        canvasEl = el('canvas', { class: 'ast-canvas', width: W, height: H });
        overlayEl = el('div', { class: 'ast-overlay' });
        var stage = el('div', { class: 'ast-stage' }, [canvasEl, overlayEl]);

        var hint = el('div', { class: 'ast-hint hint-text' }, ['Drehen ◀ ▶ · Schub 🚀 · Feuer 💥 · Tasten: Pfeile/WASD + Leertaste · Rand ist offen (Wrap)']);

        var controls = el('div', { class: 'ast-controls' }, [
          el('div', { class: 'ast-pad' }, [
            holdBtn('◀', 'ast-ctl-rot', 'links drehen', 'left'),
            holdBtn('▶', 'ast-ctl-rot', 'rechts drehen', 'right')
          ]),
          el('div', { class: 'ast-pad' }, [
            holdBtn('🚀', 'ast-ctl-thrust', 'Schub', 'thrust'),
            holdBtn('💥', 'ast-ctl-fire', 'Feuer', 'fire')
          ])
        ]);

        var kids = [head, stage, hint, controls];

        if (isMulti) {
          var board = App.MG.liveBoard(ctx.room, ctx.me.id);
          playStops.push(board.stop);
          kids.push(el('div', { class: 'ast-board-wrap glass' }, [
            el('div', { class: 'mg-field-title' }, ['🏆 Rangliste']), board.root
          ]));
        }

        var wrap = el('div', { class: 'ast-wrap' }, kids);
        root.innerHTML = ''; root.appendChild(wrap);
        g2d = canvasEl.getContext('2d');
      }

      function holdBtn(label, cls, aria, key) {
        var b = el('button', { class: 'ast-ctl ' + cls, type: 'button', 'aria-label': aria }, [label]);
        function down(e) {
          if (e && e.preventDefault) e.preventDefault();
          if (e && e.pointerId != null && b.setPointerCapture) { try { b.setPointerCapture(e.pointerId); } catch (_) {} }
          input[key] = true; b.classList.add('on');
          if (key === 'fire' && App.Audio) App.Audio.blip(680, 0.04, { type: 'square', peak: 0.04 });
        }
        function up(e) {
          if (e && e.preventDefault) e.preventDefault();
          input[key] = false; b.classList.remove('on');
        }
        addL(b, 'pointerdown', down);
        addL(b, 'pointerup', up);
        addL(b, 'pointercancel', up);
        addL(b, 'pointerleave', up);
        return b;
      }

      function attachInput() {
        function kd(e) {
          var k = e.key;
          if (k === 'ArrowLeft' || k === 'a' || k === 'A') { input.left = true; e.preventDefault(); }
          else if (k === 'ArrowRight' || k === 'd' || k === 'D') { input.right = true; e.preventDefault(); }
          else if (k === 'ArrowUp' || k === 'w' || k === 'W') { input.thrust = true; e.preventDefault(); }
          else if (k === ' ' || k === 'Spacebar' || k === 'Enter') { input.fire = true; e.preventDefault(); }
        }
        function ku(e) {
          var k = e.key;
          if (k === 'ArrowLeft' || k === 'a' || k === 'A') input.left = false;
          else if (k === 'ArrowRight' || k === 'd' || k === 'D') input.right = false;
          else if (k === 'ArrowUp' || k === 'w' || k === 'W') input.thrust = false;
          else if (k === ' ' || k === 'Spacebar' || k === 'Enter') input.fire = false;
        }
        addL(document, 'keydown', kd);
        addL(document, 'keyup', ku);
      }

      /* ===================== kleine Helfer ===================== */
      function wrap(o) { if (o.x < 0) o.x += W; else if (o.x > W) o.x -= W; if (o.y < 0) o.y += H; else if (o.y > H) o.y -= H; }
      function dist(x1, y1, x2, y2) { var dx = x1 - x2, dy = y1 - y2; return Math.sqrt(dx * dx + dy * dy); }
      function astColor(size) { return size === 3 ? '#8dff6a' : size === 2 ? '#4fe6d6' : '#ffd23f'; }
      function livesStr(n) { var s = ''; for (var i = 0; i < LIVES; i++) s += (i < n ? '❤️' : '🖤'); return s; }
    }
  };

  /* ===================== STYLES ===================== */
  function injectStyle() {
    UI.injectStyle('mg-asteroids-css', [
      '.ast-wrap{display:flex;flex-direction:column;gap:12px;align-items:stretch;}',
      '.ast-head{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:10px 16px;flex-wrap:wrap;}',
      '.ast-cell{display:flex;flex-direction:column;gap:2px;min-width:0;}',
      '.ast-cell-r{text-align:right;align-items:flex-end;}',
      '.ast-cell-l{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:1px;font-weight:700;}',
      '.ast-val{font-weight:900;line-height:1;font-variant-numeric:tabular-nums;}',
      '.ast-val-score{font-size:clamp(22px,5.5vw,36px);color:var(--gold);text-shadow:0 0 12px rgba(255,210,63,.45);}',
      '.ast-val-lives{font-size:clamp(16px,4vw,22px);letter-spacing:2px;}',
      '.ast-val-wave{font-size:clamp(22px,5.5vw,36px);color:var(--neon);text-shadow:0 0 12px rgba(57,255,20,.4);}',
      '.ast-val-best{font-size:clamp(20px,5vw,30px);color:var(--aqua);text-shadow:0 0 12px rgba(51,230,208,.4);}',
      '.ast-head .mg-timer.ast-timer{font-size:clamp(18px,5vw,28px);}',
      '.mg-timer.ast-timer.ast-urgent{color:var(--danger);animation:ast-pulse .7s infinite;}',
      // Bühne
      '.ast-stage{position:relative;width:100%;max-width:640px;margin:0 auto;aspect-ratio:900 / 600;}',
      '.ast-canvas{display:block;width:100%;height:100%;border-radius:16px;',
      'border:2px solid rgba(57,255,20,.32);background:#04140c;',
      'box-shadow:0 0 42px rgba(57,255,20,.2),inset 0 0 60px rgba(57,255,20,.05);',
      'touch-action:none;user-select:none;-webkit-user-select:none;-webkit-tap-highlight-color:transparent;}',
      // Overlay-Banner
      '.ast-overlay{position:absolute;inset:0;display:none;align-items:center;justify-content:center;pointer-events:none;padding:16px;text-align:center;}',
      '.ast-overlay.show{display:flex;}',
      '.ast-banner{font-size:clamp(24px,7vw,48px);font-weight:900;color:var(--neon);',
      'text-shadow:0 0 20px rgba(57,255,20,.6),0 2px 10px rgba(0,0,0,.6);letter-spacing:1px;',
      'animation:ast-banner-in .35s cubic-bezier(.2,.8,.3,1) both;}',
      '.ast-overlay.ast-banner-out .ast-banner{color:var(--danger);text-shadow:0 0 20px rgba(255,77,109,.55),0 2px 10px rgba(0,0,0,.6);font-size:clamp(20px,5.5vw,38px);}',
      '@keyframes ast-banner-in{from{opacity:0;transform:scale(.7);}to{opacity:1;transform:scale(1);}}',
      '.ast-hint{text-align:center;}',
      // Steuerung
      '.ast-controls{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;}',
      '.ast-pad{display:flex;gap:10px;}',
      '.ast-ctl{width:clamp(58px,15vw,72px);height:clamp(58px,15vw,72px);border-radius:16px;',
      'display:flex;align-items:center;justify-content:center;font-size:clamp(22px,6vw,30px);',
      'background:rgba(9,32,21,.72);border:1px solid var(--stroke);color:var(--text);cursor:pointer;',
      'font-family:inherit;line-height:1;user-select:none;-webkit-user-select:none;',
      '-webkit-tap-highlight-color:transparent;touch-action:none;',
      'transition:transform .08s,background .12s,border-color .12s,box-shadow .12s;}',
      '.ast-ctl.on{transform:scale(.93);}',
      '.ast-ctl-rot.on{border-color:var(--aqua);box-shadow:0 0 0 1px var(--aqua),0 0 16px rgba(51,230,208,.4);background:rgba(9,40,38,.85);}',
      '.ast-ctl-thrust{border-color:rgba(255,210,63,.4);}',
      '.ast-ctl-thrust.on{border-color:var(--gold);box-shadow:0 0 0 1px var(--gold),0 0 18px rgba(255,210,63,.45);background:rgba(40,32,6,.85);}',
      '.ast-ctl-fire{border-color:rgba(255,77,109,.45);}',
      '.ast-ctl-fire.on{border-color:var(--danger);box-shadow:0 0 0 1px var(--danger),0 0 18px rgba(255,77,109,.5);background:rgba(40,10,16,.85);}',
      // Rangliste
      '.ast-board-wrap{padding:14px;display:flex;flex-direction:column;gap:8px;}',
      '.ast-board-wrap .mg-scoreboard{max-height:230px;overflow-y:auto;}',
      '@keyframes ast-pulse{0%,100%{opacity:1}50%{opacity:.4}}'
    ].join(''));
  }
})();
