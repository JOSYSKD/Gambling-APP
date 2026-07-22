/* units-catalog.js — Übersicht ALLER Zahlen-Einheiten in Reihenfolge.
 * Zeigt Schritt für Schritt, welches Kürzel nach welchem kommt. Jede Einheit ist
 * 60 Nullen (10^60×) größer als die vorige — K=10^60, M=10^120, B=10^180 … So
 * sieht man genau, was als Nächstes kommt, wenn die Zahlen wachsen.
 */
(function () {
  'use strict';
  window.App = window.App || {};
  var UI = App.UI, el = UI.el;

  var STEP = 60;     // Nullen pro Stufe (muss zu ui.js UNIT_STEP passen)
  var COUNT = 100;   // erste 100 Einheiten zeigen

  function injectCss() {
    UI.injectStyle('units-catalog-css', [
      '.uc-page{display:flex;flex-direction:column;gap:14px;max-width:680px;margin:0 auto;}',
      '.uc-intro{color:var(--muted);font-size:13px;line-height:1.5;text-align:center;margin:0;}',
      '.uc-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px;}',
      '.uc-cell{display:flex;flex-direction:column;gap:2px;padding:10px 12px;border-radius:11px;background:rgba(0,0,0,.22);border:1px solid var(--stroke);}',
      '.uc-cell.named{border-color:rgba(57,255,20,.35);background:rgba(57,255,20,.05);}',
      '.uc-top{display:flex;align-items:baseline;gap:8px;}',
      '.uc-idx{font-size:11px;color:var(--muted);font-variant-numeric:tabular-nums;min-width:22px;}',
      '.uc-suf{font-size:20px;font-weight:900;color:var(--gold);}',
      '.uc-exp{font-size:12px;color:var(--leaf);font-variant-numeric:tabular-nums;}'
    ].join(''));
  }

  function renderPage(root) {
    injectCss();
    var page = el('div', { class: 'uc-page' });
    root.appendChild(page);

    page.appendChild(el('div', { class: 'page-head' }, [
      el('button', { class: 'btn btn-ghost back', type: 'button', onclick: function () { App.Router.go('/'); } }, ['← Menü']),
      el('h2', { class: 'page-title neon' }, ['🔢 Einheiten'])
    ]));
    page.appendChild(el('p', { class: 'uc-intro' }, [
      'Jede Einheit ist 60 Nullen (10⁶⁰×) größer als die davor. Erst ab 10⁶⁰ bekommt eine Zahl ' +
      'überhaupt ein Kürzel — darunter wird sie voll ausgeschrieben. Hier siehst du, was nach was kommt.'
    ]));

    var cells = [];
    for (var i = 0; i < COUNT; i++) {
      var suf = UI.unitSuffix(i);
      var exp = STEP * (i + 1);
      // "benannt" = Teil der handkuratierten Liste (enthält Großbuchstaben/Umlaut); rein generierte
      // Kürzel (aa, ab, …) sind nur Kleinbuchstaben.
      var isNamed = /[A-ZÄÖ]/.test(suf);
      cells.push(el('div', { class: 'uc-cell' + (isNamed ? ' named' : '') }, [
        el('div', { class: 'uc-top' }, [
          el('span', { class: 'uc-idx' }, ['#' + (i + 1)]),
          el('span', { class: 'uc-suf' }, [suf])
        ]),
        el('span', { class: 'uc-exp' }, ['= 10^' + exp])
      ]));
    }
    page.appendChild(el('div', { class: 'uc-grid' }, cells));
    page.appendChild(el('p', { class: 'uc-intro' }, ['… und immer weiter, ohne Ende.']));
  }

  App.UnitsCatalog = { renderPage: renderPage };
})();
