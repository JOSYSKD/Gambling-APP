/* admin.js — Admin-Panel für den Gambling-Bereich.
 *
 * Login: im normalen Konto-Login-Formular (Profil-Seite) Kontoname "ADMIN"
 * und Passwort "911911" eingeben -> Admin-Modus statt normalem Konto-Login.
 * Danach erscheint im Gambling-Menü ein Knopf "🛠 Admin Panel" (Route /admin).
 *
 * Funktionen:
 *  - Online-Spieler sehen (Konto zuletzt aktiv < 20s, wie account.js-Heartbeat)
 *  - Chancen eines Spielers verändern ("riggen"): wirkt als Auszahlungs-Faktor
 *    auf alle künftigen Gewinne dieses Spielers (siehe coins.js), über ALLE
 *    Gambling-Spiele hinweg — ohne einzelne Spiele einzeln patchen zu müssen.
 *  - Spieler zeitlich sperren (Bann mit Ablaufzeit, blockt Login + kickt eine
 *    laufende Sitzung beim nächsten Heartbeat).
 *  - Admin-Nachrichten an einzelne Spieler schicken (erscheinen als Modal).
 *
 * Sicherheits-Hinweis: Wie der Rest dieser Seite (siehe account.js) läuft
 * alles ohne eigenen Server — der Login-Check UND die Datenbank-Regeln
 * (database.rules.json: offener Lese-/Schreibzugriff) sind daher kein
 * echter Zugriffsschutz, sondern Casual-Schutz für eine Klassen-/Freundes-
 * runde. Wer will, kann die Werte direkt über die Firebase-REST-API lesen
 * oder schreiben. Bitte keine echten Passwörter/Daten hier verwenden.
 */
