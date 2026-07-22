/* rig.js — Wahrscheinlichkeits-Rigging pro Spieler (gesetzt im Admin-Panel).
 *
 * Anders als der Auszahlungs-FAKTOR in coins.js (rigFactor, ändert die Gewinnhöhe)
 * manipuliert dieses Modul das ERGEBNIS echter Glücksspiele: der Admin kann einem
 * einzelnen Spieler eine Verlust- oder Gewinn-Wahrscheinlichkeit vorgeben
 * (z. B. "verliert Coinflip zu 80 %") oder für Crash einen festen Crash-Punkt
 * (z. B. "crasht immer bei 1,01×"). Nur die klassischen Glücksspiele fragen das ab
 * (Coinflip, Crash, Dice, Roulette, Slots, Blackjack, Mines, HiLo, Wheel …).
 *
 * Datenquelle ist dasselbe admin-Objekt wie beim bestehenden Rigging:
 *   admin.odds = { lose: 0..1|null, win: 0..1|null, crashAt: Zahl>=1|null }
 * für Konten via App.Account.adminMeta(), für Gäste via App.Presence.odds().
 */
(function () {
  'use strict';
  window.App = window.App || {};

  function odds() {
    var o = null;
    if (App.Account && App.Account.adminMeta) {
      var meta = App.Account.adminMeta();
      if (meta && meta.odds) o = meta.odds;
    }
    if (!o && App.Presence && App.Presence.odds) o = App.Presence.odds();
    return (o && typeof o === 'object') ? o : null;
  }

  var Rig = {
    /** Erzwingt das Ergebnis der nächsten Glücksspiel-Runde:
     *   'lose' -> Spieler soll verlieren
     *   'win'  -> Spieler soll gewinnen
     *   null   -> kein Eingriff (normaler Zufall des Spiels)
     *  Ein Spiel ruft das VOR seiner eigenen Zufallsentscheidung auf. */
    outcome: function () {
      var o = odds();
      if (!o) return null;
      if (typeof o.lose === 'number' && o.lose > 0 && Math.random() < o.lose) return 'lose';
      if (typeof o.win === 'number' && o.win > 0 && Math.random() < o.win) return 'win';
      return null;
    },

    /** Fester Crash-Multiplikator fürs Crash-Spiel (oder null). Hat der Spieler
     *  zusätzlich eine hohe Verlust-Wahrscheinlichkeit, crasht Crash sehr früh. */
    crashAt: function () {
      var o = odds();
      if (!o) return null;
      if (typeof o.crashAt === 'number' && o.crashAt >= 1) return o.crashAt;
      // Ohne festen Crash-Punkt, aber mit Verlust-Zwang -> ganz früher Crash.
      if (typeof o.lose === 'number' && o.lose > 0 && Math.random() < o.lose) return 1.00;
      return null;
    },

    /** Ist gerade irgendein Eingriff aktiv? (für Anzeigen im Admin-Panel) */
    active: function () { var o = odds(); return !!(o && (o.lose || o.win || o.crashAt)); }
  };

  App.Rig = Rig;
})();
