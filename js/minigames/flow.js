/* flow.js — "Röhren-Verbinder": Flow-Free-Rennen im Neon-Dschungel.
 *
 * SPIELIDEE : Ein Gitter mit Paaren farbiger Punkte. Für jede Farbe zieht man
 *             eine Röhre von Punkt zu Punkt. Röhren dürfen sich NICHT kreuzen.
 *             Gelöst ist ein Rätsel erst, wenn ALLE Paare verbunden sind UND
 *             jedes Feld des Gitters gefüllt ist (Flow-Regel). Danach kommt
 *             sofort ein größeres/schwereres Rätsel — 3 Minuten am Stück.
 *
 * STEUERUNG : Mit Finger oder Maus von einem Punkt losziehen (pointerdown →
 *             pointermove → pointerup). Auf eine eigene Röhre tippen und weiter-
 *             ziehen kürzt sie ab dieser Stelle. Zieht man über eine fremde
 *             Röhre, wird die dort abgeschnitten (fremde Punkte blockieren).
 *             Zurückziehen = Röhre wieder einrollen. Knopf ↺ / Taste R = leeren.
 *
 * PUNKTE    : Pro gelöstem Rätsel  Grundwert (150 + 50 je Stufe)
 *             + Tempo-Bonus (max. 260, −8 je Sekunde).
 *
 * GENERATOR : Komplett in dieser Datei und rein zufalls-SEED-gesteuert:
 *             Jede Zelle startet als eigener Ein-Zell-Pfad; danach werden immer
 *             die KÜRZESTEN Pfade an ihren Enden mit einem benachbarten Pfad-Ende
 *             verschmolzen, bis nur noch k Pfade übrig sind. Ergebnis: eine volle
 *             Zerlegung des Gitters in k einfache Pfade = eine fertige Lösung.
 *             Die Endpunkte dieser Pfade sind die Punkte des Rätsels → garantiert
 *             lösbar und garantiert komplett füllbar. Klemmt das Verschmelzen,
 *             wird neu gewürfelt; als letzte Rettung eine Schlangen-Zerlegung.
 *
 * SOLO      : 3 Minuten Punktejagd gegen den eigenen Rekord (best_flow) UND gegen
 *             1–3 Bots (Efeu/Liane/Ranke) in drei Stufen. Die Bots rechnen ihre
 *             Lösezeit aus Gittergröße + Farbzahl (mit persönlichem Können und
 *             Streuung) und laufen über Wall-Clock mit — also auch nach Tab-Wechsel
 *             plausibel. Sie punkten nach exakt derselben Formel wie der Spieler.
 *
 * MULTI     : Der Host würfelt im Countdown EINEN Seed aus und verteilt ihn per
 *             room.setShared({flwSeed}). Jeder erzeugt daraus lokal dieselbe
 *             Rätsel-Folge (Seed + Stufennummer → deterministischer xorshift32),
 *             alle spielen also exakt dasselbe. Fortschritt geht per
 *             room.reportScore()/room.reportState({lvl,pct}) raus → Live-Rangliste
 *             mit Fortschrittsbalken. Alle Timer laufen über room.now() (Server-
 *             Zeit) → synchron und Tab-Wechsel-sicher. Kommt kein Seed an, greift
 *             ein aus round.startAt abgeleiteter Not-Seed (kennen alle gleich).
 *
 * cleanup() setzt dead=true und beendet rAF, Timer, Listener und alle room.on(). */
