/* paperio.js — "Gebiets-Eroberung": Paper.io im Neon-Dschungel.
 *
 * IDEE      : Jeder besitzt ein kleines Startgebiet und faehrt STAENDIG vorwaerts.
 *   Verlaesst man sein Gebiet, zieht man einen leuchtenden Schweif hinter sich her.
 *   Kehrt man ins eigene Gebiet zurueck, wird die umschlossene Flaeche erobert
 *   (Schweif + eingeschlossene Zellen werden dein Land -> +Prozent). Faehrt jemand
 *   ueber einen Schweif (auch ueber den eigenen), stirbt der BESITZER dieses
 *   Schweifs. Wer draussen von der Wand erfasst wird oder Kopf-an-Kopf faehrt,
 *   stirbt ebenfalls. Nach dem Tod bleibt das Land erhalten, man verliert nur den
 *   laufenden Schweif und startet nach kurzer Pause wieder im eigenen Gebiet
 *   (fairer fuer ein 2-Minuten-Rennen als der harte Paper.io-Reset).
 *
 * UNTERSCHIED zu "Farb-Krieg": hier zieht man einen Schweif und schliesst Flaechen,
 *   es wird nicht beim blossen Beruehren gefaerbt.
 *
 * STEUERUNG : Pfeiltasten / WASD · am Handy auf der Flaeche wischen oder die 4
 *   Pfeil-Buttons · keine Kehrtwende (180 Grad wird abgelehnt).
 *
 * PUNKTE    : Prozent des Gitters, das dir gehoert (x10 als Ganzzahl fuer die
 *   Rangliste). Groesste Flaeche nach 2 Minuten gewinnt. Solo-Rekord in
 *   App.Storage unter 'best_paperio'.
 *
 * SOLO      : gegen 3 Bots, die vorsichtige kleine Rechteck-Schleifen ziehen,
 *   ins Gebiet zurueckkehren und kurz pausieren (meiden eigenen Schweif + Wand).
 *
 * SYNC      : Host-autoritativ (wie pong). Der Host rechnet Gitter, Schweife und
 *   Flaechen und sendet ~10x/s KOMPAKT per room.setShared: Territorium und
 *   Schweif je als Ziffernfolge (ein Zeichen pro Zelle, 0=leer, 1..6=Besitzer),
 *   dazu die Koepfe. Jeder Spieler meldet nur seine Lenk-Richtung per
 *   room.reportState({d}). Nicht-Host rendert aus dem empfangenen Zustand und
 *   glaettet die Koepfe zwischen Updates. Zeit immer ueber room.now() (synchron).
 *   cleanup() stoppt rAF, alle Timer, alle Listener und jedes room.on(). */
