/* dodge.js — "Kugelhagel": Bullet-Hell-Ausweichen im Neon-Dschungel.
 *
 * IDEE:      Aus allen vier Rändern fliegen immer mehr und immer schnellere
 *            Leucht-Projektile herein. Du steuerst einen kleinen Punkt und
 *            weichst aus. Überlebte Zeit = Punkte. Ein Treffer = raus.
 *            Gelegentlich erscheinen Power-Ups: 🛡️ Schild (kurz unverwundbar)
 *            und 🐢 Zeitlupe (der Kugelhagel wird für dich langsamer).
 *
 * STEUERUNG: Maus = Punkt folgt dem Zeiger. Handy/iPad = Finger auf der Fläche
 *            ziehen (Wischen, relativ — der Finger verdeckt den Punkt nie).
 *            Zusätzlich am PC: Pfeiltasten / WASD.
 *
 * PUNKTE:    Überlebenszeit in Millisekunden (real, tab-sicher gedeckelt).
 *            Solo-Bestwert in App.Storage('best_dodge').
 *
 * SYNC-MODELL (Multiplayer):
 *   Alle Geräte bekommen aus snapshot().round.startAt denselben Seed und
 *   erzeugen daraus DEN GLEICHEN Projektil-Ablauf (zwei getrennte, gesäte
 *   PRNG-Ströme für Kugeln bzw. Power-Ups, damit die Frame-Rate die Reihen-
 *   folge nicht verschiebt). Jeder steuert nur seinen eigenen Punkt lokal.
 *   Fortlaufend wird die überlebte Zeit per reportScore gemeldet (Live-
 *   Rangliste), der Lebend-Status per reportState({alive}). Die Runde endet,
 *   wenn alle raus sind oder nach 2 Minuten (App.MG.roundTimer, room.now).
 *
 * SOLO: Gegen drei Ausweich-Bots mit echter KI (fliehen vor nahen, auf sie
 *       zulaufenden Kugeln, meiden Wände, sammeln Power-Ups) — lebendiges
 *       Rennen. Die Runde endet, sobald DU getroffen wirst; gewertet wird
 *       deine überlebte Zeit gegen deinen Rekord.
 *
 * cleanup() beendet wirklich alles: rAF, Timer, Intervalle, Listener, room.off. */
