/* chess.js — "Schach": rundenbasiertes 2-Spieler-Duell im Neon-Dschungel-Look.
 *
 * Vollständige Schach-Regeln: normale Züge, Schlagen, Rochade (kurz/lang),
 * En passant, Bauernumwandlung (mit Auswahl), Schach / Schachmatt / Patt,
 * 50-Züge-Remis und Remis bei ungenügendem Material.
 *
 *  SOLO  (ctx.mode==='single'): gegen einen Bot (Alpha-Beta-Suche + Material-/
 *        Positions-Bewertung). Spieler = Weiß (unten).
 *  MULTI (ctx.mode==='multi'):  der ganze Spielzustand liegt in room.setShared
 *        ({order,board,turn,castle,ep,half,result,winner,scores,...}); wer am
 *        Zug ist, wendet seinen legalen Zug direkt an. Spieler[0]=Weiß,
 *        Spieler[1]=Schwarz — das Brett wird für Schwarz gedreht.
 *
 * Brett-Kodierung: 64-Zeichen-Array. Index 0 = a8 (oben links), 63 = h1.
 *   row = Math.floor(i/8) (0=Reihe 8 … 7=Reihe 1), col = i%8 (0=a … 7=h).
 *   Großbuchstaben = Weiß (PNBRQK), Kleinbuchstaben = Schwarz, '.' = leer.
 *
 * cleanup() stoppt alle Timeouts und entfernt die Room-Listener. */