(function () {
  'use strict';
  window.App = window.App || {}; App.Minigames = App.Minigames || {};
  var UI = App.UI, el = UI.el;

  injectStyle();

  var DURATION = 180;          // s Rundenzeit (3 Minuten)
  var MIN_LEN = 3;             // angestrebte Mindestlänge einer Röhre
  var SOLVE_PAUSE = 1000;      // ms Jubel zwischen zwei Rätseln

  /* Neon-Dschungel-Farben der Röhren (max. 10 Farben pro Rätsel) */
  var PALETTE = [
    '#39ff14', '#33e6d0', '#ffd23f', '#ff4d6d', '#b06cff',
    '#ff9f1c', '#3fa9ff', '#c1ff72', '#ff5cf0', '#e8fff2'
  ];

  /* Stufen: Gittergröße n und Farbzahl k — wird von Rätsel zu Rätsel härter */
  var LEVELS = [
    { n: 5, k: 4 }, { n: 5, k: 5 }, { n: 6, k: 4 }, { n: 6, k: 5 },
    { n: 6, k: 6 }, { n: 7, k: 5 }, { n: 7, k: 6 }, { n: 7, k: 7 },
    { n: 8, k: 6 }, { n: 8, k: 7 }, { n: 8, k: 8 }, { n: 9, k: 7 },
    { n: 9, k: 8 }, { n: 9, k: 9 }, { n: 10, k: 8 }, { n: 10, k: 9 }
  ];
  function levelAt(i) { return LEVELS[Math.min(i, LEVELS.length - 1)]; }

  /* Solo-Stufen: wie stark die Bots sind (kleiner = schneller) */
  var DIFFS = [
    { key: 'leicht', name: 'Leicht', icon: '🌱', factor: 1.55, bots: 2, info: 'Zwei gemütliche Ranken' },
    { key: 'mittel', name: 'Mittel', icon: '🌿', factor: 1.15, bots: 3, info: 'Drei ordentliche Kletterer' },
    { key: 'schwer', name: 'Schwer', icon: '🔥', factor: 0.86, bots: 3, info: 'Drei flinke Dschungel-Profis' }
  ];
  var BOT_NAMES = ['Efeu 🌿', 'Liane 🍃', 'Ranke 🌱'];
  var BOT_SKILL = [1.0, 0.9, 1.18];   // persönliches Können je Bot

  /* ===================================================================
   *  ZUFALL — deterministisch (xorshift32), damit alle dasselbe bekommen
   * =================================================================== */
  function rngFrom(seed) {
    var s = (seed >>> 0) || 0x9e3779b9;
    return function () {
      s ^= (s << 13); s >>>= 0;
      s ^= (s >>> 17);
      s ^= (s << 5); s >>>= 0;
      return s / 4294967296;
    };
  }
  /* Aus Basis-Seed + Stufennummer einen eigenen Seed ableiten. */
  function seedFor(base, li) {
    var r = rngFrom(base), i;
    for (i = 0; i <= li + 2; i++) r();
    return Math.floor(r() * 4294967296) >>> 0;
  }
  function freshSeed() { return (Math.floor(Math.random() * 4294967295) + 1) >>> 0; }

  /* ===================================================================
   *  GENERATOR (rein, ohne DOM) — liefert { n, colors:[{a,b,len}] }
   * =================================================================== */
  function tryGen(n, k, rng) {
    var total = n * n, i;
    var paths = [], pid = [];
    for (i = 0; i < total; i++) { paths.push([i]); pid.push(i); }

    function reindex() {
      var j, q, c;
      for (j = 0; j < paths.length; j++) {
        c = paths[j];
        for (q = 0; q < c.length; q++) pid[c[q]] = j;
      }
    }
    function nbs(cell) {
      var r = [], x = cell % n, y = (cell - x) / n;
      if (x > 0) r.push(cell - 1);
      if (x < n - 1) r.push(cell + 1);
      if (y > 0) r.push(cell - n);
      if (y < n - 1) r.push(cell + n);
      return r;
    }
    function shuffle(a) {
      var q, w, t;
      for (q = a.length - 1; q > 0; q--) {
        w = Math.floor(rng() * (q + 1)); t = a[q]; a[q] = a[w]; a[w] = t;
      }
      return a;
    }

    /* Verschmilzt Pfad j an einem seiner Enden mit einem benachbarten Pfad-Ende. */
    function tryMerge(j) {
      var p = paths[j], cands = [], ei, e, list, q, o, oc, c, A, B;
      for (ei = 0; ei < 2; ei++) {
        if (ei === 1 && p.length === 1) break;          // Ein-Zell-Pfad: nur ein Ende
        e = (ei === 0) ? p[0] : p[p.length - 1];
        list = nbs(e);
        for (q = 0; q < list.length; q++) {
          o = pid[list[q]];
          if (o === j) continue;
          oc = paths[o];
          if (oc[0] === list[q]) cands.push({ o: o, myEnd: ei, oEnd: 0 });
          if (oc.length > 1 && oc[oc.length - 1] === list[q]) cands.push({ o: o, myEnd: ei, oEnd: 1 });
        }
      }
      if (!cands.length) return false;
      c = cands[Math.floor(rng() * cands.length)];
      A = paths[j].slice(); if (c.myEnd === 0) A.reverse();   // Nahtstelle ans Ende von A
      B = paths[c.o].slice(); if (c.oEnd === 1) B.reverse();  // Nahtstelle an den Anfang von B
      paths[j] = A.concat(B);
      paths.splice(c.o, 1);
      reindex();
      return true;
    }

    /* 1) auf k Pfade eindampfen — immer die kürzesten zuerst (bleibt ausgewogen) */
    var guard = 0;
    while (paths.length > k && guard++ < total * 30) {
      var order = [];
      for (i = 0; i < paths.length; i++) order.push(i);
      order.sort(function (a, b) { return (paths[a].length - paths[b].length) || (a - b); });
      var minL = paths[order[0]].length;
      var pool = order.filter(function (x) { return paths[x].length <= minL + 1; });
      var rest = order.filter(function (x) { return paths[x].length > minL + 1; });
      var all = shuffle(pool).concat(shuffle(rest));
      var ok = false;
      for (i = 0; i < all.length; i++) { if (tryMerge(all[i])) { ok = true; break; } }
      if (!ok) return null;                                  // steckengeblieben
    }

    /* 2) zu kurze Röhren (1–2 Zellen) noch wegverschmelzen */
    guard = 0;
    while (guard++ < total * 10) {
      var mi = -1, mv = Infinity;
      for (i = 0; i < paths.length; i++) if (paths[i].length < mv) { mv = paths[i].length; mi = i; }
      if (mv >= MIN_LEN || paths.length <= 2) break;
      if (!tryMerge(mi)) return null;
    }

    /* 3) prüfen: nichts darf eine einzelne Zelle sein (sonst 2 Punkte auf 1 Feld) */
    if (paths.length < 2 || paths.length > PALETTE.length) return null;
    for (i = 0; i < paths.length; i++) if (paths[i].length < 2) return null;

    var colors = [];
    for (i = 0; i < paths.length; i++) {
      colors.push({ a: paths[i][0], b: paths[i][paths[i].length - 1], len: paths[i].length });
    }
    shuffle(colors);                                          // Farbzuordnung mischen
    return { n: n, colors: colors };
  }

  /* Notlösung: Schlangenlinie durchs ganze Gitter, in k Stücke geschnitten. */
  function snakeFallback(n, k) {
    var order = [], y, x, cx, i;
    for (y = 0; y < n; y++) {
      for (x = 0; x < n; x++) {
        cx = (y % 2 === 0) ? x : (n - 1 - x);
        order.push(y * n + cx);
      }
    }
    var total = n * n;
    var cnt = Math.max(2, Math.min(k, Math.floor(total / 2), PALETTE.length));
    var colors = [], pos = 0, left = cnt, remaining, take;
    for (i = 0; i < cnt; i++) {
      remaining = total - pos;
      take = (left === 1) ? remaining : Math.max(2, Math.round(remaining / left));
      if (remaining - take < 2 * (left - 1)) take = remaining - 2 * (left - 1);
      colors.push({ a: order[pos], b: order[pos + take - 1], len: take });
      pos += take; left--;
    }
    return { n: n, colors: colors };
  }

  function genPuzzle(n, k, rng) {
    var res = null, attempt;
    for (attempt = 0; attempt < 30 && !res; attempt++) res = tryGen(n, k, rng);
    return res || snakeFallback(n, k);
  }
  /* Rätsel für Stufe li aus dem Basis-Seed — überall identisch. */
  function makeLevel(base, li) {
    var lv = levelAt(li);
    return genPuzzle(lv.n, lv.k, rngFrom(seedFor(base, li)));
  }

  /* ===================================================================
   *  PUNKTE
   * =================================================================== */
  function baseFor(li) { return 150 + li * 50; }
  function bonusFor(secs) { return Math.max(0, Math.round(260 - secs * 8)); }

  /* Farbe + Alpha → rgba() */
  function rgba(hex, a) {
    var r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
    return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
  }

  /* ===================================================================
   *  SPIEL
   * =================================================================== */
  App.Minigames.flow = {
    id: 'flow', title: 'Röhren-Verbinder', icon: '🔵', order: 156,
    subtitle: 'Verbinde die Punkte, füll das ganze Gitter',
    single: true, multi: true, minPlayers: 2, maxPlayers: 8,

    render: function (root, ctx) {
      var isMulti = ctx.mode === 'multi';
      var nowFn = isMulti ? ctx.room.now : function () { return Date.now(); };

      var dead = false;
      var stops = [];        // stop()-Funktionen (Countdown, Timer, Listener)
      var pending = [];      // laufende setTimeout-IDs
      var handlers = [];     // {evt, fn} für room.off()
      var raf = 0;

      /* Laufender Zustand */
      var seed = 0, levelIdx = 0, score = 0, solvedCount = 0, finished = false;
      var g = null, drag = null, locked = true, puzzleStartAt = 0, endAt = 0;
      var bots = [], diff = DIFFS[1];
      var lastRep = 0, lastPct = -1, lastLvl = -1;

      /* DOM */
      var canvas = null, c2d = null, cssW = 0, curDpr = 0;
      var lvlEl, scoreEl, timerEl, colChip, cellChip, boardEl, flashLayer;

      function after(ms, fn) { var t = setTimeout(function () { if (!dead) fn(); }, ms); pending.push(t); return t; }
      function clearPending() { pending.forEach(clearTimeout); pending = []; }
      function stopHelpers() { stops.forEach(function (f) { try { f(); } catch (e) {} }); stops = []; }
      function onRoom(evt, fn) { ctx.room.on(evt, fn); handlers.push({ evt: evt, fn: fn }); }
      function offAll() {
        handlers.forEach(function (h) { try { ctx.room.off(h.evt, h.fn); } catch (e) {} });
        handlers = [];
      }
      function stopRaf() { if (raf) { cancelAnimationFrame(raf); raf = 0; } }
      function cleanup() { dead = true; stopRaf(); clearPending(); stopHelpers(); if (isMulti) offAll(); }
      function sfx(n) { if (App.Audio) App.Audio.sfx(n); }
      function blip(f, d) { if (App.Audio && App.Audio.blip) App.Audio.blip(f, d); }
      function amHost() { return !!ctx.isHost || (isMulti && ctx.room.isHost()); }
      function sharedNow() { var s = isMulti && ctx.room.snapshot(); return (s && s.shared) || null; }

      /* ---------------- Einstieg ---------------- */
      if (isMulti) {
        var snap = ctx.room.snapshot() || {};
        var startAt = (snap.round && snap.round.startAt) || (ctx.room.now() + 3000);
        stops.push(App.MG.countdown(root, startAt, function () { startMulti(startAt); }, ctx.room.now));
        if (amHost()) after(60, hostMakeSeed);      // Host würfelt schon im Countdown
      } else {
        showMenu();
      }
      return { cleanup: cleanup };

      /* ================= MEHRSPIELER ================= */
      function hostMakeSeed() {
        if (dead) return;
        var sh = sharedNow();
        if (sh && sh.flwSeed) return;               // schon verteilt
        ctx.room.setShared({ flwSeed: freshSeed() });
      }

      function startMulti(startAt) {
        if (dead) return;
        var loaded = false;
        endAt = startAt + DURATION * 1000;

        root.innerHTML = '';
        root.appendChild(el('div', { class: 'flw-menu glass' }, [
          el('div', { class: 'flw-menu-ic flw-spin' }, ['🔵']),
          el('h2', { class: 'neon' }, ['Rätsel werden verteilt …']),
          el('p', { class: 'hint-text' }, ['Alle bekommen exakt dieselbe Röhren-Folge.'])
        ]));

        function tryLoad(useSeed) {
          if (dead || loaded) return;               // idempotent: 'shared' feuert oft
          var sh = sharedNow();
          var s = (sh && sh.flwSeed) || useSeed || 0;
          if (!s) return;
          loaded = true;
          seed = s >>> 0;
          play(startAt);
        }
        onRoom('shared', function () { tryLoad(0); });
        tryLoad(0);

        /* Notnagel: Host ist weg, bevor er verteilt hat. */
        after(6000, function () { if (!loaded && amHost()) hostMakeSeed(); });
        after(10000, function () { tryLoad((startAt % 4294967291) + 7); });   // kennen alle gleich
      }

      /* ================= SOLO-MENÜ ================= */
      function showMenu() {
        clearPending(); stopHelpers(); stopRaf();
        finished = false; g = null; drag = null;

        var best = App.Storage.get('best_flow', 0);
        var cards = DIFFS.map(function (d) {
          return el('button', {
            class: 'flw-card glass', type: 'button',
            onclick: function () { sfx('select'); diff = d; play(Date.now()); }
          }, [
            el('div', { class: 'flw-card-ic' }, [d.icon]),
            el('div', { class: 'flw-card-nm neon' }, [d.name]),
            el('div', { class: 'flw-card-in' }, [d.info])
          ]);
        });

        root.innerHTML = '';
        root.appendChild(el('div', { class: 'flw-menu glass' }, [
          el('div', { class: 'flw-menu-ic' }, ['🔵']),
          el('h2', { class: 'neon' }, ['Röhren-Verbinder']),
          el('p', { class: 'hint-text' }, [
            'Verbinde jedes Punkte-Paar mit einer Röhre. Röhren dürfen sich nicht kreuzen — und am Ende muss JEDES Feld gefüllt sein.'
          ]),
          el('p', { class: 'hint-text' }, ['3 Minuten · jedes gelöste Rätsel wird größer · Tempo gibt Bonus.']),
          el('div', { class: 'flw-bestrow' }, [
            el('span', { class: 'chip' }, ['🏆 Bestwert: ' + App.MG.fmt(best)])
          ]),
          el('div', { class: 'mg-field-title' }, ['Gegner wählen']),
          el('div', { class: 'flw-cards' }, cards),
          el('div', { class: 'controls-row' }, [
            el('button', { class: 'btn btn-ghost', type: 'button', onclick: ctx.onExit }, ['Zurück'])
          ])
        ]));
      }

      /* ================= RUNDE ================= */
      function play(startAt) {
        clearPending(); stopHelpers(); stopRaf();
        levelIdx = 0; score = 0; solvedCount = 0; finished = false;
        drag = null; locked = true; lastRep = 0; lastPct = -1; lastLvl = -1;
        endAt = startAt + DURATION * 1000;
        if (!isMulti) seed = freshSeed();

        /* --- Kopfzeile --- */
        lvlEl = el('div', { class: 'flw-hv flw-lvl' }, ['1']);
        scoreEl = el('div', { class: 'flw-hv flw-score' }, ['0']);
        timerEl = el('div', { class: 'mg-timer' }, [App.MG.mmss(DURATION)]);
        var head = el('div', { class: 'flw-head glass' }, [
          el('div', { class: 'flw-hcell' }, [el('span', { class: 'flw-hl' }, ['Rätsel']), lvlEl]),
          el('div', { class: 'flw-hcell flw-mid' }, [el('span', { class: 'flw-hl' }, ['Punkte']), scoreEl]),
          el('div', { class: 'flw-hcell flw-right' }, [el('span', { class: 'flw-hl' }, ['Zeit']), timerEl])
        ]);

        /* --- Fortschritts-Chips + Regelzeile --- */
        colChip = el('span', { class: 'chip flw-c1' }, ['🎨 0/0']);
        cellChip = el('span', { class: 'chip flw-c2' }, ['▦ 0/0']);
        var chips = el('div', { class: 'flw-chips' }, [colChip, cellChip]);
        var rule = el('p', { class: 'hint-text flw-rule' }, [
          'Ziehe von Punkt zu Punkt · Röhren dürfen sich nicht kreuzen · alle Felder müssen voll sein'
        ]);

        /* --- Spielfeld --- */
        canvas = el('canvas', { class: 'flw-canvas' });
        c2d = canvas.getContext('2d');
        cssW = 0; curDpr = 0;
        flashLayer = el('div', { class: 'flw-flashlayer' });
        var boardWrap = el('div', { class: 'flw-boardwrap' }, [canvas, flashLayer]);

        /* --- Knöpfe --- */
        var controls = el('div', { class: 'controls-row flw-controls' }, [
          el('button', {
            class: 'btn btn-ghost', type: 'button',
            onclick: function () { resetAll(); }
          }, ['↺ Leeren'])
        ]);

        /* --- Rangliste --- */
        boardEl = el('div', { class: 'flw-board' });
        var boardPanel = el('div', { class: 'flw-boardpanel glass' }, [
          el('div', { class: 'mg-field-title' }, ['🏆 Rangliste']), boardEl
        ]);

        root.innerHTML = '';
        root.appendChild(el('div', { class: 'flw-layout' }, [head, chips, boardWrap, rule, controls, boardPanel]));

        /* --- Eingabe (Maus + Touch über Pointer-Events) --- */
        canvas.addEventListener('pointerdown', onDown);
        canvas.addEventListener('pointermove', onMove);
        canvas.addEventListener('pointerup', onUp);
        canvas.addEventListener('pointercancel', onUp);
        stops.push(function () {
          if (!canvas) return;
          canvas.removeEventListener('pointerdown', onDown);
          canvas.removeEventListener('pointermove', onMove);
          canvas.removeEventListener('pointerup', onUp);
          canvas.removeEventListener('pointercancel', onUp);
        });
        function keyHandler(e) {
          if (e.key === 'r' || e.key === 'R') { e.preventDefault(); resetAll(); }
        }
        document.addEventListener('keydown', keyHandler);
        stops.push(function () { document.removeEventListener('keydown', keyHandler); });

        /* --- Bots (nur Solo) --- */
        bots = [];
        if (!isMulti) {
          var cnt = Math.min(diff.bots, BOT_NAMES.length), i;
          for (i = 0; i < cnt; i++) {
            var b = { name: BOT_NAMES[i], skill: BOT_SKILL[i], lvl: 0, score: 0, pct: 0, startAt: startAt, nextAt: 0 };
            b.nextAt = b.startAt + botDur(b, 0);
            bots.push(b);
          }
        }

        /* --- Live-Rangliste --- */
        if (isMulti) onRoom('players', renderBoard);
        var tick = setInterval(function () {
          if (dead) return;
          if (!isMulti) botTick(Date.now());
          renderBoard();
          report(false);
        }, 300);
        stops.push(function () { clearInterval(tick); });

        /* --- Rundentimer (Wall-Clock → Tab-sicher) --- */
        stops.push(App.MG.roundTimer(endAt, function (left) {
          timerEl.textContent = App.MG.mmss(left);
          if (left <= 15) timerEl.classList.add('flw-urgent');
        }, finish, isMulti ? ctx.room.now : null));

        if (isMulti) { ctx.room.reportScore(0); ctx.room.reportState({ lvl: 1, pct: 0 }); }

        loadLevel();
        renderBoard();
        raf = requestAnimationFrame(draw);
      }

      /* --------- Rätsel laden --------- */
      function loadLevel() {
        if (dead || finished) return;
        var puz = makeLevel(seed, levelIdx);
        g = newGame(puz);
        drag = null; locked = false;
        puzzleStartAt = nowFn();
        lvlEl.textContent = String(levelIdx + 1);
        updateChips();
        report(true);
        blip(520, 0.05);
      }

      function newGame(puz) {
        var n = puz.n, total = n * n, i;
        var st = { n: n, total: total, colors: puz.colors, owner: [], ep: [], paths: [], pulse: [], born: Date.now() };
        for (i = 0; i < total; i++) { st.owner.push(-1); st.ep.push(-1); }
        puz.colors.forEach(function (c, ci) {
          st.ep[c.a] = ci; st.ep[c.b] = ci;
          st.owner[c.a] = ci; st.owner[c.b] = ci;
          st.paths.push([]); st.pulse.push(0);
        });
        return st;
      }

      /* --------- Pfad-Werkzeuge --------- */
      function clearPath(c) {
        var p = g.paths[c], i, cell;
        for (i = 0; i < p.length; i++) { cell = p[i]; if (g.ep[cell] !== c) g.owner[cell] = -1; }
        g.paths[c] = [];
      }
      function truncate(c, keep) {
        var p = g.paths[c], i, cell;
        for (i = keep; i < p.length; i++) { cell = p[i]; if (g.ep[cell] !== c) g.owner[cell] = -1; }
        p.length = Math.max(0, keep);
      }
      function otherEndOf(c) {
        var col = g.colors[c], p = g.paths[c];
        if (!p.length) return -1;
        return (p[0] === col.a) ? col.b : col.a;
      }
      function isConnected(c) {
        var p = g.paths[c], col = g.colors[c];
        if (p.length < 2) return false;
        var s = p[0], e = p[p.length - 1];
        return (s === col.a && e === col.b) || (s === col.b && e === col.a);
      }
      function connectedCount() {
        var i, n = 0;
        for (i = 0; i < g.colors.length; i++) if (isConnected(i)) n++;
        return n;
      }
      function filledCount() {
        var i, n = 0;
        for (i = 0; i < g.total; i++) if (g.owner[i] >= 0) n++;
        return n;
      }
      function isSolved() { return connectedCount() === g.colors.length && filledCount() === g.total; }
      function pctNow() {
        if (!g) return 0;
        return Math.round(filledCount() / g.total * 100);
      }
      function resetAll() {
        if (!g || locked || dead || finished) return;
        var i;
        for (i = 0; i < g.colors.length; i++) clearPath(i);
        drag = null;
        sfx('click');
        updateChips();
      }

      /* --------- Eingabe --------- */
      function cellAt(e) {
        if (!canvas || !g) return -1;
        var r = canvas.getBoundingClientRect();
        if (!r.width) return -1;
        var pad = r.width * 0.03, size = (r.width - 2 * pad) / g.n;
        var x = Math.floor((e.clientX - r.left - pad) / size);
        var y = Math.floor((e.clientY - r.top - pad) / size);
        if (x < 0 || y < 0 || x >= g.n || y >= g.n) return -1;
        return y * g.n + x;
      }

      function onDown(e) {
        if (dead || finished || locked || !g) return;
        e.preventDefault();
        var cell = cellAt(e);
        if (cell < 0) return;
        var c = g.owner[cell];
        if (c < 0) { blip(180, 0.04); return; }
        if (g.ep[cell] === c) {                    // an einem Punkt neu anfangen
          clearPath(c);
          g.paths[c] = [cell]; g.owner[cell] = c;
        } else {                                   // mitten auf der eigenen Röhre weiterziehen
          var idx = g.paths[c].indexOf(cell);
          if (idx < 0) return;
          truncate(c, idx + 1);
        }
        drag = { c: c };
        try { canvas.setPointerCapture(e.pointerId); } catch (err) {}
        blip(300 + c * 40, 0.03);
        updateChips();
      }

      function onMove(e) {
        if (dead || finished || !drag || !g) return;
        e.preventDefault();
        var cell = cellAt(e);
        if (cell < 0) return;
        walkTo(cell);
      }

      function onUp(e) {
        if (!drag) return;
        if (e && e.preventDefault) e.preventDefault();
        try { if (e && e.pointerId != null) canvas.releasePointerCapture(e.pointerId); } catch (err) {}
        drag = null;
        report(false);
      }

      /* Zieht die Röhre Feld für Feld Richtung Ziel (schnelles Wischen bleibt sauber). */
      function walkTo(target) {
        var guard = 0;
        while (guard++ < 60) {
          /* Achtung: stepTo() kann das Rätsel lösen -> award() setzt drag=null
             und sperrt das Brett. Also vor JEDEM Durchlauf neu prüfen. */
          if (!drag || !g || locked || finished || dead) return;
          var p = g.paths[drag.c];
          if (!p.length) return;
          var last = p[p.length - 1];
          if (last === target) return;
          var n = g.n;
          var lx = last % n, ly = (last - lx) / n, tx = target % n, ty = (target - tx) / n;
          var dx = tx - lx, dy = ty - ly, steps = [];
          if (Math.abs(dx) >= Math.abs(dy)) {
            if (dx) steps.push(last + (dx > 0 ? 1 : -1));
            if (dy) steps.push(last + (dy > 0 ? n : -n));
          } else {
            if (dy) steps.push(last + (dy > 0 ? n : -n));
            if (dx) steps.push(last + (dx > 0 ? 1 : -1));
          }
          var moved = false, i;
          for (i = 0; i < steps.length; i++) { if (stepTo(steps[i])) { moved = true; break; } }
          if (!moved) return;
        }
      }

      /* Ein Schritt auf ein NACHBARFELD. true = ausgeführt. */
      function stepTo(cell) {
        var c = drag.c, p = g.paths[c];
        if (!p.length) return false;
        var last = p[p.length - 1];

        /* zurückziehen */
        if (p.length >= 2 && cell === p[p.length - 2]) {
          truncate(c, p.length - 1); updateChips(); return true;
        }
        /* schon fertig verbunden → nicht über den Zielpunkt hinaus */
        var oe = otherEndOf(c);
        if (p.length > 1 && last === oe) return false;

        var own = g.owner[cell];
        if (own === c) {
          var idx = p.indexOf(cell);
          if (idx >= 0) { truncate(c, idx + 1); updateChips(); return true; }   // eigene Schlinge kappen
          if (cell === oe) {                                                    // Zielpunkt erreicht
            p.push(cell); g.owner[cell] = c; onConnect(c); updateChips(); return true;
          }
          return false;
        }
        if (own >= 0) {
          if (g.ep[cell] >= 0) { return false; }                                // fremder Punkt blockiert
          var d = own, di = g.paths[d].indexOf(cell);
          if (di >= 0) truncate(d, di);                                         // fremde Röhre kappen
          else g.owner[cell] = -1;
          if (App.Audio && App.Audio.blip) App.Audio.blip(200, 0.03);
        }
        p.push(cell); g.owner[cell] = c;
        if (cell === oe) onConnect(c);
        updateChips();
        return true;
      }

      function onConnect(c) {
        g.pulse[c] = Date.now();
        blip(660 + c * 30, 0.07);
        sfx('ding');
      }

      /* --------- Anzeige / Fortschritt --------- */
      function updateChips() {
        if (!g || !colChip) return;
        var cc = connectedCount(), fc = filledCount();
        colChip.textContent = '🎨 ' + cc + '/' + g.colors.length;
        cellChip.textContent = '▦ ' + fc + '/' + g.total;
        colChip.className = 'chip flw-c1' + (cc === g.colors.length ? ' flw-ok' : '');
        cellChip.className = 'chip flw-c2' + (fc === g.total ? ' flw-ok' : '');
        if (!locked && isSolved()) award();
      }

      function award() {
        if (locked || finished || dead) return;
        locked = true; drag = null;
        var secs = Math.max(0, (nowFn() - puzzleStartAt) / 1000);
        var pts = baseFor(levelIdx) + bonusFor(secs);
        score += pts; solvedCount++;
        scoreEl.textContent = App.MG.fmt(score);
        scoreEl.classList.remove('flw-bump'); void scoreEl.offsetWidth; scoreEl.classList.add('flw-bump');
        sfx('levelup');
        showFlash('✅ Gelöst!  +' + pts);
        report(true);
        after(SOLVE_PAUSE, function () { levelIdx++; loadLevel(); });
      }

      function showFlash(txt) {
        if (!flashLayer) return;
        var f = el('div', { class: 'flw-flash' }, [txt]);
        flashLayer.appendChild(f);
        after(1200, function () { if (f.parentNode) f.parentNode.removeChild(f); });
      }

      function report(force) {
        if (!isMulti || dead) return;
        var pct = pctNow(), t = Date.now();
        if (!force && pct === lastPct && levelIdx === lastLvl) return;
        if (!force && t - lastRep < 700) return;
        lastRep = t; lastPct = pct; lastLvl = levelIdx;
        ctx.room.reportScore(score);
        ctx.room.reportState({ lvl: levelIdx + 1, pct: pct });
      }

      /* --------- Bots (Solo) --------- */
      function botDur(b, li) {
        var lv = levelAt(li);
        var base = (lv.n * lv.n) * 0.42 + lv.k * 1.6;           // Sekunden-Grundwert
        var jitter = 0.82 + Math.random() * 0.38;
        return Math.max(4000, base * diff.factor * b.skill * jitter * 1000);
      }
      function botTick(t) {
        bots.forEach(function (b) {
          var guard = 0;
          while (t >= b.nextAt && guard++ < 60 && t < endAt + 1) {
            b.score += baseFor(b.lvl) + bonusFor((b.nextAt - b.startAt) / 1000);
            b.lvl++;
            b.startAt = b.nextAt;
            b.nextAt = b.startAt + botDur(b, b.lvl);
          }
          var span = Math.max(1, b.nextAt - b.startAt);
          b.pct = Math.max(0, Math.min(100, Math.round((t - b.startAt) / span * 100)));
        });
      }

      /* --------- Rangliste --------- */
      function rows() {
        var out = [];
        if (isMulti) {
          ctx.room.players().forEach(function (p) {
            var s = p.state || {};
            out.push({
              id: p.id, name: p.name, me: p.id === ctx.me.id,
              score: p.score || 0, lvl: s.lvl || 1, pct: s.pct || 0
            });
          });
        } else {
          out.push({ id: 'me', name: 'Du', me: true, score: score, lvl: levelIdx + 1, pct: pctNow() });
          bots.forEach(function (b, i) {
            out.push({ id: 'b' + i, name: b.name, me: false, score: b.score, lvl: b.lvl + 1, pct: b.pct });
          });
        }
        out.sort(function (a, b) {
          return (b.score - a.score) || (b.lvl - a.lvl) || (b.pct - a.pct) || a.name.localeCompare(b.name);
        });
        return out;
      }
      function renderBoard() {
        if (dead || !boardEl) return;
        var rs = rows();
        boardEl.innerHTML = '';
        rs.forEach(function (r, i) {
          boardEl.appendChild(el('div', { class: 'flw-row' + (r.me ? ' flw-me' : '') + ' flw-p' + (i + 1) }, [
            el('span', { class: 'flw-rank' }, ['' + (i + 1)]),
            el('div', { class: 'flw-mid2' }, [
              el('div', { class: 'flw-nm' }, [r.name + (r.me ? ' (du)' : '')]),
              el('div', { class: 'flw-bar' }, [
                el('div', { class: 'flw-fill', style: 'width:' + Math.max(2, Math.min(100, r.pct)) + '%;' })
              ])
            ]),
            el('div', { class: 'flw-right2' }, [
              el('div', { class: 'flw-sc' }, [App.MG.fmt(r.score)]),
              el('div', { class: 'flw-lv' }, ['Rätsel ' + r.lvl])
            ])
          ]));
        });
      }

      /* --------- Zeichnen --------- */
      function resizeIfNeeded() {
        var w = canvas.clientWidth;
        var dpr = window.devicePixelRatio || 1;
        if (!w) return false;
        if (w === cssW && dpr === curDpr) return true;
        cssW = w; curDpr = dpr;
        canvas.style.height = w + 'px';
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(w * dpr);
        c2d.setTransform(dpr, 0, 0, dpr, 0, 0);
        return true;
      }

      function draw() {
        raf = requestAnimationFrame(draw);
        if (dead || !canvas || !c2d || !g) return;
        if (!resizeIfNeeded()) return;

        var W = cssW, t = Date.now();
        var pad = W * 0.03, size = (W - 2 * pad) / g.n;
        var cx = function (cell) { return pad + ((cell % g.n) + 0.5) * size; };
        var cy = function (cell) { return pad + (Math.floor(cell / g.n) + 0.5) * size; };

        c2d.clearRect(0, 0, W, W);

        /* Gitter */
        var i, x, y;
        for (i = 0; i < g.total; i++) {
          x = pad + (i % g.n) * size; y = pad + Math.floor(i / g.n) * size;
          c2d.fillStyle = (g.owner[i] >= 0) ? 'rgba(255,255,255,.035)' : 'rgba(255,255,255,.02)';
          rrect(x + 1.5, y + 1.5, size - 3, size - 3, Math.min(7, size * 0.16));
          c2d.fill();
          c2d.strokeStyle = 'rgba(57,255,20,.10)';
          c2d.lineWidth = 1;
          c2d.stroke();
        }

        /* Röhren */
        var order = [], ci;
        for (ci = 0; ci < g.colors.length; ci++) order.push(ci);
        order.forEach(function (c) {
          var p = g.paths[c];
          if (p.length < 2) return;
          var hex = PALETTE[c % PALETTE.length];
          var done = isConnected(c);
          var active = drag && drag.c === c;
          var pulse = active ? (0.5 + 0.5 * Math.sin(t / 160)) : 0;

          c2d.lineCap = 'round'; c2d.lineJoin = 'round';
          /* Glut darunter */
          c2d.strokeStyle = rgba(hex, done ? 0.22 : 0.14);
          c2d.lineWidth = size * (done ? 0.62 : 0.55);
          line(p);
          /* Kern */
          c2d.strokeStyle = rgba(hex, done ? 1 : 0.8 + 0.15 * pulse);
          c2d.lineWidth = size * (0.4 + (active ? 0.03 * pulse : 0));
          c2d.shadowColor = rgba(hex, done ? 0.8 : 0.45);
          c2d.shadowBlur = done ? 14 : 8;
          line(p);
          c2d.shadowBlur = 0;
          /* Lichtkante */
          c2d.strokeStyle = 'rgba(255,255,255,' + (done ? 0.3 : 0.16) + ')';
          c2d.lineWidth = size * 0.12;
          line(p);
        });

        /* Punkte */
        for (ci = 0; ci < g.colors.length; ci++) {
          var col = g.colors[ci], hexc = PALETTE[ci % PALETTE.length];
          var conn = isConnected(ci);
          [col.a, col.b].forEach(function (cell) {
            var px = cx(cell), py = cy(cell), r = size * 0.31;
            c2d.beginPath(); c2d.arc(px, py, r, 0, Math.PI * 2);
            c2d.fillStyle = rgba(hexc, 1);
            c2d.shadowColor = rgba(hexc, conn ? 0.95 : 0.5);
            c2d.shadowBlur = conn ? 18 : 9;
            c2d.fill();
            c2d.shadowBlur = 0;
            c2d.beginPath(); c2d.arc(px, py, r * 0.52, 0, Math.PI * 2);
            c2d.fillStyle = 'rgba(255,255,255,' + (conn ? 0.85 : 0.35) + ')';
            c2d.fill();
          });
          /* Ring-Welle beim Verbinden */
          var age = t - (g.pulse[ci] || 0);
          if (age >= 0 && age < 480) {
            var k = age / 480;
            [col.a, col.b].forEach(function (cell) {
              c2d.beginPath();
              c2d.arc(cx(cell), cy(cell), size * (0.3 + k * 0.55), 0, Math.PI * 2);
              c2d.strokeStyle = rgba(hexc, (1 - k) * 0.75);
              c2d.lineWidth = size * 0.08 * (1 - k) + 1;
              c2d.stroke();
            });
          }
        }

        /* Kopf des aktiven Zugs */
        if (drag) {
          var pa = g.paths[drag.c];
          if (pa && pa.length) {
            var head2 = pa[pa.length - 1], hx = cx(head2), hy = cy(head2);
            var w2 = 0.5 + 0.5 * Math.sin(t / 120);
            c2d.beginPath(); c2d.arc(hx, hy, size * (0.24 + 0.05 * w2), 0, Math.PI * 2);
            c2d.strokeStyle = 'rgba(255,255,255,' + (0.35 + 0.35 * w2) + ')';
            c2d.lineWidth = 2;
            c2d.stroke();
          }
        }

        function line(p) {
          c2d.beginPath();
          c2d.moveTo(cx(p[0]), cy(p[0]));
          var q;
          for (q = 1; q < p.length; q++) c2d.lineTo(cx(p[q]), cy(p[q]));
          c2d.stroke();
        }
        function rrect(rx, ry, rw, rh, rr) {
          c2d.beginPath();
          c2d.moveTo(rx + rr, ry);
          c2d.lineTo(rx + rw - rr, ry); c2d.quadraticCurveTo(rx + rw, ry, rx + rw, ry + rr);
          c2d.lineTo(rx + rw, ry + rh - rr); c2d.quadraticCurveTo(rx + rw, ry + rh, rx + rw - rr, ry + rh);
          c2d.lineTo(rx + rr, ry + rh); c2d.quadraticCurveTo(rx, ry + rh, rx, ry + rh - rr);
          c2d.lineTo(rx, ry + rr); c2d.quadraticCurveTo(rx, ry, rx + rr, ry);
          c2d.closePath();
        }
      }

      /* ================= ENDE ================= */
      function finish() {
        if (finished || dead) return;
        finished = true; locked = true; drag = null;
        stopRaf(); clearPending(); stopHelpers();
        sfx('whoosh');

        if (isMulti) {
          ctx.room.reportScore(score);
          ctx.room.reportState({ lvl: levelIdx + 1, pct: pctNow() });
          var t = setTimeout(function () {
            if (dead) return;
            App.MG.endScreen(root, { players: ctx.room.players(), meId: ctx.me.id, onExit: ctx.onExit });
          }, 1200);
          pending.push(t);
        } else {
          var rs = rows(), rank = 1, i;
          for (i = 0; i < rs.length; i++) if (rs[i].me) rank = i + 1;
          var best = App.Storage.get('best_flow', 0);
          var nb = score > best;
          if (nb) App.Storage.set('best_flow', score);
          App.MG.endScreen(root, {
            score: score, best: best, newBest: nb,
            label: solvedCount + (solvedCount === 1 ? ' Rätsel gelöst' : ' Rätsel gelöst') +
              ' · Platz ' + rank + ' von ' + rs.length +
              (nb ? ' · neuer Rekord! 🎉' : ' · Bestwert: ' + App.MG.fmt(best)),
            onExit: ctx.onExit,
            onAgain: function () { showMenu(); }
          });
        }
      }
    }
  };

  /* ===================== STYLES ===================== */
  function injectStyle() {
    UI.injectStyle('mg-flow-css', [
      '.flw-layout{display:flex;flex-direction:column;gap:10px;}',
      /* Kopf */
      '.flw-head{display:flex;justify-content:space-between;align-items:center;padding:10px 18px;gap:12px;flex-wrap:wrap;}',
      '.flw-hcell{display:flex;flex-direction:column;gap:2px;min-width:0;}',
      '.flw-mid{text-align:center;}',
      '.flw-right{text-align:right;}',
      '.flw-hl{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:1px;}',
      '.flw-hv{font-size:clamp(20px,5.4vw,32px);font-weight:900;line-height:1;font-variant-numeric:tabular-nums;}',
      '.flw-lvl{color:var(--aqua);text-shadow:0 0 14px rgba(51,230,208,.5);}',
      '.flw-score{color:var(--gold);text-shadow:0 0 12px rgba(255,210,63,.45);}',
      '.flw-head .mg-timer{font-size:clamp(18px,5vw,26px);}',
      '.mg-timer.flw-urgent{color:var(--danger);animation:flw-pulse .7s infinite;}',
      '.flw-bump{animation:flw-bump .32s ease;}',
      /* Chips */
      '.flw-chips{display:flex;gap:8px;justify-content:center;flex-wrap:wrap;}',
      '.flw-chips .chip{font-variant-numeric:tabular-nums;transition:color .15s,border-color .15s,box-shadow .15s;}',
      '.flw-chips .chip.flw-ok{color:var(--neon);border-color:var(--stroke-2);box-shadow:0 0 14px rgba(57,255,20,.3);}',
      /* Spielfeld */
      '.flw-boardwrap{position:relative;display:flex;justify-content:center;}',
      '.flw-canvas{display:block;width:100%;max-width:min(430px,46vh);border-radius:20px;',
      'background:radial-gradient(circle at 50% 40%,#0a2417,#04120b 76%);border:1px solid var(--stroke);',
      'box-shadow:0 10px 34px rgba(0,0,0,.45),inset 0 0 60px rgba(57,255,20,.06);',
      'touch-action:none;user-select:none;-webkit-user-select:none;-webkit-tap-highlight-color:transparent;cursor:crosshair;}',
      /* Jubel-Overlay */
      '.flw-flashlayer{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none;}',
      '.flw-flash{font-size:clamp(17px,4.4vw,26px);font-weight:900;color:#04160c;background:linear-gradient(180deg,#9dff7a,var(--neon));',
      'padding:10px 20px;border-radius:14px;box-shadow:0 0 40px rgba(57,255,20,.7);animation:flw-flash 1.2s ease forwards;}',
      '.flw-rule{text-align:center;margin:0;font-size:12px;}',
      '.flw-controls{justify-content:center;}',
      /* Rangliste */
      '.flw-boardpanel{padding:12px 14px;display:flex;flex-direction:column;gap:8px;}',
      '.flw-board{display:flex;flex-direction:column;gap:6px;max-height:230px;overflow-y:auto;}',
      '.flw-row{display:flex;align-items:center;gap:10px;padding:7px 10px;border-radius:11px;',
      'background:rgba(4,20,12,.6);border:1px solid var(--stroke);}',
      '.flw-row.flw-me{border-color:var(--stroke-2);box-shadow:0 0 16px rgba(57,255,20,.18);background:rgba(10,40,22,.7);}',
      '.flw-row.flw-p1 .flw-rank{color:var(--gold);}',
      '.flw-row.flw-p2 .flw-rank{color:var(--silver);}',
      '.flw-row.flw-p3 .flw-rank{color:var(--bronze);}',
      '.flw-rank{font-weight:900;font-size:15px;width:18px;text-align:center;color:var(--muted);flex:0 0 auto;}',
      '.flw-mid2{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:4px;}',
      '.flw-nm{font-weight:700;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--leaf);}',
      '.flw-bar{height:6px;border-radius:99px;background:rgba(255,255,255,.08);overflow:hidden;}',
      '.flw-fill{height:100%;border-radius:99px;background:linear-gradient(90deg,var(--aqua),var(--neon));',
      'box-shadow:0 0 10px rgba(57,255,20,.5);transition:width .3s ease;}',
      '.flw-right2{flex:0 0 auto;text-align:right;}',
      '.flw-sc{font-weight:900;font-size:15px;color:var(--gold);font-variant-numeric:tabular-nums;line-height:1.1;}',
      '.flw-lv{font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;}',
      /* Menü / Warten */
      '.flw-menu{padding:26px 22px;text-align:center;display:flex;flex-direction:column;gap:12px;align-items:center;max-width:540px;margin:0 auto;}',
      '.flw-menu-ic{font-size:56px;line-height:1;filter:drop-shadow(0 0 16px rgba(51,230,208,.6));}',
      '.flw-menu h2{margin:0;}',
      '.flw-menu .hint-text{margin:0;}',
      '.flw-spin{animation:flw-spin 2.4s linear infinite;}',
      '.flw-bestrow{display:flex;gap:8px;justify-content:center;}',
      '.flw-cards{display:flex;gap:10px;justify-content:center;flex-wrap:wrap;width:100%;}',
      '.flw-card{flex:1 1 140px;min-width:130px;max-width:180px;padding:14px 10px;border-radius:16px;',
      'border:1px solid var(--stroke);background:rgba(6,24,14,.6);cursor:pointer;font-family:inherit;',
      'display:flex;flex-direction:column;gap:4px;align-items:center;transition:transform .12s,box-shadow .15s,border-color .15s;}',
      '.flw-card:hover{transform:translateY(-3px);border-color:var(--stroke-2);box-shadow:0 0 22px rgba(57,255,20,.28);}',
      '.flw-card:active{transform:translateY(-1px) scale(.98);}',
      '.flw-card-ic{font-size:30px;line-height:1;}',
      '.flw-card-nm{font-weight:900;font-size:16px;}',
      '.flw-card-in{font-size:11px;color:var(--muted);line-height:1.3;}',
      /* Animationen */
      '@keyframes flw-pulse{0%,100%{opacity:1}50%{opacity:.4}}',
      '@keyframes flw-bump{0%{transform:scale(1)}40%{transform:scale(1.22)}100%{transform:scale(1)}}',
      '@keyframes flw-spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}',
      '@keyframes flw-flash{0%{opacity:0;transform:scale(.7)}18%{opacity:1;transform:scale(1.06)}',
      '30%{transform:scale(1)}75%{opacity:1}100%{opacity:0;transform:scale(1.04) translateY(-14px)}}'
    ].join(''));
  }
})();
