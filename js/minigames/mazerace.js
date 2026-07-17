/* mazerace.js — "Labyrinth-Rennen": Wettrennen durch ein neon-grünes Labyrinth.
 *
 *  IDEE
 *    Ein per Algorithmus (Recursive-Backtracker) erzeugtes Labyrinth wird auf
 *    Canvas gezeichnet. Alle Spieler bekommen aus EINEM gemeinsamen Seed exakt
 *    dasselbe Labyrinth. Start ist oben links, das goldene Ziel 🏁 unten rechts.
 *    Nur ein kleiner Sichtradius um die Figur ist hell — der Rest liegt im Dunkeln
 *    (Nebel des Krieges), das macht die Spannung. Wer ein Labyrinth löst, bekommt
 *    Punkte (schnell = viel), danach lädt sofort das nächste, GRÖSSERE Labyrinth.
 *    3 Minuten am Stück, gelöste Labyrinthe + Tempo = Punkte, Live-Rangliste mit
 *    Fortschrittsbalken.
 *
 *  STEUERUNG
 *    Wischen/Ziehen über das Feld (Drag-Lenkung), Pfeiltasten / WASD oder das
 *    sichtbare Steuerkreuz. Die Figur läuft in die gewählte Richtung weiter, bis
 *    eine Wand kommt (Pac-Man-Prinzip) — an Kreuzungen einfach umlenken.
 *
 *  PUNKTE
 *    Pro gelöstem Labyrinth: Basis (steigt mit der Größe) + Tempo-Bonus (je näher
 *    an der idealen Zeit, desto mehr). Wer am schnellsten ist, sammelt am meisten.
 *
 *  SYNC-MODELL (Multiplayer)
 *    Reines Punkte-Rennen wie reflex.js: der Host verteilt über snapshot().round
 *    .startAt EINE Zahl, die zugleich als gemeinsamer Seed dient -> jeder erzeugt
 *    lokal dieselbe Labyrinth-Folge. Jeder rechnet nur sein eigenes Spiel, meldet
 *    seinen Punktestand (reportScore) und seinen Fortschritt (reportState) — keine
 *    Host-Autorität nötig. Alle Timer laufen über die Wall-Clock (room.now im
 *    Multi), damit Tab-Wechsel nichts kaputt machen.
 *
 *  SOLO
 *    Zeitjagd gegen den eigenen best_mazerace-Rekord — und gegen drei Bots mit
 *    unterschiedlichem Tempo, die dieselbe Labyrinth-Folge abarbeiten (plausible
 *    KI über Ideal-Weglänge + Skill-Faktor), damit es sich wie ein echtes Rennen
 *    anfühlt. Die Rangliste zeigt live, wer vorn liegt.
 */
