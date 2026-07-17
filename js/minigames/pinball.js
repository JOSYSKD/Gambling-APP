/* pinball.js — "Neon-Flipper": ein echter Flippertisch (hochkant) im Neon-Dschungel.
 *
 * IDEE
 *   Ein Ball, Schwerkraft, harte Abpraller. Oben drei Pop-Bumper, in der Mitte eine
 *   Bank aus 4 Drop-Targets, links/rechts zwei Orbit-Rampen, dazu Slingshots, Posts
 *   und zwei Flipper unten. Faellt der Ball zwischen den Flippern durch, ist er weg —
 *   du hast 3 Baelle.
 *
 * STEUERUNG
 *   Flipper : Pfeil links/rechts, A/D, ODER linke/rechte Haelfte des Tisches antippen,
 *             ODER die beiden grossen Knoepfe unter dem Tisch (Touch + Maus).
 *   Feder   : unten rechts. Halten oder nach unten ziehen laedt die Feder,
 *             loslassen schiesst. Am Desktop auch Leertaste.
 *
 * PUNKTE
 *   Bumper 100 · Slingshot 50 · Target 250 · Rampe 500 · Target-Bank komplett 1000
 *   — alles mal Multiplikator. Multiplikator steigt (max. x5) bei kompletter
 *   Target-Bank oder je 3 gefahrenen Rampen. Ball verloren -> Multiplikator zurueck
 *   auf x1 und die Targets stehen wieder.
 *
 * SYNC-MODELL
 *   SOLO : Punktejagd gegen den eigenen Rekord (App.Storage 'best_pinball'). Der
 *          Rekord ist waehrend des Spiels sichtbar und meldet sich, wenn er faellt.
 *   MULTI: Kein Host noetig — jeder spielt denselben Tisch (identische Geometrie,
 *          gemeinsamer Zufalls-Seed aus round.startAt) gleichzeitig seine 3 Baelle.
 *          Nur die eigene Punktzahl geht per room.reportScore() raus (gedrosselt),
 *          "fertig" per room.reportState({done:1}). Live-Rangliste via App.MG.liveBoard.
 *          Die Runde endet, sobald ALLE fertig sind oder nach 2 Minuten
 *          (App.MG.roundTimer auf room.now()) — danach App.MG.endScreen mit Podest.
 *
 * Alle Zeiten laufen ueber Wall-Clock (Date.now / room.now), die Physik ueber echtes
 * dt in festen Teilschritten -> Tab-Wechsel kann nichts kaputt machen. cleanup()
 * beendet rAF, Timer, alle Listener und meldet jedes room.on wieder ab.
 */
