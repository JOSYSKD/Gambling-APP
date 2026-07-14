/* leaderboard.js — Bestenliste (Peak-Kontostand pro Run).
 *
 * Modular gehalten: die gesamte Persistenz läuft über den internen
 * `driver`. Standard ist ein localStorage-Driver (nur dieses Gerät).
 * Steht in js/firebase-config.js eine echte Firebase-Konfiguration,
 * schaltet dieses Modul automatisch auf einen Firebase-Driver um —
 * dann sehen alle Besucher der Seite dieselbe, geteilte Bestenliste.
 */
(function () {
  'use strict';
  window.App = window.App || {};

  var KEY_ENTRIES = 'gj_leaderboard';
  var KEY_NAME = 'gj_player_name';

  // --- Standard-Driver: localStorage (nur dieses Gerät) ------------------
  var localDriver = {
    kind: 'local',
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

  // --- Firebase-Driver: geteilte Bestenliste über alle Besucher ---------
  // Einträge werden additiv per push() geschrieben (statt die ganze Liste
  // zu überschreiben) — sonst würden gleichzeitig spielende Besucher sich
  // gegenseitig die Bestenliste überschreiben.
  function loadScript(src) {
    return new Promise(function (res, rej) {
      var s = document.createElement('script'); s.src = src; s.async = true;
      s.onload = res; s.onerror = function () { rej(new Error('Ladefehler: ' + src)); };
      document.head.appendChild(s);
    });
  }
  var FB_VER = '10.12.0';
  function loadFirebaseSDK() {
    if (window.firebase && window.firebase.database) return Promise.resolve();
    return loadScript('https://www.gstatic.com/firebasejs/' + FB_VER + '/firebase-app-compat.js')
      .then(function () { return loadScript('https://www.gstatic.com/firebasejs/' + FB_VER + '/firebase-database-compat.js'); });
  }
  function fbConfigReal(cfg) {
    return cfg && typeof cfg.apiKey === 'string' && cfg.apiKey.indexOf('DEIN_') !== 0 &&
      typeof cfg.databaseURL === 'string' && cfg.databaseURL.indexOf('DEIN_') < 0 && cfg.databaseURL.indexOf('http') === 0;
  }
  function makeFirebaseDriver(cfg) {
    if (!firebase.apps || !firebase.apps.length) firebase.initializeApp(cfg);
    var db = firebase.database();
    var ref = db.ref('leaderboard/entries').orderByChild('peak').limitToLast(200);
    var cache = [];
    ref.on('value', function (snap) {
      var val = snap.val() || {};
      cache = Object.keys(val).map(function (k) { return val[k]; });
      emit();
    });
    return {
      kind: 'firebase',
      load: function () { return cache; },
      save: function () { /* wird nicht benutzt: record()/reset() schreiben additiv */ },
      record: function (entry) { db.ref('leaderboard/entries').push(entry); },
      reset: function () { db.ref('leaderboard/entries').remove(); }
    };
  }
  if (fbConfigReal(window.FIREBASE_CONFIG)) {
    loadFirebaseSDK()
      .then(function () { Leaderboard.useDriver(makeFirebaseDriver(window.FIREBASE_CONFIG)); })
      .catch(function () { /* bleibt beim localStorage-Driver */ });
  }

  var Leaderboard = {
    /** Anderen Persistenz-Driver einsetzen (z. B. Firebase). */
    useDriver: function (d) {
      driver = d;
      emit();
    },

    /** true, wenn die Bestenliste geräteübergreifend (Firebase) läuft. */
    isOnline: function () {
      return driver.kind === 'firebase';
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
      var entry = {
        name: String(name || 'Anonym').slice(0, 18),
        peak: Math.round(peak),
        date: dateStr,
        active: false
      };
      // Der Firebase-Driver schreibt additiv (push) statt die ganze Liste
      // zu überschreiben — sonst würden gleichzeitige Spieler sich
      // gegenseitig die Bestenliste kaputt machen.
      if (driver.record) {
        driver.record(entry);
        return;
      }
      var list = driver.load() || [];
      list.push(entry);
      list.sort(function (a, b) { return b.peak - a.peak; });
      // Wir bewahren mehr als 10 auf, damit alte Rekorde nicht verloren gehen,
      // aber deckeln großzügig, um localStorage nicht vollzumüllen.
      if (list.length > 100) list = list.slice(0, 100);
      driver.save(list);
      emit();
    },

    reset: function () {
      if (driver.reset) { driver.reset(); return; }
      driver.save([]);
      emit();
    }
  };

  App.Leaderboard = Leaderboard;
})();
