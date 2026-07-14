/* daily.js — Täglicher Bonus mit Streak  (App.Daily)
 *
 * Einmal pro Kalendertag gratis Coins abholen. Der Betrag steigt mit Level und
 * mit der Tages-Streak (aufeinanderfolgende Tage, bis 7×). Verpasst man einen Tag,
 * beginnt die Streak neu. Gift-Icon im Header; blinkt, wenn etwas abzuholen ist.
 */
(function () {
  'use strict';
  window.App = window.App || {};
  var UI = App.UI, el = UI.el;
  var KEY = 'gj_daily';

  function today() {
    var d = new Date();
    return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
  }
  function yesterday() {
    var d = new Date(); d.setDate(d.getDate() - 1);
    return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
  }

  var state = load();
  function load() {
    var s = App.Storage ? App.Storage.get(KEY, null) : null;
    if (!s || typeof s !== 'object') s = { last: '', streak: 0 };
    s.last = s.last || ''; s.streak = s.streak || 0;
    return s;
  }
  function save() { if (App.Storage) App.Storage.set(KEY, state); }

  function claimable() { return state.last !== today(); }
  function nextStreak() {
    if (state.last === yesterday()) return Math.min(7, state.streak + 1);
    return 1; // Streak neu (oder erster Tag)
  }
  function amountFor(streak) {
    var L = (App.Progress && App.Progress.level) ? App.Progress.level() : 1;
    return Math.round(((300 + L * 90) * streak) / 50) * 50;   // steigt mit Level & Streak
  }

  function claim() {
    if (!claimable()) return;
    var st = nextStreak();
    var amt = amountFor(st);
    state.last = today(); state.streak = st; save();
    if (App.Coins) App.Coins.add(amt);
    if (App.Progress) App.Progress.addXp(40 + st * 10);
    if (App.Audio) App.Audio.sfx('jackpot');
    updateBadge();
    celebrate(st, amt);
  }

  /* ---------------- Header-Gift ---------------- */
  var giftBtn = null;
  function installNav() {
    var nav = document.querySelector('.topnav');
    if (!nav || giftBtn) return;
    giftBtn = el('button', { class: 'topnav-link daily-gift', type: 'button', title: 'Täglicher Bonus', onclick: openPanel }, ['🎁']);
    nav.insertBefore(giftBtn, nav.firstChild);
    updateBadge();
  }
  function updateBadge() {
    if (!giftBtn) return;
    giftBtn.classList.toggle('has', claimable());
  }

  function openPanel() {
    injectCss();
    var st = nextStreak(), amt = amountFor(st);
    var can = claimable();
    var days = el('div', { class: 'daily-days' }, [1, 2, 3, 4, 5, 6, 7].map(function (d) {
      var reached = d <= (can ? st : state.streak);
      return el('div', { class: 'daily-day' + (reached ? ' on' : '') + (d === (can ? st : state.streak) ? ' cur' : '') }, [
        el('div', { class: 'daily-day-n' }, ['Tag ' + d]),
        el('div', { class: 'daily-day-ic' }, [d === 7 ? '💎' : '🪙'])
      ]);
    }));
    var overlay = el('div', { class: 'daily-overlay' }, [
      el('div', { class: 'daily-card glass' }, [
        el('button', { class: 'daily-close', type: 'button', onclick: close }, ['✕']),
        el('div', { class: 'daily-gift-big' }, ['🎁']),
        el('h2', { class: 'neon' }, ['Täglicher Bonus']),
        el('p', { class: 'hint-text' }, [can ? ('Streak-Tag ' + st + ' · hol dir ') : 'Heute schon abgeholt — komm morgen wieder!']),
        can ? el('div', { class: 'daily-amt' }, ['+' + UI.formatCoins(amt) + ' 🪙']) : null,
        days,
        can
          ? el('button', { class: 'btn btn-primary btn-lg btn-block', type: 'button', onclick: function () { claim(); close(); } }, ['🎁 Abholen'])
          : el('button', { class: 'btn btn-ghost btn-lg btn-block', type: 'button', onclick: close }, ['Schließen'])
      ])
    ]);
    overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });
    document.body.appendChild(overlay);
    function close() { if (overlay.parentNode) overlay.parentNode.removeChild(overlay); }
  }

  function celebrate(streak, amt) {
    injectCss();
    var card = el('div', { class: 'daily-pop glass' }, [
      el('div', { class: 'daily-pop-ic' }, ['🎁']),
      el('div', {}, [
        el('div', { class: 'daily-pop-t' }, ['Tagesbonus · Streak ' + streak + '/7']),
        el('div', { class: 'daily-pop-r' }, ['+' + UI.formatCoins(amt) + ' 🪙'])
      ])
    ]);
    document.body.appendChild(card);
    setTimeout(function () { card.classList.add('show'); }, 20);
    setTimeout(function () { card.classList.remove('show'); setTimeout(function () { if (card.parentNode) card.parentNode.removeChild(card); }, 400); }, 3200);
  }

  var cssDone = false;
  function injectCss() {
    if (cssDone) return; cssDone = true;
    UI.injectStyle('daily-css', [
      '.daily-gift.has{animation:daily-wob 1.1s ease-in-out infinite;}',
      '.daily-gift.has::after{content:"";position:absolute;top:2px;right:2px;width:8px;height:8px;border-radius:50%;background:var(--danger);box-shadow:0 0 6px var(--danger);}',
      '.daily-gift{position:relative;}',
      '@keyframes daily-wob{0%,100%{transform:rotate(0)}25%{transform:rotate(-12deg)}75%{transform:rotate(12deg)}}',
      '.daily-overlay{position:fixed;inset:0;z-index:250;display:flex;align-items:center;justify-content:center;background:rgba(2,10,6,.72);backdrop-filter:blur(4px);padding:16px;}',
      '.daily-card{position:relative;width:100%;max-width:420px;padding:24px;text-align:center;display:flex;flex-direction:column;gap:12px;align-items:center;}',
      '.daily-close{position:absolute;top:10px;right:12px;background:none;border:none;color:var(--muted);font-size:20px;cursor:pointer;}',
      '.daily-gift-big{font-size:52px;line-height:1;filter:drop-shadow(0 0 14px rgba(255,210,63,.5));}',
      '.daily-amt{font-size:30px;font-weight:900;color:var(--gold);text-shadow:0 0 14px rgba(255,210,63,.5);}',
      '.daily-days{display:grid;grid-template-columns:repeat(7,1fr);gap:6px;width:100%;}',
      '.daily-day{padding:8px 2px;border-radius:10px;border:1px solid var(--stroke);background:rgba(4,16,10,.5);opacity:.5;}',
      '.daily-day.on{opacity:1;border-color:var(--stroke-2);}',
      '.daily-day.cur{border-color:var(--neon);box-shadow:0 0 0 1px var(--neon);}',
      '.daily-day-n{font-size:10px;color:var(--muted);font-weight:800;}',
      '.daily-day-ic{font-size:18px;}',
      '.daily-pop{position:fixed;left:50%;bottom:26px;transform:translate(-50%,14px);z-index:300;display:flex;align-items:center;gap:12px;padding:14px 20px;opacity:0;transition:.35s;pointer-events:none;}',
      '.daily-pop.show{opacity:1;transform:translate(-50%,0);}',
      '.daily-pop-ic{font-size:30px;}',
      '.daily-pop-t{font-weight:900;color:var(--neon);}',
      '.daily-pop-r{color:var(--gold);font-weight:800;}'
    ].join(''));
  }

  App.Daily = { claimable: claimable, claim: claim, open: openPanel };

  function boot() {
    installNav();
    // Beim ersten Besuch des Tages dezent aufs Geschenk hinweisen.
    if (claimable()) setTimeout(function () { if (App.UI && App.UI.toast) UI.toast('🎁 Täglicher Bonus wartet!', 'win'); }, 1400);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
