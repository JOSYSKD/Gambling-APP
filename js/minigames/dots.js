/* dots.js — "Käsekästchen" (Dots & Boxes) im Neon-Dschungel-Look.
 *
 * IDEE:      7x7 Punkte = 6x6 Kästchen = 84 Linien. Reihum zieht jeder eine
 *            Linie zwischen zwei benachbarten Punkten. Wer ein Kästchen
 *            schließt, bekommt es (eigene Neon-Farbe + Initiale) und ist
 *            SOFORT nochmal dran. Liegen alle Linien, gewinnt, wer die
 *            meisten der 36 Kästchen hat. 2–4 Spieler mit je eigener Farbe.
 * STEUERUNG: Zwischen zwei Punkte tippen/klicken (pointerdown → mobil-tauglich);
 *            gezogen wird die nächstgelegene freie Linie. Am Desktop zeigt eine
 *            Geister-Linie beim Drüberfahren, was passieren würde.
 * PUNKTE:    Multi → Kästchen = Punkte (Live-Chips, Podest über App.MG.endScreen).
 *            Solo  → Kästchen × 10 + Sieg-Bonus je Stufe (20 / 60 / 150),
 *            Bestwert in App.Storage unter 'best_dots'.
 * SOLO:      gegen einen Bot in drei Stufen. Leicht = übersieht auch mal ein
 *            Kästchen, Normal = nimmt alles mit und spielt sicher, Schwer =
 *            zusätzlich Ketten-/Endspiel-Logik per Rollout-Bewertung (findet
 *            dadurch auch den Doppelkreuz-Zug und gibt Ketten klein ab).
 * SYNC:      rundenbasiert über room.shared, der HOST ist Schiedsrichter.
 *            Gäste melden nur ihren Wunsch-Zug via room.reportState({move, at});
 *            der Host prüft (ist er dran? Linie frei? passt der Zugzähler 'at'
 *            zu sh.moves?) und schreibt das Ergebnis via room.setShared
 *            ({lines, boxes, turn, last, lastBy, moves, over}). Alle Clients
 *            rendern ausschließlich aus 'shared' → jeder Handler ist idempotent
 *            (Heartbeat feuert alle 4 s; ohne neuen sh.moves passiert nichts).
 *            Animationen laufen lokal über Wall-Clock (Date.now), rAF nur zum
 *            Zeichnen. cleanup() stoppt rAF, alle Timer, Listener + room.off().
 */
