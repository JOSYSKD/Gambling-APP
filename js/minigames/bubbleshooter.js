/* bubbleshooter.js — "Blasen-Schuss": klassischer Bubble Shooter im Neon-Dschungel-Look.
 *
 * IDEE
 *   Oben haengt ein Feld farbiger Blasen (versetztes Wabengitter), unten steht eine
 *   Kanone. Man zielt, schiesst eine Blase hoch, sie prallt an den Seitenwaenden ab
 *   (Ricochet) und dockt an. Bildet die neu angedockte Blase mit 2+ gleichfarbigen
 *   zusammenhaengenden Nachbarn eine Gruppe (also 3+ insgesamt), platzt die ganze
 *   Gruppe. Blasen, die dadurch den Halt zur Decke verlieren, fallen ab -> Bonus.
 *   Periodisch rueckt oben eine neue Reihe nach (das Feld kriecht nach unten); erreicht
 *   es die rote Linie -> vorbei. Vorschau auf die naechste Farbe.
 *
 * STEUERUNG
 *   Auf dem Feld ziehen/tippen zum Zielen, loslassen schiesst (Touch + Maus).
 *   Am PC zusaetzlich: Pfeil links/rechts (oder A/D) zielen, Leertaste/Pfeil hoch schiessen.
 *   Buttons ◀ / Schiessen / ▶ als sichtbare Bedienung fuers Handy/iPad.
 *
 * PUNKTE
 *   Geplatzte Blase = 10, abgefallene (verlorene Verankerung) = 20 (Bonus),
 *   grosse Gruppen geben Zusatzpunkte, komplett leergeraeumtes Feld = 500 Bonus.
 *
 * SYNC-MODELL
 *   SOLO  : endlos bis zum Game Over, Bestwert in App.Storage 'best_bubbleshooter';
 *           die Nachrueck-Geschwindigkeit steigt mit der Zeit (Schwierigkeit).
 *   MULTI : reines Punkte-Rennen ueber 2 Minuten. Alle bekommen aus round.startAt
 *           denselben Seed -> exakt dasselbe Startfeld. Danach spielt jeder sein
 *           eigenes Brett, meldet den Punktestand per room.reportScore -> Live-Rangliste.
 *           Laeuft ein Feld ueber, wird es neu befuellt (Weiterspielen statt Ende).
 *   Alle Timer laufen ueber Wall-Clock (Date.now bzw. room.now), Zeichnen per rAF mit
 *   echtem dt -> Tab-Wechsel-sicher. cleanup() beendet wirklich alles. */
