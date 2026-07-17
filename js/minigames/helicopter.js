/* helicopter.js — "Höhlen-Flug": Helicopter-Game im Neon-Dschungel.
 *
 * IDEE:      Ein Hubschrauber fliegt automatisch nach rechts durch eine
 *            leuchtende Tropfstein-Höhle. Gedrückt halten = steigen, loslassen =
 *            sinken (Schwerkraft). Die Höhle verengt sich, dazwischen schweben
 *            Kristall-Blöcke. Nicht an Decke, Boden oder Block anstoßen.
 * STEUERUNG: Maus/Finger auf der Fläche HALTEN · Leertaste/Pfeil-hoch/W · oder
 *            der große "HALTEN"-Knopf darunter (Touch-freundlich). Halten steigt,
 *            Loslassen sinkt.
 * PUNKTE:    Zurückgelegte Strecke = Punkte (Meter). Es wird mit der Distanz
 *            immer schneller. SOLO: ein Aufprall = Game Over (best_helicopter).
 * SYNC:      Die Höhle ist eine reine Funktion von Welt-x + Seed → für alle
 *            identisch. MULTI: Seed = round.startAt (aus Snapshot), alle starten
 *            per Countdown gleichzeitig, fliegen 2 Minuten dieselbe Höhle, melden
 *            ihre WEITESTE Strecke per reportScore → Live-Rangliste + Podest.
 *            Nach einem Crash respawnt man im Multi am letzten Checkpoint und
 *            fliegt weiter, bis die Zeit aus ist. Weltmaße sind auflösungs-
 *            unabhängig (Welt-Einheiten horizontal, Bruchteile der Höhe vertikal),
 *            damit Handy und Desktop dieselbe Höhle/Schwierigkeit sehen.
 * Alle Timer laufen über Wall-Clock (Date.now / room.now) → Tab-Wechsel-sicher.
 * cleanup() stoppt rAF, Timer, Listener und meldet alle room.on(...) wieder ab. */
