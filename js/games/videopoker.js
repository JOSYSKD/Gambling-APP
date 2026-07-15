/* videopoker.js — "Video Poker" (Jacks or Better) im Neon-Dschungel.
 *
 * Ablauf (Zustandsmaschine):
 *   'bet'    -> Einsatz setzen, "Geben" teilt 5 Karten aus (App.Coins.add(-bet)).
 *   'draw'   -> Karten anklicken = HALTEN togglen, "Tauschen" ersetzt die
 *               nicht gehaltenen Karten aus dem Restdeck.
 *   'result' -> Endblatt mit P.eval5 bewerten, Auszahlung gutschreiben,
 *               "Neue Runde" startet von vorn.
 *
 * Auszahlung (brutto = Einsatz × Faktor, Faktor 1 = Einsatz zurück / Push):
 *   Royal Flush 250 · Straight Flush 50 · Vierling 25 · Full House 9 ·
 *   Flush 6 · Straße 4 · Drilling 3 · Zwei Paare 2 · Paar Buben+ 1 · Rest 0.
 */
(function () {
  'use strict';
  window.App = window.App || {};
  App.Games = App.Games || {};
  var UI = App.UI, el = UI.el, P = App.Poker;

  /* Auszahlungstabelle: von oben (stark) nach unten (schwach). */
  var PAYTABLE = [
    { key: 'royal',    name: 'Royal Flush',    factor: 250 },
    { key: 'sf',       name: 'Straight Flush', factor: 50 },
    { key: 'quads',    name: 'Vierling',       factor: 25 },
    { key: 'fh',       name: 'Full House',     factor: 9 },
    { key: 'flush',    name: 'Flush',          factor: 6 },
    { key: 'straight', name: 'Straße',         factor: 4 },
    { key: 'trips',    name: 'Drilling',       factor: 3 },
    { key: 'twopair',  name: 'Zwei Paare',     factor: 2 },
    { key: 'jacks',    name: 'Paar (Buben o. besser)', factor: 1 }
  ];

  /* Ordnet eine 5-Karten-Bewertung einer Paytable-Zeile zu (oder null = kein Gewinn). */
  function evKey(ev) {
    switch (ev.cat) {
      case 8: return ev.tie[0] === 14 ? 'royal' : 'sf';
      case 7: return 'quads';
      case 6: return 'fh';
      case 5: return 'flush';
      case 4: return 'straight';
      case 3: return 'trips';
      case 2: return 'twopair';
      case 1: return ev.tie[0] >= 11 ? 'jacks' : null; // nur Buben/Damen/Könige/Asse
      default: return null;
    }
  }
  function factorFor(key) {
    for (var i = 0; i < PAYTABLE.length; i++) if (PAYTABLE[i].key === key) return PAYTABLE[i].factor;
    return 0;
  }

  function rankLabel(card) { var r = card[0]; return r === 'T' ? '10' : r; }
  function isRed(card) { var s = P.suitOf(card); return s === 'h' || s === 'd'; }

  function injectCss() {
    UI.injectStyle('game-videopoker-css', [
      '.vp-wrap{display:flex;flex-direction:column;gap:18px;}',
      '.vp-stage{gap:18px;padding:22px 16px;}',
      '.vp-banner{min-height:28px;font-weight:900;font-size:clamp(16px,4.6vw,24px);letter-spacing:1px;text-align:center;transition:.2s;color:var(--muted);}',
      '.vp-banner.win{color:var(--neon);text-shadow:0 0 14px rgba(57,255,20,.6);}',
      '.vp-banner.lose{color:var(--danger-2);text-shadow:0 0 12px rgba(255,77,109,.5);}',
      '.vp-banner.push{color:var(--aqua-soft);}',
      '.vp-banner.jackpot{color:var(--gold);text-shadow:0 0 18px rgba(255,210,63,.7);}',
      '.vp-sub{color:var(--muted);font-size:13px;text-align:center;min-height:16px;}',
      /* Kartenreihe */
      '.vp-hand{display:flex;flex-wrap:wrap;gap:clamp(6px,2vw,12px);justify-content:center;width:100%;}',
      '.vp-slot{position:relative;padding-top:24px;display:flex;flex-direction:column;align-items:center;}',
      '.vp-badge{position:absolute;top:0;left:50%;transform:translateX(-50%) translateY(4px);opacity:0;pointer-events:none;',
        'font-size:10px;font-weight:900;letter-spacing:1px;color:#04160c;background:linear-gradient(180deg,var(--neon-soft),var(--neon));',
        'padding:2px 9px;border-radius:999px;box-shadow:var(--glow);transition:opacity .16s,transform .16s;white-space:nowrap;}',
      '.vp-slot.held .vp-badge{opacity:1;transform:translateX(-50%) translateY(0);}',
      /* Karte */
      '.vp-card{position:relative;width:clamp(54px,15.5vw,74px);height:clamp(78px,22vw,104px);border-radius:10px;',
        'background:linear-gradient(158deg,#ffffff,#e6f1ea);border:1px solid rgba(0,0,0,.28);',
        'box-shadow:0 6px 15px rgba(0,0,0,.45);color:#14202b;font-weight:800;flex:0 0 auto;padding:0;',
        'font-family:inherit;cursor:default;user-select:none;-webkit-user-select:none;transition:transform .16s,box-shadow .16s,border-color .16s;}',
      '.vp-card.red{color:#d21f3c;}',
      '.vp-card.dark{color:#14202b;}',
      '.vp-can-hold .vp-card{cursor:pointer;}',
      '.vp-can-hold .vp-card:hover{transform:translateY(-4px);box-shadow:0 12px 22px rgba(0,0,0,.5);border-color:var(--neon);}',
      '.vp-slot.held .vp-card{transform:translateY(-8px);border-color:var(--neon);',
        'box-shadow:0 10px 22px rgba(0,0,0,.5),0 0 0 2px var(--neon),0 0 18px rgba(57,255,20,.55);}',
      '.vp-can-hold .vp-slot.held .vp-card:hover{transform:translateY(-11px);}',
      '.vp-corner{position:absolute;font-size:clamp(11px,3.3vw,14px);line-height:.9;text-align:center;font-weight:900;}',
      '.vp-corner.tl{top:6px;left:6px;}',
      '.vp-corner.br{bottom:6px;right:6px;transform:rotate(180deg);}',
      '.vp-center{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;}',
      '.vp-c-rank{font-size:clamp(20px,6vw,28px);line-height:1;font-weight:900;}',
      '.vp-c-suit{font-size:clamp(16px,4.6vw,22px);line-height:1;}',
      /* Rückseite */
      '.vp-card.back{color:var(--leaf);display:grid;place-items:center;border-color:rgba(57,255,20,.5);',
        'background:repeating-linear-gradient(45deg,rgba(57,255,20,.12) 0 7px,transparent 7px 14px),radial-gradient(circle at 50% 42%,#0e4a2c,#05271a);',
        'box-shadow:0 6px 15px rgba(0,0,0,.45),inset 0 0 0 2px rgba(57,255,20,.25);}',
      '.vp-back-emoji{font-size:26px;filter:drop-shadow(0 0 7px var(--neon));}',
      '.vp-deal{animation:vpDeal .34s cubic-bezier(.2,.8,.3,1.25) both;}',
      '@keyframes vpDeal{from{opacity:0;transform:translateY(-18px) rotate(-6deg) scale(.9);}to{opacity:1;transform:none;}}',
      /* Paytable */
      '.vp-pay{width:100%;border-collapse:collapse;font-size:13px;}',
      '.vp-pay caption{caption-side:top;text-align:left;color:var(--leaf);font-weight:800;text-transform:uppercase;letter-spacing:1px;font-size:12px;padding-bottom:8px;}',
      '.vp-pay td{padding:6px 10px;border-bottom:1px dashed var(--stroke);font-variant-numeric:tabular-nums;}',
      '.vp-pay .vp-p-name{color:var(--text);}',
      '.vp-pay .vp-p-mult{text-align:right;color:var(--gold);font-weight:800;white-space:nowrap;}',
      '.vp-pay .vp-p-coins{text-align:right;color:var(--muted);white-space:nowrap;}',
      '.vp-pay tr.hit{background:rgba(57,255,20,.14);}',
      '.vp-pay tr.hit td{border-bottom-color:var(--stroke-2);}',
      '.vp-pay tr.hit .vp-p-name{color:var(--neon);font-weight:900;text-shadow:0 0 10px rgba(57,255,20,.5);}',
      '.vp-pay tr.hit .vp-p-coins{color:var(--leaf);}',
      /* Steuerung */
      '.vp-controls{display:flex;flex-direction:column;gap:14px;align-items:center;}',
      '.vp-action{max-width:340px;}',
      '@media (max-width:520px){.vp-c-suit{font-size:16px;}}',
      '@media (prefers-reduced-motion:reduce){.vp-deal{animation:none;}.vp-card{transition:none;}}'
    ].join(''));
  }

  App.Games.videopoker = {
    id: 'videopoker',
    title: 'Video Poker',
    icon: '🃏',
    subtitle: 'Jacks or Better — halte Karten, tausche, kassiere',

    render: function (root) {
      injectCss();

      /* ---------- Zustand ---------- */
      var deck = [];
      var hand = [];                       // aktuelle 5 Karten (String-Format)
      var held = [false, false, false, false, false];
      var roundBet = 0;
      var phase = 'bet';                   // 'bet' | 'draw' | 'busy' | 'result'
      var destroyed = false;
      var timers = [];

      function later(fn, ms) {
        var id = setTimeout(function () {
          var idx = timers.indexOf(id);
          if (idx >= 0) timers.splice(idx, 1);
          if (!destroyed) fn();
        }, ms);
        timers.push(id);
        return id;
      }

      /* ---------- DOM: Bühne ---------- */
      var badges = [];
      var slots = [0, 1, 2, 3, 4].map(function (i) {
        var badge = el('div', { class: 'vp-badge' }, ['HALTEN']);
        badges[i] = badge;
        return el('div', { class: 'vp-slot' }, [badge]);
      });
      var handRow = el('div', { class: 'vp-hand' }, slots);
      var banner = el('div', { class: 'vp-banner' }, ['Setze deinen Einsatz und gib die Karten.']);
      var subline = el('div', { class: 'vp-sub' }, ['']);

      var stage = el('div', { class: 'game-stage vp-stage' }, [banner, handRow, subline]);

      /* ---------- DOM: Auszahlungstabelle ---------- */
      var payRows = {};   // key -> {tr, coins}
      var payBody = el('tbody');
      PAYTABLE.forEach(function (row) {
        var coins = el('td', { class: 'vp-p-coins' }, ['']);
        var tr = el('tr', {}, [
          el('td', { class: 'vp-p-name' }, [row.name]),
          el('td', { class: 'vp-p-mult' }, ['×' + row.factor]),
          coins
        ]);
        payRows[row.key] = { tr: tr, coins: coins };
        payBody.appendChild(tr);
      });
      var payTable = el('div', { class: 'glass game-panel' }, [
        el('table', { class: 'vp-pay' }, [
          el('caption', {}, ['Auszahlung (Einsatz × Faktor)']),
          payBody
        ])
      ]);

      /* ---------- DOM: Steuerung ---------- */
      var betPanel = UI.createBetPanel({
        initial: 50,
        onChange: function () { updatePayCoins(); if (phase === 'bet') refreshControls(); }
      });
      var actionMain = el('span', { class: 'btn-main' }, ['🍃 Geben']);
      var actionSub = el('span', { class: 'btn-sub' }, ['']);
      var actionBtn = el('button', { class: 'btn btn-primary btn-lg btn-block vp-action btn-2l', type: 'button' }, [actionMain, actionSub]);
      actionBtn.addEventListener('click', function () {
        if (phase === 'bet') deal();
        else if (phase === 'draw') drawSwap();
        else if (phase === 'result') newRound();
      });

      var controls = el('div', { class: 'game-panel glass vp-controls' }, [
        betPanel.root,
        actionBtn,
        el('p', { class: 'hint-text' }, ['Karten anklicken zum Halten · Paar Buben o. besser zahlt aus'])
      ]);

      root.appendChild(el('div', { class: 'vp-wrap' }, [stage, payTable, controls]));

      /* ---------- Karten-Rendering ---------- */
      function paintCard(i, animate) {
        var slot = slots[i];
        slot.classList.toggle('held', !!held[i]);
        while (slot.childNodes.length > 1) slot.removeChild(slot.lastChild); // Badge (Index 0) behalten
        var card = hand[i], node;
        if (!card) {
          node = el('button', {
            class: 'vp-card back' + (animate ? ' vp-deal' : ''), type: 'button', tabindex: '-1', 'aria-hidden': 'true',
            html: '<span class="vp-back-emoji">🌴</span>'
          });
        } else {
          var r = rankLabel(card), sym = P.SUIT_SYM[P.suitOf(card)];
          node = el('button', {
            class: 'vp-card ' + (isRed(card) ? 'red' : 'dark') + (animate ? ' vp-deal' : ''),
            type: 'button', 'aria-label': r + ' ' + sym,
            html:
              '<span class="vp-corner tl">' + r + '<br>' + sym + '</span>' +
              '<span class="vp-center"><span class="vp-c-rank">' + r + '</span><span class="vp-c-suit">' + sym + '</span></span>' +
              '<span class="vp-corner br">' + r + '<br>' + sym + '</span>',
            onclick: function () { toggleHold(i); }
          });
        }
        slot.appendChild(node);
      }

      function paintAll(animate) { for (var i = 0; i < 5; i++) paintCard(i, animate); }

      function toggleHold(i) {
        if (phase !== 'draw') return;
        held[i] = !held[i];
        slots[i].classList.toggle('held', held[i]);
        if (held[i] && App.Audio) App.Audio.sfx('select');   // Karte eingerastet
      }

      /* ---------- Paytable-Helfer ---------- */
      function updatePayCoins() {
        var bet = betPanel.getBet();
        PAYTABLE.forEach(function (row) {
          payRows[row.key].coins.textContent = UI.formatCoins(bet * row.factor) + ' 🪙';
        });
      }
      function highlightPay(key) {
        PAYTABLE.forEach(function (row) {
          payRows[row.key].tr.classList.toggle('hit', row.key === key);
        });
      }

      /* ---------- Steuerung / Phasen ---------- */
      function setBanner(text, cls) {
        banner.className = 'vp-banner' + (cls ? ' ' + cls : '');
        banner.textContent = text;
      }
      function refreshControls() {
        betPanel.setDisabled(phase !== 'bet');
        handRow.classList.toggle('vp-can-hold', phase === 'draw');
        if (phase === 'bet') {
          actionMain.textContent = '🍃 Geben';
          actionSub.textContent = 'Einsatz ' + UI.formatCoins(betPanel.getBet()) + ' 🪙';
          actionBtn.className = 'btn btn-primary btn-lg btn-block vp-action btn-2l';
          actionBtn.disabled = !App.Coins.canBet(betPanel.getBet());
        } else if (phase === 'draw') {
          actionMain.textContent = '🔄 Tauschen';
          actionSub.textContent = 'Einsatz ' + UI.formatCoins(roundBet) + ' 🪙';
          actionBtn.className = 'btn btn-aqua btn-lg btn-block vp-action btn-2l';
          actionBtn.disabled = false;
        } else if (phase === 'result') {
          actionMain.textContent = '🃏 Neue Runde';
          actionSub.textContent = 'Einsatz ' + UI.formatCoins(betPanel.getBet()) + ' 🪙';
          actionBtn.className = 'btn btn-primary btn-lg btn-block vp-action btn-2l';
          actionBtn.disabled = false;
        } else { // busy
          actionBtn.disabled = true;
        }
      }

      /* ---------- Runde ---------- */
      function deal() {
        if (phase !== 'bet') return;
        var bet = betPanel.getBet();
        if (!App.Coins.canBet(bet)) { UI.toast('Nicht genug Coins', 'lose'); return; }

        phase = 'busy';
        refreshControls();
        App.Coins.add(-bet);
        roundBet = bet;

        deck = P.shuffle(P.makeDeck());
        hand = [deck.pop(), deck.pop(), deck.pop(), deck.pop(), deck.pop()];
        held = [false, false, false, false, false];

        highlightPay(null);
        setBanner('Wähle Karten zum HALTEN', null);
        subline.textContent = 'Angeklickte Karten bleiben — der Rest wird getauscht.';
        paintAll(true);
        // 5 Karten nacheinander austeilen (hörbar gestaffelt)
        if (App.Audio) for (var d = 0; d < 5; d++) (function (k) { later(function () { App.Audio.sfx('deal'); }, k * 75); })(d);

        // Blatt-Vorschau, sobald die Deal-Animation durch ist
        later(function () {
          phase = 'draw';
          previewHand();
          refreshControls();
        }, 380);
      }

      function previewHand() {
        var ev = P.eval5(hand);
        var key = evKey(ev);
        highlightPay(key);
        if (key) subline.textContent = 'Aktuell: ' + P.handName(ev) + ' — halten oder auf mehr gehen?';
        else subline.textContent = 'Aktuell: ' + P.handName(ev) + ' — noch keine Auszahlung.';
      }

      function drawSwap() {
        if (phase !== 'draw') return;
        phase = 'busy';
        refreshControls();
        var swapped = 0;
        for (var i = 0; i < 5; i++) {
          if (!held[i]) {
            hand[i] = deck.pop(); paintCard(i, true);
            if (App.Audio) (function (k) { later(function () { App.Audio.sfx('deal'); }, k * 75); })(swapped);
            swapped++;
          }
        }
        setBanner('Karten getauscht…', null);
        subline.textContent = swapped ? (swapped + (swapped === 1 ? ' Karte' : ' Karten') + ' getauscht') : 'Alle Karten gehalten';
        later(resolve, swapped ? 400 : 200);
      }

      function resolve() {
        var ev = P.eval5(hand);
        var key = evKey(ev);
        var factor = factorFor(key);
        var name = P.handName(ev);
        var payout = roundBet * factor;
        var net = payout - roundBet;

        if (payout > 0) App.Coins.add(payout);
        highlightPay(key);

        var cls, toastKind, head;
        if (factor >= 25) { cls = 'jackpot'; toastKind = 'win'; head = '💎 ' + (key === 'royal' ? 'ROYAL FLUSH!' : name.toUpperCase()); if (App.Audio) App.Audio.sfx('jackpot'); }
        else if (factor > 1) { cls = 'win'; toastKind = 'win'; head = 'GEWONNEN'; }
        else if (factor === 1) { cls = 'push'; toastKind = 'info'; head = 'PUSH'; }
        else { cls = 'lose'; toastKind = 'lose'; head = 'VERLOREN'; }

        setBanner(head + ' · ' + name, cls);
        subline.textContent = factor >= 1
          ? 'Auszahlung ×' + factor + ' = ' + UI.formatCoins(payout) + ' 🪙' + (net > 0 ? ' (+' + UI.formatCoins(net) + ')' : (net === 0 ? ' (Einsatz zurück)' : ''))
          : 'Kein Gewinn — mindestens ein Paar Buben nötig.';

        UI.flash(net, { label: name });
        UI.toast(head + ' · ' + name, toastKind);

        phase = 'result';
        betPanel.refresh();
        updatePayCoins();
        App.Coins.settle();
        refreshControls();
      }

      function newRound() {
        phase = 'bet';
        hand = [];
        held = [false, false, false, false, false];
        highlightPay(null);
        setBanner('Setze deinen Einsatz und gib die Karten.', null);
        subline.textContent = '';
        paintAll(false); // Rückseiten
        updatePayCoins();
        refreshControls();
      }

      /* ---------- Initialisierung ---------- */
      paintAll(false);
      updatePayCoins();
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