(function () {
  'use strict';
  window.App = window.App || {}; App.Minigames = App.Minigames || {};
  var UI = App.UI, el = UI.el;

  /* ===================== Brett-Maße & Tabellen ===================== */
  var GRID = 6;                     // 6x6 Kästchen
  var NH = (GRID + 1) * GRID;       // 42 waagerechte Linien
  var NV = GRID * (GRID + 1);       // 42 senkrechte Linien
  var NL = NH + NV;                 // 84 Linien gesamt
  var NB = GRID * GRID;             // 36 Kästchen
  var S = 80, PAD = 44;             // Rasterabstand + Rand (virtuelle px)
  var W = PAD * 2 + GRID * S;       // 568
  var H = W;
  var HIT = 30;                     // Trefferradius zum Anklicken einer Linie

  /* Linien-Ids: 0..41 = waagerecht (r*GRID+c), 42..83 = senkrecht (NH + r*(GRID+1)+c) */
  var BOX_LINES = [];               // Kästchen -> [oben, unten, links, rechts]
  var LINE_BOXES = [];              // Linie -> angrenzende Kästchen (1 oder 2)
  var LINE_GEO = [];                // Linie -> {x1,y1,x2,y2,mx,my}

  buildTables();

  function buildTables() {
    var i, r, c, j, bs, g;
    for (i = 0; i < NB; i++) {
      r = Math.floor(i / GRID); c = i % GRID;
      BOX_LINES.push([r * GRID + c, (r + 1) * GRID + c, NH + r * (GRID + 1) + c, NH + r * (GRID + 1) + c + 1]);
    }
    for (i = 0; i < NL; i++) {
      bs = [];
      if (i < NH) {
        r = Math.floor(i / GRID); c = i % GRID;
        if (r > 0) bs.push((r - 1) * GRID + c);
        if (r < GRID) bs.push(r * GRID + c);
        g = { x1: PAD + c * S, y1: PAD + r * S, x2: PAD + (c + 1) * S, y2: PAD + r * S };
      } else {
        j = i - NH; r = Math.floor(j / (GRID + 1)); c = j % (GRID + 1);
        if (c > 0) bs.push(r * GRID + c - 1);
        if (c < GRID) bs.push(r * GRID + c);
        g = { x1: PAD + c * S, y1: PAD + r * S, x2: PAD + c * S, y2: PAD + (r + 1) * S };
      }
      g.mx = (g.x1 + g.x2) / 2; g.my = (g.y1 + g.y2) / 2;
      LINE_GEO.push(g); LINE_BOXES.push(bs);
    }
  }

  /* ===================== Spieler-Farben ===================== */
  var PCOL = [
    { r: 57, g: 255, b: 20 },       // Neon-Grün
    { r: 51, g: 230, b: 208 },      // Aqua
    { r: 255, g: 210, b: 63 },      // Gold
    { r: 255, g: 77, b: 109 }       // Pink
  ];
  function rgba(i, a) { var c = PCOL[i % PCOL.length]; return 'rgba(' + c.r + ',' + c.g + ',' + c.b + ',' + a + ')'; }

  var LEVELS = [
    { id: 'leicht', name: 'Leicht', icon: '🌱', bonus: 20, desc: 'Der Bot übersieht auch mal ein Kästchen.' },
    { id: 'normal', name: 'Normal', icon: '🌿', bonus: 60, desc: 'Nimmt alles mit und verschenkt nichts freiwillig.' },
    { id: 'schwer', name: 'Schwer', icon: '🔥', bonus: 150, desc: 'Denkt in Ketten und opfert eiskalt das Doppelkreuz.' }
  ];
  function levelById(id) { for (var i = 0; i < LEVELS.length; i++) if (LEVELS[i].id === id) return LEVELS[i]; return LEVELS[1]; }

  var ROLL_MAX = 38;                // ab so vielen freien Linien lohnt die Rollout-Bewertung

  /* ===================== reine Brett-Logik ===================== */
  function newState() { return { l: new Int8Array(NL), b: new Int8Array(NB) }; }
  function cloneState(st) { return { l: st.l.slice(), b: st.b.slice() }; }
  function sidesOf(st, bi) {
    var e = BOX_LINES[bi], n = 0, k;
    for (k = 0; k < 4; k++) if (st.l[e[k]]) n++;
    return n;
  }
  /* Linie ziehen. owner ist 0-basiert, gespeichert wird owner+1 (0 = frei). */
  function playLine(st, id, owner) {
    st.l[id] = owner + 1;
    var lb = LINE_BOXES[id], got = 0, k;
    for (k = 0; k < lb.length; k++) if (sidesOf(st, lb[k]) === 4) { st.b[lb[k]] = owner + 1; got++; }
    return got;
  }
  /* Gleiche Wirkung wie playLine, merkt sich aber alles für undoSim() (Bot-Suche ohne Klone). */
  function applySim(st, id, owner, uL, uB) {
    st.l[id] = owner + 1; uL.push(id);
    var lb = LINE_BOXES[id], got = 0, k;
    for (k = 0; k < lb.length; k++) if (sidesOf(st, lb[k]) === 4) { st.b[lb[k]] = owner + 1; uB.push(lb[k]); got++; }
    return got;
  }
  function undoSim(st, uL, uB) {
    var i;
    for (i = 0; i < uL.length; i++) st.l[uL[i]] = 0;
    for (i = 0; i < uB.length; i++) st.b[uB[i]] = 0;
  }
  function freeLines(st) { var a = [], i; for (i = 0; i < NL; i++) if (!st.l[i]) a.push(i); return a; }
  function isFull(st) { var i; for (i = 0; i < NL; i++) if (!st.l[i]) return false; return true; }
  function boxCount(st, owner) { var n = 0, i; for (i = 0; i < NB; i++) if (st.b[i] === owner + 1) n++; return n; }
  /* Schnellster Weg zu einem geschenkten Kästchen: erstes Kästchen mit 3 Seiten. */
  function nextCapture(st) {
    var bi, e, n, miss, k;
    for (bi = 0; bi < NB; bi++) {
      e = BOX_LINES[bi]; n = 0; miss = -1;
      for (k = 0; k < 4; k++) { if (st.l[e[k]]) n++; else miss = e[k]; }
      if (n === 3) return miss;
    }
    return -1;
  }
  /* Alle Züge, die mindestens ein Kästchen schließen. */
  function capturingMoves(st, mv) {
    var out = [], i, lb, k, ok;
    for (i = 0; i < mv.length; i++) {
      lb = LINE_BOXES[mv[i]]; ok = false;
      for (k = 0; k < lb.length; k++) if (sidesOf(st, lb[k]) === 3) { ok = true; break; }
      if (ok) out.push(mv[i]);
    }
    return out;
  }
  /* Sichere Züge: danach hat kein Kästchen 3 Seiten -> der Gegner bekommt nichts geschenkt. */
  function safeMoves(st, mv) {
    var out = [], i, lb, k, bad;
    for (i = 0; i < mv.length; i++) {
      lb = LINE_BOXES[mv[i]]; bad = false;
      for (k = 0; k < lb.length; k++) if (sidesOf(st, lb[k]) === 2) { bad = true; break; }
      if (!bad) out.push(mv[i]);
    }
    return out;
  }

  /* ===================== Bot ===================== */
  /* Wie viele Kästchen kassiert der Gegner nach diesem Zug in einem Rutsch? */
  function giveAway(st, id) {
    var uL = [], uB = [], total = 0, guard = 0, cap;
    total += applySim(st, id, 0, uL, uB);
    while (guard++ < NL) { cap = nextCapture(st); if (cap < 0) break; total += applySim(st, cap, 0, uL, uB); }
    undoSim(st, uL, uB);
    return total;
  }
  /* Muss geopfert werden: die kleinste Kette abgeben. */
  function minSacrificeMove(st, mv) {
    var best = Infinity, ties = [], i, c;
    for (i = 0; i < mv.length; i++) {
      c = giveAway(st, mv[i]);
      if (c < best) { best = c; ties = [mv[i]]; }
      else if (c === best) ties.push(mv[i]);
    }
    return ties[(Math.random() * ties.length) | 0];
  }
  /* Wie viele Kästchen stehen nach dem Zug auf 2 Seiten (= Kettenmaterial)? */
  function twoSideCount(st, id) {
    var uL = [], uB = [], n = 0, bi;
    applySim(st, id, 0, uL, uB);
    for (bi = 0; bi < NB; bi++) if (sidesOf(st, bi) === 2) n++;
    undoSim(st, uL, uB);
    return n;
  }
  function pickSafe(st, safe) {
    var best = Infinity, ties = [], i, v;
    for (i = 0; i < safe.length; i++) {
      v = twoSideCount(st, safe[i]);
      if (v < best) { best = v; ties = [safe[i]]; }
      else if (v === best) ties.push(safe[i]);
    }
    return ties[(Math.random() * ties.length) | 0];
  }
  /* Feste Politik für die Ausspiel-Simulation: erst kassieren, dann sicher, sonst kleinstes Opfer. */
  function rolloutPick(st, mv) {
    var cap = nextCapture(st);
    if (cap >= 0) return cap;
    var safe = safeMoves(st, mv);
    if (safe.length) return safe[0];
    return minSacrificeMove(st, mv);
  }
  function rollout(st, side, scores) {
    var guard = 0, mv, id, got;
    while (guard++ < NL + 4) {
      mv = freeLines(st);
      if (!mv.length) return;
      id = rolloutPick(st, mv);
      got = playLine(st, id, side);
      scores[side] += got;
      if (got === 0) side = 1 - side;
    }
  }
  /* Jeden Kandidaten einmal zu Ende spielen und die Kästchen-Differenz vergleichen.
     Findet dadurch von allein Doppelkreuz-Züge (Kette bewusst nicht ganz leeren). */
  function bestByRollout(st0, cands) {
    var best = -Infinity, ties = [], i, st, got, scores, side, sc;
    for (i = 0; i < cands.length; i++) {
      st = cloneState(st0);
      scores = [0, 0];
      got = playLine(st, cands[i], 0);
      scores[0] += got;
      side = got > 0 ? 0 : 1;
      rollout(st, side, scores);
      sc = scores[0] - scores[1];
      if (sc > best) { best = sc; ties = [cands[i]]; }
      else if (sc === best) ties.push(cands[i]);
    }
    return ties[(Math.random() * ties.length) | 0];
  }
  function botMove(st, levelId) {
    var mv = freeLines(st);
    if (!mv.length) return -1;
    var caps, safe, cap;
    if (levelId === 'leicht') {
      cap = nextCapture(st);
      if (cap >= 0 && Math.random() < 0.72) return cap;      // übersieht das Geschenk manchmal
      safe = safeMoves(st, mv);
      if (safe.length && Math.random() < 0.55) return safe[(Math.random() * safe.length) | 0];
      return mv[(Math.random() * mv.length) | 0];
    }
    caps = capturingMoves(st, mv);
    safe = safeMoves(st, mv);
    if (levelId !== 'schwer') {
      if (caps.length) return caps[(Math.random() * caps.length) | 0];
      if (safe.length) return safe[(Math.random() * safe.length) | 0];
      return minSacrificeMove(st, mv);
    }
    /* Schwer: in der ruhigen Phase Kettenmaterial vermeiden, im Endspiel ausrechnen. */
    if (!caps.length && safe.length) return pickSafe(st, safe);
    if (mv.length <= ROLL_MAX) return bestByRollout(st, mv);
    if (caps.length) return caps[0];
    return minSacrificeMove(st, mv);
  }

  /* ===================== Kodierung für room.shared ===================== */
  function encArr(a) {
    var s = '', i;
    for (i = 0; i < a.length; i++) s += a[i] === 0 ? '.' : String(a[i] - 1);
    return s;
  }
  function decArr(s, len) {
    var a = new Int8Array(len), i, c;
    s = String(s || '');
    for (i = 0; i < len; i++) { c = s.charAt(i); a[i] = (c === '' || c === '.') ? 0 : (parseInt(c, 10) + 1); }
    return a;
  }
  function decodeShared(sh) { return { l: decArr(sh.lines, NL), b: decArr(sh.boxes, NB) }; }

  /* ===================== Geometrie-Helfer ===================== */
  function segDist(px, py, g) {
    var dx = g.x2 - g.x1, dy = g.y2 - g.y1;
    var len2 = dx * dx + dy * dy;
    var t = len2 ? ((px - g.x1) * dx + (py - g.y1) * dy) / len2 : 0;
    t = t < 0 ? 0 : (t > 1 ? 1 : t);
    var qx = g.x1 + t * dx - px, qy = g.y1 + t * dy - py;
    return Math.sqrt(qx * qx + qy * qy);
  }
  function roundRect(g, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    if (r < 0) r = 0;
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
  }
  function easeOut(p) { return 1 - Math.pow(1 - p, 3); }
  function initialOf(name) {
    var s = String(name || '?').replace(/^\s+/, '');
    return (s.charAt(0) || '?').toUpperCase();
  }
  function sfx(n) { if (App.Audio) App.Audio.sfx(n); }

  injectStyle();

  /* ===================== Registrierung ===================== */
  App.Minigames.dots = {
    id: 'dots', title: 'Käsekästchen', icon: '🔲', order: 102,
    subtitle: 'Linien ziehen, Kästchen holen, dran bleiben',
    single: true, multi: true, minPlayers: 2, maxPlayers: 4,

    render: function (root, ctx) {
      var isMulti = ctx.mode === 'multi';

      /* ---- Laufzeit ---- */
      var dead = false;
      var stops = [];           // room.off + App.MG-Stopper
      var pending = [];         // setTimeout-Ids
      var listeners = [];       // {t,ty,fn}
      var raf = null;

      /* ---- Ansicht ---- */
      var refs = null;          // DOM-Referenzen des Bretts
      var g2d = null;
      var view = 'none';        // 'setup' | 'board' | 'wait' | 'end'
      var shownL = new Int8Array(NL), shownB = new Int8Array(NB);
      var animL = {}, animB = {};
      var hoverId = -1, pendingId = -1;
      var lastLine = -1, lastAt = 0;
      var lastGain = null;      // {owner, n} für die Status-Rückmeldung

      /* ---- Spielzustand ---- */
      var st = newState();
      var seats = [];           // [{name, initial, mine}]
      var turnIdx = 0, myIdx = 0, over = false;
      var levelId = App.Storage ? App.Storage.get('dots_level', 'normal') : 'normal';

      /* ---- Multiplayer (muss VOR dem return stehen, sonst laufen die
             Initialwerte nie – var hoistet nur den Namen, nicht die Zuweisung) ---- */
      var room = null, lastShared = null, initDone = false;
      var seenMoves = -1;       // zuletzt verarbeiteter shared.moves-Zugzähler
      var reported = -1;        // zuletzt gemeldeter eigener Punktestand
      var endShown = false, firstSync = true;

      function after(ms, fn) { var t = setTimeout(function () { if (!dead) fn(); }, ms); pending.push(t); return t; }
      function clearPending() { pending.forEach(clearTimeout); pending = []; }
      function addL(t, ty, fn, o) { t.addEventListener(ty, fn, o); listeners.push({ t: t, ty: ty, fn: fn, o: o }); }
      function dropListeners() {
        listeners.forEach(function (l) { try { l.t.removeEventListener(l.ty, l.fn, l.o); } catch (e) {} });
        listeners = [];
      }
      function stopHelpers() { stops.forEach(function (f) { try { f(); } catch (e) {} }); stops = []; }
      function cleanup() {
        dead = true;
        if (raf) { cancelAnimationFrame(raf); raf = null; }
        clearPending(); stopHelpers(); dropListeners();
      }

      if (isMulti) startMulti(); else showSetup();
      return { cleanup: cleanup };

      /* =========================================================
       *  Gemeinsames Brett-Layout
       * ========================================================= */
      function buildStage() {
        var brand = el('div', { class: 'dot-brand neon' }, ['🔲 Käsekästchen']);
        var countEl = el('div', { class: 'dot-count' }, ['0 / ' + NB + ' Kästchen']);
        var top = el('div', { class: 'dot-top' }, [brand, countEl]);

        var chips = [], chipRow = el('div', { class: 'dot-chips dot-n' + seats.length });
        seats.forEach(function (s, i) {
          var badge = el('div', { class: 'dot-badge', style: 'background:' + rgba(i, 0.18) + ';color:' + rgba(i, 1) + ';border:1px solid ' + rgba(i, 0.55) + ';' }, [s.initial]);
          var nameEl = el('div', { class: 'dot-nm' }, [s.name + (s.mine ? ' (du)' : '')]);
          var scEl = el('div', { class: 'dot-sc', style: 'color:' + rgba(i, 1) + ';' }, ['0']);
          var chip = el('div', { class: 'dot-chip' }, [badge, el('div', { class: 'dot-info' }, [nameEl]), scEl]);
          chips.push({ root: chip, score: scEl });
          chipRow.appendChild(chip);
        });

        var statusEl = el('div', { class: 'dot-status dot-you' }, ['']);
        var canvas = el('canvas', { class: 'dot-canvas', width: W, height: H });
        var hint = el('p', { class: 'hint-text dot-hint' }, ['Zwischen zwei Punkte tippen = Linie · Kästchen schließen = Punkt + nochmal dran']);

        var extra = [];
        if (!isMulti) {
          extra.push(el('div', { class: 'controls-row dot-tools' }, [
            el('button', {
              class: 'btn btn-ghost dot-mini-btn', type: 'button', onclick: function () { sfx('click'); showSetup(); }
            }, ['⚙️ Stufe: ' + levelById(levelId).name]),
            el('button', {
              class: 'btn btn-ghost dot-mini-btn', type: 'button', onclick: function () { sfx('click'); startSolo(levelId); }
            }, ['↻ Neu'])
          ]));
        }

        var wrap = el('div', { class: 'dot-wrap' }, [top, chipRow, statusEl, canvas, hint].concat(extra));
        refs = { root: wrap, countEl: countEl, chips: chips, statusEl: statusEl, canvas: canvas };
        root.innerHTML = ''; root.appendChild(wrap);

        g2d = canvas.getContext('2d');
        addL(canvas, 'pointerdown', onDown);
        addL(canvas, 'pointermove', onMove);
        addL(canvas, 'pointerleave', onLeave);
        addL(canvas, 'contextmenu', function (e) { e.preventDefault(); });

        if (raf) cancelAnimationFrame(raf);
        raf = requestAnimationFrame(frame);
      }

      /* ---- Eingabe ---- */
      function toVirt(e) {
        var r = refs.canvas.getBoundingClientRect();
        return { x: (e.clientX - r.left) / r.width * W, y: (e.clientY - r.top) / r.height * H };
      }
      function nearestFree(x, y) {
        var best = -1, bd = HIT, i, d;
        for (i = 0; i < NL; i++) {
          if (shownL[i]) continue;
          d = segDist(x, y, LINE_GEO[i]);
          if (d < bd) { bd = d; best = i; }
        }
        return best;
      }
      function myTurn() { return !over && turnIdx === myIdx && myIdx >= 0; }
      function onMove(e) {
        if (dead || !refs) return;
        if (!myTurn()) { hoverId = -1; return; }
        var p = toVirt(e);
        hoverId = nearestFree(p.x, p.y);
      }
      function onLeave() { hoverId = -1; }
      function onDown(e) {
        if (dead || !refs) return;
        if (e.preventDefault) e.preventDefault();
        if (!myTurn()) {
          if (!over) UI.toast('Warte – du bist nicht dran', 'info');
          return;
        }
        var p = toVirt(e);
        var id = nearestFree(p.x, p.y);
        if (id < 0) { hoverId = -1; return; }
        hoverId = -1;
        if (isMulti) submitMulti(id); else soloPlace(id, 0);
      }

      /* ---- Zustand -> Ansicht übernehmen (mit Animation + Ton) ---- */
      function syncVisual(quiet) {
        var i, newLines = 0, newBoxes = 0, gainOwner = -1, now = Date.now();
        for (i = 0; i < NL; i++) {
          if (st.l[i] === shownL[i]) continue;
          if (st.l[i] && !quiet) { animL[i] = now; newLines++; }
          shownL[i] = st.l[i];
        }
        for (i = 0; i < NB; i++) {
          if (st.b[i] === shownB[i]) continue;
          if (st.b[i] && !quiet) { animB[i] = now; newBoxes++; gainOwner = st.b[i] - 1; }
          shownB[i] = st.b[i];
        }
        if (quiet) { lastGain = null; return; }
        if (newBoxes > 0) {
          lastGain = { owner: gainOwner, n: newBoxes };
          sfx('point');
          if (App.Audio) App.Audio.blip(newBoxes > 1 ? 880 : 660, 0.12);
        } else if (newLines > 0) {
          lastGain = null;
          if (App.Audio) App.Audio.blip(300 + turnIdx * 45, 0.06);
        }
      }

      /* ---- Kopf/Chips/Status aktualisieren ---- */
      function paintHud() {
        if (!refs) return;
        var i, taken = 0;
        for (i = 0; i < NB; i++) if (shownB[i]) taken++;
        refs.countEl.textContent = taken + ' / ' + NB + ' Kästchen';
        for (i = 0; i < refs.chips.length; i++) {
          var c = refs.chips[i];
          c.score.textContent = String(boxCount({ l: shownL, b: shownB }, i));
          var active = !over && i === turnIdx;
          c.root.classList.toggle('dot-active', active);
          c.root.style.borderColor = active ? rgba(i, 0.85) : '';
          c.root.style.boxShadow = active ? '0 0 16px ' + rgba(i, 0.35) : '';
        }
        var s = statusText();
        refs.statusEl.textContent = s.text;
        refs.statusEl.className = 'dot-status ' + s.cls;
        refs.statusEl.style.color = s.color || '';
        refs.canvas.classList.toggle('dot-live', myTurn());
      }
      function statusText() {
        if (over) return { text: '🏁 Alle Linien liegen!', cls: 'dot-done' };
        if (myIdx < 0) {
          return { text: '👀 Du schaust zu – ' + seats[turnIdx].name + ' ist dran', cls: 'dot-opp', color: rgba(turnIdx, 1) };
        }
        var mine = turnIdx === myIdx;
        var who = mine ? 'Du bist' : seats[turnIdx].name + ' ist';
        if (lastGain && lastGain.owner === turnIdx) {
          return {
            text: '+' + lastGain.n + ' Kästchen! ' + who + ' nochmal dran',
            cls: mine ? 'dot-gain' : 'dot-opp', color: rgba(turnIdx, 1)
          };
        }
        if (!isMulti && turnIdx === 1) return { text: '🤖 Bot überlegt …', cls: 'dot-opp', color: rgba(1, 1) };
        return { text: who + ' dran', cls: mine ? 'dot-you' : 'dot-opp', color: rgba(turnIdx, 1) };
      }

      /* ---- Zeichnen ---- */
      function frame() {
        if (dead) return;
        draw();
        raf = requestAnimationFrame(frame);
      }
      function draw() {
        if (!g2d) return;
        var t = Date.now(), i;
        var grd = g2d.createRadialGradient(W / 2, H * 0.4, 30, W / 2, H / 2, W * 0.78);
        grd.addColorStop(0, '#0a2618'); grd.addColorStop(1, '#03110b');
        g2d.fillStyle = grd; g2d.fillRect(0, 0, W, H);

        /* leichtes Raster als Orientierung */
        g2d.strokeStyle = 'rgba(57,255,20,0.06)'; g2d.lineWidth = 1;
        for (i = 0; i <= GRID; i++) {
          g2d.beginPath(); g2d.moveTo(PAD + i * S, PAD); g2d.lineTo(PAD + i * S, H - PAD); g2d.stroke();
          g2d.beginPath(); g2d.moveTo(PAD, PAD + i * S); g2d.lineTo(W - PAD, PAD + i * S); g2d.stroke();
        }

        for (i = 0; i < NB; i++) if (shownB[i]) drawBox(i, shownB[i] - 1, t);
        for (i = 0; i < NL; i++) if (shownL[i]) drawLine(i, shownL[i] - 1, t);
        drawGhosts(t);
        drawDots(t);
      }
      function drawBox(bi, o, t) {
        var p = animB[bi] ? Math.min(1, (t - animB[bi]) / 340) : 1;
        var e = easeOut(p);
        var r = Math.floor(bi / GRID), c = bi % GRID;
        var x = PAD + c * S, y = PAD + r * S;
        var inset = 7 + (1 - e) * (S * 0.3);
        g2d.globalAlpha = 0.25 + 0.75 * e;
        roundRect(g2d, x + inset, y + inset, S - 2 * inset, S - 2 * inset, 12);
        g2d.fillStyle = rgba(o, 0.16 + 0.1 * e);
        g2d.fill();
        g2d.strokeStyle = rgba(o, 0.4); g2d.lineWidth = 2; g2d.stroke();
        g2d.fillStyle = rgba(o, 0.85);
        g2d.font = '900 ' + Math.round(30 * (0.55 + 0.45 * e)) + 'px system-ui,-apple-system,sans-serif';
        g2d.textAlign = 'center'; g2d.textBaseline = 'middle';
        g2d.fillText(seatInitial(o), x + S / 2, y + S / 2 + 1);
        if (p < 1) {   // aufploppender Leuchtring
          g2d.globalAlpha = 1 - p;
          roundRect(g2d, x + 4 - 10 * p, y + 4 - 10 * p, S - 8 + 20 * p, S - 8 + 20 * p, 14);
          g2d.strokeStyle = rgba(o, 0.9); g2d.lineWidth = 3; g2d.stroke();
        }
        g2d.globalAlpha = 1;
      }
      function drawLine(id, o, t) {
        var p = animL[id] ? Math.min(1, (t - animL[id]) / 200) : 1;
        var e = easeOut(p);
        var G = LINE_GEO[id];
        var x2 = G.x1 + (G.x2 - G.x1) * e, y2 = G.y1 + (G.y2 - G.y1) * e;
        var boost = (id === lastLine && t - lastAt < 1100) ? (0.5 + 0.5 * Math.sin((t - lastAt) / 90)) : 0;
        g2d.lineCap = 'round';
        g2d.strokeStyle = rgba(o, 0.13 + 0.12 * boost);
        g2d.lineWidth = 17 + 5 * boost;
        g2d.beginPath(); g2d.moveTo(G.x1, G.y1); g2d.lineTo(x2, y2); g2d.stroke();
        g2d.strokeStyle = rgba(o, 0.95);
        g2d.lineWidth = 8;
        g2d.beginPath(); g2d.moveTo(G.x1, G.y1); g2d.lineTo(x2, y2); g2d.stroke();
      }
      function drawGhosts(t) {
        var ids = [], o = myIdx >= 0 ? myIdx : 0, i, G;
        if (pendingId >= 0 && !shownL[pendingId]) ids.push({ id: pendingId, a: 0.5 });
        if (hoverId >= 0 && !shownL[hoverId] && hoverId !== pendingId && myTurn()) {
          ids.push({ id: hoverId, a: 0.28 + 0.14 * Math.sin(t / 200) });
        }
        for (i = 0; i < ids.length; i++) {
          G = LINE_GEO[ids[i].id];
          g2d.lineCap = 'round'; g2d.lineWidth = 8;
          g2d.strokeStyle = rgba(o, ids[i].a);
          g2d.setLineDash([9, 9]);
          g2d.beginPath(); g2d.moveTo(G.x1, G.y1); g2d.lineTo(G.x2, G.y2); g2d.stroke();
          g2d.setLineDash([]);
        }
      }
      function drawDots(t) {
        var r, c, x, y, pulse = 0.55 + 0.2 * Math.sin(t / 700);
        for (r = 0; r <= GRID; r++) {
          for (c = 0; c <= GRID; c++) {
            x = PAD + c * S; y = PAD + r * S;
            g2d.beginPath(); g2d.arc(x, y, 7, 0, Math.PI * 2);
            g2d.fillStyle = 'rgba(3,17,11,0.95)'; g2d.fill();
            g2d.strokeStyle = 'rgba(57,255,20,' + pulse.toFixed(3) + ')'; g2d.lineWidth = 1.5; g2d.stroke();
            g2d.beginPath(); g2d.arc(x, y, 3.2, 0, Math.PI * 2);
            g2d.fillStyle = 'rgba(157,255,122,0.95)'; g2d.fill();
          }
        }
      }
      function seatInitial(o) { return seats[o] ? seats[o].initial : '?'; }

      /* =========================================================
       *  SOLO — Stufenwahl + Spiel gegen den Bot
       * ========================================================= */
      function showSetup() {
        clearPending();
        if (raf) { cancelAnimationFrame(raf); raf = null; }
        dropListeners();
        view = 'setup'; refs = null; g2d = null;
        var btns = LEVELS.map(function (lv) {
          return el('button', {
            class: 'dot-lvl' + (lv.id === levelId ? ' dot-lvl-on' : ''), type: 'button',
            onclick: function () { sfx('select'); startSolo(lv.id); }
          }, [
            el('span', { class: 'dot-lvl-ic' }, [lv.icon]),
            el('span', { class: 'dot-lvl-nm' }, [lv.name]),
            el('span', { class: 'dot-lvl-d' }, [lv.desc]),
            el('span', { class: 'dot-lvl-b' }, ['Sieg-Bonus +' + lv.bonus])
          ]);
        });
        var best = App.Storage ? App.Storage.get('best_dots', 0) : 0;
        root.innerHTML = '';
        root.appendChild(el('div', { class: 'dot-panel glass' }, [
          el('div', { class: 'dot-panel-ic' }, ['🔲']),
          el('h2', { class: 'neon' }, ['Käsekästchen']),
          el('p', { class: 'hint-text' }, ['Zieh reihum eine Linie zwischen zwei Punkten. Wer ein Kästchen schließt, bekommt es und ist sofort nochmal dran. Am Ende gewinnen die meisten Kästchen.']),
          el('div', { class: 'mg-field-title' }, ['🤖 Bot-Stufe wählen']),
          el('div', { class: 'dot-lvls' }, btns),
          el('p', { class: 'hint-text' }, ['Punkte: Kästchen × 10 + Sieg-Bonus · Bestwert: ' + App.MG.fmt(best)]),
          el('div', { class: 'controls-row' }, [
            el('button', { class: 'btn btn-ghost', type: 'button', onclick: ctx.onExit }, ['Zurück'])
          ])
        ]));
      }

      function startSolo(lv) {
        clearPending();
        levelId = levelById(lv).id;
        if (App.Storage) App.Storage.set('dots_level', levelId);
        dropListeners();
        view = 'board';
        st = newState();
        shownL = new Int8Array(NL); shownB = new Int8Array(NB);
        animL = {}; animB = {};
        hoverId = -1; pendingId = -1; lastLine = -1; lastGain = null; over = false;
        turnIdx = 0; myIdx = 0;
        seats = [
          { name: (ctx.me && ctx.me.name) ? ctx.me.name : 'Du', initial: initialOf((ctx.me && ctx.me.name) ? ctx.me.name : 'Du'), mine: true },
          { name: 'Bot ' + levelById(levelId).icon, initial: 'B', mine: false }
        ];
        buildStage();
        paintHud();
        sfx('start');
      }

      function soloPlace(id, owner) {
        if (dead || over || st.l[id]) return;
        var got = playLine(st, id, owner);
        lastLine = id; lastAt = Date.now();
        syncVisual(false);
        if (got === 0) turnIdx = 1 - turnIdx;
        if (isFull(st)) { over = true; paintHud(); after(1300, finishSolo); return; }
        paintHud();
        if (turnIdx === 1) scheduleBot(got > 0);
      }
      function scheduleBot(chained) {
        after(chained ? 300 : 480 + Math.random() * 260, function () {
          if (dead || over || turnIdx !== 1) return;
          var id = botMove(st, levelId);
          if (id < 0) return;
          soloPlace(id, 1);
        });
      }
      function finishSolo() {
        if (dead) return;
        if (raf) { cancelAnimationFrame(raf); raf = null; }
        dropListeners();
        view = 'end';
        var mine = boxCount(st, 0), his = boxCount(st, 1);
        var lv = levelById(levelId);
        var won = mine > his, tie = mine === his;
        var score = mine * 10 + (won ? lv.bonus : 0);
        var best = App.Storage ? App.Storage.get('best_dots', 0) : 0;
        var nb = score > best;
        if (nb && App.Storage) App.Storage.set('best_dots', score);
        sfx(won ? 'win' : tie ? 'ding' : 'lose');
        var res = won ? '🏆 Sieg' : tie ? '🤝 Unentschieden' : '💀 Niederlage';
        App.MG.endScreen(root, {
          title: won ? '🏆 Gewonnen!' : tie ? '🤝 Unentschieden' : '💀 Verloren',
          score: score, best: best, newBest: nb,
          label: res + ' · Du ' + mine + ' : ' + his + ' Bot · Stufe ' + lv.name
            + (nb ? ' · neuer Rekord! 🎉' : ' · Bestwert: ' + App.MG.fmt(best)),
          onExit: ctx.onExit,
          onAgain: function () { startSolo(levelId); }
        });
      }

      /* =========================================================
       *  MULTI — Host ist Schiedsrichter, alle rendern aus 'shared'
       * ========================================================= */
      function startMulti() {
        var snap = ctx.room.snapshot() || {};
        var startAt = (snap.round && snap.round.startAt) || (ctx.room.now() + 3000);
        stops.push(App.MG.countdown(root, startAt, function () { playMulti(); }, ctx.room.now));
      }

      function playMulti() {
        room = ctx.room;
        lastShared = (room.snapshot() && room.snapshot().shared) || null;
        var onShared = function (sh) { if (dead) return; lastShared = sh; syncMulti(); };
        var onPlayers = function () { if (dead) return; syncMulti(); };
        room.on('shared', onShared);
        room.on('players', onPlayers);
        stops.push(function () { room.off('shared', onShared); room.off('players', onPlayers); });
        syncMulti();
      }

      function playerById(players, id) { var i; for (i = 0; i < players.length; i++) if (players[i].id === id) return players[i]; return null; }

      function syncMulti() {
        if (dead || endShown) return;
        var players = room.players();
        var sh = lastShared;

        /* 'starting' = das Brett kommt gleich (genug Spieler da bzw. shared schon
           angelegt). Ein Host, der allein im Raum sitzt, wartet dagegen wirklich. */
        if (!sh || !sh.lines || !sh.order || !sh.order.length) {
          if (room.isHost() && players.length >= 2 && !initDone) { initShared(players); return; }
          showWaiting(players, !!((sh && sh.lines) || players.length >= 2));
          return;
        }
        hostTick(players, sh);

        var order = [].concat(sh.order);
        if (order.length < 2) { showWaiting(players, players.length >= 2); return; }

        /* Sitze aus der Reihenfolge aufbauen (einmalig, danach nur Werte anpassen) */
        if (view !== 'board' || seats.length !== order.length) {
          seats = order.map(function (pid) {
            var p = playerById(players, pid);
            var nm = p ? p.name : 'Spieler';
            return { name: nm, initial: initialOf(nm), mine: pid === ctx.me.id };
          });
          myIdx = order.indexOf(ctx.me.id);
          view = 'board';
          firstSync = true;
          buildStage();
        }
        myIdx = order.indexOf(ctx.me.id);

        var nowState = decodeShared(sh);
        var moves = sh.moves || 0;
        var changed = moves !== seenMoves;
        st = nowState;
        turnIdx = order.indexOf(sh.turn);
        if (turnIdx < 0) turnIdx = 0;
        over = !!sh.over;

        if (changed) {
          if (typeof sh.last === 'number' && sh.last >= 0) { lastLine = sh.last; lastAt = Date.now(); }
          syncVisual(firstSync);
          seenMoves = moves;
          firstSync = false;
          if (pendingId >= 0 && shownL[pendingId]) pendingId = -1;
        }
        paintHud();

        /* Eigene Kästchen als Punktestand melden (nur bei Änderung) */
        if (myIdx >= 0) {
          var mine = boxCount(st, myIdx);
          if (mine !== reported) { reported = mine; room.reportScore(mine); }
        }

        if (over && !endShown) {
          endShown = true;
          sfx('win');
          after(1400, finishMulti);
        }
      }

      function initShared(players) {
        initDone = true;
        var order = players.slice(0, 4).map(function (p) { return p.id; });
        room.setShared({
          order: order, lines: encArr(new Int8Array(NL)), boxes: encArr(new Int8Array(NB)),
          turn: order[0], last: -1, lastBy: -1, moves: 0, over: false
        });
      }

      /* Host: Zug-Wünsche der Gäste prüfen + Zug weiterreichen, wenn jemand fehlt. */
      function hostTick(players, sh) {
        if (!room.isHost() || sh.over) return;
        var present = {}, i;
        for (i = 0; i < players.length; i++) present[players[i].id] = 1;
        var order = [].concat(sh.order);
        var alive = order.filter(function (id) { return present[id]; });
        if (alive.length < 2) { room.setShared({ over: true }); return; }
        if (!present[sh.turn]) { room.setShared({ turn: nextSeat(order, present, order.indexOf(sh.turn)) }); return; }
        for (i = 0; i < players.length; i++) {
          var p = players[i], s = p.state;
          if (!s || typeof s.move !== 'number') continue;
          if (p.id !== sh.turn) continue;
          if ((s.at | 0) !== (sh.moves || 0)) continue;   // alter/abgelaufener Wunsch -> ignorieren
          applyMoveHost(sh, s.move | 0, p.id);
          return;
        }
      }
      function nextSeat(order, present, from) {
        var n = order.length, k, cand;
        for (k = 1; k <= n; k++) {
          cand = order[((from < 0 ? 0 : from) + k) % n];
          if (present[cand]) return cand;
        }
        return order[0];
      }
      function applyMoveHost(sh, id, playerId) {
        if (id < 0 || id >= NL) return;
        var order = [].concat(sh.order), idx = order.indexOf(playerId);
        if (idx < 0) return;
        var s = decodeShared(sh);
        if (s.l[id] !== 0) return;                        // Linie schon belegt -> ungültig
        var got = playLine(s, id, idx);
        var present = {}, players = room.players(), i;
        for (i = 0; i < players.length; i++) present[players[i].id] = 1;
        var turn = got > 0 ? playerId : nextSeat(order, present, idx);
        var patch = {
          lines: encArr(s.l), boxes: encArr(s.b), turn: turn,
          last: id, lastBy: idx, moves: (sh.moves || 0) + 1
        };
        if (isFull(s)) patch.over = true;
        room.setShared(patch);
        /* Lokal sofort weiterschalten: der Host schreibt 'shared' selbst, das
           Echo kommt aber erst übers Netz zurück. Wer ein Kästchen schließt,
           ist SOFORT nochmal dran – klickt er die nächste Linie, bevor das Echo
           da ist, würde submitMulti/applyMoveHost sonst auf dem ALTEN Brett
           rechnen und den gerade gespielten Zug (gleiche moves-Nummer!)
           überschreiben. Darum lastShared optimistisch mitziehen. */
        var merged = {}, mk;
        for (mk in sh) if (Object.prototype.hasOwnProperty.call(sh, mk)) merged[mk] = sh[mk];
        for (mk in patch) if (Object.prototype.hasOwnProperty.call(patch, mk)) merged[mk] = patch[mk];
        lastShared = merged;
      }

      function submitMulti(id) {
        var sh = lastShared;
        if (!sh || sh.over || !sh.lines) return;
        if (sh.turn !== ctx.me.id) { UI.toast('Warte – du bist nicht dran', 'info'); return; }
        if (shownL[id]) return;
        pendingId = id;
        if (room.isHost()) applyMoveHost(sh, id, ctx.me.id);
        else room.reportState({ move: id, at: sh.moves || 0 });
        if (App.Audio) App.Audio.blip(420, 0.05);
      }

      function showWaiting(players, starting) {
        if (view !== 'wait') {
          view = 'wait'; refs = null; g2d = null;
          if (raf) { cancelAnimationFrame(raf); raf = null; }
          dropListeners();
          root.innerHTML = '';
          root.appendChild(el('div', { class: 'dot-panel glass' }, [
            el('div', { class: 'dot-panel-ic dot-spin' }, ['🔲']),
            el('h2', { class: 'neon' }, ['Käsekästchen']),
            el('div', { class: 'dot-wait-n big-readout' }, ['1 / 2']),
            el('p', { class: 'hint-text dot-wait-msg' }, ['']),
            el('div', { class: 'controls-row' }, [
              el('button', { class: 'btn btn-ghost', type: 'button', onclick: ctx.onExit }, ['Zurück zur Lobby'])
            ])
          ]));
        }
        var n = root.querySelector('.dot-wait-n'), m = root.querySelector('.dot-wait-msg');
        if (n) n.textContent = players.length + ' / 2';
        if (m) m.textContent = starting ? 'Brett wird aufgebaut …' : 'Warte auf mindestens einen Mitspieler …';
      }

      function finishMulti() {
        if (dead) return;
        if (raf) { cancelAnimationFrame(raf); raf = null; }
        dropListeners();
        stopHelpers();
        view = 'end';
        App.MG.endScreen(root, { players: room.players(), meId: ctx.me.id, onExit: ctx.onExit });
      }
    }
  };

  /* ===================== CSS ===================== */
  function injectStyle() {
    UI.injectStyle('mg-dots-css', [
      '.dot-wrap{display:flex;flex-direction:column;gap:11px;max-width:540px;margin:0 auto;}',
      '.dot-top{display:flex;justify-content:space-between;align-items:center;gap:10px;}',
      '.dot-brand{font-weight:900;font-size:18px;}',
      '.dot-count{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;font-weight:800;white-space:nowrap;}',
      /* Spieler-Chips */
      '.dot-chips{display:grid;gap:8px;grid-template-columns:repeat(2,minmax(0,1fr));}',
      '.dot-chips.dot-n3,.dot-chips.dot-n4{grid-template-columns:repeat(2,minmax(0,1fr));}',
      '@media(min-width:520px){.dot-chips.dot-n3{grid-template-columns:repeat(3,minmax(0,1fr));}',
      '.dot-chips.dot-n4{grid-template-columns:repeat(4,minmax(0,1fr));}}',
      '.dot-chip{display:flex;align-items:center;gap:8px;padding:7px 10px;border-radius:13px;',
      'background:rgba(9,32,21,.6);border:1px solid var(--stroke);min-width:0;transition:border-color .16s,box-shadow .16s,transform .16s;}',
      '.dot-chip.dot-active{transform:translateY(-1px);}',
      '.dot-chip.dot-active .dot-badge{animation:dot-bob .9s ease-in-out infinite;}',
      '.dot-badge{width:26px;height:26px;border-radius:8px;display:flex;align-items:center;justify-content:center;',
      'font-weight:900;font-size:14px;flex:none;line-height:1;}',
      '.dot-info{flex:1;min-width:0;}',
      '.dot-nm{font-weight:800;font-size:12.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      '.dot-sc{font-size:20px;font-weight:900;font-variant-numeric:tabular-nums;line-height:1;}',
      '@keyframes dot-bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-3px)}}',
      /* Status */
      '.dot-status{text-align:center;font-weight:900;font-size:clamp(15px,4.2vw,19px);min-height:24px;line-height:1.2;}',
      '.dot-status.dot-you{text-shadow:0 0 10px var(--stroke-2);}',
      '.dot-status.dot-gain{animation:dot-punch .35s ease;text-shadow:0 0 14px var(--stroke-2);}',
      '.dot-status.dot-done{color:var(--gold);text-shadow:0 0 12px rgba(255,210,63,.5);}',
      '@keyframes dot-punch{0%{transform:scale(.86)}55%{transform:scale(1.09)}100%{transform:scale(1)}}',
      /* Brett */
      '.dot-canvas{display:block;width:100%;max-width:520px;height:auto;margin:0 auto;border-radius:20px;',
      'border:1px solid var(--stroke);background:#03110b;touch-action:none;cursor:default;',
      '-webkit-tap-highlight-color:transparent;user-select:none;-webkit-user-select:none;',
      'box-shadow:0 0 26px rgba(0,0,0,.45),inset 0 0 40px rgba(57,255,20,.05);transition:border-color .2s,box-shadow .2s;}',
      '.dot-canvas.dot-live{cursor:crosshair;border-color:var(--stroke-2);box-shadow:0 0 30px rgba(57,255,20,.18),inset 0 0 40px rgba(57,255,20,.06);}',
      '.dot-hint{text-align:center;margin:0;font-size:12px;}',
      '.dot-tools{justify-content:center;}',
      '.dot-mini-btn{font-size:12px;padding:7px 12px;}',
      /* Panels (Stufenwahl / Warten) */
      '.dot-panel{padding:26px 22px;text-align:center;display:flex;flex-direction:column;gap:12px;',
      'align-items:center;max-width:480px;margin:0 auto;}',
      '.dot-panel-ic{font-size:46px;line-height:1;filter:drop-shadow(0 0 12px var(--stroke-2));}',
      '.dot-spin{animation:dot-spin 3s linear infinite;}',
      '@keyframes dot-spin{to{transform:rotate(360deg);}}',
      '.dot-panel h2{margin:0;}',
      '.dot-panel .hint-text{margin:0;}',
      '.dot-lvls{display:flex;flex-direction:column;gap:8px;width:100%;}',
      '.dot-lvl{display:grid;grid-template-columns:auto 1fr auto;grid-template-rows:auto auto;gap:2px 10px;',
      'align-items:center;text-align:left;padding:10px 13px;border-radius:14px;cursor:pointer;font-family:inherit;',
      'background:rgba(9,32,21,.55);border:1px solid var(--stroke);color:var(--text);transition:.15s;}',
      '.dot-lvl:hover{border-color:var(--neon);box-shadow:0 0 16px rgba(57,255,20,.25);transform:translateY(-1px);}',
      '.dot-lvl:active{transform:scale(.985);}',
      '.dot-lvl-on{border-color:var(--stroke-2);background:rgba(15,52,33,.7);}',
      '.dot-lvl-ic{grid-row:1/3;font-size:24px;line-height:1;}',
      '.dot-lvl-nm{font-weight:900;font-size:15px;color:var(--leaf);}',
      '.dot-lvl-d{grid-column:2;font-size:11.5px;color:var(--muted);line-height:1.25;}',
      '.dot-lvl-b{grid-row:1/3;grid-column:3;font-size:11px;font-weight:800;color:var(--gold);white-space:nowrap;}',
      '.dot-wait-n{color:var(--aqua);}'
    ].join(''));
  }
})();
