/* jenga.js — "Jenga": Zieh Steine aus dem Turm für +0.25× — aber er kann einstürzen.
 *
 * Risiko-Leiter mit Cashout (verwandt mit Mines/Crash):
 *   - Einsatz zahlt der Spieler ein. Multiplikator startet bei 1.00×.
 *   - Jeder erfolgreiche Zug hebt den Cashout-Multiplikator um +0.25× an
 *     (1.00 → 1.25 → 1.50 → …). Cashout-Wert = round(Einsatz * Multiplikator).
 *   - Jeder Zug hat eine Einsturz-Wahrscheinlichkeit. Stürzt der Turm, ist der
 *     Einsatz weg.
 *
 * FAIRNESS (~6 % House-Edge):
 *   Der Zug fügt dem aktuellen Cashout-Wert V = Einsatz*mult den festen Betrag
 *   inc = 0.25*Einsatz hinzu. Die Einsturz-Wahrscheinlichkeit ohne Hausvorteil
 *   ist p0 = inc / (V + inc)  ( = 0.25 / (mult + 0.25) ). Denn dann gilt
 *   fair:  (1 - p0)*(V + inc) = V  ->  Ziehen ist genau so viel wert wie Cashout.
 *   Tatsächlich benutzt: p = min(0.92, p0 * 1.06). Der Faktor 1.06 ist der Edge:
 *   der Turm stürzt 6 % häufiger als fair. Damit ist EV(Zug) = V - 0.06*inc,
 *   also verliert jeder Zug im Schnitt 0.06*inc = 0.015*Einsatz gegenüber dem
 *   Cashout — frühe Züge sind relativ zum Gewinn am riskantesten (p0 fällt mit
 *   steigendem mult). Einsturz-Wurf per Math.random().
 */
