/* version.js — erzwingt ein Neuladen, wenn dieser Tab nicht mehr die neueste
 * Version der Website ist.
 *
 * Warum: Admin-Änderungen (Chancen/Bann/Nachrichten, siehe js/admin.js) und
 * Bugfixes wirken nur mit aktuellem Code. Ohne diesen Hinweis könnten Spieler
 * unbemerkt mit einer alten, gecachten Version weiterspielen.
 *
 * Wichtig beim Deployen: window.APP_VERSION hier UND version.json IMMER
 * gemeinsam auf einen neuen Wert setzen (z. B. das Datum des Release).
 */
(function () {
  'use strict';
  window.App = window.App || {};

  window.APP_VERSION = '2026-07-15.4';

  var CHECK_MS = 25000;
  var blocked = false;

  function showOverlay() {
    if (blocked) return;
    blocked = true;
    var overlay;
    if (App.UI && App.UI.el) {
      var el = App.UI.el;
      overlay = el('div', { class: 'modal-overlay version-overlay' }, [
        el('div', { class: 'modal glass' }, [
          el('div', { class: 'modal-leaf' }, ['🔄']),
          el('h2', { class: 'neon' }, ['Neue Version verfügbar']),
          el('p', {}, ['Die Website wurde aktualisiert. Bitte lade neu, um weiterzuspielen.']),
          el('button', { class: 'btn btn-primary btn-lg', type: 'button', onclick: function () { location.reload(); } }, ['🔄 Seite neu laden'])
        ])
      ]);
    } else {
      overlay = document.createElement('div');
      overlay.className = 'modal-overlay version-overlay';
      overlay.innerHTML = '<div class="modal glass"><div class="modal-leaf">🔄</div>'
        + '<h2 class="neon">Neue Version verfügbar</h2>'
        + '<p>Die Website wurde aktualisiert. Bitte lade neu, um weiterzuspielen.</p>'
        + '<button class="btn btn-primary btn-lg" type="button">🔄 Seite neu laden</button></div>';
      overlay.querySelector('button').addEventListener('click', function () { location.reload(); });
    }
    document.body.appendChild(overlay);
  }

  function check() {
    if (blocked) return;
    fetch('version.json?_=' + Date.now(), { cache: 'no-store' })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (data) {
        if (data && data.version && data.version !== window.APP_VERSION) showOverlay();
      })
      .catch(function () {});
  }

  function boot() {
    setTimeout(check, 1500);
    setInterval(check, CHECK_MS);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
