/* bomberarena.js — "Bomber-Arena": Bomberman-Duell im Neon-Dschungel.
 *
 * SPIELIDEE: 13x11-Gitter mit unzerstörbaren Säulen im Schachbrettmuster und
 *   zerstörbaren Kisten (aus einem gemeinsamen Seed gewürfelt). Bis zu 4 Spieler
 *   starten in den vier Ecken. Bomben explodieren nach 2,5 s kreuzförmig,
 *   zünden andere Bomben mit (Kettenreaktion), stoppen an Säulen und zerstören
 *   je Richtung genau eine Kiste. Unter manchen Kisten liegen Verstärkungen:
 *   💣 mehr Bomben, 🔥 mehr Reichweite, 👟 mehr Tempo.
 *   Wer von einer Flamme getroffen wird, ist raus (Zuschauer-Ansicht).
 *   Letzter Überlebender gewinnt die Runde — Best-of-3, Punkte = Rundensiege.
 *   Ab 55 s stürzt die Arena spiralförmig ein ("Einsturz"), damit jede Runde endet.
 *
 * STEUERUNG: WASD / Pfeiltasten = laufen, Leertaste = Bombe legen.
 *   Am Handy: Steuerkreuz links, großer 💣-Button rechts.
 *
 * PUNKTE: Multiplayer = gewonnene Runden (room.reportScore -> Podest).
 *   Solo = Rundensiege*900 + Abschüsse*220 + Kisten*18 (+1400 für den Matchsieg),
 *   mal Schwierigkeits-Faktor (Leicht 1.0 / Normal 1.6 / Schwer 2.4).
 *
 * SYNC-MODELL: Der HOST führt die komplette Simulation mit festem 60-Hz-Tick
 *   (Wall-Clock über room.now(), Tab-Wechsel-sicher) und sendet den Zustand
 *   ~15x/s kompakt per room.setShared({grid-String, Spieler, Bomben, Flammen,
 *   Verstärkungen, Phase, Punkte}). Die anderen senden NUR ihre Eingaben per
 *   room.reportState({d: Richtung, b: Bomben-Zähler}) (~20x/s), spiegeln den
 *   Host-Zustand in eine lokale Simulation (Seed -> gleiche Arena, daher auch
 *   Host-Migration möglich), sagen ihre eigene Bewegung lokal voraus
 *   (weiche Korrektur zum Host) und interpolieren die Mitspieler.
 *
 * SOLO: gegen 3 Bots mit echter KI — Gefahrenkarte aller Bomben inkl.
 *   Kettenzündung, zeitbewusste BFS-Flucht, Bomben nur mit garantiertem
 *   Fluchtweg, Verstärkungen sammeln, Kisten sprengen, Jagd auf den Spieler.
 *
 * cleanup() beendet rAF, alle Timer, alle Listener und jedes room.on().
 */
