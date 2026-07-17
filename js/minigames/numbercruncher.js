/* numbercruncher.js — "Zahlen-Ziel": Kopfrechen-Wettkampf im Neon-Dschungel
 * (nach Art des Countdown-Zahlenspiels).
 *
 * IDEE:      6 Zahlen (Mix aus kleinen 1–10 und großen 25/50/75/100) plus eine
 *            dreistellige Zielzahl — für alle gleich. In 60 s so nah wie möglich
 *            ans Ziel rechnen. Jede Zahl darf höchstens einmal benutzt werden,
 *            jedes Teilergebnis wird zu einem neuen Plättchen. 3 Runden, die
 *            Punkte der Runden werden addiert.
 * STEUERUNG: Zahl antippen → Rechenzeichen (+ − × ÷) → zweite Zahl antippen.
 *            Alles per Touch bedienbar (große Flächen, kein Wischen nötig); am
 *            Desktop zusätzlich Tasten 1–9 (Zahl), + - * / (Zeichen),
 *            Rücktaste (Rückgängig), Entf (Neu).
 * PUNKTE:    Exakt = 100 Punkte. Sonst zählt der Abstand (Δ1 → 75 … Δ150 → 1,
 *            darüber 0). Nur errechnete Werte zählen; der beste Wert einer Runde
 *            bleibt stehen, auch wenn man danach weiterprobiert.
 * SYNC:      Alle Puzzles werden deterministisch aus startAt abgeleitet
 *            (Seed-PRNG). Der Host schreibt sie zusätzlich per setShared in den
 *            Raum — beide Wege erzeugen exakt dasselbe Puzzle, es kann also
 *            nichts auseinanderlaufen (auch nicht bei Nachzüglern oder wenn der
 *            Host geht). Der Rundenfahrplan hängt ebenfalls nur an startAt und
 *            läuft über die Wall-Clock (room.now) → tab-wechsel-sicher.
 *            Live-Punkte über reportScore, das Rundenergebnis für die
 *            Auswertung über reportState.
 * SOLO:      3 Bots, die wirklich rechnen (dieselbe Suche wie die "beste
 *            Lösung", nur mit kleinerem Knotenbudget und eigener Zugreihenfolge)
 *            → sie kommen unterschiedlich nah. Dazu der eigene Rekord
 *            best_numbercruncher.
 *
 * cleanup() beendet alle Timeouts, Timer, den Tastatur-Listener und meldet
 * jeden room.on(...) wieder ab (dead-Flag wie in reflex.js).
 */
