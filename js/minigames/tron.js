/* tron.js — "Lightcycle-Duell": Tron-Lightcycles auf einem 60x40-Neon-Gitter.
 *
 * SPIELIDEE : Jeder faehrt mit fester Geschwindigkeit (ein Feld pro Tick) in eine
 *   der 4 Richtungen und zieht eine leuchtende Mauer hinter sich her. Kehrtwende
 *   ist verboten. Wer in eine Mauer, in einen Gegner oder in den Rand faehrt,
 *   explodiert und ist raus. Letzter Ueberlebender gewinnt die Runde — Best-of-5
 *   (erster mit 3 Rundensiegen bzw. alleiniger Fuehrender nach 5 Runden).
 *   Damit keine Runde ewig dauert, schrumpft die Arena ab ~36 s ringweise
 *   (rote Todeszone, der naechste Ring wird vorher gestrichelt angekuendigt).
 *
 * STEUERUNG : Pfeiltasten oder WASD · am Handy wischen auf der Arena oder die
 *   4 Pfeil-Buttons darunter. Eine Kehrtwende wird abgelehnt (Fehlton).
 *
 * PUNKTE    : Pro Runde Platzierungs-Punkte (120/60/30/10) + 3 Punkte je
 *   ueberlebter Sekunde. Score im Multiplayer = Siege*100000 + Punkte, damit die
 *   Rangliste zuerst nach Rundensiegen und dann nach Punkten sortiert.
 *   Solo-Rekord (Serien-Punkte) liegt in App.Storage unter 'best_tron'.
 *
 * SOLO      : gegen 3 Bots in 3 Stufen. Leicht/Normal = Flood-Fill (waehlt die
 *   Richtung mit dem meisten erreichbaren freien Raum), Schwer = Voronoi-KI
 *   (maximiert das Gebiet, das der Bot vor allen anderen erreicht) und meidet
 *   Kopf-an-Kopf-Felder. Jeder Bot wuerfelt pro Runde eine kleine "Persoenlichkeit"
 *   (newPers) — sonst faehrt die Voronoi-KI mangels Zufall jede Runde dieselbe Linie.
 *   Die Bots melden ihre Zuege in dasselbe Eingabe-Log wie ein Mensch — es laeuft
 *   also exakt dieselbe Simulation wie im Multiplayer.
 *
 * SYNC-MODELL (Multiplayer, Lockstep):
 *   Tick 0 liegt auf shared.startAt (Server-Zeit via room.now()), jeder Tick
 *   dauert TICK_MS. Es werden KEINE Positionen uebertragen — jeder meldet per
 *   room.reportState({r, log}) nur sein eigenes Richtungswechsel-Log, kodiert als
 *   ein Integer pro Eintrag (tick*4 + richtung). Eigene Eingaben zaehlen erst
 *   2 Ticks spaeter (Input-Delay), damit sie rechtzeitig bei allen sind.
 *   Alle simulieren dasselbe deterministische Gitter (nur Integer-Mathematik,
 *   kein Zufall) -> identischer Spielverlauf. Trifft ein Log-Eintrag doch zu
 *   spaet ein, wird die Runde aus dem Log neu durchgerechnet (Rollback, billig:
 *   max. ~800 Ticks x 4 Bikes). Der Host haelt in room.setShared nur die
 *   Rahmendaten: {round, startAt, order, wins, over, champ}.
 *
 * Alle Timer laufen ueber Wall-Clock (Date.now bzw. room.now), rAF nur zum
 * Zeichnen (Kopf-Interpolation zwischen zwei Ticks -> fluessige Bewegung).
 * cleanup() beendet rAF, alle Timer, alle Listener und jedes room.on(). */
