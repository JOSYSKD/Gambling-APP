/* presence.js — Online-Präsenz auch für Spieler OHNE Konto ("Gäste").
 *
 * js/account.js meldet dem Admin Panel (js/admin.js) nur Konten, die per
 * Kontoname+Passwort angelegt wurden. Die meisten Besucher spielen aber ohne
 * Konto (nur lokaler Spielername + lokales Guthaben, siehe askNameIfNeeded in
 * app.js). Damit der Admin wirklich ALLE Spieler sieht, meldet sich hier jeder
 * Tab regelmäßig unter einer festen, anonymen Geräte-ID im selben geteilten
 * Backend wie die Konten (presenceGet/presenceSet in account.js).
 *
 * Zusätzlich wendet dieses Modul Admin-Bann/Nachrichten auch auf Gäste an
 * (für eingeloggte Konten übernimmt das bereits account.js).
 */
(function () {
  'use strict';
  window.App = window.App || {};

  var KEY_DEVICE_ID = 'gj_device_id';
  var KEY_MSG_SEEN = 'gj_admin_msg_seen_guest';
  var HEARTBEAT_MS = 8000;

  function randHex(n) {
    var bytes = new Uint8Array(n);
    if (window.crypto && crypto.getRandomValues) crypto.getRandomValues(bytes);
    else for (var i = 0; i < n; i++) bytes[i] = Math.floor(Math.random() * 256);
    return Array.prototype.map.call(bytes, function (b) { return b.toString(16).padStart(2, '0'); }).join('');
  }
  function deviceId() {
    var id = App.Storage.get(KEY_DEVICE_ID, null);
    if (!id) { id = 'g' + randHex(10); App.Storage.set(KEY_DEVICE_ID, id); }
    return id;
  }

  var banned = false;
  var lastRig = 0;

  function showMessage(msg) {
    if (!msg || !msg.id) return;
    if (App.Storage.get(KEY_MSG_SEEN, null) === msg.id) return;
    App.Storage.set(KEY_MSG_SEEN, msg.id);
    if (!App.UI || !App.UI.el) return;
    var el = App.UI.el;
    var overlay = el('div', { class: 'modal-overlay' }, [
      el('div', { class: 'modal glass' }, [
        el('div', { class: 'modal-leaf' }, ['📢']),
        el('h2', { class: 'neon' }, ['Nachricht vom Admin']),
        el('p', {}, [msg.text]),
        el('button', { class: 'btn btn-primary btn-lg', type: 'button', onclick: function () {
          document.body.removeChild(overlay);
        } }, ['Verstanden'])
      ])
    ]);
    document.body.appendChild(overlay);
  }

  function applyBan(banUntil) {
    var isBanned = !!(banUntil && banUntil > Date.now());
    if (isBanned && !banned) {
      banned = true;
      var t = new Date(banUntil).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
      if (App.UI && App.UI.toast) App.UI.toast('🚫 Von einem Admin gesperrt bis ' + t + '.', 'lose');
      if (App.Router) App.Router.go('/');
    } else if (!isBanned) {
      banned = false;
    }
  }

  function heartbeat() {
    if (!App.Account || !App.Account.presenceGet || !App.Account.isReady || !App.Account.isReady()) return;
    // Eingeloggte Konten haben ihr eigenes Bann/Nachrichten/Rig-Handling in
    // account.js — hier nur den Online-Status des Geräts mitschicken.
    var loggedIn = App.Account.isLoggedIn && App.Account.isLoggedIn();
    var id = deviceId();
    App.Account.presenceGet(id).then(function (rec) {
      var admin = (rec && rec.admin) || {};
      if (!loggedIn) {
        applyBan(admin.banUntil);
        showMessage(admin.msg);
      }
      lastRig = admin.rig || 0;
      // Turnier-Tickets, die der Admin verschenkt hat, genau einmal einlösen
      // (gleiche Mechanik wie die Admin-Nachricht oben).
      if (App.Tickets && admin.ticketGrant) App.Tickets.applyGrant(admin.ticketGrant);
      // Survival-Gold vom Admin einlösen und danach aus dem Präsenz-Eintrag
      // entfernen (einmalig, wie bei Konten in account.js).
      if (App.Survival && admin.goldGrant) {
        App.Survival.applyGoldGrant(admin.goldGrant);
        admin.goldGrant = null;
      }
      var next = {
        name: (App.Leaderboard && App.Leaderboard.getPlayerName()) || 'Gast',
        balance: App.Coins ? App.Coins.get() : 0,
        tickets: App.Tickets ? App.Tickets.get() : 0,
        lastSeen: Date.now(),
        accountKey: loggedIn ? App.Account.currentKey() : null,
        admin: admin
      };
      return App.Account.presenceSet(id, next);
    }).catch(function () {});
  }

  App.Presence = {
    isBanned: function () { return banned; },
    /** Gewinn-Faktor-Level für Gäste ohne Konto (siehe coins.js), 0 = kein Eingriff. */
    rig: function () { return lastRig; }
  };

  function boot() {
    heartbeat();
    setInterval(heartbeat, HEARTBEAT_MS);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
