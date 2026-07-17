/* agar.js — "Zell-Fresser": ein Agar.io-Klon im Neon-Dschungel-Look.
 *
 * IDEE
 *   Man ist ein leuchtender Zell-Klecks in einer großen Arena. Die Kamera folgt
 *   der eigenen Zelle und zoomt heraus, je größer man wird. Überall liegen kleine
 *   Pellets herum – fressen lässt die Zelle wachsen. Größere Zellen können kleinere
 *   verschlucken (man muss dafür rund ~22 % größer sein). Je größer man ist, desto
 *   langsamer wird man. Masse = Punkte. Nach 2 Minuten gewinnt die größte Zelle.
 *
 * STEUERUNG
 *   Maus:    Zelle bewegt sich immer Richtung Mauszeiger (kein Klicken nötig).
 *   Touch:   Finger auf die Fläche legen/ziehen – die Zelle folgt dem Finger.
 *   Tasten:  WASD / Pfeiltasten (optional).
 *   Je weiter der Zeiger von der Zellenmitte weg ist, desto voller die Geschwindigkeit.
 *
 * PUNKTE
 *   Punkte = aktuelle Masse. Wer gefressen wird, spawnt klein neu und verliert seine
 *   Masse – also aufpassen! Am Ende zählt die größte Masse.
 *
 * SYNC-MODELL (Multiplayer)
 *   Host-autoritativ. Der Host simuliert ALLE Zellen (Spieler + Bots) und die Pellets
 *   und sendet den kompletten Weltzustand ~10x/s per room.setShared({cells, pel, t}).
 *   Jeder Spieler meldet nur seine eigene Zielrichtung per room.reportState({ax,ay}).
 *   Nicht-Host rendert den empfangenen Zustand (glättet Positionen) und prädiziert die
 *   eigene Zelle lokal für ein direktes Steuergefühl. Zeit läuft über room.now() →
 *   alle starten und enden synchron (startAt aus snapshot().round). Punkte meldet jeder
 *   per reportScore(masse) → Live-Rangliste & Endscreen.
 *
 * SOLO
 *   Gleiche Simulation lokal gegen mehrere Bots mit unterschiedlichem Können: sie
 *   farmen Pellets, jagen kleinere Zellen und fliehen vor größeren. Bestwert im Storage.
 */
