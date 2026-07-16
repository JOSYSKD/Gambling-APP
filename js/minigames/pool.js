/* pool.js — "8-Ball Billard": rundenbasiertes Poolduell auf Canvas-Tisch
 * im Neon-Dschungel-Look.  Voller Physik-Kern: Kugelreibung, elastische
 * Kugel-Kugel-Stoesse, Bandenabpraller und 6 Taschen, in die Kugeln fallen.
 *
 * STEUERUNG: Auf dem Tisch von der weissen Kugel WEGZIEHEN (pointerdown/move/up)
 *   und loslassen — Zugrichtung bestimmt (gegengleich) die Stossrichtung, die
 *   Zuglaenge die Kraft.  Eine Ziellinie mit Aufprall-Vorschau (Geisterkugel)
 *   zeigt, wohin die getroffene Kugel laeuft.  Bei "Ball in der Hand" (nach
 *   einem Foul) zuerst die Weisse per Tipp/Zug an eine freie Stelle setzen.
 *
 * REGELN (8-Ball, entschaerft-fair): Break, danach ist der Tisch OFFEN — die
 *   erste sauber versenkte Kugel legt Voll (1-7) oder Halb (9-15) fest.  Fouls
 *   (Weisse versenkt, keine eigene Kugel zuerst getroffen, gar nichts getroffen)
 *   -> Gegner bekommt Ball-in-Hand.  Versenkte Kugel = nochmal.  Wer alle
 *   eigenen und danach die 8 sauber locht, gewinnt; die 8 zu frueh oder mit
 *   Foul -> sofort verloren.
 *
 * PUNKTE (fuer Bestenliste): versenkte eigene Kugeln * 100 + Sieg 1000
 *   (+ Bonus je Schwierigkeit im Solo).
 *
 * SYNC-MODELL (multi):  Rundenbasiert ueber room.shared.  Nur der aktive
 *   Spieler (turn === me) rechnet die deterministische Simulation (fester dt,
 *   KEIN Math.random in der Physik!) und schickt Stoss-Parameter (Startlage +
 *   Kugelgeschwindigkeit) UND den Endzustand per setShared.  Der Gegner spielt
 *   dieselbe deterministische Simulation als Animation ab und uebernimmt danach
 *   den autoritativen Endzustand.  shotSeq verhindert Doppel-Animationen;
 *   Heartbeat-Events sind idempotent (nur bei neuem shotSeq animieren).
 *
 * SOLO: gegen einen Bot mit 3 Schwierigkeitsstufen, der die beste erreichbare
 *   Tasche sucht (Geisterkugel-Ziel, Weg-frei-Pruefung, Schnittwinkel) und bei
 *   Aussichtslosigkeit einen sicheren Kontakt spielt.  Animation/Timer laufen
 *   ueber Wall-Clock (Date.now), rAF nur zum Zeichnen -> Tab-Wechsel-sicher.
 *
 * cleanup() beendet rAF, alle Timer und entfernt DOM- und Room-Listener. */
