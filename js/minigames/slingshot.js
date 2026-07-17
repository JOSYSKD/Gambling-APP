/* slingshot.js — "Schleuder-Angriff": Angry-Birds-Duell im Neon-Dschungel.
 *
 * IDEE      Links steht eine Schleuder, rechts ein Turm aus Holz-, Stein- und
 *           Glasblöcken mit Schweinchen (🐷) darin. Beide Spieler schießen
 *           abwechselnd auf DENSELBEN Turm. Wer das letzte Schweinchen holt,
 *           räumt das Level und kassiert den Bonus. 3 Level, wer danach mehr
 *           Punkte hat, gewinnt.
 * STEUERUNG Auf der Spielfläche ziehen (Maus ODER Finger — pointerdown/move/up),
 *           die Schleuder spannt sich, loslassen schießt. Je weiter gezogen,
 *           desto mehr Wumms. Eine gepunktete Linie zeigt die Flugbahn.
 * PUNKTE    Glas 15 · Holz 25 · Stein 40 · Schweinchen 300 · Level geräumt
 *           +200 und zusätzlich +120 pro NICHT verbrauchtem Schuss
 *           (wenige Geschosse = mehr Punkte). Munition: 6 Schuss pro Level
 *           für beide zusammen.
 * PHYSIK    Eigene Box-Physik mit fester Zeitscheibe (1/120 s): Schwerkraft,
 *           Stöße mit Impulsen, Reibung, Kipp-Nudge wenn ein Block über seine
 *           Auflage hinausragt -> Stapel fallen um. Alles nur +,-,*,/ und
 *           Math.sqrt -> Bit-gleich auf jedem Gerät.
 * SYNC      Rundenbasiert über room.shared. Der aktive Werfer schickt nur
 *           { seq, level, vx, vy } — beide rechnen daraus dieselbe Simulation
 *           und sehen denselben Einsturz. Danach schickt der Werfer zusätzlich
 *           den Endzustand (res: Positionen/HP/Punkte/Munition/Zug) als
 *           Autorität; der Gegner schnappt darauf ein (auch bei Neuladen /
 *           spätem Beitritt). Level-Wechsel schreiben beide identisch
 *           (idempotent). Timer/Countdown über room.now().
 * SOLO      Gegen einen Bot in 3 Stufen. Der Bot löst die Wurfparabel
 *           analytisch (flacher oder hoher Bogen) und streut je nach Stufe. */
