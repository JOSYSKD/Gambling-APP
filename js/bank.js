/* bank.js — die BANK (App.Bank). Ersetzt die alte Pokerchips-Kasse.
 *
 * Man kann beliebig viel Casino-Silber EINZAHLEN (1:1, gebührenfrei) und später
 * wieder AUSZAHLEN — beim Auszahlen gehen aber 18 % verloren (Bank-Gebühr). Die
 * Bank ist also ein Sparort mit Ausstiegskosten, kein Vermehrer.
 *
 * Beträge über 1 / 10 / 100 / 1000 / ¼ / ½ / MAX. Immer Casino-Silber: der
 * Bank-Stand liegt mode-scoped unter `gj_bank` (siehe js/mode.js), damit sich
 * Survival-Gold nicht über die Bank ins Casino schleusen lässt. Die Bank-Seite
 * erzwingt ohnehin den Casino-Modus.
 *
 * Die Einlage zählt BEWUSST NICHT als Reserve: Game Over/Auffüllung hängen nur am
 * Bargeld. Wer verliert, startet immer mit dem Wiedereinstiegsguthaben neu — egal
 * wie viel auf der Bank liegt (die Bank bleibt dabei erhalten).
 *
 * Der Admin sieht jeden Bank-Stand im Admin-Panel (der Stand wandert über
 * account.js/presence.js mit ins Konto bzw. den Präsenz-Eintrag).
 */
