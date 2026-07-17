/* breakout.js — "Ranken-Brecher": Breakout/Arkanoid im Neon-Dschungel-Look.
 *
 * IDEE      Ein Paddel unten, ein leuchtender Ball, oben eine Mauer aus bunten
 *           Ranken-Steinen (manche brauchen 2 Treffer). Steine zerschlagen gibt
 *           Punkte, selten fällt ein Power-up (↔ breiteres Paddel, ×3 Multiball,
 *           ❄ langsamer). 3 Leben. Sind alle Steine weg -> nächstes Level
 *           (schneller, mehr/zähere Steine).
 *
 * STEUERUNG Finger/Maus bewegt das Paddel (pointermove über der Fläche).
 *           Tippen / Klick / Leertaste schießt den ruhenden Ball ab.
 *           Zusätzlich Pfeiltasten ← → bzw. A / D. Touch-freundlich (touch-action:none).
 *
 * PUNKTE    Stein anschlagen +4, zerschlagen +12 (zäher Stein +25) plus Level-Bonus,
 *           Level geschafft +80 +25·Level, Power-up gefangen +20.
 *
 * SOLO      Endlos-Punktejagd gegen den eigenen Rekord (best_breakout). 3 Leben,
 *           bei 0 -> Game Over mit Endscreen (Nochmal / Zurück).
 *
 * MULTI     Punkte-Rennen wie reflex.js: ALLE bekommen dieselben Level-Layouts
 *           (Seed aus snapshot().round.startAt -> Level N sieht bei allen gleich aus).
 *           Jeder spielt sein eigenes Brett, 2 Minuten lang, meiste Punkte gewinnen
 *           (room.reportScore + Live-Rangliste). Kommt man auf 0 Leben, startet das
 *           Brett bei Level 1 neu (Punkte bleiben) — so spielt jeder die volle Zeit.
 *
 * SYNC      Physik läuft rein lokal mit echtem dt (Date.now, gedeckelt -> Tab-sicher).
 *           Nur Countdown + 2-Minuten-Timer laufen über room.now() (synchron).
 *           cleanup() beendet rAF, alle Timeouts, DOM-Listener und room.off().
 */
