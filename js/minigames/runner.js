/* runner.js — "Dschungel-Flucht": 3-Spuren-Endlosläufer im Neon-Dschungel.
 * Subway-Surfers-Abwandlung, aber vielfältiger und mit ZWEI Wertungen.
 * Die Figur rennt automatisch nach vorn (leicht schräge 2.5D-Ansicht), das
 * Tempo steigt über die Runde. Steuerung: Spur links/rechts, SPRINGEN (über
 * niedrige Hindernisse), RUTSCHEN/DUCKEN (unter hohe Hindernisse).
 *   Desktop: Pfeiltasten + WASD (hoch=Sprung, runter=Rutsch, links/rechts=Spur).
 *   Handy: Wisch-Gesten (links/rechts/hoch/runter) + On-Screen-Pfeile.
 * Hindernis-Vielfalt: 🪵 Baumstamm (springen), 🌿 Ranken-Balken (rutschen),
 *   🗿 Statue (Spur wechseln), 🕳️ Loch (springen), 🪨 rollender Stein (Spur).
 * Abwechselnde Biome (Tempel/Fluss/Höhle) mit eigener Farbstimmung.
 * Power-ups: 🧲 Magnet, 🛡️ Schild (übersteht 1 Crash), ✨ x2, 🚀 Boost.
 * Sprungschanzen geben einen Luft-Trick = Geschicklichkeits-Bonus.
 * ZWEI WERTUNGEN: 1) GESCHICKLICHKEIT (Distanz + knappe Dodges + Tricks) =
 * Haupt-Score; 2) MÜNZEN 🪙 (getrennt gezählt). Am Ende zwei Sieger:
 * 🏆 Bester Läufer + 🪙 Münz-König.
 * Zeitrennen mit Respawn (wie flappy.js): 90 s Rundenzeit. Crash -> kurze
 * Stolper-Pause (~1 s, Combo-Verlust), dann Respawn, weiter bis Zeit aus.
 * Schild verhindert 1 Crash. Kein Sofort-Ende. Physik-Loop über rAF mit
 * geclamptem Zeit-Delta (Date.now / room.now) -> Tab-Wechsel-sicher. Timer
 * über App.MG. Multiplayer: Live-Rangliste nach Geschicklichkeit, Coins via
 * reportState, eigener Doppel-Podest-Endscreen. Singleplayer: getrennte
 * Bestwerte 'best_runner_skill' + 'best_runner_coins'. */
