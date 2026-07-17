/* ludo.js — "Ärgere dich": Mensch-ärgere-dich-nicht im Neon-Dschungel.
 *
 * IDEE:      Kreuzförmiges 11x11-Brett (Canvas), 2–4 Farben mit je 4 Figuren.
 *            Mit einer 6 kommt eine Figur aus dem Haus (und man darf nochmal
 *            würfeln). Wer auf einer gegnerischen Figur landet, schickt sie
 *            zurück ins Haus. Wer zuerst alle 4 Figuren ins Ziel bringt, gewinnt.
 * STEUERUNG: 🎲-Würfel antippen bzw. "Würfeln"-Knopf. Danach leuchten alle
 *            möglichen Züge auf — die gewünschte Figur (oder ihr Zielfeld)
 *            antippen. Gibt es nur einen Zug, wird er automatisch gespielt.
 *            Alles per Touch bedienbar (pointerdown auf dem Canvas).
 * PUNKTE:    Solo = 250 pro Figur im Ziel + Fortschritt (3/Feld) + Tempo-Bonus
 *            bei Sieg (max(100, 900 − Würfe×6)). Bestwert unter 'best_ludo'.
 *            Multi = Fortschritts-Punkte (Feld+1, Ziel = 50, max 200), der
 *            Sieger bekommt +1000, damit er sicher oben auf dem Podest steht.
 * SYNC:      Rundenbasiert über room.shared. Der Zustand liegt als kompakte
 *            Strings in shared (ludBoard/ludOwn) + Zahlen (ludTurn/ludDice/
 *            ludPhase/ludTries/ludWin/ludSeq). Wer dran ist, würfelt und zieht
 *            selbst per setShared; der Host initialisiert den Tisch, spielt
 *            alle Bot-Sitze und übernimmt Sitze von Spielern, die gehen oder
 *            nicht reagieren (Watchdog). Alle Clients rechnen die erlaubten
 *            Züge aus derselben reinen Funktion → überall identisch.
 * cleanup(): stoppt rAF, alle Timer/Intervalle, Listener und room.off(). */
