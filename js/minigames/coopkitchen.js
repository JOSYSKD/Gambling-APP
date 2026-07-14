/* coopkitchen.js — "Koop-Küche": Overcooked-Klon als KOOP-Team-Minispiel.
 * Alle Spieler teilen sich EINE Küche: es kommen laufend Bestellungen rein,
 * jede ist eine Reihenfolge aus 2–3 Zubereitungs-Schritten. Wählt eine
 * Bestellung, tippt die passende Station (🔪 Schneiden · 🍳 Kochen · 🍽 Anrichten)
 * und zuletzt 🚀 Servieren. Serviert gemeinsam die Ziel-Anzahl, bevor die Zeit
 * abläuft oder die 3 Team-Leben aufgebraucht sind.
 *
 * Architektur (Pflicht): host-autoritativ + Intents.
 *  - Nur der HOST simuliert (spawnt Bestellungen, zählt Countdowns, prüft
 *    Leben/Ziel) und pusht den kompletten Küchen-Zustand gedrosselt (~140 ms)
 *    via room.setShared({ck:{...}}).
 *  - Aktionen (wählen / Schritt / servieren) laufen als Intents über
 *    room.reportState({seq, act}) — der Host wendet sie genau EINMAL an.
 *  - Solo: alles lokal, ein Spieler bedient alle Stationen. */
