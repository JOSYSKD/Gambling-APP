/* mgutil.js — gemeinsame Bausteine für die Online-Minigames.
 * Nutzt App.UI (el) + die .mg-* CSS-Klassen aus minigames.js.
 * Damit bauen alle Spiele Countdown, Live-Rangliste, Podest und Endscreen
 * einheitlich. Alle Timer laufen über Wall-Clock (Date.now) -> Tab-sicher.
 */
(function () {
  'use strict';
  window.App = window.App || {};
  var UI = App.UI, el = UI.el;

  function fmt(n) {
    n = Math.round(Number(n) || 0);
    if (Math.abs(n) < 1000) return String(n);
    if (Math.abs(n) < 1e6) return (n / 1e3).toFixed(n % 1000 === 0 ? 0 : 1) + 'k';
    if (Math.abs(n) < 1e9) return (n / 1e6).toFixed(2) + 'M';
    return (n / 1e9).toFixed(2) + 'B';
  }
  function mmss(sec) { sec = Math.max(0, Math.floor(sec)); var m = Math.floor(sec / 60), r = sec % 60; return m + ':' + (r < 10 ? '0' : '') + r; }

  /* 3-2-1-Countdown-Overlay. Ruft onDone(), sobald startAtMs erreicht ist.
     nowFn optional (default Date.now) — im Multiplayer ctx.room.now übergeben,
     damit alle Geräte synchron starten. Gibt eine stop()-Funktion zurück. */
  function countdown(root, startAtMs, onDone, nowFn) {
    nowFn = nowFn || Date.now;
    var box = el('div', { class: 'mg-cd glass' }, [
      el('div', { class: 'mg-cd-num neon-strong' }, ['3']),
      el('p', { class: 'hint-text' }, ['Gleich geht\'s los …'])
    ]);
    root.innerHTML = ''; root.appendChild(box);
    var num = box.querySelector('.mg-cd-num'), done = false;
    var t = setInterval(function () {
      var left = Math.ceil((startAtMs - nowFn()) / 1000);
      if (left <= 0) { clearInterval(t); if (!done) { done = true; onDone(); } return; }
      num.textContent = String(left);
    }, 100);
    return function () { clearInterval(t); };
  }

  /* Live-Rangliste, die sich bei room 'players'-Updates selbst aktualisiert.
     opts.format(v)->string, opts.sortDesc (default true).
     Rückgabe: { root, update(), stop() }. */
  function liveBoard(room, meId, opts) {
    opts = opts || {};
    var format = opts.format || fmt;
    var rootEl = el('div', { class: 'mg-scoreboard' });
    function update() {
      var ps = room.players().slice().sort(function (a, b) {
        return opts.sortDesc === false ? (a.score || 0) - (b.score || 0) : (b.score || 0) - (a.score || 0);
      });
      rootEl.innerHTML = '';
      ps.forEach(function (p, i) {
        rootEl.appendChild(el('div', { class: 'mg-sb-row p' + (i + 1) + (p.id === meId ? ' me' : '') }, [
          el('span', { class: 'mg-sb-rank' }, ['' + (i + 1)]),
          el('span', { class: 'mg-sb-name' }, [p.name + (p.id === meId ? ' (du)' : '')]),
          el('span', { class: 'mg-sb-score' }, [format(p.score || 0)])
        ]));
      });
    }
    var handler = function () { update(); };
    room.on('players', handler);
    update();
    return { root: rootEl, update: update, stop: function () { room.off('players', handler); } };
  }

  /* Podest-DOM aus einer Spieler-Liste (Top 3 + Rest). */
  function podiumEl(players, meId, format) {
    format = format || fmt;
    var ps = players.slice().sort(function (a, b) { return (b.score || 0) - (a.score || 0); });
    var top = ps.slice(0, 3), order = [1, 0, 2];
    var podium = el('div', { class: 'mg-podium' }, order.map(function (idx) {
      var p = top[idx]; if (!p) return null;
      var place = idx + 1;
      return el('div', { class: 'mg-pod mg-pod-' + place }, [
        el('div', { class: 'mg-pod-name' }, [p.name + (p.id === meId ? ' (du)' : '')]),
        el('div', { class: 'mg-pod-bar' }, [place === 1 ? '🥇' : place === 2 ? '🥈' : '🥉']),
        el('div', { class: 'mg-pod-score' }, [format(p.score || 0)])
      ]);
    }));
    var rest = ps.slice(3).map(function (p, i) {
      return el('div', { class: 'mg-sb-row' }, [
        el('span', { class: 'mg-sb-rank' }, ['' + (i + 4)]),
        el('span', { class: 'mg-sb-name' }, [p.name + (p.id === meId ? ' (du)' : '')]),
        el('span', { class: 'mg-sb-score' }, [format(p.score || 0)])
      ]);
    });
    return el('div', {}, [podium, rest.length ? el('div', { class: 'mg-scoreboard' }, rest) : null]);
  }

  /* Einheitlicher Endscreen.
     Multiplayer: opts.players (Liste) -> Podest, opts.meId.
     Singleplayer: opts.score + opts.best (+ opts.newBest).
     opts.onAgain (optional), opts.onExit. */
  function endScreen(root, opts) {
    opts = opts || {};
    var body;
    if (opts.players) {
      var ps = opts.players.slice().sort(function (a, b) { return (b.score || 0) - (a.score || 0); });
      var iWon = ps[0] && ps[0].id === opts.meId;
      body = [
        el('h2', { class: 'neon' }, [iWon ? '🎉 Du hast gewonnen!' : (opts.title || '🏁 Runde vorbei')]),
        podiumEl(opts.players, opts.meId, opts.format)
      ];
    } else {
      body = [
        el('h2', { class: 'neon' }, [opts.title || 'Geschafft!']),
        el('div', { class: 'big-readout', text: (opts.format || fmt)(opts.score || 0) }),
        el('p', { class: 'hint-text' }, [opts.label || (opts.newBest ? 'Neuer Rekord! 🎉' : ('Bestwert: ' + (opts.format || fmt)(opts.best || 0)))])
      ];
    }
    var actions = [];
    if (opts.onAgain) actions.push(el('button', { class: 'btn btn-primary', type: 'button', onclick: opts.onAgain }, ['Nochmal']));
    actions.push(el('button', { class: 'btn btn-ghost', type: 'button', onclick: opts.onExit }, [opts.players ? 'Zurück zur Lobby' : 'Zurück']));
    body.push(el('div', { class: 'controls-row' }, actions));
    root.innerHTML = '';
    root.appendChild(el('div', { class: 'glass mg-endscreen' }, body));
  }

  /* Wall-Clock-Timer: ruft tick(secLeft) bis 0, dann onEnd. nowFn optional
     (Multiplayer: ctx.room.now). Gibt stop() zurück. */
  function roundTimer(endAtMs, tick, onEnd, nowFn) {
    nowFn = nowFn || Date.now;
    var ended = false;
    var t = setInterval(function () {
      var left = Math.max(0, (endAtMs - nowFn()) / 1000);
      tick(left);
      if (left <= 0 && !ended) { ended = true; clearInterval(t); onEnd(); }
    }, 100);
    return function () { clearInterval(t); };
  }

  App.MG = {
    fmt: fmt, mmss: mmss,
    countdown: countdown, liveBoard: liveBoard, podiumEl: podiumEl,
    endScreen: endScreen, roundTimer: roundTimer,
    MULTI_START_DELAY: 3000     // ms Countdown vor Multiplayer-Start
  };

  UI.injectStyle('mg-util-css', [
    '.mg-cd{padding:50px;text-align:center;display:flex;flex-direction:column;gap:10px;align-items:center;max-width:440px;margin:0 auto;}',
    '.mg-cd-num{font-size:80px;font-weight:900;line-height:1;}',
    '.mg-endscreen{padding:28px;text-align:center;display:flex;flex-direction:column;gap:14px;align-items:center;max-width:540px;margin:0 auto;}',
    '.mg-endscreen .big-readout{color:var(--gold);}'
  ].join(''));
})();
