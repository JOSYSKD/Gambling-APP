/* tictactoe.js — "Tic-Tac-Toe" (Drei gewinnt): rundenbasiertes 2-Spieler-Duell
 * im Neon-Dschungel-Look.  X = 🌺 (Blüte), O = 🍃 (Blatt).  Best of 5 mit
 * sichtbarem Punktestand und leuchtender Sieglinie.
 *
 *  SOLO   (ctx.mode==='single'): gegen einen near-optimalen Bot (Minimax mit
 *         20 % Zufallszug, damit der Spieler auch gewinnen kann). Spieler = X.
 *  MULTI  (ctx.mode==='multi'):  Host hält den Zustand via room.setShared
 *         ({board, turn, winner, winline, scores, round, ...}); beide hören
 *         room.on('shared', ...) und rendern daraus. Spieler[0]=X, Spieler[1]=O.
 *
 * cleanup() stoppt alle Timeouts und entfernt die Room-Listener. */
(function () {
  'use strict';
  window.App = window.App || {}; App.Minigames = App.Minigames || {};
  var UI = App.UI, el = UI.el;

  injectStyle();

  var X = 'X', O = 'O';
  var MARKS = { X: '🌺', O: '🍃' };
  var LINES = [
    [0, 1, 2], [3, 4, 5], [6, 7, 8],
    [0, 3, 6], [1, 4, 7], [2, 5, 8],
    [0, 4, 8], [2, 4, 6]
  ];
  var WIN_TARGET = 3, MAX_ROUNDS = 5;

  /* ---------- reine Brett-Logik ---------- */
  function blank() { return ['', '', '', '', '', '', '', '', '']; }
  function emptyCells(b) { var r = []; for (var i = 0; i < 9; i++) if (b[i] === '') r.push(i); return r; }
  function winnerOf(b) {
    for (var i = 0; i < LINES.length; i++) {
      var a = LINES[i][0], c = LINES[i][1], d = LINES[i][2];
      if (b[a] && b[a] === b[c] && b[a] === b[d]) return { mark: b[a], line: LINES[i] };
    }
    return null;
  }
  /* Minimax (mit Tiefe → schnelle Siege / späte Niederlagen bevorzugen) */
  function minimax(b, current, ai, human, depth) {
    var w = winnerOf(b);
    if (w) return w.mark === ai ? (10 - depth) : (depth - 10);
    var empty = emptyCells(b);
    if (empty.length === 0) return 0;
    var i, val, best;
    if (current === ai) {
      best = -Infinity;
      for (i = 0; i < empty.length; i++) { b[empty[i]] = current; val = minimax(b, human, ai, human, depth + 1); b[empty[i]] = ''; if (val > best) best = val; }
    } else {
      best = Infinity;
      for (i = 0; i < empty.length; i++) { b[empty[i]] = current; val = minimax(b, ai, ai, human, depth + 1); b[empty[i]] = ''; if (val < best) best = val; }
    }
    return best;
  }
  function bestMove(b, ai, human) {
    var empty = emptyCells(b), best = -Infinity, move = empty[0], i, val;
    for (i = 0; i < empty.length; i++) { b[empty[i]] = ai; val = minimax(b, human, ai, human, 0); b[empty[i]] = ''; if (val > best) { best = val; move = empty[i]; } }
    return move;
  }
  function botMove(b, ai, human) {
    var empty = emptyCells(b);
    if (empty.length === 0) return -1;
    if (Math.random() < 0.2) return empty[Math.floor(Math.random() * empty.length)]; // 20 % Zufall
    return bestMove(b, ai, human);
  }

  /* ---------- gemeinsames Spiel-Layout (für Solo & Multi) ---------- */
  function buildGameLayout(onCell) {
    var roundEl = el('div', { class: 'tt-round' }, ['Runde 1 / ' + MAX_ROUNDS]);
    var top = el('div', { class: 'tt-top' }, [
      el('div', { class: 'tt-brand neon' }, ['⭕ Tic-Tac-Toe']), roundEl
    ]);

    var xNameEl = el('div', { class: 'tt-nm' }, ['—']);
    var xScoreEl = el('div', { class: 'tt-sc' }, ['0']);
    var xChip = el('div', { class: 'tt-chip tt-chip-x' }, [
      el('span', { class: 'tt-sym' }, [MARKS.X]),
      el('div', { class: 'tt-info' }, [xNameEl, el('div', { class: 'tt-mini' }, ['Blüte'])]),
      xScoreEl
    ]);
    var oNameEl = el('div', { class: 'tt-nm' }, ['—']);
    var oScoreEl = el('div', { class: 'tt-sc' }, ['0']);
    var oChip = el('div', { class: 'tt-chip tt-chip-o' }, [
      el('span', { class: 'tt-sym' }, [MARKS.O]),
      el('div', { class: 'tt-info' }, [oNameEl, el('div', { class: 'tt-mini' }, ['Blatt'])]),
      oScoreEl
    ]);
    var scores = el('div', { class: 'tt-scores' }, [xChip, oChip]);

    var statusEl = el('div', { class: 'tt-status you' }, ['']);

    var grid = el('div', { class: 'tt-grid' });
    var cells = [];
    for (var i = 0; i < 9; i++) {
      (function (idx) {
        var c = el('button', { class: 'tt-cell', type: 'button', onclick: function () { onCell(idx); } });
        cells.push(c); grid.appendChild(c);
      })(i);
    }

    var wrap = el('div', { class: 'tt-wrap' }, [top, scores, statusEl, grid]);
    return {
      root: wrap, roundEl: roundEl, statusEl: statusEl, grid: grid, cells: cells,
      xChip: xChip, xNameEl: xNameEl, xScoreEl: xScoreEl,
      oChip: oChip, oNameEl: oNameEl, oScoreEl: oScoreEl
    };
  }

  /* view-model → DOM (in-place, kein Neuaufbau → kein Flackern) */
  function updateView(refs, vm) {
    refs.roundEl.textContent = 'Runde ' + vm.round + ' / ' + MAX_ROUNDS;
    refs.xNameEl.textContent = vm.xName;
    refs.oNameEl.textContent = vm.oName;
    refs.xScoreEl.textContent = vm.xScore;
    refs.oScoreEl.textContent = vm.oScore;
    refs.xChip.classList.toggle('active', vm.turn === X);
    refs.oChip.classList.toggle('active', vm.turn === O);
    refs.xChip.classList.toggle('me', !!vm.showMe && vm.myMark === X);
    refs.oChip.classList.toggle('me', !!vm.showMe && vm.myMark === O);

    refs.statusEl.textContent = vm.status.text;
    refs.statusEl.className = 'tt-status ' + vm.status.cls;

    var myTurn = vm.turn === vm.myMark && !vm.winner;
    refs.grid.classList.toggle('clickable', !!myTurn);

    for (var i = 0; i < 9; i++) {
      var cell = refs.cells[i], m = vm.board[i];
      var wanted = m ? MARKS[m] : '';
      if (cell.textContent !== wanted) cell.textContent = wanted;
      cell.classList.toggle('x', m === X);
      cell.classList.toggle('o', m === O);
      cell.classList.toggle('filled', m !== '');
      cell.classList.toggle('win', !!(vm.winline && vm.winline.indexOf(i) >= 0));
    }
  }

  App.Minigames.tictactoe = {
    id: 'tictactoe', title: 'Tic-Tac-Toe', icon: '⭕', order: 19,
    subtitle: 'Drei in einer Reihe — schnelles Duell zu zweit',
    single: true, multi: true, minPlayers: 2, maxPlayers: 2,

    render: function (root, ctx) {
      var destroyed = false, timers = [];
      function after(ms, fn) { var t = setTimeout(fn, ms); timers.push(t); return t; }
      function clearTimers() { timers.forEach(clearTimeout); timers = []; }

      if (ctx.mode === 'multi' && ctx.room) return renderMulti();
      return renderSingle();

      /* =========================================================
       *  SOLO — gegen den Bot, kein Netz
       * ========================================================= */
      function renderSingle() {
        var st, refs;
        startSeries();
        return { cleanup: function () { destroyed = true; clearTimers(); } };

        function fresh() {
          return { board: blank(), turn: X, starter: X, scores: { X: 0, O: 0 }, round: 1, winner: null, winline: null };
        }
        function startSeries() {
          clearTimers();
          st = fresh();
          refs = buildGameLayout(onCell);
          root.innerHTML = ''; root.appendChild(refs.root);
          paint();
          if (st.turn === O) scheduleBot();
        }
        function onCell(i) {
          if (destroyed || st.winner) return;
          if (st.turn !== X) return;          // nur der Mensch setzt 🌺
          if (st.board[i] !== '') return;
          place(i, X);
        }
        function place(i, mark) {
          st.board[i] = mark;
          var w = winnerOf(st.board);
          if (w) return endRound(mark, w.line);
          if (emptyCells(st.board).length === 0) return endRound('draw', null);
          st.turn = (mark === X) ? O : X;
          paint();
          if (st.turn === O) scheduleBot();
        }
        function scheduleBot() {
          after(560, function () {
            if (destroyed || st.winner || st.turn !== O) return;
            var m = botMove(st.board.slice(), O, X);
            if (m >= 0) place(m, O);
          });
        }
        function endRound(mark, line) {
          st.winner = mark; st.winline = line;
          if (mark === X) st.scores.X++; else if (mark === O) st.scores.O++;
          paint();
          var over = seriesOver(st.scores, st.round);
          after(over ? 1600 : 1700, function () {
            if (destroyed) return;
            if (over) showEnd(); else nextRound();
          });
        }
        function nextRound() {
          st.starter = (st.starter === X) ? O : X;
          st.board = blank(); st.winner = null; st.winline = null;
          st.turn = st.starter; st.round++;
          paint();
          if (st.turn === O) scheduleBot();
        }
        function paint() {
          var over = st.winner ? seriesOver(st.scores, st.round) : false;
          updateView(refs, {
            round: st.round, xName: 'Du', oName: 'Bot',
            xScore: st.scores.X, oScore: st.scores.O,
            myMark: X, showMe: false,
            board: st.board, winline: st.winline,
            winner: st.winner,
            turn: st.winner ? null : st.turn,
            status: soloStatus(st, over)
          });
        }
        function showEnd() {
          var res = seriesResultMark(st.scores);   // 'X' | 'O' | 'draw'
          var mine = res === X ? 'win' : res === O ? 'lose' : 'draw';
          if (mine === 'win' && App.Scores) App.Scores.winCurrent();  // Serien-Sieg zählen
          root.innerHTML = '';
          root.appendChild(endPanel(mine, {
            xName: 'Du', oName: 'Bot', xScore: st.scores.X, oScore: st.scores.O, myMark: X
          }, [
            el('button', { class: 'btn btn-primary btn-lg', type: 'button', onclick: function () { startSeries(); } }, ['Nochmal']),
            el('button', { class: 'btn btn-ghost btn-lg', type: 'button', onclick: ctx.onExit }, ['Zurück'])
          ]));
        }
      }

      /* =========================================================
       *  MULTI — Host hält den Zustand, beide rendern aus 'shared'
       * ========================================================= */
      function renderMulti() {
        var room = ctx.room, me = ctx.me;
        var lastShared = (room.snapshot() && room.snapshot().shared) || null;
        var curView = null, refs = null, waitRefs = null, initDone = false, pendingAdvanceRound = -1;

        function onShared(sh) { if (destroyed) return; lastShared = sh; sync(); }
        function onPlayers() { if (destroyed) return; sync(); }
        room.on('shared', onShared);
        room.on('players', onPlayers);
        sync();

        return {
          cleanup: function () {
            destroyed = true; clearTimers();
            room.off('shared', onShared);
            room.off('players', onPlayers);
          }
        };

        /* ---- Symbol-Zuordnung aus shared.order ---- */
        function symOf(id, sh) { var i = sh && sh.order ? sh.order.indexOf(id) : -1; return i === 0 ? X : i === 1 ? O : null; }
        function otherId(id, sh) { return sh.order[0] === id ? sh.order[1] : sh.order[0]; }
        function playerById(players, id) { for (var i = 0; i < players.length; i++) if (players[i].id === id) return players[i]; return null; }

        function sync() {
          var players = room.players();
          if (players.length < 2) { showWaiting(players); return; }
          var sh = lastShared;
          if (!sh || !sh.board) {
            if (room.isHost() && !initDone) { initShared(players); return; }
            showWaiting(players, true); return;
          }
          if (sh.seriesOver) { showEnd(sh, players); return; }
          ensureGame();
          updateView(refs, multiVM(sh, players));
          maybeAdvance(sh);
        }

        function initShared(players) {
          initDone = true;
          var xId = players[0].id, oId = players[1].id;
          var scores = {}; scores[xId] = 0; scores[oId] = 0;
          room.setShared({
            order: [xId, oId], board: blank(), turn: xId, starter: xId,
            winner: null, winline: null, scores: scores, round: 1,
            seriesOver: false, seriesWinner: null
          });
        }

        function ensureGame() {
          if (curView === 'game') return;
          curView = 'game';
          refs = buildGameLayout(onCell);
          root.innerHTML = ''; root.appendChild(refs.root);
        }

        function multiVM(sh, players) {
          var xId = sh.order[0], oId = sh.order[1];
          var xP = playerById(players, xId), oP = playerById(players, oId);
          var myMark = symOf(me.id, sh);
          return {
            round: sh.round,
            xName: (xP ? xP.name : 'Spieler 1') + (myMark === X ? ' (du)' : ''),
            oName: (oP ? oP.name : 'Spieler 2') + (myMark === O ? ' (du)' : ''),
            xScore: (sh.scores && sh.scores[xId]) || 0,
            oScore: (sh.scores && sh.scores[oId]) || 0,
            myMark: myMark, showMe: false,
            board: sh.board, winline: sh.winline,
            winner: sh.winner ? (sh.winner === 'draw' ? 'draw' : symOf(sh.winner, sh)) : null,
            turn: sh.winner ? null : symOf(sh.turn, sh),
            status: multiStatus(sh, players, myMark)
          };
        }
        function multiStatus(sh, players, myMark) {
          if (sh.winner) {
            if (sh.winner === 'draw') return { text: 'Unentschieden · nächste Runde …', cls: 'draw' };
            var won = sh.winner === me.id;
            return { text: (won ? 'Runde gewonnen! 🎉' : 'Runde verloren') + ' · nächste Runde …', cls: won ? 'win' : 'lose' };
          }
          if (myMark == null) return { text: 'Du schaust zu', cls: 'opp' };
          if (sh.turn === me.id) return { text: 'Du bist dran', cls: 'you' };
          var t = playerById(players, sh.turn);
          return { text: (t ? t.name : 'Gegner') + ' ist dran', cls: 'opp' };
        }

        function onCell(i) {
          var sh = lastShared;
          if (destroyed || !sh || !sh.board || sh.seriesOver || sh.winner) return;
          var myMark = symOf(me.id, sh);
          if (!myMark) return;                        // Zuschauer
          if (sh.turn !== me.id) { UI.toast('Warte — du bist nicht dran', 'info'); return; }
          if (sh.board[i] !== '') return;
          applyMove(sh, i, myMark, me.id);
        }
        function applyMove(sh, i, mark, playerId) {
          var board = sh.board.slice(); board[i] = mark;
          var w = winnerOf(board);
          var patch = { board: board };
          if (w) {
            patch.winner = playerId; patch.winline = w.line;
            var scores = Object.assign({}, sh.scores || {});
            scores[playerId] = (scores[playerId] || 0) + 1;
            patch.scores = scores;
          } else if (emptyCells(board).length === 0) {
            patch.winner = 'draw'; patch.winline = null;
          } else {
            patch.turn = otherId(playerId, sh);
          }
          room.setShared(patch);
        }

        /* Nur der Host schaltet nach einer beendeten Runde weiter (bzw. beendet
         * die Serie). ~2,2 s Pause, damit beide die Sieglinie sehen. */
        function maybeAdvance(sh) {
          if (!room.isHost() || sh.seriesOver || !sh.winner) return;
          if (pendingAdvanceRound === sh.round) return;
          pendingAdvanceRound = sh.round;
          after(2200, function () {
            if (destroyed) return;
            var cur = lastShared;
            if (!cur || cur.seriesOver || !cur.winner || cur.round !== sh.round) return;
            var xId = cur.order[0], oId = cur.order[1];
            var sx = (cur.scores && cur.scores[xId]) || 0, so = (cur.scores && cur.scores[oId]) || 0;
            if (sx >= WIN_TARGET || so >= WIN_TARGET || cur.round >= MAX_ROUNDS) {
              room.setShared({ seriesOver: true, seriesWinner: sx > so ? xId : (so > sx ? oId : 'draw') });
            } else {
              var nextStarter = (cur.starter === xId) ? oId : xId;
              room.setShared({ board: blank(), turn: nextStarter, starter: nextStarter, winner: null, winline: null, round: cur.round + 1 });
            }
          });
        }

        function doRevanche() {
          var players = room.players(); if (players.length < 2 || !lastShared) return;
          var xId = lastShared.order[0], oId = lastShared.order[1];
          var scores = {}; scores[xId] = 0; scores[oId] = 0;
          pendingAdvanceRound = -1;
          room.setShared({
            board: blank(), turn: xId, starter: xId, winner: null, winline: null,
            scores: scores, round: 1, seriesOver: false, seriesWinner: null
          });
        }

        /* ---- Warte-Ansicht (nur 1 Spieler / Init) ---- */
        function showWaiting(players, starting) {
          if (curView !== 'waiting') {
            curView = 'waiting';
            var count = el('div', { class: 'tt-big neon' }, ['1 / 2']);
            var msg = el('p', { class: 'tt-endsub' }, ['']);
            waitRefs = { count: count, msg: msg };
            root.innerHTML = '';
            root.appendChild(el('div', { class: 'tt-panel glass' }, [
              el('div', { class: 'tt-wait-icon' }, ['⭕']),
              el('h2', { class: 'neon' }, ['Tic-Tac-Toe']),
              count, msg,
              el('div', { class: 'tt-actions' }, [
                el('button', { class: 'btn btn-ghost', type: 'button', onclick: ctx.onExit }, ['Zurück zur Lobby'])
              ])
            ]));
          }
          waitRefs.count.textContent = players.length + ' / 2';
          waitRefs.msg.textContent = starting ? 'Spiel startet gleich …' : 'Warte auf den zweiten Spieler …';
        }

        /* ---- Serien-Endscreen ---- */
        function showEnd(sh, players) {
          if (curView === 'end') return;
          curView = 'end';
          players = players || room.players();
          var xId = sh.order[0], oId = sh.order[1];
          var xP = playerById(players, xId), oP = playerById(players, oId);
          var mine = sh.seriesWinner === 'draw' ? 'draw' : (sh.seriesWinner === me.id ? 'win' : 'lose');
          if (mine === 'win' && App.Scores) App.Scores.winCurrent();  // Serien-Sieg zählen (nur beim Gewinner-Client, einmalig durch curView-Guard)
          var actions;
          if (room.isHost()) {
            actions = [
              el('button', { class: 'btn btn-primary btn-lg', type: 'button', onclick: doRevanche }, ['Revanche']),
              el('button', { class: 'btn btn-ghost btn-lg', type: 'button', onclick: ctx.onExit }, ['Zurück zur Lobby'])
            ];
          } else {
            actions = [
              el('button', { class: 'btn btn-primary btn-lg', type: 'button', onclick: ctx.onExit }, ['Zurück zur Lobby'])
            ];
          }
          var panel = endPanel(mine, {
            xName: xP ? xP.name : 'Spieler 1', oName: oP ? oP.name : 'Spieler 2',
            xScore: (sh.scores && sh.scores[xId]) || 0, oScore: (sh.scores && sh.scores[oId]) || 0,
            myMark: symOf(me.id, sh)
          }, actions);
          if (!room.isHost()) panel.appendChild(el('p', { class: 'tt-hint' }, ['Der Host kann eine Revanche starten.']));
          root.innerHTML = ''; root.appendChild(panel);
        }
      }

      /* ---------- gemeinsame Helfer ---------- */
      function seriesOver(scores, round) { return scores.X >= WIN_TARGET || scores.O >= WIN_TARGET || round >= MAX_ROUNDS; }
      function seriesResultMark(scores) { return scores.X > scores.O ? X : scores.O > scores.X ? O : 'draw'; }
      function soloStatus(st, over) {
        if (st.winner === X) return { text: 'Runde gewonnen! 🎉' + (over ? ' · Serie vorbei' : ' · nächste Runde …'), cls: 'win' };
        if (st.winner === O) return { text: 'Runde verloren' + (over ? ' · Serie vorbei' : ' · nächste Runde …'), cls: 'lose' };
        if (st.winner === 'draw') return { text: 'Unentschieden' + (over ? ' · Serie vorbei' : ' · nächste Runde …'), cls: 'draw' };
        if (st.turn === X) return { text: 'Du bist dran', cls: 'you' };
        return { text: 'Bot denkt …', cls: 'opp' };
      }

      /* Neon-Endscreen (Gewonnen/Verloren/Unentschieden) für Solo & Multi */
      function endPanel(mine, info, actions) {
        var title = mine === 'win' ? '🏆 Gewonnen!' : mine === 'lose' ? '💀 Verloren' : '🤝 Unentschieden';
        var sub = mine === 'win' ? 'Du hast die Serie geholt!' : mine === 'lose' ? 'Nächstes Mal klappt\'s!' : 'Kopf an Kopf — keiner gibt nach!';
        var xCls = 'tt-fs-side' + (info.myMark === X ? ' me' : '');
        var oCls = 'tt-fs-side' + (info.myMark === O ? ' me' : '');
        var final = el('div', { class: 'tt-finalscore' }, [
          el('div', { class: xCls }, [
            el('div', { class: 'tt-fs-sym' }, [MARKS.X]),
            el('div', { class: 'tt-fs-nm' }, [info.xName]),
            el('div', { class: 'tt-fs-num tt-fs-x' }, [String(info.xScore)])
          ]),
          el('div', { class: 'tt-fs-vs' }, [':']),
          el('div', { class: oCls }, [
            el('div', { class: 'tt-fs-sym' }, [MARKS.O]),
            el('div', { class: 'tt-fs-nm' }, [info.oName]),
            el('div', { class: 'tt-fs-num tt-fs-o' }, [String(info.oScore)])
          ])
        ]);
        return el('div', { class: 'tt-panel tt-panel-' + mine + ' glass' }, [
          el('h2', { class: 'tt-big neon' }, [title]),
          el('p', { class: 'tt-endsub' }, [sub]),
          final,
          el('div', { class: 'tt-actions' }, actions)
        ]);
      }
    }
  };

  /* ===================== CSS ===================== */
  function injectStyle() {
    UI.injectStyle('mg-tictactoe-css', [
      '.tt-wrap{display:flex;flex-direction:column;gap:14px;max-width:460px;margin:0 auto;}',
      '.tt-top{display:flex;justify-content:space-between;align-items:center;gap:10px;}',
      '.tt-brand{font-weight:900;font-size:18px;}',
      '.tt-round{font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;font-weight:800;}',
      '.tt-scores{display:flex;gap:10px;}',
      '.tt-chip{flex:1;min-width:0;display:flex;align-items:center;gap:9px;padding:9px 12px;border-radius:14px;background:rgba(9,32,21,.6);border:1px solid var(--stroke);transition:.15s;}',
      '.tt-chip .tt-sym{font-size:24px;line-height:1;filter:drop-shadow(0 0 6px rgba(0,0,0,.5));}',
      '.tt-chip .tt-info{flex:1;min-width:0;display:flex;flex-direction:column;line-height:1.15;}',
      '.tt-chip .tt-nm{font-weight:800;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      '.tt-chip .tt-mini{font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;}',
      '.tt-chip .tt-sc{font-size:24px;font-weight:900;color:var(--leaf);}',
      '.tt-chip.me .tt-nm{color:var(--aqua);}',
      '.tt-chip.active{border-color:var(--neon);box-shadow:0 0 0 1px var(--neon),0 0 18px rgba(57,255,20,.35);}',
      '.tt-chip.active .tt-sym{animation:tt-bob .9s ease-in-out infinite;}',
      '@keyframes tt-bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-3px)}}',
      '.tt-status{text-align:center;font-weight:900;font-size:clamp(16px,4.6vw,20px);min-height:26px;transition:color .15s;}',
      '.tt-status.you{color:var(--neon);text-shadow:0 0 10px rgba(57,255,20,.4);}',
      '.tt-status.opp{color:var(--aqua);}',
      '.tt-status.win{color:var(--gold);text-shadow:0 0 12px rgba(255,210,63,.5);}',
      '.tt-status.lose{color:var(--danger);}',
      '.tt-status.draw{color:var(--aqua);}',
      '.tt-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;}',
      '.tt-cell{aspect-ratio:1/1;display:flex;align-items:center;justify-content:center;font-size:clamp(38px,13vw,68px);line-height:1;border-radius:16px;background:rgba(6,24,16,.75);border:2px solid var(--stroke);color:var(--text);cursor:default;user-select:none;-webkit-user-select:none;padding:0;transition:transform .1s,box-shadow .2s,border-color .2s;}',
      '.tt-grid.clickable .tt-cell:not(.filled){cursor:pointer;}',
      '.tt-grid.clickable .tt-cell:not(.filled):hover{border-color:var(--neon);box-shadow:inset 0 0 22px rgba(57,255,20,.16);transform:translateY(-2px);}',
      '.tt-grid.clickable .tt-cell:not(.filled):active{transform:scale(.96);}',
      '.tt-cell.filled{animation:tt-pop .18s ease;}',
      '@keyframes tt-pop{0%{transform:scale(.55)}70%{transform:scale(1.14)}100%{transform:scale(1)}}',
      '.tt-cell.x{border-color:rgba(255,77,109,.5);text-shadow:0 0 14px rgba(255,77,109,.45);}',
      '.tt-cell.o{border-color:rgba(57,255,20,.5);text-shadow:0 0 14px rgba(57,255,20,.45);}',
      '.tt-cell.win{border-color:var(--gold);animation:tt-win 1s ease-in-out infinite;}',
      '@keyframes tt-win{0%,100%{box-shadow:0 0 14px rgba(255,210,63,.4),inset 0 0 12px rgba(255,210,63,.2);}50%{box-shadow:0 0 32px rgba(255,210,63,.85),inset 0 0 24px rgba(255,210,63,.4);}}',
      '.tt-actions{display:flex;gap:10px;justify-content:center;flex-wrap:wrap;margin-top:4px;}',
      '.tt-panel{padding:28px 22px;text-align:center;display:flex;flex-direction:column;gap:14px;align-items:center;max-width:460px;margin:0 auto;}',
      '.tt-big{font-size:clamp(26px,8vw,40px);font-weight:900;line-height:1.1;}',
      '.tt-endsub{color:var(--muted);margin:0;}',
      '.tt-wait-icon{font-size:48px;animation:tt-spin 2.6s linear infinite;filter:drop-shadow(0 0 10px rgba(57,255,20,.4));}',
      '@keyframes tt-spin{to{transform:rotate(360deg);}}',
      '.tt-finalscore{display:flex;gap:16px;align-items:flex-start;justify-content:center;margin:4px 0;}',
      '.tt-fs-side{display:flex;flex-direction:column;align-items:center;gap:3px;min-width:96px;padding:10px;border-radius:14px;border:1px solid transparent;}',
      '.tt-fs-side.me{border-color:var(--stroke-2,var(--stroke));background:rgba(9,32,21,.5);}',
      '.tt-fs-sym{font-size:30px;line-height:1;}',
      '.tt-fs-nm{font-size:13px;font-weight:800;color:var(--muted);max-width:110px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      '.tt-fs-num{font-size:40px;font-weight:900;line-height:1;}',
      '.tt-fs-x{color:var(--danger);text-shadow:0 0 12px rgba(255,77,109,.4);}',
      '.tt-fs-o{color:var(--neon);text-shadow:0 0 12px rgba(57,255,20,.4);}',
      '.tt-fs-vs{align-self:center;color:var(--muted);font-size:24px;font-weight:900;}',
      '.tt-hint{color:var(--muted);font-size:12px;margin:0;}'
    ].join(''));
  }
})();
