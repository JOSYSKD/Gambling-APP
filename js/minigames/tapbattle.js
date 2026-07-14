/* tapbattle.js — "Tap-Battle": So schnell wie möglich tippen (15 Sekunden).
 * Ein RIESIGER Neon-Button in der Mitte, jeder Tap/Klick = +1. Score = Taps.
 * Parallel-Wettbewerb: alle tippen gleichzeitig, wer am meisten schafft, gewinnt.
 * Singleplayer (Bestwert 'best_tapbattle') + Multiplayer (Live-Rangliste, Podest).
 * Touch-optimiert (pointerdown, touch-action:manipulation, kein Doppel-Tap-Zoom),
 * Timer/Countdown über Wall-Clock (App.MG) -> Tab-Wechsel-sicher & synchron. */
(function () {
  'use strict';
  window.App = window.App || {}; App.Minigames = App.Minigames || {};
  var UI = App.UI, el = UI.el;

  var DURATION = 15;               // s Rundenzeit (fest)
  var TEMPO_WIN = 1200;            // ms Fenster für den gleitenden Tempo-Schnitt

  injectStyle();

  App.Minigames.tapbattle = {
    id: 'tapbattle', title: 'Tap-Battle', icon: '👆', order: 3,
    subtitle: 'So schnell wie möglich tippen – 15 Sekunden',
    single: true, multi: true, minPlayers: 2, maxPlayers: 8,

    render: function (root, ctx) {
      var isMulti = ctx.mode === 'multi';
      var destroyed = false;
      var stops = [];               // Aufräum-Funktionen (Timer/Listener/Board)
      var raf = null;               // Animations-Loop
      var floaters = [];            // schwebende +1-Partikel (im <body>)

      function addStop(fn) { if (fn) stops.push(fn); }
      function clearAll() {
        stops.forEach(function (f) { try { f(); } catch (e) {} });
        stops = [];
        if (raf) { cancelAnimationFrame(raf); raf = null; }
      }
      function killFloaters() {
        floaters.forEach(function (n) { if (n && n.parentNode) n.parentNode.removeChild(n); });
        floaters = [];
      }
      function cleanup() { destroyed = true; clearAll(); killFloaters(); }

      /* Start: Multiplayer wartet auf synchronen Countdown, Single legt sofort los. */
      if (isMulti) {
        var snap = ctx.room.snapshot() || {};
        var startAt = (snap.round && snap.round.startAt) || (ctx.room.now() + 3000);
        addStop(App.MG.countdown(root, startAt, function () { play(startAt); }, ctx.room.now));
      } else {
        play(Date.now());
      }
      return { cleanup: cleanup };

      /* ===================== RUNDE ===================== */
      function play(startAt) {
        clearAll();                       // evtl. Countdown-Timer stoppen
        var nowFn = isMulti ? ctx.room.now : Date.now;
        var endAt = startAt + DURATION * 1000;
        var score = 0, punch = 0, finished = false;
        var tapTimes = [];                // Zeitstempel für den Tempo-Schnitt

        /* ---- UI ---- */
        var timerEl = el('div', { class: 'tb-timer' }, ['⏱ ' + App.MG.mmss(DURATION)]);
        var tempoNum = el('span', { class: 'tb-tempo-num' }, ['0.0']);
        var tempoFill = el('div', { class: 'tb-tempo-fill' });
        var tempoBox = el('div', { class: 'tb-tempo' }, [
          el('div', { class: 'tb-tempo-head' }, [
            el('span', { class: 'tb-tempo-lbl' }, ['⚡ Tempo']),
            el('span', {}, [tempoNum, el('span', { class: 'tb-tempo-unit' }, [' Taps/s'])])
          ]),
          el('div', { class: 'tb-tempo-track' }, [tempoFill])
        ]);
        var hud = el('div', { class: 'tb-hud glass' }, [timerEl, tempoBox]);

        var iconEl = el('div', { class: 'tb-ico' }, ['👆']);
        var countEl = el('div', { class: 'tb-count' }, ['0']);
        var labelEl = el('div', { class: 'tb-label' }, ['TIPPEN!']);
        var tapBtn = el('button', {
          class: 'tb-btn', type: 'button', 'aria-label': 'Tippen für Punkte'
        }, [iconEl, countEl, labelEl]);
        var stage = el('div', { class: 'tb-stage' }, [tapBtn]);

        var side = null;
        if (isMulti) {
          side = el('div', { class: 'tb-side glass' }, [el('div', { class: 'mg-field-title' }, ['🏆 Rangliste'])]);
        }

        var layout = el('div', { class: 'tb-play' + (isMulti ? ' has-board' : '') }, [
          hud, stage, side
        ]);
        root.innerHTML = ''; root.appendChild(layout);

        /* ---- Live-Rangliste (multi) ---- */
        if (isMulti) {
          var board = App.MG.liveBoard(ctx.room, ctx.me.id);
          side.appendChild(board.root);
          addStop(board.stop);
        }

        /* ---- Tap-Logik ---- */
        function registerTap(clientX, clientY) {
          if (finished || destroyed) return;
          if (nowFn() < startAt || nowFn() >= endAt) return;
          score++;
          countEl.textContent = String(score);
          punch = Math.min(1.6, punch + 0.9);
          tapTimes.push(Date.now());
          if (App.Audio) App.Audio.blip(760, 0.025, { type: 'triangle', peak: 0.03 });
          spawnPlus(clientX, clientY);
        }

        function onPointer(e) {
          e.preventDefault();
          registerTap(e.clientX, e.clientY);
        }
        if ('PointerEvent' in window) {
          tapBtn.addEventListener('pointerdown', onPointer);
          addStop(function () { tapBtn.removeEventListener('pointerdown', onPointer); });
        } else {
          var onTouch = function (e) {
            e.preventDefault();
            var t = e.changedTouches && e.changedTouches[0];
            registerTap(t ? t.clientX : 0, t ? t.clientY : 0);
          };
          var onMouse = function (e) { e.preventDefault(); registerTap(e.clientX, e.clientY); };
          tapBtn.addEventListener('touchstart', onTouch, { passive: false });
          tapBtn.addEventListener('mousedown', onMouse);
          addStop(function () {
            tapBtn.removeEventListener('touchstart', onTouch);
            tapBtn.removeEventListener('mousedown', onMouse);
          });
        }
        /* Tastatur (Desktop): Leertaste/Enter zählt – aber kein Auto-Repeat beim Halten. */
        function onKey(e) {
          if (e.repeat) return;
          if (e.code === 'Space' || e.key === ' ' || e.key === 'Enter') {
            e.preventDefault();
            var r = tapBtn.getBoundingClientRect();
            registerTap(r.left + r.width / 2, r.top + r.height / 2);
            punch = Math.min(1.6, punch + 0.3);
          }
        }
        document.addEventListener('keydown', onKey);
        addStop(function () { document.removeEventListener('keydown', onKey); });

        /* ---- Tempo-Anzeige (gleitender Schnitt, decayt bei Nichtstun) ---- */
        var tempoIv = setInterval(function () {
          var cut = Date.now() - TEMPO_WIN;
          while (tapTimes.length && tapTimes[0] < cut) tapTimes.shift();
          var tps = tapTimes.length / (TEMPO_WIN / 1000);
          tempoNum.textContent = tps.toFixed(1);
          tempoFill.style.width = Math.min(100, tps * 8.5) + '%';
          tapBtn.classList.toggle('tb-hot', tps >= 5);
          tapBtn.classList.toggle('tb-fire', tps >= 8);
        }, 110);
        addStop(function () { clearInterval(tempoIv); });

        /* ---- Score melden (multi, ~alle 300ms) ---- */
        if (isMulti) {
          var lastRep = -1;
          var repIv = setInterval(function () {
            if (score !== lastRep) { lastRep = score; ctx.room.reportScore(score); }
          }, 300);
          addStop(function () { clearInterval(repIv); });
        }

        /* ---- Animations-Loop (Button-Puls) ---- */
        function frame() {
          if (destroyed || finished) { raf = null; return; }
          punch *= 0.80;
          if (punch < 0.002) punch = 0;
          tapBtn.style.transform = 'scale(' + (1 + punch * 0.09).toFixed(3) + ')';
          raf = requestAnimationFrame(frame);
        }
        raf = requestAnimationFrame(frame);

        /* ---- Timer (Wall-Clock, im Multi synchron) ---- */
        addStop(App.MG.roundTimer(endAt, function (left) {
          var secs = Math.ceil(left);
          timerEl.textContent = '⏱ ' + App.MG.mmss(secs);
          if (secs <= 5) timerEl.classList.add('tb-urgent');
        }, finish, isMulti ? ctx.room.now : null));

        /* ---- Ende ---- */
        function finish() {
          if (finished) return; finished = true;
          clearAll();                     // rAF, Timer, Intervalle, Listener, Board
          tapBtn.style.transform = '';
          tapBtn.classList.remove('tb-hot', 'tb-fire');
          tapBtn.classList.add('tb-done');
          if (isMulti) {
            ctx.room.reportScore(score);
            var to = setTimeout(function () {
              if (destroyed) return;
              App.MG.endScreen(root, {
                players: ctx.room.players(), meId: ctx.me.id, onExit: ctx.onExit
              });
            }, 1200);
            addStop(function () { clearTimeout(to); });
          } else {
            var best = App.Storage.get('best_tapbattle', 0);
            var nb = score > best;
            if (nb) App.Storage.set('best_tapbattle', score);
            App.MG.endScreen(root, {
              title: 'Zeit um! ⏱',
              score: score, best: best, newBest: nb,
              label: nb ? 'Neuer Rekord! 🎉' : ('Bestwert: ' + best + ' Taps'),
              onExit: ctx.onExit,
              onAgain: function () { play(Date.now()); }
            });
          }
        }

        /* ---- schwebende +1-Partikel ---- */
        function spawnPlus(x, y) {
          if (floaters.length > 20) return;
          if (!x && !y) { var r = tapBtn.getBoundingClientRect(); x = r.left + r.width / 2; y = r.top + r.height * 0.35; }
          var p = el('div', { class: 'tb-plus' }, ['+1']);
          p.style.left = x + 'px';
          p.style.top = y + 'px';
          p.style.setProperty('--dx', (Math.random() * 54 - 27).toFixed(0) + 'px');
          document.body.appendChild(p);
          floaters.push(p);
          requestAnimationFrame(function () { p.classList.add('go'); });
          setTimeout(function () {
            var i = floaters.indexOf(p); if (i >= 0) floaters.splice(i, 1);
            if (p.parentNode) p.parentNode.removeChild(p);
          }, 720);
        }
      }
    }
  };

  /* ============================ STYLES ============================ */
  function injectStyle() {
    UI.injectStyle('mg-tapbattle-css', [
      '.tb-play{display:flex;flex-direction:column;gap:16px;align-items:stretch;}',
      '@media(min-width:780px){.tb-play.has-board{display:grid;grid-template-columns:1fr 260px;grid-template-areas:"hud hud" "stage side";align-items:start;}',
      '.tb-play.has-board .tb-hud{grid-area:hud;}.tb-play.has-board .tb-stage{grid-area:stage;}.tb-play.has-board .tb-side{grid-area:side;}}',
      /* HUD */
      '.tb-hud{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:14px 20px;flex-wrap:wrap;}',
      '.tb-timer{font-size:clamp(30px,9vw,54px);font-weight:900;line-height:1;color:var(--aqua-soft);text-shadow:0 0 16px rgba(51,230,208,.45);font-variant-numeric:tabular-nums;}',
      '.tb-timer.tb-urgent{color:var(--danger);text-shadow:0 0 18px rgba(255,77,109,.6);animation:tb-blink .5s steps(2,end) infinite;}',
      '@keyframes tb-blink{50%{opacity:.45;}}',
      '.tb-tempo{min-width:150px;flex:1;max-width:260px;display:flex;flex-direction:column;gap:6px;}',
      '.tb-tempo-head{display:flex;justify-content:space-between;align-items:baseline;font-size:13px;}',
      '.tb-tempo-lbl{color:var(--muted);font-weight:800;text-transform:uppercase;letter-spacing:1px;font-size:11px;}',
      '.tb-tempo-num{font-weight:900;color:var(--neon);font-size:18px;font-variant-numeric:tabular-nums;}',
      '.tb-tempo-unit{color:var(--muted);font-size:11px;font-weight:700;}',
      '.tb-tempo-track{height:9px;border-radius:999px;background:rgba(4,16,10,.8);border:1px solid var(--stroke);overflow:hidden;}',
      '.tb-tempo-fill{height:100%;width:0;border-radius:999px;background:linear-gradient(90deg,var(--aqua),var(--neon));box-shadow:0 0 10px rgba(57,255,20,.5);transition:width .12s ease;}',
      /* Bühne + Button */
      '.tb-stage{display:flex;align-items:center;justify-content:center;padding:8px 0 4px;}',
      '.tb-btn{position:relative;width:min(84vw,420px);aspect-ratio:1/1;max-height:52vh;border-radius:50%;',
      'border:3px solid var(--neon);color:var(--text);cursor:pointer;font-family:inherit;',
      'display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;',
      'background:radial-gradient(circle at 50% 38%,rgba(57,255,20,.34),rgba(9,32,21,.92) 68%);',
      'box-shadow:0 0 44px rgba(57,255,20,.32),inset 0 0 46px rgba(57,255,20,.14);',
      'touch-action:manipulation;user-select:none;-webkit-user-select:none;-webkit-tap-highlight-color:transparent;',
      'will-change:transform;animation:tb-breath 1.9s ease-in-out infinite;}',
      '@keyframes tb-breath{0%,100%{box-shadow:0 0 40px rgba(57,255,20,.28),inset 0 0 44px rgba(57,255,20,.12);}50%{box-shadow:0 0 62px rgba(57,255,20,.5),inset 0 0 56px rgba(57,255,20,.22);}}',
      '.tb-btn.tb-hot{border-color:var(--gold);background:radial-gradient(circle at 50% 38%,rgba(255,210,63,.34),rgba(9,32,21,.92) 68%);}',
      '.tb-btn.tb-hot .tb-count{color:var(--gold);text-shadow:0 0 22px rgba(255,210,63,.6);}',
      '.tb-btn.tb-fire{border-color:var(--danger);animation-duration:.9s;}',
      '.tb-btn.tb-fire .tb-count{color:#fff;text-shadow:0 0 24px rgba(255,77,109,.75);}',
      '.tb-btn.tb-done{animation:none;filter:saturate(.7) brightness(.9);cursor:default;}',
      '.tb-ico{font-size:clamp(30px,8vw,46px);line-height:1;filter:drop-shadow(0 4px 10px rgba(0,0,0,.4));}',
      '.tb-count{font-size:clamp(56px,17vw,104px);font-weight:900;line-height:.95;color:var(--leaf);text-shadow:0 0 22px rgba(57,255,20,.55);font-variant-numeric:tabular-nums;}',
      '.tb-label{font-size:clamp(13px,3.6vw,17px);font-weight:900;letter-spacing:3px;color:var(--muted);text-transform:uppercase;}',
      /* Seiten-Board */
      '.tb-side{padding:14px;display:flex;flex-direction:column;gap:10px;}',
      /* schwebende +1 */
      '.tb-plus{position:fixed;pointer-events:none;z-index:90;font-weight:900;font-size:26px;color:var(--neon);',
      'text-shadow:0 2px 10px rgba(0,0,0,.65);transform:translate(-50%,-50%);transition:transform .7s cubic-bezier(.2,.7,.3,1),opacity .7s ease-out;opacity:1;}',
      '.tb-plus.go{transform:translate(calc(-50% + var(--dx,0px)),-92px) scale(1.15);opacity:0;}'
    ].join(''));
  }
})();
