/* units-catalog.js — Übersicht ALLER Zahlen-Einheiten in Reihenfolge.
 * Zeigt Schritt für Schritt, welches Kürzel nach welchem kommt (K, M, B … Sx,
 * dx … SKD … und darüber hinaus, endlos generiert). Jede Einheit ist 1000× die
 * vorige. So sieht man genau, was als Nächstes kommt, wenn die Zahlen wachsen.
 */
(function () {
  'use strict';
  window.App = window.App || {};
  var UI = App.UI, el = UI.el;

  var COUNT = 120;   // erste 120 Einheiten zeigen (bis ~10^363, weit über allem Erreichbaren)
  // Deutsche Namen für die ersten Stufen (lange Skala).
  var LONG_NAMES = {
    3: 'Tausend', 6: 'Million', 9: 'Milliarde', 12: 'Billion', 15: 'Billiarde',
    18: 'Trillion', 21: 'Trilliarde', 24: 'Quadrillion', 27: 'Quadrilliarde',
    30: 'Quintillion', 33: 'Quintilliarde', 36: 'Sextillion'
  };

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
      '.uc-exp{font-size:12px;color:var(--leaf);font-variant-numeric:tabular-nums;}',
      '.uc-name{font-size:11px;color:var(--muted);}'
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
      'Jede Einheit ist 1000× so groß wie die davor. Hier siehst du, was nach was kommt — ' +
      'von K (Tausend) bis weit jenseits von SKD. Über 10³⁰⁰ hinaus werden die Kürzel automatisch endlos weiter erzeugt.'
    ]));

    var namedCount = 0;
    var cells = [];
    for (var i = 0; i < COUNT; i++) {
      var suf = UI.unitSuffix(i);
      var exp = 3 * (i + 1);
      // "benannt" = Teil der handkuratierten Liste (die ersten Einheiten); danach generiert.
      var isNamed = suf.length >= 2 ? /[A-ZÄÖ]/.test(suf) : true;
      var name = LONG_NAMES[exp] || '';
      cells.push(el('div', { class: 'uc-cell' + (name ? ' named' : '') }, [
        el('div', { class: 'uc-top' }, [
          el('span', { class: 'uc-idx' }, ['#' + (i + 1)]),
          el('span', { class: 'uc-suf' }, [suf])
        ]),
        el('span', { class: 'uc-exp' }, ['= 10^' + exp]),
        name ? el('span', { class: 'uc-name' }, [name]) : null
      ]));
    }
    page.appendChild(el('div', { class: 'uc-grid' }, cells));
    page.appendChild(el('p', { class: 'uc-intro' }, ['… und immer weiter, ohne Ende.']));
  }

  App.UnitsCatalog = { renderPage: renderPage };
})();
