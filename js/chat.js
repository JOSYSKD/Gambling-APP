/* chat.js — Live-Gruppenchat für alle Spieler  (App.Chat)
 *
 * Ein einziger, geteilter Chatraum für die ganze Spielhalle. Nachrichten werden
 * über das bereits vorhandene Firebase-Backend live verteilt — geschrieben und
 * gelesen unter dem Pfad `scores/__groupchat` (dieser Unterknoten von `scores`
 * ist in den veröffentlichten Firebase-Regeln freigegeben; ein neuer Top-Level-
 * Knoten wäre gesperrt).
 *
 * Kein Firebase erreichbar? Dann fällt der Chat sauber auf einen lokalen Modus
 * zurück (BroadcastChannel + localStorage), sodass wenigstens mehrere Tabs
 * desselben Browsers miteinander reden können. Die Seite bricht nie.
 *
 * Nachrichten-Objekt:  { name, text, ts, gold }
 *   name  = App.Leaderboard.getPlayerName() || 'Anonym'   (max 18 Zeichen)
 *   text  = getrimmt, max 300 Zeichen, leere werden nicht gesendet
 *   ts    = Date.now()   (in diesem Projekt erlaubt)
 *   gold  = true, wenn der Spieler Maximal-Level hat  -> goldener Name
 */
