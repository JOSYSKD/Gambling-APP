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
  var lastSkipTimer = false;

  /* Höchster Casino-Stand (Silber) dieses Geräts — IMMER aus dem Casino-Spielstand,
   * auch wenn gerade Survival läuft: Gold gehört nicht in die Casino-Bestenliste
   * (siehe js/mode.js). Damit steht jeder Spieler in der Bestenliste, ohne dass er
   * erst pleitegehen muss (js/leaderboard.js liest das über account.js aus). */
  function casinoPeak() {
    if (App.Mode && App.Mode.readIn) {
      return Math.max(Number(App.Mode.readIn('casino', 'gj_run_peak', 0)) || 0,
                      Number(App.Mode.readIn('casino', 'gj_balance', 0)) || 0);
    }
    return (App.Coins && App.Coins.getPeak()) || 0;
  }

  function isMax() { return !!(App.Progress && App.Progress.isMaxLevel && App.Progress.isMaxLevel()); }

  /* Längste Sieg-Serie dieses Geräts über alle Gambling-Spiele — IMMER aus dem
   * Casino-Stand (wie casinoPeak), damit die Streak-Bestenliste (js/leaderboard.js
   * getStreakBoard) auch dann die Casino-Serie zeigt, wenn gerade Survival läuft. */
  function casinoStreak() {
    if (App.Progress && App.Progress.maxStreakIn) return App.Progress.maxStreakIn('casino');
    return (App.Progress && App.Progress.maxStreak) ? App.Progress.maxStreak() : 0;
  }

  // Antwort eines Gastes auf eine Admin-Nachricht in seinen Präsenz-Eintrag schreiben
  // (Feld `replies`). Der Heartbeat bewahrt replies (siehe next.replies).
  function pushGuestReply(text, msg) {
    text = String(text || '').trim().slice(0, 300);
    if (!text || !App.Account || !App.Account.presenceGet) return Promise.resolve(false);
    var id = deviceId();
    return App.Account.presenceGet(id).then(function (rec) {
      rec = rec || {};
      rec.replies = (rec.replies || []).concat([{
        id: 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        text: text, ts: Date.now(),
        name: (App.Leaderboard && App.Leaderboard.getPlayerName()) || 'Gast',
        to: (msg && msg.id) || null, msgText: (msg && msg.text) || ''
      }]);
      if (rec.replies.length > 40) rec.replies = rec.replies.slice(rec.replies.length - 40);
      return App.Account.presenceSet(id, rec).then(function () { return true; });
    }).catch(function () { return false; });
  }

  function showMessage(msg) {
    if (!msg || !msg.id) return;
    if (App.Storage.get(KEY_MSG_SEEN, null) === msg.id) return;
    App.Storage.set(KEY_MSG_SEEN, msg.id);
    if (!App.UI || !App.UI.el) return;
    // Gemeinsames Modal mit Antwort-Feld (definiert in js/account.js). Fallback:
    // schlichtes Modal ohne Antwort, falls account.js (noch) nicht geladen ist.
    if (App.__showAdminMessageModal) { App.__showAdminMessageModal(msg, pushGuestReply); return; }
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
      lastSkipTimer = !!admin.svSkipTimer;   // Admin hat diesem Gast das Survival-Wartelimit abgenommen
      // Turnier-Tickets, die der Admin verschenkt hat, genau einmal einlösen
      // (gleiche Mechanik wie die Admin-Nachricht oben).
      if (App.Tickets && admin.ticketGrant) App.Tickets.applyGrant(admin.ticketGrant);
      // Survival-Gold vom Admin einlösen und danach aus dem Präsenz-Eintrag
      // entfernen (einmalig, wie bei Konten in account.js).
      if (App.Survival && admin.goldGrant) {
        App.Survival.applyGoldGrant(admin.goldGrant);
        admin.goldGrant = null;
      }
      // Profil-Snapshot (Kosmetik, Level, Glühbirnen, gespielte Spiele) mitschicken,
      // damit andere Spieler die Profilkarte + Spiele in der Bestenliste sehen können
      // (siehe js/profile-card.js snapshot + js/app.js renderLeaderboard).
      var snap = (App.ProfileCard && App.ProfileCard.snapshot) ? App.ProfileCard.snapshot() : null;
      var next = {
        name: (App.Leaderboard && App.Leaderboard.getPlayerName()) || 'Gast',
        balance: App.Coins ? App.Coins.get() : 0,
        tickets: App.Tickets ? App.Tickets.get() : 0,
        casinoPeak: casinoPeak(),
        streak: casinoStreak(),                  // längste Sieg-Serie (Streak-Bestenliste)
        maxLevel: isMax(),                       // goldener Name (Level 99999)
        replies: (rec && rec.replies) || [],     // Antworten an den Admin bewahren
        lastSeen: Date.now(),
        accountKey: loggedIn ? App.Account.currentKey() : null,
        admin: admin
      };
      if (snap) {
        next.cos = snap.cos;
        next.level = snap.level;
        next.bulbs = snap.bulbs;
        next.games = snap.games;
        next.pstats = snap.stats;
      }
      return App.Account.presenceSet(id, next);
    }).catch(function () {});
  }

  App.Presence = {
    isBanned: function () { return banned; },
    /** Gewinn-Faktor-Level für Gäste ohne Konto (siehe coins.js), 0 = kein Eingriff. */
    rig: function () { return lastRig; },
    /** Hat der Admin diesem Gast das Survival-Wartelimit abgenommen? (siehe js/survival.js) */
    skipsTimer: function () { return lastSkipTimer; }
  };

  function boot() {
    heartbeat();
    setInterval(heartbeat, HEARTBEAT_MS);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
