/* mancala.js — "Kalaha" (Mancala): das uralte Saatspiel im Neon-Dschungel-Look.
 *
 * SPIELIDEE
 *   Zwei Reihen mit je 6 Mulden, in jeder Mulde 4 Steine. Links und rechts steht
 *   je ein Kalaha (Speicher). Man nimmt alle Steine EINER eigenen Mulde und
 *   verteilt sie gegen den Uhrzeigersinn einzeln in die folgenden Mulden — der
 *   eigene Speicher wird mitbesät, der gegnerische immer übersprungen.
 *     - Letzter Stein im EIGENEN Speicher  -> man ist gleich nochmal dran.
 *     - Letzter Stein in einer LEEREN eigenen Mulde -> dieser Stein plus alle
 *       gegenüberliegenden gegnerischen Steine wandern in den eigenen Speicher.
 *     - Ist eine Reihe leer, räumt der andere Spieler seine restlichen Steine
 *       in seinen Speicher ab. Wer dann mehr Steine hat, gewinnt (48 gesamt).
 *
 * STEUERUNG
 *   Die eigene Reihe ist IMMER die untere (die Ansicht wird für Spieler 2
 *   gedreht). Tippen/Klicken auf eine leuchtende Mulde sät ihre Steine.
 *
 * PUNKTE
 *   Solo: Steine im eigenen Speicher x10, plus Sieg-Bonus, mal Schwierigkeits-
 *   Faktor (Leicht 1.0 / Mittel 1.6 / Schwer 2.4). Bestwert in 'best_mancala'.
 *   Multi: die gemeldete Punktzahl ist der eigene Speicherstand -> Podest.
 *
 * SYNC-MODELL (Multiplayer, rundenbasiert über room.shared)
 *   shared = { order:[idP1,idP2], pits:[14 Zahlen], turn:<playerId>, seq:n,
 *              move:{ pre:[14], pit, side, seq }, over:bool, winner:id|'draw' }
 *   Wer am Zug ist, rechnet den Zug lokal (die Logik ist deterministisch) und
 *   schreibt Ergebnis + Vorzustand ('move.pre') mit erhöhtem 'seq'. Beide Seiten
 *   animieren aus 'move.pre' heraus denselben Zug und landen exakt auf 'pits'.
 *   Ein bereits gesehener 'seq' wird ignoriert -> die alle 4 s feuernden
 *   Heartbeat-Events sind idempotent und bauen die Ansicht nie neu auf.
 *
 * Alle Timer/Animationen laufen über Wall-Clock (Date.now), rAF zeichnet nur.
 * cleanup() stoppt rAF, alle Timeouts und meldet jeden room.on(...) wieder ab. */