(function () {
  'use strict';
  window.App = window.App || {}; App.Minigames = App.Minigames || {};
  var UI = App.UI, el = UI.el;

  injectStyle();

  var ROUNDS = 3;              // Runden pro Partie
  var ROUND_MS = 60000;        // Rechenzeit je Runde
  var SUMMARY_MS = 7000;       // Auswertung zwischen den Runden
  var LARGE = [25, 50, 75, 100];
  var SOLVE_BUDGET = 220000;   // Knotenbudget für die angezeigte "beste Lösung"

  /* ===================== Seed-PRNG (mulberry32) ===================== */
  function rngFrom(seed) {
    var s = seed >>> 0;
    return function () {
      s = (s + 0x6D2B79F5) >>> 0;
      var t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function ri(rnd, n) { return Math.floor(rnd() * n) % n; }
  function shuffle(a, rnd) {
    for (var i = a.length - 1; i > 0; i--) {
      var j = ri(rnd, i + 1), t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  /* ===================== Puzzle ===================== */
  /* Sechs Zahlen ziehen: 1–3 große, Rest klein (jede kleine Zahl doppelt im Topf). */
  function pickNumbers(rnd) {
    var large = LARGE.slice(), smalls = [], out = [], i;
    for (i = 1; i <= 10; i++) { smalls.push(i); smalls.push(i); }
    shuffle(large, rnd); shuffle(smalls, rnd);
    var nLarge = 1 + ri(rnd, 3);
    for (i = 0; i < nLarge; i++) out.push(large[i]);
    for (i = 0; i < 6 - nLarge; i++) out.push(smalls[i]);
    return shuffle(out, rnd);
  }

  /* Ziel aus den Zahlen erzeugen: zufällige Rechenwege durchspielen und jeden
   * dabei entstehenden Wert im Bereich 101–999 sammeln. Jeder gesammelte Wert
   * ist damit garantiert exakt erreichbar. Werte, die viele der sechs Zahlen
   * brauchen, werden bevorzugt (sonst wäre "100 + 7" das Ziel). */
  function pickTarget(nums, rnd) {
    var cands = [], attempt, i;
    for (attempt = 0; attempt < 40; attempt++) {
      var list = nums.map(function (v) { return { v: v, n: 1 }; });
      while (list.length > 1) {
        var i1 = ri(rnd, list.length), i2;
        do { i2 = ri(rnd, list.length); } while (i2 === i1);
        var a = list[i1], b = list[i2];
        var hi = a.v >= b.v ? a : b, lo = a.v >= b.v ? b : a;
        var opts = [hi.v + lo.v];
        if (hi.v - lo.v > 0) opts.push(hi.v - lo.v);
        if (lo.v > 1 && hi.v * lo.v <= 9000) opts.push(hi.v * lo.v);
        if (lo.v > 1 && hi.v % lo.v === 0) opts.push(hi.v / lo.v);
        var node = { v: opts[ri(rnd, opts.length)], n: a.n + b.n };
        if (node.v >= 101 && node.v <= 999 && node.n >= 3) cands.push(node);
        var rest = [];
        for (i = 0; i < list.length; i++) if (i !== i1 && i !== i2) rest.push(list[i]);
        rest.push(node);
        list = rest;
      }
      if (cands.length >= 10) break;
    }
    if (!cands.length) return 101 + ri(rnd, 899);           // Notnagel (praktisch nie)
    cands.sort(function (x, y) { return y.n - x.n; });
    var need = Math.min(4, cands[0].n);
    var top = cands.filter(function (c) { return c.n >= need; });
    return top[ri(rnd, top.length)].v;
  }

  function makePuzzle(seed) {
    var rnd = rngFrom(seed);
    var nums = pickNumbers(rnd);
    return { nums: nums, target: pickTarget(nums, rnd) };
  }

  /* ===================== Löser ===================== */
  /* Tiefensuche über alle Zahlenpaare mit den üblichen Kürzungen (keine
   * negativen/0-Differenzen, keine ×1/÷1, nur glatte Division). Das Budget
   * begrenzt die Knoten — kleines Budget = "spielt nur ein paar Wege durch"
   * (= schwächerer Bot), großes Budget = findet fast immer die exakte Lösung.
   * seed (optional) mischt die Startreihenfolge → jeder Bot sucht anders. */
  function solve(nums, target, budget, seed) {
    var start = nums.map(function (v) { return { v: v, n: 1, a: null, b: null, op: null }; });
    if (seed) shuffle(start, rngFrom(seed));
    var best = null, nodes = 0, stop = false;
    var deadline = Date.now() + 600;

    function consider(it) {
      if (it.n < 2) return;                                  // nur errechnete Werte zählen
      var d = Math.abs(it.v - target);
      if (!best || d < best.d || (d === best.d && it.n < best.it.n)) best = { d: d, it: it };
    }
    function rec(list) {
      if (stop || (best && best.d === 0)) return;
      var i, j, k;
      for (i = 0; i < list.length; i++) {
        for (j = i + 1; j < list.length; j++) {
          var x = list[i], y = list[j];
          var hi = x.v >= y.v ? x : y, lo = x.v >= y.v ? y : x;
          var rest = [];
          for (k = 0; k < list.length; k++) if (k !== i && k !== j) rest.push(list[k]);
          var made = [];
          made.push({ v: hi.v + lo.v, op: '+' });
          if (hi.v - lo.v > 0) made.push({ v: hi.v - lo.v, op: '−' });
          if (lo.v > 1) made.push({ v: hi.v * lo.v, op: '×' });
          if (lo.v > 1 && hi.v % lo.v === 0) made.push({ v: hi.v / lo.v, op: '÷' });
          for (k = 0; k < made.length; k++) {
            nodes++;
            if (nodes > budget || (nodes % 2048 === 0 && Date.now() > deadline)) { stop = true; return; }
            var node = { v: made[k].v, n: hi.n + lo.n, a: hi, b: lo, op: made[k].op };
            consider(node);
            if (best && best.d === 0) return;
            if (rest.length) rec(rest.concat([node]));
            if (stop) return;
          }
        }
      }
    }
    rec(start);
    if (!best) return null;
    return { dist: best.d, value: best.it.v, steps: stepsOf(best.it) };
  }

  /* Rechenweg eines Knotens als lesbare Schritte ("75 × 9 = 675"). */
  function stepsOf(node) {
    var out = [];
    (function walk(n) {
      if (!n || !n.a) return;
      walk(n.a); walk(n.b);
      out.push(n.a.v + ' ' + n.op + ' ' + n.b.v + ' = ' + n.v);
    })(node);
    return out;
  }

  /* ===================== Punkte ===================== */
  /* Exakt = 100, sonst zählt der Abstand — streng fallend bis 0 ab Δ151. */
  function scoreFor(dist) {
    if (dist == null || !isFinite(dist)) return 0;
    if (dist === 0) return 100;
    if (dist <= 5) return 78 - dist * 3;                        // 75 … 63
    if (dist <= 10) return 72 - dist * 2;                       // 60 … 52
    if (dist <= 25) return 50 - (dist - 11) * 2;                // 50 … 22
    if (dist <= 50) return 21 - Math.round((dist - 26) * 0.5);  // 21 … 9
    if (dist <= 150) return Math.max(1, 8 - Math.round((dist - 51) / 14));
    return 0;
  }

  App.Minigames.numbercruncher = {
    id: 'numbercruncher', title: 'Zahlen-Ziel', icon: '🔢', order: 169,
    subtitle: 'Sechs Zahlen, ein Ziel — rechne schneller!',
    single: true, multi: true, minPlayers: 2, maxPlayers: 8,

    render: function (root, ctx) {
      var isMulti = ctx.mode === 'multi';
      var room = isMulti ? ctx.room : null;
      var nowFn = isMulti ? room.now : function () { return Date.now(); };

      var dead = false;
      var stops = [];        // stop()-Funktionen (App.MG-Bausteine, Listener) — je Ansicht
      var pending = [];      // laufende setTimeout-IDs

      var gStart = 0;        // Startzeit der Partie (Wall-Clock)
      var seedBase = 0;      // Seed für alle Puzzles dieser Partie
      var total = 0;         // Gesamtpunkte über die bereits gewerteten Runden
      var bots = null;       // nur Solo
      var rd = null;         // Zustand der laufenden Runde
      var refs = null;       // DOM-Referenzen der Rundenansicht

      function after(ms, fn) { var t = setTimeout(function () { if (!dead) fn(); }, ms); pending.push(t); return t; }
      function clearPending() { pending.forEach(clearTimeout); pending = []; }
      function stopHelpers() { stops.forEach(function (f) { try { f(); } catch (e) {} }); stops = []; }
      function cleanup() { dead = true; clearPending(); stopHelpers(); }
      function sfx(n) { if (App.Audio) App.Audio.sfx(n); }

      /* ---- Start (exakt wie reflex.js) ---- */
      if (isMulti) {
        var snap = ctx.room.snapshot() || {};
        var startAt = (snap.round && snap.round.startAt) || (ctx.room.now() + 3000);
        stops.push(App.MG.countdown(root, startAt, function () { play(startAt); }, ctx.room.now));
      } else {
        play(Date.now());
      }
      return { cleanup: cleanup };

      /* ===================== Partie ===================== */
      function makeBots() {
        return [
          { id: 'b1', name: 'Rechen-Papagei', icon: '🦜', rough: 120, full: 900, slip: 0.5, score: 0, cur: null },
          { id: 'b2', name: 'Zahlen-Affe', icon: '🐒', rough: 400, full: 9000, slip: 0.3, score: 0, cur: null },
          { id: 'b3', name: 'Kalkül-Kobra', icon: '🐍', rough: 1500, full: 120000, slip: 0.14, score: 0, cur: null }
        ];
      }

      function play(startAt) {
        clearPending(); stopHelpers();
        gStart = startAt;
        seedBase = Math.floor(startAt / 1000) >>> 0;
        total = 0;
        bots = isMulti ? null : makeBots();
        if (isMulti) {
          room.reportScore(0);
          room.reportState(null);
          /* Der Host verteilt die Puzzles in den Raum. Er erzeugt sie aus
           * demselben Seed wie alle anderen — shared und Eigenberechnung sind
           * daher immer identisch. */
          if (room.isHost()) {
            var list = [], i;
            for (i = 0; i < ROUNDS; i++) list.push(makePuzzle((seedBase + i * 7919) >>> 0));
            room.setShared({ puzzles: list, seed: seedBase });
          }
        }
        startRound(0);
      }

      function puzzleFor(i) {
        if (isMulti) {
          var sh = (room.snapshot() || {}).shared || {};
          var p = sh.puzzles && sh.puzzles[i];
          if (p && p.nums && p.nums.length === 6 && p.target) return { nums: p.nums.slice(), target: p.target };
        }
        return makePuzzle((seedBase + i * 7919) >>> 0);
      }

      function newRound(i) {
        var p = puzzleFor(i);
        var r = {
          i: i, target: p.target, nums: p.nums, tiles: [], steps: [],
          bestDist: Infinity, bestVal: null, bestSteps: [], pts: 0,
          sel: null, op: null, solution: null, exact: false, counted: false
        };
        for (var k = 0; k < p.nums.length; k++) {
          r.tiles.push({ id: k, v: p.nums[k], used: false, calc: false, el: null,
            node: { v: p.nums[k], n: 1, a: null, b: null, op: null } });
        }
        return r;
      }

      /* Rundenfahrplan hängt nur an gStart → jeder rechnet dieselbe Zeit aus. */
      function startRound(i) {
        if (dead) return;
        clearPending(); stopHelpers();
        if (i >= ROUNDS) { finish(); return; }

        var rStart = gStart + i * (ROUND_MS + SUMMARY_MS);
        var rEnd = rStart + ROUND_MS;
        var sEnd = rEnd + SUMMARY_MS;
        var t = nowFn();
        if (t >= sEnd) { startRound(i + 1); return; }        // Runde komplett verpasst

        rd = newRound(i);
        if (t >= rEnd) { showSummary(sEnd); return; }        // mitten in der Auswertung eingestiegen

        buildRoundView();
        /* Löser + Bots erst kurz nach dem Aufbau starten, damit die Ansicht
         * sofort steht (die Suche rechnet ein paar Dutzend Millisekunden). */
        after(60, function () {
          rd.solution = solve(rd.nums, rd.target, SOLVE_BUDGET, 0);
        });
        if (bots) scheduleBots(rEnd - t);

        stops.push(App.MG.roundTimer(rEnd, function (left) {
          if (!refs || !refs.timer) return;
          refs.timer.textContent = App.MG.mmss(left);
          refs.timer.classList.toggle('num-urgent', left <= 10);
        }, function () { endRound(sEnd); }, isMulti ? room.now : null));
      }

      /* ---- Bots (Solo): rechnen wirklich, nur unterschiedlich gründlich ---- */
      function scheduleBots(msLeft) {
        var rnd = rngFrom((seedBase + rd.i * 131 + 17) >>> 0);
        bots.forEach(function (b, idx) {
          b.cur = null;
          var s1 = (seedBase + rd.i * 977 + idx * 31 + 3) >>> 0;
          var s2 = (seedBase + rd.i * 613 + idx * 97 + 11) >>> 0;
          var slip = rnd() < b.slip;
          var t1 = msLeft * (0.22 + rnd() * 0.2);
          var t2 = msLeft * (0.55 + rnd() * 0.32);
          after(t1, function () {
            var r = solve(rd.nums, rd.target, b.rough, s1);
            if (r) applyBot(b, r);
          });
          after(t2, function () {
            var r = solve(rd.nums, rd.target, slip ? b.rough * 2 : b.full, s2);
            if (r) applyBot(b, r);
          });
        });
      }
      function applyBot(b, r) {
        if (b.cur && b.cur.d <= r.dist) return;              // Bots verschlechtern sich nie
        b.cur = { v: r.value, d: r.dist, pts: scoreFor(r.dist), steps: r.steps };
        updateBoard();
      }

      /* ===================== Rundenansicht ===================== */
      function buildRoundView() {
        var roundEl = el('div', { class: 'num-hv' }, ['Runde ' + (rd.i + 1) + ' / ' + ROUNDS]);
        var totalEl = el('div', { class: 'num-hv num-hv-gold' }, [String(total) + ' Pkt']);
        var timerEl = el('div', { class: 'mg-timer num-timer' }, [App.MG.mmss(ROUND_MS / 1000)]);
        var top = el('div', { class: 'num-top glass' }, [
          el('div', { class: 'num-hcell' }, [el('span', { class: 'num-lbl' }, ['Runde']), roundEl]),
          el('div', { class: 'num-hcell num-hcell-mid' }, [el('span', { class: 'num-lbl' }, ['Gesamt']), totalEl]),
          el('div', { class: 'num-hcell num-hcell-r' }, [el('span', { class: 'num-lbl' }, ['Zeit']), timerEl])
        ]);

        var targetEl = el('div', { class: 'num-target-v' }, [String(rd.target)]);
        var bestEl = el('div', { class: 'num-best' }, ['Noch kein Ergebnis']);
        var targetCard = el('div', { class: 'num-target glass' }, [
          el('div', { class: 'num-lbl' }, ['🎯 Zielzahl']), targetEl, bestEl
        ]);

        var exprEl = el('div', { class: 'num-expr' }, ['Zahl antippen …']);

        var tilesEl = el('div', { class: 'num-tiles' });
        var opsEl = el('div', { class: 'num-ops' });

        refs = {
          target: targetEl, best: bestEl, expr: exprEl, tiles: tilesEl, ops: opsEl,
          timer: timerEl, total: totalEl, steps: null, board: null, opBtns: {}
        };

        rd.tiles.forEach(function (t) { tilesEl.appendChild(makeTileEl(t)); });

        ['+', '−', '×', '÷'].forEach(function (sym) {
          var b = el('button', { class: 'num-op', type: 'button', onclick: function () { chooseOp(sym); } }, [sym]);
          refs.opBtns[sym] = b;
          opsEl.appendChild(b);
        });
        opsEl.appendChild(el('button', { class: 'num-op num-op-undo', type: 'button', title: 'Rückgängig', onclick: undo }, ['⟲']));
        opsEl.appendChild(el('button', { class: 'num-op num-op-reset', type: 'button', title: 'Von vorn', onclick: resetRound }, ['✕']));

        var stepsEl = el('div', { class: 'num-steps' });
        refs.steps = stepsEl;

        var rules = el('p', { class: 'hint-text num-rules' }, [
          'Zahl → Rechenzeichen → Zahl. Jede Zahl nur einmal, Ergebnisse werden neue Plättchen. Exakt = 100 Pkt, knapp daneben zählt auch.'
        ]);

        var boardBox;
        if (isMulti) {
          var lb = App.MG.liveBoard(room, ctx.me.id);
          stops.push(lb.stop);
          refs.board = lb;
          boardBox = el('div', { class: 'num-boardbox glass' }, [
            el('div', { class: 'mg-field-title' }, ['🏆 Rangliste']), lb.root
          ]);
        } else {
          var rows = el('div', { class: 'mg-scoreboard' });
          refs.board = rows;
          boardBox = el('div', { class: 'num-boardbox glass' }, [
            el('div', { class: 'mg-field-title' }, ['🏆 Rangliste']), rows
          ]);
        }

        root.innerHTML = '';
        root.appendChild(el('div', { class: 'num-wrap' }, [
          top, targetCard, exprEl, tilesEl, opsEl, stepsEl, rules, boardBox
        ]));

        var keyHandler = function (e) { onKey(e); };
        document.addEventListener('keydown', keyHandler);
        stops.push(function () { document.removeEventListener('keydown', keyHandler); });

        updateOps(); updateSteps(); updateBoard();
        sfx('start');
      }

      function makeTileEl(t) {
        var b = el('button', { class: 'num-tile' + (t.calc ? ' num-tile-calc' : '') + (t.calc ? ' is-new' : ''),
          type: 'button', onclick: function () { tapTile(t); } }, [String(t.v)]);
        t.el = b;
        return b;
      }

      function liveTiles() { return rd.tiles.filter(function (t) { return !t.used; }); }

      /* ---- Eingabe ---- */
      function tapTile(t) {
        if (dead || !rd || t.used) return;
        if (rd.sel && rd.op) {
          if (t === rd.sel) { setMsg('Zwei verschiedene Zahlen wählen', 'bad'); return; }
          combine(rd.sel, t, rd.op);
          return;
        }
        if (rd.sel === t) { rd.sel = null; sfx('click'); }
        else { rd.sel = t; sfx('select'); }
        rd.op = null;
        paintSelection(); updateExpr(); updateOps();
      }

      function chooseOp(sym) {
        if (dead || !rd) return;
        if (!rd.sel) { setMsg('Erst eine Zahl antippen', 'bad'); sfx('error'); return; }
        rd.op = (rd.op === sym) ? null : sym;
        if (App.Audio) App.Audio.blip(rd.op ? 620 : 380, 0.08, { type: 'square', peak: 0.05 });
        updateExpr(); updateOps();
      }

      function combine(a, b, sym) {
        var x = a.node.v, y = b.node.v, v;
        if (sym === '+') v = x + y;
        else if (sym === '−') {
          v = x - y;
          if (v <= 0) { setMsg('Ergebnis wäre ' + v + ' — größere Zahl zuerst', 'bad'); sfx('error'); shake(); return; }
        } else if (sym === '×') v = x * y;
        else {
          if (y === 0 || x % y !== 0) { setMsg(x + ' ÷ ' + y + ' geht nicht glatt auf', 'bad'); sfx('error'); shake(); return; }
          v = x / y;
        }

        a.used = true; b.used = true;
        var t = { id: rd.tiles.length, v: v, used: false, calc: true, el: null,
          node: { v: v, n: a.node.n + b.node.n, a: a.node, b: b.node, op: sym } };
        rd.tiles.push(t);
        rd.steps.push({ a: a, b: b, op: sym, res: t });
        refs.tiles.appendChild(makeTileEl(t));

        rd.sel = t; rd.op = null;                            // Ergebnis gleich weiterrechnen
        paintSelection(); updateOps(); updateSteps();
        setMsg(x + ' ' + sym + ' ' + y + ' = ' + v, 'ok');
        checkBest(t);
        if (!rd.exact) sfx('pop');
      }

      function undo() {
        if (dead || !rd || !rd.steps.length) return;
        var s = rd.steps.pop();
        s.a.used = false; s.b.used = false;
        var idx = rd.tiles.indexOf(s.res);
        if (idx >= 0) rd.tiles.splice(idx, 1);
        if (s.res.el && s.res.el.parentNode) s.res.el.parentNode.removeChild(s.res.el);
        rd.sel = null; rd.op = null;
        paintSelection(); updateOps(); updateSteps();
        setMsg('Zurückgenommen — dein bester Wert bleibt', 'info');
        sfx('whoosh');
      }

      function resetRound() {
        if (dead || !rd || !rd.steps.length) return;
        while (rd.steps.length) {
          var s = rd.steps.pop();
          s.a.used = false; s.b.used = false;
          var idx = rd.tiles.indexOf(s.res);
          if (idx >= 0) rd.tiles.splice(idx, 1);
          if (s.res.el && s.res.el.parentNode) s.res.el.parentNode.removeChild(s.res.el);
        }
        rd.sel = null; rd.op = null;
        paintSelection(); updateOps(); updateSteps();
        setMsg('Alles zurückgesetzt', 'info');
        sfx('whoosh');
      }

      function onKey(e) {
        if (!rd || dead) return;
        var k = e.key;
        if (k === 'Backspace') { e.preventDefault(); undo(); return; }
        if (k === 'Delete') { e.preventDefault(); resetRound(); return; }
        var map = { '+': '+', '-': '−', '*': '×', 'x': '×', 'X': '×', '/': '÷', ':': '÷' };
        if (map[k]) { e.preventDefault(); chooseOp(map[k]); return; }
        if (k >= '1' && k <= '9') {
          var live = liveTiles(), n = parseInt(k, 10) - 1;
          if (live[n]) { e.preventDefault(); tapTile(live[n]); }
        }
      }

      /* ---- bester Wert der Runde ---- */
      function checkBest(t) {
        var d = Math.abs(t.v - rd.target);
        if (d >= rd.bestDist) return;
        rd.bestDist = d; rd.bestVal = t.v; rd.bestSteps = stepsOf(t.node);
        rd.pts = scoreFor(d);
        updateBest();
        updateBoard();
        if (isMulti) room.reportScore(total + rd.pts);
        if (d === 0 && !rd.exact) {
          rd.exact = true;
          sfx('jackpot');
          if (refs && refs.target) {
            refs.target.classList.remove('num-hit'); void refs.target.offsetWidth; refs.target.classList.add('num-hit');
          }
          UI.toast('🎯 Exakt getroffen — 100 Punkte!', 'success');
        } else {
          sfx('point');
        }
        if (refs && refs.best) { refs.best.classList.remove('num-bump'); void refs.best.offsetWidth; refs.best.classList.add('num-bump'); }
      }

      /* ---- Anzeige ---- */
      function setMsg(text, kind) {
        if (!refs || !refs.expr) return;
        refs.expr.className = 'num-expr num-expr-' + (kind || 'info');
        refs.expr.textContent = text;
      }
      function updateExpr() {
        if (!refs) return;
        if (!rd.sel) { setMsg('Zahl antippen …', 'info'); return; }
        if (!rd.op) { setMsg(rd.sel.v + ' — jetzt ein Rechenzeichen', 'info'); return; }
        setMsg(rd.sel.v + ' ' + rd.op + ' ?', 'info');
      }
      function paintSelection() {
        rd.tiles.forEach(function (t) {
          if (!t.el) return;
          t.el.classList.toggle('is-used', t.used);
          t.el.classList.toggle('is-sel', t === rd.sel && !t.used);
        });
      }
      function updateOps() {
        if (!refs) return;
        ['+', '−', '×', '÷'].forEach(function (sym) {
          var b = refs.opBtns[sym];
          if (!b) return;
          b.classList.toggle('is-on', rd.op === sym);
          b.classList.toggle('is-dim', !rd.sel);
        });
      }
      function updateBest() {
        if (!refs || !refs.best) return;
        if (rd.bestVal == null) { refs.best.textContent = 'Noch kein Ergebnis'; refs.best.className = 'num-best'; return; }
        refs.best.className = 'num-best' + (rd.bestDist === 0 ? ' is-exact' : '');
        refs.best.textContent = rd.bestDist === 0
          ? '🎯 ' + rd.bestVal + ' — exakt! 100 Punkte'
          : 'Beste: ' + rd.bestVal + ' · Abstand ' + rd.bestDist + ' · ' + rd.pts + ' Pkt';
      }
      function updateSteps() {
        if (!refs || !refs.steps) return;
        refs.steps.innerHTML = '';
        if (!rd.steps.length) {
          refs.steps.appendChild(el('div', { class: 'num-step num-step-empty' }, ['Noch nichts gerechnet']));
          return;
        }
        rd.steps.forEach(function (s) {
          refs.steps.appendChild(el('div', { class: 'num-step' }, [s.a.v + ' ' + s.op + ' ' + s.b.v + ' = ' + s.res.v]));
        });
        refs.steps.scrollTop = refs.steps.scrollHeight;
      }
      function shake() {
        if (!refs || !refs.tiles) return;
        refs.tiles.classList.remove('num-shake'); void refs.tiles.offsetWidth; refs.tiles.classList.add('num-shake');
      }

      /* Rangliste: Multi über App.MG.liveBoard (reportScore), Solo lokal. */
      function updateBoard() {
        if (!refs || !refs.board) return;
        if (isMulti) { refs.board.update(); return; }
        var list = [{ name: 'Du (du)', score: total + (rd ? rd.pts : 0), me: true }];
        bots.forEach(function (b) {
          list.push({ name: b.icon + ' ' + b.name, score: b.score + (b.cur ? b.cur.pts : 0), me: false });
        });
        list.sort(function (a, b) { return b.score - a.score; });
        refs.board.innerHTML = '';
        list.forEach(function (p, i) {
          refs.board.appendChild(el('div', { class: 'mg-sb-row p' + (i + 1) + (p.me ? ' me' : '') }, [
            el('span', { class: 'mg-sb-rank' }, ['' + (i + 1)]),
            el('span', { class: 'mg-sb-name' }, [p.name]),
            el('span', { class: 'mg-sb-score' }, [String(p.score)])
          ]));
        });
      }

      /* ===================== Rundenende + Auswertung ===================== */
      function endRound(sEnd) {
        if (dead || !rd || rd.counted) return;
        rd.counted = true;
        total += rd.pts;
        if (bots) bots.forEach(function (b) { if (b.cur) b.score += b.cur.pts; });
        if (isMulti) {
          room.reportScore(total);
          if (rd.bestVal != null) room.reportState({ r: rd.i, v: rd.bestVal, d: rd.bestDist, p: rd.pts });
          else room.reportState({ r: rd.i, v: 0, d: 999, p: 0 });
        }
        sfx(rd.pts >= 100 ? 'win' : 'ding');
        showSummary(sEnd);
      }

      function showSummary(sEnd) {
        clearPending(); stopHelpers();
        if (dead) return;
        if (!rd.solution) rd.solution = solve(rd.nums, rd.target, SOLVE_BUDGET, 0);

        var myLine = rd.bestVal == null
          ? el('div', { class: 'num-sum-big num-sum-miss' }, ['—'])
          : el('div', { class: 'num-sum-big' + (rd.bestDist === 0 ? ' is-exact' : '') }, [String(rd.bestVal)]);

        var mySteps = rd.bestSteps.length
          ? el('div', { class: 'num-sol' }, rd.bestSteps.map(function (s) { return el('div', { class: 'num-sol-step' }, [s]); }))
          : el('p', { class: 'hint-text' }, ['Diese Runde ist dir nichts gelungen — nächste Runde!']);

        var sol = rd.solution;
        var solBox = el('div', { class: 'num-solbox' }, [
          el('div', { class: 'mg-field-title' }, [sol && sol.dist === 0 ? '💡 Perfekte Lösung' : '💡 Beste gefundene Lösung']),
          sol
            ? el('div', { class: 'num-sol' }, sol.steps.map(function (s) { return el('div', { class: 'num-sol-step' }, [s]); })
                .concat([el('div', { class: 'num-sol-res' }, [sol.dist === 0 ? '= ' + rd.target + ' 🎯' : '= ' + sol.value + ' (Abstand ' + sol.dist + ')'])]))
            : el('p', { class: 'hint-text' }, ['Keine Lösung gefunden.'])
        ]);

        var rowsEl = el('div', { class: 'mg-scoreboard num-sum-rows' });
        var nextEl = el('p', { class: 'hint-text num-next' }, ['']);

        var panel = el('div', { class: 'num-sum glass' }, [
          el('h2', { class: 'neon num-sum-h' }, ['Runde ' + (rd.i + 1) + ' vorbei']),
          el('div', { class: 'num-sum-grid' }, [
            el('div', { class: 'num-sum-cell' }, [el('div', { class: 'num-lbl' }, ['Ziel']), el('div', { class: 'num-sum-big num-sum-target' }, [String(rd.target)])]),
            el('div', { class: 'num-sum-cell' }, [el('div', { class: 'num-lbl' }, ['Dein Wert']), myLine]),
            el('div', { class: 'num-sum-cell' }, [el('div', { class: 'num-lbl' }, ['Abstand']), el('div', { class: 'num-sum-big' }, [rd.bestVal == null ? '—' : String(rd.bestDist)])]),
            el('div', { class: 'num-sum-cell' }, [el('div', { class: 'num-lbl' }, ['Punkte']), el('div', { class: 'num-sum-big num-sum-pts' }, ['+' + rd.pts])])
          ]),
          el('div', { class: 'num-sum-mine' }, [el('div', { class: 'mg-field-title' }, ['🧮 Dein Rechenweg']), mySteps]),
          solBox,
          el('div', { class: 'num-sum-all' }, [el('div', { class: 'mg-field-title' }, ['📊 Diese Runde']), rowsEl]),
          nextEl
        ]);
        root.innerHTML = ''; root.appendChild(panel);

        function renderRows() {
          if (dead) return;
          var list = summaryRows();
          rowsEl.innerHTML = '';
          list.forEach(function (p, i) {
            rowsEl.appendChild(el('div', { class: 'mg-sb-row p' + (i + 1) + (p.me ? ' me' : '') }, [
              el('span', { class: 'mg-sb-rank' }, ['' + (i + 1)]),
              el('span', { class: 'mg-sb-name' }, [p.name]),
              el('span', { class: 'num-sum-val' }, [p.v == null ? '—' : p.v + ' (Δ' + p.d + ')']),
              el('span', { class: 'mg-sb-score' }, ['+' + p.p])
            ]));
          });
        }
        renderRows();
        if (isMulti) {
          room.on('players', renderRows);                    // idempotent: baut nur die kleine Liste neu
          stops.push(function () { room.off('players', renderRows); });
        }

        stops.push(App.MG.roundTimer(sEnd, function (left) {
          nextEl.textContent = rd.i + 1 >= ROUNDS
            ? 'Endstand in ' + Math.ceil(left) + ' s …'
            : 'Runde ' + (rd.i + 2) + ' startet in ' + Math.ceil(left) + ' s …';
        }, function () { startRound(rd.i + 1); }, isMulti ? room.now : null));
      }

      function summaryRows() {
        var out = [];
        if (isMulti) {
          room.players().forEach(function (p) {
            var st = (p.state && p.state.r === rd.i) ? p.state : null;
            out.push({
              name: p.name + (p.id === ctx.me.id ? ' (du)' : ''), me: p.id === ctx.me.id,
              v: st && st.v ? st.v : null, d: st ? st.d : null, p: st ? st.p : 0
            });
          });
        } else {
          out.push({ name: 'Du (du)', me: true, v: rd.bestVal, d: rd.bestVal == null ? null : rd.bestDist, p: rd.pts });
          bots.forEach(function (b) {
            out.push({ name: b.icon + ' ' + b.name, me: false, v: b.cur ? b.cur.v : null, d: b.cur ? b.cur.d : null, p: b.cur ? b.cur.pts : 0 });
          });
        }
        out.sort(function (a, b) { return (b.p || 0) - (a.p || 0); });
        return out;
      }

      /* ===================== Ende ===================== */
      function finish() {
        clearPending(); stopHelpers();
        if (dead) return;
        if (isMulti) {
          room.reportScore(total);
          after(600, function () {
            App.MG.endScreen(root, { players: room.players(), meId: ctx.me.id, onExit: ctx.onExit });
          });
        } else {
          var best = App.Storage.get('best_numbercruncher', 0);
          var nb = total > best;
          if (nb) App.Storage.set('best_numbercruncher', total);
          var top = bots.slice().sort(function (a, b) { return b.score - a.score; })[0];
          var beat = top ? (total > top.score) : true;
          App.MG.endScreen(root, {
            score: total, best: best, newBest: nb,
            label: 'Punkte aus ' + ROUNDS + ' Runden · ' + (nb ? 'neuer Rekord! 🎉' : 'Bestwert: ' + best)
              + (top ? ' · ' + (beat ? 'geschlagen: ' : 'Sieger: ') + top.icon + ' ' + top.name + ' (' + top.score + ')' : ''),
            onExit: ctx.onExit,
            onAgain: function () { play(Date.now()); }
          });
        }
      }
    }
  };

  /* ===================== CSS ===================== */
  function injectStyle() {
    UI.injectStyle('mg-numbercruncher-css', [
      '.num-wrap{display:flex;flex-direction:column;gap:10px;max-width:560px;margin:0 auto;}',
      /* Kopfzeile */
      '.num-top{display:flex;justify-content:space-between;align-items:center;padding:9px 16px;gap:10px;}',
      '.num-hcell{display:flex;flex-direction:column;gap:1px;min-width:0;}',
      '.num-hcell-mid{text-align:center;}',
      '.num-hcell-r{text-align:right;}',
      '.num-lbl{font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:1.2px;font-weight:800;}',
      '.num-hv{font-size:clamp(15px,4vw,19px);font-weight:900;color:var(--leaf);font-variant-numeric:tabular-nums;line-height:1.1;}',
      '.num-hv-gold{color:var(--gold);text-shadow:0 0 10px rgba(255,210,63,.4);}',
      '.num-top .mg-timer{font-size:clamp(15px,4vw,19px);}',
      '.mg-timer.num-urgent{color:var(--danger);animation:num-pulse .7s infinite;}',
      /* Zielkarte */
      '.num-target{padding:10px 16px 12px;text-align:center;display:flex;flex-direction:column;gap:2px;align-items:center;',
      'border:1px solid var(--stroke-2);box-shadow:0 0 26px rgba(57,255,20,.14),inset 0 0 40px rgba(57,255,20,.05);}',
      '.num-target-v{font-size:clamp(38px,11vw,62px);font-weight:900;line-height:1;font-variant-numeric:tabular-nums;',
      'background:linear-gradient(180deg,#eaffe2,var(--neon));-webkit-background-clip:text;background-clip:text;',
      '-webkit-text-fill-color:transparent;color:transparent;filter:drop-shadow(0 0 12px rgba(57,255,20,.5));}',
      '.num-target-v.num-hit{animation:num-hit .7s cubic-bezier(.2,.8,.3,1);}',
      '.num-best{font-size:clamp(12px,3.2vw,14px);font-weight:800;color:var(--aqua);min-height:18px;font-variant-numeric:tabular-nums;}',
      '.num-best.is-exact{color:var(--gold);text-shadow:0 0 12px rgba(255,210,63,.55);}',
      '.num-best.num-bump{animation:num-bump .32s ease;}',
      /* Vorschau-/Meldezeile */
      '.num-expr{text-align:center;font-weight:900;font-size:clamp(15px,4.2vw,20px);min-height:26px;line-height:26px;',
      'font-variant-numeric:tabular-nums;transition:color .12s;}',
      '.num-expr-info{color:var(--muted);}',
      '.num-expr-ok{color:var(--neon);text-shadow:0 0 12px rgba(57,255,20,.45);}',
      '.num-expr-bad{color:var(--danger);}',
      /* Zahlenplättchen */
      '.num-tiles{display:flex;flex-wrap:wrap;gap:8px;justify-content:center;min-height:64px;align-items:center;}',
      '.num-tiles.num-shake{animation:num-shake .3s ease;}',
      '.num-tile{min-width:62px;height:62px;padding:0 8px;border-radius:14px;font-family:inherit;',
      'font-size:clamp(20px,5.2vw,26px);font-weight:900;font-variant-numeric:tabular-nums;color:#eafff0;',
      'background:linear-gradient(180deg,rgba(14,52,32,.95),rgba(6,24,16,.95));border:2px solid var(--stroke);',
      'cursor:pointer;user-select:none;-webkit-user-select:none;-webkit-tap-highlight-color:transparent;',
      'touch-action:manipulation;transition:transform .12s,border-color .15s,box-shadow .15s,min-width .18s,opacity .18s,font-size .18s;}',
      '.num-tile:hover{border-color:var(--neon);box-shadow:0 0 16px rgba(57,255,20,.28);transform:translateY(-2px);}',
      '.num-tile:active{transform:scale(.94);}',
      '.num-tile-calc{border-color:rgba(51,230,208,.55);color:var(--aqua-soft);}',
      '.num-tile.is-new{animation:num-pop .26s cubic-bezier(.2,.8,.3,1);}',
      '.num-tile.is-sel{border-color:var(--gold);box-shadow:0 0 0 2px rgba(255,210,63,.35),0 0 22px rgba(255,210,63,.5);',
      'transform:translateY(-3px);color:var(--gold);}',
      '.num-tile.is-used{min-width:38px;height:38px;font-size:12px;opacity:.28;filter:grayscale(.7);',
      'pointer-events:none;text-decoration:line-through;transform:none;box-shadow:none;}',
      /* Rechenzeichen */
      '.num-ops{display:flex;gap:8px;justify-content:center;flex-wrap:wrap;}',
      '.num-op{width:56px;height:50px;border-radius:13px;font-family:inherit;font-size:24px;font-weight:900;',
      'color:var(--leaf);background:rgba(9,32,21,.72);border:2px solid var(--stroke);cursor:pointer;',
      '-webkit-tap-highlight-color:transparent;touch-action:manipulation;user-select:none;-webkit-user-select:none;',
      'transition:transform .1s,border-color .15s,box-shadow .15s,opacity .15s,color .15s;}',
      '.num-op:hover{border-color:var(--aqua);color:var(--aqua);}',
      '.num-op:active{transform:scale(.93);}',
      '.num-op.is-dim{opacity:.42;}',
      '.num-op.is-on{border-color:var(--gold);color:var(--gold);background:rgba(60,44,8,.7);',
      'box-shadow:0 0 18px rgba(255,210,63,.45);animation:num-bump .3s ease;}',
      '.num-op-undo{color:var(--aqua);border-color:rgba(51,230,208,.4);}',
      '.num-op-reset{color:var(--danger);border-color:rgba(255,77,109,.4);}',
      /* Rechenweg */
      '.num-steps{display:flex;flex-direction:column;gap:2px;max-height:74px;overflow-y:auto;',
      'padding:6px 10px;border-radius:11px;background:rgba(4,16,10,.5);border:1px solid var(--stroke);}',
      '.num-step{font-size:13px;font-weight:800;color:var(--aqua-soft);font-variant-numeric:tabular-nums;',
      'animation:num-slide .2s ease;}',
      '.num-step-empty{color:var(--muted);font-weight:600;}',
      '.num-rules{margin:0;text-align:center;font-size:11.5px;line-height:1.4;}',
      '.num-boardbox{padding:12px 14px;display:flex;flex-direction:column;gap:7px;}',
      '.num-boardbox .mg-scoreboard{max-height:190px;overflow-y:auto;}',
      /* Auswertung */
      '.num-sum{padding:20px 18px;display:flex;flex-direction:column;gap:12px;max-width:560px;margin:0 auto;',
      'animation:num-in .35s cubic-bezier(.2,.8,.3,1) both;}',
      '.num-sum-h{margin:0;text-align:center;font-size:clamp(20px,5.5vw,26px);}',
      '.num-sum-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;text-align:center;}',
      '.num-sum-cell{padding:8px 4px;border-radius:12px;background:rgba(9,32,21,.55);border:1px solid var(--stroke);}',
      '.num-sum-big{font-size:clamp(18px,5vw,26px);font-weight:900;line-height:1.15;color:var(--leaf);font-variant-numeric:tabular-nums;}',
      '.num-sum-big.is-exact{color:var(--gold);text-shadow:0 0 12px rgba(255,210,63,.5);}',
      '.num-sum-target{color:var(--neon);text-shadow:0 0 12px rgba(57,255,20,.45);}',
      '.num-sum-pts{color:var(--gold);}',
      '.num-sum-miss{color:var(--muted);}',
      '.num-sum-mine,.num-solbox,.num-sum-all{display:flex;flex-direction:column;gap:5px;}',
      '.num-sol{display:flex;flex-direction:column;gap:2px;padding:8px 10px;border-radius:11px;',
      'background:rgba(4,16,10,.55);border:1px solid var(--stroke);max-height:132px;overflow-y:auto;}',
      '.num-sol-step{font-size:13px;font-weight:800;color:var(--aqua-soft);font-variant-numeric:tabular-nums;}',
      '.num-sol-res{font-size:14px;font-weight:900;color:var(--gold);margin-top:2px;}',
      '.num-sum-rows{max-height:180px;overflow-y:auto;}',
      '.num-sum-val{font-size:12px;color:var(--muted);font-weight:800;font-variant-numeric:tabular-nums;white-space:nowrap;}',
      '.num-next{margin:0;text-align:center;font-weight:800;color:var(--aqua);}',
      /* Animationen */
      '@keyframes num-pop{0%{transform:scale(.3) rotate(-8deg);opacity:0}70%{transform:scale(1.16) rotate(2deg);opacity:1}100%{transform:scale(1) rotate(0)}}',
      '@keyframes num-bump{0%{transform:scale(1)}45%{transform:scale(1.16)}100%{transform:scale(1)}}',
      '@keyframes num-hit{0%{transform:scale(1)}30%{transform:scale(1.3);filter:drop-shadow(0 0 30px rgba(255,210,63,.95))}100%{transform:scale(1)}}',
      '@keyframes num-shake{0%,100%{transform:translateX(0)}25%{transform:translateX(-8px)}75%{transform:translateX(8px)}}',
      '@keyframes num-pulse{0%,100%{opacity:1}50%{opacity:.35}}',
      '@keyframes num-slide{from{opacity:0;transform:translateX(-8px)}to{opacity:1;transform:translateX(0)}}',
      '@keyframes num-in{from{opacity:0;transform:translateY(12px) scale(.98)}to{opacity:1;transform:translateY(0) scale(1)}}',
      /* schmale Handys: alles bleibt ohne Scrollen erreichbar */
      '@media (max-width:400px){',
      '.num-tile{min-width:54px;height:54px;}',
      '.num-op{width:50px;height:46px;font-size:21px;}',
      '.num-sum-grid{grid-template-columns:repeat(2,1fr);}',
      '}'
    ].join(''));
  }
})();