(function () {
  'use strict';
  window.App = window.App || {}; App.Minigames = App.Minigames || {};
  var UI = App.UI, el = UI.el, MG = App.MG;

  injectStyle();

  /* ---- Statische Spieldaten ---- */
  var STEP = {
    cut:   { icon: '🔪', label: 'Schneiden' },
    cook:  { icon: '🍳', label: 'Kochen' },
    plate: { icon: '🍽', label: 'Anrichten' },
    serve: { icon: '🚀', label: 'Servieren' }
  };
  var STATIONS = ['cut', 'cook', 'plate', 'serve'];
  var DISHES = [
    { icon: '🥗', name: 'Salat',  steps: ['cut', 'plate'] },
    { icon: '🍟', name: 'Pommes', steps: ['cook', 'plate'] },
    { icon: '🍣', name: 'Sushi',  steps: ['cut', 'plate'] },
    { icon: '🧀', name: 'Käseteller', steps: ['cut', 'plate'] },
    { icon: '🍲', name: 'Suppe',  steps: ['cut', 'cook', 'plate'] },
    { icon: '🍔', name: 'Burger', steps: ['cut', 'cook', 'plate'] },
    { icon: '🌮', name: 'Taco',   steps: ['cut', 'cook', 'plate'] },
    { icon: '🍕', name: 'Pizza',  steps: ['cut', 'cook', 'plate'] }
  ];
  var TWO = DISHES.filter(function (d) { return d.steps.length === 2; });
  var THREE = DISHES.filter(function (d) { return d.steps.length === 3; });

  var LEVEL_TIME = 90;   // s
  var LIVES = 3;
  var PUSH_MS = 140;     // Drossel für setShared
  var SIM_MS = 80;       // Host-Sim-Takt

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function findIn(list, id) {
    list = list || [];
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }
  function neededStation(o) {
    return (o.step < o.recipe.length) ? o.recipe[o.step] : 'serve';
  }

  App.Minigames.coopkitchen = {
    id: 'coopkitchen', title: 'Koop-Küche', icon: '🍳', order: 21,
    subtitle: 'Kocht zusammen und serviert die Bestellungen rechtzeitig',
    coop: true, single: true, multi: true, minPlayers: 2, maxPlayers: 4,

    render: function (root, ctx) {
      var isMulti = ctx.mode === 'multi';
      var room = ctx.room;
      var myId = isMulti ? ctx.me.id : 'solo';
      var myName = isMulti ? (ctx.me.name || 'Ich') : 'Du';
      var nowFn = isMulti ? function () { return room.now(); } : function () { return Date.now(); };

      var destroyed = false;
      var timers = [];          // setInterval/Timeout
      var stops = [];           // stop()-Funktionen (countdown/roundTimer)
      var rafId = 0;
      var sharedListener = null, playersListener = null;

      function every(ms, fn) { var t = setInterval(fn, ms); timers.push(t); return t; }
      function after(ms, fn) { var t = setTimeout(fn, ms); timers.push(t); return t; }
      function stopTimers() { timers.forEach(clearInterval); timers.forEach(clearTimeout); timers = []; }

      /* ---- Autoritativer Zustand (nur Host / Solo relevant) ---- */
      var G = null;
      function freshG() {
        return {
          orders: [], teamScore: 0, lives: LIVES, target: 0,
          over: false, win: false, endAt: 0,
          nextId: 1, nextSpawnAt: 0,
          serveAt: 0, serveBy: '', serveIcon: '', lifeLostAt: 0,
          _init: false
        };
      }

      /* ---- Lokaler Client-Zustand ---- */
      var mySelId = null;       // lokal gewählte Bestellung
      var mySeq = 0;            // Intent-Sequenznummer
      var lastSeq = {};         // Host: zuletzt angewandte seq je Spieler
      var hosting = false;      // treibe ich gerade die Sim?
      var lastPush = 0;
      var lastShared = null;

      var startAt = 0, endAt = 0;
      var TARGET = 0, MAX_SLOTS = 4;

      /* ---- DOM-Referenzen (einmal aufgebaut) ---- */
      var builtUI = false;
      var scoreValEl, targetValEl, progEl, livesEls = [], timerEl, teamEl,
          ordersEl, emptyEl, stationBtns = {}, hintEl, wrapEl;
      var cardEls = {};
      var seenServe = 0, seenLife = 0, firstRender = true, lastLives = -1, endShown = false;

      function amHost() { return isMulti ? (room && room.isHost()) : true; }

      run();
      return { cleanup: cleanup };

      /* ==================== Ablauf ==================== */
      function run() {
        if (isMulti) {
          var snap = room.snapshot() || {};
          startAt = (snap.round && snap.round.startAt) || (room.now() + (MG.MULTI_START_DELAY || 3000));
          if (snap.shared) lastShared = snap.shared;
        } else {
          startAt = Date.now() + 2500;
        }
        endAt = startAt + LEVEL_TIME * 1000;
        var cd = MG.countdown(root, startAt, begin, nowFn);
        stops.push(cd);
      }

      function begin() {
        if (destroyed) return;
        buildUI();

        // Ziel & Slots anhand der Spielerzahl beim Start
        var np = isMulti ? Math.max(2, room.players().length) : 1;
        TARGET = 8 + 2 * np;
        MAX_SLOTS = Math.min(4, np + 2);

        if (amHost() || !isMulti) initHost();

        startLoops();
      }

      function initHost() {
        G = freshG();
        G.target = TARGET;
        G.endAt = endAt;
        G.nextSpawnAt = startAt + 600;
        G._init = true;
        hosting = true;
        if (isMulti) seedSeqs();
        pushShared(true);
      }

      function seedSeqs() {
        room.players().forEach(function (p) {
          if (p.state && typeof p.state.seq === 'number') lastSeq[p.id] = p.state.seq;
        });
      }

      function startLoops() {
        every(SIM_MS, simStep);
        var ts = MG.roundTimer(endAt, updateTimer, function () {
          if (amHost() && G && !G.over) finalize(G.teamScore >= G.target);
        }, nowFn);
        stops.push(ts);

        if (isMulti) {
          sharedListener = function (sh) { lastShared = sh; };
          playersListener = function () { onPlayers(); };
          room.on('shared', sharedListener);
          room.on('players', playersListener);
          renderTeam();
        } else {
          renderTeam();
        }

        rafId = requestAnimationFrame(frame);
      }

      function frame() {
        if (destroyed) return;
        var now = nowFn();
        var v = currentView();
        render(v, now);
        if (v.over) { showEnd(v); return; }
        rafId = requestAnimationFrame(frame);
      }

      /* ==================== Host-Simulation ==================== */
      function simStep() {
        if (destroyed) return;
        var host = amHost();
        if (host && !hosting) becomeHost();
        if (!host) { hosting = false; return; }
        if (!G) return;

        var now = nowFn();
        if (!G.over) {
          // Bestellungen spawnen
          if (now >= G.nextSpawnAt) {
            if (G.orders.length < MAX_SLOTS) {
              spawnOrder(now);
              G.nextSpawnAt = now + spawnGap(now);
              pushShared(true);
            } else {
              G.nextSpawnAt = now + 700; // Küche voll → bald erneut prüfen
            }
          }
          // Bestellungen verfallen lassen
          for (var i = G.orders.length - 1; i >= 0; i--) {
            if (now >= G.orders[i].deadline) {
              G.orders.splice(i, 1);
              G.lives--;
              G.lifeLostAt = now;
              pushShared(true);
              if (G.lives <= 0) { finalize(false); break; }
            }
          }
          if (!G.over && G.teamScore >= G.target) finalize(true);
        }
        if (isMulti && now - lastPush >= PUSH_MS) pushShared(false);
      }

      function spawnOrder(now) {
        var frac = clamp((now - startAt) / (LEVEL_TIME * 1000), 0, 1);
        var p3 = 0.22 + 0.55 * frac;
        var pool = (Math.random() < p3 && THREE.length) ? THREE : TWO;
        var d = pool[(Math.random() * pool.length) | 0];
        var recipe = d.steps.slice();
        var limit = (5200 + recipe.length * 5200) * (1 - 0.30 * frac);
        G.orders.push({
          id: 'o' + (G.nextId++), icon: d.icon, name: d.name, recipe: recipe,
          step: 0, deadline: now + limit, life: limit,
          activeBy: null, activeName: null, pulseAt: 0, errAt: 0
        });
      }
      function spawnGap(now) {
        var frac = clamp((now - startAt) / (LEVEL_TIME * 1000), 0, 1);
        var base = lerp(4300, 2100, frac);
        return base * (0.8 + Math.random() * 0.4);
      }

      function finalize(win) {
        if (!G || G.over) return;
        G.over = true; G.win = win;
        pushShared(true);
      }

      function becomeHost() {
        hosting = true;
        if (!G) G = freshG();
        if (!G._init) {
          var s = (lastShared && lastShared.ck) || null;
          if (s) {
            G.orders = (s.orders || []).map(function (o) { return Object.assign({}, o); });
            G.teamScore = s.teamScore || 0;
            G.lives = (s.lives == null) ? LIVES : s.lives;
            G.target = s.target || TARGET;
            G.over = !!s.over; G.win = !!s.win;
            G.endAt = s.endAt || endAt;
            G.serveAt = s.serveAt || 0; G.lifeLostAt = s.lifeLostAt || 0;
            var maxId = 0;
            G.orders.forEach(function (o) {
              var n = parseInt(String(o.id).slice(1), 10);
              if (n > maxId) maxId = n;
            });
            G.nextId = maxId + 1;
          } else {
            G.target = TARGET; G.endAt = endAt;
          }
          G.nextSpawnAt = nowFn() + 1500;
          G._init = true;
        }
        if (isMulti) seedSeqs();
      }

      /* ==================== Intents / Aktionen ==================== */
      function doAction(act) {
        if (amHost() || !isMulti) {
          applyAction(myId, myName, act);
        } else {
          mySeq++;
          room.reportState({ seq: mySeq, act: act, t: nowFn() });
        }
      }

      function onPlayers() {
        renderTeam();
        if (!amHost() || !G) return;
        var ps = room.players();
        ps.forEach(function (p) {
          if (p.id === myId) return;              // eigene Aktionen laufen direkt
          var st = p.state;
          if (st && typeof st.seq === 'number' && st.seq > (lastSeq[p.id] || 0)) {
            lastSeq[p.id] = st.seq;
            if (st.act) applyAction(p.id, p.name || 'Koch', st.act);
          }
        });
      }

      // Wird NUR auf dem Host / Solo ausgeführt (autoritativ auf G).
      function applyAction(playerId, name, act) {
        if (!G || G.over || !act) return;
        var now = nowFn();

        if (act.type === 'select') {
          G.orders.forEach(function (o) {
            if (o.activeBy === playerId) { o.activeBy = null; o.activeName = null; }
          });
          var os = findIn(G.orders, act.orderId);
          if (os) { os.activeBy = playerId; os.activeName = name; }
          pushShared(true);
          return;
        }

        if (act.type === 'station') {
          var o = findIn(G.orders, act.orderId);
          if (!o) return;
          var need = neededStation(o);
          if (act.station !== need) { o.errAt = now; pushShared(true); return; }
          if (need === 'serve') {
            var idx = G.orders.indexOf(o);
            if (idx >= 0) G.orders.splice(idx, 1);
            G.teamScore++;
            G.serveAt = now; G.serveBy = name; G.serveIcon = o.icon;
            if (G.teamScore >= G.target) { finalize(true); return; }
          } else {
            o.step++;
            o.pulseAt = now;
            o.activeBy = playerId; o.activeName = name; // wer zuletzt anfasste
          }
          pushShared(true);
        }
      }

      /* ==================== Netzwerk-Push ==================== */
      function pushShared(force) {
        if (!isMulti || !amHost() || !G) return;
        var now = nowFn();
        if (!force && now - lastPush < PUSH_MS) return;
        lastPush = now;
        room.setShared({
          ck: {
            orders: G.orders.map(serializeOrder),
            teamScore: G.teamScore, lives: G.lives, target: G.target,
            endAt: G.endAt, over: G.over, win: G.win,
            serveAt: G.serveAt, serveBy: G.serveBy, serveIcon: G.serveIcon,
            lifeLostAt: G.lifeLostAt
          }
        });
      }
      function serializeOrder(o) {
        return {
          id: o.id, icon: o.icon, name: o.name, recipe: o.recipe, step: o.step,
          deadline: o.deadline, life: o.life,
          activeBy: o.activeBy, activeName: o.activeName,
          pulseAt: o.pulseAt, errAt: o.errAt
        };
      }

      /* ==================== View-Auswahl ==================== */
      function currentView() {
        if (amHost() && G && G._init) {
          return {
            orders: G.orders, teamScore: G.teamScore, lives: G.lives, target: G.target,
            endAt: G.endAt, over: G.over, win: G.win,
            serveAt: G.serveAt, serveBy: G.serveBy, serveIcon: G.serveIcon, lifeLostAt: G.lifeLostAt
          };
        }
        var s = (lastShared && lastShared.ck) || {};
        return {
          orders: s.orders || [], teamScore: s.teamScore || 0,
          lives: (s.lives == null) ? LIVES : s.lives, target: s.target || TARGET,
          endAt: s.endAt || endAt, over: !!s.over, win: !!s.win,
          serveAt: s.serveAt || 0, serveBy: s.serveBy || '', serveIcon: s.serveIcon || '',
          lifeLostAt: s.lifeLostAt || 0
        };
      }

      /* ==================== UI-Aufbau ==================== */
      function buildUI() {
        scoreValEl = el('span', { class: 'ck-score-val' }, ['0']);
        targetValEl = el('span', { class: 'ck-score-tgt' }, ['–']);
        progEl = el('div', { class: 'ck-prog' });
        var scoreBlock = el('div', { class: 'ck-score-block' }, [
          el('div', { class: 'ck-score-line' }, [
            el('span', { class: 'ck-score-emoji' }, ['🍽']),
            scoreValEl, el('span', { class: 'ck-score-sep' }, [' / ']), targetValEl,
            el('span', { class: 'ck-score-lbl' }, [' serviert'])
          ]),
          el('div', { class: 'ck-prog-wrap' }, [progEl])
        ]);

        livesEls = [];
        var livesBox = el('div', { class: 'ck-lives' });
        for (var i = 0; i < LIVES; i++) {
          var h = el('span', { class: 'ck-heart on' }, ['❤️']);
          livesEls.push(h); livesBox.appendChild(h);
        }

        timerEl = el('div', { class: 'mg-timer ck-timer' }, ['⏱ ' + MG.mmss(LEVEL_TIME)]);

        var hud = el('div', { class: 'ck-hud glass' }, [
          scoreBlock,
          el('div', { class: 'ck-hud-right' }, [livesBox, timerEl])
        ]);

        teamEl = el('div', { class: 'ck-team' });
        ordersEl = el('div', { class: 'ck-orders' });
        emptyEl = el('div', { class: 'ck-empty hint-text' }, ['Warte auf Bestellungen …']);
        ordersEl.appendChild(emptyEl);

        hintEl = el('div', { class: 'ck-hint hint-text' }, ['Tippe eine Bestellung an, dann die passende Station.']);

        var stationRow = el('div', { class: 'ck-stations' });
        STATIONS.forEach(function (key) {
          var b = el('button', {
            class: 'ck-station ck-st-' + key, type: 'button',
            onclick: (function (k) { return function () { station(k); }; })(key)
          }, [
            el('span', { class: 'ck-st-icon' }, [STEP[key].icon]),
            el('span', { class: 'ck-st-label' }, [STEP[key].label])
          ]);
          stationBtns[key] = b; stationRow.appendChild(b);
        });

        wrapEl = el('div', { class: 'ck-wrap' }, [hud, teamEl, ordersEl, hintEl, stationRow]);
        root.innerHTML = ''; root.appendChild(wrapEl);
        builtUI = true;
      }

      /* ==================== Rendern ==================== */
      function render(v, now) {
        if (!builtUI) return;
        scoreValEl.textContent = v.teamScore;
        targetValEl.textContent = v.target || '–';
        var pct = v.target ? Math.min(100, (v.teamScore / v.target) * 100) : 0;
        progEl.style.width = pct.toFixed(1) + '%';

        updateLives(v.lives);
        handleEvents(v);
        renderOrders(v, now);
        updateHint(v);
      }

      function updateLives(lives) {
        if (lives === lastLives) return;
        lastLives = lives;
        for (var i = 0; i < livesEls.length; i++) {
          var alive = i < lives;
          livesEls[i].textContent = alive ? '❤️' : '🤍';
          livesEls[i].className = 'ck-heart ' + (alive ? 'on' : 'off');
        }
      }

      function handleEvents(v) {
        if (firstRender) { seenServe = v.serveAt || 0; seenLife = v.lifeLostAt || 0; firstRender = false; return; }
        if (v.serveAt && v.serveAt > seenServe) {
          seenServe = v.serveAt;
          UI.toast((v.serveBy ? v.serveBy + ' ' : '') + 'serviert ' + (v.serveIcon || '🍽') + '  +1', 'win');
          bump(scoreValEl);
        }
        if (v.lifeLostAt && v.lifeLostAt > seenLife) {
          seenLife = v.lifeLostAt;
          UI.toast('Bestellung verpasst!  −1 Leben', 'lose');
          shake();
        }
      }

      function renderOrders(v, now) {
        var list = v.orders || [];
        var seen = {};
        list.forEach(function (o) {
          seen[o.id] = true;
          var c = cardEls[o.id];
          if (!c) { c = buildCard(o); cardEls[o.id] = c; ordersEl.appendChild(c.root); }
          updateCard(c, o, now);
        });
        Object.keys(cardEls).forEach(function (id) {
          if (!seen[id]) {
            var c = cardEls[id];
            if (c.root.parentNode) c.root.parentNode.removeChild(c.root);
            delete cardEls[id];
            if (mySelId === id) mySelId = null;
          }
        });
        emptyEl.style.display = list.length ? 'none' : '';
      }

      function buildCard(o) {
        var iconEl = el('div', { class: 'ck-dish-icon' }, [o.icon]);
        var nameEl = el('div', { class: 'ck-dish-name' }, [o.name]);
        var stepsEl = el('div', { class: 'ck-steps' });
        var stepEls = [];
        o.recipe.forEach(function (key) {
          var s = el('span', { class: 'ck-step' }, [STEP[key].icon]);
          stepEls.push(s); stepsEl.appendChild(s);
        });
        stepsEl.appendChild(el('span', { class: 'ck-step-arrow' }, ['→']));
        var serveEl = el('span', { class: 'ck-step ck-step-serve' }, ['🚀']);
        stepsEl.appendChild(serveEl);

        var activeEl = el('div', { class: 'ck-active' });
        var barEl = el('div', { class: 'ck-bar' });
        var barWrap = el('div', { class: 'ck-bar-wrap' }, [barEl]);

        var rootEl = el('div', { class: 'ck-card', dataset: { id: o.id } }, [
          activeEl, iconEl, nameEl, stepsEl, barWrap
        ]);
        rootEl.addEventListener('click', (function (id) {
          return function () { selectOrder(id); };
        })(o.id));

        return {
          root: rootEl, activeEl: activeEl, stepEls: stepEls, serveEl: serveEl,
          barEl: barEl, lastPulse: 0, lastErr: 0
        };
      }

      function updateCard(c, o, now) {
        var ready = o.step >= o.recipe.length;
        // Schritte
        for (var i = 0; i < c.stepEls.length; i++) {
          var cls = 'ck-step ' + (i < o.step ? 'done' : (i === o.step ? 'cur' : 'todo'));
          if (c.stepEls[i].className !== cls) c.stepEls[i].className = cls;
        }
        var scls = 'ck-step ck-step-serve ' + (ready ? 'cur' : 'todo');
        if (c.serveEl.className !== scls) c.serveEl.className = scls;

        // Countdown-Balken
        var rem = o.deadline - now;
        var frac = clamp(rem / o.life, 0, 1);
        c.barEl.style.width = (frac * 100).toFixed(1) + '%';
        var bcls = 'ck-bar' + (frac < 0.25 ? ' low' : (frac < 0.5 ? ' mid' : ''));
        if (c.barEl.className !== bcls) c.barEl.className = bcls;

        // Wer arbeitet dran?
        if (o.activeBy) {
          var mine = o.activeBy === myId;
          c.activeEl.textContent = (mine ? '🙋 ' : '👤 ') + (o.activeName || 'Koch');
          c.activeEl.className = 'ck-active show' + (mine ? ' mine' : '');
        } else if (c.activeEl.className !== 'ck-active') {
          c.activeEl.className = 'ck-active';
          c.activeEl.textContent = '';
        }

        // Karten-Status-Klassen (Anim-Klassen pulse/err bleiben erhalten)
        setBaseClass(c.root, ready, o.id === mySelId, o.activeBy && o.activeBy !== myId);

        // Puls bei Schritt-Fortschritt
        if (o.pulseAt && o.pulseAt > c.lastPulse) {
          c.lastPulse = o.pulseAt;
          pulseNode(c.root, 'pulse');
        }
        // Fehler-Flash (falscher Schritt)
        if (o.errAt && o.errAt > c.lastErr) {
          c.lastErr = o.errAt;
          pulseNode(c.root, 'err');
        }
      }

      function setBaseClass(node, ready, sel, busy) {
        var base = 'ck-card';
        if (ready) base += ' ready';
        if (sel) base += ' sel';
        if (busy) base += ' busy';
        if (node.classList.contains('pulse')) base += ' pulse';
        if (node.classList.contains('err')) base += ' err';
        if (node.className !== base) node.className = base;
      }

      function pulseNode(node, cls) {
        node.classList.remove(cls);
        void node.offsetWidth;
        node.classList.add(cls);
        after(420, function () { if (node) node.classList.remove(cls); });
      }

      function updateHint(v) {
        var o = mySelId ? findIn(v.orders, mySelId) : null;
        // Stations-Highlight zurücksetzen
        STATIONS.forEach(function (k) { stationBtns[k].classList.remove('hot'); });
        if (!o) {
          hintEl.textContent = 'Tippe eine Bestellung an, dann die passende Station.';
          return;
        }
        var need = neededStation(o);
        var info = STEP[need];
        stationBtns[need].classList.add('hot');
        hintEl.textContent = o.icon + ' ' + o.name + ' — als Nächstes: ' + info.icon + ' ' + info.label;
      }

      function renderTeam() {
        if (!builtUI) return;
        teamEl.innerHTML = '';
        if (!isMulti) {
          teamEl.appendChild(el('span', { class: 'ck-team-chip solo' }, ['👤 Solo — du bedienst alle Stationen']));
          return;
        }
        var ps = room.players();
        teamEl.appendChild(el('span', { class: 'ck-team-count' }, ['👥 ' + ps.length]));
        ps.forEach(function (p) {
          teamEl.appendChild(el('span', {
            class: 'ck-team-chip' + (p.id === myId ? ' me' : '')
          }, [p.name + (p.id === myId ? ' (du)' : '')]));
        });
      }

      /* ==================== Eingaben ==================== */
      function selectOrder(id) {
        if (destroyed) return;
        mySelId = id;
        doAction({ type: 'select', orderId: id });
        // sofortiges lokales Feedback
        var v = currentView();
        render(v, nowFn());
      }

      function station(key) {
        if (destroyed) return;
        if (!mySelId) { UI.toast('Erst eine Bestellung antippen', 'info'); flashBtn(key); return; }
        var v = currentView();
        var o = findIn(v.orders, mySelId);
        if (!o) { mySelId = null; UI.toast('Bestellung ist weg', 'info'); return; }
        var need = neededStation(o);
        if (key !== need) {
          // optimistisches Fehler-Feedback (Host bleibt autoritativ)
          flashBtn(key);
          var c = cardEls[mySelId];
          if (c) pulseNode(c.root, 'err');
        }
        doAction({ type: 'station', station: key, orderId: mySelId });
      }

      function flashBtn(key) {
        var b = stationBtns[key];
        if (!b) return;
        b.classList.remove('shake');
        void b.offsetWidth;
        b.classList.add('shake');
        after(360, function () { if (b) b.classList.remove('shake'); });
      }
      function bump(node) {
        node.classList.remove('bump'); void node.offsetWidth; node.classList.add('bump');
        after(400, function () { if (node) node.classList.remove('bump'); });
      }
      function shake() {
        if (!wrapEl) return;
        wrapEl.classList.remove('shake'); void wrapEl.offsetWidth; wrapEl.classList.add('shake');
        after(450, function () { if (wrapEl) wrapEl.classList.remove('shake'); });
      }

      function updateTimer(secLeft) {
        if (!timerEl) return;
        timerEl.textContent = '⏱ ' + MG.mmss(secLeft);
        timerEl.classList.toggle('ck-urgent', secLeft <= 12);
      }

      /* ==================== Ende ==================== */
      function showEnd(v) {
        if (endShown) return;
        endShown = true;
        stopLoops();
        var lines = [
          'Serviert: ' + v.teamScore + ' / ' + v.target,
          'Übrige Leben: ' + Math.max(0, v.lives)
        ];
        var opts = {
          win: v.win,
          title: v.win ? 'Küche gerockt! 🎉' : 'Küche im Chaos …',
          subtitle: v.win
            ? 'Ihr habt alle Bestellungen rechtzeitig serviert!'
            : (v.lives <= 0 ? 'Zu viele Bestellungen sind angebrannt.' : 'Zeit abgelaufen — Ziel nicht geschafft.'),
          lines: lines,
          onExit: ctx.onExit,
          exitLabel: isMulti ? 'Zurück zur Lobby' : 'Zurück'
        };
        if (!isMulti) opts.onAgain = restartSolo;   // Solo: neu starten; Multi weglassen
        MG.teamEnd(root, opts);
      }

      function restartSolo() {
        if (destroyed) return;
        stopLoops();
        // Zustand zurücksetzen
        G = null; mySelId = null; mySeq = 0; lastSeq = {}; hosting = false; lastPush = 0;
        cardEls = {}; builtUI = false; seenServe = 0; seenLife = 0;
        firstRender = true; lastLives = -1; endShown = false; lastShared = null;
        run();
      }

      /* ==================== Aufräumen ==================== */
      function stopLoops() {
        stopTimers();
        stops.forEach(function (f) { try { f(); } catch (e) {} });
        stops = [];
        if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
      }
      function cleanup() {
        destroyed = true;
        stopLoops();
        if (isMulti && room) {
          if (sharedListener) room.off('shared', sharedListener);
          if (playersListener) room.off('players', playersListener);
        }
        sharedListener = null; playersListener = null;
      }
    }
  };

  /* ==================== CSS ==================== */
  function injectStyle() {
    UI.injectStyle('mg-coopkitchen-css', [
      '.ck-wrap{display:flex;flex-direction:column;gap:14px;}',
      '.ck-wrap.shake{animation:ck-shake .42s ease;}',
      '@keyframes ck-shake{0%,100%{transform:translateX(0)}20%{transform:translateX(-8px)}40%{transform:translateX(7px)}60%{transform:translateX(-5px)}80%{transform:translateX(4px)}}',

      /* HUD */
      '.ck-hud{display:flex;justify-content:space-between;align-items:center;gap:14px;padding:14px 18px;flex-wrap:wrap;}',
      '.ck-score-block{display:flex;flex-direction:column;gap:8px;min-width:200px;flex:1;}',
      '.ck-score-line{display:flex;align-items:baseline;gap:4px;font-weight:900;}',
      '.ck-score-emoji{font-size:22px;margin-right:4px;}',
      '.ck-score-val{font-size:clamp(28px,7vw,40px);line-height:1;color:var(--neon);text-shadow:0 0 14px rgba(57,255,20,.5);transition:transform .1s;display:inline-block;}',
      '.ck-score-val.bump{animation:ck-bump .4s ease;}',
      '@keyframes ck-bump{0%{transform:scale(1)}40%{transform:scale(1.4);color:var(--gold)}100%{transform:scale(1)}}',
      '.ck-score-sep{font-size:20px;color:var(--muted);}',
      '.ck-score-tgt{font-size:22px;color:var(--aqua);}',
      '.ck-score-lbl{font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;font-weight:700;margin-left:6px;}',
      '.ck-prog-wrap{height:8px;border-radius:6px;background:rgba(0,0,0,.35);overflow:hidden;border:1px solid var(--stroke);}',
      '.ck-prog{height:100%;width:0%;border-radius:6px;background:linear-gradient(90deg,var(--aqua),var(--neon));transition:width .25s ease;}',
      '.ck-hud-right{display:flex;flex-direction:column;align-items:flex-end;gap:8px;}',
      '.ck-lives{font-size:24px;letter-spacing:2px;line-height:1;}',
      '.ck-heart.off{filter:grayscale(1);opacity:.5;}',
      '.ck-timer{font-size:20px;font-weight:900;}',
      '.ck-timer.ck-urgent{color:var(--danger);text-shadow:0 0 12px rgba(255,77,109,.6);animation:ck-blink 1s steps(2) infinite;}',
      '@keyframes ck-blink{50%{opacity:.45}}',

      /* Team */
      '.ck-team{display:flex;flex-wrap:wrap;gap:6px;align-items:center;}',
      '.ck-team-count{font-weight:900;color:var(--aqua);font-size:14px;margin-right:4px;}',
      '.ck-team-chip{font-size:12px;font-weight:700;padding:3px 9px;border-radius:999px;background:rgba(9,32,21,.7);border:1px solid var(--stroke);color:var(--muted);}',
      '.ck-team-chip.me{color:var(--neon);border-color:var(--stroke-2);}',
      '.ck-team-chip.solo{color:var(--leaf);}',

      /* Bestellungen */
      '.ck-orders{display:flex;flex-wrap:wrap;gap:12px;min-height:120px;}',
      '.ck-empty{width:100%;text-align:center;padding:34px 0;}',
      '.ck-card{position:relative;flex:1 1 150px;min-width:150px;max-width:230px;padding:14px 12px 12px;border-radius:16px;',
      'background:rgba(9,32,21,.82);border:2px solid var(--stroke);cursor:pointer;transition:transform .12s,border-color .15s,box-shadow .15s;text-align:center;}',
      '@media(hover:hover){.ck-card:hover{transform:translateY(-2px);box-shadow:var(--glow-soft);}}',
      '.ck-card.sel{border-color:var(--neon);box-shadow:0 0 18px rgba(57,255,20,.35);}',
      '.ck-card.busy{border-color:rgba(51,230,208,.5);}',
      '.ck-card.ready{border-color:var(--gold);box-shadow:0 0 20px rgba(255,210,63,.45);animation:ck-ready 1.1s ease-in-out infinite;}',
      '@keyframes ck-ready{50%{box-shadow:0 0 30px rgba(255,210,63,.75);}}',
      '.ck-card.pulse{animation:ck-cpulse .4s ease;}',
      '@keyframes ck-cpulse{0%{transform:scale(1)}45%{transform:scale(1.07);border-color:var(--neon)}100%{transform:scale(1)}}',
      '.ck-card.err{animation:ck-cerr .4s ease;}',
      '@keyframes ck-cerr{0%,100%{transform:translateX(0)}25%{transform:translateX(-7px);border-color:var(--danger)}75%{transform:translateX(6px);border-color:var(--danger)}}',
      '.ck-dish-icon{font-size:44px;line-height:1;filter:drop-shadow(0 4px 10px rgba(0,0,0,.5));}',
      '.ck-dish-name{font-weight:900;margin-top:4px;font-size:15px;}',
      '.ck-steps{display:flex;flex-wrap:wrap;justify-content:center;align-items:center;gap:4px;margin:9px 0 10px;}',
      '.ck-step{font-size:18px;width:30px;height:30px;display:inline-flex;align-items:center;justify-content:center;border-radius:9px;background:rgba(0,0,0,.3);border:1px solid var(--stroke);transition:.15s;}',
      '.ck-step.done{opacity:.35;filter:grayscale(.6);}',
      '.ck-step.cur{border-color:var(--neon);background:rgba(57,255,20,.16);box-shadow:0 0 10px rgba(57,255,20,.4);animation:ck-stp .9s ease-in-out infinite;}',
      '@keyframes ck-stp{50%{transform:scale(1.12)}}',
      '.ck-step.todo{opacity:.7;}',
      '.ck-step-serve.todo{opacity:.4;}',
      '.ck-step-serve.cur{border-color:var(--gold);background:rgba(255,210,63,.18);box-shadow:0 0 10px rgba(255,210,63,.5);}',
      '.ck-step-arrow{color:var(--muted);font-size:12px;margin:0 1px;}',
      '.ck-bar-wrap{height:7px;border-radius:5px;background:rgba(0,0,0,.4);overflow:hidden;}',
      '.ck-bar{height:100%;width:100%;border-radius:5px;background:var(--aqua);transition:width .12s linear,background .3s;}',
      '.ck-bar.mid{background:var(--gold);}',
      '.ck-bar.low{background:var(--danger);animation:ck-blink .8s steps(2) infinite;}',
      '.ck-active{position:absolute;top:-9px;left:50%;transform:translateX(-50%);white-space:nowrap;font-size:11px;font-weight:800;padding:2px 8px;border-radius:999px;background:var(--aqua);color:#04241f;opacity:0;transition:opacity .15s;pointer-events:none;max-width:95%;overflow:hidden;text-overflow:ellipsis;}',
      '.ck-active.show{opacity:1;}',
      '.ck-active.mine{background:var(--neon);color:#04240a;}',

      /* Hinweis */
      '.ck-hint{text-align:center;font-weight:700;min-height:20px;}',

      /* Stationen */
      '.ck-stations{display:grid;grid-template-columns:repeat(2,1fr);gap:10px;}',
      '@media(min-width:560px){.ck-stations{grid-template-columns:repeat(4,1fr);}}',
      '.ck-station{display:flex;flex-direction:column;align-items:center;gap:4px;padding:16px 8px;border-radius:16px;cursor:pointer;',
      'font-family:inherit;color:var(--text);background:rgba(9,32,21,.85);border:2px solid var(--stroke-2);transition:transform .08s,box-shadow .15s,border-color .15s;user-select:none;-webkit-user-select:none;}',
      '.ck-station:active{transform:scale(.94);}',
      '@media(hover:hover){.ck-station:hover{box-shadow:var(--glow-soft);}}',
      '.ck-station.hot{border-color:var(--neon);box-shadow:0 0 16px rgba(57,255,20,.4);background:rgba(20,55,30,.9);}',
      '.ck-st-serve.hot{border-color:var(--gold);box-shadow:0 0 16px rgba(255,210,63,.45);}',
      '.ck-station.shake{animation:ck-shake .36s ease;border-color:var(--danger)!important;}',
      '.ck-st-icon{font-size:32px;line-height:1;}',
      '.ck-st-label{font-size:13px;font-weight:800;}'
    ].join(''));
  }
})();
