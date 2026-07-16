/* curvefever.js — "Achtung die Kurve": Leuchtwürmer im Neon-Dschungel.
 *
 * SPIELIDEE: Jeder Spieler ist ein Wurm, der ununterbrochen vorwärts kriecht.
 *   Gelenkt wird nur nach links/rechts. Hinter jedem Wurm bleibt seine Spur als
 *   tödliche Wand liegen — wer eine Spur (auch die eigene) oder den Rand berührt,
 *   ist für die Runde raus. In unregelmäßigen Abständen setzt jede Spur kurz aus
 *   (Lücke) — genau dort kann man durchschlüpfen. Letzter Überlebender gewinnt
 *   die Runde. Gespielt wird bis 5 Rundensiege.
 *
 * STEUERUNG: ← / → oder A / D · am Handy die beiden großen Flächen links/rechts
 *   der Spielfläche gedrückt halten.
 *
 * PUNKTE: Multiplayer = Rundensiege (room.reportScore). Solo = Rundensiege ×1000
 *   + 120 je überlebtem Gegner + 8 je überlebter Sekunde, mal Schwierigkeitsfaktor
 *   (Bestwert in App.Storage 'best_curvefever').
 *
 * SYNC-MODELL (multi): jeder simuliert NUR seinen eigenen Wurm und meldet ~15×/s
 *   per room.reportState({ r, s, x, y, a, al, i0, p }) Position/Winkel/Lebt sowie
 *   die NEUEN Spurpunkte als kurze Zahlenliste [x,y,break, x,y,break, …] — nie die
 *   ganze Historie. i0 = Index des ersten mitgeschickten Punkts im Sender-Zählwerk,
 *   s = laufende Nummer: damit erkennt der Empfänger doppelte Updates (überspringen)
 *   und verlorene Updates (kurze Strecken werden gerade überbrückt, große Sprünge
 *   werden als Lücke behandelt, damit keine Phantom-Wand entsteht). Alle zeichnen
 *   alle Spuren, jeder prüft seine Kollision selbst gegen die empfangenen Punkte
 *   (Uniform-Grid als Beschleuniger). Der Host entscheidet nur Rundensieger,
 *   Punktestand und Rundenwechsel über room.setShared({cf:{…}}) — Rundenstart und
 *   Startpositionen ergeben sich deterministisch aus (seed, round).
 *
 * Alle Timer laufen über Wall-Clock (Date.now bzw. room.now), rAF zeichnet nur.
 * cleanup() beendet Loop, Timeouts, Listener und meldet alle room.on wieder ab. */