(function () {
  'use strict';
  window.App = window.App || {}; App.Minigames = App.Minigames || {};
  var UI = App.UI, el = UI.el, MG = App.MG;

  var TAU = Math.PI * 2;
  var DURATION = 120;              // s Rundenzeit im Multiplayer (2 Minuten)

  /* ---- Welt-Konstanten (auflösungsunabhängig) ---- */
  var VIEW_UNITS = 26;            // Welt-Einheiten quer über die Bildschirmbreite
  var HELI_FRAC = 0.30;          // Bildschirm-x des Hubschraubers (Anteil der Breite)
  var BLK_SPACING = 11;          // Welt-Einheiten zwischen möglichen Block-Slots
  var CP = 40;                   // Checkpoint-Abstand (Welt-Einheiten) für Multi-Respawn

  /* ---- Physik (vertikal in Bruchteilen der Spielhöhe pro Sekunde) ---- */
  var GRAV = 2.5;                // Sink-Beschleunigung (frac/s^2)
  var THRUST = 3.9;             // Steig-Beschleunigung beim Halten (frac/s^2)
  var VMAX = 1.15;             // maximale Vertikalgeschwindigkeit (frac/s)
  var SPEED_BASE = 8.5;        // Grund-Vortrieb (Welt-Einheiten/s)

  /* ---- Hubschrauber-Trefferbox ---- */
  var BODY_W = 0.9;            // halbe Breite (Welt-Einheiten)
  var BODY_H = 0.05;          // halbe Höhe (Bruchteil der Spielhöhe)

  injectStyle();

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  /* gerundetes Rechteck als Pfad (auch für alte Browser ohne ctx.roundRect) */
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

  /* deterministischer 32-Bit-RNG (identisch auf allen Geräten mit gleichem Seed) */
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  App.Minigames.helicopter = {
    id: 'helicopter', title: 'Höhlen-Flug', icon: '🚁', order: 139,
    subtitle: 'Halten = steigen · flieg so weit du kannst',
    single: true, multi: true, minPlayers: 2, maxPlayers: 8,

    render: function (root, ctx) {
      var isMulti = ctx.mode === 'multi';
      var clock = isMulti ? ctx.room.now : Date.now;

      /* ---- Aufräum-Register: ALLES muss in cleanup() enden ---- */
      var stops = [], raf = null, destroyed = false;
      function addStop(fn) { if (fn) stops.push(fn); }
      function clearAll() {
        stops.forEach(function (f) { try { f(); } catch (e) {} });
        stops = [];
        if (raf) { cancelAnimationFrame(raf); raf = null; }
      }
      function cleanup() { destroyed = true; clearAll(); }

      /* ---- Start: Multi wartet auf synchronen Countdown, Solo legt sofort los ---- */
      if (isMulti) {
        var snap = ctx.room.snapshot() || {};
        var startAt = (snap.round && snap.round.startAt) || (ctx.room.now() + 3000);
        addStop(MG.countdown(root, startAt, function () { play(startAt); }, ctx.room.now));
      } else {
        play(Date.now());
      }
      return { cleanup: cleanup };

      /* ============================ RUNDE ============================ */
      function play(startAt) {
        clearAll();                       // evtl. Countdown-Timer stoppen

        /* ---- Seed → Höhle (im Multi für alle gleich) ---- */
        var seed = isMulti ? (startAt >>> 0) : ((Math.random() * 0xffffffff) >>> 0);
        var SEED = seed >>> 0;
        var prng = mulberry32(SEED);
        var ph1 = prng() * TAU, ph2 = prng() * TAU, ph3 = prng() * TAU;

        /* deterministischer Wert je Block-Slot [0,1) */
        function frnd(n) {
          var t = (Math.imul(n, 1103515245) + SEED + 1013904223) >>> 0;
          t ^= t >>> 15; t = Math.imul(t, 2654435761) >>> 0; t ^= t >>> 13;
          return (t >>> 0) / 4294967296;
        }

        /* Decke/Boden/Mitte/Spalt an einer Welt-x-Position (Bruchteile der Höhe) */
        function terrain(x) {
          var e = clamp((x + 6) / 46, 0, 1);   // Einflug ist offen und ruhig
          var raw = 0.5 + 0.15 * Math.sin(x * 0.85 + ph1)
                        + 0.10 * Math.sin(x * 0.37 + ph2)
                        + 0.055 * Math.sin(x * 1.7 + ph3);
          var center = 0.5 + (raw - 0.5) * e;
          var g = 0.62 - clamp(x / 1250, 0, 1) * 0.40;   // verengt sich mit der Distanz
          g = g + (1 - e) * 0.28;                        // am Anfang weiter
          if (g < 0.23) g = 0.23; if (g > 0.92) g = 0.92;
          var ceil = center - g / 2, floor = center + g / 2;
          if (ceil < 0.03) { ceil = 0.03; floor = ceil + g; }
          if (floor > 0.97) { floor = 0.97; ceil = floor - g; }
          if (ceil < 0.02) ceil = 0.02;
          return { c: center, g: g, ceil: ceil, floor: floor };
        }

        /* schwebender Kristall-Block an Slot k (oder null) — rein aus Seed */
        function blockAt(k) {
          var bx = k * BLK_SPACING;
          if (bx < 40) return null;                       // Ruhe zum Start
          var prob = 0.30 + clamp(bx / 2600, 0, 1) * 0.42;
          if (frnd(k * 4) > prob) return null;
          var t = terrain(bx);
          var usable = t.floor - t.ceil;
          if (usable < 0.30) return null;                 // zu eng für einen Block
          var h = Math.min(usable * 0.34, 0.16);
          var pf = 0.14 + frnd(k * 4 + 1) * 0.72;
          var top = t.ceil + pf * (usable - h);
          var halfW = 0.85 + frnd(k * 4 + 2) * 0.7;
          return { bx: bx, halfW: halfW, top: top, h: h, kind: frnd(k * 4 + 3) };
        }

        /* ---- Laufzeit-Zustand ---- */
        var endAt = startAt + DURATION * 1000;
        var W = 0, H = 0, TOPM = 4, BOTM = 4, playH = 0;
        var dist = 0, maxDist = 0, heliY = 0.5, vy = 0;
        var held = false, phase = 'fly';       // 'fly' | 'dead'
        var deadUntil = 0, invulnUntil = startAt + 650, shake = 0;
        var finished = false, lastT = clock(), lastReport = 0;
        var recordUnits = 0, recordHit = false; // Solo: eigene Bestmarke
        var parts = [], sparks = [], spores = [];
        var flashRecordT = 0;

        if (!isMulti) {
          recordUnits = App.Storage.get('best_helicopter', 0) / 10;
        }

        /* Leucht-Sporen im Hintergrund (rein visuell, dürfen zufällig sein) */
        for (var si = 0; si < 15; si++) {
          spores.push({ x: Math.random(), y: 0.05 + Math.random() * 0.9,
            r: 1 + Math.random() * 2.4, ph: Math.random() * TAU,
            bw: 0.8 + Math.random() * 2.2, aqua: Math.random() < 0.5,
            drift: (Math.random() * 0.02 + 0.008) });
        }

        /* ---- DOM: HUD + Bühne + Halten-Knopf + (Multi) Rangliste + Hinweis ---- */
        var distEl = el('div', { class: 'hel-dist big-readout' }, ['0']);
        var rightLabel = isMulti ? 'Zeit' : 'Rekord';
        var rightEl = el('div', { class: isMulti ? 'mg-timer hel-timer' : 'hel-best' },
          [isMulti ? MG.mmss(DURATION) : MG.fmt(App.Storage.get('best_helicopter', 0)) + ' m']);
        var hud = el('div', { class: 'hel-hud glass' }, [
          el('div', { class: 'hel-hud-cell' }, [el('span', { class: 'hel-hud-l' }, ['Strecke']),
            el('div', { class: 'hel-distrow' }, [distEl, el('span', { class: 'hel-unit' }, ['m'])])]),
          el('div', { class: 'hel-hud-cell hel-hud-right' }, [el('span', { class: 'hel-hud-l' }, [rightLabel]), rightEl])
        ]);

        var canvas = el('canvas', { class: 'hel-canvas' });
        var stage = el('div', { class: 'hel-stage', tabindex: '0', 'aria-label': 'Höhle – halten zum Steigen' }, [canvas]);
        var cvx = canvas.getContext('2d');

        var holdBtn = el('button', { class: 'hel-holdbtn', type: 'button', 'aria-label': 'Halten zum Steigen' }, [
          el('span', { class: 'hel-hold-ico' }, ['🚁']),
          el('span', {}, ['HALTEN zum STEIGEN'])
        ]);
        var controls = el('div', { class: 'hel-controls' }, [holdBtn]);

        var pieces = [hud, stage, controls];
        var board = null;
        if (isMulti) {
          board = MG.liveBoard(ctx.room, ctx.me.id);
          addStop(board.stop);
          pieces.push(el('div', { class: 'glass hel-board-wrap' }, [
            el('div', { class: 'mg-field-title' }, ['🏆 Weiteste Strecke']),
            board.root
          ]));
        }
        pieces.push(el('div', { class: 'hint-text hel-hint' }, [
          '🚁 Halten (Fläche · Knopf · Leertaste) = steigen, loslassen = sinken. Nicht anstoßen – je weiter, desto schneller!'
        ]));

        var wrap = el('div', { class: 'hel-wrap' }, pieces);
        root.innerHTML = ''; root.appendChild(wrap);

        if (isMulti) ctx.room.reportScore(0);

        /* ---- Canvas-Größe (DPR-scharf), Resize-sicher ---- */
        function resize() {
          var rect = stage.getBoundingClientRect();
          var cssW = Math.max(1, Math.round(rect.width));
          var cssH = Math.max(1, Math.round(rect.height));
          var dpr = Math.min(window.devicePixelRatio || 1, 2);
          canvas.width = Math.round(cssW * dpr);
          canvas.height = Math.round(cssH * dpr);
          canvas.style.width = cssW + 'px';
          canvas.style.height = cssH + 'px';
          cvx.setTransform(dpr, 0, 0, dpr, 0, 0);
          cvx.imageSmoothingEnabled = true;
          W = cssW; H = cssH;
          playH = H - TOPM - BOTM;
        }
        resize();
        if (typeof ResizeObserver !== 'undefined') {
          var ro = new ResizeObserver(function () { resize(); });
          ro.observe(stage);
          addStop(function () { ro.disconnect(); });
        } else {
          var onWinResize = function () { resize(); };
          window.addEventListener('resize', onWinResize);
          addStop(function () { window.removeEventListener('resize', onWinResize); });
        }

        /* ---- Eingabe: HALTEN per Pointer (Maus/Touch) + Tastatur + Knopf ---- */
        function press(e) {
          if (e && e.preventDefault) e.preventDefault();
          if (destroyed || finished) return;
          held = true;   // während 'dead' ignoriert die Physik held – nach Respawn steigt man dann sofort weiter
        }
        function release() { held = false; }
        stage.addEventListener('pointerdown', press);
        holdBtn.addEventListener('pointerdown', press);
        addStop(function () { stage.removeEventListener('pointerdown', press); });
        addStop(function () { holdBtn.removeEventListener('pointerdown', press); });
        window.addEventListener('pointerup', release);
        window.addEventListener('pointercancel', release);
        window.addEventListener('blur', release);
        addStop(function () { window.removeEventListener('pointerup', release); });
        addStop(function () { window.removeEventListener('pointercancel', release); });
        addStop(function () { window.removeEventListener('blur', release); });

        function onKeyDown(e) {
          if (e.code === 'Space' || e.key === ' ' || e.code === 'ArrowUp' || e.key === 'ArrowUp' || e.code === 'KeyW') {
            e.preventDefault(); press(e);
          }
        }
        function onKeyUp(e) {
          if (e.code === 'Space' || e.key === ' ' || e.code === 'ArrowUp' || e.key === 'ArrowUp' || e.code === 'KeyW') {
            release();
          }
        }
        document.addEventListener('keydown', onKeyDown);
        document.addEventListener('keyup', onKeyUp);
        addStop(function () { document.removeEventListener('keydown', onKeyDown); });
        addStop(function () { document.removeEventListener('keyup', onKeyUp); });

        /* ---- Meter-Anzeige ---- */
        function metersOf(u) { return Math.floor(u * 10); }
        function bumpDist() {
          distEl.textContent = MG.fmt(metersOf(dist));
          distEl.classList.remove('hel-bump'); void distEl.offsetWidth; distEl.classList.add('hel-bump');
        }

        /* ---- Vortrieb (Welt-Einheiten/s), wächst mit der Distanz ---- */
        function speedAt(x) {
          return SPEED_BASE * (1 + Math.min(x / 1300, 1) * 0.7 + Math.min(x / 3200, 1) * 0.5);
        }

        /* ---- Kollision am Hubschrauber ---- */
        function hitTest(now) {
          if (now < invulnUntil) return null;
          var xs0 = terrain(dist - BODY_W * 0.6), xs1 = terrain(dist), xs2 = terrain(dist + BODY_W * 0.6);
          if (heliY - BODY_H < xs0.ceil || heliY - BODY_H < xs1.ceil || heliY - BODY_H < xs2.ceil) return 'ceil';
          if (heliY + BODY_H > xs0.floor || heliY + BODY_H > xs1.floor || heliY + BODY_H > xs2.floor) return 'floor';
          var k0 = Math.floor((dist - BODY_W - BLK_SPACING) / BLK_SPACING);
          var k1 = Math.ceil((dist + BODY_W + BLK_SPACING) / BLK_SPACING);
          for (var k = k0; k <= k1; k++) {
            var b = blockAt(k);
            if (!b) continue;
            if (dist + BODY_W > b.bx - b.halfW && dist - BODY_W < b.bx + b.halfW) {
              if (heliY + BODY_H > b.top && heliY - BODY_H < b.top + b.h) return 'block';
            }
          }
          return null;
        }

        function spawnExplosion() {
          var heliPx = W * HELI_FRAC, cy = TOPM + heliY * playH;
          var cols = ['#39ff14', '#33e6d0', '#ffd23f', '#7dff5a', '#ff4d6d'];
          for (var i = 0; i < 20; i++) {
            var a = Math.random() * TAU, sp = (60 + Math.random() * 260);
            parts.push({ x: heliPx, y: cy, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 60,
              rot: Math.random() * TAU, vr: Math.random() * 10 - 5,
              s: 3 + Math.random() * 5, life: 0.5 + Math.random() * 0.6, col: cols[i % cols.length] });
          }
        }

        function crash(now) {
          if (phase !== 'fly') return;
          phase = 'dead';
          shake = Math.max(shake, 16);
          spawnExplosion();
          if (App.Audio) App.Audio.sfx('explosion');
          if (isMulti) {
            deadUntil = now + 1100;
          } else {
            var to = setTimeout(function () { if (!destroyed) finish(); }, 1050);
            stops.push(function () { clearTimeout(to); });
          }
        }

        function respawn(now) {
          var cp = Math.floor(dist / CP) * CP; if (cp < 0) cp = 0;
          dist = cp;
          var t = terrain(dist);
          heliY = t.c; vy = 0;   // held bleibt so, wie der Finger/die Taste es gerade meldet
          phase = 'fly';
          invulnUntil = now + 750;
          sparks.push({ x: W * HELI_FRAC, t0: now });
          if (App.Audio) App.Audio.sfx('powerup');
        }

        /* ---- Physik / Logik ---- */
        function update(dt, now) {
          // Sporen driften (nur Optik)
          for (var s = 0; s < spores.length; s++) {
            spores[s].x = (spores[s].x + spores[s].drift * dt) % 1;
          }
          // Partikel (Explosion) immer weiterrechnen
          for (var i = parts.length - 1; i >= 0; i--) {
            var p = parts[i]; p.life -= dt;
            if (p.life <= 0) { parts.splice(i, 1); continue; }
            p.vy += 520 * dt; p.x += p.vx * dt; p.y += p.vy * dt; p.rot += p.vr * dt;
          }

          if (phase === 'dead') {
            if (isMulti && now >= deadUntil) respawn(now);
            return;
          }

          // Steuerung: Halten = hoch, sonst Schwerkraft
          var acc = held ? -THRUST : GRAV;
          vy += acc * dt;
          if (vy > VMAX) vy = VMAX; if (vy < -VMAX) vy = -VMAX;
          heliY += vy * dt;

          var prevDist = dist;
          dist += speedAt(dist) * dt;

          if (dist > maxDist) {
            maxDist = dist;
            if (isMulti && now - lastReport >= 200) { lastReport = now; ctx.room.reportScore(metersOf(maxDist)); }
          }

          // Solo-Bestmarke geknackt?
          if (!isMulti && !recordHit && recordUnits > 0 && prevDist < recordUnits && dist >= recordUnits) {
            recordHit = true; flashRecordT = now;
            if (App.Audio) App.Audio.sfx('levelup');
          }

          if (Math.floor(metersOf(prevDist) / 100) !== Math.floor(metersOf(dist) / 100)) {
            if (App.Audio) App.Audio.blip(760, 0.05, { type: 'triangle', peak: 0.045 });
          }

          var hit = hitTest(now);
          if (hit) crash(now);

          distEl.textContent = MG.fmt(metersOf(dist));
        }

        /* ============================ ZEICHNEN ============================ */
        function fracPy(f) { return TOPM + f * playH; }

        function drawBg(now) {
          var g = cvx.createLinearGradient(0, 0, 0, H);
          g.addColorStop(0, '#05140c'); g.addColorStop(0.5, '#081f13'); g.addColorStop(1, '#03100a');
          cvx.fillStyle = g; cvx.fillRect(0, 0, W, H);
          var rg = cvx.createRadialGradient(W * 0.5, H * 0.4, 0, W * 0.5, H * 0.4, H * 0.75);
          rg.addColorStop(0, 'rgba(57,255,20,0.08)'); rg.addColorStop(1, 'rgba(57,255,20,0)');
          cvx.fillStyle = rg; cvx.fillRect(0, 0, W, H);
          // Leucht-Sporen
          var t = now * 0.001;
          for (var i = 0; i < spores.length; i++) {
            var sp = spores[i];
            var fx = sp.x * W;
            var fy = (sp.y + Math.sin(t * sp.bw + sp.ph) * 0.02) * H;
            var a = 0.15 + 0.4 * (0.5 + 0.5 * Math.sin(t * sp.bw + sp.ph));
            cvx.save(); cvx.globalAlpha = a;
            cvx.fillStyle = sp.aqua ? '#7ffbe9' : '#b6ff7a';
            cvx.shadowColor = sp.aqua ? 'rgba(51,230,208,.9)' : 'rgba(57,255,20,.9)'; cvx.shadowBlur = 9;
            cvx.beginPath(); cvx.arc(fx, fy, sp.r, 0, TAU); cvx.fill(); cvx.restore();
          }
        }

        // liefert Welt-x für eine Bildschirmspalte
        function worldOf(sx) { return dist - HELI_FRAC * VIEW_UNITS + (sx / W) * VIEW_UNITS; }

        function drawCave() {
          var step = 8, cols = [], flrs = [];
          for (var sx = 0; sx <= W + step; sx += step) {
            var t = terrain(worldOf(sx));
            cols.push({ x: sx, y: fracPy(t.ceil) });
            flrs.push({ x: sx, y: fracPy(t.floor) });
          }
          // Decke (Fels von oben)
          var cg = cvx.createLinearGradient(0, 0, 0, H);
          cg.addColorStop(0, '#0a2e17'); cg.addColorStop(1, '#134a24');
          cvx.beginPath(); cvx.moveTo(0, 0);
          for (var i = 0; i < cols.length; i++) cvx.lineTo(cols[i].x, cols[i].y);
          cvx.lineTo(W, 0); cvx.closePath(); cvx.fillStyle = cg; cvx.fill();
          neonEdge(cols);
          // Boden (Fels von unten)
          var fg = cvx.createLinearGradient(0, 0, 0, H);
          fg.addColorStop(0, '#134a24'); fg.addColorStop(1, '#0a2e17');
          cvx.beginPath(); cvx.moveTo(0, H);
          for (var j = 0; j < flrs.length; j++) cvx.lineTo(flrs[j].x, flrs[j].y);
          cvx.lineTo(W, H); cvx.closePath(); cvx.fillStyle = fg; cvx.fill();
          neonEdge(flrs);
        }

        function neonEdge(pts) {
          cvx.save();
          cvx.shadowColor = 'rgba(57,255,20,.75)'; cvx.shadowBlur = 12;
          cvx.strokeStyle = 'rgba(126,255,120,.9)'; cvx.lineWidth = 2.4;
          cvx.beginPath();
          for (var i = 0; i < pts.length; i++) { if (i === 0) cvx.moveTo(pts[i].x, pts[i].y); else cvx.lineTo(pts[i].x, pts[i].y); }
          cvx.stroke(); cvx.restore();
        }

        function drawBlocks() {
          var pxU = W / VIEW_UNITS;
          var leftW = dist - HELI_FRAC * VIEW_UNITS;
          var k0 = Math.floor((leftW - 2) / BLK_SPACING);
          var k1 = Math.ceil((leftW + VIEW_UNITS + 2) / BLK_SPACING);
          for (var k = k0; k <= k1; k++) {
            var b = blockAt(k);
            if (!b) continue;
            var bxpx = (b.bx - leftW) * pxU;
            var bwpx = b.halfW * 2 * pxU;
            var bypx = fracPy(b.top);
            var bhpx = b.h * playH;
            drawCrystal(bxpx - bwpx / 2, bypx, bwpx, bhpx, b.kind);
          }
        }

        function drawCrystal(x, y, w, h, kind) {
          cvx.save();
          var g = cvx.createLinearGradient(x, y, x, y + h);
          if (kind < 0.5) { g.addColorStop(0, '#2fd6c0'); g.addColorStop(1, '#0d5f56'); }
          else { g.addColorStop(0, '#7dff5a'); g.addColorStop(1, '#1f7d2c'); }
          cvx.fillStyle = g;
          cvx.shadowColor = kind < 0.5 ? 'rgba(51,230,208,.7)' : 'rgba(57,255,20,.7)'; cvx.shadowBlur = 14;
          // kantige Kristall-Facette
          var mx = x + w / 2, r = Math.min(w, h) * 0.22;
          cvx.beginPath();
          cvx.moveTo(mx, y);
          cvx.lineTo(x + w, y + h * 0.32);
          cvx.lineTo(x + w - r * 0.4, y + h);
          cvx.lineTo(x + r * 0.4, y + h);
          cvx.lineTo(x, y + h * 0.32);
          cvx.closePath(); cvx.fill();
          cvx.shadowBlur = 0;
          cvx.strokeStyle = 'rgba(234,255,224,.55)'; cvx.lineWidth = 1.6; cvx.stroke();
          // Glanzkante
          cvx.strokeStyle = 'rgba(255,255,255,.35)'; cvx.lineWidth = 1;
          cvx.beginPath(); cvx.moveTo(mx, y); cvx.lineTo(x + r * 0.4, y + h); cvx.stroke();
          cvx.restore();
        }

        function drawRecordMark() {
          if (isMulti || recordUnits <= 0 || recordHit) return;
          var pxU = W / VIEW_UNITS;
          var leftW = dist - HELI_FRAC * VIEW_UNITS;
          if (recordUnits < leftW || recordUnits > leftW + VIEW_UNITS) return;
          var mx = (recordUnits - leftW) * pxU;
          cvx.save();
          cvx.strokeStyle = 'rgba(255,210,63,.85)'; cvx.lineWidth = 3;
          cvx.shadowColor = 'rgba(255,210,63,.8)'; cvx.shadowBlur = 12;
          cvx.setLineDash([10, 10]);
          cvx.beginPath(); cvx.moveTo(mx, 0); cvx.lineTo(mx, H); cvx.stroke();
          cvx.setLineDash([]);
          cvx.fillStyle = '#ffe27a'; cvx.font = '900 ' + Math.round(clamp(H * 0.035, 12, 20)) + 'px system-ui,sans-serif';
          cvx.textAlign = 'center';
          cvx.fillText('REKORD', mx, clamp(H * 0.06, 14, 30));
          cvx.restore();
        }

        function drawHeli(now) {
          var cx = W * HELI_FRAC, cy = fracPy(heliY);
          var base = Math.min((W / VIEW_UNITS) * 1.5, playH * 0.12);
          var tilt = clamp(vy / VMAX, -1, 1) * 0.34;
          cvx.save();
          cvx.translate(cx, cy);
          // Aura
          var aur = cvx.createRadialGradient(0, 0, base * 0.3, 0, 0, base * 2.1);
          aur.addColorStop(0, 'rgba(57,255,20,0.28)'); aur.addColorStop(0.6, 'rgba(57,255,20,0.09)'); aur.addColorStop(1, 'rgba(57,255,20,0)');
          cvx.fillStyle = aur; cvx.beginPath(); cvx.arc(0, 0, base * 2.1, 0, TAU); cvx.fill();
          // Schub-Flamme beim Halten
          if (held && phase === 'fly') {
            var fl = base * (1.0 + 0.4 * Math.sin(now * 0.05));
            var fg = cvx.createLinearGradient(0, base * 0.4, 0, base * 0.4 + fl);
            fg.addColorStop(0, 'rgba(255,210,63,.9)'); fg.addColorStop(0.5, 'rgba(255,120,40,.7)'); fg.addColorStop(1, 'rgba(255,60,40,0)');
            cvx.fillStyle = fg;
            cvx.beginPath();
            cvx.moveTo(-base * 0.32, base * 0.42); cvx.lineTo(base * 0.32, base * 0.42);
            cvx.lineTo(0, base * 0.42 + fl); cvx.closePath(); cvx.fill();
          }
          cvx.rotate(tilt);
          // Heck-Ausleger
          cvx.strokeStyle = '#1f9e2e'; cvx.lineWidth = base * 0.16; cvx.lineCap = 'round';
          cvx.beginPath(); cvx.moveTo(-base * 0.3, -base * 0.1); cvx.lineTo(-base * 1.35, -base * 0.28); cvx.stroke();
          // Heck-Finne
          cvx.fillStyle = '#2fbf3a';
          cvx.beginPath(); cvx.moveTo(-base * 1.3, -base * 0.28); cvx.lineTo(-base * 1.5, -base * 0.55); cvx.lineTo(-base * 1.2, -base * 0.42); cvx.closePath(); cvx.fill();
          // Heckrotor (dreht)
          var trs = Math.abs(Math.sin(now * 0.05));
          cvx.strokeStyle = 'rgba(234,255,224,.75)'; cvx.lineWidth = base * 0.05;
          cvx.beginPath(); cvx.moveTo(-base * 1.45, -base * 0.42 - base * 0.28 * trs); cvx.lineTo(-base * 1.45, -base * 0.42 + base * 0.28 * trs); cvx.stroke();
          // Rumpf
          var bg = cvx.createLinearGradient(0, -base * 0.6, 0, base * 0.6);
          bg.addColorStop(0, '#8dff5f'); bg.addColorStop(1, '#1f9e2e');
          cvx.fillStyle = bg;
          cvx.beginPath(); cvx.ellipse(0, 0, base * 0.85, base * 0.55, 0, 0, TAU); cvx.fill();
          cvx.lineWidth = base * 0.05; cvx.strokeStyle = 'rgba(57,255,20,.5)'; cvx.stroke();
          // Cockpit-Glas (vorne)
          cvx.fillStyle = 'rgba(127,243,230,.85)';
          cvx.beginPath(); cvx.ellipse(base * 0.4, -base * 0.02, base * 0.35, base * 0.34, 0, 0, TAU); cvx.fill();
          cvx.fillStyle = 'rgba(255,255,255,.5)';
          cvx.beginPath(); cvx.arc(base * 0.5, -base * 0.14, base * 0.09, 0, TAU); cvx.fill();
          // Kufen
          cvx.strokeStyle = '#0d5f56'; cvx.lineWidth = base * 0.07;
          cvx.beginPath(); cvx.moveTo(-base * 0.55, base * 0.6); cvx.lineTo(base * 0.6, base * 0.6); cvx.stroke();
          cvx.beginPath(); cvx.moveTo(-base * 0.3, base * 0.5); cvx.lineTo(-base * 0.35, base * 0.6); cvx.stroke();
          cvx.beginPath(); cvx.moveTo(base * 0.3, base * 0.5); cvx.lineTo(base * 0.35, base * 0.6); cvx.stroke();
          // Rotor-Mast
          cvx.strokeStyle = '#0d5f56'; cvx.lineWidth = base * 0.08;
          cvx.beginPath(); cvx.moveTo(0, -base * 0.5); cvx.lineTo(0, -base * 0.7); cvx.stroke();
          // Hauptrotor (dreht, als schmale Ellipse)
          var span = base * 1.55 * Math.abs(Math.cos(now * 0.045)) + base * 0.12;
          cvx.save();
          cvx.shadowColor = 'rgba(51,230,208,.6)'; cvx.shadowBlur = 8;
          cvx.fillStyle = 'rgba(234,255,224,.85)';
          cvx.beginPath(); cvx.ellipse(0, -base * 0.72, span, base * 0.07, 0, 0, TAU); cvx.fill();
          cvx.restore();
          cvx.restore();
        }

        function drawParts() {
          for (var i = 0; i < parts.length; i++) {
            var p = parts[i];
            cvx.save(); cvx.globalAlpha = clamp(p.life / 0.6, 0, 1);
            cvx.translate(p.x, p.y); cvx.rotate(p.rot);
            cvx.fillStyle = p.col; cvx.shadowColor = p.col; cvx.shadowBlur = 8;
            rr(cvx, -p.s, -p.s * 0.5, p.s * 2, p.s, p.s * 0.4); cvx.fill();
            cvx.restore();
          }
        }

        function drawRespawnFx(now) {
          for (var i = sparks.length - 1; i >= 0; i--) {
            var s = sparks[i], age = now - s.t0;
            if (age > 500) { sparks.splice(i, 1); continue; }
            var a = 1 - age / 500, rad = 8 + age * 0.12;
            cvx.save(); cvx.globalAlpha = a;
            cvx.strokeStyle = '#7ff3e6'; cvx.lineWidth = 3; cvx.shadowColor = 'rgba(51,230,208,.8)'; cvx.shadowBlur = 10;
            cvx.beginPath(); cvx.arc(s.x, fracPy(heliY), rad, 0, TAU); cvx.stroke(); cvx.restore();
          }
        }

        function centerText(big, small, col) {
          cvx.save(); cvx.textAlign = 'center';
          cvx.shadowColor = col || 'rgba(57,255,20,.7)'; cvx.shadowBlur = 18;
          var bigPx = Math.round(clamp(H * 0.07, 22, 44));
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

        function draw(now) {
          cvx.clearRect(0, 0, W, H);
          var sx = (Math.random() * 2 - 1) * shake, sy = (Math.random() * 2 - 1) * shake;
          cvx.save(); cvx.translate(sx, sy);
          drawBg(now);
          drawCave();
          drawBlocks();
          drawRecordMark();
          drawParts();
          if (phase === 'fly') { drawHeli(now); drawRespawnFx(now); }
          cvx.restore();

          if (phase === 'dead') {
            var a = isMulti ? clamp((deadUntil - now) / 1100, 0, 1) * 0.4 : 0.35;
            cvx.fillStyle = 'rgba(255,40,70,' + a.toFixed(3) + ')'; cvx.fillRect(0, 0, W, H);
            centerText('BUMM!', isMulti ? 'Neustart am Checkpoint …' : 'Aufgeprallt', 'rgba(255,77,109,.8)');
          }
          if (!isMulti && recordHit && now - flashRecordT < 900) {
            var ra = 1 - (now - flashRecordT) / 900;
            cvx.save(); cvx.globalAlpha = ra; centerText('REKORD GEKNACKT! 🏆', '', 'rgba(255,210,63,.8)'); cvx.restore();
          }
          shake *= 0.86; if (shake < 0.4) shake = 0;
        }

        /* ---- Haupt-Loop: rAF mit geclamptem Zeit-Delta (Tab-sicher) ---- */
        function frame() {
          if (destroyed || finished) { raf = null; return; }
          var now = clock();
          var dt = (now - lastT) / 1000; lastT = now;
          if (dt < 0) dt = 0;
          if (dt > 0.05) dt = 0.05;              // kein Riesensprung nach Tab-Wechsel
          if (isMulti && now >= endAt) { finish(); return; }
          update(dt, now);
          draw(now);
          raf = requestAnimationFrame(frame);
        }
        raf = requestAnimationFrame(frame);

        /* ---- Runden-Timer (nur Multi, Wall-Clock, synchron) ---- */
        if (isMulti) {
          addStop(MG.roundTimer(endAt, function (left) {
            rightEl.textContent = MG.mmss(Math.ceil(left));
            if (left <= 5.5) rightEl.classList.add('hel-urgent');
          }, finish, ctx.room.now));
        }

        /* ---- Ende ---- */
        function finish() {
          if (finished || destroyed) return;
          finished = true;
          held = false;
          clearAll();                            // rAF, Timer, Board, Listener, Resize
          if (isMulti) {
            ctx.room.reportScore(metersOf(maxDist));
            var to = setTimeout(function () {
              if (destroyed) return;
              MG.endScreen(root, { players: ctx.room.players(), meId: ctx.me.id, onExit: ctx.onExit });
            }, 1100);
            stops.push(function () { clearTimeout(to); });
          } else {
            var m = metersOf(maxDist);
            var best = App.Storage.get('best_helicopter', 0), nb = m > best;
            if (nb) App.Storage.set('best_helicopter', m);
            MG.endScreen(root, {
              title: '🚁 Aufgeprallt!',
              score: m, best: best, newBest: nb,
              label: nb ? 'Neuer Rekord! 🎉' : ('Strecke · Bestwert: ' + MG.fmt(best) + ' m'),
              onExit: ctx.onExit,
              onAgain: function () { finished = false; play(Date.now()); }
            });
          }
        }
      }
    }
  };

  /* ============================ STYLES ============================ */
  function injectStyle() {
    UI.injectStyle('mg-helicopter-css', [
      '.hel-wrap{display:flex;flex-direction:column;gap:12px;}',
      /* HUD */
      '.hel-hud{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px 18px;}',
      '.hel-hud-cell{display:flex;flex-direction:column;gap:2px;min-width:0;}',
      '.hel-hud-right{align-items:flex-end;text-align:right;}',
      '.hel-hud-l{font-size:11px;text-transform:uppercase;letter-spacing:1px;color:var(--muted);}',
      '.hel-distrow{display:flex;align-items:baseline;gap:5px;}',
      '.hel-dist{font-size:clamp(26px,7vw,42px);line-height:1;color:var(--neon);text-shadow:0 0 14px rgba(57,255,20,.5);font-variant-numeric:tabular-nums;}',
      '.hel-dist.hel-bump{animation:hel-bump .26s ease;}',
      '@keyframes hel-bump{0%{transform:scale(1)}45%{transform:scale(1.22)}100%{transform:scale(1)}}',
      '.hel-unit{font-size:clamp(13px,3vw,18px);font-weight:800;color:var(--leaf);}',
      '.hel-best{font-size:clamp(18px,4.6vw,26px);font-weight:900;color:var(--gold);text-shadow:0 0 12px rgba(255,210,63,.4);font-variant-numeric:tabular-nums;}',
      '.hel-timer{font-size:clamp(20px,5vw,28px);font-variant-numeric:tabular-nums;}',
      '.hel-timer.hel-urgent{color:var(--danger);animation:hel-pulse .6s ease-in-out infinite;}',
      '@keyframes hel-pulse{0%,100%{opacity:1}50%{opacity:.45}}',
      /* Bühne (Canvas) */
      '.hel-stage{position:relative;width:100%;height:min(52vh,480px);min-height:260px;',
      'border-radius:16px;overflow:hidden;cursor:pointer;',
      'touch-action:none;user-select:none;-webkit-user-select:none;-webkit-tap-highlight-color:transparent;-webkit-touch-callout:none;',
      'background:#04140c;box-shadow:inset 0 0 46px rgba(0,0,0,.55),0 0 0 1px var(--stroke);outline:none;}',
      '.hel-stage:focus-visible{box-shadow:inset 0 0 46px rgba(0,0,0,.55),0 0 0 2px var(--neon);}',
      '.hel-canvas{display:block;width:100%;height:100%;}',
      /* Halten-Knopf */
      '.hel-controls{display:flex;justify-content:center;}',
      '.hel-holdbtn{display:flex;align-items:center;justify-content:center;gap:10px;width:100%;max-width:520px;',
      'padding:16px 20px;font-size:clamp(15px,4vw,19px);font-weight:900;letter-spacing:1px;font-family:inherit;',
      'color:#04160c;background:linear-gradient(180deg,var(--neon-soft),var(--neon));border:1px solid var(--neon);',
      'border-radius:16px;box-shadow:0 0 20px rgba(57,255,20,.4);cursor:pointer;',
      'touch-action:none;user-select:none;-webkit-user-select:none;-webkit-tap-highlight-color:transparent;transition:transform .08s,box-shadow .12s;}',
      '.hel-holdbtn:active{transform:scale(.97);box-shadow:0 0 34px rgba(57,255,20,.7),inset 0 0 22px rgba(255,255,255,.3);}',
      '.hel-hold-ico{font-size:22px;filter:drop-shadow(0 0 6px rgba(0,0,0,.3));}',
      /* Rangliste + Hinweis */
      '.hel-board-wrap{padding:14px;display:flex;flex-direction:column;gap:8px;max-height:240px;overflow-y:auto;}',
      '.hel-hint{text-align:center;font-size:13px;line-height:1.4;}'
    ].join(''));
  }
})();
