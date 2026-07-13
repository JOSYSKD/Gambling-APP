/* simon.js — "Simon-Sequenz": Merk-dir-die-Farbfolge-Wettbewerb.
 * Das Spiel zeigt eine leuchtende Neon-Farbfolge (mit leisem WebAudio-Ton),
 * die pro Level um 1 wächst. Der Spieler tippt sie nach: richtig -> nächstes
 * Level + Punkte (Level×10), Fehler -> kurze Fehler-Animation und die Folge
 * startet neu bei Länge 1 (Punkte & Bestlevel bleiben erhalten). In 90 s so
 * hoch wie möglich. Singleplayer (Bestwert) + Multiplayer (Live-Rangliste,
 * Podest). Timer/Countdown über Wall-Clock -> Tab-Wechsel-sicher. */
(function () {
  'use strict';
  window.App = window.App || {}; App.Minigames = App.Minigames || {};
  var UI = App.UI, el = UI.el;

  var DURATION = 90; // Sekunden Rundenzeit

  // 4 Neon-Felder: grün, türkis, gold, pink — je eigene Tonhöhe.
  var COLORS = [
    { cls: 'c0', name: 'Grün',   freq: 415.30 },
    { cls: 'c1', name: 'Türkis', freq: 349.23 },
    { cls: 'c2', name: 'Gold',   freq: 277.18 },
    { cls: 'c3', name: 'Pink',   freq: 233.08 }
  ];

  injectStyle();

  App.Minigames.simon = {
    id: 'simon', title: 'Simon-Sequenz', icon: '🎨', order: 5,
    subtitle: 'Merk dir die Farbfolge und wiederhole sie',
    single: true, multi: true, minPlayers: 2, maxPlayers: 8,

    render: function (root, ctx) {
      var isMulti = ctx.mode === 'multi';
      var destroyed = false, finished = false, locked = true;
      var timers = [], stops = [];
      var audio = null, muted = false;

      /* ---- Spielzustand ---- */
      var seq = [], inputPos = 0, curLen = 1, bestLevel = 0, points = 0;

      /* ---- DOM-Referenzen ---- */
      var pads = [], levelEl = null, bestEl = null, pointsEl = null,
          timerEl = null, statusEl = null, gridEl = null, boardWrap = null, board = null;

      /* ---- Timer-Helfer (Tab-sicher via App.MG-Wall-Clock, Timeouts getrackt) ---- */
      function after(ms, fn) { var t = setTimeout(fn, ms); timers.push(t); return t; }
      function clearTimers() { timers.forEach(clearTimeout); timers = []; }
      function clearStops() { stops.forEach(function (f) { try { f(); } catch (e) {} }); stops = []; }
      function clearAll() { clearTimers(); clearStops(); }

      /* ---- WebAudio (leise, optional, komplett robust) ---- */
      function ensureAudio() {
        if (audio) return audio;
        try { var AC = window.AudioContext || window.webkitAudioContext; if (AC) audio = new AC(); }
        catch (e) { audio = null; }
        return audio;
      }
      function resumeAudio() { try { if (audio && audio.state === 'suspended') audio.resume(); } catch (e) {} }
      function tone(freq, dur) {
        if (muted) return;
        try {
          var a = ensureAudio(); if (!a) return; resumeAudio();
          var o = a.createOscillator(), g = a.createGain(), now = a.currentTime;
          dur = dur || 0.35;
          o.type = 'sine'; o.frequency.value = freq;
          g.gain.setValueAtTime(0.0001, now);
          g.gain.exponentialRampToValueAtTime(0.11, now + 0.02);
          g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
          o.connect(g); g.connect(a.destination);
          o.start(now); o.stop(now + dur + 0.03);
        } catch (e) {}
      }
      function errorTone() {
        if (muted) return;
        try {
          var a = ensureAudio(); if (!a) return; resumeAudio();
          var o = a.createOscillator(), g = a.createGain(), now = a.currentTime;
          o.type = 'sawtooth';
          o.frequency.setValueAtTime(180, now);
          o.frequency.exponentialRampToValueAtTime(70, now + 0.4);
          g.gain.setValueAtTime(0.0001, now);
          g.gain.exponentialRampToValueAtTime(0.13, now + 0.02);
          g.gain.exponentialRampToValueAtTime(0.0001, now + 0.45);
          o.connect(g); g.connect(a.destination);
          o.start(now); o.stop(now + 0.48);
        } catch (e) {}
      }

      // Erstes User-Gesture -> AudioContext freigeben (Autoplay-Policy).
      document.addEventListener('pointerdown', resumeAudio);

      /* ---- Start ---- */
      if (isMulti) {
        var snap = ctx.room.snapshot() || {};
        var startAt = (snap.round && snap.round.startAt) || (ctx.room.now() + 3000);
        stops.push(App.MG.countdown(root, startAt, function () { play(startAt); }, ctx.room.now));
      } else {
        play(Date.now());
      }
      return { cleanup: cleanup };

      function cleanup() {
        destroyed = true;
        clearAll();
        document.removeEventListener('pointerdown', resumeAudio);
        if (audio) { try { audio.close(); } catch (e) {} audio = null; }
      }

      function randColor() { return Math.floor(Math.random() * 4); }
      function safeReport(n) { if (!isMulti) return; try { ctx.room.reportScore(Math.floor(n)); } catch (e) {} }

      /* ===================== RUNDE ===================== */
      function play(startAt) {
        clearAll();
        destroyed = false; finished = false; locked = true;
        seq = [randColor()]; inputPos = 0; curLen = 1; bestLevel = 0; points = 0;

        var endAt = startAt + DURATION * 1000;
        buildUI();
        updateHUD();
        safeReport(0);

        // Rundentimer (Wall-Clock; im Multi mit room.now synchron).
        var nowFn = isMulti ? ctx.room.now : null;
        stops.push(App.MG.roundTimer(endAt, updateTimer, finish, nowFn));

        // Live-Rangliste (Multiplayer).
        if (isMulti && boardWrap) {
          board = App.MG.liveBoard(ctx.room, ctx.me.id);
          stops.push(board.stop);
          boardWrap.appendChild(board.root);
        }

        // Kurz Luft holen, dann erste Folge vorspielen.
        after(750, playSequence);
      }

      /* ===================== UI ===================== */
      function stat(label, val, assign) {
        var v = el('div', { class: 'mg-simon-stat-v' }, [val]); assign(v);
        return el('div', { class: 'mg-simon-stat' }, [
          el('div', { class: 'mg-simon-stat-l' }, [label]), v
        ]);
      }

      function buildUI() {
        pads = [];
        var stats = el('div', { class: 'mg-simon-stats' }, [
          stat('Level',     '1', function (e) { levelEl = e; }),
          stat('Bestlevel', '0', function (e) { bestEl = e; }),
          stat('Punkte',    '0', function (e) { pointsEl = e; })
        ]);
        timerEl = el('div', { class: 'mg-timer mg-simon-timer' }, ['⏱ ' + App.MG.mmss(DURATION)]);
        var soundBtn = el('button', { class: 'btn btn-ghost mg-simon-sound', type: 'button', title: 'Ton an/aus' }, [muted ? '🔇' : '🔊']);
        soundBtn.addEventListener('click', function () {
          muted = !muted; soundBtn.textContent = muted ? '🔇' : '🔊';
          if (!muted) { ensureAudio(); resumeAudio(); }
        });

        var head = el('div', { class: 'mg-simon-head glass' }, [
          stats,
          el('div', { class: 'mg-simon-head-right' }, [timerEl, soundBtn])
        ]);

        statusEl = el('div', { class: 'mg-simon-status' }, ['Bereit …']);

        var grid = el('div', { class: 'mg-simon-grid' });
        COLORS.forEach(function (c, i) {
          var pad = el('div', { class: 'mg-simon-pad ' + c.cls, role: 'button', 'aria-label': c.name });
          pad.addEventListener('pointerdown', function (ev) { ev.preventDefault(); onTap(i); });
          grid.appendChild(pad); pads.push(pad);
        });
        gridEl = grid;

        boardWrap = isMulti
          ? el('div', { class: 'mg-simon-board glass' }, [el('div', { class: 'mg-field-title' }, ['🏆 Rangliste'])])
          : null;

        var layout = el('div', { class: 'mg-simon-wrap' }, [
          head, statusEl,
          el('div', { class: 'mg-simon-stage' }, [grid]),
          boardWrap
        ]);
        root.innerHTML = ''; root.appendChild(layout);
      }

      function updateHUD() {
        if (levelEl)  levelEl.textContent = String(curLen);
        if (bestEl)   bestEl.textContent = String(bestLevel);
        if (pointsEl) pointsEl.textContent = App.MG.fmt(points);
      }
      function updateTimer(left) {
        if (!timerEl) return;
        timerEl.textContent = '⏱ ' + App.MG.mmss(left);
        timerEl.classList.toggle('urgent', left <= 10);
      }
      function setStatus(txt, kind) {
        if (!statusEl) return;
        statusEl.textContent = txt;
        statusEl.className = 'mg-simon-status' + (kind ? ' ' + kind : '');
      }

      /* ===================== FOLGE VORSPIELEN ===================== */
      function playSequence() {
        if (finished || destroyed) return;
        locked = true; inputPos = 0;
        setStatus('Merken … 👀', 'watch');
        // Mit steigendem Level etwas schneller (mit Untergrenze).
        var lightDur = Math.max(210, 440 - (curLen - 1) * 14);
        var gap = Math.max(95, 210 - (curLen - 1) * 8);
        var i = 0;
        function step() {
          if (finished || destroyed) return;
          if (i >= seq.length) {
            after(gap + 130, function () {
              if (finished || destroyed) return;
              locked = false; setStatus('Nachmachen! 🎯', 'go');
            });
            return;
          }
          lightUp(seq[i], lightDur);
          i++;
          after(lightDur + gap, step);
        }
        after(560, step);
      }

      function lightUp(idx, dur) {
        dur = dur || 300;
        var pad = pads[idx]; if (!pad) return;
        pad.classList.add('lit');
        tone(COLORS[idx].freq, Math.min(0.5, dur / 1000));
        after(dur, function () { if (pad) pad.classList.remove('lit'); });
      }

      function successFlash() {
        pads.forEach(function (p) { p.classList.add('lit'); });
        after(260, function () { pads.forEach(function (p) { if (p) p.classList.remove('lit'); }); });
      }

      /* ===================== EINGABE ===================== */
      function onTap(idx) {
        if (locked || finished || destroyed) return;
        resumeAudio();
        lightUp(idx, 180);
        if (idx === seq[inputPos]) {
          inputPos++;
          if (inputPos >= seq.length) levelComplete();
        } else {
          doError();
        }
      }

      function levelComplete() {
        locked = true;
        bestLevel = Math.max(bestLevel, curLen);
        points += curLen * 10;
        updateHUD();
        safeReport(points);
        setStatus('Richtig! +' + (curLen * 10) + ' ⭐', 'win');
        successFlash();
        // Folge um 1 verlängern -> nächstes Level.
        curLen++;
        seq.push(randColor());
        after(850, function () { updateHUD(); playSequence(); });
      }

      function doError() {
        locked = true;
        errorTone();
        setStatus('Ups! Neue Folge … 🔁', 'lose');
        if (gridEl) gridEl.classList.add('err');
        pads.forEach(function (p) { p.classList.add('wrong'); });
        after(520, function () {
          if (gridEl) gridEl.classList.remove('err');
          pads.forEach(function (p) { if (p) p.classList.remove('wrong'); });
        });
        // Folge neu bei Länge 1 — Punkte & Bestlevel bleiben.
        curLen = 1; seq = [randColor()]; inputPos = 0;
        updateHUD();
        after(980, playSequence);
      }

      /* ===================== ENDE ===================== */
      function finish() {
        if (finished) return; finished = true; locked = true;
        clearAll();
        if (isMulti) {
          safeReport(points);
          after(1300, function () {
            App.MG.endScreen(root, { players: ctx.room.players(), meId: ctx.me.id, onExit: ctx.onExit });
          });
        } else {
          var best = App.Storage.get('best_simon', 0);
          var nb = points > best;
          if (nb) App.Storage.set('best_simon', points);
          App.MG.endScreen(root, {
            score: points, best: best, newBest: nb,
            label: 'Bestlevel ' + bestLevel + (nb ? ' · Neuer Rekord! 🎉' : ' · Bestwert: ' + App.MG.fmt(best)),
            onExit: ctx.onExit,
            onAgain: function () { play(Date.now()); }
          });
        }
      }
    }
  };

  /* ===================== CSS ===================== */
  function injectStyle() {
    UI.injectStyle('mg-simon-css', [
      '.mg-simon-wrap{display:flex;flex-direction:column;gap:14px;max-width:560px;margin:0 auto;}',
      '.mg-simon-head{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:12px 16px;flex-wrap:wrap;}',
      '.mg-simon-stats{display:flex;gap:18px;flex-wrap:wrap;}',
      '.mg-simon-stat{display:flex;flex-direction:column;line-height:1.1;}',
      '.mg-simon-stat-l{font-size:11px;text-transform:uppercase;letter-spacing:1px;color:var(--muted);}',
      '.mg-simon-stat-v{font-size:clamp(20px,5vw,26px);font-weight:900;color:var(--text);}',
      '.mg-simon-stat:nth-child(1) .mg-simon-stat-v{color:var(--aqua);}',
      '.mg-simon-stat:nth-child(2) .mg-simon-stat-v{color:var(--leaf);}',
      '.mg-simon-stat:nth-child(3) .mg-simon-stat-v{color:var(--gold);text-shadow:0 0 12px rgba(255,210,63,.4);}',
      '.mg-simon-head-right{display:flex;align-items:center;gap:10px;}',
      '.mg-simon-timer.urgent{color:var(--danger);animation:mg-simon-pulse .8s infinite;}',
      '.mg-simon-sound{padding:6px 10px;font-size:18px;line-height:1;}',
      '@keyframes mg-simon-pulse{50%{opacity:.45;}}',

      '.mg-simon-status{text-align:center;font-weight:800;font-size:clamp(16px,4.5vw,20px);letter-spacing:.3px;min-height:26px;color:var(--muted);transition:color .15s;}',
      '.mg-simon-status.watch{color:var(--aqua);text-shadow:0 0 12px rgba(51,230,208,.4);}',
      '.mg-simon-status.go{color:var(--neon);text-shadow:0 0 12px rgba(57,255,20,.45);}',
      '.mg-simon-status.win{color:var(--gold);text-shadow:0 0 12px rgba(255,210,63,.5);}',
      '.mg-simon-status.lose{color:var(--danger);text-shadow:0 0 12px rgba(255,77,109,.5);}',

      '.mg-simon-stage{display:flex;justify-content:center;}',
      '.mg-simon-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px;width:100%;max-width:440px;aspect-ratio:1/1;}',
      '.mg-simon-pad{position:relative;border-radius:22px;cursor:pointer;overflow:hidden;',
      'border:2px solid var(--pc);background:linear-gradient(160deg,rgba(0,0,0,.5),rgba(0,0,0,.78));',
      'transition:transform .1s ease,box-shadow .14s ease;-webkit-tap-highlight-color:transparent;',
      'user-select:none;-webkit-user-select:none;touch-action:manipulation;}',
      '.mg-simon-pad::before{content:"";position:absolute;inset:0;background:var(--pc);opacity:.14;transition:opacity .12s ease;}',
      '.mg-simon-pad:active{transform:scale(.97);}',
      '.mg-simon-pad:active::before{opacity:.55;}',
      '.mg-simon-pad.lit{transform:scale(.965);box-shadow:0 0 26px var(--pc),0 0 60px var(--pc),inset 0 0 40px rgba(255,255,255,.28);}',
      '.mg-simon-pad.lit::before{opacity:.92;}',
      '.mg-simon-pad.c0{--pc:#39ff14;}',
      '.mg-simon-pad.c1{--pc:#33e6d0;}',
      '.mg-simon-pad.c2{--pc:#ffd23f;}',
      '.mg-simon-pad.c3{--pc:#ff4d6d;}',
      '.mg-simon-pad.wrong{border-color:var(--danger);box-shadow:0 0 24px rgba(255,77,109,.6),inset 0 0 30px rgba(255,77,109,.35);}',
      '.mg-simon-grid.err{animation:mg-simon-shake .5s ease;}',
      '@keyframes mg-simon-shake{0%,100%{transform:translateX(0)}18%{transform:translateX(-10px)}38%{transform:translateX(9px)}58%{transform:translateX(-6px)}78%{transform:translateX(4px)}}',

      '.mg-simon-board{padding:12px 14px;display:flex;flex-direction:column;gap:8px;}',
      '.mg-simon-board .mg-scoreboard{max-height:230px;overflow-y:auto;}'
    ].join(''));
  }
})();