(function () {
  'use strict';
  window.App = window.App || {}; App.Minigames = App.Minigames || {};
  var UI = App.UI, el = UI.el;

  /* ===================== Konstanten ===================== */
  var GW = 60, GH = 40, CELL = 16;          // Gitter + Zellgroesse
  var W = GW * CELL, H = GH * CELL;         // virtuelle Canvas-Groesse (960x640)
  var TICK_MS = 90;                         // ein Feld pro 90 ms
  var DELAY_MULTI = 2, DELAY_SOLO = 1;      // Input-Delay in Ticks
  var SHRINK_START = 400;                   // ab Tick 400 (~36 s) schrumpft die Arena
  var SHRINK_EVERY = 20;                    // alle 20 Ticks (~1,8 s) ein Ring
  var SHRINK_WARN = 55;                     // Ticks Vorwarnung fuer den ersten Ring
  var MAX_RING = 20;                        // danach ist die Arena weg -> Ende garantiert
  var WINS_NEEDED = 3, MAX_ROUNDS = 5;      // Best-of-5
  var PLACE_PTS = [120, 60, 30, 10];        // Punkte nach Platzierung
  var DX = [1, 0, -1, 0], DY = [0, 1, 0, -1];   // 0=Ost 1=Sued 2=West 3=Nord
  var ARROWS = ['▶', '▼', '◀', '▲'];
  var SPAWNS = [
    { x: 10, y: 20, d: 0 }, { x: 49, y: 19, d: 2 },
    { x: 30, y: 6, d: 1 }, { x: 29, y: 33, d: 3 }
  ];
  var COLORS = [
    { line: '#39ff14', glow: 'rgba(57,255,20,0.85)', soft: 'rgba(57,255,20,0.30)' },
    { line: '#33e6d0', glow: 'rgba(51,230,208,0.85)', soft: 'rgba(51,230,208,0.30)' },
    { line: '#ffd23f', glow: 'rgba(255,210,63,0.85)', soft: 'rgba(255,210,63,0.30)' },
    { line: '#ff4d6d', glow: 'rgba(255,77,109,0.85)', soft: 'rgba(255,77,109,0.30)' }
  ];
  var BOT_NAMES = ['Kobra', 'Tukan', 'Jaguar'];
  var LEVELS = [
    { icon: '🌱', name: 'Leicht', desc: 'Bots fahren zaghaft und verfahren sich' },
    { icon: '⚔️', name: 'Normal', desc: 'Bots suchen immer den meisten freien Raum' },
    { icon: '🔥', name: 'Schwer', desc: 'Bots rechnen Gebiete aus und schneiden dich ab' }
  ];
  var HINT = 'Pfeiltasten oder WASD · am Handy wischen oder Pfeil-Buttons · keine Kehrtwende · nicht in Mauern oder in die rote Zone fahren';

  /* ===================== reine Gitter-Logik (deterministisch) ===================== */
  function ringAt(t) {
    if (t < SHRINK_START) return 0;
    var r = Math.floor((t - SHRINK_START) / SHRINK_EVERY) + 1;
    return r > MAX_RING ? MAX_RING : r;
  }
  function inRing(x, y, ring) { return x >= ring && y >= ring && x < GW - ring && y < GH - ring; }

  function newSim(n) {
    var s = { n: n, tick: 0, grid: new Uint8Array(GW * GH), bikes: [], alive: n, over: false, ring: 0, deaths: [], winner: -1 };
    for (var i = 0; i < n; i++) {
      var sp = SPAWNS[i];
      s.bikes.push({
        x: sp.x, y: sp.y, px: sp.x, py: sp.y, dir: sp.d, lastDir: sp.d,
        alive: true, deadAt: -1, place: 0, cur: 0, crashX: sp.x, crashY: sp.y,
        trail: [{ x: sp.x, y: sp.y }]
      });
      s.grid[sp.y * GW + sp.x] = i + 1;
    }
    return s;
  }

  /* Einen Tick weiterrechnen. logs[i] = aufsteigend sortierte [{t,d}] je Bike. */
  function stepSim(s, logs) {
    if (s.over) return;
    var t = s.tick + 1, i, j, b;

    /* 1) Richtungswechsel anwenden, die genau fuer diesen Tick gemeldet wurden */
    for (i = 0; i < s.n; i++) {
      b = s.bikes[i];
      var lg = logs[i] || [];
      while (b.cur < lg.length && lg[b.cur].t <= t) {
        var e = lg[b.cur];
        if (e.t === t && b.alive && e.d !== (b.dir + 2) % 4) b.dir = e.d;
        b.cur++;
      }
    }

    /* 2) Todeszone fuer diesen Tick */
    s.ring = ringAt(t);

    /* 3) Zielfelder + Kollisionen gegen Mauern/Rand */
    var nxs = [], nys = [], dead = [];
    for (i = 0; i < s.n; i++) {
      b = s.bikes[i];
      if (!b.alive) { nxs.push(-1); nys.push(-1); dead.push(false); continue; }
      var nx = b.x + DX[b.dir], ny = b.y + DY[b.dir];
      nxs.push(nx); nys.push(ny);
      dead.push(!inRing(nx, ny, s.ring) || !!s.grid[ny * GW + nx]);
    }
    /* 4) Kopf-an-Kopf: gleiches Zielfeld -> alle Beteiligten raus */
    for (i = 0; i < s.n; i++) {
      if (!s.bikes[i].alive || dead[i]) continue;
      for (j = i + 1; j < s.n; j++) {
        if (!s.bikes[j].alive || dead[j]) continue;
        if (nxs[i] === nxs[j] && nys[i] === nys[j]) { dead[i] = true; dead[j] = true; }
      }
    }

    /* 5) Anwenden: fahren oder sterben */
    for (i = 0; i < s.n; i++) {
      b = s.bikes[i];
      if (!b.alive) continue;
      if (dead[i]) {
        b.alive = false; b.deadAt = t; b.crashX = nxs[i]; b.crashY = nys[i];
        s.alive--; s.deaths.push(i);
      } else {
        b.px = b.x; b.py = b.y; b.x = nxs[i]; b.y = nys[i];
        s.grid[b.y * GW + b.x] = i + 1;
        var tr = b.trail;
        if (b.dir === b.lastDir && tr.length >= 2) { tr[tr.length - 1].x = b.x; tr[tr.length - 1].y = b.y; }
        else { tr.push({ x: b.x, y: b.y }); b.lastDir = b.dir; }
      }
    }

    s.tick = t;
    if (s.alive <= 1) {
      s.over = true;
      s.winner = -1;
      for (i = 0; i < s.n; i++) if (s.bikes[i].alive) { s.winner = i; break; }
      computePlaces(s);
    }
  }

  /* Platzierungen: Ueberlebender = 1., dann rueckwaerts durch die Todesreihenfolge.
     Gleichzeitig Ausgeschiedene teilen sich einen Platz. */
  function computePlaces(s) {
    var i, alive = [];
    for (i = 0; i < s.n; i++) if (s.bikes[i].alive) alive.push(i);
    for (i = 0; i < alive.length; i++) s.bikes[alive[i]].place = 1;
    var rank = alive.length ? alive.length + 1 : 1;
    var dd = s.deaths.slice().reverse(), k = 0;
    while (k < dd.length) {
      var group = [dd[k]], dt = s.bikes[dd[k]].deadAt;
      while (k + 1 < dd.length && s.bikes[dd[k + 1]].deadAt === dt) { k++; group.push(dd[k]); }
      for (i = 0; i < group.length; i++) s.bikes[group[i]].place = rank;
      rank += group.length; k++;
    }
  }

  /* ===================== Bot-KI (nur Solo) ===================== */
  var _mark = new Int32Array(GW * GH), _own = new Int8Array(GW * GH);
  var _q = new Int32Array(GW * GH), _markId = 0;

  /* Erreichbare freie Felder ab (sx,sy), gedeckelt auf cap. */
  function freeSpace(grid, ring, sx, sy, cap) {
    _markId++;
    var head = 0, tail = 0, count = 0, si = sy * GW + sx;
    _mark[si] = _markId; _q[tail++] = si;
    while (head < tail && count < cap) {
      var c = _q[head++]; count++;
      var cx = c % GW, cy = (c - cx) / GW;
      for (var d = 0; d < 4; d++) {
        var nx = cx + DX[d], ny = cy + DY[d];
        if (!inRing(nx, ny, ring)) continue;
        var ni = ny * GW + nx;
        if (_mark[ni] === _markId || grid[ni]) continue;
        _mark[ni] = _markId; _q[tail++] = ni;
      }
    }
    return count;
  }

  /* Voronoi: wie viele freie Felder erreicht myIdx vor allen anderen Koepfen? */
  function voronoi(grid, ring, myIdx, heads) {
    _markId++;
    var head = 0, tail = 0, i, mine = 0;
    for (i = 0; i < heads.length; i++) {
      var h = heads[i], ci = h.y * GW + h.x;
      if (_mark[ci] === _markId) continue;
      _mark[ci] = _markId; _own[ci] = h.idx; _q[tail++] = ci;
    }
    while (head < tail) {
      var c = _q[head++], o = _own[c];
      if (o === myIdx) mine++;
      var cx = c % GW, cy = (c - cx) / GW;
      for (var d = 0; d < 4; d++) {
        var nx = cx + DX[d], ny = cy + DY[d];
        if (!inRing(nx, ny, ring)) continue;
        var ni = ny * GW + nx;
        if (_mark[ni] === _markId || grid[ni]) continue;
        _mark[ni] = _markId; _own[ni] = o; _q[tail++] = ni;
      }
    }
    return mine;
  }

  /* Waehlt die Richtung fuer den naechsten Tick (oder -1, wenn alles toedlich ist).
     pers = optionale Runden-"Persoenlichkeit" des Bots (siehe newPers): sie verschiebt
     nur, wie gern er geradeaus faehrt bzw. wie stark er freien Raum gewichtet. Ohne sie
     ist die Voronoi-KI voellig deterministisch und faehrt in jeder Runde exakt dieselbe
     Linie — messbar: ein reiner Zufalls-Tiebreak aendert 0 % der Entscheidungen, weil
     die Score-Abstaende immer gross sind. */
  function botDecide(s, i, lvl, pers) {
    var b = s.bikes[i];
    if (!b.alive) return -1;
    var ring = ringAt(s.tick + 1);
    var cands = [b.dir, (b.dir + 1) % 4, (b.dir + 3) % 4];
    var best = -1, bestScore = -Infinity, safe = [], k, j;
    for (k = 0; k < cands.length; k++) {
      var d = cands[k], nx = b.x + DX[d], ny = b.y + DY[d];
      if (!inRing(nx, ny, ring)) continue;
      if (s.grid[ny * GW + nx]) continue;
      safe.push(d);
      /* Kopf-an-Kopf-Risiko: kann ein anderer Kopf dasselbe Feld betreten? */
      var risk = 0;
      for (j = 0; j < s.n; j++) {
        if (j === i || !s.bikes[j].alive) continue;
        var ob = s.bikes[j];
        if (Math.abs(ob.x - nx) + Math.abs(ob.y - ny) <= 1) risk++;
      }
      var sc;
      if (lvl >= 2) {
        var heads = [{ x: nx, y: ny, idx: i }];
        for (j = 0; j < s.n; j++) if (j !== i && s.bikes[j].alive) heads.push({ x: s.bikes[j].x, y: s.bikes[j].y, idx: j });
        sc = voronoi(s.grid, ring, i, heads) * 4
          + freeSpace(s.grid, ring, nx, ny, 600) * 0.5 * (pers ? pers.space : 1);
        sc -= risk * 900;                                  // Kopf-an-Kopf bleibt immer tabu
        if (d === b.dir) sc += (pers ? pers.straight : 6);
      } else {
        sc = freeSpace(s.grid, ring, nx, ny, lvl === 0 ? 60 : 400);
        sc -= risk * 200;
        if (d === b.dir) sc += 3;
      }
      if (sc > bestScore) { bestScore = sc; best = d; }
    }
    if (best < 0) return -1;
    var noise = lvl === 0 ? 0.30 : lvl === 1 ? 0.08 : 0;
    if (noise > 0 && safe.length > 1 && Math.random() < noise) best = safe[Math.floor(Math.random() * safe.length)];
    return best;
  }

  /* Pro Runde je Bot neu gewuerfelt: leichte Vorliebe fuers Geradeausfahren und fuer
     freien Raum. Die Sicherheits-Terme bleiben unangetastet -> die Bots bleiben stark,
     fahren aber jede Runde eine andere Linie. Nur im Solo aktiv, die Multiplayer-
     Simulation (stepSim) enthaelt weiterhin keinerlei Zufall. */
  function newPers() { return { straight: 2 + Math.random() * 12, space: 0.6 + Math.random() * 0.8 }; }

  /* ===================== Anzeige-Helfer ===================== */
  function fmtScore(v) {
    v = Math.round(Number(v) || 0);
    var w = Math.floor(v / 100000), p = v % 100000;
    return w + (w === 1 ? ' Sieg' : ' Siege') + ' · ' + p + ' P';
  }
  function encodeLog(lg) { return lg.map(function (e) { return e.t * 4 + e.d; }); }
  function decodeLog(arr) {
    var o = [];
    for (var k = 0; k < arr.length; k++) { var v = arr[k] | 0; if (v < 0) continue; o.push({ t: Math.floor(v / 4), d: v % 4 }); }
    return o;
  }

  injectStyle();

  /* ===================== Registrierung ===================== */
  App.Minigames.tron = {
    id: 'tron', title: 'Lightcycle-Duell', icon: '🏍️', order: 110,
    subtitle: 'Zieh Neon-Mauern – wer zuletzt fährt, gewinnt',
    single: true, multi: true, minPlayers: 2, maxPlayers: 4,

    render: function (root, ctx) {
      var isMulti = ctx.mode === 'multi';
      var nowFn = isMulti ? function () { return ctx.room.now(); } : function () { return Date.now(); };

      /* --- Laufzeit --- */
      var deadFlag = false, raf = null;
      var stops = [], timers = [], listeners = [];
      var level = 1, roster = null, myIdx = -1, onlineSet = null;
      var sim = null, logs = [], logLen = [], startAt = 0, dirty = false, frozen = false, botPers = [];
      var roundNo = 0, localWins = [], myPoints = 0;
      var roundOverAt = -1, roundApplied = false, seriesDone = false;
      var particles = [], fxDone = [];
      var repT = null, lastRep = 0, waitShown = false, ovKey = '';

      /* --- DOM-Referenzen --- */
      var canvas = null, g2 = null, bgGrad = null, overlay = null;
      var roundEl = null, zoneEl = null, timeEl = null, chipsEl = null;
      var chipRefs = [], padBtns = [];

      /* --- Aufraeumen --- */
      function after(ms, fn) { var t = setTimeout(function () { if (!deadFlag) fn(); }, ms); timers.push(t); return t; }
      function clearTimers() { timers.forEach(clearTimeout); timers = []; }
      function addL(t, ty, fn, o) { t.addEventListener(ty, fn, o); listeners.push({ t: t, ty: ty, fn: fn, o: o }); }
      function removeAllListeners() { listeners.forEach(function (l) { try { l.t.removeEventListener(l.ty, l.fn, l.o); } catch (e) {} }); listeners = []; }
      function clearReport() { if (repT) { clearTimeout(repT); repT = null; } }
      function stopLoop() { if (raf) { cancelAnimationFrame(raf); raf = null; } }
      function cleanup() {
        deadFlag = true;
        stopLoop(); clearTimers(); clearReport(); removeAllListeners();
        stops.forEach(function (f) { try { f(); } catch (e) {} }); stops = [];
      }

      /* --- Start --- */
      if (isMulti) startMulti(); else showLevelPick();
      return { cleanup: cleanup };

      /* ============================================================
       *  SOLO — Stufenwahl
       * ============================================================ */
      function showLevelPick() {
        stopLoop(); clearTimers(); removeAllListeners();
        sim = null; roster = null;
        var saved = App.Storage.get('tron_lvl', 1);
        if (typeof saved !== 'number' || saved < 0 || saved > 2) saved = 1;
        var best = App.Storage.get('best_tron', 0);
        root.innerHTML = '';
        root.appendChild(el('div', { class: 'trn-panel glass' }, [
          el('div', { class: 'trn-panel-icon' }, ['🏍️']),
          el('h2', { class: 'neon' }, ['Lightcycle-Duell']),
          el('p', { class: 'hint-text' }, ['Du gegen 3 Bots. Zieh Neon-Mauern, überlebe am längsten – Best-of-5.']),
          el('div', { class: 'trn-lvls' }, LEVELS.map(function (lv, i) {
            return el('button', {
              class: 'btn ' + (i === saved ? 'btn-primary' : 'btn-aqua') + ' trn-lvl', type: 'button',
              onclick: function () { if (App.Audio) App.Audio.sfx('select'); App.Storage.set('tron_lvl', i); startSolo(i); }
            }, [
              el('span', { class: 'trn-lvl-icon' }, [lv.icon]),
              el('span', { class: 'trn-lvl-nm' }, [lv.name]),
              el('span', { class: 'trn-lvl-d' }, [lv.desc])
            ]);
          })),
          el('p', { class: 'trn-rules hint-text' }, [HINT]),
          best > 0 ? el('p', { class: 'trn-best' }, ['🏆 Rekord: ' + App.MG.fmt(best) + ' Punkte']) : null,
          el('div', { class: 'controls-row' }, [
            el('button', { class: 'btn btn-ghost', type: 'button', onclick: ctx.onExit }, ['Zurück'])
          ])
        ]));
      }

      function startSolo(lvl) {
        level = lvl;
        roster = [{ id: 'me', name: (ctx.me && ctx.me.name) ? ctx.me.name : 'Du', bot: false }];
        for (var i = 0; i < 3; i++) roster.push({ id: 'bot' + i, name: BOT_NAMES[i], bot: true });
        myIdx = 0;
        localWins = [0, 0, 0, 0];
        myPoints = 0; seriesDone = false;
        buildStage();
        beginRound(1, nowFn() + 3200);
        loop();
      }

      /* ============================================================
       *  MULTI — Lobby-Start, Host haelt round/startAt/wins in shared
       * ============================================================ */
      function sharedNow() { var s = ctx.room.snapshot(); return (s && s.shared) || null; }
      function playerById(id) {
        var ps = ctx.room.players();
        for (var i = 0; i < ps.length; i++) if (ps[i].id === id) return ps[i];
        return null;
      }
      function idIndex(id) { for (var i = 0; i < roster.length; i++) if (roster[i].id === id) return i; return -1; }

      function startMulti() {
        var proceeded = false;
        function maybeStart() {
          if (proceeded || deadFlag) return;
          var ps = ctx.room.players();
          if (ps.length < 2) { showWaiting(ps.length); return; }
          proceeded = true;
          if (ctx.room.isHost()) initShared(ps);
          var snap = ctx.room.snapshot() || {};
          var startAt0 = (snap.round && snap.round.startAt) || (ctx.room.now() + 3000);
          stops.push(App.MG.countdown(root, startAt0, function () { play(startAt0); }, ctx.room.now));
        }
        var ph = function () { maybeStart(); };
        ctx.room.on('players', ph);
        stops.push(function () { ctx.room.off('players', ph); });
        maybeStart();
      }

      function initShared(ps) {
        var sh = sharedNow();
        if (sh && sh.round) return;                     // schon initialisiert -> idempotent
        var snap = ctx.room.snapshot() || {};
        var startAt0 = (snap.round && snap.round.startAt) || (ctx.room.now() + 3000);
        var ids = ps.slice(0, 4).map(function (p) { return p.id; });
        var wins = {};
        ids.forEach(function (id) { wins[id] = 0; });
        try { ctx.room.setShared({ round: 1, startAt: startAt0, order: ids, wins: wins, over: false, champ: null }); } catch (e) {}
      }

      function showWaiting(count) {
        if (!waitShown) {
          waitShown = true;
          root.innerHTML = '';
          root.appendChild(el('div', { class: 'trn-panel glass' }, [
            el('div', { class: 'trn-panel-icon trn-bob' }, ['🏍️']),
            el('h2', { class: 'neon' }, ['Lightcycle-Duell']),
            el('div', { class: 'big-readout trn-wait-n' }, [count + ' / 2']),
            el('p', { class: 'hint-text' }, ['Warte auf Mitspieler – ab 2 Fahrern geht es los.']),
            el('div', { class: 'controls-row' }, [
              el('button', { class: 'btn btn-ghost', type: 'button', onclick: ctx.onExit }, ['Zurück zur Lobby'])
            ])
          ]));
        }
        var n = root.querySelector('.trn-wait-n');
        if (n) n.textContent = count + ' / 2';
      }

      function play(startAt0) {
        var sh = sharedNow(), ids;
        if (sh && sh.order && sh.order.length >= 2) ids = sh.order.slice(0, 4);
        else ids = ctx.room.players().slice(0, 4).map(function (p) { return p.id; });
        roster = ids.map(function (id) {
          var p = playerById(id);
          return { id: id, name: p ? p.name : 'Spieler', bot: false };
        });
        myIdx = idIndex(ctx.me.id);
        onlineSet = {};
        ctx.room.players().forEach(function (p) { onlineSet[p.id] = true; });
        localWins = []; for (var i = 0; i < roster.length; i++) localWins.push(0);
        myPoints = 0; seriesDone = false;

        buildStage();

        var shH = function () { onShared(); };
        ctx.room.on('shared', shH);
        stops.push(function () { ctx.room.off('shared', shH); });
        var plH = function () { onPlayersUpdate(); };
        ctx.room.on('players', plH);
        stops.push(function () { ctx.room.off('players', plH); });

        beginRound(1, startAt0);
        loop();
      }

      /* room-Events feuern sehr oft (Heartbeat) -> nur bei echter Aenderung handeln */
      function onShared() {
        if (deadFlag || !roster || seriesDone) return;
        var sh = sharedNow();
        if (!sh) return;
        if (sh.wins) {
          for (var i = 0; i < roster.length; i++) {
            var w = sh.wins[roster[i].id];
            if (typeof w === 'number') localWins[i] = w;
          }
        }
        if (sh.over) { finishSeries(); return; }
        if (sh.round && sh.round !== roundNo) beginRound(sh.round, sh.startAt || (nowFn() + 3000));
      }

      function onPlayersUpdate() {
        if (deadFlag || !roster) return;
        var ps = ctx.room.players(), i, j;
        onlineSet = {};
        for (i = 0; i < ps.length; i++) onlineSet[ps[i].id] = true;
        if (!sim || frozen) return;
        for (i = 0; i < ps.length; i++) {
          var p = ps[i], idx = idIndex(p.id);
          if (idx < 0 || idx === myIdx) continue;
          var st = p.state;
          if (!st || st.r !== roundNo) continue;
          var enc = st.log || [];
          if (enc.length === logLen[idx]) continue;
          var nl = decodeLog(enc), earliest = Infinity;
          for (j = Math.min(logLen[idx], nl.length); j < nl.length; j++) if (nl[j].t < earliest) earliest = nl[j].t;
          if (nl.length < logLen[idx]) earliest = 0;
          logs[idx] = nl; logLen[idx] = enc.length;
          if (earliest <= sim.tick) dirty = true;        // zu spaet -> Runde neu durchrechnen
        }
      }

      function doReport() {
        if (deadFlag || !isMulti || myIdx < 0) return;
        lastRep = Date.now();
        try { ctx.room.reportState({ r: roundNo, log: encodeLog(logs[myIdx]) }); } catch (e) {}
      }
      function scheduleReport() {
        if (repT) return;
        var wait = 70 - (Date.now() - lastRep);
        if (wait < 0) wait = 0;
        repT = setTimeout(function () { repT = null; if (!deadFlag) doReport(); }, wait);
      }
      function reportMyScore() {
        if (!isMulti || myIdx < 0) return;
        try { ctx.room.reportScore(localWins[myIdx] * 100000 + myPoints); } catch (e) {}
      }

      /* ============================================================
       *  Runden
       * ============================================================ */
      function beginRound(n, at) {
        clearTimers(); clearReport();
        roundNo = n; startAt = at;
        logs = []; logLen = []; botPers = [];
        for (var i = 0; i < roster.length; i++) { logs.push([]); logLen.push(0); botPers.push(newPers()); }
        sim = newSim(roster.length);
        dirty = false; frozen = false;
        roundOverAt = -1; roundApplied = false;
        particles = []; fxDone = [];
        for (i = 0; i < roster.length; i++) fxDone.push(false);
        ovKey = '';
        if (isMulti) doReport();
        updateHud(nowFn());
      }

      function checkRoundEnd(now) {
        if (!sim.over) { roundOverAt = -1; return; }
        if (roundOverAt < 0) {
          roundOverAt = now;
          if (App.Audio) App.Audio.sfx(sim.winner === myIdx ? 'win' : 'ding');
        }
        if (!roundApplied && now - roundOverAt >= 800) {
          roundApplied = true; frozen = true;             // Ergebnis steht -> keine Rollbacks mehr
          applyRoundResult();
        }
      }

      function applyRoundResult() {
        if (myIdx >= 0) {
          var b = sim.bikes[myIdx];
          var secs = ((b.alive ? sim.tick : b.deadAt) * TICK_MS) / 1000;
          var pl = b.place < 1 ? 4 : (b.place > 4 ? 4 : b.place);
          myPoints += PLACE_PTS[pl - 1] + Math.round(secs * 3);
        }
        if (sim.winner >= 0) localWins[sim.winner]++;
        updateHud(nowFn());
        if (isMulti) {
          reportMyScore();
          after(2600, tryAdvance);
          after(7000, tryAdvance);                        // Fallback, falls der Host gewechselt hat
        } else {
          after(2600, soloAdvance);
        }
      }

      function seriesOver() {
        var maxW = 0, leaders = 0, i;
        for (i = 0; i < localWins.length; i++) if (localWins[i] > maxW) maxW = localWins[i];
        for (i = 0; i < localWins.length; i++) if (localWins[i] === maxW) leaders++;
        return { over: (maxW >= WINS_NEEDED) || (roundNo >= MAX_ROUNDS && leaders === 1 && maxW > 0), maxW: maxW };
      }

      function tryAdvance() {
        if (deadFlag || !isMulti || seriesDone || !ctx.room.isHost()) return;
        var sh = sharedNow() || {};
        if (sh.over || sh.round !== roundNo) return;
        var wins = {};
        roster.forEach(function (r, i) { wins[r.id] = localWins[i]; });
        var so = seriesOver();
        try {
          if (so.over) ctx.room.setShared({ wins: wins, over: true, champ: roster[localWins.indexOf(so.maxW)].id });
          else ctx.room.setShared({ wins: wins, round: roundNo + 1, startAt: ctx.room.now() + 3500 });
        } catch (e) {}
      }

      function soloAdvance() {
        if (deadFlag) return;
        var so = seriesOver();
        if (so.over) soloFinish(so.maxW); else beginRound(roundNo + 1, nowFn() + 3200);
      }

      function soloFinish(maxW) {
        seriesDone = true;
        stopLoop(); clearTimers(); removeAllListeners();
        var champ = localWins.indexOf(maxW);
        if (champ === 0 && App.Scores) App.Scores.winCurrent();
        var best = App.Storage.get('best_tron', 0);
        var nb = myPoints > best;
        if (nb) App.Storage.set('best_tron', myPoints);
        if (App.Audio) App.Audio.sfx(champ === 0 ? 'jackpot' : 'lose');
        App.MG.endScreen(root, {
          score: myPoints, best: best, newBest: nb,
          title: champ === 0 ? '🏆 Serie gewonnen!' : '💥 Serie verloren',
          label: localWins[0] + ' von ' + roundNo + ' Runden gewonnen (' + LEVELS[level].name + ')'
            + (nb ? ' · neuer Rekord! 🎉' : ' · Bestwert: ' + App.MG.fmt(best)),
          onExit: ctx.onExit,
          onAgain: function () { showLevelPick(); }
        });
      }

      function finishSeries() {
        if (seriesDone) return;
        seriesDone = true;
        stopLoop(); clearTimers(); clearReport(); removeAllListeners();
        var sh = sharedNow() || {};
        if (sh.champ === ctx.me.id && App.Scores) App.Scores.winCurrent();
        if (App.Audio) App.Audio.sfx(sh.champ === ctx.me.id ? 'jackpot' : 'lose');
        reportMyScore();
        after(900, function () {
          App.MG.endScreen(root, {
            players: ctx.room.players(), meId: ctx.me.id,
            title: '🏁 Serie vorbei', format: fmtScore, onExit: ctx.onExit
          });
        });
      }

      /* ============================================================
       *  Haupt-Schleife: Wall-Clock -> Tick, rAF nur zum Zeichnen
       * ============================================================ */
      function loop() {
        raf = null;
        if (deadFlag || seriesDone || !sim) return;
        raf = requestAnimationFrame(loop);
        var now = nowFn();
        var target = Math.floor((now - startAt) / TICK_MS);
        /* Solo: nach Tab-Wechsel nicht vorspulen, sondern die Uhr nachziehen */
        if (!isMulti && target - sim.tick > 5) {
          startAt += (target - sim.tick - 5) * TICK_MS;
          now = nowFn(); target = sim.tick + 5;
        }
        if (frozen) dirty = false;
        if (dirty) rebuild(target); else advance(target);
        checkRoundEnd(now);
        var frac = ((now - startAt) / TICK_MS) - sim.tick;
        if (frac < 0) frac = 0; if (frac > 1) frac = 1;
        draw(frac, now);
        updateHud(now);
        updateOverlay(now);
      }

      function advance(target) {
        var guard = 0;
        while (sim.tick < target && !sim.over && guard++ < 400) {
          if (!isMulti) botInputs();
          stepSim(sim, logs);
          spawnDeathFx();
        }
      }

      /* Rollback: Runde komplett aus dem Eingabe-Log neu rechnen (nur Multiplayer). */
      function rebuild(target) {
        dirty = false;
        sim = newSim(roster.length);
        var guard = 0;
        while (sim.tick < target && !sim.over && guard++ < 2000) stepSim(sim, logs);
        /* Explosions-Merker exakt an den neuen Stand angleichen: lebt ein Bike nach dem
           Rollback wieder, muss es spaeter erneut explodieren duerfen (nicht nur setzen). */
        for (var i = 0; i < sim.n; i++) fxDone[i] = !sim.bikes[i].alive;
        if (!sim.over) roundOverAt = -1;
      }

      function botInputs() {
        var t = sim.tick + 1;
        for (var i = 0; i < roster.length; i++) {
          if (!roster[i].bot) continue;
          var b = sim.bikes[i];
          if (!b.alive) continue;
          var d = botDecide(sim, i, level, botPers[i]);
          if (d >= 0 && d !== b.dir) logs[i].push({ t: t, d: d });
        }
      }

      function spawnDeathFx() {
        for (var i = 0; i < sim.n; i++) {
          var b = sim.bikes[i];
          if (b.alive || fxDone[i]) continue;
          fxDone[i] = true;
          boom(i);
        }
      }
      function boom(i) {
        var b = sim.bikes[i], now = Date.now();
        for (var k = 0; k < 24; k++) {
          var a = Math.random() * Math.PI * 2, sp = 40 + Math.random() * 170;
          particles.push({
            x: cxp(b.crashX), y: cyp(b.crashY), vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
            born: now, life: 480 + Math.random() * 460, c: COLORS[i].line
          });
        }
        if (App.Audio) App.Audio.sfx('explosion');
      }

      /* ============================================================
       *  Eingabe
       * ============================================================ */
      function curTick() { return Math.floor((nowFn() - startAt) / TICK_MS); }
      function plannedDir(i, atT) {
        var lg = logs[i];
        for (var k = lg.length - 1; k >= 0; k--) if (lg[k].t <= atT) return lg[k].d;
        return SPAWNS[i].d;
      }
      function setDir(d) {
        if (deadFlag || !sim || sim.over || myIdx < 0) return;
        var b = sim.bikes[myIdx];
        if (!b.alive) return;
        var t = curTick() + (isMulti ? DELAY_MULTI : DELAY_SOLO);
        if (t < sim.tick + 1) t = sim.tick + 1;
        var pd = plannedDir(myIdx, t);
        if (d === pd) return;                              // keine Aenderung -> Tastenwiederholung ignorieren
        if (d === (pd + 2) % 4) {                          // Kehrtwende verboten
          if (App.Audio) App.Audio.sfx('error');
          flashPad(d, true);
          return;
        }
        logs[myIdx].push({ t: t, d: d });
        logLen[myIdx] = logs[myIdx].length;
        if (App.Audio) App.Audio.blip(520 + d * 90, 0.05, { type: 'square', peak: 0.05 });
        if (isMulti) scheduleReport();
        flashPad(d, false);
      }
      function flashPad(d, bad) {
        var b = padBtns[d];
        if (!b) return;
        var cls = bad ? 'trn-pad-bad' : 'trn-pad-hit';
        b.classList.remove(cls); void b.offsetWidth; b.classList.add(cls);
        after(220, function () { b.classList.remove(cls); });
      }
      function attachInput() {
        var onKey = function (e) {
          var k = e.key, d = -1;
          if (k === 'ArrowRight' || k === 'd' || k === 'D') d = 0;
          else if (k === 'ArrowDown' || k === 's' || k === 'S') d = 1;
          else if (k === 'ArrowLeft' || k === 'a' || k === 'A') d = 2;
          else if (k === 'ArrowUp' || k === 'w' || k === 'W') d = 3;
          if (d < 0) return;
          e.preventDefault();
          setDir(d);
        };
        addL(document, 'keydown', onKey);

        var sw = null;
        addL(canvas, 'pointerdown', function (e) { e.preventDefault(); sw = { x: e.clientX, y: e.clientY }; });
        addL(canvas, 'pointermove', function (e) {
          if (!sw) return;
          var dx = e.clientX - sw.x, dy = e.clientY - sw.y;
          if (Math.abs(dx) < 22 && Math.abs(dy) < 22) return;
          sw.x = e.clientX; sw.y = e.clientY;             // Ursprung nachziehen -> Weiterwischen moeglich
          setDir(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 0 : 2) : (dy > 0 ? 1 : 3));
        });
        addL(canvas, 'pointerup', function () { sw = null; });
        addL(canvas, 'pointercancel', function () { sw = null; });
      }

      /* ============================================================
       *  Aufbau der Spielansicht
       * ============================================================ */
      function buildStage() {
        removeAllListeners();
        canvas = el('canvas', { class: 'trn-canvas', width: W, height: H });
        overlay = el('div', { class: 'trn-overlay' });
        var stage = el('div', { class: 'trn-stage' }, [canvas, overlay]);

        roundEl = el('div', { class: 'trn-round' }, ['Runde 1 / ' + MAX_ROUNDS]);
        zoneEl = el('div', { class: 'trn-zone' }, ['🌿 Freie Fahrt']);
        timeEl = el('div', { class: 'mg-timer trn-time' }, ['0:00']);
        var head = el('div', { class: 'trn-head glass' }, [roundEl, zoneEl, timeEl]);

        chipsEl = el('div', { class: 'trn-chips' });
        chipRefs = [];
        roster.forEach(function (r, i) {
          var nm = el('span', { class: 'trn-nm' }, [r.name + (i === myIdx ? ' (du)' : '')]);
          var st = el('span', { class: 'trn-st' }, ['']);
          var pips = el('span', { class: 'trn-pips' });
          var pipEls = [];
          for (var k = 0; k < WINS_NEEDED; k++) { var p = el('i', { class: 'trn-pip' }); pipEls.push(p); pips.appendChild(p); }
          var chip = el('div', { class: 'trn-chip trn-p' + (i + 1) + (i === myIdx ? ' trn-me' : '') }, [
            el('span', { class: 'trn-dot' }),
            el('span', { class: 'trn-chip-mid' }, [nm, st]),
            pips
          ]);
          chipRefs.push({ chip: chip, st: st, pips: pipEls, lastSt: null, lastW: -1 });
          chipsEl.appendChild(chip);
        });

        padBtns = [];
        var mk = function (d) {
          var b = el('button', { class: 'trn-pad-b', type: 'button', 'aria-label': 'Richtung ' + ARROWS[d] }, [ARROWS[d]]);
          b.addEventListener('pointerdown', function (e) { e.preventDefault(); setDir(d); });
          padBtns[d] = b;
          return b;
        };
        var pad = el('div', { class: 'trn-pad' }, [
          el('div', { class: 'trn-pad-row' }, [mk(3)]),
          el('div', { class: 'trn-pad-row' }, [mk(2), mk(1), mk(0)])
        ]);

        var wrap = el('div', { class: 'trn-wrap' }, [
          head, chipsEl, stage, pad, el('p', { class: 'hint-text trn-hint' }, [HINT])
        ]);
        root.innerHTML = ''; root.appendChild(wrap);

        g2 = canvas.getContext('2d');
        bgGrad = g2.createLinearGradient(0, 0, 0, H);
        bgGrad.addColorStop(0, '#06180e'); bgGrad.addColorStop(1, '#02090f');
        attachInput();
      }

      /* ============================================================
       *  HUD + Overlay
       * ============================================================ */
      function nextRing() {
        if (!sim || sim.tick < SHRINK_START - SHRINK_WARN) return 0;
        var r = ringAt(sim.tick) + 1;
        return r > MAX_RING ? MAX_RING : r;
      }
      function setText(node, txt) { if (node && node.textContent !== txt) node.textContent = txt; }
      /* Steht es nach MAX_ROUNDS unentschieden, laeuft die Serie als Entscheidungs-
         runde weiter (seriesOver verlangt einen alleinigen Fuehrenden) — dann waere
         "Runde 6 / 5" falsch. */
      function roundLabel() {
        return roundNo > MAX_ROUNDS ? 'Entscheidung · Runde ' + roundNo : 'Runde ' + roundNo + ' / ' + MAX_ROUNDS;
      }

      function updateHud(now) {
        if (!sim || !roundEl) return;
        setText(roundEl, roundLabel());
        setText(timeEl, App.MG.mmss((sim.tick * TICK_MS) / 1000));
        var zt, zc;
        if (sim.ring > 0) { zt = '⚠️ Arena schrumpft'; zc = 'trn-zone trn-zone-hot'; }
        else if (sim.tick >= SHRINK_START - SHRINK_WARN) { zt = '⏳ Arena schrumpft gleich'; zc = 'trn-zone trn-zone-warn'; }
        else { zt = '🌿 Freie Fahrt'; zc = 'trn-zone'; }
        setText(zoneEl, zt);
        if (zoneEl.className !== zc) zoneEl.className = zc;

        for (var i = 0; i < chipRefs.length; i++) {
          var r = chipRefs[i], b = sim.bikes[i];
          var s = !b.alive ? 'raus' : (onlineSet && !onlineSet[roster[i].id] ? 'offline' : 'fährt');
          if (r.lastSt !== s) {
            r.lastSt = s;
            r.st.textContent = s === 'fährt' ? '' : (s === 'raus' ? '💥 raus' : '🔌 offline');
            r.chip.classList.toggle('trn-out', !b.alive);
          }
          var w = localWins[i] || 0;
          if (r.lastW !== w) {
            r.lastW = w;
            for (var k = 0; k < r.pips.length; k++) r.pips[k].classList.toggle('on', k < w);
          }
        }
      }

      function updateOverlay(now) {
        var key, big, sub, cls;
        if (roundOverAt >= 0) {
          key = 'res' + roundNo + (sim.winner < 0 ? 'd' : sim.winner);
          if (sim.winner < 0) { big = '🤝 Unentschieden'; cls = 'trn-ov trn-ov-draw'; }
          else if (sim.winner === myIdx) { big = '🏆 Runde gewonnen!'; cls = 'trn-ov trn-ov-win'; }
          else { big = roster[sim.winner].name + ' gewinnt'; cls = 'trn-ov trn-ov-lose'; }
          var so = seriesOver();
          sub = so.over ? 'Serie entschieden …' : 'Nächste Runde …';
        } else if (now < startAt) {
          var left = Math.ceil((startAt - now) / 1000);
          if (left > 3) left = 3;
          key = 'cd' + left;
          big = String(left);
          sub = (roundNo > MAX_ROUNDS ? 'Entscheidungsrunde' : 'Runde ' + roundNo) + ' – mach dich bereit';
          cls = 'trn-ov trn-ov-cd';
        } else if (now - startAt < 650) {
          key = 'go'; big = 'LOS!'; sub = ''; cls = 'trn-ov trn-ov-go';
        } else {
          key = 'none';
        }
        if (key === ovKey) return;
        ovKey = key;
        overlay.innerHTML = '';
        if (key === 'none') { overlay.className = 'trn-overlay'; return; }
        overlay.className = 'trn-overlay ' + cls;
        overlay.appendChild(el('div', { class: 'trn-ov-big' }, [big]));
        if (sub) overlay.appendChild(el('div', { class: 'trn-ov-sub' }, [sub]));
      }

      /* ============================================================
       *  Rendering
       * ============================================================ */
      function cxp(x) { return x * CELL + CELL / 2; }
      function cyp(y) { return y * CELL + CELL / 2; }

      function draw(frac, now) {
        var g = g2, i;
        if (!g) return;
        g.clearRect(0, 0, W, H);
        g.fillStyle = bgGrad; g.fillRect(0, 0, W, H);

        /* Gitter */
        g.save();
        g.strokeStyle = 'rgba(57,255,20,0.07)'; g.lineWidth = 1;
        g.beginPath();
        for (i = 0; i <= GW; i += 2) { g.moveTo(i * CELL + 0.5, 0); g.lineTo(i * CELL + 0.5, H); }
        for (i = 0; i <= GH; i += 2) { g.moveTo(0, i * CELL + 0.5); g.lineTo(W, i * CELL + 0.5); }
        g.stroke(); g.restore();

        drawZone(g, now);

        for (i = 0; i < sim.n; i++) drawTrail(g, i, frac);
        for (i = 0; i < sim.n; i++) drawHead(g, i, frac, now);
        drawParticles(g);

        /* Aussenrahmen */
        g.save();
        g.strokeStyle = 'rgba(57,255,20,0.35)'; g.lineWidth = 3;
        g.strokeRect(1.5, 1.5, W - 3, H - 3);
        g.restore();
      }

      function drawZone(g, now) {
        var r = sim.ring;
        if (r > 0) {
          var s = r * CELL, iw = W - 2 * s, ih = H - 2 * s;
          g.save();
          g.fillStyle = 'rgba(255,77,109,0.17)';
          g.fillRect(0, 0, W, s); g.fillRect(0, H - s, W, s);
          if (ih > 0) { g.fillRect(0, s, s, ih); g.fillRect(W - s, s, s, ih); }
          if (iw > 0 && ih > 0) {
            g.strokeStyle = 'rgba(255,77,109,0.8)'; g.lineWidth = 2;
            g.shadowColor = 'rgba(255,77,109,0.7)'; g.shadowBlur = 12;
            g.strokeRect(s, s, iw, ih);
          }
          g.restore();
        }
        var nr = nextRing();
        if (nr > r) {
          var ns = nr * CELL, nw = W - 2 * ns, nh = H - 2 * ns;
          if (nw > 0 && nh > 0) {
            var pulse = 0.32 + 0.3 * Math.sin(now / 150);
            g.save();
            g.strokeStyle = 'rgba(255,210,63,' + pulse.toFixed(2) + ')';
            g.lineWidth = 2; g.setLineDash([8, 8]);
            g.strokeRect(ns, ns, nw, nh);
            g.restore();
          }
        }
      }

      function pathTrail(g, tr, hx, hy) {
        g.beginPath();
        var n = tr.length;
        if (n < 2) { g.moveTo(cxp(hx), cyp(hy)); g.lineTo(cxp(hx), cyp(hy)); return; }
        g.moveTo(cxp(tr[0].x), cyp(tr[0].y));
        for (var k = 1; k < n - 1; k++) g.lineTo(cxp(tr[k].x), cyp(tr[k].y));
        g.lineTo(cxp(hx), cyp(hy));
      }

      function drawTrail(g, i, frac) {
        var b = sim.bikes[i], tr = b.trail, col = COLORS[i];
        var hx = b.x, hy = b.y;
        if (b.alive && tr.length >= 2) { hx = b.px + (b.x - b.px) * frac; hy = b.py + (b.y - b.py) * frac; }
        g.save();
        g.lineCap = 'round'; g.lineJoin = 'round';
        g.globalAlpha = b.alive ? 0.5 : 0.22;
        g.strokeStyle = col.soft; g.lineWidth = CELL * 0.95;
        pathTrail(g, tr, hx, hy); g.stroke();
        g.globalAlpha = b.alive ? 1 : 0.5;
        g.strokeStyle = col.line; g.lineWidth = CELL * 0.42;
        g.shadowColor = col.glow; g.shadowBlur = b.alive ? 14 : 4;
        pathTrail(g, tr, hx, hy); g.stroke();
        g.restore();
      }

      function drawHead(g, i, frac, now) {
        var b = sim.bikes[i];
        if (!b.alive) return;
        var col = COLORS[i];
        var hx = b.px + (b.x - b.px) * frac, hy = b.py + (b.y - b.py) * frac;
        var px = cxp(hx), py = cyp(hy);
        g.save();
        g.shadowColor = col.glow; g.shadowBlur = 24;
        g.globalAlpha = 0.9; g.fillStyle = col.line;
        g.beginPath(); g.arc(px, py, CELL * 0.52, 0, Math.PI * 2); g.fill();
        g.globalAlpha = 1; g.fillStyle = '#eafff2';
        g.beginPath(); g.arc(px, py, CELL * 0.3, 0, Math.PI * 2); g.fill();
        g.restore();
        if (i === myIdx) {
          var rr = CELL * (0.85 + 0.12 * Math.sin(now / 130));
          g.save();
          g.strokeStyle = '#ffffff'; g.globalAlpha = 0.55; g.lineWidth = 2;
          g.beginPath(); g.arc(px, py, rr, 0, Math.PI * 2); g.stroke();
          g.restore();
        }
      }

      function drawParticles(g) {
        var now = Date.now(), keep = [];
        g.save();
        for (var k = 0; k < particles.length; k++) {
          var p = particles[k], age = now - p.born, l = age / p.life;
          if (l >= 1) continue;
          keep.push(p);
          var e = age / 1000;
          g.globalAlpha = 1 - l;
          g.fillStyle = p.c; g.shadowColor = p.c; g.shadowBlur = 10;
          g.beginPath(); g.arc(p.x + p.vx * e, p.y + p.vy * e, 3 * (1 - l) + 1, 0, Math.PI * 2); g.fill();
        }
        g.restore();
        particles = keep;
      }
    }
  };

  /* ===================== STYLES ===================== */
  function injectStyle() {
    UI.injectStyle('mg-tron-css', [
      '.trn-wrap{display:flex;flex-direction:column;gap:12px;align-items:stretch;}',
      /* Kopfzeile */
      '.trn-head{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 16px;flex-wrap:wrap;}',
      '.trn-round{font-size:12px;font-weight:900;color:var(--muted);text-transform:uppercase;letter-spacing:1.5px;}',
      '.trn-zone{font-size:12px;font-weight:800;color:var(--leaf);letter-spacing:.5px;transition:color .2s;}',
      '.trn-zone-warn{color:var(--gold);animation:trn-blink 1s ease-in-out infinite;}',
      '.trn-zone-hot{color:var(--danger);animation:trn-blink .55s ease-in-out infinite;}',
      '@keyframes trn-blink{0%,100%{opacity:1}50%{opacity:.35}}',
      '.trn-time{font-size:clamp(15px,4vw,20px);font-variant-numeric:tabular-nums;}',
      /* Spieler-Chips */
      '.trn-chips{display:flex;gap:8px;flex-wrap:wrap;}',
      '.trn-chip{flex:1 1 130px;min-width:0;display:flex;align-items:center;gap:8px;padding:7px 10px;border-radius:12px;',
      'background:rgba(9,32,21,.6);border:1px solid var(--stroke);transition:opacity .25s,border-color .25s,box-shadow .25s;}',
      '.trn-chip.trn-me{border-color:var(--stroke-2);box-shadow:0 0 14px rgba(57,255,20,.18);}',
      '.trn-chip.trn-out{opacity:.42;}',
      '.trn-dot{width:11px;height:11px;border-radius:50%;flex:0 0 auto;}',
      '.trn-chip-mid{flex:1;min-width:0;display:flex;flex-direction:column;line-height:1.2;}',
      '.trn-nm{font-weight:800;font-size:12.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      '.trn-st{font-size:10px;color:var(--muted);letter-spacing:.5px;min-height:12px;}',
      '.trn-pips{display:flex;gap:3px;flex:0 0 auto;}',
      '.trn-pip{width:8px;height:8px;border-radius:50%;background:rgba(255,255,255,.12);border:1px solid var(--stroke);transition:.2s;}',
      '.trn-pip.on{background:var(--gold);border-color:var(--gold);box-shadow:0 0 8px rgba(255,210,63,.7);}',
      '.trn-p1 .trn-dot{background:var(--neon);box-shadow:0 0 9px var(--neon);}',
      '.trn-p2 .trn-dot{background:var(--aqua);box-shadow:0 0 9px var(--aqua);}',
      '.trn-p3 .trn-dot{background:var(--gold);box-shadow:0 0 9px var(--gold);}',
      '.trn-p4 .trn-dot{background:var(--danger);box-shadow:0 0 9px var(--danger);}',
      '.trn-p1 .trn-nm{color:var(--neon);}.trn-p2 .trn-nm{color:var(--aqua);}',
      '.trn-p3 .trn-nm{color:var(--gold);}.trn-p4 .trn-nm{color:var(--danger);}',
      /* Arena */
      '.trn-stage{position:relative;width:100%;max-width:860px;margin:0 auto;aspect-ratio:960 / 640;}',
      '.trn-canvas{display:block;width:100%;height:100%;border-radius:14px;background:#04140c;',
      'border:2px solid rgba(57,255,20,.32);box-shadow:0 0 42px rgba(57,255,20,.2),inset 0 0 60px rgba(57,255,20,.06);',
      'touch-action:none;user-select:none;-webkit-user-select:none;-webkit-tap-highlight-color:transparent;}',
      /* Overlay */
      '.trn-overlay{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;',
      'gap:6px;pointer-events:none;border-radius:14px;text-align:center;padding:12px;}',
      '.trn-overlay.trn-ov{background:radial-gradient(circle at 50% 50%,rgba(2,10,6,.72),rgba(2,10,6,.32) 70%,transparent);}',
      '.trn-ov-big{font-size:clamp(28px,8vw,64px);font-weight:900;line-height:1.05;letter-spacing:1px;animation:trn-pop .28s cubic-bezier(.2,.9,.3,1.3) both;}',
      '.trn-ov-sub{font-size:clamp(11px,2.8vw,15px);font-weight:800;color:var(--muted);letter-spacing:1px;text-transform:uppercase;}',
      '@keyframes trn-pop{0%{transform:scale(.5);opacity:0}100%{transform:scale(1);opacity:1}}',
      '.trn-ov-cd .trn-ov-big{color:var(--aqua-soft);text-shadow:0 0 26px rgba(51,230,208,.65);}',
      '.trn-ov-go .trn-ov-big{color:var(--neon);text-shadow:0 0 30px rgba(57,255,20,.8);}',
      '.trn-ov-win .trn-ov-big{color:var(--gold);text-shadow:0 0 26px rgba(255,210,63,.7);}',
      '.trn-ov-lose .trn-ov-big{color:var(--danger);text-shadow:0 0 22px rgba(255,77,109,.6);}',
      '.trn-ov-draw .trn-ov-big{color:var(--silver);text-shadow:0 0 18px rgba(207,228,220,.5);}',
      /* Steuerkreuz */
      '.trn-pad{display:flex;flex-direction:column;align-items:center;gap:6px;}',
      '.trn-pad-row{display:flex;gap:6px;}',
      '.trn-pad-b{width:56px;height:46px;border-radius:12px;background:rgba(6,24,16,.8);border:1px solid var(--stroke);',
      'color:var(--leaf);font-size:17px;line-height:1;cursor:pointer;font-family:inherit;padding:0;',
      'display:flex;align-items:center;justify-content:center;touch-action:none;-webkit-tap-highlight-color:transparent;',
      'user-select:none;-webkit-user-select:none;transition:transform .08s,border-color .15s,box-shadow .15s,background .15s;}',
      '.trn-pad-b:hover{border-color:var(--stroke-2);}',
      '.trn-pad-b.trn-pad-hit{background:rgba(57,255,20,.22);border-color:var(--neon);color:#eafff2;',
      'box-shadow:0 0 16px rgba(57,255,20,.55);transform:scale(.93);}',
      '.trn-pad-b.trn-pad-bad{background:rgba(255,77,109,.24);border-color:var(--danger);color:#fff;animation:trn-shake .22s ease;}',
      '@keyframes trn-shake{0%,100%{transform:translateX(0)}30%{transform:translateX(-5px)}70%{transform:translateX(5px)}}',
      '.trn-hint{text-align:center;margin:0;}',
      /* Panels (Stufenwahl / Warten) */
      '.trn-panel{padding:28px 22px;text-align:center;display:flex;flex-direction:column;gap:12px;align-items:center;max-width:520px;margin:0 auto;}',
      '.trn-panel-icon{font-size:52px;line-height:1;filter:drop-shadow(0 0 14px rgba(57,255,20,.5));}',
      '.trn-bob{animation:trn-bob 1.6s ease-in-out infinite;}',
      '@keyframes trn-bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-8px)}}',
      '.trn-panel h2{margin:0;font-size:clamp(24px,7vw,36px);}',
      '.trn-wait-n{color:var(--aqua);}',
      '.trn-lvls{display:flex;flex-direction:column;gap:8px;width:100%;max-width:330px;}',
      '.trn-lvl{display:flex;align-items:center;gap:10px;text-align:left;flex-wrap:wrap;}',
      '.trn-lvl-icon{font-size:20px;line-height:1;flex:0 0 auto;}',
      '.trn-lvl-nm{font-weight:900;flex:0 0 auto;}',
      '.trn-lvl-d{font-size:11px;opacity:.8;flex:1 1 100%;font-weight:600;line-height:1.3;}',
      '.trn-rules{margin:0;font-size:11.5px;line-height:1.5;}',
      '.trn-best{margin:0;color:var(--gold);font-weight:800;font-size:13px;}'
    ].join(''));
  }
})();
