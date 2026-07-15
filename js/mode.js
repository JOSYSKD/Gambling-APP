/* mode.js — zwei komplett getrennte Spielstände: Casino (Silber) und Survival (Gold).
 *
 * Kernidee: alle run-gebundenen Daten (Guthaben, Peak, Level/Quests, Aktien-Depot)
 * liegen ohnehin schon im App.Storage. Hier wird der Storage-Zugriff für genau
 * diese Schlüssel modus-abhängig mit 'sv_' vorangestellt. Dadurch bekommt der
 * Survival-Modus einen eigenen Spielstand, OHNE dass coins.js, progress.js oder
 * die ~30 Spiele etwas davon wissen müssen — und ein Survival-Reset auf null
 * lässt den Casino-Stand komplett unangetastet.
 *
 * WICHTIG: muss VOR coins.js / progress.js / stocks.js geladen werden, weil die
 * ihren Zustand bereits beim Laden aus dem Storage lesen.
 */
(function () {
  'use strict';
  window.App = window.App || {};

  var KEY_MODE = 'gj_mode';
  var PREFIX = 'sv_';

  /* Nur diese Schlüssel sind an einen Modus gebunden. Alles andere (Konto,
   * Spielername, Themes, Einstellungen, Tagesbonus) bleibt bewusst geteilt. */
  var SCOPED = {
    gj_balance: 1,   // Guthaben
    gj_run_peak: 1,  // höchster Stand des Runs
    gj_progress: 1,  // Level, XP, Quests, Stats
    gj_stocks: 1,    // Aktien-Depot
    gj_chips: 1      // Pokerchips (sonst ließe sich Gold über die Chip-Kasse ins Casino tauschen)
  };

  var S = App.Storage;
  var rawGet = S.get, rawSet = S.set, rawRemove = S.remove;

  function scopedKey(k, m) {
    return (SCOPED[k] && m === 'survival') ? PREFIX + k : k;
  }

  var mode = rawGet.call(S, KEY_MODE, 'casino') === 'survival' ? 'survival' : 'casino';

  /* Storage umbiegen: ab hier arbeiten alle Module automatisch im aktiven Modus. */
  S.get = function (k, fallback) { return rawGet.call(S, scopedKey(k, mode), fallback); };
  S.set = function (k, v) { return rawSet.call(S, scopedKey(k, mode), v); };
  S.remove = function (k) { return rawRemove.call(S, scopedKey(k, mode)); };

  var listeners = [];
  function emit() {
    for (var i = 0; i < listeners.length; i++) { try { listeners[i](mode); } catch (e) {} }
  }

  function syncBody() {
    if (!document.body) return;
    document.body.classList.toggle('mode-survival', mode === 'survival');
  }

  /** Alle modus-gebundenen Module neu aus dem Storage laden. */
  function refresh() {
    if (App.Coins && App.Coins.reloadFromStorage) App.Coins.reloadFromStorage();
    if (App.Chips && App.Chips.reloadFromStorage) App.Chips.reloadFromStorage();
    if (App.Progress && App.Progress.reloadFromStorage) App.Progress.reloadFromStorage();
    if (App.Stocks && App.Stocks.reload) App.Stocks.reload();
  }

  var Mode = {
    SCOPED_KEYS: Object.keys(SCOPED),

    get: function () { return mode; },
    is: function (m) { return mode === m; },

    set: function (m) {
      m = (m === 'survival') ? 'survival' : 'casino';
      if (m === mode) return mode;
      mode = m;
      rawSet.call(S, KEY_MODE, mode);
      syncBody();
      refresh();
      emit();
      return mode;
    },

    onChange: function (cb) {
      listeners.push(cb);
      return function () { var i = listeners.indexOf(cb); if (i >= 0) listeners.splice(i, 1); };
    },

    refresh: refresh,

    /* ---- Modus-fremder Zugriff (z. B. Konto-Sync liest den Casino-Stand,
     *      während gerade Survival gespielt wird) ---- */
    readIn: function (m, k, fallback) { return rawGet.call(S, scopedKey(k, m), fallback); },
    writeIn: function (m, k, v) { return rawSet.call(S, scopedKey(k, m), v); },

    /** Kompletten Spielstand eines Modus löschen (Survival-Neustart bei null). */
    wipe: function (m) {
      Object.keys(SCOPED).forEach(function (k) { rawRemove.call(S, scopedKey(k, m)); });
    },

    /* ---- Währungs-Identität ---- */
    coinIcon: function () { return mode === 'survival' ? '🥇' : '🪙'; },
    coinName: function () { return mode === 'survival' ? 'Gold-Coins' : 'Silber-Coins'; },
    coinShort: function () { return mode === 'survival' ? 'Gold' : 'Silber'; },
    iconFor: function (m) { return m === 'survival' ? '🥇' : '🪙'; }
  };

  App.Mode = Mode;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', syncBody);
  else syncBody();
})();
