/* unblock.js — "Schiebe-Block": Rush-Hour-Wettrennen im Neon-Dschungel.
 *
 * IDEE
 *   Ein 6x6-Gitter voller Blöcke (Autos, 2–3 Felder lang). Jeder Block fährt
 *   nur in seiner eigenen Achse: waagrechte nach links/rechts, senkrechte nach
 *   oben/unten. Das rote Auto steht in Reihe 3 und muss durch den Ausgang rechts
 *   raus — die anderen Blöcke stehen im Weg. Gelöst -> sofort das nächste,
 *   schwerere Rätsel. 4 Minuten am Stück, danach Endscreen.
 *
 * STEUERUNG
 *   - Block mit Maus/Finger anfassen und in seiner Achse ziehen (pointerdown/
 *     move/up). Der Block folgt dem Finger und rastet beim Loslassen ein.
 *     Ein Zug = einmal ziehen, egal über wie viele Felder.
 *   - Kurzes Antippen wählt einen Block aus, dann bewegen ihn die Pfeiltasten
 *     (bzw. WASD) um ein Feld. Ohne Auswahl steuern die Pfeiltasten das rote Auto.
 *   - 🔄 Neu stellt das Rätsel zurück, 💡 Tipp zeigt den nächsten optimalen Zug
 *     (kostet 150 Punkte).
 *
 * PUNKTE (pro gelöstem Rätsel, Aufschlüsselung wird kurz eingeblendet)
 *   Basis  : 240 + 30 x Mindestzugzahl   -> schwere Rätsel bringen mehr
 *   Züge   : (Par − gebrauchte Züge) x 14, nie negativ  -> wenige Züge zahlen sich aus
 *   Tempo  : Basis − Sekunden x 7, nie negativ         -> schnell sein zahlt sich aus
 *   Jeder Tipp kostet 150 Punkte (Punktestand nie unter 0).
 *
 * RÄTSEL
 *   9 Stufen wachsender Schwierigkeit (6 bis 24 optimale Züge) mit je 3
 *   Varianten, fest im File kodiert. Alle wurden per vollständiger
 *   Zustandsraum-BFS erzeugt und geprüft: garantiert lösbar, und m ist die
 *   exakte Mindestzugzahl. Ab Stufe 9 bleibt es bei der härtesten Stufe.
 *
 * SYNC-MODELL (multi)
 *   Punkte-Rennen wie reflex.js: alle spielen gleichzeitig dasselbe Rätsel.
 *   Fairness über einen gemeinsamen Seed — der Host schreibt ihn per
 *   room.setShared({ubkSeed}). Der Seed ist zusätzlich DETERMINISTISCH aus
 *   round.startAt ableitbar (seedFromStart), wer das shared-Feld also noch
 *   nicht hat, rechnet exakt denselben Wert selbst aus -> Auseinanderlaufen
 *   ist unmöglich. Rätsel k wählt Stufe k und daraus per hash32(seed, k) eine
 *   der 3 Varianten. Fortschritt: room.reportScore(punkte) +
 *   room.reportState({p, prog}) -> eigene Live-Rangliste mit Balken.
 *
 * SOLO
 *   Punktejagd gegen App.Storage 'best_unblock' — plus drei Bots mit
 *   unterschiedlicher Stärke, die pro Rätsel realistisch lange brauchen
 *   (Grundzeit nach Mindestzugzahl, geteilt durch die Stärke, mit Streuung).
 *
 * Alle Timer laufen über Wall-Clock (Date.now bzw. room.now) -> Tab-sicher,
 * rAF wird nicht gebraucht (CSS-Transitions animieren die Blöcke).
 * cleanup() setzt dead=true, killt Timer, Listener und room.on-Abos.
 */
