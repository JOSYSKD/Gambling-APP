/* gomoku.js — "Fünf in einer Reihe" (Gomoku) auf einem 15x15-Neon-Gitter.
 *
 * SPIELIDEE : Zwei Spieler setzen abwechselnd Steine auf die Kreuzungen des
 *             Gitters. Wer zuerst fünf eigene Steine in einer Reihe hat
 *             (waagrecht, senkrecht oder diagonal), gewinnt die Runde. Die
 *             Siegerreihe leuchtet golden auf, der letzte Zug ist markiert.
 *             Ranke 🌿 (neongrün) beginnt, Blüte 🌺 (pink) zieht danach.
 *
 * STEUERUNG : Maus  — über eine Kreuzung fahren (Vorschau), klicken = setzen.
 *             Handy — antippen setzt einen Zielkreis (mit Lupe), zweites
 *                     Antippen derselben Kreuzung oder "✓ Setzen" bestätigt.
 *             Tasten— Pfeiltasten bewegen den Zielkreis, Enter/Leer setzt.
 *
 * PUNKTE    : SOLO gegen den Bot. Sieg = Grundpunkte je Stufe (400/1100/2400)
 *             + Zeitbonus (max. 600, schrumpft 3/Sekunde) + Effizienzbonus
 *             (30 je Stein unter 42). Unentschieden = ein Viertel der
 *             Grundpunkte, Niederlage = 0. Bestwert in App.Storage
 *             ('best_gomoku'). MULTI: Best of 3 — jede gewonnene Runde ist
 *             ein Punkt (room.reportScore), danach Podest via App.MG.endScreen.
 *
 * SYNC      : Rundenbasiert über room.shared. Der ziehende Spieler schreibt
 *             seinen Zug selbst per room.setShared({board,turn,...}) — das
 *             Brett ist ein 225-Zeichen-String ('0' leer, '1' Ranke, '2' Blüte),
 *             also klein und ohne Array-Fallen. Beide Clients rendern nur aus
 *             'shared'; die Ansicht wird EINMAL gebaut und danach nur noch
 *             in-place aktualisiert (die room-Events feuern per Heartbeat sehr
 *             oft — alle Handler sind idempotent). Nur der Host schaltet nach
 *             einer beendeten Runde weiter (Guard pendingAdvanceRound).
 *
 * BOT       : Bewertet jede Kandidaten-Kreuzung über Muster-Fenster (9 Zeichen
 *             je Richtung): Fünf > offener Vierer > Vierer > offener Dreier >
 *             gebrochener Dreier > … Angriff + gewichtete Verteidigung, Bonus
 *             für Doppel-Drohungen, Mitte als Stichentscheid. Stufe 1 spielt
 *             mit Anfänger-Blick (übersieht leise Drohungen), Stufe 3 sucht
 *             zusätzlich erzwungene Siege über Vierer-Ketten (VCF) und schleift
 *             die Auswahl mit 2 Halbzügen Vorausschau nach.
 *             cleanup() beendet wirklich alles. */
