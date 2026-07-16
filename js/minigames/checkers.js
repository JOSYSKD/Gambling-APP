/* checkers.js — "Dame": klassisches Damespiel auf 8x8 im Neon-Dschungel-Look.
 *
 * REGELN (internationale Variante auf 8x8):
 *   - Gespielt wird nur auf den dunklen Feldern, immer diagonal.
 *   - Steine ziehen 1 Feld vorwärts, schlagen aber in ALLE vier Richtungen
 *     (vorwärts wie rückwärts) über einen gegnerischen Stein hinweg.
 *   - Mehrfachsprünge werden in einem Zug zu Ende geführt.
 *   - Schlagzwang: gibt es irgendwo einen Schlag, muss geschlagen werden.
 *   - Ein Stein, der seine Zugrichtung bis zur hintersten Reihe schafft und
 *     dort stehen bleibt, wird 👑 Dame und zieht/schlägt beliebig weit diagonal.
 *     (Wer mitten im Sprung über die letzte Reihe springt, bleibt Stein.)
 *   - Verloren hat, wer keine Steine mehr hat oder keinen Zug mehr machen kann.
 *   - 50 Halbzüge ohne Schlag und ohne Steinzug = Remis.
 *
 * STEUERUNG: Eigenen Stein antippen → alle legalen Ziele leuchten auf
 *   (grüner Punkt = ruhiger Zug, goldener Ring = Sprung, rotes Feld = Opfer).
 *   Ziel antippen = ziehen. Bei Mehrfachsprüngen einfach weiterklicken.
 *   Nochmal auf den eigenen Stein tippen = Auswahl aufheben.
 *
 * SOLO   (ctx.mode==='single'): gegen einen Bot mit Negamax + Alpha-Beta
 *   (Material + Damen-Wert + Vorrückbonus, Schlag-Verlängerung gegen den
 *   Horizont-Effekt). 3 Stufen: Leicht (Tiefe 2 + Patzer), Mittel (Tiefe 3),
 *   Schwer (Tiefe 4, im Endspiel 6). Punkte = geschlagene Steine + Sieg-Bonus
 *   + übrige Steine + Stufen-Bonus + Zeitbonus; Bestwert in App.Storage.
 * MULTI  (ctx.mode==='multi'): rundenbasiert über room.shared
 *   ({order, board[64], turn, moveNo, idle, lastMove, over, result, game}).
 *   Wer am Zug ist, rechnet den Zug lokal und schreibt das Ergebnis per
 *   setShared; der Gegner spielt ihn aus lastMove Hop für Hop nach (moveNo
 *   verhindert doppeltes Abspielen bei Heartbeat-Events). Jeder sieht die
 *   eigenen Steine unten (Brett wird für Grün gedreht). Start via
 *   App.MG.countdown mit room.now(), Ende via App.MG.endScreen.
 *
 * Alle Zeiten laufen über Wall-Clock (Date.now / room.now), Animationen über
 * CSS-Transitions — kein Frame-Zählen. cleanup() beendet Timer + Listener. */
