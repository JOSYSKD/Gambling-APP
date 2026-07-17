/* stackball.js — "Stapel-Ball": Stack-Ball / Helix-Jump im Neon-Dschungel.
 *
 * IDEE:       Ein leuchtender Ball fällt einen endlosen Turm aus rotierenden
 *             Scheiben (Ringen) hinab. Jede Scheibe ist in 12 Kuchen-Segmente
 *             geteilt: bunte Segmente sind zerbrechlich, dunkelrote sind tödlich,
 *             Lücken sind offen. GEDRÜCKT HALTEN = der Ball wird zum Schmetter-
 *             Feuerball und bohrt sich nach unten durch bunte Segmente (zerbricht
 *             sie, +Punkte, Combo). Trifft er beim Schmettern ein ROTES Segment,
 *             ist das Spiel aus. Darum: LOSLASSEN zum Landen und den Turm per
 *             Wischen drehen, bis eine sichere/offene Stelle vorne ist – dann
 *             weiter schmettern. Je tiefer, desto mehr Punkte pro Segment.
 *             Bei einer Combo von 8 zündet kurz ein FEUERBALL, der auch durch
 *             rote Segmente pflügt (Bonus).
 * STEUERUNG:  Halten (Fläche, ⬇-Knopf, Leertaste/↓) = schmettern.
 *             Wischen auf der Fläche, ◄ ►-Knöpfe oder ←/→ · A/D = Turm drehen.
 * PUNKTE:     Zerbrochenes Segment = Basis (steigt mit Tiefe) × Combo-Faktor.
 *             Solo-Bestwert: best_stackball.
 * SYNC-MODELL: SOLO — Punktejagd gegen den eigenen Rekord bis zum ersten roten
 *             Treffer, dazu drei Dschungel-Rivalen (KI, 3 Stufen) als Live-Race.
 *             MULTI — der Server-Countdown-Zeitpunkt (snapshot().round.startAt)
 *             ist der gemeinsame ZUFALLS-SEED, daher baut jeder Client EXAKT
 *             denselben Turm (fair). Jeder spielt seinen eigenen Ball, meldet die
 *             Punkte per reportScore; roter Treffer = kurzer Boxenstopp + Respawn
 *             (kostet Zeit statt Ausscheiden). 2 Minuten, dann Podest.
 *             Alle Timer laufen über die Wall-Clock (Date.now / room.now) → Tab-
 *             Wechsel-sicher; Physik mit echtem dt, nur rAF zum Zeichnen.
 * cleanup():  stoppt rAF, alle Timer/Timeouts, entfernt alle Listener + room.off(). */