(function () {
  'use strict';
  window.App = window.App || {};
  var KEY = 'gj_bank';
  var FEE = 0.18;   // 18 % Abzug beim Auszahlen
  var CAP = 1e15;   // Bank-Maximum — gleiche Obergrenze wie das Guthaben (nie "unendlich")

  function load() {
    var b = App.Storage.get(KEY, 0);
    if (typeof b !== 'number' || !isFinite(b) || b < 0) b = 0;
    if (b > CAP) b = CAP;
    return Math.floor(b);
  }
  var balance = load();
  function save() { App.Storage.set(KEY, balance); }

  var listeners = [];
  function on(cb) { listeners.push(cb); return function () { var i = listeners.indexOf(cb); if (i >= 0) listeners.splice(i, 1); }; }
  function emit() { for (var i = 0; i < listeners.length; i++) { try { listeners[i](balance); } catch (e) {} } }

  /** Netto beim Auszahlen von amount (nach 18 % Gebühr). */
  function netOut(amount) { return Math.floor(Math.max(0, Math.round(Number(amount) || 0)) * (1 - FEE)); }

  /** amount Coins einzahlen (1:1). Über das Bank-Maximum hinaus geht nichts —
   *  dann wird nur so viel eingezahlt, wie noch Platz ist. */
  function deposit(amount) {
    amount = Math.floor(Number(amount) || 0);
    if (amount <= 0 || amount > App.Coins.get()) return false;
    amount = Math.min(amount, CAP - balance);
    if (amount <= 0) return false;   // Bank ist voll
    App.Coins.addRaw(-amount);   // addRaw -> kein XP fürs Umschichten
    balance += amount;
    save(); emit();
    return true;
  }

  /** amount aus der Bank auszahlen -> Coins abzüglich 18 %. */
  function withdraw(amount) {
    amount = Math.floor(Number(amount) || 0);
    if (amount <= 0 || amount > balance) return false;
    balance -= amount;
    save();
    App.Coins.addRaw(netOut(amount));
    emit();
    return true;
  }

  // Bank zaehlt BEWUSST NICHT als Reserve: wer sein Bargeld verliert, soll IMMER
  // mit dem Wiedereinstiegsguthaben neu starten koennen, egal wie viel auf der Bank
  // liegt (Game Over haengt jetzt nur am Bargeld, nicht am Bank-Vermoegen).

  var Bank = {
    KEY: KEY,
    FEE: FEE,
    get: function () { return balance; },
    netOut: netOut,
    onChange: on,
    deposit: deposit,
    withdraw: withdraw,
    reloadFromStorage: function () { balance = load(); emit(); },
    renderPage: renderPage
  };

  /* ---------------- Oberfläche ---------------- */
  function injectCss() {
    App.UI.injectStyle('bank-css', [
      '.bk-page{max-width:640px;margin:0 auto;}',
      '.bk-cards{display:flex;gap:12px;flex-wrap:wrap;margin:12px 0;}',
      '.bk-card{flex:1;min-width:150px;padding:16px;border-radius:14px;text-align:center;',
      'background:rgba(2,10,6,.5);border:1px solid var(--stroke);}',
      '.bk-card.vault{border-color:rgba(255,199,64,.6);background:radial-gradient(120% 120% at 50% 0,rgba(255,190,40,.14),rgba(2,10,6,.8) 70%);}',
      '.bk-card-l{font-size:12px;opacity:.7;}',
      '.bk-card-v{font-size:24px;font-weight:900;font-variant-numeric:tabular-nums;}',
      '.bk-card.vault .bk-card-v{color:#ffc740;}',
      '.bk-sec{padding:16px;margin-bottom:12px;}',
      '.bk-amt{width:100%;font-size:18px;text-align:center;}',
      '.bk-quick{display:flex;gap:6px;flex-wrap:wrap;margin:8px 0;}',
      '.bk-quick .btn{flex:1;min-width:52px;font-size:13px;padding:7px 4px;}',
      '.bk-hint{font-size:12px;opacity:.75;min-height:16px;margin:4px 0;}',
      '.bk-hint.bad{color:#ff6b6b;opacity:1;}',
      '.bk-do{width:100%;}'
    ].join(''));
  }

  function renderPage(root) {
    injectCss();
    if (App.Mode) App.Mode.set('casino');   // Bank ist immer Casino-Silber
    var UI = App.UI, el = UI.el;

    var cashV = el('div', { class: 'bk-card-v' }, ['']);
    var bankV = el('div', { class: 'bk-card-v' }, ['']);

    // Ein Panel (Einzahlen/Auszahlen) über eine Modus-Umschaltung.
    var mode = 'deposit';
    var tabDep = el('button', { class: 'btn btn-primary', type: 'button' }, ['⬇️ Einzahlen']);
    var tabWd = el('button', { class: 'btn btn-ghost', type: 'button' }, ['⬆️ Auszahlen']);
    var amtIn = el('input', { class: 'text-input bk-amt', type: 'text', inputmode: 'numeric', placeholder: '0' });
    var hint = el('div', { class: 'bk-hint' }, ['']);
    var doBtn = el('button', { class: 'btn btn-primary btn-lg bk-do', type: 'button' }, ['']);

    function cap() { return mode === 'deposit' ? App.Coins.get() : balance; }
    function amtVal() {
      var raw = String(amtIn.value || '').replace(/[^0-9]/g, '');
      return raw ? Math.floor(Number(raw)) : 0;
    }
    function setAmt(v) { amtIn.value = v > 0 ? String(Math.floor(v)) : ''; sync(); }

    var quick = el('div', { class: 'bk-quick' });
    function drawQuick() {
      quick.innerHTML = '';
      [['1', function () { return 1; }], ['10', function () { return 10; }], ['100', function () { return 100; }],
       ['1000', function () { return 1000; }], ['¼', function () { return Math.floor(cap() / 4); }],
       ['½', function () { return Math.floor(cap() / 2); }], ['MAX', function () { return Math.floor(cap()); }]
      ].forEach(function (q) {
        quick.appendChild(el('button', { class: 'btn btn-ghost', type: 'button', onclick: function () {
          var v = q[1]();
          setAmt(mode === 'deposit' ? Math.min(v, cap()) : Math.min(v, cap()));
        } }, [q[0]]));
      });
    }

    function sync() {
      cashV.textContent = UI.formatCoins(App.Coins.get()) + ' 🪙';
      bankV.textContent = UI.formatCoins(balance) + ' 🏦';
      var v = amtVal();
      var ok = v > 0 && v <= cap();
      if (mode === 'deposit') {
        hint.textContent = v ? ('Einzahlen: ' + UI.formatCoins(v) + ' 🪙 (1:1, keine Gebühr)') : 'Zahl beliebig viel ein — gebührenfrei.';
        hint.classList.toggle('bad', v > cap());
        if (v > cap()) hint.textContent = 'Mehr als dein Bargeld.';
        doBtn.textContent = '⬇️ ' + (v ? UI.formatShort(v) + ' einzahlen' : 'Einzahlen');
      } else {
        var net = netOut(v);
        hint.textContent = v ? ('Auszahlen: du bekommst ' + UI.formatCoins(net) + ' 🪙 (−18 % Gebühr = −' + UI.formatCoins(v - net) + ')') : 'Beim Auszahlen gehen 18 % verloren.';
        hint.classList.toggle('bad', v > cap());
        if (v > cap()) hint.textContent = 'Mehr als auf der Bank.';
        doBtn.textContent = '⬆️ ' + (v ? UI.formatShort(v) + ' auszahlen' : 'Auszahlen');
      }
      doBtn.disabled = !ok;
    }

    function setMode(m) {
      mode = m;
      tabDep.className = 'btn ' + (m === 'deposit' ? 'btn-primary' : 'btn-ghost');
      tabWd.className = 'btn ' + (m === 'withdraw' ? 'btn-primary' : 'btn-ghost');
      amtIn.value = ''; drawQuick(); sync();
    }
    tabDep.addEventListener('click', function () { setMode('deposit'); });
    tabWd.addEventListener('click', function () { setMode('withdraw'); });
    amtIn.addEventListener('input', sync);

    doBtn.addEventListener('click', function () {
      var v = amtVal();
      if (mode === 'deposit') {
        if (deposit(v)) { UI.toast('🏦 ' + UI.formatShort(v) + ' eingezahlt', 'win'); amtIn.value = ''; sync(); }
        else UI.toast('Einzahlen nicht möglich', 'lose');
      } else {
        if (withdraw(v)) { UI.toast('🪙 ' + UI.formatShort(netOut(v)) + ' ausgezahlt (−18 %)', 'win'); amtIn.value = ''; sync(); }
        else UI.toast('Auszahlen nicht möglich', 'lose');
      }
    });

    root.appendChild(el('div', { class: 'bk-page' }, [
      el('div', { class: 'page-head' }, [
        el('button', { class: 'btn btn-ghost back', type: 'button', onclick: function () { App.Router.go('/'); } }, ['← Menü']),
        el('h2', { class: 'page-title neon' }, ['🏦 Bank'])
      ]),
      el('p', { class: 'lb-hint' }, ['Parke deine Coins sicher. Einzahlen ist gebührenfrei — beim Auszahlen behält die Bank 18 %.']),
      el('div', { class: 'bk-cards' }, [
        el('div', { class: 'bk-card' }, [el('div', { class: 'bk-card-l' }, ['Bargeld']), cashV]),
        el('div', { class: 'bk-card vault' }, [el('div', { class: 'bk-card-l' }, ['Auf der Bank']), bankV])
      ]),
      el('div', { class: 'glass bk-sec' }, [
        el('div', { class: 'bk-quick', style: 'margin-bottom:10px;' }, [tabDep, tabWd]),
        amtIn,
        quick,
        hint,
        doBtn
      ])
    ]));

    setMode('deposit');
    var off = Bank.onChange(sync);
    var offc = App.Coins.onChange(sync);
    return { cleanup: function () { off(); offc(); } };
  }

  App.Bank = Bank;
})();