(function () {
  'use strict';
  window.App = window.App || {}; App.Minigames = App.Minigames || {};
  var UI = App.UI, el = UI.el;

  injectStyle();

  var SEARCH_DEPTH = 3;      // Such-Tiefe des Bots (Halbzüge zusätzlich zum Wurzelzug)
  var MAX_NODES = 140000;    // Sicherheits-Deckel gegen zu lange Bot-Denkzeit
  var GLYPH = { p: '♟', n: '♞', b: '♝', r: '♜', q: '♛', k: '♚' };
  var PIECE_DE = { q: 'Dame', r: 'Turm', b: 'Läufer', n: 'Springer', p: 'Bauer', k: 'König' };

  /* ===================== reine Schach-Logik ===================== */
  function initialBoard() {
    return [
      'r', 'n', 'b', 'q', 'k', 'b', 'n', 'r',
      'p', 'p', 'p', 'p', 'p', 'p', 'p', 'p',
      '.', '.', '.', '.', '.', '.', '.', '.',
      '.', '.', '.', '.', '.', '.', '.', '.',
      '.', '.', '.', '.', '.', '.', '.', '.',
      '.', '.', '.', '.', '.', '.', '.', '.',
      'P', 'P', 'P', 'P', 'P', 'P', 'P', 'P',
      'R', 'N', 'B', 'Q', 'K', 'B', 'N', 'R'
    ];
  }
  function initialState() {
    return { board: initialBoard(), turn: 'w', castle: { K: true, Q: true, k: true, q: true }, ep: -1, half: 0 };
  }
  function colorOf(pc) { return pc === '.' ? null : (pc === pc.toUpperCase() ? 'w' : 'b'); }
  function typeOf(pc) { return pc.toLowerCase(); }
  function onBoard(r, c) { return r >= 0 && r < 8 && c >= 0 && c < 8; }
  function idx(r, c) { return r * 8 + c; }

  var KN = [[-2, -1], [-2, 1], [-1, -2], [-1, 2], [1, -2], [1, 2], [2, -1], [2, 1]];
  var DIAG = [[-1, -1], [-1, 1], [1, -1], [1, 1]];
  var ORTHO = [[-1, 0], [1, 0], [0, -1], [0, 1]];
  var KING8 = DIAG.concat(ORTHO);

  function kingSquare(board, color) {
    var k = color === 'w' ? 'K' : 'k';
    for (var i = 0; i < 64; i++) if (board[i] === k) return i;
    return -1;
  }

  /* Wird das Feld sq von Farbe `by` angegriffen? */
  function isAttacked(board, sq, by) {
    var r = Math.floor(sq / 8), c = sq % 8, i, nr, nc, pc;
    var pawn = by === 'w' ? 'P' : 'p', kn = by === 'w' ? 'N' : 'n', kg = by === 'w' ? 'K' : 'k';
    var bi = by === 'w' ? 'B' : 'b', ro = by === 'w' ? 'R' : 'r', qu = by === 'w' ? 'Q' : 'q';
    // Bauern (weiße Bauern greifen nach oben an → stehen eine Reihe darunter)
    var pr = by === 'w' ? r + 1 : r - 1;
    if (onBoard(pr, c - 1) && board[idx(pr, c - 1)] === pawn) return true;
    if (onBoard(pr, c + 1) && board[idx(pr, c + 1)] === pawn) return true;
    // Springer
    for (i = 0; i < KN.length; i++) { nr = r + KN[i][0]; nc = c + KN[i][1]; if (onBoard(nr, nc) && board[idx(nr, nc)] === kn) return true; }
    // König
    for (i = 0; i < KING8.length; i++) { nr = r + KING8[i][0]; nc = c + KING8[i][1]; if (onBoard(nr, nc) && board[idx(nr, nc)] === kg) return true; }
    // Läufer / Dame (diagonal)
    for (i = 0; i < DIAG.length; i++) {
      nr = r + DIAG[i][0]; nc = c + DIAG[i][1];
      while (onBoard(nr, nc)) { pc = board[idx(nr, nc)]; if (pc !== '.') { if (pc === bi || pc === qu) return true; break; } nr += DIAG[i][0]; nc += DIAG[i][1]; }
    }
    // Turm / Dame (gerade)
    for (i = 0; i < ORTHO.length; i++) {
      nr = r + ORTHO[i][0]; nc = c + ORTHO[i][1];
      while (onBoard(nr, nc)) { pc = board[idx(nr, nc)]; if (pc !== '.') { if (pc === ro || pc === qu) return true; break; } nr += ORTHO[i][0]; nc += ORTHO[i][1]; }
    }
    return false;
  }

  function inCheck(state, color) {
    var ks = kingSquare(state.board, color);
    return ks >= 0 && isAttacked(state.board, ks, color === 'w' ? 'b' : 'w');
  }

  /* Pseudo-legale Züge (ohne Fessel-Prüfung), Rochade wird aber voll geprüft. */
  function pseudoMoves(state, color) {
    var b = state.board, moves = [], i, r, c, pc, t;
    for (i = 0; i < 64; i++) {
      pc = b[i]; if (pc === '.' || colorOf(pc) !== color) continue;
      r = Math.floor(i / 8); c = i % 8; t = typeOf(pc);
      if (t === 'p') pawnMoves(b, i, r, c, color, state.ep, moves);
      else if (t === 'n') hop(b, i, r, c, color, KN, moves);
      else if (t === 'b') slide(b, i, r, c, color, DIAG, moves);
      else if (t === 'r') slide(b, i, r, c, color, ORTHO, moves);
      else if (t === 'q') slide(b, i, r, c, color, KING8, moves);
      else if (t === 'k') { hop(b, i, r, c, color, KING8, moves); castleMoves(state, color, moves); }
    }
    return moves;
  }
  function pawnMoves(b, i, r, c, color, ep, moves) {
    var dir = color === 'w' ? -1 : 1;
    var startRow = color === 'w' ? 6 : 1;
    var promoRow = color === 'w' ? 0 : 7;
    var one = idx(r + dir, c);
    if (onBoard(r + dir, c) && b[one] === '.') {
      pushPawn(moves, i, one, r + dir === promoRow);
      if (r === startRow) { var two = idx(r + 2 * dir, c); if (b[two] === '.') moves.push({ from: i, to: two, flag: 'double' }); }
    }
    var dc, nr = r + dir, t;
    for (dc = -1; dc <= 1; dc += 2) {
      if (!onBoard(nr, c + dc)) continue;
      t = idx(nr, c + dc);
      if (b[t] !== '.' && colorOf(b[t]) !== color) pushPawn(moves, i, t, nr === promoRow);
      else if (t === ep) moves.push({ from: i, to: t, flag: 'ep' });
    }
  }
  function pushPawn(moves, from, to, promo) {
    if (promo) { ['q', 'r', 'b', 'n'].forEach(function (p) { moves.push({ from: from, to: to, promo: p }); }); }
    else moves.push({ from: from, to: to });
  }
  function hop(b, i, r, c, color, offs, moves) {
    for (var k = 0; k < offs.length; k++) {
      var nr = r + offs[k][0], nc = c + offs[k][1];
      if (!onBoard(nr, nc)) continue;
      var t = idx(nr, nc);
      if (b[t] === '.' || colorOf(b[t]) !== color) moves.push({ from: i, to: t });
    }
  }
  function slide(b, i, r, c, color, dirs, moves) {
    for (var k = 0; k < dirs.length; k++) {
      var nr = r + dirs[k][0], nc = c + dirs[k][1];
      while (onBoard(nr, nc)) {
        var t = idx(nr, nc);
        if (b[t] === '.') { moves.push({ from: i, to: t }); }
        else { if (colorOf(b[t]) !== color) moves.push({ from: i, to: t }); break; }
        nr += dirs[k][0]; nc += dirs[k][1];
      }
    }
  }
  function castleMoves(state, color, moves) {
    var b = state.board, opp = color === 'w' ? 'b' : 'w';
    if (color === 'w') {
      if (state.castle.K && b[61] === '.' && b[62] === '.' && b[63] === 'R' &&
        !isAttacked(b, 60, opp) && !isAttacked(b, 61, opp) && !isAttacked(b, 62, opp)) moves.push({ from: 60, to: 62, flag: 'castleK' });
      if (state.castle.Q && b[59] === '.' && b[58] === '.' && b[57] === '.' && b[56] === 'R' &&
        !isAttacked(b, 60, opp) && !isAttacked(b, 59, opp) && !isAttacked(b, 58, opp)) moves.push({ from: 60, to: 58, flag: 'castleQ' });
    } else {
      if (state.castle.k && b[5] === '.' && b[6] === '.' && b[7] === 'r' &&
        !isAttacked(b, 4, opp) && !isAttacked(b, 5, opp) && !isAttacked(b, 6, opp)) moves.push({ from: 4, to: 6, flag: 'castleK' });
      if (state.castle.q && b[3] === '.' && b[2] === '.' && b[1] === '.' && b[0] === 'r' &&
        !isAttacked(b, 4, opp) && !isAttacked(b, 3, opp) && !isAttacked(b, 2, opp)) moves.push({ from: 4, to: 2, flag: 'castleQ' });
    }
  }

  function makeMove(state, mv) {
    var b = state.board.slice(), cst = { K: state.castle.K, Q: state.castle.Q, k: state.castle.k, q: state.castle.q };
    var ep = -1, half = state.half + 1;
    var pc = b[mv.from], color = colorOf(pc), t = typeOf(pc);
    if (t === 'p' || b[mv.to] !== '.') half = 0;
    if (mv.flag === 'ep') { b[mv.to + (color === 'w' ? 8 : -8)] = '.'; }
    b[mv.to] = pc; b[mv.from] = '.';
    if (mv.promo) b[mv.to] = color === 'w' ? mv.promo.toUpperCase() : mv.promo;
    if (mv.flag === 'castleK') { if (color === 'w') { b[61] = b[63]; b[63] = '.'; } else { b[5] = b[7]; b[7] = '.'; } }
    if (mv.flag === 'castleQ') { if (color === 'w') { b[59] = b[56]; b[56] = '.'; } else { b[3] = b[0]; b[0] = '.'; } }
    if (mv.flag === 'double') ep = (mv.from + mv.to) / 2;
    if (t === 'k') { if (color === 'w') { cst.K = false; cst.Q = false; } else { cst.k = false; cst.q = false; } }
    if (mv.from === 63 || mv.to === 63) cst.K = false;
    if (mv.from === 56 || mv.to === 56) cst.Q = false;
    if (mv.from === 7 || mv.to === 7) cst.k = false;
    if (mv.from === 0 || mv.to === 0) cst.q = false;
    return { board: b, turn: color === 'w' ? 'b' : 'w', castle: cst, ep: ep, half: half };
  }

  function legalMoves(state) {
    var color = state.turn, ps = pseudoMoves(state, color), out = [];
    for (var i = 0; i < ps.length; i++) {
      var ns = makeMove(state, ps[i]);
      var ks = kingSquare(ns.board, color);
      if (ks >= 0 && !isAttacked(ns.board, ks, color === 'w' ? 'b' : 'w')) out.push(ps[i]);
    }
    return out;
  }

  function insufficient(board) {
    var minors = [], i, pc, t;
    for (i = 0; i < 64; i++) { pc = board[i]; if (pc === '.') continue; t = typeOf(pc); if (t === 'k') continue; if (t === 'n' || t === 'b') minors.push(t); else return false; }
    if (minors.length === 0) return true;              // K vs K
    if (minors.length === 1) return true;              // K+Leichtfigur vs K
    return false;
  }
  function gameResult(state) {
    var moves = legalMoves(state);
    if (moves.length === 0) {
      if (inCheck(state, state.turn)) return { over: true, type: 'checkmate', winner: state.turn === 'w' ? 'b' : 'w' };
      return { over: true, type: 'stalemate', winner: null };
    }
    if (state.half >= 100) return { over: true, type: '50move', winner: null };
    if (insufficient(state.board)) return { over: true, type: 'material', winner: null };
    return { over: false };
  }

  /* ===================== Bot (Alpha-Beta) ===================== */
  var VAL = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 0 };
  var CD = [0, 1, 2, 3, 3, 2, 1, 0];
  function evaluate(board) {
    var s = 0, i, pc, t, r, c, color;
    for (i = 0; i < 64; i++) {
      pc = board[i]; if (pc === '.') continue;
      t = typeOf(pc); color = colorOf(pc); r = Math.floor(i / 8); c = i % 8;
      var v = VAL[t];
      if (t === 'n' || t === 'b') v += (CD[c] + CD[r]) * 4;
      else if (t === 'p') v += (color === 'w' ? (6 - r) : (r - 1)) * 4 + CD[c] * 2;
      s += (color === 'w') ? v : -v;
    }
    return s; // + = gut für Weiß
  }
  function sideEval(state) { var e = evaluate(state.board); return state.turn === 'w' ? e : -e; }
  function orderMoves(state, moves) {
    var b = state.board;
    moves.forEach(function (m) {
      var victim = b[m.to]; m._s = (victim !== '.' ? VAL[typeOf(victim)] * 10 - VAL[typeOf(b[m.from])] : 0) + (m.promo ? 800 : 0);
    });
    moves.sort(function (a, z) { return z._s - a._s; });
  }
  var nodeCount = 0;
  function nega(state, depth, alpha, beta) {
    nodeCount++;
    var moves = legalMoves(state);
    if (moves.length === 0) { return inCheck(state, state.turn) ? -(90000 - depth) : 0; }
    if (depth <= 0 || nodeCount > MAX_NODES) return sideEval(state);
    orderMoves(state, moves);
    var best = -Infinity;
    for (var i = 0; i < moves.length; i++) {
      var val = -nega(makeMove(state, moves[i]), depth - 1, -beta, -alpha);
      if (val > best) best = val;
      if (best > alpha) alpha = best;
      if (alpha >= beta) break;
    }
    return best;
  }
  function pickBot(state, depth) {
    nodeCount = 0;
    var moves = legalMoves(state);
    if (!moves.length) return null;
    orderMoves(state, moves);
    var best = -Infinity, bestMoves = [];
    for (var i = 0; i < moves.length; i++) {
      var val = -nega(makeMove(state, moves[i]), depth - 1, -Infinity, Infinity) + (Math.random() * 10 - 5);
      if (val > best + 6) { best = val; bestMoves = [moves[i]]; }
      else if (val > best - 6) { bestMoves.push(moves[i]); if (val > best) best = val; }
    }
    return bestMoves[Math.floor(Math.random() * bestMoves.length)];
  }

  /* ===================== gemeinsames Brett-Layout ===================== */
  function displayOrder(view) {
    var order = [], r, c;
    if (view === 'w') { for (r = 0; r < 8; r++) for (c = 0; c < 8; c++) order.push(r * 8 + c); }
    else { for (r = 7; r >= 0; r--) for (c = 7; c >= 0; c--) order.push(r * 8 + c); }
    return order;
  }
  function buildLayout(view, onSquare, names) {
    var wChip = chip('w', names.w), bChip = chip('b', names.b);
    var scores = el('div', { class: 'ch-players' }, [wChip.root, bChip.root]);
    var statusEl = el('div', { class: 'ch-status you' }, ['']);
    var board = el('div', { class: 'ch-board' });
    var cells = new Array(64);
    displayOrder(view).forEach(function (sq) {
      var r = Math.floor(sq / 8), c = sq % 8;
      var cell = el('button', { class: 'ch-sq ' + ((r + c) % 2 === 0 ? 'light' : 'dark'), type: 'button', onclick: function () { onSquare(sq); } });
      cells[sq] = cell; board.appendChild(cell);
    });
    var wrap = el('div', { class: 'ch-wrap' }, [
      el('div', { class: 'ch-top' }, [el('div', { class: 'ch-brand neon' }, ['♛ Schach']), el('div', { class: 'ch-hint-turn' }, [''])]),
      scores, statusEl,
      el('div', { class: 'ch-board-holder' }, [board])
    ]);
    return { root: wrap, board: board, cells: cells, statusEl: statusEl, wChip: wChip, bChip: bChip };
  }
  function chip(color, name) {
    var nameEl = el('div', { class: 'ch-nm' }, [name || '—']);
    var scoreEl = el('div', { class: 'ch-sc' }, ['0']);
    var root = el('div', { class: 'ch-chip ch-chip-' + color }, [
      el('span', { class: 'ch-chip-sym ch-pc ch-' + color }, [GLYPH.k]),
      el('div', { class: 'ch-chip-info' }, [nameEl, el('div', { class: 'ch-mini' }, [color === 'w' ? 'Weiß' : 'Schwarz'])]),
      scoreEl
    ]);
    return { root: root, nameEl: nameEl, scoreEl: scoreEl };
  }

  function paintBoard(refs, board, o) {
    o = o || {};
    var checkSq = -1;
    if (o.checkColor) { var ks = kingSquare(board, o.checkColor); if (ks >= 0) checkSq = ks; }
    for (var i = 0; i < 64; i++) {
      var cell = refs.cells[i], pc = board[i];
      var want = pc === '.' ? '' : GLYPH[typeOf(pc)];
      var pcEl = cell.firstChild;
      if (pc === '.') { if (pcEl) cell.removeChild(pcEl); }
      else {
        if (!pcEl) { pcEl = el('span', { class: 'ch-pc' }, [want]); cell.appendChild(pcEl); }
        pcEl.textContent = want;
        pcEl.className = 'ch-pc ch-' + colorOf(pc);
      }
      cell.classList.toggle('sel', o.selected === i);
      cell.classList.toggle('target', !!(o.targets && o.targets.indexOf(i) >= 0));
      cell.classList.toggle('cap', !!(o.targets && o.targets.indexOf(i) >= 0) && pc !== '.');
      cell.classList.toggle('last', !!(o.last && (o.last.from === i || o.last.to === i)));
      cell.classList.toggle('check', i === checkSq);
    }
    refs.board.classList.toggle('mymove', !!o.myMove);
  }
  function updateChips(refs, vm) {
    refs.wChip.nameEl.textContent = vm.wName; refs.bChip.nameEl.textContent = vm.bName;
    refs.wChip.scoreEl.textContent = vm.wScore; refs.bChip.scoreEl.textContent = vm.bScore;
    refs.wChip.root.classList.toggle('active', vm.turn === 'w' && !vm.over);
    refs.bChip.root.classList.toggle('active', vm.turn === 'b' && !vm.over);
  }
  function resultTexts(type, mine) {
    if (type === 'checkmate') return { title: mine === 'win' ? '🏆 Schachmatt – Gewonnen!' : '💀 Schachmatt – Verloren', sub: mine === 'win' ? 'Sauber matt gesetzt!' : 'Nächstes Mal!', cls: mine };
    if (type === 'stalemate') return { title: '🤝 Patt', sub: 'Kein Zug mehr möglich – Remis.', cls: 'draw' };
    if (type === '50move') return { title: '🤝 Remis', sub: '50 Züge ohne Bauernzug/Schlag.', cls: 'draw' };
    return { title: '🤝 Remis', sub: 'Ungenügendes Material.', cls: 'draw' };
  }
  function overlay(refs, texts, actions) {
    var ov = el('div', { class: 'ch-result ch-result-' + texts.cls }, [
      el('div', { class: 'ch-result-card glass' }, [
        el('h2', { class: 'ch-big neon' }, [texts.title]),
        el('p', { class: 'ch-endsub' }, [texts.sub]),
        el('div', { class: 'ch-actions' }, actions)
      ])
    ]);
    refs.root.appendChild(ov);
    return ov;
  }
  function promoOverlay(refs, color, onPick) {
    var box = el('div', { class: 'ch-promo' }, [
      el('div', { class: 'ch-promo-card glass' }, [
        el('div', { class: 'ch-promo-title' }, ['Umwandeln in:']),
        el('div', { class: 'ch-promo-row' }, ['q', 'r', 'b', 'n'].map(function (p) {
          return el('button', { class: 'btn ch-promo-btn', type: 'button', title: PIECE_DE[p], onclick: function () { refs.root.removeChild(box); onPick(p); } }, [
            el('span', { class: 'ch-pc ch-' + color }, [GLYPH[p]])
          ]);
        }))
      ])
    ]);
    refs.root.appendChild(box);
    return box;
  }

  /* ===================== Spiel-Modul ===================== */
  App.Minigames.chess = {
    id: 'chess', title: 'Schach', icon: '♛', order: 21,
    subtitle: 'Das königliche Duell – Solo gegen den Bot oder zu zweit',
    single: true, multi: true, minPlayers: 2, maxPlayers: 2,

    render: function (root, ctx) {
      var destroyed = false, timers = [];
      function after(ms, fn) { var t = setTimeout(fn, ms); timers.push(t); return t; }
      function clearTimers() { timers.forEach(clearTimeout); timers = []; }

      if (ctx.mode === 'multi' && ctx.room) return renderMulti();
      return renderSingle();

      /* ========================= SOLO ========================= */
      function renderSingle() {
        var state, refs, sel, targets, allLegal, over, busy, lastMv, promoBox;
        var scores = { w: 0, b: 0 };
        start();
        return { cleanup: function () { destroyed = true; clearTimers(); } };

        function start() {
          state = initialState(); sel = null; targets = []; over = false; busy = false; lastMv = null; promoBox = null;
          allLegal = legalMoves(state);
          refs = buildLayout('w', onSquare, { w: 'Du', b: 'Bot' });
          root.innerHTML = ''; root.appendChild(refs.root);
          paint();
        }
        function paint() {
          var chk = inCheck(state, state.turn) && !over ? state.turn : null;
          paintBoard(refs, state.board, { selected: sel, targets: targets, last: lastMv, checkColor: chk, myMove: state.turn === 'w' && !over && !busy });
          updateChips(refs, { wName: 'Du', bName: 'Bot', wScore: scores.w, bScore: scores.b, turn: state.turn, over: over });
          refs.statusEl.textContent = soloStatus(chk);
          refs.statusEl.className = 'ch-status ' + (over ? 'draw' : state.turn === 'w' ? 'you' : 'opp');
        }
        function soloStatus(chk) {
          if (over) return 'Partie beendet';
          if (state.turn === 'w') return (chk ? 'Schach! ' : '') + 'Du bist am Zug (Weiß)';
          return (chk ? 'Schach! ' : '') + 'Bot denkt …';
        }
        function onSquare(sq) {
          if (destroyed || over || busy || promoBox || state.turn !== 'w') return;
          if (sel != null) {
            var mvs = allLegal.filter(function (m) { return m.from === sel && m.to === sq; });
            if (mvs.length) {
              if (mvs[0].promo) { sel = null; targets = []; promoBox = promoOverlay(refs, 'w', function (p) { promoBox = null; applyPlayer(mvs.filter(function (m) { return m.promo === p; })[0]); }); paint(); return; }
              applyPlayer(mvs[0]); return;
            }
          }
          var pc = state.board[sq];
          if (pc !== '.' && colorOf(pc) === 'w') { sel = sq; targets = allLegal.filter(function (m) { return m.from === sq; }).map(function (m) { return m.to; }); }
          else { sel = null; targets = []; }
          paint();
        }
        function applyPlayer(mv) {
          state = makeMove(state, mv); lastMv = { from: mv.from, to: mv.to }; sel = null; targets = [];
          allLegal = legalMoves(state);
          var res = gameResult(state); paint();
          if (res.over) return finish(res);
          busy = true; paint(); scheduleBot();
        }
        function scheduleBot() {
          after(480, function () {
            if (destroyed || over) return;
            var mv = pickBot(state, SEARCH_DEPTH);
            if (!mv) { return finish(gameResult(state)); }
            state = makeMove(state, mv); lastMv = { from: mv.from, to: mv.to };
            allLegal = legalMoves(state); busy = false;
            var res = gameResult(state); paint();
            if (res.over) finish(res);
          });
        }
        function finish(res) {
          over = true;
          if (res.type === 'checkmate' && res.winner === 'w') scores.w++;
          else if (res.type === 'checkmate' && res.winner === 'b') scores.b++;
          paint();
          var mine = res.type === 'checkmate' ? (res.winner === 'w' ? 'win' : 'lose') : 'draw';
          if (mine === 'win' && App.Scores) App.Scores.winCurrent();
          after(650, function () {
            if (destroyed) return;
            overlay(refs, resultTexts(res.type, mine), [
              el('button', { class: 'btn btn-primary btn-lg', type: 'button', onclick: function () { start(); } }, ['Nochmal']),
              el('button', { class: 'btn btn-ghost btn-lg', type: 'button', onclick: ctx.onExit }, ['Zurück'])
            ]);
          });
        }
      }

      /* ========================= MULTI ========================= */
      function renderMulti() {
        var room = ctx.room, me = ctx.me;
        var lastShared = (room.snapshot() && room.snapshot().shared) || null;
        var refs = null, curView = null, initDone = false;
        var sel = null, targets = [], allLegal = [], lastBoardKey = '', promoBox = null, endShownGame = -1;

        function onShared(sh) { if (destroyed) return; lastShared = sh; sync(); }
        function onPlayers() { if (destroyed) return; sync(); }
        room.on('shared', onShared); room.on('players', onPlayers);
        sync();

        return {
          cleanup: function () { destroyed = true; clearTimers(); room.off('shared', onShared); room.off('players', onPlayers); }
        };

        function myColor(sh) { if (!sh || !sh.order) return null; return sh.order[0] === me.id ? 'w' : sh.order[1] === me.id ? 'b' : null; }
        function playerById(players, id) { for (var i = 0; i < players.length; i++) if (players[i].id === id) return players[i]; return null; }
        function sharedToState(sh) {
          return { board: sh.board.split(''), turn: sh.turn, castle: Object.assign({ K: false, Q: false, k: false, q: false }, sh.castle || {}), ep: (typeof sh.ep === 'number' ? sh.ep : -1), half: sh.half || 0 };
        }

        function sync() {
          var players = room.players();
          if (players.length < 2) { showWaiting(players); return; }
          var sh = lastShared;
          if (!sh || !sh.board) { if (room.isHost() && !initDone) { initDone = true; initShared(players); } else showWaiting(players, true); return; }
          ensureBoard(sh);
          var st = sharedToState(sh);
          var boardKey = sh.board + '|' + sh.turn + '|' + (sh.gameId || 0);
          if (boardKey !== lastBoardKey) { lastBoardKey = boardKey; sel = null; targets = []; if (promoBox && refs) { try { refs.root.removeChild(promoBox); } catch (e) {} promoBox = null; } allLegal = legalMoves(st); }
          paint(sh, st, players);
          if (sh.result) showEnd(sh, players);
        }

        function initShared(players) {
          var sc = {}; sc[players[0].id] = 0; sc[players[1].id] = 0;
          room.setShared({ order: [players[0].id, players[1].id], board: initialBoard().join(''), turn: 'w', castle: { K: true, Q: true, k: true, q: true }, ep: -1, half: 0, result: null, winner: null, last: null, scores: sc, gameId: 1 });
        }
        function ensureBoard(sh) {
          if (curView === 'game') return;
          curView = 'game';
          refs = buildLayout(myColor(sh) === 'b' ? 'b' : 'w', onSquare, { w: 'Weiß', b: 'Schwarz' });
          root.innerHTML = ''; root.appendChild(refs.root);
        }
        function paint(sh, st, players) {
          var mc = myColor(sh);
          var wP = playerById(players, sh.order[0]), bP = playerById(players, sh.order[1]);
          var chk = !sh.result && inCheck(st, st.turn) ? st.turn : null;
          paintBoard(refs, st.board, { selected: sel, targets: targets, last: sh.last, checkColor: chk, myMove: !sh.result && mc === st.turn });
          updateChips(refs, {
            wName: (wP ? wP.name : 'Weiß') + (mc === 'w' ? ' (du)' : ''),
            bName: (bP ? bP.name : 'Schwarz') + (mc === 'b' ? ' (du)' : ''),
            wScore: (sh.scores && sh.scores[sh.order[0]]) || 0, bScore: (sh.scores && sh.scores[sh.order[1]]) || 0,
            turn: st.turn, over: !!sh.result
          });
          refs.statusEl.className = 'ch-status ' + (sh.result ? 'draw' : mc === st.turn ? 'you' : 'opp');
          refs.statusEl.textContent = multiStatus(sh, st, players, mc, chk);
        }
        function multiStatus(sh, st, players, mc, chk) {
          if (sh.result) return 'Partie beendet';
          if (mc == null) return 'Du schaust zu';
          if (st.turn === mc) return (chk ? 'Schach! ' : '') + 'Du bist am Zug';
          var t = playerById(players, st.turn === 'w' ? sh.order[0] : sh.order[1]);
          return (chk ? 'Schach! ' : '') + (t ? t.name : 'Gegner') + ' ist am Zug';
        }
        function onSquare(sq) {
          var sh = lastShared; if (destroyed || !sh || sh.result || promoBox) return;
          var mc = myColor(sh); if (!mc) return;
          var st = sharedToState(sh);
          if (st.turn !== mc) { if (st.board[sq] !== '.' && colorOf(st.board[sq]) === mc) UI.toast('Warte — du bist nicht am Zug', 'info'); return; }
          if (sel != null) {
            var mvs = allLegal.filter(function (m) { return m.from === sel && m.to === sq; });
            if (mvs.length) {
              if (mvs[0].promo) { sel = null; targets = []; promoBox = promoOverlay(refs, mc, function (p) { promoBox = null; applyMove(sh, mvs.filter(function (m) { return m.promo === p; })[0]); }); paint(sh, st, room.players()); return; }
              applyMove(sh, mvs[0]); return;
            }
          }
          var pc = st.board[sq];
          if (pc !== '.' && colorOf(pc) === mc) { sel = sq; targets = allLegal.filter(function (m) { return m.from === sq; }).map(function (m) { return m.to; }); }
          else { sel = null; targets = []; }
          paint(sh, st, room.players());
        }
        function applyMove(sh, mv) {
          var st = sharedToState(sh);
          var ns = makeMove(st, mv);
          var res = gameResult(ns);
          var patch = { board: ns.board.join(''), turn: ns.turn, castle: ns.castle, ep: ns.ep, half: ns.half, last: { from: mv.from, to: mv.to } };
          if (res.over) {
            patch.result = res.type;
            if (res.type === 'checkmate') {
              var winId = res.winner === 'w' ? sh.order[0] : sh.order[1];
              patch.winner = winId;
              var sc = Object.assign({}, sh.scores || {}); sc[winId] = (sc[winId] || 0) + 1; patch.scores = sc;
            } else patch.winner = 'draw';
          }
          sel = null; targets = [];
          room.setShared(patch);
        }
        function rematch() {
          var sh = lastShared; if (!sh) return;
          room.setShared({ board: initialBoard().join(''), turn: 'w', castle: { K: true, Q: true, k: true, q: true }, ep: -1, half: 0, result: null, winner: null, last: null, gameId: (sh.gameId || 1) + 1, scores: Object.assign({}, sh.scores || {}) });
        }
        function showEnd(sh, players) {
          if (endShownGame === (sh.gameId || 0)) return;
          endShownGame = sh.gameId || 0;
          var mc = myColor(sh);
          var mine = sh.winner === 'draw' || !sh.winner ? 'draw' : (sh.winner === me.id ? 'win' : 'lose');
          if (mine === 'win' && App.Scores) App.Scores.winCurrent();
          var actions;
          if (room.isHost()) actions = [
            el('button', { class: 'btn btn-primary btn-lg', type: 'button', onclick: rematch }, ['Revanche']),
            el('button', { class: 'btn btn-ghost btn-lg', type: 'button', onclick: ctx.onExit }, ['Zurück zur Lobby'])
          ];
          else actions = [el('button', { class: 'btn btn-primary btn-lg', type: 'button', onclick: ctx.onExit }, ['Zurück zur Lobby'])];
          after(500, function () {
            if (destroyed || !refs) return;
            var old = refs.root.querySelector('.ch-result'); if (old) old.parentNode.removeChild(old);
            var ov = overlay(refs, resultTexts(sh.result, mine), actions);
            if (!room.isHost()) ov.querySelector('.ch-result-card').appendChild(el('p', { class: 'ch-hint' }, ['Der Host kann eine Revanche starten.']));
          });
        }
        function showWaiting(players, starting) {
          if (curView !== 'waiting') {
            curView = 'waiting';
            var count = el('div', { class: 'ch-big neon' }, ['1 / 2']);
            var msg = el('p', { class: 'ch-endsub' }, ['']);
            root.innerHTML = '';
            root.appendChild(el('div', { class: 'ch-panel glass' }, [
              el('div', { class: 'ch-wait-icon' }, ['♛']),
              el('h2', { class: 'neon' }, ['Schach']),
              count, msg,
              el('div', { class: 'ch-actions' }, [el('button', { class: 'btn btn-ghost', type: 'button', onclick: ctx.onExit }, ['Zurück zur Lobby'])])
            ]));
            curView2Refs = { count: count, msg: msg };
          }
          curView2Refs.count.textContent = players.length + ' / 2';
          curView2Refs.msg.textContent = starting ? 'Spiel startet gleich …' : 'Warte auf den zweiten Spieler …';
        }
        var curView2Refs = null;
      }
    }
  };

  /* ===================== CSS ===================== */
  function injectStyle() {
    UI.injectStyle('mg-chess-css', [
      '.ch-wrap{display:flex;flex-direction:column;gap:12px;max-width:520px;margin:0 auto;position:relative;}',
      '.ch-top{display:flex;justify-content:space-between;align-items:center;gap:10px;}',
      '.ch-brand{font-weight:900;font-size:18px;}',
      '.ch-players{display:flex;gap:10px;}',
      '.ch-chip{flex:1;min-width:0;display:flex;align-items:center;gap:9px;padding:8px 12px;border-radius:14px;background:rgba(9,32,21,.6);border:1px solid var(--stroke);transition:.15s;}',
      '.ch-chip-sym{font-size:22px;}',
      '.ch-chip-info{flex:1;min-width:0;display:flex;flex-direction:column;line-height:1.15;}',
      '.ch-nm{font-weight:800;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      '.ch-mini{font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;}',
      '.ch-sc{font-size:22px;font-weight:900;color:var(--leaf);}',
      '.ch-chip.active{border-color:var(--neon);box-shadow:0 0 0 1px var(--neon),0 0 16px rgba(57,255,20,.32);}',
      '.ch-status{text-align:center;font-weight:900;font-size:clamp(15px,4.2vw,19px);min-height:24px;}',
      '.ch-status.you{color:var(--neon);text-shadow:0 0 10px rgba(57,255,20,.4);}',
      '.ch-status.opp{color:var(--aqua);}',
      '.ch-status.draw{color:var(--gold);}',
      '.ch-board-holder{width:100%;}',
      '.ch-board{display:grid;grid-template-columns:repeat(8,1fr);gap:0;width:100%;aspect-ratio:1/1;border-radius:14px;overflow:hidden;border:2px solid var(--stroke-2,var(--stroke));box-shadow:0 8px 30px rgba(0,0,0,.4);}',
      '.ch-sq{position:relative;display:flex;align-items:center;justify-content:center;padding:0;border:none;cursor:default;-webkit-tap-highlight-color:transparent;transition:background .12s;}',
      '.ch-sq.light{background:#3f7a58;}',
      '.ch-sq.dark{background:#1c4630;}',
      '.ch-board.mymove .ch-sq{cursor:pointer;}',
      '.ch-pc{font-size:clamp(20px,7.2vw,42px);line-height:1;pointer-events:none;user-select:none;-webkit-user-select:none;}',
      '.ch-pc.ch-w{color:#f2fff7;text-shadow:0 1px 1px rgba(0,0,0,.55),0 0 3px rgba(0,0,0,.4);}',
      '.ch-pc.ch-b{color:#08160e;-webkit-text-stroke:1.3px rgba(180,255,215,.9);text-shadow:0 0 5px rgba(0,0,0,.35);}',
      '.ch-sq.sel{box-shadow:inset 0 0 0 3px var(--neon);}',
      '.ch-sq.last{box-shadow:inset 0 0 0 3px rgba(255,210,63,.55);}',
      '.ch-sq.sel.last{box-shadow:inset 0 0 0 3px var(--neon);}',
      '.ch-sq.target::after{content:"";position:absolute;width:30%;height:30%;border-radius:50%;background:rgba(57,255,20,.55);box-shadow:0 0 8px rgba(57,255,20,.5);}',
      '.ch-sq.target.cap::after{width:82%;height:82%;background:transparent;border:3px solid rgba(57,255,20,.7);box-shadow:0 0 10px rgba(57,255,20,.4);}',
      '.ch-sq.check{background:radial-gradient(circle,rgba(255,77,109,.85),rgba(255,77,109,.35)) !important;animation:ch-checkpulse 1s ease-in-out infinite;}',
      '@keyframes ch-checkpulse{0%,100%{box-shadow:inset 0 0 12px rgba(255,77,109,.5);}50%{box-shadow:inset 0 0 26px rgba(255,77,109,.9);}}',
      '.ch-hint-turn{font-size:11px;color:var(--muted);}',
      /* Overlays (Ergebnis / Umwandlung) */
      '.ch-result,.ch-promo{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(2,10,6,.72);backdrop-filter:blur(3px);border-radius:14px;z-index:20;animation:ch-fade .2s ease;}',
      '@keyframes ch-fade{from{opacity:0}to{opacity:1}}',
      '.ch-result-card,.ch-promo-card{padding:24px 22px;text-align:center;display:flex;flex-direction:column;gap:12px;align-items:center;max-width:88%;}',
      '.ch-big{font-size:clamp(22px,7vw,34px);font-weight:900;line-height:1.15;}',
      '.ch-endsub{color:var(--muted);margin:0;}',
      '.ch-actions{display:flex;gap:10px;justify-content:center;flex-wrap:wrap;margin-top:4px;}',
      '.ch-promo-title{font-weight:800;color:var(--leaf);}',
      '.ch-promo-row{display:flex;gap:10px;}',
      '.ch-promo-btn{width:56px;height:56px;display:flex;align-items:center;justify-content:center;padding:0;}',
      '.ch-promo-btn .ch-pc{font-size:34px;}',
      '.ch-panel{padding:28px 22px;text-align:center;display:flex;flex-direction:column;gap:14px;align-items:center;max-width:460px;margin:0 auto;}',
      '.ch-wait-icon{font-size:48px;animation:ch-bob 2.2s ease-in-out infinite;filter:drop-shadow(0 0 10px rgba(57,255,20,.4));}',
      '@keyframes ch-bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-6px)}}',
      '.ch-hint{color:var(--muted);font-size:12px;margin:6px 0 0;}'
    ].join(''));
  }
})();
