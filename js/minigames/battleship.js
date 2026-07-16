/* battleship.js — "Schiffe versenken": klassisches 8×8-Duell im Neon-Dschungel.
 *
 * SPIELIDEE
 *   Jeder Spieler hat ein 8×8-Raster und eine Flotte aus 5 Schiffen
 *   (5er Flugzeugträger, 4er Schlachtschiff, 3er Kreuzer, 3er U-Boot,
 *   2er Zerstörer = 17 Felder).  Erst wird aufgebaut, dann wird abwechselnd
 *   auf das gegnerische Raster geschossen.  Treffer 💥 = nochmal dran,
 *   Wasser 💦 = der Gegner ist dran.  Ein versenktes Schiff wird komplett
 *   markiert (☠️) und angesagt.  Wer zuerst alle 5 Schiffe versenkt, gewinnt.
 *
 * STEUERUNG
 *   Aufbau : Klick/Tipp setzt das aktuelle Schiff (angeklicktes Feld = Bug),
 *            "↻" dreht quer/hoch (auch Taste R), "🎲" würfelt eine komplette
 *            Aufstellung, "↶" nimmt das letzte Schiff zurück, "⚓ Bereit".
 *   Spiel  : Klick/Tipp ins große Gegner-Raster = Schuss.  Das eigene Raster
 *            steht kleiner darunter.  Alles läuft über pointerdown → Maus
 *            und Touch identisch.
 *
 * PUNKTE
 *   Solo : Treffer × 20 + (Sieg: Zeitbonus für wenige Schüsse + noch heile
 *          eigene Felder × 25), alles mal Schwierigkeits-Faktor
 *          (Leicht 1.0 / Normal 1.4 / Schwer 1.9).  Bestwert in
 *          App.Storage 'best_battleship'.
 *   Multi: Treffer × 20, der Sieger bekommt +1000 → er steht sicher oben
 *          auf dem Podest von App.MG.endScreen.
 *
 * SYNC-MODELL (Multiplayer, rundenbasiert)
 *   WICHTIG: Die eigenen Schiffs-Positionen landen NIE in room.shared —
 *   sonst könnte der Gegner die Daten auslesen und spicken.  Jeder Spieler
 *   hält sein Brett rein lokal.
 *     room.shared  = { order:[id0,id1], phase:'place'|'play'|'over', turn,
 *                      first, shots:{ s1:{by,i,n}, … }, ackN, winner, rev }
 *                    → nur öffentliche Infos: WOHIN geschossen wurde.
 *     reportState  = { ready, rev, ans:{ s1:{r:'h'|'w', sk, c, d}, … } }
 *                    → jeder beantwortet NUR die Schüsse auf sein eigenes
 *                      Brett (Treffer/Wasser/versenkt/alles-weg).
 *   Der Host ist Schiedsrichter: er startet die Partie (beide bereit),
 *   bestätigt jeden Schuss (ackN) anhand der Antwort des Verteidigers,
 *   setzt danach 'turn' (Treffer → Schütze bleibt dran) und beendet die
 *   Partie.  Geschossen werden darf nur, wenn kein Schuss offen ist →
 *   keine Schreib-Konflikte.  Alle Antworten werden rein aus (Brett +
 *   bisherige Schüsse) berechnet und sind damit idempotent — die
 *   room.on()-Events dürfen also beliebig oft feuern (Heartbeat alle 4 s).
 *
 * SOLO
 *   Gegen einen Bot mit echter Jagd-KI: nach einem Treffer werden die
 *   Nachbarfelder abgeklappert, ab zwei Treffern in einer Linie wird die
 *   Richtung beibehalten und an beiden Enden weitergesucht.  Drei Stufen —
 *   Leicht (verliert öfter die Spur), Normal (Jagd + Schachbrett-Suche),
 *   Schwer (Jagd + Wahrscheinlichkeits-Karte aller noch möglichen
 *   Schiffs-Positionen).
 *
 * cleanup() beendet alle Timeouts und entfernt Room- + Tastatur-Listener. */
