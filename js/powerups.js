/* powerups.js — zeitlich begrenzte Power-Ups (App.Powerups).
 *
 * Preis für den Turniersieger (siehe js/tournament.js): der Admin legt im
 * Turnier-Konfigurationsmenü fest, was es zu gewinnen gibt — z. B. "1 Minute
 * extrem viel Glück".
 *
 * Die Glücks-Power-Ups nutzen denselben Eingriffspunkt wie das Admin-"Rigging"
 * (rigFactor() in js/coins.js): ein Faktor auf jede Gewinn-Gutschrift, über
 * alle Gambling-Spiele hinweg. Der Unterschied zum Admin-Rig ist nur, dass ein
 * Power-Up von selbst abläuft (`until`-Zeitstempel) und der Faktor multiplikativ
 * zum Admin-Rig dazukommt.
 *
 * Es ist immer höchstens EIN Power-Up aktiv; ein neues ersetzt ein laufendes
 * (bzw. verlängert es, wenn es derselbe Typ ist).
 */
(function () {
  'use strict';
  window.App = window.App || {};

  var KEY = 'gj_powerup';

  /* Katalog. `factor` wirkt auf Gewinne (siehe coins.js), `instant` schreibt
   * einmalig gut statt zu laufen. Die Reihenfolge ist die Auswahlreihenfolge im
   * Admin-Menü. */
  var TYPES = [
    { id: 'luck3', icon: '🌟', label: 'Göttliches Glück', hint: 'Gewinne ×5', factor: 5, timed: true },
    { id: 'luck2', icon: '🍀', label: 'Extrem viel Glück', hint: 'Gewinne ×2.5', factor: 2.5, timed: true },
    { id: 'luck1', icon: '🙂', label: 'Etwas Glück', hint: 'Gewinne ×1.6', factor: 1.6, timed: true },
    { id: 'coins', icon: '🪙', label: 'Coin-Regen', hint: 'Coins sofort aufs Konto', instant: true },
    { id: 'tickets', icon: '🎟️', label: 'Ticket-Paket', hint: 'Turnier-Tickets sofort', instant: true }
  ];

  function typeById(id) {
    for (var i = 0; i < TYPES.length; i++) if (TYPES[i].id === id) return TYPES[i];
    return null;
  }

  var listeners = [];
  function emit() { listeners.forEach(function (cb) { try { cb(active()); } catch (e) {} }); }

  /** Aktives Power-Up { type, until, amount } oder null (abgelaufene fliegen raus). */
  function active() {
    var p = App.Storage.get(KEY, null);
    if (!p || !p.type || !typeById(p.type)) return null;
    if (!p.until || p.until <= Date.now()) {
      if (p) App.Storage.remove(KEY);
      return null;
    }
    return p;
  }

  /** Gewinn-Faktor des laufenden Power-Ups (1 = keins aktiv). Liest coins.js. */
  function factor() {
    var p = active();
    if (!p) return 1;
    var t = typeById(p.type);
    return (t && t.factor) || 1;
  }

  function remainingMs() {
    var p = active();
    return p ? Math.max(0, p.until - Date.now()) : 0;
  }

  function fmtRemaining(ms) {
    var s = Math.ceil(ms / 1000);
    var m = Math.floor(s / 60);
    s = s % 60;
    return m > 0 ? (m + ':' + String(s).padStart(2, '0')) : (s + 's');
  }

  /** Preis-Beschreibung für Menüs/Sieger-Screen. prize = {type, minutes, amount}. */
  function describe(prize) {
    if (!prize || !prize.type) return 'kein Preis';
    var t = typeById(prize.type);
    if (!t) return 'kein Preis';
    if (t.instant) return (prize.amount || 0) + ' ' + (t.id === 'coins' ? '🪙 Coins' : '🎟️ Tickets');
    var min = prize.minutes || 1;
    return min + ' Min. ' + t.label + ' (' + t.hint + ')';
  }

  /** Power-Up verleihen (Turniersieg). Gibt den Beschreibungstext zurück. */
  function grant(prize) {
    if (!prize || !prize.type) return '';
    var t = typeById(prize.type);
    if (!t) return '';

    if (t.instant) {
      var amount = Math.max(0, Math.round(Number(prize.amount) || 0));
      if (t.id === 'coins' && App.Coins) {
        // addRaw() umgeht Rigging/Quest-Wertung — es ist ein Preis, kein
        // Spielgewinn. Wo es die Methode (noch) nicht gibt, tut es add() auch;
        // dann wird der Betrag lediglich von einem laufenden Glücks-Power-Up
        // mitskaliert.
        if (App.Coins.addRaw) App.Coins.addRaw(amount);
        else App.Coins.add(amount);
      }
      if (t.id === 'tickets' && App.Tickets) App.Tickets.add(amount);
      emit();
      return describe(prize);
    }

    var minutes = Math.max(1, Math.round(Number(prize.minutes) || 1));
    var cur = active();
    // Gleicher Typ -> verlängern statt ersetzen, sonst überschreiben.
    var base = (cur && cur.type === t.id) ? cur.until : Date.now();
    App.Storage.set(KEY, { type: t.id, until: base + minutes * 60000 });
    emit();
    render();
    return describe(prize);
  }

  function clear() { App.Storage.remove(KEY); emit(); render(); }

  /* ---------- Anzeige im Kopfbereich ---------- */
  function injectCss() {
    if (!App.UI || !App.UI.injectStyle) return;
    App.UI.injectStyle('powerup-css', [
      '.pu-chip{display:inline-flex;align-items:center;gap:6px;padding:5px 10px;border-radius:999px;',
      'border:1px solid var(--neon);background:rgba(4,16,10,.72);font-size:13px;font-weight:700;',
      'color:var(--neon);animation:pu-pulse 1.6s ease-in-out infinite;white-space:nowrap;}',
      '@keyframes pu-pulse{0%,100%{box-shadow:0 0 4px rgba(57,255,20,.4);}50%{box-shadow:0 0 14px rgba(57,255,20,.9);}}',
      '.pu-chip .pu-time{opacity:.85;font-variant-numeric:tabular-nums;}',
      '.reduce-motion .pu-chip{animation:none;}'
    ].join(''));
  }

  var chipEl = null, tickTimer = null;

  function render() {
    var nav = document.querySelector('.topnav');
    if (!nav || !App.UI || !App.UI.el) return;
    injectCss();
    var p = active();

    if (!p) {
      if (chipEl && chipEl.parentNode) chipEl.parentNode.removeChild(chipEl);
      chipEl = null;
      if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
      return;
    }

    var t = typeById(p.type);
    if (!chipEl) {
      chipEl = App.UI.el('span', { class: 'pu-chip', title: t.label + ' — ' + t.hint });
      nav.appendChild(chipEl);
    }
    chipEl.textContent = '';
    chipEl.appendChild(document.createTextNode((t.icon || '⚡') + ' ' + t.label + ' '));
    var time = App.UI.el('span', { class: 'pu-time' }, [fmtRemaining(remainingMs())]);
    chipEl.appendChild(time);

    if (!tickTimer) {
      tickTimer = setInterval(function () {
        var ms = remainingMs();
        if (ms <= 0) {
          if (App.UI.toast) App.UI.toast('⚡ Power-Up abgelaufen', 'info');
          render();
          return;
        }
        if (time.parentNode) time.textContent = fmtRemaining(ms);
      }, 1000);
    }
  }

  App.Powerups = {
    TYPES: TYPES,
    typeById: typeById,
    active: active,
    factor: factor,
    describe: describe,
    grant: grant,
    clear: clear,
    remainingMs: remainingMs,
    onChange: function (cb) {
      listeners.push(cb);
      return function () { var i = listeners.indexOf(cb); if (i >= 0) listeners.splice(i, 1); };
    },
    render: render
  };

  function boot() { render(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
