/* keno.js — "Keno"
 * 80er-Zahlenraster (1–80): Spieler wählt 1–10 Zahlen (Spots),
 * 20 eindeutige Zahlen werden gezogen. Auszahlung = Einsatz × Faktor
 * aus der Paytable (Faktor = BRUTTO-Rückzahlung pro Einsatz, RTP ~94 %).
 */
(function () {
  'use strict';
  window.App = window.App || {};
  App.Games = App.Games || {};
  var UI = App.UI, el = UI.el;

  var COUNT = 80;   // Zahlen 1..80
  var DRAWN = 20;   // gezogene Zahlen pro Runde
  var MAX_SPOTS = 10;

  /* Paytable: PAYTABLE[spots][hits] = Bruttofaktor (nicht gelistet = 0). */
  var PAYTABLE = {
    1:  { 1: 3.6 },
    2:  { 1: 1, 2: 9 },
    3:  { 2: 2, 3: 16 },
    4:  { 2: 1, 3: 4, 4: 22 },
    5:  { 3: 2, 4: 12, 5: 50 },
    6:  { 3: 1, 4: 4, 5: 24, 6: 90 },
    7:  { 4: 2, 5: 10, 6: 45, 7: 150 },
    8:  { 5: 8, 6: 30, 7: 90, 8: 300 },
    9:  { 5: 4, 6: 18, 7: 45, 8: 150, 9: 600 },
    10: { 5: 2, 6: 10, 7: 30, 8: 90, 9: 300, 10: 1000 }
  };
  function factorFor(spots, hits) {
    var row = PAYTABLE[spots];
    return (row && row[hits]) || 0;
  }

  function injectCss() {
    UI.injectStyle('game-keno-css', [
      '.kn-wrap{display:flex;flex-direction:column;gap:16px;}',
      '.kn-stage{gap:14px;}',
      '.kn-readout{display:flex;flex-direction:column;align-items:center;gap:4px;text-align:center;}',
      '.kn-big-label{font-size:12px;letter-spacing:2px;text-transform:uppercase;color:var(--muted);font-weight:700;}',
      '.kn-big{color:var(--neon);text-shadow:0 0 18px rgba(57,255,20,0.5);line-height:1;transition:color .2s;}',
      '.kn-big.muted{color:var(--muted);text-shadow:none;}',
      '.kn-big.win{color:var(--gold);text-shadow:0 0 22px rgba(255,210,63,0.6);}',
      '.kn-payline{display:flex;align-items:center;gap:10px;font-weight:800;font-size:16px;min-height:20px;}',
      '.kn-multi{color:var(--gold);font-variant-numeric:tabular-nums;}',
      '.kn-multi.muted{color:var(--muted);}',
      '.kn-pay-val{color:var(--leaf);font-variant-numeric:tabular-nums;}',
      '.kn-status{color:var(--muted);font-size:13px;min-height:16px;font-weight:700;}',
      '.kn-status.win{color:var(--neon);text-shadow:0 0 12px rgba(57,255,20,0.55);}',
      '.kn-status.lose{color:var(--danger-2);}',
      '.kn-info{display:flex;flex-wrap:wrap;gap:8px 22px;justify-content:center;}',
      '.kn-info-item{text-align:center;}',
      '.kn-info-l{display:block;color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:1px;}',
      '.kn-info-v{font-size:18px;font-weight:900;color:var(--leaf);font-variant-numeric:tabular-nums;}',
      '.kn-info-v.gold{color:var(--gold);}',
      '.kn-info-v.aqua{color:var(--aqua-soft);}',
      '.kn-grid{display:grid;grid-template-columns:repeat(10,1fr);gap:clamp(3px,0.9vw,6px);width:100%;max-width:470px;margin:0 auto;}',
      '.kn-cell{aspect-ratio:1/1;display:grid;place-items:center;border-radius:8px;',
      '  border:1px solid var(--stroke);background:linear-gradient(180deg,rgba(16,54,35,0.85),rgba(8,28,18,0.85));',
      '  color:var(--text);font-weight:800;font-variant-numeric:tabular-nums;font-size:clamp(11px,3.1vw,15px);',
      '  user-select:none;transition:transform .1s,box-shadow .15s,border-color .15s,background .15s;}',
      '.kn-grid.selectable .kn-cell{cursor:pointer;}',
      '.kn-grid.selectable .kn-cell:hover{transform:translateY(-2px);border-color:var(--stroke-2);box-shadow:var(--glow-soft);}',
      '.kn-grid.drawing .kn-cell{cursor:default;}',
      '.kn-cell.sel{border-color:var(--neon);color:#04160c;background:linear-gradient(180deg,var(--neon-soft),var(--neon));box-shadow:var(--glow);}',
      '.kn-cell.drawn{border-color:var(--aqua);color:var(--aqua-soft);',
      '  background:radial-gradient(120% 120% at 50% 0%,rgba(51,230,208,0.25),rgba(8,28,18,0.9));',
      '  box-shadow:0 0 0 2px rgba(51,230,208,0.55),0 0 10px rgba(51,230,208,0.3);}',
      '.kn-cell.hit{border-color:var(--gold);color:#2a1e00;background:linear-gradient(180deg,#ffe27a,var(--gold));',
      '  box-shadow:0 0 0 2px rgba(255,210,63,0.7),0 0 16px rgba(255,210,63,0.6);}',
      '.kn-cell.pop{animation:kn-pop .3s cubic-bezier(.2,.9,.3,1.4);}',
      '@keyframes kn-pop{0%{transform:scale(.55);}60%{transform:scale(1.18);}100%{transform:scale(1);}}',
      '.kn-actions{display:flex;flex-direction:column;gap:10px;min-width:200px;flex:1 1 200px;}',
      '.kn-actions-row{display:flex;gap:10px;}',
      '.kn-actions-row .btn{flex:1;}',
      '.kn-pay{display:flex;flex-wrap:wrap;gap:6px;justify-content:center;margin-top:6px;}',
      '.kn-pay-title{width:100%;text-align:center;font-size:11px;text-transform:uppercase;letter-spacing:1px;color:var(--muted);font-weight:700;margin-bottom:2px;}',
      '.kn-tier{display:flex;flex-direction:column;align-items:center;gap:1px;padding:5px 9px;border-radius:9px;',
      '  border:1px solid var(--stroke);background:rgba(9,32,21,0.6);min-width:44px;line-height:1.1;transition:.15s;}',
      '.kn-tier-h{font-size:11px;color:var(--muted);font-weight:700;}',
      '.kn-tier-m{font-size:13px;color:var(--leaf);font-weight:800;font-variant-numeric:tabular-nums;}',
      '.kn-tier.won{border-color:var(--gold);box-shadow:0 0 14px rgba(255,210,63,0.5);}',
      '.kn-tier.won .kn-tier-h{color:var(--gold);}',
      '.kn-tier.won .kn-tier-m{color:var(--gold);}',
      '@media (max-width:520px){.kn-actions{min-width:100%;}}',
      '@media (prefers-reduced-motion:reduce){.kn-cell.pop{animation:none;}}'
    ].join(''));
  }

  App.Games.keno = {
    id: 'keno',
    title: 'Keno',
    icon: '🔢',
    subtitle: 'Wähle bis zu 10 Zahlen — 20 werden gezogen',

    render: function (root) {
      injectCss();
      var Coins = App.Coins;

      /* ---- Zustand ---- */
      var phase = 'select';        // 'select' | 'drawing' | 'result'
      var selected = {};           // { num: true }
      var drawnSet = {};           // gezogene Zahlen dieser Runde
      var currentBet = 0;
      var timers = [];
      var payTierEls = {};

      function later(fn, ms) {
        var id = setTimeout(function () {
          var i = timers.indexOf(id); if (i >= 0) timers.splice(i, 1);
          fn();
        }, ms);
        timers.push(id);
        return id;
      }
      function spotCount() { return Object.keys(selected).length; }

      /* ---- Readout ---- */
      var bigEl = el('div', { class: 'big-readout kn-big muted' }, ['–']);
      var multiEl = el('span', { class: 'kn-multi muted' }, ['×–']);
      var payValEl = el('span', { class: 'kn-pay-val' }, ['']);
      var statusEl = el('div', { class: 'kn-status' }, ['Wähle 1–10 Zahlen und ziehe.']);

      var gewaehltV = el('div', { class: 'kn-info-v' }, ['0 / 10']);
      var maxMultiV = el('div', { class: 'kn-info-v gold' }, ['×–']);
      var possWinV  = el('div', { class: 'kn-info-v aqua' }, ['–']);
      var infoRow = el('div', { class: 'kn-info' }, [
        el('div', { class: 'kn-info-item' }, [el('span', { class: 'kn-info-l' }, ['Gewählt']), gewaehltV]),
        el('div', { class: 'kn-info-item' }, [el('span', { class: 'kn-info-l' }, ['Max-Multi']), maxMultiV]),
        el('div', { class: 'kn-info-item' }, [el('span', { class: 'kn-info-l' }, ['Möglicher Gewinn']), possWinV])
      ]);

      /* ---- 80er-Raster ---- */
      var cells = [];
      for (var idx = 1; idx <= COUNT; idx++) {
        (function (num) {
          var c = el('button', {
            class: 'kn-cell', type: 'button',
            onclick: function () { onCellClick(num); }
          }, [String(num)]);
          cells.push(c);
        })(idx);
      }
      var grid = el('div', { class: 'kn-grid selectable' }, cells);

      var stage = el('div', { class: 'game-stage kn-stage' }, [
        el('div', { class: 'kn-readout' }, [
          el('div', { class: 'kn-big-label' }, ['Treffer']),
          bigEl,
          el('div', { class: 'kn-payline' }, [multiEl, payValEl]),
          statusEl
        ]),
        infoRow,
        grid
      ]);

      /* ---- Bedienpanel ---- */
      var betPanel = UI.createBetPanel({
        initial: 50,
        onChange: function () { if (phase !== 'drawing') updateCounts(); }
      });

      var randomBtn = el('button', { class: 'btn', type: 'button', onclick: quickPick }, ['🎲 Zufällig']);
      var clearBtn  = el('button', { class: 'btn', type: 'button', onclick: clearSelection }, ['✕ Leeren']);
      var drawMain  = el('span', { class: 'btn-main' }, ['🔢 Ziehen']);
      var drawSub   = el('span', { class: 'btn-sub' }, ['']);
      var drawBtn   = el('button', { class: 'btn btn-primary btn-lg btn-block btn-2l', type: 'button', onclick: doDraw }, [drawMain, drawSub]);
      var actions = el('div', { class: 'kn-actions' }, [
        el('div', { class: 'kn-actions-row' }, [randomBtn, clearBtn]),
        drawBtn
      ]);

      var payWrap = el('div', { class: 'kn-pay' }, []);
      var hintEl = el('p', { class: 'hint-text' }, ['20 Zahlen werden gezogen — je mehr deiner Zahlen dabei sind, desto höher der Faktor.']);

      var panel = el('div', { class: 'glass game-panel' }, [
        el('div', { class: 'controls-row' }, [betPanel.root, actions]),
        payWrap,
        hintEl
      ]);

      root.appendChild(el('div', { class: 'kn-wrap' }, [stage, panel]));

      /* ---- Auswahl-Logik ---- */
      function onCellClick(num) {
        if (phase === 'drawing') return;
        if (phase === 'result') { clearDrawVisuals(); phase = 'select'; }
        var cell = cells[num - 1];
        if (selected[num]) {
          delete selected[num];
          cell.classList.remove('sel');
        } else {
          if (spotCount() >= MAX_SPOTS) { UI.toast('Maximal ' + MAX_SPOTS + ' Zahlen', 'lose'); return; }
          selected[num] = true;
          cell.classList.add('sel');
        }
        resetReadout();
        renderPayTable(spotCount());
        updateCounts();
      }

      function quickPick() {
        if (phase === 'drawing') return;
        clearSelection();
        var pool = [];
        for (var n = 1; n <= COUNT; n++) pool.push(n);
        for (var i = pool.length - 1; i > 0; i--) {
          var j = Math.floor(Math.random() * (i + 1));
          var t = pool[i]; pool[i] = pool[j]; pool[j] = t;
        }
        for (var s = 0; s < MAX_SPOTS; s++) {
          var num = pool[s];
          selected[num] = true;
          cells[num - 1].classList.add('sel');
        }
        renderPayTable(spotCount());
        updateCounts();
      }

      function clearSelection() {
        if (phase === 'drawing') return;
        clearDrawVisuals();
        Object.keys(selected).forEach(function (num) { cells[num - 1].classList.remove('sel'); });
        selected = {};
        phase = 'select';
        resetReadout();
        renderPayTable(0);
        updateCounts();
      }

      function clearDrawVisuals() {
        for (var n = 1; n <= COUNT; n++) cells[n - 1].classList.remove('drawn', 'hit', 'pop');
        drawnSet = {};
        Object.keys(payTierEls).forEach(function (h) { payTierEls[h].classList.remove('won'); });
      }

      function resetReadout() {
        bigEl.className = 'big-readout kn-big muted';
        bigEl.textContent = '–';
        multiEl.className = 'kn-multi muted';
        multiEl.textContent = '×–';
        payValEl.textContent = '';
      }

      /* ---- Ziehung ---- */
      function doDraw() {
        if (phase === 'drawing') return;
        var count = spotCount();
        if (count < 1) { UI.toast('Wähle mindestens 1 Zahl', 'lose'); return; }
        var bet = betPanel.getBet();
        if (!Coins.canBet(bet)) { UI.toast('Nicht genug Coins', 'lose'); return; }

        clearDrawVisuals();
        currentBet = bet;
        Coins.add(-bet);
        phase = 'drawing';
        applyPhase();

        // 20 eindeutige Zahlen ziehen (Fisher-Yates auf 1..80)
        var pool = [];
        for (var n = 1; n <= COUNT; n++) pool.push(n);
        for (var i = pool.length - 1; i > 0; i--) {
          var j = Math.floor(Math.random() * (i + 1));
          var t = pool[i]; pool[i] = pool[j]; pool[j] = t;
        }
        var draw = pool.slice(0, DRAWN);

        // Rigging: Ziehung an das erzwungene Ergebnis anpassen.
        var forced = (App.Rig && App.Rig.outcome) ? App.Rig.outcome() : null;
        if (forced === 'win' || forced === 'lose') {
          var sel = Object.keys(selected).map(Number);
          var others = [];
          for (var m = 1; m <= COUNT; m++) if (!selected[m]) others.push(m);
          for (var a = others.length - 1; a > 0; a--) {
            var bb = Math.floor(Math.random() * (a + 1)); var tt = others[a]; others[a] = others[bb]; others[bb] = tt;
          }
          var forcedDraw;
          if (forced === 'win') {
            // Alle gewählten Zahlen treffen -> maximaler Faktor.
            forcedDraw = sel.slice(0, DRAWN).concat(others.slice(0, Math.max(0, DRAWN - sel.length)));
          } else {
            // Keine gewählte Zahl -> 0 Treffer -> Niete.
            forcedDraw = others.slice(0, DRAWN);
          }
          forcedDraw = forcedDraw.slice(0, DRAWN);
          for (var a2 = forcedDraw.length - 1; a2 > 0; a2--) {
            var b2 = Math.floor(Math.random() * (a2 + 1)); var t2 = forcedDraw[a2]; forcedDraw[a2] = forcedDraw[b2]; forcedDraw[b2] = t2;
          }
          draw = forcedDraw;
        }

        var liveHits = 0;
        bigEl.className = 'big-readout kn-big';
        bigEl.textContent = '0';
        multiEl.className = 'kn-multi muted';
        multiEl.textContent = '×–';
        payValEl.textContent = '';
        statusEl.className = 'kn-status';
        statusEl.textContent = 'Zahlen werden gezogen…';

        draw.forEach(function (num, k) {
          later(function () {
            drawnSet[num] = true;
            var cell = cells[num - 1];
            if (selected[num]) {
              cell.classList.add('hit', 'pop');
              liveHits++;
              bigEl.textContent = String(liveHits);
              if (App.Audio) App.Audio.sfx('coin');           // getroffene Zahl
            } else {
              cell.classList.add('drawn', 'pop');
              if (App.Audio) App.Audio.blip(500 + k * 30, 0.08, { type: 'triangle', peak: 0.06 }); // steigende Tonhöhe
            }
          }, 60 + k * 60);
        });

        later(function () { resolve(count); }, 60 + DRAWN * 60 + 260);
      }

      function resolve(spots) {
        var hits = 0;
        Object.keys(selected).forEach(function (num) { if (drawnSet[num]) hits++; });
        var factor = factorFor(spots, hits);
        var payout = Math.round(currentBet * factor);
        var net = payout - currentBet;

        bigEl.textContent = String(hits);
        if (payout > 0) {
          Coins.add(payout);
          UI.flash(net);
          UI.toast('Gewonnen! ' + hits + ' Treffer · ×' + factor, 'win');
          bigEl.className = 'big-readout kn-big win';
          multiEl.className = 'kn-multi';
          multiEl.textContent = '×' + factor;
          payValEl.textContent = '+' + UI.formatCoins(net) + ' 🪙';
          statusEl.className = 'kn-status win';
          statusEl.textContent = hits + ' von ' + spots + ' getroffen — Auszahlung ' + UI.formatCoins(payout) + ' 🪙';
          if (payTierEls[hits]) payTierEls[hits].classList.add('won');
        } else {
          UI.flash(-currentBet);
          UI.toast('Verloren — ' + hits + ' Treffer', 'lose');
          bigEl.className = 'big-readout kn-big muted';
          multiEl.className = 'kn-multi muted';
          multiEl.textContent = '×0';
          payValEl.textContent = '';
          statusEl.className = 'kn-status lose';
          statusEl.textContent = hits + ' von ' + spots + ' getroffen — kein Gewinn.';
        }

        phase = 'result';
        applyPhase();
        betPanel.refresh();
        Coins.settle();
        updateCounts();
      }

      /* ---- Ansicht / Anzeige ---- */
      function applyPhase() {
        var drawing = phase === 'drawing';
        grid.classList.toggle('selectable', !drawing);
        grid.classList.toggle('drawing', drawing);
        betPanel.setDisabled(drawing);
        randomBtn.disabled = drawing;
        clearBtn.disabled = drawing;
        drawBtn.disabled = drawing || spotCount() < 1;
        drawMain.textContent = phase === 'result' ? '🔁 Nochmal ziehen' : '🔢 Ziehen';
      }

      function updateCounts() {
        var count = spotCount();
        var bet = betPanel.getBet();
        gewaehltV.textContent = count + ' / ' + MAX_SPOTS;
        if (count > 0) {
          var mf = factorFor(count, count);
          maxMultiV.textContent = '×' + mf;
          possWinV.textContent = '+' + UI.formatCoins(Math.round(bet * mf) - bet) + ' 🪙';
          drawSub.textContent = 'Einsatz ' + UI.formatCoins(bet) + ' 🪙 · bis ×' + mf;
        } else {
          maxMultiV.textContent = '×–';
          possWinV.textContent = '–';
          drawSub.textContent = 'Einsatz ' + UI.formatCoins(bet) + ' 🪙';
        }
        drawBtn.disabled = phase === 'drawing' || count < 1;
        if (phase === 'select') {
          statusEl.className = 'kn-status';
          statusEl.textContent = count < 1
            ? 'Wähle 1–10 Zahlen und ziehe.'
            : count + ' Zahl' + (count > 1 ? 'en' : '') + ' gewählt · ' + DRAWN + ' werden gezogen.';
        }
      }

      function renderPayTable(count) {
        payWrap.innerHTML = '';
        payTierEls = {};
        payWrap.appendChild(el('div', { class: 'kn-pay-title' }, [
          count > 0 ? ('Gewinntabelle · ' + count + ' Zahl' + (count > 1 ? 'en' : '')) : 'Wähle 1–10 Zahlen'
        ]));
        if (count > 0) {
          var row = PAYTABLE[count];
          Object.keys(row).map(Number).sort(function (a, b) { return a - b; }).forEach(function (h) {
            var tier = el('div', { class: 'kn-tier' }, [
              el('span', { class: 'kn-tier-h' }, [h + ' Tr.']),
              el('span', { class: 'kn-tier-m' }, ['×' + row[h]])
            ]);
            payTierEls[h] = tier;
            payWrap.appendChild(tier);
          });
        }
      }

      /* ---- Start ---- */
      renderPayTable(0);
      updateCounts();
      applyPhase();

      return {
        cleanup: function () {
          for (var i = 0; i < timers.length; i++) clearTimeout(timers[i]);
          timers = [];
        }
      };
    }
  };
})();
