/* connect4.js — "4 Gewinnt": rundenbasiertes 2-Spieler-Duell.
 * Klassisches 7x6-Brett, Steine fallen animiert in die Spalte.
 * Rot vs. Türkis, wer zuerst 4 in einer Reihe hat gewinnt.
 * Singleplayer: gegen einen Bot (Gewinn-/Block-/Mitte-KI), kein Netz.
 * Multiplayer: Host hält den Zustand via room.setShared({board,turn,winner,winline,gen}),
 * beide hören room.on('shared'). Zug nur wenn turn === ctx.me.id (serverseitig-artig geprüft). */
(function () {
  'use strict';
  window.App = window.App || {}; App.Minigames = App.Minigames || {};
  var UI = App.UI, el = UI.el;

  var COLS = 7, ROWS = 6;

  injectStyle();

  /* ---------- reine Brett-Logik ---------- */
  function emptyBoard() {
    var b = [];
    for (var r = 0; r < ROWS; r++) { var row = []; for (var c = 0; c < COLS; c++) row.push(0); b.push(row); }
    return b;
  }
  function cloneBoard(b) { return b.map(function (row) { return row.slice(); }); }
  function dropRow(b, col) { for (var r = ROWS - 1; r >= 0; r--) { if (b[r][col] === 0) return r; } return -1; }
  function validCols(b) { var v = []; for (var c = 0; c < COLS; c++) if (dropRow(b, c) >= 0) v.push(c); return v; }
  function isFull(b) { for (var c = 0; c < COLS; c++) if (b[0][c] === 0) return false; return true; }
  function inb(r, c) { return r >= 0 && r < ROWS && c >= 0 && c < COLS; }

  /* Gibt die Gewinn-Linie (Array [r,c]) zurück, falls der Stein bei (r,c) 4+ vervollständigt, sonst null. */
  function checkWinAt(b, r, c) {
    var v = b[r][c]; if (!v) return null;
    var dirs = [[0, 1], [1, 0], [1, 1], [1, -1]];
    for (var d = 0; d < dirs.length; d++) {
      var dr = dirs[d][0], dc = dirs[d][1], cells = [[r, c]], i;
      for (i = 1; inb(r - dr * i, c - dc * i) && b[r - dr * i][c - dc * i] === v; i++) cells.push([r - dr * i, c - dc * i]);
      for (i = 1; inb(r + dr * i, c + dc * i) && b[r + dr * i][c + dc * i] === v; i++) cells.push([r + dr * i, c + dc * i]);
      if (cells.length >= 4) return cells;
    }
    return null;
  }
  /* Gibt eine Spalte zurück, in der 'disc' sofort gewinnt, sonst -1. */
  function winningMove(b, disc) {
    var v = validCols(b);
    for (var k = 0; k < v.length; k++) {
      var col = v[k], nb = cloneBoard(b), r = dropRow(nb, col); nb[r][col] = disc;
      if (checkWinAt(nb, r, col)) return col;
    }
    return -1;
  }
  /* Bot-KI: 1) selbst gewinnen  2) Gegner blocken  3) gewichtet Mitte (kein Selbstmord) */
  function botChoose(b) {
    var w = winningMove(b, 2); if (w >= 0) return w;
    var block = winningMove(b, 1); if (block >= 0) return block;
    var valid = validCols(b);
    var safe = valid.filter(function (col) {
      var nb = cloneBoard(b), r = dropRow(nb, col); nb[r][col] = 2;
      return winningMove(nb, 1) < 0;       // Zug schenkt Gegner keinen sofortigen Sieg
    });
    var pool = safe.length ? safe : valid;
    var weights = pool.map(function (col) { return 4 - Math.abs(3 - col); }); // Mitte bevorzugt
    var total = 0; weights.forEach(function (x) { total += x; });
    var x = Math.random() * total;
    for (var i = 0; i < pool.length; i++) { x -= weights[i]; if (x <= 0) return pool[i]; }
    return pool[pool.length - 1];
  }

  App.Minigames.connect4 = {
    id: 'connect4', title: '4 Gewinnt', icon: '🔴', order: 18,
    subtitle: 'Vier in einer Reihe — Duell zu zweit',
    single: true, multi: true, minPlayers: 2, maxPlayers: 2,

    render: function (root, ctx) {
      var isMulti = ctx.mode === 'multi';
      var destroyed = false, timeouts = [];
      function after(ms, fn) { var t = setTimeout(function () { if (!destroyed) fn(); }, ms); timeouts.push(t); return t; }
      function clearTimers() { timeouts.forEach(clearTimeout); timeouts = []; }

      /* gemeinsame UI-Refs */
      var uiBuilt = false, boardEl, boardOuter, statusEl, cells2d = [], previewCells = [], hitBars = [];
      var overlayEl = null, renderedBoard = null, hoverCol = -1;

      /* pro Modus gesetzte Callbacks (von den Board-Handlern referenziert) */
      var canInteract = function () { return false; };   // (col) -> bool
      var previewColor = function () { return null; };    // () -> 'red'|'aqua'|null
      var activate = function () {};                       // (col) -> void
      var newGameSingle = null, requestRematch = null;

      /* ---------- Board-UI aufbauen ---------- */
      function buildUI() {
        root.innerHTML = '';
        statusEl = el('div', { class: 'c4-status' });

        var previewRow = el('div', { class: 'c4-preview' });
        previewCells = [];
        for (var pc = 0; pc < COLS; pc++) {
          var disc = el('div', { class: 'c4-disc' });
          var pcell = el('div', { class: 'c4-pcell' }, [disc]);
          previewRow.appendChild(pcell); previewCells.push({ cell: pcell, disc: disc });
        }

        boardEl = el('div', { class: 'c4-board' });
        cells2d = [];
        for (var r = 0; r < ROWS; r++) {
          var rowArr = [];
          for (var c = 0; c < COLS; c++) {
            var cell = el('div', { class: 'c4-cell' });
            boardEl.appendChild(cell); rowArr.push(cell);
          }
          cells2d.push(rowArr);
        }
        /* transparente Spalten-Trefferflächen (grosse Touch-Ziele) */
        var hit = el('div', { class: 'c4-hit' });
        hitBars = [];
        for (var hc = 0; hc < COLS; hc++) {
          var bar = el('div', { class: 'c4-colbar', dataset: { col: hc } });
          hit.appendChild(bar); hitBars.push(bar);
        }
        boardEl.appendChild(hit);

        boardOuter = el('div', { class: 'c4-board-outer' }, [previewRow, boardEl]);
        var wrap = el('div', { class: 'c4-wrap glass' }, [statusEl, boardOuter]);
        root.appendChild(wrap);

        hit.addEventListener('click', onClick);
        hit.addEventListener('mouseover', onOver);
        hit.addEventListener('mouseleave', onLeave);
      }

      function onClick(e) {
        var t = e.target.closest('[data-col]'); if (!t) return;
        activate(+t.dataset.col); setHover(-1);
      }
      function onOver(e) { var t = e.target.closest('[data-col]'); setHover(t ? +t.dataset.col : -1); }
      function onLeave() { setHover(-1); }
      function setHover(col) {
        if (col === hoverCol) return;
        if (hoverCol >= 0) for (var r = 0; r < ROWS; r++) cells2d[r][hoverCol].classList.remove('col-hover');
        hoverCol = col;
        if (hoverCol >= 0) for (var r2 = 0; r2 < ROWS; r2++) cells2d[r2][hoverCol].classList.add('col-hover');
        updatePreview();
      }
      function updatePreview() {
        for (var c = 0; c < COLS; c++) { previewCells[c].cell.classList.remove('show'); previewCells[c].disc.className = 'c4-disc'; }
        if (hoverCol < 0) return;
        var color = previewColor();
        if (!color || !canInteract(hoverCol)) return;
        previewCells[hoverCol].disc.className = 'c4-disc ' + color;
        previewCells[hoverCol].cell.classList.add('show');
      }

      /* ---------- Brett zeichnen (mit Fall-Animation für neue Steine) ---------- */
      function discIn(cell) { return cell.querySelector('.c4-disc'); }
      function paint(board, winline) {
        winline = winline || [];
        for (var r = 0; r < ROWS; r++) {
          for (var c = 0; c < COLS; c++) {
            var cell = cells2d[r][c]; cell.classList.remove('win-cell');
            var val = board[r][c], d = discIn(cell);
            if (val === 0) { if (d) cell.removeChild(d); continue; }
            if (!d) {
              d = el('div', { class: 'c4-disc ' + (val === 1 ? 'red' : 'aqua') });
              if (renderedBoard && renderedBoard[r][c] === 0) d.classList.add('drop');
              cell.appendChild(d);
            } else { d.classList.remove('win'); }
          }
        }
        winline.forEach(function (p) {
          var cell = cells2d[p[0]][p[1]]; cell.classList.add('win-cell');
          var d = discIn(cell); if (d) d.classList.add('win');
        });
        renderedBoard = cloneBoard(board);
      }

      /* ---------- Statuszeile ---------- */
      function chip(name, color, active, me) {
        return el('div', { class: 'c4-chip ' + color + (active ? ' active' : '') }, [
          el('span', { class: 'dot' }), el('span', {}, [name + (me ? ' (du)' : '')])
        ]);
      }
      function setStatus(redName, aquaName, activeColor, line, lineColor, redMe, aquaMe) {
        statusEl.innerHTML = '';
        statusEl.appendChild(el('div', { class: 'c4-turnline ' + (lineColor || '') }, [line]));
        statusEl.appendChild(el('div', { class: 'c4-chips' }, [
          chip(redName, 'red', activeColor === 'red', redMe),
          el('span', { class: 'c4-vs' }, ['vs']),
          chip(aquaName, 'aqua', activeColor === 'aqua', aquaMe)
        ]));
      }

      /* ---------- Endscreen-Overlay (Neon-Stil) ---------- */
      function removeOverlay() { if (overlayEl && overlayEl.parentNode) overlayEl.parentNode.removeChild(overlayEl); overlayEl = null; }
      function buildOverlay(res, opts) {
        removeOverlay();
        var map = { win: { t: 'Gewonnen!', e: '🏆', cls: 'win' }, lose: { t: 'Verloren', e: '💀', cls: 'lose' }, draw: { t: 'Unentschieden', e: '🤝', cls: 'draw' } };
        var m = map[res], btns, revBtn = null;
        if (opts.multi) {
          revBtn = el('button', { class: 'btn btn-aqua', type: 'button' }, ['Revanche']);
          revBtn.addEventListener('click', function () { if (requestRematch) requestRematch(revBtn); });
          btns = [revBtn, el('button', { class: 'btn btn-ghost', type: 'button', onclick: ctx.onExit }, ['Zurück zur Lobby'])];
        } else {
          btns = [
            el('button', { class: 'btn btn-primary', type: 'button', onclick: function () { if (newGameSingle) newGameSingle(); } }, ['Nochmal']),
            el('button', { class: 'btn btn-ghost', type: 'button', onclick: ctx.onExit }, ['Zurück'])
          ];
        }
        overlayEl = el('div', { class: 'c4-end' }, [
          el('div', { class: 'c4-end-emoji' }, [m.e]),
          el('h2', { class: m.cls }, [m.t]),
          opts.sub ? el('div', { class: 'c4-end-sub' }, [opts.sub]) : null,
          el('div', { class: 'c4-end-btns' }, btns)
        ]);
        boardOuter.appendChild(overlayEl);
        return revBtn;
      }

      /* ===================== SINGLEPLAYER ===================== */
      if (!isMulti) {
        buildUI(); uiBuilt = true;
        var S = null;
        previewColor = function () { return S && !S.over && S.turn === 1 ? 'red' : null; };
        canInteract = function (col) { return S && !S.over && S.turn === 1 && dropRow(S.board, col) >= 0; };
        activate = function (col) { if (canInteract(col)) playerMove(col); };
        newGameSingle = function () {
          S = { board: emptyBoard(), turn: 1, over: false };
          renderedBoard = null; removeOverlay(); paint(S.board, []); statusSingle(); updatePreview();
        };
        function statusSingle() {
          var line = S.turn === 1 ? 'Du bist dran' : 'Bot überlegt …';
          setStatus('Du', 'Bot', S.turn === 1 ? 'red' : 'aqua', line, S.turn === 1 ? 'neon' : '', true, false);
        }
        function playerMove(col) {
          var r = dropRow(S.board, col); if (r < 0) return;
          S.board[r][col] = 1;
          var line = checkWinAt(S.board, r, col);
          paint(S.board, line || []); updatePreview();
          if (line) { S.over = true; statusSingle(); after(700, function () { buildOverlay('win', { multi: false, sub: 'Vier in einer Reihe – stark!' }); }); return; }
          if (isFull(S.board)) { S.over = true; after(700, function () { buildOverlay('draw', { multi: false, sub: 'Brett voll – keiner gewinnt.' }); }); return; }
          S.turn = 2; statusSingle(); updatePreview();
          after(650, botMove);
        }
        function botMove() {
          if (destroyed || !S || S.over) return;
          var col = botChoose(S.board), r = dropRow(S.board, col);
          if (r < 0) return;
          S.board[r][col] = 2;
          var line = checkWinAt(S.board, r, col);
          paint(S.board, line || []);
          if (line) { S.over = true; statusSingle(); after(700, function () { buildOverlay('lose', { multi: false, sub: 'Der Bot war schneller.' }); }); return; }
          if (isFull(S.board)) { S.over = true; after(700, function () { buildOverlay('draw', { multi: false, sub: 'Brett voll – keiner gewinnt.' }); }); return; }
          S.turn = 1; statusSingle(); updatePreview();
        }
        newGameSingle();
        return { cleanup: cleanup };
      }

      /* ===================== MULTIPLAYER ===================== */
      var room = ctx.room, curShared = null, sharedCb = null, playersCb = null;

      function firstTwo() { return room.players().slice(0, 2); }
      function meIn(players) { for (var i = 0; i < players.length; i++) if (players[i].id === ctx.me.id) return i; return -1; }
      function winnerOf(sh) { return sh && sh.winner ? sh.winner : null; }

      previewColor = function () {
        if (!curShared || winnerOf(curShared) || curShared.turn !== ctx.me.id) return null;
        var mi = meIn(firstTwo()); return mi === 0 ? 'red' : mi === 1 ? 'aqua' : null;
      };
      canInteract = function (col) {
        var players = firstTwo();
        return players.length >= 2 && curShared && curShared.board && !winnerOf(curShared) &&
          curShared.turn === ctx.me.id && dropRow(curShared.board, col) >= 0;
      };
      activate = function (col) {
        var sh = curShared, players = firstTwo();
        if (players.length < 2 || !sh || !sh.board) return;
        if (winnerOf(sh)) return;
        if (sh.turn !== ctx.me.id) { UI.toast('Gegner ist dran', 'info'); return; }
        var mi = meIn(players); if (mi < 0) return;
        var myDisc = mi + 1, r = dropRow(sh.board, col); if (r < 0) return;
        var nb = cloneBoard(sh.board); nb[r][col] = myDisc;
        var line = checkWinAt(nb, r, col);
        var winner = line ? ctx.me.id : (isFull(nb) ? 'draw' : null);
        var otherId = players[mi === 0 ? 1 : 0].id;
        var nextTurn = winner ? sh.turn : otherId;
        room.setShared({ board: nb, turn: nextTurn, winner: winner, winline: line || [], gen: sh.gen || 0 });
      };

      function initShared(players) {
        room.setShared({ board: emptyBoard(), turn: players[0].id, winner: null, winline: [], gen: 0 });
      }

      requestRematch = function (btn) {
        var g = (curShared && curShared.gen) || 0;
        room.reportState({ rematch: g });
        if (btn) { btn.disabled = true; btn.textContent = 'Warte auf Gegner …'; }
        if (room.isHost()) maybeRematch(firstTwo());
      };
      function maybeRematch(players) {
        var sh = curShared; if (!sh || !winnerOf(sh) || players.length < 2) return;
        var g = sh.gen || 0;
        var both = players.slice(0, 2).every(function (p) { return p.state && p.state.rematch === g; });
        if (both) room.setShared({ board: emptyBoard(), turn: players[0].id, winner: null, winline: [], gen: g + 1 });
      }

      /* Warten-Ansicht, wenn nur 1 Spieler im Raum */
      function showWaiting(msg) {
        uiBuilt = false; overlayEl = null; hoverCol = -1;
        root.innerHTML = '';
        root.appendChild(el('div', { class: 'c4-wait glass' }, [
          el('div', { class: 'c4-wait-icon' }, ['🔴']),
          el('h3', { class: 'neon' }, ['4 Gewinnt']),
          el('p', { class: 'hint-text' }, [msg || 'Warte auf zweiten Spieler …']),
          el('button', { class: 'btn btn-ghost', type: 'button', onclick: ctx.onExit }, ['Zurück zur Lobby'])
        ]));
      }
      function ensureBoardUI() { if (!uiBuilt) { buildUI(); uiBuilt = true; renderedBoard = null; } }

      function showEndMulti(res, sh, players) {
        var key = res + ':' + (sh.winner || '') + ':' + (sh.gen || 0);
        if (overlayEl && overlayEl.dataset.key === key) return;   // schon angezeigt
        var sub;
        if (res === 'win') sub = 'Du hast vier in einer Reihe!';
        else if (res === 'draw') sub = 'Brett voll – unentschieden.';
        else {
          var wp = players.filter(function (p) { return p.id === sh.winner; })[0];
          sub = (wp ? wp.name : 'Gegner') + ' hat gewonnen.';
        }
        var btn = buildOverlay(res, { multi: true, sub: sub });
        overlayEl.dataset.key = key;
        var me = players.filter(function (p) { return p.id === ctx.me.id; })[0];
        if (btn && me && me.state && me.state.rematch === (sh.gen || 0)) { btn.disabled = true; btn.textContent = 'Warte auf Gegner …'; }
      }

      function onShared(shared) {
        if (destroyed) return;
        curShared = shared || {};
        var players = firstTwo();
        if (players.length < 2) { showWaiting('Warte auf zweiten Spieler …'); return; }
        if (room.isHost() && (!curShared || !curShared.board)) { initShared(players); return; }
        if (!curShared.board) { showWaiting('Warte auf Spielstart …'); return; }

        ensureBoardUI();
        paint(curShared.board, curShared.winline || []);

        var redP = players[0], aquaP = players[1];
        var w = winnerOf(curShared);
        var line, lineColor;
        if (w === 'draw') { line = 'Unentschieden'; lineColor = 'draw'; }
        else if (w) { line = (w === ctx.me.id) ? 'Du hast gewonnen!' : 'Verloren'; lineColor = (w === ctx.me.id) ? 'neon' : 'lose'; }
        else if (curShared.turn === ctx.me.id) { line = 'Du bist dran'; lineColor = 'neon'; }
        else { var tp = players.filter(function (p) { return p.id === curShared.turn; })[0]; line = (tp ? tp.name : 'Gegner') + ' ist dran'; lineColor = ''; }
        var activeColor = w ? '' : (curShared.turn === redP.id ? 'red' : 'aqua');
        setStatus(redP.name, aquaP.name, activeColor, line, lineColor, redP.id === ctx.me.id, aquaP.id === ctx.me.id);
        updatePreview();

        if (w) {
          var res = w === 'draw' ? 'draw' : (w === ctx.me.id ? 'win' : 'lose');
          showEndMulti(res, curShared, players);
        } else { removeOverlay(); }
      }

      function onPlayers() {
        if (destroyed) return;
        var players = firstTwo();
        if (players.length >= 2 && room.isHost() && (!curShared || !curShared.board)) initShared(players);
        if (room.isHost()) maybeRematch(players);
        onShared(curShared);
      }

      sharedCb = function (sh) { onShared(sh); };
      playersCb = function () { onPlayers(); };
      room.on('shared', sharedCb);
      room.on('players', playersCb);

      /* Initialer Zustand (Listener feuern nicht rückwirkend) */
      var snap = room.snapshot();
      onShared(snap ? snap.shared : null);
      onPlayers();

      return { cleanup: cleanup };

      /* ---------- Aufräumen ---------- */
      function cleanup() {
        destroyed = true; clearTimers();
        if (room) {
          if (sharedCb) room.off('shared', sharedCb);
          if (playersCb) room.off('players', playersCb);
        }
      }
    }
  };

  function injectStyle() {
    UI.injectStyle('mg-connect4-css', [
      '.c4-wrap{max-width:520px;margin:0 auto;display:flex;flex-direction:column;gap:14px;padding:16px;}',
      '.c4-status{display:flex;flex-direction:column;gap:9px;align-items:center;text-align:center;}',
      '.c4-turnline{font-weight:800;font-size:clamp(16px,4.6vw,21px);min-height:24px;}',
      '.c4-turnline.neon{color:var(--neon);text-shadow:0 0 8px rgba(57,255,20,.5);}',
      '.c4-turnline.lose{color:var(--danger-2);}',
      '.c4-turnline.draw{color:var(--gold);}',
      '.c4-chips{display:flex;gap:8px;justify-content:center;align-items:center;flex-wrap:wrap;}',
      '.c4-vs{color:var(--muted);font-size:12px;font-weight:800;text-transform:uppercase;letter-spacing:1px;}',
      '.c4-chip{display:flex;align-items:center;gap:7px;padding:6px 13px;border-radius:999px;border:1px solid var(--stroke);background:rgba(9,32,21,.6);font-weight:700;font-size:14px;transition:.2s;opacity:.72;}',
      '.c4-chip .dot{width:13px;height:13px;border-radius:50%;flex:none;}',
      '.c4-chip.red .dot{background:radial-gradient(circle at 35% 30%,#ff9bb0,var(--danger));box-shadow:0 0 7px var(--danger);}',
      '.c4-chip.aqua .dot{background:radial-gradient(circle at 35% 30%,#bff8ee,var(--aqua));box-shadow:0 0 7px var(--aqua);}',
      '.c4-chip.active{opacity:1;transform:translateY(-1px);}',
      '.c4-chip.red.active{border-color:var(--danger);box-shadow:0 0 14px rgba(255,77,109,.45);}',
      '.c4-chip.aqua.active{border-color:var(--aqua);box-shadow:0 0 14px rgba(51,230,208,.45);}',
      '.c4-board-outer{position:relative;width:100%;max-width:440px;margin:0 auto;}',
      '.c4-preview{display:grid;grid-template-columns:repeat(7,1fr);gap:2.5%;padding:0 4%;margin-bottom:5px;}',
      '.c4-pcell{aspect-ratio:1;display:flex;align-items:center;justify-content:center;}',
      '.c4-pcell .c4-disc{width:72%;height:72%;opacity:0;transition:opacity .12s;}',
      '.c4-pcell.show .c4-disc{opacity:.5;}',
      '.c4-board{position:relative;display:grid;grid-template-columns:repeat(7,1fr);gap:2.5%;padding:4%;aspect-ratio:7/6;',
      'background:linear-gradient(160deg,rgba(9,42,27,.96),rgba(6,22,15,.98));border:1.5px solid var(--stroke-2);border-radius:16px;',
      'box-shadow:inset 0 0 34px rgba(0,0,0,.55),var(--glow-soft);touch-action:manipulation;}',
      '.c4-cell{aspect-ratio:1;border-radius:50%;position:relative;overflow:hidden;display:flex;align-items:center;justify-content:center;',
      'background:radial-gradient(circle at 35% 30%,#06160e,#020a06);box-shadow:inset 0 3px 7px rgba(0,0,0,.75),inset 0 0 0 1px rgba(57,255,20,.06);transition:box-shadow .15s;}',
      '.c4-cell.col-hover{box-shadow:inset 0 3px 7px rgba(0,0,0,.7),inset 0 0 0 1px rgba(57,255,20,.28);}',
      '.c4-disc{width:100%;height:100%;border-radius:50%;}',
      '.c4-disc.red{background:radial-gradient(circle at 35% 30%,#ffb3c4,var(--danger) 56%,#a51f39);box-shadow:0 0 10px rgba(255,77,109,.55),inset 0 -4px 8px rgba(0,0,0,.35),inset 0 3px 6px rgba(255,255,255,.25);}',
      '.c4-disc.aqua{background:radial-gradient(circle at 35% 30%,#c8f9f0,var(--aqua) 56%,#128a7b);box-shadow:0 0 10px rgba(51,230,208,.55),inset 0 -4px 8px rgba(0,0,0,.35),inset 0 3px 6px rgba(255,255,255,.25);}',
      '.c4-disc.drop{animation:c4-drop .5s cubic-bezier(.3,.7,.4,1);}',
      '@keyframes c4-drop{0%{transform:translateY(-900%);}72%{transform:translateY(0);}84%{transform:translateY(-9%);}92%{transform:translateY(0);}96%{transform:translateY(-3%);}100%{transform:translateY(0);}}',
      '.c4-disc.win{animation:c4-win 1s ease-in-out infinite;}',
      '@keyframes c4-win{0%,100%{filter:brightness(1);transform:scale(1);}50%{filter:brightness(1.65);transform:scale(1.09);}}',
      '.c4-cell.win-cell{box-shadow:inset 0 0 0 2px var(--neon),0 0 16px rgba(57,255,20,.55);}',
      '.c4-hit{position:absolute;inset:4%;display:grid;grid-template-columns:repeat(7,1fr);gap:0;z-index:3;}',
      '.c4-colbar{height:100%;cursor:pointer;}',
      '.c4-end{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;text-align:center;padding:20px;',
      'background:rgba(3,14,9,.85);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);border-radius:16px;z-index:6;animation:c4-fade .3s ease;}',
      '@keyframes c4-fade{from{opacity:0;transform:scale(.96);}to{opacity:1;transform:scale(1);}}',
      '.c4-end-emoji{font-size:54px;filter:drop-shadow(0 0 12px rgba(0,0,0,.4));}',
      '.c4-end h2{margin:0;font-size:clamp(24px,7vw,34px);}',
      '.c4-end h2.win{color:var(--neon);text-shadow:0 0 12px rgba(57,255,20,.6);}',
      '.c4-end h2.lose{color:var(--danger-2);text-shadow:0 0 12px rgba(255,77,109,.5);}',
      '.c4-end h2.draw{color:var(--gold);text-shadow:0 0 12px rgba(255,210,63,.5);}',
      '.c4-end-sub{color:var(--muted);font-size:14px;}',
      '.c4-end-btns{display:flex;gap:10px;flex-wrap:wrap;justify-content:center;}',
      '.c4-wait{max-width:420px;margin:24px auto;padding:34px;text-align:center;display:flex;flex-direction:column;gap:14px;align-items:center;}',
      '.c4-wait-icon{font-size:50px;animation:c4-pulse 1.4s ease-in-out infinite;}',
      '@keyframes c4-pulse{0%,100%{opacity:.5;transform:scale(.94);}50%{opacity:1;transform:scale(1.06);}}'
    ].join(''));
  }
})();
