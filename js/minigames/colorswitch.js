/* colorswitch.js — "Farb-Wechsel": ein Color-Switch-Kletterspiel im Neon-Dschungel.
 *
 *  IDEE
 *    Ein kleiner leuchtender Ball steigt nach oben durch rotierende, vierfarbige
 *    Ring-Hindernisse.  Der Ball darf einen Ring nur an der Stelle passieren, die
 *    gerade SEINE Farbe zeigt (unten, wo er eintritt).  Kleine Farb-Wechsler
 *    zwischen den Ringen tauschen seine Farbe.  Je hoeher, desto schneller drehen
 *    die Ringe und desto enger werden sie ("wird enger/schneller").
 *
 *  STEUERUNG  (ein Knopf, voll touch-tauglich)
 *    Tippen auf die Flaeche  ODER  Leertaste / Pfeil-hoch / Enter  = Sprung.
 *    Schwerkraft zieht den Ball zurueck — im Rhythmus antippen, um zu steigen.
 *
 *  PUNKTE
 *    Jedes komplett durchquerte Hindernis = 1 Punkt.  Falsche Farbe beruehrt oder
 *    unten aus dem Bild fallen = Aus.
 *
 *  SOLO   Rekordjagd gegen best_colorswitch — ein Versuch, dann Endscreen.
 *  MULTI  Alle spielen 2 Minuten gleichzeitig dieselbe (Seed-gleiche) Hindernis-
 *         folge; bei einem Fehler sofort Neustart von unten, gezaehlt wird der
 *         beste Lauf (reportScore(best)).  Live-Rangliste, meiste Punkte gewinnt.
 *
 *  SYNC-MODELL
 *    Der Ablauf ist rein deterministisch aus dem Seed (= startAt aus der Lobby):
 *    Ring-Anordnung, Dreh-Richtung/-Tempo und die Farb-Sequenz haengen nur vom
 *    Seed + Index ab, nie vom Spielstand.  Die Ring-Rotation laeuft ueber die
 *    Wall-Clock (im Multi room.now()), damit auf allen Geraeten zu jedem Zeit-
 *    punkt exakt dieselbe Farbe an derselben Stelle steht -> voellig fair.
 *    Jeder rechnet seine Ball-Physik lokal (echtes dt) und meldet nur seinen
 *    besten Punktestand.  cleanup() beendet rAF, Timer und alle Listener.
 */
