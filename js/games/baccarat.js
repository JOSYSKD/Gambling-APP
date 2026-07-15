/* baccarat.js — Baccarat (Punto Banco) im Neon-Dschungel.
 *
 * Regeln:
 *   - Frisch gemischtes 52er-Deck pro Runde (Fisher-Yates, Math.random).
 *   - Kartenwerte: 2–9 = Nennwert, 10/J/Q/K = 0, Ass = 1.
 *     Handwert = (Summe der Kartenwerte) mod 10 → immer 0–9.
 *   - Spieler wettet vor dem Deal auf Spieler / Bank / Unentschieden.
 *   - Je 2 Karten an Spieler (Player) und Bank (Banker).
 *   - Natural: hat eine Seite mit den ersten 2 Karten 8 oder 9 → sofort Stopp.
 *   - Dritte-Karte-Regel (Standard-Punto-Banco):
 *       Player zieht 3. Karte bei 0–5, steht bei 6–7.
 *       Banker (wenn Player NICHT gezogen hat): zieht bei 0–5, steht bei 6–7.
 *       Banker (wenn Player gezogen hat, P3 = Wert der 3. Player-Karte):
 *         0–2 zieht immer · 3 zieht außer P3=8 · 4 zieht bei P3 2–7 ·
 *         5 zieht bei P3 4–7 · 6 zieht bei P3 6–7 · 7 steht.
 *   - Auszahlung (brutto, inkl. Einsatz):
 *       Spieler-Wette gewinnt 2× (1:1).
 *       Bank-Wette   gewinnt floor(1.95×) (1:1 minus 5% Kommission).
 *       Tie-Wette    gewinnt 9× (8:1).
 *     Bei Unentschieden werden Spieler-/Bank-Wetten als Push zurückgegeben.
 */
