/* trickytower.js — "Wackelturm": eine Tricky-Towers-Abwandlung im Neon-Dschungel.
 *
 * Jeder Spieler baut auf einer SCHMALEN Neon-Plattform seinen eigenen Turm aus
 * fallenden Tetris-Blöcken (I, O, L, J, T, S, Z). Ziel: möglichst HOCH bauen —
 * es zählt die Turmhöhe. Der "tricky" Kniff ist die BALANCE: der Turm ist nicht
 * gitter-starr, sondern wackelt und kippt, wenn sein Masse-Schwerpunkt zu weit
 * über die schmale Auflagefläche (Plattform) hinausdriftet. Ein sauber zentriert
 * gestapelter Turm bleibt stehen — überhängende, schlecht platzierte Blöcke lassen
 * die Spitze abrutschen (die obersten Blöcke kippen animiert weg → Höhenverlust).
 * Eine Stabilitäts-Anzeige zeigt live, wie kippgefährdet der Turm gerade ist.
 *
 * Modus: RENNEN auf Zeit (120 s). Es gibt eine markierte ZIEL-LINIE (Höhe 15).
 * Wer seinen Turm zuerst STABIL über die Ziel-Linie bringt, gewinnt sofort die
 * Runde. Erreicht niemand die Linie, gewinnt bei Zeitablauf der höchste Turm.
 *
 * Steuerung: ◀ ▶ bewegen, 🔄 drehen, ⬇ ablegen. Desktop: Pfeiltasten + WASD +
 * Leertaste. Handy: große On-Screen-Buttons UND Tap/Wisch aufs Feld (links/rechts
 * tippen = bewegen, Mitte tippen = drehen, nach unten wischen = ablegen).
 *
 * Balance-Modell: pragmatisch & robust (kein voller Rigid-Body-Physik-Engine).
 * Blöcke werden gitterbasiert (spaltenweise) rigide abgelegt (auch mit Überhang),
 * die Stabilität ergibt sich aus dem horizontalen Schwerpunkt relativ zur
 * Plattform. Zu weit außerhalb → die obersten Blöcke kippen weg. Deterministisch,
 * bug-frei, aber es fühlt sich wacklig an (sichtbares Neigen + Schwanken).
 *
 * Canvas-Render über rAF mit geclamptem Zeit-Delta (Date.now / room.now) -> Tab-sicher.
 * Singleplayer (Bestwert) + Multiplayer (synchroner Start, Live-Höhen-Rangliste). */
