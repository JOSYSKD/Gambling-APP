/* doodlejump.js — "Ranken-Hüpfer": Doodle-Jump im Neon-Dschungel.
 *
 * IDEE:       Eine Figur (🦗) springt automatisch immer weiter nach oben. Du
 *             lenkst NUR nach links/rechts und landest auf Ranken-Plattformen,
 *             die dich wieder hochkatapultieren. Die Kamera scrollt mit — je
 *             höher du kommst, desto mehr Punkte. Runterfallen = vorbei.
 * PLATTFORMEN: normale Ranke, wandernde Ranke (schwingt hin und her),
 *             morsche Ranke (bricht nach dem Absprung weg), Sprungfeder (🟡,
 *             riesiger Boost). Ab einer gewissen Höhe fliegen rote Käfer herum:
 *             seitlich berühren = Tod, von oben draufspringen = zerquetschen.
 * STEUERUNG:  Tasten ← → oder A / D · am Handy/iPad die beiden großen Felder
 *             ◄ ► ODER links/rechts auf die Spielfläche tippen/ziehen.
 * PUNKTE:     Höhe = Punkte (gekletterte Strecke). Bestwert: best_doodlejump.
 * SYNC-MODELL: SOLO — Punktejagd gegen den eigenen Rekord (Rekord-Linie in der
 *             Welt) + drei Dschungel-Rivalen (KI in 3 Stufen) als Live-Rangliste.
 *             MULTI — der Countdown-Startzeitpunkt (Server-Zeit aus
 *             snapshot().round.startAt) ist der gemeinsame ZUFALLS-SEED, daher
 *             baut jeder Client EXAKT dasselbe Plattform-Layout (fair). Jeder
 *             rechnet seine eigene Figur, meldet die Höhe per reportScore und
 *             per reportState({fallen}) ob er gefallen ist. 2 Minuten oder bis
 *             alle gefallen sind, dann Podest. Alle Timer laufen über die
 *             Wall-Clock (Date.now bzw. room.now) → Tab-Wechsel-sicher.
 * cleanup():  stoppt rAF, alle Timer, entfernt alle Listener und room.off(). */
