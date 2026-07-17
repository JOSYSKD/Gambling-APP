/* curling.js — "Dschungel-Curling": Curling von oben auf einer Neon-Eisbahn.
 *
 * IDEE      Unten der Abwurfpunkt, oben das Haus (Zielkreise). Jeder Spieler gibt
 *           pro End mehrere Steine ab. Steine gleiten mit Reibung, laufen durch
 *           den Drall eine Kurve und stossen sich elastisch gegenseitig weg.
 * STEUERUNG Auf die Bahn ziehen (pointerdown/move/up, Maus + Touch): die Zugweite
 *           bestimmt die Kraft (1:1 = der Stein bleibt ungefaehr am Zeiger liegen),
 *           die Richtung das Ziel. Drall vorher per Chip waehlen (↺ / gerade / ↻).
 *           Die gepunktete Vorschau zeigt die Kurve + den Landepunkt.
 * PUNKTE    Curling-Wertung: nur das Team mit dem innersten Stein im Haus punktet —
 *           je einen Punkt fuer jeden eigenen Stein, der naeher am Zentrum liegt als
 *           der beste gegnerische. Gespielt werden 4 Ends. best_curling = Punkte.
 * SOLO      Gegen einen Bot mit drei Stufen. Der Bot simuliert bis zu ~200 Wuerfe
 *           durch und bewertet das Ergebnis (Draw, Takeout, Guard). 'Leicht' plant
 *           blind auf leerer Bahn (zieht nur aufs Haus), 'Profi' rechnet die Stoesse
 *           mit — im Test steht Profi gegen einen perfekt planenden Gegner 4:7:4.
 * SYNC      Rundenbasiert ueber room.shared: { order, end, throwIdx, turn, stones,
 *           shot, scores, phase, deadline }. Der Werfer rechnet seinen Wurf sofort
 *           komplett durch, teilt Wurf-Parameter (fuer die Animation) UND die
 *           Endpositionen (autoritativ). Alle animieren dieselbe deterministische
 *           Physik (fester 1/100-s-Schritt) und rasten danach auf shared.stones ein.
 *           Der Host schaltet nach der Wertung ins naechste End weiter. Zeit immer
 *           ueber room.now(); pro Wurf laeuft eine Frist, sonst wirft der Bot. */
