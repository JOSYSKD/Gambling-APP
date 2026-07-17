/* ninemensmorris.js — "Mühle" (Nine Men's Morris) im Neon-Dschungel-Look.
 *
 * IDEE   : Klassisches Mühle-Duell auf einem Canvas-Brett aus drei verschachtelten
 *          Quadraten mit 24 Schnittpunkten.
 *          Phase 1 "Setzen": beide setzen abwechselnd ihre 9 Steine.
 *          Phase 2 "Ziehen": Steine wandern entlang der Linien auf freie Nachbarpunkte.
 *          Drei Steine in einer Linie = Mühle -> sofort einen gegnerischen Stein
 *          wegnehmen (Steine in einer Mühle sind geschützt, solange es freie gibt).
 *          Wer auf 2 Steine schrumpft oder nicht mehr ziehen kann, verliert.
 *          Mit nur noch 3 Steinen darf man "fliegen" (auf jeden freien Punkt springen).
 *          60 Züge ohne Mühle = Remis.
 *
 * STEUER.: Nur Tippen/Klicken auf die Punkte (Maus + Touch über pointerdown).
 *          Setzen: freien Punkt antippen. Ziehen: eigenen Stein antippen (leuchtet
 *          golden), dann ein markiertes Ziel. Mühle: gegnerischen Stein mit ✕ antippen.
 *
 * PUNKTE : SOLO -> Sieg = Grundwert der Stufe (300/600/1000) + 50 je Stein über 3,
 *          Remis = ein Viertel, Niederlage = 0. Bestwert in 'best_ninemensmorris'.
 *          MULTI -> Sieger meldet 1, Verlierer 0 (Podest über App.MG.endScreen).
 *
 * SYNC   : Rundenbasiert über room.shared. Wer am Zug ist, rechnet den Zug lokal und
 *          schreibt den kompletten Brettzustand per room.setShared (flache Skalare,
 *          Firebase-freundlich). Der Host legt den Startzustand an. Beide Clients
 *          rendern nur aus 'shared'; die laufende Nummer moveNo verhindert doppelte
 *          Animationen bei den (sehr häufigen) Heartbeat-Events.
 *
 * SOLO   : Bot mit Negamax + Alpha-Beta über zusammengesetzte Züge (Setzen/Ziehen +
 *          Wegnehmen in einem Knoten), Bewertung aus Material, Mühlen, Doppelmühlen,
 *          offenen Zweierreihen, Beweglichkeit und blockierten Steinen. 3 Stufen.
 */