(function () {
  'use strict';
  window.App = window.App || {}; App.Minigames = App.Minigames || {};
  var UI = App.UI, el = UI.el;

  /* ---- Virtuelles Spielfeld (feste Koordinaten, Canvas skaliert per CSS) ---- */
  var W = 480, H = 600;
  var COLS = 8, MARGIN_X = 22, GAP = 6, BTOP = 62, BH = 22;
  var BW = (W - 2 * MARGIN_X - (COLS - 1) * GAP) / COLS;   // Steinbreite

  var PW_BASE = 92, PW_WIDE = 152, PH = 14, PADDLE_Y = H - 40;
  var R = 8;                              // Ball-Radius
  var BALL_BASE = 300, BALL_STEP = 24, MAX_SPEED = 560;
  var MAX_ANGLE = 1.05;                   // rad (~60°) max. Abprallwinkel am Paddel
  var HIT_SPEEDUP = 1.03;                 // pro Paddel-Kontakt
  var MIN_VY_FRAC = 0.22;                 // Ball nie zu waagerecht -> läuft weiter
  var KB_SPEED = 620;                     // px/s Paddel per Tastatur

  var PU_W = 32, PU_H = 18, PU_FALL = 150, PU_CHANCE = 0.12;
  var WIDE_MS = 9000, SLOW_MS = 8000, SLOW_FACTOR = 0.6;
  var MAX_BALLS = 6, MAX_PARTICLES = 150;
  var START_LIVES = 3, AUTOLAUNCH_MS = 1500;
  var MULTI_DURATION = 120;               // s

  /* Reihenfarben (Neon-Dschungel-Palette) */
  var ROW_COLORS = ['#39ff14', '#33e6d0', '#ffd23f', '#9dff7a', '#ff4d6d', '#7ff3e6', '#e08a3c', '#6dff4d'];
  /* Power-up-Typen */
  var PU_TYPES = [
    { k: 'wide', glyph: '↔', color: '#33e6d0' },
    { k: 'multi', glyph: '×3', color: '#ffd23f' },
    { k: 'slow', glyph: '❄', color: '#9dff7a' }
  ];

  injectStyle();

  App.Minigames.breakout = {
    id: 'breakout', title: 'Ranken-Brecher', icon: '🧱', order: 132,
    subtitle: 'Ball & Paddel: zerlege die Neon-Steinmauer',
    single: true, multi: true, minPlayers: 2, maxPlayers: 8,

    render: function (root, ctx) {
      var isMulti = ctx.mode === 'multi';

      /* ---- Laufzeit ---- */
      var dead = false, finished = false, raf = null, last = 0;
      var stops = [];        // App.MG-stop()-Funktionen + room.off()
      var listeners = [];    // DOM-Listener {t,ty,fn,opts}
      var pending = [];      // setTimeout-IDs

      /* ---- Spielzustand (in play()/initLevel() gesetzt) ---- */
      var score = 0, level = 1, lives = START_LIVES;
      var baseSeed = 0, levelSpeed = BALL_BASE, endAt = 0;
      var bricks = [], balls = [], powerups = [], particles = [];
      var paddleX = W / 2, paddleW = PW_BASE;
      var wideUntil = 0, slowUntil = 0;
      var flashUntil = 0, flashColor = 'rgba(255,77,109,0.18)';
      var levelMsg = '', levelMsgUntil = 0;
      var scoreDirty = false, lastReport = 0;
      var keys = { left: false, right: false };

      /* ---- DOM-Referenzen ---- */
      var canvas = null, g2d = null;
      var scoreEl = null, levelEl = null, livesEl = null, sideEl = null;
      var hudScore = -1, hudLevel = -1, hudLives = -1, hudSide = '';

      /* ================= Helfer: Timer / Listener / Aufräumen ================= */
      function after(ms, fn) { var t = setTimeout(function () { if (!dead) fn(); }, ms); pending.push(t); return t; }
      function clearPending() { pending.forEach(clearTimeout); pending = []; }
      function stopHelpers() { stops.forEach(function (f) { try { f(); } catch (e) {} }); stops = []; }
      function addL(target, type, fn, opts) { target.addEventListener(type, fn, opts); listeners.push({ t: target, ty: type, fn: fn, opts: opts }); }
      function removeListeners() { listeners.forEach(function (l) { try { l.t.removeEventListener(l.ty, l.fn, l.opts); } catch (e) {} }); listeners = []; }
      function cleanup() {
        dead = true;
        if (raf) { cancelAnimationFrame(raf); raf = null; }
        clearPending(); stopHelpers(); removeListeners();
      }

      /* ================= Start ================= */
      if (isMulti) {
        var snap = ctx.room.snapshot() || {};
        var startAt = (snap.round && snap.round.startAt) || (ctx.room.now() + 3000);
        stops.push(App.MG.countdown(root, startAt, function () { play(startAt); }, ctx.room.now));
      } else {
        play(Date.now());
      }
      return { cleanup: cleanup };

      /* ===================== SPIEL AUFBAUEN ===================== */
      function play(startAt) {
        if (dead) return;
        clearPending(); stopHelpers(); removeListeners();
        finished = false;
        score = 0; level = 1; lives = START_LIVES;
        powerups = []; particles = [];
        wideUntil = 0; slowUntil = 0; paddleW = PW_BASE; paddleX = W / 2;
        flashUntil = 0; levelMsgUntil = 0;
        scoreDirty = false; lastReport = 0;
        hudScore = hudLevel = hudLives = -1; hudSide = '';
        baseSeed = (Math.floor(isMulti ? startAt : Date.now())) >>> 0;
        endAt = startAt + MULTI_DURATION * 1000;

        buildStage();
        attachInput();
        initLevel(1);

        if (isMulti) {
          try { ctx.room.reportScore(0); } catch (e) {}
          stops.push(App.MG.roundTimer(endAt, function (leftSec) {
            if (!sideEl) return;
            var txt = App.MG.mmss(leftSec);
            if (txt !== hudSide) { hudSide = txt; sideEl.textContent = txt; }
            if (leftSec <= 10) sideEl.classList.add('brk-urgent');
          }, endMulti, ctx.room.now));
        }

        updateHud();
        last = Date.now();
        raf = requestAnimationFrame(frame);
      }

      /* Baut Kopfzeile + Canvas + Hinweis (+ Live-Rangliste im Multi). */
      function buildStage() {
        scoreEl = el('div', { class: 'brk-val brk-score' }, ['0']);
        levelEl = el('div', { class: 'brk-val brk-level' }, ['1']);
        livesEl = el('div', { class: 'brk-val brk-lives' }, ['']);
        var cells = [
          el('div', { class: 'brk-cell' }, [el('span', { class: 'brk-cell-l' }, ['Punkte']), scoreEl]),
          el('div', { class: 'brk-cell' }, [el('span', { class: 'brk-cell-l' }, ['Level']), levelEl]),
          el('div', { class: 'brk-cell' }, [el('span', { class: 'brk-cell-l' }, ['Leben']), livesEl])
        ];
        if (isMulti) {
          sideEl = el('div', { class: 'mg-timer brk-timer' }, [App.MG.mmss(MULTI_DURATION)]);
          cells.push(el('div', { class: 'brk-cell brk-cell-r' }, [el('span', { class: 'brk-cell-l' }, ['Zeit']), sideEl]));
        } else {
          sideEl = el('div', { class: 'brk-val brk-best' }, [App.MG.fmt(App.Storage.get('best_breakout', 0))]);
          cells.push(el('div', { class: 'brk-cell brk-cell-r' }, [el('span', { class: 'brk-cell-l' }, ['Beste']), sideEl]));
        }
        var head = el('div', { class: 'brk-head glass' }, cells);

        canvas = el('canvas', { class: 'brk-canvas', width: W, height: H });
        var stage = el('div', { class: 'brk-stage' }, [canvas]);
        g2d = canvas.getContext('2d');

        var hint = el('div', { class: 'brk-hint hint-text' }, [
          'Finger/Maus bewegt das Paddel · Tippen/Leertaste schießt ab · Power-ups fangen: ↔ Breiter · ×3 Multiball · ❄ Langsam'
        ]);

        var kids = [head, stage, hint];
        if (isMulti) {
          var board = App.MG.liveBoard(ctx.room, ctx.me.id);
          stops.push(board.stop);
          kids.push(el('div', { class: 'brk-board-wrap glass' }, [
            el('div', { class: 'mg-field-title' }, ['🏆 Rangliste']), board.root
          ]));
        }
        root.innerHTML = '';
        root.appendChild(el('div', { class: 'brk-wrap' }, kids));
      }

      /* ===================== LEVEL / STEINE ===================== */
      function initLevel(lv) {
        level = lv;
        levelSpeed = Math.min(MAX_SPEED, BALL_BASE + (lv - 1) * BALL_STEP);
        bricks = buildBricks(lv);
        powerups = [];
        wideUntil = 0; slowUntil = 0; paddleW = PW_BASE;
        resetBall();
      }

      function buildBricks(lv) {
        var rng = makeRng((baseSeed + lv * 7919) >>> 0);
        var rows = Math.min(4 + (lv - 1), 8);
        var out = [];
        var p2Base = Math.min(0.55, 0.1 + (lv - 1) * 0.05);
        for (var r = 0; r < rows; r++) {
          for (var c = 0; c < COLS; c++) {
            if (lv >= 3 && rng() < 0.06) continue;              // vereinzelte Lücken
            var p2 = p2Base + (r === 0 ? 0.15 : 0);
            var hp = rng() < p2 ? 2 : 1;
            out.push({
              x: MARGIN_X + c * (BW + GAP),
              y: BTOP + r * (BH + GAP),
              hp: hp, maxhp: hp, color: ROW_COLORS[r % ROW_COLORS.length]
            });
          }
        }
        return out;
      }

      /* Einen einzelnen, am Paddel ruhenden Ball erzeugen. */
      function resetBall() {
        balls = [{
          x: paddleX, y: PADDLE_Y - PH / 2 - R - 1,
          vx: 0, vy: 0, stuck: true, stuckSince: Date.now(), trail: []
        }];
      }

      function launchStuck() {
        var launched = false;
        for (var i = 0; i < balls.length; i++) {
          var b = balls[i];
          if (b.stuck) {
            var ang = (Math.random() * 2 - 1) * 0.4;           // leicht schräg nach oben
            b.vx = levelSpeed * Math.sin(ang);
            b.vy = -levelSpeed * Math.cos(ang);
            b.stuck = false;
            launched = true;
          }
        }
        if (launched && App.Audio) App.Audio.sfx('whoosh');
      }

      /* ===================== EINGABE ===================== */
      function pointerToVX(clientX) {
        if (!canvas) return paddleX;
        var rect = canvas.getBoundingClientRect();
        if (!rect.width) return paddleX;
        return (clientX - rect.left) / rect.width * W;
      }
      function movePaddleTo(vx) { paddleX = clamp(vx, paddleW / 2, W - paddleW / 2); }

      function attachInput() {
        keys.left = keys.right = false;
        var onMove = function (e) {
          if (finished || dead) return;
          movePaddleTo(pointerToVX(e.clientX));
        };
        var onDown = function (e) {
          if (finished || dead) return;
          if (e.preventDefault) e.preventDefault();
          movePaddleTo(pointerToVX(e.clientX));
          launchStuck();
        };
        addL(canvas, 'pointermove', onMove);
        addL(canvas, 'pointerdown', onDown);

        var onKeyDown = function (e) {
          if (finished || dead) return;
          var k = e.key;
          if (k === 'ArrowLeft' || k === 'a' || k === 'A') { keys.left = true; e.preventDefault(); }
          else if (k === 'ArrowRight' || k === 'd' || k === 'D') { keys.right = true; e.preventDefault(); }
          else if (k === ' ' || k === 'Spacebar' || k === 'Enter') { launchStuck(); e.preventDefault(); }
        };
        var onKeyUp = function (e) {
          var k = e.key;
          if (k === 'ArrowLeft' || k === 'a' || k === 'A') keys.left = false;
          else if (k === 'ArrowRight' || k === 'd' || k === 'D') keys.right = false;
        };
        addL(document, 'keydown', onKeyDown);
        addL(document, 'keyup', onKeyUp);
      }

      /* ===================== FRAME-LOOP ===================== */
      function frame() {
        raf = null;
        if (dead || finished) return;
        var nowMs = Date.now();
        var dt = (nowMs - last) / 1000; if (dt < 0) dt = 0; if (dt > 0.05) dt = 0.05; last = nowMs;
        update(dt, nowMs);
        draw(nowMs);
        if (!dead && !finished) raf = requestAnimationFrame(frame);
      }

      function update(dt, nowMs) {
        /* Paddel per Tastatur */
        var kd = (keys.right ? 1 : 0) - (keys.left ? 1 : 0);
        if (kd !== 0) movePaddleTo(paddleX + kd * KB_SPEED * dt);

        /* Power-up-Effekte ablaufen lassen */
        if (wideUntil && nowMs > wideUntil) { wideUntil = 0; paddleW = PW_BASE; movePaddleTo(paddleX); }
        var slowActive = slowUntil && nowMs <= slowUntil;
        if (slowUntil && nowMs > slowUntil) slowUntil = 0;
        var speedFactor = slowActive ? SLOW_FACTOR : 1;

        /* Bälle bewegen */
        var i, b;
        for (i = balls.length - 1; i >= 0; i--) {
          b = balls[i];
          if (b.stuck) {
            b.x = paddleX;
            b.y = PADDLE_Y - PH / 2 - R - 1;
            if (nowMs - b.stuckSince > AUTOLAUNCH_MS) launchStuck();
            pushTrail(b);
            continue;
          }
          b.x += b.vx * dt * speedFactor;
          b.y += b.vy * dt * speedFactor;

          /* Wände */
          if (b.x - R < 0) { b.x = R; b.vx = Math.abs(b.vx); }
          else if (b.x + R > W) { b.x = W - R; b.vx = -Math.abs(b.vx); }
          if (b.y - R < 0) { b.y = R; b.vy = Math.abs(b.vy); }

          /* Paddel */
          if (b.vy > 0 && (b.y + R) >= (PADDLE_Y - PH / 2) && (b.y - R) <= (PADDLE_Y + PH / 2) &&
              b.x >= paddleX - paddleW / 2 - R && b.x <= paddleX + paddleW / 2 + R) {
            b.y = PADDLE_Y - PH / 2 - R;
            var rel = clamp((b.x - paddleX) / (paddleW / 2), -1, 1);
            var ang = rel * MAX_ANGLE;
            var sp = Math.min(MAX_SPEED, Math.hypot(b.vx, b.vy) * HIT_SPEEDUP);
            b.vx = sp * Math.sin(ang);
            b.vy = -Math.abs(sp * Math.cos(ang));
            enforceMinVy(b);
            if (App.Audio) App.Audio.blip(520, 0.05, { type: 'square', peak: 0.05 });
          }

          /* Steine (höchstens ein Treffer pro Ball & Frame -> kein Doppel-Flip) */
          hitBricks(b);

          /* Unten raus -> Ball verloren */
          if (b.y - R > H) { balls.splice(i, 1); }
          else pushTrail(b);
        }

        /* Alle Bälle weg -> Leben verlieren */
        if (balls.length === 0 && !finished) loseLife(nowMs);

        /* Power-ups fallen / fangen */
        for (i = powerups.length - 1; i >= 0; i--) {
          var pu = powerups[i];
          pu.y += PU_FALL * dt;
          if (pu.y - PU_H / 2 > H) { powerups.splice(i, 1); continue; }
          if (pu.y + PU_H / 2 >= PADDLE_Y - PH / 2 && pu.y - PU_H / 2 <= PADDLE_Y + PH / 2 &&
              pu.x >= paddleX - paddleW / 2 - PU_W / 2 && pu.x <= paddleX + paddleW / 2 + PU_W / 2) {
            applyPowerup(pu, nowMs);
            powerups.splice(i, 1);
          }
        }

        /* Partikel */
        for (i = particles.length - 1; i >= 0; i--) {
          var p = particles[i];
          p.x += p.vx * dt; p.y += p.vy * dt; p.vy += 520 * dt; p.life -= dt;
          if (p.life <= 0) particles.splice(i, 1);
        }

        /* Level geschafft? */
        if (bricks.length === 0 && !finished) levelClear(nowMs);

        /* Punkte melden (gedrosselt) */
        if (isMulti && scoreDirty && (nowMs - lastReport) > 250) {
          lastReport = nowMs; scoreDirty = false;
          try { ctx.room.reportScore(score); } catch (e) {}
        }

        updateHud();
      }

      function pushTrail(b) { b.trail.push({ x: b.x, y: b.y }); if (b.trail.length > 7) b.trail.shift(); }
      function enforceMinVy(b) {
        var sp = Math.hypot(b.vx, b.vy); if (sp <= 0) return;
        var minVy = sp * MIN_VY_FRAC;
        if (Math.abs(b.vy) < minVy) {
          var sign = b.vy < 0 ? -1 : 1;
          b.vy = sign * minVy;
          b.vx = (b.vx < 0 ? -1 : 1) * Math.sqrt(Math.max(0, sp * sp - b.vy * b.vy));
        }
      }

      function hitBricks(b) {
        for (var k = 0; k < bricks.length; k++) {
          var br = bricks[k];
          var nearestX = clamp(b.x, br.x, br.x + BW);
          var nearestY = clamp(b.y, br.y, br.y + BH);
          var dx = b.x - nearestX, dy = b.y - nearestY;
          if (dx * dx + dy * dy > R * R) continue;

          /* Abpralls-Achse über kleinere Durchdringung bestimmen */
          var ox = (R + BW / 2) - Math.abs(b.x - (br.x + BW / 2));
          var oy = (R + BH / 2) - Math.abs(b.y - (br.y + BH / 2));
          if (ox < oy) {
            b.vx = -b.vx;
            b.x += (b.x < br.x + BW / 2 ? -1 : 1) * ox;
          } else {
            b.vy = -b.vy;
            b.y += (b.y < br.y + BH / 2 ? -1 : 1) * oy;
          }
          enforceMinVy(b);
          damageBrick(k, br);
          return;    // nur ein Stein pro Frame
        }
      }

      function damageBrick(index, br) {
        br.hp--;
        var cx = br.x + BW / 2, cy = br.y + BH / 2;
        if (br.hp > 0) {
          score += 4; scoreDirty = true;
          burst(cx, cy, br.color, 4);
          if (App.Audio) App.Audio.blip(300, 0.04, { type: 'square', peak: 0.05 });
          return;
        }
        /* zerstört */
        score += (br.maxhp === 2 ? 25 : 12) + level * 2; scoreDirty = true;
        bricks.splice(index, 1);
        burst(cx, cy, br.color, 10);
        if (App.Audio) App.Audio.blip(440 + Math.random() * 120, 0.06, { type: 'triangle', peak: 0.06 });
        /* Power-up? */
        if (Math.random() < PU_CHANCE) {
          var t = PU_TYPES[(Math.random() * PU_TYPES.length) | 0];
          powerups.push({ x: cx, y: cy, k: t.k, glyph: t.glyph, color: t.color });
        }
      }

      function applyPowerup(pu, nowMs) {
        score += 20; scoreDirty = true;
        if (App.Audio) App.Audio.sfx('powerup');
        burst(pu.x, PADDLE_Y, pu.color, 12);
        levelMsg = puLabel(pu.k); levelMsgUntil = nowMs + 900;
        if (pu.k === 'wide') { paddleW = PW_WIDE; wideUntil = nowMs + WIDE_MS; movePaddleTo(paddleX); }
        else if (pu.k === 'slow') { slowUntil = nowMs + SLOW_MS; }
        else if (pu.k === 'multi') {
          var src = null, j;
          for (j = 0; j < balls.length; j++) { if (!balls[j].stuck) { src = balls[j]; break; } }
          if (!src) src = balls[0];
          if (src) {
            var add = Math.min(2, MAX_BALLS - balls.length);
            var sp = Math.max(levelSpeed, Math.hypot(src.vx, src.vy) || levelSpeed);
            var baseAng = Math.atan2(src.vy || -1, src.vx || 0);
            for (j = 1; j <= add; j++) {
              var a = baseAng + (j === 1 ? 0.45 : -0.45);
              balls.push({ x: src.x, y: src.y, vx: sp * Math.cos(a), vy: sp * Math.sin(a), stuck: false, stuckSince: nowMs, trail: [] });
            }
          }
        }
      }
      function puLabel(k) { return k === 'wide' ? 'Breiteres Paddel!' : k === 'multi' ? 'Multiball!' : 'Langsamer!'; }

      /* ===================== LEBEN / LEVEL / ENDE ===================== */
      function loseLife(nowMs) {
        lives--;
        flashUntil = nowMs + 400; flashColor = 'rgba(255,77,109,0.20)';
        burst(paddleX, PADDLE_Y, '#ff4d6d', 16);
        powerups = [];
        wideUntil = 0; slowUntil = 0; paddleW = PW_BASE;
        if (App.Audio) App.Audio.sfx('explosion');
        if (lives <= 0) {
          if (isMulti) {
            /* Punkte bleiben erhalten — nur das Brett startet neu bei Level 1 */
            lives = START_LIVES;
            initLevel(1);
            levelMsg = 'Brett zurückgesetzt'; levelMsgUntil = nowMs + 1400;
          } else {
            endSolo();
          }
        } else {
          resetBall();
        }
      }

      function levelClear(nowMs) {
        score += 80 + level * 25; scoreDirty = true;
        flashUntil = nowMs + 500; flashColor = 'rgba(57,255,20,0.16)';
        if (App.Audio) App.Audio.sfx('levelup');
        initLevel(level + 1);
        levelMsg = 'Level ' + level; levelMsgUntil = nowMs + 1400;
      }

      function endSolo() {
        if (finished || dead) return;
        finished = true;
        if (raf) { cancelAnimationFrame(raf); raf = null; }
        if (App.Audio) App.Audio.sfx('lose');
        var best = App.Storage.get('best_breakout', 0);
        var nb = score > best;
        if (nb) App.Storage.set('best_breakout', score);
        App.MG.endScreen(root, {
          score: score, best: best, newBest: nb,
          label: (nb ? 'Neuer Rekord! 🎉' : 'Bestwert: ' + App.MG.fmt(best)) + ' · Level ' + level,
          onExit: ctx.onExit,
          onAgain: function () { if (dead) return; play(Date.now()); }
        });
      }

      function endMulti() {
        if (finished || dead) return;
        finished = true;
        if (raf) { cancelAnimationFrame(raf); raf = null; }
        try { ctx.room.reportScore(score); } catch (e) {}
        if (App.Audio) App.Audio.sfx('win');
        after(1000, function () {
          if (dead) return;
          App.MG.endScreen(root, { players: ctx.room.players(), meId: ctx.me.id, onExit: ctx.onExit });
        });
      }

      /* ===================== HUD ===================== */
      function updateHud() {
        if (scoreEl && score !== hudScore) {
          hudScore = score; scoreEl.textContent = App.MG.fmt(score);
          scoreEl.classList.remove('brk-bump'); void scoreEl.offsetWidth; scoreEl.classList.add('brk-bump');
        }
        if (levelEl && level !== hudLevel) { hudLevel = level; levelEl.textContent = String(level); }
        if (livesEl && lives !== hudLives) {
          hudLives = lives;
          var s = '';
          for (var i = 0; i < START_LIVES; i++) s += (i < lives ? '❤️' : '🤍');
          livesEl.textContent = s;
        }
        if (!isMulti && sideEl) {
          var bestNow = Math.max(score, App.Storage.get('best_breakout', 0));
          var bt = App.MG.fmt(bestNow);
          if (bt !== hudSide) { hudSide = bt; sideEl.textContent = bt; }
        }
      }

      /* ===================== ZEICHNEN ===================== */
      function draw(nowMs) {
        var g = g2d; if (!g) return;
        g.clearRect(0, 0, W, H);
        var grd = g.createLinearGradient(0, 0, 0, H);
        grd.addColorStop(0, '#06180e'); grd.addColorStop(1, '#020c07');
        g.fillStyle = grd; g.fillRect(0, 0, W, H);

        /* Rahmen */
        g.save(); g.strokeStyle = 'rgba(57,255,20,0.22)'; g.lineWidth = 4;
        roundRect(g, 4, 4, W - 8, H - 8, 16); g.stroke(); g.restore();

        /* Steine */
        var i;
        for (i = 0; i < bricks.length; i++) drawBrick(g, bricks[i]);

        /* Power-ups */
        for (i = 0; i < powerups.length; i++) drawPowerup(g, powerups[i]);

        /* Paddel */
        drawPaddle(g, nowMs);

        /* Bälle + Spuren */
        for (i = 0; i < balls.length; i++) drawBall(g, balls[i]);

        /* Partikel */
        for (i = 0; i < particles.length; i++) {
          var p = particles[i], a = Math.max(0, p.life / p.maxlife);
          g.globalAlpha = a;
          g.fillStyle = p.color;
          g.fillRect(p.x - p.s / 2, p.y - p.s / 2, p.s, p.s);
        }
        g.globalAlpha = 1;

        /* Hinweis "abschießen" solange ein Ball ruht */
        var anyStuck = false;
        for (i = 0; i < balls.length; i++) if (balls[i].stuck) { anyStuck = true; break; }
        if (anyStuck && !finished) {
          g.save();
          g.fillStyle = 'rgba(157,255,122,0.85)';
          g.font = '700 18px "Segoe UI",system-ui,Roboto,Arial,sans-serif';
          g.textAlign = 'center'; g.textBaseline = 'middle';
          g.fillText('Tippen / Leertaste zum Abschießen ↑', W / 2, PADDLE_Y - 70);
          g.restore();
        }

        /* Level-/Effekt-Meldung */
        if (levelMsgUntil > nowMs && levelMsg) {
          g.save();
          g.globalAlpha = Math.min(1, (levelMsgUntil - nowMs) / 500);
          g.fillStyle = '#eaffe0';
          g.shadowColor = 'rgba(57,255,20,0.8)'; g.shadowBlur = 22;
          g.font = '900 40px "Segoe UI",system-ui,Roboto,Arial,sans-serif';
          g.textAlign = 'center'; g.textBaseline = 'middle';
          g.fillText(levelMsg, W / 2, H / 2 - 40);
          g.restore();
        }

        /* Voll-Flash bei Lebensverlust / Levelwechsel */
        if (flashUntil > nowMs) {
          g.save();
          g.globalAlpha = Math.min(1, (flashUntil - nowMs) / 400);
          g.fillStyle = flashColor;
          g.fillRect(0, 0, W, H);
          g.restore();
        }
      }

      function drawBrick(g, br) {
        g.save();
        g.shadowColor = br.color; g.shadowBlur = 8;
        g.fillStyle = br.color;
        roundRect(g, br.x, br.y, BW, BH, 6); g.fill();
        g.shadowBlur = 0;
        if (br.maxhp === 2 && br.hp === 2) {
          /* verstärkter Stein: abdunkeln + heller Innenrahmen */
          g.fillStyle = 'rgba(2,10,6,0.42)';
          roundRect(g, br.x, br.y, BW, BH, 6); g.fill();
          g.strokeStyle = 'rgba(255,255,255,0.75)'; g.lineWidth = 2;
          roundRect(g, br.x + 3.5, br.y + 3.5, BW - 7, BH - 7, 4); g.stroke();
        } else {
          g.fillStyle = 'rgba(255,255,255,0.16)';
          roundRect(g, br.x + 2, br.y + 2, BW - 4, BH * 0.42, 4); g.fill();
        }
        g.restore();
      }

      function drawPowerup(g, pu) {
        g.save();
        g.shadowColor = pu.color; g.shadowBlur = 14;
        g.fillStyle = pu.color;
        roundRect(g, pu.x - PU_W / 2, pu.y - PU_H / 2, PU_W, PU_H, 7); g.fill();
        g.shadowBlur = 0;
        g.fillStyle = '#04160c';
        g.font = '900 13px "Segoe UI",system-ui,Roboto,Arial,sans-serif';
        g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillText(pu.glyph, pu.x, pu.y + 0.5);
        g.restore();
      }

      function drawPaddle(g, nowMs) {
        var wide = wideUntil && nowMs <= wideUntil;
        var col = wide ? '#33e6d0' : '#39ff14';
        g.save();
        g.shadowColor = wide ? 'rgba(51,230,208,0.8)' : 'rgba(57,255,20,0.8)';
        g.shadowBlur = 22; g.fillStyle = col;
        roundRect(g, paddleX - paddleW / 2, PADDLE_Y - PH / 2, paddleW, PH, PH / 2); g.fill();
        g.shadowBlur = 0;
        g.fillStyle = 'rgba(255,255,255,0.28)';
        roundRect(g, paddleX - paddleW / 2 + 4, PADDLE_Y - PH / 2 + 2, paddleW - 8, PH * 0.4, 4); g.fill();
        g.restore();
      }

      function drawBall(g, b) {
        var t, a;
        g.save();
        for (t = 0; t < b.trail.length; t++) {
          a = (t + 1) / b.trail.length;
          g.fillStyle = 'rgba(180,255,150,' + (a * 0.28).toFixed(3) + ')';
          g.beginPath(); g.arc(b.trail[t].x, b.trail[t].y, R * (0.35 + a * 0.7), 0, Math.PI * 2); g.fill();
        }
        g.shadowColor = 'rgba(57,255,20,0.95)'; g.shadowBlur = 22; g.fillStyle = '#eaffe0';
        g.beginPath(); g.arc(b.x, b.y, R, 0, Math.PI * 2); g.fill();
        g.restore();
      }

      /* ===================== KLEINKRAM ===================== */
      function burst(x, y, color, n) {
        for (var i = 0; i < n; i++) {
          if (particles.length >= MAX_PARTICLES) break;
          var ang = Math.random() * Math.PI * 2, sp = 60 + Math.random() * 160;
          particles.push({
            x: x, y: y, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp - 40,
            life: 0.4 + Math.random() * 0.35, maxlife: 0.75, s: 3 + Math.random() * 3, color: color
          });
        }
      }
    }
  };

  /* ===================== reine Helfer (Modul-Ebene) ===================== */
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function makeRng(seed) {
    var s = (seed >>> 0) || 1;
    return function () { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
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

  /* ===================== STYLES ===================== */
  function injectStyle() {
    UI.injectStyle('mg-breakout-css', [
      '.brk-wrap{display:flex;flex-direction:column;gap:12px;align-items:stretch;}',
      '.brk-head{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:10px 16px;flex-wrap:wrap;}',
      '.brk-cell{display:flex;flex-direction:column;gap:2px;min-width:0;}',
      '.brk-cell-r{text-align:right;align-items:flex-end;}',
      '.brk-cell-l{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:1px;}',
      '.brk-val{font-size:clamp(20px,5vw,30px);font-weight:900;line-height:1;font-variant-numeric:tabular-nums;}',
      '.brk-score{color:var(--gold);text-shadow:0 0 12px rgba(255,210,63,.45);}',
      '.brk-level{color:var(--aqua);text-shadow:0 0 12px rgba(51,230,208,.45);}',
      '.brk-lives{font-size:clamp(15px,4vw,20px);letter-spacing:1px;}',
      '.brk-best{color:var(--leaf);}',
      '.brk-head .brk-timer{font-size:clamp(18px,5vw,26px);}',
      '.brk-head .mg-timer.brk-urgent{color:var(--danger);animation:brk-pulse .7s infinite;}',
      '.brk-bump{animation:brk-bump .25s ease;}',
      '.brk-stage{width:100%;max-width:460px;margin:0 auto;aspect-ratio:480 / 600;position:relative;}',
      '.brk-canvas{display:block;width:100%;height:100%;border-radius:16px;',
      'border:2px solid rgba(57,255,20,.35);background:#04140c;',
      'box-shadow:0 0 42px rgba(57,255,20,.22),inset 0 0 60px rgba(57,255,20,.06);',
      'touch-action:none;user-select:none;-webkit-user-select:none;-webkit-tap-highlight-color:transparent;cursor:none;}',
      '.brk-hint{text-align:center;line-height:1.5;}',
      '.brk-board-wrap{padding:14px;display:flex;flex-direction:column;gap:8px;}',
      '.brk-board-wrap .mg-scoreboard{max-height:280px;overflow-y:auto;}',
      '@keyframes brk-pulse{0%,100%{opacity:1}50%{opacity:.4}}',
      '@keyframes brk-bump{0%{transform:scale(1)}40%{transform:scale(1.22)}100%{transform:scale(1)}}'
    ].join(''));
  }
})();