(function () {
  'use strict';
  window.App = window.App || {}; App.Minigames = App.Minigames || {};
  var UI = App.UI, el = UI.el;

  injectStyle();

  /* ============================ REGELN / LOGIK ============================ */
  var SEEDS = 4;                  // Startsteine pro Mulde
  var STORE_A = 6, STORE_B = 13;  // Speicher-Indizes
  var TOTAL = 48;                 // 12 Mulden x 4 Steine
  var TAU = Math.PI * 2;

  /* Brett = Array mit 14 Feldern:
     0..5   = Mulden Spieler A (unten)      6  = Speicher A (rechts)
     7..12  = Mulden Spieler B (oben)      13  = Speicher B (links)
     Gegenüber von Mulde i ist immer 12 - i. */
  function freshPits() {
    var p = [], i;
    for (i = 0; i < 14; i++) p.push(SEEDS);
    p[STORE_A] = 0; p[STORE_B] = 0;
    return p;
  }
  function sideLo(side) { return side === 0 ? 0 : 7; }
  function storeOf(side) { return side === 0 ? STORE_A : STORE_B; }
  function rowEmpty(p, side) {
    var lo = sideLo(side), i;
    for (i = lo; i < lo + 6; i++) if (p[i] > 0) return false;
    return true;
  }
  function legalMoves(p, side) {
    var lo = sideLo(side), r = [], i;
    for (i = lo; i < lo + 6; i++) if (p[i] > 0) r.push(i);
    return r;
  }

  /* Der komplette Zug als reine Funktion (mutiert 'pits' nicht).
     Rückgabe: { pits, path, again, capture, sweep, over } */
  function sow(pits, side, pit) {
    if (pit < sideLo(side) || pit > sideLo(side) + 5) return null;
    var p = pits.slice(), n = p[pit];
    if (n <= 0) return null;
    var store = storeOf(side), skip = storeOf(1 - side);
    var path = [], idx = pit, i;
    p[pit] = 0;
    while (n > 0) {
      idx = (idx + 1) % 14;
      if (idx === skip) continue;      // gegnerischer Speicher wird übersprungen
      p[idx]++; n--; path.push(idx);
    }
    var last = path[path.length - 1];
    var again = (last === store);
    var capture = null;

    /* Letzter Stein in einer bis dahin leeren EIGENEN Mulde -> erobern */
    var lo = sideLo(side);
    if (!again && last >= lo && last <= lo + 5 && p[last] === 1) {
      var opp = 12 - last;
      if (p[opp] > 0) {
        capture = { from: last, opp: opp, gained: p[opp] + 1 };
        p[store] += p[opp] + 1;
        p[opp] = 0; p[last] = 0;
      }
    }

    /* Eine Reihe leer -> der andere räumt seine Steine ab, Partie vorbei */
    var sweep = null;
    var e0 = rowEmpty(p, 0), e1 = rowEmpty(p, 1);
    if (e0 || e1) {
      var sSide = e0 ? 1 : 0, sLo = sideLo(sSide), sStore = storeOf(sSide);
      var list = [], sum = 0;
      for (i = sLo; i < sLo + 6; i++) { if (p[i] > 0) { sum += p[i]; list.push(i); } p[i] = 0; }
      p[sStore] += sum;
      sweep = { from: list, to: sStore, total: sum };
      again = false;
    }
    return { pits: p, path: path, again: again, capture: capture, sweep: sweep, over: !!sweep };
  }

  function winnerSide(p) { return p[STORE_A] > p[STORE_B] ? 0 : (p[STORE_B] > p[STORE_A] ? 1 : -1); }

  /* ============================ BOT: MINIMAX ============================ */
  var LEVELS = {
    leicht: { key: 'leicht', label: 'Leicht', icon: '🌱', depth: 1, noise: 0.55, ms: 420, mul: 1.0, hint: 'Der Bot spielt oft aus dem Bauch heraus.' },
    mittel: { key: 'mittel', label: 'Mittel', icon: '🌿', depth: 3, noise: 0.15, ms: 480, mul: 1.6, hint: 'Der Bot schaut 3 Züge voraus und nimmt Extra-Züge mit.' },
    schwer: { key: 'schwer', label: 'Schwer', icon: '🐍', depth: 5, noise: 0, ms: 540, mul: 2.4, hint: 'Minimax mit Tiefe 5 — plant Ketten und Eroberungen.' }
  };

  function evalBoard(p, me) {
    var mySt = p[storeOf(me)], opSt = p[storeOf(1 - me)];
    var myRow = 0, opRow = 0, lo = sideLo(me), lo2 = sideLo(1 - me), i;
    for (i = 0; i < 6; i++) { myRow += p[lo + i]; opRow += p[lo2 + i]; }
    var s = (mySt - opSt) * 8 + (myRow - opRow);
    if (mySt > TOTAL / 2) s += 400;          // uneinholbar
    if (opSt > TOTAL / 2) s -= 400;
    return s;
  }
  function finalScore(p, me) {
    var mySt = p[storeOf(me)], opSt = p[storeOf(1 - me)];
    return (mySt - opSt) * 8 + (mySt > opSt ? 1200 : (mySt < opSt ? -1200 : 0));
  }
  /* Minimax mit Alpha-Beta. Extra-Züge behalten die Seite bei, kosten aber
     ebenfalls eine Tiefe -> garantiert endliche Rekursion. */
  function search(p, side, me, depth, alpha, beta) {
    if (rowEmpty(p, 0) || rowEmpty(p, 1)) return finalScore(p, me);
    if (depth <= 0) return evalBoard(p, me);
    var moves = legalMoves(p, side);
    if (!moves.length) return finalScore(p, me);
    var maxing = (side === me), best = maxing ? -Infinity : Infinity, i, r, v;
    for (i = 0; i < moves.length; i++) {
      r = sow(p, side, moves[i]);
      v = search(r.pits, r.again ? side : 1 - side, me, depth - 1, alpha, beta);
      if (maxing) { if (v > best) best = v; if (best > alpha) alpha = best; }
      else { if (v < best) best = v; if (best < beta) beta = best; }
      if (beta <= alpha) break;
    }
    return best;
  }
  function botMove(p, side, levelKey) {
    var moves = legalMoves(p, side);
    if (!moves.length) return -1;
    var cfg = LEVELS[levelKey] || LEVELS.schwer;
    if (cfg.noise > 0 && Math.random() < cfg.noise) return moves[Math.floor(Math.random() * moves.length)];
    var best = -Infinity, ties = [], i, r, v;
    for (i = 0; i < moves.length; i++) {
      r = sow(p, side, moves[i]);
      v = search(r.pits, r.again ? side : 1 - side, side, cfg.depth - 1, -Infinity, Infinity);
      if (v > best + 0.0001) { best = v; ties = [moves[i]]; }
      else if (v > best - 0.0001) ties.push(moves[i]);
    }
    return ties[Math.floor(Math.random() * ties.length)];
  }

  /* ============================ GEOMETRIE ============================ */
  /* Virtuelles Brett; das Canvas skaliert per CSS mit.
     Anzeige-Index 0..5 = untere Reihe (ich), 6 = mein Speicher rechts,
     7..12 = obere Reihe (rechts nach links), 13 = Gegner-Speicher links. */
  var VW = 740, VH = 360;
  var PIT_R = 40, PIT_X0 = 156, PIT_DX = 88, ROW_TOP = 90, ROW_BOT = 270;
  var ST_W = 82, ST_H = 244, ST_CY = 180, ST_L_CX = 60, ST_R_CX = 680;

  function geo(d) {
    if (d === 6) return { store: true, cx: ST_R_CX, cy: ST_CY, w: ST_W, h: ST_H };
    if (d === 13) return { store: true, cx: ST_L_CX, cy: ST_CY, w: ST_W, h: ST_H };
    if (d <= 5) return { store: false, cx: PIT_X0 + d * PIT_DX, cy: ROW_BOT, r: PIT_R };
    return { store: false, cx: PIT_X0 + (12 - d) * PIT_DX, cy: ROW_TOP, r: PIT_R };
  }
  function center(d) { var g = geo(d); return { x: g.cx, y: g.store ? g.cy + 26 : g.cy }; }
  /* Ansicht drehen: die eigene Reihe liegt immer unten. */
  function toDisp(i, mySide) { return mySide === 0 ? i : (i + 7) % 14; }
  function fromDisp(d, mySide) { return mySide === 0 ? d : (d + 7) % 14; }

  /* Deterministisches Pseudo-Zufalls-Streumuster -> Steine zappeln nicht. */
  function hash01(a, b) { var x = Math.sin(a * 127.1 + b * 311.7) * 43758.5453; return x - Math.floor(x); }
  function stonePos(d, k) {
    var g = geo(d), ang, rad;
    if (g.store) {
      ang = hash01(d * 7 + 1, k) * TAU;
      rad = Math.sqrt(hash01(d * 13 + 2, k));
      return { x: g.cx + Math.cos(ang) * rad * (g.w / 2 - 13), y: g.cy + 30 + Math.sin(ang) * rad * 60 };
    }
    ang = hash01(d + 3, k) * TAU;
    rad = 17 + hash01(d + 41, k) * 15;     // Ring um das Zahlen-Plättchen herum
    return { x: g.cx + Math.cos(ang) * rad, y: g.cy + Math.sin(ang) * rad };
  }
  var STONE_COLS = [
    ['#c9ffa6', '#39ff14'], ['#a8f2e8', '#33e6d0'],
    ['#ffe9a3', '#ffd23f'], ['#e2ffcc', '#7dff5e']
  ];
  function colOf(d, k) { return STONE_COLS[Math.floor(hash01(d * 5 + 7, k) * STONE_COLS.length) % STONE_COLS.length]; }
  function ease(t) { return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t; }

  /* ============================ ZEICHNEN ============================ */
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
  function drawStone(g, x, y, r, cols, glow) {
    var grd = g.createRadialGradient(x - r * 0.36, y - r * 0.42, r * 0.14, x, y, r);
    grd.addColorStop(0, cols[0]); grd.addColorStop(1, cols[1]);
    if (glow) { g.shadowColor = cols[1]; g.shadowBlur = glow; }
    g.fillStyle = grd;
    g.beginPath(); g.arc(x, y, r, 0, TAU); g.fill();
    g.shadowBlur = 0;
  }
  function drawScene(g, sc) {
    var t = sc.t, d, i;
    g.clearRect(0, 0, VW, VH);

    /* Brett */
    var bg = g.createLinearGradient(0, 0, 0, VH);
    bg.addColorStop(0, '#07301f'); bg.addColorStop(0.5, '#05200f'); bg.addColorStop(1, '#02110a');
    roundRect(g, 3, 3, VW - 6, VH - 6, 32);
    g.fillStyle = bg; g.fill();
    g.lineWidth = 2; g.strokeStyle = 'rgba(57,255,20,.26)'; g.stroke();

    /* Laufrichtung als dezenter Pfeil-Ring */
    g.save();
    g.globalAlpha = 0.16; g.lineWidth = 2; g.setLineDash([9, 13]);
    g.strokeStyle = 'rgba(51,230,208,.9)';
    g.lineDashOffset = -(t / 26) % 22;
    roundRect(g, 116, 40, VW - 232, VH - 80, 90);
    g.stroke();
    g.restore();

    for (d = 0; d < 14; d++) drawSlot(g, d, sc);
    for (i = 0; i < sc.fly.length; i++) drawStone(g, sc.fly[i].x, sc.fly[i].y, 7, sc.fly[i].c, 12);
    if (sc.hand) drawHand(g, sc.hand);
  }
  function drawSlot(g, d, sc) {
    var gg = geo(d), n = sc.disp[fromDisp(d, sc.mySide)] || 0, i, p;
    var mine = (d <= 6);
    var hot = sc.hl.indexOf(d) >= 0;
    var pulse = 0.5 + 0.5 * Math.sin(sc.t / 340);
    var accent = mine ? '57,255,20' : '51,230,208';

    if (gg.store) {
      var x = gg.cx - gg.w / 2, y = gg.cy - gg.h / 2;
      roundRect(g, x, y, gg.w, gg.h, 40);
      var sg = g.createLinearGradient(0, y, 0, y + gg.h);
      sg.addColorStop(0, 'rgba(2,12,7,.95)'); sg.addColorStop(1, 'rgba(6,30,18,.95)');
      g.fillStyle = sg; g.fill();
      g.lineWidth = 2;
      g.strokeStyle = mine ? 'rgba(255,210,63,.7)' : 'rgba(51,230,208,.5)';
      g.stroke();
      /* Beschriftung + Zahl */
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.font = 'bold 10px sans-serif';
      g.fillStyle = 'rgba(123,166,146,.95)';
      g.fillText(mine ? 'DU' : 'GEGNER', gg.cx, y + 22);      // kurz halten: passt in die Speicher-Breite
      g.font = 'bold 34px sans-serif';
      g.fillStyle = mine ? '#ffd23f' : '#7ff3e6';
      g.shadowColor = mine ? 'rgba(255,210,63,.7)' : 'rgba(51,230,208,.6)';
      g.shadowBlur = 14;
      g.fillText(String(n), gg.cx, y + 52);
      g.shadowBlur = 0;
      for (i = 0; i < Math.min(n, 26); i++) { p = stonePos(d, i); drawStone(g, p.x, p.y, 6, colOf(d, i), 0); }
      return;
    }

    /* Mulde */
    g.beginPath(); g.arc(gg.cx, gg.cy, gg.r, 0, TAU);
    var pg = g.createRadialGradient(gg.cx, gg.cy - 10, 4, gg.cx, gg.cy, gg.r);
    pg.addColorStop(0, 'rgba(1,9,5,.98)'); pg.addColorStop(1, 'rgba(9,38,23,.95)');
    g.fillStyle = pg; g.fill();
    g.lineWidth = hot ? 3 : 2;
    if (hot) { g.shadowColor = 'rgba(57,255,20,.9)'; g.shadowBlur = 10 + pulse * 20; }
    g.strokeStyle = hot ? 'rgba(57,255,20,' + (0.75 + pulse * 0.25) + ')' : 'rgba(' + accent + ',.3)';
    g.stroke(); g.shadowBlur = 0;

    for (i = 0; i < Math.min(n, 22); i++) { p = stonePos(d, i); drawStone(g, p.x, p.y, 7, colOf(d, i), 0); }

    /* Zahlen-Plättchen in der Mitte */
    g.beginPath(); g.arc(gg.cx, gg.cy, 13, 0, TAU);
    g.fillStyle = 'rgba(2,10,6,.88)'; g.fill();
    g.lineWidth = 1; g.strokeStyle = 'rgba(' + accent + ',.35)'; g.stroke();
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.font = 'bold 15px sans-serif';
    g.fillStyle = n === 0 ? 'rgba(123,166,146,.6)' : (mine ? '#c9ffa6' : '#a8f2e8');
    g.fillText(String(n), gg.cx, gg.cy + 1);
  }
  function drawHand(g, h) {
    g.beginPath(); g.arc(h.x, h.y, 15, 0, TAU);
    g.fillStyle = 'rgba(3,14,8,.92)'; g.fill();
    g.lineWidth = 2; g.strokeStyle = 'rgba(255,210,63,.85)';
    g.shadowColor = 'rgba(255,210,63,.8)'; g.shadowBlur = 16; g.stroke(); g.shadowBlur = 0;
    drawStone(g, h.x, h.y - 1, 7, STONE_COLS[2], 10);
    if (h.n > 1) {
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.font = 'bold 11px sans-serif';
      g.fillStyle = '#ffd23f';
      g.fillText('x' + h.n, h.x, h.y + 24);
    }
  }

  /* ============================ DOM-BAUSTEINE ============================ */
  function buildStage(oppLabel, meLabel, levelLabel) {
    var oppNm = el('div', { class: 'mnc-nm' }, [oppLabel]);
    var oppSc = el('div', { class: 'mnc-sc' }, ['0']);
    var oppChip = el('div', { class: 'mnc-chip mnc-chip-opp' }, [
      el('span', { class: 'mnc-av' }, ['🙂']),
      el('div', { class: 'mnc-info' }, [oppNm, el('div', { class: 'mnc-mini' }, ['obere Reihe'])]),
      oppSc
    ]);
    var meNm = el('div', { class: 'mnc-nm' }, [meLabel]);
    var meSc = el('div', { class: 'mnc-sc mnc-sc-me' }, ['0']);
    var meChip = el('div', { class: 'mnc-chip mnc-chip-me' }, [
      el('span', { class: 'mnc-av' }, ['🫵']),
      el('div', { class: 'mnc-info' }, [meNm, el('div', { class: 'mnc-mini' }, ['untere Reihe'])]),
      meSc
    ]);
    var statusEl = el('div', { class: 'mnc-status you' }, ['']);
    var canvas = el('canvas', { class: 'mnc-canvas' });
    var wrap = el('div', { class: 'mnc-wrap' }, [
      el('div', { class: 'mnc-top' }, [
        el('div', { class: 'mnc-brand neon' }, ['🫘 Kalaha']),
        levelLabel ? el('span', { class: 'chip mnc-lvl' }, [levelLabel]) : null
      ]),
      el('div', { class: 'mnc-chips' }, [oppChip, meChip]),
      statusEl,
      el('div', { class: 'mnc-stage glass' }, [canvas]),
      el('p', { class: 'hint-text mnc-rules' }, [
        '↺ Gegen den Uhrzeigersinn säen · eigener Speicher zählt mit, der gegnerische wird übersprungen · ' +
        'letzter Stein im eigenen Speicher = nochmal dran · letzter Stein in eigener leerer Mulde = erobern'
      ])
    ]);
    return {
      root: wrap, canvas: canvas, statusEl: statusEl,
      oppChip: oppChip, oppNm: oppNm, oppSc: oppSc,
      meChip: meChip, meNm: meNm, meSc: meSc
    };
  }

  /* ============================ SPIEL ============================ */
  App.Minigames.mancala = {
    id: 'mancala', title: 'Kalaha', icon: '🫘', order: 105,
    subtitle: 'Säe Steine, erobere den Speicher des Gegners',
    single: true, multi: true, minPlayers: 2, maxPlayers: 2,

    render: function (root, ctx) {
      var dead = false, timers = [], stops = [], raf = null;

      /* Ansicht + Spielzustand */
      var refs = null, g2d = null;
      var mySide = 0, pits = freshPits(), turn = 0, over = false;
      var anim = null;                       // laufende Säe-Animation
      var meLabel = 'Du', oppLabel = 'Gegner';
      var noteTxt = '', noteCls = '';
      var lastMeSc = -1, lastOppSc = -1;

      function after(ms, fn) { var id = setTimeout(function () { if (!dead) fn(); }, ms); timers.push(id); return id; }
      function clearTimers() { timers.forEach(clearTimeout); timers = []; }
      function stopAll() { stops.forEach(function (f) { try { f(); } catch (e) {} }); stops = []; }
      function stopLoop() { if (raf) { cancelAnimationFrame(raf); raf = null; } }
      function cleanup() { dead = true; clearTimers(); stopAll(); stopLoop(); }

      if (ctx.mode === 'multi' && ctx.room) startMulti(); else startSolo();
      return { cleanup: cleanup };

      /* ===================== Animation ===================== */
      /* Baut aus einem sow()-Ergebnis den kompletten Ablauf:
         Säen (Stein für Stein) -> ggf. Erobern -> ggf. Abräumen. Alles rein
         zeitgesteuert, damit jeder Frame den Zustand neu ableiten kann. */
      function makeAnim(prePits, side, srcPit, res, startAt) {
        var n = res.path.length, i, q;
        var stepMs = Math.max(70, Math.min(140, 1100 / Math.max(1, n)));
        var sowEnd = n * stepMs;
        var sowPits = prePits.slice();
        sowPits[srcPit] = 0;
        for (i = 0; i < n; i++) sowPits[res.path[i]]++;

        var phases = [], base = sowPits, cursor = sowEnd, store = storeOf(side);
        var capT0 = -1, sweepT0 = -1;

        if (res.capture) {
          var cs = [{ d: res.capture.from, k: 0 }];
          for (i = 0; i < base[res.capture.opp]; i++) cs.push({ d: res.capture.opp, k: i });
          var cRes = base.slice();
          cRes[res.capture.from] = 0; cRes[res.capture.opp] = 0;
          cRes[store] = base[store] + cs.length;
          capT0 = cursor + 220;
          phases.push(mkPhase(capT0, 34, 380, cs, store, base, cRes));
          base = cRes; cursor = phases[phases.length - 1].end;
        }
        if (res.sweep && res.sweep.from.length) {
          var ss = [], sRes = base.slice();
          for (q = 0; q < res.sweep.from.length; q++) {
            var pd = res.sweep.from[q];
            for (i = 0; i < base[pd]; i++) ss.push({ d: pd, k: i });
            sRes[pd] = 0;
          }
          sRes[res.sweep.to] = base[res.sweep.to] + ss.length;
          sweepT0 = cursor + 260;
          phases.push(mkPhase(sweepT0, 26, 420, ss, res.sweep.to, base, sRes));
          base = sRes; cursor = phases[phases.length - 1].end;
        }
        return {
          src: srcPit, side: side, path: res.path, stepMs: stepMs, startAt: startAt, sowEnd: sowEnd,
          prePits: prePits.slice(), sowPits: sowPits, phases: phases,
          resultPits: res.pits.slice(), doneAt: cursor + 220,
          capT0: capT0, sweepT0: sweepT0, again: res.again,
          sndDrop: 0, sndCap: false, sndSweep: false, onDone: null
        };
      }
      function mkPhase(t0, stag, dur, stones, toIdx, base, result) {
        return {
          t0: t0, stag: stag, dur: dur, stones: stones, toIdx: toIdx,
          base: base.slice(), result: result.slice(),
          end: t0 + stag * Math.max(0, stones.length - 1) + dur
        };
      }
      /* Eine Flug-Phase (Erobern/Abräumen) zu einem Zeitpunkt auswerten. */
      function phaseAt(ph, t) {
        var disp = ph.base.slice(), fly = [], k, s, dd, p0, p1, pr, e, arrived = 0;
        if (t <= ph.t0) return { disp: disp, fly: fly };
        if (t >= ph.end) return { disp: ph.result.slice(), fly: fly };
        var to = center(toDisp(ph.toIdx, mySide));
        for (k = 0; k < ph.stones.length; k++) disp[ph.stones[k].d] = 0;
        for (k = 0; k < ph.stones.length; k++) {
          s = ph.stones[k];
          dd = toDisp(s.d, mySide);
          p0 = stonePos(dd, s.k);
          pr = (t - (ph.t0 + k * ph.stag)) / ph.dur;
          if (pr >= 1) { arrived++; continue; }
          if (pr < 0) pr = 0;
          e = ease(pr);
          p1 = { x: p0.x + (to.x - p0.x) * e, y: p0.y + (to.y - p0.y) * e - Math.sin(pr * Math.PI) * 30 };
          fly.push({ x: p1.x, y: p1.y, c: colOf(dd, s.k) });
        }
        disp[ph.toIdx] = ph.base[ph.toIdx] + arrived;
        return { disp: disp, fly: fly };
      }
      /* Kompletter Anzeige-Zustand für den Zeitpunkt 'now'. */
      function animSnapshot(now) {
        if (!anim) return { disp: pits, hand: null, fly: [], done: true, dropped: -1 };
        var t = now - anim.startAt, n = anim.path.length, i;
        if (t >= anim.doneAt) return { disp: anim.resultPits, hand: null, fly: [], done: true, dropped: n };
        if (t < anim.sowEnd) {
          var disp = anim.prePits.slice();
          disp[anim.src] = 0;
          var dropped = Math.floor(t / anim.stepMs);
          if (dropped < 0) dropped = 0;
          if (dropped > n) dropped = n;
          for (i = 0; i < dropped; i++) disp[anim.path[i]]++;
          var hand = null;
          if (dropped < n) {
            var pr = (t - dropped * anim.stepMs) / anim.stepMs;
            if (pr < 0) pr = 0; if (pr > 1) pr = 1;
            var a = center(toDisp(dropped === 0 ? anim.src : anim.path[dropped - 1], mySide));
            var b = center(toDisp(anim.path[dropped], mySide));
            var e = ease(pr);
            hand = { x: a.x + (b.x - a.x) * e, y: a.y + (b.y - a.y) * e - Math.sin(pr * Math.PI) * 26, n: n - dropped };
          }
          return { disp: disp, hand: hand, fly: [], done: false, dropped: dropped };
        }
        var cur = anim.sowPits, j;
        for (j = 0; j < anim.phases.length; j++) {
          if (t < anim.phases[j].end) {
            var r = phaseAt(anim.phases[j], t);
            return { disp: r.disp, hand: null, fly: r.fly, done: false, dropped: n };
          }
          cur = anim.phases[j].result;
        }
        return { disp: cur, hand: null, fly: [], done: false, dropped: n };
      }
      function stepSounds(snap, now) {
        if (!anim || !App.Audio) return;
        var d = snap.dropped, i, t = now - anim.startAt;
        if (d > anim.sndDrop) {
          if (d - anim.sndDrop <= 3) {
            for (i = anim.sndDrop; i < d; i++) App.Audio.blip(500 + (i % 6) * 55, 0.06, { type: 'sine', peak: 0.05 });
          }
          anim.sndDrop = d;
        }
        if (!anim.sndCap && anim.capT0 >= 0 && t >= anim.capT0) { anim.sndCap = true; App.Audio.sfx('coin'); }
        if (!anim.sndSweep && anim.sweepT0 >= 0 && t >= anim.sweepT0) { anim.sndSweep = true; App.Audio.sfx('cashout'); }
      }

      /* ===================== Render-Schleife ===================== */
      function startLoop() { stopLoop(); raf = requestAnimationFrame(frame); }
      function frame() {
        raf = null;
        if (dead) return;
        raf = requestAnimationFrame(frame);
        var now = Date.now();
        var snap = animSnapshot(now);
        if (anim) {
          stepSounds(snap, now);
          if (snap.done) { var cb = anim.onDone; anim = null; if (cb) cb(); return; }
        }
        paint(snap, now);
      }
      function paint(snap, now) {
        if (!g2d || !refs) return;
        var a = snap.disp[storeOf(mySide)] || 0, b = snap.disp[storeOf(1 - mySide)] || 0;
        if (a !== lastMeSc) { lastMeSc = a; refs.meSc.textContent = String(a); }
        if (b !== lastOppSc) { lastOppSc = b; refs.oppSc.textContent = String(b); }
        var hl = (!anim && !over && turn === mySide)
          ? legalMoves(pits, mySide).map(function (i) { return toDisp(i, mySide); })
          : [];
        drawScene(g2d, { disp: snap.disp, mySide: mySide, hl: hl, hand: snap.hand, fly: snap.fly, t: now });
      }

      /* ===================== Brett einhängen ===================== */
      function mountBoard(levelLabel, onPit) {
        anim = null; lastMeSc = -1; lastOppSc = -1; noteTxt = '';
        refs = buildStage(oppLabel, meLabel, levelLabel);
        root.innerHTML = ''; root.appendChild(refs.root);
        var dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
        refs.canvas.width = Math.round(VW * dpr);
        refs.canvas.height = Math.round(VH * dpr);
        g2d = refs.canvas.getContext('2d');
        g2d.setTransform(dpr, 0, 0, dpr, 0, 0);
        var cv = refs.canvas;      // fest halten: 'refs' wechselt bei Neuaufbau
        var onDown = function (e) {
          if (e.preventDefault) e.preventDefault();
          var d = hitTest(cv, e.clientX, e.clientY);
          if (d >= 0) onPit(d);
        };
        cv.addEventListener('pointerdown', onDown);
        stops.push(function () { try { cv.removeEventListener('pointerdown', onDown); } catch (err) {} });
        startLoop();
        updateChrome();
      }
      /* Großzügige Trefferzone: die nächste Mulde der unteren Reihe. */
      function hitTest(canvas, clientX, clientY) {
        var r = canvas.getBoundingClientRect();
        if (!r.width || !r.height) return -1;
        var vx = (clientX - r.left) / r.width * VW;
        var vy = (clientY - r.top) / r.height * VH;
        if (Math.abs(vy - ROW_BOT) > PIT_R + 22) return -1;
        var d, bd = -1, bdx = 1e9, dx;
        for (d = 0; d <= 5; d++) {
          dx = Math.abs(vx - (PIT_X0 + d * PIT_DX));
          if (dx < bdx) { bdx = dx; bd = d; }
        }
        return bdx <= PIT_DX / 2 ? bd : -1;
      }

      function setNote(txt, cls) {
        noteTxt = txt; noteCls = cls; updateChrome();
        after(2000, function () { if (noteTxt === txt) { noteTxt = ''; noteCls = ''; updateChrome(); } });
      }
      function updateChrome() {
        if (!refs) return;
        var meTurn = (turn === mySide);
        refs.meChip.classList.toggle('active', meTurn && !over && !anim);
        refs.oppChip.classList.toggle('active', !meTurn && !over && !anim);
        var txt, cls;
        if (over) { txt = 'Partie vorbei'; cls = 'draw'; }
        else if (anim) { txt = (anim.side === mySide ? 'Du säst …' : oppLabel + ' sät …'); cls = 'sow'; }
        else if (meTurn) { txt = 'Du bist dran — wähle eine Mulde'; cls = 'you'; }
        else { txt = oppLabel + ' ist dran …'; cls = 'opp'; }
        if (noteTxt) txt = over ? noteTxt : noteTxt + ' · ' + txt;
        refs.statusEl.textContent = txt;
        refs.statusEl.className = 'mnc-status ' + (noteTxt && noteCls ? noteCls : cls);
      }
      /* Rückmeldung nach einem beendeten Zug. */
      function reactTo(res, side) {
        if (res.over) return;
        if (res.again) setNote(side === mySide ? '↻ Speicher getroffen — nochmal du!' : '↻ ' + oppLabel + ' ist nochmal dran', 'cap');
        else if (res.capture) setNote((side === mySide ? '💰 Erobert: +' : '💥 ' + oppLabel + ' erobert: +') + res.capture.gained, side === mySide ? 'cap' : 'lose');
        if (res.again && side === mySide && App.Audio) App.Audio.sfx('powerup');
      }

      /* =========================================================
       *  SOLO — gegen den Minimax-Bot
       * ========================================================= */
      function startSolo() {
        showLevelPick(App.Storage.get('mancala_level', 'schwer'));
      }
      function showLevelPick(sel) {
        stopLoop(); clearTimers();
        var keys = ['leicht', 'mittel', 'schwer'];
        var hintEl = el('p', { class: 'hint-text mnc-lvlhint' }, [(LEVELS[sel] || LEVELS.schwer).hint]);
        var btns = keys.map(function (k) {
          var L = LEVELS[k];
          return el('button', {
            class: 'btn ' + (k === sel ? 'btn-primary' : 'btn-ghost') + ' mnc-lvlbtn', type: 'button',
            onmouseenter: function () { hintEl.textContent = L.hint; },
            onclick: function () {
              if (App.Audio) App.Audio.sfx('click');
              App.Storage.set('mancala_level', k);
              newSolo(k);
            }
          }, [el('span', { class: 'mnc-lvlicon' }, [L.icon]), L.label]);
        });
        root.innerHTML = '';
        root.appendChild(el('div', { class: 'mnc-panel glass' }, [
          el('div', { class: 'mnc-wait-icon' }, ['🫘']),
          el('h2', { class: 'neon mnc-big' }, ['Kalaha']),
          el('p', { class: 'mnc-sub' }, ['Wer am Ende die meisten der 48 Steine im eigenen Speicher hat, gewinnt.']),
          el('div', { class: 'mnc-levels' }, btns),
          hintEl,
          el('p', { class: 'hint-text' }, ['Bestwert: ' + App.MG.fmt(App.Storage.get('best_mancala', 0))]),
          el('div', { class: 'mnc-actions' }, [
            el('button', { class: 'btn btn-ghost', type: 'button', onclick: ctx.onExit }, ['Zurück'])
          ])
        ]));
      }
      function newSolo(levelKey) {
        clearTimers();
        var cfg = LEVELS[levelKey] || LEVELS.schwer;
        mySide = 0; pits = freshPits(); turn = 0; over = false;
        meLabel = (ctx.me && ctx.me.name) ? ctx.me.name : 'Du';
        oppLabel = 'Bot ' + cfg.icon;
        mountBoard(cfg.icon + ' ' + cfg.label, function (d) {
          if (dead || over || anim || turn !== mySide) return;
          var pit = fromDisp(d, mySide);
          if (!pits[pit]) { if (App.Audio) App.Audio.sfx('error'); return; }
          if (App.Audio) App.Audio.sfx('select');
          doSoloMove(mySide, pit);
        });

        function doSoloMove(side, pit) {
          var pre = pits.slice();
          var res = sow(pre, side, pit);
          if (!res) return;
          anim = makeAnim(pre, side, pit, res, Date.now());
          anim.onDone = function () {
            pits = res.pits.slice();
            over = !!res.over;
            if (!over) turn = res.again ? side : 1 - side;
            updateChrome();
            reactTo(res, side);
            if (over) { after(1000, finishSolo); return; }
            if (turn === 1) scheduleBot();
          };
          updateChrome();
        }
        function scheduleBot() {
          after(cfg.ms, function () {
            if (dead || over || anim || turn !== 1) return;
            var m = botMove(pits, 1, levelKey);
            if (m >= 0) doSoloMove(1, m);
          });
        }
        function finishSolo() {
          if (dead) return;
          stopLoop();
          var mine = pits[STORE_A], his = pits[STORE_B];
          var w = winnerSide(pits);
          var win = (w === 0), draw = (w === -1);
          if (win && App.Scores) App.Scores.winCurrent();
          if (App.Audio) App.Audio.sfx(win ? 'win' : (draw ? 'ding' : 'lose'));
          var score = Math.round((mine * 10 + (win ? 250 : (draw ? 80 : 0))) * cfg.mul);
          var best = App.Storage.get('best_mancala', 0);
          var nb = score > best;
          if (nb) App.Storage.set('best_mancala', score);
          App.MG.endScreen(root, {
            score: score, best: best, newBest: nb,
            title: win ? '🏆 Gewonnen!' : (draw ? '🤝 Unentschieden' : '💀 Verloren'),
            label: mine + ' : ' + his + ' Steine · ' + cfg.icon + ' ' + cfg.label +
              (nb ? ' · neuer Rekord! 🎉' : ' · Bestwert: ' + App.MG.fmt(best)),
            onExit: ctx.onExit,
            onAgain: function () { showLevelPick(levelKey); }
          });
        }
      }

      /* =========================================================
       *  MULTI — Zustand liegt in room.shared, beide animieren gleich
       * ========================================================= */
      function startMulti() {
        var snap = ctx.room.snapshot() || {};
        var startAt = (snap.round && snap.round.startAt) || (ctx.room.now() + 3000);
        stops.push(App.MG.countdown(root, startAt, function () { playMulti(); }, ctx.room.now));
      }
      function playMulti() {
        var room = ctx.room, me = ctx.me;
        var lastShared = (room.snapshot() && room.snapshot().shared) || null;
        var view = null, lastSeq = -1, initDone = false, lastReported = -1;
        var waitRefs = null;

        var onShared = function (sh) { if (dead) return; lastShared = sh; sync(); };
        var onPlayers = function () { if (dead) return; sync(); };
        room.on('shared', onShared);
        room.on('players', onPlayers);
        stops.push(function () { room.off('shared', onShared); room.off('players', onPlayers); });
        sync();

        function pById(ps, id) { var i; for (i = 0; i < ps.length; i++) if (ps[i].id === id) return ps[i]; return null; }

        function sync() {
          var ps = room.players();
          if (ps.length < 2) { showWait(ps, false); return; }
          var sh = lastShared;
          if (!sh || !sh.pits || !sh.order) {
            if (room.isHost() && !initDone) {
              initDone = true;
              room.setShared({
                order: [ps[0].id, ps[1].id], pits: freshPits(), turn: ps[0].id,
                seq: 0, move: null, over: false, winner: null
              });
              return;
            }
            showWait(ps, true); return;
          }
          var idx = sh.order.indexOf(me.id);
          if (idx < 0) { showWait(ps, true); return; }
          mySide = idx;
          if (sh.over && view === 'end') return;              // Endscreen steht schon
          if (!sh.over && view === 'end') { view = null; lastSeq = -1; }   // Revanche
          ensureBoard(ps, sh);
          handleShared(sh);
        }

        function ensureBoard(ps, sh) {
          var meP = pById(ps, sh.order[mySide]), opP = pById(ps, sh.order[1 - mySide]);
          meLabel = (meP ? meP.name : 'Du') + ' (du)';
          oppLabel = opP ? opP.name : 'Gegner';
          if (view !== 'game') { view = 'game'; mountBoard(null, onPitClick); }
          refs.meNm.textContent = meLabel;
          refs.oppNm.textContent = oppLabel;
        }

        function handleShared(sh) {
          var seq = sh.seq || 0;
          if (seq > lastSeq) {
            lastSeq = seq;
            if (sh.move && sh.move.pre && sh.move.pre.length === 14) {
              var pre = sh.move.pre.slice();
              var res = sow(pre, sh.move.side, sh.move.pit);
              if (res) { runAnim(pre, sh.move.side, sh.move.pit, res); return; }
            }
            settle();
            return;
          }
          if (!anim) settle(); else updateChrome();          // Heartbeat: idempotent
        }

        function runAnim(pre, side, pit, res) {
          anim = makeAnim(pre, side, pit, res, Date.now());
          anim.onDone = function () { settle(); reactTo(res, side); };
          updateChrome();
        }

        function settle() {
          var sh = lastShared;
          if (!sh || !sh.pits || !sh.order) return;
          pits = sh.pits.slice();
          over = !!sh.over;
          turn = over ? -1 : sh.order.indexOf(sh.turn);
          updateChrome();
          var v = pits[storeOf(mySide)];
          if (v !== lastReported) { lastReported = v; room.reportScore(v); }
          if (over) scheduleEnd();
        }

        function onPitClick(d) {
          var sh = lastShared;
          if (dead || anim || !sh || !sh.pits || sh.over) return;
          if (sh.order.indexOf(sh.turn) !== mySide) { UI.toast('Warte — du bist nicht dran', 'info'); return; }
          var pit = fromDisp(d, mySide);
          if (!sh.pits[pit]) { if (App.Audio) App.Audio.sfx('error'); return; }
          var pre = sh.pits.slice();
          var res = sow(pre, mySide, pit);
          if (!res) return;
          var seq = (sh.seq || 0) + 1;
          var nextSide = (res.over || res.again) ? mySide : 1 - mySide;
          var wSide = res.over ? winnerSide(res.pits) : -2;
          var patch = {
            pits: res.pits, seq: seq, move: { pre: pre, pit: pit, side: mySide, seq: seq },
            turn: sh.order[nextSide], over: !!res.over,
            winner: res.over ? (wSide < 0 ? 'draw' : sh.order[wSide]) : null
          };
          lastSeq = seq;                                     // eigenen Zug nicht doppelt animieren
          lastShared = Object.assign({}, sh, patch);
          room.setShared(patch);
          if (App.Audio) App.Audio.sfx('select');
          runAnim(pre, mySide, pit, res);
        }

        function doRematch() {
          var sh = lastShared;
          if (!sh || !sh.order) return;
          room.setShared({
            pits: freshPits(), turn: sh.order[0], seq: (sh.seq || 0) + 1,
            move: null, over: false, winner: null
          });
        }

        function scheduleEnd() {
          if (view === 'end') return;
          view = 'end';
          var sh = lastShared;
          var iWon = (sh.winner === me.id);
          if (iWon && App.Scores) App.Scores.winCurrent();
          if (App.Audio) App.Audio.sfx(iWon ? 'win' : (sh.winner === 'draw' ? 'ding' : 'lose'));
          after(1400, function () {
            if (dead) return;
            stopLoop();
            App.MG.endScreen(root, {
              players: room.players(), meId: me.id,
              title: sh.winner === 'draw' ? '🤝 Unentschieden' : '🏁 Partie vorbei',
              onExit: ctx.onExit,
              onAgain: room.isHost() ? doRematch : null
            });
          });
        }

        function showWait(ps, starting) {
          if (view !== 'wait') {
            view = 'wait'; stopLoop(); refs = null; g2d = null;
            var cnt = el('div', { class: 'mnc-big neon' }, ['1 / 2']);
            var msg = el('p', { class: 'mnc-sub' }, ['']);
            waitRefs = { cnt: cnt, msg: msg };
            root.innerHTML = '';
            root.appendChild(el('div', { class: 'mnc-panel glass' }, [
              el('div', { class: 'mnc-wait-icon' }, ['🫘']),
              el('h2', { class: 'neon' }, ['Kalaha']),
              cnt, msg,
              el('div', { class: 'mnc-actions' }, [
                el('button', { class: 'btn btn-ghost', type: 'button', onclick: ctx.onExit }, ['Zurück zur Lobby'])
              ])
            ]));
          }
          waitRefs.cnt.textContent = ps.length + ' / 2';
          waitRefs.msg.textContent = starting ? 'Brett wird aufgebaut …' : 'Warte auf den zweiten Spieler …';
        }
      }
    }
  };

  /* ===================== STYLES ===================== */
  function injectStyle() {
    UI.injectStyle('mg-mancala-css', [
      '.mnc-wrap{display:flex;flex-direction:column;gap:12px;max-width:760px;margin:0 auto;}',
      '.mnc-top{display:flex;justify-content:space-between;align-items:center;gap:10px;}',
      '.mnc-brand{font-weight:900;font-size:18px;}',
      '.mnc-lvl{font-size:11px;font-weight:800;letter-spacing:1px;text-transform:uppercase;}',
      /* Spieler-Chips */
      '.mnc-chips{display:flex;gap:10px;}',
      '.mnc-chip{flex:1;min-width:0;display:flex;align-items:center;gap:9px;padding:8px 12px;border-radius:14px;',
      'background:rgba(9,32,21,.6);border:1px solid var(--stroke);transition:border-color .15s,box-shadow .2s;}',
      '.mnc-chip .mnc-av{font-size:20px;line-height:1;filter:drop-shadow(0 0 6px rgba(0,0,0,.5));}',
      '.mnc-chip .mnc-info{flex:1;min-width:0;display:flex;flex-direction:column;line-height:1.15;}',
      '.mnc-nm{font-weight:800;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      '.mnc-mini{font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;}',
      '.mnc-sc{font-size:24px;font-weight:900;color:var(--aqua);font-variant-numeric:tabular-nums;min-width:32px;text-align:right;}',
      '.mnc-sc-me{color:var(--gold);}',
      '.mnc-chip-me .mnc-nm{color:var(--leaf);}',
      '.mnc-chip.active{border-color:var(--neon);box-shadow:0 0 0 1px var(--neon),0 0 18px rgba(57,255,20,.32);}',
      '.mnc-chip.active .mnc-av{animation:mnc-bob .9s ease-in-out infinite;}',
      '@keyframes mnc-bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-3px)}}',
      /* Statuszeile */
      '.mnc-status{text-align:center;font-weight:900;font-size:clamp(14px,3.8vw,18px);min-height:24px;transition:color .15s;}',
      '.mnc-status.you{color:var(--neon);text-shadow:0 0 10px rgba(57,255,20,.4);}',
      '.mnc-status.opp{color:var(--aqua);}',
      '.mnc-status.sow{color:var(--leaf);}',
      '.mnc-status.cap{color:var(--gold);text-shadow:0 0 12px rgba(255,210,63,.5);}',
      '.mnc-status.lose{color:var(--danger);}',
      '.mnc-status.draw{color:var(--silver);}',
      /* Brett */
      '.mnc-stage{padding:8px;border-radius:22px;overflow:hidden;}',
      '.mnc-canvas{display:block;width:100%;max-width:744px;height:auto;margin:0 auto;border-radius:16px;',
      'touch-action:manipulation;user-select:none;-webkit-user-select:none;-webkit-tap-highlight-color:transparent;cursor:pointer;}',
      '.mnc-rules{text-align:center;font-size:12px;line-height:1.5;margin:0;}',
      /* Panels (Level-Wahl / Warten) */
      '.mnc-panel{padding:28px 22px;text-align:center;display:flex;flex-direction:column;gap:12px;align-items:center;max-width:480px;margin:0 auto;}',
      '.mnc-big{font-size:clamp(26px,8vw,40px);font-weight:900;line-height:1.1;margin:0;}',
      '.mnc-sub{color:var(--muted);margin:0;}',
      '.mnc-wait-icon{font-size:52px;line-height:1;filter:drop-shadow(0 0 14px rgba(57,255,20,.45));animation:mnc-float 2.4s ease-in-out infinite;}',
      '@keyframes mnc-float{0%,100%{transform:translateY(0) rotate(-6deg)}50%{transform:translateY(-8px) rotate(6deg)}}',
      '.mnc-levels{display:flex;gap:8px;flex-wrap:wrap;justify-content:center;margin-top:4px;}',
      '.mnc-lvlbtn{display:flex;align-items:center;gap:7px;}',
      '.mnc-lvlicon{font-size:17px;line-height:1;}',
      '.mnc-lvlhint{margin:0;min-height:32px;font-size:12px;}',
      '.mnc-actions{display:flex;gap:10px;justify-content:center;flex-wrap:wrap;margin-top:4px;}'
    ].join(''));
  }
})();