(function () {
  'use strict';
  window.App = window.App || {};

  var UI = App.UI, el = UI.el;

  var PATH = 'scores/__groupchat';   // in den Firebase-Regeln freigegebener Unterknoten
  var MAX = 100;                     // so viele Nachrichten halten/anzeigen wir
  var MAX_NAME = 18;
  var MAX_TEXT = 300;
  var LS_KEY = 'gj_groupchat';       // lokaler Rückfall-Speicher
  var BC_NAME = 'gj_groupchat';      // Kanal für Tab-zu-Tab im selben Browser

  var messages = [];        // [{ id, name, text, ts, gold }] — chronologisch (älteste zuerst)
  var listeners = [];       // Abonnenten der Ansicht
  var driver = null;        // aktives Backend: { kind, send(msg), stop() }
  var mySent = {};          // Signaturen der in dieser Sitzung selbst gesendeten Nachrichten

  function now() { return Date.now(); }
  function sig(m) { return String(m.ts) + '|' + String(m.text); }
  function isMine(m) { return mySent[sig(m)] === true; }

  function emit() {
    listeners.slice().forEach(function (cb) { try { cb(); } catch (e) {} });
  }
  function onChange(cb) {
    listeners.push(cb);
    return function () { var i = listeners.indexOf(cb); if (i >= 0) listeners.splice(i, 1); };
  }

  /* Rohdaten (Objekt aus Firebase ODER Array aus localStorage) in eine sortierte,
   * begrenzte Nachrichtenliste normalisieren. */
  function normalize(raw) {
    var arr;
    if (Array.isArray(raw)) {
      arr = raw.slice();
    } else if (raw && typeof raw === 'object') {
      arr = Object.keys(raw).map(function (k) {
        var m = raw[k] || {};
        return { id: k, name: m.name, text: m.text, ts: Number(m.ts) || 0, gold: !!m.gold, nc: m.nc, nf: m.nf, lv: m.lv };
      });
    } else {
      arr = [];
    }
    arr.sort(function (a, b) {
      return (a.ts - b.ts) || (String(a.id) < String(b.id) ? -1 : (String(a.id) > String(b.id) ? 1 : 0));
    });
    return arr.slice(-MAX);
  }

  /* ================= Backends ================= */

  function initDriver() {
    if (App.Net && App.Net.firebaseConfigured && App.Net.firebaseConfigured()) {
      var p;
      try { p = App.Net.firebaseDb(); } catch (e) { p = null; }
      if (p && typeof p.then === 'function') {
        p.then(function (db) { startFirebase(db); })
         .catch(function () { startLocal(); });
        return;
      }
    }
    startLocal();
  }

  function startFirebase(db) {
    if (driver && driver.kind === 'firebase') return;
    var query = db.ref(PATH).limitToLast(MAX);
    var handler = query.on('value', function (snap) {
      messages = normalize(snap.val() || {});
      emit();
    }, function () {
      // z. B. Regeln nicht (mehr) freigegeben -> sauber lokal weitermachen.
      try { query.off('value', handler); } catch (e) {}
      startLocal();
    });
    driver = {
      kind: 'firebase',
      send: function (msg) { try { db.ref(PATH).push(msg); } catch (e) {} },
      stop: function () { try { query.off('value', handler); } catch (e) {} }
    };
    emit();
  }

  function lsLoad() {
    if (App.Storage && App.Storage.get) {
      var v = App.Storage.get(LS_KEY, []);
      return Array.isArray(v) ? v : [];
    }
    try {
      var raw = window.localStorage.getItem(LS_KEY);
      var arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch (e) { return []; }
  }
  function lsSave(arr) {
    if (App.Storage && App.Storage.set) { App.Storage.set(LS_KEY, arr); return; }
    try { window.localStorage.setItem(LS_KEY, JSON.stringify(arr)); } catch (e) {}
  }

  function startLocal() {
    if (driver && driver.kind === 'local') return;
    if (driver && driver.stop) { try { driver.stop(); } catch (e) {} }

    var bc = null;
    try { if (window.BroadcastChannel) bc = new BroadcastChannel(BC_NAME); } catch (e) { bc = null; }

    function refresh() { messages = normalize(lsLoad()); emit(); }

    if (bc) bc.onmessage = function () { refresh(); };
    // storage-Event feuert nur in ANDEREN Tabs — genau richtig für Tab-zu-Tab.
    var onStorage = function () { refresh(); };
    window.addEventListener('storage', onStorage);
    // Letztes Sicherheitsnetz, falls weder BroadcastChannel noch storage-Event greifen.
    var poll = setInterval(refresh, 2000);

    driver = {
      kind: 'local',
      send: function (msg) {
        var arr = lsLoad();
        arr.push({ id: msg.ts + '_' + Math.random().toString(36).slice(2, 8), name: msg.name, text: msg.text, ts: msg.ts, gold: msg.gold, nc: msg.nc, nf: msg.nf, lv: msg.lv });
        if (arr.length > MAX) arr = arr.slice(-MAX);
        lsSave(arr);
        if (bc) { try { bc.postMessage({ t: 'msg' }); } catch (e) {} }
        refresh();
      },
      stop: function () {
        clearInterval(poll);
        window.removeEventListener('storage', onStorage);
        if (bc) { try { bc.close(); } catch (e) {} }
      }
    };
    refresh();
  }

  /* ================= Senden ================= */

  function sendMessage(text) {
    text = String(text == null ? '' : text).trim();
    if (!text) return false;
    if (text.length > MAX_TEXT) text = text.slice(0, MAX_TEXT);
    if (!driver) { if (UI.toast) UI.toast('Chat verbindet noch …', 'info'); return false; }

    var name = (App.Leaderboard && App.Leaderboard.getPlayerName && App.Leaderboard.getPlayerName()) || 'Anonym';
    name = String(name).slice(0, MAX_NAME) || 'Anonym';
    var gold = !!(App.Progress && App.Progress.isMaxLevel && App.Progress.isMaxLevel());

    var myc = (App.ProfileCard && App.ProfileCard.myNameCos) ? App.ProfileCard.myNameCos() : {};
    var myLv = (App.Progress && App.Progress.level) ? App.Progress.level() : 1;
    var msg = { name: name, text: text, ts: now(), gold: gold, nc: myc.nameColor || 'default', nf: myc.nameFont || 'default', lv: myLv };
    mySent[sig(msg)] = true;   // eigene Nachricht später optisch abheben
    driver.send(msg);
    return true;
  }

  /* ================= Ansicht ================= */

  function fmtTime(ts) {
    var d = new Date(Number(ts) || 0);
    try {
      return d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
    } catch (e) {
      var p = function (n) { return (n < 10 ? '0' : '') + n; };
      return p(d.getHours()) + ':' + p(d.getMinutes());
    }
  }

  function backendLabel() {
    if (!driver) return { txt: 'Verbinde …', cls: '' };
    if (driver.kind === 'firebase') return { txt: '🟢 Live · alle Spieler', cls: 'online' };
    return { txt: '🟡 Nur dieser Browser (offline)', cls: 'offline' };
  }

  function renderPage(root) {
    injectCss();

    var list = el('div', { class: 'chat-list' });
    var input = el('input', {
      class: 'chat-input', type: 'text', maxlength: String(MAX_TEXT),
      placeholder: 'Nachricht an alle …', autocomplete: 'off'
    });
    var sendBtn = el('button', { class: 'btn btn-primary chat-send', type: 'button' }, ['Senden']);
    var count = el('span', { class: 'chat-count' }, ['']);
    var status = el('div', { class: 'chat-status' }, ['Verbinde …']);

    var card = el('div', { class: 'glass chat-card' }, [
      el('div', { class: 'chat-card-head' }, [
        el('span', { class: 'chat-card-t' }, ['🌴 Gruppenchat']),
        count
      ]),
      list,
      el('div', { class: 'chat-input-row' }, [input, sendBtn])
    ]);

    var wrap = el('div', { class: 'chat-page' }, [
      el('div', { class: 'page-head' }, [
        el('button', { class: 'btn btn-ghost back', type: 'button', onclick: function () { App.Router.go('/'); } }, ['← Menü']),
        el('h2', { class: 'page-title chat-title' }, ['💬 Chat'])
      ]),
      status,
      card
    ]);
    root.appendChild(wrap);

    var drawn = false;
    function nearBottom() { return (list.scrollHeight - list.scrollTop - list.clientHeight) < 60; }

    function rowFor(m) {
      var name = el('span', { class: 'chat-name' + (m.gold ? ' name-gold' : '') });
      name.textContent = m.name || 'Anonym';           // textContent -> kein XSS
      // Namensfarbe + Schriftart des Absenders (kommt mit der Nachricht mit).
      if (App.ProfileCard && App.ProfileCard.styleName) App.ProfileCard.styleName(name, { nameColor: m.nc, nameFont: m.nf }, m.lv || 1, m.gold);
      var text = el('div', { class: 'chat-text' });
      text.textContent = m.text || '';                 // textContent -> kein XSS
      return el('div', { class: 'chat-row' + (isMine(m) ? ' mine' : '') }, [
        el('div', { class: 'chat-bubble' }, [
          el('div', { class: 'chat-meta' }, [name, el('span', { class: 'chat-time' }, [fmtTime(m.ts)])]),
          text
        ])
      ]);
    }

    function draw() {
      var stick = !drawn || nearBottom();
      list.innerHTML = '';
      if (!messages.length) {
        list.appendChild(el('div', { class: 'chat-empty' }, ['Noch keine Nachrichten — schreib die erste! 🌴']));
      } else {
        messages.forEach(function (m) { list.appendChild(rowFor(m)); });
      }
      count.textContent = messages.length
        ? (messages.length >= MAX ? MAX + '+ Nachrichten' : messages.length + (messages.length === 1 ? ' Nachricht' : ' Nachrichten'))
        : '';
      var b = backendLabel();
      status.textContent = b.txt;
      status.className = 'chat-status' + (b.cls ? ' ' + b.cls : '');
      drawn = true;
      if (stick) list.scrollTop = list.scrollHeight;
    }

    function submit() {
      if (sendMessage(input.value)) { input.value = ''; }
      input.focus();
    }
    sendBtn.addEventListener('click', submit);
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
    });

    var off = onChange(draw);
    draw();

    // cleanup: Ansicht-Abo lösen (das geteilte Backend läuft für boot() weiter).
    return function cleanup() { off(); };
  }

  /* ================= CSS ================= */
  function injectCss() {
    UI.injectStyle('chat-css', [
      '.chat-page{display:flex;flex-direction:column;gap:14px;max-width:820px;margin:0 auto;}',
      '.chat-title{color:var(--neon,#39ff14);text-shadow:0 0 10px rgba(57,255,20,.5);}',
      '.chat-status{font-size:12px;font-weight:800;letter-spacing:.4px;color:var(--muted,#8aa);text-align:center;}',
      '.chat-status.online{color:var(--neon,#39ff14);text-shadow:0 0 8px rgba(57,255,20,.4);}',
      '.chat-status.offline{color:var(--gold,#ffd23f);}',
      '.chat-card{display:flex;flex-direction:column;gap:0;padding:0;overflow:hidden;',
      'border-color:rgba(57,255,20,.28);}',
      '.chat-card-head{display:flex;align-items:center;justify-content:space-between;gap:10px;',
      'padding:12px 16px;border-bottom:1px solid rgba(255,255,255,.08);',
      'background:linear-gradient(90deg,rgba(57,255,20,.10),transparent);}',
      '.chat-card-t{font-weight:900;font-size:15px;color:#eafff0;}',
      '.chat-count{font-size:11px;font-weight:800;color:var(--muted,#8aa);font-variant-numeric:tabular-nums;}',
      // Nachrichtenliste (scrollbar, neueste unten)
      '.chat-list{display:flex;flex-direction:column;gap:8px;padding:16px;overflow-y:auto;',
      'height:min(56vh,460px);scroll-behavior:smooth;}',
      '.chat-list::-webkit-scrollbar{width:8px;}',
      '.chat-list::-webkit-scrollbar-thumb{background:rgba(57,255,20,.25);border-radius:99px;}',
      '.chat-empty{margin:auto;color:var(--muted,#8aa);font-size:13px;text-align:center;}',
      // eine Nachricht
      '.chat-row{display:flex;max-width:100%;}',
      '.chat-row.mine{justify-content:flex-end;}',
      '.chat-bubble{max-width:78%;min-width:0;padding:8px 12px;border-radius:14px;',
      'background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.08);}',
      '.chat-row.mine .chat-bubble{background:linear-gradient(180deg,rgba(57,255,20,.16),rgba(57,255,20,.07));',
      'border-color:rgba(57,255,20,.4);}',
      '.chat-meta{display:flex;align-items:baseline;gap:8px;margin-bottom:2px;}',
      '.chat-name{font-weight:900;font-size:12px;color:#bfeacb;overflow:hidden;text-overflow:ellipsis;',
      'white-space:nowrap;max-width:180px;}',
      '.chat-row.mine .chat-name{color:var(--neon,#39ff14);}',
      '.chat-time{font-size:10px;color:var(--muted,#8aa);font-variant-numeric:tabular-nums;flex:0 0 auto;}',
      '.chat-text{font-size:13.5px;line-height:1.45;color:#eef7f0;word-break:break-word;overflow-wrap:anywhere;',
      'white-space:pre-wrap;}',
      // Eingabezeile
      '.chat-input-row{display:flex;gap:8px;padding:12px 16px;border-top:1px solid rgba(255,255,255,.08);',
      'background:rgba(0,0,0,.18);}',
      '.chat-input{flex:1;min-width:0;background:rgba(0,0,0,.35);border:1px solid rgba(255,255,255,.14);',
      'border-radius:12px;padding:10px 14px;color:#fff;font-size:14px;outline:none;transition:border-color .15s;}',
      '.chat-input:focus{border-color:var(--neon,#39ff14);box-shadow:0 0 0 2px rgba(57,255,20,.18);}',
      '.chat-input::placeholder{color:var(--muted,#7a9);}',
      '.chat-send{flex:0 0 auto;}',
      '@media(max-width:520px){.chat-bubble{max-width:86%;}.chat-list{height:min(52vh,420px);}}'
    ].join(''));
  }

  /* ================= API + Boot ================= */
  App.Chat = {
    /** Aktives Backend: 'firebase' | 'local' | 'none'. */
    backendKind: function () { return driver ? driver.kind : 'none'; },
    /** Aktuelle (chronologische) Nachrichtenliste — Kopie. */
    getMessages: function () { return messages.slice(); },
    /** Text an alle senden (getrimmt, max 300 Zeichen). true = gesendet. */
    send: sendMessage,
    /** Auf Änderungen der Nachrichtenliste hören; gibt Abmelde-Funktion zurück. */
    onChange: onChange,
    /** Chat-Ansicht in root rendern; gibt cleanup()-Funktion zurück. */
    renderPage: renderPage,
    /** Live-Verbindung starten (idempotent; läuft auch via boot() automatisch). */
    boot: function () { if (!driver) initDriver(); }
  };

  function boot() { if (!driver) initDriver(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
