/* slots.js — "Dschungel-Slots": 3 Walzen, gewichtete Symbole, Jackpot.
 *
 * RTP-Auslegung (rein rechnerisch, jede Walze unabhaengig gezogen):
 *   Symbol   Gewicht  p       3-gleich (p^3)  Auszahlung  Beitrag
 *   🌿 leaf     77    0.770   0.45653          2x         0.9131
 *   🍌 banana   10    0.100   0.00100          4x         0.0040
 *   🥥 coconut   5    0.050   0.000125         6x         0.0008
 *   🐒 monkey    4    0.040   0.000064        10x         0.0006
 *   💎 diamond   3    0.030   0.000027        20x         0.0005
 *   🐍 snake     1    0.010   0.000001        40x         0.0000
 *   + genau 2x 🐍 (egal wo): 3*p^2*(1-p)=0.000294          2x   0.0006
 *   ------------------------------------------------------------------
 *   RTP ≈ 0.9196  ->  House-Edge ≈ 8.04 %
 */
(function () {
  'use strict';
  window.App = window.App || {};
  App.Games = App.Games || {};

  var UI = App.UI, el = UI.el;

  // Symbole: absteigende Gewichtung (haeufig -> selten), aufsteigende Auszahlung.
  var SYMBOLS = [
    { id: 'leaf',    emoji: '🌿', name: 'Blatt',   weight: 77, mult3: 2 },
    { id: 'banana',  emoji: '🍌', name: 'Banane',  weight: 10, mult3: 4 },
    { id: 'coconut', emoji: '🥥', name: 'Kokos',   weight: 5,  mult3: 6 },
    { id: 'monkey',  emoji: '🐒', name: 'Affe',    weight: 4,  mult3: 10 },
    { id: 'diamond', emoji: '💎', name: 'Diamant', weight: 3,  mult3: 20 },
    { id: 'snake',   emoji: '🐍', name: 'Schlange',weight: 1,  mult3: 40 }
  ];
  var SNAKE2_MULT = 2; // genau zwei Schlangen irgendwo
  var TOTAL_WEIGHT = SYMBOLS.reduce(function (s, x) { return s + x.weight; }, 0);
  var byId = {};
  SYMBOLS.forEach(function (s) { byId[s.id] = s; });

  // Gewichtete Ziehung EINER Walze via Math.random().
  function drawSymbol() {
    var r = Math.random() * TOTAL_WEIGHT;
    for (var i = 0; i < SYMBOLS.length; i++) {
      r -= SYMBOLS[i].weight;
      if (r < 0) return SYMBOLS[i];
    }
    return SYMBOLS[SYMBOLS.length - 1];
  }
  function randomEmoji() {
    return SYMBOLS[(Math.random() * SYMBOLS.length) | 0].emoji;
  }

  App.Games.slots = {
    id: 'slots', title: 'Slots', icon: '🎰', subtitle: '3 Walzen, Dschungel-Symbole, Jackpot',

    render: function (root) {
      injectCss();

      /* ---------- Zustand ---------- */
      var timers = [];           // alle setTimeout-IDs (cleanup!)
      var spinning = false;
      var destroyed = false;
      // pro Walze die aktuell sichtbaren 3 Emojis [oben, mitte, unten]
      var visible = [null, null, null];

      function later(fn, ms) {
        var id = setTimeout(function () {
          if (destroyed) return;
          var k = timers.indexOf(id);
          if (k >= 0) timers.splice(k, 1);
          fn();
        }, ms);
        timers.push(id);
        return id;
      }

      /* ---------- DOM ---------- */
      var readout = el('div', { class: 'big-readout slots-readout' }, ['Bereit']);

      var reelEls = [];
      var stripEls = [];
      var reelsRow = el('div', { class: 'slots-reels' });
      for (var i = 0; i < 3; i++) {
        var strip = el('div', { class: 'slots-strip' });
        var reel = el('div', { class: 'slots-reel' }, [
          strip,
          el('div', { class: 'slots-payline' })
        ]);
        stripEls.push(strip);
        reelEls.push(reel);
        reelsRow.appendChild(reel);
      }

      var stage = el('div', { class: 'game-stage slots-stage' }, [readout, reelsRow]);

      var betPanel = UI.createBetPanel({ initial: 50 });
      var spinBtn = el('button', {
        class: 'btn btn-primary btn-lg slots-spin', type: 'button', onclick: onSpin
      }, ['🎰 Drehen']);

      var controls = el('div', { class: 'controls-row slots-controls' }, [
        betPanel.root, spinBtn
      ]);

      var hint = el('p', { class: 'hint-text' }, [
        'Drei gleiche Symbole zahlen aus. RTP ≈ 92 % (House-Edge ≈ 8 %).'
      ]);

      // Sichtbare Gewinntabelle
      var payoutCard = el('div', { class: 'glass slots-paycard' }, [
        el('div', { class: 'slots-paytitle neon' }, ['💰 Gewinntabelle (× Einsatz)']),
        buildPayoutTable()
      ]);

      root.appendChild(el('div', { class: 'slots-wrap' }, [
        stage, controls, hint, payoutCard
      ]));

      /* ---------- Walzen initial fuellen (statisch) ---------- */
      for (var r = 0; r < 3; r++) fillReel(r, null);

      /* ---------- Walze bauen ----------
       * Baut einen Streifen mit N Zellen. Der Zielwert liegt auf idxTarget,
       * sodass er nach dem Scrollen in der Mittel-Reihe (Payline) landet.
       * seedTop: falls gesetzt, die obersten 3 Zellen = zuletzt sichtbare
       * Symbole -> nahtloser Start ohne "Springen".
       */
      var STRIP_N = 30;
      var IDX_TARGET = STRIP_N - 4; // Zielsymbol; darunter bleiben Zellen fuer Overshoot

      function fillReel(reelIdx, targetSym) {
        var strip = stripEls[reelIdx];
        strip.style.transition = 'none';
        strip.style.transform = 'translateY(0)';
        strip.innerHTML = '';

        var seedTop = visible[reelIdx]; // [oben,mitte,unten] oder null
        var cells = [];
        for (var k = 0; k < STRIP_N; k++) {
          var emo;
          if (seedTop && k < 3 && seedTop[k]) emo = seedTop[k];
          else if (targetSym && k === IDX_TARGET) emo = targetSym.emoji;
          else emo = randomEmoji();
          cells.push(emo);
          strip.appendChild(el('div', { class: 'slots-cell' }, [emo]));
        }

        if (targetSym) {
          // Was am Ende (Payline = Mitte) sichtbar sein wird:
          visible[reelIdx] = [cells[IDX_TARGET - 1], cells[IDX_TARGET], cells[IDX_TARGET + 1]];
        } else if (!seedTop) {
          // Statischer Erststand: sichtbar sind die obersten 3 Zellen.
          visible[reelIdx] = [cells[0], cells[1], cells[2]];
        }
      }

      /* ---------- Dreh-Ablauf ---------- */
      function setBusy(b) {
        spinBtn.disabled = b;
        betPanel.setDisabled(b);
      }

      function onSpin() {
        if (spinning || destroyed) return;

        var bet = betPanel.getBet();
        if (!App.Coins.canBet(bet)) {
          UI.toast('Nicht genug Coins für diesen Einsatz', 'lose');
          return;
        }

        spinning = true;
        setBusy(true);
        App.Coins.add(-bet); // Einsatz abziehen

        // vorherige Gewinn-Hervorhebung entfernen
        reelEls.forEach(function (re) { re.classList.remove('reel-win', 'reel-landed'); });
        readout.className = 'big-readout slots-readout spinning';
        readout.textContent = 'Dreht …';

        // Ergebnis vorab unabhaengig ziehen
        var targets = [drawSymbol(), drawSymbol(), drawSymbol()];

        // Streifen bauen (mit nahtlosem Seed)
        for (var i = 0; i < 3; i++) fillReel(i, targets[i]);

        // Zellhoehe real messen -> robust bei responsivem Layout
        var firstCell = stripEls[0].firstChild;
        var cellH = firstCell ? firstCell.getBoundingClientRect().height : 88;
        if (!cellH) cellH = 88;
        var finalOffset = (IDX_TARGET - 1) * cellH;

        // Walzen nacheinander stoppen: 1 zuerst, dann 2, dann 3.
        var durations = [900, 1150, 1400];
        var ease = 'cubic-bezier(0.16, 0.84, 0.20, 1)';

        for (var w = 0; w < 3; w++) {
          (function (idx) {
            var strip = stripEls[idx];
            // Startzustand (0) sicher committen
            strip.style.transition = 'none';
            strip.style.transform = 'translateY(0)';
            void strip.offsetHeight; // Reflow erzwingen
            // Roll starten
            strip.style.transition = 'transform ' + durations[idx] + 'ms ' + ease;
            strip.style.transform = 'translateY(' + (-finalOffset) + 'px)';
            // Landungs-Bounce dieser Walze
            later(function () { reelEls[idx].classList.add('reel-landed'); }, durations[idx]);
          })(w);
        }

        // Auswertung, nachdem die letzte Walze steht
        later(function () { evaluate(targets, bet); }, durations[2] + 140);
      }

      function evaluate(targets, bet) {
        var a = targets[0], b = targets[1], c = targets[2];
        var multiplier = 0, kind = 'lose', highlight = [];

        if (a.id === b.id && b.id === c.id) {
          multiplier = a.mult3;
          kind = (a.id === 'snake') ? 'jackpot' : 'three';
          highlight = [0, 1, 2];
        } else {
          var snakeIdx = [];
          targets.forEach(function (s, i) { if (s.id === 'snake') snakeIdx.push(i); });
          if (snakeIdx.length === 2) {
            multiplier = SNAKE2_MULT;
            kind = 'two';
            highlight = snakeIdx;
          }
        }

        var payout = Math.round(bet * multiplier);

        if (payout > 0) {
          App.Coins.add(payout);                 // Bruttoauszahlung inkl. Einsatz
          UI.flash(payout - bet);                // Netto-Gewinn
          highlight.forEach(function (idx) {
            reelEls[idx].classList.remove('reel-landed'); // Pop-Animation freigeben
            reelEls[idx].classList.add('reel-win');       // -> Dauer-Glow greift
          });

          if (kind === 'jackpot') {
            readout.className = 'big-readout slots-readout jackpot';
            readout.textContent = '🐍 JACKPOT ×' + multiplier + '! 🐍';
            UI.toast('JACKPOT! ×' + multiplier + ' — ' + UI.formatCoins(payout - bet) + ' 🪙', 'win');
          } else if (kind === 'three') {
            readout.className = 'big-readout slots-readout win';
            readout.textContent = a.emoji + a.emoji + a.emoji + '  ×' + multiplier;
            UI.toast('Gewinn ×' + multiplier + '!', 'win');
          } else { // two snakes
            readout.className = 'big-readout slots-readout win';
            readout.textContent = '🐍🐍 Zwei Schlangen  ×' + multiplier;
            UI.toast('Zwei Schlangen — ×' + multiplier, 'win');
          }
        } else {
          UI.flash(-bet);                        // Totalverlust des Einsatzes
          readout.className = 'big-readout slots-readout lose';
          readout.textContent = a.emoji + b.emoji + c.emoji + '  —  kein Gewinn';
        }

        // Runde abschliessen
        betPanel.refresh();
        App.Coins.settle();

        spinning = false;
        setBusy(false);
      }

      /* ---------- cleanup: ALLE Timer stoppen ---------- */
      return {
        cleanup: function () {
          destroyed = true;
          spinning = false;
          for (var i = 0; i < timers.length; i++) clearTimeout(timers[i]);
          timers.length = 0;
          // CSS-Transitions sterben mit dem entfernten DOM-Knoten.
        }
      };
    }
  };

  /* ---------- Gewinntabelle (DOM) ---------- */
  function buildPayoutTable() {
    var rows = [];
    // 3-gleich, hoechste zuerst
    SYMBOLS.slice().sort(function (x, y) { return y.mult3 - x.mult3; }).forEach(function (s) {
      rows.push(el('tr', s.id === 'snake' ? { class: 'pay-jackpot' } : null, [
        el('td', { class: 'pay-combo' }, [s.emoji + ' ' + s.emoji + ' ' + s.emoji]),
        el('td', { class: 'pay-name' }, [s.name + (s.id === 'snake' ? ' · Jackpot' : '')]),
        el('td', { class: 'pay-mult' }, ['×' + s.mult3])
      ]));
    });
    // Sonderregel: genau zwei Schlangen
    rows.push(el('tr', { class: 'pay-special' }, [
      el('td', { class: 'pay-combo' }, ['🐍 🐍']),
      el('td', { class: 'pay-name' }, ['Zwei Schlangen (egal wo)']),
      el('td', { class: 'pay-mult' }, ['×' + SNAKE2_MULT])
    ]));

    return el('table', { class: 'payout-table slots-paytable' }, [
      el('thead', null, [el('tr', null, [
        el('th', null, ['Kombination']),
        el('th', null, ['Symbol']),
        el('th', { class: 'pay-mult' }, ['Auszahlung'])
      ])]),
      el('tbody', null, rows)
    ]);
  }

  /* ---------- Spielspezifisches CSS ---------- */
  function injectCss() {
    UI.injectStyle('game-slots-css', [
      '.slots-wrap{display:flex;flex-direction:column;gap:16px;max-width:640px;margin:0 auto;}',
      '.slots-stage{display:flex;flex-direction:column;align-items:center;gap:16px;overflow:hidden;}',

      '.slots-readout{font-size:clamp(20px,5.2vw,30px);min-height:1.3em;text-align:center;transition:color .2s;color:var(--leaf);}',
      '.slots-readout.spinning{color:var(--muted);}',
      '.slots-readout.win{color:var(--neon);text-shadow:0 0 14px rgba(57,255,20,.6);}',
      '.slots-readout.lose{color:var(--muted);}',
      '.slots-readout.jackpot{color:var(--gold);text-shadow:0 0 16px rgba(255,210,63,.85),0 0 34px rgba(255,210,63,.5);animation:slotsJack .5s ease-in-out 3;}',
      '@keyframes slotsJack{0%,100%{transform:scale(1)}50%{transform:scale(1.06)}}',

      // --cell steuert Zellhoehe (und damit Walzenhoehe = 3 Zellen)
      '.slots-reels{--cell:clamp(64px,20vw,92px);display:flex;gap:10px;justify-content:center;width:100%;}',
      '.slots-reel{position:relative;flex:1 1 0;max-width:120px;height:calc(var(--cell)*3);',
        'overflow:hidden;border-radius:14px;border:1px solid var(--stroke-2);',
        'background:linear-gradient(180deg,rgba(4,16,10,.95),rgba(9,32,21,.85));',
        'box-shadow:inset 0 0 22px rgba(0,0,0,.7),inset 0 0 12px rgba(57,255,20,.06);',
        'transition:box-shadow .25s,border-color .25s;}',
      // sanfte Verlaufsblenden oben/unten fuer Tiefe
      '.slots-reel::before,.slots-reel::after{content:"";position:absolute;left:0;right:0;height:calc(var(--cell)*.85);z-index:3;pointer-events:none;}',
      '.slots-reel::before{top:0;background:linear-gradient(180deg,rgba(4,16,10,.95),rgba(4,16,10,0));}',
      '.slots-reel::after{bottom:0;background:linear-gradient(0deg,rgba(4,16,10,.95),rgba(4,16,10,0));}',

      '.slots-strip{display:flex;flex-direction:column;will-change:transform;}',
      '.slots-cell{height:var(--cell);display:flex;align-items:center;justify-content:center;',
        'font-size:calc(var(--cell)*.56);line-height:1;user-select:none;filter:drop-shadow(0 2px 4px rgba(0,0,0,.5));}',

      // Payline (mittlere Reihe hervorgehoben)
      '.slots-payline{position:absolute;left:0;right:0;top:var(--cell);height:var(--cell);z-index:2;pointer-events:none;',
        'border-top:2px solid rgba(51,230,208,.55);border-bottom:2px solid rgba(51,230,208,.55);',
        'box-shadow:0 0 14px rgba(51,230,208,.25) inset;}',

      // Gewinn-Hervorhebung der Walze
      '.slots-reel.reel-win{border-color:var(--neon);box-shadow:0 0 22px rgba(57,255,20,.55),inset 0 0 20px rgba(57,255,20,.3);animation:slotsGlow .7s ease-in-out infinite alternate;}',
      '@keyframes slotsGlow{from{box-shadow:0 0 16px rgba(57,255,20,.4),inset 0 0 14px rgba(57,255,20,.22)}to{box-shadow:0 0 30px rgba(57,255,20,.8),inset 0 0 24px rgba(57,255,20,.4)}}',
      // kurzer Landungs-Pop (skaliert Container, nicht den Streifen)
      '.slots-reel.reel-landed{animation:slotsPop .26s ease-out;}',
      '@keyframes slotsPop{0%{transform:translateY(0)}35%{transform:translateY(3px) scale(1.03)}100%{transform:translateY(0) scale(1)}}',

      '.slots-controls{margin-top:2px;}',
      '.slots-spin{min-width:170px;}',

      // Gewinntabelle
      '.slots-paycard{padding:14px 16px;}',
      '.slots-paytitle{font-size:15px;font-weight:800;letter-spacing:.5px;margin-bottom:8px;}',
      '.slots-paytable td.pay-combo{font-size:18px;white-space:nowrap;letter-spacing:2px;}',
      '.slots-paytable td.pay-name{color:var(--muted);}',
      '.slots-paytable td.pay-mult,.slots-paytable th.pay-mult{text-align:right;font-weight:800;color:var(--leaf);font-variant-numeric:tabular-nums;}',
      '.slots-paytable tr.pay-jackpot td.pay-name{color:var(--gold);font-weight:700;}',
      '.slots-paytable tr.pay-jackpot td.pay-mult{color:var(--gold);text-shadow:0 0 10px rgba(255,210,63,.5);}',
      '.slots-paytable tr.pay-special td.pay-mult{color:var(--aqua-soft);}',
      '.slots-paytable tr.pay-special td{border-top:1px solid var(--stroke-2);}',

      '@media(max-width:420px){.slots-spin{width:100%;}.slots-reels{gap:7px;}}'
    ].join(''));
  }
})();