(function () {
  'use strict';
  window.App = window.App || {}; App.Minigames = App.Minigames || {};
  var UI = App.UI, el = UI.el;

  injectStyle();

  /* ============ Welt-Konstanten (virtuelles Feld, Canvas skaliert per CSS) ============ */
  var W = 960, H = 540, GY = 470;          // Feldmaße + Bodenhöhe
  var AX = 138, AY = GY - 100;             // Ankerpunkt der Schleuder (Gummi-Mitte)
  var MAXPULL = 132, MAXV = 1060, G = 900; // max. Zug, max. Abschussgeschwindigkeit, Schwerkraft
  var STEP = 1 / 120, MAX_SIM = 11;        // feste Physik-Zeitscheibe, Not-Aus nach 11 s
  var AMMO = 6, LEVELS = 3;
  var PTS = { glas: 15, holz: 25, stein: 40, pig: 300 };
  var CLEAR_BONUS = 200, AMMO_BONUS = 120;
  var LEVEL_NAMES = ['Wachhütte', 'Steinturm', 'Festung'];

  /* Materialien: hp = Haltbarkeit, dens = Dichte, fac = Schadensanfälligkeit */
  var MAT = {
    glas: { hp: 22, dens: 0.5, fac: 2.2, fill: 'rgba(51,230,208,.26)', line: 'rgba(127,243,230,.92)', glow: 'rgba(51,230,208,.55)' },
    holz: { hp: 55, dens: 0.9, fac: 1.0, fill: 'rgba(157,255,122,.20)', line: 'rgba(157,255,122,.88)', glow: 'rgba(57,255,20,.45)' },
    stein: { hp: 130, dens: 2.4, fac: 0.6, fill: 'rgba(207,228,220,.18)', line: 'rgba(207,228,220,.82)', glow: 'rgba(207,228,220,.35)' },
    pig: { hp: 34, dens: 0.8, fac: 3.0, fill: 'rgba(255,210,63,.16)', line: 'rgba(255,210,63,.9)', glow: 'rgba(255,210,63,.6)' },
    ball: { hp: 9999, dens: 5.0, fac: 0, fill: '#eaffe0', line: '#eaffe0', glow: 'rgba(57,255,20,.95)' }
  };

  /* Bot-Stufen: aerr = Winkelstreuung (rad), verr = Kraftstreuung, jit = Zielversatz (px) */
  var BOT = {
    leicht: { aerr: 0.075, verr: 0.07, jit: 28, label: '🌱 Leicht', wait: 1200 },
    normal: { aerr: 0.034, verr: 0.03, jit: 13, label: '🌿 Normal', wait: 1000 },
    schwer: { aerr: 0.012, verr: 0.012, jit: 4, label: '🔥 Schwer', wait: 850 }
  };

  /* Deko-Lianen im Hintergrund (fest, damit alle dasselbe Bild sehen) */
  var VINES = [
    [60, -20, 96, 150, 44, 300], [250, -20, 210, 120, 268, 250],
    [430, -20, 480, 100, 418, 210], [700, -20, 748, 130, 690, 240],
    [905, -20, 940, 160, 900, 300]
  ];

  App.Minigames.slingshot = {
    id: 'slingshot', title: 'Schleuder-Angriff', icon: '🪃', order: 154,
    subtitle: 'Ziehen, zielen, Turm zum Einsturz bringen',
    single: true, multi: true, minPlayers: 2, maxPlayers: 2,

    render: function (root, ctx) {
      var isMulti = ctx.mode === 'multi';
      var MEID = isMulti ? ctx.me.id : 'me';

      /* ---- Laufzeit ---- */
      var dead = false, raf = null, pending = [], stops = [], listeners = [];
      var g2d = null, canvas = null, refs = null;
      var world = { level: -1, bodies: [], list: [], ball: null };
      var state = 'idle';             // idle | fly | wait | end
      var scores = {}, ammo = AMMO, turn = null, shooterId = null, shotPts = 0;
      var pA = null, pB = null, diff = 'normal';
      var simT = 0, calm = 0, acc = 0, lastFrame = 0, advanceDone = false;
      var dragging = false, px = 0, py = 0, pull = { dx: 0, dy: 0, len: 0 };
      var trail = [], parts = [], floats = [], shake = 0;
      /* ---- Multiplayer ---- */
      var lastShared = {}, initSent = false, started = false;
      var appliedSeq = 0, animSeq = 0, resAppliedSeq = -1, pendingRes = null;

      /* ============ Aufräumen ============ */
      function after(ms, fn) { var t = setTimeout(function () { if (!dead) fn(); }, ms); pending.push(t); return t; }
      function addL(t, ty, fn, o) { t.addEventListener(ty, fn, o); listeners.push({ t: t, ty: ty, fn: fn, o: o }); }
      function addStop(f) { if (f) stops.push(f); }
      function cleanup() {
        dead = true;
        if (raf) { cancelAnimationFrame(raf); raf = null; }
        pending.forEach(clearTimeout); pending = [];
        stops.forEach(function (f) { try { f(); } catch (e) {} }); stops = [];
        listeners.forEach(function (l) { try { l.t.removeEventListener(l.ty, l.fn, l.o); } catch (e) {} }); listeners = [];
      }

      if (isMulti) startMulti(); else showChooser();
      return { cleanup: cleanup };

      /* ==================================================================
       *  KÖRPER & LEVEL
       * ================================================================== */
      function mk(x, y, w, h, mat) {
        var m = MAT[mat];
        return {
          x: x, y: y, w: w, h: h, vx: 0, vy: 0, mat: mat,
          hp: m.hp, max: m.hp, alive: true, im: 1000 / (w * h * m.dens),
          sMin: 0, sMax: 0, sup: 0, grd: false
        };
      }
      /* Fest gebaute Türme -> jeder Spieler bekommt garantiert dasselbe Level. */
      function levelBodies(i) {
        var a = [];
        if (i === 0) {
          a.push(mk(640, 415, 22, 110, 'holz'));
          a.push(mk(760, 415, 22, 110, 'holz'));
          a.push(mk(700, 349, 170, 22, 'holz'));
          a.push(mk(700, 320, 36, 36, 'glas'));
          a.push(mk(700, 453, 34, 34, 'pig'));
        } else if (i === 1) {
          a.push(mk(620, 400, 26, 140, 'stein'));
          a.push(mk(800, 400, 26, 140, 'stein'));
          a.push(mk(710, 318, 210, 24, 'stein'));
          a.push(mk(665, 261, 20, 90, 'holz'));
          a.push(mk(755, 261, 20, 90, 'holz'));
          a.push(mk(710, 206, 130, 20, 'holz'));
          a.push(mk(560, 452, 36, 36, 'glas'));
          a.push(mk(870, 452, 36, 36, 'glas'));
          a.push(mk(710, 453, 34, 34, 'pig'));
          a.push(mk(710, 179, 34, 34, 'pig'));
        } else {
          a.push(mk(570, 395, 28, 150, 'stein'));
          a.push(mk(890, 395, 28, 150, 'stein'));
          a.push(mk(660, 415, 24, 110, 'glas'));
          a.push(mk(800, 415, 24, 110, 'glas'));
          a.push(mk(730, 349, 260, 22, 'holz'));
          a.push(mk(730, 308, 380, 24, 'stein'));
          a.push(mk(640, 278, 36, 36, 'glas'));
          a.push(mk(820, 278, 36, 36, 'glas'));
          a.push(mk(700, 453, 34, 34, 'pig'));
          a.push(mk(790, 453, 34, 34, 'pig'));
          a.push(mk(730, 279, 34, 34, 'pig'));
        }
        return a;
      }
      function rebuildList() { world.list = world.ball ? world.bodies.concat([world.ball]) : world.bodies.slice(); }
      function alivePigs() {
        var r = [], i;
        for (i = 0; i < world.bodies.length; i++) if (world.bodies[i].alive && world.bodies[i].mat === 'pig') r.push(world.bodies[i]);
        return r;
      }

      /* ==================================================================
       *  PHYSIK — deterministisch, feste Zeitscheibe
       * ================================================================== */
      function simStep(dt) {
        var list = world.list, i, b, it;
        for (i = 0; i < list.length; i++) {
          b = list[i]; if (!b.alive) continue;
          b.vy += G * dt;
          b.x += b.vx * dt;
          b.y += b.vy * dt;
          b.sMin = 1e9; b.sMax = -1e9; b.sup = 0; b.grd = false;
        }
        for (it = 0; it < 4; it++) { solveBounds(it === 0); solvePairs(it === 0); }
        /* Kippen: Schwerpunkt außerhalb der gesammelten Auflagefläche -> Nudge */
        for (i = 0; i < list.length; i++) {
          b = list[i];
          if (!b.alive || !b.sup || b.mat === 'ball') continue;
          if (b.x > b.sMax) b.vx += (40 + (b.x - b.sMax) * 3 > 150 ? 150 : 40 + (b.x - b.sMax) * 3) * dt;
          else if (b.x < b.sMin) b.vx -= (40 + (b.sMin - b.x) * 3 > 150 ? 150 : 40 + (b.sMin - b.x) * 3) * dt;
        }
        /* Ball weg? */
        var ball = world.ball;
        if (ball && (ball.x > W + 70 || ball.x < -70 || ball.y > H + 90)) { world.ball = null; rebuildList(); }
        if (ball && world.ball) { trail.push({ x: ball.x, y: ball.y }); if (trail.length > 20) trail.shift(); }
      }

      function solveBounds(first) {
        var list = world.list, i, b;
        for (i = 0; i < list.length; i++) {
          b = list[i]; if (!b.alive) continue;
          var hw = b.w / 2, hh = b.h / 2;
          if (b.mat !== 'ball') {                       // Seitenwände (Ball darf raus)
            if (b.x - hw < 4) { b.x = 4 + hw; if (b.vx < 0) b.vx = -b.vx * 0.2; }
            if (b.x + hw > W - 4) { b.x = W - 4 - hw; if (b.vx > 0) b.vx = -b.vx * 0.2; }
          }
          if (b.y + hh > GY) {
            var pen = b.y + hh - GY;
            b.y -= (pen > 0.3 ? pen - 0.3 : 0) * 0.9;
            if (b.vy > 0) {
              if (first) hurt(b, b.vy, false);
              b.vy = (b.vy > 60) ? -b.vy * 0.18 : 0;
            }
            b.grd = true; b.sup = 1;
            if (b.x - hw < b.sMin) b.sMin = b.x - hw;
            if (b.x + hw > b.sMax) b.sMax = b.x + hw;
            if (first) b.vx *= (b.mat === 'ball') ? 0.988 : 0.90;
          }
        }
      }

      function solvePairs(first) {
        var list = world.list, i, j;
        for (i = 0; i < list.length; i++) {
          var a = list[i]; if (!a.alive) continue;
          for (j = i + 1; j < list.length; j++) {
            var b = list[j]; if (!b.alive || !a.alive) continue;
            var dx = b.x - a.x, dy = b.y - a.y;
            var adx = dx < 0 ? -dx : dx, ady = dy < 0 ? -dy : dy;
            var ox = (a.w + b.w) / 2 - adx; if (ox <= 0) continue;
            var oy = (a.h + b.h) / 2 - ady; if (oy <= 0) continue;
            var nx, ny, pen;
            if (ox < oy) { nx = dx < 0 ? -1 : 1; ny = 0; pen = ox; }
            else { nx = 0; ny = dy < 0 ? -1 : 1; pen = oy; }
            var s = a.im + b.im; if (s <= 0) continue;
            var corr = (pen > 0.4 ? pen - 0.4 : 0) * 0.8 / s;
            a.x -= nx * corr * a.im; a.y -= ny * corr * a.im;
            b.x += nx * corr * b.im; b.y += ny * corr * b.im;

            var rvx = b.vx - a.vx, rvy = b.vy - a.vy;
            var rn = rvx * nx + rvy * ny;
            if (rn < 0) {
              var e = (rn > -50) ? 0 : 0.12;
              var jn = -(1 + e) * rn / s;
              a.vx -= jn * nx * a.im; a.vy -= jn * ny * a.im;
              b.vx += jn * nx * b.im; b.vy += jn * ny * b.im;
              if (first) {
                var tx = -ny, ty = nx;
                var rt = rvx * tx + rvy * ty;
                var jt = -rt * 0.30 / s;
                a.vx -= jt * tx * a.im; a.vy -= jt * ty * a.im;
                b.vx += jt * tx * b.im; b.vy += jt * ty * b.im;
                var byBall = (a.mat === 'ball' || b.mat === 'ball');
                hurt(a, -rn, byBall); hurt(b, -rn, byBall);
              }
            }
            /* Auflage merken (nur senkrechte Kontakte): n zeigt von a nach b */
            if (first && ny !== 0) {
              var up = ny > 0 ? a : b, lo = ny > 0 ? b : a;
              var loA = lo.x - lo.w / 2, loB = lo.x + lo.w / 2;
              var upA = up.x - up.w / 2, upB = up.x + up.w / 2;
              var cl = loA > upA ? loA : upA, ch = loB < upB ? loB : upB;
              if (ch > cl) {
                up.sup = 1;
                if (cl < up.sMin) up.sMin = cl;
                if (ch > up.sMax) up.sMax = ch;
              }
            }
          }
        }
      }

      /* Schaden: harte Einschläge zerlegen Material. Ball trifft härter. */
      function hurt(b, speed, byBall) {
        if (!b.alive) return;
        var m = MAT[b.mat]; if (!m.fac) return;
        var min = byBall ? 60 : 130, k = byBall ? 0.10 : 0.06;
        if (speed <= min) return;
        b.hp -= (speed - min) * k * m.fac;
        if (b.hp <= 0) destroy(b);
      }
      function destroy(b) {
        b.alive = false; b.hp = 0;
        shotPts += PTS[b.mat] || 0;
        burst(b);
        floater(b.x, b.y - 14, '+' + (PTS[b.mat] || 0), b.mat === 'pig' ? 'gold' : 'neon');
        if (shake < 12) shake = b.mat === 'pig' ? 12 : 8;
        if (App.Audio) {
          if (b.mat === 'pig') App.Audio.sfx('explosion');
          else if (b.mat === 'glas') App.Audio.sfx('pop');
          else if (b.mat === 'stein') App.Audio.sfx('hit');
          else App.Audio.blip(180, 0.09);
        }
      }

      function checkSettle() {
        var list = world.list, i, mx = 0;
        for (i = 0; i < list.length; i++) {
          var b = list[i]; if (!b.alive) continue;
          var s = (b.vx < 0 ? -b.vx : b.vx) + (b.vy < 0 ? -b.vy : b.vy);
          if (s > mx) mx = s;
        }
        if (mx < 14) calm += STEP; else calm = 0;
        if (calm > 0.4 || simT > MAX_SIM) finishShot();
      }

      /* ==================================================================
       *  SPIELFLUSS
       * ================================================================== */
      function loadLevel(idx) {
        world.level = idx; world.bodies = levelBodies(idx); world.ball = null; rebuildList();
        ammo = AMMO; turn = (idx % 2 === 0) ? pA.id : pB.id;
        state = 'idle'; advanceDone = false; dragging = false;
        parts = []; floats = []; trail = []; shake = 0; shotPts = 0;
        if (isMulti) { appliedSeq = lastShared.seq || 0; animSeq = appliedSeq; resAppliedSeq = -1; pendingRes = null; }
        if (App.Audio) App.Audio.sfx('start');
        updateHud();
        maybeBot();
      }

      function beginShot(vx, vy, by) {
        shooterId = by; shotPts = 0; simT = 0; calm = 0; acc = 0; trail = [];
        world.ball = mk(AX, AY, 24, 24, 'ball');
        world.ball.vx = vx; world.ball.vy = vy;
        rebuildList();
        state = 'fly'; dragging = false;
        if (App.Audio) App.Audio.sfx('whoosh');
        updateHud();
      }

      function finishShot() {
        world.ball = null; rebuildList();
        state = 'wait';
        var by = shooterId;
        scores[by] = (scores[by] || 0) + shotPts;
        ammo--;
        var cleared = alivePigs().length === 0;
        if (cleared) {
          var bonus = CLEAR_BONUS + AMMO_BONUS * (ammo > 0 ? ammo : 0);
          scores[by] = (scores[by] || 0) + bonus;
          floater(W / 2, 190, '+' + bonus + ' Räum-Bonus', 'gold');
          if (App.Audio) App.Audio.sfx('jackpot');
        }
        turn = (by === pA.id) ? pB.id : pA.id;
        appliedSeq = animSeq;
        reportMine();
        if (isMulti && by === MEID) publishRes(cleared);
        if (isMulti && pendingRes && pendingRes.seq === animSeq) { var pr = pendingRes; pendingRes = null; applyRes(pr); return; }
        if (cleared || ammo <= 0) scheduleAdvance(cleared);
        else { state = 'idle'; updateHud(); maybeBot(); }
      }

      function scheduleAdvance(cleared) {
        state = 'wait';
        setStatus(cleared ? 'Level geräumt! 🎉' : 'Munition leer — die Schweinchen halten durch', cleared ? 'win' : 'lose');
        updateHud(true);
        if (advanceDone) return;
        advanceDone = true;
        var lvl = world.level;
        after(2000, function () {
          if (world.level !== lvl) return;
          if (lvl + 1 < LEVELS) {
            if (isMulti) { try { ctx.room.setShared({ level: lvl + 1 }); } catch (e) {} }
            else loadLevel(lvl + 1);
          } else {
            if (isMulti) { try { ctx.room.setShared({ over: 1 }); } catch (e) {} }
            else showEndSolo();
          }
        });
      }

      function canShoot() { return !dead && state === 'idle' && world.level >= 0 && turn === MEID; }

      function fire(vx, vy) {
        vx = Math.round(vx * 100) / 100; vy = Math.round(vy * 100) / 100;
        if (isMulti) {
          var seq = (lastShared.seq || 0) + 1;
          animSeq = seq;
          try { ctx.room.setShared({ seq: seq, shot: { seq: seq, by: MEID, vx: vx, vy: vy, level: world.level } }); } catch (e) {}
        }
        beginShot(vx, vy, MEID);
      }

      /* ==================================================================
       *  SOLO
       * ================================================================== */
      function showChooser() {
        var best = App.Storage.get('best_slingshot', 0);
        var row = el('div', { class: 'sls-diff-row' }, ['leicht', 'normal', 'schwer'].map(function (k) {
          return el('button', {
            class: 'btn ' + (k === 'normal' ? 'btn-primary' : k === 'schwer' ? 'btn-danger' : 'btn-aqua'),
            type: 'button',
            onclick: function () { if (App.Audio) App.Audio.sfx('select'); startSolo(k); }
          }, [BOT[k].label]);
        }));
        root.innerHTML = '';
        root.appendChild(el('div', { class: 'glass sls-panel' }, [
          el('div', { class: 'sls-panel-icon' }, ['🪃']),
          el('h2', { class: 'neon' }, ['Schleuder-Angriff']),
          el('p', { class: 'hint-text' }, ['Ziehen, zielen, loslassen — hol die 🐷 von ihrem Turm. Du und der Bot schießt abwechselnd auf denselben Turm, 6 Schuss pro Level, 3 Level. Wer räumt, kassiert den Bonus.']),
          el('div', { class: 'sls-panel-l' }, ['Gegner wählen']),
          row,
          el('p', { class: 'hint-text' }, ['🏆 Bestwert: ' + App.MG.fmt(best) + ' Punkte']),
          el('div', { class: 'controls-row' }, [
            el('button', { class: 'btn btn-ghost', type: 'button', onclick: ctx.onExit }, ['Zurück'])
          ])
        ]));
      }

      function startSolo(d) {
        diff = d;
        pending.forEach(clearTimeout); pending = [];
        pA = { id: 'me', name: (ctx.me && ctx.me.name) ? ctx.me.name : 'Du' };
        pB = { id: 'bot', name: 'Bot ' + BOT[d].label.slice(2) };
        scores = {}; scores.me = 0; scores.bot = 0;
        state = 'idle';
        buildStage();
        loadLevel(0);
        startLoop();
      }

      function maybeBot() {
        if (isMulti || dead) return;
        if (turn !== pB.id || state !== 'idle') return;
        after(BOT[diff].wait, botShoot);
      }

      /* Der Bot löst die Wurfparabel analytisch und streut je nach Stufe. */
      function botShoot() {
        if (dead || isMulti || state !== 'idle' || turn !== pB.id) return;
        var cfg = BOT[diff];
        var pigs = alivePigs(), aim = null, i;
        if (pigs.length) aim = pigs[Math.floor(Math.random() * pigs.length)];
        if (!aim) {
          var alive = [];
          for (i = 0; i < world.bodies.length; i++) if (world.bodies[i].alive) alive.push(world.bodies[i]);
          aim = alive.length ? alive[Math.floor(Math.random() * alive.length)] : null;
        }
        if (!aim) { turn = pA.id; updateHud(); return; }
        /* Leicht/Normal zielen manchmal auf die tragende Säule statt aufs Ziel. */
        var tx = aim.x, ty = aim.y;
        if (Math.random() < (diff === 'schwer' ? 0.25 : 0.4)) {
          var sup = supportUnder(aim);
          if (sup) { tx = sup.x; ty = sup.y; }
        }
        tx += (Math.random() * 2 - 1) * cfg.jit;
        ty += (Math.random() * 2 - 1) * cfg.jit;
        var v = 1000 * (1 + (Math.random() * 2 - 1) * cfg.verr);
        if (v > MAXV) v = MAXV;
        var th = solveAngle(tx, ty, v, Math.random() < 0.3);
        if (th === null) { th = Math.PI / 4; v = MAXV; }
        th += (Math.random() * 2 - 1) * cfg.aerr;
        if (App.Audio) App.Audio.sfx('click');
        shooterId = pB.id;
        beginShot(v * Math.cos(th), -v * Math.sin(th), pB.id);
      }
      /* Ein Block, der links/unter dem Ziel steht und es trägt (grobe Heuristik). */
      function supportUnder(t) {
        var best = null, i;
        for (i = 0; i < world.bodies.length; i++) {
          var b = world.bodies[i];
          if (!b.alive || b.mat === 'pig' || b === t) continue;
          if (b.y <= t.y) continue;
          if (Math.abs(b.x - t.x) > 130) continue;
          if (!best || b.h > best.h) best = b;
        }
        return best;
      }
      /* Wurfwinkel (rad, positiv = nach oben) für Ziel (tx,ty) bei Tempo v. */
      function solveAngle(tx, ty, v, high) {
        var X = tx - AX, Y = AY - ty;
        if (X <= 1) return null;
        var v2 = v * v;
        var disc = v2 * v2 - G * (G * X * X + 2 * Y * v2);
        if (disc < 0) return null;
        var r = Math.sqrt(disc);
        return Math.atan((high ? (v2 + r) : (v2 - r)) / (G * X));
      }

      function showEndSolo() {
        if (state === 'end') return;
        state = 'end';
        if (raf) { cancelAnimationFrame(raf); raf = null; }
        var s = scores.me || 0, bs = scores.bot || 0;
        var best = App.Storage.get('best_slingshot', 0), nb = s > best;
        if (nb) App.Storage.set('best_slingshot', s);
        if (s > bs && App.Scores) App.Scores.winCurrent();
        if (App.Audio) App.Audio.sfx(s > bs ? 'win' : 'lose');
        var head = s > bs ? 'Du schlägst den Bot ' : (s === bs ? 'Gleichstand ' : 'Der Bot gewinnt ');
        App.MG.endScreen(root, {
          score: s, best: best, newBest: nb,
          title: s > bs ? '🏆 Turm geknackt!' : (s === bs ? '🤝 Unentschieden' : '💥 Knapp daneben'),
          label: head + s + ' : ' + bs + (nb ? ' · neuer Rekord! 🎉' : ' · Bestwert: ' + App.MG.fmt(best)),
          onExit: ctx.onExit,
          onAgain: function () { showChooser(); }
        });
      }

      /* ==================================================================
       *  MULTIPLAYER
       * ================================================================== */
      function startMulti() {
        var room = ctx.room;
        function maybeStart() {
          if (started || dead) return;
          var ps = room.players();
          if (ps.length < 2) { showWaiting(ps.length); return; }
          started = true;
          var snap = room.snapshot() || {};
          var startAt = (snap.round && snap.round.startAt) || (room.now() + 3000);
          addStop(App.MG.countdown(root, startAt, function () { playMulti(); }, room.now));
        }
        var ph = function () { maybeStart(); };
        room.on('players', ph);
        addStop(function () { room.off('players', ph); });
        maybeStart();
      }

      function playMulti() {
        var room = ctx.room;
        var ps = room.players();
        var sh0 = (room.snapshot() || {}).shared || {};
        var order = (sh0 && sh0.order && sh0.order.length === 2) ? sh0.order : [ps[0].id, ps[1].id];
        pA = { id: order[0], name: nameOf(order[0], ps, 'Spieler 1') };
        pB = { id: order[1], name: nameOf(order[1], ps, 'Spieler 2') };
        scores = {}; scores[pA.id] = 0; scores[pB.id] = 0;
        lastShared = sh0 || {};
        buildStage();
        if (room.isHost() && !lastShared.init && !initSent) {
          initSent = true;
          try { room.setShared({ init: 1, order: [pA.id, pB.id], level: 0, seq: 0 }); } catch (e) {}
        }
        var sh = function (s) { if (dead) return; lastShared = s || {}; sync(); };
        room.on('shared', sh);
        addStop(function () { room.off('shared', sh); });
        var pl = function () { if (dead) return; onPlayers(); };
        room.on('players', pl);
        addStop(function () { room.off('players', pl); });
        reportMine();
        sync();
        startLoop();
      }
      function nameOf(id, ps, fb) { for (var i = 0; i < ps.length; i++) if (ps[i].id === id) return ps[i].name; return fb; }

      /* Gegner weg -> Partie beenden (der Verbliebene schreibt es einmal). */
      function onPlayers() {
        if (state === 'end' || !pA) return;
        if (ctx.room.players().length < 2 && !lastShared.over) {
          UI.toast('Gegner hat den Raum verlassen', 'info');
          try { ctx.room.setShared({ over: 1 }); } catch (e) {}
        }
      }

      function sync() {
        if (dead || !pA) return;
        var sh = lastShared || {};
        if (sh.over) { showEndMulti(); return; }
        if (!sh.init) {
          if (ctx.room.isHost() && !initSent) {
            initSent = true;
            try { ctx.room.setShared({ init: 1, order: [pA.id, pB.id], level: 0, seq: 0 }); } catch (e) {}
          }
          setStatus('Turm wird aufgebaut …', 'opp');
          return;
        }
        var lvl = sh.level || 0;
        if (lvl !== world.level) loadLevel(lvl);
        if (sh.res && sh.res.level === world.level && sh.res.seq !== resAppliedSeq) {
          if (state === 'fly' && animSeq === sh.res.seq) pendingRes = sh.res;
          else applyRes(sh.res);
        }
        if (sh.shot && sh.shot.level === world.level && sh.shot.seq > appliedSeq &&
            sh.shot.seq !== animSeq && state === 'idle') {
          animSeq = sh.shot.seq;
          beginShot(sh.shot.vx, sh.shot.vy, sh.shot.by);
        }
        updateHud();
      }

      /* Endzustand des Werfers = Autorität (fängt Drift und späten Beitritt ab). */
      function publishRes(cleared) {
        var a = [], i;
        for (i = 0; i < world.bodies.length; i++) {
          var b = world.bodies[i];
          a.push(Math.round(b.x * 100) / 100, Math.round(b.y * 100) / 100,
            Math.max(0, Math.round(b.hp * 10)), b.alive ? 1 : 0);
        }
        try {
          ctx.room.setShared({
            res: {
              seq: animSeq, level: world.level, turn: turn, ammo: ammo,
              sa: scores[pA.id] || 0, sb: scores[pB.id] || 0,
              cleared: cleared ? 1 : 0, w: a
            }
          });
        } catch (e) {}
      }

      function applyRes(res) {
        resAppliedSeq = res.seq; appliedSeq = res.seq;
        var a = res.w || [], i, k = 0;
        for (i = 0; i < world.bodies.length; i++) {
          var b = world.bodies[i];
          if (k + 3 < a.length) {
            b.x = a[k]; b.y = a[k + 1]; b.hp = a[k + 2] / 10; b.alive = a[k + 3] === 1;
            b.vx = 0; b.vy = 0;
          }
          k += 4;
        }
        world.ball = null; rebuildList();
        ammo = res.ammo; turn = res.turn;
        scores[pA.id] = res.sa || 0; scores[pB.id] = res.sb || 0;
        reportMine();
        if (res.cleared || ammo <= 0) scheduleAdvance(!!res.cleared);
        else { state = 'idle'; updateHud(); }
      }

      function reportMine() { if (isMulti) { try { ctx.room.reportScore(scores[MEID] || 0); } catch (e) {} } }

      function showEndMulti() {
        if (state === 'end') return;
        state = 'end';
        if (raf) { cancelAnimationFrame(raf); raf = null; }
        reportMine();
        var oid = (MEID === pA.id) ? pB.id : pA.id;
        var iWon = (scores[MEID] || 0) > (scores[oid] || 0);
        if (iWon && App.Scores) App.Scores.winCurrent();
        if (App.Audio) App.Audio.sfx(iWon ? 'win' : 'lose');
        after(1200, function () {
          App.MG.endScreen(root, { players: ctx.room.players(), meId: ctx.me.id, onExit: ctx.onExit });
        });
      }

      function showWaiting(n) {
        root.innerHTML = '';
        root.appendChild(el('div', { class: 'glass sls-panel' }, [
          el('div', { class: 'sls-panel-icon sls-spin' }, ['🪃']),
          el('h2', { class: 'neon' }, ['Schleuder-Angriff']),
          el('div', { class: 'big-readout' }, [n + ' / 2']),
          el('p', { class: 'hint-text' }, ['Warte auf den zweiten Schützen …']),
          el('div', { class: 'controls-row' }, [
            el('button', { class: 'btn btn-ghost', type: 'button', onclick: ctx.onExit }, ['Zurück zur Lobby'])
          ])
        ]));
      }

      /* ==================================================================
       *  ANSICHT
       * ================================================================== */
      function buildStage() {
        var aName = pA.name + (pA.id === MEID ? ' (du)' : '');
        var bName = pB.name + (pB.id === MEID ? ' (du)' : '');
        var scA = el('div', { class: 'sls-chip-score' }, ['0']);
        var scB = el('div', { class: 'sls-chip-score' }, ['0']);
        var chipA = el('div', { class: 'sls-chip sls-chip-a' + (pA.id === MEID ? ' me' : '') }, [
          el('span', { class: 'sls-chip-ico' }, ['🪃']),
          el('div', { class: 'sls-chip-info' }, [el('div', { class: 'sls-chip-name' }, [aName]), el('div', { class: 'sls-chip-l' }, ['Schütze 1'])]),
          scA
        ]);
        var chipB = el('div', { class: 'sls-chip sls-chip-b' + (pB.id === MEID ? ' me' : '') }, [
          el('span', { class: 'sls-chip-ico' }, ['🎯']),
          el('div', { class: 'sls-chip-info' }, [el('div', { class: 'sls-chip-name' }, [bName]), el('div', { class: 'sls-chip-l' }, ['Schütze 2'])]),
          scB
        ]);
        var lvlEl = el('div', { class: 'sls-lvl' }, ['Level 1/3']);
        var ammoEl = el('div', { class: 'sls-ammo' });
        var mid = el('div', { class: 'sls-mid' }, [lvlEl, ammoEl]);
        var head = el('div', { class: 'sls-head glass' }, [chipA, mid, chipB]);
        var statusEl = el('div', { class: 'sls-status' }, ['']);
        canvas = el('canvas', { class: 'sls-canvas', width: W, height: H });
        var stage = el('div', { class: 'sls-stage' }, [canvas]);
        var hint = el('div', { class: 'sls-hint hint-text' }, ['Auf der Fläche ziehen & loslassen · Glas 15 · Holz 25 · Stein 40 · 🐷 300 · Level räumen = Bonus je übrigem Schuss']);
        root.innerHTML = '';
        root.appendChild(el('div', { class: 'sls-wrap' }, [head, statusEl, stage, hint]));
        refs = { scA: scA, scB: scB, chipA: chipA, chipB: chipB, lvl: lvlEl, ammo: ammoEl, status: statusEl };
        g2d = canvas.getContext('2d');
        attachInput();
        updateHud();
      }

      function setStatus(t, cls) {
        if (!refs) return;
        refs.status.textContent = t;
        refs.status.className = 'sls-status ' + (cls || '');
      }

      function updateHud(keepStatus) {
        if (!refs || !pA) return;
        refs.scA.textContent = App.MG.fmt(scores[pA.id] || 0);
        refs.scB.textContent = App.MG.fmt(scores[pB.id] || 0);
        refs.chipA.classList.toggle('active', turn === pA.id && state !== 'end');
        refs.chipB.classList.toggle('active', turn === pB.id && state !== 'end');
        refs.lvl.textContent = 'Level ' + (world.level + 1) + '/' + LEVELS +
          (world.level >= 0 ? ' · ' + LEVEL_NAMES[world.level] : '');
        if (refs.ammo.childNodes.length !== AMMO) {
          refs.ammo.innerHTML = '';
          for (var i = 0; i < AMMO; i++) refs.ammo.appendChild(el('span', { class: 'sls-dot' }));
        }
        for (var j = 0; j < AMMO; j++) {
          refs.ammo.childNodes[j].className = 'sls-dot' + (j < ammo ? ' on' : '');
        }
        if (keepStatus) return;
        if (state === 'fly') setStatus('Geschoss unterwegs … 🪃', 'fly');
        else if (state === 'idle' && turn === MEID) setStatus('Du bist dran — ziehen & loslassen', 'you');
        else if (state === 'idle') setStatus((turn === pA.id ? pA.name : pB.name) + ' zielt …', 'opp');
      }

      /* ---- Eingabe: Maus UND Touch über Pointer-Events ---- */
      function attachInput() {
        var onDown = function (e) {
          if (!canShoot()) return;
          e.preventDefault();
          dragging = true; setPointer(e);
          if (canvas.setPointerCapture) { try { canvas.setPointerCapture(e.pointerId); } catch (er) {} }
          if (App.Audio) App.Audio.sfx('click');
        };
        var onMove = function (e) { if (!dragging) return; e.preventDefault(); setPointer(e); };
        var onUp = function (e) {
          if (!dragging) return;
          dragging = false; e.preventDefault();
          if (!canShoot()) return;
          if (pull.len < 14) { if (App.Audio) App.Audio.sfx('error'); return; }
          var v = pull.len / MAXPULL * MAXV;
          fire(-pull.dx / pull.len * v, -pull.dy / pull.len * v);
        };
        addL(canvas, 'pointerdown', onDown);
        addL(canvas, 'pointermove', onMove);
        addL(canvas, 'pointerup', onUp);
        addL(canvas, 'pointercancel', function () { dragging = false; });
        addL(canvas, 'contextmenu', function (e) { e.preventDefault(); });
      }
      function setPointer(e) {
        var r = canvas.getBoundingClientRect();
        px = (e.clientX - r.left) / r.width * W;
        py = (e.clientY - r.top) / r.height * H;
        var dx = px - AX, dy = py - AY;
        if (dx > 0) dx = 0;                          // immer nach hinten spannen
        var len = Math.sqrt(dx * dx + dy * dy);
        if (len > MAXPULL) { dx *= MAXPULL / len; dy *= MAXPULL / len; len = MAXPULL; }
        pull.dx = dx; pull.dy = dy; pull.len = len;
      }

      /* ==================================================================
       *  SCHLEIFE
       * ================================================================== */
      function startLoop() {
        if (raf) cancelAnimationFrame(raf);
        lastFrame = Date.now(); acc = 0;
        raf = requestAnimationFrame(frame);
      }
      function frame() {
        if (dead || state === 'end') { raf = null; return; }
        var now = Date.now();
        var dt = (now - lastFrame) / 1000; lastFrame = now;
        if (dt < 0) dt = 0; if (dt > 0.5) dt = 0.5;
        if (state === 'fly') {
          acc += dt;
          var n = 0;
          while (acc >= STEP && n < 90 && state === 'fly') {
            simStep(STEP); simT += STEP; acc -= STEP; n++;
            checkSettle();
          }
          if (acc > 0.5) acc = 0.5;
        } else acc = 0;
        updateFx(dt);
        draw();
        raf = requestAnimationFrame(frame);
      }

      /* ---- Effekte (rein optisch, nicht Teil der Simulation) ---- */
      function burst(b) {
        var n = b.mat === 'pig' ? 18 : 12, i;
        for (i = 0; i < n; i++) {
          parts.push({
            x: b.x + (Math.random() - 0.5) * b.w, y: b.y + (Math.random() - 0.5) * b.h,
            vx: (Math.random() * 2 - 1) * 240, vy: (Math.random() * 2 - 1) * 240 - 60,
            life: 0.5 + Math.random() * 0.5, t: 0, c: MAT[b.mat].line, s: 2 + Math.random() * 4
          });
        }
      }
      function floater(x, y, txt, kind) { floats.push({ x: x, y: y, txt: txt, t: 0, kind: kind }); }
      function updateFx(dt) {
        var i;
        for (i = parts.length - 1; i >= 0; i--) {
          var p = parts[i];
          p.t += dt; p.vy += 700 * dt; p.x += p.vx * dt; p.y += p.vy * dt;
          if (p.t >= p.life) parts.splice(i, 1);
        }
        for (i = floats.length - 1; i >= 0; i--) {
          var f = floats[i]; f.t += dt; f.y -= 34 * dt;
          if (f.t > 1.3) floats.splice(i, 1);
        }
        if (shake > 0) { shake -= dt * 26; if (shake < 0) shake = 0; }
      }

      /* ==================================================================
       *  ZEICHNEN
       * ================================================================== */
      function draw() {
        var g = g2d; if (!g) return;
        g.save();
        if (shake > 0.3) g.translate((Math.random() * 2 - 1) * shake, (Math.random() * 2 - 1) * shake);
        var grd = g.createLinearGradient(0, 0, 0, H);
        grd.addColorStop(0, '#05170e'); grd.addColorStop(0.68, '#03110a'); grd.addColorStop(1, '#020c07');
        g.fillStyle = grd; g.fillRect(-40, -40, W + 80, H + 80);
        drawVines(g);
        drawGround(g);
        drawSling(g);
        var i;
        for (i = 0; i < world.bodies.length; i++) if (world.bodies[i].alive) drawBody(g, world.bodies[i], i);
        drawTrail(g);
        if (world.ball) drawBall(g, world.ball.x, world.ball.y);
        drawAim(g);
        drawParts(g);
        drawFloats(g);
        g.restore();
      }

      function drawVines(g) {
        g.save(); g.strokeStyle = 'rgba(57,255,20,.10)'; g.lineWidth = 7; g.lineCap = 'round';
        for (var i = 0; i < VINES.length; i++) {
          var v = VINES[i];
          g.beginPath(); g.moveTo(v[0], v[1]); g.quadraticCurveTo(v[2], v[3], v[4], v[5]); g.stroke();
          g.fillStyle = 'rgba(157,255,122,.10)';
          g.beginPath(); g.ellipse(v[4], v[5], 13, 7, 0.6, 0, Math.PI * 2); g.fill();
        }
        g.restore();
      }

      function drawGround(g) {
        g.save();
        var gg = g.createLinearGradient(0, GY, 0, H);
        gg.addColorStop(0, '#0b2c15'); gg.addColorStop(1, '#04150b');
        g.fillStyle = gg; g.fillRect(-40, GY, W + 80, H - GY + 40);
        g.strokeStyle = 'rgba(57,255,20,.6)'; g.lineWidth = 3;
        g.shadowColor = 'rgba(57,255,20,.7)'; g.shadowBlur = 14;
        g.beginPath(); g.moveTo(-40, GY + 1.5); g.lineTo(W + 40, GY + 1.5); g.stroke();
        g.shadowBlur = 0; g.strokeStyle = 'rgba(157,255,122,.22)'; g.lineWidth = 2;
        for (var x = 10; x < W; x += 34) {
          g.beginPath(); g.moveTo(x, GY + 2); g.lineTo(x + 6, GY - 9); g.stroke();
          g.beginPath(); g.moveTo(x + 14, GY + 2); g.lineTo(x + 10, GY - 7); g.stroke();
        }
        g.restore();
      }

      function drawSling(g) {
        g.save();
        g.strokeStyle = 'rgba(157,255,122,.9)'; g.lineWidth = 9; g.lineCap = 'round';
        g.shadowColor = 'rgba(57,255,20,.5)'; g.shadowBlur = 12;
        g.beginPath(); g.moveTo(AX, GY); g.lineTo(AX, AY + 34); g.stroke();
        g.lineWidth = 7;
        g.beginPath(); g.moveTo(AX, AY + 36); g.lineTo(AX - 24, AY - 12); g.stroke();
        g.beginPath(); g.moveTo(AX, AY + 36); g.lineTo(AX + 24, AY - 12); g.stroke();
        g.restore();
        /* Gummi + ruhendes Geschoss */
        if (state === 'idle' && world.level >= 0 && !world.ball) {
          var bx = AX + (dragging ? pull.dx : 0), by = AY + (dragging ? pull.dy : 0);
          g.save();
          g.strokeStyle = 'rgba(255,210,63,.85)'; g.lineWidth = 5; g.lineCap = 'round';
          g.shadowColor = 'rgba(255,210,63,.5)'; g.shadowBlur = 10;
          g.beginPath(); g.moveTo(AX - 24, AY - 12); g.lineTo(bx, by); g.stroke();
          g.beginPath(); g.moveTo(AX + 24, AY - 12); g.lineTo(bx, by); g.stroke();
          g.restore();
          if (turn === MEID) drawBall(g, bx, by);
        }
      }

      function drawBall(g, x, y) {
        g.save();
        g.shadowColor = 'rgba(57,255,20,.95)'; g.shadowBlur = 26;
        var rg = g.createRadialGradient(x - 4, y - 5, 2, x, y, 13);
        rg.addColorStop(0, '#ffffff'); rg.addColorStop(0.5, '#c8ffb0'); rg.addColorStop(1, '#39ff14');
        g.fillStyle = rg;
        g.beginPath(); g.arc(x, y, 13, 0, Math.PI * 2); g.fill();
        g.restore();
      }

      function drawTrail(g) {
        if (!trail.length) return;
        g.save();
        for (var i = 0; i < trail.length; i++) {
          var a = (i + 1) / trail.length;
          g.fillStyle = 'rgba(180,255,150,' + (a * 0.26).toFixed(3) + ')';
          g.beginPath(); g.arc(trail[i].x, trail[i].y, 4 + a * 7, 0, Math.PI * 2); g.fill();
        }
        g.restore();
      }

      function drawBody(g, b, idx) {
        var m = MAT[b.mat];
        if (b.mat === 'pig') {
          g.save();
          g.shadowColor = m.glow; g.shadowBlur = 16;
          g.fillStyle = 'rgba(255,210,63,.14)';
          g.beginPath(); g.arc(b.x, b.y, 18, 0, Math.PI * 2); g.fill();
          g.shadowBlur = 0;
          g.font = '28px "Segoe UI Emoji",system-ui,sans-serif';
          g.textAlign = 'center'; g.textBaseline = 'middle';
          g.globalAlpha = 0.55 + 0.45 * (b.hp / b.max);
          g.fillText('🐷', b.x, b.y + 1);
          g.globalAlpha = 1;
          /* Lebensring */
          g.strokeStyle = b.hp / b.max > 0.5 ? 'rgba(255,210,63,.8)' : 'rgba(255,77,109,.9)';
          g.lineWidth = 2.5;
          g.beginPath(); g.arc(b.x, b.y, 21, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * (b.hp / b.max)); g.stroke();
          g.restore();
          return;
        }
        g.save();
        g.shadowColor = m.glow; g.shadowBlur = 14;
        g.fillStyle = m.fill;
        rrect(g, b.x - b.w / 2, b.y - b.h / 2, b.w, b.h, 5); g.fill();
        g.shadowBlur = 0;
        g.strokeStyle = m.line; g.lineWidth = 2;
        rrect(g, b.x - b.w / 2 + 1, b.y - b.h / 2 + 1, b.w - 2, b.h - 2, 4); g.stroke();
        if (b.mat === 'stein') {
          g.strokeStyle = 'rgba(207,228,220,.28)'; g.lineWidth = 1;
          g.beginPath(); g.moveTo(b.x - b.w / 2 + 3, b.y); g.lineTo(b.x + b.w / 2 - 3, b.y); g.stroke();
        }
        var r = b.hp / b.max;
        if (r < 0.8) drawCracks(g, b, r, idx);
        g.restore();
      }
      function drawCracks(g, b, r, idx) {
        var n = r < 0.35 ? 3 : r < 0.6 ? 2 : 1, i;
        g.save();
        g.strokeStyle = 'rgba(255,77,109,' + (0.8 - r * 0.5).toFixed(2) + ')';
        g.lineWidth = 1.6;
        for (i = 0; i < n; i++) {
          var t = (i + 1) / (n + 1);
          var sx = b.x - b.w / 2 + b.w * t;
          var ex = b.x - b.w / 2 + b.w * ((idx + i) % 2 === 0 ? t * 0.55 + 0.2 : 1 - t * 0.55);
          g.beginPath();
          g.moveTo(sx, b.y - b.h / 2 + 2);
          g.lineTo((sx + ex) / 2 + 3, b.y);
          g.lineTo(ex, b.y + b.h / 2 - 2);
          g.stroke();
        }
        g.restore();
      }

      /* Zielhilfe: gepunktete Parabel + Kraftanzeige */
      function drawAim(g) {
        if (!dragging || pull.len < 6 || !canShoot()) return;
        var v = pull.len / MAXPULL * MAXV;
        var vx = -pull.dx / pull.len * v, vy = -pull.dy / pull.len * v;
        g.save();
        for (var i = 1; i <= 18; i++) {
          var t = i * 0.075;
          var x = AX + vx * t, y = AY + vy * t + 0.5 * G * t * t;
          if (y > GY - 4 || x > W + 20) break;
          var a = 0.75 - i * 0.032;
          g.fillStyle = 'rgba(255,210,63,' + (a < 0.08 ? 0.08 : a).toFixed(2) + ')';
          g.beginPath(); g.arc(x, y, 4.5 - i * 0.12, 0, Math.PI * 2); g.fill();
        }
        var pw = Math.round(pull.len / MAXPULL * 100);
        g.font = '900 22px "Segoe UI",system-ui,Arial,sans-serif';
        g.textAlign = 'left'; g.textBaseline = 'middle';
        g.fillStyle = 'rgba(255,210,63,.95)';
        g.shadowColor = 'rgba(255,210,63,.6)'; g.shadowBlur = 12;
        g.fillText(pw + '% Kraft', 26, GY - 190);
        g.shadowBlur = 0;
        g.fillStyle = 'rgba(4,22,12,.8)';
        rrect(g, 26, GY - 172, 150, 12, 6); g.fill();
        var lg = g.createLinearGradient(26, 0, 176, 0);
        lg.addColorStop(0, '#39ff14'); lg.addColorStop(0.6, '#ffd23f'); lg.addColorStop(1, '#ff4d6d');
        g.fillStyle = lg;
        rrect(g, 26, GY - 172, 150 * (pw / 100), 12, 6); g.fill();
        g.restore();
      }

      function drawParts(g) {
        g.save();
        for (var i = 0; i < parts.length; i++) {
          var p = parts[i], a = 1 - p.t / p.life;
          g.globalAlpha = a < 0 ? 0 : a;
          g.fillStyle = p.c;
          g.fillRect(p.x - p.s / 2, p.y - p.s / 2, p.s, p.s);
        }
        g.restore();
      }
      function drawFloats(g) {
        g.save();
        g.font = '900 20px "Segoe UI",system-ui,Arial,sans-serif';
        g.textAlign = 'center'; g.textBaseline = 'middle';
        for (var i = 0; i < floats.length; i++) {
          var f = floats[i], a = 1 - f.t / 1.3;
          g.globalAlpha = a < 0 ? 0 : a;
          g.fillStyle = f.kind === 'gold' ? '#ffd23f' : '#9dff7a';
          g.shadowColor = f.kind === 'gold' ? 'rgba(255,210,63,.7)' : 'rgba(57,255,20,.6)';
          g.shadowBlur = 12;
          g.fillText(f.txt, f.x, f.y);
        }
        g.restore();
      }
      function rrect(g, x, y, w, h, r) {
        if (r > w / 2) r = w / 2; if (r > h / 2) r = h / 2;
        g.beginPath();
        g.moveTo(x + r, y);
        g.arcTo(x + w, y, x + w, y + h, r);
        g.arcTo(x + w, y + h, x, y + h, r);
        g.arcTo(x, y + h, x, y, r);
        g.arcTo(x, y, x + w, y, r);
        g.closePath();
      }
    }
  };

  /* ============================ STYLES ============================ */
  function injectStyle() {
    UI.injectStyle('mg-slingshot-css', [
      '.sls-wrap{display:flex;flex-direction:column;gap:10px;}',
      '.sls-head{display:flex;align-items:center;gap:10px;padding:9px 12px;}',
      '.sls-chip{flex:1;min-width:0;display:flex;align-items:center;gap:8px;padding:7px 10px;border-radius:13px;background:rgba(9,32,21,.6);border:1px solid var(--stroke);transition:border-color .15s,box-shadow .15s;}',
      '.sls-chip-ico{font-size:20px;line-height:1;}',
      '.sls-chip-info{flex:1;min-width:0;display:flex;flex-direction:column;line-height:1.15;}',
      '.sls-chip-name{font-weight:800;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      '.sls-chip-l{font-size:9px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;}',
      '.sls-chip-score{font-size:20px;font-weight:900;font-variant-numeric:tabular-nums;color:var(--leaf);}',
      '.sls-chip-b .sls-chip-score{color:var(--aqua);}',
      '.sls-chip.me .sls-chip-name{color:var(--aqua-soft);}',
      '.sls-chip.active{border-color:var(--neon);box-shadow:0 0 0 1px var(--neon),0 0 16px rgba(57,255,20,.3);}',
      '.sls-chip.active .sls-chip-ico{animation:sls-bob .9s ease-in-out infinite;}',
      '@keyframes sls-bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-3px)}}',
      '.sls-mid{display:flex;flex-direction:column;align-items:center;gap:5px;min-width:112px;}',
      '.sls-lvl{font-size:11px;font-weight:900;color:var(--gold);text-transform:uppercase;letter-spacing:1px;white-space:nowrap;text-shadow:0 0 8px rgba(255,210,63,.4);}',
      '.sls-ammo{display:flex;gap:5px;}',
      '.sls-dot{width:9px;height:9px;border-radius:50%;background:rgba(123,166,146,.25);border:1px solid var(--stroke);transition:.2s;}',
      '.sls-dot.on{background:var(--neon);border-color:var(--neon);box-shadow:0 0 8px rgba(57,255,20,.8);}',
      '.sls-status{text-align:center;font-weight:900;font-size:clamp(14px,3.8vw,18px);min-height:22px;color:var(--muted);transition:color .15s;}',
      '.sls-status.you{color:var(--neon);text-shadow:0 0 10px rgba(57,255,20,.45);}',
      '.sls-status.opp{color:var(--aqua);}',
      '.sls-status.fly{color:var(--gold);}',
      '.sls-status.win{color:var(--gold);text-shadow:0 0 12px rgba(255,210,63,.5);}',
      '.sls-status.lose{color:var(--danger);}',
      '.sls-stage{width:100%;max-width:780px;margin:0 auto;aspect-ratio:960 / 540;}',
      '.sls-canvas{display:block;width:100%;height:100%;border-radius:16px;border:1px solid var(--stroke-2);',
      'background:#03110a;box-shadow:0 0 30px rgba(57,255,20,.16),inset 0 0 40px rgba(0,0,0,.5);',
      'touch-action:none;user-select:none;-webkit-user-select:none;-webkit-tap-highlight-color:transparent;cursor:crosshair;}',
      '.sls-hint{text-align:center;font-size:12px;margin:0;}',
      '.sls-panel{padding:28px 22px;text-align:center;display:flex;flex-direction:column;gap:12px;align-items:center;max-width:520px;margin:0 auto;}',
      '.sls-panel-icon{font-size:56px;line-height:1;filter:drop-shadow(0 0 14px rgba(57,255,20,.5));}',
      '.sls-spin{animation:sls-spin 2.4s linear infinite;}',
      '@keyframes sls-spin{to{transform:rotate(360deg);}}',
      '.sls-panel-l{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:2px;font-weight:800;}',
      '.sls-diff-row{display:flex;gap:10px;flex-wrap:wrap;justify-content:center;}',
      '@media (max-width:560px){.sls-chip-l{display:none;}.sls-chip{padding:6px 8px;}.sls-mid{min-width:92px;}}'
    ].join(''));
  }
})();