(function () {
  'use strict';
  window.App = window.App || {}; App.Minigames = App.Minigames || {};
  var UI = App.UI, el = UI.el;

  injectStyle();

  /* ---------- Spiel-Konstanten ---------- */
  var VW = 600;                 // virtuelle Canvas-Größe (Canvas skaliert per CSS)
  var TOTAL = 180;              // s Gesamtspielzeit (3 Minuten)
  var START_SIDE = 7;           // Kantenlänge des ersten Labyrinths (Zellen)
  var SIDE_STEP = 2;            // Wachstum pro Labyrinth
  var MAX_SIDE = 21;            // Deckel für die Größe
  var CELLS_PER_SEC = 5.6;      // Lauftempo der Figur (Zellen/Sek)
  var SIGHT = 2.7;              // Sichtradius in Zellen
  var INIT_GRACE = 500;         // ms Orientierungspause vor dem ersten Zug
  var FREEZE = 650;             // ms Feier-/Ladepause zwischen zwei Labyrinthen
  /* Punkte-Formel */
  var SCORE_MS = 360;           // Referenz: ideale ms pro Weg-Zelle
  var SPEED_MAX = 750;          // maximaler Tempo-Bonus
  var SPEED_CAP = 1.6;          // Deckel des Tempo-Verhältnisses
  var BASE0 = 400;              // Basis-Punkte fürs erste Labyrinth
  var BASE_STEP = 170;          // Basis-Zuwachs pro Labyrinth-Stufe
  /* Bots (nur Solo) */
  var BOT_MS = 520;             // ms pro Weg-Zelle bei Skill 1.0 (inkl. Erkundung)

  /* Richtungen: Bit passt zur Wand-Maske der Zelle (1=N,2=O,4=S,8=W) */
  var DIR = {
    N: { dx: 0, dy: -1, bit: 1 },
    E: { dx: 1, dy: 0, bit: 2 },
    S: { dx: 0, dy: 1, bit: 4 },
    W: { dx: -1, dy: 0, bit: 8 }
  };
  /* Nachbar-Richtung + Gegenbit fürs Carven */
  var CARVE = [
    { dx: 0, dy: -1, bit: 1, opp: 4 },
    { dx: 1, dy: 0, bit: 2, opp: 8 },
    { dx: 0, dy: 1, bit: 4, opp: 1 },
    { dx: -1, dy: 0, bit: 8, opp: 2 }
  ];

  /* ---------- deterministischer Zufall ---------- */
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  /* Aus Basis-Seed + Labyrinth-Index einen gut gestreuten Seed mischen. */
  function seedFor(base, i) {
    var s = (base >>> 0);
    s = (s ^ Math.imul(i + 1, 0x9E3779B1)) >>> 0;
    s = Math.imul(s ^ (s >>> 16), 0x45d9f3b) >>> 0;
    s = Math.imul(s ^ (s >>> 16), 0x45d9f3b) >>> 0;
    return (s ^ (s >>> 16)) >>> 0;
  }

  /* ---------- Labyrinth-Erzeugung (iterativer Recursive-Backtracker) ---------- */
  function genMaze(side, rng) {
    var n = side * side, cells = new Uint8Array(n), i;
    for (i = 0; i < n; i++) cells[i] = 15;          // alle vier Wände stehen
    var visited = new Uint8Array(n);
    var stack = [0]; visited[0] = 1;
    while (stack.length) {
      var cur = stack[stack.length - 1];
      var c = cur % side, r = (cur - c) / side;
      var opts = [];
      for (i = 0; i < 4; i++) {
        var nc = c + CARVE[i].dx, nr = r + CARVE[i].dy;
        if (nc >= 0 && nr >= 0 && nc < side && nr < side && !visited[nr * side + nc]) opts.push(i);
      }
      if (opts.length === 0) { stack.pop(); continue; }
      var d = opts[Math.floor(rng() * opts.length)];
      var tc = c + CARVE[d].dx, tr = r + CARVE[d].dy, ni = tr * side + tc;
      cells[cur] &= ~CARVE[d].bit;                   // Wand raus
      cells[ni] &= ~CARVE[d].opp;
      visited[ni] = 1; stack.push(ni);
    }
    return { side: side, cells: cells };
  }
  /* Kürzeste Weglänge Start->Ziel (BFS) für Ideal-Zeit & Bot-Timing. */
  function pathLen(maze) {
    var side = maze.side, n = side * side, cells = maze.cells;
    var dist = new Int32Array(n), i;
    for (i = 0; i < n; i++) dist[i] = -1;
    var q = [0], head = 0; dist[0] = 0;
    while (head < q.length) {
      var cur = q[head++]; var c = cur % side, r = (cur - c) / side;
      for (i = 0; i < 4; i++) {
        if (cells[cur] & CARVE[i].bit) continue;     // Wand versperrt
        var nc = c + CARVE[i].dx, nr = r + CARVE[i].dy;
        if (nc < 0 || nr < 0 || nc >= side || nr >= side) continue;
        var ni = nr * side + nc;
        if (dist[ni] < 0) { dist[ni] = dist[cur] + 1; q.push(ni); }
      }
    }
    return dist[n - 1] < 0 ? side * 2 : dist[n - 1];
  }

  /* ---------- Punkte pro gelöstem Labyrinth ---------- */
  function mazeScore(i, plen, timeMs) {
    var base = BASE0 + i * BASE_STEP;
    var ideal = Math.max(1, plen) * SCORE_MS;
    var ratio = ideal / Math.max(timeMs, ideal * 0.25);
    if (ratio > SPEED_CAP) ratio = SPEED_CAP;
    return base + Math.round(SPEED_MAX * ratio);
  }

  App.Minigames.mazerace = {
    id: 'mazerace', title: 'Labyrinth-Rennen', icon: '🌽', order: 148,
    subtitle: 'Wettrennen durchs Neon-Labyrinth zum Ziel',
    single: true, multi: true, minPlayers: 2, maxPlayers: 8,

    render: function (root, ctx) {
      var isMulti = ctx.mode === 'multi';
      var nowFn = isMulti ? function () { return ctx.room.now(); } : function () { return Date.now(); };

      /* ---- Aufräum-Verwaltung (dead-Flag wie reflex.js) ---- */
      var dead = false, raf = null, last = 0;
      var stops = [];        // stop()-Funktionen (roundTimer / countdown / room.off)
      var listeners = [];    // {t,ty,fn,opts}
      var timers = [];       // setTimeout-IDs
      function addL(t, ty, fn, opts) { t.addEventListener(ty, fn, opts); listeners.push({ t: t, ty: ty, fn: fn, opts: opts }); }
      function after(ms, fn) { var id = setTimeout(function () { if (!dead) fn(); }, ms); timers.push(id); return id; }
      function addStop(fn) { if (fn) stops.push(fn); }
      function clearTimers() { timers.forEach(clearTimeout); timers = []; }
      function stopHelpers() { stops.forEach(function (f) { try { f(); } catch (e) {} }); stops = []; }
      function removeListeners() { listeners.forEach(function (l) { try { l.t.removeEventListener(l.ty, l.fn, l.opts); } catch (e) {} }); listeners = []; }
      function cleanup() {
        dead = true;
        if (raf) { cancelAnimationFrame(raf); raf = null; }
        clearTimers(); stopHelpers(); removeListeners();
      }

      /* ---- Laufzeit-Zustand ---- */
      var canvas = null, g = null;
      var headMazes = null, headPts = null, headTimer = null, headLevel = null, flashEl = null;
      var boardApi = null;
      var baseSeed = 0, plenCache = {};
      var maze = null, mazeIndex = 0, mazeStartAt = 0, frozenUntil = 0;
      var solvedCount = 0, score = 0;
      var player = null, want = null, visited = null;
      var endAt = 0, finished = false;
      var bots = [];
      var lastStep = 0, lastReport = 0, lastBoardAt = 0;

      /* ================= Start ================= */
      if (isMulti) {
        var snap = ctx.room.snapshot() || {};
        var startAt = (snap.round && snap.round.startAt) || (ctx.room.now() + 3000);
        addStop(App.MG.countdown(root, startAt, function () { play(startAt); }, ctx.room.now));
      } else {
        play(nowFn());
      }
      return { cleanup: cleanup };

      /* ================= Spielaufbau ================= */
      function play(startAt) {
        /* alten Lauf sauber beenden (wichtig für "Nochmal" im Solo) */
        if (raf) { cancelAnimationFrame(raf); raf = null; }
        clearTimers(); stopHelpers(); removeListeners();

        finished = false; score = 0; solvedCount = 0; mazeIndex = 0;
        plenCache = {}; bots = []; want = null;
        lastStep = 0; lastReport = 0; lastBoardAt = 0;
        baseSeed = isMulti ? (Math.floor(startAt) >>> 0)
          : (((Date.now() >>> 0) ^ Math.floor(Math.random() * 0xFFFFFFFF)) >>> 0);
        endAt = startAt + TOTAL * 1000;

        buildLayout();
        loadMaze(0, startAt + INIT_GRACE);
        initBots(startAt + INIT_GRACE);
        attachInput();
        showFlash('🏁 Finde das Ziel!');

        addStop(App.MG.roundTimer(endAt, function (leftSec) {
          if (!headTimer) return;
          headTimer.textContent = App.MG.mmss(leftSec);
          if (leftSec <= 10) headTimer.classList.add('maz-urgent');
        }, finish, isMulti ? ctx.room.now : null));

        if (isMulti) { try { ctx.room.reportScore(0); ctx.room.reportState({ maze: 0, prog: 0 }); } catch (e) {} }

        last = nowFn();
        raf = requestAnimationFrame(frame);
      }

      function loadMaze(i, atTime) {
        mazeIndex = i;
        var side = Math.min(MAX_SIDE, START_SIDE + i * SIDE_STEP);
        maze = genMaze(side, mulberry32(seedFor(baseSeed, i)));
        maze.cell = VW / side;
        maze.plen = pathLen(maze);
        plenCache[i] = maze.plen;
        visited = new Uint8Array(side * side);
        visited[0] = 1;
        player = { c: 0, r: 0, px: cx(0), py: cy(0), dir: null, moving: false, tc: 0, tr: 0 };
        want = null;
        mazeStartAt = atTime; frozenUntil = atTime;
        updateHead();
      }

      function plenFor(i) {
        if (plenCache[i] != null) return plenCache[i];
        var side = Math.min(MAX_SIDE, START_SIDE + i * SIDE_STEP);
        var m = genMaze(side, mulberry32(seedFor(baseSeed, i)));
        var pl = pathLen(m); plenCache[i] = pl; return pl;
      }

      function cx(c) { return (c + 0.5) * maze.cell; }
      function cy(r) { return (r + 0.5) * maze.cell; }
      function canPass(c, r, d) {
        var nc = c + d.dx, nr = r + d.dy, side = maze.side;
        if (nc < 0 || nr < 0 || nc >= side || nr >= side) return false;
        return (maze.cells[r * side + c] & d.bit) === 0;
      }

      /* ================= Bots (nur Solo) ================= */
      function initBots(t0) {
        if (isMulti) return;
        var defs = [
          { name: 'Grünschnabel', skill: 0.82 },
          { name: 'Späher', skill: 1.0 },
          { name: 'Flitzer', skill: 1.16 }
        ];
        bots = defs.map(function (d, k) {
          return { id: 'bot' + k, name: d.name, skill: d.skill, maze: 0, score: 0, prog: 0,
            mazeStart: t0, targetMs: botTarget(0, d.skill) };
        });
      }
      function botTarget(i, skill) {
        return plenFor(i) * BOT_MS / skill * (0.9 + Math.random() * 0.3);
      }
      function updateBots(now) {
        var i, b;
        for (i = 0; i < bots.length; i++) {
          b = bots[i];
          if (now < b.mazeStart) { b.prog = 0; continue; }
          var frac = (now - b.mazeStart) / b.targetMs;
          if (frac >= 1) {
            b.score += mazeScore(b.maze, plenFor(b.maze), b.targetMs);
            b.maze++;
            b.targetMs = botTarget(b.maze, b.skill);
            b.mazeStart = now; b.prog = 0;
          } else {
            b.prog = frac;
          }
        }
      }

      /* ================= Frame-Loop ================= */
      function frame() {
        if (dead || finished) { raf = null; return; }
        var now = nowFn();
        var dt = (now - last) / 1000; if (dt < 0) dt = 0; if (dt > 0.05) dt = 0.05; last = now;

        updatePlayer(dt, now);
        if (isMulti) maybeReport(now); else updateBots(now);
        if (now - lastBoardAt > 120) { lastBoardAt = now; updateBoard(); }
        draw(now);

        raf = requestAnimationFrame(frame);
      }

      function updatePlayer(dt, now) {
        if (now < frozenUntil) return;
        var cell = maze.cell, speed = CELLS_PER_SEC * cell;

        if (player.moving) {
          /* Sofort-Wende, wenn die gewünschte Richtung genau entgegengesetzt ist */
          if (want && player.dir && want.dx === -player.dir.dx && want.dy === -player.dir.dy) {
            var oc = player.c, or_ = player.r;
            player.c = player.tc; player.r = player.tr;
            player.tc = oc; player.tr = or_;
            player.dir = want;
          }
          var tx = cx(player.tc), ty = cy(player.tr);
          var dx = tx - player.px, dy = ty - player.py;
          var distLeft = Math.sqrt(dx * dx + dy * dy);
          var stepPx = speed * dt;
          if (stepPx >= distLeft) {
            player.px = tx; player.py = ty;
            player.c = player.tc; player.r = player.tr; player.moving = false;
            if (onEnterCell(player.c, player.r, now)) return;   // gelöst -> neues Labyrinth
          } else {
            player.px += dx / distLeft * stepPx; player.py += dy / distLeft * stepPx;
            return;
          }
        }
        /* Am Zellen-Mittelpunkt: neue Richtung wählen (Wunsch, sonst weiter geradeaus) */
        var nd = null;
        if (want && canPass(player.c, player.r, want)) nd = want;
        else if (player.dir && canPass(player.c, player.r, player.dir)) nd = player.dir;
        if (nd) {
          player.dir = nd;
          player.tc = player.c + nd.dx; player.tr = player.r + nd.dy;
          player.moving = true;
        }
      }

      function onEnterCell(c, r, now) {
        var idx = r * maze.side + c;
        visited[idx] = 1;
        if (App.Audio && now - lastStep > 85) { lastStep = now; App.Audio.blip(300 + Math.random() * 50, 0.03, { type: 'sine', peak: 0.02 }); }
        if (c === maze.side - 1 && r === maze.side - 1) { solveMaze(now); return true; }
        return false;
      }

      function solveMaze(now) {
        var timeMs = now - mazeStartAt;
        var pts = mazeScore(mazeIndex, maze.plen, timeMs);
        score += pts; solvedCount++;
        if (App.Audio) { App.Audio.sfx('ding'); App.Audio.sfx('levelup'); }
        showFlash('Labyrinth ' + (mazeIndex + 1) + ' geschafft!  +' + App.MG.fmt(pts));
        if (isMulti) { try { ctx.room.reportScore(score); ctx.room.reportState({ maze: solvedCount, prog: 0 }); } catch (e) {} }
        loadMaze(mazeIndex + 1, now + FREEZE);      // kurze Feierpause, dann größer
        updateHead();
      }

      function myProg() {
        if (!maze) return 0;
        var side = maze.side;
        var d = (side - 1 - player.c) + (side - 1 - player.r);
        var p = 1 - d / ((side - 1) * 2);
        if (p < 0) p = 0; if (p > 0.99) p = 0.99;
        return p;
      }

      function maybeReport(now) {
        if (now - lastReport < 250) return;
        lastReport = now;
        try { ctx.room.reportState({ maze: solvedCount, prog: myProg() }); } catch (e) {}
      }

      /* ================= Rangliste ================= */
      function updateBoard() {
        if (!boardApi) return;
        var list;
        if (isMulti) {
          list = ctx.room.players().map(function (p) {
            var s = p.state || {};
            var mine = p.id === ctx.me.id;
            return {
              id: p.id, name: p.name, me: mine,
              score: mine ? score : (p.score || 0),
              maze: mine ? solvedCount : (typeof s.maze === 'number' ? s.maze : 0),
              prog: mine ? myProg() : (typeof s.prog === 'number' ? s.prog : 0)
            };
          });
        } else {
          list = [{ id: 'me', name: (ctx.me && ctx.me.name) || 'Du', me: true, score: score, maze: solvedCount, prog: myProg() }];
          bots.forEach(function (b) { list.push({ id: b.id, name: b.name, me: false, score: b.score, maze: b.maze, prog: b.prog }); });
        }
        boardApi.update(list);
      }

      function buildBoard() {
        var rootEl = el('div', { class: 'maz-board' });
        var rowsById = {};
        function update(list) {
          list = list.slice().sort(function (a, b) {
            return (b.score - a.score) || (b.maze - a.maze) || (b.prog - a.prog);
          });
          var ids = list.map(function (x) { return x.id; }).join(',');
          if (rootEl._ids !== ids) {
            rootEl.innerHTML = ''; rowsById = {};
            list.forEach(function (it) {
              var rank = el('span', { class: 'maz-b-rank' }, ['']);
              var name = el('span', { class: 'maz-b-name' }, ['']);
              var fill = el('span', { class: 'maz-b-fill' });
              var track = el('span', { class: 'maz-b-track' }, [fill]);
              var lvl = el('span', { class: 'maz-b-lvl' }, ['']);
              var sc = el('span', { class: 'maz-b-score' }, ['']);
              var row = el('div', { class: 'maz-b-row' }, [
                rank,
                el('span', { class: 'maz-b-mid' }, [name, track]),
                el('span', { class: 'maz-b-right' }, [lvl, sc])
              ]);
              rowsById[it.id] = { row: row, rank: rank, name: name, fill: fill, lvl: lvl, sc: sc };
              rootEl.appendChild(row);
            });
            rootEl._ids = ids;
          }
          list.forEach(function (it, i) {
            var r = rowsById[it.id]; if (!r) return;
            r.rank.textContent = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : ('#' + (i + 1));
            r.name.textContent = it.name + (it.me ? ' (du)' : '');
            r.lvl.textContent = 'L' + (it.maze + 1);
            r.sc.textContent = App.MG.fmt(it.score);
            r.fill.style.width = Math.round((it.prog || 0) * 100) + '%';
            r.row.className = 'maz-b-row' + (it.me ? ' me' : '') + (i === 0 ? ' lead' : '');
            rootEl.appendChild(r.row);                // in sortierte Reihenfolge bringen
          });
        }
        return { root: rootEl, update: update };
      }

      /* ================= Rendering ================= */
      function draw(now) {
        if (!g || !maze) return;
        var side = maze.side, cell = maze.cell, cells = maze.cells, i;
        g.clearRect(0, 0, VW, VW);
        g.fillStyle = '#04120b'; g.fillRect(0, 0, VW, VW);

        /* Brotkrumen: besuchte Zellen ganz leicht einfärben */
        g.save();
        g.fillStyle = 'rgba(57,255,20,0.055)';
        for (i = 0; i < visited.length; i++) {
          if (!visited[i]) continue;
          var vc = i % side, vr = (i - vc) / side;
          g.fillRect(vc * cell + cell * 0.16, vr * cell + cell * 0.16, cell * 0.68, cell * 0.68);
        }
        g.restore();

        /* Ziel-Glühen + Fahne (wird vom Nebel gedimmt, wenn es weit weg ist) */
        var gx = cx(side - 1), gy = cy(side - 1);
        var pulse = 0.5 + 0.5 * Math.sin(now / 280);
        g.save();
        var gg = g.createRadialGradient(gx, gy, cell * 0.1, gx, gy, cell * 1.5);
        gg.addColorStop(0, 'rgba(255,210,63,' + (0.75 + 0.2 * pulse).toFixed(3) + ')');
        gg.addColorStop(1, 'rgba(255,210,63,0)');
        g.fillStyle = gg; g.beginPath(); g.arc(gx, gy, cell * 1.5, 0, Math.PI * 2); g.fill();
        g.font = '900 ' + Math.round(cell * 0.62) + 'px system-ui,sans-serif';
        g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillText('🏁', gx, gy);
        g.restore();

        /* Wände als ein Pfad mit Neon-Glühen */
        g.save();
        g.strokeStyle = 'rgba(120,255,180,0.92)';
        g.lineWidth = Math.max(2, cell * 0.11); g.lineCap = 'round';
        g.shadowColor = 'rgba(57,255,20,0.55)'; g.shadowBlur = cell * 0.28;
        g.beginPath();
        for (var r = 0; r < side; r++) {
          for (var c = 0; c < side; c++) {
            var w = cells[r * side + c], x0 = c * cell, y0 = r * cell;
            if (w & 1) { g.moveTo(x0, y0); g.lineTo(x0 + cell, y0); }         // Nordwand
            if (w & 8) { g.moveTo(x0, y0); g.lineTo(x0, y0 + cell); }         // Westwand
          }
        }
        g.moveTo(0, side * cell); g.lineTo(side * cell, side * cell);          // Südrand
        g.moveTo(side * cell, 0); g.lineTo(side * cell, side * cell);          // Ostrand
        g.stroke();
        g.restore();

        drawPlayer();
        drawFog();

        /* schwacher Ziel-Leuchtpunkt ÜBER dem Nebel — immer ein Richtungs-Hinweis */
        g.save();
        g.globalAlpha = 0.22 + 0.16 * pulse;
        var bg = g.createRadialGradient(gx, gy, 0, gx, gy, cell * 0.95);
        bg.addColorStop(0, 'rgba(255,210,63,0.85)'); bg.addColorStop(1, 'rgba(255,210,63,0)');
        g.fillStyle = bg; g.beginPath(); g.arc(gx, gy, cell * 0.95, 0, Math.PI * 2); g.fill();
        g.restore();
      }

      function drawPlayer() {
        var rad = maze.cell * 0.3;
        g.save();
        g.shadowColor = 'rgba(57,255,20,0.95)'; g.shadowBlur = maze.cell * 0.5;
        var gp = g.createRadialGradient(player.px - rad * 0.3, player.py - rad * 0.3, rad * 0.2, player.px, player.py, rad);
        gp.addColorStop(0, '#f2ffe8'); gp.addColorStop(1, '#39ff14');
        g.fillStyle = gp;
        g.beginPath(); g.arc(player.px, player.py, rad, 0, Math.PI * 2); g.fill();
        g.restore();
      }

      function drawFog() {
        var cell = maze.cell;
        var grad = g.createRadialGradient(player.px, player.py, cell * 0.9, player.px, player.py, SIGHT * cell);
        grad.addColorStop(0, 'rgba(3,11,7,0)');
        grad.addColorStop(0.6, 'rgba(3,11,7,0.42)');
        grad.addColorStop(1, 'rgba(3,11,7,0.94)');
        g.fillStyle = grad; g.fillRect(0, 0, VW, VW);
      }

      /* ================= Eingabe ================= */
      function setWant(d) { want = d; }

      function attachInput() {
        /* Tastatur */
        var onKey = function (e) {
          var k = e.key, d = null;
          if (k === 'ArrowUp' || k === 'w' || k === 'W') d = DIR.N;
          else if (k === 'ArrowDown' || k === 's' || k === 'S') d = DIR.S;
          else if (k === 'ArrowLeft' || k === 'a' || k === 'A') d = DIR.W;
          else if (k === 'ArrowRight' || k === 'd' || k === 'D') d = DIR.E;
          if (d) { e.preventDefault(); setWant(d); }
        };
        addL(document, 'keydown', onKey);

        /* Wisch-/Zieh-Lenkung direkt auf dem Feld */
        var dragging = false, ax = 0, ay = 0, thresh = VW * 0.06;
        function toV(e) {
          var rect = canvas.getBoundingClientRect();
          return { x: (e.clientX - rect.left) / rect.width * VW, y: (e.clientY - rect.top) / rect.height * VW };
        }
        var onDown = function (e) { dragging = true; var p = toV(e); ax = p.x; ay = p.y; if (e.preventDefault) e.preventDefault(); };
        var onMove = function (e) {
          if (!dragging) return;
          var p = toV(e), dx = p.x - ax, dy = p.y - ay;
          if (Math.abs(dx) > thresh || Math.abs(dy) > thresh) {
            if (Math.abs(dx) > Math.abs(dy)) setWant(dx > 0 ? DIR.E : DIR.W);
            else setWant(dy > 0 ? DIR.S : DIR.N);
            ax = p.x; ay = p.y;
          }
          if (e.preventDefault) e.preventDefault();
        };
        var onUp = function () { dragging = false; };
        addL(canvas, 'pointerdown', onDown);
        addL(canvas, 'pointermove', onMove);
        addL(canvas, 'pointerup', onUp);
        addL(canvas, 'pointercancel', onUp);
        addL(canvas, 'pointerleave', onUp);
      }

      /* ================= DOM-Aufbau ================= */
      function updateHead() {
        if (headMazes) headMazes.textContent = String(solvedCount);
        if (headPts) headPts.textContent = App.MG.fmt(score);
        if (headLevel && maze) headLevel.textContent = 'Labyrinth ' + (mazeIndex + 1) + ' · ' + maze.side + '×' + maze.side;
      }

      function showFlash(txt) {
        if (!flashEl) return;
        flashEl.textContent = txt;
        flashEl.classList.remove('maz-flash-show'); void flashEl.offsetWidth; flashEl.classList.add('maz-flash-show');
      }

      function dpadBtn(sym, dir, cls) {
        var btn = el('button', { class: 'maz-dbtn ' + cls, type: 'button', 'aria-label': cls }, [sym]);
        var press = function (e) { if (e && e.preventDefault) e.preventDefault(); setWant(dir); btn.classList.add('act'); if (App.Audio) App.Audio.sfx('tick'); };
        var rel = function () { btn.classList.remove('act'); };
        addL(btn, 'pointerdown', press);
        addL(btn, 'pointerup', rel);
        addL(btn, 'pointerleave', rel);
        addL(btn, 'pointercancel', rel);
        return btn;
      }

      function buildLayout() {
        headLevel = el('div', { class: 'maz-level' }, ['Labyrinth 1']);
        var brand = el('div', { class: 'maz-brand' }, [el('span', {}, ['🌽 Labyrinth-Rennen']), headLevel]);

        headMazes = el('div', { class: 'maz-stat-v' }, ['0']);
        headPts = el('div', { class: 'maz-stat-v maz-pts' }, ['0']);
        headTimer = el('div', { class: 'maz-stat-v maz-time' }, [App.MG.mmss(TOTAL)]);
        var stats = el('div', { class: 'maz-stats' }, [
          el('div', { class: 'maz-stat' }, [el('div', { class: 'maz-stat-l' }, ['Gelöst']), headMazes]),
          el('div', { class: 'maz-stat' }, [el('div', { class: 'maz-stat-l' }, ['Punkte']), headPts]),
          el('div', { class: 'maz-stat' }, [el('div', { class: 'maz-stat-l' }, ['Zeit']), headTimer])
        ]);
        var head = el('div', { class: 'maz-head glass' }, [brand, stats]);

        canvas = el('canvas', { class: 'maz-canvas', width: VW, height: VW });
        flashEl = el('div', { class: 'maz-flash' }, ['']);
        var stage = el('div', { class: 'maz-stage' }, [canvas, flashEl]);
        g = canvas.getContext('2d');

        var hint = el('div', { class: 'hint-text maz-hint' },
          ['Wische übers Feld oder nutze das Steuerkreuz · Pfeiltasten / WASD · erreiche das goldene 🏁 — schneller = mehr Punkte']);

        var dpad = el('div', { class: 'maz-dpad' }, [
          el('span'), dpadBtn('▲', DIR.N, 'maz-d-up'), el('span'),
          dpadBtn('◀', DIR.W, 'maz-d-left'), el('span', { class: 'maz-dmid' }, ['🌽']), dpadBtn('▶', DIR.E, 'maz-d-right'),
          el('span'), dpadBtn('▼', DIR.S, 'maz-d-down'), el('span')
        ]);

        var b = buildBoard(); boardApi = b;
        var panel = el('div', { class: 'maz-panel glass' }, [
          el('div', { class: 'mg-field-title' }, ['🏆 Rangliste']), b.root
        ]);

        var wrap = el('div', { class: 'maz-wrap' }, [head, stage, hint, dpad, panel]);
        root.innerHTML = ''; root.appendChild(wrap);
        updateBoard();
      }

      /* ================= Ende ================= */
      function finish() {
        if (finished || dead) return;
        finished = true;
        if (raf) { cancelAnimationFrame(raf); raf = null; }
        clearTimers(); stopHelpers();
        if (App.Audio) App.Audio.sfx('win');

        if (isMulti) {
          try { ctx.room.reportScore(score); } catch (e) {}
          after(700, function () {
            App.MG.endScreen(root, { players: ctx.room.players(), meId: ctx.me.id, onExit: ctx.onExit });
          });
        } else {
          var best = App.Storage.get('best_mazerace', 0);
          var nb = score > best;
          if (nb) App.Storage.set('best_mazerace', score);
          App.MG.endScreen(root, {
            score: score, best: best, newBest: nb,
            label: solvedCount + ' Labyrinthe gelöst · ' + (nb ? 'neuer Rekord! 🎉' : 'Bestwert: ' + App.MG.fmt(best)),
            onExit: ctx.onExit,
            onAgain: function () { play(nowFn()); }
          });
        }
      }
    }
  };

  /* ===================== STYLES ===================== */
  function injectStyle() {
    UI.injectStyle('mg-mazerace-css', [
      '.maz-wrap{display:flex;flex-direction:column;gap:12px;max-width:520px;margin:0 auto;}',
      /* Kopf */
      '.maz-head{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 16px;flex-wrap:wrap;}',
      '.maz-brand{display:flex;flex-direction:column;gap:2px;font-weight:900;font-size:clamp(15px,3.6vw,19px);color:var(--neon);text-shadow:0 0 12px rgba(57,255,20,.4);}',
      '.maz-level{font-size:11px;color:var(--muted);font-weight:800;letter-spacing:.4px;}',
      '.maz-stats{display:flex;gap:16px;}',
      '.maz-stat{display:flex;flex-direction:column;align-items:flex-end;line-height:1.05;}',
      '.maz-stat-l{font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;}',
      '.maz-stat-v{font-weight:900;font-size:clamp(18px,4.8vw,24px);color:var(--leaf);font-variant-numeric:tabular-nums;}',
      '.maz-stat-v.maz-pts{color:var(--gold);text-shadow:0 0 10px rgba(255,210,63,.4);}',
      '.maz-stat-v.maz-time{color:var(--aqua);}',
      '.maz-stat-v.maz-urgent{color:var(--danger);animation:maz-pulse .7s infinite;}',
      '@keyframes maz-pulse{0%,100%{opacity:1}50%{opacity:.45}}',
      /* Spielfeld */
      '.maz-stage{position:relative;width:100%;max-width:min(460px,52vh);aspect-ratio:1/1;margin:0 auto;}',
      '.maz-canvas{display:block;width:100%;height:100%;border-radius:16px;border:2px solid var(--stroke-2);',
      'background:#04120b;box-shadow:0 0 42px rgba(57,255,20,.2),inset 0 0 60px rgba(57,255,20,.05);',
      'touch-action:none;user-select:none;-webkit-user-select:none;-webkit-tap-highlight-color:transparent;cursor:pointer;}',
      '.maz-flash{position:absolute;top:12px;left:50%;transform:translateX(-50%);pointer-events:none;',
      'padding:8px 16px;border-radius:12px;background:rgba(4,16,10,.85);border:1px solid var(--stroke-2);',
      'color:var(--gold);font-weight:900;font-size:clamp(13px,3.4vw,17px);white-space:nowrap;opacity:0;',
      'box-shadow:0 6px 22px rgba(0,0,0,.4),0 0 18px rgba(255,210,63,.2);text-shadow:0 0 10px rgba(255,210,63,.4);}',
      '.maz-flash-show{animation:maz-flash 1.15s ease forwards;}',
      '@keyframes maz-flash{0%{opacity:0;transform:translate(-50%,-10px) scale(.9);}14%{opacity:1;transform:translate(-50%,0) scale(1);}70%{opacity:1;}100%{opacity:0;transform:translate(-50%,-6px);}}',
      '.maz-hint{text-align:center;}',
      /* Steuerkreuz */
      '.maz-dpad{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;width:min(240px,72vw);margin:0 auto;touch-action:none;}',
      '.maz-dbtn{aspect-ratio:1/1;border-radius:14px;background:rgba(9,32,21,.72);border:1px solid var(--stroke);',
      'color:var(--neon);font-size:clamp(17px,5vw,24px);font-weight:900;display:flex;align-items:center;justify-content:center;',
      'cursor:pointer;user-select:none;-webkit-user-select:none;-webkit-tap-highlight-color:transparent;touch-action:none;',
      'transition:transform .08s,box-shadow .12s,border-color .12s;}',
      '.maz-dbtn:hover{border-color:var(--stroke-2);}',
      '.maz-dbtn.act{border-color:var(--neon);box-shadow:0 0 0 1px var(--neon),0 0 16px rgba(57,255,20,.4);transform:scale(.93);color:#eaffe0;}',
      '.maz-dmid{display:flex;align-items:center;justify-content:center;font-size:clamp(15px,4.5vw,22px);opacity:.65;}',
      /* Rangliste */
      '.maz-panel{padding:12px 14px;display:flex;flex-direction:column;gap:8px;}',
      '.maz-board{display:flex;flex-direction:column;gap:6px;max-height:220px;overflow-y:auto;}',
      '.maz-b-row{display:flex;align-items:center;gap:10px;padding:6px 10px;border-radius:11px;',
      'background:rgba(6,24,16,.55);border:1px solid var(--stroke);transition:background .2s,border-color .2s;}',
      '.maz-b-row.me{border-color:var(--aqua);background:rgba(9,36,30,.6);}',
      '.maz-b-row.lead{box-shadow:inset 0 0 16px rgba(255,210,63,.12);}',
      '.maz-b-rank{width:28px;text-align:center;font-weight:900;font-size:14px;flex:none;}',
      '.maz-b-mid{flex:1;min-width:0;display:flex;flex-direction:column;gap:4px;}',
      '.maz-b-name{font-weight:800;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      '.maz-b-track{height:6px;border-radius:4px;background:rgba(255,255,255,.08);overflow:hidden;}',
      '.maz-b-fill{display:block;height:100%;width:0;border-radius:4px;background:linear-gradient(90deg,var(--aqua),var(--neon));transition:width .25s ease;}',
      '.maz-b-right{display:flex;flex-direction:column;align-items:flex-end;gap:2px;min-width:46px;flex:none;}',
      '.maz-b-lvl{font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;}',
      '.maz-b-score{font-weight:900;font-size:15px;color:var(--gold);font-variant-numeric:tabular-nums;}'
    ].join(''));
  }
})();
