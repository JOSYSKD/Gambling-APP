/* andarbahar.js — "Andar Bahar" im Neon-Dschungel.
 *
 * Regeln:
 *   - Eine Joker-Karte wird aufgedeckt (Mitte).
 *   - Der Spieler wählt VORHER die Seite: Andar (links) oder Bahar (rechts).
 *   - Aus dem restlichen Deck werden Karten ABWECHSELND ausgeteilt:
 *     erste Karte -> Andar, nächste -> Bahar, usw. (animiert).
 *   - Sobald eine ausgeteilte Karte denselben RANG wie der Joker hat,
 *     endet die Runde — diese Seite ist die Gewinnerseite.
 *   - Auszahlung (brutto inkl. Einsatz), wegen Andar-Vorteil:
 *       Andar korrekt -> 1.9× · Bahar korrekt -> 2.0×
 */
(function () {
  'use strict';
  window.App = window.App || {};
  App.Games = App.Games || {};
  var UI = App.UI, el = UI.el;

  var RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
  var SUITS = ['♠', '♥', '♦', '♣'];

  var MULT = { andar: 1.9, bahar: 2.0 };
  var DEAL_MS = 250;   // Takt beim Austeilen

  function isRed(suit) { return suit === '♥' || suit === '♦'; }

  // Simuliert das Austeilen (dealIndex 0 = deck.pop() = letztes Element; gerade -> Andar, ungerade -> Bahar)
  // und liefert die Gewinnerseite (erste Karte mit Joker-Rang) oder null.
  function simulateWinner(dk, jk) {
    var di = 0;
    for (var p = dk.length - 1; p >= 0; p--) {
      if (dk[p].rank === jk.rank) return (di % 2 === 0) ? 'andar' : 'bahar';
      di++;
    }
    return null;
  }

  function buildDeck() {
    var d = [], si, ri, i, j, t;
    for (si = 0; si < SUITS.length; si++)
      for (ri = 0; ri < RANKS.length; ri++)
        d.push({ rank: RANKS[ri], suit: SUITS[si] });
    // Fisher-Yates
    for (i = d.length - 1; i > 0; i--) {
      j = Math.floor(Math.random() * (i + 1));
      t = d[i]; d[i] = d[j]; d[j] = t;
    }
    return d;
  }

  function injectCss() {
    UI.injectStyle('game-andarbahar-css', [
      '.ab-wrap{display:flex;flex-direction:column;gap:18px;}',
      '.ab-stage{gap:18px;padding:22px 16px;}',
      /* Joker-Zone */
      '.ab-joker-zone{display:flex;flex-direction:column;align-items:center;gap:8px;}',
      '.ab-joker-label{font-size:12px;text-transform:uppercase;letter-spacing:2px;font-weight:800;color:var(--gold);text-shadow:0 0 10px rgba(255,210,63,.45);}',
      '.ab-joker-holder{display:flex;align-items:center;justify-content:center;min-height:126px;}',
      /* Tisch: zwei Reihen Andar / Bahar */
      '.ab-table{display:grid;grid-template-columns:1fr 1fr;gap:12px;width:100%;}',
      '.ab-col{display:flex;flex-direction:column;gap:9px;padding:12px 10px;border-radius:14px;',
        'background:rgba(4,16,10,.55);border:1px solid var(--stroke);transition:.25s;}',
      '.ab-col-head{display:flex;align-items:center;justify-content:space-between;gap:8px;}',
      '.ab-col-name{font-weight:800;letter-spacing:1px;text-transform:uppercase;font-size:14px;}',
      '.ab-col.andar .ab-col-name{color:var(--leaf);}',
      '.ab-col.bahar .ab-col-name{color:var(--aqua-soft);}',
      '.ab-count{font-size:12px;font-weight:800;font-variant-numeric:tabular-nums;color:var(--muted);',
        'padding:2px 9px;border-radius:999px;background:rgba(4,16,10,.7);border:1px solid var(--stroke);}',
      '.ab-cards{display:flex;flex-wrap:wrap;gap:7px;min-height:86px;align-content:flex-start;}',
      '.ab-col.win{border-color:var(--neon);box-shadow:inset 0 0 18px rgba(57,255,20,.18),var(--glow);}',
      '.ab-col.win .ab-count{color:var(--neon);border-color:var(--stroke-2);}',
      '.ab-col.lose{opacity:.5;}',
      /* Karten (angelehnt an Blackjack) */
      '.ab-card{position:relative;width:clamp(44px,12vw,60px);height:clamp(63px,17vw,84px);border-radius:8px;',
        'background:linear-gradient(158deg,#ffffff,#e6f1ea);border:1px solid rgba(0,0,0,.28);',
        'box-shadow:0 5px 13px rgba(0,0,0,.42);color:#14202b;font-weight:800;flex:0 0 auto;',
        'user-select:none;-webkit-user-select:none;animation:abDeal .28s cubic-bezier(.2,.8,.3,1.25) both;}',
      '.ab-card.red{color:#d21f3c;}',
      '.ab-corner{position:absolute;font-size:clamp(10px,3vw,13px);line-height:.9;text-align:center;font-weight:900;}',
      '.ab-corner.tl{top:4px;left:5px;}',
      '.ab-corner.br{bottom:4px;right:5px;transform:rotate(180deg);}',
      '.ab-pip{position:absolute;inset:0;display:grid;place-items:center;font-size:clamp(20px,6vw,30px);}',
      '.ab-card.hit{box-shadow:0 0 16px rgba(57,255,20,.6),0 5px 13px rgba(0,0,0,.42);border-color:var(--neon);}',
      /* Joker-Karte größer + golden umrandet */
      '.ab-card.joker{width:clamp(64px,20vw,86px);height:clamp(92px,28vw,122px);border-color:var(--gold);',
        'box-shadow:0 0 22px rgba(255,210,63,.5),0 8px 18px rgba(0,0,0,.5);}',
      '.ab-card.joker .ab-corner{font-size:clamp(12px,3.6vw,16px);}',
      '.ab-card.joker .ab-pip{font-size:clamp(26px,8vw,40px);}',
      /* Rückseite (vor Rundenstart) */
      '.ab-card.back{color:var(--gold);display:grid;place-items:center;border-color:rgba(255,210,63,.5);',
        'background:repeating-linear-gradient(45deg,rgba(57,255,20,.12) 0 7px,transparent 7px 14px),',
        'radial-gradient(circle at 50% 42%,#0e4a2c,#05271a);',
        'box-shadow:0 0 18px rgba(255,210,63,.3),inset 0 0 0 2px rgba(255,210,63,.25);}',
      '.ab-back-emoji{font-size:32px;filter:drop-shadow(0 0 7px var(--gold));}',
      /* Banner */
      '.ab-banner{min-height:26px;font-weight:900;font-size:clamp(16px,4.4vw,22px);letter-spacing:1px;text-align:center;transition:.2s;color:var(--muted);}',
      '.ab-banner.win{color:var(--neon);text-shadow:0 0 14px rgba(57,255,20,.6);}',
      '.ab-banner.lose{color:var(--danger-2);text-shadow:0 0 12px rgba(255,77,109,.5);}',
      /* Steuerung */
      '.ab-section{display:flex;flex-direction:column;gap:12px;}',
      '.ab-section-title{text-align:center;color:var(--leaf);font-weight:800;font-size:12px;text-transform:uppercase;letter-spacing:1px;}',
      '.ab-sides{display:flex;gap:10px;flex-wrap:wrap;justify-content:center;}',
      '.ab-sidebtn{flex:1 1 150px;min-width:130px;display:flex;flex-direction:column;gap:2px;align-items:center;}',
      '.ab-sidebtn .ab-side-mult{font-size:12px;font-weight:700;opacity:.8;}',
      '.ab-sidebtn.active.andar{color:#04160c;background:linear-gradient(180deg,var(--neon-soft),var(--neon));border-color:var(--neon);box-shadow:var(--glow);}',
      '.ab-sidebtn.active.bahar{color:#042020;background:linear-gradient(180deg,var(--aqua-soft),var(--aqua));border-color:var(--aqua);box-shadow:0 0 16px rgba(51,230,208,.45);}',
      '.ab-info{display:flex;flex-wrap:wrap;gap:10px 22px;justify-content:center;}',
      '.ab-info-item{text-align:center;}',
      '.ab-info-l{display:block;color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:1px;}',
      '.ab-info-v{font-size:20px;font-weight:900;font-variant-numeric:tabular-nums;color:var(--leaf);}',
      '.ab-info-v.gold{color:var(--gold);}',
      '.ab-betrow{display:flex;flex-wrap:wrap;gap:16px;align-items:flex-end;justify-content:center;}',
      '.ab-betrow .bet-panel{flex:1 1 240px;}',
      '.ab-start{flex:1 1 240px;}',
      '@keyframes abDeal{from{opacity:0;transform:translateY(-16px) rotate(-6deg) scale(.9);}to{opacity:1;transform:none;}}',
      '@media (max-width:420px){.ab-card{width:clamp(38px,11vw,52px);height:clamp(54px,16vw,74px);}}',
      '@media (prefers-reduced-motion:reduce){.ab-card{animation:none;}}'
    ].join(''));
  }

  App.Games.andarbahar = {
    id: 'andarbahar',
    title: 'Andar Bahar',
    icon: '🪔',
    subtitle: 'Auf welcher Seite fällt zuerst die Joker-Karte?',

    render: function (root) {
      injectCss();

      /* ---------- Zustand ---------- */
      var chosen = 'andar';        // gewählte Seite
      var phase = 'idle';          // 'idle' | 'dealing'
      var deck = [];
      var joker = null;
      var turnIndex = 0;           // gerade -> Andar, ungerade -> Bahar
      var dealtAndar = 0, dealtBahar = 0;
      var destroyed = false;
      var timers = [];

      function later(fn, ms) {
        var id = setTimeout(function () {
          var idx = timers.indexOf(id);
          if (idx >= 0) timers.splice(idx, 1);
          if (destroyed) return;
          fn();
        }, ms);
        timers.push(id);
        return id;
      }

      /* ---------- Karten-Rendering ---------- */
      function cardNode(card, extraClass) {
        var cls = 'ab-card' + (isRed(card.suit) ? ' red' : '') + (extraClass ? ' ' + extraClass : '');
        var inner =
          '<span class="ab-corner tl">' + card.rank + '<br>' + card.suit + '</span>' +
          '<span class="ab-pip">' + card.suit + '</span>' +
          '<span class="ab-corner br">' + card.rank + '<br>' + card.suit + '</span>';
        return el('div', { class: cls, html: inner });
      }
      function backNode() {
        return el('div', { class: 'ab-card joker back', html: '<span class="ab-back-emoji">🪔</span>' });
      }

      /* ---------- DOM ---------- */
      var jokerHolder = el('div', { class: 'ab-joker-holder' }, [backNode()]);
      var jokerZone = el('div', { class: 'ab-joker-zone' }, [
        el('div', { class: 'ab-joker-label' }, ['Joker-Karte']),
        jokerHolder
      ]);

      var andarCards = el('div', { class: 'ab-cards' });
      var baharCards = el('div', { class: 'ab-cards' });
      var andarCount = el('span', { class: 'ab-count' }, ['0']);
      var baharCount = el('span', { class: 'ab-count' }, ['0']);
      var andarCol = el('div', { class: 'ab-col andar' }, [
        el('div', { class: 'ab-col-head' }, [
          el('span', { class: 'ab-col-name' }, ['Andar']), andarCount
        ]),
        andarCards
      ]);
      var baharCol = el('div', { class: 'ab-col bahar' }, [
        el('div', { class: 'ab-col-head' }, [
          el('span', { class: 'ab-col-name' }, ['Bahar']), baharCount
        ]),
        baharCards
      ]);
      var table = el('div', { class: 'ab-table' }, [andarCol, baharCol]);

      var banner = el('div', { class: 'ab-banner' }, ['Wähle eine Seite und starte die Runde.']);

      var stage = el('div', { class: 'game-stage ab-stage' }, [jokerZone, table, banner]);

      /* ---------- Seiten-Auswahl ---------- */
      var sideDefs = [
        { key: 'andar', label: 'Andar (links)', cls: 'andar' },
        { key: 'bahar', label: 'Bahar (rechts)', cls: 'bahar' }
      ];
      var sideWinSpans = [];
      var sideBtns = sideDefs.map(function (s) {
        var winSpan = el('span', { class: 'bs-win' }, ['']);
        sideWinSpans.push(winSpan);
        return el('button', {
          class: 'btn ab-sidebtn btn-2l ' + s.cls + (chosen === s.key ? ' active' : ''),
          type: 'button',
          onclick: function () { if (phase === 'idle') selectSide(s.key); }
        }, [
          el('span', { class: 'btn-main' }, [s.label]),
          el('span', { class: 'btn-sub' }, [MULT[s.key].toFixed(1) + '× · ', winSpan])
        ]);
      });
      var sideRow = el('div', { class: 'ab-sides' }, sideBtns);

      var multV = el('div', { class: 'ab-info-v gold' });
      var winV  = el('div', { class: 'ab-info-v' });
      var infoRow = el('div', { class: 'ab-info' }, [
        el('div', { class: 'ab-info-item' }, [el('span', { class: 'ab-info-l' }, ['Auszahlung']), multV]),
        el('div', { class: 'ab-info-item' }, [el('span', { class: 'ab-info-l' }, ['Möglicher Gewinn']), winV])
      ]);

      var controlsPanel = el('div', { class: 'glass game-panel ab-section' }, [
        el('div', { class: 'ab-section-title' }, ['Deine Seite']),
        sideRow,
        infoRow
      ]);

      /* ---------- Einsatz + Start ---------- */
      var betPanel = UI.createBetPanel({ initial: 50, onChange: updateInfo });
      var startSub = el('span', { class: 'btn-sub' }, ['']);
      var startBtn = el('button', {
        class: 'btn btn-primary btn-lg btn-block ab-start btn-2l', type: 'button',
        onclick: startRound
      }, [
        el('span', { class: 'btn-main' }, ['🪔 Runde starten']),
        startSub
      ]);
      var betRow = el('div', { class: 'ab-betrow' }, [betPanel.root, startBtn]);

      var hint = el('p', { class: 'hint-text' }, [
        'Karten werden abwechselnd ausgeteilt (zuerst Andar). Rang = Joker → diese Seite gewinnt.'
      ]);

      root.appendChild(el('div', { class: 'ab-wrap' }, [stage, controlsPanel, betRow, hint]));

      /* ---------- Logik ---------- */
      function selectSide(key) {
        chosen = key;
        sideBtns.forEach(function (b, i) { b.classList.toggle('active', sideDefs[i].key === key); });
        updateInfo();
      }

      function updateInfo() {
        var bet = betPanel.getBet();
        multV.textContent = MULT[chosen].toFixed(1) + '×';
        winV.textContent = '+' + UI.formatCoins(Math.round(bet * MULT[chosen]) - bet);
        sideDefs.forEach(function (s, i) {
          sideWinSpans[i].textContent = '+' + UI.formatCoins(Math.round(bet * MULT[s.key]) - bet);
        });
        startSub.textContent = 'Einsatz ' + UI.formatCoins(bet) + ' 🪙';
      }

      function setControlsDisabled(d) {
        startBtn.disabled = d;
        betPanel.setDisabled(d);
        sideBtns.forEach(function (b) { b.disabled = d; });
      }

      function setBanner(text, cls) {
        banner.className = 'ab-banner' + (cls ? ' ' + cls : '');
        banner.textContent = text;
      }

      function updateCounts() {
        andarCount.textContent = String(dealtAndar);
        baharCount.textContent = String(dealtBahar);
      }

      function startRound() {
        if (phase !== 'idle') return;
        var bet = betPanel.getBet();
        if (!App.Coins.canBet(bet)) { UI.toast('Nicht genug Coins', 'lose'); return; }

        phase = 'dealing';
        setControlsDisabled(true);
        App.Coins.add(-bet);

        // Deck bauen, Joker aufdecken
        deck = buildDeck();
        joker = deck.pop();

        // Rigging: Deck/Joker neu ziehen, bis die Gewinnerseite zum erzwungenen Ergebnis passt.
        var forced = (App.Rig && App.Rig.outcome) ? App.Rig.outcome() : null;
        if (forced) {
          for (var tries = 0; tries < 400; tries++) {
            var w = simulateWinner(deck, joker);
            var ok = (forced === 'win') ? (w === chosen) : (w && w !== chosen);
            if (ok) break;
            deck = buildDeck();
            joker = deck.pop();
          }
        }

        turnIndex = 0;
        dealtAndar = 0; dealtBahar = 0;
        andarCards.innerHTML = '';
        baharCards.innerHTML = '';
        andarCol.className = 'ab-col andar';
        baharCol.className = 'ab-col bahar';
        updateCounts();

        jokerHolder.innerHTML = '';
        jokerHolder.appendChild(cardNode(joker, 'joker'));
        if (App.Audio) App.Audio.sfx('deal');   // Joker aufgedeckt
        setBanner('Joker ' + joker.rank + joker.suit + ' — es wird ausgeteilt…', null);

        later(function () { dealStep(bet); }, 520);
      }

      function dealStep(bet) {
        var card = deck.pop();
        if (!card) { finish(null, bet); return; } // Sicherheitsnetz (praktisch unerreichbar)

        var side = (turnIndex % 2 === 0) ? 'andar' : 'bahar';
        var match = (card.rank === joker.rank);
        var node = cardNode(card, match ? 'hit' : null);
        if (side === 'andar') { andarCards.appendChild(node); dealtAndar++; }
        else { baharCards.appendChild(node); dealtBahar++; }
        // Jede ausgeteilte Karte klingt; der Treffer (Rang = Joker) rastet mit 'ding' ein.
        if (App.Audio) App.Audio.sfx(match ? 'ding' : 'deal');
        updateCounts();
        turnIndex++;

        if (match) { later(function () { finish(side, bet); }, 360); }
        else { later(function () { dealStep(bet); }, DEAL_MS); }
      }

      function finish(winSide, bet) {
        if (winSide) {
          (winSide === 'andar' ? andarCol : baharCol).classList.add('win');
          (winSide === 'andar' ? baharCol : andarCol).classList.add('lose');
        }
        var sideLabel = winSide === 'andar' ? 'Andar' : (winSide === 'bahar' ? 'Bahar' : '—');
        var won = winSide === chosen;

        if (won) {
          var payout = Math.round(bet * MULT[winSide]);
          App.Coins.add(payout);
          UI.flash(payout - bet, { label: sideLabel });
          UI.toast('Gewonnen! ' + sideLabel + ' trifft zuerst', 'win');
          setBanner('🎉 ' + sideLabel + ' gewinnt — richtig getippt!', 'win');
        } else {
          UI.flash(-bet, { label: sideLabel });
          UI.toast('Verloren — ' + sideLabel + ' trifft zuerst', 'lose');
          setBanner(sideLabel + ' gewinnt — daneben.', 'lose');
        }

        phase = 'idle';
        setControlsDisabled(false);
        betPanel.refresh();
        App.Coins.settle();
        updateInfo();
      }

      /* ---------- Init ---------- */
      updateInfo();

      return {
        cleanup: function () {
          destroyed = true;
          for (var i = 0; i < timers.length; i++) clearTimeout(timers[i]);
          timers = [];
        }
      };
    }
  };
})();
