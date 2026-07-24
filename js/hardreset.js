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

  var GEN = 8;                 // hochzählen für den nächsten globalen Reset (8 = großer Sommer-Reset: Geld/Bank/Depot/Tickets + Level, Spiel-Stats bleiben)

  // Zeitpunkt des großen Sommer-Resets (GEN 8, 24.07.2026). Cloud-Daten, die VOR
  // diesem Zeitpunkt entstanden sind — Postfach-Zahlungen (tournament-host.js),
  // Bestenlisten-Runs (leaderboard.js), Survival-Board-Einträge (survival.js) und
  // Präsenz-Geldwerte von seither nicht mehr gesehenen Spielern — stammen aus der
  // alten, kaputten Ökonomie und werden beim LESEN ignoriert. So braucht der Reset
  // keinen Massen-Schreibzugriff auf die Datenbank: jeder Client kappt sich selbst,
  // und die Alt-Reste sind ab sofort unsichtbar.
  var RESET_AT = 1784898577139;
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
    M.writeIn('casino', 'gj_cours', null);        // COURS-Depot (js/cours.js) — zählte sonst als Reserve weiter
    M.writeIn('survival', 'gj_balance', 0);
    M.writeIn('survival', 'gj_run_peak', 0);
    M.writeIn('survival', 'gj_chips', 0);
    M.writeIn('survival', 'gj_bank', 0);
    M.writeIn('survival', 'gj_stocks', null);
    M.writeIn('survival', 'gj_cours', null);
    if (App.Storage) {
      App.Storage.set('gj_sv_peak_ever', 0);
      App.Storage.set('gj_sv_next_try', 0);
      App.Storage.set('gj_sv_run', false);
      App.Storage.set('gj_tickets', 1);        // Turnier-Tickets zurück aufs Willkommens-Ticket
      App.Storage.set('gj_gifted_total', 0);   // "bisher verschenkt" (Geld-Rekord) nullen
      App.Storage.remove('gj_pu_inv');         // Power-Up-Inventar leeren (remove statt set(null): get() soll den Fallback liefern)
      App.Storage.remove('gj_pu_fx');          // aktive Power-Up-Effekte beenden
    }
    // Level/XP/Quests + Stats-Erhalt macht progress.js (RESET_GEN). Danach die
    // In-Memory-Stände dem gekappten Storage nachziehen.
    if (M.refresh) M.refresh();
    if (App.Coins && App.Coins.reloadFromStorage) App.Coins.reloadFromStorage();
    if (App.Chips && App.Chips.reloadFromStorage) App.Chips.reloadFromStorage();
    if (App.Stocks && App.Stocks.reload) App.Stocks.reload();
    if (App.Cours && App.Cours.reload) App.Cours.reload();
    if (App.Bank && App.Bank.reloadFromStorage) App.Bank.reloadFromStorage();
  }

  var have = App.Storage ? (Number(App.Storage.get(KEY_GEN, 0)) || 0) : GEN;
  if (have < GEN) {
    wipeLocal();
    if (App.Storage) App.Storage.set(KEY_GEN, GEN);
  }

  /* ---------------- Cloud-gesteuerter Geld-Reset ----------------------------
   * Der lokale GEN oben ist im Code fest verdrahtet — der Admin kann damit zur
   * Laufzeit KEINEN Reset auslösen. Genau das war der Bug: der „Geld-Bestenliste
   * zurücksetzen"-Knopf patchte nur die Cloud-Werte, die jeder Client beim nächsten
   * Heartbeat wieder überschrieb → praktisch wurde nur der Admin selbst zurückgesetzt.
   *
   * Lösung wie der lokale GEN, aber über einen ZÄHLER in der Cloud: erhöht der Admin
   * ihn (bumpCloudReset), kappt JEDER Client beim nächsten Laden UND regelmäßig genau
   * EINMAL sein Geld/Bank/Chips/Depot/COURS (Level/XP/Quests/Stats bleiben). Pfad liegt
   * unter dem bereits offenen `scores`-Knoten -> kein Firebase-Regel-Deploy nötig. */
  var CLOUD_PATH = 'scores/__money_reset';   // { gen:Number, at:Number }
  var CLOUD_SEEN = 'gj_money_reset_seen';     // lokal zuletzt angewandte Cloud-Generation

  function applyCloudResetOnce() {
    if (!App.Net || !App.Net.store) return Promise.resolve();
    return App.Net.store().then(function (b) { return b.get(CLOUD_PATH); }).then(function (node) {
      var cloudGen = (node && Number(node.gen)) || 0;
      var seen = App.Storage ? (Number(App.Storage.get(CLOUD_SEEN, 0)) || 0) : 0;
      if (cloudGen <= seen) return;
      // seen ZUERST setzen -> auch wenn wipeLocal etwas neu rendert, kein Doppel-Reset.
      if (App.Storage) App.Storage.set(CLOUD_SEEN, cloudGen);
      wipeLocal();                       // nur Geld/Depot/COURS — Level/Quests/Stats bleiben
      try { if (App.UI && App.UI.toast) App.UI.toast('💥 Guthaben wurde zurückgesetzt.', 'info'); } catch (e) {}
    }).catch(function () {});
  }

  /** Admin: globalen Geld-Reset für ALLE auslösen (Cloud-Zähler +1). */
  function bumpCloudReset() {
    if (!App.Net || !App.Net.store) return Promise.resolve();
    return App.Net.store().then(function (b) {
      return b.get(CLOUD_PATH).then(function (node) {
        var gen = ((node && Number(node.gen)) || 0) + 1;
        // eigenen seen mitziehen, damit der Admin sich nicht selbst doppelt kappt
        if (App.Storage) App.Storage.set(CLOUD_SEEN, gen);
        return b.set(CLOUD_PATH, { gen: gen, at: Date.now() });
      });
    });
  }

  // Beim Laden prüfen + danach regelmäßig (fängt auch Spieler, die die Seite offen lassen).
  applyCloudResetOnce();
  if (typeof setInterval === 'function') setInterval(applyCloudResetOnce, 30000);

  /** Braucht dieses Konto noch den Reset? (Aufruf aus account.js.) */
  function accountNeedsReset(acct) {
    return !!acct && (Number(acct.hardGen) || 0) < GEN;
  }

  /** Kopie des Kontos mit gekapptem Geld/Bank/Chips/Depot/Survival + Stempel.
   *  `progress` bleibt ABSICHTLICH erhalten (bringt die alten Stats aus der Cloud
   *  zurück; progress.js RESET_GEN nullt daraus XP/Quests + Geld-Rekorde und behält
   *  die Spiel-Stats). Name, Glühbirnen, Antworten, Admin bleiben. */
  function cleanAccount(acct) {
    var c = {};
    for (var k in acct) if (Object.prototype.hasOwnProperty.call(acct, k)) c[k] = acct[k];
    c.balance = CASINO_START;
    c.runPeak = CASINO_START;
    c.bank = 0;
    c.chips = 0;
    c.tickets = 1;
    c.giftedTotal = 0;
    c.sv = freshSv();
    c.hardGen = GEN;
    return c;
  }

  App.HardReset = {
    GEN: GEN,
    RESET_AT: RESET_AT,
    accountNeedsReset: accountNeedsReset,
    cleanAccount: cleanAccount,
    bumpCloudReset: bumpCloudReset,          // Admin: Geld-Reset für ALLE auslösen
    applyCloudResetOnce: applyCloudResetOnce
  };
})();
