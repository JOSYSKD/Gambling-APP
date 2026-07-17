/* slidingpuzzle.js — "15er-Puzzle": Schiebepuzzle-Wettrennen im Neon-Dschungel.
 *
 * IDEE
 *   Ein 4x4-Gitter mit 15 nummerierten Kacheln und einer Lücke. Angrenzende
 *   Kacheln rutschen in die Lücke — Ziel: 1 … 15 in Reihenfolge, Lücke unten
 *   rechts. Gelöst -> sofort das nächste, schwerere Puzzle (ab dem 4. Puzzle
 *   5x5 mit 24 Kacheln). 3 Minuten am Stück, danach Endscreen.
 *
 * STEUERUNG
 *   - Kachel antippen/anklicken: rutscht in die Lücke. Liegt sie in derselben
 *     Reihe/Spalte wie die Lücke, wandert die ganze Kachel-Kette mit.
 *   - Wischen auf dem Brett (pointerdown/move/up) schiebt die Kachel neben der
 *     Lücke in Wischrichtung — ideal fürs Handy/iPad.
 *   - Pfeiltasten / WASD machen dasselbe wie Wischen.
 *
 * PUNKTE  (pro gelöstem Puzzle, Aufschlüsselung wird kurz eingeblendet)
 *   Basis   : 500 (4x4) bzw. 1200 (5x5)
 *   Züge    : (Par − gebrauchte Züge) x 8, nie negativ  -> wenige Züge zahlen sich aus
 *   Tempo   : Basis − Sekunden x 8, nie negativ         -> schnell sein zahlt sich aus
 *
 * SYNC-MODELL (multi)
 *   Punkte-Rennen wie reflex.js: alle spielen gleichzeitig dasselbe Puzzle.
 *   Fairness über einen gemeinsamen Seed: der Host schreibt ihn per
 *   room.setShared({slpSeed}). Der Seed ist bewusst DETERMINISTISCH aus
 *   round.startAt abgeleitet (seedFromStart) — wer das setShared-Feld noch
 *   nicht hat, rechnet exakt denselben Wert selbst aus, ein Auseinanderlaufen
 *   ist damit unmöglich. Jedes Puzzle k mischt mit hash32(seed, k), die
 *   Mischung entsteht aus zufälligen LEGALEN Zügen (immer lösbar) und wird
 *   zusätzlich per isSolvable() geprüft/erzwungen.
 *   Fortschritt: room.reportScore(punkte) + room.reportState({p, prog}) ->
 *   eigene Live-Rangliste mit Puzzle-Nummer und Fortschrittsbalken.
 *
 * SOLO
 *   Punktejagd gegen App.Storage 'best_slidingpuzzle' — plus drei Bots mit
 *   unterschiedlicher Stärke, die realistisch lange brauchen (Fortschritt
 *   startet schnell und zäht sich zum Schluss, wie bei echten Schiebepuzzles).
 *
 * Alle Timer laufen über Wall-Clock (Date.now bzw. room.now) -> Tab-sicher.
 * cleanup() setzt dead=true, killt Timer und alle Listener.
 */
