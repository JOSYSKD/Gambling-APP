/* chat.js — Live-Gruppen-Chat als Slide-over-Panel (App.Chat).
 *
 * Über den 💬-Knopf in der Kopfleiste auf jeder Seite erreichbar. Wie bei der
 * Bestenliste (js/leaderboard.js) läuft die Persistenz über einen austausch-
 * baren Treiber, automatisch passend zum verfügbaren Backend (wie account.js):
 *   - Firebase Realtime Database, WENN js/firebase-config.js echte Werte enthält
 *     -> Nachrichten kommen bei allen Besuchern per Realtime-Push sofort an.
 *   - Sonst Cloud-Speicher (js/cloud.js), WENN eine CLOUD_STORE_ID gesetzt ist
 *     -> geteilt, aber per Polling (~10s Verzögerung).
 *   - Sonst rein lokal per BroadcastChannel/localStorage (nur Tabs desselben
 *     Browsers) -> die Seite bleibt in jedem Fall benutzbar.
 *
 * Sicherheits-Hinweis: wie der Rest der Seite (siehe account.js) offener
 * Lese-/Schreibzugriff ohne echten Server — Casual-Schutz für eine Klassen-/
 * Freundesrunde, keine Moderation, kein Schutz vor Missbrauch.
 */
(function () {
  'use strict';
  window.App = window.App || {};
  var UI = App.UI, el = UI.el;

  var KEY_LOCAL_MESSAGES = 'gj_chat_local';
  var KEY_SENDER_ID = 'gj_chat_sender_id';
  var MAX_MESSAGES = 200;
  var MAX_LEN = 300;

  function randHex(n) {
    var bytes = new Uint8Array(n);
    if (window.crypto && crypto.getRandomValues) crypto.getRandomValues(bytes);
    else for (var i = 0; i < n; i++) bytes[i] = Math.floor(Math.random() * 256);
    return Array.prototype.map.call(bytes, function (b) { return b.toString(16).padStart(2, '0'); }).join('');
  }
  function mySenderId() {
    var id = App.Storage.get(KEY_SENDER_ID, null);
    if (!id) { id = 'u' + randHex(10); App.Storage.set(KEY_SENDER_ID, id); }
    return id;
  }
  function genId() { return 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

  /* ---------- Treiber (austauschbar, gleiche Idee wie leaderboardDriver in account.js) ---------- */
  function localDriver() {
    var bc = ('BroadcastChannel' in window) ? new BroadcastChannel('gj-chat') : null;
    function readAll() { return App.Storage.get(KEY_LOCAL_MESSAGES, []); }
    function writeAll(list) { App.Storage.set(KEY_LOCAL_MESSAGES, list); }
    if (bc) bc.onmessage = function () { Chat.refresh(); };
    window.addEventListener('storage', function (e) { if (e.key === KEY_LOCAL_MESSAGES) Chat.refresh(); });
    return {
      kind: 'local',
      load: function () { return Promise.resolve(readAll()); },
      send: function (msg) {
        var list = readAll();
        list.push(msg);
        if (list.length > MAX_MESSAGES) list = list.slice(list.length - MAX_MESSAGES);
        writeAll(list);
        if (bc) bc.postMessage(1);
        Chat.refresh();
        return Promise.resolve();
      }
    };
  }

  function firebaseDriver(db) {
    var cache = [];
    var ref = db.ref('chat');
    ref.limitToLast(MAX_MESSAGES).on('value', function (snap) {
      var val = snap.val() || {};
      cache = Object.keys(val).map(function (k) { return val[k]; })
        .sort(function (a, b) { return (a.ts || 0) - (b.ts || 0); });
      Chat.refresh();
    });
    return {
      kind: 'firebase',
      load: function () { return Promise.resolve(cache); },
      send: function (msg) { return ref.push(msg); }
    };
  }

  // Keyloser Fallback ohne Google-/Firebase-Konto (siehe js/cloud.js).
  function cloudDriver() {
    App.Cloud.startPolling(10000);
    var cache = [];
    function sync(state) { cache = (state && state.chat) || []; Chat.refresh(); }
    App.Cloud.onChange(sync);
    App.Cloud.load().then(sync).catch(function () {});
    return {
      kind: 'cloud',
      load: function () { return Promise.resolve(cache); },
      send: function (msg) {
        return App.Cloud.mutate(function (state) {
          state.chat = state.chat || [];
          state.chat.push(msg);
          if (state.chat.length > MAX_MESSAGES) state.chat = state.chat.slice(state.chat.length - MAX_MESSAGES);
        }).then(sync);
      }
    };
  }

  function cloudOrLocal() {
    if (App.Cloud && App.Cloud.configured()) {
      return App.Cloud.load().then(function () { return cloudDriver(); }).catch(function () { return localDriver(); });
    }
    return Promise.resolve(localDriver());
  }
  function initDriver() {
    if (App.Net && App.Net.firebaseConfigured()) {
      return App.Net.firebaseDb().then(firebaseDriver).catch(function () { return cloudOrLocal(); });
    }
    return cloudOrLocal();
  }

  /* ---------- Zustand ---------- */
  var driver = null, cache = [], listeners = [], panelOpen = false, unread = 0, loadedOnce = false;
  function emit() { listeners.forEach(function (cb) { try { cb(); } catch (e) {} }); }

  var Chat = {
    isReady: function () { return !!driver; },
    getMessages: function () { return cache; },
    onChange: function (cb) {
      listeners.push(cb);
      return function () { var i = listeners.indexOf(cb); if (i >= 0) listeners.splice(i, 1); };
    },
    refresh: function () {
      if (!driver) return;
      driver.load().then(function (list) {
        var prevIds = {};
        cache.forEach(function (m) { prevIds[m.id] = true; });
        var next = (list || []).slice().sort(function (a, b) { return (a.ts || 0) - (b.ts || 0); });
        // Beim allerersten Laden (Verlauf) nichts als "ungelesen" zählen — nur
        // Nachrichten, die NACH dem initialen Laden neu dazukommen.
        if (loadedOnce && panelOpen === false) {
          var mine = mySenderId();
          next.forEach(function (m) { if (!prevIds[m.id] && m.senderId !== mine) unread++; });
        }
        loadedOnce = true;
        cache = next;
        emit();
      });
    },
    sendMessage: function (text) {
      text = String(text || '').trim().slice(0, MAX_LEN);
      if (!text || !driver) return Promise.resolve();
      var msg = {
        id: genId(), senderId: mySenderId(),
        name: (App.Leaderboard && App.Leaderboard.getPlayerName()) || 'Gast',
        text: text, ts: Date.now()
      };
      return driver.send(msg);
    },
    isOpen: function () { return panelOpen; },
    unreadCount: function () { return unread; },
    open: function () { panelOpen = true; unread = 0; emit(); },
    close: function () { panelOpen = false; emit(); }
  };
  App.Chat = Chat;

  /* ---------- UI ---------- */
  function injectCss() {
    UI.injectStyle('chat-panel-css', [
      '.chat-toggle{position:relative;}',
      '.chat-badge{position:absolute;top:-4px;right:-4px;min-width:16px;height:16px;padding:0 4px;border-radius:999px;background:var(--danger-2);color:#170006;font-size:10px;font-weight:800;display:flex;align-items:center;justify-content:center;box-shadow:0 0 6px rgba(0,0,0,0.5);}',
      '.chat-backdrop{position:fixed;inset:0;z-index:95;background:rgba(2,8,5,0.6);backdrop-filter:blur(2px);opacity:0;pointer-events:none;transition:opacity .2s ease;}',
      '.chat-backdrop.show{opacity:1;pointer-events:auto;}',
      '.chat-drawer{position:fixed;top:0;right:0;bottom:0;z-index:96;width:min(380px,100vw);display:flex;flex-direction:column;background:var(--panel-solid);border-left:1px solid var(--stroke);box-shadow:-10px 0 30px rgba(0,0,0,0.4);transform:translateX(100%);transition:transform .25s ease;}',
      '.chat-drawer.show{transform:translateX(0);}',
      '.chat-drawer-head{display:flex;align-items:center;justify-content:space-between;padding:16px 18px;border-bottom:1px solid var(--stroke);}',
      '.chat-drawer-title{font-weight:900;}',
      '.chat-drawer-close{background:none;border:none;color:var(--text);font-size:22px;cursor:pointer;padding:4px 8px;line-height:1;}',
      '.chat-messages{flex:1;overflow-y:auto;padding:14px 16px;display:flex;flex-direction:column;gap:10px;}',
      '.chat-msg{max-width:85%;padding:8px 12px;border-radius:14px;background:rgba(9,32,21,0.7);border:1px solid var(--stroke);align-self:flex-start;}',
      '.chat-msg-mine{align-self:flex-end;background:rgba(57,255,20,0.14);border-color:var(--stroke-2);}',
      '.chat-msg-meta{display:flex;gap:8px;font-size:11px;color:var(--muted);margin-bottom:2px;}',
      '.chat-msg-name{font-weight:700;color:var(--aqua-soft);}',
      '.chat-msg-text{font-size:14px;word-break:break-word;white-space:pre-wrap;}',
      '.chat-empty{color:var(--muted);text-align:center;padding:30px 10px;}',
      '.chat-input-row{display:flex;gap:8px;padding:12px 14px;border-top:1px solid var(--stroke);}',
      '.chat-input-row .text-input{flex:1;}',
      '@media (max-width:560px){.chat-drawer{width:100vw;}}'
    ].join(''));
  }

  function boot() {
    injectCss();
    var btn = document.getElementById('chat-toggle-btn');
    var badge = document.getElementById('chat-badge');
    if (!btn) return; // Kopfleiste ohne Chat-Knopf (z. B. andere Seite) -> Modul bleibt inaktiv

    var input = el('input', { class: 'text-input', type: 'text', maxlength: MAX_LEN, placeholder: 'Nachricht an alle …' });
    var sendBtn = el('button', { class: 'btn btn-primary', type: 'button', onclick: send }, ['Senden']);
    var messages = el('div', { class: 'chat-messages' });
    var drawer = el('div', { class: 'chat-drawer' }, [
      el('div', { class: 'chat-drawer-head' }, [
        el('div', { class: 'chat-drawer-title neon' }, ['💬 Gruppen-Chat']),
        el('button', { class: 'chat-drawer-close', type: 'button', onclick: close, 'aria-label': 'Schließen' }, ['✕'])
      ]),
      messages,
      el('div', { class: 'chat-input-row' }, [input, sendBtn])
    ]);
    var backdrop = el('div', { class: 'chat-backdrop', onclick: close });
    document.body.appendChild(backdrop);
    document.body.appendChild(drawer);

    function send() {
      var v = input.value;
      if (!v || !v.trim()) return;
      Chat.sendMessage(v);
      input.value = '';
      input.focus();
    }
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') send(); });

    function open() {
      Chat.open();
      backdrop.classList.add('show');
      drawer.classList.add('show');
      setTimeout(function () { input.focus(); }, 150);
    }
    function close() {
      Chat.close();
      backdrop.classList.remove('show');
      drawer.classList.remove('show');
    }
    btn.addEventListener('click', function () { Chat.isOpen() ? close() : open(); });

    function draw() {
      messages.innerHTML = '';
      if (!cache.length) {
        messages.appendChild(el('p', { class: 'chat-empty' }, ['Noch keine Nachrichten — schreib die erste! 🌿']));
      } else {
        var mine = mySenderId();
        cache.forEach(function (m) {
          messages.appendChild(el('div', { class: 'chat-msg' + (m.senderId === mine ? ' chat-msg-mine' : '') }, [
            el('div', { class: 'chat-msg-meta' }, [
              el('span', { class: 'chat-msg-name' }, [m.name || 'Gast']),
              el('span', {}, [new Date(m.ts || 0).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })])
            ]),
            el('div', { class: 'chat-msg-text' }, [m.text])
          ]));
        });
      }
      messages.scrollTop = messages.scrollHeight;
      if (badge) {
        var n = Chat.unreadCount();
        badge.hidden = n <= 0;
        badge.textContent = n > 99 ? '99+' : String(n);
      }
    }
    Chat.onChange(draw);

    initDriver().then(function (d) {
      driver = d;
      Chat.refresh();
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
