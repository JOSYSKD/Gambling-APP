/* backgammon.js — "Backgammon": das klassische Laufspiel im Neon-Dschungel.
 *
 * IDEE
 *   Brett mit 24 Zungen, je 15 Steine. Grün (🟢) läuft von Punkt 23 nach 0 und
 *   würfelt seine Steine im Heimfeld unten rechts aus; Türkis (🩵) läuft von 0
 *   nach 23 und wirft oben rechts aus. Zwei Würfel, Pasch = vier Züge. Ein
 *   einzeln stehender Stein (Blot) wird geschlagen, wandert auf den Balken und
 *   muss zuerst wieder eintreten. Wer zuerst alle 15 Steine draußen hat, gewinnt
 *   — einfach (1), Gammon (2, Verlierer hat keinen Stein draußen) oder
 *   Backgammon (3, zusätzlich noch auf dem Balken/im gegnerischen Heim).
 *   Alle Regeln sind drin: Eröffnungswurf, Eintreten vom Balken, Zwang beide
 *   Würfel zu nutzen (und den höheren, wenn nur einer geht), exaktes und
 *   überzähliges Auswürfeln.
 *
 * STEUERUNG
 *   Eigenen Stein antippen (oder anfassen) → alle legalen Ziele leuchten gold →
 *   Ziel antippen bzw. Stein dorthin ziehen. Ziehen und Tippen gehen beide, per
 *   Maus wie per Finger (Pointer-Events, touch-action:none auf dem Brett).
 *   "🎲 Würfeln" wirft, "↶ Zurück" nimmt Züge des laufenden Wurfs zurück.
 *
 * PUNKTE
 *   Sieg zählt: Niederlage = 0. Sieg = Siegpunkte (1/2/3) × 100 × Stufe
 *   + Pip-Vorsprung. Solo-Bestwert in App.Storage('best_backgammon').
 *
 * SYNC-MODELL
 *   Rundenbasiert über room.shared — flach und als kompakte Strings kodiert
 *   (Firebase-freundlich): b = Brett, dice/rolled = Würfel, turn/phase/winner,
 *   hist = Undo-Stapel, seq + lastF/lastT/lastC/lastHit = letzter Zug (treibt
 *   Animation und Sound auf BEIDEN Geräten). Es schreibt immer nur der Spieler,
 *   der am Zug ist (kein Host-Server nötig); der Host legt nur die Startstellung
 *   samt Eröffnungswurf an. Alle Handler sind idempotent: gerendert wird in
 *   place, animiert/geklungen wird nur bei einer NEUEN seq — die Heartbeats
 *   (alle 4 s) lösen also nichts aus.
 *   SOLO läuft über exakt dieselbe Zustandsmaschine, nur schreibt commit()
 *   lokal statt ins Netz — und ein Bot mit Heuristik (Blots vermeiden, Punkte
 *   bauen, schlagen, Primes) zieht in 3 Stufen.
 */
