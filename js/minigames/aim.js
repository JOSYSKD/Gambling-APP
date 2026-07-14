/* aim.js — "Ziel-Jäger": Neon-Reaktions-Klickspiel.
 * In einer dunklen Dschungel-Arena tauchen leuchtende Frucht-Ziele auf und
 * verschwinden nach kurzer Zeit wieder. Triff in 30 Sekunden so viele wie
 * möglich — kleine/schnelle Ziele geben mehr Punkte, schnelle Treffer-Serien
 * bauen einen Combo-Multiplikator auf. Singleplayer (mit Bestwert) +
 * Multiplayer (synchroner Start, Live-Rangliste, Podest).
 * Alle Zeit läuft über Wall-Clock (Date.now / room.now) -> Tab-sicher. */
(function () {
  'use strict';
  window.App = window.App || {}; App.Minigames = App.Minigames || {};
  var UI = App.UI, el = UI.el, MG = App.MG;

  var DURATION = 30;                 // Sekunden Rundenzeit
  var MAX_ACTIVE = 3;                // gleichzeitig max. sichtbare Ziele
  var FRUITS = ['🍎', '🍏', '🍊', '🍋', '🍉', '🍓', '🥝', '🍑', '🫐', '🍒', '🥥', '🍍'];

  /* Ziel-Stufen: kleiner + kürzere Lebenszeit = mehr Punkte.
     frac = Größe relativ zur kürzeren Spielfeld-Seite. */
  var TIERS = [
    { key: 'normal', w: 48, frac: 0.26, life: 1550, pts: 1, cls: 'aim-t-normal' },
    { key: 'medium', w: 30, frac: 0.20, life: 1150, pts: 2, cls: 'aim-t-medium' },
    { key: 'small',  w: 16, frac: 0.15, life: 850,  pts: 3, cls: 'aim-t-small'  },
    { key: 'gold',   w: 6,  frac: 0.18, life: 1000, pts: 5, cls: 'aim-t-gold', gold: true }
  ];

  function pickTier() {
    var tot = 0, i; for (i = 0; i < TIERS.length; i++) tot += TIERS[i].w;
    var r = Math.random() * tot;
    for (i = 0; i < TIERS.length; i++) { r -= TIERS[i].w; if (r < 0) return TIERS[i]; }
    return TIERS[0];
  }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  App.Minigames.aim = {
    id: 'aim', title: 'Ziel-Jäger', icon: '🎯', order: 7,
    subtitle: 'Triff so viele Ziele wie möglich in 30 Sekunden',
    single: true, multi: true, minPlayers: 2, maxPlayers: 8,

    render: function (root, ctx) {
      injectStyle();
      var isMulti = ctx.mode === 'multi';
      var clock = isMulti ? ctx.room.now : Date.now;

      /* ---- Aufräum-Register (alles muss in cleanup weg) ---- */
      var tos = [], stops = [], targets = [], dead = false;
      function after(ms, fn) { var t = setTimeout(fn, ms); tos.push(t); return t; }
      function clearRound() {
        tos.forEach(clearTimeout); tos = [];
        stops.forEach(function (f) { try { f(); } catch (e) {} }); stops = [];
        targets.forEach(function (t) { if (t.el && t.el.parentNode) t.el.parentNode.removeChild(t.el); });
        targets = [];
      }
      function cleanup() { dead = true; clearRound(); }

      /* ---- Runden-Zustand ---- */
      var score = 0, streak = 0, mult = 1, finished = false;
      var stageEl = null, hudScore = null, hudCombo = null, hudTimer = null;

      /* ---- Start ---- */
      if (isMulti) {
        var snap = ctx.room.snapshot() || {};
        var startAt = (snap.round && snap.round.startAt) || (ctx.room.now() + 3000);
        stops.push(MG.countdown(root, startAt, function () { play(startAt); }, ctx.room.now));
      } else {
        intro();
      }
      return { cleanup: cleanup };

      /* ===================== SINGLEPLAYER-INTRO ===================== */
      function intro() {
        clearRound(); finished = false;
        var best = App.Storage.get('best_aim', 0);
        var card = el('div', { class: 'aim-intro glass' }, [
          el('div', { class: 'aim-intro-icon' }, ['🎯']),
          el('h2', { class: 'neon' }, ['Ziel-Jäger']),
          el('p', { class: 'hint-text' }, ['Triff die leuchtenden Ziele, bevor sie verschwinden. Kleine & schnelle Ziele geben mehr Punkte — Treffer-Serien bauen einen 🔥 Combo-Bonus auf.']),
          el('div', { class: 'aim-intro-best hint-text' }, ['🏆 Bestwert: ' + MG.fmt(best)]),
          el('button', { class: 'btn btn-primary btn-lg', type: 'button', onclick: function () {
            var s = Date.now() + 3200;
            clearRound();
            stops.push(MG.countdown(root, s, function () { play(s); }));
          } }, ['▶ Los geht\'s'])
        ]);
        root.innerHTML = ''; root.appendChild(card);
      }

      /* ===================== SPIEL ===================== */
      function play(startAt) {
        clearRound();
        score = 0; streak = 0; mult = 1; finished = false;
        var endAt = startAt + DURATION * 1000;

        /* --- HUD --- */
        hudScore = el('div', { class: 'aim-score big-readout' }, ['0']);
        hudCombo = el('div', { class: 'aim-combo' }, ['']);
        hudTimer = el('div', { class: 'mg-timer aim-timer' }, ['0:' + DURATION]);
        var hud = el('div', { class: 'aim-hud glass' }, [
          el('div', { class: 'aim-hud-cell' }, [el('span', { class: 'aim-hud-l' }, ['Punkte']), hudScore]),
          hudCombo,
          el('div', { class: 'aim-hud-cell aim-hud-right' }, [el('span', { class: 'aim-hud-l' }, ['Zeit']), hudTimer])
        ]);

        /* --- Spielfeld --- */
        stageEl = el('div', { class: 'game-stage aim-stage' });
        stageEl.appendChild(el('div', { class: 'aim-cross-h' }));
        stageEl.appendChild(el('div', { class: 'aim-cross-v' }));

        var pieces = [hud, stageEl];

        /* --- Live-Rangliste (multi) --- */
        var board = null;
        if (isMulti) {
          board = MG.liveBoard(ctx.room, ctx.me.id);
          stops.push(board.stop);
          pieces.push(el('div', { class: 'glass aim-board-wrap' }, [
            el('div', { class: 'mg-field-title' }, ['🏆 Rangliste']),
            board.root
          ]));
          ctx.room.reportScore(0);
        }

        var layout = el('div', { class: 'aim-layout' }, pieces);
        root.innerHTML = ''; root.appendChild(layout);

        /* --- Ziel-Spawner --- */
        spawnTarget();                       // sofort eins, damit das Feld nie leer startet
        scheduleSpawn(320, endAt);

        /* --- Timer --- */
        stops.push(MG.roundTimer(endAt, function (left) {
          hudTimer.textContent = MG.mmss(Math.ceil(left));
          hudTimer.classList.toggle('aim-urgent', left <= 5.5);
        }, finish, isMulti ? ctx.room.now : null));
      }

      function scheduleSpawn(delay, endAt) {
        after(delay, function () {
          if (dead || finished || clock() >= endAt) return;
          if (targets.length < MAX_ACTIVE) spawnTarget();
          var gap = targets.length === 0 ? 130 : (260 + Math.random() * 420);
          scheduleSpawn(gap, endAt);
        });
      }

      function spawnTarget() {
        if (dead || finished || !stageEl) return;
        var rect = stageEl.getBoundingClientRect();
        var w = rect.width, h = rect.height;
        if (w < 40 || h < 40) return;

        var tier = pickTier();
        var sizePx = Math.round(clamp(tier.frac * Math.min(w, h), 50, 118));
        var pos = placeTarget(w, h, sizePx);

        var emoji = tier.gold ? '🌟' : FRUITS[(Math.random() * FRUITS.length) | 0];
        var elm = el('div', { class: 'aim-target ' + tier.cls }, [
          el('div', { class: 'aim-ring' }),
          el('span', { class: 'aim-fruit' }, [emoji])
        ]);
        elm.style.width = sizePx + 'px';
        elm.style.height = sizePx + 'px';
        elm.style.left = (pos.x / w * 100) + '%';
        elm.style.top = (pos.y / h * 100) + '%';
        elm.querySelector('.aim-fruit').style.fontSize = Math.round(sizePx * 0.5) + 'px';
        elm.querySelector('.aim-ring').style.animationDuration = tier.life + 'ms';

        var target = { el: elm, tier: tier, cx: pos.cx, cy: pos.cy, r: sizePx / 2, resolved: false, esc: null };

        elm.addEventListener('pointerdown', function (e) {
          if (e && e.preventDefault) e.preventDefault();
          hit(target);
        });

        target.esc = after(tier.life, function () { escape(target); });
        targets.push(target);
        stageEl.appendChild(elm);
      }

      /* Position im Feld finden, dabei starke Überlappung meiden. */
      function placeTarget(w, h, sizePx) {
        var pad = 4;
        var maxX = Math.max(pad, w - sizePx - pad), maxY = Math.max(pad, h - sizePx - pad);
        var best = null;
        for (var i = 0; i < 10; i++) {
          var x = pad + Math.random() * (maxX - pad);
          var y = pad + Math.random() * (maxY - pad);
          var cx = x + sizePx / 2, cy = y + sizePx / 2, ok = true;
          for (var j = 0; j < targets.length; j++) {
            var t = targets[j];
            var dx = cx - t.cx, dy = cy - t.cy, minD = (sizePx / 2 + t.r) * 0.85;
            if (dx * dx + dy * dy < minD * minD) { ok = false; break; }
          }
          if (ok) return { x: x, y: y, cx: cx, cy: cy };
          if (!best) best = { x: x, y: y, cx: cx, cy: cy };
        }
        return best;
      }

      function removeTarget(target) {
        var i = targets.indexOf(target);
        if (i >= 0) targets.splice(i, 1);
      }

      function hit(target) {
        if (target.resolved || dead || finished) return;
        target.resolved = true;
        clearTimeout(target.esc);
        removeTarget(target);

        streak++;
        mult = 1 + Math.min(4, Math.floor(streak / 3));   // x1 .. x5
        var gained = target.tier.pts * mult;
        score += gained;

        hudScore.textContent = MG.fmt(score);
        updateCombo();
        if (isMulti) ctx.room.reportScore(score);

        if (App.Audio) App.Audio.sfx(target.tier.gold ? 'coin' : 'pop');
        popFloat(target.cx, target.cy, '+' + gained, target.tier.gold ? 'aim-float-gold' : (mult > 1 ? 'aim-float-hot' : ''));
        target.el.classList.add('aim-hit');
        after(280, function () { if (target.el.parentNode) target.el.parentNode.removeChild(target.el); });
      }

      function escape(target) {
        if (target.resolved || dead) return;
        target.resolved = true;
        removeTarget(target);
        streak = 0; mult = 1; updateCombo();
        target.el.classList.add('aim-gone');
        after(320, function () { if (target.el.parentNode) target.el.parentNode.removeChild(target.el); });
      }

      function updateCombo() {
        if (!hudCombo) return;
        if (mult > 1) {
          hudCombo.textContent = '🔥 x' + mult;
          hudCombo.classList.add('on');
          hudCombo.classList.remove('bump'); void hudCombo.offsetWidth; hudCombo.classList.add('bump');
        } else {
          hudCombo.textContent = '';
          hudCombo.classList.remove('on', 'bump');
        }
      }

      function popFloat(cx, cy, txt, cls) {
        if (!stageEl) return;
        var f = el('div', { class: 'aim-float ' + (cls || '') }, [txt]);
        f.style.left = cx + 'px';
        f.style.top = cy + 'px';
        stageEl.appendChild(f);
        after(760, function () { if (f.parentNode) f.parentNode.removeChild(f); });
      }

      /* ===================== ENDE ===================== */
      function finish() {
        if (finished || dead) return;
        finished = true;
        clearRound();
        if (isMulti) {
          ctx.room.reportScore(score);
          after(1200, function () {
            if (dead) return;
            MG.endScreen(root, { players: ctx.room.players(), meId: ctx.me.id, onExit: ctx.onExit });
          });
        } else {
          var best = App.Storage.get('best_aim', 0), nb = score > best;
          if (nb) App.Storage.set('best_aim', score);
          MG.endScreen(root, {
            title: 'Zeit um! 🎯', score: score, best: best, newBest: nb,
            label: nb ? 'Neuer Rekord! 🎉' : 'Punkte · Bestwert: ' + MG.fmt(best),
            onExit: ctx.onExit, onAgain: intro
          });
        }
      }
    }
  };

  /* ===================== STYLES ===================== */
  function injectStyle() {
    UI.injectStyle('mg-aim-css', [
      '.aim-layout{display:flex;flex-direction:column;gap:14px;}',
      /* Intro */
      '.aim-intro{padding:28px;text-align:center;display:flex;flex-direction:column;gap:12px;align-items:center;max-width:480px;margin:0 auto;}',
      '.aim-intro-icon{font-size:56px;filter:drop-shadow(0 0 14px rgba(57,255,20,.55));animation:aim-bob 2.2s ease-in-out infinite;}',
      '@keyframes aim-bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-8px)}}',
      '.aim-intro h2{margin:0;}',
      '.aim-intro-best{font-weight:800;color:var(--gold);}',
      /* HUD */
      '.aim-hud{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px 18px;}',
      '.aim-hud-cell{display:flex;flex-direction:column;gap:2px;}',
      '.aim-hud-right{align-items:flex-end;}',
      '.aim-hud-l{font-size:11px;text-transform:uppercase;letter-spacing:1px;color:var(--muted);}',
      '.aim-score{font-size:clamp(26px,7vw,42px);line-height:1;color:var(--neon);text-shadow:0 0 14px rgba(57,255,20,.5);font-variant-numeric:tabular-nums;}',
      '.aim-timer{font-size:clamp(20px,5vw,28px);font-variant-numeric:tabular-nums;}',
      '.aim-timer.aim-urgent{color:var(--danger-2);animation:aim-pulse .6s ease-in-out infinite;}',
      '@keyframes aim-pulse{0%,100%{opacity:1}50%{opacity:.5}}',
      '.aim-combo{min-width:70px;text-align:center;font-weight:900;font-size:clamp(16px,4.5vw,22px);color:var(--gold);opacity:0;transition:opacity .2s;text-shadow:0 0 12px rgba(255,210,63,.6);}',
      '.aim-combo.on{opacity:1;}',
      '.aim-combo.bump{animation:aim-bump .3s ease;}',
      '@keyframes aim-bump{0%{transform:scale(.7)}55%{transform:scale(1.25)}100%{transform:scale(1)}}',
      /* Spielfeld — überschreibt das flex-Zentrieren von .game-stage */
      '.aim-stage{display:block;overflow:hidden;padding:0;cursor:crosshair;',
      'height:min(60vh,560px);min-height:300px;width:100%;',
      'touch-action:manipulation;user-select:none;-webkit-user-select:none;-webkit-touch-callout:none;',
      'background:radial-gradient(120% 100% at 50% 0%,#0c3020,#04140c);}',
      /* dezentes Fadenkreuz-Feeling in der Mitte */
      '.aim-cross-h,.aim-cross-v{position:absolute;background:rgba(57,255,20,.06);pointer-events:none;}',
      '.aim-cross-h{left:0;right:0;top:50%;height:1px;}',
      '.aim-cross-v{top:0;bottom:0;left:50%;width:1px;}',
      /* Ziel */
      '.aim-target{position:absolute;border-radius:50%;display:flex;align-items:center;justify-content:center;',
      'cursor:pointer;touch-action:none;user-select:none;-webkit-user-select:none;will-change:transform,opacity;',
      'animation:aim-in .18s cubic-bezier(.2,1.4,.4,1) both;}',
      '.aim-fruit{position:relative;z-index:2;line-height:1;filter:drop-shadow(0 2px 4px rgba(0,0,0,.5));pointer-events:none;}',
      '.aim-ring{position:absolute;inset:0;border-radius:50%;pointer-events:none;',
      'animation:aim-ring linear both;}',
      '@keyframes aim-in{from{transform:scale(0);opacity:0}to{transform:scale(1);opacity:1}}',
      '@keyframes aim-ring{from{transform:scale(1.55);opacity:.9}to{transform:scale(1);opacity:0}}',
      '.aim-target.aim-hit{animation:aim-hit .28s ease forwards;pointer-events:none;}',
      '@keyframes aim-hit{0%{transform:scale(1)}45%{transform:scale(1.4)}100%{transform:scale(1.7);opacity:0}}',
      '.aim-target.aim-gone{animation:aim-gone .32s ease forwards;pointer-events:none;}',
      '@keyframes aim-gone{to{transform:scale(.55);opacity:0}}',
      /* Ziel-Stufen (Farbe/Glow) */
      '.aim-t-normal{background:radial-gradient(circle at 35% 30%,#8dff6a,#2fbf22);box-shadow:0 0 18px rgba(57,255,20,.6),inset 0 0 10px rgba(255,255,255,.35),inset 0 0 0 3px rgba(4,20,12,.35);}',
      '.aim-t-normal .aim-ring{box-shadow:0 0 0 3px rgba(57,255,20,.8);}',
      '.aim-t-medium{background:radial-gradient(circle at 35% 30%,#9ff6ea,#22b6a3);box-shadow:0 0 18px rgba(51,230,208,.65),inset 0 0 10px rgba(255,255,255,.35),inset 0 0 0 3px rgba(4,20,12,.35);}',
      '.aim-t-medium .aim-ring{box-shadow:0 0 0 3px rgba(51,230,208,.85);}',
      '.aim-t-small{background:radial-gradient(circle at 35% 30%,#ff9fb3,#ff4d6d);box-shadow:0 0 20px rgba(255,77,109,.7),inset 0 0 10px rgba(255,255,255,.35),inset 0 0 0 3px rgba(4,20,12,.35);}',
      '.aim-t-small .aim-ring{box-shadow:0 0 0 3px rgba(255,128,152,.9);}',
      '.aim-t-gold{background:radial-gradient(circle at 35% 30%,#fff0b0,#ffbf1f);box-shadow:0 0 26px rgba(255,210,63,.85),inset 0 0 12px rgba(255,255,255,.5),inset 0 0 0 3px rgba(80,50,0,.35);animation:aim-in .18s cubic-bezier(.2,1.4,.4,1) both,aim-gold-glow 1s ease-in-out infinite;}',
      '@keyframes aim-gold-glow{0%,100%{box-shadow:0 0 22px rgba(255,210,63,.7),inset 0 0 12px rgba(255,255,255,.5),inset 0 0 0 3px rgba(80,50,0,.35)}50%{box-shadow:0 0 40px rgba(255,210,63,1),inset 0 0 14px rgba(255,255,255,.7),inset 0 0 0 3px rgba(80,50,0,.35)}}',
      '.aim-t-gold .aim-ring{box-shadow:0 0 0 3px rgba(255,210,63,.95);}',
      /* +X Float */
      '.aim-float{position:absolute;transform:translate(-50%,-50%);pointer-events:none;z-index:5;font-weight:900;',
      'font-size:22px;color:var(--leaf);text-shadow:0 2px 6px rgba(0,0,0,.7);animation:aim-float .74s ease-out forwards;}',
      '.aim-float-hot{color:var(--aqua-soft);font-size:26px;}',
      '.aim-float-gold{color:var(--gold);font-size:30px;text-shadow:0 0 10px rgba(255,210,63,.8),0 2px 6px rgba(0,0,0,.7);}',
      '@keyframes aim-float{0%{opacity:0;transform:translate(-50%,-50%) scale(.6)}20%{opacity:1;transform:translate(-50%,-70%) scale(1.1)}100%{opacity:0;transform:translate(-50%,-150%) scale(1)}}',
      /* Board */
      '.aim-board-wrap{padding:14px;display:flex;flex-direction:column;gap:8px;max-height:260px;overflow-y:auto;}'
    ].join(''));
  }
})();