(function () {
  'use strict';
  window.App = window.App || {}; App.Minigames = App.Minigames || {};
  var UI = App.UI, el = UI.el;

  /* ------------------------------------------------------------------ *
   *  Konstanten (virtuelle Welt-Einheiten; Canvas skaliert per CSS)
   * ------------------------------------------------------------------ */
  var VW = 960, VH = 640;             // virtuelle Canvas-Größe
  var WORLD = 2800;                   // quadratische Arena
  var START_MASS = 22;                // Startmasse einer Zelle
  var PELLET_MASS = 1;                // Masse pro Pellet
  var PELLET_R = 5;                   // Pellet-Zeichenradius
  var EAT_RATIO = 1.22;              // so viel größer, um zu fressen (+22 %)
  var MATCH_TIME = 120;               // s Rundenzeit
  var MASS_CAP = 30000;
  var SPEED_MAX = 300, SPEED_MIN = 95;
  var R0 = 4 * Math.sqrt(START_MASS); // Startradius (für Speed/Zoom-Bezug)
  var GRID = 120;                     // Gitterabstand Hintergrund
  var VIEW0 = 560, ZOOM_K = 6.0;      // Zoom: sichtbare Welt-Höhe = VIEW0 + r*K
  var BROADCAST_MS = 100, REPORT_MS = 90, SCORE_MS = 450;

  var CELL_COLORS = ['#39ff14', '#33e6d0', '#ffd23f', '#ff6ec7', '#b06bff',
    '#4dd2ff', '#ff9f43', '#9dff7a', '#ff4d6d', '#7affd1', '#e6ff5a', '#5af7c0'];
  var PELLET_COLORS = ['#7fffab', '#7fd8ff', '#ffe37f', '#ff9fd0', '#c79fff',
    '#9fffd8', '#ffc79f', '#d8ff9f'];
  var BOT_NAMES = ['Blubb', 'Klecks', 'Schlucker', 'Zellulo', 'Mikrobi', 'Amöbe',
    'Fresso', 'Pünktchen', 'Wabbel', 'Glibber', 'Kugelchen', 'Protzo', 'Schleimi',
    'Nucleus', 'Vakuole', 'Plasmi'];

  /* ------------------------------------------------------------------ *
   *  kleine Mathe-/Geometrie-Helfer
   * ------------------------------------------------------------------ */
  function rand(a, b) { return a + Math.random() * (b - a); }
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function radiusOf(m) { return 4 * Math.sqrt(m); }
  function speedOf(m) {
    var f = Math.sqrt(R0 / radiusOf(m));           // klein = schnell, groß = langsam
    var sp = SPEED_MIN + (SPEED_MAX - SPEED_MIN) * f;
    return clamp(sp, SPEED_MIN, SPEED_MAX);
  }

  injectStyle();

  App.Minigames.agar = {
    id: 'agar', title: 'Zell-Fresser', icon: '🦠', order: 147,
    subtitle: 'Friss, wachse, werde die größte Zelle!',
    single: true, multi: true, minPlayers: 2, maxPlayers: 6,

    render: function (root, ctx) {
      var isMulti = ctx.mode === 'multi';
      var nowFn = isMulti ? function () { return ctx.room.now(); } : function () { return Date.now(); };
      var myId = isMulti ? ctx.me.id : 'me';
      var myName = (ctx.me && ctx.me.name) ? ctx.me.name : 'Du';

      /* ---- Laufzeit-/Aufräum-Zustand ---- */
      var dead = false, finished = false;
      var raf = null, last = 0;
      var stops = [];        // stop()-Funktionen (App.MG-Bausteine, room.off)
      var timers = [];       // setTimeout-IDs
      var listeners = [];    // {t,ty,fn,opts}

      /* ---- Spiel-Zustand ---- */
      var sim = null;                 // autoritative Simulation (Solo & Host)
      var model = null;               // Render-Modell (Nicht-Host)
      var pred = null;                // Prädiktion der eigenen Zelle (Nicht-Host)
      var prevAuthX = 0, prevAuthY = 0;
      var myMass = START_MASS, prevMyMass = START_MASS;
      var lastCast = 0, lastReport = 0, lastScore = 0, lastPop = 0;
      var particles = [];
      var hurtUntil = 0, boostUntil = 0;

      /* ---- Kamera ---- */
      var camX = WORLD / 2, camY = WORLD / 2, camS = 1, snapCam = true;
      var shX = 0, shY = 0;

      /* ---- Eingabe ---- */
      var ptr = { x: VW / 2, y: VH / 2, active: false };
      var keyU = false, keyD = false, keyL = false, keyR = false;

      /* ---- DOM-Referenzen ---- */
      var canvas = null, g = null, massEl = null, rankEl = null, timerEl = null;

      /* ---------------- Aufräum-Infrastruktur ---------------- */
      function addL(t, ty, fn, opts) { t.addEventListener(ty, fn, opts); listeners.push({ t: t, ty: ty, fn: fn, opts: opts }); }
      function removeListeners() { listeners.forEach(function (l) { try { l.t.removeEventListener(l.ty, l.fn, l.opts); } catch (e) {} }); listeners = []; }
      function after(ms, fn) { var t = setTimeout(function () { if (!dead) fn(); }, ms); timers.push(t); return t; }
      function clearTimers() { timers.forEach(clearTimeout); timers = []; }
      function stopHelpers() { stops.forEach(function (f) { try { f(); } catch (e) {} }); stops = []; }
      function stopRound() {
        if (raf) { cancelAnimationFrame(raf); raf = null; }
        stopHelpers(); removeListeners(); clearTimers();
      }
      function cleanup() { dead = true; stopRound(); }

      /* ---------------- Start ---------------- */
      if (isMulti) {
        var snap = ctx.room.snapshot() || {};
        var startAt = (snap.round && snap.round.startAt) || (ctx.room.now() + 3000);
        stops.push(App.MG.countdown(root, startAt, function () { play(startAt); }, ctx.room.now));
      } else {
        play(nowFn());
      }
      return { cleanup: cleanup };

      /* ================================================================ *
       *  Runde aufbauen
       * ================================================================ */
      function play(startAt) {
        stopRound();
        finished = false;
        myMass = prevMyMass = START_MASS;
        particles = []; hurtUntil = 0; boostUntil = 0;
        snapCam = true; camS = 1;

        buildStage();
        setupInput();

        var amHost = isMulti ? ctx.room.isHost() : true;
        if (amHost) { buildSim(); }
        else { model = { cells: {}, pellets: [] }; pred = null; }

        // Nicht-Host (und zur Sicherheit auch Host) hört auf Weltzustand.
        if (isMulti) {
          var sh = function (s) { onShared(s); };
          ctx.room.on('shared', sh);
          stops.push(function () { ctx.room.off('shared', sh); });
          var cur = (ctx.room.snapshot() && ctx.room.snapshot().shared) || null;
          if (cur) onShared(cur);
          try { ctx.room.reportScore(START_MASS); } catch (e) {}
        }

        // synchroner Rundentimer (Wall-Clock)
        var endAt = startAt + MATCH_TIME * 1000;
        stops.push(App.MG.roundTimer(endAt, function (leftSec) {
          if (!timerEl) return;
          timerEl.textContent = App.MG.mmss(leftSec);
          if (leftSec <= 10) timerEl.classList.add('agr-urgent'); else timerEl.classList.remove('agr-urgent');
        }, finish, isMulti ? ctx.room.now : null));

        if (App.Audio) App.Audio.sfx('start');
        last = nowFn();
        raf = requestAnimationFrame(frame);
      }

      /* ---------------- Simulation aufbauen (Host/Solo) ---------------- */
      function buildSim() {
        sim = { cells: [], pellets: [] };
        var i, colIdx = 0;

        if (isMulti) {
          var ps = ctx.room.players();
          for (i = 0; i < ps.length; i++) {
            sim.cells.push(makePlayerCell(ps[i].id, ps[i].name, CELL_COLORS[colIdx % CELL_COLORS.length]));
            colIdx++;
          }
        } else {
          sim.cells.push(makePlayerCell('me', myName, CELL_COLORS[0]));
          colIdx = 1;
        }

        var nBots = isMulti
          ? clamp(8 - ctx.room.players().length, 2, 6)
          : 7;
        var used = {};
        for (i = 0; i < nBots; i++) {
          var nm;
          do { nm = BOT_NAMES[Math.floor(Math.random() * BOT_NAMES.length)]; } while (used[nm] && Object.keys(used).length < BOT_NAMES.length);
          used[nm] = true;
          var skill = clamp(0.4 + (i / Math.max(1, nBots - 1)) * 0.5 + rand(-0.08, 0.08), 0.35, 0.95);
          var c = makePlayerCell('b' + i, nm, CELL_COLORS[colIdx % CELL_COLORS.length]);
          c.bot = true; c.skill = skill; c.reAt = 0; c.tx = c.x; c.ty = c.y;
          c.aimx = 0; c.aimy = 0; c.m = rand(START_MASS * 0.7, START_MASS * 1.5);
          sim.cells.push(c); colIdx++;
        }

        var nPel = isMulti ? 150 : 200;
        for (i = 0; i < nPel; i++) sim.pellets.push({ x: rand(30, WORLD - 30), y: rand(30, WORLD - 30) });
      }

      function makePlayerCell(id, name, col) {
        var s = pickSpawn(START_MASS);
        return { id: id, name: name || '?', col: col, bot: false, x: s.x, y: s.y, m: START_MASS,
          mvx: 0, mvy: 0, skill: 0, reAt: 0, tx: s.x, ty: s.y, aimx: 0, aimy: 0 };
      }

      // Spawn-Punkt möglichst weit weg von deutlich größeren Zellen.
      function pickSpawn(mass) {
        var best = null, bestScore = -1, tries = 8, i, k;
        for (i = 0; i < tries; i++) {
          var x = rand(120, WORLD - 120), y = rand(120, WORLD - 120), near = 1e9;
          if (sim) for (k = 0; k < sim.cells.length; k++) {
            var o = sim.cells[k];
            if (o.m > mass * EAT_RATIO) {
              var d = Math.sqrt((o.x - x) * (o.x - x) + (o.y - y) * (o.y - y));
              if (d < near) near = d;
            }
          }
          if (near > bestScore) { bestScore = near; best = { x: x, y: y }; }
          if (near > 500) break;
        }
        return best || { x: WORLD / 2, y: WORLD / 2 };
      }

      /* ================================================================ *
       *  Haupt-Frame
       * ================================================================ */
      function frame() {
        if (dead) { raf = null; return; }
        var now = nowFn();
        var dt = (now - last) / 1000; if (dt < 0) dt = 0; if (dt > 0.05) dt = 0.05; last = now;

        var mvec = computeMvec();
        var amHost = isMulti ? ctx.room.isHost() : true;

        // Übernahme: falls ich unerwartet Host werde, Sim aus dem Modell bauen.
        if (amHost && !sim) buildSimFromModel();

        var me, view;
        if (amHost) {
          me = cellById(myId);
          if (me) { me.mvx = mvec.x; me.mvy = mvec.y; }
          if (isMulti) reconcilePlayers();
          stepSim(dt, now);
          me = cellById(myId);
          myMass = me ? me.m : START_MASS;
          view = { cells: sim.cells, pellets: sim.pellets, me: me };
          if (isMulti && (now - lastCast >= BROADCAST_MS)) { lastCast = now; broadcast(now); }
        } else {
          // Nicht-Host: eigene Richtung melden, Zustand glätten, eigene Zelle prädizieren
          if (now - lastReport >= REPORT_MS) { lastReport = now; try { ctx.room.reportState({ ax: mvec.x, ay: mvec.y }); } catch (e) {} }
          smoothModel(dt);
          me = predictSelf(dt, mvec);
          view = buildModelView(me);
        }

        if (!me) { drawWaiting(); raf = requestAnimationFrame(frame); return; }

        // Punkte melden (gedrosselt)
        if (isMulti && (now - lastScore >= SCORE_MS)) { lastScore = now; try { ctx.room.reportScore(Math.round(myMass)); } catch (e) {} }

        detectFeedback(me);
        updateCamera(me.x, me.y, myMass, dt, now);
        updateParticles(dt);
        draw(view, now);

        raf = requestAnimationFrame(frame);
      }

      /* ---------------- Simulation (ein Schritt) ---------------- */
      function stepSim(dt, now) {
        var cells = sim.cells, pellets = sim.pellets, i, j;

        // 1) Bewegung
        for (i = 0; i < cells.length; i++) {
          var c = cells[i], mvx, mvy;
          if (c.bot) { botThink(c, now); mvx = c.aimx; mvy = c.aimy; }
          else { mvx = c.mvx || 0; mvy = c.mvy || 0; }
          var sp = speedOf(c.m), r = radiusOf(c.m);
          c.x = clamp(c.x + mvx * sp * dt, r, WORLD - r);
          c.y = clamp(c.y + mvy * sp * dt, r, WORLD - r);
        }

        // 2) Pellets fressen
        for (i = 0; i < cells.length; i++) {
          var cc = cells[i], rr = radiusOf(cc.m), rr2 = rr * rr;
          for (j = 0; j < pellets.length; j++) {
            var p = pellets[j], dx = p.x - cc.x, dy = p.y - cc.y;
            if (dx * dx + dy * dy < rr2) {
              cc.m = Math.min(MASS_CAP, cc.m + PELLET_MASS);
              p.x = rand(30, WORLD - 30); p.y = rand(30, WORLD - 30);
            }
          }
        }

        // 3) Zelle frisst Zelle
        for (i = 0; i < cells.length; i++) {
          for (j = i + 1; j < cells.length; j++) {
            var a = cells[i], b = cells[j];
            var ra = radiusOf(a.m), rb = radiusOf(b.m);
            var ddx = a.x - b.x, ddy = a.y - b.y, d2 = ddx * ddx + ddy * ddy;
            if (a.m >= b.m * EAT_RATIO) {
              var lim = ra - rb * 0.6; if (lim > 0 && d2 < lim * lim) eat(a, b);
            } else if (b.m >= a.m * EAT_RATIO) {
              var lim2 = rb - ra * 0.6; if (lim2 > 0 && d2 < lim2 * lim2) eat(b, a);
            }
          }
        }
      }

      function eat(big, small) {
        big.m = Math.min(MASS_CAP, big.m + small.m);
        var s = pickSpawn(START_MASS);
        small.m = START_MASS; small.x = s.x; small.y = s.y;
        small.mvx = 0; small.mvy = 0; small.reAt = 0;
      }

      /* ---------------- Bot-KI ---------------- */
      function botThink(c, now) {
        if (now < c.reAt) { aimToTarget(c); return; }
        c.reAt = now + (0.34 - c.skill * 0.22) * 1000 * rand(0.7, 1.3);

        var myR = radiusOf(c.m), cells = sim.cells, k;
        var threat = null, threatD = 1e9, prey = null, preyD = 1e9;
        for (k = 0; k < cells.length; k++) {
          var o = cells[k]; if (o === c) continue;
          var d = Math.sqrt((o.x - c.x) * (o.x - c.x) + (o.y - c.y) * (o.y - c.y));
          if (o.m >= c.m * EAT_RATIO) { if (d < threatD) { threatD = d; threat = o; } }
          else if (c.m >= o.m * EAT_RATIO) { if (d < preyD) { preyD = d; prey = o; } }
        }

        var vis = 260 + myR * 4;
        var fleeR = (myR + (threat ? radiusOf(threat.m) : 0)) * (2.2 + c.skill * 2) + 60;
        var tx, ty;

        if (threat && threatD < fleeR) {
          var ang = Math.atan2(c.y - threat.y, c.x - threat.x);
          tx = c.x + Math.cos(ang) * 420; ty = c.y + Math.sin(ang) * 420;
        } else if (prey && preyD < vis && Math.random() < (0.35 + c.skill * 0.6)) {
          tx = prey.x; ty = prey.y;                        // Jagd auf kleinere Zelle
        } else {
          var best = null, bd = 1e9;                       // sonst: nächstes Pellet
          for (k = 0; k < sim.pellets.length; k++) {
            var pp = sim.pellets[k], pdx = pp.x - c.x, pdy = pp.y - c.y, pd = pdx * pdx + pdy * pdy;
            if (pd < bd) { bd = pd; best = pp; }
          }
          if (best && Math.random() > (1 - c.skill) * 0.2) { tx = best.x; ty = best.y; }
          else { tx = rand(120, WORLD - 120); ty = rand(120, WORLD - 120); }
        }
        // schwächere Bots zielen ungenauer
        var jit = (1 - c.skill) * 90;
        tx += rand(-jit, jit); ty += rand(-jit, jit);
        c.tx = clamp(tx, 40, WORLD - 40); c.ty = clamp(ty, 40, WORLD - 40);
        aimToTarget(c);
      }
      function aimToTarget(c) {
        var dx = c.tx - c.x, dy = c.ty - c.y, len = Math.sqrt(dx * dx + dy * dy);
        if (len < 4) { c.aimx = 0; c.aimy = 0; return; }
        var inten = Math.min(1, len / 130);
        c.aimx = dx / len * inten; c.aimy = dy / len * inten;
      }

      /* ---------------- Host: Spieler-Liste abgleichen ---------------- */
      function reconcilePlayers() {
        var ps = ctx.room.players(), i, k, ids = {};
        for (i = 0; i < ps.length; i++) {
          ids[ps[i].id] = true;
          var c = cellById(ps[i].id);
          if (!c) {
            c = makePlayerCell(ps[i].id, ps[i].name, CELL_COLORS[sim.cells.length % CELL_COLORS.length]);
            sim.cells.push(c);
          } else {
            c.name = ps[i].name;
            if (ps[i].id !== myId) {
              var st = ps[i].state;
              c.mvx = (st && typeof st.ax === 'number') ? st.ax : 0;
              c.mvy = (st && typeof st.ay === 'number') ? st.ay : 0;
            }
          }
        }
        // ausgestiegene Spieler-Zellen entfernen (Bots bleiben)
        for (k = sim.cells.length - 1; k >= 0; k--) {
          var cell = sim.cells[k];
          if (!cell.bot && !ids[cell.id]) sim.cells.splice(k, 1);
        }
      }

      /* ---------------- Host: Weltzustand senden ---------------- */
      function broadcast(now) {
        var cells = [], i;
        for (i = 0; i < sim.cells.length; i++) {
          var c = sim.cells[i];
          cells.push({ i: c.id, x: Math.round(c.x), y: Math.round(c.y), m: Math.round(c.m * 10) / 10, n: c.name, c: c.col, b: c.bot ? 1 : 0 });
        }
        var pel = [];
        for (i = 0; i < sim.pellets.length; i++) { pel.push(Math.round(sim.pellets[i].x)); pel.push(Math.round(sim.pellets[i].y)); }
        try { ctx.room.setShared({ cells: cells, pel: pel, t: now }); } catch (e) {}
      }

      /* ---------------- Nicht-Host: Zustand empfangen ---------------- */
      function onShared(sh) {
        if (dead || !sh) return;
        if (isMulti && ctx.room.isHost()) return;    // Host ist selbst die Quelle
        if (!model) model = { cells: {}, pellets: [] };
        var i, keep = {};
        if (sh.cells) {
          for (i = 0; i < sh.cells.length; i++) {
            var e = sh.cells[i]; keep[e.i] = true;
            var c = model.cells[e.i];
            if (!c) { c = { dx: e.x, dy: e.y }; model.cells[e.i] = c; }
            c.x = e.x; c.y = e.y; c.m = e.m; c.name = e.n; c.col = e.c; c.bot = !!e.b;
          }
          for (var id in model.cells) { if (model.cells.hasOwnProperty(id) && !keep[id]) delete model.cells[id]; }
        }
        if (sh.pel) {
          var pel = [];
          for (i = 0; i + 1 < sh.pel.length; i += 2) pel.push({ x: sh.pel[i], y: sh.pel[i + 1] });
          model.pellets = pel;
        }
        // Punkte für die Rangliste aus der eigenen autoritativen Masse melden
        var mine = model.cells[myId];
        if (mine) myMass = mine.m;
      }

      // Fließende Anzeige: Display-Position sanft an Zielposition ziehen.
      function smoothModel(dt) {
        if (!model) return;
        var f = Math.min(1, dt * 11);
        for (var id in model.cells) {
          if (!model.cells.hasOwnProperty(id)) continue;
          var c = model.cells[id];
          c.dx += (c.x - c.dx) * f; c.dy += (c.y - c.dy) * f;
        }
      }

      // Eigene Zelle lokal prädizieren (responsiv) + sanft an Host korrigieren.
      function predictSelf(dt, mvec) {
        if (!model) return null;
        var auth = model.cells[myId];
        if (!auth) { pred = null; return null; }
        if (!pred) { pred = { x: auth.x, y: auth.y }; prevAuthX = auth.x; prevAuthY = auth.y; }
        // Teleport (Respawn) → hart nachziehen
        var jumped = Math.abs(auth.x - prevAuthX) > 240 || Math.abs(auth.y - prevAuthY) > 240;
        prevAuthX = auth.x; prevAuthY = auth.y;
        if (jumped) { pred.x = auth.x; pred.y = auth.y; snapCam = true; }
        else {
          var sp = speedOf(auth.m), r = radiusOf(auth.m);
          pred.x = clamp(pred.x + mvec.x * sp * dt, r, WORLD - r);
          pred.y = clamp(pred.y + mvec.y * sp * dt, r, WORLD - r);
          pred.x += (auth.x - pred.x) * 0.10;             // gegen Auseinanderdriften
          pred.y += (auth.y - pred.y) * 0.10;
        }
        myMass = auth.m;
        return { id: myId, x: pred.x, y: pred.y, m: auth.m, col: auth.col, name: auth.name, bot: false };
      }

      function buildModelView(me) {
        var arr = [], id;
        for (id in model.cells) {
          if (!model.cells.hasOwnProperty(id)) continue;
          var c = model.cells[id];
          if (id === myId) { arr.push(me); }
          else arr.push({ id: id, x: c.dx, y: c.dy, m: c.m, col: c.col, name: c.name, bot: c.bot });
        }
        return { cells: arr, pellets: model.pellets || [], me: me };
      }

      // Host-Übernahme: aus dem letzten Render-Modell eine Sim rekonstruieren.
      function buildSimFromModel() {
        sim = { cells: [], pellets: [] };
        if (!model) { buildSim(); return; }
        var id, bi = 0;
        for (id in model.cells) {
          if (!model.cells.hasOwnProperty(id)) continue;
          var c = model.cells[id];
          var cell = { id: id, name: c.name || '?', col: c.col || CELL_COLORS[0], bot: !!c.bot,
            x: c.x, y: c.y, m: c.m, mvx: 0, mvy: 0, skill: 0.6, reAt: 0, tx: c.x, ty: c.y, aimx: 0, aimy: 0 };
          if (cell.bot) { cell.skill = clamp(0.45 + (bi % 5) * 0.1, 0.35, 0.95); bi++; }
          sim.cells.push(cell);
        }
        var i;
        if (model.pellets) for (i = 0; i < model.pellets.length; i++) sim.pellets.push({ x: model.pellets[i].x, y: model.pellets[i].y });
        if (!sim.pellets.length) for (i = 0; i < 150; i++) sim.pellets.push({ x: rand(30, WORLD - 30), y: rand(30, WORLD - 30) });
      }

      function cellById(id) { if (!sim) return null; for (var i = 0; i < sim.cells.length; i++) if (sim.cells[i].id === id) return sim.cells[i]; return null; }

      /* ---------------- Eingabe → Bewegungsvektor ---------------- */
      function computeMvec() {
        var kx = (keyR ? 1 : 0) - (keyL ? 1 : 0), ky = (keyD ? 1 : 0) - (keyU ? 1 : 0);
        if (kx || ky) { var kl = Math.sqrt(kx * kx + ky * ky); return { x: kx / kl, y: ky / kl }; }
        if (ptr.active) {
          var dx = ptr.x - VW / 2, dy = ptr.y - VH / 2, len = Math.sqrt(dx * dx + dy * dy);
          if (len < 12) return { x: 0, y: 0 };
          var inten = Math.min(1, len / 220);
          return { x: dx / len * inten, y: dy / len * inten };
        }
        return { x: 0, y: 0 };
      }

      /* ---------------- lokale Rückmeldung (Sound/Partikel) ---------------- */
      function detectFeedback(me) {
        var d = myMass - prevMyMass;
        if (d > 4) {                                  // Zelle verschluckt
          if (App.Audio) App.Audio.sfx('powerup');
          burst(me.x, me.y, me.col, 14); boostUntil = nowFn() + 260;
        } else if (d > 0.5) {                         // Pellet(s) gefressen
          var t = nowFn(); if (t - lastPop > 70) { lastPop = t; if (App.Audio) App.Audio.blip(520 + Math.min(600, myMass), 0.05, { type: 'sine', peak: 0.05 }); }
        } else if (d < -6 && prevMyMass > START_MASS * 1.4) {   // selbst gefressen
          if (App.Audio) App.Audio.sfx('explosion');
          burst(me.x, me.y, '#ff4d6d', 22); hurtUntil = nowFn() + 460;
        }
        prevMyMass = myMass;
      }
      function burst(x, y, col, n) {
        for (var i = 0; i < n; i++) {
          var a = Math.random() * Math.PI * 2, sp = rand(60, 260);
          particles.push({ x: x, y: y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 1, max: rand(0.4, 0.8), col: col, r: rand(2, 5) });
        }
      }
      function updateParticles(dt) {
        for (var i = particles.length - 1; i >= 0; i--) {
          var p = particles[i];
          p.life -= dt / p.max; p.x += p.vx * dt; p.y += p.vy * dt; p.vx *= 0.92; p.vy *= 0.92;
          if (p.life <= 0) particles.splice(i, 1);
        }
      }

      /* ---------------- Kamera ---------------- */
      function updateCamera(mx, my, mm, dt, now) {
        var targetS = VH / (VIEW0 + radiusOf(mm) * ZOOM_K);
        if (snapCam) { camX = mx; camY = my; camS = targetS; snapCam = false; }
        else {
          var f = Math.min(1, dt * 6);
          camX += (mx - camX) * f; camY += (my - camY) * f;
          camS += (targetS - camS) * Math.min(1, dt * 4);
        }
        if (now < hurtUntil) { var mag = 7 * (hurtUntil - now) / 460; shX = rand(-mag, mag); shY = rand(-mag, mag); }
        else { shX = 0; shY = 0; }
      }
      function sx(wx) { return (wx - camX) * camS + VW / 2 + shX; }
      function sy(wy) { return (wy - camY) * camS + VH / 2 + shY; }

      /* ================================================================ *
       *  Rendering
       * ================================================================ */
      function draw(view, now) {
        if (!g) return;
        // Hintergrund
        var grd = g.createLinearGradient(0, 0, 0, VH);
        grd.addColorStop(0, '#06180e'); grd.addColorStop(1, '#020a06');
        g.fillStyle = grd; g.fillRect(0, 0, VW, VH);

        drawGrid();
        drawBorder();
        drawPellets(view.pellets);
        drawCells(view.cells);
        drawParticles();
        drawPointer(view.me);
        drawLeaderboard(view.cells);
        if (now < hurtUntil) drawHurt(now);

        // HUD-Text
        if (massEl) massEl.textContent = App.MG.fmt(Math.round(myMass));
        if (rankEl) rankEl.textContent = rankText(view.cells);
      }

      function drawGrid() {
        var x0 = camX - (VW / 2) / camS, x1 = camX + (VW / 2) / camS;
        var y0 = camY - (VH / 2) / camS, y1 = camY + (VH / 2) / camS;
        g.strokeStyle = 'rgba(57,255,20,0.06)'; g.lineWidth = 1;
        g.beginPath();
        var gx = Math.floor(x0 / GRID) * GRID;
        for (; gx <= x1; gx += GRID) { g.moveTo(sx(gx), sy(y0)); g.lineTo(sx(gx), sy(y1)); }
        var gy = Math.floor(y0 / GRID) * GRID;
        for (; gy <= y1; gy += GRID) { g.moveTo(sx(x0), sy(gy)); g.lineTo(sx(x1), sy(gy)); }
        g.stroke();
      }
      function drawBorder() {
        g.save();
        g.strokeStyle = 'rgba(51,230,208,0.5)'; g.lineWidth = 3;
        g.shadowColor = 'rgba(51,230,208,0.5)'; g.shadowBlur = 16;
        g.strokeRect(sx(0), sy(0), WORLD * camS, WORLD * camS);
        g.restore();
      }
      function drawPellets(pellets) {
        if (!pellets) return;
        var r = PELLET_R * camS; if (r < 1.2) r = 1.2;
        var x0 = camX - (VW / 2 + 40) / camS, x1 = camX + (VW / 2 + 40) / camS;
        var y0 = camY - (VH / 2 + 40) / camS, y1 = camY + (VH / 2 + 40) / camS;
        for (var i = 0; i < pellets.length; i++) {
          var p = pellets[i];
          if (p.x < x0 || p.x > x1 || p.y < y0 || p.y > y1) continue;  // Culling
          g.fillStyle = PELLET_COLORS[i % PELLET_COLORS.length];
          g.beginPath(); g.arc(sx(p.x), sy(p.y), r, 0, Math.PI * 2); g.fill();
        }
      }
      function drawCells(cells) {
        var ordered = cells.slice().sort(function (a, b) { return a.m - b.m; }); // klein zuerst
        for (var i = 0; i < ordered.length; i++) {
          var c = ordered[i], isMe = c.id === myId;
          var cx = sx(c.x), cy = sy(c.y), r = radiusOf(c.m) * camS;
          if (cx < -r - 20 || cx > VW + r + 20 || cy < -r - 20 || cy > VH + r + 20) continue;

          g.save();
          if (r > 10) { g.shadowColor = c.col; g.shadowBlur = Math.min(30, r * 0.5); }
          var rg = g.createRadialGradient(cx - r * 0.3, cy - r * 0.3, r * 0.1, cx, cy, r);
          rg.addColorStop(0, lighten(c.col)); rg.addColorStop(1, c.col);
          g.fillStyle = rg;
          g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.fill();
          g.restore();

          // Umrandung
          g.lineWidth = Math.max(1.5, r * 0.06);
          g.strokeStyle = isMe ? '#ffffff' : darken(c.col);
          g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.stroke();

          // Eigener Puls-Ring
          if (isMe) {
            var t = (nowFn() % 1400) / 1400, pr = r + 3 + t * 8;
            g.globalAlpha = 1 - t; g.strokeStyle = '#eaffe0'; g.lineWidth = 2;
            g.beginPath(); g.arc(cx, cy, pr, 0, Math.PI * 2); g.stroke(); g.globalAlpha = 1;
          }

          // Name + Masse
          if (r > 15) {
            g.save();
            g.font = '900 ' + Math.max(10, Math.min(r * 0.5, 22)).toFixed(0) + 'px "Segoe UI",system-ui,Arial,sans-serif';
            g.textAlign = 'center'; g.textBaseline = 'middle';
            g.fillStyle = 'rgba(0,0,0,0.55)'; g.fillText(c.name, cx, cy + 1);
            g.fillStyle = '#ffffff'; g.fillText(c.name, cx, cy);
            if (r > 26) {
              g.font = '800 ' + Math.max(9, Math.min(r * 0.32, 15)).toFixed(0) + 'px "Segoe UI",system-ui,Arial,sans-serif';
              g.fillStyle = 'rgba(255,255,255,0.75)'; g.fillText(App.MG.fmt(Math.round(c.m)), cx, cy + r * 0.42);
            }
            g.restore();
          }
        }
      }
      function drawParticles() {
        for (var i = 0; i < particles.length; i++) {
          var p = particles[i];
          g.globalAlpha = Math.max(0, p.life);
          g.fillStyle = p.col;
          g.beginPath(); g.arc(sx(p.x), sy(p.y), p.r, 0, Math.PI * 2); g.fill();
        }
        g.globalAlpha = 1;
      }
      function drawPointer(me) {
        if (!me || !ptr.active) return;
        var cx = VW / 2, cy = VH / 2;
        g.save();
        g.strokeStyle = 'rgba(234,255,224,0.35)'; g.lineWidth = 2; g.setLineDash([8, 8]);
        g.beginPath(); g.moveTo(cx, cy); g.lineTo(ptr.x, ptr.y); g.stroke();
        g.setLineDash([]);
        g.strokeStyle = 'rgba(234,255,224,0.7)';
        g.beginPath(); g.arc(ptr.x, ptr.y, 9, 0, Math.PI * 2); g.stroke();
        g.restore();
      }
      function drawLeaderboard(cells) {
        var top = cells.slice().sort(function (a, b) { return b.m - a.m; }).slice(0, 5);
        var bw = 176, bh = 24 + top.length * 20, bx = VW - bw - 12, by = 12;
        g.save();
        g.fillStyle = 'rgba(4,16,10,0.72)'; roundRect(bx, by, bw, bh, 10); g.fill();
        g.strokeStyle = 'rgba(57,255,20,0.3)'; g.lineWidth = 1; roundRect(bx, by, bw, bh, 10); g.stroke();
        g.textAlign = 'left'; g.textBaseline = 'middle';
        g.font = '800 12px "Segoe UI",system-ui,Arial,sans-serif';
        g.fillStyle = '#ffd23f'; g.fillText('🏆 Rangliste', bx + 12, by + 13);
        g.font = '700 12px "Segoe UI",system-ui,Arial,sans-serif';
        for (var i = 0; i < top.length; i++) {
          var c = top[i], me = c.id === myId, yy = by + 30 + i * 20;
          g.fillStyle = me ? '#39ff14' : '#cfe4dc';
          var nm = c.name.length > 12 ? c.name.slice(0, 11) + '…' : c.name;
          g.fillText((i + 1) + '. ' + nm, bx + 12, yy);
          g.textAlign = 'right'; g.fillText(App.MG.fmt(Math.round(c.m)), bx + bw - 12, yy); g.textAlign = 'left';
        }
        g.restore();
      }
      function drawHurt(now) {
        var a = 0.4 * (hurtUntil - now) / 460;
        var rg = g.createRadialGradient(VW / 2, VH / 2, VH * 0.2, VW / 2, VH / 2, VH * 0.75);
        rg.addColorStop(0, 'rgba(255,77,109,0)'); rg.addColorStop(1, 'rgba(255,77,109,' + a.toFixed(3) + ')');
        g.fillStyle = rg; g.fillRect(0, 0, VW, VH);
      }
      function drawWaiting() {
        if (!g) return;
        g.fillStyle = '#06180e'; g.fillRect(0, 0, VW, VH);
        g.fillStyle = '#9dff7a'; g.textAlign = 'center'; g.textBaseline = 'middle';
        g.font = '800 22px "Segoe UI",system-ui,Arial,sans-serif';
        g.fillText('Verbinde mit der Arena …', VW / 2, VH / 2);
      }

      function rankText(cells) {
        var mine = null, i;
        for (i = 0; i < cells.length; i++) if (cells[i].id === myId) mine = cells[i];
        if (!mine) return '–';
        var rank = 1;
        for (i = 0; i < cells.length; i++) if (cells[i].m > mine.m + 0.001) rank++;
        return '#' + rank + '/' + cells.length;
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
      function lighten(hex) { return mix(hex, '#ffffff', 0.35); }
      function darken(hex) { return mix(hex, '#000000', 0.4); }
      function mix(a, b, t) {
        var ca = hx(a), cb = hx(b);
        var r = Math.round(ca[0] + (cb[0] - ca[0]) * t);
        var gg = Math.round(ca[1] + (cb[1] - ca[1]) * t);
        var bl = Math.round(ca[2] + (cb[2] - ca[2]) * t);
        return 'rgb(' + r + ',' + gg + ',' + bl + ')';
      }
      function hx(h) { h = h.replace('#', ''); return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]; }

      /* ================================================================ *
       *  UI-Aufbau + Eingabe
       * ================================================================ */
      function buildStage() {
        massEl = el('div', { class: 'agr-stat-v agr-mass' }, ['22']);
        rankEl = el('div', { class: 'agr-stat-v agr-rank' }, ['#1']);
        timerEl = el('div', { class: 'mg-timer agr-timer' }, [App.MG.mmss(MATCH_TIME)]);
        var head = el('div', { class: 'agr-head glass' }, [
          el('div', { class: 'agr-stat' }, [el('span', { class: 'agr-stat-l' }, ['Masse']), massEl]),
          el('div', { class: 'agr-stat agr-stat-mid' }, [el('span', { class: 'agr-stat-l' }, ['Platz']), rankEl]),
          el('div', { class: 'agr-stat agr-stat-r' }, [el('span', { class: 'agr-stat-l' }, ['Zeit']), timerEl])
        ]);

        canvas = el('canvas', { class: 'agr-canvas', width: VW, height: VH });
        var stage = el('div', { class: 'agr-stage' }, [canvas]);
        var hint = el('div', { class: 'agr-hint hint-text' }, [
          '🎯 Beweg dich Richtung Zeiger/Finger · friss Pellets & kleinere Zellen · flieh vor größeren'
        ]);
        root.innerHTML = '';
        root.appendChild(el('div', { class: 'agr-wrap' }, [head, stage, hint]));
        g = canvas.getContext('2d');
      }

      function setupInput() {
        removeListeners();
        keyU = keyD = keyL = keyR = false;
        ptr.active = false;

        function setPtr(e) {
          var r = canvas.getBoundingClientRect();
          ptr.x = (e.clientX - r.left) / r.width * VW;
          ptr.y = (e.clientY - r.top) / r.height * VH;
        }
        addL(canvas, 'pointerdown', function (e) { e.preventDefault(); ptr.active = true; setPtr(e); try { canvas.setPointerCapture(e.pointerId); } catch (er) {} }, { passive: false });
        addL(canvas, 'pointermove', function (e) { setPtr(e); if (e.pointerType === 'mouse') ptr.active = true; }, { passive: false });
        addL(canvas, 'pointerup', function (e) { if (e.pointerType !== 'mouse') ptr.active = false; });
        addL(canvas, 'pointercancel', function () { ptr.active = false; });
        addL(canvas, 'pointerleave', function (e) { if (e.pointerType === 'mouse') ptr.active = false; });

        addL(document, 'keydown', function (e) {
          var k = e.key;
          if (k === 'ArrowUp' || k === 'w' || k === 'W') { keyU = true; e.preventDefault(); }
          else if (k === 'ArrowDown' || k === 's' || k === 'S') { keyD = true; e.preventDefault(); }
          else if (k === 'ArrowLeft' || k === 'a' || k === 'A') { keyL = true; e.preventDefault(); }
          else if (k === 'ArrowRight' || k === 'd' || k === 'D') { keyR = true; e.preventDefault(); }
        });
        addL(document, 'keyup', function (e) {
          var k = e.key;
          if (k === 'ArrowUp' || k === 'w' || k === 'W') keyU = false;
          else if (k === 'ArrowDown' || k === 's' || k === 'S') keyD = false;
          else if (k === 'ArrowLeft' || k === 'a' || k === 'A') keyL = false;
          else if (k === 'ArrowRight' || k === 'd' || k === 'D') keyR = false;
        });
      }

      /* ================================================================ *
       *  Ende
       * ================================================================ */
      function finish() {
        if (finished || dead) return;
        finished = true;
        if (raf) { cancelAnimationFrame(raf); raf = null; }
        stopHelpers(); removeListeners(); clearTimers();

        if (isMulti) {
          try { ctx.room.reportScore(Math.round(myMass)); } catch (e) {}
          after(700, function () {
            App.MG.endScreen(root, { players: ctx.room.players(), meId: ctx.me.id, onExit: ctx.onExit });
          });
        } else {
          var score = Math.round(myMass);
          var rank = soloRank();
          var best = App.Storage.get('best_agar', 0);
          var nb = score > best;
          if (nb) App.Storage.set('best_agar', score);
          App.MG.endScreen(root, {
            score: score, best: best, newBest: nb,
            label: 'Platz ' + rank.place + ' von ' + rank.total + ' · Masse' + (nb ? ' · neuer Rekord! 🎉' : ' · Bestwert: ' + App.MG.fmt(best)),
            onExit: ctx.onExit,
            onAgain: function () { play(nowFn()); }
          });
        }
      }

      function soloRank() {
        var me = cellById(myId), place = 1, i, total = sim ? sim.cells.length : 1;
        if (sim && me) for (i = 0; i < sim.cells.length; i++) if (sim.cells[i].m > me.m + 0.001) place++;
        return { place: place, total: total };
      }
    }
  };

  /* ================================================================ *
   *  STYLES
   * ================================================================ */
  function injectStyle() {
    UI.injectStyle('mg-agar-css', [
      '.agr-wrap{display:flex;flex-direction:column;gap:12px;align-items:stretch;}',
      '.agr-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 18px;}',
      '.agr-stat{display:flex;flex-direction:column;gap:1px;min-width:0;}',
      '.agr-stat-mid{text-align:center;}',
      '.agr-stat-r{text-align:right;}',
      '.agr-stat-l{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:1px;}',
      '.agr-stat-v{font-size:clamp(20px,5.4vw,34px);font-weight:900;line-height:1;font-variant-numeric:tabular-nums;}',
      '.agr-mass{color:var(--neon);text-shadow:0 0 12px rgba(57,255,20,.5);}',
      '.agr-rank{color:var(--aqua);text-shadow:0 0 12px rgba(51,230,208,.45);}',
      '.agr-head .mg-timer{font-size:clamp(18px,5vw,26px);color:var(--gold);}',
      '.mg-timer.agr-urgent{color:var(--danger);animation:agr-pulse .7s infinite;}',
      '.agr-stage{width:100%;max-width:900px;margin:0 auto;aspect-ratio:960 / 640;position:relative;}',
      '.agr-canvas{display:block;width:100%;height:100%;border-radius:16px;',
      'border:2px solid rgba(57,255,20,.32);background:#04140c;',
      'box-shadow:0 0 42px rgba(57,255,20,.2),inset 0 0 60px rgba(57,255,20,.05);',
      'touch-action:none;user-select:none;-webkit-user-select:none;-webkit-tap-highlight-color:transparent;cursor:crosshair;}',
      '.agr-hint{text-align:center;}',
      '@keyframes agr-pulse{0%,100%{opacity:1}50%{opacity:.4}}'
    ].join(''));
  }
})();