(function () {
  'use strict';
  window.App = window.App || {}; App.Minigames = App.Minigames || {};
  var UI = App.UI, el = UI.el;

  injectStyle();

  /* ===================== Konstanten ===================== */
  var N = 15, CELLS = N * N, CENTER = 112;      // 112 = Mitte (7/7)
  var EMPTY = '0', P1 = '1', P2 = '2';          // Brett-Zeichen
  var VS = 608, PAD = 24, CELL = 40, SR = 15.5; // virtuelle Canvas-Maße
  var WIN_TARGET = 2, MAX_ROUNDS = 3;           // Multiplayer: Best of 3
  var COLS = 'ABCDEFGHIJKLMNO';
  var DIRS = [[0, 1], [1, 0], [1, 1], [1, -1]];
  var STARS = [[3, 3], [3, 11], [11, 3], [11, 11], [7, 7]];

  /* def   = Gewicht der Verteidigung. Bewusst < 1: Wer am Zug ist, soll bei
   *         gleich starken Drohungen lieber die eigene Reihe bauen — sonst
   *         blocken sich zwei Bots gegenseitig bis das Brett voll ist.
   * dull  = Anfänger-Blick: leise Drohungen (unter dem offenen Vierer) werden
   *         stark abgewertet, d. h. offene Dreier werden oft übersehen.
   * sharp = erkennt offene Vierer sofort (setzen bzw. blocken).
   * deep  = rechnet zusätzlich die beste Gegner-Antwort mit. */
  var LEVELS = [
    { name: 'Ranke', icon: '🌱', label: 'Leicht', desc: 'Baut lieber eigene Reihen — übersieht auch mal was.', def: 0.45, noise: 9000, radius: 1, deep: false, sharp: false, dull: true, base: 400 },
    { name: 'Jaguar', icon: '🐆', label: 'Mittel', desc: 'Blockt deine Dreier und legt Doppel-Drohungen.', def: 0.85, noise: 300, radius: 2, deep: false, sharp: true, dull: false, base: 1100 },
    { name: 'Anaconda', icon: '🐍', label: 'Schwer', desc: 'Rechnet deine Antwort mit — verzeiht keinen Fehler.', def: 0.85, noise: 80, radius: 2, deep: true, sharp: true, dull: false, base: 2400 }
  ];

  /* ===================== reine Brett-Logik ===================== */
  function emptyBoard() { var s = '', i; for (i = 0; i < CELLS; i++) s += EMPTY; return s; }
  function setAt(b, i, ch) { return b.substring(0, i) + ch + b.substring(i + 1); }
  function rowOf(i) { return Math.floor(i / N); }
  function colOf(i) { return i % N; }
  function idxOf(r, c) { return r * N + c; }
  function coordName(i) { return COLS.charAt(colOf(i)) + (rowOf(i) + 1); }
  function boardFull(b) { return b.indexOf(EMPTY) < 0; }

  /* Liefert die komplette Reihe (>= 5 Steine) durch i oder null. */
  function winRun(b, i, ch) {
    var r = rowOf(i), c = colOf(i), d, dr, dc, k, rr, cc, run;
    for (d = 0; d < DIRS.length; d++) {
      dr = DIRS[d][0]; dc = DIRS[d][1];
      run = [i];
      for (k = 1; k < N; k++) {
        rr = r - dr * k; cc = c - dc * k;
        if (rr < 0 || rr >= N || cc < 0 || cc >= N || b.charAt(idxOf(rr, cc)) !== ch) break;
        run.unshift(idxOf(rr, cc));
      }
      for (k = 1; k < N; k++) {
        rr = r + dr * k; cc = c + dc * k;
        if (rr < 0 || rr >= N || cc < 0 || cc >= N || b.charAt(idxOf(rr, cc)) !== ch) break;
        run.push(idxOf(rr, cc));
      }
      if (run.length >= 5) return run;
    }
    return null;
  }

  /* ===================== Bot: Musterbewertung ===================== */
  /* Muster-Fenster: 'p' eigener Stein, 'o' gegnerisch, '.' leer, 'x' Rand. */
  var PATS = [
    { v: 1000000, s: ['ppppp'] },                                  // fünf = Sieg
    { v: 150000, s: ['.pppp.'] },                                  // offener Vierer = nicht mehr zu stoppen
    { v: 12000, s: ['.pppp', 'pppp.', 'pp.pp', 'p.ppp', 'ppp.p'] },// Vierer / Lücken-Vierer = erzwingt Block
    { v: 8000, s: ['.ppp.'] },                                     // offener Dreier
    { v: 6500, s: ['.p.pp.', '.pp.p.'] },                          // gebrochener offener Dreier
    { v: 900, s: ['.ppp', 'ppp.', 'p.pp', 'pp.p'] },               // gedeckelter Dreier
    { v: 700, s: ['.pp.'] },                                       // offener Zweier
    { v: 500, s: ['.p.p.'] },
    { v: 120, s: ['.pp', 'pp.', 'p.p'] },
    { v: 40, s: ['.p.'] },
    { v: 12, s: ['.p', 'p.'] }
  ];
  function matchScore(w) {
    var i, j, s;
    for (i = 0; i < PATS.length; i++) {
      s = PATS[i].s;
      for (j = 0; j < s.length; j++) if (w.indexOf(s[j]) >= 0) return PATS[i].v;
    }
    return 0;
  }
  /* 9-Zeichen-Fenster um (r,c) in Richtung (dr,dc), Mitte = eigener Stein. */
  function windowStr(b, r, c, dr, dc, p) {
    var s = '', k, rr, cc, v;
    for (k = -4; k <= 4; k++) {
      if (k === 0) { s += 'p'; continue; }
      rr = r + dr * k; cc = c + dc * k;
      if (rr < 0 || rr >= N || cc < 0 || cc >= N) { s += 'x'; continue; }
      v = b.charAt(idxOf(rr, cc));
      s += (v === p ? 'p' : (v === EMPTY ? '.' : 'o'));
    }
    return s;
  }
  /* Wert der Kreuzung i, wenn dort ein Stein von p landet. */
  function scoreCell(b, i, p) {
    var r = rowOf(i), c = colOf(i), d, v, total = 0, big = 0;
    for (d = 0; d < DIRS.length; d++) {
      v = matchScore(windowStr(b, r, c, DIRS[d][0], DIRS[d][1], p));
      total += v;
      if (v >= 6000) big++;
    }
    if (big >= 2) total += 40000;   // Doppel-Drohung: zwei Reihen gleichzeitig
    return total;
  }
  /* Kleiner Bonus zur Brettmitte (max. 112). Bewusst NICHT in scoreCell: dort
   * werden feste Schwellen (Fünf, offener Vierer) verglichen. Er wirkt nur als
   * Stichentscheid — ohne ihn gewinnt bei Gleichstand der kleinste Index, also
   * systematisch die Ecke oben links. */
  function centerBias(i) { return (14 - (Math.abs(rowOf(i) - 7) + Math.abs(colOf(i) - 7))) * 8; }

  function hasNeighbour(b, r, c, rad) {
    var dr, dc, rr, cc;
    for (dr = -rad; dr <= rad; dr++) for (dc = -rad; dc <= rad; dc++) {
      if (dr === 0 && dc === 0) continue;
      rr = r + dr; cc = c + dc;
      if (rr < 0 || rr >= N || cc < 0 || cc >= N) continue;
      if (b.charAt(idxOf(rr, cc)) !== EMPTY) return true;
    }
    return false;
  }
  function candidates(b, rad) {
    var out = [], r, c, i, any = false;
    for (i = 0; i < CELLS; i++) if (b.charAt(i) !== EMPTY) { any = true; break; }
    if (!any) return [CENTER];
    for (r = 0; r < N; r++) for (c = 0; c < N; c++) {
      i = idxOf(r, c);
      if (b.charAt(i) === EMPTY && hasNeighbour(b, r, c, rad)) out.push(i);
    }
    if (!out.length) for (i = 0; i < CELLS; i++) if (b.charAt(i) === EMPTY) { out.push(i); break; }
    return out;
  }
  function topBy(list, key) {
    var i, best = null;
    for (i = 0; i < list.length; i++) if (!best || list[i][key] > best[key]) best = list[i];
    return best;
  }
  /* Stärkste Drohung, die p auf dem Brett b noch aufbauen kann (Vorausschau). */
  function bestReply(b, p, rad) {
    var cands = candidates(b, rad), i, v, best = 0;
    for (i = 0; i < cands.length; i++) {
      v = scoreCell(b, cands[i], p);
      if (v > best) best = v;
    }
    return best;
  }
  /* Alle Felder, auf denen p sofort fünf hätte. */
  function winCells(b, p) {
    var c = candidates(b, 2), out = [], i;
    for (i = 0; i < c.length; i++) if (scoreCell(b, c[i], p) >= 1000000) out.push(c[i]);
    return out;
  }
  /* VCF ("Victory by Continuous Fours"): Sucht einen erzwungenen Sieg über eine
   * Kette von Vierern. Jeder Vierer zwingt den Gegner zum Block — die Suche
   * verzweigt darum kaum und findet trotzdem tiefe Gewinnfolgen. Genau das
   * lässt Stufe 3 gefährlich wirken: Wer eine Lücke lässt, verliert sofort. */
  function findVCF(b, me, opp, depth) {
    var cands = candidates(b, 2), i, b2, b3, blocks, r;
    for (i = 0; i < cands.length; i++) if (scoreCell(b, cands[i], me) >= 1000000) return cands[i];
    if (depth <= 0) return -1;
    for (i = 0; i < cands.length; i++) {
      if (scoreCell(b, cands[i], me) < 12000) continue;      // nur forcierende Züge
      b2 = setAt(b, cands[i], me);
      blocks = winCells(b2, me);                              // wo hätte ich die Fünf?
      if (!blocks.length) continue;                           // war doch kein Vierer
      if (blocks.length >= 2) return cands[i];                // offener Vierer -> nicht blockbar
      b3 = setAt(b2, blocks[0], opp);                         // Gegner MUSS blocken
      if (winCells(b3, opp).length) continue;                 // Gegenvierer bricht die Kette
      r = findVCF(b3, me, opp, depth - 1);
      if (r >= 0) return cands[i];
    }
    return -1;
  }

  /* Bester Gegenzug von p (schnelle Heuristik, ohne Vorausschau) — für die
   * 2-Halbzug-Bewertung von Stufe 3. */
  function counterMove(b, p, o, rad) {
    var cands = candidates(b, rad), i, v, best = -1, bv = -Infinity;
    for (i = 0; i < cands.length; i++) {
      v = scoreCell(b, cands[i], p) + scoreCell(b, cands[i], o) * 0.85;
      if (v > bv) { bv = v; best = cands[i]; }
    }
    return best;
  }
  function pickMove(b, me, opp, level) {
    var cfg = LEVELS[level], cands = candidates(b, cfg.radius);
    if (!cands.length) return -1;
    var scored = [], i, a, d, best;
    for (i = 0; i < cands.length; i++) {
      a = scoreCell(b, cands[i], me);
      d = scoreCell(b, cands[i], opp);
      if (cfg.dull && d < 150000) d *= 0.35;   // Anfänger übersieht leise Drohungen
      scored.push({ i: cands[i], a: a, d: d, v: a + d * cfg.def + centerBias(cands[i]) + Math.random() * cfg.noise });
    }
    scored.sort(function (x, y) { return y.v - x.v; });

    best = topBy(scored, 'a'); if (best && best.a >= 1000000) return best.i;   // selbst gewinnen
    best = topBy(scored, 'd'); if (best && best.d >= 1000000) return best.i;   // gegnerische Fünf blocken
    if (cfg.sharp) {
      best = topBy(scored, 'a'); if (best && best.a >= 150000) return best.i;  // eigener offener Vierer
      best = topBy(scored, 'd'); if (best && best.d >= 150000) return best.i;  // gegnerischen offenen Vierer blocken
    }
    if (!cfg.deep) return scored[0].i;

    /* Erzwungener Sieg über eine Vierer-Kette? Dann sofort einleiten. */
    var vcf = findVCF(b, me, opp, 5);
    if (vcf >= 0) return vcf;

    /* Stufe 3: echte 2-Halbzug-Bewertung. Für die besten Kandidaten wird der
     * beste Gegenzug gesetzt und DANN die Stellung bewertet. Genau so fallen
     * Doppel-Drohungen auf: Wenn meine Drohung den besten Block des Gegners
     * überlebt, ist der Zug gewinnend. (Reines Abziehen der Gegner-Drohung
     * würde die Verteidigung doppelt zählen und den Bot passiv machen.) */
    var top = scored.slice(0, 8), pick = top[0].i, bv = -Infinity, v2, b2, b3, rep;
    for (i = 0; i < top.length; i++) {
      b2 = setAt(b, top[i].i, me);
      rep = counterMove(b2, opp, me, cfg.radius);          // bester Block/Aufbau des Gegners
      b3 = rep < 0 ? b2 : setAt(b2, rep, opp);
      /* Grundlage bleibt die bewährte Bewertung; die Vorausschau schleift sie
       * nur nach (Faktor 0.35). Ersetzt man sie ganz, verliert der Bot die
       * Verteidigungs-Information und spielt schlechter als Stufe 2. */
      v2 = top[i].v + (bestReply(b3, me, cfg.radius) - bestReply(b3, opp, cfg.radius) * 0.8) * 0.35;
      if (v2 > bv) { bv = v2; pick = top[i].i; }
    }
    return pick;
  }

  /* ===================== Bühne (Kopf + Brett + Steuerung) ===================== */
  function buildStage() {
    var roundEl = el('div', { class: 'gmk-round' }, ['']);
    var top = el('div', { class: 'gmk-top' }, [
      el('div', { class: 'gmk-brand neon' }, ['⭕ Fünf in einer Reihe']), roundEl
    ]);

    var aName = el('div', { class: 'gmk-nm' }, ['—']), aScore = el('div', { class: 'gmk-sc' }, ['0']);
    var aChip = el('div', { class: 'gmk-chip gmk-chip-a' }, [
      el('span', { class: 'gmk-dot gmk-dot-a' }),
      el('div', { class: 'gmk-info' }, [aName, el('div', { class: 'gmk-mini' }, ['🌿 Ranke'])]),
      aScore
    ]);
    var bName = el('div', { class: 'gmk-nm' }, ['—']), bScore = el('div', { class: 'gmk-sc' }, ['0']);
    var bChip = el('div', { class: 'gmk-chip gmk-chip-b' }, [
      el('span', { class: 'gmk-dot gmk-dot-b' }),
      el('div', { class: 'gmk-info' }, [bName, el('div', { class: 'gmk-mini' }, ['🌺 Blüte'])]),
      bScore
    ]);
    var scores = el('div', { class: 'gmk-scores' }, [aChip, bChip]);

    var statusEl = el('div', { class: 'gmk-status you' }, ['']);
    var canvas = el('canvas', { class: 'gmk-canvas', width: 608, height: 608, 'aria-label': 'Gomoku-Brett, 15 mal 15' });
    var confirmBtn = el('button', { class: 'btn btn-primary gmk-confirm', type: 'button' }, ['✓ Setzen']);
    var confirmRow = el('div', { class: 'controls-row gmk-confirm-row' }, [confirmBtn]);
    var rules = el('p', { class: 'hint-text gmk-rules' }, [
      'Abwechselnd setzen · fünf in einer Reihe (auch diagonal) gewinnt · Handy: antippen, dann ✓ bestätigen'
    ]);

    var wrap = el('div', { class: 'gmk-wrap' }, [
      top, scores, statusEl, el('div', { class: 'gmk-board-wrap' }, [canvas]), confirmRow, rules
    ]);
    return {
      root: wrap, canvas: canvas, roundEl: roundEl, statusEl: statusEl,
      aChip: aChip, aName: aName, aScore: aScore,
      bChip: bChip, bName: bName, bScore: bScore,
      confirmBtn: confirmBtn, confirmRow: confirmRow
    };
  }

  /* Zeichnet Raster + Steine + Marker (wird auch von der Lupe wiederverwendet). */
  function drawScene(c, vm, seen, now) {
    var i, r, k, x, y, ch, t, s;
    /* Raster */
    c.lineWidth = 1.1;
    c.strokeStyle = 'rgba(57,255,20,.22)';
    c.beginPath();
    for (i = 0; i < N; i++) {
      c.moveTo(PAD, PAD + i * CELL); c.lineTo(VS - PAD, PAD + i * CELL);
      c.moveTo(PAD + i * CELL, PAD); c.lineTo(PAD + i * CELL, VS - PAD);
    }
    c.stroke();
    /* Rahmen */
    c.lineWidth = 2;
    c.strokeStyle = 'rgba(57,255,20,.4)';
    c.strokeRect(PAD, PAD, CELL * (N - 1), CELL * (N - 1));
    /* Sternpunkte */
    c.fillStyle = 'rgba(125,243,230,.5)';
    for (i = 0; i < STARS.length; i++) {
      c.beginPath();
      c.arc(PAD + STARS[i][1] * CELL, PAD + STARS[i][0] * CELL, 3.4, 0, Math.PI * 2);
      c.fill();
    }
    /* Steine */
    for (i = 0; i < CELLS; i++) {
      ch = vm.board.charAt(i);
      if (ch === EMPTY) continue;
      t = seen[i] ? Math.min(1, (now - seen[i]) / 190) : 1;
      s = t >= 1 ? 1 : (1 - Math.pow(1 - t, 3)) * (1 + 0.18 * Math.sin(Math.PI * t));
      drawStone(c, PAD + colOf(i) * CELL, PAD + rowOf(i) * CELL, ch, SR * s, 1);
    }
    /* Marker letzter Zug */
    if (vm.last >= 0 && vm.board.charAt(vm.last) !== EMPTY && !vm.winline) {
      x = PAD + colOf(vm.last) * CELL; y = PAD + rowOf(vm.last) * CELL;
      c.save();
      c.globalAlpha = 0.5 + 0.35 * Math.sin(now / 260);
      c.strokeStyle = '#ffffff';
      c.lineWidth = 2;
      c.beginPath(); c.arc(x, y, SR + 5, 0, Math.PI * 2); c.stroke();
      c.restore();
    }
    /* Siegerreihe */
    if (vm.winline && vm.winline.length) {
      var pulse = 0.55 + 0.45 * Math.sin(now / 200);
      var f = vm.winline[0], l = vm.winline[vm.winline.length - 1];
      c.save();
      c.strokeStyle = 'rgba(255,210,63,' + (0.55 + 0.35 * pulse).toFixed(3) + ')';
      c.lineWidth = 7; c.lineCap = 'round';
      c.shadowColor = 'rgba(255,210,63,.9)'; c.shadowBlur = 18 + 14 * pulse;
      c.beginPath();
      c.moveTo(PAD + colOf(f) * CELL, PAD + rowOf(f) * CELL);
      c.lineTo(PAD + colOf(l) * CELL, PAD + rowOf(l) * CELL);
      c.stroke();
      c.shadowBlur = 0;
      c.lineWidth = 2.4;
      c.strokeStyle = 'rgba(255,210,63,' + (0.7 + 0.3 * pulse).toFixed(3) + ')';
      for (k = 0; k < vm.winline.length; k++) {
        r = vm.winline[k];
        c.beginPath();
        c.arc(PAD + colOf(r) * CELL, PAD + rowOf(r) * CELL, SR + 4 + 2 * pulse, 0, Math.PI * 2);
        c.stroke();
      }
      c.restore();
    }
  }

  function drawStone(c, x, y, ch, r, alpha) {
    if (r <= 0.4) return;
    var hi = ch === P1 ? '#d6ffc9' : '#ffd3db';
    var mid = ch === P1 ? '#39ff14' : '#ff4d6d';
    var lo = ch === P1 ? '#0d6b0a' : '#7d0f28';
    var glow = ch === P1 ? 'rgba(57,255,20,.6)' : 'rgba(255,77,109,.6)';
    c.save();
    c.globalAlpha = alpha;
    c.shadowColor = glow; c.shadowBlur = 13;
    var g = c.createRadialGradient(x - r * 0.34, y - r * 0.38, r * 0.1, x, y, r);
    g.addColorStop(0, hi); g.addColorStop(0.5, mid); g.addColorStop(1, lo);
    c.fillStyle = g;
    c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fill();
    c.shadowBlur = 0;
    c.lineWidth = 1.3; c.strokeStyle = 'rgba(3,14,8,.8)'; c.stroke();
    c.restore();
  }

  function roundRectPath(c, x, y, w, h, r) {
    c.beginPath();
    c.moveTo(x + r, y);
    c.lineTo(x + w - r, y); c.quadraticCurveTo(x + w, y, x + w, y + r);
    c.lineTo(x + w, y + h - r); c.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    c.lineTo(x + r, y + h); c.quadraticCurveTo(x, y + h, x, y + h - r);
    c.lineTo(x, y + r); c.quadraticCurveTo(x, y, x + r, y);
    c.closePath();
  }

  /* Bühne mit eigener Zeichenschleife, Eingabe und In-place-Updates.
     cfg.onPlace(idx) wird gerufen, wenn der Spieler wirklich setzt. */
  function makeStage(root, cfg) {
    var refs = buildStage();
    root.innerHTML = ''; root.appendChild(refs.root);

    var cvs = refs.canvas, c2d = cvs.getContext('2d');
    var vm = {
      board: emptyBoard(), last: -1, winline: null, canPlay: false, myColor: null,
      turn: null, aName: '—', bName: '—', aScore: 0, bScore: 0,
      roundText: '', status: { text: '', cls: 'you' }
    };
    var seen = {}, prevBoard = null, hoverIdx = -1, cursorIdx = -1;
    var raf = null, dead = false, css = 0, nextFit = 0, listeners = [];

    function addL(t, ty, fn, opts) { t.addEventListener(ty, fn, opts); listeners.push({ t: t, ty: ty, fn: fn, opts: opts }); }

    /* ---- Größe: Backing-Store an die CSS-Breite anpassen (scharf auf Retina) ---- */
    function fit() {
      var w = cvs.clientWidth || 320;
      var dpr = Math.min(window.devicePixelRatio || 1, 2);
      var px = Math.max(160, Math.round(w * dpr));
      if (cvs.width !== px) { cvs.width = px; cvs.height = px; }
      css = w;
    }

    function evtIdx(e) {
      var rect = cvs.getBoundingClientRect();
      if (!rect.width || !rect.height) return -1;
      var x = (e.clientX - rect.left) / rect.width * VS;
      var y = (e.clientY - rect.top) / rect.height * VS;
      var col = Math.round((x - PAD) / CELL), row = Math.round((y - PAD) / CELL);
      if (col < 0 || col >= N || row < 0 || row >= N) return -1;
      return idxOf(row, col);
    }
    function free(i) { return i >= 0 && vm.board.charAt(i) === EMPTY; }

    function place(i) {
      if (dead || !vm.canPlay || !free(i)) return;
      cursorIdx = -1; hoverIdx = -1;
      syncControls();
      cfg.onPlace(i);
    }
    function setCursor(i) {
      cursorIdx = i;
      syncControls();
      if (App.Audio) App.Audio.sfx('select');
    }
    function syncControls() {
      var show = vm.canPlay && cursorIdx >= 0 && free(cursorIdx);
      refs.confirmRow.style.display = show ? '' : 'none';
      if (show) refs.confirmBtn.textContent = '✓ Setzen · ' + coordName(cursorIdx);
      cvs.classList.toggle('gmk-live', !!vm.canPlay);
    }

    addL(cvs, 'pointerdown', function (e) {
      if (dead || !vm.canPlay) return;
      var i = evtIdx(e);
      if (!free(i)) return;
      if (e.pointerType === 'touch' || e.pointerType === 'pen') {
        if (cursorIdx === i) place(i); else setCursor(i);   // erst zielen, dann bestätigen
      } else {
        place(i);
      }
    });
    addL(cvs, 'pointermove', function (e) {
      if (dead || e.pointerType === 'touch') return;
      var i = vm.canPlay ? evtIdx(e) : -1;
      hoverIdx = free(i) ? i : -1;
    });
    addL(cvs, 'pointerleave', function () { hoverIdx = -1; });
    addL(refs.confirmBtn, 'click', function () { if (cursorIdx >= 0) place(cursorIdx); });
    addL(window, 'resize', function () { nextFit = 0; });
    addL(document, 'keydown', function (e) {
      if (dead || !vm.canPlay) return;
      var k = e.key, cur = cursorIdx >= 0 ? cursorIdx : (vm.last >= 0 ? vm.last : CENTER);
      var r = rowOf(cur), c = colOf(cur), moved = true;
      if (k === 'ArrowUp') r = Math.max(0, r - 1);
      else if (k === 'ArrowDown') r = Math.min(N - 1, r + 1);
      else if (k === 'ArrowLeft') c = Math.max(0, c - 1);
      else if (k === 'ArrowRight') c = Math.min(N - 1, c + 1);
      else moved = false;
      if (moved) { e.preventDefault(); cursorIdx = idxOf(r, c); syncControls(); return; }
      if ((k === 'Enter' || k === ' ') && cursorIdx >= 0) { e.preventDefault(); place(cursorIdx); }
    });

    /* ---- Zeichenschleife (rAF nur zum Malen, alle Zeiten via Date.now) ---- */
    function frame() {
      if (dead) return;
      var now = Date.now();
      if (now >= nextFit) { fit(); nextFit = now + 400; }
      var k = cvs.width / VS;
      c2d.setTransform(k, 0, 0, k, 0, 0);
      c2d.clearRect(0, 0, VS, VS);
      var g = c2d.createRadialGradient(VS / 2, VS * 0.4, 30, VS / 2, VS / 2, VS * 0.8);
      g.addColorStop(0, '#0c2c1c'); g.addColorStop(1, '#04120b');
      c2d.fillStyle = g; c2d.fillRect(0, 0, VS, VS);

      drawScene(c2d, vm, seen, now);

      /* Maus-Vorschau */
      if (vm.canPlay && hoverIdx >= 0 && free(hoverIdx) && vm.myColor) {
        drawStone(c2d, PAD + colOf(hoverIdx) * CELL, PAD + rowOf(hoverIdx) * CELL, vm.myColor, SR * 0.92, 0.32);
      }
      /* Zielkreis (Handy/Tastatur) + Lupe */
      if (vm.canPlay && cursorIdx >= 0 && free(cursorIdx) && vm.myColor) {
        var cx = PAD + colOf(cursorIdx) * CELL, cy = PAD + rowOf(cursorIdx) * CELL;
        drawStone(c2d, cx, cy, vm.myColor, SR * 0.95, 0.5);
        drawCross(c2d, cx, cy, now);
        drawLoupe(c2d, cx, cy, now);
      }
      raf = requestAnimationFrame(frame);
    }
    function drawCross(c, x, y, now) {
      var p = 0.6 + 0.4 * Math.sin(now / 220);
      c.save();
      c.strokeStyle = 'rgba(125,243,230,' + (0.5 + 0.5 * p).toFixed(3) + ')';
      c.lineWidth = 2;
      c.beginPath(); c.arc(x, y, SR + 7 + 2 * p, 0, Math.PI * 2); c.stroke();
      c.beginPath();
      c.moveTo(x - CELL * 0.62, y); c.lineTo(x - SR - 9, y);
      c.moveTo(x + SR + 9, y); c.lineTo(x + CELL * 0.62, y);
      c.moveTo(x, y - CELL * 0.62); c.lineTo(x, y - SR - 9);
      c.moveTo(x, y + SR + 9); c.lineTo(x, y + CELL * 0.62);
      c.stroke();
      c.restore();
    }
    /* Lupe: zeigt die Umgebung des Zielkreises vergrößert — hilft auf dem Handy. */
    function drawLoupe(c, cx, cy, now) {
      var size = 168, m = 14, k = 2.1;
      var lx = cx > VS / 2 ? m : VS - m - size;
      var ly = cy > VS / 2 ? m : VS - m - size;
      c.save();
      roundRectPath(c, lx, ly, size, size, 16);
      c.save();
      c.clip();
      c.fillStyle = '#061c11'; c.fillRect(lx, ly, size, size);
      c.translate(lx + size / 2, ly + size / 2);
      c.scale(k, k);
      c.translate(-cx, -cy);
      drawScene(c, vm, seen, now);
      drawStone(c, cx, cy, vm.myColor, SR * 0.95, 0.5);
      drawCross(c, cx, cy, now);
      c.restore();
      c.lineWidth = 2;
      c.strokeStyle = 'rgba(125,243,230,.55)';
      c.stroke();
      c.restore();
    }

    /* ---- Zustand -> DOM/Canvas (in-place, beliebig oft aufrufbar) ---- */
    function update(next) {
      if (dead) return;
      var i, ch, fresh = prevBoard === null;
      if (next.board && next.board !== vm.board) {
        for (i = 0; i < CELLS; i++) {
          ch = next.board.charAt(i);
          if (ch !== EMPTY && (!prevBoard || prevBoard.charAt(i) === EMPTY)) {
            seen[i] = fresh ? 0 : Date.now();
            if (!fresh && App.Audio) App.Audio.blip(ch === P1 ? 640 : 430, 0.11, { type: 'triangle', peak: 0.07 });
          } else if (ch === EMPTY && seen[i]) {
            delete seen[i];
          }
        }
        prevBoard = next.board;
      } else if (fresh && next.board) {
        prevBoard = next.board;
      }
      Object.assign(vm, next);

      refs.roundEl.textContent = vm.roundText;
      refs.aName.textContent = vm.aName;
      refs.bName.textContent = vm.bName;
      refs.aScore.textContent = String(vm.aScore);
      refs.bScore.textContent = String(vm.bScore);
      refs.aChip.classList.toggle('active', vm.turn === P1);
      refs.bChip.classList.toggle('active', vm.turn === P2);
      refs.aChip.classList.toggle('me', vm.myColor === P1);
      refs.bChip.classList.toggle('me', vm.myColor === P2);
      refs.statusEl.textContent = vm.status.text;
      refs.statusEl.className = 'gmk-status ' + vm.status.cls;
      if (!vm.canPlay) { cursorIdx = -1; hoverIdx = -1; }
      syncControls();
    }

    function destroy() {
      dead = true;
      if (raf) { cancelAnimationFrame(raf); raf = null; }
      listeners.forEach(function (l) { try { l.t.removeEventListener(l.ty, l.fn, l.opts); } catch (e) {} });
      listeners = [];
    }

    fit();
    syncControls();
    raf = requestAnimationFrame(frame);
    return { update: update, destroy: destroy };
  }

  /* ===================== Registrierung ===================== */
  App.Minigames.gomoku = {
    id: 'gomoku', title: 'Fünf in einer Reihe', icon: '⭕', order: 106,
    subtitle: 'Fünf Steine in Reihe – Duell auf 15x15',
    single: true, multi: true, minPlayers: 2, maxPlayers: 2,

    render: function (root, ctx) {
      var destroyed = false, timers = [], stops = [], stage = null;
      function after(ms, fn) { var t = setTimeout(function () { if (!destroyed) fn(); }, ms); timers.push(t); return t; }
      function clearTimers() { timers.forEach(clearTimeout); timers = []; }
      function dropStage() { if (stage) { stage.destroy(); stage = null; } }
      function cleanup() {
        destroyed = true;
        clearTimers();
        stops.forEach(function (f) { try { f(); } catch (e) {} }); stops = [];
        dropStage();
      }

      if (ctx.mode === 'multi' && ctx.room) renderMulti(); else renderSingle();
      return { cleanup: cleanup };

      /* =========================================================
       *  SOLO — Stufenwahl, dann Duell gegen den Bot
       * ========================================================= */
      function renderSingle() {
        var st = null, thinking = false;
        showSetup();

        function showSetup() {
          clearTimers(); dropStage();
          var cards = LEVELS.map(function (lv, i) {
            return el('button', { class: 'gmk-lvl', type: 'button', onclick: function () { if (App.Audio) App.Audio.sfx('click'); startGame(i); } }, [
              el('span', { class: 'gmk-lvl-ic' }, [lv.icon]),
              el('span', { class: 'gmk-lvl-tx' }, [
                el('span', { class: 'gmk-lvl-nm' }, [lv.name + ' · ' + lv.label]),
                el('span', { class: 'gmk-lvl-ds' }, [lv.desc])
              ]),
              el('span', { class: 'gmk-lvl-go' }, ['▶'])
            ]);
          });
          var best = App.Storage.get('best_gomoku', 0);
          root.innerHTML = '';
          root.appendChild(el('div', { class: 'gmk-panel glass' }, [
            el('div', { class: 'gmk-hero' }, ['⭕']),
            el('h2', { class: 'neon' }, ['Fünf in einer Reihe']),
            el('p', { class: 'hint-text' }, ['Du bist 🌿 Ranke und beginnst. Bring fünf Steine in eine Reihe — waagrecht, senkrecht oder diagonal.']),
            el('div', { class: 'gmk-lvls' }, cards),
            el('p', { class: 'gmk-best' }, ['🏆 Bestwert: ' + App.MG.fmt(best) + ' Punkte'])
          ]));
        }

        function startGame(level) {
          clearTimers(); dropStage();
          thinking = false;
          st = {
            board: emptyBoard(), turn: P1, last: -1, winline: null,
            over: false, result: null, level: level, startedAt: Date.now(), myStones: 0
          };
          stage = makeStage(root, { onPlace: onPlace });
          paint();
        }

        function onPlace(i) {
          if (destroyed || !st || st.over || st.turn !== P1 || thinking) return;
          if (st.board.charAt(i) !== EMPTY) return;
          st.myStones++;
          apply(i, P1);
        }

        function apply(i, ch) {
          st.board = setAt(st.board, i, ch);
          st.last = i;
          var run = winRun(st.board, i, ch);
          if (run) { st.winline = run; return finish(ch === P1 ? 'win' : 'lose'); }
          if (boardFull(st.board)) return finish('draw');
          st.turn = ch === P1 ? P2 : P1;
          paint();
          if (st.turn === P2) scheduleBot();
        }

        function scheduleBot() {
          thinking = true;
          paint();
          after(360 + Math.random() * 260, function () {
            if (!st || st.over || st.turn !== P2) { thinking = false; return; }
            var m = pickMove(st.board, P2, P1, st.level);
            thinking = false;
            if (m < 0) return finish('draw');
            apply(m, P2);
          });
        }

        function finish(res) {
          st.over = true; st.result = res; st.turn = null;
          paint();
          if (App.Audio) App.Audio.sfx(res === 'win' ? 'win' : res === 'lose' ? 'lose' : 'info');
          after(res === 'draw' ? 1200 : 1800, showEnd);
        }

        function paint() {
          if (!stage || !st) return;
          var lv = LEVELS[st.level];
          stage.update({
            board: st.board, last: st.last, winline: st.winline,
            myColor: P1, turn: st.turn,
            canPlay: !st.over && st.turn === P1 && !thinking,
            aName: 'Du', bName: lv.icon + ' ' + lv.name,
            aScore: st.myStones, bScore: countOf(st.board, P2),
            roundText: lv.label + ' · ' + App.MG.mmss((Date.now() - st.startedAt) / 1000),
            status: soloStatus()
          });
        }
        function soloStatus() {
          if (st.result === 'win') return { text: 'Fünf in einer Reihe — gewonnen! 🎉', cls: 'win' };
          if (st.result === 'lose') return { text: 'Der Bot hat fünf. Verloren.', cls: 'lose' };
          if (st.result === 'draw') return { text: 'Brett voll — unentschieden', cls: 'draw' };
          if (thinking || st.turn === P2) return { text: LEVELS[st.level].name + ' überlegt …', cls: 'opp' };
          return { text: 'Du bist dran', cls: 'you' };
        }

        function showEnd() {
          dropStage();
          var lv = LEVELS[st.level];
          var sec = (Date.now() - st.startedAt) / 1000;
          var score = 0, label;
          if (st.result === 'win') {
            var timeBonus = Math.max(0, Math.round(600 - sec * 3));
            var effBonus = Math.max(0, (42 - st.myStones) * 30);
            score = lv.base + timeBonus + effBonus;
            label = lv.icon + ' ' + lv.name + ' geschlagen · ' + App.MG.mmss(sec) + ' · ' + st.myStones + ' Steine (+' + timeBonus + ' Zeit, +' + effBonus + ' Effizienz)';
          } else if (st.result === 'draw') {
            score = Math.round(lv.base * 0.25);
            label = 'Unentschieden gegen ' + lv.icon + ' ' + lv.name + ' — das Brett ist voll.';
          } else {
            label = lv.icon + ' ' + lv.name + ' hatte zuerst fünf. Neue Runde, neues Glück!';
          }
          var best = App.Storage.get('best_gomoku', 0);
          var nb = score > best;
          if (nb) App.Storage.set('best_gomoku', score);
          App.MG.endScreen(root, {
            title: st.result === 'win' ? '🏆 Gewonnen!' : st.result === 'draw' ? '🤝 Unentschieden' : '💀 Verloren',
            score: score, best: best, newBest: nb,
            label: label + (nb ? ' · neuer Rekord! 🎉' : ' · Bestwert: ' + App.MG.fmt(best)),
            onExit: ctx.onExit,
            onAgain: showSetup
          });
        }
      }

      /* =========================================================
       *  MULTI — rundenbasiert über room.shared, Best of 3
       * ========================================================= */
      function renderMulti() {
        var room = ctx.room, me = ctx.me;
        var snap = room.snapshot() || {};
        var startAt = (snap.round && snap.round.startAt) || (room.now() + 3000);
        stops.push(App.MG.countdown(root, startAt, function () { play(); }, room.now));

        var lastShared = (snap && snap.shared) || null;
        var curView = null, waitRefs = null, initDone = false;
        var pendingAdvanceRound = -1, reported = -1, started = false;

        function play() {
          if (destroyed || started) return;
          started = true;
          lastShared = (room.snapshot() && room.snapshot().shared) || lastShared;
          room.on('shared', onShared);
          room.on('players', onPlayers);
          stops.push(function () { room.off('shared', onShared); room.off('players', onPlayers); });
          sync();
        }
        function onShared(sh) { if (destroyed) return; lastShared = sh; sync(); }
        function onPlayers() { if (destroyed) return; sync(); }

        /* ---- Farbzuordnung aus shared.order ---- */
        function colorOf(id, sh) { var i = sh && sh.order ? sh.order.indexOf(id) : -1; return i === 0 ? P1 : i === 1 ? P2 : null; }
        function otherId(id, sh) { return sh.order[0] === id ? sh.order[1] : sh.order[0]; }
        function byId(players, id) { var i; for (i = 0; i < players.length; i++) if (players[i].id === id) return players[i]; return null; }

        function sync() {
          if (destroyed || !started) return;
          var players = room.players();
          if (players.length < 2) { showWaiting(players, false); return; }
          var sh = lastShared;
          if (!sh || !sh.board) {
            if (room.isHost() && !initDone) { initShared(players); return; }
            showWaiting(players, true); return;
          }
          reportIfNeeded(sh);
          if (sh.seriesOver) { showEnd(sh); return; }
          ensureStage();
          stage.update(multiVM(sh, players));
          maybeAdvance(sh);
        }

        function initShared(players) {
          initDone = true;
          var a = players[0].id, b = players[1].id, scores = {};
          scores[a] = 0; scores[b] = 0;
          room.setShared({
            order: [a, b], board: emptyBoard(), turn: a, starter: a, last: -1,
            winner: null, winline: null, scores: scores, round: 1,
            seriesOver: false, seriesWinner: null
          });
        }

        function reportIfNeeded(sh) {
          var v = (sh.scores && sh.scores[me.id]) || 0;
          if (v !== reported) { reported = v; room.reportScore(v); }
        }

        function ensureStage() {
          if (curView === 'game' && stage) return;
          curView = 'game';
          dropStage();
          stage = makeStage(root, { onPlace: onPlace });
        }

        function multiVM(sh, players) {
          var aId = sh.order[0], bId = sh.order[1];
          var aP = byId(players, aId), bP = byId(players, bId);
          var mine = colorOf(me.id, sh);
          var over = !!sh.winner;
          return {
            board: sh.board, last: typeof sh.last === 'number' ? sh.last : -1,
            winline: sh.winline || null,
            myColor: mine, turn: over ? null : colorOf(sh.turn, sh),
            canPlay: !over && !!mine && sh.turn === me.id,
            aName: (aP ? aP.name : 'Spieler 1') + (mine === P1 ? ' (du)' : ''),
            bName: (bP ? bP.name : 'Spieler 2') + (mine === P2 ? ' (du)' : ''),
            aScore: (sh.scores && sh.scores[aId]) || 0,
            bScore: (sh.scores && sh.scores[bId]) || 0,
            roundText: 'Runde ' + sh.round + ' / ' + MAX_ROUNDS,
            status: multiStatus(sh, players, mine)
          };
        }
        function multiStatus(sh, players, mine) {
          if (sh.winner) {
            if (sh.winner === 'draw') return { text: 'Brett voll — unentschieden · nächste Runde …', cls: 'draw' };
            var won = sh.winner === me.id;
            return { text: (won ? 'Fünf in einer Reihe! 🎉' : 'Runde verloren') + ' · nächste Runde …', cls: won ? 'win' : 'lose' };
          }
          if (!mine) return { text: 'Du schaust zu', cls: 'opp' };
          if (sh.turn === me.id) return { text: 'Du bist dran', cls: 'you' };
          var t = byId(players, sh.turn);
          return { text: (t ? t.name : 'Gegner') + ' überlegt …', cls: 'opp' };
        }

        function onPlace(i) {
          var sh = lastShared;
          if (destroyed || !sh || !sh.board || sh.seriesOver || sh.winner) return;
          var mine = colorOf(me.id, sh);
          if (!mine) return;
          if (sh.turn !== me.id) { UI.toast('Warte — du bist nicht dran', 'info'); return; }
          if (sh.board.charAt(i) !== EMPTY) return;
          var board = setAt(sh.board, i, mine);
          var run = winRun(board, i, mine);
          var patch = { board: board, last: i };
          if (run) {
            patch.winner = me.id; patch.winline = run;
            var scores = Object.assign({}, sh.scores || {});
            scores[me.id] = (scores[me.id] || 0) + 1;
            patch.scores = scores;
            if (App.Audio) App.Audio.sfx('win');
          } else if (boardFull(board)) {
            patch.winner = 'draw'; patch.winline = null;
          } else {
            patch.turn = otherId(me.id, sh);
          }
          lastShared = Object.assign({}, sh, patch);   // sofortiges Feedback, Server bestätigt gleich
          room.setShared(patch);
          sync();
        }

        /* Nur der Host schaltet weiter — ~2,6 s, damit beide die Siegerreihe sehen. */
        function maybeAdvance(sh) {
          if (!room.isHost() || sh.seriesOver || !sh.winner) return;
          if (pendingAdvanceRound === sh.round) return;
          pendingAdvanceRound = sh.round;
          after(2600, function () {
            var cur = lastShared;
            if (!cur || cur.seriesOver || !cur.winner || cur.round !== sh.round) return;
            var a = cur.order[0], b = cur.order[1];
            var sa = (cur.scores && cur.scores[a]) || 0, sb = (cur.scores && cur.scores[b]) || 0;
            if (sa >= WIN_TARGET || sb >= WIN_TARGET || cur.round >= MAX_ROUNDS) {
              room.setShared({ seriesOver: true, seriesWinner: sa > sb ? a : (sb > sa ? b : 'draw') });
            } else {
              var ns = (cur.starter === a) ? b : a;
              room.setShared({
                board: emptyBoard(), turn: ns, starter: ns, last: -1,
                winner: null, winline: null, round: cur.round + 1
              });
            }
          });
        }

        function doRevanche() {
          var players = room.players();
          if (players.length < 2 || !lastShared) return;
          var a = lastShared.order[0], b = lastShared.order[1], scores = {};
          scores[a] = 0; scores[b] = 0;
          pendingAdvanceRound = -1; reported = -1; curView = null;
          room.setShared({
            board: emptyBoard(), turn: a, starter: a, last: -1,
            winner: null, winline: null, scores: scores, round: 1,
            seriesOver: false, seriesWinner: null
          });
        }

        /* ---- Warte-Ansicht ---- */
        function showWaiting(players, starting) {
          if (curView !== 'waiting') {
            curView = 'waiting';
            dropStage();
            var count = el('div', { class: 'gmk-big neon' }, ['1 / 2']);
            var msg = el('p', { class: 'hint-text' }, ['']);
            waitRefs = { count: count, msg: msg };
            root.innerHTML = '';
            root.appendChild(el('div', { class: 'gmk-panel glass' }, [
              el('div', { class: 'gmk-hero gmk-spin' }, ['⭕']),
              el('h2', { class: 'neon' }, ['Fünf in einer Reihe']),
              count, msg,
              el('div', { class: 'controls-row' }, [
                el('button', { class: 'btn btn-ghost', type: 'button', onclick: ctx.onExit }, ['Zurück zur Lobby'])
              ])
            ]));
          }
          waitRefs.count.textContent = players.length + ' / 2';
          waitRefs.msg.textContent = starting ? 'Spiel startet gleich …' : 'Warte auf den zweiten Spieler …';
        }

        /* ---- Serien-Ende: Podest über App.MG.endScreen ---- */
        function showEnd(sh) {
          if (curView === 'end') return;
          curView = 'end';
          dropStage();
          reportIfNeeded(sh);
          var opts = {
            players: room.players(), meId: me.id, onExit: ctx.onExit,
            title: sh.seriesWinner === 'draw' ? '🤝 Unentschieden' : '🏁 Serie vorbei'
          };
          if (room.isHost()) opts.onAgain = doRevanche;
          App.MG.endScreen(root, opts);
          if (!room.isHost()) {
            root.appendChild(el('p', { class: 'hint-text gmk-center' }, ['Der Host kann eine Revanche starten.']));
          }
        }
      }

      function countOf(b, ch) { var i, n = 0; for (i = 0; i < CELLS; i++) if (b.charAt(i) === ch) n++; return n; }
    }
  };

  /* ===================== CSS ===================== */
  function injectStyle() {
    UI.injectStyle('mg-gomoku-css', [
      '.gmk-wrap{display:flex;flex-direction:column;gap:12px;max-width:520px;margin:0 auto;}',
      '.gmk-top{display:flex;justify-content:space-between;align-items:center;gap:10px;}',
      '.gmk-brand{font-weight:900;font-size:17px;}',
      '.gmk-round{font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;font-weight:800;font-variant-numeric:tabular-nums;}',
      /* Spieler-Chips */
      '.gmk-scores{display:flex;gap:10px;}',
      '.gmk-chip{flex:1;min-width:0;display:flex;align-items:center;gap:9px;padding:8px 12px;border-radius:14px;background:rgba(9,32,21,.6);border:1px solid var(--stroke);transition:border-color .15s,box-shadow .15s;}',
      '.gmk-dot{width:18px;height:18px;border-radius:50%;flex:0 0 auto;}',
      '.gmk-dot-a{background:radial-gradient(circle at 34% 32%,#d6ffc9,var(--neon) 55%,#0d6b0a);box-shadow:0 0 10px rgba(57,255,20,.6);}',
      '.gmk-dot-b{background:radial-gradient(circle at 34% 32%,#ffd3db,var(--danger) 55%,#7d0f28);box-shadow:0 0 10px rgba(255,77,109,.6);}',
      '.gmk-info{flex:1;min-width:0;display:flex;flex-direction:column;line-height:1.15;}',
      '.gmk-nm{font-weight:800;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      '.gmk-mini{font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;}',
      '.gmk-sc{font-size:22px;font-weight:900;color:var(--leaf);font-variant-numeric:tabular-nums;}',
      '.gmk-chip.me .gmk-nm{color:var(--aqua);}',
      '.gmk-chip.active{border-color:var(--neon);box-shadow:0 0 0 1px var(--neon),0 0 16px rgba(57,255,20,.3);}',
      '.gmk-chip.active .gmk-dot{animation:gmk-bob .9s ease-in-out infinite;}',
      '@keyframes gmk-bob{0%,100%{transform:translateY(0) scale(1)}50%{transform:translateY(-3px) scale(1.12)}}',
      /* Statuszeile */
      '.gmk-status{text-align:center;font-weight:900;font-size:clamp(15px,4.2vw,19px);min-height:24px;transition:color .15s;}',
      '.gmk-status.you{color:var(--neon);text-shadow:0 0 10px rgba(57,255,20,.4);}',
      '.gmk-status.opp{color:var(--aqua);}',
      '.gmk-status.win{color:var(--gold);text-shadow:0 0 12px rgba(255,210,63,.5);}',
      '.gmk-status.lose{color:var(--danger);}',
      '.gmk-status.draw{color:var(--silver);}',
      /* Brett */
      '.gmk-board-wrap{display:flex;justify-content:center;}',
      '.gmk-canvas{width:100%;max-width:460px;height:auto;aspect-ratio:1/1;display:block;border-radius:18px;',
      'border:1px solid var(--stroke-2);background:#04120b;box-shadow:0 0 28px rgba(57,255,20,.14),inset 0 0 40px rgba(0,0,0,.5);',
      'touch-action:manipulation;-webkit-tap-highlight-color:transparent;user-select:none;-webkit-user-select:none;cursor:default;}',
      '.gmk-canvas.gmk-live{cursor:pointer;border-color:var(--neon);box-shadow:0 0 34px rgba(57,255,20,.3),inset 0 0 40px rgba(0,0,0,.5);}',
      /* Bestätigen */
      '.gmk-confirm-row{margin:0;}',
      '.gmk-confirm{font-variant-numeric:tabular-nums;animation:gmk-in .18s ease;}',
      '@keyframes gmk-in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}',
      '.gmk-rules{margin:0;text-align:center;font-size:11px;}',
      '.gmk-center{text-align:center;margin:10px 0 0;}',
      /* Panels (Stufenwahl / Warten) */
      '.gmk-panel{padding:26px 20px;text-align:center;display:flex;flex-direction:column;gap:12px;align-items:center;max-width:460px;margin:0 auto;}',
      '.gmk-panel h2{margin:0;}',
      '.gmk-hero{font-size:52px;line-height:1;filter:drop-shadow(0 0 12px rgba(57,255,20,.45));}',
      '.gmk-spin{animation:gmk-spin 2.6s linear infinite;}',
      '@keyframes gmk-spin{to{transform:rotate(360deg)}}',
      '.gmk-big{font-size:clamp(24px,7vw,36px);font-weight:900;line-height:1.1;}',
      '.gmk-lvls{display:flex;flex-direction:column;gap:9px;width:100%;margin-top:4px;}',
      '.gmk-lvl{display:flex;align-items:center;gap:12px;width:100%;padding:12px 14px;border-radius:15px;text-align:left;',
      'background:rgba(6,24,16,.8);border:1px solid var(--stroke);color:var(--text);font-family:inherit;cursor:pointer;',
      'transition:transform .12s,border-color .15s,box-shadow .2s;}',
      '.gmk-lvl:hover{border-color:var(--neon);box-shadow:0 0 18px rgba(57,255,20,.25);transform:translateY(-2px);}',
      '.gmk-lvl:active{transform:scale(.98);}',
      '.gmk-lvl-ic{font-size:26px;line-height:1;flex:0 0 auto;filter:drop-shadow(0 0 6px rgba(0,0,0,.5));}',
      '.gmk-lvl-tx{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px;}',
      '.gmk-lvl-nm{font-weight:900;font-size:14px;color:var(--leaf);}',
      '.gmk-lvl-ds{font-size:11px;color:var(--muted);line-height:1.3;}',
      '.gmk-lvl-go{color:var(--neon);font-size:13px;flex:0 0 auto;}',
      '.gmk-best{margin:2px 0 0;color:var(--gold);font-weight:800;font-size:13px;}'
    ].join(''));
  }
})();
