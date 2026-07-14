/* net.js — Multiplayer-Fundament für die Online-Minigames.
 *
 * Einheitliches Room-System über drei austauschbare Transporte:
 *   - PeerBackend     : Raum-Code via PeerJS (WebRTC P2P, KEIN Setup nötig)   <- Standard online
 *   - FirebaseBackend : Realtime Database (falls eine echte Config vorliegt)
 *   - LocalBackend    : BroadcastChannel/localStorage (mehrere Tabs, file://)  <- Fallback
 *
 * Alle Transporte bieten dasselbe Mini-Interface:
 *   connect(role,code) -> Promise   ('host' | 'client')
 *   watch(path,cb) -> unsubscribe
 *   get(path) -> Promise<value>
 *   set/update/remove(path[,val])
 *   onDisconnectRemove(path)
 *   serverTime()
 *
 * Datenmodell: rooms/<CODE> = { createdAt, host, game, phase, round, shared,
 *   players:{ <id>:{ name, ready, joinedAt, lastSeen, score, state } } }
 *
 * Tab-Wechsel-Schutz: WebRTC-/DB-Verbindungen überstehen kurzes Wegtabben
 * (kein Kick). Ein Spieler fliegt erst raus, wenn seine Verbindung wirklich
 * schließt (Tab zu / Netz weg).
 */
