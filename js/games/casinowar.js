/* casinowar.js — "Casino War" im Neon-Dschungel.
 *
 * Regeln:
 *   - "Deal": je 1 Karte an Spieler und Dealer aus einem frisch gemischten
 *     6-Deck-Schuh (Fisher-Yates). Nur der Rang zählt (Farbe egal), Ass hoch.
 *   - Höhere Karte gewinnt 1:1  -> payout = bet * 2.
 *   - Dealer höher -> Einsatz verloren.
 *   - Gleicher Rang (Krieg): der Spieler wählt
 *       • KRIEG:     zweiter Einsatz in Höhe von bet wird fällig (nur wenn das
 *                    Guthaben es noch hergibt). 3 Karten werden "verbrannt",
 *                    dann je 1 neue Karte. Spieler >= Dealer -> gewonnen:
 *                    erster Einsatz zurück + zweiter Einsatz 1:1
 *                    -> add(bet*2 + bet). Sonst beide Einsätze verloren.
 *       • AUFGEBEN:  halber erster Einsatz zurück -> add(floor(bet/2)).
 * House-Edge ~2,9 % (Krieg-Auszahlung nicht auf den ersten Einsatz).
 */
(function () {
  'use strict';
  window.App = window.App || {};
  App.Games = App.Games || {};
  var UI = App.UI, el = UI.el;

  var RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
  var SUITS = ['♠', '♥', '♦', '♣'];

  function rankVal(r) { return RANKS.indexOf(r) + 2; } // 2..14 (Ass hoch)
  function isRed(suit) { return suit === '♥' || suit === '♦'; }

  function buildShoe() {
    var s = [], d, si, ri, i, j, t;
    for (d = 0; d < 6; d++)
      for (si = 0; si < SUITS.length; si++)
        for (ri = 0; ri < RANKS.length; ri++)
          s.push({ rank: RANKS[ri], suit: SUITS[si] });
    for (i = s.length - 1; i > 0; i--) {
      j = Math.floor(Math.random() * (i + 1));
      t = s[i]; s[i] = s[j]; s[j] = t;
    }
    return s;
  }

  function injectCss() {
    UI.injectStyle('game-casinowar-css', [
      '.cw-wrap{display:flex;flex-direction:column;gap:18px;}',
      '.cw-stage{gap:18px;padding:24px 18px;}',
      '.cw-table{display:flex;align-items:center;justify-content:center;gap:clamp(10px,4vw,34px);width:100%;flex-wrap:nowrap;}',
      '.cw-seat{display:flex;flex-direction:column;align-items:center;gap:10px;min-width:0;}',
      '.cw-seat-name{font-weight:800;letter-spacing:1px;text-transform:uppercase;font-size:13px;color:var(--leaf);}',
      '.cw-seat.dealer .cw-seat-name{color:var(--aqua-soft);}',
      '.cw-slot{width:clamp(76px,22vw,104px);height:clamp(108px,31vw,146px);border-radius:11px;display:grid;place-items:center;}',
      '.cw-slot.empty{border:2px dashed var(--stroke-2);background:rgba(4,16,10,.4);}',
      '.cw-rank{font-weight:900;font-variant-numeric:tabular-nums;font-size:18px;color:var(--text);min-width:40px;text-align:center;',
        'padding:3px 12px;border-radius:999px;background:rgba(4,16,10,.7);border:1px solid var(--stroke);}',
      '.cw-vs{font-weight:900;font-size:clamp(20px,6vw,30px);letter-spacing:2px;color:var(--muted);',
        'text-shadow:0 0 14px rgba(57,255,20,.25);flex:0 0 auto;align-self:center;}',
      '.cw-card{position:relative;width:100%;height:100%;border-radius:11px;',
        'background:linear-gradient(158deg,#ffffff,#e6f1ea);border:1px solid rgba(0,0,0,.28);',
        'box-shadow:0 6px 15px rgba(0,0,0,.45);color:#14202b;font-weight:800;',
        'user-select:none;-webkit-user-select:none;animation:cwDeal .34s cubic-bezier(.2,.8,.3,1.25) both;}',
      '.cw-card.red{color:#d21f3c;}',
      '.cw-card.dark{color:#14202b;}',
      '.cw-card.win{box-shadow:0 6px 15px rgba(0,0,0,.45),0 0 0 2px var(--neon),0 0 20px rgba(57,255,20,.55);}',
      '.cw-card.lose{box-shadow:0 6px 15px rgba(0,0,0,.45),0 0 0 2px var(--danger),0 0 18px rgba(255,77,109,.5);opacity:.9;}',
      '.cw-corner{position:absolute;font-size:clamp(12px,3.6vw,15px);line-height:.92;text-align:center;font-weight:900;}',
      '.cw-corner.tl{top:6px;left:7px;}',
      '.cw-corner.br{bottom:6px;right:7px;transform:rotate(180deg);}',
      '.cw-pip{position:absolute;inset:0;display:grid;place-items:center;font-size:clamp(30px,9vw,44px);}',
      '.cw-card.back{color:var(--leaf);display:grid;place-items:center;border-color:rgba(57,255,20,.5);',
        'background:repeating-linear-gradient(45deg,rgba(57,255,20,.12) 0 7px,transparent 7px 14px),',
        'radial-gradient(circle at 50% 42%,#0e4a2c,#05271a);',
        'box-shadow:0 6px 15px rgba(0,0,0,.45),inset 0 0 0 2px rgba(57,255,20,.25);}',
      '.cw-back-emoji{font-size:30px;filter:drop-shadow(0 0 7px var(--neon));}',
      '.cw-burn{display:flex;flex-direction:column;align-items:center;gap:8px;overflow:hidden;max-height:0;opacity:0;',
        'transition:max-height .3s ease,opacity .3s ease;}',
      '.cw-burn.show{max-height:160px;opacity:1;}',
      '.cw-burn-label{font-size:11px;text-transform:uppercase;letter-spacing:1px;color:var(--muted);}',
      '.cw-burn-row{display:flex;gap:8px;}',
      '.cw-burn-card{width:clamp(38px,11vw,52px);height:clamp(54px,16vw,72px);border-radius:8px;',
        'display:grid;place-items:center;color:var(--leaf);border:1px solid rgba(57,255,20,.4);',
        'background:repeating-linear-gradient(45deg,rgba(57,255,20,.1) 0 6px,transparent 6px 12px),',
        'radial-gradient(circle at 50% 42%,#0e4a2c,#05271a);box-shadow:0 4px 10px rgba(0,0,0,.4);',
        'animation:cwDeal .3s ease both;}',
      '.cw-burn-card span{font-size:16px;filter:drop-shadow(0 0 5px var(--neon));}',
      '.cw-banner{min-height:30px;font-weight:900;font-size:clamp(18px,4.8vw,26px);letter-spacing:1px;text-align:center;transition:.2s;color:var(--muted);}',
      '.cw-banner.win{color:var(--neon);text-shadow:0 0 14px rgba(57,255,20,.6);}',
      '.cw-banner.lose{color:var(--danger-2);text-shadow:0 0 12px rgba(255,77,109,.5);}',
      '.cw-banner.war{color:var(--gold);text-shadow:0 0 16px rgba(255,210,63,.6);}',
      '.cw-controls{display:flex;flex-direction:column;gap:16px;align-items:center;}',
      '.cw-info{display:flex;flex-wrap:wrap;gap:8px 22px;justify-content:center;}',
      '.cw-info-item{text-align:center;}',
      '.cw-info-l{display:block;color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:1px;}',
      '.cw-info-v{font-size:20px;font-weight:900;color:var(--leaf);font-variant-numeric:tabular-nums;}',
      '.cw-info-v.gold{color:var(--gold);}',
      '.cw-deal-row{width:100%;max-width:320px;}',
      '.cw-war-actions{display:flex;flex-wrap:wrap;gap:10px;justify-content:center;width:100%;max-height:0;overflow:hidden;',
        'opacity:0;transition:max-height .3s ease,opacity .3s ease;}',
      '.cw-war-actions.show{max-height:120px;opacity:1;}',
      '.cw-war-actions .btn{min-width:150px;}',
      '@keyframes cwDeal{from{opacity:0;transform:translateY(-18px) rotate(-6deg) scale(.9);}to{opacity:1;transform:none;}}',
      '@media (prefers-reduced-motion:reduce){.cw-card,.cw-burn-card{animation:none;}}'
    ].join(''));
  }

  App.Games.casinowar = {
    id: 'casinowar',
    title: 'Casino War',
    icon: '⚔️',
    subtitle: 'Höhere Karte gewinnt — bei Gleichstand: Krieg!',

    render: function (root) {
      injectCss();

      /* ---------- Zustand ---------- */
      var shoe = [];
      var playerCard = null, dealerCard = null;
      var roundBet = 0;       // erster Einsatz der Runde
      var warBet = 0;         // zweiter Einsatz (Krieg)
      var phase = 'idle';     // 'idle' | 'busy' | 'war'
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

      /* ---------- DOM ---------- */
      var dealerSlot = el('div', { class: 'cw-slot empty' });
      var dealerRank = el('div', { class: 'cw-rank' }, ['—']);
      var playerSlot = el('div', { class: 'cw-slot empty' });
      var playerRank = el('div', { class: 'cw-rank' }, ['—']);

      var table = el('div', { class: 'cw-table' }, [
        el('div', { class: 'cw-seat dealer' }, [
          el('div', { class: 'cw-seat-name' }, ['Dealer']), dealerSlot, dealerRank
        ]),
        el('div', { class: 'cw-vs' }, ['VS']),
        el('div', { class: 'cw-seat player' }, [
          el('div', { class: 'cw-seat-name' }, ['Du']), playerSlot, playerRank
        ])
      ]);

      var burnRow = el('div', { class: 'cw-burn-row' });
      var burn = el('div', { class: 'cw-burn' }, [
        el('div', { class: 'cw-burn-label' }, ['3 Karten verbrannt']),
        burnRow
      ]);

      var banner = el('div', { class: 'cw-banner' }, ['Setze deinen Einsatz und gib die Karten.']);

      var stage = el('div', { class: 'game-stage cw-stage' }, [table, burn, banner]);

      /* ---------- Info + Steuerung ---------- */
      var winV = el('div', { class: 'cw-info-v' });
      var info = el('div', { class: 'cw-info' }, [
        el('div', { class: 'cw-info-item' }, [
          el('span', { class: 'cw-info-l' }, ['Auszahlung']),
          el('div', { class: 'cw-info-v gold' }, ['1:1'])
        ]),
        el('div', { class: 'cw-info-item' }, [
          el('span', { class: 'cw-info-l' }, ['Möglicher Gewinn']), winV
        ])
      ]);

      var betPanel = UI.createBetPanel({
        initial: 50,
        onChange: function () { updateInfo(); if (phase === 'idle') refreshButtons(); }
      });

      var dealBtn = el('button', { class: 'btn btn-primary btn-lg btn-block', type: 'button' }, ['🍃 Karten geben']);
      var warBtn = el('button', { class: 'btn btn-primary', type: 'button' }, ['⚔️ Krieg']);
      var surrenderBtn = el('button', { class: 'btn btn-danger', type: 'button' }, ['🏳️ Aufgeben']);
      var warActions = el('div', { class: 'cw-war-actions' }, [warBtn, surrenderBtn]);

      var panel = el('div', { class: 'game-panel glass cw-controls' }, [
        info,
        betPanel.root,
        el('div', { class: 'cw-deal-row' }, [dealBtn]),
        warActions,
        el('p', { class: 'hint-text' }, ['Höhere Karte gewinnt 1:1 · Gleichstand = Krieg (zweiter Einsatz) oder aufgeben (halber Einsatz zurück)'])
      ]);

      root.appendChild(el('div', { class: 'cw-wrap' }, [stage, panel]));

      /* ---------- Karten-Rendering ---------- */
      function cardInner(card) {
        return '<span class="cw-corner tl">' + card.rank + '<br>' + card.suit + '</span>' +
          '<span class="cw-pip">' + card.suit + '</span>' +
          '<span class="cw-corner br">' + card.rank + '<br>' + card.suit + '</span>';
      }
      function renderCard(slot, card) {
        slot.className = 'cw-slot';
        slot.innerHTML = '';
        slot.appendChild(el('div', {
          class: 'cw-card ' + (isRed(card.suit) ? 'red' : 'dark'),
          html: cardInner(card)
        }));
      }
      function renderBack(slot) {
        slot.className = 'cw-slot';
        slot.innerHTML = '';
        slot.appendChild(el('div', { class: 'cw-card back', html: '<span class="cw-back-emoji">🌴</span>' }));
      }
      function markResult(slot, cls) {
        var c = slot.firstChild;
        if (c) c.classList.add(cls);
      }
      function draw() { return shoe.pop(); }

      function updateRanks() {
        dealerRank.textContent = dealerCard ? dealerCard.rank : '—';
        playerRank.textContent = playerCard ? playerCard.rank : '—';
      }

      function updateInfo() {
        var bet = betPanel.getBet();
        winV.textContent = '+' + UI.formatCoins(bet);
      }

      /* ---------- Buttons / Phasen ---------- */
      function showWarActions(show) { warActions.classList.toggle('show', !!show); }

      function refreshButtons() {
        var idle = (phase === 'idle');
        dealBtn.disabled = !(idle && App.Coins.canBet(betPanel.getBet()));
        betPanel.setDisabled(!idle);
        var atWar = (phase === 'war');
        // Krieg nur, wenn der zweite Einsatz gedeckt ist; sonst nur Aufgeben.
        warBtn.disabled = !(atWar && App.Coins.canBet(roundBet));
        surrenderBtn.disabled = !atWar;
      }
      function setPhase(p) { phase = p; refreshButtons(); }

      /* ---------- Runde ---------- */
      function deal() {
        if (phase !== 'idle') return;
        var bet = betPanel.getBet();
        if (!App.Coins.canBet(bet)) { UI.toast('Nicht genug Coins', 'lose'); return; }

        setPhase('busy');
        App.Coins.add(-bet);
        roundBet = bet;
        warBet = 0;

        shoe = buildShoe();
        var pc = draw(), dc = draw();

        // UI zurücksetzen
        banner.className = 'cw-banner';
        banner.textContent = 'Die Karten werden gegeben…';
        burn.classList.remove('show');
        burnRow.innerHTML = '';
        showWarActions(false);
        playerCard = null; dealerCard = null;
        renderBack(dealerSlot);
        renderBack(playerSlot);
        updateRanks();

        later(function () { dealerCard = dc; renderCard(dealerSlot, dc); updateRanks(); if (App.Audio) App.Audio.sfx('deal'); }, 160);
        later(function () { playerCard = pc; renderCard(playerSlot, pc); updateRanks(); if (App.Audio) App.Audio.sfx('deal'); }, 460);
        later(compareInitial, 900);
      }

      function compareInitial() {
        var pv = rankVal(playerCard.rank), dv = rankVal(dealerCard.rank);
        if (pv > dv) { markResult(playerSlot, 'win'); markResult(dealerSlot, 'lose'); endRound('win'); }
        else if (pv < dv) { markResult(dealerSlot, 'win'); markResult(playerSlot, 'lose'); endRound('lose'); }
        else enterWar();
      }

      function enterWar() {
        setPhase('war');
        if (App.Audio) App.Audio.sweep(560, 180, 0.45, { type: 'sawtooth', peak: 0.09, filter: 1500 }); // dramatischer Kriegs-Sweep
        banner.className = 'cw-banner war';
        if (App.Coins.canBet(roundBet)) {
          banner.textContent = '⚔️ GLEICHSTAND — Krieg oder aufgeben?';
        } else {
          banner.textContent = '⚔️ Gleichstand — zu wenig Coins für Krieg, nur aufgeben.';
        }
        showWarActions(true);
      }

      function goToWar() {
        if (phase !== 'war') return;
        if (!App.Coins.canBet(roundBet)) { UI.toast('Nicht genug Coins für den Krieg', 'lose'); return; }

        setPhase('busy');
        showWarActions(false);
        App.Coins.add(-roundBet);
        warBet = roundBet;

        banner.className = 'cw-banner war';
        banner.textContent = '⚔️ KRIEG!';

        // 3 Karten verbrennen (simuliert)
        var burned = [draw(), draw(), draw()];
        burn.classList.add('show');
        burned.forEach(function (c, i) {
          later(function () {
            burnRow.appendChild(el('div', { class: 'cw-burn-card' }, [el('span', {}, ['🌴'])]));
            if (App.Audio) App.Audio.sfx('deal');
          }, 120 + i * 150);
        });

        var pc = draw(), dc = draw();
        later(function () {
          renderBack(dealerSlot); renderBack(playerSlot);
          playerCard = null; dealerCard = null; updateRanks();
        }, 640);
        later(function () { dealerCard = dc; renderCard(dealerSlot, dc); updateRanks(); if (App.Audio) App.Audio.sfx('deal'); }, 880);
        later(function () { playerCard = pc; renderCard(playerSlot, pc); updateRanks(); if (App.Audio) App.Audio.sfx('deal'); }, 1180);
        later(function () {
          var pv = rankVal(playerCard.rank), dv = rankVal(dealerCard.rank);
          if (pv >= dv) { markResult(playerSlot, 'win'); markResult(dealerSlot, 'lose'); endRound('warwin'); }
          else { markResult(dealerSlot, 'win'); markResult(playerSlot, 'lose'); endRound('warlose'); }
        }, 1620);
      }

      function surrender() {
        if (phase !== 'war') return;
        setPhase('busy');
        showWarActions(false);
        endRound('surrender');
      }

      function endRound(outcome) {
        var payout = 0, net = 0, cls = 'lose', text = '', kind = 'lose';
        if (outcome === 'win') {
          payout = roundBet * 2; net = roundBet;
          cls = 'win'; text = 'GEWONNEN'; kind = 'win';
        } else if (outcome === 'warwin') {
          // erster Einsatz zurück + zweiter Einsatz 1:1
          payout = roundBet * 2 + roundBet; net = roundBet;
          cls = 'win'; text = 'KRIEG GEWONNEN'; kind = 'win';
        } else if (outcome === 'warlose') {
          payout = 0; net = -(roundBet + warBet);
          cls = 'lose'; text = 'KRIEG VERLOREN'; kind = 'lose';
        } else if (outcome === 'surrender') {
          payout = Math.floor(roundBet / 2); net = payout - roundBet;
          cls = 'lose'; text = 'AUFGEGEBEN'; kind = 'info';
        } else { // 'lose'
          payout = 0; net = -roundBet;
          cls = 'lose'; text = 'VERLOREN'; kind = 'lose';
        }

        if (payout > 0) App.Coins.add(payout);
        UI.flash(net, { label: text });
        UI.toast(text, kind);
        banner.className = 'cw-banner ' + cls;
        banner.textContent = text;

        // Genau einmal pro Runde abrechnen (auch nach Krieg).
        betPanel.refresh();
        updateInfo();
        setPhase('idle');
        App.Coins.settle();
      }

      /* ---------- Events ---------- */
      dealBtn.addEventListener('click', deal);
      warBtn.addEventListener('click', goToWar);
      surrenderBtn.addEventListener('click', surrender);

      updateInfo();
      setPhase('idle');

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