(function () {
  'use strict';
  window.App = window.App || {}; App.Minigames = App.Minigames || {};
  var UI = App.UI, el = UI.el;

  /* ---------- virtuelles Spielfeld (Canvas skaliert per CSS) ---------- */
  var W = 760, H = 520, TAU = Math.PI * 2;
  var SPEED = 108;              // px/s Vorwärtstempo
  var TURN = 2.6;               // rad/s Lenkrate (Kurvenradius ≈ 41 px)
  var HR = 2.8;                 // Kopfradius
  var LINE_W = 5;               // Spurbreite
  var HIT = 4.9, HIT2 = HIT * HIT;
  var SPACING = 4.5;            // Abstand zweier Spurpunkte
  var SKIP = 5;                 // so viele eigene Punkte hinter dem Kopf ignorieren
  var CELL = 16, COLS = Math.ceil(W / CELL), ROWS = Math.ceil(H / CELL);
  var WALL = 10;                // Randzone (Tod)
  var WIN_ROUNDS = 5;
  var ROUND_CAP = 90;           // s Notbremse pro Runde
  var REPORT_MS = 66;           // ≈15 Meldungen/s
  var PROBE_STEP = 6;           // px je Vorausschau-Schritt der Bots
  var GAP_EVERY_MIN = 1500, GAP_EVERY_MAX = 3200;   // ms bis zur nächsten Lücke
  var GAP_DUR_MIN = 210, GAP_DUR_MAX = 300;         // ms Lückendauer (≈23–32 px)
  var COLORS = ['#39ff14', '#33e6d0', '#ffd23f', '#ff4d6d', '#b47dff', '#ff9a3c'];
  var BOT_NAMES = ['Nessa', 'Zephyr', 'Kobra'];
  var LEVELS = [
    { key: 'easy', name: 'Leicht', icon: '🌱', steps: 12, react: 190, jit: 120, err: 0.16, mult: 1, desc: '3 gemütliche Würmer, die öfter mal patzen' },
    { key: 'normal', name: 'Normal', icon: '⚡', steps: 15, react: 120, jit: 80, err: 0.07, mult: 1.4, desc: 'Sie schauen voraus und weichen sauber aus' },
    { key: 'hard', name: 'Schwer', icon: '🔥', steps: 19, react: 70, jit: 50, err: 0.025, mult: 1.9, desc: 'Blitzschnell, weitsichtig, fast fehlerfrei' }
  ];

  /* deterministischer Zufall — gleiche Startaufstellung auf allen Geräten */
  function mulberry32(a) {
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  injectStyle();

  App.Minigames.curvefever = {
    id: 'curvefever', title: 'Achtung die Kurve', icon: '🐍', order: 109,
    subtitle: 'Leuchtspuren ausweichen – letzter Wurm gewinnt',
    single: true, multi: true, minPlayers: 2, maxPlayers: 6,

    render: function (root, ctx) {
      var isMulti = ctx.mode === 'multi';
      var room = isMulti ? ctx.room : null;
      var nowFn = isMulti ? function () { return room.now(); } : function () { return Date.now(); };

      /* ---------- Laufzeit ---------- */
      var dead = false, loopOn = false, raf = null;
      var stops = [], pending = [], listeners = [];
      var refs = null, tctx = null, fctx = null;

      var worms = [], wormById = {}, myWorm = null;
      var grid = new Array(COLS * ROWS), parts = [];
      var roundNo = 0, curSeed = 0, roundStartAt = 0, roundOver = true, matchOver = false;
      var roundTimerStop = null, resultSent = false;
      var lastFrame = 0, lastCd = -1, ovKey = '', boardSig = '', statusSig = '';
      var padLOn = false, padROn = false;
      var keys = { l: false, r: false };

      /* Multiplayer */
      var cfLocal = null, seq = 0, lastReport = 0, pendingPts = [], sentCount = 0, lastScoreSent = -1;
      /* Solo */
      var level = LEVELS[1], soloStats = { outlived: 0, surv: 0 };

      /* ---------- Aufräum-Helfer ---------- */
      function after(ms, fn) { var t = setTimeout(function () { if (!dead) fn(); }, ms); pending.push(t); return t; }
      function clearPending() { pending.forEach(clearTimeout); pending = []; }
      function stopHelpers() { stops.forEach(function (f) { try { f(); } catch (e) {} }); stops = []; }
      function addL(t, ty, fn, o) { t.addEventListener(ty, fn, o); listeners.push({ t: t, ty: ty, fn: fn, o: o }); }
      function removeListeners() { listeners.forEach(function (l) { try { l.t.removeEventListener(l.ty, l.fn, l.o); } catch (e) {} }); listeners = []; }
      function stopLoop() { loopOn = false; if (raf) { cancelAnimationFrame(raf); raf = null; } }
      function stopRoundTimer() { if (roundTimerStop) { try { roundTimerStop(); } catch (e) {} roundTimerStop = null; } }
      function cleanup() { dead = true; stopLoop(); stopRoundTimer(); clearPending(); stopHelpers(); removeListeners(); }

      /* ---------- Start: multi exakt nach dem reflex.js-Muster ---------- */
      if (isMulti) {
        var snap = ctx.room.snapshot() || {};
        var startAt = (snap.round && snap.round.startAt) || (ctx.room.now() + 3000);
        stops.push(App.MG.countdown(root, startAt, function () { playMulti(); }, ctx.room.now));
      } else {
        chooseLevel();
      }
      return { cleanup: cleanup };

      /* ================================================================
       *  GRID + KOLLISION
       * ================================================================ */
      function gridAdd(p) {
        var cx = Math.floor(p.x / CELL), cy = Math.floor(p.y / CELL);
        if (cx < 0 || cy < 0 || cx >= COLS || cy >= ROWS) return;
        var k = cy * COLS + cx, a = grid[k];
        if (!a) { a = []; grid[k] = a; }
        a.push(p);
      }
      /* Trifft ein Kopf bei (x,y) eine Spur? Eigene Punkte ab skipFrom zählen nicht. */
      function hits(x, y, owner, skipFrom) {
        var x0 = Math.floor((x - HIT) / CELL), x1 = Math.floor((x + HIT) / CELL);
        var y0 = Math.floor((y - HIT) / CELL), y1 = Math.floor((y + HIT) / CELL);
        if (x0 < 0) x0 = 0; if (y0 < 0) y0 = 0;
        if (x1 >= COLS) x1 = COLS - 1; if (y1 >= ROWS) y1 = ROWS - 1;
        for (var cy = y0; cy <= y1; cy++) {
          for (var cx = x0; cx <= x1; cx++) {
            var a = grid[cy * COLS + cx];
            if (!a) continue;
            for (var i = 0; i < a.length; i++) {
              var p = a[i];
              if (p.o === owner && p.i >= skipFrom) continue;
              var dx = p.x - x, dy = p.y - y;
              if (dx * dx + dy * dy < HIT2) return true;
            }
          }
        }
        return false;
      }
      function outside(x, y) { return x < WALL || x > W - WALL || y < WALL || y > H - WALL; }

      /* ================================================================
       *  WÜRMER, SPUR, PHYSIK
       * ================================================================ */
      function makeWorm(id, name, idx, opts) {
        var w = {
          id: id, name: name, idx: idx, color: COLORS[idx % COLORS.length],
          local: !!(opts && opts.local), bot: !!(opts && opts.bot), gone: false,
          x: 0, y: 0, a: 0, steer: 0, alive: false, wins: 0,
          pts: [], drawn: 0, lpx: 0, lpy: 0, recv: 0, seenSeq: -1,
          gapUntil: 0, nextGapAt: 0,
          tx: 0, ty: 0, ta: 0, lastAt: 0,
          aiNext: 0, wander: 0, wanderAt: 0
        };
        return w;
      }
      function pushPt(w, x, y, b) {
        var p = { x: x, y: y, b: (w.pts.length === 0 ? 1 : (b ? 1 : 0)), o: w.idx, i: w.pts.length };
        w.pts.push(p); gridAdd(p);
        w.lpx = x; w.lpy = y;
      }
      /* eigener Punkt: wird gesetzt UND (multi) für die nächste Meldung vorgemerkt */
      function addPoint(w, x, y, brk) {
        var px = Math.round(x), py = Math.round(y);
        var b = (brk || w.pts.length === 0) ? 1 : 0;
        pushPt(w, px, py, b);
        if (w.local && isMulti) pendingPts.push(px, py, b);
      }
      /* empfangener Punkt: kurze Löcher gerade überbrücken, große Sprünge = Lücke */
      function feedPt(w, x, y, b) {
        var brk = b ? 1 : 0;
        if (!brk && w.pts.length) {
          var dx = x - w.lpx, dy = y - w.lpy, d = Math.sqrt(dx * dx + dy * dy);
          if (d > 70) brk = 1;
          else if (d > SPACING * 1.6) {
            var steps = Math.floor(d / SPACING);
            for (var s = 1; s < steps; s++) {
              pushPt(w, Math.round(w.lpx + dx * s / steps), Math.round(w.lpy + dy * s / steps), 0);
            }
          }
        }
        pushPt(w, x, y, brk);
      }
      /* Lücken-Takt + Punktabstand (nur für selbst simulierte Würmer) */
      function updateTrail(w, t) {
        if (w.gapUntil) {
          if (t >= w.gapUntil) {
            w.gapUntil = 0;
            w.nextGapAt = t + GAP_EVERY_MIN + Math.random() * (GAP_EVERY_MAX - GAP_EVERY_MIN);
            addPoint(w, w.x, w.y, 1);
          }
          return;
        }
        if (t >= w.nextGapAt) { w.gapUntil = t + GAP_DUR_MIN + Math.random() * (GAP_DUR_MAX - GAP_DUR_MIN); return; }
        var dx = w.x - w.lpx, dy = w.y - w.lpy;
        if (dx * dx + dy * dy >= SPACING * SPACING) addPoint(w, w.x, w.y, 0);
      }
      /* Bewegung in Teilschritten -> auch bei Lag-Spitzen kein Durchtunneln */
      function stepWorm(w, dt, t) {
        var sub = Math.ceil(SPEED * dt / 3); if (sub < 1) sub = 1;
        var sdt = dt / sub;
        for (var i = 0; i < sub; i++) {
          w.a += w.steer * TURN * sdt;
          w.x += Math.cos(w.a) * SPEED * sdt;
          w.y += Math.sin(w.a) * SPEED * sdt;
          if (outside(w.x, w.y)) { killWorm(w, t); return; }
          if (hits(w.x, w.y, w.idx, w.pts.length - SKIP)) { killWorm(w, t); return; }
          updateTrail(w, t);
        }
      }
      function killWorm(w, t) {
        if (!w.alive) return;
        w.alive = false; w.deathT = t;
        boom(w.x, w.y, w.color);
        if (w.local) {
          if (App.Audio) App.Audio.sfx('explosion');
          if (isMulti) report(t, true);
          setStatus('💥 Erwischt! Schau zu, wer die Runde holt.', 'bad');
        } else {
          if (App.Audio) App.Audio.sfx('pop');
          if (!isMulti && myWorm && myWorm.alive) soloStats.outlived++;
        }
        updateBoard();
      }
      function remoteKill(w) {
        if (!w.alive) return;
        w.alive = false;
        boom(w.x, w.y, w.color);
        if (App.Audio) App.Audio.sfx('pop');
        updateBoard();
      }
      function aliveWorms() {
        return worms.filter(function (w) { return w.alive && !w.gone; });
      }

      /* ================================================================
       *  BOT-KI — Vorausschau per Probe-Strahl, mit Charakter und Patzern
       * ================================================================ */
      function probe(w, steer, steps) {
        var x = w.x, y = w.y, a = w.a, d = 0;
        var skipFrom = w.pts.length - SKIP;
        var da = steer * TURN * (PROBE_STEP / SPEED);
        for (var s = 0; s < steps; s++) {
          a += da;
          x += Math.cos(a) * PROBE_STEP;
          y += Math.sin(a) * PROBE_STEP;
          if (outside(x, y)) return d;
          if (hits(x, y, w.idx, skipFrom)) return d;
          d += PROBE_STEP;
        }
        return d;
      }
      function botThink(w, t) {
        if (t < w.aiNext) return;
        w.aiNext = t + level.react + Math.random() * level.jit;
        if (t >= w.wanderAt) {
          w.wanderAt = t + 900 + Math.random() * 1400;
          w.wander = [-0.5, 0, 0, 0.5][Math.floor(Math.random() * 4)];
        }
        var cands = [-1, -0.55, 0, 0.55, 1];
        var maxD = level.steps * PROBE_STEP;
        var best = 0, bestSc = -1, straight = 0, i, d, sc;
        for (i = 0; i < cands.length; i++) {
          d = probe(w, cands[i], level.steps);
          if (cands[i] === 0) straight = d;
          sc = d + (cands[i] === 0 ? PROBE_STEP * 1.2 : 0) - Math.abs(cands[i]) * PROBE_STEP * 0.35;
          if (sc > bestSc) { bestSc = sc; best = cands[i]; }
        }
        /* Freie Bahn -> gemütlich schlängeln statt stur geradeaus */
        if (straight >= maxD - 0.01 && w.wander !== 0 && probe(w, w.wander, level.steps) >= maxD - 0.01) {
          w.steer = w.wander; return;
        }
        /* menschlicher Patzer */
        if (Math.random() < level.err) { w.steer = cands[Math.floor(Math.random() * cands.length)]; return; }
        w.steer = best;
      }

      /* ================================================================
       *  PARTIKEL
       * ================================================================ */
      function boom(x, y, color) {
        for (var i = 0; i < 16; i++) {
          var a = Math.random() * TAU, sp = 40 + Math.random() * 140;
          parts.push({ x: x, y: y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, t: 0, life: 0.5 + Math.random() * 0.45, c: color, r: 1.4 + Math.random() * 2.2 });
        }
      }
      function stepParts(dt) {
        var damp = Math.pow(0.2, dt);
        for (var i = parts.length - 1; i >= 0; i--) {
          var p = parts[i];
          p.t += dt;
          if (p.t >= p.life) { parts.splice(i, 1); continue; }
          p.x += p.vx * dt; p.y += p.vy * dt;
          p.vx *= damp; p.vy *= damp;
        }
      }

      /* ================================================================
       *  RUNDE AUFBAUEN
       * ================================================================ */
      function spawnPoints(rnd, n) {
        var out = [], tries = 0;
        while (out.length < n && tries < 900) {
          tries++;
          var x = 80 + rnd() * (W - 160), y = 80 + rnd() * (H - 160), ok = true;
          for (var i = 0; i < out.length; i++) {
            var dx = out[i].x - x, dy = out[i].y - y;
            if (dx * dx + dy * dy < 130 * 130) { ok = false; break; }
          }
          if (!ok) continue;
          out.push({ x: x, y: y, a: Math.atan2(H / 2 - y, W / 2 - x) + (rnd() - 0.5) * 1.6 });
        }
        while (out.length < n) {
          var fx = 80 + rnd() * (W - 160), fy = 80 + rnd() * (H - 160);
          out.push({ x: fx, y: fy, a: Math.atan2(H / 2 - fy, W / 2 - fx) + (rnd() - 0.5) * 1.6 });
        }
        return out;
      }
      function setupRound(n, seed, startAt) {
        stopRoundTimer();
        roundNo = n; curSeed = seed; roundStartAt = startAt;
        roundOver = false; resultSent = false; lastCd = -1;
        grid = new Array(COLS * ROWS); parts = [];
        pendingPts = []; sentCount = 0;
        var rnd = mulberry32((seed >>> 0) + n * 7919);
        var sp = spawnPoints(rnd, worms.length);
        worms.forEach(function (w, i) {
          w.x = sp[i].x; w.y = sp[i].y; w.a = sp[i].a;
          w.tx = w.x; w.ty = w.y; w.ta = w.a; w.lastAt = startAt;
          w.alive = !w.gone; w.steer = 0; w.pts = []; w.drawn = 0; w.recv = 0;
          w.lpx = w.x; w.lpy = w.y; w.deathT = 0;
          w.gapUntil = 0;
          w.nextGapAt = startAt + 1400 + Math.random() * 1800;
          w.aiNext = 0; w.wander = 0; w.wanderAt = 0;
        });
        paintBackground();
        if (refs) refs.roundEl.textContent = 'Runde ' + roundNo;
        setStatus(myWorm ? 'Lenk mit ← → oder A / D um jede Spur herum.' : 'Du schaust zu – nächste Runde bist du dabei.', myWorm ? '' : 'info');
        updateBoard();
        /* Notbremse: die Runde kann nicht ewig laufen. Während des Countdowns
           bleibt die Anzeige bei der vollen Rundenzeit stehen. */
        roundTimerStop = App.MG.roundTimer(startAt + ROUND_CAP * 1000, function (left) {
          if (!refs) return;
          refs.timerEl.textContent = App.MG.mmss(Math.min(left, ROUND_CAP));
          refs.timerEl.classList.toggle('crv-urgent', left <= 15);
        }, onRoundCap, isMulti ? room.now : null);
      }
      function onRoundCap() {
        if (dead || roundOver) return;
        if (isMulti) { if (room.isHost()) hostResult(null); }
        else showRoundResult(null);
      }

      /* ================================================================
       *  RUNDENENDE / MATCHENDE
       * ================================================================ */
      function leaderWins() {
        var mx = 0;
        worms.forEach(function (w) { if (w.wins > mx) mx = w.wins; });
        return mx;
      }
      function showRoundResult(winnerId) {
        if (roundOver || dead) return;
        roundOver = true;
        stopRoundTimer();
        var w = winnerId ? wormById[winnerId] : null;
        if (!isMulti && w) w.wins++;
        var mine = !!(w && w.local);
        setOverlay(w ? (mine ? '🏆' : '🐍') : '🤝',
          w ? (mine ? 'Du gewinnst Runde ' + roundNo + '!' : w.name + ' gewinnt Runde ' + roundNo)
            : 'Runde ' + roundNo + ' endet unentschieden', true);
        if (App.Audio) App.Audio.sfx(mine ? 'levelup' : 'ding');
        updateBoard();
        var over = leaderWins() >= WIN_ROUNDS;
        if (isMulti) {
          if (room.isHost()) after(2000, hostAdvance);
        } else {
          after(over ? 1700 : 2200, function () {
            if (over) return soloEnd();
            setupRound(roundNo + 1, (Math.random() * 1e9) | 0, Date.now() + 2800);
          });
        }
      }
      function soloEnd() {
        stopLoop(); stopRoundTimer(); clearPending(); stopHelpers(); removeListeners();
        var wins = myWorm ? myWorm.wins : 0;
        var s = Math.round((wins * 1000 + soloStats.outlived * 120 + Math.floor(soloStats.surv) * 8) * level.mult);
        var best = App.Storage.get('best_curvefever', 0);
        var nb = s > best;
        if (nb) App.Storage.set('best_curvefever', s);
        if (App.Audio) App.Audio.sfx(wins >= WIN_ROUNDS ? 'win' : 'lose');
        App.MG.endScreen(root, {
          score: s, best: best, newBest: nb,
          title: wins >= WIN_ROUNDS ? '🏆 Match gewonnen!' : '🏁 Match vorbei',
          label: wins + ' Rundensiege · ' + level.name + (nb ? ' · neuer Rekord! 🎉' : ' · Bestwert: ' + App.MG.fmt(best)),
          onExit: ctx.onExit,
          onAgain: function () { startSolo(level); }
        });
      }
      function showMatchEnd(winnerId) {
        if (matchOver || dead) return;
        matchOver = true; roundOver = true;
        stopRoundTimer(); clearPending();
        var w = wormById[winnerId];
        var mine = !!(w && w.local);
        setOverlay(mine ? '🏆' : '🏁', (w ? w.name : 'Niemand') + ' gewinnt das Match!', true);
        if (App.Audio) App.Audio.sfx(mine ? 'win' : 'lose');
        after(1400, function () {
          stopLoop(); stopHelpers(); removeListeners();
          App.MG.endScreen(root, { players: room.players(), meId: ctx.me.id, onExit: ctx.onExit });
        });
      }

      /* ================================================================
       *  MULTIPLAYER
       * ================================================================ */
      function playMulti() {
        if (dead) return;
        buildStage();
        attachInput();
        var sh = (room.snapshot() && room.snapshot().shared) || null;
        var onShared = function (s) { if (!dead && s && s.cf) applyCf(s.cf); };
        var onPlayers = function () { if (!dead) syncPlayers(); };
        room.on('shared', onShared);
        room.on('players', onPlayers);
        stops.push(function () { room.off('shared', onShared); room.off('players', onPlayers); });

        if (sh && sh.cf) applyCf(sh.cf);
        else if (room.isHost()) hostStartFirst();
        else setOverlay('⏳', 'Warte auf den Host …', true);

        loopOn = true; lastFrame = nowFn();
        raf = requestAnimationFrame(frame);
      }
      function hostStartFirst() {
        var order = room.players().map(function (p) { return p.id; });
        var cf = { r: 1, seed: (Math.random() * 1e9) | 0, startAt: room.now() + 2200, order: order, scores: {}, result: null, over: null };
        cfLocal = cf;
        try { room.setShared({ cf: cf }); } catch (e) {}
        applyCf(cf);
      }
      /* Alles, was vom Host kommt, hier hinein — idempotent (Events feuern oft). */
      function applyCf(cf) {
        if (!cf || dead) return;
        cfLocal = cf;
        if (typeof cf.r === 'number' && (cf.r !== roundNo || cf.seed !== curSeed)) {
          buildMultiWorms(cf.order || []);
          setupRound(cf.r, cf.seed, cf.startAt || room.now() + 1500);
        }
        syncScores(cf);
        if (cf.over) { showMatchEnd(cf.over); return; }
        if (cf.result && cf.result.round === roundNo && !roundOver) showRoundResult(cf.result.winner || null);
      }
      function syncScores(cf) {
        var sc = cf.scores || {};
        worms.forEach(function (w) { w.wins = sc[w.id] || 0; });
        var mine = sc[ctx.me.id] || 0;
        if (mine !== lastScoreSent) { lastScoreSent = mine; try { room.reportScore(mine); } catch (e) {} }
        updateBoard();
      }
      function buildMultiWorms(order) {
        var ps = room.players();
        worms = []; wormById = {}; myWorm = null;
        order.forEach(function (id, i) {
          var p = null, k;
          for (k = 0; k < ps.length; k++) if (ps[k].id === id) { p = ps[k]; break; }
          var w = makeWorm(id, (p && p.name) || 'Spieler', i, { local: id === ctx.me.id });
          w.gone = !p;
          worms.push(w); wormById[id] = w;
          if (w.local) myWorm = w;
        });
      }
      function syncPlayers() {
        var ps = room.players(), seen = {}, i, w;
        for (i = 0; i < ps.length; i++) {
          seen[ps[i].id] = 1;
          w = wormById[ps[i].id];
          if (!w) continue;
          if (ps[i].name) w.name = ps[i].name;
          if (!w.local) ingest(w, ps[i].state);
        }
        for (i = 0; i < worms.length; i++) {
          w = worms[i];
          if (!w.local && !seen[w.id] && !w.gone) { w.gone = true; w.alive = false; }
        }
        updateBoard();
      }
      /* Fremd-Zustand übernehmen: Kopf + nur die neuen Spurpunkte */
      function ingest(w, st) {
        if (!st || st.r !== roundNo) return;
        if (typeof st.s === 'number') {
          if (st.s <= w.seenSeq) return;
          w.seenSeq = st.s;
        }
        w.tx = st.x; w.ty = st.y; w.ta = st.a; w.lastAt = nowFn();
        var arr = st.p || [], i0 = st.i0 || 0, n = Math.floor(arr.length / 3), k;
        for (k = 0; k < n; k++) {
          var idx = i0 + k;
          if (idx < w.recv) continue;                 // schon bekannt -> überspringen
          feedPt(w, arr[k * 3], arr[k * 3 + 1], arr[k * 3 + 2]);
          w.recv = idx + 1;
        }
        if (st.al === 0) remoteKill(w);
      }
      function report(t, force) {
        if (!isMulti || !myWorm || myWorm.gone) return;
        if (!force && t - lastReport < REPORT_MS) return;
        lastReport = t; seq++;
        var st = {
          r: roundNo, s: seq, al: myWorm.alive ? 1 : 0, i0: sentCount,
          x: Math.round(myWorm.x), y: Math.round(myWorm.y), a: Math.round(myWorm.a * 100) / 100
        };
        if (pendingPts.length) { st.p = pendingPts; sentCount += pendingPts.length / 3; pendingPts = []; }
        try { room.reportState(st); } catch (e) {}
      }
      /* Nur der Host entscheidet Rundensieger + Punkte. */
      function hostCheck() {
        if (!isMulti || roundOver || resultSent || !cfLocal || cfLocal.r !== roundNo) return;
        if (!room.isHost()) return;
        var here = worms.filter(function (w) { return !w.gone; });
        if (here.length <= 1) { hostOver(here[0] ? here[0].id : ctx.me.id); return; }
        var live = aliveWorms();
        if (live.length <= 1) hostResult(live.length === 1 ? live[0].id : null);
      }
      function hostResult(winnerId) {
        if (resultSent || !cfLocal || dead) return;
        resultSent = true;
        var sc = Object.assign({}, cfLocal.scores || {});
        if (winnerId) sc[winnerId] = (sc[winnerId] || 0) + 1;
        var cf = Object.assign({}, cfLocal, { result: { round: roundNo, winner: winnerId || null }, scores: sc });
        cfLocal = cf;
        try { room.setShared({ cf: cf }); } catch (e) {}
        applyCf(cf);
      }
      function hostOver(winnerId) {
        if (!cfLocal || dead) return;
        var cf = Object.assign({}, cfLocal, { over: winnerId });
        cfLocal = cf;
        try { room.setShared({ cf: cf }); } catch (e) {}
        applyCf(cf);
      }
      function hostAdvance() {
        if (dead || matchOver || !cfLocal || !room.isHost()) return;
        var sc = cfLocal.scores || {}, champ = null, mx = 0;
        Object.keys(sc).forEach(function (id) { if (sc[id] > mx) { mx = sc[id]; champ = id; } });
        var ps = room.players();
        if (mx >= WIN_ROUNDS || ps.length <= 1) { hostOver(champ || (ps[0] ? ps[0].id : ctx.me.id)); return; }
        var cf = {
          r: roundNo + 1, seed: (Math.random() * 1e9) | 0, startAt: room.now() + 3000,
          order: ps.map(function (p) { return p.id; }), scores: sc, result: null, over: null
        };
        cfLocal = cf;
        try { room.setShared({ cf: cf }); } catch (e) {}
        applyCf(cf);
      }

      /* ================================================================
       *  SOLO
       * ================================================================ */
      function chooseLevel() {
        root.innerHTML = '';
        root.appendChild(el('div', { class: 'glass crv-lvl' }, [
          el('div', { class: 'crv-lvl-icon' }, ['🐍']),
          el('h2', { class: 'neon' }, ['Achtung die Kurve']),
          el('p', { class: 'hint-text' }, ['Du trittst gegen 3 Bot-Würmer an. Erster mit ' + WIN_ROUNDS + ' Rundensiegen gewinnt.']),
          el('div', { class: 'crv-lvl-row' }, LEVELS.map(function (lv) {
            return el('button', {
              class: 'btn ' + (lv.key === 'easy' ? 'btn-aqua' : lv.key === 'normal' ? 'btn-primary' : 'btn-danger') + ' crv-lvl-btn',
              type: 'button',
              onclick: function () { if (App.Audio) App.Audio.sfx('select'); startSolo(lv); }
            }, [
              el('span', { class: 'crv-lvl-name' }, [lv.icon + ' ' + lv.name]),
              el('span', { class: 'crv-lvl-desc' }, [lv.desc]),
              el('span', { class: 'crv-lvl-mult' }, ['Punkte ×' + lv.mult])
            ]);
          })),
          el('p', { class: 'hint-text' }, ['Steuerung: ← → oder A / D · am Handy die Flächen links & rechts halten'])
        ]));
      }
      function startSolo(lv) {
        level = lv;
        matchOver = false; soloStats = { outlived: 0, surv: 0 };
        stopLoop(); stopRoundTimer(); clearPending(); stopHelpers(); removeListeners();
        buildStage();
        attachInput();
        worms = []; wormById = {};
        var me = makeWorm('me', (ctx.me && ctx.me.name) ? ctx.me.name : 'Du', 0, { local: true });
        worms.push(me); wormById.me = me; myWorm = me;
        BOT_NAMES.forEach(function (nm, i) {
          var b = makeWorm('bot' + i, nm + ' 🤖', i + 1, { bot: true });
          worms.push(b); wormById[b.id] = b;
        });
        setupRound(1, (Math.random() * 1e9) | 0, Date.now() + 2800);
        loopOn = true; lastFrame = Date.now();
        raf = requestAnimationFrame(frame);
      }

      /* ================================================================
       *  FRAME-LOOP (Wall-Clock-Physik, rAF nur zum Zeichnen)
       * ================================================================ */
      function frame() {
        if (dead || !loopOn) { raf = null; return; }
        var t = nowFn();
        var dt = (t - lastFrame) / 1000;
        if (dt < 0) dt = 0; if (dt > 0.05) dt = 0.05;
        lastFrame = t;

        var running = roundNo > 0 && !roundOver && t >= roundStartAt;
        if (running) {
          if (myWorm && !myWorm.gone && myWorm.alive) {
            myWorm.steer = (keys.r ? 1 : 0) - (keys.l ? 1 : 0);
            stepWorm(myWorm, dt, t);
            if (myWorm.alive && !isMulti) soloStats.surv += dt;
          }
          for (var i = 0; i < worms.length; i++) {
            var w = worms[i];
            if (w.bot && w.alive) { botThink(w, t); stepWorm(w, dt, t); }
          }
          if (isMulti) { report(t, false); hostCheck(); }
          else if (aliveWorms().length <= 1) {
            var live = aliveWorms();
            showRoundResult(live.length === 1 ? live[0].id : null);
          }
        }
        smoothRemotes(dt, t);
        stepParts(dt);
        drawTrails();
        drawFx(t);
        syncOverlay(t);
        syncPads();
        raf = requestAnimationFrame(frame);
      }
      /* Fremde Köpfe: bis zum nächsten Update sanft vorausrechnen */
      function smoothRemotes(dt, t) {
        if (!isMulti) return;
        var f = Math.min(1, dt * 14);
        for (var i = 0; i < worms.length; i++) {
          var w = worms[i];
          if (w.local || w.gone) continue;
          var tx = w.tx, ty = w.ty;
          if (w.alive) {
            var e = Math.min(0.25, (t - w.lastAt) / 1000);
            if (e > 0) { tx += Math.cos(w.ta) * SPEED * e; ty += Math.sin(w.ta) * SPEED * e; }
          }
          w.x += (tx - w.x) * f; w.y += (ty - w.y) * f; w.a = w.ta;
        }
      }
      function syncOverlay(t) {
        if (roundOver || matchOver) return;
        if (roundNo === 0) { setOverlay('⏳', 'Warte auf den Host …', true); return; }
        if (t < roundStartAt) {
          var n = Math.ceil((roundStartAt - t) / 1000);
          if (n !== lastCd) { lastCd = n; if (App.Audio && n > 0 && n <= 3) App.Audio.sfx('tick'); }
          setOverlay(String(n), 'Runde ' + roundNo + (myWorm && !myWorm.gone ? '' : ' · du schaust zu'), true);
        } else if (t - roundStartAt < 700) {
          if (lastCd !== 0) { lastCd = 0; if (App.Audio) App.Audio.sfx('start'); }
          setOverlay('LOS!', '', true);
        } else {
          setOverlay('', '', false);
        }
      }
      function syncPads() {
        if (!refs) return;
        if (keys.l !== padLOn) { padLOn = keys.l; refs.padL.classList.toggle('on', padLOn); }
        if (keys.r !== padROn) { padROn = keys.r; refs.padR.classList.toggle('on', padROn); }
      }

      /* ================================================================
       *  ZEICHNEN — Spur-Canvas wächst, FX-Canvas wird jedes Bild geleert
       * ================================================================ */
      function paintBackground() {
        var g = tctx; if (!g) return;
        g.clearRect(0, 0, W, H);
        var grd = g.createRadialGradient(W / 2, H / 2, 40, W / 2, H / 2, W * 0.72);
        grd.addColorStop(0, '#082514'); grd.addColorStop(1, '#02100a');
        g.fillStyle = grd; g.fillRect(0, 0, W, H);
        g.save();
        g.strokeStyle = 'rgba(57,255,20,0.06)'; g.lineWidth = 1;
        for (var x = 40; x < W; x += 40) { g.beginPath(); g.moveTo(x + 0.5, 0); g.lineTo(x + 0.5, H); g.stroke(); }
        for (var y = 40; y < H; y += 40) { g.beginPath(); g.moveTo(0, y + 0.5); g.lineTo(W, y + 0.5); g.stroke(); }
        g.restore();
        g.save();
        g.strokeStyle = 'rgba(57,255,20,0.5)'; g.lineWidth = 4;
        g.shadowColor = 'rgba(57,255,20,0.7)'; g.shadowBlur = 16;
        g.strokeRect(WALL - 2, WALL - 2, W - 2 * (WALL - 2), H - 2 * (WALL - 2));
        g.restore();
      }
      function drawTrails() {
        var g = tctx; if (!g) return;
        for (var k = 0; k < worms.length; k++) {
          var w = worms[k];
          if (w.drawn >= w.pts.length) continue;
          g.save();
          g.strokeStyle = w.color; g.lineWidth = LINE_W; g.lineCap = 'round'; g.lineJoin = 'round';
          g.shadowColor = w.color; g.shadowBlur = 8;
          if (w.drawn === 0 && w.pts.length) {
            g.fillStyle = w.color;
            g.beginPath(); g.arc(w.pts[0].x, w.pts[0].y, LINE_W / 2, 0, TAU); g.fill();
          }
          for (var i = Math.max(1, w.drawn); i < w.pts.length; i++) {
            var a = w.pts[i - 1], b = w.pts[i];
            if (b.b) continue;
            g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke();
          }
          w.drawn = w.pts.length;
          g.restore();
        }
      }
      function drawFx(t) {
        var g = fctx; if (!g) return;
        g.clearRect(0, 0, W, H);
        var pre = roundNo > 0 && t < roundStartAt;
        for (var k = 0; k < worms.length; k++) {
          var w = worms[k];
          if (w.gone || !w.alive) continue;
          var dx = w.x - w.lpx, dy = w.y - w.lpy;
          var d = Math.sqrt(dx * dx + dy * dy);
          var conn = w.pts.length > 0 && d <= SPACING * 2.2;
          /* letztes Stück Spur bis zum Kopf -> nahtlose Linie */
          if (conn) {
            g.save();
            g.strokeStyle = w.color; g.lineWidth = LINE_W; g.lineCap = 'round';
            g.shadowColor = w.color; g.shadowBlur = 8;
            g.beginPath(); g.moveTo(w.lpx, w.lpy); g.lineTo(w.x, w.y); g.stroke();
            g.restore();
          }
          /* Kopf */
          g.save();
          g.shadowColor = w.color; g.shadowBlur = 18; g.fillStyle = '#f2fff4';
          g.beginPath(); g.arc(w.x, w.y, HR + 1.3, 0, TAU); g.fill();
          if (!conn) {   /* Lücke -> Ring als deutliche Rückmeldung */
            g.strokeStyle = w.color; g.lineWidth = 1.6; g.globalAlpha = 0.85;
            g.beginPath(); g.arc(w.x, w.y, HR + 5.5 + Math.sin(t / 90) * 1.2, 0, TAU); g.stroke();
            g.globalAlpha = 1;
          }
          g.restore();
          /* Startaufstellung: Name + Blickrichtung */
          if (pre) {
            g.save();
            g.strokeStyle = w.color; g.lineWidth = 2.5; g.globalAlpha = 0.9;
            g.beginPath(); g.moveTo(w.x, w.y);
            g.lineTo(w.x + Math.cos(w.a) * 26, w.y + Math.sin(w.a) * 26); g.stroke();
            g.font = '800 15px "Segoe UI",system-ui,Roboto,Arial,sans-serif';
            g.textAlign = 'center'; g.fillStyle = w.color;
            g.shadowColor = 'rgba(0,0,0,.8)'; g.shadowBlur = 6;
            g.fillText(w.name + (w.local ? ' (du)' : ''), w.x, w.y - 14);
            g.restore();
          }
        }
        /* Partikel */
        g.save();
        for (var i = 0; i < parts.length; i++) {
          var p = parts[i];
          g.globalAlpha = Math.max(0, 1 - p.t / p.life);
          g.fillStyle = p.c;
          g.beginPath(); g.arc(p.x, p.y, p.r, 0, TAU); g.fill();
        }
        g.restore();
      }

      /* ================================================================
       *  DOM
       * ================================================================ */
      function buildStage() {
        var roundEl = el('div', { class: 'crv-round' }, ['Runde 1']);
        var timerEl = el('div', { class: 'mg-timer crv-timer' }, [App.MG.mmss(ROUND_CAP)]);
        var goalEl = el('div', { class: 'crv-goal' }, ['Ziel: ' + WIN_ROUNDS + ' Siege' + (isMulti ? '' : ' · ' + level.name)]);
        var head = el('div', { class: 'crv-head glass' }, [roundEl, timerEl, goalEl]);

        var trailC = el('canvas', { class: 'crv-canvas', width: W, height: H });
        var fxC = el('canvas', { class: 'crv-canvas', width: W, height: H });
        var padL = el('div', { class: 'crv-pad crv-pad-l' }, [el('span', { class: 'crv-arrow' }, ['◀'])]);
        var padR = el('div', { class: 'crv-pad crv-pad-r' }, [el('span', { class: 'crv-arrow' }, ['▶'])]);
        var ovBig = el('div', { class: 'crv-ov-big' });
        var ovSub = el('div', { class: 'crv-ov-sub' });
        var overlay = el('div', { class: 'crv-overlay' }, [ovBig, ovSub]);
        var stage = el('div', { class: 'crv-stage' }, [trailC, fxC, padL, padR, overlay]);

        var status = el('div', { class: 'crv-status' }, ['']);
        var board = el('div', { class: 'crv-board glass' });
        var hint = el('p', { class: 'hint-text crv-hint' }, [
          '← → oder A / D lenken · am Handy die Flächen links & rechts halten · Spuren und Rand sind tödlich · durch die Lücken passt du durch'
        ]);
        root.innerHTML = '';
        root.appendChild(el('div', { class: 'crv-wrap' }, [head, stage, status, board, hint]));

        tctx = trailC.getContext('2d');
        fctx = fxC.getContext('2d');
        refs = { roundEl: roundEl, timerEl: timerEl, goalEl: goalEl, padL: padL, padR: padR, overlay: overlay, ovBig: ovBig, ovSub: ovSub, status: status, board: board };
        ovKey = ''; boardSig = ''; statusSig = ''; padLOn = false; padROn = false;
        paintBackground();
      }
      function setOverlay(big, sub, show) {
        if (!refs) return;
        var k = show ? (big + '|' + sub) : '';
        if (k === ovKey) return;
        ovKey = k;
        refs.ovBig.textContent = big;
        refs.ovSub.textContent = sub;
        refs.overlay.classList.toggle('show', !!show);
        if (show) { refs.ovBig.classList.remove('crv-pop'); void refs.ovBig.offsetWidth; refs.ovBig.classList.add('crv-pop'); }
      }
      function setStatus(text, cls) {
        if (!refs) return;
        var sig = text + '|' + (cls || '');
        if (sig === statusSig) return;
        statusSig = sig;
        refs.status.textContent = text;
        refs.status.className = 'crv-status' + (cls ? ' crv-' + cls : '');
      }
      function updateBoard() {
        if (!refs) return;
        var sig = worms.map(function (w) { return w.id + w.wins + (w.alive ? 1 : 0) + (w.gone ? 1 : 0) + w.name; }).join('|');
        if (sig === boardSig) return;
        boardSig = sig;
        var top = leaderWins();
        var sorted = worms.slice().sort(function (a, b) { return b.wins - a.wins; });
        refs.board.innerHTML = '';
        sorted.forEach(function (w) {
          refs.board.appendChild(el('div', {
            class: 'crv-row' + (w.local ? ' me' : '') + ((!w.alive || w.gone) ? ' out' : '')
          }, [
            el('span', { class: 'crv-dot', style: 'color:' + w.color }),
            el('span', { class: 'crv-nm' }, [w.name + (w.local ? ' (du)' : '')]),
            el('span', { class: 'crv-wins' }, [String(w.wins)]),
            w.wins > 0 && w.wins === top ? el('span', { class: 'crv-crown' }, ['👑']) : null,
            w.gone ? el('span', { class: 'crv-skull' }, ['🚪']) : (!w.alive ? el('span', { class: 'crv-skull' }, ['💀']) : null)
          ]));
        });
      }

      /* ================================================================
       *  EINGABE (Tastatur + zwei große Touch-Flächen)
       * ================================================================ */
      function attachInput() {
        removeListeners();
        keys.l = false; keys.r = false;
        var down = function (e) {
          var k = e.key;
          if (k === 'ArrowLeft' || k === 'a' || k === 'A') { keys.l = true; e.preventDefault(); }
          else if (k === 'ArrowRight' || k === 'd' || k === 'D') { keys.r = true; e.preventDefault(); }
        };
        var up = function (e) {
          var k = e.key;
          if (k === 'ArrowLeft' || k === 'a' || k === 'A') keys.l = false;
          else if (k === 'ArrowRight' || k === 'd' || k === 'D') keys.r = false;
        };
        var blur = function () { keys.l = false; keys.r = false; };
        addL(document, 'keydown', down);
        addL(document, 'keyup', up);
        addL(window, 'blur', blur);
        bindPad(refs.padL, 'l');
        bindPad(refs.padR, 'r');
      }
      function bindPad(node, side) {
        var active = false;
        var onDown = function (e) {
          e.preventDefault();
          active = true; keys[side] = true;
          if (node.setPointerCapture && e.pointerId != null) { try { node.setPointerCapture(e.pointerId); } catch (err) {} }
        };
        var onUp = function () { if (!active) return; active = false; keys[side] = false; };
        addL(node, 'pointerdown', onDown);
        addL(node, 'pointerup', onUp);
        addL(node, 'pointercancel', onUp);
        addL(node, 'pointerleave', onUp);
        addL(window, 'pointerup', onUp);
      }
    }
  };

  /* ============================ STYLES ============================ */
  function injectStyle() {
    UI.injectStyle('mg-curvefever-css', [
      '.crv-wrap{display:flex;flex-direction:column;gap:12px;}',
      /* Kopfzeile */
      '.crv-head{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 16px;}',
      '.crv-round{font-weight:900;font-size:clamp(14px,3.6vw,19px);color:var(--neon);text-shadow:0 0 12px rgba(57,255,20,.45);white-space:nowrap;}',
      '.crv-timer{font-size:clamp(15px,4vw,22px);font-variant-numeric:tabular-nums;}',
      '.mg-timer.crv-urgent{color:var(--danger-2);animation:crv-blink .7s infinite;}',
      '.crv-goal{font-size:11px;font-weight:800;letter-spacing:1.4px;text-transform:uppercase;color:var(--muted);text-align:right;}',
      /* Spielfläche */
      '.crv-stage{position:relative;width:100%;max-width:760px;margin:0 auto;aspect-ratio:760 / 520;border-radius:16px;',
      'overflow:hidden;border:2px solid rgba(57,255,20,.35);background:#02100a;',
      'box-shadow:0 0 42px rgba(57,255,20,.2),inset 0 0 60px rgba(57,255,20,.05);',
      'touch-action:none;user-select:none;-webkit-user-select:none;-webkit-tap-highlight-color:transparent;}',
      '.crv-canvas{position:absolute;top:0;left:0;width:100%;height:100%;display:block;pointer-events:none;}',
      /* Touch-/Klick-Flächen */
      '.crv-pad{position:absolute;top:0;bottom:0;width:26%;display:flex;align-items:center;justify-content:center;',
      'cursor:pointer;opacity:.3;transition:opacity .14s ease;touch-action:none;-webkit-tap-highlight-color:transparent;}',
      '.crv-pad-l{left:0;background:linear-gradient(90deg,rgba(57,255,20,.16),rgba(57,255,20,0));}',
      '.crv-pad-r{right:0;background:linear-gradient(270deg,rgba(57,255,20,.16),rgba(57,255,20,0));}',
      '.crv-pad.on{opacity:.95;}',
      '.crv-arrow{font-size:clamp(22px,5vw,34px);color:var(--neon);text-shadow:0 0 14px rgba(57,255,20,.8);}',
      /* Overlay */
      '.crv-overlay{position:absolute;top:0;left:0;right:0;bottom:0;display:flex;flex-direction:column;align-items:center;',
      'justify-content:center;gap:6px;text-align:center;padding:16px;pointer-events:none;opacity:0;transition:opacity .22s ease;',
      'background:radial-gradient(circle at 50% 50%,rgba(2,16,10,.72),rgba(2,16,10,.25) 70%);}',
      '.crv-overlay.show{opacity:1;}',
      '.crv-ov-big{font-size:clamp(38px,10vw,80px);font-weight:900;line-height:1;color:var(--neon);',
      'text-shadow:0 0 26px rgba(57,255,20,.6),0 3px 10px rgba(0,0,0,.6);}',
      '.crv-ov-sub{font-size:clamp(13px,3.4vw,19px);font-weight:800;color:var(--aqua-soft);text-shadow:0 2px 8px rgba(0,0,0,.7);}',
      '.crv-pop{animation:crv-pop .3s cubic-bezier(.2,.9,.3,1);}',
      /* Status + Rangliste */
      '.crv-status{text-align:center;font-weight:800;font-size:13px;color:var(--leaf);min-height:18px;}',
      '.crv-status.crv-bad{color:var(--danger-2);}',
      '.crv-status.crv-info{color:var(--muted);}',
      '.crv-board{display:flex;flex-wrap:wrap;gap:8px;padding:10px 12px;justify-content:center;}',
      '.crv-row{display:flex;align-items:center;gap:7px;padding:5px 11px;border-radius:11px;',
      'background:rgba(4,16,10,.55);border:1px solid var(--stroke);transition:opacity .2s ease;}',
      '.crv-row.me{border-color:var(--stroke-2);box-shadow:0 0 14px rgba(57,255,20,.18);}',
      '.crv-row.out{opacity:.4;}',
      '.crv-dot{width:11px;height:11px;border-radius:50%;background:currentColor;box-shadow:0 0 9px currentColor;flex:none;}',
      '.crv-nm{font-weight:800;font-size:13px;color:var(--silver);max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.crv-wins{font-weight:900;font-size:15px;color:var(--gold);font-variant-numeric:tabular-nums;text-shadow:0 0 10px rgba(255,210,63,.4);}',
      '.crv-crown,.crv-skull{font-size:12px;line-height:1;}',
      '.crv-hint{text-align:center;}',
      /* Schwierigkeitswahl (Solo) */
      '.crv-lvl{padding:26px 22px;display:flex;flex-direction:column;gap:12px;align-items:center;max-width:520px;margin:0 auto;text-align:center;}',
      '.crv-lvl-icon{font-size:56px;line-height:1;filter:drop-shadow(0 0 16px rgba(57,255,20,.55));animation:crv-bob 2s ease-in-out infinite;}',
      '.crv-lvl h2{margin:0;}',
      '.crv-lvl-row{display:flex;flex-direction:column;gap:10px;width:100%;max-width:340px;}',
      '.crv-lvl-btn{display:flex;flex-direction:column;gap:2px;padding:11px 14px;line-height:1.25;}',
      '.crv-lvl-name{font-weight:900;font-size:16px;}',
      '.crv-lvl-desc{font-size:11px;opacity:.85;font-weight:700;}',
      '.crv-lvl-mult{font-size:10px;letter-spacing:1.2px;text-transform:uppercase;opacity:.75;font-weight:800;}',
      /* Animationen */
      '@keyframes crv-blink{0%,100%{opacity:1}50%{opacity:.35}}',
      '@keyframes crv-pop{0%{transform:scale(.7);opacity:.3}60%{transform:scale(1.12)}100%{transform:scale(1);opacity:1}}',
      '@keyframes crv-bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-7px)}}'
    ].join(''));
  }
})();