(function () {
  'use strict';
  window.App = window.App || {}; App.Minigames = App.Minigames || {};
  var UI = App.UI, el = UI.el;

  /* ===================== Konstanten ===================== */
  var GW = 40, GH = 25, N = GW * GH;          // Gitter 40x25 = 1000 Zellen
  var CELL = 20, W = GW * CELL, H = GH * CELL; // virtuelle Canvas-Groesse 800x500
  var TICK_MS = 120;                           // ein Feld pro 120 ms
  var MATCH_TIME = 120;                         // s Rundenzeit (2 Minuten)
  var RESPAWN_MS = 1400;                        // Pause nach dem Tod
  var BROADCAST_MS = 100;                       // Host: setShared-Drossel (~10x/s)
  var REPORT_MS = 90;                           // Spieler: reportState-Drossel
  var SCORE_MS = 400;                           // reportScore-Drossel
  var DX = [1, 0, -1, 0], DY = [0, 1, 0, -1];   // 0=Ost 1=Sued 2=West 3=Nord
  var ARROWS = ['▶', '▼', '◀', '▲'];
  var BOT_NAMES = ['Kobra', 'Tukan', 'Gecko'];
  var HINT = 'Pfeiltasten / WASD · am Handy wischen oder Pfeil-Buttons · verlasse dein Gebiet, zieh einen Schweif und kehr zurueck · Schweif getroffen = raus';

  var SPAWNS = [
    { x: 7, y: 6, d: 0 }, { x: 32, y: 6, d: 2 },
    { x: 7, y: 18, d: 0 }, { x: 32, y: 18, d: 2 },
    { x: 20, y: 4, d: 1 }, { x: 20, y: 20, d: 3 }
  ];
  var COLORS = [
    { line: '#39ff14', terr: 'rgba(57,255,20,0.32)', trail: 'rgba(120,255,90,0.62)', glow: 'rgba(57,255,20,0.9)' },
    { line: '#33e6d0', terr: 'rgba(51,230,208,0.32)', trail: 'rgba(120,240,225,0.6)', glow: 'rgba(51,230,208,0.9)' },
    { line: '#ffd23f', terr: 'rgba(255,210,63,0.30)', trail: 'rgba(255,224,120,0.6)', glow: 'rgba(255,210,63,0.9)' },
    { line: '#ff4d6d', terr: 'rgba(255,77,109,0.30)', trail: 'rgba(255,140,165,0.6)', glow: 'rgba(255,77,109,0.9)' },
    { line: '#c86bff', terr: 'rgba(200,107,255,0.30)', trail: 'rgba(220,160,255,0.6)', glow: 'rgba(200,107,255,0.9)' },
    { line: '#ff9e3f', terr: 'rgba(255,158,63,0.30)', trail: 'rgba(255,190,120,0.6)', glow: 'rgba(255,158,63,0.9)' }
  ];

  /* ===================== reine Gitter-Simulation ===================== */
  function clampX(x) { return x < 0 ? 0 : (x >= GW ? GW - 1 : x); }
  function clampY(y) { return y < 0 ? 0 : (y >= GH ? GH - 1 : y); }
  function opp(d) { return (d + 2) % 4; }

  function stampTerritory(s, pi, cx, cy) {
    for (var yy = cy - 1; yy <= cy + 2; yy++) {
      for (var xx = cx - 1; xx <= cx + 2; xx++) {
        if (xx < 0 || yy < 0 || xx >= GW || yy >= GH) continue;
        s.grid[yy * GW + xx] = pi + 1;
      }
    }
  }

  function newSim(roster) {
    var s = {
      n: roster.length, tick: 0, over: false, dirtyTerr: true,
      grid: new Uint8Array(N), trail: new Uint8Array(N),
      mask: new Int32Array(N), maskId: 0, q: new Int32Array(N), players: []
    };
    for (var i = 0; i < roster.length; i++) {
      var sp = SPAWNS[i];
      s.players.push({
        idx: i, bot: !!roster[i].bot, alive: true, out: false, wasOut: false,
        x: sp.x, y: sp.y, px: sp.x, py: sp.y, dir: sp.d, pendingDir: sp.d,
        hx: sp.x, hy: sp.y, trail: [], deadAt: -1, respawnAt: 0,
        plan: [], restUntil: 0, loopLen: 12, goalX: sp.x, goalY: sp.y
      });
      stampTerritory(s, i, sp.x, sp.y);
    }
    return s;
  }

  function killPlayer(s, i, now) {
    var p = s.players[i];
    if (!p.alive) return;
    for (var k = 0; k < p.trail.length; k++) { if (s.trail[p.trail[k]] === p.idx + 1) s.trail[p.trail[k]] = 0; }
    p.trail = []; p.out = false; p.wasOut = false; p.alive = false;
    p.deadAt = s.tick; p.respawnAt = now + RESPAWN_MS; p.plan = [];
  }

  /* Flaeche erobern: Schweif -> Land, dann alle vom Rand her NICHT erreichbaren
     Fremd-/Leerzellen einschliessen (Flood-Fill ueber Zellen != eigenes Land). */
  function captureFor(s, pi) {
    var p = s.players[pi], own = pi + 1, i, idx;
    for (i = 0; i < p.trail.length; i++) { idx = p.trail[i]; s.grid[idx] = own; s.trail[idx] = 0; }
    p.trail = [];
    s.maskId++;
    var mid = s.maskId, mask = s.mask, q = s.q, tail = 0, head = 0;
    var seed = function (c) { if (mask[c] !== mid && s.grid[c] !== own) { mask[c] = mid; q[tail++] = c; } };
    var x, y;
    for (x = 0; x < GW; x++) { seed(x); seed((GH - 1) * GW + x); }
    for (y = 0; y < GH; y++) { seed(y * GW); seed(y * GW + (GW - 1)); }
    while (head < tail) {
      var c = q[head++], cx = c % GW, cy = (c - cx) / GW;
      if (cx > 0) seed(c - 1);
      if (cx < GW - 1) seed(c + 1);
      if (cy > 0) seed(c - GW);
      if (cy < GH - 1) seed(c + GW);
    }
    for (i = 0; i < N; i++) {
      if (s.grid[i] !== own && mask[i] !== mid) { s.grid[i] = own; if (s.trail[i] === own) s.trail[i] = 0; }
    }
    s.dirtyTerr = true;
  }

  /* Einen Tick weiterrechnen (pendingDir ist fuer alle Spieler bereits gesetzt). */
  function stepSim(s, now) {
    if (s.over) return;
    var n = s.n, i, j, p;
    /* 1) Richtungen anwenden (keine Kehrtwende) */
    for (i = 0; i < n; i++) { p = s.players[i]; if (!p.alive) continue; if (p.pendingDir !== opp(p.dir)) p.dir = p.pendingDir; }
    /* 2) Zielfelder + Wand-Tod */
    var nx = [], ny = [], wall = [], nidx = [];
    for (i = 0; i < n; i++) {
      p = s.players[i];
      if (!p.alive) { nx.push(-1); ny.push(-1); wall.push(false); nidx.push(-1); continue; }
      var X = p.x + DX[p.dir], Y = p.y + DY[p.dir];
      nx.push(X); ny.push(Y);
      var ob = (X < 0 || Y < 0 || X >= GW || Y >= GH);
      wall.push(ob); nidx.push(ob ? -1 : Y * GW + X);
    }
    /* 3) Todesliste zusammenstellen */
    var dies = {};
    for (i = 0; i < n; i++) { if (s.players[i].alive && wall[i]) dies[i] = true; }
    /* 3b) Schweif-Schnitt: wer einen Schweif befaehrt, toetet dessen Besitzer */
    for (i = 0; i < n; i++) {
      p = s.players[i];
      if (!p.alive || wall[i]) continue;
      var to = s.trail[nidx[i]];
      if (to > 0) dies[to - 1] = true;
    }
    /* 3c) Kopf-an-Kopf: gleiches Zielfeld oder Platztausch */
    for (i = 0; i < n; i++) {
      if (!s.players[i].alive || wall[i]) continue;
      for (j = i + 1; j < n; j++) {
        if (!s.players[j].alive || wall[j]) continue;
        if (nidx[i] === nidx[j]) { dies[i] = true; dies[j] = true; }
        else if (nidx[i] === s.players[j].y * GW + s.players[j].x && nidx[j] === s.players[i].y * GW + s.players[i].x) { dies[i] = true; dies[j] = true; }
      }
    }
    /* 4) Tode anwenden (Schweife loeschen) */
    for (i = 0; i < n; i++) { if (dies[i]) killPlayer(s, i, now); }
    /* 5) Bewegung fuer Ueberlebende */
    for (i = 0; i < n; i++) {
      p = s.players[i];
      if (!p.alive || dies[i] || wall[i]) continue;
      var ni = nidx[i];
      p.px = p.x; p.py = p.y; p.x = nx[i]; p.y = ny[i];
      if (s.grid[ni] === p.idx + 1) {
        if (p.out && p.trail.length > 0) captureFor(s, i);
        p.out = false;
      } else {
        p.out = true;
        s.trail[ni] = p.idx + 1;
        p.trail.push(ni);
      }
    }
    s.tick++;
  }

  function respawnPlayer(s, i, now) {
    var p = s.players[i], own = i + 1;
    if (s.grid[p.hy * GW + p.hx] !== own) stampTerritory(s, i, clampX(p.hx), clampY(p.hy)), (s.dirtyTerr = true);
    p.x = p.hx; p.y = p.hy; p.px = p.hx; p.py = p.hy;
    p.alive = true; p.out = false; p.wasOut = false; p.trail = []; p.plan = [];
    p.restUntil = now + 400; p.deadAt = -1; p.respawnAt = 0;
    p.dir = p.hx < GW / 2 ? 0 : 2; p.pendingDir = p.dir;
  }

  /* ===================== Bot-KI (nur Solo) ===================== */
  function safeCell(s, p, d) {
    var X = p.x + DX[d], Y = p.y + DY[d];
    if (X < 0 || Y < 0 || X >= GW || Y >= GH) return false;
    if (s.trail[Y * GW + X] === p.idx + 1) return false;    // eigener Schweif = Selbstmord
    return true;
  }
  function makeSafe(s, i, d) {
    var p = s.players[i];
    if (d === opp(p.dir)) d = p.dir;
    if (safeCell(s, p, d)) return d;
    var alts = [p.dir, (p.dir + 1) % 4, (p.dir + 3) % 4], a;
    for (a = 0; a < alts.length; a++) { if (alts[a] !== opp(p.dir) && safeCell(s, p, alts[a])) return alts[a]; }
    return p.dir;
  }
  function safeStay(s, i) {
    var p = s.players[i], own = i + 1, alts = [p.dir, (p.dir + 1) % 4, (p.dir + 3) % 4], a;
    for (a = 0; a < alts.length; a++) {
      var d = alts[a]; if (d === opp(p.dir)) continue;
      var X = p.x + DX[d], Y = p.y + DY[d];
      if (X < 0 || Y < 0 || X >= GW || Y >= GH) continue;
      if (s.grid[Y * GW + X] === own) return d;
    }
    return makeSafe(s, i, p.dir);
  }
  function outwardDir(p) {
    var dx = p.hx - GW / 2, dy = p.hy - GH / 2;
    if (Math.abs(dx) >= Math.abs(dy)) return dx < 0 ? 2 : 0;
    return dy < 0 ? 3 : 1;
  }
  function perpDir(od, sgn) {
    if (od === 0 || od === 2) return sgn > 0 ? 1 : 3;
    return sgn > 0 ? 0 : 2;
  }
  function makePlan(s, p) {
    var od = outwardDir(p), sd = perpDir(od, Math.random() < 0.5 ? 1 : -1);
    var k = 2 + (Math.random() * 2 | 0), m = 1 + (Math.random() * 2 | 0), a, plan = [];
    for (a = 0; a < k; a++) plan.push(od);
    for (a = 0; a < m; a++) plan.push(sd);
    for (a = 0; a < k + 1; a++) plan.push(opp(od));
    for (a = 0; a < m; a++) plan.push(opp(sd));
    p.plan = plan; p.loopLen = k * 2 + m * 2 + 4;
  }
  function homeDir(s, p) {
    var dx = p.hx - p.x, dy = p.hy - p.y, cand = [], k;
    if (Math.abs(dx) >= Math.abs(dy)) { if (dx !== 0) cand.push(dx < 0 ? 2 : 0); if (dy !== 0) cand.push(dy < 0 ? 3 : 1); }
    else { if (dy !== 0) cand.push(dy < 0 ? 3 : 1); if (dx !== 0) cand.push(dx < 0 ? 2 : 0); }
    for (k = 0; k < cand.length; k++) { if (cand[k] !== opp(p.dir) && safeCell(s, p, cand[k])) return cand[k]; }
    return p.dir;
  }
  function botDir(s, i, now) {
    var p = s.players[i];
    if (!p.alive) return p.dir;
    if (p.wasOut && !p.out) { p.plan = []; p.restUntil = now + 500 + (Math.random() * 900 | 0); }
    p.wasOut = p.out;
    if (!p.plan) p.plan = [];
    if (p.out && p.trail.length > p.loopLen + 4) { p.plan = []; return makeSafe(s, i, homeDir(s, p)); }
    if (p.plan.length === 0) {
      if (!p.out) { if (now < (p.restUntil || 0)) return safeStay(s, i); makePlan(s, p); }
      else p.plan.push(homeDir(s, p));
    }
    if (p.plan.length === 0) return safeStay(s, i);
    return makeSafe(s, i, p.plan.shift());
  }

  function pctFmt(v) { return (Math.round(Number(v) || 0) / 10).toFixed(1) + '%'; }

  injectStyle();

  /* ===================== Registrierung ===================== */
  App.Minigames.paperio = {
    id: 'paperio', title: 'Gebiets-Eroberung', icon: '🟩', order: 146,
    subtitle: 'Zieh Schweife, schliess Flaechen, erobere das Feld',
    single: true, multi: true, minPlayers: 2, maxPlayers: 6,

    render: function (root, ctx) {
      var isMulti = ctx.mode === 'multi';
      var nowFn = isMulti ? function () { return ctx.room.now(); } : function () { return Date.now(); };

      /* --- Laufzeit --- */
      var dead = false, finished = false, raf = null;
      var timers = [], listeners = [], stops = [];
      var sim = null, roster = null, myIdx = 0, startAt = 0, endAt = 0;
      var myDir = 0, lastReportDir = -999, lastRepT = 0, lastScoreT = 0, lastBroadcast = 0;
      var prevMyPct = 0, prevMyAlive = true, flashT = 0;
      var sharedHandler = null, board = null;

      /* --- DOM --- */
      var canvas = null, g2 = null, terr = null, tctx = null, bgGrad = null;
      var chipsEl = null, chipRefs = [], timeEl = null, padBtns = [];

      /* --- Sicht (Quelle: sim beim Host, decodiert beim Gast) --- */
      var view = null;

      /* --- Aufraeumen --- */
      function after(ms, fn) { var t = setTimeout(function () { if (!dead) fn(); }, ms); timers.push(t); return t; }
      function clearTimers() { timers.forEach(clearTimeout); timers = []; }
      function addL(t, ty, fn, o) { t.addEventListener(ty, fn, o); listeners.push({ t: t, ty: ty, fn: fn, o: o }); }
      function removeAllListeners() { listeners.forEach(function (l) { try { l.t.removeEventListener(l.ty, l.fn, l.o); } catch (e) {} }); listeners = []; }
      function stopLoop() { if (raf) { cancelAnimationFrame(raf); raf = null; } }
      function softReset() { stopLoop(); clearTimers(); removeAllListeners(); stops.forEach(function (f) { try { f(); } catch (e) {} }); stops = []; board = null; }
      function cleanup() { dead = true; softReset(); }

      /* --- Start --- */
      if (isMulti) startMulti(); else startSolo();
      return { cleanup: cleanup };

      /* ============================================================
       *  SOLO
       * ============================================================ */
      function startSolo() {
        var nm = (ctx.me && ctx.me.name) ? ctx.me.name : 'Du';
        roster = [{ id: 'me', name: nm, bot: false }];
        for (var i = 0; i < 3; i++) roster.push({ id: 'bot' + i, name: BOT_NAMES[i], bot: true });
        myIdx = 0; myDir = SPAWNS[0].d;
        buildStage();
        sim = newSim(roster);
        startAt = nowFn(); endAt = startAt + MATCH_TIME * 1000;
        initView();
        prevMyPct = 0; prevMyAlive = true;
        startTimer();
        loop();
      }

      /* ============================================================
       *  MULTI — Host-autoritativ
       * ============================================================ */
      function startMulti() {
        var snap = ctx.room.snapshot() || {};
        var startAt0 = (snap.round && snap.round.startAt) || (ctx.room.now() + 3000);
        stops.push(App.MG.countdown(root, startAt0, function () { play(startAt0); }, ctx.room.now));
      }

      function roomPlayerById(id) { var ps = ctx.room.players(); for (var i = 0; i < ps.length; i++) if (ps[i].id === id) return ps[i]; return null; }
      function indexOfId(list, id) { for (var i = 0; i < list.length; i++) if (list[i].id === id) return i; return -1; }

      function play(startAt0) {
        var ps = ctx.room.players();
        roster = ps.slice(0, 6).map(function (p) { return { id: p.id, name: p.name, bot: false }; });
        if (roster.length < 1) roster = [{ id: ctx.me.id, name: ctx.me.name || 'Du', bot: false }];
        myIdx = indexOfId(roster, ctx.me.id); if (myIdx < 0) myIdx = 0;
        myDir = SPAWNS[myIdx].d;
        buildStage();
        startAt = startAt0; endAt = startAt + MATCH_TIME * 1000;
        sim = ctx.room.isHost() ? newSim(roster) : null;
        initView();
        prevMyPct = 0; prevMyAlive = true;

        sharedHandler = function (sh) { onShared(sh); };
        ctx.room.on('shared', sharedHandler);
        stops.push(function () { ctx.room.off('shared', sharedHandler); });
        var s0 = ctx.room.snapshot();
        if (s0 && s0.shared && s0.shared.g) onShared(s0.shared);

        /* Live-Rangliste */
        board = App.MG.liveBoard(ctx.room, ctx.me.id, { format: pctFmt });
        if (board) stops.push(board.stop);
        var bw = root.querySelector('.pio-board');
        if (bw && board) bw.appendChild(board.root);

        try { ctx.room.reportState({ d: myDir }); } catch (e) {}
        lastReportDir = myDir; lastRepT = nowFn();
        startTimer();
        loop();
      }

      function onShared(sh) {
        if (dead || finished || !sh) return;
        if (ctx.room.isHost() && sim) { if (sh.o) doFinish(); return; }  // Host rendert aus sim
        if (!sh.g) { if (sh.o) doFinish(); return; }
        var g = view.g, w = view.w, i;
        if (!g || g.length !== N) { g = new Uint8Array(N); view.g = g; }
        if (!w || w.length !== N) { w = new Uint8Array(N); view.w = w; }
        var gs = sh.g, ws = sh.w || '';
        for (i = 0; i < N; i++) { g[i] = gs.charCodeAt(i) - 48; w[i] = i < ws.length ? ws.charCodeAt(i) - 48 : 0; }
        if (sh.g !== view.prevG) { view.prevG = sh.g; view.terrDirty = true; }
        var hh = sh.h || [], hd = sh.d || [];
        for (i = 0; i < view.heads.length; i++) {
          var h = view.heads[i], pk = hh[i];
          if (typeof pk !== 'number' || pk < 0) { h.alive = false; }
          else { var wasA = h.alive; h.alive = true; var X = pk % GW, Y = (pk - X) / GW; if (!wasA) { h.rx = X; h.ry = Y; } h.x = X; h.y = Y; h.dir = hd[i] || 0; }
        }
        if (sh.o) doFinish();
      }

      /* ============================================================
       *  Sicht + Rendering-Datenquelle
       * ============================================================ */
      function initView() {
        var heads = [], i;
        for (i = 0; i < roster.length; i++) {
          var sp = SPAWNS[i];
          heads.push({ x: sp.x, y: sp.y, rx: sp.x, ry: sp.y, dir: sp.d, alive: true });
        }
        view = {
          heads: heads, terrDirty: true, prevG: '',
          g: sim ? sim.grid : new Uint8Array(N),
          w: sim ? sim.trail : new Uint8Array(N)
        };
      }

      function startTimer() {
        stops.push(App.MG.roundTimer(endAt, function (left) {
          if (timeEl) { timeEl.textContent = App.MG.mmss(left); if (left <= 10) timeEl.classList.add('pio-urgent'); }
        }, doFinish, isMulti ? ctx.room.now : null));
      }

      /* ============================================================
       *  Haupt-Schleife
       * ============================================================ */
      function loop() {
        raf = null;
        if (dead || finished) return;
        raf = requestAnimationFrame(loop);
        var now = nowFn();
        var amHost = !isMulti || ctx.room.isHost();

        if (sim && amHost) {
          stepWorld(now);
          syncViewFromSim(now);
          if (isMulti && now - lastBroadcast >= BROADCAST_MS) { lastBroadcast = now; broadcast(now); }
        } else {
          smoothHeads();
        }
        if (isMulti) doReports(now);
        if (view.terrDirty) { repaintTerr(); view.terrDirty = false; }
        draw(now);
        updateHud(now);
      }

      function applyHumanDirs() {
        for (var i = 0; i < sim.n; i++) {
          var p = sim.players[i];
          if (p.bot) continue;
          if (!isMulti) { if (i === myIdx) p.pendingDir = myDir; continue; }
          if (i === myIdx) { p.pendingDir = myDir; continue; }
          var rp = roomPlayerById(roster[i].id);
          var d = rp && rp.state ? rp.state.d : undefined;
          if (typeof d === 'number') p.pendingDir = d;
        }
      }

      function stepWorld(now) {
        var target = Math.floor((now - startAt) / TICK_MS);
        if (target - sim.tick > 6) { startAt += (target - sim.tick - 6) * TICK_MS; target = sim.tick + 6; }
        applyHumanDirs();
        var guard = 0;
        while (sim.tick < target && !sim.over && guard++ < 8) {
          for (var i = 0; i < sim.n; i++) { var p = sim.players[i]; if (p.bot && p.alive) p.pendingDir = botDir(sim, i, now); }
          stepSim(sim, now);
        }
        for (var j = 0; j < sim.n; j++) {
          var q = sim.players[j];
          if (!q.alive && q.respawnAt > 0 && now >= q.respawnAt && !sim.over) respawnPlayer(sim, j, now);
        }
        if (sim.dirtyTerr) { view.terrDirty = true; sim.dirtyTerr = false; }
      }

      function syncViewFromSim(now) {
        var frac = ((now - startAt) / TICK_MS) - sim.tick;
        if (frac < 0) frac = 0; if (frac > 1) frac = 1;
        for (var i = 0; i < sim.n; i++) {
          var p = sim.players[i], h = view.heads[i];
          h.alive = p.alive; h.dir = p.dir; h.x = p.x; h.y = p.y;
          if (p.alive) { h.rx = p.px + (p.x - p.px) * frac; h.ry = p.py + (p.y - p.py) * frac; }
        }
        view.g = sim.grid; view.w = sim.trail;
      }

      function smoothHeads() {
        for (var i = 0; i < view.heads.length; i++) {
          var h = view.heads[i];
          if (!h.alive) continue;
          h.rx += (h.x - h.rx) * 0.3; h.ry += (h.y - h.ry) * 0.3;
        }
      }

      function broadcast(now) {
        var gs = new Array(N), ws = new Array(N), i;
        for (i = 0; i < N; i++) { gs[i] = sim.grid[i]; ws[i] = sim.trail[i]; }
        var hh = [], hd = [];
        for (i = 0; i < sim.n; i++) { var p = sim.players[i]; hh.push(p.alive ? p.y * GW + p.x : -1); hd.push(p.dir); }
        try { ctx.room.setShared({ g: gs.join(''), w: ws.join(''), h: hh, d: hd, o: sim.over || false, t: now }); } catch (e) {}
      }

      function doReports(now) {
        if (myIdx < 0) return;
        if (myDir !== lastReportDir && now - lastRepT >= REPORT_MS) {
          lastReportDir = myDir; lastRepT = now;
          try { ctx.room.reportState({ d: myDir }); } catch (e) {}
        }
        if (now - lastScoreT >= SCORE_MS) {
          lastScoreT = now;
          try { ctx.room.reportScore(Math.round(countOwn(myIdx) / N * 1000)); } catch (e) {}
        }
      }

      function countOwn(i) { var g = view.g, c = 0, own = i + 1, k; for (k = 0; k < N; k++) if (g[k] === own) c++; return c; }

      /* ============================================================
       *  Rendering
       * ============================================================ */
      function repaintTerr() {
        var g = tctx; if (!g) return;
        g.fillStyle = bgGrad; g.fillRect(0, 0, W, H);
        g.save();
        g.strokeStyle = 'rgba(57,255,20,0.06)'; g.lineWidth = 1;
        g.beginPath();
        var i;
        for (i = 0; i <= GW; i += 2) { g.moveTo(i * CELL + 0.5, 0); g.lineTo(i * CELL + 0.5, H); }
        for (i = 0; i <= GH; i += 2) { g.moveTo(0, i * CELL + 0.5); g.lineTo(W, i * CELL + 0.5); }
        g.stroke(); g.restore();
        var gr = view.g;
        for (i = 0; i < N; i++) {
          var v = gr[i]; if (!v) continue;
          var cx = i % GW, cy = (i - cx) / GW;
          g.fillStyle = COLORS[v - 1].terr;
          g.fillRect(cx * CELL, cy * CELL, CELL, CELL);
        }
        g.save();
        g.strokeStyle = 'rgba(57,255,20,0.32)'; g.lineWidth = 3;
        g.strokeRect(1.5, 1.5, W - 3, H - 3);
        g.restore();
      }

      function draw(now) {
        var g = g2; if (!g) return;
        g.clearRect(0, 0, W, H);
        g.drawImage(terr, 0, 0);
        /* Schweife */
        var wr = view.w, i;
        for (i = 0; i < N; i++) {
          var v = wr[i]; if (!v) continue;
          var cx = i % GW, cy = (i - cx) / GW;
          g.fillStyle = COLORS[v - 1].trail;
          g.fillRect(cx * CELL + 2, cy * CELL + 2, CELL - 4, CELL - 4);
        }
        /* Koepfe */
        for (i = 0; i < view.heads.length; i++) drawHead(g, i, now);
        /* Todes-Blitz */
        if (now < flashT) {
          var a = (flashT - now) / 500;
          g.save(); g.fillStyle = 'rgba(255,77,109,' + (0.35 * a).toFixed(3) + ')';
          g.fillRect(0, 0, W, H); g.restore();
        }
      }

      function drawHead(g, i, now) {
        var h = view.heads[i]; if (!h.alive) return;
        var col = COLORS[i], px = h.rx * CELL + CELL / 2, py = h.ry * CELL + CELL / 2;
        g.save();
        g.shadowColor = col.glow; g.shadowBlur = 20;
        g.fillStyle = col.line; g.globalAlpha = 0.95;
        g.beginPath(); g.arc(px, py, CELL * 0.5, 0, Math.PI * 2); g.fill();
        g.globalAlpha = 1; g.fillStyle = '#eafff2';
        g.beginPath(); g.arc(px, py, CELL * 0.26, 0, Math.PI * 2); g.fill();
        g.restore();
        if (i === myIdx) {
          var rr = CELL * (0.78 + 0.12 * Math.sin(now / 130));
          g.save(); g.strokeStyle = '#ffffff'; g.globalAlpha = 0.6; g.lineWidth = 2;
          g.beginPath(); g.arc(px, py, rr, 0, Math.PI * 2); g.stroke(); g.restore();
        }
      }

      /* ============================================================
       *  HUD
       * ============================================================ */
      function updateHud(now) {
        var g = view.g, w = view.w, terrC = [], trailC = [], i;
        for (i = 0; i < roster.length; i++) { terrC.push(0); trailC.push(0); }
        for (i = 0; i < N; i++) { var tv = g[i]; if (tv > 0 && tv <= roster.length) terrC[tv - 1]++; var wv = w[i]; if (wv > 0 && wv <= roster.length) trailC[wv - 1]++; }
        var maxC = -1, leader = -1;
        for (i = 0; i < roster.length; i++) { if (terrC[i] > maxC) { maxC = terrC[i]; leader = i; } }
        for (i = 0; i < chipRefs.length; i++) {
          var r = chipRefs[i], pct = (terrC[i] / N * 100), alive = view.heads[i] ? view.heads[i].alive : true;
          var pctTxt = pct.toFixed(1) + '%';
          if (r.pctTxt !== pctTxt) { r.pctTxt = pctTxt; r.pct.textContent = pctTxt; }
          var st = !alive ? '💥 raus' : (trailC[i] > 0 ? '✏️ Schweif' : '🛡️ Gebiet');
          if (r.stTxt !== st) { r.stTxt = st; r.st.textContent = st; }
          var isLead = (i === leader && maxC > 0);
          if (r.lead !== isLead) { r.lead = isLead; r.chip.classList.toggle('pio-lead', isLead); }
          if (r.dead !== !alive) { r.dead = !alive; r.chip.classList.toggle('pio-out', !alive); }
        }
        /* eigene Ereignisse -> Ton/Feedback */
        var myPct = terrC[myIdx] / N * 100;
        var myAlive = view.heads[myIdx] ? view.heads[myIdx].alive : true;
        if (myPct > prevMyPct + 0.35) { if (App.Audio) App.Audio.sfx('point'); flashChip(myIdx); }
        if (prevMyAlive && !myAlive) { if (App.Audio) App.Audio.sfx('explosion'); flashT = now + 500; }
        prevMyPct = myPct; prevMyAlive = myAlive;
      }

      function flashChip(i) {
        var r = chipRefs[i]; if (!r) return;
        r.chip.classList.remove('pio-cap'); void r.chip.offsetWidth; r.chip.classList.add('pio-cap');
        after(420, function () { r.chip.classList.remove('pio-cap'); });
      }

      /* ============================================================
       *  Eingabe
       * ============================================================ */
      function setMyDir(d) {
        if (dead || finished || myIdx < 0) return;
        if (d === opp(myDir)) { if (App.Audio) App.Audio.sfx('error'); flashPad(d, true); return; }
        if (d === myDir) return;
        myDir = d;
        if (App.Audio) App.Audio.blip(520 + d * 80, 0.05, { type: 'square', peak: 0.05 });
        flashPad(d, false);
        if (sim && (!isMulti || ctx.room.isHost()) && sim.players[myIdx] && sim.players[myIdx].alive) sim.players[myIdx].pendingDir = d;
        if (isMulti) { lastReportDir = d; lastRepT = nowFn(); try { ctx.room.reportState({ d: d }); } catch (e) {} }
      }
      function flashPad(d, bad) {
        var b = padBtns[d]; if (!b) return;
        var cls = bad ? 'pio-pad-bad' : 'pio-pad-hit';
        b.classList.remove(cls); void b.offsetWidth; b.classList.add(cls);
        after(200, function () { b.classList.remove(cls); });
      }
      function attachInput() {
        var onKey = function (e) {
          var k = e.key, d = -1;
          if (k === 'ArrowRight' || k === 'd' || k === 'D') d = 0;
          else if (k === 'ArrowDown' || k === 's' || k === 'S') d = 1;
          else if (k === 'ArrowLeft' || k === 'a' || k === 'A') d = 2;
          else if (k === 'ArrowUp' || k === 'w' || k === 'W') d = 3;
          if (d < 0) return;
          e.preventDefault(); setMyDir(d);
        };
        addL(document, 'keydown', onKey);
        var sw = null;
        addL(canvas, 'pointerdown', function (e) { e.preventDefault(); sw = { x: e.clientX, y: e.clientY }; });
        addL(canvas, 'pointermove', function (e) {
          if (!sw) return;
          var dx = e.clientX - sw.x, dy = e.clientY - sw.y;
          if (Math.abs(dx) < 20 && Math.abs(dy) < 20) return;
          sw.x = e.clientX; sw.y = e.clientY;
          setMyDir(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 0 : 2) : (dy > 0 ? 1 : 3));
        });
        addL(canvas, 'pointerup', function () { sw = null; });
        addL(canvas, 'pointercancel', function () { sw = null; });
      }

      /* ============================================================
       *  Aufbau der Ansicht
       * ============================================================ */
      function buildStage() {
        removeAllListeners();
        timeEl = el('div', { class: 'mg-timer pio-time' }, [App.MG.mmss(MATCH_TIME)]);
        var head = el('div', { class: 'pio-head glass' }, [
          el('div', { class: 'pio-brand neon' }, ['🟩 Gebiets-Eroberung']),
          el('div', { class: 'pio-time-wrap' }, [el('span', { class: 'pio-time-l' }, ['Zeit']), timeEl])
        ]);

        chipsEl = el('div', { class: 'pio-chips' });
        chipRefs = [];
        roster.forEach(function (r, i) {
          var pct = el('span', { class: 'pio-pct' }, ['0.0%']);
          var st = el('span', { class: 'pio-st' }, ['🛡️ Gebiet']);
          var chip = el('div', { class: 'pio-chip pio-c' + (i + 1) + (i === myIdx ? ' pio-me' : '') }, [
            el('span', { class: 'pio-dot' }),
            el('div', { class: 'pio-chip-mid' }, [
              el('span', { class: 'pio-nm' }, [r.name + (i === myIdx ? ' (du)' : '')]), st
            ]),
            pct
          ]);
          chipRefs.push({ chip: chip, pct: pct, st: st, pctTxt: '', stTxt: '', lead: false, dead: false });
          chipsEl.appendChild(chip);
        });

        canvas = el('canvas', { class: 'pio-canvas', width: W, height: H });
        var stage = el('div', { class: 'pio-stage' }, [canvas]);

        padBtns = [];
        var mk = function (d) {
          var b = el('button', { class: 'pio-pad-b', type: 'button', 'aria-label': 'Richtung ' + ARROWS[d] }, [ARROWS[d]]);
          b.addEventListener('pointerdown', function (e) { e.preventDefault(); setMyDir(d); });
          padBtns[d] = b; return b;
        };
        var pad = el('div', { class: 'pio-pad' }, [
          el('div', { class: 'pio-pad-row' }, [mk(3)]),
          el('div', { class: 'pio-pad-row' }, [mk(2), mk(1), mk(0)])
        ]);

        var boardWrap = isMulti ? el('div', { class: 'pio-board-wrap glass' }, [
          el('div', { class: 'mg-field-title' }, ['🏆 Rangliste']),
          el('div', { class: 'pio-board' })
        ]) : null;

        var wrap = el('div', { class: 'pio-wrap' }, [
          head, chipsEl, stage, pad,
          el('p', { class: 'hint-text pio-hint' }, [HINT]),
          boardWrap
        ]);
        root.innerHTML = ''; root.appendChild(wrap);

        g2 = canvas.getContext('2d');
        terr = document.createElement('canvas'); terr.width = W; terr.height = H;
        tctx = terr.getContext('2d');
        bgGrad = tctx.createLinearGradient(0, 0, 0, H);
        bgGrad.addColorStop(0, '#06180e'); bgGrad.addColorStop(1, '#02090f');
        attachInput();
      }

      /* ============================================================
       *  Ende
       * ============================================================ */
      function doFinish() {
        if (finished || dead) return;
        finished = true;
        stopLoop(); clearTimers();
        stops.forEach(function (f) { try { f(); } catch (e) {} }); stops = []; board = null;

        if (isMulti) {
          if (ctx.room.isHost() && sim) { sim.over = true; try { ctx.room.setShared({ o: true }); } catch (e) {} }
          try { ctx.room.reportScore(Math.round(countOwn(myIdx) / N * 1000)); } catch (e) {}
          after(400, function () {
            var players = ctx.room.players();
            var top = players.slice().sort(function (a, b) { return (b.score || 0) - (a.score || 0); })[0];
            if (top && top.id === ctx.me.id && App.Scores && App.Scores.winCurrent) App.Scores.winCurrent();
            if (App.Audio) App.Audio.sfx(top && top.id === ctx.me.id ? 'jackpot' : 'ding');
            App.MG.endScreen(root, { players: players, meId: ctx.me.id, format: pctFmt, title: '🏁 Zeit um!', onExit: ctx.onExit });
          });
        } else {
          var terrC = [], i, k;
          for (i = 0; i < roster.length; i++) terrC.push(0);
          for (k = 0; k < N; k++) { var v = view.g[k]; if (v > 0 && v <= roster.length) terrC[v - 1]++; }
          var maxC = -1, leader = -1;
          for (i = 0; i < roster.length; i++) { if (terrC[i] > maxC) { maxC = terrC[i]; leader = i; } }
          var iLead = (leader === myIdx && maxC > 0);
          var sc = Math.round(terrC[myIdx] / N * 1000);
          var best = App.Storage.get('best_paperio', 0), nb = sc > best;
          if (nb) App.Storage.set('best_paperio', sc);
          if (iLead && App.Scores && App.Scores.winCurrent) App.Scores.winCurrent();
          if (App.Audio) App.Audio.sfx(iLead ? 'jackpot' : 'lose');
          App.MG.endScreen(root, {
            score: sc, best: best, newBest: nb, format: pctFmt,
            label: (iLead ? '🏆 Groesstes Gebiet! · ' : 'Platz hinter den Bots · ') + (nb ? 'neuer Rekord! 🎉' : 'Bestwert: ' + pctFmt(best)),
            onExit: ctx.onExit,
            onAgain: function () { if (dead) return; finished = false; softReset(); startSolo(); }
          });
        }
      }
    }
  };

  /* ===================== STYLES ===================== */
  function injectStyle() {
    UI.injectStyle('mg-paperio-css', [
      '.pio-wrap{display:flex;flex-direction:column;gap:12px;align-items:stretch;}',
      '.pio-head{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 16px;flex-wrap:wrap;}',
      '.pio-brand{font-weight:900;font-size:clamp(15px,4vw,20px);}',
      '.pio-time-wrap{display:flex;flex-direction:column;align-items:flex-end;line-height:1;}',
      '.pio-time-l{font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;}',
      '.pio-time{font-size:clamp(18px,5vw,26px);font-variant-numeric:tabular-nums;font-weight:900;}',
      '.pio-time.pio-urgent{color:var(--danger);animation:pio-blink .7s infinite;}',
      '@keyframes pio-blink{0%,100%{opacity:1}50%{opacity:.4}}',
      /* Spieler-Chips */
      '.pio-chips{display:flex;gap:8px;flex-wrap:wrap;}',
      '.pio-chip{flex:1 1 130px;min-width:0;display:flex;align-items:center;gap:8px;padding:7px 10px;border-radius:12px;',
      'background:rgba(9,32,21,.6);border:1px solid var(--stroke);transition:opacity .25s,border-color .25s,box-shadow .25s;}',
      '.pio-chip.pio-me{border-color:var(--stroke-2);box-shadow:0 0 14px rgba(57,255,20,.18);}',
      '.pio-chip.pio-lead{border-color:var(--gold);box-shadow:0 0 16px rgba(255,210,63,.4);}',
      '.pio-chip.pio-out{opacity:.45;}',
      '.pio-chip.pio-cap{animation:pio-cap .42s ease;}',
      '@keyframes pio-cap{0%{transform:scale(1)}45%{transform:scale(1.07);box-shadow:0 0 20px rgba(255,210,63,.6);}100%{transform:scale(1)}}',
      '.pio-dot{width:11px;height:11px;border-radius:50%;flex:0 0 auto;}',
      '.pio-chip-mid{flex:1;min-width:0;display:flex;flex-direction:column;line-height:1.2;}',
      '.pio-nm{font-weight:800;font-size:12.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      '.pio-st{font-size:10px;color:var(--muted);letter-spacing:.3px;min-height:12px;}',
      '.pio-pct{font-size:16px;font-weight:900;flex:0 0 auto;font-variant-numeric:tabular-nums;color:var(--leaf);}',
      '.pio-c1 .pio-dot{background:var(--neon);box-shadow:0 0 9px var(--neon);}.pio-c1 .pio-nm{color:var(--neon);}',
      '.pio-c2 .pio-dot{background:var(--aqua);box-shadow:0 0 9px var(--aqua);}.pio-c2 .pio-nm{color:var(--aqua);}',
      '.pio-c3 .pio-dot{background:var(--gold);box-shadow:0 0 9px var(--gold);}.pio-c3 .pio-nm{color:var(--gold);}',
      '.pio-c4 .pio-dot{background:var(--danger);box-shadow:0 0 9px var(--danger);}.pio-c4 .pio-nm{color:var(--danger);}',
      '.pio-c5 .pio-dot{background:#c86bff;box-shadow:0 0 9px #c86bff;}.pio-c5 .pio-nm{color:#c86bff;}',
      '.pio-c6 .pio-dot{background:#ff9e3f;box-shadow:0 0 9px #ff9e3f;}.pio-c6 .pio-nm{color:#ff9e3f;}',
      /* Arena */
      '.pio-stage{position:relative;width:100%;max-width:560px;margin:0 auto;aspect-ratio:800 / 500;}',
      '.pio-canvas{display:block;width:100%;height:100%;border-radius:14px;background:#04140c;',
      'border:2px solid rgba(57,255,20,.32);box-shadow:0 0 42px rgba(57,255,20,.2),inset 0 0 60px rgba(57,255,20,.06);',
      'touch-action:none;user-select:none;-webkit-user-select:none;-webkit-tap-highlight-color:transparent;}',
      /* Steuerkreuz */
      '.pio-pad{display:flex;flex-direction:column;align-items:center;gap:6px;}',
      '.pio-pad-row{display:flex;gap:6px;}',
      '.pio-pad-b{width:56px;height:44px;border-radius:12px;background:rgba(6,24,16,.8);border:1px solid var(--stroke);',
      'color:var(--leaf);font-size:17px;line-height:1;cursor:pointer;font-family:inherit;padding:0;',
      'display:flex;align-items:center;justify-content:center;touch-action:none;-webkit-tap-highlight-color:transparent;',
      'user-select:none;-webkit-user-select:none;transition:transform .08s,border-color .15s,box-shadow .15s,background .15s;}',
      '.pio-pad-b:hover{border-color:var(--stroke-2);}',
      '.pio-pad-b.pio-pad-hit{background:rgba(57,255,20,.22);border-color:var(--neon);color:#eafff2;box-shadow:0 0 16px rgba(57,255,20,.55);transform:scale(.93);}',
      '.pio-pad-b.pio-pad-bad{background:rgba(255,77,109,.24);border-color:var(--danger);color:#fff;animation:pio-shake .22s ease;}',
      '@keyframes pio-shake{0%,100%{transform:translateX(0)}30%{transform:translateX(-5px)}70%{transform:translateX(5px)}}',
      '.pio-hint{text-align:center;margin:0;font-size:11.5px;line-height:1.5;}',
      /* Rangliste */
      '.pio-board-wrap{padding:12px 14px;display:flex;flex-direction:column;gap:8px;}',
      '.pio-board-wrap .mg-scoreboard{max-height:260px;overflow-y:auto;}'
    ].join(''));
  }
})();
