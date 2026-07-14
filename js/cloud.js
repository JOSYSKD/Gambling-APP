/* cloud.js — Keyloser Cloud-Speicher (kein Firebase-/Google-Konto nötig).
 *
 * Nutzt JSONBlob (https://jsonblob.com) als kostenlosen, anmeldefreien
 * JSON-Speicher mit CORS-Unterstützung für Client-Code. Die ID des geteilten
 * Datensatzes steht in js/cloud-config.js.
 *
 * Wird automatisch von js/account.js verwendet, WENN keine echte Firebase-
 * Konfiguration vorliegt, aber eine echte CLOUD_STORE_ID gesetzt ist. Dann
 * sind Konten & Bestenliste für alle Besucher der Website geteilt.
 *
 * Grenzen (freier Drittanbieter, kein eigener Server):
 *  - Kein Push/Realtime wie bei Firebase — Änderungen anderer Besucher kommen
 *    per Polling an (siehe startPolling), also mit ein paar Sekunden Verzögerung.
 *  - Kein atomares Update: bei echtzeit-gleichzeitigen Schreibern (sehr selten
 *    bei einer kleinen Klassen-/Freundesrunde) kann im Extremfall ein Schreib-
 *    vorgang einen anderen überschreiben. Für dieses Projekt ein akzeptabler
 *    Kompromiss, da es keinen eigenen Server gibt.
 *  - Ist der Dienst mal down/langsam, fällt account.js automatisch auf den
 *    lokalen Modus zurück — die Seite bleibt in jedem Fall benutzbar.
 */
(function () {
  'use strict';
  window.App = window.App || {};

  var API_BASE = 'https://jsonblob.com/api/jsonBlob/';
  var TIMEOUT_MS = 8000;

  function configured() {
    var id = window.CLOUD_STORE_ID;
    return typeof id === 'string' && id.trim().length > 0 && id.indexOf('DEIN_') !== 0;
  }

  function withTimeout(promise, ms) {
    return new Promise(function (resolve, reject) {
      var settled = false;
      var t = setTimeout(function () {
        if (settled) return;
        settled = true;
        reject(new Error('Cloud-Speicher: Zeitüberschreitung'));
      }, ms);
      promise.then(function (v) {
        if (settled) return;
        settled = true; clearTimeout(t); resolve(v);
      }, function (e) {
        if (settled) return;
        settled = true; clearTimeout(t); reject(e);
      });
    });
  }

  function fetchFresh() {
    if (!configured()) return Promise.reject(new Error('Cloud-Speicher nicht konfiguriert'));
    return withTimeout(fetch(API_BASE + window.CLOUD_STORE_ID, { headers: { Accept: 'application/json' } }), TIMEOUT_MS)
      .then(function (res) {
        if (!res.ok) throw new Error('Cloud-Speicher nicht erreichbar (' + res.status + ')');
        return res.json();
      })
      .then(function (data) { return (data && typeof data === 'object') ? data : {}; });
  }

  function put(state) {
    return withTimeout(fetch(API_BASE + window.CLOUD_STORE_ID, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(state)
    }), TIMEOUT_MS).then(function (res) {
      if (!res.ok) throw new Error('Cloud-Speicher: Schreiben fehlgeschlagen (' + res.status + ')');
      return state;
    });
  }

  var cache = null;
  var listeners = [];
  var pollTimer = null;

  function emit() {
    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i](cache); } catch (e) {}
    }
  }

  var Cloud = {
    configured: configured,

    /** Aktuellen Stand liefern. `fresh=true` erzwingt einen Netzwerk-Reload statt Cache. */
    load: function (fresh) {
      if (!fresh && cache) return Promise.resolve(cache);
      return fetchFresh().then(function (data) { cache = data; emit(); return cache; });
    },

    /** Read-Modify-Write: frischen Stand holen, `fn(state)` darauf anwenden, zurückschreiben. */
    mutate: function (fn) {
      return fetchFresh().then(function (data) {
        fn(data);
        return put(data).then(function () { cache = data; emit(); return cache; });
      });
    },

    onChange: function (cb) {
      listeners.push(cb);
      return function () {
        var i = listeners.indexOf(cb);
        if (i >= 0) listeners.splice(i, 1);
      };
    },

    /** Regelmäßig neu laden, damit Änderungen anderer Besucher ankommen (kein Websocket beim freien Dienst). */
    startPolling: function (ms) {
      if (pollTimer) return pollTimer;
      pollTimer = setInterval(function () {
        Cloud.load(true).catch(function () {});
      }, ms || 15000);
      return pollTimer;
    }
  };

  App.Cloud = Cloud;
})();
