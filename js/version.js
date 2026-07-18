/* version.js — meldet dezent, wenn die Seite aktualisiert wurde, und lädt auf
 * Wunsch WIRKLICH neu.
 *
 * Zwei Fallen, die dieses Modul früher hatte (und jetzt umgeht):
 *  1) GitHub Pages cached JS/CSS bis zu ~10 Minuten. Ein gewöhnliches
 *     location.reload() lieferte deshalb oft weiter das ALTE Skript -> die
 *     Version blieb alt -> die Meldung kam sofort wieder. Wer einmal auf
 *     „neu laden" klickte, musste es endlos wiederholen. Fix: hardReload()
 *     holt die eigenen Skripte/Styles vorher hart aus dem Netz
 *     (fetch cache:'reload' aktualisiert den HTTP-Cache) und lädt ERST DANN
 *     neu -> garantiert der neue Code.
 *  2) Ein bildschirmfüllendes, blockierendes Fenster, das man nicht schließen
 *     konnte. Jetzt ein kleines, wegklickbares Banner unten.
 *
 * Zusätzlich: pro Zielversion wird höchstens EINMAL genervt (sessionStorage-
 * Merker) — hängt der Cache trotz Reload noch, kommt die Meldung nicht im
 * Sekundentakt wieder.
 *
 * Wichtig beim Deployen: window.APP_VERSION hier UND version.json IMMER
 * gemeinsam auf einen neuen Wert setzen (z. B. das Datum des Release).
 */
(function () {
  'use strict';
  window.App = window.App || {};

  window.APP_VERSION = '2026-07-18.10';

  var CHECK_MS = 60000;              // seltener prüfen (vorher 25s)
  var SEEN_KEY = 'gj_reloaded_for';  // welche Zielversion haben wir schon versucht?
  var barVisible = false;            // liegt gerade ein Banner im DOM?

  function alreadyTried(v) {
    try { return sessionStorage.getItem(SEEN_KEY) === v; } catch (e) { return false; }
  }
  function markTried(v) {
    try { sessionStorage.setItem(SEEN_KEY, v); } catch (e) {}
  }

  function injectCss() {
    if (document.getElementById('gj-version-css')) return;
    var s = document.createElement('style');
    s.id = 'gj-version-css';
    s.textContent = [
      '.gj-update-bar{position:fixed;left:50%;bottom:18px;transform:translate(-50%,140%);',
        'z-index:99999;display:flex;align-items:center;gap:12px;max-width:calc(100vw - 24px);',
        'padding:11px 14px;border-radius:14px;background:rgba(8,26,18,.94);',
        'border:1px solid var(--neon,#39ff14);box-shadow:0 10px 34px rgba(0,0,0,.55),0 0 18px rgba(57,255,20,.35);',
        'color:var(--text,#eafff0);font-weight:700;transition:transform .35s cubic-bezier(.2,.9,.3,1.15);',
        '-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px);}',
      '.gj-update-bar.show{transform:translate(-50%,0);}',
      '.gj-update-bar .u-t{font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      '.gj-update-bar .u-r{background:linear-gradient(90deg,var(--aqua,#00e5c0),var(--neon,#39ff14));',
        'color:#04170e;border:none;border-radius:10px;padding:8px 14px;font-weight:900;cursor:pointer;',
        'font-size:14px;white-space:nowrap;}',
      '.gj-update-bar .u-r:disabled{opacity:.7;cursor:default;}',
      '.gj-update-bar .u-x{background:transparent;border:none;color:var(--muted,#9fb0a6);font-size:18px;',
        'cursor:pointer;line-height:1;padding:2px 6px;}'
    ].join('');
    (document.head || document.documentElement).appendChild(s);
  }

  function showBar(target) {
    if (barVisible) return;
    barVisible = true;
    injectCss();

    var bar = document.createElement('div');
    bar.className = 'gj-update-bar';
    bar.setAttribute('role', 'status');

    var txt = document.createElement('span');
    txt.className = 'u-t';
    txt.textContent = '🔄 Neue Version verfügbar';

    var btn = document.createElement('button');
    btn.className = 'u-r'; btn.type = 'button';
    btn.textContent = '🔄 Jetzt neu laden';
    btn.addEventListener('click', function () {
      btn.disabled = true; btn.textContent = 'Lädt …';
      hardReload(target);
    });

    var x = document.createElement('button');
    x.className = 'u-x'; x.type = 'button'; x.title = 'Später';
    x.textContent = '✕';
    x.addEventListener('click', function () {
      markTried(target);   // diese Version in dieser Sitzung nicht mehr melden
      remove();
    });

    function remove() { barVisible = false; if (bar.parentNode) bar.parentNode.removeChild(bar); }

    bar.appendChild(txt); bar.appendChild(btn); bar.appendChild(x);
    (document.body || document.documentElement).appendChild(bar);
    setTimeout(function () { bar.classList.add('show'); }, 30);
  }

  /* Echtes Neuladen trotz GitHub-Pages-Cache: erst die eigenen (same-origin)
   * Skripte/Styles hart aus dem Netz nachladen (cache:'reload' überschreibt den
   * HTTP-Cache), dann location.reload() — das liest dann die frischen Dateien. */
  function hardReload(target) {
    markTried(target);   // egal wie es ausgeht: nicht sofort wieder nerven
    var urls = [];
    try {
      var nodes = document.querySelectorAll('script[src], link[rel="stylesheet"][href]');
      for (var i = 0; i < nodes.length; i++) {
        var u = nodes[i].src || nodes[i].href;
        if (u && u.indexOf(location.origin) === 0) urls.push(u);
      }
    } catch (e) {}
    urls.push(location.href.split('#')[0]);   // auch das Dokument selbst

    var done = false;
    function go() { if (done) return; done = true; location.reload(); }
    try {
      Promise.all(urls.map(function (u) {
        return fetch(u, { cache: 'reload' }).catch(function () {});
      })).then(go, go);
    } catch (e) { go(); }
    setTimeout(go, 4000);   // Sicherheitsnetz, falls ein Request hängt
  }

  function check() {
    fetch('version.json?_=' + Date.now(), { cache: 'no-store' })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (data) {
        if (!data || !data.version) return;
        if (data.version === window.APP_VERSION) return;   // aktuell -> nichts tun
        if (alreadyTried(data.version)) return;            // schon versucht -> nicht weiter nerven
        showBar(data.version);
      })
      .catch(function () {});
  }

  function boot() {
    setTimeout(check, 2000);
    setInterval(check, CHECK_MS);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
