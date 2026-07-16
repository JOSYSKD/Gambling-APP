/* ideas.js — Spielideen-Briefkasten (App.Ideas).
 *
 * Jeder Spieler kann oben in der Leiste über den 💡-Knopf eine Spielidee
 * eintippen. Die Idee wird als Nachricht an den Admin geschickt und taucht im
 * Admin-Panel (js/admin.js) in der Liste „Spielideen" auf, wo der Admin sie
 * abhaken oder löschen kann.
 *
 * Speicherort: der bereits offene, in Firebase veröffentlichte Knoten `scores`
 * (Unterschlüssel `scores/__ideas`) — genau wie survival.js seinen Board dort
 * ablegt. So braucht dieses Feature KEINEN neuen Firebase-Regel-Deploy (ein
 * eigener `ideas`-Knoten wäre per Default gesperrt und müsste erst publiziert
 * werden). scores.js liest nur `scores/<spielId>`; der doppelte Unterstrich in
 * `__ideas` kollidiert also mit keiner Spiel-Bestenliste.
 *
 * Ohne Firebase (file:// / nur lokal) läuft alles über den lokalen Fallback-
 * Speicher von App.Net.store() — dann sieht der Admin nur die Ideen desselben
 * Geräts, was für einen Offline-Test genügt.
 */
(function () {
  'use strict';
  window.App = window.App || {};

  var PATH = 'scores/__ideas';
  var MAX_LEN = 400;

  function store() { return App.Net.store(); }

  function deviceId() { return App.Storage.get('gj_device_id', null) || 'anon'; }
  function myName() {
    return (App.Leaderboard && App.Leaderboard.getPlayerName && App.Leaderboard.getPlayerName()) || 'Gast';
  }
  function newId() { return 'i' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

  /** Eine Spielidee an den Admin schicken. Gibt ein Promise zurück. */
  function submit(text) {
    text = String(text || '').trim().slice(0, MAX_LEN);
    if (!text) return Promise.reject(new Error('leer'));
    var id = newId();
    var idea = { id: id, name: myName(), pid: deviceId(), text: text, at: Date.now(), done: false };
    var patch = {}; patch[id] = idea;
    return store().then(function (b) { return b.update(PATH, patch); });
  }

  /** Alle Ideen lesen (neueste zuerst). Für das Admin-Panel. */
  function list() {
    return store().then(function (b) { return b.get(PATH); }).then(function (o) {
      o = o || {};
      return Object.keys(o).map(function (k) { return Object.assign({ id: k }, o[k]); })
        .sort(function (a, b) { return (b.at || 0) - (a.at || 0); });
    }).catch(function () { return []; });
  }

  function remove(id) { return store().then(function (b) { return b.remove(PATH + '/' + id); }); }
  function setDone(id, done) { return store().then(function (b) { return b.update(PATH + '/' + id, { done: !!done }); }); }

  /* ---------------- Oberfläche: 💡-Knopf in der Topnav + Eingabe-Panel ---------------- */
  function injectCss() {
    if (!App.UI || !App.UI.injectStyle) return;
    App.UI.injectStyle('idea-css', [
      '.idea-btn{cursor:pointer;color:inherit;background:rgba(6,26,17,0.6);}',
      '.idea-panel{display:flex;flex-direction:column;gap:12px;max-width:520px;width:100%;text-align:left;}',
      '.idea-intro{opacity:.82;font-size:14px;margin:0;}',
      '.idea-ta{width:100%;box-sizing:border-box;resize:vertical;min-height:120px;font-size:15px;padding:12px 14px;',
      'border-radius:12px;border:1px solid var(--stroke);background:rgba(2,10,6,.6);color:#eaffe2;font-family:inherit;line-height:1.4;}',
      '.idea-ta:focus{outline:none;border-color:var(--neon);box-shadow:0 0 10px rgba(57,255,20,.4);}',
      '.idea-count{font-size:12px;opacity:.6;text-align:right;margin-top:-4px;}'
    ].join(''));
  }

  function openPanel() {
    injectCss();
    var el = App.UI.el;
    var ta = el('textarea', {
      class: 'idea-ta', rows: 5, maxlength: MAX_LEN,
      placeholder: 'Welches Spiel wünschst du dir? Beschreib deine Idee …'
    });
    var counter = el('div', { class: 'idea-count' }, ['0 / ' + MAX_LEN]);
    ta.addEventListener('input', function () { counter.textContent = ta.value.length + ' / ' + MAX_LEN; });

    var sendBtn = el('button', { class: 'btn btn-primary btn-lg', type: 'button' }, ['💡 Idee abschicken']);
    var overlay = el('div', { class: 'modal-overlay' }, [
      el('div', { class: 'modal glass', style: 'max-width:540px;width:92%;' }, [
        el('div', { class: 'modal-leaf' }, ['💡']),
        el('h2', { class: 'neon' }, ['Spielidee vorschlagen']),
        el('p', { class: 'idea-intro' }, ['Schreib dem Admin, welches Spiel du dir wünschst oder was verbessert werden soll. Er sieht alle Ideen im Admin-Panel.']),
        el('div', { class: 'idea-panel' }, [ta, counter]),
        sendBtn,
        el('button', { class: 'btn btn-ghost', type: 'button', onclick: close }, ['Schließen'])
      ])
    ]);
    function close() { if (overlay.parentNode) document.body.removeChild(overlay); }
    overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });
    sendBtn.addEventListener('click', function () {
      var text = ta.value.trim();
      if (!text) {
        ta.focus();
        if (App.UI.toast) App.UI.toast('Bitte schreib zuerst deine Idee.', 'lose');
        return;
      }
      sendBtn.disabled = true;
      submit(text).then(function () {
        if (App.UI.toast) App.UI.toast('💡 Danke! Deine Idee ging an den Admin.', 'win');
        if (App.Audio && App.Audio.sfx) { try { App.Audio.sfx('powerup'); } catch (e) {} }
        close();
      }).catch(function () {
        sendBtn.disabled = false;
        if (App.UI.toast) App.UI.toast('Konnte gerade nicht senden — bitte nochmal versuchen.', 'lose');
      });
    });
    document.body.appendChild(overlay);
    setTimeout(function () { ta.focus(); }, 50);
  }

  var placed = false;
  function renderChip() {
    if (placed) return;
    var nav = document.querySelector('.topnav');
    if (!nav || !App.UI || !App.UI.el) return;
    injectCss();
    var btn = App.UI.el('button', {
      class: 'topnav-link idea-btn', type: 'button',
      title: 'Spielidee an den Admin schicken', onclick: openPanel
    }, ['💡']);
    nav.insertBefore(btn, nav.firstChild);   // ganz vorne in der Leiste
    placed = true;
  }

  App.Ideas = {
    submit: submit,
    list: list,
    remove: remove,
    setDone: setDone,
    openPanel: openPanel,
    renderChip: renderChip,
    PATH: PATH
  };

  function boot() { renderChip(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
