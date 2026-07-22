/* roulette.js — Europäisches Roulette (einzelne grüne 0 = House-Edge 2,70 %).
 *
 * Ein Wett-Typ pro Spin. Auszahlung ist immer BRUTTO (inkl. Einsatz):
 *   Rot/Schwarz, Gerade/Ungerade, 1–18/19–36 ...... 1:1  -> bet*2
 *   Dutzend (1–12 / 13–24 / 25–36) ................. 2:1  -> bet*3
 *   Einzelne Zahl (0–36) ........................... 35:1 -> bet*36
 * Die 0 gewinnt nur bei der passenden Einzelzahl-Wette; alle einfachen
 * Chancen (Rot/Schwarz/Gerade/... ) verlieren bei 0 -> daher der House-Edge.
 */
(function () {
  'use strict';
  window.App = window.App || {}; App.Games = App.Games || {};

  var UI = App.UI, el = UI.el;

  // Reihenfolge der Zahlen auf einem echten europäischen Rad (im Uhrzeigersinn, ab 0).
  var WHEEL_ORDER = [
    0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23,
    10, 5, 24, 16, 33, 1, 20, 14, 31, 9, 22, 18, 29, 7, 28, 12, 35, 3, 26
  ];
  var N = WHEEL_ORDER.length;                 // 37
  var SEG = 360 / N;                          // Grad je Segment
  var ORDER_INDEX = {};                       // Zahl -> Position im Rad
  WHEEL_ORDER.forEach(function (n, i) { ORDER_INDEX[n] = i; });

  var RED = {};
  [1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]
    .forEach(function (n) { RED[n] = true; });

  function isRed(n)   { return !!RED[n]; }
  function isBlack(n) { return n !== 0 && !RED[n]; }
  function colorClass(n) { return n === 0 ? 'rl-green' : (isRed(n) ? 'rl-red' : 'rl-black'); }
  function colorWord(n)  { return n === 0 ? 'Grün' : (isRed(n) ? 'Rot' : 'Schwarz'); }

  App.Games.roulette = {
    id: 'roulette',
    title: 'Roulette',
    icon: '🎡',
    subtitle: 'Europäisch — Rot/Schwarz, Zahlen, Dutzende',

    render: function (root) {
      injectCSS();

      /* ---------------- Zustand ---------------- */
      var spinning = false;
      var spinTimer = null;
      var tickTimers = [];          // Kugel-Ticks (werden langsamer)
      function clearTicks() { tickTimers.forEach(function (id) { clearTimeout(id); }); tickTimers = []; }
      var rotation = 0;              // aktueller Rad-Drehwinkel (wächst monoton)
      var selected = null;          // gewählte Wette
      var selEls = [];              // alle anklickbaren Wett-Elemente
      var history = [];             // letzte Gewinnzahlen

      /* ---------------- Rad + Zeiger ---------------- */
      var wheel = el('div', { class: 'rl-wheel' });
      wheel.style.background = buildWheelGradient();
      // Zahlen-Labels rund ums Rad (drehen mit)
      WHEEL_ORDER.forEach(function (n, i) {
        var deg = i * SEG;
        var lab = el('span', { class: 'rl-num ' + colorClass(n), text: String(n) });
        lab.style.transform =
          'translate(-50%,-50%) rotate(' + deg + 'deg) translateY(calc(-1 * var(--r))) rotate(' + (-deg) + 'deg)';
        wheel.appendChild(lab);
      });
      wheel.appendChild(el('div', { class: 'rl-hub' }, ['🎡']));

      var wheelWrap = el('div', { class: 'rl-wheel-wrap' }, [
        el('div', { class: 'rl-pointer' }),
        wheel
      ]);

      /* ---------------- Ergebnis-Anzeige ---------------- */
      var resultBadge = el('div', { class: 'rl-result-badge rl-green', text: '–' });
      var resultText  = el('div', { class: 'rl-result-text hint-text', text: 'Wähle eine Wette und drehe.' });
      var resultBox   = el('div', { class: 'rl-result' }, [resultBadge, resultText]);

      /* ---------------- Historie ---------------- */
      var historyRow = el('div', { class: 'rl-history' });
      renderHistory();

      var stage = el('div', { class: 'game-stage rl-stage' }, [
        wheelWrap, resultBox, historyRow
      ]);

      /* ---------------- Wettfeld (Zahlen-Raster) ---------------- */
      function pickBet(bet, node) {
        if (spinning) return;
        selected = bet;
        selEls.forEach(function (x) { x.classList.remove('sel'); });
        node.classList.add('sel');
        updateBetLabel();
      }
      function mkBet(label, node, bet) {
        bet.label = label;
        node.addEventListener('click', function () { pickBet(bet, node); });
        selEls.push(node);
        return node;
      }

      // Grid: 0 (links, 3 Reihen hoch) + 12 Spalten × 3 Reihen (Zahlen 1–36)
      var grid = el('div', { class: 'rl-grid' });

      var zeroCell = el('button', {
        class: 'rl-cell rl-green rl-zero', type: 'button', text: '0'
      });
      zeroCell.style.gridArea = '1 / 1 / 4 / 2';
      grid.appendChild(mkBet('Zahl 0', zeroCell,
        { kind: 'straight', mult: 36, match: function (w) { return w === 0; } }));

      for (var c = 0; c < 12; c++) {
        for (var r = 0; r < 3; r++) {
          var num = 3 * c + (3 - r);   // r0->3.. top, r2->1 bottom
          var cell = el('button', {
            class: 'rl-cell ' + colorClass(num), type: 'button', text: String(num)
          });
          cell.style.gridArea = (r + 1) + ' / ' + (c + 2) + ' / ' + (r + 2) + ' / ' + (c + 3);
          (function (nn) {
            grid.appendChild(mkBet('Zahl ' + nn, cell,
              { kind: 'straight', mult: 36, match: function (w) { return w === nn; } }));
          })(num);
        }
      }

      // Dutzend-Reihe (unter den Zahlen)
      var dozens = el('div', { class: 'rl-dozens' }, [
        el('div', { class: 'rl-doz-spacer' }),
        mkBet('1. Dutzend', el('button', { class: 'rl-cell rl-outside', type: 'button', text: '1–12 · 2:1' }),
          { kind: 'dozen', mult: 3, match: function (w) { return w >= 1 && w <= 12; } }),
        mkBet('2. Dutzend', el('button', { class: 'rl-cell rl-outside', type: 'button', text: '13–24 · 2:1' }),
          { kind: 'dozen', mult: 3, match: function (w) { return w >= 13 && w <= 24; } }),
        mkBet('3. Dutzend', el('button', { class: 'rl-cell rl-outside', type: 'button', text: '25–36 · 2:1' }),
          { kind: 'dozen', mult: 3, match: function (w) { return w >= 25 && w <= 36; } })
      ]);

      // Einfache Chancen (1:1)
      var evens = el('div', { class: 'rl-evens' }, [
        mkBet('1–18 (Tief)', el('button', { class: 'rl-cell rl-outside', type: 'button', text: '1–18' }),
          { kind: 'low', mult: 2, match: function (w) { return w >= 1 && w <= 18; } }),
        mkBet('Gerade', el('button', { class: 'rl-cell rl-outside', type: 'button', text: 'GERADE' }),
          { kind: 'even', mult: 2, match: function (w) { return w !== 0 && w % 2 === 0; } }),
        mkBet('Rot', el('button', { class: 'rl-cell rl-red rl-swatch', type: 'button', text: 'ROT' }),
          { kind: 'red', mult: 2, match: function (w) { return isRed(w); } }),
        mkBet('Schwarz', el('button', { class: 'rl-cell rl-black rl-swatch', type: 'button', text: 'SCHWARZ' }),
          { kind: 'black', mult: 2, match: function (w) { return isBlack(w); } }),
        mkBet('Ungerade', el('button', { class: 'rl-cell rl-outside', type: 'button', text: 'UNGERADE' }),
          { kind: 'odd', mult: 2, match: function (w) { return w % 2 === 1; } }),
        mkBet('19–36 (Hoch)', el('button', { class: 'rl-cell rl-outside', type: 'button', text: '19–36' }),
          { kind: 'high', mult: 2, match: function (w) { return w >= 19 && w <= 36; } })
      ]);

      var tableScroll = el('div', { class: 'rl-table-scroll' }, [
        el('div', { class: 'rl-table' }, [grid, dozens])
      ]);

      var betField = el('div', { class: 'game-panel glass rl-betfield' }, [
        el('div', { class: 'rl-field-title' }, ['Wettfeld – wähle EINE Wette']),
        tableScroll,
        evens
      ]);

      /* ---------------- Einsatz + Drehen ---------------- */
      var betPanel = UI.createBetPanel({ initial: 50, onChange: updateSpinSub });

      var betLabelEl = el('span', { class: 'rl-cur-bet', text: 'keine' });
      var currentBet = el('div', { class: 'rl-cur' }, [
        el('span', { class: 'rl-cur-l' }, ['Gewählt:']), betLabelEl
      ]);

      var spinSubTxt = el('span', {}, ['']);
      var spinSubWin = el('span', { class: 'bs-win' }, ['']);
      var spinBtn = el('button', {
        class: 'btn btn-primary btn-lg rl-spin btn-2l', type: 'button', onclick: doSpin
      }, [
        el('span', { class: 'btn-main' }, ['🎡 Drehen']),
        el('span', { class: 'btn-sub' }, [spinSubTxt, spinSubWin])
      ]);

      function updateSpinSub() {
        var bet = betPanel.getBet();
        if (!selected) {
          spinSubTxt.textContent = 'Einsatz ' + UI.formatCoins(bet) + ' 🪙 · Wette wählen';
          spinSubWin.textContent = '';
          return;
        }
        spinSubTxt.textContent = (selected.mult - 1) + ':1 · Einsatz ' + UI.formatCoins(bet) + ' 🪙 · ';
        spinSubWin.textContent = '+' + UI.formatCoins(bet * selected.mult - bet);
      }

      var controls = el('div', { class: 'game-panel glass rl-controls' }, [
        el('div', { class: 'controls-row' }, [betPanel.root, spinBtn]),
        currentBet
      ]);

      /* ---------------- Auszahlungs-Tabelle ---------------- */
      var payTable = el('table', { class: 'payout-table rl-pay' }, [
        el('tbody', {}, [
          payRow('Rot / Schwarz · Gerade / Ungerade · 1–18 / 19–36', '1:1'),
          payRow('Dutzend (1–12 · 13–24 · 25–36)', '2:1'),
          payRow('Einzelne Zahl (0–36)', '35:1')
        ])
      ]);
      var payBox = el('div', { class: 'game-panel glass rl-paybox' }, [
        el('div', { class: 'rl-field-title' }, ['Auszahlungen']),
        payTable,
        el('p', { class: 'hint-text' }, ['Europäisches Rad · eine grüne 0 · House-Edge 2,70 %'])
      ]);

      root.appendChild(el('div', { class: 'rl-wrap' }, [
        stage, betField, controls, payBox
      ]));

      // Standard-Wette (Rot) vorwählen, damit man ohne Umweg sofort drehen kann.
      (function () {
        var r = selEls.filter(function (n) { return n.textContent === 'ROT'; })[0];
        if (r) r.click();
      })();

      /* ---------------- Ablauf ---------------- */
      function updateBetLabel() {
        if (!selected) {
          betLabelEl.textContent = 'keine'; betLabelEl.className = 'rl-cur-bet';
          updateSpinSub();
          return;
        }
        betLabelEl.textContent = selected.label + '  (' + (selected.mult - 1) + ':1)';
        betLabelEl.className = 'rl-cur-bet on';
        updateSpinSub();
      }

      function setLocked(lock) {
        spinning = lock;
        spinBtn.disabled = lock;
        betPanel.setDisabled(lock);
        betField.classList.toggle('locked', lock);
        evens.classList.toggle('locked', lock);
      }

      function doSpin() {
        if (spinning) return;
        if (!selected) { UI.toast('Wähle zuerst eine Wette', 'info'); return; }
        var bet = betPanel.getBet();
        if (!App.Coins.canBet(bet)) { UI.toast('Nicht genug Coins', 'lose'); return; }

        setLocked(true);
        App.Coins.add(-bet);
        resultText.textContent = 'Das Rad dreht …';

        // Gewinnzahl gleichverteilt 0–36 (die 0 sorgt für den House-Edge).
        var winNum = Math.floor(Math.random() * N);
        var forced = (App.Rig && App.Rig.outcome) ? App.Rig.outcome() : null;
        if (forced) {
          var wins = [], loses = [], k;
          for (k = 0; k < N; k++) { (selected.match(k) ? wins : loses).push(k); }
          var pool = (forced === 'win') ? wins : loses;
          if (pool.length) winNum = pool[Math.floor(Math.random() * pool.length)];
        }
        var idx = ORDER_INDEX[winNum];

        // Rad so drehen, dass die Gewinnzahl oben unter dem Zeiger landet.
        var desired = ((360 - idx * SEG) % 360 + 360) % 360;
        var curMod  = ((rotation % 360) + 360) % 360;
        var delta   = ((desired - curMod) % 360 + 360) % 360;
        var turns   = 4 + Math.floor(Math.random() * 3);           // 4–6 volle Runden
        var jitter  = (Math.random() - 0.5) * SEG * 0.55;          // bleibt im Segment
        rotation += turns * 360 + delta + jitter;

        wheel.style.transition = 'transform 2.8s cubic-bezier(.15,.82,.24,1)';
        wheel.style.transform = 'rotate(' + rotation + 'deg)';

        // Kugel-Ticks, die synchron zum abbremsenden Rad langsamer werden.
        clearTicks();
        if (App.Audio) {
          var tt = 0, gap = 55;
          while (tt < 2760) {
            tickTimers.push(setTimeout(function () { App.Audio.sfx('tick'); }, tt));
            tt += gap; gap *= 1.13;
          }
        }

        spinTimer = setTimeout(function () { finish(winNum, bet); }, 2950);
      }

      function finish(winNum, bet) {
        spinTimer = null;
        clearTicks();
        if (App.Audio) App.Audio.sfx('ding');   // Kugel rastet im Fach ein
        var won = selected.match(winNum);
        var payout = won ? bet * selected.mult : 0;

        resultBadge.textContent = String(winNum);
        resultBadge.className = 'rl-result-badge ' + colorClass(winNum) + ' pop';

        history.unshift(winNum);
        if (history.length > 10) history.pop();
        renderHistory();

        if (won) {
          App.Coins.add(payout);
          UI.flash(payout - bet);
          UI.toast('Gewonnen! ' + winNum + ' ' + colorWord(winNum), 'win');
          resultText.innerHTML = '<b class="rl-won">GEWONNEN</b> · ' + winNum + ' (' + colorWord(winNum)
            + ') · +' + UI.formatCoins(payout - bet) + ' 🪙';
        } else {
          UI.flash(-bet);
          UI.toast('Verloren — ' + winNum + ' ' + colorWord(winNum), 'lose');
          resultText.innerHTML = '<b class="rl-lost">VERLOREN</b> · ' + winNum + ' (' + colorWord(winNum) + ')';
        }

        setLocked(false);
        betPanel.refresh();
        App.Coins.settle();
      }

      function renderHistory() {
        historyRow.textContent = '';
        historyRow.appendChild(el('span', { class: 'rl-hist-l' }, ['Letzte:']));
        if (!history.length) {
          historyRow.appendChild(el('span', { class: 'rl-hist-empty' }, ['—']));
          return;
        }
        history.forEach(function (n) {
          historyRow.appendChild(el('span', { class: 'rl-chip ' + colorClass(n), text: String(n) }));
        });
      }

      return {
        cleanup: function () {
          if (spinTimer) { clearTimeout(spinTimer); spinTimer = null; }
          clearTicks();
          spinning = false;
        }
      };
    }
  };

  /* ---------------- Helfer ---------------- */
  function payRow(what, odds) {
    return el('tr', {}, [
      el('td', {}, [what]),
      el('td', { class: 'rl-odds' }, [odds])
    ]);
  }

  function buildWheelGradient() {
    var stops = [];
    for (var i = 0; i < N; i++) {
      var n = WHEEL_ORDER[i];
      var col = n === 0 ? '#159947' : (RED[n] ? '#c81d3c' : '#181a15');
      stops.push(col + ' ' + (i * SEG).toFixed(3) + 'deg ' + ((i + 1) * SEG).toFixed(3) + 'deg');
    }
    return 'conic-gradient(from ' + (-SEG / 2).toFixed(3) + 'deg, ' + stops.join(', ') + ')';
  }

  function injectCSS() {
    UI.injectStyle('game-roulette-css', [
      '.rl-wrap{display:flex;flex-direction:column;gap:16px;}',
      '.rl-stage{gap:16px;}',

      /* Rad */
      '.rl-wheel-wrap{position:relative;display:flex;align-items:center;justify-content:center;padding-top:14px;}',
      '.rl-wheel{--size:clamp(190px,54vw,250px);--r:calc(var(--size)/2 - 22px);',
      'position:relative;width:var(--size);height:var(--size);border-radius:50%;',
      'box-shadow:0 0 0 8px #06170f,0 0 0 11px rgba(57,255,20,.35),inset 0 0 26px rgba(0,0,0,.6),0 12px 34px rgba(0,0,0,.5);',
      'transition:transform 2.8s cubic-bezier(.15,.82,.24,1);will-change:transform;}',
      '.rl-num{position:absolute;left:50%;top:50%;transform-origin:50% 50%;font-size:11px;font-weight:800;',
      'color:#fff;text-shadow:0 1px 2px rgba(0,0,0,.85);font-variant-numeric:tabular-nums;pointer-events:none;line-height:1;}',
      '.rl-num.rl-green{color:#eafff0;}',
      '.rl-hub{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:34%;height:34%;border-radius:50%;',
      'display:grid;place-items:center;font-size:clamp(20px,7vw,30px);',
      'background:radial-gradient(circle at 40% 35%,#0e3521,#04120b);border:2px solid rgba(57,255,20,.5);',
      'box-shadow:inset 0 0 16px rgba(0,0,0,.7),0 0 14px rgba(57,255,20,.3);}',
      /* Zeiger */
      '.rl-pointer{position:absolute;top:0;left:50%;transform:translateX(-50%);z-index:5;',
      'width:0;height:0;border-left:13px solid transparent;border-right:13px solid transparent;',
      'border-top:22px solid var(--gold);filter:drop-shadow(0 2px 5px rgba(0,0,0,.6)) drop-shadow(0 0 8px rgba(255,210,63,.6));}',

      /* Ergebnis */
      '.rl-result{display:flex;align-items:center;gap:12px;flex-wrap:wrap;justify-content:center;}',
      '.rl-result-badge{min-width:52px;height:52px;padding:0 10px;border-radius:14px;display:grid;place-items:center;',
      'font-size:26px;font-weight:900;color:#fff;text-shadow:0 1px 3px rgba(0,0,0,.7);border:2px solid rgba(255,255,255,.18);}',
      '.rl-result-badge.pop{animation:rl-pop .45s ease;}',
      '@keyframes rl-pop{0%{transform:scale(.4);opacity:0}60%{transform:scale(1.15)}100%{transform:scale(1)}}',
      '.rl-result-text{margin:0;}',
      '.rl-won{color:var(--neon);} .rl-lost{color:var(--danger-2);}',

      /* Historie */
      '.rl-history{display:flex;align-items:center;gap:6px;flex-wrap:wrap;justify-content:center;}',
      '.rl-hist-l{color:var(--muted);font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:1px;}',
      '.rl-hist-empty{color:var(--muted);}',
      '.rl-chip{min-width:26px;height:26px;padding:0 5px;border-radius:8px;display:grid;place-items:center;',
      'font-size:13px;font-weight:800;color:#fff;border:1px solid rgba(255,255,255,.18);}',

      /* Farben */
      '.rl-red{background:linear-gradient(180deg,#e0344c,#b31734);}',
      '.rl-black{background:linear-gradient(180deg,#26281f,#111309);}',
      '.rl-green{background:linear-gradient(180deg,#1caa52,#0e7b3a);}',
      '.rl-result-badge.rl-black,.rl-chip.rl-black{color:#eafff0;}',

      /* Wettfeld */
      '.rl-betfield{display:flex;flex-direction:column;gap:12px;}',
      '.rl-field-title{font-size:13px;font-weight:800;color:var(--leaf);text-transform:uppercase;letter-spacing:1px;}',
      '.rl-table-scroll{overflow-x:auto;-webkit-overflow-scrolling:touch;padding-bottom:4px;}',
      '.rl-table{min-width:420px;display:flex;flex-direction:column;gap:6px;}',
      '.rl-grid{display:grid;grid-template-columns:44px repeat(12,1fr);grid-template-rows:repeat(3,40px);gap:5px;}',
      '.rl-dozens{display:grid;grid-template-columns:44px repeat(3,1fr);gap:5px;}',
      '.rl-doz-spacer{grid-column:1;}',
      '.rl-evens{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;}',
      '@media(min-width:560px){.rl-evens{grid-template-columns:repeat(6,1fr);}}',

      '.rl-cell{cursor:pointer;font-family:inherit;font-weight:800;color:#fff;font-size:14px;',
      'border-radius:9px;border:1px solid rgba(255,255,255,.14);padding:8px 6px;',
      'display:grid;place-items:center;transition:transform .1s,box-shadow .15s,filter .15s;',
      'text-shadow:0 1px 2px rgba(0,0,0,.6);min-height:40px;}',
      '.rl-zero{font-size:18px;}',
      '.rl-outside{background:rgba(9,32,21,.85);color:var(--text);font-size:13px;letter-spacing:.3px;}',
      '.rl-swatch{}',
      '.rl-cell:hover{transform:translateY(-1px);filter:brightness(1.12);box-shadow:0 4px 12px rgba(0,0,0,.4);}',
      '.rl-cell.sel{outline:3px solid var(--gold);outline-offset:1px;box-shadow:0 0 16px rgba(255,210,63,.7);z-index:2;transform:translateY(-1px);}',

      '.rl-cur{margin-top:2px;font-size:14px;color:var(--muted);}',
      '.rl-cur-l{font-weight:700;margin-right:6px;}',
      '.rl-cur-bet{font-weight:800;color:var(--muted);}',
      '.rl-cur-bet.on{color:var(--gold);}',
      '.rl-controls{display:flex;flex-direction:column;gap:12px;}',
      '.rl-spin{min-width:150px;}',
      '.rl-odds{color:var(--gold);font-weight:800;text-align:right;white-space:nowrap;}',

      '.locked .rl-cell{pointer-events:none;opacity:.75;}',
      '.rl-betfield.locked .rl-field-title{opacity:.7;}'
    ].join(''));
  }
})();
