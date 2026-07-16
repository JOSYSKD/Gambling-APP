/* sumo.js — "Sumo-Arena": Rempel-Duell auf einer runden Neon-Plattform über dem Abgrund.
 *
 * SPIELIDEE : Jeder ist eine leuchtende Kugel auf einer schwebenden Scheibe. Wer von der
 *             Plattform rutscht, fällt in den Abgrund und ist raus. Die Plattform schrumpft
 *             nach einer Schonfrist immer weiter → es wird zwangsläufig eng. Letzter drauf
 *             gewinnt die Runde. Best of 5 (wer zuerst 3 Rundensiege hat, gewinnt sofort);
 *             steht es nach Runde 5 gleich, fällt die Entscheidung in einer Sudden-Death-
 *             Runde – wer die holt, holt das Match (nie einfach „Spieler 1 gewinnt“).
 * STEUERUNG : WASD / Pfeiltasten bewegen, LEERTASTE = Dash (kräftiger Stoß, 2 s Abklingzeit).
 *             Am Handy: virtueller Joystick + Dash-Knopf unter der Arena.
 * PHYSIK    : Beschleunigung + Reibung, Stöße zwischen den Kugeln. Ein Dash macht schwer und
 *             prallhart → damit schiebt man Gegner über die Kante. Die Balance steckt in
 *             Marschtempo (ACC/DAMP) und Rutschweg (MAXV/DAMP), siehe Konstanten unten:
 *             ein sauberer Dash killt vom Rand her, in der Mitte überlebt man ihn.
 * PUNKTE    : Multiplayer = Rundensiege (room.reportScore → Live-Rangliste + Podest).
 *             Solo = Rundensiege ×500 + Ausschaltungen ×120 + Matchsieg ×900, mal
 *             Schwierigkeits-Multiplikator; Bestwert in App.Storage ('best_sumo').
 * SOLO      : gegen 3 Bots (Leicht / Mittel / Schwer). Die Bots suchen sich den lohnendsten
 *             Gegner (nah + schon randnah), zielen hinter ihn (durchschieben), passen mit
 *             Vorhersage auf den eigenen Rand auf und dashen zum Angriff oder zur Rettung.
 * SYNC      : Host-autoritativ. Der HOST rechnet die komplette Physik und schreibt den Zustand
 *             ~15×/s per room.setShared({t,ph,rd,at,r,ps,w,wn,rw,hit}). Alle anderen schicken
 *             nur ihre Eingabe per room.reportState({ax,ay,ds}) (ds = Dash-Zähler) und
 *             interpolieren die empfangenen Positionen weich (Dead-Reckoning über p.v* + Lerp).
 *             Gäste führen den Zustand mit → wird ein Gast zum Host, rechnet er nahtlos weiter.
 *             Alle Zeiten laufen über room.now() (Server-Zeit) bzw. Date.now() im Solo.
 * cleanup() beendet rAF, Timeouts, Listener und meldet jeden room.on wieder ab. */