(function () {
  'use strict';
  window.App = window.App || {}; App.Minigames = App.Minigames || {};
  var UI = App.UI, el = UI.el;

  injectStyle();

  var DURATION = 180;              // s Rundenzeit (3 Minuten)
  var TAP_SLOP = 12;               // px: darunter gilt es als Tippen, darüber als Wischen

  /* ================= Puzzle-Mathematik (rein, ohne DOM) ================= */

  /* Deterministischer PRNG (mulberry32) — gleicher Seed = gleiche Mischung. */
  function rng(seed) {
    var s = seed >>> 0;
    return function () {
      s = (s + 0x6D2B79F5) >>> 0;
      var t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function hash32(a, b) {
    var h = (a >>> 0) ^ Math.imul(b >>> 0, 0x9E3779B1);
    h = Math.imul(h ^ (h >>> 16), 0x85EBCA6B);
    h = Math.imul(h ^ (h >>> 13), 0xC2B2AE35);
    return (h ^ (h >>> 16)) >>> 0;
  }
  /* Seed aus der Server-Startzeit — jedes Gerät rechnet denselben Wert. */
  function seedFromStart(startAt) { return hash32(Math.floor(startAt / 1000) >>> 0, 0x5715); }

  /* Stufen: erst 4x4 (immer stärker gemischt), ab dem 4. Puzzle 5x5. */
  function stageOf(idx) {
    if (idx === 0) return { n: 4, scramble: 26 };
    if (idx === 1) return { n: 4, scramble: 55 };
    if (idx === 2) return { n: 4, scramble: 110 };
    if (idx === 3) return { n: 5, scramble: 80 };
    return { n: 5, scramble: Math.min(240, 120 + (idx - 4) * 25) };
  }
  function parOf(stage) { return Math.round(stage.scramble * 1.6) + 24; }
  function baseOf(stage) { return stage.n === 4 ? 500 : 1200; }

  function solvedGrid(n) {
    var g = [], i;
    for (i = 0; i < n * n - 1; i++) g.push(i + 1);
    g.push(0);
    return g;
  }
  function isSolved(g) {
    for (var i = 0; i < g.length - 1; i++) if (g[i] !== i + 1) return false;
    return g[g.length - 1] === 0;
  }
  /* Standard-Parität: ungerade Breite -> Inversionen gerade; gerade Breite ->
     (Inversionen + Lücken-Reihe von unten) muss ungerade sein. */
  function isSolvable(g, n) {
    var inv = 0, i, j, blank = g.indexOf(0);
    for (i = 0; i < g.length; i++) {
      if (g[i] === 0) continue;
      for (j = i + 1; j < g.length; j++) if (g[j] !== 0 && g[j] < g[i]) inv++;
    }
    if (n % 2 === 1) return inv % 2 === 0;
    var rowFromBottom = n - Math.floor(blank / n);
    return (inv + rowFromBottom) % 2 === 1;
  }
  /* Sicherheitsnetz: unlösbare Stellung durch Tausch zweier Kacheln kippen. */
  function forceSolvable(g, n) {
    if (isSolvable(g, n)) return g;
    var a = -1, b = -1, i;
    for (i = 0; i < g.length; i++) { if (g[i] !== 0) { if (a < 0) a = i; else { b = i; break; } } }
    var t = g[a]; g[a] = g[b]; g[b] = t;
    return g;
  }
  /* Mischen über zufällige legale Züge (dadurch garantiert lösbar), ohne den
     letzten Zug direkt zurückzunehmen. */
  function scramble(n, moves, rand) {
    var g = solvedGrid(n), blank = n * n - 1, last = -1, tries = 0;
    function step() {
      var opts = [], r = Math.floor(blank / n), c = blank % n;
      if (r > 0) opts.push(blank - n);
      if (r < n - 1) opts.push(blank + n);
      if (c > 0) opts.push(blank - 1);
      if (c < n - 1) opts.push(blank + 1);
      opts = opts.filter(function (x) { return x !== last; });
      var pick = opts[Math.floor(rand() * opts.length) % opts.length];
      last = blank;
      g[blank] = g[pick]; g[pick] = 0; blank = pick;
    }
    for (var i = 0; i < moves; i++) step();
    while (isSolved(g) && tries++ < 40) step();     // nie schon gelöst starten
    return forceSolvable(g, n);
  }

  /* Kachel-Kette, die beim Tippen auf idx in die Lücke rückt (nächste zuerst).
     Leeres Array = Zug nicht erlaubt. */
  function chainFor(g, n, idx) {
    var blank = g.indexOf(0);
    if (idx === blank || idx < 0 || idx >= n * n) return [];
    var r = Math.floor(idx / n), c = idx % n, br = Math.floor(blank / n), bc = blank % n;
    var list = [], step, x, y;
    if (r === br) {
      step = c < bc ? 1 : -1;
      for (x = bc - step; ; x -= step) { list.push(r * n + x); if (x === c) break; }
      return list;
    }
    if (c === bc) {
      step = r < br ? 1 : -1;
      for (y = br - step; ; y -= step) { list.push(y * n + c); if (y === r) break; }
      return list;
    }
    return [];
  }
  /* Welche Kachel rutscht bei Wischen/Pfeiltaste in Richtung dir? */
  function idxForDir(g, n, dir) {
    var blank = g.indexOf(0), br = Math.floor(blank / n), bc = blank % n;
    if (dir === 'right') return bc > 0 ? blank - 1 : -1;
    if (dir === 'left') return bc < n - 1 ? blank + 1 : -1;
    if (dir === 'down') return br > 0 ? blank - n : -1;
    if (dir === 'up') return br < n - 1 ? blank + n : -1;
    return -1;
  }
  function progressOf(g, n) {
    var ok = 0;
    for (var i = 0; i < n * n - 1; i++) if (g[i] === i + 1) ok++;
    return Math.round(ok * 100 / (n * n - 1));
  }
  /* Punkte für ein gelöstes Puzzle. */
  function scoreFor(stage, moves, sec) {
    var base = baseOf(stage), par = parOf(stage);
    var zug = Math.max(0, par - moves) * 8;
    var tempo = Math.max(0, Math.round(base - sec * 8));
    return { base: base, zug: zug, tempo: tempo, total: base + zug + tempo };
  }

  /* ================= Live-Rangliste mit Fortschritt ================= */
  /* Zeilen werden per id wiederverwendet (nur .order ändert sich) — dadurch
     bleiben die Balken-Übergänge weich und nichts flackert. */
  function makeRankList() {
    var listEl = el('div', { class: 'slp-list' });
    var nodes = {};
    function build() {
      var rank = el('span', { class: 'slp-rank' }, ['1']);
      var name = el('span', { class: 'slp-name' }, ['—']);
      var score = el('span', { class: 'slp-score' }, ['0']);
      var sub = el('span', { class: 'slp-sub' }, ['Puzzle 1']);
      var fill = el('i', { class: 'slp-fill' });
      var bar = el('div', { class: 'slp-bar' }, [fill]);
      var root = el('div', { class: 'slp-row' }, [
        rank,
        el('div', { class: 'slp-rowmain' }, [el('div', { class: 'slp-rowtop' }, [name, score]), bar]),
        sub
      ]);
      return { root: root, rank: rank, name: name, score: score, sub: sub, fill: fill };
    }
    function update(rows) {
      rows = rows.slice().sort(function (a, b) { return (b.score || 0) - (a.score || 0); });
      var seen = {};
      rows.forEach(function (r, i) {
        seen[r.id] = true;
        var nd = nodes[r.id];
        if (!nd) { nd = build(); nodes[r.id] = nd; listEl.appendChild(nd.root); }
        nd.root.style.order = String(i);
        nd.root.className = 'slp-row p' + (i + 1) + (r.me ? ' me' : '');
        nd.rank.textContent = String(i + 1);
        nd.name.textContent = r.name + (r.me ? ' (du)' : '');
        nd.score.textContent = App.MG.fmt(r.score || 0);
        nd.sub.textContent = 'Puzzle ' + (r.puzzle || 1) + ' · ' + Math.round(r.prog || 0) + '%';
        nd.fill.style.width = Math.max(2, Math.min(100, r.prog || 0)) + '%';
      });
      Object.keys(nodes).forEach(function (id) {
        if (!seen[id]) { if (nodes[id].root.parentNode) listEl.removeChild(nodes[id].root); delete nodes[id]; }
      });
    }
    return { root: listEl, update: update };
  }

  /* ================= Solo-Bots ================= */
  var BOT_DEFS = [
    { id: 'bot_w', name: 'Wurzel-Willi 🤖', skill: 0.72 },
    { id: 'bot_l', name: 'Liane-Lena 🤖', skill: 1.0 },
    { id: 'bot_n', name: 'Nova-Nadia 🤖', skill: 1.32 }
  ];
  function makeBots(seed) {
    return BOT_DEFS.map(function (d, i) {
      var rand = rng(hash32(seed, 900 + i));
      var b = { id: d.id, name: d.name, skill: d.skill, rand: rand, idx: 0, t0: 0, score: 0, prog: 0 };
      b.dur = botDur(b, 0);
      return b;
    });
  }
  /* Wie lange braucht ein Bot für Puzzle idx? Grundzeit nach Größe/Mischung,
     geteilt durch die Stärke, plus Streuung — nie unter 8 s. */
  function botDur(bot, idx) {
    var st = stageOf(idx);
    var base = (st.n === 4 ? 26 : 62) + st.scramble * 0.38;
    return Math.max(8, base / bot.skill * (0.82 + bot.rand() * 0.42));
  }
  function botTick(bot, elapsed) {
    var guard = 0;
    while (elapsed >= bot.t0 + bot.dur && guard++ < 30) {
      var st = stageOf(bot.idx), par = parOf(st);
      var moves = Math.round(par * (1.02 - 0.2 * bot.skill) * (0.88 + bot.rand() * 0.26));
      bot.score += scoreFor(st, moves, bot.dur).total;
      bot.t0 += bot.dur;
      bot.idx++;
      bot.dur = botDur(bot, bot.idx);
    }
    var f = Math.max(0, Math.min(1, (elapsed - bot.t0) / bot.dur));
    bot.prog = Math.min(98, Math.pow(f, 0.72) * 100);   // schneller Start, zäher Schluss
  }

  /* ================= Registrierung ================= */
  App.Minigames.slidingpuzzle = {
    id: 'slidingpuzzle', title: '15er-Puzzle', icon: '🔢', order: 157,
    subtitle: 'Schiebe 1–15 in Reihenfolge – gegen die Uhr',
    single: true, multi: true, minPlayers: 2, maxPlayers: 8,

    render: function (root, ctx) {
      var isMulti = ctx.mode === 'multi';
      var nowFn = isMulti ? ctx.room.now : function () { return Date.now(); };

      var dead = false;
      var stops = [];                 // stop()-Funktionen (App.MG, Listener, room.off)
      var pending = [];               // laufende setTimeout-IDs

      /* Laufender Zustand */
      var score = 0, solved = 0, puzzleIdx = 0, moves = 0, finished = false;
      var grid = null, stage = null, puzzleStartAt = 0, busy = false, lastReport = 0;
      var bots = [];

      /* DOM-Referenzen */
      var scoreEl, timerEl, puzEl, moveEl, gridEl, tiles = {}, rank = null, boardBox;

      function after(ms, fn) { var t = setTimeout(function () { if (!dead) fn(); }, ms); pending.push(t); return t; }
      function clearPending() { pending.forEach(clearTimeout); pending = []; }
      function stopHelpers() { stops.forEach(function (f) { try { f(); } catch (e) {} }); stops = []; }
      function cleanup() { dead = true; clearPending(); stopHelpers(); }

      /* ---- Start ---- */
      if (isMulti) {
        var snap = ctx.room.snapshot() || {};
        var startAt = (snap.round && snap.round.startAt) || (ctx.room.now() + 3000);
        /* Host verteilt den Seed — er ist zugleich aus startAt ableitbar, damit
           ein noch nicht angekommenes 'shared' niemanden aus dem Takt bringt. */
        if (ctx.room.isHost()) { try { ctx.room.setShared({ slpSeed: seedFromStart(startAt) }); } catch (e) {} }
        stops.push(App.MG.countdown(root, startAt, function () { play(startAt); }, ctx.room.now));
      } else {
        play(nowFn());
      }
      return { cleanup: cleanup };

      /* Seed der Runde: bevorzugt der vom Host geteilte Wert. */
      function seedOf(startAt) {
        if (isMulti) {
          var sh = (ctx.room.snapshot() || {}).shared || {};
          if (typeof sh.slpSeed === 'number') return sh.slpSeed >>> 0;
        }
        return seedFromStart(startAt);
      }

      /* ===================== SPIEL ===================== */
      function play(startAt) {
        clearPending(); stopHelpers();
        score = 0; solved = 0; puzzleIdx = 0; moves = 0; finished = false;
        busy = false; lastReport = 0; tiles = {};
        var seed = seedOf(startAt);
        var endAt = startAt + DURATION * 1000;
        bots = isMulti ? [] : makeBots(seed);

        /* --- Kopfzeile --- */
        scoreEl = el('div', { class: 'slp-v slp-v-gold' }, ['0']);
        puzEl = el('div', { class: 'slp-v' }, ['1']);
        moveEl = el('div', { class: 'slp-v slp-v-aqua' }, ['0']);
        timerEl = el('div', { class: 'mg-timer' }, [App.MG.mmss(DURATION)]);
        var head = el('div', { class: 'slp-head glass' }, [
          el('div', { class: 'slp-cell' }, [el('span', { class: 'slp-l' }, ['Punkte']), scoreEl]),
          el('div', { class: 'slp-cell' }, [el('span', { class: 'slp-l' }, ['Puzzle']), puzEl]),
          el('div', { class: 'slp-cell' }, [el('span', { class: 'slp-l' }, ['Züge']), moveEl]),
          el('div', { class: 'slp-cell slp-cell-t' }, [el('span', { class: 'slp-l' }, ['Zeit']), timerEl])
        ]);

        /* --- Brett --- */
        gridEl = el('div', { class: 'slp-grid' });
        boardBox = el('div', { class: 'slp-boardbox glass' }, [gridEl]);

        var rules = el('p', { class: 'hint-text slp-rules' }, [
          '🔢 Ordne die Zahlen aufsteigend, Lücke unten rechts · Kachel antippen (ganze Reihen rücken mit), '
          + 'auf dem Brett wischen oder Pfeiltasten · Wenige Züge und Tempo geben Extra-Punkte'
        ]);

        /* --- Rangliste (Multi: echte Spieler, Solo: Bots + du) --- */
        rank = makeRankList();
        var boardTitle = isMulti ? '🏆 Rangliste' : '🤖 Bots & du';
        var listWrap = el('div', { class: 'slp-listwrap glass' }, [
          el('div', { class: 'mg-field-title' }, [boardTitle]), rank.root
        ]);

        var best = isMulti ? 0 : (App.Storage.get('best_slidingpuzzle', 0) || 0);
        var bestLine = isMulti ? null : el('div', { class: 'slp-best' }, ['🥇 Dein Rekord: ' + App.MG.fmt(best)]);

        root.innerHTML = '';
        root.appendChild(el('div', { class: 'slp-wrap' }, [head, rules, boardBox, bestLine, listWrap]));

        bindInput();
        loadPuzzle(seed, 0);
        refreshRank();

        /* --- Rundentimer (Wall-Clock) --- */
        var tnf = isMulti ? ctx.room.now : null;
        stops.push(App.MG.roundTimer(endAt, function (left) {
          timerEl.textContent = App.MG.mmss(left);
          if (left <= 15) timerEl.classList.add('slp-urgent');
          if (!isMulti) {
            var elapsed = (nowFn() - startAt) / 1000;
            bots.forEach(function (b) { botTick(b, elapsed); });
            refreshRank();
          }
        }, finish, tnf));

        if (isMulti) {
          ctx.room.reportScore(0);
          reportProgress(true);
          var onPlayers = function () { if (!dead && !finished) refreshRank(); };
          ctx.room.on('players', onPlayers);
          stops.push(function () { ctx.room.off('players', onPlayers); });
        }

        /* ---------- Puzzle aufbauen ---------- */
        function loadPuzzle(sd, idx) {
          stage = stageOf(idx);
          grid = scramble(stage.n, stage.scramble, rng(hash32(sd, idx + 1)));
          moves = 0;
          puzzleStartAt = nowFn();
          busy = false;
          tiles = {};
          gridEl.innerHTML = '';
          gridEl.className = 'slp-grid slp-n' + stage.n;
          gridEl.style.setProperty('--slp-n', String(stage.n));
          for (var v = 1; v < stage.n * stage.n; v++) {
            var t = el('div', { class: 'slp-tile', dataset: { v: String(v) } }, [
              el('span', { class: 'slp-face' }, [String(v)])
            ]);
            tiles[v] = t;
            gridEl.appendChild(t);
          }
          puzEl.textContent = String(idx + 1);
          moveEl.textContent = '0';
          paint();
        }

        /* ---------- Kacheln positionieren + Zustand färben ---------- */
        function paint() {
          var n = stage.n;
          for (var i = 0; i < grid.length; i++) {
            var v = grid[i];
            if (!v) continue;
            var t = tiles[v];
            if (!t) continue;
            var r = Math.floor(i / n), c = i % n;
            t.style.transform = 'translate(' + (c * 100) + '%,' + (r * 100) + '%)';
            var ok = (v === i + 1);
            if (ok !== t.classList.contains('slp-ok')) t.classList.toggle('slp-ok', ok);
          }
        }

        /* ---------- Eingabe ---------- */
        function bindInput() {
          var downX = 0, downY = 0, downIdx = -1, downId = null;

          function tileIdxFromEvent(e) {
            var node = e.target;
            while (node && node !== gridEl && !(node.classList && node.classList.contains('slp-tile'))) node = node.parentNode;
            if (!node || node === gridEl || !node.dataset) return -1;
            var v = parseInt(node.dataset.v, 10);
            return grid ? grid.indexOf(v) : -1;
          }
          function onDown(e) {
            if (dead || finished || busy) return;
            downId = e.pointerId; downX = e.clientX; downY = e.clientY;
            downIdx = tileIdxFromEvent(e);
            if (e.preventDefault) e.preventDefault();
          }
          function onUp(e) {
            if (dead || finished || busy || downId === null || e.pointerId !== downId) return;
            downId = null;
            var dx = e.clientX - downX, dy = e.clientY - downY;
            var adx = Math.abs(dx), ady = Math.abs(dy);
            if (adx < TAP_SLOP && ady < TAP_SLOP) {
              if (downIdx >= 0) doMove(chainFor(grid, stage.n, downIdx));
              return;
            }
            var dir = adx > ady ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up');
            var idx = idxForDir(grid, stage.n, dir);
            if (idx >= 0) doMove([idx]); else nudge();
          }
          function onCancel() { downId = null; }
          gridEl.addEventListener('pointerdown', onDown);
          gridEl.addEventListener('pointerup', onUp);
          gridEl.addEventListener('pointercancel', onCancel);
          gridEl.addEventListener('pointerleave', onCancel);
          stops.push(function () {
            gridEl.removeEventListener('pointerdown', onDown);
            gridEl.removeEventListener('pointerup', onUp);
            gridEl.removeEventListener('pointercancel', onCancel);
            gridEl.removeEventListener('pointerleave', onCancel);
          });

          function onKey(e) {
            if (dead || finished || busy) return;
            var k = e.key, dir = null;
            if (k === 'ArrowRight' || k === 'd' || k === 'D') dir = 'right';
            else if (k === 'ArrowLeft' || k === 'a' || k === 'A') dir = 'left';
            else if (k === 'ArrowUp' || k === 'w' || k === 'W') dir = 'up';
            else if (k === 'ArrowDown' || k === 's' || k === 'S') dir = 'down';
            if (!dir) return;
            e.preventDefault();
            var idx = idxForDir(grid, stage.n, dir);
            if (idx >= 0) doMove([idx]); else nudge();
          }
          document.addEventListener('keydown', onKey);
          stops.push(function () { document.removeEventListener('keydown', onKey); });
        }

        function nudge() {
          if (!gridEl) return;
          gridEl.classList.remove('slp-nudge'); void gridEl.offsetWidth; gridEl.classList.add('slp-nudge');
          if (App.Audio) App.Audio.blip(150, 0.05);
        }

        /* ---------- Zug ausführen ---------- */
        function doMove(chain) {
          if (!chain || !chain.length || busy || finished || dead) { if (!chain || !chain.length) nudge(); return; }
          var blank = grid.indexOf(0);
          chain.forEach(function (i) { grid[blank] = grid[i]; grid[i] = 0; blank = i; });
          moves += chain.length;
          moveEl.textContent = String(moves);
          paint();
          if (App.Audio) App.Audio.blip(300 + Math.min(6, chain.length) * 40, 0.05);
          if (isSolved(grid)) return onSolved();
          reportProgress(false);
        }

        /* ---------- Puzzle gelöst ---------- */
        function onSolved() {
          busy = true;
          solved++;
          var sec = Math.max(0, (nowFn() - puzzleStartAt) / 1000);
          var pts = scoreFor(stage, moves, sec);
          score += pts.total;
          scoreEl.textContent = App.MG.fmt(score);
          scoreEl.classList.remove('slp-bump'); void scoreEl.offsetWidth; scoreEl.classList.add('slp-bump');
          boardBox.classList.add('slp-win');
          gridEl.classList.add('slp-done');
          if (App.Audio) App.Audio.sfx(stage.n === 5 ? 'jackpot' : 'levelup');
          popup(pts, sec);
          if (isMulti) { ctx.room.reportScore(score); reportProgress(true); }
          refreshRank();
          after(1150, function () {
            if (finished || dead) return;
            boardBox.classList.remove('slp-win');
            puzzleIdx++;
            loadPuzzle(seed, puzzleIdx);
            reportProgress(true);
            refreshRank();
            if (App.Audio) App.Audio.sfx('whoosh');
          });
        }

        /* Kurze Punkte-Aufschlüsselung über dem Brett. */
        function popup(pts, sec) {
          var box = el('div', { class: 'slp-pop' }, [
            el('div', { class: 'slp-pop-big' }, ['+' + App.MG.fmt(pts.total)]),
            el('div', { class: 'slp-pop-sub' }, [
              'Basis ' + pts.base + ' · Züge +' + pts.zug + ' (' + moves + '/' + parOf(stage) + ') · Tempo +' + pts.tempo + ' (' + sec.toFixed(1) + 's)'
            ])
          ]);
          boardBox.appendChild(box);
          after(1400, function () { if (box.parentNode) box.parentNode.removeChild(box); });
        }

        /* ---------- Fortschritt melden (gedrosselt) ---------- */
        function reportProgress(force) {
          if (!isMulti || dead) return;
          var t = Date.now();
          if (!force && t - lastReport < 1200) return;
          lastReport = t;
          try { ctx.room.reportState({ p: puzzleIdx + 1, prog: progressOf(grid, stage.n) }); } catch (e) {}
        }

        /* ---------- Rangliste füttern ---------- */
        function refreshRank() {
          if (!rank || dead) return;
          var rows;
          if (isMulti) {
            rows = ctx.room.players().map(function (p) {
              var st = p.state || {};
              return {
                id: p.id, name: p.name, score: p.score || 0, me: p.id === ctx.me.id,
                puzzle: st.p || 1, prog: typeof st.prog === 'number' ? st.prog : 0
              };
            });
          } else {
            rows = [{
              id: 'me', name: ctx.me && ctx.me.name ? ctx.me.name : 'Du', score: score, me: true,
              puzzle: puzzleIdx + 1, prog: grid ? progressOf(grid, stage.n) : 0
            }];
            bots.forEach(function (b) {
              rows.push({ id: b.id, name: b.name, score: Math.round(b.score), me: false, puzzle: b.idx + 1, prog: b.prog });
            });
          }
          rank.update(rows);
        }
      }

      /* ===================== ENDE ===================== */
      function finish() {
        if (finished || dead) return;
        finished = true;
        busy = true;
        clearPending();
        stopHelpers();
        if (App.Audio) App.Audio.sfx('start');

        if (isMulti) {
          ctx.room.reportScore(score);
          after(900, function () {
            App.MG.endScreen(root, { players: ctx.room.players(), meId: ctx.me.id, onExit: ctx.onExit });
          });
        } else {
          var best = App.Storage.get('best_slidingpuzzle', 0) || 0;
          var nb = score > best;
          if (nb) App.Storage.set('best_slidingpuzzle', score);
          var beaten = bots.filter(function (b) { return b.score < score; }).length;
          App.MG.endScreen(root, {
            score: score, best: best, newBest: nb,
            label: solved + ' Puzzle gelöst · ' + beaten + '/' + bots.length + ' Bots geschlagen'
              + (nb ? ' · neuer Rekord! 🎉' : ' · Bestwert: ' + App.MG.fmt(best)),
            onExit: ctx.onExit,
            onAgain: function () { if (dead) return; finished = false; play(nowFn()); }
          });
        }
      }
    }
  };

  /* ===================== STYLES ===================== */
  function injectStyle() {
    UI.injectStyle('mg-slidingpuzzle-css', [
      '.slp-wrap{display:flex;flex-direction:column;gap:10px;}',
      /* Kopfzeile */
      '.slp-head{display:flex;justify-content:space-between;align-items:center;padding:10px 16px;gap:10px;flex-wrap:wrap;}',
      '.slp-cell{display:flex;flex-direction:column;gap:1px;min-width:0;}',
      '.slp-cell-t{text-align:right;margin-left:auto;}',
      '.slp-l{color:var(--muted);font-size:10px;text-transform:uppercase;letter-spacing:1px;}',
      '.slp-v{font-size:clamp(18px,4.6vw,28px);font-weight:900;line-height:1.05;color:var(--leaf);font-variant-numeric:tabular-nums;}',
      '.slp-v-gold{color:var(--gold);text-shadow:0 0 12px rgba(255,210,63,.45);}',
      '.slp-v-aqua{color:var(--aqua);}',
      '.slp-head .mg-timer{font-size:clamp(17px,4.4vw,24px);}',
      '.mg-timer.slp-urgent{color:var(--danger-2);animation:slp-pulse .7s infinite;}',
      '.slp-bump{animation:slp-bump .34s ease;}',
      '.slp-rules{margin:0;text-align:center;font-size:12px;}',
      '.slp-best{text-align:center;font-size:12px;font-weight:800;color:var(--gold);opacity:.9;}',
      /* Brett */
      '.slp-boardbox{position:relative;padding:10px;margin:0 auto;width:100%;max-width:min(380px,86vw);',
      'border-radius:20px;transition:box-shadow .25s,border-color .25s;}',
      '.slp-boardbox.slp-win{box-shadow:0 0 34px rgba(57,255,20,.55),inset 0 0 40px rgba(57,255,20,.14);border-color:var(--stroke-2);}',
      '.slp-grid{--slp-n:4;position:relative;width:100%;aspect-ratio:1/1;border-radius:14px;',
      'background:radial-gradient(circle at 50% 35%,rgba(5,26,16,.95),rgba(3,14,9,.98));',
      'border:1px solid var(--stroke);overflow:hidden;touch-action:none;user-select:none;-webkit-user-select:none;',
      '-webkit-tap-highlight-color:transparent;cursor:pointer;}',
      '.slp-grid.slp-done{animation:slp-done .55s ease;}',
      '.slp-grid.slp-nudge{animation:slp-shake .26s ease;}',
      '.slp-tile{position:absolute;top:0;left:0;width:calc(100% / var(--slp-n));height:calc(100% / var(--slp-n));',
      'transition:transform .12s cubic-bezier(.25,.9,.3,1);will-change:transform;}',
      '.slp-face{position:absolute;inset:4px;border-radius:10px;display:flex;align-items:center;justify-content:center;',
      'font-weight:900;font-variant-numeric:tabular-nums;color:var(--leaf);',
      'background:linear-gradient(180deg,rgba(16,58,36,.98),rgba(7,28,17,.98));',
      'border:1px solid var(--stroke);box-shadow:inset 0 1px 0 rgba(157,255,122,.18),0 3px 8px rgba(0,0,0,.45);',
      'transition:color .18s,border-color .18s,box-shadow .18s,background .18s;}',
      '.slp-n4 .slp-face{font-size:clamp(20px,7.6vw,34px);}',
      '.slp-n5 .slp-face{font-size:clamp(15px,5.8vw,26px);}',
      '.slp-tile.slp-ok .slp-face{color:#04160c;background:linear-gradient(180deg,var(--neon-soft),var(--neon));',
      'border-color:#eaffe2;box-shadow:0 0 14px rgba(57,255,20,.45),inset 0 1px 0 rgba(255,255,255,.35);}',
      '.slp-tile:active .slp-face{filter:brightness(1.18);}',
      /* Punkte-Popup */
      '.slp-pop{position:absolute;left:50%;top:38%;transform:translate(-50%,-50%);z-index:3;text-align:center;',
      'padding:12px 18px;border-radius:16px;background:rgba(4,16,10,.9);border:1px solid var(--stroke-2);',
      'box-shadow:0 0 28px rgba(57,255,20,.45);pointer-events:none;animation:slp-pop 1.4s ease forwards;max-width:94%;}',
      '.slp-pop-big{font-size:clamp(26px,7vw,40px);font-weight:900;color:var(--gold);text-shadow:0 0 16px rgba(255,210,63,.6);line-height:1;}',
      '.slp-pop-sub{margin-top:4px;font-size:11px;font-weight:700;color:var(--leaf);}',
      /* Rangliste */
      '.slp-listwrap{padding:12px 14px;display:flex;flex-direction:column;gap:8px;}',
      '.slp-list{display:flex;flex-direction:column;gap:6px;max-height:230px;overflow-y:auto;}',
      '.slp-row{display:flex;align-items:center;gap:9px;padding:6px 10px;border-radius:11px;',
      'background:rgba(9,32,21,.6);border:1px solid var(--stroke);}',
      '.slp-row.me{border-color:var(--stroke-2);box-shadow:0 0 12px rgba(57,255,20,.22);}',
      '.slp-row.p1 .slp-rank{color:var(--gold);}',
      '.slp-row.p2 .slp-rank{color:var(--silver);}',
      '.slp-row.p3 .slp-rank{color:var(--bronze);}',
      '.slp-rank{font-weight:900;font-size:14px;width:16px;text-align:center;color:var(--muted);flex:0 0 auto;}',
      '.slp-rowmain{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:4px;}',
      '.slp-rowtop{display:flex;align-items:baseline;justify-content:space-between;gap:8px;}',
      '.slp-name{font-weight:700;font-size:13px;color:#eaffe2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      '.slp-score{font-weight:900;font-size:13px;color:var(--gold);font-variant-numeric:tabular-nums;flex:0 0 auto;}',
      '.slp-bar{height:5px;border-radius:4px;background:rgba(4,16,10,.85);border:1px solid var(--stroke);overflow:hidden;}',
      '.slp-fill{display:block;height:100%;width:2%;border-radius:4px;',
      'background:linear-gradient(90deg,var(--aqua),var(--neon));transition:width .3s ease;}',
      '.slp-sub{flex:0 0 auto;font-size:10px;font-weight:700;color:var(--muted);white-space:nowrap;}',
      /* Animationen */
      '@keyframes slp-pulse{0%,100%{opacity:1}50%{opacity:.4}}',
      '@keyframes slp-bump{0%{transform:scale(1)}40%{transform:scale(1.22)}100%{transform:scale(1)}}',
      '@keyframes slp-shake{0%,100%{transform:translateX(0)}25%{transform:translateX(-5px)}75%{transform:translateX(5px)}}',
      '@keyframes slp-done{0%{filter:brightness(1)}35%{filter:brightness(1.75)}100%{filter:brightness(1)}}',
      '@keyframes slp-pop{0%{opacity:0;transform:translate(-50%,-30%) scale(.8)}18%{opacity:1;transform:translate(-50%,-50%) scale(1)}',
      '78%{opacity:1;transform:translate(-50%,-50%) scale(1)}100%{opacity:0;transform:translate(-50%,-72%) scale(.96)}}'
    ].join(''));
  }
})();
