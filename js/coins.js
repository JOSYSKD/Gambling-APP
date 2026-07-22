/* coins.js — übergreifendes Coin-System.
 *
 * Besitzt Guthaben (balance) und den Peak-Kontostand des aktuellen Runs
 * (runPeak). Ein "Run" läuft von 1000 Start-Coins bis zum Game Over.
 *
 * Welche Währung das ist, entscheidet App.Mode: im Casino Silber-Coins, im
 * Survival-Modus Gold-Coins. Beide Stände liegen getrennt im Storage (mode.js),
 * dieses Modul arbeitet immer nur mit dem gerade aktiven.
 *
 * Spielablauf-Konvention:
 *   - Einsatz abziehen:   App.Coins.add(-bet)
 *   - Gewinn gutschreiben: App.Coins.add(payout)
 *   - Nach JEDER abgeschlossenen Runde: App.Coins.settle()
 *     -> prüft, ob Guthaben < Mindesteinsatz -> feuert 'gameover'.
 *   settle() NICHT mitten in einer laufenden Runde aufrufen (z. B. während
 *   bei Blackjack noch gezogen wird), sonst gäbe es ein Fehl-Game-Over.
 */
(function () {
  'use strict';
  window.App = window.App || {};

  var START = 1000;
  var MIN_BET = 10;
  var KEY_BAL = 'gj_balance';
  var KEY_PEAK = 'gj_run_peak';

  // Auffüll-/Startbetrag steigt mit dem Spieler-Level (App.Progress). Fällt auf 1000
  // zurück, solange progress.js noch nicht geladen ist (Level 1).
  function startAmount() {
    return (App.Progress && App.Progress.startBalance) ? App.Progress.startBalance() : START;
  }

  // Admin-"Rigging" (siehe js/admin.js): wirkt als Faktor auf Gewinn-Gutschriften
  // des aktuell eingeloggten Spielers, über alle Gambling-Spiele hinweg (ein
  // einziger Eingriffspunkt statt Änderungen in jedem einzelnen Spiel).
  var RIG_FACTORS = { '-2': 0.15, '-1': 0.5, '1': 1.6, '2': 2.5 };
  function rigFactor() {
    var level = 0;
    if (App.Account && App.Account.adminMeta) {
      var meta = App.Account.adminMeta();
      level = (meta && meta.rig) || 0;
    }
    // Kein Konto eingeloggt (Gast, siehe js/presence.js) -> eigenen Präsenz-Eintrag prüfen.
    if (!level && App.Presence && App.Presence.rig) level = App.Presence.rig();
    var admin = (level && RIG_FACTORS[String(level)]) || 1;
    // Zeitlich begrenzte Glücks-Power-Ups (Preis für Turniersieger, siehe
    // js/powerups.js) wirken auf denselben Gewinnen und kommen multiplikativ dazu.
    var powerup = (App.Powerups && App.Powerups.factor) ? App.Powerups.factor() : 1;
    return admin * powerup;
  }

  var listeners = { change: [], gameover: [] };

  function on(evt, cb) {
    (listeners[evt] || (listeners[evt] = [])).push(cb);
    return function () {
      var a = listeners[evt], i = a.indexOf(cb);
      if (i >= 0) a.splice(i, 1);
    };
  }
  function emit(evt, payload) {
    var a = listeners[evt] || [];
    for (var i = 0; i < a.length; i++) {
      try { a[i](payload); } catch (e) {}
    }
  }

  /* Globaler Geld-Reset (Josls Wunsch): Bei einem Sprung dieser Generation setzt
   * JEDER Client sein CASINO-Guthaben + Peak einmalig auf das (jetzt kleine)
   * Einstiegsguthaben zurück — zuverlässig für online wie offline, weil jeder
   * Client es an sich selbst anwendet (ein Konto-Patch würde bei Online-Spielern
   * sofort wieder hochsynchronisiert). LEVEL/XP/Quests bleiben unangetastet.
   * Nur Casino-Silber, nie das Survival-Gold. */
  var BAL_RESET_GEN = 1;
  (function balanceResetOnce() {
    if (!App.Mode || !App.Mode.readIn) return;
    var seen = Number(App.Storage.get('gj_bal_reset_gen', 0)) || 0;
    if (seen >= BAL_RESET_GEN) return;
    App.Storage.set('gj_bal_reset_gen', BAL_RESET_GEN);
    var start = (App.Progress && App.Progress.startBalanceIn) ? App.Progress.startBalanceIn('casino')
      : (App.Progress && App.Progress.startBalance ? App.Progress.startBalance() : START);
    start = Math.max(0, Math.round(Number(start) || START));
    App.Mode.writeIn('casino', 'gj_balance', start);
    App.Mode.writeIn('casino', 'gj_run_peak', start);
    App.Mode.writeIn('casino', 'gj_bank', 0);   // Bank-Einlage beim Geld-Reset ebenfalls auf 0
  })();

  // Höchstwert für Guthaben/Peak: knapp unter dem JS-Zahlen-Limit, damit nie
  // "Infinity" ("∞") entsteht. Mit den 60er-Einheiten wird das als "1Qa" o.Ä.
  // angezeigt — riesig, aber endlich und lesbar.
  var BAL_CAP = 1e300;
  function loadBalance() {
    var b = App.Storage.get(KEY_BAL, null);
    if (b === null || typeof b !== 'number' || b < 0 || !isFinite(b)) { b = START; App.Storage.set(KEY_BAL, b); }
    else if (b > BAL_CAP) { b = BAL_CAP; App.Storage.set(KEY_BAL, b); }
    return b;
  }
  function loadPeak() {
    var p = App.Storage.get(KEY_PEAK, null);
    if (p === null || typeof p !== 'number' || !isFinite(p)) { p = loadBalance(); App.Storage.set(KEY_PEAK, p); }
    else if (p > BAL_CAP) { p = BAL_CAP; App.Storage.set(KEY_PEAK, p); }
    return p;
  }

  var balance = loadBalance();
  var runPeak = Math.max(loadPeak(), balance);

  function save() {
    App.Storage.set(KEY_BAL, balance);
    App.Storage.set(KEY_PEAK, runPeak);
  }

  /** Guthaben ändern — ohne Rigging und ohne Quest-/XP-Erfassung. */
  function apply(delta) {
    delta = Math.round(Number(delta) || 0);
    if (!isFinite(delta)) delta = delta > 0 ? BAL_CAP : 0;   // Infinity-Gewinn/Einsatz abfangen
    balance += delta;
    if (balance < 0) balance = 0;
    if (!isFinite(balance) || balance > BAL_CAP) balance = BAL_CAP;   // nie "Unendlich" (∞)
    if (balance > runPeak) {
      runPeak = balance;
      // Peak live an die Bestenliste melden (aktiver Run).
      App.Leaderboard && App.Leaderboard.onChange && emitLeaderboardTick();
    }
    save();
    emit('change', balance);
    return balance;
  }

  /* Vermögen außerhalb des Guthabens (Aktien-Depot, Pokerchips). Solange davon
   * noch etwas da ist, ist der Spieler NICHT pleite — er muss nur verkaufen bzw.
   * eintauschen. Ohne diesen Schutz gäbe es ein Game Over, obwohl das Depot voll ist. */
  // Netto-Ergebnis der laufenden Runde (Summe aller add()-Aufrufe seit dem
  // letzten settle) + ob überhaupt ein Einsatz lief — für die Verlust-Erstattung
  // der Power-Ups (Freispiel/Schild/Goldene Hand, siehe powerups.js/settle).
  var roundNet = 0, roundStaked = false;

  var reserveFns = [];
  function reserve() {
    var total = 0;
    for (var i = 0; i < reserveFns.length; i++) {
      try { total += Number(reserveFns[i]()) || 0; } catch (e) {}
    }
    return total;
  }

  var Coins = {
    START: START,
    MIN_BET: MIN_BET,
    BAL_RESET_GEN: BAL_RESET_GEN,   // Geld-Reset-Generation (siehe balanceResetOnce + account.js)

    get: function () { return balance; },
    getPeak: function () { return runPeak; },

    onChange: function (cb) { return on('change', cb); },
    onGameOver: function (cb) { return on('gameover', cb); },

    canBet: function (amount) {
      amount = Number(amount);
      return isFinite(amount) && amount >= MIN_BET && amount <= balance;
    },

    /** Guthaben um delta ändern (Einsatz negativ, Gewinn positiv). */
    add: function (delta) {
      delta = Math.round(Number(delta) || 0);
      if (delta > 0) {
        delta = Math.round(delta * rigFactor());
        // Einmalige Gewinn-Power-Ups (Verdoppler/Verdreifacher, siehe powerups.js).
        if (App.Powerups && App.Powerups.consumeWinBonus) delta = Math.round(App.Powerups.consumeWinBonus(delta));
      } else if (delta < 0) {
        roundStaked = true;   // in dieser Runde wurde etwas gesetzt
      }
      roundNet += delta;       // Netto der laufenden Runde (für Verlust-Erstattung)
      return apply(delta);
    },

    /** Wie add(), aber ohne Rigging und ohne Einsatz-/Gewinn-Wertung (Aktienhandel,
     *  Ein-/Auszahlungen). progress.js hookt nur add(), daher zählt das hier nicht
     *  als Einsatz — sonst gäbe es XP fürs bloße Hin- und Herschieben von Coins. */
    addRaw: function (delta) { return apply(delta); },

    /** Quelle für "Vermögen außerhalb des Guthabens" anmelden (siehe reserve()). */
    addReserveSource: function (fn) {
      if (typeof fn === 'function') reserveFns.push(fn);
    },
    reserve: reserve,

    /** Runde abschließen: Verlust-Power-Ups anwenden, dann Game Over prüfen. */
    settle: function () {
      // Freispiel/Schild/Goldene Hand: bei Netto-Verlust den Einsatz erstatten.
      if (App.Powerups && App.Powerups.onRoundEnd) {
        var refund = App.Powerups.onRoundEnd(roundNet, roundStaked);
        if (refund > 0) apply(refund);   // Runde auf Null bringen (als hätte man nicht gespielt)
      }
      roundNet = 0; roundStaked = false;
      if (balance < MIN_BET && reserve() < MIN_BET) {
        emit('gameover', { peak: runPeak });
        return true;
      }
      return false;
    },

    /** Aktuellen Auffüll-/Startbetrag (level-abhängig). */
    startAmount: function () { return startAmount(); },

    /** Kompletten Run zurücksetzen (nach Game Over -> Neustart, Betrag je Level). */
    reset: function () {
      balance = startAmount();
      runPeak = balance;
      save();
      emit('change', balance);
    },

    /** Neu aus dem Storage laden (z. B. nachdem ein Konto-Login den Spielstand ersetzt hat). */
    reloadFromStorage: function () {
      balance = loadBalance();
      runPeak = Math.max(loadPeak(), balance);
      emit('change', balance);
    }
  };

  // Leaderboard-Anzeige aktualisiert sich über seine eigenen onChange-Listener,
  // die den aktiven Run-Peak live aus Coins.getPeak() lesen. Wir müssen hier nur
  // dessen Listener antriggern.
  function emitLeaderboardTick() {
    // Leaderboard hat keinen expliziten "peak changed"-Hook; die Views, die den
    // aktiven Run zeigen, lauschen auf Coins.onChange. Daher genügt das change-Event.
  }

  App.Coins = Coins;
})();
