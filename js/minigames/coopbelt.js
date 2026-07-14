/* coopbelt.js — "Fließband-Chaos" (KOOP / Team-Sortieren).
 *
 * Ein gemeinsames Fließband transportiert Früchte (rot/grün/blau/gelb) von
 * rechts nach links. Unten stehen vier farbige Behälter. Tippt eine Frucht an
 * → sie fliegt automatisch ins richtige Fach → TEAM-Punkt +1. Erreicht eine
 * Frucht das linke Bandende, ohne einsortiert zu sein → das TEAM verliert ein
 * Leben. In höheren Wellen kommen so viele Früchte, dass einer allein nicht
 * hinterherkommt — das Team teilt sich das Band. Alle sehen dasselbe Band,
 * dieselben Leben, denselben Score.
 *
 * ARCHITEKTUR (host-autoritativ + Intents, exakt nach COOP_SPEC):
 *  - Der HOST würfelt beim Start EINEN kompletten Spielplan (alle Objekte mit
 *    id/typ/spawnAt/laneY/speed) und pusht ihn EINMAL via setShared. ALLE
 *    berechnen die x-Position deterministisch aus (room.now()-spawnAt)*speed
 *    → flüssige Bewegung ohne 60fps-Broadcast.
 *  - Maßgeblich (host-autoritativ) ist nur, WELCHE Objekte erledigt sind:
 *    Sortieren (Tap) oder Verpasst (am linken Ende). Der Host führt das in
 *    G.resolved und pusht es gedrosselt (~12 Hz, nur bei Änderung).
 *  - Ein Tap eines Gastes ist ein INTENT über reportState({seq,act}). Der Host
 *    wendet ihn genau EINMAL an (verhindert Doppelzählung bei gleichzeitigem Tap).
 *  - Host-Migration: jeder Client spiegelt den geteilten Zustand in G; wer
 *    gerade Host ist, treibt die Sim. Solo: alles lokal, kein Netz.
 * Alle Zeit läuft über Wall-Clock (room.now / Date.now) -> Tab-sicher. */
