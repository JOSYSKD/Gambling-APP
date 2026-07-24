/* tickets.js — Turnier-Tickets (App.Tickets).
 *
 * Ein Ticket ist die Eintrittskarte für eine Turnier-Teilnahme (siehe
 * js/tournament.js). Herkunft:
 *   - Quests: jede eingelöste Quest bringt Tickets mit (siehe js/progress.js,
 *     ticketsFor() unten legt fest, wie viele).
 *   - Admin: kann im Admin Panel Tickets verschenken (einmalige "grants", die
 *     der Client wie eine Admin-Nachricht genau einmal einlöst).
 *
 * Speicherung: wie das Guthaben lokal im Storage. Der Wert wird zusätzlich in
 * den Präsenz-/Konto-Datensatz gespiegelt (js/presence.js, js/account.js),
 * damit der Admin die Ticketstände in seiner Spielerliste sieht. Das ist wie
 * der Rest der Seite Casual-Schutz, kein echter Server-Check — wer will, kann
 * seinen Storage editieren. Für eine Klassen-/Freundesrunde reicht das.
 */
(function () {
  'use strict';
  window.App = window.App || {};

  var KEY = 'gj_tickets';
  var KEY_GRANT_SEEN = 'gj_ticket_grant_seen';
  var START = 1;   // ein Willkommens-Ticket, damit das erste Turnier ohne Grinden geht

  var listeners = [];
  function emit() {
    var n = get();
    listeners.forEach(function (cb) { try { cb(n); } catch (e) {} });
  }

  var CAP = 999;   // Ticket-Maximum — auch hier gibt es kein "unendlich"

  function get() {
    var v = App.Storage.get(KEY, null);
    if (v === null || typeof v !== 'number' || v < 0) { v = START; App.Storage.set(KEY, v); }
    return Math.min(CAP, v);
  }
  function set(n) {
    App.Storage.set(KEY, Math.max(0, Math.min(CAP, Math.round(Number(n) || 0))));
    emit();
    return get();
  }

  /* Wie viele Tickets eine Quest-Belohnung abwirft. Skaliert mit der Coin-
   * Belohnung der Quest, damit die dicken Quests (Whale, Jackpot-Jäger) mehr
   * bringen als "Spiele 10 Runden" — ohne dass jede Quest einzeln gepflegt
   * werden muss. */
  function ticketsFor(reward) {
    var coins = (reward && reward.coins) || 0;
    if (coins >= 8000) return 3;
    if (coins >= 2000) return 2;
    return 1;
  }

  var Tickets = {
    START: START,

    get: get,
    set: set,

    /** Tickets gutschreiben (Quest-Belohnung, Admin-Geschenk). */
    add: function (n) {
      n = Math.round(Number(n) || 0);
      if (n === 0) return get();
      return set(get() + n);
    },

    /** Tickets abbuchen. Gibt false zurück (und bucht nichts ab), wenn zu wenige da sind. */
    spend: function (n) {
      n = Math.max(0, Math.round(Number(n) || 0));
      if (get() < n) return false;
      set(get() - n);
      return true;
    },

    has: function (n) { return get() >= Math.max(0, Math.round(Number(n) || 0)); },

    onChange: function (cb) {
      listeners.push(cb);
      return function () { var i = listeners.indexOf(cb); if (i >= 0) listeners.splice(i, 1); };
    },

    ticketsFor: ticketsFor,

    /** Belohnung einer eingelösten Quest -> Tickets. Wird von progress.js gerufen. */
    grantForQuest: function (reward) {
      var n = ticketsFor(reward);
      Tickets.add(n);
      return n;
    },

    /** Einmaliges Admin-Geschenk einlösen ({id, n}), wie eine Admin-Nachricht.
     *  Wird aus dem Präsenz-/Konto-Heartbeat gefüttert. */
    applyGrant: function (grant) {
      if (!grant || !grant.id) return false;
      if (App.Storage.get(KEY_GRANT_SEEN, null) === grant.id) return false;
      App.Storage.set(KEY_GRANT_SEEN, grant.id);
      var n = Math.max(0, Math.round(Number(grant.n) || 0));
      if (!n) return false;
      Tickets.add(n);
      if (App.UI && App.UI.toast) App.UI.toast('🎟️ Vom Admin geschenkt: ' + n + ' Turnier-Ticket' + (n === 1 ? '' : 's'), 'win');
      return true;
    },

    /** Anzeige-Text, z. B. "3 Tickets". */
    label: function (n) {
      if (n == null) n = get();
      return n + ' Ticket' + (n === 1 ? '' : 's');
    }
  };

  App.Tickets = Tickets;
})();
