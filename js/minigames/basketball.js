/* basketball.js — "Korbjagd": Basketball-Wurfspiel im Neon-Dschungel.
 *
 *  IDEE       Seitenansicht. Der Ball liegt unten links, der Korb steht rechts
 *             (und wandert/wackelt in hoeheren Wuerfen). Du wirfst per Wisch-/
 *             Ziehgeste: Richtung + Kraft ergeben sich aus dem Wischvektor. Der
 *             Ball fliegt als Parabel, prallt an Brett und Ring ab und faellt
 *             (hoffentlich) durch den Netz-Korb. 60 Sekunden lang so viele
 *             Koerbe wie moeglich.
 *
 *  STEUERUNG  Finger/Maus auf die Flaeche druecken und in Wurfrichtung ziehen,
 *             dann loslassen. Weiter ziehen = mehr Kraft. Ein Vorschau-Bogen
 *             zeigt die Flugbahn. Funktioniert per Pointer (Maus + Touch).
 *
 *  PUNKTE     100 Punkte pro Korb x Combo-Multiplikator (Treffer in Folge,
 *             bis x6). Swish (ohne Ring-/Brettberuehrung) = +50 Bonus. Ein
 *             Fehlwurf setzt die Serie zurueck.
 *
 *  SYNC       Punkte-Rennen: alle spielen gleichzeitig. Die Korb-Positionsfolge
 *             kommt aus EINEM Seed (snapshot().round.startAt) -> jeder Spieler
 *             bekommt beim gleichen Wurf denselben Korb (fair). Gemeldet wird
 *             nur die eigene Punktzahl per room.reportScore, Live-Rangliste per
 *             App.MG.liveBoard. SOLO ist Punktejagd gegen best_basketball.
 *             Alle Timer laufen ueber Wall-Clock (Date.now bzw. room.now).
 */
