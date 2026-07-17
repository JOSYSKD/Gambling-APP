/* account.js — Konten mit Passwort, geräteübergreifend nutzbar.
 *
 * Backend-Wahl (automatisch, wie bei net.js):
 *   - Firebase Realtime Database, WENN js/firebase-config.js echte Werte enthält
 *     -> Konten/Spielstand/Bestenliste sind dann für ALLE Besucher der Seite geteilt
 *        und funktionieren geräteübergreifend (jeder Browser, überall).
 *   - Sonst: Fallback auf einen lokalen Simulator (localStorage) -> Konten
 *     funktionieren dann genauso (Registrieren/Login/Passwort/Sitzungssperre),
 *     aber nur innerhalb DIESES Browsers. Sobald Firebase eingerichtet ist,
 *     übernimmt automatisch das geteilte Backend, ohne Codeänderung.
 *
 * Sicherheits-Hinweis: Passwörter werden nur gehasht (SHA-256 + Salt) abgelegt,
 * NICHT im Klartext. Da es sich um eine offene Klassen-/Freundeskreis-Seite ohne
 * eigenen Server handelt, ist das ein Casual-Schutz (verhindert versehentliches
 * Klartext-Mitlesen), keine Bank-Sicherheit — bitte kein "echtes" Passwort wiederverwenden.
 */
