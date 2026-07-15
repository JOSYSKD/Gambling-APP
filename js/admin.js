/* admin.js — Admin-Panel für den Gambling-Bereich.
 *
 * Login: im normalen Konto-Login-Formular (Profil-Seite) Kontoname "ADMIN"
 * und Passwort "911911" eingeben -> Admin-Modus statt normalem Konto-Login.
 * Danach erscheint im Gambling-Menü ein Knopf "🛠 Admin Panel" (Route /admin).
 *
 * Funktionen:
 *  - Online-Spieler sehen (Konto zuletzt aktiv < 20s, wie account.js-Heartbeat).
 *    Zusätzlich zu Konten werden auch Gäste ohne Konto gelistet (siehe
 *    js/presence.js) — sonst würde der Admin nur einen Bruchteil der
 *    tatsächlichen Spieler sehen, da ein Konto nicht zum Spielen nötig ist.
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

    // Liefert eine zusammengeführte Liste ALLER Spieler: Konten (js/account.js)
    // PLUS Gäste ohne Konto, die sich nur per Präsenz-Heartbeat melden (siehe
    // js/presence.js). Ein Gast, der sich später einloggt, wird über sein
    // `accountKey` im Präsenz-Eintrag erkannt und nicht doppelt gelistet.
    listPlayers: function () {
      // WICHTIG: Konten- und Gäste-Liste unabhängig voneinander laden. Auf der
      // Live-DB ist die Regel für den 'presence'-Knoten evtl. noch nicht
      // veröffentlicht (database.rules.json muss in Firebase publiziert werden)
      // -> dann liefert adminListPresence() "Permission denied". Früher riss
      // dieser eine Fehler via Promise.all die GANZE Liste mit runter, sodass
      // das Panel nur noch eine Fehlermeldung zeigte. Jetzt fangen wir jeden
      // Teil einzeln ab: Konten werden immer angezeigt, Gäste nur wenn möglich.
      var presenceFailed = false;
      var pAccounts = Promise.resolve(App.Account.adminListAccounts()).catch(function () { return {}; });
      var pPresence = Promise.resolve(App.Account.adminListPresence()).catch(function () { presenceFailed = true; return {}; });
      return Promise.all([pAccounts, pPresence]).then(function (r) {
        var accounts = r[0] || {}, presence = r[1] || {};
        var rows = [];
        Object.keys(accounts).forEach(function (key) {
          var acct = accounts[key] || {};
          rows.push({
            key: key, kind: 'account',
            displayName: acct.displayName || key,
            balance: acct.balance || 0,
            lastSeen: (acct.session && acct.session.lastSeen) || 0,
            admin: acct.admin || {}
          });
        });
        Object.keys(presence).forEach(function (id) {
          var p = presence[id] || {};
          if (p.accountKey && accounts[p.accountKey]) return; // schon als Konto gelistet
          rows.push({
            key: id, kind: 'guest',
            displayName: (p.name || 'Gast') + ' (Gast)',
            balance: p.balance || 0,
            lastSeen: p.lastSeen || 0,
            admin: p.admin || {}
          });
        });
        rows.presenceFailed = presenceFailed;
        return rows;
      });
    },
    setRig: function (kind, key, level) {
      var patch = kind === 'guest' ? App.Account.adminPatchPresence : App.Account.adminPatch;
      return patch(key, function (rec) { rec.admin = rec.admin || {}; rec.admin.rig = level; });
    },
    ban: function (kind, key, minutes) {
      var patch = kind === 'guest' ? App.Account.adminPatchPresence : App.Account.adminPatch;
      return patch(key, function (rec) { rec.admin = rec.admin || {}; rec.admin.banUntil = Date.now() + minutes * 60000; });
    },
    unban: function (kind, key) {
      var patch = kind === 'guest' ? App.Account.adminPatchPresence : App.Account.adminPatch;
      return patch(key, function (rec) { rec.admin = rec.admin || {}; rec.admin.banUntil = 0; });
    },
    sendMessage: function (kind, key, text) {
      var patch = kind === 'guest' ? App.Account.adminPatchPresence : App.Account.adminPatch;
      return patch(key, function (rec) {
        rec.admin = rec.admin || {};
        rec.admin.msg = { id: genId(), text: String(text || '').slice(0, 200), ts: Date.now() };
      });
    },

    renderPage: function (root) {
      injectCss();
      var refreshTimer = null;
      var msgDrafts = {};
      var banDrafts = {};
      var loading = false;

      function buildRow(row, now) {
        var key = row.key, kind = row.kind, rowId = kind + ':' + key;
        var online = !!(row.lastSeen && (now - row.lastSeen) < ONLINE_MS);
        var admin = row.admin || {};
        var banned = admin.banUntil && admin.banUntil > now;

        var rigBtns = RIG_LEVELS.map(function (r) {
          return el('button', {
            class: 'btn btn-ghost admin-rig-btn' + ((admin.rig || 0) === r.level ? ' active' : ''),
            type: 'button', title: r.hint,
            onclick: function () {
              Admin.setRig(kind, key, r.level).then(function () {
                UI.toast('Chancen für ' + row.displayName + ': ' + r.label, r.level < 0 ? 'lose' : 'win');
                refresh();
              }).catch(function (e) { UI.toast(e.message, 'lose'); });
            }
          }, [r.label]);
        });

        var banMinutes = el('input', {
          class: 'text-input admin-ban-input', type: 'number', min: 1,
          value: banDrafts[rowId] || 15
        });
        banMinutes.addEventListener('input', function () { banDrafts[rowId] = banMinutes.value; });

        var banControls = banned
          ? el('div', { class: 'admin-row-actions' }, [
              el('span', { class: 'cf-status lose' }, ['🚫 Gesperrt bis ' + new Date(admin.banUntil).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })]),
              el('button', { class: 'btn btn-ghost', type: 'button', onclick: function () {
                Admin.unban(kind, key).then(function () { UI.toast('Entsperrt', 'win'); refresh(); }).catch(function (e) { UI.toast(e.message, 'lose'); });
              } }, ['Entsperren'])
            ])
          : el('div', { class: 'admin-row-actions' }, [
              banMinutes,
              el('span', { class: 'cf-info-l' }, ['Min.']),
              el('button', { class: 'btn btn-ghost', type: 'button', onclick: function () {
                var mins = Math.max(1, Math.round(Number(banMinutes.value) || 15));
                Admin.ban(kind, key, mins).then(function () {
                  UI.toast('Gesperrt für ' + mins + ' Min.', 'lose');
                  refresh();
                }).catch(function (e) { UI.toast(e.message, 'lose'); });
              } }, ['🚫 Bannen'])
            ]);

        var msgInput = el('input', {
          class: 'text-input', type: 'text', maxlength: 200,
          placeholder: 'Admin-Nachricht an ' + row.displayName + ' …',
          value: msgDrafts[rowId] || ''
        });
        msgInput.addEventListener('input', function () { msgDrafts[rowId] = msgInput.value; });
        var msgBtn = el('button', { class: 'btn btn-primary', type: 'button', onclick: function () {
          var text = (msgInput.value || '').trim();
          if (!text) return;
          Admin.sendMessage(kind, key, text).then(function () {
            UI.toast('Nachricht gesendet an ' + row.displayName, 'win');
            msgInput.value = ''; msgDrafts[rowId] = '';
          }).catch(function (e) { UI.toast(e.message, 'lose'); });
        } }, ['📨 Senden']);

        return el('div', { class: 'glass admin-row' + (online ? ' admin-online' : '') }, [
          el('div', { class: 'admin-row-head' }, [
            el('span', { class: 'admin-dot' + (online ? ' online' : '') }, [online ? '🟢' : '⚪']),
            el('b', {}, [row.displayName]),
            el('span', { class: 'cf-info-l' }, [UI.formatCoins(row.balance || 0) + ' 🪙']),
            el('span', { class: 'cf-info-l' }, ['Chancen: ' + rigLabelFor(admin.rig)])
          ]),
          el('div', { class: 'admin-rig-row' }, rigBtns),
          banControls,
          el('div', { class: 'admin-row-actions' }, [msgInput, msgBtn])
        ]);
      }

      function draw(rows) {
        root.innerHTML = '';
        var now = Date.now();
        rows.forEach(function (row) { row.online = !!(row.lastSeen && (now - row.lastSeen) < ONLINE_MS); });

        // Stabil sortieren (online zuerst, dann alphabetisch nach Name): reines
        // Sortieren nach lastSeen ließ die Liste bei jedem Refresh (alle 4s)
        // ständig springen, weil sich Heartbeat-Zeitstempel minimal unterscheiden.
        rows.sort(function (a, b) {
          if (a.online !== b.online) return a.online ? -1 : 1;
          var an = (a.displayName || '').toLowerCase(), bn = (b.displayName || '').toLowerCase();
          if (an !== bn) return an < bn ? -1 : 1;
          return a.key < b.key ? -1 : (a.key > b.key ? 1 : 0);
        });

        var onlineCount = rows.filter(function (r) { return r.online; }).length;

        root.appendChild(el('div', { class: 'page-head' }, [
          el('button', { class: 'btn btn-ghost back', type: 'button', onclick: function () { App.Router.go('/category/gambling'); } }, ['← Zurück']),
          el('h2', { class: 'page-title neon' }, ['🛠 Admin Panel'])
        ]));
        root.appendChild(el('p', { class: 'lb-hint' }, [
          rows.length + ' Spieler insgesamt (Konten + Gäste) · 🟢 ' + onlineCount + ' gerade online.'
          + ' Chancen-Änderung wirkt als Gewinn-Faktor über alle Gambling-Spiele hinweg.'
        ]));
        if (rows.presenceFailed) {
          // Gäste (Spieler ohne Konto) brauchen Lese-/Schreibzugriff auf den
          // 'presence'-Knoten in Firebase. Solange die Regeln (database.rules.json)
          // dort nicht veröffentlicht sind, sieht der Admin nur Konten.
          root.appendChild(el('p', { class: 'lb-hint', style: 'color:var(--gold);' }, [
            '⚠️ Gäste ohne Konto können gerade nicht geladen werden '
            + '(Firebase-Regel für „presence" noch nicht veröffentlicht). '
            + 'Konten werden trotzdem angezeigt.'
          ]));
        }
        root.appendChild(el('button', { class: 'btn btn-ghost', type: 'button', onclick: function () {
          Admin.logout();
          UI.toast('Admin-Modus beendet', 'info');
          App.Router.go('/');
        } }, ['🚪 Admin-Modus verlassen']));

        if (!rows.length) {
          root.appendChild(el('p', { class: 'lb-empty' }, ['Noch keine Spieler vorhanden.']));
          return;
        }

        var list = el('div', { class: 'admin-list' });
        rows.forEach(function (row) { list.appendChild(buildRow(row, now)); });
        root.appendChild(list);
      }

      function refresh() {
        if (loading) return;
        loading = true;
        Admin.listPlayers().then(function (rows) {
          loading = false;
          draw(rows || []);
        }).catch(function () {
          // listPlayers() fängt Teil-Fehler inzwischen selbst ab und wirft
          // praktisch nie mehr. Falls doch (kein Backend), NICHT die ganze Seite
          // leerräumen — sonst verschwindet auch der Zurück-/Verlassen-Knopf und
          // der Admin sitzt fest. Nur eine dezente Meldung anhängen.
          loading = false;
          if (!root.querySelector('.admin-load-err')) {
            root.appendChild(el('p', { class: 'lb-hint admin-load-err', style: 'color:var(--gold);' }, [
              'Spieler konnten nicht geladen werden. Neuer Versuch in wenigen Sekunden …'
            ]));
          }
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
