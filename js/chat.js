/* chat.js — Live-Gruppen-Chat für alle Spieler.
 *
 * Öffnet sich als Slide-over-Panel von der oberen Leiste aus (Knopf 💬,
 * neben Bestenliste/Profil) und funktioniert auf JEDER Seite, unabhängig
 * vom Router — genau wie das Guthaben in der Kopfleiste.
 *
 * Persistenz läuft modular über einen austauschbaren `driver` (`load`/`push`),
 * genau wie bei js/leaderboard.js. js/account.js injiziert beim Start den
 * zum gewählten Backend passenden Driver (`App.Chat.useDriver(...)`):
 *  - Firebase: echter Realtime-Listener -> Nachrichten erscheinen sofort bei
 *    allen Besuchern (siehe firebaseBackend().chatDriver() in account.js).
 *  - Cloud-Speicher (JSONBlob): Polling (~10s), wie die geteilte Bestenliste.
 *  - Lokal (kein Backend/`file://`): nur in diesem Browser, aber per
 *    BroadcastChannel immerhin über mehrere Tabs live synchron.
 */
(function () {
  'use strict';
  window.App = window.App || {};

  var MAX_LEN = 300;

  var noopDriver = { load: function () { return []; }, push: function () {} };
  var driver = noopDriver;
  // Nachrichten, die abgeschickt wurden, bevor account.js den echten Driver
  // injiziert hat (kurzes Zeitfenster beim Start) — gehen so nicht verloren.
  var pending = [];
  var listeners = [];
  function emit() { listeners.forEach(function (cb) { try { cb(); } catch (e) {} }); }

  var Chat = {
    /** Anderen Persistenz-Driver einsetzen (siehe account.js). */
    useDriver: function (d) {
      driver = d || noopDriver;
      if (driver !== noopDriver && pending.length) {
        pending.forEach(function (m) { driver.push(m); });
        pending = [];
      }
      emit();
    },
    /** Für asynchrone Driver: Listener neu benachrichtigen, wenn sich der Cache ändert. */
    refresh: function () { emit(); },
    onChange: function (cb) {
      listeners.push(cb);
      return function () { var i = listeners.indexOf(cb); if (i >= 0) listeners.splice(i, 1); };
    },
    getMessages: function () { return (driver.load() || []).concat(pending); },
    send: function (text) {
      text = String(text || '').trim().slice(0, MAX_LEN);
      if (!text) return;
      var name = (App.Leaderboard.getPlayerName() || 'Anonym').slice(0, 18);
      var msg = { name: name, text: text, ts: Date.now() };
      if (driver === noopDriver) pending.push(msg);
      else driver.push(msg);
      emit();
    }
  };

  App.Chat = Chat;

  /* ===================== UI: Slide-over-Panel ===================== */
  function boot() {
    var UI = App.UI, el = UI.el;
    if (!UI) return;

    UI.injectStyle('chat-panel-css', [
      '.chat-toggle{position:relative;appearance:none;cursor:pointer;font:inherit;}',
      '.chat-dot{position:absolute;top:6px;right:6px;width:9px;height:9px;border-radius:50%;background:var(--danger);box-shadow:0 0 6px var(--danger);display:none;}',
      '.chat-dot.show{display:block;}',
      '.chat-backdrop{position:fixed;inset:0;z-index:94;background:rgba(2,8,5,0.6);backdrop-filter:blur(2px);opacity:0;pointer-events:none;transition:opacity .25s;}',
      '.chat-backdrop.open{opacity:1;pointer-events:auto;}',
      '.chat-panel{position:fixed;top:0;right:0;bottom:0;width:min(380px,92vw);z-index:95;',
      'background:var(--panel-solid);border-left:1px solid var(--stroke-2);box-shadow:-10px 0 40px rgba(0,0,0,0.5);',
      'display:flex;flex-direction:column;transform:translateX(100%);transition:transform .28s ease;}',
      '.chat-panel.open{transform:translateX(0);}',
      '.chat-panel-head{display:flex;align-items:center;justify-content:space-between;padding:16px 16px 12px;border-bottom:1px solid var(--stroke);flex:0 0 auto;}',
      '.chat-panel-title{margin:0;font-size:18px;}',
      '.chat-close{padding:8px 12px;}',
      '.chat-messages{flex:1 1 auto;overflow-y:auto;padding:14px 16px;display:flex;flex-direction:column;gap:10px;}',
      '.chat-empty{color:var(--muted);text-align:center;margin-top:30px;}',
      '.chat-msg{max-width:88%;padding:8px 12px;border-radius:14px;background:rgba(9,32,21,0.7);border:1px solid var(--stroke);align-self:flex-start;}',
      '.chat-msg-mine{align-self:flex-end;background:rgba(57,255,20,0.14);border-color:var(--stroke-2);}',
      '.chat-msg-head{display:flex;gap:8px;align-items:baseline;margin-bottom:2px;}',
      '.chat-msg-head b{color:var(--leaf);font-size:13px;}',
      '.chat-msg-time{color:var(--muted);font-size:11px;}',
      '.chat-msg-text{font-size:14px;line-height:1.4;word-break:break-word;white-space:pre-wrap;}',
      '.chat-form{display:flex;gap:8px;padding:12px 16px;border-top:1px solid var(--stroke);flex:0 0 auto;}',
      '.chat-input{flex:1;}',
      '.chat-send{flex:0 0 auto;padding:12px 16px;}'
    ].join(''));

    var isOpen = false;
    var lastSeenCount = 0;
    // Historische Nachrichten, die kurz nach dem Laden eintrudeln (Firebase liefert
    // beim ersten Realtime-Callback den gesamten bisherigen Verlauf auf einen Schlag),
    // sollen nicht als "ungelesen" markiert werden — daher erst nach kurzer Anlaufzeit
    // eine Basislinie setzen und ab da echte neue Nachrichten erkennen.
    var baselineReady = false;

    var messagesEl = el('div', { class: 'chat-messages' });
    var input = el('input', {
      class: 'text-input chat-input', type: 'text', maxlength: MAX_LEN,
      placeholder: 'Nachricht an alle …', autocomplete: 'off'
    });
    var form = el('form', { class: 'chat-form', onsubmit: function (e) {
      e.preventDefault();
      var v = input.value;
      input.value = '';
      Chat.send(v);
    } }, [
      input,
      el('button', { class: 'btn btn-primary chat-send', type: 'submit' }, ['➤'])
    ]);

    var panel = el('div', { class: 'chat-panel' }, [
      el('div', { class: 'chat-panel-head' }, [
        el('h3', { class: 'chat-panel-title neon' }, ['💬 Gruppen-Chat']),
        el('button', { class: 'btn btn-ghost chat-close', type: 'button', onclick: closePanel }, ['✕'])
      ]),
      messagesEl,
      form
    ]);
    var backdrop = el('div', { class: 'chat-backdrop', onclick: closePanel });
    document.body.appendChild(backdrop);
    document.body.appendChild(panel);

    var dot = el('span', { class: 'chat-dot' });
    var toggleBtn = el('button', { class: 'topnav-link chat-toggle', type: 'button', title: 'Gruppen-Chat' }, ['💬', dot]);
    toggleBtn.addEventListener('click', function () { isOpen ? closePanel() : openPanel(); });
    var nav = document.querySelector('.topnav');
    if (nav) nav.insertBefore(toggleBtn, nav.firstChild);

    function openPanel() {
      isOpen = true;
      panel.classList.add('open'); backdrop.classList.add('open');
      render();
      setTimeout(function () { input.focus(); }, 250);
    }
    function closePanel() {
      isOpen = false;
      panel.classList.remove('open'); backdrop.classList.remove('open');
    }

    function fmtTime(ts) {
      return new Date(ts || Date.now()).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
    }
    function buildMsg(m) {
      var mine = m.name === (App.Leaderboard.getPlayerName() || 'Anonym');
      return el('div', { class: 'chat-msg' + (mine ? ' chat-msg-mine' : '') }, [
        el('div', { class: 'chat-msg-head' }, [el('b', {}, [m.name || 'Anonym']), el('span', { class: 'chat-msg-time' }, [fmtTime(m.ts)])]),
        el('div', { class: 'chat-msg-text' }, [m.text])
      ]);
    }

    function render() {
      var msgs = Chat.getMessages();

      messagesEl.innerHTML = '';
      if (!msgs.length) {
        messagesEl.appendChild(el('p', { class: 'chat-empty' }, ['Noch keine Nachrichten. Schreib die erste! 👋']));
      } else {
        msgs.forEach(function (m) { messagesEl.appendChild(buildMsg(m)); });
      }

      if (isOpen) {
        lastSeenCount = msgs.length;
        dot.classList.remove('show');
        messagesEl.scrollTop = messagesEl.scrollHeight;
      } else if (baselineReady) {
        dot.classList.toggle('show', msgs.length > lastSeenCount);
      }
    }

    Chat.onChange(render);
    render();
    setTimeout(function () {
      lastSeenCount = Chat.getMessages().length;
      baselineReady = true;
    }, 1500);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
