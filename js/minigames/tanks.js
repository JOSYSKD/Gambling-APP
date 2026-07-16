/* tanks.js — "Panzer-Duell": rundenbasiertes Artillerie-Duell (Worms / Scorched
 * Earth) im Neon-Dschungel.
 *
 * IDEE      Jeder Panzer steht auf einem Hügel einer zufälligen, ZERSTÖRBAREN
 *           Landschaft. Wer dran ist, stellt Winkel + Stärke ein und feuert.
 *           Der Wind (oben angezeigt) zieht die Kugel zur Seite. Der Einschlag
 *           sprengt einen Krater ins Gelände und macht Schaden nach Nähe
 *           (Volltreffer = 58). 100 Lebenspunkte, bei 0 ist der Panzer raus.
 *           Wer als Letzter lebt, gewinnt.
 * STEUERUNG Winkel-/Stärke-Slider (+ − / + Feintasten), Ziehen im Canvas
 *           (Richtung = Winkel, Abstand = Stärke) mit gepunkteter Flugbahn-
 *           Vorschau, Tastatur: ← → Winkel, ↑ ↓ Stärke, Leertaste = FEUER.
 *           30 s pro Zug — danach geht der Schuss automatisch raus.
 * PUNKTE    Schaden an Gegnern ×10 + verbleibende HP ×3 + 500 für den Sieg.
 * SOLO      Du gegen 2 Bots (Leicht / Normal / Schwer). Ein Bot schätzt seinen
 *           ersten Schuss ballistisch und korrigiert danach die Stärke aus dem
 *           beobachteten Reichweiten-Fehler (Stärke ~ sqrt(Soll/Ist)) — jeder
 *           weitere Schuss aufs selbe Ziel wird spürbar genauer.
 * SYNC      2–4 Spieler über room.shared (Host = Schiedsrichter):
 *             seed        -> alle bauen dieselbe Landschaft (deterministisch)
 *             order / hp  -> Zugreihenfolge + Lebenspunkte (nur der Host schreibt hp)
 *             wind / turn / turnStartAt -> aktueller Zug
 *             shot {n,by,angle,power,wind,at} -> der Schütze veröffentlicht NUR
 *               seine Eingabe; jeder Client simuliert die Flugbahn selbst mit
 *               festem Zeitschritt -> identischer Einschlag, gleiche Animation.
 *             craters[]   -> Liste aller Krater. Landschaft = f(seed, craters);
 *               wer einen Schuss verpasst hat, baut daraus alles neu auf.
 *           Eigene Schüsse/Ergebnisse werden immer AUCH lokal angewandt (das
 *           Lokal-Backend schickt einem die eigenen Writes nicht zurück).
 *           Alle Timer laufen über Wall-Clock (room.now bzw. Date.now), rAF
 *           zeichnet nur. cleanup() beendet Timer, rAF, Listener und room.on. */