(function () {
  'use strict';
  window.App = window.App || {};

  var KEY_SESSION = 'gj_session';
  var KEY_LOCAL_ACCOUNTS = 'gj_accounts_local';
  var KEY_LOCAL_PRESENCE = 'gj_presence_local';
  var KEY_LOCAL_LB = 'gj_lb_store_local';
  var KEY_MIGRATED = 'gj_migrated_lb_v1';

  var HEARTBEAT_MS = 8000;
  var SESSION_STALE_MS = 20000; // Sitzung eines anderen Geräts gilt danach als "weg"

  /* ---------- Helfer ---------- */
  function sanitizeKey(name) {
    return String(name || '').toLowerCase().trim().replace(/[^a-z0-9_-]/g, '').slice(0, 24);
  }
  function randHex(n) {
    var bytes = new Uint8Array(n);
    if (window.crypto && crypto.getRandomValues) crypto.getRandomValues(bytes);
    else for (var i = 0; i < n; i++) bytes[i] = Math.floor(Math.random() * 256);
    return Array.prototype.map.call(bytes, function (b) { return b.toString(16).padStart(2, '0'); }).join('');
  }
  function fallbackHash(str) {
    // Nur falls crypto.subtle fehlt (z. B. file://). Kein starker Hash, reiner Notbehelf.
    var h = 0x811c9dc5;
    for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return 'fnv1a:' + (h >>> 0).toString(16);
  }
  function hashPassword(pw, salt) {
    var str = salt + ':' + pw;
    if (window.crypto && crypto.subtle && crypto.subtle.digest) {
      return crypto.subtle.digest('SHA-256', new TextEncoder().encode(str)).then(function (buf) {
        return 'sha256:' + Array.prototype.map.call(new Uint8Array(buf), function (b) { return b.toString(16).padStart(2, '0'); }).join('');
      }).catch(function () { return fallbackHash(str); });
    }
    return Promise.resolve(fallbackHash(str));
  }

  /* Präsenz-Datensätze -> Spielerliste für die Bestenliste.
   * Jeder Tab meldet sich alle 8s unter presence/<geräte-id> (js/presence.js),
   * auch Gäste ohne Konto. Dadurch steht wirklich JEDER Spieler auf der Liste
   * und nicht nur, wer mal Game Over hatte. 'Gast' = hat noch keinen Namen
   * gewählt und würde sonst alle Namenlosen zu einer Zeile verschmelzen. */
  function presenceToPlayers(val) {
    val = val || {};
    return Object.keys(val).map(function (k) {
      var p = val[k] || {};
      return {
        name: p.name, peak: Number(p.casinoPeak) || 0, streak: Number(p.streak) || 0,
        updatedAt: Number(p.lastSeen) || 0, maxLevel: !!p.maxLevel,
        // Profil-Daten für die Bestenliste (Profilkarte + gespielte Spiele, siehe presence.js).
        cos: p.cos || null, level: Number(p.level) || 1, bulbs: Number(p.bulbs) || 0,
        games: (p.games && p.games.slice) ? p.games : [], stats: p.pstats || null
      };
    }).filter(function (p) { return p.name && p.name !== 'Gast'; });
  }

  /* Nur echte Run-Einträge; im Firebase-Knoten 'leaderboard' können auch
   * Fremdschlüssel liegen, die keine Einträge sind. */
  function validEntries(val) {
    val = val || {};
    return Object.keys(val).map(function (k) { return val[k]; })
      .filter(function (e) { return e && typeof e === 'object' && typeof e.peak === 'number'; });
  }

  /* ---------- Backends ---------- */
  function localBackend() {
    function readAll() { return App.Storage.get(KEY_LOCAL_ACCOUNTS, {}); }
    function writeAll(o) { App.Storage.set(KEY_LOCAL_ACCOUNTS, o); }
    function readAllPresence() { return App.Storage.get(KEY_LOCAL_PRESENCE, {}); }
    function writeAllPresence(o) { App.Storage.set(KEY_LOCAL_PRESENCE, o); }
    return {
      kind: 'local',
      getAccount: function (key) { return Promise.resolve(readAll()[key] || null); },
      setAccount: function (key, data) { var all = readAll(); all[key] = data; writeAll(all); return Promise.resolve(); },
      listAll: function () { return Promise.resolve(readAll()); },
      getPresence: function (key) { return Promise.resolve(readAllPresence()[key] || null); },
      setPresence: function (key, data) { var all = readAllPresence(); all[key] = data; writeAllPresence(all); return Promise.resolve(); },
      listPresence: function () { return Promise.resolve(readAllPresence()); },
      removeAccount: function (key) { var all = readAll(); delete all[key]; writeAll(all); return Promise.resolve(); },
      removePresence: function (key) { var all = readAllPresence(); delete all[key]; writeAllPresence(all); return Promise.resolve(); },
      leaderboardDriver: function () {
        return {
          load: function () { return App.Storage.get(KEY_LOCAL_LB, []); },
          push: function (entry) {
            var list = App.Storage.get(KEY_LOCAL_LB, []);
            list.push(entry);
            if (list.length > 300) list = list.slice(list.length - 300);
            App.Storage.set(KEY_LOCAL_LB, list);
            App.Leaderboard.refresh();
          },
          save: function (entries) { App.Storage.set(KEY_LOCAL_LB, entries || []); App.Leaderboard.refresh(); },
          players: function () { return presenceToPlayers(readAllPresence()); }
        };
      }
    };
  }

  function firebaseBackend(db) {
    return {
      kind: 'firebase',
      getAccount: function (key) { return db.ref('accounts/' + key).get().then(function (s) { return s.val(); }); },
      setAccount: function (key, data) { return db.ref('accounts/' + key).set(data); },
      listAll: function () { return db.ref('accounts').get().then(function (s) { return s.val() || {}; }); },
      getPresence: function (key) { return db.ref('presence/' + key).get().then(function (s) { return s.val(); }); },
      setPresence: function (key, data) { return db.ref('presence/' + key).set(data); },
      listPresence: function () { return db.ref('presence').get().then(function (s) { return s.val() || {}; }); },
      removeAccount: function (key) { return db.ref('accounts/' + key).remove(); },
      removePresence: function (key) { return db.ref('presence/' + key).remove(); },
      leaderboardDriver: function () {
        var cache = [], pCache = [];
        var ref = db.ref('leaderboard');
        ref.limitToLast(500).on('value', function (snap) {
          cache = validEntries(snap.val());
          App.Leaderboard.refresh();
        });
        // Live: sobald irgendwer die Seite öffnet, steht er auf der Bestenliste.
        db.ref('presence').on('value', function (snap) {
          pCache = presenceToPlayers(snap.val());
          App.Leaderboard.refresh();
        }, function () { /* Knoten gesperrt -> Liste bleibt bei der Run-Historie */ });
        return {
          load: function () { return cache; },
          push: function (entry) { ref.push(entry); },
          save: function (entries) { ref.set(entries && entries.length ? entries : null); },
          players: function () { return pCache; }
        };
      }
    };
  }

  // Keyloser Fallback ohne Google-/Firebase-Konto, siehe js/cloud.js + js/cloud-config.js.
  function cloudBackend() {
    App.Cloud.startPolling(10000);
    var lbCache = [], pCache = [];
    function syncLbCache(state) {
      lbCache = (state && state.leaderboard) || [];
      pCache = presenceToPlayers(state && state.presence);
      App.Leaderboard.refresh();
    }
    App.Cloud.onChange(syncLbCache);
    App.Cloud.load().then(syncLbCache).catch(function () {});

    return {
      kind: 'cloud',
      getAccount: function (key) {
        return App.Cloud.load(true).then(function (state) { return (state.accounts || {})[key] || null; });
      },
      setAccount: function (key, data) {
        return App.Cloud.mutate(function (state) {
          state.accounts = state.accounts || {};
          state.accounts[key] = data;
        });
      },
      listAll: function () {
        return App.Cloud.load(true).then(function (state) { return state.accounts || {}; });
      },
      getPresence: function (key) {
        return App.Cloud.load(true).then(function (state) { return (state.presence || {})[key] || null; });
      },
      setPresence: function (key, data) {
        return App.Cloud.mutate(function (state) {
          state.presence = state.presence || {};
          state.presence[key] = data;
        });
      },
      listPresence: function () {
        return App.Cloud.load(true).then(function (state) { return state.presence || {}; });
      },
      leaderboardDriver: function () {
        return {
          load: function () { return lbCache; },
          push: function (entry) {
            return App.Cloud.mutate(function (state) {
              state.leaderboard = state.leaderboard || [];
              state.leaderboard.push(entry);
              if (state.leaderboard.length > 300) state.leaderboard = state.leaderboard.slice(state.leaderboard.length - 300);
            }).then(syncLbCache).catch(function () {});
          },
          save: function (entries) {
            return App.Cloud.mutate(function (state) { state.leaderboard = entries || []; }).then(syncLbCache).catch(function () {});
          },
          players: function () { return pCache; }
        };
      }
    };
  }

  function cloudOrLocal() {
    if (App.Cloud && App.Cloud.configured()) {
      return App.Cloud.load().then(function () { return cloudBackend(); }).catch(function () { return localBackend(); });
    }
    return Promise.resolve(localBackend());
  }

  function initBackend() {
    if (App.Net.firebaseConfigured()) {
      return App.Net.firebaseDb().then(firebaseBackend).catch(function () { return cloudOrLocal(); });
    }
    return cloudOrLocal();
  }

  /* ---------- Zustand ---------- */
  var state = { backend: null, key: null, account: null, token: null, ready: false, hbTimer: null, syncTimer: null };
  var listeners = [];
  function emit() { listeners.forEach(function (cb) { try { cb(); } catch (e) {} }); }

  function migrateOldLeaderboardOnce(lbDriver) {
    if (App.Storage.get(KEY_MIGRATED, false)) return;
    App.Storage.set(KEY_MIGRATED, true);
    var old = App.Storage.get('gj_leaderboard', []);
    if (old && old.length && lbDriver.push) {
      old.forEach(function (e) { lbDriver.push({ name: e.name, peak: e.peak, date: e.date, active: false }); });
    }
  }

  /* Das Konto trägt BEIDE Spielstände: den Casino-Stand (Silber) und den
   * Survival-Stand (Gold) unter acct.sv. Deshalb wird hier gezielt in den
   * jeweiligen Modus geschrieben (App.Mode.writeIn) statt in den gerade
   * aktiven — sonst landete beim Anmelden während eines Survival-Runs das
   * Casino-Guthaben im Gold-Stand. */
  function applyAccountToLocalState(acct) {
    var M = App.Mode;
    // Globaler Geld-Reset (siehe coins.js balanceResetOnce): Bringt das Konto
    // noch einen alten Generationsstempel mit, wird das Casino-Guthaben auf das
    // (kleine) Einstiegsguthaben gesetzt, statt den alten hohen Kontostand zu
    // übernehmen. So greift der Reset auch für eingeloggte Spieler zuverlässig
    // (der neue Stand wandert beim nächsten Snapshot ins Konto). Level bleiben.
    var GEN = (App.Coins && App.Coins.BAL_RESET_GEN) || 0;
    if ((Number(acct.balResetGen) || 0) < GEN) {
      var start = (App.Progress && App.Progress.startBalanceForProgress)
        ? App.Progress.startBalanceForProgress(acct.progress) : (App.Coins ? App.Coins.START : 1000);
      start = Math.max(0, Math.round(Number(start) || 0));
      acct.balance = start; acct.runPeak = start; acct.bank = 0;
      acct.balResetGen = GEN;
      App.Storage.set('gj_bal_reset_gen', GEN);
    }
    // Ergänzung zum Geld-Reset: Depot, Survival-Stand, Level/Quests und Alt-Chips
    // eines noch nicht zurückgesetzten Kontos nullen (siehe js/hardreset.js).
    if (App.HardReset && App.HardReset.accountNeedsReset(acct)) acct = App.HardReset.cleanAccount(acct);
    if (typeof acct.balance === 'number') M.writeIn('casino', 'gj_balance', acct.balance);
    if (typeof acct.runPeak === 'number') M.writeIn('casino', 'gj_run_peak', Math.max(acct.runPeak, acct.balance || 0));
    // Alt-Pokerchips ins Guthaben falten (Chips wurden abgeschafft, siehe js/chips.js):
    // ein Chip = 100.000 Coins. Der neue Bank-Stand liegt in acct.bank.
    if (typeof acct.chips === 'number' && acct.chips > 0) {
      var base = (typeof acct.balance === 'number') ? acct.balance : 0;
      M.writeIn('casino', 'gj_balance', base + acct.chips * 100000);
      M.writeIn('casino', 'gj_chips', 0);
    }
    if (typeof acct.bank === 'number') M.writeIn('casino', 'gj_bank', acct.bank);
    // Casino-Fortschritt (Level, XP, Quests/Erfolge) ans Konto binden -> der
    // level-abhängige Wieder-Auffüll-Betrag (startBalance) wandert geräte-
    // übergreifend mit. Survival-Fortschritt liegt separat in acct.sv.progress.
    if (acct.progress) M.writeIn('casino', 'gj_progress', acct.progress);

    var sv = acct.sv;
    if (sv && typeof sv === 'object') {
      if (typeof sv.balance === 'number') M.writeIn('survival', 'gj_balance', sv.balance);
      if (typeof sv.runPeak === 'number') M.writeIn('survival', 'gj_run_peak', sv.runPeak);
      if (typeof sv.chips === 'number') M.writeIn('survival', 'gj_chips', sv.chips);
      if (sv.progress) M.writeIn('survival', 'gj_progress', sv.progress);
      if (sv.stocks) M.writeIn('survival', 'gj_stocks', sv.stocks);
      // Run-Zustand & Sperre sind modus-unabhängig -> normaler Storage.
      if (typeof sv.nextTry === 'number') App.Storage.set('gj_sv_next_try', sv.nextTry);
      if (typeof sv.runActive === 'boolean') App.Storage.set('gj_sv_run', sv.runActive);
      if (typeof sv.peakEver === 'number') App.Storage.set('gj_sv_peak_ever', sv.peakEver);
    }
    // Ideen-Glühbirnen des KONTOS übernehmen (nicht mit dem lokalen Stand mischen —
    // sonst erbte ein Spieler die Glühbirnen des Vorgängers auf demselben Gerät).
    if (typeof acct.ideaWins === 'number') App.Storage.set('gj_idea_wins', acct.ideaWins);

    M.refresh();     // Coins/Chips/Progress/Depot des AKTIVEN Modus neu laden
    if (acct.playerName) App.Leaderboard.setPlayerName(acct.playerName);
  }

  /** Aktuellen Stand beider Modi ins Konto-Objekt schreiben. Liest bewusst aus dem
   *  Storage statt aus App.Coins, damit auch der gerade inaktive Modus mitkommt. */
  function snapshotToAccount(acct) {
    var M = App.Mode;
    acct.balance = M.readIn('casino', 'gj_balance', App.Coins.START);
    acct.runPeak = M.readIn('casino', 'gj_run_peak', acct.balance);
    acct.chips = 0;   // Chips abgeschafft -> beim Restore ins Guthaben gefaltet
    acct.bank = M.readIn('casino', 'gj_bank', 0);   // Bank-Einlage (Casino-Silber)
    acct.balResetGen = Number(App.Storage.get('gj_bal_reset_gen', 0)) || 0;   // Geld-Reset-Generation
    acct.progress = M.readIn('casino', 'gj_progress', null);   // Level/XP/Quests/Erfolge (Casino)
    acct.sv = {
      balance: M.readIn('survival', 'gj_balance', 0),
      runPeak: M.readIn('survival', 'gj_run_peak', 0),
      chips: M.readIn('survival', 'gj_chips', 0),
      progress: M.readIn('survival', 'gj_progress', null),
      stocks: M.readIn('survival', 'gj_stocks', null),
      nextTry: App.Storage.get('gj_sv_next_try', 0),
      runActive: App.Storage.get('gj_sv_run', false),
      peakEver: App.Storage.get('gj_sv_peak_ever', 0)
    };
    acct.playerName = App.Leaderboard.getPlayerName();
    // Höchstlevel-Flag mitschicken -> goldener Name in Bestenliste/Admin (siehe progress.js).
    acct.maxLevel = !!(App.Progress && App.Progress.isMaxLevel && App.Progress.isMaxLevel());
    // Turnier-Tickets gelten für beide Modi gemeinsam (siehe js/tickets.js) und
    // liegen daher außerhalb von acct.sv.
    acct.tickets = App.Tickets ? App.Tickets.get() : 0;
    // Erfolgreiche Spielideen (goldene Glühbirnen, siehe js/ideas.js): einmal verdient,
    // für immer behalten — also ans Konto binden statt nur ans Gerät.
    acct.ideaWins = App.Storage.get('gj_idea_wins', 0) || 0;
    // Hard-Reset-Zusatz-Stempel mitschreiben -> Depot/Survival/Level eines Kontos
    // werden nicht erneut gekappt (siehe js/hardreset.js).
    if (App.HardReset) acct.hardGen = App.HardReset.GEN;
    return acct;
  }

  // Antwort des Spielers auf eine Admin-Nachricht in sein eigenes Konto schreiben
  // (Feld `replies`). Der Admin liest das im Postfach (siehe js/admin.js). Der
  // Heartbeat bewahrt `replies`, weil snapshotToAccount die frische acct-Kopie
  // nur ergänzt und replies nie überschreibt.
  function pushAccountReply(text, msg) {
    text = String(text || '').trim().slice(0, 300);
    if (!text || !state.key || !state.backend) return Promise.resolve(false);
    return state.backend.getAccount(state.key).then(function (acct) {
      if (!acct) return false;
      acct.replies = (acct.replies || []).concat([{
        id: 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        text: text, ts: Date.now(),
        name: acct.displayName || state.key,
        to: (msg && msg.id) || null, msgText: (msg && msg.text) || ''
      }]);
      if (acct.replies.length > 40) acct.replies = acct.replies.slice(acct.replies.length - 40);
      state.account = acct;
      return state.backend.setAccount(state.key, acct).then(function () { return true; });
    }).catch(function () { return false; });
  }

  // Admin-Nachrichten (siehe js/admin.js): einmalig je Nachrichten-ID als Modal zeigen.
  var KEY_ADMIN_MSG_SEEN = 'gj_admin_msg_seen';
  function checkAdminMessage(acct) {
    var msg = acct.admin && acct.admin.msg;
    if (!msg || !msg.id) return;
    if (App.Storage.get(KEY_ADMIN_MSG_SEEN, null) === msg.id) return;
    App.Storage.set(KEY_ADMIN_MSG_SEEN, msg.id);
    if (!App.UI || !App.UI.el) return;
    showAdminMessageModal(msg, pushAccountReply);
  }

  // Gemeinsames Nachricht-Modal mit Antwort-Feld (auch von js/presence.js genutzt).
  // sendReply(text, msg) -> Promise<bool>.
  function showAdminMessageModal(msg, sendReply) {
    var elx = App.UI.el;
    var input = elx('textarea', { class: 'text-input', rows: 2, placeholder: 'Antwort an den Admin schreiben …', style: 'resize:vertical;min-height:44px;' });
    var status = elx('div', { class: 'lb-hint', style: 'margin:0;min-height:16px;' }, ['']);
    var sendBtn, closeBtn;
    var overlay = elx('div', { class: 'modal-overlay' }, [
      elx('div', { class: 'modal glass' }, [
        elx('div', { class: 'modal-leaf' }, ['📢']),
        elx('h2', { class: 'neon' }, ['Nachricht vom Admin']),
        elx('p', {}, [msg.text]),
        input, status,
        elx('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;justify-content:center;' }, [
          (sendBtn = elx('button', { class: 'btn btn-primary', type: 'button', onclick: function () {
            var t = (input.value || '').trim();
            if (!t) { status.textContent = 'Bitte etwas schreiben.'; return; }
            sendBtn.disabled = true; status.textContent = 'Wird gesendet …';
            sendReply(t, msg).then(function (ok) {
              status.textContent = ok ? '✅ Antwort gesendet — der Admin sieht sie im Postfach.' : '⚠️ Konnte nicht senden.';
              if (ok) { input.disabled = true; sendBtn.style.display = 'none'; closeBtn.textContent = 'Schließen'; }
              else sendBtn.disabled = false;
            });
          } }, ['✉️ Antworten'])),
          (closeBtn = elx('button', { class: 'btn btn-ghost', type: 'button', onclick: function () {
            if (overlay.parentNode) document.body.removeChild(overlay);
          } }, ['Verstanden']))
        ])
      ])
    ]);
    document.body.appendChild(overlay);
  }
  App.__showAdminMessageModal = showAdminMessageModal;   // für js/presence.js (Gäste)

  function banMessage(banUntil) {
    var t = new Date(banUntil).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
    return '🚫 Von einem Admin gesperrt bis ' + t + '.';
  }

  function stopHeartbeat() { if (state.hbTimer) clearInterval(state.hbTimer); state.hbTimer = null; }
  function startHeartbeat() {
    stopHeartbeat();
    state.hbTimer = setInterval(function () {
      if (!state.key || !state.backend) return;
      state.backend.getAccount(state.key).then(function (acct) {
        if (!acct || !acct.session || acct.session.token !== state.token) {
          forceLocalLogout('Von einem anderen Gerät angemeldet — du wurdest hier abgemeldet.');
          return;
        }
        if (acct.admin && acct.admin.banUntil && acct.admin.banUntil > Date.now()) {
          forceLocalLogout(banMessage(acct.admin.banUntil));
          return;
        }
        checkAdminMessage(acct);
        // Vom Admin verschenkte Turnier-Tickets genau einmal einlösen.
        if (App.Tickets && acct.admin && acct.admin.ticketGrant) App.Tickets.applyGrant(acct.admin.ticketGrant);
        // Vom Admin geschenktes Survival-Gold einlösen und danach aus dem Konto
        // entfernen, damit es nicht auf einem zweiten Gerät nochmal gutgeschrieben
        // wird (der Seen-Guard in survival.js schützt nur das aktuelle Gerät).
        if (App.Survival && acct.admin && acct.admin.goldGrant) {
          App.Survival.applyGoldGrant(acct.admin.goldGrant);
          acct.admin.goldGrant = null;
        }
        // Vom Admin gesetzter Level-Abzug (genau einmal, siehe progress.js).
        if (App.Progress && App.Progress.applyLevelAdjust && acct.admin && acct.admin.levelAdjust) {
          App.Progress.applyLevelAdjust(acct.admin.levelAdjust);
        }
        acct.session.lastSeen = Date.now();
        snapshotToAccount(acct);
        state.account = acct;
        state.backend.setAccount(state.key, acct);
      }).catch(function () {});
    }, HEARTBEAT_MS);
  }

  function forceLocalLogout(message) {
    stopHeartbeat();
    App.Storage.remove(KEY_SESSION);
    state.key = null; state.account = null; state.token = null;
    emit();
    if (message && App.UI && App.UI.toast) App.UI.toast(message, 'lose');
  }

  function resumeSession() {
    var sess = App.Storage.get(KEY_SESSION, null);
    if (!sess || !sess.key || !sess.token) return Promise.resolve();
    return state.backend.getAccount(sess.key).then(function (acct) {
      if (!acct || !acct.session || acct.session.token !== sess.token) {
        App.Storage.remove(KEY_SESSION);
        return;
      }
      state.key = sess.key; state.account = acct; state.token = sess.token;
      applyAccountToLocalState(acct);
      startHeartbeat();
    }).catch(function () {});
  }

  function boot() {
    initBackend().then(function (be) {
      state.backend = be;
      var lbDriver = be.leaderboardDriver();
      App.Leaderboard.useDriver(lbDriver);
      migrateOldLeaderboardOnce(lbDriver);
      return resumeSession();
    }).then(function () {
      state.ready = true;
      emit();
    });
  }

  /* ---------- Öffentliche API ---------- */
  var Account = {
    isReady: function () { return state.ready; },
    isLoggedIn: function () { return !!state.key; },
    current: function () { return state.account ? { name: state.account.displayName } : null; },
    backendKind: function () { return state.backend ? state.backend.kind : 'local'; },
    onChange: function (cb) {
      listeners.push(cb);
      return function () { var i = listeners.indexOf(cb); if (i >= 0) listeners.splice(i, 1); };
    },

    register: function (name, password) {
      var key = sanitizeKey(name);
      if (!key) return Promise.reject(new Error('Bitte einen gültigen Kontonamen eingeben (Buchstaben/Zahlen, min. 2 Zeichen).'));
      if (key.length < 2) return Promise.reject(new Error('Kontoname muss mind. 2 Zeichen haben.'));
      if (!password || password.length < 4) return Promise.reject(new Error('Passwort muss mind. 4 Zeichen haben.'));
      return state.backend.getAccount(key).then(function (existing) {
        if (existing) throw new Error('Dieser Kontoname ist bereits vergeben.');
        var salt = randHex(16);
        return hashPassword(password, salt).then(function (hash) {
          var token = randHex(16), now = Date.now();
          // Beide Spielstände (Casino + Survival) aus dem Storage ins neue Konto übernehmen.
          var acct = snapshotToAccount({
            displayName: String(name).trim().slice(0, 18),
            salt: salt, hash: hash, createdAt: now,
            session: { token: token, lastSeen: now }
          });
          if (!acct.playerName) acct.playerName = String(name).trim().slice(0, 18);
          return state.backend.setAccount(key, acct).then(function () {
            App.Storage.set(KEY_SESSION, { key: key, token: token });
            state.key = key; state.account = acct; state.token = token;
            applyAccountToLocalState(acct);
            startHeartbeat();
            emit();
          });
        });
      });
    },

    /** Anmelden — und falls es das Konto noch nicht gibt, es mit dem aktuellen
     *  Spielstand anlegen. Gedacht für den Admin-Login (siehe js/app.js): auch der
     *  Host soll ein echtes Konto haben, sonst lägen sein Level und sein Kontostand
     *  nur im Browser und wären auf jedem anderen Gerät wieder bei Level 1. */
    loginOrRegister: function (name, password) {
      var A = this, key = sanitizeKey(name);
      return state.backend.getAccount(key).then(function (existing) {
        return existing ? A.login(name, password) : A.register(name, password);
      });
    },

    login: function (name, password) {
      var key = sanitizeKey(name);
      return state.backend.getAccount(key).then(function (acct) {
        if (!acct) throw new Error('Kein Konto mit diesem Namen gefunden.');
        return hashPassword(password, acct.salt).then(function (hash) {
          if (hash !== acct.hash) throw new Error('Falsches Passwort.');
          if (acct.admin && acct.admin.banUntil && acct.admin.banUntil > Date.now()) {
            throw new Error(banMessage(acct.admin.banUntil));
          }
          var now = Date.now();
          if (acct.session && acct.session.token && acct.session.lastSeen && (now - acct.session.lastSeen) < SESSION_STALE_MS) {
            throw new Error('Dieses Konto ist gerade auf einem anderen Gerät aktiv. Bitte kurz warten (~20 Sek. nach Schließen dort) oder dort abmelden.');
          }
          var token = randHex(16);
          acct.session = { token: token, lastSeen: now };
          return state.backend.setAccount(key, acct).then(function () {
            App.Storage.set(KEY_SESSION, { key: key, token: token });
            state.key = key; state.account = acct; state.token = token;
            applyAccountToLocalState(acct);
            startHeartbeat();
            emit();
          });
        });
      });
    },

    logout: function () {
      var key = state.key, be = state.backend;
      stopHeartbeat();
      App.Storage.remove(KEY_SESSION);
      state.key = null; state.account = null; state.token = null;
      emit();
      if (key && be) {
        be.getAccount(key).then(function (acct) {
          if (acct) { acct.session = { token: null, lastSeen: 0 }; return be.setAccount(key, acct); }
        }).catch(function () {});
      }
    },

    changePassword: function (oldPassword, newPassword) {
      if (!state.key) return Promise.reject(new Error('Nicht angemeldet.'));
      if (!newPassword || newPassword.length < 4) return Promise.reject(new Error('Neues Passwort muss mind. 4 Zeichen haben.'));
      var key = state.key, be = state.backend;
      return be.getAccount(key).then(function (acct) {
        return hashPassword(oldPassword, acct.salt).then(function (hash) {
          if (hash !== acct.hash) throw new Error('Aktuelles Passwort ist falsch.');
          var salt = randHex(16);
          return hashPassword(newPassword, salt).then(function (newHash) {
            acct.salt = salt; acct.hash = newHash;
            return be.setAccount(key, acct).then(function () { state.account = acct; emit(); });
          });
        });
      });
    },

    currentKey: function () { return state.key; },

    /* ---------- Präsenz (siehe js/presence.js) ---------- */
    // Wie adminPatch/getAccount, aber für den 'presence'-Bucket, in dem sich JEDER
    // Besucher meldet (mit oder ohne Konto) — Grundlage dafür, dass das Admin Panel
    // wirklich alle Spieler sieht, nicht nur die mit eigenem Konto.
    presenceGet: function (key) {
      return (state.backend && state.backend.getPresence) ? state.backend.getPresence(key) : Promise.resolve(null);
    },
    presenceSet: function (key, data) {
      return (state.backend && state.backend.setPresence) ? state.backend.setPresence(key, data) : Promise.resolve();
    },

    /* ---------- Admin-API (siehe js/admin.js) ---------- */
    // Aktuell eingeloggtes Konto: { rig, banUntil, msg } oder null. Wird spätestens
    // alle HEARTBEAT_MS aktualisiert (siehe startHeartbeat), reicht für coins.js.
    adminMeta: function () { return (state.account && state.account.admin) || null; },
    adminListAccounts: function () {
      if (!state.backend || !state.backend.listAll) return Promise.resolve({});
      return state.backend.listAll();
    },
    adminListPresence: function () {
      if (!state.backend || !state.backend.listPresence) return Promise.resolve({});
      return state.backend.listPresence();
    },
    adminPatch: function (key, mutator) {
      if (!state.backend) return Promise.reject(new Error('Kein Backend verfügbar.'));
      return state.backend.getAccount(key).then(function (acct) {
        if (!acct) throw new Error('Konto nicht gefunden.');
        mutator(acct);
        return state.backend.setAccount(key, acct);
      });
    },
    adminPatchPresence: function (key, mutator) {
      if (!state.backend || !state.backend.setPresence) return Promise.reject(new Error('Kein Backend verfügbar.'));
      var getP = state.backend.getPresence ? state.backend.getPresence(key) : Promise.resolve(null);
      return getP.then(function (rec) {
        rec = rec || {};
        mutator(rec);
        return state.backend.setPresence(key, rec);
      });
    },
    adminRemoveAccount: function (key) {
      if (!state.backend || !state.backend.removeAccount) return Promise.reject(new Error('Kein Backend verfügbar.'));
      return state.backend.removeAccount(key);
    },
    adminRemovePresence: function (key) {
      if (!state.backend || !state.backend.removePresence) return Promise.reject(new Error('Kein Backend verfügbar.'));
      return state.backend.removePresence(key);
    }
  };

  // Guthaben & Spielername zeitnah (statt nur alle 8s per Heartbeat) mit dem Konto synchronisieren.
  function scheduleSync() {
    if (!state.key || !state.backend) return;
    if (state.syncTimer) return;
    state.syncTimer = setTimeout(function () {
      state.syncTimer = null;
      if (!state.key || !state.backend) return;
      state.backend.getAccount(state.key).then(function (acct) {
        if (!acct) return;
        snapshotToAccount(acct);
        state.account = acct;
        state.backend.setAccount(state.key, acct);
      }).catch(function () {});
    }, 1500);
  }
  App.Coins.onChange(scheduleSync);
  if (App.Bank) App.Bank.onChange(scheduleSync);
  App.Leaderboard.onChange(scheduleSync);

  App.Account = Account;
  boot();
})();