(function () {
  'use strict';
  window.App = window.App || {}; App.Minigames = App.Minigames || {};
  var UI = App.UI, el = UI.el;

  injectStyle();

  /* ================= Bahn-Geometrie (virtuelle px, Canvas skaliert per CSS) ================= */
  var W = 520, H = 680;
  var CX = W / 2;
  var WALL = 26;                 // Seitenlinien (Mitte drueber = aus)
  var TEE_Y = 170;               // Haus-Mitte ("Button")
  var HOUSE_R = 108, R8 = 74, R4 = 40, BUTTON_R = 13;
  var BACK_Y = 44;               // Back-Linie: dahinter = aus
  var HOG_Y = 460;               // Hog-Linie: abgegebener Stein muss darueber liegen
  var THROW_Y = 620;             // Abwurfpunkt
  var STONE_R = 17;

  /* ================= Physik ================= */
  var FRICTION = 110;            // px/s^2 Reibungs-Verzoegerung
  var CURL = 11;                 // px/s^2 seitliche Beschleunigung pro Drall
  var V_MIN = 150, V_MAX = 380;  // px/s Abwurf-Geschwindigkeit
  var FIXED = 1 / 100;           // fester Simulationsschritt -> deterministisch
  var MAX_STEPS = 2500;

  /* ================= Regeln =================
     ENDS muss GERADE sein: der Anwurf rotiert pro End, wer zuletzt wirft (Hammer)
     holt fast immer den Punkt. Bei 3 Ends haette eine Seite den Hammer zweimal —
     im Test verliert selbst ein gleich starker Spieler dann 2:13. Bei 4 Ends ist
     der Hammer gerecht verteilt (2 Spieler: 2/2, 4 Spieler: je einmal). */
  var ENDS = 4;
  var TURN_MS = 45000;           // Frist pro Wurf (nur Multiplayer)
  var BOT_ID = '__bot__', ME_ID = '__me__';

  var TEAMS = [
    { fill: '#39ff14', glow: 'rgba(57,255,20,.75)', sym: '🟢', label: 'Gruen' },
    { fill: '#ff4d6d', glow: 'rgba(255,77,109,.75)', sym: '🔴', label: 'Rot' },
    { fill: '#ffd23f', glow: 'rgba(255,210,63,.75)', sym: '🟡', label: 'Gold' },
    { fill: '#33e6d0', glow: 'rgba(51,230,208,.75)', sym: '🔵', label: 'Aqua' }
  ];
  /* Bot-Stufen. Zwei Erkenntnisse aus dem Balancing:
     1) "Nimm einen der besten N Kandidaten" macht den Bot NICHT schwaecher — die
        besten Kandidaten sind alle gut. Es braucht Rauschen und Bewertungs-Chaos.
     2) Der eigentliche Vorteil des Bots ist, dass er beim Planen die Stoesse
        mitsimuliert, waehrend der Mensch nur seine (stoss-freie) Vorschau-Linie
        sieht. 'blind' nimmt ihm genau das: er plant auf leerer Bahn, zieht also nur
        aufs Haus und raeumt hoechstens zufaellig ab — so spielt ein Anfaenger. */
  var SKILLS = [
    { key: 0, name: 'Leicht', pick: 10, ang: 0.075, pow: 0.140, takeout: false, chaos: 70, blind: true },
    { key: 1, name: 'Normal', pick: 5, ang: 0.030, pow: 0.060, takeout: true, chaos: 22, blind: false },
    { key: 2, name: 'Profi', pick: 2, ang: 0.010, pow: 0.018, takeout: true, chaos: 3, blind: false }
  ];

  /* Deko am Bahnrand (einmal fest, damit nichts flackert) */
  var DECOR = [];
  (function () {
    var leaves = ['🌿', '🍃', '🌴'];
    for (var i = 0; i < 9; i++) {
      DECOR.push({ x: WALL * 0.5, y: 46 + i * 74, e: leaves[i % 3], r: -0.5 });
      DECOR.push({ x: W - WALL * 0.5, y: 82 + i * 74, e: leaves[(i + 2) % 3], r: 0.5 });
    }
  })();

  /* ================= reine Helfer ================= */
  function dist(ax, ay, bx, by) { var dx = ax - bx, dy = ay - by; return Math.sqrt(dx * dx + dy * dy); }
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function r2(v) { return Math.round(v * 100) / 100; }
  function sfx(n) { if (App.Audio) App.Audio.sfx(n); }
  function stonesPerPlayer(n) { return n <= 2 ? 4 : (n === 3 ? 3 : 2); }

  /* Ein einzelner Physikschritt (identisch fuer Sim, Vorschau und Bot). */
  function stepOne(s) {
    var sp = Math.sqrt(s.vx * s.vx + s.vy * s.vy);
    if (sp > 0) {
      if (s.spin) {                          // Drall: Beschleunigung quer zur Fahrt
        var nx = -s.vy / sp, ny = s.vx / sp;
        s.vx += nx * CURL * s.spin * FIXED;
        s.vy += ny * CURL * s.spin * FIXED;
        sp = Math.sqrt(s.vx * s.vx + s.vy * s.vy);
      }
      var dec = FRICTION * FIXED;
      if (sp <= dec) { s.vx = 0; s.vy = 0; }
      else { var f = (sp - dec) / sp; s.vx *= f; s.vy *= f; }
    }
    s.x += s.vx * FIXED; s.y += s.vy * FIXED;
  }

  function outOfPlay(s) {
    return s.x < WALL || s.x > W - WALL || s.y < BACK_Y || s.y > THROW_Y + 50;
  }

  /* ---- Simulation eines Wurfs: gleiche Schritte, egal ob animiert oder sofort ---- */
  function newSim(stones, shot, cb) {
    cb = cb || {};
    var list = [], i;
    for (i = 0; i < stones.length; i++) {
      list.push({ x: stones[i].x, y: stones[i].y, vx: 0, vy: 0, team: stones[i].team, spin: 0, dead: false });
    }
    var thrown = {
      x: shot.x, y: shot.y,
      vx: Math.sin(shot.angle) * shot.v, vy: -Math.cos(shot.angle) * shot.v,
      team: shot.team, spin: shot.spin, dead: false, thrown: true
    };
    list.push(thrown);

    var acc = 0, done = false, steps = 0;

    function step() {
      var i, j, a, b;
      steps++;
      for (i = 0; i < list.length; i++) { a = list[i]; if (!a.dead) stepOne(a); }
      /* elastische Stoesse (gleiche Masse) */
      for (i = 0; i < list.length; i++) {
        a = list[i]; if (a.dead) continue;
        for (j = i + 1; j < list.length; j++) {
          b = list[j]; if (b.dead) continue;
          var dx = b.x - a.x, dy = b.y - a.y, d2 = dx * dx + dy * dy, dm = STONE_R * 2;
          if (d2 >= dm * dm || d2 <= 0.0001) continue;
          var d = Math.sqrt(d2), nx = dx / d, ny = dy / d, ov = (dm - d) / 2;
          a.x -= nx * ov; a.y -= ny * ov; b.x += nx * ov; b.y += ny * ov;
          var vn = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
          if (vn < 0) {
            a.vx += nx * vn; a.vy += ny * vn;
            b.vx -= nx * vn; b.vy -= ny * vn;
            if (cb.onHit) cb.onHit(-vn);
          }
        }
      }
      /* Bande / Aus */
      var moving = false;
      for (i = 0; i < list.length; i++) {
        a = list[i]; if (a.dead) continue;
        if (outOfPlay(a)) { a.dead = true; if (cb.onOut) cb.onOut(a); continue; }
        if (a.vx !== 0 || a.vy !== 0) moving = true;
      }
      if (!moving || steps >= MAX_STEPS) finish();
    }

    function finish() {
      if (done) return;
      done = true;
      /* Hog-Regel: der abgegebene Stein muss die Hog-Linie ueberqueren */
      if (!thrown.dead && thrown.y > HOG_Y) { thrown.dead = true; thrown.hogged = true; if (cb.onOut) cb.onOut(thrown); }
    }

    return {
      stones: list,
      thrown: thrown,
      isDone: function () { return done; },
      /* Animation: echte Sekunden verbrauchen, aber nur in festen Schritten rechnen */
      advance: function (sec) {
        if (done) return;
        acc += sec;
        var guard = 0;
        while (acc >= FIXED && !done && guard < 400) { acc -= FIXED; step(); guard++; }
      },
      resolveAll: function () { while (!done && steps < MAX_STEPS) step(); finish(); },
      result: function () {
        var out = [];
        for (var i = 0; i < list.length; i++) {
          if (!list[i].dead) out.push({ x: r2(list[i].x), y: r2(list[i].y), team: list[i].team });
        }
        return out;
      }
    };
  }

  /* ---- Vorschau: nur der eigene Stein, ohne Gegner (die "Linie" des Wurfs) ---- */
  function previewPath(angle, v, spin) {
    var s = { x: CX, y: THROW_Y, vx: Math.sin(angle) * v, vy: -Math.cos(angle) * v, spin: spin };
    var path = [{ x: s.x, y: s.y }], n = 0;
    while ((s.vx !== 0 || s.vy !== 0) && n < MAX_STEPS) {
      stepOne(s); n++;
      if (n % 7 === 0) path.push({ x: s.x, y: s.y });
      if (outOfPlay(s)) break;
    }
    path.push({ x: s.x, y: s.y });
    var bad = outOfPlay(s) ? 'aus' : (s.y > HOG_Y ? 'kurz' : '');
    return { path: path, x: s.x, y: s.y, bad: bad };
  }

  /* ---- Curling-Wertung: nur das Team mit dem innersten Stein punktet ---- */
  function computeScore(stones) {
    var inH = [], i;
    for (i = 0; i < stones.length; i++) {
      var d = dist(stones[i].x, stones[i].y, CX, TEE_Y);
      if (d <= HOUSE_R + STONE_R) inH.push({ team: stones[i].team, d: d });
    }
    if (!inH.length) return null;
    inH.sort(function (a, b) { return a.d - b.d; });
    var team = inH[0].team, oppD = Infinity;
    for (i = 0; i < inH.length; i++) { if (inH[i].team !== team) { oppD = inH[i].d; break; } }
    var pts = 0;
    for (i = 0; i < inH.length; i++) { if (inH[i].team === team && inH[i].d < oppD) pts++; }
    return { team: team, points: pts };
  }

  /* ---- Bot: Kandidaten durchsimulieren und das Ergebnis bewerten ---- */
  function evalPos(stones, team) {
    var sc = computeScore(stones), val = 0, i;
    if (sc) val = (sc.team === team ? sc.points : -sc.points) * 100;
    var myBest = 400, oppBest = 400, mine = 0, oppHouse = 0;
    for (i = 0; i < stones.length; i++) {
      var d = dist(stones[i].x, stones[i].y, CX, TEE_Y);
      if (stones[i].team === team) {
        mine++;
        if (d < myBest) myBest = d;
      } else {
        if (d < oppBest) oppBest = d;
        if (d <= HOUSE_R + STONE_R) oppHouse++;
      }
    }
    val += (400 - Math.min(400, myBest)) * 0.22;
    val -= (400 - Math.min(400, oppBest)) * 0.16;
    val += mine * 4;
    val -= oppHouse * 3;
    return val;
  }

  function botPlan(stones, team, skill) {
    var sk = SKILLS[clamp(skill, 0, 2)];
    /* Ohne Takeout-Repertoire kennt der Bot nur Zieh-Weiten rund ums Haus */
    var dists = sk.takeout ? [300, 380, 430, 462, 500, 560, 680, 880] : [400, 430, 462, 500];
    var world = sk.blind ? [] : stones;      // blind = plant auf leerer Bahn
    var cands = [], a, di, sp;
    for (sp = -1; sp <= 1; sp++) {
      for (a = -0.24; a <= 0.2401; a += 0.06) {
        for (di = 0; di < dists.length; di++) {
          var v = clamp(Math.sqrt(2 * FRICTION * dists[di]), V_MIN, V_MAX);
          var shot = { x: CX, y: THROW_Y, angle: a, v: v, spin: sp, team: team };
          var s = newSim(world, shot, null);
          s.resolveAll();
          /* blind: das Ergebnis so bewerten, als laege nur der eigene Stein da */
          cands.push({ angle: a, v: v, spin: sp, val: evalPos(s.result(), team) + Math.random() * sk.chaos });
        }
      }
    }
    cands.sort(function (p, q) { return q.val - p.val; });
    var c = cands[Math.floor(Math.random() * Math.min(sk.pick, cands.length))] || cands[0];
    return {
      angle: c.angle + (Math.random() * 2 - 1) * sk.ang,
      v: clamp(c.v * (1 + (Math.random() * 2 - 1) * sk.pow), V_MIN, V_MAX),
      spin: c.spin
    };
  }

  /* ================================================================== */
  App.Minigames.curling = {
    id: 'curling', title: 'Dschungel-Curling', icon: '🥌', order: 155,
    subtitle: 'Zieh den Stein ins Haus – Drall entscheidet',
    single: true, multi: true, minPlayers: 2, maxPlayers: 4,

    render: function (root, ctx) {
      var isMulti = ctx.mode === 'multi';
      var room = isMulti ? ctx.room : null;
      var nowFn = isMulti ? function () { return room.now(); } : function () { return Date.now(); };

      var dead = false, raf = null, timers = [], stops = [], listeners = [];
      var sharedH = null, playersH = null, dlStop = null;

      var S = null;                 // Spielzustand (solo lokal, multi = room.shared)
      var viewStones = [];          // was gerade gezeichnet wird
      var sim = null, animStart = 0, trail = [];
      var seenShot = 0, pendingAdv = -1, botKey = '', dlKey = '', endShown = false;
      var lastReported = -1;

      var skill = clamp(App.Storage.get('cur_skill', 1), 0, 2);
      var spin = 0;                 // gewaehlter Drall (-1 / 0 / 1)
      var aim = null;               // {angle, v, prev} waehrend des Ziehens
      var refs = null, g2d = null;

      function after(ms, fn) { var t = setTimeout(function () { if (!dead) fn(); }, ms); timers.push(t); return t; }
      function addL(t, ty, fn, o) { t.addEventListener(ty, fn, o); listeners.push({ t: t, ty: ty, fn: fn, o: o }); }
      function cleanup() {
        dead = true;
        if (raf) { cancelAnimationFrame(raf); raf = null; }
        timers.forEach(clearTimeout); timers = [];
        if (dlStop) { try { dlStop(); } catch (e) {} dlStop = null; }
        stops.forEach(function (f) { try { f(); } catch (e) {} }); stops = [];
        listeners.forEach(function (l) { try { l.t.removeEventListener(l.ty, l.fn, l.o); } catch (e) {} }); listeners = [];
        if (room) {
          if (sharedH) room.off('shared', sharedH);
          if (playersH) room.off('players', playersH);
        }
      }

      /* ===================== Start ===================== */
      if (isMulti) {
        var snap = ctx.room.snapshot() || {};
        var startAt = (snap.round && snap.round.startAt) || (ctx.room.now() + 3000);
        stops.push(App.MG.countdown(root, startAt, function () { playMulti(); }, ctx.room.now));
      } else {
        showSoloIntro();
      }
      return { cleanup: cleanup };

      /* ===================== SOLO ===================== */
      function showSoloIntro() {
        if (raf) { cancelAnimationFrame(raf); raf = null; }
        sim = null; aim = null; refs = null; g2d = null;
        var chips = SKILLS.map(function (s) {
          return el('button', {
            class: 'cur-skill' + (s.key === skill ? ' on' : ''), type: 'button',
            onclick: function () {
              skill = s.key; App.Storage.set('cur_skill', skill); sfx('click');
              var all = root.querySelectorAll('.cur-skill');
              for (var i = 0; i < all.length; i++) all[i].classList.toggle('on', i === skill);
            }
          }, [s.name]);
        });
        root.innerHTML = '';
        root.appendChild(el('div', { class: 'cur-panel glass' }, [
          el('div', { class: 'cur-panel-icon' }, ['🥌']),
          el('h2', { class: 'cur-big neon' }, ['Dschungel-Curling']),
          el('p', { class: 'cur-sub' }, ['Vier Ends gegen den Bot. Zieh deine Steine ins Haus — nur das Team mit dem innersten Stein punktet. Wer zuletzt wirft, ist im Vorteil.']),
          el('div', { class: 'mg-field-title' }, ['🤖 Bot-Stufe']),
          el('div', { class: 'cur-skills' }, chips),
          el('div', { class: 'cur-actions' }, [
            el('button', { class: 'btn btn-primary', type: 'button', onclick: function () { sfx('start'); startSolo(); } }, ['Los geht\'s']),
            el('button', { class: 'btn btn-ghost', type: 'button', onclick: ctx.onExit }, ['Zurück'])
          ])
        ]));
      }

      function startSolo() {
        /* alte Timer aus einer vorherigen Partie ("Nochmal") wegräumen */
        timers.forEach(clearTimeout); timers = [];
        seenShot = 0; pendingAdv = -1; botKey = ''; endShown = false; sim = null; trail = [];
        S = freshState([ME_ID, BOT_ID]);
        buildUI();
        applyState(S);
        startLoop();
      }

      /* ===================== MULTI ===================== */
      function playMulti() {
        buildUI();
        var snap = room.snapshot() || {};
        S = snap.shared && snap.shared.game === 'curling' ? snap.shared : null;

        sharedH = function (sh) {
          if (dead) return;
          if (!sh || sh.game !== 'curling') { maybeInit(); return; }
          S = sh; applyState(S);
        };
        playersH = function () {
          if (dead) return;
          renderHud(S);
          maybeInit();
          nudgeAbsent();
        };
        room.on('shared', sharedH);
        room.on('players', playersH);

        maybeInit();
        applyState(S);
        startLoop();
      }

      /* Nur der Host legt den Startzustand an — genau einmal. */
      function maybeInit() {
        if (dead || !isMulti || S || !room.isHost()) return;
        var ps = room.players();
        if (ps.length < 2) { setStatus('Warte auf Mitspieler …', 'wait'); return; }
        var order = ps.slice(0, 4).map(function (p) { return p.id; });
        var st = freshState(order);
        st.deadline = room.now() + TURN_MS;
        S = st;
        room.setShared(st);
      }

      /* Wenn der Werfer den Raum verlassen hat: Frist verkürzen -> Host wirft für ihn. */
      function nudgeAbsent() {
        if (!isMulti || !S || S.phase !== 'play' || sim || !room.isHost()) return;
        var ids = room.players().map(function (p) { return p.id; });
        if (S.turn && ids.indexOf(S.turn) < 0 && (!S.deadline || S.deadline - room.now() > 5000)) {
          room.setShared({ deadline: room.now() + 3000 });
        }
      }

      function freshState(order) {
        return {
          game: 'curling', order: order, end: 1, throwIdx: 0, turn: order[0],
          stones: [], shot: null, shotSeq: 0, scores: {}, phase: 'play',
          endResult: null, deadline: 0
        };
      }

      /* ===================== Zustands-Logik ===================== */
      function totalStones(s) { return s.order.length * stonesPerPlayer(s.order.length); }
      function turnFor(s, idx) { return s.order[((s.end - 1) + idx) % s.order.length]; }
      function teamOf(s, id) { return s.order.indexOf(id); }
      function myId() { return isMulti ? ctx.me.id : ME_ID; }
      function amHost() { return isMulti ? !!room.isHost() : true; }
      function nameOf(id) {
        if (!isMulti) return id === ME_ID ? 'Du' : 'Bot 🤖';
        var ps = room.players();
        for (var i = 0; i < ps.length; i++) { if (ps[i].id === id) return ps[i].name + (id === ctx.me.id ? ' (du)' : ''); }
        return 'Weg';
      }
      function thrownBy(s, id) {
        var n = 0;
        for (var k = 0; k < s.throwIdx; k++) { if (turnFor(s, k) === id) n++; }
        return n;
      }

      function commit(patch) {
        if (isMulti) { room.setShared(patch); }
        else { S = Object.assign({}, S, patch); applyState(S); }
      }

      /* Achtung: Firebase speichert keine leeren Arrays/Objekte — fehlendes
         'stones' heisst also "keine Steine", nicht "kein Zustand". */
      function applyState(s) {
        if (dead) return;
        if (!s || !s.order || !s.order.length) { setStatus(isMulti ? 'Warte auf den Host …' : '…', 'wait'); return; }
        if (s.shot && s.shot.id && s.shot.id !== seenShot) {
          seenShot = s.shot.id;
          startAnim(s.shot);
        } else if (!sim) {
          viewStones = s.stones || [];
        }
        renderHud(s);
        if (sim) return;                       // waehrend der Animation nichts entscheiden
        if (s.phase === 'over') { showFinal(s); return; }
        if (s.phase === 'scoring') { hostAdvance(s); return; }
        scheduleTurn(s);
      }

      function scheduleTurn(s) {
        if (!isMulti) {
          if (s.turn !== BOT_ID) return;
          var key = s.end + ':' + s.throwIdx;
          if (botKey === key) return;
          botKey = key;
          setStatus('Bot zielt …', 'wait');
          after(900, function () {
            var c = S;
            if (!c || c.phase !== 'play' || c.turn !== BOT_ID || sim) return;
            doThrow(BOT_ID, botPlan(c.stones || [], teamOf(c, BOT_ID), skill));
          });
          return;
        }
        setupDeadline(s);
      }

      function setupDeadline(s) {
        if (!isMulti || s.phase !== 'play' || !s.deadline) return;
        var key = s.end + ':' + s.throwIdx + ':' + s.deadline;
        if (dlKey === key) return;
        dlKey = key;
        if (dlStop) { try { dlStop(); } catch (e) {} dlStop = null; }
        var end = s.end, idx = s.throwIdx;
        dlStop = App.MG.roundTimer(s.deadline, function (left) {
          if (refs && refs.timer) refs.timer.textContent = App.MG.mmss(left);
        }, function () { onDeadline(end, idx); }, room.now);
      }

      function onDeadline(end, idx) {
        var s = S;
        if (dead || !s || s.phase !== 'play' || s.end !== end || s.throwIdx !== idx || sim) return;
        if (s.turn === ctx.me.id) {
          UI.toast('Zeit abgelaufen — der Stein geht automatisch raus', 'info');
          doThrow(s.turn, botPlan(s.stones || [], teamOf(s, s.turn), 1));
        } else if (amHost()) {
          /* Werfer reagiert nicht (z. B. Raum verlassen) -> Host wirft für ihn */
          after(3500, function () {
            var c = S;
            if (!c || c.phase !== 'play' || c.end !== end || c.throwIdx !== idx || sim) return;
            doThrow(c.turn, botPlan(c.stones || [], teamOf(c, c.turn), 1));
          });
        }
      }

      /* Ein Wurf: sofort komplett durchrechnen, teilen, dann lokal animieren. */
      function doThrow(pid, plan) {
        var s = S;
        if (dead || !s || s.phase !== 'play' || sim) return;
        var team = teamOf(s, pid);
        if (team < 0) return;

        /* Das Eis ist nie perfekt: kleines, geteiltes Rauschen (steckt im Wurf) */
        var angle = clamp(plan.angle + (Math.random() * 2 - 1) * 0.010, -0.5, 0.5);
        var v = clamp(plan.v * (1 + (Math.random() * 2 - 1) * 0.02), V_MIN, V_MAX);

        var shot = {
          id: (s.shotSeq || 0) + 1, by: pid, team: team,
          x: CX, y: THROW_Y, angle: r2(angle), v: r2(v), spin: plan.spin | 0,
          pre: (s.stones || []).slice()
        };
        var solve = newSim(shot.pre, shot, null);
        solve.resolveAll();
        var endStones = solve.result();

        var patch = { shot: shot, shotSeq: shot.id, stones: endStones, throwIdx: s.throwIdx + 1 };
        if (patch.throwIdx >= totalStones(s)) {
          var sc = computeScore(endStones);
          var scores = Object.assign({}, s.scores || {});
          if (sc && sc.points > 0) scores[s.order[sc.team]] = (scores[s.order[sc.team]] || 0) + sc.points;
          patch.scores = scores;
          patch.phase = 'scoring';
          patch.endResult = sc ? { team: sc.team, points: sc.points } : { team: -1, points: 0 };
        } else {
          patch.turn = turnFor(s, patch.throwIdx);
          if (isMulti) patch.deadline = room.now() + TURN_MS;
        }

        seenShot = shot.id;
        aim = null;
        if (refs) { refs.power.style.width = '0%'; refs.powerTxt.textContent = 'Kraft –'; }
        sfx('roll');
        startAnim(shot);
        commit(patch);
      }

      function startAnim(shot) {
        var hits = 0;
        sim = newSim(shot.pre || [], shot, {
          onHit: function (sp) { if (hits++ < 4) { sfx('hit'); if (App.Audio) App.Audio.blip(120 + Math.min(300, sp), 0.07); } },
          onOut: function () { sfx('pop'); }
        });
        animStart = Date.now();
        trail = [];
      }

      function finishAnim() {
        var res = sim ? sim.result() : null;
        sim = null; trail = [];
        /* autoritativ sind die geteilten Endpositionen des Werfers */
        if (S && S.shot && S.shot.id === seenShot) viewStones = S.stones || [];
        else if (res) viewStones = res;
        applyState(S);
      }

      /* Host: nach der Wertung ins naechste End (oder Schluss). */
      function hostAdvance(s) {
        if (!amHost() || pendingAdv === s.end) return;
        pendingAdv = s.end;
        if (s.endResult && s.endResult.points > 0) sfx('point');
        after(3800, function () {
          var c = S;
          if (!c || c.phase !== 'scoring' || c.end !== s.end) return;
          if (c.end >= ENDS) { commit({ phase: 'over' }); return; }
          var next = {
            end: c.end + 1, throwIdx: 0, stones: [], shot: null,
            phase: 'play', endResult: null
          };
          next.turn = c.order[c.end % c.order.length];   // Anwurf rotiert pro End
          if (isMulti) next.deadline = room.now() + TURN_MS;
          commit(next);
        });
      }

      /* ===================== Ende ===================== */
      function showFinal(s) {
        if (endShown) return;
        endShown = true;
        if (dlStop) { try { dlStop(); } catch (e) {} dlStop = null; }
        if (raf) { cancelAnimationFrame(raf); raf = null; }
        var mine = (s.scores && s.scores[myId()]) || 0;

        if (isMulti) {
          room.reportScore(mine);
          var top = 0, ids = s.order;
          for (var i = 0; i < ids.length; i++) { var v = (s.scores && s.scores[ids[i]]) || 0; if (v > top) top = v; }
          if (mine > 0 && mine >= top && App.Scores) App.Scores.winCurrent();
          sfx(mine >= top && mine > 0 ? 'win' : 'lose');
          after(1400, function () {
            App.MG.endScreen(root, { players: room.players(), meId: ctx.me.id, onExit: ctx.onExit });
          });
          return;
        }

        var botPts = (s.scores && s.scores[BOT_ID]) || 0;
        var best = App.Storage.get('best_curling', 0);
        var nb = mine > best;
        if (nb) App.Storage.set('best_curling', mine);
        if (mine > botPts && App.Scores) App.Scores.winCurrent();
        sfx(mine > botPts ? 'win' : 'lose');
        App.MG.endScreen(root, {
          score: mine, best: best, newBest: nb,
          label: (mine > botPts ? '🏆 Du schlägst den Bot ' : (mine === botPts ? '🤝 Unentschieden ' : '💀 Der Bot gewinnt ')) +
            mine + ' : ' + botPts + (nb ? ' · neuer Rekord! 🎉' : ' · Bestwert: ' + App.MG.fmt(best)),
          onExit: ctx.onExit,
          onAgain: function () { showSoloIntro(); }
        });
      }

      /* ===================== Oberflaeche ===================== */
      function buildUI() {
        var canvas = el('canvas', { class: 'cur-canvas', width: W, height: H });
        var endEl = el('div', { class: 'cur-end' }, ['End 1 / ' + ENDS]);
        var timer = el('div', { class: 'mg-timer cur-timer' }, ['']);
        var status = el('div', { class: 'cur-status' }, ['']);
        var chips = el('div', { class: 'cur-chips' });
        var power = el('div', { class: 'cur-power' }, [el('div', { class: 'cur-power-fill' })]);
        var powerTxt = el('span', { class: 'cur-power-txt' }, ['Kraft –']);

        var spinBtns = [-1, 0, 1].map(function (v) {
          var lbl = v < 0 ? '↺ Links' : (v > 0 ? '↻ Rechts' : '↑ Gerade');
          return el('button', {
            class: 'cur-spin' + (v === spin ? ' on' : ''), type: 'button',
            onclick: function () {
              spin = v; sfx('click');
              var all = refs.spins;
              for (var i = 0; i < all.length; i++) all[i].classList.toggle('on', (i - 1) === spin);
              if (aim) { aim.prev = previewPath(aim.angle, aim.v, spin); }
            }
          }, [lbl]);
        });

        var wrap = el('div', { class: 'cur-wrap' }, [
          el('div', { class: 'cur-top' }, [
            el('div', { class: 'cur-brand neon' }, ['🥌 Dschungel-Curling']),
            el('div', { class: 'cur-top-r' }, [endEl, isMulti ? timer : null])
          ]),
          chips,
          status,
          el('div', { class: 'cur-stage' }, [canvas]),
          el('div', { class: 'cur-ctrls' }, [
            el('div', { class: 'cur-spins' }, spinBtns),
            el('div', { class: 'cur-power-wrap' }, [powerTxt, power])
          ]),
          el('p', { class: 'cur-hint hint-text' }, ['Auf die Bahn ziehen = Ziel & Kraft · Drall wählt die Kurve · nur der innerste Stein im Haus punktet'])
        ]);
        root.innerHTML = ''; root.appendChild(wrap);

        refs = {
          canvas: canvas, end: endEl, timer: timer, status: status, chips: chips,
          spins: spinBtns, power: power.querySelector('.cur-power-fill'), powerTxt: powerTxt,
          chipMap: {}
        };
        g2d = canvas.getContext('2d');
        attachInput(canvas);
      }

      function setStatus(txt, cls) {
        if (!refs) return;
        refs.status.textContent = txt;
        refs.status.className = 'cur-status ' + (cls || '');
      }

      function renderHud(s) {
        if (!refs || !s || !s.order) return;
        refs.end.textContent = 'End ' + s.end + ' / ' + ENDS;
        if (refs.timer) refs.timer.style.display = (isMulti && s.phase === 'play' && !sim) ? '' : 'none';

        /* Spieler-Chips (in-place, damit nichts flackert) */
        var per = stonesPerPlayer(s.order.length);
        if (refs.chips.childNodes.length !== s.order.length) {
          refs.chips.innerHTML = ''; refs.chipMap = {};
          s.order.forEach(function (id, i) {
            var nm = el('div', { class: 'cur-chip-nm' }, ['—']);
            var mini = el('div', { class: 'cur-chip-mini' }, ['']);
            var sc = el('div', { class: 'cur-chip-sc' }, ['0']);
            var box = el('div', { class: 'cur-chip cur-t' + (i % 4) }, [
              el('span', { class: 'cur-chip-sym' }, [TEAMS[i % 4].sym]),
              el('div', { class: 'cur-chip-info' }, [nm, mini]), sc
            ]);
            refs.chipMap[id] = { box: box, nm: nm, mini: mini, sc: sc };
            refs.chips.appendChild(box);
          });
        }
        s.order.forEach(function (id) {
          var c = refs.chipMap[id]; if (!c) return;
          var left = per - thrownBy(s, id);
          c.nm.textContent = nameOf(id);
          c.mini.textContent = s.phase === 'play' ? ('🥌 ' + Math.max(0, left) + ' übrig') : 'Wertung';
          c.sc.textContent = String((s.scores && s.scores[id]) || 0);
          c.box.classList.toggle('active', s.phase === 'play' && s.turn === id && !sim);
          c.box.classList.toggle('me', id === myId());
        });

        /* Status-Zeile */
        if (sim) setStatus('Der Stein läuft …', 'run');
        else if (s.phase === 'over') setStatus('Spiel vorbei', 'wait');
        else if (s.phase === 'scoring') {
          var r = s.endResult;
          if (r && r.points > 0) setStatus('End ' + s.end + ': ' + nameOf(s.order[r.team]) + ' holt ' + r.points + ' Punkt' + (r.points > 1 ? 'e' : '') + '!', r.team === teamOf(s, myId()) ? 'good' : 'bad');
          else setStatus('End ' + s.end + ': kein Stein im Haus — 0 Punkte', 'wait');
        } else if (s.turn === myId()) setStatus('Du bist dran — zieh deinen Stein!', 'good');
        else setStatus(nameOf(s.turn) + ' ist dran …', 'wait');

        /* eigene Punkte melden */
        if (isMulti) {
          var mine = (s.scores && s.scores[ctx.me.id]) || 0;
          if (mine !== lastReported) { lastReported = mine; room.reportScore(mine); }
        }
      }

      /* ===================== Eingabe (Maus + Touch) ===================== */
      function canMove() {
        return !!S && S.phase === 'play' && !sim && S.turn === myId();
      }
      function toVirt(e) {
        var r = refs.canvas.getBoundingClientRect();
        return { x: (e.clientX - r.left) * W / r.width, y: (e.clientY - r.top) * H / r.height };
      }
      function calcAim(p) {
        var dx = p.x - CX, dy = p.y - THROW_Y;
        if (dy > -25) dy = -25;
        var angle = clamp(Math.atan2(dx, -dy), -0.5, 0.5);
        var d = Math.sqrt(dx * dx + dy * dy);
        var v = clamp(Math.sqrt(2 * FRICTION * d), V_MIN, V_MAX);
        return { angle: angle, v: v, prev: previewPath(angle, v, spin) };
      }
      function showPower(v) {
        if (!refs) return;
        var pct = Math.round((v - V_MIN) / (V_MAX - V_MIN) * 100);
        refs.power.style.width = pct + '%';
        refs.powerTxt.textContent = 'Kraft ' + pct + '%';
      }
      function attachInput(canvas) {
        addL(canvas, 'pointerdown', function (e) {
          if (!canMove()) return;
          e.preventDefault();
          try { canvas.setPointerCapture(e.pointerId); } catch (err) {}
          aim = calcAim(toVirt(e));
          showPower(aim.v);
          if (App.Audio) App.Audio.blip(300, 0.05);
        });
        addL(canvas, 'pointermove', function (e) {
          if (!aim || !canMove()) return;
          e.preventDefault();
          aim = calcAim(toVirt(e));
          showPower(aim.v);
        });
        function release(e) {
          if (!aim) return;
          var a = aim;
          if (!canMove()) { aim = null; return; }
          e.preventDefault();
          doThrow(myId(), { angle: a.angle, v: a.v, spin: spin });
        }
        addL(canvas, 'pointerup', release);
        addL(canvas, 'pointercancel', function () { aim = null; if (refs) { refs.power.style.width = '0%'; refs.powerTxt.textContent = 'Kraft –'; } });
      }

      /* ===================== Schleife + Zeichnen ===================== */
      function startLoop() {
        var last = Date.now();
        if (raf) cancelAnimationFrame(raf);
        raf = requestAnimationFrame(function frame() {
          if (dead) { raf = null; return; }
          var now = Date.now();
          var dt = (now - last) / 1000; last = now;
          if (dt < 0) dt = 0; if (dt > 0.1) dt = 0.1;   // Wall-Clock, Tab-Wechsel-sicher
          if (sim) {
            sim.advance(dt);
            if (now - animStart > 14000) sim.resolveAll();   // Notbremse (z. B. Tab war weg)
            var t = sim.thrown;
            if (!t.dead) { trail.push({ x: t.x, y: t.y }); if (trail.length > 26) trail.shift(); }
            if (sim.isDone()) { finishAnim(); }
          }
          draw();
          raf = requestAnimationFrame(frame);
        });
      }

      function draw() {
        var g = g2d; if (!g) return;
        var i;
        /* Eis */
        var grd = g.createLinearGradient(0, 0, 0, H);
        grd.addColorStop(0, '#04222b'); grd.addColorStop(0.55, '#062a34'); grd.addColorStop(1, '#04161d');
        g.fillStyle = grd; g.fillRect(0, 0, W, H);

        /* Aus-Zonen */
        g.fillStyle = 'rgba(2,12,9,.88)';
        g.fillRect(0, 0, WALL, H); g.fillRect(W - WALL, 0, WALL, H); g.fillRect(0, 0, W, BACK_Y);

        /* Dschungel-Deko am Rand */
        g.save(); g.globalAlpha = 0.5; g.font = '15px system-ui,sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
        for (i = 0; i < DECOR.length; i++) {
          g.save(); g.translate(DECOR[i].x, DECOR[i].y); g.rotate(DECOR[i].r); g.fillText(DECOR[i].e, 0, 0); g.restore();
        }
        g.restore();

        /* Seitenlinien */
        g.strokeStyle = 'rgba(57,255,20,.35)'; g.lineWidth = 2;
        g.beginPath(); g.moveTo(WALL, 0); g.lineTo(WALL, H); g.moveTo(W - WALL, 0); g.lineTo(W - WALL, H); g.stroke();

        /* Haus */
        drawRing(g, HOUSE_R, 'rgba(51,230,208,.16)', 'rgba(51,230,208,.55)');
        drawRing(g, R8, 'rgba(220,247,231,.10)', 'rgba(220,247,231,.30)');
        drawRing(g, R4, 'rgba(255,210,63,.18)', 'rgba(255,210,63,.55)');
        g.beginPath(); g.arc(CX, TEE_Y, BUTTON_R, 0, 6.2832);
        g.fillStyle = 'rgba(234,255,226,.9)'; g.shadowColor = 'rgba(57,255,20,.8)'; g.shadowBlur = 14; g.fill(); g.shadowBlur = 0;

        /* Linien: Mittellinie, Tee-Linie, Back-Linie, Hog-Linie */
        g.save(); g.setLineDash([7, 9]); g.lineWidth = 1.5; g.strokeStyle = 'rgba(220,247,231,.18)';
        g.beginPath(); g.moveTo(CX, BACK_Y); g.lineTo(CX, H); g.stroke();
        g.restore();
        line(g, BACK_Y, 'rgba(255,77,109,.45)', 2);
        line(g, TEE_Y, 'rgba(220,247,231,.22)', 1.5);
        g.save(); g.setLineDash([10, 8]);
        line(g, HOG_Y, 'rgba(255,210,63,.5)', 2.5);
        g.restore();
        g.font = '10px system-ui,sans-serif'; g.textAlign = 'left'; g.textBaseline = 'bottom';
        g.fillStyle = 'rgba(255,210,63,.65)'; g.fillText('HOG-LINIE', WALL + 6, HOG_Y - 4);
        g.fillStyle = 'rgba(255,77,109,.6)'; g.textBaseline = 'top'; g.fillText('AUS', WALL + 6, BACK_Y + 3);

        /* Abwurfpunkt */
        g.strokeStyle = 'rgba(57,255,20,.5)'; g.lineWidth = 2; g.setLineDash([4, 4]);
        g.beginPath(); g.arc(CX, THROW_Y, STONE_R + 5, 0, 6.2832); g.stroke(); g.setLineDash([]);

        /* Zielhilfe */
        if (aim && canMove()) drawAim(g, aim);

        /* Steine */
        var list = sim ? sim.stones : viewStones;
        if (sim) {
          g.save(); g.strokeStyle = 'rgba(220,247,231,.35)'; g.lineWidth = 3; g.lineCap = 'round';
          g.beginPath();
          for (i = 0; i < trail.length; i++) { if (i === 0) g.moveTo(trail[i].x, trail[i].y); else g.lineTo(trail[i].x, trail[i].y); }
          g.stroke(); g.restore();
        }
        for (i = 0; i < list.length; i++) {
          if (list[i].dead) continue;
          drawStone(g, list[i], !!(sim && (list[i].vx || list[i].vy)));
        }

        /* Wertungs-Markierung: der innerste Stein */
        if (S && S.phase === 'scoring' && !sim) {
          var best = null, bd = 1e9;
          for (i = 0; i < list.length; i++) {
            var d = dist(list[i].x, list[i].y, CX, TEE_Y);
            if (d <= HOUSE_R + STONE_R && d < bd) { bd = d; best = list[i]; }
          }
          if (best) {
            var pulse = 0.6 + 0.4 * Math.sin(Date.now() / 220);
            g.save(); g.globalAlpha = pulse;
            g.strokeStyle = '#ffd23f'; g.lineWidth = 3;
            g.beginPath(); g.arc(best.x, best.y, STONE_R + 9, 0, 6.2832); g.stroke();
            g.restore();
          }
        }
      }

      function line(g, y, col, w) {
        g.strokeStyle = col; g.lineWidth = w;
        g.beginPath(); g.moveTo(WALL, y); g.lineTo(W - WALL, y); g.stroke();
      }
      function drawRing(g, r, fill, stroke) {
        g.beginPath(); g.arc(CX, TEE_Y, r, 0, 6.2832);
        g.fillStyle = fill; g.fill();
        g.strokeStyle = stroke; g.lineWidth = 2; g.stroke();
      }
      function drawStone(g, s, moving) {
        var c = TEAMS[(s.team | 0) % 4];
        g.save();
        g.shadowColor = c.glow; g.shadowBlur = moving ? 24 : 12;
        g.beginPath(); g.arc(s.x, s.y, STONE_R, 0, 6.2832);
        g.fillStyle = '#0a1b16'; g.fill();
        g.lineWidth = 4; g.strokeStyle = c.fill; g.stroke();
        g.restore();
        g.beginPath(); g.arc(s.x, s.y, STONE_R * 0.44, 0, 6.2832);
        g.globalAlpha = 0.9; g.fillStyle = c.fill; g.fill(); g.globalAlpha = 1;
      }
      function drawAim(g, a) {
        var p = a.prev, i;
        g.save();
        g.setLineDash([5, 7]); g.lineWidth = 2.5;
        g.strokeStyle = p.bad ? 'rgba(255,77,109,.75)' : 'rgba(57,255,20,.75)';
        g.beginPath();
        for (i = 0; i < p.path.length; i++) { if (i === 0) g.moveTo(p.path[i].x, p.path[i].y); else g.lineTo(p.path[i].x, p.path[i].y); }
        g.stroke(); g.setLineDash([]);
        /* Geister-Stein am Landepunkt */
        g.globalAlpha = 0.7;
        g.beginPath(); g.arc(p.x, p.y, STONE_R, 0, 6.2832);
        g.strokeStyle = p.bad ? '#ff4d6d' : '#eaffe2'; g.lineWidth = 3; g.stroke();
        g.globalAlpha = 1;
        if (p.bad) {
          g.font = 'bold 13px system-ui,sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
          g.fillStyle = '#ff4d6d';
          g.fillText(p.bad === 'aus' ? 'AUS!' : 'ZU KURZ!', clamp(p.x, 60, W - 60), clamp(p.y - 30, 20, H - 20));
        }
        g.restore();
      }
    }
  };

  /* ===================== CSS ===================== */
  function injectStyle() {
    UI.injectStyle('mg-curling-css', [
      '.cur-wrap{display:flex;flex-direction:column;gap:9px;max-width:520px;margin:0 auto;}',
      '.cur-top{display:flex;justify-content:space-between;align-items:center;gap:10px;}',
      '.cur-brand{font-weight:900;font-size:16px;}',
      '.cur-top-r{display:flex;align-items:center;gap:10px;}',
      '.cur-end{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;font-weight:800;}',
      '.cur-timer{font-size:15px;font-variant-numeric:tabular-nums;}',
      /* Spieler-Chips */
      '.cur-chips{display:flex;gap:7px;flex-wrap:wrap;}',
      '.cur-chip{flex:1 1 110px;min-width:0;display:flex;align-items:center;gap:7px;padding:6px 9px;border-radius:12px;',
      'background:rgba(9,32,21,.6);border:1px solid var(--stroke);transition:border-color .15s,box-shadow .15s;}',
      '.cur-chip-sym{font-size:16px;line-height:1;}',
      '.cur-chip-info{flex:1;min-width:0;display:flex;flex-direction:column;line-height:1.15;}',
      '.cur-chip-nm{font-weight:800;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      '.cur-chip-mini{font-size:9px;color:var(--muted);text-transform:uppercase;letter-spacing:.6px;}',
      '.cur-chip-sc{font-size:20px;font-weight:900;color:var(--leaf);font-variant-numeric:tabular-nums;}',
      '.cur-chip.me .cur-chip-nm{color:var(--aqua);}',
      '.cur-chip.active{border-color:var(--neon);box-shadow:0 0 0 1px var(--neon),0 0 16px rgba(57,255,20,.3);}',
      '.cur-chip.active .cur-chip-sym{animation:cur-bob .9s ease-in-out infinite;}',
      '.cur-t0 .cur-chip-sc{color:#39ff14;}',
      '.cur-t1 .cur-chip-sc{color:#ff4d6d;}',
      '.cur-t2 .cur-chip-sc{color:#ffd23f;}',
      '.cur-t3 .cur-chip-sc{color:#33e6d0;}',
      '@keyframes cur-bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-3px)}}',
      /* Status */
      '.cur-status{text-align:center;font-weight:900;font-size:clamp(13px,3.6vw,17px);min-height:22px;line-height:1.25;}',
      '.cur-status.good{color:var(--neon);text-shadow:0 0 10px rgba(57,255,20,.4);}',
      '.cur-status.wait{color:var(--aqua);}',
      '.cur-status.run{color:var(--gold);}',
      '.cur-status.bad{color:var(--danger);}',
      /* Bahn */
      '.cur-stage{width:100%;max-width:min(440px,44vh);margin:0 auto;}',
      '.cur-canvas{display:block;width:100%;height:auto;aspect-ratio:520/680;border-radius:18px;',
      'border:2px solid var(--stroke-2);background:#04161d;box-shadow:0 0 30px rgba(51,230,208,.16),inset 0 0 40px rgba(0,0,0,.5);',
      'touch-action:none;user-select:none;-webkit-user-select:none;-webkit-tap-highlight-color:transparent;cursor:crosshair;}',
      /* Steuerung */
      '.cur-ctrls{display:flex;gap:10px;align-items:center;justify-content:space-between;flex-wrap:wrap;}',
      '.cur-spins{display:flex;gap:6px;flex:1 1 auto;}',
      '.cur-spin{flex:1;padding:9px 6px;border-radius:12px;font-family:inherit;font-weight:800;font-size:12px;',
      'color:var(--muted);background:rgba(6,24,16,.75);border:1px solid var(--stroke);cursor:pointer;',
      'transition:.14s;-webkit-tap-highlight-color:transparent;white-space:nowrap;}',
      '.cur-spin:hover{border-color:var(--stroke-2);color:var(--leaf);}',
      '.cur-spin.on{color:#04160c;background:linear-gradient(180deg,var(--aqua-soft),var(--aqua));border-color:var(--aqua-soft);box-shadow:0 0 14px rgba(51,230,208,.45);}',
      '.cur-power-wrap{flex:1 1 130px;display:flex;flex-direction:column;gap:3px;min-width:120px;}',
      '.cur-power-txt{font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;font-weight:800;}',
      '.cur-power{height:8px;border-radius:6px;background:rgba(6,24,16,.85);border:1px solid var(--stroke);overflow:hidden;}',
      '.cur-power-fill{height:100%;width:0%;border-radius:6px;background:linear-gradient(90deg,var(--aqua),var(--neon),var(--gold));',
      'box-shadow:0 0 12px rgba(57,255,20,.5);transition:width .05s linear;}',
      '.cur-hint{text-align:center;margin:0;font-size:11px;}',
      /* Intro-Panel */
      '.cur-panel{padding:28px 22px;text-align:center;display:flex;flex-direction:column;gap:12px;align-items:center;max-width:460px;margin:0 auto;}',
      '.cur-panel-icon{font-size:52px;line-height:1;filter:drop-shadow(0 0 14px rgba(51,230,208,.55));animation:cur-slide 2.6s ease-in-out infinite;}',
      '@keyframes cur-slide{0%,100%{transform:translateX(-10px) rotate(-4deg)}50%{transform:translateX(10px) rotate(4deg)}}',
      '.cur-big{font-size:clamp(24px,7vw,36px);font-weight:900;line-height:1.1;}',
      '.cur-sub{color:var(--muted);margin:0;font-size:13px;}',
      '.cur-skills{display:flex;gap:8px;flex-wrap:wrap;justify-content:center;}',
      '.cur-skill{padding:9px 16px;border-radius:12px;font-family:inherit;font-weight:800;font-size:13px;color:var(--muted);',
      'background:rgba(6,24,16,.75);border:1px solid var(--stroke);cursor:pointer;transition:.14s;}',
      '.cur-skill:hover{border-color:var(--stroke-2);color:var(--leaf);}',
      '.cur-skill.on{color:#04160c;background:linear-gradient(180deg,var(--neon-soft),var(--neon));border-color:#eaffe2;box-shadow:0 0 16px rgba(57,255,20,.45);}',
      '.cur-actions{display:flex;gap:10px;justify-content:center;flex-wrap:wrap;margin-top:4px;}'
    ].join(''));
  }
})();
