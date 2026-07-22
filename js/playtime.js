/* playtime.js — misst die aktive Spielzeit auf der Seite.
 *
 * Zählt nur, solange der Tab wirklich sichtbar ist (kein Weiterlaufen, wenn die
 * Seite im Hintergrund liegt). Der Wert liegt modus-ÜBERGREIFEND im Storage
 * (gesamte Zeit auf der Seite, egal ob Casino oder Survival) und wird per
 * Präsenz-Heartbeat (js/presence.js) geteilt, damit man die eigene UND die
 * Spielzeit anderer in den Stats + einer Bestenliste sieht (js/boards.js).
 *
 * Rückwirkend: wer schon länger dabei ist, startet nicht bei 0 — beim ersten
 * Mal wird aus Level + Anzahl gespielter Spiele eine plausible bisherige
 * Spielzeit geschätzt (so, als hätte es die Messung von Anfang an gegeben).
 */
(function () {
  'use strict';
  window.App = window.App || {};

  var KEY = 'gj_playtime_ms';
  var KEY_SEED = 'gj_playtime_seeded';
  var TICK_MS = 15000;

  function load() { return Math.max(0, Number(App.Storage.get(KEY, 0)) || 0); }
  var accumulated = load();
  var lastStamp = Date.now();

  function save() { App.Storage.set(KEY, Math.round(accumulated)); }

  function tick() {
    var now = Date.now();
    var dt = now - lastStamp;
    lastStamp = now;
    // Nur zählen bei sichtbarem Tab und plausibler Differenz (kein Nachzählen von
    // Schlaf-/Hintergrund-Phasen).
    if (document.visibilityState !== 'hidden' && dt > 0 && dt < TICK_MS * 3) {
      accumulated += dt;
      save();
    }
  }

  // Beim ersten Start rückwirkend schätzen (nach kurzer Verzögerung, damit
  // Progress/Profilkarte geladen sind).
  function seedIfNeeded() {
    if (App.Storage.get(KEY_SEED, false)) return;
    App.Storage.set(KEY_SEED, true);
    if (accumulated > 0) return;   // schon echte Zeit vorhanden -> nichts überschreiben
    var level = (App.Progress && App.Progress.level) ? App.Progress.level() : 1;
    var games = 0;
    try {
      var snap = App.ProfileCard && App.ProfileCard.snapshot && App.ProfileCard.snapshot();
      if (snap && snap.games && snap.games.length) games = snap.games.length;
    } catch (e) {}
    var estMin = 8 + level * 3 + games * 2;   // grobe, plausible Rückschätzung
    accumulated = estMin * 60000;
    save();
  }

  function fmt(ms) {
    ms = Math.max(0, Number(ms) || 0);
    var s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    if (h >= 1) return h + ' h ' + (m < 10 ? '0' + m : m) + ' min';
    if (m >= 1) return m + ' min';
    return s + ' s';
  }

  App.Playtime = {
    getMs: function () { return Math.round(accumulated); },
    getFormatted: function () { return fmt(accumulated); },
    format: fmt
  };

  function boot() {
    lastStamp = Date.now();
    setInterval(tick, TICK_MS);
    document.addEventListener('visibilitychange', function () { lastStamp = Date.now(); });
    setTimeout(seedIfNeeded, 2500);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
