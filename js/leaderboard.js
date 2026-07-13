/* leaderboard.js — Bestenliste (Peak-Kontostand pro Run).
 *
 * Modular gehalten: die gesamte Persistenz läuft über den internen
 * `driver`. Aktuell ein localStorage-Driver; für ein Online-Backend
 * (z. B. Firebase) einfach `App.Leaderboard.useDriver(firebaseDriver)`
 * mit denselben Methoden (load/save/subscribe) aufrufen.
 */
(function () {
  'use strict';
  window.App = window.App || {};

  var KEY_ENTRIES = 'gj_leaderboard';
  var KEY_NAME = 'gj_player_name';

  // --- Standard-Driver: localStorage ------------------------------------
  var localDriver = {
    load: function () {
      return App.Storage.get(KEY_ENTRIES, []);
    },
    save: function (entries) {
      App.Storage.set(KEY_ENTRIES, entries);
    }
  };

  var driver = localDriver;
  var listeners = [];

  function emit() {
    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i](); } catch (e) {}
    }
  }

  var Leaderboard = {
    /** Anderen Persistenz-Driver einsetzen (z. B. Firebase). */
    useDriver: function (d) {
      driver = d;
      emit();
    },

    onChange: function (cb) {
      listeners.push(cb);
      return function () {
        var i = listeners.indexOf(cb);
        if (i >= 0) listeners.splice(i, 1);
      };
    },

    getPlayerName: function () {
      return App.Storage.get(KEY_NAME, '');
    },
    setPlayerName: function (name) {
      App.Storage.set(KEY_NAME, String(name || '').slice(0, 18).trim());
      emit();
    },

    /** Alle gespeicherten (abgeschlossenen) Runs, sortiert absteigend. */
    getEntries: function () {
      var list = (driver.load() || []).slice();
      list.sort(function (a, b) { return b.peak - a.peak; });
      return list;
    },

    /**
     * Kombinierte Anzeige-Liste: gespeicherte Runs + der aktuell laufende
     * Run (als virtueller Eintrag mit active:true). Sortiert, Top `limit`.
     */
    getBoard: function (activePeak, limit) {
      limit = limit || 10;
      var list = this.getEntries();
      var name = this.getPlayerName() || 'Du';
      if (typeof activePeak === 'number') {
        list.push({ name: name, peak: activePeak, date: null, active: true });
        list.sort(function (a, b) { return b.peak - a.peak; });
      }
      return list.slice(0, limit);
    },

    /** Einen abgeschlossenen Run eintragen (bei Game Over). */
    recordRun: function (name, peak, dateStr) {
      var list = driver.load() || [];
      list.push({
        name: String(name || 'Anonym').slice(0, 18),
        peak: Math.round(peak),
        date: dateStr,
        active: false
      });
      list.sort(function (a, b) { return b.peak - a.peak; });
      // Wir bewahren mehr als 10 auf, damit alte Rekorde nicht verloren gehen,
      // aber deckeln großzügig, um localStorage nicht vollzumüllen.
      if (list.length > 100) list = list.slice(0, 100);
      driver.save(list);
      emit();
    },

    reset: function () {
      driver.save([]);
      emit();
    }
  };

  App.Leaderboard = Leaderboard;
})();
