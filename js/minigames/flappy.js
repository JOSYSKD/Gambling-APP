/* flappy.js — "Papagei-Flug": Flappy-Bird im Neon-Dschungel.
 * Tippe/klicke/Leertaste = Flügelschlag nach oben, die Schwerkraft zieht runter.
 * Fliege durch die Lücken zwischen den glühenden Ranken-Röhren. Jede Lücke = +1.
 * PARALLEL-WETTBEWERB mit Leben/Neustart: 60 s Rundenzeit, jeder fliegt seinen
 * eigenen Papagei. Crash (Röhre/Boden/Decke) -> ~1 Sek Pause, dann Respawn,
 * Punkte bleiben, weiterfliegen bis die Zeit aus ist. Faires Zeitrennen.
 * Singleplayer (Bestwert 'best_flappy') + Multiplayer (synchroner Start via
 * Countdown, Live-Rangliste, Podest). Physik-Loop über rAF mit geclamptem
 * Zeit-Delta (Date.now / room.now) -> Tab-Wechsel-sicher. Timer über App.MG. */
(function () {
  'use strict';
  window.App = window.App || {}; App.Minigames = App.Minigames || {};
  var UI = App.UI, el = UI.el, MG = App.MG;

  var DURATION = 60;                 // Sekunden Rundenzeit
  var TAU = Math.PI * 2;

  injectStyle();

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  /* gerundetes Rechteck als Pfad (für alte Browser ohne ctx.roundRect) */
  function rr(c, x, y, w, h, r) {
    if (r > h / 2) r = h / 2; if (r > w / 2) r = w / 2; if (r < 0) r = 0;
    c.beginPath();
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r);
    c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
  }

  App.Minigames.flappy = {
    id: 'flappy', title: 'Papagei-Flug', icon: '🦜', order: 10,
    subtitle: 'Flieg durch die Lücken, so weit du kommst',
    single: true, multi: true, minPlayers: 2, maxPlayers: 8,

    render: function (root, ctx) {
      var isMulti = ctx.mode === 'multi';
      var clock = isMulti ? ctx.room.now : Date.now;

      /* ---- Aufräum-Register (alles muss in cleanup() weg) ---- */
      var stops = [], raf = null, destroyed = false;
      function addStop(fn) { if (fn) stops.push(fn); }
      function clearAll() {
        stops.forEach(function (f) { try { f(); } catch (e) {} });
        stops = [];
        if (raf) { cancelAnimationFrame(raf); raf = null; }
      }
      function cleanup() { destroyed = true; clearAll(); }

      /* ---- Start: Multi wartet auf synchronen Countdown, Single legt sofort los ---- */
      if (isMulti) {
        var snap = ctx.room.snapshot() || {};
        var startAt0 = (snap.round && snap.round.startAt) || (ctx.room.now() + 3000);
        addStop(MG.countdown(root, startAt0, function () { play(startAt0); }, ctx.room.now));
      } else {
        play(Date.now());
      }
      return { cleanup: cleanup };

      /* ============================ RUNDE ============================ */
      function play(startAt) {
        clearAll();                       // evtl. Countdown-Timer stoppen

        /* ---- Spielzustand ---- */
        var endAt = startAt + DURATION * 1000;
        var W = 0, H = 0;
        var pipes = [], pops = [], particles = [], fireflies = [];
        var worldX = 0, birdY = 0, vy = 0;
        var phase = 'wait';               // 'wait' | 'fly' | 'dead'
        var deadUntil = 0, shake = 0;
        var score = 0, finished = false, lastT = clock();

        /* ---- Leuchtkäfer im Hintergrund (einmal streuen) ---- */
        for (var i = 0; i < 16; i++) {
          fireflies.push({
            x: Math.random(), y: 0.06 + Math.random() * 0.74,
            dx: (Math.random() * 0.024 - 0.012), w: 0.5 + Math.random() * 1.4,
            ph: Math.random() * TAU, bw: 1 + Math.random() * 2.2,
            r: 1.3 + Math.random() * 2.4, aqua: Math.random() < 0.5
          });
        }

        /* ---- DOM: HUD + Bühne (Canvas) + Rangliste ---- */
        var scoreEl = el('div', { class: 'fl-score big-readout' }, ['0']);
        var timerEl = el('div', { class: 'mg-timer fl-timer' }, ['0:' + DURATION]);
        var hud = el('div', { class: 'fl-hud glass' }, [
          el('div', { class: 'fl-hud-cell' }, [el('span', { class: 'fl-hud-l' }, ['Lücken']), scoreEl]),
          el('div', { class: 'fl-hud-cell fl-hud-right' }, [el('span', { class: 'fl-hud-l' }, ['Zeit']), timerEl])
        ]);

        var canvas = el('canvas', { class: 'fl-canvas' });
        var stage = el('div', { class: 'fl-stage', tabindex: '0', 'aria-label': 'Spielfeld – tippen zum Fliegen' }, [canvas]);
        var cvx = canvas.getContext('2d');

        var pieces = [hud, stage];
        var board = null;
        if (isMulti) {
          board = MG.liveBoard(ctx.room, ctx.me.id);
          addStop(board.stop);
          pieces.push(el('div', { class: 'glass fl-board-wrap' }, [
            el('div', { class: 'mg-field-title' }, ['🏆 Rangliste']),
            board.root
          ]));
        }
        pieces.push(el('div', { class: 'hint-text fl-hint' }, [
          '🦜 Tippen · Klick · Leertaste = Flügelschlag. Crash? Nach 1 Sek geht\'s weiter – Punkte bleiben!'
        ]));

        var layout = el('div', { class: 'fl-wrap' }, pieces);
        root.innerHTML = ''; root.appendChild(layout);

        if (isMulti) ctx.room.reportScore(0);

        /* ---- Canvas-Größe (DPR-scharf), Resize-sicher ---- */
        function resize() {
          var rect = stage.getBoundingClientRect();
          var cssW = Math.max(1, Math.round(rect.width));
          var cssH = Math.max(1, Math.round(rect.height));
          var dpr = Math.min(window.devicePixelRatio || 1, 2);
          var ratio = (W > 0) ? cssW / W : 1;
          canvas.width = Math.round(cssW * dpr);
          canvas.height = Math.round(cssH * dpr);
          canvas.style.width = cssW + 'px';
          canvas.style.height = cssH + 'px';
          cvx.setTransform(dpr, 0, 0, dpr, 0, 0);
          cvx.imageSmoothingEnabled = true;
          if (isFinite(ratio) && ratio !== 1) {
            for (var k = 0; k < pipes.length; k++) pipes[k].x *= ratio;
          }
          W = cssW; H = cssH;
        }
        resize();
        birdY = H * 0.40;
        if (typeof ResizeObserver !== 'undefined') {
          var ro = new ResizeObserver(function () { resize(); });
          ro.observe(stage);
          addStop(function () { ro.disconnect(); });
        } else {
          var onWinResize = function () { resize(); };
          window.addEventListener('resize', onWinResize);
          addStop(function () { window.removeEventListener('resize', onWinResize); });
        }

        /* ---- Eingabe: Pointer (Maus/Touch/Pen) + Tastatur ---- */
        function onPointerDown(e) { if (e && e.preventDefault) e.preventDefault(); flap(); }
        stage.addEventListener('pointerdown', onPointerDown);
        addStop(function () { stage.removeEventListener('pointerdown', onPointerDown); });

        function onKey(e) {
          if (e.repeat) return;
          if (e.code === 'Space' || e.key === ' ' || e.code === 'ArrowUp' || e.key === 'ArrowUp' || e.code === 'KeyW') {
            e.preventDefault(); flap();
          }
        }
        document.addEventListener('keydown', onKey);
        addStop(function () { document.removeEventListener('keydown', onKey); });

        function flap() {
          if (destroyed || finished) return;
          if (phase === 'dead') return;
          if (phase === 'wait') phase = 'fly';
          vy = -0.80 * H;
          if (App.Audio) App.Audio.blip(660, 0.07, { type: 'triangle', peak: 0.05 });
        }

        /* ---- abgeleitete Maße (jederzeit aus W/H, Resize-robust) ---- */
        function metrics(now) {
          var groundH = clamp(H * 0.11, 26, 72);
          var groundY = H - groundH;
          var birdR = clamp(H * 0.040, 11, 28);
          var birdX = W * 0.30;
          var elapsed = clamp((now - startAt) / (DURATION * 1000), 0, 1);
          var speed = W * 0.30 * (1 + elapsed * 0.55);           // wird über die Runde schneller
          var gap = Math.max(birdR * 4.6, H * 0.34 * (1 - elapsed * 0.16)); // wird enger
          var pipeW = clamp(W * 0.13, 44, 110);
          var spacing = Math.max(W * 0.55, pipeW * 3.6);
          return {
            groundY: groundY, birdR: birdR, birdX: birdX, speed: speed,
            gap: gap, pipeW: pipeW, spacing: spacing, gravity: 2.4 * H
          };
        }

        function spawnPipe(x) {
          pipes.push({ x: x, f: 0.14 + Math.random() * 0.72, passed: false });
        }
        function pipeGap(p, m) {
          var minC = m.gap / 2 + H * 0.03;
          var maxC = m.groundY - m.gap / 2 - H * 0.03;
          if (maxC < minC) maxC = minC;
          var cy = minC + p.f * (maxC - minC);
          return { gt: cy - m.gap / 2, gb: cy + m.gap / 2 };
        }

        function onScore(m, now) {
          score++;
          if (scoreEl) {
            scoreEl.textContent = String(score);
            scoreEl.classList.remove('fl-bump'); void scoreEl.offsetWidth; scoreEl.classList.add('fl-bump');
          }
          if (isMulti) ctx.room.reportScore(score);
          if (App.Audio) App.Audio.sfx('point');
          pops.push({ x: m.birdX + m.birdR * 0.6, y: birdY - m.birdR * 1.1, t0: now });
        }

        function crash(now, m) {
          if (phase !== 'fly') return;
          if (App.Audio) App.Audio.sfx('hit');
          phase = 'dead'; deadUntil = now + 1000; shake = Math.max(shake, 12);
          vy = -0.12 * H;
          var cols = ['#39ff14', '#33e6d0', '#7dff5a', '#ffd23f'];
          for (var i = 0; i < 12; i++) {
            var a = Math.random() * TAU, sp = (0.3 + Math.random() * 0.7) * H;
            particles.push({
              x: m.birdX, y: birdY, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 0.2 * H,
              rot: Math.random() * TAU, vr: Math.random() * 8 - 4,
              s: m.birdR * 0.28, life: 0.6 + Math.random() * 0.5, col: cols[i % cols.length]
            });
          }
        }

        function respawn() {
          phase = 'wait'; pipes = []; vy = 0; birdY = H * 0.40; // Punkte bleiben erhalten
        }

        /* ---- Physik / Logik (dt in Sekunden, geclampt) ---- */
        function update(dt, now, m) {
          // Partikel (Federn) immer aktualisieren
          for (var i = particles.length - 1; i >= 0; i--) {
            var p = particles[i]; p.life -= dt;
            if (p.life <= 0) { particles.splice(i, 1); continue; }
            p.vy += m.gravity * 0.25 * dt; p.x += p.vx * dt; p.y += p.vy * dt; p.rot += p.vr * dt;
          }

          if (phase === 'wait') {
            birdY = H * 0.40 + Math.sin(now * 0.006) * m.birdR * 0.7;
            vy = 0;
            return;
          }
          if (phase === 'dead') {
            vy += m.gravity * dt; birdY += vy * dt;
            if (birdY + m.birdR * 0.85 > m.groundY) { birdY = m.groundY - m.birdR * 0.85; vy = 0; }
            if (now >= deadUntil) respawn();
            return;
          }

          /* phase === 'fly' */
          vy += m.gravity * dt; birdY += vy * dt;
          worldX += m.speed * dt;
          for (var j = 0; j < pipes.length; j++) pipes[j].x -= m.speed * dt;
          pipes = pipes.filter(function (pp) { return pp.x + m.pipeW > -30; });

          // Nachschub
          if (pipes.length === 0) {
            spawnPipe(W + W * 0.25);
          } else {
            var last = pipes[pipes.length - 1];
            if (last.x < W - m.spacing) spawnPipe(last.x + m.spacing);
          }

          // Punkte: durchflogene Lücke
          for (var s = 0; s < pipes.length; s++) {
            var ps = pipes[s];
            if (!ps.passed && (ps.x + m.pipeW) < m.birdX) { ps.passed = true; onScore(m, now); }
          }

          // Kollision (etwas gnädig)
          var cr = m.birdR * 0.72, hit = false;
          if (birdY - cr < 0) { birdY = cr; hit = true; }
          else if (birdY + cr > m.groundY) { birdY = m.groundY - cr; hit = true; }
          else {
            for (var c = 0; c < pipes.length; c++) {
              var pc = pipes[c];
              if (m.birdX + cr > pc.x && m.birdX - cr < pc.x + m.pipeW) {
                var g = pipeGap(pc, m);
                if (birdY - cr < g.gt || birdY + cr > g.gb) { hit = true; break; }
              }
            }
          }
          if (hit) crash(now, m);
        }

        /* ============================ ZEICHNEN ============================ */
        function leafRow(yBase, amp, rad, color, factor, phaseOff) {
          cvx.fillStyle = color;
          var step = rad * 1.25;
          var off = -(((worldX * factor) + phaseOff * step) % step);
          for (var x = off - step; x < W + step; x += step) {
            var yy = yBase + Math.abs(Math.sin(x * 0.6 / step + phaseOff)) * amp;
            cvx.beginPath(); cvx.arc(x, yy, rad, 0, TAU); cvx.fill();
          }
        }

        function drawBg(now, m) {
          var g = cvx.createLinearGradient(0, 0, 0, H);
          g.addColorStop(0, '#06180e'); g.addColorStop(0.5, '#0b2617'); g.addColorStop(1, '#04120a');
          cvx.fillStyle = g; cvx.fillRect(0, 0, W, H);

          var rg = cvx.createRadialGradient(W * 0.5, H * 0.12, 0, W * 0.5, H * 0.12, H * 0.62);
          rg.addColorStop(0, 'rgba(57,255,20,0.10)'); rg.addColorStop(1, 'rgba(57,255,20,0)');
          cvx.fillStyle = rg; cvx.fillRect(0, 0, W, H);

          // Blätterdach (zwei Parallax-Ebenen, hängen oben)
          leafRow(H * 0.02, H * 0.09, H * 0.11, 'rgba(4,26,14,0.92)', 0.12, 0.0);
          leafRow(H * 0.00, H * 0.07, H * 0.075, 'rgba(9,42,23,0.72)', 0.24, 2.0);

          // Leuchtkäfer
          var t = now * 0.001;
          for (var i = 0; i < fireflies.length; i++) {
            var f = fireflies[i];
            var fx = ((((f.x + t * f.dx) % 1) + 1) % 1) * W;
            var fy = (f.y + Math.sin(t * f.w + f.ph) * 0.05) * m.groundY;
            var a = 0.2 + 0.5 * (0.5 + 0.5 * Math.sin(t * f.bw + f.ph));
            cvx.save(); cvx.globalAlpha = a;
            cvx.fillStyle = f.aqua ? '#7ffbe9' : '#b6ff7a';
            cvx.shadowColor = f.aqua ? 'rgba(51,230,208,.9)' : 'rgba(57,255,20,.9)'; cvx.shadowBlur = 10;
            cvx.beginPath(); cvx.arc(fx, fy, f.r, 0, TAU); cvx.fill();
            cvx.restore();
          }
        }

        function pipeHalf(x, top, bot, w, capTop) {
          var h = bot - top; if (h <= 0) return;
          var rad = Math.min(10, w * 0.22);
          var g = cvx.createLinearGradient(x, 0, x + w, 0);
          g.addColorStop(0, '#0e3417'); g.addColorStop(0.18, '#2fa83a');
          g.addColorStop(0.5, '#7dff5a'); g.addColorStop(0.82, '#2c9a34'); g.addColorStop(1, '#0c2e14');
          cvx.fillStyle = g; rr(cvx, x, top, w, h, rad); cvx.fill();

          // Bambus-Knoten
          cvx.save(); rr(cvx, x, top, w, h, rad); cvx.clip();
          var seg = Math.max(28, w * 1.15);
          for (var yy = top + seg; yy < bot; yy += seg) {
            cvx.strokeStyle = 'rgba(6,30,15,.55)'; cvx.lineWidth = Math.max(2, w * 0.05);
            cvx.beginPath(); cvx.moveTo(x, yy); cvx.lineTo(x + w, yy); cvx.stroke();
            cvx.strokeStyle = 'rgba(200,255,180,.18)'; cvx.lineWidth = 1.5;
            cvx.beginPath(); cvx.moveTo(x, yy + 3); cvx.lineTo(x + w, yy + 3); cvx.stroke();
          }
          cvx.restore();

          // Neon-Kontur
          cvx.shadowColor = 'rgba(57,255,20,.75)'; cvx.shadowBlur = 12;
          cvx.lineWidth = 2.4; cvx.strokeStyle = 'rgba(126,255,120,.9)';
          rr(cvx, x, top, w, h, rad); cvx.stroke(); cvx.shadowBlur = 0;

          // Lippe an der Lücken-Öffnung
          var lipH = Math.min(w * 0.55, 26), over = w * 0.12;
          var ly = capTop ? top : bot - lipH;
          var g2 = cvx.createLinearGradient(x - over, 0, x + w + over, 0);
          g2.addColorStop(0, '#12401d'); g2.addColorStop(0.5, '#8dff6a'); g2.addColorStop(1, '#12401d');
          cvx.fillStyle = g2; rr(cvx, x - over, ly, w + over * 2, lipH, 8); cvx.fill();
          cvx.shadowColor = 'rgba(57,255,20,.8)'; cvx.shadowBlur = 14;
          cvx.lineWidth = 2.4; cvx.strokeStyle = 'rgba(57,255,20,.95)';
          rr(cvx, x - over, ly, w + over * 2, lipH, 8); cvx.stroke(); cvx.shadowBlur = 0;
          // kleine Blätter an den Ecken
          cvx.fillStyle = 'rgba(57,255,20,.5)';
          cvx.beginPath(); cvx.arc(x - over, ly + lipH * 0.5, 5, 0, TAU); cvx.fill();
          cvx.beginPath(); cvx.arc(x + w + over, ly + lipH * 0.5, 5, 0, TAU); cvx.fill();
        }

        function drawPipes(m) {
          for (var i = 0; i < pipes.length; i++) {
            var p = pipes[i], g = pipeGap(p, m);
            pipeHalf(p.x, 0, g.gt, m.pipeW, false);        // von der Decke
            pipeHalf(p.x, g.gb, m.groundY, m.pipeW, true);  // vom Boden
          }
        }

        function drawGround(m) {
          var gy = m.groundY;
          var g = cvx.createLinearGradient(0, gy, 0, H);
          g.addColorStop(0, '#123f1e'); g.addColorStop(1, '#04150a');
          cvx.fillStyle = g; cvx.fillRect(0, gy, W, H - gy);
          cvx.shadowColor = 'rgba(57,255,20,.8)'; cvx.shadowBlur = 12;
          cvx.fillStyle = 'rgba(126,255,120,.95)'; cvx.fillRect(0, gy - 2, W, 3); cvx.shadowBlur = 0;
          cvx.fillStyle = 'rgba(57,255,20,.32)';
          var step = 16, off = -(worldX % step);
          for (var x = off; x < W; x += step) {
            cvx.beginPath(); cvx.moveTo(x, gy); cvx.lineTo(x + step * 0.5, gy - 8); cvx.lineTo(x + step, gy); cvx.closePath(); cvx.fill();
          }
        }

        function drawParticles() {
          for (var i = 0; i < particles.length; i++) {
            var p = particles[i];
            cvx.save(); cvx.globalAlpha = clamp(p.life / 0.5, 0, 1);
            cvx.translate(p.x, p.y); cvx.rotate(p.rot);
            cvx.fillStyle = p.col; cvx.shadowColor = p.col; cvx.shadowBlur = 8;
            rr(cvx, -p.s, -p.s * 0.4, p.s * 2, p.s * 0.8, p.s * 0.4); cvx.fill();
            cvx.restore();
          }
        }

        function drawPops(now) {
          pops = pops.filter(function (o) { return now - o.t0 < 700; });
          for (var i = 0; i < pops.length; i++) {
            var o = pops[i], age = now - o.t0, a = 1 - age / 700;
            cvx.save(); cvx.globalAlpha = a; cvx.textAlign = 'center';
            cvx.fillStyle = '#7dff5a'; cvx.shadowColor = 'rgba(57,255,20,.7)'; cvx.shadowBlur = 10;
            cvx.font = '900 ' + Math.round(clamp(H * 0.045, 16, 30)) + 'px system-ui,sans-serif';
            cvx.fillText('+1', o.x, o.y - age * 0.06);
            cvx.restore();
          }
        }

        function drawParrot(now, m) {
          var ang = clamp(vy / (0.9 * H), -0.5, 1.0);
          cvx.save();
          cvx.translate(m.birdX, birdY);
          // Aura (glühender Papagei)
          var aur = cvx.createRadialGradient(0, 0, m.birdR * 0.3, 0, 0, m.birdR * 2.0);
          aur.addColorStop(0, 'rgba(57,255,20,0.30)'); aur.addColorStop(0.6, 'rgba(57,255,20,0.10)'); aur.addColorStop(1, 'rgba(57,255,20,0)');
          cvx.fillStyle = aur; cvx.beginPath(); cvx.arc(0, 0, m.birdR * 2.0, 0, TAU); cvx.fill();

          cvx.rotate(ang);
          cvx.scale(m.birdR, m.birdR);
          var wing = Math.sin(now * 0.02) * (phase === 'fly' ? 0.85 : 0.35) - 0.15;

          // Schwanzfedern (türkis)
          cvx.fillStyle = '#2fd6c0';
          cvx.beginPath(); cvx.moveTo(-0.55, 0.05); cvx.lineTo(-1.85, -0.2); cvx.lineTo(-1.7, 0.18);
          cvx.lineTo(-1.9, 0.55); cvx.lineTo(-0.5, 0.42); cvx.closePath(); cvx.fill();
          cvx.lineWidth = 0.05; cvx.strokeStyle = 'rgba(57,255,20,.5)'; cvx.stroke();

          // Körper
          var bg = cvx.createLinearGradient(0, -0.85, 0, 0.85);
          bg.addColorStop(0, '#8dff5f'); bg.addColorStop(1, '#1f9e2e');
          cvx.fillStyle = bg; cvx.beginPath(); cvx.ellipse(-0.05, 0.05, 1.0, 0.82, 0, 0, TAU); cvx.fill();
          cvx.lineWidth = 0.05; cvx.strokeStyle = 'rgba(57,255,20,.45)'; cvx.stroke();

          // Kopf
          var hg = cvx.createLinearGradient(0, -1.05, 0, -0.1);
          hg.addColorStop(0, '#a9ff8a'); hg.addColorStop(1, '#2fbf3a');
          cvx.fillStyle = hg; cvx.beginPath(); cvx.arc(0.5, -0.42, 0.62, 0, TAU); cvx.fill();

          // Federkamm
          cvx.fillStyle = '#39ff14';
          cvx.beginPath(); cvx.moveTo(0.25, -0.95); cvx.lineTo(0.05, -1.4); cvx.lineTo(0.45, -1.05); cvx.closePath(); cvx.fill();
          cvx.beginPath(); cvx.moveTo(0.5, -1.02); cvx.lineTo(0.4, -1.5); cvx.lineTo(0.72, -1.05); cvx.closePath(); cvx.fill();

          // Schnabel (Papagei-Haken, gold)
          cvx.fillStyle = '#ffd23f';
          cvx.beginPath(); cvx.moveTo(0.95, -0.6); cvx.lineTo(1.7, -0.4);
          cvx.quadraticCurveTo(1.55, -0.08, 1.12, -0.08); cvx.lineTo(0.98, -0.2); cvx.closePath(); cvx.fill();
          cvx.fillStyle = '#d99a1c';
          cvx.beginPath(); cvx.moveTo(0.98, -0.2); cvx.lineTo(1.28, -0.06); cvx.lineTo(0.98, 0.05); cvx.closePath(); cvx.fill();

          // Wange
          cvx.fillStyle = 'rgba(255,77,109,.7)'; cvx.beginPath(); cvx.arc(0.45, -0.2, 0.14, 0, TAU); cvx.fill();
          // Auge
          cvx.fillStyle = '#eafff0'; cvx.beginPath(); cvx.arc(0.66, -0.55, 0.2, 0, TAU); cvx.fill();
          cvx.fillStyle = '#052012'; cvx.beginPath(); cvx.arc(0.72, -0.55, 0.1, 0, TAU); cvx.fill();
          cvx.fillStyle = '#fff'; cvx.beginPath(); cvx.arc(0.68, -0.59, 0.035, 0, TAU); cvx.fill();

          // Flügel (schlägt), über dem Körper
          cvx.save(); cvx.translate(-0.05, -0.02); cvx.rotate(wing);
          var wg = cvx.createLinearGradient(0, -0.45, 0, 0.4);
          wg.addColorStop(0, '#9ffff0'); wg.addColorStop(1, '#22b6a3');
          cvx.fillStyle = wg; cvx.beginPath(); cvx.ellipse(-0.12, 0.02, 0.66, 0.36, 0.35, 0, TAU); cvx.fill();
          cvx.lineWidth = 0.05; cvx.strokeStyle = 'rgba(4,20,12,.4)'; cvx.stroke();
          cvx.restore();

          cvx.restore();
        }

        function centerText(big, small) {
          cvx.save(); cvx.textAlign = 'center';
          cvx.shadowColor = 'rgba(57,255,20,.7)'; cvx.shadowBlur = 18;
          var bigPx = Math.round(clamp(H * 0.06, 20, 40));
          cvx.fillStyle = '#eafff0'; cvx.font = '900 ' + bigPx + 'px system-ui,sans-serif';
          cvx.fillText(big, W / 2, H * 0.42);
          cvx.shadowBlur = 0;
          if (small) {
            cvx.fillStyle = 'rgba(200,255,200,.85)';
            cvx.font = '600 ' + Math.round(clamp(H * 0.032, 12, 20)) + 'px system-ui,sans-serif';
            cvx.fillText(small, W / 2, H * 0.42 + bigPx * 0.95);
          }
          cvx.restore();
        }

        function draw(now, m) {
          cvx.clearRect(0, 0, W, H);
          var sx = (Math.random() * 2 - 1) * shake, sy = (Math.random() * 2 - 1) * shake;
          cvx.save(); cvx.translate(sx, sy);
          drawBg(now, m);
          drawPipes(m);
          drawGround(m);
          drawParticles();
          drawParrot(now, m);
          drawPops(now);
          cvx.restore();

          if (phase === 'dead') {
            var a = clamp((deadUntil - now) / 1000, 0, 1) * 0.35;
            cvx.fillStyle = 'rgba(255,40,70,' + a.toFixed(3) + ')'; cvx.fillRect(0, 0, W, H);
            centerText('Bruchlandung!', 'Neustart …');
          } else if (phase === 'wait') {
            centerText('Tippen zum Fliegen', 'Leertaste · Klick · Touch');
          }

          shake *= 0.86; if (shake < 0.4) shake = 0;
          if (scoreEl) scoreEl.textContent = String(score);
        }

        /* ---- Haupt-Loop: rAF mit geclamptem Zeit-Delta (Tab-sicher) ---- */
        function frame() {
          if (destroyed || finished) { raf = null; return; }
          var now = clock();
          var dt = (now - lastT) / 1000; lastT = now;
          if (dt < 0) dt = 0;
          if (dt > 0.05) dt = 0.05;          // kein Riesensprung nach Tab-Wechsel
          if (now >= endAt) { finish(); return; }
          var m = metrics(now);
          update(dt, now, m);
          draw(now, m);
          raf = requestAnimationFrame(frame);
        }
        raf = requestAnimationFrame(frame);

        /* ---- Runden-Timer (Wall-Clock, im Multi synchron) ---- */
        addStop(MG.roundTimer(endAt, function (left) {
          var secs = Math.ceil(left);
          timerEl.textContent = MG.mmss(secs);
          timerEl.classList.toggle('fl-urgent', left <= 5.5);
        }, finish, isMulti ? ctx.room.now : null));

        /* ---- Ende ---- */
        function finish() {
          if (finished || destroyed) return;
          finished = true;
          clearAll();                        // rAF, Timer, Board, Listener, Resize
          if (isMulti) {
            ctx.room.reportScore(score);
            var to = setTimeout(function () {
              if (destroyed) return;
              MG.endScreen(root, { players: ctx.room.players(), meId: ctx.me.id, onExit: ctx.onExit });
            }, 1200);
            stops.push(function () { clearTimeout(to); });
          } else {
            var best = App.Storage.get('best_flappy', 0), nb = score > best;
            if (nb) App.Storage.set('best_flappy', score);
            MG.endScreen(root, {
              title: 'Zeit um! 🦜',
              score: score, best: best, newBest: nb,
              label: nb ? 'Neuer Rekord! 🎉' : ('Lücken · Bestwert: ' + MG.fmt(best)),
              onExit: ctx.onExit,
              onAgain: function () { play(Date.now()); }
            });
          }
        }
      }
    }
  };

  /* ============================ STYLES ============================ */
  function injectStyle() {
    UI.injectStyle('mg-flappy-css', [
      '.fl-wrap{display:flex;flex-direction:column;gap:14px;}',
      /* HUD */
      '.fl-hud{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px 18px;}',
      '.fl-hud-cell{display:flex;flex-direction:column;gap:2px;}',
      '.fl-hud-right{align-items:flex-end;}',
      '.fl-hud-l{font-size:11px;text-transform:uppercase;letter-spacing:1px;color:var(--muted);}',
      '.fl-score{font-size:clamp(26px,7vw,42px);line-height:1;color:var(--neon);text-shadow:0 0 14px rgba(57,255,20,.5);font-variant-numeric:tabular-nums;}',
      '.fl-score.fl-bump{animation:fl-bump .28s ease;}',
      '@keyframes fl-bump{0%{transform:scale(1)}45%{transform:scale(1.28)}100%{transform:scale(1)}}',
      '.fl-timer{font-size:clamp(20px,5vw,28px);font-variant-numeric:tabular-nums;}',
      '.fl-timer.fl-urgent{color:var(--danger);animation:fl-pulse .6s ease-in-out infinite;}',
      '@keyframes fl-pulse{0%,100%{opacity:1}50%{opacity:.45}}',
      /* Bühne (Canvas) */
      '.fl-stage{position:relative;width:100%;height:min(64vh,600px);min-height:320px;',
      'border-radius:var(--radius,16px);overflow:hidden;cursor:pointer;',
      'touch-action:none;user-select:none;-webkit-user-select:none;-webkit-tap-highlight-color:transparent;-webkit-touch-callout:none;',
      'background:#04140c;box-shadow:inset 0 0 46px rgba(0,0,0,.55),0 0 0 1px var(--stroke,rgba(57,255,20,.18));outline:none;}',
      '.fl-stage:focus-visible{box-shadow:inset 0 0 46px rgba(0,0,0,.55),0 0 0 2px var(--neon,#39ff14);}',
      '.fl-canvas{display:block;width:100%;height:100%;}',
      /* Rangliste + Hinweis */
      '.fl-board-wrap{padding:14px;display:flex;flex-direction:column;gap:8px;max-height:260px;overflow-y:auto;}',
      '.fl-hint{text-align:center;font-size:13px;line-height:1.4;}'
    ].join(''));
  }
})();