(function () {
  'use strict';
  window.App = window.App || {}; App.Minigames = App.Minigames || {};
  var UI = App.UI, el = UI.el;

  injectStyle();

  /* ===================== Brett-Tabellen ===================== */
  var W = 'W', B = 'B';
  var SYM = { W: '🟢', B: '🔵' };
  var TEAM = { W: 'Smaragd', B: 'Türkis' };

  /* Rasterkoordinaten (0..6) der 24 Punkte, von oben links nach unten rechts. */
  var GP = [
    [0, 0], [3, 0], [6, 0],
    [1, 1], [3, 1], [5, 1],
    [2, 2], [3, 2], [4, 2],
    [0, 3], [1, 3], [2, 3], [4, 3], [5, 3], [6, 3],
    [2, 4], [3, 4], [4, 4],
    [1, 5], [3, 5], [5, 5],
    [0, 6], [3, 6], [6, 6]
  ];

  /* Nachbarn entlang der gezeichneten Linien. */
  var ADJ = [
    [1, 9], [0, 2, 4], [1, 14],
    [4, 10], [1, 3, 5, 7], [4, 13],
    [7, 11], [4, 6, 8], [7, 12],
    [0, 10, 21], [3, 9, 11, 18], [6, 10, 15], [8, 13, 17], [5, 12, 14, 20], [2, 13, 23],
    [11, 16], [15, 17, 19], [12, 16],
    [10, 19], [16, 18, 20, 22], [13, 19],
    [9, 22], [19, 21, 23], [14, 22]
  ];

  /* Die 16 möglichen Mühlen (8 waagerecht, 8 senkrecht). */
  var MILLS = [
    [0, 1, 2], [3, 4, 5], [6, 7, 8], [9, 10, 11], [12, 13, 14], [15, 16, 17], [18, 19, 20], [21, 22, 23],
    [0, 9, 21], [3, 10, 18], [6, 11, 15], [1, 4, 7], [16, 19, 22], [8, 12, 17], [5, 13, 20], [2, 14, 23]
  ];
  var MILLS_AT = (function () {
    var t = [], i, k;
    for (i = 0; i < 24; i++) t.push([]);
    for (k = 0; k < MILLS.length; k++) for (i = 0; i < 3; i++) t[MILLS[k][i]].push(MILLS[k]);
    return t;
  })();

  /* Zeichenmaße (virtuelles Canvas, per CSS skaliert). */
  var SIZE = 560, MARGIN = 54, CELL = (SIZE - 2 * MARGIN) / 6, STONE_R = 25;
  function px(v) { return MARGIN + v * CELL; }
  function cx(i) { return px(GP[i][0]); }
  function cy(i) { return px(GP[i][1]); }

  var COL = {
    W: { hi: '#e6ffd9', mid: '#5cf03a', lo: '#127a05', edge: '#b6ff9b', glow: 'rgba(57,255,20,.85)' },
    B: { hi: '#dffcf7', mid: '#3fe8d3', lo: '#08706a', edge: '#9ff5ea', glow: 'rgba(51,230,208,.85)' }
  };

  var DRAW_LIMIT = 60;   // Halbzüge ohne Mühle -> Remis
  var LEVELS = [
    { name: 'Leicht', icon: '🌱', desc: 'Schaut nur einen Zug voraus', dPlace: 1, dMove: 1, rnd: 0.45, limit: 20000, base: 300 },
    { name: 'Normal', icon: '🌿', desc: 'Denkt ein paar Züge weiter', dPlace: 3, dMove: 3, rnd: 0.10, limit: 70000, base: 600 },
    { name: 'Schwer', icon: '🔥', desc: 'Rechnet tief und verzeiht nichts', dPlace: 4, dMove: 5, rnd: 0, limit: 160000, base: 1000 }
  ];

  /* ===================== reine Regel-Logik ===================== */
  function blank() { var a = [], i; for (i = 0; i < 24; i++) a.push(''); return a; }
  function other(m) { return m === W ? B : W; }
  function countOf(b, m) { var n = 0, i; for (i = 0; i < 24; i++) if (b[i] === m) n++; return n; }
  function emptyCount(b) { var n = 0, i; for (i = 0; i < 24; i++) if (b[i] === '') n++; return n; }

  function millsAt(b, i, m) {
    var res = [], ls = MILLS_AT[i], k, L;
    for (k = 0; k < ls.length; k++) { L = ls[k]; if (b[L[0]] === m && b[L[1]] === m && b[L[2]] === m) res.push(L); }
    return res;
  }
  function inMill(b, i, m) { return millsAt(b, i, m).length > 0; }
  function allMills(b) {
    var res = [], k, L, v;
    for (k = 0; k < MILLS.length; k++) { L = MILLS[k]; v = b[L[0]]; if (v && b[L[1]] === v && b[L[2]] === v) res.push(L); }
    return res;
  }
  /* Wegnehmbare Steine: alles, was nicht in einer Mühle steht — sonst (alle
     geschützt) ausnahmsweise doch jeder Stein. */
  function removableOf(b, opp) {
    var free = [], all = [], i;
    for (i = 0; i < 24; i++) if (b[i] === opp) { all.push(i); if (!inMill(b, i, opp)) free.push(i); }
    return free.length ? free : all;
  }

  function isPlacing(g, m) { return g.placed[m] < 9; }
  function canFly(g, m) { return g.placed[m] >= 9 && countOf(g.board, m) === 3; }
  function targetsFrom(g, from) {
    var m = g.board[from], out = [], i, a;
    if (!m) return out;
    if (canFly(g, m)) { for (i = 0; i < 24; i++) if (g.board[i] === '') out.push(i); return out; }
    a = ADJ[from];
    for (i = 0; i < a.length; i++) if (g.board[a[i]] === '') out.push(a[i]);
    return out;
  }
  function hasMove(g, m) {
    var i, j, a;
    if (isPlacing(g, m)) return emptyCount(g.board) > 0;
    if (canFly(g, m)) return emptyCount(g.board) > 0;
    for (i = 0; i < 24; i++) {
      if (g.board[i] !== m) continue;
      a = ADJ[i];
      for (j = 0; j < a.length; j++) if (g.board[a[j]] === '') return true;
    }
    return false;
  }

  function newGame() {
    return { board: blank(), turn: W, placed: { W: 0, B: 0 }, mustRemove: false, noCap: 0, winner: '', moveNo: 0, op: null };
  }
  function cloneG(g) {
    return {
      board: g.board.slice(), turn: g.turn, placed: { W: g.placed.W, B: g.placed.B },
      mustRemove: g.mustRemove, noCap: g.noCap, winner: g.winner, moveNo: g.moveNo, op: g.op
    };
  }
  /* Setzen (from = -1) oder Ziehen. Erwartet einen legalen Zug. */
  function doPlaceMove(g, from, to) {
    var m = g.turn;
    g.board[to] = m;
    if (from >= 0) g.board[from] = ''; else g.placed[m] = g.placed[m] + 1;
    g.noCap = g.noCap + 1;
    g.moveNo = g.moveNo + 1;
    g.op = { kind: from >= 0 ? 'move' : 'place', from: from, to: to, mark: m };
    if (millsAt(g.board, to, m).length > 0 && countOf(g.board, other(m)) > 0) g.mustRemove = true;
    else endTurn(g);
  }
  function doRemove(g, at) {
    var m = g.board[at];
    g.board[at] = '';
    g.mustRemove = false;
    g.noCap = 0;
    g.moveNo = g.moveNo + 1;
    g.op = { kind: 'remove', from: -1, to: at, mark: m };
    endTurn(g);
  }
  function endTurn(g) {
    g.turn = other(g.turn);
    var t = g.turn;
    if (g.placed[t] >= 9 && countOf(g.board, t) < 3) { g.winner = other(t); return; }
    if (!hasMove(g, t)) { g.winner = other(t); return; }
    if (g.noCap >= DRAW_LIMIT) g.winner = 'draw';
  }

  /* ===================== Bot: Negamax + Alpha-Beta ===================== */
  /* Suchzustand: nur Brett, gesetzte Steine und der Remis-Zähler. Ein "Zug" ist
     zusammengesetzt: {from, to, remove} — so steckt das Wegnehmen mit im Knoten. */
  var NODES = 0, NODE_LIMIT = 0, WIN_SC = 1000000;

  function genActions(S, m) {
    var acts = [], b = S.board, rem = removableOf(b, other(m)), i, k, a;
    function push(from, to) {
      var formed = false, ls = MILLS_AT[to], q, L, r;
      b[to] = m; if (from >= 0) b[from] = '';
      for (q = 0; q < ls.length; q++) { L = ls[q]; if (b[L[0]] === m && b[L[1]] === m && b[L[2]] === m) { formed = true; break; } }
      b[to] = ''; if (from >= 0) b[from] = m;
      if (formed && rem.length) { for (r = 0; r < rem.length; r++) acts.push({ from: from, to: to, remove: rem[r] }); }
      else acts.push({ from: from, to: to, remove: -1 });
    }
    if (S.placed[m] < 9) {
      for (i = 0; i < 24; i++) if (b[i] === '') push(-1, i);
      return acts;
    }
    var fly = countOf(b, m) === 3;
    for (i = 0; i < 24; i++) {
      if (b[i] !== m) continue;
      if (fly) { for (k = 0; k < 24; k++) if (b[k] === '') push(i, k); }
      else { a = ADJ[i]; for (k = 0; k < a.length; k++) if (b[a[k]] === '') push(i, a[k]); }
    }
    return acts;
  }
  function doAct(S, m, a) {
    var u = { from: a.from, to: a.to, remove: a.remove, mark: m, noCap: S.noCap, rem: a.remove >= 0 ? S.board[a.remove] : '' };
    S.board[a.to] = m;
    if (a.from >= 0) S.board[a.from] = ''; else S.placed[m] = S.placed[m] + 1;
    if (a.remove >= 0) S.board[a.remove] = '';
    S.noCap = a.remove >= 0 ? 0 : S.noCap + 1;
    return u;
  }
  function undoAct(S, u) {
    if (u.remove >= 0) S.board[u.remove] = u.rem;
    S.board[u.to] = '';
    if (u.from >= 0) S.board[u.from] = u.mark; else S.placed[u.mark] = S.placed[u.mark] - 1;
    S.noCap = u.noCap;
  }
  function sideStats(b, m) {
    var st = { pieces: 0, mills: 0, dbl: 0, two: 0, mob: 0, blocked: 0 };
    var cnt = [], i, k, q, L, c, e, a, free;
    for (i = 0; i < 24; i++) cnt.push(0);
    for (k = 0; k < MILLS.length; k++) {
      L = MILLS[k]; c = 0; e = 0;
      for (q = 0; q < 3; q++) { if (b[L[q]] === m) c++; else if (b[L[q]] === '') e++; }
      if (c === 3) { st.mills++; cnt[L[0]]++; cnt[L[1]]++; cnt[L[2]]++; }
      else if (c === 2 && e === 1) st.two++;
    }
    for (i = 0; i < 24; i++) {
      if (b[i] !== m) continue;
      st.pieces++;
      if (cnt[i] >= 2) st.dbl++;
      a = ADJ[i]; free = 0;
      for (k = 0; k < a.length; k++) if (b[a[k]] === '') free++;
      st.mob += free;
      if (free === 0) st.blocked++;
    }
    return st;
  }
  /* Symmetrische Bewertung aus Sicht von m (Material > Mühlen > Struktur). */
  function evalFor(S, m) {
    var A = sideStats(S.board, m), C = sideStats(S.board, other(m));
    return 30 * (A.pieces - C.pieces) + 12 * (A.mills - C.mills) + 6 * (A.dbl - C.dbl) +
      5 * (A.two - C.two) + 2 * (A.mob - C.mob) + 3 * (C.blocked - A.blocked);
  }
  function orderActs(acts) {
    acts.sort(function (a, b) { return (b.remove >= 0 ? 1 : 0) - (a.remove >= 0 ? 1 : 0); });
  }
  function lostS(S, m) { return S.placed[m] >= 9 && countOf(S.board, m) < 3; }

  function negamax(S, m, depth, alpha, beta, ply) {
    NODES++;
    if (lostS(S, m)) return -(WIN_SC - ply);
    if (S.noCap >= DRAW_LIMIT) return 0;
    var acts = genActions(S, m);
    if (!acts.length) return -(WIN_SC - ply);
    if (depth <= 0 || NODES > NODE_LIMIT) return evalFor(S, m);
    orderActs(acts);
    var best = -Infinity, i, u, v;
    for (i = 0; i < acts.length; i++) {
      u = doAct(S, m, acts[i]);
      v = -negamax(S, other(m), depth - 1, -beta, -alpha, ply + 1);
      undoAct(S, u);
      if (v > best) best = v;
      if (best > alpha) alpha = best;
      if (alpha >= beta) break;
    }
    return best;
  }
  function chooseAction(g, m, level) {
    var S = { board: g.board.slice(), placed: { W: g.placed.W, B: g.placed.B }, noCap: g.noCap };
    var acts = genActions(S, m);
    if (!acts.length) return null;
    var conf = LEVELS[level] || LEVELS[1];
    if (Math.random() < conf.rnd) return acts[Math.floor(Math.random() * acts.length)];
    NODES = 0; NODE_LIMIT = conf.limit;
    var depth = S.placed[m] < 9 ? conf.dPlace : conf.dMove;
    orderActs(acts);
    var best = -Infinity, pool = [acts[0]], alpha = -Infinity, i, u, v;
    for (i = 0; i < acts.length; i++) {
      u = doAct(S, m, acts[i]);
      v = -negamax(S, other(m), depth - 1, -Infinity, -alpha, 1);
      undoAct(S, u);
      if (v > best) { best = v; pool = [acts[i]]; alpha = v; }
      else if (v === best) pool.push(acts[i]);
    }
    return pool[Math.floor(Math.random() * pool.length)];
  }

  /* ===================== kleine Helfer ===================== */
  function sfx(n) { if (App.Audio) App.Audio.sfx(n); }
  function easeOutBack(p) { var c = 1.70158; return 1 + (c + 1) * Math.pow(p - 1, 3) + c * Math.pow(p - 1, 2); }
  function easeInOut(p) { return p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2; }
  function playerById(list, id) { var i; for (i = 0; i < list.length; i++) if (list[i].id === id) return list[i]; return null; }

  /* ===================== Registrierung ===================== */
  App.Minigames.ninemensmorris = {
    id: 'ninemensmorris', title: 'Mühle', icon: '⚪', order: 166,
    subtitle: 'Drei in einer Reihe – und ein Stein fällt',
    single: true, multi: true, minPlayers: 2, maxPlayers: 2,

    render: function (root, ctx) {
      var isMulti = ctx.mode === 'multi';

      var dead = false, timers = [], stops = [], listeners = [], raf = null, flashT = null;
      var g = null, sel = -1, hover = -1, anims = [], refs = null;
      var myMark = W, botMark = B, level = 1;
      var showingEnd = false, prevMoveNo = -1, curView = '';
      var lastShared = null, initDone = false, oppName = 'Gegner';

      function after(ms, fn) { var t = setTimeout(function () { if (!dead) fn(); }, ms); timers.push(t); return t; }
      function clearTimers() { timers.forEach(clearTimeout); timers = []; }
      function addL(t, ty, fn, o) { t.addEventListener(ty, fn, o); listeners.push({ t: t, ty: ty, fn: fn, o: o }); }
      function dropL() { listeners.forEach(function (l) { try { l.t.removeEventListener(l.ty, l.fn, l.o); } catch (e) {} }); listeners = []; }
      function addStop(f) { if (f) stops.push(f); }
      function startRaf() { if (raf == null) raf = requestAnimationFrame(frame); }
      function stopRaf() { if (raf != null) { cancelAnimationFrame(raf); raf = null; } }
      function frame() { raf = null; if (dead) return; drawAll(); raf = requestAnimationFrame(frame); }
      function cleanup() {
        dead = true;
        stopRaf(); clearTimers(); dropL();
        stops.forEach(function (f) { try { f(); } catch (e) {} }); stops = [];
      }

      if (isMulti) startMulti(); else showDifficulty();
      return { cleanup: cleanup };

      /* ============================================================
       *  Ansicht
       * ============================================================ */
      function makeChip(cls, sym, team) {
        var nameEl = el('div', { class: 'mhl-nm' }, ['—']);
        var handEl = el('span', { class: 'mhl-num' }, ['9']);
        var boardEl = el('span', { class: 'mhl-num' }, ['0']);
        var rootEl = el('div', { class: 'mhl-chip ' + cls }, [
          el('span', { class: 'mhl-sym' }, [sym]),
          el('div', { class: 'mhl-info' }, [
            nameEl,
            el('div', { class: 'mhl-mini' }, [
              el('span', { class: 'mhl-team' }, [team + ' · ']),
              'Hand ', handEl, ' · Brett ', boardEl
            ])
          ])
        ]);
        return { root: rootEl, nameEl: nameEl, handEl: handEl, boardEl: boardEl };
      }

      function buildView(wName, bName) {
        var phaseEl = el('div', { class: 'mhl-phase' }, ['Phase 1 · Setzen']);
        var top = el('div', { class: 'mhl-top' }, [el('div', { class: 'mhl-brand neon' }, ['⚪ Mühle']), phaseEl]);
        var wChip = makeChip('mhl-chip-w', SYM.W, TEAM.W);
        var bChip = makeChip('mhl-chip-b', SYM.B, TEAM.B);
        wChip.nameEl.textContent = wName; bChip.nameEl.textContent = bName;
        var statusEl = el('div', { class: 'mhl-status you' }, ['']);
        var canvas = el('canvas', { class: 'mhl-canvas', width: SIZE, height: SIZE, 'aria-label': 'Mühlebrett' });
        var stage = el('div', { class: 'mhl-stage' }, [canvas]);
        var hint = el('div', { class: 'mhl-hint hint-text' }, [
          'Antippen: Punkt wählen · 3 in einer Linie = Mühle → gegnerischen Stein klauen (Steine in Mühlen sind geschützt) · nur noch 3 Steine = frei springen'
        ]);
        var wrap = el('div', { class: 'mhl-wrap' }, [
          top, el('div', { class: 'mhl-chips' }, [wChip.root, bChip.root]), statusEl, stage, hint
        ]);
        root.innerHTML = ''; root.appendChild(wrap);
        refs = {
          phaseEl: phaseEl, statusEl: statusEl, canvas: canvas, ctx2d: canvas.getContext('2d'),
          wChip: wChip, bChip: bChip
        };
        attachPointer(canvas);
        startRaf();
      }

      function attachPointer(canvas) {
        function toIdx(clientX, clientY) {
          var r = canvas.getBoundingClientRect();
          if (!r.width || !r.height) return -1;
          var x = (clientX - r.left) / r.width * SIZE, y = (clientY - r.top) / r.height * SIZE;
          var best = -1, bd = CELL * 0.55, i, dx, dy, d;
          for (i = 0; i < 24; i++) {
            dx = x - cx(i); dy = y - cy(i); d = Math.sqrt(dx * dx + dy * dy);
            if (d < bd) { bd = d; best = i; }
          }
          return best;
        }
        addL(canvas, 'pointerdown', function (e) {
          e.preventDefault();
          var i = toIdx(e.clientX, e.clientY);
          if (i >= 0) handleClick(i);
        });
        addL(canvas, 'pointermove', function (e) {
          if (e.pointerType === 'touch') return;
          hover = toIdx(e.clientX, e.clientY);
        });
        addL(canvas, 'pointerleave', function () { hover = -1; });
      }

      /* ---------- DOM-Aktualisierung (kein Neuaufbau) ---------- */
      function paint() {
        if (!refs || !g) return;
        var placing = isPlacing(g, W) || isPlacing(g, B);
        var flying = canFly(g, W) || canFly(g, B);
        refs.phaseEl.textContent = placing ? 'Phase 1 · Setzen' : (flying ? 'Phase 2 · Ziehen & Fliegen' : 'Phase 2 · Ziehen');

        refs.wChip.handEl.textContent = String(9 - g.placed.W);
        refs.wChip.boardEl.textContent = String(countOf(g.board, W));
        refs.bChip.handEl.textContent = String(9 - g.placed.B);
        refs.bChip.boardEl.textContent = String(countOf(g.board, B));
        refs.wChip.root.classList.toggle('active', !g.winner && g.turn === W);
        refs.bChip.root.classList.toggle('active', !g.winner && g.turn === B);
        refs.wChip.root.classList.toggle('me', myMark === W);
        refs.bChip.root.classList.toggle('me', myMark === B);

        var s = statusOf();
        refs.statusEl.textContent = s.text;
        refs.statusEl.className = 'mhl-status ' + s.cls;
      }
      function statusOf() {
        if (g.winner === 'draw') return { text: '🤝 Remis — ' + DRAW_LIMIT + ' Züge ohne Mühle', cls: 'draw' };
        if (g.winner) return g.winner === myMark ? { text: '🏆 Gewonnen!', cls: 'win' } : { text: '💀 Verloren', cls: 'lose' };
        var mine = g.turn === myMark;
        if (g.mustRemove) {
          return mine ? { text: 'Mühle! 🎉 Nimm einen gegnerischen Stein', cls: 'mill' }
            : { text: oppName + ' hat eine Mühle — ein Stein von dir fällt', cls: 'lose' };
        }
        if (!mine) return { text: isMulti ? (oppName + ' ist dran …') : 'Bot denkt … 🤖', cls: 'opp' };
        if (isPlacing(g, myMark)) return { text: 'Du bist dran — setze einen Stein (' + (9 - g.placed[myMark]) + ' in der Hand)', cls: 'you' };
        if (canFly(g, myMark)) return { text: sel >= 0 ? 'Springe auf einen freien Punkt' : 'Du darfst fliegen — wähle einen Stein', cls: 'you' };
        return { text: sel >= 0 ? 'Ziel wählen (oder anderen Stein antippen)' : 'Du bist dran — wähle einen Stein', cls: 'you' };
      }
      function flashStatus(msg) {
        if (!refs) return;
        refs.statusEl.textContent = msg;
        refs.statusEl.className = 'mhl-status warn';
        refs.statusEl.classList.remove('mhl-shake'); void refs.statusEl.offsetWidth; refs.statusEl.classList.add('mhl-shake');
        if (flashT) clearTimeout(flashT);
        flashT = after(1300, function () { paint(); });
      }

      /* ---------- Sichtbare Markierungen ---------- */
      function viewLegal() {
        var out = [], i;
        if (!g || g.winner || g.turn !== myMark || g.mustRemove) return out;
        if (isPlacing(g, myMark)) { for (i = 0; i < 24; i++) if (g.board[i] === '') out.push(i); return out; }
        if (sel >= 0) return targetsFrom(g, sel);
        return out;
      }
      function viewRemovable() {
        if (!g || g.winner || g.turn !== myMark || !g.mustRemove) return [];
        return removableOf(g.board, other(myMark));
      }
      function viewMovable() {
        var out = [], i;
        if (!g || g.winner || g.turn !== myMark || g.mustRemove || isPlacing(g, myMark)) return out;
        for (i = 0; i < 24; i++) if (g.board[i] === myMark && targetsFrom(g, i).length) out.push(i);
        return out;
      }

      /* ============================================================
       *  Zeichnen (Canvas)
       * ============================================================ */
      function drawAll() {
        if (!refs || !refs.ctx2d || !g) return;
        var c = refs.ctx2d, now = Date.now(), live = [], q;
        for (q = 0; q < anims.length; q++) if (now < anims[q].t0 + anims[q].dur) live.push(anims[q]);
        anims = live;

        c.clearRect(0, 0, SIZE, SIZE);
        var bg = c.createRadialGradient(SIZE / 2, SIZE * 0.44, 30, SIZE / 2, SIZE / 2, SIZE * 0.8);
        bg.addColorStop(0, '#0b3222'); bg.addColorStop(1, '#03110a');
        c.fillStyle = bg; c.fillRect(0, 0, SIZE, SIZE);

        drawGrid(c);
        drawMills(c, now);
        var legal = viewLegal(), rem = viewRemovable(), mov = viewMovable();
        drawHints(c, now, legal);
        drawStones(c, now, rem, mov);
        drawAnims(c, now);
      }

      function drawGrid(c) {
        var k, a, z;
        var conn = [[[3, 0], [3, 2]], [[3, 4], [3, 6]], [[0, 3], [2, 3]], [[4, 3], [6, 3]]];
        c.save();
        c.lineCap = 'round'; c.lineJoin = 'round';
        c.strokeStyle = 'rgba(57,255,20,.30)'; c.lineWidth = 3.5;
        c.shadowColor = 'rgba(57,255,20,.45)'; c.shadowBlur = 9;
        for (k = 0; k < 3; k++) { a = px(k); z = px(6 - k); c.strokeRect(a, a, z - a, z - a); }
        for (k = 0; k < conn.length; k++) {
          c.beginPath();
          c.moveTo(px(conn[k][0][0]), px(conn[k][0][1]));
          c.lineTo(px(conn[k][1][0]), px(conn[k][1][1]));
          c.stroke();
        }
        c.restore();
      }

      function drawMills(c, now) {
        var mills = allMills(g.board), fresh = -1, k, L, isNew, pulse;
        if (g.op && (g.op.kind === 'place' || g.op.kind === 'move')) fresh = g.op.to;
        for (k = 0; k < mills.length; k++) {
          L = mills[k];
          isNew = fresh >= 0 && (L[0] === fresh || L[1] === fresh || L[2] === fresh);
          pulse = 0.5 + 0.5 * Math.sin(now / (isNew ? 170 : 430));
          c.save();
          c.lineCap = 'round';
          c.strokeStyle = 'rgba(255,210,63,' + (isNew ? (0.45 + 0.45 * pulse) : (0.16 + 0.1 * pulse)) + ')';
          c.lineWidth = isNew ? 9 : 6;
          c.shadowColor = 'rgba(255,210,63,.9)'; c.shadowBlur = isNew ? (16 + 14 * pulse) : 8;
          c.beginPath(); c.moveTo(cx(L[0]), cy(L[0])); c.lineTo(cx(L[2]), cy(L[2])); c.stroke();
          c.restore();
        }
      }

      function drawHints(c, now, legal) {
        var i, pulse = 0.5 + 0.5 * Math.sin(now / 300), r;
        for (i = 0; i < 24; i++) {
          if (g.board[i] !== '') continue;
          c.beginPath(); c.arc(cx(i), cy(i), 4.5, 0, 6.2832);
          c.fillStyle = 'rgba(157,255,122,.3)'; c.fill();
        }
        for (i = 0; i < legal.length; i++) {
          var p = legal[i];
          if (hover === p) {
            c.beginPath(); c.arc(cx(p), cy(p), STONE_R, 0, 6.2832);
            c.fillStyle = 'rgba(57,255,20,.16)'; c.fill();
          }
          r = 13 + 3 * pulse;
          c.save();
          c.strokeStyle = 'rgba(57,255,20,' + (0.5 + 0.35 * pulse) + ')';
          c.lineWidth = 2.5; c.shadowColor = 'rgba(57,255,20,.8)'; c.shadowBlur = 10;
          c.beginPath(); c.arc(cx(p), cy(p), r, 0, 6.2832); c.stroke();
          c.restore();
          c.beginPath(); c.arc(cx(p), cy(p), 5, 0, 6.2832);
          c.fillStyle = 'rgba(57,255,20,.55)'; c.fill();
        }
      }

      function drawStones(c, now, rem, mov) {
        var skip = {}, i, q, a;
        for (q = 0; q < anims.length; q++) {
          a = anims[q];
          if (a.kind === 'slide') skip[a.to] = 1;
          if (a.kind === 'place') skip[a.at] = 1;
        }
        for (i = 0; i < 24; i++) {
          if (!g.board[i] || skip[i]) continue;
          drawStone(c, cx(i), cy(i), g.board[i], 1, 1, now, {
            sel: sel === i, removable: rem.indexOf(i) >= 0, movable: mov.indexOf(i) >= 0
          });
        }
      }

      function drawStone(c, x, y, mark, scale, alpha, now, o) {
        var col = COL[mark] || COL.W, r = STONE_R * scale, pulse, gr;
        if (r <= 0.5) return;
        c.save();
        c.globalAlpha = alpha;
        c.beginPath(); c.arc(x, y + 3, r, 0, 6.2832); c.fillStyle = 'rgba(0,0,0,.45)'; c.fill();
        gr = c.createRadialGradient(x - r * 0.35, y - r * 0.4, r * 0.12, x, y, r);
        gr.addColorStop(0, col.hi); gr.addColorStop(0.55, col.mid); gr.addColorStop(1, col.lo);
        c.beginPath(); c.arc(x, y, r, 0, 6.2832);
        c.shadowColor = col.glow; c.shadowBlur = 14; c.fillStyle = gr; c.fill();
        c.shadowBlur = 0;
        c.lineWidth = 2; c.strokeStyle = col.edge; c.stroke();
        c.beginPath(); c.arc(x - r * 0.32, y - r * 0.36, r * 0.2, 0, 6.2832);
        c.fillStyle = 'rgba(255,255,255,.5)'; c.fill();
        if (o) {
          if (o.movable && !o.sel) {
            pulse = 0.5 + 0.5 * Math.sin(now / 420);
            c.beginPath(); c.arc(x, y, r + 5, 0, 6.2832);
            c.strokeStyle = 'rgba(157,255,122,' + (0.22 + 0.28 * pulse) + ')';
            c.lineWidth = 2; c.stroke();
          }
          if (o.sel) {
            pulse = 0.5 + 0.5 * Math.sin(now / 200);
            c.save();
            c.strokeStyle = 'rgba(255,210,63,' + (0.65 + 0.35 * pulse) + ')';
            c.lineWidth = 3; c.shadowColor = 'rgba(255,210,63,.9)'; c.shadowBlur = 12 + 8 * pulse;
            c.beginPath(); c.arc(x, y, r + 6, 0, 6.2832); c.stroke();
            c.restore();
          }
          if (o.removable) {
            pulse = 0.5 + 0.5 * Math.sin(now / 230);
            c.save();
            c.strokeStyle = 'rgba(255,77,109,' + (0.6 + 0.4 * pulse) + ')';
            c.lineWidth = 3; c.shadowColor = 'rgba(255,77,109,.9)'; c.shadowBlur = 10 + 8 * pulse;
            c.beginPath(); c.arc(x, y, r + 6, 0, 6.2832); c.stroke();
            c.restore();
            c.font = '900 22px system-ui, sans-serif';
            c.textAlign = 'center'; c.textBaseline = 'middle';
            c.fillStyle = 'rgba(255,255,255,.92)';
            c.shadowColor = 'rgba(255,77,109,1)'; c.shadowBlur = 8;
            c.fillText('✕', x, y + 1);
            c.shadowBlur = 0;
          }
        }
        c.restore();
      }

      function drawAnims(c, now) {
        var q, a, p, s, e, x, y, r;
        for (q = 0; q < anims.length; q++) {
          a = anims[q];
          p = (now - a.t0) / a.dur;
          if (p < 0) p = 0; if (p > 1) p = 1;
          if (a.kind === 'place') {
            s = easeOutBack(p);
            drawStone(c, cx(a.at), cy(a.at), a.mark, s, 1, now, null);
            c.save();
            c.globalAlpha = (1 - p) * 0.65;
            c.strokeStyle = (COL[a.mark] || COL.W).edge; c.lineWidth = 3;
            c.beginPath(); c.arc(cx(a.at), cy(a.at), STONE_R + 34 * p, 0, 6.2832); c.stroke();
            c.restore();
          } else if (a.kind === 'slide') {
            e = easeInOut(p);
            x = cx(a.from) + (cx(a.to) - cx(a.from)) * e;
            y = cy(a.from) + (cy(a.to) - cy(a.from)) * e;
            c.save();
            c.globalAlpha = (1 - p) * 0.5; c.lineCap = 'round';
            c.strokeStyle = (COL[a.mark] || COL.W).glow; c.lineWidth = 7;
            c.beginPath(); c.moveTo(cx(a.from), cy(a.from)); c.lineTo(x, y); c.stroke();
            c.restore();
            drawStone(c, x, y, a.mark, 1, 1, now, null);
          } else if (a.kind === 'remove') {
            drawStone(c, cx(a.at), cy(a.at), a.mark, 1 - 0.78 * p, 1 - p, now, null);
            r = STONE_R + 44 * p;
            c.save();
            c.strokeStyle = 'rgba(255,77,109,' + (1 - p) * 0.85 + ')';
            c.lineWidth = 3; c.shadowColor = 'rgba(255,77,109,.9)'; c.shadowBlur = 12;
            c.beginPath(); c.arc(cx(a.at), cy(a.at), r, 0, 6.2832); c.stroke();
            c.restore();
          }
        }
      }

      function pushAnim(op) {
        if (!op) return;
        var t0 = Date.now();
        if (op.kind === 'place') anims.push({ kind: 'place', at: op.to, mark: op.mark, t0: t0, dur: 300 });
        else if (op.kind === 'move') anims.push({ kind: 'slide', from: op.from, to: op.to, mark: op.mark, t0: t0, dur: 240 });
        else if (op.kind === 'remove') anims.push({ kind: 'remove', at: op.to, mark: op.mark, t0: t0, dur: 360 });
      }
      function sfxForOp(op, ng) {
        if (!op) return;
        if (op.kind === 'remove') { sfx('pop'); return; }
        if (ng.mustRemove) { sfx('powerup'); return; }
        sfx(op.kind === 'place' ? 'chip' : 'step');
      }

      /* Übernimmt einen neuen Zustand: Animation, Sound, DOM. */
      function commit(ng, push) {
        sel = -1;
        pushAnim(ng.op);
        sfxForOp(ng.op, ng);
        prevMoveNo = ng.moveNo;
        g = ng;
        if (push && isMulti) ctx.room.setShared(sharedFromG(ng));
        paint();
      }

      /* ============================================================
       *  Eingabe (Solo + Multi identisch)
       * ============================================================ */
      function handleClick(i) {
        if (dead || showingEnd || !g || g.winner || !myMark) return;
        if (g.turn !== myMark) {
          if (isMulti) UI.toast('Warte — du bist nicht dran', 'info'); else sfx('error');
          return;
        }
        var ng;
        if (g.mustRemove) {
          if (removableOf(g.board, other(myMark)).indexOf(i) >= 0) {
            ng = cloneG(g); doRemove(ng, i); commit(ng, true); afterMyTurn();
          } else {
            sfx('error');
            flashStatus(g.board[i] === other(myMark) ? 'Der Stein steckt in einer Mühle — geschützt!' : 'Wähle einen gegnerischen Stein');
          }
          return;
        }
        if (isPlacing(g, myMark)) {
          if (g.board[i] === '') { ng = cloneG(g); doPlaceMove(ng, -1, i); commit(ng, true); afterMyTurn(); }
          else { sfx('error'); flashStatus('Dieser Punkt ist schon besetzt'); }
          return;
        }
        if (g.board[i] === myMark) {
          if (sel === i) { sel = -1; sfx('click'); }
          else if (targetsFrom(g, i).length === 0) { sfx('error'); flashStatus('Der Stein ist eingeklemmt — kein freier Nachbar'); return; }
          else { sel = i; sfx('select'); }
          paint();
          return;
        }
        if (sel >= 0 && g.board[i] === '' && targetsFrom(g, sel).indexOf(i) >= 0) {
          var from = sel;
          ng = cloneG(g); doPlaceMove(ng, from, i); commit(ng, true); afterMyTurn();
          return;
        }
        sfx('error');
        flashStatus(sel < 0 ? 'Erst einen eigenen Stein wählen' : 'Dorthin kann der Stein nicht');
      }
      function afterMyTurn() {
        if (isMulti) { if (g.winner && !showingEnd) finishMulti(); return; }
        if (g.winner) return finishSolo();
        if (g.turn === botMark) scheduleBot();
      }

      /* ============================================================
       *  SOLO
       * ============================================================ */
      function showDifficulty() {
        curView = 'diff';
        stopRaf();
        var btns = LEVELS.map(function (L, idx) {
          return el('button', { class: 'mhl-lvl', type: 'button', onclick: function () { sfx('select'); level = idx; startSolo(); } }, [
            el('span', { class: 'mhl-lvl-icon' }, [L.icon]),
            el('span', { class: 'mhl-lvl-name' }, [L.name]),
            el('span', { class: 'mhl-lvl-desc' }, [L.desc])
          ]);
        });
        var best = App.Storage.get('best_ninemensmorris', 0);
        root.innerHTML = '';
        root.appendChild(el('div', { class: 'mhl-panel glass' }, [
          el('div', { class: 'mhl-wait-icon' }, ['⚪']),
          el('h2', { class: 'mhl-big neon' }, ['Mühle']),
          el('p', { class: 'mhl-sub' }, ['Setze 9 Steine, baue Mühlen und räume den Gegner ab. Du beginnst mit ' + SYM.W + ' ' + TEAM.W + '.']),
          el('div', { class: 'mhl-levels' }, btns),
          el('p', { class: 'hint-text' }, ['Bestwert: ' + App.MG.fmt(best) + ' Punkte']),
          el('div', { class: 'mhl-actions' }, [
            el('button', { class: 'btn btn-ghost', type: 'button', onclick: ctx.onExit }, ['Zurück'])
          ])
        ]));
      }

      function startSolo() {
        curView = 'game';
        clearTimers();
        showingEnd = false;
        myMark = W; botMark = B;
        g = newGame(); sel = -1; hover = -1; anims = []; prevMoveNo = 0;
        oppName = 'Bot';
        buildView('Du', 'Bot ' + LEVELS[level].icon);
        paint();
      }

      function scheduleBot() {
        after(430, function () {
          if (dead || !g || g.winner || g.turn !== botMark) return;
          var a = chooseAction(g, botMark, level);
          if (!a) return;
          var ng = cloneG(g);
          doPlaceMove(ng, a.from, a.to);
          commit(ng, false);
          if (g.mustRemove && g.turn === botMark) {
            var r = a.remove;
            if (r < 0 || g.board[r] !== myMark) {
              var list = removableOf(g.board, myMark);
              r = list.length ? list[0] : -1;
            }
            if (r < 0) return;
            after(660, function () {
              if (dead || !g || g.winner || !g.mustRemove) return;
              var n2 = cloneG(g); doRemove(n2, r); commit(n2, false);
              if (g.winner) finishSolo();
            });
          } else if (g.winner) finishSolo();
        });
      }

      function finishSolo() {
        if (showingEnd) return;
        showingEnd = true;
        var conf = LEVELS[level], s = 0;
        if (g.winner === myMark) {
          s = conf.base + 50 * Math.max(0, countOf(g.board, myMark) - 3);
          sfx('win');
          if (App.Scores) App.Scores.winCurrent();
        } else if (g.winner === 'draw') { s = Math.round(conf.base / 4); sfx('info'); }
        else sfx('lose');
        paint();
        after(1400, function () {
          stopRaf();
          var best = App.Storage.get('best_ninemensmorris', 0);
          var nb = s > best;
          if (nb) App.Storage.set('best_ninemensmorris', s);
          var head = g.winner === myMark ? '🏆 Sieg gegen ' + conf.name
            : g.winner === 'draw' ? '🤝 Remis gegen ' + conf.name : '💀 Niederlage gegen ' + conf.name;
          App.MG.endScreen(root, {
            score: s, best: best, newBest: nb,
            title: g.winner === myMark ? 'Mühle gewonnen!' : (g.winner === 'draw' ? 'Unentschieden' : 'Verloren'),
            label: head + (nb ? ' · neuer Rekord! 🎉' : ' · Bestwert: ' + App.MG.fmt(best)),
            onExit: ctx.onExit,
            onAgain: function () { showingEnd = false; showDifficulty(); }
          });
        });
      }

      /* ============================================================
       *  MULTI — Zustand komplett in room.shared
       * ============================================================ */
      function sharedFromG(x) {
        var op = x.op || { kind: '', from: -1, to: -1, mark: '' };
        return {
          board: x.board.slice(), turn: x.turn,
          placedW: x.placed.W, placedB: x.placed.B,
          mustRemove: !!x.mustRemove, noCap: x.noCap, winner: x.winner || '', moveNo: x.moveNo,
          opKind: op.kind || '', opFrom: typeof op.from === 'number' ? op.from : -1,
          opTo: typeof op.to === 'number' ? op.to : -1, opMark: op.mark || ''
        };
      }
      function normBoard(src) {
        var b = blank(), i;
        if (src) for (i = 0; i < 24; i++) if (src[i]) b[i] = src[i];
        return b;
      }
      function gFromShared(sh) {
        return {
          board: normBoard(sh.board), turn: sh.turn === B ? B : W,
          placed: { W: sh.placedW || 0, B: sh.placedB || 0 },
          mustRemove: !!sh.mustRemove, noCap: sh.noCap || 0, winner: sh.winner || '',
          moveNo: sh.moveNo || 0,
          op: sh.opKind ? {
            kind: sh.opKind,
            from: typeof sh.opFrom === 'number' ? sh.opFrom : -1,
            to: typeof sh.opTo === 'number' ? sh.opTo : -1,
            mark: sh.opMark || ''
          } : null
        };
      }
      function markOf(id, sh) {
        var i = sh && sh.order ? sh.order.indexOf(id) : -1;
        return i === 0 ? W : i === 1 ? B : null;
      }

      function startMulti() {
        var started = false;
        function maybeStart() {
          if (started || dead) return;
          if (ctx.room.players().length >= 2) {
            started = true;
            var snap = ctx.room.snapshot() || {};
            var startAt = (snap.round && snap.round.startAt) || (ctx.room.now() + 3000);
            stops.push(App.MG.countdown(root, startAt, function () { playMulti(startAt); }, ctx.room.now));
          } else showWaiting(ctx.room.players(), false);
        }
        var ph = function () { maybeStart(); };
        ctx.room.on('players', ph);
        addStop(function () { ctx.room.off('players', ph); });
        maybeStart();
      }

      function playMulti(startAt) {
        var snap = ctx.room.snapshot();
        lastShared = (snap && snap.shared) || null;
        prevMoveNo = -1; curView = ''; showingEnd = false;
        var onShared = function (sh) { if (!dead) { lastShared = sh; syncMulti(); } };
        var onPlayers = function () { if (!dead) syncMulti(); };
        ctx.room.on('shared', onShared);
        ctx.room.on('players', onPlayers);
        addStop(function () { ctx.room.off('shared', onShared); });
        addStop(function () { ctx.room.off('players', onPlayers); });
        ctx.room.reportScore(0);
        syncMulti();
      }

      /* Läuft bei JEDEM room-Event (auch Heartbeat) — muss idempotent bleiben. */
      function syncMulti() {
        if (dead || showingEnd) return;
        var players = ctx.room.players();
        if (players.length < 2) { showWaiting(players, false); return; }
        var sh = lastShared;
        if (!sh || !sh.board || !sh.order) {
          if (ctx.room.isHost() && !initDone) {
            initDone = true;
            var g0 = newGame();
            var patch = sharedFromG(g0);
            patch.order = [players[0].id, players[1].id];
            ctx.room.setShared(patch);
          } else showWaiting(players, true);
          return;
        }
        var mk = markOf(ctx.me.id, sh);
        myMark = mk || W;
        var wP = playerById(players, sh.order[0]), bP = playerById(players, sh.order[1]);
        var wName = (wP ? wP.name : 'Spieler 1') + (mk === W ? ' (du)' : '');
        var bName = (bP ? bP.name : 'Spieler 2') + (mk === B ? ' (du)' : '');
        oppName = mk === W ? (bP ? bP.name : 'Gegner') : (wP ? wP.name : 'Gegner');

        if (curView !== 'game') { curView = 'game'; anims = []; buildView(wName, bName); }
        else { refs.wChip.nameEl.textContent = wName; refs.bChip.nameEl.textContent = bName; }

        var ng = gFromShared(sh);
        if (prevMoveNo >= 0 && ng.moveNo !== prevMoveNo) { pushAnim(ng.op); sfxForOp(ng.op, ng); }
        if (!g || g.turn !== ng.turn || ng.moveNo !== prevMoveNo) sel = -1;
        prevMoveNo = ng.moveNo;
        g = ng;
        paint();
        if (g.winner && !showingEnd) finishMulti();
      }

      function finishMulti() {
        if (showingEnd) return;
        showingEnd = true;
        var iWon = g.winner === myMark;
        ctx.room.reportScore(iWon ? 1 : 0);
        if (iWon) { sfx('win'); if (App.Scores) App.Scores.winCurrent(); }
        else sfx(g.winner === 'draw' ? 'info' : 'lose');
        paint();
        after(1500, function () {
          stopRaf();
          App.MG.endScreen(root, {
            players: ctx.room.players(), meId: ctx.me.id,
            title: g.winner === 'draw' ? '🤝 Remis' : '🏁 Partie vorbei',
            onExit: ctx.onExit
          });
        });
      }

      function showWaiting(players, starting) {
        if (curView !== 'wait') {
          curView = 'wait';
          stopRaf();
          var count = el('div', { class: 'mhl-big neon' }, ['1 / 2']);
          var msg = el('p', { class: 'mhl-sub' }, ['']);
          refs = null;
          root.innerHTML = '';
          root.appendChild(el('div', { class: 'mhl-panel glass' }, [
            el('div', { class: 'mhl-wait-icon' }, ['⚪']),
            el('h2', { class: 'mhl-big neon' }, ['Mühle']),
            count, msg,
            el('div', { class: 'mhl-actions' }, [
              el('button', { class: 'btn btn-ghost', type: 'button', onclick: ctx.onExit }, ['Zurück zur Lobby'])
            ])
          ]));
          waitRefs = { count: count, msg: msg };
        }
        waitRefs.count.textContent = players.length + ' / 2';
        waitRefs.msg.textContent = starting ? 'Brett wird aufgebaut …' : 'Warte auf den zweiten Spieler …';
      }
      var waitRefs = null;
    }
  };

  /* ===================== STYLES ===================== */
  function injectStyle() {
    UI.injectStyle('mg-ninemensmorris-css', [
      '.mhl-wrap{display:flex;flex-direction:column;gap:10px;max-width:520px;margin:0 auto;}',
      '.mhl-top{display:flex;justify-content:space-between;align-items:center;gap:10px;}',
      '.mhl-brand{font-weight:900;font-size:18px;}',
      '.mhl-phase{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:1.4px;font-weight:800;}',
      '.mhl-chips{display:flex;gap:8px;}',
      '.mhl-chip{flex:1;min-width:0;display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:14px;',
      'background:rgba(9,32,21,.6);border:1px solid var(--stroke);transition:border-color .15s,box-shadow .15s;}',
      '.mhl-chip .mhl-sym{font-size:20px;line-height:1;filter:drop-shadow(0 0 6px rgba(0,0,0,.55));}',
      '.mhl-chip .mhl-info{flex:1;min-width:0;display:flex;flex-direction:column;line-height:1.2;}',
      '.mhl-chip .mhl-nm{font-weight:800;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      '.mhl-chip .mhl-mini{font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.6px;',
      'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      /* Auf schmalen Handys hat der Team-Name im Chip keinen Platz -> nur Hand/Brett. */
      '@media (max-width:460px){.mhl-chip .mhl-team{display:none;}}',
      '.mhl-chip .mhl-num{font-weight:900;font-variant-numeric:tabular-nums;}',
      '.mhl-chip-w .mhl-num{color:var(--neon);}',
      '.mhl-chip-b .mhl-num{color:var(--aqua);}',
      '.mhl-chip.me .mhl-nm{color:var(--aqua-soft);}',
      '.mhl-chip.active{border-color:var(--neon);box-shadow:0 0 0 1px var(--neon),0 0 16px rgba(57,255,20,.3);}',
      '.mhl-chip.active .mhl-sym{animation:mhl-bob .9s ease-in-out infinite;}',
      '@keyframes mhl-bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-3px)}}',
      '.mhl-status{text-align:center;font-weight:900;font-size:clamp(14px,3.9vw,18px);min-height:24px;line-height:1.25;transition:color .15s;}',
      '.mhl-status.you{color:var(--neon);text-shadow:0 0 10px rgba(57,255,20,.4);}',
      '.mhl-status.opp{color:var(--aqua);}',
      '.mhl-status.mill{color:var(--gold);text-shadow:0 0 12px rgba(255,210,63,.55);}',
      '.mhl-status.win{color:var(--gold);text-shadow:0 0 14px rgba(255,210,63,.6);}',
      '.mhl-status.lose{color:var(--danger);}',
      '.mhl-status.draw{color:var(--aqua-soft);}',
      '.mhl-status.warn{color:var(--danger-2);}',
      '.mhl-shake{animation:mhl-shake .3s ease;}',
      '@keyframes mhl-shake{0%,100%{transform:translateX(0)}25%{transform:translateX(-6px)}75%{transform:translateX(6px)}}',
      '.mhl-stage{width:100%;max-width:480px;margin:0 auto;aspect-ratio:1 / 1;}',
      '.mhl-canvas{display:block;width:100%;height:100%;border-radius:18px;border:2px solid rgba(57,255,20,.34);',
      'background:#03110a;box-shadow:0 0 40px rgba(57,255,20,.2),inset 0 0 60px rgba(57,255,20,.06);',
      'touch-action:none;user-select:none;-webkit-user-select:none;-webkit-tap-highlight-color:transparent;cursor:pointer;}',
      '.mhl-hint{text-align:center;font-size:11px;line-height:1.4;}',
      '.mhl-panel{padding:26px 20px;text-align:center;display:flex;flex-direction:column;gap:12px;align-items:center;max-width:480px;margin:0 auto;}',
      '.mhl-big{font-size:clamp(26px,7vw,38px);font-weight:900;line-height:1.1;margin:0;}',
      '.mhl-sub{color:var(--muted);margin:0;font-size:13px;}',
      '.mhl-wait-icon{font-size:46px;filter:drop-shadow(0 0 12px rgba(57,255,20,.5));animation:mhl-float 2.4s ease-in-out infinite;}',
      '@keyframes mhl-float{0%,100%{transform:translateY(0)}50%{transform:translateY(-7px)}}',
      '.mhl-levels{display:flex;flex-direction:column;gap:8px;width:100%;max-width:340px;}',
      '.mhl-lvl{display:grid;grid-template-columns:34px 1fr;grid-template-rows:auto auto;gap:0 10px;align-items:center;',
      'padding:10px 14px;border-radius:14px;background:rgba(9,32,21,.66);border:1px solid var(--stroke);',
      'color:var(--text,#eaffe2);font-family:inherit;cursor:pointer;text-align:left;transition:transform .12s,border-color .15s,box-shadow .15s;}',
      '.mhl-lvl:hover{border-color:var(--neon);box-shadow:0 0 18px rgba(57,255,20,.28);transform:translateY(-2px);}',
      '.mhl-lvl:active{transform:scale(.98);}',
      '.mhl-lvl-icon{grid-row:1 / span 2;font-size:26px;line-height:1;}',
      '.mhl-lvl-name{font-weight:900;font-size:15px;color:var(--leaf);}',
      '.mhl-lvl-desc{font-size:11px;color:var(--muted);}',
      '.mhl-actions{display:flex;gap:10px;justify-content:center;flex-wrap:wrap;margin-top:4px;}'
    ].join(''));
  }
})();
