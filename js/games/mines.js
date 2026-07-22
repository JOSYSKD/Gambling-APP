/* mines.js — "Mines": 5×5-Feld, sicher aufdecken & auscashen.
 *
 * Fairer Multiplikator mit ~1 % House-Edge:
 *   fair = 1; for (i=0..k-1) fair *= (n - i) / (n - m - i); mult = fair * 0.99;
 *   (n = 25 Felder, m = Minen, k = sichere Aufdeckungen)
 */
(function () {
  'use strict';
  window.App = window.App || {};
  App.Games = App.Games || {};

  var UI = App.UI, el = UI.el, Coins = App.Coins;
  var N = 25;                 // 5×5
  var MINE_CHOICES = [3, 5, 10];
  var GEMS = ['💎', '💎', '🌿', '💎', '🍀', '💎'];

  /* ----- Fairer Multiplikator nach k sicheren Aufdeckungen ----- */
  function multFor(m, k) {
    if (k <= 0) return 1;
    var fair = 1;
    for (var i = 0; i < k; i++) fair *= (N - i) / (N - m - i);
    return fair * 0.99;
  }
  function fmtMult(x) {
    if (x >= 100) return UI.formatCoins(Math.round(x));
    if (x >= 10) return x.toFixed(1);
    return x.toFixed(2);
  }

  /* ----- Spielspezifisches CSS ----- */
  UI.injectStyle('game-mines-css', [
    '.mines-stage{gap:18px;}',
    '.mines-readout{display:flex;flex-direction:column;align-items:center;gap:4px;text-align:center;}',
    '.mines-mult-label{font-size:12px;letter-spacing:2px;text-transform:uppercase;color:var(--muted);font-weight:700;}',
    '.mines-mult{color:var(--gold);text-shadow:0 0 18px rgba(255,210,63,0.5);line-height:1;transition:color .2s;}',
    '.mines-mult.muted{color:var(--muted);text-shadow:none;}',
    '.mines-payline{display:flex;align-items:center;gap:8px;font-weight:800;font-size:18px;}',
    '.mines-pay-label{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:1px;}',
    '.mines-pay-val{color:var(--leaf);font-variant-numeric:tabular-nums;}',
    '.mines-next{color:var(--aqua-soft);font-size:13px;font-weight:700;min-height:16px;}',
    '.mines-progress{color:var(--muted);font-size:12px;letter-spacing:1px;}',
    '.mines-grid{display:grid;grid-template-columns:repeat(5,1fr);gap:8px;width:100%;max-width:340px;}',
    '.mines-cell{aspect-ratio:1/1;display:grid;place-items:center;border-radius:12px;',
    '  border:1px solid var(--stroke);background:linear-gradient(180deg,rgba(16,54,35,0.9),rgba(8,28,18,0.9));',
    '  font-size:clamp(20px,7vw,30px);color:var(--text);user-select:none;transition:transform .1s,box-shadow .15s,border-color .15s;}',
    '.mines-grid.playing .mines-cell:not(.revealed){cursor:pointer;}',
    '.mines-grid.playing .mines-cell:not(.revealed):hover{transform:translateY(-2px);border-color:var(--stroke-2);box-shadow:var(--glow-soft);}',
    '.mines-grid:not(.playing) .mines-cell{cursor:default;}',
    '.mines-cell.revealed{cursor:default;}',
    '.mines-cell.safe{border-color:var(--neon);background:radial-gradient(120% 120% at 50% 0%,rgba(57,255,20,0.28),rgba(8,28,18,0.9));box-shadow:inset 0 0 14px rgba(57,255,20,0.25),0 0 10px rgba(57,255,20,0.25);}',
    '.mines-cell.pop{animation:mines-pop .32s cubic-bezier(.2,.9,.3,1.4);}',
    '.mines-cell.mine{border-color:var(--danger);background:radial-gradient(120% 120% at 50% 0%,rgba(255,77,109,0.35),rgba(30,6,12,0.92));}',
    '.mines-cell.mine.shown{opacity:.7;filter:saturate(.8);}',
    '.mines-cell.reveal-fade{animation:mines-fade .3s ease both;}',
    '.mines-cell.exploded{border-color:var(--danger);background:radial-gradient(120% 120% at 50% 0%,rgba(255,120,80,0.75),rgba(60,10,10,0.95));',
    '  box-shadow:0 0 26px rgba(255,90,60,0.8),inset 0 0 20px rgba(255,180,80,0.6);animation:mines-boom .5s ease both;}',
    '@keyframes mines-pop{0%{transform:scale(.35);opacity:0;}60%{transform:scale(1.18);}100%{transform:scale(1);opacity:1;}}',
    '@keyframes mines-fade{from{opacity:0;transform:scale(.7);}to{opacity:.7;transform:scale(1);}}',
    '@keyframes mines-boom{0%{transform:scale(1) rotate(0);}20%{transform:scale(1.35) rotate(-9deg);}40%{transform:scale(1.15) rotate(9deg);}60%{transform:scale(1.28) rotate(-5deg);}80%{transform:scale(1.1) rotate(4deg);}100%{transform:scale(1) rotate(0);}}',
    '.mines-modes{display:flex;gap:8px;flex-wrap:wrap;}',
    '.mines-mode{cursor:pointer;font-family:inherit;font-weight:800;font-size:14px;color:var(--text);',
    '  padding:10px 16px;border-radius:12px;border:1px solid var(--stroke);background:rgba(9,32,21,0.7);transition:.12s;display:flex;flex-direction:column;align-items:center;gap:2px;line-height:1.1;}',
    '.mines-mode small{font-size:10px;color:var(--muted);font-weight:700;}',
    '.mines-mode:hover:not(:disabled){border-color:var(--stroke-2);box-shadow:var(--glow-soft);transform:translateY(-1px);}',
    '.mines-mode.active{border-color:var(--danger);color:var(--danger-2);box-shadow:0 0 14px rgba(255,77,109,0.35);}',
    '.mines-mode.active small{color:var(--danger-2);}',
    '.mines-mode:disabled{opacity:.5;cursor:not-allowed;}',
    '.mines-field-label{font-size:12px;color:var(--muted);font-weight:700;text-transform:uppercase;letter-spacing:1px;text-align:center;margin-bottom:2px;}',
    '.mines-actions{display:flex;flex-direction:column;gap:10px;align-items:stretch;min-width:220px;}',
    '.mines-setup-col{display:flex;flex-direction:column;gap:8px;}'
  ].join('\n'));

  App.Games.mines = {
    id: 'mines',
    title: 'Mines',
    icon: '💣',
    subtitle: '5×5-Feld — decke sicher auf, cashe aus',

    render: function (root) {
      /* ---- Zustand ---- */
      var state = 'setup';          // 'setup' | 'playing' | 'ended'
      var mineCount = 3;
      var mines = null;             // Set der Minen-Indizes
      var revealedCount = 0;        // sichere Aufdeckungen (k)
      var revealed = null;          // bool[]
      var currentBet = 0;
      var over = false;             // Abrechnungs-Guard (genau 1× je Runde)
      var forcedOutcome = null;     // Rigging-Verdikt der Runde ('win'|'lose'|null)
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
        onChange: function () { if (state === 'setup') updateReadout(); }
      });

      /* ---- Minen-Auswahl ---- */
      var modeBtns = MINE_CHOICES.map(function (m) {
        return el('button', {
          class: 'mines-mode' + (m === mineCount ? ' active' : ''),
          type: 'button',
          onclick: function () { if (state === 'playing') return; selectMode(m); }
        }, [String(m) + ' 💣', el('small', {}, ['×' + fmtMult(multFor(m, 1)) + ' / Feld'])]);
      });
      function selectMode(m) {
        mineCount = m;
        modeBtns.forEach(function (b, i) { b.classList.toggle('active', MINE_CHOICES[i] === m); });
        updateReadout();
      }

      /* ---- Anzeige (Multiplikator / Cashout) ---- */
      var multEl = el('div', { class: 'big-readout mines-mult muted' }, ['×1.00']);
      var payoutEl = el('span', { class: 'mines-pay-val' }, ['0 🪙']);
      var nextEl = el('div', { class: 'mines-next' }, ['']);
      var progressEl = el('div', { class: 'mines-progress' }, ['']);

      /* ---- Spielfeld ---- */
      var cells = [];
      for (var idx = 0; idx < N; idx++) {
        (function (i) {
          var c = el('button', { class: 'mines-cell', type: 'button', onclick: function () { onCellClick(i); } });
          cells.push(c);
        })(idx);
      }
      var grid = el('div', { class: 'mines-grid' }, cells);

      var stage = el('div', { class: 'game-stage mines-stage' }, [
        el('div', { class: 'mines-readout' }, [
          el('div', { class: 'mines-mult-label' }, ['Multiplikator']),
          multEl,
          el('div', { class: 'mines-payline' }, [
            el('span', { class: 'mines-pay-label' }, ['Cashout']), payoutEl
          ]),
          nextEl,
          progressEl
        ]),
        grid
      ]);

      /* ---- Aktions-Buttons ---- */
      var startSub = el('span', { class: 'btn-sub' }, ['']);
      var startBtn = el('button', { class: 'btn btn-primary btn-lg btn-block btn-2l', type: 'button', onclick: startRound }, [
        el('span', { class: 'btn-main' }, ['💣 Start']),
        startSub
      ]);
      var cashBtn = el('button', { class: 'btn btn-aqua btn-lg btn-block', type: 'button', onclick: function () { cashOut(false); } }, ['💰 Cashout']);
      var newBtn = el('button', { class: 'btn btn-primary btn-lg btn-block', type: 'button', onclick: resetToSetup }, ['🌱 Neue Runde']);
      cashBtn.hidden = true; newBtn.hidden = true;

      var hintEl = el('p', { class: 'hint-text' }, ['']);

      var panel = el('div', { class: 'glass game-panel' }, [
        el('div', { class: 'controls-row' }, [
          betPanel.root,
          el('div', { class: 'mines-setup-col' }, [
            el('div', { class: 'mines-field-label' }, ['Minen']),
            el('div', { class: 'mines-modes' }, modeBtns)
          ]),
          el('div', { class: 'mines-actions' }, [startBtn, cashBtn, newBtn])
        ]),
        hintEl
      ]);

      root.appendChild(stage);
      root.appendChild(panel);

      /* ---- Ablauf ---- */
      function safeTotal() { return N - mineCount; }

      function startRound() {
        if (state === 'playing') return;
        var bet = betPanel.getBet();
        if (!Coins.canBet(bet)) { UI.toast('Nicht genug Coins', 'lose'); return; }
        currentBet = bet;
        Coins.add(-bet);                    // Einsatz abziehen

        // Minen platzieren: genau mineCount eindeutige Positionen
        mines = {};
        var placed = 0;
        while (placed < mineCount) {
          var p = Math.floor(Math.random() * N);
          if (!mines[p]) { mines[p] = true; placed++; }
        }
        revealed = new Array(N);
        revealedCount = 0;
        over = false;
        forcedOutcome = (App.Rig && App.Rig.outcome) ? App.Rig.outcome() : null;

        // Feld zurücksetzen
        cells.forEach(function (c) { c.className = 'mines-cell'; c.textContent = ''; });

        state = 'playing';
        applyState();
        updateReadout();
      }

      // Rigging: Minen umverteilen, damit das erzwungene Rundenergebnis eintritt.
      function makeMineAt(i) {              // Feld i garantiert zur Mine machen
        if (mines[i]) return;
        for (var k = 0; k < N; k++) {
          if (mines[k] && !revealed[k]) { delete mines[k]; mines[i] = true; return; }
        }
      }
      function relocateMineAwayFrom(i) {    // Mine von Feld i auf ein anderes Feld schieben
        var free = [];
        for (var k = 0; k < N; k++) { if (k !== i && !mines[k] && !revealed[k]) free.push(k); }
        if (!free.length) return;
        delete mines[i];
        mines[free[Math.floor(Math.random() * free.length)]] = true;
      }

      function onCellClick(i) {
        if (state !== 'playing' || revealed[i]) return;
        // Erzwungenes Ergebnis: 'lose' -> Mine unters Feld, 'win' -> Feld sicher machen.
        if (forcedOutcome === 'lose') makeMineAt(i);
        else if (forcedOutcome === 'win' && mines[i]) relocateMineAwayFrom(i);
        revealed[i] = true;
        var cell = cells[i];
        if (mines[i]) { hitMine(i); return; }

        // Sicheres Feld
        revealedCount++;
        cell.classList.add('revealed', 'safe', 'pop');
        cell.textContent = GEMS[Math.floor(Math.random() * GEMS.length)];
        if (App.Audio) App.Audio.sfx('pop');
        updateReadout();

        if (revealedCount >= safeTotal()) {
          // Alle sicheren Felder aufgedeckt → Max-Cashout
          state = 'ended';            // sofort sperren
          cashBtn.disabled = true;    // Klick im Auto-Fenster verhindern
          later(function () { cashOut(true); }, 380);
        }
      }

      function hitMine(i) {
        if (over) return;
        over = true;
        state = 'ended';
        var cell = cells[i];
        cell.classList.add('revealed', 'mine', 'exploded');
        cell.textContent = '💣';
        if (App.Audio) App.Audio.sfx('explosion');

        // Restliche Minen gestaffelt aufdecken
        var order = 0;
        for (var k = 0; k < N; k++) {
          if (mines[k] && k !== i && !revealed[k]) {
            (function (idx, delay) {
              later(function () {
                cells[idx].classList.add('revealed', 'mine', 'reveal-fade');
                cells[idx].textContent = '💣';
              }, delay);
            })(k, 70 + order * 55);
            order++;
          }
        }

        UI.flash(-currentBet);
        UI.toast('Boom! Mine getroffen 💥', 'lose');
        multEl.classList.add('muted');
        multEl.textContent = '×0.00';
        payoutEl.textContent = '0 🪙';
        nextEl.textContent = '';
        progressEl.textContent = revealedCount + ' / ' + safeTotal() + ' sicher';
        hintEl.textContent = 'Einsatz verloren. ' + revealedCount + ' Feld(er) waren sicher.';
        endRound();
      }

      function cashOut(auto) {
        if (over) return;
        // nur gültig mit mind. 1 sicherem Feld
        if (revealedCount < 1) return;
        over = true;
        if (App.Audio) App.Audio.sfx('cashout');
        var mult = multFor(mineCount, revealedCount);
        var payout = Math.round(currentBet * mult);
        Coins.add(payout);                  // Bruttoauszahlung inkl. Einsatz
        UI.flash(payout - currentBet);
        UI.toast(auto ? 'Perfekt! Alle Felder sicher — Max-Cashout 🌟'
                      : ('Ausgecasht: +' + UI.formatCoins(payout - currentBet) + ' 🪙'), 'win');

        // Verbliebene Minen zur Info zeigen
        for (var k = 0; k < N; k++) {
          if (mines[k] && !revealed[k]) {
            cells[k].classList.add('revealed', 'mine', 'shown', 'reveal-fade');
            cells[k].textContent = '💣';
          }
        }
        state = 'ended';
        multEl.classList.remove('muted');
        multEl.textContent = '×' + fmtMult(mult);
        payoutEl.textContent = UI.formatCoins(payout) + ' 🪙';
        nextEl.textContent = '';
        progressEl.textContent = revealedCount + ' / ' + safeTotal() + ' sicher';
        hintEl.textContent = 'Gewinn: ' + UI.formatCoins(payout) + ' 🪙 bei ×' + fmtMult(mult) + '.';
        endRound();
      }

      // Gemeinsamer Rundenabschluss: Buttons/Einsatz freigeben, abrechnen.
      function endRound() {
        applyState();                       // state === 'ended'
        betPanel.refresh();
        Coins.settle();
      }

      function resetToSetup() {
        state = 'setup';
        mines = null; revealed = null; revealedCount = 0; currentBet = 0; over = false; forcedOutcome = null;
        cells.forEach(function (c) { c.className = 'mines-cell'; c.textContent = ''; });
        applyState();
        updateReadout();
      }

      /* ---- Ansicht an Zustand anpassen ---- */
      function applyState() {
        startBtn.hidden = state !== 'setup';
        cashBtn.hidden = state !== 'playing';
        newBtn.hidden = state !== 'ended';
        grid.classList.toggle('playing', state === 'playing');
        // Einsatz & Minenzahl nur während laufender Runde sperren.
        betPanel.setDisabled(state === 'playing');
        modeBtns.forEach(function (b) { b.disabled = state === 'playing'; });
      }

      function updateReadout() {
        var m = mineCount, total = safeTotal(), k = revealedCount;
        var betPreview = state === 'playing' ? currentBet : betPanel.getBet();
        var mult = multFor(m, k);
        var payout = Math.round(betPreview * mult);

        multEl.textContent = '×' + fmtMult(mult);
        multEl.classList.toggle('muted', state === 'setup');
        payoutEl.textContent = UI.formatCoins(payout) + ' 🪙';
        progressEl.textContent = k + ' / ' + total + ' sicher';

        if (state === 'playing' && k < total) {
          nextEl.textContent = 'Nächstes Feld: ×' + fmtMult(multFor(m, k + 1));
        } else {
          nextEl.textContent = '';
        }

        if (state === 'playing') {
          cashBtn.disabled = k < 1;
          cashBtn.textContent = k < 1
            ? '💰 Erst ein Feld aufdecken'
            : ('💰 Cashout · ' + UI.formatCoins(payout) + ' 🪙');
          hintEl.textContent = 'Decke sichere Felder auf oder cashe aus. Eine Mine = Einsatz weg.';
        } else if (state === 'setup') {
          hintEl.textContent = m + ' Minen · pro Feld ab ×' + fmtMult(multFor(m, 1))
            + ' · alle ' + total + ' Felder → ×' + fmtMult(multFor(m, total));
        }

        startSub.textContent = 'Einsatz ' + UI.formatCoins(betPreview) + ' 🪙 · ' + m + ' Minen';
      }

      // Startzustand
      applyState();
      updateReadout();

      return {
        cleanup: function () {
          for (var i = 0; i < timers.length; i++) clearTimeout(timers[i]);
          timers = [];
        }
      };
    }
  };
})();
