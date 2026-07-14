/* bingo.js — "Bingo" (Kategorie „Poker & Casino" / group:'live').
 *
 * Klassisches 75er-Bingo im Neon-Dschungel-Look. Jeder Spieler bekommt eine
 * eigene 5×5-Karte (Spalten B/I/N/G/O), die Mitte ist FREE. Alle ~2,2 s wird
 * eine neue Zahl gezogen, die Karten markieren sich automatisch. Wer als
 * Erster eine volle Reihe/Spalte/Diagonale hat, gewinnt.
 *
 *  SOLO   (ctx.mode==='single'): der Spieler + 3–5 Bots. Es wird einfach
 *         gezogen; der erste mit einer Linie (evtl. ein Bot) gewinnt. Der
 *         Spieler muss nichts anklicken.
 *  MULTI  (ctx.mode==='multi'): HOST-AUTORITATIV. Nur der Host zieht Zahlen und
 *         prüft die Karten, alles läuft über room.setShared. Alle rendern aus
 *         room.on('shared'|'players', …). DOM wird EINMAL gebaut (ensure) und
 *         danach nur noch in-place aktualisiert → kein Flackern.
 *
 * cleanup() stoppt alle Timer und entfernt die Room-Listener. */
(function () {
  'use strict';
  window.App = window.App || {}; App.Minigames = App.Minigames || {};
  var UI = App.UI, el = UI.el;

  injectStyle();

  var COLS = ['B', 'I', 'N', 'G', 'O'];
  var DRAW_MS = 2200;        // Ziehungs-Takt
  var MIN_PLAYERS = 2;

  /* die 12 möglichen Linien einer 5×5-Karte (5 Reihen, 5 Spalten, 2 Diagonalen) */
  var LINES = (function () {
    var L = [], r, c;
    for (r = 0; r < 5; r++) L.push([r * 5, r * 5 + 1, r * 5 + 2, r * 5 + 3, r * 5 + 4]);
    for (c = 0; c < 5; c++) L.push([c, c + 5, c + 10, c + 15, c + 20]);
    L.push([0, 6, 12, 18, 24]);
    L.push([4, 8, 12, 16, 20]);
    return L;
  })();

  /* ---------- reine Bingo-Logik ---------- */
  function pickN(lo, hi, n) {                       // n eindeutige Werte aus [lo..hi]
    var pool = [], v, i, j, t;
    for (v = lo; v <= hi; v++) pool.push(v);
    for (i = pool.length - 1; i > 0; i--) { j = Math.floor(Math.random() * (i + 1)); t = pool[i]; pool[i] = pool[j]; pool[j] = t; }
    return pool.slice(0, n);
  }
  function makeCard() {                             // 25 Zahlen, Mitte (12) = 0 = FREE
    var card = new Array(25), col, row, nums;
    for (col = 0; col < 5; col++) {
      var lo = col * 15 + 1;                        // B 1-15, I 16-30, N 31-45, G 46-60, O 61-75
      nums = pickN(lo, lo + 14, 5);
      for (row = 0; row < 5; row++) card[row * 5 + col] = nums[row];
    }
    card[12] = 0;
    return card;
  }
  function letterOf(n) { return COLS[Math.min(4, Math.floor((n - 1) / 15))]; }
  function toMap(arr) { var m = {}, i; for (i = 0; i < arr.length; i++) m[arr[i]] = true; return m; }
  function isMarked(card, i, map) { return card[i] === 0 || !!map[card[i]]; }     // FREE zählt immer
  function hasLine(card, map) {
    for (var L = 0; L < LINES.length; L++) {
      var ln = LINES[L], ok = true;
      for (var k = 0; k < 5; k++) { if (!isMarked(card, ln[k], map)) { ok = false; break; } }
      if (ok) return true;
    }
    return false;
  }
  function markedCount(card, map) { var c = 0, i; for (i = 0; i < 25; i++) if (isMarked(card, i, map)) c++; return c; }
  function nextNumber(drawn) {                      // zufällige, noch ungezogene Zahl 1-75
    var used = toMap(drawn), pool = [], n;
    for (n = 1; n <= 75; n++) if (!used[n]) pool.push(n);
    if (!pool.length) return null;
    return pool[Math.floor(Math.random() * pool.length)];
  }
  /* erster Spieler mit einer Linie (bei Gleichstand in derselben Ziehung → zufällig) */
  function findWinner(entries, map) {
    var winners = [], i;
    for (i = 0; i < entries.length; i++) if (entries[i].card && hasLine(entries[i].card, map)) winners.push(entries[i].id);
    if (!winners.length) return null;
    return winners[Math.floor(Math.random() * winners.length)];
  }

  /* ---------- gemeinsames Layout (Solo & Multi) — EINMAL bauen ---------- */
  function buildLayout() {
    var head = el('div', { class: 'bg-head' }, COLS.map(function (c) { return el('div', { class: 'bg-hcell' }, [c]); }));
    var grid = el('div', { class: 'bg-grid' });
    var cells = [];
    for (var i = 0; i < 25; i++) { var cell = el('div', { class: 'bg-cell' }); cells.push(cell); grid.appendChild(cell); }
    var cardWrap = el('div', { class: 'bg-card glass' }, [head, grid]);

    var ballLetter = el('div', { class: 'bg-ball-l' }, ['—']);
    var ballNum = el('div', { class: 'bg-ball-n' }, ['?']);
    var ball = el('div', { class: 'bg-ball' }, [ballLetter, ballNum]);
    var drawnCount = el('div', { class: 'bg-drawn-c' }, ['0 / 75 gezogen']);
    var drawnList = el('div', { class: 'bg-drawn' });
    var drawSide = el('div', { class: 'bg-drawside glass' }, [
      el('div', { class: 'bg-label' }, ['Zuletzt gezogen']),
      ball, drawnCount, drawnList
    ]);

    var playersEl = el('div', { class: 'bg-players' });
    var playersWrap = el('div', { class: 'bg-pwrap glass' }, [el('div', { class: 'bg-label' }, ['Mitspieler']), playersEl]);

    var status = el('div', { class: 'bg-status' }, ['']);
    var root = el('div', { class: 'bg-wrap' }, [
      el('div', { class: 'bg-top' }, [el('div', { class: 'bg-brand neon' }, ['🎱 Bingo']), status]),
      el('div', { class: 'bg-main' }, [cardWrap, el('div', { class: 'bg-rightcol' }, [drawSide, playersWrap])])
    ]);

    return {
      root: root, cells: cells, ball: ball, ballLetter: ballLetter, ballNum: ballNum,
      drawnList: drawnList, drawnCount: drawnCount, playersEl: playersEl, status: status,
      _drawnShown: 0, _psig: null, _prows: {}, _lastNum: null
    };
  }

  /* view-model → DOM (in-place, kein Neuaufbau → kein Flackern) */
  function makeVM(myCard, drawn, entries, meId, winnerId) {
    var map = toMap(drawn);
    var last = drawn.length ? drawn[drawn.length - 1] : null;
    var players = entries.map(function (e) {
      return {
        id: e.id, name: e.name, count: markedCount(e.card, map),
        isMe: e.id === meId, isWinner: winnerId ? e.id === winnerId : false
      };
    });
    var status = winnerId ? { text: '🎉 BINGO!', cls: 'win' }
      : (last == null ? { text: 'Zahlen werden gezogen …', cls: '' }
        : { text: drawn.length + ' Zahlen gezogen', cls: '' });
    return { myCard: myCard, drawn: drawn, map: map, last: last, players: players, statusText: status.text, statusCls: status.cls };
  }

  function updateView(refs, vm) {
    var i, cell, free, num, txt, marked;
    for (i = 0; i < 25; i++) {
      cell = refs.cells[i];
      free = vm.myCard ? vm.myCard[i] === 0 : false;
      num = vm.myCard ? vm.myCard[i] : null;
      txt = vm.myCard ? (free ? '★' : String(num)) : '';
      if (cell.textContent !== txt) cell.textContent = txt;
      marked = vm.myCard ? (free || !!vm.map[num]) : false;
      cell.classList.toggle('free', free);
      cell.classList.toggle('marked', marked && !free);
    }
    if (vm.last != null) {
      if (refs._lastNum !== vm.last) {
        refs._lastNum = vm.last;
        refs.ballLetter.textContent = letterOf(vm.last);
        refs.ballNum.textContent = String(vm.last);
        refs.ball.classList.remove('pop'); void refs.ball.offsetWidth; refs.ball.classList.add('pop');
      }
    } else { refs.ballLetter.textContent = '—'; refs.ballNum.textContent = '?'; }

    refs.drawnCount.textContent = vm.drawn.length + ' / 75 gezogen';
    while (refs._drawnShown < vm.drawn.length) {
      var n = vm.drawn[refs._drawnShown];
      refs.drawnList.appendChild(el('span', { class: 'bg-chip' }, [letterOf(n) + n]));
      refs._drawnShown++;
    }

    var sig = vm.players.map(function (p) { return p.id; }).join(',');
    if (refs._psig !== sig) {                       // Spielerliste nur bei Änderung neu bauen
      refs._psig = sig; refs._prows = {}; refs.playersEl.innerHTML = '';
      vm.players.forEach(function (p) {
        var cnt = el('span', { class: 'bg-pcount' }, ['1']);
        var row = el('div', { class: 'bg-prow' + (p.isMe ? ' me' : '') }, [
          el('span', { class: 'bg-pdot' }),
          el('span', { class: 'bg-pname' }, [p.name + (p.isMe ? ' (du)' : '')]),
          cnt
        ]);
        refs._prows[p.id] = { row: row, cnt: cnt };
        refs.playersEl.appendChild(row);
      });
    }
    vm.players.forEach(function (p) {
      var r = refs._prows[p.id]; if (!r) return;
      var t = String(p.count);
      if (r.cnt.textContent !== t) r.cnt.textContent = t;
      r.row.classList.toggle('winner', !!p.isWinner);
    });

    refs.status.textContent = vm.statusText || '';
    refs.status.className = 'bg-status ' + (vm.statusCls || '');
  }

  App.Minigames.bingo = {
    id: 'bingo', title: 'Bingo', icon: '🎱', order: 30,
    subtitle: 'Erster mit einer vollen Reihe gewinnt',
    single: true, multi: true, minPlayers: 2, maxPlayers: 8, group: 'live',

    render: function (root, ctx) {
      var destroyed = false, timers = [];
      function after(ms, fn) { var t = setTimeout(fn, ms); timers.push(t); return t; }
      function clearTimers() { timers.forEach(clearTimeout); timers = []; }

      if (ctx.mode === 'multi' && ctx.room) return renderMulti();
      return renderSingle();

      /* =========================================================
       *  SOLO — Spieler + Bots, lokal (kein Netz)
       * ========================================================= */
      function renderSingle() {
        var refs, state, loop = null;
        start();
        return { cleanup: function () { destroyed = true; clearTimers(); stop(); } };

        function stop() { if (loop) { clearInterval(loop); loop = null; } }
        function start() {
          var name = (ctx.me && ctx.me.name) || 'Du';
          var nBots = 3 + Math.floor(Math.random() * 3);         // 3–5 Bots
          var entries = [{ id: 'me', name: name, card: makeCard() }];
          for (var i = 0; i < nBots; i++) entries.push({ id: 'bot' + i, name: 'Bot ' + (i + 1), card: makeCard() });
          state = { entries: entries, drawn: [], winner: null, done: false };
          refs = buildLayout();
          root.innerHTML = ''; root.appendChild(refs.root);
          paint();
          loop = setInterval(tick, DRAW_MS);
        }
        function tick() {
          if (destroyed || state.done) return;
          var n = nextNumber(state.drawn);
          if (n == null) { finish(null); return; }
          state.drawn.push(n);
          var w = findWinner(state.entries, toMap(state.drawn));
          paint();
          if (w) finish(w);
        }
        function finish(winId) {
          state.done = true; state.winner = winId; stop();
          // Bestenliste: eigener Sieg zählt genau einmal (finish läuft pro Runde nur einmal)
          if (winId === 'me' && App.Scores) App.Scores.winCurrent();
          paint();
          after(1400, function () { if (!destroyed) showEnd(); });
        }
        function paint() {
          updateView(refs, makeVM(state.entries[0].card, state.drawn, state.entries, 'me', state.winner));
        }
        function showEnd() {
          var winId = state.winner, iWon = winId === 'me', winName = '', wc = null;
          for (var i = 0; i < state.entries.length; i++) if (state.entries[i].id === winId) { winName = state.entries[i].name; wc = state.entries[i].card; }
          root.innerHTML = ''; root.appendChild(endPanel(iWon, winName, wc, state.drawn));
        }
      }

      /* =========================================================
       *  MULTI — Host zieht & prüft, alle rendern aus 'shared'
       * ========================================================= */
      function renderMulti() {
        var room = ctx.room, me = ctx.me;
        var lastShared = (room.snapshot() && room.snapshot().shared) || null;
        var curView = null, refs = null, waitRefs = null, initDone = false, loop = null;

        function onShared(sh) { if (destroyed) return; lastShared = sh; sync(); }
        function onPlayers() { if (destroyed) return; sync(); }
        room.on('shared', onShared);
        room.on('players', onPlayers);
        sync();

        return {
          cleanup: function () {
            destroyed = true; clearTimers(); stopLoop();
            room.off('shared', onShared);
            room.off('players', onPlayers);
          }
        };

        function startLoop() { if (!loop) loop = setInterval(hostTick, DRAW_MS); }
        function stopLoop() { if (loop) { clearInterval(loop); loop = null; } }

        function sync() {
          var players = room.players();
          if (players.length < MIN_PLAYERS) { stopLoop(); showWaiting(players); return; }
          var sh = lastShared;
          if (!sh || !sh.cards) {
            if (room.isHost() && !initDone) { initShared(players); return; }
            showWaiting(players, true); return;
          }
          if (sh.done) { stopLoop(); showEndMulti(sh, players); return; }
          if (room.isHost()) startLoop();
          ensureGame();
          var myCard = sh.cards[me.id] || null;
          var entries = players.map(function (p) { return { id: p.id, name: p.name, card: sh.cards[p.id] }; })
            .filter(function (e) { return !!e.card; });
          updateView(refs, makeVM(myCard, sh.drawn || [], entries, me.id, sh.winner || null));
        }

        function initShared(players) {
          initDone = true;
          var cards = {};
          players.forEach(function (p) { cards[p.id] = makeCard(); });
          room.setShared({ cards: cards, drawn: [], winner: null, done: false, startedAt: Date.now() });
        }

        /* nur der Host: eine Zahl ziehen, Karten prüfen, shared schreiben */
        function hostTick() {
          if (destroyed || !room.isHost()) return;
          var sh = lastShared;
          if (!sh || !sh.cards || sh.done) { stopLoop(); return; }
          var players = room.players(), cards = sh.cards, added = false, i;
          for (i = 0; i < players.length; i++) {                 // Nachzügler bekommen eine Karte
            if (!cards[players[i].id]) { if (!added) { cards = Object.assign({}, sh.cards); added = true; } cards[players[i].id] = makeCard(); }
          }
          var drawn = (sh.drawn || []).slice();
          var n = nextNumber(drawn);
          if (n == null) { var p0 = { done: true }; if (added) p0.cards = cards; room.setShared(p0); stopLoop(); return; }
          drawn.push(n);
          var entries = players.map(function (p) { return { id: p.id, card: cards[p.id] }; });
          var winner = findWinner(entries, toMap(drawn));
          var patch = { drawn: drawn };
          if (added) patch.cards = cards;
          if (winner) { patch.winner = winner; patch.done = true; }
          room.setShared(patch);
          if (winner) stopLoop();
        }

        function ensureGame() {
          if (curView === 'game') return;
          curView = 'game';
          refs = buildLayout();
          root.innerHTML = ''; root.appendChild(refs.root);
        }

        function showWaiting(players, starting) {
          if (curView !== 'waiting') {
            curView = 'waiting';
            var count = el('div', { class: 'bg-big neon' }, ['1 / ' + MIN_PLAYERS]);
            var msg = el('p', { class: 'bg-sub' }, ['']);
            waitRefs = { count: count, msg: msg };
            root.innerHTML = '';
            root.appendChild(el('div', { class: 'bg-panel glass' }, [
              el('div', { class: 'bg-wait-icon' }, ['🎱']),
              el('h2', { class: 'neon' }, ['Bingo']),
              count, msg,
              el('div', { class: 'bg-actions' }, [
                el('button', { class: 'btn btn-ghost', type: 'button', onclick: ctx.onExit }, ['Zurück zur Lobby'])
              ])
            ]));
          }
          waitRefs.count.textContent = players.length + ' / ' + MIN_PLAYERS;
          waitRefs.msg.textContent = starting ? 'Spiel startet gleich …' : 'Warte auf Mitspieler …';
        }

        function showEndMulti(sh, players) {
          if (curView === 'end') return;
          curView = 'end';
          players = players || room.players();
          var winId = sh.winner, iWon = winId === me.id, winName = '';
          for (var i = 0; i < players.length; i++) if (players[i].id === winId) winName = players[i].name;
          // Bestenliste: nur der lokale Spieler zählt seinen Sieg; Guard (curView==='end') → genau einmal pro Runde
          if (iWon && App.Scores) App.Scores.winCurrent();
          var wc = sh.cards ? sh.cards[winId] : null;
          root.innerHTML = ''; root.appendChild(endPanel(iWon, winName, wc, sh.drawn || []));
        }
      }

      /* ---------- gemeinsamer Endscreen (Solo & Multi) ---------- */
      function endPanel(iWon, winName, winCard, drawn) {
        var title = iWon ? '🎉 BINGO! Du gewinnst!' : ('🎉 BINGO! ' + (winName || 'Ein Spieler') + ' gewinnt');
        var body = [
          el('div', { class: 'bg-end-emoji' }, ['🎱']),
          el('h2', { class: 'bg-big neon' }, [title]),
          el('p', { class: 'bg-sub' }, [iWon ? 'Volle Reihe — starke Runde!' : 'Nächstes Mal bist du dran!'])
        ];
        if (winCard) body.push(miniCard(winCard, drawn));
        body.push(el('div', { class: 'bg-actions' }, [
          el('button', { class: 'btn btn-primary btn-lg', type: 'button', onclick: ctx.onExit }, ['Zurück zur Lobby'])
        ]));
        return el('div', { class: 'bg-panel bg-panel-' + (iWon ? 'win' : 'lose') + ' glass' }, body);
      }
      function miniCard(card, drawn) {
        var map = toMap(drawn || []);
        var head = el('div', { class: 'bg-head bg-head-sm' }, COLS.map(function (c) { return el('div', { class: 'bg-hcell' }, [c]); }));
        var grid = el('div', { class: 'bg-grid bg-grid-sm' });
        for (var i = 0; i < 25; i++) {
          var free = card[i] === 0, marked = free || !!map[card[i]];
          grid.appendChild(el('div', { class: 'bg-cell bg-cell-sm' + (free ? ' free' : (marked ? ' marked' : '')) }, [free ? '★' : String(card[i])]));
        }
        return el('div', { class: 'bg-card bg-card-sm glass' }, [head, grid]);
      }
    }
  };

  /* ===================== CSS ===================== */
  function injectStyle() {
    UI.injectStyle('mg-bingo-css', [
      '.bg-wrap{display:flex;flex-direction:column;gap:14px;max-width:760px;margin:0 auto;}',
      '.bg-top{display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;}',
      '.bg-brand{font-weight:900;font-size:20px;}',
      '.bg-status{font-weight:800;font-size:14px;color:var(--aqua);min-height:18px;}',
      '.bg-status.win{color:var(--gold);text-shadow:0 0 12px rgba(255,210,63,.5);}',
      '.bg-main{display:flex;gap:16px;align-items:flex-start;flex-wrap:wrap;}',
      '.bg-card{flex:1 1 320px;min-width:280px;padding:14px;display:flex;flex-direction:column;gap:8px;}',
      '.bg-rightcol{flex:1 1 240px;min-width:220px;display:flex;flex-direction:column;gap:14px;}',
      '.bg-head{display:grid;grid-template-columns:repeat(5,1fr);gap:8px;}',
      '.bg-hcell{text-align:center;font-weight:900;font-size:clamp(18px,4.4vw,26px);color:var(--neon);text-shadow:0 0 10px rgba(57,255,20,.5);letter-spacing:1px;}',
      '.bg-grid{display:grid;grid-template-columns:repeat(5,1fr);gap:8px;}',
      '.bg-cell{aspect-ratio:1/1;display:flex;align-items:center;justify-content:center;font-size:clamp(15px,4.4vw,25px);font-weight:800;border-radius:12px;background:rgba(6,24,16,.75);border:2px solid var(--stroke);color:var(--text);user-select:none;-webkit-user-select:none;font-variant-numeric:tabular-nums;transition:transform .15s,box-shadow .25s,border-color .25s,background .25s;}',
      '.bg-cell.marked{background:linear-gradient(160deg,rgba(57,255,20,.28),rgba(57,255,20,.1));border-color:var(--neon);color:#eaffe0;box-shadow:0 0 14px rgba(57,255,20,.35),inset 0 0 10px rgba(57,255,20,.18);animation:bg-pop .25s ease;}',
      '.bg-cell.free{background:linear-gradient(160deg,rgba(255,210,63,.32),rgba(255,210,63,.12));border-color:var(--gold);color:var(--gold);box-shadow:0 0 14px rgba(255,210,63,.4),inset 0 0 10px rgba(255,210,63,.2);}',
      '@keyframes bg-pop{0%{transform:scale(.8)}70%{transform:scale(1.09)}100%{transform:scale(1)}}',
      '.bg-drawside{padding:14px;display:flex;flex-direction:column;gap:8px;align-items:center;text-align:center;}',
      '.bg-label{font-size:12px;font-weight:800;color:var(--leaf);text-transform:uppercase;letter-spacing:1px;align-self:flex-start;}',
      '.bg-ball{width:clamp(96px,26vw,132px);height:clamp(96px,26vw,132px);border-radius:50%;display:flex;flex-direction:column;align-items:center;justify-content:center;background:radial-gradient(circle at 35% 30%,rgba(57,255,20,.35),rgba(4,16,10,.92));border:3px solid var(--neon);box-shadow:0 0 26px rgba(57,255,20,.45),inset 0 0 18px rgba(0,0,0,.5);}',
      '.bg-ball.pop{animation:bg-ballpop .4s ease;}',
      '@keyframes bg-ballpop{0%{transform:scale(.6) rotate(-12deg);}60%{transform:scale(1.12) rotate(6deg);}100%{transform:scale(1) rotate(0);}}',
      '.bg-ball-l{font-size:clamp(13px,3.2vw,17px);font-weight:900;color:var(--neon);letter-spacing:2px;line-height:1;}',
      '.bg-ball-n{font-size:clamp(38px,11vw,58px);font-weight:900;color:#fff;line-height:1;text-shadow:0 0 14px rgba(57,255,20,.6);}',
      '.bg-drawn-c{font-size:12px;color:var(--muted);font-weight:700;}',
      '.bg-drawn{display:flex;flex-wrap:wrap;gap:5px;justify-content:center;max-height:118px;overflow-y:auto;width:100%;}',
      '.bg-chip{font-size:11px;font-weight:800;padding:3px 7px;border-radius:999px;background:rgba(9,32,21,.85);border:1px solid var(--stroke);color:var(--aqua-soft);font-variant-numeric:tabular-nums;}',
      '.bg-pwrap{padding:12px 14px;display:flex;flex-direction:column;gap:8px;}',
      '.bg-players{display:flex;flex-direction:column;gap:6px;}',
      '.bg-prow{display:flex;align-items:center;gap:8px;padding:7px 10px;border-radius:10px;background:rgba(9,32,21,.6);border:1px solid var(--stroke);transition:border-color .2s,box-shadow .2s;}',
      '.bg-prow.me{border-color:var(--stroke-2);box-shadow:var(--glow-soft);}',
      '.bg-prow.winner{border-color:var(--gold);box-shadow:0 0 16px rgba(255,210,63,.45);}',
      '.bg-pdot{width:9px;height:9px;border-radius:50%;background:var(--leaf);flex:0 0 auto;box-shadow:0 0 6px var(--leaf);}',
      '.bg-pname{flex:1;font-weight:700;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.bg-pcount{font-weight:900;color:var(--neon);font-variant-numeric:tabular-nums;font-size:15px;}',
      '.bg-panel{padding:28px 22px;text-align:center;display:flex;flex-direction:column;gap:14px;align-items:center;max-width:520px;margin:0 auto;}',
      '.bg-panel-win{box-shadow:0 0 34px rgba(57,255,20,.35);}',
      '.bg-panel-lose{box-shadow:0 0 30px rgba(255,77,109,.22);}',
      '.bg-big{font-size:clamp(23px,7vw,36px);font-weight:900;line-height:1.15;margin:0;}',
      '.bg-sub{color:var(--muted);margin:0;}',
      '.bg-actions{display:flex;gap:10px;justify-content:center;flex-wrap:wrap;margin-top:4px;}',
      '.bg-wait-icon{font-size:52px;animation:bg-spin 3s linear infinite;filter:drop-shadow(0 0 12px rgba(57,255,20,.4));}',
      '@keyframes bg-spin{to{transform:rotate(360deg);}}',
      '.bg-end-emoji{font-size:56px;filter:drop-shadow(0 0 14px rgba(255,210,63,.5));}',
      '.bg-card-sm{padding:10px;gap:6px;max-width:280px;}',
      '.bg-head-sm .bg-hcell{font-size:14px;}',
      '.bg-grid-sm{gap:5px;}',
      '.bg-cell-sm{font-size:13px;border-radius:8px;border-width:1px;}'
    ].join(''));
  }
})();
