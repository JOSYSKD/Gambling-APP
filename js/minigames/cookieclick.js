/* cookieclick.js — "Jungle Tycoon": Idle-Clicker im Dschungel.
 * Klick die Nektar-Blüte, kauf Helfer, sammle in der Rundenzeit am meisten
 * Nektar. Singleplayer (mit Bestwert) + Multiplayer (Live-Rangliste, Podest).
 * Tab-Wechsel-sicher: Produktion & Timer laufen über Wall-Clock (Date.now). */
(function () {
  'use strict';
  window.App = window.App || {}; App.Minigames = App.Minigames || {};
  var UI = App.UI, el = UI.el;

  injectStyle();

  var HELPERS = [
    { key: 'ant',   icon: '🐜', name: 'Ameise',       base: 15,    rate: 0.3 },
    { key: 'cater', icon: '🐛', name: 'Raupe',        base: 120,   rate: 1.6 },
    { key: 'fly',   icon: '🦋', name: 'Schmetterling', base: 650,   rate: 7 },
    { key: 'monkey',icon: '🐒', name: 'Affe',         base: 3200,  rate: 28 },
    { key: 'tree',  icon: '🌳', name: 'Nektarbaum',   base: 15000, rate: 110 },
    { key: 'toucan',icon: '🦜', name: 'Tukan-Schwarm',base: 85000, rate: 520 }
  ];
  var CLICK_UP = { base: 250, growth: 1.6 }; // verdoppelt perClick

  function fmt(n) {
    n = Math.floor(n);
    if (n < 1000) return String(n);
    if (n < 1e6) return (n / 1e3).toFixed(n < 1e4 ? 1 : 0) + 'k';
    if (n < 1e9) return (n / 1e6).toFixed(2) + 'M';
    return (n / 1e9).toFixed(2) + 'B';
  }
  function priceOf(base, count, growth) { return Math.floor(base * Math.pow(growth || 1.15, count)); }

  App.Minigames.cookieclick = {
    id: 'cookieclick', title: 'Jungle Tycoon', icon: '🍯', order: 1,
    subtitle: 'Sammle in der Rundenzeit am meisten Nektar',
    single: true, multi: true, minPlayers: 2, maxPlayers: 8,

    render: function (root, ctx) {
      var isMulti = ctx.mode === 'multi';
      var DEFAULT_SINGLE = 90;          // s
      var MULTI_DURATION = 120;         // s (fest im Mehrspieler)
      var destroyed = false, timers = [];
      function every(ms, fn) { var t = setInterval(fn, ms); timers.push(t); return t; }
      function after(ms, fn) { var t = setTimeout(fn, ms); timers.push(t); return t; }
      function stopTimers() { timers.forEach(clearInterval); timers.forEach(clearTimeout); timers = []; }

      /* ---- Spielzustand ---- */
      var s = { nectar: 0, total: 0, perClick: 1, clickLevel: 0, helpers: {}, last: Date.now() };
      HELPERS.forEach(function (h) { s.helpers[h.key] = 0; });
      function perSec() { var r = 0; HELPERS.forEach(function (h) { r += h.rate * s.helpers[h.key]; }); return r; }

      /* ---- Singleplayer: erst Dauer wählen ---- */
      if (!isMulti) { chooseDuration(); return { cleanup: cleanup }; }
      /* ---- Multiplayer: Countdown bis round.startAt, dann los ---- */
      startCountdownMulti();
      return { cleanup: cleanup };

      function cleanup() { destroyed = true; stopTimers(); }

      /* ===================== SINGLEPLAYER-SETUP ===================== */
      function chooseDuration() {
        var opts = [{ t: 60, l: '60 Sek' }, { t: 90, l: '90 Sek' }, { t: 180, l: '3 Min' }, { t: 900, l: '15 Min' }];
        var wrap = el('div', { class: 'cc-setup glass' }, [
          el('div', { class: 'cc-setup-icon' }, ['🍯']),
          el('h3', { class: 'neon' }, ['Jungle Tycoon']),
          el('p', { class: 'hint-text' }, ['Wie lange willst du sammeln?']),
          el('div', { class: 'cc-dur' }, opts.map(function (o) {
            return el('button', { class: 'btn btn-ghost', type: 'button', onclick: function () { begin(o.t); } }, [o.l]);
          }))
        ]);
        root.innerHTML = ''; root.appendChild(wrap);
      }

      /* ===================== MULTIPLAYER-COUNTDOWN ===================== */
      function startCountdownMulti() {
        var snap = ctx.room.snapshot() || {};
        var startAt = (snap.round && snap.round.startAt) || (Date.now() + 3000);
        var overlay = el('div', { class: 'cc-countdown glass' }, [
          el('div', { class: 'cc-cd-num neon-strong' }, ['3']),
          el('p', { class: 'hint-text' }, ['Gleich geht\'s los …'])
        ]);
        root.innerHTML = ''; root.appendChild(overlay);
        var numEl = overlay.querySelector('.cc-cd-num');
        every(120, function () {
          var left = Math.ceil((startAt - Date.now()) / 1000);
          if (left <= 0) { stopTimers(); begin(MULTI_DURATION, startAt); return; }
          numEl.textContent = String(left);
        });
      }

      /* ===================== SPIEL ===================== */
      function begin(duration, startAtOverride) {
        var startAt = startAtOverride || Date.now();
        var endAt = startAt + duration * 1000;
        s.last = Date.now();

        /* --- Kopf: Nektar + Rate + Timer --- */
        var nectarEl = el('div', { class: 'cc-nectar big-readout' }, ['0']);
        var rateEl = el('div', { class: 'cc-rate hint-text' }, ['0 /s']);
        var timerEl = el('div', { class: 'mg-timer' }, ['']);
        var head = el('div', { class: 'cc-head glass' }, [
          el('div', {}, [el('span', { class: 'cc-nectar-l' }, ['🍯 Nektar']), nectarEl, rateEl]),
          timerEl
        ]);

        /* --- Klick-Blüte --- */
        var flower = el('button', { class: 'cc-flower', type: 'button' }, ['🌺']);
        var clickInfo = el('div', { class: 'hint-text', text: '+1 pro Klick' });
        var stage = el('div', { class: 'cc-stage' }, [flower, clickInfo]);

        /* --- Upgrades --- */
        var shopEl = el('div', { class: 'cc-shop' });

        /* --- Scoreboard (multi) --- */
        var boardEl = isMulti ? el('div', { class: 'mg-scoreboard cc-board' }) : null;

        var layout = el('div', { class: 'cc-layout' }, [
          head, stage,
          el('div', { class: 'cc-cols' }, [
            el('div', { class: 'cc-shop-wrap glass' }, [el('div', { class: 'mg-field-title' }, ['🛒 Helfer & Upgrades']), shopEl]),
            isMulti ? el('div', { class: 'cc-board-wrap glass' }, [el('div', { class: 'mg-field-title' }, ['🏆 Rangliste']), boardEl]) : null
          ])
        ]);
        root.innerHTML = ''; root.appendChild(layout);

        /* --- Klick-Handler --- */
        flower.addEventListener('click', function (e) {
          if (Date.now() >= endAt) return;
          s.nectar += s.perClick; s.total += s.perClick;
          popFloat(flower, '+' + fmt(s.perClick));
          flower.classList.remove('pop'); void flower.offsetWidth; flower.classList.add('pop');
        });

        /* --- Shop aufbauen --- */
        var rows = {};
        HELPERS.forEach(function (h) {
          var btn = el('button', { class: 'cc-buy', type: 'button', onclick: function () { buyHelper(h); } }, [
            el('span', { class: 'cc-buy-icon' }, [h.icon]),
            el('span', { class: 'cc-buy-info' }, [
              el('span', { class: 'cc-buy-name' }, [h.name]),
              el('span', { class: 'cc-buy-rate' }, ['+' + h.rate + '/s'])
            ]),
            el('span', { class: 'cc-buy-right' }, [
              el('span', { class: 'cc-buy-price' }, ['']),
              el('span', { class: 'cc-buy-count' }, ['0'])
            ])
          ]);
          shopEl.appendChild(btn); rows[h.key] = btn;
        });
        var clickBtn = el('button', { class: 'cc-buy cc-buy-click', type: 'button', onclick: buyClick }, [
          el('span', { class: 'cc-buy-icon' }, ['🖐️']),
          el('span', { class: 'cc-buy-info' }, [
            el('span', { class: 'cc-buy-name' }, ['Stärkere Hände']),
            el('span', { class: 'cc-buy-rate' }, ['Klick ×2'])
          ]),
          el('span', { class: 'cc-buy-right' }, [el('span', { class: 'cc-buy-price cc-click-price' }, [''])])
        ]);
        shopEl.appendChild(clickBtn);

        function buyHelper(h) {
          var price = priceOf(h.base, s.helpers[h.key]);
          if (s.nectar < price) { UI.toast('Zu wenig Nektar', 'lose'); return; }
          s.nectar -= price; s.helpers[h.key]++; refreshShop();
        }
        function buyClick() {
          var price = priceOf(CLICK_UP.base, s.clickLevel, CLICK_UP.growth);
          if (s.nectar < price) { UI.toast('Zu wenig Nektar', 'lose'); return; }
          s.nectar -= price; s.clickLevel++; s.perClick = Math.pow(2, s.clickLevel) ;
          clickInfo.textContent = '+' + fmt(s.perClick) + ' pro Klick'; refreshShop();
        }
        function refreshShop() {
          HELPERS.forEach(function (h) {
            var price = priceOf(h.base, s.helpers[h.key]);
            var btn = rows[h.key];
            btn.querySelector('.cc-buy-price').textContent = '🍯 ' + fmt(price);
            btn.querySelector('.cc-buy-count').textContent = s.helpers[h.key];
            btn.classList.toggle('afford', s.nectar >= price);
          });
          var cp = priceOf(CLICK_UP.base, s.clickLevel, CLICK_UP.growth);
          clickBtn.querySelector('.cc-click-price').textContent = '🍯 ' + fmt(cp);
          clickBtn.classList.toggle('afford', s.nectar >= cp);
        }
        refreshShop();

        /* --- Haupt-Loop (Wall-Clock, Tab-sicher) --- */
        var lastReport = 0;
        every(80, function () {
          var now = Date.now();
          var dt = (now - s.last) / 1000; s.last = now;
          if (dt > 0) { var add = perSec() * dt; s.nectar += add; s.total += add; }
          nectarEl.textContent = fmt(s.nectar);
          rateEl.textContent = fmt(perSec()) + ' /s';
          // Timer
          var left = Math.max(0, Math.ceil((endAt - now) / 1000));
          timerEl.textContent = '⏱ ' + mmss(left);
          if (left <= 10) timerEl.classList.add('cc-urgent');
          // Multiplayer: Score melden
          if (isMulti && now - lastReport > 1200) { lastReport = now; ctx.room.reportScore(Math.floor(s.total)); }
          if (now >= endAt) finish();
        });
        if (isMulti) {
          ctx.room.on('players', function () { renderBoard(); });
          renderBoard();
        }

        function renderBoard() {
          if (!boardEl) return;
          var ps = ctx.room.players().slice().sort(function (a, b) { return (b.score || 0) - (a.score || 0); });
          boardEl.innerHTML = '';
          ps.forEach(function (p, i) {
            boardEl.appendChild(el('div', { class: 'mg-sb-row p' + (i + 1) + (p.id === ctx.me.id ? ' me' : '') }, [
              el('span', { class: 'mg-sb-rank' }, ['' + (i + 1)]),
              el('span', { class: 'mg-sb-name' }, [p.name + (p.id === ctx.me.id ? ' (du)' : '')]),
              el('span', { class: 'mg-sb-score' }, [fmt(p.score || 0)])
            ]));
          });
        }

        var finished = false;
        function finish() {
          if (finished) return; finished = true;
          stopTimers();
          if (isMulti) {
            ctx.room.reportScore(Math.floor(s.total));
            var me = ctx.room.players().filter(function (p) { return p.id === ctx.me.id; })[0];
            if (App.Scores && me) App.Scores.submitCurrent(Math.floor(me.score || 0)); // nur EIGENER Nektar-Endwert, genau einmal
            after(1200, showPodium);        // kurz warten, bis alle Endstände da sind
          } else {
            if (App.Scores) App.Scores.submitCurrent(Math.floor(s.total)); // eigene Gesamtsumme, genau einmal
            showSingleResult();
          }
        }

        function showSingleResult() {
          var best = App.Storage.get('cc_best', 0);
          var isNew = s.total > best;
          if (isNew) App.Storage.set('cc_best', Math.floor(s.total));
          root.innerHTML = '';
          root.appendChild(el('div', { class: 'cc-result glass' }, [
            el('div', { class: 'cc-result-icon' }, ['🍯']),
            el('h2', { class: 'neon' }, ['Zeit um!']),
            el('div', { class: 'big-readout' }, [fmt(s.total)]),
            el('p', { class: 'hint-text' }, ['Nektar gesammelt' + (isNew ? ' · neuer Rekord! 🎉' : ' · Bestwert: ' + fmt(best))]),
            el('div', { class: 'controls-row' }, [
              el('button', { class: 'btn btn-primary', type: 'button', onclick: function () { reset(); chooseDuration(); } }, ['Nochmal']),
              el('button', { class: 'btn btn-ghost', type: 'button', onclick: ctx.onExit }, ['Zurück'])
            ])
          ]));
        }

        function showPodium() {
          var ps = ctx.room.players().slice().sort(function (a, b) { return (b.score || 0) - (a.score || 0); });
          var top = ps.slice(0, 3);
          var order = [1, 0, 2]; // Silber, Gold, Bronze — Gold in der Mitte
          var podium = el('div', { class: 'mg-podium' }, order.map(function (idx) {
            var p = top[idx]; if (!p) return null;
            var place = idx + 1;
            return el('div', { class: 'mg-pod mg-pod-' + place }, [
              el('div', { class: 'mg-pod-name' }, [p.name + (p.id === ctx.me.id ? ' (du)' : '')]),
              el('div', { class: 'mg-pod-bar' }, [place === 1 ? '🥇' : place === 2 ? '🥈' : '🥉']),
              el('div', { class: 'mg-pod-score' }, [fmt(p.score || 0)])
            ]);
          }));
          var rest = ps.slice(3).map(function (p, i) {
            return el('div', { class: 'mg-sb-row' }, [
              el('span', { class: 'mg-sb-rank' }, ['' + (i + 4)]),
              el('span', { class: 'mg-sb-name' }, [p.name]),
              el('span', { class: 'mg-sb-score' }, [fmt(p.score || 0)])
            ]);
          });
          var iWon = ps[0] && ps[0].id === ctx.me.id;
          root.innerHTML = '';
          root.appendChild(el('div', { class: 'cc-result glass' }, [
            el('h2', { class: 'neon' }, [iWon ? '🎉 Du hast gewonnen!' : '🏁 Runde vorbei']),
            podium,
            rest.length ? el('div', { class: 'mg-scoreboard' }, rest) : null,
            el('div', { class: 'controls-row' }, [
              el('button', { class: 'btn btn-ghost', type: 'button', onclick: ctx.onExit }, ['Zurück zur Lobby'])
            ])
          ]));
        }

        function reset() {
          s = { nectar: 0, total: 0, perClick: 1, clickLevel: 0, helpers: {}, last: Date.now() };
          HELPERS.forEach(function (h) { s.helpers[h.key] = 0; });
          finished = false;
        }
      }

      function mmss(sec) { var m = Math.floor(sec / 60), r = sec % 60; return m + ':' + (r < 10 ? '0' : '') + r; }
      function popFloat(anchor, txt) {
        var r = anchor.getBoundingClientRect();
        var f = el('div', { class: 'cc-float', text: txt });
        f.style.left = (r.left + r.width / 2 + (Math.random() * 40 - 20)) + 'px';
        f.style.top = (r.top + 20) + 'px';
        document.body.appendChild(f);
        setTimeout(function () { f.classList.add('go'); }, 10);
        setTimeout(function () { if (f.parentNode) f.parentNode.removeChild(f); }, 900);
      }
    }
  };

  function injectStyle() {
    UI.injectStyle('mg-cookieclick-css', [
      '.cc-setup{padding:30px;text-align:center;display:flex;flex-direction:column;gap:12px;align-items:center;max-width:440px;margin:0 auto;}',
      '.cc-setup-icon{font-size:52px;filter:drop-shadow(0 0 12px rgba(255,210,63,.5));}',
      '.cc-dur{display:flex;gap:10px;flex-wrap:wrap;justify-content:center;}',
      '.cc-countdown{padding:50px;text-align:center;display:flex;flex-direction:column;gap:10px;align-items:center;max-width:440px;margin:0 auto;}',
      '.cc-cd-num{font-size:80px;font-weight:900;}',
      '.cc-layout{display:flex;flex-direction:column;gap:14px;}',
      '.cc-head{display:flex;justify-content:space-between;align-items:center;padding:14px 18px;gap:12px;flex-wrap:wrap;}',
      '.cc-nectar-l{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:1px;}',
      '.cc-nectar{font-size:clamp(28px,7vw,44px);line-height:1;color:var(--gold);text-shadow:0 0 14px rgba(255,210,63,.5);}',
      '.cc-rate{margin-top:2px;}',
      '.mg-timer.cc-urgent{color:var(--danger-2);}',
      '.cc-stage{display:flex;flex-direction:column;align-items:center;gap:8px;padding:10px;}',
      '.cc-flower{font-size:clamp(90px,26vw,150px);background:none;border:none;cursor:pointer;line-height:1;filter:drop-shadow(0 8px 20px rgba(0,0,0,.4));transition:transform .06s;user-select:none;-webkit-user-select:none;}',
      '.cc-flower:active{transform:scale(.92);}',
      '.cc-flower.pop{animation:cc-pop .18s ease;}',
      '@keyframes cc-pop{0%{transform:scale(.92)}60%{transform:scale(1.06)}100%{transform:scale(1)}}',
      '.cc-float{position:fixed;pointer-events:none;z-index:85;font-weight:900;font-size:22px;color:var(--gold);text-shadow:0 2px 8px rgba(0,0,0,.6);transform:translate(-50%,0);transition:all .85s ease-out;opacity:1;}',
      '.cc-float.go{transform:translate(-50%,-70px);opacity:0;}',
      '.cc-cols{display:grid;grid-template-columns:1fr;gap:14px;}',
      '@media(min-width:720px){.cc-cols{grid-template-columns:1fr 1fr;}}',
      '.cc-shop-wrap,.cc-board-wrap{padding:14px;display:flex;flex-direction:column;gap:8px;}',
      '.cc-shop{display:flex;flex-direction:column;gap:7px;}',
      '.cc-buy{display:flex;align-items:center;gap:10px;padding:9px 12px;border-radius:12px;cursor:pointer;font-family:inherit;text-align:left;',
      'background:rgba(9,32,21,.7);border:1px solid var(--stroke);color:var(--text);transition:.12s;opacity:.6;}',
      '.cc-buy.afford{opacity:1;border-color:var(--stroke-2);}',
      '.cc-buy.afford:hover{box-shadow:var(--glow-soft);transform:translateY(-1px);}',
      '.cc-buy-icon{font-size:26px;}',
      '.cc-buy-info{flex:1;display:flex;flex-direction:column;}',
      '.cc-buy-name{font-weight:800;}',
      '.cc-buy-rate{font-size:12px;color:var(--muted);}',
      '.cc-buy-right{display:flex;flex-direction:column;align-items:flex-end;gap:2px;}',
      '.cc-buy-price{font-weight:800;color:var(--leaf);font-size:14px;}',
      '.cc-buy-count{font-size:12px;color:var(--aqua-soft);font-weight:800;}',
      '.cc-buy-click{border-color:rgba(255,210,63,.3);}',
      '.cc-board{max-height:340px;overflow-y:auto;}',
      '.cc-result{padding:30px;text-align:center;display:flex;flex-direction:column;gap:12px;align-items:center;max-width:520px;margin:0 auto;}',
      '.cc-result-icon{font-size:48px;}',
      '.cc-result .big-readout{color:var(--gold);}'
    ].join(''));
  }
})();