(function () {
  'use strict';
  window.App = window.App || {}; App.Minigames = App.Minigames || {};
  var UI = App.UI, el = UI.el;

  injectStyle();

  var N = 6;                  // Gitter 6x6
  var RED_ROW = 2;            // Reihe des roten Autos (0-basiert)
  var DURATION = 240;         // s Rundenzeit (4 Minuten)
  var TAP_SLOP = 9;           // px: darunter gilt es als Tippen, darüber als Ziehen
  var HINT_COST = 150;        // Punkte je Tipp
  var MAX_STATES = 200000;    // Sicherheitsgrenze für den Tipp-Löser

  /* ================= Rätsel-Daten =================
   * Ein Block: [richtung, x, y, laenge] — richtung 0 = waagrecht, 1 = senkrecht.
   * Der erste Block ist immer das rote Auto (waagrecht, Reihe 2, Länge 2).
   * m = geprüfte Mindestzugzahl (ein Zug = ein Block beliebig weit schieben). */
  var TIERS = [
    /* Stufe 1 — 6 Züge */
    [
      { m: 6, c: [[0,0,2,2],[1,5,1,2],[1,1,4,2],[0,0,3,2],[1,2,4,2],[1,2,2,2],[0,3,3,2],[0,4,5,2],[1,3,1,2],[0,1,0,2],[0,3,0,2]] },
      { m: 6, c: [[0,2,2,2],[0,3,3,2],[1,2,0,2],[0,0,0,2],[1,4,0,3],[0,4,5,2],[0,3,4,2],[1,3,0,2],[1,5,2,2]] },
      { m: 6, c: [[0,0,2,2],[0,4,4,2],[1,3,1,3],[1,5,0,2],[1,4,0,2],[1,2,3,2],[0,1,0,2],[1,5,2,2],[1,0,4,2]] }
    ],
    /* Stufe 2 — 8 Züge */
    [
      { m: 8, c: [[0,0,2,2],[1,5,1,2],[1,1,3,2],[0,2,3,2],[1,2,4,2],[1,2,1,2],[0,4,3,2],[0,4,5,2],[1,3,1,2],[0,1,0,2],[0,4,0,2]] },
      { m: 8, c: [[0,0,2,2],[0,1,3,2],[1,2,1,2],[0,1,0,2],[1,4,1,3],[0,4,5,2],[0,4,4,2],[1,3,1,2],[1,5,2,2]] },
      { m: 8, c: [[0,1,2,2],[0,4,4,2],[1,3,1,3],[1,5,0,2],[1,4,2,2],[1,2,3,2],[0,1,0,2],[1,5,2,2],[1,0,4,2]] }
    ],
    /* Stufe 3 — 10 Züge */
    [
      { m: 10, c: [[0,0,2,2],[1,5,0,2],[1,1,3,2],[0,2,3,2],[1,2,4,2],[1,2,1,2],[0,4,3,2],[0,0,5,2],[1,3,1,2],[0,0,0,2],[0,3,0,2]] },
      { m: 10, c: [[0,1,2,2],[0,4,3,2],[1,2,4,2],[0,2,0,2],[1,4,0,3],[0,3,5,2],[0,4,4,2],[1,3,3,2],[1,5,1,2]] },
      { m: 10, c: [[0,1,2,2],[0,4,4,2],[1,3,2,3],[1,5,0,2],[1,4,2,2],[1,2,3,2],[0,2,0,2],[1,5,2,2],[1,0,2,2]] }
    ],
    /* Stufe 4 — 12 Züge */
    [
      { m: 12, c: [[0,1,2,2],[0,1,0,2],[0,4,5,2],[1,0,4,2],[1,3,1,2],[1,1,4,2],[1,4,1,3],[0,2,5,2],[0,1,1,2],[1,2,3,2],[0,4,4,2]] },
      { m: 12, c: [[0,2,2,2],[0,3,5,3],[1,4,2,2],[0,0,1,2],[1,5,1,3],[0,3,0,3],[0,3,1,2],[0,0,5,2],[1,0,2,3],[1,2,3,2],[0,0,0,2],[0,4,4,2]] },
      { m: 12, c: [[0,0,2,2],[1,1,4,2],[0,3,0,2],[1,3,1,3],[0,3,5,2],[1,2,2,2],[1,4,1,2],[0,3,4,2],[1,2,0,2],[0,4,3,2],[1,0,0,2]] }
    ],
    /* Stufe 5 — 14 Züge */
    [
      { m: 14, c: [[0,2,2,2],[0,2,5,3],[1,4,2,2],[0,1,1,2],[1,5,2,3],[0,3,0,3],[0,4,1,2],[0,0,5,2],[1,0,2,3],[1,2,3,2],[0,0,0,2],[0,3,4,2]] },
      { m: 14, c: [[0,0,2,2],[1,1,3,2],[0,4,0,2],[1,3,0,3],[0,3,5,2],[1,2,4,2],[1,4,2,2],[0,3,4,2],[1,2,1,2],[0,2,3,2],[1,0,0,2]] },
      { m: 14, c: [[0,0,2,2],[1,0,3,2],[0,2,0,2],[1,3,1,3],[1,5,4,2],[1,2,1,3],[0,0,5,2],[0,4,1,2],[1,1,0,2],[0,3,4,2],[0,3,5,2],[1,5,2,2]] }
    ],
    /* Stufe 6 — 16 Züge */
    [
      { m: 16, c: [[0,2,2,2],[0,2,5,3],[1,4,2,2],[0,1,1,2],[1,5,3,3],[0,3,0,3],[0,4,1,2],[0,0,5,2],[1,0,2,3],[1,2,3,2],[0,1,0,2],[0,3,4,2]] },
      { m: 16, c: [[0,0,2,2],[1,1,4,2],[0,1,0,2],[1,3,0,3],[0,3,5,2],[1,2,3,2],[1,4,0,2],[0,3,4,2],[1,2,1,2],[0,0,3,2],[1,0,0,2]] },
      { m: 16, c: [[0,0,2,2],[1,0,3,2],[0,3,0,2],[1,3,2,3],[1,5,4,2],[1,2,1,3],[0,0,5,2],[0,4,1,2],[1,1,0,2],[0,1,4,2],[0,3,5,2],[1,5,2,2]] }
    ],
    /* Stufe 7 — 18 Züge */
    [
      { m: 18, c: [[0,0,2,2],[1,0,3,2],[0,3,0,2],[1,3,2,3],[1,5,4,2],[1,2,0,3],[0,0,5,2],[0,3,1,2],[1,1,0,2],[0,1,4,2],[0,3,5,2],[1,5,0,2]] },
      { m: 18, c: [[0,0,2,2],[0,2,0,3],[1,0,4,2],[0,0,1,2],[1,2,3,2],[1,3,1,2],[1,5,3,3],[0,1,5,2],[1,2,1,2],[0,3,3,2],[0,3,4,2]] },
      { m: 18, c: [[0,1,2,2],[0,0,3,3],[0,3,4,2],[1,3,2,2],[1,2,0,2],[0,3,0,2],[1,5,3,2],[1,5,0,2],[0,3,1,2],[1,0,0,2],[1,4,2,2],[1,1,4,2]] }
    ],
    /* Stufe 8 — 21 Züge */
    [
      { m: 21, c: [[0,0,2,2],[1,0,3,2],[0,3,0,2],[1,3,3,3],[1,5,3,2],[1,2,0,3],[0,0,5,2],[0,3,1,2],[1,1,0,2],[0,1,4,2],[0,4,5,2],[1,5,0,2]] },
      { m: 21, c: [[0,0,2,2],[0,2,0,3],[1,0,3,2],[0,0,1,2],[1,2,3,2],[1,3,1,2],[1,5,0,3],[0,1,5,2],[1,2,1,2],[0,3,3,2],[0,4,4,2]] },
      { m: 21, c: [[0,1,2,2],[0,0,3,3],[0,2,4,2],[1,3,2,2],[1,2,0,2],[0,0,0,2],[1,5,4,2],[1,5,1,2],[0,3,1,2],[1,0,1,2],[1,4,3,2],[1,1,4,2]] }
    ],
    /* Stufe 9 — 24 Züge */
    [
      { m: 24, c: [[0,0,2,2],[1,0,4,2],[0,4,0,2],[1,3,3,3],[1,5,3,2],[1,2,1,3],[0,1,5,2],[0,3,1,2],[1,1,0,2],[0,1,4,2],[0,4,5,2],[1,5,1,2]] },
      { m: 24, c: [[0,1,2,2],[0,0,3,3],[0,4,4,2],[1,3,3,2],[1,2,0,2],[0,0,0,2],[1,5,2,2],[1,5,0,2],[0,3,1,2],[1,0,1,2],[1,4,2,2],[1,1,4,2]] },
      { m: 24, c: [[0,1,2,2],[1,1,4,2],[1,5,0,2],[0,1,0,3],[0,0,3,2],[1,0,1,2],[0,4,5,2],[1,2,3,2],[0,1,1,2],[0,2,5,2],[1,3,1,3]] }
    ]
  ];

  /* ================= Seed-Zufall (deterministisch) ================= */
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
    var x = ((a >>> 0) ^ Math.imul(b >>> 0, 0x9E3779B1)) >>> 0;
    x = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
    x = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
    return (x ^ (x >>> 16)) >>> 0;
  }
  /* Seed allein aus der Startzeit — jedes Gerät rechnet denselben Wert aus. */
  function seedFromStart(startAt) { return hash32(Math.floor(startAt / 1000), 0x5C41EB) >>> 0; }

  /* Rätsel Nr. idx: Stufe idx (ab Stufe 9 bleibt es bei der härtesten),
     Variante per Seed -> alle Geräte bekommen dasselbe Layout. */
  function puzzleAt(seed, idx) {
    var tier = TIERS[Math.min(idx, TIERS.length - 1)];
    return tier[hash32(seed, idx + 1) % tier.length];
  }

  /* ================= Brett-Logik (rein, ohne DOM) ================= */

  /* Modell eines Blocks: { d, fixed, len, p, p0 }
     d=0 waagrecht -> fixed = Reihe (y), p = x;  d=1 senkrecht -> fixed = Spalte (x), p = y. */
  function carsOf(pz) {
    return pz.c.map(function (a) {
      var d = a[0];
      return { d: d, fixed: d === 0 ? a[2] : a[1], len: a[3], p: d === 0 ? a[1] : a[2], p0: d === 0 ? a[1] : a[2] };
    });
  }
  /* Gitter-Index der Zelle, die Block c an Achsen-Position t belegt. */
  function cellAt(c, t) { return c.d === 0 ? c.fixed * N + t : t * N + c.fixed; }

  function gridOfPos(cars, pos) {
    var g = [], i, k;
    for (i = 0; i < N * N; i++) g.push(-1);
    for (i = 0; i < cars.length; i++) {
      for (k = 0; k < cars[i].len; k++) g[cellAt(cars[i], pos[i] + k)] = i;
    }
    return g;
  }
  function posOf(cars) { return cars.map(function (c) { return c.p; }); }
  function isGoal(cars, pos) { return pos[0] + cars[0].len === N; }
  function isSolved(cars) { return cars[0].p + cars[0].len === N; }

  /* Freier Schiebe-Bereich [min, max] für Block i in der aktuellen Lage. */
  function rangeOf(cars, i) {
    var g = gridOfPos(cars, posOf(cars)), c = cars[i], lo = c.p, hi = c.p;
    while (lo > 0 && g[cellAt(c, lo - 1)] === -1) lo--;
    while (hi + c.len < N && g[cellAt(c, hi + c.len)] === -1) hi++;
    return [lo, hi];
  }

  /* Alle Folge-Lagen (ein Zug = ein Block beliebig weit). */
  function movesFrom(cars, pos) {
    var g = gridOfPos(cars, pos), out = [], i, t, q;
    for (i = 0; i < cars.length; i++) {
      var c = cars[i], p = pos[i];
      for (t = p - 1; t >= 0 && g[cellAt(c, t)] === -1; t--) { q = pos.slice(); q[i] = t; out.push({ i: i, p: t, pos: q }); }
      for (t = p + 1; t + c.len <= N && g[cellAt(c, t + c.len - 1)] === -1; t++) { q = pos.slice(); q[i] = t; out.push({ i: i, p: t, pos: q }); }
    }
    return out;
  }

  /* Tipp-Löser: Breitensuche zum Ausgang, liefert den ERSTEN Zug einer
     optimalen Lösung ({i, p}) oder null. Der Zustandsraum ist klein (wenige
     10.000 Lagen), die Grenze MAX_STATES ist nur ein Sicherheitsnetz. */
  function hintMove(cars) {
    var start = posOf(cars);
    if (isGoal(cars, start)) return null;
    var startKey = start.join(','), meta = {}, queue = [start], head = 0;
    meta[startKey] = null;
    while (head < queue.length && queue.length < MAX_STATES) {
      var s = queue[head++], sk = s.join(',');
      var ms = movesFrom(cars, s);
      for (var j = 0; j < ms.length; j++) {
        var k = ms[j].pos.join(',');
        if (meta[k] !== undefined) continue;
        meta[k] = { pk: sk, i: ms[j].i, p: ms[j].p };
        if (isGoal(cars, ms[j].pos)) return firstStep(meta, k, startKey);
        queue.push(ms[j].pos);
      }
    }
    return null;
  }
  /* Vom Ziel zurück zum Start laufen und den ersten Zug zurückgeben. */
  function firstStep(meta, key, startKey) {
    var rec = meta[key], guard = 0;
    while (rec && rec.pk !== startKey && guard++ < 500) rec = meta[rec.pk];
    return rec ? { i: rec.i, p: rec.p } : null;
  }

  /* ================= Punkte ================= */
  function parOf(pz) { return Math.round(pz.m * 1.6) + 4; }
  /* hints = Tipps für DIESES Rätsel: sie werden von der Belohnung abgezogen
     (nicht vom Gesamt-Punktestand — sonst wären Tipps bei 0 Punkten gratis). */
  function scoreFor(pz, moves, sec, hints) {
    var base = 240 + pz.m * 30;
    var zug = Math.max(0, parOf(pz) - moves) * 14;
    var tempo = Math.max(0, Math.round(base - sec * 7));
    var malus = (hints || 0) * HINT_COST;
    return { base: base, zug: zug, tempo: tempo, malus: malus, total: Math.max(0, base + zug + tempo - malus) };
  }
  /* Fortschritt = wie weit das rote Auto Richtung Ausgang gekommen ist. */
  function progOf(cars) {
    var c = cars[0], maxP = N - c.len;
    if (maxP <= c.p0) return 100;
    return Math.max(0, Math.min(100, (c.p - c.p0) / (maxP - c.p0) * 100));
  }

  /* ================= Rangliste (Multi: Spieler, Solo: Bots + du) ================= */
  function makeRankList() {
    var listEl = el('div', { class: 'ubk-list' });
    var nodes = {};
    function build() {
      var rank = el('span', { class: 'ubk-rank' }, ['1']);
      var name = el('span', { class: 'ubk-nm' }, ['—']);
      var score = el('span', { class: 'ubk-sc' }, ['0']);
      var sub = el('span', { class: 'ubk-sub' }, ['Rätsel 1']);
      var fill = el('i', { class: 'ubk-fill' });
      var bar = el('div', { class: 'ubk-bar' }, [fill]);
      var rootEl = el('div', { class: 'ubk-row' }, [
        rank,
        el('div', { class: 'ubk-rowmain' }, [el('div', { class: 'ubk-rowtop' }, [name, score]), bar]),
        sub
      ]);
      return { root: rootEl, rank: rank, name: name, score: score, sub: sub, fill: fill };
    }
    function update(rows) {
      rows = rows.slice().sort(function (a, b) { return (b.score || 0) - (a.score || 0); });
      var seen = {};
      rows.forEach(function (r, i) {
        seen[r.id] = true;
        var nd = nodes[r.id];
        if (!nd) { nd = build(); nodes[r.id] = nd; listEl.appendChild(nd.root); }
        nd.root.style.order = String(i);
        nd.root.className = 'ubk-row p' + (i + 1) + (r.me ? ' me' : '');
        nd.rank.textContent = String(i + 1);
        nd.name.textContent = r.name + (r.me ? ' (du)' : '');
        nd.score.textContent = App.MG.fmt(r.score || 0);
        nd.sub.textContent = 'Rätsel ' + (r.puzzle || 1);
        nd.fill.style.width = Math.max(2, Math.min(100, r.prog || 0)) + '%';
      });
      Object.keys(nodes).forEach(function (id) {
        if (!seen[id]) { if (nodes[id].root.parentNode) listEl.removeChild(nodes[id].root); delete nodes[id]; }
      });
    }
    return { root: listEl, update: update };
  }

  /* ================= Solo-Bots ================= */
  /* Drei Stufen als Messlatte (Werte durchsimuliert über eine 4-Minuten-Runde):
     Sammy ~3.700 (schlägt man gemütlich), Hilde ~7.400 (braucht ordentliches
     Tempo), Tayo ~11.000 (nur mit wenigen Zügen + Tempo zu knacken). */
  var BOT_DEFS = [
    { id: 'bot_s', name: 'Stau-Sammy 🤖', skill: 0.8 },
    { id: 'bot_h', name: 'Hupe-Hilde 🤖', skill: 1.25 },
    { id: 'bot_t', name: 'Turbo-Tayo 🤖', skill: 1.8 }
  ];
  function makeBots(seed) {
    return BOT_DEFS.map(function (d, i) {
      var rand = rng(hash32(seed, 700 + i));
      var b = { id: d.id, name: d.name, skill: d.skill, rand: rand, idx: 0, t0: 0, score: 0, prog: 0 };
      b.dur = botDur(b, seed, 0);
      return b;
    });
  }
  /* Grundzeit nach Mindestzugzahl, geteilt durch die Stärke, plus Streuung. */
  function botDur(bot, seed, idx) {
    var pz = puzzleAt(seed, idx);
    return Math.max(7, (12 + pz.m * 2.5) / bot.skill * (0.8 + bot.rand() * 0.45));
  }
  function botTick(bot, seed, elapsed) {
    var guard = 0;
    while (elapsed >= bot.t0 + bot.dur && guard++ < 40) {
      var pz = puzzleAt(seed, bot.idx);
      var moves = Math.max(pz.m, Math.round(pz.m * (1.55 - 0.3 * bot.skill) * (0.9 + bot.rand() * 0.24)));
      bot.score += scoreFor(pz, moves, bot.dur, 0).total;   // Bots nutzen keine Tipps
      bot.t0 += bot.dur;
      bot.idx++;
      bot.dur = botDur(bot, seed, bot.idx);
    }
    var f = Math.max(0, Math.min(1, (elapsed - bot.t0) / bot.dur));
    bot.prog = Math.min(96, Math.pow(f, 0.8) * 100);   // zäher Start, Durchbruch am Schluss
  }

  /* ================= Registrierung ================= */
  App.Minigames.unblock = {
    id: 'unblock', title: 'Schiebe-Block', icon: '🚗', order: 160,
    subtitle: 'Schieb das rote Auto aus dem Stau',
    single: true, multi: true, minPlayers: 2, maxPlayers: 8,

    render: function (root, ctx) {
      var isMulti = ctx.mode === 'multi';
      var nowFn = isMulti ? ctx.room.now : function () { return Date.now(); };

      var dead = false;
      var stops = [];                 // stop()-Funktionen (App.MG, Listener, room.off)
      var pending = [];               // laufende setTimeout-IDs

      /* Laufender Zustand */
      var score = 0, solved = 0, hintsUsed = 0, hintsOnPuzzle = 0, puzzleIdx = 0, moves = 0, finished = false;
      var cars = [], pz = null, puzzleStartAt = 0, busy = false, lastReport = 0;
      var selected = -1, bots = [];

      /* DOM-Referenzen */
      var scoreEl, timerEl, puzEl, moveEl, boardEl, boardBox, rank = null, hintBtn, statusEl;
      var carEls = [];

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
        if (ctx.room.isHost()) { try { ctx.room.setShared({ ubkSeed: seedFromStart(startAt) }); } catch (e) {} }
        stops.push(App.MG.countdown(root, startAt, function () { play(startAt); }, ctx.room.now));
      } else {
        play(nowFn());
      }
      return { cleanup: cleanup };

      /* Seed der Runde: bevorzugt der vom Host geteilte Wert. */
      function seedOf(startAt) {
        if (isMulti) {
          var sh = (ctx.room.snapshot() || {}).shared || {};
          if (typeof sh.ubkSeed === 'number') return sh.ubkSeed >>> 0;
        }
        return seedFromStart(startAt);
      }

      /* ===================== SPIEL ===================== */
      function play(startAt) {
        clearPending(); stopHelpers();
        score = 0; solved = 0; hintsUsed = 0; hintsOnPuzzle = 0; puzzleIdx = 0; moves = 0;
        finished = false; busy = false; lastReport = 0; selected = -1;
        var seed = seedOf(startAt);
        var endAt = startAt + DURATION * 1000;
        bots = isMulti ? [] : makeBots(seed);

        /* --- Kopfzeile --- */
        scoreEl = el('div', { class: 'ubk-v ubk-v-gold' }, ['0']);
        puzEl = el('div', { class: 'ubk-v' }, ['1']);
        moveEl = el('div', { class: 'ubk-v ubk-v-aqua' }, ['0']);
        timerEl = el('div', { class: 'mg-timer' }, [App.MG.mmss(DURATION)]);
        var head = el('div', { class: 'ubk-head glass' }, [
          el('div', { class: 'ubk-cell' }, [el('span', { class: 'ubk-l' }, ['Punkte']), scoreEl]),
          el('div', { class: 'ubk-cell' }, [el('span', { class: 'ubk-l' }, ['Rätsel']), puzEl]),
          el('div', { class: 'ubk-cell' }, [el('span', { class: 'ubk-l' }, ['Züge']), moveEl]),
          el('div', { class: 'ubk-cell ubk-cell-t' }, [el('span', { class: 'ubk-l' }, ['Zeit']), timerEl])
        ]);

        var rules = el('p', { class: 'hint-text ubk-rules' }, [
          '🚗 Zieh die Blöcke aus dem Weg – das rote Auto muss rechts raus · Jeder Block fährt nur in seiner Richtung · '
          + 'Ein Zug = einmal ziehen (egal wie weit) · Wenige Züge + Tempo geben Extra-Punkte'
        ]);

        /* --- Brett --- */
        boardEl = el('div', { class: 'ubk-board' }, [
          el('div', { class: 'ubk-lane' }),
          el('div', { class: 'ubk-gate' })
        ]);
        boardBox = el('div', { class: 'ubk-boardbox glass' }, [boardEl]);

        /* --- Knöpfe --- */
        statusEl = el('div', { class: 'ubk-status' }, ['']);
        hintBtn = el('button', { class: 'btn btn-aqua ubk-btn', type: 'button', onclick: onHint }, ['💡 Tipp (−' + HINT_COST + ')']);
        var resetBtn = el('button', { class: 'btn btn-ghost ubk-btn', type: 'button', onclick: onReset }, ['🔄 Neu']);
        var buttons = el('div', { class: 'controls-row ubk-buttons' }, [hintBtn, resetBtn]);

        /* --- Rangliste --- */
        rank = makeRankList();
        var listWrap = el('div', { class: 'ubk-listwrap glass' }, [
          el('div', { class: 'mg-field-title' }, [isMulti ? '🏆 Rangliste' : '🤖 Bots & du']), rank.root
        ]);

        var best = isMulti ? 0 : (App.Storage.get('best_unblock', 0) || 0);
        var bestLine = isMulti ? null : el('div', { class: 'ubk-best' }, ['🥇 Dein Rekord: ' + App.MG.fmt(best)]);

        root.innerHTML = '';
        root.appendChild(el('div', { class: 'ubk-wrap' }, [head, rules, boardBox, statusEl, buttons, bestLine, listWrap]));

        bindInput();
        loadPuzzle(seed, 0);
        refreshRank();

        /* --- Rundentimer (Wall-Clock, Tab-sicher) --- */
        var tnf = isMulti ? ctx.room.now : null;
        stops.push(App.MG.roundTimer(endAt, function (left) {
          timerEl.textContent = App.MG.mmss(left);
          if (left <= 15) timerEl.classList.add('ubk-urgent');
          if (!isMulti) {
            var elapsed = (nowFn() - startAt) / 1000;
            bots.forEach(function (b) { botTick(b, seed, elapsed); });
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

        /* Beim Größenwechsel (Drehen des Tablets) die Blöcke neu setzen. */
        var onResize = function () { if (!dead) paint(false); };
        window.addEventListener('resize', onResize);
        window.addEventListener('orientationchange', onResize);
        stops.push(function () {
          window.removeEventListener('resize', onResize);
          window.removeEventListener('orientationchange', onResize);
        });

        /* ---------- Rätsel aufbauen ---------- */
        function loadPuzzle(sd, idx) {
          pz = puzzleAt(sd, idx);
          cars = carsOf(pz);
          moves = 0; hintsOnPuzzle = 0; selected = -1; busy = false;
          puzzleStartAt = nowFn();
          carEls = [];
          /* alte Blöcke raus, Deko (Lane + Gate) bleibt stehen */
          var old = boardEl.querySelectorAll('.ubk-car');
          for (var q = 0; q < old.length; q++) boardEl.removeChild(old[q]);
          boardEl.classList.remove('ubk-done');
          boardBox.classList.remove('ubk-win');

          cars.forEach(function (c, i) {
            var face = el('span', { class: 'ubk-face' }, [
              el('span', { class: 'ubk-emoji' }, [i === 0 ? '🚗' : (c.len === 3 ? '🚚' : '🚙')])
            ]);
            var cls = 'ubk-car ' + (c.d === 0 ? 'ubk-h' : 'ubk-v')
              + (i === 0 ? ' ubk-red' : ' ubk-c' + (i % 5));
            var node = el('div', { class: cls, dataset: { i: String(i) } }, [face]);
            node.style.width = (c.d === 0 ? (c.len / N) * 100 : (1 / N) * 100) + '%';
            node.style.height = (c.d === 0 ? (1 / N) * 100 : (c.len / N) * 100) + '%';
            carEls.push(node);
            boardEl.appendChild(node);
          });
          puzEl.textContent = String(idx + 1);
          moveEl.textContent = '0';
          setStatus('Stufe ' + Math.min(idx + 1, TIERS.length) + ' · optimal in ' + pz.m + ' Zügen');
          paint(false);
        }

        /* ---------- Blöcke positionieren ---------- */
        function cellPx() { return boardEl.clientWidth / N; }
        function paint(animate) {
          var cell = cellPx();
          cars.forEach(function (c, i) {
            var node = carEls[i];
            if (!node || node.classList.contains('ubk-dragging')) return;
            if (!animate) node.classList.add('ubk-nofx');
            var x = c.d === 0 ? c.p : c.fixed;
            var y = c.d === 0 ? c.fixed : c.p;
            node.style.transform = 'translate(' + (x * cell) + 'px,' + (y * cell) + 'px)';
            if (!animate) { void node.offsetWidth; node.classList.remove('ubk-nofx'); }
          });
        }
        function setStatus(t) { if (statusEl) statusEl.textContent = t; }

        /* ---------- Eingabe: Ziehen (Maus + Touch) ---------- */
        function bindInput() {
          var dragI = -1, dragId = null, startX = 0, startY = 0, startP = 0, lo = 0, hi = 0, movedPx = 0;

          function carIdxFrom(e) {
            var node = e.target;
            while (node && node !== boardEl && !(node.classList && node.classList.contains('ubk-car'))) node = node.parentNode;
            if (!node || node === boardEl || !node.dataset) return -1;
            var i = parseInt(node.dataset.i, 10);
            return isNaN(i) ? -1 : i;
          }
          function onDown(e) {
            if (dead || finished || busy || dragId !== null) return;
            var i = carIdxFrom(e);
            if (i < 0) { clearSel(); return; }
            if (e.preventDefault) e.preventDefault();
            dragI = i; dragId = e.pointerId;
            startX = e.clientX; startY = e.clientY; startP = cars[i].p; movedPx = 0;
            var r = rangeOf(cars, i); lo = r[0]; hi = r[1];
            carEls[i].classList.add('ubk-dragging');
            clearHint();
            if (App.Audio) App.Audio.blip(210, 0.04);
            try { carEls[i].setPointerCapture(e.pointerId); } catch (err) {}
          }
          function onMove(e) {
            if (dragId === null || e.pointerId !== dragId || dead) return;
            if (e.preventDefault) e.preventDefault();
            var c = cars[dragI], cell = cellPx();
            var raw = c.d === 0 ? (e.clientX - startX) : (e.clientY - startY);
            movedPx = Math.max(Math.abs(e.clientX - startX), Math.abs(e.clientY - startY));
            var off = Math.max((lo - startP) * cell, Math.min((hi - startP) * cell, raw));
            var live = startP * cell + off;
            var x = c.d === 0 ? live : c.fixed * cell;
            var y = c.d === 0 ? c.fixed * cell : live;
            carEls[dragI].style.transform = 'translate(' + x + 'px,' + y + 'px)';
          }
          function onUp(e) {
            if (dragId === null || e.pointerId !== dragId) return;
            dragId = null;
            var i = dragI; dragI = -1;
            if (dead || !carEls[i]) return;
            carEls[i].classList.remove('ubk-dragging');
            try { carEls[i].releasePointerCapture(e.pointerId); } catch (err) {}
            if (finished || busy) { paint(true); return; }

            var c = cars[i], cell = cellPx();
            var raw = c.d === 0 ? (e.clientX - startX) : (e.clientY - startY);
            /* Kurzes Tippen ohne Ziehen -> Block nur auswählen (für die Pfeiltasten). */
            if (movedPx < TAP_SLOP) { paint(true); selectCar(i); return; }
            var target = Math.max(lo, Math.min(hi, startP + Math.round(raw / cell)));
            if (target === startP) { paint(true); if (lo === hi) nudge(i); return; }
            applyMove(i, target);
          }
          function onCancel(e) {
            if (dragId === null || (e && e.pointerId !== dragId)) return;
            dragId = null;
            if (dragI >= 0 && carEls[dragI]) carEls[dragI].classList.remove('ubk-dragging');
            dragI = -1;
            paint(true);
          }
          boardEl.addEventListener('pointerdown', onDown);
          boardEl.addEventListener('pointermove', onMove);
          boardEl.addEventListener('pointerup', onUp);
          boardEl.addEventListener('pointercancel', onCancel);
          stops.push(function () {
            boardEl.removeEventListener('pointerdown', onDown);
            boardEl.removeEventListener('pointermove', onMove);
            boardEl.removeEventListener('pointerup', onUp);
            boardEl.removeEventListener('pointercancel', onCancel);
          });

          /* Tastatur: gewählter Block (sonst das rote Auto) um ein Feld. */
          function onKey(e) {
            if (dead || finished || busy) return;
            var k = e.key, dir = 0, axis = -1;
            if (k === 'ArrowRight' || k === 'd' || k === 'D') { dir = 1; axis = 0; }
            else if (k === 'ArrowLeft' || k === 'a' || k === 'A') { dir = -1; axis = 0; }
            else if (k === 'ArrowDown' || k === 's' || k === 'S') { dir = 1; axis = 1; }
            else if (k === 'ArrowUp' || k === 'w' || k === 'W') { dir = -1; axis = 1; }
            else return;
            e.preventDefault();
            var i = selected >= 0 ? selected : 0;
            var c = cars[i];
            if (c.d !== axis) { nudge(i); return; }        // falsche Achse für diesen Block
            var r = rangeOf(cars, i), t = c.p + dir;
            if (t < r[0] || t > r[1]) { nudge(i); return; }
            applyMove(i, t);
          }
          document.addEventListener('keydown', onKey);
          stops.push(function () { document.removeEventListener('keydown', onKey); });
        }

        /* ---------- Auswahl ---------- */
        function selectCar(i) {
          clearSel();
          selected = i;
          if (carEls[i]) carEls[i].classList.add('ubk-sel');
          if (App.Audio) App.Audio.sfx('click');
        }
        function clearSel() {
          if (selected >= 0 && carEls[selected]) carEls[selected].classList.remove('ubk-sel');
          selected = -1;
        }
        function nudge(i) {
          var node = carEls[i];
          if (!node) return;
          node.classList.remove('ubk-shake'); void node.offsetWidth; node.classList.add('ubk-shake');
          if (App.Audio) App.Audio.blip(140, 0.05);
        }

        /* ---------- Zug ausführen ---------- */
        function applyMove(i, target) {
          if (dead || finished || busy) return;
          var dist = Math.abs(target - cars[i].p);
          cars[i].p = target;
          moves++;
          moveEl.textContent = String(moves);
          clearHint();
          paint(true);
          if (App.Audio) App.Audio.blip(250 + Math.min(4, dist) * 45, 0.05);
          if (isSolved(cars)) return onSolved();
          reportProgress(false);
        }

        /* ---------- Rätsel gelöst ---------- */
        function onSolved() {
          busy = true;
          solved++;
          clearSel();
          var sec = Math.max(0, (nowFn() - puzzleStartAt) / 1000);
          var pts = scoreFor(pz, moves, sec, hintsOnPuzzle);
          score += pts.total;
          scoreEl.textContent = App.MG.fmt(score);
          scoreEl.classList.remove('ubk-bump'); void scoreEl.offsetWidth; scoreEl.classList.add('ubk-bump');
          boardBox.classList.add('ubk-win');
          boardEl.classList.add('ubk-done');
          /* rotes Auto fährt raus */
          var red = carEls[0];
          if (red) {
            red.classList.add('ubk-escape');
            red.style.transform = 'translate(' + (N * (boardEl.clientWidth / N) + 26) + 'px,' + (cars[0].fixed * (boardEl.clientWidth / N)) + 'px)';
          }
          if (App.Audio) App.Audio.sfx(pz.m >= 18 ? 'jackpot' : 'levelup');
          setStatus('🎉 Frei! in ' + moves + ' Zügen (optimal: ' + pz.m + ')');
          popup(pts, sec);
          if (isMulti) { ctx.room.reportScore(score); reportProgress(true); }
          refreshRank();
          after(1300, function () {
            if (finished || dead) return;
            puzzleIdx++;
            loadPuzzle(seed, puzzleIdx);
            reportProgress(true);
            refreshRank();
            if (App.Audio) App.Audio.sfx('whoosh');
          });
        }

        /* Kurze Punkte-Aufschlüsselung über dem Brett. */
        function popup(pts, sec) {
          var box = el('div', { class: 'ubk-pop' }, [
            el('div', { class: 'ubk-pop-big' }, ['+' + App.MG.fmt(pts.total)]),
            el('div', { class: 'ubk-pop-sub' }, [
              'Basis ' + pts.base + ' · Züge +' + pts.zug + ' (' + moves + '/' + parOf(pz) + ') · Tempo +' + pts.tempo + ' (' + sec.toFixed(1) + 's)'
                + (pts.malus ? ' · Tipps −' + pts.malus : '')
            ])
          ]);
          boardBox.appendChild(box);
          after(1500, function () { if (box.parentNode) box.parentNode.removeChild(box); });
        }

        /* ---------- Tipp ---------- */
        function onHint() {
          if (dead || finished || busy) return;
          var mv = hintMove(cars);
          if (!mv) { if (App.Audio) App.Audio.sfx('error'); setStatus('Kein Tipp gefunden – probier es selbst!'); return; }
          hintsUsed++; hintsOnPuzzle++;
          if (App.Audio) App.Audio.sfx('info');
          clearHint();
          var c = cars[mv.i], node = carEls[mv.i];
          /* Geometrische Pfeile (◀▶▲▼) statt Emoji-Pfeilen: die rendern überall
             gleich und bleiben auch als kleines Abzeichen scharf. */
          var arrow = c.d === 0 ? (mv.p > c.p ? '▶' : '◀') : (mv.p > c.p ? '▼' : '▲');
          if (node) {
            node.classList.add('ubk-hint');
            node.appendChild(el('span', { class: 'ubk-arrow' }, [arrow]));
          }
          setStatus('💡 Tipp: diesen Block ' + dirWord(c.d, mv.p > c.p) + ' schieben · '
            + hintsOnPuzzle + ' Tipp' + (hintsOnPuzzle === 1 ? '' : 's') + ' = −' + (hintsOnPuzzle * HINT_COST) + ' auf die Belohnung');
          after(2600, clearHint);
        }
        function dirWord(d, fwd) {
          if (d === 0) return fwd ? 'nach rechts' : 'nach links';
          return fwd ? 'nach unten' : 'nach oben';
        }
        function clearHint() {
          if (!boardEl) return;
          var hs = boardEl.querySelectorAll('.ubk-hint');
          for (var i = 0; i < hs.length; i++) {
            hs[i].classList.remove('ubk-hint');
            var a = hs[i].querySelector('.ubk-arrow');
            if (a && a.parentNode) a.parentNode.removeChild(a);
          }
        }

        /* ---------- Rätsel zurücksetzen ---------- */
        function onReset() {
          if (dead || finished || busy) return;
          if (App.Audio) App.Audio.sfx('whoosh');
          cars.forEach(function (c) { c.p = c.p0; });
          moves = 0;
          moveEl.textContent = '0';
          puzzleStartAt = nowFn();
          /* hintsOnPuzzle bleibt absichtlich stehen: sonst könnte man sich die
             Lösung ertippen, zurücksetzen und die Tipps wären umsonst. */
          clearSel(); clearHint();
          paint(true);
          setStatus('Zurückgesetzt · optimal in ' + pz.m + ' Zügen');
          reportProgress(true);
          refreshRank();
        }

        /* ---------- Fortschritt melden (gedrosselt) ---------- */
        function reportProgress(force) {
          if (!isMulti || dead) return;
          var t = Date.now();
          if (!force && t - lastReport < 1200) return;
          lastReport = t;
          try { ctx.room.reportState({ p: puzzleIdx + 1, prog: progOf(cars) }); } catch (e) {}
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
              id: 'me', name: (ctx.me && ctx.me.name) ? ctx.me.name : 'Du', score: score, me: true,
              puzzle: puzzleIdx + 1, prog: cars.length ? progOf(cars) : 0
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
          var best = App.Storage.get('best_unblock', 0) || 0;
          var nb = score > best;
          if (nb) App.Storage.set('best_unblock', score);
          var beaten = bots.filter(function (b) { return b.score < score; }).length;
          App.MG.endScreen(root, {
            score: score, best: best, newBest: nb,
            label: solved + ' Rätsel gelöst · ' + beaten + '/' + bots.length + ' Bots geschlagen'
              + (hintsUsed ? ' · ' + hintsUsed + ' Tipps' : '')
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
    UI.injectStyle('mg-unblock-css', [
      '.ubk-wrap{display:flex;flex-direction:column;gap:10px;}',
      /* Kopfzeile */
      '.ubk-head{display:flex;justify-content:space-between;align-items:center;padding:10px 16px;gap:10px;flex-wrap:wrap;}',
      '.ubk-cell{display:flex;flex-direction:column;gap:1px;min-width:0;}',
      '.ubk-cell-t{text-align:right;margin-left:auto;}',
      '.ubk-l{color:var(--muted);font-size:10px;text-transform:uppercase;letter-spacing:1px;}',
      '.ubk-v{font-size:clamp(18px,4.6vw,28px);font-weight:900;line-height:1.05;color:var(--leaf);font-variant-numeric:tabular-nums;}',
      '.ubk-v-gold{color:var(--gold);text-shadow:0 0 12px rgba(255,210,63,.45);}',
      '.ubk-v-aqua{color:var(--aqua);}',
      '.ubk-head .mg-timer{font-size:clamp(17px,4.4vw,24px);}',
      '.mg-timer.ubk-urgent{color:var(--danger);animation:ubk-pulse .7s infinite;}',
      '.ubk-bump{animation:ubk-bump .34s ease;}',
      '.ubk-rules{margin:0;text-align:center;font-size:12px;}',
      '.ubk-best{text-align:center;font-size:12px;font-weight:800;color:var(--gold);opacity:.9;}',
      '.ubk-status{text-align:center;font-size:12px;font-weight:700;color:var(--aqua-soft);min-height:16px;}',
      '.ubk-buttons{justify-content:center;gap:10px;}',
      '.ubk-btn{padding:8px 16px;font-size:13px;}',
      /* Brett */
      '.ubk-boardbox{position:relative;padding:10px 14px 10px 10px;margin:0 auto;width:100%;',
      'max-width:min(392px,88vw,52vh);border-radius:20px;transition:box-shadow .25s,border-color .25s;}',
      '.ubk-boardbox.ubk-win{box-shadow:0 0 34px rgba(57,255,20,.5),inset 0 0 40px rgba(57,255,20,.12);border-color:var(--stroke-2);}',
      '.ubk-board{position:relative;width:100%;aspect-ratio:1/1;border-radius:14px;border:1px solid var(--stroke);',
      'background-color:rgba(4,18,11,.96);',
      'background-image:linear-gradient(rgba(157,255,122,.09) 1px,transparent 1px),linear-gradient(90deg,rgba(157,255,122,.09) 1px,transparent 1px);',
      'background-size:calc(100% / 6) calc(100% / 6);',
      'touch-action:none;user-select:none;-webkit-user-select:none;-webkit-tap-highlight-color:transparent;}',
      '.ubk-board.ubk-done{animation:ubk-done .5s ease;}',
      /* Ausgangs-Spur + Tor */
      '.ubk-lane{position:absolute;left:0;right:0;top:33.3333%;height:16.6667%;pointer-events:none;',
      'background:linear-gradient(90deg,rgba(255,77,109,0),rgba(255,77,109,.16));border-radius:0 12px 12px 0;}',
      '.ubk-gate{position:absolute;right:-5px;top:33.3333%;height:16.6667%;width:6px;border-radius:4px;pointer-events:none;',
      'background:linear-gradient(180deg,var(--neon),var(--leaf));box-shadow:0 0 14px var(--neon);animation:ubk-gate 1.7s ease-in-out infinite;}',
      '.ubk-gate::after{content:"▶";position:absolute;left:8px;top:50%;transform:translateY(-50%);',
      'color:var(--neon);font-size:11px;text-shadow:0 0 8px var(--neon);}',
      /* Blöcke */
      '.ubk-car{position:absolute;top:0;left:0;will-change:transform;cursor:grab;touch-action:none;z-index:2;',
      'transition:transform .13s cubic-bezier(.25,.9,.3,1);}',
      '.ubk-car.ubk-nofx{transition:none;}',
      '.ubk-car.ubk-dragging{transition:none;cursor:grabbing;z-index:5;}',
      '.ubk-car.ubk-dragging .ubk-face{filter:brightness(1.22);box-shadow:0 8px 20px rgba(0,0,0,.55);}',
      '.ubk-face{position:absolute;inset:3px;border-radius:9px;display:flex;align-items:center;justify-content:center;',
      'border:1px solid var(--stroke);box-shadow:inset 0 1px 0 rgba(255,255,255,.14),0 3px 8px rgba(0,0,0,.45);',
      'transition:filter .15s,box-shadow .15s;overflow:hidden;}',
      '.ubk-emoji{font-size:clamp(13px,3.4vw,19px);opacity:.75;filter:drop-shadow(0 1px 2px rgba(0,0,0,.5));}',
      '.ubk-v .ubk-emoji,.ubk-car.ubk-v .ubk-emoji{transform:rotate(90deg);}',
      /* Farben der Blöcke */
      '.ubk-red .ubk-face{background:linear-gradient(180deg,#ff5f7a,#a8102e);border-color:#ffd9df;',
      'box-shadow:0 0 20px rgba(255,77,109,.55),inset 0 1px 0 rgba(255,255,255,.3),0 3px 8px rgba(0,0,0,.5);}',
      '.ubk-red .ubk-emoji{opacity:1;font-size:clamp(15px,3.9vw,22px);}',
      '.ubk-c0 .ubk-face{background:linear-gradient(180deg,rgba(20,74,45,.98),rgba(8,32,20,.98));}',
      '.ubk-c1 .ubk-face{background:linear-gradient(180deg,rgba(12,66,74,.98),rgba(5,28,32,.98));border-color:rgba(51,230,208,.3);}',
      '.ubk-c2 .ubk-face{background:linear-gradient(180deg,rgba(76,62,16,.98),rgba(32,26,6,.98));border-color:rgba(255,210,63,.28);}',
      '.ubk-c3 .ubk-face{background:linear-gradient(180deg,rgba(44,56,68,.98),rgba(16,22,28,.98));border-color:rgba(198,208,220,.24);}',
      '.ubk-c4 .ubk-face{background:linear-gradient(180deg,rgba(74,48,22,.98),rgba(30,19,8,.98));border-color:rgba(205,127,50,.3);}',
      /* Auswahl / Tipp / Ausfahrt */
      '.ubk-car.ubk-sel .ubk-face{border-color:var(--aqua);box-shadow:0 0 16px rgba(51,230,208,.5),inset 0 0 12px rgba(51,230,208,.2);}',
      '.ubk-car.ubk-hint .ubk-face{border-color:var(--gold);animation:ubk-hint 1s ease-in-out infinite;}',
      /* Beim Tipp weicht das Auto-Emoji dem Pfeil — sonst liegen beide mittig übereinander. */
      '.ubk-car.ubk-hint .ubk-emoji{opacity:0;}',
      '.ubk-emoji{transition:opacity .15s ease;}',
      '.ubk-arrow{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);z-index:3;',
      'display:flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:50%;',
      'font-size:12px;line-height:1;color:var(--gold);background:rgba(4,18,11,.9);border:1px solid var(--gold);',
      'box-shadow:0 0 10px rgba(255,210,63,.7);animation:ubk-arrow 1s ease-in-out infinite;}',
      '.ubk-car.ubk-escape{transition:transform .5s cubic-bezier(.4,0,.7,1),opacity .5s ease .25s;opacity:0;z-index:6;}',
      '.ubk-car.ubk-shake{animation:ubk-shake .26s ease;}',
      /* Punkte-Einblendung */
      '.ubk-pop{position:absolute;left:50%;top:14%;transform:translateX(-50%);z-index:8;pointer-events:none;text-align:center;',
      'padding:9px 15px;border-radius:14px;background:rgba(4,18,11,.94);border:1px solid var(--stroke-2);',
      'box-shadow:0 0 26px rgba(57,255,20,.35);animation:ubk-pop 1.5s ease forwards;white-space:nowrap;max-width:96%;}',
      '.ubk-pop-big{font-size:clamp(20px,5vw,28px);font-weight:900;color:var(--gold);text-shadow:0 0 14px rgba(255,210,63,.5);line-height:1.1;}',
      '.ubk-pop-sub{font-size:10px;color:var(--leaf);opacity:.9;overflow:hidden;text-overflow:ellipsis;}',
      /* Rangliste */
      '.ubk-listwrap{padding:12px 14px;display:flex;flex-direction:column;gap:8px;}',
      '.ubk-list{display:flex;flex-direction:column;gap:6px;max-height:280px;overflow-y:auto;}',
      '.ubk-row{display:flex;align-items:center;gap:9px;padding:7px 10px;border-radius:11px;',
      'background:rgba(6,24,14,.7);border:1px solid var(--stroke);}',
      '.ubk-row.me{border-color:var(--stroke-2);background:rgba(12,44,26,.8);}',
      '.ubk-row.p1 .ubk-rank{color:var(--gold);}',
      '.ubk-row.p2 .ubk-rank{color:var(--silver);}',
      '.ubk-row.p3 .ubk-rank{color:var(--bronze);}',
      '.ubk-rank{font-weight:900;font-size:13px;min-width:14px;text-align:center;color:var(--muted);}',
      '.ubk-rowmain{flex:1;min-width:0;display:flex;flex-direction:column;gap:4px;}',
      '.ubk-rowtop{display:flex;justify-content:space-between;gap:8px;align-items:baseline;}',
      '.ubk-nm{font-weight:700;font-size:12px;color:var(--leaf);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.ubk-sc{font-weight:900;font-size:13px;color:var(--gold);font-variant-numeric:tabular-nums;}',
      '.ubk-bar{height:4px;border-radius:3px;background:rgba(255,255,255,.08);overflow:hidden;}',
      '.ubk-fill{display:block;height:100%;border-radius:3px;background:linear-gradient(90deg,var(--leaf),var(--neon));transition:width .3s ease;}',
      '.ubk-sub{font-size:10px;color:var(--muted);white-space:nowrap;}',
      /* Animationen */
      '@keyframes ubk-pulse{0%,100%{opacity:1}50%{opacity:.4}}',
      '@keyframes ubk-bump{0%{transform:scale(1)}40%{transform:scale(1.2)}100%{transform:scale(1)}}',
      '@keyframes ubk-shake{0%,100%{filter:none}25%{filter:brightness(1.5)}50%{filter:none}75%{filter:brightness(1.5)}}',
      '@keyframes ubk-gate{0%,100%{opacity:.55;box-shadow:0 0 8px var(--neon);}50%{opacity:1;box-shadow:0 0 18px var(--neon);}}',
      '@keyframes ubk-hint{0%,100%{box-shadow:0 0 8px rgba(255,210,63,.4);}50%{box-shadow:0 0 22px rgba(255,210,63,.85);}}',
      '@keyframes ubk-arrow{0%,100%{transform:translate(-50%,-50%) scale(1);}50%{transform:translate(-50%,-50%) scale(1.28);}}',
      '@keyframes ubk-done{0%{filter:brightness(1)}35%{filter:brightness(1.5)}100%{filter:brightness(1)}}',
      '@keyframes ubk-pop{0%{opacity:0;transform:translateX(-50%) translateY(8px) scale(.9);}',
      '18%{opacity:1;transform:translateX(-50%) translateY(0) scale(1);}',
      '78%{opacity:1;transform:translateX(-50%) translateY(0) scale(1);}',
      '100%{opacity:0;transform:translateX(-50%) translateY(-10px) scale(.96);}}'
    ].join(''));
  }
})();
