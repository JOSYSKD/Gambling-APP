/* tournament-presets.js — Turnier-Vorlagen für den Admin (App.TournamentPresets).
 *
 * Der Admin klickt im Turnier-Panel (js/tournament-admin.js) einmal ein Turnier
 * komplett zusammen (Name, Rundenplan, Zeiten, Ticketpreis, Preis …) und
 * speichert diese Einstellung als benannte VORLAGE. Später genügt ein Klick:
 *   · „📋 Laden"   füllt alle Felder mit der Vorlage (er kann noch anpassen),
 *   · „🏆 Ansetzen" lädt die Vorlage UND setzt das Turnier sofort an.
 *
 * Gespeichert werden die ROHEN Feldwerte (nicht die fertige save-Config), damit
 * das Laden = Felder-Befüllen verlustfrei ist. Die Startzeit liegt als „HH:MM"
 * vor: eine Vorlage „Abend-Cup 18:00" setzt beim Ansetzen wieder auf 18 Uhr
 * (heute, sonst morgen) — genau wie das Uhrzeit-Feld selbst.
 *
 * Speicherort wie bei den Spielideen (js/ideas.js): der bereits in Firebase
 * freigegebene Knoten `scores`, Unterschlüssel `scores/__tournament_presets`.
 * Kein neuer Regel-Deploy nötig; scores.js liest nur `scores/<spielId>`, der
 * doppelte Unterstrich kollidiert mit keiner Bestenliste. So sind die Vorlagen
 * geräteübergreifend da (PC wie Handy). Ohne Firebase (file://) läuft alles über
 * den lokalen Fallback von App.Net.store() — dann eben nur auf diesem Gerät.
 *
 * Nur der Admin sieht/nutzt diese Vorlagen; der Pfad ist zwar technisch offen,
 * enthält aber nur harmlose Turnier-Voreinstellungen.
 */
(function () {
  'use strict';
  window.App = window.App || {};

  var PATH = 'scores/__tournament_presets';

  function store() { return App.Net.store(); }
  function newId() { return 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

  /** Alle Vorlagen, neueste zuerst. */
  function list() {
    return store().then(function (b) { return b.get(PATH); }).then(function (o) {
      var arr = [];
      if (o) Object.keys(o).forEach(function (k) {
        var p = o[k];
        if (p && typeof p === 'object') { p.id = k; arr.push(p); }
      });
      arr.sort(function (a, b2) { return (b2.savedAt || 0) - (a.savedAt || 0); });
      return arr;
    }).catch(function () { return []; });
  }

  /**
   * Vorlage anlegen/überschreiben. `preset` = rohe Feldwerte (siehe presetFromForm
   * in tournament-admin.js). Gibt die gespeicherte Vorlage mit id zurück.
   */
  function save(preset) {
    var id = preset.id || newId();
    var rec = {
      name: String(preset.name || 'Vorlage').slice(0, 40),
      savedAt: Date.now(),
      title: String(preset.title || '').slice(0, 40),
      time: String(preset.time || ''),
      roundSec: Number(preset.roundSec) || 60,
      ticketCost: Math.max(0, Math.round(Number(preset.ticketCost) || 0)),
      chat: !!preset.chat,
      prizeKind: preset.prizeKind === 'powerup' ? 'powerup' : 'money',
      prizeType: String(preset.prizeType || 'luck2'),
      prizeSec: Math.max(1, Math.round(Number(preset.prizeSec) || 60)),
      prizeAmt: Math.max(1, Math.round(Number(preset.prizeAmt) || 5000)),
      pot: String(preset.pot || '1B'),
      rounds: (preset.rounds || []).slice(0, 64).map(String),
      roundSecs: (preset.roundSecs || []).slice(0, 64).map(function (s) { return Math.max(5, Math.round(Number(s) || 60)); })
    };
    var patch = {};
    patch[id] = rec;
    return store().then(function (b) { return b.update(PATH, patch); }).then(function () {
      rec.id = id; return rec;
    });
  }

  function remove(id) { return store().then(function (b) { return b.remove(PATH + '/' + id); }); }

  App.TournamentPresets = { list: list, save: save, remove: remove };
})();