(function () {
  'use strict';
  window.App = window.App || {}; App.Minigames = App.Minigames || {};
  var UI = App.UI, el = UI.el;

  injectStyle();

  /* ===================== Brett-Geometrie (11x11) ===================== */
  var CELL = 60, SZ = 11 * CELL, TAU = Math.PI * 2;
  var R = 19;                       // Figuren-Radius (virtuelle px)

  /* Die 40 Felder der Laufbahn, im Uhrzeigersinn ab dem Startfeld von Farbe 0. */
  var TRACK = [
    [0, 4], [1, 4], [2, 4], [3, 4], [4, 4],
    [4, 3], [4, 2], [4, 1], [4, 0],
    [5, 0],
    [6, 0], [6, 1], [6, 2], [6, 3], [6, 4],
    [7, 4], [8, 4], [9, 4], [10, 4],
    [10, 5],
    [10, 6], [9, 6], [8, 6], [7, 6], [6, 6],
    [6, 7], [6, 8], [6, 9], [6, 10],
    [5, 10],
    [4, 10], [4, 9], [4, 8], [4, 7], [4, 6],
    [3, 6], [2, 6], [1, 6], [0, 6],
    [0, 5]
  ];
  var START = [0, 10, 20, 30];      // Startfeld-Index je Farbe
  var GOALS = [
    [[1, 5], [2, 5], [3, 5], [4, 5]],
    [[5, 1], [5, 2], [5, 3], [5, 4]],
    [[9, 5], [8, 5], [7, 5], [6, 5]],
    [[5, 9], [5, 8], [5, 7], [5, 6]]
  ];
  var HOMES = [
    [[0, 0], [1, 0], [0, 1], [1, 1]],
    [[9, 0], [10, 0], [9, 1], [10, 1]],
    [[9, 9], [10, 9], [9, 10], [10, 10]],
    [[0, 9], [1, 9], [0, 10], [1, 10]]
  ];
  var COL = ['#39ff14', '#33e6d0', '#ffd23f', '#ff4d6d'];
  var COLNAME = ['Grün', 'Türkis', 'Gold', 'Pink'];
  var ORDER4 = [0, 1, 2, 3];
  var PIPS = { 1: [4], 2: [0, 8], 3: [0, 4, 8], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8] };
  var ROLL_MS = 720;                // Dauer der Würfel-Animation

  function cellXY(cell) { return { x: cell[0] * CELL + CELL / 2, y: cell[1] * CELL + CELL / 2 }; }
  function pieceCell(c, p) {
    if (p.st === 'h') return HOMES[c][p.v];
    if (p.st === 't') return TRACK[(START[c] + p.v) % 40];
    return GOALS[c][p.v];
  }

  /* ===================== reine Spiel-Logik ===================== */
  function newBoard() {
    var b = [], c, i;
    for (c = 0; c < 4; c++) { var seat = []; for (i = 0; i < 4; i++) seat.push({ st: 'h', v: i }); b.push(seat); }
    return b;
  }
  function cloneBoard(b) {
    return b.map(function (seat) { return seat.map(function (p) { return { st: p.st, v: p.v }; }); });
  }
  function encodeBoard(b) {
    var out = [], c, i;
    for (c = 0; c < 4; c++) { var s = []; for (i = 0; i < 4; i++) s.push(b[c][i].st + b[c][i].v); out.push(s.join(',')); }
    return out.join('|');
  }
  function decodeBoard(str) {
    var b = [], parts = String(str || '').split('|'), c, i;
    for (c = 0; c < 4; c++) {
      var ps = String(parts[c] || 'h0,h1,h2,h3').split(','), seat = [];
      for (i = 0; i < 4; i++) {
        var t = ps[i] || ('h' + i), st = t.charAt(0), v = parseInt(t.slice(1), 10);
        if (st !== 'h' && st !== 't' && st !== 'g') st = 'h';
        seat.push({ st: st, v: isNaN(v) ? i : v });
      }
      b.push(seat);
    }
    return b;
  }
  function pieceOnTrackPos(board, c, pos) {
    for (var i = 0; i < 4; i++) { var p = board[c][i]; if (p.st === 't' && p.v === pos) return i; }
    return -1;
  }
  function goalBlocked(board, c, fromSlot, toSlot) {
    for (var i = 0; i < 4; i++) { var p = board[c][i]; if (p.st === 'g' && p.v > fromSlot && p.v <= toSlot) return true; }
    return false;
  }
  function countOnTrack(board, c) { var n = 0; for (var i = 0; i < 4; i++) if (board[c][i].st === 't') n++; return n; }
  function countGoal(board, c) { var n = 0; for (var i = 0; i < 4; i++) if (board[c][i].st === 'g') n++; return n; }
  function hasWon(board, c) { return countGoal(board, c) === 4; }
  function freeHomeSlot(board, c) {
    for (var s = 0; s < 4; s++) {
      var used = false;
      for (var i = 0; i < 4; i++) if (board[c][i].st === 'h' && board[c][i].v === s) used = true;
      if (!used) return s;
    }
    return 0;
  }

  /* Alle erlaubten Züge für Farbe c bei Augenzahl dice — rein, überall gleich. */
  function movesFor(board, c, dice) {
    var res = [], i, p, homeCount = 0;
    if (!dice) return res;
    for (i = 0; i < 4; i++) if (board[c][i].st === 'h') homeCount++;
    for (i = 0; i < 4; i++) {
      p = board[c][i];
      if (p.st === 'h') {
        if (dice !== 6) continue;
        if (pieceOnTrackPos(board, c, 0) >= 0) continue;      // eigene Figur blockiert das Startfeld
        res.push({ pi: i, kind: 'out', to: { st: 't', v: 0 } });
      } else if (p.st === 't') {
        var np = p.v + dice;
        if (np <= 39) {
          if (pieceOnTrackPos(board, c, np) >= 0) continue;    // nie auf eigene Figur
          res.push({ pi: i, kind: 'move', to: { st: 't', v: np } });
        } else {
          var slot = np - 40;                                  // Ziel nur mit exakter Zahl
          if (slot > 3) continue;
          if (goalBlocked(board, c, -1, slot)) continue;       // im Ziel wird nicht übersprungen
          res.push({ pi: i, kind: 'goal', to: { st: 'g', v: slot } });
        }
      } else {
        var ns = p.v + dice;
        if (ns > 3) continue;
        if (goalBlocked(board, c, p.v, ns)) continue;
        res.push({ pi: i, kind: 'goalmove', to: { st: 'g', v: ns } });
      }
    }
    /* Zugzwang bei einer 6: erst raus aus dem Haus … */
    if (dice === 6 && homeCount > 0) {
      var outs = res.filter(function (m) { return m.kind === 'out'; });
      if (outs.length) return [outs[0]];
      /* … und wenn das eigene Startfeld belegt ist, muss diese Figur weichen. */
      var blocker = pieceOnTrackPos(board, c, 0);
      if (blocker >= 0) {
        var bm = res.filter(function (m) { return m.pi === blocker; });
        if (bm.length) return bm;
      }
    }
    return res;
  }

  /* Führt den Zug auf board aus (mutiert!) und gibt eine geschlagene Figur zurück. */
  function applyMove(board, order, c, m) {
    var captured = null, oi, j;
    var p = board[c][m.pi];
    if (m.to.st === 't') {
      var abs = (START[c] + m.to.v) % 40;
      for (oi = 0; oi < order.length; oi++) {
        var oc = order[oi];
        if (oc === c) continue;
        for (j = 0; j < 4; j++) {
          var q = board[oc][j];
          if (q.st === 't' && (START[oc] + q.v) % 40 === abs) {
            captured = { c: oc, pi: j, pos: q.v };
            q.st = 'h'; q.v = freeHomeSlot(board, oc);
          }
        }
      }
    }
    p.st = m.to.st; p.v = m.to.v;
    return captured;
  }

  function progressScore(board, c) {
    var s = 0;
    for (var i = 0; i < 4; i++) {
      var p = board[c][i];
      if (p.st === 't') s += p.v + 1; else if (p.st === 'g') s += 50;
    }
    return s;                                   // 0 … 200
  }

  /* ===================== Bot-KI ===================== */
  /* Wie viele Gegner können das Feld pos (aus Sicht von c) im nächsten Wurf treffen? */
  function threatCount(board, order, c, pos) {
    var abs = (START[c] + pos) % 40, n = 0, oi, j;
    for (oi = 0; oi < order.length; oi++) {
      var oc = order[oi];
      if (oc === c) continue;
      var homeCounted = false;
      for (j = 0; j < 4; j++) {
        var q = board[oc][j];
        if (q.st === 't') {
          var d = (abs - (START[oc] + q.v) + 40) % 40;
          if (d >= 1 && d <= 6 && q.v + d <= 39) n += 1;       // erreichbar und nicht schon im Ziel-Arm
        } else if (q.st === 'h' && !homeCounted && abs === START[oc]) {
          n += 0.6; homeCounted = true;                        // Gegner kann mit 6 auf sein Startfeld
        }
      }
    }
    return n;
  }

  function evalMove(board, order, c, m, dice, dangerW) {
    var b = cloneBoard(board);
    var before = board[c][m.pi];
    var beforeSt = before.st, beforeV = before.v;
    var cap = applyMove(b, order, c, m);
    var s = 0;
    if (cap) s += 70 + cap.pos;                                // je weiter der Gegner war, desto süßer
    if (m.kind === 'goal') s += 60 + (3 - m.to.v) * 3;         // ab ins Ziel
    if (m.kind === 'goalmove') s += 12;
    if (m.kind === 'out') { s += 35; if (countOnTrack(board, c) === 0) s += 20; }
    if (m.to.st === 't') s += m.to.v * 0.2;                    // Vorhut nach vorne
    s += dice * 0.4;
    if (dangerW) {
      if (beforeSt === 't') s += dangerW * threatCount(board, order, c, beforeV) * 0.8;   // Flucht belohnen
      if (m.to.st === 't') s -= dangerW * threatCount(b, order, c, m.to.v);               // nicht ins Messer laufen
    }
    return s;
  }

  /* level: 0 = leicht, 1 = normal, 2 = schwer */
  function botPick(board, order, c, dice, level) {
    var ms = movesFor(board, c, dice);
    if (!ms.length) return null;
    if (ms.length === 1) return ms[0];
    var rnd = level === 0 ? 0.5 : level === 1 ? 0.15 : 0;
    if (Math.random() < rnd) return ms[Math.floor(Math.random() * ms.length)];
    var dangerW = level === 0 ? 0 : level === 1 ? 12 : 26;
    var best = ms[0], bestS = -1e9;
    ms.forEach(function (m) {
      var v = evalMove(board, order, c, m, dice, dangerW);
      if (v > bestS) { bestS = v; best = m; }
    });
    return best;
  }

  /* ===================== Farb-Helfer ===================== */
  function hex2rgb(h) {
    return [parseInt(h.substr(1, 2), 16), parseInt(h.substr(3, 2), 16), parseInt(h.substr(5, 2), 16)];
  }
  function rgba(h, a) { var c = hex2rgb(h); return 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + a + ')'; }
  function mix(h1, h2, t) {
    var a = hex2rgb(h1), b = hex2rgb(h2);
    return 'rgb(' + Math.round(a[0] + (b[0] - a[0]) * t) + ',' + Math.round(a[1] + (b[1] - a[1]) * t) + ',' + Math.round(a[2] + (b[2] - a[2]) * t) + ')';
  }

  /* ============================================================== */
  App.Minigames.ludo = {
    id: 'ludo', title: 'Ärgere dich', icon: '🎲', order: 164,
    subtitle: 'Würfeln, rauswerfen, ärgern — alle 4 ins Ziel',
    single: true, multi: true, minPlayers: 2, maxPlayers: 4,

    render: function (root, ctx) {
      var isMulti = ctx.mode === 'multi';
      var room = isMulti ? ctx.room : null;
      var myKey = isMulti ? ctx.me.id : 'ME';

      /* ---- Laufzeit ---- */
      var dead = false, ended = false, built = false;
      var timers = [], stops = [], listeners = [], raf = null, diceTimer = null;
      var st = null, order = ORDER4, seatOwner = null, myColor = -1, botLevel = 1;
      var viewBoard = null, anims = {}, lastRollSeq = -1, actedSeq = -1, diceReadyAt = 0, rolling = false;
      var lastShared = null, initDone = false, lastReported = -1, soloRolls = 0;
      var canvas = null, ctx2d = null, statusEl = null, diceEl = null, rollBtn = null, seatEls = [];

      function after(ms, fn) { var t = setTimeout(function () { if (!dead) fn(); }, ms); timers.push(t); return t; }
      function clearTimers() { timers.forEach(clearTimeout); timers = []; }
      function addL(t, ty, fn, o) { t.addEventListener(ty, fn, o); listeners.push({ t: t, ty: ty, fn: fn, o: o }); }
      function cleanup() {
        dead = true;
        clearTimers();
        if (raf) { cancelAnimationFrame(raf); raf = null; }
        if (diceTimer) { clearInterval(diceTimer); diceTimer = null; }
        stops.forEach(function (f) { try { f(); } catch (e) {} }); stops = [];
        listeners.forEach(function (l) { try { l.t.removeEventListener(l.ty, l.fn, l.o); } catch (e) {} }); listeners = [];
      }

      if (isMulti) startMulti(); else showSetup();
      return { cleanup: cleanup };

      /* ===================== SOLO ===================== */
      function showSetup() {
        var bots = App.Storage.get('lud_bots', 2), level = App.Storage.get('lud_level', 1);
        if (bots < 1 || bots > 3) bots = 2;
        if (level < 0 || level > 2) level = 1;
        var botBtns = [], lvlBtns = [];

        function paintOpts() {
          botBtns.forEach(function (b, i) { b.classList.toggle('is-on', (i + 1) === bots); });
          lvlBtns.forEach(function (b, i) { b.classList.toggle('is-on', i === level); });
        }
        [1, 2, 3].forEach(function (n) {
          botBtns.push(el('button', {
            class: 'chip lud-opt', type: 'button',
            onclick: function () { bots = n; if (App.Audio) App.Audio.sfx('click'); paintOpts(); }
          }, [n + ' Bot' + (n > 1 ? 's' : '')]));
        });
        ['Leicht', 'Normal', 'Schwer'].forEach(function (t, i) {
          lvlBtns.push(el('button', {
            class: 'chip lud-opt', type: 'button',
            onclick: function () { level = i; if (App.Audio) App.Audio.sfx('click'); paintOpts(); }
          }, [t]));
        });
        var best = App.Storage.get('best_ludo', 0);
        root.innerHTML = '';
        root.appendChild(el('div', { class: 'glass lud-setup' }, [
          el('div', { class: 'lud-setup-icon' }, ['🎲']),
          el('h2', { class: 'neon' }, ['Ärgere dich']),
          el('p', { class: 'hint-text' }, ['Bring alle 4 Figuren ins Ziel — mit einer 6 kommst du raus und darfst nochmal.']),
          el('div', { class: 'lud-opt-l' }, ['Gegner']),
          el('div', { class: 'lud-opt-row' }, botBtns),
          el('div', { class: 'lud-opt-l' }, ['Schwierigkeit']),
          el('div', { class: 'lud-opt-row' }, lvlBtns),
          el('p', { class: 'hint-text' }, ['🏆 Bestwert: ' + App.MG.fmt(best)]),
          el('div', { class: 'controls-row' }, [
            el('button', {
              class: 'btn btn-primary btn-lg', type: 'button',
              onclick: function () {
                App.Storage.set('lud_bots', bots); App.Storage.set('lud_level', level);
                if (App.Audio) App.Audio.sfx('start');
                startSolo(bots, level);
              }
            }, ['Spiel starten']),
            el('button', { class: 'btn btn-ghost btn-lg', type: 'button', onclick: ctx.onExit }, ['Zurück'])
          ])
        ]));
        paintOpts();
      }

      function startSolo(botCount, level) {
        clearTimers();
        botLevel = level;
        ended = false; soloRolls = 0; lastRollSeq = -1; actedSeq = -1; diceReadyAt = 0;
        order = botCount === 1 ? [0, 2] : botCount === 2 ? [0, 1, 2] : [0, 1, 2, 3];
        seatOwner = ['ME'];
        for (var i = 0; i < botCount; i++) seatOwner.push('BOT');
        myColor = 0;
        st = { board: newBoard(), turnI: 0, dice: 0, phase: 'roll', tries: 3, msg: 'Du beginnst — würfle!', winner: -1, seq: 1 };
        buildView();
        sync();
      }

      /* ===================== MULTI ===================== */
      /* Sichere Server-Uhr: room.now() liefert nicht bei jedem Backend eine Zahl
       * (net.js FirebaseBackend.serverTime() gibt den Schreib-Sentinel
       * ServerValue.TIMESTAMP = {".sv":"timestamp"} zurück). Damit würde jede
       * Rechnung NaN ergeben und der Countdown nie ablaufen → dann die lokale
       * Uhr nehmen. Der Rundenablauf selbst hängt nicht an dieser Uhr, sondern
       * an room.shared, ist also in jedem Fall bei allen gleich. */
      function netNow() {
        var n = room ? room.now() : Date.now();
        return (typeof n === 'number' && isFinite(n)) ? n : Date.now();
      }
      function startMulti() {
        order = ORDER4;
        room.on('shared', onShared);
        room.on('players', onPlayers);
        stops.push(function () { room.off('shared', onShared); room.off('players', onPlayers); });

        var snap = room.snapshot() || {};
        var startAt = (snap.round && snap.round.startAt) || (netNow() + 3000);
        stops.push(App.MG.countdown(root, startAt, function () { beginMulti(); }, netNow));
      }
      function beginMulti() {
        if (dead) return;
        lastShared = (room.snapshot() && room.snapshot().shared) || null;
        buildView();
        startWatchdog();
        syncMulti();
      }
      function onShared(sh) { if (dead) return; lastShared = sh; if (built) syncMulti(); }
      function onPlayers() {
        if (dead || !built) return;
        /* Der Host ersetzt Sitze von Spielern, die den Tisch verlassen haben, durch Bots. */
        if (room.isHost() && st && st.phase !== 'over' && seatOwner) {
          var real = room.players(), ow = seatOwner.slice(), changed = false, i;
          for (i = 0; i < ow.length; i++) {
            if (ow[i] !== 'BOT' && !findReal(real, ow[i])) { ow[i] = 'BOT'; changed = true; }
          }
          if (changed) {
            room.setShared({ ludOwn: ow.join(','), ludMsg: 'Ein Spieler hat den Tisch verlassen — ein Bot übernimmt.', ludSeq: st.seq + 1 });
          }
        }
        updateChrome();
      }
      function findReal(list, id) {
        for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
        return null;
      }
      function initShared() {
        var players = room.players(), owners = [], i;
        for (i = 0; i < 4; i++) owners.push(players[i] ? players[i].id : 'BOT');
        var init = {
          ludOwn: owners.join(','), ludBoard: encodeBoard(newBoard()),
          ludTurn: 0, ludDice: 0, ludPhase: 'roll', ludTries: 3,
          ludMsg: 'Los geht\'s — ' + (players[0] ? players[0].name : 'Grün') + ' beginnt!',
          ludWin: -1, ludSeq: 1
        };
        room.setShared(init);
        /* Auch hier nicht auf das Echo warten (unter file:// läuft das lokale
         * Backend, das eigene Schreibvorgänge nicht an den Schreiber meldet —
         * sonst bliebe der Host ewig bei "Tisch wird aufgebaut" hängen). */
        lastShared = Object.assign({}, lastShared || {}, init);
        syncMulti();
      }
      function fromShared(sh) {
        if (!sh || !sh.ludBoard || !sh.ludOwn) return null;
        var ow = String(sh.ludOwn).split(',');
        while (ow.length < 4) ow.push('BOT');
        return {
          owners: ow, board: decodeBoard(sh.ludBoard),
          turnI: sh.ludTurn | 0, dice: sh.ludDice | 0,
          phase: sh.ludPhase === 'move' || sh.ludPhase === 'over' ? sh.ludPhase : 'roll',
          tries: sh.ludTries | 0, msg: String(sh.ludMsg || ''),
          winner: (sh.ludWin === null || sh.ludWin === undefined) ? -1 : (sh.ludWin | 0),
          seq: sh.ludSeq | 0
        };
      }
      function syncMulti() {
        if (dead) return;
        var s = fromShared(lastShared);
        if (!s) {
          if (room.isHost() && !initDone && room.players().length >= 1) { initDone = true; initShared(); }
          setStatus('Der Tisch wird aufgebaut …', 'wait');
          return;
        }
        seatOwner = s.owners;
        myColor = seatOwner.indexOf(ctx.me.id) >= 0 ? order[seatOwner.indexOf(ctx.me.id)] : -1;
        /* Veraltetes Echo (z. B. der Rücklauf des eigenen, schon lokal
         * angewendeten Zuges) darf den Stand nicht zurückdrehen. */
        if (st && s.seq < st.seq) { updateChrome(); return; }
        st = { board: s.board, turnI: s.turnI, dice: s.dice, phase: s.phase, tries: s.tries, msg: s.msg, winner: s.winner, seq: s.seq };
        sync();
      }

      /* Falls ein Mensch 25 s nicht reagiert, spielt der Host für ihn weiter. */
      function startWatchdog() {
        var wdSeq = -1, wdAt = Date.now();
        var iv = setInterval(function () {
          if (dead || !st || st.phase === 'over' || !room.isHost()) return;
          if (st.seq !== wdSeq) { wdSeq = st.seq; wdAt = Date.now(); return; }
          if (Date.now() - wdAt < 25000) return;
          wdAt = Date.now();
          if (isBotSeat(st.turnI)) return;                     // Bots treibt der Host ohnehin
          if (st.phase === 'roll') { doRoll(); return; }
          var c = order[st.turnI], ms = movesFor(st.board, c, st.dice);
          if (ms.length) doMove(botPick(st.board, order, c, st.dice, 1)); else afterRollNoMoves();
        }, 2000);
        stops.push(function () { clearInterval(iv); });
      }

      /* ===================== Sitz-Helfer ===================== */
      function ownerOf(pos) { return (seatOwner && seatOwner[pos]) || 'BOT'; }
      function isBotSeat(pos) { return ownerOf(pos) === 'BOT'; }
      function isHumanSeat(pos) { return ownerOf(pos) === myKey; }
      function iDrive(pos) {
        if (!isMulti) return true;                              // Solo: alles lokal
        return ownerOf(pos) === ctx.me.id || (isBotSeat(pos) && room.isHost());
      }
      function seatName(pos) {
        var c = order[pos], own = ownerOf(pos);
        if (own === 'BOT') return 'Bot ' + COLNAME[c];
        if (!isMulti) return 'Du';
        var p = findReal(room.players(), own);
        return p ? p.name : 'Spieler';
      }
      /* Name zu einer Farbe (für Sieger-Meldungen) — echter Spieler- bzw. Bot-Name. */
      function nameOfColor(c) {
        for (var i = 0; i < order.length; i++) if (order[i] === c) return seatName(i);
        return COLNAME[c] || 'Spieler';
      }
      function myTurnNow() {
        return !!st && st.phase === 'move' && myColor >= 0 && isHumanSeat(st.turnI) && Date.now() >= diceReadyAt;
      }
      function curMoves() {
        if (!st || st.phase !== 'move') return [];
        return movesFor(st.board, order[st.turnI], st.dice);
      }

      /* ===================== Zustands-Änderungen ===================== */
      function push(patch) {
        if (dead || !st) return;
        if (isMulti) {
          var p = {};
          if (patch.board) p.ludBoard = encodeBoard(patch.board);
          if (patch.hasOwnProperty('turnI')) p.ludTurn = patch.turnI;
          if (patch.hasOwnProperty('dice')) p.ludDice = patch.dice;
          if (patch.hasOwnProperty('phase')) p.ludPhase = patch.phase;
          if (patch.hasOwnProperty('tries')) p.ludTries = patch.tries;
          if (patch.hasOwnProperty('msg')) p.ludMsg = patch.msg;
          if (patch.hasOwnProperty('winner')) p.ludWin = patch.winner;
          p.ludSeq = (st.seq || 0) + 1;
          room.setShared(p);
        }
        /* Immer sofort auch lokal anwenden: der eigene Zug soll ohne Netz-Umweg
         * sichtbar sein, und nicht jedes Backend spiegelt eigene Schreibvorgänge
         * zurück (net.js LocalBackend meldet per BroadcastChannel nur an ANDERE
         * Tabs). sync() ist idempotent, das spätere Echo ändert also nichts mehr. */
        applyLocal(patch);
      }
      function applyLocal(patch) {
        if (patch.board) st.board = patch.board;
        ['turnI', 'dice', 'phase', 'tries', 'msg', 'winner'].forEach(function (k) {
          if (patch.hasOwnProperty(k)) st[k] = patch[k];
        });
        st.seq = (st.seq || 0) + 1;
        sync();
      }

      function doRoll() {
        if (dead || !st || st.phase !== 'roll') return;
        var d = 1 + Math.floor(Math.random() * 6);
        if (!isMulti && st.turnI === 0) soloRolls++;
        push({ dice: d, phase: 'move', tries: Math.max(0, (st.tries | 0) - 1), msg: seatName(st.turnI) + ' würfelt eine ' + d });
      }

      function afterRollNoMoves() {
        if (dead || !st || st.phase !== 'move') return;
        var nm = seatName(st.turnI);
        if (st.dice === 6) {
          push({ phase: 'roll', tries: 1, msg: nm + ': kein Zug möglich — Extrawurf für die 6' });
        } else if ((st.tries | 0) > 0) {
          push({ phase: 'roll', msg: nm + ': kein Zug möglich — noch ' + st.tries + ' Versuch' + (st.tries > 1 ? 'e' : '') });
        } else {
          nextTurn(st.board, nm + ': kein Zug möglich');
        }
      }

      function nextTurn(board, why) {
        var ni = (st.turnI + 1) % order.length;
        var tries = countOnTrack(board, order[ni]) === 0 ? 3 : 1;
        push({ turnI: ni, phase: 'roll', tries: tries, msg: (why ? why + ' · ' : '') + seatName(ni) + ' ist dran' });
      }

      function doMove(m) {
        if (dead || !st || !m || st.phase !== 'move') return;
        var pos = st.turnI, c = order[pos];
        var b = cloneBoard(st.board);
        var cap = applyMove(b, order, c, m);
        var nm = seatName(pos), msg;
        if (cap) {
          var vp = -1;
          for (var k = 0; k < order.length; k++) if (order[k] === cap.c) vp = k;
          msg = '💥 ' + nm + ' wirft ' + (vp >= 0 ? seatName(vp) : COLNAME[cap.c]) + ' raus!';
        } else if (m.kind === 'out') msg = nm + ' kommt aus dem Haus';
        else if (m.kind === 'goal') msg = '🎯 ' + nm + ': Figur im Ziel!';
        else msg = nm + ' zieht ' + st.dice;

        if (hasWon(b, c)) {
          push({ board: b, phase: 'over', winner: c, msg: '🏆 ' + nm + ' hat alle Figuren im Ziel!' });
          return;
        }
        if (st.dice === 6) {
          push({ board: b, turnI: pos, phase: 'roll', tries: 1, msg: msg + ' · Extrawurf für die 6' });
        } else {
          var ni = (pos + 1) % order.length;
          var tries = countOnTrack(b, order[ni]) === 0 ? 3 : 1;
          push({ board: b, turnI: ni, phase: 'roll', tries: tries, msg: msg + ' · ' + seatName(ni) + ' ist dran' });
        }
      }

      /* ===================== Sync / Ablauf-Steuerung ===================== */
      function sync() {
        if (dead || !st || !built) return;
        applyAnims(viewBoard, st.board);
        viewBoard = cloneBoard(st.board);
        if (st.phase === 'move' && st.seq !== lastRollSeq) { lastRollSeq = st.seq; animateDice(st.dice); }
        updateChrome();
        reportMyScore();
        tick();
      }

      function tick() {
        if (!st) return;
        if (st.phase === 'over') {
          if (!ended) { ended = true; after(1500, finish); }
          return;
        }
        var pos = st.turnI;
        if (!iDrive(pos)) return;
        if (actedSeq === st.seq) return;
        actedSeq = st.seq;
        var sq = st.seq, wait = Math.max(0, diceReadyAt - Date.now());

        if (st.phase === 'roll') {
          if (isHumanSeat(pos)) return;                          // Mensch klickt selbst
          after(wait + 620, function () { if (st && st.seq === sq && st.phase === 'roll') doRoll(); });
          return;
        }
        var c = order[pos], ms = movesFor(st.board, c, st.dice);
        if (!ms.length) {
          after(wait + 950, function () { if (st && st.seq === sq && st.phase === 'move') afterRollNoMoves(); });
          return;
        }
        if (isHumanSeat(pos)) {
          if (ms.length === 1) after(wait + 520, function () { if (st && st.seq === sq && st.phase === 'move') doMove(ms[0]); });
          return;
        }
        after(wait + 800, function () {
          if (!st || st.seq !== sq || st.phase !== 'move') return;
          doMove(botPick(st.board, order, c, st.dice, isMulti ? 1 : botLevel));
        });
      }

      function reportMyScore() {
        if (!isMulti || myColor < 0 || !st) return;
        var s = progressScore(st.board, myColor);
        if (s === lastReported) return;
        lastReported = s;
        room.reportScore(s);
      }

      /* ===================== Ansicht ===================== */
      function buildView() {
        built = true;
        seatEls = [];
        var seatsWrap = el('div', { class: 'lud-seats' });
        for (var i = 0; i < order.length; i++) {
          var dot = el('span', { class: 'lud-seat-dot' });
          dot.style.background = COL[order[i]];
          dot.style.boxShadow = '0 0 8px ' + rgba(COL[order[i]], 0.9);
          var nm = el('span', { class: 'lud-seat-nm' }, ['…']);
          var go = el('span', { class: 'lud-seat-go' }, ['0/4']);
          var chip = el('div', { class: 'lud-seat' }, [dot, nm, go]);
          seatEls.push({ root: chip, nm: nm, go: go });
          seatsWrap.appendChild(chip);
        }

        canvas = el('canvas', { class: 'lud-canvas', width: SZ, height: SZ });
        ctx2d = canvas.getContext('2d');
        statusEl = el('div', { class: 'lud-status' }, ['']);
        diceEl = buildDice();
        rollBtn = el('button', { class: 'btn btn-primary lud-roll', type: 'button', onclick: onRoll }, ['🎲 Würfeln']);

        var wrap = el('div', { class: 'lud-wrap' }, [
          el('div', { class: 'lud-top' }, [
            el('div', { class: 'lud-brand neon' }, ['🎲 Ärgere dich']),
            el('div', { class: 'lud-mode' }, [isMulti ? 'Online-Tisch' : 'Solo'])
          ]),
          seatsWrap,
          statusEl,
          el('div', { class: 'lud-stage' }, [canvas]),
          el('div', { class: 'lud-bar' }, [diceEl, rollBtn]),
          el('p', { class: 'lud-hint hint-text' }, ['Mit einer 6 kommt eine Figur raus und du darfst nochmal · Gegner treffen = ab ins Haus · alle 4 ins Ziel gewinnt · Figur oder Zielfeld antippen'])
        ]);
        root.innerHTML = ''; root.appendChild(wrap);

        addL(canvas, 'pointerdown', onTap, { passive: false });
        viewBoard = null; anims = {}; setFace(1); diceEl.classList.add('is-idle');
        if (raf) cancelAnimationFrame(raf);
        raf = requestAnimationFrame(draw);
      }

      function buildDice() {
        var pips = [];
        for (var i = 0; i < 9; i++) pips.push(el('span', { class: 'lud-pip' }));
        return el('button', { class: 'lud-dice', type: 'button', 'aria-label': 'Würfel', onclick: onRoll }, pips);
      }
      function setFace(n) {
        if (!diceEl) return;
        var on = PIPS[n] || [], kids = diceEl.childNodes;
        for (var i = 0; i < 9; i++) kids[i].className = 'lud-pip' + (on.indexOf(i) >= 0 ? ' on' : '');
      }
      function animateDice(d) {
        if (!diceEl) return;
        if (diceTimer) { clearInterval(diceTimer); diceTimer = null; }
        rolling = true;
        diceReadyAt = Date.now() + ROLL_MS;
        diceEl.classList.remove('is-idle');
        diceEl.classList.add('is-rolling');
        if (App.Audio) App.Audio.sfx('roll');
        diceTimer = setInterval(function () {
          if (dead) { clearInterval(diceTimer); diceTimer = null; return; }
          if (Date.now() >= diceReadyAt) {
            clearInterval(diceTimer); diceTimer = null; rolling = false;
            diceEl.classList.remove('is-rolling');
            setFace(d);
            if (App.Audio) App.Audio.sfx(d === 6 ? 'ding' : 'tick');
            updateChrome();
            return;
          }
          setFace(1 + Math.floor(Math.random() * 6));
        }, 70);
      }

      function onRoll() {
        if (dead || !st || st.phase !== 'roll' || rolling) return;
        if (!isHumanSeat(st.turnI)) { if (App.Audio) App.Audio.sfx('error'); return; }
        if (App.Audio) App.Audio.sfx('click');
        doRoll();
      }

      function onTap(e) {
        if (e && e.preventDefault) e.preventDefault();
        if (!myTurnNow()) return;
        var ms = curMoves();
        if (!ms.length) return;
        var r = canvas.getBoundingClientRect();
        var vx = (e.clientX - r.left) / r.width * SZ, vy = (e.clientY - r.top) / r.height * SZ;
        var best = null, bd = CELL * 0.66;
        ms.forEach(function (m) {
          var a = cellXY(pieceCell(myColor, st.board[myColor][m.pi]));
          var b = cellXY(pieceCell(myColor, m.to));
          [a, b].forEach(function (pt) {
            var d = Math.sqrt((pt.x - vx) * (pt.x - vx) + (pt.y - vy) * (pt.y - vy));
            if (d < bd) { bd = d; best = m; }
          });
        });
        if (best) { if (App.Audio) App.Audio.sfx('select'); doMove(best); }
      }

      function setStatus(txt, cls) {
        if (!statusEl) return;
        statusEl.textContent = txt;
        statusEl.className = 'lud-status' + (cls ? ' ' + cls : '');
      }

      function updateChrome() {
        if (!built || !st) return;
        var i;
        for (i = 0; i < seatEls.length; i++) {
          var s = seatEls[i];
          s.nm.textContent = seatName(i) + (ownerOf(i) === myKey ? ' (du)' : '');
          s.go.textContent = countGoal(st.board, order[i]) + '/4';
          s.root.classList.toggle('active', st.phase !== 'over' && st.turnI === i);
          s.root.classList.toggle('me', ownerOf(i) === myKey);
        }
        var mine = st.phase !== 'over' && isHumanSeat(st.turnI);
        if (rollBtn) {
          var canRoll = mine && st.phase === 'roll' && !rolling;
          rollBtn.disabled = !canRoll;
          rollBtn.textContent = st.phase === 'roll' && mine
            ? ((st.tries | 0) > 1 ? '🎲 Würfeln (' + st.tries + ' Versuche)' : '🎲 Würfeln')
            : '🎲 Würfeln';
        }
        if (diceEl) diceEl.classList.toggle('is-idle', !rolling && st.phase === 'roll');
        var cls = st.phase === 'over' ? 'over' : (mine ? 'you' : 'opp');
        setStatus(st.msg || '', cls);
      }

      /* ---- Animationen aus dem Brett-Diff ---- */
      function pathPts(c, a, z) {
        var cells = [pieceCell(c, a)], p;
        if (z.st === 'h') cells.push(HOMES[c][z.v]);
        else if (a.st === 'h' && z.st === 't') cells.push(TRACK[START[c]]);
        else if (a.st === 't' && z.st === 't') { for (p = a.v + 1; p <= z.v; p++) cells.push(TRACK[(START[c] + p) % 40]); }
        else if (a.st === 't' && z.st === 'g') {
          for (p = a.v + 1; p <= 39; p++) cells.push(TRACK[(START[c] + p) % 40]);
          for (p = 0; p <= z.v; p++) cells.push(GOALS[c][p]);
        } else if (a.st === 'g' && z.st === 'g') { for (p = a.v + 1; p <= z.v; p++) cells.push(GOALS[c][p]); }
        else cells.push(pieceCell(c, z));
        return cells.map(cellXY);
      }
      function applyAnims(oldB, newB) {
        if (!oldB) return;
        var moved = false, capt = false, goaled = false, c, i;
        for (c = 0; c < 4; c++) {
          for (i = 0; i < 4; i++) {
            var a = oldB[c][i], z = newB[c][i];
            if (a.st === z.st && a.v === z.v) continue;
            var pts = pathPts(c, a, z);
            var toHome = (z.st === 'h' && a.st !== 'h');
            anims[c + '-' + i] = { pts: pts, t0: Date.now(), dur: toHome ? 420 : Math.max(220, (pts.length - 1) * 105), hop: toHome ? 34 : 9 };
            if (toHome) capt = true;
            else if (z.st === 'g' && a.st !== 'g') goaled = true;
            else moved = true;
          }
        }
        if (App.Audio) {
          if (capt) App.Audio.sfx('explosion');
          else if (goaled) App.Audio.sfx('levelup');
          else if (moved) App.Audio.sfx('step');
        }
      }
      function animPos(key, fallback) {
        var a = anims[key];
        if (!a) return fallback;
        var t = (Date.now() - a.t0) / a.dur;
        if (t >= 1) { delete anims[key]; return fallback; }
        var n = a.pts.length - 1;
        if (n <= 0) { delete anims[key]; return fallback; }
        var f = t * n, seg = Math.min(n - 1, Math.floor(f)), k = f - seg;
        var p0 = a.pts[seg], p1 = a.pts[seg + 1];
        return { x: p0.x + (p1.x - p0.x) * k, y: p0.y + (p1.y - p0.y) * k - Math.sin(k * Math.PI) * a.hop };
      }

      /* ---- Zeichnen ---- */
      function draw() {
        raf = requestAnimationFrame(draw);
        if (dead || !ctx2d) return;
        var g = ctx2d, now = Date.now();
        var pulse = 0.5 + 0.5 * Math.sin(now / 260);
        g.clearRect(0, 0, SZ, SZ);

        /* Grundlicht */
        var grd = g.createRadialGradient(SZ / 2, SZ / 2, 24, SZ / 2, SZ / 2, SZ * 0.64);
        grd.addColorStop(0, 'rgba(57,255,20,.11)');
        grd.addColorStop(1, 'rgba(0,0,0,0)');
        g.fillStyle = grd; g.fillRect(0, 0, SZ, SZ);

        var k, c;
        /* Haus-Quadranten der aktiven Farben */
        for (k = 0; k < order.length; k++) {
          c = order[k];
          var h0 = cellXY(HOMES[c][0]), h3 = cellXY(HOMES[c][3]);
          var x0 = Math.min(h0.x, h3.x) - CELL * 0.46, y0 = Math.min(h0.y, h3.y) - CELL * 0.46;
          roundRect(g, x0, y0, CELL * 1.92, CELL * 1.92, 16);
          g.fillStyle = rgba(COL[c], 0.1); g.fill();
          g.strokeStyle = rgba(COL[c], 0.42); g.lineWidth = 2; g.stroke();
        }

        /* Laufbahn */
        var startOf = {};
        for (k = 0; k < order.length; k++) startOf[START[order[k]]] = order[k];
        for (var i = 0; i < 40; i++) {
          var xy = cellXY(TRACK[i]), sc = startOf.hasOwnProperty(i) ? startOf[i] : -1;
          g.beginPath(); g.arc(xy.x, xy.y, CELL * 0.36, 0, TAU);
          g.fillStyle = sc >= 0 ? rgba(COL[sc], 0.26) : 'rgba(8,40,26,.9)';
          g.fill();
          g.lineWidth = sc >= 0 ? 3 : 1.6;
          g.strokeStyle = sc >= 0 ? rgba(COL[sc], 0.95) : 'rgba(57,255,20,.16)';
          g.stroke();
          if (sc >= 0) {
            /* Startfeld: kleiner Pfeil in Laufrichtung — nie ein gefüllter Punkt,
               der sonst mit einer echten Figur verwechselt wird. */
            var nx = TRACK[(i + 1) % 40];
            var dx = nx[0] - TRACK[i][0], dy = nx[1] - TRACK[i][1];
            var ln = Math.sqrt(dx * dx + dy * dy) || 1; dx /= ln; dy /= ln;
            var px = -dy, py = dx;
            var ax = xy.x + dx * CELL * 0.13, ay = xy.y + dy * CELL * 0.13;
            g.beginPath();
            g.moveTo(ax + dx * CELL * 0.11, ay + dy * CELL * 0.11);
            g.lineTo(ax - dx * CELL * 0.06 + px * CELL * 0.1, ay - dy * CELL * 0.06 + py * CELL * 0.1);
            g.lineTo(ax - dx * CELL * 0.06 - px * CELL * 0.1, ay - dy * CELL * 0.06 - py * CELL * 0.1);
            g.closePath();
            g.fillStyle = rgba(COL[sc], 0.8); g.fill();
          }
        }

        /* Ziel-Arme */
        for (k = 0; k < order.length; k++) {
          c = order[k];
          for (var s = 0; s < 4; s++) {
            var gz = cellXY(GOALS[c][s]);
            roundRect(g, gz.x - CELL * 0.34, gz.y - CELL * 0.34, CELL * 0.68, CELL * 0.68, 8);
            g.fillStyle = rgba(COL[c], 0.16); g.fill();
            g.lineWidth = 2; g.strokeStyle = rgba(COL[c], 0.6); g.stroke();
          }
        }

        /* Haus-Mulden */
        for (k = 0; k < order.length; k++) {
          c = order[k];
          for (var hh = 0; hh < 4; hh++) {
            var hp = cellXY(HOMES[c][hh]);
            g.beginPath(); g.arc(hp.x, hp.y, CELL * 0.32, 0, TAU);
            g.fillStyle = 'rgba(3,18,10,.75)'; g.fill();
            g.lineWidth = 1.6; g.strokeStyle = rgba(COL[c], 0.5); g.stroke();
          }
        }

        /* Mitte */
        var mid = cellXY([5, 5]);
        g.beginPath(); g.arc(mid.x, mid.y, CELL * 0.42, 0, TAU);
        g.fillStyle = 'rgba(4,22,12,.9)'; g.fill();
        g.lineWidth = 2; g.strokeStyle = 'rgba(57,255,20,.35)'; g.stroke();
        g.font = '700 ' + Math.round(CELL * 0.5) + 'px system-ui,sans-serif';
        g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillText('🎲', mid.x, mid.y + 1);

        if (!st) return;

        /* Markierungen der möglichen Züge (erst wenn der Würfel liegt) */
        var ms = (now >= diceReadyAt && st.phase === 'move') ? curMoves() : [];
        var actC = order[st.turnI];
        var markMe = ms.length && isHumanSeat(st.turnI);
        ms.forEach(function (m) {
          var t = cellXY(pieceCell(actC, m.to));
          g.save();
          g.setLineDash([6, 5]);
          g.lineDashOffset = -(now / 42) % 11;
          g.lineWidth = 3;
          g.strokeStyle = markMe ? 'rgba(255,255,255,' + (0.55 + 0.4 * pulse) + ')' : rgba(COL[actC], 0.55);
          g.beginPath(); g.arc(t.x, t.y, CELL * 0.4 + pulse * 2, 0, TAU); g.stroke();
          g.restore();
          if (markMe) {
            g.beginPath(); g.arc(t.x, t.y, CELL * 0.1, 0, TAU);
            g.fillStyle = 'rgba(255,255,255,' + (0.25 + 0.35 * pulse) + ')'; g.fill();
          }
        });

        /* Figuren — Häuser zuerst, dann Bahn/Ziel (überlagern schöner) */
        for (k = 0; k < order.length; k++) {
          c = order[k];
          for (var pi = 0; pi < 4; pi++) {
            var p = st.board[c][pi];
            var base = cellXY(pieceCell(c, p));
            var pos = animPos(c + '-' + pi, base);
            var movable = false;
            if (c === actC) {
              for (var mi = 0; mi < ms.length; mi++) if (ms[mi].pi === pi) movable = true;
            }
            drawPiece(g, c, pos.x, pos.y, c === myColor, movable, markMe, pulse);
          }
        }
      }

      function drawPiece(g, c, x, y, isMine, movable, markMe, pulse) {
        var col = COL[c];
        g.save();
        g.beginPath(); g.ellipse(x, y + R * 0.66, R * 0.8, R * 0.3, 0, 0, TAU);
        g.fillStyle = 'rgba(0,0,0,.5)'; g.fill();
        if (movable) {
          g.beginPath(); g.arc(x, y, R + 5 + pulse * 3, 0, TAU);
          g.lineWidth = 2.5;
          g.strokeStyle = markMe ? 'rgba(255,255,255,' + (0.5 + 0.45 * pulse) + ')' : rgba(col, 0.5);
          g.stroke();
        }
        var gr = g.createRadialGradient(x - R * 0.32, y - R * 0.4, R * 0.15, x, y, R);
        gr.addColorStop(0, mix(col, '#ffffff', 0.6));
        gr.addColorStop(1, col);
        g.beginPath(); g.arc(x, y, R, 0, TAU);
        g.fillStyle = gr; g.fill();
        g.lineWidth = 2.4; g.strokeStyle = 'rgba(2,12,6,.9)'; g.stroke();
        g.beginPath(); g.ellipse(x - R * 0.3, y - R * 0.36, R * 0.28, R * 0.17, -0.5, 0, TAU);
        g.fillStyle = 'rgba(255,255,255,.55)'; g.fill();
        if (isMine) {
          g.beginPath(); g.arc(x, y, R + 3.4, 0, TAU);
          g.lineWidth = 2; g.strokeStyle = 'rgba(255,255,255,.85)'; g.stroke();
        }
        g.restore();
      }

      function roundRect(g, x, y, w, h, r) {
        g.beginPath();
        g.moveTo(x + r, y);
        g.lineTo(x + w - r, y); g.quadraticCurveTo(x + w, y, x + w, y + r);
        g.lineTo(x + w, y + h - r); g.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
        g.lineTo(x + r, y + h); g.quadraticCurveTo(x, y + h, x, y + h - r);
        g.lineTo(x, y + r); g.quadraticCurveTo(x, y, x + r, y);
        g.closePath();
      }

      /* ===================== Ende ===================== */
      function finish() {
        if (dead || !st) return;
        clearTimers();
        if (raf) { cancelAnimationFrame(raf); raf = null; }
        if (diceTimer) { clearInterval(diceTimer); diceTimer = null; }
        var iWon = st.winner === myColor;
        if (App.Audio) App.Audio.sfx(iWon ? 'win' : 'lose');

        if (isMulti) {
          reportMyScore();
          var list = [], real = room.players(), pos;
          for (pos = 0; pos < order.length; pos++) {
            var c = order[pos], own = ownerOf(pos);
            var sc = progressScore(st.board, c);
            if (st.winner === c) sc += 1000;                     // Sieger sicher oben
            if (own === 'BOT') list.push({ id: 'BOT' + pos, name: 'Bot ' + COLNAME[c] + ' 🤖', score: sc });
            else {
              var rp = findReal(real, own);
              list.push({ id: own, name: rp ? rp.name : 'Spieler', score: sc });
            }
          }
          real.forEach(function (p) {                             // Zuschauer ohne Sitz
            if (seatOwner.indexOf(p.id) < 0) list.push({ id: p.id, name: p.name, score: 0 });
          });
          App.MG.endScreen(root, {
            players: list, meId: ctx.me.id, onExit: ctx.onExit,
            title: st.winner >= 0 ? '🏁 ' + nameOfColor(st.winner) + ' hat gewonnen' : '🏁 Partie vorbei'
          });
          return;
        }

        var score = 0, i;
        for (i = 0; i < 4; i++) {
          var p = st.board[myColor][i];
          if (p.st === 'g') score += 250; else if (p.st === 't') score += p.v * 3;
        }
        if (iWon) score += Math.max(100, 900 - soloRolls * 6);
        score = Math.round(score);
        var best = App.Storage.get('best_ludo', 0);
        var nb = score > best;
        if (nb) App.Storage.set('best_ludo', score);
        App.MG.endScreen(root, {
          score: score, best: best, newBest: nb,
          title: iWon ? '🏆 Gewonnen!' : '💀 ' + (st.winner >= 0 ? nameOfColor(st.winner) : 'Der Gegner') + ' war schneller',
          label: countGoal(st.board, myColor) + ' von 4 Figuren im Ziel · ' + soloRolls + ' Würfe'
            + (nb ? ' · neuer Rekord! 🎉' : ' · Bestwert: ' + App.MG.fmt(best)),
          onExit: ctx.onExit,
          onAgain: function () { ended = false; showSetup(); }
        });
      }
    }
  };

  /* ===================== STYLES ===================== */
  function injectStyle() {
    UI.injectStyle('mg-ludo-css', [
      '.lud-wrap{display:flex;flex-direction:column;gap:9px;max-width:520px;margin:0 auto;}',
      '.lud-top{display:flex;justify-content:space-between;align-items:center;gap:10px;}',
      '.lud-brand{font-weight:900;font-size:clamp(15px,4vw,19px);}',
      '.lud-mode{font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:1.5px;font-weight:800;}',
      /* Sitz-Chips */
      '.lud-seats{display:flex;gap:5px;}',
      '.lud-seat{flex:1 1 0;min-width:0;display:flex;align-items:center;gap:5px;padding:5px 7px;border-radius:10px;',
      'background:rgba(9,32,21,.62);border:1px solid var(--stroke);transition:border-color .15s,box-shadow .15s;}',
      '.lud-seat-dot{width:9px;height:9px;border-radius:50%;flex:none;}',
      '.lud-seat-nm{flex:1;min-width:0;font-size:11px;font-weight:800;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      '.lud-seat-go{font-size:11px;font-weight:900;color:var(--muted);font-variant-numeric:tabular-nums;flex:none;}',
      '.lud-seat.me .lud-seat-nm{color:var(--aqua);}',
      '.lud-seat.active{border-color:var(--neon);box-shadow:0 0 0 1px var(--neon),0 0 14px rgba(57,255,20,.3);}',
      '.lud-seat.active .lud-seat-dot{animation:lud-blink .9s ease-in-out infinite;}',
      '@keyframes lud-blink{0%,100%{transform:scale(1);opacity:1}50%{transform:scale(1.45);opacity:.6}}',
      /* Status */
      /* zwei Zeilen Platz — lange Meldungen ("X wirft Y raus! · Z ist dran") dürfen umbrechen,
         die feste Mindesthöhe verhindert dabei ein Springen des Bretts. */
      '.lud-status{text-align:center;font-weight:900;font-size:clamp(12px,3.4vw,16px);min-height:36px;color:var(--leaf);',
      'display:flex;align-items:center;justify-content:center;line-height:1.2;padding:0 4px;}',
      '.lud-status.you{color:var(--neon);text-shadow:0 0 10px rgba(57,255,20,.45);}',
      '.lud-status.opp{color:var(--aqua);}',
      '.lud-status.wait{color:var(--muted);}',
      '.lud-status.over{color:var(--gold);text-shadow:0 0 12px rgba(255,210,63,.5);}',
      /* Brett */
      '.lud-stage{width:100%;max-width:min(74vh,440px);margin:0 auto;aspect-ratio:1 / 1;}',
      '.lud-canvas{display:block;width:100%;height:100%;border-radius:18px;border:2px solid rgba(57,255,20,.28);',
      'background:#03120a;box-shadow:0 0 34px rgba(57,255,20,.18),inset 0 0 60px rgba(57,255,20,.05);',
      'touch-action:none;user-select:none;-webkit-user-select:none;-webkit-tap-highlight-color:transparent;}',
      /* Würfel + Knopf */
      '.lud-bar{display:flex;align-items:center;justify-content:center;gap:14px;}',
      '.lud-dice{width:56px;height:56px;flex:none;display:grid;grid-template-columns:repeat(3,1fr);grid-template-rows:repeat(3,1fr);',
      'gap:3px;padding:7px;border-radius:13px;background:linear-gradient(160deg,#f6fff2,#c6e9bd);',
      'border:2px solid rgba(57,255,20,.55);box-shadow:0 0 18px rgba(57,255,20,.38);cursor:pointer;',
      '-webkit-tap-highlight-color:transparent;transition:opacity .2s,filter .2s;}',
      '.lud-pip{border-radius:50%;background:transparent;}',
      '.lud-pip.on{background:#07240f;box-shadow:inset 0 -1px 2px rgba(0,0,0,.5);}',
      '.lud-dice.is-rolling{animation:lud-tumble .3s linear infinite;}',
      '@keyframes lud-tumble{0%{transform:rotate(0) scale(1)}25%{transform:rotate(90deg) scale(1.12)}50%{transform:rotate(180deg) scale(1)}75%{transform:rotate(270deg) scale(1.12)}100%{transform:rotate(360deg) scale(1)}}',
      '.lud-dice.is-idle{opacity:.55;filter:grayscale(.45);}',
      '.lud-roll{min-width:160px;}',
      '.lud-roll:disabled{opacity:.35;cursor:default;box-shadow:none;}',
      '.lud-hint{text-align:center;font-size:11px;line-height:1.45;margin:0;}',
      /* Solo-Vorbereitung */
      '.lud-setup{padding:26px 22px;text-align:center;display:flex;flex-direction:column;gap:10px;align-items:center;max-width:440px;margin:0 auto;}',
      '.lud-setup-icon{font-size:52px;line-height:1;filter:drop-shadow(0 0 14px rgba(57,255,20,.5));animation:lud-roll-in 2.6s ease-in-out infinite;}',
      '@keyframes lud-roll-in{0%,100%{transform:rotate(-8deg) translateY(0)}50%{transform:rotate(8deg) translateY(-6px)}}',
      '.lud-opt-l{font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:1.5px;font-weight:800;margin-top:4px;}',
      '.lud-opt-row{display:flex;gap:8px;justify-content:center;flex-wrap:wrap;}',
      '.lud-opt{cursor:pointer;font-family:inherit;transition:.15s;}',
      '.lud-opt.is-on{border-color:var(--neon);color:var(--neon);box-shadow:0 0 12px rgba(57,255,20,.35);}'
    ].join(''));
  }
})();