(function () {
  'use strict';
  window.App = window.App || {}; App.Minigames = App.Minigames || {};
  var UI = App.UI, el = UI.el;

  /* ---- Virtuelles Spielfeld (feste Koordinaten, Canvas skaliert per CSS) ---- */
  var W = 640, H = 440;            // Spielfeld in virtuellen px
  var FLOOR = H - 26;              // Bodenlinie
  var BR = 13;                     // Ball-Radius
  var GRAV = 680;                  // Schwerkraft px/s^2
  var POWER = 3.2;                 // Wisch-px -> Geschwindigkeit
  var MAX_SPD = 1060;              // Deckel Abwurfgeschwindigkeit
  var MIN_SPD = 150;               // darunter = kein Wurf
  var RIM_W = 60;                  // Ring-Oeffnung (Seitenansicht)
  var RIM_R = 4;                   // Radius der beiden Ring-Enden
  var BOARD_REST = 0.55;           // Abprall am Brett
  var RIM_REST = 0.62;             // Abprall am Ring
  var GAME_TIME = 60;              // s Rundenzeit
  var HOME = { x: 84, y: FLOOR - 44 };  // Ruheposition des Balls

  injectStyle();

  /* Deterministischer Zufall (mulberry32) fuer die Korb-Folge aus dem Seed. */
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  App.Minigames.basketball = {
    id: 'basketball', title: 'Korbjagd', icon: '🏀', order: 151,
    subtitle: 'Wische, wirf, triff – 60 Sekunden Korbjagd',
    single: true, multi: true, minPlayers: 2, maxPlayers: 8,

    render: function (root, ctx) {
      var isMulti = ctx.mode === 'multi';
      var timeNow = isMulti ? function () { return ctx.room.now(); } : function () { return Date.now(); };

      /* ---- Laufzeit ---- */
      var dead = false, ended = false, raf = null, last = 0;
      var stops = [];        // App.MG-/room-Aufraeumer
      var listeners = [];    // {t,ty,fn,opts}
      var seed = 0, endAt = 0, basketIdx = 0, finished = false;
      var canvas = null, g = null;
      var scoreEl, comboEl, timerEl, mkEl, swEl, bestEl;
      var S = null;          // Spielzustand
      var trail = [], floaters = [];
      var aiming = false, aStartX = 0, aStartY = 0, aCurX = 0, aCurY = 0;
      var pCache = null, pCacheIdx = -1;

      /* ---- Listener/Aufraeumen ---- */
      function addL(t, ty, fn, opts) { t.addEventListener(ty, fn, opts); listeners.push({ t: t, ty: ty, fn: fn, opts: opts }); }
      function removeAllListeners() { listeners.forEach(function (l) { try { l.t.removeEventListener(l.ty, l.fn, l.opts); } catch (e) {} }); listeners = []; }
      function stopHelpers() { stops.forEach(function (f) { try { f(); } catch (e) {} }); stops = []; }
      function cleanup() {
        dead = true;
        if (raf) { cancelAnimationFrame(raf); raf = null; }
        stopHelpers();
        removeAllListeners();
      }
      function sfx(n) { if (App.Audio) App.Audio.sfx(n); }

      /* ---- Start ---- */
      if (isMulti) {
        var snap = ctx.room.snapshot() || {};
        var startAt = (snap.round && snap.round.startAt) || (ctx.room.now() + 3000);
        stops.push(App.MG.countdown(root, startAt, function () { play(startAt); }, ctx.room.now));
      } else {
        play(timeNow());
      }
      return { cleanup: cleanup };

      /* ============================ SPIEL ============================ */
      function play(startAt) {
        stopHelpers(); removeAllListeners();
        if (raf) { cancelAnimationFrame(raf); raf = null; }
        seed = startAt >>> 0;
        basketIdx = 0; pCache = null; pCacheIdx = -1;
        finished = false; ended = false; aiming = false;
        trail = []; floaters = [];
        endAt = startAt + GAME_TIME * 1000;
        S = {
          mode: 'ready', bx: HOME.x, by: HOME.y, vx: 0, vy: 0, spin: 0,
          rimTouched: false, boardTouched: false, resolveAt: 0, flyStart: 0,
          score: 0, streak: 0, maxStreak: 0, makes: 0, swishes: 0,
          netWigAt: -9999, lastPts: 0
        };

        buildLayout();
        g = canvas.getContext('2d');
        attachInput();

        if (isMulti) {
          var board = App.MG.liveBoard(ctx.room, ctx.me.id);
          stops.push(board.stop);
          rankBox.innerHTML = ''; rankBox.appendChild(board.root);
          ctx.room.reportScore(0);
        }

        var tnf = isMulti ? ctx.room.now : null;
        stops.push(App.MG.roundTimer(endAt, function (left) {
          if (!timerEl) return;
          timerEl.textContent = App.MG.mmss(left);
          if (left <= 5) timerEl.classList.add('bkb-urgent');
        }, finish, tnf));

        updateHud();
        last = timeNow();
        raf = requestAnimationFrame(frame);
      }

      /* ---- Korb-Parameter pro Wurf-Index (deterministisch aus Seed) ---- */
      function paramsFor(idx) {
        if (pCacheIdx === idx) return pCache;
        var r = mulberry32(((seed >>> 0) ^ Math.imul(idx + 1, 2654435761)) >>> 0);
        var diff = Math.min(idx / 10, 1);        // Schwierigkeit rampt ueber 10 Wuerfe hoch
        var p = {
          xFrac: 0.66 + r() * 0.06 + diff * 0.08,
          yBase: 0.32 + r() * (0.05 + diff * 0.20),
          amp: diff * (8 + r() * 32),            // vertikales Wackeln
          spd: 1.0 + r() * 1.5,
          ph: r() * 6.2832,
          xamp: diff * diff * (r() * 22),        // horizontale Drift (erst spaet)
          xspd: 0.6 + r() * 1.0,
          xph: r() * 6.2832
        };
        pCache = p; pCacheIdx = idx; return p;
      }
      /* Aktuelle Korb-Geometrie zur Zeit now (bewegt sich sanft). */
      function hoopAt(now) {
        var p = paramsFor(basketIdx), ts = now / 1000;
        var ry = clamp(H * p.yBase + Math.sin(ts * p.spd + p.ph) * p.amp, H * 0.20, H * 0.60);
        var lx = clamp(W * p.xFrac + Math.sin(ts * p.xspd + p.xph) * p.xamp, W * 0.58, W * 0.80);
        var rx = lx + RIM_W;
        return { lx: lx, rx: rx, ry: ry, boardX: rx + 6, top: ry - 80, bot: ry + 12 };
      }

      /* ---- Frame-Loop ---- */
      function frame() {
        if (dead || ended) { raf = null; return; }
        var now = timeNow();
        var dt = (now - last) / 1000; if (dt < 0) dt = 0; if (dt > 0.05) dt = 0.05; last = now;

        if (S.mode === 'flying') {
          stepFlying(dt, now);
          if (S.mode === 'flying' && (now - S.flyStart) > 6000) resolveMiss(now); // Sicherheitsnetz
        } else if (S.mode === 'scored' || S.mode === 'missed') {
          stepPassive(dt);
          if (now >= S.resolveAt) resetShot();
        }
        draw(now);
        raf = requestAnimationFrame(frame);
      }

      /* ---- Physik: Flugphase ---- */
      function stepFlying(dt, now) {
        var hp = hoopAt(now);
        var pby = S.by;
        S.vy += GRAV * dt;
        S.bx += S.vx * dt; S.by += S.vy * dt;
        S.spin += S.vx * dt * 0.03;
        trail.push({ x: S.bx, y: S.by }); if (trail.length > 12) trail.shift();

        // Waende (halten den Ball sichtbar)
        if (S.bx < BR) { S.bx = BR; S.vx = Math.abs(S.vx) * 0.5; }
        else if (S.bx > W - BR) { S.bx = W - BR; S.vx = -Math.abs(S.vx) * 0.5; }
        if (S.by < BR) { S.by = BR; S.vy = Math.abs(S.vy) * 0.5; }

        // Brett (Vorderkante) -> Bankschuss moeglich
        if (S.vx > 0 && (S.bx + BR) >= hp.boardX && (S.bx + BR - S.vx * dt) < hp.boardX &&
            S.by >= hp.top && S.by <= hp.bot) {
          S.bx = hp.boardX - BR; S.vx = -Math.abs(S.vx) * BOARD_REST; S.boardTouched = true;
          if (App.Audio) App.Audio.blip(180, 0.09, { type: 'sine', peak: 0.06 });
        }

        // Ring-Enden (zwei kleine Kreise)
        collideNode(hp.lx, hp.ry);
        collideNode(hp.rx, hp.ry);

        // Korb! Ball faellt durch die Oeffnung
        if (S.vy > 0 && pby <= hp.ry && S.by > hp.ry && S.bx > hp.lx + 3 && S.bx < hp.rx - 3) {
          resolveScore(now, hp);
          return;
        }
        // Daneben -> Boden
        if (S.by + BR >= FLOOR) { S.by = FLOOR - BR; resolveMiss(now); }
      }
      function collideNode(nx, ny) {
        var dx = S.bx - nx, dy = S.by - ny, d = Math.sqrt(dx * dx + dy * dy), mn = BR + RIM_R;
        if (d < mn && d > 0.0001) {
          var uX = dx / d, uY = dy / d;
          S.bx = nx + uX * mn; S.by = ny + uY * mn;
          var vn = S.vx * uX + S.vy * uY;
          if (vn < 0) {
            S.vx -= (1 + RIM_REST) * vn * uX;
            S.vy -= (1 + RIM_REST) * vn * uY;
            S.vx *= 0.86; S.vy *= 0.86;
            S.rimTouched = true;
            if (App.Audio) App.Audio.blip(300 + Math.random() * 90, 0.05, { type: 'square', peak: 0.05 });
          }
        }
      }
      /* ---- Physik: nach Korb/Fehlwurf (Ball rollt/faellt aus) ---- */
      function stepPassive(dt) {
        S.vy += GRAV * dt;
        S.bx += S.vx * dt; S.by += S.vy * dt;
        S.spin += S.vx * dt * 0.03;
        trail.push({ x: S.bx, y: S.by }); if (trail.length > 12) trail.shift();
        if (S.by + BR >= FLOOR) { S.by = FLOOR - BR; S.vy = -Math.abs(S.vy) * 0.35; S.vx *= 0.7; }
      }

      /* ---- Auswertung ---- */
      function resolveScore(now, hp) {
        var mult = Math.min(S.streak + 1, 6);
        S.streak++; if (S.streak > S.maxStreak) S.maxStreak = S.streak;
        S.makes++;
        var swish = !S.rimTouched && !S.boardTouched;
        if (swish) S.swishes++;
        var pts = 100 * mult + (swish ? 50 : 0);
        S.score += pts; S.lastPts = pts;
        S.mode = 'scored'; S.resolveAt = now + 750; S.netWigAt = now;

        var cx = (hp.lx + hp.rx) / 2;
        pushFloater('+' + pts, cx, hp.ry - 6, '#ffd23f', 22);
        if (mult > 1) pushFloater('COMBO x' + mult, cx, hp.ry - 34, '#39ff14', 16);
        if (swish) pushFloater('SWISH!', cx, hp.ry - (mult > 1 ? 58 : 34), '#7ff3e6', 16);

        sfx('point');
        if (swish) sfx('ding');
        if (mult >= 3) sfx('levelup');
        if (isMulti) ctx.room.reportScore(S.score);
        bumpScore();
        updateHud();
      }
      function resolveMiss(now) {
        if (S.mode !== 'flying') return;
        S.mode = 'missed'; S.resolveAt = now + 520; S.streak = 0;
        S.vy = -Math.abs(S.vy) * 0.35; S.vx *= 0.6;
        if (App.Audio) App.Audio.blip(150, 0.14, { type: 'sine', peak: 0.05 });
        if (isMulti) ctx.room.reportScore(S.score);
        updateHud();
      }
      function resetShot() {
        basketIdx++;                       // naechster Korb aus der Folge
        S.mode = 'ready';
        S.bx = HOME.x; S.by = HOME.y; S.vx = 0; S.vy = 0;
        S.rimTouched = false; S.boardTouched = false;
        trail = [];
      }

      /* ---- Eingabe: Pointer (Maus + Touch) ---- */
      function toVX(clientX) { var r = canvas.getBoundingClientRect(); return (clientX - r.left) / r.width * W; }
      function toVY(clientY) { var r = canvas.getBoundingClientRect(); return (clientY - r.top) / r.height * H; }
      function aimVel() {
        var dx = aCurX - aStartX, dy = aCurY - aStartY;
        var vx = dx * POWER, vy = dy * POWER;
        var sp = Math.sqrt(vx * vx + vy * vy);
        if (sp > MAX_SPD) { var f = MAX_SPD / sp; vx *= f; vy *= f; sp = MAX_SPD; }
        return { vx: vx, vy: vy, sp: sp };
      }
      function attachInput() {
        removeAllListeners();
        aiming = false;
        var down = function (e) {
          if (dead || ended || S.mode !== 'ready' || timeNow() >= endAt) return;
          aiming = true;
          aStartX = aCurX = toVX(e.clientX); aStartY = aCurY = toVY(e.clientY);
          if (e.pointerId != null && canvas.setPointerCapture) { try { canvas.setPointerCapture(e.pointerId); } catch (er) {} }
          if (e.preventDefault) e.preventDefault();
        };
        var move = function (e) {
          if (!aiming) return;
          aCurX = toVX(e.clientX); aCurY = toVY(e.clientY);
          if (e.preventDefault) e.preventDefault();
        };
        var up = function (e) {
          if (!aiming) return;
          aiming = false;
          if (e.preventDefault) e.preventDefault();
          doLaunch();
        };
        var cancel = function () { aiming = false; };
        addL(canvas, 'pointerdown', down);
        addL(canvas, 'pointermove', move);
        addL(canvas, 'pointerup', up);
        addL(canvas, 'pointercancel', cancel);
      }
      function doLaunch() {
        if (dead || ended || S.mode !== 'ready' || timeNow() >= endAt) return;
        var v = aimVel();
        if (v.sp < MIN_SPD) return;         // zu schwach -> kein Wurf
        S.bx = HOME.x; S.by = HOME.y;
        S.vx = v.vx; S.vy = v.vy; S.spin = 0;
        S.rimTouched = false; S.boardTouched = false;
        S.mode = 'flying'; S.flyStart = timeNow(); trail = [];
        sfx('whoosh');
      }

      /* ---- Floater (schwebende Punkte-Texte) ---- */
      function pushFloater(text, x, y, color, size) {
        floaters.push({ t: text, x: x, y: y, born: timeNow(), color: color, size: size || 16 });
      }

      /* ============================ ZEICHNEN ============================ */
      function draw(now) {
        if (!g) return;
        g.clearRect(0, 0, W, H);
        // Hintergrund
        var grd = g.createLinearGradient(0, 0, 0, H);
        grd.addColorStop(0, '#06180e'); grd.addColorStop(1, '#020c07');
        g.fillStyle = grd; g.fillRect(0, 0, W, H);

        var hp = hoopAt(now);

        // Glow hinter dem Korb
        g.save();
        var gl = g.createRadialGradient(hp.boardX, hp.ry, 6, hp.boardX, hp.ry, 150);
        gl.addColorStop(0, 'rgba(255,138,60,0.16)'); gl.addColorStop(1, 'rgba(255,138,60,0)');
        g.fillStyle = gl; g.fillRect(hp.boardX - 160, hp.ry - 160, 320, 320);
        g.restore();

        // Boden
        g.save();
        g.strokeStyle = 'rgba(57,255,20,0.5)'; g.lineWidth = 3; g.shadowColor = 'rgba(57,255,20,0.5)'; g.shadowBlur = 14;
        g.beginPath(); g.moveTo(0, FLOOR); g.lineTo(W, FLOOR); g.stroke();
        g.restore();
        g.fillStyle = 'rgba(4,14,9,0.7)'; g.fillRect(0, FLOOR, W, H - FLOOR);

        drawHoop(hp, now);

        // Abwurf-Marke
        if (S.mode === 'ready') {
          g.save();
          g.strokeStyle = 'rgba(57,255,20,0.5)'; g.lineWidth = 2; g.setLineDash([4, 5]);
          g.beginPath(); g.arc(HOME.x, HOME.y, BR + 7, 0, Math.PI * 2); g.stroke();
          g.restore();
        }

        // Ball-Spur
        g.save();
        for (var i = 0; i < trail.length; i++) {
          var tp = trail[i], a = (i + 1) / trail.length;
          g.fillStyle = 'rgba(255,160,80,' + (a * 0.28).toFixed(3) + ')';
          g.beginPath(); g.arc(tp.x, tp.y, BR * (0.35 + a * 0.6), 0, Math.PI * 2); g.fill();
        }
        g.restore();

        drawBall(S.bx, S.by, S.spin);

        if (aiming) drawAim();
        drawFloaters(now);
      }

      function drawHoop(hp, now) {
        // Stange hinter dem Brett
        g.save();
        g.strokeStyle = 'rgba(120,160,140,0.28)'; g.lineWidth = 8; g.lineCap = 'round';
        g.beginPath(); g.moveTo(hp.boardX + 12, hp.bot); g.lineTo(hp.boardX + 12, FLOOR); g.stroke();
        g.restore();
        // Brett
        g.save();
        g.fillStyle = 'rgba(6,26,17,0.72)';
        g.strokeStyle = 'rgba(51,230,208,0.65)'; g.lineWidth = 3;
        g.shadowColor = 'rgba(51,230,208,0.35)'; g.shadowBlur = 12;
        roundRect(hp.boardX, hp.top, 12, hp.bot - hp.top, 5); g.fill(); g.stroke();
        g.restore();
        // Ziel-Rechteck auf dem Brett
        g.save();
        g.strokeStyle = 'rgba(51,230,208,0.55)'; g.lineWidth = 2;
        g.strokeRect(hp.boardX - 26, hp.ry - 34, 24, 30);
        g.restore();
        // Netz (zappelt nach einem Korb)
        var wig = Math.max(0, 1 - (now - S.netWigAt) / 750);
        drawNet(hp, now, wig);
        // Ring (zwei Enden + Bogen)
        g.save();
        g.strokeStyle = '#ff8a3c'; g.lineWidth = 5; g.lineCap = 'round';
        g.shadowColor = 'rgba(255,138,60,0.7)'; g.shadowBlur = 12;
        g.beginPath(); g.moveTo(hp.lx, hp.ry); g.quadraticCurveTo((hp.lx + hp.rx) / 2, hp.ry + 6, hp.rx, hp.ry); g.stroke();
        g.fillStyle = '#ffb35a';
        g.beginPath(); g.arc(hp.lx, hp.ry, RIM_R + 1, 0, Math.PI * 2); g.fill();
        g.beginPath(); g.arc(hp.rx, hp.ry, RIM_R + 1, 0, Math.PI * 2); g.fill();
        g.restore();
      }

      function drawNet(hp, now, wig) {
        var cols = 6, netH = 40, ts = now / 1000;
        var inset = RIM_W * 0.20;
        g.save();
        g.strokeStyle = 'rgba(225,255,240,' + (0.28 + wig * 0.22).toFixed(3) + ')';
        g.lineWidth = 1.4;
        var topX = [], botX = [], k;
        for (k = 0; k <= cols; k++) {
          var f = k / cols;
          var tx = hp.lx + (hp.rx - hp.lx) * f;
          var bx = (hp.lx + inset) + ((hp.rx - inset) - (hp.lx + inset)) * f;
          var sway = Math.sin(ts * 9 + k * 0.8) * wig * 8;
          topX.push(tx); botX.push(bx + sway);
        }
        // senkrechte Straenge
        for (k = 0; k <= cols; k++) {
          g.beginPath(); g.moveTo(topX[k], hp.ry); g.lineTo(botX[k], hp.ry + netH); g.stroke();
        }
        // waagerechte Verbindungen
        var rows = [0.34, 0.68, 1];
        for (var rI = 0; rI < rows.length; rI++) {
          var fr = rows[rI];
          g.beginPath();
          for (k = 0; k <= cols; k++) {
            var xx = topX[k] + (botX[k] - topX[k]) * fr;
            var yy = hp.ry + netH * fr;
            if (k === 0) g.moveTo(xx, yy); else g.lineTo(xx, yy);
          }
          g.stroke();
        }
        g.restore();
      }

      function drawBall(x, y, spin) {
        g.save();
        g.shadowColor = 'rgba(255,138,60,0.7)'; g.shadowBlur = 16;
        var rg = g.createRadialGradient(x - BR * 0.35, y - BR * 0.4, BR * 0.2, x, y, BR);
        rg.addColorStop(0, '#ffc074'); rg.addColorStop(0.6, '#ef7f2a'); rg.addColorStop(1, '#c85e14');
        g.fillStyle = rg;
        g.beginPath(); g.arc(x, y, BR, 0, Math.PI * 2); g.fill();
        g.restore();
        // Naehte
        g.save();
        g.translate(x, y); g.rotate(spin);
        g.strokeStyle = 'rgba(45,22,6,0.7)'; g.lineWidth = 1.4;
        g.beginPath(); g.moveTo(0, -BR); g.lineTo(0, BR); g.stroke();
        g.beginPath(); g.moveTo(-BR, 0); g.lineTo(BR, 0); g.stroke();
        g.beginPath(); g.arc(-BR * 1.1, 0, BR * 1.35, -0.7, 0.7); g.stroke();
        g.beginPath(); g.arc(BR * 1.1, 0, BR * 1.35, Math.PI - 0.7, Math.PI + 0.7); g.stroke();
        g.restore();
      }

      function drawAim() {
        var v = aimVel();
        // Vorschau-Bogen
        var x = HOME.x, y = HOME.y, sx = v.vx, sy = v.vy, dt = 0.03, i;
        g.save();
        for (i = 0; i < 46; i++) {
          sy += GRAV * dt; x += sx * dt; y += sy * dt;
          if (y > FLOOR - BR || x > W || x < 0) break;
          var a = 1 - i / 46;
          g.fillStyle = 'rgba(157,255,122,' + (a * 0.85).toFixed(3) + ')';
          g.beginPath(); g.arc(x, y, 3.4, 0, Math.PI * 2); g.fill();
        }
        g.restore();
        // Zug-Pfeil vom Ball
        var sp = v.sp || 1, len = Math.min(sp / MAX_SPD, 1) * 66;
        var ux = v.vx / sp, uy = v.vy / sp;
        g.save();
        g.strokeStyle = 'rgba(57,255,20,0.9)'; g.lineWidth = 3; g.lineCap = 'round';
        g.beginPath(); g.moveTo(HOME.x, HOME.y); g.lineTo(HOME.x + ux * len, HOME.y + uy * len); g.stroke();
        g.restore();
        // Kraft-Balken unten links
        var pf = Math.min(v.sp / MAX_SPD, 1);
        var bx = 16, by = FLOOR - 14, bw = 120, bh = 9;
        g.save();
        g.fillStyle = 'rgba(4,16,10,0.8)'; roundRect(bx, by, bw, bh, 4); g.fill();
        var col = pf < 0.5 ? '#39ff14' : pf < 0.82 ? '#ffd23f' : '#ff4d6d';
        g.fillStyle = col; roundRect(bx, by, bw * pf, bh, 4); g.fill();
        g.fillStyle = 'rgba(230,255,240,0.9)'; g.font = '700 12px system-ui,Arial,sans-serif';
        g.textAlign = 'left'; g.textBaseline = 'bottom';
        g.fillText('Kraft ' + Math.round(pf * 100) + '%', bx, by - 3);
        g.restore();
      }

      function drawFloaters(now) {
        for (var i = floaters.length - 1; i >= 0; i--) {
          var fl = floaters[i], age = now - fl.born;
          if (age > 950) { floaters.splice(i, 1); continue; }
          var a = 1 - age / 950, yy = fl.y - age * 0.045;
          g.save();
          g.globalAlpha = a;
          g.fillStyle = fl.color;
          g.font = '900 ' + fl.size + 'px system-ui,Arial,sans-serif';
          g.textAlign = 'center'; g.textBaseline = 'middle';
          g.shadowColor = fl.color; g.shadowBlur = 12;
          g.fillText(fl.t, fl.x, yy);
          g.restore();
        }
      }

      function roundRect(x, y, w, h, r) {
        r = Math.min(r, w / 2, h / 2);
        g.beginPath();
        g.moveTo(x + r, y);
        g.arcTo(x + w, y, x + w, y + h, r);
        g.arcTo(x + w, y + h, x, y + h, r);
        g.arcTo(x, y + h, x, y, r);
        g.arcTo(x, y, x + w, y, r);
        g.closePath();
      }

      /* ============================ HUD ============================ */
      var rankBox = null;
      function buildLayout() {
        scoreEl = el('div', { class: 'bkb-score' }, ['0']);
        comboEl = el('div', { class: 'bkb-combo' }, ['–']);
        timerEl = el('div', { class: 'mg-timer bkb-timerv' }, [App.MG.mmss(GAME_TIME)]);
        var head = el('div', { class: 'bkb-head glass' }, [
          el('div', { class: 'bkb-hc' }, [el('span', { class: 'bkb-hl' }, ['Punkte']), scoreEl]),
          el('div', { class: 'bkb-hc bkb-hc-mid' }, [el('span', { class: 'bkb-hl' }, ['Serie']), comboEl]),
          el('div', { class: 'bkb-hc bkb-hc-r' }, [el('span', { class: 'bkb-hl' }, ['Zeit']), timerEl])
        ]);

        canvas = el('canvas', { class: 'bkb-canvas', width: W, height: H });
        var stage = el('div', { class: 'bkb-stage' }, [canvas]);
        var hint = el('div', { class: 'bkb-hint hint-text' },
          ['🏀 In Wurfrichtung wischen & loslassen · Serie = mehr Punkte · Swish (ohne Ring) = Bonus']);

        mkEl = el('div', { class: 'bkb-stat-v' }, ['0']);
        swEl = el('div', { class: 'bkb-stat-v' }, ['0']);
        bestEl = el('div', { class: 'bkb-stat-v' }, ['0']);
        var stats = el('div', { class: 'bkb-stats glass' }, [
          el('div', { class: 'bkb-stat' }, [el('div', { class: 'bkb-stat-l' }, ['🎯 Treffer']), mkEl]),
          el('div', { class: 'bkb-stat' }, [el('div', { class: 'bkb-stat-l' }, ['✨ Swish']), swEl]),
          el('div', { class: 'bkb-stat' }, [el('div', { class: 'bkb-stat-l' }, ['🔥 Beste Serie']), bestEl])
        ]);

        var kids = [head, stage, hint, stats];
        if (isMulti) {
          rankBox = el('div', { class: 'mg-scoreboard' });
          kids.push(el('div', { class: 'bkb-rank glass' }, [
            el('div', { class: 'mg-field-title' }, ['🏆 Rangliste']), rankBox
          ]));
        }
        var wrap = el('div', { class: 'bkb-wrap' }, kids);
        root.innerHTML = ''; root.appendChild(wrap);
      }
      function bumpScore() {
        if (!scoreEl) return;
        scoreEl.classList.remove('bkb-bump'); void scoreEl.offsetWidth; scoreEl.classList.add('bkb-bump');
      }
      function updateHud() {
        if (!scoreEl) return;
        scoreEl.textContent = App.MG.fmt(S.score);
        if (S.streak > 0) { comboEl.textContent = '🔥 ' + S.streak; comboEl.classList.add('hot'); }
        else { comboEl.textContent = '–'; comboEl.classList.remove('hot'); }
        mkEl.textContent = String(S.makes);
        swEl.textContent = String(S.swishes);
        bestEl.textContent = String(S.maxStreak);
      }

      /* ============================ ENDE ============================ */
      function finish() {
        if (finished || dead) return;
        finished = true; ended = true;
        if (raf) { cancelAnimationFrame(raf); raf = null; }
        stopHelpers();
        removeAllListeners();

        if (isMulti) {
          ctx.room.reportScore(S.score);
          var t = setTimeout(function () {
            if (dead) return;
            App.MG.endScreen(root, { players: ctx.room.players(), meId: ctx.me.id, onExit: ctx.onExit });
          }, 1100);
          stops.push(function () { clearTimeout(t); });
        } else {
          var best = App.Storage.get('best_basketball', 0);
          var nb = S.score > best;
          if (nb) App.Storage.set('best_basketball', S.score);
          App.MG.endScreen(root, {
            score: S.score, best: best, newBest: nb,
            label: S.makes + ' Koerbe · beste Serie ' + S.maxStreak +
              (nb ? ' · neuer Rekord! 🎉' : ' · Bestwert: ' + App.MG.fmt(best)),
            onExit: ctx.onExit,
            onAgain: function () { ended = false; play(timeNow()); }
          });
        }
      }
    }
  };

  /* ============================ STYLES ============================ */
  function injectStyle() {
    UI.injectStyle('mg-basketball-css', [
      '.bkb-wrap{display:flex;flex-direction:column;gap:12px;align-items:stretch;}',
      '.bkb-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 18px;}',
      '.bkb-hc{display:flex;flex-direction:column;gap:2px;min-width:0;}',
      '.bkb-hc-mid{text-align:center;align-items:center;}',
      '.bkb-hc-r{text-align:right;align-items:flex-end;}',
      '.bkb-hl{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:1px;font-weight:800;}',
      '.bkb-score{font-size:clamp(24px,6vw,40px);font-weight:900;color:var(--gold);text-shadow:0 0 12px rgba(255,210,63,.45);line-height:1;font-variant-numeric:tabular-nums;}',
      '.bkb-combo{font-size:clamp(20px,5vw,32px);font-weight:900;color:var(--muted);line-height:1;transition:color .15s;}',
      '.bkb-combo.hot{color:var(--neon);text-shadow:0 0 12px rgba(57,255,20,.5);animation:bkb-beat .8s ease-in-out infinite;}',
      '.bkb-timerv{font-size:clamp(18px,5vw,26px);}',
      '.mg-timer.bkb-urgent{color:var(--danger-2);animation:bkb-pulse .7s infinite;}',
      '.bkb-bump{animation:bkb-bump .3s ease;}',
      '.bkb-stage{width:100%;max-width:600px;margin:0 auto;aspect-ratio:640 / 440;position:relative;}',
      '.bkb-canvas{display:block;width:100%;height:100%;border-radius:16px;',
      'border:2px solid rgba(57,255,20,.35);background:#04140c;',
      'box-shadow:0 0 42px rgba(57,255,20,.2),inset 0 0 60px rgba(57,255,20,.06);',
      'touch-action:none;user-select:none;-webkit-user-select:none;-webkit-tap-highlight-color:transparent;cursor:crosshair;}',
      '.bkb-hint{text-align:center;}',
      '.bkb-stats{display:flex;gap:12px;padding:11px 16px;justify-content:space-around;}',
      '.bkb-stat{display:flex;flex-direction:column;align-items:center;gap:2px;}',
      '.bkb-stat-l{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;}',
      '.bkb-stat-v{font-size:clamp(18px,4.5vw,24px);font-weight:900;color:var(--leaf);font-variant-numeric:tabular-nums;}',
      '.bkb-rank{padding:14px;display:flex;flex-direction:column;gap:8px;}',
      '.bkb-rank .mg-scoreboard{max-height:280px;overflow-y:auto;}',
      '@keyframes bkb-bump{0%{transform:scale(1)}40%{transform:scale(1.22)}100%{transform:scale(1)}}',
      '@keyframes bkb-beat{0%,100%{transform:scale(1)}50%{transform:scale(1.1)}}',
      '@keyframes bkb-pulse{0%,100%{opacity:1}50%{opacity:.4}}'
    ].join(''));
  }
})();