(function () {
  'use strict';
  window.App = window.App || {}; App.Minigames = App.Minigames || {};
  var UI = App.UI, el = UI.el, MG = App.MG;

  var DURATION = 120;      // Sekunden Rundenzeit (single + multi)
  var FIELD_COLS = 9;      // Spalten des Spielfelds (inkl. Überhang-Reserve)
  var BASE_L = 3, BASE_W = 3; // Plattform: schmal, mittig (Spalten 3..5)
  var GOAL_ROWS = 15;      // Ziel-Linie: Turmhöhe in Reihen
  var SAFE_HALF = 1.55;    // halbe Auflagefläche in Zellen (Schwerpunkt-Toleranz)
  var BASE_CX = BASE_L + BASE_W / 2; // Plattform-Mitte in Spalten (=4.5)

  /* Tetromino-Typen: Zellen [dc,dr] (dr = nach oben), + Neon-Farbton. */
  var TYPES = [
    { cells: [[0, 0], [1, 0], [2, 0], [3, 0]], hue: 174 }, // I  aqua
    { cells: [[0, 0], [1, 0], [0, 1], [1, 1]], hue: 47 },  // O  gold
    { cells: [[0, 0], [1, 0], [2, 0], [1, 1]], hue: 300 }, // T  magenta
    { cells: [[0, 0], [1, 0], [2, 0], [2, 1]], hue: 30 },  // L  orange
    { cells: [[0, 0], [1, 0], [2, 0], [0, 1]], hue: 262 }, // J  violett
    { cells: [[0, 0], [1, 0], [1, 1], [2, 1]], hue: 116 }, // S  neon-grün
    { cells: [[1, 0], [2, 0], [0, 1], [1, 1]], hue: 340 }  // Z  pink
  ];

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function normalize(cells) {
    var mc = Infinity, mr = Infinity;
    cells.forEach(function (c) { if (c[0] < mc) mc = c[0]; if (c[1] < mr) mr = c[1]; });
    return cells.map(function (c) { return [c[0] - mc, c[1] - mr]; });
  }
  function rotateCells(cells) { return normalize(cells.map(function (c) { return [c[1], -c[0]]; })); }
  function pieceWidth(cells) { var m = 0; cells.forEach(function (c) { if (c[0] > m) m = c[0]; }); return m + 1; }

  App.Minigames.trickytower = {
    id: 'trickytower', title: 'Wackelturm', icon: '🗼', order: 27,
    subtitle: 'Stapelt Blöcke zum höchsten Turm – aber balanciert, sonst kippt er',
    single: true, multi: true, minPlayers: 2, maxPlayers: 4,

    render: function (root, ctx) {
      injectStyle();
      var isMulti = ctx.mode === 'multi';
      var clock = isMulti ? ctx.room.now : Date.now;

      /* ---- Aufräum-Register (ALLES muss in cleanup weg) ---- */
      var stops = [], listeners = [], tos = [], ivs = [], raf = null, ro = null;
      var dead = false, finished = false;
      function addL(t, e, fn) { t.addEventListener(e, fn); listeners.push({ t: t, e: e, fn: fn }); }
      function after(ms, fn) { var t = setTimeout(fn, ms); tos.push(t); return t; }
      function every(ms, fn) { var t = setInterval(fn, ms); ivs.push(t); return t; }
      function stopAll() {
        if (raf) { cancelAnimationFrame(raf); raf = null; }
        stops.forEach(function (f) { try { f(); } catch (e) {} }); stops = [];
        listeners.forEach(function (l) { try { l.t.removeEventListener(l.e, l.fn); } catch (e) {} }); listeners = [];
        tos.forEach(clearTimeout); tos = [];
        ivs.forEach(clearInterval); ivs = [];
        if (ro) { try { ro.disconnect(); } catch (e) {} ro = null; }
      }
      function cleanup() { dead = true; stopAll(); }

      /* ---- Runden-Zustand ---- */
      var V = { W: 320, H: 480, dpr: 1 };
      var CELL = 30, fieldX0 = 0, PED_H = 20, pivotX = 0, pivotY = 0;
      var placed = [];        // [{cells:[{col,row,hue}], hue}]
      var colTopMap = {};     // col -> erste freie Reihe (Höhe der Spalte)
      var active = null;      // {cells:[[dc,dr]], hue, leftCol, oy}
      var fallers = [], particles = [];
      var height = 0, comCol = BASE_CX, overhang = 0, ratio = 0;
      var leanCur = 0, shakeAmp = 0, cam = 0;
      var phase = 'play', score = 0, maxHeight = 0, lastTs = 0, endAt = 0;
      var reportedReached = false, singleGoalToasted = false, resolving = false;

      var stageEl = null, canvas = null, g2 = null, bannerEl = null;
      var hudHeight = null, hudGoal = null, hudTimer = null, stabFill = null, prevCv = null, prevG2 = null;
      var boardWrap = null, board = null;
      var bag = [];

      /* ---- Start ---- */
      if (isMulti) {
        var snap = ctx.room.snapshot() || {};
        var startAt = (snap.round && snap.round.startAt) || (ctx.room.now() + 3000);
        stops.push(MG.countdown(root, startAt, function () { startGame(startAt); }, ctx.room.now));
      } else {
        startGame(Date.now());
      }
      return { cleanup: cleanup };

      /* ===================== LAYOUT / MAPPING ===================== */
      function computeLayout() {
        CELL = clamp(Math.min(V.W / FIELD_COLS, V.H / 13), 15, 60);
        var fieldW = FIELD_COLS * CELL;
        fieldX0 = (V.W - fieldW) / 2;
        PED_H = clamp(CELL * 0.55, 12, 30);
        pivotY = V.H - PED_H - 6;
        pivotX = fieldX0 + BASE_CX * CELL;
      }
      function sX(col) { return fieldX0 + col * CELL; }
      function sYtop(row) { return pivotY - ((row + 1) * CELL - cam); } // Screen-y der Zell-Oberkante

      function measure() {
        var r = stageEl.getBoundingClientRect();
        V.W = Math.max(160, Math.round(r.width));
        V.H = Math.max(280, Math.round(r.height));
        V.dpr = Math.min(2, window.devicePixelRatio || 1);
      }
      function setupBuffer() {
        canvas.width = Math.round(V.W * V.dpr);
        canvas.height = Math.round(V.H * V.dpr);
        g2.setTransform(V.dpr, 0, 0, V.dpr, 0, 0);
        computeLayout();
      }
      function onResize() { if (!stageEl || !canvas) return; measure(); setupBuffer(); }

      /* ===================== GRID / BALANCE ===================== */
      function colTop(col) {
        if (colTopMap[col] !== undefined) return colTopMap[col];
        if (col >= BASE_L && col < BASE_L + BASE_W) return 0; // Plattform trägt bei Reihe 0
        return -Infinity; // ins Leere
      }
      function restRow(cells, leftCol) {
        var byCol = {};
        cells.forEach(function (c) {
          var col = leftCol + c[0];
          if (byCol[col] === undefined || c[1] < byCol[col]) byCol[col] = c[1];
        });
        var rest = -Infinity;
        Object.keys(byCol).forEach(function (k) {
          var h = colTop(+k); if (h === -Infinity) return;
          var r = h - byCol[k]; if (r > rest) rest = r;
        });
        return rest;
      }
      function recompute() {
        colTopMap = {};
        var sumCol = 0, n = 0, maxRow = 0, has = false;
        placed.forEach(function (p) {
          p.cells.forEach(function (c) {
            var t = c.row + 1;
            if (colTopMap[c.col] === undefined || t > colTopMap[c.col]) colTopMap[c.col] = t;
            sumCol += (c.col + 0.5); n++; if (t > maxRow) maxRow = t; has = true;
          });
        });
        height = has ? maxRow : 0;
        comCol = n ? sumCol / n : BASE_CX;
        overhang = comCol - BASE_CX;
        ratio = overhang / SAFE_HALF;
      }
      /* Kippt die obersten Blöcke weg, bis der Schwerpunkt wieder sicher über der
         Plattform liegt. Gibt true zurück, wenn etwas gekippt ist. */
      function resolveBalance() {
        var toppled = false, guard = 0;
        while (Math.abs(ratio) > 1 && placed.length > 0 && guard < 80) {
          guard++;
          var p = placed.pop();
          var dir = overhang > 0 ? 1 : -1;
          p.cells.forEach(function (c) { spawnFaller(c.col + 0.5, c.row, c.hue, dir * (2.2 + Math.random() * 2)); });
          recompute();
          toppled = true;
          if (Math.abs(ratio) <= 0.82) break;
        }
        if (toppled) { shakeAmp = 15; crashFlash(); }
        return toppled;
      }

      /* ===================== BLOCK-STEUERUNG ===================== */
      function nextFromBag() {
        if (!bag.length) {
          bag = [0, 1, 2, 3, 4, 5, 6];
          for (var i = bag.length - 1; i > 0; i--) { var j = Math.floor(Math.random() * (i + 1)); var t = bag[i]; bag[i] = bag[j]; bag[j] = t; }
        }
        return TYPES[bag.pop()];
      }
      function spawnNext() {
        if (finished || dead) return;
        var t = nextFromBag();
        var cells = t.cells.map(function (c) { return [c[0], c[1]]; });
        var w = pieceWidth(cells);
        var left = clamp(BASE_L + Math.floor((BASE_W - w) / 2), 0, FIELD_COLS - w);
        active = { cells: cells, hue: t.hue, leftCol: left, oy: height + 4.2 };
        drawPreview();
      }
      function clampLeft() {
        if (!active) return;
        active.leftCol = clamp(active.leftCol, 0, FIELD_COLS - pieceWidth(active.cells));
      }
      function moveLeft() { if (active && phase === 'play') { active.leftCol -= 1; clampLeft(); } }
      function moveRight() { if (active && phase === 'play') { active.leftCol += 1; clampLeft(); } }
      function rotateActive() {
        if (!active || phase !== 'play') return;
        active.cells = rotateCells(active.cells);
        clampLeft();
      }
      function hardDrop() {
        if (!active || phase !== 'play' || finished) return;
        var rest = restRow(active.cells, active.leftCol);
        if (rest === -Infinity) { wastePiece(); return; }
        active.oy = rest; lockPiece(rest);
      }
      function wastePiece() {
        if (!active) return;
        active.cells.forEach(function (c) {
          spawnFaller(active.leftCol + c[0] + 0.5, active.oy + c[1], active.hue, (Math.random() - 0.5) * 3);
        });
        active = null;
        if (App.Audio) App.Audio.sfx('error');
        crashFlash();
        spawnNext();
      }
      function lockPiece(rest) {
        var hue = active.hue;
        var cx = 0, cyRow = 0, cells = active.cells.map(function (c) {
          var col = active.leftCol + c[0], row = rest + c[1];
          cx += col + 0.5; cyRow = Math.max(cyRow, row);
          return { col: col, row: row, hue: hue };
        });
        cx /= cells.length;
        placed.push({ cells: cells, hue: hue });
        recompute();
        var toppled = resolveBalance();
        if (App.Audio) App.Audio.sfx(toppled ? 'hit' : 'pop');
        if (!toppled) spawnParticles(sX(cx), sYtop(cyRow), hue);
        active = null;
        onHeightChanged();
        spawnNext();
      }
      function onHeightChanged() {
        score = height;
        if (height > maxHeight) maxHeight = height;
        updateHud();
        if (isMulti) ctx.room.reportScore(score);
        checkGoal();
      }
      function checkGoal() {
        if (finished || phase !== 'play') return;
        if (height >= GOAL_ROWS && Math.abs(ratio) <= 1) {
          if (isMulti) {
            if (!reportedReached) {
              reportedReached = true;
              ctx.room.reportState({ r: clock() });
              showBanner('🏁 Ziel-Linie erreicht!');
              UI.toast('Du hast die Ziel-Linie erreicht!', 'win');
            }
          } else if (!singleGoalToasted) {
            singleGoalToasted = true;
            showBanner('🏁 Ziel-Linie geschafft!');
            UI.toast('Ziel-Linie erreicht! Bau weiter für mehr Höhe.', 'win');
          }
        }
      }

      /* ===================== FALLER / PARTIKEL ===================== */
      function spawnFaller(col, row, hue, vx) {
        fallers.push({ x: col, y: row, hue: hue, vx: vx, vy: -(1 + Math.random() * 1.5), rot: 0, vr: (Math.random() - 0.5) * 7 });
      }
      function updateFallers(dt) {
        for (var i = 0; i < fallers.length; i++) {
          var f = fallers[i];
          f.vy -= 26 * dt; f.x += f.vx * dt; f.y += f.vy * dt; f.rot += f.vr * dt;
        }
        fallers = fallers.filter(function (f) { return sYtop(f.y) < V.H + 160; });
      }
      function spawnParticles(sx, sy, hue) {
        for (var i = 0; i < 12; i++) {
          var a = Math.random() * Math.PI * 2, sp = V.H * (0.2 + Math.random() * 0.5);
          particles.push({
            x: sx + (Math.random() - 0.5) * CELL, y: sy,
            vx: Math.cos(a) * sp * 0.6, vy: -Math.abs(Math.sin(a)) * sp - V.H * 0.08,
            life: 0.45 + Math.random() * 0.4, max: 0.85, hue: hue
          });
        }
      }
      function updateParticles(dt) {
        for (var i = 0; i < particles.length; i++) {
          var p = particles[i]; p.vy += V.H * 2.2 * dt; p.x += p.vx * dt; p.y += p.vy * dt; p.life -= dt;
        }
        particles = particles.filter(function (p) { return p.life > 0 && p.y < V.H + 40; });
      }

      /* ===================== HAUPT-LOOP ===================== */
      function frame() {
        if (dead || finished) return;
        var now = clock();
        var dt = clamp((now - lastTs) / 1000, 0, 0.05);
        lastTs = now;

        if (phase === 'play' && active) {
          var grav = 2.6 + Math.min(height * 0.06, 3.2);
          active.oy -= grav * dt;
          var rest = restRow(active.cells, active.leftCol);
          if (rest !== -Infinity && active.oy <= rest) lockPiece(rest);
          else if (active.oy < -4) wastePiece();
        }

        var camTarget = Math.max(0, height * CELL - V.H * 0.48);
        if (active) camTarget = Math.max(camTarget, (active.oy + 2) * CELL - V.H * 0.78);
        cam += (camTarget - cam) * Math.min(1, dt * 6);

        updateFallers(dt);
        updateParticles(dt);
        var targetLean = clamp(ratio, -1, 1) * 0.2;
        leanCur += (targetLean - leanCur) * Math.min(1, dt * 8);
        if (shakeAmp > 0.3) shakeAmp *= Math.pow(0.0016, dt); else shakeAmp = 0;

        draw(now);
        raf = requestAnimationFrame(frame);
      }

      /* ===================== ZEICHNEN ===================== */
      function roundRect(x, y, w, h, r) {
        r = Math.min(r, w / 2, h / 2);
        g2.beginPath();
        g2.moveTo(x + r, y);
        g2.arcTo(x + w, y, x + w, y + h, r);
        g2.arcTo(x + w, y + h, x, y + h, r);
        g2.arcTo(x, y + h, x, y, r);
        g2.arcTo(x, y, x + w, y, r);
        g2.closePath();
      }
      function drawCell(x, y, s, hue, opt) {
        opt = opt || {};
        if (opt.ghost) {
          g2.save();
          g2.globalAlpha = 0.5; g2.setLineDash([4, 4]);
          g2.strokeStyle = 'hsla(' + hue + ',100%,72%,0.7)'; g2.lineWidth = 1.5;
          roundRect(x + 1.5, y + 1.5, s - 3, s - 3, Math.min(6, s / 4)); g2.stroke();
          g2.restore();
          return;
        }
        var isActive = opt.active, alpha = opt.alpha == null ? 1 : opt.alpha;
        var light = isActive ? 66 : 54;
        var pulse = isActive ? (0.75 + 0.25 * Math.sin(Date.now() / 160)) : 1;
        var grad = g2.createLinearGradient(0, y, 0, y + s);
        grad.addColorStop(0, 'hsl(' + hue + ',100%,' + (light + 12) + '%)');
        grad.addColorStop(1, 'hsl(' + hue + ',82%,' + (light - 20) + '%)');
        g2.save();
        g2.globalAlpha = alpha;
        g2.shadowColor = 'hsl(' + hue + ',100%,55%)';
        g2.shadowBlur = (isActive ? 22 : 11) * pulse;
        g2.fillStyle = grad;
        roundRect(x + 0.6, y + 0.6, s - 1.2, s - 1.2, Math.min(6, s / 4)); g2.fill();
        g2.shadowBlur = 0;
        g2.fillStyle = 'hsla(' + hue + ',100%,90%,' + (isActive ? 0.42 : 0.24) + ')';
        roundRect(x + 2.4, y + 2.4, Math.max(0, s - 4.8), Math.max(1, s * 0.26), 3); g2.fill();
        g2.strokeStyle = 'hsla(' + hue + ',100%,86%,' + (isActive ? 0.95 : 0.55) + ')';
        g2.lineWidth = 1.3;
        roundRect(x + 0.6, y + 0.6, s - 1.2, s - 1.2, Math.min(6, s / 4)); g2.stroke();
        g2.restore();
      }

      function draw(now) {
        computeLayout();
        var W = V.W, H = V.H;
        var bg = g2.createLinearGradient(0, 0, 0, H);
        bg.addColorStop(0, '#06180f'); bg.addColorStop(1, '#020a06');
        g2.fillStyle = bg; g2.fillRect(0, 0, W, H);

        g2.save();
        if (shakeAmp) g2.translate((Math.random() - 0.5) * shakeAmp, (Math.random() - 0.5) * shakeAmp);

        // Tiefen-Linien
        g2.save();
        g2.strokeStyle = 'rgba(57,255,20,0.05)'; g2.lineWidth = 1;
        var step = CELL * 2, kStart = Math.floor(cam / step);
        for (var k = kStart; k < kStart + 40; k++) {
          var ly = pivotY - (k * step - cam);
          if (ly < -step) break; if (ly > H + step) continue;
          g2.beginPath(); g2.moveTo(0, ly); g2.lineTo(W, ly); g2.stroke();
        }
        g2.restore();

        // Ziel-Linie (Oberkante der Zielreihe)
        var gy = pivotY - (GOAL_ROWS * CELL - cam);
        if (gy > -30 && gy < H + 30) {
          g2.save();
          g2.strokeStyle = height >= GOAL_ROWS ? 'rgba(255,210,63,0.95)' : 'rgba(51,230,208,0.85)';
          g2.lineWidth = 2; g2.setLineDash([10, 7]);
          g2.shadowColor = height >= GOAL_ROWS ? 'rgba(255,210,63,0.8)' : 'rgba(51,230,208,0.7)';
          g2.shadowBlur = 12;
          g2.beginPath(); g2.moveTo(0, gy); g2.lineTo(W, gy); g2.stroke();
          g2.setLineDash([]); g2.shadowBlur = 0;
          g2.fillStyle = height >= GOAL_ROWS ? 'rgba(255,210,63,0.95)' : 'rgba(51,230,208,0.9)';
          g2.font = '900 ' + Math.round(clamp(CELL * 0.5, 11, 20)) + 'px system-ui,sans-serif';
          g2.textAlign = 'left'; g2.textBaseline = 'bottom';
          g2.fillText('ZIEL', 8, gy - 4);
          g2.restore();
        }

        // Plattform (fest, kippt nicht)
        drawPedestal();

        // Geisterbild (Landeposition, aufrecht)
        if (phase === 'play' && active) {
          var rest = restRow(active.cells, active.leftCol);
          if (rest !== -Infinity) {
            active.cells.forEach(function (c) {
              drawCell(sX(active.leftCol + c[0]), sYtop(rest + c[1]), CELL, active.hue, { ghost: true });
            });
          }
        }

        // Turm (mit Neigung/Wackeln um die Plattform-Mitte)
        var sway = Math.sin(now * 0.004) * (0.012 + 0.028 * Math.min(1, Math.abs(ratio))) * (0.5 + Math.min(1, height / GOAL_ROWS));
        var lean = leanCur + sway;
        g2.save();
        g2.translate(pivotX, pivotY); g2.rotate(lean); g2.translate(-pivotX, -pivotY);
        placed.forEach(function (p) {
          p.cells.forEach(function (c) {
            var y = sYtop(c.row);
            if (y > H + CELL || y + CELL < -CELL) return;
            drawCell(sX(c.col), y, CELL, c.hue, {});
          });
        });
        g2.restore();

        // Aktiver Block (aufrecht)
        if (active) {
          active.cells.forEach(function (c) {
            drawCell(sX(active.leftCol + c[0]), sYtop(active.oy + c[1]), CELL, active.hue, { active: true });
          });
        }

        // Fallende Blöcke
        fallers.forEach(function (f) {
          var x = sX(f.x - 0.5), y = sYtop(f.y);
          if (y > H + 120) return;
          g2.save();
          g2.translate(x + CELL / 2, y + CELL / 2); g2.rotate(f.rot); g2.translate(-(x + CELL / 2), -(y + CELL / 2));
          drawCell(x, y, CELL, f.hue, { alpha: 0.9 });
          g2.restore();
        });

        // Partikel
        particles.forEach(function (p) {
          var al = Math.max(0, p.life / p.max);
          g2.save();
          g2.globalAlpha = al;
          g2.shadowColor = 'hsl(' + p.hue + ',100%,60%)'; g2.shadowBlur = 8;
          g2.fillStyle = 'hsl(' + p.hue + ',100%,72%)';
          g2.beginPath(); g2.arc(p.x, p.y, 3, 0, Math.PI * 2); g2.fill();
          g2.restore();
        });

        g2.restore();
      }

      function drawPedestal() {
        var x = sX(BASE_L), w = BASE_W * CELL, y = pivotY;
        g2.save();
        var grad = g2.createLinearGradient(0, y, 0, y + PED_H);
        grad.addColorStop(0, 'hsl(150,90%,60%)');
        grad.addColorStop(1, 'hsl(158,80%,32%)');
        g2.shadowColor = 'rgba(57,255,20,0.7)'; g2.shadowBlur = 18;
        g2.fillStyle = grad;
        roundRect(x, y, w, PED_H, 6); g2.fill();
        g2.shadowBlur = 0;
        // schmaler Standfuß
        g2.fillStyle = 'rgba(9,32,21,0.9)';
        var fw = w * 0.34, fx = x + (w - fw) / 2;
        g2.fillRect(fx, y + PED_H, fw, V.H);
        g2.strokeStyle = 'rgba(57,255,20,0.4)'; g2.lineWidth = 1.5;
        g2.strokeRect(fx, y + PED_H, fw, V.H);
        g2.restore();
      }

      function drawPreview() {
        if (!prevG2 || !active) return;
        var g = prevG2, cw = prevCv.width, ch = prevCv.height;
        g.clearRect(0, 0, cw, ch);
        var cells = active.cells, hue = active.hue;
        var w = pieceWidth(cells), h = 0;
        cells.forEach(function (c) { if (c[1] > h) h = c[1]; }); h += 1;
        var s = Math.min((cw - 8) / w, (ch - 8) / h);
        var ox = (cw - w * s) / 2, oy = (ch - h * s) / 2;
        cells.forEach(function (c) {
          var x = ox + c[0] * s, y = oy + (h - 1 - c[1]) * s;
          var grad = g.createLinearGradient(0, y, 0, y + s);
          grad.addColorStop(0, 'hsl(' + hue + ',100%,66%)');
          grad.addColorStop(1, 'hsl(' + hue + ',82%,42%)');
          g.fillStyle = grad;
          g.fillRect(x + 1, y + 1, s - 2, s - 2);
          g.strokeStyle = 'hsla(' + hue + ',100%,85%,0.7)'; g.lineWidth = 1;
          g.strokeRect(x + 1, y + 1, s - 2, s - 2);
        });
      }

      /* ===================== HUD / EFFEKTE ===================== */
      function updateHud() {
        if (!hudHeight) return;
        hudHeight.textContent = String(height);
        var st = clamp(1 - Math.abs(ratio), 0, 1);
        stabFill.style.width = Math.round(st * 100) + '%';
        stabFill.style.background = st > 0.6 ? 'var(--neon)' : (st > 0.3 ? 'var(--gold)' : 'var(--danger)');
        stabFill.style.boxShadow = '0 0 10px ' + (st > 0.6 ? 'rgba(57,255,20,.6)' : (st > 0.3 ? 'rgba(255,210,63,.6)' : 'rgba(255,77,109,.6)'));
      }
      function showBanner(txt) {
        if (!stageEl) return;
        if (bannerEl && bannerEl.parentNode) bannerEl.parentNode.removeChild(bannerEl);
        bannerEl = el('div', { class: 'tt-banner' }, [txt]);
        stageEl.appendChild(bannerEl);
        var b = bannerEl;
        after(1400, function () { if (b && b.parentNode) b.parentNode.removeChild(b); });
      }
      function crashFlash() {
        if (!stageEl) return;
        var f = el('div', { class: 'tt-crash' }, ['WACKELT!']);
        stageEl.appendChild(f);
        after(900, function () { if (f.parentNode) f.parentNode.removeChild(f); });
      }

      /* ===================== UI-AUFBAU ===================== */
      function buildUI() {
        hudHeight = el('div', { class: 'tt-height big-readout' }, ['0']);
        hudGoal = el('div', { class: 'tt-goal' }, ['Ziel ' + GOAL_ROWS]);
        hudTimer = el('div', { class: 'mg-timer tt-timer' }, [MG.mmss(DURATION)]);
        stabFill = el('div', { class: 'tt-stab-fill' });
        prevCv = el('canvas', { class: 'tt-preview', width: 60, height: 46 });

        var hud = el('div', { class: 'tt-hud glass' }, [
          el('div', { class: 'tt-hud-cell' }, [el('span', { class: 'tt-hud-l' }, ['Höhe']), hudHeight, hudGoal]),
          el('div', { class: 'tt-hud-mid' }, [
            el('span', { class: 'tt-hud-l' }, ['Stabilität']),
            el('div', { class: 'tt-stab' }, [stabFill]),
            el('div', { class: 'tt-next-row' }, [el('span', { class: 'tt-hud-l' }, ['Nächster']), prevCv])
          ]),
          el('div', { class: 'tt-hud-cell tt-hud-right' }, [el('span', { class: 'tt-hud-l' }, ['Zeit']), hudTimer])
        ]);

        canvas = el('canvas', { class: 'tt-canvas' });
        stageEl = el('div', { class: 'game-stage tt-stage' }, [canvas]);

        var btnL = el('button', { class: 'tt-btn', type: 'button', 'aria-label': 'Links' }, ['◀']);
        var btnR = el('button', { class: 'tt-btn', type: 'button', 'aria-label': 'Rechts' }, ['▶']);
        var btnRot = el('button', { class: 'tt-btn tt-btn-rot', type: 'button', 'aria-label': 'Drehen' }, ['🔄']);
        var btnDrop = el('button', { class: 'tt-btn tt-btn-drop', type: 'button', 'aria-label': 'Ablegen' }, ['⬇']);
        var controls = el('div', { class: 'tt-controls' }, [btnL, btnRot, btnDrop, btnR]);

        var hint = el('div', { class: 'hint-text tt-hint' }, ['◀ ▶ bewegen · 🔄 drehen · ⬇ ablegen — halte den Schwerpunkt über der Plattform!']);

        var pieces = [hud, stageEl, controls, hint];
        boardWrap = null;
        if (isMulti) {
          boardWrap = el('div', { class: 'glass tt-board-wrap' }, [el('div', { class: 'mg-field-title' }, ['🏆 Turmhöhen'])]);
          pieces.push(boardWrap);
        }
        root.innerHTML = '';
        root.appendChild(el('div', { class: 'tt-layout' }, pieces));
        g2 = canvas.getContext('2d');
        prevG2 = prevCv.getContext('2d');

        // Buttons
        bindHold(btnL, moveLeft); bindHold(btnR, moveRight);
        bindTap(btnRot, rotateActive); bindTap(btnDrop, hardDrop);
      }
      function bindHold(btn, fn) {
        var iv = null;
        function stop() { if (iv) { clearInterval(iv); iv = null; } }
        addL(btn, 'pointerdown', function (e) { if (e && e.cancelable) e.preventDefault(); fn(); stop(); iv = every(120, fn); });
        addL(btn, 'pointerup', stop); addL(btn, 'pointerleave', stop); addL(btn, 'pointercancel', stop);
      }
      function bindTap(btn, fn) {
        addL(btn, 'pointerdown', function (e) { if (e && e.cancelable) e.preventDefault(); fn(); });
      }

      function addInput() {
        // Tastatur
        addL(window, 'keydown', function (e) {
          if (finished || dead || phase !== 'play') return;
          var k = e.key;
          if (k === 'ArrowLeft' || k === 'a' || k === 'A') { e.preventDefault(); moveLeft(); }
          else if (k === 'ArrowRight' || k === 'd' || k === 'D') { e.preventDefault(); moveRight(); }
          else if (k === 'ArrowUp' || k === 'w' || k === 'W') { e.preventDefault(); rotateActive(); }
          else if (k === 'ArrowDown' || k === 's' || k === 'S' || k === ' ' || e.code === 'Space') { e.preventDefault(); hardDrop(); }
        });
        // Tap / Wisch aufs Feld
        var pdX = 0, pdY = 0, pdId = null;
        addL(stageEl, 'pointerdown', function (e) { if (e && e.cancelable) e.preventDefault(); pdId = e.pointerId; pdX = e.clientX; pdY = e.clientY; });
        addL(stageEl, 'pointerup', function (e) {
          if (pdId === null) return;
          var dx = e.clientX - pdX, dy = e.clientY - pdY; pdId = null;
          if (dy > 40 && dy > Math.abs(dx)) { hardDrop(); return; }
          if (Math.abs(dx) < 26 && Math.abs(dy) < 26) {
            var r = stageEl.getBoundingClientRect(), rx = (e.clientX - r.left) / Math.max(1, r.width);
            if (rx < 0.35) moveLeft(); else if (rx > 0.65) moveRight(); else rotateActive();
          }
        });
        addL(stageEl, 'pointercancel', function () { pdId = null; });
      }

      /* ===================== SPIEL START ===================== */
      function startGame(startAtMs) {
        finished = false; phase = 'play';
        placed = []; colTopMap = {}; active = null; fallers = []; particles = []; bag = [];
        height = 0; maxHeight = 0; comCol = BASE_CX; overhang = 0; ratio = 0;
        leanCur = 0; shakeAmp = 0; cam = 0; score = 0;
        reportedReached = false; singleGoalToasted = false; resolving = false;
        endAt = startAtMs + DURATION * 1000;

        buildUI();
        measure(); setupBuffer();

        if ('ResizeObserver' in window) { ro = new ResizeObserver(onResize); ro.observe(stageEl); }
        else { addL(window, 'resize', onResize); }
        addInput();

        if (isMulti) {
          board = MG.liveBoard(ctx.room, ctx.me.id);
          stops.push(board.stop);
          boardWrap.appendChild(board.root);
          ctx.room.reportScore(0);
          var goalHandler = function () { checkWinner(); };
          ctx.room.on('players', goalHandler);
          stops.push(function () { ctx.room.off('players', goalHandler); });
        }

        stops.push(MG.roundTimer(endAt, function (left) {
          hudTimer.textContent = MG.mmss(Math.ceil(left));
          hudTimer.classList.toggle('tt-urgent', left <= 8);
        }, function () { if (isMulti) endMulti(null); else endSingle(); }, isMulti ? ctx.room.now : null));

        spawnNext();
        updateHud();
        cam = Math.max(0, height * CELL - V.H * 0.48);
        lastTs = clock();
        raf = requestAnimationFrame(frame);
      }

      /* ===================== SIEG-ERMITTLUNG (MULTI) ===================== */
      function checkWinner() {
        if (resolving || finished || dead) return;
        var ps = ctx.room.players();
        var any = ps.some(function (p) { return p.state && p.state.r; });
        if (any) {
          resolving = true;
          after(900, resolveGoalWinner); // kurz warten, damit alle "erreicht"-Meldungen ankommen
        }
      }
      function resolveGoalWinner() {
        if (finished || dead) return;
        var reached = ctx.room.players().filter(function (p) { return p.state && p.state.r; })
          .sort(function (a, b) { return a.state.r - b.state.r; });
        endMulti(reached[0] || null);
      }

      /* ===================== ENDE ===================== */
      function endMulti(winner) {
        if (finished || dead) return;
        finished = true;
        try { ctx.room.reportScore(score); } catch (e) {}
        stopAll();
        after(1000, function () {
          if (dead) return;
          if (winner) showGoalEnd(winner);
          else MG.endScreen(root, { players: ctx.room.players(), meId: ctx.me.id, onExit: ctx.onExit });
        });
      }
      function showGoalEnd(winner) {
        var players = ctx.room.players();
        var iWon = winner && winner.id === ctx.me.id;
        var head = iWon ? '🎉 Du hast die Ziel-Linie erreicht!'
          : '🏁 ' + (winner ? winner.name : 'Jemand') + ' hat die Ziel-Linie erreicht!';
        root.innerHTML = '';
        root.appendChild(el('div', { class: 'glass mg-endscreen' }, [
          el('h2', { class: 'neon' }, [head]),
          el('p', { class: 'hint-text' }, ['Endstand nach Turmhöhe:']),
          MG.podiumEl(players, ctx.me.id),
          el('div', { class: 'controls-row' }, [
            el('button', { class: 'btn btn-ghost', type: 'button', onclick: ctx.onExit }, ['Zurück zur Lobby'])
          ])
        ]));
      }
      function endSingle() {
        if (finished || dead) return;
        finished = true;
        stopAll();
        var best = App.Storage.get('best_trickytower', 0), nb = maxHeight > best;
        if (nb) App.Storage.set('best_trickytower', maxHeight);
        MG.endScreen(root, {
          title: 'Zeit um! 🗼', score: maxHeight, best: best, newBest: nb,
          label: nb ? 'Neuer Rekord! 🎉' : ('Höchster Turm · Bestwert: ' + MG.fmt(best) + ' Reihen'),
          onExit: ctx.onExit,
          onAgain: function () { stopAll(); startGame(Date.now()); }
        });
      }
    }
  };

  /* ===================== STYLES ===================== */
  function injectStyle() {
    UI.injectStyle('mg-trickytower-css', [
      '.tt-layout{display:flex;flex-direction:column;gap:12px;}',
      /* HUD */
      '.tt-hud{display:flex;align-items:stretch;justify-content:space-between;gap:10px;padding:10px 16px;}',
      '.tt-hud-cell{display:flex;flex-direction:column;gap:2px;justify-content:center;}',
      '.tt-hud-right{align-items:flex-end;}',
      '.tt-hud-mid{display:flex;flex-direction:column;gap:5px;justify-content:center;min-width:120px;flex:1;max-width:220px;}',
      '.tt-hud-l{font-size:10px;text-transform:uppercase;letter-spacing:1px;color:var(--muted);}',
      '.tt-height{font-size:clamp(26px,7vw,40px);line-height:1;color:var(--neon);text-shadow:0 0 14px rgba(57,255,20,.5);font-variant-numeric:tabular-nums;}',
      '.tt-goal{font-size:11px;font-weight:800;color:var(--aqua-soft);letter-spacing:.5px;}',
      '.tt-timer{font-size:clamp(20px,5vw,28px);font-variant-numeric:tabular-nums;}',
      '.tt-timer.tt-urgent{color:var(--danger);animation:tt-pulse .6s ease-in-out infinite;}',
      '@keyframes tt-pulse{0%,100%{opacity:1}50%{opacity:.45}}',
      '.tt-stab{height:12px;border-radius:999px;background:rgba(4,16,10,.8);border:1px solid var(--stroke);overflow:hidden;}',
      '.tt-stab-fill{height:100%;width:100%;border-radius:999px;background:var(--neon);transition:width .18s ease,background .18s ease;}',
      '.tt-next-row{display:flex;align-items:center;gap:8px;}',
      '.tt-preview{width:60px;height:46px;border-radius:8px;background:rgba(4,16,10,.7);border:1px solid var(--stroke);flex:0 0 auto;}',
      /* Spielfeld */
      '.tt-stage{position:relative;display:block;overflow:hidden;padding:0;cursor:pointer;',
      'height:min(58vh,560px);min-height:320px;width:100%;border-radius:var(--radius);',
      'touch-action:none;user-select:none;-webkit-user-select:none;-webkit-touch-callout:none;-webkit-tap-highlight-color:transparent;',
      'background:radial-gradient(120% 100% at 50% 100%,#0c3020,#04120b);}',
      '.tt-canvas{display:block;width:100%;height:100%;}',
      '.tt-hint{text-align:center;}',
      /* Steuer-Buttons */
      '.tt-controls{display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:10px;}',
      '.tt-btn{font-size:26px;font-weight:900;padding:16px 0;border-radius:16px;cursor:pointer;',
      'background:rgba(9,32,21,.85);border:1px solid var(--stroke-2);color:var(--leaf);',
      'touch-action:none;user-select:none;-webkit-tap-highlight-color:transparent;transition:transform .06s,filter .1s;}',
      '.tt-btn:active{transform:scale(.94);filter:brightness(1.25);}',
      '.tt-btn-rot{color:var(--aqua-soft);}',
      '.tt-btn-drop{color:var(--gold);border-color:rgba(255,210,63,.4);}',
      /* Banner / Crash */
      '.tt-banner{position:absolute;left:50%;top:20%;transform:translate(-50%,-50%);pointer-events:none;z-index:6;',
      'font-weight:900;font-size:clamp(20px,6vw,34px);letter-spacing:1px;color:var(--gold);text-align:center;',
      'text-shadow:0 0 16px rgba(255,210,63,.9),0 2px 8px rgba(0,0,0,.6);animation:tt-pop .7s ease-out forwards;}',
      '@keyframes tt-pop{0%{opacity:0;transform:translate(-50%,-50%) scale(.5)}25%{opacity:1;transform:translate(-50%,-50%) scale(1.12)}70%{opacity:1}100%{opacity:.9;transform:translate(-50%,-50%) scale(1)}}',
      '.tt-crash{position:absolute;left:50%;top:44%;transform:translate(-50%,-50%);pointer-events:none;z-index:6;',
      'font-weight:900;font-size:clamp(22px,7vw,40px);letter-spacing:2px;color:var(--danger);',
      'text-shadow:0 0 16px rgba(255,77,109,.9),0 2px 8px rgba(0,0,0,.6);animation:tt-crash 1s ease-out forwards;}',
      '@keyframes tt-crash{0%{opacity:0;transform:translate(-50%,-50%) scale(.5) rotate(-6deg)}20%{opacity:1;transform:translate(-50%,-50%) scale(1.1) rotate(4deg)}50%{transform:translate(-50%,-50%) scale(1) rotate(-2deg)}100%{opacity:0;transform:translate(-50%,-38%) scale(1) rotate(0)}}',
      /* Board */
      '.tt-board-wrap{padding:14px;display:flex;flex-direction:column;gap:8px;max-height:240px;overflow-y:auto;}'
    ].join(''));
  }
})();