(function () {
  'use strict';
  window.App = window.App || {}; App.Minigames = App.Minigames || {};
  var UI = App.UI, el = UI.el;

  /* ===================== Konstanten ===================== */
  var COLS = 13, ROWS = 11, TS = 40, W = COLS * TS, H = ROWS * TS;
  var FREE = 0, PILLAR = 1, BOX = 2, SWALL = 3;
  var FUSE = 2500, FLAME_MS = 460;
  var BASE_SPEED = 3.1, SPEED_STEP = 0.42, MAX_SPEED = 5.2, MAX_SPEED_LVL = 5;
  var MAX_RANGE = 6, MAX_BOMBS = 6;
  var RADIUS = 0.33;
  var ROUND_MS = 100000, SUDDEN_MS = 55000, SUDDEN_STEP = 330;
  var TICK_MS = 1000 / 60;
  var BROADCAST_MS = 66, REPORT_MS = 50;
  var WINS_NEEDED = 2, MAX_ROUNDS = 3;
  var ROUND_GAP = 2800, ROUND_INTRO = 1400;
  var INTERP_MS = 110;

  var SKINS = [
    { body: '#39ff14', dark: '#0b4a06', glow: 'rgba(57,255,20,.9)', css: 'var(--neon)' },
    { body: '#33e6d0', dark: '#075049', glow: 'rgba(51,230,208,.9)', css: 'var(--aqua)' },
    { body: '#ffd23f', dark: '#5e4903', glow: 'rgba(255,210,63,.9)', css: 'var(--gold)' },
    { body: '#ff4d6d', dark: '#61091c', glow: 'rgba(255,77,109,.9)', css: 'var(--danger)' }
  ];
  var STARTS = [[1, 1], [COLS - 2, 1], [1, ROWS - 2], [COLS - 2, ROWS - 2]];
  var PUP_ICON = { b: '💣', r: '🔥', s: '👟' };
  var DIFFS = {
    leicht: { label: 'Leicht', icon: '🌱', interval: 270, miss: 0.34, aggro: 0.22, mult: 1.0, desc: 'Gemütliche Bots' },
    normal: { label: 'Normal', icon: '🔥', interval: 175, miss: 0.14, aggro: 0.5, mult: 1.6, desc: 'Bots jagen dich' },
    schwer: { label: 'Schwer', icon: '💀', interval: 105, miss: 0.03, aggro: 0.85, mult: 2.4, desc: 'Gnadenlos' }
  };
  var BOT_NAMES = ['Bot Aqua', 'Bot Gold', 'Bot Rosa'];

  injectStyle();

  /* ===================== Gitter-Helfer ===================== */
  function idx(cx, cy) { return cy * COLS + cx; }
  function cellX(c) { return c % COLS; }
  function cellY(c) { return (c - (c % COLS)) / COLS; }
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

  /* Deterministischer Zufall (LCG) — gleicher Seed ergibt dieselbe Arena auf allen Geräten. */
  function makeRng(seed) {
    var t = (seed >>> 0) || 1;
    return function () { t = (t * 1664525 + 1013904223) >>> 0; return t / 4294967296; };
  }

  /* Arena aus Seed bauen: Säulen, Kisten, versteckte Verstärkungen. */
  function buildGrid(seed) {
    var rnd = makeRng(seed);
    var g = new Array(COLS * ROWS), cx, cy, i;
    for (cy = 0; cy < ROWS; cy++) {
      for (cx = 0; cx < COLS; cx++) {
        i = idx(cx, cy);
        if (cx === 0 || cy === 0 || cx === COLS - 1 || cy === ROWS - 1) g[i] = PILLAR;
        else if (cx % 2 === 0 && cy % 2 === 0) g[i] = PILLAR;
        else g[i] = FREE;
      }
    }
    /* Startecken freihalten, damit niemand eingemauert startet */
    var safe = {}, k, z, zone = [[0, 0], [1, 0], [2, 0], [0, 1], [0, 2], [1, 1]];
    for (k = 0; k < STARTS.length; k++) {
      var sx = STARTS[k][0], sy = STARTS[k][1];
      for (z = 0; z < zone.length; z++) {
        var ax = sx + (sx === 1 ? zone[z][0] : -zone[z][0]);
        var ay = sy + (sy === 1 ? zone[z][1] : -zone[z][1]);
        if (ax > 0 && ay > 0 && ax < COLS - 1 && ay < ROWS - 1) safe[idx(ax, ay)] = true;
      }
    }
    for (i = 0; i < g.length; i++) {
      if (g[i] !== FREE || safe[i]) continue;
      if (rnd() < 0.78) g[i] = BOX;
    }
    /* Verstärkungen unter zufälligen Kisten verstecken */
    var boxes = [];
    for (i = 0; i < g.length; i++) if (g[i] === BOX) boxes.push(i);
    for (i = boxes.length - 1; i > 0; i--) {
      var j = Math.floor(rnd() * (i + 1)), tmp = boxes[i]; boxes[i] = boxes[j]; boxes[j] = tmp;
    }
    var hidden = {}, count = Math.round(boxes.length * 0.4);
    for (i = 0; i < count; i++) {
      var r = rnd();
      hidden[boxes[i]] = r < 0.38 ? 'r' : (r < 0.72 ? 'b' : 's');
    }
    return { grid: g, hidden: hidden };
  }

  /* Einsturz-Reihenfolge: Spirale von außen nach innen. */
  function makeSpiral() {
    var x0 = 1, y0 = 1, x1 = COLS - 2, y1 = ROWS - 2, out = [], x, y;
    while (x0 <= x1 && y0 <= y1) {
      for (x = x0; x <= x1; x++) out.push(idx(x, y0));
      for (y = y0 + 1; y <= y1; y++) out.push(idx(x1, y));
      if (y1 > y0) for (x = x1 - 1; x >= x0; x--) out.push(idx(x, y1));
      if (x1 > x0) for (y = y1 - 1; y >= y0 + 1; y--) out.push(idx(x0, y));
      x0++; y0++; x1--; y1--;
    }
    return out;
  }

  function gridToStr(g) { return g.join(''); }
  function strToGrid(str) {
    var g = new Array(COLS * ROWS);
    for (var i = 0; i < g.length; i++) g[i] = str.charCodeAt(i) - 48;
    return g;
  }

  /* ===================== Simulation ===================== */
  function newSim(seed, defs, startAt) {
    var built = buildGrid(seed);
    var s = {
      seed: seed, grid: built.grid, hidden: built.hidden,
      players: [], bombs: [], flames: [], pups: [],
      startAt: startAt, endAt: startAt + ROUND_MS,
      over: false, winner: null, overAt: 0, pendingEnd: 0,
      spiral: makeSpiral(), suddenIdx: 0, nextSuddenAt: startAt + SUDDEN_MS,
      seq: 1, lastWall: -1
    };
    for (var i = 0; i < defs.length && i < 4; i++) {
      var st = STARTS[i];
      s.players.push({
        id: defs[i].id, name: defs[i].name, ci: i,
        x: st[0] + 0.5, y: st[1] + 0.5, alive: true, dir: 0,
        maxBombs: 1, range: 1, speedLvl: 0, speed: BASE_SPEED,
        active: 0, seenBq: 0, kills: 0, boxes: 0, deathAt: 0
      });
    }
    return s;
  }

  function bombAt(s, cx, cy) {
    for (var i = 0; i < s.bombs.length; i++) if (s.bombs[i].x === cx && s.bombs[i].y === cy) return s.bombs[i];
    return null;
  }
  function overlapsCell(p, cx, cy) {
    return (p.x + RADIUS > cx) && (p.x - RADIUS < cx + 1) && (p.y + RADIUS > cy) && (p.y - RADIUS < cy + 1);
  }
  function canStand(s, px, py, pIdx) {
    var x0 = Math.floor(px - RADIUS), x1 = Math.floor(px + RADIUS);
    var y0 = Math.floor(py - RADIUS), y1 = Math.floor(py + RADIUS), cx, cy, v, b;
    for (cy = y0; cy <= y1; cy++) {
      for (cx = x0; cx <= x1; cx++) {
        if (cx < 0 || cy < 0 || cx >= COLS || cy >= ROWS) return false;
        v = s.grid[idx(cx, cy)];
        if (v !== FREE) return false;
        b = bombAt(s, cx, cy);
        if (b && b.free.indexOf(pIdx) < 0) return false;
      }
    }
    return true;
  }

  /* Bewegung: achsenweise + sanftes Ausrichten auf die Gassenmitte (Ecken-Hilfe). */
  function movePlayer(s, p, pIdx, dt) {
    var dx = 0, dy = 0;
    if (p.dir === 1) dy = -1; else if (p.dir === 2) dx = 1;
    else if (p.dir === 3) dy = 1; else if (p.dir === 4) dx = -1;
    if (!dx && !dy) return;
    var step = p.speed * dt, moved = false, t, off, sgn, sub;
    if (dx) {
      if (canStand(s, p.x + dx * step, p.y, pIdx)) { p.x += dx * step; moved = true; }
      t = Math.floor(p.y) + 0.5; off = t - p.y;
      if (Math.abs(off) > 0.012) {
        sgn = off > 0 ? 1 : -1; sub = Math.min(step * (moved ? 0.9 : 1), Math.abs(off));
        if (canStand(s, p.x, p.y + sgn * sub, pIdx)) p.y += sgn * sub;
      } else if (!moved) p.y = t;
    } else {
      if (canStand(s, p.x, p.y + dy * step, pIdx)) { p.y += dy * step; moved = true; }
      t = Math.floor(p.x) + 0.5; off = t - p.x;
      if (Math.abs(off) > 0.012) {
        sgn = off > 0 ? 1 : -1; sub = Math.min(step * (moved ? 0.9 : 1), Math.abs(off));
        if (canStand(s, p.x + sgn * sub, p.y, pIdx)) p.x += sgn * sub;
      } else if (!moved) p.x = t;
    }
  }

  function pickup(s, p) {
    var cx = Math.floor(p.x), cy = Math.floor(p.y);
    for (var i = s.pups.length - 1; i >= 0; i--) {
      var pu = s.pups[i];
      if (pu.x !== cx || pu.y !== cy) continue;
      s.pups.splice(i, 1);
      if (pu.k === 'b') p.maxBombs = Math.min(MAX_BOMBS, p.maxBombs + 1);
      else if (pu.k === 'r') p.range = Math.min(MAX_RANGE, p.range + 1);
      else {
        p.speedLvl = Math.min(MAX_SPEED_LVL, p.speedLvl + 1);
        p.speed = Math.min(MAX_SPEED, BASE_SPEED + p.speedLvl * SPEED_STEP);
      }
    }
  }
  function removePupAt(s, cx, cy) {
    for (var i = s.pups.length - 1; i >= 0; i--) if (s.pups[i].x === cx && s.pups[i].y === cy) s.pups.splice(i, 1);
  }
  function removeBomb(s, b) {
    var i = s.bombs.indexOf(b);
    if (i >= 0) s.bombs.splice(i, 1);
    var o = s.players[b.owner];
    if (o && o.active > 0) o.active--;
  }
  function placeBomb(s, p, pIdx, now) {
    if (!p.alive || p.active >= p.maxBombs) return false;
    var cx = Math.floor(p.x), cy = Math.floor(p.y);
    if (s.grid[idx(cx, cy)] !== FREE || bombAt(s, cx, cy)) return false;
    var free = [];
    for (var i = 0; i < s.players.length; i++) if (s.players[i].alive && overlapsCell(s.players[i], cx, cy)) free.push(i);
    s.bombs.push({ id: s.seq++, x: cx, y: cy, owner: pIdx, at: now, range: p.range, free: free });
    p.active++;
    return true;
  }

  /* Flammen-Zellen einer Bombe; zerstört Kisten und sammelt Kettenbomben ein. */
  function blast(s, b, cells, queue) {
    cells.push(idx(b.x, b.y));
    removePupAt(s, b.x, b.y);
    var dirs = [[0, -1], [1, 0], [0, 1], [-1, 0]], d, i, cx, cy, c, v, ob;
    for (d = 0; d < 4; d++) {
      for (i = 1; i <= b.range; i++) {
        cx = b.x + dirs[d][0] * i; cy = b.y + dirs[d][1] * i;
        if (cx < 0 || cy < 0 || cx >= COLS || cy >= ROWS) break;
        c = idx(cx, cy); v = s.grid[c];
        if (v === PILLAR || v === SWALL) break;
        if (v === BOX) {
          s.grid[c] = FREE; cells.push(c);
          if (s.players[b.owner]) s.players[b.owner].boxes++;
          if (s.hidden[c]) { s.pups.push({ x: cx, y: cy, k: s.hidden[c] }); delete s.hidden[c]; }
          break;
        }
        cells.push(c);
        removePupAt(s, cx, cy);
        ob = bombAt(s, cx, cy);
        if (ob) queue.push(ob);
      }
    }
  }
  function detonate(s, now) {
    var exploded = {}, guard = 0, i;
    while (guard++ < 48) {
      var root = null;
      for (i = 0; i < s.bombs.length; i++) if (now >= s.bombs[i].at + FUSE) { root = s.bombs[i]; break; }
      if (!root) break;
      var queue = [root], cells = [], by = root.owner;
      while (queue.length) {
        var b = queue.shift();
        if (exploded[b.id]) continue;
        exploded[b.id] = true;
        removeBomb(s, b);
        blast(s, b, cells, queue);
      }
      var uniq = [], seen = {};
      for (i = 0; i < cells.length; i++) if (!seen[cells[i]]) { seen[cells[i]] = true; uniq.push(cells[i]); }
      s.flames.push({ id: s.seq++, cells: uniq, until: now + FLAME_MS, by: by, at: now });
    }
  }

  function killPlayer(s, p, pIdx, by, now) {
    if (!p.alive) return;
    p.alive = false; p.deathAt = now; p.dir = 0;
    if (by >= 0 && by !== pIdx && s.players[by]) s.players[by].kills++;
  }
  function aliveList(s) {
    var out = [];
    for (var i = 0; i < s.players.length; i++) if (s.players[i].alive) out.push(s.players[i]);
    return out;
  }
  function dropWall(s, now) {
    while (s.suddenIdx < s.spiral.length) {
      var c = s.spiral[s.suddenIdx++];
      if (s.grid[c] === PILLAR) continue;
      s.grid[c] = SWALL;
      var cx = cellX(c), cy = cellY(c), i;
      for (i = s.bombs.length - 1; i >= 0; i--) if (s.bombs[i].x === cx && s.bombs[i].y === cy) removeBomb(s, s.bombs[i]);
      removePupAt(s, cx, cy);
      for (i = 0; i < s.players.length; i++) {
        var p = s.players[i];
        if (p.alive && Math.floor(p.x) === cx && Math.floor(p.y) === cy) killPlayer(s, p, i, -1, now);
      }
      s.lastWall = c;
      return;
    }
  }

  function tickSim(s, now, dt, inputs) {
    if (s.over || now < s.startAt) return;
    var i, p, b, f;
    for (i = 0; i < s.players.length; i++) {
      p = s.players[i];
      if (!p.alive) continue;
      var inp = inputs[p.id] || { d: 0, b: p.seenBq };
      p.dir = inp.d | 0;
      var bq = inp.b | 0;
      if (bq > p.seenBq) {
        if (bq - p.seenBq > 3) p.seenBq = bq - 1;
        p.seenBq++;
        placeBomb(s, p, i, now);
      } else if (bq < p.seenBq) p.seenBq = bq;
      movePlayer(s, p, i, dt);
      pickup(s, p);
    }
    /* Freigabe: wer die eigene Bombe verlassen hat, kommt nicht mehr zurück */
    for (i = 0; i < s.bombs.length; i++) {
      b = s.bombs[i];
      for (var k = b.free.length - 1; k >= 0; k--) {
        var pp = s.players[b.free[k]];
        if (!pp || !pp.alive || !overlapsCell(pp, b.x, b.y)) b.free.splice(k, 1);
      }
    }
    detonate(s, now);
    for (i = s.flames.length - 1; i >= 0; i--) if (now >= s.flames[i].until) s.flames.splice(i, 1);
    for (i = 0; i < s.players.length; i++) {
      p = s.players[i];
      if (!p.alive) continue;
      var c = idx(Math.floor(p.x), Math.floor(p.y));
      for (var fi = 0; fi < s.flames.length; fi++) {
        f = s.flames[fi];
        if (f.cells.indexOf(c) >= 0) { killPlayer(s, p, i, f.by, now); break; }
      }
    }
    if (now >= s.nextSuddenAt && s.suddenIdx < s.spiral.length) {
      s.nextSuddenAt = now + SUDDEN_STEP;
      dropWall(s, now);
    }
    var alive = aliveList(s);
    if (alive.length <= 1) {
      if (!s.pendingEnd) s.pendingEnd = now + 750;
      else if (now >= s.pendingEnd) {
        s.over = true; s.overAt = now;
        s.winner = aliveList(s).length === 1 ? aliveList(s)[0].id : 'draw';
      }
    } else s.pendingEnd = 0;
    if (!s.over && now >= s.endAt) { s.over = true; s.overAt = now; s.winner = 'draw'; }
  }

  /* ===================== Bot-KI ===================== */
  function virtualBlast(s, bx, by, range) {
    var cells = [idx(bx, by)], dirs = [[0, -1], [1, 0], [0, 1], [-1, 0]], d, i, cx, cy, c, v;
    for (d = 0; d < 4; d++) {
      for (i = 1; i <= range; i++) {
        cx = bx + dirs[d][0] * i; cy = by + dirs[d][1] * i;
        if (cx < 0 || cy < 0 || cx >= COLS || cy >= ROWS) break;
        c = idx(cx, cy); v = s.grid[c];
        if (v === PILLAR || v === SWALL) break;
        cells.push(c);
        if (v === BOX) break;
      }
    }
    return cells;
  }
  /* Gefahrenkarte: frühester Explosionszeitpunkt je Zelle (inkl. Kettenzündung). */
  function computeDanger(s, now) {
    var d = new Array(COLS * ROWS), i, j, pass;
    for (i = 0; i < d.length; i++) d[i] = Infinity;
    for (i = 0; i < s.flames.length; i++) {
      var fc = s.flames[i].cells;
      for (j = 0; j < fc.length; j++) if (now < d[fc[j]]) d[fc[j]] = now;
    }
    var times = [], blasts = [];
    for (i = 0; i < s.bombs.length; i++) {
      times.push(s.bombs[i].at + FUSE);
      blasts.push(virtualBlast(s, s.bombs[i].x, s.bombs[i].y, s.bombs[i].range));
    }
    for (pass = 0; pass < 3; pass++) {
      for (i = 0; i < s.bombs.length; i++) {
        for (j = 0; j < s.bombs.length; j++) {
          if (i === j) continue;
          if (blasts[i].indexOf(idx(s.bombs[j].x, s.bombs[j].y)) >= 0 && times[i] < times[j]) times[j] = times[i];
        }
      }
    }
    for (i = 0; i < s.bombs.length; i++) {
      for (j = 0; j < blasts[i].length; j++) if (times[i] < d[blasts[i][j]]) d[blasts[i][j]] = times[i];
    }
    return d;
  }
  var BDIRS = [[0, -1, 1], [1, 0, 2], [0, 1, 3], [-1, 0, 4]];
  /* Zeitbewusste BFS: liefert Schrittzahl + ersten Zug für jede erreichbare Zelle. */
  function bfsField(s, sx, sy, danger, now, speed) {
    var n = COLS * ROWS, dist = new Array(n), step = new Array(n), i;
    for (i = 0; i < n; i++) { dist[i] = -1; step[i] = 0; }
    var start = idx(sx, sy);
    dist[start] = 0;
    var q = [start], head = 0, msPerCell = 1000 / Math.max(0.5, speed);
    while (head < q.length) {
      var c = q[head++], cx = cellX(c), cy = cellY(c);
      for (var d = 0; d < 4; d++) {
        var nx = cx + BDIRS[d][0], ny = cy + BDIRS[d][1];
        if (nx < 1 || ny < 1 || nx >= COLS - 1 || ny >= ROWS - 1) continue;
        var nc = idx(nx, ny);
        if (dist[nc] >= 0 || s.grid[nc] !== FREE || bombAt(s, nx, ny)) continue;
        var nd = dist[c] + 1;
        if (danger[nc] !== Infinity && now + nd * msPerCell > danger[nc] - 280) continue;
        dist[nc] = nd;
        step[nc] = (c === start) ? BDIRS[d][2] : step[c];
        q.push(nc);
      }
    }
    return { dist: dist, step: step, start: start };
  }
  function escapeExists(s, p, pIdx, cx, cy, now) {
    var tmp = { id: -999, x: cx, y: cy, owner: pIdx, at: now, range: p.range, free: [pIdx] };
    s.bombs.push(tmp);
    var dg = computeDanger(s, now);
    var f = bfsField(s, cx, cy, dg, now, p.speed), ok = false;
    for (var i = 0; i < f.dist.length; i++) {
      if (f.dist[i] > 0 && dg[i] === Infinity) { ok = true; break; }
    }
    s.bombs.pop();
    return ok;
  }
  function bombValue(s, cx, cy, p, pIdx) {
    var cells = virtualBlast(s, cx, cy, p.range), v = 0, i, j;
    for (i = 0; i < cells.length; i++) {
      if (s.grid[cells[i]] === BOX) v += 1;
      for (j = 0; j < s.players.length; j++) {
        var q = s.players[j];
        if (j === pIdx || !q.alive) continue;
        if (idx(Math.floor(q.x), Math.floor(q.y)) === cells[i]) v += 6;
      }
    }
    return v;
  }
  function adjacentBox(s, c) {
    var cx = cellX(c), cy = cellY(c);
    for (var d = 0; d < 4; d++) {
      var nx = cx + BDIRS[d][0], ny = cy + BDIRS[d][1];
      if (nx < 0 || ny < 0 || nx >= COLS || ny >= ROWS) continue;
      if (s.grid[idx(nx, ny)] === BOX) return true;
    }
    return false;
  }
  function nearestReachable(field, c) {
    if (field.dist[c] >= 0) return c;
    var cx = cellX(c), cy = cellY(c), best = -1, bd = 1e9;
    for (var d = 0; d < 4; d++) {
      var nx = cx + BDIRS[d][0], ny = cy + BDIRS[d][1];
      if (nx < 0 || ny < 0 || nx >= COLS || ny >= ROWS) continue;
      var nc = idx(nx, ny);
      if (field.dist[nc] >= 0 && field.dist[nc] < bd) { bd = field.dist[nc]; best = nc; }
    }
    return best;
  }
  function wanderDir(s, p, danger) {
    var cx = Math.floor(p.x), cy = Math.floor(p.y), opts = [], d;
    for (d = 0; d < 4; d++) {
      var nx = cx + BDIRS[d][0], ny = cy + BDIRS[d][1];
      if (nx < 1 || ny < 1 || nx >= COLS - 1 || ny >= ROWS - 1) continue;
      var c = idx(nx, ny);
      if (s.grid[c] !== FREE || bombAt(s, nx, ny) || danger[c] !== Infinity) continue;
      opts.push(BDIRS[d][2]);
    }
    if (!opts.length) return 0;
    if (p.dir && opts.indexOf(p.dir) >= 0 && Math.random() < 0.72) return p.dir;
    return opts[Math.floor(Math.random() * opts.length)];
  }
  function panicDir(s, p, danger) {
    var cx = Math.floor(p.x), cy = Math.floor(p.y);
    var best = 0, bestT = danger[idx(cx, cy)], d;
    for (d = 0; d < 4; d++) {
      var nx = cx + BDIRS[d][0], ny = cy + BDIRS[d][1];
      if (nx < 1 || ny < 1 || nx >= COLS - 1 || ny >= ROWS - 1) continue;
      var c = idx(nx, ny);
      if (s.grid[c] !== FREE || bombAt(s, nx, ny)) continue;
      if (danger[c] > bestT) { bestT = danger[c]; best = BDIRS[d][2]; }
    }
    return best;
  }
  function pickGoal(s, p, pIdx, field, cfg) {
    var i, best = -1, bestScore = -1e9, sc, c;
    for (i = 0; i < s.pups.length; i++) {
      c = idx(s.pups[i].x, s.pups[i].y);
      if (field.dist[c] < 0) continue;
      sc = 120 - field.dist[c] * 4;
      if (sc > bestScore) { bestScore = sc; best = c; }
    }
    if (Math.random() < cfg.aggro) {
      for (i = 0; i < s.players.length; i++) {
        var q = s.players[i];
        if (i === pIdx || !q.alive) continue;
        var t = nearestReachable(field, idx(Math.floor(q.x), Math.floor(q.y)));
        if (t < 0) continue;
        sc = 85 - field.dist[t] * 3;
        if (sc > bestScore) { bestScore = sc; best = t; }
      }
    }
    for (i = 0; i < field.dist.length; i++) {
      if (field.dist[i] < 0 || !adjacentBox(s, i)) continue;
      sc = 62 - field.dist[i] * 5;
      if (sc > bestScore) { bestScore = sc; best = i; }
    }
    return best;
  }
  function botThink(s, p, pIdx, now, cfg, danger) {
    var res = { dir: 0, bomb: false };
    var cx = Math.floor(p.x), cy = Math.floor(p.y), here = idx(cx, cy);
    var field = bfsField(s, cx, cy, danger, now, p.speed), i;
    if (danger[here] !== Infinity) {                       /* 1) Flucht */
      var best = -1, bd = 1e9;
      for (i = 0; i < field.dist.length; i++) {
        if (field.dist[i] <= 0 || danger[i] !== Infinity) continue;
        if (field.dist[i] < bd) { bd = field.dist[i]; best = i; }
      }
      res.dir = (best >= 0 && field.step[best]) ? field.step[best] : panicDir(s, p, danger);
      return res;
    }
    if (p.active < p.maxBombs && s.grid[here] === FREE && !bombAt(s, cx, cy)) {   /* 2) Bombe legen */
      if (bombValue(s, cx, cy, p, pIdx) > 0 && Math.random() > cfg.miss && escapeExists(s, p, pIdx, cx, cy, now)) {
        res.bomb = true;
        return res;
      }
    }
    var goal = pickGoal(s, p, pIdx, field, cfg);            /* 3) Ziel ansteuern */
    if (goal >= 0 && goal !== here && field.step[goal]) res.dir = field.step[goal];
    else res.dir = wanderDir(s, p, danger);
    return res;
  }

  /* ===================== Registrierung ===================== */
  App.Minigames.bomberarena = {
    id: 'bomberarena', title: 'Bomber-Arena', icon: '🧨', order: 122,
    subtitle: 'Bomben legen, ausweichen – letzter gewinnt',
    single: true, multi: true, minPlayers: 2, maxPlayers: 4,

    render: function (root, ctx) {
      var isMulti = ctx.mode === 'multi';
      var nowFn = isMulti ? function () { return ctx.room.now(); } : function () { return Date.now(); };

      /* ---- Laufzeit ---- */
      var dead = false, raf = null, stops = [], timers = [], listeners = [];
      var sim = null, match = null, refs = null, g2d = null;
      var simNow = 0, lastBroadcast = 0, lastReport = 0, endShown = false, wonCounted = false;
      var diffKey = 'normal', bots = [], soloStats = { boxes: 0, kills: 0 };
      var myIdx = 0, amHost = false;
      var netCur = null, netPrev = null, interp = {}, hostMe = null, netPlayers = [], inputs = {};
      var myBombFree = {}, seenBombs = {}, seenFlames = {}, deathSeen = {};
      var prevStats = null, shake = 0, parts = [], lastSc = -1;

      /* ---- Eingabe ---- */
      var held = [], touchDir = 0, bombCounter = 0;

      function after(ms, fn) { var t = setTimeout(function () { if (!dead) fn(); }, ms); timers.push(t); return t; }
      function addL(t, ty, fn, o) { t.addEventListener(ty, fn, o); listeners.push({ t: t, ty: ty, fn: fn, o: o }); }
      function cleanup() {
        dead = true;
        if (raf) { cancelAnimationFrame(raf); raf = null; }
        timers.forEach(clearTimeout); timers = [];
        stops.forEach(function (f) { try { f(); } catch (e) {} }); stops = [];
        listeners.forEach(function (l) { try { l.t.removeEventListener(l.ty, l.fn, l.o); } catch (e) {} }); listeners = [];
      }

      if (isMulti) startMulti(); else showDifficulty();
      return { cleanup: cleanup };

      /* ===================== SOLO ===================== */
      function showDifficulty() {
        var keys = ['leicht', 'normal', 'schwer'];
        var btns = keys.map(function (k) {
          var d = DIFFS[k];
          return el('button', { class: 'btn bmb-diff', type: 'button', onclick: function () { if (App.Audio) App.Audio.sfx('select'); startSolo(k); } }, [
            el('span', { class: 'bmb-diff-icon' }, [d.icon]),
            el('span', { class: 'bmb-diff-l' }, [d.label]),
            el('span', { class: 'bmb-diff-d' }, [d.desc]),
            el('span', { class: 'bmb-diff-m' }, ['×' + d.mult.toFixed(1) + ' Punkte'])
          ]);
        });
        root.innerHTML = '';
        root.appendChild(el('div', { class: 'glass bmb-pre' }, [
          el('div', { class: 'bmb-pre-icon' }, ['🧨']),
          el('h2', { class: 'neon' }, ['Bomber-Arena']),
          el('p', { class: 'hint-text' }, ['Du gegen 3 Bots · Best-of-3 · wähle die Schwierigkeit']),
          el('div', { class: 'bmb-diff-row' }, btns),
          el('p', { class: 'hint-text bmb-pre-hint' }, ['WASD / Pfeile laufen · Leertaste legt eine Bombe · am Handy Steuerkreuz + 💣'])
        ]));
      }

      function startSolo(key) {
        diffKey = key;
        soloStats = { boxes: 0, kills: 0 };
        endShown = false; wonCounted = false;
        var defs = [{ id: ctx.me.id, name: (ctx.me && ctx.me.name) ? ctx.me.name : 'Du' }];
        for (var i = 0; i < 3; i++) defs.push({ id: 'bot' + i, name: BOT_NAMES[i] });
        match = { round: 1, scores: {}, phase: 'play', nextAt: 0, winner: null, defs: defs };
        defs.forEach(function (d) { match.scores[d.id] = 0; });
        myIdx = 0; amHost = true;
        stops.push(App.MG.countdown(root, Date.now() + 3000, function () {
          buildStage();
          newRound(Date.now() + 200);
          startLoop();
        }, Date.now));
      }

      function resetBots(now) {
        bots = [];
        for (var i = 1; i < sim.players.length; i++) {
          bots.push({ pi: i, nextThink: now + 300 + i * 90, jitter: (i - 1) * 25 });
        }
      }

      /* ===================== MULTI ===================== */
      function startMulti() {
        var snap = ctx.room.snapshot() || {};
        var startAt = (snap.round && snap.round.startAt) || (ctx.room.now() + 3000);
        stops.push(App.MG.countdown(root, startAt, function () { play(startAt); }, ctx.room.now));
      }

      function play(startAt) {
        var ps = ctx.room.players().slice(0, 4);
        var defs = ps.map(function (p) { return { id: p.id, name: p.name }; });
        if (!defs.length) defs = [{ id: ctx.me.id, name: ctx.me.name }];
        myIdx = 0;
        for (var i = 0; i < defs.length; i++) if (defs[i].id === ctx.me.id) myIdx = i;
        match = { round: 1, scores: {}, phase: 'play', nextAt: 0, winner: null, defs: defs };
        defs.forEach(function (d) { match.scores[d.id] = 0; });
        endShown = false; wonCounted = false;
        amHost = !!ctx.room.isHost();

        var onShared = function (sh) { if (!dead && sh) applyShared(sh); };
        var onPlayers = function () { if (!dead) netPlayers = ctx.room.players(); };
        ctx.room.on('shared', onShared);
        ctx.room.on('players', onPlayers);
        stops.push(function () { ctx.room.off('shared', onShared); });
        stops.push(function () { ctx.room.off('players', onPlayers); });
        netPlayers = ctx.room.players();

        buildStage();
        if (amHost) newRound(startAt + ROUND_INTRO);
        else {
          var sh = (ctx.room.snapshot() || {}).shared;
          if (sh && sh.g) applyShared(sh);
        }
        ctx.room.reportScore(0);
        startLoop();
      }

      function newRound(startAt) {
        var seed = (Math.floor(Math.random() * 1e9) ^ (match.round * 2654435761)) >>> 0;
        sim = newSim(seed, match.defs, startAt);
        simNow = startAt - 400;
        resetBots(startAt);
        inputsReset();
        myBombFree = {}; seenBombs = {}; seenFlames = {}; deathSeen = {}; parts = []; prevStats = null;
        match.phase = 'play';
      }
      function inputsReset() {
        inputs = {};
        match.defs.forEach(function (d) { inputs[d.id] = { d: 0, b: 0 }; });
        bombCounter = 0; held = []; touchDir = 0;
      }

      /* ---- Host/Solo: Zustand senden ---- */
      function broadcast(now) {
        var ps = sim.players.map(function (p) {
          return { i: p.id, x: Math.round(p.x * 100), y: Math.round(p.y * 100), a: p.alive ? 1 : 0,
            b: p.maxBombs, r: p.range, s: p.speedLvl, d: p.dir };
        });
        var bs = sim.bombs.map(function (b) { return { i: b.id, x: b.x, y: b.y, o: b.owner, a: b.at, r: b.range }; });
        var fl = sim.flames.map(function (f) { return { i: f.id, c: f.cells, u: f.until, b: f.by }; });
        var pu = sim.pups.map(function (p) { return { x: p.x, y: p.y, k: p.k }; });
        var sc = match.defs.map(function (d) { return { i: d.id, w: match.scores[d.id] || 0 }; });
        try {
          ctx.room.setShared({
            t: now, sd: sim.seed, g: gridToStr(sim.grid), ph: match.phase, rd: match.round,
            st: sim.startAt, en: sim.endAt, nx: match.nextAt || 0, si: sim.suddenIdx, ns: sim.nextSuddenAt,
            wn: sim.winner || '', mw: match.winner || '', ps: ps, bs: bs, fl: fl, pu: pu, sc: sc
          });
        } catch (e) {}
      }

      /* ---- Gast: Zustand übernehmen ---- */
      function applyShared(sh) {
        if (!sh || !sh.g || !match) return;
        var t = (typeof sh.t === 'number') ? sh.t : ctx.room.now();
        if (typeof sh.sd === 'number' && (!sim || sim.seed !== sh.sd)) {
          sim = newSim(sh.sd, match.defs, sh.st || t);
          myBombFree = {}; seenBombs = {}; seenFlames = {}; parts = []; prevStats = null;
          interp = {};
        }
        if (!sim) return;
        if (typeof sh.rd === 'number') match.round = sh.rd;
        match.phase = sh.ph || 'play';
        match.nextAt = sh.nx || 0;
        match.winner = sh.mw || null;
        sim.startAt = sh.st || sim.startAt;
        sim.endAt = sh.en || sim.endAt;
        sim.suddenIdx = sh.si || 0;
        sim.nextSuddenAt = sh.ns || sim.nextSuddenAt;
        sim.winner = sh.wn || null;
        sim.over = !!sh.wn;
        sim.grid = strToGrid(sh.g);
        Object.keys(sim.hidden).forEach(function (k) { if (sim.grid[k] !== BOX) delete sim.hidden[k]; });

        var i, p, o;
        var bs = sh.bs || [];
        sim.bombs = bs.map(function (b) { return { id: b.i, x: b.x, y: b.y, owner: b.o, at: b.a, range: b.r, free: [] }; });
        var fl = sh.fl || [];
        sim.flames = fl.map(function (f) { return { id: f.i, cells: f.c || [], until: f.u, by: f.b, at: f.u - FLAME_MS }; });
        var pu = sh.pu || [];
        sim.pups = pu.map(function (x) { return { x: x.x, y: x.y, k: x.k }; });

        var ps = sh.ps || [];
        for (i = 0; i < ps.length; i++) {
          o = ps[i];
          p = null;
          for (var j = 0; j < sim.players.length; j++) if (sim.players[j].id === o.i) { p = sim.players[j]; break; }
          if (!p) continue;
          var hx = o.x / 100, hy = o.y / 100;
          if (p === sim.players[myIdx] && !amHost) {
            hostMe = { x: hx, y: hy };
            if (Math.abs(p.x - hx) + Math.abs(p.y - hy) > 1.4) { p.x = hx; p.y = hy; }
          } else {
            var b = interp[o.i] || { px: hx, py: hy, pt: t - 60, cx: hx, cy: hy, ct: t };
            interp[o.i] = { px: b.cx, py: b.cy, pt: b.ct, cx: hx, cy: hy, ct: t };
            p.x = hx; p.y = hy;
            p.dir = o.d | 0;
          }
          p.alive = o.a === 1;
          p.maxBombs = o.b; p.range = o.r; p.speedLvl = o.s;
          p.speed = Math.min(MAX_SPEED, BASE_SPEED + p.speedLvl * SPEED_STEP);
          p.active = 0;
        }
        for (i = 0; i < sim.bombs.length; i++) {
          var ow = sim.players[sim.bombs[i].owner];
          if (ow) ow.active++;
          /* Eigene Durchlässigkeit lokal spiegeln (spart Bandbreite) */
          var key = sim.bombs[i].id;
          var me = sim.players[myIdx];
          if (!(key in myBombFree)) myBombFree[key] = overlapsCell(me, sim.bombs[i].x, sim.bombs[i].y);
          if (myBombFree[key] && !overlapsCell(me, sim.bombs[i].x, sim.bombs[i].y)) myBombFree[key] = false;
          if (myBombFree[key]) sim.bombs[i].free.push(myIdx);
        }
        var sc = sh.sc || [];
        for (i = 0; i < sc.length; i++) match.scores[sc[i].i] = sc[i].w;
        var mine = match.scores[ctx.me.id] || 0;
        if (mine !== lastSc) { lastSc = mine; try { ctx.room.reportScore(mine); } catch (e) {} }
        netPrev = netCur; netCur = { t: t };
      }

      /* ===================== Haupt-Loop ===================== */
      function startLoop() {
        simNow = simNow || nowFn();
        raf = requestAnimationFrame(frame);
      }
      function frame() {
        if (dead) { raf = null; return; }
        raf = requestAnimationFrame(frame);
        var now = nowFn();
        if (!sim || !match) return;

        if (isMulti) {
          amHost = !!ctx.room.isHost();
          if (now - lastReport >= REPORT_MS) {
            lastReport = now;
            try { ctx.room.reportState({ d: curDir(), b: bombCounter }); } catch (e) {}
          }
        }

        if (amHost) hostStep(now); else guestStep(now);
        drawAll(now);
        updateHud(now);
        checkPhase(now);
      }

      function gatherInputs(now) {
        inputs[match.defs[myIdx].id] = { d: curDir(), b: bombCounter };
        if (isMulti) {
          for (var i = 0; i < match.defs.length; i++) {
            var id = match.defs[i].id;
            if (id === ctx.me.id) continue;
            var np = null;
            for (var j = 0; j < netPlayers.length; j++) if (netPlayers[j].id === id) { np = netPlayers[j]; break; }
            if (!np) {                                  /* Spieler weg -> ausscheiden lassen */
              if (sim.players[i] && sim.players[i].alive) killPlayer(sim, sim.players[i], i, -1, now);
              inputs[id] = { d: 0, b: sim.players[i] ? sim.players[i].seenBq : 0 };
              continue;
            }
            var st = np.state;
            inputs[id] = { d: (st && st.d) | 0, b: (st && st.b) | 0 };
          }
        } else {
          /* Gefahrenkarte nur bauen, wenn wirklich ein Bot dran ist (nicht jeden Frame). */
          var danger = null;
          for (var k = 0; k < bots.length; k++) {
            var bo = bots[k], p = sim.players[bo.pi];
            if (!p || !p.alive) continue;
            if (now < bo.nextThink) continue;
            if (!danger) danger = computeDanger(sim, now);
            var cfg = DIFFS[diffKey];
            bo.nextThink = now + cfg.interval + bo.jitter + Math.random() * 50;
            var r = botThink(sim, p, bo.pi, now, cfg, danger);
            var cur = inputs[p.id] || { d: 0, b: 0 };
            inputs[p.id] = { d: r.dir, b: cur.b + (r.bomb ? 1 : 0) };
            if (r.bomb) bo.nextThink = now + 40;        /* sofort fliehen */
          }
        }
      }

      function hostStep(now) {
        if (match.phase !== 'play') { simNow = now; return; }
        gatherInputs(now);
        var steps = 0;
        while (simNow + TICK_MS <= now && steps < 12) {
          simNow += TICK_MS;
          tickSim(sim, simNow, TICK_MS / 1000, inputs);
          steps++;
        }
        if (simNow + TICK_MS <= now) simNow = now;     /* Tab war weg -> aufholen */
        if (isMulti && (now - lastBroadcast >= BROADCAST_MS || sim.over)) { lastBroadcast = now; broadcast(now); }
      }

      function guestStep(now) {
        if (match.phase !== 'play' || now < sim.startAt) { simNow = now; return; }
        var me = sim.players[myIdx];
        if (!me || !me.alive) { simNow = now; return; }
        var steps = 0;
        while (simNow + TICK_MS <= now && steps < 12) {
          simNow += TICK_MS;
          me.dir = curDir();
          movePlayer(sim, me, myIdx, TICK_MS / 1000);
          steps++;
        }
        if (simNow + TICK_MS <= now) simNow = now;
        if (hostMe) {                                   /* weiche Korrektur zum Host */
          var dx = hostMe.x - me.x, dy = hostMe.y - me.y;
          if (Math.abs(dx) + Math.abs(dy) > 0.3) { me.x += dx * 0.14; me.y += dy * 0.14; }
        }
      }

      /* ---- Runden-/Match-Phasen (Host + Solo steuern, Gast folgt) ---- */
      function checkPhase(now) {
        if (!amHost) {
          if (match.phase === 'mend' && !endShown) showEnd();
          return;
        }
        if (match.phase === 'play' && sim.over) {
          match.phase = 'rend';
          match.nextAt = now + ROUND_GAP;
          if (sim.winner && sim.winner !== 'draw') match.scores[sim.winner] = (match.scores[sim.winner] || 0) + 1;
          if (!isMulti) { soloStats.boxes += sim.players[0].boxes; soloStats.kills += sim.players[0].kills; }
          if (App.Audio) App.Audio.sfx(sim.winner === ctx.me.id ? 'win' : (sim.winner === 'draw' ? 'info' : 'lose'));
          if (isMulti) broadcast(now);
        } else if (match.phase === 'rend' && now >= match.nextAt) {
          var top = 0, id;
          for (id in match.scores) if (match.scores[id] > top) top = match.scores[id];
          if (top >= WINS_NEEDED || match.round >= MAX_ROUNDS) {
            var winners = [];
            for (id in match.scores) if (match.scores[id] === top) winners.push(id);
            match.winner = (top > 0 && winners.length === 1) ? winners[0] : 'draw';
            match.phase = 'mend';
            if (isMulti) broadcast(now);
            after(600, showEnd);
          } else {
            match.round++;
            newRound(now + ROUND_INTRO);
            if (isMulti) broadcast(now);
          }
        }
      }

      function showEnd() {
        if (endShown || dead) return;
        endShown = true;
        if (raf) { cancelAnimationFrame(raf); raf = null; }
        var iWon = match.winner === ctx.me.id;
        if (iWon && !wonCounted) { wonCounted = true; try { if (App.Scores) App.Scores.winCurrent(); } catch (e) {} }
        if (App.Audio) App.Audio.sfx(iWon ? 'jackpot' : 'info');
        if (isMulti) {
          try { ctx.room.reportScore(match.scores[ctx.me.id] || 0); } catch (e) {}
          App.MG.endScreen(root, { players: ctx.room.players(), meId: ctx.me.id, onExit: ctx.onExit });
        } else {
          var cfg = DIFFS[diffKey];
          var wins = match.scores[ctx.me.id] || 0;
          var score = Math.round((wins * 900 + soloStats.kills * 220 + soloStats.boxes * 18 + (iWon ? 1400 : 0)) * cfg.mult);
          var best = App.Storage.get('best_bomberarena', 0);
          var nb = score > best;
          if (nb) App.Storage.set('best_bomberarena', score);
          App.MG.endScreen(root, {
            score: score, best: best, newBest: nb,
            label: cfg.icon + ' ' + cfg.label + ' · ' + wins + ' Rundensiege · ' + soloStats.kills +
              ' Abschüsse · ' + soloStats.boxes + ' Kisten' + (nb ? ' · neuer Rekord! 🎉' : ' · Bestwert: ' + App.MG.fmt(best)),
            onExit: ctx.onExit,
            onAgain: function () { endShown = false; showDifficulty(); }
          });
        }
      }

      /* ===================== Eingabe ===================== */
      function dirOfKey(k) {
        if (k === 'ArrowUp' || k === 'w' || k === 'W') return 1;
        if (k === 'ArrowRight' || k === 'd' || k === 'D') return 2;
        if (k === 'ArrowDown' || k === 's' || k === 'S') return 3;
        if (k === 'ArrowLeft' || k === 'a' || k === 'A') return 4;
        return 0;
      }
      function curDir() { return held.length ? held[held.length - 1] : touchDir; }
      function pressDir(d) { if (d && held.indexOf(d) < 0) held.push(d); }
      function releaseDir(d) { var i = held.indexOf(d); if (i >= 0) held.splice(i, 1); }
      function requestBomb() {
        var me = sim && sim.players[myIdx];
        if (!me || !me.alive || match.phase !== 'play') return;
        bombCounter++;
        if (App.Audio) App.Audio.sfx('click');
      }
      function attachInput() {
        /* Erst alte Listener lösen — buildStage() läuft bei "Nochmal" erneut,
           sonst würde jeder Tastendruck doppelt zählen (2 Bomben pro Leertaste). */
        listeners.forEach(function (l) { try { l.t.removeEventListener(l.ty, l.fn, l.o); } catch (e) {} });
        listeners = [];
        held = []; touchDir = 0;
        addL(document, 'keydown', function (e) {
          if (e.repeat) return;
          var d = dirOfKey(e.key);
          if (d) { pressDir(d); e.preventDefault(); return; }
          if (e.code === 'Space' || e.key === ' ') { requestBomb(); e.preventDefault(); }
        });
        addL(document, 'keyup', function (e) {
          var d = dirOfKey(e.key);
          if (d) releaseDir(d);
        });
        addL(window, 'blur', function () { held = []; touchDir = 0; });
      }

      /* ===================== Aufbau der Ansicht ===================== */
      function buildStage() {
        var canvas = el('canvas', { class: 'bmb-canvas', width: W, height: H });
        var banner = el('div', { class: 'bmb-banner' });
        var stage = el('div', { class: 'bmb-stage' }, [canvas, banner]);

        var roundEl = el('div', { class: 'bmb-round' }, ['Runde 1 / ' + MAX_ROUNDS]);
        var timerEl = el('div', { class: 'mg-timer bmb-timer' }, ['1:40']);
        var warnEl = el('div', { class: 'bmb-warn' }, ['⚠ Einsturz']);
        var head = el('div', { class: 'bmb-head glass' }, [roundEl, timerEl, warnEl]);

        var chips = [], chipRow = el('div', { class: 'bmb-chips' });
        for (var i = 0; i < match.defs.length; i++) {
          var nameEl = el('span', { class: 'bmb-chip-name' }, [match.defs[i].name + (match.defs[i].id === ctx.me.id ? ' (du)' : '')]);
          var winEl = el('span', { class: 'bmb-chip-wins' }, ['0']);
          var statEl = el('span', { class: 'bmb-chip-stats' }, ['💣1 🔥1 👟1']);
          var chip = el('div', { class: 'bmb-chip bmb-c' + i }, [
            el('span', { class: 'bmb-chip-dot' }),
            el('span', { class: 'bmb-chip-info' }, [nameEl, statEl]),
            winEl
          ]);
          chips.push({ root: chip, win: winEl, stat: statEl, cache: '' });
          chipRow.appendChild(chip);
        }

        var hint = el('p', { class: 'hint-text bmb-hint' },
          ['WASD / Pfeile laufen · Leertaste = 💣 · Kisten sprengen für 💣 🔥 👟 · letzter Überlebender gewinnt die Runde']);

        var touch = buildTouch();
        var wrap = el('div', { class: 'bmb-wrap' }, [head, chipRow, stage, hint, touch]);
        root.innerHTML = ''; root.appendChild(wrap);
        g2d = canvas.getContext('2d');
        refs = { canvas: canvas, banner: banner, roundEl: roundEl, timerEl: timerEl, warnEl: warnEl, chips: chips, stage: stage };
        attachInput();
      }

      function buildTouch() {
        var coarse = false;
        try { coarse = window.matchMedia && window.matchMedia('(pointer: coarse), (hover: none)').matches; } catch (e) {}
        if (!coarse && !('ontouchstart' in window)) return null;
        function pad(d, label, cls) {
          var b = el('button', { class: 'bmb-pad ' + cls, type: 'button' }, [label]);
          b.addEventListener('pointerdown', function (e) { e.preventDefault(); touchDir = d; b.classList.add('on'); });
          var off = function () { if (touchDir === d) touchDir = 0; b.classList.remove('on'); };
          b.addEventListener('pointerup', off);
          b.addEventListener('pointercancel', off);
          b.addEventListener('pointerleave', off);
          return b;
        }
        var dpad = el('div', { class: 'bmb-dpad' }, [
          pad(1, '▲', 'bmb-pu'), pad(4, '◀', 'bmb-pl'), pad(2, '▶', 'bmb-pr'), pad(3, '▼', 'bmb-pd')
        ]);
        var bomb = el('button', { class: 'bmb-bombbtn', type: 'button' }, ['💣']);
        bomb.addEventListener('pointerdown', function (e) { e.preventDefault(); requestBomb(); bomb.classList.add('on'); });
        var boff = function () { bomb.classList.remove('on'); };
        bomb.addEventListener('pointerup', boff);
        bomb.addEventListener('pointercancel', boff);
        return el('div', { class: 'bmb-touch' }, [dpad, bomb]);
      }

      /* ===================== HUD ===================== */
      function updateHud(now) {
        if (!refs) return;
        refs.roundEl.textContent = 'Runde ' + match.round + ' / ' + MAX_ROUNDS;
        var left = Math.max(0, (sim.endAt - Math.max(now, sim.startAt)) / 1000);
        refs.timerEl.textContent = App.MG.mmss(left);
        refs.timerEl.classList.toggle('bmb-urgent', left <= 15);
        var sudden = sim.suddenIdx > 0;
        refs.warnEl.classList.toggle('on', sudden);
        for (var i = 0; i < refs.chips.length; i++) {
          var p = sim.players[i], c = refs.chips[i];
          if (!p) continue;
          var stat = '💣' + p.maxBombs + ' 🔥' + p.range + ' 👟' + (p.speedLvl + 1);
          if (c.cache !== stat) { c.cache = stat; c.stat.textContent = stat; }
          var w = String(match.scores[p.id] || 0);
          if (c.win.textContent !== w) c.win.textContent = w;
          c.root.classList.toggle('out', !p.alive);
        }
        /* Banner */
        var txt = '', cls = '';
        if (match.phase === 'mend') { txt = ''; }
        else if (match.phase === 'rend') {
          if (sim.winner === 'draw') { txt = '💥 Unentschieden'; cls = 'draw'; }
          else {
            var wp = null;
            for (var j = 0; j < sim.players.length; j++) if (sim.players[j].id === sim.winner) wp = sim.players[j];
            txt = (sim.winner === ctx.me.id ? '🏆 Du gewinnst die Runde!' : '🏆 ' + (wp ? wp.name : '?') + ' gewinnt die Runde');
            cls = sim.winner === ctx.me.id ? 'win' : 'lose';
          }
        } else if (now < sim.startAt) {
          txt = 'Runde ' + match.round + ' – ' + Math.max(1, Math.ceil((sim.startAt - now) / 1000));
          cls = 'go';
        } else if (sim.players[myIdx] && !sim.players[myIdx].alive) {
          txt = '👻 Du bist raus – Zuschauermodus';
          cls = 'spec';
        }
        if (refs.banner.textContent !== txt) refs.banner.textContent = txt;
        refs.banner.className = 'bmb-banner' + (txt ? ' show ' + cls : '');
      }

      /* ===================== Zeichnen ===================== */
      function renderPos(p, i, now) {
        if (isMulti && !amHost && i !== myIdx) {
          var b = interp[p.id];
          if (b) {
            var rt = now - INTERP_MS, span = Math.max(20, b.ct - b.pt);
            var a = clamp((rt - b.pt) / span, 0, 1);
            return { x: b.px + (b.cx - b.px) * a, y: b.py + (b.cy - b.py) * a };
          }
        }
        return { x: p.x, y: p.y };
      }

      function cues(now) {
        var i, b, f;
        for (i = 0; i < sim.bombs.length; i++) {
          b = sim.bombs[i];
          if (!seenBombs[b.id]) { seenBombs[b.id] = true; if (App.Audio) App.Audio.sfx('pop'); }
        }
        for (i = 0; i < sim.flames.length; i++) {
          f = sim.flames[i];
          if (seenFlames[f.id]) continue;
          seenFlames[f.id] = true;
          if (App.Audio) App.Audio.sfx('explosion');
          shake = Math.min(9, 3 + f.cells.length * 0.35);
          for (var c = 0; c < f.cells.length; c++) {
            var cx = cellX(f.cells[c]) + 0.5, cy = cellY(f.cells[c]) + 0.5;
            for (var k = 0; k < 3; k++) {
              parts.push({ x: cx, y: cy, vx: (Math.random() - 0.5) * 3, vy: (Math.random() - 0.5) * 3,
                born: now, life: 340 + Math.random() * 260 });
            }
          }
        }
        var me = sim.players[myIdx];
        if (me) {
          var st = me.maxBombs + ':' + me.range + ':' + me.speedLvl;
          if (prevStats && prevStats !== st && me.alive && App.Audio) App.Audio.sfx('powerup');
          prevStats = st;
          if (!me.alive && !deathSeen[me.id]) { deathSeen[me.id] = now; if (App.Audio) App.Audio.sfx('lose'); }
        }
        for (i = 0; i < sim.players.length; i++) {
          var p = sim.players[i];
          if (!p.alive && !deathSeen[p.id]) deathSeen[p.id] = now;
          if (p.alive && deathSeen[p.id]) delete deathSeen[p.id];
        }
      }

      function roundRect(g, x, y, w, h, r) {
        r = Math.min(r, w / 2, h / 2);
        g.beginPath();
        g.moveTo(x + r, y);
        g.arcTo(x + w, y, x + w, y + h, r);
        g.arcTo(x + w, y + h, x, y + h, r);
        g.arcTo(x, y + h, x, y, r);
        g.arcTo(x, y, x + w, y, r);
        g.closePath();
      }

      function drawAll(now) {
        var g = g2d;
        if (!g || !sim) return;
        cues(now);
        g.save();
        if (shake > 0.2) {
          g.translate((Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake);
          shake *= 0.86;
        } else shake = 0;

        /* Boden */
        var bg = g.createLinearGradient(0, 0, 0, H);
        bg.addColorStop(0, '#06180e'); bg.addColorStop(1, '#020a06');
        g.fillStyle = bg; g.fillRect(-12, -12, W + 24, H + 24);
        var cx, cy, c, v, x, y;
        for (cy = 1; cy < ROWS - 1; cy++) {
          for (cx = 1; cx < COLS - 1; cx++) {
            if ((cx + cy) % 2) continue;
            g.fillStyle = 'rgba(57,255,20,0.035)';
            g.fillRect(cx * TS, cy * TS, TS, TS);
          }
        }
        g.strokeStyle = 'rgba(57,255,20,0.07)'; g.lineWidth = 1;
        for (cx = 1; cx < COLS; cx++) { g.beginPath(); g.moveTo(cx * TS, TS); g.lineTo(cx * TS, H - TS); g.stroke(); }
        for (cy = 1; cy < ROWS; cy++) { g.beginPath(); g.moveTo(TS, cy * TS); g.lineTo(W - TS, cy * TS); g.stroke(); }

        /* Blöcke */
        for (cy = 0; cy < ROWS; cy++) {
          for (cx = 0; cx < COLS; cx++) {
            c = idx(cx, cy); v = sim.grid[c];
            if (v === FREE) continue;
            x = cx * TS; y = cy * TS;
            if (v === PILLAR) drawPillar(g, x, y);
            else if (v === BOX) drawBox(g, x, y);
            else drawSwall(g, x, y, c === sim.lastWall, now);
          }
        }

        /* Verstärkungen */
        for (var i = 0; i < sim.pups.length; i++) drawPup(g, sim.pups[i], now);
        /* Bomben */
        for (i = 0; i < sim.bombs.length; i++) drawBomb(g, sim.bombs[i], now);
        /* Flammen */
        for (i = 0; i < sim.flames.length; i++) drawFlame(g, sim.flames[i], now);
        /* Spieler */
        for (i = 0; i < sim.players.length; i++) {
          var p = sim.players[i];
          var pos = renderPos(p, i, now);
          if (p.alive) drawBomber(g, p, pos, i === myIdx, now);
          else if (deathSeen[p.id] && now - deathSeen[p.id] < 900) drawGhost(g, p, pos, now - deathSeen[p.id]);
        }
        /* Partikel */
        for (i = parts.length - 1; i >= 0; i--) {
          var pa = parts[i], age = now - pa.born;
          if (age >= pa.life) { parts.splice(i, 1); continue; }
          var t = age / pa.life;
          g.fillStyle = 'rgba(' + Math.round(255 - t * 60) + ',255,' + Math.round(180 - t * 140) + ',' + (1 - t).toFixed(2) + ')';
          var px = (pa.x + pa.vx * t * 0.9) * TS, py = (pa.y + pa.vy * t * 0.9) * TS;
          g.beginPath(); g.arc(px, py, (1 - t) * 4 + 1, 0, Math.PI * 2); g.fill();
        }
        g.restore();

        if (sim.players[myIdx] && !sim.players[myIdx].alive && match.phase === 'play') {
          g.fillStyle = 'rgba(2,10,6,0.34)'; g.fillRect(0, 0, W, H);
        }
      }

      function drawPillar(g, x, y) {
        var gr = g.createLinearGradient(x, y, x, y + TS);
        gr.addColorStop(0, '#1c3b28'); gr.addColorStop(1, '#0a1a11');
        g.fillStyle = gr;
        roundRect(g, x + 1, y + 1, TS - 2, TS - 2, 6); g.fill();
        g.strokeStyle = 'rgba(51,230,208,0.35)'; g.lineWidth = 1.5;
        roundRect(g, x + 2.5, y + 2.5, TS - 5, TS - 5, 5); g.stroke();
        g.fillStyle = 'rgba(255,255,255,0.06)';
        roundRect(g, x + 5, y + 5, TS - 10, 8, 3); g.fill();
      }
      function drawBox(g, x, y) {
        var gr = g.createLinearGradient(x, y, x + TS, y + TS);
        gr.addColorStop(0, '#4a3a16'); gr.addColorStop(1, '#241d08');
        g.fillStyle = gr;
        roundRect(g, x + 2, y + 2, TS - 4, TS - 4, 5); g.fill();
        g.strokeStyle = 'rgba(255,210,63,0.42)'; g.lineWidth = 1.6;
        roundRect(g, x + 3, y + 3, TS - 6, TS - 6, 4); g.stroke();
        g.strokeStyle = 'rgba(255,210,63,0.22)'; g.lineWidth = 1.2;
        g.beginPath();
        g.moveTo(x + 5, y + 5); g.lineTo(x + TS - 5, y + TS - 5);
        g.moveTo(x + TS - 5, y + 5); g.lineTo(x + 5, y + TS - 5);
        g.stroke();
        g.fillStyle = 'rgba(57,255,20,0.14)';
        roundRect(g, x + TS / 2 - 4, y + TS / 2 - 4, 8, 8, 2); g.fill();
      }
      function drawSwall(g, x, y, fresh, now) {
        var gr = g.createLinearGradient(x, y, x, y + TS);
        gr.addColorStop(0, '#5a1226'); gr.addColorStop(1, '#22060e');
        g.fillStyle = gr;
        roundRect(g, x + 1, y + 1, TS - 2, TS - 2, 6); g.fill();
        g.strokeStyle = 'rgba(255,77,109,' + (fresh ? 0.9 : 0.4) + ')'; g.lineWidth = 1.6;
        roundRect(g, x + 2.5, y + 2.5, TS - 5, TS - 5, 5); g.stroke();
        g.save();
        g.globalAlpha = 0.25 + 0.2 * Math.sin(now / 260);
        g.fillStyle = 'rgba(255,77,109,0.5)';
        roundRect(g, x + 6, y + 6, TS - 12, TS - 12, 4); g.fill();
        g.restore();
      }
      function drawPup(g, pu, now) {
        var x = pu.x * TS, y = pu.y * TS;
        var pulse = 1 + 0.07 * Math.sin(now / 190 + pu.x + pu.y);
        g.save();
        g.translate(x + TS / 2, y + TS / 2); g.scale(pulse, pulse);
        g.shadowColor = 'rgba(57,255,20,0.7)'; g.shadowBlur = 14;
        var gr = g.createLinearGradient(-TS / 2, -TS / 2, TS / 2, TS / 2);
        gr.addColorStop(0, 'rgba(20,70,40,0.95)'); gr.addColorStop(1, 'rgba(8,32,20,0.95)');
        g.fillStyle = gr;
        roundRect(g, -TS / 2 + 5, -TS / 2 + 5, TS - 10, TS - 10, 7); g.fill();
        g.shadowBlur = 0;
        g.strokeStyle = 'rgba(57,255,20,0.75)'; g.lineWidth = 1.6;
        roundRect(g, -TS / 2 + 5, -TS / 2 + 5, TS - 10, TS - 10, 7); g.stroke();
        g.font = '17px "Segoe UI Emoji",system-ui,sans-serif';
        g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillText(PUP_ICON[pu.k] || '?', 0, 1);
        g.restore();
      }
      function drawBomb(g, b, now) {
        var t = clamp((now - b.at) / FUSE, 0, 1);
        var beat = 1 + 0.16 * Math.abs(Math.sin(now / (150 - t * 80)));
        var r = TS * 0.31 * beat;
        var x = b.x * TS + TS / 2, y = b.y * TS + TS / 2;
        var sk = SKINS[b.owner % 4];
        g.save();
        g.shadowColor = t > 0.75 ? 'rgba(255,77,109,0.9)' : 'rgba(0,0,0,0.7)';
        g.shadowBlur = t > 0.75 ? 18 : 8;
        var gr = g.createRadialGradient(x - r * 0.35, y - r * 0.4, r * 0.15, x, y, r);
        gr.addColorStop(0, t > 0.8 ? '#ff7a90' : '#4a5560');
        gr.addColorStop(1, '#080d0a');
        g.fillStyle = gr;
        g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
        g.shadowBlur = 0;
        g.strokeStyle = sk.glow; g.lineWidth = 1.8;
        g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.stroke();
        /* Zündschnur + Funke */
        g.strokeStyle = '#caa15a'; g.lineWidth = 2;
        g.beginPath(); g.moveTo(x + r * 0.4, y - r * 0.75); g.quadraticCurveTo(x + r * 1.1, y - r * 1.3, x + r * 0.75, y - r * 1.7); g.stroke();
        g.fillStyle = (Math.floor(now / 70) % 2) ? '#fff6b0' : '#ffb02e';
        g.beginPath(); g.arc(x + r * 0.75, y - r * 1.75, 2.6 + (1 - t) * 1.2, 0, Math.PI * 2); g.fill();
        g.restore();
      }
      function drawFlame(g, f, now) {
        var t = clamp((now - f.at) / FLAME_MS, 0, 1);
        var a = 1 - t * t;
        g.save();
        g.globalCompositeOperation = 'lighter';
        for (var i = 0; i < f.cells.length; i++) {
          var cx = cellX(f.cells[i]) * TS, cy = cellY(f.cells[i]) * TS;
          var mx = cx + TS / 2, my = cy + TS / 2;
          var gr = g.createRadialGradient(mx, my, 1, mx, my, TS * 0.62);
          gr.addColorStop(0, 'rgba(255,255,235,' + (a * 0.95).toFixed(3) + ')');
          gr.addColorStop(0.42, 'rgba(180,255,120,' + (a * 0.6).toFixed(3) + ')');
          gr.addColorStop(0.75, 'rgba(51,230,208,' + (a * 0.3).toFixed(3) + ')');
          gr.addColorStop(1, 'rgba(51,230,208,0)');
          g.fillStyle = gr;
          g.fillRect(cx - TS * 0.2, cy - TS * 0.2, TS * 1.4, TS * 1.4);
          var s = (1 - t) * TS * 0.34;
          g.fillStyle = 'rgba(255,255,255,' + (a * 0.85).toFixed(3) + ')';
          roundRect(g, mx - s / 2, my - s / 2, s, s, s * 0.35); g.fill();
        }
        g.restore();
      }
      function drawBomber(g, p, pos, isMe, now) {
        var x = pos.x * TS, y = pos.y * TS, r = TS * 0.36;
        var sk = SKINS[p.ci % 4];
        g.save();
        g.fillStyle = 'rgba(0,0,0,0.35)';
        g.beginPath(); g.ellipse(x, y + r * 0.8, r * 0.8, r * 0.32, 0, 0, Math.PI * 2); g.fill();
        g.shadowColor = sk.glow; g.shadowBlur = isMe ? 20 : 11;
        var gr = g.createRadialGradient(x - r * 0.35, y - r * 0.4, r * 0.1, x, y, r);
        gr.addColorStop(0, '#ffffff'); gr.addColorStop(0.38, sk.body); gr.addColorStop(1, sk.dark);
        g.fillStyle = gr;
        g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
        g.shadowBlur = 0;
        g.strokeStyle = 'rgba(4,16,10,0.85)'; g.lineWidth = 2;
        g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.stroke();
        if (isMe) {
          g.strokeStyle = 'rgba(255,255,255,' + (0.5 + 0.3 * Math.sin(now / 220)).toFixed(2) + ')';
          g.lineWidth = 1.6;
          g.beginPath(); g.arc(x, y, r + 3.5, 0, Math.PI * 2); g.stroke();
        }
        /* Augen in Laufrichtung */
        var horiz = (p.dir === 2 || p.dir === 4);
        var ex = p.dir === 2 ? 0.2 : (p.dir === 4 ? -0.2 : 0);
        var ey = p.dir === 1 ? -0.24 : (p.dir === 3 ? 0.18 : -0.04);
        var sx = horiz ? 0 : 0.19, sy = horiz ? 0.15 : 0;   /* seitwärts: Augen übereinander */
        var e1x = x + (ex - sx) * TS, e1y = y + (ey - sy) * TS;
        var e2x = x + (ex + sx) * TS, e2y = y + (ey + sy) * TS;
        g.fillStyle = '#ffffff';
        g.beginPath(); g.ellipse(e1x, e1y, 3.3, 4.1, 0, 0, Math.PI * 2); g.fill();
        g.beginPath(); g.ellipse(e2x, e2y, 3.3, 4.1, 0, 0, Math.PI * 2); g.fill();
        g.fillStyle = '#07120b';
        var px = ex * 9, py = (p.dir === 1 ? -1.6 : (p.dir === 3 ? 1.6 : 0));
        g.beginPath(); g.arc(e1x + px, e1y + py, 1.7, 0, Math.PI * 2); g.fill();
        g.beginPath(); g.arc(e2x + px, e2y + py, 1.7, 0, Math.PI * 2); g.fill();
        /* Name */
        g.font = '700 9px "Segoe UI",system-ui,sans-serif';
        g.textAlign = 'center'; g.textBaseline = 'middle';
        var nm = p.name.length > 9 ? p.name.slice(0, 8) + '…' : p.name;
        var wdt = g.measureText(nm).width + 8;
        g.fillStyle = 'rgba(3,12,7,0.72)';
        roundRect(g, x - wdt / 2, y - r - 15, wdt, 12, 4); g.fill();
        g.fillStyle = sk.body;
        g.fillText(nm, x, y - r - 9);
        g.restore();
      }
      function drawGhost(g, p, pos, age) {
        var t = clamp(age / 900, 0, 1);
        g.save();
        g.globalAlpha = 1 - t;
        g.font = (26 - t * 6) + 'px "Segoe UI Emoji",system-ui,sans-serif';
        g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillText('👻', pos.x * TS, pos.y * TS - t * 24);
        g.restore();
      }
    }
  };

  /* ===================== STYLES ===================== */
  function injectStyle() {
    UI.injectStyle('mg-bomberarena-css', [
      '.bmb-wrap{display:flex;flex-direction:column;gap:10px;align-items:stretch;}',
      /* Kopf */
      '.bmb-head{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:9px 16px;}',
      '.bmb-round{font-weight:900;font-size:clamp(12px,3vw,15px);color:var(--leaf);text-transform:uppercase;letter-spacing:1.5px;}',
      '.bmb-timer{font-size:clamp(18px,5vw,26px);font-variant-numeric:tabular-nums;}',
      '.bmb-timer.bmb-urgent{color:var(--danger);animation:bmb-blink .7s infinite;}',
      '.bmb-warn{font-size:11px;font-weight:900;letter-spacing:1px;color:var(--danger);opacity:0;transition:opacity .3s;text-transform:uppercase;}',
      '.bmb-warn.on{opacity:1;animation:bmb-blink .9s infinite;}',
      /* Spieler-Chips */
      '.bmb-chips{display:flex;gap:6px;flex-wrap:wrap;justify-content:center;}',
      /* min-width:0 -> Chips duerfen unter ihre Inhaltsbreite schrumpfen (Name kuerzt mit …),
         sonst brechen 4 Spieler auf zwei Zeilen um (3+1). */
      '.bmb-chip{display:flex;align-items:center;gap:7px;padding:5px 10px;border-radius:11px;',
      'background:rgba(4,16,10,.66);border:1px solid var(--stroke);min-width:0;flex:1 1 132px;max-width:220px;transition:opacity .3s,filter .3s;}',
      '.bmb-chip.out{opacity:.35;filter:grayscale(1);}',
      '.bmb-chip-dot{width:11px;height:11px;border-radius:50%;flex:0 0 auto;}',
      '.bmb-chip-info{display:flex;flex-direction:column;gap:1px;min-width:0;flex:1;}',
      '.bmb-chip-name{font-weight:800;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#e6ffe9;}',
      '.bmb-chip-stats{font-size:10px;color:var(--muted);font-variant-numeric:tabular-nums;white-space:nowrap;}',
      '.bmb-chip-wins{font-weight:900;font-size:15px;color:var(--gold);font-variant-numeric:tabular-nums;}',
      '.bmb-c0 .bmb-chip-dot{background:var(--neon);box-shadow:0 0 8px var(--neon);}',
      '.bmb-c0{border-color:rgba(57,255,20,.45);}',
      '.bmb-c1 .bmb-chip-dot{background:var(--aqua);box-shadow:0 0 8px var(--aqua);}',
      '.bmb-c1{border-color:rgba(51,230,208,.45);}',
      '.bmb-c2 .bmb-chip-dot{background:var(--gold);box-shadow:0 0 8px var(--gold);}',
      '.bmb-c2{border-color:rgba(255,210,63,.45);}',
      '.bmb-c3 .bmb-chip-dot{background:var(--danger);box-shadow:0 0 8px var(--danger);}',
      '.bmb-c3{border-color:rgba(255,77,109,.45);}',
      /* Arena */
      '.bmb-stage{width:100%;max-width:620px;margin:0 auto;position:relative;aspect-ratio:13 / 11;}',
      '.bmb-canvas{display:block;width:100%;height:auto;border-radius:14px;border:2px solid rgba(57,255,20,.32);',
      'background:#03100a;box-shadow:0 0 38px rgba(57,255,20,.2),inset 0 0 60px rgba(57,255,20,.05);',
      'touch-action:none;user-select:none;-webkit-user-select:none;-webkit-tap-highlight-color:transparent;}',
      /* Banner */
      '.bmb-banner{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%) scale(.9);opacity:0;pointer-events:none;',
      'padding:10px 22px;border-radius:14px;font-weight:900;font-size:clamp(14px,3.6vw,22px);text-align:center;',
      'background:rgba(3,12,7,.86);border:1px solid var(--stroke-2);white-space:nowrap;transition:opacity .2s,transform .2s;}',
      '.bmb-banner.show{opacity:1;transform:translate(-50%,-50%) scale(1);}',
      '.bmb-banner.win{color:var(--neon);text-shadow:0 0 16px rgba(57,255,20,.6);border-color:var(--neon);}',
      '.bmb-banner.lose{color:var(--aqua-soft);border-color:var(--stroke-2);}',
      '.bmb-banner.draw{color:var(--gold);border-color:rgba(255,210,63,.5);}',
      '.bmb-banner.spec{color:var(--silver);font-size:clamp(12px,3vw,16px);top:14%;}',
      '.bmb-banner.go{color:var(--neon);font-size:clamp(20px,6vw,34px);animation:bmb-pop .3s ease;}',
      '.bmb-hint{text-align:center;font-size:11px;line-height:1.5;margin:0;}',
      /* Touch-Steuerung */
      '.bmb-touch{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:4px 6px 8px;max-width:340px;margin:0 auto;width:100%;}',
      '.bmb-dpad{display:grid;grid-template-columns:repeat(3,44px);grid-template-rows:repeat(3,44px);gap:4px;touch-action:none;}',
      '.bmb-pad{border:1px solid var(--stroke);background:rgba(4,16,10,.8);color:var(--leaf);border-radius:10px;',
      'font-size:15px;font-family:inherit;display:flex;align-items:center;justify-content:center;cursor:pointer;',
      'touch-action:none;-webkit-tap-highlight-color:transparent;user-select:none;padding:0;}',
      '.bmb-pad.on{background:var(--neon);color:#04160c;border-color:#eaffe2;box-shadow:0 0 14px rgba(57,255,20,.6);}',
      '.bmb-pu{grid-column:2;grid-row:1;} .bmb-pl{grid-column:1;grid-row:2;} .bmb-pr{grid-column:3;grid-row:2;} .bmb-pd{grid-column:2;grid-row:3;}',
      '.bmb-bombbtn{width:88px;height:88px;border-radius:50%;font-size:36px;line-height:1;cursor:pointer;',
      'border:2px solid var(--stroke-2);background:radial-gradient(circle at 40% 34%,#123f26,#04160c 74%);',
      'box-shadow:0 0 22px rgba(57,255,20,.28);touch-action:none;-webkit-tap-highlight-color:transparent;user-select:none;',
      'display:flex;align-items:center;justify-content:center;padding:0;transition:transform .07s,box-shadow .12s;}',
      '.bmb-bombbtn.on{transform:scale(.92);box-shadow:0 0 34px rgba(57,255,20,.75);border-color:var(--neon);}',
      /* Vorab-Bildschirm */
      '.bmb-pre{padding:28px 22px;text-align:center;display:flex;flex-direction:column;gap:12px;align-items:center;max-width:520px;margin:0 auto;}',
      '.bmb-pre-icon{font-size:54px;line-height:1;filter:drop-shadow(0 0 16px rgba(57,255,20,.5));animation:bmb-bob 1.8s ease-in-out infinite;}',
      '.bmb-pre h2{margin:0;}',
      '.bmb-pre-hint{margin:0;font-size:11px;}',
      '.bmb-diff-row{display:flex;gap:8px;flex-wrap:wrap;justify-content:center;width:100%;}',
      '.bmb-diff{flex:1 1 140px;max-width:200px;display:flex;flex-direction:column;align-items:center;gap:3px;padding:14px 10px;',
      'border:1px solid var(--stroke);background:rgba(4,16,10,.7);border-radius:14px;cursor:pointer;transition:border-color .15s,transform .12s,box-shadow .15s;}',
      '.bmb-diff:hover{border-color:var(--neon);transform:translateY(-2px);box-shadow:0 0 20px rgba(57,255,20,.3);}',
      '.bmb-diff-icon{font-size:26px;line-height:1;}',
      '.bmb-diff-l{font-weight:900;font-size:15px;color:var(--leaf);}',
      '.bmb-diff-d{font-size:11px;color:var(--muted);}',
      '.bmb-diff-m{font-size:10px;font-weight:800;color:var(--gold);letter-spacing:.5px;}',
      /* Animationen */
      '@keyframes bmb-blink{0%,100%{opacity:1}50%{opacity:.35}}',
      '@keyframes bmb-bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-7px)}}',
      '@keyframes bmb-pop{0%{transform:translate(-50%,-50%) scale(1.5);opacity:0}100%{transform:translate(-50%,-50%) scale(1);opacity:1}}'
    ].join(''));
  }
})();
