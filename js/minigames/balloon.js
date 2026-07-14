/* balloon.js — "Ballon-Risiko": Pump-Risiko-Spiel (Risk/Reward).
 * Pumpe den Ballon: jeder Pump erhöht deinen aktuellen Einsatz — aber auch die
 * Platz-Wahrscheinlichkeit. Sammle jederzeit ein (Cash-out), dann ist der
 * Einsatz sicher und ein frischer Ballon startet. Platzt der Ballon, ist der
 * aktuelle Einsatz weg (das gesicherte Guthaben bleibt). Ziel: in 60 Sekunden
 * so viel gesichertes Guthaben wie möglich. Singleplayer (mit Bestwert) +
 * Multiplayer (synchroner Start, Live-Rangliste, Podest).
 * Alle Zeit läuft über Wall-Clock (Date.now / room.now) -> Tab-sicher. */
(function () {
  'use strict';
  window.App = window.App || {}; App.Minigames = App.Minigames || {};
  var UI = App.UI, el = UI.el, MG = App.MG;

  var DURATION = 60;          // Sekunden Rundenzeit
  var POP_BASE = 0.02;        // Platz-Chance beim 1. Pump (~2%)
  var POP_STEP = 0.025;       // + pro weiterem Pump (~2.5 Prozentpunkte)
  var POP_CAP  = 0.85;        // Deckel, damit es nie 100% sicher-tödlich wird

  App.Minigames.balloon = {
    id: 'balloon', title: 'Ballon-Risiko', icon: '🎈', order: 13,
    subtitle: 'Pump für mehr Punkte — aber nicht platzen lassen!',
    single: true, multi: true, minPlayers: 2, maxPlayers: 8,

    render: function (root, ctx) {
      injectStyle();
      var isMulti = ctx.mode === 'multi';
      var clock = isMulti ? ctx.room.now : Date.now;

      /* ---- Aufräum-Register (alles muss in cleanup weg) ---- */
      var tos = [], stops = [], dead = false, finished = false, keyHandler = null;
      function after(ms, fn) { var t = setTimeout(fn, ms); tos.push(t); return t; }
      function clearRound() {
        tos.forEach(clearTimeout); tos = [];
        stops.forEach(function (f) { try { f(); } catch (e) {} }); stops = [];
        if (keyHandler) { document.removeEventListener('keydown', keyHandler); keyHandler = null; }
      }
      function cleanup() { dead = true; clearRound(); }

      /* ---- Runden-Zustand ---- */
      var total = 0, stake = 0, pumps = 0;
      /* ---- DOM-Referenzen (in play() gesetzt) ---- */
      var stageEl, balloonWrap, balloonEl, stakeNumEl, totalEl, stakeEl, timerEl,
          pumpBtn, cashBtn, pumpCountEl;

      /* ---- Start ---- */
      if (isMulti) {
        var snap = ctx.room.snapshot() || {};
        var startAt = (snap.round && snap.round.startAt) || (ctx.room.now() + 3000);
        stops.push(MG.countdown(root, startAt, function () { play(startAt); }, ctx.room.now));
      } else {
        play(Date.now());
      }
      return { cleanup: cleanup };

      /* ===================== SPIEL ===================== */
      function play(startAt) {
        clearRound();
        total = 0; stake = 0; pumps = 0; finished = false;
        var endAt = startAt + DURATION * 1000;

        /* --- Kopf: Gesichert + Einsatz + Timer --- */
        totalEl = el('div', { class: 'bl-total big-readout' }, ['0']);
        stakeEl = el('div', { class: 'bl-stake-val' }, ['0']);
        timerEl = el('div', { class: 'mg-timer bl-timer' }, [MG.mmss(DURATION)]);
        var head = el('div', { class: 'bl-head glass' }, [
          el('div', { class: 'bl-head-cell' }, [el('span', { class: 'bl-head-l' }, ['💰 Gesichert']), totalEl]),
          el('div', { class: 'bl-head-cell bl-head-center' }, [el('span', { class: 'bl-head-l' }, ['Im Ballon']), stakeEl]),
          el('div', { class: 'bl-head-cell bl-head-right' }, [el('span', { class: 'bl-head-l' }, ['Zeit']), timerEl])
        ]);

        /* --- Ballon-Bühne --- */
        stakeNumEl = el('div', { class: 'bl-stake-num' }, ['']);
        balloonEl = el('div', { class: 'bl-balloon' }, [el('div', { class: 'bl-shine' }), stakeNumEl]);
        balloonWrap = el('div', { class: 'bl-balloon-wrap' }, [balloonEl, el('div', { class: 'bl-string' })]);
        pumpCountEl = el('div', { class: 'bl-pumps hint-text' }, ['0 Pumps']);
        stageEl = el('div', { class: 'bl-stage game-stage' }, [balloonWrap, pumpCountEl]);

        /* --- Steuerung --- */
        pumpBtn = el('button', { class: 'btn btn-primary btn-lg bl-pump', type: 'button' }, ['🎈 PUMPEN']);
        cashBtn = el('button', { class: 'btn btn-aqua btn-lg bl-cash', type: 'button' }, ['💰 EINSAMMELN']);
        var controls = el('div', { class: 'bl-controls-wrap glass' }, [
          el('div', { class: 'controls-row bl-controls' }, [pumpBtn, cashBtn]),
          el('div', { class: 'hint-text bl-keyhint' }, ['Leertaste = Pumpen · Enter = Einsammeln'])
        ]);

        var pieces = [head, stageEl, controls];

        /* --- Live-Rangliste (multi) --- */
        var board = null;
        if (isMulti) {
          board = MG.liveBoard(ctx.room, ctx.me.id);
          stops.push(board.stop);
          pieces.push(el('div', { class: 'glass bl-board-wrap' }, [
            el('div', { class: 'mg-field-title' }, ['🏆 Rangliste']),
            board.root
          ]));
          ctx.room.reportScore(0);
        }

        var layout = el('div', { class: 'bl-layout' }, pieces);
        root.innerHTML = ''; root.appendChild(layout);

        /* --- Aktionen --- */
        pumpBtn.addEventListener('click', function () { doPump(); });
        cashBtn.addEventListener('click', function () { doCash(); });

        keyHandler = function (e) {
          if (dead || finished) return;
          if (e.code === 'Space' || e.key === ' ' || e.key === 'Spacebar') { e.preventDefault(); doPump(); }
          else if (e.code === 'Enter' || e.key === 'Enter') { e.preventDefault(); doCash(); }
        };
        document.addEventListener('keydown', keyHandler);

        /* --- Timer --- */
        stops.push(MG.roundTimer(endAt, function (left) {
          timerEl.textContent = MG.mmss(Math.ceil(left));
          timerEl.classList.toggle('bl-urgent', left <= 10);
        }, finish, isMulti ? ctx.room.now : null));

        /* --- Frischer Ballon --- */
        resetHard();

        /* ============ interne Spiel-Logik (Closure über endAt) ============ */

        function doPump() {
          if (dead || finished) return;
          if (clock() >= endAt) { finish(); return; }
          var chance = Math.min(POP_CAP, POP_BASE + pumps * POP_STEP);
          if (Math.random() < chance) { popBalloon(); return; }
          pumps++;
          stake += pumps;                       // Zuwachs wächst: +1, +2, +3, …
          if (App.Audio) App.Audio.blip(Math.min(900, 300 + pumps * 32), 0.08, { type: 'sine', peak: 0.06 });
          applyScale(true); paint(); syncHud();
        }

        function doCash() {
          if (dead || finished || stake <= 0) return;
          if (App.Audio) App.Audio.sfx('coin');
          total += stake;
          totalEl.textContent = MG.fmt(total);
          totalEl.classList.remove('bl-pump-total'); void totalEl.offsetWidth; totalEl.classList.add('bl-pump-total');
          if (isMulti) ctx.room.reportScore(total);
          floatText('+' + MG.fmt(stake), 'bl-float-cash');
          resetSmooth();                        // Ballon schrumpft sanft = eingesammelt
        }

        function popBalloon() {
          if (App.Audio) App.Audio.sfx('pop');
          balloonEl.classList.remove('bl-danger');
          balloonEl.classList.add('bl-popped');
          showBurst();
          stageEl.classList.remove('bl-shake'); void stageEl.offsetWidth; stageEl.classList.add('bl-shake');
          stake = 0; pumps = 0;                  // Einsatz verloren, Guthaben bleibt
          syncHud();
          after(520, function () { if (!dead) resetHard(); });
        }

        /* --- Ballon schrumpft weich (Cash-out): frischer, kleiner Ballon --- */
        function resetSmooth() {
          stake = 0; pumps = 0;
          balloonEl.classList.remove('bl-danger');
          applyScale(false); paint(); syncHud();
        }
        /* --- Ballon snappt auf klein (nach Platzen): kein Schrumpf-Tween --- */
        function resetHard() {
          stake = 0; pumps = 0;
          balloonEl.classList.remove('bl-popped', 'bl-danger');
          balloonWrap.style.transition = 'none';
          applyScale(false);
          void balloonWrap.offsetWidth;
          balloonWrap.style.transition = '';
          paint(); syncHud();
        }

        function applyScale(bounce) {
          var scale = Math.min(2.4, 0.72 + pumps * 0.115);
          if (bounce) {
            balloonWrap.style.transform = 'scale(' + (scale * 1.05).toFixed(3) + ')';
            after(90, function () { if (!dead && balloonWrap) balloonWrap.style.transform = 'scale(' + scale.toFixed(3) + ')'; });
          } else {
            balloonWrap.style.transform = 'scale(' + scale.toFixed(3) + ')';
          }
        }

        /* --- Farbe: je näher am Platzen, desto röter (subtiler Hinweis) --- */
        function paint() {
          var risk = Math.min(1, (POP_BASE + pumps * POP_STEP) / 0.5);
          var hue = Math.round(158 - risk * 158);   // 158 = türkis/grün  ->  0 = rot
          var c1 = 'hsl(' + hue + ',85%,72%)';
          var c2 = 'hsl(' + hue + ',90%,50%)';
          var c3 = 'hsl(' + hue + ',95%,38%)';
          balloonEl.style.background = 'radial-gradient(circle at 34% 28%,' + c1 + ' 0%,' + c2 + ' 45%,' + c3 + ' 100%)';
          balloonEl.style.boxShadow = '0 0 ' + Math.round(14 + risk * 26) + 'px hsla(' + hue + ',90%,55%,' + (0.4 + risk * 0.4).toFixed(2) + ')';
          balloonEl.style.setProperty('--bl-c', c3);
          stakeNumEl.textContent = stake > 0 ? MG.fmt(stake) : '';
          balloonEl.classList.toggle('bl-danger', risk > 0.6 && stake > 0);
        }

        function syncHud() {
          stakeEl.textContent = MG.fmt(stake);
          cashBtn.disabled = stake <= 0;
          pumpCountEl.textContent = pumps + (pumps === 1 ? ' Pump' : ' Pumps');
        }

        function showBurst() {
          var b = el('div', { class: 'bl-burst' }, ['💥']);
          stageEl.appendChild(b);
          after(600, function () { if (b.parentNode) b.parentNode.removeChild(b); });
        }

        function floatText(txt, cls) {
          var f = el('div', { class: 'bl-float ' + (cls || '') }, [txt]);
          stageEl.appendChild(f);
          after(850, function () { if (f.parentNode) f.parentNode.removeChild(f); });
        }
      }

      /* ===================== ENDE ===================== */
      function finish() {
        if (finished || dead) return;
        finished = true;
        if (pumpBtn) pumpBtn.disabled = true;
        if (cashBtn) cashBtn.disabled = true;
        clearRound();
        if (isMulti) {
          ctx.room.reportScore(total);
          after(1200, function () {
            if (dead) return;
            MG.endScreen(root, { players: ctx.room.players(), meId: ctx.me.id, onExit: ctx.onExit });
          });
        } else {
          var best = App.Storage.get('best_balloon', 0), nb = total > best;
          if (nb) App.Storage.set('best_balloon', total);
          MG.endScreen(root, {
            title: 'Zeit um! 🎈', score: total, best: best, newBest: nb,
            label: nb ? 'Neuer Rekord! 🎉' : 'Gesichert · Bestwert: ' + MG.fmt(best),
            onExit: ctx.onExit, onAgain: function () { play(Date.now()); }
          });
        }
      }
    }
  };

  /* ===================== STYLES ===================== */
  function injectStyle() {
    UI.injectStyle('mg-balloon-css', [
      '.bl-layout{display:flex;flex-direction:column;gap:14px;}',
      /* Kopf */
      '.bl-head{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px 18px;}',
      '.bl-head-cell{display:flex;flex-direction:column;gap:2px;}',
      '.bl-head-center{align-items:center;}',
      '.bl-head-right{align-items:flex-end;}',
      '.bl-head-l{font-size:11px;text-transform:uppercase;letter-spacing:1px;color:var(--muted);}',
      '.bl-total{font-size:clamp(24px,6.5vw,40px);line-height:1;color:var(--neon);text-shadow:0 0 14px rgba(57,255,20,.5);font-variant-numeric:tabular-nums;}',
      '.bl-total.bl-pump-total{animation:bl-pt .4s ease;}',
      '@keyframes bl-pt{0%{transform:scale(1)}40%{transform:scale(1.25);text-shadow:0 0 22px rgba(57,255,20,.9)}100%{transform:scale(1)}}',
      '.bl-stake-val{font-size:clamp(20px,5vw,30px);font-weight:900;line-height:1;color:var(--gold);text-shadow:0 0 12px rgba(255,210,63,.4);font-variant-numeric:tabular-nums;}',
      '.bl-timer{font-size:clamp(20px,5vw,28px);font-variant-numeric:tabular-nums;}',
      '.bl-timer.bl-urgent{color:var(--danger,#ff4d6d);animation:bl-pulse .6s ease-in-out infinite;}',
      '@keyframes bl-pulse{0%,100%{opacity:1}50%{opacity:.5}}',
      /* Bühne */
      '.bl-stage{display:flex;flex-direction:column;align-items:center;justify-content:center;position:relative;overflow:hidden;',
      'min-height:340px;height:min(52vh,440px);padding:20px;gap:6px;',
      'background:radial-gradient(120% 100% at 50% 0%,#0c3020,#04140c);touch-action:manipulation;',
      'user-select:none;-webkit-user-select:none;-webkit-touch-callout:none;}',
      '.bl-stage.bl-shake{animation:bl-shake .45s ease;}',
      '@keyframes bl-shake{0%,100%{transform:translate(0,0)}15%{transform:translate(-8px,4px)}30%{transform:translate(7px,-5px)}45%{transform:translate(-6px,3px)}60%{transform:translate(5px,-3px)}80%{transform:translate(-3px,2px)}}',
      '.bl-pumps{margin-top:10px;font-weight:700;letter-spacing:.5px;}',
      /* Ballon */
      '.bl-balloon-wrap{position:relative;display:flex;flex-direction:column;align-items:center;transform:scale(.72);transition:transform .28s cubic-bezier(.34,1.4,.5,1);will-change:transform;}',
      '.bl-balloon{position:relative;width:clamp(96px,26vw,132px);height:clamp(116px,32vw,160px);',
      'border-radius:50% 50% 50% 50%/54% 54% 46% 46%;display:flex;align-items:center;justify-content:center;',
      'background:radial-gradient(circle at 34% 28%,#7ef0d8 0%,#22b6a3 45%,#178a7c 100%);box-shadow:0 0 18px rgba(51,230,208,.5);will-change:transform,filter;}',
      '.bl-balloon::after{content:"";position:absolute;bottom:-9px;left:50%;transform:translateX(-50%);width:0;height:0;',
      'border-left:7px solid transparent;border-right:7px solid transparent;border-top:11px solid var(--bl-c,#178a7c);}',
      '.bl-shine{position:absolute;top:12%;left:20%;width:32%;height:24%;border-radius:50%;pointer-events:none;',
      'background:radial-gradient(circle at 40% 40%,rgba(255,255,255,.85),rgba(255,255,255,0) 70%);}',
      '.bl-stake-num{position:relative;z-index:2;font-weight:900;font-size:clamp(17px,4.6vw,24px);line-height:1;',
      'color:rgba(4,20,12,.82);text-shadow:0 1px 2px rgba(255,255,255,.45);pointer-events:none;font-variant-numeric:tabular-nums;}',
      '.bl-string{width:2px;height:44px;margin-top:5px;background:linear-gradient(to bottom,rgba(255,255,255,.55),rgba(255,255,255,.04));}',
      '.bl-balloon.bl-danger{animation:bl-danger .55s ease-in-out infinite;}',
      '@keyframes bl-danger{0%,100%{filter:drop-shadow(0 0 5px rgba(255,77,109,.35))}50%{filter:drop-shadow(0 0 16px rgba(255,77,109,.9))}}',
      '.bl-balloon.bl-popped{animation:bl-pop .32s ease forwards;}',
      '@keyframes bl-pop{0%{transform:scale(1)}28%{transform:scale(1.28)}100%{transform:scale(0);opacity:0}}',
      /* Platz-Effekt & Cash-Float */
      '.bl-burst{position:absolute;top:44%;left:50%;transform:translate(-50%,-50%);pointer-events:none;z-index:6;',
      'font-size:clamp(64px,20vw,120px);filter:drop-shadow(0 0 18px rgba(255,210,63,.7));animation:bl-burst .6s ease-out forwards;}',
      '@keyframes bl-burst{0%{transform:translate(-50%,-50%) scale(.3);opacity:0}25%{opacity:1;transform:translate(-50%,-50%) scale(1.2)}100%{opacity:0;transform:translate(-50%,-50%) scale(1.7)}}',
      '.bl-float{position:absolute;top:40%;left:50%;transform:translate(-50%,-50%);pointer-events:none;z-index:7;',
      'font-weight:900;font-size:clamp(22px,6vw,34px);color:var(--aqua);',
      'text-shadow:0 0 12px rgba(51,230,208,.7),0 2px 6px rgba(0,0,0,.6);animation:bl-float .85s ease-out forwards;}',
      '.bl-float-cash{color:var(--aqua);}',
      '@keyframes bl-float{0%{opacity:0;transform:translate(-50%,-50%) scale(.6)}20%{opacity:1;transform:translate(-50%,-110%) scale(1.1)}100%{opacity:0;transform:translate(-50%,-230%) scale(1)}}',
      /* Steuerung */
      '.bl-controls-wrap{padding:14px;display:flex;flex-direction:column;gap:10px;}',
      '.bl-controls{display:flex;gap:12px;}',
      '.bl-pump,.bl-cash{flex:1;font-size:clamp(15px,4.4vw,20px);padding:16px 8px;font-weight:900;letter-spacing:.5px;',
      'touch-action:manipulation;user-select:none;-webkit-user-select:none;}',
      '.bl-cash:disabled{opacity:.42;cursor:not-allowed;filter:grayscale(.4);}',
      '.bl-keyhint{text-align:center;}',
      /* Board */
      '.bl-board-wrap{padding:14px;display:flex;flex-direction:column;gap:8px;max-height:260px;overflow-y:auto;}'
    ].join(''));
  }
})();