(function () {
  'use strict';
  window.App = window.App || {};

  function randId(n, alphabet) {
    alphabet = alphabet || 'abcdefghijklmnopqrstuvwxyz0123456789';
    var s = '';
    for (var i = 0; i < n; i++) s += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
    return s;
  }
  function roomCode() { return randId(4, 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'); }

  function loadScript(src) {
    return new Promise(function (res, rej) {
      var s = document.createElement('script'); s.src = src; s.async = true;
      s.onload = res; s.onerror = function () { rej(new Error('Ladefehler: ' + src)); };
      document.head.appendChild(s);
    });
  }

  // Baum-Helfer für die In-Memory-Backends
  function valueAt(root, path) {
    var parts = path.split('/').filter(Boolean), node = root;
    for (var i = 0; i < parts.length; i++) { if (node == null) return null; node = node[parts[i]]; }
    return node == null ? null : node;
  }
  function setAt(root, path, val) {
    var parts = path.split('/').filter(Boolean), node = root;
    for (var i = 0; i < parts.length - 1; i++) {
      if (typeof node[parts[i]] !== 'object' || node[parts[i]] == null) node[parts[i]] = {};
      node = node[parts[i]];
    }
    if (val === null) delete node[parts[parts.length - 1]];
    else node[parts[parts.length - 1]] = val;
  }
  function makeWatchStore() {
    var watchers = {};
    return {
      add: function (path, cb) { (watchers[path] = watchers[path] || []).push(cb); return function () { var a = watchers[path]; if (a) { var i = a.indexOf(cb); if (i >= 0) a.splice(i, 1); } }; },
      notify: function (root) { Object.keys(watchers).forEach(function (p) { var v = valueAt(root, p); watchers[p].forEach(function (cb) { try { cb(v); } catch (e) {} }); }); }
    };
  }

  /* ===================== PeerJS-Backend (P2P, kein Setup) ===================== */
  var PEER_PREFIX = 'klettlogin-mini-';
  function loadPeerJS() {
    if (window.Peer) return Promise.resolve();
    return loadScript('https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js')
      .catch(function () { return loadScript('https://cdn.jsdelivr.net/npm/peerjs@1.5.4/dist/peerjs.min.js'); });
  }
  function PeerBackend() {
    var peer = null, role = null, code = null, hostConn = null;
    var conns = {};                 // host: peerId -> DataConnection
    var disconnectPaths = {};       // host: peerId -> [paths]
    var state = {};                 // voller Baum { rooms: { CODE: {...} } }
    var store = makeWatchStore();
    var timeOffset = 0;             // client: serverTime = Date.now()+offset

    function broadcast() {
      var msg = { t: 'full', state: state, now: Date.now() };
      Object.keys(conns).forEach(function (id) { try { conns[id].send(msg); } catch (e) {} });
    }
    function applyOp(op) {
      if (op.op === 'set') setAt(state, op.path, op.value);
      else if (op.op === 'remove') setAt(state, op.path, null);
      else if (op.op === 'update') Object.keys(op.value || {}).forEach(function (k) { setAt(state, op.path + '/' + k, op.value[k]); });
    }
    function onHostData(conn, d) {
      if (!d) return;
      if (d.t === 'op') { applyOp(d); broadcast(); store.notify(state); }
      else if (d.t === 'bye') { closeConn(conn); }
      else if (d.t === 'onDisconnect') { (disconnectPaths[conn.peer] = disconnectPaths[conn.peer] || []).push(d.path); }
    }
    function closeConn(conn) {
      (disconnectPaths[conn.peer] || []).forEach(function (p) { setAt(state, p, null); });
      delete disconnectPaths[conn.peer]; delete conns[conn.peer];
      broadcast(); store.notify(state);
    }

    return {
      kind: 'peer',
      connect: function (r, c) {
        role = r; code = c;
        return loadPeerJS().then(function () {
          return new Promise(function (res, rej) {
            var settled = false;
            if (r === 'host') {
              peer = new Peer(PEER_PREFIX + c, { debug: 0 });
              peer.on('open', function () { if (!settled) { settled = true; res(); } });
              peer.on('error', function (e) { if (!settled) { settled = true; rej(new Error(e && e.type === 'unavailable-id' ? 'Code belegt' : 'Verbindung fehlgeschlagen')); } });
              peer.on('connection', function (conn) {
                conn.on('open', function () { conns[conn.peer] = conn; conn.send({ t: 'full', state: state, now: Date.now() }); });
                conn.on('data', function (d) { onHostData(conn, d); });
                conn.on('close', function () { closeConn(conn); });
                conn.on('error', function () { closeConn(conn); });
              });
            } else {
              peer = new Peer({ debug: 0 });
              peer.on('open', function () {
                hostConn = peer.connect(PEER_PREFIX + c, { reliable: true });
                hostConn.on('open', function () {/* warte auf erstes full */ });
                hostConn.on('data', function (d) {
                  if (d && d.t === 'full') {
                    state = d.state || {};
                    if (d.now) timeOffset = d.now - Date.now();
                    store.notify(state);
                    if (!settled) { settled = true; res(); }
                  }
                });
                hostConn.on('close', function () { store.notify(state); });
                hostConn.on('error', function () { if (!settled) { settled = true; rej(new Error('Raum nicht gefunden')); } });
              });
              peer.on('error', function () { if (!settled) { settled = true; rej(new Error('Raum nicht gefunden')); } });
              setTimeout(function () { if (!settled) { settled = true; rej(new Error('Raum nicht gefunden')); } }, 9000);
            }
          });
        });
      },
      watch: function (path, cb) { var off = store.add(path, cb); cb(valueAt(state, path)); return off; },
      get: function (path) { return Promise.resolve(valueAt(state, path)); },
      set: function (path, v) { if (role === 'host') { setAt(state, path, v); broadcast(); store.notify(state); } else if (hostConn) hostConn.send({ t: 'op', op: 'set', path: path, value: v }); return Promise.resolve(); },
      update: function (path, o) { if (role === 'host') { Object.keys(o).forEach(function (k) { setAt(state, path + '/' + k, o[k]); }); broadcast(); store.notify(state); } else if (hostConn) hostConn.send({ t: 'op', op: 'update', path: path, value: o }); return Promise.resolve(); },
      remove: function (path) { if (role === 'host') { setAt(state, path, null); broadcast(); store.notify(state); } else if (hostConn) hostConn.send({ t: 'op', op: 'remove', path: path }); return Promise.resolve(); },
      onDisconnectRemove: function (path) { if (role === 'client' && hostConn) hostConn.send({ t: 'onDisconnect', path: path }); return Promise.resolve(); },
      serverTime: function () { return Date.now() + timeOffset; },
      destroy: function () { try { if (peer) peer.destroy(); } catch (e) {} }
    };
  }

  /* ===================== Firebase-Backend (optional) ===================== */
  var FB_VER = '10.12.0';
  function loadFirebaseSDK() {
    if (window.firebase && window.firebase.database) return Promise.resolve();
    return loadScript('https://www.gstatic.com/firebasejs/' + FB_VER + '/firebase-app-compat.js')
      .then(function () { return loadScript('https://www.gstatic.com/firebasejs/' + FB_VER + '/firebase-database-compat.js'); });
  }
  function FirebaseBackend(cfg) {
    if (!firebase.apps || !firebase.apps.length) firebase.initializeApp(cfg);
    var db = firebase.database();
    return {
      kind: 'firebase',
      connect: function () { return Promise.resolve(); },
      watch: function (path, cb) { var ref = db.ref(path); var h = ref.on('value', function (s) { cb(s.val()); }); return function () { ref.off('value', h); }; },
      get: function (path) { return db.ref(path).get().then(function (s) { return s.val(); }); },
      set: function (path, v) { return db.ref(path).set(v); },
      update: function (path, o) { return db.ref(path).update(o); },
      remove: function (path) { return db.ref(path).remove(); },
      onDisconnectRemove: function (path) { return db.ref(path).onDisconnect().remove(); },
      serverTime: function () { return firebase.database.ServerValue.TIMESTAMP; },
      destroy: function () {}
    };
  }

  /* ===================== Lokal-Backend (Tabs / file://) ===================== */
  function LocalBackend() {
    var bc = ('BroadcastChannel' in window) ? new BroadcastChannel('mp-sync') : null;
    var store = makeWatchStore();
    function readRoot() { try { return JSON.parse(localStorage.getItem('mp-root') || '{}'); } catch (e) { return {}; } }
    function writeRoot(r) { localStorage.setItem('mp-root', JSON.stringify(r)); if (bc) bc.postMessage(1); }
    function notify() { store.notify(readRoot()); }
    if (bc) bc.onmessage = notify;
    window.addEventListener('storage', function (e) { if (e.key === 'mp-root') notify(); });
    var dPaths = [];
    function cleanup() { var r = readRoot(); dPaths.forEach(function (p) { setAt(r, p, null); }); if (dPaths.length) writeRoot(r); }
    window.addEventListener('pagehide', cleanup); window.addEventListener('beforeunload', cleanup);
    return {
      kind: 'local',
      connect: function () { return Promise.resolve(); },
      watch: function (path, cb) { var off = store.add(path, cb); cb(valueAt(readRoot(), path)); return off; },
      get: function (path) { return Promise.resolve(valueAt(readRoot(), path)); },
      set: function (path, v) { var r = readRoot(); setAt(r, path, v); writeRoot(r); return Promise.resolve(); },
      update: function (path, o) { var r = readRoot(); Object.keys(o).forEach(function (k) { setAt(r, path + '/' + k, o[k]); }); writeRoot(r); return Promise.resolve(); },
      remove: function (path) { var r = readRoot(); setAt(r, path, null); writeRoot(r); return Promise.resolve(); },
      onDisconnectRemove: function (path) { dPaths.push(path); return Promise.resolve(); },
      serverTime: function () { return Date.now(); },
      destroy: function () {}
    };
  }

  /* ===================== Transport-Auswahl ===================== */
  function fbConfigReal(cfg) {
    return cfg && typeof cfg.apiKey === 'string' && cfg.apiKey.indexOf('DEIN_') !== 0 &&
      typeof cfg.databaseURL === 'string' && cfg.databaseURL.indexOf('DEIN_') < 0 && cfg.databaseURL.indexOf('http') === 0;
  }
  function isFileOrOffline() { return location.protocol === 'file:' || (navigator && navigator.onLine === false); }

  function preferredKind() {
    if (fbConfigReal(window.FIREBASE_CONFIG)) return 'firebase';
    if (!isFileOrOffline()) return 'peer';
    return 'local';
  }

  // Erzeugt für eine Room-Instanz ein frisches Backend passend zum Transport.
  function makeBackend() {
    var kind = preferredKind();
    if (kind === 'firebase') {
      return loadFirebaseSDK().then(function () { return FirebaseBackend(window.FIREBASE_CONFIG); })
        .catch(function () { return LocalBackend(); });
    }
    if (kind === 'peer') {
      return Promise.resolve(PeerBackend());   // PeerJS wird in connect() geladen
    }
    return Promise.resolve(LocalBackend());
  }

  /* ===================== Room ===================== */
  function makeRoom() {
    var be = null, code = null, myId = randId(9), myName = 'Spieler';
    var unsub = [], hbTimer = null, listeners = {}, lastRoom = null;

    function emit(evt, data) { (listeners[evt] || []).forEach(function (cb) { try { cb(data); } catch (e) {} }); }
    function base() { return 'rooms/' + code; }

    function onVis() { if (!document.hidden && code && be) be.update(base() + '/players/' + myId, { lastSeen: be.serverTime() }); }
    function startHeartbeat() {
      stopHeartbeat();
      function beat() { if (code && be) be.update(base() + '/players/' + myId, { lastSeen: be.serverTime() }); }
      beat(); hbTimer = setInterval(beat, 4000);
      document.addEventListener('visibilitychange', onVis);
    }
    function stopHeartbeat() { if (hbTimer) clearInterval(hbTimer); hbTimer = null; document.removeEventListener('visibilitychange', onVis); }

    function subscribeRoom() {
      unsub.push(be.watch(base(), function (room) {
        lastRoom = room;
        emit('room', room);
        emit('players', room && room.players ? room.players : {});
        emit('phase', room ? room.phase : null);
        emit('shared', room ? room.shared : null);
      }));
    }

    var Room = {
      get id() { return myId; },
      get code() { return code; },
      get name() { return myName; },
      backend: function () { return be ? be.kind : preferredKind(); },
      isHost: function () { return lastRoom && lastRoom.host === myId; },
      snapshot: function () { return lastRoom; },
      players: function () {
        var p = (lastRoom && lastRoom.players) || {};
        return Object.keys(p).map(function (id) { return Object.assign({ id: id }, p[id]); })
          .sort(function (a, b) { return (a.joinedAt || 0) - (b.joinedAt || 0); });
      },
      on: function (evt, cb) { (listeners[evt] = listeners[evt] || []).push(cb); return Room; },
      off: function (evt, cb) { var a = listeners[evt]; if (a) { var i = a.indexOf(cb); if (i >= 0) a.splice(i, 1); } },
      setName: function (n) { myName = String(n || 'Spieler').slice(0, 16); },

      host: function (gameId, opts) {
        return makeBackend().then(function (b) {
          be = b; code = roomCode();
          return be.connect('host', code).then(function () {
            var now = be.serverTime();
            var room = { createdAt: now, host: myId, game: gameId, phase: 'lobby', opts: opts || {}, shared: {}, players: {} };
            room.players[myId] = { name: myName, ready: false, joinedAt: now, lastSeen: now, score: 0, state: null };
            return be.set(base(), room).then(function () {
              be.onDisconnectRemove(base() + '/players/' + myId);
              subscribeRoom(); startHeartbeat(); return code;
            });
          });
        });
      },

      join: function (joinCode) {
        return makeBackend().then(function (b) {
          be = b; code = String(joinCode || '').toUpperCase().trim();
          return be.connect('client', code).then(function () {
            return be.get(base()).then(function (room) {
              if (!room) throw new Error('Raum nicht gefunden');
              var now = be.serverTime();
              return be.update(base() + '/players/' + myId, { name: myName, ready: false, joinedAt: now, lastSeen: now, score: 0, state: null })
                .then(function () {
                  be.onDisconnectRemove(base() + '/players/' + myId);
                  subscribeRoom(); startHeartbeat(); return room.game;
                });
            });
          });
        });
      },

      setReady: function (r) { if (code && be) return be.update(base() + '/players/' + myId, { ready: !!r }); },
      reportScore: function (score) { if (code && be) return be.update(base() + '/players/' + myId, { score: score }); },
      reportState: function (st) { if (code && be) return be.update(base() + '/players/' + myId, { state: st }); },
      setShared: function (patch) { if (code && be) return be.update(base() + '/shared', patch); },
      setPhase: function (phase, extra) { if (!code || !be) return; var o = { phase: phase }; if (extra) o = Object.assign(o, extra); return be.update(base(), o); },
      now: function () { return be ? be.serverTime() : Date.now(); },

      leave: function () {
        stopHeartbeat();
        unsub.forEach(function (f) { try { f(); } catch (e) {} }); unsub = [];
        var p = (code && be) ? be.remove(base() + '/players/' + myId) : Promise.resolve();
        return p.then(function () {
          if (be && lastRoom && lastRoom.host === myId) {
            var others = Object.keys(lastRoom.players || {}).filter(function (x) { return x !== myId; });
            if (others.length) return be.update(base(), { host: others[0] });
            if (code) return be.remove(base());
          }
        }).then(function () { if (be && be.destroy) be.destroy(); code = null; lastRoom = null; });
      }
    };
    return Room;
  }

  App.Net = {
    available: function () { return true; },
    isOnline: function () { return preferredKind() !== 'local'; },
    backendKind: function () { return preferredKind(); },
    createRoom: function () { return makeRoom(); },
    randId: randId,
    /** true, wenn eine echte Firebase-Konfiguration hinterlegt ist (js/firebase-config.js). */
    firebaseConfigured: function () { return fbConfigReal(window.FIREBASE_CONFIG); },
    /** Liefert (geladen + initialisiert) die Firebase-Database-Instanz, für Module außerhalb von net.js (z. B. Accounts). */
    firebaseDb: function () {
      return loadFirebaseSDK().then(function () {
        if (!firebase.apps || !firebase.apps.length) firebase.initializeApp(window.FIREBASE_CONFIG);
        return firebase.database();
      });
    }
  };
})();
