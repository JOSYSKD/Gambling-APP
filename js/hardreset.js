/* hardreset.js — Ergänzung zum globalen Hard-Reset (App.HardReset).
 *
 * Den Casino-Geld-/Bank-Reset und die (abgeschafften) Pokerchips erledigt bereits
 * coins.js (balanceResetOnce / BAL_RESET_GEN) + der Guard in account.js. Damit der
 * Reset WIRKLICH alles trifft, deckt diese Datei den REST ab, den coins.js NICHT
 * anfasst:
 *   · das Aktien-DEPOT (Casino, lokal in gj_stocks) und
 *   · den kompletten SURVIVAL-Stand (Gold-Guthaben, Peak, Depot, Bank).
 * Level/XP/Quests macht progress.js über seinen RESET_GEN.
 *
 * Zwei Wege, damit auch Firebase-KONTEN getroffen werden (deren Stand käme sonst
 * beim Login zurück):
 *   1. LOKAL beim Laden — ältere `gj_hard_gen` im Browser -> Depot + Survival
 *      werden einmalig gekappt, dann Stempel.
 *   2. PRO KONTO — account.js fragt hier `accountNeedsReset(acct)`; ein Konto ohne
 *      aktuelle `hardGen` bekommt beim Anwenden Survival-Stand (acct.sv) und
 *      Level (acct.progress) genullt und wird beim nächsten Heartbeat mit dem
 *      neuen Stempel in die Cloud zurückgeschrieben.
 *
 * GEN hochzählen = neuer globaler Zusatz-Reset. Muss NACH mode/stocks/survival
 * geladen werden (ruft Mode.refresh, damit die In-Memory-Stände dem gekappten
 * Storage folgen).
 */
(function () {
  'use strict';
  window.App = window.App || {};

  var GEN = 1;                 // hochzählen für den nächsten Zusatz-Reset
  var KEY_GEN = 'gj_hard_gen';

  function freshSv() {
    return { balance: 0, runPeak: 0, chips: 0, bank: 0, progress: null, stocks: null, nextTry: 0, runActive: false, peakEver: 0 };
  }

  /** Aktien-Depot (Casino) + kompletten Survival-Stand lokal auf null kappen. */
  function wipeLocal() {
    var M = App.Mode;
    if (!M) return;
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
    if (M.refresh) M.refresh();
    if (App.Stocks && App.Stocks.reload) App.Stocks.reload();
  }

  var have = App.Storage ? (Number(App.Storage.get(KEY_GEN, 0)) || 0) : GEN;
  if (have < GEN) {
    wipeLocal();
    if (App.Storage) App.Storage.set(KEY_GEN, GEN);
  }

  /** Braucht dieses Konto noch den Zusatz-Reset? (Aufruf aus account.js.) */
  function accountNeedsReset(acct) {
    return !!acct && (Number(acct.hardGen) || 0) < GEN;
  }

  /** Kopie des Kontos mit genulltem Survival-Stand + geleertem Level + Stempel.
   *  Casino-Geld/Bank kappt der coins.js-Reset (BAL_RESET_GEN); Name, Tickets,
   *  Glühbirnen, Antworten, Admin bleiben. */
  function cleanAccount(acct) {
    var c = {};
    for (var k in acct) if (Object.prototype.hasOwnProperty.call(acct, k)) c[k] = acct[k];
    c.chips = 0;               // Alt-Pokerchips wirklich weg (account.js würde sie sonst ins Guthaben falten)
    c.sv = freshSv();
    c.progress = null;         // Level/XP/Quests -> progress.js RESET_GEN leert lokal
    c.hardGen = GEN;
    return c;
  }

  App.HardReset = {
    GEN: GEN,
    accountNeedsReset: accountNeedsReset,
    cleanAccount: cleanAccount
  };
})();
