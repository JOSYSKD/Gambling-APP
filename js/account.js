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
          save: function (entries) { App.Storage.set(KEY_LOCAL_LB, entries || []); App.Leaderboard.refresh(); }
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
      leaderboardDriver: function () {
        var cache = [];
        var ref = db.ref('leaderboard');
        ref.limitToLast(500).on('value', function (snap) {
          var val = snap.val() || {};
          cache = Object.keys(val).map(function (k) { return val[k]; });
          App.Leaderboard.refresh();
        });
        return {
          load: function () { return cache; },
          push: function (entry) { ref.push(entry); },
          save: function (entries) { ref.set(entries && entries.length ? entries : null); }
        };
      }
    };
  }

  // Keyloser Fallback ohne Google-/Firebase-Konto, siehe js/cloud.js + js/cloud-config.js.
  function cloudBackend() {
    App.Cloud.startPolling(10000);
    var lbCache = [];
    function syncLbCache(state) { lbCache = (state && state.leaderboard) || []; App.Leaderboard.refresh(); }
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
          }
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

  function applyAccountToLocalState(acct) {
    if (typeof acct.balance === 'number') App.Storage.set('gj_balance', acct.balance);
    if (typeof acct.runPeak === 'number') App.Storage.set('gj_run_peak', Math.max(acct.runPeak, acct.balance || 0));
    App.Coins.reloadFromStorage();
    if (acct.playerName) App.Leaderboard.setPlayerName(acct.playerName);
  }

  // Admin-Nachrichten (siehe js/admin.js): einmalig je Nachrichten-ID als Modal zeigen.
  var KEY_ADMIN_MSG_SEEN = 'gj_admin_msg_seen';
  function checkAdminMessage(acct) {
    var msg = acct.admin && acct.admin.msg;
    if (!msg || !msg.id) return;
    if (App.Storage.get(KEY_ADMIN_MSG_SEEN, null) === msg.id) return;
    App.Storage.set(KEY_ADMIN_MSG_SEEN, msg.id);
    if (!App.UI || !App.UI.el) return;
    var elx = App.UI.el;
    var overlay = elx('div', { class: 'modal-overlay' }, [
      elx('div', { class: 'modal glass' }, [
        elx('div', { class: 'modal-leaf' }, ['📢']),
        elx('h2', { class: 'neon' }, ['Nachricht vom Admin']),
        elx('p', {}, [msg.text]),
        elx('button', { class: 'btn btn-primary btn-lg', type: 'button', onclick: function () {
          document.body.removeChild(overlay);
        } }, ['Verstanden'])
      ])
    ]);
    document.body.appendChild(overlay);
  }

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
        acct.session.lastSeen = Date.now();
        acct.balance = App.Coins.get();
        acct.runPeak = App.Coins.getPeak();
        acct.playerName = App.Leaderboard.getPlayerName();
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
          var acct = {
            displayName: String(name).trim().slice(0, 18),
            salt: salt, hash: hash, createdAt: now,
            balance: App.Coins.get(), runPeak: App.Coins.getPeak(),
            playerName: App.Leaderboard.getPlayerName() || String(name).trim().slice(0, 18),
            session: { token: token, lastSeen: now }
          };
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
        acct.balance = App.Coins.get();
        acct.runPeak = App.Coins.getPeak();
        acct.playerName = App.Leaderboard.getPlayerName();
        state.account = acct;
        state.backend.setAccount(state.key, acct);
      }).catch(function () {});
    }, 1500);
  }
  App.Coins.onChange(scheduleSync);
  App.Leaderboard.onChange(scheduleSync);

  App.Account = Account;
  boot();
})();
