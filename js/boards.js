/* boards.js — zusätzliche Bestenlisten neben der Coin-Bestenliste:
 *   ⭐ Level        — höchste Level
 *   ⏱ Spielzeit    — wer war am längsten auf der Seite (js/playtime.js)
 *   🎁 Verschenkt   — größte Schenker (js/gift.js)
 *
 * Datenquelle ist das Präsenz-Register (js/presence.js über account.js), das
 * jeden Spieler kennt — plus der eigene Live-Wert, damit man sich sofort selbst
 * sieht. Ein Eintrag pro Spielername (höchster Wert gewinnt).
 */
(function () {
  'use strict';
  window.App = window.App || {};
  var UI = App.UI, el = UI.el;

  function timeFmt(v) { return (App.Playtime && App.Playtime.format) ? App.Playtime.format(v) : (Math.round(v / 60000) + ' min'); }

  var METRICS = [
    { id: 'level', label: '⭐ Level', get: function (p) { return Number(p.level) || 1; }, fmt: function (v) { return 'Level ' + UI.formatShort(v); } },
    { id: 'time', label: '⏱ Spielzeit', get: function (p) { return Number(p.playtimeMs) || 0; }, fmt: timeFmt },
    { id: 'gift', label: '🎁 Verschenkt', get: function (p) { return Number(p.giftedTotal) || 0; }, fmt: function (v) { return UI.formatShort(v) + ' ' + UI.coinIcon(); } }
  ];

  function myLive(id) {
    if (id === 'level') return (App.Progress && App.Progress.level) ? App.Progress.level() : 1;
    if (id === 'time') return (App.Playtime && App.Playtime.getMs) ? App.Playtime.getMs() : 0;
    if (id === 'gift') return (App.Gift && App.Gift.total) ? App.Gift.total() : 0;
    return 0;
  }

  function rowsFor(metric) {
    var map = {}, keys = [], now = Date.now();
    function put(name, val, opts) {
      var k = String(name || '').toLowerCase().trim();
      if (!k || k === 'gast') return;
      val = Number(val) || 0;
      var e = map[k];
      if (!e) { e = map[k] = { name: String(name).slice(0, 18), val: val, me: false, online: false, gold: opts.gold || false }; keys.push(k); }
      else if (val > e.val) e.val = val;
      if (opts.me) e.me = true;
      if (opts.online) e.online = true;
      if (opts.gold) e.gold = true;
    }
    ((App.Leaderboard && App.Leaderboard.getPlayers && App.Leaderboard.getPlayers()) || []).forEach(function (p) {
      if (!p || !p.name) return;
      // Level & Verschenkt wurden beim großen Reset genullt — Register-Werte von
      // Spielern, die seitdem nicht mehr da waren, sind Vor-Reset-Reste und werden
      // ausgeblendet. Die Spielzeit blieb erhalten und zeigt weiterhin alle.
      if (metric.id !== 'time' && (p.updatedAt || 0) < ((App.HardReset && App.HardReset.RESET_AT) || 0)) return;
      put(p.name, metric.get(p), { online: (now - (p.updatedAt || 0)) < 45000, gold: !!p.maxLevel });
    });
    var myName = (App.Leaderboard && App.Leaderboard.getPlayerName()) || 'Du';
    put(myName, myLive(metric.id), { me: true, online: true, gold: !!(App.Progress && App.Progress.isMaxLevel && App.Progress.isMaxLevel()) });
    var list = keys.map(function (k) { return map[k]; });
    list.sort(function (a, b) { return (b.val - a.val) || a.name.localeCompare(b.name); });
    return list;
  }

  function injectCss() {
    UI.injectStyle('boards-css', [
      '.bd-page{display:flex;flex-direction:column;gap:14px;max-width:680px;margin:0 auto;}',
      '.bd-tabs{display:flex;gap:8px;flex-wrap:wrap;}',
      '.bd-tab{flex:1;min-width:96px;font-weight:800;}',
      '.bd-tab.active{color:#04160c;background:linear-gradient(180deg,var(--neon-soft),var(--neon));border-color:var(--neon);box-shadow:0 0 12px rgba(57,255,20,.5);}',
      '.bd-mine{padding:12px 16px;text-align:center;}',
      '.bd-mine-v{font-size:24px;font-weight:900;color:var(--gold);font-variant-numeric:tabular-nums;}',
      '.bd-mine-l{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;font-weight:800;}',
      '.bd-list{display:flex;flex-direction:column;gap:6px;}',
      '.bd-row{display:flex;align-items:center;gap:12px;padding:10px 14px;border-radius:11px;background:rgba(0,0,0,.22);border:1px solid var(--stroke);}',
      '.bd-row.me{border-color:var(--gold);box-shadow:0 0 12px rgba(255,210,63,.3);background:rgba(255,210,63,.06);}',
      '.bd-rank{font-weight:900;color:var(--muted);min-width:30px;font-variant-numeric:tabular-nums;}',
      '.bd-row.top1 .bd-rank{color:#ffd23f;}.bd-row.top2 .bd-rank{color:#cfd8dc;}.bd-row.top3 .bd-rank{color:#e6a86b;}',
      '.bd-name{font-weight:800;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.bd-name.gold{color:var(--gold);text-shadow:0 0 8px rgba(255,210,63,.5);}',
      '.bd-dot{font-size:9px;opacity:.35;}.bd-dot.on{opacity:1;color:var(--neon);filter:drop-shadow(0 0 5px rgba(57,255,20,.85));}',
      '.bd-val{font-weight:900;color:var(--leaf);font-variant-numeric:tabular-nums;}'
    ].join(''));
  }

  function renderPage(root) {
    injectCss();
    var page = el('div', { class: 'bd-page' });
    root.appendChild(page);

    page.appendChild(el('div', { class: 'page-head' }, [
      el('button', { class: 'btn btn-ghost back', type: 'button', onclick: function () { App.Router.go('/'); } }, ['← Menü']),
      el('h2', { class: 'page-title neon' }, ['🏆 Ranglisten'])
    ]));

    var current = METRICS[0];
    var tabRow = el('div', { class: 'bd-tabs' });
    var mineBox = el('div', { class: 'glass bd-mine' });
    var listBox = el('div', { class: 'bd-list' });

    var tabBtns = METRICS.map(function (m) {
      return el('button', { class: 'btn bd-tab' + (m.id === current.id ? ' active' : ''), type: 'button', onclick: function () {
        current = m;
        tabBtns.forEach(function (b, i) { b.classList.toggle('active', METRICS[i].id === m.id); });
        draw();
      } }, [m.label]);
    });
    tabBtns.forEach(function (b) { tabRow.appendChild(b); });

    page.appendChild(tabRow);
    page.appendChild(mineBox);
    page.appendChild(listBox);

    function draw() {
      mineBox.innerHTML = '';
      mineBox.appendChild(el('div', { class: 'bd-mine-v' }, [current.fmt(myLive(current.id))]));
      mineBox.appendChild(el('div', { class: 'bd-mine-l' }, ['Dein Wert · ' + current.label]));

      listBox.innerHTML = '';
      var rows = rowsFor(current);
      if (!rows.length) { listBox.appendChild(el('p', { class: 'lb-hint' }, ['Noch keine Spieler.'])); return; }
      rows.slice(0, 100).forEach(function (r, i) {
        var cls = 'bd-row' + (r.me ? ' me' : '') + (i < 3 ? ' top' + (i + 1) : '');
        listBox.appendChild(el('div', { class: cls }, [
          el('span', { class: 'bd-rank' }, ['#' + (i + 1)]),
          el('span', { class: 'bd-dot' + (r.online ? ' on' : '') }, ['●']),
          el('span', { class: 'bd-name' + (r.gold ? ' gold' : '') }, [r.name + (r.me ? ' (du)' : '')]),
          el('span', { class: 'bd-val' }, [current.fmt(r.val)])
        ]));
      });
    }

    draw();
    var off = App.Leaderboard.onChange(draw);
    return function () { off && off(); };
  }

  App.Boards = { renderPage: renderPage };
})();
