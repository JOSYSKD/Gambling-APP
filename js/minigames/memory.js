/* memory.js — "Dschungel-Memory": Finde die Tier-Paare.
 * 4×4-Raster (8 Paare) aus Dschungel-Emojis, verdeckt mit Neon-Blatt-Rückseite.
 * Zwei Karten aufdecken: Paar bleibt offen (+Punkte & Zeitbonus), sonst klappen
 * beide zurück (−kleine Strafe). Alle 8 Paare gefunden → sofort frisches Board,
 * so schaffst du in der Rundenzeit (90 s) mehrere Boards.
 * Parallel-Wettbewerb: jeder hat sein EIGENES Board.
 * Singleplayer (Bestwert 'best_memory') + Multiplayer (Countdown, Live-Rangliste,
 * Podest). Alle Timer laufen über App.MG (Wall-Clock) → Tab-Wechsel-sicher. */
(function () {
  'use strict';
  window.App = window.App || {}; App.Minigames = App.Minigames || {};
  var UI = App.UI, el = UI.el, MG = App.MG;

  injectStyle();

  var DURATION = 90;                       // Sekunden Rundenzeit
  var PAIRS = 8;                           // 8 Paare = 16 Karten (4×4)
  var POOL = ['🐒', '🐍', '🦜', '🐆', '🦋', '🐸', '🌴', '🥥', '🐘', '🦎', '🦥', '🌺', '🍌', '🦩'];

  function shuffle(a) {
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  App.Minigames.memory = {
    id: 'memory', title: 'Dschungel-Memory', icon: '🃏', order: 4,
    subtitle: 'Finde die Tier-Paare – so viele wie möglich',
    single: true, multi: true, minPlayers: 2, maxPlayers: 8,

    render: function (root, ctx) {
      var isMulti = ctx.mode === 'multi';
      var nowFn = isMulti ? ctx.room.now : Date.now;

      /* ---- Timer-/Timeout-Verwaltung (cleanup stoppt WIRKLICH alles) ---- */
      var stops = [];                      // App.MG-stop()-Funktionen + room.off
      var timeouts = [];                   // setTimeout-IDs
      var destroyed = false;
      function after(ms, fn) { var t = setTimeout(fn, ms); timeouts.push(t); return t; }
      function clearTimeouts() { timeouts.forEach(clearTimeout); timeouts = []; }
      function clearStops() { stops.forEach(function (f) { try { f(); } catch (e) {} }); stops = []; }
      function clearAll() { clearStops(); clearTimeouts(); }
      function cleanup() { destroyed = true; clearAll(); }

      /* ---- Score-Zustand (über render-Scope, damit finish() ihn liest) ---- */
      var score = 0, pairs = 0, misses = 0, boards = 0, bonus = 0;
      function resetState() { score = 0; pairs = 0; misses = 0; boards = 0; bonus = 0; }
      function computeScore() { return Math.max(0, pairs * 100 + bonus - misses * 10); }

      /* ---- Start: Multi mit 3-2-1-Countdown, Single sofort ---- */
      if (isMulti) {
        var snap = ctx.room.snapshot() || {};
        var startAt = (snap.round && snap.round.startAt) || (ctx.room.now() + (MG.MULTI_START_DELAY || 3000));
        stops.push(MG.countdown(root, startAt, function () { play(startAt); }, ctx.room.now));
      } else {
        play(Date.now());
      }
      return { cleanup: cleanup };

      /* ===================== SPIEL ===================== */
      function play(startAt) {
        clearAll();
        resetState();
        var endAt = startAt + DURATION * 1000;
        var finished = false;

        /* --- Kopf: Score / Paare / Boards / Timer --- */
        var scoreEl = el('b', {}, ['0']);
        var pairsEl = el('b', {}, ['0']);
        var boardsEl = el('b', {}, ['0']);
        var timerEl = el('div', { class: 'mg-timer' }, ['⏱ ' + MG.mmss(DURATION)]);
        var head = el('div', { class: 'mg-mem-head glass' }, [
          el('div', { class: 'mg-mem-stats' }, [
            el('div', { class: 'mg-mem-stat' }, [scoreEl, el('span', {}, ['Punkte'])]),
            el('div', { class: 'mg-mem-stat' }, [pairsEl, el('span', {}, ['Paare'])]),
            el('div', { class: 'mg-mem-stat' }, [boardsEl, el('span', {}, ['Boards'])])
          ]),
          timerEl
        ]);

        /* --- Spielfeld --- */
        var gridEl = el('div', { class: 'mg-mem-grid' });
        var boardBox = el('div', { class: 'mg-mem-board' }, [gridEl]);

        /* --- Live-Rangliste (nur multi) --- */
        var sideCol = null;
        if (isMulti) {
          var lb = MG.liveBoard(ctx.room, ctx.me.id);
          stops.push(lb.stop);
          sideCol = el('div', { class: 'mg-mem-side glass' }, [
            el('div', { class: 'mg-field-title' }, ['🏆 Rangliste']), lb.root
          ]);
        }

        var layout = el('div', { class: 'mg-mem-wrap' }, [
          head,
          el('div', { class: 'mg-mem-cols' }, [boardBox, sideCol])
        ]);
        root.innerHTML = ''; root.appendChild(layout);
        if (isMulti) ctx.room.reportScore(0);

        function onScoreChange() {
          score = computeScore();
          scoreEl.textContent = MG.fmt(score);
          pairsEl.textContent = String(pairs);
          boardsEl.textContent = String(boards);
          if (isMulti && !destroyed) ctx.room.reportScore(score);
        }

        /* --- Board-Logik (jeder hat sein eigenes) --- */
        var cards = [], firstIndex = null, busy = false, foundOnBoard = 0;

        function buildBoard() {
          firstIndex = null; busy = false; foundOnBoard = 0; cards = [];
          var chosen = shuffle(POOL.slice()).slice(0, PAIRS);
          var deck = shuffle(chosen.concat(chosen));
          gridEl.innerHTML = '';
          deck.forEach(function (emoji, i) {
            var card = el('button', { class: 'mg-mem-card', type: 'button' }, [
              el('div', { class: 'mg-mem-inner' }, [
                el('div', { class: 'mg-mem-cover' }),
                el('div', { class: 'mg-mem-face' }, [emoji])
              ])
            ]);
            card.addEventListener('click', function () { onCard(i); });
            gridEl.appendChild(card);
            cards.push({ el: card, emoji: emoji, matched: false });
          });
          // sanftes Rein-Fade des neuen Boards
          gridEl.classList.remove('mg-mem-in'); void gridEl.offsetWidth; gridEl.classList.add('mg-mem-in');
        }

        function onCard(i) {
          if (destroyed || finished || busy) return;
          if (nowFn() >= endAt) return;
          var c = cards[i];
          if (!c || c.matched || c.el.classList.contains('flipped')) return;

          c.el.classList.add('flipped');

          if (firstIndex === null) { firstIndex = i; return; }
          if (firstIndex === i) return;

          var a = cards[firstIndex], b = c;
          var secLeft = Math.max(0, (endAt - nowFn()) / 1000);

          if (a.emoji === b.emoji) {
            /* Treffer */
            a.matched = true; b.matched = true;
            a.el.classList.add('matched'); b.el.classList.add('matched');
            firstIndex = null;
            pairs++; foundOnBoard++;
            bonus += Math.max(0, Math.round(secLeft / 9));   // kleiner Zeitbonus
            popFloat(b.el, '+100');
            if (foundOnBoard >= PAIRS) {
              boards++; bonus += 40;                          // Board-fertig-Bonus
              busy = true;
              UI.toast('Board geschafft! 🌟', 'win');
              after(560, function () {
                if (destroyed || finished || nowFn() >= endAt) return;
                buildBoard();
              });
            }
            onScoreChange();
          } else {
            /* Kein Paar */
            busy = true;
            misses++;
            onScoreChange();
            var fa = firstIndex; firstIndex = null;
            after(700, function () {
              if (destroyed) return;
              if (cards[fa]) cards[fa].el.classList.remove('flipped');
              b.el.classList.remove('flipped');
              busy = false;
            });
          }
        }

        buildBoard();

        /* --- Rundentimer (Wall-Clock, im Multi synchron über room.now) --- */
        stops.push(MG.roundTimer(endAt, function (left) {
          timerEl.textContent = '⏱ ' + MG.mmss(left);
          timerEl.classList.toggle('mg-mem-urgent', left <= 10);
        }, finish, isMulti ? ctx.room.now : null));

        function finish() {
          if (finished) return; finished = true;
          clearAll();
          if (isMulti) {
            ctx.room.reportScore(score);
            after(1200, function () {
              if (destroyed) return;
              MG.endScreen(root, {
                players: ctx.room.players(), meId: ctx.me.id,
                onExit: ctx.onExit, format: MG.fmt
              });
            });
          } else {
            var best = App.Storage.get('best_memory', 0);
            var nb = score > best;
            if (nb) App.Storage.set('best_memory', score);
            MG.endScreen(root, {
              score: score, best: best, newBest: nb, format: MG.fmt,
              label: nb ? 'Neuer Rekord! 🎉' : (pairs + ' Paare · ' + boards + ' Boards · Bestwert: ' + MG.fmt(best)),
              onExit: ctx.onExit,
              onAgain: function () { play(Date.now()); }
            });
          }
        }
      }

      /* Schwebendes "+100" über der getroffenen Karte. */
      function popFloat(anchor, txt) {
        var r = anchor.getBoundingClientRect();
        var f = el('div', { class: 'mg-mem-float', text: txt });
        f.style.left = (r.left + r.width / 2) + 'px';
        f.style.top = (r.top + r.height / 2) + 'px';
        document.body.appendChild(f);
        setTimeout(function () { f.classList.add('go'); }, 10);
        setTimeout(function () { if (f.parentNode) f.parentNode.removeChild(f); }, 850);
      }
    }
  };

  function injectStyle() {
    UI.injectStyle('mg-memory-css', [
      '.mg-mem-wrap{display:flex;flex-direction:column;gap:14px;}',
      '.mg-mem-head{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;padding:12px 18px;}',
      '.mg-mem-stats{display:flex;gap:22px;align-items:center;}',
      '.mg-mem-stat{display:flex;flex-direction:column;line-height:1.05;}',
      '.mg-mem-stat b{font-size:clamp(20px,5vw,26px);color:var(--gold);text-shadow:0 0 12px rgba(255,210,63,.45);}',
      '.mg-mem-stat span{font-size:10px;text-transform:uppercase;letter-spacing:1.5px;color:var(--muted);margin-top:2px;}',
      '.mg-timer.mg-mem-urgent{color:var(--danger);animation:mg-mem-blink .7s steps(2) infinite;}',
      '@keyframes mg-mem-blink{50%{opacity:.4;}}',
      '.mg-mem-cols{display:grid;grid-template-columns:1fr;gap:14px;align-items:start;}',
      '@media(min-width:760px){.mg-mem-cols{grid-template-columns:minmax(0,1fr) 240px;}}',
      '.mg-mem-board{display:flex;justify-content:center;}',
      '.mg-mem-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:clamp(6px,2.2vw,12px);width:min(92vw,440px);}',
      '.mg-mem-grid.mg-mem-in .mg-mem-card{animation:mg-mem-deal .35s ease both;}',
      '.mg-mem-grid.mg-mem-in .mg-mem-card:nth-child(4n+2){animation-delay:.04s;}',
      '.mg-mem-grid.mg-mem-in .mg-mem-card:nth-child(4n+3){animation-delay:.08s;}',
      '.mg-mem-grid.mg-mem-in .mg-mem-card:nth-child(4n){animation-delay:.12s;}',
      '@keyframes mg-mem-deal{from{opacity:0;transform:translateY(10px) scale(.9);}to{opacity:1;transform:none;}}',
      '.mg-mem-card{position:relative;aspect-ratio:1/1;background:none;border:none;padding:0;cursor:pointer;perspective:900px;-webkit-tap-highlight-color:transparent;}',
      '.mg-mem-inner{position:absolute;inset:0;transform-style:preserve-3d;transition:transform .45s cubic-bezier(.2,.7,.3,1.3);}',
      '.mg-mem-card.flipped .mg-mem-inner{transform:rotateY(180deg);}',
      '.mg-mem-cover,.mg-mem-face{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;border-radius:14px;backface-visibility:hidden;-webkit-backface-visibility:hidden;overflow:hidden;}',
      '.mg-mem-cover{background:radial-gradient(circle at 30% 22%,rgba(57,255,20,.20),transparent 62%),repeating-linear-gradient(135deg,#0a2c1c 0 8px,#082418 8px 16px);border:1px solid var(--stroke);box-shadow:inset 0 0 0 1px rgba(57,255,20,.10),0 6px 14px rgba(0,0,0,.42);}',
      '.mg-mem-cover::before{content:"🍃";font-size:clamp(20px,7vw,32px);opacity:.28;filter:drop-shadow(0 0 6px rgba(57,255,20,.55));transform:rotate(-12deg);}',
      '.mg-mem-card:not(.flipped):hover .mg-mem-inner{transform:translateY(-3px);}',
      '.mg-mem-card:not(.flipped):active .mg-mem-inner{transform:scale(.94);}',
      '.mg-mem-face{transform:rotateY(180deg);font-size:clamp(28px,10vw,50px);line-height:1;background:radial-gradient(circle at 50% 35%,rgba(57,255,20,.10),transparent 70%),linear-gradient(150deg,#0e3a24,#0a271a);border:1px solid rgba(57,255,20,.32);box-shadow:inset 0 0 18px rgba(57,255,20,.14);user-select:none;-webkit-user-select:none;}',
      '.mg-mem-card.matched .mg-mem-face{border-color:var(--neon);box-shadow:inset 0 0 22px rgba(57,255,20,.42),0 0 20px rgba(57,255,20,.55);}',
      '.mg-mem-card.matched{animation:mg-mem-glow 1.8s ease-in-out infinite;}',
      '@keyframes mg-mem-glow{0%,100%{transform:scale(1);filter:drop-shadow(0 0 4px rgba(57,255,20,.35));}50%{transform:scale(1.04);filter:drop-shadow(0 0 13px rgba(57,255,20,.8));}}',
      '.mg-mem-side{padding:14px;display:flex;flex-direction:column;gap:8px;}',
      '.mg-mem-side .mg-scoreboard{max-height:320px;overflow-y:auto;}',
      '.mg-mem-float{position:fixed;pointer-events:none;z-index:90;font-weight:900;font-size:22px;color:var(--gold);text-shadow:0 2px 8px rgba(0,0,0,.6);transform:translate(-50%,-50%);transition:all .8s ease-out;opacity:1;}',
      '.mg-mem-float.go{transform:translate(-50%,-140%);opacity:0;}'
    ].join(''));
  }
})();
