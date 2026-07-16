/* spleef.js — "Spleef": Eis-Arena über dem Abgrund im Neon-Dschungel.
 *
 * SPIELIDEE : Alle stehen auf einer 15×15-Eisplattform über dem Nichts (leichte 2.5D-Draufsicht).
 *             Wer läuft, lässt die Kachel unter sich anknacksen — kurz darauf bricht sie weg und
 *             hinterlässt ein Loch. Zusätzlich kann man die nächste Eiskachel in Blickrichtung
 *             wegschießen (❄-Bolzen, 1,5 s Abklingzeit) und so den Boden unter den Gegnern
 *             verschwinden lassen. Wer in ein Loch fällt, ist raus (Sturz-Animation).
 *             Stehenbleiben ist sicher — darum frisst sich ab Sekunde 60 die Arena von außen
 *             nach innen weg (Sudden Death). Letzter Überlebender holt die Runde.
 *             Best of 3 (2 Siege reichen sofort), bei Gleichstand folgt eine Entscheidungsrunde.
 * STEUERUNG : WASD / Pfeiltasten = laufen, LEERTASTE = schießen. Am Handy: Joystick + ❄-Knopf.
 *             Die anvisierte Kachel wird markiert, sobald der Schuss bereit ist.
 * PUNKTE    : Multiplayer = Rundensiege (room.reportScore → Live-Rangliste + Podest).
 *             Solo = Rundensiege ×500 + Ausschaltungen ×150 + Matchsieg ×900, mal Stufen-
 *             Multiplikator; Bestwert in App.Storage ('best_spleef').
 * SOLO      : gegen 3 Bots (Leicht / Mittel / Schwer). Sie bewerten mehrere Laufrichtungen auf
 *             Löcher und knackende Kacheln, ziehen auf sicheren, dichten Boden, bleiben auf
 *             heilem Eis stehen statt es selbst zu zerstören, weichen aus, wenn jemand auf sie
 *             zielt, und schießen dir die Kachel unter den Füßen weg.
 * SYNC      : Host-autoritativ. Der HOST rechnet die Simulation und schickt ~15×/s per
 *             room.setShared({t,ph,rd,at,st,ps,w,wn,rw,tg,tc,bo}): tg = Loch-Maske (225 Zeichen),
 *             tc = Liste der knackenden Kacheln — beide nur bei Änderung im Patch. Alle anderen
 *             melden nur ihre Eingabe per room.reportState({ax,ay,fx,fy,sh}) und interpolieren
 *             die Positionen (Dead-Reckoning + Lerp); die eigene Figur sagt der Gast lokal
 *             voraus und zieht sie weich zur Host-Wahrheit. Kachelzustände wachsen nur in eine
 *             Richtung (heil → knackt → Loch), darum ist das Anwenden der Patches idempotent
 *             und der Zerfall (crackAt + CRACK_MS) wird von Gästen mitgerechnet.
 *             Alle Zeiten laufen über room.now() (Server-Zeit) bzw. Date.now() im Solo.
 * cleanup() beendet rAF, Timeouts, Listener und meldet jeden room.on wieder ab. */