(function () {
  'use strict';
  window.App = window.App || {}; App.Minigames = App.Minigames || {};
  var UI = App.UI, el = UI.el;

  injectStyle();

  /* ===================== Konstanten ===================== */
  var RED = 1, GRN = -1;                     // Rot zieht nach oben, Grün nach unten
  var DIRS = [[-1, -1], [-1, 1], [1, -1], [1, 1]];
  var HOP_MS = 250;                          // ms pro Teilsprung der Animation
  var IDLE_DRAW = 50;                        // Halbzüge ohne Aktion → Remis
  var NODE_CAP = 220000;                     // Notbremse für die Suche
  var QEXT = 4;                              // zusätzliche Schlag-Halbzüge

  var LEVEL_ORDER = ['leicht', 'mittel', 'schwer'];
  var LEVELS = {
    leicht: { name: 'Leicht', icon: '🌱', sub: '2 Züge voraus – patzt gerne mal', depth: 2, rand: 0.3, bonus: 0 },
    mittel: { name: 'Mittel', icon: '🌿', sub: '3 Züge voraus – passt gut auf', depth: 3, rand: 0.08, bonus: 300 },
    schwer: { name: 'Schwer', icon: '🔥', sub: '4 Züge voraus, im Endspiel 6', depth: 4, rand: 0, bonus: 700 }
  };

  function beep(n) { if (App.Audio) App.Audio.sfx(n); }

  /* ===================== reine Brett-Logik ===================== */
  function sideOf(v) { return v > 0 ? 1 : (v < 0 ? -1 : 0); }
  function isKing(v) { return v === 2 || v === -2; }
  function onBoard(r, c) { return r >= 0 && r < 8 && c >= 0 && c < 8; }
  function zeros() { var b = [], i; for (i = 0; i < 64; i++) b[i] = 0; return b; }

  function startBoard() {
    var b = zeros(), r, c, i;
    for (r = 0; r < 8; r++) for (c = 0; c < 8; c++) {
      i = r * 8 + c;
      if ((r + c) % 2 !== 1) continue;
      if (r < 3) b[i] = -1; else if (r > 4) b[i] = 1;
    }
    return b;
  }
  function countSide(b, side) { var n = 0, i; for (i = 0; i < 64; i++) if (b[i] !== 0 && sideOf(b[i]) === side) n++; return n; }

  /* Firebase kann Arrays als Objekte zurückgeben → defensiv normalisieren. */
  function toBoard(v) {
    if (!v) return null;
    var b = zeros(), i, x;
    for (i = 0; i < 64; i++) { x = v[i]; b[i] = (typeof x === 'number') ? x : 0; }
    return b;
  }
  function toArr(v) {
    if (!v) return [];
    if (Array.isArray(v)) return v.slice();
    var keys = Object.keys(v), out = [];
    keys.sort(function (a, b) { return (+a) - (+b); });
    keys.forEach(function (k) { out.push(v[k]); });
    return out;
  }

  /* Alle maximalen Schlagfolgen eines Steins. Geschlagene Steine bleiben bis
     zum Zugende als Blocker liegen und dürfen nicht doppelt geschlagen werden. */
  function capsFrom(b, from, out) {
    var piece = b[from];
    var w = b.slice(); w[from] = 0;
    capRec(w, from, piece, [], [from], out);
  }
  function capRec(w, sq, piece, caps, path, out) {
    var king = isKing(piece), side = sideOf(piece);
    var r = sq >> 3, c = sq & 7, found = false, d, dr, dc;
    for (d = 0; d < 4; d++) {
      dr = DIRS[d][0]; dc = DIRS[d][1];
      if (king) {
        var rr = r + dr, cc = c + dc;
        while (onBoard(rr, cc) && w[rr * 8 + cc] === 0) { rr += dr; cc += dc; }
        if (!onBoard(rr, cc)) continue;
        var tgt = rr * 8 + cc;
        if (sideOf(w[tgt]) === side) continue;
        if (caps.indexOf(tgt) >= 0) continue;
        var lr = rr + dr, lc = cc + dc;
        while (onBoard(lr, lc) && w[lr * 8 + lc] === 0) {
          found = true;
          capRec(w, lr * 8 + lc, piece, caps.concat([tgt]), path.concat([lr * 8 + lc]), out);
          lr += dr; lc += dc;
        }
      } else {
        var mr = r + dr, mc = c + dc;
        if (!onBoard(mr, mc)) continue;
        var mid = mr * 8 + mc;
        if (w[mid] === 0 || sideOf(w[mid]) === side) continue;
        if (caps.indexOf(mid) >= 0) continue;
        var jr = r + 2 * dr, jc = c + 2 * dc;
        if (!onBoard(jr, jc)) continue;
        var land = jr * 8 + jc;
        if (w[land] !== 0) continue;
        found = true;
        capRec(w, land, piece, caps.concat([mid]), path.concat([land]), out);
      }
    }
    if (!found && caps.length) out.push({ path: path.slice(), caps: caps.slice() });
  }

  function quietFrom(b, from, out) {
    var piece = b[from], side = sideOf(piece), king = isKing(piece);
    var r = from >> 3, c = from & 7, d, dr, dc;
    for (d = 0; d < 4; d++) {
      dr = DIRS[d][0]; dc = DIRS[d][1];
      if (!king && dr !== -side) continue;          // Steine ziehen nur vorwärts
      var rr = r + dr, cc = c + dc;
      if (king) {
        while (onBoard(rr, cc) && b[rr * 8 + cc] === 0) { out.push({ path: [from, rr * 8 + cc], caps: [] }); rr += dr; cc += dc; }
      } else if (onBoard(rr, cc) && b[rr * 8 + cc] === 0) {
        out.push({ path: [from, rr * 8 + cc], caps: [] });
      }
    }
  }

  /* Alle legalen Züge einer Seite — mit Schlagzwang. */
  function genMoves(b, side) {
    var caps = [], quiet = [], i;
    for (i = 0; i < 64; i++) if (b[i] !== 0 && sideOf(b[i]) === side) capsFrom(b, i, caps);
    if (caps.length) return caps;
    for (i = 0; i < 64; i++) if (b[i] !== 0 && sideOf(b[i]) === side) quietFrom(b, i, quiet);
    return quiet;
  }

  /* Brett nach k Teilsprüngen (ohne Umwandlung — die kommt erst am Zugende). */
  function stepBoard(b, path, caps, k) {
    var nb = b.slice(), v = nb[path[0]], j;
    nb[path[0]] = 0;
    for (j = 0; j < k && j < caps.length; j++) if (caps[j] != null) nb[caps[j]] = 0;
    nb[path[k]] = v;
    return nb;
  }
  function applyMove(b, mv) {
    var nb = b.slice(), path = mv.path, caps = mv.caps || [];
    var from = path[0], to = path[path.length - 1], v = nb[from], j;
    nb[from] = 0;
    for (j = 0; j < caps.length; j++) nb[caps[j]] = 0;
    if (v === 1 && (to >> 3) === 0) v = 2;
    else if (v === -1 && (to >> 3) === 7) v = -2;
    nb[to] = v;
    return nb;
  }

  /* ===================== Bot: Negamax + Alpha-Beta ===================== */
  var nodes = 0;

  /* Material + Damen + Vorrückbonus (+ Randsicherheit / Grundreihe / zentrale Damen) */
  function evaluate(b, side) {
    var s = 0, i, v, r, c;
    for (i = 0; i < 64; i++) {
      v = b[i]; if (v === 0) continue;
      r = i >> 3; c = i & 7;
      if (v === 1) s += 100 + (7 - r) * 7 + ((c === 0 || c === 7) ? 6 : 0) + (r === 7 ? 12 : 0);
      else if (v === 2) s += 275 + centerBonus(r, c);
      else if (v === -1) s -= 100 + r * 7 + ((c === 0 || c === 7) ? 6 : 0) + (r === 0 ? 12 : 0);
      else s -= 275 + centerBonus(r, c);
    }
    return side === 1 ? s : -s;
  }
  function centerBonus(r, c) {
    var dr = Math.abs(r * 2 - 7), dc = Math.abs(c * 2 - 7);
    return Math.max(0, 12 - (dr + dc));
  }
  function byCaps(x, y) { return y.caps.length - x.caps.length; }

  function negamax(b, side, depth, alpha, beta, ext) {
    var moves = genMoves(b, side);
    if (!moves.length) return -(100000 + depth);          // wer nicht ziehen kann, verliert
    nodes++;
    if (nodes > NODE_CAP) return evaluate(b, side);
    var forced = moves[0].caps.length > 0;
    if (depth <= 0 && (!forced || ext <= 0)) return evaluate(b, side);
    if (moves.length > 1) moves.sort(byCaps);
    var best = -Infinity, i, val, nextExt = depth <= 0 ? ext - 1 : ext;
    for (i = 0; i < moves.length; i++) {
      val = -negamax(applyMove(b, moves[i]), -side, depth - 1, -beta, -alpha, nextExt);
      if (val > best) best = val;
      if (best > alpha) alpha = best;
      if (alpha >= beta) break;
    }
    return best;
  }

  function botMove(b, side, lv) {
    var moves = genMoves(b, side);
    if (!moves.length) return null;
    if (moves.length === 1) return moves[0];
    var cfg = LEVELS[lv] || LEVELS.mittel;
    if (cfg.rand > 0 && Math.random() < cfg.rand) return moves[Math.floor(Math.random() * moves.length)];
    var depth = cfg.depth;
    if (countSide(b, 1) + countSide(b, -1) <= 8) depth += 2;   // Endspiel tiefer rechnen
    moves.sort(byCaps);
    nodes = 0;
    var best = -Infinity, list = [], i, val, beta;
    for (i = 0; i < moves.length; i++) {
      beta = (best === -Infinity) ? Infinity : -(best - 1);
      val = -negamax(applyMove(b, moves[i]), -side, depth - 1, -Infinity, beta, QEXT);
      if (val > best) { best = val; list = [moves[i]]; }
      else if (val === best) list.push(moves[i]);
    }
    return list[Math.floor(Math.random() * list.length)];
  }

  /* ===================== Brett-Ansicht ===================== */
  function posOf(i, flip) { var k = flip ? 63 - i : i; return { r: k >> 3, c: k & 7 }; }
  function setPos(node, i, flip) {
    var p = posOf(i, flip);
    node.style.transform = 'translate(' + (p.c * 100) + '%,' + (p.r * 100) + '%)';
  }
  function makePiece(v, i, flip) {
    var node = el('div', { class: 'chk-pc ' + (v > 0 ? 'chk-red' : 'chk-green') + (isKing(v) ? ' chk-king' : '') }, [
      el('div', { class: 'chk-disc' }, [el('span', { class: 'chk-crown' }, ['👑'])])
    ]);
    setPos(node, i, flip);
    return node;
  }

  /* Hält die Steine als eigene Ebene über dem Raster → Züge gleiten per
     CSS-Transition. sync() gleicht per Diff ab (ein Zieher, n geschlagene). */
  function makeBoardView(flip, onSquare) {
    var squares = [], k;
    var grid = el('div', { class: 'chk-grid' });
    var layer = el('div', { class: 'chk-pieces' });
    for (k = 0; k < 64; k++) {
      (function (kk) {
        var bi = flip ? 63 - kk : kk;
        var dark = ((bi >> 3) + (bi & 7)) % 2 === 1;
        var sq = el('div', { class: 'chk-sq ' + (dark ? 'chk-dark' : 'chk-light') });
        if (dark) sq.addEventListener('pointerdown', function (e) { if (e && e.preventDefault) e.preventDefault(); onSquare(bi); });
        squares[bi] = sq; grid.appendChild(sq);
      })(k);
    }
    var boardEl = el('div', { class: 'chk-board' }, [grid, layer]);

    var cur = zeros(), map = {}, timers = [], animating = false, pendingB = null;

    function clearTimers() { timers.forEach(clearTimeout); timers = []; }
    function later(ms, fn) { timers.push(setTimeout(fn, ms)); }

    function sync(nb, hard) {
      if (hard) {
        clearTimers(); animating = false; pendingB = null;
        layer.innerHTML = ''; map = {}; cur = zeros();
      }
      var removed = [], added = [], i;
      for (i = 0; i < 64; i++) {
        if (cur[i] === nb[i]) continue;
        if (cur[i] !== 0) removed.push(i);
        if (nb[i] !== 0) added.push(i);
      }
      if (!removed.length && !added.length) return;
      var used = {};
      added.forEach(function (a) {
        var s = nb[a] > 0 ? 1 : -1, rec = null, hit = -1, j, rr;
        for (j = 0; j < removed.length; j++) {
          rr = removed[j];
          if (used[rr]) continue;
          if ((cur[rr] > 0 ? 1 : -1) === s) { hit = rr; break; }
        }
        if (hit >= 0) {
          used[hit] = true;
          rec = map[hit]; delete map[hit];
        }
        if (rec) {
          setPos(rec.node, a, flip);
          if (nb[a] !== cur[hit]) rec.node.classList.toggle('chk-king', isKing(nb[a]));
          map[a] = rec;
        } else {
          var node = makePiece(nb[a], a, flip);
          layer.appendChild(node);
          map[a] = { node: node };
        }
      });
      removed.forEach(function (rr) {
        if (used[rr]) return;
        var rec = map[rr]; delete map[rr];
        if (!rec) return;
        rec.node.classList.add('chk-gone');
        later(340, function () { if (rec.node.parentNode) rec.node.parentNode.removeChild(rec.node); });
      });
      cur = nb.slice();
    }

    /* Zeigt ein Brett an, ohne eine laufende Animation zu zerreißen. */
    function show(nb) { if (animating) pendingB = nb.slice(); else sync(nb, false); }

    /* Spielt einen fremden Zug Teilsprung für Teilsprung nach. */
    function playMove(prev, mv, finalB, onEnd) {
      var path = toArr(mv.path), caps = toArr(mv.caps), steps = [], j;
      if (path.length < 2) { sync(finalB, false); if (onEnd) onEnd(); return; }
      for (j = 1; j < path.length; j++) steps.push(stepBoard(prev, path, caps, j));
      steps[steps.length - 1] = finalB;
      animating = true;
      var i = 0;
      function next() {
        sync(steps[i], false); i++;
        if (i < steps.length) later(HOP_MS, next);
        else later(HOP_MS + 40, function () {
          animating = false;
          if (pendingB) { var p = pendingB; pendingB = null; sync(p, false); }
          if (onEnd) onEnd();
        });
      }
      next();
    }

    function marks(o) {
      o = o || {};
      var tgt = o.targets || [], caps = o.caps || [], must = o.must || [], last = o.last || [], i, sq;
      for (i = 0; i < 64; i++) {
        sq = squares[i]; if (!sq) continue;
        sq.classList.toggle('chk-sel', o.sel === i);
        sq.classList.toggle('chk-target', tgt.indexOf(i) >= 0);
        sq.classList.toggle('chk-jump', !!o.jump && tgt.indexOf(i) >= 0);
        sq.classList.toggle('chk-capt', caps.indexOf(i) >= 0);
        sq.classList.toggle('chk-must', must.indexOf(i) >= 0);
        sq.classList.toggle('chk-last', last.indexOf(i) >= 0);
      }
      boardEl.classList.toggle('chk-mymove', !!o.myTurn);
    }

    return {
      root: boardEl, sync: sync, show: show, playMove: playMove, marks: marks,
      isBusy: function () { return animating; },
      destroy: function () { clearTimers(); animating = false; pendingB = null; }
    };
  }

  /* Markierungen aus Auswahl bzw. Schlagzwang ableiten. */
  function markData(board, side, sel, last) {
    var targets = [], caps = [], must = [], jump = false;
    if (sel) {
      var n = sel.path.length;
      jump = sel.cands[0].caps.length > 0;
      sel.cands.forEach(function (m) {
        var t = m.path[n];
        if (t != null && targets.indexOf(t) < 0) targets.push(t);
        var ci = m.caps[n - 1];
        if (ci != null && caps.indexOf(ci) < 0) caps.push(ci);
      });
    } else if (side) {
      var mv = genMoves(board, side);
      if (mv.length && mv[0].caps.length) mv.forEach(function (m) { if (must.indexOf(m.path[0]) < 0) must.push(m.path[0]); });
    }
    return {
      sel: sel ? sel.path[sel.path.length - 1] : -1,
      targets: targets, caps: caps, must: must, jump: jump, last: last || []
    };
  }

  /* Auswahl + Mehrfachsprung-Klicklogik (für Solo und Multi identisch). */
  function makeSelector(getBoard, getSide, bv, commit, repaint) {
    var sel = null;
    function step(picks, to, board) {
      var n = sel.path.length;
      var ci = (picks[0].caps.length >= n) ? picks[0].caps[n - 1] : null;
      sel.path.push(to);
      if (ci != null) sel.caps.push(ci);
      sel.cands = picks;
      var done = true;
      picks.forEach(function (m) { if (m.path.length > sel.path.length) done = false; });
      if (done) {
        var mv = { path: sel.path.slice(), caps: sel.caps.slice() };
        sel = null; commit(mv); return;
      }
      bv.show(stepBoard(board, sel.path, sel.caps, sel.path.length - 1));
      beep('hit'); repaint();
    }
    function click(i) {
      var board = getBoard(), side = getSide();
      if (!board || !side) return;
      if (sel && sel.path.length > 1) {
        var p = sel.cands.filter(function (m) { return m.path[sel.path.length] === i; });
        if (p.length) { step(p, i, board); return; }
        beep('error'); UI.toast('Mehrfachsprung — du musst weiterspringen!', 'info'); return;
      }
      if (sel) {
        var p2 = sel.cands.filter(function (m) { return m.path[1] === i; });
        if (p2.length) { step(p2, i, board); return; }
        if (i === sel.from) { sel = null; beep('click'); repaint(); return; }
      }
      var v = board[i];
      if (v === 0 || sideOf(v) !== side) { if (sel) { sel = null; repaint(); } return; }
      var moves = genMoves(board, side);
      var cands = moves.filter(function (m) { return m.path[0] === i; });
      if (!cands.length) {
        beep('error');
        UI.toast(moves.length && moves[0].caps.length ? '🔒 Schlagzwang — dieser Stein darf nicht ziehen' : 'Dieser Stein kann nicht ziehen', 'info');
        return;
      }
      sel = { from: i, path: [i], caps: [], cands: cands };
      beep('select'); repaint();
    }
    return { click: click, sel: function () { return sel; }, reset: function () { sel = null; } };
  }

  /* ===================== Layout ===================== */
  function buildLayout(o) {
    var badgeEl = el('div', { class: 'chk-badge' }, [o.badge || '']);
    var redNm = el('div', { class: 'chk-nm' }, [o.redName || '—']);
    var redSc = el('div', { class: 'chk-sc' }, ['0']);
    var redChip = el('div', { class: 'chk-chip' }, [
      el('span', { class: 'chk-sym' }, ['🔴']),
      el('div', { class: 'chk-info' }, [redNm, el('div', { class: 'chk-mini' }, ['Rot'])]),
      redSc
    ]);
    var grnNm = el('div', { class: 'chk-nm' }, [o.grnName || '—']);
    var grnSc = el('div', { class: 'chk-sc' }, ['0']);
    var grnChip = el('div', { class: 'chk-chip' }, [
      el('span', { class: 'chk-sym' }, ['🟢']),
      el('div', { class: 'chk-info' }, [grnNm, el('div', { class: 'chk-mini' }, ['Grün'])]),
      grnSc
    ]);
    var statusEl = el('div', { class: 'chk-status chk-you' }, ['']);
    var surBtn = el('button', { class: 'btn btn-ghost chk-sur', type: 'button' }, ['🏳️ Aufgeben']);
    var root = el('div', { class: 'chk-wrap' }, [
      el('div', { class: 'chk-top' }, [el('div', { class: 'chk-brand neon' }, ['🔴 Dame']), badgeEl]),
      el('div', { class: 'chk-chips' }, [redChip, grnChip]),
      statusEl,
      el('div', { class: 'chk-board-holder' }, [o.boardEl]),
      el('p', { class: 'chk-rules hint-text' }, ['Stein antippen → Ziele leuchten · 🔒 Schlagen ist Pflicht · Mehrfachsprung weiterklicken · letzte Reihe = 👑 Dame (zieht beliebig weit)']),
      el('div', { class: 'controls-row chk-bottom' }, [surBtn])
    ]);
    return {
      root: root, badgeEl: badgeEl, statusEl: statusEl, surBtn: surBtn,
      redChip: redChip, redNm: redNm, redSc: redSc,
      grnChip: grnChip, grnNm: grnNm, grnSc: grnSc
    };
  }
  function setStatus(node, s) { node.textContent = s.text; node.className = 'chk-status ' + s.cls; }
  function playerById(players, id) { var i; for (i = 0; i < players.length; i++) if (players[i].id === id) return players[i]; return null; }

  function soloScore(res, myLeft, oppCap, lv, secs) {
    var pts = oppCap * 50;
    if (res === 'win') pts += 600 + myLeft * 40 + (LEVELS[lv] ? LEVELS[lv].bonus : 0) + Math.max(0, 300 - Math.floor(secs));
    else if (res === 'draw') pts += 200;
    return Math.round(pts);
  }

  /* ===================== Registrierung ===================== */
  App.Minigames.checkers = {
    id: 'checkers', title: 'Dame', icon: '🔴', order: 104,
    subtitle: 'Springen, schlagen, krönen – Brett-Klassiker',
    single: true, multi: true, minPlayers: 2, maxPlayers: 2,

    render: function (root, ctx) {
      var dead = false, timers = [], stops = [];

      function after(ms, fn) { var t = setTimeout(function () { if (!dead) fn(); }, ms); timers.push(t); return t; }
      function clearTimers() { timers.forEach(clearTimeout); timers = []; }
      function stopAll() { stops.forEach(function (f) { try { f(); } catch (e) {} }); stops = []; }
      function cleanup() { dead = true; clearTimers(); stopAll(); }

      /* Aufgeben mit Sicherheitsabfrage (zweiter Klick innerhalb von 3 s). */
      function armSurrender(btn, doIt, alive) {
        var armed = false;
        function reset() { armed = false; btn.textContent = '🏳️ Aufgeben'; btn.className = 'btn btn-ghost chk-sur'; }
        btn.addEventListener('click', function () {
          if (dead || !alive()) return;
          if (armed) { reset(); doIt(); return; }
          armed = true;
          btn.textContent = 'Wirklich aufgeben?';
          btn.className = 'btn btn-danger chk-sur';
          beep('click');
          after(3000, function () { if (armed) reset(); });
        });
      }

      if (ctx.mode === 'multi' && ctx.room) renderMulti(); else renderSolo();
      return { cleanup: cleanup };

      /* =========================================================
       *  SOLO — gegen den Bot
       * ========================================================= */
      function renderSolo() {
        var level = App.Storage.get('checkers_level', 'mittel');
        if (!LEVELS[level]) level = 'mittel';
        showLevels();

        function showLevels() {
          clearTimers(); stopAll();
          var best = App.Storage.get('best_checkers', 0);
          var btns = LEVEL_ORDER.map(function (k) {
            var L = LEVELS[k];
            return el('button', {
              class: 'chk-level' + (k === level ? ' chk-on' : ''), type: 'button',
              onclick: function () { level = k; App.Storage.set('checkers_level', k); beep('start'); startGame(k); }
            }, [
              el('span', { class: 'chk-lv-icon' }, [L.icon]),
              el('span', { class: 'chk-lv-txt' }, [
                el('span', { class: 'chk-lv-name' }, [L.name]),
                el('span', { class: 'chk-lv-sub' }, [L.sub])
              ])
            ]);
          });
          root.innerHTML = '';
          root.appendChild(el('div', { class: 'chk-panel glass' }, [
            el('div', { class: 'chk-wait-icon' }, ['🔴']),
            el('h2', { class: 'chk-big neon' }, ['Dame']),
            el('p', { class: 'chk-endsub' }, ['Schlag alle Steine des Bots – oder nimm ihm jeden Zug. Wähle deine Stufe:']),
            el('div', { class: 'chk-levels' }, btns),
            el('p', { class: 'hint-text' }, ['🏅 Bestwert: ' + App.MG.fmt(best)]),
            el('div', { class: 'chk-actions' }, [
              el('button', { class: 'btn btn-ghost', type: 'button', onclick: ctx.onExit }, ['Zurück'])
            ])
          ]));
        }

        function startGame(lv) {
          clearTimers(); stopAll();
          var st = { board: startBoard(), turn: RED, over: false, idle: 0, startAt: Date.now(), last: [] };
          var bv = makeBoardView(false, function (i) { ctl.click(i); });
          stops.push(bv.destroy);
          var ctl = makeSelector(function () { return st.board; }, function () {
            return (!st.over && st.turn === RED && !bv.isBusy()) ? RED : 0;
          }, bv, commit, paint);
          var refs = buildLayout({
            boardEl: bv.root, redName: 'Du', grnName: 'Bot',
            badge: LEVELS[lv].icon + ' ' + LEVELS[lv].name
          });
          refs.redChip.classList.add('chk-me');
          armSurrender(refs.surBtn, function () { finish('lose'); }, function () { return !st.over; });
          root.innerHTML = ''; root.appendChild(refs.root);
          bv.sync(st.board, true);
          paint();

          function paint() {
            var side = (!st.over && st.turn === RED) ? RED : 0;
            bv.marks(Object.assign(markData(st.board, side, ctl.sel(), st.last), { myTurn: side === RED && !bv.isBusy() }));
            refs.redSc.textContent = String(12 - countSide(st.board, GRN));
            refs.grnSc.textContent = String(12 - countSide(st.board, RED));
            refs.redChip.classList.toggle('chk-active', !st.over && st.turn === RED);
            refs.grnChip.classList.toggle('chk-active', !st.over && st.turn === GRN);
            setStatus(refs.statusEl, statusSolo());
          }
          function statusSolo() {
            if (st.over) return { text: 'Partie vorbei', cls: 'chk-draw' };
            if (st.turn === GRN || bv.isBusy()) return { text: 'Bot denkt …', cls: 'chk-opp' };
            var sel = ctl.sel();
            if (sel && sel.path.length > 1) return { text: 'Weiterspringen! 🔥', cls: 'chk-you' };
            var mv = genMoves(st.board, RED);
            if (mv.length && mv[0].caps.length) return { text: 'Du bist dran · Schlagzwang!', cls: 'chk-you' };
            return { text: 'Du bist dran', cls: 'chk-you' };
          }

          function commit(mv) {
            var prev = st.board, nb = applyMove(prev, mv);
            var to = mv.path[mv.path.length - 1];
            var promoted = nb[to] !== prev[mv.path[0]];
            st.idle = (mv.caps.length || !isKing(prev[mv.path[0]])) ? 0 : st.idle + 1;
            st.board = nb; st.last = [mv.path[0], to]; st.turn = GRN;
            bv.show(nb);
            beep(mv.caps.length ? 'hit' : 'step');
            if (promoted) after(200, function () { beep('levelup'); });
            paint();
            after(HOP_MS + 80, nextTurn);
          }
          function nextTurn() {
            if (dead || st.over) return;
            var res = outcome(st.board, st.turn, st.idle);
            if (res) { finish(res); return; }
            botTurn();
          }
          function outcome(b, turn, idle) {
            if (idle >= IDLE_DRAW) return 'draw';
            if (!genMoves(b, turn).length) return turn === RED ? 'lose' : 'win';
            return null;
          }
          function botTurn() {
            paint();
            after(340 + Math.random() * 260, function () {
              if (dead || st.over) return;
              var mv = botMove(st.board, GRN, lv);
              if (!mv) { finish('win'); return; }
              var prev = st.board, nb = applyMove(prev, mv);
              var to = mv.path[mv.path.length - 1];
              var promoted = nb[to] !== prev[mv.path[0]];
              st.idle = (mv.caps.length || !isKing(prev[mv.path[0]])) ? 0 : st.idle + 1;
              st.board = nb; st.last = [mv.path[0], to]; st.turn = RED;
              beep(mv.caps.length ? 'hit' : 'step');
              bv.playMove(prev, mv, nb, function () {
                if (dead || st.over) return;
                if (promoted) beep('levelup');
                paint();
                var res = outcome(st.board, RED, st.idle);
                if (res) after(420, function () { finish(res); });
              });
              paint();
            });
          }

          function finish(res) {
            if (st.over || dead) return;
            st.over = true;
            ctl.reset();
            paint();
            beep(res === 'win' ? 'win' : res === 'draw' ? 'info' : 'lose');
            var secs = (Date.now() - st.startAt) / 1000;
            var myLeft = countSide(st.board, RED), oppCap = 12 - countSide(st.board, GRN);
            var score = soloScore(res, myLeft, oppCap, lv, secs);
            after(1100, function () {
              var best = App.Storage.get('best_checkers', 0);
              var nb2 = score > best;
              if (nb2) App.Storage.set('best_checkers', score);
              var head = res === 'win' ? ('Sieg auf ' + LEVELS[lv].name + ' · ' + myLeft + ' Steine übrig')
                : res === 'draw' ? ('Remis · ' + oppCap + ' Steine geschlagen')
                  : ('Verloren · ' + oppCap + ' Steine geschlagen');
              App.MG.endScreen(root, {
                title: res === 'win' ? '🏆 Gewonnen!' : res === 'draw' ? '🤝 Remis' : '💀 Verloren',
                score: score, best: best, newBest: nb2,
                label: head + (nb2 ? ' · neuer Rekord! 🎉' : ' · Bestwert: ' + App.MG.fmt(best)),
                onExit: ctx.onExit,
                onAgain: function () { showLevels(); }
              });
            });
          }
        }
      }

      /* =========================================================
       *  MULTI — Zustand in room.shared, Zug rechnet der Ziehende
       * ========================================================= */
      function renderMulti() {
        var room = ctx.room, me = ctx.me;
        var snap = room.snapshot() || {};
        var lastShared = snap.shared || null;
        var started = false, initDone = false, endPlanned = false;
        var curView = null, curFlip = null, curGame = -1;
        var refs = null, bv = null, ctl = null, waitRefs = null;
        var seenMove = -1, prevBoard = null, reported = -1;

        function onShared(sh) { if (dead) return; lastShared = sh; sync(); }
        function onPlayers() { if (dead) return; sync(); }
        room.on('shared', onShared);
        room.on('players', onPlayers);
        stops.push(function () { room.off('shared', onShared); room.off('players', onPlayers); });
        stops.push(function () { if (bv) bv.destroy(); });

        var startAt = (snap.round && snap.round.startAt) || (room.now() + 3000);
        stops.push(App.MG.countdown(root, startAt, function () { started = true; sync(); }, room.now));
        sync();

        /* ---- Helfer ---- */
        function hasBoard(sh) { return !!(sh && sh.board && typeof sh.board === 'object'); }
        function sideForId(id, sh) {
          var o = toArr(sh.order);
          if (o[0] === id) return RED;
          if (o[1] === id) return GRN;
          return 0;
        }
        function otherId(id, sh) { var o = toArr(sh.order); return o[0] === id ? o[1] : o[0]; }

        function sync() {
          var players = room.players(), sh = lastShared;
          if (room.isHost() && players.length >= 2 && !hasBoard(sh) && !initDone) { initShared(players); return; }
          if (!started) return;
          if (!hasBoard(sh)) { showWaiting(players, players.length >= 2); return; }
          if (players.length < 2 && !sh.over) { showWaiting(players, false); return; }
          if (curView === 'end' && sh.over) return;
          ensureGame(sh);
          applyShared(sh, players);
          if (sh.over) scheduleEnd(sh);
        }

        function initShared(players) {
          initDone = true;
          room.setShared({
            order: [players[0].id, players[1].id], board: startBoard(),
            turn: players[0].id, moveNo: 0, idle: 0, lastMove: null,
            over: false, result: null, game: 1
          });
        }

        function ensureGame(sh) {
          var flip = sideForId(me.id, sh) === GRN;
          var g = sh.game || 1;
          if (curView === 'game' && curFlip === flip && curGame === g) return;
          curView = 'game'; curFlip = flip; curGame = g;
          endPlanned = false; seenMove = -1; prevBoard = null; reported = -1;
          if (bv) bv.destroy();
          bv = makeBoardView(flip, function (i) { ctl.click(i); });
          ctl = makeSelector(function () { return lastShared ? toBoard(lastShared.board) : null; }, function () {
            var s = lastShared;
            if (!s || s.over || s.turn !== me.id || bv.isBusy()) return 0;
            return sideForId(me.id, s);
          }, bv, commitM, function () { paintM(lastShared, room.players()); });
          refs = buildLayout({ boardEl: bv.root, badge: 'Partie ' + g });
          armSurrender(refs.surBtn, surrenderM, function () { return !!(lastShared && !lastShared.over); });
          root.innerHTML = ''; root.appendChild(refs.root);
        }

        function applyShared(sh, players) {
          var board = toBoard(sh.board), mn = sh.moveNo || 0;
          if (mn !== seenMove) {
            var mv = sh.lastMove ? { path: toArr(sh.lastMove.path), caps: toArr(sh.lastMove.caps) } : null;
            if (mv && mv.path.length >= 2 && prevBoard) {
              beep(mv.caps.length ? 'hit' : 'step');
              bv.playMove(prevBoard, mv, board, function () { if (!dead) paintM(lastShared, room.players()); });
            } else {
              bv.sync(board, true);
            }
            seenMove = mn; ctl.reset();
          } else {
            bv.show(board);
          }
          prevBoard = board;
          reportMine(sh, board);
          paintM(sh, players);
        }

        function reportMine(sh, board) {
          var mySide = sideForId(me.id, sh);
          if (!mySide) return;
          var s = 12 - countSide(board, -mySide);
          if (sh.over && sh.result === me.id) s += 100;
          if (s !== reported) { reported = s; room.reportScore(s); }
        }

        function paintM(sh, players) {
          if (!sh || !refs || !hasBoard(sh) || curView !== 'game') return;
          players = players || room.players();
          var board = toBoard(sh.board), mySide = sideForId(me.id, sh);
          var myTurn = !sh.over && sh.turn === me.id && !bv.isBusy();
          /* Von-/Nach-Feld des letzten Zuges markieren — sonst sieht man nicht,
             was der Gegner gerade gespielt hat. */
          var last = [];
          if (sh.lastMove) {
            var lp = toArr(sh.lastMove.path);
            if (lp.length >= 2) last = [lp[0], lp[lp.length - 1]];
          }
          bv.marks(Object.assign(markData(board, myTurn ? mySide : 0, ctl.sel(), last), { myTurn: myTurn }));
          var redP = playerById(players, toArr(sh.order)[0]), grnP = playerById(players, toArr(sh.order)[1]);
          refs.redNm.textContent = (redP ? redP.name : 'Spieler 1') + (mySide === RED ? ' (du)' : '');
          refs.grnNm.textContent = (grnP ? grnP.name : 'Spieler 2') + (mySide === GRN ? ' (du)' : '');
          refs.redSc.textContent = String(12 - countSide(board, GRN));
          refs.grnSc.textContent = String(12 - countSide(board, RED));
          refs.redChip.classList.toggle('chk-me', mySide === RED);
          refs.grnChip.classList.toggle('chk-me', mySide === GRN);
          refs.redChip.classList.toggle('chk-active', !sh.over && sh.turn === toArr(sh.order)[0]);
          refs.grnChip.classList.toggle('chk-active', !sh.over && sh.turn === toArr(sh.order)[1]);
          refs.badgeEl.textContent = 'Partie ' + (sh.game || 1);
          setStatus(refs.statusEl, statusM(sh, players, mySide));
        }
        function statusM(sh, players, mySide) {
          if (sh.over) {
            if (sh.result === 'draw') return { text: '🤝 Remis', cls: 'chk-draw' };
            return sh.result === me.id ? { text: '🏆 Gewonnen!', cls: 'chk-win' } : { text: '💀 Verloren', cls: 'chk-lose' };
          }
          if (!mySide) return { text: 'Du schaust zu', cls: 'chk-opp' };
          if (bv.isBusy()) return { text: 'Zug läuft …', cls: 'chk-opp' };
          if (sh.turn === me.id) {
            var sel = ctl.sel();
            if (sel && sel.path.length > 1) return { text: 'Weiterspringen! 🔥', cls: 'chk-you' };
            var mv = genMoves(toBoard(sh.board), mySide);
            if (mv.length && mv[0].caps.length) return { text: 'Du bist dran · Schlagzwang!', cls: 'chk-you' };
            return { text: 'Du bist dran', cls: 'chk-you' };
          }
          var t = playerById(players, sh.turn);
          return { text: (t ? t.name : 'Gegner') + ' ist dran …', cls: 'chk-opp' };
        }

        function commitM(mv) {
          var sh = lastShared;
          if (!sh || sh.over || sh.turn !== me.id) return;
          var mySide = sideForId(me.id, sh);
          if (!mySide) return;
          var prev = toBoard(sh.board), nb = applyMove(prev, mv);
          var from = mv.path[0], to = mv.path[mv.path.length - 1];
          var promoted = nb[to] !== prev[from];
          var idle = (mv.caps.length || !isKing(prev[from])) ? 0 : (sh.idle || 0) + 1;
          var mn = (sh.moveNo || 0) + 1;
          var patch = {
            board: nb, turn: otherId(me.id, sh), moveNo: mn, idle: idle,
            lastMove: { path: mv.path, caps: mv.caps.length ? mv.caps : null }
          };
          if (idle >= IDLE_DRAW) { patch.over = true; patch.result = 'draw'; }
          else if (!genMoves(nb, -mySide).length) { patch.over = true; patch.result = me.id; }
          seenMove = mn; prevBoard = nb;
          bv.show(nb);
          beep(mv.caps.length ? 'hit' : 'step');
          if (promoted) after(200, function () { beep('levelup'); });
          lastShared = Object.assign({}, sh, patch);
          room.setShared(patch);
          sync();
        }

        function surrenderM() {
          var sh = lastShared;
          if (!sh || sh.over || !hasBoard(sh) || !sideForId(me.id, sh)) return;
          var patch = { over: true, result: otherId(me.id, sh) };
          lastShared = Object.assign({}, sh, patch);
          room.setShared(patch);
          UI.toast('Du hast aufgegeben', 'info');
          sync();
        }

        function scheduleEnd(sh) {
          if (endPlanned) return;
          endPlanned = true;
          var win = sh.result === me.id, draw = sh.result === 'draw';
          after(bv.isBusy() ? 1600 : 900, function () {
            beep(win ? 'win' : draw ? 'info' : 'lose');
            showEnd(lastShared || sh);
          });
        }

        function showEnd(sh) {
          curView = 'end';
          if (bv) bv.destroy();
          var board = toBoard(sh.board), draw = sh.result === 'draw';
          /* Punkte lokal aus dem Endbrett ableiten → beide Geräte zeigen dasselbe
             Podest, auch wenn ein reportScore noch unterwegs ist. */
          var ps = room.players().map(function (p) {
            var sd = sideForId(p.id, sh);
            var sc = sd ? (12 - countSide(board, -sd)) : 0;
            if (sh.result === p.id) sc += 100;
            return { id: p.id, name: p.name, score: sc };
          });
          App.MG.endScreen(root, {
            title: draw ? '🤝 Remis — keiner gibt nach' : '🏁 Partie vorbei',
            players: ps, meId: me.id,
            format: function (v) { v = v || 0; return (v >= 100 ? '🏆 ' : '') + (v % 100) + ' Steine'; },
            onExit: ctx.onExit,
            onAgain: room.isHost() ? doRevanche : null
          });
          if (!room.isHost()) root.appendChild(el('p', { class: 'chk-hint' }, ['Der Host kann eine Revanche starten.']));
        }

        function doRevanche() {
          var sh = lastShared;
          if (!sh || !toArr(sh.order).length) return;
          if (room.players().length < 2) { UI.toast('Warte auf den Gegner …', 'info'); return; }
          var o = toArr(sh.order), order = [o[1], o[0]];      // Farben tauschen
          var patch = {
            order: order, board: startBoard(), turn: order[0], moveNo: 0, idle: 0,
            lastMove: null, over: false, result: null, game: (sh.game || 1) + 1
          };
          lastShared = Object.assign({}, sh, patch);
          beep('start');
          room.setShared(patch);
          sync();
        }

        function showWaiting(players, starting) {
          if (curView !== 'waiting') {
            curView = 'waiting'; curGame = -1;
            if (bv) { bv.destroy(); bv = null; }
            var count = el('div', { class: 'chk-big neon' }, ['1 / 2']);
            var msg = el('p', { class: 'chk-endsub' }, ['']);
            waitRefs = { count: count, msg: msg };
            root.innerHTML = '';
            root.appendChild(el('div', { class: 'chk-panel glass' }, [
              el('div', { class: 'chk-wait-icon' }, ['🔴']),
              el('h2', { class: 'neon' }, ['Dame']),
              count, msg,
              el('div', { class: 'chk-actions' }, [
                el('button', { class: 'btn btn-ghost', type: 'button', onclick: ctx.onExit }, ['Zurück zur Lobby'])
              ])
            ]));
          }
          waitRefs.count.textContent = players.length + ' / 2';
          waitRefs.msg.textContent = starting ? 'Brett wird aufgebaut …' : 'Warte auf den zweiten Spieler …';
        }
      }
    }
  };

  /* ===================== CSS ===================== */
  function injectStyle() {
    UI.injectStyle('mg-checkers-css', [
      '.chk-wrap{display:flex;flex-direction:column;gap:12px;max-width:460px;margin:0 auto;}',
      '.chk-top{display:flex;justify-content:space-between;align-items:center;gap:10px;}',
      '.chk-brand{font-weight:900;font-size:18px;}',
      '.chk-badge{font-size:11px;font-weight:800;color:var(--muted);text-transform:uppercase;letter-spacing:1px;padding:4px 10px;border-radius:999px;border:1px solid var(--stroke);background:rgba(9,32,21,.55);white-space:nowrap;}',
      /* Spieler-Chips */
      '.chk-chips{display:flex;gap:10px;}',
      '.chk-chip{flex:1;min-width:0;display:flex;align-items:center;gap:9px;padding:8px 11px;border-radius:14px;background:rgba(9,32,21,.6);border:1px solid var(--stroke);transition:border-color .18s,box-shadow .18s;}',
      '.chk-chip .chk-sym{font-size:22px;line-height:1;filter:drop-shadow(0 0 6px rgba(0,0,0,.5));}',
      '.chk-info{flex:1;min-width:0;display:flex;flex-direction:column;line-height:1.15;}',
      '.chk-nm{font-weight:800;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      '.chk-mini{font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;}',
      '.chk-sc{font-size:22px;font-weight:900;color:var(--leaf);font-variant-numeric:tabular-nums;}',
      '.chk-chip.chk-me .chk-nm{color:var(--aqua);}',
      '.chk-chip.chk-active{border-color:var(--neon);box-shadow:0 0 0 1px var(--neon),0 0 18px rgba(57,255,20,.3);}',
      '.chk-chip.chk-active .chk-sym{animation:chk-bob .9s ease-in-out infinite;}',
      '@keyframes chk-bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-3px)}}',
      /* Status */
      '.chk-status{text-align:center;font-weight:900;font-size:clamp(15px,4.2vw,19px);min-height:24px;transition:color .15s;}',
      '.chk-status.chk-you{color:var(--neon);text-shadow:0 0 10px rgba(57,255,20,.4);}',
      '.chk-status.chk-opp{color:var(--aqua);}',
      '.chk-status.chk-win{color:var(--gold);text-shadow:0 0 12px rgba(255,210,63,.5);}',
      '.chk-status.chk-lose{color:var(--danger);}',
      '.chk-status.chk-draw{color:var(--aqua-soft);}',
      /* Brett */
      '.chk-board-holder{width:100%;}',
      '.chk-board{position:relative;width:100%;aspect-ratio:1/1;border-radius:14px;overflow:hidden;border:2px solid var(--stroke-2,var(--stroke));box-shadow:0 8px 30px rgba(0,0,0,.45),0 0 26px rgba(57,255,20,.1);touch-action:manipulation;user-select:none;-webkit-user-select:none;-webkit-tap-highlight-color:transparent;}',
      '.chk-grid{position:absolute;inset:0;display:grid;grid-template-columns:repeat(8,1fr);grid-template-rows:repeat(8,1fr);}',
      '.chk-sq{position:relative;}',
      '.chk-light{background:linear-gradient(155deg,#1d5539,#143a28);}',
      '.chk-dark{background:linear-gradient(155deg,#091c11,#04100a);}',
      '.chk-board.chk-mymove .chk-dark{cursor:pointer;}',
      /* Feld-Markierungen */
      '.chk-sq.chk-last::before{content:"";position:absolute;inset:0;box-shadow:inset 0 0 0 2px rgba(51,230,208,.45);pointer-events:none;}',
      '.chk-sq.chk-capt::before{content:"";position:absolute;inset:0;background:rgba(255,77,109,.2);box-shadow:inset 0 0 0 3px var(--danger);pointer-events:none;animation:chk-doom .85s ease-in-out infinite;}',
      '@keyframes chk-doom{0%,100%{opacity:.5}50%{opacity:1}}',
      '.chk-sq.chk-sel{box-shadow:inset 0 0 0 3px var(--aqua),inset 0 0 22px rgba(51,230,208,.38);}',
      '.chk-sq.chk-must{box-shadow:inset 0 0 0 2px rgba(255,210,63,.7);}',
      '.chk-sq.chk-target::after{content:"";position:absolute;left:50%;top:50%;width:30%;height:30%;transform:translate(-50%,-50%);border-radius:50%;background:var(--neon);box-shadow:0 0 14px var(--neon);pointer-events:none;animation:chk-dot 1.1s ease-in-out infinite;}',
      '.chk-sq.chk-target.chk-jump::after{width:76%;height:76%;background:transparent;border:3px solid var(--gold);box-shadow:0 0 16px rgba(255,210,63,.7),inset 0 0 14px rgba(255,210,63,.3);}',
      '@keyframes chk-dot{0%,100%{opacity:.55;transform:translate(-50%,-50%) scale(.85)}50%{opacity:1;transform:translate(-50%,-50%) scale(1.12)}}',
      /* Steine */
      '.chk-pieces{position:absolute;inset:0;pointer-events:none;}',
      '.chk-pc{position:absolute;left:0;top:0;width:12.5%;height:12.5%;display:flex;align-items:center;justify-content:center;transition:transform .25s cubic-bezier(.34,1.12,.4,1);will-change:transform;}',
      '.chk-disc{width:76%;height:76%;border-radius:50%;display:flex;align-items:center;justify-content:center;animation:chk-pop .28s cubic-bezier(.2,1.5,.4,1) both;}',
      '.chk-red .chk-disc{background:radial-gradient(circle at 34% 30%,#ff9aad,#e8264c 58%,#8d0c26);box-shadow:0 3px 8px rgba(0,0,0,.55),0 0 14px rgba(255,77,109,.45),inset 0 -3px 6px rgba(0,0,0,.35),inset 0 2px 5px rgba(255,255,255,.3);}',
      '.chk-green .chk-disc{background:radial-gradient(circle at 34% 30%,#ccffb8,#39ff14 58%,#0f7a12);box-shadow:0 3px 8px rgba(0,0,0,.55),0 0 14px rgba(57,255,20,.45),inset 0 -3px 6px rgba(0,0,0,.35),inset 0 2px 5px rgba(255,255,255,.35);}',
      '.chk-king .chk-disc{box-shadow:0 3px 8px rgba(0,0,0,.55),0 0 0 2px var(--gold),0 0 18px rgba(255,210,63,.65),inset 0 -3px 6px rgba(0,0,0,.3);}',
      '.chk-crown{font-size:clamp(11px,2.7vw,17px);line-height:1;opacity:0;transform:scale(.2);transition:opacity .25s,transform .32s cubic-bezier(.2,1.6,.4,1);filter:drop-shadow(0 1px 2px rgba(0,0,0,.6));}',
      '.chk-king .chk-crown{opacity:1;transform:scale(1);}',
      '.chk-gone .chk-disc{animation:chk-cap .32s ease-in forwards;}',
      '@keyframes chk-pop{0%{transform:scale(0);opacity:0}70%{transform:scale(1.1)}100%{transform:scale(1);opacity:1}}',
      '@keyframes chk-cap{0%{transform:scale(1);opacity:1}45%{transform:scale(1.35);opacity:.85;filter:brightness(1.8)}100%{transform:scale(0);opacity:0}}',
      /* Fußzeile */
      '.chk-rules{margin:0;text-align:center;font-size:11.5px;line-height:1.5;}',
      '.chk-bottom{justify-content:center;margin-top:-2px;}',
      '.chk-sur{font-size:12px;padding:6px 14px;}',
      '.chk-hint{color:var(--muted);font-size:12px;margin:8px 0 0;text-align:center;}',
      /* Panels (Stufenwahl / Warten) */
      '.chk-panel{padding:28px 22px;text-align:center;display:flex;flex-direction:column;gap:14px;align-items:center;max-width:460px;margin:0 auto;}',
      '.chk-big{font-size:clamp(26px,8vw,40px);font-weight:900;line-height:1.1;margin:0;}',
      '.chk-endsub{color:var(--muted);margin:0;}',
      '.chk-wait-icon{font-size:48px;line-height:1;filter:drop-shadow(0 0 12px rgba(255,77,109,.5));animation:chk-hop 1.8s ease-in-out infinite;}',
      '@keyframes chk-hop{0%,100%{transform:translateY(0) scale(1)}50%{transform:translateY(-8px) scale(1.06)}}',
      '.chk-actions{display:flex;gap:10px;justify-content:center;flex-wrap:wrap;}',
      '.chk-levels{display:flex;flex-direction:column;gap:9px;width:100%;}',
      '.chk-level{display:flex;align-items:center;gap:12px;width:100%;padding:11px 14px;border-radius:14px;background:rgba(6,24,16,.7);border:1px solid var(--stroke);color:var(--text);cursor:pointer;text-align:left;font-family:inherit;transition:transform .12s,border-color .18s,box-shadow .18s;}',
      '.chk-level:hover{border-color:var(--neon);box-shadow:0 0 18px rgba(57,255,20,.25);transform:translateY(-2px);}',
      '.chk-level:active{transform:scale(.98);}',
      '.chk-level.chk-on{border-color:var(--aqua);box-shadow:0 0 0 1px var(--aqua),0 0 16px rgba(51,230,208,.28);}',
      '.chk-lv-icon{font-size:26px;line-height:1;}',
      '.chk-lv-txt{display:flex;flex-direction:column;gap:1px;min-width:0;}',
      '.chk-lv-name{font-weight:900;font-size:15px;}',
      '.chk-lv-sub{font-size:11px;color:var(--muted);}'
    ].join(''));
  }
})();