(function () {
  'use strict';
  window.App = window.App || {}; App.Minigames = App.Minigames || {};
  var UI = App.UI, el = UI.el;

  injectStyle();

  /* ---- Virtuelle Arena (feste Koordinaten, Canvas skaliert per CSS) ---- */
  var W = 720, H = 720, CX = W / 2, CY = H / 2;
  var R0 = 292, RMIN = 76;              // Plattform-Radius: Start / Minimum (76 ≈ 3 Kugeln breit → enges Duell)
  var SHRINK = 13;                      // px/s Schrumpfen
  var GRACE_MS = 7000;                  // Schonfrist vor dem Schrumpfen
  var ROUND_CAP_MS = 42000;             // Notbremse: danach gewinnt, wer der Mitte am nächsten ist
  var PR = 24;                          // Kugel-Radius
  /* Balance-Faustregeln (in Reibung gedacht, nicht in Höchstwerten):
     Marschtempo  = ACC / DAMP  ≈ 430 px/s  → knapp 1,5 s quer über die Plattform.
     Rutschweg    = MAXV / DAMP ≈ 190 px    → so weit fliegt man nach dem härtesten Treffer.
     Damit killt ein sauberer Dash vom Rand her, in der Mitte überlebt man ihn. */
  var ACC = 1800, DAMP = 4.2, MAXV = 800;
  var DASH_IMP = 470, DASH_CD = 2000, DASH_MS = 220, DASH_MASS = 2;
  /* Stoß-Elastizität < 1 = Energie geht verloren (physikalisch). Der Dash darf mit 1.15
     etwas „zaubern“, sonst fühlt er sich nicht nach Stoß an – aber nie so viel, dass
     jeder Kontakt zum Abschuss wird. */
  var REST = 0.95, REST_DASH = 1.15;
  var FALL_MS = 750;                    // Dauer der Sturz-Animation
  var OUT_MARGIN = PR * 0.2;            // Kulanz an der Kante
  var MAX_ROUNDS = 5, WINS_NEEDED = 3;  // Best of 5
  var COUNT_MS = 2600, COUNT1_MS = 1600, ROUNDEND_MS = 2600;
  var NET_MS = 66, REPORT_MS = 66;      // Host-Broadcast / Eingabe-Meldung (~15/s)
  var CREDIT_MS = 4000;                 // so lange zählt ein Treffer als Ausschaltung

  var COLORS = [
    { hex: '#39ff14', rgb: '57,255,20' },
    { hex: '#33e6d0', rgb: '51,230,208' },
    { hex: '#ffd23f', rgb: '255,210,63' },
    { hex: '#ff4d6d', rgb: '255,77,109' },
    { hex: '#b57cff', rgb: '181,124,255' },
    { hex: '#ff9d3c', rgb: '255,157,60' }
  ];
  var BOT_NAMES = ['Kokos', 'Liane', 'Mango', 'Papaya', 'Bambus'];

  /* Bot-Stufen: think = Reaktionstakt (ms), jitter = Zielfehler (rad),
     range = Dash-Reichweite, safety = ab welchem Anteil des Radius gebremst wird,
     edgeIq = wie stark randnahe Opfer bevorzugt werden, dashUse = Dash-Freude. */
  var DIFFS = [
    { id: 'easy', name: 'Leicht', icon: '🌱', mult: 1, think: 200, jitter: 0.55, range: 74, safety: 0.60, edgeIq: 0.35, dashUse: 0.45, desc: 'Gemütliche Gegner zum Warmrempeln' },
    { id: 'mid', name: 'Mittel', icon: '🌿', mult: 1.6, think: 130, jitter: 0.30, range: 96, safety: 0.72, edgeIq: 0.75, dashUse: 0.75, desc: 'Sie zielen und retten sich am Rand' },
    { id: 'hard', name: 'Schwer', icon: '🔥', mult: 2.4, think: 85, jitter: 0.13, range: 122, safety: 0.82, edgeIq: 1.1, dashUse: 0.95, desc: 'Gnadenlos: sie warten auf deinen Fehler' }
  ];

  var TOUCH = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);

  function r1(v) { return Math.round(v * 10) / 10; }
  function len(x, y) { return Math.sqrt(x * x + y * y); }

  App.Minigames.sumo = {
    id: 'sumo', title: 'Sumo-Arena', icon: '🥊', order: 111,
    subtitle: 'Rempel alle von der Neon-Plattform!',
    single: true, multi: true, minPlayers: 2, maxPlayers: 6,

    render: function (root, ctx) {
      var isMulti = ctx.mode === 'multi';
      var tnow = isMulti ? function () { return ctx.room.now(); } : function () { return Date.now(); };

      /* ---- Laufzeit ---- */
      var dead = false, raf = null, last = 0;
      var stops = [], listeners = [], pending = [];
      var g = null, refs = null;

      /* ---- Spielzustand ---- */
      var P = [], byId = {};
      var phase = 'count', phaseAt = 0, roundIdx = 1, platR = R0, playStart = 0;
      var roundWinner = null, matchWinner = null, wins = {};
      var diff = DIFFS[1], ended = false;

      /* ---- Eingabe ---- */
      var keys = { u: false, d: false, l: false, r: false };
      var joy = { on: false, x: 0, y: 0, id: -1 };
      var dashSeq = 0, lastDs = {};

      /* ---- Netz ---- */
      var lastReport = 0, lastBroadcast = 0, reportedScore = -1, wasHost = false;
      var lastHit = null, lastHitSeen = 0;

      /* ---- Effekte / Cues ---- */
      var parts = [], spores = [], cueFall = {}, cueRound = 0, cueCount = -1, lastHitSfx = 0;
      var soloElims = 0, headSig = '', tagSig = '';

      buildSpores();

      /* ================= Aufräumen ================= */
      function addL(t, ty, fn, opts) { t.addEventListener(ty, fn, opts); listeners.push({ t: t, ty: ty, fn: fn, opts: opts }); }
      function after(ms, fn) { var t = setTimeout(function () { if (!dead) fn(); }, ms); pending.push(t); return t; }
      function cleanup() {
        dead = true; ended = true;
        if (raf) { cancelAnimationFrame(raf); raf = null; }
        pending.forEach(clearTimeout); pending = [];
        stops.forEach(function (f) { try { f(); } catch (e) {} }); stops = [];
        listeners.forEach(function (l) { try { l.t.removeEventListener(l.ty, l.fn, l.opts); } catch (e) {} }); listeners = [];
      }

      /* ================= Einstieg ================= */
      if (isMulti) startMulti(); else showDiff();
      return { cleanup: cleanup };

      /* ================= SOLO ================= */
      function showDiff() {
        stopLoop();
        var best = App.Storage.get('best_sumo', 0);
        var btns = DIFFS.map(function (d) {
          return el('button', { class: 'smo-diff btn' + (d.id === diff.id ? ' is-on' : ''), type: 'button', onclick: function () {
            if (App.Audio) App.Audio.sfx('select');
            diff = d; startSolo();
          } }, [
            el('span', { class: 'smo-diff-ico' }, [d.icon]),
            el('span', { class: 'smo-diff-nm' }, [d.name]),
            el('span', { class: 'smo-diff-ds' }, [d.desc]),
            el('span', { class: 'smo-diff-x' }, ['×' + d.mult + ' Punkte'])
          ]);
        });
        root.innerHTML = '';
        root.appendChild(el('div', { class: 'glass smo-intro' }, [
          el('div', { class: 'smo-intro-ico' }, ['🥊']),
          el('h2', { class: 'neon' }, ['Sumo-Arena']),
          el('p', { class: 'hint-text' }, ['Du gegen 3 Bots auf der schrumpfenden Plattform. Wer runterfällt, ist raus – Best of 5.']),
          el('div', { class: 'mg-field-title' }, ['Schwierigkeit wählen']),
          el('div', { class: 'smo-diffs' }, btns),
          el('p', { class: 'hint-text' }, ['🏆 Dein Bestwert: ' + App.MG.fmt(best) + ' Punkte'])
        ]));
      }

      function startSolo() {
        stopLoop();
        ended = false; soloElims = 0; wins = {}; matchWinner = null;
        parts = []; cueFall = {}; cueRound = 0; cueCount = -1;
        buildStage([]);
        P = []; byId = {};
        addPlayer(ctx.me.id, (ctx.me && ctx.me.name) ? ctx.me.name : 'Du', 0, false);
        var order = BOT_NAMES.slice();
        for (var i = 0; i < 3; i++) {
          var nm = order.splice(Math.floor(Math.random() * order.length), 1)[0];
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
        ended = false; parts = []; cueFall = {}; cueRound = 0; cueCount = -1;
        wins = {}; matchWinner = null; roundWinner = null;
        P = []; byId = {};
        var ps = ctx.room.players();
        buildStage(ps);
        ps.forEach(function (pl, i) { addPlayer(pl.id, pl.name, i, false); wins[pl.id] = 0; });

        var sh = function (s) { applyShared(s); };
        ctx.room.on('shared', sh);
        stops.push(function () { ctx.room.off('shared', sh); });
        var pl = function () { refreshNames(); };
        ctx.room.on('players', pl);
        stops.push(function () { ctx.room.off('players', pl); });

        wasHost = !!ctx.room.isHost();
        if (wasHost) { initRound(1, startAt); broadcast(ctx.room.now(), true); }
        else { var s0 = ctx.room.snapshot(); if (s0 && s0.shared) applyShared(s0.shared); }
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

      /* ================= Spieler-Objekte ================= */
      function addPlayer(id, name, ci, bot) {
        var p = {
          id: id, name: name, ci: ci % COLORS.length, color: COLORS[ci % COLORS.length], bot: !!bot,
          x: CX, y: CY, vx: 0, vy: 0, dx: CX, dy: CY, nt: 0,
          ax: 0, ay: 0, fx: 0, fy: 1,
          alive: true, fallAt: 0, dashUntil: 0, cdUntil: 0,
          hitBy: null, hitAt: 0, trail: [], nextThink: 0, gone: false
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
        platR = R0; playStart = 0; roundWinner = null;
        cueFall = {}; cueCount = -1; parts = [];

        var list = P;
        if (isMulti) {   // Aufstellung frisch aus dem Raum (Zu-/Abgänge berücksichtigen)
          var ps = ctx.room.players();
          P = []; byId = {};
          ps.forEach(function (pl, i) {
            var p = addPlayer(pl.id, pl.name, i, false);
            if (wins[pl.id] == null) wins[pl.id] = 0;
            p.trail = [];
          });
          list = P;
        }
        var off = Math.random() * Math.PI * 2, rr = R0 * 0.62;
        list.forEach(function (p, i) {
          var a = off + i / list.length * Math.PI * 2;
          p.x = CX + Math.cos(a) * rr; p.y = CY + Math.sin(a) * rr;
          p.dx = p.x; p.dy = p.y;
          p.vx = 0; p.vy = 0; p.ax = 0; p.ay = 0;
          p.fx = Math.cos(a + Math.PI); p.fy = Math.sin(a + Math.PI);
          p.alive = true; p.fallAt = 0; p.dashUntil = 0; p.cdUntil = 0;
          p.hitBy = null; p.hitAt = 0; p.trail = []; p.nextThink = 0; p.gone = false;
        });
        lastDs = {};
        if (isMulti) ctx.room.players().forEach(function (pl) {
          lastDs[pl.id] = (pl.state && pl.state.ds) || 0;
        });
      }

      function standing() {
        var n = 0, w = null;
        for (var i = 0; i < P.length; i++) if (P[i].alive && !P[i].fallAt) { n++; w = P[i]; }
        return { n: n, last: w };
      }

      /* Host/Solo: Phasen weiterschalten */
      function hostPhases(t) {
        if (phase === 'count') {
          if (t >= phaseAt) { phase = 'play'; playStart = t; if (isMulti) broadcast(t, true); }
          return;
        }
        if (phase === 'play') {
          var el_ = t - playStart - GRACE_MS;
          platR = el_ > 0 ? Math.max(RMIN, R0 - el_ / 1000 * SHRINK) : R0;
          /* Notbremse: klammern sich alle in der Mitte fest, entscheidet der kürzeste
             Abstand zur Mitte → eine Runde kann niemals ewig laufen. */
          if (playStart && t - playStart > ROUND_CAP_MS) {
            var bp = null, bd = Infinity, q;
            for (q = 0; q < P.length; q++) {
              var pq = P[q];
              if (!pq.alive || pq.fallAt) continue;
              var dq = len(pq.x - CX, pq.y - CY);
              if (dq < bd) { bd = dq; bp = pq; }
            }
            for (q = 0; q < P.length; q++) {
              var pr2 = P[q];
              if (pr2.alive && !pr2.fallAt && pr2 !== bp) pr2.fallAt = t;
            }
          }
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
            /* Entscheidungsrunde: wer sie holt, holt das Match (Sudden Death). */
            if (roundWinner) { matchWinner = roundWinner; phase = 'over'; }
            else if (roundIdx >= MAX_ROUNDS + 3) { matchWinner = 'draw'; phase = 'over'; }
            else initRound(roundIdx + 1, t);
          } else if (ld.v >= WINS_NEEDED || (roundIdx >= MAX_ROUNDS && !ld.tied)) {
            matchWinner = ld.id || 'draw';
            phase = 'over';
          } else {
            /* Bei Gleichstand nach Runde 5 folgt eine Entscheidungsrunde statt eines
               willkürlichen Siegers. */
            initRound(roundIdx + 1, t);
          }
          if (isMulti) broadcast(t, true);
        }
      }
      /* Führender + ob die Führung GETEILT ist. Wichtig: nie einfach den ersten Spieler
         mit der Höchstzahl krönen – im Multiplayer wäre das immer der Host. */
      function leader() {
        var bestId = null, bestV = -1, tied = false;
        for (var i = 0; i < P.length; i++) {
          var v = wins[P[i].id] || 0;
          if (v > bestV) { bestV = v; bestId = P[i].id; tied = false; }
          else if (v === bestV) tied = true;
        }
        return { id: bestId, v: bestV, tied: tied };
      }

      /* ================= Physik (nur Host/Solo) ================= */
      function stepAll(dt, t) {
        var n = Math.ceil(dt / 0.016), i;
        if (n < 1) n = 1; if (n > 4) n = 4;
        for (i = 0; i < n; i++) physics(dt / n, t);
      }

      function physics(dt, t) {
        var i, j, p;
        for (i = 0; i < P.length; i++) {
          p = P[i];
          if (!p.alive) continue;
          if (p.fallAt) {                       // Sturz: keine Kontrolle mehr
            var fd = Math.exp(-0.7 * dt);
            p.vx *= fd; p.vy *= fd;
            p.x += p.vx * dt; p.y += p.vy * dt;
            if (t - p.fallAt >= FALL_MS) p.alive = false;
            continue;
          }
          if (phase !== 'play') { p.vx *= Math.exp(-6 * dt); p.vy *= Math.exp(-6 * dt); continue; }
          var ax = p.ax, ay = p.ay, m = len(ax, ay);
          if (m > 1) { ax /= m; ay /= m; m = 1; }
          if (m > 0.08) { p.fx = ax / m; p.fy = ay / m; }
          p.vx += ax * ACC * dt; p.vy += ay * ACC * dt;
          var damp = Math.exp(-DAMP * dt);
          p.vx *= damp; p.vy *= damp;
          var sp = len(p.vx, p.vy);
          if (sp > MAXV) { p.vx = p.vx / sp * MAXV; p.vy = p.vy / sp * MAXV; }
          p.x += p.vx * dt; p.y += p.vy * dt;
        }
        for (i = 0; i < P.length; i++) for (j = i + 1; j < P.length; j++) collide(P[i], P[j], t);

        /* Rausflug-Prüfung – nur im laufenden Spiel, sonst würde der Sieger noch während
           seiner Siegermeldung von der (stehengebliebenen) Plattform kippen. */
        if (phase !== 'play') return;

        var outs = [], aliveN = 0, over;
        for (i = 0; i < P.length; i++) {
          p = P[i];
          if (!p.alive || p.fallAt) continue;
          aliveN++;
          over = len(p.x - CX, p.y - CY) - (platR + OUT_MARGIN);
          if (over > 0) outs.push({ p: p, over: over });
        }
        /* Wer als Letzter oben steht, hat gewonnen und kann nicht mehr fallen. Ohne diese
           Sperre kippt er noch im selben Frame hinterher (stepAll rechnet bis zu 4 Teil-
           schritte, der Rundensieger wird aber erst danach ermittelt) → 0 Übrige = Remis. */
        if (aliveN <= 1) return;
        /* Schrumpft die Plattform unter einer ganzen Traube weg, wären alle gleichzeitig
           draußen. Dann bleibt der drauf, der am wenigsten weit über der Kante steht: Er
           fällt zuletzt und gewinnt die Runde verdient. */
        if (outs.length >= aliveN) {
          outs.sort(function (u, v) { return u.over - v.over; });
          outs.shift();
        }
        for (i = 0; i < outs.length; i++) {
          p = outs[i].p;
          p.fallAt = t;
          if (!isMulti && p.hitBy && p.hitBy === ctx.me.id && t - p.hitAt <= CREDIT_MS && p.id !== ctx.me.id) soloElims++;
        }
      }

      function collide(a, b, t) {
        if (!a.alive || !b.alive || a.fallAt || b.fallAt) return;
        var dx = b.x - a.x, dy = b.y - a.y, d = len(dx, dy);
        if (d >= PR * 2 || d <= 0.0001) return;
        var nx = dx / d, ny = dy / d, ov = PR * 2 - d;
        a.x -= nx * ov / 2; a.y -= ny * ov / 2;
        b.x += nx * ov / 2; b.y += ny * ov / 2;
        var rvn = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
        if (rvn > 0) return;
        var aD = t < a.dashUntil, bD = t < b.dashUntil;
        var ma = aD ? DASH_MASS : 1, mb = bD ? DASH_MASS : 1;
        var e = (aD || bD) ? REST_DASH : REST;
        var jI = -(1 + e) * rvn / (1 / ma + 1 / mb);
        a.vx -= jI / ma * nx; a.vy -= jI / ma * ny;
        b.vx += jI / mb * nx; b.vy += jI / mb * ny;
        a.hitBy = b.id; a.hitAt = t; b.hitBy = a.id; b.hitAt = t;
        var pw = Math.min(1, Math.abs(rvn) / 700 + (aD || bD ? 0.35 : 0));
        var hx = a.x + nx * PR, hy = a.y + ny * PR;
        if (pw > 0.18) {
          spawnHit(hx, hy, pw, t);
          if (isMulti && hostMode()) lastHit = { x: Math.round(hx), y: Math.round(hy), p: r1(pw), t: Math.round(t) };
        }
      }

      function dashNow(p, dx, dy, t) {
        if (!p.alive || p.fallAt || t < p.cdUntil || phase !== 'play') return false;
        var m = len(dx, dy);
        if (m < 0.05) { dx = p.fx; dy = p.fy; m = len(dx, dy) || 1; }
        dx /= m; dy /= m;
        p.vx += dx * DASH_IMP; p.vy += dy * DASH_IMP;
        p.fx = dx; p.fy = dy;
        p.dashUntil = t + DASH_MS; p.cdUntil = t + DASH_CD;
        for (var i = 0; i < 8; i++) {
          var a = Math.atan2(-dy, -dx) + (Math.random() - 0.5) * 1.5;
          parts.push({ x: p.x - dx * PR, y: p.y - dy * PR, vx: Math.cos(a) * (60 + Math.random() * 140),
            vy: Math.sin(a) * (60 + Math.random() * 140), t0: t, life: 320 + Math.random() * 180, c: p.color.rgb, r: 3 });
        }
        return true;
      }

      /* ================= Bot-KI ================= */
      function botThink(b, t) {
        if (t < b.nextThink) return;
        b.nextThink = t + diff.think * (0.75 + Math.random() * 0.5);
        var i, o, tgt = null, bestSc = -Infinity;
        for (i = 0; i < P.length; i++) {
          o = P[i];
          if (o === b || !o.alive || o.fallAt) continue;
          var d = len(o.x - b.x, o.y - b.y);
          var edge = len(o.x - CX, o.y - CY) / platR;           // 0..1 – höher = näher am Abgrund
          var sc = -d * 0.6 + edge * 260 * diff.edgeIq;
          if (sc > bestSc) { bestSc = sc; tgt = o; }
        }
        var dirx, diry;
        if (tgt) {   // Zielpunkt HINTER dem Gegner (Richtung Rand) → durchschieben statt anstupsen
          var ex = tgt.x - CX, ey = tgt.y - CY, eL = len(ex, ey) || 1;
          dirx = (tgt.x + ex / eL * PR * 1.6) - b.x;
          diry = (tgt.y + ey / eL * PR * 1.6) - b.y;
        } else { dirx = CX - b.x; diry = CY - b.y; }
        var dl = len(dirx, diry) || 1; dirx /= dl; diry /= dl;

        /* Selbsterhaltung: Position in 0,5 s vorhersagen und ggf. zur Mitte gegensteuern.
           Je kleiner die Plattform, desto tiefer zieht es den Bot in die Mitte – sonst
           umkreist er im Endspiel brav den Rand und fällt von selbst herunter, während
           ein Spieler einfach in der Mitte campt. */
        var px = b.x + b.vx * 0.5 - CX, py = b.y + b.vy * 0.5 - CY, pd = len(px, py) || 1;
        var safeR = platR * diff.safety * (0.7 + 0.3 * (platR / R0));
        var danger = pd / safeR;
        if (danger > 1) {
          var w = Math.min(1, (danger - 1) * 1.7);
          dirx = dirx * (1 - w) + (-px / pd) * w * 1.7;
          diry = diry * (1 - w) + (-py / pd) * w * 1.7;
          var l2 = len(dirx, diry) || 1; dirx /= l2; diry /= l2;
        }
        var ang = Math.atan2(diry, dirx) + (Math.random() * 2 - 1) * diff.jitter;
        b.ax = Math.cos(ang); b.ay = Math.sin(ang);

        if (t < b.cdUntil || phase !== 'play') return;
        var mx = b.x - CX, my = b.y - CY, md = len(mx, my) || 1;
        var outward = (b.vx * mx + b.vy * my) / md;
        if (md > platR * 0.84 && outward > 70 && Math.random() < diff.dashUse) {
          dashNow(b, -mx / md, -my / md, t);                    // Rettungs-Dash zur Mitte
          return;
        }
        if (tgt) {
          var tx = tgt.x - b.x, ty = tgt.y - b.y, td = len(tx, ty) || 1;
          if (td < diff.range + PR * 2) {
            var ux = tx / td, uy = ty / td;
            var ex2 = tgt.x - CX, ey2 = tgt.y - CY, el2 = len(ex2, ey2) || 1;
            var aim = ux * (ex2 / el2) + uy * (ey2 / el2);       // schiebt der Stoß Richtung Rand?
            if (aim > 0.05 && Math.random() < diff.dashUse) { b.ax = ux; b.ay = uy; dashNow(b, ux, uy, t); }
          }
        }
      }

      /* ================= Netz ================= */
      function broadcast(t, force) {
        if (!isMulti) return;
        if (!force && t - lastBroadcast < NET_MS) return;
        lastBroadcast = t;
        var ps = {};
        for (var i = 0; i < P.length; i++) {
          var p = P[i];
          ps[p.id] = { x: r1(p.x), y: r1(p.y), vx: r1(p.vx), vy: r1(p.vy), a: p.alive ? 1 : 0,
            f: Math.round(p.fallAt || 0), d: Math.round(p.dashUntil || 0), c: Math.round(p.cdUntil || 0) };
        }
        var patch = { t: Math.round(t), ph: phase, rd: roundIdx, at: Math.round(phaseAt), r: r1(platR),
          st: Math.round(playStart), ps: ps, w: wins, wn: matchWinner || null, rw: roundWinner || null };
        if (lastHit) patch.hit = lastHit;
        try { ctx.room.setShared(patch); } catch (e) {}
      }

      function applyShared(sh) {
        if (dead || !sh || !sh.ps) return;
        if (ctx.room.isHost()) return;                        // ich bin die Wahrheit
        var t = (typeof sh.t === 'number') ? sh.t : ctx.room.now();
        if (sh.ph) phase = sh.ph;
        if (sh.rd) roundIdx = sh.rd;
        if (typeof sh.at === 'number') phaseAt = sh.at;
        if (typeof sh.r === 'number') platR = sh.r;
        if (typeof sh.st === 'number') playStart = sh.st;
        if (sh.w) wins = sh.w;
        roundWinner = sh.rw || null;
        if (sh.wn) matchWinner = sh.wn;

        var seen = {}, ids = Object.keys(sh.ps);
        ids.forEach(function (id, i) {
          var d = sh.ps[id], p = byId[id];
          if (!p) { p = addPlayer(id, nameOf(id, i), colorIdxOf(id, i), false); p.x = d.x; p.y = d.y; p.dx = d.x; p.dy = d.y; }
          seen[id] = 1;
          p.x = d.x; p.y = d.y; p.vx = d.vx; p.vy = d.vy;
          p.alive = !!d.a; p.fallAt = d.f || 0; p.dashUntil = d.d || 0; p.cdUntil = d.c || 0;
          p.nt = t;
        });
        var keep = [];
        for (var i2 = 0; i2 < P.length; i2++) if (seen[P[i2].id]) keep.push(P[i2]); else delete byId[P[i2].id];
        P = keep;
        if (sh.hit && sh.hit.t && sh.hit.t !== lastHitSeen) {
          lastHitSeen = sh.hit.t;
          spawnHit(sh.hit.x, sh.hit.y, sh.hit.p || 0.5, ctx.room.now());
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
        if (isMulti && host && !wasHost) { lastDs = {}; }   // gerade zum Host befördert
        wasHost = host;

        /* --- Eingabe --- */
        var inp = readInput();
        var mp = me();
        if (mp && !mp.bot) {
          if (host) { mp.ax = inp.x; mp.ay = inp.y; }
        }
        if (isMulti && !host) {
          if (t - lastReport >= REPORT_MS) {
            lastReport = t;
            try { ctx.room.reportState({ ax: r1(inp.x), ay: r1(inp.y), ds: dashSeq }); } catch (e) {}
          }
        }

        if (host) {
          if (isMulti) {
            var ps = ctx.room.players(), map = {};
            ps.forEach(function (pl) { map[pl.id] = pl; });
            for (var i = 0; i < P.length; i++) {
              var p = P[i];
              if (p.id === ctx.me.id) continue;
              var pl2 = map[p.id];
              if (!pl2) { if (p.alive && !p.fallAt) { p.alive = false; p.gone = true; } continue; }
              var s = pl2.state || {};
              p.ax = (typeof s.ax === 'number') ? s.ax : 0;
              p.ay = (typeof s.ay === 'number') ? s.ay : 0;
              var ds = s.ds || 0;
              if (lastDs[p.id] == null) lastDs[p.id] = ds;
              else if (ds > lastDs[p.id]) { lastDs[p.id] = ds; dashNow(p, p.ax, p.ay, t); }
            }
          } else {
            for (var b = 0; b < P.length; b++) if (P[b].bot && P[b].alive && !P[b].fallAt) botThink(P[b], t);
          }
          stepAll(dt, t);
          hostPhases(t);
          broadcast(t, false);
        }

        /* --- Anzeige-Positionen --- */
        for (var k = 0; k < P.length; k++) {
          var q = P[k];
          if (host) { q.dx = q.x; q.dy = q.y; }
          else {
            var e = (t - q.nt) / 1000; if (e < 0) e = 0; if (e > 0.35) e = 0.35;
            var tx = q.x + q.vx * e, ty = q.y + q.vy * e;
            if (Math.abs(tx - q.dx) > 170 || Math.abs(ty - q.dy) > 170) { q.dx = tx; q.dy = ty; }
            else { var f = 1 - Math.exp(-14 * dt); q.dx += (tx - q.dx) * f; q.dy += (ty - q.dy) * f; }
          }
          if (q.alive && !q.fallAt && len(q.vx, q.vy) > 45) {
            q.trail.push({ x: q.dx, y: q.dy });
            if (q.trail.length > 10) q.trail.shift();
          } else if (q.trail.length) q.trail.shift();
        }
        if (!host && phase === 'play' && playStart) {   // Schrumpfen weich mitrechnen
          var el3 = t - playStart - GRACE_MS;
          if (el3 > 0) platR = Math.max(RMIN, Math.min(platR, R0 - el3 / 1000 * SHRINK));
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

      /* ================= Cues (Sound & Effekte, für Host UND Gast gleich) ================= */
      function cues(t) {
        var i, p;
        for (i = 0; i < P.length; i++) {
          p = P[i];
          if (p.fallAt && !cueFall[p.id]) {
            cueFall[p.id] = 1;
            if (App.Audio) App.Audio.sweep(560, 90, 0.6, { type: 'sine', peak: 0.1 });
            for (var j = 0; j < 10; j++) {
              var a = Math.random() * Math.PI * 2;
              parts.push({ x: p.dx, y: p.dy, vx: Math.cos(a) * 90, vy: Math.sin(a) * 90 + 60, t0: t, life: 600, c: p.color.rgb, r: 3 });
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
      }

      function spawnHit(x, y, pw, t) {
        var n = Math.round(4 + pw * 8);
        if (App.Audio && t - lastHitSfx > 90) {
          lastHitSfx = t;
          if (pw > 0.55) App.Audio.sfx('hit'); else App.Audio.blip(300 + pw * 400, 0.05, { type: 'square', peak: 0.05 });
        }
        for (var i = 0; i < n; i++) {
          var a = Math.random() * Math.PI * 2, sp = 60 + Math.random() * 260 * (0.4 + pw);
          parts.push({ x: x, y: y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, t0: t,
            life: 260 + Math.random() * 260, c: '234,255,224', r: 2 + Math.random() * 2.5 });
        }
      }
      function stepParts(t) {
        var out = [];
        for (var i = 0; i < parts.length; i++) if (t - parts[i].t0 < parts[i].life) out.push(parts[i]);
        parts = out;
        if (parts.length > 220) parts = parts.slice(parts.length - 220);
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
          if (matchWinner === ctx.me.id && App.Scores) App.Scores.winCurrent();   // ended-Sperre oben → genau einmal
          after(1300, function () {
            App.MG.endScreen(root, { players: ctx.room.players(), meId: ctx.me.id, onExit: ctx.onExit,
              format: function (n) { return (n || 0) + (n === 1 ? ' Sieg' : ' Siege'); } });
          });
        } else {
          var myWins = wins[ctx.me.id] || 0;
          var iWon = matchWinner === ctx.me.id;
          var base = myWins * 500 + soloElims * 120 + (iWon ? 900 : 0);
          var score = Math.round(base * diff.mult);
          var best = App.Storage.get('best_sumo', 0);
          var nb = score > best;
          if (nb) App.Storage.set('best_sumo', score);
          if (iWon && App.Scores) App.Scores.winCurrent();
          if (App.Audio) App.Audio.sfx(iWon ? 'win' : 'lose');
          after(1300, function () {
            App.MG.endScreen(root, {
              title: iWon ? '🏆 Arena-Meister!' : (matchWinner === 'draw' ? '🤝 Unentschieden' : '💥 Rausgerempelt'),
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
          var m = len(x, y);
          if (m > 1) { x /= m; y /= m; }
        }
        return { x: x, y: y };
      }
      function tryDash() {
        var t = tnow(), mp = me();
        if (!mp || phase !== 'play' || !mp.alive || mp.fallAt) return;
        if (t < mp.cdUntil) { if (App.Audio) App.Audio.blip(140, 0.05, { type: 'square', peak: 0.04 }); return; }
        var inp = readInput();
        if (App.Audio) App.Audio.sweep(180, 720, 0.18, { type: 'sawtooth', peak: 0.09 });
        if (hostMode()) dashNow(mp, inp.x, inp.y, t);
        else {
          dashSeq++;
          mp.cdUntil = t + DASH_CD;                    // lokale Rückmeldung, Host korrigiert
          lastReport = t;
          try { ctx.room.reportState({ ax: r1(inp.x), ay: r1(inp.y), ds: dashSeq }); } catch (e) {}
        }
      }

      function bindKeys() {
        var down = function (e) {
          var k = e.key;
          if (k === 'ArrowUp' || k === 'w' || k === 'W') { keys.u = true; e.preventDefault(); }
          else if (k === 'ArrowDown' || k === 's' || k === 'S') { keys.d = true; e.preventDefault(); }
          else if (k === 'ArrowLeft' || k === 'a' || k === 'A') { keys.l = true; e.preventDefault(); }
          else if (k === 'ArrowRight' || k === 'd' || k === 'D') { keys.r = true; e.preventDefault(); }
          else if (e.code === 'Space' || k === ' ') { e.preventDefault(); if (!e.repeat) tryDash(); }
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
          var sc = r.width / 120 || 1;                 // CSS-Größe → virtuelle Einheiten
          dx /= sc; dy /= sc;
          var m = len(dx, dy);
          if (m > R) { dx = dx / m * R; dy = dy / m * R; m = R; }
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
        root.appendChild(el('div', { class: 'glass smo-wait' }, [
          el('div', { class: 'smo-wait-ico' }, ['🥊']),
          el('h3', { class: 'neon' }, ['Sumo-Arena']),
          el('p', { class: 'hint-text' }, ['Warte auf Mitspieler … (2–6 Spieler)'])
        ]));
      }

      function buildStage(ps) {
        var roundEl = el('div', { class: 'smo-round' }, ['Runde 1 / ' + MAX_ROUNDS]);
        var statusEl = el('div', { class: 'smo-status' }, ['Gleich geht\'s los']);
        var dashEl = el('div', { class: 'smo-dchip' }, ['⚡ Dash']);
        var head = el('div', { class: 'smo-head glass' }, [roundEl, statusEl, dashEl]);

        var canvas = el('canvas', { class: 'smo-canvas', width: W, height: H });
        var stage = el('div', { class: 'smo-stage' }, [canvas]);

        var tags = el('div', { class: 'smo-tags' });
        var hint = el('p', { class: 'hint-text smo-hint' }, [
          TOUCH ? 'Joystick = bewegen · ⚡ = Dash (2 s) · Wer von der Plattform fällt, ist raus · Best of 5'
                : 'WASD / Pfeile = bewegen · LEERTASTE = Dash (2 s) · Wer von der Plattform fällt, ist raus · Best of 5'
        ]);

        var pad = null, knob = null, stickBase = null, dashBtn = null, dashFill = null;
        if (TOUCH) {
          knob = el('div', { class: 'smo-knob' });
          stickBase = el('div', { class: 'smo-stick' }, [el('div', { class: 'smo-stick-ring' }), knob]);
          dashFill = el('div', { class: 'smo-dash-fill' });
          dashBtn = el('button', { class: 'smo-dash', type: 'button' }, [dashFill, el('span', { class: 'smo-dash-t' }, ['⚡'])]);
          pad = el('div', { class: 'smo-pad' }, [stickBase, dashBtn]);
        }

        var board = null, boardWrap = null;
        if (isMulti) {
          board = App.MG.liveBoard(ctx.room, ctx.me.id, { format: function (n) { return (n || 0) + ' ⭐'; } });
          stops.push(board.stop);
          boardWrap = el('div', { class: 'smo-board glass' }, [el('div', { class: 'mg-field-title' }, ['🏆 Rundensiege']), board.root]);
        }

        var wrap = el('div', { class: 'smo-wrap' }, [head, stage, tags, pad, hint, boardWrap]);
        root.innerHTML = ''; root.appendChild(wrap);

        refs = { canvas: canvas, roundEl: roundEl, statusEl: statusEl, dashEl: dashEl, tags: tags,
          dashBtn: dashBtn, dashFill: dashFill };
        g = canvas.getContext('2d');
        headSig = ''; tagSig = '';

        listeners.forEach(function (l) { try { l.t.removeEventListener(l.ty, l.fn, l.opts); } catch (e) {} });
        listeners = [];
        bindKeys();
        if (TOUCH) {
          bindStick(stickBase, knob);
          addL(dashBtn, 'pointerdown', function (e) { e.preventDefault(); tryDash(); });
          addL(dashBtn, 'contextmenu', function (e) { e.preventDefault(); });
        }
        return refs;
      }

      function updateHead(t) {
        if (!refs) return;
        var mp = me();
        var st;
        if (phase === 'count') st = 'Bereit machen …';
        else if (phase === 'play') st = (playStart && t - playStart > GRACE_MS) ? '⚠ Plattform schrumpft!' : 'Rempeln!';
        else if (phase === 'roundend') st = roundWinner ? ((byId[roundWinner] ? byId[roundWinner].name : 'Jemand') + ' holt die Runde') : 'Unentschieden';
        else st = 'Match vorbei';
        var cd = 0;
        if (mp && t < mp.cdUntil) cd = (mp.cdUntil - t) / 1000;
        var dtxt = !mp || !mp.alive ? '💀 Raus' : (cd > 0 ? '⚡ ' + cd.toFixed(1) + ' s' : '⚡ Dash bereit');
        var sig = roundIdx + '|' + st + '|' + dtxt;
        if (sig !== headSig) {
          headSig = sig;
          refs.roundEl.textContent = roundIdx > MAX_ROUNDS ? '⚡ Entscheidung' : 'Runde ' + roundIdx + ' / ' + MAX_ROUNDS;
          refs.statusEl.textContent = st;
          refs.statusEl.className = 'smo-status' + (phase === 'play' && playStart && t - playStart > GRACE_MS ? ' is-warn' : '');
          refs.dashEl.textContent = dtxt;
          refs.dashEl.className = 'smo-dchip' + (cd > 0 || !mp || !mp.alive ? '' : ' is-ready');
        }
        if (refs.dashFill) {
          var pr = cd > 0 ? 1 - cd / (DASH_CD / 1000) : 1;
          refs.dashFill.style.transform = 'scaleY(' + pr.toFixed(3) + ')';
          if (refs.dashBtn) refs.dashBtn.classList.toggle('is-ready', pr >= 1);
        }
      }

      function updateTags() {
        if (!refs) return;
        var sig = '', i;
        for (i = 0; i < P.length; i++) sig += P[i].id + ':' + (wins[P[i].id] || 0) + ':' + (P[i].alive ? (P[i].fallAt ? 'f' : '1') : '0') + '|';
        if (sig === tagSig) return;
        tagSig = sig;
        refs.tags.innerHTML = '';
        for (i = 0; i < P.length; i++) {
          var p = P[i], w = wins[p.id] || 0;
          var stars = w > 0 ? new Array(w + 1).join('⭐') : '–';
          refs.tags.appendChild(el('div', {
            class: 'smo-tag' + (p.alive && !p.fallAt ? '' : ' is-out') + (p.id === ctx.me.id ? ' is-me' : ''),
            style: '--tc:' + p.color.hex + ';--tg:rgba(' + p.color.rgb + ',.35)'
          }, [
            el('span', { class: 'smo-dot' }),
            el('span', { class: 'smo-tag-n' }, [p.name + (p.id === ctx.me.id && isMulti ? ' (du)' : '')]),
            el('span', { class: 'smo-tag-w' }, [stars])
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
      function circle(x, y, r) { g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); }

      function draw(t) {
        if (!g) return;
        var i;
        /* Abgrund */
        var bg = g.createRadialGradient(CX, CY, 40, CX, CY, W * 0.72);
        bg.addColorStop(0, '#072114'); bg.addColorStop(0.55, '#04120b'); bg.addColorStop(1, '#010604');
        g.fillStyle = bg; g.fillRect(0, 0, W, H);
        /* Sporen im Abgrund */
        g.save();
        for (i = 0; i < spores.length; i++) {
          var s = spores[i];
          var yy = (s.y - (t / 1000 * s.sp)) % H; if (yy < 0) yy += H;
          var xx = s.x + Math.sin(t / 1400 + s.ph) * 12;
          g.fillStyle = 'rgba(157,255,122,' + (0.05 + 0.08 * (0.5 + 0.5 * Math.sin(t / 800 + s.ph))).toFixed(3) + ')';
          circle(xx, yy, s.r); g.fill();
        }
        g.restore();

        var shrinking = (phase === 'play' && playStart && t - playStart > GRACE_MS);

        /* Plattform */
        g.save();
        g.shadowColor = shrinking ? 'rgba(255,157,60,.55)' : 'rgba(57,255,20,.45)';
        g.shadowBlur = 40;
        var pg = g.createRadialGradient(CX - platR * 0.3, CY - platR * 0.35, platR * 0.1, CX, CY, platR);
        pg.addColorStop(0, '#124f2f'); pg.addColorStop(0.7, '#0a3120'); pg.addColorStop(1, '#052013');
        g.fillStyle = pg; circle(CX, CY, platR); g.fill();
        g.restore();

        g.save();
        g.lineWidth = 6;
        g.strokeStyle = shrinking ? 'rgba(255,157,60,.9)' : 'rgba(57,255,20,.75)';
        g.shadowColor = shrinking ? 'rgba(255,157,60,.8)' : 'rgba(57,255,20,.8)';
        g.shadowBlur = 22;
        circle(CX, CY, platR); g.stroke();
        g.restore();

        g.save();
        g.lineWidth = 2; g.strokeStyle = 'rgba(157,255,122,.14)';
        circle(CX, CY, platR * 0.66); g.stroke();
        circle(CX, CY, platR * 0.33); g.stroke();
        g.strokeStyle = 'rgba(157,255,122,.22)';
        g.beginPath(); g.moveTo(CX - 14, CY); g.lineTo(CX + 14, CY); g.moveTo(CX, CY - 14); g.lineTo(CX, CY + 14); g.stroke();
        g.restore();

        if (shrinking && platR > RMIN) {   // rotierender Warnring
          g.save();
          g.setLineDash([14, 16]); g.lineDashOffset = -(t / 26) % 30;
          g.lineWidth = 3; g.strokeStyle = 'rgba(255,77,109,.55)';
          circle(CX, CY, platR + 11); g.stroke();
          g.restore();
        }

        /* Partikel */
        g.save();
        for (i = 0; i < parts.length; i++) {
          var pa = parts[i], age = (t - pa.t0) / pa.life;
          if (age < 0 || age > 1) continue;
          var e = (t - pa.t0) / 1000;
          g.fillStyle = 'rgba(' + pa.c + ',' + ((1 - age) * 0.85).toFixed(3) + ')';
          circle(pa.x + pa.vx * e, pa.y + pa.vy * e, pa.r * (1 - age * 0.6)); g.fill();
        }
        g.restore();

        /* Kugeln */
        for (i = 0; i < P.length; i++) drawBall(P[i], t);

        /* Overlays */
        if (phase === 'count') {
          var lft = Math.ceil((phaseAt - t) / 1000);
          var txt = lft > 0 ? String(lft) : 'LOS!';
          var frac = 1 - ((phaseAt - t) / 1000 - Math.floor((phaseAt - t) / 1000));
          g.save();
          g.globalAlpha = 0.9;
          g.font = '900 ' + Math.round(120 + (1 - frac) * 24) + 'px "Segoe UI",system-ui,Roboto,Arial,sans-serif';
          g.textAlign = 'center'; g.textBaseline = 'middle';
          g.shadowColor = 'rgba(57,255,20,.85)'; g.shadowBlur = 30;
          g.fillStyle = '#eaffe2';
          g.fillText(txt, CX, CY);
          g.restore();
        } else if (phase === 'roundend' || phase === 'over') {
          var wn = phase === 'over' ? matchWinner : roundWinner;
          var wp = wn ? byId[wn] : null;
          var line1 = phase === 'over' ? (wn === ctx.me.id ? 'MATCH GEWONNEN!' : 'MATCH VORBEI')
            : (roundIdx > MAX_ROUNDS ? 'ENTSCHEIDUNG' : 'RUNDE ' + roundIdx);
          var line2 = wp ? (wp.name + ' gewinnt' + (phase === 'over' ? ' das Match' : ' die Runde')) : 'Unentschieden';
          g.save();
          g.fillStyle = 'rgba(2,10,6,.62)'; g.fillRect(0, CY - 92, W, 184);
          g.textAlign = 'center'; g.textBaseline = 'middle';
          g.font = '900 44px "Segoe UI",system-ui,Roboto,Arial,sans-serif';
          g.fillStyle = wp ? wp.color.hex : '#cfe4dc';
          g.shadowColor = wp ? 'rgba(' + wp.color.rgb + ',.7)' : 'rgba(207,228,220,.5)'; g.shadowBlur = 24;
          g.fillText(line1, CX, CY - 30);
          g.font = '800 30px "Segoe UI",system-ui,Roboto,Arial,sans-serif';
          g.fillStyle = '#eaffe2'; g.shadowBlur = 12;
          g.fillText(line2, CX, CY + 24);
          g.restore();
        }
      }

      function drawBall(p, t) {
        var sc = 1, al = 1, yo = 0, rot = 0;
        if (p.fallAt) {
          var pr = Math.min(1, (t - p.fallAt) / FALL_MS);
          sc = 1 - pr * 0.82; al = 1 - pr * 0.92; yo = pr * pr * 52; rot = pr * 2.4;
        } else if (!p.alive) return;
        if (al <= 0.02) return;
        var x = p.dx, y = p.dy + yo, r = PR * sc, c = p.color;
        var dashing = t < p.dashUntil;

        /* Spur */
        g.save();
        for (var i = 0; i < p.trail.length; i++) {
          var tp = p.trail[i], a = (i + 1) / p.trail.length;
          g.fillStyle = 'rgba(' + c.rgb + ',' + (a * 0.16 * al).toFixed(3) + ')';
          circle(tp.x, tp.y, r * (0.35 + a * 0.6)); g.fill();
        }
        g.restore();

        /* Schatten auf der Plattform */
        if (!p.fallAt) {
          g.save();
          g.fillStyle = 'rgba(0,0,0,.35)';
          g.beginPath(); g.ellipse(x + 4, y + 7, r * 0.95, r * 0.7, 0, 0, Math.PI * 2); g.fill();
          g.restore();
        }

        /* Abklingzeit-Ring */
        if (!p.fallAt && p.alive) {
          var ready = t >= p.cdUntil;
          var prg = ready ? 1 : 1 - (p.cdUntil - t) / DASH_CD;
          g.save();
          g.lineWidth = 3.5;
          g.strokeStyle = ready ? 'rgba(' + c.rgb + ',.85)' : 'rgba(' + c.rgb + ',.3)';
          if (ready) { g.shadowColor = 'rgba(' + c.rgb + ',.7)'; g.shadowBlur = 10; }
          g.beginPath(); g.arc(x, y, r + 7, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * prg); g.stroke();
          g.restore();
        }

        /* Körper */
        g.save();
        g.globalAlpha = al;
        g.translate(x, y); g.rotate(rot);
        if (dashing) { g.shadowColor = '#ffffff'; g.shadowBlur = 34; }
        else { g.shadowColor = 'rgba(' + c.rgb + ',.75)'; g.shadowBlur = 18; }
        var bgd = g.createRadialGradient(-r * 0.35, -r * 0.4, r * 0.1, 0, 0, r);
        bgd.addColorStop(0, '#ffffff');
        bgd.addColorStop(0.35, c.hex);
        bgd.addColorStop(1, 'rgba(' + c.rgb + ',.55)');
        g.fillStyle = bgd; circle(0, 0, r); g.fill();
        g.lineWidth = 2; g.strokeStyle = 'rgba(255,255,255,' + (dashing ? 0.95 : 0.5) + ')';
        circle(0, 0, r); g.stroke();
        /* Blickrichtung / Dash-Nase */
        g.rotate(Math.atan2(p.fy, p.fx));
        g.fillStyle = 'rgba(4,22,12,' + (dashing ? 0.9 : 0.55) + ')';
        g.beginPath(); g.moveTo(r * 0.25, -r * 0.32); g.lineTo(r * 0.82, 0); g.lineTo(r * 0.25, r * 0.32); g.closePath(); g.fill();
        g.restore();

        /* Name */
        if (!p.fallAt && p.alive) {
          g.save();
          g.font = '800 17px "Segoe UI",system-ui,Roboto,Arial,sans-serif';
          g.textAlign = 'center'; g.textBaseline = 'middle';
          var nm = p.name.length > 12 ? p.name.slice(0, 11) + '…' : p.name;
          var w = g.measureText(nm).width + 14;
          g.fillStyle = 'rgba(3,14,8,.72)';
          g.beginPath();
          var bx = x - w / 2, by = y - r - 27, bh = 20, br = 8;
          g.moveTo(bx + br, by); g.arcTo(bx + w, by, bx + w, by + bh, br);
          g.arcTo(bx + w, by + bh, bx, by + bh, br); g.arcTo(bx, by + bh, bx, by, br);
          g.arcTo(bx, by, bx + w, by, br); g.closePath(); g.fill();
          g.fillStyle = p.id === ctx.me.id ? '#ffffff' : c.hex;
          g.fillText(nm, x, by + bh / 2 + 1);
          g.restore();
        }
      }
    }
  };

  /* ============================ STYLES ============================ */
  function injectStyle() {
    UI.injectStyle('mg-sumo-css', [
      '.smo-wrap{display:flex;flex-direction:column;gap:12px;align-items:stretch;}',
      /* Kopfzeile */
      '.smo-head{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 16px;flex-wrap:wrap;}',
      '.smo-round{font-weight:900;font-size:clamp(13px,3.4vw,17px);color:var(--leaf);letter-spacing:.5px;white-space:nowrap;}',
      '.smo-status{flex:1;text-align:center;font-size:clamp(11px,3vw,13px);font-weight:800;color:var(--muted);',
      'text-transform:uppercase;letter-spacing:1.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      '.smo-status.is-warn{color:var(--bronze);text-shadow:0 0 10px rgba(224,138,60,.5);animation:smo-blink 1s ease-in-out infinite;}',
      '.smo-dchip{font-weight:900;font-size:clamp(12px,3.2vw,15px);color:var(--muted);border:1px solid var(--stroke);',
      'border-radius:999px;padding:4px 11px;background:rgba(4,16,10,.6);white-space:nowrap;font-variant-numeric:tabular-nums;}',
      '.smo-dchip.is-ready{color:var(--gold);border-color:rgba(255,210,63,.5);box-shadow:0 0 12px rgba(255,210,63,.3);}',
      /* Arena */
      '.smo-stage{width:100%;max-width:min(560px,100%);margin:0 auto;aspect-ratio:1 / 1;position:relative;}',
      '.smo-canvas{display:block;width:100%;height:100%;border-radius:20px;background:#020806;',
      'border:1px solid var(--stroke);box-shadow:0 0 44px rgba(57,255,20,.16),inset 0 0 60px rgba(0,0,0,.5);',
      'touch-action:none;user-select:none;-webkit-user-select:none;-webkit-tap-highlight-color:transparent;}',
      /* Spieler-Tags */
      '.smo-tags{display:flex;flex-wrap:wrap;gap:7px;justify-content:center;}',
      '.smo-tag{display:flex;align-items:center;gap:6px;padding:4px 10px;border-radius:999px;',
      'background:rgba(6,24,15,.72);border:1px solid var(--stroke);font-size:12px;font-weight:800;color:var(--silver);',
      'transition:opacity .25s ease,filter .25s ease;}',
      '.smo-tag.is-me{border-color:var(--tg);box-shadow:0 0 12px var(--tg);}',
      '.smo-tag.is-out{opacity:.34;filter:grayscale(.8);}',
      '.smo-tag.is-out .smo-tag-n{text-decoration:line-through;}',
      '.smo-dot{width:9px;height:9px;border-radius:50%;background:var(--tc);box-shadow:0 0 8px var(--tc);flex:none;}',
      '.smo-tag-n{max-width:112px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.smo-tag-w{font-size:10px;letter-spacing:-1px;color:var(--gold);}',
      '.smo-hint{margin:0;}',
      /* Touch-Steuerung */
      '.smo-pad{display:flex;align-items:center;justify-content:space-between;gap:16px;max-width:330px;margin:2px auto 0;width:100%;}',
      '.smo-stick{position:relative;width:120px;height:120px;border-radius:50%;flex:none;touch-action:none;',
      'background:radial-gradient(circle at 50% 40%,rgba(12,44,28,.9),rgba(3,14,8,.9));',
      'border:1px solid var(--stroke-2);box-shadow:inset 0 0 26px rgba(57,255,20,.12);}',
      '.smo-stick.is-on{border-color:var(--neon);box-shadow:0 0 20px rgba(57,255,20,.35),inset 0 0 26px rgba(57,255,20,.2);}',
      '.smo-stick-ring{position:absolute;inset:14px;border-radius:50%;border:1px dashed rgba(157,255,122,.25);}',
      '.smo-knob{position:absolute;left:50%;top:50%;width:52px;height:52px;margin:-26px 0 0 -26px;border-radius:50%;',
      'background:linear-gradient(180deg,var(--neon-soft,#6dff4d),var(--neon));box-shadow:0 0 18px rgba(57,255,20,.6);',
      'transition:transform .05s linear;pointer-events:none;}',
      '.smo-dash{position:relative;width:92px;height:92px;border-radius:50%;flex:none;overflow:hidden;',
      'border:2px solid var(--stroke-2);background:rgba(4,16,10,.85);color:var(--muted);font-size:34px;',
      'cursor:pointer;touch-action:none;user-select:none;-webkit-tap-highlight-color:transparent;font-family:inherit;}',
      '.smo-dash.is-ready{border-color:var(--gold);color:var(--gold);box-shadow:0 0 20px rgba(255,210,63,.45);}',
      '.smo-dash:active{transform:scale(.94);}',
      '.smo-dash-fill{position:absolute;left:0;right:0;bottom:0;height:100%;transform-origin:bottom;transform:scaleY(0);',
      'background:linear-gradient(180deg,rgba(255,210,63,.34),rgba(255,157,60,.18));pointer-events:none;}',
      '.smo-dash-t{position:relative;z-index:1;line-height:1;filter:drop-shadow(0 0 8px currentColor);}',
      /* Rangliste */
      '.smo-board{padding:14px;display:flex;flex-direction:column;gap:8px;}',
      '.smo-board .mg-scoreboard{max-height:260px;overflow-y:auto;}',
      /* Schwierigkeits-Auswahl */
      '.smo-intro{padding:26px 22px;display:flex;flex-direction:column;gap:12px;align-items:center;text-align:center;max-width:520px;margin:0 auto;}',
      '.smo-intro-ico{font-size:56px;line-height:1;filter:drop-shadow(0 0 16px rgba(57,255,20,.5));animation:smo-bob 1.8s ease-in-out infinite;}',
      '.smo-intro h2{margin:0;}',
      '.smo-diffs{display:flex;flex-direction:column;gap:9px;width:100%;max-width:330px;}',
      '.smo-diff{display:grid;grid-template-columns:auto 1fr auto;grid-template-rows:auto auto;gap:2px 12px;',
      'text-align:left;padding:11px 14px;align-items:center;}',
      '.smo-diff.is-on{border-color:var(--neon);box-shadow:0 0 16px rgba(57,255,20,.28);}',
      '.smo-diff-ico{grid-row:1 / span 2;font-size:26px;line-height:1;}',
      '.smo-diff-nm{font-weight:900;color:var(--leaf);font-size:15px;}',
      '.smo-diff-ds{grid-column:2;font-size:11px;color:var(--muted);font-weight:600;}',
      '.smo-diff-x{grid-row:1 / span 2;grid-column:3;font-size:11px;font-weight:900;color:var(--gold);white-space:nowrap;}',
      /* Warten */
      '.smo-wait{padding:44px;text-align:center;display:flex;flex-direction:column;gap:10px;align-items:center;max-width:440px;margin:0 auto;}',
      '.smo-wait-ico{font-size:52px;filter:drop-shadow(0 0 14px rgba(57,255,20,.5));animation:smo-bob 1.6s ease-in-out infinite;}',
      '@keyframes smo-bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-8px)}}',
      '@keyframes smo-blink{0%,100%{opacity:1}50%{opacity:.45}}'
    ].join(''));
  }
})();
