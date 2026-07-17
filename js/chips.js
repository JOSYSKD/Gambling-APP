/* chips.js — NUR NOCH MIGRATION. Die Pokerchips wurden abgeschafft und durch die
 * Bank (js/bank.js) ersetzt.
 *
 * Beim Laden werden alle noch vorhandenen Chips EINMALIG zu Coins ausgezahlt
 * (Kurs wie früher: 1 Chip = RATE Coins) — in BEIDEN Modi (Casino-Silber und
 * Survival-Gold), damit niemand seine Chips verliert. Danach ist der Chip-Stand
 * 0 und bleibt es.
 *
 * App.Chips bleibt als schlanker Kompatibilitäts-Stub bestehen (get()=0, no-ops),
 * damit Alt-Aufrufer (account.js/mode.js) nicht brechen. Konto-gebundene Chips
 * werden zusätzlich in js/account.js beim Restore ins Guthaben gefaltet.
 */
(function () {
  'use strict';
  window.App = window.App || {};
  var KEY = 'gj_chips';
  var RATE = 100000;   // 1 Chip = 100.000 Coins (historischer Kurs)

  var listeners = [];

  /** Chips eines Modus zu Coins machen und auf 0 setzen. Gibt den Coin-Betrag zurück. */
  function payoutMode(m) {
    if (!App.Mode || !App.Mode.readIn) return 0;
    var chips = Math.floor(Number(App.Mode.readIn(m, KEY, 0)) || 0);
    if (chips <= 0) return 0;
    var coins = chips * RATE;
    var bal = Math.floor(Number(App.Mode.readIn(m, 'gj_balance', 0)) || 0) + coins;
    App.Mode.writeIn(m, 'gj_balance', bal);
    var peak = Math.floor(Number(App.Mode.readIn(m, 'gj_run_peak', 0)) || 0);
    if (bal > peak) App.Mode.writeIn(m, 'gj_run_peak', bal);
    App.Mode.writeIn(m, KEY, 0);
    return coins;
  }

  /** Einmalige Auszahlung beider Modi. Läuft beim Boot und nach Konto-Restore. */
  function payoutAll() {
    var casino = payoutMode('casino');
    payoutMode('survival');
    if (App.Coins && App.Coins.reloadFromStorage) App.Coins.reloadFromStorage();
    if (casino > 0 && App.UI && App.UI.toast) {
      App.UI.toast('🎟️→🪙 Deine alten Pokerchips wurden als ' + App.UI.formatShort(casino) + ' Coins ausgezahlt.', 'win');
    }
  }

  App.Chips = {
    RATE: RATE,
    MIN_BET: 1,
    // Kompatibilitäts-Stub: Chips gibt es nicht mehr.
    get: function () { return 0; },
    canBet: function () { return false; },
    add: function () { return 0; },
    buy: function () { return false; },
    sell: function () { return false; },
    onChange: function (cb) { listeners.push(cb); return function () { var i = listeners.indexOf(cb); if (i >= 0) listeners.splice(i, 1); }; },
    reloadFromStorage: function () {},
    payoutAll: payoutAll
  };

  function boot() { try { payoutAll(); } catch (e) {} }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
