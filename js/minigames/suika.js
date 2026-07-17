/* suika.js — "Frucht-Merge" (Suika / Wassermelonen-Spiel) im Neon-Dschungel-Look.
 *
 * IDEE:      In einem Behälter fallen Früchte von oben herein. Zwei GLEICHE
 *            Früchte, die sich berühren, verschmelzen zur nächstgrößeren und
 *            geben Punkte. Ziel: die große Wassermelone bauen. Stapelt es über
 *            die rote Linie und bleibt dort liegen -> Behälter voll = Ende.
 *
 * STEUERUNG: Über der Fläche schwebt die aktuelle Frucht. Finger/Maus über die
 *            Fläche ziehen zum Zielen (die Frucht folgt), loslassen/tippen lässt
 *            sie fallen. Zusätzlich: Pfeil ← → bewegen, Leertaste/↓ = fallen.
 *            Eine Vorschau zeigt die nächste Frucht.
 *
 * PUNKTE:    Beim Verschmelzen gibt es Punkte je nach entstandener Frucht
 *            (1,3,6,10,15,21,28,36,45). Zwei Wassermelonen lösen sich mit
 *            Bonus (+100) auf. Schnelle Ketten geben kleinen Zusatz.
 *
 * SYNC-MODELL:
 *   SOLO   — endloses Punktejagen gegen den eigenen Rekord (best_suika).
 *   MULTI  — jeder spielt sein EIGENES Brett, aber alle bekommen aus dem
 *            geteilten Rundenstart (snapshot().round.startAt) denselben Seed,
 *            also exakt die GLEICHE Frucht-Reihenfolge -> fair. 2 Minuten,
 *            wer die meisten Punkte hat, gewinnt (reportScore + Live-Rangliste).
 *            Die Physik läuft rein lokal (jedes Brett unabhängig); nur der
 *            Rundentimer läuft synchron über room.now().
 *
 * cleanup() stoppt wirklich alles: rAF, Timeouts, Timer, Listener, room.off.
 */
