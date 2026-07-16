/* admin.js — Admin-Panel für den Gambling-Bereich.
 *
 * Login: im normalen Konto-Login-Formular (Profil-Seite) Kontoname "J0SY_SKD"
 * (oder "JOSY_SKD" mit O — beide gehen) und Passwort "072018" eingeben ->
 * Admin-Modus statt normalem Konto-Login.
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
 *  - Turnier-Tickets und Survival-Gold verschenken (einmalige Gutschrift).
 *  - Survival-Wartelimit für einen Spieler überspringen: der ausgewählte Spieler
 *    muss nach dem Pleitegehen nicht die Stunde warten, sondern darf sofort einen
 *    neuen Run starten (Zustand, an/aus — siehe js/survival.js isLocked).
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

  // Beide Schreibweisen akzeptieren: mit Null ("J0SY_SKD") UND mit Buchstabe O
  // ("JOSY_SKD"). Josls Konto-/GitHub-Name nutzt das O, daher tippt er das leicht
  // aus Gewohnheit — sonst schlägt der Admin-Login unbemerkt fehl.
  var ADMIN_USERS = ['j0sy_skd', 'josy_skd'];
  var ADMIN_PASS = '072018';
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
      // Grundgerüst
      '.admin-wrap{display:flex;flex-direction:column;gap:18px;}',
      '.admin-head{display:flex;align-items:center;gap:12px;flex-wrap:wrap;}',
      '.admin-head .page-title{margin:0;}',
      '.admin-head-spacer{flex:1 1 auto;}',
      // Statistik-Leiste
      '.admin-stats{display:flex;flex-wrap:wrap;gap:12px;}',
      '.admin-stat{flex:1 1 120px;min-width:108px;padding:14px 16px;display:flex;flex-direction:column;gap:4px;}',
      '.admin-stat-v{font-size:26px;font-weight:900;color:var(--leaf);font-variant-numeric:tabular-nums;line-height:1;}',
      '.admin-stat-l{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;}',
      '.admin-stat.online .admin-stat-v{color:var(--neon);text-shadow:0 0 14px rgba(57,255,20,0.6);}',
      // Werkzeugleiste / Suche
      '.admin-toolbar{display:flex;gap:10px;align-items:center;flex-wrap:wrap;}',
      '.admin-search{flex:1 1 260px;font-size:15px;}',
      '.admin-hint-warn{color:var(--gold);}',
      // Shoutout / Broadcast an alle
      '.admin-broadcast{padding:14px 16px;display:flex;flex-direction:column;gap:8px;}',
      '.admin-broadcast .text-input{flex:1 1 220px;font-size:14px;padding:9px 12px;}',
      // Karten-Gitter
      '.admin-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:16px;align-items:start;}',
      '.admin-card{padding:18px;display:flex;flex-direction:column;gap:14px;}',
      '.admin-card.admin-online{border-color:var(--neon);box-shadow:0 0 22px rgba(57,255,20,0.20),0 10px 30px rgba(0,0,0,0.35);}',
      // Karten-Kopf (klickbar: klappt die Karte auf/zu)
      '.admin-card-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;cursor:pointer;user-select:none;-webkit-user-select:none;padding:4px;margin:-4px;border-radius:12px;transition:background .15s;}',
      '.admin-card-head:hover{background:rgba(57,255,20,0.06);}',
      '.admin-chevron{color:var(--muted);font-size:12px;width:14px;text-align:center;flex:0 0 auto;}',
      '.admin-card-body{display:flex;flex-direction:column;gap:14px;}',
      '.admin-dot{opacity:.4;font-size:12px;}',
      '.admin-dot.online{opacity:1;filter:drop-shadow(0 0 5px rgba(57,255,20,0.85));}',
      '.admin-name{font-weight:800;font-size:16px;color:#eaffe2;overflow:hidden;text-overflow:ellipsis;}',
      '.admin-badges{display:flex;gap:6px 10px;flex-wrap:wrap;align-items:center;margin-left:auto;}',
      '.admin-badge{font-size:13px;font-weight:800;color:var(--leaf);font-variant-numeric:tabular-nums;white-space:nowrap;}',
      '.admin-badge.admin-tix{color:var(--gold);}',
      '.admin-badge.admin-rig-badge{color:var(--aqua-soft);font-weight:700;}',
      // Abschnitte innerhalb einer Karte
      '.admin-section{display:flex;flex-direction:column;gap:7px;}',
      '.admin-section-l{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;}',
      '.admin-rig-row{display:flex;flex-wrap:wrap;gap:6px;}',
      '.admin-rig-btn{font-size:12px;padding:6px 10px;border-radius:11px;}',
      '.admin-rig-btn.active{color:#04160c;background:linear-gradient(180deg,var(--neon-soft),var(--neon));border-color:var(--neon);box-shadow:0 0 12px rgba(57,255,20,0.5);}',
      '.admin-controls{display:flex;flex-wrap:wrap;align-items:center;gap:8px;}',
      '.admin-controls .text-input{flex:1 1 150px;font-size:14px;padding:9px 12px;}',
      '.admin-num{flex:0 0 90px!important;}',
      '.admin-unit{color:var(--muted);font-size:12px;}',
      '.admin-status{font-weight:800;letter-spacing:.5px;color:var(--muted);}',
      '.admin-status.win{color:var(--neon);text-shadow:0 0 10px rgba(57,255,20,0.5);}',
      '.admin-status.lose{color:var(--danger-2);text-shadow:0 0 10px rgba(255,77,109,0.4);}',
      '.admin-divider{height:1px;background:var(--stroke);border:0;margin:0;width:100%;}',
      // Mobil: Karten stapeln, Steuerelemente umbrechen bereits per flex-wrap
      '@media (max-width:560px){.admin-grid{grid-template-columns:1fr;}.admin-head-spacer{display:none;}}'
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
      var u = String(user || '').trim().toLowerCase();
      if (ADMIN_USERS.indexOf(u) >= 0 && String(pass || '') === ADMIN_PASS) {
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
            tickets: acct.tickets || 0,
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
            tickets: p.tickets || 0,
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

    /** Turnier-Tickets verschenken (siehe js/tickets.js). Der Client löst das
     *  Geschenk beim nächsten Heartbeat genau einmal ein — wie eine Nachricht. */
    giftTickets: function (kind, key, n) {
      var patch = kind === 'guest' ? App.Account.adminPatchPresence : App.Account.adminPatch;
      return patch(key, function (rec) {
        rec.admin = rec.admin || {};
        rec.admin.ticketGrant = { id: genId(), n: Math.max(1, Math.round(Number(n) || 1)) };
      });
    },

    /** Survival-Gold verschenken (siehe js/survival.js applyGoldGrant). Der Client
     *  schreibt sich das Gold beim nächsten Heartbeat genau einmal auf seinen
     *  Survival-Stand (Gold) — unabhängig davon, ob er gerade Casino oder Survival
     *  spielt. Wirkt für Konten (adminPatch) wie für Gäste (adminPatchPresence). */
    giftGold: function (kind, key, amount) {
      var patch = kind === 'guest' ? App.Account.adminPatchPresence : App.Account.adminPatch;
      return patch(key, function (rec) {
        rec.admin = rec.admin || {};
        rec.admin.goldGrant = { id: genId(), amount: Math.max(1, Math.round(Number(amount) || 0)) };
      });
    },

    /** Survival-Wartelimit für einen Spieler an/aus (siehe js/survival.js isLocked).
     *  Ist das Flag gesetzt, überspringt der Spieler die Stunden-Sperre nach dem
     *  Pleitegehen und kann sofort neu starten — dauerhaft, bis der Admin es wieder
     *  ausschaltet (kein einmaliges Geschenk, sondern ein Zustand wie das Rigging). */
    setSkipTimer: function (kind, key, on) {
      var patch = kind === 'guest' ? App.Account.adminPatchPresence : App.Account.adminPatch;
      return patch(key, function (rec) { rec.admin = rec.admin || {}; rec.admin.svSkipTimer = !!on; });
    },

    /** Shoutout: dieselbe Nachricht an ALLE Spieler (Konten + Gäste) auf einmal.
     *  Es wird EIN gemeinsames Nachrichten-Objekt erzeugt und jedem Spieler in
     *  rec.admin.msg geschrieben — nutzt exakt die bestehende Pro-Spieler-Mechanik
     *  (account.js/presence.js zeigt admin.msg genau einmal pro id an, daher muss
     *  keine andere Datei geändert werden). Liefert ein Promise mit der Anzahl der
     *  erreichten Spieler. */
    broadcast: function (text) {
      var msg = { id: genId(), text: String(text || '').slice(0, 200), ts: Date.now() };
      return Admin.listPlayers().then(function (rows) {
        return Promise.all(rows.map(function (row) {
          var patch = row.kind === 'guest' ? App.Account.adminPatchPresence : App.Account.adminPatch;
          return patch(row.key, function (rec) { rec.admin = rec.admin || {}; rec.admin.msg = msg; }).catch(function () {});
        })).then(function () { return rows.length; });
      });
    },

    renderPage: function (root) {
      injectCss();
      var refreshTimer = null;
      // Drafts bleiben als Sicherheitsnetz erhalten. Mit persistenten <input>-
      // Knoten (siehe unten) sind sie meist redundant, schaden aber nicht.
      var msgDrafts = {};
      var banDrafts = {};
      var goldDrafts = {};
      var loading = false;

      // Persistente Referenzen auf das Grundgerüst (einmalig gebaut, nie ersetzt).
      var statTotal, statOnline, statAccounts, statGuests;
      var searchInput, warnEl, errEl, gridEl, emptyEl;
      // rowId ('kind:key') -> { el, name, update(row) }. Jede Spieler-Karte wird
      // EINMAL gebaut; beim Refresh nur aktualisiert, damit fokussierte <input>-
      // Felder (Nachricht/Bann-Minuten/Gold/Suche) NICHT zerstört werden und der
      // Admin beim Tippen nicht ständig den Fokus verliert.
      var rowMap = {};
      var filterText = '';

      function sortRows(a, b) {
        // Online zuerst, dann alphabetisch nach Name, dann Key — stabil, damit die
        // Liste bei jedem 4s-Refresh nicht herumspringt.
        if (a.online !== b.online) return a.online ? -1 : 1;
        var an = (a.displayName || '').toLowerCase(), bn = (b.displayName || '').toLowerCase();
        if (an !== bn) return an < bn ? -1 : 1;
        return a.key < b.key ? -1 : (a.key > b.key ? 1 : 0);
      }

      // Fokus-Schutz (Gürtel + Hosenträger): Wenn der Admin gerade in einem <input>
      // oder <textarea> innerhalb des Panels tippt, den Refresh-Zyklus KOMPLETT
      // überspringen — dann ändert sich am DOM nichts und der Cursor/Text bleibt.
      function isTypingInRoot() {
        var a = document.activeElement;
        if (!a) return false;
        var tag = a.tagName;
        if (tag !== 'INPUT' && tag !== 'TEXTAREA') return false;
        return root.contains(a);
      }

      function buildShell() {
        root.innerHTML = '';

        var header = el('div', { class: 'admin-head' }, [
          el('button', { class: 'btn btn-ghost back', type: 'button', onclick: function () {
            App.Router.go('/category/gambling');
          } }, ['← Zurück']),
          el('h2', { class: 'page-title neon' }, ['🛠 Admin Panel']),
          el('div', { class: 'admin-head-spacer' }),
          el('button', { class: 'btn btn-primary', type: 'button', onclick: function () {
            App.Router.go('/admin/tournament');
          } }, ['🏆 Turniere & Sieger']),
          el('button', { class: 'btn btn-ghost', type: 'button', onclick: function () {
            Admin.logout();
            UI.toast('Admin-Modus beendet', 'info');
            App.Router.go('/');
          } }, ['🚪 Admin-Modus verlassen'])
        ]);

        statTotal = el('span', { class: 'admin-stat-v' }, ['–']);
        statOnline = el('span', { class: 'admin-stat-v' }, ['–']);
        statAccounts = el('span', { class: 'admin-stat-v' }, ['–']);
        statGuests = el('span', { class: 'admin-stat-v' }, ['–']);
        var stats = el('div', { class: 'admin-stats' }, [
          el('div', { class: 'glass admin-stat' }, [statTotal, el('span', { class: 'admin-stat-l' }, ['Spieler gesamt'])]),
          el('div', { class: 'glass admin-stat online' }, [statOnline, el('span', { class: 'admin-stat-l' }, ['🟢 Online'])]),
          el('div', { class: 'glass admin-stat' }, [statAccounts, el('span', { class: 'admin-stat-l' }, ['Konten'])]),
          el('div', { class: 'glass admin-stat' }, [statGuests, el('span', { class: 'admin-stat-l' }, ['Gäste'])])
        ]);

        // Live-Filter: auch dieses <input> ist persistent und verliert beim Refresh
        // nicht den Fokus. Tippen filtert sofort (nur Sichtbarkeit, kein Neu-Bau).
        searchInput = el('input', {
          class: 'text-input admin-search', type: 'text',
          placeholder: '🔎 Spieler nach Name filtern …', value: filterText
        });
        searchInput.addEventListener('input', function () {
          filterText = searchInput.value;
          applyFilter();
        });
        var toolbar = el('div', { class: 'admin-toolbar' }, [searchInput]);

        // Shoutout: eine Nachricht an ALLE Spieler auf einmal. Dieses <input> liegt
        // in `root` — der activeElement-Fokus-Schutz greift also auch hier.
        var bcInput = el('input', {
          class: 'text-input', type: 'text', maxlength: 200,
          placeholder: 'Nachricht an alle Spieler …'
        });
        var bcBtn = el('button', { class: 'btn btn-primary', type: 'button', onclick: function () {
          var text = (bcInput.value || '').trim();
          if (!text) return;
          Admin.broadcast(text).then(function (n) {
            UI.toast('📢 An ' + n + ' Spieler gesendet', 'win');
            bcInput.value = '';
          }).catch(function (e) { UI.toast(e.message, 'lose'); });
        } }, ['📢 An alle senden']);
        var broadcastBox = el('div', { class: 'glass admin-broadcast' }, [
          el('span', { class: 'admin-section-l' }, ['📢 Nachricht an alle (Shoutout)']),
          el('div', { class: 'admin-controls' }, [bcInput, bcBtn])
        ]);

        var infoEl = el('p', { class: 'lb-hint' }, [
          'Chancen-Änderung wirkt als Gewinn-Faktor über alle Gambling-Spiele hinweg.'
        ]);
        // Gäste ohne Konto brauchen Zugriff auf den 'presence'-Knoten in Firebase.
        // Ist die Regel (database.rules.json) noch nicht veröffentlicht, nur Konten.
        warnEl = el('p', { class: 'lb-hint admin-hint-warn' }, [
          '⚠️ Gäste ohne Konto können gerade nicht geladen werden '
          + '(Firebase-Regel für „presence" noch nicht veröffentlicht). '
          + 'Konten werden trotzdem angezeigt.'
        ]);
        warnEl.hidden = true;
        errEl = el('p', { class: 'lb-hint admin-hint-warn' }, [
          'Spieler konnten nicht geladen werden. Neuer Versuch in wenigen Sekunden …'
        ]);
        errEl.hidden = true;

        gridEl = el('div', { class: 'admin-grid' });
        emptyEl = el('p', { class: 'lb-empty' }, ['Lade Spieler …']);

        root.appendChild(el('div', { class: 'admin-wrap' }, [
          header, stats, toolbar, broadcastBox, infoEl, warnEl, errEl, gridEl, emptyEl
        ]));
      }

      // Baut EINE Spieler-Karte samt aller Steuerelemente genau einmal. Gibt ein
      // Objekt mit .el (die Karte), .name (aktueller Anzeigename für den Filter)
      // und .update(row) zurück. update() ändert NUR dynamische Teile (Punkt,
      // Zahlen, aktive Rig-Buttons, Bann-Status) und fasst die <input>-Knoten
      // (Nachricht/Bann-Minuten/Gold) NIE an — so bleibt der Fokus erhalten.
      function buildCard(row) {
        var key = row.key, kind = row.kind, rowId = kind + ':' + key;
        var current = row; // stets die zuletzt bekannten Daten (für Toasts etc.)

        // --- Kopf (Zusammenfassung, immer sichtbar; Klick klappt Karte auf/zu) ---
        var chevron = el('span', { class: 'admin-chevron' }, ['▸']);
        var dot = el('span', { class: 'admin-dot' }, ['⚪']);
        var nameEl = el('span', { class: 'admin-name' }, [row.displayName]);
        var balEl = el('span', { class: 'admin-badge' }, ['0 🪙']);
        var tixEl = el('span', { class: 'admin-badge admin-tix' }, ['0 🎟️']);
        var rigBadge = el('span', { class: 'admin-badge admin-rig-badge' }, ['']);
        var head = el('div', { class: 'admin-card-head' }, [
          chevron, dot, nameEl, el('span', { class: 'admin-badges' }, [balEl, tixEl, rigBadge])
        ]);

        // --- Chancen (Rigging) ---
        var rigHeadEl = el('span', { class: 'admin-section-l' }, ['']);
        var rigBtns = RIG_LEVELS.map(function (r) {
          return el('button', {
            class: 'btn btn-ghost admin-rig-btn', type: 'button', title: r.hint,
            onclick: function () {
              Admin.setRig(kind, key, r.level).then(function () {
                UI.toast('Chancen für ' + current.displayName + ': ' + r.label, r.level < 0 ? 'lose' : 'win');
                refresh();
              }).catch(function (e) { UI.toast(e.message, 'lose'); });
            }
          }, [r.label]);
        });
        var rigSection = el('div', { class: 'admin-section' }, [
          rigHeadEl, el('div', { class: 'admin-rig-row' }, rigBtns)
        ]);

        // --- Sperre: zwei Zustände, per hidden umgeschaltet, Minuten-Input bleibt. ---
        var banUntilEl = el('span', { class: 'admin-status lose' }, ['']);
        var unbanBtn = el('button', { class: 'btn btn-ghost admin-rig-btn', type: 'button', onclick: function () {
          Admin.unban(kind, key).then(function () { UI.toast('Entsperrt', 'win'); refresh(); }).catch(function (e) { UI.toast(e.message, 'lose'); });
        } }, ['🔓 Entsperren']);
        var banActive = el('div', { class: 'admin-controls' }, [banUntilEl, unbanBtn]);

        var banInput = el('input', {
          class: 'text-input admin-num', type: 'number', min: 1,
          value: banDrafts[rowId] || 15
        });
        banInput.addEventListener('input', function () { banDrafts[rowId] = banInput.value; });
        var banBtn = el('button', { class: 'btn btn-ghost admin-rig-btn', type: 'button', onclick: function () {
          var mins = Math.max(1, Math.round(Number(banInput.value) || 15));
          Admin.ban(kind, key, mins).then(function () {
            UI.toast('Gesperrt für ' + mins + ' Min.', 'lose');
            refresh();
          }).catch(function (e) { UI.toast(e.message, 'lose'); });
        } }, ['🚫 Bannen']);
        var banForm = el('div', { class: 'admin-controls' }, [
          banInput, el('span', { class: 'admin-unit' }, ['Min.']), banBtn
        ]);
        var banSection = el('div', { class: 'admin-section' }, [
          el('span', { class: 'admin-section-l' }, ['🚫 Sperre']), banActive, banForm
        ]);

        // --- Nachricht ---
        var msgInput = el('input', {
          class: 'text-input', type: 'text', maxlength: 200,
          placeholder: 'Admin-Nachricht an ' + row.displayName + ' …',
          value: msgDrafts[rowId] || ''
        });
        msgInput.addEventListener('input', function () { msgDrafts[rowId] = msgInput.value; });
        var msgBtn = el('button', { class: 'btn btn-primary admin-rig-btn', type: 'button', onclick: function () {
          var text = (msgInput.value || '').trim();
          if (!text) return;
          Admin.sendMessage(kind, key, text).then(function () {
            UI.toast('Nachricht gesendet an ' + current.displayName, 'win');
            msgInput.value = ''; msgDrafts[rowId] = '';
          }).catch(function (e) { UI.toast(e.message, 'lose'); });
        } }, ['📨 Senden']);
        var msgSection = el('div', { class: 'admin-section' }, [
          el('span', { class: 'admin-section-l' }, ['✉️ Nachricht']),
          el('div', { class: 'admin-controls' }, [msgInput, msgBtn])
        ]);

        // --- Turnier-Tickets schenken ---
        function giftTickets(n) {
          Admin.giftTickets(kind, key, n).then(function () {
            UI.toast(n + ' 🎟️ an ' + current.displayName + ' geschenkt (kommt beim nächsten Heartbeat an).', 'win');
          }).catch(function (e) { UI.toast(e.message, 'lose'); });
        }
        function mkTixBtn(n) {
          return el('button', { class: 'btn btn-ghost admin-rig-btn', type: 'button', onclick: function () { giftTickets(n); } }, ['🎟️ +' + n]);
        }
        var tixSection = el('div', { class: 'admin-section' }, [
          el('span', { class: 'admin-section-l' }, ['🎟️ Turnier-Tickets schenken']),
          el('div', { class: 'admin-controls' }, [mkTixBtn(1), mkTixBtn(3), mkTixBtn(10)])
        ]);

        // --- Survival-Gold schenken ---
        function giftGold(amount) {
          amount = Math.max(1, Math.round(Number(amount) || 0));
          Admin.giftGold(kind, key, amount).then(function () {
            UI.toast(UI.formatCoins(amount) + ' 🥇 Survival-Gold an ' + current.displayName + ' geschenkt (kommt beim nächsten Heartbeat an).', 'win');
          }).catch(function (e) { UI.toast(e.message, 'lose'); });
        }
        var goldInput = el('input', {
          class: 'text-input admin-num', type: 'number', min: 1, step: 100,
          value: goldDrafts[rowId] || 1000
        });
        goldInput.addEventListener('input', function () { goldDrafts[rowId] = goldInput.value; });
        var goldSection = el('div', { class: 'admin-section' }, [
          el('span', { class: 'admin-section-l' }, ['🥇 Survival-Gold schenken']),
          el('div', { class: 'admin-controls' }, [
            goldInput,
            el('button', { class: 'btn btn-primary admin-rig-btn', type: 'button', onclick: function () { giftGold(goldInput.value); } }, ['🥇 Senden']),
            el('button', { class: 'btn btn-ghost admin-rig-btn', type: 'button', onclick: function () { goldInput.value = 1000; goldDrafts[rowId] = 1000; giftGold(1000); } }, ['+1.000']),
            el('button', { class: 'btn btn-ghost admin-rig-btn', type: 'button', onclick: function () { goldInput.value = 10000; goldDrafts[rowId] = 10000; giftGold(10000); } }, ['+10.000'])
          ])
        ]);

        // --- Survival-Wartelimit überspringen (Zustand) ---
        var skipStatusEl = el('span', { class: 'admin-status' }, ['']);
        var skipBtn = el('button', { class: 'btn admin-rig-btn', type: 'button', onclick: function () {
          var skipOn = !!(current.admin && current.admin.svSkipTimer);
          Admin.setSkipTimer(kind, key, !skipOn).then(function () {
            UI.toast(current.displayName + (skipOn ? ': Survival-Wartelimit wieder aktiv.' : ' muss im Survival nicht mehr warten.'), skipOn ? 'lose' : 'win');
            refresh();
          }).catch(function (e) { UI.toast(e.message, 'lose'); });
        } }, ['']);
        var skipSection = el('div', { class: 'admin-section' }, [
          el('span', { class: 'admin-section-l' }, ['⏱️ Survival-Wartelimit']),
          el('div', { class: 'admin-controls' }, [skipStatusEl, skipBtn])
        ]);

        // Der Karten-KÖRPER (alle Steuerelemente) ist standardmäßig eingeklappt
        // und wird nur beim Aufklappen gezeigt. Wichtig: er ist ein persistenter
        // DOM-Knoten — der Auf/Zu-Zustand überlebt den 4s-Refresh von allein, weil
        // update() ihn NIE anfasst.
        var body = el('div', { class: 'admin-card-body' }, [
          rigSection,
          el('hr', { class: 'admin-divider' }),
          banSection,
          msgSection,
          el('hr', { class: 'admin-divider' }),
          tixSection,
          goldSection,
          skipSection
        ]);
        body.hidden = true; // eingeklappt starten

        var card = el('div', { class: 'glass admin-card' }, [head, body]);

        // Nur der KOPF klappt um. Steuerelemente liegen im (separaten) Körper, nicht
        // im Kopf — ihre Klicks erreichen diesen Handler also gar nicht erst.
        var expanded = false;
        head.addEventListener('click', function () {
          expanded = !expanded;
          body.hidden = !expanded;
          chevron.textContent = expanded ? '▾' : '▸';
        });

        var api = {
          el: card,
          name: row.displayName,
          update: function (r) {
            current = r;
            api.name = r.displayName;
            var admin = r.admin || {};
            var now = Date.now();
            var online = !!(r.lastSeen && (now - r.lastSeen) < ONLINE_MS);

            dot.textContent = online ? '🟢' : '⚪';
            dot.classList.toggle('online', online);
            card.classList.toggle('admin-online', online);
            nameEl.textContent = r.displayName;
            balEl.textContent = UI.formatCoins(r.balance || 0) + ' 🪙';
            tixEl.textContent = (r.tickets || 0) + ' 🎟️';

            var rig = admin.rig || 0;
            rigHeadEl.textContent = '🎲 Chancen — aktuell: ' + rigLabelFor(rig);
            rigBadge.textContent = rigLabelFor(rig); // Zusammenfassung im Kopf (auch eingeklappt)
            rigBtns.forEach(function (b, i) { b.classList.toggle('active', RIG_LEVELS[i].level === rig); });

            var banned = admin.banUntil && admin.banUntil > now;
            if (banned) {
              banUntilEl.textContent = '🚫 Gesperrt bis ' + new Date(admin.banUntil).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
              banActive.hidden = false;
              banForm.hidden = true;
            } else {
              banActive.hidden = true;
              banForm.hidden = false;
            }

            var skipOn = !!admin.svSkipTimer;
            skipStatusEl.textContent = skipOn ? 'übersprungen ✔' : '1 Stunde nach Pleite';
            skipStatusEl.classList.toggle('win', skipOn);
            skipBtn.textContent = skipOn ? 'Wieder einschalten' : '⏭️ Timer überspringen';
            skipBtn.className = 'btn admin-rig-btn' + (skipOn ? ' btn-ghost' : ' btn-primary');

            // Placeholder aktualisieren ist fokus-sicher (blurrt nicht).
            msgInput.placeholder = 'Admin-Nachricht an ' + r.displayName + ' …';
          }
        };
        return api;
      }

      // Nur Sichtbarkeit nach Suchtext umschalten — reorder/refetch NICHT nötig,
      // daher fokus-sicher auch während in der Suche getippt wird.
      function applyFilter() {
        var q = (filterText || '').trim().toLowerCase();
        var ids = Object.keys(rowMap);
        var visible = 0;
        ids.forEach(function (rowId) {
          var entry = rowMap[rowId];
          var match = !q || (entry.name || '').toLowerCase().indexOf(q) >= 0;
          entry.el.hidden = !match;
          if (match) visible++;
        });
        if (!ids.length) {
          emptyEl.textContent = 'Noch keine Spieler vorhanden.';
          emptyEl.hidden = false;
        } else if (visible === 0) {
          emptyEl.textContent = 'Kein Spieler passt zum Filter „' + filterText + '".';
          emptyEl.hidden = false;
        } else {
          emptyEl.hidden = true;
        }
      }

      // Abgleich (Reconcile): neue Spieler anlegen, verschwundene entfernen,
      // vorhandene aktualisieren und in Sortier-Reihenfolge bringen. Wird NUR
      // aufgerufen, wenn nicht getippt wird (Fokus-Schutz in refresh()).
      function reconcile(rows) {
        var now = Date.now();
        rows.forEach(function (row) { row.online = !!(row.lastSeen && (now - row.lastSeen) < ONLINE_MS); });
        rows.sort(sortRows);

        var total = rows.length, onlineCount = 0, accountCount = 0;
        rows.forEach(function (r) {
          if (r.online) onlineCount++;
          if (r.kind === 'account') accountCount++;
        });
        statTotal.textContent = total;
        statOnline.textContent = onlineCount;
        statAccounts.textContent = accountCount;
        statGuests.textContent = total - accountCount;
        warnEl.hidden = !rows.presenceFailed;

        var seen = {};
        rows.forEach(function (row) {
          var rowId = row.kind + ':' + row.key;
          seen[rowId] = true;
          var entry = rowMap[rowId];
          if (!entry) { entry = buildCard(row); rowMap[rowId] = entry; }
          entry.update(row);
          // In Sortier-Position schieben: appendChild verschiebt bestehende Knoten
          // ans Ende — in sortierter Reihenfolge iteriert ergibt das die Ordnung.
          gridEl.appendChild(entry.el);
        });
        Object.keys(rowMap).forEach(function (rowId) {
          if (seen[rowId]) return;
          var entry = rowMap[rowId];
          if (entry.el.parentNode) entry.el.parentNode.removeChild(entry.el);
          delete rowMap[rowId];
          delete msgDrafts[rowId];
          delete banDrafts[rowId];
          delete goldDrafts[rowId];
        });

        applyFilter();
      }

      function refresh() {
        if (loading) return;
        // Fokus-Schutz: während der Admin in einem Panel-Feld tippt, gar nichts tun.
        if (isTypingInRoot()) return;
        loading = true;
        Admin.listPlayers().then(function (rows) {
          loading = false;
          errEl.hidden = true;
          reconcile(rows || []);
        }).catch(function () {
          // listPlayers() fängt Teil-Fehler inzwischen selbst ab und wirft praktisch
          // nie mehr. Falls doch (kein Backend): NICHT das Grundgerüst leerräumen —
          // sonst verschwindet auch Zurück/Verlassen und der Admin sitzt fest. Nur
          // die dezente Fehlerzeile einblenden.
          loading = false;
          errEl.hidden = false;
        });
      }

      buildShell();
      refresh();
      refreshTimer = setInterval(refresh, 4000);

      return {
        cleanup: function () { if (refreshTimer) clearInterval(refreshTimer); }
      };
    }
  };

  App.Admin = Admin;
})();