(function () {
  'use strict';
  window.App = window.App || {}; App.Minigames = App.Minigames || {};
  var UI = App.UI, el = UI.el, MG = App.MG;

  var DURATION = 90;                 // Sekunden Rundenzeit
  var TAU = Math.PI * 2;
  var LANES = 3;

  injectStyle();

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  /* gerundetes Rechteck (für Browser ohne ctx.roundRect) */
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

  /* ---- Biome (Farbstimmung, wechseln über die Distanz) ---- */
  var BIOMES = [
    { name: 'Tempel', sky: ['#06180e', '#0c2a19', '#04120a'], glow: 'rgba(57,255,20,0.12)', ground: ['#123f1e', '#04150a'], accent: '#7dff5a', side: '#0e3417' },
    { name: 'Fluss',  sky: ['#04141c', '#0a2733', '#03101a'], glow: 'rgba(51,230,208,0.14)', ground: ['#0d3a44', '#04141c'], accent: '#5ff0e0', side: '#0e3440' },
    { name: 'Höhle',  sky: ['#12060e', '#241019', '#0a040a'], glow: 'rgba(255,77,109,0.10)', ground: ['#2a1226', '#0a040a'], accent: '#ff7ab0', side: '#341026' }
  ];

  /* ---- Hindernis-Typen ---- */
  // action: 'jump' | 'slide' | 'lane' (lane = ausweichen indem man die Spur wechselt)
  var OBST = {
    log:    { emoji: '🪵', action: 'jump',  h: 0.30, label: 'Baumstamm' },
    hole:   { emoji: '🕳️', action: 'jump',  h: 0.02, label: 'Loch' },
    vine:   { emoji: '🌿', action: 'slide', h: 0.95, label: 'Ranke' },
    statue: { emoji: '🗿', action: 'lane',  h: 0.90, label: 'Statue' },
    rock:   { emoji: '🪨', action: 'lane',  h: 0.55, label: 'Stein' }
  };
  var OBST_KEYS = ['log', 'hole', 'vine', 'statue', 'rock'];

  /* ---- Power-ups ---- */
  var POWER = {
    magnet: { emoji: '🧲', dur: 6000, label: 'Magnet' },
    shield: { emoji: '🛡️', dur: 0,    label: 'Schild' },
    x2:     { emoji: '✨', dur: 6000, label: 'Doppelt' },
    boost:  { emoji: '🚀', dur: 3500, label: 'Boost' }
  };

  App.Minigames.runner = {
    id: 'runner', title: 'Dschungel-Flucht', icon: '🏃', order: 26,
    subtitle: 'Renn, weiche aus, sammle Coins – geschickteste UND reichste gewinnen',
    single: true, multi: true, minPlayers: 2, maxPlayers: 8,

    render: function (root, ctx) {
      var isMulti = ctx.mode === 'multi';
      var clock = isMulti ? ctx.room.now : Date.now;

      /* ---- Aufräum-Register ---- */
      var stops = [], raf = null, destroyed = false;
      function addStop(fn) { if (fn) stops.push(fn); }
      function clearAll() {
        stops.forEach(function (f) { try { f(); } catch (e) {} });
        stops = [];
        if (raf) { cancelAnimationFrame(raf); raf = null; }
      }
      function cleanup() { destroyed = true; clearAll(); }

      /* ---- Start ---- */
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
        clearAll();

        var endAt = startAt + DURATION * 1000;
        var W = 0, H = 0;
        var finished = false, lastT = clock();

        /* ---- Spielzustand ---- */
        var lane = 1;                    // 0..2
        var laneX = 1;                   // interpolierte Spur (für weiche Bewegung)
        var jump = 0;                    // 0..1 (Sprunghöhe-Faktor)
        var jumpVel = 0;                 // vertikale Geschwindigkeit (Sprung)
        var airborne = false;
        var slide = 0;                   // Rutsch-Rest in ms
        var trickSpin = 0;               // Luft-Trick-Rotation (rad), aus Schanzen
        var phase = 'run';               // 'run' | 'stumble'
        var stumbleUntil = 0;
        var worldZ = 0;                  // zurückgelegte Distanz (Welt-Einheiten)
        var shake = 0;
        var runFrame = 0;                // Bein-Animation

        var skill = 0;                   // GESCHICKLICHKEIT (Haupt-Score)
        var coins = 0;                   // MÜNZEN (getrennt)
        var combo = 0;                   // Dodge-Combo
        var comboUntil = 0;

        var magnetUntil = 0, x2Until = 0, boostUntil = 0, shield = false;

        var obstacles = [];              // {z, lane, type, scored, near}
        var pickups = [];                // {z, lane, kind:'coin'|powerkey}
        var ramps = [];                  // {z, lane}
        var pops = [];                   // schwebende Texte {x,y,t0,txt,col}
        var sparks = [];                 // Partikel
        var fireflies = [];
        var nextSpawnZ = 6;              // nächste Spawn-Distanz

        var lastReportSkill = -1, lastReportCoins = -1, lastReport = 0;

        for (var i = 0; i < 18; i++) {
          fireflies.push({ x: Math.random(), y: Math.random(), ph: Math.random() * TAU, bw: 0.6 + Math.random() * 1.8, r: 1 + Math.random() * 2.4, aqua: Math.random() < 0.5 });
        }

        /* ---- DOM: HUD + Bühne + Steuer-Pfeile ---- */
        var skillEl = el('div', { class: 'rn-val rn-skill big-readout' }, ['0']);
        var coinEl = el('div', { class: 'rn-val rn-coin' }, ['0']);
        var timerEl = el('div', { class: 'mg-timer rn-timer' }, [MG.mmss(DURATION)]);
        var comboEl = el('div', { class: 'rn-combo' }, ['']);
        var hud = el('div', { class: 'rn-hud glass' }, [
          el('div', { class: 'rn-hud-cell' }, [el('span', { class: 'rn-hud-l' }, ['🏆 Geschick']), skillEl]),
          el('div', { class: 'rn-hud-cell' }, [el('span', { class: 'rn-hud-l' }, ['🪙 Münzen']), coinEl]),
          el('div', { class: 'rn-hud-cell rn-hud-right' }, [el('span', { class: 'rn-hud-l' }, ['Zeit']), timerEl])
        ]);

        var canvas = el('canvas', { class: 'rn-canvas' });
        var biomeTag = el('div', { class: 'rn-biome' }, ['🏛️ Tempel']);
        var powBar = el('div', { class: 'rn-powbar' });
        var mkBtn = function (dir, glyph) {
          return el('button', { class: 'rn-arrow rn-arrow-' + dir, type: 'button', 'aria-label': dir,
            onpointerdown: function (e) { e.preventDefault(); if (e.stopPropagation) e.stopPropagation(); doAction(dir); } }, [glyph]);
        };
        var pad = el('div', { class: 'rn-pad' }, [
          mkBtn('up', '⬆'),
          el('div', { class: 'rn-pad-mid' }, [mkBtn('left', '⬅'), mkBtn('down', '⬇'), mkBtn('right', '➡')])
        ]);
        var stage = el('div', { class: 'rn-stage', tabindex: '0', 'aria-label': 'Spielfeld – wischen zum Steuern' }, [canvas, biomeTag, comboEl, powBar, pad]);
        var cvx = canvas.getContext('2d');

        var pieces = [hud, stage];
        var board = null;
        if (isMulti) {
          board = MG.liveBoard(ctx.room, ctx.me.id);
          addStop(board.stop);
          pieces.push(el('div', { class: 'glass rn-board-wrap' }, [
            el('div', { class: 'mg-field-title' }, ['🏆 Geschicklichkeit']),
            board.root
          ]));
        }
        pieces.push(el('div', { class: 'hint-text rn-hint' }, [
          '⬅➡ Spur · ⬆ Springen · ⬇ Rutschen  ·  Handy: wischen. Crash? Kurz stolpern, dann weiter – Punkte bleiben!'
        ]));

        var layout = el('div', { class: 'rn-wrap' }, pieces);
        root.innerHTML = ''; root.appendChild(layout);

        if (isMulti) { ctx.room.reportScore(0); ctx.room.reportState({ coins: 0 }); }

        /* ---- Canvas-Größe (DPR-scharf) ---- */
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

        /* ---- Eingabe: Tastatur ---- */
        function onKey(e) {
          if (e.repeat) return;
          var k = e.key, c = e.code;
          if (c === 'ArrowLeft' || k === 'ArrowLeft' || c === 'KeyA') { e.preventDefault(); doAction('left'); }
          else if (c === 'ArrowRight' || k === 'ArrowRight' || c === 'KeyD') { e.preventDefault(); doAction('right'); }
          else if (c === 'ArrowUp' || k === 'ArrowUp' || c === 'KeyW' || c === 'Space' || k === ' ') { e.preventDefault(); doAction('up'); }
          else if (c === 'ArrowDown' || k === 'ArrowDown' || c === 'KeyS') { e.preventDefault(); doAction('down'); }
        }
        document.addEventListener('keydown', onKey);
        addStop(function () { document.removeEventListener('keydown', onKey); });

        /* ---- Eingabe: Wisch-Gesten (Pointer) ---- */
        var swStart = null;
        function onPD(e) {
          swStart = { x: e.clientX, y: e.clientY, t: clock() };
          if (e.target === canvas && e.preventDefault) e.preventDefault();
        }
        function onPU(e) {
          if (!swStart) return;
          var dx = e.clientX - swStart.x, dy = e.clientY - swStart.y;
          var adx = Math.abs(dx), ady = Math.abs(dy), dt = clock() - swStart.t;
          swStart = null;
          if (adx < 24 && ady < 24) return;          // Tap -> ignorieren (Buttons übernehmen)
          if (dt > 800) return;
          if (adx > ady) doAction(dx > 0 ? 'right' : 'left');
          else doAction(dy > 0 ? 'down' : 'up');
        }
        stage.addEventListener('pointerdown', onPD);
        stage.addEventListener('pointerup', onPU);
        stage.addEventListener('pointercancel', function () { swStart = null; });
        addStop(function () {
          stage.removeEventListener('pointerdown', onPD);
          stage.removeEventListener('pointerup', onPU);
        });

        /* ---- Aktionen ---- */
        function doAction(dir) {
          if (destroyed || finished) return;
          try { stage.focus({ preventScroll: true }); } catch (e) {}
          if (phase === 'stumble') return;
          if (dir === 'left') { if (lane > 0) { lane--; if (App.Audio) App.Audio.sfx('whoosh'); } }
          else if (dir === 'right') { if (lane < LANES - 1) { lane++; if (App.Audio) App.Audio.sfx('whoosh'); } }
          else if (dir === 'up') {
            if (!airborne) { airborne = true; jumpVel = 2.2; slide = 0; if (App.Audio) App.Audio.sfx('whoosh'); }
          } else if (dir === 'down') {
            if (airborne) { jumpVel = Math.min(jumpVel, -1.4); }   // Sturzflug -> schneller runter
            else { slide = 650; if (App.Audio) App.Audio.sfx('whoosh'); }
          }
        }

        /* ---- Geometrie: 3D-artige Projektion einer schrägen Bahn ----
           z = Distanz vor der Figur (0 = an der Figur, größer = weiter weg).
           Wir projizieren mit einfacher Perspektive. */
        function proj(z, laneIdx, lift) {
          // Perspektive: kleiner Faktor s in der Ferne
          var s = 1 / (1 + z * 0.14);
          var horizon = H * 0.26;
          var baseY = horizon + (H - horizon) * s;           // Boden-Y bei dieser Distanz
          var roadHalf = (W * 0.16 + (W * 0.34) * s);        // halbe Straßenbreite an dieser Distanz
          var cx = W * 0.5;
          var laneOff = (laneIdx - 1) * roadHalf * 0.62;
          var x = cx + laneOff;
          var y = baseY - (lift || 0) * (H * 0.24) * s;
          return { x: x, y: y, s: s, roadHalf: roadHalf, baseY: baseY };
        }

        function biomeAt(z) {
          // wechselt etwa alle 60 Distanz-Einheiten
          var idx = Math.floor((worldZ + z) / 60) % BIOMES.length;
          return BIOMES[idx];
        }
        function currentBiomeIndex() { return Math.floor(worldZ / 60) % BIOMES.length; }

        /* ---- Spawner ---- */
        function speedNow(now) {
          var elapsed = clamp((now - startAt) / (DURATION * 1000), 0, 1);
          var base = 9 + elapsed * 9;                        // Distanz-Einheiten/s
          if (now < boostUntil) base *= 1.7;
          return base;
        }
        function densityGap(now) {
          var elapsed = clamp((now - startAt) / (DURATION * 1000), 0, 1);
          return 8.5 - elapsed * 3.2;                        // Abstand schrumpft -> dichter
        }

        function spawnWave(now) {
          var gap = densityGap(now);
          nextSpawnZ = worldZ + 26;                          // vorne am Horizont einsetzen
          // Was kommt? gelegentlich Schanze, meistens Hindernis, oft Coins.
          var roll = Math.random();
          if (roll < 0.12) {
            ramps.push({ z: nextSpawnZ, lane: Math.floor(Math.random() * LANES) });
          } else {
            // 1-2 Hindernisse, IMMER mind. eine Spur frei lassen (fair)
            var freeLane = Math.floor(Math.random() * LANES);
            var openLanes = [];
            for (var l = 0; l < LANES; l++) if (l !== freeLane) openLanes.push(l);
            var count = Math.random() < 0.5 ? 1 : 2;         // max = LANES-1
            for (var oc = 0; oc < count && openLanes.length; oc++) {
              var li = openLanes.splice(Math.floor(Math.random() * openLanes.length), 1)[0];
              var type = OBST_KEYS[Math.floor(Math.random() * OBST_KEYS.length)];
              obstacles.push({ z: nextSpawnZ, lane: li, type: type, scored: false, dodged: false, resolved: false });
            }
          }
          // Coins: Reihe auf einer Spur
          if (Math.random() < 0.8) {
            var cl = Math.floor(Math.random() * LANES);
            var n = 3 + Math.floor(Math.random() * 4);
            for (var ci = 0; ci < n; ci++) pickups.push({ z: nextSpawnZ + 2 + ci * 1.6, lane: cl, kind: 'coin' });
          }
          // Power-up selten
          if (Math.random() < 0.14) {
            var keys = Object.keys(POWER);
            var pk = keys[Math.floor(Math.random() * keys.length)];
            pickups.push({ z: nextSpawnZ + 4, lane: Math.floor(Math.random() * LANES), kind: pk });
          }
        }

        /* ---- Wertung ---- */
        function addSkill(v) { skill += v; }
        function bumpEl(node) { if (!node) return; node.classList.remove('rn-bump'); void node.offsetWidth; node.classList.add('rn-bump'); }
        function floatText(txt, laneIdx, col) {
          var p = proj(1.4, laneIdx, jump);
          pops.push({ x: p.x, y: p.y - H * 0.10, t0: clock(), txt: txt, col: col || '#7dff5a' });
        }
        function addCombo(now, laneIdx) {
          combo++; comboUntil = now + 2200;
          var bonus = 4 + combo * 2;
          addSkill(bonus);
          if (comboEl) { comboEl.textContent = combo >= 2 ? ('Combo x' + combo + '  +' + bonus) : ''; comboEl.classList.toggle('rn-combo-on', combo >= 2); }
          floatText('+' + bonus, laneIdx, '#33e6d0');
        }

        function grabCoin(pk, now) {
          var val = now < x2Until ? 2 : 1;
          coins += val;
          if (coinEl) { coinEl.textContent = String(coins); bumpEl(coinEl); }
          if (App.Audio) App.Audio.sfx('coin');
          for (var s = 0; s < 5; s++) {
            var a = Math.random() * TAU, sp = 40 + Math.random() * 120;
            sparks.push({ x: pk._px || W / 2, y: pk._py || H / 2, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 40, life: 0.5, col: '#ffd23f' });
          }
        }
        function grabPower(kind, now, laneIdx) {
          var def = POWER[kind];
          if (kind === 'shield') { shield = true; }
          else if (kind === 'magnet') magnetUntil = now + def.dur;
          else if (kind === 'x2') x2Until = now + def.dur;
          else if (kind === 'boost') { boostUntil = now + def.dur; addSkill(10); }
          floatText(def.emoji + ' ' + def.label, laneIdx, '#39ff14');
          if (UI.toast) UI.toast(def.emoji + ' ' + def.label + '!', 'info');
        }

        function crash(now, laneIdx) {
          if (shield) {
            shield = false;
            if (App.Audio) App.Audio.sfx('pop');
            floatText('🛡️ Schild!', laneIdx, '#ffd23f');
            shake = Math.max(shake, 8);
            for (var s = 0; s < 10; s++) { var a = Math.random() * TAU, sp = 60 + Math.random() * 140; sparks.push({ x: W / 2, y: H * 0.68, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 0.5, col: '#ffd23f' }); }
            return false;
          }
          if (App.Audio) App.Audio.sfx('hit');
          phase = 'stumble'; stumbleUntil = now + 1000; shake = Math.max(shake, 16);
          combo = 0; comboUntil = 0; if (comboEl) { comboEl.textContent = ''; comboEl.classList.remove('rn-combo-on'); }
          airborne = false; jump = 0; jumpVel = 0; slide = 0; trickSpin = 0;
          for (var i = 0; i < 16; i++) {
            var an = Math.random() * TAU, spd = 60 + Math.random() * 220;
            sparks.push({ x: W / 2, y: H * 0.70, vx: Math.cos(an) * spd, vy: Math.sin(an) * spd - 120, life: 0.6 + Math.random() * 0.4, col: ['#39ff14', '#33e6d0', '#ff4d6d', '#ffd23f'][i % 4] });
          }
          floatText('Autsch!', laneIdx, '#ff4d6d');
          return true;
        }

        /* ---- Physik / Logik ---- */
        function update(dt, now) {
          var sp = speedNow(now);

          // Spur weich interpolieren
          laneX += (lane - laneX) * Math.min(1, dt * 12);

          // Partikel
          for (var i = sparks.length - 1; i >= 0; i--) {
            var s = sparks[i]; s.life -= dt; if (s.life <= 0) { sparks.splice(i, 1); continue; }
            s.vy += 320 * dt; s.x += s.vx * dt; s.y += s.vy * dt;
          }

          if (phase === 'stumble') {
            // langsam weiterrollen, dann Respawn
            worldZ += sp * 0.25 * dt;
            if (now >= stumbleUntil) { phase = 'run'; }
            // Objekte hinter uns weiter durchlaufen lassen
            obstacles = obstacles.filter(function (ob) { return ob.z - worldZ > -3; });
            pickups = pickups.filter(function (pp) { return pp.z - worldZ > -3; });
            ramps = ramps.filter(function (rp) { return rp.z - worldZ > -3; });
            runFrame += dt * 4;
            return;
          }

          /* laufen */
          runFrame += dt * (8 + sp * 0.3);
          worldZ += sp * dt;

          // Geschicklichkeit steigt mit Distanz (Haupt-Score)
          addSkill(sp * dt * 1.0);

          // Sprung-Physik
          if (airborne) {
            jump += jumpVel * dt * 2.2;
            jumpVel -= 4.0 * dt * 2.2;
            if (trickSpin > 0) trickSpin += dt * 9;
            if (jump <= 0) { jump = 0; airborne = false; jumpVel = 0; if (trickSpin > 0) { addSkill(14); floatText('Trick! +14', lane, '#39ff14'); if (App.Audio) App.Audio.sfx('ding'); trickSpin = 0; } }
          }
          // Rutschen abklingen
          if (slide > 0) slide -= dt * 1000;
          if (slide < 0) slide = 0;

          // Combo-Verfall
          if (combo > 0 && now > comboUntil) { combo = 0; if (comboEl) { comboEl.textContent = ''; comboEl.classList.remove('rn-combo-on'); } }

          // Spawnen: neue Welle, sobald das entfernteste Hindernis/die Schanze
          // näher als (26 - Abstand) herangerückt ist -> gleichmäßiger, mit der
          // Zeit dichterer Nachschub. (Schanzen zählen mit, Coins nicht.)
          var farZ = worldZ, any = false;
          for (var fo = 0; fo < obstacles.length; fo++) { any = true; if (obstacles[fo].z > farZ) farZ = obstacles[fo].z; }
          for (var fr = 0; fr < ramps.length; fr++) { any = true; if (ramps[fr].z > farZ) farZ = ramps[fr].z; }
          if (!any) farZ = worldZ;                       // Bahn leer -> sofort auffüllen
          var guard = 0;
          while (farZ - worldZ < 26 - densityGap(now) && guard++ < 4) {
            spawnWave(now);                              // legt bei worldZ+26 ab
            farZ = nextSpawnZ;
          }

          // Magnet: Coins zur Figur-Spur ziehen
          var magnet = now < magnetUntil;
          for (var p = 0; p < pickups.length; p++) {
            var pk = pickups[p];
            if (pk.kind === 'coin' && magnet && (pk.z - worldZ) < 10 && (pk.z - worldZ) > -1) {
              pk.lane += (lane - pk.lane) * Math.min(1, dt * 6);
            }
          }

          // Kollision / Sammeln (Figur bei z≈0.6, Spur = lane)
          var myZ = 0.6;
          // Hindernisse: ERST Crash prüfen, DANN Dodge werten (nie beides)
          for (var oi = obstacles.length - 1; oi >= 0; oi--) {
            var ob = obstacles[oi];
            var rel = ob.z - worldZ;
            var def = OBST[ob.type];
            var inMyLane = Math.abs(ob.lane - laneX) < 0.55;
            // Gefahren-Fenster: in unserer Spur -> springen/rutschen oder Spur räumen.
            // Einmal sauber ausgewichen (dodged) bleibt es sicher, auch wenn man landet.
            if (!ob.resolved && !ob.dodged && rel < myZ + 0.45 && rel > myZ - 0.55 && inMyLane) {
              var safe = def.action === 'jump' ? (airborne && jump > 0.26)
                       : def.action === 'slide' ? (slide > 0)
                       : false;                         // 'lane': nur Spurwechsel rettet
              if (safe) { ob.dodged = true; }           // sauber drüber/drunter
              else { ob.resolved = true; if (crash(now, lane)) { obstacles.splice(oi, 1); continue; } }
            }
            // Vorbei: werten (nur wenn nicht gecrasht)
            if (!ob.scored && rel < myZ - 0.3) {
              ob.scored = true;
              if (!ob.resolved) {
                if (ob.dodged) addCombo(now, lane);      // aktiver Sprung/Rutsch -> Combo
                else addSkill(2);                         // gefahrlos passiert (andere Spur)
              }
            }
            if (rel < -3) obstacles.splice(oi, 1);
          }
          // Schanzen
          for (var ri = ramps.length - 1; ri >= 0; ri--) {
            var rp = ramps[ri];
            var rrel = rp.z - worldZ;
            if (rrel < myZ + 0.3 && rrel > myZ - 0.5 && Math.abs(rp.lane - laneX) < 0.55) {
              if (!airborne) { airborne = true; jumpVel = 2.6; trickSpin = 0.01; }
              ramps.splice(ri, 1); continue;
            }
            if (rrel < -3) ramps.splice(ri, 1);
          }
          // Pickups
          for (var pi = pickups.length - 1; pi >= 0; pi--) {
            var pk2 = pickups[pi];
            var prel = pk2.z - worldZ;
            if (prel < myZ + 0.4 && prel > myZ - 0.6 && Math.abs(pk2.lane - lane) < 0.6) {
              // Coin auch beim Springen einsammeln (leicht großzügig)
              if (pk2.kind === 'coin') { grabCoin(pk2, now); }
              else grabPower(pk2.kind, now, lane);
              pickups.splice(pi, 1); continue;
            }
            if (prel < -3) pickups.splice(pi, 1);
          }

          // Power-Leiste aktualisieren
          updatePowBar(now);
          // Live-Werte melden (throttled)
          maybeReport(now);
        }

        function maybeReport(now) {
          if (!isMulti) return;
          if (now - lastReport < 350) return;
          lastReport = now;
          var sInt = Math.round(skill);
          if (sInt !== lastReportSkill) { ctx.room.reportScore(sInt); lastReportSkill = sInt; }
          if (coins !== lastReportCoins) { ctx.room.reportState({ coins: coins }); lastReportCoins = coins; }
        }

        function updatePowBar(now) {
          if (!powBar) return;
          var items = [];
          if (shield) items.push('🛡️');
          if (now < magnetUntil) items.push('🧲' + Math.ceil((magnetUntil - now) / 1000));
          if (now < x2Until) items.push('✨' + Math.ceil((x2Until - now) / 1000));
          if (now < boostUntil) items.push('🚀' + Math.ceil((boostUntil - now) / 1000));
          powBar.textContent = items.join('  ');
          powBar.classList.toggle('rn-powbar-on', items.length > 0);
        }

        /* ============================ ZEICHNEN ============================ */
        function drawBg(now, biome) {
          var g = cvx.createLinearGradient(0, 0, 0, H);
          g.addColorStop(0, biome.sky[0]); g.addColorStop(0.5, biome.sky[1]); g.addColorStop(1, biome.sky[2]);
          cvx.fillStyle = g; cvx.fillRect(0, 0, W, H);

          var rg = cvx.createRadialGradient(W * 0.5, H * 0.16, 0, W * 0.5, H * 0.16, H * 0.7);
          rg.addColorStop(0, biome.glow); rg.addColorStop(1, 'rgba(0,0,0,0)');
          cvx.fillStyle = rg; cvx.fillRect(0, 0, W, H);

          // Leuchtkäfer im oberen Bereich
          var t = now * 0.001;
          for (var i = 0; i < fireflies.length; i++) {
            var f = fireflies[i];
            var fx = ((((f.x + t * 0.02) % 1) + 1) % 1) * W;
            var fy = (0.04 + f.y * 0.22) * H + Math.sin(t * f.bw + f.ph) * 6;
            var a = 0.15 + 0.45 * (0.5 + 0.5 * Math.sin(t * f.bw + f.ph));
            cvx.save(); cvx.globalAlpha = a;
            cvx.fillStyle = f.aqua ? '#7ffbe9' : '#b6ff7a';
            cvx.shadowColor = f.aqua ? 'rgba(51,230,208,.9)' : 'rgba(57,255,20,.9)'; cvx.shadowBlur = 8;
            cvx.beginPath(); cvx.arc(fx, fy, f.r, 0, TAU); cvx.fill(); cvx.restore();
          }
        }

        function drawRoad(now, biome) {
          // Straße als Trapez (nah = breit, fern = schmal)
          var near = proj(0, 0, 0), far = proj(20, 0, 0);
          var cx = W * 0.5;
          var nHalf = near.roadHalf, fHalf = far.roadHalf;
          var g = cvx.createLinearGradient(0, far.baseY, 0, near.baseY);
          g.addColorStop(0, biome.ground[1]); g.addColorStop(1, biome.ground[0]);
          cvx.fillStyle = g;
          cvx.beginPath();
          cvx.moveTo(cx - fHalf, far.baseY);
          cvx.lineTo(cx + fHalf, far.baseY);
          cvx.lineTo(cx + nHalf, near.baseY);
          cvx.lineTo(cx - nHalf, near.baseY);
          cvx.closePath(); cvx.fill();

          // Seitenränder (glühend)
          cvx.strokeStyle = biome.accent; cvx.lineWidth = 3; cvx.shadowColor = biome.accent; cvx.shadowBlur = 12;
          cvx.beginPath(); cvx.moveTo(cx - fHalf, far.baseY); cvx.lineTo(cx - nHalf, near.baseY); cvx.stroke();
          cvx.beginPath(); cvx.moveTo(cx + fHalf, far.baseY); cvx.lineTo(cx + nHalf, near.baseY); cvx.stroke();
          cvx.shadowBlur = 0;

          // Spurlinien
          cvx.strokeStyle = 'rgba(200,255,200,.16)'; cvx.lineWidth = 2;
          for (var L = 1; L < LANES; L++) {
            var frac = L / LANES;
            var nx = (cx - nHalf) + (nHalf * 2) * frac;
            var fx = (cx - fHalf) + (fHalf * 2) * frac;
            cvx.beginPath(); cvx.moveTo(fx, far.baseY); cvx.lineTo(nx, near.baseY); cvx.stroke();
          }
          // Quer-Streifen (Tiefen-Gefühl, mit worldZ scrollend)
          cvx.strokeStyle = 'rgba(255,255,255,.05)'; cvx.lineWidth = 2;
          for (var z = 0; z < 20; z++) {
            var frac2 = ((z + (worldZ % 1)) );
            var pz = proj(frac2, 0, 0);
            if (pz.baseY < far.baseY || pz.baseY > near.baseY) continue;
            var half = pz.roadHalf;
            cvx.globalAlpha = clamp(pz.s * 1.4, 0, 0.5);
            cvx.beginPath(); cvx.moveTo(cx - half, pz.baseY); cvx.lineTo(cx + half, pz.baseY); cvx.stroke();
          }
          cvx.globalAlpha = 1;
        }

        function drawEmojiAt(z, laneIdx, lift, emoji, size, spin) {
          var p = proj(z, laneIdx, lift);
          var px = Math.round(clamp(H * 0.09 * size * p.s * 3.2, 12, H * 0.16));
          cvx.save();
          cvx.globalAlpha = clamp(p.s * 2.2, 0.15, 1);
          cvx.translate(p.x, p.y);
          if (spin) cvx.rotate(spin);
          cvx.font = px + 'px system-ui,sans-serif';
          cvx.textAlign = 'center'; cvx.textBaseline = 'alphabetic';
          cvx.fillText(emoji, 0, 0);
          cvx.restore();
          return { x: p.x, y: p.y, s: p.s };
        }

        function drawScene(now) {
          // Alle Bahn-Objekte nach Distanz sortiert (fern zuerst)
          var items = [];
          for (var i = 0; i < obstacles.length; i++) { var ob = obstacles[i]; items.push({ z: ob.z - worldZ, o: ob, kind: 'obst' }); }
          for (var j = 0; j < ramps.length; j++) { var rp = ramps[j]; items.push({ z: rp.z - worldZ, o: rp, kind: 'ramp' }); }
          for (var k = 0; k < pickups.length; k++) { var pk = pickups[k]; items.push({ z: pk.z - worldZ, o: pk, kind: 'pick' }); }
          items.sort(function (a, b) { return b.z - a.z; });

          for (var m = 0; m < items.length; m++) {
            var it = items[m];
            if (it.z < -2 || it.z > 22) continue;
            if (it.kind === 'obst') {
              var def = OBST[it.o.type];
              var lift = def.action === 'slide' ? 0.6 : 0;   // hohe Hindernisse schweben (drunter durch)
              drawEmojiAt(it.z, it.o.lane, lift, def.emoji, def.action === 'lane' ? 1.25 : 1.0, 0);
            } else if (it.kind === 'ramp') {
              drawEmojiAt(it.z, it.o.lane, 0, '🛫', 1.1, 0);
            } else {
              var pos;
              if (it.o.kind === 'coin') {
                var bob = Math.sin(now * 0.006 + it.o.z) * 0.05;
                pos = drawEmojiAt(it.z, it.o.lane, 0.35 + bob, '🪙', 0.8, 0);
              } else {
                pos = drawEmojiAt(it.z, it.o.lane, 0.45, POWER[it.o.kind].emoji, 1.0, 0);
              }
              it.o._px = pos.x; it.o._py = pos.y;
            }
          }
        }

        function drawRunner(now, biome) {
          var lift = jump;
          var p = proj(0.6, laneX, lift);
          var sc = clamp(p.s * 3.0, 0.6, 1.6);
          var bounce = phase === 'stumble' ? 0 : Math.abs(Math.sin(runFrame)) * 6 * (airborne ? 0 : 1);
          var sliding = slide > 0 && !airborne;
          cvx.save();
          cvx.translate(p.x, p.y - bounce);
          if (trickSpin > 0) cvx.rotate(Math.sin(trickSpin) * 0.9);

          // Schatten
          cvx.save();
          cvx.globalAlpha = clamp(0.4 - lift * 0.3, 0.06, 0.4);
          cvx.fillStyle = '#000';
          cvx.beginPath(); cvx.ellipse(0, 4 + lift * 40, 26 * sc, 8 * sc, 0, 0, TAU); cvx.fill();
          cvx.restore();

          cvx.scale(sc, sc);
          if (sliding) { cvx.rotate(0.9); cvx.scale(1, 0.8); }

          var wob = Math.sin(runFrame) * (airborne ? 0 : 1);
          // Aura
          var aur = cvx.createRadialGradient(0, -14, 4, 0, -14, 42);
          aur.addColorStop(0, 'rgba(57,255,20,0.28)'); aur.addColorStop(1, 'rgba(57,255,20,0)');
          cvx.fillStyle = aur; cvx.beginPath(); cvx.arc(0, -14, 42, 0, TAU); cvx.fill();

          // Beine (rennend)
          cvx.strokeStyle = '#1f9e2e'; cvx.lineWidth = 6; cvx.lineCap = 'round';
          cvx.beginPath(); cvx.moveTo(-3, -6); cvx.lineTo(-6 + wob * 6, 8); cvx.stroke();
          cvx.beginPath(); cvx.moveTo(3, -6); cvx.lineTo(6 - wob * 6, 8); cvx.stroke();
          // Körper
          var bg = cvx.createLinearGradient(0, -30, 0, -4);
          bg.addColorStop(0, '#8dff5f'); bg.addColorStop(1, '#1f9e2e');
          cvx.fillStyle = bg; rr(cvx, -11, -30, 22, 26, 8); cvx.fill();
          cvx.lineWidth = 1.4; cvx.strokeStyle = 'rgba(57,255,20,.5)'; cvx.stroke();
          // Arme (pumpend)
          cvx.strokeStyle = '#2fbf3a'; cvx.lineWidth = 5;
          cvx.beginPath(); cvx.moveTo(-9, -24); cvx.lineTo(-14 - wob * 5, -12); cvx.stroke();
          cvx.beginPath(); cvx.moveTo(9, -24); cvx.lineTo(14 + wob * 5, -12); cvx.stroke();
          // Kopf
          var hg = cvx.createLinearGradient(0, -46, 0, -30);
          hg.addColorStop(0, '#a9ff8a'); hg.addColorStop(1, '#2fbf3a');
          cvx.fillStyle = hg; cvx.beginPath(); cvx.arc(0, -38, 11, 0, TAU); cvx.fill();
          // Federkamm
          cvx.fillStyle = biome.accent;
          cvx.beginPath(); cvx.moveTo(-2, -48); cvx.lineTo(-6, -56); cvx.lineTo(2, -49); cvx.closePath(); cvx.fill();
          cvx.beginPath(); cvx.moveTo(2, -49); cvx.lineTo(2, -58); cvx.lineTo(7, -48); cvx.closePath(); cvx.fill();
          // Auge
          cvx.fillStyle = '#eafff0'; cvx.beginPath(); cvx.arc(4, -40, 4, 0, TAU); cvx.fill();
          cvx.fillStyle = '#052012'; cvx.beginPath(); cvx.arc(5.4, -40, 2, 0, TAU); cvx.fill();
          // Schnabel
          cvx.fillStyle = '#ffd23f'; cvx.beginPath(); cvx.moveTo(10, -40); cvx.lineTo(17, -38); cvx.lineTo(10, -35); cvx.closePath(); cvx.fill();

          // Schild-Blase
          if (shield) {
            cvx.strokeStyle = 'rgba(255,210,63,.8)'; cvx.lineWidth = 2.5; cvx.shadowColor = 'rgba(255,210,63,.7)'; cvx.shadowBlur = 12;
            cvx.beginPath(); cvx.arc(0, -22, 30, 0, TAU); cvx.stroke(); cvx.shadowBlur = 0;
          }
          cvx.restore();
        }

        function drawPops(now) {
          pops = pops.filter(function (o) { return now - o.t0 < 800; });
          for (var i = 0; i < pops.length; i++) {
            var o = pops[i], age = now - o.t0, a = 1 - age / 800;
            cvx.save(); cvx.globalAlpha = a; cvx.textAlign = 'center';
            cvx.fillStyle = o.col; cvx.shadowColor = o.col; cvx.shadowBlur = 10;
            cvx.font = '900 ' + Math.round(clamp(H * 0.036, 14, 26)) + 'px system-ui,sans-serif';
            cvx.fillText(o.txt, o.x, o.y - age * 0.05);
            cvx.restore();
          }
        }

        function drawSparks() {
          for (var i = 0; i < sparks.length; i++) {
            var s = sparks[i];
            cvx.save(); cvx.globalAlpha = clamp(s.life / 0.5, 0, 1);
            cvx.fillStyle = s.col; cvx.shadowColor = s.col; cvx.shadowBlur = 8;
            cvx.beginPath(); cvx.arc(s.x, s.y, 3, 0, TAU); cvx.fill(); cvx.restore();
          }
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

        function draw(now) {
          var biome = BIOMES[currentBiomeIndex()];
          cvx.clearRect(0, 0, W, H);
          var sx = (Math.random() * 2 - 1) * shake, sy = (Math.random() * 2 - 1) * shake;
          cvx.save(); cvx.translate(sx, sy);
          drawBg(now, biome);
          drawRoad(now, biome);
          drawScene(now);
          drawRunner(now, biome);
          drawSparks();
          drawPops(now);
          cvx.restore();

          if (phase === 'stumble') {
            var a = clamp((stumbleUntil - now) / 1000, 0, 1) * 0.30;
            cvx.fillStyle = 'rgba(255,40,70,' + a.toFixed(3) + ')'; cvx.fillRect(0, 0, W, H);
            centerText('Gestolpert!', 'Weiter geht\'s …');
          }

          shake *= 0.85; if (shake < 0.4) shake = 0;
          if (skillEl) skillEl.textContent = String(Math.round(skill));

          // Biom-Tag aktualisieren
          if (biomeTag) {
            var icons = ['🏛️ Tempel', '🌊 Fluss', '🕳️ Höhle'];
            var want = icons[currentBiomeIndex()];
            if (biomeTag.textContent !== want) { biomeTag.textContent = want; biomeTag.classList.remove('rn-biome-flash'); void biomeTag.offsetWidth; biomeTag.classList.add('rn-biome-flash'); }
          }
        }

        /* ---- Haupt-Loop ---- */
        function frame() {
          if (destroyed || finished) { raf = null; return; }
          var now = clock();
          var dt = (now - lastT) / 1000; lastT = now;
          if (dt < 0) dt = 0;
          if (dt > 0.05) dt = 0.05;
          if (now >= endAt) { finish(); return; }
          update(dt, now);
          draw(now);
          raf = requestAnimationFrame(frame);
        }
        raf = requestAnimationFrame(frame);

        /* ---- Runden-Timer ---- */
        addStop(MG.roundTimer(endAt, function (left) {
          var secs = Math.ceil(left);
          timerEl.textContent = MG.mmss(secs);
          timerEl.classList.toggle('rn-urgent', left <= 10.5);
        }, finish, isMulti ? ctx.room.now : null));

        /* ---- Ende ---- */
        function finish() {
          if (finished || destroyed) return;
          finished = true;
          clearAll();
          var skInt = Math.round(skill);
          if (isMulti) {
            ctx.room.reportScore(skInt);
            ctx.room.reportState({ coins: coins });
            var me = ctx.room.players().filter(function (p) { return p.id === ctx.me.id; })[0];
            if (App.Scores && me) App.Scores.submitCurrent(Math.floor(me.score || 0)); // nur EIGENER Geschick-Endwert, genau einmal
            var to = setTimeout(function () {
              if (destroyed) return;
              showMultiEnd();
            }, 1200);
            stops.push(function () { clearTimeout(to); });
          } else {
            if (App.Scores) App.Scores.submitCurrent(skInt); // eigener Geschicklichkeits-Score, genau einmal
            var bestS = App.Storage.get('best_runner_skill', 0), nbS = skInt > bestS;
            var bestC = App.Storage.get('best_runner_coins', 0), nbC = coins > bestC;
            if (nbS) App.Storage.set('best_runner_skill', skInt);
            if (nbC) App.Storage.set('best_runner_coins', coins);
            showSingleEnd(skInt, bestS, nbS, coins, bestC, nbC);
          }
        }

        /* ---- Endscreen Singleplayer (beide Werte) ---- */
        function showSingleEnd(skInt, bestS, nbS, coinN, bestC, nbC) {
          root.innerHTML = '';
          root.appendChild(el('div', { class: 'glass mg-endscreen rn-end' }, [
            el('h2', { class: 'neon' }, ['🏁 Zeit um!']),
            el('div', { class: 'rn-end-stats' }, [
              el('div', { class: 'rn-end-stat' }, [
                el('div', { class: 'rn-end-icn' }, ['🏆']),
                el('div', { class: 'rn-end-lbl' }, ['Geschicklichkeit']),
                el('div', { class: 'rn-end-num rn-end-skill' }, [MG.fmt(skInt)]),
                el('div', { class: 'rn-end-sub' }, [nbS ? 'Neuer Rekord! 🎉' : ('Best: ' + MG.fmt(bestS))])
              ]),
              el('div', { class: 'rn-end-stat' }, [
                el('div', { class: 'rn-end-icn' }, ['🪙']),
                el('div', { class: 'rn-end-lbl' }, ['Münzen']),
                el('div', { class: 'rn-end-num rn-end-coin' }, [MG.fmt(coinN)]),
                el('div', { class: 'rn-end-sub' }, [nbC ? 'Neuer Rekord! 🎉' : ('Best: ' + MG.fmt(bestC))])
              ])
            ]),
            el('div', { class: 'controls-row' }, [
              el('button', { class: 'btn btn-primary', type: 'button', onclick: function () { play(Date.now()); } }, ['Nochmal']),
              el('button', { class: 'btn btn-ghost', type: 'button', onclick: ctx.onExit }, ['Zurück'])
            ])
          ]));
        }

        /* ---- Endscreen Multiplayer (Doppel-Ranking) ---- */
        function showMultiEnd() {
          var players = ctx.room.players();
          var meId = ctx.me.id;

          // Geschicklichkeit = score
          var bySkill = players.slice().sort(function (a, b) { return (b.score || 0) - (a.score || 0); });
          // Münzen = state.coins
          function coinsOf(p) { return (p.state && typeof p.state.coins === 'number') ? p.state.coins : 0; }
          var byCoins = players.slice().sort(function (a, b) { return coinsOf(b) - coinsOf(a); });

          var wonSkill = bySkill[0] && bySkill[0].id === meId;
          var wonCoins = byCoins[0] && byCoins[0].id === meId && coinsOf(byCoins[0]) > 0;

          function rankList(list, valFn, meWon, unit) {
            return el('div', { class: 'rn-rank' }, list.map(function (p, i) {
              var medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : ('#' + (i + 1));
              return el('div', { class: 'rn-rank-row' + (p.id === meId ? ' me' : '') + (i === 0 ? ' first' : '') }, [
                el('span', { class: 'rn-rank-medal' }, [medal]),
                el('span', { class: 'rn-rank-name' }, [p.name + (p.id === meId ? ' (du)' : '')]),
                el('span', { class: 'rn-rank-val' }, [MG.fmt(valFn(p)) + (unit || '')])
              ]);
            }));
          }

          var headline = wonSkill && wonCoins ? '👑 Doppelsieg! Bester Läufer UND Münz-König!'
            : wonSkill ? '🏆 Du bist der beste Läufer!'
            : wonCoins ? '🪙 Du bist der Münz-König!'
            : '🏁 Runde vorbei';

          root.innerHTML = '';
          root.appendChild(el('div', { class: 'glass mg-endscreen rn-mend' }, [
            el('h2', { class: 'neon rn-mend-h' }, [headline]),
            el('div', { class: 'rn-mend-cols' }, [
              el('div', { class: 'rn-mend-col' + (wonSkill ? ' rn-win' : '') }, [
                el('div', { class: 'rn-mend-title' }, ['🏆 Bester Läufer']),
                el('div', { class: 'rn-mend-cap' }, ['Geschicklichkeit']),
                rankList(bySkill, function (p) { return p.score || 0; }, wonSkill, '')
              ]),
              el('div', { class: 'rn-mend-col' + (wonCoins ? ' rn-win' : '') }, [
                el('div', { class: 'rn-mend-title' }, ['🪙 Münz-König']),
                el('div', { class: 'rn-mend-cap' }, ['Gesammelte Münzen']),
                rankList(byCoins, coinsOf, wonCoins, ' 🪙')
              ])
            ]),
            el('div', { class: 'controls-row' }, [
              el('button', { class: 'btn btn-ghost', type: 'button', onclick: ctx.onExit }, ['Zurück zur Lobby'])
            ])
          ]));
        }
      }
    }
  };

  /* ============================ STYLES ============================ */
  function injectStyle() {
    UI.injectStyle('mg-runner-css', [
      '.rn-wrap{display:flex;flex-direction:column;gap:14px;}',
      /* HUD */
      '.rn-hud{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px 18px;}',
      '.rn-hud-cell{display:flex;flex-direction:column;gap:2px;}',
      '.rn-hud-right{align-items:flex-end;}',
      '.rn-hud-l{font-size:11px;text-transform:uppercase;letter-spacing:1px;color:var(--muted);}',
      '.rn-val{font-size:clamp(22px,6vw,36px);line-height:1;font-variant-numeric:tabular-nums;font-weight:900;}',
      '.rn-skill{color:var(--neon);text-shadow:0 0 14px rgba(57,255,20,.5);}',
      '.rn-coin{color:var(--gold);text-shadow:0 0 14px rgba(255,210,63,.5);}',
      '.rn-val.rn-bump{animation:rn-bump .28s ease;}',
      '@keyframes rn-bump{0%{transform:scale(1)}45%{transform:scale(1.28)}100%{transform:scale(1)}}',
      '.rn-timer{font-size:clamp(20px,5vw,28px);font-variant-numeric:tabular-nums;}',
      '.rn-timer.rn-urgent{color:var(--danger);animation:rn-pulse .6s ease-in-out infinite;}',
      '@keyframes rn-pulse{0%,100%{opacity:1}50%{opacity:.45}}',
      /* Bühne */
      '.rn-stage{position:relative;width:100%;height:min(66vh,620px);min-height:340px;',
      'border-radius:var(--radius,16px);overflow:hidden;cursor:pointer;',
      'touch-action:none;user-select:none;-webkit-user-select:none;-webkit-tap-highlight-color:transparent;-webkit-touch-callout:none;',
      'background:#04140c;box-shadow:inset 0 0 46px rgba(0,0,0,.55),0 0 0 1px var(--stroke,rgba(57,255,20,.18));outline:none;}',
      '.rn-stage:focus-visible{box-shadow:inset 0 0 46px rgba(0,0,0,.55),0 0 0 2px var(--neon,#39ff14);}',
      '.rn-canvas{display:block;width:100%;height:100%;}',
      /* Biom-Tag */
      '.rn-biome{position:absolute;top:10px;left:10px;padding:5px 12px;border-radius:999px;font-weight:800;font-size:13px;',
      'background:rgba(4,16,10,.72);border:1px solid var(--stroke,rgba(57,255,20,.25));color:var(--leaf);backdrop-filter:blur(4px);}',
      '.rn-biome.rn-biome-flash{animation:rn-flash .6s ease;}',
      '@keyframes rn-flash{0%{transform:scale(1);filter:brightness(1)}40%{transform:scale(1.15);filter:brightness(1.8)}100%{transform:scale(1);filter:brightness(1)}}',
      /* Combo */
      '.rn-combo{position:absolute;top:10px;right:10px;padding:5px 12px;border-radius:999px;font-weight:900;font-size:14px;',
      'background:rgba(4,20,16,.7);border:1px solid rgba(51,230,208,.4);color:var(--aqua,#33e6d0);opacity:0;transform:translateY(-6px);transition:opacity .2s,transform .2s;}',
      '.rn-combo.rn-combo-on{opacity:1;transform:translateY(0);}',
      /* Power-Leiste */
      '.rn-powbar{position:absolute;bottom:10px;left:50%;transform:translateX(-50%);padding:4px 12px;border-radius:999px;',
      'font-weight:800;font-size:15px;letter-spacing:1px;background:rgba(4,16,10,.7);border:1px solid var(--stroke,rgba(57,255,20,.25));',
      'color:#eafff0;opacity:0;transition:opacity .2s;pointer-events:none;}',
      '.rn-powbar.rn-powbar-on{opacity:1;}',
      /* Steuer-Pfeile (Touch) */
      '.rn-pad{position:absolute;right:12px;bottom:12px;display:flex;flex-direction:column;align-items:center;gap:8px;opacity:.9;}',
      '.rn-pad-mid{display:flex;gap:8px;align-items:center;}',
      '.rn-arrow{width:54px;height:54px;border-radius:14px;border:1px solid var(--stroke-2,rgba(57,255,20,.4));',
      'background:rgba(6,24,14,.62);color:var(--leaf);font-size:22px;font-weight:900;line-height:1;',
      'display:flex;align-items:center;justify-content:center;cursor:pointer;-webkit-tap-highlight-color:transparent;',
      'backdrop-filter:blur(4px);transition:transform .08s,background .12s;}',
      '.rn-arrow:active{transform:scale(.9);background:rgba(57,255,20,.28);}',
      '@media (min-width:820px){.rn-pad{opacity:.5;}.rn-arrow{width:46px;height:46px;font-size:18px;}}',
      /* Live-Board + Hinweis */
      '.rn-board-wrap{padding:14px;display:flex;flex-direction:column;gap:8px;max-height:240px;overflow-y:auto;}',
      '.rn-hint{text-align:center;font-size:13px;line-height:1.4;}',
      /* Endscreen Single */
      '.rn-end-stats{display:flex;gap:16px;justify-content:center;flex-wrap:wrap;width:100%;}',
      '.rn-end-stat{flex:1 1 180px;min-width:160px;padding:16px;border-radius:14px;background:rgba(4,16,10,.6);border:1px solid var(--stroke-2,rgba(57,255,20,.3));display:flex;flex-direction:column;align-items:center;gap:4px;}',
      '.rn-end-icn{font-size:34px;}',
      '.rn-end-lbl{font-size:12px;text-transform:uppercase;letter-spacing:1px;color:var(--muted);}',
      '.rn-end-num{font-size:38px;font-weight:900;font-variant-numeric:tabular-nums;}',
      '.rn-end-skill{color:var(--neon);text-shadow:0 0 14px rgba(57,255,20,.5);}',
      '.rn-end-coin{color:var(--gold);text-shadow:0 0 14px rgba(255,210,63,.5);}',
      '.rn-end-sub{font-size:12px;color:var(--leaf);}',
      /* Endscreen Multi (Doppel-Ranking) */
      '.rn-mend{max-width:720px;}',
      '.rn-mend-h{text-align:center;}',
      '.rn-mend-cols{display:flex;gap:16px;width:100%;flex-wrap:wrap;}',
      '.rn-mend-col{flex:1 1 260px;min-width:220px;padding:14px;border-radius:14px;background:rgba(4,16,10,.55);border:1px solid var(--stroke,rgba(57,255,20,.2));}',
      '.rn-mend-col.rn-win{border-color:var(--gold,#ffd23f);box-shadow:0 0 22px rgba(255,210,63,.35);}',
      '.rn-mend-title{font-weight:900;font-size:17px;text-align:center;color:#eafff0;}',
      '.rn-mend-cap{font-size:11px;text-transform:uppercase;letter-spacing:1px;color:var(--muted);text-align:center;margin-bottom:8px;}',
      '.rn-rank{display:flex;flex-direction:column;gap:5px;}',
      '.rn-rank-row{display:grid;grid-template-columns:34px 1fr auto;align-items:center;gap:8px;padding:7px 10px;border-radius:10px;background:rgba(9,32,21,.55);border:1px solid var(--stroke,rgba(57,255,20,.16));}',
      '.rn-rank-row.first{background:rgba(40,32,6,.55);border-color:rgba(255,210,63,.4);}',
      '.rn-rank-row.me{box-shadow:inset 0 0 0 1px var(--neon,#39ff14);}',
      '.rn-rank-medal{font-weight:900;text-align:center;}',
      '.rn-rank-name{font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.rn-rank-val{font-weight:900;color:var(--leaf);font-variant-numeric:tabular-nums;}'
    ].join(''));
  }
})();