(function () {
  'use strict';
  window.App = window.App || {}; App.Minigames = App.Minigames || {};
  var UI = App.UI, el = UI.el;

  injectStyle();

  /* ===================== Konstanten ===================== */
  var SIZE = 8, N = SIZE * SIZE, COLS = 'ABCDEFGH';
  var FLEET = [
    { len: 5, name: 'Flugzeugträger', icon: '🛳️' },
    { len: 4, name: 'Schlachtschiff', icon: '🚢' },
    { len: 3, name: 'Kreuzer', icon: '⛴️' },
    { len: 3, name: 'U-Boot', icon: '🤿' },
    { len: 2, name: 'Zerstörer', icon: '🚤' }
  ];
  var FLEET_CELLS = 17;                       // 5+4+3+3+2
  var LEVELS = [
    { id: 'leicht', label: '🌴 Leicht', mul: 1.0 },
    { id: 'normal', label: '⚓ Normal', mul: 1.4 },
    { id: 'schwer', label: '☠️ Schwer', mul: 1.9 }
  ];
  var BOT_DELAY = 780;                        // ms Denkpause des Bots

  /* ===================== reine Brett-Logik ===================== */
  function xOf(i) { return i % SIZE; }
  function yOf(i) { return Math.floor(i / SIZE); }
  function coordName(i) { return COLS.charAt(xOf(i)) + (yOf(i) + 1); }
  function cellAt(i, dx, dy) {
    var x = xOf(i) + dx, y = yOf(i) + dy;
    if (x < 0 || x >= SIZE || y < 0 || y >= SIZE) return -1;
    return y * SIZE + x;
  }
  function newBoard() {
    var g = [], i;
    for (i = 0; i < N; i++) g.push(-1);       // -1 = Wasser, sonst Schiffs-Index
    return { grid: g, ships: [] };
  }
  /* Felder eines Schiffs ab 'start' — null, wenn es über den Rand ragt. */
  function cellsFor(start, len, horiz) {
    var x = xOf(start), y = yOf(start), out = [], k;
    if (horiz && x + len > SIZE) return null;
    if (!horiz && y + len > SIZE) return null;
    for (k = 0; k < len; k++) out.push(horiz ? (y * SIZE + x + k) : ((y + k) * SIZE + x));
    return out;
  }
  function freeCells(board, cells) {
    if (!cells) return false;
    for (var i = 0; i < cells.length; i++) if (board.grid[cells[i]] >= 0) return false;
    return true;
  }
  function addShip(board, def, cells) {
    var s = board.ships.length;
    board.ships.push({ len: def.len, name: def.name, icon: def.icon, cells: cells.slice() });
    cells.forEach(function (c) { board.grid[c] = s; });
  }
  function randomBoard() {
    var board = newBoard();
    FLEET.forEach(function (def) {
      var tries = 0, cells, i;
      while (tries < 800) {
        tries++;
        cells = cellsFor(Math.floor(Math.random() * N), def.len, Math.random() < 0.5);
        if (cells && freeCells(board, cells)) { addShip(board, def, cells); return; }
      }
      for (i = 0; i < N; i++) {              // Notfall: erste passende Stelle
        cells = cellsFor(i, def.len, true);
        if (cells && freeCells(board, cells)) { addShip(board, def, cells); return; }
        cells = cellsFor(i, def.len, false);
        if (cells && freeCells(board, cells)) { addShip(board, def, cells); return; }
      }
    });
    return board;
  }
  function shipSunk(board, s, shotSet) {
    var c = board.ships[s].cells, i;
    for (i = 0; i < c.length; i++) if (!shotSet[c[i]]) return false;
    return true;
  }
  function allSunk(board, shotSet) {
    for (var s = 0; s < board.ships.length; s++) if (!shipSunk(board, s, shotSet)) return false;
    return true;
  }
  /* Antwort auf einen Schuss, rein aus (Brett + allen bisherigen Schüssen auf
     dieses Brett) berechnet → beliebig oft wiederholbar, kein Doppelzählen.
     r:'h'|'w' · sk = versenkter Schiffs-Index · c = dessen Felder · d = Flotte weg */
  function judge(board, shotSet, i) {
    var s = board.grid[i];
    if (s < 0) return { r: 'w' };
    if (!shipSunk(board, s, shotSet)) return { r: 'h' };
    return { r: 'h', sk: s, c: board.ships[s].cells.slice(), d: allSunk(board, shotSet) };
  }
  /* Schüsse + Antworten → Feld-Markierungen fürs Rendern. */
  function marksFrom(shots) {
    var map = {}, sunk = [], hits = 0, last = -1, i, s;
    for (i = 0; i < FLEET.length; i++) sunk.push(false);
    for (i = 0; i < shots.length; i++) {
      s = shots[i];
      last = s.i;
      if (!s.ans) { map[s.i] = 'pending'; continue; }
      if (s.ans.r === 'w') { map[s.i] = 'miss'; continue; }
      hits++;
      map[s.i] = 'hit';
      if (s.ans.c) {
        if (typeof s.ans.sk === 'number') sunk[s.ans.sk] = true;
        s.ans.c.forEach(function (c) { map[c] = 'sunk'; });
      }
    }
    return { map: map, sunk: sunk, hits: hits, last: last };
  }
  function countHits(shots) {
    var n = 0;
    shots.forEach(function (s) { if (s.ans && s.ans.r === 'h') n++; });
    return n;
  }

  /* ===================== Bot-KI ===================== */
  /* shot/miss/sunkCell = was der Bot aus seinen Antworten WEISS (er schaut
     nie ins gegnerische Brett).  unres = Treffer, deren Schiff noch lebt. */
  function makeBot(level) {
    var shot = {}, miss = {}, sunkCell = {}, unres = [], remaining = [];
    FLEET.forEach(function (f) { remaining.push(f.len); });

    function open(i) { return !shot[i]; }
    function isUnres(i) { return unres.indexOf(i) >= 0; }

    function learn(i, ans) {
      shot[i] = true;
      if (ans.r === 'w') { miss[i] = true; return; }
      unres.push(i);
      if (ans.c) {                                   // Schiff versenkt
        ans.c.forEach(function (c) { sunkCell[c] = true; });
        unres = unres.filter(function (c) { return ans.c.indexOf(c) < 0; });
        var k = remaining.indexOf(ans.c.length);
        if (k >= 0) remaining.splice(k, 1);
      }
    }

    /* Zusammenhängende Treffer-Reihe durch h in Richtung (dx,dy) + deren Enden. */
    function runInfo(h, dx, dy) {
      var len = 1, a = h, b = h, c, ends = [];
      c = cellAt(a, -dx, -dy); while (c >= 0 && isUnres(c)) { len++; a = c; c = cellAt(a, -dx, -dy); }
      c = cellAt(b, dx, dy); while (c >= 0 && isUnres(c)) { len++; b = c; c = cellAt(b, dx, dy); }
      var e1 = cellAt(a, -dx, -dy), e2 = cellAt(b, dx, dy);
      if (e1 >= 0) ends.push(e1);
      if (e2 >= 0) ends.push(e2);
      return { len: len, ends: ends };
    }
    /* Jagd: Richtung beibehalten, sonst die vier Nachbarn. */
    function huntTargets() {
      if (!unres.length) return [];
      var h = unres[unres.length - 1];
      var rH = runInfo(h, 1, 0), rV = runInfo(h, 0, 1), t = [];
      if (rH.len >= 2 && rH.len >= rV.len) t = t.concat(rH.ends);
      if (rV.len >= 2 && rV.len >= rH.len) t = t.concat(rV.ends);
      if (!t.length) t = [cellAt(h, 1, 0), cellAt(h, -1, 0), cellAt(h, 0, 1), cellAt(h, 0, -1)];
      return t.filter(function (c) { return c >= 0 && open(c); });
    }
    /* Wahrscheinlichkeits-Karte: Wie oft passt noch ein Schiff über dieses Feld?
       Offene Treffer ziehen kräftig an → Jagd und Suche in einer Formel. */
    function density() {
      var score = [], i;
      for (i = 0; i < N; i++) score.push(0);
      remaining.forEach(function (len) {
        var o, start, cells, ok, k, c, bonus;
        for (o = 0; o < 2; o++) {
          for (start = 0; start < N; start++) {
            cells = cellsFor(start, len, o === 0);
            if (!cells) continue;
            ok = true; bonus = 0;
            for (k = 0; k < cells.length; k++) {
              c = cells[k];
              if (miss[c] || sunkCell[c]) { ok = false; break; }   // dort kann es nicht liegen
              if (isUnres(c)) bonus += 14;
            }
            if (!ok) continue;
            for (k = 0; k < cells.length; k++) if (open(cells[k])) score[cells[k]] += 1 + bonus;
          }
        }
      });
      var best = -1, bi = -1;
      for (i = 0; i < N; i++) if (open(i) && score[i] > best) { best = score[i]; bi = i; }
      return bi;
    }
    function firstOpen() { for (var i = 0; i < N; i++) if (open(i)) return i; return 0; }
    /* Suche ohne heiße Spur. */
    function search() {
      var i, cand = [], minLen = 99, d;
      if (level === 'schwer') { d = density(); if (d >= 0) return d; }
      if (level === 'normal') {
        remaining.forEach(function (l) { if (l < minLen) minLen = l; });
        if (minLen < 2 || minLen > SIZE) minLen = 2;
        for (i = 0; i < N; i++) if (open(i) && (xOf(i) + yOf(i)) % minLen === 0) cand.push(i);
      }
      if (!cand.length) for (i = 0; i < N; i++) if (open(i)) cand.push(i);
      if (!cand.length) return firstOpen();
      return cand[Math.floor(Math.random() * cand.length)];
    }
    function next() {
      var t, d;
      if (unres.length && !(level === 'leicht' && Math.random() < 0.45)) {
        t = huntTargets();
        if (t.length) {
          if (level === 'schwer') { d = density(); if (t.indexOf(d) >= 0) return d; }
          return t[Math.floor(Math.random() * t.length)];
        }
      }
      var s = search();
      return (s >= 0 && s < N) ? s : firstOpen();
    }
    return { next: next, learn: learn };
  }

  /* ===================== DOM-Bausteine ===================== */
  /* 8×8-Raster mit Beschriftung A–H / 1–8.  onCell(i,'down'|'over') */
  function buildBoard(mini, onCell) {
    var grid = el('div', { class: 'bsh-grid' });
    var cells = [], i;
    for (i = 0; i < N; i++) {
      (function (k) {
        var c = el('button', { class: 'bsh-cell', type: 'button', 'aria-label': coordName(k) });
        if (onCell) {
          c.addEventListener('pointerdown', function (e) { e.preventDefault(); onCell(k, 'down'); });
          c.addEventListener('pointerenter', function () { onCell(k, 'over'); });
        }
        cells.push(c); grid.appendChild(c);
      })(i);
    }
    var cols = el('div', { class: 'bsh-cols' });
    for (i = 0; i < SIZE; i++) cols.appendChild(el('span', {}, [COLS.charAt(i)]));
    var rows = el('div', { class: 'bsh-rows' });
    for (i = 0; i < SIZE; i++) rows.appendChild(el('span', {}, [String(i + 1)]));
    var frame = el('div', { class: 'bsh-frame' + (mini ? ' bsh-mini' : '') }, [
      el('span', { class: 'bsh-corner' }), cols, rows, grid
    ]);
    return { root: frame, grid: grid, cells: cells };
  }

  function setCell(node, cls, txt) {
    if (node.className !== cls) node.className = cls;      // kein Neu-Setzen → Animation läuft nicht neu
    if (node.textContent !== txt) node.textContent = txt;
  }
  function paintFleet(node, sunk) {
    var sig = sunk.join(',');
    if (node.getAttribute('data-sig') === sig) return;
    node.setAttribute('data-sig', sig);
    node.innerHTML = '';
    FLEET.forEach(function (f, k) {
      node.appendChild(el('span', { class: 'bsh-chip' + (sunk[k] ? ' dead' : '') }, [f.icon + ' ' + f.len]));
    });
  }
  function paintLog(node, log) {
    var view = log.slice(-4), sig = view.map(function (e) { return e.k; }).join(',');
    if (node.getAttribute('data-sig') === sig) return;
    node.setAttribute('data-sig', sig);
    node.innerHTML = '';
    view.forEach(function (e) { node.appendChild(el('div', { class: 'bsh-log-l ' + e.c }, [e.t])); });
  }

  /* ---- Aufbauphase (Solo + Multi identisch) ---- */
  function makePlacement(opts) {
    opts = opts || {};
    var board = newBoard(), horiz = true, hover = -1, locked = false;

    var bd = buildBoard(false, onCellEvt);
    var statusEl = el('div', { class: 'bsh-status you' }, ['⚓ Stell deine Flotte auf']);
    var nextEl = el('div', { class: 'bsh-next' }, ['']);
    var fleetEl = el('div', { class: 'bsh-fleet bsh-fleet-c' });
    var rotBtn = el('button', { class: 'btn btn-aqua bsh-b', type: 'button', onclick: rotate }, ['↻']);
    var randBtn = el('button', { class: 'btn btn-ghost bsh-b', type: 'button', onclick: randomize }, ['🎲 Zufall']);
    var undoBtn = el('button', { class: 'btn btn-ghost bsh-b', type: 'button', onclick: undo }, ['↶ Zurück']);
    var readyBtn = el('button', { class: 'btn btn-primary bsh-ready', type: 'button', onclick: confirm }, ['⚓ Bereit']);
    var waitEl = el('div', { class: 'bsh-wait' }, ['']);

    var wrap = el('div', { class: 'bsh-wrap' }, [
      statusEl,
      opts.extra || null,
      nextEl,
      bd.root,
      el('div', { class: 'controls-row bsh-row' }, [rotBtn, randBtn, undoBtn]),
      fleetEl,
      readyBtn,
      waitEl,
      el('p', { class: 'hint-text bsh-hint' }, ['Klick setzt das Schiff (Feld = Bug) · ↻ dreht quer/hoch (Taste R) · 🎲 = Zufallsaufstellung'])
    ]);

    bd.grid.addEventListener('pointerleave', function () { hover = -1; paint(); });
    function onKey(e) {
      if (locked) return;
      if (e.key === 'r' || e.key === 'R') { e.preventDefault(); rotate(); }
    }
    document.addEventListener('keydown', onKey);

    function onCellEvt(i, kind) {
      if (locked) return;
      if (kind === 'over') { hover = i; paint(); return; }
      var def = FLEET[board.ships.length];
      if (!def) { UI.toast('Alle Schiffe stehen — auf "Bereit" tippen', 'info'); return; }
      var cs = cellsFor(i, def.len, horiz);
      if (!cs || !freeCells(board, cs)) {
        if (App.Audio) App.Audio.sfx('error');
        UI.toast('Da passt das Schiff nicht', 'info');
        return;
      }
      addShip(board, def, cs);
      if (App.Audio) App.Audio.sfx('click');
      hover = i; paint();
    }
    function rotate() { if (locked) return; horiz = !horiz; if (App.Audio) App.Audio.sfx('select'); paint(); }
    function randomize() {
      if (locked) return;
      board = randomBoard();
      if (App.Audio) App.Audio.sfx('whoosh');
      paint();
    }
    function undo() {
      if (locked) return;
      var s = board.ships.pop();
      if (!s) return;
      s.cells.forEach(function (c) { board.grid[c] = -1; });
      if (App.Audio) App.Audio.sfx('pop');
      paint();
    }
    function confirm() {
      if (locked || board.ships.length < FLEET.length) {
        if (App.Audio) App.Audio.sfx('error');
        UI.toast('Erst alle 5 Schiffe setzen', 'info');
        return;
      }
      locked = true;
      if (App.Audio) App.Audio.sfx('ding');
      statusEl.textContent = '🚩 Flotte steht!';
      paint();
      if (opts.onReady) opts.onReady(board);
    }

    function paint() {
      var placed = board.ships.length, def = FLEET[placed] || null, i;
      nextEl.textContent = def
        ? ('Als Nächstes: ' + def.icon + ' ' + def.name + ' · ' + def.len + ' Felder · ' + (horiz ? 'quer ➡' : 'hoch ⬇'))
        : (locked ? 'Deine Flotte ist bereit.' : '✔ Alle Schiffe gesetzt — auf "Bereit" tippen!');

      var prev = {};
      if (def && hover >= 0 && !locked) {
        var cs = cellsFor(hover, def.len, horiz);
        if (cs) {
          var ok = freeCells(board, cs);
          cs.forEach(function (c) { prev[c] = ok ? 'ok' : 'bad'; });
        } else prev[hover] = 'bad';
      }
      for (i = 0; i < N; i++) {
        var s = board.grid[i], cls = 'bsh-cell', txt = '';
        if (s >= 0) { cls += ' bsh-ship'; if (board.ships[s].cells[0] === i) txt = board.ships[s].icon; }
        if (prev[i]) cls += ' bsh-pv-' + prev[i];
        setCell(bd.cells[i], cls, txt);
      }
      fleetEl.innerHTML = '';
      FLEET.forEach(function (f, k) {
        fleetEl.appendChild(el('span', { class: 'bsh-chip' + (k < placed ? ' set' : (k === placed && !locked ? ' cur' : '')) },
          [f.icon + ' ' + f.len]));
      });
      rotBtn.textContent = horiz ? '↻ quer ➡' : '↻ hoch ⬇';
      rotBtn.disabled = locked;
      randBtn.disabled = locked;
      undoBtn.disabled = locked || !placed;
      readyBtn.disabled = locked || placed < FLEET.length;
      readyBtn.textContent = locked ? '✔ Bereit' : '⚓ Bereit';
      bd.grid.classList.toggle('bsh-clickable', !locked && placed < FLEET.length);
    }
    paint();

    return {
      root: wrap,
      stop: function () { document.removeEventListener('keydown', onKey); },
      setWait: function (t) { waitEl.textContent = t || ''; }
    };
  }

  /* ---- Spielphase (Solo + Multi identisch) ---- */
  function makePlay(onShot) {
    var statusEl = el('div', { class: 'bsh-status' }, ['']);
    var enemyTitle = el('div', { class: 'mg-field-title' }, ['🎯 Gegner']);
    var enemyFleet = el('div', { class: 'bsh-fleet' });
    var enemy = buildBoard(false, function (i, kind) { if (kind === 'down') onShot(i); });
    var myTitle = el('div', { class: 'mg-field-title' }, ['🛡 Du']);
    var myFleet = el('div', { class: 'bsh-fleet' });
    var mine = buildBoard(true, null);
    var logEl = el('div', { class: 'bsh-log' });

    var root = el('div', { class: 'bsh-wrap' }, [
      statusEl,
      el('div', { class: 'bsh-head' }, [enemyTitle, enemyFleet]),
      enemy.root,
      el('div', { class: 'bsh-bottom' }, [
        el('div', { class: 'bsh-minecol' }, [myTitle, mine.root]),
        el('div', { class: 'bsh-infocol' }, [myFleet, logEl])
      ]),
      el('p', { class: 'hint-text bsh-hint' }, ['Klick ins Gegner-Raster = Schuss · Treffer 💥 = nochmal dran · Wasser 💦 = Gegner ist dran'])
    ]);
    return {
      root: root, statusEl: statusEl, enemy: enemy, mine: mine,
      enemyTitle: enemyTitle, enemyFleet: enemyFleet,
      myTitle: myTitle, myFleet: myFleet, logEl: logEl
    };
  }

  function paintPlayView(refs, vm) {
    var i, cls, txt, m;
    refs.statusEl.textContent = vm.status.t;
    refs.statusEl.className = 'bsh-status ' + vm.status.c;

    for (i = 0; i < N; i++) {
      m = vm.enemyMarks[i]; cls = 'bsh-cell'; txt = '';
      if (m === 'pending') { cls += ' bsh-pending'; txt = '🎯'; }
      else if (m === 'miss') { cls += ' bsh-miss'; txt = '💦'; }
      else if (m === 'hit') { cls += ' bsh-hit'; txt = '💥'; }
      else if (m === 'sunk') { cls += ' bsh-sunk'; txt = '☠️'; }
      if (vm.enemyLast === i && m) cls += ' bsh-last';
      setCell(refs.enemy.cells[i], cls, txt);
    }
    for (i = 0; i < N; i++) {
      m = vm.myMarks[i]; cls = 'bsh-cell';
      if (vm.myGrid[i] >= 0) cls += ' bsh-ship';
      if (m === 'miss') cls += ' bsh-miss';
      else if (m === 'hit') cls += ' bsh-hit';
      else if (m === 'sunk') cls += ' bsh-sunk';
      if (vm.myLast === i && m) cls += ' bsh-last';
      setCell(refs.mine.cells[i], cls, '');
    }
    refs.enemy.grid.classList.toggle('bsh-clickable', !!vm.clickable);
    refs.enemyTitle.textContent = '🎯 ' + vm.enemyName + ' · noch ' + (FLEET_CELLS - vm.enemyHits) + ' Felder';
    refs.myTitle.textContent = '🛡 Du · noch ' + (FLEET_CELLS - vm.myHits);
    paintFleet(refs.enemyFleet, vm.enemySunk);
    paintFleet(refs.myFleet, vm.mySunk);
    paintLog(refs.logEl, vm.log);
  }

  function panel(icon, title, subtitle, actions) {
    return el('div', { class: 'bsh-panel glass' }, [
      el('div', { class: 'bsh-panel-icon' }, [icon]),
      el('h2', { class: 'bsh-big neon' }, [title]),
      subtitle || null,
      actions ? el('div', { class: 'controls-row' }, actions) : null
    ]);
  }

  /* ===================== Registrierung ===================== */
  App.Minigames.battleship = {
    id: 'battleship', title: 'Schiffe versenken', icon: '⚓', order: 101,
    subtitle: 'Triff die Flotte – Treffer heißt nochmal!',
    single: true, multi: true, minPlayers: 2, maxPlayers: 2,

    render: function (root, ctx) {
      var isMulti = ctx.mode === 'multi' && ctx.room;
      var dead = false, pending = [], stops = [];

      function after(ms, fn) { var t = setTimeout(function () { if (!dead) fn(); }, ms); pending.push(t); return t; }
      function clearPending() { pending.forEach(clearTimeout); pending = []; }
      function stopHelpers() { stops.forEach(function (f) { try { f(); } catch (e) {} }); stops = []; }

      return isMulti ? renderMulti() : renderSolo();

      /* =========================================================
       *  SOLO — gegen den Bot, kein Netz
       * ========================================================= */
      function renderSolo() {
        var level = App.Storage.get('bsh_level', 'normal');
        if (level !== 'leicht' && level !== 'normal' && level !== 'schwer') level = 'normal';
        var plc = null;

        startPlacement();
        return { cleanup: function () { dead = true; clearPending(); stopHelpers(); } };

        function levelInfo(id) {
          for (var i = 0; i < LEVELS.length; i++) if (LEVELS[i].id === id) return LEVELS[i];
          return LEVELS[1];
        }

        function startPlacement() {
          clearPending(); stopHelpers();
          var chips = LEVELS.map(function (L) {
            return el('button', { class: 'chip bsh-lv' + (L.id === level ? ' active' : ''), type: 'button', onclick: function () {
              level = L.id;
              App.Storage.set('bsh_level', level);
              if (App.Audio) App.Audio.sfx('select');
              chips.forEach(function (c, k) { c.classList.toggle('active', LEVELS[k].id === level); });
            } }, [L.label]);
          });
          var row = el('div', { class: 'bsh-levels' }, [el('span', { class: 'bsh-lv-l' }, ['Bot'])].concat(chips));
          plc = makePlacement({ extra: row, onReady: startGame });
          stops.push(plc.stop);
          root.innerHTML = ''; root.appendChild(plc.root);
        }

        function startGame(myBoard) {
          if (plc) plc.stop();
          var botBoard = randomBoard();
          var bot = makeBot(level);
          var myShots = [], botShots = [], myShotSet = {}, botShotSet = {};
          var turn = 'me', over = false, iWon = false, fired = 0;
          var log = [], logK = 0;
          var botName = 'Bot ' + levelInfo(level).label;
          var refs = makePlay(onShot);
          root.innerHTML = ''; root.appendChild(refs.root);
          paint();

          function addLog(mineShot, i, ans) {
            var who = mineShot ? 'Du' : 'Bot';
            var t, c;
            if (ans.r === 'w') { t = '💦 ' + who + ': Wasser auf ' + coordName(i); c = 'w'; if (App.Audio) App.Audio.sfx('pop'); }
            else if (ans.c) {
              var f = FLEET[ans.sk];
              t = '☠️ ' + f.icon + ' ' + f.name + (mineShot ? ' versenkt!' : ' von dir versenkt!');
              c = mineShot ? 'h' : 'l';
              if (App.Audio) App.Audio.sfx('explosion');
              UI.toast(f.name + (mineShot ? ' versenkt! ☠️' : ' verloren 💀'), mineShot ? 'win' : 'lose');
            } else {
              t = '💥 ' + who + ': Treffer auf ' + coordName(i);
              c = mineShot ? 'h' : 'l';
              if (App.Audio) App.Audio.sfx('hit');
            }
            logK++;
            log.push({ t: t, c: c, k: logK });
            if (log.length > 8) log.shift();
          }

          function onShot(i) {
            if (dead || over || turn !== 'me') { if (turn !== 'me' && !over) UI.toast('Der Bot ist dran', 'info'); return; }
            if (myShotSet[i]) { if (App.Audio) App.Audio.sfx('error'); UI.toast('Da hast du schon geschossen', 'info'); return; }
            myShotSet[i] = true;
            fired++;
            var ans = judge(botBoard, myShotSet, i);
            myShots.push({ i: i, ans: ans });
            addLog(true, i, ans);
            if (ans.d) { finish(true); return; }
            if (ans.r === 'w') turn = 'bot';
            paint();
            if (turn === 'bot') scheduleBot();
          }

          function scheduleBot() {
            after(BOT_DELAY, function () {
              if (dead || over || turn !== 'bot') return;
              var i = bot.next();
              botShotSet[i] = true;
              var ans = judge(myBoard, botShotSet, i);
              bot.learn(i, ans);
              botShots.push({ i: i, ans: ans });
              addLog(false, i, ans);
              if (ans.d) { finish(false); return; }
              if (ans.r === 'w') turn = 'me';
              paint();
              if (turn === 'bot') scheduleBot();
            });
          }

          function status() {
            if (over) return iWon
              ? { t: '🏆 Flotte versenkt — du gewinnst!', c: 'win' }
              : { t: '💀 Deine Flotte ist versenkt', c: 'lose' };
            if (turn === 'me') return { t: '⚓ Du bist dran — feuer!', c: 'you' };
            return { t: '🔭 ' + botName + ' zielt …', c: 'opp' };
          }

          function paint() {
            var em = marksFrom(myShots), mm = marksFrom(botShots);
            paintPlayView(refs, {
              status: status(),
              enemyMarks: em.map, enemyLast: em.last, enemySunk: em.sunk, enemyHits: em.hits,
              myMarks: mm.map, myLast: mm.last, mySunk: mm.sunk, myHits: mm.hits,
              myGrid: myBoard.grid,
              enemyName: botName, clickable: !over && turn === 'me',
              log: log
            });
          }

          function finish(win) {
            over = true; iWon = win;
            paint();
            if (App.Audio) App.Audio.sfx(win ? 'win' : 'lose');
            if (win && App.Scores && App.Scores.winCurrent) App.Scores.winCurrent();

            var mul = levelInfo(level).mul;
            var hits = countHits(myShots);
            var score = hits * 20;
            if (win) {
              var quick = Math.max(200, 900 - Math.max(0, fired - FLEET_CELLS) * 14);
              var alive = FLEET_CELLS - countHits(botShots);
              score += quick + alive * 25;
            }
            score = Math.round(score * mul);

            var best = App.Storage.get('best_battleship', 0);
            var nb = score > best;
            if (nb) App.Storage.set('best_battleship', score);

            after(1400, function () {
              if (dead) return;
              App.MG.endScreen(root, {
                score: score, best: best, newBest: nb,
                title: win ? '🏆 Feindflotte versenkt!' : '💀 Untergegangen',
                label: 'Treffer ' + hits + '/' + FLEET_CELLS + ' · ' + fired + ' Schüsse · ' + levelInfo(level).label +
                  (nb ? ' · neuer Rekord! 🎉' : ' · Bestwert: ' + App.MG.fmt(best)),
                onExit: ctx.onExit,
                onAgain: function () { startPlacement(); }
              });
            });
          }
        }
      }

      /* =========================================================
       *  MULTI — Bretter bleiben lokal, Host ist Schiedsrichter
       * ========================================================= */
      function renderMulti() {
        var room = ctx.room, me = ctx.me;
        var snap0 = room.snapshot() || {};
        var lastShared = snap0.shared || null;

        var myBoard = null, myAns = null, myReady = false;
        var myRev = (lastShared && lastShared.rev) || 0;
        var curView = null, plc = null, refs = null, waitRefs = null;
        var cdDone = false, initToken = '', startWritten = false, ackWritten = -1;
        var endShown = false, lastScore = -1, firstPaint = true, curHits = 0;
        var log = [], logK = 0, seen = {};

        /* room.now() liefert je nach Transport einen Zeitstempel — beim
           Firebase-Backend aber ein Server-Sentinel-Objekt.  Deshalb absichern,
           sonst wird der Countdown zu NaN und läuft nie ab. */
        function serverNow() {
          var t = room.now();
          return (typeof t === 'number' && isFinite(t)) ? t : Date.now();
        }

        function onShared(sh) { if (dead) return; lastShared = sh; sync(); }
        function onPlayers() { if (dead) return; sync(); }
        room.on('shared', onShared);
        room.on('players', onPlayers);

        /* Start exakt wie in reflex.js: synchroner Countdown, danach Aufbau. */
        var startAt = (snap0.round && snap0.round.startAt) || (serverNow() + 3000);
        stops.push(App.MG.countdown(root, startAt, function () { cdDone = true; sync(); }, serverNow));

        return {
          cleanup: function () {
            dead = true; clearPending(); stopHelpers();
            room.off('shared', onShared);
            room.off('players', onPlayers);
          }
        };

        /* ---- kleine Helfer ---- */
        function stOf(players, id) {
          for (var i = 0; i < players.length; i++) if (players[i].id === id) return players[i].state || null;
          return null;
        }
        function nameOf(players, id) {
          for (var i = 0; i < players.length; i++) if (players[i].id === id) return players[i].name;
          return 'Gegner';
        }
        function other(id, sh) { return sh.order[0] === id ? sh.order[1] : sh.order[0]; }
        function shotList(sh) {
          var o = (sh && sh.shots) || {}, out = [];
          Object.keys(o).forEach(function (k) {
            var s = o[k];
            if (s && typeof s.n === 'number' && typeof s.i === 'number') out.push(s);
          });
          out.sort(function (a, b) { return a.n - b.n; });
          return out;
        }
        function pendingOf(sh) {
          var shots = shotList(sh);
          if (!shots.length) return null;
          var last = shots[shots.length - 1];
          return (sh.ackN || 0) < last.n ? last : null;
        }
        function orderOk(sh, players) {
          if (!sh || !sh.order || sh.order.length < 2) return false;
          var ids = players.map(function (p) { return p.id; });
          return ids.indexOf(sh.order[0]) >= 0 && ids.indexOf(sh.order[1]) >= 0;
        }
        function pushState() {
          room.reportState({ ready: !!myReady, rev: myRev, ans: myAns || null });
        }

        /* ---- zentraler Abgleich (idempotent, darf beliebig oft laufen) ---- */
        function sync() {
          if (dead || !cdDone) return;
          var players = room.players();
          if (players.length < 2) { showWait(players, false); return; }

          var sh = lastShared;
          if (!orderOk(sh, players)) {
            if (room.isHost()) initShared(players);
            showWait(players, true);
            return;
          }
          if (sh.order.indexOf(me.id) < 0) { showWait(players, true); return; }

          var rev = sh.rev || 0;
          if (rev !== myRev) resetGame(rev);
          if (curView === 'end') return;               // Endscreen steht — nur eine Revanche baut neu

          if (sh.phase === 'play' || sh.phase === 'over') {
            if (!myBoard) { showWait(players, true); return; }
            ensurePlay();
            answer(sh);
            referee(sh);
            paint(sh, players);
            reportScore(sh);
            if (sh.phase === 'over') finishMulti(sh);
            return;
          }
          ensurePlacement();
          placementWait(players, sh);
          hostStart(sh, players);
        }

        function dropPlacement() { if (plc) { plc.stop(); plc = null; } }

        function resetGame(rev) {
          myRev = rev; myBoard = null; myAns = null; myReady = false;
          dropPlacement();
          curView = null; refs = null;
          log = []; seen = {}; firstPaint = true;
          startWritten = false; ackWritten = -1; endShown = false; lastScore = -1;
          pushState();
        }

        /* Host: Reihenfolge festlegen (auch nach einem Spieler-Wechsel). */
        function initShared(players) {
          var ids = [players[0].id, players[1].id], tok = ids.join('|');
          if (initToken === tok) return;
          initToken = tok;
          room.setShared({
            order: ids, phase: 'place', turn: null, first: null,
            shots: null, ackN: 0, winner: null, rev: ((lastShared && lastShared.rev) || 0) + 1
          });
        }

        /* ---- Aufbauphase ---- */
        function ensurePlacement() {
          if (curView === 'place') return;
          curView = 'place';
          plc = makePlacement({
            onReady: function (board) {
              myBoard = board; myReady = true;
              pushState();
              if (plc) plc.setWait('⏳ Warte auf den Gegner …');
            }
          });
          stops.push(plc.stop);
          root.innerHTML = ''; root.appendChild(plc.root);
        }
        function placementWait(players, sh) {
          if (!plc) return;
          var oppId = other(me.id, sh);
          var oppSt = stOf(players, oppId);
          var oppReady = !!(oppSt && oppSt.ready && (oppSt.rev || 0) === (sh.rev || 0));
          if (myReady) plc.setWait(oppReady ? '🚩 Beide bereit — es geht los!' : ('⏳ Warte auf ' + nameOf(players, oppId) + ' …'));
          else plc.setWait(oppReady ? ('🚩 ' + nameOf(players, oppId) + ' ist bereit!') : '');
        }
        function hostStart(sh, players) {
          if (!room.isHost() || startWritten || sh.phase !== 'place') return;
          var a = stOf(players, sh.order[0]), b = stOf(players, sh.order[1]);
          if (!ready(a, sh) || !ready(b, sh)) return;
          startWritten = true;
          var first = sh.order[Math.random() < 0.5 ? 0 : 1];
          room.setShared({ phase: 'play', turn: first, first: first, ackN: 0 });
        }
        function ready(st, sh) { return !!(st && st.ready && (st.rev || 0) === (sh.rev || 0)); }

        /* ---- Spielphase ---- */
        function ensurePlay() {
          if (curView === 'play') return;
          curView = 'play';
          dropPlacement();
          refs = makePlay(onShot);
          root.innerHTML = ''; root.appendChild(refs.root);
        }

        function onShot(i) {
          var sh = lastShared;
          if (dead || !sh || sh.phase !== 'play') return;
          if (sh.turn !== me.id) { UI.toast('Warte — du bist nicht dran', 'info'); return; }
          if (pendingOf(sh)) return;                       // letzter Schuss noch unbestätigt
          var shots = shotList(sh), k;
          for (k = 0; k < shots.length; k++) {
            if (shots[k].by === me.id && shots[k].i === i) {
              if (App.Audio) App.Audio.sfx('error');
              UI.toast('Da hast du schon geschossen', 'info');
              return;
            }
          }
          var n = shots.length ? shots[shots.length - 1].n + 1 : 1;
          var patch = {};
          patch['shots/s' + n] = { by: me.id, i: i, n: n };
          if (App.Audio) App.Audio.sfx('select');
          room.setShared(patch);
        }

        /* Verteidiger: jeden Schuss auf MEIN Brett genau einmal beantworten.
           Die Schiffs-Positionen bleiben dabei lokal — veröffentlicht wird nur
           das Ergebnis. */
        function answer(sh) {
          if (!myBoard) return;
          var shotSet = {}, changed = false;
          shotList(sh).forEach(function (s) {
            if (s.by === me.id) return;
            shotSet[s.i] = true;
            var key = 's' + s.n;
            if (myAns && myAns[key]) return;
            myAns = myAns || {};
            myAns[key] = judge(myBoard, shotSet, s.i);
            changed = true;
          });
          if (changed) pushState();
        }

        /* Host als Schiedsrichter: Schuss bestätigen, Zug setzen, Ende erklären. */
        function referee(sh) {
          if (!room.isHost() || sh.phase !== 'play') return;
          var last = pendingOf(sh);
          if (!last || ackWritten >= last.n) return;
          var def = other(last.by, sh);
          var st = stOf(room.players(), def);
          var a = st && st.ans && st.ans['s' + last.n];
          if (!a) return;                                   // Antwort abwarten
          ackWritten = last.n;
          var patch = { ackN: last.n };
          if (a.d) { patch.phase = 'over'; patch.winner = last.by; }
          else patch.turn = (a.r === 'h') ? last.by : def;  // Treffer → Schütze bleibt dran
          room.setShared(patch);
        }

        function addLog(mineShot, i, a, silent) {
          var who = mineShot ? 'Du' : 'Gegner';
          var t, c;
          if (a.r === 'w') { t = '💦 ' + who + ': Wasser auf ' + coordName(i); c = 'w'; if (!silent && App.Audio) App.Audio.sfx('pop'); }
          else if (a.c) {
            var f = FLEET[a.sk];
            t = '☠️ ' + f.icon + ' ' + f.name + (mineShot ? ' versenkt!' : ' von dir versenkt!');
            c = mineShot ? 'h' : 'l';
            if (!silent) {
              if (App.Audio) App.Audio.sfx('explosion');
              UI.toast(f.name + (mineShot ? ' versenkt! ☠️' : ' verloren 💀'), mineShot ? 'win' : 'lose');
            }
          } else {
            t = '💥 ' + who + ': Treffer auf ' + coordName(i);
            c = mineShot ? 'h' : 'l';
            if (!silent && App.Audio) App.Audio.sfx('hit');
          }
          logK++;
          log.push({ t: t, c: c, k: logK });
          if (log.length > 8) log.shift();
        }

        function paint(sh, players) {
          var oppId = other(me.id, sh);
          var oppSt = stOf(players, oppId) || {};
          var oppAns = oppSt.ans || {};
          var shots = shotList(sh);
          var mineShots = [], theirShots = [];
          shots.forEach(function (s) {
            if (s.by === me.id) mineShots.push({ i: s.i, ans: oppAns['s' + s.n] || null });
            else theirShots.push({ i: s.i, ans: (myAns && myAns['s' + s.n]) || null });
          });
          shots.forEach(function (s) {                      // Log + Sounds, jedes Ereignis genau einmal
            if (seen[s.n]) return;
            var a = s.by === me.id ? oppAns['s' + s.n] : (myAns && myAns['s' + s.n]);
            if (!a) return;
            seen[s.n] = true;
            addLog(s.by === me.id, s.i, a, firstPaint);
          });

          var em = marksFrom(mineShots), mm = marksFrom(theirShots);
          curHits = em.hits;
          var pend = pendingOf(sh), st;
          if (sh.phase === 'over') {
            st = sh.winner === me.id
              ? { t: '🏆 Alle Schiffe versenkt — du gewinnst!', c: 'win' }
              : { t: '💀 Deine Flotte ist versenkt', c: 'lose' };
          } else if (pend) {
            st = pend.by === me.id ? { t: '🎯 Schuss unterwegs …', c: 'opp' } : { t: '⏳ Auswertung …', c: 'opp' };
          } else if (sh.turn === me.id) {
            st = { t: '⚓ Du bist dran — feuer!', c: 'you' };
          } else {
            st = { t: '🔭 ' + nameOf(players, oppId) + ' zielt …', c: 'opp' };
          }

          paintPlayView(refs, {
            status: st,
            enemyMarks: em.map, enemyLast: em.last, enemySunk: em.sunk, enemyHits: em.hits,
            myMarks: mm.map, myLast: mm.last, mySunk: mm.sunk, myHits: mm.hits,
            myGrid: myBoard.grid,
            enemyName: nameOf(players, oppId),
            clickable: sh.phase === 'play' && sh.turn === me.id && !pend,
            log: log
          });
          firstPaint = false;
        }

        function reportScore(sh) {
          var s = curHits * 20 + ((sh.phase === 'over' && sh.winner === me.id) ? 1000 : 0);
          if (s === lastScore) return;
          lastScore = s;
          room.reportScore(s);
        }

        function finishMulti(sh) {
          if (endShown) return;
          endShown = true;
          var win = sh.winner === me.id;
          if (App.Audio) App.Audio.sfx(win ? 'win' : 'lose');
          if (win && App.Scores && App.Scores.winCurrent) App.Scores.winCurrent();
          after(1500, function () {
            if (dead) return;
            curView = 'end';
            App.MG.endScreen(root, {
              players: room.players(), meId: me.id,
              title: '💀 Deine Flotte ist versenkt',
              onExit: ctx.onExit,
              onAgain: room.isHost() ? doRevanche : null
            });
          });
        }
        function doRevanche() {
          var sh = lastShared;
          if (!sh) return;
          room.setShared({
            phase: 'place', rev: (sh.rev || 0) + 1, shots: null,
            ackN: 0, winner: null, turn: null, first: null
          });
        }

        /* ---- Warte-Ansicht (Gegner fehlt / Raum wird vorbereitet) ---- */
        function showWait(players, starting) {
          if (curView !== 'wait') {
            curView = 'wait';
            dropPlacement(); refs = null;
            var count = el('div', { class: 'bsh-big neon' }, ['1 / 2']);
            var msg = el('p', { class: 'hint-text' }, ['']);
            waitRefs = { count: count, msg: msg };
            root.innerHTML = '';
            root.appendChild(panel('⚓', 'Schiffe versenken', el('div', { class: 'bsh-waitbox' }, [count, msg]), [
              el('button', { class: 'btn btn-ghost', type: 'button', onclick: ctx.onExit }, ['Zurück zur Lobby'])
            ]));
          }
          waitRefs.count.textContent = players.length + ' / 2';
          waitRefs.msg.textContent = starting ? 'Partie wird vorbereitet …' : 'Warte auf den zweiten Kapitän …';
        }
      }
    }
  };

  /* ===================== STYLES ===================== */
  function injectStyle() {
    UI.injectStyle('mg-battleship-css', [
      '.bsh-wrap{display:flex;flex-direction:column;gap:10px;width:100%;max-width:340px;margin:0 auto;}',
      '.bsh-status{text-align:center;font-weight:900;font-size:clamp(14px,4.2vw,18px);min-height:24px;line-height:1.2;transition:color .15s;}',
      '.bsh-status.you{color:var(--neon);text-shadow:0 0 10px rgba(57,255,20,.45);}',
      '.bsh-status.opp{color:var(--aqua);}',
      '.bsh-status.win{color:var(--gold);text-shadow:0 0 14px rgba(255,210,63,.5);animation:bsh-in .4s ease;}',
      '.bsh-status.lose{color:var(--danger);animation:bsh-shake .4s ease;}',
      '.bsh-next{text-align:center;font-size:12px;font-weight:800;color:var(--leaf);min-height:15px;}',
      '.bsh-head{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;}',
      /* --- Raster --- */
      '.bsh-frame{display:grid;grid-template-columns:13px 1fr;grid-template-rows:13px 1fr;gap:3px;width:100%;}',
      '.bsh-cols{display:grid;grid-template-columns:repeat(8,1fr);gap:3px;}',
      '.bsh-cols span{text-align:center;font-size:9px;font-weight:800;color:var(--muted);}',
      '.bsh-rows{display:grid;grid-template-rows:repeat(8,1fr);gap:3px;}',
      '.bsh-rows span{display:flex;align-items:center;justify-content:center;font-size:9px;font-weight:800;color:var(--muted);}',
      '.bsh-grid{display:grid;grid-template-columns:repeat(8,1fr);gap:3px;touch-action:manipulation;}',
      '.bsh-cell{aspect-ratio:1/1;display:flex;align-items:center;justify-content:center;padding:0;border-radius:6px;',
      'border:1px solid var(--stroke);background:linear-gradient(160deg,rgba(8,40,54,.92),rgba(3,15,22,.92));',
      'color:#fff;font-size:clamp(9px,3vw,17px);line-height:1;font-family:inherit;cursor:default;',
      'user-select:none;-webkit-user-select:none;-webkit-tap-highlight-color:transparent;overflow:hidden;',
      'transition:transform .1s,box-shadow .18s,border-color .18s,background .18s;}',
      '.bsh-grid.bsh-clickable .bsh-cell:not(.bsh-miss):not(.bsh-hit):not(.bsh-sunk):hover{cursor:pointer;border-color:var(--neon);',
      'box-shadow:inset 0 0 14px rgba(57,255,20,.28);transform:translateY(-1px);}',
      '.bsh-grid.bsh-clickable .bsh-cell:active{transform:scale(.94);}',
      '.bsh-ship{background:linear-gradient(160deg,#1e7a41,#0b3a1f);border-color:var(--stroke-2);}',
      '.bsh-miss{background:radial-gradient(circle at 50% 45%,rgba(51,230,208,.24),rgba(3,15,22,.95));border-color:rgba(51,230,208,.4);animation:bsh-splash .38s ease;}',
      '.bsh-hit{background:radial-gradient(circle at 50% 45%,#ff8b3d,#5e1305);border-color:#ffc09a;box-shadow:0 0 12px rgba(255,139,61,.55);animation:bsh-boom .32s ease;}',
      '.bsh-sunk{background:radial-gradient(circle at 50% 45%,#8d1026,#2c040a);border-color:var(--danger);box-shadow:0 0 14px rgba(255,77,109,.5);animation:bsh-sink .5s ease;}',
      '.bsh-pending{border-color:var(--aqua);box-shadow:0 0 10px rgba(51,230,208,.4);animation:bsh-ping .8s ease-in-out infinite;}',
      '.bsh-last{outline:2px solid var(--gold);outline-offset:-2px;}',
      '.bsh-pv-ok{border-color:var(--neon);background:rgba(57,255,20,.26);box-shadow:inset 0 0 12px rgba(57,255,20,.3);}',
      '.bsh-pv-bad{border-color:var(--danger);background:rgba(255,77,109,.26);}',
      /* --- kleines eigenes Raster --- */
      '.bsh-mini{grid-template-columns:8px 1fr;grid-template-rows:8px 1fr;gap:2px;}',
      '.bsh-mini .bsh-cols,.bsh-mini .bsh-rows,.bsh-mini .bsh-grid{gap:2px;}',
      '.bsh-mini .bsh-cols span,.bsh-mini .bsh-rows span{font-size:6px;}',
      '.bsh-mini .bsh-cell{border-radius:3px;font-size:0;}',
      '.bsh-bottom{display:flex;gap:10px;align-items:flex-start;}',
      '.bsh-minecol{flex:0 0 44%;max-width:148px;display:flex;flex-direction:column;gap:5px;}',
      '.bsh-infocol{flex:1;min-width:0;display:flex;flex-direction:column;gap:7px;}',
      /* --- Flotten-Chips + Log --- */
      '.bsh-fleet{display:flex;gap:4px;flex-wrap:wrap;}',
      '.bsh-fleet-c{justify-content:center;}',
      '.bsh-chip{font-size:10px;font-weight:800;padding:2px 7px;border-radius:999px;white-space:nowrap;',
      'background:rgba(9,32,21,.8);border:1px solid var(--stroke);color:var(--leaf);transition:.15s;}',
      '.bsh-chip.cur{border-color:var(--neon);color:var(--neon);box-shadow:0 0 10px var(--stroke-2);}',
      '.bsh-chip.set{opacity:.6;}',
      '.bsh-chip.dead{border-color:var(--danger);color:var(--danger);background:rgba(60,6,16,.75);text-decoration:line-through;}',
      '.bsh-log{display:flex;flex-direction:column;gap:3px;}',
      '.bsh-log-l{font-size:11px;font-weight:700;line-height:1.3;color:var(--muted);animation:bsh-in .28s ease;}',
      '.bsh-log-l.h{color:var(--neon);}',
      '.bsh-log-l.l{color:var(--danger);}',
      '.bsh-log-l.w{color:var(--aqua-soft);}',
      /* --- Bedienung --- */
      '.bsh-row{gap:6px;flex-wrap:nowrap;}',
      '.bsh-b{flex:1;min-width:0;font-size:12px;padding:9px 4px;}',
      '.bsh-ready{width:100%;}',
      '.bsh-wait{text-align:center;font-size:12px;font-weight:800;color:var(--aqua);min-height:16px;}',
      '.bsh-hint{font-size:11px;text-align:center;margin:0;}',
      '.bsh-levels{display:flex;gap:6px;align-items:center;justify-content:center;flex-wrap:wrap;}',
      '.bsh-lv-l{font-size:11px;font-weight:800;color:var(--muted);text-transform:uppercase;letter-spacing:1px;}',
      '.bsh-lv{cursor:pointer;font-size:11px;}',
      '.bsh-lv.active{border-color:var(--neon);color:var(--neon);box-shadow:0 0 10px var(--stroke-2);}',
      /* --- Panels --- */
      '.bsh-panel{padding:28px 20px;text-align:center;display:flex;flex-direction:column;gap:12px;align-items:center;width:100%;max-width:340px;margin:0 auto;}',
      '.bsh-panel-icon{font-size:46px;line-height:1;filter:drop-shadow(0 0 12px var(--stroke-2));animation:bsh-float 2.8s ease-in-out infinite;}',
      '.bsh-big{font-size:clamp(22px,7vw,32px);font-weight:900;margin:0;line-height:1.1;}',
      '.bsh-waitbox{display:flex;flex-direction:column;gap:6px;align-items:center;}',
      '.bsh-waitbox p{margin:0;}',
      /* --- Animationen --- */
      '@keyframes bsh-splash{0%{transform:scale(.5);opacity:.3;}60%{transform:scale(1.15);}100%{transform:scale(1);opacity:1;}}',
      '@keyframes bsh-boom{0%{transform:scale(.4);filter:brightness(2.4);}55%{transform:scale(1.25);}100%{transform:scale(1);filter:brightness(1);}}',
      '@keyframes bsh-sink{0%{transform:scale(1.3) rotate(-8deg);filter:brightness(2);}100%{transform:scale(1) rotate(0);filter:brightness(1);}}',
      '@keyframes bsh-ping{0%,100%{box-shadow:0 0 6px rgba(51,230,208,.35);transform:scale(1);}50%{box-shadow:0 0 16px rgba(51,230,208,.8);transform:scale(1.07);}}',
      '@keyframes bsh-in{from{opacity:0;transform:translateY(-4px);}to{opacity:1;transform:translateY(0);}}',
      '@keyframes bsh-float{0%,100%{transform:translateY(0);}50%{transform:translateY(-6px);}}',
      '@keyframes bsh-shake{0%,100%{transform:translateX(0);}25%{transform:translateX(-6px);}75%{transform:translateX(6px);}}'
    ].join(''));
  }
})();