(function () {
  'use strict';
  window.App = window.App || {}; App.Minigames = App.Minigames || {};
  var UI = App.UI, el = UI.el;
  var fmt = App.MG.fmt, mmss = App.MG.mmss;
  var PI = Math.PI;

  injectStyle();

  /* ---- feste virtuelle Spielfeld-Masse (Canvas skaliert per CSS) ---- */
  var R = 22;                       // Blasen-Radius
  var COLS = 8;                     // Blasen in einer "vollen" Reihe
  var W = 2 * R * COLS;             // 352
  var H = 520;
  var ROWH = R * Math.sqrt(3);      // vertikaler Reihenabstand (~38.1)
  var TOPY = 30;                    // y-Mitte der obersten Reihe
  var DEATHY = 398;                 // rote Linie -> darunter = Feld voll
  var CANNON = { x: W / 2, y: 486 };
  var MUZZLE = 30;                  // Abstand Muendung zur Kanonenmitte
  var SPEED = 640;                  // px/s Schuss
  var HITDIST = R * 1.85;           // Andock-Abstand
  var NUM_COLORS = 5;
  var START_ROWS = 5;
  var MATCH_MIN = 3;                // 2+ getroffene Gleichfarbige + Schuss
  var POP_PTS = 10, DROP_PTS = 20, CLEAR_BONUS = 500;
  var ADV_START = 10000, ADV_MULTI = 9000, ADV_MIN = 5000, ADV_STEP = 350;
  var AIM_MAX = 1.35, AIM_RATE = 1.7;   // rad
  var POP_MS = 200, DROP_MS = 700, GRAV = 1500;
  var MATCH_MS = 120000;            // 2 Minuten Multiplayer

  /* Farbpalette (Neon-Dschungel): a = Hauptton, b = Tiefe, glow = Leuchten */
  var COLORS = [
    { a: '#39ff14', b: '#0c5a10', glow: 'rgba(57,255,20,.9)' },
    { a: '#33e6d0', b: '#0a5a55', glow: 'rgba(51,230,208,.9)' },
    { a: '#ffd23f', b: '#7a5300', glow: 'rgba(255,210,63,.9)' },
    { a: '#ff4d6d', b: '#7a0f22', glow: 'rgba(255,77,109,.9)' },
    { a: '#b17bff', b: '#3d1a7a', glow: 'rgba(177,123,255,.9)' }
  ];

  App.Minigames.bubbleshooter = {
    id: 'bubbleshooter', title: 'Blasen-Schuss', icon: '🫧', order: 135,
    subtitle: 'Ziel, schieß und lass Farben platzen!',
    single: true, multi: true, minPlayers: 2, maxPlayers: 8,

    render: function (root, ctx) {
      var isMulti = ctx.mode === 'multi';
      var nowFn = isMulti ? ctx.room.now : function () { return Date.now(); };

      /* ---- Laufzeit ---- */
      var dead = false, raf = null, last = 0;
      var S = null;                 // Spielzustand
      var canvas = null, ctx2d = null;
      var scoreEl = null, timerEl = null, bestEl = null, nextDot = null, flashEl = null, boardHost = null;
      var aiming = false;
      var keys = { left: false, right: false };
      var stops = [];               // stop()-Funktionen (roundTimer/liveBoard/room.off)
      var listeners = [];           // {t,ty,fn,opts}
      var timers = [];              // setTimeout-IDs

      function after(ms, fn) { var t = setTimeout(function () { if (!dead) fn(); }, ms); timers.push(t); return t; }
      function clearTimers() { timers.forEach(clearTimeout); timers = []; }
      function stopHelpers() { stops.forEach(function (f) { try { f(); } catch (e) {} }); stops = []; }
      function addL(t, ty, fn, opts) { t.addEventListener(ty, fn, opts); listeners.push({ t: t, ty: ty, fn: fn, opts: opts }); }
      function removeAllListeners() { listeners.forEach(function (l) { try { l.t.removeEventListener(l.ty, l.fn, l.opts); } catch (e) {} }); listeners = []; }
      function cleanup() {
        dead = true;
        if (raf) { cancelAnimationFrame(raf); raf = null; }
        clearTimers(); stopHelpers(); removeAllListeners();
      }

      /* ---- Start ---- */
      if (isMulti) {
        var snap = ctx.room.snapshot() || {};
        var startAt = (snap.round && snap.round.startAt) || (ctx.room.now() + 3000);
        stops.push(App.MG.countdown(root, startAt, function () { beginGame(startAt); }, ctx.room.now));
      } else {
        beginGame(Date.now());
      }
      return { cleanup: cleanup };

      /* ======================= Aufbau einer Partie ======================= */
      function beginGame(startAt) {
        if (raf) { cancelAnimationFrame(raf); raf = null; }
        stopHelpers(); removeAllListeners(); clearTimers();
        aiming = false; keys.left = false; keys.right = false;

        var seed = isMulti
          ? (Math.floor(startAt) >>> 0)
          : (((Date.now() >>> 0) ^ (Math.floor(Math.random() * 4294967296) >>> 0)) >>> 0);

        buildLayout();
        initState(seed);
        attachInput();

        if (isMulti) {
          var board = App.MG.liveBoard(ctx.room, ctx.me.id);
          stops.push(board.stop);
          boardHost.appendChild(board.root);
          try { ctx.room.reportScore(0); } catch (e) {}
          var endAt = startAt + MATCH_MS;
          stops.push(App.MG.roundTimer(endAt, function (left) {
            if (timerEl) { timerEl.textContent = mmss(left); if (left <= 10) timerEl.classList.add('urgent'); }
          }, finishMulti, ctx.room.now));
        }

        last = nowFn(); S.now = last;
        raf = requestAnimationFrame(frame);
      }

      function buildLayout() {
        scoreEl = el('div', { class: 'bub-score' }, ['0']);
        nextDot = el('div', { class: 'bub-next' });
        var rightVal = isMulti
          ? (timerEl = el('div', { class: 'bub-time' }, ['2:00']))
          : (bestEl = el('div', { class: 'bub-best' }, [fmt(App.Storage.get('best_bubbleshooter', 0))]));
        var head = el('div', { class: 'bub-head glass' }, [
          el('div', { class: 'bub-cell' }, [el('span', { class: 'bub-l' }, ['Punkte']), scoreEl]),
          el('div', { class: 'bub-cell mid' }, [el('span', { class: 'bub-l' }, ['Nächste']), nextDot]),
          el('div', { class: 'bub-cell right' }, [el('span', { class: 'bub-l' }, [isMulti ? 'Zeit' : 'Beste']), rightVal])
        ]);

        canvas = el('canvas', { class: 'bub-canvas', width: W, height: H });
        flashEl = el('div', { class: 'bub-flash' });
        var stage = el('div', { class: 'bub-stage' }, [canvas, flashEl]);

        var lBtn = el('button', { class: 'btn btn-ghost bub-nudge', type: 'button', onclick: function () { aimAdjust(-0.14); } }, ['◀']);
        var shootBtn = el('button', { class: 'btn btn-primary bub-shoot', type: 'button', onclick: function () { shoot(); } }, ['🫧 Schießen']);
        var rBtn = el('button', { class: 'btn btn-ghost bub-nudge', type: 'button', onclick: function () { aimAdjust(0.14); } }, ['▶']);
        var ctrl = el('div', { class: 'controls-row bub-ctrl' }, [lBtn, shootBtn, rBtn]);

        var hint = el('div', { class: 'hint-text bub-hint' }, [
          'Auf dem Feld ziehen/tippen zum Zielen — loslassen schießt. Am PC: ◀ ▶ / Leertaste. 3+ gleiche Farben platzen, Losgelöste fallen (Bonus).'
        ]);

        var kids = [head, stage, ctrl, hint];
        if (isMulti) {
          boardHost = el('div', { class: 'bub-board glass' }, [el('div', { class: 'mg-field-title' }, ['🏆 Rangliste'])]);
          kids.push(boardHost);
        }

        ctx2d = canvas.getContext('2d');
        root.innerHTML = '';
        root.appendChild(el('div', { class: 'bub-wrap' }, kids));
      }

      /* ======================= Zustand ======================= */
      function initState(seed) {
        var rng = makeRng(seed);
        S = {
          rows: [], firstRowOffset: false, score: 0,
          cur: -1, next: -1, shot: null, moving: false, over: false,
          aimAng: 0, pops: [], drops: [], now: nowFn(),
          nextAdvanceAt: 0, advanceMs: isMulti ? ADV_MULTI : ADV_START,
          storedBest: App.Storage.get('best_bubbleshooter', 0)
        };
        buildStarterRows(rng, START_ROWS);
        S.cur = pickColor(rng);
        S.next = pickColor(rng);
        setNextDot();
        scoreEl.textContent = '0';
        S.nextAdvanceAt = S.now + S.advanceMs;
      }

      function buildStarterRows(rand, n) {
        S.rows = []; S.firstRowOffset = false;
        for (var r = 0; r < n; r++) {
          var len = rowLenAt(r), row = [];
          for (var c = 0; c < len; c++) row.push(Math.floor(rand() * NUM_COLORS));
          S.rows.push(row);
        }
      }

      function setNextDot() {
        if (!nextDot || S.next < 0) return;
        var col = COLORS[S.next];
        nextDot.style.background = 'radial-gradient(circle at 34% 32%, #fff, ' + col.a + ' 42%, ' + col.b + ')';
        nextDot.style.boxShadow = '0 0 12px ' + col.glow;
      }

      /* ---- Gitter-Geometrie ---- */
      function rowIsB(r) { return (r % 2 === 0) ? S.firstRowOffset : !S.firstRowOffset; }
      function rowLenAt(r) { return rowIsB(r) ? (COLS - 1) : COLS; }
      function cellX(r, c) { return rowIsB(r) ? (2 * R + c * 2 * R) : (R + c * 2 * R); }
      function cellY(r) { return TOPY + r * ROWH; }
      function getCell(r, c) {
        if (r < 0 || c < 0) return -1;
        var row = S.rows[r]; if (!row) return -1;
        if (c >= row.length) return -1;
        var v = row[c]; return (v == null ? -1 : v);
      }
      function ensureRow(r) {
        while (S.rows.length <= r) {
          var idx = S.rows.length, len = rowLenAt(idx), row = [];
          for (var c = 0; c < len; c++) row.push(-1);
          S.rows.push(row);
        }
      }
      function neighbors(r, c) {
        var b = rowIsB(r);
        var out = [[r, c - 1], [r, c + 1]];
        if (b) { out.push([r - 1, c]); out.push([r - 1, c + 1]); out.push([r + 1, c]); out.push([r + 1, c + 1]); }
        else { out.push([r - 1, c - 1]); out.push([r - 1, c]); out.push([r + 1, c - 1]); out.push([r + 1, c]); }
        var res = [];
        for (var i = 0; i < out.length; i++) {
          var rr = out[i][0], cc = out[i][1];
          if (rr < 0 || cc < 0) continue;
          if (cc >= rowLenAt(rr)) continue;
          res.push([rr, cc]);
        }
        return res;
      }
      function hasFilledNeighbor(r, c) {
        var nb = neighbors(r, c);
        for (var i = 0; i < nb.length; i++) if (getCell(nb[i][0], nb[i][1]) >= 0) return true;
        return false;
      }
      function presentColors() {
        var seen = {}, out = [];
        for (var r = 0; r < S.rows.length; r++) {
          var row = S.rows[r]; if (!row) continue;
          for (var c = 0; c < row.length; c++) { var v = row[c]; if (v >= 0 && !seen[v]) { seen[v] = 1; out.push(v); } }
        }
        return out;
      }
      function pickColor(rand) {
        var pc = presentColors();
        if (pc.length) return pc[Math.floor(rand() * pc.length)];
        return Math.floor(rand() * NUM_COLORS);
      }
      function boardEmpty() {
        for (var r = 0; r < S.rows.length; r++) {
          var row = S.rows[r]; if (!row) continue;
          for (var c = 0; c < row.length; c++) if (row[c] >= 0) return false;
        }
        return true;
      }

      /* ======================= Eingabe ======================= */
      function toVX(cx) { var b = canvas.getBoundingClientRect(); return (cx - b.left) / b.width * W; }
      function toVY(cy) { var b = canvas.getBoundingClientRect(); return (cy - b.top) / b.height * H; }
      function clampAim(a) { return a < -AIM_MAX ? -AIM_MAX : (a > AIM_MAX ? AIM_MAX : a); }
      function aimTo(vx, vy) { S.aimAng = clampAim(Math.atan2(vx - CANNON.x, CANNON.y - vy)); }
      function aimAdjust(d) { if (!S.over) S.aimAng = clampAim(S.aimAng + d); }

      function attachInput() {
        var onDown = function (e) { if (S.over) return; aiming = true; aimTo(toVX(e.clientX), toVY(e.clientY)); if (e.preventDefault) e.preventDefault(); };
        var onMove = function (e) { if (!aiming || S.over) return; aimTo(toVX(e.clientX), toVY(e.clientY)); if (e.preventDefault) e.preventDefault(); };
        var onUp = function (e) {
          if (!aiming) return; aiming = false;
          if (!S.over) { if (typeof e.clientX === 'number') aimTo(toVX(e.clientX), toVY(e.clientY)); shoot(); }
          if (e.preventDefault) e.preventDefault();
        };
        var onCancel = function () { aiming = false; };
        var onKeyDown = function (e) {
          var k = e.key;
          if (k === 'ArrowLeft' || k === 'a' || k === 'A') { keys.left = true; e.preventDefault(); }
          else if (k === 'ArrowRight' || k === 'd' || k === 'D') { keys.right = true; e.preventDefault(); }
          else if (k === ' ' || k === 'ArrowUp' || k === 'w' || k === 'W' || k === 'Enter') { shoot(); e.preventDefault(); }
        };
        var onKeyUp = function (e) {
          var k = e.key;
          if (k === 'ArrowLeft' || k === 'a' || k === 'A') keys.left = false;
          else if (k === 'ArrowRight' || k === 'd' || k === 'D') keys.right = false;
        };
        addL(canvas, 'pointerdown', onDown);
        addL(canvas, 'pointermove', onMove);
        addL(window, 'pointerup', onUp);
        addL(window, 'pointercancel', onCancel);
        addL(document, 'keydown', onKeyDown);
        addL(document, 'keyup', onKeyUp);
      }

      function muzzle(ang) { return { x: CANNON.x + Math.sin(ang) * MUZZLE, y: CANNON.y - Math.cos(ang) * MUZZLE }; }

      function shoot() {
        if (S.over || S.moving || S.cur < 0) return;
        var ang = S.aimAng, m = muzzle(ang);
        S.shot = { x: m.x, y: m.y, dx: Math.sin(ang), dy: -Math.cos(ang), color: S.cur };
        S.moving = true;
        S.cur = S.next; S.next = pickColor(Math.random); setNextDot();
        if (App.Audio) App.Audio.sfx('whoosh');
      }

      /* ======================= Schuss-Physik ======================= */
      function collidesAt(x, y) {
        var rC = Math.round((y - TOPY) / ROWH);
        for (var rr = rC - 1; rr <= rC + 1; rr++) {
          if (rr < 0) continue;
          var row = S.rows[rr]; if (!row) continue;
          for (var cc = 0; cc < row.length; cc++) {
            if (row[cc] == null || row[cc] < 0) continue;
            var dx = cellX(rr, cc) - x, dy = cellY(rr) - y;
            if (dx * dx + dy * dy < HITDIST * HITDIST) return true;
          }
        }
        return false;
      }

      function stepShot(dt) {
        var remaining = SPEED * dt, stepLen = R * 0.5;
        while (remaining > 0 && S.moving) {
          var d = Math.min(stepLen, remaining); remaining -= d;
          S.shot.x += S.shot.dx * d; S.shot.y += S.shot.dy * d;
          if (S.shot.x < R) { S.shot.x = R; S.shot.dx = -S.shot.dx; if (App.Audio) App.Audio.sfx('tick'); }
          else if (S.shot.x > W - R) { S.shot.x = W - R; S.shot.dx = -S.shot.dx; if (App.Audio) App.Audio.sfx('tick'); }
          if (S.shot.y <= TOPY) { landShot(); return; }
          if (collidesAt(S.shot.x, S.shot.y)) { landShot(); return; }
          if (S.shot.y < -R) { S.moving = false; S.shot = null; return; }
        }
      }

      function findCell(sx, sy) {
        var rG = Math.round((sy - TOPY) / ROWH); if (rG < 0) rG = 0;
        for (var pass = 0; pass < 2; pass++) {
          var best = null, bestD = 1e18;
          for (var rr = Math.max(0, rG - 2); rr <= rG + 2; rr++) {
            var len = rowLenAt(rr);
            for (var cc = 0; cc < len; cc++) {
              if (getCell(rr, cc) >= 0) continue;
              if (pass === 0 && rr !== 0 && !hasFilledNeighbor(rr, cc)) continue;
              var dx = cellX(rr, cc) - sx, dy = cellY(rr) - sy, dd = dx * dx + dy * dy;
              if (dd < bestD) { bestD = dd; best = [rr, cc]; }
            }
          }
          if (best) return best;
        }
        return null;
      }

      function landShot() {
        var sx = S.shot.x, sy = S.shot.y, color = S.shot.color;
        S.moving = false; S.shot = null;
        var cell = findCell(sx, sy);
        if (!cell) cell = findCell(CANNON.x, TOPY);
        if (!cell) return;
        var rr = cell[0], cc = cell[1];
        ensureRow(rr);
        S.rows[rr][cc] = color;
        resolveMatches(rr, cc, color);
        trimRows();
        if (boardEmpty()) { onClear(); return; }
        if (checkDeath()) onDeath();
      }

      /* ---- Gruppen platzen + Herabfallen ---- */
      function floodColor(r, c, color) {
        var seen = {}, stack = [[r, c]], out = [];
        seen[r + ',' + c] = 1;
        while (stack.length) {
          var cur = stack.pop(); out.push(cur);
          var nb = neighbors(cur[0], cur[1]);
          for (var i = 0; i < nb.length; i++) {
            var rr = nb[i][0], cc = nb[i][1], k = rr + ',' + cc;
            if (seen[k]) continue;
            if (getCell(rr, cc) !== color) continue;
            seen[k] = 1; stack.push([rr, cc]);
          }
        }
        return out;
      }
      function findFloating() {
        var seen = {}, stack = [];
        var len0 = rowLenAt(0);
        for (var c = 0; c < len0; c++) if (getCell(0, c) >= 0) { seen['0,' + c] = 1; stack.push([0, c]); }
        while (stack.length) {
          var cur = stack.pop(), nb = neighbors(cur[0], cur[1]);
          for (var i = 0; i < nb.length; i++) {
            var rr = nb[i][0], cc = nb[i][1], k = rr + ',' + cc;
            if (seen[k]) continue;
            if (getCell(rr, cc) < 0) continue;
            seen[k] = 1; stack.push([rr, cc]);
          }
        }
        var fl = [];
        for (var r = 0; r < S.rows.length; r++) {
          var row = S.rows[r]; if (!row) continue;
          for (var cc2 = 0; cc2 < row.length; cc2++) if (getCell(r, cc2) >= 0 && !seen[r + ',' + cc2]) fl.push([r, cc2]);
        }
        return fl;
      }

      function resolveMatches(r, c, color) {
        var group = floodColor(r, c, color);
        if (group.length < MATCH_MIN) {
          if (App.Audio) App.Audio.blip(300, 0.06, { type: 'sine', peak: 0.05 });
          return;
        }
        var i, popped = 0, dropped = 0;
        for (i = 0; i < group.length; i++) {
          var g0 = group[i];
          S.pops.push({ x: cellX(g0[0], g0[1]), y: cellY(g0[0]), color: color, t0: S.now });
          S.rows[g0[0]][g0[1]] = -1; popped++;
        }
        var fl = findFloating();
        for (i = 0; i < fl.length; i++) {
          var f0 = fl[i], fc = getCell(f0[0], f0[1]);
          S.drops.push({ x: cellX(f0[0], f0[1]), y: cellY(f0[0]), vx: (Math.random() * 2 - 1) * 40, vy: -60 - Math.random() * 60, color: fc, t0: S.now });
          S.rows[f0[0]][f0[1]] = -1; dropped++;
        }
        var extra = popped > 4 ? (popped - 4) * 5 : 0;
        var gained = popped * POP_PTS + dropped * DROP_PTS + extra;
        addScore(gained);
        if (App.Audio) {
          App.Audio.sfx('pop');
          if (dropped > 0) App.Audio.sfx('explosion');
          if (popped >= 6) App.Audio.sfx('powerup');
        }
        showFlash('+' + gained + (popped + dropped >= 6 ? '  🔥' : ''));
      }

      function trimRows() {
        while (S.rows.length > 0) {
          var row = S.rows[S.rows.length - 1], any = false;
          for (var i = 0; i < row.length; i++) if (row[i] >= 0) { any = true; break; }
          if (any) break;
          S.rows.pop();
        }
      }

      /* ---- Nachruecken der Decke, Tod, Feld-Reset ---- */
      function advance(now) {
        S.firstRowOffset = !S.firstRowOffset;
        var n = rowLenAt(0), row = [];
        var pc = presentColors();
        for (var c = 0; c < n; c++) row.push(pc.length ? pc[Math.floor(Math.random() * pc.length)] : Math.floor(Math.random() * NUM_COLORS));
        S.rows.unshift(row);
        if (App.Audio) App.Audio.sfx('step');
        if (!isMulti) S.advanceMs = Math.max(ADV_MIN, S.advanceMs - ADV_STEP);
        S.nextAdvanceAt = now + S.advanceMs;
        if (checkDeath()) onDeath();
      }

      function checkDeath() {
        var maxR = -1;
        for (var r = 0; r < S.rows.length; r++) {
          var row = S.rows[r]; if (!row) continue;
          for (var c = 0; c < row.length; c++) if (row[c] >= 0) { if (r > maxR) maxR = r; break; }
        }
        if (maxR < 0) return false;
        return (cellY(maxR) + R >= DEATHY);
      }

      function onClear() {
        addScore(CLEAR_BONUS);
        showFlash('Feld leer! +' + CLEAR_BONUS);
        if (App.Audio) App.Audio.sfx('jackpot');
        buildStarterRows(function () { return Math.random(); }, START_ROWS);
        S.nextAdvanceAt = S.now + S.advanceMs;
      }

      function onDeath() {
        if (isMulti) {
          if (App.Audio) App.Audio.sfx('explosion');
          showFlash('Feld voll! 🔄');
          resetBoard(S.now);
        } else {
          gameOverSolo();
        }
      }

      function resetBoard(now) {
        buildStarterRows(function () { return Math.random(); }, START_ROWS);
        S.cur = pickColor(Math.random); S.next = pickColor(Math.random); setNextDot();
        S.moving = false; S.shot = null; S.pops = []; S.drops = [];
        S.advanceMs = ADV_MULTI; S.nextAdvanceAt = now + S.advanceMs;
      }

      /* ======================= Punkte / Flash ======================= */
      function addScore(n) {
        S.score += n;
        scoreEl.textContent = fmt(S.score);
        if (isMulti) { try { ctx.room.reportScore(S.score); } catch (e) {} }
        else if (bestEl) bestEl.textContent = fmt(Math.max(S.storedBest, S.score));
      }
      function showFlash(text) {
        if (!flashEl) return;
        flashEl.textContent = text;
        flashEl.classList.remove('show'); void flashEl.offsetWidth; flashEl.classList.add('show');
      }

      /* ======================= Frame-Loop ======================= */
      function frame() {
        if (dead) { raf = null; return; }
        var now = nowFn();
        var dt = (now - last) / 1000; if (dt < 0) dt = 0; if (dt > 0.05) dt = 0.05; last = now;
        update(now, dt);
        draw(now);
        if (!dead) raf = requestAnimationFrame(frame);
      }

      function update(now, dt) {
        S.now = now;
        if (S.over) return;
        if (keys.left) aimAdjust(-AIM_RATE * dt);
        if (keys.right) aimAdjust(AIM_RATE * dt);
        if (!S.moving && now >= S.nextAdvanceAt) advance(now);
        if (S.moving) stepShot(dt);
        // Platz-Animationen ablaufen lassen
        for (var i = S.pops.length - 1; i >= 0; i--) if (now - S.pops[i].t0 > POP_MS) S.pops.splice(i, 1);
        // fallende Blasen integrieren
        for (var j = S.drops.length - 1; j >= 0; j--) {
          var d = S.drops[j];
          d.vy += GRAV * dt; d.x += d.vx * dt; d.y += d.vy * dt;
          if (d.y - R > H || now - d.t0 > DROP_MS + 400) S.drops.splice(j, 1);
        }
      }

      /* ======================= Zeichnen ======================= */
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
      function drawBubble(x, y, ci, scale, alpha) {
        if (ci < 0) return;
        var col = COLORS[ci], rr = R * scale, g = ctx2d;
        g.save();
        g.globalAlpha = alpha;
        var grd = g.createRadialGradient(x - rr * 0.34, y - rr * 0.38, rr * 0.12, x, y, rr);
        grd.addColorStop(0, '#ffffff');
        grd.addColorStop(0.18, col.a);
        grd.addColorStop(1, col.b);
        g.shadowColor = col.glow; g.shadowBlur = 8;
        g.fillStyle = grd;
        g.beginPath(); g.arc(x, y, rr, 0, PI * 2); g.fill();
        g.shadowBlur = 0;
        g.lineWidth = 1.4; g.strokeStyle = 'rgba(255,255,255,.22)';
        g.beginPath(); g.arc(x, y, rr, 0, PI * 2); g.stroke();
        g.globalAlpha = alpha * 0.55; g.fillStyle = '#ffffff';
        g.beginPath(); g.arc(x - rr * 0.3, y - rr * 0.34, rr * 0.17, 0, PI * 2); g.fill();
        g.restore();
      }
      function drawGuide() {
        var pts = predictPath(S.aimAng);
        if (pts.length < 2) return;
        var g = ctx2d;
        g.save();
        g.strokeStyle = 'rgba(180,255,150,.5)'; g.lineWidth = 2.5; g.lineCap = 'round';
        g.setLineDash([2, 11]);
        g.beginPath(); g.moveTo(pts[0].x, pts[0].y);
        for (var i = 1; i < pts.length; i++) g.lineTo(pts[i].x, pts[i].y);
        g.stroke();
        g.setLineDash([]);
        var e = pts[pts.length - 1];
        g.strokeStyle = 'rgba(255,255,255,.7)'; g.lineWidth = 2;
        g.beginPath(); g.arc(e.x, e.y, R * 0.78, 0, PI * 2); g.stroke();
        g.restore();
      }
      function predictPath(ang) {
        var m = muzzle(ang), pts = [{ x: m.x, y: m.y }];
        var x = m.x, y = m.y, dx = Math.sin(ang), dy = -Math.cos(ang);
        var step = R * 0.6, guard = 0;
        while (guard++ < 600) {
          x += dx * step; y += dy * step;
          if (x < R) { x = R; dx = -dx; pts.push({ x: x, y: y }); }
          else if (x > W - R) { x = W - R; dx = -dx; pts.push({ x: x, y: y }); }
          if (y <= TOPY) { pts.push({ x: x, y: y }); break; }
          if (collidesAt(x, y)) { pts.push({ x: x, y: y }); break; }
          if (y < 0) break;
        }
        return pts;
      }
      function drawCannon(ang, color) {
        var g = ctx2d;
        g.save();
        g.translate(CANNON.x, CANNON.y); g.rotate(ang);
        g.fillStyle = 'rgba(10,40,26,.95)'; g.strokeStyle = 'rgba(57,255,20,.5)'; g.lineWidth = 2;
        roundRect(g, -9, -42, 18, 46, 8); g.fill(); g.stroke();
        g.restore();
        g.save();
        g.fillStyle = 'rgba(8,30,20,.96)'; g.strokeStyle = 'rgba(57,255,20,.55)'; g.lineWidth = 2;
        g.beginPath(); g.arc(CANNON.x, CANNON.y, 20, 0, PI * 2); g.fill(); g.stroke();
        g.restore();
        if (color >= 0) { var m = muzzle(ang); drawBubble(m.x, m.y, color, 1, 1); }
      }
      function draw(now) {
        var g = ctx2d; if (!g) return;
        var grd = g.createLinearGradient(0, 0, 0, H);
        grd.addColorStop(0, '#06180e'); grd.addColorStop(1, '#020c07');
        g.fillStyle = grd; g.fillRect(0, 0, W, H);
        // Rahmen + Decke
        g.save(); g.strokeStyle = 'rgba(57,255,20,.18)'; g.lineWidth = 3; roundRect(g, 4, 4, W - 8, H - 8, 14); g.stroke(); g.restore();
        g.save(); g.fillStyle = 'rgba(57,255,20,.10)'; g.fillRect(7, 7, W - 14, 9); g.restore();
        // rote Linie
        g.save();
        g.strokeStyle = 'rgba(255,77,109,.55)'; g.lineWidth = 2; g.setLineDash([10, 8]);
        g.beginPath(); g.moveTo(8, DEATHY); g.lineTo(W - 8, DEATHY); g.stroke();
        g.setLineDash([]);
        g.fillStyle = 'rgba(255,77,109,.6)'; g.font = '700 10px system-ui,sans-serif'; g.textAlign = 'left';
        g.fillText('GAME OVER', 12, DEATHY - 5);
        g.restore();
        // Gitter
        for (var r = 0; r < S.rows.length; r++) {
          var row = S.rows[r]; if (!row) continue;
          for (var c = 0; c < row.length; c++) { var v = row[c]; if (v >= 0) drawBubble(cellX(r, c), cellY(r), v, 1, 1); }
        }
        // Platz-Animationen
        for (var i = 0; i < S.pops.length; i++) {
          var p = S.pops[i], pr = (now - p.t0) / POP_MS; if (pr > 1) continue;
          drawBubble(p.x, p.y, p.color, 1 + pr * 0.6, 1 - pr);
        }
        // fallende Blasen
        for (var j = 0; j < S.drops.length; j++) {
          var d = S.drops[j], dr = (now - d.t0) / DROP_MS, a = dr > 0.6 ? Math.max(0, 1 - (dr - 0.6) / 0.4) : 1;
          drawBubble(d.x, d.y, d.color, 1, a);
        }
        // Schuss
        if (S.moving && S.shot) drawBubble(S.shot.x, S.shot.y, S.shot.color, 1, 1);
        // Zielhilfe
        if (!S.moving && !S.over) drawGuide();
        // Kanone + Vorschau
        drawCannon(S.aimAng, S.cur);
        if (S.next >= 0) drawBubble(W - 24, H - 22, S.next, 0.58, 1);
      }

      /* ======================= Ende ======================= */
      function gameOverSolo() {
        if (S.over) return;
        S.over = true; S.moving = false; S.shot = null;
        if (App.Audio) App.Audio.sfx('lose');
        var best = S.storedBest, nb = S.score > best;
        if (nb) App.Storage.set('best_bubbleshooter', S.score);
        after(800, function () {
          if (dead) return;
          if (raf) { cancelAnimationFrame(raf); raf = null; }
          App.MG.endScreen(root, {
            score: S.score, best: best, newBest: nb,
            label: nb ? 'Neuer Rekord! 🎉' : 'Bestwert: ' + fmt(Math.max(best, S.score)),
            onExit: ctx.onExit,
            onAgain: function () { beginGame(Date.now()); }
          });
        });
      }
      function finishMulti() {
        if (S.over) return;
        S.over = true; S.moving = false; S.shot = null;
        try { ctx.room.reportScore(S.score); } catch (e) {}
        if (App.Audio) App.Audio.sfx(S.score > 0 ? 'win' : 'info');
        after(900, function () {
          if (dead) return;
          if (raf) { cancelAnimationFrame(raf); raf = null; }
          App.MG.endScreen(root, { players: ctx.room.players(), meId: ctx.me.id, onExit: ctx.onExit });
        });
      }

      /* ---- kleiner deterministischer Zufall (mulberry32) fuer gleiches Startfeld ---- */
      function makeRng(seed) {
        var t = seed >>> 0;
        return function () {
          t = (t + 0x6D2B79F5) >>> 0;
          var x = t;
          x = Math.imul(x ^ (x >>> 15), x | 1);
          x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
          return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
        };
      }
    }
  };

  /* ======================= STYLES ======================= */
  function injectStyle() {
    UI.injectStyle('mg-bubbleshooter-css', [
      '.bub-wrap{display:flex;flex-direction:column;gap:12px;align-items:stretch;max-width:440px;margin:0 auto;}',
      '.bub-head{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 16px;}',
      '.bub-cell{display:flex;flex-direction:column;gap:3px;min-width:0;}',
      '.bub-cell.mid{align-items:center;}',
      '.bub-cell.right{align-items:flex-end;text-align:right;}',
      '.bub-l{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:1px;font-weight:800;}',
      '.bub-score{font-size:clamp(22px,6vw,34px);font-weight:900;color:var(--gold);text-shadow:0 0 12px rgba(255,210,63,.45);line-height:1;font-variant-numeric:tabular-nums;}',
      '.bub-time{font-size:clamp(18px,5vw,26px);font-weight:900;color:var(--aqua);text-shadow:0 0 10px rgba(51,230,208,.4);line-height:1;font-variant-numeric:tabular-nums;}',
      '.bub-time.urgent{color:var(--danger);text-shadow:0 0 12px rgba(255,77,109,.5);animation:bub-pulse .7s infinite;}',
      '.bub-best{font-size:clamp(16px,4.5vw,22px);font-weight:900;color:var(--leaf);line-height:1;font-variant-numeric:tabular-nums;}',
      '.bub-next{width:30px;height:30px;border-radius:50%;border:2px solid rgba(255,255,255,.5);background:rgba(255,255,255,.15);box-shadow:0 0 12px rgba(255,255,255,.2);transition:background .2s,box-shadow .2s;}',
      '.bub-stage{position:relative;width:100%;max-width:min(360px,92vw);margin:0 auto;}',
      '.bub-canvas{display:block;width:100%;height:auto;aspect-ratio:352 / 520;border-radius:16px;',
      'border:2px solid rgba(57,255,20,.3);background:#04140c;',
      'box-shadow:0 0 40px rgba(57,255,20,.18),inset 0 0 60px rgba(57,255,20,.05);',
      'touch-action:none;user-select:none;-webkit-user-select:none;-webkit-tap-highlight-color:transparent;cursor:crosshair;}',
      '.bub-ctrl{margin-top:2px;flex-wrap:nowrap;}',
      '.bub-nudge{min-width:56px;font-size:18px;padding:10px 12px;}',
      '.bub-shoot{flex:1;max-width:220px;}',
      '.bub-hint{text-align:center;line-height:1.45;}',
      '.bub-board{padding:12px 14px;display:flex;flex-direction:column;gap:8px;}',
      '.bub-board .mg-scoreboard{max-height:220px;overflow-y:auto;}',
      '.bub-flash{position:absolute;left:50%;top:46%;transform:translate(-50%,-50%);font-weight:900;',
      'font-size:clamp(20px,6vw,30px);color:var(--gold);text-shadow:0 0 16px rgba(255,210,63,.65);',
      'pointer-events:none;opacity:0;white-space:nowrap;}',
      '.bub-flash.show{animation:bub-flash .9s ease;}',
      '@keyframes bub-flash{0%{opacity:0;transform:translate(-50%,-30%) scale(.7);}25%{opacity:1;transform:translate(-50%,-58%) scale(1.1);}100%{opacity:0;transform:translate(-50%,-88%) scale(1);}}',
      '@keyframes bub-pulse{0%,100%{opacity:1}50%{opacity:.4}}'
    ].join(''));
  }
})();