(function () {
  'use strict';
  window.App = window.App || {}; App.Minigames = App.Minigames || {};
  var UI = App.UI, el = UI.el;

  /* ---- virtuelles Spielfeld (Canvas skaliert per CSS) ---- */
  var W = 440, H = 660;
  var TAU = Math.PI * 2;
  var CX = W / 2;
  var BALL_Y = Math.round(H * 0.34);   // feste Bildschirmhöhe des Balls
  var R = 22;                          // Ballradius
  var SEG = 12;                        // Segmente pro Scheibe
  var SEGA = TAU / SEG;                // Winkel je Segment
  var FRONT = Math.PI / 2;             // Vorderseite der Ellipse (unten = Kamera)
  var RX = 152, RY = 40;              // Ellipsen-Radien (perspektivische Scheibe)
  var DISC_H = 13;                     // Scheibendicke (3D-Extrusion)
  var LEVEL_H = 128;                   // Weltabstand zwischen Scheiben
  var REST_CONTACT = 30;               // Abstand Ball<->Scheibenebene beim Ruhen

  /* ---- Physik-Tuning ---- */
  var SMASH_SPEED = 940;               // px/s Bohrtempo beim Halten
  var GRAV = 1700;                     // px/s^2 (nicht-haltend)
  var REST_MAX = 700;                  // px/s Fall-Deckel
  var ROT_SPEED = 3.6;                 // rad/s Turmdrehung per Knopf/Taste
  var DRAG_SENS = 0.0115;              // rad je gewischtem Client-Pixel
  var RAGE_COMBO = 8;                  // Combo für Feuerball
  var RAGE_MS = 1400;                  // Dauer des Feuerballs
  var RAGE_BONUS = 45;                 // Bonuspunkte je durchpflügtem Rot
  var RESPAWN_MS = 1150;               // Boxenstopp im Multiplayer
  var DURATION = 120;                  // s Rundenzeit Multiplayer

  /* ---- Farben (Canvas braucht Literale; am Theme orientiert) ---- */
  var DISC_COLORS = ['#39ff14', '#33e6d0', '#ffd23f', '#9dff7a', '#7ff3e6', '#e08a3c', '#c17bff', '#ff6fae'];
  var DEAD_TOP = '#8f1330', DEAD_LO = '#4a0817';

  injectStyle();

  /* deterministischer Zufall (mulberry32) — gleicher Seed, gleicher Turm */
  function makeRng(seed) {
    var s = seed >>> 0;
    return function () {
      s |= 0; s = (s + 0x6D2B79F5) | 0;
      var t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function shade(hex, f) {
    var r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
    r = Math.max(0, Math.min(255, Math.round(r * f)));
    g = Math.max(0, Math.min(255, Math.round(g * f)));
    b = Math.max(0, Math.min(255, Math.round(b * f)));
    return 'rgb(' + r + ',' + g + ',' + b + ')';
  }

  App.Minigames.stackball = {
    id: 'stackball', title: 'Stapel-Ball', icon: '🔴', order: 143,
    subtitle: 'Bohr dich durch den Neon-Turm – Rot ist tödlich!',
    single: true, multi: true, minPlayers: 2, maxPlayers: 8,

    render: function (root, ctx) {
      var isMulti = ctx.mode === 'multi';
      var perf = (window.performance && performance.now)
        ? function () { return performance.now(); }
        : function () { return Date.now(); };

      /* ---- Laufzeit ---- */
      var dead = false;                 // cleanup-Flag (wie reflex.js)
      var over = false;                 // Runde beendet
      var dying = false;                // Boxenstopp (Multiplayer)
      var raf = null, lastT = 0;
      var stops = [], pending = [], listeners = [];
      var ctx2d = null, canvas = null;

      /* ---- Turm / Ball ---- */
      var SEED = 1, rngSeeded = false;
      var levelCache = {};              // level -> { type:[..], color, broken:[..] }
      var ballDepth = 0, vy = 0, rot = 0;
      var nextLevel = 0, resting = -1, deepest = 0;
      var score = 0, combo = 0, comboBump = 0;
      var rageUntil = 0, rageWasActive = false;
      var ballBob = 0, squash = 0, shake = 0, hurt = 0;
      var particles = [];
      var lastSent = -1, lastSentAt = 0;

      /* ---- Eingabe ---- */
      var rotateHeld = 0, smashBtn = false, keySmash = false;
      var canvasPtr = { active: false, id: -1, dragging: false, lastX: 0, startX: 0, t: 0 };

      /* ---- DOM ---- */
      var scoreEl, depthEl, rightEl, comboEl, startHint, rivalsBox, ctrlRefs = null;

      /* ---- Solo-Rivalen ---- */
      var rivals = [], rivalT0 = 0, lastRivalDraw = 0;

      /* ===================== Aufräumen ===================== */
      function addL(t, ty, fn, opts) { t.addEventListener(ty, fn, opts); listeners.push({ t: t, ty: ty, fn: fn, opts: opts }); }
      function removeAllListeners() { listeners.forEach(function (l) { try { l.t.removeEventListener(l.ty, l.fn, l.opts); } catch (e) {} }); listeners = []; }
      function after(ms, fn) { var id = setTimeout(function () { if (!dead) fn(); }, ms); pending.push(id); return id; }
      function clearPending() { pending.forEach(clearTimeout); pending = []; }
      function stopHelpers() { stops.forEach(function (f) { try { f(); } catch (e) {} }); stops = []; }
      function cancelRaf() { if (raf) { cancelAnimationFrame(raf); raf = null; } }
      function cleanup() { dead = true; cancelRaf(); clearPending(); stopHelpers(); removeAllListeners(); }

      /* ===================== Start ===================== */
      if (isMulti) {
        var snap = ctx.room.snapshot() || {};
        var startAt = (snap.round && snap.round.startAt) || (ctx.room.now() + 3000);
        stops.push(App.MG.countdown(root, startAt, function () { play(startAt); }, ctx.room.now));
      } else {
        play(0);
      }
      return { cleanup: cleanup };

      /* ===================== Turm-Erzeugung ===================== */
      function levelData(level) {
        var cached = levelCache[level];
        if (cached) return cached;
        var r = makeRng((SEED ^ Math.imul(level + 1, 2654435761)) >>> 0);
        var deadChance = Math.min(0.5, 0.10 + level * 0.007);
        var gapChance = 0.16;
        var types = [], i, v, hasSafe = false;
        for (i = 0; i < SEG; i++) {
          v = r();
          if (v < gapChance) { types.push('gap'); }
          else if (v < gapChance + deadChance) { types.push('dead'); }
          else { types.push('safe'); hasSafe = true; }
        }
        if (!hasSafe) { types[Math.floor(r() * SEG) % SEG] = 'safe'; }   // immer eine sichere Stelle
        var broken = [];
        for (i = 0; i < SEG; i++) broken.push(false);
        var d = { type: types, color: DISC_COLORS[((level % DISC_COLORS.length) + DISC_COLORS.length) % DISC_COLORS.length], broken: broken };
        levelCache[level] = d;
        return d;
      }
      function segType(level, idx) {
        var d = levelData(level);
        if (d.broken[idx]) return 'broken';
        return d.type[idx];
      }
      function frontIndex() {
        var i = Math.round((FRONT - rot) / SEGA);
        return ((i % SEG) + SEG) % SEG;
      }
      function findPassable(level) {
        var d = levelData(level), i;
        for (i = 0; i < SEG; i++) if (!d.broken[i] && d.type[i] === 'safe') return i;
        for (i = 0; i < SEG; i++) if (!d.broken[i] && d.type[i] === 'gap') return i;
        return 0;
      }
      function platDepth(level) { return level * LEVEL_H; }
      function landDepth(level) { return level * LEVEL_H - REST_CONTACT; }

      /* ===================== Spiel aufsetzen ===================== */
      function play(startAt) {
        cancelRaf(); clearPending(); stopHelpers();
        over = false; dying = false;

        SEED = isMulti ? ((Math.floor(startAt) >>> 0) || 1)
                       : ((((Date.now() ^ (Math.random() * 1e9)) >>> 0)) || 1);
        rngSeeded = true;
        levelCache = {};

        ballDepth = landDepth(0); vy = 0; rot = FRONT - findPassable(0) * SEGA;
        nextLevel = 0; resting = 0; deepest = 0;
        score = 0; combo = 0; comboBump = 0; rageUntil = 0; rageWasActive = false;
        ballBob = 0; squash = 0; shake = 0; hurt = 0; particles = [];
        lastSent = -1; lastSentAt = 0;
        rotateHeld = 0; smashBtn = false; keySmash = false;
        canvasPtr.active = false; canvasPtr.dragging = false;

        buildStage(startAt);
        attachInput();

        if (isMulti) {
          var board = App.MG.liveBoard(ctx.room, ctx.me.id);
          stops.push(board.stop);
          rivalsBox.innerHTML = '';
          rivalsBox.appendChild(board.root);
          ctx.room.reportScore(0);
          var endAt = Math.floor(startAt) + DURATION * 1000;
          stops.push(App.MG.roundTimer(endAt, function (left) {
            rightEl.textContent = App.MG.mmss(left);
            if (left <= 10) rightEl.classList.add('sbl-urgent');
          }, finishMulti, ctx.room.now));
        } else {
          setupRivals();
          drawRivals(true);
        }

        lastT = perf();
        raf = requestAnimationFrame(frame);
      }

      /* ===================== Solo-Rivalen ===================== */
      function setupRivals() {
        rivals = [
          { name: 'Koko', icon: '🐒', pace: 15, phase: 0.4, score: 0 },
          { name: 'Rana', icon: '🐸', pace: 23, phase: 2.1, score: 0 },
          { name: 'Tiko', icon: '🦎', pace: 32, phase: 4.3, score: 0 }
        ];
        rivalT0 = perf(); lastRivalDraw = 0;
      }
      function updateRivals(dt) {
        var elapsed = (perf() - rivalT0) / 1000, ramp = 1 + elapsed / 95, i, rv;
        for (i = 0; i < rivals.length; i++) {
          rv = rivals[i];
          rv.score += rv.pace * ramp * (0.8 + 0.35 * Math.sin(elapsed * 0.9 + rv.phase)) * dt;
          if (rv.score < 0) rv.score = 0;
        }
      }
      function drawRivals(force) {
        if (!rivalsBox) return;
        var now = perf();
        if (!force && now - lastRivalDraw < 380) return;
        lastRivalDraw = now;
        var rows = [{ name: (ctx.me && ctx.me.name) || 'Du', icon: '🔴', score: score, me: true }];
        var i;
        for (i = 0; i < rivals.length; i++) rows.push({ name: rivals[i].name, icon: rivals[i].icon, score: Math.round(rivals[i].score), me: false });
        rows.sort(function (a, b) { return b.score - a.score; });
        rivalsBox.innerHTML = '';
        for (i = 0; i < rows.length; i++) {
          rivalsBox.appendChild(el('div', { class: 'sbl-rrow' + (rows[i].me ? ' me' : '') }, [
            el('span', { class: 'sbl-rrank' }, ['' + (i + 1)]),
            el('span', { class: 'sbl-ricon' }, [rows[i].icon]),
            el('span', { class: 'sbl-rname' }, [rows[i].name + (rows[i].me ? ' (du)' : '')]),
            el('span', { class: 'sbl-rscore' }, [App.MG.fmt(rows[i].score)])
          ]));
        }
      }

      /* ===================== Frame-Schleife ===================== */
      function frame() {
        if (dead) { raf = null; return; }
        var now = perf();
        var dt = (now - lastT) / 1000; lastT = now;
        if (dt < 0) dt = 0; if (dt > 0.05) dt = 0.05;

        step(dt);
        updateParticles(dt);
        if (!isMulti && !over) { updateRivals(dt); drawRivals(false); }
        draw();

        // Punkte melden (gedrosselt) im Multiplayer
        if (isMulti && !over && score !== lastSent && (now - lastSentAt) > 250) {
          lastSent = score; lastSentAt = now;
          try { ctx.room.reportScore(score); } catch (e) {}
        }
        raf = requestAnimationFrame(frame);
      }

      function isHolding() {
        if (dying || over) return false;
        if (smashBtn || keySmash) return true;
        if (canvasPtr.active && !canvasPtr.dragging && (perf() - canvasPtr.t) > 90) return true;
        return false;
      }
      function rageActive() { return perf() < rageUntil; }

      /* ===================== Physik ===================== */
      function step(dt) {
        // Drehung aus gehaltenen Knöpfen/Tasten
        if (rotateHeld !== 0) rot += rotateHeld * ROT_SPEED * dt;
        rot = ((rot % TAU) + TAU) % TAU;

        // Feuerball-Ablauf: nach dem Burst Combo zurücksetzen
        if (rageWasActive && !rageActive()) { combo = 0; comboBump = 1; rageWasActive = false; }

        if (over || dying) { updateBallVisual(dt); return; }

        var fi = frontIndex();
        var holding = isHolding();

        if (holding) {
          resting = -1;
          var speed = SMASH_SPEED + Math.min(combo, 30) * 14 + (rageActive() ? 380 : 0);
          vy = speed;
          ballDepth += vy * dt;
          var guard = 0;
          while (ballDepth >= platDepth(nextLevel)) {
            var t = segType(nextLevel, fi);
            if (t === 'gap' || t === 'broken') { passGap(nextLevel); }
            else if (t === 'safe') { smashSafe(nextLevel, fi); }
            else { // dead
              if (rageActive()) { smashDead(nextLevel, fi); }
              else { die(nextLevel); return; }
            }
            nextLevel++;
            if (nextLevel > deepest) deepest = nextLevel;
            guard++; if (guard > 60) break;
          }
        } else {
          var supt = segType(nextLevel, fi);
          var solid = (supt === 'safe' || supt === 'dead');
          if (solid && ballDepth >= landDepth(nextLevel) && vy >= 0) {
            if (resting !== nextLevel) onLand(nextLevel);
            resting = nextLevel; ballDepth = landDepth(nextLevel); vy = 0;
          } else {
            resting = -1;
            vy += GRAV * dt; if (vy > REST_MAX) vy = REST_MAX;
            ballDepth += vy * dt;
            var g2 = 0;
            while (ballDepth >= platDepth(nextLevel)) {
              var t2 = segType(nextLevel, fi);
              if (t2 === 'safe' || t2 === 'dead') {
                ballDepth = landDepth(nextLevel); vy = 0;
                if (resting !== nextLevel) onLand(nextLevel);
                resting = nextLevel;
                break;
              } else {
                passGap(nextLevel); nextLevel++;
                if (nextLevel > deepest) deepest = nextLevel;
              }
              g2++; if (g2 > 60) break;
            }
          }
        }
        updateBallVisual(dt);
      }

      function updateBallVisual(dt) {
        if (resting >= 0) ballBob = Math.sin(perf() / 260) * 2.2; else ballBob = 0;
        if (squash > 0) { squash -= dt * 5; if (squash < 0) squash = 0; }
        if (shake > 0) { shake -= dt * 42; if (shake < 0) shake = 0; }
        if (hurt > 0) { hurt -= dt * 1.6; if (hurt < 0) hurt = 0; }
        if (comboBump > 0) { comboBump -= dt * 4; if (comboBump < 0) comboBump = 0; }
      }

      function onLand(level) {
        combo = 0;
        squash = 1; shake = Math.max(shake, 4);
        if (App.Audio) App.Audio.sfx('step');
        updateHud();
      }
      function passGap(level) {
        if (Math.random() < 0.5 && App.Audio) App.Audio.blip(220, 0.04, { type: 'sine', peak: 0.04 });
      }
      function scoreForSmash(level) {
        var base = 8 + Math.floor(level / 3);
        var mult = 1 + Math.min(2.5, combo * 0.14);
        return Math.round(base * mult);
      }
      function smashSafe(level, fi) {
        var d = levelData(level); d.broken[fi] = true;
        combo++; comboBump = 1;
        score += scoreForSmash(level);
        spawnDebris(d.color, 8);
        squash = 1; shake = Math.max(shake, 3.5);
        if (!rageActive() && combo >= RAGE_COMBO) {
          rageUntil = perf() + RAGE_MS; rageWasActive = true;
          shake = Math.max(shake, 10); hurt = Math.max(hurt, 0.2);
          if (App.Audio) App.Audio.sfx('powerup');
        }
        if (App.Audio) App.Audio.blip(300 + Math.min(combo, 22) * 22, 0.045, { type: 'square', peak: 0.06 });
        updateHud();
      }
      function smashDead(level, fi) {
        var d = levelData(level); d.broken[fi] = true;
        score += RAGE_BONUS; comboBump = 1;
        spawnDebris('#ff7043', 12);
        shake = Math.max(shake, 8);
        if (App.Audio) App.Audio.sfx('explosion');
        updateHud();
      }
      function die(level) {
        if (over) return;
        spawnDebris('#ff4d6d', 22);
        shake = Math.max(shake, 16); hurt = 1;
        if (App.Audio) { App.Audio.sfx('explosion'); App.Audio.sfx('lose'); }
        if (isMulti) {
          dying = true;
          after(RESPAWN_MS, function () { respawn(level); });
        } else {
          over = true;
          if (startHint) startHint.classList.add('sbl-hide');
          after(950, finishSolo);
        }
      }
      function respawn(level) {
        if (dead || over) return;
        dying = false;
        combo = 0; comboBump = 0; rageUntil = 0; rageWasActive = false;
        nextLevel = level; resting = level; vy = 0;
        ballDepth = landDepth(level);
        rot = FRONT - findPassable(level) * SEGA;   // sichere Stelle nach vorn drehen
        shake = Math.max(shake, 5);
        if (App.Audio) App.Audio.sfx('pop');
        updateHud();
      }

      /* ===================== Partikel ===================== */
      function spawnDebris(color, n) {
        var i, a, sp, sx = CX, sy = BALL_Y - R + ballBob;
        for (i = 0; i < n; i++) {
          a = Math.random() * TAU; sp = 60 + Math.random() * 220;
          particles.push({
            x: sx + (Math.random() * 2 - 1) * 10, y: sy + (Math.random() * 2 - 1) * 6,
            vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 120,
            life: 0.4 + Math.random() * 0.5, max: 0.9,
            c: color, s: 2 + Math.random() * 4
          });
        }
        if (particles.length > 160) particles.splice(0, particles.length - 160);
      }
      function updateParticles(dt) {
        var i, p;
        for (i = particles.length - 1; i >= 0; i--) {
          p = particles[i];
          p.vy += 900 * dt;
          p.x += p.vx * dt; p.y += p.vy * dt;
          p.life -= dt;
          if (p.life <= 0) particles.splice(i, 1);
        }
      }

      /* ===================== HUD ===================== */
      function updateHud() {
        if (scoreEl) scoreEl.textContent = App.MG.fmt(score);
        if (depthEl) depthEl.textContent = String(deepest);
        if (comboEl) {
          if (rageActive()) { comboEl.textContent = '🔥 FEUERBALL'; comboEl.className = 'sbl-combo is-rage show'; }
          else if (combo >= 2) { comboEl.textContent = 'Combo ×' + combo; comboEl.className = 'sbl-combo show'; }
          else { comboEl.className = 'sbl-combo'; }
        }
      }

      /* ===================== Zeichnen ===================== */
      function draw() {
        var g = ctx2d; if (!g) return;
        g.clearRect(0, 0, W, H);
        // Hintergrund
        var bg = g.createLinearGradient(0, 0, 0, H);
        bg.addColorStop(0, '#04160d'); bg.addColorStop(0.55, '#03110a'); bg.addColorStop(1, '#010805');
        g.fillStyle = bg; g.fillRect(0, 0, W, H);

        g.save();
        if (shake > 0) g.translate((Math.random() * 2 - 1) * shake, (Math.random() * 2 - 1) * shake);

        // zentrale Helix-Achse
        g.save();
        g.fillStyle = 'rgba(57,255,20,0.05)';
        g.fillRect(CX - 10, 0, 20, H);
        g.restore();

        // sichtbaren Level-Bereich bestimmen
        var topDepth = ballDepth - (BALL_Y + 160);
        var botDepth = ballDepth + (H - BALL_Y + 160);
        var lo = Math.floor(topDepth / LEVEL_H) - 1;
        var hi = Math.ceil(botDepth / LEVEL_H) + 1;
        if (lo < 0) lo = 0;
        var fi = frontIndex();
        var lv;
        for (lv = lo; lv <= hi; lv++) drawDisc(g, lv, fi);

        // Ball
        drawBall(g);

        // Partikel
        drawParticles(g);
        g.restore();

        // Verletzungs-Vignette
        if (hurt > 0) {
          var vg = g.createRadialGradient(CX, BALL_Y, 40, CX, BALL_Y, H * 0.75);
          vg.addColorStop(0, 'rgba(255,40,70,0)');
          vg.addColorStop(1, 'rgba(255,30,60,' + (0.42 * hurt).toFixed(3) + ')');
          g.fillStyle = vg; g.fillRect(0, 0, W, H);
        }
      }

      function screenY(depth) { return BALL_Y + (depth - ballDepth); }

      function drawDisc(g, level, fi) {
        var d = levelData(level);
        var cy = screenY(platDepth(level));
        if (cy < -80 || cy > H + 80) return;

        // Segmente von hinten (oben) nach vorne (unten) sortieren
        var order = [];
        var i;
        for (i = 0; i < SEG; i++) {
          if (d.broken[i] || d.type[i] === 'gap') continue;
          var wc = i * SEGA + rot;
          order.push({ i: i, s: Math.sin(wc), wc: wc });
        }
        order.sort(function (a, b) { return a.s - b.s; });

        for (i = 0; i < order.length; i++) {
          var seg = order[i];
          var isDead = d.type[seg.i] === 'dead';
          var topC = isDead ? DEAD_TOP : d.color;
          var loC = isDead ? DEAD_LO : shade(d.color, 0.42);
          var near = (seg.s + 1) / 2;                  // 0 hinten .. 1 vorne
          // Seitenwand (Extrusion nach unten)
          fillWedge(g, cy + DISC_H, seg.wc, loC, 0.85);
          // Deckfläche
          fillWedge(g, cy, seg.wc, topC, 0.55 + 0.45 * near);
          // Vorderes Segment hervorheben (Rückmeldung, wo der Ball trifft)
          if (seg.i === fi) {
            g.save();
            g.lineWidth = 3;
            g.strokeStyle = isDead ? 'rgba(255,90,120,0.95)' : 'rgba(255,255,255,0.9)';
            g.shadowColor = isDead ? 'rgba(255,60,90,0.9)' : 'rgba(255,255,255,0.8)';
            g.shadowBlur = 14;
            strokeWedge(g, cy, seg.wc);
            g.restore();
          }
        }
      }

      // Kuchen-Segment (Mittelpunkt -> Ellipsenrand) füllen
      function wedgePath(g, cy, wc) {
        var a0 = wc - SEGA / 2, a1 = wc + SEGA / 2, steps = 5, i, a;
        g.beginPath();
        g.moveTo(CX, cy);
        for (i = 0; i <= steps; i++) {
          a = a0 + (a1 - a0) * (i / steps);
          g.lineTo(CX + RX * Math.cos(a), cy + RY * Math.sin(a));
        }
        g.closePath();
      }
      function fillWedge(g, cy, wc, color, alpha) {
        g.save(); g.globalAlpha = alpha; g.fillStyle = color;
        wedgePath(g, cy, wc); g.fill();
        g.restore();
      }
      function strokeWedge(g, cy, wc) { wedgePath(g, cy, wc); g.stroke(); }

      function drawBall(g) {
        var holding = isHolding();
        var rage = rageActive();
        var sy = BALL_Y - R + ballBob;
        // Schmetter-Streak
        if (holding) {
          var grd = g.createLinearGradient(0, sy - 96, 0, sy);
          var c0 = rage ? 'rgba(255,140,40,0)' : 'rgba(120,255,120,0)';
          var c1 = rage ? 'rgba(255,160,50,0.55)' : 'rgba(140,255,120,0.5)';
          grd.addColorStop(0, c0); grd.addColorStop(1, c1);
          g.save(); g.fillStyle = grd;
          g.beginPath(); g.moveTo(CX - R * 0.7, sy); g.lineTo(CX + R * 0.7, sy);
          g.lineTo(CX + R * 0.35, sy - 96); g.lineTo(CX - R * 0.35, sy - 96); g.closePath(); g.fill();
          g.restore();
        }
        var sq = squash > 0 ? squash : 0;
        var rx = R * (1 + sq * 0.28), ry = R * (1 - sq * 0.30);
        g.save();
        g.shadowBlur = rage ? 34 : (holding ? 26 : 18);
        g.shadowColor = rage ? 'rgba(255,150,40,0.95)' : (holding ? 'rgba(120,255,90,0.9)' : 'rgba(51,230,208,0.85)');
        var bg = g.createRadialGradient(CX - rx * 0.32, sy - ry * 0.34, rx * 0.18, CX, sy, rx);
        if (rage) { bg.addColorStop(0, '#fff3d0'); bg.addColorStop(0.5, '#ffb648'); bg.addColorStop(1, '#ff5a2a'); }
        else if (holding) { bg.addColorStop(0, '#f2ffe6'); bg.addColorStop(0.5, '#a6ff6e'); bg.addColorStop(1, '#39b814'); }
        else { bg.addColorStop(0, '#eafff8'); bg.addColorStop(0.5, '#7ff3e6'); bg.addColorStop(1, '#1fb0a0'); }
        g.fillStyle = bg;
        g.beginPath(); g.ellipse(CX, sy, rx, ry, 0, 0, TAU); g.fill();
        // Glanz
        g.globalAlpha = 0.55; g.fillStyle = 'rgba(255,255,255,0.9)';
        g.beginPath(); g.ellipse(CX - rx * 0.3, sy - ry * 0.34, rx * 0.24, ry * 0.18, 0, 0, TAU); g.fill();
        g.restore();
      }

      function drawParticles(g) {
        var i, p;
        g.save();
        for (i = 0; i < particles.length; i++) {
          p = particles[i];
          g.globalAlpha = Math.max(0, Math.min(1, p.life / p.max));
          g.fillStyle = p.c;
          g.fillRect(p.x - p.s / 2, p.y - p.s / 2, p.s, p.s);
        }
        g.restore();
      }

      /* ===================== UI-Aufbau ===================== */
      function buildStage(startAt) {
        scoreEl = el('div', { class: 'sbl-val sbl-v-score' }, ['0']);
        depthEl = el('div', { class: 'sbl-val sbl-v-depth' }, ['0']);
        rightEl = isMulti ? el('div', { class: 'sbl-val sbl-v-time mg-timer' }, [App.MG.mmss(DURATION)])
                          : el('div', { class: 'sbl-val sbl-v-best' }, [App.MG.fmt(App.Storage.get('best_stackball', 0))]);
        var head = el('div', { class: 'sbl-head glass' }, [
          el('div', { class: 'sbl-cell' }, [el('span', { class: 'sbl-cl' }, ['🔴 Punkte']), scoreEl]),
          el('div', { class: 'sbl-cell sbl-mid' }, [el('span', { class: 'sbl-cl' }, ['⬇ Tiefe']), depthEl]),
          el('div', { class: 'sbl-cell sbl-r' }, [el('span', { class: 'sbl-cl' }, [isMulti ? '⏱ Zeit' : '🏆 Rekord']), rightEl])
        ]);

        canvas = el('canvas', { class: 'sbl-canvas' });
        comboEl = el('div', { class: 'sbl-combo' }, ['']);
        startHint = el('div', { class: 'sbl-start' }, [
          el('div', { class: 'sbl-start-i' }, ['⬇']),
          el('div', { class: 'sbl-start-t' }, ['Halten zum Schmettern']),
          el('div', { class: 'sbl-start-s' }, ['Wischen dreht den Turm'])
        ]);
        var stage = el('div', { class: 'sbl-stage' }, [canvas, comboEl, startHint]);

        var btnL = el('button', { class: 'btn sbl-rot', type: 'button', 'aria-label': 'Turm links drehen' }, ['◄']);
        var btnSmash = el('button', { class: 'btn btn-primary sbl-smash', type: 'button', 'aria-label': 'Schmettern' }, ['⬇ HALTEN']);
        var btnR = el('button', { class: 'btn sbl-rot', type: 'button', 'aria-label': 'Turm rechts drehen' }, ['►']);
        var controls = el('div', { class: 'sbl-controls' }, [btnL, btnSmash, btnR]);
        ctrlRefs = { btnL: btnL, btnR: btnR, btnSmash: btnSmash };   // Referenzen für attachInput

        var hint = el('div', { class: 'sbl-hint hint-text' },
          ['Halten = schmettern · Wischen / ◄ ► / ← → · A / D = Turm drehen · ROT ist tödlich – 8er-Combo zündet den 🔥 Feuerball']);

        var boardTitle = isMulti ? '🏆 Rangliste' : '🌴 Dschungel-Rivalen';
        rivalsBox = el('div', { class: 'sbl-board' });
        var boardWrap = el('div', { class: 'sbl-board-wrap glass' }, [
          el('div', { class: 'mg-field-title' }, [boardTitle]), rivalsBox
        ]);

        root.innerHTML = '';
        root.appendChild(el('div', { class: 'sbl-wrap' }, [head, stage, controls, hint, boardWrap]));

        // Canvas scharf per DPR
        var dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
        canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
        ctx2d = canvas.getContext('2d');
        ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);

        updateHud();
        // Start-Hinweis nach kurzer Zeit ausblenden
        after(2600, function () { if (startHint) startHint.classList.add('sbl-hide'); });
      }

      /* ===================== Eingabe ===================== */
      function hideHint() { if (startHint) startHint.classList.add('sbl-hide'); }

      function attachInput() {
        removeAllListeners();
        rotateHeld = 0; smashBtn = false; keySmash = false;
        canvasPtr.active = false; canvasPtr.dragging = false;

        // --- Canvas: Wischen = drehen, Halten (still) = schmettern ---
        addL(canvas, 'pointerdown', function (e) {
          e.preventDefault();
          canvasPtr.active = true; canvasPtr.id = e.pointerId; canvasPtr.dragging = false;
          canvasPtr.startX = e.clientX; canvasPtr.lastX = e.clientX; canvasPtr.t = perf();
          try { canvas.setPointerCapture(e.pointerId); } catch (er) {}
        });
        addL(canvas, 'pointermove', function (e) {
          if (!canvasPtr.active || e.pointerId !== canvasPtr.id) return;
          e.preventDefault();
          var dx = e.clientX - canvasPtr.lastX; canvasPtr.lastX = e.clientX;
          if (Math.abs(e.clientX - canvasPtr.startX) > 7) canvasPtr.dragging = true;
          rot -= dx * DRAG_SENS;
        });
        var canvasUp = function (e) {
          if (e.pointerId !== canvasPtr.id) return;
          canvasPtr.active = false;
          try { canvas.releasePointerCapture(e.pointerId); } catch (er) {}
        };
        addL(canvas, 'pointerup', canvasUp);
        addL(canvas, 'pointercancel', canvasUp);

        // --- Knöpfe ---
        function holdBtn(node, on, off) {
          addL(node, 'pointerdown', function (e) { e.preventDefault(); hideHint(); on(); try { node.setPointerCapture(e.pointerId); } catch (er) {} });
          addL(node, 'pointerup', function (e) { e.preventDefault(); off(); });
          addL(node, 'pointercancel', function () { off(); });
          addL(node, 'pointerleave', function () { off(); });
        }
        if (ctrlRefs) {
          holdBtn(ctrlRefs.btnL, function () { rotateHeld = -1; }, function () { if (rotateHeld === -1) rotateHeld = 0; });
          holdBtn(ctrlRefs.btnR, function () { rotateHeld = 1; }, function () { if (rotateHeld === 1) rotateHeld = 0; });
          holdBtn(ctrlRefs.btnSmash, function () { smashBtn = true; }, function () { smashBtn = false; });
        }

        // --- Tastatur ---
        var onKeyDown = function (e) {
          var k = e.key;
          if (k === 'ArrowLeft' || k === 'a' || k === 'A') { rotateHeld = -1; e.preventDefault(); hideHint(); }
          else if (k === 'ArrowRight' || k === 'd' || k === 'D') { rotateHeld = 1; e.preventDefault(); hideHint(); }
          else if (k === ' ' || k === 'ArrowDown' || k === 's' || k === 'S') { keySmash = true; e.preventDefault(); hideHint(); }
        };
        var onKeyUp = function (e) {
          var k = e.key;
          if (k === 'ArrowLeft' || k === 'a' || k === 'A') { if (rotateHeld === -1) rotateHeld = 0; }
          else if (k === 'ArrowRight' || k === 'd' || k === 'D') { if (rotateHeld === 1) rotateHeld = 0; }
          else if (k === ' ' || k === 'ArrowDown' || k === 's' || k === 'S') { keySmash = false; }
        };
        addL(document, 'keydown', onKeyDown);
        addL(document, 'keyup', onKeyUp);

        // Sicherheitsnetz: globales Loslassen setzt alle Halte-Zustände zurück
        var globalUp = function () { rotateHeld = 0; smashBtn = false; canvasPtr.active = false; };
        addL(document, 'pointerup', globalUp);
        addL(document, 'pointercancel', globalUp);
        addL(window, 'blur', function () { rotateHeld = 0; smashBtn = false; keySmash = false; canvasPtr.active = false; });
      }

      /* ===================== Ende ===================== */
      function finishSolo() {
        if (dead) return;
        over = true; cancelRaf();
        var best = App.Storage.get('best_stackball', 0);
        var nb = score > best;
        if (nb) App.Storage.set('best_stackball', score);
        App.MG.endScreen(root, {
          score: score, best: best, newBest: nb,
          label: 'Tiefe ' + deepest + ' · ' + (nb ? 'neuer Rekord! 🎉' : 'Bestwert: ' + App.MG.fmt(best)),
          onExit: ctx.onExit,
          onAgain: function () { play(0); }
        });
      }
      function finishMulti() {
        if (over || dead) return;
        over = true;
        try { ctx.room.reportScore(score); } catch (e) {}
        after(1200, function () {
          cancelRaf();
          App.MG.endScreen(root, { players: ctx.room.players(), meId: ctx.me.id, onExit: ctx.onExit });
        });
      }
    }
  };

  /* ===================== STYLES ===================== */
  function injectStyle() {
    UI.injectStyle('mg-stackball-css', [
      '.sbl-wrap{display:flex;flex-direction:column;gap:12px;align-items:stretch;}',
      '.sbl-head{display:flex;justify-content:space-between;align-items:center;padding:10px 18px;gap:12px;}',
      '.sbl-cell{display:flex;flex-direction:column;gap:2px;min-width:0;}',
      '.sbl-mid{text-align:center;align-items:center;}',
      '.sbl-r{text-align:right;align-items:flex-end;}',
      '.sbl-cl{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;white-space:nowrap;}',
      '.sbl-val{font-size:clamp(22px,5.6vw,34px);font-weight:900;line-height:1;font-variant-numeric:tabular-nums;}',
      '.sbl-v-score{color:var(--gold);text-shadow:0 0 12px rgba(255,210,63,.45);}',
      '.sbl-v-depth{color:var(--aqua);text-shadow:0 0 12px rgba(51,230,208,.45);}',
      '.sbl-v-best{color:var(--leaf);}',
      '.sbl-v-time{color:var(--leaf);}',
      '.sbl-val.sbl-urgent{color:var(--danger-2);animation:sbl-pulse .7s infinite;}',
      '/* Buehne: Hoehe an Viewport koppeln, damit Flaeche + Steuerung ohne Scrollen zusammen passen */',
      '.sbl-stage{position:relative;width:100%;margin:0 auto;aspect-ratio:440 / 660;',
      'max-width:min(440px, calc((100vh - 220px) * 0.6667));}',
      '.sbl-canvas{display:block;width:100%;height:100%;border-radius:18px;border:2px solid rgba(57,255,20,.32);',
      'background:#03110a;box-shadow:0 0 40px rgba(57,255,20,.2),inset 0 0 60px rgba(57,255,20,.05);',
      'touch-action:none;user-select:none;-webkit-user-select:none;-webkit-tap-highlight-color:transparent;-webkit-touch-callout:none;}',
      /* Combo-Chip */
      '.sbl-combo{position:absolute;top:12px;left:50%;transform:translateX(-50%) translateY(-8px) scale(.9);',
      'padding:6px 14px;border-radius:999px;font-weight:900;font-size:clamp(14px,3.4vw,18px);letter-spacing:.5px;',
      'background:rgba(4,16,10,.82);border:1px solid var(--stroke-2);color:var(--leaf);',
      'opacity:0;pointer-events:none;transition:opacity .18s,transform .18s;text-shadow:0 0 10px rgba(57,255,20,.5);}',
      '.sbl-combo.show{opacity:1;transform:translateX(-50%) translateY(0) scale(1);}',
      '.sbl-combo.is-rage{color:#fff;border-color:rgba(255,140,40,.9);background:rgba(60,20,4,.85);',
      'text-shadow:0 0 14px rgba(255,150,40,.9);animation:sbl-rage .5s ease-in-out infinite;}',
      /* Start-Hinweis */
      '.sbl-start{position:absolute;left:50%;top:58%;transform:translateX(-50%);text-align:center;pointer-events:none;',
      'display:flex;flex-direction:column;gap:4px;align-items:center;transition:opacity .5s;}',
      '.sbl-start.sbl-hide{opacity:0;}',
      '.sbl-start-i{font-size:40px;line-height:1;color:var(--neon);text-shadow:0 0 16px var(--neon);animation:sbl-bob 1s ease-in-out infinite;}',
      '.sbl-start-t{font-weight:900;font-size:18px;color:#eaffe2;text-shadow:0 0 10px rgba(57,255,20,.6);}',
      '.sbl-start-s{font-size:13px;color:var(--leaf);}',
      /* Steuerung */
      '.sbl-controls{display:flex;gap:10px;align-items:stretch;max-width:440px;margin:0 auto;width:100%;}',
      '.sbl-rot{flex:0 0 74px;font-size:26px;font-weight:900;padding:0;min-height:66px;display:flex;align-items:center;justify-content:center;',
      'user-select:none;-webkit-user-select:none;-webkit-touch-callout:none;touch-action:manipulation;}',
      '.sbl-rot:active{transform:scale(.95);}',
      '.sbl-smash{flex:1;min-height:66px;font-size:clamp(17px,4.4vw,22px);font-weight:900;letter-spacing:1px;',
      'user-select:none;-webkit-user-select:none;-webkit-touch-callout:none;touch-action:manipulation;}',
      '.sbl-smash:active{transform:scale(.98);filter:brightness(1.15);}',
      '.sbl-hint{text-align:center;}',
      /* Rangliste / Rivalen */
      '.sbl-board-wrap{padding:14px;display:flex;flex-direction:column;gap:8px;}',
      '.sbl-board{display:flex;flex-direction:column;gap:6px;max-height:280px;overflow-y:auto;}',
      '.sbl-rrow{display:grid;grid-template-columns:26px 26px 1fr auto;align-items:center;gap:9px;padding:8px 12px;',
      'border-radius:11px;background:rgba(9,32,21,.6);border:1px solid var(--stroke);}',
      '.sbl-rrow.me{background:linear-gradient(90deg,rgba(255,210,63,.14),rgba(9,32,21,.6));border-color:rgba(255,210,63,.4);}',
      '.sbl-rrank{color:var(--muted);font-weight:800;text-align:center;font-variant-numeric:tabular-nums;}',
      '.sbl-ricon{font-size:16px;text-align:center;}',
      '.sbl-rname{font-weight:700;color:var(--leaf);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      '.sbl-rscore{font-weight:900;color:var(--gold);font-variant-numeric:tabular-nums;}',
      /* Animationen */
      '@keyframes sbl-pulse{0%,100%{opacity:1}50%{opacity:.4}}',
      '@keyframes sbl-bob{0%,100%{transform:translateY(0)}50%{transform:translateY(6px)}}',
      '@keyframes sbl-rage{0%,100%{transform:translateX(-50%) scale(1)}50%{transform:translateX(-50%) scale(1.08)}}'
    ].join(''));
  }
})();
