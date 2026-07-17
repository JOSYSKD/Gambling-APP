/* archery.js — "Bogen-Duell": Bogenschiessen im Neon-Dschungel.
 *
 * IDEE
 *   Links steht der Bogen, rechts eine leuchtende Zielscheibe (Ringe 1–10 + Bullseye).
 *   Ziehen & loslassen schiesst den Pfeil als Parabel. Schwerkraft zieht ihn nach unten,
 *   der oben angezeigte Wind schiebt ihn hoch (↑) oder runter (↓). Je näher an der Mitte,
 *   desto mehr Punkte (max 10, Bullseye = 10 mit Extra-Effekt). Pfeile bleiben stecken.
 *   3 Runden à 5 Pfeilen = 15 Schüsse; von Runde zu Runde wird die Scheibe kleiner,
 *   der Wind stärker und ab Runde 3 wandert das Ziel auf und ab.
 *
 * STEUERUNG
 *   Maus/Finger: irgendwo auf der Fläche packen und nach hinten (unten/links) ziehen –
 *     Richtung = Zielwinkel, Zug-Länge = Spannung/Power. Loslassen schiesst.
 *     Eine gepunktete Flugbahn-Vorschau zeigt, wohin der Pfeil fliegt.
 *   Tastatur (optional): ↑/↓ Winkel, ←/→ Power, Leertaste/Enter schiessen.
 *
 * PUNKTE
 *   Trefferwert nach Abstand zur Mitte (10 innen … 1 aussen), Summe über alle 15 Pfeile.
 *
 * SYNC-MODELL
 *   Rundenbasiertes Punkte-Rennen (parallel). Alle bekommen denselben Seed aus
 *   snapshot().round.startAt -> identische Wind-/Scheiben-Abfolge (fair). Jeder schiesst
 *   in seinem Tempo, meldet die laufende Summe per room.reportScore(); Live-Rangliste
 *   über App.MG.liveBoard, Ende über App.MG.endScreen. Das wandernde Ziel schwingt über
 *   room.now() (synchron). SOLO: Punktejagd gegen best_archery + zwei plausible Bots.
 *   Timer/Animation laufen über Wall-Clock (Date.now/room.now), rAF nur zum Zeichnen.
 */