(function () {
  'use strict';
  window.App = window.App || {}; App.Minigames = App.Minigames || {};
  var UI = App.UI, el = UI.el;

  /* ================= Tisch-Konstanten (virtuelle px, Canvas skaliert per CSS) ================= */
  var W = 460, H = 720;          // Tischgroesse
  var BR = 8;                    // Ball-Radius
  var GRAV = 950;                // px/s^2
  var MAXV = 1500;               // Deckel Ballgeschwindigkeit
  var SUB = 1 / 300;             // fester Physik-Teilschritt (s)
  var BALLS = 3;                 // Baelle pro Spiel
  var MULT_MAX = 5;
  var ROUND_MS = 120000;         // Multiplayer-Rundenlimit (2 Min)

  var FIELD_L = 14, FIELD_R = 410;      // Wandflaechen des Spielfelds
  var LANE_X = 428;                     // Mitte der Federbahn
  var LANE_FLOOR = 700, LANE_REST = 656; // Boden bzw. Ruhelage des Balls in der Bahn
  var ARC_CX = 230, ARC_CY = 220, ARC_R = 216;   // Bogen oben (Innenseite)

  /* Flipper-Zapfen: der Abstand ist so gewaehlt, dass zwischen den Spitzen genau
     ein Ball durchpasst (Ausgang) — Spitzen-Abstand 37 minus 2x Dicke = 23 > 16. */
  var PIV_L = { x: 126, y: 638 }, PIV_R = { x: 298, y: 638 };
  var FLIP_LEN = 76, FLIP_T = 7;
  var FLIP_REST = 0.48, FLIP_UP = -0.52;         // rad (y zeigt nach unten)
  var FLIP_SPEED = 26;                            // rad/s

  var SC_BUMPER = 100, SC_SLING = 50, SC_TARGET = 250, SC_RAMP = 500, SC_BANK = 1000;

  injectStyle();

  App.Minigames.pinball = {
    id: 'pinball', title: 'Neon-Flipper', icon: '🎰', order: 153,
    subtitle: 'Bumper, Rampen, Targets – 3 Bälle, ein Rekord',
    single: true, multi: true, minPlayers: 2, maxPlayers: 8,

    render: function (root, ctx) {
      var isMulti = ctx.mode === 'multi';
      var nowFn = isMulti ? function () { return ctx.room.now(); } : function () { return Date.now(); };

      /* ---- Laufzeit ---- */
      var dead = false, finished = false;
      var raf = null, last = 0, acc = 0;
      var stops = [];        // Aufraeum-Funktionen (App.MG-Bausteine, room.off, Timer)
      var listeners = [];    // {t, ty, fn, opts}
      var timeouts = [];

      /* ---- Spielzustand ---- */
      var table = null, rng = null;
      var ball = null, flipL = null, flipR = null;
      var state = 'ready';   // ready | play | ramp | lost | over
      var score = 0, mult = 1, ballsLeft = BALLS, rampCount = 0, bankCount = 0;
      var charge = 0, holdCharge = 0, dragCharge = 0;
      var waitT = 0;         // Wartezeit (s) in 'lost'
      var popups = [], trail = [];
      var lastReport = 0, reportedScore = -1, myDone = false;
      var bestSolo = 0, recordBeaten = false;
      var ridingRamp = null, rampS = 0, rampSpeed = 0;

      /* ---- DOM ---- */
      var g2d = null, canvas = null;
      var scoreEl = null, multEl = null, ballsEl = null, sideEl = null, sideLabEl = null;
      var progEl = null, msgEl = null, board = null;

      /* ---- Eingabe ---- */
      var press = { L: false, R: false, P: false };
      var ptrMap = {};       // pointerId -> 'L' | 'R' | 'P'
      var dragFrom = 0;

      /* ================= Aufraeumen ================= */
      function addL(t, ty, fn, opts) { t.addEventListener(ty, fn, opts); listeners.push({ t: t, ty: ty, fn: fn, opts: opts }); }
      function after(ms, fn) { var id = setTimeout(function () { if (!dead) fn(); }, ms); timeouts.push(id); return id; }
      function cleanup() {
        dead = true;
        if (raf) { cancelAnimationFrame(raf); raf = null; }
        timeouts.forEach(clearTimeout); timeouts = [];
        stops.forEach(function (f) { try { f(); } catch (e) {} }); stops = [];
        listeners.forEach(function (l) { try { l.t.removeEventListener(l.ty, l.fn, l.opts); } catch (e) {} }); listeners = [];
      }

      /* ================= Start ================= */
      if (isMulti) {
        var snap = ctx.room.snapshot() || {};
        var startAt = (snap.round && snap.round.startAt) || (ctx.room.now() + 3000);
        stops.push(App.MG.countdown(root, startAt, function () { play(startAt); }, ctx.room.now));
      } else {
        play(Date.now());
      }
      return { cleanup: cleanup };

      /* ================= Aufbau einer Partie ================= */
      function play(startAt) {
        // laufende Reste einer Vorrunde (Nochmal-Knopf) wegraeumen
        if (raf) { cancelAnimationFrame(raf); raf = null; }
        timeouts.forEach(clearTimeout); timeouts = [];
        stops.forEach(function (f) { try { f(); } catch (e) {} }); stops = [];
        listeners.forEach(function (l) { try { l.t.removeEventListener(l.ty, l.fn, l.opts); } catch (e) {} }); listeners = [];

        finished = false; myDone = false;
        score = 0; mult = 1; ballsLeft = BALLS; rampCount = 0; bankCount = 0;
        popups = []; trail = []; ridingRamp = null;
        lastReport = 0; reportedScore = -1; recordBeaten = false;
        bestSolo = isMulti ? 0 : (App.Storage.get('best_pinball', 0) || 0);

        // Gleicher Seed fuer alle -> exakt gleicher Tisch im Multiplayer
        rng = mkRng(isMulti ? (startAt % 2147483647) : (Date.now() % 2147483647));
        table = buildTable();
        flipL = { x: PIV_L.x, y: PIV_L.y, a: FLIP_REST, av: 0, rest: FLIP_REST, up: FLIP_UP, side: 'L' };
        flipR = { x: PIV_R.x, y: PIV_R.y, a: Math.PI - FLIP_REST, av: 0, rest: Math.PI - FLIP_REST, up: Math.PI - FLIP_UP, side: 'R' };
        ball = { x: LANE_X, y: LANE_FLOOR - BR, vx: 0, vy: 0 };
        state = 'ready'; charge = 0; holdCharge = 0; dragCharge = 0; waitT = 0;
        press.L = press.R = press.P = false; ptrMap = {};

        buildUI(startAt);
        if (isMulti) { ctx.room.reportScore(0); ctx.room.reportState({ done: 0 }); }

        last = Date.now(); acc = 0;
        raf = requestAnimationFrame(loop);
      }

      /* ================= Oberflaeche ================= */
      function buildUI(startAt) {
        scoreEl = el('div', { class: 'pin-hud-v pin-hud-score' }, ['0']);
        multEl = el('div', { class: 'pin-hud-v pin-hud-mult' }, ['x1']);
        ballsEl = el('div', { class: 'pin-hud-v pin-hud-balls' }, ['']);
        sideEl = el('div', { class: 'pin-hud-v pin-hud-side' }, ['–']);
        sideLabEl = el('span', { class: 'pin-hud-l' }, [isMulti ? 'Zeit' : 'Rekord']);

        var head = el('div', { class: 'pin-hud glass' }, [
          el('div', { class: 'pin-hud-cell' }, [el('span', { class: 'pin-hud-l' }, ['Punkte']), scoreEl]),
          el('div', { class: 'pin-hud-cell' }, [el('span', { class: 'pin-hud-l' }, ['Multi']), multEl]),
          el('div', { class: 'pin-hud-cell' }, [el('span', { class: 'pin-hud-l' }, ['Bälle']), ballsEl]),
          el('div', { class: 'pin-hud-cell pin-hud-right' }, [sideLabEl, sideEl])
        ]);

        progEl = el('div', { class: 'pin-prog' }, ['🎯 0/4   ·   🌀 0/3   ·   Bank & Rampen erhöhen den Multi']);

        canvas = el('canvas', { class: 'pin-canvas', width: W, height: H });
        msgEl = el('div', { class: 'pin-msg' }, []);
        var stage = el('div', { class: 'pin-stage' }, [canvas, msgEl]);

        var btnL = el('button', { class: 'btn pin-fbtn pin-fbtn-l', type: 'button', 'aria-label': 'Linker Flipper' }, ['◀']);
        var btnP = el('button', { class: 'btn pin-fbtn pin-fbtn-p', type: 'button', 'aria-label': 'Feder' }, ['🔻 Feder']);
        var btnR = el('button', { class: 'btn pin-fbtn pin-fbtn-r', type: 'button', 'aria-label': 'Rechter Flipper' }, ['▶']);
        var pad = el('div', { class: 'pin-pad' }, [btnL, btnP, btnR]);

        var hint = el('p', { class: 'hint-text pin-hint' }, [
          'Flipper: ◀ ▶ / Pfeiltasten / A · D — oder Tischhälfte antippen. ' +
          'Feder unten rechts halten bzw. ziehen und loslassen (Leertaste). 3 Bälle.'
        ]);

        var col = el('div', { class: 'pin-col' }, [head, stage, pad, progEl, hint]);

        var side = null;
        if (isMulti) {
          board = App.MG.liveBoard(ctx.room, ctx.me.id);
          stops.push(board.stop);
          side = el('div', { class: 'pin-side glass' }, [
            el('div', { class: 'mg-field-title' }, ['🏆 Rangliste']), board.root,
            el('p', { class: 'hint-text pin-side-hint' }, ['Alle spielen gleichzeitig 3 Bälle. Runde endet, wenn alle durch sind – spätestens nach 2 Minuten.'])
          ]);
        }

        root.innerHTML = '';
        root.appendChild(el('div', { class: 'pin-main' }, [col, side]));

        g2d = canvas.getContext('2d');
        updateHud();
        bindInput(btnL, btnP, btnR);

        if (isMulti) {
          var endAt = startAt + ROUND_MS;
          stops.push(App.MG.roundTimer(endAt, function (left) {
            sideEl.textContent = App.MG.mmss(left);
            if (left <= 15) sideEl.classList.add('pin-urgent');
          }, function () { finishRound(); }, ctx.room.now));

          var ph = function () { tryFinishMulti(); };
          ctx.room.on('players', ph);
          stops.push(function () { ctx.room.off('players', ph); });
        } else {
          sideEl.textContent = App.MG.fmt(bestSolo);
        }
      }

      function updateHud() {
        if (!scoreEl) return;
        scoreEl.textContent = App.MG.fmt(score);
        multEl.textContent = 'x' + mult;
        var dots = '';
        for (var i = 0; i < BALLS; i++) dots += (i < ballsLeft ? '●' : '○');
        ballsEl.textContent = dots;
        var downs = 0;
        table.targets.forEach(function (t) { if (t.down) downs++; });
        progEl.textContent = '🎯 ' + downs + '/4   ·   🌀 ' + (rampCount % 3) + '/3   ·   ' +
          (mult >= MULT_MAX ? 'Multi am Maximum!' : 'Bank & Rampen erhöhen den Multi');
        if (!isMulti && score > bestSolo && bestSolo > 0 && !recordBeaten) {
          recordBeaten = true;
          if (App.Audio) App.Audio.sfx('jackpot');
          flashMsg('👑 REKORD GEKNACKT!', 1400);
        }
      }

      function flashMsg(text, ms) {
        if (!msgEl) return;
        msgEl.textContent = text;
        msgEl.classList.remove('pin-msg-on'); void msgEl.offsetWidth; msgEl.classList.add('pin-msg-on');
        after(ms || 900, function () { if (msgEl && msgEl.textContent === text) msgEl.classList.remove('pin-msg-on'); });
      }

      /* ================= Eingabe (Maus, Touch, Tastatur) ================= */
      /* Jeder Zeiger (Maus/Finger) wird in ptrMap gemerkt; losgelassen wird auf
         document-Ebene -> zwei Finger koennen beide Flipper gleichzeitig halten,
         und ein Finger, der neben dem Knopf loslaesst, haengt trotzdem nicht fest. */
      function bindInput(btnL, btnP, btnR) {
        function down(node, which) {
          addL(node, 'pointerdown', function (e) {
            e.preventDefault();
            ptrMap[e.pointerId] = which;
            begin(which);
          });
          addL(node, 'contextmenu', function (e) { e.preventDefault(); });
        }
        down(btnL, 'L'); down(btnR, 'R'); down(btnP, 'P');

        addL(canvas, 'pointerdown', function (e) {
          e.preventDefault();
          var v = toVirtual(e.clientX, e.clientY);
          var which;
          if (state === 'ready' || v.x > FIELD_R) { which = 'P'; dragFrom = v.y; }
          else which = (v.x < W / 2 ? 'L' : 'R');
          ptrMap[e.pointerId] = which;
          begin(which);
        });
        addL(canvas, 'pointermove', function (e) {
          if (ptrMap[e.pointerId] !== 'P' || state !== 'ready') return;
          var v = toVirtual(e.clientX, e.clientY);
          dragCharge = Math.max(0, Math.min(1, (v.y - dragFrom) / 90));
        });
        addL(canvas, 'contextmenu', function (e) { e.preventDefault(); });

        function up(e) {
          var which = ptrMap[e.pointerId];
          if (!which) return;
          delete ptrMap[e.pointerId];
          var still = false;
          Object.keys(ptrMap).forEach(function (k) { if (ptrMap[k] === which) still = true; });
          if (!still) end(which);
        }
        addL(document, 'pointerup', up);
        addL(document, 'pointercancel', up);

        addL(document, 'keydown', function (e) {
          if (e.repeat) return;
          var k = e.key;
          if (k === 'ArrowLeft' || k === 'a' || k === 'A') { e.preventDefault(); begin('L'); }
          else if (k === 'ArrowRight' || k === 'd' || k === 'D') { e.preventDefault(); begin('R'); }
          else if (k === ' ' || k === 'Spacebar' || k === 'ArrowDown' || k === 's' || k === 'S') { e.preventDefault(); begin('P'); }
        });
        addL(document, 'keyup', function (e) {
          var k = e.key;
          if (k === 'ArrowLeft' || k === 'a' || k === 'A') end('L');
          else if (k === 'ArrowRight' || k === 'd' || k === 'D') end('R');
          else if (k === ' ' || k === 'Spacebar' || k === 'ArrowDown' || k === 's' || k === 'S') end('P');
        });
        // Fenster verlassen -> alles loslassen, sonst klemmt ein Flipper oben fest
        addL(window, 'blur', function () { ptrMap = {}; end('L'); end('R'); end('P'); });
      }

      function begin(which) {
        if (dead || state === 'over') return;
        if (which === 'P') {
          if (state !== 'ready') return;
          if (!press.P) { holdCharge = 0; dragCharge = 0; }
          press.P = true;
        } else {
          if (press[which]) return;
          press[which] = true;
          if (App.Audio) App.Audio.blip(170, 0.035, { type: 'square', peak: 0.05 });
        }
      }
      function end(which) {
        if (which === 'P') {
          if (press.P && state === 'ready') launch();
          press.P = false; holdCharge = 0; dragCharge = 0; charge = 0;
        } else press[which] = false;
      }

      function toVirtual(cx, cy) {
        var r = canvas.getBoundingClientRect();
        return { x: (cx - r.left) / r.width * W, y: (cy - r.top) / r.height * H };
      }

      function launch() {
        var p = Math.max(0.06, charge);
        ball.vx = (rng() - 0.5) * 18;
        ball.vy = -(520 + 620 * p);
        state = 'play';
        charge = 0; holdCharge = 0; dragCharge = 0;
        trail = [];
        if (App.Audio) App.Audio.sfx('whoosh');
      }

      /* ================= Haupt-Schleife ================= */
      function loop() {
        if (dead) { raf = null; return; }
        var now = Date.now();
        var dt = (now - last) / 1000; last = now;
        if (dt < 0) dt = 0; if (dt > 0.05) dt = 0.05;   // Tab-Wechsel: nicht nachrechnen
        acc += dt;
        var guard = 0;
        while (acc >= SUB && guard < 40) { physics(SUB); acc -= SUB; guard++; }
        if (acc > SUB) acc = 0;
        draw(now);
        pushScore(nowFn());
        raf = requestAnimationFrame(loop);
      }

      function pushScore(t) {
        if (!isMulti || finished) return;
        if (score === reportedScore) return;
        if (t - lastReport < 400) return;
        lastReport = t; reportedScore = score;
        try { ctx.room.reportScore(score); } catch (e) {}
      }

      /* ================= Physik ================= */
      function physics(h) {
        stepFlipper(flipL, press.L, h);
        stepFlipper(flipR, press.R, h);

        if (state === 'lost') {
          waitT -= h;
          if (waitT <= 0) { state = 'ready'; ball.x = LANE_X; ball.y = LANE_FLOOR - BR; ball.vx = 0; ball.vy = 0; trail = []; }
          return;
        }
        if (state === 'ready') {
          if (press.P) holdCharge = Math.min(1, holdCharge + h / 1.1);
          charge = Math.max(holdCharge, dragCharge);
          ball.x = LANE_X; ball.y = LANE_REST + charge * 34;
          return;
        }
        if (state === 'over') return;
        if (state === 'ramp') { stepRamp(h); return; }

        /* --- freier Ball --- */
        ball.vy += GRAV * h;
        ball.vx *= 0.99955; ball.vy *= 0.99955;
        var sp = Math.sqrt(ball.vx * ball.vx + ball.vy * ball.vy);
        if (sp > MAXV) { ball.vx = ball.vx / sp * MAXV; ball.vy = ball.vy / sp * MAXV; }
        ball.x += ball.vx * h; ball.y += ball.vy * h;

        collideArc();
        collideSegs();
        collideCircles();
        collideFlipper(flipL);
        collideFlipper(flipR);
        checkRamps();
        checkDrain();
      }

      function stepFlipper(f, on, h) {
        var target = on ? f.up : f.rest;
        var d = target - f.a;
        var step = FLIP_SPEED * h;
        var prev = f.a;
        if (Math.abs(d) <= step) f.a = target;
        else f.a += (d > 0 ? 1 : -1) * step;
        f.av = (f.a - prev) / h;
      }

      /* --- Bogen oben: Ball bleibt INNEN --- */
      function collideArc() {
        if (ball.y > ARC_CY) return;
        var dx = ball.x - ARC_CX, dy = ball.y - ARC_CY;
        var d = Math.sqrt(dx * dx + dy * dy);
        var lim = ARC_R - BR;
        if (d <= lim || d === 0) return;
        var nx = -dx / d, ny = -dy / d;                 // Normale zeigt nach innen
        ball.x = ARC_CX + dx / d * lim; ball.y = ARC_CY + dy / d * lim;
        var vn = ball.vx * nx + ball.vy * ny;
        if (vn < 0) { ball.vx -= 1.25 * vn * nx; ball.vy -= 1.25 * vn * ny; }   // e = 0.25 -> Ball schmiegt sich an
      }

      /* --- Wandsegmente, Slingshots, Targets, Einwegklappe --- */
      function collideSegs() {
        for (var i = 0; i < table.segs.length; i++) {
          var s = table.segs[i];
          if (s.kind === 'target' && s.ref.down) continue;
          if (s.kind === 'gate' && ball.vy <= 0) continue;               // Klappe: nur von oben
          var hit = hitCapsule(s.ax, s.ay, s.bx, s.by, s.t, s.e, s.nx, s.ny);
          if (!hit) continue;

          if (s.kind === 'sling') {
            if (nowMs() - s.cool < 70) continue;
            s.cool = nowMs(); s.flash = nowMs();
            ball.vx += hit.nx * 400; ball.vy += hit.ny * 400;
            addScore(SC_SLING, ball.x, ball.y);
            if (App.Audio) App.Audio.sfx('tick');
          } else if (s.kind === 'target') {
            s.ref.down = true; s.ref.flash = nowMs();
            addScore(SC_TARGET, s.ref.x, s.ref.y - 14);
            if (App.Audio) App.Audio.sfx('hit');
            checkBank();
            updateHud();
          } else if (s.kind === 'gate') {
            ball.vy = -Math.abs(ball.vy) * 0.35 - 40;
            ball.vx -= 90;                                              // zurueck ins Feld schubsen
          }
        }
      }

      /* --- Bumper und Posts --- */
      function collideCircles() {
        for (var i = 0; i < table.circles.length; i++) {
          var c = table.circles[i];
          var dx = ball.x - c.x, dy = ball.y - c.y;
          var d = Math.sqrt(dx * dx + dy * dy);
          var rad = c.r + BR;
          if (d >= rad) continue;
          var nx, ny;
          if (d === 0) { nx = 0; ny = -1; } else { nx = dx / d; ny = dy / d; }
          ball.x = c.x + nx * rad; ball.y = c.y + ny * rad;
          var vn = ball.vx * nx + ball.vy * ny;
          if (vn < 0) { ball.vx -= (1 + c.e) * vn * nx; ball.vy -= (1 + c.e) * vn * ny; }
          if (c.kind === 'bumper') {
            if (nowMs() - c.cool < 80) continue;
            c.cool = nowMs(); c.flash = nowMs();
            var jit = (rng() - 0.5) * 0.5;
            var ang = Math.atan2(ny, nx) + jit;
            ball.vx += Math.cos(ang) * 360; ball.vy += Math.sin(ang) * 360;
            addScore(SC_BUMPER, c.x, c.y - c.r - 6);
            if (App.Audio) App.Audio.blip(520 + rng() * 260, 0.05, { type: 'square', peak: 0.07 });
          }
        }
      }

      /* --- Flipper als rotierende Kapsel --- */
      function collideFlipper(f) {
        var tx = f.x + Math.cos(f.a) * FLIP_LEN, ty = f.y + Math.sin(f.a) * FLIP_LEN;
        var p = closest(f.x, f.y, tx, ty, ball.x, ball.y);
        var dx = ball.x - p.x, dy = ball.y - p.y;
        var d = Math.sqrt(dx * dx + dy * dy);
        var rad = BR + FLIP_T;
        if (d >= rad) return;
        var nx, ny;
        if (d === 0) { nx = 0; ny = -1; } else { nx = dx / d; ny = dy / d; }
        ball.x = p.x + nx * rad; ball.y = p.y + ny * rad;
        // Oberflaechen-Geschwindigkeit am Kontaktpunkt (Drehung um den Zapfen)
        var rx = p.x - f.x, ry = p.y - f.y;
        var sx = -f.av * ry, sy = f.av * rx;
        var rvx = ball.vx - sx, rvy = ball.vy - sy;
        var vn = rvx * nx + rvy * ny;
        if (vn < 0) {
          var e = 0.5 + (Math.abs(f.av) > 3 ? 0.28 : 0);
          rvx -= (1 + e) * vn * nx; rvy -= (1 + e) * vn * ny;
          ball.vx = rvx + sx; ball.vy = rvy + sy;
          var sp = Math.sqrt(ball.vx * ball.vx + ball.vy * ball.vy);
          if (sp > MAXV) { ball.vx = ball.vx / sp * MAXV; ball.vy = ball.vy / sp * MAXV; }
          if (Math.abs(f.av) > 6 && App.Audio) App.Audio.blip(230, 0.04, { type: 'square', peak: 0.06 });
        }
      }

      /* --- Rampen-Eingaenge: nur mit ordentlich Schwung nach oben --- */
      function checkRamps() {
        for (var i = 0; i < table.ramps.length; i++) {
          var r = table.ramps[i];
          if (ball.vy > -200) continue;
          var m = r.path[0];
          var dx = ball.x - m[0], dy = ball.y - m[1];
          if (dx * dx + dy * dy > (r.mouthR + BR) * (r.mouthR + BR)) continue;
          ridingRamp = r; rampS = 0;
          rampSpeed = Math.max(500, Math.min(1050, Math.sqrt(ball.vx * ball.vx + ball.vy * ball.vy)));
          state = 'ramp';
          rampCount++;
          addScore(SC_RAMP, m[0], m[1] - 18);
          if (App.Audio) App.Audio.sfx('whoosh');
          if (rampCount % 3 === 0) bumpMult('🌀 3 Rampen!');
          updateHud();
          return;
        }
      }

      function stepRamp(h) {
        rampSpeed = Math.max(360, rampSpeed - 170 * h);
        rampS += rampSpeed * h;
        var p = pathAt(ridingRamp, rampS);
        ball.x = p.x; ball.y = p.y;
        ball.vx = p.dx * rampSpeed; ball.vy = p.dy * rampSpeed;
        if (rampS >= ridingRamp.total) {
          ball.x = ridingRamp.exit[0]; ball.y = ridingRamp.exit[1];
          ball.vx = ridingRamp.exitV[0]; ball.vy = ridingRamp.exitV[1];
          state = 'play'; ridingRamp = null;
          if (App.Audio) App.Audio.sfx('coin');
        }
      }

      function checkBank() {
        var all = true;
        table.targets.forEach(function (t) { if (!t.down) all = false; });
        if (!all) return;
        bankCount++;
        addScore(SC_BANK, 212, 300);
        if (App.Audio) App.Audio.sfx('powerup');
        bumpMult('🎯 BANK KOMPLETT!');
        after(900, function () {
          if (state === 'over') return;
          table.targets.forEach(function (t) { t.down = false; t.flash = nowMs(); });
          updateHud();
        });
      }

      function bumpMult(why) {
        if (mult < MULT_MAX) {
          mult++;
          if (App.Audio) App.Audio.sfx('levelup');
          flashMsg(why + '  MULTI x' + mult, 1200);
        } else {
          flashMsg(why, 900);
        }
        updateHud();
      }

      function checkDrain() {
        // Zu schwach gefedert -> Ball rollt in die Bahn zurueck, neu federn
        if (ball.x > FIELD_R + 4 && ball.y > 640 && Math.abs(ball.vy) < 90 && Math.abs(ball.vx) < 90) {
          state = 'ready'; charge = 0; holdCharge = 0; dragCharge = 0;
          ball.x = LANE_X; ball.y = LANE_FLOOR - BR; ball.vx = 0; ball.vy = 0;
          return;
        }
        if (ball.y < H + 40 && !(ball.y > 704 && ball.x < FIELD_R)) return;
        loseBall();
      }

      function loseBall() {
        ballsLeft--;
        mult = 1;
        table.targets.forEach(function (t) { t.down = false; });
        if (App.Audio) App.Audio.sfx('lose');
        updateHud();
        if (ballsLeft <= 0) { gameOver(); return; }
        state = 'lost'; waitT = 1.0;
        ball.vx = 0; ball.vy = 0; ball.y = H + 60;
        trail = [];
        flashMsg('💀 Ball verloren — noch ' + ballsLeft + (ballsLeft === 1 ? ' Ball' : ' Bälle'), 1000);
      }

      function addScore(base, px, py) {
        var v = base * mult;
        score += v;
        popups.push({ x: px, y: py, t: nowMs(), txt: '+' + App.MG.fmt(v) });
        if (popups.length > 14) popups.shift();
        updateHud();
      }

      function nowMs() { return Date.now(); }

      /* ================= Ende ================= */
      function gameOver() {
        state = 'over';
        press.L = press.R = press.P = false;
        flashMsg('🏁 Alle Bälle gespielt — ' + App.MG.fmt(score) + ' Punkte', 2500);
        if (App.Audio) App.Audio.sfx('cashout');

        if (isMulti) {
          myDone = true;
          try { ctx.room.reportScore(score); } catch (e) {}
          try { ctx.room.reportState({ done: 1 }); } catch (e) {}
          reportedScore = score;
          after(600, tryFinishMulti);
        } else {
          after(1100, function () {
            if (raf) { cancelAnimationFrame(raf); raf = null; }
            var best = App.Storage.get('best_pinball', 0) || 0;
            var nb = score > best;
            if (nb) App.Storage.set('best_pinball', score);
            App.MG.endScreen(root, {
              score: score, best: best, newBest: nb,
              label: nb ? 'Neuer Tisch-Rekord! 🎉' : ('Rekord: ' + App.MG.fmt(best) + ' Punkte'),
              onExit: ctx.onExit,
              onAgain: function () { play(Date.now()); }
            });
          });
        }
      }

      function tryFinishMulti() {
        if (finished || dead || !myDone) return;
        var ps = ctx.room.players();
        if (!ps.length) return;
        var all = ps.every(function (p) { return p.state && p.state.done; });
        if (all) finishRound();
      }

      function finishRound() {
        if (finished || dead) return;
        finished = true;
        state = 'over';
        if (raf) { cancelAnimationFrame(raf); raf = null; }
        try { ctx.room.reportScore(score); } catch (e) {}
        try { ctx.room.reportState({ done: 1 }); } catch (e) {}
        after(700, function () {
          stops.forEach(function (f) { try { f(); } catch (e) {} }); stops = [];
          App.MG.endScreen(root, { players: ctx.room.players(), meId: ctx.me.id, onExit: ctx.onExit });
        });
      }

      /* ================= Zeichnen ================= */
      function draw(now) {
        var g = g2d; if (!g) return;
        g.clearRect(0, 0, W, H);

        // Untergrund
        var bg = g.createLinearGradient(0, 0, 0, H);
        bg.addColorStop(0, '#07200f'); bg.addColorStop(0.55, '#05170d'); bg.addColorStop(1, '#020b06');
        g.fillStyle = bg; g.fillRect(0, 0, W, H);
        // Dschungel-Schimmer
        var glow = g.createRadialGradient(230, 240, 20, 230, 240, 300);
        glow.addColorStop(0, 'rgba(57,255,20,0.09)'); glow.addColorStop(1, 'rgba(57,255,20,0)');
        g.fillStyle = glow; g.fillRect(0, 0, W, H);

        drawArc(g);
        drawRamps(g, now);
        drawSegs(g, now);
        drawCircles(g, now);
        drawTargets(g, now);
        drawFlipper(g, flipL, now);
        drawFlipper(g, flipR, now);
        drawPlunger(g);
        drawBall(g);
        drawPopups(g, now);
        drawOverlay(g, now);
      }

      function drawArc(g) {
        g.save();
        g.strokeStyle = 'rgba(57,255,20,0.55)'; g.lineWidth = 5;
        g.shadowColor = 'rgba(57,255,20,0.55)'; g.shadowBlur = 14;
        g.beginPath(); g.arc(ARC_CX, ARC_CY, ARC_R, Math.PI, 0); g.stroke();
        g.restore();
      }

      function drawRamps(g, now) {
        for (var i = 0; i < table.ramps.length; i++) {
          var r = table.ramps[i];
          var hot = (ridingRamp === r);
          g.save();
          g.lineCap = 'round'; g.lineJoin = 'round';
          g.beginPath();
          g.moveTo(r.path[0][0], r.path[0][1]);
          for (var j = 1; j < r.path.length; j++) g.lineTo(r.path[j][0], r.path[j][1]);
          g.strokeStyle = hot ? 'rgba(51,230,208,0.30)' : 'rgba(51,230,208,0.10)';
          g.lineWidth = 22; g.stroke();
          g.strokeStyle = hot ? 'rgba(127,243,230,0.95)' : 'rgba(51,230,208,0.38)';
          g.lineWidth = 2; g.setLineDash([9, 9]); g.stroke();
          g.setLineDash([]);
          g.restore();
          // Rampenmaul
          var m = r.path[0];
          g.save();
          g.strokeStyle = hot ? '#7ff3e6' : 'rgba(51,230,208,0.8)';
          g.shadowColor = 'rgba(51,230,208,0.8)'; g.shadowBlur = hot ? 20 : 10;
          g.lineWidth = 3;
          g.beginPath(); g.arc(m[0], m[1], r.mouthR, 0, Math.PI * 2); g.stroke();
          g.fillStyle = 'rgba(51,230,208,0.85)'; g.font = '900 13px system-ui,sans-serif';
          g.textAlign = 'center'; g.textBaseline = 'middle';
          g.fillText('▲', m[0], m[1]);
          g.restore();
        }
      }

      function drawSegs(g, now) {
        for (var i = 0; i < table.segs.length; i++) {
          var s = table.segs[i];
          if (s.kind === 'target' || s.kind === 'gate') continue;
          var sling = s.kind === 'sling';
          var f = sling ? Math.max(0, 1 - (now - s.flash) / 180) : 0;
          g.save();
          g.lineCap = 'round';
          if (sling) {
            g.strokeStyle = f > 0 ? '#ffffff' : '#ff4d6d';
            g.shadowColor = 'rgba(255,77,109,0.85)'; g.shadowBlur = 12 + f * 22;
            g.lineWidth = 7;
          } else {
            g.strokeStyle = 'rgba(57,255,20,0.5)';
            g.shadowColor = 'rgba(57,255,20,0.45)'; g.shadowBlur = 10;
            g.lineWidth = 5;
          }
          g.beginPath(); g.moveTo(s.ax, s.ay); g.lineTo(s.bx, s.by); g.stroke();
          g.restore();
        }
        // Slingshot-Koerper fuellen
        g.save();
        g.fillStyle = 'rgba(255,77,109,0.13)';
        table.slingTris.forEach(function (t) {
          g.beginPath(); g.moveTo(t[0][0], t[0][1]); g.lineTo(t[1][0], t[1][1]); g.lineTo(t[2][0], t[2][1]);
          g.closePath(); g.fill();
        });
        g.restore();
        // Klappe der Federbahn
        var gate = table.gate;
        g.save();
        g.strokeStyle = 'rgba(255,210,63,0.45)'; g.lineWidth = 3; g.setLineDash([6, 5]);
        g.beginPath(); g.moveTo(gate.ax, gate.ay); g.lineTo(gate.bx, gate.by); g.stroke();
        g.restore();
      }

      function drawCircles(g, now) {
        for (var i = 0; i < table.circles.length; i++) {
          var c = table.circles[i];
          if (c.kind === 'bumper') {
            var f = Math.max(0, 1 - (now - c.flash) / 200);
            var rr = c.r * (1 + f * 0.16);
            g.save();
            g.shadowColor = 'rgba(57,255,20,0.9)'; g.shadowBlur = 16 + f * 30;
            g.strokeStyle = f > 0.2 ? '#ffffff' : '#39ff14'; g.lineWidth = 4;
            g.beginPath(); g.arc(c.x, c.y, rr, 0, Math.PI * 2); g.stroke();
            g.shadowBlur = 0;
            var gr = g.createRadialGradient(c.x, c.y - 5, 2, c.x, c.y, rr);
            gr.addColorStop(0, f > 0.2 ? 'rgba(255,255,255,0.95)' : 'rgba(57,255,20,0.5)');
            gr.addColorStop(1, 'rgba(4,22,12,0.95)');
            g.fillStyle = gr;
            g.beginPath(); g.arc(c.x, c.y, rr - 2, 0, Math.PI * 2); g.fill();
            g.fillStyle = f > 0.2 ? '#04160c' : 'rgba(157,255,122,0.9)';
            g.font = '900 14px system-ui,sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
            g.fillText('100', c.x, c.y);
            g.restore();
          } else {
            g.save();
            g.fillStyle = 'rgba(255,210,63,0.9)';
            g.shadowColor = 'rgba(255,210,63,0.7)'; g.shadowBlur = 10;
            g.beginPath(); g.arc(c.x, c.y, c.r, 0, Math.PI * 2); g.fill();
            g.restore();
          }
        }
      }

      function drawTargets(g, now) {
        for (var i = 0; i < table.targets.length; i++) {
          var t = table.targets[i];
          var f = Math.max(0, 1 - (now - t.flash) / 220);
          g.save();
          // Gezeichnet wird exakt die Kollisionsform (Kapsel +-13 um t.x, Dicke 5),
          // sonst sieht der Spieler Luecken, durch die der Ball gar nicht passt.
          if (t.down) {
            g.fillStyle = 'rgba(123,166,146,0.28)';
            roundRect(g, t.x - 18, t.y - 2, 36, 4, 2); g.fill();
          } else {
            g.shadowColor = 'rgba(255,210,63,0.8)'; g.shadowBlur = 10 + f * 26;
            g.fillStyle = f > 0.2 ? '#ffffff' : '#ffd23f';
            roundRect(g, t.x - 18, t.y - 5, 36, 10, 5); g.fill();
            g.shadowBlur = 0; g.fillStyle = 'rgba(4,22,12,0.8)';
            g.font = '900 8px system-ui,sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
            g.fillText('250', t.x, t.y);
          }
          g.restore();
        }
      }

      function drawFlipper(g, f, now) {
        var tx = f.x + Math.cos(f.a) * FLIP_LEN, ty = f.y + Math.sin(f.a) * FLIP_LEN;
        var active = Math.abs(f.a - f.up) < 0.12;
        g.save();
        g.lineCap = 'round';
        g.strokeStyle = active ? '#eaffe0' : '#39ff14';
        g.shadowColor = 'rgba(57,255,20,0.9)'; g.shadowBlur = active ? 26 : 14;
        g.lineWidth = FLIP_T * 2;
        g.beginPath(); g.moveTo(f.x, f.y); g.lineTo(tx, ty); g.stroke();
        g.shadowBlur = 0;
        g.fillStyle = 'rgba(4,22,12,0.9)';
        g.beginPath(); g.arc(f.x, f.y, 3.5, 0, Math.PI * 2); g.fill();
        g.restore();
      }

      function drawPlunger(g) {
        // Federteller sitzt immer direkt unter dem Ball und wird beim Laden mitgezogen
        var top = LANE_REST + BR + 2 + charge * 34;
        g.save();
        // Teller
        g.strokeStyle = 'rgba(207,228,220,0.8)'; g.lineWidth = 4; g.lineCap = 'round';
        g.beginPath(); g.moveTo(LANE_X - 9, top); g.lineTo(LANE_X + 9, top); g.stroke();
        // Feder (staucht sich beim Ziehen zusammen)
        g.strokeStyle = charge > 0.02 ? '#ffd23f' : 'rgba(255,210,63,0.55)';
        g.shadowColor = 'rgba(255,210,63,0.7)'; g.shadowBlur = charge * 18;
        g.lineWidth = 2.5;
        g.beginPath();
        var coils = 8, y0 = top + 2, y1 = LANE_FLOOR - 2;
        for (var i = 0; i <= coils; i++) {
          var yy = y0 + (y1 - y0) * (i / coils);
          if (i === 0) g.moveTo(LANE_X - 8, yy); else g.lineTo(i % 2 ? LANE_X + 8 : LANE_X - 8, yy);
        }
        g.stroke();
        g.shadowBlur = 0;
        // Ladebalken neben der Bahn
        g.fillStyle = 'rgba(4,22,12,0.8)';
        roundRect(g, LANE_X - 7, 470, 14, 120, 7); g.fill();
        if (charge > 0.02) {
          var hgt = 116 * charge;
          var lg = g.createLinearGradient(0, 588, 0, 472);
          lg.addColorStop(0, '#39ff14'); lg.addColorStop(1, '#ffd23f');
          g.fillStyle = lg;
          roundRect(g, LANE_X - 5, 588 - hgt, 10, hgt, 5); g.fill();
        }
        g.restore();
      }

      function drawBall(g) {
        if (state === 'lost' || state === 'over' && ball.y > H) return;
        trail.push({ x: ball.x, y: ball.y });
        if (trail.length > 10) trail.shift();
        g.save();
        for (var i = 0; i < trail.length; i++) {
          var a = (i + 1) / trail.length;
          g.fillStyle = 'rgba(200,255,180,' + (a * 0.22).toFixed(3) + ')';
          g.beginPath(); g.arc(trail[i].x, trail[i].y, BR * (0.35 + a * 0.65), 0, Math.PI * 2); g.fill();
        }
        g.restore();
        g.save();
        g.shadowColor = 'rgba(255,255,255,0.9)'; g.shadowBlur = 22;
        var gr = g.createRadialGradient(ball.x - 3, ball.y - 3, 1, ball.x, ball.y, BR);
        gr.addColorStop(0, '#ffffff'); gr.addColorStop(0.6, '#dfe9e4'); gr.addColorStop(1, '#7d918a');
        g.fillStyle = gr;
        g.beginPath(); g.arc(ball.x, ball.y, BR, 0, Math.PI * 2); g.fill();
        g.restore();
      }

      function drawPopups(g, now) {
        g.save();
        g.font = '900 15px system-ui,sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
        for (var i = popups.length - 1; i >= 0; i--) {
          var p = popups[i];
          var t = (now - p.t) / 900;
          if (t >= 1) { popups.splice(i, 1); continue; }
          g.globalAlpha = 1 - t;
          g.fillStyle = '#ffd23f';
          g.shadowColor = 'rgba(255,210,63,0.8)'; g.shadowBlur = 10;
          g.fillText(p.txt, p.x, p.y - t * 42);
        }
        g.restore();
      }

      function drawOverlay(g, now) {
        if (state !== 'ready') return;
        var pulse = 0.55 + 0.45 * Math.sin(now / 320);
        g.save();
        g.globalAlpha = pulse;
        g.fillStyle = '#9dff7a';
        g.font = '900 17px system-ui,sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
        g.shadowColor = 'rgba(57,255,20,0.7)'; g.shadowBlur = 12;
        // Freie Flaeche zwischen Posts und Slingshots — nichts verdecken
        g.fillText('Feder halten & loslassen ▶', 212, 458);
        g.globalAlpha = 1;
        g.font = '900 12px system-ui,sans-serif'; g.fillStyle = 'rgba(157,255,122,0.7)';
        g.fillText('(unten rechts ziehen oder Leertaste)', 212, 480);
        g.restore();
      }

      /* ================= Geometrie-Helfer ================= */
      function closest(ax, ay, bx, by, px, py) {
        var dx = bx - ax, dy = by - ay;
        var L2 = dx * dx + dy * dy;
        if (L2 === 0) return { x: ax, y: ay };
        var t = ((px - ax) * dx + (py - ay) * dy) / L2;
        if (t < 0) t = 0; else if (t > 1) t = 1;
        return { x: ax + dx * t, y: ay + dy * t };
      }
      /* Kapsel-Kollision: Segment mit Dicke. Gibt {nx,ny} der Kontaktnormalen zurueck. */
      function hitCapsule(ax, ay, bx, by, thick, e, fnx, fny) {
        var p = closest(ax, ay, bx, by, ball.x, ball.y);
        var dx = ball.x - p.x, dy = ball.y - p.y;
        var d2 = dx * dx + dy * dy;
        var rad = BR + thick;
        if (d2 >= rad * rad) return null;
        var d = Math.sqrt(d2);
        var nx, ny;
        if (d < 0.0001) { nx = fnx; ny = fny; d = 0; } else { nx = dx / d; ny = dy / d; }
        ball.x = p.x + nx * (rad + 0.05); ball.y = p.y + ny * (rad + 0.05);
        var vn = ball.vx * nx + ball.vy * ny;
        if (vn < 0) { ball.vx -= (1 + e) * vn * nx; ball.vy -= (1 + e) * vn * ny; }
        return { nx: nx, ny: ny };
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
    }
  };

  /* ================= Tisch bauen ================= */
  function buildTable() {
    var segs = [], circles = [], targets = [], slingTris = [], ramps = [];

    function seg(ax, ay, bx, by, e, kind, thick, ref) {
      var dx = bx - ax, dy = by - ay, L = Math.sqrt(dx * dx + dy * dy) || 1;
      var o = { ax: ax, ay: ay, bx: bx, by: by, e: e, kind: kind || 'wall', t: thick || 0,
        nx: -dy / L, ny: dx / L, cool: 0, flash: -9999 };
      if (ref) o.ref = ref;
      segs.push(o); return o;
    }

    /* --- Aussenwaende ---
       Die unteren Schraegen fuehren den Ball auf die Flipper. Sie laufen bewusst rund
       14 px OBERHALB des Flipper-Zapfens vorbei und enden erst ueber der Flipperflaeche
       (134/290, 626). Grund: der Zapfen ist fuer den Ball ein Kreis mit Radius
       BR+FLIP_T = 15. Laege die Wand direkt am Zapfen, wuerde dieser Kreis den nur 8 px
       breiten Korridor entlang der Wand komplett zusperren und der Ball bliebe dort
       endgueltig haengen. So bleibt der Korridor 22 px frei und der Ball rollt an der
       Wand entlang und faellt dahinter sauber auf die Flipperflaeche. */
    seg(FIELD_L, 220, FIELD_L, 552, 0.42);                 // links
    seg(FIELD_L, 552, 134, 626, 0.42);                     // links unten -> Flipper
    seg(FIELD_R, 250, FIELD_R, LANE_FLOOR, 0.42);          // Trennwand zur Federbahn
    seg(FIELD_R, 552, 290, 626, 0.42);                     // rechts unten -> Flipper
    seg(446, 220, 446, LANE_FLOOR, 0.35);                  // Aussenwand Federbahn
    seg(412, LANE_FLOOR, 446, LANE_FLOOR, 0.05);           // Boden der Federbahn
    var gate = seg(FIELD_R, 240, 446, 240, 0.2, 'gate');   // Einwegklappe

    /* --- Slingshots (Dreiecke ueber den Flippern) ---
       Wichtig: die Unterkante (p1->p2) laeuft PARALLEL zur unteren Schraege und haelt
       ~38 px Abstand. So bleibt der Inlane-Kanal ueberall breiter als ein Ball. Waeren
       die Ecken naeher an der Wand, keilt sich der Ball im spitzen Winkel fest. */
    function sling(x1, y1, x2, y2, x3, y3) {
      seg(x1, y1, x2, y2, 0.35);
      seg(x2, y2, x3, y3, 0.35);
      seg(x1, y1, x3, y3, 0.45, 'sling');
      slingTris.push([[x1, y1], [x2, y2], [x3, y3]]);
    }
    sling(58, 498, 69, 544, 129, 581);
    sling(366, 498, 355, 544, 295, 581);

    /* --- Bumper + Posts --- */
    function circ(x, y, r, e, kind) { circles.push({ x: x, y: y, r: r, e: e, kind: kind, cool: 0, flash: -9999 }); }
    circ(152, 258, 22, 0.5, 'bumper');
    circ(272, 258, 22, 0.5, 'bumper');
    circ(212, 186, 22, 0.5, 'bumper');
    circ(100, 430, 10, 0.75, 'post');
    circ(324, 430, 10, 0.75, 'post');
    circ(212, 400, 10, 0.75, 'post');

    /* --- Drop-Target-Bank (4 Stueck, Mitte) --- */
    [158, 194, 230, 266].forEach(function (cx) {
      var t = { x: cx, y: 330, down: false, flash: -9999 };
      targets.push(t);
      seg(cx - 13, 330, cx + 13, 330, 0.4, 'target', 5, t);
    });

    /* --- Orbit-Rampen (links + rechts, Ausgang jeweils im anderen Inlane) --- */
    ramps.push(mkRamp([[40, 262], [30, 196], [58, 140], [130, 102], [230, 92], [330, 112], [390, 172], [400, 256], [396, 364], [392, 470]],
      [392, 470], [0, 300]));
    ramps.push(mkRamp([[384, 262], [394, 196], [366, 140], [294, 102], [194, 92], [94, 112], [34, 172], [24, 256], [28, 364], [32, 470]],
      [32, 470], [0, 300]));

    return { segs: segs, circles: circles, targets: targets, slingTris: slingTris, ramps: ramps, gate: gate };
  }

  /* Rampe aus Stuetzpunkten: glatte Catmull-Rom-Kurve + Bogenlaengen-Tabelle. */
  function mkRamp(cps, exit, exitV) {
    var pts = smooth(cps, 8);
    var parts = [], total = 0, i;
    for (i = 0; i < pts.length - 1; i++) {
      var dx = pts[i + 1][0] - pts[i][0], dy = pts[i + 1][1] - pts[i][1];
      var L = Math.sqrt(dx * dx + dy * dy);
      if (L < 0.0001) continue;
      parts.push({ x: pts[i][0], y: pts[i][1], dx: dx / L, dy: dy / L, L: L, s0: total });
      total += L;
    }
    return { path: pts, parts: parts, total: total, mouthR: 13, exit: exit, exitV: exitV };
  }
  function pathAt(r, s) {
    var parts = r.parts;
    if (s <= 0) return { x: parts[0].x, y: parts[0].y, dx: parts[0].dx, dy: parts[0].dy };
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      if (s <= p.s0 + p.L || i === parts.length - 1) {
        var t = Math.min(Math.max(s - p.s0, 0), p.L);
        return { x: p.x + p.dx * t, y: p.y + p.dy * t, dx: p.dx, dy: p.dy };
      }
    }
    return { x: parts[0].x, y: parts[0].y, dx: 0, dy: 1 };
  }
  function smooth(cps, steps) {
    var p = [cps[0]].concat(cps, [cps[cps.length - 1]]);
    var out = [], i, j;
    for (i = 0; i < p.length - 3; i++) {
      for (j = 0; j < steps; j++) out.push(catmull(p[i], p[i + 1], p[i + 2], p[i + 3], j / steps));
    }
    out.push([cps[cps.length - 1][0], cps[cps.length - 1][1]]);
    return out;
  }
  function catmull(p0, p1, p2, p3, t) {
    var t2 = t * t, t3 = t2 * t;
    function ax(a, b, c, d) {
      return 0.5 * ((2 * b) + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
    }
    return [ax(p0[0], p1[0], p2[0], p3[0]), ax(p0[1], p1[1], p2[1], p3[1])];
  }

  /* Kleiner, deterministischer Zufall (xorshift) — gleicher Seed = gleicher Tisch. */
  function mkRng(seed) {
    var s = (seed >>> 0) || 88675123;
    return function () {
      s ^= s << 13; s >>>= 0;
      s ^= s >>> 17;
      s ^= s << 5; s >>>= 0;
      return s / 4294967296;
    };
  }

  /* ================= STYLES ================= */
  function injectStyle() {
    UI.injectStyle('mg-pinball-css', [
      '.pin-main{display:flex;gap:14px;align-items:flex-start;justify-content:center;flex-wrap:wrap;}',
      '.pin-col{display:flex;flex-direction:column;gap:8px;align-items:stretch;min-width:0;}',
      '.pin-side{flex:0 1 260px;min-width:210px;padding:14px;display:flex;flex-direction:column;gap:8px;}',
      '.pin-side .mg-scoreboard{max-height:320px;overflow-y:auto;}',
      '.pin-side-hint{margin:0;}',
      /* HUD */
      '.pin-hud{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 14px;}',
      '.pin-hud-cell{display:flex;flex-direction:column;gap:1px;min-width:0;}',
      '.pin-hud-right{text-align:right;align-items:flex-end;}',
      '.pin-hud-l{color:var(--muted);font-size:10px;text-transform:uppercase;letter-spacing:1px;}',
      '.pin-hud-v{font-weight:900;line-height:1;font-variant-numeric:tabular-nums;}',
      '.pin-hud-score{font-size:clamp(18px,4.6vw,26px);color:var(--gold);text-shadow:0 0 12px rgba(255,210,63,.45);}',
      '.pin-hud-mult{font-size:clamp(16px,4vw,22px);color:var(--neon);text-shadow:0 0 12px rgba(57,255,20,.5);}',
      '.pin-hud-balls{font-size:clamp(14px,3.4vw,18px);color:var(--leaf);letter-spacing:2px;}',
      '.pin-hud-side{font-size:clamp(14px,3.4vw,20px);color:var(--aqua);text-shadow:0 0 10px rgba(51,230,208,.4);}',
      '.pin-hud-side.pin-urgent{color:var(--danger-2);animation:pin-pulse .7s infinite;}',
      '.pin-prog{text-align:center;font-size:11px;font-weight:800;color:var(--muted);letter-spacing:.4px;}',
      /* Tisch */
      '.pin-stage{position:relative;margin:0 auto;aspect-ratio:460 / 720;',
      'width:min(92vw,360px,calc((100vh - 260px) * 0.639));',
      'width:min(92vw,360px,calc((100svh - 260px) * 0.639));min-width:224px;}',
      '.pin-canvas{display:block;width:100%;height:100%;border-radius:18px;',
      'border:2px solid rgba(57,255,20,.35);background:#04140c;',
      'box-shadow:0 0 40px rgba(57,255,20,.2),inset 0 0 60px rgba(57,255,20,.05);',
      'touch-action:none;user-select:none;-webkit-user-select:none;-webkit-tap-highlight-color:transparent;}',
      /* Meldung ueber dem Tisch */
      '.pin-msg{position:absolute;left:50%;top:26%;transform:translate(-50%,-50%) scale(.9);',
      'padding:8px 14px;border-radius:12px;background:rgba(4,16,10,.9);border:1px solid var(--stroke-2);',
      'color:var(--leaf);font-weight:900;font-size:clamp(12px,3vw,15px);white-space:nowrap;',
      'text-shadow:0 0 10px rgba(57,255,20,.5);opacity:0;pointer-events:none;transition:opacity .18s ease,transform .18s ease;}',
      '.pin-msg.pin-msg-on{opacity:1;transform:translate(-50%,-50%) scale(1);animation:pin-pop .3s ease;}',
      /* Steuerknoepfe */
      '.pin-pad{display:flex;gap:8px;justify-content:center;align-items:stretch;}',
      '.pin-fbtn{flex:1;min-height:52px;font-size:20px;font-weight:900;border-radius:14px;',
      'touch-action:none;user-select:none;-webkit-user-select:none;-webkit-tap-highlight-color:transparent;}',
      '.pin-fbtn-l,.pin-fbtn-r{max-width:110px;border:1px solid var(--stroke-2);color:var(--neon);',
      'background:linear-gradient(180deg,rgba(57,255,20,.14),rgba(4,22,12,.9));}',
      '.pin-fbtn-l:active,.pin-fbtn-r:active{background:linear-gradient(180deg,rgba(57,255,20,.5),rgba(57,255,20,.2));color:#04160c;}',
      '.pin-fbtn-p{font-size:14px;border:1px solid rgba(255,210,63,.45);color:var(--gold);',
      'background:linear-gradient(180deg,rgba(255,210,63,.12),rgba(4,22,12,.9));}',
      '.pin-fbtn-p:active{background:linear-gradient(180deg,rgba(255,210,63,.45),rgba(255,210,63,.18));color:#04160c;}',
      '.pin-hint{text-align:center;margin:0;font-size:11px;line-height:1.45;}',
      /* Animationen */
      '@keyframes pin-pulse{0%,100%{opacity:1}50%{opacity:.4}}',
      '@keyframes pin-pop{0%{transform:translate(-50%,-50%) scale(.7)}60%{transform:translate(-50%,-50%) scale(1.08)}100%{transform:translate(-50%,-50%) scale(1)}}',
      '@media (max-width:520px){.pin-side{flex:1 1 100%;max-width:360px;margin:0 auto;}}'
    ].join(''));
  }
})();