(function () {
  'use strict';
  window.App = window.App || {};
  App.Games = App.Games || {};
  var UI = App.UI, el = UI.el;

  var RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
  var SUITS = ['♠', '♥', '♦', '♣'];

  var CHOICES = [
    { key: 'player', label: 'Spieler', pay: '1:1',      mult: 2,    chance: '44,6%' },
    { key: 'banker', label: 'Bank',    pay: '1:1 −5%',   mult: 1.95, chance: '45,9%' },
    { key: 'tie',    label: 'Unent.',  pay: '8:1',       mult: 9,    chance: '9,5%' }
  ];

  function pointVal(rank) {
    if (rank === 'A') return 1;
    if (rank === '10' || rank === 'J' || rank === 'Q' || rank === 'K') return 0;
    return parseInt(rank, 10);
  }
  function handTotal(cards) {
    var s = 0, i;
    for (i = 0; i < cards.length; i++) s += pointVal(cards[i].rank);
    return s % 10;
  }
  function isRed(suit) { return suit === '♥' || suit === '♦'; }

  function buildDeck() {
    var d = [], si, ri, i, j, t;
    for (si = 0; si < SUITS.length; si++)
      for (ri = 0; ri < RANKS.length; ri++)
        d.push({ rank: RANKS[ri], suit: SUITS[si] });
    for (i = d.length - 1; i > 0; i--) {
      j = Math.floor(Math.random() * (i + 1));
      t = d[i]; d[i] = d[j]; d[j] = t;
    }
    return d;
  }

  /* Vollständige Runde deterministisch aus dem Deck ausspielen.
     Liefert die fertigen Hände; die Reveal-Animation läuft danach. */
  function playHand(deck) {
    var p = [], b = [];
    p.push(deck.pop()); b.push(deck.pop());
    p.push(deck.pop()); b.push(deck.pop());

    var pv = handTotal(p), bv = handTotal(b);
    var natural = (pv >= 8 || bv >= 8);
    var playerThird = null;

    if (!natural) {
      if (pv <= 5) {
        p.push(deck.pop());
        playerThird = pointVal(p[2].rank);
        pv = handTotal(p);
      }
      var bankerDraws;
      if (playerThird === null) {
        // Player stand (6–7): Banker zieht bei 0–5, steht 6–7.
        bankerDraws = (bv <= 5);
      } else {
        var t = playerThird;
        if (bv <= 2) bankerDraws = true;
        else if (bv === 3) bankerDraws = (t !== 8);
        else if (bv === 4) bankerDraws = (t >= 2 && t <= 7);
        else if (bv === 5) bankerDraws = (t >= 4 && t <= 7);
        else if (bv === 6) bankerDraws = (t >= 6 && t <= 7);
        else bankerDraws = false; // bv === 7 → steht
      }
      if (bankerDraws) { b.push(deck.pop()); bv = handTotal(b); }
    }
    return { player: p, banker: b };
  }

  function injectCss() {
    UI.injectStyle('game-baccarat-css', [
      '.bac-wrap{display:flex;flex-direction:column;gap:18px;}',
      '.bac-stage{gap:16px;padding:22px 16px;}',
      '.bac-hand{width:100%;display:flex;flex-direction:column;gap:9px;}',
      '.bac-hand-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}',
      '.bac-hand-name{font-weight:800;letter-spacing:1px;font-size:14px;text-transform:uppercase;}',
      '.bac-hand-name.player{color:var(--aqua-soft);}',
      '.bac-hand-name.banker{color:var(--gold);}',
      '.bac-hand-val{font-weight:900;font-variant-numeric:tabular-nums;font-size:20px;color:var(--text);',
        'min-width:34px;text-align:center;padding:2px 10px;border-radius:999px;',
        'background:rgba(4,16,10,.7);border:1px solid var(--stroke);transition:box-shadow .25s,border-color .25s;}',
      '.bac-hand-val.lit-p{border-color:var(--aqua);box-shadow:0 0 14px rgba(45,226,230,.6);color:var(--aqua-soft);}',
      '.bac-hand-val.lit-b{border-color:var(--gold);box-shadow:0 0 14px rgba(255,210,63,.6);color:var(--gold);}',
      '.bac-hand-tag{font-size:11px;font-weight:800;letter-spacing:1px;padding:2px 9px;border-radius:999px;',
        'color:#04160c;background:var(--gold);box-shadow:0 0 12px rgba(255,210,63,.55);}',
      '.bac-cards{display:flex;flex-wrap:wrap;gap:9px;min-height:98px;align-items:center;}',
      '.bac-card{position:relative;width:clamp(52px,15vw,68px);height:clamp(74px,21vw,96px);border-radius:9px;',
        'background:linear-gradient(158deg,#ffffff,#e6f1ea);border:1px solid rgba(0,0,0,.28);',
        'box-shadow:0 6px 15px rgba(0,0,0,.45);color:#14202b;font-weight:800;flex:0 0 auto;',
        'user-select:none;-webkit-user-select:none;animation:bacDeal .34s cubic-bezier(.2,.8,.3,1.25) both;}',
      '.bac-card.red{color:#d21f3c;}',
      '.bac-card.dark{color:#14202b;}',
      '.bac-corner{position:absolute;font-size:clamp(11px,3.4vw,14px);line-height:.92;text-align:center;font-weight:900;}',
      '.bac-corner.tl{top:5px;left:6px;}',
      '.bac-corner.br{bottom:5px;right:6px;transform:rotate(180deg);}',
      '.bac-pip{position:absolute;inset:0;display:grid;place-items:center;font-size:clamp(24px,7vw,34px);}',
      '@keyframes bacDeal{from{opacity:0;transform:translateY(-18px) rotate(-7deg) scale(.9);}to{opacity:1;transform:none;}}',
      '.bac-banner{min-height:30px;font-weight:900;font-size:clamp(17px,4.6vw,25px);letter-spacing:1px;text-align:center;transition:.2s;}',
      '.bac-banner.win{color:var(--neon);text-shadow:0 0 14px rgba(57,255,20,.6);}',
      '.bac-banner.lose{color:var(--danger-2);text-shadow:0 0 12px rgba(255,77,109,.5);}',
      '.bac-banner.push{color:var(--aqua-soft);text-shadow:0 0 12px rgba(45,226,230,.45);}',
      '.bac-controls{display:flex;flex-direction:column;gap:16px;}',
      '.bac-section-title{text-align:center;color:var(--leaf);font-weight:800;font-size:12px;text-transform:uppercase;letter-spacing:1px;}',
      '.bac-choices{display:flex;gap:10px;flex-wrap:wrap;}',
      '.bac-choice{flex:1 1 96px;min-width:88px;display:flex;flex-direction:column;align-items:center;gap:3px;',
        'padding:12px 8px;line-height:1.1;}',
      '.bac-choice .bac-c-label{font-weight:800;font-size:14px;}',
      '.bac-choice .bac-c-pay{font-size:11px;color:var(--muted);letter-spacing:.5px;}',
      '.bac-choice.active .bac-c-pay{color:inherit;opacity:.85;}',
      '.bac-choice .bac-c-win{font-size:12px;font-weight:900;color:var(--gold);letter-spacing:.3px;font-variant-numeric:tabular-nums;}',
      '.bac-choice.active .bac-c-win{color:inherit;}',
      '.bac-choice.active.player{color:#04160c;background:linear-gradient(180deg,var(--aqua-soft),var(--aqua));border-color:var(--aqua);box-shadow:0 0 16px rgba(45,226,230,.5);}',
      '.bac-choice.active.banker{color:#1a1200;background:linear-gradient(180deg,var(--gold),#d9a521);border-color:var(--gold);box-shadow:0 0 16px rgba(255,210,63,.5);}',
      '.bac-choice.active.tie{color:#04160c;background:linear-gradient(180deg,var(--neon-soft),var(--neon));border-color:var(--neon);box-shadow:var(--glow);}',
      '.bac-info{display:flex;flex-wrap:wrap;gap:8px 22px;justify-content:center;}',
      '.bac-info-item{text-align:center;}',
      '.bac-info-l{display:block;color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:1px;}',
      '.bac-info-v{font-size:20px;font-weight:900;font-variant-numeric:tabular-nums;color:var(--leaf);}',
      '.bac-info-v.gold{color:var(--gold);}',
      '.bac-info-v.aqua{color:var(--aqua-soft);}',
      '.bac-betrow{display:flex;flex-wrap:wrap;gap:16px;align-items:flex-end;justify-content:center;}',
      '.bac-betrow .bet-panel{flex:1 1 240px;}',
      '.bac-deal{flex:1 1 220px;}',
      '@media (prefers-reduced-motion:reduce){.bac-card{animation:none;}}'
    ].join(''));
  }

  App.Games.baccarat = {
    id: 'baccarat',
    title: 'Baccarat',
    icon: '🎴',
    subtitle: 'Punto Banco — setze auf Spieler, Bank oder Unentschieden',

    render: function (root) {
      injectCss();

      /* ---------- Zustand ---------- */
      var phase = 'idle';          // 'idle' | 'busy'
      var choice = 'player';       // aktuelle Wettauswahl
      var roundChoice = 'player';  // Snapshot der Runde
      var roundBet = 0;
      var player = [], banker = [];
      var pShown = 0, bShown = 0;
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

      /* ---------- DOM: Tisch ---------- */
      var bankerCards = el('div', { class: 'bac-cards' });
      var bankerVal = el('span', { class: 'bac-hand-val' }, ['—']);
      var bankerTag = el('span', { class: 'bac-hand-tag', text: '' });
      var playerCards = el('div', { class: 'bac-cards' });
      var playerVal = el('span', { class: 'bac-hand-val' }, ['—']);
      var playerTag = el('span', { class: 'bac-hand-tag', text: '' });
      var banner = el('div', { class: 'bac-banner' }, ['Wähle eine Wette und gib die Karten.']);

      var stage = el('div', { class: 'game-stage bac-stage' }, [
        el('div', { class: 'bac-hand' }, [
          el('div', { class: 'bac-hand-head' }, [
            el('span', { class: 'bac-hand-name banker' }, ['Bank']), bankerVal, bankerTag
          ]),
          bankerCards
        ]),
        banner,
        el('div', { class: 'bac-hand' }, [
          el('div', { class: 'bac-hand-head' }, [
            el('span', { class: 'bac-hand-name player' }, ['Spieler']), playerVal, playerTag
          ]),
          playerCards
        ])
      ]);

      /* ---------- DOM: Wettauswahl ---------- */
      var choiceWinSpans = {};
      var choiceBtns = CHOICES.map(function (c) {
        var winSpan = el('span', { class: 'bac-c-win' }, ['']);
        choiceWinSpans[c.key] = winSpan;
        return el('button', {
          class: 'btn bac-choice ' + c.key + (choice === c.key ? ' active' : ''),
          type: 'button',
          onclick: function () { if (phase === 'idle') selectChoice(c.key); }
        }, [
          el('span', { class: 'bac-c-label', text: c.label }),
          el('span', { class: 'bac-c-pay', text: c.pay }),
          winSpan
        ]);
      });
      var choiceRow = el('div', { class: 'bac-choices' }, choiceBtns);

      /* ---------- DOM: Info ---------- */
      var multV = el('div', { class: 'bac-info-v gold' });
      var chanceV = el('div', { class: 'bac-info-v aqua' });
      var winV = el('div', { class: 'bac-info-v' });
      var infoRow = el('div', { class: 'bac-info' }, [
        el('div', { class: 'bac-info-item' }, [el('span', { class: 'bac-info-l' }, ['Auszahlung']), multV]),
        el('div', { class: 'bac-info-item' }, [el('span', { class: 'bac-info-l' }, ['Gewinnchance']), chanceV]),
        el('div', { class: 'bac-info-item' }, [el('span', { class: 'bac-info-l' }, ['Möglicher Gewinn']), winV])
      ]);

      /* ---------- DOM: Einsatz + Geben ---------- */
      var betPanel = UI.createBetPanel({
        initial: 50,
        onChange: function () { updateInfo(); if (phase === 'idle') refreshControls(); }
      });
      var dealSub = el('span', { class: 'btn-sub' }, ['']);
      var dealBtn = el('button', {
        class: 'btn btn-primary btn-lg bac-deal btn-2l', type: 'button', onclick: deal
      }, [
        el('span', { class: 'btn-main' }, ['🍃 Geben']),
        dealSub
      ]);
      var betRow = el('div', { class: 'bac-betrow' }, [betPanel.root, dealBtn]);

      var controls = el('div', { class: 'game-panel glass bac-controls' }, [
        el('div', { class: 'bac-section-title' }, ['Wette']),
        choiceRow,
        infoRow,
        betRow,
        el('p', { class: 'hint-text' }, ['Natural 8/9 stoppt sofort · Bank-Kommission 5% · Tie ist Push für Spieler/Bank'])
      ]);

      root.appendChild(el('div', { class: 'bac-wrap' }, [stage, controls]));

      /* ---------- Karten-Rendering ---------- */
      function cardNode(card) {
        var cls = 'bac-card ' + (isRed(card.suit) ? 'red' : 'dark');
        var inner =
          '<span class="bac-corner tl">' + card.rank + '<br>' + card.suit + '</span>' +
          '<span class="bac-pip">' + card.suit + '</span>' +
          '<span class="bac-corner br">' + card.rank + '<br>' + card.suit + '</span>';
        return el('div', { class: cls, html: inner });
      }

      function updateValues() {
        var pv = pShown ? handTotal(player.slice(0, pShown)) : null;
        var bv = bShown ? handTotal(banker.slice(0, bShown)) : null;
        playerVal.textContent = pv === null ? '—' : pv;
        bankerVal.textContent = bv === null ? '—' : bv;
        // Natural-Tag, sobald die ersten zwei Karten liegen
        setNaturalTag(playerTag, player, pShown);
        setNaturalTag(bankerTag, banker, bShown);
      }
      function setNaturalTag(tagEl, cards, shown) {
        if (shown >= 2 && cards.length === 2) {
          var v = handTotal(cards.slice(0, 2));
          if (v >= 8) { tagEl.textContent = 'Natural ' + v; return; }
        }
        tagEl.textContent = '';
      }

      /* ---------- Wettauswahl / Info ---------- */
      function selectChoice(key) {
        choice = key;
        choiceBtns.forEach(function (b, i) {
          b.classList.toggle('active', CHOICES[i].key === key);
        });
        updateInfo();
      }
      function netWinFor(key, bet) {
        if (key === 'player') return 2 * bet - bet;
        if (key === 'banker') return Math.floor(1.95 * bet) - bet;
        return 9 * bet - bet; // tie
      }
      function updateInfo() {
        var def = CHOICES[choice === 'player' ? 0 : choice === 'banker' ? 1 : 2];
        var bet = betPanel.getBet();
        multV.textContent = def.mult.toFixed(2) + '×';
        chanceV.textContent = def.chance;
        winV.textContent = '+' + UI.formatCoins(netWinFor(choice, bet));
        CHOICES.forEach(function (c) {
          choiceWinSpans[c.key].textContent = '+' + UI.formatCoins(netWinFor(c.key, bet));
        });
        dealSub.textContent = 'Einsatz ' + UI.formatCoins(bet) + ' 🪙';
      }

      /* ---------- Steuerung ---------- */
      function refreshControls() {
        var idle = phase === 'idle';
        betPanel.setDisabled(!idle);
        choiceBtns.forEach(function (b) { b.disabled = !idle; });
        dealBtn.disabled = !(idle && App.Coins.canBet(betPanel.getBet()));
      }
      function setPhase(p) { phase = p; refreshControls(); }

      /* ---------- Runde ---------- */
      function deal() {
        if (phase !== 'idle') return;
        var bet = betPanel.getBet();
        if (!App.Coins.canBet(bet)) { UI.toast('Nicht genug Coins', 'lose'); return; }

        setPhase('busy');
        App.Coins.add(-bet);
        roundBet = bet;
        roundChoice = choice;

        var deck = buildDeck();
        var result = playHand(deck);
        player = result.player;
        banker = result.banker;
        pShown = 0; bShown = 0;

        bankerCards.innerHTML = '';
        playerCards.innerHTML = '';
        bankerTag.textContent = '';
        playerTag.textContent = '';
        bankerVal.className = 'bac-hand-val';
        playerVal.className = 'bac-hand-val';
        banner.className = 'bac-banner';
        banner.textContent = 'Karten werden gegeben…';

        // Reihenfolge des Aufdeckens: P1, B1, P2, B2, [P3], [B3]
        var reveals = [
          { side: 'p', idx: 0 }, { side: 'b', idx: 0 },
          { side: 'p', idx: 1 }, { side: 'b', idx: 1 }
        ];
        if (player.length > 2) reveals.push({ side: 'p', idx: 2 });
        if (banker.length > 2) reveals.push({ side: 'b', idx: 2 });

        var t = 60, GAP = 320, i;
        for (i = 0; i < reveals.length; i++) {
          (function (r) { later(function () { showCard(r); }, t); })(reveals[i]);
          t += GAP;
        }
        later(resolve, t + 260);
      }

      function showCard(r) {
        if (App.Audio) App.Audio.sfx('deal');
        if (r.side === 'p') {
          playerCards.appendChild(cardNode(player[r.idx]));
          pShown++;
        } else {
          bankerCards.appendChild(cardNode(banker[r.idx]));
          bShown++;
        }
        updateValues();
      }

      function resolve() {
        pShown = player.length; bShown = banker.length;
        updateValues();

        var pv = handTotal(player), bv = handTotal(banker);
        var winner = pv > bv ? 'player' : (bv > pv ? 'banker' : 'tie');

        // Gewinner-Hand hervorheben
        if (winner === 'player') playerVal.className = 'bac-hand-val lit-p';
        else if (winner === 'banker') bankerVal.className = 'bac-hand-val lit-b';

        var bet = roundBet, ch = roundChoice;
        var payout = 0, userWon = false, push = false;

        if (ch === 'tie') {
          if (winner === 'tie') { userWon = true; payout = 9 * bet; }
        } else if (winner === 'tie') {
          push = true; payout = bet; // Einsatz zurück
        } else if (winner === ch) {
          userWon = true;
          payout = ch === 'player' ? 2 * bet : Math.floor(1.95 * bet);
        }

        if (payout > 0) App.Coins.add(payout);
        var net = payout - bet;

        // Banner-Text
        var wname = winner === 'player' ? 'SPIELER' : winner === 'banker' ? 'BANK' : 'UNENTSCHIEDEN';
        var head = winner === 'tie' ? 'UNENTSCHIEDEN' : wname + ' GEWINNT';
        var score = 'Spieler ' + pv + ' : ' + bv + ' Bank';

        if (userWon) {
          banner.className = 'bac-banner win';
          UI.toast('Gewonnen! ' + (winner === 'tie' ? 'Unentschieden' : wname), 'win');
        } else if (push) {
          banner.className = 'bac-banner push';
          UI.toast('Unentschieden — Einsatz zurück', 'info');
        } else {
          banner.className = 'bac-banner lose';
          UI.toast('Verloren — ' + head, 'lose');
        }
        banner.textContent = head + ' · ' + score;
        UI.flash(net, { label: head });

        // Runde abschließen
        setPhase('idle');
        betPanel.refresh();
        updateInfo();
        App.Coins.settle();
      }

      /* ---------- Init ---------- */
      selectChoice('player');
      updateInfo();
      refreshControls();

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