(function () {
  'use strict';
  window.App = window.App || {}; App.Minigames = App.Minigames || {};
  var UI = App.UI, el = UI.el, MG = App.MG;

  var LANES = 4;
  var MAX_LIVES = 5;

  /* Objekt-Typen (Frucht + zugehöriger Behälter). */
  var TYPES = [
    { key: 'r', emoji: '🍎', bin: '🔴', label: 'Rot',  color: '#ff4d6d' },
    { key: 'g', emoji: '🍏', bin: '🟢', label: 'Grün', color: '#39ff14' },
    { key: 'b', emoji: '🫐', bin: '🔵', label: 'Blau', color: '#33a0ff' },
    { key: 'y', emoji: '🍋', bin: '🟡', label: 'Gelb', color: '#ffd23f' }
  ];

  /* Wellen (Basiswerte, vor Spieler-Skalierung).
     count = Früchte, gap = ms zwischen Spawns, cross = ms für eine Bandquerung. */
  var WAVES = [
    { count: 6,  gap: 1300, cross: 8200 },
    { count: 9,  gap: 1050, cross: 7000 },
    { count: 12, gap: 840,  cross: 6100 },
    { count: 15, gap: 700,  cross: 5300 },
    { count: 18, gap: 570,  cross: 4700 }
  ];
  var WAVE_BREAK = 1600;   // Verschnaufpause zwischen Wellen (ms)
  var PREROLL = 900;       // ms nach Start bis zur ersten Frucht

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function countKeys(o) { return o ? Object.keys(o).length : 0; }

  App.Minigames.coopbelt = {
    id: 'coopbelt', title: 'Fließband-Chaos', icon: '🍣', order: 23,
    subtitle: 'Sortiert die Sachen ins richtige Fach, bevor sie runterfallen',
    coop: true, single: true, multi: true, minPlayers: 2, maxPlayers: 4,

    render: function (root, ctx) {
      injectStyle();
      var isMulti = ctx.mode === 'multi';
      var room = isMulti ? ctx.room : null;
      var clock = isMulti ? room.now : Date.now;
      var myId = isMulti ? ctx.me.id : 'solo';
      var myName = (ctx.me && ctx.me.name) || 'Du';

      /* ---- Aufräum-Register ---- */
      var tos = [], stops = [], destroyed = false;
      var rafId = null, tickId = null;
      function after(ms, fn) { var t = setTimeout(fn, ms); tos.push(t); return t; }

      /* ---- Netz-Listener (einmal, in cleanup wieder ab) ---- */
      var onSharedRef = null, onPlayersRef = null;

      /* ---- Laufender Zustand ---- */
      var G = null;             // maßgeblicher Zustand (Host) bzw. Spiegel (Gast)
      var curView = null;       // Zustand, aus dem gerendert wird (Host: G, Gast: shared)
      var planIndex = null;     // id -> obj
      var totalObjs = 0;
      var nPlayers = 1;
      var seen = {};            // schon verarbeitete resolved-ids (fly/drop)
      var nodes = {};           // id -> {el, obj, size, py, flying}
      var ended = false, dirty = false, initPushed = false;
      var lastSeq = {}, mySeq = 0;
      var shownWave = 0;

      /* ---- DOM-Referenzen (nach buildUI gesetzt) ---- */
      var stage = null, belt = null, cliff = null, binEls = [], chipByName = {};
      var hudHearts = null, hudSorted = null, hudWaveTxt = null, hudProg = null;

      function amHost() { return !isMulti || (room && room.isHost()); }

      /* ===================== START ===================== */
      if (isMulti) {
        var snap = room.snapshot() || {};
        var startAt = (snap.round && snap.round.startAt) || (room.now() + 3000);
        stops.push(MG.countdown(root, startAt, function () { begin(startAt); }, room.now));
      } else {
        intro();
      }
      return { cleanup: cleanup };

      /* ===================== SOLO-INTRO ===================== */
      function intro() {
        clearRound();
        ended = false;
        var best = App.Storage.get('best_coopbelt', 0);
        var card = el('div', { class: 'cb-intro glass' }, [
          el('div', { class: 'cb-intro-icon' }, ['🍣']),
          el('h2', { class: 'neon' }, ['Fließband-Chaos']),
          el('p', { class: 'hint-text' }, [
            'Tippt die Früchte an, bevor sie links vom Band fallen — jede fliegt automatisch ins richtige Fach. Zu langsam? Ein Leben weg. Schafft alle Wellen, ohne dass die ' + MAX_LIVES + ' Team-Leben aufgebraucht sind!'
          ]),
          el('div', { class: 'cb-intro-best hint-text' }, ['🏆 Beste Sortier-Zahl: ' + MG.fmt(best)]),
          el('button', { class: 'btn btn-primary btn-lg', type: 'button', onclick: function () {
            var s = Date.now() + 3200;
            clearRound();
            stops.push(MG.countdown(root, s, function () { begin(s); }));
          } }, ['▶ Los geht\'s'])
        ]);
        root.innerHTML = ''; root.appendChild(card);
      }

      /* ===================== SPIEL START ===================== */
      function begin(startAt) {
        if (destroyed) return;
        clearRound();
        ended = false; dirty = false; initPushed = false;
        seen = {}; nodes = {}; planIndex = null; shownWave = 0;

        nPlayers = isMulti ? Math.max(1, room.players().length) : 1;

        buildUI();

        if (amHost()) {
          G = buildInitialState(startAt, nPlayers);
          buildPlanIndex(G.plan);
          curView = G;
          if (isMulti && !initPushed) { initPushed = true; pushInit(); }
          renderFrom(G);
        } else {
          // Gast: warte auf Plan vom Host (Snapshot direkt anwenden, dann Events)
          var s0 = (room.snapshot() && room.snapshot().shared) || null;
          if (s0 && s0.plan) { curView = s0; buildPlanIndex(s0.plan); }
          renderFrom(s0 || {});
        }

        /* Netz-Listener */
        if (isMulti) {
          onSharedRef = function (shared) { if (!amHost()) applyShared(shared); };
          onPlayersRef = function () { onPlayers(); };
          room.on('shared', onSharedRef);
          room.on('players', onPlayersRef);
          onPlayers();
        }

        /* Schleifen laufen bei ALLEN; Host-Logik nur beim aktuellen Host. */
        rafId = requestAnimationFrame(frame);
        tickId = setInterval(hostTick, 80);
      }

      /* ===================== ZUSTAND / PLAN ===================== */
      function buildInitialState(startAt, players) {
        var extra = clamp(players - 1, 0, 3);
        var nMul = 1 + extra * 0.30;
        var gapMul = 1 / (1 + extra * 0.22);
        var plan = [];
        var laneLast = new Array(LANES); for (var i = 0; i < LANES; i++) laneLast[i] = -1e9;
        var t = startAt + PREROLL, objId = 0;
        for (var w = 0; w < WAVES.length; w++) {
          var cfg = WAVES[w];
          var count = Math.round(cfg.count * nMul);
          var gap = cfg.gap * gapMul;
          var speed = 1 / cfg.cross;
          for (var k = 0; k < count; k++) {
            // Lane wählen, die am längsten frei ist (vermeidet Überlappung)
            var lane = 0, bestFree = -1e18;
            for (var l = 0; l < LANES; l++) { var free = t - laneLast[l]; if (free > bestFree) { bestFree = free; lane = l; } }
            laneLast[lane] = t;
            plan.push({
              id: 'o' + (objId++),
              typ: (Math.random() * TYPES.length) | 0,
              spawnAt: Math.round(t),
              laneY: lane,
              speed: speed,
              wave: w + 1
            });
            t += gap;
          }
          t += WAVE_BREAK;
        }
        return {
          plan: plan, maxLives: MAX_LIVES, nPlayers: players,
          resolved: {}, score: 0, sorted: 0, missed: 0, lives: MAX_LIVES,
          curWave: 0, fxN: 0, over: false, win: false
        };
      }

      function buildPlanIndex(plan) {
        planIndex = {}; totalObjs = (plan || []).length;
        for (var i = 0; i < plan.length; i++) planIndex[plan[i].id] = plan[i];
      }

      function pushInit() {
        if (!isMulti || !room) return;
        room.setShared({
          plan: G.plan, maxLives: G.maxLives, nPlayers: G.nPlayers,
          resolved: {}, score: 0, sorted: 0, missed: 0, lives: G.lives,
          curWave: 0, over: false, win: false
        });
      }
      function pushDynamic() {
        if (!isMulti || !room) return;
        room.setShared({
          resolved: G.resolved, score: G.score, sorted: G.sorted, missed: G.missed,
          lives: G.lives, curWave: G.curWave, over: !!G.over, win: !!G.win
        });
      }

      /* ===================== EINGEHENDER GETEILTER ZUSTAND (Gast) ===================== */
      function applyShared(shared) {
        if (destroyed || ended) return;
        shared = shared || {};
        if (!planIndex && shared.plan) buildPlanIndex(shared.plan);
        // G spiegeln (für mögliche Host-Migration) — Plan aus Spiegel/aktuellem shared
        G = shared;
        curView = shared;
        renderFrom(shared);
      }

      /* ===================== RENDER AUS ZUSTAND ===================== */
      function renderFrom(S) {
        if (destroyed || !S) return;
        curView = S;
        if (!planIndex && S.plan) buildPlanIndex(S.plan);
        // neu erledigte Objekte animieren (Sortieren/Verpasst)
        var r = S.resolved || {};
        for (var id in r) {
          if (!r.hasOwnProperty(id) || seen[id]) continue;
          seen[id] = 1;
          var ev = r[id] || {};
          if (ev.k === 'sort') flyToBin(id, ev.by);
          else dropOff(id);
        }
        updateHud(S);
        maybeEnd(S);
      }

      function updateHud(S) {
        if (!hudHearts) return;
        var maxL = S.maxLives || MAX_LIVES;
        var lives = clamp(S.lives == null ? maxL : S.lives, 0, maxL);
        var hearts = '';
        for (var i = 0; i < maxL; i++) hearts += (i < lives) ? '💚' : '🖤';
        if (hudHearts.textContent !== hearts) hudHearts.textContent = hearts;
        var sorted = S.sorted || 0;
        if (hudSorted.textContent !== String(sorted)) hudSorted.textContent = String(sorted);
        var rc = countKeys(S.resolved);
        var pct = totalObjs ? Math.round(rc / totalObjs * 100) : 0;
        hudProg.style.width = pct + '%';
      }

      function maybeEnd(S) {
        if (!ended && S && S.over) { ended = true; showEnd(!!S.win, S); }
      }

      /* ===================== HOST-SIMULATION ===================== */
      function hostTick() {
        if (destroyed || ended) return;
        if (!amHost() || !G || !G.plan) return;
        var now = clock();

        // aktuelle Welle
        var w = currentWave(now, G.plan);
        if (w > (G.curWave || 0)) { G.curWave = w; dirty = true; }

        // Verpasste Objekte (linkes Bandende erreicht)
        for (var i = 0; i < G.plan.length; i++) {
          var o = G.plan[i];
          if (G.resolved[o.id]) continue;
          if (now >= o.spawnAt && (1 - (now - o.spawnAt) * o.speed) <= 0) markMiss(o);
        }

        // Ende prüfen
        var rc = countKeys(G.resolved);
        if (G.lives <= 0) finishLevel(false);
        else if (rc >= G.plan.length) finishLevel(true);

        // gedrosselt pushen
        if (dirty) { dirty = false; pushDynamic(); }
      }

      function markMiss(o) {
        if (G.resolved[o.id]) return;
        G.resolved[o.id] = { k: 'miss', by: null, n: G.fxN++ };
        G.missed++;
        G.lives = Math.max(0, G.lives - 1);
        dirty = true;
        renderFrom(G);
      }

      /* Kern-Sortierung (nur Host mutiert G). */
      function handleSort(id, byName) {
        if (ended || !amHost() || !G) return;
        var o = planIndex && planIndex[id];
        if (!o || G.resolved[id]) return;
        G.resolved[id] = { k: 'sort', by: byName || null, n: G.fxN++ };
        G.sorted++; G.score = G.sorted;
        dirty = true;
        renderFrom(G);
      }

      /* Intents der Gäste einsammeln. */
      function onPlayers() {
        if (!amHost() || !isMulti) return;
        var ps = room.players();
        for (var i = 0; i < ps.length; i++) {
          var p = ps[i];
          if (p.id === myId) continue;
          var st = p.state;
          if (st && st.seq && st.act && st.seq > (lastSeq[p.id] || 0)) {
            lastSeq[p.id] = st.seq;
            if (st.act.type === 'sort') handleSort(st.act.id, st.act.by || p.name);
          }
        }
      }

      function finishLevel(win) {
        if (ended) return;
        ended = true;
        G.over = true; G.win = win;
        if (isMulti) pushDynamic();
        renderFrom(G);
      }

      function currentWave(now, plan) {
        var w = 0;
        for (var i = 0; i < plan.length; i++) if (plan[i].spawnAt <= now && plan[i].wave > w) w = plan[i].wave;
        return w;
      }

      /* ===================== TAP (Intent) ===================== */
      function onTapObject(id) {
        if (destroyed || ended) return;
        if (!planIndex || !planIndex[id]) return;
        if (curView && curView.resolved && curView.resolved[id]) return;  // schon erledigt
        grab(id);                                                          // sofortiges Feedback
        if (amHost()) handleSort(id, myName);
        else { mySeq++; room.reportState({ seq: mySeq, act: { type: 'sort', id: id, by: myName }, t: clock() }); }
      }

      /* ===================== RENDER-SCHLEIFE (ALLE) ===================== */
      function frame() {
        if (destroyed) return;
        rafId = requestAnimationFrame(frame);
        var S = curView;
        if (!stage || !S || !S.plan) return;
        var now = clock();
        var stageW = stage.clientWidth || 300;
        var plan = S.plan, resolved = S.resolved || {};
        var anyDanger = false;
        for (var i = 0; i < plan.length; i++) {
          var o = plan[i];
          if (resolved[o.id]) continue;              // fly/drop kümmert sich
          if (now < o.spawnAt) continue;             // noch nicht auf dem Band
          var node = nodes[o.id];
          if (!node) node = createNode(o);
          if (node.flying) continue;
          var x = 1 - (now - o.spawnAt) * o.speed;    // 1 = rechts, 0 = linkes Ende
          if (x < -0.14) { node.el.style.visibility = 'hidden'; continue; }
          node.el.style.visibility = '';
          var px = x * (stageW - node.size);
          node.el.style.transform = 'translate3d(' + px + 'px,' + node.py + 'px,0)';
          if (x < 0.16) { node.el.classList.add('cb-danger'); anyDanger = true; }
          else node.el.classList.remove('cb-danger');
        }
        if (cliff) cliff.classList.toggle('on', anyDanger);
        updateWaveDisplay(now, plan);
      }

      function updateWaveDisplay(now, plan) {
        var w = currentWave(now, plan);
        if (w > shownWave) {
          shownWave = w;
          if (hudWaveTxt) hudWaveTxt.textContent = w + '/' + WAVES.length;
          if (w >= 1) UI.toast('🌊 Welle ' + w, 'info');
        }
      }

      /* ===================== OBJEKT-DOM ===================== */
      function createNode(o) {
        var t = TYPES[o.typ] || TYPES[0];
        var e = el('div', { class: 'cb-obj cb-type-' + t.key }, [
          el('span', { class: 'cb-emoji' }, [t.emoji])
        ]);
        e.style.transform = 'translate3d(-300px,0,0)';
        e.addEventListener('pointerdown', function (ev) { if (ev && ev.preventDefault) ev.preventDefault(); onTapObject(o.id); });
        var node = { el: e, obj: o, size: 44, py: 0, flying: false };
        nodes[o.id] = node;
        stage.appendChild(e);
        layoutNode(node);
        return node;
      }

      function layoutNode(node) {
        if (!belt) return;
        var H = belt.clientHeight || 260;
        var laneH = H / LANES;
        var size = Math.round(clamp(laneH * 0.74, 40, 78));
        node.size = size;
        node.py = Math.round(node.obj.laneY * laneH + (laneH - size) / 2);
        node.el.style.width = size + 'px';
        node.el.style.height = size + 'px';
        var em = node.el.querySelector('.cb-emoji');
        if (em) em.style.fontSize = Math.round(size * 0.52) + 'px';
      }

      function relayoutAll() { for (var id in nodes) if (nodes.hasOwnProperty(id) && !nodes[id].flying) layoutNode(nodes[id]); }

      function removeNode(id) {
        var n = nodes[id];
        if (n) { if (n.el && n.el.parentNode) n.el.parentNode.removeChild(n.el); delete nodes[id]; }
      }

      function grab(id) {
        var n = nodes[id];
        if (!n || n.flying) return;
        n.el.classList.add('cb-grab');
        after(320, function () { if (nodes[id] && !nodes[id].flying) nodes[id].el.classList.remove('cb-grab'); });
      }

      /* ===================== ERFOLG / MISS-ANIMATIONEN ===================== */
      function flyToBin(id, by) {
        var o = planIndex && planIndex[id];
        var typ = o ? o.typ : 0;
        binPulse(typ, by);
        bumpSorted();
        var node = nodes[id];
        if (!node || node.flying) { if (node) node.flying = true; return; }
        node.flying = true;
        node.el.classList.remove('cb-grab', 'cb-danger');
        var target = binEls[typ];
        if (target && stage) {
          var sr = stage.getBoundingClientRect(), br = target.getBoundingClientRect();
          var tx = (br.left + br.width / 2) - sr.left - node.size / 2;
          var ty = (br.top + br.height / 2) - sr.top - node.size / 2;
          node.el.style.transition = 'transform .42s cubic-bezier(.5,-0.25,.3,1), opacity .42s ease';
          node.el.style.transform = 'translate3d(' + tx + 'px,' + ty + 'px,0) scale(.22)';
          node.el.style.opacity = '0';
          node.el.classList.add('cb-fly');
        }
        after(450, function () { removeNode(id); });
      }

      function dropOff(id) {
        missFlash();
        var node = nodes[id];
        if (!node || node.flying) { if (node) node.flying = true; return; }
        node.flying = true;
        node.el.classList.remove('cb-grab', 'cb-danger');
        node.el.classList.add('cb-fall');
        node.el.style.transition = 'transform .52s ease-in, opacity .52s ease';
        node.el.style.transform = 'translate3d(-70px,' + (node.py + 170) + 'px,0) rotate(-28deg)';
        node.el.style.opacity = '0';
        after(540, function () { removeNode(id); });
      }

      function bumpSorted() {
        if (!hudSorted) return;
        hudSorted.classList.remove('bump'); void hudSorted.offsetWidth; hudSorted.classList.add('bump');
      }
      function missFlash() {
        if (cliff) { cliff.classList.remove('flash'); void cliff.offsetWidth; cliff.classList.add('flash'); }
        if (hudHearts) { hudHearts.classList.remove('shake'); void hudHearts.offsetWidth; hudHearts.classList.add('shake'); }
      }

      function binPulse(typ, by) {
        var b = binEls[typ];
        if (b) { b.classList.remove('pulse'); void b.offsetWidth; b.classList.add('pulse'); }
        // "von <Name>" — kleines Team-Feedback über dem Behälter
        if (by && b && stage) {
          var sr = stage.getBoundingClientRect(), br = b.getBoundingClientRect();
          var lbl = el('div', { class: 'cb-by' }, ['von ' + (by === myName ? 'dir' : by)]);
          lbl.style.left = (br.left + br.width / 2 - sr.left) + 'px';
          lbl.style.top = (br.top - sr.top - 6) + 'px';
          stage.appendChild(lbl);
          after(900, function () { if (lbl.parentNode) lbl.parentNode.removeChild(lbl); });
          var chip = chipByName[by];
          if (chip) { chip.classList.remove('act'); void chip.offsetWidth; chip.classList.add('act'); }
        }
      }

      /* ===================== UI-AUFBAU ===================== */
      function buildUI() {
        binEls = []; chipByName = {};

        hudHearts = el('div', { class: 'cb-hearts' }, ['']);
        hudSorted = el('div', { class: 'cb-sorted big-readout' }, ['0']);
        hudWaveTxt = el('div', { class: 'cb-wave-txt' }, ['0/' + WAVES.length]);

        var hudCells = [
          el('div', { class: 'cb-hud-cell' }, [el('span', { class: 'cb-hud-l' }, ['Leben']), hudHearts]),
          el('div', { class: 'cb-hud-cell cb-hud-center' }, [el('span', { class: 'cb-hud-l' }, ['Sortiert']), hudSorted]),
          el('div', { class: 'cb-hud-cell cb-hud-right' }, [el('span', { class: 'cb-hud-l' }, ['Welle']), hudWaveTxt])
        ];
        var hudTop = el('div', { class: 'cb-hud-top' }, hudCells);

        hudProg = el('div', { class: 'cb-prog-fill' });
        var progBar = el('div', { class: 'cb-prog' }, [hudProg]);

        var teamRow = null;
        if (isMulti) {
          var ps = room.players();
          var chips = ps.map(function (p) {
            var c = el('span', { class: 'cb-chip' + (p.id === myId ? ' me' : '') }, [p.name + (p.id === myId ? ' (du)' : '')]);
            chipByName[p.name] = c;
            return c;
          });
          teamRow = el('div', { class: 'cb-team' }, [
            el('span', { class: 'cb-team-l' }, ['🤝 Team (' + ps.length + '):']),
            el('div', { class: 'cb-chips' }, chips)
          ]);
        }

        var hud = el('div', { class: 'cb-hud glass' }, [hudTop, progBar, teamRow]);

        /* Bühne: Band (mit Laufstreifen) + linke Kante + Behälter */
        belt = el('div', { class: 'cb-belt' }, [
          el('div', { class: 'cb-stripes' }),
          el('div', { class: 'cb-lanes' })
        ]);
        cliff = el('div', { class: 'cb-cliff' }, [el('span', { class: 'cb-cliff-i' }, ['⬇'])]);

        var bins = TYPES.map(function (t, i) {
          var b = el('div', { class: 'cb-bin cb-type-' + t.key }, [
            el('div', { class: 'cb-bin-mouth' }),
            el('div', { class: 'cb-bin-icon' }, [t.bin]),
            el('div', { class: 'cb-bin-label' }, [t.emoji])
          ]);
          binEls[i] = b;
          return b;
        });
        var binsRow = el('div', { class: 'cb-bins' }, bins);

        stage = el('div', { class: 'cb-stage' }, [belt, cliff, binsRow]);

        var layout = el('div', { class: 'cb-layout' }, [hud, stage]);
        root.innerHTML = ''; root.appendChild(layout);

        // Resize -> Objekte neu einpassen (rAF-gedrosselt)
        addResize();
      }

      var resizePending = false, resizeHandler = null;
      function addResize() {
        resizeHandler = function () {
          if (resizePending) return;
          resizePending = true;
          requestAnimationFrame(function () { resizePending = false; relayoutAll(); });
        };
        window.addEventListener('resize', resizeHandler);
      }

      /* ===================== ENDE ===================== */
      function showEnd(win, S) {
        stopLoops();
        clearNodes();
        var sorted = (S && S.sorted) || 0;
        var reachedWave = (S && S.curWave) || shownWave || WAVES.length;
        if (!isMulti) {
          var best = App.Storage.get('best_coopbelt', 0);
          if (sorted > best) App.Storage.set('best_coopbelt', sorted);
        }
        var lines = [
          '🍎 Sortiert: ' + sorted,
          '🌊 Welle: ' + (win ? WAVES.length : reachedWave) + '/' + WAVES.length
        ];
        if (isMulti) lines.push('🤝 Team: ' + nPlayers + ' Spieler');
        MG.teamEnd(root, {
          win: win,
          title: win ? 'Level geschafft! 🎉' : 'Band überflutet 💥',
          subtitle: win ? 'Ihr habt alle Wellen zusammen sortiert!' : 'Zu viele Sachen sind runtergefallen.',
          lines: lines,
          onAgain: (!isMulti) ? intro : null,
          onExit: ctx.onExit,
          exitLabel: isMulti ? 'Zurück zur Lobby' : 'Zurück'
        });
      }

      /* ===================== AUFRÄUMEN ===================== */
      function clearNodes() {
        for (var id in nodes) if (nodes.hasOwnProperty(id)) { var n = nodes[id]; if (n.el && n.el.parentNode) n.el.parentNode.removeChild(n.el); }
        nodes = {};
      }
      function stopLoops() {
        if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
        if (tickId) { clearInterval(tickId); tickId = null; }
      }
      function clearRound() {
        tos.forEach(clearTimeout); tos = [];
        stops.forEach(function (f) { try { f(); } catch (e) {} }); stops = [];
        stopLoops();
        clearNodes();
      }
      function cleanup() {
        destroyed = true;
        clearRound();
        if (isMulti && room) {
          if (onSharedRef) room.off('shared', onSharedRef);
          if (onPlayersRef) room.off('players', onPlayersRef);
        }
        if (resizeHandler) window.removeEventListener('resize', resizeHandler);
        onSharedRef = onPlayersRef = resizeHandler = null;
      }
    }
  };

  /* ===================== STYLES ===================== */
  function injectStyle() {
    UI.injectStyle('mg-coopbelt-css', [
      '.cb-layout{display:flex;flex-direction:column;gap:14px;}',
      /* Intro */
      '.cb-intro{padding:28px;text-align:center;display:flex;flex-direction:column;gap:12px;align-items:center;max-width:500px;margin:0 auto;}',
      '.cb-intro-icon{font-size:56px;filter:drop-shadow(0 0 14px rgba(51,230,208,.55));animation:cb-bob 2.2s ease-in-out infinite;}',
      '@keyframes cb-bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-8px)}}',
      '.cb-intro h2{margin:0;}',
      '.cb-intro-best{font-weight:800;color:var(--gold);}',
      /* HUD */
      '.cb-hud{display:flex;flex-direction:column;gap:10px;padding:12px 16px;}',
      '.cb-hud-top{display:flex;align-items:center;justify-content:space-between;gap:10px;}',
      '.cb-hud-cell{display:flex;flex-direction:column;gap:2px;min-width:0;}',
      '.cb-hud-center{align-items:center;}',
      '.cb-hud-right{align-items:flex-end;}',
      '.cb-hud-l{font-size:11px;text-transform:uppercase;letter-spacing:1px;color:var(--muted);}',
      '.cb-hearts{font-size:clamp(16px,4.6vw,22px);line-height:1;letter-spacing:1px;}',
      '.cb-hearts.shake{animation:cb-shake .4s ease;}',
      '@keyframes cb-shake{0%,100%{transform:translateX(0)}25%{transform:translateX(-5px)}75%{transform:translateX(5px)}}',
      '.cb-sorted{font-size:clamp(26px,7vw,40px);line-height:1;color:var(--neon);text-shadow:0 0 14px rgba(57,255,20,.5);font-variant-numeric:tabular-nums;}',
      '.cb-sorted.bump{animation:cb-bump .3s ease;}',
      '@keyframes cb-bump{0%{transform:scale(1)}45%{transform:scale(1.35)}100%{transform:scale(1)}}',
      '.cb-wave-txt{font-size:clamp(18px,5vw,26px);font-weight:900;color:var(--aqua-soft);font-variant-numeric:tabular-nums;}',
      '.cb-prog{height:8px;border-radius:6px;background:rgba(4,16,10,.7);border:1px solid var(--stroke);overflow:hidden;}',
      '.cb-prog-fill{height:100%;width:0%;border-radius:6px;background:linear-gradient(90deg,var(--aqua),var(--neon));box-shadow:0 0 10px rgba(57,255,20,.5);transition:width .25s ease;}',
      '.cb-team{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}',
      '.cb-team-l{font-size:12px;font-weight:800;color:var(--leaf);white-space:nowrap;}',
      '.cb-chips{display:flex;gap:6px;flex-wrap:wrap;}',
      '.cb-chip{font-size:11px;font-weight:700;padding:3px 9px;border-radius:999px;background:rgba(9,32,21,.8);border:1px solid var(--stroke);color:var(--muted);transition:transform .15s;}',
      '.cb-chip.me{color:var(--aqua-soft);border-color:rgba(51,230,208,.4);}',
      '.cb-chip.act{animation:cb-chip .5s ease;color:var(--neon);border-color:var(--neon);}',
      '@keyframes cb-chip{0%{transform:scale(1)}40%{transform:scale(1.18)}100%{transform:scale(1)}}',
      /* Bühne */
      '.cb-stage{position:relative;width:100%;overflow:hidden;border-radius:var(--radius,16px);',
      'background:radial-gradient(120% 120% at 50% 0%,#0c3020,#04120a);border:1px solid var(--stroke);',
      'touch-action:manipulation;user-select:none;-webkit-user-select:none;-webkit-touch-callout:none;padding-bottom:2px;}',
      /* Laufband */
      '.cb-belt{position:relative;width:100%;height:clamp(220px,46vh,420px);overflow:hidden;',
      'border-bottom:3px solid rgba(51,230,208,.35);background:linear-gradient(180deg,rgba(8,26,18,.4),rgba(4,16,10,.75));}',
      '.cb-stripes{position:absolute;inset:0;pointer-events:none;opacity:.5;',
      'background:repeating-linear-gradient(115deg,rgba(51,230,208,.12) 0 22px,transparent 22px 62px);',
      'background-size:200% 100%;animation:cb-run 1.1s linear infinite;}',
      '@keyframes cb-run{from{background-position:0 0}to{background-position:-84px 0}}',
      '.cb-lanes{position:absolute;inset:0;pointer-events:none;',
      'background:repeating-linear-gradient(180deg,transparent 0,transparent calc(25% - 1px),rgba(157,255,122,.10) calc(25% - 1px),rgba(157,255,122,.10) 25%);}',
      /* linke Kante (Gefahren-Zone) */
      '.cb-cliff{position:absolute;left:0;top:0;width:14px;height:clamp(220px,46vh,420px);pointer-events:none;z-index:6;',
      'display:flex;align-items:center;justify-content:center;color:var(--danger);font-weight:900;font-size:12px;',
      'background:linear-gradient(90deg,rgba(255,77,109,.5),transparent);opacity:0;transition:opacity .2s;}',
      '.cb-cliff .cb-cliff-i{transform:rotate(90deg);opacity:.8;}',
      '.cb-cliff.on{opacity:1;animation:cb-cliffpulse .7s ease-in-out infinite;}',
      '@keyframes cb-cliffpulse{0%,100%{filter:brightness(1)}50%{filter:brightness(1.6)}}',
      '.cb-cliff.flash{animation:cb-cliffflash .5s ease;}',
      '@keyframes cb-cliffflash{0%{opacity:1;box-shadow:0 0 30px 12px rgba(255,77,109,.7)}100%{opacity:0;box-shadow:none}}',
      /* Objekte auf dem Band */
      '.cb-obj{position:absolute;left:0;top:0;border-radius:16px;display:flex;align-items:center;justify-content:center;',
      'cursor:pointer;touch-action:none;user-select:none;-webkit-user-select:none;will-change:transform;z-index:4;',
      'box-shadow:0 3px 10px rgba(0,0,0,.45),inset 0 0 0 2px rgba(255,255,255,.14);animation:cb-in .22s ease both;}',
      /* Positionierung erfolgt per inline-transform (jeder Frame) -> Keyframes duerfen KEIN transform animieren, sonst ueberschreibt die Animation die Position. Nur Opacity hier; der Pop laeuft auf dem inneren Emoji. */
      '.cb-emoji{pointer-events:none;line-height:1;filter:drop-shadow(0 2px 3px rgba(0,0,0,.5));animation:cb-pop .24s cubic-bezier(.2,1.4,.4,1) both;}',
      '@keyframes cb-in{from{opacity:0}to{opacity:1}}',
      '@keyframes cb-pop{from{transform:scale(.3)}to{transform:scale(1)}}',
      '.cb-obj.cb-grab{animation:cb-grab .3s ease;box-shadow:0 0 0 3px #fff,0 0 18px 4px rgba(255,255,255,.5);}',
      '@keyframes cb-grab{0%{transform-origin:center}50%{filter:brightness(1.4)}100%{}}',
      '.cb-obj.cb-danger{box-shadow:0 0 0 3px var(--danger),0 0 18px 3px rgba(255,77,109,.6);animation:cb-danger .5s ease-in-out infinite;}',
      '@keyframes cb-danger{0%,100%{filter:brightness(1)}50%{filter:brightness(1.5)}}',
      '.cb-obj.cb-fly{z-index:8;pointer-events:none;box-shadow:0 0 24px 6px rgba(255,255,255,.5);}',
      '.cb-obj.cb-fall{z-index:2;pointer-events:none;}',
      /* Typ-Farben (Objekte + Behälter) */
      '.cb-type-r{background:radial-gradient(circle at 35% 28%,#ff9fb3,#ff4d6d);}',
      '.cb-type-g{background:radial-gradient(circle at 35% 28%,#a6ff7d,#2fbf22);}',
      '.cb-type-b{background:radial-gradient(circle at 35% 28%,#8fc7ff,#2f7fe0);}',
      '.cb-type-y{background:radial-gradient(circle at 35% 28%,#ffe98a,#f5b800);}',
      /* Behälter-Reihe */
      '.cb-bins{display:flex;gap:8px;padding:10px;align-items:stretch;}',
      '.cb-bin{position:relative;flex:1;min-width:0;border-radius:12px 12px 14px 14px;padding:8px 4px 10px;',
      'display:flex;flex-direction:column;align-items:center;gap:2px;border:2px solid;',
      'background:rgba(4,16,10,.6);transition:transform .12s;overflow:hidden;}',
      '.cb-bin-mouth{width:70%;height:6px;border-radius:4px;margin-bottom:4px;opacity:.85;}',
      '.cb-bin-icon{font-size:clamp(20px,5.4vw,30px);line-height:1;}',
      '.cb-bin-label{font-size:clamp(13px,3.4vw,18px);opacity:.85;}',
      '.cb-bin.cb-type-r{border-color:#ff4d6d;box-shadow:0 0 14px rgba(255,77,109,.35);} .cb-bin.cb-type-r .cb-bin-mouth{background:#ff4d6d;}',
      '.cb-bin.cb-type-g{border-color:#39ff14;box-shadow:0 0 14px rgba(57,255,20,.35);} .cb-bin.cb-type-g .cb-bin-mouth{background:#39ff14;}',
      '.cb-bin.cb-type-b{border-color:#33a0ff;box-shadow:0 0 14px rgba(51,160,255,.35);} .cb-bin.cb-type-b .cb-bin-mouth{background:#33a0ff;}',
      '.cb-bin.cb-type-y{border-color:#ffd23f;box-shadow:0 0 14px rgba(255,210,63,.35);} .cb-bin.cb-type-y .cb-bin-mouth{background:#ffd23f;}',
      '.cb-bin.pulse{animation:cb-binpulse .42s ease;}',
      '@keyframes cb-binpulse{0%{transform:translateY(0)}35%{transform:translateY(6px) scale(1.05);filter:brightness(1.5)}100%{transform:translateY(0)}}',
      /* "von <Name>"-Feedback */
      '.cb-by{position:absolute;transform:translate(-50%,-100%);pointer-events:none;z-index:9;font-weight:800;font-size:12px;',
      'color:#fff;text-shadow:0 1px 4px rgba(0,0,0,.8);white-space:nowrap;animation:cb-by .9s ease-out forwards;}',
      '@keyframes cb-by{0%{opacity:0;transform:translate(-50%,-80%)}20%{opacity:1}100%{opacity:0;transform:translate(-50%,-160%)}}'
    ].join(''));
  }
})();