(function () {
  'use strict';
  window.App = window.App || {}; App.Minigames = App.Minigames || {};
  var UI = App.UI, el = UI.el;

  /* ---- virtuelles Spielfeld (Canvas skaliert per CSS) ---- */
  var W = 380, H = 460;
  var TAU = Math.PI * 2;
  var PR = 16;                 // Figur-Radius
  var G = 1500;               // Schwerkraft px/s^2
  var JUMP_V = 640;           // normaler Absprung nach oben
  var SPRING_V = 1140;        // Sprungfeder-Boost
  var SQUASH_V = 600;         // Absprung nach zerquetschtem Käfer
  var MAX_VX = 340;           // seitliches Tempo
  var PLW = 64, PLH = 14;     // Plattform-Maße
  var GAP_MIN = 52;           // minimaler vertikaler Abstand
  var FR = 15;                // Käfer-Radius
  var SCORE_SCALE = 6;        // Welt-px pro Punkt
  var MATCH_TIME = 120;       // s Rundenzeit im Multiplayer

  injectStyle();

  /* deterministischer Zufall (mulberry32) — gleicher Seed -> gleiches Layout */
  function makeRng(seed) {
    var s = seed >>> 0;
    return function () {
      s = (s + 0x6D2B79F5) | 0;
      var t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

  App.Minigames.doodlejump = {
    id: 'doodlejump', title: 'Ranken-Hüpfer', icon: '🦗', order: 137,
    subtitle: 'Hüpf von Ranke zu Ranke immer höher!',
    single: true, multi: true, minPlayers: 2, maxPlayers: 8,

    render: function (root, ctx) {
      var isMulti = ctx.mode === 'multi';
      var nowFn = isMulti ? ctx.room.now : function () { return Date.now(); };
      var fmt = App.MG.fmt;

      /* ---- Lebenszyklus ---- */
      var dead = false;              // nach cleanup: nichts mehr tun
      var raf = null;
      var stops = [];                // App.MG-Helfer + room.off
      var listeners = [];            // {t,ty,fn,opts}
      var timers = [];               // setTimeout-IDs
      function addL(t, ty, fn, opts) { t.addEventListener(ty, fn, opts); listeners.push({ t: t, ty: ty, fn: fn, opts: opts }); }
      function removeAllListeners() { listeners.forEach(function (l) { try { l.t.removeEventListener(l.ty, l.fn, l.opts); } catch (e) {} }); listeners = []; }
      function stopHelpers() { stops.forEach(function (f) { try { f(); } catch (e) {} }); stops = []; }
      function after(ms, fn) { var t = setTimeout(function () { if (!dead) fn(); }, ms); timers.push(t); return t; }
      function clearTimers() { timers.forEach(clearTimeout); timers = []; }
      function cancelRaf() { if (raf) { cancelAnimationFrame(raf); raf = null; } }
      function cleanup() { dead = true; cancelRaf(); stopHelpers(); removeAllListeners(); clearTimers(); }

      /* ---- Zustand ---- */
      var rng = null, ctx2d = null;
      var plats = [], foes = [], parts = [], ghosts = [];
      var px = W / 2, py = 0, vx = 0, vy = 0;
      var camTop = 0, highest = 0, genY = 0, platCount = 0, lastFoeY = 0;
      var score = 0, best = 0, recordY = 0, recordPassed = true;
      var lastBounceAt = 0, last = 0, startAt = 0, endAt = 0;
      var finished = false, myFallen = false;
      var lastReportedScore = -1, lastScoreReport = 0, lastRival = 0;
      var input = { kl: false, kr: false, bl: false, br: false, cdir: 0 };
      var bgDots = [];

      /* ---- DOM-Referenzen ---- */
      var canvas, scoreVal, rightVal, overlay, ovEmoji, ovTitle, ovH, ovSub, btnL, btnR, rivalsBox, timerEl;

      /* ================= Start ================= */
      if (isMulti) startMulti(); else startSolo();
      return { cleanup: cleanup };

      function startSolo() {
        finished = false; myFallen = false;
        best = App.Storage.get('best_doodlejump', 0) || 0;
        recordY = -best * SCORE_SCALE;
        recordPassed = !(best > 0);
        initGhosts();
        play((((Date.now() ^ (Math.random() * 1e9)) >>> 0) || 1), Date.now(), 0);
      }

      function startMulti() {
        var snap = ctx.room.snapshot() || {};
        var sAt = (snap.round && snap.round.startAt) || (ctx.room.now() + 3000);
        stops.push(App.MG.countdown(root, sAt, function () {
          finished = false; myFallen = false;
          play((Math.floor(sAt) >>> 0) || 1, sAt, sAt + MATCH_TIME * 1000);
        }, ctx.room.now));
      }

      function initGhosts() {
        ghosts = [];
        var defs = [
          { name: 'Kokos', icon: '🐒', rate: 86 },
          { name: 'Zisch', icon: '🦎', rate: 106 },
          { name: 'Ara', icon: '🦜', rate: 126 }
        ];
        defs.forEach(function (d) {
          ghosts.push({
            name: d.name, icon: d.icon, rate: d.rate + (Math.random() * 16 - 8),
            climb: 0, stallUntil: 0, wob: 0.6 + Math.random() * 0.8, phase: Math.random() * TAU
          });
        });
      }

      /* ================= Spielaufbau ================= */
      function play(seed, sAt, eAt) {
        cancelRaf(); removeAllListeners(); clearTimers();
        rng = makeRng(seed);
        startAt = sAt; endAt = eAt;
        plats = []; foes = []; parts = []; bgDots = [];
        px = W / 2; py = 0; vx = 0; vy = -JUMP_V;
        highest = 0; score = 0; platCount = 0; lastFoeY = 1e9;
        lastBounceAt = 0; lastReportedScore = -1; lastScoreReport = 0; lastRival = 0;
        camTop = 0 - H * 0.70;
        input.kl = input.kr = input.bl = input.br = false; input.cdir = 0;

        /* Start-Ranke direkt unter der Figur (erster Absprung garantiert) */
        var startY = PR;
        plats.push({ type: 'n', y: startY, x: W / 2, baseX: W / 2, broken: false, breakAt: 0, spring: false });
        genY = startY;
        ensurePlatforms();

        /* Hintergrund-Sporen (nur Deko) */
        var i;
        for (i = 0; i < 26; i++) bgDots.push({ x: Math.random() * W, y: Math.random() * H, r: 0.6 + Math.random() * 1.8, p: 0.3 + Math.random() * 0.6 });

        buildDom();
        setupCanvas();
        attachInput();

        if (isMulti) {
          timerEl.textContent = App.MG.mmss(MATCH_TIME);
          stops.push(App.MG.roundTimer(endAt, function (left) {
            timerEl.textContent = App.MG.mmss(left);
            if (left <= 10) timerEl.classList.add('jmp-urgent');
          }, finishMulti, ctx.room.now));
          var ph = function () { if (!dead && !finished) checkAllFallen(); };
          ctx.room.on('players', ph);
          stops.push(function () { ctx.room.off('players', ph); });
          try { ctx.room.reportScore(0); ctx.room.reportState({ fallen: false, h: 0 }); } catch (e) {}
        } else {
          drawRivals();
        }

        last = nowFn();
        raf = requestAnimationFrame(frame);
      }

      /* ================= Plattform-Erzeugung ================= */
      function ensurePlatforms() {
        while (genY > camTop - H) {
          var climb = -genY;
          var diff = clamp(climb / 9000, 0, 1);
          var gapMax = 84 + 28 * diff;
          var gap = GAP_MIN + rng() * (gapMax - GAP_MIN);
          genY -= gap;
          addPlatform(genY, gap, diff);
        }
      }
      function addPlatform(y, gap, diff) {
        platCount++;
        var forced = platCount <= 5;
        var r = rng();
        var moveC = forced ? 0 : (0.04 + 0.18 * diff);
        var breakC = forced ? 0 : (0.04 + 0.20 * diff);
        var type = 'n';
        if (r < moveC) type = 'm'; else if (r < moveC + breakC) type = 'b';
        var p = { type: type, y: y, broken: false, breakAt: 0, spring: false, amp: 0, w: 0, phase: 0 };
        if (type === 'm') {
          p.amp = 44 + 40 * diff;
          var lo = PLW / 2 + p.amp, hi = W - PLW / 2 - p.amp;
          if (hi < lo) { var mid = (lo + hi) / 2; lo = mid; hi = mid; }
          p.baseX = lo + rng() * (hi - lo);
          p.w = 0.9 + rng() * 0.9;
          p.phase = rng() * TAU;
          p.x = p.baseX;
        } else {
          p.x = PLW / 2 + rng() * (W - PLW);
          p.baseX = p.x;
        }
        if (type === 'n' && !forced && rng() < Math.max(0.05, 0.10 - 0.04 * diff)) p.spring = true;
        plats.push(p);
        /* Käfer zwischen den Ranken (ab einer gewissen Höhe, gut verteilt) */
        var climb = -y;
        if (!forced && climb > 1400 && (lastFoeY - y) > 950 && rng() < (0.02 + 0.055 * diff)) {
          var fy = y - gap * 0.55;
          var fa = 60 + 44 * diff;
          var flo = PR + fa, fhi = W - PR - fa;
          if (fhi < flo) { var fm = (flo + fhi) / 2; flo = fm; fhi = fm; }
          foes.push({ y: fy, amp: fa, w: 0.7 + rng() * 0.9, phase: rng() * TAU, baseX: flo + rng() * (fhi - flo), x: W / 2, alive: true });
          lastFoeY = y;
        }
      }
      function cullPlatforms(now) {
        var keep = [], i;
        for (i = 0; i < plats.length; i++) {
          var p = plats[i];
          if (p.y - camTop > H + 80) continue;
          if (p.broken && (now - p.breakAt) > 500) continue;
          keep.push(p);
        }
        plats = keep;
        var kf = [];
        for (i = 0; i < foes.length; i++) { var f = foes[i]; if (f.alive && f.y - camTop <= H + 80) kf.push(f); }
        foes = kf;
      }

      /* ================= Physik ================= */
      function steerDir() {
        var l = input.kl || input.bl || input.cdir < 0;
        var r = input.kr || input.br || input.cdir > 0;
        return (r ? 1 : 0) - (l ? 1 : 0);
      }
      function updateMovers(now) {
        var t = (now - startAt) / 1000, i;
        for (i = 0; i < plats.length; i++) { var p = plats[i]; if (p.type === 'm') p.x = p.baseX + p.amp * Math.sin(p.w * t + p.phase); }
        for (i = 0; i < foes.length; i++) { var f = foes[i]; if (f.alive) f.x = f.baseX + f.amp * Math.sin(f.w * t + f.phase); }
      }
      function simulate(dt, now) {
        var steps = Math.min(8, Math.max(1, Math.ceil(Math.abs(vy * dt) / 9)));
        var sdt = dt / steps, i;
        for (i = 0; i < steps; i++) { integrate(sdt, now); if (dead || finished || myFallen) return; }
      }
      function integrate(dt, now) {
        var target = steerDir() * MAX_VX;
        vx += (target - vx) * Math.min(1, dt * 14);
        var prevPy = py, prevFoot = py + PR;
        vy += G * dt;
        px += vx * dt;
        if (px < -PR) px = W + PR; else if (px > W + PR) px = -PR;
        var newPy = py + vy * dt, newFoot = newPy + PR;
        if (vy > 0) {
          var bestS = null, bestPlat = null, k;
          for (k = 0; k < plats.length; k++) {
            var p = plats[k]; if (p.broken) continue;
            var s = p.y;
            if (prevFoot <= s && newFoot >= s && Math.abs(px - p.x) <= PLW / 2 + PR * 0.35) {
              if (bestS === null || s < bestS) { bestS = s; bestPlat = p; }
            }
          }
          if (bestPlat) { py = bestS - PR; bounce(bestPlat, now); newPy = py; } else py = newPy;
        } else py = newPy;
        if (py < highest) highest = py;
        var f;
        for (f = 0; f < foes.length; f++) {
          var fo = foes[f]; if (!fo.alive) continue;
          if (Math.abs(px - fo.x) < (PR + FR) * 0.72 && Math.abs(py - fo.y) < (PR + FR) * 0.72) {
            if (vy > 0 && (prevPy + PR) <= fo.y + FR * 0.3) {
              fo.alive = false; vy = -SQUASH_V; lastBounceAt = now;
              spawnBurst(fo.x, fo.y, '#ff8098', 14);
              if (App.Audio) App.Audio.sfx('explosion');
            } else { die(); return; }
          }
        }
        if ((py - camTop) > H + PR * 4) { die(); return; }
      }
      function bounce(p, now) {
        lastBounceAt = now;
        if (p.spring) {
          vy = -SPRING_V;
          spawnBurst(p.x, p.y, '#ffd23f', 16);
          if (App.Audio) { App.Audio.sfx('powerup'); App.Audio.sweep(320, 900, 0.18); }
        } else {
          vy = -JUMP_V;
          spawnBurst(p.x, p.y + PLH * 0.5, '#9dff7a', 7);
          if (App.Audio) App.Audio.blip(360 + Math.min(360, (-highest) / 20), 0.06, { type: 'triangle', peak: 0.05 });
        }
        if (p.type === 'b') {
          p.broken = true; p.breakAt = now;
          spawnBurst(p.x, p.y, '#e08a3c', 12);
          if (App.Audio) App.Audio.sfx('tick');
        }
      }

      /* ================= Rivalen-KI (Solo) ================= */
      function updateGhosts(dt) {
        if (isMulti) return;
        var t = Date.now(), i;
        for (i = 0; i < ghosts.length; i++) {
          var g = ghosts[i];
          if (t < g.stallUntil) { g.climb += g.rate * dt * 0.12; }
          else {
            var wob = 1 + 0.22 * Math.sin(t / 1000 * g.wob + g.phase);
            g.climb += g.rate * dt * wob;
            if (Math.random() < dt * 0.35) g.stallUntil = t + 300 + Math.random() * 700;
            else if (Math.random() < dt * 0.06) { g.climb = Math.max(0, g.climb - (80 + Math.random() * 140)); g.stallUntil = t + 200 + Math.random() * 400; }
          }
        }
      }

      /* ================= Partikel ================= */
      function spawnBurst(x, y, color, n) {
        var i;
        for (i = 0; i < n; i++) {
          var a = Math.random() * TAU, sp = 40 + Math.random() * 160;
          parts.push({ x: x, y: y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 40, life: 0.5 + Math.random() * 0.4, max: 0.9, c: color, r: 1.5 + Math.random() * 2.5 });
        }
        if (parts.length > 120) parts.splice(0, parts.length - 120);
      }
      function updateParticles(dt) {
        var keep = [], i;
        for (i = 0; i < parts.length; i++) {
          var p = parts[i];
          p.vy += 900 * dt; p.x += p.vx * dt; p.y += p.vy * dt; p.life -= dt;
          if (p.life > 0) keep.push(p);
        }
        parts = keep;
      }

      /* ================= Kamera & Punkte ================= */
      function updateCamera(dt) {
        var desired = py - H * 0.44;
        var tgt = Math.min(camTop, desired);
        camTop += (tgt - camTop) * Math.min(1, dt * 10);
      }
      function updateScore(now) {
        var climb = -highest;
        var s = Math.max(0, Math.floor(climb / SCORE_SCALE));
        if (s !== score) { score = s; if (scoreVal) scoreVal.textContent = fmt(score); }
        if (!isMulti && !recordPassed && best > 0 && py <= recordY) {
          recordPassed = true;
          spawnBurst(px, py, '#ffd23f', 22);
          if (App.Audio) App.Audio.sfx('jackpot');
        }
        if (isMulti && score !== lastReportedScore && (now - lastScoreReport) > 350) {
          lastScoreReport = now; lastReportedScore = score;
          try { ctx.room.reportScore(score); } catch (e) {}
        }
        if (!isMulti && (now - lastRival) > 170) { lastRival = now; drawRivals(); }
      }

      /* ================= Frame-Schleife ================= */
      function frame() {
        if (dead || finished || myFallen) { raf = null; return; }
        var now = nowFn();
        var dt = (now - last) / 1000; if (dt < 0) dt = 0; if (dt > 0.05) dt = 0.05; last = now;
        updateMovers(now);
        simulate(dt, now);
        if (dead || finished || myFallen) { raf = null; return; }
        updateGhosts(dt);
        updateParticles(dt);
        ensurePlatforms();
        cullPlatforms(now);
        updateCamera(dt);
        updateScore(now);
        draw(now);
        raf = requestAnimationFrame(frame);
      }

      /* ================= Ende ================= */
      function die() { if (isMulti) myFall(); else soloDeath(); }

      function soloDeath() {
        if (finished) return; finished = true;
        cancelRaf(); removeAllListeners();
        spawnBurst(px, py, '#ff4d6d', 24); draw(nowFn());
        if (App.Audio) App.Audio.sfx('bust');
        var nb = score > best;
        if (nb) App.Storage.set('best_doodlejump', score);
        var rank = 1, i;
        for (i = 0; i < ghosts.length; i++) if (Math.floor(ghosts[i].climb / SCORE_SCALE) > score) rank++;
        var label = 'Höhe ' + fmt(score) + ' · Platz ' + rank + '/' + (ghosts.length + 1) +
          ' · ' + (nb ? 'Neuer Rekord! 🎉' : 'Rekord: ' + fmt(best));
        after(650, function () {
          App.MG.endScreen(root, {
            score: score, best: best, newBest: nb, label: label,
            onExit: ctx.onExit, onAgain: startSolo
          });
        });
      }

      function myFall() {
        if (myFallen || finished) return; myFallen = true;
        cancelRaf(); removeAllListeners();
        spawnBurst(px, py, '#ff4d6d', 20); draw(nowFn());
        if (App.Audio) App.Audio.sfx('bust');
        try { ctx.room.reportScore(score); ctx.room.reportState({ fallen: true, h: score }); } catch (e) {}
        if (overlay) {
          ovEmoji.textContent = '💥';
          ovTitle.textContent = 'Gefallen!';
          ovH.textContent = 'Höhe ' + fmt(score);
          ovSub.textContent = 'Warte auf die anderen …';
          overlay.className = 'jmp-overlay';
        }
        checkAllFallen();
      }

      function checkAllFallen() {
        var ps = ctx.room.players(); if (!ps.length) return;
        var i, allDown = true;
        for (i = 0; i < ps.length; i++) { if (!(ps[i].state && ps[i].state.fallen)) { allDown = false; break; } }
        if (allDown) finishMulti();
      }

      function finishMulti() {
        if (finished) return; finished = true;
        cancelRaf(); removeAllListeners(); stopHelpers();
        try { ctx.room.reportScore(score); } catch (e) {}
        after(500, function () {
          App.MG.endScreen(root, { players: ctx.room.players(), meId: ctx.me.id, onExit: ctx.onExit });
        });
      }

      /* ================= DOM ================= */
      function buildDom() {
        scoreVal = el('div', { class: 'jmp-score' }, ['0']);
        var leftStat = el('div', { class: 'jmp-stat' }, [el('span', { class: 'jmp-stat-l' }, ['Höhe']), scoreVal]);
        var rightStat;
        if (isMulti) {
          timerEl = el('div', { class: 'mg-timer' }, [App.MG.mmss(MATCH_TIME)]);
          rightVal = timerEl;
          rightStat = el('div', { class: 'jmp-stat r' }, [el('span', { class: 'jmp-stat-l' }, ['Zeit']), timerEl]);
        } else {
          rightVal = el('div', { class: 'jmp-best' }, [fmt(best)]);
          rightStat = el('div', { class: 'jmp-stat r' }, [el('span', { class: 'jmp-stat-l' }, ['🏆 Rekord']), rightVal]);
        }
        var top = el('div', { class: 'jmp-top glass' }, [leftStat, rightStat]);

        canvas = el('canvas', { class: 'jmp-canvas', width: W, height: H });
        ovEmoji = el('div', { class: 'jmp-ov-emoji' }, ['🦗']);
        ovTitle = el('div', { class: 'jmp-ov-t neon' }, ['']);
        ovH = el('div', { class: 'jmp-ov-h' }, ['']);
        ovSub = el('p', { class: 'hint-text' }, ['']);
        overlay = el('div', { class: 'jmp-overlay hidden' }, [ovEmoji, ovTitle, ovH, ovSub]);
        var stage = el('div', { class: 'jmp-stage' }, [canvas, overlay]);

        btnL = el('button', { class: 'jmp-ctrl', type: 'button', 'aria-label': 'Links' }, ['◄']);
        btnR = el('button', { class: 'jmp-ctrl', type: 'button', 'aria-label': 'Rechts' }, ['►']);
        var controls = el('div', { class: 'jmp-controls' }, [btnL, btnR]);

        var hint = el('div', { class: 'jmp-hint hint-text' },
          ['← → oder A/D · am Handy Felder ◄ ► oder links/rechts auf die Fläche · 🟡 Feder = Boost · rote Käfer von oben treffen · nicht runterfallen!']);

        var children = [top, stage, controls, hint];
        if (isMulti) {
          var board = App.MG.liveBoard(ctx.room, ctx.me.id);
          stops.push(board.stop);
          children.push(el('div', { class: 'jmp-board-wrap glass' }, [el('div', { class: 'mg-field-title' }, ['🏆 Rangliste']), board.root]));
        } else {
          rivalsBox = el('div', { class: 'jmp-rivals' });
          children.push(el('div', { class: 'jmp-board-wrap glass' }, [el('div', { class: 'mg-field-title' }, ['🌴 Dschungel-Rivalen']), rivalsBox]));
        }
        root.innerHTML = '';
        root.appendChild(el('div', { class: 'jmp-wrap' }, children));
      }

      function drawRivals() {
        if (!rivalsBox) return;
        var arr = [], i;
        for (i = 0; i < ghosts.length; i++) arr.push({ icon: ghosts[i].icon, name: ghosts[i].name, score: Math.floor(ghosts[i].climb / SCORE_SCALE), me: false });
        arr.push({ icon: '🦗', name: 'Du', score: score, me: true });
        arr.sort(function (a, b) { return b.score - a.score; });
        rivalsBox.innerHTML = '';
        for (i = 0; i < arr.length; i++) {
          var it = arr[i];
          rivalsBox.appendChild(el('div', { class: 'jmp-rv-row' + (it.me ? ' me' : '') }, [
            el('span', { class: 'jmp-rv-ic' }, [it.icon]),
            el('span', { class: 'jmp-rv-nm' }, [(i + 1) + '. ' + it.name]),
            el('span', { class: 'jmp-rv-sc' }, [fmt(it.score)])
          ]));
        }
      }

      /* ================= Eingabe ================= */
      function bindHold(node, dn, up) {
        addL(node, 'pointerdown', function (e) { e.preventDefault(); node.classList.add('on'); dn(); });
        var release = function (e) { if (e && e.preventDefault) e.preventDefault(); node.classList.remove('on'); up(); };
        addL(node, 'pointerup', release);
        addL(node, 'pointercancel', release);
        addL(node, 'pointerleave', release);
      }
      function canvasFrac(e) { var r = canvas.getBoundingClientRect(); return r.width ? (e.clientX - r.left) / r.width : 0.5; }
      function attachInput() {
        bindHold(btnL, function () { input.bl = true; }, function () { input.bl = false; });
        bindHold(btnR, function () { input.br = true; }, function () { input.br = false; });
        addL(canvas, 'pointerdown', function (e) { e.preventDefault(); input.cdir = canvasFrac(e) < 0.5 ? -1 : 1; });
        addL(canvas, 'pointermove', function (e) { if (input.cdir !== 0) { e.preventDefault(); input.cdir = canvasFrac(e) < 0.5 ? -1 : 1; } });
        var clr = function () { input.cdir = 0; };
        addL(canvas, 'pointerup', clr);
        addL(canvas, 'pointercancel', clr);
        addL(canvas, 'pointerleave', clr);
        var kd = function (e) {
          var k = e.key;
          if (k === 'ArrowLeft' || k === 'a' || k === 'A') { input.kl = true; e.preventDefault(); }
          else if (k === 'ArrowRight' || k === 'd' || k === 'D') { input.kr = true; e.preventDefault(); }
        };
        var ku = function (e) {
          var k = e.key;
          if (k === 'ArrowLeft' || k === 'a' || k === 'A') input.kl = false;
          else if (k === 'ArrowRight' || k === 'd' || k === 'D') input.kr = false;
        };
        addL(document, 'keydown', kd);
        addL(document, 'keyup', ku);
      }

      /* ================= Rendering ================= */
      function setupCanvas() {
        var dpr = Math.min(2, window.devicePixelRatio || 1);
        canvas.width = Math.round(W * dpr);
        canvas.height = Math.round(H * dpr);
        ctx2d = canvas.getContext('2d');
        ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
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
      function draw(now) {
        var g = ctx2d; if (!g) return;
        drawBg(g);
        drawRecordLine(g);
        var i;
        for (i = 0; i < plats.length; i++) drawPlat(g, plats[i]);
        for (i = 0; i < foes.length; i++) drawFoe(g, foes[i], now);
        drawParts(g);
        drawPlayer(g, now);
      }
      function drawBg(g) {
        var grd = g.createLinearGradient(0, 0, 0, H);
        grd.addColorStop(0, '#082214'); grd.addColorStop(1, '#02100a');
        g.fillStyle = grd; g.fillRect(0, 0, W, H);
        var i;
        g.save();
        for (i = 0; i < bgDots.length; i++) {
          var d = bgDots[i];
          var y = (((d.y - camTop * d.p) % (H + 40)) + (H + 40)) % (H + 40) - 20;
          g.fillStyle = 'rgba(120,255,150,' + (0.05 + d.r * 0.03).toFixed(3) + ')';
          g.beginPath(); g.arc(d.x, y, d.r, 0, TAU); g.fill();
        }
        g.restore();
      }
      function drawRecordLine(g) {
        if (isMulti || best <= 0) return;
        var sy = recordY - camTop;
        if (sy < -10 || sy > H + 10) return;
        g.save();
        g.strokeStyle = 'rgba(255,210,63,0.85)'; g.lineWidth = 2; g.setLineDash([9, 8]);
        g.beginPath(); g.moveTo(0, sy); g.lineTo(W, sy); g.stroke();
        g.setLineDash([]);
        g.font = '900 12px "Segoe UI",system-ui,Roboto,Arial,sans-serif';
        g.fillStyle = 'rgba(255,210,63,0.95)'; g.textAlign = 'right'; g.textBaseline = 'bottom';
        g.fillText('REKORD', W - 8, sy - 2);
        g.restore();
      }
      function drawPlat(g, p) {
        if (p.broken) return;
        var sy = p.y - camTop; if (sy < -PLH || sy > H + PLH) return;
        var x = p.x - PLW / 2;
        var top, bot, edge;
        if (p.type === 'm') { top = '#7ff3e6'; bot = '#1f9e8f'; edge = 'rgba(51,230,208,0.85)'; }
        else if (p.type === 'b') { top = '#f0b070'; bot = '#8a4d18'; edge = 'rgba(224,138,60,0.8)'; }
        else { top = '#bdff9a'; bot = '#2f9e2f'; edge = 'rgba(57,255,20,0.85)'; }
        g.save();
        g.shadowColor = edge; g.shadowBlur = 12;
        var grd = g.createLinearGradient(0, sy, 0, sy + PLH);
        grd.addColorStop(0, top); grd.addColorStop(1, bot);
        g.fillStyle = grd; roundRect(g, x, sy, PLW, PLH, 6); g.fill();
        g.shadowBlur = 0; g.strokeStyle = edge; g.lineWidth = 1.5; g.stroke();
        if (p.type === 'b') {
          g.strokeStyle = 'rgba(40,20,4,0.6)'; g.lineWidth = 1.4; g.beginPath();
          g.moveTo(x + PLW * 0.32, sy + 1); g.lineTo(x + PLW * 0.42, sy + PLH - 1);
          g.moveTo(x + PLW * 0.62, sy + 1); g.lineTo(x + PLW * 0.54, sy + PLH - 1); g.stroke();
        }
        g.restore();
        if (p.spring) drawSpring(g, p.x, sy);
      }
      function drawSpring(g, cx, sy) {
        g.save();
        g.strokeStyle = '#ffd23f'; g.lineWidth = 2.4; g.shadowColor = 'rgba(255,210,63,0.7)'; g.shadowBlur = 8;
        g.beginPath();
        var baseY = sy, topY = sy - 12, x0 = cx - 6;
        g.moveTo(x0, baseY);
        g.lineTo(x0 + 12, baseY - 4);
        g.lineTo(x0, baseY - 8);
        g.lineTo(x0 + 12, topY);
        g.stroke();
        g.fillStyle = '#fff1b0';
        roundRect(g, cx - 8, topY - 4, 16, 5, 2); g.fill();
        g.restore();
      }
      function drawFoe(g, fo, now) {
        var sy = fo.y - camTop; if (sy < -FR * 2 || sy > H + FR * 2) return;
        var flap = Math.sin(now / 90) * 0.5 + 0.5;
        g.save();
        g.translate(fo.x, sy);
        g.fillStyle = 'rgba(255,128,152,0.35)';
        g.beginPath(); g.ellipse(-FR * 0.5, -FR * 0.4, FR * 0.9, FR * (0.5 + flap * 0.4), -0.5, 0, TAU); g.fill();
        g.beginPath(); g.ellipse(FR * 0.5, -FR * 0.4, FR * 0.9, FR * (0.5 + flap * 0.4), 0.5, 0, TAU); g.fill();
        g.shadowColor = 'rgba(255,77,109,0.9)'; g.shadowBlur = 16;
        var grd = g.createRadialGradient(0, -FR * 0.3, 2, 0, 0, FR);
        grd.addColorStop(0, '#ff8098'); grd.addColorStop(1, '#c31133');
        g.fillStyle = grd; g.beginPath(); g.arc(0, 0, FR, 0, TAU); g.fill();
        g.shadowBlur = 0;
        g.fillStyle = '#fff';
        g.beginPath(); g.arc(-FR * 0.35, -FR * 0.15, FR * 0.24, 0, TAU); g.fill();
        g.beginPath(); g.arc(FR * 0.35, -FR * 0.15, FR * 0.24, 0, TAU); g.fill();
        g.fillStyle = '#200';
        g.beginPath(); g.arc(-FR * 0.32, -FR * 0.1, FR * 0.12, 0, TAU); g.fill();
        g.beginPath(); g.arc(FR * 0.38, -FR * 0.1, FR * 0.12, 0, TAU); g.fill();
        g.strokeStyle = '#200'; g.lineWidth = 1.6;
        g.beginPath(); g.moveTo(-FR * 0.5, -FR * 0.5); g.lineTo(-FR * 0.15, -FR * 0.3);
        g.moveTo(FR * 0.5, -FR * 0.5); g.lineTo(FR * 0.15, -FR * 0.3); g.stroke();
        g.restore();
      }
      function drawParts(g) {
        var i;
        g.save();
        for (i = 0; i < parts.length; i++) {
          var p = parts[i], sy = p.y - camTop, a = clamp(p.life / p.max, 0, 1);
          if (sy < -10 || sy > H + 10) continue;
          g.globalAlpha = a; g.fillStyle = p.c;
          g.beginPath(); g.arc(p.x, sy, p.r, 0, TAU); g.fill();
        }
        g.globalAlpha = 1; g.restore();
      }
      function drawPlayer(g, now) {
        var sy = py - camTop;
        var since = (now - lastBounceAt) / 1000;
        var pop = Math.max(0, 1 - since / 0.16);
        var stretch = clamp(-vy / 2600, -0.16, 0.26);
        var scaleY = 1 + stretch + 0.30 * pop;
        var scaleX = 1 - 0.7 * stretch - 0.24 * pop;
        var rot = clamp(vx / 950, -0.32, 0.32);
        var faceDir = vx >= 0 ? 1 : -1;
        g.save();
        g.translate(px, sy);
        g.rotate(rot);
        g.scale(scaleX, scaleY);
        /* Schatten/Glühen */
        g.shadowColor = 'rgba(57,255,20,0.85)'; g.shadowBlur = 18;
        var grd = g.createRadialGradient(-PR * 0.3, -PR * 0.4, 2, 0, 0, PR * 1.2);
        grd.addColorStop(0, '#eaffe2'); grd.addColorStop(0.5, '#6dff4d'); grd.addColorStop(1, '#1fae10');
        g.fillStyle = grd;
        g.beginPath(); g.ellipse(0, 0, PR, PR * 1.06, 0, 0, TAU); g.fill();
        g.shadowBlur = 0;
        /* Beinchen */
        g.strokeStyle = '#2f9e2f'; g.lineWidth = 3; g.lineCap = 'round';
        g.beginPath();
        g.moveTo(-PR * 0.5, PR * 0.7); g.lineTo(-PR * 0.9, PR * 1.15);
        g.moveTo(PR * 0.5, PR * 0.7); g.lineTo(PR * 0.9, PR * 1.15);
        g.stroke();
        /* Augen */
        var ex = PR * 0.34, ey = -PR * 0.32;
        g.fillStyle = '#fff';
        g.beginPath(); g.arc(-ex, ey, PR * 0.30, 0, TAU); g.fill();
        g.beginPath(); g.arc(ex, ey, PR * 0.30, 0, TAU); g.fill();
        g.fillStyle = '#04160c';
        var pd = faceDir * PR * 0.11;
        g.beginPath(); g.arc(-ex + pd, ey, PR * 0.15, 0, TAU); g.fill();
        g.beginPath(); g.arc(ex + pd, ey, PR * 0.15, 0, TAU); g.fill();
        /* Fühler */
        g.strokeStyle = '#eaffe2'; g.lineWidth = 1.6;
        g.beginPath();
        g.moveTo(-PR * 0.25, -PR * 0.8); g.lineTo(-PR * 0.5, -PR * 1.25);
        g.moveTo(PR * 0.25, -PR * 0.8); g.lineTo(PR * 0.5, -PR * 1.25);
        g.stroke();
        /* Mund */
        g.strokeStyle = '#0a3316'; g.lineWidth = 2;
        g.beginPath(); g.arc(0, PR * 0.12, PR * 0.34, 0.15 * Math.PI, 0.85 * Math.PI); g.stroke();
        g.restore();
      }
    }
  };

  /* ================= STYLES ================= */
  function injectStyle() {
    UI.injectStyle('mg-doodlejump-css', [
      '.jmp-wrap{display:flex;flex-direction:column;gap:12px;max-width:460px;margin:0 auto;}',
      '.jmp-top{display:flex;justify-content:space-between;align-items:stretch;gap:12px;padding:10px 16px;}',
      '.jmp-stat{display:flex;flex-direction:column;gap:2px;min-width:0;}',
      '.jmp-stat.r{align-items:flex-end;text-align:right;}',
      '.jmp-stat-l{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;}',
      '.jmp-score{font-size:clamp(26px,7vw,40px);font-weight:900;color:var(--neon);text-shadow:0 0 14px rgba(57,255,20,.5);line-height:1;font-variant-numeric:tabular-nums;}',
      '.jmp-best{font-size:clamp(22px,6vw,32px);font-weight:900;color:var(--gold);text-shadow:0 0 12px rgba(255,210,63,.45);line-height:1;font-variant-numeric:tabular-nums;}',
      '.jmp-top .mg-timer{font-size:clamp(20px,5.5vw,30px);font-weight:900;color:var(--aqua);line-height:1;font-variant-numeric:tabular-nums;}',
      '.jmp-top .mg-timer.jmp-urgent{color:var(--danger-2);animation:jmp-pulse .7s infinite;}',
      '.jmp-stage{position:relative;width:100%;max-width:400px;margin:0 auto;}',
      '.jmp-canvas{display:block;width:100%;height:auto;border-radius:18px;border:2px solid rgba(57,255,20,.3);background:#04140c;',
      'box-shadow:0 0 40px rgba(57,255,20,.2),inset 0 0 60px rgba(57,255,20,.05);',
      'touch-action:none;user-select:none;-webkit-user-select:none;-webkit-tap-highlight-color:transparent;cursor:pointer;}',
      '.jmp-overlay{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;text-align:center;padding:20px;border-radius:18px;background:rgba(3,10,6,.74);animation:jmp-fade .25s ease;}',
      '.jmp-overlay.hidden{display:none;}',
      '.jmp-ov-emoji{font-size:52px;filter:drop-shadow(0 0 14px rgba(255,77,109,.5));animation:jmp-bob 1.4s ease-in-out infinite;}',
      '.jmp-ov-t{font-size:26px;font-weight:900;}',
      '.jmp-ov-h{font-size:22px;font-weight:900;color:var(--gold);text-shadow:0 0 12px rgba(255,210,63,.45);}',
      '.jmp-controls{display:flex;gap:12px;align-items:stretch;}',
      '.jmp-ctrl{flex:1;display:flex;align-items:center;justify-content:center;font-size:30px;font-weight:900;padding:15px;border-radius:16px;',
      'border:1px solid var(--stroke-2);background:rgba(9,32,21,.7);color:var(--leaf);cursor:pointer;font-family:inherit;',
      'user-select:none;-webkit-user-select:none;-webkit-tap-highlight-color:transparent;touch-action:none;transition:transform .08s,box-shadow .12s,border-color .12s;}',
      '.jmp-ctrl:active,.jmp-ctrl.on{transform:scale(.97);border-color:var(--neon);box-shadow:0 0 18px rgba(57,255,20,.4),inset 0 0 20px rgba(57,255,20,.14);color:#eaffe2;}',
      '.jmp-hint{text-align:center;line-height:1.5;}',
      '.jmp-board-wrap{padding:12px 14px;display:flex;flex-direction:column;gap:8px;}',
      '.jmp-board-wrap .mg-scoreboard{max-height:260px;overflow-y:auto;}',
      '.jmp-rivals{display:flex;flex-direction:column;gap:6px;}',
      '.jmp-rv-row{display:grid;grid-template-columns:26px 1fr auto;gap:9px;align-items:center;padding:8px 12px;border-radius:11px;',
      'background:rgba(9,32,21,.55);border:1px solid var(--stroke);font-weight:800;transition:border-color .2s;}',
      '.jmp-rv-row.me{border-color:var(--stroke-2);background:linear-gradient(90deg,rgba(57,255,20,.14),rgba(9,32,21,.55));}',
      '.jmp-rv-ic{font-size:17px;line-height:1;}',
      '.jmp-rv-nm{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:13px;color:var(--text);}',
      '.jmp-rv-row.me .jmp-rv-nm{color:var(--aqua);}',
      '.jmp-rv-sc{color:var(--leaf);font-variant-numeric:tabular-nums;font-size:15px;}',
      '@keyframes jmp-pulse{0%,100%{opacity:1}50%{opacity:.4}}',
      '@keyframes jmp-bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-8px)}}',
      '@keyframes jmp-fade{from{opacity:0}to{opacity:1}}'
    ].join(''));
  }
})();