(function () {
  'use strict';
  window.App = window.App || {}; App.Minigames = App.Minigames || {};
  var UI = App.UI, el = UI.el;

  injectStyle();

  /* ---- Arena: feste virtuelle Koordinaten, das Canvas skaliert per CSS ----
     Weltkoordinaten sind Kacheln (0…15). Kachel (tx,ty) belegt [tx,tx+1)×[ty,ty+1).
     Gezeichnet wird mit TH < TW (leichte Stauchung) plus DEPTH als Blockdicke →
     die Seitenflächen sieht man nur dort, wo darunter ein Loch klafft. */
  var N = 15;                              // 15×15 Eiskacheln
  var TW = 42, TH = 36, DEPTH = 9;
  var W = 720, H = 640;
  var OX = Math.round((W - N * TW) / 2);
  var OY = Math.round((H - (N * TH + DEPTH)) / 2);
  var PR = 13;                             // Spieler-Radius in Bildschirm-px

  /* Balance-Faustregeln: Laufen ist der Preis, nicht die Belohnung — jede verlassene
     Kachel bricht weg. Bei SPEED frisst ein Dauerläufer ~2 Kacheln/s vom eigenen
     Boden, das Feld hat 225. Wer sinnlos rennt, ist zuerst ohne Eis. Stehen bleiben
     ist sicher — dagegen gibt es den Schuss (Kachel vorne weg) und ab 60 s den
     Sudden Death, der die Arena von außen zufrisst. */
  var SPEED = 2.2;                         // Kacheln/s (quer über die Arena ≈ 6,8 s)
  var CRACK_MS = 1200;                     // Laufspur: Knacksen → Wegbrechen
  /* Ein Treffer zersplittert die Kachel nicht sofort, sondern mit kurzer Lunte: sonst ist
     „danebenstellen und abdrücken“ ein garantierter Kill ohne jede Gegenwehr (gemessen:
     Runden waren nach 4 s vorbei, Sudden Death kam nie). 600 ms sind knapp genug, dass
     Unaufmerksame fallen, und lang genug, dass ein wacher Spieler wegkommt. */
  var SHOT_CRACK_MS = 600;
  var SHOT_CD = 1500;                      // Abklingzeit des Schusses
  var SHOT_RANGE = 7;                      // Kacheln Reichweite
  var BOLT_SPEED = 22;                     // Kacheln/s Fluggeschwindigkeit
  var FALL_MS = 850;                       // Dauer der Sturz-Animation
  var SD_DELAY = 60000, SD_STEP = 3000;    // Sudden Death: ab 60 s alle 3 s ein Ring
  var RINGS = Math.ceil(N / 2);            // 8 Ringe (0 = außen, 7 = Mittelkachel)
  var MAX_ROUNDS = 3, WINS_NEEDED = 2;     // Best of 3
  var COUNT_MS = 2600, COUNT1_MS = 1600, ROUNDEND_MS = 2600;
  var NET_MS = 66, REPORT_MS = 66;         // Host-Broadcast / Eingabe-Meldung (~15/s)
  var SEP = 0.52;                          // ab hier schieben sich zwei Figuren sanft auseinander

  var COLORS = [
    { hex: '#39ff14', rgb: '57,255,20' },
    { hex: '#33e6d0', rgb: '51,230,208' },
    { hex: '#ffd23f', rgb: '255,210,63' },
    { hex: '#ff4d6d', rgb: '255,77,109' },
    { hex: '#b57cff', rgb: '181,124,255' },
    { hex: '#ff9d3c', rgb: '255,157,60' }
  ];
  var BOT_NAMES = ['Frosti', 'Liane', 'Kokos', 'Mango', 'Bambus'];

  /* Bot-Stufen: think = Reaktionstakt (ms), jitter = Zielfehler (rad), shoot = Schussfreude,
     hunt = Chance pro Denktakt, eine Jagd zu starten, safeIq = wie stark dichter Boden gesucht
     wird, dodge = Ausweichen, wenn jemand zielt, wander = sinnloses Herumlaufen (frisst eigenen
     Boden → macht die Stufe schlagbar), noise = Zufall in der Laufrichtung. */
  var DIFFS = [
    { id: 'easy', name: 'Leicht', icon: '🌱', mult: 1, think: 240, jitter: 0.36, shoot: 0.5,
      hunt: 0.05, safeIq: 0.6, dodge: 0.15, wander: 0.12, noise: 26, desc: 'Gemütliche Gegner zum Warmlaufen' },
    { id: 'mid', name: 'Mittel', icon: '🌿', mult: 1.6, think: 150, jitter: 0.16, shoot: 0.85,
      hunt: 0.1, safeIq: 1, dodge: 0.5, wander: 0.03, noise: 14, desc: 'Sie pirschen sich an und zielen' },
    { id: 'hard', name: 'Schwer', icon: '🔥', mult: 2.4, think: 95, jitter: 0.05, shoot: 0.98,
      hunt: 0.16, safeIq: 1.3, dodge: 0.9, wander: 0, noise: 6, desc: 'Gnadenlos: sie schießen dir den Boden weg' }
  ];

  var TOUCH = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);

  function len(x, y) { return Math.sqrt(x * x + y * y); }
  function r2(v) { return Math.round(v * 100) / 100; }
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  /* deterministischer Pseudo-Zufall pro Kachel → Risse sehen überall gleich aus */
  function noise(i, k) { var s = Math.sin(i * 12.9898 + k * 78.233) * 43758.5453; return s - Math.floor(s); }
  function ringOf(tx, ty) { return Math.min(tx, ty, N - 1 - tx, N - 1 - ty); }

  App.Minigames.spleef = {
    id: 'spleef', title: 'Spleef', icon: '🧊', order: 123,
    subtitle: 'Schieß dem Gegner das Eis unter den Füßen weg',
    single: true, multi: true, minPlayers: 2, maxPlayers: 6,

    render: function (root, ctx) {
      var isMulti = ctx.mode === 'multi';
      var tnow = isMulti ? function () { return ctx.room.now(); } : function () { return Date.now(); };

      /* ---- Laufzeit ---- */
      var dead = false, raf = null, last = 0, ended = false;
      var stops = [], listeners = [], pending = [];
      var g = null, refs = null;

      /* ---- Arena: tst 0 = heil, 1 = knackt, 2 = Loch ---- */
      var tst = [], tcr = [], town = [];

      /* ---- Spielzustand ---- */
      var P = [], byId = {};
      var phase = 'count', phaseAt = 0, roundIdx = 1, playStart = 0;
      var roundWinner = null, matchWinner = null, wins = {};
      var sdDone = 0;                       // vom Sudden Death bereits gefressene Ringe
      var diff = DIFFS[1];

      /* ---- Eingabe ---- */
      var keys = { u: false, d: false, l: false, r: false };
      var joy = { on: false, x: 0, y: 0, id: -1 };
      var shotSeq = 0, lastSh = {};

      /* ---- Netz ---- */
      var lastReport = 0, lastBroadcast = 0, reportedScore = -1, wasHost = false;
      var lastTg = null, lastTc = null, lastSharedT = -1;
      var netBolt = null, lastBoltSeen = 0;
      var predX = 0, predY = 0, predOk = false;

      /* ---- Effekte / Cues ---- */
      var bolts = [], parts = [], shards = [], spores = [];
      var cueFall = {}, cueRound = 0, cueCount = -1, cueSd = false;
      var lastBreakSfx = 0, soloElims = 0, headSig = '', tagSig = '';

      buildSpores();
      resetTiles();

      /* ================= Aufräumen ================= */
      function addL(t, ty, fn, opts) { t.addEventListener(ty, fn, opts); listeners.push({ t: t, ty: ty, fn: fn, opts: opts }); }
      function dropL() { listeners.forEach(function (l) { try { l.t.removeEventListener(l.ty, l.fn, l.opts); } catch (e) {} }); listeners = []; }
      function after(ms, fn) { var t = setTimeout(function () { if (!dead) fn(); }, ms); pending.push(t); return t; }
      function cleanup() {
        dead = true; ended = true;
        if (raf) { cancelAnimationFrame(raf); raf = null; }
        pending.forEach(clearTimeout); pending = [];
        stops.forEach(function (f) { try { f(); } catch (e) {} }); stops = [];
        dropL();
      }

      /* ================= Einstieg ================= */
      if (isMulti) startMulti(); else showDiff();
      return { cleanup: cleanup };

      /* ================= SOLO ================= */
      function showDiff() {
        stopLoop();
        var best = App.Storage.get('best_spleef', 0);
        var btns = DIFFS.map(function (d) {
          return el('button', { class: 'spl-diff btn' + (d.id === diff.id ? ' is-on' : ''), type: 'button', onclick: function () {
            if (App.Audio) App.Audio.sfx('select');
            diff = d; startSolo();
          } }, [
            el('span', { class: 'spl-diff-ico' }, [d.icon]),
            el('span', { class: 'spl-diff-nm' }, [d.name]),
            el('span', { class: 'spl-diff-ds' }, [d.desc]),
            el('span', { class: 'spl-diff-x' }, ['×' + d.mult + ' Punkte'])
          ]);
        });
        root.innerHTML = '';
        root.appendChild(el('div', { class: 'glass spl-intro' }, [
          el('div', { class: 'spl-intro-ico' }, ['🧊']),
          el('h2', { class: 'neon' }, ['Spleef']),
          el('p', { class: 'hint-text' }, ['Du gegen 3 Bots auf dem Eis über dem Abgrund. Hinter dir bricht der Boden weg, mit ❄ schießt du Kacheln raus. Wer fällt, ist raus — Best of 3.']),
          el('div', { class: 'mg-field-title' }, ['Schwierigkeit wählen']),
          el('div', { class: 'spl-diffs' }, btns),
          el('p', { class: 'hint-text' }, ['🏆 Dein Bestwert: ' + App.MG.fmt(best) + ' Punkte'])
        ]));
      }

      function startSolo() {
        stopLoop();
        ended = false; soloElims = 0; wins = {}; matchWinner = null; roundWinner = null;
        parts = []; shards = []; bolts = []; cueFall = {}; cueRound = 0; cueCount = -1;
        buildStage();
        P = []; byId = {};
        addPlayer(ctx.me.id, (ctx.me && ctx.me.name) ? ctx.me.name : 'Du', 0, false);
        var pool = BOT_NAMES.slice();
        for (var i = 0; i < 3; i++) {
          var nm = pool.splice(Math.floor(Math.random() * pool.length), 1)[0];
          addPlayer('bot' + i, nm + ' 🤖', i + 1, true);
        }
        P.forEach(function (p) { wins[p.id] = 0; });
        initRound(1, Date.now());
        startLoop();
      }

      /* ================= MULTI ================= */
      function startMulti() {
        var proceeded = false;
        function maybe() {
          if (proceeded || dead) return;
          var ps = ctx.room.players();
          if (ps.length >= 2) {
            proceeded = true;
            var snap = ctx.room.snapshot() || {};
            var startAt = (snap.round && snap.round.startAt) || (ctx.room.now() + 3000);
            stops.push(App.MG.countdown(root, startAt, function () { playMulti(startAt); }, ctx.room.now));
          } else showWaiting();
        }
        var ph = function () { maybe(); };
        ctx.room.on('players', ph);
        stops.push(function () { ctx.room.off('players', ph); });
        maybe();
      }

      function playMulti(startAt) {
        stopLoop();
        ended = false; parts = []; shards = []; bolts = [];
        cueFall = {}; cueRound = 0; cueCount = -1; cueSd = false;
        wins = {}; matchWinner = null; roundWinner = null;
        lastTg = null; lastTc = null; lastSharedT = -1;
        P = []; byId = {};
        buildStage();
        ctx.room.players().forEach(function (pl, i) { addPlayer(pl.id, pl.name, i, false); wins[pl.id] = 0; });

        var sh = function (s) { applyShared(s); };
        ctx.room.on('shared', sh);
        stops.push(function () { ctx.room.off('shared', sh); });
        var pl2 = function () { refreshNames(); };
        ctx.room.on('players', pl2);
        stops.push(function () { ctx.room.off('players', pl2); });

        wasHost = !!ctx.room.isHost();
        if (wasHost) { initRound(1, startAt); broadcast(ctx.room.now(), true); }
        else {
          var s0 = ctx.room.snapshot();
          initRound(1, startAt);
          if (s0 && s0.shared) applyShared(s0.shared);
        }
        ctx.room.reportScore(0);
        startLoop();
      }

      /* Namen/Farben nachziehen, ohne die Ansicht neu zu bauen (Events feuern oft!) */
      function refreshNames() {
        if (!isMulti || dead) return;
        ctx.room.players().forEach(function (pl, i) {
          var p = byId[pl.id];
          if (p) { p.name = pl.name; p.ci = i % COLORS.length; p.color = COLORS[p.ci]; }
        });
        tagSig = '';
      }
      function nameOf(id, idx) {
        if (!isMulti) return 'Spieler';
        var ps = ctx.room.players();
        for (var i = 0; i < ps.length; i++) if (ps[i].id === id) return ps[i].name;
        return 'Spieler ' + (idx + 1);
      }
      function colorIdxOf(id, idx) {
        if (!isMulti) return idx % COLORS.length;
        var ps = ctx.room.players();
        for (var i = 0; i < ps.length; i++) if (ps[i].id === id) return i % COLORS.length;
        return idx % COLORS.length;
      }

      /* ================= Kacheln ================= */
      function resetTiles() {
        tst = []; tcr = []; town = [];
        for (var i = 0; i < N * N; i++) { tst.push(0); tcr.push(0); town.push(null); }
      }
      function tileIndexAt(x, y) {
        var tx = Math.floor(x), ty = Math.floor(y);
        if (tx < 0 || ty < 0 || tx >= N || ty >= N) return -1;
        return ty * N + tx;
      }
      function crackTile(i, owner, t) {
        if (i < 0 || tst[i] !== 0) return;
        tst[i] = 1; tcr[i] = t; town[i] = owner;
        if (App.Audio && t - lastBreakSfx > 110) { lastBreakSfx = t; App.Audio.blip(190 + Math.random() * 60, 0.04, { type: 'square', peak: 0.03 }); }
      }
      function breakTile(i, owner, t) {
        if (i < 0 || tst[i] === 2) return;
        tst[i] = 2;
        if (owner) town[i] = owner;
        var tx = i % N, ty = Math.floor(i / N);
        shards.push({ x: OX + tx * TW, y: OY + ty * TH, t0: t, life: 780, rot: (Math.random() - 0.5) * 2.2 });
        for (var k = 0; k < 4; k++) {
          var a = Math.random() * Math.PI * 2;
          parts.push({ x: OX + (tx + 0.5) * TW, y: OY + (ty + 0.5) * TH, vx: Math.cos(a) * 70,
            vy: Math.sin(a) * 40 + 40, t0: t, life: 380 + Math.random() * 220, c: '127,243,230', r: 2 });
        }
        if (App.Audio && t - lastBreakSfx > 80) { lastBreakSfx = t; App.Audio.blip(320 + Math.random() * 120, 0.06, { type: 'triangle', peak: 0.05 }); }
      }
      /* Treffer zersplittert nicht sofort, sondern zündet eine kurze Lunte (SHOT_CRACK_MS):
         die Kachel knackt und bricht erst SHOT_CRACK_MS nach dem Einschlag weg. Umgesetzt
         über einen zurückdatierten Riss-Zeitstempel, damit collapseDue (tcr + CRACK_MS) sie
         genau dann wegbrechen lässt — deterministisch bei Host UND Gast. So kann ein wacher
         Spieler noch wegkommen, statt beim Danebenstellen chancenlos zu fallen. */
      function shotCrack(i, owner, t) {
        if (i < 0 || tst[i] === 2) return;
        var stamp = t - (CRACK_MS - SHOT_CRACK_MS);
        if (tst[i] === 0) { tst[i] = 1; tcr[i] = stamp; town[i] = owner; }
        else if (tst[i] === 1 && stamp < tcr[i]) { tcr[i] = stamp; town[i] = owner; }  // schon rissig → Lunte verkürzen
        if (App.Audio && t - lastBreakSfx > 80) { lastBreakSfx = t; App.Audio.blip(300 + Math.random() * 90, 0.05, { type: 'triangle', peak: 0.05 }); }
      }
      /* Zerfall ist rein zeitgesteuert → Host UND Gast rechnen ihn gleich aus. */
      function collapseDue(t) {
        for (var i = 0; i < tst.length; i++) if (tst[i] === 1 && t - tcr[i] >= CRACK_MS) breakTile(i, town[i], t);
      }
      /* erste noch vorhandene Kachel in Blickrichtung (die eigene wird übersprungen) */
      function rayHit(x, y, ux, uy) {
        var own = tileIndexAt(x, y), d = 0.14;
        while (d <= SHOT_RANGE) {
          var i = tileIndexAt(x + ux * d, y + uy * d);
          if (i >= 0 && i !== own && tst[i] !== 2) return { i: i, d: d };
          d += 0.12;
        }
        return null;
      }
      /* heile/knackende Kacheln im 3×3 um eine Stelle → wie tragfähig ist der Boden dort? */
      function safeAround(x, y) {
        var tx = Math.floor(x), ty = Math.floor(y), n = 0;
        for (var dy = -1; dy <= 1; dy++) for (var dx = -1; dx <= 1; dx++) {
          var i = tileIndexAt(tx + dx + 0.5, ty + dy + 0.5);
          if (i >= 0 && tst[i] !== 2) n++;
        }
        return n;
      }
      /* Zeitpunkt, an dem Ring r vom Sudden Death gefressen wird (0 = nie/noch nicht bekannt) */
      function ringGoneAt(r) { return playStart ? playStart + SD_DELAY + r * SD_STEP : 0; }

      /* ================= Spieler ================= */
      function addPlayer(id, name, ci, bot) {
        var p = {
          id: id, name: name, ci: ci % COLORS.length, color: COLORS[ci % COLORS.length], bot: !!bot,
          x: N / 2, y: N / 2, dx: N / 2, dy: N / 2, nt: 0, ti: -1,
          ax: 0, ay: 0, fx: 0, fy: 1, alive: true, fallAt: 0, fallBy: null,
          cdUntil: 0, nextThink: 0, trail: [], mode: 'camp', modeUntil: 0
        };
        P.push(p); byId[id] = p;
        return p;
      }
      function me() { return byId[ctx.me.id] || null; }
      function hostMode() { return !isMulti || !!ctx.room.isHost(); }

      /* ================= Runden ================= */
      function initRound(n, t) {
        roundIdx = n;
        phase = 'count';
        phaseAt = t + (n === 1 ? COUNT1_MS : COUNT_MS);
        playStart = 0; roundWinner = null; sdDone = 0;
        cueFall = {}; cueCount = -1; cueSd = false;
        parts = []; shards = []; bolts = [];
        resetTiles();

        if (isMulti) {   // Aufstellung frisch aus dem Raum (Zu-/Abgänge berücksichtigen)
          P = []; byId = {};
          ctx.room.players().forEach(function (pl, i) {
            addPlayer(pl.id, pl.name, i, false);
            if (wins[pl.id] == null) wins[pl.id] = 0;
          });
        }
        var off = Math.random() * Math.PI * 2, rr = 5.1;
        P.forEach(function (p, i) {
          var a = off + i / P.length * Math.PI * 2;
          p.x = N / 2 + Math.cos(a) * rr; p.y = N / 2 + Math.sin(a) * rr;
          p.dx = p.x; p.dy = p.y; p.nt = t;
          p.ax = 0; p.ay = 0;
          p.fx = -Math.cos(a); p.fy = -Math.sin(a);
          p.alive = true; p.fallAt = 0; p.fallBy = null;
          p.cdUntil = 0; p.nextThink = 0; p.trail = [];
          p.mode = 'camp'; p.modeUntil = 0;
          p.ti = tileIndexAt(p.x, p.y);
        });
        predOk = false;
        lastSh = {};
        if (isMulti) ctx.room.players().forEach(function (pl) { lastSh[pl.id] = (pl.state && pl.state.sh) || 0; });
        headSig = ''; tagSig = '';
      }

      function standing() {
        var n = 0, w = null;
        for (var i = 0; i < P.length; i++) if (P[i].alive && !P[i].fallAt) { n++; w = P[i]; }
        return { n: n, last: w };
      }
      /* Führender + ob die Führung GETEILT ist — nie einfach den ersten Spieler krönen
         (das wäre im Multiplayer immer der Host). */
      function leader() {
        var bestId = null, bestV = -1, tied = false;
        for (var i = 0; i < P.length; i++) {
          var v = wins[P[i].id] || 0;
          if (v > bestV) { bestV = v; bestId = P[i].id; tied = false; }
          else if (v === bestV) tied = true;
        }
        return { id: bestId, v: bestV, tied: tied };
      }

      /* Host/Solo: Phasen weiterschalten */
      function hostPhases(t) {
        if (phase === 'count') {
          if (t >= phaseAt) { phase = 'play'; playStart = t; if (isMulti) broadcast(t, true); }
          return;
        }
        if (phase === 'play') {
          /* Sudden Death: Ring für Ring von außen nach innen */
          var want = playStart ? Math.floor((t - playStart - SD_DELAY) / SD_STEP) + 1 : 0;
          if (want > RINGS) want = RINGS;
          while (sdDone < want) { eatRing(sdDone, t); sdDone++; }
          var s = standing();
          if (s.n <= 1) {
            roundWinner = s.last ? s.last.id : null;
            if (roundWinner) wins[roundWinner] = (wins[roundWinner] || 0) + 1;
            phase = 'roundend'; phaseAt = t + ROUNDEND_MS;
            if (isMulti) broadcast(t, true);
          }
          return;
        }
        if (phase === 'roundend' && t >= phaseAt) {
          var ld = leader();
          if (roundIdx > MAX_ROUNDS) {
            /* Entscheidungsrunde: wer sie holt, holt das Match. */
            if (roundWinner) { matchWinner = roundWinner; phase = 'over'; }
            else if (roundIdx >= MAX_ROUNDS + 3) { matchWinner = 'draw'; phase = 'over'; }
            else initRound(roundIdx + 1, t);
          } else if (ld.v >= WINS_NEEDED || (roundIdx >= MAX_ROUNDS && !ld.tied && ld.v > 0)) {
            matchWinner = ld.id || 'draw'; phase = 'over';
          } else {
            /* Gleichstand nach Runde 3 → Entscheidungsrunde statt willkürlichem Sieger. */
            initRound(roundIdx + 1, t);
          }
          if (isMulti) broadcast(t, true);
        }
      }
      function eatRing(r, t) {
        for (var ty = 0; ty < N; ty++) for (var tx = 0; tx < N; tx++) {
          if (ringOf(tx, ty) === r) breakTile(ty * N + tx, null, t);
        }
        if (App.Audio) App.Audio.sweep(240, 90, 0.3, { type: 'sawtooth', peak: 0.07 });
      }

      /* ================= Simulation (nur Host/Solo) ================= */
      function stepAll(dt, t) {
        var n = Math.ceil(dt / 0.02); if (n < 1) n = 1; if (n > 3) n = 3;
        for (var i = 0; i < n; i++) physics(dt / n, t);
      }

      function physics(dt, t) {
        var i, j, p;
        for (i = 0; i < P.length; i++) {
          p = P[i];
          if (!p.alive || p.fallAt) continue;
          var m = len(p.ax, p.ay);
          if (m > 1) { p.ax /= m; p.ay /= m; m = 1; }
          if (m > 0.12) { p.fx = p.ax / m; p.fy = p.ay / m; }
          if (phase !== 'play') continue;
          if (m > 0.05) { p.x += p.ax * SPEED * dt; p.y += p.ay * SPEED * dt; }

          var ti = tileIndexAt(p.x, p.y);
          if (ti < 0 || tst[ti] === 2) {          // ins Loch / über die Kante
            p.fallAt = t; p.fallBy = (ti >= 0 ? town[ti] : null);
            continue;
          }
          if (ti !== p.ti) {                      // neue Kachel betreten → die alte knackt weg
            if (p.ti >= 0) crackTile(p.ti, p.id, t);
            p.ti = ti;
          }
        }
        /* sanftes Auseinanderschieben, damit niemand in einer Figur steckt */
        for (i = 0; i < P.length; i++) {
          var a = P[i]; if (!a.alive || a.fallAt) continue;
          for (j = i + 1; j < P.length; j++) {
            var b = P[j]; if (!b.alive || b.fallAt) continue;
            var dx = b.x - a.x, dy = b.y - a.y, d = len(dx, dy);
            if (d > 0.0001 && d < SEP) {
              var push = (SEP - d) * 0.5;
              dx /= d; dy /= d;
              a.x -= dx * push; a.y -= dy * push;
              b.x += dx * push; b.y += dy * push;
            }
          }
        }
        /* Kachel-Merker nach dem Schieben nachziehen — OHNE zu knacksen: geschubst
           werden ist keine eigene Bewegung. Sonst zerbröseln zwei aneinander hängende
           Figuren (oder eine, die gegen eine stehende drückt) den Boden unter den
           eigenen Füßen, obwohl niemand freiwillig einen Schritt gemacht hat. */
        for (i = 0; i < P.length; i++) {
          var q = P[i];
          if (q.alive && !q.fallAt) q.ti = tileIndexAt(q.x, q.y);
        }
      }

      function shoot(p, t) {
        if (!p.alive || p.fallAt || phase !== 'play' || t < p.cdUntil) return false;
        p.cdUntil = t + SHOT_CD;
        var h = rayHit(p.x, p.y, p.fx, p.fy);
        var d = h ? h.d : SHOT_RANGE;
        var bolt = { x: p.x, y: p.y, ux: p.fx, uy: p.fy, d: d, t0: t, ci: p.ci, i: h ? h.i : -1, owner: p.id, done: false };
        bolts.push(bolt);
        if (App.Audio) App.Audio.sweep(760, 260, 0.16, { type: 'sawtooth', peak: 0.07 });
        if (isMulti && hostMode()) {
          netBolt = { x: r2(p.x), y: r2(p.y), ux: r2(p.fx), uy: r2(p.fy), d: r2(d), c: p.ci, i: bolt.i, t: Math.round(t) };
        }
        return true;
      }
      /* Bolzen fliegen bei allen mit — der Einschlag ist deterministisch, der Host
         bestätigt das Loch anschließend per Loch-Maske. */
      function stepBolts(t) {
        var out = [];
        for (var i = 0; i < bolts.length; i++) {
          var b = bolts[i];
          var run = (t - b.t0) / 1000 * BOLT_SPEED;
          if (run >= b.d) {
            if (!b.done) {
              b.done = true;
              if (b.i >= 0) {
                shotCrack(b.i, b.owner, t);
                var hx = OX + (b.x + b.ux * b.d) * TW, hy = OY + (b.y + b.uy * b.d) * TH;
                for (var k = 0; k < 9; k++) {
                  var a = Math.random() * Math.PI * 2, sp = 70 + Math.random() * 190;
                  parts.push({ x: hx, y: hy, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp * 0.7, t0: t,
                    life: 280 + Math.random() * 240, c: '234,255,224', r: 2 + Math.random() * 2 });
                }
              }
            }
            if (run > b.d + 0.5) continue;
          }
          out.push(b);
        }
        bolts = out;
      }

      /* ================= Bot-KI ================= */
      function nearestOpp(b, opps) {
        var best = null, bd = Infinity;
        for (var i = 0; i < opps.length; i++) {
          var d = len(opps[i].x - b.x, opps[i].y - b.y);
          if (d < bd) { bd = d; best = opps[i]; }
        }
        return best;
      }
      function aimHits(b, ux, uy, opps) {
        var h = rayHit(b.x, b.y, ux, uy);
        if (!h) return false;
        for (var i = 0; i < opps.length; i++) if (tileIndexAt(opps[i].x, opps[i].y) === h.i) return true;
        return false;
      }
      /* zielt gerade jemand mit geladenem Schuss auf meine Kachel? */
      function aimedAt(b, opps, t) {
        var my = tileIndexAt(b.x, b.y);
        for (var i = 0; i < opps.length; i++) {
          var o = opps[i];
          if (t < o.cdUntil) continue;
          var h = rayHit(o.x, o.y, o.fx, o.fy);
          if (h && h.i === my) return true;
        }
        return false;
      }
      /* Bewertet eine Laufrichtung: Löcher und knackendes Eis sind tabu, dichter Boden
         lockt, lure zieht zum Jagdziel. Wichtig ist die Vorschau — der Bot prüft, wo er
         in 0,25/0,5/0,9/1,3 s steht, nicht nur die Nachbarkachel. */
      function dirScore(b, dx, dy, t, lure) {
        var sc = 0, k;
        var probes = [0.55, 1.1, 1.9, 2.8], wgt = [700, 260, 90, 35];
        for (k = 0; k < probes.length; k++) {
          var ti = tileIndexAt(b.x + dx * probes[k], b.y + dy * probes[k]);
          if (ti < 0 || tst[ti] === 2) { sc -= wgt[k]; continue; }
          if (tst[ti] === 1) {
            var leftMs = tcr[ti] + CRACK_MS - t;
            var needMs = probes[k] / SPEED * 1000;
            sc -= (leftMs < needMs + 300) ? wgt[k] * 0.85 : wgt[k] * 0.2;
          } else sc += wgt[k] * 0.06;
          var ga = ringGoneAt(ringOf(ti % N, Math.floor(ti / N)));
          if (ga && ga - t < 5000) sc -= wgt[k] * 0.55;   // dieser Ring bricht gleich weg
        }
        sc += safeAround(b.x + dx * 1.9, b.y + dy * 1.9) * 8 * diff.safeIq;
        sc += (dx * b.fx + dy * b.fy) * 14;               // Trägheit → kein Zittern
        if (lure) {
          var lx = lure.x - b.x, ly = lure.y - b.y, ld = len(lx, ly) || 1;
          sc += ((dx * lx + dy * ly) / ld) * 46;
        }
        sc += (Math.random() * 2 - 1) * diff.noise;
        return sc;
      }
      function bestDir(b, t, lure) {
        var bestSc = -Infinity, bx = 0, by = 0;
        for (var i = 0; i < 12; i++) {
          var a = i / 12 * Math.PI * 2, cx = Math.cos(a), cy = Math.sin(a);
          var sc = dirScore(b, cx, cy, t, lure);
          if (sc > bestSc) { bestSc = sc; bx = cx; by = cy; }
        }
        return { x: bx, y: by, sc: bestSc };
      }
      function faceTo(b, o) {
        var dx = o.x - b.x, dy = o.y - b.y, d = len(dx, dy) || 1;
        b.fx = dx / d; b.fy = dy / d;
      }
      /* Die KI denkt in Absichten statt in Richtungen — sonst rennt sie sich in Sekunden
         den eigenen Boden weg (jede verlassene Kachel bricht ja weg):
           1 Schießen  2 Notfall (Eis knackt / Ring kommt)  3 Ausweichen
           4 Jagd (anpirschen bis auf Schussposition)       5 sonst: stehen, Eis schonen. */
      function botThink(b, t) {
        if (t < b.nextThink) return;
        b.nextThink = t + diff.think * (0.75 + Math.random() * 0.5);
        var i, opps = [];
        for (i = 0; i < P.length; i++) if (P[i] !== b && P[i].alive && !P[i].fallAt) opps.push(P[i]);
        var tgt = nearestOpp(b, opps);
        var ready = (t >= b.cdUntil) && phase === 'play';

        /* --- 1) Schuss: Blick trifft eine Gegner-Kachel → feuern, ohne zu laufen --- */
        if (ready && opps.length && Math.random() < diff.shoot) {
          if (aimHits(b, b.fx, b.fy, opps)) { b.ax = 0; b.ay = 0; shoot(b, t); b.mode = 'camp'; return; }
          for (i = 0; i < opps.length; i++) {
            var o = opps[i], dx = o.x - b.x, dy = o.y - b.y, d = len(dx, dy);
            if (d < 0.6 || d > SHOT_RANGE) continue;
            var ang = Math.atan2(dy, dx) + (Math.random() * 2 - 1) * diff.jitter;
            var ux = Math.cos(ang), uy = Math.sin(ang);
            if (aimHits(b, ux, uy, opps)) {          // hindrehen und feuern
              b.fx = ux; b.fy = uy; b.ax = 0; b.ay = 0;
              shoot(b, t); b.mode = 'camp'; return;
            }
          }
        }

        /* --- 2) Notfall: eigene Kachel knackt weg oder der Ring wird gleich gefressen --- */
        var myTile = tileIndexAt(b.x, b.y);
        var urgent = (myTile < 0) || (tst[myTile] === 1 && tcr[myTile] + CRACK_MS - t < 700);
        var myGone = myTile >= 0 ? ringGoneAt(ringOf(myTile % N, Math.floor(myTile / N))) : 0;
        if (myGone && myGone - t < 4500) urgent = true;
        if (urgent) {
          var e = bestDir(b, t, null);
          b.ax = e.x; b.ay = e.y;
          return;
        }

        /* --- 3) Jemand zielt geladen auf meine Kachel → weg hier --- */
        if (aimedAt(b, opps, t) && Math.random() < diff.dodge) {
          var dg = bestDir(b, t, null);
          b.ax = dg.x; b.ay = dg.y; b.mode = 'camp';
          return;
        }

        /* --- 4) Jagd: anpirschen, bis der Schuss die Gegner-Kachel trifft --- */
        if (b.mode === 'hunt' && (t > b.modeUntil || !tgt)) b.mode = 'camp';
        if (b.mode !== 'hunt' && tgt && ready && Math.random() < diff.hunt) {
          b.mode = 'hunt'; b.modeUntil = t + 2600 + Math.random() * 2200;
        }
        if (b.mode === 'hunt' && tgt) {
          var hd = bestDir(b, t, tgt);
          b.ax = hd.x; b.ay = hd.y;
          return;
        }

        /* --- 5) Stehen bleiben: heiles Eis ist bares Leben. Nur die leichten Bots
                 latschen aus Langeweile herum (und verlieren dadurch Boden). --- */
        if (Math.random() < diff.wander) {
          var w = bestDir(b, t, null);
          b.ax = w.x; b.ay = w.y;
          return;
        }
        b.ax = 0; b.ay = 0;
        if (tgt) faceTo(b, tgt);                    // im Stehen den Gegner anvisieren
      }

      /* ================= Netz ================= */
      function encGone() {
        var s = '';
        for (var i = 0; i < tst.length; i++) s += (tst[i] === 2 ? '#' : '.');
        return s;
      }
      function encCracks() {
        var a = [];
        for (var i = 0; i < tst.length; i++) if (tst[i] === 1) a.push(i + '@' + Math.round(tcr[i]));
        return a.join(',');
      }
      function broadcast(t, force) {
        if (!isMulti) return;
        if (!force && t - lastBroadcast < NET_MS) return;
        lastBroadcast = t;
        var ps = {}, i;
        for (i = 0; i < P.length; i++) {
          var p = P[i];
          ps[p.id] = { x: r2(p.x), y: r2(p.y), vx: r2(p.ax * SPEED), vy: r2(p.ay * SPEED),
            fx: r2(p.fx), fy: r2(p.fy), a: p.alive ? 1 : 0, f: Math.round(p.fallAt || 0), c: Math.round(p.cdUntil || 0) };
        }
        var patch = { t: Math.round(t), ph: phase, rd: roundIdx, at: Math.round(phaseAt),
          st: Math.round(playStart), ps: ps, w: wins, wn: matchWinner || null, rw: roundWinner || null };
        var tg = encGone(); if (force || tg !== lastTg) { patch.tg = tg; lastTg = tg; }
        var tc = encCracks(); if (force || tc !== lastTc) { patch.tc = tc; lastTc = tc; }
        if (netBolt) { patch.bo = netBolt; netBolt = null; }
        try { ctx.room.setShared(patch); } catch (e) {}
      }

      function applyShared(sh) {
        if (dead || !sh || !sh.ps) return;
        if (ctx.room.isHost()) return;                       // ich bin die Wahrheit
        var t = (typeof sh.t === 'number') ? sh.t : ctx.room.now();
        if (t <= lastSharedT) return;                        // Heartbeat wiederholt nur Altes
        lastSharedT = t;

        if (sh.rd && sh.rd !== roundIdx) {                   // neue Runde → Arena frisch
          roundIdx = sh.rd; resetTiles(); parts = []; shards = []; bolts = [];
          cueFall = {}; cueCount = -1; cueSd = false; predOk = false;
        }
        if (sh.ph) phase = sh.ph;
        if (typeof sh.at === 'number') phaseAt = sh.at;
        if (typeof sh.st === 'number') playStart = sh.st;
        if (sh.w) wins = sh.w;
        roundWinner = sh.rw || null;
        if (sh.wn) matchWinner = sh.wn;

        /* Kacheln kennen nur einen Weg: heil → knackt → Loch. Darum ist das
           Anwenden idempotent und die Reihenfolge der Patches egal. */
        if (typeof sh.tg === 'string' && sh.tg.length === tst.length) {
          for (var i = 0; i < tst.length; i++) if (sh.tg.charAt(i) === '#' && tst[i] !== 2) breakTile(i, null, t);
        }
        if (typeof sh.tc === 'string' && sh.tc) {
          var list = sh.tc.split(',');
          for (var k = 0; k < list.length; k++) {
            var pr = list[k].split('@'), ix = parseInt(pr[0], 10), at = parseInt(pr[1], 10);
            if (!isNaN(ix) && !isNaN(at) && ix >= 0 && ix < tst.length && tst[ix] === 0) { tst[ix] = 1; tcr[ix] = at; }
          }
        }

        var seen = {}, ids = Object.keys(sh.ps);
        ids.forEach(function (id, i2) {
          var d = sh.ps[id], p = byId[id];
          if (!p) { p = addPlayer(id, nameOf(id, i2), colorIdxOf(id, i2), false); p.x = d.x; p.y = d.y; p.dx = d.x; p.dy = d.y; }
          seen[id] = 1;
          p.x = d.x; p.y = d.y; p.vx = d.vx; p.vy = d.vy;
          p.alive = !!d.a; p.fallAt = d.f || 0; p.cdUntil = d.c || 0; p.nt = t;
          if (id !== ctx.me.id) { p.fx = d.fx; p.fy = d.fy; }   // eigenen Blick lokal behalten
        });
        var keep = [];
        for (var j = 0; j < P.length; j++) { if (seen[P[j].id]) keep.push(P[j]); else delete byId[P[j].id]; }
        P = keep;

        if (sh.bo && sh.bo.t && sh.bo.t !== lastBoltSeen) {
          lastBoltSeen = sh.bo.t;
          bolts.push({ x: sh.bo.x, y: sh.bo.y, ux: sh.bo.ux, uy: sh.bo.uy, d: sh.bo.d,
            t0: sh.bo.t, ci: sh.bo.c || 0, i: (typeof sh.bo.i === 'number' ? sh.bo.i : -1), owner: null, done: false });
          if (App.Audio) App.Audio.sweep(760, 260, 0.16, { type: 'sawtooth', peak: 0.06 });
        }
      }

      /* ================= Haupt-Loop ================= */
      function startLoop() { last = tnow(); if (!raf) raf = requestAnimationFrame(frame); }
      function stopLoop() { if (raf) { cancelAnimationFrame(raf); raf = null; } }

      function frame() {
        raf = null;
        if (dead || ended) return;
        var t = tnow();
        var dt = (t - last) / 1000; if (dt < 0) dt = 0; if (dt > 0.05) dt = 0.05; last = t;

        var host = hostMode();
        if (isMulti && host && !wasHost) { lastSh = {}; lastTg = null; lastTc = null; }  // gerade Host geworden
        wasHost = host;

        /* --- Eingabe --- */
        var inp = readInput();
        var mp = me();
        if (mp && !mp.bot && mp.alive && !mp.fallAt) {
          var im = len(inp.x, inp.y);
          if (im > 0.12) { mp.fx = inp.x / im; mp.fy = inp.y / im; }
          if (host) { mp.ax = inp.x; mp.ay = inp.y; }
        }
        if (isMulti && !host && t - lastReport >= REPORT_MS) {
          lastReport = t;
          try { ctx.room.reportState({ ax: r2(inp.x), ay: r2(inp.y), fx: r2(mp ? mp.fx : 0), fy: r2(mp ? mp.fy : 1), sh: shotSeq }); } catch (e) {}
        }

        if (host) {
          if (isMulti) {
            var map = {};
            ctx.room.players().forEach(function (pl) { map[pl.id] = pl; });
            for (var i = 0; i < P.length; i++) {
              var p = P[i];
              if (p.id === ctx.me.id) continue;
              var pl2 = map[p.id];
              if (!pl2) { if (p.alive && !p.fallAt) { p.alive = false; p.fallAt = t; } continue; }
              var s = pl2.state || {};
              p.ax = (typeof s.ax === 'number') ? s.ax : 0;
              p.ay = (typeof s.ay === 'number') ? s.ay : 0;
              if (typeof s.fx === 'number' && (s.fx || s.fy)) { p.fx = s.fx; p.fy = s.fy; }
              var sq = s.sh || 0;
              if (lastSh[p.id] == null) lastSh[p.id] = sq;
              else if (sq > lastSh[p.id]) { lastSh[p.id] = sq; shoot(p, t); }
            }
          } else {
            for (var b = 0; b < P.length; b++) if (P[b].bot && P[b].alive && !P[b].fallAt) botThink(P[b], t);
          }
          stepAll(dt, t);
          collapseDue(t);
          hostPhases(t);
          broadcast(t, false);
        } else {
          collapseDue(t);   // deterministischer Zerfall — der Host bestätigt ihn per Maske
        }

        stepBolts(t);

        /* --- Anzeige-Positionen --- */
        for (var k = 0; k < P.length; k++) {
          var q = P[k];
          if (host) { q.dx = q.x; q.dy = q.y; }
          else if (q.id === ctx.me.id && q.alive && !q.fallAt && phase === 'play') {
            /* Eigene Figur lokal vorhersagen → sofortige Rückmeldung, danach
               weich zur Host-Wahrheit ziehen (großer Versatz = harter Schnitt). */
            if (!predOk) { predX = q.x; predY = q.y; predOk = true; }
            predX += inp.x * SPEED * dt; predY += inp.y * SPEED * dt;
            var pf = 1 - Math.exp(-5 * dt);
            predX += (q.x - predX) * pf; predY += (q.y - predY) * pf;
            if (Math.abs(q.x - predX) > 1.6 || Math.abs(q.y - predY) > 1.6) { predX = q.x; predY = q.y; }
            q.dx = predX; q.dy = predY;
          } else {
            var e = (t - q.nt) / 1000; if (e < 0) e = 0; if (e > 0.3) e = 0.3;
            var tx = q.x + (q.vx || 0) * e, ty = q.y + (q.vy || 0) * e;
            if (Math.abs(tx - q.dx) > 3 || Math.abs(ty - q.dy) > 3) { q.dx = tx; q.dy = ty; }
            else { var f = 1 - Math.exp(-16 * dt); q.dx += (tx - q.dx) * f; q.dy += (ty - q.dy) * f; }
            if (q.id === ctx.me.id) predOk = false;
          }
          if (q.alive && !q.fallAt && phase === 'play' && (Math.abs(q.ax) + Math.abs(q.ay) > 0.1 || !host)) {
            q.trail.push({ x: q.dx, y: q.dy });
            if (q.trail.length > 8) q.trail.shift();
          } else if (q.trail.length) q.trail.shift();
        }

        cues(t);
        stepParts(t);
        draw(t);
        updateHead(t);
        updateTags();
        reportMine();

        if (phase === 'over' && matchWinner !== null) { finish(t); return; }
        raf = requestAnimationFrame(frame);
      }

      /* ================= Cues (Sound & Effekte — bei Host und Gast gleich) ================= */
      function cues(t) {
        var i, p;
        for (i = 0; i < P.length; i++) {
          p = P[i];
          if (p.fallAt && !cueFall[p.id]) {
            cueFall[p.id] = 1;
            if (App.Audio) App.Audio.sweep(520, 70, 0.65, { type: 'sine', peak: 0.1 });
            if (!isMulti && p.fallBy && p.fallBy === ctx.me.id && p.id !== ctx.me.id) soloElims++;
            for (var j = 0; j < 8; j++) {
              var a = Math.random() * Math.PI * 2;
              parts.push({ x: OX + p.dx * TW, y: OY + p.dy * TH, vx: Math.cos(a) * 80, vy: Math.sin(a) * 50 + 50,
                t0: t, life: 560, c: p.color.rgb, r: 2.5 });
            }
          }
        }
        if (phase === 'count') {
          var lft = Math.ceil((phaseAt - t) / 1000);
          if (lft !== cueCount && lft > 0 && lft <= 3) { cueCount = lft; if (App.Audio) App.Audio.sfx('tick'); }
          if (lft <= 0 && cueCount !== 0) { cueCount = 0; if (App.Audio) App.Audio.sfx('start'); }
        }
        if (phase === 'roundend' && cueRound !== roundIdx) {
          cueRound = roundIdx;
          if (App.Audio) App.Audio.sfx(roundWinner === ctx.me.id ? 'win' : 'ding');
        }
        if (!cueSd && playStart && phase === 'play' && t - playStart >= SD_DELAY) {
          cueSd = true;
          if (App.Audio) App.Audio.sfx('explosion');
        }
      }
      function stepParts(t) {
        var out = [], i;
        for (i = 0; i < parts.length; i++) if (t - parts[i].t0 < parts[i].life) out.push(parts[i]);
        parts = out;
        if (parts.length > 240) parts = parts.slice(parts.length - 240);
        var so = [];
        for (i = 0; i < shards.length; i++) if (t - shards[i].t0 < shards[i].life) so.push(shards[i]);
        shards = so;
        if (shards.length > 90) shards = shards.slice(shards.length - 90);
      }

      /* ================= Punkte melden ================= */
      function reportMine() {
        if (!isMulti) return;
        var v = wins[ctx.me.id] || 0;
        if (v !== reportedScore) { reportedScore = v; try { ctx.room.reportScore(v); } catch (e) {} }
      }

      /* ================= Ende ================= */
      function finish(t) {
        if (ended) return;
        ended = true;
        stopLoop();
        if (isMulti) {
          try { ctx.room.reportScore(wins[ctx.me.id] || 0); } catch (e) {}
          if (matchWinner === ctx.me.id && App.Scores) App.Scores.winCurrent();   // ended-Sperre → genau einmal
          after(1300, function () {
            App.MG.endScreen(root, { players: ctx.room.players(), meId: ctx.me.id, onExit: ctx.onExit,
              format: function (n) { return (n || 0) + (n === 1 ? ' Sieg' : ' Siege'); } });
          });
        } else {
          var myWins = wins[ctx.me.id] || 0;
          var iWon = matchWinner === ctx.me.id;
          var score = Math.round((myWins * 500 + soloElims * 150 + (iWon ? 900 : 0)) * diff.mult);
          var best = App.Storage.get('best_spleef', 0);
          var nb = score > best;
          if (nb) App.Storage.set('best_spleef', score);
          if (iWon && App.Scores) App.Scores.winCurrent();
          if (App.Audio) App.Audio.sfx(iWon ? 'win' : 'lose');
          after(1300, function () {
            App.MG.endScreen(root, {
              title: iWon ? '🏆 Eiskönig!' : (matchWinner === 'draw' ? '🤝 Unentschieden' : '🕳 Abgestürzt'),
              score: score, best: best, newBest: nb,
              label: 'Rundensiege: ' + myWins + ' · Ausschaltungen: ' + soloElims + ' · ' + diff.icon + ' ' + diff.name +
                     (nb ? ' · neuer Rekord! 🎉' : ' · Bestwert: ' + App.MG.fmt(best)),
              onExit: ctx.onExit,
              onAgain: function () { showDiff(); }
            });
          });
        }
      }

      /* ================= Eingabe ================= */
      function readInput() {
        var x = 0, y = 0;
        if (joy.on && (joy.x !== 0 || joy.y !== 0)) { x = joy.x; y = joy.y; }
        else {
          x = (keys.r ? 1 : 0) - (keys.l ? 1 : 0);
          y = (keys.d ? 1 : 0) - (keys.u ? 1 : 0);
        }
        var m = len(x, y);
        if (m > 1) { x /= m; y /= m; }
        return { x: x, y: y };
      }
      function tryShoot() {
        var t = tnow(), mp = me();
        if (!mp || phase !== 'play' || !mp.alive || mp.fallAt) return;
        if (t < mp.cdUntil) { if (App.Audio) App.Audio.blip(130, 0.05, { type: 'square', peak: 0.04 }); return; }
        if (hostMode()) shoot(mp, t);
        else {
          shotSeq++;
          mp.cdUntil = t + SHOT_CD;                     // lokale Rückmeldung, der Host korrigiert
          if (App.Audio) App.Audio.sweep(760, 260, 0.16, { type: 'sawtooth', peak: 0.07 });
          lastReport = t;
          try { ctx.room.reportState({ ax: r2(mp.ax), ay: r2(mp.ay), fx: r2(mp.fx), fy: r2(mp.fy), sh: shotSeq }); } catch (e) {}
        }
      }
      function bindKeys() {
        var down = function (e) {
          var k = e.key;
          if (k === 'ArrowUp' || k === 'w' || k === 'W') { keys.u = true; e.preventDefault(); }
          else if (k === 'ArrowDown' || k === 's' || k === 'S') { keys.d = true; e.preventDefault(); }
          else if (k === 'ArrowLeft' || k === 'a' || k === 'A') { keys.l = true; e.preventDefault(); }
          else if (k === 'ArrowRight' || k === 'd' || k === 'D') { keys.r = true; e.preventDefault(); }
          else if (e.code === 'Space' || k === ' ') { e.preventDefault(); if (!e.repeat) tryShoot(); }
        };
        var up = function (e) {
          var k = e.key;
          if (k === 'ArrowUp' || k === 'w' || k === 'W') keys.u = false;
          else if (k === 'ArrowDown' || k === 's' || k === 'S') keys.d = false;
          else if (k === 'ArrowLeft' || k === 'a' || k === 'A') keys.l = false;
          else if (k === 'ArrowRight' || k === 'd' || k === 'D') keys.r = false;
        };
        var blur = function () { keys.u = keys.d = keys.l = keys.r = false; };
        addL(document, 'keydown', down);
        addL(document, 'keyup', up);
        addL(window, 'blur', blur);
      }
      function bindStick(base, knob) {
        var R = 42;
        function set(e) {
          var r = base.getBoundingClientRect();
          var dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2);
          var sc = r.width / 120 || 1;                  // CSS-Größe → virtuelle Einheiten
          dx /= sc; dy /= sc;
          var m = len(dx, dy);
          if (m > R) { dx = dx / m * R; dy = dy / m * R; }
          joy.x = dx / R; joy.y = dy / R;
          knob.style.transform = 'translate(' + (dx * sc) + 'px,' + (dy * sc) + 'px)';
        }
        function end() {
          joy.on = false; joy.x = 0; joy.y = 0; joy.id = -1;
          knob.style.transform = 'translate(0px,0px)';
          base.classList.remove('is-on');
        }
        addL(base, 'pointerdown', function (e) {
          e.preventDefault(); joy.on = true; joy.id = e.pointerId;
          base.classList.add('is-on');
          try { base.setPointerCapture(e.pointerId); } catch (er) {}
          set(e);
        });
        addL(base, 'pointermove', function (e) { if (joy.on && e.pointerId === joy.id) { e.preventDefault(); set(e); } });
        addL(base, 'pointerup', function (e) { if (e.pointerId === joy.id) { e.preventDefault(); end(); } });
        addL(base, 'pointercancel', function () { end(); });
        addL(base, 'lostpointercapture', function () { end(); });
      }

      /* ================= UI ================= */
      function showWaiting() {
        root.innerHTML = '';
        root.appendChild(el('div', { class: 'glass spl-wait' }, [
          el('div', { class: 'spl-wait-ico' }, ['🧊']),
          el('h3', { class: 'neon' }, ['Spleef']),
          el('p', { class: 'hint-text' }, ['Warte auf Mitspieler … (2–6 Spieler)'])
        ]));
      }

      function buildStage() {
        var roundEl = el('div', { class: 'spl-round' }, ['Runde 1 / ' + MAX_ROUNDS]);
        var statusEl = el('div', { class: 'spl-status' }, ['Gleich geht\'s los']);
        var shotEl = el('div', { class: 'spl-chip' }, ['❄ Schuss']);
        var head = el('div', { class: 'spl-head glass' }, [roundEl, statusEl, shotEl]);

        var canvas = el('canvas', { class: 'spl-canvas', width: W, height: H });
        var stage = el('div', { class: 'spl-stage' }, [canvas]);
        var tags = el('div', { class: 'spl-tags' });
        var hint = el('p', { class: 'hint-text spl-hint' }, [
          TOUCH ? 'Joystick = laufen (das Eis bricht hinter dir weg) · ❄ = Kachel vorne wegschießen (1,5 s) · nicht runterfallen · Best of 3'
                : 'WASD / Pfeile = laufen (das Eis bricht hinter dir weg) · LEERTASTE = Kachel vorne wegschießen (1,5 s) · nicht runterfallen · Best of 3'
        ]);

        var pad = null, knob = null, stick = null, shotBtn = null, shotFill = null;
        if (TOUCH) {
          knob = el('div', { class: 'spl-knob' });
          stick = el('div', { class: 'spl-stick' }, [el('div', { class: 'spl-stick-ring' }), knob]);
          shotFill = el('div', { class: 'spl-shot-fill' });
          shotBtn = el('button', { class: 'spl-shot', type: 'button' }, [shotFill, el('span', { class: 'spl-shot-t' }, ['❄'])]);
          pad = el('div', { class: 'spl-pad' }, [stick, shotBtn]);
        }

        var boardWrap = null;
        if (isMulti) {
          var board = App.MG.liveBoard(ctx.room, ctx.me.id, { format: function (n) { return (n || 0) + ' ⭐'; } });
          stops.push(board.stop);
          boardWrap = el('div', { class: 'spl-board glass' }, [el('div', { class: 'mg-field-title' }, ['🏆 Rundensiege']), board.root]);
        }

        var wrap = el('div', { class: 'spl-wrap' }, [head, stage, tags, pad, hint, boardWrap]);
        root.innerHTML = ''; root.appendChild(wrap);

        refs = { canvas: canvas, roundEl: roundEl, statusEl: statusEl, shotEl: shotEl, tags: tags, shotBtn: shotBtn, shotFill: shotFill };
        g = canvas.getContext('2d');
        headSig = ''; tagSig = '';

        dropL();
        bindKeys();
        if (TOUCH) {
          bindStick(stick, knob);
          addL(shotBtn, 'pointerdown', function (e) { e.preventDefault(); tryShoot(); });
          addL(shotBtn, 'contextmenu', function (e) { e.preventDefault(); });
        }
        return refs;
      }

      function updateHead(t) {
        if (!refs) return;
        var mp = me(), s;
        if (phase === 'count') s = 'Bereit machen …';
        else if (phase === 'play') {
          var toSd = playStart ? (playStart + SD_DELAY - t) : SD_DELAY;
          if (toSd <= 0) s = '⚠ Sudden Death – die Arena bricht ein!';
          else if (toSd < 15000) s = 'Sudden Death in ' + Math.ceil(toSd / 1000) + ' s';
          else s = 'Lauf! Hinter dir bricht das Eis';
        } else if (phase === 'roundend') s = roundWinner ? ((byId[roundWinner] ? byId[roundWinner].name : 'Jemand') + ' holt die Runde') : 'Alle abgestürzt – unentschieden';
        else s = 'Match vorbei';
        var warn = (phase === 'play' && playStart && t - playStart >= SD_DELAY - 15000);

        var cd = (mp && t < mp.cdUntil) ? (mp.cdUntil - t) / 1000 : 0;
        var ctxt = (!mp || !mp.alive || mp.fallAt) ? '💀 Raus' : (cd > 0 ? '❄ ' + cd.toFixed(1) + ' s' : '❄ Schuss bereit');
        var sig = roundIdx + '|' + s + '|' + ctxt;
        if (sig !== headSig) {
          headSig = sig;
          refs.roundEl.textContent = roundIdx > MAX_ROUNDS ? '⚡ Entscheidung' : 'Runde ' + roundIdx + ' / ' + MAX_ROUNDS;
          refs.statusEl.textContent = s;
          refs.statusEl.className = 'spl-status' + (warn ? ' is-warn' : '');
          refs.shotEl.textContent = ctxt;
          refs.shotEl.className = 'spl-chip' + (cd <= 0 && mp && mp.alive && !mp.fallAt ? ' is-ready' : '');
        }
        if (refs.shotFill) {
          var pr = cd > 0 ? 1 - cd / (SHOT_CD / 1000) : 1;
          refs.shotFill.style.transform = 'scaleY(' + pr.toFixed(3) + ')';
          if (refs.shotBtn) refs.shotBtn.classList.toggle('is-ready', pr >= 1);
        }
      }

      function updateTags() {
        if (!refs) return;
        var sig = '', i;
        for (i = 0; i < P.length; i++) sig += P[i].id + ':' + (wins[P[i].id] || 0) + ':' + (P[i].alive && !P[i].fallAt ? '1' : '0') + '|';
        if (sig === tagSig) return;
        tagSig = sig;
        refs.tags.innerHTML = '';
        for (i = 0; i < P.length; i++) {
          var p = P[i], w = wins[p.id] || 0;
          refs.tags.appendChild(el('div', {
            class: 'spl-tag' + (p.alive && !p.fallAt ? '' : ' is-out') + (p.id === ctx.me.id ? ' is-me' : ''),
            style: '--tc:' + p.color.hex + ';--tg:rgba(' + p.color.rgb + ',.35)'
          }, [
            el('span', { class: 'spl-dot' }),
            el('span', { class: 'spl-tag-n' }, [p.name + (p.id === ctx.me.id && isMulti ? ' (du)' : '')]),
            el('span', { class: 'spl-tag-w' }, [w > 0 ? new Array(w + 1).join('⭐') : '–'])
          ]));
        }
      }

      /* ================= Zeichnen ================= */
      function buildSpores() {
        spores = [];
        for (var i = 0; i < 26; i++) {
          spores.push({ x: Math.random() * W, y: Math.random() * H, r: 1 + Math.random() * 2.2,
            sp: 6 + Math.random() * 16, ph: Math.random() * 6.28 });
        }
      }
      function rrect(x, y, w, h, r) {
        r = Math.min(r, w / 2, h / 2);
        g.beginPath();
        g.moveTo(x + r, y);
        g.arcTo(x + w, y, x + w, y + h, r);
        g.arcTo(x + w, y + h, x, y + h, r);
        g.arcTo(x, y + h, x, y, r);
        g.arcTo(x, y, x + w, y, r);
        g.closePath();
      }
      function circle(x, y, r) { g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); }

      function draw(t) {
        if (!g) return;
        var i;
        /* Abgrund + treibende Sporen */
        var bg = g.createRadialGradient(W / 2, H / 2, 40, W / 2, H / 2, W * 0.75);
        bg.addColorStop(0, '#062018'); bg.addColorStop(0.55, '#04120c'); bg.addColorStop(1, '#010604');
        g.fillStyle = bg; g.fillRect(0, 0, W, H);
        g.save();
        for (i = 0; i < spores.length; i++) {
          var sp = spores[i];
          var yy = (sp.y - (t / 1000 * sp.sp)) % H; if (yy < 0) yy += H;
          var xx = sp.x + Math.sin(t / 1400 + sp.ph) * 12;
          g.fillStyle = 'rgba(157,255,122,' + (0.05 + 0.08 * (0.5 + 0.5 * Math.sin(t / 800 + sp.ph))).toFixed(3) + ')';
          circle(xx, yy, sp.r); g.fill();
        }
        g.restore();

        /* Was in die Tiefe stürzt, liegt UNTER dem Eis → zuerst zeichnen, dann die Kacheln
           darüber: dadurch verschwinden Scherben und Spieler sauber im Loch. */
        drawShards(t);
        for (i = 0; i < P.length; i++) if (P[i].fallAt) drawPlayer(P[i], t);
        drawArena(t);
        drawParts(t);
        drawAim(t);
        drawBolts(t);
        var order = P.slice().sort(function (a, b) { return a.dy - b.dy; });
        for (i = 0; i < order.length; i++) if (!order[i].fallAt) drawPlayer(order[i], t);
        drawOverlay(t);
      }

      function drawArena(t) {
        var tx, ty, i;
        var sdOn = playStart && (t - playStart >= SD_DELAY - 1600);
        var nextRing = -1, nextAt = 0;
        if (sdOn) {
          nextRing = Math.min(RINGS - 1, Math.max(0, Math.floor((t - playStart - SD_DELAY) / SD_STEP) + 1));
          nextAt = ringGoneAt(nextRing);
        }
        for (ty = 0; ty < N; ty++) {
          for (tx = 0; tx < N; tx++) {
            i = ty * N + tx;
            if (tst[i] === 2) continue;
            var sx = OX + tx * TW, sy = OY + ty * TH;
            var prog = tst[i] === 1 ? clamp((t - tcr[i]) / CRACK_MS, 0, 1) : 0;
            var sink = prog * prog * 3;
            var warn = 0;
            if (sdOn && ringOf(tx, ty) === nextRing && nextAt > t && nextAt - t < 2600) {
              warn = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(t / 90));
            }
            /* Seitenfläche (sieht man nur an Kante/Loch — die nächste Reihe deckt sie sonst ab) */
            g.fillStyle = warn ? 'rgba(120,40,18,.95)' : (prog > 0.6 ? '#0d3a3a' : '#0a2c36');
            g.fillRect(sx, sy + TH - 1 + sink, TW, DEPTH);
            g.fillStyle = 'rgba(0,0,0,.35)';
            g.fillRect(sx, sy + TH - 1 + DEPTH + sink - 2, TW, 2);
            /* Oberseite */
            var grd = g.createLinearGradient(sx, sy + sink, sx, sy + TH + sink);
            if (warn) { grd.addColorStop(0, 'rgba(255,157,60,' + (0.55 + warn * 0.35) + ')'); grd.addColorStop(1, '#7a2a12'); }
            else if (prog > 0) {
              grd.addColorStop(0, 'rgba(' + Math.round(43 + prog * 90) + ',' + Math.round(111 - prog * 20) + ',' + Math.round(120 - prog * 40) + ',1)');
              grd.addColorStop(1, '#0f3640');
            } else { grd.addColorStop(0, '#2f7c88'); grd.addColorStop(1, '#124049'); }
            g.fillStyle = grd;
            rrect(sx + 0.5, sy + 0.5 + sink, TW - 1, TH - 1, 5); g.fill();
            /* Glanzkante oben */
            g.fillStyle = 'rgba(127,243,230,' + (prog > 0 ? 0.16 : 0.3) + ')';
            g.fillRect(sx + 3, sy + 2 + sink, TW - 6, 2);
            /* Rand */
            g.lineWidth = 1;
            g.strokeStyle = warn ? 'rgba(255,157,60,.9)' : 'rgba(51,230,208,' + (0.3 - prog * 0.12) + ')';
            rrect(sx + 0.5, sy + 0.5 + sink, TW - 1, TH - 1, 5); g.stroke();
            if (prog > 0) drawCracks(i, sx, sy + sink, prog);
          }
        }
      }
      /* Risse: pro Kachel fest ausgewürfelt, wachsen mit dem Fortschritt */
      function drawCracks(i, sx, sy, prog) {
        var cx = sx + TW / 2, cy = sy + TH / 2;
        var n = 3 + Math.floor(prog * 3);
        g.save();
        g.strokeStyle = 'rgba(234,255,240,' + (0.25 + prog * 0.6).toFixed(2) + ')';
        g.lineWidth = 1 + prog;
        g.lineCap = 'round';
        for (var k = 0; k < n; k++) {
          var a = noise(i, k) * Math.PI * 2;
          var l1 = (0.25 + noise(i, k + 9) * 0.28) * TW * (0.45 + prog * 0.75);
          var mx = cx + Math.cos(a) * l1 * 0.55, my = cy + Math.sin(a) * l1 * 0.5;
          var a2 = a + (noise(i, k + 21) - 0.5) * 1.5;
          g.beginPath();
          g.moveTo(cx, cy);
          g.lineTo(mx, my);
          g.lineTo(mx + Math.cos(a2) * l1 * 0.6, my + Math.sin(a2) * l1 * 0.5);
          g.stroke();
        }
        g.restore();
      }
      function drawShards(t) {
        g.save();
        for (var i = 0; i < shards.length; i++) {
          var s = shards[i], pr = (t - s.t0) / s.life;
          var dy = pr * pr * 120, sc = 1 - pr * 0.55;
          g.globalAlpha = Math.max(0, 1 - pr * 1.15);
          g.translate(s.x + TW / 2, s.y + TH / 2 + dy);
          g.rotate(s.rot * pr);
          g.fillStyle = '#1d5a66';
          g.fillRect(-TW / 2 * sc, -TH / 2 * sc, TW * sc, TH * sc);
          g.fillStyle = 'rgba(127,243,230,.35)';
          g.fillRect(-TW / 2 * sc, -TH / 2 * sc, TW * sc, 3);
          g.setTransform(1, 0, 0, 1, 0, 0);
        }
        g.restore();
      }
      function drawParts(t) {
        g.save();
        for (var i = 0; i < parts.length; i++) {
          var p = parts[i], e = (t - p.t0) / 1000, pr = (t - p.t0) / p.life;
          g.fillStyle = 'rgba(' + p.c + ',' + Math.max(0, 1 - pr).toFixed(3) + ')';
          circle(p.x + p.vx * e, p.y + p.vy * e + 60 * e * e, p.r * (1 - pr * 0.5)); g.fill();
        }
        g.restore();
      }
      /* Zielhilfe: die Kachel, die mein nächster Schuss trifft */
      function drawAim(t) {
        var mp = me();
        if (!mp || !mp.alive || mp.fallAt || phase !== 'play' || t < mp.cdUntil) return;
        var h = rayHit(mp.dx, mp.dy, mp.fx, mp.fy);
        if (!h) return;
        var tx = h.i % N, ty = Math.floor(h.i / N);
        var pulse = 0.5 + 0.5 * Math.sin(t / 150);
        g.save();
        g.strokeStyle = 'rgba(234,255,224,' + (0.45 + pulse * 0.5).toFixed(2) + ')';
        g.lineWidth = 2.5;
        g.shadowColor = mp.color.hex; g.shadowBlur = 12;
        rrect(OX + tx * TW + 2, OY + ty * TH + 2, TW - 4, TH - 4, 5); g.stroke();
        g.setLineDash([5, 6]);
        g.lineWidth = 1.5;
        g.strokeStyle = 'rgba(' + mp.color.rgb + ',.5)';
        g.beginPath();
        g.moveTo(OX + mp.dx * TW, OY + mp.dy * TH);
        g.lineTo(OX + (mp.dx + mp.fx * h.d) * TW, OY + (mp.dy + mp.fy * h.d) * TH);
        g.stroke();
        g.restore();
      }
      function drawBolts(t) {
        g.save();
        for (var i = 0; i < bolts.length; i++) {
          var b = bolts[i], run = Math.min(b.d, (t - b.t0) / 1000 * BOLT_SPEED);
          var c = COLORS[b.ci % COLORS.length];
          var x = OX + (b.x + b.ux * run) * TW, y = OY + (b.y + b.uy * run) * TH;
          for (var k = 1; k <= 4; k++) {
            var rr = Math.max(0, run - k * 0.22);
            g.fillStyle = 'rgba(' + c.rgb + ',' + (0.24 - k * 0.05).toFixed(2) + ')';
            circle(OX + (b.x + b.ux * rr) * TW, OY + (b.y + b.uy * rr) * TH, 6 - k); g.fill();
          }
          g.shadowColor = c.hex; g.shadowBlur = 16;
          g.fillStyle = '#eaffe0';
          circle(x, y, b.done ? 3 : 5.5); g.fill();
          g.shadowBlur = 0;
        }
        g.restore();
      }

      function drawPlayer(p, t) {
        var sc = 1, al = 1, yo = 0, rot = 0;
        if (p.fallAt) {
          var pr = Math.min(1, (t - p.fallAt) / FALL_MS);
          sc = 1 - pr * 0.8; al = 1 - pr * 0.9; yo = pr * pr * 90; rot = pr * 3.2;
        } else if (!p.alive) return;
        if (al <= 0.02) return;
        var x = OX + p.dx * TW, y = OY + p.dy * TH + yo, r = PR * sc, c = p.color;

        /* Laufspur */
        g.save();
        for (var i = 0; i < p.trail.length; i++) {
          var tp = p.trail[i], a = (i + 1) / p.trail.length;
          g.fillStyle = 'rgba(' + c.rgb + ',' + (a * 0.13 * al).toFixed(3) + ')';
          circle(OX + tp.x * TW, OY + tp.y * TH, r * (0.3 + a * 0.55)); g.fill();
        }
        g.restore();

        if (!p.fallAt) {
          g.save();
          g.fillStyle = 'rgba(0,0,0,.4)';
          g.beginPath(); g.ellipse(x + 3, y + 6, r * 0.95, r * 0.6, 0, 0, Math.PI * 2); g.fill();
          g.restore();
          /* Abklingzeit-Ring */
          var ready = t >= p.cdUntil;
          var prg = ready ? 1 : 1 - (p.cdUntil - t) / SHOT_CD;
          g.save();
          g.lineWidth = 3;
          g.strokeStyle = ready ? 'rgba(' + c.rgb + ',.85)' : 'rgba(' + c.rgb + ',.28)';
          if (ready) { g.shadowColor = 'rgba(' + c.rgb + ',.7)'; g.shadowBlur = 9; }
          g.beginPath(); g.arc(x, y, r + 5, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * prg); g.stroke();
          g.restore();
        }

        /* Körper */
        g.save();
        g.globalAlpha = al;
        g.translate(x, y); g.rotate(rot);
        g.shadowColor = 'rgba(' + c.rgb + ',.75)'; g.shadowBlur = 16;
        var bgd = g.createRadialGradient(-r * 0.35, -r * 0.4, r * 0.1, 0, 0, r);
        bgd.addColorStop(0, '#ffffff'); bgd.addColorStop(0.35, c.hex); bgd.addColorStop(1, 'rgba(' + c.rgb + ',.55)');
        g.fillStyle = bgd; circle(0, 0, r); g.fill();
        g.lineWidth = 2; g.strokeStyle = 'rgba(255,255,255,.55)';
        circle(0, 0, r); g.stroke();
        g.rotate(Math.atan2(p.fy, p.fx));
        g.fillStyle = 'rgba(3,18,14,.6)';
        g.beginPath(); g.moveTo(r * 0.2, -r * 0.34); g.lineTo(r * 0.85, 0); g.lineTo(r * 0.2, r * 0.34); g.closePath(); g.fill();
        g.restore();

        /* Namensschild */
        if (!p.fallAt && p.alive) {
          g.save();
          g.font = '800 15px "Segoe UI",system-ui,Roboto,Arial,sans-serif';
          g.textAlign = 'center'; g.textBaseline = 'middle';
          var nm = p.name.length > 12 ? p.name.slice(0, 11) + '…' : p.name;
          var w = g.measureText(nm).width + 12;
          var bx = x - w / 2, by = y - r - 24, bh = 18;
          g.fillStyle = 'rgba(3,14,8,.75)';
          rrect(bx, by, w, bh, 7); g.fill();
          g.fillStyle = p.id === ctx.me.id ? '#ffffff' : c.hex;
          g.fillText(nm, x, by + bh / 2 + 1);
          g.restore();
        }
      }

      /* Große Ansagen mitten auf dem Eis */
      function drawOverlay(t) {
        var l1 = null, l2 = null;
        if (phase === 'count') {
          var left = Math.ceil((phaseAt - t) / 1000);
          l1 = left > 0 ? String(left) : 'LOS!';
          l2 = left > 0 ? 'Bereit machen …' : '';
        } else if (phase === 'roundend') {
          l1 = roundWinner ? (roundWinner === ctx.me.id ? 'Runde gewonnen!' : ((byId[roundWinner] ? byId[roundWinner].name : 'Jemand') + ' gewinnt')) : 'Unentschieden';
          l2 = 'Runde ' + Math.min(roundIdx, MAX_ROUNDS) + (roundIdx > MAX_ROUNDS ? ' (Entscheidung)' : ' / ' + MAX_ROUNDS);
        } else if (phase === 'play' && playStart && t - playStart < SD_DELAY + 1800 && t - playStart >= SD_DELAY) {
          l1 = 'SUDDEN DEATH';
          l2 = 'Die Arena bricht von außen weg!';
        }
        if (!l1) return;
        g.save();
        g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillStyle = 'rgba(2,10,7,.62)';
        g.fillRect(0, H / 2 - 62, W, 124);
        g.shadowColor = 'rgba(57,255,20,.75)'; g.shadowBlur = 22;
        g.fillStyle = '#eaffe2';
        g.font = '900 54px "Segoe UI",system-ui,Roboto,Arial,sans-serif';
        g.fillText(l1, W / 2, H / 2 - 12);
        if (l2) {
          g.shadowBlur = 10;
          g.font = '800 22px "Segoe UI",system-ui,Roboto,Arial,sans-serif';
          g.fillStyle = '#9dff7a';
          g.fillText(l2, W / 2, H / 2 + 30);
        }
        g.restore();
      }
    }
  };

  /* ============================ STYLES ============================ */
  function injectStyle() {
    UI.injectStyle('mg-spleef-css', [
      '.spl-wrap{display:flex;flex-direction:column;gap:12px;align-items:stretch;}',
      /* Kopfzeile */
      '.spl-head{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 16px;flex-wrap:wrap;}',
      '.spl-round{font-weight:900;font-size:clamp(13px,3.4vw,17px);color:var(--leaf);letter-spacing:.5px;white-space:nowrap;}',
      '.spl-status{flex:1;text-align:center;font-size:clamp(11px,3vw,13px);font-weight:800;color:var(--muted);',
      'text-transform:uppercase;letter-spacing:1.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      '.spl-status.is-warn{color:var(--bronze);text-shadow:0 0 10px rgba(224,138,60,.5);animation:spl-blink 1s ease-in-out infinite;}',
      '.spl-chip{font-weight:900;font-size:clamp(12px,3.2vw,15px);color:var(--muted);border:1px solid var(--stroke);',
      'border-radius:999px;padding:4px 11px;background:rgba(4,16,10,.6);white-space:nowrap;font-variant-numeric:tabular-nums;}',
      '.spl-chip.is-ready{color:var(--aqua-soft);border-color:rgba(51,230,208,.5);box-shadow:0 0 12px rgba(51,230,208,.3);}',
      /* Arena */
      '.spl-stage{width:100%;max-width:min(560px,100%);margin:0 auto;aspect-ratio:720 / 640;position:relative;}',
      '.spl-canvas{display:block;width:100%;height:100%;border-radius:20px;background:#020806;',
      'border:1px solid var(--stroke);box-shadow:0 0 44px rgba(51,230,208,.16),inset 0 0 60px rgba(0,0,0,.5);',
      'touch-action:none;user-select:none;-webkit-user-select:none;-webkit-tap-highlight-color:transparent;}',
      /* Spieler-Chips */
      '.spl-tags{display:flex;flex-wrap:wrap;gap:7px;justify-content:center;}',
      '.spl-tag{display:flex;align-items:center;gap:6px;padding:4px 10px;border-radius:999px;',
      'background:rgba(6,24,15,.72);border:1px solid var(--stroke);font-size:12px;font-weight:800;color:var(--silver);',
      'transition:opacity .25s ease,filter .25s ease;}',
      '.spl-tag.is-me{border-color:var(--tg);box-shadow:0 0 12px var(--tg);}',
      '.spl-tag.is-out{opacity:.34;filter:grayscale(.8);}',
      '.spl-tag.is-out .spl-tag-n{text-decoration:line-through;}',
      '.spl-dot{width:9px;height:9px;border-radius:50%;background:var(--tc);box-shadow:0 0 8px var(--tc);flex:none;}',
      '.spl-tag-n{max-width:112px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.spl-tag-w{font-size:10px;letter-spacing:-1px;color:var(--gold);}',
      '.spl-hint{margin:0;}',
      /* Touch-Steuerung */
      '.spl-pad{display:flex;align-items:center;justify-content:space-between;gap:16px;max-width:330px;margin:2px auto 0;width:100%;}',
      '.spl-stick{position:relative;width:120px;height:120px;border-radius:50%;flex:none;touch-action:none;',
      'background:radial-gradient(circle at 50% 40%,rgba(12,44,28,.9),rgba(3,14,8,.9));',
      'border:1px solid var(--stroke-2);box-shadow:inset 0 0 26px rgba(57,255,20,.12);}',
      '.spl-stick.is-on{border-color:var(--neon);box-shadow:0 0 20px rgba(57,255,20,.35),inset 0 0 26px rgba(57,255,20,.2);}',
      '.spl-stick-ring{position:absolute;inset:14px;border-radius:50%;border:1px dashed rgba(157,255,122,.25);}',
      '.spl-knob{position:absolute;left:50%;top:50%;width:52px;height:52px;margin:-26px 0 0 -26px;border-radius:50%;',
      'background:linear-gradient(180deg,var(--neon-soft,#6dff4d),var(--neon));box-shadow:0 0 18px rgba(57,255,20,.6);',
      'transition:transform .05s linear;pointer-events:none;}',
      '.spl-shot{position:relative;width:92px;height:92px;border-radius:50%;flex:none;overflow:hidden;',
      'border:2px solid var(--stroke-2);background:rgba(4,16,10,.85);color:var(--muted);font-size:34px;',
      'cursor:pointer;touch-action:none;user-select:none;-webkit-tap-highlight-color:transparent;font-family:inherit;}',
      '.spl-shot.is-ready{border-color:var(--aqua);color:var(--aqua-soft);box-shadow:0 0 20px rgba(51,230,208,.45);}',
      '.spl-shot:active{transform:scale(.94);}',
      '.spl-shot-fill{position:absolute;left:0;right:0;bottom:0;height:100%;transform-origin:bottom;transform:scaleY(0);',
      'background:linear-gradient(180deg,rgba(51,230,208,.34),rgba(127,243,230,.14));pointer-events:none;}',
      '.spl-shot-t{position:relative;z-index:1;line-height:1;filter:drop-shadow(0 0 8px currentColor);}',
      /* Rangliste */
      '.spl-board{padding:14px;display:flex;flex-direction:column;gap:8px;}',
      '.spl-board .mg-scoreboard{max-height:260px;overflow-y:auto;}',
      /* Schwierigkeits-Auswahl */
      '.spl-intro{padding:26px 22px;display:flex;flex-direction:column;gap:12px;align-items:center;text-align:center;max-width:520px;margin:0 auto;}',
      '.spl-intro-ico{font-size:56px;line-height:1;filter:drop-shadow(0 0 16px rgba(51,230,208,.55));animation:spl-bob 1.8s ease-in-out infinite;}',
      '.spl-intro h2{margin:0;}',
      '.spl-diffs{display:flex;flex-direction:column;gap:9px;width:100%;max-width:330px;}',
      '.spl-diff{display:grid;grid-template-columns:auto 1fr auto;grid-template-rows:auto auto;gap:2px 12px;',
      'text-align:left;padding:11px 14px;align-items:center;}',
      '.spl-diff.is-on{border-color:var(--aqua);box-shadow:0 0 16px rgba(51,230,208,.28);}',
      '.spl-diff-ico{grid-row:1 / span 2;font-size:26px;line-height:1;}',
      '.spl-diff-nm{font-weight:900;color:var(--leaf);font-size:15px;}',
      '.spl-diff-ds{grid-column:2;font-size:11px;color:var(--muted);font-weight:600;}',
      '.spl-diff-x{grid-row:1 / span 2;grid-column:3;font-size:11px;font-weight:900;color:var(--gold);white-space:nowrap;}',
      /* Warten */
      '.spl-wait{padding:44px;text-align:center;display:flex;flex-direction:column;gap:10px;align-items:center;max-width:440px;margin:0 auto;}',
      '.spl-wait-ico{font-size:52px;filter:drop-shadow(0 0 14px rgba(51,230,208,.5));animation:spl-bob 1.6s ease-in-out infinite;}',
      '@keyframes spl-bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-8px)}}',
      '@keyframes spl-blink{0%,100%{opacity:1}50%{opacity:.45}}'
    ].join(''));
  }
})();
