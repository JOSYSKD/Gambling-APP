/* blackjack.js — Blackjack im Neon-Dschungel.
 *
 * Regeln:
 *   - 6-Deck-Schuh, jede Runde frisch per Fisher-Yates (Math.random) gemischt.
 *   - Ass zählt automatisch 1 oder 11 (bester Wert).
 *   - Spieler: Hit / Stand / Double (nur mit 2 Karten & genug Guthaben).
 *   - Blackjack (21 aus 2 Karten) zahlt 3:2 (payout = Einsatz * 2.5).
 *   - Dealer deckt nach Stand auf und zieht bis >= 17 (steht auf soft 17).
 *   - Normaler Gewinn 1:1 (payout = Einsatz * 2), Push = Einsatz zurück.
 * House-Edge bei sinnvoller Strategie ~0,5 % (Dealer steht auf allen 17,
 * BJ 3:2, Double auf beliebige 2 Karten, kein Split/keine Versicherung).
 */
(function () {
  'use strict';
  window.App = window.App || {};
  App.Games = App.Games || {};
  var UI = App.UI, el = UI.el;

  var RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
  var SUITS = ['♠', '♥', '♦', '♣']; // ♠ ♥ ♦ ♣

  function baseValue(rank) {
    if (rank === 'A') return 11;
    if (rank === 'K' || rank === 'Q' || rank === 'J') return 10;
    return parseInt(rank, 10);
  }
  function handValue(cards) {
    var sum = 0, aces = 0, i;
    for (i = 0; i < cards.length; i++) {
      sum += baseValue(cards[i].rank);
      if (cards[i].rank === 'A') aces++;
    }
    while (sum > 21 && aces > 0) { sum -= 10; aces--; }
    return sum;
  }
  function isBlackjack(cards) { return cards.length === 2 && handValue(cards) === 21; }
  function isRed(suit) { return suit === '♥' || suit === '♦'; }

  function buildShoe() {
    var s = [], d, si, ri, i, j, t;
    for (d = 0; d < 6; d++)
      for (si = 0; si < SUITS.length; si++)
        for (ri = 0; ri < RANKS.length; ri++)
          s.push({ rank: RANKS[ri], suit: SUITS[si] });
    // Fisher-Yates
    for (i = s.length - 1; i > 0; i--) {
      j = Math.floor(Math.random() * (i + 1));
      t = s[i]; s[i] = s[j]; s[j] = t;
    }
    return s;
  }

  var CSS =
    '.bj-stage{gap:22px;padding:24px 18px;}' +
    '.bj-hand{width:100%;display:flex;flex-direction:column;gap:10px;}' +
    '.bj-hand-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}' +
    '.bj-hand-name{font-weight:800;letter-spacing:1px;color:var(--leaf);font-size:15px;text-transform:uppercase;}' +
    '.bj-hand-val{font-weight:900;font-variant-numeric:tabular-nums;font-size:20px;color:var(--text);' +
      'min-width:34px;padding:2px 10px;border-radius:999px;background:rgba(4,16,10,.7);border:1px solid var(--stroke);}' +
    '.bj-hand-tag{font-size:12px;font-weight:800;letter-spacing:1px;padding:2px 9px;border-radius:999px;}' +
    '.bj-hand-tag.bj{color:#04160c;background:var(--gold);box-shadow:0 0 12px rgba(255,210,63,.55);}' +
    '.bj-hand-tag.bust{color:#fff;background:var(--danger);box-shadow:0 0 12px rgba(255,77,109,.5);}' +
    '.bj-cards{display:flex;flex-wrap:wrap;gap:9px;min-height:98px;align-items:center;}' +
    '.bj-card{position:relative;width:clamp(52px,15vw,68px);height:clamp(74px,21vw,96px);border-radius:9px;' +
      'background:linear-gradient(158deg,#ffffff,#e6f1ea);border:1px solid rgba(0,0,0,.28);' +
      'box-shadow:0 6px 15px rgba(0,0,0,.45);color:#14202b;font-weight:800;flex:0 0 auto;' +
      'user-select:none;-webkit-user-select:none;animation:bjDeal .34s cubic-bezier(.2,.8,.3,1.25) both;}' +
    '.bj-card.red{color:#d21f3c;}' +
    '.bj-card.dark{color:#14202b;}' +
    '.bj-corner{position:absolute;font-size:clamp(11px,3.4vw,14px);line-height:.92;text-align:center;font-weight:900;}' +
    '.bj-corner.tl{top:5px;left:6px;}' +
    '.bj-corner.br{bottom:5px;right:6px;transform:rotate(180deg);}' +
    '.bj-pip{position:absolute;inset:0;display:grid;place-items:center;font-size:clamp(24px,7vw,34px);}' +
    '.bj-card.back{color:var(--leaf);display:grid;place-items:center;border-color:rgba(57,255,20,.5);' +
      'background:' +
        "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='40' height='40' viewBox='0 0 40 40'%3E%3Cg fill='%2339ff14' opacity='0.2'%3E%3Cellipse cx='10' cy='10' rx='7' ry='3' transform='rotate(40 10 10)'/%3E%3Cellipse cx='30' cy='30' rx='7' ry='3' transform='rotate(40 30 30)'/%3E%3Cellipse cx='30' cy='8' rx='5' ry='2.4' transform='rotate(-40 30 8)'/%3E%3Cellipse cx='8' cy='30' rx='5' ry='2.4' transform='rotate(-40 8 30)'/%3E%3C/g%3E%3C/svg%3E\")," +
        'repeating-linear-gradient(45deg,rgba(57,255,20,.12) 0 7px,transparent 7px 14px),' +
        'radial-gradient(circle at 50% 42%,#0e4a2c,#05271a);' +
      'box-shadow:0 6px 15px rgba(0,0,0,.45),inset 0 0 0 2px rgba(57,255,20,.25);}' +
    '.bj-back-emoji{font-size:30px;filter:drop-shadow(0 0 7px var(--neon));}' +
    '.bj-card.flip{animation:bjFlip .36s ease both;}' +
    '@keyframes bjDeal{from{opacity:0;transform:translateY(-18px) rotate(-7deg) scale(.9);}to{opacity:1;transform:none;}}' +
    '@keyframes bjFlip{0%{transform:perspective(500px) rotateY(90deg);opacity:.15;}100%{transform:perspective(500px) rotateY(0);opacity:1;}}' +
    '.bj-banner{min-height:30px;font-weight:900;font-size:clamp(18px,4.8vw,26px);letter-spacing:1px;text-align:center;transition:.2s;}' +
    '.bj-banner.win{color:var(--neon);text-shadow:0 0 14px rgba(57,255,20,.6);}' +
    '.bj-banner.lose{color:var(--danger-2);text-shadow:0 0 12px rgba(255,77,109,.5);}' +
    '.bj-banner.push{color:var(--aqua-soft);}' +
    '.bj-banner.bj{color:var(--gold);text-shadow:0 0 16px rgba(255,210,63,.65);}' +
    '.bj-controls{display:flex;flex-direction:column;gap:16px;align-items:center;}' +
    '.bj-actions{display:flex;flex-wrap:wrap;gap:10px;justify-content:center;width:100%;}' +
    '.bj-actions .btn{min-width:104px;}' +
    '.bj-deal-row{width:100%;max-width:320px;}';

  App.Games.blackjack = {
    id: 'blackjack',
    title: 'Blackjack',
    icon: '🃏', // 🃏
    subtitle: 'Schlage den Dealer bis 21',

    render: function (root) {
      UI.injectStyle('game-blackjack-css', CSS);

      /* ---------- Zustand ---------- */
      var shoe = [];
      var player = [];
      var dealer = [];
      var roundBet = 0;      // Basiseinsatz der Runde
      var wager = 0;         // insgesamt gesetzt (bei Double doppelt)
      var doubled = false;
      var holeRevealed = false;
      var roundResolved = false;
      var phase = 'idle';    // 'idle' | 'player' | 'busy'
      var hiddenCardEl = null;
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
      var dealerCards = el('div', { class: 'bj-cards' });
      var dealerVal = el('span', { class: 'bj-hand-val' }, ['—']);
      var dealerTag = el('span', { class: 'bj-hand-tag' });
      var playerCards = el('div', { class: 'bj-cards' });
      var playerVal = el('span', { class: 'bj-hand-val' }, ['—']);
      var playerTag = el('span', { class: 'bj-hand-tag' });
      var banner = el('div', { class: 'bj-banner' }, ['Setze deinen Einsatz und gib die Karten.']);

      var stage = el('div', { class: 'game-stage bj-stage' }, [
        el('div', { class: 'bj-hand' }, [
          el('div', { class: 'bj-hand-head' }, [
            el('span', { class: 'bj-hand-name' }, ['Dealer']), dealerVal, dealerTag
          ]),
          dealerCards
        ]),
        banner,
        el('div', { class: 'bj-hand' }, [
          el('div', { class: 'bj-hand-head' }, [
            el('span', { class: 'bj-hand-name' }, ['Spieler']), playerVal, playerTag
          ]),
          playerCards
        ])
      ]);

      var betPanel = UI.createBetPanel({
        initial: 50,
        onChange: function () { if (phase === 'idle') refreshButtons(); }
      });

      var dealBtn = el('button', { class: 'btn btn-primary btn-lg btn-block', type: 'button' }, ['🍃 Geben']);
      var hitBtn = el('button', { class: 'btn btn-aqua', type: 'button' }, ['Hit']);
      var standBtn = el('button', { class: 'btn', type: 'button' }, ['Stand']);
      var doubleBtn = el('button', { class: 'btn', type: 'button' }, ['Double']);

      var panel = el('div', { class: 'game-panel glass bj-controls' }, [
        betPanel.root,
        el('div', { class: 'bj-deal-row' }, [dealBtn]),
        el('div', { class: 'bj-actions' }, [hitBtn, standBtn, doubleBtn]),
        el('p', { class: 'hint-text' }, ['Dealer zieht bis 17 · Blackjack zahlt 3:2 · Double nur mit 2 Karten'])
      ]);

      root.appendChild(stage);
      root.appendChild(panel);

      /* ---------- Karten-Rendering ---------- */
      function cardNode(card, hidden) {
        if (hidden) {
          return el('div', { class: 'bj-card back', html: '<span class="bj-back-emoji">🌴</span>' });
        }
        var cls = 'bj-card ' + (isRed(card.suit) ? 'red' : 'dark');
        var inner =
          '<span class="bj-corner tl">' + card.rank + '<br>' + card.suit + '</span>' +
          '<span class="bj-pip">' + card.suit + '</span>' +
          '<span class="bj-corner br">' + card.rank + '<br>' + card.suit + '</span>';
        return el('div', { class: cls, html: inner });
      }
      function addCard(container, card) {
        container.appendChild(cardNode(card, false));
      }
      function draw() { return shoe.pop(); }

      function revealHole() {
        if (holeRevealed) return;
        holeRevealed = true;
        if (hiddenCardEl && dealer[1]) {
          var real = dealer[1];
          hiddenCardEl.className = 'bj-card flip ' + (isRed(real.suit) ? 'red' : 'dark');
          hiddenCardEl.innerHTML =
            '<span class="bj-corner tl">' + real.rank + '<br>' + real.suit + '</span>' +
            '<span class="bj-pip">' + real.suit + '</span>' +
            '<span class="bj-corner br">' + real.rank + '<br>' + real.suit + '</span>';
        }
        updateValues();
      }

      function setTag(elm, cards) {
        if (isBlackjack(cards)) { elm.className = 'bj-hand-tag bj'; elm.textContent = 'Blackjack'; }
        else if (handValue(cards) > 21) { elm.className = 'bj-hand-tag bust'; elm.textContent = 'Bust'; }
        else { elm.className = 'bj-hand-tag'; elm.textContent = ''; }
      }
      function updateValues() {
        // Spieler
        playerVal.textContent = player.length ? handValue(player) : '—';
        setTag(playerTag, player);
        // Dealer
        if (!dealer.length) { dealerVal.textContent = '—'; dealerTag.textContent = ''; dealerTag.className = 'bj-hand-tag'; return; }
        if (!holeRevealed) {
          dealerVal.textContent = handValue([dealer[0]]) + ' + ?';
          dealerTag.textContent = ''; dealerTag.className = 'bj-hand-tag';
        } else {
          dealerVal.textContent = handValue(dealer);
          setTag(dealerTag, dealer);
        }
      }

      /* ---------- Buttons ---------- */
      function refreshButtons() {
        var canDeal = (phase === 'idle') && App.Coins.canBet(betPanel.getBet());
        dealBtn.disabled = !canDeal;
        betPanel.setDisabled(phase !== 'idle');
        var inTurn = (phase === 'player');
        hitBtn.disabled = !inTurn;
        standBtn.disabled = !inTurn;
        doubleBtn.disabled = !(inTurn && player.length === 2 && App.Coins.canBet(roundBet));
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
        wager = bet;
        doubled = false;
        holeRevealed = false;
        roundResolved = false;

        shoe = buildShoe();
        player = [draw(), draw()];
        dealer = [draw(), draw()];

        dealerCards.innerHTML = '';
        playerCards.innerHTML = '';
        banner.className = 'bj-banner';
        banner.textContent = '';

        // Karten mit kleiner Verzögerung reindealen (P, D, P, D-verdeckt)
        later(function () { addCard(playerCards, player[0]); }, 40);
        later(function () {
          hiddenCardEl = cardNode(dealer[0], false);
          dealerCards.appendChild(hiddenCardEl); // Dealer 1. Karte offen
          hiddenCardEl = null;
        }, 190);
        later(function () { addCard(playerCards, player[1]); updateValues(); }, 340);
        later(function () {
          hiddenCardEl = cardNode(dealer[1], true); // verdeckt
          dealerCards.appendChild(hiddenCardEl);
          updateValues();
        }, 490);

        // Naturals prüfen, nachdem alles ausgeteilt ist
        later(function () {
          var pBJ = isBlackjack(player), dBJ = isBlackjack(dealer);
          if (pBJ || dBJ) {
            revealHole();
            later(function () {
              if (pBJ && dBJ) endRound('push', 'Beide Blackjack');
              else if (pBJ) endRound('blackjack', null);
              else endRound('lose', 'Dealer Blackjack');
            }, 520);
          } else {
            setPhase('player');
          }
        }, 640);
      }

      function doHit() {
        if (phase !== 'player') return;
        setPhase('busy');
        player.push(draw());
        addCard(playerCards, player[player.length - 1]);
        updateValues();
        var v = handValue(player);
        if (v > 21) later(function () { endRound('lose', 'Überkauft'); }, 520);
        else if (v === 21) later(function () { beginDealer(); }, 480);
        else later(function () { setPhase('player'); }, 260);
      }

      function doDouble() {
        if (phase !== 'player' || player.length !== 2) return;
        if (!App.Coins.canBet(roundBet)) { UI.toast('Nicht genug Coins zum Verdoppeln', 'lose'); return; }
        setPhase('busy');
        App.Coins.add(-roundBet);
        wager += roundBet;
        doubled = true;
        player.push(draw());
        addCard(playerCards, player[player.length - 1]);
        updateValues();
        var v = handValue(player);
        if (v > 21) later(function () { endRound('lose', 'Überkauft'); }, 540);
        else later(function () { beginDealer(); }, 540);
      }

      function beginDealer() {
        setPhase('busy');
        revealHole();
        later(dealerStep, 700);
      }
      function dealerStep() {
        if (handValue(dealer) < 17) {
          dealer.push(draw());
          addCard(dealerCards, dealer[dealer.length - 1]);
          updateValues();
          later(dealerStep, 650);
        } else {
          var pv = handValue(player), dv = handValue(dealer);
          if (dv > 21) endRound('win', 'Dealer überkauft');
          else if (pv > dv) endRound('win', 'Höher als Dealer');
          else if (pv < dv) endRound('lose', 'Dealer höher');
          else endRound('push', null);
        }
      }

      function endRound(outcome, detail) {
        if (roundResolved) return;
        roundResolved = true;
        setPhase('busy');
        revealHole();
        updateValues();

        var payout = 0, cls = '', text = '', kind = 'info';
        if (outcome === 'blackjack') { payout = Math.round(roundBet * 2.5); cls = 'bj'; text = 'BLACKJACK!'; kind = 'win'; }
        else if (outcome === 'win') { payout = wager * 2; cls = 'win'; text = 'GEWONNEN'; kind = 'win'; }
        else if (outcome === 'push') { payout = wager; cls = 'push'; text = 'PUSH'; kind = 'info'; }
        else { payout = 0; cls = 'lose'; text = 'VERLOREN'; kind = 'lose'; }

        if (payout > 0) App.Coins.add(payout);
        var net = payout - wager;
        UI.flash(net, { label: text });

        banner.className = 'bj-banner ' + cls;
        banner.textContent = text + (detail ? ' · ' + detail : '') +
          (outcome === 'blackjack' ? ' 3:2' : '');
        UI.toast(text + (detail ? ' (' + detail + ')' : ''), kind);

        // Genau einmal pro Runde abrechnen
        betPanel.refresh();
        App.Coins.settle();
        setPhase('idle');
      }

      /* ---------- Events ---------- */
      dealBtn.addEventListener('click', deal);
      hitBtn.addEventListener('click', doHit);
      standBtn.addEventListener('click', function () { if (phase === 'player') beginDealer(); });
      doubleBtn.addEventListener('click', doDouble);

      setPhase('idle');
      updateValues();

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