(function () {
  'use strict';
  window.App = window.App || {};
  App.Games = App.Games || {};

  var UI = App.UI, el = UI.el, Coins = App.Coins;

  var ROWS = 14;          // Turm-Reihen (von oben nach unten)
  var PER_ROW = 3;        // klassischer Jenga-Look: 3 Steine je Reihe
  var STEP = 0.25;        // Multiplikator-Zuwachs je erfolgreichem Zug
  var EDGE = 1.06;        // ~6 % House-Edge auf die faire Einsturz-Chance

  /* Faire Einsturz-Wahrscheinlichkeit (ohne Edge) beim aktuellen Multiplikator.
     p0 = inc/(V+inc) = 0.25/(mult+0.25) — unabhängig vom Einsatz. */
  function collapseChance(mult) {
    var p0 = STEP / (mult + STEP);
    var p = p0 * EDGE;
    return p > 0.92 ? 0.92 : p;
  }

  UI.injectStyle('game-jenga-css', [
    '.jenga-stage{gap:16px;}',
    '.jenga-readout{display:flex;flex-direction:column;align-items:center;gap:4px;text-align:center;}',
    '.jenga-mult-label{font-size:12px;letter-spacing:2px;text-transform:uppercase;color:var(--muted);font-weight:700;}',
    '.jenga-mult{color:var(--gold);text-shadow:0 0 18px rgba(255,210,63,0.5);line-height:1;transition:color .2s;}',
    '.jenga-mult.muted{color:var(--muted);text-shadow:none;}',
    '.jenga-payline{display:flex;align-items:center;gap:8px;font-weight:800;font-size:18px;}',
    '.jenga-pay-label{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:1px;}',
    '.jenga-pay-val{color:var(--leaf);font-variant-numeric:tabular-nums;}',
    '.jenga-risk{color:var(--danger-2);font-size:13px;font-weight:700;min-height:16px;}',
    '.jenga-risk.safe{color:var(--aqua-soft);}',
    /* Turm */
    '.jenga-tower{display:flex;flex-direction:column-reverse;gap:5px;width:100%;max-width:280px;',
    '  padding:12px 10px;border-radius:14px;border:1px solid var(--stroke);',
    '  background:radial-gradient(120% 100% at 50% 100%,rgba(16,54,35,0.55),rgba(6,18,11,0.7));',
    '  transition:transform .1s;}',
    '.jenga-tower.shake{animation:jenga-shake .5s ease;}',
    '@keyframes jenga-shake{0%,100%{transform:translate(0,0) rotate(0)}20%{transform:translate(-6px,2px) rotate(-1deg)}40%{transform:translate(6px,-2px) rotate(1deg)}60%{transform:translate(-4px,2px) rotate(-.6deg)}80%{transform:translate(3px,-1px) rotate(.4deg)}}',
    '.jenga-row{display:flex;gap:5px;height:clamp(16px,4.4vw,22px);}',
    '.jenga-block{flex:1;border-radius:4px;position:relative;',
    '  background:linear-gradient(180deg,hsl(28,62%,58%),hsl(26,58%,44%));',
    '  border:1px solid rgba(0,0,0,0.28);box-shadow:inset 0 1px 0 rgba(255,255,255,0.28),inset 0 -3px 5px rgba(0,0,0,0.28);',
    '  transition:opacity .28s ease,transform .32s cubic-bezier(.3,.8,.4,1);}',
    '.jenga-row.perp .jenga-block{background:linear-gradient(180deg,hsl(34,58%,60%),hsl(30,54%,46%));}',
    '.jenga-block.pulled{opacity:0;transform:translateX(46px) rotate(14deg);}',
    '.jenga-tower.collapsing .jenga-block{transition:transform .8s cubic-bezier(.4,.1,.7,1),opacity .8s ease;}',
    '.jenga-pull-anim{animation:jenga-pop .3s ease;}',
    '@keyframes jenga-pop{0%{transform:scale(1)}45%{transform:scale(1.05)}100%{transform:scale(1)}}',
    /* Aktionen */
    '.jenga-actions{display:flex;flex-direction:column;gap:10px;align-items:stretch;min-width:220px;}',
    '.jenga-status{font-size:14px;font-weight:800;color:var(--muted);min-height:18px;text-align:center;}',
    '.jenga-status.win{color:var(--neon);text-shadow:0 0 10px rgba(57,255,20,.4);}',
    '.jenga-status.loss{color:var(--danger-2);text-shadow:0 0 10px rgba(255,77,109,.4);}',
    /* Verlauf */
    '.jenga-hist{display:flex;flex-wrap:wrap;gap:8px;justify-content:center;align-items:center;}',
    '.jenga-hist-l{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:1px;font-weight:800;margin-right:2px;}',
    '.jenga-chip{font-weight:800;font-size:13px;padding:5px 11px;border-radius:999px;border:1px solid var(--stroke);background:rgba(4,16,10,.7);color:var(--muted);font-variant-numeric:tabular-nums;}',
    '.jenga-chip.win{color:var(--neon);border-color:var(--stroke-2);box-shadow:var(--glow-soft);}',
    '.jenga-chip.loss{color:var(--danger-2);border-color:rgba(255,77,109,.35);}',
    '.jenga-chip.empty{color:var(--muted);border-style:dashed;}',
    '@media(max-width:560px){.jenga-actions{min-width:100%;}}'
  ].join('\n'));

  App.Games.jenga = {
    id: 'jenga',
    title: 'Jenga',
    icon: '🧱',
    subtitle: 'Zieh Steine für +0.25× — aber der Turm kann einstürzen',

    render: function (root) {
      /* ---- Zustand ---- */
      var state = 'idle';       // 'idle' | 'playing' | 'ended'
      var bet = 0;
      var mult = 1;
      var pulls = 0;
      var over = false;         // Abrechnungs-Guard (genau 1× je Runde)
      var history = [];         // {v:mult, win:bool}, neueste zuerst
      var timers = [];

      function later(fn, ms) {
        var id = setTimeout(function () {
          var i = timers.indexOf(id); if (i >= 0) timers.splice(i, 1);
          fn();
        }, ms);
        timers.push(id);
        return id;
      }

      /* ---- Bet-Panel ---- */
      var betPanel = UI.createBetPanel({
        initial: 50,
        onChange: function () { if (state === 'idle') updateReadout(); }
      });

      /* ---- Anzeige ---- */
      var multEl = el('div', { class: 'big-readout jenga-mult muted' }, ['1.00×']);
      var payoutEl = el('span', { class: 'jenga-pay-val' }, ['0 🪙']);
      var riskEl = el('div', { class: 'jenga-risk' }, ['']);
      var statusEl = el('div', { class: 'jenga-status' }, ['Setze deinen Einsatz und baue den Turm 🏗️']);

      /* ---- Turm ---- */
      var blockEls = [];        // alle Stein-Elemente
      var present = [];         // bool[] — Stein noch im Turm?
      var rowEls = [];
      for (var r = 0; r < ROWS; r++) {
        var rowBlocks = [];
        for (var c = 0; c < PER_ROW; c++) {
          var b = el('div', { class: 'jenga-block' });
          blockEls.push(b);
          present.push(true);
          rowBlocks.push(b);
        }
        // Reihen abwechselnd "quer" für den klassischen Jenga-Look.
        rowEls.push(el('div', { class: 'jenga-row' + (r % 2 ? ' perp' : '') }, rowBlocks));
      }
      var towerEl = el('div', { class: 'jenga-tower' }, rowEls);

      var stage = el('div', { class: 'game-stage jenga-stage' }, [
        el('div', { class: 'jenga-readout' }, [
          el('div', { class: 'jenga-mult-label' }, ['Multiplikator']),
          multEl,
          el('div', { class: 'jenga-payline' }, [
            el('span', { class: 'jenga-pay-label' }, ['Cashout']), payoutEl
          ]),
          riskEl
        ]),
        towerEl,
        statusEl
      ]);

      /* ---- Aktions-Buttons ---- */
      var startSub = el('span', { class: 'btn-sub' }, ['']);
      var startBtn = el('button', { class: 'btn btn-primary btn-lg btn-block btn-2l', type: 'button', onclick: startRound }, [
        el('span', { class: 'btn-main' }, ['🏗️ Turm bauen']),
        startSub
      ]);
      var pullBtn = el('button', { class: 'btn btn-primary btn-lg btn-block', type: 'button', onclick: pull }, ['🧱 Stein ziehen']);
      var cashBtn = el('button', { class: 'btn btn-aqua btn-lg btn-block', type: 'button', onclick: function () { cashOut(); } }, ['💸 Cashout']);
      var newBtn = el('button', { class: 'btn btn-primary btn-lg btn-block', type: 'button', onclick: resetToIdle }, ['🌱 Neue Runde']);
      pullBtn.hidden = true; cashBtn.hidden = true; newBtn.hidden = true;

      var actions = el('div', { class: 'jenga-actions' }, [startBtn, pullBtn, cashBtn, newBtn]);

      var hintEl = el('p', { class: 'hint-text' }, [
        'Jeder gezogene Stein bringt +0.25×. Cashe rechtzeitig aus — stürzt der Turm, ist der Einsatz weg.'
      ]);

      var panel = el('div', { class: 'glass game-panel' }, [
        el('div', { class: 'controls-row' }, [betPanel.root, actions]),
        hintEl
      ]);

      root.appendChild(stage);
      root.appendChild(panel);

      applyState();
      updateReadout();

      /* ---- Ablauf ---- */
      function startRound() {
        if (state !== 'idle') return;
        var b = betPanel.getBet();
        if (!Coins.canBet(b)) { UI.toast('Nicht genug Coins', 'lose'); return; }
        bet = b;
        Coins.add(-bet);                    // Einsatz abziehen

        mult = 1; pulls = 0; over = false;
        resetTower();
        state = 'playing';
        statusEl.className = 'jenga-status';
        statusEl.textContent = 'Turm steht — zieh den ersten Stein 🧱';
        applyState();
        updateReadout();
        if (App.Audio) App.Audio.sfx('deal');
      }

      function pull() {
        if (state !== 'playing' || over) return;

        var p = collapseChance(mult);       // fair p0*1.06, gedeckelt 0.92
        if (Math.random() < p) { collapse(); return; }

        // Erfolgreicher Zug
        pulls++;
        mult += STEP;
        removeOneBlock();
        if (App.Audio) App.Audio.sfx(pulls % 2 ? 'chip' : 'tick');
        statusEl.className = 'jenga-status';
        statusEl.textContent = pulls + ' Stein(e) gezogen — weiter oder Cashout?';
        updateReadout();
      }

      function cashOut() {
        if (state !== 'playing' || over) return;
        if (pulls < 1) return;              // erst nach mind. 1 Zug auscashbar
        over = true;
        state = 'ended';
        if (App.Audio) App.Audio.sfx('cashout');

        var payout = Math.round(bet * mult);
        Coins.add(payout);                  // Bruttoauszahlung inkl. Einsatz
        UI.flash(payout - bet);
        UI.toast('Ausgecasht bei ' + mult.toFixed(2) + '×', 'win');

        multEl.classList.remove('muted');
        statusEl.className = 'jenga-status win';
        statusEl.textContent = 'Ausgecasht bei ' + mult.toFixed(2) + '× · +' + UI.formatCoins(payout - bet) + ' 🪙';
        riskEl.textContent = '';
        history.unshift({ v: mult, win: true });
        endRound();
      }

      function collapse() {
        if (over) return;
        over = true;
        state = 'ended';
        if (App.Audio) App.Audio.sfx('explosion');

        // Turm kippt: verbliebene Steine fallen zufällig, kurzes Schütteln.
        towerEl.classList.add('collapsing');
        for (var i = 0; i < blockEls.length; i++) {
          if (present[i]) {
            var dx = (Math.random() - 0.5) * 90;
            var dy = 60 + Math.random() * 90;
            var rot = (Math.random() - 0.5) * 60;
            blockEls[i].style.transform = 'translate(' + dx.toFixed(0) + 'px,' + dy.toFixed(0) + 'px) rotate(' + rot.toFixed(0) + 'deg)';
            blockEls[i].style.opacity = '0';
          }
        }
        towerEl.classList.remove('shake'); void towerEl.offsetWidth; towerEl.classList.add('shake');

        UI.flash(-bet);
        UI.toast('Turm eingestürzt bei ' + mult.toFixed(2) + '×', 'lose');

        multEl.classList.add('muted');
        multEl.textContent = '0.00×';
        payoutEl.textContent = '0 🪙';
        statusEl.className = 'jenga-status loss';
        statusEl.textContent = 'Turm eingestürzt nach ' + pulls + ' Stein(en) — Einsatz verloren';
        riskEl.textContent = '';
        history.unshift({ v: mult, win: false });
        endRound();
      }

      // Gemeinsamer Rundenabschluss.
      function endRound() {
        applyState();                       // state === 'ended'
        renderHistory();
        betPanel.refresh();
        Coins.settle();
      }

      function resetToIdle() {
        state = 'idle';
        bet = 0; mult = 1; pulls = 0; over = false;
        resetTower();
        multEl.classList.add('muted');
        statusEl.className = 'jenga-status';
        statusEl.textContent = 'Setze deinen Einsatz und baue den Turm 🏗️';
        applyState();
        updateReadout();
      }

      /* ---- Turm-Helfer ---- */
      function resetTower() {
        towerEl.classList.remove('collapsing', 'shake');
        for (var i = 0; i < blockEls.length; i++) {
          present[i] = true;
          blockEls[i].className = 'jenga-block';
          blockEls[i].style.transform = '';
          blockEls[i].style.opacity = '';
        }
      }

      function removeOneBlock() {
        // Zufälligen noch vorhandenen Stein "herausziehen".
        var idxList = [];
        for (var i = 0; i < present.length; i++) if (present[i]) idxList.push(i);
        if (!idxList.length) return;        // Turm leer (praktisch nie) -> nichts tun
        var pick = idxList[Math.floor(Math.random() * idxList.length)];
        present[pick] = false;
        blockEls[pick].classList.add('pulled');
        towerEl.classList.remove('pull-shake');
        // kleines Wackeln des Turms bei jedem Zug
        towerEl.classList.remove('shake'); void towerEl.offsetWidth; towerEl.classList.add('shake');
      }

      /* ---- Ansicht / Anzeige ---- */
      function applyState() {
        startBtn.hidden = state !== 'idle';
        pullBtn.hidden = state !== 'playing';
        cashBtn.hidden = state !== 'playing';
        newBtn.hidden = state !== 'ended';
        pullBtn.disabled = state !== 'playing';
        cashBtn.disabled = (state !== 'playing') || pulls < 1;
        betPanel.setDisabled(state === 'playing');
      }

      function updateReadout() {
        var previewBet = state === 'playing' ? bet : betPanel.getBet();
        var payout = Math.round(previewBet * mult);

        multEl.textContent = mult.toFixed(2) + '×';
        multEl.classList.toggle('muted', state !== 'playing');
        payoutEl.textContent = UI.formatCoins(payout) + ' 🪙';

        if (state === 'playing') {
          var pct = Math.round(collapseChance(mult) * 100);
          riskEl.textContent = 'Nächster Zug: +0.25× · Einsturz-Risiko ' + pct + ' %';
          riskEl.classList.toggle('safe', pct < 15);
          cashBtn.disabled = pulls < 1;
          cashBtn.textContent = pulls < 1
            ? '💸 Erst einen Stein ziehen'
            : ('💸 Cashout · ' + UI.formatCoins(payout) + ' 🪙');
        } else {
          if (state === 'idle') riskEl.textContent = 'Erster Zug: Einsturz-Risiko ' + Math.round(collapseChance(1) * 100) + ' %';
        }

        startSub.textContent = 'Einsatz ' + UI.formatCoins(previewBet) + ' 🪙';
      }

      function renderHistory() {
        histWrap.innerHTML = '';
        histWrap.appendChild(el('span', { class: 'jenga-hist-l' }, ['Letzte']));
        if (!history.length) {
          histWrap.appendChild(el('span', { class: 'jenga-chip empty' }, ['—']));
          return;
        }
        history.slice(0, 8).forEach(function (h) {
          histWrap.appendChild(el('span', {
            class: 'jenga-chip ' + (h.win ? 'win' : 'loss')
          }, [h.v.toFixed(2) + '×']));
        });
      }

      var histWrap = el('div', { class: 'jenga-hist' });
      panel.appendChild(histWrap);
      renderHistory();

      return {
        cleanup: function () {
          for (var i = 0; i < timers.length; i++) clearTimeout(timers[i]);
          timers = [];
        }
      };
    }
  };
})();
