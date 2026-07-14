/* reflex.js — "Reflex-Blitz": Reaktions-Wettbewerb im Neon-Dschungel.
 * Eine große Fläche ist rot ("Warte auf GRÜN …"). Nach 1–3 s wird sie
 * leuchtend grün — dann so schnell wie möglich klicken/tippen. Punkte =
 * max(0, 500 − Reaktionszeit_ms). Klick vor Grün = Fehlstart (0 Punkte).
 * Nach jedem Versuch sofort die nächste Runde → in 30 s viele Reaktionen.
 * Singleplayer (mit Bestwert) + Multiplayer (Live-Rangliste, Podest).
 * Reaktionsmessung lokal über performance.now(); Rundentimer/Countdown
 * über Wall-Clock (App.MG, im Multi mit room.now) → Tab-Wechsel-sicher. */
(function () {
  'use strict';
  window.App = window.App || {}; App.Minigames = App.Minigames || {};
  var UI = App.UI, el = UI.el;

  injectStyle();

  App.Minigames.reflex = {
    id: 'reflex', title: 'Reflex-Blitz', icon: '⚡', order: 2,
    subtitle: 'Klick sofort bei Grün – teste deine Reaktion',
    single: true, multi: true, minPlayers: 2, maxPlayers: 8,

    render: function (root, ctx) {
      var isMulti = ctx.mode === 'multi';
      var DURATION = 30;                                  // s Rundenzeit
      var nowFn = isMulti ? ctx.room.now : function () { return Date.now(); };
      var perf = (window.performance && performance.now)
        ? function () { return performance.now(); }
        : function () { return Date.now(); };

      var dead = false;
      var stops = [];       // stop()-Funktionen der App.MG-Bausteine + Listener
      var pending = [];      // laufende setTimeout-IDs

      /* Zustand (wird in play() für jede Runde frisch gesetzt) */
      var score = 0, hits = 0, bestReact = Infinity;
      var state = 'idle', goAt = 0, roundId = 0, finished = false;

      /* DOM-Referenzen der laufenden Ansicht */
      var field, fIcon, fMsg, fSub, reactEl, scoreEl, timerEl, bestEl, hitsEl;

      function after(ms, fn) { var t = setTimeout(function () { if (!dead) fn(); }, ms); pending.push(t); return t; }
      function clearPending() { pending.forEach(clearTimeout); pending = []; }
      function stopHelpers() { stops.forEach(function (f) { try { f(); } catch (e) {} }); stops = []; }
      function cleanup() { dead = true; clearPending(); stopHelpers(); }

      /* ---- Start ---- */
      if (isMulti) {
        var snap = ctx.room.snapshot() || {};
        var startAt = (snap.round && snap.round.startAt) || (ctx.room.now() + 3000);
        stops.push(App.MG.countdown(root, startAt, function () { play(startAt); }, ctx.room.now));
      } else {
        play(nowFn());
      }
      return { cleanup: cleanup };

      /* ===================== SPIEL ===================== */
      function play(startAt) {
        clearPending(); stopHelpers();
        score = 0; hits = 0; bestReact = Infinity;
        state = 'idle'; goAt = 0; roundId = 0; finished = false;
        var endAt = startAt + DURATION * 1000;

        /* --- Kopf: Reaktion / Punkte / Timer --- */
        reactEl = el('div', { class: 'rx-react' }, ['– ms']);
        scoreEl = el('div', { class: 'rx-score' }, ['0']);
        timerEl = el('div', { class: 'mg-timer' }, ['']);
        var head = el('div', { class: 'rx-head glass' }, [
          el('div', { class: 'rx-head-cell' }, [el('span', { class: 'rx-head-l' }, ['Reaktion']), reactEl]),
          el('div', { class: 'rx-head-cell rx-head-mid' }, [el('span', { class: 'rx-head-l' }, ['Punkte']), scoreEl]),
          el('div', { class: 'rx-head-cell rx-head-timer' }, [el('span', { class: 'rx-head-l' }, ['Zeit']), timerEl])
        ]);

        /* --- Große Umschalt-Fläche --- */
        fIcon = el('div', { class: 'rx-icon' }, ['✋']);
        fMsg = el('div', { class: 'rx-msg' }, ['Warte auf GRÜN …']);
        fSub = el('div', { class: 'rx-sub' }, ['Nicht klicken!']);
        field = el('button', { class: 'rx-field rx-wait', type: 'button', 'aria-label': 'Reaktionsfläche' }, [fIcon, fMsg, fSub]);

        /* --- Stat-Zeile --- */
        bestEl = el('div', { class: 'rx-stat-v' }, ['–']);
        hitsEl = el('div', { class: 'rx-stat-v' }, ['0']);
        var stats = el('div', { class: 'rx-stats glass' }, [
          el('div', { class: 'rx-stat' }, [el('div', { class: 'rx-stat-l' }, ['⚡ Beste']), bestEl]),
          el('div', { class: 'rx-stat' }, [el('div', { class: 'rx-stat-l' }, ['🎯 Treffer']), hitsEl])
        ]);

        /* --- Live-Rangliste (multi) --- */
        var board = isMulti ? App.MG.liveBoard(ctx.room, ctx.me.id) : null;
        if (board) stops.push(board.stop);
        var boardWrap = board ? el('div', { class: 'rx-board-wrap glass' }, [
          el('div', { class: 'mg-field-title' }, ['🏆 Rangliste']), board.root
        ]) : null;

        var layout = el('div', { class: 'rx-layout' }, [head, field, stats, boardWrap]);
        root.innerHTML = ''; root.appendChild(layout);

        /* --- Eingabe: pointerdown = schnellster Weg (Maus + Touch) --- */
        field.addEventListener('pointerdown', onPress);
        function keyHandler(e) { if (e.code === 'Space' || e.key === ' ' || e.key === 'Enter') { e.preventDefault(); onPress(e); } }
        document.addEventListener('keydown', keyHandler);
        stops.push(function () { document.removeEventListener('keydown', keyHandler); });

        function onPress(e) {
          if (e && e.preventDefault) e.preventDefault();
          if (dead || finished || nowFn() >= endAt) return;

          if (state === 'go') {
            var rt = Math.round(perf() - goAt);
            if (rt < 0) rt = 0;
            var pts = Math.max(0, 500 - rt);
            score += pts; hits++;
            if (rt < bestReact) bestReact = rt;
            reactEl.textContent = rt + ' ms';
            reactEl.classList.remove('rx-bump'); void reactEl.offsetWidth; reactEl.classList.add('rx-bump');
            scoreEl.textContent = App.MG.fmt(score);
            updateStats();
            if (isMulti) ctx.room.reportScore(score);
            state = 'pause';
            if (App.Audio) App.Audio.sfx('point');
            setField('hit', rt < 150 ? '🚀' : '✅', rt + ' ms', '+' + pts + ' Punkte');
            after(650, nextRound);
          } else if (state === 'wait') {
            /* Fehlstart */
            state = 'pause';
            if (App.Audio) App.Audio.sfx('error');
            setField('early', '🚫', 'Zu früh!', '0 Punkte – warte auf Grün');
            after(950, nextRound);
          }
          /* state 'pause'/'idle'/'over' → ignorieren */
        }

        /* --- Rundenlogik --- */
        function nextRound() {
          if (dead || finished || nowFn() >= endAt) return;
          roundId++;
          var myRound = roundId;
          state = 'wait';
          setField('wait', '✋', 'Warte auf GRÜN …', 'Nicht klicken!');
          var wait = 1000 + Math.random() * 2000;         // 1–3 s
          after(wait, function () {
            if (dead || finished || myRound !== roundId || state !== 'wait') return;
            if (nowFn() >= endAt) return;
            state = 'go';
            goAt = perf();
            if (App.Audio) App.Audio.sfx('start');
            setField('go', '⚡', 'JETZT!', 'Klick sofort!');
          });
        }

        function updateStats() {
          bestEl.textContent = (bestReact === Infinity ? '–' : bestReact + ' ms');
          hitsEl.textContent = String(hits);
        }

        /* --- Rundentimer (Wall-Clock, Tab-sicher) --- */
        var tnf = isMulti ? ctx.room.now : null;
        stops.push(App.MG.roundTimer(endAt, function (left) {
          timerEl.textContent = App.MG.mmss(left);
          if (left <= 5) timerEl.classList.add('rx-urgent');
        }, finish, tnf));

        if (isMulti) ctx.room.reportScore(0);
        nextRound();
      }

      function setField(cls, icon, msg, sub) {
        if (!field) return;
        field.className = 'rx-field rx-' + cls;
        fIcon.textContent = icon;
        fMsg.textContent = msg;
        fSub.textContent = sub;
      }

      /* ===================== ENDE ===================== */
      function finish() {
        if (finished || dead) return;
        finished = true;
        state = 'over';
        clearPending();
        stopHelpers();
        setField('over', '🏁', 'Zeit um!', App.MG.fmt(score) + ' Punkte');

        if (isMulti) {
          ctx.room.reportScore(score);
          after(1200, function () {
            App.MG.endScreen(root, { players: ctx.room.players(), meId: ctx.me.id, onExit: ctx.onExit });
          });
        } else {
          var best = App.Storage.get('best_reflex', 0);
          var nb = score > best;
          if (nb) App.Storage.set('best_reflex', score);
          App.MG.endScreen(root, {
            score: score, best: best, newBest: nb,
            label: 'Reaktions-Punkte' + (nb ? ' · neuer Rekord! 🎉' : ' · Bestwert: ' + App.MG.fmt(best)),
            onExit: ctx.onExit,
            onAgain: function () { finished = false; play(nowFn()); }
          });
        }
      }
    }
  };

  /* ===================== STYLES ===================== */
  function injectStyle() {
    UI.injectStyle('mg-reflex-css', [
      '.rx-layout{display:flex;flex-direction:column;gap:14px;}',
      '.rx-head{display:flex;justify-content:space-between;align-items:center;padding:12px 18px;gap:12px;flex-wrap:wrap;}',
      '.rx-head-cell{display:flex;flex-direction:column;gap:2px;min-width:0;}',
      '.rx-head-mid{text-align:center;}',
      '.rx-head-timer{text-align:right;}',
      '.rx-head-l{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:1px;}',
      '.rx-react{font-size:clamp(24px,6vw,40px);line-height:1;color:var(--aqua);text-shadow:0 0 14px rgba(51,230,208,.5);font-variant-numeric:tabular-nums;font-weight:900;}',
      '.rx-score{font-size:clamp(24px,6vw,40px);font-weight:900;color:var(--gold);text-shadow:0 0 12px rgba(255,210,63,.45);line-height:1;font-variant-numeric:tabular-nums;}',
      '.rx-head .mg-timer{font-size:clamp(18px,5vw,26px);}',
      '.mg-timer.rx-urgent{color:var(--danger-2);animation:rx-pulse .7s infinite;}',
      '.rx-bump{animation:rx-bump .3s ease;}',
      /* Umschalt-Fläche */
      '.rx-field{position:relative;width:100%;min-height:clamp(220px,44vh,430px);border-radius:24px;',
      'border:2px solid var(--stroke);cursor:pointer;display:flex;flex-direction:column;align-items:center;',
      'justify-content:center;gap:10px;padding:20px;text-align:center;font-family:inherit;color:#fff;',
      'user-select:none;-webkit-user-select:none;-webkit-tap-highlight-color:transparent;touch-action:manipulation;',
      'overflow:hidden;transition:background .09s ease,border-color .12s,box-shadow .12s;}',
      '.rx-field:active{transform:scale(.994);}',
      '.rx-icon{font-size:clamp(48px,13vw,90px);line-height:1;filter:drop-shadow(0 6px 16px rgba(0,0,0,.4));}',
      '.rx-msg{font-size:clamp(26px,7vw,50px);font-weight:900;letter-spacing:1px;line-height:1.05;}',
      '.rx-sub{font-size:clamp(13px,3.2vw,19px);font-weight:700;opacity:.92;}',
      /* Zustände */
      '.rx-wait{background:radial-gradient(circle at 50% 34%,#7a1024,#2a0510 78%);border-color:rgba(255,77,109,.5);box-shadow:inset 0 0 70px rgba(255,77,109,.16);}',
      '.rx-wait .rx-msg{color:#ffd9df;text-shadow:0 0 18px rgba(255,77,109,.5);}',
      '.rx-wait .rx-sub{color:#ff9fb0;}',
      '.rx-go{background:radial-gradient(circle at 50% 34%,#7dff5e,var(--neon) 72%);border-color:#eaffe2;',
      'box-shadow:0 0 55px rgba(57,255,20,.65),inset 0 0 70px rgba(255,255,255,.28);color:#04160c;animation:rx-flashgo .16s ease;}',
      '.rx-go .rx-msg{color:#04160c;text-shadow:0 2px 12px rgba(255,255,255,.45);}',
      '.rx-go .rx-sub{color:#0a2a12;}',
      '.rx-hit{background:radial-gradient(circle at 50% 34%,#123f26,#04160c 78%);border-color:var(--stroke-2);',
      'box-shadow:0 0 34px rgba(57,255,20,.35),inset 0 0 55px rgba(57,255,20,.12);}',
      '.rx-hit .rx-msg{color:var(--neon);text-shadow:0 0 18px rgba(57,255,20,.6);}',
      '.rx-hit .rx-sub{color:var(--leaf);}',
      '.rx-early{background:radial-gradient(circle at 50% 34%,#b3122f,#3a0512 78%);border-color:var(--danger);',
      'box-shadow:0 0 34px rgba(255,77,109,.5),inset 0 0 55px rgba(255,77,109,.2);animation:rx-shake .3s ease;}',
      '.rx-early .rx-msg{color:#fff;text-shadow:0 0 16px rgba(255,77,109,.6);}',
      '.rx-early .rx-sub{color:#ffc2cd;}',
      '.rx-over{background:radial-gradient(circle at 50% 34%,#0b3a52,#04121a 78%);border-color:var(--stroke-2);cursor:default;}',
      '.rx-over .rx-msg{color:var(--aqua-soft);}',
      /* Stats */
      '.rx-stats{display:flex;gap:12px;padding:12px 16px;justify-content:space-around;}',
      '.rx-stat{display:flex;flex-direction:column;align-items:center;gap:2px;}',
      '.rx-stat-l{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;}',
      '.rx-stat-v{font-size:clamp(18px,4.5vw,24px);font-weight:900;color:var(--leaf);font-variant-numeric:tabular-nums;}',
      '.rx-board-wrap{padding:14px;display:flex;flex-direction:column;gap:8px;}',
      '.rx-board-wrap .mg-scoreboard{max-height:300px;overflow-y:auto;}',
      /* Animationen */
      '@keyframes rx-flashgo{0%{filter:brightness(1.7)}100%{filter:brightness(1)}}',
      '@keyframes rx-shake{0%,100%{transform:translateX(0)}20%{transform:translateX(-9px)}60%{transform:translateX(9px)}}',
      '@keyframes rx-pulse{0%,100%{opacity:1}50%{opacity:.4}}',
      '@keyframes rx-bump{0%{transform:scale(1)}40%{transform:scale(1.2)}100%{transform:scale(1)}}'
    ].join(''));
  }
})();
