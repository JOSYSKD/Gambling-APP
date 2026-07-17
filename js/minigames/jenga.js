/* jenga.js — "Jenga-Turm": Wer zieht die meisten Steine, bevor der Turm fällt?
 *
 * Push-your-luck-Geschicklichkeit (kein Coin-Einsatz): jeder Zug hat eine
 * steigende Einsturz-Chance. Punktzahl = Anzahl der erfolgreich gezogenen Steine
 * vor dem Einsturz. Kein Cashout — es geht rein um Mut/Glück.
 *   Einsturz-Chance je Zug: p = min(0.55, 0.04 + gezogen*0.017)
 *   -> erster Zug ~4 %, klettert stetig -> Punkte bleiben ~10–25 begrenzt.
 * Solo (mit Bestwert) + Multiplayer (synchroner Start, Live-Rangliste, Podest).
 * Struktur bewusst an stacktower.js/reflex.js angelehnt (Countdown, Live-Board,
 * Endscreen, saubere cleanup-Register). Timer/Countdown über Wall-Clock
 * (Date.now / room.now) -> Tab-Wechsel-sicher. */
(function () {
  'use strict';
  window.App = window.App || {}; App.Minigames = App.Minigames || {};
  var UI = App.UI, el = UI.el, MG = App.MG;

  var ROWS = 14, PER_ROW = 3;
  var DURATION = 45;        // s — Sicherheits-Cap im Multiplayer

  function collapseChance(pulled) {
    var p = 0.04 + pulled * 0.017;
    return p > 0.55 ? 0.55 : p;
  }

  App.Minigames.jenga = {
    id: 'jenga', title: 'Jenga-Turm', icon: '🧱', order: 13,
    subtitle: 'Wer zieht die meisten Steine, bevor der Turm fällt?',
    single: true, multi: true, minPlayers: 2, maxPlayers: 8,

    render: function (root, ctx) {
      injectStyle();
      var isMulti = ctx.mode === 'multi';
      var nowFn = isMulti ? ctx.room.now : function () { return Date.now(); };

      /* ---- Aufräum-Register ---- */
      var stops = [], listeners = [], tos = [], dead = false;
      function after(ms, fn) { var t = setTimeout(function () { if (!dead) fn(); }, ms); tos.push(t); return t; }
      function stopAll() {
        stops.forEach(function (f) { try { f(); } catch (e) {} }); stops = [];
        listeners.forEach(function (l) { try { l.t.removeEventListener(l.e, l.fn); } catch (e) {} }); listeners = [];
        tos.forEach(clearTimeout); tos = [];
      }
      function cleanup() { dead = true; stopAll(); }

      /* ---- Runden-Zustand ---- */
      var pulls = 0, collapsed = false, finished = false;
      var blockEls = [], present = [], board = null;
      var towerEl = null, hudPulls = null, hudRisk = null, hudTimer = null;
      var pullBtn = null, statusEl = null, stageEl = null, boardWrap = null;

      /* ---- Start ---- */
      if (isMulti) {
        var snap = ctx.room.snapshot() || {};
        var startAt = (snap.round && snap.round.startAt) || (ctx.room.now() + 3000);
        stops.push(MG.countdown(root, startAt, function () { startGame(startAt); }, ctx.room.now));
      } else {
        startGame(Date.now());
      }
      return { cleanup: cleanup };

      /* ===================== UI-AUFBAU ===================== */
      function startGame(startAtMs) {
        pulls = 0; collapsed = false; finished = false;
        buildUI();

        if (isMulti) {
          board = MG.liveBoard(ctx.room, ctx.me.id);
          stops.push(board.stop);
          boardWrap.appendChild(board.root);
          ctx.room.reportScore(0);
          // Sicherheits-Cap: nach DURATION endet die Runde in jedem Fall.
          var endAt = startAtMs + DURATION * 1000;
          stops.push(MG.roundTimer(endAt, function (left) {
            hudTimer.textContent = MG.mmss(Math.ceil(left));
            hudTimer.classList.toggle('jg-urgent', left <= 6);
          }, finish, ctx.room.now));
        }
        updateHud();
      }

      function buildUI() {
        hudPulls = el('div', { class: 'jg-score big-readout' }, ['0']);
        hudRisk = el('div', { class: 'jg-risk-v' }, [Math.round(collapseChance(0) * 100) + ' %']);
        var cells = [
          el('div', { class: 'jg-hud-cell' }, [el('span', { class: 'jg-hud-l' }, ['Steine']), hudPulls]),
          el('div', { class: 'jg-hud-cell jg-hud-mid' }, [el('span', { class: 'jg-hud-l' }, ['Einsturz-Risiko']), hudRisk])
        ];
        if (isMulti) {
          hudTimer = el('div', { class: 'mg-timer jg-timer' }, [MG.mmss(DURATION)]);
          cells.push(el('div', { class: 'jg-hud-cell jg-hud-right' }, [el('span', { class: 'jg-hud-l' }, ['Zeit']), hudTimer]));
        }
        var hud = el('div', { class: 'jg-hud glass' }, cells);

        // Turm
        blockEls = []; present = [];
        var rowEls = [];
        for (var r = 0; r < ROWS; r++) {
          var rowBlocks = [];
          for (var c = 0; c < PER_ROW; c++) {
            var b = el('div', { class: 'jg-block' });
            blockEls.push(b); present.push(true); rowBlocks.push(b);
          }
          rowEls.push(el('div', { class: 'jg-row' + (r % 2 ? ' perp' : '') }, rowBlocks));
        }
        towerEl = el('div', { class: 'jg-tower' }, rowEls);
        stageEl = el('div', { class: 'game-stage jg-stage' }, [towerEl]);

        statusEl = el('div', { class: 'jg-status' }, ['Zieh einen Stein 🧱']);
        pullBtn = el('button', { class: 'btn btn-primary btn-lg btn-block', type: 'button', onclick: pull }, ['🧱 Stein ziehen']);

        var hint = el('div', { class: 'hint-text jg-hint' }, ['Tippen · Klicken · Leertaste zum Ziehen — je höher, desto riskanter!']);

        var pieces = [hud, stageEl, statusEl, pullBtn, hint];
        boardWrap = null;
        if (isMulti) {
          boardWrap = el('div', { class: 'glass jg-board-wrap' }, [el('div', { class: 'mg-field-title' }, ['🏆 Rangliste'])]);
          pieces.push(boardWrap);
        }

        root.innerHTML = '';
        root.appendChild(el('div', { class: 'jg-layout' }, pieces));

        addInput();
      }

      function addInput() {
        var pd = function (e) { if (e && e.cancelable) e.preventDefault(); pull(); };
        stageEl.addEventListener('pointerdown', pd);
        listeners.push({ t: stageEl, e: 'pointerdown', fn: pd });
        var kd = function (e) {
          if (e.code === 'Space' || e.key === ' ' || e.keyCode === 32) { e.preventDefault(); pull(); }
        };
        window.addEventListener('keydown', kd);
        listeners.push({ t: window, e: 'keydown', fn: kd });
      }

      /* ===================== SPIELZUG ===================== */
      function pull() {
        if (dead || finished || collapsed) return;

        var p = collapseChance(pulls);
        if (Math.random() < p) { collapse(); return; }

        pulls++;
        removeOneBlock();
        if (App.Audio) App.Audio.sfx(pulls % 2 ? 'chip' : 'tick');
        if (isMulti) ctx.room.reportScore(pulls);
        statusEl.className = 'jg-status';
        statusEl.textContent = pulls + ' Stein(e) — weiter!';
        updateHud();
      }

      function removeOneBlock() {
        var idxList = [];
        for (var i = 0; i < present.length; i++) if (present[i]) idxList.push(i);
        if (!idxList.length) return;
        var pick = idxList[Math.floor(Math.random() * idxList.length)];
        present[pick] = false;
        blockEls[pick].classList.add('pulled');
        towerEl.classList.remove('shake'); void towerEl.offsetWidth; towerEl.classList.add('shake');
      }

      function collapse() {
        if (collapsed) return;
        collapsed = true;
        if (App.Audio) App.Audio.sfx('explosion');

        towerEl.classList.add('collapsing');
        for (var i = 0; i < blockEls.length; i++) {
          if (present[i]) {
            var dx = (Math.random() - 0.5) * 120;
            var dy = 80 + Math.random() * 120;
            var rot = (Math.random() - 0.5) * 70;
            blockEls[i].style.transform = 'translate(' + dx.toFixed(0) + 'px,' + dy.toFixed(0) + 'px) rotate(' + rot.toFixed(0) + 'deg)';
            blockEls[i].style.opacity = '0';
          }
        }
        towerEl.classList.remove('shake'); void towerEl.offsetWidth; towerEl.classList.add('shake');

        if (pullBtn) pullBtn.disabled = true;
        statusEl.className = 'jg-status jg-lose';
        statusEl.textContent = 'Turm gefallen bei ' + pulls + ' Steinen!';

        if (isMulti) {
          ctx.room.reportScore(pulls);
          statusEl.textContent = 'Turm gefallen bei ' + pulls + ' Steinen — warte auf die anderen ⏳';
          // Ende via Rundentimer (finish). Kein sofortiger Endscreen, damit die
          // Punktzahlen aller Spieler final sind.
        } else {
          after(950, finish);
        }
      }

      /* ===================== HUD ===================== */
      function updateHud() {
        if (!hudPulls) return;
        hudPulls.textContent = MG.fmt(pulls);
        var pct = Math.round(collapseChance(pulls) * 100);
        hudRisk.textContent = pct + ' %';
        hudRisk.classList.toggle('jg-danger', pct >= 30);
      }

      /* ===================== ENDE ===================== */
      function finish() {
        if (finished || dead) return;
        finished = true;
        stopAll();

        if (isMulti) {
          ctx.room.reportScore(pulls);
          after(1000, function () {
            if (dead) return;
            MG.endScreen(root, { players: ctx.room.players(), meId: ctx.me.id, onExit: ctx.onExit });
          });
        } else {
          var best = App.Storage.get('best_jenga', 0), nb = pulls > best;
          if (nb) App.Storage.set('best_jenga', pulls);
          MG.endScreen(root, {
            title: 'Turm gefallen! 🧱', score: pulls, best: best, newBest: nb,
            label: nb ? 'Neuer Rekord! 🎉' : 'Gezogene Steine · Bestwert: ' + MG.fmt(best),
            onExit: ctx.onExit,
            onAgain: function () { finished = false; dead = false; stops = []; listeners = []; tos = []; startGame(Date.now()); }
          });
        }
      }
    }
  };

  /* ===================== STYLES ===================== */
  function injectStyle() {
    UI.injectStyle('mg-jenga-css', [
      '.jg-layout{display:flex;flex-direction:column;gap:14px;align-items:stretch;}',
      /* HUD */
      '.jg-hud{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px 18px;}',
      '.jg-hud-cell{display:flex;flex-direction:column;gap:2px;}',
      '.jg-hud-mid{align-items:center;}',
      '.jg-hud-right{align-items:flex-end;}',
      '.jg-hud-l{font-size:11px;text-transform:uppercase;letter-spacing:1px;color:var(--muted);}',
      '.jg-score{font-size:clamp(26px,7vw,42px);line-height:1;color:var(--neon);text-shadow:0 0 14px rgba(57,255,20,.5);font-variant-numeric:tabular-nums;}',
      '.jg-risk-v{font-size:clamp(18px,5vw,26px);font-weight:900;color:var(--aqua-soft);font-variant-numeric:tabular-nums;transition:color .2s;}',
      '.jg-risk-v.jg-danger{color:var(--danger-2);text-shadow:0 0 10px rgba(255,77,109,.4);}',
      '.jg-timer{font-size:clamp(20px,5vw,28px);font-variant-numeric:tabular-nums;}',
      '.jg-timer.jg-urgent{color:var(--danger-2);animation:jg-pulse .6s ease-in-out infinite;}',
      '@keyframes jg-pulse{0%,100%{opacity:1}50%{opacity:.5}}',
      /* Spielfeld / Turm */
      '.jg-stage{position:relative;display:flex;align-items:flex-end;justify-content:center;overflow:hidden;padding:16px 0;',
      'min-height:clamp(260px,46vh,440px);cursor:pointer;touch-action:none;user-select:none;-webkit-user-select:none;-webkit-tap-highlight-color:transparent;',
      'background:radial-gradient(120% 100% at 50% 100%,#0c3020,#04120b);}',
      '.jg-tower{display:flex;flex-direction:column-reverse;gap:5px;width:min(280px,72vw);transition:transform .1s;}',
      '.jg-tower.shake{animation:jg-shake .5s ease;}',
      '@keyframes jg-shake{0%,100%{transform:translate(0,0) rotate(0)}20%{transform:translate(-6px,2px) rotate(-1deg)}40%{transform:translate(6px,-2px) rotate(1deg)}60%{transform:translate(-4px,2px) rotate(-.6deg)}80%{transform:translate(3px,-1px) rotate(.4deg)}}',
      '.jg-row{display:flex;gap:5px;height:clamp(16px,4.6vw,22px);}',
      '.jg-block{flex:1;border-radius:4px;background:linear-gradient(180deg,hsl(28,62%,58%),hsl(26,58%,44%));',
      'border:1px solid rgba(0,0,0,0.28);box-shadow:inset 0 1px 0 rgba(255,255,255,0.28),inset 0 -3px 5px rgba(0,0,0,0.28);',
      'transition:opacity .28s ease,transform .32s cubic-bezier(.3,.8,.4,1);}',
      '.jg-row.perp .jg-block{background:linear-gradient(180deg,hsl(34,58%,60%),hsl(30,54%,46%));}',
      '.jg-block.pulled{opacity:0;transform:translateX(50px) rotate(14deg);}',
      '.jg-tower.collapsing .jg-block{transition:transform .8s cubic-bezier(.4,.1,.7,1),opacity .8s ease;}',
      /* Status / Aktion */
      '.jg-status{text-align:center;font-weight:800;font-size:15px;color:var(--leaf);min-height:20px;}',
      '.jg-status.jg-lose{color:var(--danger-2);text-shadow:0 0 10px rgba(255,77,109,.4);}',
      '.jg-hint{text-align:center;}',
      '.jg-board-wrap{padding:14px;display:flex;flex-direction:column;gap:8px;max-height:260px;overflow-y:auto;}'
    ].join(''));
  }
})();