(function () {
  'use strict';
  window.App = window.App || {}; App.Minigames = App.Minigames || {};
  var UI = App.UI, el = UI.el;

  injectStyle();

  /* ---- feste Spielfeld-Masse (virtuelle px, Canvas skaliert per CSS) ---- */
  var W = 420, H = 640;
  var TAU = Math.PI * 2, STEP = TAU / 4;         // 4 Farb-Segmente pro Ring
  var GAP = 300;                                  // Weltabstand zwischen Ringen
  var Y0 = 340;                                   // Welt-Y des ersten Rings
  var BR = 13;                                    // Ball-Radius
  var G = 2100;                                   // Schwerkraft (px/s^2)
  var JUMP = 690;                                 // Sprung-Startgeschwindigkeit (px/s, aufwaerts)
  var MAXFALL = 920;                              // maximales Falltempo
  var CAM_START = -0.34 * H;                      // Kamera-Unterkante beim Start
  var CAM_TOP = 0.58 * H;                          // Ball darf max. so hoch aufs Bild
  var DURATION = 120;                             // s Rundenzeit im Multiplayer

  /* Vier Neon-Dschungel-Farben (alle vier stecken in JEDEM Ring, es gibt also
     immer eine passende Oeffnung fuer die aktuelle Ballfarbe). */
  var COLORS = ['#39ff14', '#33e6d0', '#ffd23f', '#ff4d6d'];
  var GLOW = ['rgba(57,255,20,.92)', 'rgba(51,230,208,.92)', 'rgba(255,210,63,.92)', 'rgba(255,77,109,.92)'];

  /* Deterministischer Hash -> [0,1). Math.imul haelt die Multiplikation exakt
     im 32-Bit-Bereich, damit alle Geraete dieselbe Zahl bekommen. */
  function seedFor(seed, i, salt) {
    var h = Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b);
    h = Math.imul(h ^ (i | 0), 0xc2b2ae35);
    h = Math.imul(h ^ (salt | 0), 0x27d4eb2f);
    h ^= h >>> 15; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13;
    return (h >>> 0) / 4294967296;
  }
  function normAngle(a) { a = a % TAU; if (a < 0) a += TAU; return a; }

  App.Minigames.colorswitch = {
    id: 'colorswitch', title: 'Farb-Wechsel', icon: '🎨', order: 144,
    subtitle: 'Springe durch die richtige Farbe hinauf!',
    single: true, multi: true, minPlayers: 2, maxPlayers: 8,

    render: function (root, ctx) {
      var isMulti = ctx.mode === 'multi';
      var nowFn = isMulti ? function () { return ctx.room.now(); } : function () { return Date.now(); };

      /* ---- Laufzeit / Aufraeumen ---- */
      var dead = false, raf = null, last = 0;
      var stops = [], timers = [], listeners = [];
      function after(ms, fn) { var t = setTimeout(function () { if (!dead) fn(); }, ms); timers.push(t); return t; }
      function clearTimers() { timers.forEach(clearTimeout); timers = []; }
      function stopHelpers() { stops.forEach(function (f) { try { f(); } catch (e) {} }); stops = []; }
      function addL(target, type, fn, opts) { target.addEventListener(type, fn, opts); listeners.push({ t: target, ty: type, fn: fn, opts: opts }); }
      function removeListeners() { listeners.forEach(function (l) { try { l.t.removeEventListener(l.ty, l.fn, l.opts); } catch (e) {} }); listeners = []; }
      function cleanup() {
        dead = true;
        if (raf) { cancelAnimationFrame(raf); raf = null; }
        clearTimers(); stopHelpers(); removeListeners();
      }
      function report() { if (isMulti) { try { ctx.room.reportScore(best); } catch (e) {} } }

      /* ---- Spielzustand (in play() frisch gesetzt) ---- */
      var g2d = null, refs = null, seed = 0, startAt = 0, endAt = 0;
      var phase = 'ready';                 // 'ready' | 'run' | 'dead' | 'over'
      var ball = { wy: 0, vy: 0, colorIdx: 0 };
      var camBottom = CAM_START;
      var runScore = 0, best = 0, bestAtStart = 0, prevColor = 0;
      var obsCache = {}, colorSeq = [0], trail = [], parts = [], board = null;

      /* ================= Start ================= */
      if (isMulti) {
        var snap = ctx.room.snapshot() || {};
        startAt = (snap.round && snap.round.startAt) || (ctx.room.now() + 3000);
        stops.push(App.MG.countdown(root, startAt, function () { play(startAt); }, ctx.room.now));
      } else {
        play(Date.now());
      }
      return { cleanup: cleanup };

      /* ================= Aufbau einer Partie ================= */
      function play(sAt) {
        clearTimers(); stopHelpers(); removeListeners();
        startAt = sAt;
        seed = (Math.floor(sAt / 100) >>> 0) || 1;   // grober Seed -> gleich auf allen Geraeten
        endAt = sAt + DURATION * 1000;
        obsCache = {}; colorSeq = [0]; trail = []; parts = [];
        runScore = 0; best = 0; prevColor = 0;
        bestAtStart = isMulti ? 0 : App.Storage.get('best_colorswitch', 0);
        resetBall(false);
        phase = 'ready';

        buildDom();
        attachInput();

        /* Rundenzeit nur im Multiplayer (Solo laeuft bis zum ersten Fehler). */
        if (isMulti) {
          report();
          stops.push(App.MG.roundTimer(endAt, function (leftSec) {
            if (refs.timer) { refs.timer.textContent = App.MG.mmss(leftSec); refs.timer.classList.toggle('csw-urgent', leftSec <= 10); }
          }, finish, ctx.room.now));
        }

        if (isMulti && App.Audio) App.Audio.sfx('start');
        last = nowFn();
        raf = requestAnimationFrame(frame);
      }

      function resetBall(autoHop) {
        ball.wy = 0; ball.vy = autoHop ? JUMP : 0; ball.colorIdx = colorAt(0);
        camBottom = CAM_START; trail = [];
      }

      /* ================= DOM ================= */
      function buildDom() {
        var scoreEl = el('div', { class: 'csw-score' }, ['0']);
        var scoreSub = el('div', { class: 'csw-sub' }, [isMulti ? '🏆 Best 0' : 'Steig so hoch du kannst']);
        var dot = el('div', { class: 'csw-dot' });
        var rightVal = el('div', { class: 'csw-right ' + (isMulti ? 'mg-timer' : '') }, [isMulti ? App.MG.mmss(DURATION) : App.MG.fmt(bestAtStart)]);
        var head = el('div', { class: 'csw-head glass' }, [
          el('div', { class: 'csw-cell' }, [el('span', { class: 'csw-l' }, ['Punkte']), scoreEl, scoreSub]),
          el('div', { class: 'csw-cell csw-mid' }, [el('span', { class: 'csw-l' }, ['Farbe']), dot]),
          el('div', { class: 'csw-cell csw-r' }, [el('span', { class: 'csw-l' }, [isMulti ? 'Zeit' : 'Rekord']), rightVal])
        ]);

        var canvas = el('canvas', { class: 'csw-canvas', width: W, height: H, 'aria-label': 'Spielfeld' });
        var stage = el('div', { class: 'csw-stage' }, [canvas]);
        var hint = el('div', { class: 'csw-hint hint-text' }, ['Tippen / Leertaste = Springen · nur durch deine Farbe · falsche Farbe = Aus']);

        var boardWrap = null;
        if (isMulti) {
          board = App.MG.liveBoard(ctx.room, ctx.me.id);
          stops.push(board.stop);
          boardWrap = el('div', { class: 'csw-board glass' }, [
            el('div', { class: 'mg-field-title' }, ['🏆 Rangliste']), board.root
          ]);
        }

        var wrap = el('div', { class: 'csw-wrap' }, [head, stage, hint, boardWrap]);
        root.innerHTML = ''; root.appendChild(wrap);
        g2d = canvas.getContext('2d');
        refs = { canvas: canvas, score: scoreEl, scoreSub: scoreSub, dot: dot, timer: isMulti ? rightVal : null, right: rightVal };
        paintHud();
      }

      function paintHud() {
        refs.score.textContent = App.MG.fmt(runScore);
        refs.dot.style.background = COLORS[ball.colorIdx];
        refs.dot.style.boxShadow = '0 0 12px ' + GLOW[ball.colorIdx];
        if (isMulti) refs.scoreSub.textContent = '🏆 Best ' + App.MG.fmt(best);
        else refs.right.textContent = App.MG.fmt(Math.max(bestAtStart, runScore));
      }
      function bumpScore() { refs.score.classList.remove('csw-bump'); void refs.score.offsetWidth; refs.score.classList.add('csw-bump'); }

      /* ================= Eingabe ================= */
      function attachInput() {
        var onDown = function (e) { if (e && e.preventDefault) e.preventDefault(); tap(); };
        addL(refs.canvas, 'pointerdown', onDown);
        var onKey = function (e) {
          if (e.code === 'Space' || e.key === ' ' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === 'w' || e.key === 'W') {
            e.preventDefault(); tap();
          }
        };
        addL(document, 'keydown', onKey);
      }
      function tap() {
        if (dead || phase === 'dead' || phase === 'over') return;
        if (phase === 'ready') { phase = 'run'; ball.vy = JUMP; jumpFx(); return; }
        if (phase === 'run') { ball.vy = JUMP; jumpFx(); }
      }
      function jumpFx() {
        if (App.Audio) App.Audio.blip(320 + Math.random() * 60, 0.06, { type: 'sine', peak: 0.05 });
        var i, a;
        for (i = 0; i < 4; i++) { a = TAU * Math.random(); spawn(ball.wy - BR, W / 2 + Math.cos(a) * 6, Math.cos(a) * 40, -60 - Math.random() * 60, 3, ball.colorIdx, 0.35); }
      }

      /* ================= deterministische Welt ================= */
      function colorAt(k) {                            // Ballfarbe nach k Wechslern
        if (k < 0) k = 0;
        while (colorSeq.length <= k) {
          var idx = colorSeq.length, prev = colorSeq[idx - 1];
          var c = Math.floor(seedFor(seed, idx, 7) * 3);   // 0..2
          if (c >= prev) c += 1;                            // ungleich der vorigen Farbe
          colorSeq.push(c);
        }
        return colorSeq[k];
      }
      function switchersBelow(wy) { return Math.max(0, Math.floor((wy - Y0) / GAP + 0.5)); }
      function arcOrder(i) {                            // Permutation von [0,1,2,3]
        var a = [0, 1, 2, 3], j, k, tmp;
        for (j = 3; j > 0; j--) { k = Math.floor(seedFor(seed, i, 20 + j) * (j + 1)); tmp = a[j]; a[j] = a[k]; a[k] = tmp; }
        return a;
      }
      function getObs(i) {
        if (obsCache[i]) return obsCache[i];
        var o = {
          wy: Y0 + i * GAP,
          R: Math.max(70, 106 - i * 1.7),               // wird enger
          T: 24,
          dir: seedFor(seed, i, 1) < 0.5 ? -1 : 1,
          baseRot: seedFor(seed, i, 2) * TAU,
          spin: Math.min(2.7, 0.55 + i * 0.12),         // wird schneller
          arc: arcOrder(i),
          passed: false
        };
        obsCache[i] = o; return o;
      }
      function rotOf(o, tSec) { return o.baseRot + o.dir * o.spin * tSec; }
      function slotAt(o, angle, tSec) { return Math.floor(normAngle(angle - rotOf(o, tSec) + STEP / 2) / STEP) % 4; }

      /* ================= Frame-Loop ================= */
      function frame() {
        if (dead || phase === 'over') { raf = null; return; }
        var now = nowFn();
        var dt = (now - last) / 1000; if (dt < 0) dt = 0; if (dt > 0.03) dt = 0.03; last = now;
        var tSec = (now - startAt) / 1000;

        if (phase === 'run') {
          ball.vy -= G * dt;
          if (ball.vy < -MAXFALL) ball.vy = -MAXFALL;
          ball.wy += ball.vy * dt;

          if (ball.wy - camBottom > CAM_TOP) camBottom = ball.wy - CAM_TOP;

          updateColor();
          checkObstacles(tSec);                                    // ruft ggf. die() -> phase 'dead'
          if (phase === 'run' && ball.wy < camBottom - BR - 6) die();
          if (phase === 'run') { trail.push(ball.wy); if (trail.length > 12) trail.shift(); }
        }

        /* Loop laeuft auch waehrend 'dead' weiter: Explosion animiert, dann
           Respawn (Multi) bzw. Endscreen (Solo) uebernehmen. */
        updateParts(dt);
        drawScene(tSec);
        if (phase === 'over') { raf = null; return; }
        raf = requestAnimationFrame(frame);
      }

      function updateColor() {
        var c = colorAt(switchersBelow(ball.wy));
        if (c !== ball.colorIdx) {
          ball.colorIdx = c;
          if (c !== prevColor && phase === 'run') {
            prevColor = c;
            if (App.Audio) App.Audio.sfx('powerup');
            var i, a; for (i = 0; i < 10; i++) { a = TAU * Math.random(); spawn(ball.wy, W / 2, Math.cos(a) * 120, Math.sin(a) * 120, 3, i % 4, 0.5); }
          }
        }
      }

      /* Gibt true zurueck, wenn der Ball an einem Ring gestorben ist. */
      function checkObstacles(tSec) {
        var lo = Math.floor((camBottom - 160 - Y0) / GAP);
        var hi = Math.ceil((camBottom + H + 160 - Y0) / GAP);
        if (lo < 0) lo = 0;
        for (var i = lo; i <= hi; i++) {
          var o = getObs(i);
          if (o.passed) continue;
          if (ball.wy > o.wy + o.R + BR) {           // Ring komplett durchquert
            o.passed = true; runScore++;
            if (runScore > best) { best = runScore; report(); }
            bumpScore(); paintHud();
            if (App.Audio) App.Audio.sfx('point');
            var j, a; for (j = 0; j < 12; j++) { a = TAU * Math.random(); spawn(o.wy, W / 2 + Math.cos(a) * 8, Math.cos(a) * 150, Math.sin(a) * 150, 3.5, ball.colorIdx, 0.55); }
            continue;
          }
          var d = o.wy - ball.wy;                    // >0: Ball noch unterhalb (Eintritt)
          if (d > 0 && Math.abs(d - o.R) <= BR + o.T / 2 + 6) {
            if (o.arc[slotAt(o, Math.PI / 2, tSec)] !== ball.colorIdx) { die(); return true; }
          }
        }
        return false;
      }

      function die() {
        if (phase !== 'run') return;
        phase = 'dead';
        var i, a; for (i = 0; i < 28; i++) { a = TAU * Math.random(); var sp = 80 + Math.random() * 240; spawn(ball.wy, W / 2, Math.cos(a) * sp, Math.sin(a) * sp, 4, i % 5 < 4 ? i % 4 : ball.colorIdx, 0.7); }
        if (App.Audio) App.Audio.sfx('explosion');
        report();
        if (isMulti) after(1300, respawn); else after(850, endSolo);
      }
      function respawn() {
        if (dead || phase === 'over') return;
        obsCache = {}; colorSeq = [0]; prevColor = 0; runScore = 0;
        resetBall(true); ball.colorIdx = colorAt(0);
        paintHud(); phase = 'run';
        if (App.Audio) App.Audio.sfx('start');
      }

      /* ================= Partikel ================= */
      function spawn(wy, x, vx, vyw, r, colIdx, life) { parts.push({ x: x, wy: wy, vx: vx, vyw: vyw, r: r, c: colIdx, life: life, max: life }); }
      function updateParts(dt) {
        for (var i = parts.length - 1; i >= 0; i--) {
          var p = parts[i];
          p.life -= dt;
          if (p.life <= 0) { parts.splice(i, 1); continue; }
          p.x += p.vx * dt; p.wy += p.vyw * dt; p.vyw -= 620 * dt;
        }
      }

      /* ================= Zeichnen ================= */
      function screenY(wy) { return H - (wy - camBottom); }

      function drawScene(tSec) {
        var g = g2d; if (!g) return;
        g.clearRect(0, 0, W, H);
        var grd = g.createLinearGradient(0, 0, 0, H);
        grd.addColorStop(0, '#06180e'); grd.addColorStop(1, '#020c07');
        g.fillStyle = grd; g.fillRect(0, 0, W, H);
        drawSpores();

        var lo = Math.floor((camBottom - 200 - Y0) / GAP);
        var hi = Math.ceil((camBottom + H + 200 - Y0) / GAP);
        if (lo < 0) lo = 0;
        var i;
        for (i = lo; i <= hi; i++) { if (i >= 1) drawSwitcher(i, tSec); drawRing(getObs(i), tSec); }

        drawTrail();
        drawBall(tSec);
        drawParts();

        if (phase === 'ready') drawCenterText('TIPP zum Start', 'Halte den Ball in seiner Farbe oben', tSec, false);
        else if (phase === 'dead' && isMulti) drawCenterText('💥 Falsche Farbe!', 'Neustart … · Best ' + App.MG.fmt(best), tSec, true);
      }

      function drawSpores() {
        var g = g2d;
        var base = Math.floor((camBottom - 120) / 96), top = Math.ceil((camBottom + H + 120) / 96);
        g.save();
        for (var n = base; n <= top; n++) {
          var sy = screenY(n * 96 + seedFor(seed | 7, n, 33) * 60);
          var sx = seedFor(seed | 7, n, 34) * W;
          g.fillStyle = 'rgba(157,255,122,' + (0.05 + seedFor(seed | 7, n, 35) * 0.06).toFixed(3) + ')';
          g.beginPath(); g.arc(sx, sy, 1.6 + seedFor(seed | 7, n, 36) * 2.2, 0, TAU); g.fill();
        }
        g.restore();
      }

      function drawRing(o, tSec) {
        var g = g2d, cy = screenY(o.wy);
        if (cy < -o.R - 40 || cy > H + o.R + 40) return;
        var rot = rotOf(o, tSec), k, ca;
        g.save(); g.lineWidth = o.T; g.lineCap = 'butt';
        for (k = 0; k < 4; k++) {
          ca = k * STEP + rot;
          g.strokeStyle = COLORS[o.arc[k]];
          g.shadowColor = GLOW[o.arc[k]]; g.shadowBlur = 12;
          g.beginPath(); g.arc(W / 2, cy, o.R, ca - STEP / 2, ca + STEP / 2); g.stroke();
        }
        g.restore();
        /* dezenter Marker am Eintritt (unten), zeigt die Pruef-Stelle */
        g.save();
        g.fillStyle = 'rgba(255,255,255,.16)';
        g.beginPath(); g.moveTo(W / 2, cy + o.R + o.T / 2 + 10); g.lineTo(W / 2 - 7, cy + o.R + o.T / 2 + 20); g.lineTo(W / 2 + 7, cy + o.R + o.T / 2 + 20); g.closePath(); g.fill();
        g.restore();
      }

      function drawSwitcher(i, tSec) {
        var wy = Y0 + (i - 0.5) * GAP, cy = screenY(wy);
        if (cy < -30 || cy > H + 30) return;
        var g = g2d, rr = 15, rot = tSec * 1.4, k, ca;
        g.save(); g.translate(W / 2, cy);
        for (k = 0; k < 4; k++) {
          ca = k * STEP + rot;
          g.fillStyle = COLORS[k];
          g.beginPath(); g.moveTo(0, 0); g.arc(0, 0, rr, ca - STEP / 2, ca + STEP / 2); g.closePath();
          g.globalAlpha = 0.9; g.fill();
        }
        g.globalAlpha = 1; g.strokeStyle = 'rgba(234,255,226,.7)'; g.lineWidth = 2;
        g.beginPath(); g.arc(0, 0, rr + 2, 0, TAU); g.stroke();
        g.restore();
      }

      function drawTrail() {
        var g = g2d, i;
        g.save();
        for (i = 0; i < trail.length; i++) {
          var a = (i + 1) / trail.length;
          g.fillStyle = 'rgba(234,255,226,' + (a * 0.22).toFixed(3) + ')';
          g.beginPath(); g.arc(W / 2, screenY(trail[i]), BR * (0.3 + a * 0.6), 0, TAU); g.fill();
        }
        g.restore();
      }

      function drawBall(tSec) {
        var g = g2d;
        var wy = ball.wy;
        if (phase === 'ready') wy += Math.sin(tSec * 3) * 8;    // sanftes Schweben
        var cy = screenY(wy);
        g.save();
        g.shadowColor = GLOW[ball.colorIdx]; g.shadowBlur = 26;
        g.fillStyle = COLORS[ball.colorIdx];
        g.beginPath(); g.arc(W / 2, cy, BR, 0, TAU); g.fill();
        g.shadowBlur = 0; g.fillStyle = 'rgba(255,255,255,.55)';
        g.beginPath(); g.arc(W / 2 - 4, cy - 4, BR * 0.34, 0, TAU); g.fill();
        g.restore();
      }

      function drawParts() {
        var g = g2d, i;
        g.save();
        for (i = 0; i < parts.length; i++) {
          var p = parts[i], a = p.life / p.max;
          g.globalAlpha = Math.max(0, a);
          g.fillStyle = COLORS[p.c];
          g.beginPath(); g.arc(p.x, screenY(p.wy), p.r * (0.4 + a * 0.9), 0, TAU); g.fill();
        }
        g.restore();
      }

      function drawCenterText(title, sub, tSec, warn) {
        var g = g2d, pulse = 0.75 + Math.sin(tSec * 4) * 0.25;
        g.save();
        g.textAlign = 'center'; g.textBaseline = 'middle';
        g.globalAlpha = warn ? 1 : pulse;
        g.shadowBlur = 18; g.shadowColor = warn ? 'rgba(255,77,109,.7)' : 'rgba(57,255,20,.7)';
        g.fillStyle = warn ? '#ff8098' : '#eaffe2';
        g.font = '900 32px "Segoe UI",system-ui,Roboto,Arial,sans-serif';
        g.fillText(title, W / 2, H * 0.42);
        g.globalAlpha = 0.9; g.shadowBlur = 0; g.fillStyle = 'rgba(157,255,122,.9)';
        g.font = '700 15px "Segoe UI",system-ui,Roboto,Arial,sans-serif';
        g.fillText(sub, W / 2, H * 0.42 + 30);
        g.restore();
      }

      /* ================= Ende ================= */
      function endSolo() {
        if (phase === 'over') return; phase = 'over';
        if (raf) { cancelAnimationFrame(raf); raf = null; }
        stopHelpers();
        var nb = runScore > bestAtStart;
        if (nb) App.Storage.set('best_colorswitch', runScore);
        App.MG.endScreen(root, {
          score: runScore, best: bestAtStart, newBest: nb,
          label: nb ? 'Neuer Rekord! 🎉' : 'Rekord: ' + App.MG.fmt(bestAtStart) + ' · durchquerte Ringe',
          onExit: ctx.onExit,
          onAgain: function () { if (!dead) play(Date.now()); }
        });
      }
      function finish() {
        if (phase === 'over') return; phase = 'over';
        if (raf) { cancelAnimationFrame(raf); raf = null; }
        report();
        if (App.Audio) App.Audio.sfx('win');
        after(500, function () {
          if (dead) return;
          App.MG.endScreen(root, { players: ctx.room.players(), meId: ctx.me.id, onExit: ctx.onExit });
        });
      }
    }
  };

  /* ===================== STYLES ===================== */
  function injectStyle() {
    UI.injectStyle('mg-colorswitch-css', [
      '.csw-wrap{display:flex;flex-direction:column;gap:12px;align-items:stretch;}',
      '.csw-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 18px;}',
      '.csw-cell{display:flex;flex-direction:column;gap:2px;min-width:0;}',
      '.csw-mid{align-items:center;}',
      '.csw-r{text-align:right;align-items:flex-end;}',
      '.csw-l{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:1px;}',
      '.csw-score{font-size:clamp(26px,7vw,42px);font-weight:900;color:var(--gold);text-shadow:0 0 12px rgba(255,210,63,.45);line-height:1;font-variant-numeric:tabular-nums;}',
      '.csw-score.csw-bump{animation:csw-bump .3s ease;}',
      '.csw-sub{font-size:11px;color:var(--leaf);font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      '.csw-dot{width:30px;height:30px;border-radius:50%;background:var(--neon);border:2px solid rgba(255,255,255,.35);box-shadow:0 0 12px var(--stroke-2);transition:background .15s,box-shadow .15s;}',
      '.csw-right{font-size:clamp(20px,5.5vw,30px);font-weight:900;color:var(--aqua);text-shadow:0 0 12px rgba(51,230,208,.4);line-height:1;font-variant-numeric:tabular-nums;}',
      '.csw-right.mg-timer.csw-urgent{color:var(--danger-2);animation:csw-pulse .7s infinite;}',
      '.csw-stage{width:min(100%,40.5vh,380px);aspect-ratio:420 / 640;margin:0 auto;position:relative;}',
      '.csw-canvas{display:block;width:100%;height:100%;border-radius:20px;',
      'border:2px solid rgba(57,255,20,.35);background:#04140c;',
      'box-shadow:0 0 42px rgba(57,255,20,.22),inset 0 0 60px rgba(57,255,20,.06);',
      'touch-action:none;user-select:none;-webkit-user-select:none;-webkit-tap-highlight-color:transparent;cursor:pointer;}',
      '.csw-hint{text-align:center;}',
      '.csw-board{padding:12px 14px;display:flex;flex-direction:column;gap:8px;}',
      '.csw-board .mg-scoreboard{max-height:220px;overflow-y:auto;}',
      '@keyframes csw-bump{0%{transform:scale(1)}40%{transform:scale(1.22)}100%{transform:scale(1)}}',
      '@keyframes csw-pulse{0%,100%{opacity:1}50%{opacity:.4}}'
    ].join(''));
  }
})();
