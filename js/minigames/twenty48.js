/* twenty48.js — "2048 Dschungel": klassisches Zahlen-Schiebe-Puzzle auf 4x4.
 * Schiebe alle Kacheln (Pfeiltasten/WASD am Desktop, Wischen am Handy); gleiche
 * Werte verschmelzen (2+2=4 …), der Verschmelzungswert zählt als Punkte. Nach
 * jedem gültigen Zug erscheint eine neue Kachel (2 oder 4). Ist das Brett voll
 * ohne möglichen Zug -> kurze "Voll!"-Meldung, Brett wird geleert (Punkte
 * bleiben) und es geht weiter. Zeitrennen: in 90 s so viele Punkte wie möglich.
 * Parallel-Wettbewerb (alle spielen gleichzeitig). Singleplayer (Bestwert
 * 'best_twenty48') + Multiplayer (Live-Rangliste, Podest). Timer/Countdown über
 * Wall-Clock (App.MG) -> Tab-Wechsel-sicher & im Multi synchron. */
(function () {
  'use strict';
  window.App = window.App || {}; App.Minigames = App.Minigames || {};
  var UI = App.UI, el = UI.el;

  var DURATION = 90;   // s Rundenzeit (fest, Single + Multi)
  var SLIDE = 120;     // ms Slide-/Merge-Animation

  injectStyle();

  App.Minigames.twenty48 = {
    id: 'twenty48', title: '2048 Dschungel', icon: '🧩', order: 16,
    subtitle: 'Schiebe und verschmelze die Kacheln — höchste Punktzahl gewinnt',
    single: true, multi: true, minPlayers: 2, maxPlayers: 8,

    render: function (root, ctx) {
      var isMulti = ctx.mode === 'multi';
      var destroyed = false;
      var stops = [];        // Aufräum-Funktionen (Timer/Listener/Board/Observer)
      var timeouts = [];     // laufende setTimeouts (Slide/Voll-Pause)

      function addStop(fn) { if (fn) stops.push(fn); }
      function after(ms, fn) {
        var id = setTimeout(function () {
          var i = timeouts.indexOf(id); if (i >= 0) timeouts.splice(i, 1);
          fn();
        }, ms);
        timeouts.push(id); return id;
      }
      function clearAll() {
        stops.forEach(function (f) { try { f(); } catch (e) {} }); stops = [];
        timeouts.forEach(clearTimeout); timeouts = [];
      }
      function cleanup() { destroyed = true; clearAll(); }

      /* Start: Multiplayer wartet auf synchronen Countdown, Single legt sofort los. */
      if (isMulti) {
        var snap = ctx.room.snapshot() || {};
        var startAt = (snap.round && snap.round.startAt) || (ctx.room.now() + 3000);
        addStop(App.MG.countdown(root, startAt, function () { play(startAt); }, ctx.room.now));
      } else {
        play(Date.now());
      }
      return { cleanup: cleanup };

      /* ===================== EINE RUNDE ===================== */
      function play(startAt) {
        clearAll();                       // evtl. Countdown-Timer stoppen
        var nowFn = isMulti ? ctx.room.now : Date.now;
        var endAt = startAt + DURATION * 1000;

        /* ---- Rundenzustand ---- */
        var board = empty();              // 4x4 aus Kachel-Objekten | null
        var domTiles = [];                // alle lebenden Kacheln (für Resize)
        var score = 0, maxTile = 0, nextId = 0, lastReport = -1;
        var animating = false, paused = false, finished = false, active = false;

        function empty() { return [[null, null, null, null], [null, null, null, null], [null, null, null, null], [null, null, null, null]]; }

        /* ---- Kopf (Punkte / höchste Kachel / Timer) ---- */
        var scoreEl = el('div', { class: 'tw-score' }, ['0']);
        var maxEl = el('div', { class: 'tw-max' }, ['—']);
        var timerEl = el('div', { class: 'tw-timer' }, ['⏱ ' + App.MG.mmss(DURATION)]);
        var hud = el('div', { class: 'tw-hud glass' }, [
          el('div', { class: 'tw-stat' }, [el('div', { class: 'tw-stat-l' }, ['Punkte']), scoreEl]),
          el('div', { class: 'tw-stat', style: 'align-items:center;' }, [el('div', { class: 'tw-stat-l' }, ['🔥 Höchste']), maxEl]),
          el('div', { class: 'tw-stat', style: 'align-items:flex-end;' }, [el('div', { class: 'tw-stat-l' }, ['Zeit']), timerEl])
        ]);

        /* ---- Spielbrett ---- */
        var gridEl = el('div', { class: 'tw-grid' });
        for (var i = 0; i < 16; i++) gridEl.appendChild(el('div', { class: 'tw-cell' }));
        var tileLayer = el('div', { class: 'tw-tilelayer' });
        var gainEl = el('div', { class: 'tw-gain' }, ['']);
        var fullEl = el('div', { class: 'tw-full' }, [
          el('div', { class: 'tw-full-big' }, ['Voll!']),
          el('div', { class: 'hint-text' }, ['Frisches Brett …'])
        ]);
        var boardEl = el('div', { class: 'tw-board' }, [gridEl, tileLayer, gainEl, fullEl]);
        var stage = el('div', { class: 'tw-stage' }, [boardEl]);

        var hintEl = el('div', { class: 'tw-hint hint-text' }, ['↑ ↓ ← →  /  W A S D  ·  am Handy: wischen']);

        /* ---- Seiten-Rangliste (multi) ---- */
        var side = null;
        if (isMulti) side = el('div', { class: 'tw-side glass' }, [el('div', { class: 'mg-field-title' }, ['🏆 Rangliste'])]);

        var layout = el('div', { class: 'tw-play' + (isMulti ? ' has-board' : '') }, [hud, stage, hintEl, side]);
        root.innerHTML = ''; root.appendChild(layout);

        if (isMulti) {
          var lb = App.MG.liveBoard(ctx.room, ctx.me.id);
          side.appendChild(lb.root);
          addStop(lb.stop);
          ctx.room.reportScore(0);
        }

        /* ===================== DARSTELLUNG / KACHELN ===================== */
        function makeTile(value, r, c) {
          var inner = el('div', { class: 'tw-inner' }, [String(value)]);
          var e = el('div', { class: 'tw-tile' }, [inner]);
          e.dataset.v = value;
          if (value > 2048) e.classList.add('tw-super');
          return { id: ++nextId, value: value, r: r, c: c, el: e, inner: inner };
        }
        function setFont(t, w) {
          var d = String(t.value).length;
          t.inner.style.fontSize = (w * (d <= 2 ? 0.46 : d === 3 ? 0.36 : 0.28)).toFixed(1) + 'px';
        }
        /* Kachel an ihre logische Position (r,c) setzen. animate=false -> ohne Slide. */
        function place(t, animate) {
          var cell = gridEl.children[t.r * 4 + t.c];
          if (!cell) return;
          var w = cell.offsetWidth;
          if (!animate) t.el.classList.add('tw-noanim');
          t.el.style.width = w + 'px'; t.el.style.height = w + 'px';
          t.el.style.transform = 'translate(' + cell.offsetLeft + 'px,' + cell.offsetTop + 'px)';
          setFont(t, w);
          if (!animate) { void t.el.offsetWidth; t.el.classList.remove('tw-noanim'); }
        }
        function layoutAll() { domTiles.forEach(function (t) { place(t, false); }); }
        function setValue(t, val) {
          t.value = val; t.el.dataset.v = val; t.inner.textContent = String(val);
          t.el.classList.toggle('tw-super', val > 2048);
          var w = gridEl.children[t.r * 4 + t.c]; setFont(t, w ? w.offsetWidth : 60);
          if (val > maxTile) { maxTile = val; maxEl.textContent = String(maxTile); }
        }
        function pop(t) {
          t.inner.classList.remove('tw-pop'); void t.inner.offsetWidth; t.inner.classList.add('tw-pop');
          after(220, function () { t.inner.classList.remove('tw-pop'); });
        }
        function removeTile(t) {
          var i = domTiles.indexOf(t); if (i >= 0) domTiles.splice(i, 1);
          if (t.el.parentNode) t.el.parentNode.removeChild(t.el);
        }
        function spawnTile() {
          var empties = [];
          for (var r = 0; r < 4; r++) for (var c = 0; c < 4; c++) if (!board[r][c]) empties.push({ r: r, c: c });
          if (!empties.length) return null;
          var p = empties[Math.floor(Math.random() * empties.length)];
          var val = Math.random() < 0.9 ? 2 : 4;
          var t = makeTile(val, p.r, p.c);
          board[p.r][p.c] = t; domTiles.push(t); tileLayer.appendChild(t.el);
          place(t, false);
          if (val > maxTile) { maxTile = val; maxEl.textContent = String(maxTile); }
          t.inner.classList.add('tw-spawnin');
          after(220, function () { t.inner.classList.remove('tw-spawnin'); });
          return t;
        }
        function clearBoard() {
          domTiles.slice().forEach(function (t) { if (t.el.parentNode) t.el.parentNode.removeChild(t.el); });
          domTiles = []; board = empty();
        }

        /* ===================== SCHIEBE-LOGIK ===================== */
        function getLines(dir) {
          var lines = [];
          for (var i = 0; i < 4; i++) {
            var cells = [];
            for (var j = 0; j < 4; j++) {
              var r, c;
              if (dir === 'left') { r = i; c = j; }
              else if (dir === 'right') { r = i; c = 3 - j; }
              else if (dir === 'up') { r = j; c = i; }
              else { r = 3 - j; c = i; }   // down
              cells.push({ r: r, c: c });
            }
            lines.push(cells);
          }
          return lines;
        }
        /* Zug berechnen + Brett aktualisieren. Kein Doppel-Merge in einem Zug
           (jede Kachel verschmilzt höchstens einmal, da i += 2). */
        function computeMove(dir) {
          var lines = getLines(dir);
          var nb = empty();
          var moved = false, gain = 0, survivors = [], losers = [], merged = [];
          lines.forEach(function (cells) {
            var seq = [];
            cells.forEach(function (p) { var t = board[p.r][p.c]; if (t) seq.push(t); });
            var out = [], i = 0;
            while (i < seq.length) {
              if (i + 1 < seq.length && seq[i].value === seq[i + 1].value) {
                out.push({ s: seq[i], l: seq[i + 1] }); i += 2;
              } else { out.push({ s: seq[i], l: null }); i += 1; }
            }
            out.forEach(function (entry, idx) {
              var cell = cells[idx], t = entry.s;
              if (t.r !== cell.r || t.c !== cell.c) moved = true;
              t.r = cell.r; t.c = cell.c;
              nb[cell.r][cell.c] = t; survivors.push(t);
              if (entry.l) {
                moved = true;
                entry.l.r = cell.r; entry.l.c = cell.c; losers.push(entry.l);
                t._pending = t.value * 2; merged.push(t); gain += t.value * 2;
              }
            });
          });
          if (moved) board = nb;
          return { moved: moved, gain: gain, survivors: survivors, losers: losers, merged: merged };
        }
        function canMove() {
          for (var r = 0; r < 4; r++) for (var c = 0; c < 4; c++) {
            if (!board[r][c]) return true;
            var v = board[r][c].value;
            if (c < 3 && board[r][c + 1] && board[r][c + 1].value === v) return true;
            if (r < 3 && board[r + 1][c] && board[r + 1][c].value === v) return true;
          }
          return false;
        }

        function doMove(dir) {
          if (!active || finished || animating || paused || destroyed) return;
          var now = nowFn();
          if (now < startAt || now >= endAt) return;
          var res = computeMove(dir);
          if (!res.moved) return;
          animating = true;
          res.survivors.forEach(function (t) { place(t, true); });
          res.losers.forEach(function (l) { place(l, true); });
          if (res.gain > 0) { score += res.gain; renderScore(); showGain(res.gain); }
          if (App.Audio) {
            if (res.merged.length) {
              var mv = 0;
              res.merged.forEach(function (t) { if (t._pending > mv) mv = t._pending; });
              var semis = Math.min(24, Math.round(Math.log(mv) / Math.LN2) * 2);   // Tonhöhe steigt mit dem Verschmelzungswert
              App.Audio.blip(261.63 * Math.pow(2, semis / 12), 0.13, { type: 'triangle', peak: 0.12 });
            } else {
              App.Audio.sfx('step');   // Zug ohne Merge: leiser Schub
            }
          }
          if (isMulti && score !== lastReport) { lastReport = score; ctx.room.reportScore(score); }
          after(SLIDE, function () {
            res.losers.forEach(removeTile);
            res.merged.forEach(function (t) { var v = t._pending; delete t._pending; setValue(t, v); pop(t); });
            spawnTile();
            animating = false;
            if (!canMove()) handleFull();
          });
        }
        function handleFull() {
          paused = true;
          fullEl.classList.add('show');
          after(950, function () {
            fullEl.classList.remove('show');
            if (!active || finished || destroyed) return;
            clearBoard(); spawnTile(); spawnTile();
            paused = false;
          });
        }

        /* ---- kleine Anzeigen ---- */
        function renderScore() {
          scoreEl.textContent = App.MG.fmt(score);
          scoreEl.classList.remove('bump'); void scoreEl.offsetWidth; scoreEl.classList.add('bump');
        }
        function showGain(n) {
          gainEl.textContent = '+' + App.MG.fmt(n);
          gainEl.classList.remove('go'); void gainEl.offsetWidth; gainEl.classList.add('go');
        }

        /* ===================== EINGABEN ===================== */
        function onKey(e) {
          var k = e.key, dir = null;
          if (k === 'ArrowUp' || k === 'w' || k === 'W') dir = 'up';
          else if (k === 'ArrowDown' || k === 's' || k === 'S') dir = 'down';
          else if (k === 'ArrowLeft' || k === 'a' || k === 'A') dir = 'left';
          else if (k === 'ArrowRight' || k === 'd' || k === 'D') dir = 'right';
          if (dir) { e.preventDefault(); doMove(dir); }
        }
        document.addEventListener('keydown', onKey);
        addStop(function () { document.removeEventListener('keydown', onKey); });

        var tsx = 0, tsy = 0, touching = false;
        function onTS(e) { var t = e.touches[0]; if (!t) return; tsx = t.clientX; tsy = t.clientY; touching = true; }
        function onTM(e) { if (touching) e.preventDefault(); }   // Seiten-Scroll verhindern
        function onTE(e) {
          if (!touching) return; touching = false;
          var t = e.changedTouches && e.changedTouches[0]; if (!t) return;
          var dx = t.clientX - tsx, dy = t.clientY - tsy, ax = Math.abs(dx), ay = Math.abs(dy);
          if (Math.max(ax, ay) < 24) return;
          doMove(ax > ay ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up'));
        }
        boardEl.addEventListener('touchstart', onTS, { passive: false });
        boardEl.addEventListener('touchmove', onTM, { passive: false });
        boardEl.addEventListener('touchend', onTE);
        addStop(function () {
          boardEl.removeEventListener('touchstart', onTS);
          boardEl.removeEventListener('touchmove', onTM);
          boardEl.removeEventListener('touchend', onTE);
        });

        /* ---- Resize: Kacheln neu positionieren ---- */
        if (typeof ResizeObserver !== 'undefined') {
          var ro = new ResizeObserver(function () { layoutAll(); });
          ro.observe(boardEl);
          addStop(function () { ro.disconnect(); });
        } else {
          var onResize = function () { layoutAll(); };
          window.addEventListener('resize', onResize);
          addStop(function () { window.removeEventListener('resize', onResize); });
        }

        /* ---- Rundentimer (Wall-Clock, im Multi synchron) ---- */
        addStop(App.MG.roundTimer(endAt, function (left) {
          var secs = Math.ceil(left);
          timerEl.textContent = '⏱ ' + App.MG.mmss(secs);
          if (secs <= 10) timerEl.classList.add('urgent');
        }, finish, isMulti ? ctx.room.now : null));

        /* ---- Brett aufbauen (nach Layout, damit Zellen-Maße stimmen) ---- */
        requestAnimationFrame(function () {
          if (destroyed || finished) return;
          layoutAll();
          spawnTile(); spawnTile();
          active = true;
        });

        /* ===================== ENDE ===================== */
        function finish() {
          if (finished) return; finished = true; active = false;
          clearAll();
          if (isMulti) {
            ctx.room.reportScore(score);
            var to = setTimeout(function () {
              if (destroyed) return;
              App.MG.endScreen(root, { players: ctx.room.players(), meId: ctx.me.id, onExit: ctx.onExit });
            }, 1200);
            stops.push(function () { clearTimeout(to); });
          } else {
            var best = App.Storage.get('best_twenty48', 0);
            var nb = score > best;
            if (nb) App.Storage.set('best_twenty48', score);
            App.MG.endScreen(root, {
              title: 'Zeit um! ⏱',
              score: score, best: best, newBest: nb,
              label: '🔥 Höchste Kachel: ' + maxTile + (nb ? ' · Neuer Rekord! 🎉' : ' · Bestwert: ' + App.MG.fmt(best)),
              onExit: ctx.onExit,
              onAgain: function () { play(Date.now()); }
            });
          }
        }
      }
    }
  };

  /* ============================ STYLES ============================ */
  function injectStyle() {
    UI.injectStyle('mg-twenty48-css', [
      /* Layout */
      '.tw-play{display:flex;flex-direction:column;gap:14px;}',
      '@media(min-width:820px){.tw-play.has-board{display:grid;grid-template-columns:1fr 260px;grid-template-areas:"hud hud" "stage side" "hint side";align-items:start;column-gap:16px;}',
      '.tw-play.has-board .tw-hud{grid-area:hud;}.tw-play.has-board .tw-stage{grid-area:stage;}.tw-play.has-board .tw-hint{grid-area:hint;}.tw-play.has-board .tw-side{grid-area:side;}}',
      /* Kopf */
      '.tw-hud{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 18px;flex-wrap:wrap;}',
      '.tw-stat{display:flex;flex-direction:column;gap:2px;}',
      '.tw-stat-l{font-size:11px;text-transform:uppercase;letter-spacing:1px;color:var(--muted);font-weight:800;white-space:nowrap;}',
      '.tw-score{font-size:clamp(26px,7vw,40px);font-weight:900;line-height:1;color:var(--leaf);text-shadow:0 0 14px rgba(57,255,20,.4);font-variant-numeric:tabular-nums;}',
      '.tw-score.bump{animation:tw-bump .18s ease;}',
      '@keyframes tw-bump{0%{transform:scale(1)}50%{transform:scale(1.14)}100%{transform:scale(1)}}',
      '.tw-max{font-size:22px;font-weight:900;line-height:1;color:var(--gold);text-shadow:0 0 12px rgba(255,210,63,.4);font-variant-numeric:tabular-nums;}',
      '.tw-timer{font-size:clamp(22px,6vw,34px);font-weight:900;line-height:1;color:var(--aqua-soft);text-shadow:0 0 14px rgba(51,230,208,.4);font-variant-numeric:tabular-nums;}',
      '.tw-timer.urgent{color:var(--danger);text-shadow:0 0 16px rgba(255,77,109,.6);animation:tw-blink .5s steps(2,end) infinite;}',
      '@keyframes tw-blink{50%{opacity:.4;}}',
      /* Bühne + Brett */
      '.tw-stage{display:flex;justify-content:center;}',
      '.tw-board{position:relative;width:min(92vw,440px);max-width:100%;aspect-ratio:1/1;margin:0 auto;--gap:clamp(7px,2.4vw,13px);',
      'background:rgba(6,22,14,.85);border:1px solid var(--stroke);border-radius:18px;box-shadow:inset 0 0 30px rgba(0,0,0,.45),0 0 30px rgba(57,255,20,.08);',
      'touch-action:none;-webkit-user-select:none;user-select:none;}',
      '.tw-grid,.tw-tilelayer{position:absolute;top:var(--gap);left:var(--gap);right:var(--gap);bottom:var(--gap);}',
      '.tw-grid{display:grid;grid-template-columns:repeat(4,1fr);grid-template-rows:repeat(4,1fr);gap:var(--gap);}',
      '.tw-cell{border-radius:12px;background:rgba(255,255,255,.045);border:1px solid rgba(255,255,255,.03);}',
      '.tw-tilelayer{pointer-events:none;}',
      /* Kacheln */
      '.tw-tile{position:absolute;top:0;left:0;width:60px;height:60px;transform:translate(0,0);transition:transform .12s cubic-bezier(.2,.7,.3,1);will-change:transform;}',
      '.tw-tile.tw-noanim{transition:none!important;}',
      '.tw-inner{position:absolute;inset:0;border-radius:12px;display:flex;align-items:center;justify-content:center;font-weight:900;line-height:1;',
      'font-variant-numeric:tabular-nums;background:#0f3626;color:#8fe89a;transition:background .12s,color .12s,box-shadow .12s;}',
      '.tw-inner.tw-pop{animation:tw-pop .2s ease;}',
      '@keyframes tw-pop{0%{transform:scale(1)}45%{transform:scale(1.18)}100%{transform:scale(1)}}',
      '.tw-inner.tw-spawnin{animation:tw-spawn .2s ease;}',
      '@keyframes tw-spawn{0%{transform:scale(0)}70%{transform:scale(1.12)}100%{transform:scale(1)}}',
      /* Neon-Dschungel-Farbskala */
      '.tw-tile[data-v="2"] .tw-inner{background:#0f3626;color:#8fe89a;}',
      '.tw-tile[data-v="4"] .tw-inner{background:#134a30;color:#a9f39a;}',
      '.tw-tile[data-v="8"] .tw-inner{background:#166b39;color:#dcffcf;box-shadow:inset 0 0 18px rgba(57,255,20,.15);}',
      '.tw-tile[data-v="16"] .tw-inner{background:#1a9142;color:#fff;box-shadow:inset 0 0 20px rgba(57,255,20,.2);}',
      '.tw-tile[data-v="32"] .tw-inner{background:#23b84e;color:#04170d;box-shadow:0 0 14px rgba(57,255,20,.3);}',
      '.tw-tile[data-v="64"] .tw-inner{background:#39ff14;color:#04170d;box-shadow:0 0 22px rgba(57,255,20,.55);}',
      '.tw-tile[data-v="128"] .tw-inner{background:#2fe6c2;color:#04170d;box-shadow:0 0 20px rgba(51,230,208,.5);}',
      '.tw-tile[data-v="256"] .tw-inner{background:#33e6d0;color:#04170d;box-shadow:0 0 24px rgba(51,230,208,.6);}',
      '.tw-tile[data-v="512"] .tw-inner{background:#9af0c8;color:#04170d;box-shadow:0 0 26px rgba(154,240,200,.6);}',
      '.tw-tile[data-v="1024"] .tw-inner{background:#ffd23f;color:#3a2a00;box-shadow:0 0 26px rgba(255,210,63,.6);}',
      '.tw-tile[data-v="2048"] .tw-inner{background:#ffe36b;color:#3a2a00;box-shadow:0 0 34px rgba(255,210,63,.85);}',
      '.tw-tile.tw-super .tw-inner{background:linear-gradient(135deg,#39ff14,#33e6d0,#ffd23f);color:#04170d;box-shadow:0 0 38px rgba(57,255,20,.8);}',
      /* Punkte-Popup + Voll-Overlay */
      '.tw-gain{position:absolute;top:6px;left:50%;transform:translateX(-50%);font-weight:900;font-size:clamp(20px,5vw,28px);color:var(--neon);text-shadow:0 2px 10px rgba(0,0,0,.65);pointer-events:none;opacity:0;z-index:6;}',
      '.tw-gain.go{animation:tw-gainfloat .7s ease-out;}',
      '@keyframes tw-gainfloat{0%{opacity:1;transform:translate(-50%,0)}100%{opacity:0;transform:translate(-50%,-44px)}}',
      '.tw-full{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;border-radius:18px;',
      'background:rgba(4,16,10,.82);opacity:0;pointer-events:none;transition:opacity .18s;z-index:8;}',
      '.tw-full.show{opacity:1;}',
      '.tw-full-big{font-size:clamp(34px,11vw,62px);font-weight:900;color:var(--danger);text-shadow:0 0 22px rgba(255,77,109,.6);}',
      /* Hinweis + Seiten-Board */
      '.tw-hint{text-align:center;}',
      '.tw-side{padding:14px;display:flex;flex-direction:column;gap:10px;}'
    ].join(''));
  }
})();