(function () {
  'use strict';
  window.App = window.App || {}; App.Minigames = App.Minigames || {};
  var UI = App.UI, el = UI.el;

  injectStyle();

  /* ===================== Tisch-Geometrie (virtuelle px) ===================== */
  var W = 760, H = 400;
  var CUSH = 30;                      // Bandenstaerke
  var PL = CUSH, PR = W - CUSH, PT = CUSH, PB = H - CUSH;
  var R = 11;                         // Kugelradius
  var RP = 18;                        // Fangradius einer Tasche
  var minX = PL + R, maxX = PR - R, minY = PT + R, maxY = PB - R;

  var POCKETS = [
    { x: PL, y: PT }, { x: W / 2, y: PT - 3 }, { x: PR, y: PT },
    { x: PL, y: PB }, { x: W / 2, y: PB + 3 }, { x: PR, y: PB }
  ];

  /* ===================== Physik-Konstanten ===================== */
  var STEP = 1 / 240;                 // fester Simulations-dt (deterministisch)
  var STEPMS = STEP * 1000;
  var DECEL = 300;                    // px/s^2 Reibung (lineare Verzoegerung)
  var STOP = 5;                       // px/s Stillstands-Schwelle
  var WALL = 0.9;                     // Banden-Restitution
  var REST = 0.95;                    // Kugel-Kugel-Restitution
  var MINSPD = 150, MAXSPD = 1000;    // Stossgeschwindigkeit min/max
  var PULLMAX = 150;                  // Zuglaenge fuer volle Kraft (virtuelle px)
  var MAXSTEPS = 2600;                // Deckel fuer die Voll-Simulation

  /* ===================== Kugelfarben ===================== */
  var BASE = [null, '#f4c430', '#2f6fd0', '#dd3b34', '#7a3fb2', '#e8842b', '#2ba24a', '#8f2f45'];
  function colorFor(n) { if (n === 8) return '#141414'; return n <= 7 ? BASE[n] : BASE[n - 8]; }
  function groupOf(n) { if (n === 0) return 'cue'; if (n === 8) return 'eight'; return n <= 7 ? 'solid' : 'stripe'; }
  function isStripe(n) { return n >= 9 && n <= 15; }

  /* ===================== Rack / Startaufstellung ===================== */
  var HEADX = PL + (PR - PL) * 0.22;  // Break-Position der Weissen
  var FOOTX = PL + (PR - PL) * 0.72;  // Rack-Spitze
  var SP = 2 * R + 0.6;               // Kugelabstand im Rack (leicht getrennt)
  var ROWS = [[1], [11, 2], [3, 8, 10], [12, 4, 13, 5], [6, 14, 7, 15, 9]];

  function newRack() {
    var balls = [];
    balls[0] = { n: 0, x: HEADX, y: H / 2, vx: 0, vy: 0, in: true };
    var rowDX = SP * 0.866;
    for (var i = 0; i < ROWS.length; i++) {
      var row = ROWS[i], rx = FOOTX + i * rowDX;
      for (var k = 0; k < row.length; k++) {
        var ry = H / 2 + (k - i / 2) * SP;
        balls[row[k]] = { n: row[k], x: rx, y: ry, vx: 0, vy: 0, in: true };
      }
    }
    return balls;
  }
  function cloneBalls(b) {
    var out = [];
    for (var n = 0; n < 16; n++) out[n] = { n: n, x: b[n].x, y: b[n].y, vx: b[n].vx || 0, vy: b[n].vy || 0, in: !!b[n].in };
    return out;
  }
  function countGroup(balls, group) {
    var c = 0; for (var n = 1; n <= 15; n++) { if (balls[n].in && groupOf(n) === group) c++; } return c;
  }

  /* ===================== Deterministische Physik ===================== */
  function isMoving(balls) {
    for (var n = 0; n < 16; n++) { var b = balls[n]; if (b.in && (b.vx * b.vx + b.vy * b.vy) > 0.01) return true; }
    return false;
  }
  /* Ein fester Simulationsschritt.  ev = optionale Ereignis-Hooks
     (cue, pocket, scratch, hit, cushion).  KEIN Math.random hier drin. */
  function stepOnce(balls, dt, ev) {
    var i, j, b;
    for (i = 0; i < 16; i++) { b = balls[i]; if (!b.in) continue; b.x += b.vx * dt; b.y += b.vy * dt; }
    // Taschen zuerst -> Kugeln fallen, statt an der Ecke abzuprallen
    for (i = 0; i < 16; i++) {
      b = balls[i]; if (!b.in) continue;
      for (var p = 0; p < POCKETS.length; p++) {
        var dxp = b.x - POCKETS[p].x, dyp = b.y - POCKETS[p].y;
        if (dxp * dxp + dyp * dyp < RP * RP) {
          b.in = false; b.vx = 0; b.vy = 0;
          if (b.n === 0) { if (ev && ev.scratch) ev.scratch(); }
          else { if (ev && ev.pocket) ev.pocket(b.n); }
          break;
        }
      }
    }
    // Banden
    for (i = 0; i < 16; i++) {
      b = balls[i]; if (!b.in) continue;
      if (b.x < minX) { b.x = minX; if (b.vx < 0) { b.vx = -b.vx * WALL; if (ev && ev.cushion) ev.cushion(Math.abs(b.vx)); } }
      else if (b.x > maxX) { b.x = maxX; if (b.vx > 0) { b.vx = -b.vx * WALL; if (ev && ev.cushion) ev.cushion(Math.abs(b.vx)); } }
      if (b.y < minY) { b.y = minY; if (b.vy < 0) { b.vy = -b.vy * WALL; if (ev && ev.cushion) ev.cushion(Math.abs(b.vy)); } }
      else if (b.y > maxY) { b.y = maxY; if (b.vy > 0) { b.vy = -b.vy * WALL; if (ev && ev.cushion) ev.cushion(Math.abs(b.vy)); } }
    }
    // Kugel-Kugel (elastisch, gleiche Masse)
    var mind = 2 * R;
    for (i = 0; i < 16; i++) {
      var a = balls[i]; if (!a.in) continue;
      for (j = i + 1; j < 16; j++) {
        b = balls[j]; if (!b.in) continue;
        var dx = b.x - a.x, dy = b.y - a.y, d2 = dx * dx + dy * dy;
        if (d2 < mind * mind && d2 > 1e-9) {
          var d = Math.sqrt(d2), nx = dx / d, ny = dy / d, overlap = mind - d;
          a.x -= nx * overlap * 0.5; a.y -= ny * overlap * 0.5;
          b.x += nx * overlap * 0.5; b.y += ny * overlap * 0.5;
          var rvx = b.vx - a.vx, rvy = b.vy - a.vy, vn = rvx * nx + rvy * ny;
          if (vn < 0) {
            var imp = -(1 + REST) * vn * 0.5;
            a.vx -= imp * nx; a.vy -= imp * ny; b.vx += imp * nx; b.vy += imp * ny;
            if ((a.n === 0 || b.n === 0) && ev && ev.cue) ev.cue(a.n === 0 ? b.n : a.n);
            if (ev && ev.hit) ev.hit(Math.abs(vn));
          }
        }
      }
    }
    // Reibung
    for (i = 0; i < 16; i++) {
      b = balls[i]; if (!b.in) continue;
      var sp = Math.sqrt(b.vx * b.vx + b.vy * b.vy);
      if (sp > 0) { var ns = sp - DECEL * dt; if (ns < STOP) { b.vx = 0; b.vy = 0; } else { var kk = ns / sp; b.vx *= kk; b.vy *= kk; } }
    }
  }
  /* Voll-Simulation bis Stillstand (auf einem Klon).  Liefert Endlage + Ereignisse. */
  function computeShot(pre) {
    var firstHit = 0, potted = [], cueIn = false;
    var ev = {
      cue: function (n) { if (!firstHit) firstHit = n; },
      pocket: function (n) { potted.push(n); },
      scratch: function () { cueIn = true; }
    };
    var steps = 0;
    while (isMoving(pre) && steps < MAXSTEPS) { stepOnce(pre, STEP, ev); steps++; }
    return { rest: pre, firstHit: firstHit, potted: potted, cueIn: cueIn };
  }

  /* 8 nach Break-Fehler wieder auf den Fusspunkt setzen (naechste freie Stelle). */
  function respot8(balls) {
    var spots = [[FOOTX, H / 2], [FOOTX + 26, H / 2], [FOOTX - 26, H / 2], [FOOTX, H / 2 - 26], [FOOTX, H / 2 + 26]];
    for (var s = 0; s < spots.length; s++) {
      var x = spots[s][0], y = spots[s][1], ok = true;
      for (var n = 0; n < 16; n++) {
        if (n === 8 || !balls[n].in) continue;
        var dx = balls[n].x - x, dy = balls[n].y - y;
        if (dx * dx + dy * dy < (2 * R + 1) * (2 * R + 1)) { ok = false; break; }
      }
      if (ok) { balls[8].x = x; balls[8].y = y; balls[8].in = true; balls[8].vx = 0; balls[8].vy = 0; return; }
    }
    balls[8].x = FOOTX; balls[8].y = H / 2; balls[8].in = true;
  }

  /* ===================== 8-Ball-Regelauswertung ===================== */
  /* game: { balls (VOR dem Stoss), group{id:str}, order[id0,id1], turn, open, phase }
     sim:  Ergebnis von computeShot.  Liefert das logische Ergebnis. */
  function resolveShot(game, sim) {
    var shooter = game.turn, opp = otherId(game.order, shooter);
    var myGroup = game.group[shooter] || '';
    var potted = sim.potted, scratch = sim.cueIn, firstHit = sim.firstHit;
    var open = game.open, isBreak = game.phase === 'break';
    var out = {
      turn: shooter, ballInHand: false, foul: false, over: false, winner: null,
      group: { }, open: open, phase: isBreak ? 'play' : (game.phase || 'play'), msg: ''
    };
    out.group[game.order[0]] = game.group[game.order[0]] || '';
    out.group[game.order[1]] = game.group[game.order[1]] || '';

    var eightIn = potted.indexOf(8) >= 0;

    /* ---------- Break ---------- */
    if (isBreak) {
      out.open = true;
      var pottedObj = filterObj(potted);
      if (scratch) {
        out.foul = true; out.turn = opp; out.ballInHand = true;
        out.msg = 'Foul beim Break – Ball in der Hand';
      } else if (pottedObj.length > 0) {
        out.turn = shooter;
        out.msg = 'Break: ' + pottedObj.length + ' versenkt – Tisch offen, weiter';
      } else {
        out.turn = opp;
        out.msg = 'Break gespielt – Gegner ist dran';
      }
      return out;
    }

    /* ---------- Foul-Pruefung ---------- */
    var foulReason = '';
    if (!firstHit) foulReason = 'nichts getroffen';
    else if (open) { if (firstHit === 8) foulReason = 'die 8 zuerst getroffen'; }
    else {
      var myRemain = countGroup(game.balls, myGroup);
      if (myRemain > 0) { if (groupOf(firstHit) !== myGroup) foulReason = (firstHit === 8 ? 'die 8 zuerst' : 'fremde Kugel zuerst'); }
      else { if (firstHit !== 8) foulReason = 'du musst die 8 spielen'; }
    }
    if (!foulReason && scratch) foulReason = 'weisse versenkt';
    var foul = !!foulReason;

    /* ---------- 8er ---------- */
    if (eightIn) {
      var myRemainBefore = myGroup ? countGroup(game.balls, myGroup) : 999;
      var legal8 = (!foul) && (!open) && myGroup && (myRemainBefore === 0);
      out.over = true;
      if (legal8) { out.winner = shooter; out.msg = 'Die 8 sauber versenkt – gewonnen!'; }
      else { out.winner = opp; out.msg = 'Die 8 unerlaubt versenkt – verloren'; }
      return out;
    }

    /* ---------- Foul ohne 8 ---------- */
    if (foul) {
      out.foul = true; out.turn = opp; out.ballInHand = true;
      out.msg = 'Foul: ' + foulReason + ' – Ball in der Hand';
      return out;
    }

    /* ---------- sauberer Stoss ---------- */
    if (open) {
      var firstGrp = null;
      for (var i = 0; i < potted.length; i++) { if (potted[i] !== 8) { firstGrp = potted[i]; break; } }
      if (firstGrp != null) {
        var g = groupOf(firstGrp);
        out.group[shooter] = g; out.group[opp] = (g === 'solid' ? 'stripe' : 'solid');
        out.open = false; out.turn = shooter;
        out.msg = 'Zugeteilt: du = ' + (g === 'solid' ? 'Volle' : 'Halbe') + ' – weiter';
      } else { out.turn = opp; out.msg = 'Nichts versenkt – Gegner ist dran'; }
    } else {
      var own = 0; for (var q = 0; q < potted.length; q++) { if (groupOf(potted[q]) === myGroup) own++; }
      if (own > 0) { out.turn = shooter; out.msg = own + ' versenkt – weiter'; }
      else { out.turn = opp; out.msg = 'Nichts Eigenes – Gegner ist dran'; }
    }
    return out;
  }
  function filterObj(potted) { var r = []; for (var i = 0; i < potted.length; i++) if (potted[i] !== 8 && potted[i] !== 0) r.push(potted[i]); return r; }
  function otherId(order, id) { return order[0] === id ? order[1] : order[0]; }

  /* ===================== Netz-Kodierung ===================== */
  function encBalls(b) { var a = []; for (var n = 0; n < 16; n++) { a.push(Math.round(b[n].x), Math.round(b[n].y), b[n].in ? 1 : 0); } return a; }
  function decBalls(a) { var b = []; for (var n = 0; n < 16; n++) { b.push({ n: n, x: a[n * 3], y: a[n * 3 + 1], vx: 0, vy: 0, in: a[n * 3 + 2] === 1 }); } return b; }
  function encFrom(b) { var a = []; for (var n = 0; n < 16; n++) { if (b[n].in) a.push(Math.round(b[n].x), Math.round(b[n].y)); else a.push(-1, -1); } return a; }
  function decFrom(a) { var b = []; for (var n = 0; n < 16; n++) { var x = a[n * 2], on = x !== -1; b.push({ n: n, x: on ? x : 0, y: on ? a[n * 2 + 1] : 0, vx: 0, vy: 0, in: on }); } return b; }

  /* ===================== Bot-KI (nur Solo) ===================== */
  function segClear(balls, ax, ay, bx, by, ig1, ig2) {
    var vx = bx - ax, vy = by - ay, len2 = vx * vx + vy * vy;
    if (len2 < 1e-6) return true;
    for (var n = 0; n < 16; n++) {
      var b = balls[n]; if (!b.in || n === ig1 || n === ig2) continue;
      var t = ((b.x - ax) * vx + (b.y - ay) * vy) / len2;
      if (t < 0 || t > 1) continue;
      var px = ax + vx * t, py = ay + vy * t, dx = b.x - px, dy = b.y - py;
      if (dx * dx + dy * dy < (2 * R) * (2 * R)) return false;
    }
    return true;
  }
  /* Beste Stoss-Loesung suchen: fuer jede eigene Kugel x jede Tasche eine
     Geisterkugel-Loesung pruefen (Weg frei, Schnittwinkel ok) und bewerten. */
  function chooseBotShot(balls, group, open) {
    var cue = balls[0], best = null, n, t;
    var targets = [];
    for (n = 1; n <= 15; n++) {
      if (!balls[n].in) continue;
      if (n === 8) { if (!open && group && countGroup(balls, group) === 0) targets.push(n); continue; }
      if (open || groupOf(n) === group) targets.push(n);
    }
    for (t = 0; t < targets.length; t++) {
      var ball = balls[targets[t]];
      for (var p = 0; p < POCKETS.length; p++) {
        var pk = POCKETS[p];
        var bpx = pk.x - ball.x, bpy = pk.y - ball.y, bpl = Math.sqrt(bpx * bpx + bpy * bpy);
        if (bpl < 1) continue;
        var ubx = bpx / bpl, uby = bpy / bpl;
        var gx = ball.x - ubx * 2 * R, gy = ball.y - uby * 2 * R;   // Geisterkugel-Ziel
        var cgx = gx - cue.x, cgy = gy - cue.y, cgl = Math.sqrt(cgx * cgx + cgy * cgy);
        if (cgl < 1) continue;
        var ucx = cgx / cgl, ucy = cgy / cgl;
        var cosCut = ucx * ubx + ucy * uby;             // Schnittwinkel
        if (cosCut < 0.28) continue;                    // zu duenn
        if (!segClear(balls, cue.x, cue.y, gx, gy, 0, ball.n)) continue;
        if (!segClear(balls, ball.x, ball.y, pk.x, pk.y, ball.n, -1)) continue;
        var quality = cosCut * (1 / (1 + (cgl + bpl) / 550));
        if (!best || quality > best.quality) best = { dirx: ucx, diry: ucy, cgl: cgl, bpl: bpl, cosCut: cosCut, quality: quality };
      }
    }
    if (best) {
      var wantBall = Math.sqrt(2 * DECEL * (best.bpl * 1.25 + 40));
      var contact = wantBall / Math.max(best.cosCut, 0.3);
      var vinit = Math.sqrt(contact * contact + 2 * DECEL * best.cgl);
      vinit = Math.max(MINSPD + 40, Math.min(MAXSPD, vinit));
      return { dirx: best.dirx, diry: best.diry, speed: vinit, safe: false };
    }
    // Sicherheitsstoss: naechste erlaubte Kugel sanft anspielen (kein Foul)
    var near = null, nd = 1e9;
    for (t = 0; t < targets.length; t++) {
      var tb = balls[targets[t]], dx = tb.x - cue.x, dy = tb.y - cue.y, dd = dx * dx + dy * dy;
      if (dd < nd) { nd = dd; near = tb; }
    }
    if (near) {
      var l = Math.sqrt(nd) || 1;
      return { dirx: (near.x - cue.x) / l, diry: (near.y - cue.y) / l, speed: MINSPD + 220, safe: true };
    }
    return { dirx: 1, diry: 0, speed: 400, safe: true };
  }

  /* ===================== Metadaten + Render ===================== */
  App.Minigames.pool = {
    id: 'pool', title: '8-Ball Billard', icon: '🎱', order: 127,
    subtitle: 'Zieh, stoße, versenke – 8-Ball im Neon',
    single: true, multi: true, minPlayers: 2, maxPlayers: 2,

    render: function (root, ctx) {
      var isMulti = ctx.mode === 'multi';
      var room = isMulti ? ctx.room : null;
      var meId = isMulti ? ctx.me.id : 'you';

      /* ---- Aufraeum-Verwaltung ---- */
      var dead = false, raf = null, timers = [], stops = [], domL = [], roomL = [];
      function after(ms, fn) { var t = setTimeout(function () { if (!dead) fn(); }, ms); timers.push(t); return t; }
      function addDom(target, ty, fn, opts) { target.addEventListener(ty, fn, opts); domL.push({ t: target, ty: ty, fn: fn, opts: opts }); }
      function onRoom(evt, fn) { room.on(evt, fn); roomL.push({ e: evt, f: fn }); }
      function cleanup() {
        dead = true;
        if (raf) { cancelAnimationFrame(raf); raf = null; }
        timers.forEach(clearTimeout); timers = [];
        stops.forEach(function (f) { try { f(); } catch (e) {} }); stops = [];
        domL.forEach(function (l) { try { l.t.removeEventListener(l.ty, l.fn, l.opts); } catch (e) {} }); domL = [];
        if (room) roomL.forEach(function (l) { try { room.off(l.e, l.f); } catch (e) {} });
        roomL = [];
      }

      /* ---- Laufzeit-Zustand ---- */
      var game = null;                 // aktueller logischer Zustand
      var ui = null;                   // DOM-Referenzen
      var g2d = null, canvas = null;
      var animating = false, anim = { balls: null, last: 0, acc: 0, soundT: 0, done: null };
      var aim = { active: false, px: 0, py: 0 }, aimView = null;
      var placing = false, placeGhost = null, placedLocal = false;
      var endShown = false, botScheduled = false;
      var DIFF = { name: 'Mittel', err: 0.045, dumb: 0.0 };

      /* ---- Multiplayer-Sync-Zustand ---- */
      var lastShared = (room && room.snapshot() && room.snapshot().shared) || null;
      var started = false, counting = false, built = false, initDone = false, animSeq = 0;

      if (isMulti) startMulti(); else showDiffChooser();
      return { cleanup: cleanup };

      /* ============================================================
       *  SOLO
       * ============================================================ */
      function showDiffChooser() {
        var opts = [
          { name: 'Leicht', err: 0.09, dumb: 0.4, icon: '🐣' },
          { name: 'Mittel', err: 0.045, dumb: 0.12, icon: '🎯' },
          { name: 'Schwer', err: 0.018, dumb: 0.0, icon: '🔥' }
        ];
        var btns = opts.map(function (o) {
          return el('button', { class: 'btn btn-primary pol-diff-btn', type: 'button', onclick: function () {
            DIFF = o; if (App.Audio) App.Audio.sfx('select'); startSolo();
          } }, [el('span', { class: 'pol-diff-ic' }, [o.icon]), el('span', {}, [o.name])]);
        });
        root.innerHTML = '';
        root.appendChild(el('div', { class: 'glass pol-panel' }, [
          el('div', { class: 'pol-panel-ic' }, ['🎱']),
          el('h2', { class: 'neon' }, ['8-Ball Billard']),
          el('p', { class: 'hint-text' }, ['Wie stark soll der Bot spielen?']),
          el('div', { class: 'pol-diff-row' }, btns)
        ]));
      }

      function startSolo() {
        endShown = false; botScheduled = false; placedLocal = false;
        game = {
          order: ['you', 'bot'], balls: newRack(),
          group: { you: '', bot: '' }, turn: 'you', open: true, phase: 'break',
          ballInHand: false, over: false, winner: null, msg: 'Break! Von der Weissen wegziehen und loslassen.'
        };
        buildTable();
        startLoop();
        refresh();
      }

      function scheduleBot() {
        if (botScheduled || animating || game.over || dead) return;
        botScheduled = true;
        after(760, function () {
          botScheduled = false;
          if (dead || game.over || animating || game.turn !== 'bot') return;
          botPlay();
        });
      }
      function botPlay() {
        if (game.ballInHand) botPlaceCue();
        var shot;
        if (game.phase === 'break') {
          var apex = game.balls[1];
          var dx = apex.x - game.balls[0].x, dy = apex.y - game.balls[0].y, l = Math.sqrt(dx * dx + dy * dy) || 1;
          shot = { dirx: dx / l, diry: dy / l, speed: MAXSPD * 0.96, safe: false };
        } else {
          shot = chooseBotShot(game.balls, game.group.bot, game.open);
          if (DIFF.dumb > 0 && Math.random() < DIFF.dumb) {
            // gelegentlich schlechter zielen (menschlicher)
            shot.speed = shot.speed * (0.7 + Math.random() * 0.3);
          }
        }
        var ang = Math.atan2(shot.diry, shot.dirx) + (Math.random() * 2 - 1) * DIFF.err;
        var sp = Math.max(MINSPD, Math.min(MAXSPD, shot.speed));
        executeShot(Math.cos(ang) * sp, Math.sin(ang) * sp);
      }
      function botPlaceCue() {
        // Rasterpositionen testen, beste Stoss-Aussicht nehmen; sonst Kopfpunkt
        var bestPos = null, bestQ = -1, gx, gy;
        for (gx = PL + 60; gx <= PR - 60; gx += 90) {
          for (gy = PT + 45; gy <= PB - 45; gy += 70) {
            if (!validCue(gx, gy)) continue;
            var trial = cloneBalls(game.balls); trial[0].x = gx; trial[0].y = gy; trial[0].in = true;
            var s = chooseBotShot(trial, game.group.bot, game.open);
            var q = s.safe ? 0.01 : 1;
            if (q > bestQ) { bestQ = q; bestPos = [gx, gy]; }
            if (bestQ >= 1) break;
          }
          if (bestQ >= 1) break;
        }
        if (!bestPos) bestPos = validCue(HEADX, H / 2) ? [HEADX, H / 2] : [W / 2, H / 2];
        game.balls[0].x = bestPos[0]; game.balls[0].y = bestPos[1]; game.balls[0].in = true;
      }

      /* ============================================================
       *  MULTIPLAYER
       * ============================================================ */
      function startMulti() {
        onRoom('players', function () { sync(); });
        onRoom('shared', function (sh) { lastShared = sh; sync(); });
        sync();
      }
      function sync() {
        if (dead || counting) return;
        var players = room.players();
        if (players.length < 2) {
          if (built && !endShown && !game.over) { game.over = true; game.winner = meId; game.msg = 'Gegner hat verlassen'; showEnd(); }
          else if (!built) showWaiting(players.length);
          return;
        }
        if (room.isHost() && (!lastShared || !lastShared.balls) && !initDone) { initShared(players); return; }
        if (!lastShared || !lastShared.balls) { if (!built) showWaiting(players.length, true); return; }
        if (!started) {
          started = true; counting = true;
          var snap = room.snapshot() || {};
          var startAt = (snap.round && snap.round.startAt) || (room.now() + 3000);
          stops.push(App.MG.countdown(root, startAt, function () { counting = false; sync(); }, room.now));
          return;
        }
        if (!built) {
          game = { order: lastShared.order.slice(), balls: null, group: {}, turn: '', open: true, phase: 'break', ballInHand: false, over: false, winner: null, msg: '' };
          buildTable(); built = true; startLoop();
          adoptShared(); animSeq = (lastShared.shotSeq || 0); refresh();
          return;
        }
        var seq = lastShared.shotSeq || 0;
        if (seq > animSeq && lastShared.shot) {
          animSeq = seq;
          if (lastShared.shooter !== meId) {
            var fromB = decFrom(lastShared.shot.from);
            startAnim(fromB, lastShared.shot.cvx, lastShared.shot.cvy, function () { adoptShared(); refresh(); });
          }
          return;
        }
        if (!animating) { adoptShared(); refresh(); }
      }
      function initShared(players) {
        initDone = true;
        var o0 = players[0].id, o1 = players[1].id, grp = {}; grp[o0] = ''; grp[o1] = '';
        room.setShared({
          order: [o0, o1], balls: encBalls(newRack()), group: grp, turn: o0,
          open: true, phase: 'break', ballInHand: false, over: false, winner: '',
          foul: false, msg: 'Break!', shotSeq: 0, shooter: '', shot: null
        });
      }
      function adoptShared() {
        var sh = lastShared; if (!sh || !sh.balls) return;
        game.order = sh.order.slice();
        game.balls = decBalls(sh.balls);
        game.group = sh.group || {};
        game.turn = sh.turn; game.open = !!sh.open; game.phase = sh.phase || 'play';
        game.ballInHand = !!sh.ballInHand; game.over = !!sh.over;
        game.winner = sh.winner || null; game.msg = sh.msg || '';
        placedLocal = false; aim.active = false; aimView = null; placing = false; placeGhost = null;
      }
      function showWaiting(count, starting) {
        root.innerHTML = '';
        root.appendChild(el('div', { class: 'glass pol-panel' }, [
          el('div', { class: 'pol-panel-ic pol-spin' }, ['🎱']),
          el('h2', { class: 'neon' }, ['8-Ball Billard']),
          el('div', { class: 'pol-wait-count neon-strong' }, [count + ' / 2']),
          el('p', { class: 'hint-text' }, [starting ? 'Spiel startet gleich …' : 'Warte auf den zweiten Spieler …']),
          el('div', { class: 'controls-row' }, [
            el('button', { class: 'btn btn-ghost', type: 'button', onclick: ctx.onExit }, ['Zurück zur Lobby'])
          ])
        ]));
      }

      /* ============================================================
       *  Stoss ausfuehren (Solo + aktiver Multi-Spieler)
       * ============================================================ */
      function executeShot(vx, vy) {
        if (animating || game.over || dead) return;
        var from = cloneBalls(game.balls); from[0].in = true;
        var sim = cloneBalls(from); sim[0].vx = vx; sim[0].vy = vy;
        var res = computeShot(sim);
        var out = resolveShot(game, res);
        var rest = sim;
        if (game.phase === 'break' && res.potted.indexOf(8) >= 0 && !out.over) respot8(rest);

        game.balls = rest; game.group = out.group; game.open = out.open; game.phase = out.phase;
        game.turn = out.turn; game.ballInHand = out.ballInHand; game.over = out.over;
        game.winner = out.winner; game.msg = out.msg;
        placedLocal = false; aim.active = false; aimView = null; placing = false; placeGhost = null;

        if (isMulti) {
          var nextSeq = ((lastShared && lastShared.shotSeq) || 0) + 1;
          animSeq = nextSeq;
          try {
            room.setShared({
              balls: encBalls(rest), group: out.group, turn: out.turn, open: out.open,
              phase: out.phase, ballInHand: out.ballInHand, over: out.over,
              winner: out.winner || '', foul: out.foul, msg: out.msg,
              shotSeq: nextSeq, shooter: meId,
              shot: { seq: nextSeq, cvx: Math.round(vx), cvy: Math.round(vy), from: encFrom(from) }
            });
          } catch (e) {}
        }
        if (out.foul && App.Audio) after(80, function () { if (App.Audio) App.Audio.sfx('error'); });
        startAnim(from, vx, vy, function () { refresh(); });
      }

      /* ============================================================
       *  Animation (Wall-Clock-getaktet, fester dt)
       * ============================================================ */
      function startAnim(fromBalls, vx, vy, done) {
        animating = true;
        anim.balls = cloneBalls(fromBalls); anim.balls[0].in = true;
        anim.balls[0].vx = vx; anim.balls[0].vy = vy;
        anim.last = Date.now(); anim.acc = 0; anim.done = done;
        if (App.Audio) App.Audio.sfx('whoosh');
      }
      function soundEv() {
        return {
          cue: function () {},
          pocket: function () { if (App.Audio) App.Audio.sfx('pop'); },
          scratch: function () { if (App.Audio) App.Audio.sfx('error'); },
          hit: function (sp) { var t = Date.now(); if (sp > 55 && t - anim.soundT > 45) { anim.soundT = t; if (App.Audio) App.Audio.blip(160 + Math.min(430, sp * 0.4), 0.05, { type: 'sine', peak: 0.05 }); } },
          cushion: function (sp) { var t = Date.now(); if (sp > 55 && t - anim.soundT > 45) { anim.soundT = t; if (App.Audio) App.Audio.sfx('tick'); } }
        };
      }
      function startLoop() { if (!raf) raf = requestAnimationFrame(frame); }
      function frame() {
        if (dead) { raf = null; return; }
        raf = requestAnimationFrame(frame);
        if (animating) {
          var now = Date.now(), elapsed = now - anim.last; anim.last = now;
          anim.acc += elapsed; if (anim.acc > 400) anim.acc = 400;
          var ev = soundEv(), steps = 0;
          while (anim.acc >= STEPMS && isMoving(anim.balls) && steps < 320) { stepOnce(anim.balls, STEP, ev); anim.acc -= STEPMS; steps++; }
          draw(anim.balls, null, null);
          if (!isMoving(anim.balls)) {
            animating = false;
            // auf autoritative Endlage einrasten
            if (game && game.balls) draw(game.balls, null, null);
            var d = anim.done; anim.done = null; if (d) d();
          }
        } else if (game && game.balls) {
          draw(game.balls, aimView, placeGhost);
        }
      }

      /* ============================================================
       *  UI-Aufbau
       * ============================================================ */
      function buildTable() {
        var mine = sideRefs(true), theirs = sideRefs(false);
        ui = { mine: mine, theirs: theirs };
        var head = el('div', { class: 'pol-head glass' }, [mine.chip, el('div', { class: 'pol-vs' }, ['VS']), theirs.chip]);
        ui.status = el('div', { class: 'pol-status' }, ['']);
        canvas = el('canvas', { class: 'pol-canvas', width: W, height: H });
        var powerFill = el('div', { class: 'pol-power-fill' });
        ui.powerFill = powerFill;
        ui.power = el('div', { class: 'pol-power' }, [powerFill]);
        var stage = el('div', { class: 'pol-stage' }, [canvas, ui.power]);
        ui.msg = el('div', { class: 'pol-msg' }, ['']);
        var hint = el('div', { class: 'pol-hint hint-text' }, [
          'Von der weissen Kugel wegziehen & loslassen · erste versenkte Kugel = Voll/Halb · alle eigenen + die 8 legal = Sieg'
        ]);
        var wrap = el('div', { class: 'pol-wrap' }, [head, ui.status, stage, ui.msg, hint]);
        root.innerHTML = ''; root.appendChild(wrap);
        g2d = canvas.getContext('2d');
        attachInput();
      }
      function sideRefs(isMe) {
        var name = el('div', { class: 'pol-nm' }, ['—']);
        var grp = el('div', { class: 'pol-grp' }, ['offen']);
        var dot = el('span', { class: 'pol-dot' });
        var cnt = el('div', { class: 'pol-cnt' }, ['']);
        var chip = el('div', { class: 'pol-chip' + (isMe ? ' me' : '') }, [
          dot, el('div', { class: 'pol-chip-info' }, [name, grp]), cnt
        ]);
        return { chip: chip, name: name, grp: grp, dot: dot, cnt: cnt };
      }

      function nameOf(id) {
        if (!isMulti) return id === 'you' ? 'Du' : 'Bot';
        var ps = room.players();
        for (var i = 0; i < ps.length; i++) if (ps[i].id === id) return ps[i].name + (id === meId ? ' (du)' : '');
        return id === meId ? 'Du' : 'Gegner';
      }
      function refresh() {
        if (!ui || !game) return;
        if (game.over) { showEnd(); return; }
        updateChips(); updateStatus();
        if (!isMulti && game.turn === 'bot' && !animating) scheduleBot();
      }
      function updateChips() {
        var order = game.order;
        // "mine" = ich, "theirs" = Gegner
        var meSide = ui.mine, opSide = ui.theirs;
        fillChip(meSide, meId);
        fillChip(opSide, otherId(order, meId));
      }
      function fillChip(side, id) {
        side.name.textContent = nameOf(id);
        var grp = game.group[id] || '';
        if (game.open || !grp) { side.grp.textContent = 'offen'; side.dot.style.background = 'var(--muted)'; side.cnt.textContent = ''; }
        else {
          var label = grp === 'solid' ? 'Volle' : 'Halbe';
          var remain = countGroup(game.balls, grp);
          side.grp.textContent = label + (game.phase !== 'break' && remain === 0 ? ' · auf die 8' : '');
          side.dot.style.background = grp === 'solid' ? '#f4c430' : '#33e6d0';
          side.cnt.textContent = remain + ' übrig';
        }
        side.chip.classList.toggle('active', game.turn === id);
      }
      function updateStatus() {
        var myTurn = game.turn === meId;
        var txt, cls;
        if (myTurn) {
          if (game.ballInHand && !placedLocal) { txt = 'Ball in der Hand – weisse Kugel setzen'; cls = 'you'; }
          else { txt = 'Du bist dran – zielen & schießen'; cls = 'you'; }
        } else { txt = nameOf(game.turn) + ' ist dran'; cls = 'opp'; }
        ui.status.textContent = txt; ui.status.className = 'pol-status ' + cls;
        ui.msg.textContent = game.msg || '';
        ui.msg.className = 'pol-msg' + (game.foul ? ' foul' : '');
      }

      /* ============================================================
       *  Ende
       * ============================================================ */
      function scoreFor(id) {
        var grp = game.group[id] || '';
        var potted = grp ? (7 - countGroup(game.balls, grp)) : 0;
        return potted * 100 + (game.winner === id ? 1000 : 0);
      }
      function showEnd() {
        if (endShown) return; endShown = true;
        animating = false;
        if (raf) { cancelAnimationFrame(raf); raf = null; }
        var iWon = game.winner === meId;
        if (App.Audio) App.Audio.sfx(iWon ? 'win' : 'lose');

        if (isMulti) {
          var myScore = scoreFor(meId) + DIFF.dumb * 0;
          try { room.reportScore(myScore); } catch (e) {}
          if (iWon && App.Scores) App.Scores.winCurrent();
          var order = game.order;
          var players = [
            { id: order[0], name: nameOf(order[0]).replace(' (du)', ''), score: scoreFor(order[0]) },
            { id: order[1], name: nameOf(order[1]).replace(' (du)', ''), score: scoreFor(order[1]) }
          ];
          after(700, function () {
            if (dead) return;
            App.MG.endScreen(root, { players: players, meId: meId, onExit: ctx.onExit });
          });
        } else {
          var diffBonus = DIFF.name === 'Schwer' ? 350 : DIFF.name === 'Mittel' ? 150 : 0;
          var score = scoreFor('you') + (iWon ? diffBonus : 0);
          var best = App.Storage.get('best_pool', 0);
          var nb = score > best;
          if (nb) App.Storage.set('best_pool', score);
          if (iWon && App.Scores) App.Scores.winCurrent();
          App.MG.endScreen(root, {
            score: score, best: best, newBest: nb,
            title: iWon ? '🎱 Gewonnen!' : '🎱 Verloren',
            label: (iWon ? 'Sieg über den Bot (' + DIFF.name + ')' : 'Der Bot war stärker')
              + (nb ? ' · neuer Rekord! 🎉' : ' · Bestwert: ' + App.MG.fmt(best)),
            onExit: ctx.onExit,
            onAgain: function () { endShown = false; showDiffChooser(); }
          });
        }
      }

      /* ============================================================
       *  Eingabe (Zeigergeraet + Touch)
       * ============================================================ */
      function canInput() { return !dead && !animating && !endShown && game && !game.over && game.turn === meId; }
      function placingActive() { return game && game.ballInHand && game.turn === meId && !placedLocal; }
      function toVirtual(e) {
        var r = canvas.getBoundingClientRect();
        return { x: (e.clientX - r.left) / r.width * W, y: (e.clientY - r.top) / r.height * H };
      }
      function validCue(x, y) {
        if (x < minX || x > maxX || y < minY || y > maxY) return false;
        for (var n = 1; n <= 15; n++) {
          var b = game.balls[n]; if (!b.in) continue;
          var dx = b.x - x, dy = b.y - y;
          if (dx * dx + dy * dy < (2 * R) * (2 * R)) return false;
        }
        // nicht direkt in einer Tasche
        for (var p = 0; p < POCKETS.length; p++) { var px = POCKETS[p].x - x, py = POCKETS[p].y - y; if (px * px + py * py < (RP + 2) * (RP + 2)) return false; }
        return true;
      }
      function attachInput() {
        addDom(canvas, 'pointerdown', onDown);
        addDom(canvas, 'pointermove', onMove);
        addDom(canvas, 'pointerup', onUp);
        addDom(canvas, 'pointercancel', onUp);
      }
      function onDown(e) {
        if (!canInput()) return;
        e.preventDefault();
        try { canvas.setPointerCapture(e.pointerId); } catch (err) {}
        var v = toVirtual(e);
        if (placingActive()) {
          placing = true;
          placeGhost = { x: clamp(v.x, minX, maxX), y: clamp(v.y, minY, maxY), valid: false };
          placeGhost.valid = validCue(placeGhost.x, placeGhost.y);
        } else if (game.balls[0].in) {
          aim.active = true; aim.px = v.x; aim.py = v.y; updateAim();
        }
      }
      function onMove(e) {
        if (dead) return;
        if (placing) {
          var v = toVirtual(e);
          placeGhost = { x: clamp(v.x, minX, maxX), y: clamp(v.y, minY, maxY), valid: false };
          placeGhost.valid = validCue(placeGhost.x, placeGhost.y);
        } else if (aim.active) {
          var w = toVirtual(e); aim.px = w.x; aim.py = w.y; updateAim();
        }
      }
      function onUp(e) {
        if (dead) return;
        if (placing) {
          placing = false;
          if (placeGhost && placeGhost.valid) {
            game.balls[0].x = placeGhost.x; game.balls[0].y = placeGhost.y; game.balls[0].in = true;
            placedLocal = true;
            if (App.Audio) App.Audio.sfx('select');
            updateStatus();
          } else if (UI.toast) { UI.toast('Dort ist kein Platz für die Weiße', 'info'); }
          placeGhost = null;
        } else if (aim.active) {
          aim.active = false;
          if (aimView && aimView.power > 0.04) {
            var speed = MINSPD + aimView.power * (MAXSPD - MINSPD);
            var vx = aimView.dirx * speed, vy = aimView.diry * speed;
            aimView = null; if (ui.power) ui.power.classList.remove('show');
            executeShot(vx, vy);
          } else { aimView = null; if (ui.power) ui.power.classList.remove('show'); }
        }
      }
      function updateAim() {
        var cue = game.balls[0];
        if (!cue.in) { aimView = null; return; }
        var dx = aim.px - cue.x, dy = aim.py - cue.y, L = Math.sqrt(dx * dx + dy * dy);
        if (L < 8) { aimView = null; if (ui.power) ui.power.classList.remove('show'); return; }
        var dirx = -dx / L, diry = -dy / L, frac = Math.min(1, L / PULLMAX);
        aimView = { cx: cue.x, cy: cue.y, dirx: dirx, diry: diry, power: frac, preview: previewContact(dirx, diry), pullx: aim.px, pully: aim.py };
        if (ui.power) { ui.power.classList.add('show'); ui.powerFill.style.width = Math.round(frac * 100) + '%'; }
      }
      function previewContact(dirx, diry) {
        var cue = game.balls[0], t = 0, maxT = Math.sqrt(W * W + H * H), stepT = 2, px = cue.x, py = cue.y;
        while (t < maxT) {
          px = cue.x + dirx * t; py = cue.y + diry * t;
          if (px < minX || px > maxX || py < minY || py > maxY) {
            return { type: 'cushion', x: clamp(px, minX, maxX), y: clamp(py, minY, maxY) };
          }
          for (var n = 1; n <= 15; n++) {
            var b = game.balls[n]; if (!b.in) continue;
            var bx = b.x - px, by = b.y - py;
            if (bx * bx + by * by <= (2 * R) * (2 * R)) return { type: 'ball', x: px, y: py, tx: b.x, ty: b.y };
          }
          t += stepT;
        }
        return { type: 'cushion', x: px, y: py };
      }

      /* ============================================================
       *  Zeichnen
       * ============================================================ */
      function draw(balls, av, pg) {
        var g = g2d; if (!g) return;
        // Filz
        var grd = g.createLinearGradient(0, 0, 0, H);
        grd.addColorStop(0, '#0a3d24'); grd.addColorStop(1, '#062a18');
        g.fillStyle = grd; g.fillRect(0, 0, W, H);
        // Bandenrahmen
        g.save(); g.strokeStyle = 'rgba(57,255,20,0.30)'; g.lineWidth = 3;
        roundRect(g, PL - 6, PT - 6, (PR - PL) + 12, (PB - PT) + 12, 14); g.stroke();
        g.strokeStyle = 'rgba(57,255,20,0.16)'; g.lineWidth = 2;
        roundRect(g, PL, PT, PR - PL, PB - PT, 8); g.stroke(); g.restore();
        // Kopflinie + Fusspunkt (dezent)
        g.save(); g.strokeStyle = 'rgba(200,255,220,0.10)'; g.lineWidth = 1;
        g.beginPath(); g.moveTo(HEADX, PT); g.lineTo(HEADX, PB); g.stroke();
        g.fillStyle = 'rgba(200,255,220,0.14)'; g.beginPath(); g.arc(FOOTX, H / 2, 2.5, 0, Math.PI * 2); g.fill(); g.restore();
        // Taschen
        for (var p = 0; p < POCKETS.length; p++) {
          var pk = POCKETS[p];
          g.save(); g.fillStyle = '#020c07';
          g.beginPath(); g.arc(pk.x, pk.y, RP, 0, Math.PI * 2); g.fill();
          g.strokeStyle = 'rgba(0,0,0,0.6)'; g.lineWidth = 2; g.stroke();
          g.strokeStyle = 'rgba(57,255,20,0.25)'; g.lineWidth = 1;
          g.beginPath(); g.arc(pk.x, pk.y, RP - 1, 0, Math.PI * 2); g.stroke(); g.restore();
        }
        // Kugeln
        for (var n = 0; n < 16; n++) { if (balls[n].in) drawBall(g, balls[n]); }
        // Ziel-Overlay
        if (av) drawAim(g, av);
        // Ball-in-Hand Geist
        if (pg) drawPlaceGhost(g, pg);
      }
      function drawBall(g, b) {
        var x = b.x, y = b.y;
        g.save();
        g.shadowColor = 'rgba(0,0,0,0.45)'; g.shadowBlur = 6; g.shadowOffsetY = 2;
        if (b.n === 0) {
          var cg = g.createRadialGradient(x - 3, y - 3, 1, x, y, R);
          cg.addColorStop(0, '#ffffff'); cg.addColorStop(1, '#d7ded8');
          g.fillStyle = cg; g.beginPath(); g.arc(x, y, R, 0, Math.PI * 2); g.fill();
        } else {
          var col = colorFor(b.n);
          if (isStripe(b.n)) {
            // weisse Basis
            g.fillStyle = '#f2f4f0'; g.beginPath(); g.arc(x, y, R, 0, Math.PI * 2); g.fill();
            // farbiges Band
            g.save(); g.beginPath(); g.arc(x, y, R, 0, Math.PI * 2); g.clip();
            g.fillStyle = col; g.fillRect(x - R, y - R * 0.52, 2 * R, R * 1.04); g.restore();
          } else {
            var bg = g.createRadialGradient(x - 3, y - 3, 1, x, y, R);
            bg.addColorStop(0, lighten(col)); bg.addColorStop(1, col);
            g.fillStyle = bg; g.beginPath(); g.arc(x, y, R, 0, Math.PI * 2); g.fill();
          }
          // Nummernkreis
          g.shadowColor = 'transparent'; g.shadowBlur = 0; g.shadowOffsetY = 0;
          g.fillStyle = b.n === 8 ? '#f2f4f0' : '#ffffff';
          g.beginPath(); g.arc(x, y, R * 0.56, 0, Math.PI * 2); g.fill();
          g.fillStyle = '#12241a'; g.font = '700 ' + Math.round(R * 0.9) + 'px system-ui,Segoe UI,Arial,sans-serif';
          g.textAlign = 'center'; g.textBaseline = 'middle';
          g.fillText(String(b.n), x, y + 0.5);
        }
        g.restore();
        // Glanzpunkt
        g.save(); g.fillStyle = 'rgba(255,255,255,0.5)';
        g.beginPath(); g.arc(x - R * 0.32, y - R * 0.34, R * 0.22, 0, Math.PI * 2); g.fill(); g.restore();
      }
      function drawAim(g, av) {
        var pre = av.preview;
        // Stossrichtung (gestrichelt)
        g.save();
        g.strokeStyle = 'rgba(230,255,224,0.85)'; g.lineWidth = 2; g.setLineDash([9, 8]);
        g.beginPath(); g.moveTo(av.cx, av.cy); g.lineTo(pre.x, pre.y); g.stroke();
        g.setLineDash([]);
        if (pre.type === 'ball') {
          // Geisterkugel am Kontaktpunkt
          g.strokeStyle = 'rgba(230,255,224,0.9)'; g.lineWidth = 2;
          g.beginPath(); g.arc(pre.x, pre.y, R, 0, Math.PI * 2); g.stroke();
          // Zielrichtung der getroffenen Kugel
          var tdx = pre.tx - pre.x, tdy = pre.ty - pre.y, tl = Math.sqrt(tdx * tdx + tdy * tdy) || 1;
          g.strokeStyle = 'rgba(255,210,63,0.9)'; g.lineWidth = 2;
          g.beginPath(); g.moveTo(pre.tx, pre.ty); g.lineTo(pre.tx + tdx / tl * 42, pre.ty + tdy / tl * 42); g.stroke();
        } else {
          g.fillStyle = 'rgba(51,230,208,0.9)';
          g.beginPath(); g.arc(pre.x, pre.y, 4, 0, Math.PI * 2); g.fill();
        }
        // Zugstock hinter der Weissen
        g.strokeStyle = 'rgba(255,210,63,0.85)'; g.lineWidth = 4; g.lineCap = 'round';
        g.beginPath(); g.moveTo(av.cx, av.cy); g.lineTo(av.pullx, av.pully); g.stroke();
        g.restore();
      }
      function drawPlaceGhost(g, pg) {
        g.save();
        g.strokeStyle = pg.valid ? 'rgba(57,255,20,0.95)' : 'rgba(255,77,109,0.95)';
        g.lineWidth = 2; g.setLineDash([5, 5]);
        g.beginPath(); g.arc(pg.x, pg.y, R, 0, Math.PI * 2); g.stroke();
        g.setLineDash([]);
        g.fillStyle = pg.valid ? 'rgba(240,255,240,0.4)' : 'rgba(255,77,109,0.2)';
        g.beginPath(); g.arc(pg.x, pg.y, R - 1, 0, Math.PI * 2); g.fill();
        g.restore();
      }
    }
  };

  /* ===================== Helfer ===================== */
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function lighten(hex) {
    var c = hex.replace('#', '');
    var r = parseInt(c.substr(0, 2), 16), gg = parseInt(c.substr(2, 2), 16), b = parseInt(c.substr(4, 2), 16);
    r = Math.min(255, r + 70); gg = Math.min(255, gg + 70); b = Math.min(255, b + 70);
    return 'rgb(' + r + ',' + gg + ',' + b + ')';
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

  /* ===================== Styles ===================== */
  function injectStyle() {
    UI.injectStyle('mg-pool-css', [
      '.pol-wrap{display:flex;flex-direction:column;gap:12px;max-width:820px;margin:0 auto;}',
      '.pol-head{display:flex;align-items:stretch;justify-content:space-between;gap:10px;padding:10px 14px;}',
      '.pol-chip{flex:1;min-width:0;display:flex;align-items:center;gap:9px;padding:8px 12px;border-radius:13px;background:rgba(6,28,18,.6);border:1px solid var(--stroke);transition:.15s;}',
      '.pol-chip.me{border-color:var(--stroke-2);}',
      '.pol-chip.active{border-color:var(--neon);box-shadow:0 0 0 1px var(--neon),0 0 16px rgba(57,255,20,.32);}',
      '.pol-dot{width:14px;height:14px;border-radius:50%;flex:0 0 auto;background:var(--muted);box-shadow:0 0 6px rgba(0,0,0,.5);}',
      '.pol-chip-info{flex:1;min-width:0;display:flex;flex-direction:column;line-height:1.2;}',
      '.pol-nm{font-weight:800;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      '.pol-grp{font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;}',
      '.pol-cnt{font-size:12px;font-weight:800;color:var(--leaf);white-space:nowrap;}',
      '.pol-vs{align-self:center;color:var(--muted);font-weight:900;font-size:12px;letter-spacing:2px;}',
      '.pol-status{text-align:center;font-weight:900;font-size:clamp(15px,4.4vw,20px);min-height:24px;}',
      '.pol-status.you{color:var(--neon);text-shadow:0 0 10px rgba(57,255,20,.4);}',
      '.pol-status.opp{color:var(--aqua);}',
      '.pol-stage{position:relative;width:100%;max-width:780px;margin:0 auto;}',
      '.pol-canvas{display:block;width:100%;max-width:780px;height:auto;aspect-ratio:760 / 400;border-radius:14px;',
      'border:2px solid rgba(57,255,20,.32);box-shadow:0 0 40px rgba(57,255,20,.2),inset 0 0 50px rgba(0,0,0,.35);',
      'background:#062a18;touch-action:none;user-select:none;-webkit-user-select:none;-webkit-tap-highlight-color:transparent;cursor:crosshair;}',
      '.pol-power{position:absolute;left:50%;bottom:10px;transform:translateX(-50%);width:min(64%,340px);height:10px;',
      'border-radius:999px;background:rgba(4,16,10,.75);border:1px solid var(--stroke);overflow:hidden;opacity:0;transition:opacity .12s;pointer-events:none;}',
      '.pol-power.show{opacity:1;}',
      '.pol-power-fill{height:100%;width:0;border-radius:999px;background:linear-gradient(90deg,var(--neon),var(--gold),var(--danger));box-shadow:0 0 12px rgba(255,210,63,.5);transition:width .04s linear;}',
      '.pol-msg{text-align:center;font-size:13px;font-weight:700;color:var(--leaf);min-height:18px;}',
      '.pol-msg.foul{color:var(--danger);text-shadow:0 0 10px rgba(255,77,109,.4);}',
      '.pol-hint{text-align:center;font-size:12px;line-height:1.4;}',
      /* Panels (Warten / Schwierigkeit) */
      '.pol-panel{padding:30px 24px;text-align:center;display:flex;flex-direction:column;gap:14px;align-items:center;max-width:460px;margin:0 auto;}',
      '.pol-panel-ic{font-size:52px;filter:drop-shadow(0 0 14px rgba(57,255,20,.5));}',
      '.pol-spin{animation:pol-spin 2.6s linear infinite;}',
      '@keyframes pol-spin{to{transform:rotate(360deg);}}',
      '.pol-wait-count{font-size:34px;font-weight:900;}',
      '.pol-diff-row{display:flex;gap:10px;flex-wrap:wrap;justify-content:center;}',
      '.pol-diff-btn{display:flex;flex-direction:column;align-items:center;gap:4px;padding:12px 18px;min-width:86px;}',
      '.pol-diff-ic{font-size:24px;line-height:1;}'
    ].join(''));
  }
})();