(function () {
  'use strict';
  window.App = window.App || {};
  var UI = App.UI, el = UI.el;

  var ADMIN_USER = 'admin';
  var ADMIN_PASS = '911911';
  var KEY_SESSION = 'gj_admin_session';
  var ONLINE_MS = 20000; // deckt sich mit SESSION_STALE_MS in account.js

  var RIG_LEVELS = [
    { level: 2, label: '🍀 Sehr viel Glück', hint: 'Gewinne ×2.5' },
    { level: 1, label: '🙂 Etwas Glück', hint: 'Gewinne ×1.6' },
    { level: 0, label: '⚖️ Normal', hint: 'kein Eingriff' },
    { level: -1, label: '☁️ Etwas Pech', hint: 'Gewinne ×0.5' },
    { level: -2, label: '⛈️ Sehr viel Pech', hint: 'Gewinne ×0.15' }
  ];

  function injectCss() {
    UI.injectStyle('admin-panel-css', [
      '.admin-list{display:flex;flex-direction:column;gap:12px;}',
      '.admin-row{padding:16px;display:flex;flex-direction:column;gap:10px;}',
      '.admin-row.admin-online{border-color:var(--neon);}',
      '.admin-row-head{display:flex;flex-wrap:wrap;align-items:center;gap:8px 14px;}',
      '.admin-dot{opacity:.4;}',
      '.admin-dot.online{opacity:1;filter:drop-shadow(0 0 4px rgba(57,255,20,0.8));}',
      '.admin-rig-row{display:flex;flex-wrap:wrap;gap:6px;}',
      '.admin-rig-btn{font-size:12px;padding:6px 10px;}',
      '.admin-rig-btn.active{color:#04160c;background:linear-gradient(180deg,var(--neon-soft),var(--neon));border-color:var(--neon);}',
      '.admin-row-actions{display:flex;flex-wrap:wrap;align-items:center;gap:8px;}',
      '.admin-row-actions .text-input{flex:1 1 200px;}',
      '.admin-ban-input{flex:0 0 90px;}'
    ].join(''));
  }

  var listeners = [];
  function emit() { listeners.forEach(function (cb) { try { cb(); } catch (e) {} }); }

  function genId() { return 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

  function rigLabelFor(level) {
    var found = RIG_LEVELS.filter(function (r) { return r.level === (level || 0); })[0];
    return (found || RIG_LEVELS[2]).label;
  }

  var Admin = {
    isAdmin: function () { return App.Storage.get(KEY_SESSION, false) === true; },

    tryLogin: function (user, pass) {
      if (String(user || '').trim().toLowerCase() === ADMIN_USER && String(pass || '') === ADMIN_PASS) {
        App.Storage.set(KEY_SESSION, true);
        emit();
        return true;
      }
      return false;
    },

    logout: function () { App.Storage.remove(KEY_SESSION); emit(); },

    onChange: function (cb) {
      listeners.push(cb);
      return function () { var i = listeners.indexOf(cb); if (i >= 0) listeners.splice(i, 1); };
    },

    listPlayers: function () { return App.Account.adminListAccounts(); },
    setRig: function (key, level) { return App.Account.adminPatch(key, function (acct) { acct.admin = acct.admin || {}; acct.admin.rig = level; }); },
    ban: function (key, minutes) { return App.Account.adminPatch(key, function (acct) { acct.admin = acct.admin || {}; acct.admin.banUntil = Date.now() + minutes * 60000; }); },
    unban: function (key) { return App.Account.adminPatch(key, function (acct) { acct.admin = acct.admin || {}; acct.admin.banUntil = 0; }); },
    sendMessage: function (key, text) {
      return App.Account.adminPatch(key, function (acct) {
        acct.admin = acct.admin || {};
        acct.admin.msg = { id: genId(), text: String(text || '').slice(0, 200), ts: Date.now() };
      });
    },

    renderPage: function (root) {
      injectCss();
      var refreshTimer = null;
      var msgDrafts = {};
      var banDrafts = {};
      var loading = false;

      function buildRow(key, acct, now) {
        var online = !!(acct.session && acct.session.lastSeen && (now - acct.session.lastSeen) < ONLINE_MS);
        var admin = acct.admin || {};
        var banned = admin.banUntil && admin.banUntil > now;

        var rigBtns = RIG_LEVELS.map(function (r) {
          return el('button', {
            class: 'btn btn-ghost admin-rig-btn' + ((admin.rig || 0) === r.level ? ' active' : ''),
            type: 'button', title: r.hint,
            onclick: function () {
              Admin.setRig(key, r.level).then(function () {
                UI.toast('Chancen für ' + (acct.displayName || key) + ': ' + r.label, r.level < 0 ? 'lose' : 'win');
                refresh();
              }).catch(function (e) { UI.toast(e.message, 'lose'); });
            }
          }, [r.label]);
        });

        var banMinutes = el('input', {
          class: 'text-input admin-ban-input', type: 'number', min: 1,
          value: banDrafts[key] || 15
        });
        banMinutes.addEventListener('input', function () { banDrafts[key] = banMinutes.value; });

        var banControls = banned
          ? el('div', { class: 'admin-row-actions' }, [
              el('span', { class: 'cf-status lose' }, ['🚫 Gesperrt bis ' + new Date(admin.banUntil).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })]),
              el('button', { class: 'btn btn-ghost', type: 'button', onclick: function () {
                Admin.unban(key).then(function () { UI.toast('Entsperrt', 'win'); refresh(); }).catch(function (e) { UI.toast(e.message, 'lose'); });
              } }, ['Entsperren'])
            ])
          : el('div', { class: 'admin-row-actions' }, [
              banMinutes,
              el('span', { class: 'cf-info-l' }, ['Min.']),
              el('button', { class: 'btn btn-ghost', type: 'button', onclick: function () {
                var mins = Math.max(1, Math.round(Number(banMinutes.value) || 15));
                Admin.ban(key, mins).then(function () {
                  UI.toast('Gesperrt für ' + mins + ' Min.', 'lose');
                  refresh();
                }).catch(function (e) { UI.toast(e.message, 'lose'); });
              } }, ['🚫 Bannen'])
            ]);

        var msgInput = el('input', {
          class: 'text-input', type: 'text', maxlength: 200,
          placeholder: 'Admin-Nachricht an ' + (acct.displayName || key) + ' …',
          value: msgDrafts[key] || ''
        });
        msgInput.addEventListener('input', function () { msgDrafts[key] = msgInput.value; });
        var msgBtn = el('button', { class: 'btn btn-primary', type: 'button', onclick: function () {
          var text = (msgInput.value || '').trim();
          if (!text) return;
          Admin.sendMessage(key, text).then(function () {
            UI.toast('Nachricht gesendet an ' + (acct.displayName || key), 'win');
            msgInput.value = ''; msgDrafts[key] = '';
          }).catch(function (e) { UI.toast(e.message, 'lose'); });
        } }, ['📨 Senden']);

        return el('div', { class: 'glass admin-row' + (online ? ' admin-online' : '') }, [
          el('div', { class: 'admin-row-head' }, [
            el('span', { class: 'admin-dot' + (online ? ' online' : '') }, [online ? '🟢' : '⚪']),
            el('b', {}, [acct.displayName || key]),
            el('span', { class: 'cf-info-l' }, [UI.formatCoins(acct.balance || 0) + ' 🪙']),
            el('span', { class: 'cf-info-l' }, ['Chancen: ' + rigLabelFor(admin.rig)])
          ]),
          el('div', { class: 'admin-rig-row' }, rigBtns),
          banControls,
          el('div', { class: 'admin-row-actions' }, [msgInput, msgBtn])
        ]);
      }

      function draw(accounts) {
        root.innerHTML = '';
        var keys = Object.keys(accounts);
        var now = Date.now();
        keys.sort(function (a, b) {
          var la = (accounts[a].session && accounts[a].session.lastSeen) || 0;
          var lb = (accounts[b].session && accounts[b].session.lastSeen) || 0;
          return lb - la;
        });
        var onlineCount = keys.filter(function (k) {
          var s = accounts[k].session;
          return s && s.lastSeen && (now - s.lastSeen) < ONLINE_MS;
        }).length;

        root.appendChild(el('div', { class: 'page-head' }, [
          el('button', { class: 'btn btn-ghost back', type: 'button', onclick: function () { App.Router.go('/category/gambling'); } }, ['← Zurück']),
          el('h2', { class: 'page-title neon' }, ['🛠 Admin Panel'])
        ]));
        root.appendChild(el('p', { class: 'lb-hint' }, [
          keys.length + ' Konten insgesamt · 🟢 ' + onlineCount + ' gerade online.'
          + ' Chancen-Änderung wirkt als Gewinn-Faktor über alle Gambling-Spiele hinweg.'
        ]));
        root.appendChild(el('button', { class: 'btn btn-ghost', type: 'button', onclick: function () {
          Admin.logout();
          UI.toast('Admin-Modus beendet', 'info');
          App.Router.go('/');
        } }, ['🚪 Admin-Modus verlassen']));

        if (!keys.length) {
          root.appendChild(el('p', { class: 'lb-empty' }, ['Noch keine Konten vorhanden.']));
          return;
        }

        var list = el('div', { class: 'admin-list' });
        keys.forEach(function (key) { list.appendChild(buildRow(key, accounts[key], now)); });
        root.appendChild(list);
      }

      function refresh() {
        if (loading) return;
        loading = true;
        Admin.listPlayers().then(function (accounts) {
          loading = false;
          draw(accounts || {});
        }).catch(function () {
          loading = false;
          root.innerHTML = '';
          root.appendChild(el('p', { class: 'err' }, ['Konten konnten nicht geladen werden (kein geteiltes Backend konfiguriert?).']));
        });
      }

      refresh();
      refreshTimer = setInterval(refresh, 4000);

      return {
        cleanup: function () { if (refreshTimer) clearInterval(refreshTimer); }
      };
    }
  };

  App.Admin = Admin;
})();
