/* chips.js — Pokerchips: eigene "High-Roller"-Währung  (App.Chips)
 *
 * Chips sind von Coins getrennt und werden ausschließlich über die Chip-Kasse
 * gegen Coins getauscht (Kurs: RATE Coins = 1 Chip, in beide Richtungen ohne
 * Gebühr). Poker-Spiele (aktuell Video Poker) setzen NICHT mehr in Coins,
 * sondern in Chips — daher braucht man zuerst einen Umtausch in der Kasse
 * (Route #/chips), bevor man dort spielen kann.
 *
 * Anzeige: Chip-Beträge werden als Stapel farbiger Chip-Wertstufen (DENOMS)
 * dargestellt, ähnlich echten Pokerchips (weiß=1 … pink=10.000).
 */
(function () {
  'use strict';
  window.App = window.App || {};
  var KEY_BAL = 'gj_chips';
  var RATE = 100000;      // 1 Chip = 100.000 Coins
  var MIN_BET = 1;

  var DENOMS = [
    { v: 10000, color: '#ec4899', label: '10K' },
    { v: 5000,  color: '#f97316', label: '5K' },
    { v: 1000,  color: '#eab308', label: '1K' },
    { v: 500,   color: '#8b5cf6', label: '500' },
    { v: 100,   color: '#1c1c1c', label: '100' },
    { v: 25,    color: '#2e9e5b', label: '25' },
    { v: 10,    color: '#3b82c4', label: '10' },
    { v: 5,     color: '#e6483c', label: '5' },
    { v: 1,     color: '#f5f5f5', label: '1' }
  ];

  function loadBalance() {
    var b = App.Storage.get(KEY_BAL, 0);
    if (typeof b !== 'number' || !isFinite(b) || b < 0) b = 0;
    return Math.floor(b);
  }
  var balance = loadBalance();
  function save() { App.Storage.set(KEY_BAL, balance); }

  var listeners = { change: [], wager: [], outcome: [] };
  function on(evt, cb) {
    (listeners[evt] || (listeners[evt] = [])).push(cb);
    return function () { var a = listeners[evt], i = a.indexOf(cb); if (i >= 0) a.splice(i, 1); };
  }
  function emit(evt, payload) {
    var a = listeners[evt] || [];
    for (var i = 0; i < a.length; i++) { try { a[i](payload); } catch (e) {} }
  }

  /** Chip-Stapel für einen Betrag berechnen: [{denom, color, label, count}, …] (größte zuerst). */
  function stackFor(amount) {
    amount = Math.max(0, Math.floor(amount));
    var out = [];
    DENOMS.forEach(function (d) {
      var count = Math.floor(amount / d.v);
      if (count > 0) { out.push({ denom: d.v, color: d.color, label: d.label, count: count }); amount -= count * d.v; }
    });
    return out;
  }

  var Chips = {
    RATE: RATE,
    MIN_BET: MIN_BET,
    DENOMS: DENOMS,

    get: function () { return balance; },
    onChange: function (cb) { return on('change', cb); },
    onWager: function (cb) { return on('wager', cb); },
    onOutcome: function (cb) { return on('outcome', cb); },

    canBet: function (amount) {
      amount = Number(amount);
      return isFinite(amount) && amount >= MIN_BET && amount <= balance;
    },

    /** Chip-Guthaben um delta ändern (Einsatz negativ = Wager-Event, Gewinn positiv). Für Spiele. */
    add: function (delta) {
      delta = Math.round(Number(delta) || 0);
      balance = Math.max(0, balance + delta);
      save();
      emit('change', balance);
      if (delta < 0) emit('wager', -delta);
      return balance;
    },

    /** Guthaben um amount erhöhen (Brutto-Auszahlung), OHNE Wager/Outcome-Event — für reportOutcome(net). */
    credit: function (amount) {
      amount = Math.round(Number(amount) || 0);
      if (!amount) return balance;
      balance = Math.max(0, balance + amount);
      save();
      emit('change', balance);
      return balance;
    },

    /** Rundenergebnis (Netto: Auszahlung − Einsatz) für Level/Quests melden — ändert NICHT den Kontostand. */
    reportOutcome: function (net) {
      net = Math.round(Number(net) || 0);
      emit('outcome', net);
    },

    /** Neu aus dem Storage laden (Konto-Login oder Wechsel Casino <-> Survival, siehe js/mode.js). */
    reloadFromStorage: function () {
      balance = loadBalance();
      emit('change', balance);
    },

    /** amount Chips gegen Coins kaufen (kostet amount*RATE Coins). */
    buy: function (amount) {
      amount = Math.max(0, Math.floor(Number(amount) || 0));
      if (!amount) return false;
      var cost = amount * RATE;
      if (App.Coins.get() < cost) return false;
      App.Coins.addRaw(-cost);
      balance += amount;
      save();
      emit('change', balance);
      return true;
    },

    /** amount Chips zurück in Coins tauschen. */
    sell: function (amount) {
      amount = Math.max(0, Math.floor(Number(amount) || 0));
      if (!amount || amount > balance) return false;
      balance -= amount;
      save();
      App.Coins.addRaw(amount * RATE);
      emit('change', balance);
      return true;
    },

    /** Chip-Stapel (Denominationen) für einen Betrag. */
    stackFor: stackFor,

    /** Kompakte Anzeige "1.234 🎟️". */
    format: function (n) { return App.UI.formatCoins(n); },

    /** Ein einzelnes Chip-Icon-Element (farbiger Kreis) für eine Denomination. */
    chipIcon: function (denom) {
      var el = App.UI.el;
      var d = null;
      for (var i = 0; i < DENOMS.length; i++) if (DENOMS[i].v === denom) d = DENOMS[i];
      if (!d) d = DENOMS[DENOMS.length - 1];
      return el('span', { class: 'chip-ico', style: 'background:' + d.color + ';color:' + (d.v >= 100 && d.v < 10000 ? '#fff' : '#1a1200') }, [d.label]);
    },

    /** Stapel-Ansicht für einen Betrag: Reihe farbiger Chip-Icons mit Stückzahl. */
    renderStack: function (amount) {
      var el = App.UI.el;
      var stack = stackFor(amount);
      if (!stack.length) return el('div', { class: 'chip-stack chip-stack-empty' }, ['— keine Chips —']);
      return el('div', { class: 'chip-stack' }, stack.map(function (s) {
        return el('div', { class: 'chip-stack-item' }, [
          Chips.chipIcon(s.denom),
          el('span', { class: 'chip-stack-n' }, ['× ' + s.count])
        ]);
      }));
    },

    renderPage: renderPage
  };

  /* ---------------- Chip-Kasse Seite ---------------- */
  function renderPage(root) {
    injectCss();
    var UI = App.UI, el = UI.el;

    var coinsVal = el('span', { class: 'chips-coins-v' }, [UI.formatCoins(App.Coins.get())]);
    var chipsVal = el('span', { class: 'chips-chips-v' }, [UI.formatCoins(balance)]);
    var stackHost = el('div', {});

    var buyInput = el('input', { class: 'text-input chips-amt', type: 'number', min: 1, step: 1, value: 1, inputmode: 'numeric' });
    var buyCost = el('div', { class: 'chips-cost' }, ['']);
    var buyBtn = el('button', { class: 'btn btn-primary', type: 'button' }, ['🎟️ Kaufen']);

    var sellInput = el('input', { class: 'text-input chips-amt', type: 'number', min: 1, step: 1, value: 1, inputmode: 'numeric' });
    var sellGain = el('div', { class: 'chips-cost' }, ['']);
    var sellBtn = el('button', { class: 'btn btn-ghost', type: 'button' }, ['🪙 Verkaufen']);

    function quickBtns(target) {
      return el('div', { class: 'chips-quick' }, [1, 5, 10, 25, 100].map(function (v) {
        return el('button', { class: 'chip', type: 'button', onclick: function () { target.value = v; target.dispatchEvent(new Event('input')); } }, [String(v)]);
      }));
    }

    function refresh() {
      coinsVal.textContent = UI.formatCoins(App.Coins.get());
      chipsVal.textContent = UI.formatCoins(balance);
      stackHost.innerHTML = '';
      stackHost.appendChild(Chips.renderStack(balance));

      var buyAmt = Math.max(0, Math.floor(Number(buyInput.value) || 0));
      var cost = buyAmt * RATE;
      buyCost.textContent = buyAmt ? ('Kostet ' + UI.formatCoins(cost) + ' 🪙') : '';
      buyBtn.disabled = !buyAmt || cost > App.Coins.get();

      var sellAmt = Math.max(0, Math.floor(Number(sellInput.value) || 0));
      sellGain.textContent = sellAmt ? ('Ergibt ' + UI.formatCoins(sellAmt * RATE) + ' 🪙') : '';
      sellBtn.disabled = !sellAmt || sellAmt > balance;
    }

    buyInput.addEventListener('input', refresh);
    sellInput.addEventListener('input', refresh);
    buyBtn.addEventListener('click', function () {
      var amt = Math.max(0, Math.floor(Number(buyInput.value) || 0));
      if (Chips.buy(amt)) { UI.toast('+' + UI.formatCoins(amt) + ' 🎟️ Chips gekauft', 'win'); refresh(); }
      else UI.toast('Nicht genug Coins', 'lose');
    });
    sellBtn.addEventListener('click', function () {
      var amt = Math.max(0, Math.floor(Number(sellInput.value) || 0));
      if (Chips.sell(amt)) { UI.toast('+' + UI.formatCoins(amt * RATE) + ' 🪙 erhalten', 'win'); refresh(); }
      else UI.toast('Nicht genug Chips', 'lose');
    });

    var legend = el('div', { class: 'chips-legend' }, DENOMS.slice().reverse().map(function (d) {
      return el('div', { class: 'chips-legend-item' }, [Chips.chipIcon(d.v), el('span', {}, [UI.formatCoins(d.v * RATE) + ' 🪙'])]);
    }));

    root.appendChild(el('div', { class: 'chips-page' }, [
      el('div', { class: 'page-head' }, [
        el('button', { class: 'btn btn-ghost back', type: 'button', onclick: function () { App.Router.go('/'); } }, ['← Menü']),
        el('h2', { class: 'page-title neon' }, ['🎟️ Pokerchips-Kasse'])
      ]),
      el('p', { class: 'hint-text' }, ['Poker-Spiele wie Video Poker werden mit Pokerchips statt Coins gespielt. Kurs: ', el('b', {}, [UI.formatCoins(RATE) + ' 🪙']), ' = ', el('b', {}, ['1 🎟️'])]),
      el('div', { class: 'chips-balances glass' }, [
        el('div', { class: 'chips-bal' }, [el('div', { class: 'chips-bal-l' }, ['Coins']), el('div', { class: 'chips-bal-v' }, ['🪙 ', coinsVal])]),
        el('div', { class: 'chips-bal' }, [el('div', { class: 'chips-bal-l' }, ['Pokerchips']), el('div', { class: 'chips-bal-v' }, ['🎟️ ', chipsVal])])
      ]),
      el('div', { class: 'glass chips-stackcard' }, [el('h3', { class: 'chips-h' }, ['Dein Chip-Stapel']), stackHost]),
      el('div', { class: 'chips-trade glass' }, [
        el('div', { class: 'chips-trade-col' }, [
          el('label', { class: 'field-label' }, ['Chips kaufen']),
          quickBtns(buyInput), buyInput, buyCost, buyBtn
        ]),
        el('div', { class: 'chips-trade-col' }, [
          el('label', { class: 'field-label' }, ['Chips verkaufen']),
          quickBtns(sellInput), sellInput, sellGain, sellBtn
        ])
      ]),
      el('h3', { class: 'chips-h' }, ['Chip-Werte']),
      legend
    ]));

    refresh();
    var off1 = App.Coins.onChange(refresh);
    var off2 = Chips.onChange(refresh);
    return function () { off1(); off2(); };
  }

  var cssDone = false;
  function injectCss() {
    if (cssDone) return; cssDone = true;
    App.UI.injectStyle('chips-css', [
      '.chips-page{display:flex;flex-direction:column;gap:16px;max-width:760px;margin:0 auto;}',
      '.chips-h{margin:4px 0 -4px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;font-size:13px;}',
      '.chips-balances{display:flex;gap:10px;padding:16px;}',
      '.chips-bal{flex:1;text-align:center;}',
      '.chips-bal-l{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.5px;font-weight:800;}',
      '.chips-bal-v{font-size:20px;font-weight:900;color:var(--gold);font-variant-numeric:tabular-nums;margin-top:4px;}',
      '.chips-stackcard{padding:16px;}',
      '.chip-stack{display:flex;flex-wrap:wrap;gap:10px;}',
      '.chip-stack-empty{color:var(--muted);font-size:13px;}',
      '.chip-stack-item{display:flex;flex-direction:column;align-items:center;gap:4px;}',
      '.chip-stack-n{font-size:11px;color:var(--muted);font-weight:800;}',
      '.chip-ico{display:inline-flex;align-items:center;justify-content:center;width:40px;height:40px;border-radius:50%;font-size:10px;font-weight:900;',
        'box-shadow:0 2px 6px rgba(0,0,0,.5),inset 0 0 0 3px rgba(255,255,255,.35),inset 0 0 0 5px rgba(0,0,0,.25);border:2px dashed rgba(255,255,255,.5);}',
      '.chips-trade{display:flex;gap:18px;padding:16px;flex-wrap:wrap;}',
      '.chips-trade-col{flex:1;min-width:180px;display:flex;flex-direction:column;gap:8px;}',
      '.chips-amt{width:100%;}',
      '.chips-quick{display:flex;gap:6px;flex-wrap:wrap;}',
      '.chips-cost{font-size:12px;color:var(--muted);min-height:16px;}',
      '.chips-legend{display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:10px;}',
      '.chips-legend-item{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--muted);font-weight:700;}'
    ].join(''));
  }

  App.Chips = Chips;
})();
