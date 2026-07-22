/* busfahrer.js — "Busfahrer"
 * Progressives Kartenspiel in vier Stufen. Jede richtige Vorhersage steigert den
 * Multiplikator; nach jeder Stufe kann man auszahlen oder weiterrisken. Ein Fehler
 * kostet den kompletten Einsatz.
 *   1) Rot oder Schwarz?            -> ×2
 *   2) Höher oder tiefer?           -> ×4
 *   3) Innerhalb oder außerhalb?    -> ×6
 *   4) Welche Farbe (Symbol)?       -> ×20
 * Berücksichtigt das Wahrscheinlichkeits-Rigging (js/rig.js).
 */
(function () {
  'use strict';
  window.App = window.App || {};
  App.Games = App.Games || {};
  var UI = App.UI, el = UI.el;

  var MULTS = [2, 4, 6, 20];   // Auszahlung bei Erreichen von Stufe 1..4
  var SUITS = [
    { k: 'clubs', s: '♣', red: false, name: 'Kreuz' },
    { k: 'spades', s: '♠', red: false, name: 'Pik' },
    { k: 'hearts', s: '♥', red: true, name: 'Herz' },
    { k: 'diamonds', s: '♦', red: true, name: 'Karo' }
  ];
  var RANK_LABEL = { 11: 'B', 12: 'D', 13: 'K', 14: 'A' };

  function rankLabel(r) { return RANK_LABEL[r] || String(r); }
  function randomCard() {
    var suit = SUITS[Math.floor(Math.random() * 4)];
    var rank = 2 + Math.floor(Math.random() * 13);   // 2..14
    return { rank: rank, suit: suit.k, red: suit.red, sym: suit.s };
  }
  /** Karte ziehen; wenn der Admin das Ergebnis erzwingt (js/rig.js), so lange
   *  ziehen bis isWin(card) dem gewünschten Ergebnis entspricht. */
  function drawFor(isWin) {
    var forced = (App.Rig && App.Rig.outcome) ? App.Rig.outcome() : null;
    var want = forced === 'win' ? true : (forced === 'lose' ? false : null);
    var card = randomCard();
    if (want === null) return card;
    for (var i = 0; i < 60 && isWin(card) !== want; i++) card = randomCard();
    return card;
  }

  function injectCss() {
    UI.injectStyle('game-busfahrer-css', [
      '.bf-wrap{display:flex;flex-direction:column;gap:16px;}',
      '.bf-track{display:flex;gap:8px;justify-content:center;flex-wrap:wrap;}',
      '.bf-slot{width:70px;height:98px;border-radius:12px;border:2px dashed var(--stroke-2);display:flex;flex-direction:column;align-items:center;justify-content:center;background:rgba(0,0,0,.22);position:relative;}',
      '.bf-slot.filled{border-style:solid;background:linear-gradient(160deg,#0d2419,#061510);box-shadow:0 4px 14px rgba(0,0,0,.4);}',
      '.bf-slot.cur{border-color:var(--neon);box-shadow:0 0 16px rgba(57,255,20,.4);}',
      '.bf-card-r{font-size:26px;font-weight:900;line-height:1;}',
      '.bf-card-s{font-size:26px;line-height:1;margin-top:2px;}',
      '.bf-red{color:#ff5a7a;}.bf-black{color:#eaffe2;}',
      '.bf-slot-x{font-size:12px;font-weight:900;color:var(--gold);position:absolute;bottom:5px;}',
      '.bf-slot-lab{font-size:9px;color:var(--muted);position:absolute;top:5px;text-transform:uppercase;letter-spacing:.5px;}',
      '.bf-stage{text-align:center;font-weight:900;color:var(--leaf);font-size:14px;}',
      '.bf-status{text-align:center;min-height:22px;font-weight:800;color:var(--muted);}',
      '.bf-status.win{color:var(--neon);text-shadow:0 0 12px rgba(57,255,20,.6);}',
      '.bf-status.lose{color:var(--danger-2,#ff4d6d);text-shadow:0 0 12px rgba(255,77,109,.5);}',
      '.bf-choices{display:flex;gap:10px;flex-wrap:wrap;justify-content:center;}',
      '.bf-choice{flex:1 1 130px;min-width:120px;font-weight:900;}',
      '.bf-cash{display:flex;gap:10px;flex-wrap:wrap;justify-content:center;}',
      '.bf-cash .btn{flex:1 1 160px;}',
      '.bf-mult{font-size:22px;font-weight:900;color:var(--gold);font-variant-numeric:tabular-nums;}'
    ].join(''));
  }

  App.Games.busfahrer = {
    id: 'busfahrer',
    title: 'Busfahrer',
    icon: '🚌',
    subtitle: '4 Stufen: Rot/Schwarz → Höher/Tiefer → Rein/Raus → Farbe (×20)',

    render: function (root) {
      injectCss();

      var stage = 0;           // 0 = bereit, 1..4 = laufend, angekommen bei "geschafft"
      var bet = 0;
      var cards = [];          // gezogene Karten
      var busy = false;

      var track = el('div', { class: 'bf-track' });
      var stageEl = el('div', { class: 'bf-stage' }, ['']);
      var statusEl = el('div', { class: 'bf-status' }, ['Setze deinen Einsatz und starte!']);
      var choicesEl = el('div', { class: 'bf-choices' });
      var cashEl = el('div', { class: 'bf-cash' });

      var betPanel = UI.createBetPanel({ initial: 50 });
      var startBtn = el('button', { class: 'btn btn-primary btn-lg btn-block', type: 'button', onclick: start }, ['🚌 Losfahren']);
      var betRow = el('div', { class: 'game-panel glass', style: 'display:flex;flex-direction:column;gap:12px;' }, [betPanel.root, startBtn]);

      root.appendChild(el('div', { class: 'bf-wrap' }, [
        el('div', { class: 'glass game-panel', style: 'display:flex;flex-direction:column;gap:12px;' }, [
          track, stageEl, statusEl, choicesEl, cashEl
        ]),
        betRow
      ]));

      function cardNode(c, labelText, xText, isCur) {
        var slot = el('div', { class: 'bf-slot' + (c ? ' filled' : '') + (isCur ? ' cur' : '') });
        if (labelText) slot.appendChild(el('span', { class: 'bf-slot-lab' }, [labelText]));
        if (c) {
          slot.appendChild(el('span', { class: 'bf-card-r ' + (c.red ? 'bf-red' : 'bf-black') }, [rankLabel(c.rank)]));
          slot.appendChild(el('span', { class: 'bf-card-s ' + (c.red ? 'bf-red' : 'bf-black') }, [c.sym]));
        } else {
          slot.appendChild(el('span', { class: 'bf-card-r', style: 'color:var(--muted);opacity:.5;' }, ['?']));
        }
        if (xText) slot.appendChild(el('span', { class: 'bf-slot-x' }, [xText]));
        return slot;
      }

      function drawTrack() {
        track.innerHTML = '';
        var labels = ['Farbe', 'Höher/Tiefer', 'Rein/Raus', 'Symbol'];
        for (var i = 0; i < 4; i++) {
          track.appendChild(cardNode(cards[i] || null, labels[i], '×' + MULTS[i], stage === i + 1 && !cards[i]));
        }
      }

      function setStatus(t, cls) { statusEl.className = 'bf-status' + (cls ? ' ' + cls : ''); statusEl.textContent = t; }

      function start() {
        if (busy) return;
        bet = betPanel.getBet();
        if (!App.Coins.canBet(bet)) { UI.toast('Nicht genug Coins', 'lose'); return; }
        App.Coins.add(-bet);
        cards = []; stage = 1;
        betRow.style.display = 'none';
        setStatus('Rot oder Schwarz?');
        drawTrack();
        renderStage();
      }

      function endRound(msg) {
        stage = 0; cards = []; busy = false;
        choicesEl.innerHTML = ''; cashEl.innerHTML = '';
        stageEl.textContent = '';
        betPanel.refresh();
        betRow.style.display = '';
        App.Coins.settle();
        drawTrack();
        if (msg) setStatus(msg.text, msg.cls);
      }

      function cashOut() {
        var mult = MULTS[stage - 1];
        var payout = Math.round(bet * mult);
        App.Coins.add(payout);
        UI.flash(payout - bet);
        if (App.Audio) App.Audio.sfx('coin');
        endRound({ text: '💰 Ausgezahlt: ' + UI.formatCoins(payout) + ' (×' + mult + ')', cls: 'win' });
      }

      function afterCorrect() {
        var mult = MULTS[stage - 1];
        if (App.Audio) App.Audio.sfx('ding');
        if (stage >= 4) {
          // Alles geschafft -> Maximalgewinn automatisch auszahlen.
          cashOut();
          return;
        }
        setStatus('✅ Richtig! Aktuell ×' + mult + ' — weiter oder auszahlen?', 'win');
        renderCash(mult);
        stage += 1;
        renderStage();
        drawTrack();
      }

      function renderCash(mult) {
        cashEl.innerHTML = '';
        cashEl.appendChild(el('button', { class: 'btn btn-aqua', type: 'button', onclick: cashOut }, [
          '💰 Auszahlen (' + UI.formatCoins(Math.round(bet * mult)) + ')'
        ]));
      }

      function pick(isWin, resultText) {
        if (busy) return;
        busy = true;
        var card = drawFor(isWin);
        cards[stage - 1] = card;
        drawTrack();
        var ok = isWin(card);
        busy = false;
        if (ok) {
          afterCorrect();
        } else {
          UI.flash(-bet);
          if (App.Audio) App.Audio.sfx('lose');
          endRound({ text: '❌ ' + resultText(card) + ' — Einsatz verloren.', cls: 'lose' });
        }
      }

      function renderStage() {
        choicesEl.innerHTML = '';
        if (stage < 1 || stage > 4) return;
        stageEl.textContent = 'Stufe ' + stage + ' · Gewinn bei Erfolg: ×' + MULTS[stage - 1];
        if (stage === 1) {
          setStatus('Rot oder Schwarz?');
          cashEl.innerHTML = '';
          mkChoice('🔴 Rot', function () { pick(function (c) { return c.red; }, function (c) { return 'War ' + (c.red ? 'Rot' : 'Schwarz'); }); });
          mkChoice('⚫ Schwarz', function () { pick(function (c) { return !c.red; }, function (c) { return 'War ' + (c.red ? 'Rot' : 'Schwarz'); }); });
        } else if (stage === 2) {
          var r1 = cards[0].rank;
          setStatus('Höher oder tiefer als ' + rankLabel(r1) + '?');
          mkChoice('⬆️ Höher', function () { pick(function (c) { return c.rank > r1; }, function (c) { return rankLabel(c.rank) + ' ist nicht höher'; }); });
          mkChoice('⬇️ Tiefer', function () { pick(function (c) { return c.rank < r1; }, function (c) { return rankLabel(c.rank) + ' ist nicht tiefer'; }); });
        } else if (stage === 3) {
          var lo = Math.min(cards[0].rank, cards[1].rank), hi = Math.max(cards[0].rank, cards[1].rank);
          setStatus('Ist die Karte INNERHALB (' + rankLabel(lo) + '–' + rankLabel(hi) + ') oder außerhalb?');
          mkChoice('↔️ Rein (innen)', function () { pick(function (c) { return c.rank > lo && c.rank < hi; }, function (c) { return rankLabel(c.rank) + ' war nicht innen'; }); });
          mkChoice('↗️ Raus (außen)', function () { pick(function (c) { return c.rank < lo || c.rank > hi; }, function (c) { return rankLabel(c.rank) + ' war nicht außen'; }); });
        } else if (stage === 4) {
          setStatus('Welches Symbol? (×20!)');
          SUITS.forEach(function (su) {
            mkChoice(su.s + ' ' + su.name, function () {
              pick(function (c) { return c.suit === su.k; }, function (c) { return 'War ' + c.sym; });
            }, su.red);
          });
        }
      }

      function mkChoice(label, onClick, red) {
        var b = el('button', { class: 'btn btn-primary bf-choice', type: 'button', onclick: onClick }, [label]);
        if (red) b.style.borderColor = 'rgba(255,90,122,.6)';
        choicesEl.appendChild(b);
      }

      drawTrack();
      return { cleanup: function () {} };
    }
  };
})();
