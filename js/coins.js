/* coins.js — übergreifendes Coin-System.
 *
 * Besitzt Guthaben (balance) und den Peak-Kontostand des aktuellen Runs
 * (runPeak). Ein "Run" läuft von 1000 Start-Coins bis zum Game Over.
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
    if (!App.Account || !App.Account.adminMeta) return 1;
    var meta = App.Account.adminMeta();
    var level = meta && meta.rig;
    return (level && RIG_FACTORS[String(level)]) || 1;
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

  function loadBalance() {
    var b = App.Storage.get(KEY_BAL, null);
    if (b === null || typeof b !== 'number' || b < 0) { b = START; App.Storage.set(KEY_BAL, b); }
    return b;
  }
  function loadPeak() {
    var p = App.Storage.get(KEY_PEAK, null);
    if (p === null || typeof p !== 'number') { p = loadBalance(); App.Storage.set(KEY_PEAK, p); }
    return p;
  }

  var balance = loadBalance();
  var runPeak = Math.max(loadPeak(), balance);

  function save() {
    App.Storage.set(KEY_BAL, balance);
    App.Storage.set(KEY_PEAK, runPeak);
  }

  var Coins = {
    START: START,
    MIN_BET: MIN_BET,

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
      if (delta > 0) delta = Math.round(delta * rigFactor());
      balance += delta;
      if (balance < 0) balance = 0;
      if (balance > runPeak) {
        runPeak = balance;
        // Peak live an die Bestenliste melden (aktiver Run).
        App.Leaderboard && App.Leaderboard.onChange && emitLeaderboardTick();
      }
      save();
      emit('change', balance);
      return balance;
    },

    /** Runde abschließen: Game Over prüfen. Gibt true zurück bei Game Over. */
    settle: function () {
      if (balance < MIN_BET) {
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
