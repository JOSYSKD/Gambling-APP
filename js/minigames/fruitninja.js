/* fruitninja.js — "Frucht-Slicer": Fruit-Ninja im Neon-Dschungel.
 * Früchte werden von unten in einer Wurf-Parabel ins Bild geworfen. Mit
 * Maus-Ziehen (Desktop) oder Finger-Wisch (Touch) zieht man eine leuchtende
 * Klinge — jede vom Wischpfad berührte Frucht wird zerschnitten (+10, Saft +
 * Hälften), mehrere in einem Wisch geben Combo-Bonus. 💣 Bomben kosten Punkte
 * (kein Sofort-Ende — es ist ein 60-Sekunden-Zeitrennen).
 *
 * Parallel-Wettbewerb: Single (Bestwert) + Multi (synchroner Start, Live-
 * Rangliste, Podest). Frucht-Physik läuft per rAF mit geclamptem Zeit-Delta
 * (Tab-Wechsel-sicher); Countdown & Timer über App.MG (Wall-Clock / room.now).
 * Treffer = Distanz Frucht-Mittelpunkt zur Wisch-Strecke (Segment) <= Radius. */
(function () {
  'use strict';
  window.App = window.App || {}; App.Minigames = App.Minigames || {};
  var UI = App.UI, el = UI.el, MG = App.MG;

  var DURATION = 60;            // s Rundenzeit (Parallel-Wettbewerb)
  var POINTS = 10;             // Basispunkte pro Frucht
  var BOMB_PEN = 15;          // Strafe pro getroffener Bombe
  var COMBO_WINDOW = 520;    // ms — Treffer innerhalb zählen als Combo
  var DT_CLAMP = 0.05;      // s — max. Physik-Schritt (gegen Tab-Sprünge)
  var GRAV_FRAC = 1.15;   // Schwerkraft = GRAV_FRAC * Feldhöhe (px/s^2)
  var TRAIL_MS = 130;    // ms Lebensdauer der Klingen-Spur
  var BLADE_W = 13;     // Basis-Breite der Klinge (px)

  var FRUITS = [
    { e: '🍉', c: '#ff5277' },   // Melone
    { e: '🍊', c: '#ff9f1c' },   // Orange
    { e: '🍋', c: '#ffe14d' },   // Zitrone
    { e: '🥝', c: '#8ee06a' },   // Kiwi
    { e: '🍍', c: '#ffd23f' },   // Ananas
    { e: '🥥', c: '#e9dcc9' }    // Kokosnuss
  ];
  var BOMB = { e: '💣', c: '#5a5a66' };

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function segDist(px, py, ax, ay, bx, by) {
    var dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
    var t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
    t = t < 0 ? 0 : (t > 1 ? 1 : t);
    var qx = ax + t * dx, qy = ay + t * dy, ex = px - qx, ey = py - qy;
    return Math.sqrt(ex * ex + ey * ey);
  }

  App.Minigames.fruitninja = {
    id: 'fruitninja', title: 'Frucht-Slicer', icon: '🍉', order: 11,
    subtitle: 'Zerschneide fliegende Früchte, meide die Bomben',
    single: true, multi: true, minPlayers: 2, maxPlayers: 8,

    render: function (root, ctx) {
      injectStyle();
      var isMulti = ctx.mode === 'multi';

      /* ---- Aufräum-Register (ALLES muss in cleanup wieder weg) ---- */
      var stops = [], tos = [], raf = null;
      function addStop(fn) { if (fn) stops.push(fn); }
      function after(ms, fn) { var t = setTimeout(fn, ms); tos.push(t); return t; }
      function clearAll() {
        stops.forEach(function (f) { try { f(); } catch (e) {} }); stops = [];
        tos.forEach(clearTimeout); tos = [];
        if (raf) { cancelAnimationFrame(raf); raf = null; }
        active = {}; trail = [];
      }
      function cleanup() { dead = true; clearAll(); }

      /* ---- Runden-Zustand ---- */
      var items = [], active = {}, trail = [];
      var score = 0, combo = 0, lastSlice = 0, comboHideTo = null;
      var finished = false, dead = false;
      var W = 0, H = 0, gravity = 0, bladeHit = 8, stageRect = null;
      var physicsStart = 0, lastTime = 0, nextSpawnAt = 0;
      var stage = null, canvas = null, ctx2 = null, flashEl = null;
      var hudScore = null, hudCombo = null, hudTimer = null;

      /* ---- Start ---- */
      if (isMulti) {
        var snap = ctx.room.snapshot() || {};
        var startAt = (snap.round && snap.round.startAt) || (ctx.room.now() + 3000);
        addStop(MG.countdown(root, startAt, function () { play(startAt); }, ctx.room.now));
      } else {
        play(Date.now());                 // Single: sofort los
      }
      return { cleanup: cleanup };

      /* ===================== RUNDE ===================== */
      function play(startAt) {
        clearAll();
        score = 0; combo = 0; lastSlice = 0; comboHideTo = null;
        items = []; active = {}; trail = []; finished = false;
        var endAt = startAt + DURATION * 1000;

        /* --- HUD --- */
        hudScore = el('div', { class: 'fn-score big-readout' }, ['0']);
        hudCombo = el('div', { class: 'fn-combo' }, ['']);
        hudTimer = el('div', { class: 'mg-timer fn-timer' }, [MG.mmss(DURATION)]);
        var hud = el('div', { class: 'fn-hud glass' }, [
          el('div', { class: 'fn-hud-cell' }, [el('span', { class: 'fn-hud-l' }, ['Punkte']), hudScore]),
          hudCombo,
          el('div', { class: 'fn-hud-cell fn-hud-right' }, [el('span', { class: 'fn-hud-l' }, ['Zeit']), hudTimer])
        ]);

        /* --- Spielfeld (Canvas für die Klinge, Früchte als DOM) --- */
        stage = el('div', { class: 'game-stage fn-stage' });
        canvas = el('canvas', { class: 'fn-canvas' });
        ctx2 = canvas.getContext('2d');
        flashEl = el('div', { class: 'fn-flash' });
        var hint = el('div', { class: 'fn-hint' }, ['✋ Wische über die Früchte — 💣 meiden!']);
        stage.appendChild(canvas);
        stage.appendChild(flashEl);
        stage.appendChild(hint);
        after(2600, function () { if (hint.parentNode) hint.parentNode.removeChild(hint); });

        var pieces = [hud, stage];

        /* --- Live-Rangliste (multi) --- */
        if (isMulti) {
          var board = MG.liveBoard(ctx.room, ctx.me.id);
          addStop(board.stop);
          pieces.push(el('div', { class: 'glass fn-board-wrap' }, [
            el('div', { class: 'mg-field-title' }, ['🏆 Rangliste']),
            board.root
          ]));
          ctx.room.reportScore(0);
        }

        var layout = el('div', { class: 'fn-layout' }, pieces);
        root.innerHTML = ''; root.appendChild(layout);

        /* --- Feldgröße + Listener --- */
        resize();
        var onResize = function () { resize(); };
        window.addEventListener('resize', onResize);
        addStop(function () { window.removeEventListener('resize', onResize); });

        stage.addEventListener('pointerdown', onDown);
        stage.addEventListener('pointermove', onMove);
        stage.addEventListener('pointerup', onUp);
        stage.addEventListener('pointercancel', onUp);
        addStop(function () {
          stage.removeEventListener('pointerdown', onDown);
          stage.removeEventListener('pointermove', onMove);
          stage.removeEventListener('pointerup', onUp);
          stage.removeEventListener('pointercancel', onUp);
        });

        /* --- Timer (Wall-Clock, im Multi synchron) --- */
        addStop(MG.roundTimer(endAt, function (left) {
          hudTimer.textContent = MG.mmss(Math.ceil(left));
          hudTimer.classList.toggle('fn-urgent', left <= 5.5);
        }, finish, isMulti ? ctx.room.now : null));

        /* --- Physik-Loop --- */
        physicsStart = Date.now(); lastTime = physicsStart; nextSpawnAt = physicsStart + 300;
        raf = requestAnimationFrame(loop);
      }

      function resize() {
        if (!stage || !canvas) return;
        var r = stage.getBoundingClientRect();
        W = r.width; H = r.height; stageRect = r;
        gravity = H * GRAV_FRAC;
        bladeHit = Math.max(7, Math.min(W, H) * 0.02);
        var dpr = window.devicePixelRatio || 1;
        canvas.width = Math.round(W * dpr);
        canvas.height = Math.round(H * dpr);
        canvas.style.width = W + 'px';
        canvas.style.height = H + 'px';
        ctx2.setTransform(dpr, 0, 0, dpr, 0, 0);
      }

      /* ===================== PHYSIK ===================== */
      function loop() {
        raf = null;
        if (dead || finished) return;
        var now = Date.now();
        var dt = (now - lastTime) / 1000; lastTime = now;
        if (dt > DT_CLAMP) dt = DT_CLAMP; if (dt < 0) dt = 0;
        var elapsed = (now - physicsStart) / 1000;

        if (elapsed < DURATION - 0.8) maybeSpawn(now, elapsed);

        for (var i = items.length - 1; i >= 0; i--) {
          var it = items[i];
          it.vy += gravity * dt;
          it.x += it.vx * dt; it.y += it.vy * dt; it.a += it.av * dt;
          place(it);
          if (it.y > H + it.size || it.x < -it.size * 2 || it.x > W + it.size * 2) {
            if (it.node.parentNode) it.node.parentNode.removeChild(it.node);
            items.splice(i, 1);            // verpasst — keine Strafe (Zeitrennen)
          }
        }

        drawTrail(now);
        raf = requestAnimationFrame(loop);
      }

      function place(it) {
        it.node.style.transform = 'translate(' + it.x.toFixed(1) + 'px,' + it.y.toFixed(1) +
          'px) translate(-50%,-50%) rotate(' + it.a.toFixed(3) + 'rad)';
      }

      function maybeSpawn(now, elapsed) {
        if (now < nextSpawnAt) return;
        var frac = Math.min(1, elapsed / DURATION);
        var gap = 900 - 420 * frac;                 // wird zum Ende hin dichter
        nextSpawnAt = now + gap * (0.7 + Math.random() * 0.6);
        if (items.length > 11) return;
        var n = 1;
        if (Math.random() < 0.40 + 0.25 * frac) n++;
        if (Math.random() < 0.12 + 0.22 * frac) n++;
        var hadFruit = false;
        for (var i = 0; i < n; i++) {
          var bomb = Math.random() < (0.10 + 0.09 * frac);
          if (bomb && !hadFruit && i === n - 1) bomb = false;   // min. 1 Frucht pro Welle
          if (!bomb) hadFruit = true;
          spawnItem(bomb);
        }
      }

      function spawnItem(bomb) {
        if (W < 60 || H < 60 || gravity <= 0) return;
        var minDim = Math.min(W, H);
        var base = clamp(minDim * 0.15, 44, 104);
        var size = Math.round(base * (0.85 + Math.random() * 0.35));
        var lxFrac = 0.12 + Math.random() * 0.76;
        var f = 0.55 + Math.random() * 0.40;         // Scheitel-Höhe (Anteil der Feldhöhe)
        var v0 = Math.sqrt(2 * gravity * f * H);     // Startgeschwindigkeit nach oben
        var T = 2 * v0 / gravity;                    // ungefähre Flugzeit
        var targetX = clamp((1 - lxFrac) + (Math.random() - 0.5) * 0.5, 0.12, 0.88);
        var vx = (targetX - lxFrac) * W / T;
        var src = bomb ? BOMB : FRUITS[(Math.random() * FRUITS.length) | 0];
        var it = {
          bomb: bomb, emoji: src.e, color: src.c,
          x: lxFrac * W, y: H + size * 0.55,
          vx: vx, vy: -v0, a: Math.random() * 6.283,
          av: (Math.random() - 0.5) * (bomb ? 2.2 : 5),
          size: size, font: Math.round(size * 0.82),
          r: size * (bomb ? 0.42 : 0.46), sliced: false, node: null
        };
        var node = el('div', { class: 'fn-item' + (bomb ? ' fn-bomb' : '') }, [it.emoji]);
        node.style.width = node.style.height = size + 'px';
        node.style.fontSize = it.font + 'px';
        it.node = node;
        place(it);
        stage.appendChild(node);
        items.push(it);
      }

      /* ===================== KLINGE / TREFFER ===================== */
      function refreshRect() { if (stage) stageRect = stage.getBoundingClientRect(); }

      function onDown(e) {
        if (finished || dead) return;
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        e.preventDefault();
        refreshRect();
        var x = e.clientX - stageRect.left, y = e.clientY - stageRect.top;
        active[e.pointerId] = { x: x, y: y };
        try { stage.setPointerCapture(e.pointerId); } catch (_) {}
        addTrail(x, y, e.pointerId, Date.now());
      }
      function onMove(e) {
        var p = active[e.pointerId];
        if (!p || finished || dead) return;
        e.preventDefault();
        var x = e.clientX - stageRect.left, y = e.clientY - stageRect.top;
        var dx = x - p.x, dy = y - p.y;
        if (dx * dx + dy * dy > 16) sliceAlong(p.x, p.y, x, y);   // echtes Wischen nötig
        addTrail(x, y, e.pointerId, Date.now());
        p.x = x; p.y = y;
      }
      function onUp(e) {
        if (active[e.pointerId]) delete active[e.pointerId];
        try { stage.releasePointerCapture(e.pointerId); } catch (_) {}
      }

      function addTrail(x, y, pid, t) {
        trail.push({ x: x, y: y, pid: pid, t: t });
        if (trail.length > 60) trail.shift();
      }

      function sliceAlong(ax, ay, bx, by) {
        var now = Date.now();
        for (var i = items.length - 1; i >= 0; i--) {
          var it = items[i];
          if (it.sliced) continue;
          if (segDist(it.x, it.y, ax, ay, bx, by) <= it.r + bladeHit) {
            it.sliced = true;
            if (it.node.parentNode) it.node.parentNode.removeChild(it.node);
            items.splice(i, 1);
            if (it.bomb) onBomb(it, now); else onSlice(it, now);
          }
        }
      }

      function onSlice(it, now) {
        combo = (now - lastSlice <= COMBO_WINDOW) ? combo + 1 : 1;
        lastSlice = now;
        var gained = POINTS + (combo >= 2 ? (combo - 1) * 5 : 0);
        score += gained;
        hudScore.textContent = MG.fmt(score);
        if (App.Audio) App.Audio.sweep(820 + Math.min(combo, 6) * 55, 300, 0.1, { type: 'sawtooth', peak: 0.06 });
        floatText(it.x, it.y, '+' + gained, combo >= 2 ? 'hot' : '');
        sliceFx(it);
        updateCombo();
        if (combo === 3 || combo === 5 || combo === 7 || combo === 9) UI.toast('Combo x' + combo + '! 🔥', 'win');
        if (isMulti) ctx.room.reportScore(score);
      }

      function onBomb(it, now) {
        score = Math.max(0, score - BOMB_PEN);
        combo = 0; lastSlice = 0;
        hudScore.textContent = MG.fmt(score);
        if (App.Audio) App.Audio.sfx('explosion');
        floatText(it.x, it.y, '−' + BOMB_PEN, 'neg');
        bombFx(it);
        updateCombo();
        UI.toast('💣 Bombe! −' + BOMB_PEN, 'lose');
        if (isMulti) ctx.room.reportScore(score);
      }

      function updateCombo() {
        if (!hudCombo) return;
        if (combo >= 2) {
          hudCombo.textContent = '🔥 x' + combo;
          hudCombo.classList.add('on');
          hudCombo.classList.remove('bump'); void hudCombo.offsetWidth; hudCombo.classList.add('bump');
          if (comboHideTo) clearTimeout(comboHideTo);
          comboHideTo = setTimeout(function () {
            combo = 0; hudCombo.classList.remove('on', 'bump'); hudCombo.textContent = '';
          }, 900);
          tos.push(comboHideTo);
        } else {
          hudCombo.classList.remove('on', 'bump'); hudCombo.textContent = '';
          if (comboHideTo) { clearTimeout(comboHideTo); comboHideTo = null; }
        }
      }

      /* ===================== EFFEKTE ===================== */
      function drawTrail(now) {
        ctx2.clearRect(0, 0, W, H);
        while (trail.length && now - trail[0].t > TRAIL_MS) trail.shift();
        if (trail.length < 2) return;
        ctx2.lineCap = 'round'; ctx2.lineJoin = 'round';
        for (var pass = 0; pass < 2; pass++) {
          for (var i = 1; i < trail.length; i++) {
            var a = trail[i - 1], b = trail[i];
            if (a.pid !== b.pid) continue;
            var k = 1 - (now - b.t) / TRAIL_MS; if (k < 0) k = 0;
            ctx2.beginPath(); ctx2.moveTo(a.x, a.y); ctx2.lineTo(b.x, b.y);
            if (pass === 0) {                                  // äußerer Neon-Glow
              ctx2.lineWidth = 4 + k * BLADE_W;
              ctx2.strokeStyle = 'rgba(57,255,20,' + (0.10 + 0.28 * k) + ')';
              ctx2.shadowColor = 'rgba(57,255,20,0.9)'; ctx2.shadowBlur = 16 * k;
            } else {                                           // heller Kern
              ctx2.lineWidth = 1.5 + k * (BLADE_W * 0.4);
              ctx2.strokeStyle = 'rgba(233,255,224,' + (0.5 + 0.5 * k) + ')';
              ctx2.shadowColor = 'rgba(255,255,255,0.85)'; ctx2.shadowBlur = 6 * k;
            }
            ctx2.stroke();
          }
        }
        ctx2.shadowBlur = 0;
      }

      function floatText(x, y, txt, cls) {
        if (!stage) return;
        var f = el('div', { class: 'fn-float' + (cls ? ' fn-' + cls : '') }, [txt]);
        f.style.left = x + 'px'; f.style.top = y + 'px';
        stage.appendChild(f);
        after(760, function () { if (f.parentNode) f.parentNode.removeChild(f); });
      }

      function spawnDrop(x, y, color, ang, dist, size, life) {
        var d = el('div', { class: 'fn-drop' });
        d.style.left = x + 'px'; d.style.top = y + 'px';
        d.style.background = color;
        d.style.width = size + 'px'; d.style.height = size + 'px';
        d.style.setProperty('--dx', (Math.cos(ang) * dist).toFixed(0) + 'px');
        d.style.setProperty('--dy', (Math.sin(ang) * dist).toFixed(0) + 'px');
        stage.appendChild(d);
        requestAnimationFrame(function () { d.classList.add('go'); });
        after(life, function () { if (d.parentNode) d.parentNode.removeChild(d); });
      }

      function makeHalf(it, dir) {
        var h = el('div', { class: 'fn-half' }, [it.emoji]);
        h.style.left = it.x + 'px'; h.style.top = it.y + 'px';
        h.style.fontSize = it.font + 'px';
        var clip = dir < 0 ? 'inset(0 50% 0 0)' : 'inset(0 0 0 50%)';
        h.style.clipPath = clip; h.style.webkitClipPath = clip;
        h.style.setProperty('--dx', (dir * (18 + Math.random() * 26)).toFixed(0) + 'px');
        h.style.setProperty('--rot', (dir * (25 + Math.random() * 45)).toFixed(0) + 'deg');
        stage.appendChild(h);
        requestAnimationFrame(function () { h.classList.add('go'); });
        after(640, function () { if (h.parentNode) h.parentNode.removeChild(h); });
      }

      function sliceFx(it) {
        var sp = el('div', { class: 'fn-splat' });
        sp.style.left = it.x + 'px'; sp.style.top = it.y + 'px';
        sp.style.width = sp.style.height = (it.size * 1.35) + 'px';
        sp.style.setProperty('--c', it.color);
        stage.appendChild(sp);
        after(520, function () { if (sp.parentNode) sp.parentNode.removeChild(sp); });
        for (var k = 0; k < 7; k++) {
          spawnDrop(it.x, it.y, it.color, Math.random() * 6.283,
            it.size * (0.5 + Math.random() * 0.7), 4 + Math.random() * 6, 520);
        }
        makeHalf(it, -1); makeHalf(it, 1);
      }

      function bombFx(it) {
        if (flashEl) { flashEl.classList.remove('go'); void flashEl.offsetWidth; flashEl.classList.add('go'); }
        if (stage) {
          stage.classList.remove('fn-shake'); void stage.offsetWidth; stage.classList.add('fn-shake');
          after(420, function () { if (stage) stage.classList.remove('fn-shake'); });
        }
        var b = el('div', { class: 'fn-boom' });
        b.style.left = it.x + 'px'; b.style.top = it.y + 'px';
        b.style.width = b.style.height = (it.size * 2) + 'px';
        stage.appendChild(b);
        after(500, function () { if (b.parentNode) b.parentNode.removeChild(b); });
        for (var k = 0; k < 9; k++) {
          spawnDrop(it.x, it.y, (k % 2 ? '#ffb020' : '#3a3a44'), Math.random() * 6.283,
            it.size * (0.7 + Math.random() * 0.8), 5 + Math.random() * 7, 560);
        }
      }

      /* ===================== ENDE ===================== */
      function finish() {
        if (finished || dead) return;
        finished = true;
        clearAll();
        if (isMulti) {
          ctx.room.reportScore(score);
          after(1200, function () {
            if (dead) return;
            MG.endScreen(root, { players: ctx.room.players(), meId: ctx.me.id, onExit: ctx.onExit });
          });
        } else {
          var best = App.Storage.get('best_fruitninja', 0), nb = score > best;
          if (nb) App.Storage.set('best_fruitninja', score);
          MG.endScreen(root, {
            title: 'Zeit um! 🍉', score: score, best: best, newBest: nb,
            label: nb ? 'Neuer Rekord! 🎉' : 'Punkte · Bestwert: ' + MG.fmt(best),
            onExit: ctx.onExit, onAgain: function () { play(Date.now()); }
          });
        }
      }
    }
  };

  /* ============================ STYLES ============================ */
  function injectStyle() {
    UI.injectStyle('mg-fruitninja-css', [
      '.fn-layout{display:flex;flex-direction:column;gap:14px;}',
      /* HUD */
      '.fn-hud{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px 18px;}',
      '.fn-hud-cell{display:flex;flex-direction:column;gap:2px;}',
      '.fn-hud-right{align-items:flex-end;}',
      '.fn-hud-l{font-size:11px;text-transform:uppercase;letter-spacing:1px;color:var(--muted);}',
      '.fn-score{font-size:clamp(26px,7vw,42px);line-height:1;color:var(--neon);text-shadow:0 0 14px rgba(57,255,20,.5);font-variant-numeric:tabular-nums;}',
      '.fn-timer{font-size:clamp(20px,5vw,28px);font-variant-numeric:tabular-nums;}',
      '.fn-timer.fn-urgent{color:var(--danger,#ff4d6d);animation:fn-pulse .6s ease-in-out infinite;}',
      '@keyframes fn-pulse{0%,100%{opacity:1}50%{opacity:.5}}',
      '.fn-combo{min-width:70px;text-align:center;font-weight:900;font-size:clamp(16px,4.5vw,22px);color:var(--gold);opacity:0;transition:opacity .2s;text-shadow:0 0 12px rgba(255,210,63,.6);}',
      '.fn-combo.on{opacity:1;}',
      '.fn-combo.bump{animation:fn-bump .3s ease;}',
      '@keyframes fn-bump{0%{transform:scale(.7)}55%{transform:scale(1.25)}100%{transform:scale(1)}}',
      /* Spielfeld — überschreibt das flex-Zentrieren von .game-stage */
      '.fn-stage{position:relative;display:block;overflow:hidden;padding:0;cursor:crosshair;',
      'height:min(60vh,560px);min-height:300px;width:100%;',
      'touch-action:none;user-select:none;-webkit-user-select:none;-webkit-touch-callout:none;-webkit-tap-highlight-color:transparent;',
      'background:radial-gradient(120% 100% at 50% 0%,#0c3020,#04140c);}',
      '.fn-stage.fn-shake{animation:fn-shake .42s cubic-bezier(.36,.07,.19,.97);}',
      '@keyframes fn-shake{0%,100%{transform:translateX(0)}20%{transform:translateX(-9px)}40%{transform:translateX(8px)}60%{transform:translateX(-6px)}80%{transform:translateX(4px)}}',
      '.fn-canvas{position:absolute;left:0;top:0;pointer-events:none;z-index:5;}',
      /* Früchte / Bomben */
      '.fn-item{position:absolute;left:0;top:0;display:flex;align-items:center;justify-content:center;line-height:1;',
      'pointer-events:none;user-select:none;-webkit-user-select:none;z-index:2;will-change:transform;',
      'filter:drop-shadow(0 4px 8px rgba(0,0,0,.45));}',
      '.fn-bomb{filter:drop-shadow(0 0 12px rgba(255,77,109,.75)) drop-shadow(0 3px 6px rgba(0,0,0,.5));}',
      /* Saft-Splat */
      '.fn-splat{position:absolute;transform:translate(-50%,-50%);border-radius:50%;pointer-events:none;z-index:3;',
      'background:radial-gradient(circle,var(--c) 0%,transparent 68%);mix-blend-mode:screen;animation:fn-splat .5s ease-out forwards;}',
      '@keyframes fn-splat{0%{transform:translate(-50%,-50%) scale(.3);opacity:.9}100%{transform:translate(-50%,-50%) scale(1.4);opacity:0}}',
      /* Saft-Tropfen */
      '.fn-drop{position:absolute;transform:translate(-50%,-50%);border-radius:50%;pointer-events:none;z-index:3;opacity:1;',
      'box-shadow:0 0 6px rgba(0,0,0,.3);transition:transform .5s cubic-bezier(.2,.7,.3,1),opacity .5s ease-out;}',
      '.fn-drop.go{transform:translate(-50%,-50%) translate(var(--dx,0px),var(--dy,0px)) scale(.4);opacity:0;}',
      /* Frucht-Hälften */
      '.fn-half{position:absolute;transform:translate(-50%,-50%);pointer-events:none;z-index:3;line-height:1;',
      'filter:drop-shadow(0 3px 6px rgba(0,0,0,.5));transition:transform .6s ease-in,opacity .6s ease-in;}',
      '.fn-half.go{transform:translate(-50%,-50%) translate(var(--dx,0px),48px) rotate(var(--rot,0deg));opacity:0;}',
      /* Bomben-Boom */
      '.fn-boom{position:absolute;transform:translate(-50%,-50%);border-radius:50%;pointer-events:none;z-index:4;',
      'border:3px solid var(--gold,#ffd23f);background:radial-gradient(circle,rgba(255,160,32,.85),rgba(255,77,109,.2) 60%,transparent 72%);',
      'animation:fn-boom .5s ease-out forwards;}',
      '@keyframes fn-boom{0%{transform:translate(-50%,-50%) scale(.2);opacity:1}100%{transform:translate(-50%,-50%) scale(1.7);opacity:0}}',
      /* roter Fehler-Blitz */
      '.fn-flash{position:absolute;inset:0;pointer-events:none;z-index:6;opacity:0;',
      'background:radial-gradient(120% 120% at 50% 50%,rgba(255,77,109,.55),rgba(255,77,109,0) 70%);}',
      '.fn-flash.go{animation:fn-flash .42s ease-out;}',
      '@keyframes fn-flash{0%{opacity:.6}100%{opacity:0}}',
      /* +Punkte-Float */
      '.fn-float{position:absolute;transform:translate(-50%,-50%);pointer-events:none;z-index:7;font-weight:900;',
      'font-size:24px;color:var(--leaf,#9dff7a);text-shadow:0 2px 6px rgba(0,0,0,.7);animation:fn-float .76s ease-out forwards;}',
      '.fn-float.fn-hot{color:var(--aqua-soft,#7ff0e2);font-size:28px;}',
      '.fn-float.fn-neg{color:var(--danger,#ff4d6d);font-size:28px;text-shadow:0 0 10px rgba(255,77,109,.7),0 2px 6px rgba(0,0,0,.7);}',
      '@keyframes fn-float{0%{opacity:0;transform:translate(-50%,-50%) scale(.6)}20%{opacity:1;transform:translate(-50%,-90%) scale(1.1)}100%{opacity:0;transform:translate(-50%,-180%) scale(1)}}',
      /* Start-Hinweis */
      '.fn-hint{position:absolute;left:50%;top:14px;transform:translateX(-50%);pointer-events:none;z-index:7;',
      'padding:8px 16px;border-radius:999px;background:rgba(4,20,12,.72);border:1px solid var(--stroke,rgba(57,255,20,.25));',
      'color:var(--leaf,#9dff7a);font-weight:800;font-size:clamp(12px,3.4vw,15px);white-space:nowrap;animation:fn-hint 2.6s ease forwards;}',
      '@keyframes fn-hint{0%{opacity:0}12%{opacity:1}72%{opacity:1}100%{opacity:0}}',
      /* Board */
      '.fn-board-wrap{padding:14px;display:flex;flex-direction:column;gap:8px;max-height:260px;overflow-y:auto;}'
    ].join(''));
  }
})();
