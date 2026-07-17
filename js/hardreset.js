/* hardreset.js — globaler Hard-Reset (App.HardReset).
 *
 * Setzt bei ALLEN Spielern zurück: Casino-Guthaben, Bank, Aktien-Depot, Pokerchips
 * und den kompletten Survival-Stand — dazu Level/XP/Quests (die erledigt progress.js
 * über seinen RESET_GEN). Die STATS (Lebensleistung: wagered/wins/rounds/…) bleiben
 * bewusst ERHALTEN, denn die will Josl behalten; deshalb wird `progress` hier NICHT
 * genullt — progress.js nullt nur XP/Quests und behält die Stats.
 *
 * Zwei Wege, damit auch Firebase-KONTEN getroffen werden (deren Stand käme sonst
 * beim Login zurück):
 *   1. LOKAL beim Laden — ältere `gj_hard_gen` im Browser -> Stände einmalig gekappt.
 *   2. PRO KONTO — account.js fragt `accountNeedsReset(acct)`; ein Konto ohne aktuelle
 *      `hardGen` wird beim Anwenden auf Start gebügelt (Geld/Bank/Chips/Depot/Survival)
 *      und beim nächsten Heartbeat mit neuem Stempel in die Cloud zurückgeschrieben.
 *
 * GEN hochzählen = neuer globaler Reset. Muss NACH mode/coins/stocks/survival geladen
 * werden (ruft Mode.refresh, damit die In-Memory-Stände dem gekappten Storage folgen).
 */
(function () {
  'use strict';
  window.App = window.App || {};

  var GEN = 2;                 // hochzählen für den nächsten globalen Reset
  var KEY_GEN = 'gj_hard_gen';
  var CASINO_START = (App.Coins && App.Coins.START) || 1000;

  function freshSv() {
    return { balance: 0, runPeak: 0, chips: 0, bank: 0, progress: null, stocks: null, nextTry: 0, runActive: false, peakEver: 0 };
  }

  /** Casino-Geld/Bank/Chips/Depot + kompletten Survival-Stand lokal auf Start kappen. */
  function wipeLocal() {
    var M = App.Mode;
    if (!M) return;
    M.writeIn('casino', 'gj_balance', CASINO_START);
    M.writeIn('casino', 'gj_run_peak', CASINO_START);
    M.writeIn('casino', 'gj_bank', 0);
    M.writeIn('casino', 'gj_chips', 0);
    M.writeIn('casino', 'gj_stocks', null);
    M.writeIn('survival', 'gj_balance', 0);
    M.writeIn('survival', 'gj_run_peak', 0);
    M.writeIn('survival', 'gj_chips', 0);
    M.writeIn('survival', 'gj_bank', 0);
    M.writeIn('survival', 'gj_stocks', null);
    if (App.Storage) {
      App.Storage.set('gj_sv_peak_ever', 0);
      App.Storage.set('gj_sv_next_try', 0);
      App.Storage.set('gj_sv_run', false);
    }
    // Level/XP/Quests + Stats-Erhalt macht progress.js (RESET_GEN). Danach die
    // In-Memory-Stände dem gekappten Storage nachziehen.
    if (M.refresh) M.refresh();
    if (App.Stocks && App.Stocks.reload) App.Stocks.reload();
    if (App.Bank && App.Bank.reloadFromStorage) App.Bank.reloadFromStorage();
  }

  var have = App.Storage ? (Number(App.Storage.get(KEY_GEN, 0)) || 0) : GEN;
  if (have < GEN) {
    wipeLocal();
    if (App.Storage) App.Storage.set(KEY_GEN, GEN);
  }

  /** Braucht dieses Konto noch den Reset? (Aufruf aus account.js.) */
  function accountNeedsReset(acct) {
    return !!acct && (Number(acct.hardGen) || 0) < GEN;
  }

  /** Kopie des Kontos mit gekapptem Geld/Bank/Chips/Depot/Survival + Stempel.
   *  `progress` bleibt ABSICHTLICH erhalten (bringt die alten Stats aus der Cloud
   *  zurück; progress.js RESET_GEN nullt daraus nur XP/Quests). Name, Tickets,
   *  Glühbirnen, Antworten, Admin bleiben. */
  function cleanAccount(acct) {
    var c = {};
    for (var k in acct) if (Object.prototype.hasOwnProperty.call(acct, k)) c[k] = acct[k];
    c.balance = CASINO_START;
    c.runPeak = CASINO_START;
    c.bank = 0;
    c.chips = 0;
    c.sv = freshSv();
    c.hardGen = GEN;
    return c;
  }

  App.HardReset = {
    GEN: GEN,
    accountNeedsReset: accountNeedsReset,
    cleanAccount: cleanAccount
  };
})();
