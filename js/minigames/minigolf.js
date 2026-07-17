/* minigolf.js — "Dschungel-Golf": Minigolf aus der Draufsicht im Neon-Dschungel.
 *
 * IDEE      : 6 handgebaute Bahnen (Wände, Bumper, Rampen, Sandgruben, Loch).
 *             Wer mit den wenigsten Schlägen durchkommt, gewinnt. Gewertet wird
 *             wie beim echten Golf gegen Par (Gesamt-Par der 6 Bahnen = 21).
 * STEUERUNG : Auf der Bahn mit Maus/Finger von der Kugel WEGZIEHEN (pointerdown/
 *             move/up) — Richtung = Gegenrichtung des Zugs, Kraft = Zugweite.
 *             Eine gestrichelte Ziellinie zeigt die Bahn inkl. zwei Bandenabprallern.
 *             Loslassen = Schlag. Alles läuft auch rein per Touch.
 * PUNKTE    : score = Par − Schläge (also höher = besser, damit Live-Rangliste,
 *             Podest und die Bestenliste ohne Sonderfall passen). Angezeigt wird
 *             die Golf-Schreibweise: "Par", "-2", "+3".  Nach Par+3 Schlägen wird
 *             ein Loch automatisch gewertet, damit niemand hängen bleibt.
 * SOLO      : feste Reihenfolge aller 6 Bahnen (damit der Rekord vergleichbar ist)
 *             gegen einen Bot in 3 Stufen (Locker/Profi/Legende), der parallel auf
 *             der Wall-Clock seine Löcher spielt. Rekord in best_minigolf.
 * SYNC      : Punkte-Rennen — alle spielen dieselben Bahnen gleichzeitig, jeder
 *             seine eigene Kugel. Start über snapshot().round.startAt + Countdown;
 *             aus demselben startAt leitet JEDER Client denselben Seed für die
 *             Bahn-Reihenfolge ab (kein Host nötig, kein Math.random in der Physik).
 *             Fortschritt via reportScore(Par-Differenz) + reportState({hole,done}).
 *             Ende, sobald alle durch sind oder die Rundenzeit abläuft.
 *             Physik komplett deterministisch, dt aus echter Uhrzeit (Tab-sicher). */
