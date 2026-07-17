/* ui.js — gemeinsame UI-Helfer für alle Spiele. */
(function () {
  'use strict';
  window.App = window.App || {};

  /** Volle, ausgeschriebene Zahl (1.234.567) — nur noch für Sonderfälle, in denen
   *  der exakte Betrag zählt. Die normale Coin-Anzeige (formatCoins) kürzt ab. */
  function formatFull(n) {
    n = Math.round(Number(n) || 0);
    return n.toLocaleString('de-DE');
  }

  /** Coin-/Zahl-Anzeige der GESAMTEN App: kürzt große Zahlen ab (1.234 -> "1,23K",
   *  … bis "Sx" = 10^21), damit auch riesige Beträge auf der Bestenliste, im
   *  Guthaben, in Quests usw. überall kompakt und lesbar bleiben. Zahlen < 1000
   *  bleiben exakt. (Früher: volle Zahl — auf Wunsch überall auf Kurzform umgestellt.) */
  function formatCoins(n) {
    return formatShort(n);
  }

  /** Große Zahlen abgekürzt: 1.234 -> "1,23K", 2.500.000 -> "2,5M", … bis "Sx" (10^21).
   *  Über der Billion (T) geht es weiter in der englischen Kurzskala, damit auch die
   *  Risiko-Mega-Quests (bis 10^21) noch lesbar bleiben: Qa=10^15, Qi=10^18, Sx=10^21. */
  var SHORT_UNITS = [
    { v: 1e21, s: 'Sx' }, { v: 1e18, s: 'Qi' }, { v: 1e15, s: 'Qa' },
    { v: 1e12, s: 'T' }, { v: 1e9, s: 'B' }, { v: 1e6, s: 'M' }, { v: 1e3, s: 'K' }
  ];
  function formatShort(n) {
    n = Number(n) || 0;
    var sign = n < 0 ? '-' : '';
    n = Math.abs(n);
    if (n < 1000) return sign + Math.round(n).toLocaleString('de-DE');
    for (var i = 0; i < SHORT_UNITS.length; i++) {
      var u = SHORT_UNITS[i];
      if (n >= u.v) {
        var v = n / u.v;
        var txt = (v >= 100 ? Math.round(v) : Math.round(v * 10) / 10).toLocaleString('de-DE');
        return sign + txt + u.s;
      }
    }
    return sign + Math.round(n).toLocaleString('de-DE');
  }

  /** Mini-DOM-Helfer: el('div', {class:'x', onclick:fn}, [kind|'text']) */
  function el(tag, attrs, children) {
    var e = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (k === 'class') e.className = v;
        else if (k === 'html') e.innerHTML = v;
        else if (k === 'text') e.textContent = v;
        else if (k === 'dataset') Object.keys(v).forEach(function (dk) { e.dataset[dk] = v[dk]; });
        else if (k.slice(0, 2) === 'on' && typeof v === 'function') e.addEventListener(k.slice(2), v);
        else if (v !== null && v !== undefined && v !== false) e.setAttribute(k, v === true ? '' : v);
      });
    }
    if (children != null) {
      if (!Array.isArray(children)) children = [children];
      children.forEach(function (c) {
        if (c == null) return;
        e.appendChild(typeof c === 'string' || typeof c === 'number'
          ? document.createTextNode(String(c)) : c);
      });
    }
    return e;
  }

  /** Münz-Symbol der aktiven Währung: Silber im Casino, Gold im Survival-Modus. */
  function coinIcon() { return App.Mode ? App.Mode.coinIcon() : '🪙'; }

  /** Schwebende +X / -X Coin-Animation über dem Bildschirm. */
  function flash(amount, opts) {
    opts = opts || {};
    var layer = document.getElementById('toast-layer');
    if (!layer) return;
    var win = amount > 0;
    var sign = win ? '+' : (amount < 0 ? '−' : '');
    var node = el('div', {
      class: 'flash ' + (win ? 'flash-win' : (amount < 0 ? 'flash-lose' : 'flash-neutral'))
    }, [sign + formatShort(Math.abs(amount)) + ' ' + coinIcon()]);
    if (opts.label) node.title = opts.label;
    layer.appendChild(node);
    setTimeout(function () { node.classList.add('flash-go'); }, 20);
    setTimeout(function () { if (node.parentNode) node.parentNode.removeChild(node); }, 1500);
  }

  /** Kurze Status-Nachricht (Toast) unten mittig. */
  function toast(msg, kind) {
    var layer = document.getElementById('toast-layer');
    if (!layer) return;
    var node = el('div', { class: 'toast toast-' + (kind || 'info'), text: msg });
    layer.appendChild(node);
    setTimeout(function () { node.classList.add('toast-show'); }, 20);
    setTimeout(function () { node.classList.add('toast-hide'); }, 2200);
    setTimeout(function () { if (node.parentNode) node.parentNode.removeChild(node); }, 2700);
  }

  /**
   * Einsatz-Panel mit Schnellbuttons: 10, 50, 100, 500, ½, Max.
   *  ½   = Hälfte des aktuellen Guthabens
   *  Max = gesamtes Guthaben
   * Rückgabe: Steuerobjekt mit getBet()/setBet()/setDisabled().
   */
  function createBetPanel(options) {
    options = options || {};
    var MIN = App.Coins.MIN_BET;

    // Freispiel-Power-Up (siehe powerups.js): die nächste Runde soll mit dem
    // Maximaleinsatz laufen -> Feld direkt auf das ganze Guthaben vorbelegen.
    var freebet = !!(App.Powerups && App.Powerups.freebetArmed && App.Powerups.freebetArmed());
    // Einstellung „Max-Einsatz vorwählen" (siehe settings.js): Feld startet auf
    // dem ganzen Guthaben — greift auch nach einer Pleite (Panel wird neu gebaut).
    var autoMax = !!(App.Settings && App.Settings.autoMaxBet && App.Settings.autoMaxBet());
    var startBet = (freebet || autoMax) ? App.Coins.get() : Math.min(Math.max(MIN, options.initial || 50), Math.max(MIN, App.Coins.get()));

    var input = el('input', {
      class: 'bet-input', type: 'number', min: MIN, step: 10,
      value: startBet,
      inputmode: 'numeric'
    });

    var quick = [10, 50, 100, 500];
    var quickBtns = quick.map(function (v) {
      return el('button', { class: 'chip', type: 'button', onclick: function () { setBet(v); } }, [String(v)]);
    });
    var quarterBtn = el('button', { class: 'chip chip-alt', type: 'button', onclick: function () {
      setBet(Math.floor(App.Coins.get() / 4 / 10) * 10);
    } }, ['¼']);
    var halfBtn = el('button', { class: 'chip chip-alt', type: 'button', onclick: function () {
      setBet(Math.floor(App.Coins.get() / 2 / 10) * 10);
    } }, ['½']);
    var maxBtn = el('button', { class: 'chip chip-alt', type: 'button', onclick: function () {
      setBet(App.Coins.get());
    } }, ['Max']);

    var chips = el('div', { class: 'bet-chips' }, quickBtns.concat([quarterBtn, halfBtn, maxBtn]));

    var label = el('label', { class: 'bet-label' }, ['Einsatz']);
    var inputWrap = el('div', { class: 'bet-input-wrap' }, [
      el('span', { class: 'bet-coin' }, [coinIcon()]), input
    ]);

    var root = el('div', { class: 'bet-panel' }, [label, inputWrap, chips]);

    function clamp(v) {
      v = Math.floor(Number(v) || 0);
      var bal = App.Coins.get();
      if (v > bal) v = bal;
      if (v < MIN) v = MIN;
      return v;
    }
    function setBet(v) {
      input.value = clamp(v);
      if (options.onChange) options.onChange(getBet());
    }
    function getBet() { return clamp(input.value); }

    input.addEventListener('change', function () { setBet(input.value); });
    input.addEventListener('input', function () { if (options.onChange) options.onChange(getBet()); });

    return {
      root: root,
      getBet: getBet,
      setBet: setBet,
      /** Einsatz an aktuelles Guthaben anpassen (z. B. nach Gewinn/Verlust). */
      refresh: function () { if (getBet() > App.Coins.get()) setBet(App.Coins.get()); },
      setDisabled: function (d) {
        input.disabled = !!d;
        [].concat(quickBtns, [halfBtn, maxBtn]).forEach(function (b) { b.disabled = !!d; });
        root.classList.toggle('disabled', !!d);
      }
    };
  }

  /** Standard-Kopf einer Spiel-Ansicht: Titel + kurze Regel-Zeile. */
  function gameHeader(title, subtitle) {
    return el('div', { class: 'game-head' }, [
      el('h2', { class: 'game-title neon' }, [title]),
      subtitle ? el('p', { class: 'game-sub' }, [subtitle]) : null
    ]);
  }

  /** Spielspezifisches CSS einmalig injizieren (idempotent über id). */
  function injectStyle(id, css) {
    if (document.getElementById(id)) return;
    var s = document.createElement('style');
    s.id = id;
    s.textContent = css;
    document.head.appendChild(s);
  }

  App.UI = {
    formatCoins: formatCoins,
    formatShort: formatShort,
    coinIcon: coinIcon,
    el: el,
    flash: flash,
    /** Wie flash(), aber ohne Quest-/XP-Wertung: progress.js hookt nur flash().
     *  Für Coin-Bewegungen, die keine Spielrunde sind (z. B. Aktienhandel). */
    flashRaw: flash,
    toast: toast,
    createBetPanel: createBetPanel,
    gameHeader: gameHeader,
    injectStyle: injectStyle
  };
})();