(function () {
  'use strict';
  window.App = window.App || {}; App.Minigames = App.Minigames || {};
  var UI = App.UI, el = UI.el;

  injectStyle();

  /* ---- Virtuelles Spielfeld (Canvas-Pixel = Feldkoordinaten, CSS skaliert) ---- */
  var FW = 340, FH = 460;      // Feldgröße
  var DROP_Y = 44;             // Höhe, in der die gehaltene Frucht schwebt
  var DEAD_Y = 92;             // Game-Over-Linie (Oberkante-Test)
  var PI2 = Math.PI * 2;

  /* ---- Physik-Konstanten ---- */
  var GRAV = 1500;             // px/s^2
  var REST = 0.08;            // Restitution zwischen Früchten (kaum Sprung)
  var WALL_E = 0.16;          // Wand-Restitution
  var FLOOR_FR = 0.82;        // horizontale Dämpfung bei Bodenkontakt
  var CORR = 0.82;           // Positions-Korrektur-Anteil (gegen Zittern)
  var FIXED = 1 / 120;        // fester Physik-Schritt
  var MAX_STEPS = 5;          // max. Physik-Schritte pro Frame (Anti-Spirale)
  var ITER = 4;               // Kollisions-Iterationen pro Schritt
  var MAXV = 2600;            // Geschwindigkeits-Deckel
  var DROP_COOLDOWN = 460;    // ms bis zur nächsten Frucht
  var OVER_LIMIT = 1.6;       // s, die eine Frucht über der Linie ruhen darf
  var MATCH_TIME = 120;       // s Rundenzeit im Multiplayer
  var BONUS_MAX = 100;        // Bonus, wenn zwei Wassermelonen verschmelzen

  /* ---- Früchte-Kette (Emoji, Radius, Farbe, Name) ---- */
  var TIERS = [
    { e: '🍒', r: 12, c: '#ff5670', n: 'Kirsche' },
    { e: '🍓', r: 17, c: '#ff7d97', n: 'Erdbeere' },
    { e: '🍇', r: 23, c: '#9a6bff', n: 'Traube' },
    { e: '🍊', r: 29, c: '#ffab3d', n: 'Mandarine' },
    { e: '🍋', r: 36, c: '#ffe23f', n: 'Zitrone' },
    { e: '🍎', r: 44, c: '#ff4d4d', n: 'Apfel' },
    { e: '🍐', r: 53, c: '#b6ff5a', n: 'Birne' },
    { e: '🍑', r: 63, c: '#ffb3c1', n: 'Pfirsich' },
    { e: '🍈', r: 74, c: '#7dff6b', n: 'Honigmelone' },
    { e: '🍉', r: 86, c: '#39ff14', n: 'Wassermelone' }
  ];
  var MAXTIER = TIERS.length - 1;
  var POINTS = [0, 1, 3, 6, 10, 15, 21, 28, 36, 45, 55]; // POINTS[entstandene Stufe]
  var DROP_MAX = 4;           // gespawnt werden nur Stufen 0..4

  /* ---- Seeded PRNG (mulberry32) -> gleiche Frucht-Reihenfolge im Multi ---- */
  function makeRng(seed) {
    var s = (seed >>> 0) || 1;
    return function () {
      s = (s + 0x6D2B79F5) | 0;
      var t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  /* Gewichtete Wahl der Fall-Frucht (kleine Früchte häufiger). */
  function pickDropTier(rng) {
    var w = [30, 26, 22, 14, 8], x = rng() * 100, a = 0, i;
    for (i = 0; i < w.length; i++) { a += w[i]; if (x < a) return i; }
    return 0;
  }

  App.Minigames.suika = {
    id: 'suika', title: 'Frucht-Merge', icon: '🍉', order: 142,
    subtitle: 'Stapeln, verschmelzen, Wassermelone bauen!',
    single: true, multi: true, minPlayers: 2, maxPlayers: 8,

    render: function (root, ctx) {
      var isMulti = ctx.mode === 'multi';
      var perf = (window.performance && performance.now)
        ? function () { return performance.now(); }
        : function () { return Date.now(); };

      /* ---- Aufräum-/Laufzeit-Zustand ---- */
      var dead = false;        // endgültig (cleanup) -> nichts mehr tun
      var finished = false;    // aktuelle Runde beendet (Endscreen sichtbar)
      var rafId = null;
      var timers = [];         // setTimeout-IDs
      var stops = [];          // stop()-Funktionen (roundTimer/liveBoard)
      var listeners = [];      // {t,ty,fn,opts}

      /* ---- Spielzustand (pro play() frisch) ---- */
      var rng = null;
      var fruits = [];
      var score = 0, chain = 0, lastMergeAt = 0;
      var heldTier = 0, nextTier = 0, heldX = FW / 2;
      var canDrop = true, dropCount = 0;
      var overTime = 0, playing = false;
      var acc = 0, lastFrame = 0;

      /* ---- Partikel (rein kosmetisch, Wall-Clock-gesteuert) ---- */
      var rings = [], pops = [];

      /* ---- DOM ---- */
      var canvas = null, g = null, scoreEl = null, nextEl = null, rightEl = null, overlay = null, stageEl = null;

      /* ---- kleine Helfer ---- */
      function after(ms, fn) { var t = setTimeout(function () { if (!dead) fn(); }, ms); timers.push(t); return t; }
      function clearTimers() { timers.forEach(clearTimeout); timers = []; }
      function addL(target, type, fn, opts) { target.addEventListener(type, fn, opts); listeners.push({ t: target, ty: type, fn: fn, opts: opts }); }
      function removeListeners() { listeners.forEach(function (l) { try { l.t.removeEventListener(l.ty, l.fn, l.opts); } catch (e) {} }); listeners = []; }
      function stopHelpers() { stops.forEach(function (f) { try { f(); } catch (e) {} }); stops = []; }
      function cancelRaf() { if (rafId) { cancelAnimationFrame(rafId); rafId = null; } }
      function cleanup() { dead = true; playing = false; cancelRaf(); clearTimers(); stopHelpers(); removeListeners(); }
      function sfx(name) { if (App.Audio) App.Audio.sfx(name); }
      function blip(f, d, o) { if (App.Audio && App.Audio.blip) App.Audio.blip(f, d, o); }

      /* ================= Start ================= */
      if (isMulti) {
        var snap = ctx.room.snapshot() || {};
        var startAt = (snap.round && snap.round.startAt) || (ctx.room.now() + 3000);
        stops.push(App.MG.countdown(root, startAt, function () { play(startAt); }, ctx.room.now));
      } else {
        play(Date.now());
      }
      return { cleanup: cleanup };

      /* ================= Eine Partie aufbauen ================= */
      function play(seed) {
        // evtl. laufende Runde abräumen (Solo-"Nochmal")
        finished = false; playing = true;
        cancelRaf(); clearTimers(); stopHelpers(); removeListeners();

        rng = makeRng(seed || 1);
        fruits = []; rings = []; pops = [];
        score = 0; chain = 0; lastMergeAt = 0; overTime = 0;
        heldTier = pickDropTier(rng); nextTier = pickDropTier(rng);
        heldX = FW / 2; canDrop = true; dropCount = 0;
        acc = 0; lastFrame = perf();

        buildLayout();
        attachInput();

        if (isMulti) {
          // Live-Rangliste
          var board = App.MG.liveBoard(ctx.room, ctx.me.id);
          stops.push(board.stop);
          root.querySelector('.mrg-board-slot').appendChild(board.root);
          ctx.room.reportScore(0);
          // Synchroner Rundentimer (2 Minuten)
          var endAt = (seed || ctx.room.now()) + MATCH_TIME * 1000;
          stops.push(App.MG.roundTimer(endAt, function (left) {
            if (!rightEl) return;
            rightEl.textContent = App.MG.mmss(left);
            rightEl.classList.toggle('mrg-urgent', left <= 10);
          }, function () { finish('time'); }, ctx.room.now));
        }

        rafId = requestAnimationFrame(frame);
      }

      /* ================= Layout ================= */
      function buildLayout() {
        scoreEl = el('div', { class: 'mrg-score' }, ['0']);
        nextEl = el('div', { class: 'mrg-next-badge' }, [TIERS[nextTier].e]);
        rightEl = el('div', { class: 'mrg-timer' }, [isMulti ? App.MG.mmss(MATCH_TIME) : App.MG.fmt(App.Storage.get('best_suika', 0))]);

        var head = el('div', { class: 'mrg-head glass' }, [
          el('div', { class: 'mrg-hcell' }, [el('span', { class: 'mrg-hl' }, ['Punkte']), scoreEl]),
          el('div', { class: 'mrg-hcell mrg-hnext' }, [el('span', { class: 'mrg-hl' }, ['Nächste']), nextEl]),
          el('div', { class: 'mrg-hcell mrg-hright' }, [el('span', { class: 'mrg-hl' }, [isMulti ? 'Zeit' : 'Rekord']), rightEl])
        ]);

        canvas = el('canvas', { class: 'mrg-canvas', width: FW, height: FH });
        overlay = el('div', { class: 'mrg-over', style: 'display:none;' });
        stageEl = el('div', { class: 'mrg-stage' }, [canvas, overlay]);

        var hint = el('div', { class: 'mrg-hint hint-text' }, [
          'Ziehen zum Zielen · loslassen zum Fallenlassen · gleiche Früchte verschmelzen 🍒→🍓→🍇→…→🍉'
        ]);

        var children = [head, stageEl, hint];
        if (isMulti) {
          children.push(el('div', { class: 'mrg-board-wrap glass' }, [
            el('div', { class: 'mg-field-title' }, ['🏆 Rangliste']),
            el('div', { class: 'mrg-board-slot' })
          ]));
        }

        root.innerHTML = '';
        root.appendChild(el('div', { class: 'mrg-wrap' }, children));
        g = canvas.getContext('2d');
      }

      /* ================= Eingabe ================= */
      function clientToX(clientX) {
        var rct = canvas.getBoundingClientRect();
        if (!rct.width) return heldX;
        return (clientX - rct.left) / rct.width * FW;
      }
      function aimTo(clientX) {
        var r = TIERS[heldTier].r;
        var x = clientToX(clientX);
        heldX = Math.max(r + 2, Math.min(FW - r - 2, x));
      }
      function attachInput() {
        var pressed = false;
        var onDown = function (e) {
          if (!playing || finished || dead) return;
          e.preventDefault();
          pressed = true;
          if (canvas.setPointerCapture && e.pointerId != null) { try { canvas.setPointerCapture(e.pointerId); } catch (er) {} }
          aimTo(e.clientX);
        };
        var onMove = function (e) {
          if (!playing || finished || dead) return;
          // Maus (Hover) zielt auch ohne Druck; Touch bewegt nur bei Kontakt
          if (e.pointerType === 'mouse' || pressed) aimTo(e.clientX);
        };
        var onUp = function (e) {
          if (!pressed) return;
          pressed = false;
          if (!playing || finished || dead) return;
          aimTo(e.clientX);
          doDrop();
        };
        addL(canvas, 'pointerdown', onDown);
        addL(canvas, 'pointermove', onMove);
        addL(canvas, 'pointerup', onUp);
        addL(canvas, 'pointercancel', function () { pressed = false; });

        var onKey = function (e) {
          if (!playing || finished || dead) return;
          var k = e.key, r = TIERS[heldTier].r, step = 22;
          if (k === 'ArrowLeft') { heldX = Math.max(r + 2, heldX - step); e.preventDefault(); }
          else if (k === 'ArrowRight') { heldX = Math.min(FW - r - 2, heldX + step); e.preventDefault(); }
          else if (k === ' ' || k === 'ArrowDown' || k === 'Enter') { doDrop(); e.preventDefault(); }
        };
        addL(document, 'keydown', onKey);
      }

      /* ================= Frucht fallen lassen ================= */
      function makeFruit(x, y, tier) {
        var r = TIERS[tier].r;
        return { x: x, y: y, vx: 0, vy: 0, tier: tier, r: r, m: r * r, age: 0, born: perf(), dead: false };
      }
      function doDrop() {
        if (!playing || finished || dead || !canDrop) return;
        var f = makeFruit(heldX, DROP_Y, heldTier);
        f.vy = 30;
        fruits.push(f);
        sfx('tick');
        blip(180 + heldTier * 26, 0.05, { type: 'sine', peak: 0.05 });
        canDrop = false; dropCount++;
        heldTier = nextTier;
        nextTier = pickDropTier(rng);
        if (nextEl) nextEl.textContent = TIERS[nextTier].e;
        after(DROP_COOLDOWN, function () { if (playing && !finished) canDrop = true; });
      }

      /* ================= Physik ================= */
      function stepPhysics(h) {
        var i, j, f, n = fruits.length;
        // 1) Integration
        for (i = 0; i < n; i++) {
          f = fruits[i];
          f.vy += GRAV * h;
          f.vx *= 0.995;
          var sp2 = f.vx * f.vx + f.vy * f.vy;
          if (sp2 > MAXV * MAXV) { var sc = MAXV / Math.sqrt(sp2); f.vx *= sc; f.vy *= sc; }
          f.x += f.vx * h; f.y += f.vy * h;
          f.age += h;
          if (!isFinite(f.x) || !isFinite(f.y)) { f.x = FW / 2; f.y = FH / 2; f.vx = 0; f.vy = 0; }
        }
        // 2) Verschmelzen (auf den integrierten Positionen)
        doMerges(n);
        // 3) Kollisions-Iterationen (Wände + Paare)
        var it, k, a, b;
        for (it = 0; it < ITER; it++) {
          for (k = 0; k < fruits.length; k++) {
            f = fruits[k];
            if (f.x < f.r) { f.x = f.r; if (f.vx < 0) f.vx = -f.vx * WALL_E; }
            else if (f.x > FW - f.r) { f.x = FW - f.r; if (f.vx > 0) f.vx = -f.vx * WALL_E; }
            if (f.y > FH - f.r) { f.y = FH - f.r; if (f.vy > 0) { f.vy = -f.vy * WALL_E; f.vx *= FLOOR_FR; } }
          }
          for (i = 0; i < fruits.length; i++) {
            a = fruits[i];
            for (j = i + 1; j < fruits.length; j++) {
              b = fruits[j];
              resolve(a, b);
            }
          }
        }
      }
      function doMerges(n) {
        var i, j, a, b, dx, dy, rr, merged = false;
        for (i = 0; i < n; i++) {
          a = fruits[i]; if (a.dead) continue;
          for (j = i + 1; j < n; j++) {
            b = fruits[j]; if (b.dead || b.tier !== a.tier) continue;
            dx = b.x - a.x; dy = b.y - a.y; rr = a.r + b.r;
            if (dx * dx + dy * dy <= rr * rr * 0.94) { mergePair(a, b); merged = true; break; }
          }
        }
        if (merged) {
          var out = [], k;
          for (k = 0; k < fruits.length; k++) { if (!fruits[k].dead) out.push(fruits[k]); }
          fruits = out;
        }
      }
      function mergePair(a, b) {
        a.dead = true; b.dead = true;
        var t = a.tier;
        var tot = a.m + b.m;
        var mx = (a.x * a.m + b.x * b.m) / tot;
        var my = (a.y * a.m + b.y * b.m) / tot;

        // Kette: schnelle Folge-Merges geben kleinen Bonus
        var now = perf();
        chain = (now - lastMergeAt < 800) ? chain + 1 : 1;
        lastMergeAt = now;

        if (t >= MAXTIER) {
          // Zwei Wassermelonen -> lösen sich mit Bonus auf
          addScore(BONUS_MAX);
          addRing(mx, my, TIERS[t].r * 1.5, '#ffe23f');
          addRing(mx, my, TIERS[t].r, TIERS[t].c);
          addPop(mx, my, '+' + BONUS_MAX, '#ffe23f');
          sfx('explosion'); sfx('jackpot');
          return;
        }
        var nt = t + 1;
        var pts = POINTS[nt] + (chain > 1 ? (chain - 1) * 2 : 0);
        var nf = makeFruit(mx, my, nt);
        nf.vx = (a.vx + b.vx) * 0.5;
        nf.vy = (a.vy + b.vy) * 0.5 - 46;   // kleiner Pop nach oben
        fruits.push(nf);
        addScore(pts);
        addRing(mx, my, TIERS[nt].r, TIERS[nt].c);
        addPop(mx, my, '+' + pts + (chain > 1 ? '  Kette x' + chain : ''), TIERS[nt].c);
        sfx('pop');
        blip(240 + nt * 48, 0.11, { type: 'triangle', peak: 0.07 });
        if (nt >= 7) sfx('powerup');
        if (nt === MAXTIER) { sfx('jackpot'); addRing(mx, my, TIERS[nt].r * 1.6, '#ffe23f'); }
      }
      function resolve(a, b) {
        var dx = b.x - a.x, dy = b.y - a.y, minD = a.r + b.r;
        var d2 = dx * dx + dy * dy;
        if (d2 >= minD * minD) return;
        var d = Math.sqrt(d2), nx, ny;
        if (d < 0.0001) { nx = (Math.random() - 0.5); ny = -1; var ln = Math.sqrt(nx * nx + ny * ny) || 1; nx /= ln; ny /= ln; d = 0.01; }
        else { nx = dx / d; ny = dy / d; }
        var pen = minD - d;
        var im = 1 / a.m + 1 / b.m;
        var corr = pen / im * CORR;
        a.x -= nx * corr / a.m; a.y -= ny * corr / a.m;
        b.x += nx * corr / b.m; b.y += ny * corr / b.m;
        var rvx = b.vx - a.vx, rvy = b.vy - a.vy;
        var vn = rvx * nx + rvy * ny;
        if (vn < 0) {
          var jn = -(1 + REST) * vn / im;
          a.vx -= jn * nx / a.m; a.vy -= jn * ny / a.m;
          b.vx += jn * nx / b.m; b.vy += jn * ny / b.m;
        }
      }

      /* ================= Score / Partikel ================= */
      function addScore(p) {
        score += p;
        if (scoreEl) {
          scoreEl.textContent = App.MG.fmt(score);
          scoreEl.classList.remove('mrg-bump'); void scoreEl.offsetWidth; scoreEl.classList.add('mrg-bump');
        }
        if (isMulti) { try { ctx.room.reportScore(score); } catch (e) {} }
      }
      function addRing(x, y, r, c) { rings.push({ x: x, y: y, r: r, c: c, born: perf() }); }
      function addPop(x, y, txt, c) { pops.push({ x: x, y: y, t: txt, c: c, born: perf() }); }

      /* ================= Überlauf-Prüfung (Game Over) ================= */
      function checkOverflow(dt) {
        var danger = false, i, f;
        for (i = 0; i < fruits.length; i++) {
          f = fruits[i];
          if (f.age < 0.6) continue;                       // frisch gefallene ignorieren
          if ((f.y - f.r) >= DEAD_Y) continue;             // Oberkante unter der Linie -> ok
          if (f.vx * f.vx + f.vy * f.vy > 24 * 24) continue; // noch in Bewegung -> ok
          danger = true; break;
        }
        if (danger) overTime += dt; else overTime = Math.max(0, overTime - dt * 1.6);
        if (overTime > OVER_LIMIT) finish('over');
      }

      /* ================= Frame-Schleife ================= */
      function frame() {
        if (dead || finished || !playing) { rafId = null; return; }
        var now = perf();
        var dt = (now - lastFrame) / 1000; lastFrame = now;
        if (dt < 0) dt = 0; if (dt > 0.05) dt = 0.05;   // Tab-Wechsel abfedern

        acc += dt;
        var steps = 0;
        while (acc >= FIXED && steps < MAX_STEPS) { stepPhysics(FIXED); acc -= FIXED; steps++; }
        if (steps >= MAX_STEPS) acc = 0;

        checkOverflow(dt);
        drawScene(now);

        if (!finished) rafId = requestAnimationFrame(frame);
        else rafId = null;
      }

      /* ================= Zeichnen ================= */
      function drawScene(now) {
        if (!g) return;
        // Hintergrund
        var grd = g.createLinearGradient(0, 0, 0, FH);
        grd.addColorStop(0, '#06180e'); grd.addColorStop(1, '#03100a');
        g.fillStyle = grd; g.fillRect(0, 0, FW, FH);
        // Rahmen
        g.save(); g.strokeStyle = 'rgba(57,255,20,0.22)'; g.lineWidth = 4;
        roundRect(g, 4, 4, FW - 8, FH - 8, 18); g.stroke(); g.restore();

        // Früchte
        var i;
        for (i = 0; i < fruits.length; i++) drawFruit(g, fruits[i], 1, now);

        // Ringe (Merge-Blitze)
        for (i = 0; i < rings.length; i++) {
          var rg = rings[i], ra = (now - rg.born) / 420;
          if (ra >= 1) continue;
          g.save(); g.globalAlpha = (1 - ra) * 0.8; g.strokeStyle = rg.c; g.lineWidth = 3;
          g.beginPath(); g.arc(rg.x, rg.y, rg.r * (0.6 + ra * 0.9), 0, PI2); g.stroke(); g.restore();
        }
        rings = rings.filter(function (r) { return (now - r.born) < 420; });

        // Punkte-Pops
        for (i = 0; i < pops.length; i++) {
          var pp = pops[i], pa = (now - pp.born) / 780;
          if (pa >= 1) continue;
          g.save(); g.globalAlpha = 1 - pa;
          g.font = '900 17px "Segoe UI",system-ui,Roboto,Arial,sans-serif';
          g.textAlign = 'center'; g.textBaseline = 'middle';
          g.fillStyle = pp.c; g.shadowColor = pp.c; g.shadowBlur = 10;
          g.fillText(pp.t, pp.x, pp.y - pa * 30); g.restore();
        }
        pops = pops.filter(function (p) { return (now - p.born) < 780; });

        // Game-Over-Linie (pulsiert rot bei Gefahr)
        var danger = overTime > 0.01;
        var pulse = 0.45 + 0.55 * Math.abs(Math.sin(now / 170));
        g.save();
        g.strokeStyle = danger ? 'rgba(255,77,109,' + pulse.toFixed(2) + ')' : 'rgba(51,230,208,0.35)';
        g.lineWidth = danger ? 3 : 2; g.setLineDash([10, 10]);
        g.beginPath(); g.moveTo(10, DEAD_Y); g.lineTo(FW - 10, DEAD_Y); g.stroke();
        g.restore();

        // Gehaltene Frucht + Zielhilfe
        if (playing && !finished && canDrop) {
          var r = TIERS[heldTier].r;
          g.save(); g.strokeStyle = 'rgba(234,255,224,0.25)'; g.lineWidth = 2; g.setLineDash([6, 10]);
          g.beginPath(); g.moveTo(heldX, DROP_Y + r); g.lineTo(heldX, FH - 6); g.stroke(); g.restore();
          var bob = 1 + 0.04 * Math.sin(now / 300);
          drawFruit(g, { x: heldX, y: DROP_Y, r: r * bob, tier: heldTier }, 1, now);
        }
      }
      function drawFruit(g2, f, alpha, now) {
        var t = TIERS[f.tier], r = f.r;
        g2.save();
        g2.globalAlpha = alpha;
        // Körper + Glow
        g2.shadowColor = t.c; g2.shadowBlur = 12; g2.fillStyle = t.c;
        g2.beginPath(); g2.arc(f.x, f.y, r, 0, PI2); g2.fill();
        g2.shadowBlur = 0;
        // Glanzlicht oben-links
        g2.globalAlpha = alpha * 0.5; g2.fillStyle = 'rgba(255,255,255,0.9)';
        g2.save(); g2.translate(f.x - r * 0.32, f.y - r * 0.36); g2.rotate(-0.6); g2.scale(1, 0.6);
        g2.beginPath(); g2.arc(0, 0, r * 0.32, 0, PI2); g2.fill(); g2.restore();
        // Emoji
        g2.globalAlpha = alpha;
        g2.font = (r * 1.35 | 0) + 'px serif';
        g2.textAlign = 'center'; g2.textBaseline = 'middle';
        g2.fillText(t.e, f.x, f.y + r * 0.06);
        g2.restore();
      }
      function roundRect(g2, x, y, w, h, rad) {
        rad = Math.min(rad, w / 2, h / 2);
        g2.beginPath();
        g2.moveTo(x + rad, y);
        g2.arcTo(x + w, y, x + w, y + h, rad);
        g2.arcTo(x + w, y + h, x, y + h, rad);
        g2.arcTo(x, y + h, x, y, rad);
        g2.arcTo(x, y, x + w, y, rad);
        g2.closePath();
      }

      /* ================= Partie-Ende ================= */
      function finish(reason) {
        if (finished || dead) return;
        finished = true; playing = false; canDrop = false;
        cancelRaf();
        clearTimers();

        if (reason === 'over') sfx('bust'); else sfx('ding');

        if (isMulti) {
          try { ctx.room.reportScore(score); } catch (e) {}
          // Bei Überlauf vor Zeit-Ende: bis zum Rundenende auf die Anderen warten.
          if (reason === 'over') {
            showOverlay();
            // stops enthält den Rundentimer -> ruft finish('time') am Ende; dort
            // ist finished bereits true, also zeigen wir das Endergebnis selbst:
            return;
          }
          stopHelpers();
          after(500, function () {
            if (dead) return;
            App.MG.endScreen(root, { players: ctx.room.players(), meId: ctx.me.id, onExit: ctx.onExit });
          });
        } else {
          stopHelpers();
          var best = App.Storage.get('best_suika', 0);
          var nb = score > best;
          if (nb) App.Storage.set('best_suika', score);
          after(reason === 'over' ? 700 : 300, function () {
            if (dead) return;
            App.MG.endScreen(root, {
              score: score, best: best, newBest: nb,
              label: 'Frucht-Punkte' + (nb ? ' · neuer Rekord! 🎉' : ' · Bestwert: ' + App.MG.fmt(best)),
              onExit: ctx.onExit,
              onAgain: function () { play(Date.now()); }
            });
          });
        }
      }

      /* Wartescreen im Multi, wenn der Behälter vor Zeit-Ende voll ist. */
      function showOverlay() {
        if (!overlay) return;
        overlay.innerHTML = '';
        overlay.appendChild(el('div', { class: 'mrg-over-emoji' }, ['🧺']));
        overlay.appendChild(el('div', { class: 'mrg-over-h' }, ['Behälter voll!']));
        overlay.appendChild(el('div', { class: 'mrg-over-sub' }, [App.MG.fmt(score) + ' Punkte · warte aufs Rundenende …']));
        overlay.style.display = 'flex';

        // Eigenen Rundentimer weiterlaufen lassen und am Ende das Endergebnis zeigen.
        var endAt = ctx.room.now() + Math.max(0, (function () {
          var sn = ctx.room.snapshot() || {};
          var st = (sn.round && sn.round.startAt) || ctx.room.now();
          return (st + MATCH_TIME * 1000) - ctx.room.now();
        })());
        stops.push(App.MG.roundTimer(endAt, function () {}, function () {
          stopHelpers();
          if (dead) return;
          App.MG.endScreen(root, { players: ctx.room.players(), meId: ctx.me.id, onExit: ctx.onExit });
        }, ctx.room.now));
      }
    }
  };

  /* ===================== STYLES ===================== */
  function injectStyle() {
    UI.injectStyle('mg-suika-css', [
      '.mrg-wrap{display:flex;flex-direction:column;gap:12px;align-items:stretch;max-width:520px;margin:0 auto;}',
      '.mrg-head{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:9px 16px;}',
      '.mrg-hcell{display:flex;flex-direction:column;gap:1px;min-width:0;}',
      '.mrg-hnext{align-items:center;text-align:center;}',
      '.mrg-hright{align-items:flex-end;text-align:right;}',
      '.mrg-hl{color:var(--muted);font-size:10px;text-transform:uppercase;letter-spacing:1px;font-weight:800;}',
      '.mrg-score{font-size:clamp(24px,6.5vw,38px);font-weight:900;color:var(--gold);text-shadow:0 0 12px rgba(255,210,63,.45);line-height:1;font-variant-numeric:tabular-nums;}',
      '.mrg-score.mrg-bump{animation:mrg-bump .3s ease;}',
      '.mrg-next-badge{width:42px;height:42px;border-radius:12px;display:flex;align-items:center;justify-content:center;font-size:26px;line-height:1;background:rgba(4,16,10,.7);border:1px solid var(--stroke-2);box-shadow:inset 0 0 14px rgba(57,255,20,.1);}',
      '.mrg-timer{font-size:clamp(20px,5.5vw,30px);font-weight:900;color:var(--aqua);text-shadow:0 0 12px rgba(51,230,208,.4);line-height:1;font-variant-numeric:tabular-nums;}',
      '.mrg-timer.mrg-urgent{color:var(--danger-2);animation:mrg-pulse .7s infinite;}',
      /* Spielfläche: Höhe über die Breite gedeckelt, damit alles ohne Scrollen passt */
      '.mrg-stage{position:relative;width:100%;max-width:min(340px,92vw,43vh);margin:0 auto;}',
      '.mrg-canvas{display:block;width:100%;height:auto;border-radius:16px;',
      'border:2px solid rgba(57,255,20,.35);background:#04140c;',
      'box-shadow:0 0 40px rgba(57,255,20,.2),inset 0 0 50px rgba(57,255,20,.06);',
      'touch-action:none;user-select:none;-webkit-user-select:none;-webkit-tap-highlight-color:transparent;cursor:pointer;}',
      '.mrg-over{position:absolute;inset:0;border-radius:16px;background:rgba(3,12,7,.82);',
      'display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;text-align:center;padding:20px;animation:mrg-fade .3s ease;}',
      '.mrg-over-emoji{font-size:52px;filter:drop-shadow(0 0 14px rgba(255,77,109,.5));animation:mrg-bob 1.6s ease-in-out infinite;}',
      '.mrg-over-h{font-size:24px;font-weight:900;color:var(--danger);text-shadow:0 0 12px rgba(255,77,109,.5);}',
      '.mrg-over-sub{font-size:14px;color:var(--leaf);font-weight:700;}',
      '.mrg-hint{text-align:center;line-height:1.5;}',
      '.mrg-board-wrap{padding:12px 14px;display:flex;flex-direction:column;gap:8px;}',
      '.mrg-board-wrap .mg-scoreboard{max-height:240px;overflow-y:auto;}',
      '@keyframes mrg-bump{0%{transform:scale(1)}40%{transform:scale(1.22)}100%{transform:scale(1)}}',
      '@keyframes mrg-pulse{0%,100%{opacity:1}50%{opacity:.4}}',
      '@keyframes mrg-bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-8px)}}',
      '@keyframes mrg-fade{from{opacity:0}to{opacity:1}}'
    ].join(''));
  }
})();