(function () {
  'use strict';
  window.App = window.App || {}; App.Minigames = App.Minigames || {};
  var UI = App.UI, el = UI.el;

  /* ---------------- Virtuelles Schlachtfeld (Canvas skaliert per CSS) --------------- */
  var W = 960, H = 560;
  var GRAV = 260;            // px/s² Schwerkraft
  var WIND_ACC = 15;         // px/s² je Windpunkt
  var POWER_V = 4.4;         // Stärke 100 -> 440 px/s Mündungsgeschwindigkeit
  var MAX_WIND = 5;          // Wind liegt in [-5, +5]
  var DT = 1 / 240;          // fester Physik-Schritt -> überall identisch
  var SAMPLE = 4;            // jeder 4. Schritt kommt in die Flugbahn (60 Punkte/s)
  var SDT = DT * SAMPLE;
  var MAX_FLIGHT = 12;       // s, danach gilt der Schuss als verloren
  var BLAST = 62;            // px Wirkungsradius
  var CRATER = 44;           // px Kraterradius
  var MAX_DMG = 58;          // Schaden bei einem Volltreffer
  var TANK_W = 30, TANK_H = 13, BARREL = 21;
  var START_HP = 100, TURN_MS = 30000, BOOM_MS = 900;
  var PREVIEW_T = 0.8;       // s Flugbahn-Vorschau
  var COLORS = ['#39ff14', '#33e6d0', '#ffd23f', '#ff4d6d'];
  var BOT_NAMES = ['Bot Kaktus 🌵', 'Bot Liane 🌿'];

  var DIFFS = [
    { key: 'leicht', label: 'Leicht', icon: '🌱', desc: 'Zielt grob, tastet sich langsam heran', noise: 0.30, ang: 9, decay: 0.86, pre: 0, think: 1250 },
    { key: 'normal', label: 'Normal', icon: '🔥', desc: 'Rechnet mit, korrigiert solide nach', noise: 0.15, ang: 5, decay: 0.58, pre: 1, think: 1000 },
    { key: 'schwer', label: 'Schwer', icon: '💀', desc: 'Scharfschützen – sie sitzen schnell drauf', noise: 0.06, ang: 2, decay: 0.32, pre: 2, think: 800 }
  ];

  injectStyle();

  /* ---------------- kleine Helfer ---------------- */
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function toArr(v) {
    if (!v) return [];
    if (Array.isArray(v)) return v.slice();
    return Object.keys(v).sort(function (a, b) { return (+a) - (+b); }).map(function (k) { return v[k]; });
  }
  /* deterministischer Zufall (mulberry32) — gleicher Seed = gleiche Landschaft */
  function rng(seed) {
    var s = seed >>> 0;
    return function () {
      s = (s + 0x6D2B79F5) >>> 0;
      var t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* ---------------- Landschaft ---------------- */
  /* Grundgelände aus 4 überlagerten Sinuswellen + Plateaus unter den Panzern.
     Rein aus (seed, n) berechnet -> auf jedem Gerät bitgleich. */
  function makeTerrain(seed, n) {
    var r = rng(seed);
    var ground = new Float64Array(W);
    var oct = [
      { a: 34 + r() * 40, f: (0.5 + r() * 0.5) / 260, p: r() * 6.283 },
      { a: 14 + r() * 20, f: (1.2 + r() * 1.0) / 260, p: r() * 6.283 },
      { a: 6 + r() * 10, f: (3.0 + r() * 2.0) / 260, p: r() * 6.283 },
      { a: 2 + r() * 5, f: (7.0 + r() * 4.0) / 260, p: r() * 6.283 }
    ];
    var tilt = (r() - 0.5) * 90, base = H * 0.68;
    var x, i, h;
    for (x = 0; x < W; x++) {
      h = base + (x / W - 0.5) * tilt;
      for (i = 0; i < oct.length; i++) h -= oct[i].a * Math.sin(x * oct[i].f + oct[i].p);
      ground[x] = clamp(h, H * 0.34, H - 26);
    }
    /* Panzer-Standplätze gleichmäßig verteilt, mit etwas Streuung aus dem Seed */
    var margin = 70, span = W - margin * 2, xs = [];
    for (i = 0; i < n; i++) {
      var cx = margin + (i + 0.5) * (span / n) + (r() - 0.5) * (span / n) * 0.45;
      xs.push(clamp(Math.round(cx), 44, W - 44));
    }
    for (i = 0; i < n; i++) flatten(ground, xs[i]);
    return { ground: ground, xs: xs };
  }
  /* kleines Plateau unter einem Panzer (mit weichen Rändern) */
  function flatten(ground, cx) {
    var gy = ground[clamp(Math.round(cx), 0, W - 1)], half = 15, fade = 12, dx, xi, ad, t;
    for (dx = -(half + fade); dx <= half + fade; dx++) {
      xi = Math.round(cx) + dx;
      if (xi < 0 || xi >= W) continue;
      ad = Math.abs(dx);
      t = ad <= half ? 1 : (1 - (ad - half) / fade);
      ground[xi] = ground[xi] * (1 - t) + gy * t;
    }
  }
  /* Krater in die Höhenkarte sprengen: Oberfläche innerhalb des Kreises fällt
     auf die Kreis-Unterkante (Grundgestein bei H bleibt stehen). */
  function digCrater(ground, cx, cy, r) {
    var x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(W - 1, Math.ceil(cx + r)), x, dx, s, dy, top, bot, g;
    for (x = x0; x <= x1; x++) {
      dx = x - cx; s = r * r - dx * dx;
      if (s <= 0) continue;
      dy = Math.sqrt(s); top = cy - dy; bot = cy + dy; g = ground[x];
      if (g >= top && g < bot) ground[x] = Math.min(H, bot);
    }
  }
  function groundY(ground, x) { return ground[clamp(Math.round(x), 0, W - 1)]; }

  /* ---------------- Flugbahn (deterministisch, fester Zeitschritt) ---------------- */
  function muzzle(tk, angleDeg) {
    var rad = angleDeg * Math.PI / 180;
    return {
      x: tk.x + Math.cos(rad) * (BARREL + 6),
      y: tk.y - TANK_H - 4 - Math.sin(rad) * (BARREL + 6),
      rad: rad
    };
  }
  function simulate(ground, tanks, idx, angleDeg, power, wind, maxT) {
    var sh = tanks[idx], m = muzzle(sh, angleDeg);
    var v = power * POWER_V;
    var x = m.x, y = m.y;
    var vx = Math.cos(m.rad) * v, vy = -Math.sin(m.rad) * v;
    var ax = wind * WIND_ACC;
    var path = [{ x: x, y: y }];
    var steps = Math.floor((maxT || MAX_FLIGHT) / DT), hit = null, i, k, tk, t = 0;
    for (i = 1; i <= steps; i++) {
      vx += ax * DT; vy += GRAV * DT;
      x += vx * DT; y += vy * DT; t += DT;
      for (k = 0; k < tanks.length; k++) {
        tk = tanks[k];
        if (!tk.alive) continue;
        if (i < 4 && k === idx) continue;                       // nicht in der Mündung explodieren
        if (Math.abs(x - tk.x) <= TANK_W / 2 + 3 && y >= tk.y - TANK_H - 6 && y <= tk.y + 4) {
          hit = { x: x, y: y, type: 'tank', idx: k }; break;
        }
      }
      if (hit) break;
      if (x < -900 || x > W + 900 || y > H + 260) { hit = { x: x, y: y, type: 'lost' }; break; }
      if (x >= 0 && x < W && y >= groundY(ground, x)) { hit = { x: x, y: y, type: 'ground' }; break; }
      if (i % SAMPLE === 0) path.push({ x: x, y: y });
    }
    if (!hit) hit = { x: x, y: y, type: 'lost' };
    return { path: path, hit: hit, time: t };
  }
  /* Position auf der Flugbahn zum Zeitpunkt tSec (Wall-Clock -> Tab-sicher) */
  function pathAt(sim, tSec) {
    if (tSec >= sim.time) return { x: sim.hit.x, y: sim.hit.y };
    var f = tSec / SDT, i = Math.floor(f);
    if (i >= sim.path.length - 1) return { x: sim.hit.x, y: sim.hit.y };
    var a = sim.path[i], b = sim.path[i + 1], u = f - i;
    return { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u };
  }

  /* ================================================================== */
  App.Minigames.tanks = {
    id: 'tanks', title: 'Panzer-Duell', icon: '💥', order: 112,
    subtitle: 'Winkel, Stärke, Wind — sprengt euch weg!',
    single: true, multi: true, minPlayers: 2, maxPlayers: 4,

    render: function (root, ctx) {
      var isMulti = ctx.mode === 'multi';
      var myId = isMulti ? ctx.me.id : 'me';

      /* Wall-Clock: room.now() liefert bei manchen Backends keine Zahl ->
         dann auf Date.now() zurückfallen (die Lobby setzt startAt auch so). */
      function nowMs() {
        if (!isMulti) return Date.now();
        var t = ctx.room.now();
        return (typeof t === 'number' && isFinite(t)) ? t : Date.now();
      }

      /* ---- Aufräum-Register ---- */
      var deadFlag = false, raf = null, timers = [], stops = [], lst = [];
      function after(ms, fn) { var t = setTimeout(function () { if (!deadFlag) fn(); }, ms); timers.push(t); return t; }
      function addL(t, ty, fn, o) { t.addEventListener(ty, fn, o); lst.push({ t: t, ty: ty, fn: fn, o: o }); }
      function addStop(f) { if (f) stops.push(f); }
      function cleanup() {
        deadFlag = true;
        if (raf) { cancelAnimationFrame(raf); raf = null; }
        timers.forEach(clearTimeout); timers = [];
        stops.forEach(function (f) { try { f(); } catch (e) {} }); stops = [];
        lst.forEach(function (l) { try { l.t.removeEventListener(l.ty, l.fn, l.o); } catch (e) {} }); lst = [];
      }

      /* ---- Spielzustand ---- */
      var seed = 0, terr = null, ground = null, tanks = [], order = [];
      var craters = [], wind = 0, diff = DIFFS[1];
      var phase = 'aim';                      // aim | flight | boom | over
      var curTurn = { id: null, startAt: 0 }, wantTurn = null, curTurnIdx = -1;
      var curShot = null, lastShotN = 0, hpAppliedN = 0, boomAt = 0, boomHit = null;
      var overFlag = false, winnerId = null, finished = false, built = false;
      var myIdx = -1, myAngle = 45, myPower = 60, aiming = false;
      var pops = [], turnStop = null, lastShared = null, initDone = false, curView = '';

      /* ---- DOM ---- */
      var canvas = null, c2 = null, terrGrad = null, sky = null, hills = [], flies = [];
      var turnEl, timerEl, windEl, windFill, rosterEl, msgEl, panelEl, angIn, powIn, angVal, powVal, fireBtn;

      /* ---- Vorschau-Cache ---- */
      var pvKey = '', pvSim = null;

      if (isMulti) startMulti(); else showDiffPicker();
      return { cleanup: cleanup };

      /* ============================================================
       *  AUFBAU
       * ============================================================ */
      function makeTank(id, name, i, isBot) {
        return {
          id: id, name: name, color: COLORS[i % COLORS.length], bot: !!isBot,
          x: 0, y: 0, hp: START_HP, alive: true, deadShown: false, angle: 45, power: 60,
          dmg: 0, mem: {}, target: null, ui: null
        };
      }
      /* Panzer auf die Standplätze setzen (Slot-Reihenfolge aus dem Seed
         gemischt -> gleiche Zugreihenfolge, aber wechselnde Positionen). */
      function placeTanks() {
        var n = tanks.length, slots = [], i, r = rng(seed ^ 0x9e3779b9);
        for (i = 0; i < n; i++) slots.push(i);
        for (i = n - 1; i > 0; i--) { var j = Math.floor(r() * (i + 1)), t = slots[i]; slots[i] = slots[j]; slots[j] = t; }
        for (i = 0; i < n; i++) { tanks[i].x = terr.xs[slots[i]]; tanks[i].y = groundY(ground, tanks[i].x); }
        for (i = 0; i < n; i++) tanks[i].angle = tanks[i].x < W / 2 ? 55 : 125;
      }
      function rebuildTerrain() {
        terr = makeTerrain(seed, tanks.length);
        ground = terr.ground;
        for (var i = 0; i < craters.length; i++) digCrater(ground, craters[i].x, craters[i].y, craters[i].r || CRATER);
      }
      function settleTanks() { tanks.forEach(function (tk) { tk.y = groundY(ground, tk.x); }); }

      function buildWorld() {
        terr = makeTerrain(seed, tanks.length);
        ground = terr.ground;
        placeTanks();
        for (var i = 0; i < craters.length; i++) digCrater(ground, craters[i].x, craters[i].y, craters[i].r || CRATER);
        settleTanks();
        myIdx = idxOf(myId);
        if (myIdx >= 0) { myAngle = tanks[myIdx].angle; myPower = 60; }
        buildDecor();
        built = true;
      }
      /* Hintergrund-Deko (ferne Hügel + Glühwürmchen) — ebenfalls aus dem Seed */
      function buildDecor() {
        var r = rng(seed ^ 0x1234567), i, x, y;
        hills = [];
        for (i = 0; i < 2; i++) {
          var a1 = 18 + r() * 26, f1 = (0.6 + r() * 0.8) / 300, p1 = r() * 6.283;
          var a2 = 8 + r() * 14, f2 = (2.0 + r() * 1.5) / 300, p2 = r() * 6.283;
          var base = H * (0.52 + i * 0.09), pts = [];
          for (x = 0; x <= W; x += 12) pts.push({ x: x, y: base - a1 * Math.sin(x * f1 + p1) - a2 * Math.sin(x * f2 + p2) });
          hills.push({ pts: pts, fill: i === 0 ? '#07200f' : '#0a2b17' });
        }
        flies = [];
        for (i = 0; i < 26; i++) flies.push({ x: r() * W, y: 40 + r() * (H * 0.55), p: r() * 6.283, s: 0.5 + r() * 1.2, r: 1 + r() * 1.8 });
      }
      function idxOf(id) { for (var i = 0; i < tanks.length; i++) if (tanks[i].id === id) return i; return -1; }
      function aliveTanks() { return tanks.filter(function (t) { return t.alive; }); }
      function randWind() { return Math.round((Math.random() * 2 - 1) * MAX_WIND * 10) / 10; }
      function scoreOf(tk) { return Math.round(tk.dmg * 10 + Math.max(0, tk.hp) * 3 + (overFlag && winnerId === tk.id ? 500 : 0)); }

      /* ============================================================
       *  DOM / HUD
       * ============================================================ */
      function buildStage() {
        turnEl = el('div', { class: 'tnk-turn' }, ['—']);
        timerEl = el('div', { class: 'mg-timer tnk-timer' }, ['0:30']);
        windFill = el('i', { class: 'tnk-wind-fill' });
        windEl = el('span', { class: 'tnk-wind-val' }, ['0.0']);
        var head = el('div', { class: 'tnk-head glass' }, [
          el('div', { class: 'tnk-head-l' }, [
            el('span', { class: 'tnk-head-lab' }, ['Am Zug']), turnEl
          ]),
          el('div', { class: 'tnk-head-c' }, [
            el('span', { class: 'tnk-head-lab' }, ['🌬 Wind']),
            el('div', { class: 'tnk-wind' }, [
              el('div', { class: 'tnk-wind-bar' }, [windFill]), windEl
            ])
          ]),
          el('div', { class: 'tnk-head-r' }, [
            el('span', { class: 'tnk-head-lab' }, ['Zug-Zeit']), timerEl
          ])
        ]);

        rosterEl = el('div', { class: 'tnk-roster' });
        canvas = el('canvas', { class: 'tnk-canvas', width: W, height: H });
        var stage = el('div', { class: 'tnk-stage' }, [canvas]);
        msgEl = el('div', { class: 'tnk-msg' }, ['']);

        angVal = el('span', { class: 'tnk-val' }, ['45°']);
        powVal = el('span', { class: 'tnk-val tnk-val-pw' }, ['60']);
        angIn = el('input', { class: 'tnk-range', type: 'range', min: 0, max: 180, step: 1, value: 45 });
        powIn = el('input', { class: 'tnk-range tnk-range-pw', type: 'range', min: 5, max: 100, step: 1, value: 60 });
        fireBtn = el('button', { class: 'btn btn-primary tnk-fire', type: 'button' }, ['💥 FEUER']);

        panelEl = el('div', { class: 'tnk-panel glass' }, [
          el('div', { class: 'tnk-ctl' }, [
            el('div', { class: 'tnk-ctl-top' }, [el('span', { class: 'tnk-ctl-lab' }, ['🎯 Winkel']), angVal]),
            el('div', { class: 'tnk-ctl-row' }, [
              nudge('−', function () { setAim(myAngle - 1, myPower); }),
              angIn,
              nudge('+', function () { setAim(myAngle + 1, myPower); })
            ])
          ]),
          el('div', { class: 'tnk-ctl' }, [
            el('div', { class: 'tnk-ctl-top' }, [el('span', { class: 'tnk-ctl-lab' }, ['🔥 Stärke']), powVal]),
            el('div', { class: 'tnk-ctl-row' }, [
              nudge('−', function () { setAim(myAngle, myPower - 1); }),
              powIn,
              nudge('+', function () { setAim(myAngle, myPower + 1); })
            ])
          ]),
          fireBtn
        ]);

        var wrap = el('div', { class: 'tnk-wrap' }, [
          head, rosterEl, stage, msgEl, panelEl,
          el('p', { class: 'hint-text tnk-hint' }, [
            'Ins Bild ziehen (Richtung = Winkel, Abstand = Stärke) oder Slider · ← → Winkel · ↑ ↓ Stärke · Leertaste = Feuer · Volltreffer = 58 Schaden, Krater bleiben.'
          ])
        ]);
        root.innerHTML = ''; root.appendChild(wrap);

        c2 = canvas.getContext('2d');
        terrGrad = c2.createLinearGradient(0, H * 0.3, 0, H);
        terrGrad.addColorStop(0, '#1d6a37');
        terrGrad.addColorStop(0.45, '#0e3d20');
        terrGrad.addColorStop(1, '#04150b');
        sky = c2.createLinearGradient(0, 0, 0, H);
        sky.addColorStop(0, '#02110b');
        sky.addColorStop(0.55, '#04200f');
        sky.addColorStop(1, '#072a17');

        buildRoster();
        attachInput();
      }
      function nudge(txt, fn) {
        return el('button', {
          class: 'btn btn-ghost tnk-nudge', type: 'button',
          onclick: function () { if (canShoot()) { fn(); if (App.Audio) App.Audio.blip(560, 0.05, { peak: 0.05 }); } }
        }, [txt]);
      }
      function buildRoster() {
        rosterEl.innerHTML = '';
        tanks.forEach(function (tk) {
          var fill = el('i', { class: 'tnk-hp-fill' });
          fill.style.background = tk.color;
          var hpEl = el('span', { class: 'tnk-hp-num' }, ['100']);
          var ptsEl = el('span', { class: 'tnk-pts' }, ['0 P']);
          var dot = el('i', { class: 'tnk-dot' }); dot.style.background = tk.color;
          var chip = el('div', { class: 'tnk-chip' }, [
            el('div', { class: 'tnk-chip-top' }, [
              dot, el('span', { class: 'tnk-nm' }, [tk.name + (tk.id === myId ? ' (du)' : '')]), hpEl
            ]),
            el('div', { class: 'tnk-hp' }, [fill]),
            ptsEl
          ]);
          chip.style.setProperty('--tnk-c', tk.color);
          tk.ui = { chip: chip, fill: fill, hpEl: hpEl, ptsEl: ptsEl };
          rosterEl.appendChild(chip);
        });
      }
      function paintHud() {
        if (!built || !rosterEl) return;
        tanks.forEach(function (tk) {
          if (!tk.ui) return;
          tk.ui.fill.style.width = Math.max(0, tk.hp) + '%';
          tk.ui.hpEl.textContent = tk.alive ? String(Math.max(0, Math.round(tk.hp))) : '☠';
          tk.ui.ptsEl.textContent = App.MG.fmt(scoreOf(tk)) + ' P';
          tk.ui.chip.classList.toggle('active', tk.alive && curTurn.id === tk.id);
          tk.ui.chip.classList.toggle('dead', !tk.alive);
          tk.ui.chip.classList.toggle('me', tk.id === myId);
        });
        var cur = curTurnIdx >= 0 ? tanks[curTurnIdx] : null;
        turnEl.textContent = cur ? (cur.id === myId ? 'Du 🎯' : cur.name) : '—';
        turnEl.style.color = cur ? cur.color : '';
        windEl.textContent = (wind < 0 ? '⬅ ' : '➡ ') + Math.abs(wind).toFixed(1);
        windEl.className = 'tnk-wind-val' + (Math.abs(wind) >= 3.2 ? ' strong' : '');
        windFill.style.width = (Math.abs(wind) / MAX_WIND * 50) + '%';
        windFill.style.left = wind < 0 ? (50 - Math.abs(wind) / MAX_WIND * 50) + '%' : '50%';
        var can = canShoot();
        angIn.disabled = !can; powIn.disabled = !can; fireBtn.disabled = !can;
        panelEl.classList.toggle('locked', !can);
      }
      function setMsg(t, cls) { if (msgEl) { msgEl.textContent = t; msgEl.className = 'tnk-msg' + (cls ? ' ' + cls : ''); } }
      function canShoot() { return !deadFlag && !finished && phase === 'aim' && !overFlag && curTurnIdx >= 0 && tanks[curTurnIdx] && tanks[curTurnIdx].id === myId && tanks[curTurnIdx].alive; }
      function setAim(a, p) {
        myAngle = clamp(Math.round(a * 10) / 10, 0, 180);
        myPower = clamp(Math.round(p), 5, 100);
        if (myIdx >= 0) { tanks[myIdx].angle = myAngle; tanks[myIdx].power = myPower; }
        angIn.value = String(Math.round(myAngle));
        powIn.value = String(myPower);
        angVal.textContent = myAngle.toFixed(0) + '°';
        powVal.textContent = String(myPower);
      }

      /* ---------------- Eingabe ---------------- */
      function attachInput() {
        addL(angIn, 'input', function () { if (canShoot()) setAim(+angIn.value, myPower); else setAim(myAngle, myPower); });
        addL(powIn, 'input', function () { if (canShoot()) setAim(myAngle, +powIn.value); else setAim(myAngle, myPower); });
        addL(fireBtn, 'click', function () { if (App.Audio) App.Audio.sfx('click'); fireMine(); });

        addL(canvas, 'pointerdown', function (e) {
          if (!canShoot()) return;
          e.preventDefault(); aiming = true;
          try { canvas.setPointerCapture(e.pointerId); } catch (err) {}
          aimFrom(e);
        });
        addL(canvas, 'pointermove', function (e) { if (aiming && canShoot()) { e.preventDefault(); aimFrom(e); } });
        var stopAim = function () { aiming = false; };
        addL(canvas, 'pointerup', stopAim);
        addL(canvas, 'pointercancel', stopAim);
        addL(canvas, 'pointerleave', stopAim);

        addL(document, 'keydown', function (e) {
          if (!canShoot()) return;
          var k = e.key, big = e.shiftKey ? 5 : 1;
          if (k === 'ArrowLeft') { setAim(myAngle + big, myPower); e.preventDefault(); }
          else if (k === 'ArrowRight') { setAim(myAngle - big, myPower); e.preventDefault(); }
          else if (k === 'ArrowUp') { setAim(myAngle, myPower + big); e.preventDefault(); }
          else if (k === 'ArrowDown') { setAim(myAngle, myPower - big); e.preventDefault(); }
          else if (k === ' ' || k === 'Enter') { e.preventDefault(); fireMine(); }
        });
      }
      function aimFrom(e) {
        var r = canvas.getBoundingClientRect();
        if (!r.width || !r.height || myIdx < 0) return;
        var vx = (e.clientX - r.left) / r.width * W, vy = (e.clientY - r.top) / r.height * H;
        var tk = tanks[myIdx];
        var dx = vx - tk.x, dy = (tk.y - TANK_H - 4) - vy;
        var ang = Math.atan2(Math.max(dy, 0.0001), dx) * 180 / Math.PI;
        var dist = Math.sqrt(dx * dx + dy * dy);
        setAim(ang, clamp(dist / 3.1, 5, 100));
      }

      /* ============================================================
       *  SCHUSS / EINSCHLAG (identisch für Solo & Multi)
       * ============================================================ */
      function fireMine() {
        if (!canShoot()) return;
        var shot = { n: lastShotN + 1, by: myId, angle: myAngle, power: myPower, wind: wind, at: nowMs() };
        startShot(shot);                                   // sofort lokal — kein Warten aufs Netz
        if (isMulti) { try { ctx.room.setShared({ shot: shot }); } catch (e) {} }
      }
      function startShot(shot) {
        var idx = idxOf(shot.by);
        /* Schuss eines (hier) unbekannten/toten Panzers: Nummer trotzdem
           mitzählen, sonst spielt ihn ein späterer Heartbeat verspätet nach. */
        if (idx < 0 || !tanks[idx].alive) { if (shot.n > lastShotN) lastShotN = shot.n; return; }
        lastShotN = shot.n;
        var tk = tanks[idx];
        tk.angle = shot.angle; tk.power = shot.power;
        /* Start der Animation: bei plausibler Uhr am Sende-Zeitpunkt ausrichten
           (Latenz-Ausgleich), sonst lokal starten -> nie ein übersprungener Flug. */
        var n = nowMs(), d = n - (shot.at || n);
        var start = (d >= 0 && d < 1500) ? shot.at : n;
        curShot = { n: shot.n, idx: idx, start: start, sim: simulate(ground, tanks, idx, shot.angle, shot.power, shot.wind, MAX_FLIGHT) };
        phase = 'flight'; aiming = false;
        if (turnStop) { turnStop(); turnStop = null; }
        if (timerEl) { timerEl.textContent = '–'; timerEl.classList.remove('tnk-urgent'); }
        if (App.Audio) { App.Audio.sfx('whoosh'); App.Audio.blip(180 + shot.power * 2, 0.09, { type: 'square', peak: 0.06 }); }
        setMsg(tk.name + ' feuert — ' + Math.round(shot.angle) + '° / Stärke ' + Math.round(shot.power), 'fire');
        paintHud();
      }
      function computeDamage(hit) {
        var out = [], i, tk, dx, dy, d, dm;
        for (i = 0; i < tanks.length; i++) {
          tk = tanks[i]; if (!tk.alive) continue;
          dx = hit.x - tk.x; dy = hit.y - (tk.y - TANK_H / 2);
          d = Math.sqrt(dx * dx + dy * dy);
          dm = 0;
          if (hit.type === 'tank' && hit.idx === i) dm = MAX_DMG;
          else if (d < BLAST) dm = Math.max(1, Math.round(MAX_DMG * (1 - d / BLAST)));
          if (dm > 0) out.push({ i: i, dmg: dm, direct: hit.type === 'tank' && hit.idx === i });
        }
        return out;
      }
      function addCrater(cr) {
        for (var i = 0; i < craters.length; i++) if (craters[i].n === cr.n) return false;
        craters.push(cr); digCrater(ground, cr.x, cr.y, cr.r); settleTanks(); pvKey = '';
        return true;
      }
      function doImpact() {
        var sim = curShot.sim, hit = sim.hit, n = curShot.n, shooter = tanks[curShot.idx];
        phase = 'boom'; boomAt = nowMs(); boomHit = hit;
        if (hit.type === 'lost') {
          if (App.Audio) App.Audio.sfx('info');
          setMsg('Daneben — der Schuss ist im Nichts verschwunden.', 'miss');
        } else {
          if (App.Audio) App.Audio.sfx('explosion');
          var hits = computeDamage(hit);                    // Schaden VOR dem Krater (Positionen von jetzt)
          addCrater({ n: n, x: hit.x, y: hit.y, r: CRATER });
          /* War das Host-Ergebnis für DIESEN Schuss schon da (es kann ein paar
             Frames vor der eigenen Animation eintreffen), sind die HP bereits
             verbindlich gesetzt -> Schaden NICHT ein zweites Mal abziehen. */
          var authDone = hpAppliedN >= n;
          if (!authDone) hpAppliedN = n;
          var best = null;
          hits.forEach(function (h) {
            var tk = tanks[h.i];
            if (!authDone) {
              tk.hp = Math.max(0, tk.hp - h.dmg);
              if (h.i !== curShot.idx) shooter.dmg += h.dmg;
            }
            pops.push({ x: tk.x, y: tk.y - TANK_H - 22, txt: '-' + h.dmg, at: boomAt, color: '#ff8098' });
            if (!best || h.dmg > best.dmg) best = h;
            if (tk.hp <= 0 && !tk.deadShown) {
              tk.deadShown = true; tk.alive = false;
              pops.push({ x: tk.x, y: tk.y - TANK_H - 44, txt: '💀 ' + tk.name, at: boomAt + 180, color: '#ffd23f' });
              after(220, function () { if (App.Audio) App.Audio.sfx('bust'); });
            }
          });
          if (best) {
            if (App.Audio) after(90, function () { App.Audio.sfx('hit'); });
            if (best.direct && tanks[best.i].id === myId && best.i === curShot.idx) setMsg('Autsch! Du hast dich selbst erwischt (−' + best.dmg + ').', 'bad');
            else if (best.direct) setMsg('🎯 VOLLTREFFER auf ' + tanks[best.i].name + ' (−' + best.dmg + ')!', 'good');
            else setMsg('💥 Treffer in der Nähe: ' + tanks[best.i].name + ' −' + best.dmg, 'good');
          } else if (Math.abs(hit.x - shooter.x) < 42) {
            setMsg('Direkt in den eigenen Hügel gerauscht …', 'miss');
          } else {
            setMsg('Einschlag — nur Erde bewegt.', 'miss');
          }
          /* Bots lernen aus dem beobachteten Reichweiten-Fehler */
          if (!isMulti && shooter.bot) botLearn(shooter, hit);
        }
        if (isMulti) { try { ctx.room.reportScore(scoreOf(tanks[myIdx])); } catch (e) {} }
        paintHud();
        if (!isMulti) soloResolve();
        else if (ctx.room.isHost()) hostPublish(n);
      }
      function nextAliveId(fromId) {
        var i = order.indexOf(fromId); if (i < 0) i = 0;
        for (var k = 1; k <= order.length; k++) {
          var id = order[(i + k) % order.length], t = tanks[idxOf(id)];
          if (t && t.alive) return id;
        }
        return null;
      }
      function beginTurn(t) {
        curTurn = { id: t.id, startAt: t.startAt };
        curTurnIdx = idxOf(t.id);
        aiming = false;
        var tk = curTurnIdx >= 0 ? tanks[curTurnIdx] : null;
        if (!tk || !tk.alive) { paintHud(); return; }        // Host korrigiert das gleich
        if (tk.id === myId) {
          setAim(tk.angle, myPower);
          if (App.Audio) App.Audio.sfx('ding');
          setMsg('Du bist dran — zielen und feuern!', 'you');
        } else {
          setMsg(tk.name + ' zielt …', 'opp');
        }
        startTurnTimer(t.startAt);
        if (tk.bot) scheduleBot(tk);
        pvKey = '';
        paintHud();
      }
      function startTurnTimer(startAt) {
        if (turnStop) { turnStop(); turnStop = null; }
        turnStop = App.MG.roundTimer(startAt + TURN_MS, function (left) {
          if (!timerEl) return;
          timerEl.textContent = App.MG.mmss(Math.min(TURN_MS / 1000, left));
          timerEl.classList.toggle('tnk-urgent', left <= 6);
        }, function () {
          if (deadFlag) return;
          if (canShoot()) { UI.toast('Zeit um — der Schuss geht raus!', 'info'); fireMine(); }
        }, nowMs);
        addStop(turnStop);
      }

      /* ============================================================
       *  SOLO
       * ============================================================ */
      function showDiffPicker() {
        curView = 'diff';
        root.innerHTML = '';
        root.appendChild(el('div', { class: 'tnk-intro glass' }, [
          el('div', { class: 'tnk-intro-icon' }, ['💥']),
          el('h2', { class: 'neon' }, ['Panzer-Duell']),
          el('p', { class: 'hint-text' }, ['Du gegen 2 Bots: Winkel + Stärke einstellen, Wind beachten, Krater sprengen. Der letzte Panzer gewinnt.']),
          el('div', { class: 'tnk-diffs' }, DIFFS.map(function (d) {
            return el('button', {
              class: 'tnk-diff', type: 'button',
              onclick: function () { if (App.Audio) App.Audio.sfx('select'); startSolo(d); }
            }, [
              el('span', { class: 'tnk-diff-ic' }, [d.icon]),
              el('span', { class: 'tnk-diff-nm neon' }, [d.label]),
              el('span', { class: 'tnk-diff-ds' }, [d.desc])
            ]);
          })),
          el('div', { class: 'controls-row' }, [
            el('button', { class: 'btn btn-ghost', type: 'button', onclick: ctx.onExit }, ['Zurück'])
          ])
        ]));
      }
      function startSolo(d) {
        curView = 'game';
        diff = d;
        timers.forEach(clearTimeout); timers = [];
        stops.forEach(function (f) { try { f(); } catch (e) {} }); stops = [];
        turnStop = null;
        seed = (Math.random() * 0x7fffffff) | 0;
        craters = []; pops = []; lastShotN = 0; hpAppliedN = 0; curShot = null;
        overFlag = false; winnerId = null; finished = false; built = false;
        phase = 'aim'; curTurn = { id: null, startAt: 0 }; curTurnIdx = -1; wantTurn = null;
        wind = randWind();
        tanks = [makeTank('me', (ctx.me && ctx.me.name) ? ctx.me.name : 'Du', 0, false)];
        tanks.push(makeTank('bot1', BOT_NAMES[0], 1, true));
        tanks.push(makeTank('bot2', BOT_NAMES[1], 2, true));
        order = tanks.map(function (t) { return t.id; });
        buildStage();
        buildWorld();
        setAim(tanks[myIdx].angle, 60);
        wantTurn = { id: 'me', startAt: nowMs() + 300 };
        setMsg('Wind beachten — viel Erfolg!', 'you');
        paintHud();
        if (raf) cancelAnimationFrame(raf);
        raf = requestAnimationFrame(loop);
      }
      function soloResolve() {
        var alive = aliveTanks();
        if (alive.length <= 1) { overFlag = true; winnerId = alive[0] ? alive[0].id : null; return; }
        wind = randWind();
        var nx = nextAliveId(curTurn.id);
        if (nx) wantTurn = { id: nx, startAt: nowMs() + BOOM_MS + 250 };
      }

      /* ---------------- Bot-KI ---------------- */
      /* 1. Ziel wählen (nah + schwach, der Mensch wird leicht bevorzugt)
         2. erster Schuss: ballistische Schätzung OHNE Wind
         3. je nach Stufe 0–2 "Erfahrungs"-Korrekturen im Kopf (interne Simulation)
         4. Restunschärfe drauf, die pro Versuch aufs selbe Ziel schrumpft
         5. nach dem Einschlag: echte Korrektur aus dem Reichweiten-Fehler */
      function pickTarget(tk) {
        if (tk.target) { var t = tanks[idxOf(tk.target)]; if (t && t.alive) return t; }
        var best = null, bs = Infinity;
        tanks.forEach(function (o) {
          if (!o.alive || o.id === tk.id) return;
          var s = Math.abs(o.x - tk.x) * (o.bot ? 1 : 0.6) + o.hp * 0.8;
          if (s < bs) { bs = s; best = o; }
        });
        tk.target = best ? best.id : null;
        return best;
      }
      function ballisticGuess(from, to) {
        var x0 = from.x, y0 = from.y - TANK_H - 6;
        var X = to.x - x0, Y = -(to.y - TANK_H / 2 - y0), dir = X >= 0 ? 1 : -1;
        var ax = Math.max(1, Math.abs(X)), best = null, a, th, den, v2, p, s;
        for (a = 25; a <= 82; a += 1) {
          th = a * Math.PI / 180;
          den = 2 * Math.cos(th) * Math.cos(th) * (ax * Math.tan(th) - Y);
          if (den <= 0) continue;
          v2 = GRAV * ax * ax / den;
          if (v2 <= 0) continue;
          p = Math.sqrt(v2) / POWER_V;
          if (p < 8 || p > 98) continue;
          s = Math.abs(p - 68) + Math.abs(a - 55) * 0.35;
          if (!best || s < best.s) best = { s: s, a: a, p: p };
        }
        if (!best) return { angle: dir > 0 ? 55 : 125, power: 88 };
        return { angle: dir > 0 ? best.a : 180 - best.a, power: best.p };
      }
      function botDecide(tk) {
        var target = pickTarget(tk);
        if (!target) return { angle: tk.angle, power: 50 };
        var m = tk.mem[target.id], angle, power, i, want = Math.abs(target.x - tk.x);

        if (m && typeof m.range === 'number') {
          /* Korrektur aus dem letzten Fehler: Reichweite ~ v² -> Stärke ~ sqrt(Soll/Ist) */
          angle = m.angle;
          if (m.range < 40) { angle = clamp(angle > 90 ? angle - 12 : angle + 12, 12, 168); power = m.power; }
          else power = m.power * clamp(Math.sqrt(want / m.range), 0.7, 1.45);
          m.noise = m.noise * diff.decay;
        } else {
          var g = ballisticGuess(tk, target);
          angle = g.angle; power = g.power;
          m = tk.mem[target.id] = { noise: diff.noise };
          /* "Erfahrung": im Kopf durchrechnen und die Stärke nachziehen (mit Wind) */
          for (i = 0; i < diff.pre; i++) {
            var sim = simulate(ground, tanks, idxOf(tk.id), angle, power, wind, MAX_FLIGHT);
            var got = Math.abs(sim.hit.x - tk.x);
            if (got < 40) { angle = clamp(angle > 90 ? angle - 10 : angle + 10, 12, 168); continue; }
            power = power * clamp(Math.sqrt(want / got), 0.7, 1.45);
          }
        }
        power = clamp(power * (1 + (Math.random() * 2 - 1) * m.noise), 6, 100);
        angle = clamp(angle + (Math.random() * 2 - 1) * diff.ang * (m.noise / diff.noise), 8, 172);
        m.angle = angle; m.power = power; m.target = target.id;
        return { angle: angle, power: power };
      }
      function botLearn(tk, hit) {
        var key = tk.target; if (!key || !tk.mem[key]) return;
        tk.mem[key].range = Math.abs(hit.x - tk.x);          // tatsächlich erreichte Reichweite
        var t = tanks[idxOf(key)];
        if (t && !t.alive) { tk.target = null; }              // Ziel erledigt -> neu wählen
      }
      function scheduleBot(tk) {
        var mine = curTurn.id, plan = null;
        after(Math.round(diff.think * 0.45), function () {
          if (curTurn.id !== mine || phase !== 'aim') return;
          plan = botDecide(tk);
          tk.angle = plan.angle; tk.power = plan.power;       // Rohr sichtbar einschwenken
          pvKey = '';
        });
        after(diff.think + Math.round(Math.random() * 350), function () {
          if (curTurn.id !== mine || phase !== 'aim' || !tk.alive) return;
          if (!plan) plan = botDecide(tk);
          startShot({ n: lastShotN + 1, by: tk.id, angle: plan.angle, power: plan.power, wind: wind, at: nowMs() });
        });
      }

      /* ============================================================
       *  MULTIPLAYER
       * ============================================================ */
      function startMulti() {
        var snap = ctx.room.snapshot() || {};
        var startAt = (snap.round && snap.round.startAt) || (nowMs() + 3000);
        addStop(App.MG.countdown(root, startAt, function () { playMulti(startAt); }, nowMs));
      }
      function playMulti(startAt) {
        curView = 'game';
        var ps = ctx.room.players();
        if (ps.length < 2) { showWaiting(); return; }
        order = ps.slice(0, 4).map(function (p) { return p.id; });
        tanks = ps.slice(0, 4).map(function (p, i) { return makeTank(p.id, p.name, i, false); });
        craters = []; pops = []; lastShotN = 0; hpAppliedN = 0; curShot = null;
        overFlag = false; winnerId = null; finished = false; built = false;
        phase = 'aim'; curTurn = { id: null, startAt: 0 }; curTurnIdx = -1; wantTurn = null;

        var sharedH = function (sh) { if (!deadFlag) applyShared(sh); };
        var playersH = function () { if (!deadFlag) hostCheckPlayers(); };
        ctx.room.on('shared', sharedH);
        ctx.room.on('players', playersH);
        addStop(function () { ctx.room.off('shared', sharedH); ctx.room.off('players', playersH); });

        var sh0 = (ctx.room.snapshot() || {}).shared || null;
        if (ctx.room.isHost() && (!sh0 || !sh0.seed) && !initDone) {
          initDone = true;
          var hp = {};
          order.forEach(function (id) { hp[id] = START_HP; });
          var init = {
            seed: (Math.random() * 0x7fffffff) | 0, order: order, hp: hp, hpN: 0,
            craters: [], wind: randWind(), turn: order[0],
            turnStartAt: Math.max(startAt, nowMs()) + 800, over: false, winner: null
          };
          try { ctx.room.setShared(init); } catch (e) {}
          applyShared(init);
        } else if (sh0 && sh0.seed) {
          applyShared(sh0);
        } else {
          showPrep();
        }
        try { ctx.room.reportScore(0); } catch (e) {}

        /* Host-Wachhund: hängengebliebene Züge (Tab zu, Netz weg) weiterschalten */
        var wd = setInterval(function () {
          if (deadFlag || !ctx.room.isHost() || overFlag || finished) return;
          if (phase === 'flight' || phase === 'boom') return;
          if (!lastShared || !lastShared.turn) return;
          if (nowMs() - (lastShared.turnStartAt || 0) > TURN_MS + 22000) hostSkipTurn();
        }, 3000);
        addStop(function () { clearInterval(wd); });

        if (raf) cancelAnimationFrame(raf);
        raf = requestAnimationFrame(loop);
      }
      function showPrep() {
        if (curView === 'prep') return;
        curView = 'prep';
        root.innerHTML = '';
        root.appendChild(el('div', { class: 'tnk-intro glass' }, [
          el('div', { class: 'tnk-intro-icon' }, ['💥']),
          el('h2', { class: 'neon' }, ['Panzer-Duell']),
          el('p', { class: 'hint-text' }, ['Schlachtfeld wird ausgehoben …'])
        ]));
      }
      function showWaiting() {
        curView = 'wait';
        root.innerHTML = '';
        root.appendChild(el('div', { class: 'tnk-intro glass' }, [
          el('div', { class: 'tnk-intro-icon' }, ['💥']),
          el('h2', { class: 'neon' }, ['Panzer-Duell']),
          el('p', { class: 'hint-text' }, ['Warte auf Mitspieler …']),
          el('div', { class: 'controls-row' }, [
            el('button', { class: 'btn btn-ghost', type: 'button', onclick: ctx.onExit }, ['Zurück zur Lobby'])
          ])
        ]));
      }
      /* Landschaft = f(seed, craters): fehlt uns ein Krater, bauen wir alles neu.
         Die Liste wächst nur -> nie schrumpfen lassen (sonst flackert der Boden). */
      function syncCraters(list) {
        if (list.length > craters.length) {
          craters = list.slice();
          rebuildTerrain(); settleTanks(); pvKey = '';
        }
      }
      /* Der Host ist die Wahrheit — in BEIDE Richtungen. Ein nur lokal (z. B. durch
         eine Kollision zweier Updates) totgeglaubter Panzer muss auch wieder
         auferstehen können, sonst ignoriert dieser Client dessen Schüsse für immer
         und das Spiel bleibt stehen. */
      function applyHp(map) {
        tanks.forEach(function (tk) {
          if (typeof map[tk.id] !== 'number') return;
          tk.hp = Math.max(0, map[tk.id]);
          tk.alive = tk.hp > 0;
          if (tk.alive) tk.deadShown = false;
        });
      }
      function applyShared(sh) {
        if (!sh || !sh.seed) return;
        lastShared = sh;
        if (!built) {
          seed = sh.seed;
          var ord = toArr(sh.order);
          if (ord.length) {
            /* Reihenfolge des Hosts übernehmen (Panzer entsprechend sortieren) */
            var by = {}; tanks.forEach(function (t) { by[t.id] = t; });
            var sorted = [];
            ord.forEach(function (id, i) { var t = by[id] || makeTank(id, 'Spieler ' + (i + 1), i, false); t.color = COLORS[i % COLORS.length]; sorted.push(t); });
            tanks = sorted; order = ord;
          }
          craters = toArr(sh.craters);
          buildStage();
          buildWorld();
          setAim(myIdx >= 0 ? tanks[myIdx].angle : 45, 60);
        }
        syncCraters(toArr(sh.craters));
        /* hpAppliedN mitziehen: sonst zieht doImpact den Schaden dieses Schusses
           gleich noch einmal ab (siehe authDone dort). */
        if (sh.hp && (sh.hpN || 0) >= hpAppliedN) { applyHp(sh.hp); hpAppliedN = sh.hpN || 0; }
        if (typeof sh.wind === 'number') wind = sh.wind;
        if (sh.shot && sh.shot.n > lastShotN && phase === 'aim') startShot(sh.shot);
        if (sh.over) { overFlag = true; winnerId = sh.winner || null; }
        else if (sh.turn) wantTurn = { id: sh.turn, startAt: sh.turnStartAt || nowMs() };
        paintHud();
      }
      /* Host als Schiedsrichter: Ergebnis festschreiben (und sofort lokal anwenden) */
      function hostPublish(n) {
        var hp = {};
        tanks.forEach(function (tk) { hp[tk.id] = Math.max(0, Math.round(tk.hp)); });
        var alive = aliveTanks();
        var patch = { hp: hp, hpN: n, craters: craters };
        if (alive.length <= 1) { patch.over = true; patch.winner = alive[0] ? alive[0].id : null; }
        else {
          patch.wind = randWind();
          patch.turn = nextAliveId(curTurn.id);
          patch.turnStartAt = nowMs() + BOOM_MS + 250;
        }
        try { ctx.room.setShared(patch); } catch (e) {}
        applyShared(Object.assign({}, lastShared || {}, patch));
      }
      function hostSkipTurn() {
        var nx = nextAliveId(curTurn.id);
        if (!nx) return;
        var patch = { turn: nx, turnStartAt: nowMs() + 300, wind: randWind() };
        try { ctx.room.setShared(patch); } catch (e) {}
        applyShared(Object.assign({}, lastShared || {}, patch));
      }
      /* Verlassene Spieler ausscheiden lassen (nur der Host schreibt) */
      function hostCheckPlayers() {
        if (!built || !ctx.room.isHost() || overFlag || finished) return;
        var here = {}; ctx.room.players().forEach(function (p) { here[p.id] = 1; });
        var changed = false, hp = {};
        tanks.forEach(function (tk) {
          hp[tk.id] = Math.max(0, Math.round(tk.hp));
          if (tk.alive && !here[tk.id]) { hp[tk.id] = 0; tk.alive = false; tk.hp = 0; changed = true; }
        });
        if (!changed) return;
        var alive = aliveTanks(), patch = { hp: hp, hpN: hpAppliedN };
        if (alive.length <= 1) { patch.over = true; patch.winner = alive[0] ? alive[0].id : null; }
        else if (curTurnIdx >= 0 && !tanks[curTurnIdx].alive && phase === 'aim') {
          patch.turn = nextAliveId(curTurn.id); patch.turnStartAt = nowMs() + 300; patch.wind = randWind();
        }
        try { ctx.room.setShared(patch); } catch (e) {}
        applyShared(Object.assign({}, lastShared || {}, patch));
      }

      /* ============================================================
       *  SCHLEIFE
       * ============================================================ */
      function loop() {
        if (deadFlag || finished) { raf = null; return; }
        var now = nowMs();
        if (phase === 'flight' && curShot && (now - curShot.start) >= curShot.sim.time * 1000) doImpact();
        if (phase === 'boom' && (now - boomAt) >= BOOM_MS) { phase = 'aim'; curShot = null; paintHud(); }
        if (phase === 'aim') {
          if (overFlag) {
            phase = 'over';
            var w = winnerId ? tanks[idxOf(winnerId)] : null;
            setMsg(w ? (w.id === myId ? '🏆 Du hast das Duell gewonnen!' : '🏁 ' + w.name + ' gewinnt das Duell.') : '🏁 Alle ausgelöscht!', w && w.id === myId ? 'good' : 'bad');
            paintHud();
            after(1200, finish);
          } else if (wantTurn && (wantTurn.id !== curTurn.id || wantTurn.startAt !== curTurn.startAt)) {
            beginTurn(wantTurn);
          }
        }
        draw(now);
        raf = requestAnimationFrame(loop);
      }

      /* ============================================================
       *  ZEICHNEN
       * ============================================================ */
      function draw(now) {
        if (!c2) return;
        c2.clearRect(0, 0, W, H);
        c2.fillStyle = sky; c2.fillRect(0, 0, W, H);
        drawFlies(now);
        drawHills();
        drawWindStreaks(now);
        drawTerrain();
        var i;
        for (i = 0; i < tanks.length; i++) drawTank(tanks[i], now);
        if (canShoot()) drawPreview();
        if (phase === 'flight' && curShot) drawShell(now);
        if ((phase === 'boom' || phase === 'over') && boomHit) drawBoom(now);
        drawPops(now);
      }
      function drawHills() {
        hills.forEach(function (h) {
          c2.beginPath(); c2.moveTo(0, H);
          h.pts.forEach(function (p) { c2.lineTo(p.x, p.y); });
          c2.lineTo(W, H); c2.closePath();
          c2.fillStyle = h.fill; c2.fill();
        });
      }
      function drawFlies(now) {
        var t = now / 1000;
        flies.forEach(function (f) {
          var x = f.x + Math.sin(t * f.s + f.p) * 22, y = f.y + Math.cos(t * f.s * 0.7 + f.p) * 14;
          var a = 0.25 + 0.35 * (0.5 + 0.5 * Math.sin(t * 2.2 + f.p));
          c2.beginPath(); c2.arc(x, y, f.r, 0, 6.283);
          c2.fillStyle = 'rgba(157,255,122,' + a.toFixed(3) + ')';
          c2.shadowColor = '#39ff14'; c2.shadowBlur = 8; c2.fill(); c2.shadowBlur = 0;
        });
      }
      function drawWindStreaks(now) {
        if (Math.abs(wind) < 0.35) return;
        var t = now / 1000, i, x, y, len = 16 + Math.abs(wind) * 7;
        c2.strokeStyle = 'rgba(127,243,230,.16)'; c2.lineWidth = 1.5;
        for (i = 0; i < 16; i++) {
          y = 26 + ((i * 97) % Math.round(H * 0.5));
          x = (((i * 137) + t * wind * 46) % (W + 200) + (W + 200)) % (W + 200) - 100;
          c2.beginPath(); c2.moveTo(x, y); c2.lineTo(x + (wind > 0 ? len : -len), y); c2.stroke();
        }
      }
      function drawTerrain() {
        var x;
        c2.beginPath(); c2.moveTo(0, H); c2.lineTo(0, ground[0]);
        for (x = 2; x < W; x += 2) c2.lineTo(x, ground[x]);
        c2.lineTo(W, ground[W - 1]); c2.lineTo(W, H); c2.closePath();
        c2.fillStyle = terrGrad; c2.fill();
        c2.beginPath(); c2.moveTo(0, ground[0]);
        for (x = 2; x < W; x += 2) c2.lineTo(x, ground[x]);
        c2.lineTo(W, ground[W - 1]);
        c2.lineWidth = 2.5; c2.strokeStyle = 'rgba(140,255,130,.9)';
        c2.shadowColor = '#39ff14'; c2.shadowBlur = 12; c2.stroke(); c2.shadowBlur = 0;
      }
      function slopeAt(x) {
        var a = groundY(ground, x - 9), b = groundY(ground, x + 9);
        return clamp(Math.atan2(b - a, 18), -0.7, 0.7);
      }
      function drawTank(tk, now) {
        var rot = slopeAt(tk.x);
        c2.save();
        c2.translate(tk.x, tk.y); c2.rotate(rot);
        if (!tk.alive) {
          c2.fillStyle = '#20281f';
          rrect(-TANK_W / 2, -TANK_H, TANK_W, TANK_H, 3); c2.fill();
          c2.font = '700 15px system-ui,sans-serif'; c2.textAlign = 'center';
          c2.fillText('💀', 0, -TANK_H - 6);
          c2.restore(); return;
        }
        if (curTurn.id === tk.id && phase === 'aim') {
          var p = 0.5 + 0.5 * Math.sin(now / 260);
          c2.beginPath(); c2.arc(0, -TANK_H / 2, 26 + p * 5, 0, 6.283);
          c2.strokeStyle = tk.color; c2.globalAlpha = 0.28 + p * 0.3; c2.lineWidth = 2; c2.stroke();
          c2.globalAlpha = 1;
        }
        c2.fillStyle = 'rgba(0,0,0,.45)';
        rrect(-TANK_W / 2 - 1, -5, TANK_W + 2, 6, 3); c2.fill();
        var rad = tk.angle * Math.PI / 180;                 // Rohr (Winkel ist weltfest)
        c2.save(); c2.rotate(-rot);
        c2.strokeStyle = tk.color; c2.lineWidth = 5; c2.lineCap = 'round';
        c2.shadowColor = tk.color; c2.shadowBlur = 8;
        c2.beginPath(); c2.moveTo(0, -TANK_H - 4);
        c2.lineTo(Math.cos(rad) * BARREL, -TANK_H - 4 - Math.sin(rad) * BARREL);
        c2.stroke(); c2.shadowBlur = 0;
        c2.restore();
        c2.fillStyle = tk.color; c2.shadowColor = tk.color; c2.shadowBlur = 10;
        rrect(-TANK_W / 2, -TANK_H, TANK_W, TANK_H - 3, 4); c2.fill();
        c2.shadowBlur = 0;
        c2.beginPath(); c2.arc(0, -TANK_H, 6.5, Math.PI, 0); c2.fill();
        c2.fillStyle = 'rgba(255,255,255,.35)';
        rrect(-TANK_W / 2 + 3, -TANK_H + 1.5, TANK_W - 6, 2.5, 1.5); c2.fill();
        c2.fillStyle = '#0a1a10';
        rrect(-TANK_W / 2, -5.5, TANK_W, 5.5, 2.5); c2.fill();
        c2.restore();
        /* HP-Balken + Name über dem Panzer (weltfest, nicht gekippt) */
        var bx = tk.x - 21, by = tk.y - TANK_H - 30;
        c2.fillStyle = 'rgba(2,10,6,.75)'; rrect(bx - 1, by - 1, 44, 7, 3); c2.fill();
        c2.fillStyle = tk.hp > 55 ? tk.color : (tk.hp > 25 ? '#ffd23f' : '#ff4d6d');
        rrect(bx, by, 42 * Math.max(0, tk.hp) / START_HP, 5, 2.5); c2.fill();
        c2.font = '700 11px system-ui,sans-serif'; c2.textAlign = 'center';
        c2.fillStyle = tk.id === myId ? '#fff' : 'rgba(220,247,231,.8)';
        c2.fillText(tk.name.slice(0, 14) + (tk.id === myId ? ' (du)' : ''), tk.x, by - 5);
      }
      function rrect(x, y, w, h, r) {
        if (w < 0) { x += w; w = -w; }
        r = Math.min(r, w / 2, h / 2);
        c2.beginPath();
        c2.moveTo(x + r, y); c2.lineTo(x + w - r, y); c2.quadraticCurveTo(x + w, y, x + w, y + r);
        c2.lineTo(x + w, y + h - r); c2.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
        c2.lineTo(x + r, y + h); c2.quadraticCurveTo(x, y + h, x, y + h - r);
        c2.lineTo(x, y + r); c2.quadraticCurveTo(x, y, x + r, y); c2.closePath();
      }
      function drawPreview() {
        var key = myIdx + '|' + myAngle + '|' + myPower + '|' + wind + '|' + craters.length;
        if (key !== pvKey) { pvKey = key; pvSim = simulate(ground, tanks, myIdx, myAngle, myPower, wind, PREVIEW_T); }
        if (!pvSim) return;
        var pts = pvSim.path, i;
        c2.fillStyle = 'rgba(255,255,255,.62)';
        for (i = 1; i < pts.length; i += 3) {
          var a = 0.75 * (1 - i / pts.length) + 0.15;
          c2.globalAlpha = a;
          c2.beginPath(); c2.arc(pts[i].x, pts[i].y, 2.1, 0, 6.283); c2.fill();
        }
        c2.globalAlpha = 1;
      }
      function drawShell(now) {
        var t = (now - curShot.start) / 1000, p = pathAt(curShot.sim, t), i, q;
        for (i = 1; i <= 12; i++) {                          // Rauchspur
          q = pathAt(curShot.sim, Math.max(0, t - i * 0.022));
          c2.globalAlpha = 0.42 * (1 - i / 12);
          c2.beginPath(); c2.arc(q.x, q.y, 4.4 * (1 - i / 16), 0, 6.283);
          c2.fillStyle = '#ffd23f'; c2.fill();
        }
        c2.globalAlpha = 1;
        c2.beginPath(); c2.arc(p.x, p.y, 4.6, 0, 6.283);
        c2.fillStyle = '#fff8d0'; c2.shadowColor = '#ffd23f'; c2.shadowBlur = 16; c2.fill(); c2.shadowBlur = 0;
      }
      function drawBoom(now) {
        var t = clamp((now - boomAt) / BOOM_MS, 0, 1);
        if (boomHit.type === 'lost') return;
        var r = BLAST * (0.35 + 1.15 * t), a = 1 - t, i;
        var g = c2.createRadialGradient(boomHit.x, boomHit.y, 0, boomHit.x, boomHit.y, r);
        g.addColorStop(0, 'rgba(255,255,240,' + (a * 0.95).toFixed(3) + ')');
        g.addColorStop(0.4, 'rgba(255,210,63,' + (a * 0.7).toFixed(3) + ')');
        g.addColorStop(1, 'rgba(255,77,109,0)');
        c2.fillStyle = g; c2.beginPath(); c2.arc(boomHit.x, boomHit.y, r, 0, 6.283); c2.fill();
        c2.beginPath(); c2.arc(boomHit.x, boomHit.y, BLAST * 1.7 * t, 0, 6.283);
        c2.strokeStyle = 'rgba(255,240,180,' + (a * 0.8).toFixed(3) + ')'; c2.lineWidth = 3; c2.stroke();
        var pr = rng((boomHit.n || Math.round(boomHit.x)) + 7);
        for (i = 0; i < 18; i++) {
          var ang = pr() * 6.283, sp = 0.5 + pr() * 1.4;
          var px = boomHit.x + Math.cos(ang) * sp * BLAST * 1.6 * t;
          var py = boomHit.y + Math.sin(ang) * sp * BLAST * 1.6 * t + GRAV * 0.5 * Math.pow(t * 0.9, 2) * 2.2;
          c2.globalAlpha = a * 0.9;
          c2.fillStyle = i % 3 === 0 ? '#9dff7a' : '#ffd23f';
          c2.beginPath(); c2.arc(px, py, 2.6 * (1 - t * 0.5), 0, 6.283); c2.fill();
        }
        c2.globalAlpha = 1;
      }
      function drawPops(now) {
        var keep = [];
        c2.font = '900 16px system-ui,sans-serif'; c2.textAlign = 'center';
        pops.forEach(function (p) {
          var t = (now - p.at) / 1300;
          if (t < 0) { keep.push(p); return; }
          if (t > 1) return;
          c2.globalAlpha = 1 - t;
          c2.fillStyle = p.color;
          c2.shadowColor = p.color; c2.shadowBlur = 10;
          c2.fillText(p.txt, p.x, p.y - t * 34);
          c2.shadowBlur = 0; c2.globalAlpha = 1;
          keep.push(p);
        });
        pops = keep;
      }

      /* ============================================================
       *  ENDE
       * ============================================================ */
      function finish() {
        if (finished || deadFlag) return;
        finished = true;
        if (raf) { cancelAnimationFrame(raf); raf = null; }
        if (turnStop) { turnStop(); turnStop = null; }
        var me = myIdx >= 0 ? tanks[myIdx] : null;
        var s = me ? scoreOf(me) : 0;
        var iWon = !!(me && winnerId === me.id);
        if (iWon && App.Scores && App.Scores.winCurrent) App.Scores.winCurrent();
        if (App.Audio) App.Audio.sfx(iWon ? 'win' : 'lose');
        if (isMulti) {
          try { ctx.room.reportScore(s); } catch (e) {}
          after(900, function () {
            App.MG.endScreen(root, { players: ctx.room.players(), meId: ctx.me.id, onExit: ctx.onExit });
          });
        } else {
          var best = App.Storage.get('best_tanks', 0);
          var nb = s > best;
          if (nb) App.Storage.set('best_tanks', s);
          App.MG.endScreen(root, {
            score: s, best: best, newBest: nb,
            label: (iWon ? '🏆 Letzter Panzer im Dschungel! · ' : '💀 Abgeschossen · ')
              + 'Schaden ' + (me ? me.dmg : 0) + ' · ' + (nb ? 'neuer Rekord! 🎉' : 'Bestwert: ' + App.MG.fmt(best)),
            onExit: ctx.onExit,
            onAgain: function () { finished = false; showDiffPicker(); }
          });
        }
      }
    }
  };

  /* ============================== STYLES ============================== */
  function injectStyle() {
    UI.injectStyle('mg-tanks-css', [
      '.tnk-wrap{display:flex;flex-direction:column;gap:11px;}',
      /* Kopfzeile */
      '.tnk-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 16px;}',
      '.tnk-head-l,.tnk-head-c,.tnk-head-r{display:flex;flex-direction:column;gap:3px;min-width:0;}',
      '.tnk-head-c{align-items:center;flex:1;}',
      '.tnk-head-r{align-items:flex-end;}',
      '.tnk-head-lab{font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:1.4px;font-weight:800;}',
      '.tnk-turn{font-size:clamp(14px,3.8vw,19px);font-weight:900;color:var(--neon);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:34vw;}',
      '.tnk-timer{font-size:clamp(15px,4vw,21px);font-variant-numeric:tabular-nums;}',
      '.mg-timer.tnk-urgent{color:var(--danger-2);animation:tnk-blink .7s infinite;}',
      '@keyframes tnk-blink{0%,100%{opacity:1}50%{opacity:.35}}',
      '.tnk-wind{display:flex;align-items:center;gap:8px;}',
      '.tnk-wind-bar{position:relative;width:86px;height:7px;border-radius:5px;background:rgba(4,16,10,.85);border:1px solid var(--stroke);overflow:hidden;}',
      '.tnk-wind-bar::after{content:"";position:absolute;left:50%;top:0;width:1px;height:100%;background:var(--stroke-2);}',
      '.tnk-wind-fill{position:absolute;top:0;height:100%;background:linear-gradient(90deg,var(--aqua-soft),var(--aqua));box-shadow:0 0 8px var(--aqua);transition:width .3s,left .3s;}',
      '.tnk-wind-val{font-size:14px;font-weight:900;color:var(--aqua);font-variant-numeric:tabular-nums;white-space:nowrap;}',
      '.tnk-wind-val.strong{color:var(--gold);text-shadow:0 0 10px rgba(255,210,63,.5);}',
      /* Spieler-Leiste */
      '.tnk-roster{display:grid;grid-template-columns:repeat(auto-fit,minmax(128px,1fr));gap:8px;}',
      '.tnk-chip{position:relative;padding:8px 10px;border-radius:12px;background:rgba(9,32,21,.62);border:1px solid var(--stroke);display:flex;flex-direction:column;gap:5px;min-width:0;transition:border-color .2s,box-shadow .2s,opacity .3s;}',
      '.tnk-chip.active{border-color:var(--tnk-c,var(--neon));box-shadow:0 0 0 1px var(--tnk-c,var(--neon)),0 0 18px rgba(57,255,20,.28);}',
      '.tnk-chip.dead{opacity:.42;filter:grayscale(.7);}',
      '.tnk-chip-top{display:flex;align-items:center;gap:6px;min-width:0;}',
      '.tnk-dot{width:9px;height:9px;border-radius:50%;flex:0 0 auto;box-shadow:0 0 7px currentColor;}',
      '.tnk-nm{flex:1;min-width:0;font-size:12px;font-weight:800;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      '.tnk-chip.me .tnk-nm{color:var(--aqua);}',
      '.tnk-hp-num{font-size:13px;font-weight:900;color:var(--leaf);font-variant-numeric:tabular-nums;}',
      '.tnk-hp{position:relative;height:6px;border-radius:4px;background:rgba(4,16,10,.9);border:1px solid var(--stroke);overflow:hidden;}',
      '.tnk-hp-fill{position:absolute;left:0;top:0;height:100%;border-radius:4px;transition:width .35s cubic-bezier(.2,.8,.3,1);}',
      '.tnk-pts{font-size:10px;color:var(--muted);font-weight:800;letter-spacing:.6px;}',
      /* Spielfeld */
      '.tnk-stage{width:100%;max-width:820px;margin:0 auto;aspect-ratio:960 / 560;}',
      '.tnk-canvas{display:block;width:100%;height:100%;border-radius:16px;border:2px solid rgba(57,255,20,.35);',
      'background:#02110b;box-shadow:0 0 42px rgba(57,255,20,.2),inset 0 0 60px rgba(57,255,20,.05);',
      'touch-action:none;user-select:none;-webkit-user-select:none;-webkit-tap-highlight-color:transparent;cursor:crosshair;}',
      /* Meldung */
      '.tnk-msg{text-align:center;min-height:22px;font-weight:900;font-size:clamp(13px,3.4vw,17px);color:var(--muted);transition:color .2s;}',
      '.tnk-msg.you{color:var(--neon);text-shadow:0 0 10px rgba(57,255,20,.4);}',
      '.tnk-msg.opp{color:var(--aqua);}',
      '.tnk-msg.fire{color:var(--gold);}',
      '.tnk-msg.good{color:var(--gold);text-shadow:0 0 12px rgba(255,210,63,.5);animation:tnk-pop .3s ease;}',
      '.tnk-msg.bad{color:var(--danger);}',
      '.tnk-msg.miss{color:var(--silver);}',
      '@keyframes tnk-pop{0%{transform:scale(.8)}60%{transform:scale(1.1)}100%{transform:scale(1)}}',
      /* Bedienfeld */
      '.tnk-panel{display:flex;align-items:flex-end;gap:14px;padding:12px 16px;flex-wrap:wrap;transition:opacity .2s;}',
      '.tnk-panel.locked{opacity:.5;}',
      '.tnk-ctl{flex:1 1 190px;min-width:0;display:flex;flex-direction:column;gap:5px;}',
      '.tnk-ctl-top{display:flex;justify-content:space-between;align-items:baseline;gap:8px;}',
      '.tnk-ctl-lab{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:1.2px;font-weight:800;}',
      '.tnk-val{font-size:18px;font-weight:900;color:var(--aqua);font-variant-numeric:tabular-nums;}',
      '.tnk-val-pw{color:var(--gold);}',
      '.tnk-ctl-row{display:flex;align-items:center;gap:8px;}',
      '.tnk-nudge{padding:0;width:32px;height:32px;flex:0 0 auto;font-size:17px;font-weight:900;line-height:1;display:flex;align-items:center;justify-content:center;}',
      '.tnk-range{-webkit-appearance:none;appearance:none;flex:1;min-width:0;height:8px;border-radius:6px;',
      'background:linear-gradient(90deg,rgba(51,230,208,.45),rgba(9,32,21,.9));border:1px solid var(--stroke);outline:none;cursor:pointer;}',
      '.tnk-range-pw{background:linear-gradient(90deg,rgba(9,32,21,.9),rgba(255,210,63,.5));}',
      '.tnk-range:disabled{cursor:default;opacity:.55;}',
      '.tnk-range::-webkit-slider-thumb{-webkit-appearance:none;width:22px;height:22px;border-radius:50%;border:none;cursor:grab;',
      'background:radial-gradient(circle at 35% 32%,#eafff4,var(--aqua));box-shadow:0 0 10px var(--aqua),0 2px 6px rgba(0,0,0,.5);}',
      '.tnk-range-pw::-webkit-slider-thumb{background:radial-gradient(circle at 35% 32%,#fff6d0,var(--gold));box-shadow:0 0 10px var(--gold),0 2px 6px rgba(0,0,0,.5);}',
      '.tnk-range::-moz-range-thumb{width:20px;height:20px;border-radius:50%;border:none;cursor:grab;',
      'background:radial-gradient(circle at 35% 32%,#eafff4,var(--aqua));box-shadow:0 0 10px var(--aqua);}',
      '.tnk-range-pw::-moz-range-thumb{background:radial-gradient(circle at 35% 32%,#fff6d0,var(--gold));box-shadow:0 0 10px var(--gold);}',
      '.tnk-fire{flex:0 0 auto;min-width:130px;font-weight:900;letter-spacing:1px;}',
      '.tnk-fire:disabled{opacity:.45;cursor:default;filter:grayscale(.5);}',
      '.tnk-fire:not(:disabled){animation:tnk-ready 1.8s ease-in-out infinite;}',
      '@keyframes tnk-ready{0%,100%{box-shadow:0 0 0 rgba(57,255,20,0)}50%{box-shadow:0 0 20px rgba(57,255,20,.55)}}',
      '.tnk-hint{text-align:center;}',
      /* Start-/Warte-Panel */
      '.tnk-intro{padding:28px 22px;text-align:center;display:flex;flex-direction:column;gap:13px;align-items:center;max-width:520px;margin:0 auto;}',
      '.tnk-intro-icon{font-size:52px;line-height:1;filter:drop-shadow(0 0 14px rgba(255,210,63,.5));animation:tnk-shake 2.4s ease-in-out infinite;}',
      '@keyframes tnk-shake{0%,88%,100%{transform:translate(0,0) scale(1)}92%{transform:translate(-4px,2px) scale(1.08)}96%{transform:translate(4px,-2px) scale(1.05)}}',
      '.tnk-diffs{display:flex;flex-direction:column;gap:9px;width:100%;}',
      '.tnk-diff{display:flex;align-items:center;gap:12px;padding:12px 14px;border-radius:14px;text-align:left;',
      'background:rgba(9,32,21,.6);border:1px solid var(--stroke);color:var(--text);cursor:pointer;font-family:inherit;',
      'transition:transform .14s,border-color .18s,box-shadow .18s;}',
      '.tnk-diff:hover{transform:translateY(-2px);border-color:var(--neon);box-shadow:0 0 22px rgba(57,255,20,.3);}',
      '.tnk-diff:active{transform:scale(.98);}',
      '.tnk-diff-ic{font-size:26px;flex:0 0 auto;}',
      '.tnk-diff-nm{font-size:16px;font-weight:900;flex:0 0 74px;}',
      '.tnk-diff-ds{font-size:12px;color:var(--muted);flex:1;min-width:0;}',
      '@media(max-width:520px){',
      '.tnk-panel{gap:10px;padding:11px 12px;}',
      '.tnk-ctl{flex:1 1 100%;}',
      '.tnk-fire{flex:1 1 100%;min-width:0;}',
      '.tnk-wind-bar{width:60px;}',
      '.tnk-diff-nm{flex:0 0 62px;font-size:14px;}',
      '}'
    ].join(''));
  }
})();
