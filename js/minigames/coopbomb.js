/* coopbomb.js — "Bomben-Team": Koop-Entschärfung.
 *
 * KOOP (kein Wettbewerb): ALLE Spieler teilen sich EINE Bombe. Ein großer
 * Countdown läuft; drei Module müssen gemeinsam gelöst werden, bevor die Zeit
 * abläuft: 🔌 Draht-Sequenz, 🎨 Muster-Knöpfe, 🔢 Code. Jeder darf an jedem
 * Modul arbeiten — der Fortschritt ist GETEILT (löst einer einen Schritt,
 * sehen es alle). Alle Module grün = Bombe entschärft = Team gewinnt. Eine
 * falsche Aktion gibt einen ⚡ Strike (geteilt). 3 Strikes ODER Timer abgelaufen
 * = 💥 Bombe explodiert = Team verliert.
 *
 * Architektur: host-autoritativ + Intents (siehe COOP_SPEC).
 *  - Nur der HOST würfelt die Module EINMAL beim Start und hält den maßgeblichen
 *    Zustand in `G`; er pusht ihn ereignisbasiert (gedrosselt ~150ms) via setShared.
 *  - Alle rendern aus dem geteilten Zustand (Host aus G für 0 Latenz, Gäste aus shared).
 *  - Spieler-Aktionen laufen als Intents über reportState(seq/act); der Host
 *    validiert gegen die Lösung und setzt Fortschritt oder Strike.
 *  - Solo: alles lokal, der einzelne Spieler IST der Host.
 */