(function () {
  'use strict';
  window.App = window.App || {}; App.Minigames = App.Minigames || {};
  var UI = App.UI, el = UI.el;

  /* ---- Virtuelles Spielfeld (Canvas skaliert per CSS) ---- */
  var W = 600, H = 600, TAU = Math.PI * 2;
  var PLAYER_R = 9;
  var ROUND_MS = 120000;          // 2 Minuten Hard-Cap im Multiplayer
  var KB_SPEED = 540;             // px/s Tastatursteuerung
  var DRAG_K = 1.35;             // Touch: Wisch-Verstärkung
  var SLOW_SCALE = 0.42;         // Zeitlupe: Faktor auf die Feldzeit
  var SHIELD_MS = 3500, SLOW_MS = 3800, PU_LIFE = 7000;
  var RAMP = 90000;              // ms bis fast maximale Schwierigkeit
  var SPAWN_MAX = 620, SPAWN_MIN = 150;   // ms Spawn-Intervall (Start → Ende)
  var SPD_MIN = 130, SPD_MAX = 340;       // px/s Kugelgeschwindigkeit

  /* Kugel-Typen (Neon-Palette + Geschwindigkeits-/Größen-Multiplikator) */
  var PAL = [
    { core: '#eaffe0', glow: 'rgba(57,255,20,0.95)', ring: 'rgba(57,255,20,0.55)', spdMul: 1.0, rMul: 1.0 },   // Neon-Grün
    { core: '#c9fff6', glow: 'rgba(51,230,208,0.95)', ring: 'rgba(51,230,208,0.55)', spdMul: 1.05, rMul: 0.95 },// Aqua
    { core: '#fff0c2', glow: 'rgba(255,210,63,0.98)', ring: 'rgba(255,210,63,0.6)', spdMul: 1.4, rMul: 0.8 },   // Gold (schnell)
    { core: '#ffd7de', glow: 'rgba(255,77,109,0.98)', ring: 'rgba(255,77,109,0.6)', spdMul: 0.82, rMul: 1.5 }   // Rot (dick)
  ];

  injectStyle();

  App.Minigames.dodge = {
    id: 'dodge', title: 'Kugelhagel', icon: '🌀', order: 140,
    subtitle: 'Weiche aus und überlebe am längsten!',
    single: true, multi: true, minPlayers: 2, maxPlayers: 8,

    render: function (root, ctx) {
      var isMulti = ctx.mode === 'multi';
      var nowFn = isMulti ? ctx.room.now : function () { return Date.now(); };

      /* ---- Laufzeit ---- */
      var dead = false;              // cleanup passiert -> gar nichts mehr tun
      var ended = false;             // Endscreen sichtbar / Loop stoppen
      var raf = null;
      var stops = [];                // stop()-Funktionen (App.MG + room.off)
      var pending = [];              // laufende setTimeout-IDs
      var listeners = [];            // {t,ty,fn,opts}

      /* ---- Spielzustand ---- */
      var rngB = null, rngP = null;  // getrennte Ströme: Kugeln / Power-Ups
      var simT = 0, last = 0, curNow = 0;
      var spawnAt = 0, puAt = 0, puId = 0;
      var bullets = [], powerups = [], particles = [], bots = [];
      var hero = null;
      var heroNear = 1e9, lastGraze = 0, lastWave = 1;
      var finishScheduled = false;

      /* ---- Multiplayer ---- */
      var roundEndAt = 0, board = null;

      /* ---- Eingabe ---- */
      var keys = { up: false, down: false, left: false, right: false };

      /* ---- DOM ---- */
      var canvas = null, ctx2d = null, stageEl = null;
      var timeEl = null, waveEl = null, rightEl = null, puRowEl = null, soloBoardEl = null;

      /* ============== Hilfen: Timer/Listener/Aufräumen ============== */
      function after(ms, fn) { var t = setTimeout(function () { if (!dead) fn(); }, ms); pending.push(t); return t; }
      function clearPending() { pending.forEach(clearTimeout); pending = []; }
      function stopHelpers() { stops.forEach(function (f) { try { f(); } catch (e) {} }); stops = []; }
      function addL(target, type, fn, opts) { target.addEventListener(type, fn, opts); listeners.push({ t: target, ty: type, fn: fn, opts: opts }); }
      function removeAllListeners() { listeners.forEach(function (l) { try { l.t.removeEventListener(l.ty, l.fn, l.opts); } catch (e) {} }); listeners = []; }
      function cleanup() {
        dead = true;
        if (raf) { cancelAnimationFrame(raf); raf = null; }
        clearPending(); stopHelpers(); removeAllListeners();
      }

      function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
      function clampEntity(e) { e.x = clamp(e.x, e.r, W - e.r); e.y = clamp(e.y, e.r, H - e.r); }

      /* Zeit-Formatierung: <60s -> "12.4s", sonst m:ss */
      function fmtTime(ms) {
        ms = Math.max(0, Math.round(Number(ms) || 0));
        var s = ms / 1000;
        if (s < 60) return s.toFixed(1) + 's';
        var m = Math.floor(s / 60), r = Math.floor(s % 60);
        return m + ':' + (r < 10 ? '0' : '') + r;
      }

      /* Deterministischer PRNG (mulberry32) — gleicher Seed liefert gleiche Folge */
      function makeRng(seed) {
        var a = seed >>> 0;
        return function () {
          a |= 0; a = (a + 0x6D2B79F5) | 0;
          var t = Math.imul(a ^ (a >>> 15), 1 | a);
          t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
          return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
      }

      /* ===================== Start ===================== */
      if (isMulti) {
        var snap = ctx.room.snapshot() || {};
        var startAt = (snap.round && snap.round.startAt) || (ctx.room.now() + 3000);
        var seed = (Math.floor(startAt) >>> 0) || 1;
        stops.push(App.MG.countdown(root, startAt, function () { play(startAt, seed); }, ctx.room.now));
      } else {
        startSolo();
      }
      return { cleanup: cleanup };

      function startSolo() {
        ended = false;
        play(Date.now(), (Date.now() >>> 0) || 1);
      }

      /* ===================== Spiel-Aufbau ===================== */
      function play(startAt, seed) {
        clearPending(); stopHelpers();
        ended = false; finishScheduled = false;
        rngB = makeRng(seed);
        rngP = makeRng((seed ^ 0x9e3779b9) >>> 0);
        simT = 0; spawnAt = 0; puAt = 7000; puId = 0;
        bullets = []; powerups = []; particles = [];
        heroNear = 1e9; lastGraze = 0; lastWave = 1;
        hero = { name: (ctx.me && ctx.me.name) ? ctx.me.name : 'Du', col: '#eaffe0', x: W / 2, y: H * 0.72, r: PLAYER_R, alive: true, ms: 0, shieldUntil: 0, slowUntil: 0 };
        bots = isMulti ? [] : makeBots();
        roundEndAt = startAt + ROUND_MS;

        buildStage();
        setupCanvas();
        attachInput();

        if (isMulti) {
          board = App.MG.liveBoard(ctx.room, ctx.me.id, { format: fmtTime });
          stops.push(board.stop);
          root.querySelector('.dge-board-slot').appendChild(board.root);
          // Erst-Meldung + laufende Meldung der überlebten Zeit
          try { ctx.room.reportScore(0); ctx.room.reportState({ alive: true }); } catch (e) {}
          var repT = setInterval(function () {
            if (dead || ended) return;
            if (hero.alive) { try { ctx.room.reportScore(Math.round(hero.ms)); ctx.room.reportState({ alive: true }); } catch (e) {} }
          }, 350);
          stops.push(function () { clearInterval(repT); });
          // Harte 2-Minuten-Grenze (synchron über room.now)
          stops.push(App.MG.roundTimer(roundEndAt, function (leftS) {
            if (rightEl) { rightEl.textContent = App.MG.mmss(leftS); rightEl.classList.toggle('dge-urgent', leftS <= 10); }
          }, function () { finishMulti(); }, ctx.room.now));
        }

        if (App.Audio) App.Audio.sfx('start');
        last = nowFn();
        raf = requestAnimationFrame(frame);
      }

      function makeBots() {
        var defs = [
          { name: 'Grünschnabel', col: '#9dff7a', speed: 200, react: 122, skill: 0.55 },
          { name: 'Ranger', col: '#33e6d0', speed: 240, react: 152, skill: 0.8 },
          { name: 'Panther', col: '#ffd23f', speed: 272, react: 178, skill: 0.98 }
        ];
        return defs.map(function (d, i) {
          return { name: d.name, col: d.col, speed: d.speed, react: d.react, skill: d.skill,
            x: W * (0.28 + 0.22 * i), y: H * 0.32, r: PLAYER_R, alive: true, ms: 0, shieldUntil: 0, slowUntil: 0 };
        });
      }

      /* ===================== Frame-Loop ===================== */
      function frame() {
        if (dead) { raf = null; return; }
        var now = nowFn();
        var rawDt = (now - last) / 1000; last = now;
        if (rawDt < 0) rawDt = 0; if (rawDt > 0.05) rawDt = 0.05;   // Tab-Rückkehr deckeln
        curNow = now;

        var heroSlow = hero.alive && hero.slowUntil > now;
        var scale = heroSlow ? SLOW_SCALE : 1;
        var effDt = rawDt * scale;
        simT += effDt * 1000;

        /* Tastatur (in Echtzeit, unabhängig von der Zeitlupe) */
        if (hero.alive) {
          var kx = (keys.right ? 1 : 0) - (keys.left ? 1 : 0);
          var ky = (keys.down ? 1 : 0) - (keys.up ? 1 : 0);
          if (kx || ky) { var kl = Math.hypot(kx, ky) || 1; hero.x += kx / kl * KB_SPEED * rawDt; hero.y += ky / kl * KB_SPEED * rawDt; clampEntity(hero); }
          hero.ms += rawDt * 1000;
        }

        /* Deterministisches Spawnen (Reihenfolge frame-unabhängig) */
        var guard = 0;
        while (simT >= spawnAt && guard < 400) { doSpawn(spawnAt); spawnAt += bulletInterval(spawnAt); guard++; }
        guard = 0;
        while (simT >= puAt && guard < 40) { spawnPowerup(puAt); puAt += 8000 + rngP() * 6000; guard++; }

        /* Kugel-Positionen (analytisch) + Culling */
        var keep = [], i;
        for (i = 0; i < bullets.length; i++) {
          var b = bullets[i], e = (simT - b.t0) / 1000;
          b.cx = b.x0 + b.vx * e; b.cy = b.y0 + b.vy * e;
          if (b.cx > -60 && b.cx < W + 60 && b.cy > -60 && b.cy < H + 60) keep.push(b);
        }
        bullets = keep;
        if (bullets.length > 260) bullets.splice(0, bullets.length - 260);

        /* Power-Up-Positionen + Ablauf */
        var pk = [];
        for (i = 0; i < powerups.length; i++) {
          var p = powerups[i], pe = (simT - p.t0) / 1000;
          p.cx = clamp(p.x0 + p.vx * pe, 30, W - 30);
          p.cy = clamp(p.y0 + p.vy * pe, 30, H - 30);
          if (simT - p.t0 < PU_LIFE) pk.push(p);
        }
        powerups = pk;

        /* Bots (nur Solo) */
        for (i = 0; i < bots.length; i++) updateBot(bots[i], effDt, rawDt, now);

        /* Kollisionen + Aufsammeln */
        handleEntity(hero, now, true);
        for (i = 0; i < bots.length; i++) handleEntity(bots[i], now, false);

        /* Beinahe-Feedback (Glühen + zarter Ton) für den Helden */
        if (hero.alive) {
          var nd = 1e9;
          for (i = 0; i < bullets.length; i++) { var bb = bullets[i]; var d = Math.hypot(hero.x - bb.cx, hero.y - bb.cy) - bb.r; if (d < nd) nd = d; }
          heroNear = nd;
          if (nd < 16 && hero.shieldUntil <= now && now - lastGraze > 150) { lastGraze = now; if (App.Audio) App.Audio.blip(1600, 0.03, { type: 'square', peak: 0.04 }); }
        }

        updateParticles(rawDt);
        drawScene();
        updateHud();

        /* Runden-Ende (Multi): alle raus? */
        if (isMulti && !ended && !finishScheduled && allOut()) { finishScheduled = true; after(800, finishMulti); }

        if (!ended) raf = requestAnimationFrame(frame);
      }

      /* ===================== Spawn-Logik ===================== */
      function bulletInterval(t) {
        var f = Math.max(0, 1 - t / RAMP);
        var base = SPAWN_MIN + (SPAWN_MAX - SPAWN_MIN) * f;
        return base * (0.7 + rngB() * 0.6);
      }
      function bulletSpeed(t) { var f = Math.min(1, t / RAMP); return SPD_MIN + (SPD_MAX - SPD_MIN) * f; }
      function edgeOrigin(edge) {
        if (edge === 0) return { x: rngB() * W, y: -10 };
        if (edge === 1) return { x: W + 10, y: rngB() * H };
        if (edge === 2) return { x: rngB() * W, y: H + 10 };
        return { x: -10, y: rngB() * H };
      }
      function pickType() {
        var r = rngB();
        return r < 0.42 ? PAL[0] : (r < 0.72 ? PAL[1] : (r < 0.88 ? PAL[2] : PAL[3]));
      }
      function doSpawn(t0) {
        if (t0 > 9000 && rngB() < 0.16) spawnFan(t0); else spawnBullet(t0);
      }
      function spawnBullet(t0) {
        var typ = pickType();
        var o = edgeOrigin(Math.floor(rngB() * 4));
        var tx = W * (0.22 + rngB() * 0.56), ty = H * (0.22 + rngB() * 0.56);
        var ang = Math.atan2(ty - o.y, tx - o.x);
        var spd = bulletSpeed(t0) * (0.85 + rngB() * 0.5) * typ.spdMul;
        var r = (6 + rngB() * 3) * typ.rMul;
        bullets.push({ x0: o.x, y0: o.y, vx: Math.cos(ang) * spd, vy: Math.sin(ang) * spd, t0: t0, r: r, c: typ });
      }
      function spawnFan(t0) {
        var o = edgeOrigin(Math.floor(rngB() * 4));
        var tx = W * (0.3 + rngB() * 0.4), ty = H * (0.3 + rngB() * 0.4);
        var base = Math.atan2(ty - o.y, tx - o.x);
        var n = 3 + Math.floor(rngB() * 3);          // 3..5 Kugeln
        var spread = 0.32 + rngB() * 0.3;
        var spd = bulletSpeed(t0) * (0.8 + rngB() * 0.35);
        var typ = PAL[2];
        var half = (n - 1) / 2;
        for (var k = 0; k < n; k++) {
          var a = base + (half === 0 ? 0 : ((k - half) / half) * spread);
          bullets.push({ x0: o.x, y0: o.y, vx: Math.cos(a) * spd, vy: Math.sin(a) * spd, t0: t0, r: 6, c: typ });
        }
      }
      function spawnPowerup(t0) {
        var type = rngP() < 0.5 ? 'shield' : 'slow';
        var px = W * (0.18 + rngP() * 0.64), py = H * (0.18 + rngP() * 0.64);
        var ang = rngP() * TAU, spd = 16 + rngP() * 22;
        powerups.push({ id: puId++, x0: px, y0: py, vx: Math.cos(ang) * spd, vy: Math.sin(ang) * spd, t0: t0, type: type, cx: px, cy: py });
      }

      /* ===================== Bots (Solo) ===================== */
      function updateBot(bot, effDt, rawDt, now) {
        if (!bot.alive) return;
        bot.ms += rawDt * 1000;
        var ax = 0, ay = 0, i;
        var react = bot.react, immune = bot.shieldUntil > now;
        for (i = 0; i < bullets.length; i++) {
          var b = bullets[i];
          var lead = 0.18 * (1 + bot.skill);
          var bx = b.cx + b.vx * lead, by = b.cy + b.vy * lead;
          var dx = bot.x - bx, dy = bot.y - by, d2 = dx * dx + dy * dy;
          if (d2 < react * react && d2 > 0.001) {
            var appr = b.vx * dx + b.vy * dy;            // positiv: Kugel läuft auf den Bot zu
            if (appr > 0 || immune === false) {
              var d = Math.sqrt(d2), w = (1 - d / react); w = w * w * (0.6 + bot.skill);
              ax += dx / d * w; ay += dy / d * w;
            }
          }
        }
        // Wand-Abstoßung + sanfter Zug zur Mitte
        var m = 90;
        if (bot.x < m) ax += (m - bot.x) / m * 1.2; if (bot.x > W - m) ax -= (bot.x - (W - m)) / m * 1.2;
        if (bot.y < m) ay += (m - bot.y) / m * 1.2; if (bot.y > H - m) ay -= (bot.y - (H - m)) / m * 1.2;
        ax += (W / 2 - bot.x) / (W / 2) * 0.14; ay += (H / 2 - bot.y) / (H / 2) * 0.14;
        // Nächstes Power-Up ansteuern
        if (powerups.length) {
          var np = null, nd = 1e9;
          for (i = 0; i < powerups.length; i++) { var pu = powerups[i]; var qx = pu.cx - bot.x, qy = pu.cy - bot.y, q = qx * qx + qy * qy; if (q < nd) { nd = q; np = pu; } }
          if (np && nd < 200 * 200) { var pd = Math.sqrt(nd) || 1; ax += (np.cx - bot.x) / pd * 0.5 * bot.skill; ay += (np.cy - bot.y) / pd * 0.5 * bot.skill; }
        }
        ax += (Math.random() - 0.5) * 0.25; ay += (Math.random() - 0.5) * 0.25;
        var mag = Math.hypot(ax, ay);
        if (mag > 0.001) { bot.x += ax / mag * bot.speed * effDt; bot.y += ay / mag * bot.speed * effDt; }
        clampEntity(bot);
      }

      /* ===================== Kollision / Aufsammeln ===================== */
      function handleEntity(ent, now, isHero) {
        if (!ent.alive) return;
        var i, immune = ent.shieldUntil > now;
        for (i = powerups.length - 1; i >= 0; i--) {
          var p = powerups[i], dx = ent.x - p.cx, dy = ent.y - p.cy, rr = ent.r + 20;
          if (dx * dx + dy * dy < rr * rr) { grantPowerup(ent, p, isHero, now); powerups.splice(i, 1); }
        }
        if (!immune) {
          for (i = 0; i < bullets.length; i++) {
            var b = bullets[i], ddx = ent.x - b.cx, ddy = ent.y - b.cy, hr = ent.r + b.r - 2;
            if (ddx * ddx + ddy * ddy < hr * hr) { killEntity(ent, isHero, now); break; }
          }
        }
      }
      function grantPowerup(ent, p, isHero, now) {
        if (p.type === 'shield') { ent.shieldUntil = now + SHIELD_MS; }
        else { if (isHero) ent.slowUntil = now + SLOW_MS; else ent.shieldUntil = now + SHIELD_MS; }
        spawnParticles(p.cx, p.cy, p.type === 'shield' ? 'rgba(255,210,63,0.9)' : 'rgba(51,230,208,0.9)', 12, 40, 160);
        if (isHero && App.Audio) App.Audio.sfx(p.type === 'shield' ? 'ding' : 'powerup');
      }
      function killEntity(ent, isHero, now) {
        ent.alive = false;
        spawnParticles(ent.x, ent.y, isHero ? 'rgba(57,255,20,0.95)' : ent.col, 18, 70, 230);
        if (isHero) onHeroDeath(now);
        else if (App.Audio) App.Audio.blip(180, 0.12, { type: 'sine', peak: 0.06 });
      }
      function onHeroDeath(now) {
        if (App.Audio) App.Audio.sfx('explosion');
        if (isMulti) {
          try { ctx.room.reportScore(Math.round(hero.ms)); ctx.room.reportState({ alive: false }); } catch (e) {}
          showDeadBanner();
        } else {
          after(850, soloEnd);
        }
      }

      /* ===================== Partikel ===================== */
      function spawnParticles(x, y, col, n, smin, smax) {
        for (var i = 0; i < n; i++) {
          var a = Math.random() * TAU, s = smin + Math.random() * (smax - smin);
          particles.push({ x: x, y: y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, born: curNow, life: 380 + Math.random() * 420, col: col });
        }
      }
      function updateParticles(rawDt) {
        var k = [];
        for (var i = 0; i < particles.length; i++) {
          var p = particles[i];
          p.x += p.vx * rawDt; p.y += p.vy * rawDt; p.vx *= 0.92; p.vy *= 0.92;
          if (curNow - p.born < p.life) k.push(p);
        }
        particles = k;
      }

      /* ===================== Runden-Ende (Multi) ===================== */
      function allOut() {
        var ps = ctx.room.players();
        if (!ps.length) return true;
        for (var i = 0; i < ps.length; i++) {
          var st = ps[i].state;
          if (!(st && st.alive === false)) return false;   // fehlend/lebend -> noch nicht vorbei
        }
        return true;
      }
      function finishMulti() {
        if (ended || dead) return;
        ended = true;
        if (raf) { cancelAnimationFrame(raf); raf = null; }
        stopHelpers();
        try { ctx.room.reportScore(Math.round(hero.ms)); ctx.room.reportState({ alive: false }); } catch (e) {}
        after(700, function () {
          App.MG.endScreen(root, { players: ctx.room.players(), meId: ctx.me.id, onExit: ctx.onExit, format: fmtTime });
        });
      }

      /* ===================== Ende (Solo) ===================== */
      function soloEnd() {
        if (ended || dead) return;
        ended = true;
        if (raf) { cancelAnimationFrame(raf); raf = null; }
        var score = Math.round(hero.ms);
        var best = App.Storage.get('best_dodge', 0);
        var nb = score > best;
        if (nb) App.Storage.set('best_dodge', score);
        // Platz gegen die Bots (kleine Zugabe im Label)
        var all = [{ name: 'Du', ms: hero.ms }];
        for (var i = 0; i < bots.length; i++) all.push({ name: bots[i].name, ms: bots[i].ms });
        all.sort(function (a, b) { return b.ms - a.ms; });
        var rank = 1; for (i = 0; i < all.length; i++) { if (all[i].name === 'Du') { rank = i + 1; break; } }
        App.MG.endScreen(root, {
          score: score, best: best, newBest: nb, format: fmtTime,
          label: 'Überlebt · Platz ' + rank + ' / ' + all.length + (nb ? ' · neuer Rekord! 🎉' : ' · Rekord: ' + fmtTime(best)),
          onExit: ctx.onExit,
          onAgain: function () { startSolo(); }
        });
      }

      /* ===================== Rendering ===================== */
      function setupCanvas() { ctx2d = canvas.getContext('2d'); }
      function drawScene() {
        var g = ctx2d; if (!g) return;
        g.clearRect(0, 0, W, H);
        var grd = g.createRadialGradient(W / 2, H * 0.42, 60, W / 2, H / 2, H * 0.78);
        grd.addColorStop(0, '#0a2416'); grd.addColorStop(1, '#03100a');
        g.fillStyle = grd; g.fillRect(0, 0, W, H);
        // feines Raster
        g.save(); g.strokeStyle = 'rgba(57,255,20,0.06)'; g.lineWidth = 1;
        for (var gx = 60; gx < W; gx += 60) { g.beginPath(); g.moveTo(gx, 0); g.lineTo(gx, H); g.stroke(); }
        for (var gy = 60; gy < H; gy += 60) { g.beginPath(); g.moveTo(0, gy); g.lineTo(W, gy); g.stroke(); }
        g.restore();

        var i;
        // Power-Ups
        for (i = 0; i < powerups.length; i++) drawPowerup(g, powerups[i]);
        // Kugeln (Streifen + Leucht-Kern)
        for (i = 0; i < bullets.length; i++) {
          var b = bullets[i];
          g.save(); g.globalAlpha = 0.5; g.strokeStyle = b.c.ring; g.lineWidth = b.r * 0.9; g.lineCap = 'round';
          g.beginPath(); g.moveTo(b.cx - b.vx * 0.05, b.cy - b.vy * 0.05); g.lineTo(b.cx, b.cy); g.stroke(); g.restore();
          g.save(); g.shadowColor = b.c.glow; g.shadowBlur = 14; g.fillStyle = b.c.core;
          g.beginPath(); g.arc(b.cx, b.cy, b.r, 0, TAU); g.fill(); g.restore();
        }
        // Partikel
        for (i = 0; i < particles.length; i++) {
          var pt = particles[i], a = 1 - (curNow - pt.born) / pt.life;
          g.save(); g.globalAlpha = Math.max(0, a) * 0.9; g.fillStyle = pt.col;
          g.beginPath(); g.arc(pt.x, pt.y, 2.5 + a * 2.5, 0, TAU); g.fill(); g.restore();
        }
        // Bots
        for (i = 0; i < bots.length; i++) drawBot(g, bots[i]);
        // Held
        drawHero(g);
      }
      function drawPowerup(g, p) {
        var rem = PU_LIFE - (simT - p.t0);
        if (rem < 1200 && Math.floor(curNow / 120) % 2 === 0) return;   // vor Ablauf blinken
        var pulse = 0.5 + 0.5 * Math.sin(curNow / 220 + p.id);
        var col = p.type === 'shield' ? 'rgba(255,210,63,0.95)' : 'rgba(51,230,208,0.95)';
        g.save(); g.shadowColor = col; g.shadowBlur = 18; g.strokeStyle = col; g.lineWidth = 3;
        g.beginPath(); g.arc(p.cx, p.cy, 16 + pulse * 3, 0, TAU); g.stroke(); g.restore();
        g.save(); g.font = '20px system-ui,"Segoe UI",sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillText(p.type === 'shield' ? '🛡️' : '🐢', p.cx, p.cy + 1); g.restore();
      }
      function drawBot(g, bot) {
        if (!bot.alive) return;
        g.save(); g.globalAlpha = 0.95; g.shadowColor = bot.col; g.shadowBlur = 10; g.fillStyle = bot.col;
        g.beginPath(); g.arc(bot.x, bot.y, bot.r, 0, TAU); g.fill();
        if (bot.shieldUntil > curNow) { g.strokeStyle = 'rgba(255,210,63,0.9)'; g.lineWidth = 2.5; g.beginPath(); g.arc(bot.x, bot.y, bot.r + 5, 0, TAU); g.stroke(); }
        g.restore();
      }
      function drawHero(g) {
        if (!hero.alive) return;
        var immune = hero.shieldUntil > curNow, slow = hero.slowUntil > curNow;
        if (slow) { g.save(); g.globalAlpha = 0.22; g.fillStyle = 'rgba(51,230,208,0.6)'; g.beginPath(); g.arc(hero.x, hero.y, 26 + Math.sin(curNow / 120) * 3, 0, TAU); g.fill(); g.restore(); }
        var gl = 1 - Math.min(1, Math.max(0, (heroNear - 8)) / 60);   // 0..1 Nähe zur nächsten Kugel
        g.save(); g.shadowColor = 'rgba(57,255,20,0.95)'; g.shadowBlur = 14 + gl * 22; g.fillStyle = '#eaffe0';
        g.beginPath(); g.arc(hero.x, hero.y, hero.r, 0, TAU); g.fill(); g.restore();
        g.save(); g.strokeStyle = gl > 0.5 ? 'rgba(255,77,109,0.9)' : 'rgba(57,255,20,0.85)'; g.lineWidth = 2;
        g.beginPath(); g.arc(hero.x, hero.y, hero.r + 3, 0, TAU); g.stroke(); g.restore();
        if (immune) { var rot = curNow / 300; g.save(); g.strokeStyle = 'rgba(255,210,63,0.95)'; g.lineWidth = 3; g.setLineDash([6, 6]); g.beginPath(); g.arc(hero.x, hero.y, hero.r + 9, rot, rot + TAU); g.stroke(); g.restore(); }
      }

      /* ===================== HUD ===================== */
      function updateHud() {
        if (timeEl) timeEl.textContent = fmtTime(hero.ms);
        var wave = Math.floor(simT / 14000) + 1;
        if (wave !== lastWave) { lastWave = wave; if (App.Audio) App.Audio.blip(760 + wave * 40, 0.06, { type: 'triangle', peak: 0.06 }); }
        if (waveEl) waveEl.textContent = 'Welle ' + wave;
        // Power-Up-Status-Chips
        if (puRowEl) {
          var chips = '';
          if (hero.shieldUntil > curNow) chips += chip('🛡️', ((hero.shieldUntil - curNow) / 1000).toFixed(1) + 's', 'dge-chip-shield');
          if (hero.slowUntil > curNow) chips += chip('🐢', ((hero.slowUntil - curNow) / 1000).toFixed(1) + 's', 'dge-chip-slow');
          if (puRowEl.innerHTML !== chips) puRowEl.innerHTML = chips;
        }
        // Solo-Rangliste (gedrosselt)
        if (soloBoardEl && curNow - (soloBoardEl._t || 0) > 200) { soloBoardEl._t = curNow; renderSoloBoard(); }
      }
      function chip(icon, txt, cls) {
        return '<span class="dge-chip ' + cls + '"><span class="dge-chip-i">' + icon + '</span>' + txt + '</span>';
      }
      function renderSoloBoard() {
        var rows = [{ name: 'Du', ms: hero.ms, alive: hero.alive, me: true, col: '#eaffe0' }];
        for (var i = 0; i < bots.length; i++) rows.push({ name: bots[i].name, ms: bots[i].ms, alive: bots[i].alive, me: false, col: bots[i].col });
        rows.sort(function (a, b) { return b.ms - a.ms; });
        var html = '';
        for (i = 0; i < rows.length; i++) {
          var r = rows[i];
          html += '<div class="mg-sb-row' + (r.me ? ' me' : '') + (r.alive ? '' : ' dge-out') + '">' +
            '<span class="mg-sb-rank">' + (i + 1) + '</span>' +
            '<span class="mg-sb-name"><span class="dge-dot" style="background:' + r.col + '"></span>' + r.name + (r.me ? ' (du)' : '') + (r.alive ? '' : ' 💥') + '</span>' +
            '<span class="mg-sb-score">' + fmtTime(r.ms) + '</span></div>';
        }
        soloBoardEl.innerHTML = html;
      }

      /* ===================== DOM-Aufbau ===================== */
      function buildStage() {
        timeEl = el('div', { class: 'dge-big dge-time' }, ['0.0s']);
        waveEl = el('div', { class: 'dge-big dge-wave' }, ['Welle 1']);
        rightEl = isMulti ? el('div', { class: 'mg-timer dge-timer' }, ['2:00'])
          : el('div', { class: 'dge-big dge-best' }, [fmtTime(App.Storage.get('best_dodge', 0))]);
        var head = el('div', { class: 'dge-head glass' }, [
          el('div', { class: 'dge-cell' }, [el('span', { class: 'dge-l' }, ['Zeit']), timeEl]),
          el('div', { class: 'dge-cell dge-cell-mid' }, [el('span', { class: 'dge-l' }, ['Stufe']), waveEl]),
          el('div', { class: 'dge-cell dge-cell-r' }, [el('span', { class: 'dge-l' }, [isMulti ? 'Rest' : 'Rekord']), rightEl])
        ]);

        canvas = el('canvas', { class: 'dge-canvas', width: W, height: H });
        stageEl = el('div', { class: 'dge-stage' }, [canvas]);

        puRowEl = el('div', { class: 'dge-pu-row' });
        var hint = el('div', { class: 'dge-hint hint-text' }, ['Maus/Finger ziehen zum Ausweichen · 🛡️ Schild · 🐢 Zeitlupe einsammeln · ein Treffer = raus']);

        var kids = [head, stageEl, puRowEl, hint];
        if (isMulti) {
          kids.push(el('div', { class: 'dge-board-wrap glass' }, [
            el('div', { class: 'mg-field-title' }, ['🏆 Rangliste']),
            el('div', { class: 'dge-board-slot' })
          ]));
        } else {
          soloBoardEl = el('div', { class: 'mg-scoreboard dge-solo-board' });
          kids.push(el('div', { class: 'dge-board-wrap glass' }, [
            el('div', { class: 'mg-field-title' }, ['🏆 Ausweich-Rennen']), soloBoardEl
          ]));
        }
        root.innerHTML = '';
        root.appendChild(el('div', { class: 'dge-wrap' }, kids));
      }

      function showDeadBanner() {
        if (!stageEl) return;
        stageEl.classList.add('dge-dim');
        var overlay = el('div', { class: 'dge-dead' }, [
          el('div', { class: 'dge-dead-emoji' }, ['💥']),
          el('div', { class: 'dge-dead-t neon-strong' }, ['Erwischt!']),
          el('div', { class: 'dge-dead-s' }, ['Deine Zeit: ' + fmtTime(hero.ms)]),
          el('p', { class: 'hint-text' }, ['Warte auf die anderen …']),
          el('button', { class: 'btn btn-ghost', type: 'button', onclick: ctx.onExit }, ['Zur Lobby'])
        ]);
        stageEl.appendChild(overlay);
      }

      /* ===================== Eingabe ===================== */
      function toVirtual(clientX, clientY) {
        var r = canvas.getBoundingClientRect();
        return { x: (clientX - r.left) / r.width * W, y: (clientY - r.top) / r.height * H, sx: W / r.width, sy: H / r.height };
      }
      function attachInput() {
        var dragging = false, lastX = 0, lastY = 0;
        function onDown(e) {
          if (!hero || !hero.alive) return;
          dragging = true;
          var v = toVirtual(e.clientX, e.clientY);
          if ((e.pointerType || 'mouse') === 'touch') { lastX = v.x; lastY = v.y; }
          else { hero.x = v.x; hero.y = v.y; clampEntity(hero); }
          if (canvas.setPointerCapture && e.pointerId != null) { try { canvas.setPointerCapture(e.pointerId); } catch (er) {} }
          e.preventDefault();
        }
        function onMove(e) {
          if (!hero || !hero.alive) return;
          var v = toVirtual(e.clientX, e.clientY);
          if ((e.pointerType || 'mouse') === 'touch') {
            if (dragging) { hero.x += (v.x - lastX) * DRAG_K; hero.y += (v.y - lastY) * DRAG_K; lastX = v.x; lastY = v.y; clampEntity(hero); }
          } else { hero.x = v.x; hero.y = v.y; clampEntity(hero); }
          e.preventDefault();
        }
        function onUp() { dragging = false; }
        addL(canvas, 'pointerdown', onDown, { passive: false });
        addL(canvas, 'pointermove', onMove, { passive: false });
        addL(canvas, 'pointerup', onUp);
        addL(canvas, 'pointercancel', onUp);
        addL(canvas, 'pointerleave', onUp);

        function kd(e) {
          var k = e.key;
          if (k === 'ArrowUp' || k === 'w' || k === 'W') { keys.up = true; e.preventDefault(); }
          else if (k === 'ArrowDown' || k === 's' || k === 'S') { keys.down = true; e.preventDefault(); }
          else if (k === 'ArrowLeft' || k === 'a' || k === 'A') { keys.left = true; e.preventDefault(); }
          else if (k === 'ArrowRight' || k === 'd' || k === 'D') { keys.right = true; e.preventDefault(); }
        }
        function ku(e) {
          var k = e.key;
          if (k === 'ArrowUp' || k === 'w' || k === 'W') keys.up = false;
          else if (k === 'ArrowDown' || k === 's' || k === 'S') keys.down = false;
          else if (k === 'ArrowLeft' || k === 'a' || k === 'A') keys.left = false;
          else if (k === 'ArrowRight' || k === 'd' || k === 'D') keys.right = false;
        }
        addL(document, 'keydown', kd);
        addL(document, 'keyup', ku);
      }
    }
  };

  /* ===================== STYLES ===================== */
  function injectStyle() {
    UI.injectStyle('mg-dodge-css', [
      '.dge-wrap{display:flex;flex-direction:column;gap:12px;max-width:600px;margin:0 auto;}',
      '.dge-head{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:10px 16px;flex-wrap:wrap;}',
      '.dge-cell{display:flex;flex-direction:column;gap:2px;min-width:0;}',
      '.dge-cell-mid{text-align:center;}',
      '.dge-cell-r{text-align:right;}',
      '.dge-l{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:1px;}',
      '.dge-big{font-weight:900;line-height:1;font-variant-numeric:tabular-nums;font-size:clamp(20px,5.4vw,34px);}',
      '.dge-time{color:var(--neon);text-shadow:0 0 14px rgba(57,255,20,.5);}',
      '.dge-wave{color:var(--aqua);font-size:clamp(15px,4vw,22px);text-shadow:0 0 12px rgba(51,230,208,.4);}',
      '.dge-best{color:var(--gold);font-size:clamp(16px,4.4vw,24px);text-shadow:0 0 12px rgba(255,210,63,.4);}',
      '.dge-timer{font-size:clamp(18px,5vw,26px);}',
      '.dge-timer.dge-urgent{color:var(--danger);animation:dge-pulse .7s infinite;}',
      /* Spielfeld */
      '.dge-stage{position:relative;width:100%;max-width:min(560px,74vh);margin:0 auto;aspect-ratio:1/1;}',
      '.dge-canvas{display:block;width:100%;height:100%;border-radius:18px;',
      'border:2px solid rgba(57,255,20,.32);background:#04140c;',
      'box-shadow:0 0 42px rgba(57,255,20,.2),inset 0 0 60px rgba(57,255,20,.06);',
      'touch-action:none;user-select:none;-webkit-user-select:none;-webkit-tap-highlight-color:transparent;cursor:crosshair;transition:filter .3s;}',
      '.dge-stage.dge-dim .dge-canvas{filter:brightness(.55) saturate(.8);}',
      '.dge-hint{text-align:center;}',
      /* Power-Up-Chips */
      '.dge-pu-row{display:flex;gap:8px;justify-content:center;flex-wrap:wrap;min-height:26px;}',
      '.dge-chip{display:inline-flex;align-items:center;gap:6px;padding:4px 12px;border-radius:999px;font-weight:800;font-size:13px;font-variant-numeric:tabular-nums;border:1px solid var(--stroke);animation:dge-chip-in .2s ease;}',
      '.dge-chip-i{font-size:15px;}',
      '.dge-chip-shield{color:var(--gold);border-color:rgba(255,210,63,.5);background:rgba(40,32,6,.7);box-shadow:0 0 14px rgba(255,210,63,.3);}',
      '.dge-chip-slow{color:var(--aqua);border-color:rgba(51,230,208,.5);background:rgba(6,32,30,.7);box-shadow:0 0 14px rgba(51,230,208,.3);}',
      '@keyframes dge-chip-in{from{transform:scale(.7);opacity:0;}to{transform:scale(1);opacity:1;}}',
      /* Ranglisten */
      '.dge-board-wrap{padding:14px;display:flex;flex-direction:column;gap:8px;}',
      '.dge-board-wrap .mg-scoreboard,.dge-board-slot{max-height:260px;overflow-y:auto;display:flex;flex-direction:column;gap:6px;}',
      '.dge-solo-board .mg-sb-row.me{border-color:var(--neon);box-shadow:0 0 0 1px rgba(57,255,20,.3);}',
      '.dge-solo-board .mg-sb-row.dge-out{opacity:.5;}',
      '.dge-solo-board .mg-sb-name{display:flex;align-items:center;gap:8px;}',
      '.dge-dot{width:10px;height:10px;border-radius:50%;flex:0 0 auto;box-shadow:0 0 6px currentColor;}',
      /* Erwischt-Overlay */
      '.dge-dead{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;text-align:center;padding:20px;',
      'background:radial-gradient(circle at 50% 45%,rgba(255,77,109,.16),rgba(3,16,10,.7));border-radius:18px;animation:dge-dead-in .3s ease both;}',
      '.dge-dead-emoji{font-size:56px;line-height:1;filter:drop-shadow(0 0 14px rgba(255,77,109,.6));animation:dge-boom .5s ease;}',
      '.dge-dead-t{font-size:clamp(26px,7vw,40px);font-weight:900;}',
      '.dge-dead-s{font-size:clamp(16px,4.4vw,22px);font-weight:800;color:var(--gold);font-variant-numeric:tabular-nums;}',
      '.dge-dead .btn{margin-top:6px;}',
      /* Animationen */
      '@keyframes dge-pulse{0%,100%{opacity:1}50%{opacity:.4}}',
      '@keyframes dge-dead-in{from{opacity:0;transform:scale(.96);}to{opacity:1;transform:scale(1);}}',
      '@keyframes dge-boom{0%{transform:scale(.3);}60%{transform:scale(1.25);}100%{transform:scale(1);}}'
    ].join(''));
  }
})();
