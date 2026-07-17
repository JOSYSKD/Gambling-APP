/* crash.js — "Crash": Rakete steigt, cashe aus bevor sie abstürzt.
 *
 * House-Edge: Crash-Punkt vorab mit RTP 99 % gezogen
 *   r = Math.random(); crash = (r < 0.01) ? 1.00 : floor((0.99/(1-r))*100)/100
 * Der Multiplikator wächst exponentiell (beschleunigend) mit der Zeit.
 * Auszahlung beim Cashout = round(bet * aktuellerMultiplikator) (brutto inkl. Einsatz).
 */
(function () {
  'use strict';
  window.App = window.App || {};
  App.Games = App.Games || {};

  // Wachstumsrate pro Millisekunde: mult = e^(GROWTH * t).
  //  -> 2.00× nach ~3.6 s, 5.00× nach ~8.5 s, 10× nach ~12 s. Beschleunigt.
  var GROWTH = 0.00019;

  // Frühester Cashout-Multiplikator: vorher ist der Knopf gesperrt. Man muss also
  // mindestens bis 1.10× "drin bleiben", bevor man aussteigen darf. (Label/Logik
  // ziehen den Wert dynamisch aus dieser Konstante.)
  var MIN_CASHOUT = 1.1;

  App.UI.injectStyle('game-crash-css', [
    '.crash-stage{position:relative;padding:0;overflow:hidden;height:clamp(280px,44vh,440px);min-height:280px;}',
    '.crash-stage.bust{animation:crashShake .45s ease;}',
    '@keyframes crashShake{0%,100%{transform:translate(0,0)}20%{transform:translate(-7px,4px)}40%{transform:translate(6px,-3px)}60%{transform:translate(-4px,3px)}80%{transform:translate(3px,-2px)}}',
    '.crash-canvas{position:absolute;inset:0;width:100%;height:100%;display:block;}',
    '.crash-overlay{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;pointer-events:none;text-align:center;padding:14px;}',
    '.crash-mult{line-height:1;text-shadow:0 0 22px currentColor;transition:color .12s;font-variant-numeric:tabular-nums;}',
    '.crash-mult.idle{color:var(--leaf);}',
    '.crash-mult.run{color:var(--neon);}',
    '.crash-mult.win{color:var(--gold);}',
    '.crash-mult.bust{color:var(--danger);}',
    '.crash-status{font-size:15px;font-weight:800;color:var(--muted);min-height:20px;letter-spacing:.3px;}',
    '.crash-status.win{color:var(--neon);text-shadow:0 0 10px rgba(57,255,20,.5);}',
    '.crash-status.bust{color:var(--danger-2);text-shadow:0 0 10px rgba(255,77,109,.5);}',
    '.crash-controls{display:flex;flex-wrap:wrap;gap:14px;align-items:flex-end;justify-content:center;}',
    '.crash-actions{display:flex;flex-direction:column;gap:10px;flex:1;min-width:220px;}',
    '.crash-actions .btn{white-space:nowrap;}',
    '.crash-hist{display:flex;flex-wrap:wrap;gap:8px;justify-content:center;align-items:center;}',
    '.crash-hist-l{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:1px;font-weight:800;margin-right:2px;}',
    '.crash-chip{font-weight:800;font-size:13px;padding:5px 11px;border-radius:999px;border:1px solid var(--stroke);background:rgba(4,16,10,.7);color:var(--muted);font-variant-numeric:tabular-nums;}',
    '.crash-chip.win{color:var(--neon);border-color:var(--stroke-2);box-shadow:var(--glow-soft);}',
    '.crash-chip.loss{color:var(--danger-2);border-color:rgba(255,77,109,.35);}',
    '.crash-chip.empty{color:var(--muted);border-style:dashed;}',
    '@media(max-width:560px){.crash-actions{min-width:100%;}}'
  ].join('\n'));

  App.Games.crash = {
    id: 'crash',
    title: 'Crash',
    icon: '🚀',
    subtitle: 'Cashe aus, bevor die Rakete abstürzt',

    render: function (root) {
      var UI = App.UI, el = UI.el;

      /* -------------------- Zustand -------------------- */
      var state = {
        phase: 'idle',      // 'idle' | 'running' | 'crashed' | 'cashed'
        bet: 0,
        crashPoint: 0,
        startTime: null,
        elapsed: 0,
        mult: 1,            // angezeigter (gefloorter) Multiplikator
        busted: false,
        viewXMax: 6000,     // sichtbares Zeitfenster (ms) — sanft nachziehend
        viewYMax: 2         // sichtbarer Multiplikator-Bereich
      };
      var rafId = null;
      var timers = [];
      var history = [];      // {v:crashValue, win:bool}, neueste zuerst
      var riser = null;      // steigender Ton während des Flugs (App.Audio.hold)
      function stopRiser(fade) { if (riser) { riser.stop(fade); riser = null; } }

      function later(fn, ms) { var id = setTimeout(fn, ms); timers.push(id); return id; }

      /* -------------------- DOM -------------------- */
      var canvas = el('canvas', { class: 'crash-canvas' });
      var ctx = canvas.getContext('2d');

      var readout = el('div', { class: 'big-readout crash-mult idle' }, ['1.00×']);
      var status = el('div', { class: 'crash-status' }, ['Setze deinen Einsatz und starte 🚀']);
      var overlay = el('div', { class: 'crash-overlay' }, [readout, status]);
      var stage = el('div', { class: 'game-stage crash-stage' }, [canvas, overlay]);

      var betPanel = UI.createBetPanel({ initial: 50, onChange: updateStartSub });

      var startSub = el('span', { class: 'btn-sub' }, ['']);
      var startBtn = el('button', { class: 'btn btn-primary btn-lg btn-block btn-2l', type: 'button', onclick: startRound }, [
        el('span', { class: 'btn-main' }, ['🚀 Start']),
        startSub
      ]);
      var cashBtn = el('button', { class: 'btn btn-aqua btn-lg btn-block', type: 'button', disabled: true, onclick: cashout }, ['CASHOUT']);
      var actions = el('div', { class: 'crash-actions' }, [startBtn, cashBtn]);

      var controls = el('div', { class: 'crash-controls' }, [betPanel.root, actions]);

      var histWrap = el('div', { class: 'crash-hist' });

      var hint = el('p', { class: 'hint-text' }, [
        'Der Multiplikator steigt immer schneller. Cashe rechtzeitig aus — sonst ist der Einsatz weg. RTP 99 %.'
      ]);

      root.appendChild(el('div', { class: 'game-panel glass', style: 'display:flex;flex-direction:column;gap:16px;' }, [
        stage, controls, histWrap, hint
      ]));

      renderHistory();
      drawScene();
      updateStartSub();

      /* -------------------- Buttons/Anzeige -------------------- */
      function updateStartSub() {
        startSub.textContent = 'Einsatz ' + UI.formatCoins(betPanel.getBet()) + ' 🪙';
      }

      function updateButtons() {
        startBtn.disabled = (state.phase !== 'idle');
        // Cashout erst ab MIN_CASHOUT (1.20×) erlaubt.
        cashBtn.disabled = (state.phase !== 'running') || (state.mult < MIN_CASHOUT);
        betPanel.setDisabled(state.phase !== 'idle');
      }

      function updateReadout() {
        readout.textContent = state.mult.toFixed(2) + '×';
      }

      function updateCashLabel() {
        if (state.phase === 'running') {
          if (state.mult < MIN_CASHOUT) {
            cashBtn.textContent = '🔒 Cashout ab ' + MIN_CASHOUT.toFixed(2) + '×';
          } else {
            var payout = Math.round(state.bet * state.mult);
            cashBtn.textContent = '💸 CASHOUT · ' + UI.formatCoins(payout) + ' 🪙';
          }
        } else {
          cashBtn.textContent = 'CASHOUT';
        }
      }

      function renderHistory() {
        histWrap.innerHTML = '';
        histWrap.appendChild(el('span', { class: 'crash-hist-l' }, ['Letzte']));
        if (!history.length) {
          histWrap.appendChild(el('span', { class: 'crash-chip empty' }, ['—']));
          return;
        }
        history.slice(0, 8).forEach(function (h) {
          histWrap.appendChild(el('span', {
            class: 'crash-chip ' + (h.win ? 'win' : 'loss')
          }, [h.v.toFixed(2) + '×']));
        });
      }

      /* -------------------- Rundenlogik -------------------- */
      function startRound() {
        if (state.phase !== 'idle') return;
        var bet = betPanel.getBet();
        if (!App.Coins.canBet(bet)) { UI.toast('Nicht genug Coins', 'lose'); return; }

        App.Coins.add(-bet);        // Einsatz abziehen

        // Crash-Punkt vorab ziehen (House-Edge, RTP 99 %) — bleibt geheim.
        var r = Math.random();
        var crash = (r < 0.01) ? 1.00 : Math.floor((0.99 / (1 - r)) * 100) / 100;
        if (crash < 1) crash = 1.00;

        state.phase = 'running';
        state.bet = bet;
        state.crashPoint = crash;
        state.startTime = null;     // wird im ersten Frame gesetzt
        state.elapsed = 0;
        state.mult = 1;
        state.busted = false;
        state.viewXMax = 6000;
        state.viewYMax = 2;

        readout.className = 'big-readout crash-mult run';
        status.className = 'crash-status';
        status.textContent = 'Steigt … 🚀';
        updateReadout();
        updateCashLabel();
        updateButtons();

        // Steigender Spannungston — Tonhöhe wächst mit dem Multiplikator, bricht bei Cashout/Crash ab.
        stopRiser(0.02);
        if (App.Audio) riser = App.Audio.hold(165, { type: 'sawtooth', peak: 0.06, filter: 1400 });

        rafId = requestAnimationFrame(loop);
      }

      function loop(ts) {
        if (state.startTime == null) state.startTime = ts;
        state.elapsed = ts - state.startTime;

        var m = Math.exp(GROWTH * state.elapsed);
        var crashed = false;
        if (m >= state.crashPoint) { m = state.crashPoint; crashed = true; }

        state.mult = Math.floor(m * 100) / 100;
        if (state.mult < 1) state.mult = 1;

        // Ton steigt mit dem Multiplikator (gedeckelt, damit's nicht schrill wird).
        if (riser) riser.setFreq(150 + Math.min(1900, (state.mult - 1) * 95), 0.09);

        updateView();
        updateReadout();
        updateCashLabel();
        cashBtn.disabled = (state.mult < MIN_CASHOUT);   // erst ab 1.20× freischalten
        drawScene();

        if (crashed) { bust(); return; }
        rafId = requestAnimationFrame(loop);
      }

      // Sichtfenster sanft an aktuellen Stand anpassen (dynamisches "Rauszoomen").
      function updateView() {
        var m = state.mult, e = state.elapsed;
        var targetY = Math.max(2, m * 1.4);
        var targetX = Math.max(6000, e * 1.25 + 2500);
        state.viewYMax += (targetY - state.viewYMax) * 0.06;
        state.viewXMax += (targetX - state.viewXMax) * 0.06;
        if (state.viewYMax < m * 1.05) state.viewYMax = m * 1.05;
        if (state.viewXMax < e * 1.03) state.viewXMax = e * 1.03;
        if (state.viewYMax < 2) state.viewYMax = 2;
        if (state.viewXMax < 3000) state.viewXMax = 3000;
      }

      function cashout() {
        if (state.phase !== 'running') return;
        if (state.mult < MIN_CASHOUT) return;   // vor 1.20× ist Aussteigen gesperrt
        if (rafId) { cancelAnimationFrame(rafId); rafId = null; }

        state.phase = 'cashed';
        stopRiser(0.05);
        if (App.Audio) App.Audio.sfx('cashout');
        var payout = Math.round(state.bet * state.mult);
        App.Coins.add(payout);

        readout.className = 'big-readout crash-mult win';
        updateReadout();
        status.className = 'crash-status win';
        status.textContent = 'Ausgecasht bei ' + state.mult.toFixed(2) + '× · +' + UI.formatCoins(payout - state.bet) + ' 🪙';

        UI.flash(payout - state.bet);
        UI.toast('Ausgecasht bei ' + state.mult.toFixed(2) + '×', 'win');

        history.unshift({ v: state.mult, win: true });
        drawScene();
        endRound();
      }

      function bust() {
        rafId = null;
        state.phase = 'crashed';
        state.busted = true;
        state.mult = state.crashPoint;

        stopRiser(0.02);
        if (App.Audio) App.Audio.sfx('explosion');

        readout.className = 'big-readout crash-mult bust';
        updateReadout();
        status.className = 'crash-status bust';
        status.textContent = 'Abgestürzt bei ' + state.crashPoint.toFixed(2) + '× — Einsatz verloren';

        stage.classList.remove('bust'); void stage.offsetWidth; stage.classList.add('bust');
        UI.flash(-state.bet);
        UI.toast('Crash bei ' + state.crashPoint.toFixed(2) + '×', 'lose');

        history.unshift({ v: state.crashPoint, win: false });
        drawScene();
        endRound();
      }

      // Abrechnung nach vollständig beendeter Runde.
      function endRound() {
        updateCashLabel();
        renderHistory();
        betPanel.refresh();
        state.phase = 'idle';       // erst danach ist Game-Over-Prüfung korrekt
        updateButtons();
        App.Coins.settle();
      }

      /* -------------------- Zeichnen -------------------- */
      function drawScene() {
        var dpr = window.devicePixelRatio || 1;
        var rect = canvas.getBoundingClientRect();
        var W = Math.max(1, rect.width), H = Math.max(1, rect.height);
        var bw = Math.round(W * dpr), bh = Math.round(H * dpr);
        if (canvas.width !== bw || canvas.height !== bh) { canvas.width = bw; canvas.height = bh; }
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, W, H);

        var padL = 10, padR = 10, padT = 16, padB = 10;
        var plotW = W - padL - padR, plotH = H - padT - padB;
        var vx = state.viewXMax, vy = state.viewYMax;
        if (vy <= 1) vy = 2;
        var baseY = padT + plotH;

        function X(t) { return padL + (t / vx) * plotW; }
        function Y(m) { return baseY - ((m - 1) / (vy - 1)) * plotH; }

        var busted = state.busted;
        var lineCol = busted ? '#ff4d6d' : '#39ff14';
        var glowCol = busted ? 'rgba(255,77,109,0.65)' : 'rgba(57,255,20,0.6)';

        // --- Gitternetz (Multiplikator-Ticks) ---
        ctx.lineWidth = 1;
        ctx.font = '11px ' + '-apple-system, Segoe UI, Roboto, sans-serif';
        ctx.textBaseline = 'middle';
        for (var i = 1; i <= 4; i++) {
          var mv = 1 + (vy - 1) * (i / 4);
          var gy = Y(mv);
          ctx.strokeStyle = 'rgba(57,255,20,0.07)';
          ctx.beginPath(); ctx.moveTo(padL, gy); ctx.lineTo(W - padR, gy); ctx.stroke();
          ctx.fillStyle = 'rgba(123,166,146,0.6)';
          ctx.textAlign = 'left';
          ctx.fillText(mv.toFixed(mv < 10 ? 1 : 0) + '×', padL + 2, gy - 7);
        }
        // Basislinie 1.00×
        ctx.strokeStyle = 'rgba(57,255,20,0.18)';
        ctx.beginPath(); ctx.moveTo(padL, baseY); ctx.lineTo(W - padR, baseY); ctx.stroke();

        // --- Kurve aufbauen ---
        var e = state.elapsed;
        var endX = X(e);
        var steps = Math.max(2, Math.min(220, Math.floor((endX - padL) / 3)));
        var pts = [];
        for (var s = 0; s <= steps; s++) {
          var t = e * (s / steps);
          var m = Math.exp(GROWTH * t);
          if (m > state.mult) m = state.mult;
          pts.push([X(t), Y(m)]);
        }
        var last = pts[pts.length - 1];

        // --- Fläche unter der Kurve ---
        var grad = ctx.createLinearGradient(0, padT, 0, baseY);
        grad.addColorStop(0, busted ? 'rgba(255,77,109,0.28)' : 'rgba(57,255,20,0.26)');
        grad.addColorStop(1, 'rgba(57,255,20,0.0)');
        ctx.beginPath();
        ctx.moveTo(pts[0][0], baseY);
        for (var p = 0; p < pts.length; p++) ctx.lineTo(pts[p][0], pts[p][1]);
        ctx.lineTo(last[0], baseY);
        ctx.closePath();
        ctx.fillStyle = grad;
        ctx.fill();

        // --- Neon-Linie mit Glow ---
        ctx.save();
        ctx.shadowColor = glowCol;
        ctx.shadowBlur = 16;
        ctx.strokeStyle = lineCol;
        ctx.lineWidth = 3;
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(pts[0][0], pts[0][1]);
        for (var q = 1; q < pts.length; q++) ctx.lineTo(pts[q][0], pts[q][1]);
        ctx.stroke();
        ctx.restore();

        // --- Raketen-/Crash-Symbol am Kurvenende ---
        ctx.save();
        ctx.shadowColor = glowCol;
        ctx.shadowBlur = 14;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        if (busted) {
          ctx.font = '30px sans-serif';
          ctx.fillText('💥', last[0], last[1]);
        } else {
          // kleiner Glow-Punkt + Rakete
          ctx.fillStyle = lineCol;
          ctx.beginPath(); ctx.arc(last[0], last[1], 4, 0, Math.PI * 2); ctx.fill();
          ctx.shadowBlur = 10;
          ctx.font = '26px sans-serif';
          ctx.fillText('🚀', last[0], last[1] - 15);
        }
        ctx.restore();
      }

      // Bei Größenänderung neu zeichnen (auch im Ruhezustand).
      var onResize = function () { drawScene(); };
      window.addEventListener('resize', onResize);

      /* -------------------- Cleanup -------------------- */
      return {
        cleanup: function () {
          if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
          stopRiser(0.02);
          timers.forEach(function (id) { clearTimeout(id); });
          timers = [];
          window.removeEventListener('resize', onResize);
        }
      };
    }
  };
})();