(function () {
  'use strict';
  window.App = window.App || {}; App.Minigames = App.Minigames || {};
  var UI = App.UI, el = UI.el;

  /* ---- Virtuelles Spielfeld (Canvas skaliert per CSS) ---- */
  var W = 900, H = 560;
  var GROUND = H - 46;
  var ANCHOR_X = 104, ANCHOR_Y = H * 0.60;   // Abschusspunkt (Bogen)
  var TARGET_X = W - 116;                     // Ebene der Zielscheibe
  var BASE_CY = H * 0.40;                     // Grund-Höhe der Scheibenmitte
  var G = 980;                               // Schwerkraft px/s^2
  var MAX_PULL = 230;                        // virtuelle px Zuglänge = volle Power
  var MIN_SPEED = 360, MAX_SPEED = 1160;     // Abschussgeschwindigkeit px/s
  var ROUNDS = 3, ARROWS_PER_ROUND = 5;
  var AIM_TIME = 15000;                      // ms Zielzeit je Pfeil (dann Auto-Schuss)

  injectStyle();

  App.Minigames.archery = {
    id: 'archery', title: 'Bogen-Duell', icon: '🏹', order: 152,
    subtitle: 'Zielen, spannen, treffen – Wind beachten!',
    single: true, multi: true, minPlayers: 2, maxPlayers: 6,

    render: function (root, ctx) {
      var isMulti = ctx.mode === 'multi';
      var timeNow = isMulti ? function () { return ctx.room.now(); } : function () { return Date.now(); };

      /* ---- Aufräum-Infrastruktur (wie reflex/pong) ---- */
      var dead = false, raf = null, last = 0;
      var stops = [], pending = [], listeners = [];
      function after(ms, fn) { var t = setTimeout(function () { if (!dead) fn(); }, ms); pending.push(t); return t; }
      function clearPending() { pending.forEach(clearTimeout); pending = []; }
      function stopHelpers() { stops.forEach(function (f) { try { f(); } catch (e) {} }); stops = []; }
      function addL(t, ty, fn, opts) { t.addEventListener(ty, fn, opts); listeners.push({ t: t, ty: ty, fn: fn, opts: opts }); }
      function removeAllListeners() { listeners.forEach(function (l) { try { l.t.removeEventListener(l.ty, l.fn, l.opts); } catch (e) {} }); listeners = []; }
      function cleanup() {
        dead = true;
        if (raf) { cancelAnimationFrame(raf); raf = null; }
        clearPending(); stopHelpers(); removeAllListeners();
      }

      /* ---- Laufzeit-Zustand ---- */
      var canvas = null, g2 = null;
      var roundChip, arrowChip, scoreChip, windChip, timerChip, boardRoot, hint;
      var rounds = [], cur = null, roundIdx = 0, arrowIdx = 0, totalScore = 0;
      var ph = 'aim';                     // 'aim' | 'fly' | 'land' | 'over'
      var aimAngle = 0.62, aimPower = 0.66;
      var dragging = false, dragMoved = false, downP = { x: 0, y: 0 };
      var aimDeadline = 0;
      var flyArrow = null, trail = [], stuckArrows = [];
      var landInfo = null;                // schwebender Ergebnis-Text
      var leaves = [];                    // Wind-Blätter (Deko)
      var bots = [];                      // nur Solo

      /* ================= Start ================= */
      if (isMulti) {
        var snap = ctx.room.snapshot() || {};
        var startAt = (snap.round && snap.round.startAt) || (ctx.room.now() + 3000);
        stops.push(App.MG.countdown(root, startAt, function () { play(startAt); }, ctx.room.now));
      } else {
        play(Date.now());
      }
      return { cleanup: cleanup };

      /* ================= Aufbau + Rundenlogik ================= */
      function play(startAt) {
        clearPending(); stopHelpers();
        rounds = buildRounds(Math.floor(startAt) >>> 0);
        roundIdx = 0; arrowIdx = 0; totalScore = 0;
        aimAngle = 0.62; aimPower = 0.66;
        stuckArrows = []; trail = []; flyArrow = null; landInfo = null; ph = 'aim';

        buildStage();
        initLeaves();
        if (!isMulti) {
          bots = [
            { name: 'Robin 🎯', skill: 8.7, score: 0 },
            { name: 'Willi 🏹', skill: 6.9, score: 0 }
          ];
          updateSoloBoard();
        }

        attachInput();
        if (App.Audio) App.Audio.sfx('start');
        if (isMulti) ctx.room.reportScore(0);

        beginRound(0);
        last = timeNow();
        raf = requestAnimationFrame(frame);
      }

      function beginRound(r) {
        roundIdx = r; arrowIdx = 0; cur = rounds[r];
        stuckArrows = [];
        updateHud();
        beginArrow();
      }
      function beginArrow() {
        ph = 'aim';
        flyArrow = null; trail = []; landInfo = null; dragging = false; dragMoved = false;
        aimDeadline = timeNow() + AIM_TIME;
        updateHud();
      }
      function advance() {
        if (dead) return;
        arrowIdx++;
        if (arrowIdx >= ARROWS_PER_ROUND) {
          if (roundIdx + 1 >= ROUNDS) return finish();
          if (App.Audio) App.Audio.sfx('levelup');
          beginRound(roundIdx + 1);
        } else {
          beginArrow();
        }
      }

      /* ================= Schuss + Treffer ================= */
      function aimVec() { var a = clampAng(aimAngle); return { x: Math.cos(a), y: -Math.sin(a) }; }
      function clampAng(a) { if (a > 1.45) a = 1.45; if (a < -0.5) a = -0.5; return a; }

      function fire() {
        if (ph !== 'aim') return;
        var dir = aimVec();
        if (dir.x < 0.06) dir = { x: 0.2, y: dir.y };   // niemals nach hinten
        var pw = aimPower; if (pw < 0) pw = 0; if (pw > 1) pw = 1;
        var speed = MIN_SPEED + pw * (MAX_SPEED - MIN_SPEED);
        flyArrow = { x: ANCHOR_X, y: ANCHOR_Y, px: ANCHOR_X, py: ANCHOR_Y, vx: dir.x * speed, vy: dir.y * speed, t0: timeNow() };
        trail = []; dragging = false; ph = 'fly';
        if (App.Audio) { App.Audio.sfx('whoosh'); App.Audio.sweep(280, 760, 0.14); }
      }

      function stepArrow(dt, now) {
        var a = flyArrow;
        a.px = a.x; a.py = a.y;
        a.vy += (G + cur.windAy) * dt;
        a.x += a.vx * dt; a.y += a.vy * dt;
        trail.push({ x: a.x, y: a.y }); if (trail.length > 18) trail.shift();

        // Zielscheiben-Ebene durchflogen?
        if (a.px < TARGET_X && a.x >= TARGET_X) {
          var f = (a.x - a.px) !== 0 ? (TARGET_X - a.px) / (a.x - a.px) : 0;
          var iy = a.py + (a.y - a.py) * f;
          var cy = curCY(now);
          var dist = Math.abs(iy - cy);
          if (dist <= cur.rMax) {
            var bull = dist <= cur.rMax * 0.085;
            var sc = bull ? 10 : scoreFor(dist);
            var ang = Math.atan2(a.vy, a.vx);
            landArrow(sc, { onTarget: true, offY: iy - cy, ang: ang }, TARGET_X, iy, bull);
            return;
          }
        }
        // Boden getroffen -> Fehlschuss, bleibt stecken
        if (a.y >= GROUND) {
          var gx = Math.max(6, Math.min(W - 6, a.x));
          landArrow(0, { onTarget: false, x: gx, y: GROUND, ang: Math.atan2(a.vy, a.vx) }, gx, GROUND, false);
          return;
        }
        // aus dem Bild / zu lange -> Fehlschuss ohne Steckpfeil
        if (a.x > W + 40 || a.x < -40 || a.y < -900 || (now - a.t0) > 6000) {
          landArrow(0, null, a.x, a.y, false);
          return;
        }
      }

      function scoreFor(dist) {
        var band = Math.floor(dist / (cur.rMax / 10));
        var v = 10 - band; if (v < 1) v = 1; if (v > 10) v = 10; return v;
      }

      function landArrow(score, stuck, ix, iy, bull) {
        totalScore += score;
        if (stuck) stuckArrows.push(stuck);
        landInfo = { score: score, bull: !!bull, miss: score <= 0, at: timeNow(), x: ix, y: iy };
        ph = 'land';
        if (App.Audio) {
          if (bull) App.Audio.sfx('jackpot');
          else if (score >= 8) App.Audio.sfx('ding');
          else if (score > 0) App.Audio.sfx('point');
          else App.Audio.sfx('error');
        }
        updateHud();
        if (isMulti) {
          ctx.room.reportScore(totalScore);
        } else {
          bots.forEach(function (b) { b.score += botArrow(b, roundIdx); });
          updateSoloBoard();
        }
        after(950, advance);
      }

      /* ================= Frame-Loop ================= */
      function frame() {
        if (dead) { raf = null; return; }
        var now = timeNow();
        var dt = (now - last) / 1000; if (dt < 0) dt = 0; if (dt > 0.045) dt = 0.045; last = now;

        if (ph === 'fly' && flyArrow) stepArrow(dt, now);
        if (ph === 'aim') {
          var left = Math.ceil((aimDeadline - now) / 1000); if (left < 0) left = 0;
          if (timerChip.textContent !== '⏱ ' + left) {
            timerChip.textContent = '⏱ ' + left;
            timerChip.className = 'arc-chip arc-timer' + (left <= 5 ? ' arc-urgent' : '');
          }
          if (now >= aimDeadline) fire();
        }
        updateWind(dt, now);
        drawScene(now);
        raf = requestAnimationFrame(frame);
      }

      function curCY(now) {
        return BASE_CY + (cur.moveAmp ? cur.moveAmp * Math.sin(now / cur.movePeriod * Math.PI * 2 + cur.movePhase) : 0);
      }

      /* ================= Wind-Deko ================= */
      function initLeaves() {
        leaves = [];
        for (var i = 0; i < 8; i++) {
          leaves.push({ x: Math.random() * W, y: Math.random() * H, ph: Math.random() * 6.28, s: 10 + Math.random() * 8 });
        }
      }
      function updateWind(dt, now) {
        var w = cur ? cur.windAy : 0;
        for (var i = 0; i < leaves.length; i++) {
          var lf = leaves[i];
          lf.y += (w * 0.13) * dt + Math.sin(now / 700 + lf.ph) * 0.35;
          lf.x += (12 + Math.sin(now / 1200 + lf.ph) * 8) * dt;
          if (lf.x > W + 12) lf.x = -12; if (lf.x < -12) lf.x = W + 12;
          if (lf.y > H + 12) lf.y = -12; if (lf.y < -12) lf.y = H + 12;
        }
      }

      /* ================= Zeichnen ================= */
      function drawScene(now) {
        var g = g2; if (!g) return;
        g.clearRect(0, 0, W, H);
        // Hintergrund
        var grd = g.createLinearGradient(0, 0, 0, H);
        grd.addColorStop(0, '#06210f'); grd.addColorStop(0.55, '#05160c'); grd.addColorStop(1, '#020c06');
        g.fillStyle = grd; g.fillRect(0, 0, W, H);
        // ferne Dschungel-Silhouette
        g.save(); g.fillStyle = 'rgba(20,70,38,0.5)';
        drawHills(g, H * 0.62, 90, 0);
        g.fillStyle = 'rgba(12,48,26,0.7)';
        drawHills(g, H * 0.72, 120, 1.6);
        g.restore();
        // Wind-Blätter
        g.save();
        for (var i = 0; i < leaves.length; i++) {
          var lf = leaves[i];
          g.globalAlpha = 0.35;
          g.font = lf.s + 'px system-ui,sans-serif';
          g.fillText('🍃', lf.x, lf.y);
        }
        g.restore();
        // Boden
        g.save();
        var gg = g.createLinearGradient(0, GROUND, 0, H);
        gg.addColorStop(0, 'rgba(20,80,40,0.85)'); gg.addColorStop(1, 'rgba(6,26,14,0.95)');
        g.fillStyle = gg; g.fillRect(0, GROUND, W, H - GROUND);
        g.strokeStyle = 'rgba(57,255,20,0.55)'; g.lineWidth = 2; g.shadowColor = 'rgba(57,255,20,0.6)'; g.shadowBlur = 12;
        g.beginPath(); g.moveTo(0, GROUND); g.lineTo(W, GROUND); g.stroke();
        g.restore();

        var cy = curCY(now);
        drawTarget(g, TARGET_X, cy, cur.rMax);
        // Steckpfeile
        for (var s = 0; s < stuckArrows.length; s++) {
          var a = stuckArrows[s];
          var ax = a.onTarget ? TARGET_X : a.x;
          var ay = a.onTarget ? (cy + a.offY) : a.y;
          drawArrow(g, ax, ay, a.ang, 0.9, false);
        }
        // Bogen + Zielen ODER fliegender Pfeil
        if (ph === 'fly' && flyArrow) {
          drawTrail(g);
          drawArrow(g, flyArrow.x, flyArrow.y, Math.atan2(flyArrow.vy, flyArrow.vx), 1, true);
          drawBow(g, false);
        } else {
          if (ph === 'aim') drawPreview(g, now);
          drawBow(g, ph === 'aim');
        }
        // Ergebnis-Text
        if (landInfo) drawLandText(g, now);
      }

      function drawHills(g, base, amp, off) {
        g.beginPath(); g.moveTo(0, H);
        for (var x = 0; x <= W; x += 30) {
          var y = base + Math.sin(x / 120 + off) * amp * 0.4 + Math.cos(x / 60 + off) * amp * 0.18;
          g.lineTo(x, y);
        }
        g.lineTo(W, H); g.closePath(); g.fill();
      }

      function drawTarget(g, cx, cy, rMax) {
        // 5 Farbzonen (je 2 Ringwerte) von aussen nach innen
        var zones = [
          ['rgba(157,255,122,0.85)', 5],  // 1-2 leaf
          ['rgba(57,255,20,0.88)', 4],    // 3-4 neon
          ['rgba(51,230,208,0.9)', 3],    // 5-6 aqua
          ['rgba(255,77,109,0.9)', 2],    // 7-8 danger
          ['rgba(255,210,63,0.95)', 1]    // 9-10 gold
        ];
        g.save();
        g.shadowColor = 'rgba(255,210,63,0.35)'; g.shadowBlur = 24;
        for (var z = 0; z < zones.length; z++) {
          g.beginPath(); g.fillStyle = zones[z][0];
          g.arc(cx, cy, rMax * zones[z][1] / 5, 0, Math.PI * 2); g.fill();
        }
        g.shadowBlur = 0;
        // feine Ringlinien alle 1/10
        g.strokeStyle = 'rgba(4,16,10,0.55)'; g.lineWidth = 1.4;
        for (var k = 1; k < 10; k++) {
          g.beginPath(); g.arc(cx, cy, rMax * k / 10, 0, Math.PI * 2); g.stroke();
        }
        // Bullseye
        g.beginPath(); g.fillStyle = '#fff7d6';
        g.shadowColor = 'rgba(255,210,63,0.9)'; g.shadowBlur = 16;
        g.arc(cx, cy, rMax * 0.085, 0, Math.PI * 2); g.fill();
        g.shadowBlur = 0;
        // Aussenrand
        g.strokeStyle = 'rgba(234,255,224,0.85)'; g.lineWidth = 3;
        g.beginPath(); g.arc(cx, cy, rMax, 0, Math.PI * 2); g.stroke();
        // Ständer
        g.strokeStyle = 'rgba(120,90,50,0.8)'; g.lineWidth = 6;
        g.beginPath(); g.moveTo(cx, cy + rMax); g.lineTo(cx, GROUND); g.stroke();
        g.restore();
      }

      function drawBow(g, aiming) {
        var dir = aimVec();
        var pull = aiming ? (12 + aimPower * 26) : 14;
        var nock = { x: ANCHOR_X - dir.x * pull, y: ANCHOR_Y - dir.y * pull };
        var top = { x: ANCHOR_X, y: ANCHOR_Y - 44 }, bot = { x: ANCHOR_X, y: ANCHOR_Y + 44 };
        g.save();
        // Bogenkörper
        g.strokeStyle = '#6dff4d'; g.lineWidth = 5; g.lineCap = 'round';
        g.shadowColor = 'rgba(57,255,20,0.7)'; g.shadowBlur = 14;
        g.beginPath(); g.moveTo(top.x, top.y); g.quadraticCurveTo(ANCHOR_X - 34, ANCHOR_Y, bot.x, bot.y); g.stroke();
        // Sehne
        g.shadowBlur = 0; g.strokeStyle = 'rgba(207,228,220,0.9)'; g.lineWidth = 2;
        g.beginPath(); g.moveTo(top.x, top.y); g.lineTo(nock.x, nock.y); g.lineTo(bot.x, bot.y); g.stroke();
        g.restore();
        // nockender Pfeil (nur beim Zielen)
        if (aiming) {
          var tip = { x: nock.x + dir.x * 58, y: nock.y + dir.y * 58 };
          drawArrow(g, tip.x, tip.y, Math.atan2(dir.y, dir.x), 1, true);
        }
      }

      function drawArrow(g, x, y, ang, scale, bright) {
        var L = 46 * scale;
        g.save();
        g.translate(x, y); g.rotate(ang);
        g.lineCap = 'round';
        g.strokeStyle = bright ? '#eaffe0' : 'rgba(200,230,210,0.7)';
        g.lineWidth = 3 * scale;
        if (bright) { g.shadowColor = 'rgba(255,210,63,0.7)'; g.shadowBlur = 10; }
        g.beginPath(); g.moveTo(0, 0); g.lineTo(-L, 0); g.stroke();
        // Spitze
        g.beginPath(); g.moveTo(0, 0); g.lineTo(-9 * scale, -6 * scale); g.moveTo(0, 0); g.lineTo(-9 * scale, 6 * scale); g.stroke();
        g.shadowBlur = 0;
        // Federn
        g.strokeStyle = bright ? '#33e6d0' : 'rgba(51,230,208,0.6)'; g.lineWidth = 2 * scale;
        g.beginPath();
        g.moveTo(-L, 0); g.lineTo(-L + 9 * scale, -6 * scale);
        g.moveTo(-L, 0); g.lineTo(-L + 9 * scale, 6 * scale);
        g.moveTo(-L + 7 * scale, 0); g.lineTo(-L + 16 * scale, -6 * scale);
        g.moveTo(-L + 7 * scale, 0); g.lineTo(-L + 16 * scale, 6 * scale);
        g.stroke();
        g.restore();
      }

      function drawTrail(g) {
        g.save();
        for (var i = 0; i < trail.length; i++) {
          var tp = trail[i], al = (i + 1) / trail.length;
          g.fillStyle = 'rgba(255,232,160,' + (al * 0.32).toFixed(3) + ')';
          g.beginPath(); g.arc(tp.x, tp.y, 2 + al * 3, 0, Math.PI * 2); g.fill();
        }
        g.restore();
      }

      function drawPreview(g, now) {
        var dir = aimVec();
        var pw = aimPower; if (pw < 0) pw = 0; if (pw > 1) pw = 1;
        var speed = MIN_SPEED + pw * (MAX_SPEED - MIN_SPEED);
        var vx = dir.x * speed, vy = dir.y * speed;
        var x = ANCHOR_X, y = ANCHOR_Y, dt = 0.02, ay = G + cur.windAy;
        var hitY = null;
        g.save();
        for (var i = 0; i < 140; i++) {
          vy += ay * dt; x += vx * dt; y += vy * dt;
          if (x >= TARGET_X) { hitY = y; break; }
          if (y >= GROUND || y < -700 || x > W + 40) break;
          if (i % 3 === 0) {
            var al = Math.max(0.12, 0.6 - i / 200);
            g.fillStyle = 'rgba(255,210,63,' + al.toFixed(3) + ')';
            g.beginPath(); g.arc(x, y, 2.6, 0, Math.PI * 2); g.fill();
          }
        }
        g.restore();
        // vorhergesagter Einschlag
        if (hitY != null) {
          g.save();
          g.strokeStyle = 'rgba(234,255,224,0.9)'; g.lineWidth = 2;
          g.beginPath(); g.arc(TARGET_X, hitY, 7, 0, Math.PI * 2); g.stroke();
          g.beginPath(); g.moveTo(TARGET_X - 10, hitY); g.lineTo(TARGET_X + 10, hitY);
          g.moveTo(TARGET_X, hitY - 10); g.lineTo(TARGET_X, hitY + 10); g.stroke();
          g.restore();
        }
      }

      function drawLandText(g, now) {
        var age = (now - landInfo.at) / 950; if (age > 1) age = 1;
        var alpha = 1 - age;
        var txt = landInfo.miss ? 'Daneben' : (landInfo.bull ? 'BULLSEYE! +10' : '+' + landInfo.score);
        var col = landInfo.miss ? '255,77,109' : (landInfo.bull ? '255,210,63' : '57,255,20');
        var ty = Math.max(24, landInfo.y - 22 - age * 26);
        var tx = Math.min(W - 90, Math.max(90, landInfo.x));
        g.save();
        g.globalAlpha = alpha;
        g.font = '900 ' + (landInfo.bull ? 34 : 28) + 'px "Segoe UI",system-ui,Arial,sans-serif';
        g.textAlign = 'center'; g.textBaseline = 'middle';
        g.shadowColor = 'rgba(' + col + ',0.8)'; g.shadowBlur = 18;
        g.fillStyle = 'rgb(' + col + ')';
        g.fillText(txt, tx, ty);
        g.restore();
      }

      /* ================= HUD / Layout ================= */
      function buildStage() {
        roundChip = el('span', { class: 'arc-chip' }, ['🎯 Runde 1/' + ROUNDS]);
        arrowChip = el('span', { class: 'arc-chip' }, ['🏹 Pfeil 1/' + ARROWS_PER_ROUND]);
        windChip = el('span', { class: 'arc-chip arc-wind' }, ['💨 Windstill']);
        scoreChip = el('span', { class: 'arc-chip arc-score' }, ['⭐ 0']);
        timerChip = el('span', { class: 'arc-chip arc-timer' }, ['⏱ 15']);
        var hud = el('div', { class: 'arc-hud glass' }, [roundChip, arrowChip, windChip, scoreChip, timerChip]);

        canvas = el('canvas', { class: 'arc-canvas', width: W, height: H });
        var stage = el('div', { class: 'arc-stage' }, [canvas]);
        g2 = canvas.getContext('2d');

        hint = el('div', { class: 'arc-hint hint-text' },
          ['Ziehen & loslassen zum Schiessen · näher an der Mitte = mehr Punkte · ↑↓ Winkel, ←→ Power, Leertaste']);

        boardRoot = isMulti ? null : el('div', { class: 'mg-scoreboard' });
        var boardWrap;
        if (isMulti) {
          var board = App.MG.liveBoard(ctx.room, ctx.me.id);
          stops.push(board.stop);
          boardRoot = board.root;
          boardWrap = el('div', { class: 'arc-board glass' }, [el('div', { class: 'mg-field-title' }, ['🏆 Rangliste']), boardRoot]);
        } else {
          boardWrap = el('div', { class: 'arc-board glass' }, [el('div', { class: 'mg-field-title' }, ['🏆 Schützen']), boardRoot]);
        }

        var wrap = el('div', { class: 'arc-wrap' }, [hud, stage, hint, boardWrap]);
        root.innerHTML = ''; root.appendChild(wrap);
      }

      function updateHud() {
        if (!roundChip) return;
        roundChip.textContent = '🎯 Runde ' + (roundIdx + 1) + '/' + ROUNDS;
        arrowChip.textContent = '🏹 Pfeil ' + Math.min(arrowIdx + 1, ARROWS_PER_ROUND) + '/' + ARROWS_PER_ROUND;
        scoreChip.textContent = '⭐ ' + totalScore;
        windChip.textContent = '💨 ' + windText(cur ? cur.windAy : 0);
      }
      function windText(w) {
        var mag = Math.round(Math.abs(w) / 70);
        if (mag <= 0) return 'Windstill';
        return (w < 0 ? '↑ ' : '↓ ') + mag;
      }

      function updateSoloBoard() {
        if (!boardRoot) return;
        var rows = [{ name: (ctx.me && ctx.me.name) || 'Du', score: totalScore, me: true }];
        bots.forEach(function (b) { rows.push({ name: b.name, score: b.score, me: false }); });
        rows.sort(function (a, b) { return b.score - a.score; });
        boardRoot.innerHTML = '';
        rows.forEach(function (p, i) {
          boardRoot.appendChild(el('div', { class: 'mg-sb-row p' + (i + 1) + (p.me ? ' me' : '') }, [
            el('span', { class: 'mg-sb-rank' }, ['' + (i + 1)]),
            el('span', { class: 'mg-sb-name' }, [p.name + (p.me ? ' (du)' : '')]),
            el('span', { class: 'mg-sb-score' }, [String(p.score)])
          ]));
        });
      }

      /* ================= Eingabe ================= */
      function toV(e) {
        var r = canvas.getBoundingClientRect();
        return { x: (e.clientX - r.left) / r.width * W, y: (e.clientY - r.top) / r.height * H };
      }
      function attachInput() {
        removeAllListeners();
        var onDown = function (e) {
          if (ph !== 'aim') return;
          e.preventDefault();
          dragging = true; dragMoved = false; downP = toV(e);
          try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
        };
        var onMove = function (e) {
          if (!dragging) return;
          e.preventDefault();
          var p = toV(e);
          var ddx = downP.x - p.x, ddy = downP.y - p.y;    // Zug = entgegen der Bewegung
          var len = Math.hypot(ddx, ddy);
          if (len > 8) dragMoved = true;
          if (ddx > 0) {                                    // nur nach hinten spannen
            aimAngle = clampAng(Math.atan2(-ddy, ddx));
            aimPower = Math.min(1, len / MAX_PULL);
          }
        };
        var onUp = function (e) {
          if (!dragging) return;
          dragging = false;
          try { canvas.releasePointerCapture(e.pointerId); } catch (_) {}
          if (ph === 'aim' && dragMoved && aimPower > 0.07) fire();
        };
        addL(canvas, 'pointerdown', onDown);
        addL(canvas, 'pointermove', onMove);
        addL(canvas, 'pointerup', onUp);
        addL(canvas, 'pointercancel', onUp);

        var onKey = function (e) {
          if (ph !== 'aim') return;
          var k = e.key;
          if (k === 'ArrowUp') { aimAngle = clampAng(aimAngle + 0.05); e.preventDefault(); }
          else if (k === 'ArrowDown') { aimAngle = clampAng(aimAngle - 0.05); e.preventDefault(); }
          else if (k === 'ArrowRight') { aimPower = Math.min(1, aimPower + 0.04); e.preventDefault(); }
          else if (k === 'ArrowLeft') { aimPower = Math.max(0, aimPower - 0.04); e.preventDefault(); }
          else if (k === ' ' || k === 'Enter' || k === 'Spacebar') { fire(); e.preventDefault(); }
        };
        addL(document, 'keydown', onKey);
      }

      /* ================= Ende ================= */
      function finish() {
        if (ph === 'over' || dead) return;
        ph = 'over';
        clearPending();
        if (raf) { cancelAnimationFrame(raf); raf = null; }
        stopHelpers();

        if (isMulti) {
          ctx.room.reportScore(totalScore);
          after(1100, function () {
            App.MG.endScreen(root, { players: ctx.room.players(), meId: ctx.me.id, onExit: ctx.onExit });
          });
        } else {
          var best = App.Storage.get('best_archery', 0);
          var nb = totalScore > best;
          if (nb) App.Storage.set('best_archery', totalScore);
          // Platzierung gegen die Bots
          var all = [{ name: 'Du', score: totalScore }].concat(bots.map(function (b) { return { name: b.name, score: b.score }; }));
          all.sort(function (a, b) { return b.score - a.score; });
          var place = 1; for (var i = 0; i < all.length; i++) { if (all[i].name === 'Du') { place = i + 1; break; } }
          if (place === 1 && App.Scores) App.Scores.winCurrent();
          App.MG.endScreen(root, {
            score: totalScore, best: best, newBest: nb,
            label: 'Platz ' + place + ' von ' + all.length + ' · ' + (nb ? 'Neuer Rekord! 🎉' : 'Bestwert: ' + App.MG.fmt(best)),
            onExit: ctx.onExit,
            onAgain: function () { ph = 'aim'; play(Date.now()); }
          });
        }
      }

      /* ================= Seed / Bots ================= */
      function buildRounds(seed) {
        var rnd = mulberry32(seed);
        var defs = [
          { rMax: 118, moveAmp: 0, movePeriod: 1, windRange: 170 },
          { rMax: 96, moveAmp: 0, movePeriod: 1, windRange: 330 },
          { rMax: 80, moveAmp: 92, movePeriod: 2300, windRange: 470 }
        ];
        return defs.map(function (d) {
          var wind = (rnd() * 2 - 1) * d.windRange;
          var phase = rnd() * Math.PI * 2;
          return { rMax: d.rMax, moveAmp: d.moveAmp, movePeriod: d.movePeriod, movePhase: phase, windAy: wind };
        });
      }
      function botArrow(b, r) {
        var pen = [0, 0.8, 1.8][r] || 0;
        var mean = b.skill - pen;
        var noise = (Math.random() + Math.random() + Math.random() - 1.5) * 1.9;
        var v = Math.round(mean + noise);
        if (v < 0) v = 0; if (v > 10) v = 10; return v;
      }
    }
  };

  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* ===================== STYLES ===================== */
  function injectStyle() {
    UI.injectStyle('mg-archery-css', [
      '.arc-wrap{display:flex;flex-direction:column;gap:14px;}',
      '.arc-hud{display:flex;flex-wrap:wrap;gap:8px;justify-content:center;align-items:center;padding:10px 14px;}',
      '.arc-chip{display:inline-flex;align-items:center;gap:5px;padding:7px 13px;border-radius:12px;background:rgba(9,32,21,.66);border:1px solid var(--stroke);font-weight:800;font-size:clamp(12px,3.2vw,15px);color:var(--leaf);white-space:nowrap;font-variant-numeric:tabular-nums;letter-spacing:.4px;}',
      '.arc-chip.arc-score{color:var(--gold);border-color:rgba(255,210,63,.4);text-shadow:0 0 10px rgba(255,210,63,.4);}',
      '.arc-chip.arc-wind{color:var(--aqua);border-color:rgba(51,230,208,.35);}',
      '.arc-chip.arc-timer{color:var(--silver);}',
      '.arc-chip.arc-urgent{color:#fff;border-color:var(--danger);background:rgba(60,10,22,.7);animation:arc-pulse .7s infinite;}',
      '@keyframes arc-pulse{0%,100%{opacity:1}50%{opacity:.45}}',
      '.arc-stage{width:100%;max-width:780px;margin:0 auto;aspect-ratio:900 / 560;position:relative;}',
      '.arc-canvas{display:block;width:100%;height:100%;border-radius:16px;border:2px solid var(--stroke-2);',
      'background:#04140c;box-shadow:0 0 42px rgba(57,255,20,.2),inset 0 0 60px rgba(57,255,20,.05);',
      'touch-action:none;user-select:none;-webkit-user-select:none;-webkit-tap-highlight-color:transparent;cursor:crosshair;}',
      '.arc-hint{text-align:center;}',
      '.arc-board{padding:14px;display:flex;flex-direction:column;gap:8px;max-width:520px;margin:0 auto;width:100%;}',
      '.arc-board .mg-scoreboard{max-height:240px;overflow-y:auto;}'
    ].join(''));
  }
})();