(function () {
  'use strict';
  window.App = window.App || {}; App.Minigames = App.Minigames || {};
  var UI = App.UI, el = UI.el;

  /* ---------- Virtuelles Spielfeld (Canvas skaliert per CSS) ---------- */
  var W = 760, H = 520, PAD = 16;      // Bandenrand
  var BR = 9;                          // Kugelradius
  var HOLE_R = 16;                     // Lochradius
  var MAX_POWER = 980;                 // px/s bei voller Kraft
  var MAX_DRAG = 155;                  // virtuelle px Zugweg = volle Kraft
  var FRICTION = 1.35;                 // Rasen-Dämpfung (1/s)
  var SAND_FRICTION = 6.4;             // Sandgrube bremst hart
  var REST = 0.74;                     // Banden-Elastizität
  var REST_BUMP = 1.06;                // Bumper geben Schub
  var BUMP_MIN = 230;                  // px/s Mindest-Abprall am Bumper
  var STOP_SPEED = 16;                 // px/s: darunter gilt "steht fast"
  var REST_TIME = 0.2;                 // s so lange fast still = liegt
  var CAPTURE_SPEED = 320;             // px/s: schneller fällt sie nicht rein
  var EXTRA_STROKES = 3;               // nach Par+3 wird das Loch gewertet
  var MULTI_TIME = 420;                // s Rundenzeit im Multiplayer

  /* ---------- Bahnen: [x,y,w,h] für Wände/Sand, [x,y,r] Bumper,
                        [x,y,w,h,ax,ay] Rampen (Beschleunigung in px/s²) ---------- */
  var COURSES = [
    {
      name: 'Lichtung', par: 2, tee: [100, 260], hole: [650, 260],
      walls: [[350, 16, 26, 160], [350, 344, 26, 160]],
      bumpers: [[560, 150, 18], [560, 370, 18]],
      ramps: [], sand: []
    },
    {
      name: 'Bumper-Hain', par: 3, tee: [100, 430], hole: [660, 100],
      walls: [[190, 16, 24, 150], [560, 354, 24, 150]],
      bumpers: [[280, 320, 26], [430, 220, 26], [300, 120, 22], [545, 300, 22]],
      ramps: [], sand: []
    },
    {
      name: 'Der Trichter', par: 3, tee: [90, 260], hole: [690, 260],
      walls: [[300, 16, 26, 190], [300, 314, 26, 190], [520, 110, 26, 120], [520, 290, 26, 120]],
      bumpers: [[420, 140, 20], [420, 380, 20]],
      ramps: [], sand: []
    },
    {
      name: 'Rampen-Kamm', par: 4, tee: [90, 260], hole: [680, 260],
      walls: [[560, 16, 24, 150], [560, 370, 24, 134]],
      bumpers: [],
      ramps: [[320, 16, 140, 488, -320, 0]],
      sand: [[480, 180, 80, 160]]
    },
    {
      name: 'Sandgrube', par: 4, tee: [90, 110], hole: [660, 430],
      walls: [[300, 300, 240, 24], [560, 120, 24, 200]],
      bumpers: [[190, 390, 24]],
      ramps: [],
      sand: [[250, 60, 180, 170], [420, 340, 200, 150]]
    },
    {
      name: 'Zickzack', par: 5, tee: [90, 460], hole: [690, 460],
      walls: [[180, 16, 24, 370], [340, 140, 24, 364], [500, 16, 24, 370]],
      bumpers: [[610, 180, 22]],
      ramps: [], sand: []
    }
  ];

  var PAR_TOTAL = (function () {
    var s = 0, i;
    for (i = 0; i < COURSES.length; i++) s += COURSES[i].par;
    return s;
  })();

  /* ---------- kleine Helfer ---------- */
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function hypot(x, y) { return Math.sqrt(x * x + y * y); }
  function inRect(x, y, r) { return x >= r[0] && x <= r[0] + r[2] && y >= r[1] && y <= r[1] + r[3]; }

  /* Deterministischer PRNG (nur für Bahn-Reihenfolge + Bot, NIE für die Kugel). */
  function makeRng(seed) {
    var s = (seed >>> 0) || 1;
    return function () {
      s = (s + 0x6D2B79F5) >>> 0;
      var t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  /* Reihenfolge der Bahnen aus einem Seed — alle Clients bekommen dieselbe. */
  function courseOrder(seed) {
    var idx = [], i, j, tmp, rnd = makeRng(seed);
    for (i = 0; i < COURSES.length; i++) idx.push(i);
    for (i = idx.length - 1; i > 0; i--) {
      j = Math.floor(rnd() * (i + 1));
      tmp = idx[i]; idx[i] = idx[j]; idx[j] = tmp;
    }
    return idx;
  }

  /* Golf-Schreibweise: score = Par − Schläge → Anzeige +/− relativ zum Par. */
  function golfFmt(v) {
    var d = -Math.round(Number(v) || 0);
    if (d === 0) return 'Par';
    return (d > 0 ? '+' : '') + d;
  }

  /* Kollisionsnormale einer Kugelposition gegen ein Rechteck (null = frei). */
  function rectNormal(r, x, y) {
    var cx = clamp(x, r[0], r[0] + r[2]), cy = clamp(y, r[1], r[1] + r[3]);
    var dx = x - cx, dy = y - cy, d2 = dx * dx + dy * dy;
    if (d2 >= BR * BR) return null;
    var d = Math.sqrt(d2);
    if (d > 0.0001) return { nx: dx / d, ny: dy / d, push: BR - d };
    /* Mittelpunkt steckt im Rechteck → über die kleinste Eindringtiefe rausdrücken */
    var l = x - r[0], ri = r[0] + r[2] - x, t = y - r[1], b = r[1] + r[3] - y;
    var m = Math.min(l, ri, t, b);
    if (m === l) return { nx: -1, ny: 0, push: l + BR };
    if (m === ri) return { nx: 1, ny: 0, push: ri + BR };
    if (m === t) return { nx: 0, ny: -1, push: t + BR };
    return { nx: 0, ny: 1, push: b + BR };
  }
  /* Erste Normale an einer Position (Banden + Wände + Bumper) — für die Ziellinie. */
  function blockNormalAt(course, x, y) {
    if (x < PAD + BR) return { nx: 1, ny: 0 };
    if (x > W - PAD - BR) return { nx: -1, ny: 0 };
    if (y < PAD + BR) return { nx: 0, ny: 1 };
    if (y > H - PAD - BR) return { nx: 0, ny: -1 };
    var i, n;
    for (i = 0; i < course.walls.length; i++) {
      n = rectNormal(course.walls[i], x, y);
      if (n) return n;
    }
    for (i = 0; i < course.bumpers.length; i++) {
      var b = course.bumpers[i], dx = x - b[0], dy = y - b[1], d = hypot(dx, dy);
      if (d < b[2] + BR && d > 0.0001) return { nx: dx / d, ny: dy / d };
    }
    return null;
  }

  injectStyle();

  App.Minigames.minigolf = {
    id: 'minigolf', title: 'Dschungel-Golf', icon: '⛳', order: 150,
    subtitle: 'Ziehen, zielen, einlochen – wenige Schläge!',
    single: true, multi: true, minPlayers: 2, maxPlayers: 6,

    render: function (root, ctx) {
      var isMulti = ctx.mode === 'multi';
      var nowFn = isMulti ? function () { return ctx.room.now(); } : function () { return Date.now(); };

      /* ---- Laufzeit ---- */
      var dead = false, finished = false, ended = false;   // finished = ich bin durch, ended = Endscreen steht
      var stops = [];          // stop()-Funktionen (App.MG-Bausteine, room.off, Intervalle)
      var pending = [];        // setTimeout-IDs
      var listeners = [];      // {t,ty,fn}
      var raf = null, lastT = 0;

      /* ---- Spielstand ---- */
      var order = [], holeIdx = 0, course = null;
      var strokes = 0, totalStrokes = 0, parPlayed = 0, holeState = 'play';
      var ball = { x: 0, y: 0, vx: 0, vy: 0, moving: false, rest: 0, sunk: 0 };
      var trail = [];
      var aiming = false, aimX = 0, aimY = 0, aimPow = 0, pointerId = null;
      var lastHitSfx = 0, flash = null;

      /* ---- DOM ---- */
      var canvas = null, g = null;
      var elHole = null, elPar = null, elStrokes = null, elTotal = null, elTimer = null;
      var elPowFill = null, elPowTxt = null, elMsg = null;
      var mpBoard = null;                  // App.MG.liveBoard (multi) — wandert auf den Wartebildschirm

      /* ---- Solo-Bot ---- */
      var bot = null, elBotHole = null, elBotScore = null;
      var LEVELS = {
        locker: { name: 'Locker-Bot', icon: '🙂', dist: [[-1, 0.05], [0, 0.30], [1, 0.40], [2, 0.25]] },
        profi: { name: 'Profi-Bot', icon: '😎', dist: [[-1, 0.15], [0, 0.45], [1, 0.30], [2, 0.10]] },
        legende: { name: 'Legenden-Bot', icon: '👑', dist: [[-1, 0.30], [0, 0.50], [1, 0.18], [2, 0.02]] }
      };

      /* ================= Aufräumen ================= */
      function after(ms, fn) { var t = setTimeout(function () { if (!dead) fn(); }, ms); pending.push(t); return t; }
      function clearPending() { pending.forEach(clearTimeout); pending = []; }
      function addL(t, ty, fn, o) { t.addEventListener(ty, fn, o); listeners.push({ t: t, ty: ty, fn: fn, o: o }); }
      function removeL() { listeners.forEach(function (l) { try { l.t.removeEventListener(l.ty, l.fn, l.o); } catch (e) {} }); listeners = []; }
      function stopHelpers() { stops.forEach(function (f) { try { f(); } catch (e) {} }); stops = []; }
      function stopRaf() { if (raf) { cancelAnimationFrame(raf); raf = null; } }
      function cleanup() { dead = true; stopRaf(); clearPending(); stopHelpers(); removeL(); }

      /* ================= Start ================= */
      if (isMulti) {
        var snap = ctx.room.snapshot() || {};
        var startAt = (snap.round && snap.round.startAt) || (ctx.room.now() + 3000);
        stops.push(App.MG.countdown(root, startAt, function () { playMulti(startAt); }, ctx.room.now));
      } else {
        soloIntro();
      }
      return { cleanup: cleanup };

      /* ================= SOLO ================= */
      /* Rekord = beste Par-Differenz (höher = besser ⇔ wenigste Schläge, da der
         Solo-Platz immer dieselben 6 Bahnen hat). null-Probe = "noch kein Rekord",
         damit wir Neulingen nicht "Rekord: Par" andichten. */
      function getBest() {
        return { val: App.Storage.get('best_minigolf', 0), has: App.Storage.get('best_minigolf', null) !== null };
      }
      function soloIntro() {
        var b = getBest();
        function lvlBtn(key, cls) {
          var L = LEVELS[key];
          return el('button', { class: 'btn ' + cls, type: 'button', onclick: function () {
            if (App.Audio) App.Audio.sfx('select');
            startSolo(key);
          } }, [L.icon + ' ' + L.name]);
        }
        root.innerHTML = '';
        root.appendChild(el('div', { class: 'glass glf-intro' }, [
          el('div', { class: 'glf-intro-emoji' }, ['⛳']),
          el('h2', { class: 'neon' }, ['Dschungel-Golf']),
          el('p', { class: 'hint-text' }, [
            COURSES.length + ' Bahnen · Gesamt-Par ' + PAR_TOTAL + ' · von der Kugel wegziehen und loslassen'
          ]),
          el('div', { class: 'glf-intro-best' }, [b.has
            ? '🏅 Dein Rekord: ' + golfFmt(b.val) + ' (' + (PAR_TOTAL - b.val) + ' Schläge)'
            : '🏅 Noch kein Rekord — spiel deine erste Runde!']),
          el('p', { class: 'glf-intro-l' }, ['Gegner wählen:']),
          el('div', { class: 'controls-row' }, [
            lvlBtn('locker', 'btn-ghost'), lvlBtn('profi', 'btn-aqua'), lvlBtn('legende', 'btn-primary')
          ]),
          el('div', { class: 'controls-row' }, [
            el('button', { class: 'btn btn-ghost', type: 'button', onclick: ctx.onExit }, ['Zurück'])
          ])
        ]));
      }

      function startSolo(level) {
        clearPending(); stopHelpers(); removeL(); stopRaf();
        dead = false; finished = false; ended = false;
        order = [0, 1, 2, 3, 4, 5];            // feste Reihenfolge → Rekord vergleichbar
        bot = newBot(level, Date.now());
        buildStage(null);
        stops.push(intervalStop(setInterval(function () { if (!dead) tickBot(); }, 200)));
        if (App.Audio) App.Audio.sfx('start');
        beginHole(0);
        startLoop();
      }

      function intervalStop(id) { return function () { clearInterval(id); }; }

      /* Bot: würfelt pro Loch seine Schlagzahl aus einer Stufen-Verteilung und
         braucht dafür plausibel Zeit — er spielt also parallel auf der Uhr mit. */
      function newBot(level, t0) {
        var L = LEVELS[level] || LEVELS.profi;
        var b = { level: level, name: L.name, icon: L.icon, rnd: makeRng((t0 / 7) | 0), hole: 0, strokes: 0, par: 0, doneAt: 0, done: false, dist: L.dist };
        planBotHole(b, t0);
        return b;
      }
      function planBotHole(b, t) {
        if (b.hole >= COURSES.length) { b.done = true; return; }
        var c = COURSES[order.length ? order[b.hole] : b.hole];
        var r = b.rnd(), acc = 0, delta = 0, i;
        for (i = 0; i < b.dist.length; i++) {
          acc += b.dist[i][1];
          if (r <= acc) { delta = b.dist[i][0]; break; }
        }
        b.pendingStrokes = Math.max(1, c.par + delta);
        b.pendingPar = c.par;
        b.doneAt = t + 7000 + b.pendingStrokes * 3600 + Math.floor(b.rnd() * 2500);
      }
      function tickBot() {
        if (!bot || bot.done || finished) return;
        var t = Date.now();
        var changed = false;
        while (!bot.done && t >= bot.doneAt) {
          bot.strokes += bot.pendingStrokes;
          bot.par += bot.pendingPar;
          bot.hole++;
          changed = true;
          if (bot.hole >= COURSES.length) { bot.done = true; break; }
          planBotHole(bot, bot.doneAt);
        }
        if (changed) updateBotCard();
      }
      function updateBotCard() {
        if (!bot || !elBotHole) return;
        elBotHole.textContent = bot.done ? 'fertig' : ('Loch ' + (bot.hole + 1) + '/' + COURSES.length);
        elBotScore.textContent = golfFmt(bot.par - bot.strokes);
      }

      /* ================= MULTI ================= */
      function playMulti(startAt) {
        clearPending(); stopHelpers(); removeL(); stopRaf();
        finished = false;
        order = courseOrder(Math.floor(startAt / 1000));   // identischer Seed für alle
        var board = App.MG.liveBoard(ctx.room, ctx.me.id, { format: golfFmt });
        stops.push(board.stop);
        buildStage(board.root);

        mpBoard = board;
        var endAt = startAt + MULTI_TIME * 1000;
        stops.push(App.MG.roundTimer(endAt, function (left) {
          if (!elTimer) return;
          elTimer.textContent = App.MG.mmss(left);
          if (left <= 30) elTimer.classList.add('glf-urgent');
        }, function () {
          /* Zeit um: wer noch spielt, bekommt seine offenen Bahnen gewertet,
             wer schon wartet, sieht sofort das Ergebnis. */
          if (finished) showEndMulti(); else finishRound(true);
        }, ctx.room.now));

        var pHandler = function () { checkAllDone(); };
        ctx.room.on('players', pHandler);
        stops.push(function () { ctx.room.off('players', pHandler); });

        ctx.room.reportScore(0);
        ctx.room.reportState({ hole: 0, strokes: 0, done: false });
        if (App.Audio) App.Audio.sfx('start');
        beginHole(0);
        startLoop();
      }

      /* Idempotent: läuft bei jedem players-Event (auch Heartbeat, alle 4 s) —
         baut nichts neu auf und beendet die Runde höchstens einmal. */
      function checkAllDone() {
        if (ended || dead || !isMulti) return;
        var ps = ctx.room.players();
        if (!ps.length) return;
        var all = true;
        ps.forEach(function (p) { if (!(p.state && p.state.done)) all = false; });
        if (all) showEndMulti();
      }

      /* ================= Bühne ================= */
      function buildStage(boardEl) {
        elHole = el('div', { class: 'glf-h-v glf-h-name' }, ['–']);
        elPar = el('div', { class: 'glf-h-v' }, ['–']);
        elStrokes = el('div', { class: 'glf-h-v glf-h-strokes' }, ['0']);
        elTotal = el('div', { class: 'glf-h-v glf-h-total' }, ['Par']);
        var cells = [
          el('div', { class: 'glf-h-cell glf-h-wide' }, [el('span', { class: 'glf-h-l' }, ['Bahn']), elHole]),
          el('div', { class: 'glf-h-cell' }, [el('span', { class: 'glf-h-l' }, ['Par']), elPar]),
          el('div', { class: 'glf-h-cell' }, [el('span', { class: 'glf-h-l' }, ['Schläge']), elStrokes]),
          el('div', { class: 'glf-h-cell' }, [el('span', { class: 'glf-h-l' }, ['Gesamt']), elTotal])
        ];
        if (isMulti) {
          elTimer = el('div', { class: 'mg-timer' }, [App.MG.mmss(MULTI_TIME)]);
          cells.push(el('div', { class: 'glf-h-cell' }, [el('span', { class: 'glf-h-l' }, ['Zeit']), elTimer]));
        }
        var head = el('div', { class: 'glf-head glass' }, cells);

        canvas = el('canvas', { class: 'glf-canvas', width: W, height: H });
        var stage = el('div', { class: 'glf-stage' }, [canvas]);

        elPowFill = el('div', { class: 'glf-pow-fill' });
        elPowTxt = el('div', { class: 'glf-pow-txt' }, ['0 %']);
        var bar = el('div', { class: 'glf-bar glass' }, [
          el('div', { class: 'glf-bar-hint hint-text' }, ['🎯 Von der Kugel wegziehen (Maus oder Finger) = Richtung + Kraft · loslassen = Schlag · wenige Schläge = besser']),
          el('div', { class: 'glf-pow' }, [el('div', { class: 'glf-pow-track' }, [elPowFill]), elPowTxt])
        ]);

        var side = null;
        if (boardEl) {
          side = el('div', { class: 'glf-side glass' }, [el('div', { class: 'mg-field-title' }, ['🏆 Rangliste']), boardEl]);
        } else if (bot) {
          elBotHole = el('div', { class: 'glf-bot-hole' }, ['Loch 1/' + COURSES.length]);
          elBotScore = el('div', { class: 'glf-bot-score' }, ['Par']);
          side = el('div', { class: 'glf-side glass glf-bot' }, [
            el('div', { class: 'glf-bot-icon' }, [bot.icon]),
            el('div', { class: 'glf-bot-info' }, [el('div', { class: 'glf-bot-name' }, [bot.name]), elBotHole]),
            elBotScore
          ]);
        }

        elMsg = el('div', { class: 'glf-msg' }, ['']);
        root.innerHTML = '';
        root.appendChild(el('div', { class: 'glf-wrap' }, [head, stage, elMsg, bar, side]));

        g = canvas.getContext('2d');
        attachInput();
      }

      /* ================= Eingabe (Maus + Touch über Pointer-Events) ================= */
      function toField(e) {
        var r = canvas.getBoundingClientRect();
        return { x: (e.clientX - r.left) * (W / r.width), y: (e.clientY - r.top) * (H / r.height) };
      }
      function canAim() { return !dead && !finished && holeState === 'play' && !ball.moving; }
      function attachInput() {
        addL(canvas, 'pointerdown', function (e) {
          if (!canAim()) return;
          e.preventDefault();
          aiming = true; pointerId = e.pointerId;
          try { canvas.setPointerCapture(e.pointerId); } catch (err) {}
          var p = toField(e); aimX = p.x; aimY = p.y;
          updateAim();
          if (App.Audio) App.Audio.sfx('click');
        });
        addL(canvas, 'pointermove', function (e) {
          if (!aiming || e.pointerId !== pointerId) return;
          e.preventDefault();
          var p = toField(e); aimX = p.x; aimY = p.y;
          updateAim();
        });
        function release(e) {
          if (!aiming || (e.pointerId != null && e.pointerId !== pointerId)) return;
          aiming = false; pointerId = null;
          try { canvas.releasePointerCapture(e.pointerId); } catch (err) {}
          if (aimPow > 0.06 && canAim()) shoot();
          aimPow = 0; setPower(0);
        }
        addL(canvas, 'pointerup', release);
        addL(canvas, 'pointercancel', release);
        addL(canvas, 'contextmenu', function (e) { e.preventDefault(); });
      }
      function aimVec() {
        var dx = ball.x - aimX, dy = ball.y - aimY, d = hypot(dx, dy);
        if (d < 0.001) return { x: 1, y: 0, p: 0 };
        return { x: dx / d, y: dy / d, p: clamp(d / MAX_DRAG, 0, 1) };
      }
      function updateAim() { aimPow = aimVec().p; setPower(aimPow); }
      function setPower(p) {
        if (!elPowFill) return;
        elPowFill.style.width = Math.round(p * 100) + '%';
        elPowTxt.textContent = Math.round(p * 100) + ' %';
      }
      function shoot() {
        var a = aimVec();
        ball.vx = a.x * a.p * MAX_POWER;
        ball.vy = a.y * a.p * MAX_POWER;
        ball.moving = true; ball.rest = 0;
        strokes++;
        elStrokes.textContent = String(strokes);
        elStrokes.classList.remove('glf-bump'); void elStrokes.offsetWidth; elStrokes.classList.add('glf-bump');
        if (App.Audio) { App.Audio.sfx('whoosh'); App.Audio.blip(180 + a.p * 260, 0.06); }
      }

      /* ================= Löcher ================= */
      function beginHole(i) {
        holeIdx = i;
        course = COURSES[order[i]];
        strokes = 0;
        holeState = 'play';
        ball.x = course.tee[0]; ball.y = course.tee[1];
        ball.vx = 0; ball.vy = 0; ball.moving = false; ball.rest = 0; ball.sunk = 0;
        trail = []; aiming = false; aimPow = 0; setPower(0);
        elHole.textContent = (i + 1) + '/' + COURSES.length + ' · ' + course.name;
        elPar.textContent = String(course.par);
        elStrokes.textContent = '0';
        elTotal.textContent = golfFmt(parPlayed - totalStrokes);
        showMsg('Bahn ' + (i + 1) + ': ' + course.name + ' · Par ' + course.par, 'info');
      }

      function showMsg(txt, kind) {
        if (!elMsg) return;
        elMsg.textContent = txt;
        elMsg.className = 'glf-msg glf-msg-' + (kind || 'info');
        void elMsg.offsetWidth;                 // Reflow → Einblend-Animation läuft erneut
        elMsg.classList.add('glf-msg-in');
      }

      /* Loch beendet (eingelocht oder nach Par+3 gewertet). */
      function completeHole(sunk) {
        if (holeState !== 'play') return;
        holeState = 'done';
        totalStrokes += strokes;
        parPlayed += course.par;
        var d = strokes - course.par;
        var label;
        if (!sunk) label = '🚧 Loch gewertet: ' + strokes + ' Schläge';
        else if (strokes === 1) label = '🕳️ Hole-in-One!';
        else if (d <= -2) label = '🦅 Eagle! ' + strokes + ' Schläge';
        else if (d === -1) label = '🐦 Birdie! ' + strokes + ' Schläge';
        else if (d === 0) label = '✅ Par · ' + strokes + ' Schläge';
        else if (d === 1) label = 'Bogey · ' + strokes + ' Schläge';
        else label = '+' + d + ' · ' + strokes + ' Schläge';
        showMsg(label + '  →  Gesamt ' + golfFmt(parPlayed - totalStrokes), sunk ? (d <= 0 ? 'good' : 'info') : 'bad');
        elTotal.textContent = golfFmt(parPlayed - totalStrokes);

        if (App.Audio) {
          if (!sunk) App.Audio.sfx('error');
          else if (d <= -1) App.Audio.sfx('levelup');
          else App.Audio.sfx('point');
        }
        if (isMulti) {
          ctx.room.reportScore(parPlayed - totalStrokes);
          ctx.room.reportState({ hole: holeIdx + 1, strokes: totalStrokes, done: holeIdx + 1 >= COURSES.length });
        }
        after(sunk ? 1500 : 1200, function () {
          if (holeIdx + 1 >= COURSES.length) finishRound(false);
          else beginHole(holeIdx + 1);
        });
      }

      /* ================= Physik (deterministisch, echtes dt) ================= */
      function substep(s) {
        var i, r;
        /* Rampen: konstante Beschleunigung, solange die Kugel drauf ist */
        var onRamp = false;
        for (i = 0; i < course.ramps.length; i++) {
          r = course.ramps[i];
          if (inRect(ball.x, ball.y, r)) { ball.vx += r[4] * s; ball.vy += r[5] * s; onRamp = true; }
        }
        /* Loch zieht an (Lippen-Effekt) */
        var hx = course.hole[0], hy = course.hole[1];
        var dxh = hx - ball.x, dyh = hy - ball.y, dh = hypot(dxh, dyh), pullR = HOLE_R * 2.6;
        if (dh < pullR && dh > 0.001) {
          var pull = 900 * (1 - dh / pullR);
          ball.vx += (dxh / dh) * pull * s;
          ball.vy += (dyh / dh) * pull * s;
        }
        /* Reibung (Sand bremst stark) */
        var k = FRICTION;
        for (i = 0; i < course.sand.length; i++) if (inRect(ball.x, ball.y, course.sand[i])) { k = SAND_FRICTION; break; }
        var damp = Math.exp(-k * s);
        ball.vx *= damp; ball.vy *= damp;

        ball.x += ball.vx * s; ball.y += ball.vy * s;
        collide();

        var sp = hypot(ball.vx, ball.vy);
        dh = hypot(hx - ball.x, hy - ball.y);
        if (dh < HOLE_R * 0.9 && sp < CAPTURE_SPEED) { sink(); return; }

        if (!onRamp && sp < STOP_SPEED) {
          ball.rest += s;
          if (ball.rest >= REST_TIME) { ball.vx = 0; ball.vy = 0; ball.moving = false; onRest(); }
        } else ball.rest = 0;
      }

      function collide() {
        var i, n, dot;
        /* Banden */
        if (ball.x < PAD + BR) { ball.x = PAD + BR; if (ball.vx < 0) { ball.vx = -ball.vx * REST; bandSfx(); } }
        if (ball.x > W - PAD - BR) { ball.x = W - PAD - BR; if (ball.vx > 0) { ball.vx = -ball.vx * REST; bandSfx(); } }
        if (ball.y < PAD + BR) { ball.y = PAD + BR; if (ball.vy < 0) { ball.vy = -ball.vy * REST; bandSfx(); } }
        if (ball.y > H - PAD - BR) { ball.y = H - PAD - BR; if (ball.vy > 0) { ball.vy = -ball.vy * REST; bandSfx(); } }
        /* Wände */
        for (i = 0; i < course.walls.length; i++) {
          n = rectNormal(course.walls[i], ball.x, ball.y);
          if (!n) continue;
          ball.x += n.nx * n.push; ball.y += n.ny * n.push;
          dot = ball.vx * n.nx + ball.vy * n.ny;
          if (dot < 0) { ball.vx -= (1 + REST) * dot * n.nx; ball.vy -= (1 + REST) * dot * n.ny; bandSfx(); }
        }
        /* Bumper */
        for (i = 0; i < course.bumpers.length; i++) {
          var b = course.bumpers[i];
          var dx = ball.x - b[0], dy = ball.y - b[1], d = hypot(dx, dy), rr = b[2] + BR;
          if (d >= rr) continue;
          var nx = d > 0.0001 ? dx / d : 1, ny = d > 0.0001 ? dy / d : 0;
          ball.x = b[0] + nx * rr; ball.y = b[1] + ny * rr;
          dot = ball.vx * nx + ball.vy * ny;
          if (dot < 0) {
            ball.vx -= (1 + REST_BUMP) * dot * nx;
            ball.vy -= (1 + REST_BUMP) * dot * ny;
            var sp = hypot(ball.vx, ball.vy);
            if (sp < BUMP_MIN) { ball.vx = nx * BUMP_MIN; ball.vy = ny * BUMP_MIN; }
            b.hit = Date.now();
            if (App.Audio) App.Audio.sfx('pop');
          }
        }
      }
      function bandSfx() {
        var t = Date.now();
        if (t - lastHitSfx < 90) return;
        lastHitSfx = t;
        if (App.Audio && hypot(ball.vx, ball.vy) > 90) App.Audio.blip(150, 0.03);
      }

      function sink() {
        ball.vx = 0; ball.vy = 0; ball.moving = false; ball.sunk = Date.now();
        ball.x = course.hole[0]; ball.y = course.hole[1];
        if (App.Audio) App.Audio.sfx('ding');
        completeHole(true);
      }
      /* Kugel liegt still → prüfen, ob das Loch nach Par+3 gewertet wird. */
      function onRest() {
        if (holeState !== 'play') return;
        if (strokes >= course.par + EXTRA_STROKES) completeHole(false);
      }

      /* ================= Schleife ================= */
      function startLoop() {
        lastT = Date.now();
        stopRaf();
        raf = requestAnimationFrame(frame);
      }
      function frame() {
        if (dead) return;
        var t = Date.now();
        var dt = (t - lastT) / 1000;
        lastT = t;
        if (dt > 0.25) dt = 0.25;                      // Tab-Wechsel: nicht aufholen
        if (ball.moving && holeState === 'play') {
          var rem = dt, s;
          while (rem > 0 && ball.moving) {             // feste Substeps → stabile Physik
            s = rem > 0.004 ? 0.004 : rem; rem -= s;
            substep(s);
          }
          trail.push({ x: ball.x, y: ball.y, t: t });
        }
        while (trail.length && t - trail[0].t > 420) trail.shift();
        draw(t);
        raf = requestAnimationFrame(frame);
      }

      /* ================= Zeichnen ================= */
      function draw(t) {
        if (!g || !course) return;
        /* Rasen */
        var grad = g.createRadialGradient(W / 2, H / 2, 60, W / 2, H / 2, W * 0.7);
        grad.addColorStop(0, '#0d3d22');
        grad.addColorStop(1, '#04160c');
        g.fillStyle = grad;
        g.fillRect(0, 0, W, H);
        /* Rasenstreifen */
        g.fillStyle = 'rgba(57,255,20,0.035)';
        for (var sx = PAD; sx < W - PAD; sx += 64) g.fillRect(sx, PAD, 32, H - 2 * PAD);
        /* Bande */
        g.lineWidth = 4;
        g.strokeStyle = 'rgba(57,255,20,0.5)';
        g.shadowColor = 'rgba(57,255,20,0.6)'; g.shadowBlur = 16;
        roundRect(PAD - 4, PAD - 4, W - 2 * PAD + 8, H - 2 * PAD + 8, 14);
        g.stroke();
        g.shadowBlur = 0;

        drawSand();
        drawRamps(t);
        drawHole(t);
        drawWalls();
        drawBumpers(t);
        drawTrail();
        drawBall(t);
        if (aiming && canAim()) drawAim();
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

      function drawSand() {
        course.sand.forEach(function (r) {
          g.fillStyle = 'rgba(224,138,60,0.22)';
          roundRect(r[0], r[1], r[2], r[3], 16); g.fill();
          g.strokeStyle = 'rgba(224,138,60,0.5)'; g.lineWidth = 2; g.stroke();
          g.fillStyle = 'rgba(224,138,60,0.55)';
          g.font = '600 12px system-ui, sans-serif';
          g.textAlign = 'center'; g.textBaseline = 'middle';
          g.fillText('SAND', r[0] + r[2] / 2, r[1] + r[3] / 2);
        });
      }

      function drawRamps(t) {
        course.ramps.forEach(function (r) {
          g.save();
          roundRect(r[0], r[1], r[2], r[3], 12); g.clip();
          g.fillStyle = 'rgba(51,230,208,0.12)';
          g.fillRect(r[0], r[1], r[2], r[3]);
          /* laufende Pfeil-Streifen zeigen die Schubrichtung (nur Optik) */
          var dir = r[4] < 0 ? -1 : 1;
          var off = ((t / 14) * dir) % 40;
          g.strokeStyle = 'rgba(51,230,208,0.42)'; g.lineWidth = 3;
          for (var x = r[0] - 40; x < r[0] + r[2] + 40; x += 40) {
            var px = x + off;
            g.beginPath();
            g.moveTo(px, r[1]); g.lineTo(px + dir * 18, r[1] + r[3] / 2); g.lineTo(px, r[1] + r[3]);
            g.stroke();
          }
          g.restore();
          g.strokeStyle = 'rgba(51,230,208,0.6)'; g.lineWidth = 2;
          roundRect(r[0], r[1], r[2], r[3], 12); g.stroke();
        });
      }

      function drawWalls() {
        course.walls.forEach(function (r) {
          g.shadowColor = 'rgba(57,255,20,0.45)'; g.shadowBlur = 12;
          g.fillStyle = 'rgba(10,44,26,0.96)';
          roundRect(r[0], r[1], r[2], r[3], 7); g.fill();
          g.shadowBlur = 0;
          g.strokeStyle = 'rgba(109,255,77,0.8)'; g.lineWidth = 2;
          roundRect(r[0], r[1], r[2], r[3], 7); g.stroke();
        });
      }

      function drawBumpers(t) {
        course.bumpers.forEach(function (b) {
          var age = b.hit ? (t - b.hit) : 9999;
          var kick = age < 220 ? (1 - age / 220) * 0.28 : 0;
          var r = b[2] * (1 + kick);
          g.shadowColor = 'rgba(255,210,63,0.7)'; g.shadowBlur = 16 + kick * 40;
          var gr = g.createRadialGradient(b[0], b[1] - r * 0.3, 2, b[0], b[1], r);
          gr.addColorStop(0, '#fff2b8'); gr.addColorStop(1, '#e0a516');
          g.fillStyle = gr;
          g.beginPath(); g.arc(b[0], b[1], r, 0, Math.PI * 2); g.fill();
          g.shadowBlur = 0;
          g.strokeStyle = 'rgba(255,255,255,' + (0.5 + kick) + ')'; g.lineWidth = 2;
          g.beginPath(); g.arc(b[0], b[1], r * 0.62, 0, Math.PI * 2); g.stroke();
        });
      }

      function drawHole(t) {
        var hx = course.hole[0], hy = course.hole[1];
        var pulse = 1 + Math.sin(t / 320) * 0.06;
        g.fillStyle = 'rgba(0,0,0,0.85)';
        g.beginPath(); g.arc(hx, hy, HOLE_R, 0, Math.PI * 2); g.fill();
        g.strokeStyle = 'rgba(255,210,63,0.9)'; g.lineWidth = 3;
        g.shadowColor = 'rgba(255,210,63,0.8)'; g.shadowBlur = 18 * pulse;
        g.beginPath(); g.arc(hx, hy, HOLE_R * pulse, 0, Math.PI * 2); g.stroke();
        g.shadowBlur = 0;
        /* Fahne */
        g.strokeStyle = 'rgba(230,255,230,0.9)'; g.lineWidth = 2;
        g.beginPath(); g.moveTo(hx, hy - 2); g.lineTo(hx, hy - 46); g.stroke();
        var wave = Math.sin(t / 220) * 3;
        g.fillStyle = '#ff4d6d';
        g.beginPath();
        g.moveTo(hx, hy - 46); g.lineTo(hx + 26, hy - 39 + wave); g.lineTo(hx, hy - 30);
        g.closePath(); g.fill();
      }

      function drawTrail() {
        if (trail.length < 2) return;
        for (var i = 1; i < trail.length; i++) {
          var a = i / trail.length;
          g.strokeStyle = 'rgba(125,243,230,' + (a * 0.4) + ')';
          g.lineWidth = BR * 1.1 * a;
          g.lineCap = 'round';
          g.beginPath(); g.moveTo(trail[i - 1].x, trail[i - 1].y); g.lineTo(trail[i].x, trail[i].y); g.stroke();
        }
      }

      function drawBall(t) {
        if (ball.sunk) {
          var age = t - ball.sunk;
          if (age < 300) {
            var f = 1 - age / 300;
            g.fillStyle = 'rgba(255,255,255,' + f + ')';
            g.beginPath(); g.arc(ball.x, ball.y, BR * f, 0, Math.PI * 2); g.fill();
          }
          /* Sternchen-Effekt beim Einlochen */
          var e = clamp(age / 420, 0, 1);
          if (e < 1) {
            g.strokeStyle = 'rgba(255,210,63,' + (1 - e) + ')'; g.lineWidth = 3;
            g.beginPath(); g.arc(course.hole[0], course.hole[1], HOLE_R + e * 40, 0, Math.PI * 2); g.stroke();
          }
          return;
        }
        g.shadowColor = 'rgba(0,0,0,0.6)'; g.shadowBlur = 8;
        g.fillStyle = 'rgba(0,0,0,0.4)';
        g.beginPath(); g.arc(ball.x + 2, ball.y + 3, BR, 0, Math.PI * 2); g.fill();
        g.shadowBlur = 0;
        var gr = g.createRadialGradient(ball.x - 3, ball.y - 4, 1, ball.x, ball.y, BR);
        gr.addColorStop(0, '#ffffff'); gr.addColorStop(1, '#a9e6c6');
        g.fillStyle = gr;
        g.beginPath(); g.arc(ball.x, ball.y, BR, 0, Math.PI * 2); g.fill();
        if (!ball.moving && holeState === 'play') {
          var p = 1 + Math.sin(t / 260) * 0.12;
          g.strokeStyle = 'rgba(57,255,20,0.55)'; g.lineWidth = 1.5;
          g.beginPath(); g.arc(ball.x, ball.y, BR * 2.1 * p, 0, Math.PI * 2); g.stroke();
        }
      }

      /* Ziellinie mit bis zu 2 vorausberechneten Bandenabprallern. */
      function drawAim() {
        var a = aimVec();
        if (a.p <= 0.01) return;
        var px = ball.x, py = ball.y, dx = a.x, dy = a.y;
        var len = 90 + a.p * 260, step = 7, bounces = 0, pts = [{ x: px, y: py }], i;
        for (i = 0; i < len / step; i++) {
          var nx2 = px + dx * step, ny2 = py + dy * step;
          var n = blockNormalAt(course, nx2, ny2);
          if (n) {
            pts.push({ x: px, y: py });
            var dot = dx * n.nx + dy * n.ny;
            dx -= 2 * dot * n.nx; dy -= 2 * dot * n.ny;
            bounces++;
            if (bounces > 2) break;
          } else { px = nx2; py = ny2; }
        }
        pts.push({ x: px, y: py });
        g.save();
        g.setLineDash([9, 8]);
        g.lineWidth = 2.5;
        g.strokeStyle = a.p > 0.85 ? 'rgba(255,77,109,0.95)' : 'rgba(125,243,230,0.9)';
        g.shadowColor = g.strokeStyle; g.shadowBlur = 10;
        g.beginPath(); g.moveTo(pts[0].x, pts[0].y);
        for (i = 1; i < pts.length; i++) g.lineTo(pts[i].x, pts[i].y);
        g.stroke();
        g.restore();
        /* Zugband hinter der Kugel + Kraftbogen */
        g.save();
        g.setLineDash([4, 5]);
        g.strokeStyle = 'rgba(255,255,255,0.45)'; g.lineWidth = 2;
        g.beginPath(); g.moveTo(ball.x, ball.y); g.lineTo(aimX, aimY); g.stroke();
        g.restore();
        g.strokeStyle = a.p > 0.85 ? '#ff4d6d' : '#39ff14';
        g.lineWidth = 4; g.lineCap = 'round';
        g.beginPath();
        g.arc(ball.x, ball.y, BR + 8, -Math.PI / 2, -Math.PI / 2 + a.p * Math.PI * 2);
        g.stroke();
        g.fillStyle = '#eaffe2';
        g.font = '900 13px system-ui, sans-serif';
        g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillText(Math.round(a.p * 100) + '%', ball.x, ball.y - BR - 22);
      }

      /* ================= Ende ================= */
      function finishRound(timeUp) {
        if (finished || dead) return;
        finished = true;
        stopRaf(); clearPending();
        /* Offene Löcher werden mit Par+3 gewertet (fair für alle, kein Hängenbleiben) */
        if (holeIdx < COURSES.length && holeState === 'play') {
          var i;
          for (i = holeIdx; i < COURSES.length; i++) {
            var c = COURSES[order[i]];
            var st = (i === holeIdx) ? Math.max(strokes, c.par + EXTRA_STROKES) : c.par + EXTRA_STROKES;
            totalStrokes += st; parPlayed += c.par;
          }
        }
        var score = parPlayed - totalStrokes;

        if (!isMulti) { showEndSolo(score); return; }

        ctx.room.reportScore(score);
        ctx.room.reportState({ hole: COURSES.length, strokes: totalStrokes, done: true });
        if (timeUp) {
          showMsg('⏱️ Zeit um! Offene Bahnen mit Par+' + EXTRA_STROKES + ' gewertet.', 'bad');
          after(1400, showEndMulti);
          return;
        }
        /* Selbst durch: warten, bis alle fertig sind (oder die Zeit abläuft) */
        showWaiting(score);
        checkAllDone();
      }

      /* Wartebildschirm nach der eigenen letzten Bahn — Rangliste läuft weiter. */
      function showWaiting(score) {
        if (dead || ended) return;
        elTimer = el('div', { class: 'mg-timer' }, ['']);
        var boardBox = mpBoard
          ? el('div', { class: 'glf-side glass' }, [el('div', { class: 'mg-field-title' }, ['🏆 Rangliste']), mpBoard.root])
          : null;
        root.innerHTML = '';
        root.appendChild(el('div', { class: 'glf-wait-wrap' }, [
          el('div', { class: 'glass glf-wait' }, [
            el('div', { class: 'glf-intro-emoji' }, ['🏁']),
            el('h2', { class: 'neon' }, ['Alle ' + COURSES.length + ' Bahnen gespielt!']),
            el('div', { class: 'big-readout glf-wait-score' }, [golfFmt(score)]),
            el('p', { class: 'hint-text' }, [totalStrokes + ' Schläge (Par ' + PAR_TOTAL + ') · warte auf die anderen …']),
            el('div', { class: 'glf-wait-timer' }, [el('span', { class: 'glf-h-l' }, ['Restzeit']), elTimer])
          ]),
          boardBox
        ]));
        if (App.Audio) App.Audio.sfx('cashout');
      }

      function showEndMulti() {
        if (dead || ended) return;
        ended = true;
        stopHelpers();
        App.MG.endScreen(root, {
          players: ctx.room.players(), meId: ctx.me.id, format: golfFmt, onExit: ctx.onExit
        });
      }

      function showEndSolo(score) {
        if (dead || ended) return;
        ended = true;
        /* Bot bis zum Ende durchrechnen, damit der Vergleich stimmt */
        if (bot) {
          while (!bot.done) {
            bot.strokes += bot.pendingStrokes; bot.par += bot.pendingPar; bot.hole++;
            if (bot.hole >= COURSES.length) { bot.done = true; break; }
            planBotHole(bot, bot.doneAt);
          }
        }
        stopHelpers();
        var b = getBest();
        var best = b.val;
        var nb = !b.has || score > best;          // erste Runde ist immer der erste Rekord
        if (nb) App.Storage.set('best_minigolf', score);
        var botScore = bot ? (bot.par - bot.strokes) : null;
        var duell = '';
        if (bot) {
          if (score > botScore) duell = ' · 🏆 Du schlägst den ' + bot.name + ' (' + golfFmt(botScore) + ')';
          else if (score === botScore) duell = ' · 🤝 Gleichstand mit dem ' + bot.name;
          else duell = ' · 🤖 Der ' + bot.name + ' war besser (' + golfFmt(botScore) + ')';
        }
        if (App.Audio) App.Audio.sfx(nb ? 'jackpot' : (bot && score > botScore ? 'win' : 'cashout'));
        App.MG.endScreen(root, {
          score: score, best: best, newBest: nb, format: golfFmt,
          title: nb ? (b.has ? '🎉 Neuer Rekord!' : '⛳ Dein erster Rekord!') : '🏁 Runde gespielt',
          label: totalStrokes + ' Schläge (Par ' + PAR_TOTAL + ')' +
            (nb ? ' · Rekord!' : ' · Rekord: ' + golfFmt(best) + ' (' + (PAR_TOTAL - best) + ')') + duell,
          onExit: ctx.onExit,
          onAgain: function () { totalStrokes = 0; parPlayed = 0; startSolo(bot ? bot.level : 'profi'); }
        });
      }
    }
  };

  /* ===================== STYLES ===================== */
  function injectStyle() {
    UI.injectStyle('mg-minigolf-css', [
      '.glf-wrap{display:flex;flex-direction:column;gap:10px;}',
      '.glf-head{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:9px 16px;flex-wrap:wrap;}',
      '.glf-h-cell{display:flex;flex-direction:column;gap:1px;min-width:0;}',
      '.glf-h-wide{flex:1;min-width:120px;}',
      '.glf-h-l{color:var(--muted);font-size:10px;text-transform:uppercase;letter-spacing:1.2px;}',
      '.glf-h-v{font-size:clamp(15px,3.4vw,22px);font-weight:900;line-height:1.1;color:var(--leaf);font-variant-numeric:tabular-nums;}',
      '.glf-h-name{color:var(--aqua-soft);text-shadow:0 0 10px rgba(51,230,208,.4);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      '.glf-h-strokes{color:#fff;}',
      '.glf-h-total{color:var(--gold);text-shadow:0 0 10px rgba(255,210,63,.45);}',
      '.glf-head .mg-timer{font-size:clamp(15px,3.4vw,22px);}',
      '.glf-head .mg-timer.glf-urgent{color:var(--danger-2);animation:glf-pulse .7s infinite;}',
      '.glf-bump{animation:glf-bump .28s ease;}',
      /* Bahn */
      '.glf-stage{width:100%;max-width:740px;margin:0 auto;aspect-ratio:760 / 520;}',
      '.glf-canvas{display:block;width:100%;height:100%;border-radius:18px;background:#04160c;',
      'border:2px solid rgba(57,255,20,.35);box-shadow:0 0 40px rgba(57,255,20,.2),inset 0 0 60px rgba(57,255,20,.05);',
      'touch-action:none;user-select:none;-webkit-user-select:none;-webkit-tap-highlight-color:transparent;cursor:crosshair;}',
      /* Meldungszeile */
      '.glf-msg{text-align:center;font-weight:800;font-size:clamp(12px,3vw,16px);min-height:20px;letter-spacing:.3px;}',
      '.glf-msg-info{color:var(--aqua-soft);}',
      '.glf-msg-good{color:var(--neon);text-shadow:0 0 12px rgba(57,255,20,.55);}',
      '.glf-msg-bad{color:var(--danger-2);}',
      '.glf-msg-in{animation:glf-msg .35s ease;}',
      /* Hinweis + Kraftanzeige */
      '.glf-bar{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:8px 14px;flex-wrap:wrap;}',
      '.glf-bar-hint{margin:0;flex:1;min-width:180px;text-align:left;font-size:11.5px;}',
      '.glf-pow{display:flex;align-items:center;gap:8px;}',
      '.glf-pow-track{width:clamp(90px,26vw,180px);height:10px;border-radius:999px;background:rgba(4,16,10,.85);',
      'border:1px solid var(--stroke);overflow:hidden;}',
      '.glf-pow-fill{width:0%;height:100%;border-radius:999px;background:linear-gradient(90deg,var(--aqua),var(--neon) 60%,var(--danger));transition:width .05s linear;}',
      '.glf-pow-txt{font-size:12px;font-weight:900;color:var(--leaf);min-width:42px;text-align:right;font-variant-numeric:tabular-nums;}',
      /* Seitenkarte: Rangliste / Bot */
      '.glf-side{padding:12px 14px;display:flex;flex-direction:column;gap:8px;}',
      '.glf-side .mg-scoreboard{max-height:210px;overflow-y:auto;}',
      '.glf-bot{flex-direction:row;align-items:center;gap:12px;}',
      '.glf-bot-icon{font-size:30px;filter:drop-shadow(0 0 10px rgba(51,230,208,.5));}',
      '.glf-bot-info{flex:1;min-width:0;}',
      '.glf-bot-name{font-weight:900;color:var(--aqua);font-size:14px;}',
      '.glf-bot-hole{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;}',
      '.glf-bot-score{font-size:22px;font-weight:900;color:var(--gold);font-variant-numeric:tabular-nums;text-shadow:0 0 10px rgba(255,210,63,.4);}',
      /* Startbildschirm Solo */
      '.glf-intro{padding:30px 26px;text-align:center;display:flex;flex-direction:column;gap:12px;align-items:center;max-width:520px;margin:0 auto;}',
      '.glf-intro-emoji{font-size:56px;filter:drop-shadow(0 0 16px rgba(57,255,20,.55));animation:glf-bob 2.2s ease-in-out infinite;}',
      '.glf-intro h2{margin:0;}',
      '.glf-intro-best{padding:8px 16px;border-radius:999px;background:rgba(40,32,6,.7);border:1px solid rgba(255,210,63,.4);',
      'color:var(--gold);font-weight:800;font-size:14px;}',
      '.glf-intro-l{margin:4px 0 0;color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:1.4px;}',
      /* Wartebildschirm (multi, eigene Runde durch) */
      '.glf-wait-wrap{display:flex;flex-direction:column;gap:12px;max-width:520px;margin:0 auto;}',
      '.glf-wait{padding:26px 24px;text-align:center;display:flex;flex-direction:column;gap:8px;align-items:center;}',
      '.glf-wait h2{margin:0;font-size:clamp(19px,4.6vw,26px);}',
      '.glf-wait-score{color:var(--gold);}',
      '.glf-wait-timer{display:flex;flex-direction:column;align-items:center;gap:1px;margin-top:4px;}',
      /* Animationen */
      '@keyframes glf-bump{0%{transform:scale(1)}45%{transform:scale(1.28)}100%{transform:scale(1)}}',
      '@keyframes glf-msg{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:translateY(0)}}',
      '@keyframes glf-pulse{0%,100%{opacity:1}50%{opacity:.4}}',
      '@keyframes glf-bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-7px)}}',
      '@media (max-width:560px){.glf-bar-hint{font-size:10.5px;}.glf-side .mg-scoreboard{max-height:150px;}}'
    ].join(''));
  }
})();