(function () {
  'use strict';
  window.App = window.App || {}; App.Minigames = App.Minigames || {};
  var UI = App.UI, el = UI.el;

  injectStyle();

  /* ===================== Konstanten ===================== */
  var WHITE = 'W', BLACK = 'B';
  var BAR_FROM = -1, OFF_TO = 24;          // Sonder-Felder für from/to

  /* Virtuelles Brett (Canvas skaliert per CSS) */
  var BW = 900, BH = 560;
  var MG = 12;                              // Rand
  var TRAY = 62;                            // Ablage rechts (ausgewürfelte Steine)
  var BARW = 44;                            // Mittelbalken
  var PW = (BW - 2 * MG - TRAY - BARW) / 12; // Zungenbreite
  var CR = PW * 0.44;                       // Steinradius
  var TRIH = BH * 0.42;                     // Zungenhöhe
  var RIGHT0 = MG + 6 * PW + BARW;          // linke Kante der rechten Bretthälfte
  var BARX = MG + 6 * PW + BARW / 2;        // Mitte Balken
  var TRAYX = BW - MG - TRAY;               // linke Kante der Ablage

  var MOVE_MS = 240;                        // Dauer der Zug-Animation
  var LEVELS = [
    { name: 'Grünschnabel', icon: '🌱', hint: 'Zieht oft irgendwas — gut zum Reinkommen' },
    { name: 'Dschungelfuchs', icon: '🦊', hint: 'Spielt solide, patzt aber ab und zu' },
    { name: 'Neon-Meister', icon: '👑', hint: 'Deckt Blots, baut Primes, schlägt gnadenlos' }
  ];
  var DIE_PIPS = { 1: [4], 2: [0, 8], 3: [0, 4, 8], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8] };

  /* ===================== Brett-Logik (rein) ===================== */
  function other(c) { return c === WHITE ? BLACK : WHITE; }
  function dirOf(c) { return c === WHITE ? -1 : 1; }
  function pipOf(c, p) { return c === WHITE ? p + 1 : 24 - p; }       // Restweg bis raus
  function inHome(c, p) { return c === WHITE ? (p >= 0 && p <= 5) : (p >= 18 && p <= 23); }
  function entryPoint(c, d) { return c === WHITE ? 24 - d : d - 1; }  // Eintritt vom Balken
  function r6() { return 1 + Math.floor(Math.random() * 6); }

  function newBoard() {
    var pts = [], i;
    for (i = 0; i < 24; i++) pts.push(0);
    pts[23] = 2; pts[12] = 5; pts[7] = 3; pts[5] = 5;        // Grün = positiv
    pts[0] = -2; pts[11] = -5; pts[16] = -3; pts[18] = -5;   // Türkis = negativ
    return { pts: pts, bar: { W: 0, B: 0 }, off: { W: 0, B: 0 } };
  }
  function cloneBoard(b) {
    return { pts: b.pts.slice(), bar: { W: b.bar.W, B: b.bar.B }, off: { W: b.off.W, B: b.off.B } };
  }
  function countAt(b, p, c) { var v = b.pts[p]; return c === WHITE ? (v > 0 ? v : 0) : (v < 0 ? -v : 0); }
  function ownerAt(b, p) { var v = b.pts[p]; return v > 0 ? WHITE : v < 0 ? BLACK : null; }
  function canLand(b, p, c) { return countAt(b, p, other(c)) <= 1; }
  function allHome(b, c) {
    if (b.bar[c] > 0) return false;
    for (var p = 0; p < 24; p++) if (countAt(b, p, c) > 0 && !inHome(c, p)) return false;
    return true;
  }
  function maxPip(b, c) {
    var m = 0, q;
    for (var p = 0; p < 24; p++) if (countAt(b, p, c) > 0) { q = pipOf(c, p); if (q > m) m = q; }
    return m;
  }
  function pipCount(b, c) {
    var s = b.bar[c] * 25;
    for (var p = 0; p < 24; p++) s += countAt(b, p, c) * pipOf(c, p);
    return s;
  }

  /* Alle Einzelzüge, die die Brettregeln erlauben (ohne Würfel-Ausnutzungszwang). */
  function genMoves(b, c, dice) {
    var out = [], ds = [], i, d, p, t, pv;
    for (i = 0; i < dice.length; i++) if (ds.indexOf(dice[i]) < 0) ds.push(dice[i]);
    if (b.bar[c] > 0) {                                   // Balken zuerst räumen
      for (i = 0; i < ds.length; i++) {
        d = ds[i]; t = entryPoint(c, d);
        if (canLand(b, t, c)) out.push({ from: BAR_FROM, to: t, die: d });
      }
      return out;
    }
    var home = allHome(b, c), mx = home ? maxPip(b, c) : 0;
    for (p = 0; p < 24; p++) {
      if (countAt(b, p, c) <= 0) continue;
      for (i = 0; i < ds.length; i++) {
        d = ds[i]; t = p + dirOf(c) * d;
        if (t >= 0 && t <= 23) {
          if (canLand(b, t, c)) out.push({ from: p, to: t, die: d });
        } else if (home) {
          pv = pipOf(c, p);
          // exakt auswürfeln — oder mit größerem Würfel, wenn kein Stein weiter hinten steht
          if (pv === d || (d > pv && pv === mx)) out.push({ from: p, to: OFF_TO, die: d });
        }
      }
    }
    return out;
  }

  function wasHit(b, c, m) { return m.to !== OFF_TO && countAt(b, m.to, other(c)) === 1; }
  function applyMove(b, c, m) {
    var n = cloneBoard(b), o = other(c), step = c === WHITE ? 1 : -1;
    if (m.from === BAR_FROM) n.bar[c]--; else n.pts[m.from] -= step;
    if (m.to === OFF_TO) { n.off[c]++; return n; }
    if (countAt(n, m.to, o) === 1) { n.pts[m.to] = 0; n.bar[o]++; }   // Blot geschlagen
    n.pts[m.to] += step;
    return n;
  }

  /* Wie viele Würfel lassen sich von hier aus maximal noch verbrauchen?
     (Memoisiert — die Suche wird für Zug-Filter UND Bot sehr oft gebraucht.) */
  var muCache = {}, muCount = 0;
  function bkey(b) { return b.pts.join(',') + '|' + b.bar.W + ',' + b.bar.B; }
  function maxUsable(b, c, dice) {
    if (!dice.length) return 0;
    var k = bkey(b) + '|' + c + '|' + dice.slice().sort().join(',');
    if (muCache[k] !== undefined) return muCache[k];
    var mvs = genMoves(b, c, dice), best = 0, i, nd, r;
    for (i = 0; i < mvs.length; i++) {
      nd = dice.slice(); nd.splice(nd.indexOf(mvs[i].die), 1);
      r = 1 + maxUsable(applyMove(b, c, mvs[i]), c, nd);
      if (r > best) best = r;
      if (best === dice.length) break;
    }
    if (muCount > 30000) { muCache = {}; muCount = 0; }
    muCache[k] = best; muCount++;
    return best;
  }

  /* Wirklich erlaubte Züge: es müssen so viele Würfel wie möglich genutzt werden,
     und wenn nur einer geht, muss es der höhere sein. */
  function legalMoves(b, c, dice) {
    var mu = maxUsable(b, c, dice);
    if (mu === 0) return [];
    var mvs = genMoves(b, c, dice), out = [], i, nd;
    for (i = 0; i < mvs.length; i++) {
      nd = dice.slice(); nd.splice(nd.indexOf(mvs[i].die), 1);
      if (1 + maxUsable(applyMove(b, c, mvs[i]), c, nd) === mu) out.push(mvs[i]);
    }
    if (mu === 1) {
      var hi = 0, f = [];
      for (i = 0; i < out.length; i++) if (out[i].die > hi) hi = out[i].die;
      for (i = 0; i < out.length; i++) if (out[i].die === hi) f.push(out[i]);
      out = f;
    }
    return out;
  }
  function winPoints(b, c) {
    var o = other(c), p;
    if (b.off[o] > 0) return 1;                                    // einfach
    if (b.bar[o] > 0) return 3;                                    // Backgammon
    for (p = 0; p < 24; p++) if (countAt(b, p, o) > 0 && inHome(c, p)) return 3;
    return 2;                                                      // Gammon
  }

  /* ===================== Bot ===================== */
  /* Wie viele direkte Schüsse hat der Gegner auf den Blot bei p? */
  function hitRisk(b, p, o) {
    var risk = 0, d, q;
    if (b.bar[o] > 0) {                       // mit Stein auf dem Balken zählt nur der Eintritt
      for (d = 1; d <= 6; d++) if (entryPoint(o, d) === p) risk += 2;
      return risk;
    }
    for (d = 1; d <= 6; d++) { q = p - dirOf(o) * d; if (q >= 0 && q <= 23 && countAt(b, q, o) > 0) risk += 1; }
    return risk;
  }
  function primeBonus(b, c) {
    var run = 0, s = 0;
    for (var p = 0; p < 24; p++) {
      if (countAt(b, p, c) >= 2) { run++; s += run * 1.6; } else run = 0;
    }
    return s;
  }
  function evalFor(b, c) {
    var o = other(c), s = 0, p, n;
    s += (pipCount(b, o) - pipCount(b, c)) * 1.0;      // Laufvorsprung
    s += (b.off[c] - b.off[o]) * 22;                   // rausgewürfelt zählt doppelt
    s -= b.bar[c] * 32; s += b.bar[o] * 26;            // Balken tut weh / hilft
    for (p = 0; p < 24; p++) {
      n = countAt(b, p, c);
      if (n === 1) {
        s -= 7 + hitRisk(b, p, o) * 3.2;               // Blot je nach Trefferchance meiden
        if (inHome(o, p)) s -= 3;
      } else if (n >= 2) {
        s += 3.5;
        if (inHome(c, p)) s += 5;                      // Heimfeld-Punkte sperren den Wiedereinstieg
        if (inHome(o, p)) s += 3;                      // Anker im gegnerischen Heim
        if (n >= 4) s -= (n - 3) * 2.5;                // Türme sind träge
      }
    }
    return s + primeBonus(b, c);
  }
  /* Alle vollständigen Zugfolgen (nach Endstellung entdoppelt). */
  function botSequences(b, c, dice) {
    var mu = maxUsable(b, c, dice), out = [], seen = {};
    if (mu === 0) return out;
    rec(b, dice, []);
    return out;
    function rec(board, ds, path) {
      if (out.length > 2500) return;
      if (path.length === mu) {
        var k = bkey(board);
        if (!seen[k]) { seen[k] = 1; out.push({ board: board, path: path }); }
        return;
      }
      var mvs = legalMoves(board, c, ds), i, nd;
      for (i = 0; i < mvs.length; i++) {
        nd = ds.slice(); nd.splice(nd.indexOf(mvs[i].die), 1);
        rec(applyMove(board, c, mvs[i]), nd, path.concat([mvs[i]]));
      }
    }
  }
  function botChoose(b, c, dice, level) {
    var seqs = botSequences(b, c, dice);
    if (!seqs.length) return [];
    if (level === 0 && Math.random() < 0.55) return seqs[Math.floor(Math.random() * seqs.length)].path;
    if (level === 1 && Math.random() < 0.15) return seqs[Math.floor(Math.random() * seqs.length)].path;
    var best = seqs[0], bestV = -Infinity, i, v;
    for (i = 0; i < seqs.length; i++) {
      if (level === 0) {
        // Grünschnabel schaut nur auf den Laufvorsprung — Blots sind ihm egal
        v = (pipCount(seqs[i].board, other(c)) - pipCount(seqs[i].board, c)) + seqs[i].board.off[c] * 20;
      } else {
        v = evalFor(seqs[i].board, c);
        if (level === 1) v += (Math.random() * 2 - 1) * 6;
      }
      if (v > bestV) { bestV = v; best = seqs[i]; }
    }
    return best.path;
  }

  /* ===================== Kodierung für room.shared ===================== */
  function encBoard(b) { return b.pts.join(',') + '|' + b.bar.W + ',' + b.bar.B + '|' + b.off.W + ',' + b.off.B; }
  function decBoard(s) {
    var parts = String(s || '').split('|');
    var pts = (parts[0] || '').split(',').map(Number);
    if (pts.length !== 24) return newBoard();
    var i;
    for (i = 0; i < 24; i++) if (isNaN(pts[i])) return newBoard();
    var ba = (parts[1] || '0,0').split(',').map(Number);
    var of = (parts[2] || '0,0').split(',').map(Number);
    return { pts: pts, bar: { W: ba[0] || 0, B: ba[1] || 0 }, off: { W: of[0] || 0, B: of[1] || 0 } };
  }
  function encDice(a) { return a.join(','); }
  function decDice(s) {
    if (!s) return [];
    return String(s).split(',').filter(function (x) { return x !== ''; }).map(Number);
  }
  function encSnap(b, dice) { return encBoard(b) + '#' + encDice(dice); }
  function decSnap(s) {
    var p = String(s || '').split('#');
    return { board: decBoard(p[0]), dice: decDice(p[1]) };
  }

  /* ===================== Geometrie ===================== */
  function isTop(i) { return i >= 12; }
  function pointX(i) {
    if (i < 6) return RIGHT0 + (5 - i + 0.5) * PW;        // unten rechts (Grüns Heim)
    if (i < 12) return MG + (11 - i + 0.5) * PW;          // unten links
    if (i < 18) return MG + (i - 12 + 0.5) * PW;          // oben links
    return RIGHT0 + (i - 18 + 0.5) * PW;                  // oben rechts (Türkis' Heim)
  }
  function stackY(i, k, n) {
    if (n < 1) n = 1;
    var step = CR * 1.85, span = TRIH + CR * 0.6;
    if (n > 1 && (n - 1) * step + CR * 2 > span) step = (span - CR * 2) / (n - 1);
    if (step < CR * 0.5) step = CR * 0.5;
    var d = CR + k * step;
    return isTop(i) ? (MG + d) : (BH - MG - d);
  }
  function barY(c, k, n) {
    if (n < 1) n = 1;
    var step = CR * 1.7, span = BH / 2 - MG - CR * 2 - 26;
    if (n > 1 && (n - 1) * step > span) step = span / (n - 1);
    // Grün tritt oben rechts ein, Türkis unten rechts -> jeder wartet auf seiner Seite
    return c === WHITE ? (BH / 2 - 30 - CR - k * step) : (BH / 2 + 30 + CR + k * step);
  }
  function offY(c, k) {
    var h = 13;
    return c === WHITE ? (BH - MG - 8 - h / 2 - k * h) : (MG + 8 + h / 2 + k * h);
  }
  /* Bildschirm -> Feld. Es zählt die ganze Spalte (nicht nur das Dreieck) — am Handy viel treffsicherer. */
  function hitField(x, y) {
    if (x >= TRAYX - 6) return OFF_TO;
    if (x > BARX - BARW / 2 - 5 && x < BARX + BARW / 2 + 5) return BAR_FROM;
    var col = -1;
    if (x >= MG && x < MG + 6 * PW) col = Math.floor((x - MG) / PW);
    else if (x >= RIGHT0 && x < RIGHT0 + 6 * PW) col = 6 + Math.floor((x - RIGHT0) / PW);
    else return null;
    if (y < BH / 2) return col < 6 ? 12 + col : 18 + (col - 6);
    return col < 6 ? 11 - col : 5 - (col - 6);
  }

  /* ===================== Spiel ===================== */
  App.Minigames.backgammon = {
    id: 'backgammon', title: 'Backgammon', icon: '🎲', order: 165,
    subtitle: 'Würfeln, schlagen, auswürfeln – der Klassiker',
    single: true, multi: true, minPlayers: 2, maxPlayers: 2,

    render: function (root, ctx) {
      var isMulti = ctx.mode === 'multi';
      var room = isMulti ? ctx.room : null;

      var dead = false, raf = null, timers = [], stops = [], listeners = [];
      var endShown = false;

      /* Zustand (Solo: Quelle der Wahrheit; Multi: aus shared dekodiert) */
      var S = {
        board: newBoard(), dice: [], rolled: [], turn: WHITE, phase: 'roll',
        winner: null, wpts: 0, seq: 0, hist: [], last: null, opw: 0, opb: 0
      };
      var myColor = WHITE, botColor = BLACK, level = 1, order = null;

      /* Lokale Ansicht */
      var stage = null, cv = null, g = null, statusEl = null, diceRow = null;
      var rollBtn = null, undoBtn = null, hintEl = null;
      var chipW = null, chipB = null;
      var sel = null, dests = [], movable = [];
      var anim = null, animSeq = -1, checkedSeq = -1;
      var dieNodes = [], diceKey = '', rollAnimUntil = 0, lastTumble = 0;
      var drag = null, botTimer = null, botPath = null;
      var flash = null;   // kurze Meldung über dem Brett

      function after(ms, fn) { var t = setTimeout(function () { if (!dead) fn(); }, ms); timers.push(t); return t; }
      function clearTimers() { timers.forEach(clearTimeout); timers = []; }
      function addL(t, ty, fn, o) { t.addEventListener(ty, fn, o); listeners.push({ t: t, ty: ty, fn: fn, o: o }); }
      function sfx(n) { if (App.Audio) App.Audio.sfx(n); }
      function cleanup() {
        dead = true;
        if (raf) { cancelAnimationFrame(raf); raf = null; }
        clearTimers();
        stops.forEach(function (f) { try { f(); } catch (e) {} }); stops = [];
        listeners.forEach(function (l) { try { l.t.removeEventListener(l.ty, l.fn, l.o); } catch (e) {} }); listeners = [];
      }

      if (isMulti) startMulti(); else showLevelMenu();
      return { cleanup: cleanup };

      /* ============ SOLO: Stufenwahl ============ */
      function showLevelMenu() {
        var saved = App.Storage.get('bkg_level', 1);
        var btns = LEVELS.map(function (L, i) {
          return el('button', {
            class: 'bkg-lvl' + (i === saved ? ' is-on' : ''), type: 'button',
            onclick: function () { sfx('select'); App.Storage.set('bkg_level', i); startSolo(i); }
          }, [
            el('span', { class: 'bkg-lvl-ic' }, [L.icon]),
            el('span', { class: 'bkg-lvl-tx' }, [
              el('span', { class: 'bkg-lvl-nm' }, [L.name]),
              el('span', { class: 'bkg-lvl-hi' }, [L.hint])
            ])
          ]);
        });
        root.innerHTML = '';
        root.appendChild(el('div', { class: 'glass bkg-menu' }, [
          el('div', { class: 'bkg-menu-ic' }, ['🎲']),
          el('h2', { class: 'neon' }, ['Backgammon']),
          el('p', { class: 'hint-text' }, ['Bring alle 15 Steine ins Heimfeld und würfle sie raus. Gegen wen trittst du an?']),
          el('div', { class: 'bkg-lvls' }, btns),
          el('div', { class: 'controls-row' }, [
            el('button', { class: 'btn btn-ghost', type: 'button', onclick: ctx.onExit }, ['Zurück'])
          ])
        ]));
      }

      function startSolo(lv) {
        clearTimers();
        level = lv; myColor = WHITE; botColor = BLACK;
        endShown = false; botPath = null; botTimer = null;
        sel = null; dests = []; anim = null; animSeq = -1; checkedSeq = -1; flash = null;
        var opw = r6(), opb = r6();
        while (opw === opb) opb = r6();                       // Eröffnungswurf: kein Pasch
        S = {
          board: newBoard(), dice: [opw, opb], rolled: [opw, opb],
          turn: opw > opb ? WHITE : BLACK, phase: 'move',
          winner: null, wpts: 0, seq: 1, hist: [], last: null, opw: opw, opb: opb
        };
        buildStage((ctx.me && ctx.me.name) ? ctx.me.name : 'Du', LEVELS[level].icon + ' ' + LEVELS[level].name);
        sfx('roll');
        refresh();
        loop();
      }

      /* ============ MULTI ============ */
      function startMulti() {
        var proceeded = false;
        function maybeStart() {
          if (proceeded || dead) return;
          var ps = room.players();
          if (ps.length >= 2) {
            proceeded = true;
            var snap = room.snapshot() || {};
            var startAt = (snap.round && snap.round.startAt) || (room.now() + App.MG.MULTI_START_DELAY);
            stops.push(App.MG.countdown(root, startAt, function () { playMulti(); }, room.now));
          } else showWaiting(ps.length);
        }
        var ph = function () { maybeStart(); };
        room.on('players', ph);
        stops.push(function () { room.off('players', ph); });
        maybeStart();
      }

      function showWaiting(n) {
        root.innerHTML = '';
        root.appendChild(el('div', { class: 'glass bkg-wait' }, [
          el('div', { class: 'bkg-wait-ic' }, ['🎲']),
          el('h2', { class: 'neon' }, ['Backgammon']),
          el('div', { class: 'big-readout' }, [(n || 1) + ' / 2']),
          el('p', { class: 'hint-text' }, ['Warte auf den zweiten Spieler …']),
          el('div', { class: 'controls-row' }, [
            el('button', { class: 'btn btn-ghost', type: 'button', onclick: ctx.onExit }, ['Zurück zur Lobby'])
          ])
        ]));
      }

      function playMulti() {
        var ps = room.players();
        var sh = (room.snapshot() && room.snapshot().shared) || null;
        var initDone = false;

        function onShared() { if (!dead) sync(); }
        function onPlayers() { if (!dead) sync(); }
        room.on('shared', onShared); room.on('players', onPlayers);
        stops.push(function () { room.off('shared', onShared); });
        stops.push(function () { room.off('players', onPlayers); });

        buildStage('…', '…');
        sync();
        loop();

        function sync() {
          var players = room.players();
          var s = (room.snapshot() && room.snapshot().shared) || null;
          if (!s || !s.b || !s.order) {
            if (room.isHost() && players.length >= 2 && !initDone) { initDone = true; initShared(players); }
            statusEl.textContent = players.length < 2 ? 'Warte auf den zweiten Spieler …' : 'Stellung wird aufgebaut …';
            return;
          }
          order = s.order;
          myColor = order[0] === ctx.me.id ? WHITE : (order[1] === ctx.me.id ? BLACK : null);
          S = {
            board: decBoard(s.b), dice: decDice(s.dice), rolled: decDice(s.rolled),
            turn: s.turn || WHITE, phase: s.phase || 'roll',
            winner: s.winner || null, wpts: s.wpts || 0, seq: s.seq || 0,
            hist: s.hist ? String(s.hist).split(';').filter(function (x) { return x !== ''; }) : [],
            last: s.lastC ? { from: Number(s.lastF), to: Number(s.lastT), c: s.lastC, hit: !!s.lastHit } : null,
            opw: s.opw || 0, opb: s.opb || 0
          };
          var pW = byId(players, order[0]), pB = byId(players, order[1]);
          setChipNames(
            (pW ? pW.name : 'Spieler 1') + (myColor === WHITE ? ' (du)' : ''),
            (pB ? pB.name : 'Spieler 2') + (myColor === BLACK ? ' (du)' : '')
          );
          refresh();
        }
        function initShared(players) {
          var a = r6(), b = r6();
          while (a === b) b = r6();
          room.setShared({
            order: [players[0].id, players[1].id], b: encBoard(newBoard()),
            dice: encDice([a, b]), rolled: encDice([a, b]),
            turn: a > b ? WHITE : BLACK, phase: 'move', winner: '', wpts: 0,
            seq: 1, hist: '', lastF: 0, lastT: 0, lastC: '', lastHit: 0, opw: a, opb: b
          });
        }
      }
      function byId(ps, id) { for (var i = 0; i < ps.length; i++) if (ps[i].id === id) return ps[i]; return null; }

      /* ============ Zustands-Schreiben ============ */
      function commit(p) {
        if (dead) return;
        if (!isMulti) {
          Object.keys(p).forEach(function (k) { S[k] = p[k]; });
          refresh();
          return;
        }
        var o = {};
        if (p.board !== undefined) o.b = encBoard(p.board);
        if (p.dice !== undefined) o.dice = encDice(p.dice);
        if (p.rolled !== undefined) o.rolled = encDice(p.rolled);
        if (p.turn !== undefined) o.turn = p.turn;
        if (p.phase !== undefined) o.phase = p.phase;
        if (p.winner !== undefined) o.winner = p.winner || '';
        if (p.wpts !== undefined) o.wpts = p.wpts;
        if (p.seq !== undefined) o.seq = p.seq;
        if (p.hist !== undefined) o.hist = p.hist.join(';');
        if (p.last !== undefined) {
          o.lastF = p.last ? p.last.from : 0;
          o.lastT = p.last ? p.last.to : 0;
          o.lastC = p.last ? p.last.c : '';
          o.lastHit = p.last && p.last.hit ? 1 : 0;
        }
        room.setShared(o);
      }
      /* Wer darf den Zug vorantreiben (würfeln, Zugende, Bot)? */
      function iControlTurn() { return isMulti ? (S.turn === myColor) : true; }
      function isMyMove() { return S.phase === 'move' && myColor && S.turn === myColor; }

      function doRoll(force) {
        if (dead || S.phase !== 'roll') return;
        if (!force && (!myColor || S.turn !== myColor)) return;
        var d1 = r6(), d2 = r6();
        var dice = d1 === d2 ? [d1, d1, d1, d1] : [d1, d2];
        botPath = null;
        commit({ rolled: dice.slice(), dice: dice, phase: 'move', seq: S.seq + 1, last: null });
      }

      function doMove(m) {
        if (dead || S.phase !== 'move') return;
        var c = S.turn;
        var hit = wasHit(S.board, c, m);
        var nb = applyMove(S.board, c, m);
        var nd = S.dice.slice(); nd.splice(nd.indexOf(m.die), 1);
        var nh = S.hist.slice(); nh.push(encSnap(S.board, S.dice));
        if (nh.length > 8) nh.shift();
        var patch = {
          board: nb, dice: nd, hist: nh, seq: S.seq + 1,
          last: { from: m.from, to: m.to, c: c, hit: hit }
        };
        if (nb.off[c] === 15) { patch.phase = 'over'; patch.winner = c; patch.wpts = winPoints(nb, c); }
        sel = null; dests = [];
        commit(patch);
      }

      function doUndo() {
        if (dead || !S.hist.length || S.phase !== 'move' || !iControlTurn()) return;
        var h = S.hist.slice(), snap = decSnap(h.pop());
        sel = null; dests = [];
        sfx('click');
        commit({ board: snap.board, dice: snap.dice, hist: h, seq: S.seq + 1, last: null });
      }

      function endTurn() {
        if (dead || S.phase === 'over') return;
        botPath = null; sel = null; dests = [];
        commit({
          turn: other(S.turn), phase: 'roll', dice: [], rolled: [],
          hist: [], last: null, seq: S.seq + 1
        });
      }

      /* Nach jeder NEUEN Stellung genau einmal prüfen, ob der Zug vorbei ist. */
      function afterStateChange() {
        if (S.phase !== 'move' || !iControlTurn()) return;
        if (checkedSeq === S.seq) return;
        checkedSeq = S.seq;
        var sq = S.seq;
        if (!S.dice.length) { after(700, function () { if (S.seq === sq) endTurn(); }); return; }
        if (maxUsable(S.board, S.turn, S.dice) === 0) {
          setFlash(S.turn === myColor ? 'Kein Zug möglich 😖' : 'Gegner kann nicht ziehen', 1300);
          sfx('error');
          after(1350, function () { if (S.seq === sq) endTurn(); });
        }
      }

      function driveBot() {
        if (dead || isMulti || S.turn !== botColor || S.phase === 'over' || botTimer) return;
        if (S.phase === 'roll') {
          botTimer = after(720, function () { botTimer = null; doRoll(true); });
          return;
        }
        if (S.phase === 'move') {
          if (!botPath) botPath = botChoose(S.board, botColor, S.dice, level);
          if (botPath.length) {
            botTimer = after(640, function () {
              botTimer = null;
              if (dead || S.turn !== botColor || S.phase !== 'move' || !botPath || !botPath.length) return;
              doMove(botPath.shift());
            });
          }
        }
      }

      function setFlash(text, ms) { flash = { text: text, until: Date.now() + ms }; }

      /* ============ Ansicht aufbauen ============ */
      function setChipNames(nW, nB) {
        chipW.querySelector('.bkg-nm').textContent = nW;
        chipB.querySelector('.bkg-nm').textContent = nB;
      }
      function makeChip(cls, ic, label) {
        return el('div', { class: 'bkg-chip ' + cls }, [
          el('span', { class: 'bkg-chip-ic' }, [ic]),
          el('div', { class: 'bkg-chip-in' }, [
            el('div', { class: 'bkg-nm' }, [label]),
            el('div', { class: 'bkg-mini' }, [''])
          ]),
          el('div', { class: 'bkg-offc' }, ['0'])
        ]);
      }
      function buildStage(nW, nB) {
        chipW = makeChip('bkg-chip-w', '🟢', nW);
        chipB = makeChip('bkg-chip-b', '🩵', nB);
        statusEl = el('div', { class: 'bkg-status' }, ['']);
        cv = el('canvas', { class: 'bkg-canvas', width: BW, height: BH });
        stage = el('div', { class: 'bkg-stage' }, [cv]);
        diceRow = el('div', { class: 'bkg-dice' });
        rollBtn = el('button', { class: 'btn btn-primary bkg-roll', type: 'button', onclick: function () { doRoll(false); } }, ['🎲 Würfeln']);
        undoBtn = el('button', { class: 'btn btn-ghost bkg-undo', type: 'button', onclick: doUndo }, ['↶ Zurück']);
        hintEl = el('div', { class: 'bkg-hint hint-text' }, [
          'Stein antippen oder ziehen · goldene Ziele sind erlaubt · 🟢 läuft nach unten rechts, 🩵 nach oben rechts'
        ]);
        var wrap = el('div', { class: 'bkg-wrap' }, [
          el('div', { class: 'bkg-head' }, [chipW, chipB]),
          statusEl, stage,
          el('div', { class: 'bkg-ctrl' }, [diceRow, el('div', { class: 'bkg-btns' }, [rollBtn, undoBtn])]),
          hintEl
        ]);
        root.innerHTML = ''; root.appendChild(wrap);
        g = cv.getContext('2d');
        attachInput();
      }

      /* ============ Eingabe (Maus + Touch über Pointer-Events) ============ */
      function toField(e) {
        var r = cv.getBoundingClientRect();
        var x = (e.clientX - r.left) / r.width * BW;
        var y = (e.clientY - r.top) / r.height * BH;
        return { f: hitField(x, y), x: x, y: y };
      }
      function attachInput() {
        addL(cv, 'pointerdown', function (e) {
          e.preventDefault();
          if (!isMyMove()) return;
          var h = toField(e);
          if (h.f === null) return;
          if (sel !== null && destAt(h.f)) { playTo(h.f); return; }
          if (selectFrom(h.f)) drag = { from: h.f, x: h.x, y: h.y, moved: false };
        }, { passive: false });
        addL(cv, 'pointermove', function (e) {
          if (!drag) return;
          e.preventDefault();
          var h = toField(e);
          if (Math.abs(h.x - drag.x) > 8 || Math.abs(h.y - drag.y) > 8) drag.moved = true;
          drag.x = h.x; drag.y = h.y;
        }, { passive: false });
        addL(cv, 'pointerup', function (e) {
          if (!drag) return;
          e.preventDefault();
          var d = drag; drag = null;
          if (!d.moved) return;                       // reines Tippen -> Auswahl bleibt stehen
          var h = toField(e);
          if (h.f !== null && sel === d.from && destAt(h.f)) playTo(h.f);
        }, { passive: false });
        addL(cv, 'pointercancel', function () { drag = null; });
      }
      function destAt(f) {
        for (var i = 0; i < dests.length; i++) if (dests[i] === f) return true;
        return false;
      }
      /* Ziel anspielen. Mehrere Würfel aufs selbe Ziel (nur beim Auswürfeln
         möglich) -> den kleinsten nehmen, der große bleibt für andere Steine. */
      function playTo(f) {
        var lm = legalMoves(S.board, S.turn, S.dice), pick = null, i;
        for (i = 0; i < lm.length; i++) {
          if (lm[i].from === sel && lm[i].to === f) { if (!pick || lm[i].die < pick.die) pick = lm[i]; }
        }
        if (pick) doMove(pick);
      }
      function selectFrom(f) {
        if (f === OFF_TO) return false;
        var have = f === BAR_FROM ? S.board.bar[myColor] > 0 : countAt(S.board, f, myColor) > 0;
        if (!have) { sel = null; dests = []; return false; }
        var lm = legalMoves(S.board, S.turn, S.dice), d = [], i;
        for (i = 0; i < lm.length; i++) if (lm[i].from === f && d.indexOf(lm[i].to) < 0) d.push(lm[i].to);
        if (!d.length) {
          sfx('error');
          UI.toast(S.board.bar[myColor] > 0 ? 'Erst den Stein vom Balken einsetzen!' : 'Von dort geht mit diesem Wurf nichts', 'info');
          sel = null; dests = []; return false;
        }
        sel = f; dests = d; sfx('select');
        return true;
      }

      /* ============ Refresh (idempotent — läuft auch bei jedem Heartbeat) ============ */
      function refresh() {
        if (dead || !statusEl) return;
        if (S.seq !== animSeq) {                    // neue Stellung: Auswahl weg, ggf. animieren
          animSeq = S.seq; sel = null; dests = []; drag = null;
          if (S.last) startAnim(S.last);
        }
        // Auswahl gegen die aktuelle Stellung prüfen (z. B. nach Undo)
        if (sel !== null && !isMyMove()) { sel = null; dests = []; }
        movable = [];
        if (isMyMove()) {
          var lm = legalMoves(S.board, S.turn, S.dice), i;
          for (i = 0; i < lm.length; i++) if (movable.indexOf(lm[i].from) < 0) movable.push(lm[i].from);
        }
        updateChips();
        updateStatus();
        refreshDice();
        rollBtn.disabled = !(S.phase === 'roll' && myColor && S.turn === myColor);
        rollBtn.classList.toggle('bkg-glow', !rollBtn.disabled);
        undoBtn.disabled = !(S.phase === 'move' && iControlTurn() && S.hist.length > 0 && (!isMulti || S.turn === myColor));
        if (S.phase === 'over') { showEnd(); return; }
        afterStateChange();
        driveBot();
      }

      function updateChips() {
        chipW.classList.toggle('active', S.turn === WHITE && S.phase !== 'over');
        chipB.classList.toggle('active', S.turn === BLACK && S.phase !== 'over');
        chipW.classList.toggle('me', myColor === WHITE);
        chipB.classList.toggle('me', myColor === BLACK);
        chipW.querySelector('.bkg-offc').textContent = String(S.board.off.W);
        chipB.querySelector('.bkg-offc').textContent = String(S.board.off.B);
        chipW.querySelector('.bkg-mini').textContent = pipCount(S.board, WHITE) + ' Pips'
          + (S.board.bar.W ? ' · ' + S.board.bar.W + '× Balken' : '');
        chipB.querySelector('.bkg-mini').textContent = pipCount(S.board, BLACK) + ' Pips'
          + (S.board.bar.B ? ' · ' + S.board.bar.B + '× Balken' : '');
      }

      function colName(c) { return c === WHITE ? '🟢 Grün' : '🩵 Türkis'; }
      function ptsName(n) { return n >= 3 ? 'Backgammon (3 Punkte)' : n === 2 ? 'Gammon (2 Punkte)' : '1 Punkt'; }
      function updateStatus() {
        var t = '', cls = 'opp';
        if (S.phase === 'over') {
          var iw = S.winner === myColor;
          t = (iw ? '🏆 Gewonnen — ' : '💀 Verloren — ') + ptsName(S.wpts);
          cls = iw ? 'win' : 'lose';
        } else if (S.seq <= 1 && S.opw) {
          // Eröffnungswurf: wer beginnt — aber auch gleich sagen, was zu tun ist
          var first = S.opw > S.opb ? WHITE : BLACK;
          t = 'Eröffnungswurf ' + S.opw + ':' + S.opb + ' — '
            + (first === myColor ? 'du beginnst, zieh deine Steine!' : colName(first) + ' beginnt …');
          cls = first === myColor ? 'you' : 'opp';
        } else if (!myColor) {
          t = 'Du schaust zu — ' + colName(S.turn) + ' ist dran';
        } else if (S.turn === myColor) {
          t = S.phase === 'roll' ? 'Du bist dran — würfle!'
            : (S.board.bar[myColor] ? 'Du musst vom Balken eintreten' : 'Du bist dran — zieh deine Steine');
          cls = 'you';
        } else {
          t = isMulti ? (colName(S.turn) + ' ist dran …') : (LEVELS[level].icon + ' ' + LEVELS[level].name + (S.phase === 'roll' ? ' würfelt …' : ' zieht …'));
        }
        if (statusEl.textContent !== t) statusEl.textContent = t;
        if (statusEl.className !== 'bkg-status ' + cls) statusEl.className = 'bkg-status ' + cls;
      }

      function buildDie() {
        var pips = [], i;
        for (i = 0; i < 9; i++) pips.push(el('span', { class: 'bkg-pip' }));
        var d = el('div', { class: 'bkg-die' }, pips);
        d._v = -1;
        return d;
      }
      function setDie(node, v) {
        if (node._v === v) return;
        node._v = v;
        var m = DIE_PIPS[v] || [], ch = node.childNodes, i;
        for (i = 0; i < 9; i++) ch[i].className = 'bkg-pip' + (m.indexOf(i) >= 0 ? ' on' : '');
      }
      function refreshDice() {
        var faces = S.rolled.length ? S.rolled : [0, 0];
        var key = faces.join(',') + '|' + S.turn + '|' + S.seq;
        var fresh = (diceKey.split('|')[0] + '|' + diceKey.split('|')[1]) !== (faces.join(',') + '|' + S.turn);
        if (diceKey === '' || fresh) {
          diceRow.innerHTML = ''; dieNodes = [];
          for (var i = 0; i < faces.length; i++) {
            var d = buildDie();
            d.className = 'bkg-die ' + (S.turn === WHITE ? 'bkg-die-w' : 'bkg-die-b') + (S.rolled.length ? '' : ' bkg-die-idle');
            diceRow.appendChild(d); dieNodes.push(d);
          }
          if (S.rolled.length) { rollAnimUntil = Date.now() + 520; sfx('roll'); }
        }
        diceKey = key;
        var rem = S.dice.slice(), j, used;
        for (var k = 0; k < dieNodes.length; k++) {
          if (!S.rolled.length) { dieNodes[k].classList.remove('used'); continue; }
          j = rem.indexOf(S.rolled[k]); used = j < 0;
          if (!used) rem.splice(j, 1);
          dieNodes[k].classList.toggle('used', used);
        }
      }
      function tickDice(now) {
        if (!dieNodes.length) return;
        var i;
        if (S.rolled.length && now < rollAnimUntil) {
          diceRow.classList.add('bkg-rolling');
          if (now - lastTumble > 65) {
            lastTumble = now;
            for (i = 0; i < dieNodes.length; i++) setDie(dieNodes[i], r6());
          }
        } else {
          diceRow.classList.remove('bkg-rolling');
          for (i = 0; i < dieNodes.length; i++) setDie(dieNodes[i], S.rolled.length ? S.rolled[i] : 0);
        }
      }

      /* ============ Animation eines Zuges (aus S.last — auf BEIDEN Geräten) ============ */
      function startAnim(L) {
        var b = S.board, c = L.c, o = other(c), fx, fy, tx, ty, n;
        if (L.from === BAR_FROM) { n = b.bar[c] + 1; fx = BARX; fy = barY(c, n - 1, n); }
        else { n = countAt(b, L.from, c) + 1; fx = pointX(L.from); fy = stackY(L.from, n - 1, n); }
        if (L.to === OFF_TO) { fx = fx; tx = TRAYX + TRAY / 2; ty = offY(c, b.off[c] - 1); }
        else { n = countAt(b, L.to, c); tx = pointX(L.to); ty = stackY(L.to, n - 1, n); }
        anim = {
          c: c, to: L.to, hit: L.hit, t0: Date.now(),
          fx: fx, fy: fy, tx: tx, ty: ty,
          hx: L.hit ? pointX(L.to) : 0, hy: L.hit ? stackY(L.to, 0, 1) : 0,
          bx: BARX, by: L.hit ? barY(o, b.bar[o] - 1, b.bar[o]) : 0
        };
        if (L.hit) { sfx('hit'); setFlash(c === myColor ? 'Getroffen! 🎯' : 'Du wurdest geschlagen! 💥', 1200); }
        else if (L.to === OFF_TO) sfx('coin');
        else sfx('chip');
      }

      /* ============ Zeichnen ============ */
      function loop() {
        if (dead) { raf = null; return; }
        var now = Date.now();
        if (anim && now - anim.t0 >= MOVE_MS) anim = null;
        if (flash && now > flash.until) flash = null;
        tickDice(now);
        draw(now);
        raf = requestAnimationFrame(loop);
      }
      function ease(t) { t = t < 0 ? 0 : t > 1 ? 1 : t; return 1 - Math.pow(1 - t, 3); }
      function roundRect(x, y, w, h, r) {
        r = Math.min(r, w / 2, h / 2);
        g.beginPath(); g.moveTo(x + r, y);
        g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
        g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
      }
      function colOf(c) {
        return c === WHITE
          ? { a: '#8dff6b', b: '#159c0a', e: '#eaffe2', gl: 'rgba(57,255,20,0.8)' }
          : { a: '#7ff5e6', b: '#0d7f72', e: '#dffcf7', gl: 'rgba(51,230,208,0.8)' };
      }

      function draw(now) {
        if (!g) return;
        var pulse = 0.5 + 0.5 * Math.sin(now / 260);
        var i;
        g.clearRect(0, 0, BW, BH);
        var bg = g.createLinearGradient(0, 0, 0, BH);
        bg.addColorStop(0, '#06180e'); bg.addColorStop(1, '#02100a');
        g.fillStyle = bg; g.fillRect(0, 0, BW, BH);
        g.save(); g.strokeStyle = 'rgba(57,255,20,0.28)'; g.lineWidth = 3;
        roundRect(3, 3, BW - 6, BH - 6, 16); g.stroke(); g.restore();

        drawHomeBand();
        for (i = 0; i < 24; i++) drawPoint(i);
        drawBar(); drawTray();
        if (sel !== null) for (i = 0; i < dests.length; i++) drawDest(dests[i], pulse);
        for (i = 0; i < 24; i++) drawStack(i, pulse);
        drawBarStacks(pulse); drawOffStacks();
        for (i = 0; i < movable.length; i++) drawMovableDot(movable[i], pulse);
        drawAnim(now);
        drawFlash();
      }

      /* Heimfeld-Bänder: eigenes Heim gold, gegnerisches dezent */
      function drawHomeBand() {
        var mine = myColor || WHITE;
        band(RIGHT0, BH - MG - 4, 6 * PW, mine === WHITE);
        band(RIGHT0, MG + 1, 6 * PW, mine === BLACK);
        function band(x, y, w, isMine) {
          g.save();
          g.fillStyle = isMine ? 'rgba(255,210,63,0.5)' : 'rgba(157,255,122,0.16)';
          if (isMine) { g.shadowColor = 'rgba(255,210,63,0.6)'; g.shadowBlur = 10; }
          g.fillRect(x, y, w, 3);
          g.restore();
        }
      }
      function drawPoint(i) {
        var x = pointX(i), top = isTop(i);
        var y0 = top ? MG : BH - MG, y1 = top ? MG + TRIH : BH - MG - TRIH;
        var light = (i % 2 === 0);
        g.beginPath();
        g.moveTo(x - PW / 2 + 2, y0); g.lineTo(x + PW / 2 - 2, y0); g.lineTo(x, y1); g.closePath();
        var lg = g.createLinearGradient(0, y0, 0, y1);
        if (light) { lg.addColorStop(0, '#1d3a2a'); lg.addColorStop(1, 'rgba(29,58,42,0.12)'); }
        else { lg.addColorStop(0, '#0b1c13'); lg.addColorStop(1, 'rgba(11,28,19,0.08)'); }
        g.fillStyle = lg; g.fill();
        g.strokeStyle = light ? 'rgba(157,255,122,0.16)' : 'rgba(51,230,208,0.13)';
        g.lineWidth = 1; g.stroke();
      }
      function drawBar() {
        g.save();
        g.fillStyle = 'rgba(2,14,8,0.92)';
        g.fillRect(BARX - BARW / 2, MG, BARW, BH - 2 * MG);
        g.strokeStyle = 'rgba(57,255,20,0.22)'; g.lineWidth = 2;
        g.strokeRect(BARX - BARW / 2, MG, BARW, BH - 2 * MG);
        g.restore();
      }
      function drawTray() {
        g.save();
        g.fillStyle = 'rgba(2,14,8,0.85)';
        roundRect(TRAYX, MG, TRAY, BH - 2 * MG, 10); g.fill();
        g.strokeStyle = 'rgba(255,210,63,0.28)'; g.lineWidth = 2; g.stroke();
        g.strokeStyle = 'rgba(255,210,63,0.18)'; g.lineWidth = 1;
        g.beginPath(); g.moveTo(TRAYX + 6, BH / 2); g.lineTo(TRAYX + TRAY - 6, BH / 2); g.stroke();
        g.restore();
      }
      function drawDest(f, pulse) {
        g.save();
        if (f === OFF_TO) {
          g.strokeStyle = 'rgba(255,210,63,' + (0.55 + 0.4 * pulse) + ')';
          g.lineWidth = 3; g.shadowColor = 'rgba(255,210,63,0.8)'; g.shadowBlur = 16;
          roundRect(TRAYX, MG, TRAY, BH - 2 * MG, 10); g.stroke();
          g.restore(); return;
        }
        var x = pointX(f), top = isTop(f);
        var y0 = top ? MG : BH - MG, y1 = top ? MG + TRIH : BH - MG - TRIH;
        g.beginPath();
        g.moveTo(x - PW / 2 + 2, y0); g.lineTo(x + PW / 2 - 2, y0); g.lineTo(x, y1); g.closePath();
        g.fillStyle = 'rgba(255,210,63,' + (0.12 + 0.10 * pulse) + ')'; g.fill();
        var c = S.turn, n = countAt(S.board, f, c);
        var hitting = countAt(S.board, f, other(c)) === 1;
        var y = stackY(f, hitting ? 0 : n, hitting ? 1 : n + 1);
        g.setLineDash([6, 5]);
        g.strokeStyle = hitting ? 'rgba(255,77,109,' + (0.7 + 0.3 * pulse) + ')' : 'rgba(255,210,63,' + (0.7 + 0.3 * pulse) + ')';
        g.lineWidth = 2.5;
        g.shadowColor = hitting ? 'rgba(255,77,109,0.8)' : 'rgba(255,210,63,0.8)'; g.shadowBlur = 14;
        g.beginPath(); g.arc(x, y, CR * 0.94, 0, Math.PI * 2); g.stroke();
        g.restore();
      }
      function drawMovableDot(f, pulse) {
        if (sel !== null) return;
        var x, y;
        if (f === BAR_FROM) { x = BARX; y = barY(myColor, S.board.bar[myColor] - 1, S.board.bar[myColor]); }
        else { var n = countAt(S.board, f, myColor); x = pointX(f); y = stackY(f, n - 1, n); }
        g.save();
        g.fillStyle = 'rgba(255,210,63,' + (0.45 + 0.45 * pulse) + ')';
        g.shadowColor = 'rgba(255,210,63,0.9)'; g.shadowBlur = 10;
        g.beginPath(); g.arc(x, y, CR * 0.2, 0, Math.PI * 2); g.fill();
        g.restore();
      }
      function hiddenAt(i, c) { return anim && anim.to === i && anim.c === c ? 1 : 0; }
      function drawStack(i, pulse) {
        var c = ownerAt(S.board, i);
        if (!c) return;
        var n = countAt(S.board, i, c) - hiddenAt(i, c);
        if (anim && anim.hit && anim.to === i && c === other(anim.c)) n = 0;   // geschlagener Blot fliegt
        if (n <= 0) return;
        for (var k = 0; k < n; k++) drawChecker(pointX(i), stackY(i, k, n), c, sel === i && k === n - 1, pulse);
        if (n > 5) drawCount(pointX(i), stackY(i, n - 1, n), n);
      }
      function drawBarStacks(pulse) {
        [WHITE, BLACK].forEach(function (c) {
          var n = S.board.bar[c] - (anim && anim.hit && other(anim.c) === c ? 1 : 0);
          for (var k = 0; k < n; k++) drawChecker(BARX, barY(c, k, n), c, sel === BAR_FROM && c === myColor && k === n - 1, pulse);
        });
      }
      function drawOffStacks() {
        [WHITE, BLACK].forEach(function (c) {
          var n = S.board.off[c] - (anim && anim.to === OFF_TO && anim.c === c ? 1 : 0);
          for (var k = 0; k < n; k++) drawOffBar(c, k);
        });
      }
      function drawOffBar(c, k) {
        var col = colOf(c), y = offY(c, k), h = 11, w = TRAY - 16, x = TRAYX + 8;
        g.save();
        var lg = g.createLinearGradient(x, y - h / 2, x, y + h / 2);
        lg.addColorStop(0, col.a); lg.addColorStop(1, col.b);
        g.fillStyle = lg; g.shadowColor = col.gl; g.shadowBlur = 6;
        roundRect(x, y - h / 2, w, h, 4); g.fill();
        g.restore();
      }
      function drawChecker(x, y, c, selected, pulse) {
        var col = colOf(c);
        g.save();
        g.shadowColor = col.gl; g.shadowBlur = selected ? 26 : 12;
        var rg = g.createRadialGradient(x - CR * 0.3, y - CR * 0.35, CR * 0.15, x, y, CR);
        rg.addColorStop(0, col.a); rg.addColorStop(1, col.b);
        g.fillStyle = rg;
        g.beginPath(); g.arc(x, y, CR, 0, Math.PI * 2); g.fill();
        g.shadowBlur = 0;
        g.strokeStyle = col.e; g.lineWidth = 2;
        g.beginPath(); g.arc(x, y, CR, 0, Math.PI * 2); g.stroke();
        g.strokeStyle = 'rgba(255,255,255,0.22)'; g.lineWidth = 1.5;
        g.beginPath(); g.arc(x, y, CR * 0.62, 0, Math.PI * 2); g.stroke();
        if (selected) {
          g.setLineDash([5, 4]);
          g.strokeStyle = 'rgba(255,210,63,' + (0.75 + 0.25 * (pulse || 0)) + ')';
          g.lineWidth = 3; g.shadowColor = 'rgba(255,210,63,0.9)'; g.shadowBlur = 14;
          g.beginPath(); g.arc(x, y, CR + 4, 0, Math.PI * 2); g.stroke();
        }
        g.restore();
      }
      function drawCount(x, y, n) {
        g.save();
        g.fillStyle = 'rgba(2,14,8,0.85)';
        g.beginPath(); g.arc(x, y, CR * 0.56, 0, Math.PI * 2); g.fill();
        g.fillStyle = '#fff';
        g.font = '900 ' + Math.round(CR * 0.8) + 'px "Segoe UI",system-ui,Roboto,Arial,sans-serif';
        g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillText(String(n), x, y + 1);
        g.restore();
      }
      function drawAnim(now) {
        if (!anim) return;
        var t = ease((now - anim.t0) / MOVE_MS);
        if (anim.hit) {
          drawChecker(anim.hx + (anim.bx - anim.hx) * t, anim.hy + (anim.by - anim.hy) * t, other(anim.c), false, 0);
        }
        if (anim.to === OFF_TO) {
          var ox = anim.fx + (anim.tx - anim.fx) * t, oy = anim.fy + (anim.ty - anim.fy) * t;
          drawChecker(ox, oy, anim.c, false, 0);
          return;
        }
        var lift = Math.sin(t * Math.PI) * 14;
        drawChecker(anim.fx + (anim.tx - anim.fx) * t, anim.fy + (anim.ty - anim.fy) * t - lift, anim.c, false, 0);
      }
      function drawFlash() {
        if (!flash) return;
        var txt = flash.text;
        g.save();
        g.font = '900 30px "Segoe UI",system-ui,Roboto,Arial,sans-serif';
        g.textAlign = 'center'; g.textBaseline = 'middle';
        var w = g.measureText(txt).width + 40;
        g.fillStyle = 'rgba(2,14,8,0.88)';
        roundRect(BW / 2 - w / 2, BH / 2 - 26, w, 52, 14); g.fill();
        g.strokeStyle = 'rgba(255,210,63,0.65)'; g.lineWidth = 2; g.stroke();
        g.fillStyle = '#ffd23f'; g.shadowColor = 'rgba(255,210,63,0.7)'; g.shadowBlur = 16;
        g.fillText(txt, BW / 2, BH / 2);
        g.restore();
      }

      /* ============ Ende ============ */
      function showEnd() {
        if (endShown || dead) return;
        endShown = true;
        clearTimers();
        var iWon = S.winner === myColor;
        sfx(iWon ? 'win' : 'lose');
        if (isMulti) {
          room.reportScore(iWon ? S.wpts * 100 : 0);
          after(1600, function () {
            if (raf) { cancelAnimationFrame(raf); raf = null; }
            App.MG.endScreen(root, {
              players: room.players(), meId: ctx.me.id,
              title: '🏁 Partie vorbei', onExit: ctx.onExit
            });
          });
          return;
        }
        var lead = Math.max(0, pipCount(S.board, botColor) - pipCount(S.board, myColor));
        var score = iWon ? S.wpts * 100 * (level + 1) + lead : 0;
        var best = App.Storage.get('best_backgammon', 0);
        var nb = score > best;
        if (nb) App.Storage.set('best_backgammon', score);
        after(1500, function () {
          if (raf) { cancelAnimationFrame(raf); raf = null; }
          App.MG.endScreen(root, {
            score: score, best: best, newBest: nb,
            title: iWon ? '🏆 ' + ptsName(S.wpts) + '!' : '💀 Verloren',
            label: (iWon ? 'Sieg gegen ' + LEVELS[level].name + ' · +' + lead + ' Pips Vorsprung' : 'Kein Sieg = keine Punkte')
              + (nb ? ' · neuer Rekord! 🎉' : ' · Bestwert: ' + App.MG.fmt(best)),
            onExit: ctx.onExit,
            onAgain: function () { showLevelMenu(); }
          });
        });
      }
    }
  };

  /* ===================== CSS ===================== */
  function injectStyle() {
    UI.injectStyle('mg-backgammon-css', [
      '.bkg-wrap{display:flex;flex-direction:column;gap:10px;max-width:840px;margin:0 auto;}',
      /* Kopf */
      '.bkg-head{display:flex;gap:10px;}',
      '.bkg-chip{flex:1;min-width:0;display:flex;align-items:center;gap:9px;padding:8px 12px;border-radius:14px;',
      'background:rgba(9,32,21,.6);border:1px solid var(--stroke);transition:border-color .15s,box-shadow .15s;}',
      '.bkg-chip-ic{font-size:22px;line-height:1;}',
      '.bkg-chip-in{flex:1;min-width:0;display:flex;flex-direction:column;line-height:1.15;}',
      '.bkg-nm{font-weight:800;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      '.bkg-mini{font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.8px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      '.bkg-offc{font-size:22px;font-weight:900;color:var(--gold);font-variant-numeric:tabular-nums;text-shadow:0 0 10px rgba(255,210,63,.4);}',
      '.bkg-chip.me .bkg-nm{color:var(--aqua);}',
      '.bkg-chip.active{border-color:var(--neon);box-shadow:0 0 0 1px var(--neon),0 0 18px rgba(57,255,20,.32);}',
      '.bkg-chip.active .bkg-chip-ic{animation:bkg-bob .9s ease-in-out infinite;}',
      '.bkg-chip-b.active{border-color:var(--aqua);box-shadow:0 0 0 1px var(--aqua),0 0 18px rgba(51,230,208,.32);}',
      '@keyframes bkg-bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-3px)}}',
      /* Status */
      '.bkg-status{text-align:center;font-weight:900;font-size:clamp(14px,3.8vw,19px);min-height:24px;}',
      '.bkg-status.you{color:var(--neon);text-shadow:0 0 10px rgba(57,255,20,.4);}',
      '.bkg-status.opp{color:var(--aqua);}',
      '.bkg-status.win{color:var(--gold);text-shadow:0 0 12px rgba(255,210,63,.5);}',
      '.bkg-status.lose{color:var(--danger);}',
      /* Brett */
      '.bkg-stage{width:100%;max-width:840px;margin:0 auto;aspect-ratio:900 / 560;}',
      '.bkg-canvas{display:block;width:100%;height:100%;border-radius:14px;border:2px solid rgba(57,255,20,.32);',
      'background:#04140c;box-shadow:0 0 38px rgba(57,255,20,.2),inset 0 0 60px rgba(57,255,20,.05);',
      'touch-action:none;user-select:none;-webkit-user-select:none;-webkit-tap-highlight-color:transparent;cursor:pointer;}',
      /* Würfel + Knöpfe */
      '.bkg-ctrl{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;}',
      '.bkg-dice{display:flex;gap:8px;}',
      '.bkg-dice.bkg-rolling .bkg-die{animation:bkg-tumble .26s linear infinite;}',
      '@keyframes bkg-tumble{0%{transform:rotate(-9deg) translateY(0)}50%{transform:rotate(9deg) translateY(-5px)}100%{transform:rotate(-9deg) translateY(0)}}',
      '.bkg-die{width:40px;height:40px;border-radius:9px;display:grid;grid-template-columns:repeat(3,1fr);grid-template-rows:repeat(3,1fr);',
      'padding:5px;gap:1px;border:2px solid var(--stroke-2);background:rgba(6,24,16,.9);transition:opacity .2s,filter .2s;}',
      '.bkg-die-w{border-color:rgba(57,255,20,.65);box-shadow:0 0 14px rgba(57,255,20,.3);}',
      '.bkg-die-b{border-color:rgba(51,230,208,.65);box-shadow:0 0 14px rgba(51,230,208,.3);}',
      '.bkg-die-idle{opacity:.35;box-shadow:none;}',
      '.bkg-die.used{opacity:.28;filter:grayscale(1);}',
      '.bkg-pip{border-radius:50%;background:transparent;}',
      '.bkg-die-w .bkg-pip.on{background:var(--neon);box-shadow:0 0 5px rgba(57,255,20,.8);}',
      '.bkg-die-b .bkg-pip.on{background:var(--aqua);box-shadow:0 0 5px rgba(51,230,208,.8);}',
      '.bkg-btns{display:flex;gap:8px;}',
      '.bkg-roll.bkg-glow{animation:bkg-pulse 1.4s ease-in-out infinite;}',
      '@keyframes bkg-pulse{0%,100%{box-shadow:0 0 0 0 rgba(57,255,20,.5)}50%{box-shadow:0 0 22px 4px rgba(57,255,20,.45)}}',
      '.bkg-roll:disabled,.bkg-undo:disabled{opacity:.35;cursor:default;animation:none;}',
      '.bkg-hint{text-align:center;font-size:11px;}',
      /* Stufen-Menü */
      '.bkg-menu{padding:26px 22px;text-align:center;display:flex;flex-direction:column;gap:12px;align-items:center;max-width:480px;margin:0 auto;}',
      '.bkg-menu-ic{font-size:52px;filter:drop-shadow(0 0 14px rgba(57,255,20,.5));animation:bkg-bob 2s ease-in-out infinite;}',
      '.bkg-lvls{display:flex;flex-direction:column;gap:9px;width:100%;}',
      '.bkg-lvl{display:flex;align-items:center;gap:12px;padding:11px 14px;border-radius:14px;text-align:left;',
      'background:rgba(9,32,21,.6);border:1px solid var(--stroke);color:var(--text);cursor:pointer;font-family:inherit;transition:.15s;}',
      '.bkg-lvl:hover{border-color:var(--neon);box-shadow:0 0 18px rgba(57,255,20,.28);transform:translateY(-2px);}',
      '.bkg-lvl.is-on{border-color:var(--gold);box-shadow:0 0 0 1px var(--gold);}',
      '.bkg-lvl-ic{font-size:26px;line-height:1;}',
      '.bkg-lvl-tx{display:flex;flex-direction:column;min-width:0;}',
      '.bkg-lvl-nm{font-weight:900;font-size:15px;color:var(--leaf);}',
      '.bkg-lvl-hi{font-size:11px;color:var(--muted);}',
      /* Warten */
      '.bkg-wait{padding:40px;text-align:center;display:flex;flex-direction:column;gap:10px;align-items:center;max-width:440px;margin:0 auto;}',
      '.bkg-wait-ic{font-size:52px;filter:drop-shadow(0 0 14px rgba(57,255,20,.5));animation:bkg-bob 1.6s ease-in-out infinite;}',
      '@media(max-width:560px){.bkg-die{width:34px;height:34px;}.bkg-ctrl{justify-content:center;}}'
    ].join(''));
  }
})();
