/* stroop.js — "Farb-Chaos": Reaktions-Stroop-Test.
 * In der Mitte steht ein Farbwort (ROT/GRÜN/BLAU/GELB/LILA), aber in einer
 * ANDEREN Farbe eingefärbt. Man muss die TATSÄCHLICHE Schriftfarbe wählen,
 * nicht das gelesene Wort. Richtig = Punkte + Combo-Bonus, falsch = Combo-Reset.
 * Parallel-Wettbewerb (45 s): Singleplayer (Bestwert) + Multiplayer (Live-
 * Rangliste, Podest). Alle Timer laufen über Wall-Clock (App.MG) -> Tab-sicher. */
(function () {
  'use strict';
  window.App = window.App || {}; App.Minigames = App.Minigames || {};
  var UI = App.UI, el = UI.el, MG = App.MG;

  var DURATION = 45; // Sekunden Rundenzeit

  /* Kräftige, klar unterscheidbare Farben (fg = gut lesbare Beschriftungsfarbe). */
  var COLORS = [
    { key: 'rot',  name: 'ROT',  css: '#ff3b3b', fg: '#ffffff' },
    { key: 'gruen', name: 'GRÜN', css: '#22e04a', fg: '#04160c' },
    { key: 'blau', name: 'BLAU', css: '#4d8bff', fg: '#ffffff' },
    { key: 'gelb', name: 'GELB', css: '#ffd11a', fg: '#3a2c00' },
    { key: 'lila', name: 'LILA', css: '#c15bff', fg: '#ffffff' }
  ];

  injectStyle();

  App.Minigames.stroop = {
    id: 'stroop', title: 'Farb-Chaos', icon: '🌈', order: 8,
    subtitle: 'Wähle die FARBE des Wortes, nicht den Text',
    single: true, multi: true, minPlayers: 2, maxPlayers: 8,

    render: function (root, ctx) {
      var isMulti = ctx.mode === 'multi';
      var destroyed = false;
      var stops = [];          // stop()-Funktionen (Timer, Board, ...)
      var onKey = null;        // Tastatur-Listener

      /* Laufender Zustand */
      var score = 0, combo = 0, bestCombo = 0, correct = 0, finished = false;
      var current = null;      // { name, colorKey, colorCss }
      var btnMap = {};
      var scoreEl, comboEl, timerEl, wordEl, stageEl, boardMount;

      function clearStops() {
        stops.forEach(function (f) { try { f(); } catch (e) {} });
        stops = [];
        if (onKey) { document.removeEventListener('keydown', onKey); onKey = null; }
      }
      function cleanup() { destroyed = true; clearStops(); }

      /* ---- Start ---- */
      if (isMulti) {
        var snap = ctx.room.snapshot() || {};
        var startAt = (snap.round && snap.round.startAt) || (ctx.room.now() + MG.MULTI_START_DELAY);
        stops.push(MG.countdown(root, startAt, function () { play(startAt); }, ctx.room.now));
      } else {
        play(Date.now());
      }
      return { cleanup: cleanup };

      /* ===================== SPIEL ===================== */
      function play(startAt) {
        clearStops();
        score = 0; combo = 0; bestCombo = 0; correct = 0; finished = false;
        var endAt = startAt + DURATION * 1000;

        /* --- Kopf: Punkte + Combo + Timer --- */
        scoreEl = el('div', { class: 'stroop-score big-readout' }, ['0']);
        comboEl = el('div', { class: 'stroop-combo' }, ['']);
        timerEl = el('div', { class: 'mg-timer stroop-timer' }, ['⏱ ' + MG.mmss(DURATION)]);
        var head = el('div', { class: 'stroop-head glass' }, [
          el('div', { class: 'stroop-head-left' }, [
            el('span', { class: 'stroop-l' }, ['Punkte']),
            scoreEl, comboEl
          ]),
          timerEl
        ]);

        /* --- Bühne: das große Farbwort --- */
        wordEl = el('div', { class: 'stroop-word' }, ['']);
        stageEl = el('div', { class: 'stroop-stage glass' }, [
          el('div', { class: 'stroop-ask' }, ['Welche FARBE hat das Wort?']),
          wordEl,
          el('div', { class: 'stroop-note hint-text' }, ['Nicht lesen – nur die Farbe zählt!'])
        ]);

        /* --- Farb-Buttons --- */
        var btnRow = el('div', { class: 'stroop-buttons' });
        btnMap = {};
        COLORS.forEach(function (c, i) {
          var b = el('button', { class: 'stroop-cbtn', type: 'button', onclick: function () { answer(c.key); } }, [
            el('span', { class: 'stroop-cbtn-num' }, [String(i + 1)]),
            el('span', { class: 'stroop-cbtn-name' }, [c.name])
          ]);
          b.style.background = c.css;
          b.style.color = c.fg;
          btnMap[c.key] = b;
          btnRow.appendChild(b);
        });

        /* --- Live-Rangliste (multi) --- */
        boardMount = isMulti
          ? el('div', { class: 'stroop-board-wrap glass' }, [el('div', { class: 'mg-field-title' }, ['🏆 Rangliste'])])
          : null;

        var wrap = el('div', { class: 'stroop-wrap' }, [head, stageEl, btnRow, boardMount]);
        root.innerHTML = ''; root.appendChild(wrap);

        newWord();
        updateHud();

        if (isMulti) {
          var board = MG.liveBoard(ctx.room, ctx.me.id);
          boardMount.appendChild(board.root);
          stops.push(board.stop);
        }

        /* --- Rundentimer (Wall-Clock, Tab-sicher) --- */
        var nowFn = isMulti ? ctx.room.now : null;
        stops.push(MG.roundTimer(endAt, function (left) {
          timerEl.textContent = '⏱ ' + MG.mmss(left);
          timerEl.classList.toggle('urgent', left <= 10);
        }, finish, nowFn));

        /* --- Tastatur 1–5 (Desktop-Komfort) --- */
        onKey = function (e) {
          var idx = '12345'.indexOf(e.key);
          if (idx >= 0 && idx < COLORS.length) { e.preventDefault(); answer(COLORS[idx].key); }
        };
        document.addEventListener('keydown', onKey);
      }

      /* Neues Wort + Anzeigefarbe würfeln (meist inkongruent, gelegentlich gleich). */
      function newWord() {
        var wi = Math.floor(Math.random() * COLORS.length);
        var ci;
        if (Math.random() < 0.82) {
          do { ci = Math.floor(Math.random() * COLORS.length); } while (ci === wi);
        } else {
          ci = Math.floor(Math.random() * COLORS.length); // darf zufällig übereinstimmen
        }
        current = { name: COLORS[wi].name, colorKey: COLORS[ci].key, colorCss: COLORS[ci].css };
        wordEl.textContent = current.name;
        wordEl.style.color = current.colorCss;
        wordEl.style.textShadow = '0 0 26px ' + current.colorCss + 'cc, 0 3px 8px rgba(0,0,0,.55)';
        wordEl.classList.remove('in'); void wordEl.offsetWidth; wordEl.classList.add('in');
      }

      function answer(key) {
        if (finished || destroyed || !current) return;
        if (key === current.colorKey) {
          combo++;
          if (combo > bestCombo) bestCombo = combo;
          var gain = 10 + Math.min(combo - 1, 15) * 3;
          score += gain; correct++;
          flashStage('ok');
          pulseBtn(key, 'ok');
          popFloat('+' + gain, 'ok');
          if (isMulti) ctx.room.reportScore(score);
          newWord();
        } else {
          combo = 0;
          score = Math.max(0, score - 4);
          flashStage('bad');
          pulseBtn(key, 'bad');
          pulseBtn(current.colorKey, 'reveal'); // richtige Farbe kurz zeigen
          popFloat('−4', 'bad');
          if (isMulti) ctx.room.reportScore(score);
          newWord();
        }
        updateHud();
      }

      function updateHud() {
        if (!scoreEl) return;
        scoreEl.textContent = MG.fmt(score);
        if (combo >= 2) {
          comboEl.textContent = '🔥 Combo x' + combo;
          comboEl.classList.add('hot');
          comboEl.classList.remove('bump'); void comboEl.offsetWidth; comboEl.classList.add('bump');
        } else {
          comboEl.textContent = '';
          comboEl.classList.remove('hot');
        }
      }

      function flashStage(kind) {
        if (!stageEl) return;
        stageEl.classList.remove('fx-ok', 'fx-bad');
        void stageEl.offsetWidth;
        stageEl.classList.add(kind === 'ok' ? 'fx-ok' : 'fx-bad');
      }
      function pulseBtn(key, kind) {
        var b = btnMap[key]; if (!b) return;
        var cls = 'pulse-' + kind;
        b.classList.remove('pulse-ok', 'pulse-bad', 'pulse-reveal');
        void b.offsetWidth;
        b.classList.add(cls);
      }
      function popFloat(txt, kind) {
        if (!stageEl) return;
        var f = el('div', { class: 'stroop-float ' + (kind === 'ok' ? 'f-ok' : 'f-bad'), text: txt });
        stageEl.appendChild(f);
        f.addEventListener('animationend', function () { if (f.parentNode) f.parentNode.removeChild(f); });
      }

      /* ===================== ENDE ===================== */
      function finish() {
        if (finished) return; finished = true;
        clearStops();
        if (isMulti) {
          ctx.room.reportScore(score);
          var t = setTimeout(function () {
            if (destroyed) return;
            MG.endScreen(root, { players: ctx.room.players(), meId: ctx.me.id, onExit: ctx.onExit });
          }, 1200);
          stops.push(function () { clearTimeout(t); });
        } else {
          var best = App.Storage.get('best_stroop', 0);
          var nb = score > best;
          if (nb) App.Storage.set('best_stroop', score);
          MG.endScreen(root, {
            score: score, best: best, newBest: nb,
            label: nb ? ('Neuer Rekord! 🎉  ·  ' + correct + ' richtig, Top-Combo x' + bestCombo)
                      : (correct + ' richtig · Top-Combo x' + bestCombo + '  ·  Bestwert: ' + MG.fmt(best)),
            onExit: ctx.onExit,
            onAgain: function () { play(Date.now()); }
          });
        }
      }
    }
  };

  /* ============================ STYLE ============================ */
  function injectStyle() {
    UI.injectStyle('mg-stroop-css', [
      '.stroop-wrap{display:flex;flex-direction:column;gap:14px;}',
      /* Kopf */
      '.stroop-head{display:flex;justify-content:space-between;align-items:center;padding:12px 18px;gap:12px;flex-wrap:wrap;}',
      '.stroop-head-left{display:flex;flex-direction:column;gap:2px;}',
      '.stroop-l{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:1px;font-weight:800;}',
      '.stroop-score{font-size:clamp(26px,6vw,40px);line-height:1;color:var(--gold);text-shadow:0 0 14px rgba(255,210,63,.5);}',
      '.stroop-combo{font-size:13px;font-weight:900;color:var(--muted);min-height:16px;letter-spacing:.4px;}',
      '.stroop-combo.hot{color:var(--gold);text-shadow:0 0 10px rgba(255,210,63,.55);}',
      '.stroop-combo.bump{animation:stroop-bump .3s ease;}',
      '@keyframes stroop-bump{0%{transform:scale(.7)}55%{transform:scale(1.25)}100%{transform:scale(1)}}',
      '.stroop-timer.urgent{color:var(--danger-2);animation:stroop-blink 1s steps(2) infinite;}',
      '@keyframes stroop-blink{50%{opacity:.4}}',
      /* Bühne */
      '.stroop-stage{position:relative;overflow:hidden;padding:26px 18px 22px;display:flex;flex-direction:column;align-items:center;gap:10px;text-align:center;min-height:220px;justify-content:center;transition:box-shadow .18s,border-color .18s;}',
      '.stroop-ask{font-size:13px;font-weight:800;color:var(--aqua-soft);text-transform:uppercase;letter-spacing:1.5px;}',
      '.stroop-word{font-size:clamp(52px,17vw,120px);font-weight:900;line-height:1;letter-spacing:2px;user-select:none;-webkit-user-select:none;}',
      '.stroop-word.in{animation:stroop-pop .22s ease;}',
      '@keyframes stroop-pop{0%{transform:scale(.82);opacity:.2}60%{transform:scale(1.05)}100%{transform:scale(1);opacity:1}}',
      '.stroop-note{margin:0;}',
      '.stroop-stage.fx-ok{animation:stroop-ok .38s ease;}',
      '.stroop-stage.fx-bad{animation:stroop-bad .4s ease;}',
      '@keyframes stroop-ok{0%,100%{box-shadow:none}40%{box-shadow:inset 0 0 0 3px var(--neon),0 0 28px rgba(57,255,20,.5)}}',
      '@keyframes stroop-bad{0%,100%{transform:translateX(0);box-shadow:none}20%{transform:translateX(-9px);box-shadow:inset 0 0 0 3px var(--danger)}40%{transform:translateX(8px)}60%{transform:translateX(-5px)}80%{transform:translateX(4px)}}',
      /* Schwebende Punkte */
      '.stroop-float{position:absolute;left:50%;top:46%;transform:translate(-50%,0);pointer-events:none;font-weight:900;font-size:clamp(24px,6vw,38px);z-index:5;animation:stroop-fly .8s ease-out forwards;text-shadow:0 2px 10px rgba(0,0,0,.6);}',
      '.stroop-float.f-ok{color:var(--neon);}',
      '.stroop-float.f-bad{color:var(--danger-2);}',
      '@keyframes stroop-fly{0%{opacity:0;transform:translate(-50%,10px) scale(.6)}25%{opacity:1;transform:translate(-50%,-6px) scale(1.1)}100%{opacity:0;transform:translate(-50%,-70px) scale(1)}}',
      /* Farb-Buttons */
      '.stroop-buttons{display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:10px;}',
      '.stroop-cbtn{position:relative;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;min-height:64px;padding:10px 8px;border:none;border-radius:14px;cursor:pointer;font-family:inherit;font-weight:900;',
      'box-shadow:0 6px 0 rgba(0,0,0,.35),0 8px 20px rgba(0,0,0,.35);transition:transform .08s,filter .12s,box-shadow .08s;-webkit-tap-highlight-color:transparent;user-select:none;}',
      '.stroop-cbtn:hover{filter:brightness(1.08);}',
      '.stroop-cbtn:active{transform:translateY(4px);box-shadow:0 2px 0 rgba(0,0,0,.35),0 4px 12px rgba(0,0,0,.35);}',
      '.stroop-cbtn-num{font-size:11px;opacity:.75;font-weight:800;line-height:1;}',
      '.stroop-cbtn-name{font-size:clamp(15px,4.4vw,20px);letter-spacing:1px;line-height:1;}',
      '.stroop-cbtn.pulse-ok{animation:stroop-bok .35s ease;}',
      '.stroop-cbtn.pulse-bad{animation:stroop-bbad .35s ease;}',
      '.stroop-cbtn.pulse-reveal{animation:stroop-brev .55s ease;}',
      '@keyframes stroop-bok{0%,100%{transform:translateY(0)}45%{transform:translateY(4px) scale(.96);box-shadow:0 0 0 4px #fff,0 0 22px rgba(255,255,255,.6)}}',
      '@keyframes stroop-bbad{0%,100%{transform:translateY(0)}25%{transform:translateX(-6px)}55%{transform:translateX(5px);filter:brightness(.7)}}',
      '@keyframes stroop-brev{0%,100%{box-shadow:0 6px 0 rgba(0,0,0,.35),0 8px 20px rgba(0,0,0,.35)}30%,70%{box-shadow:0 0 0 4px var(--neon),0 0 24px rgba(57,255,20,.7)}}',
      /* Rangliste */
      '.stroop-board-wrap{padding:14px;display:flex;flex-direction:column;gap:8px;}',
      '@media(min-width:560px){.stroop-buttons{grid-template-columns:repeat(5,1fr);}}'
    ].join(''));
  }
})();