(function () {
  'use strict';
  window.App = window.App || {}; App.Minigames = App.Minigames || {};
  var UI = App.UI, el = UI.el;

  var DURATION = 90;              // Sekunden bis zur Explosion
  var MAX_STRIKES = 3;

  // Bis zu 7 klar unterscheidbare Draht-Farben (eindeutig pro Draht -> die
  // angezeigte Reihenfolge ist unmissverständlich).
  var WIRE_COLORS = [
    { hex: '#39ff14', name: 'Grün' }, { hex: '#33e6d0', name: 'Türkis' },
    { hex: '#ffd23f', name: 'Gold' }, { hex: '#ff4d6d', name: 'Pink' },
    { hex: '#4d8cff', name: 'Blau' }, { hex: '#b06dff', name: 'Lila' },
    { hex: '#ff9d3f', name: 'Orange' }
  ];
  // 4 Muster-Farben (Simon-artig).
  var PAT_COLORS = [
    { hex: '#39ff14', name: 'Grün' }, { hex: '#33e6d0', name: 'Türkis' },
    { hex: '#ffd23f', name: 'Gold' }, { hex: '#ff4d6d', name: 'Pink' }
  ];

  var genCounter = 0;            // global fortlaufende Bomben-Generation

  injectStyle();

  App.Minigames.coopbomb = {
    id: 'coopbomb', title: 'Bomben-Team', icon: '💣', order: 25,
    subtitle: 'Entschärft die Bombe gemeinsam, bevor die Zeit abläuft',
    coop: true, single: true, multi: true, minPlayers: 2, maxPlayers: 4,

    render: function (root, ctx) {
      var isMulti = ctx.mode === 'multi';
      var room = ctx.room;
      var myName = isMulti ? (ctx.me && ctx.me.name) || 'Spieler' : 'Du';

      /* ---- Laufzeit-Flags ---- */
      var destroyed = false, started = false, amHost = false;
      var timers = [], intervals = [];
      var hostLoop = null, timerStop = null;
      var dirty = false;

      /* ---- Zustand ---- */
      var G = null;              // Host: maßgeblicher Zustand
      var mirror = null;         // Gast: gespiegelter Zustand aus shared
      var lastSeq = {};          // Host: pro Spieler zuletzt verarbeitete Intent-seq
      var evSeq = 0;             // Host: fortlaufende Ereignis-Nummer
      var mySeq = 0;             // Gast: eigener Intent-Zähler
      var shownEvSeq = -1;       // zuletzt angezeigtes Aktivitäts-Ereignis

      /* ---- Render-Buchhaltung ---- */
      var builtGen = -1, endShownGen = -1, timerGen = -1;
      var dom = {};              // DOM-Referenzen (einmal bauen, nur updaten)

      var nowFn = isMulti ? room.now : null;
      function now() { return isMulti ? room.now() : Date.now(); }
      function isHostNow() { return isMulti ? !!room.isHost() : true; }
      function playerCount() { return isMulti ? Math.max(1, room.players().length) : 1; }
      function clone(o) { try { return JSON.parse(JSON.stringify(o)); } catch (e) { return o; } }

      /* ---- Timer-Helfer ---- */
      function after(ms, fn) { var t = setTimeout(fn, ms); timers.push(t); return t; }
      function clearTimers() { timers.forEach(clearTimeout); timers = []; }
      function stopHostLoop() { if (hostLoop) { clearInterval(hostLoop); hostLoop = null; } }
      function stopTimerOnly() { if (timerStop) { try { timerStop(); } catch (e) {} timerStop = null; } }

      /* ============================ START ============================ */
      // Listener früh registrieren, damit nichts verloren geht (Rendern via started-Flag gated).
      if (isMulti) { room.on('shared', onShared); room.on('players', onPlayers); }

      if (isMulti) {
        var snap = room.snapshot() || {};
        var startAt = (snap.round && snap.round.startAt) || (room.now() + 3000);
        // countdown() gibt eine stop-Funktion zurück -> zum Aufräumen merken.
        intervals.push({ stop: App.MG.countdown(root, startAt, function () { begin(startAt); }, room.now) });
      } else {
        begin(Date.now());
      }
      return { cleanup: cleanup };

      function cleanup() {
        destroyed = true;
        clearTimers();
        stopHostLoop();
        stopTimerOnly();
        intervals.forEach(function (o) { try { (o.stop || o)(); } catch (e) {} });
        intervals = [];
        if (isMulti) { try { room.off('shared', onShared); room.off('players', onPlayers); } catch (e) {} }
      }

      /* Nach dem Countdown: Spiel starten. */
      function begin(startAt) {
        if (destroyed) return;
        started = true;
        amHost = isHostNow();
        if (amHost) {
          G = makeGame(startAt, playerCount());
          baselineSeqs();
          pushSharedNow();
        }
        onState();                       // sofort rendern (Host aus G; Gast wartet ggf. auf shared)
        hostLoop = setInterval(hostTick, 150);
      }

      /* ============================ MODUL-ERZEUGUNG (nur Host) ============================ */
      function shuffled(n) {
        var a = []; for (var i = 0; i < n; i++) a.push(i);
        for (var j = a.length - 1; j > 0; j--) { var k = Math.floor(Math.random() * (j + 1)); var t = a[j]; a[j] = a[k]; a[k] = t; }
        return a;
      }
      function makeGame(startAt, pc) {
        var extra = Math.min(Math.max(pc - 1, 0), 3);   // 0..3 -> skaliert leicht mit Spielerzahl

        // 🔌 Draht-Sequenz: eindeutige Farben; eine Teilmenge muss in Reihenfolge geschnitten werden.
        var wireLen = 3 + extra;                        // 3..6 Schnitte
        var wireCount = Math.min(wireLen + 1, WIRE_COLORS.length); // +1 Ablenk-Draht
        if (wireLen > wireCount) wireLen = wireCount;
        var wires = shuffled(WIRE_COLORS.length).slice(0, wireCount);   // wires[i] = FarbIndex des Drahts i
        var order = shuffled(wireCount).slice(0, wireLen);              // Reihenfolge als Draht-Indizes
        var cut = []; for (var w = 0; w < wireCount; w++) cut.push(false);
        var wireMod = { type: 'wire', title: 'Draht-Sequenz', icon: '🔌', done: false, pos: 0,
                        wires: wires, order: order, cut: cut };

        // 🎨 Muster-Knöpfe (Simon-artig): Farbfolge nachtippen.
        var patLen = 3 + extra;                          // 3..6
        var pattern = []; for (var p = 0; p < patLen; p++) pattern.push(Math.floor(Math.random() * PAT_COLORS.length));
        var patMod = { type: 'pat', title: 'Muster-Knöpfe', icon: '🎨', done: false, pos: 0, pattern: pattern };

        // 🔢 Code: angezeigten Zahlencode eingeben.
        var codeLen = 3 + extra;                          // 3..6
        var code = []; for (var c = 0; c < codeLen; c++) code.push(Math.floor(Math.random() * 10));
        var codeMod = { type: 'code', title: 'Code-Eingabe', icon: '🔢', done: false, pos: 0, code: code };

        return {
          gen: ++genCounter,
          startAt: startAt, endAt: startAt + DURATION * 1000,
          strikes: 0, over: false, win: false, stats: null,
          modules: [wireMod, patMod, codeMod],
          lastEvent: { seq: ++evSeq, text: 'Bombe scharf! Entschärft alle 3 Module. 💣' },
          players: pc
        };
      }

      /* ============================ INTENTS / HOST-LOGIK ============================ */
      function baselineSeqs() {
        lastSeq = {};
        if (!isMulti) return;
        room.players().forEach(function (p) { lastSeq[p.id] = (p.state && p.state.seq) || 0; });
      }

      // Eigene Aktion: Host wendet sie direkt an, Gast schickt einen Intent.
      function doLocal(act) {
        if (destroyed || !started) return;
        var vs = amHost ? G : mirror;
        if (!vs || vs.over) return;
        if (amHost) { applyAction(act, myName); afterChange(); }
        else {
          mySeq++;
          try { room.reportState({ seq: mySeq, act: act, by: myName, t: now() }); } catch (e) {}
        }
      }

      // Host verarbeitet neue Intents der anderen Spieler (genau EINMAL je seq).
      function processIntents() {
        if (!amHost || !isMulti || !G || G.over) return false;
        var changed = false;
        room.players().forEach(function (p) {
          if (p.id === ctx.me.id) return;               // eigene Aktionen laufen direkt
          var s = p.state;
          if (s && typeof s.seq === 'number' && s.seq > (lastSeq[p.id] || 0)) {
            lastSeq[p.id] = s.seq;
            if (s.act) { applyAction(s.act, s.by || p.name || 'Mitspieler'); changed = true; }
          }
        });
        return changed;
      }

      function event(text) { if (G) G.lastEvent = { seq: ++evSeq, text: text }; }

      function strike(byName, what) {
        if (!G || G.over) return;
        G.strikes++;
        event('⚡ Strike von ' + byName + ' (' + what + ')  ·  ' + G.strikes + '/' + MAX_STRIKES);
        if (G.strikes >= MAX_STRIKES) endGame(false);
      }

      // Kernvalidierung: prüft eine Aktion gegen die Lösung und aktualisiert G.
      function applyAction(act, byName) {
        if (!G || G.over || !act) return;
        var idx = act.mod | 0;
        var m = G.modules[idx];
        if (!m || m.done) return;

        if (m.type === 'wire') {
          var wi = act.wire | 0;
          if (wi < 0 || wi >= m.wires.length || m.cut[wi]) return;   // schon geschnitten -> ignorieren
          if (wi === m.order[m.pos]) {
            m.cut[wi] = true; m.pos++;
            if (m.pos >= m.order.length) { m.done = true; event(byName + ' hat 🔌 Draht-Sequenz entschärft! ✅'); }
            else event(byName + ' schneidet einen Draht durch ✂️');
          } else {
            strike(byName, '🔌 falscher Draht');   // falschen Draht NICHT schneiden -> bleibt lösbar
          }
        } else if (m.type === 'pat') {
          var c = act.color | 0;
          if (c === m.pattern[m.pos]) {
            m.pos++;
            if (m.pos >= m.pattern.length) { m.done = true; event(byName + ' hat 🎨 Muster entschärft! ✅'); }
            else event(byName + ' trifft den nächsten Knopf 🎨');
          } else {
            m.pos = 0; strike(byName, '🎨 Muster verhauen');
          }
        } else if (m.type === 'code') {
          var d = act.digit | 0;
          if (d === m.code[m.pos]) {
            m.pos++;
            if (m.pos >= m.code.length) { m.done = true; event(byName + ' hat 🔢 Code geknackt! ✅'); }
            else event(byName + ' tippt eine Ziffer 🔢');
          } else {
            m.pos = 0; strike(byName, '🔢 falsche Ziffer');
          }
        }

        // Sieg? Alle Module entschärft.
        if (!G.over) {
          var allDone = true;
          for (var i = 0; i < G.modules.length; i++) if (!G.modules[i].done) { allDone = false; break; }
          if (allDone) endGame(true);
        }
      }

      function endGame(win) {
        if (!G || G.over) return;
        G.over = true; G.win = win;
        var solved = 0; for (var i = 0; i < G.modules.length; i++) if (G.modules[i].done) solved++;
        var secLeft = Math.max(0, Math.round((G.endAt - now()) / 1000));
        G.stats = { solved: solved, total: G.modules.length, strikes: G.strikes, secLeft: secLeft };
        event(win ? '✅ Bombe entschärft!' : '💥 BOOM!');
      }

      // Nach einer Host-Änderung: sofort rendern + geteilten Zustand pushen.
      function afterChange() {
        onState();
        if (isMulti && G) {
          if (G.over) pushSharedNow();      // Ende sofort verteilen
          else dirty = true;                 // sonst gedrosselt im hostLoop
        }
      }

      function pushSharedNow() {
        if (!isMulti || !G) return;
        try { room.setShared({ st: clone(G) }); } catch (e) {}
        dirty = false;
      }

      // Host-Migration: wird ein Gast plötzlich Host, übernimmt er den gespiegelten Zustand.
      function adoptHost() {
        if (!G) {
          G = mirror ? clone(mirror) : null;
          if (G) { evSeq = (G.lastEvent && G.lastEvent.seq) || 0; }
        }
        baselineSeqs();                       // alles bis jetzt gilt als verarbeitet
        dirty = true;
      }

      function hostTick() {
        if (destroyed) return;
        var host = isHostNow();
        if (host && !amHost) adoptHost();
        amHost = host;
        if (!amHost || !G) return;
        if (!G.over) {
          if (processIntents()) afterChange();
          if (!G.over && now() >= G.endAt) { endGame(false); afterChange(); }
        }
        if (dirty) pushSharedNow();
      }

      /* ============================ NETZ-EVENTS ============================ */
      function onShared(shared) {
        if (destroyed) return;
        shared = shared || {};
        if (shared.st) mirror = shared.st;
        onState();
      }
      function onPlayers() {
        if (destroyed) return;
        if (amHost) { if (processIntents()) afterChange(); }
        updateTeam();
      }

      /* ============================ RENDER ============================ */
      function cur() { return amHost ? G : mirror; }

      function onState() {
        if (!started || destroyed) return;
        var vs = cur();
        if (!vs) { showWaiting(); return; }
        if (builtGen !== vs.gen) {
          buildPlay(vs);
          builtGen = vs.gen; endShownGen = -1; shownEvSeq = -1;
          startBombTimer(vs);
        }
        if (vs.over) {
          if (endShownGen !== vs.gen) { endShownGen = vs.gen; showEnd(vs); }
          return;
        }
        updatePlay(vs);
      }

      function showWaiting() {
        if (dom.waiting) return;
        dom = {};
        root.innerHTML = '';
        root.appendChild(el('div', { class: 'mg-cb-waiting glass' }, [
          el('div', { class: 'mg-cb-wemoji' }, ['💣']),
          el('p', { class: 'hint-text' }, ['Warte auf den Host …'])
        ]));
        dom.waiting = true;
      }

      function startBombTimer(vs) {
        stopTimerOnly();
        timerGen = vs.gen;
        timerStop = App.MG.roundTimer(vs.endAt, tickTimer, onTimerZero, nowFn);
      }
      function tickTimer(left) {
        if (!dom.timerEl) return;
        dom.timerEl.textContent = '⏱ ' + App.MG.mmss(left);
        var urgent = left <= 15;
        dom.timerEl.classList.toggle('urgent', urgent);
        if (dom.head) dom.head.classList.toggle('is-urgent', urgent);
      }
      function onTimerZero() {
        if (amHost && G && !G.over) { endGame(false); afterChange(); }
      }

      /* ---- DOM einmalig bauen ---- */
      function buildPlay(vs) {
        dom = {};

        // Kopf: Titel + Team + Strikes + Timer
        var title = el('div', { class: 'mg-cb-title' }, ['💣 BOMBE']);
        dom.teamEl = el('div', { class: 'mg-cb-team' }, ['']);
        var left = el('div', { class: 'mg-cb-head-l' }, [title, dom.teamEl]);

        dom.strikeLamps = [];
        var lampWrap = el('div', { class: 'mg-cb-strikes' });
        for (var s = 0; s < MAX_STRIKES; s++) {
          var lamp = el('div', { class: 'mg-cb-lamp' }, ['⚡']);
          dom.strikeLamps.push(lamp); lampWrap.appendChild(lamp);
        }
        dom.timerEl = el('div', { class: 'mg-cb-timer' }, ['⏱ ' + App.MG.mmss(DURATION)]);
        var right = el('div', { class: 'mg-cb-head-r' }, [
          el('div', { class: 'mg-cb-strikes-wrap' }, [el('span', { class: 'mg-cb-strikes-l' }, ['Strikes']), lampWrap]),
          dom.timerEl
        ]);
        dom.head = el('div', { class: 'mg-cb-head glass' }, [left, right]);

        // Module
        dom.modules = [];
        var grid = el('div', { class: 'mg-cb-modules' });
        vs.modules.forEach(function (m, i) { grid.appendChild(buildModule(m, i)); });

        // Aktivitäts-Ticker
        dom.activityEl = el('div', { class: 'mg-cb-activity glass' }, ['']);

        var wrap = el('div', { class: 'mg-cb-wrap' }, [
          dom.head,
          el('p', { class: 'mg-cb-hint hint-text' }, ['Teilt euch auf – jeder ein Modul! Alle 3 grün = entschärft.']),
          grid,
          dom.activityEl
        ]);
        root.innerHTML = ''; root.appendChild(wrap);
        updateTeam();
      }

      function buildModule(m, idx) {
        var refs = { idx: idx, type: m.type };
        var statusEl = el('div', { class: 'mg-cb-status' }, ['aktiv']);
        var head = el('div', { class: 'mg-cb-mhead' }, [
          el('span', { class: 'mg-cb-micon' }, [m.icon]),
          el('span', { class: 'mg-cb-mtitle' }, [m.title]),
          statusEl
        ]);
        var body = el('div', { class: 'mg-cb-mbody' });

        if (m.type === 'wire') {
          // Reihenfolge-Chips (Vorgabe – für alle sichtbar)
          refs.orderChips = [];
          var orderWrap = el('div', { class: 'mg-cb-order' }, [el('span', { class: 'mg-cb-order-l' }, ['Reihenfolge:'])]);
          m.order.forEach(function (wi, k) {
            var chip = el('div', { class: 'mg-cb-chip' }, [String(k + 1)]);
            chip.style.background = WIRE_COLORS[m.wires[wi]].hex;
            refs.orderChips.push(chip); orderWrap.appendChild(chip);
          });
          // Draht-Knöpfe
          refs.wireBtns = [];
          var wiresWrap = el('div', { class: 'mg-cb-wires' });
          m.wires.forEach(function (colIdx, i) {
            var bar = el('div', { class: 'mg-cb-wbar' });
            bar.style.background = WIRE_COLORS[colIdx].hex;
            var btn = el('button', { class: 'mg-cb-wire', type: 'button', 'aria-label': 'Draht ' + WIRE_COLORS[colIdx].name }, [
              bar, el('span', { class: 'mg-cb-wname' }, [WIRE_COLORS[colIdx].name]), el('span', { class: 'mg-cb-scissor' }, ['✂'])
            ]);
            (function (wireIdx, button) {
              button.addEventListener('pointerdown', function (e) { e.preventDefault(); pressFx(button); doLocal({ type: 'wire', mod: idx, wire: wireIdx }); });
            })(i, btn);
            refs.wireBtns.push(btn); wiresWrap.appendChild(btn);
          });
          body.appendChild(orderWrap); body.appendChild(wiresWrap);

        } else if (m.type === 'pat') {
          refs.patDots = [];
          var patWrap = el('div', { class: 'mg-cb-pattern' }, [el('span', { class: 'mg-cb-order-l' }, ['Folge:'])]);
          m.pattern.forEach(function (colIdx, k) {
            var dot = el('div', { class: 'mg-cb-pdot' });
            dot.style.background = PAT_COLORS[colIdx].hex;
            refs.patDots.push(dot); patWrap.appendChild(dot);
          });
          refs.progEl = el('div', { class: 'mg-cb-prog' }, ['0 / ' + m.pattern.length]);
          refs.pads = [];
          var padsWrap = el('div', { class: 'mg-cb-pads' });
          PAT_COLORS.forEach(function (col, c) {
            var pad = el('button', { class: 'mg-cb-pad', type: 'button', 'aria-label': col.name });
            pad.style.setProperty('--pc', col.hex);
            (function (colorIdx, button) {
              button.addEventListener('pointerdown', function (e) { e.preventDefault(); pressFx(button); flashPad(button); doLocal({ type: 'pat', mod: idx, color: colorIdx }); });
            })(c, pad);
            refs.pads.push(pad); padsWrap.appendChild(pad);
          });
          body.appendChild(patWrap); body.appendChild(refs.progEl); body.appendChild(padsWrap);

        } else { // code
          refs.codeSlots = [];
          var codeWrap = el('div', { class: 'mg-cb-code' });
          m.code.forEach(function (dig, k) {
            var slot = el('div', { class: 'mg-cb-slot' }, [String(dig)]);
            refs.codeSlots.push(slot); codeWrap.appendChild(slot);
          });
          refs.keys = [];
          var keypad = el('div', { class: 'mg-cb-keypad' });
          for (var d = 0; d < 10; d++) {
            var key = el('button', { class: 'mg-cb-key', type: 'button' }, [String(d)]);
            (function (digit, button) {
              button.addEventListener('pointerdown', function (e) { e.preventDefault(); pressFx(button); doLocal({ type: 'code', mod: idx, digit: digit }); });
            })(d, key);
            refs.keys.push(key); keypad.appendChild(key);
          }
          body.appendChild(codeWrap); body.appendChild(keypad);
        }

        var overlay = el('div', { class: 'mg-cb-defused' }, [el('span', {}, ['✓ ENTSCHÄRFT'])]);
        var modRoot = el('div', { class: 'mg-cb-mod glass' }, [head, body, overlay]);
        refs.root = modRoot; refs.statusEl = statusEl; refs.overlay = overlay;
        dom.modules[idx] = refs;
        return modRoot;
      }

      function pressFx(node) { if (!node) return; node.classList.remove('press'); void node.offsetWidth; node.classList.add('press'); }
      function flashPad(node) { if (!node) return; node.classList.add('lit'); after(200, function () { if (node) node.classList.remove('lit'); }); }

      /* ---- Nur Zustände aktualisieren (kein Neuaufbau) ---- */
      function updatePlay(vs) {
        if (!dom.modules) return;
        // Strikes
        for (var s = 0; s < MAX_STRIKES; s++) {
          if (dom.strikeLamps[s]) dom.strikeLamps[s].classList.toggle('on', s < vs.strikes);
        }
        // Module
        vs.modules.forEach(function (m, i) { updateModule(m, i, vs.over); });
        // Aktivität
        if (vs.lastEvent && vs.lastEvent.seq !== shownEvSeq) {
          shownEvSeq = vs.lastEvent.seq;
          if (dom.activityEl) {
            dom.activityEl.textContent = vs.lastEvent.text || '';
            pressFx(dom.activityEl);
          }
        }
        updateTeam();
      }

      function updateModule(m, i, over) {
        var r = dom.modules[i]; if (!r) return;
        var locked = m.done || over;
        r.root.classList.toggle('done', !!m.done);
        r.statusEl.textContent = m.done ? '✓ entschärft' : 'aktiv';
        r.statusEl.classList.toggle('ok', !!m.done);

        if (m.type === 'wire') {
          r.orderChips.forEach(function (chip, k) {
            chip.classList.toggle('done', k < m.pos);
            chip.classList.toggle('next', !m.done && k === m.pos);
          });
          r.wireBtns.forEach(function (btn, wi) {
            btn.classList.toggle('cut', !!m.cut[wi]);
            btn.disabled = locked || !!m.cut[wi];
          });
        } else if (m.type === 'pat') {
          r.patDots.forEach(function (dot, k) { dot.classList.toggle('done', k < m.pos); });
          if (r.progEl) r.progEl.textContent = m.pos + ' / ' + m.pattern.length;
          r.pads.forEach(function (pad) { pad.disabled = locked; });
        } else { // code
          r.codeSlots.forEach(function (slot, k) { slot.classList.toggle('filled', k < m.pos); });
          r.keys.forEach(function (key) { key.disabled = locked; });
        }
      }

      function updateTeam() {
        if (!dom.teamEl) return;
        if (isMulti) {
          var ps = room.players();
          var names = ps.map(function (p) { return p.name + (p.id === ctx.me.id ? ' (du)' : ''); }).join(', ');
          dom.teamEl.textContent = '👥 ' + ps.length + ' im Team: ' + names;
        } else {
          dom.teamEl.textContent = '👤 Solo-Übung';
        }
      }

      /* ============================ ENDE ============================ */
      function showEnd(vs) {
        stopTimerOnly();
        var st = vs.stats || { solved: 0, total: (vs.modules || []).length, strikes: vs.strikes || 0, secLeft: 0 };
        var canAgain = (!isMulti) || amHost;
        App.MG.teamEnd(root, {
          win: !!vs.win,
          title: vs.win ? '🎉 Bombe entschärft!' : '💥 Bombe explodiert',
          subtitle: vs.win
            ? (isMulti ? 'Starke Teamarbeit – ihr habt es geschafft!' : 'Sauber entschärft!')
            : (canAgain ? 'Zu spät … versucht es nochmal!' : 'Warte auf den Host für eine neue Runde …'),
          lines: [
            'Module gelöst: ' + st.solved + '/' + st.total,
            'Strikes: ' + st.strikes + '/' + MAX_STRIKES,
            'Restzeit: ' + st.secLeft + 's'
          ],
          onAgain: canAgain ? startFresh : undefined,
          onExit: ctx.onExit,
          exitLabel: isMulti ? 'Zurück zur Lobby' : 'Zurück'
        });
      }

      // Neue Bombe (Solo-Neustart / Host startet neu). Gäste folgen via neuer gen.
      function startFresh() {
        if (destroyed) return;
        stopTimerOnly();
        builtGen = -1; endShownGen = -1; timerGen = -1; shownEvSeq = -1;
        amHost = isHostNow();
        if (!amHost) return;                 // Sicherheit: nur Host/Solo erzeugt
        G = makeGame(now(), playerCount());
        baselineSeqs();
        onState();
        if (isMulti) pushSharedNow();
      }
    }
  };

  /* ============================ STYLES ============================ */
  function injectStyle() {
    UI.injectStyle('mg-coopbomb-css', [
      '.mg-cb-wrap{display:flex;flex-direction:column;gap:14px;max-width:1000px;margin:0 auto;width:100%;}',
      '.mg-cb-waiting{padding:40px;text-align:center;display:flex;flex-direction:column;gap:10px;align-items:center;max-width:440px;margin:0 auto;}',
      '.mg-cb-wemoji{font-size:56px;animation:mg-cb-pulse 1.2s infinite;}',

      '.mg-cb-head{display:flex;justify-content:space-between;align-items:center;gap:14px;padding:14px 18px;flex-wrap:wrap;border:1px solid var(--stroke-2);}',
      '.mg-cb-head.is-urgent{box-shadow:0 0 26px rgba(255,77,109,.4);border-color:var(--danger);}',
      '.mg-cb-head-l{display:flex;flex-direction:column;gap:3px;min-width:0;}',
      '.mg-cb-title{font-size:clamp(20px,5vw,28px);font-weight:900;letter-spacing:1px;color:var(--text);text-shadow:0 0 14px rgba(255,77,109,.35);}',
      '.mg-cb-team{font-size:12px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:60vw;}',
      '.mg-cb-head-r{display:flex;align-items:center;gap:18px;flex-wrap:wrap;}',
      '.mg-cb-strikes-wrap{display:flex;flex-direction:column;gap:3px;align-items:flex-start;}',
      '.mg-cb-strikes-l{font-size:10px;text-transform:uppercase;letter-spacing:1px;color:var(--muted);}',
      '.mg-cb-strikes{display:flex;gap:6px;}',
      '.mg-cb-lamp{width:30px;height:30px;border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:15px;',
      'background:rgba(9,32,21,.7);border:1px solid var(--stroke);color:rgba(255,255,255,.18);transition:all .15s;}',
      '.mg-cb-lamp.on{background:rgba(255,77,109,.22);border-color:var(--danger);color:var(--danger);box-shadow:0 0 12px rgba(255,77,109,.7);}',
      '.mg-cb-timer{font-size:clamp(24px,6vw,34px);font-weight:900;font-variant-numeric:tabular-nums;color:var(--aqua);letter-spacing:1px;}',
      '.mg-cb-timer.urgent{color:var(--danger);animation:mg-cb-pulse .7s infinite;text-shadow:0 0 16px rgba(255,77,109,.6);}',

      '.mg-cb-hint{text-align:center;margin:-4px 0 2px;}',
      '.mg-cb-modules{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:14px;}',
      '.mg-cb-mod{position:relative;padding:16px;display:flex;flex-direction:column;gap:12px;border:1px solid var(--stroke);overflow:hidden;transition:box-shadow .2s,border-color .2s;}',
      '.mg-cb-mod.done{border-color:var(--neon);box-shadow:0 0 22px rgba(57,255,20,.35);}',
      '.mg-cb-mhead{display:flex;align-items:center;gap:8px;}',
      '.mg-cb-micon{font-size:22px;}',
      '.mg-cb-mtitle{font-weight:800;flex:1;color:var(--text);}',
      '.mg-cb-status{font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:1px;color:var(--muted);padding:3px 8px;border-radius:999px;border:1px solid var(--stroke);}',
      '.mg-cb-status.ok{color:#04160c;background:var(--neon);border-color:var(--neon);}',
      '.mg-cb-mbody{display:flex;flex-direction:column;gap:10px;}',

      // Defused-Overlay
      '.mg-cb-defused{position:absolute;inset:0;display:none;align-items:center;justify-content:center;',
      'background:rgba(6,26,14,.82);backdrop-filter:blur(2px);color:var(--neon);font-weight:900;font-size:20px;letter-spacing:2px;',
      'text-shadow:0 0 16px rgba(57,255,20,.7);animation:mg-cb-pop .35s ease;}',
      '.mg-cb-mod.done .mg-cb-defused{display:flex;}',

      // Draht-Modul
      '.mg-cb-order{display:flex;align-items:center;gap:6px;flex-wrap:wrap;}',
      '.mg-cb-order-l{font-size:12px;color:var(--muted);font-weight:700;margin-right:2px;}',
      '.mg-cb-chip{width:26px;height:26px;border-radius:7px;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:900;color:#04160c;',
      'border:2px solid rgba(0,0,0,.35);box-shadow:0 0 6px rgba(0,0,0,.4);transition:all .15s;}',
      '.mg-cb-chip.done{opacity:.28;filter:grayscale(.5);}',
      '.mg-cb-chip.next{outline:3px solid #fff;outline-offset:1px;animation:mg-cb-pulse .9s infinite;}',
      '.mg-cb-wires{display:flex;flex-direction:column;gap:8px;}',
      '.mg-cb-wire{display:flex;align-items:center;gap:10px;padding:8px 12px;border-radius:12px;cursor:pointer;',
      'background:linear-gradient(160deg,rgba(0,0,0,.4),rgba(0,0,0,.7));border:1px solid var(--stroke);',
      '-webkit-tap-highlight-color:transparent;touch-action:manipulation;transition:transform .1s,opacity .2s;min-height:44px;}',
      '.mg-cb-wire:active{transform:scale(.98);}',
      '.mg-cb-wbar{width:44px;height:12px;border-radius:6px;flex:0 0 auto;box-shadow:0 0 8px rgba(255,255,255,.15);}',
      '.mg-cb-wname{flex:1;text-align:left;font-weight:700;color:var(--text);font-size:14px;}',
      '.mg-cb-scissor{opacity:0;font-size:16px;transition:opacity .15s;}',
      '.mg-cb-wire:hover .mg-cb-scissor{opacity:.5;}',
      '.mg-cb-wire.cut{opacity:.4;}',
      '.mg-cb-wire.cut .mg-cb-wbar{height:3px;background:var(--muted)!important;box-shadow:none;}',
      '.mg-cb-wire.cut .mg-cb-scissor{opacity:1;}',
      '.mg-cb-wire:disabled{cursor:default;}',

      // Muster-Modul
      '.mg-cb-pattern{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}',
      '.mg-cb-pdot{width:22px;height:22px;border-radius:50%;box-shadow:0 0 8px rgba(255,255,255,.2);transition:opacity .15s;}',
      '.mg-cb-pdot.done{opacity:.22;filter:grayscale(.6);}',
      '.mg-cb-prog{font-size:12px;font-weight:800;color:var(--aqua-soft);}',
      '.mg-cb-pads{display:grid;grid-template-columns:1fr 1fr;gap:8px;}',
      '.mg-cb-pad{position:relative;height:60px;border-radius:14px;cursor:pointer;overflow:hidden;border:2px solid var(--pc);',
      'background:linear-gradient(160deg,rgba(0,0,0,.5),rgba(0,0,0,.78));-webkit-tap-highlight-color:transparent;touch-action:manipulation;transition:transform .1s;}',
      '.mg-cb-pad::before{content:"";position:absolute;inset:0;background:var(--pc);opacity:.16;transition:opacity .12s;}',
      '.mg-cb-pad:active{transform:scale(.96);}',
      '.mg-cb-pad.lit::before{opacity:.9;}',
      '.mg-cb-pad.lit{box-shadow:0 0 22px var(--pc),inset 0 0 30px rgba(255,255,255,.25);}',
      '.mg-cb-pad:disabled{cursor:default;opacity:.55;}',

      // Code-Modul
      '.mg-cb-code{display:flex;gap:6px;flex-wrap:wrap;justify-content:center;}',
      '.mg-cb-slot{min-width:34px;height:44px;padding:0 6px;border-radius:10px;display:flex;align-items:center;justify-content:center;',
      'font-size:22px;font-weight:900;font-variant-numeric:tabular-nums;background:rgba(4,16,10,.7);border:1px solid var(--stroke);color:var(--muted);transition:all .15s;}',
      '.mg-cb-slot.filled{color:#04160c;background:var(--neon);border-color:var(--neon);box-shadow:0 0 10px rgba(57,255,20,.5);}',
      '.mg-cb-keypad{display:grid;grid-template-columns:repeat(5,1fr);gap:6px;}',
      '.mg-cb-key{height:46px;border-radius:10px;cursor:pointer;font-size:18px;font-weight:900;color:var(--text);',
      'background:linear-gradient(160deg,rgba(9,32,21,.8),rgba(4,16,10,.9));border:1px solid var(--stroke);',
      '-webkit-tap-highlight-color:transparent;touch-action:manipulation;transition:transform .1s;}',
      '.mg-cb-key:active{transform:scale(.94);}',
      '.mg-cb-key:disabled{cursor:default;opacity:.5;}',

      // Aktivitäts-Ticker
      '.mg-cb-activity{padding:10px 14px;text-align:center;font-weight:700;font-size:14px;color:var(--leaf);min-height:20px;}',

      '.press{animation:mg-cb-press .18s ease;}',
      '@keyframes mg-cb-press{0%{transform:scale(1);}45%{transform:scale(.94);}100%{transform:scale(1);}}',
      '@keyframes mg-cb-pulse{50%{opacity:.4;}}',
      '@keyframes mg-cb-pop{0%{transform:scale(.6);opacity:0;}100%{transform:scale(1);opacity:1;}}',

      '@media(max-width:560px){.mg-cb-head-r{width:100%;justify-content:space-between;}.mg-cb-team{max-width:100%;}}'
    ].join(''));
  }
})();
