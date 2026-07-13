/* stacktower.js — "Turm-Stapler": klassisches Stack-/Tower-Spiel im Neon-Dschungel.
 * Ein leuchtender Block gleitet hin und her; per Klick / Tap / Leertaste legst du
 * ihn ab. Der Überhang zum Block darunter wird abgeschnitten → der Turm wird
 * schmaler. Ein exakter Treffer (PERFEKT!) schneidet nichts ab, gibt Bonus-Punkte
 * und lässt den Turm wieder etwas breiter werden. Landet der Block komplett daneben,
 * stürzt der Turm — kurze Pause, dann geht es (mit deinen Punkten) von vorne weiter.
 * Zeitrennen über 60 s: je höher, desto mehr Punkte pro Block, desto schneller.
 * Singleplayer (Bestwert) + Multiplayer (synchroner Start, Live-Rangliste, Podest).
 * Canvas-Render über rAF mit geclamptem Zeit-Delta (Date.now / room.now) -> Tab-sicher. */
(function () {
  'use strict';
  window.App = window.App || {}; App.Minigames = App.Minigames || {};
  var UI = App.UI, el = UI.el, MG = App.MG;

  var DURATION = 60; // Sekunden Rundenzeit (single + multi)

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  /* Blockfarbe je nach Höhe: pendelt zwischen Neon-Grün und Türkis. */
  function blockHue(i) { return Math.round(116 + Math.sin(i * 0.45) * 46); }

  App.Minigames.stacktower = {
    id: 'stacktower', title: 'Turm-Stapler', icon: '🧱', order: 12,
    subtitle: 'Staple die Blöcke exakt — je höher, desto mehr Punkte',
    single: true, multi: true, minPlayers: 2, maxPlayers: 8,

    render: function (root, ctx) {
      injectStyle();
      var isMulti = ctx.mode === 'multi';
      var clock = isMulti ? ctx.room.now : Date.now;

      /* ---- Aufräum-Register (ALLES muss in cleanup weg) ---- */
      var stops = [], listeners = [], tos = [], raf = null, ro = null, dead = false;
      function after(ms, fn) { var t = setTimeout(fn, ms); tos.push(t); return t; }
      function stopAll() {
        if (raf) { cancelAnimationFrame(raf); raf = null; }
        stops.forEach(function (f) { try { f(); } catch (e) {} }); stops = [];
        listeners.forEach(function (l) { try { l.t.removeEventListener(l.e, l.fn); } catch (e) {} }); listeners = [];
        tos.forEach(clearTimeout); tos = [];
        if (ro) { try { ro.disconnect(); } catch (e) {} ro = null; }
      }
      function cleanup() { dead = true; stopAll(); }

      /* ---- Runden-Zustand ---- */
      var V = { W: 320, H: 480, dpr: 1 };
      var blocks = [], moving = null, fallers = [], particles = [];
      var cam = 0, phase = 'play', collapseUntil = 0, shakeAmp = 0;
      var score = 0, perfectStreak = 0, maxHeight = 0, lastTs = 0, finished = false, endAt = 0;
      var stageEl = null, canvas = null, g2 = null, boardWrap = null, board = null;
      var hudScore = null, hudHeight = null, hudCombo = null, hudTimer = null;

      /* ---- Start ---- */
      if (isMulti) {
        var snap = ctx.room.snapshot() || {};
        var startAt = (snap.round && snap.round.startAt) || (ctx.room.now() + 3000);
        stops.push(MG.countdown(root, startAt, function () { startGame(startAt); }, ctx.room.now));
      } else {
        startGame(Date.now()); // Singleplayer: sofort los
      }
      return { cleanup: cleanup };

      /* ===================== HILFEN: MASSE / MAPPING ===================== */
      function BH() { return clamp(V.H * 0.085, 22, 44); }         // Blockhöhe in CSS-px
      function sY(worldTop) { return V.H - (worldTop - cam); }     // Welt-Oberkante -> Screen-y

      function measure() {
        var r = stageEl.getBoundingClientRect();
        V.W = Math.max(140, Math.round(r.width));
        V.H = Math.max(240, Math.round(r.height));
        V.dpr = Math.min(2, window.devicePixelRatio || 1);
      }
      function setupBuffer() {
        canvas.width = Math.round(V.W * V.dpr);
        canvas.height = Math.round(V.H * V.dpr);
        g2.setTransform(V.dpr, 0, 0, V.dpr, 0, 0);
      }
      function onResize() {
        if (!stageEl || !canvas) return;
        var oldW = V.W;
        measure();
        if (oldW > 0 && Math.abs(oldW - V.W) > 0.5) {
          var ratio = V.W / oldW;
          blocks.forEach(function (b) { b.x *= ratio; b.w *= ratio; });
          if (moving) { moving.x *= ratio; moving.w *= ratio; moving.speed *= ratio; }
        }
        setupBuffer();
      }

      /* ===================== UI-AUFBAU ===================== */
      function buildUI() {
        hudScore = el('div', { class: 'st-score big-readout' }, ['0']);
        hudHeight = el('div', { class: 'st-height' }, ['0']);
        hudCombo = el('div', { class: 'st-combo' }, ['']);
        hudTimer = el('div', { class: 'mg-timer st-timer' }, [MG.mmss(DURATION)]);
        var hud = el('div', { class: 'st-hud glass' }, [
          el('div', { class: 'st-hud-cell' }, [el('span', { class: 'st-hud-l' }, ['Punkte']), hudScore]),
          hudCombo,
          el('div', { class: 'st-hud-cell st-hud-mid' }, [el('span', { class: 'st-hud-l' }, ['Höhe']), hudHeight]),
          el('div', { class: 'st-hud-cell st-hud-right' }, [el('span', { class: 'st-hud-l' }, ['Zeit']), hudTimer])
        ]);
        canvas = el('canvas', { class: 'st-canvas' });
        stageEl = el('div', { class: 'game-stage st-stage' }, [canvas]);
        var hint = el('div', { class: 'hint-text st-hint' }, ['Tippen · Klicken · Leertaste zum Ablegen — triff exakt für PERFEKT!']);
        var pieces = [hud, stageEl, hint];
        boardWrap = null;
        if (isMulti) {
          boardWrap = el('div', { class: 'glass st-board-wrap' }, [el('div', { class: 'mg-field-title' }, ['🏆 Rangliste'])]);
          pieces.push(boardWrap);
        }
        root.innerHTML = '';
        root.appendChild(el('div', { class: 'st-layout' }, pieces));
        g2 = canvas.getContext('2d');
      }

      function addInput() {
        var pd = function (e) { if (e && e.cancelable) e.preventDefault(); dropBlock(); };
        stageEl.addEventListener('pointerdown', pd);
        listeners.push({ t: stageEl, e: 'pointerdown', fn: pd });
        var kd = function (e) {
          if (e.code === 'Space' || e.key === ' ' || e.keyCode === 32) { e.preventDefault(); dropBlock(); }
        };
        window.addEventListener('keydown', kd);
        listeners.push({ t: window, e: 'keydown', fn: kd });
      }

      /* ===================== SPIEL START ===================== */
      function startGame(startAtMs) {
        finished = false; score = 0; perfectStreak = 0; maxHeight = 0;
        phase = 'play'; cam = 0; shakeAmp = 0;
        blocks = []; moving = null; fallers = []; particles = [];
        endAt = startAtMs + DURATION * 1000;

        buildUI();
        measure(); setupBuffer();
        buildFoundation();
        spawnMoving();
        cam = Math.max(0, (blocks.length + 1) * BH() - V.H * 0.72); // Startkamera direkt richtig

        addInput();
        if ('ResizeObserver' in window) { ro = new ResizeObserver(onResize); ro.observe(stageEl); }
        else { var wf = function () { onResize(); }; window.addEventListener('resize', wf); listeners.push({ t: window, e: 'resize', fn: wf }); }

        if (isMulti) {
          board = MG.liveBoard(ctx.room, ctx.me.id);
          stops.push(board.stop);
          boardWrap.appendChild(board.root);
          ctx.room.reportScore(0);
        }

        stops.push(MG.roundTimer(endAt, function (left) {
          hudTimer.textContent = MG.mmss(Math.ceil(left));
          hudTimer.classList.toggle('st-urgent', left <= 6);
        }, finish, isMulti ? ctx.room.now : null));

        updateHud();
        lastTs = clock();
        raf = requestAnimationFrame(frame);
      }

      function buildFoundation() {
        var iw = clamp(V.W * 0.5, 120, Math.min(300, V.W * 0.72));
        blocks = [{ x: (V.W - iw) / 2, w: iw, hue: blockHue(0) }];
      }

      function spawnMoving() {
        var top = blocks[blocks.length - 1];
        var w = top.w;
        var fromLeft = (blocks.length % 2) === 0;
        var right = Math.max(0, V.W - w);
        var speed = clamp(V.W * 0.5 + blocks.length * V.W * 0.04, V.W * 0.5, V.W * 1.75);
        moving = {
          x: fromLeft ? 0 : right, w: w, dir: fromLeft ? 1 : -1,
          speed: speed, hue: blockHue(blocks.length)
        };
      }

      /* ===================== ABLEGEN ===================== */
      function dropBlock() {
        if (dead || finished || phase !== 'play' || !moving) return;
        var prev = blocks[blocks.length - 1];
        var cur = moving;
        var idx = blocks.length; // Ebene des beweglichen Blocks

        var oL = Math.max(cur.x, prev.x), oR = Math.min(cur.x + cur.w, prev.x + prev.w);
        var ov = oR - oL;
        if (ov <= 0.5) { startCollapse(cur); return; } // komplett daneben -> Absturz

        var delta = Math.abs(cur.x - prev.x);
        var tol = Math.max(5, V.W * 0.012);
        var perfect = delta <= tol;
        var nb;
        if (perfect) {
          var grow = clamp(V.W * 0.9 - prev.w, 0, V.W * 0.05); // etwas breiter als Belohnung
          var nw = prev.w + grow;
          var nx = clamp(prev.x - grow / 2, 0, V.W - nw);
          nb = { x: nx, w: nw, hue: cur.hue };
          perfectStreak++;
          perfectFlash();
          spawnParticles(nx + nw / 2, idx);
        } else {
          perfectStreak = 0;
          spawnOverhangFaller(cur, oL, oR, idx); // abgeschnittenes Stück fällt
          nb = { x: oL, w: ov, hue: cur.hue };
        }
        blocks.push(nb);

        var h = blocks.length;                 // inkl. Fundament
        var gained = 8 + h * 2;                 // höher = mehr Punkte
        if (perfect) gained += 18 + (perfectStreak - 1) * 8;
        score += gained;
        maxHeight = Math.max(maxHeight, h - 1);
        if (isMulti) ctx.room.reportScore(score);

        popFloat(nb.x + nb.w / 2, sY(h * BH()), '+' + gained, perfect ? 'st-float-perf' : '');
        updateHud();
        spawnMoving();
      }

      function startCollapse(cur) {
        phase = 'collapsing'; perfectStreak = 0;
        var prev = blocks[blocks.length - 1];
        var away = (cur.x + cur.w / 2) < (prev.x + prev.w / 2) ? -1 : 1;
        fallers.push(makeFaller(cur.x, blocks.length, cur.w, cur.hue, away * V.W * 0.28, -V.H * 0.12));
        shakeAmp = 16;
        crashFlash();
        moving = null;
        collapseUntil = clock() + 1150; // kurze Pause, dann Neustart (in frame gesteuert)
        updateHud();
      }

      function resetTower() {
        buildFoundation();
        perfectStreak = 0; fallers = []; particles = [];
        phase = 'play';
        spawnMoving();
      }

      /* ===================== FALLENDE STÜCKE / PARTIKEL ===================== */
      function makeFaller(x, idx, w, hue, vx, vy) {
        return { sx: x, sy: sY((idx + 1) * BH()), w: w, hue: hue, vx: vx, vy: vy, rot: 0, vr: (Math.random() - 0.5) * 5 };
      }
      function spawnOverhangFaller(cur, oL, oR, idx) {
        var sx, sw, vx;
        if (cur.x < oL) { sx = cur.x; sw = oL - cur.x; vx = -V.W * 0.18; }
        else { sx = oR; sw = (cur.x + cur.w) - oR; vx = V.W * 0.18; }
        if (sw > 1) fallers.push(makeFaller(sx, idx, sw, cur.hue, vx, -V.H * 0.05));
      }
      function updateFallers(dt) {
        for (var i = 0; i < fallers.length; i++) {
          var f = fallers[i];
          f.vy += V.H * 2.6 * dt; f.sx += f.vx * dt; f.sy += f.vy * dt; f.rot += f.vr * dt;
        }
        fallers = fallers.filter(function (f) { return f.sy < V.H + 200; });
      }
      function spawnParticles(cx, idx) {
        var sy = sY((idx + 1) * BH());
        for (var i = 0; i < 14; i++) {
          var a = Math.random() * Math.PI * 2, sp = V.H * (0.25 + Math.random() * 0.55);
          particles.push({
            x: cx + (Math.random() - 0.5) * 44, y: sy,
            vx: Math.cos(a) * sp * 0.6, vy: -Math.abs(Math.sin(a)) * sp - V.H * 0.1,
            life: 0.5 + Math.random() * 0.45, max: 0.95, hue: blockHue(idx)
          });
        }
      }
      function updateParticles(dt) {
        for (var i = 0; i < particles.length; i++) {
          var p = particles[i];
          p.vy += V.H * 2.4 * dt; p.x += p.vx * dt; p.y += p.vy * dt; p.life -= dt;
        }
        particles = particles.filter(function (p) { return p.life > 0 && p.y < V.H + 40; });
      }

      /* ===================== HAUPT-LOOP ===================== */
      function frame() {
        if (dead || finished) return;
        var now = clock();
        var dt = clamp((now - lastTs) / 1000, 0, 0.05); // Delta clampen -> Tab-sicher
        lastTs = now;

        if (phase === 'play' && moving) {
          moving.x += moving.dir * moving.speed * dt;
          var right = Math.max(0, V.W - moving.w);
          if (moving.x <= 0) { moving.x = 0; moving.dir = 1; }
          else if (moving.x >= right) { moving.x = right; moving.dir = -1; }
        }
        if (phase === 'collapsing' && now >= collapseUntil) resetTower();

        var camTarget = Math.max(0, (blocks.length + 1) * BH() - V.H * 0.72);
        cam += (camTarget - cam) * Math.min(1, dt * 7);

        updateFallers(dt);
        updateParticles(dt);
        if (shakeAmp > 0.3) shakeAmp *= Math.pow(0.0015, dt); else shakeAmp = 0;

        draw(now);
        raf = requestAnimationFrame(frame);
      }

      /* ===================== ZEICHNEN ===================== */
      function draw(now) {
        var W = V.W, H = V.H, bh = BH();
        var bg = g2.createLinearGradient(0, 0, 0, H);
        bg.addColorStop(0, '#06180f'); bg.addColorStop(1, '#020a06');
        g2.fillStyle = bg; g2.fillRect(0, 0, W, H);

        g2.save();
        if (shakeAmp) g2.translate((Math.random() - 0.5) * shakeAmp, (Math.random() - 0.5) * shakeAmp);

        // Tiefen-Linien (scrollen mit der Kamera)
        g2.save();
        g2.strokeStyle = 'rgba(57,255,20,0.05)'; g2.lineWidth = 1;
        var step = bh * 2, kStart = Math.floor(cam / step);
        for (var k = kStart; k < kStart + 42; k++) {
          var ly = sY(k * step);
          if (ly < -step) break;
          if (ly > H + step) continue;
          g2.beginPath(); g2.moveTo(0, ly); g2.lineTo(W, ly); g2.stroke();
        }
        g2.restore();

        // Ziel-Hilfslinien an den Kanten des obersten Blocks
        var top = blocks[blocks.length - 1];
        if (phase === 'play' && top) {
          var topScreen = sY(blocks.length * bh);
          g2.save();
          g2.strokeStyle = 'rgba(57,255,20,0.11)'; g2.lineWidth = 1; g2.setLineDash([6, 8]);
          [top.x, top.x + top.w].forEach(function (gx) {
            g2.beginPath(); g2.moveTo(gx, 0); g2.lineTo(gx, topScreen); g2.stroke();
          });
          g2.restore();
        }

        // Turm
        for (var i = 0; i < blocks.length; i++) {
          var b = blocks[i];
          var yTop = sY((i + 1) * bh);
          if (yTop > H + bh || yTop + bh < -bh) continue;
          drawBlock(b.x, yTop, b.w, bh, b.hue, false, now, 1);
        }
        // beweglicher Block
        if (moving) drawBlock(moving.x, sY((blocks.length + 1) * bh), moving.w, bh, moving.hue, true, now, 1);
        // fallende Stücke
        for (var f = 0; f < fallers.length; f++) drawFaller(fallers[f], bh, now);
        // Partikel
        for (var p = 0; p < particles.length; p++) drawParticle(particles[p]);

        g2.restore();
      }

      function roundRect(x, y, w, h, r) {
        r = Math.min(r, w / 2, h / 2);
        g2.beginPath();
        g2.moveTo(x + r, y);
        g2.arcTo(x + w, y, x + w, y + h, r);
        g2.arcTo(x + w, y + h, x, y + h, r);
        g2.arcTo(x, y + h, x, y, r);
        g2.arcTo(x, y, x + w, y, r);
        g2.closePath();
      }

      function drawBlock(x, y, w, h, hue, active, now, alpha) {
        var light = active ? 68 : 56;
        var pulse = active ? (0.7 + 0.3 * Math.sin(now / 170)) : 1;
        var grad = g2.createLinearGradient(0, y, 0, y + h);
        grad.addColorStop(0, 'hsl(' + hue + ',100%,' + (light + 10) + '%)');
        grad.addColorStop(1, 'hsl(' + hue + ',82%,' + (light - 20) + '%)');
        g2.save();
        g2.globalAlpha = alpha;
        g2.shadowColor = 'hsl(' + hue + ',100%,55%)';
        g2.shadowBlur = (active ? 26 : 12) * pulse;
        g2.fillStyle = grad;
        roundRect(x, y, w, h, Math.min(7, h / 3)); g2.fill();
        g2.shadowBlur = 0;
        // heller Glanz oben
        g2.fillStyle = 'hsla(' + hue + ',100%,88%,' + (active ? 0.4 : 0.22) + ')';
        roundRect(x + 2, y + 2, Math.max(0, w - 4), Math.max(1, h * 0.28), 3); g2.fill();
        // Neon-Oberkante
        g2.strokeStyle = 'hsla(' + hue + ',100%,86%,' + (active ? 0.95 : 0.6) + ')';
        g2.lineWidth = 1.5;
        g2.beginPath(); g2.moveTo(x + 3, y + 1.4); g2.lineTo(x + w - 3, y + 1.4); g2.stroke();
        g2.restore();
      }

      function drawFaller(f, bh, now) {
        var cx = f.sx + f.w / 2, cy = f.sy + bh / 2;
        g2.save();
        g2.translate(cx, cy); g2.rotate(f.rot); g2.translate(-cx, -cy);
        drawBlock(f.sx, f.sy, f.w, bh, f.hue, false, now, 0.9);
        g2.restore();
      }

      function drawParticle(p) {
        var al = Math.max(0, p.life / p.max);
        g2.save();
        g2.globalAlpha = al;
        g2.shadowColor = 'hsl(' + p.hue + ',100%,60%)'; g2.shadowBlur = 8;
        g2.fillStyle = 'hsl(' + p.hue + ',100%,72%)';
        g2.beginPath(); g2.arc(p.x, p.y, 3, 0, Math.PI * 2); g2.fill();
        g2.restore();
      }

      /* ===================== HUD / EFFEKTE ===================== */
      function updateHud() {
        if (!hudScore) return;
        hudScore.textContent = MG.fmt(score);
        hudHeight.textContent = String(Math.max(blocks.length - 1, 0));
        if (perfectStreak > 1) {
          hudCombo.textContent = 'PERFEKT x' + perfectStreak;
          hudCombo.classList.add('on');
          hudCombo.classList.remove('bump'); void hudCombo.offsetWidth; hudCombo.classList.add('bump');
        } else {
          hudCombo.textContent = '';
          hudCombo.classList.remove('on', 'bump');
        }
      }
      function popFloat(sx, sy, txt, cls) {
        if (!stageEl) return;
        var f = el('div', { class: 'st-float ' + (cls || '') }, [txt]);
        f.style.left = sx + 'px'; f.style.top = sy + 'px';
        stageEl.appendChild(f);
        after(780, function () { if (f.parentNode) f.parentNode.removeChild(f); });
      }
      function perfectFlash() {
        if (!stageEl) return;
        var f = el('div', { class: 'st-perfect' }, ['PERFEKT!']);
        stageEl.appendChild(f);
        after(650, function () { if (f.parentNode) f.parentNode.removeChild(f); });
      }
      function crashFlash() {
        if (!stageEl) return;
        var f = el('div', { class: 'st-crash' }, ['DANEBEN!']);
        stageEl.appendChild(f);
        after(1000, function () { if (f.parentNode) f.parentNode.removeChild(f); });
      }

      /* ===================== ENDE ===================== */
      function finish() {
        if (finished || dead) return;
        finished = true;
        stopAll();
        if (isMulti) {
          ctx.room.reportScore(score);
          after(1200, function () {
            if (dead) return;
            MG.endScreen(root, { players: ctx.room.players(), meId: ctx.me.id, onExit: ctx.onExit });
          });
        } else {
          var best = App.Storage.get('best_stacktower', 0), nb = score > best;
          if (nb) App.Storage.set('best_stacktower', score);
          MG.endScreen(root, {
            title: 'Zeit um! 🧱', score: score, best: best, newBest: nb,
            label: nb ? 'Neuer Rekord! 🎉' : 'Punkte · Bestwert: ' + MG.fmt(best),
            onExit: ctx.onExit,
            onAgain: function () { stopAll(); startGame(Date.now()); }
          });
        }
      }
    }
  };

  /* ===================== STYLES ===================== */
  function injectStyle() {
    UI.injectStyle('mg-stacktower-css', [
      '.st-layout{display:flex;flex-direction:column;gap:14px;}',
      /* HUD */
      '.st-hud{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px 18px;}',
      '.st-hud-cell{display:flex;flex-direction:column;gap:2px;}',
      '.st-hud-mid{align-items:center;}',
      '.st-hud-right{align-items:flex-end;}',
      '.st-hud-l{font-size:11px;text-transform:uppercase;letter-spacing:1px;color:var(--muted);}',
      '.st-score{font-size:clamp(26px,7vw,42px);line-height:1;color:var(--neon);text-shadow:0 0 14px rgba(57,255,20,.5);font-variant-numeric:tabular-nums;}',
      '.st-height{font-size:clamp(18px,5vw,26px);font-weight:900;color:var(--aqua-soft);font-variant-numeric:tabular-nums;}',
      '.st-timer{font-size:clamp(20px,5vw,28px);font-variant-numeric:tabular-nums;}',
      '.st-timer.st-urgent{color:var(--danger-2);animation:st-pulse .6s ease-in-out infinite;}',
      '@keyframes st-pulse{0%,100%{opacity:1}50%{opacity:.5}}',
      '.st-combo{min-width:80px;text-align:center;font-weight:900;font-size:clamp(14px,4vw,20px);color:var(--gold);opacity:0;transition:opacity .2s;text-shadow:0 0 12px rgba(255,210,63,.6);}',
      '.st-combo.on{opacity:1;}',
      '.st-combo.bump{animation:st-bump .3s ease;}',
      '@keyframes st-bump{0%{transform:scale(.7)}55%{transform:scale(1.25)}100%{transform:scale(1)}}',
      /* Spielfeld (überschreibt das Zentrieren von .game-stage) */
      '.st-stage{position:relative;display:block;overflow:hidden;padding:0;cursor:pointer;',
      'height:min(62vh,600px);min-height:320px;width:100%;border-radius:var(--radius);',
      'touch-action:none;user-select:none;-webkit-user-select:none;-webkit-touch-callout:none;-webkit-tap-highlight-color:transparent;',
      'background:radial-gradient(120% 100% at 50% 100%,#0c3020,#04120b);}',
      '.st-canvas{display:block;width:100%;height:100%;}',
      '.st-hint{text-align:center;}',
      /* Floats & Flashes */
      '.st-float{position:absolute;transform:translate(-50%,-50%);pointer-events:none;z-index:5;font-weight:900;',
      'font-size:20px;color:var(--leaf);text-shadow:0 2px 6px rgba(0,0,0,.7);animation:st-float .76s ease-out forwards;}',
      '.st-float-perf{color:var(--gold);font-size:26px;text-shadow:0 0 10px rgba(255,210,63,.85),0 2px 6px rgba(0,0,0,.7);}',
      '@keyframes st-float{0%{opacity:0;transform:translate(-50%,-50%) scale(.6)}20%{opacity:1;transform:translate(-50%,-80%) scale(1.1)}100%{opacity:0;transform:translate(-50%,-160%) scale(1)}}',
      '.st-perfect{position:absolute;left:50%;top:22%;transform:translate(-50%,-50%);pointer-events:none;z-index:6;',
      'font-weight:900;font-size:clamp(26px,8vw,44px);letter-spacing:2px;color:var(--gold);',
      'text-shadow:0 0 16px rgba(255,210,63,.9),0 2px 8px rgba(0,0,0,.6);animation:st-perf .65s ease-out forwards;}',
      '@keyframes st-perf{0%{opacity:0;transform:translate(-50%,-50%) scale(.5)}25%{opacity:1;transform:translate(-50%,-50%) scale(1.15)}70%{opacity:1}100%{opacity:0;transform:translate(-50%,-90%) scale(1)}}',
      '.st-crash{position:absolute;left:50%;top:45%;transform:translate(-50%,-50%);pointer-events:none;z-index:6;',
      'font-weight:900;font-size:clamp(28px,9vw,52px);letter-spacing:3px;color:var(--danger);',
      'text-shadow:0 0 18px rgba(255,77,109,.9),0 2px 8px rgba(0,0,0,.6);animation:st-crash 1s ease-out forwards;}',
      '@keyframes st-crash{0%{opacity:0;transform:translate(-50%,-50%) scale(.5) rotate(-6deg)}20%{opacity:1;transform:translate(-50%,-50%) scale(1.1) rotate(3deg)}45%{transform:translate(-50%,-50%) scale(1) rotate(-2deg)}100%{opacity:0;transform:translate(-50%,-40%) scale(1) rotate(0)}}',
      /* Board */
      '.st-board-wrap{padding:14px;display:flex;flex-direction:column;gap:8px;max-height:260px;overflow-y:auto;}'
    ].join(''));
  }
})();
