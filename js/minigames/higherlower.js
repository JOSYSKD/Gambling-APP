/* higherlower.js — "Höher oder Tiefer": Karten-Raten mit Streak-Jagd.
 * Eine Dschungel-Karte (Wert 2–14, Neon-Symbole 🍃🌺🦋🐍) liegt offen.
 * Rate per Knopf (oder Pfeiltaste ↑/↓), ob die nächste Karte HÖHER oder
 * TIEFER ist. Richtig -> Punkte mit Streak-Multiplikator (+10 × Serie),
 * die neue Karte wird zur aktuellen. Falsch -> Serie zurück auf 0 (Punkte
 * bleiben), kurze Fehler-Animation, weiter. In 60 s möglichst viele Punkte
 * durch lange Serien. Gleiche Werte gibt es nicht: bei Gleichstand wird die
 * nächste Karte automatisch neu gezogen -> jeder Tipp ist fair entscheidbar.
 * Singleplayer (Bestwert 'best_higherlower' + längste Serie) + Multiplayer
 * (synchroner Countdown/Timer über App.MG mit room.now, Live-Rangliste,
 * Podest). Timer/Countdown laufen über Wall-Clock -> Tab-Wechsel-sicher. */
(function () {
  'use strict';
  window.App = window.App || {}; App.Minigames = App.Minigames || {};
  var UI = App.UI, el = UI.el, MG = App.MG;

  var DURATION = 60;      // Sekunden Rundenzeit
  var FLIP_MS = 440;      // Dauer der Karten-Flip-Animation
  var BASE = 10;          // Punkte-Basis, wird mit der Serie multipliziert

  /* Dschungel-"Farben" (Kartensymbole) mit je eigener Neon-Farbe. */
  var SUITS = [
    { s: '🍃', c: 'var(--neon)' },
    { s: '🌺', c: 'var(--danger-2)' },
    { s: '🦋', c: 'var(--aqua)' },
    { s: '🐍', c: 'var(--gold)' }
  ];

  injectStyle();

  /* Kartenwerte 2–14; Bildkarten mit Buchstaben (Ass hoch). */
  function rankLabel(v) { return v === 11 ? 'B' : v === 12 ? 'D' : v === 13 ? 'K' : v === 14 ? 'A' : String(v); }
  function randCard() {
    return { v: 2 + Math.floor(Math.random() * 13), suit: SUITS[Math.floor(Math.random() * SUITS.length)] };
  }
  /* Nächste Karte ziehen, die sich vom aktuellen Wert unterscheidet
     (Gleichstand kommt so nie vor -> Tipp immer eindeutig auswertbar). */
  function drawDifferent(avoidV) { var c; do { c = randCard(); } while (c.v === avoidV); return c; }

  App.Minigames.higherlower = {
    id: 'higherlower', title: 'Höher oder Tiefer', icon: '🔼', order: 15,
    subtitle: 'Rate, ob die nächste Karte höher oder tiefer ist',
    single: true, multi: true, minPlayers: 2, maxPlayers: 8,

    render: function (root, ctx) {
      var isMulti = ctx.mode === 'multi';
      var nowFn = isMulti ? ctx.room.now : function () { return Date.now(); };

      var destroyed = false;
      var stops = [];       // stop()-Funktionen (App.MG-Bausteine + Listener)
      var timeouts = [];     // laufende setTimeout-IDs

      function after(ms, fn) { var t = setTimeout(function () { if (!destroyed) fn(); }, ms); timeouts.push(t); return t; }
      function clearTimeouts() { timeouts.forEach(clearTimeout); timeouts = []; }
      function stopHelpers() { stops.forEach(function (f) { try { f(); } catch (e) {} }); stops = []; }
      function clearAll() { clearTimeouts(); stopHelpers(); }
      function cleanup() { destroyed = true; clearAll(); }

      /* ---- Start: Multi mit synchronem Countdown, Single sofort ---- */
      if (isMulti) {
        var snap = ctx.room.snapshot() || {};
        var startAt = (snap.round && snap.round.startAt) || (ctx.room.now() + 3000);
        stops.push(MG.countdown(root, startAt, function () { play(startAt); }, ctx.room.now));
      } else {
        play(Date.now());
      }
      return { cleanup: cleanup };

      /* ===================== SPIEL ===================== */
      function play(startAt) {
        if (destroyed) return;
        clearAll();
        var endAt = startAt + DURATION * 1000;
        var tnf = isMulti ? ctx.room.now : null;

        /* ---- Zustand ---- */
        var score = 0, streak = 0, bestStreak = 0, guesses = 0, correctCount = 0;
        var current = randCard();
        var locked = false, ended = false;

        /* ---- Kopf: Punkte · Serie · Timer ---- */
        var scoreEl = el('div', { class: 'hl-score' }, ['0']);
        var streakEl = el('div', { class: 'hl-streak' }, ['🔥 Serie ×0']);
        var timerEl = el('div', { class: 'hl-timer mg-timer' }, ['⏱ ' + MG.mmss(DURATION)]);
        var head = el('div', { class: 'hl-head glass' }, [
          el('div', { class: 'hl-head-cell' }, [el('span', { class: 'hl-head-l' }, ['Punkte']), scoreEl]),
          el('div', { class: 'hl-head-cell hl-head-mid' }, [el('span', { class: 'hl-head-l' }, ['Serie']), streakEl]),
          el('div', { class: 'hl-head-cell hl-head-timer' }, [el('span', { class: 'hl-head-l' }, ['Zeit']), timerEl])
        ]);

        /* ---- Die Karte (3D-Flip) ---- */
        var cTLr = el('span', { class: 'hl-cn-rank' }, ['']);
        var cTLs = el('span', { class: 'hl-cn-suit' }, ['']);
        var cBRr = el('span', { class: 'hl-cn-rank' }, ['']);
        var cBRs = el('span', { class: 'hl-cn-suit' }, ['']);
        var cRank = el('div', { class: 'hl-card-rank' }, ['']);
        var cSuit = el('div', { class: 'hl-card-suit' }, ['']);
        var card = el('div', { class: 'hl-card hl-deal' }, [
          el('div', { class: 'hl-corner tl' }, [cTLr, cTLs]),
          el('div', { class: 'hl-center' }, [cRank, cSuit]),
          el('div', { class: 'hl-corner br' }, [cBRr, cBRs])
        ]);
        var cardWrap = el('div', { class: 'hl-card-wrap' }, [card]);

        /* ---- Steuer-Buttons: HÖHER / TIEFER ---- */
        var upCount = el('span', { class: 'hl-btn-hint' }, ['']);
        var dnCount = el('span', { class: 'hl-btn-hint' }, ['']);
        var nextGain = el('span', { class: 'hl-btn-gain' }, ['']);
        var upBtn = el('button', { class: 'hl-btn hl-up', type: 'button', 'aria-label': 'Höher' }, [
          el('span', { class: 'hl-btn-ico' }, ['🔼']),
          el('span', { class: 'hl-btn-lbl' }, ['HÖHER']),
          upCount
        ]);
        var dnBtn = el('button', { class: 'hl-btn hl-dn', type: 'button', 'aria-label': 'Tiefer' }, [
          el('span', { class: 'hl-btn-ico' }, ['🔽']),
          el('span', { class: 'hl-btn-lbl' }, ['TIEFER']),
          dnCount
        ]);
        var controls = el('div', { class: 'hl-controls' }, [dnBtn, upBtn]);
        var gainRow = el('div', { class: 'hl-gain-row' }, [
          el('span', { class: 'hl-gain-l' }, ['Nächster Treffer: ']), nextGain
        ]);
        var hint = el('p', { class: 'hint-text hl-hint' }, ['Ist die nächste Karte höher oder tiefer? Gleiche Werte werden neu gezogen.']);

        /* ---- Live-Rangliste (multi) ---- */
        var board = isMulti ? MG.liveBoard(ctx.room, ctx.me.id) : null;
        if (board) stops.push(board.stop);
        var boardWrap = board ? el('div', { class: 'hl-board-wrap glass' }, [
          el('div', { class: 'mg-field-title' }, ['🏆 Rangliste']), board.root
        ]) : null;

        var stageCol = el('div', { class: 'hl-stage' }, [cardWrap, gainRow, controls, hint]);
        var layout = el('div', { class: 'hl-layout' }, [
          head,
          isMulti ? el('div', { class: 'hl-cols' }, [stageCol, boardWrap]) : stageCol
        ]);
        root.innerHTML = ''; root.appendChild(layout);

        /* ---- Karte anzeigen ---- */
        function paint(c) {
          var lbl = rankLabel(c.v);
          cRank.textContent = lbl; cTLr.textContent = lbl; cBRr.textContent = lbl;
          cSuit.textContent = c.suit.s; cTLs.textContent = c.suit.s; cBRs.textContent = c.suit.s;
          card.style.setProperty('--suit-c', c.suit.c);
        }
        function updateHud() {
          scoreEl.textContent = MG.fmt(score);
          streakEl.textContent = '🔥 Serie ×' + streak;
          streakEl.classList.toggle('hot', streak >= 2);
          nextGain.textContent = '+' + (BASE * (streak + 1));
          var higher = 14 - current.v, lower = current.v - 2;   // Karten über/unter dem aktuellen Wert
          upCount.textContent = higher + (higher === 1 ? ' Karte höher' : ' Karten höher');
          dnCount.textContent = lower + (lower === 1 ? ' Karte tiefer' : ' Karten tiefer');
        }
        paint(current);
        updateHud();

        /* ---- Ein Tipp ---- */
        function guess(dir) {
          if (locked || ended || destroyed || nowFn() >= endAt) return;
          locked = true;
          controls.classList.add('busy');
          card.classList.remove('hl-correct', 'hl-wrong', 'hl-deal');
          var btn = dir === 'higher' ? upBtn : dnBtn;
          btn.classList.remove('press'); void btn.offsetWidth; btn.classList.add('press');

          var next = drawDifferent(current.v);
          var correct = dir === 'higher' ? next.v > current.v : next.v < current.v;

          /* Flip starten; Inhalt in der Mitte (edge-on) tauschen. */
          card.classList.remove('hl-flip'); void card.offsetWidth; card.classList.add('hl-flip');
          after(FLIP_MS / 2, function () {
            current = next;
            paint(current);
            if (correct) {
              streak++; if (streak > bestStreak) bestStreak = streak;
              var pts = BASE * streak;               // Streak-Multiplikator
              score += pts; correctCount++;
              card.classList.add('hl-correct');
              popFloat(card, '+' + pts, true);
              if (App.Audio) App.Audio.sfx('coin');
            } else {
              streak = 0;
              card.classList.add('hl-wrong');
              popFloat(card, 'Daneben!', false);
              if (App.Audio) App.Audio.sfx('error');
            }
            guesses++;
            updateHud();
            btn.classList.add(correct ? 'ok' : 'bad');
            if (isMulti) ctx.room.reportScore(score);
          });
          after(FLIP_MS, function () {
            card.classList.remove('hl-flip');
            upBtn.classList.remove('ok', 'bad', 'press');
            dnBtn.classList.remove('ok', 'bad', 'press');
            locked = false;
            controls.classList.remove('busy');
          });
        }

        upBtn.addEventListener('click', function () { guess('higher'); });
        dnBtn.addEventListener('click', function () { guess('lower'); });

        /* ---- Tastatur (Desktop): ↑ = höher, ↓ = tiefer ---- */
        function keyHandler(e) {
          if (e.key === 'ArrowUp') { e.preventDefault(); guess('higher'); }
          else if (e.key === 'ArrowDown') { e.preventDefault(); guess('lower'); }
        }
        document.addEventListener('keydown', keyHandler);
        stops.push(function () { document.removeEventListener('keydown', keyHandler); });

        /* ---- Timer (Wall-Clock, Tab-sicher) ---- */
        stops.push(MG.roundTimer(endAt, function (left) {
          timerEl.textContent = '⏱ ' + MG.mmss(left);
          timerEl.classList.toggle('hl-urgent', left <= 10);
        }, finish, tnf));

        if (isMulti) ctx.room.reportScore(0);

        /* ---- schwebender +Punkte / Fehler-Text ---- */
        function popFloat(anchor, txt, win) {
          var r = anchor.getBoundingClientRect();
          var f = el('div', { class: 'hl-float ' + (win ? 'win' : 'lose'), text: txt });
          f.style.left = (r.left + r.width / 2 + (Math.random() * 30 - 15)) + 'px';
          f.style.top = (r.top + r.height * 0.3) + 'px';
          document.body.appendChild(f);
          setTimeout(function () { f.classList.add('go'); }, 10);
          setTimeout(function () { if (f.parentNode) f.parentNode.removeChild(f); }, 900);
        }

        /* ===================== ENDE ===================== */
        function finish() {
          if (ended || destroyed) return;
          ended = true;
          locked = true;
          clearAll();
          if (isMulti) {
            ctx.room.reportScore(score);
            after(1200, function () {
              if (destroyed) return;
              MG.endScreen(root, { players: ctx.room.players(), meId: ctx.me.id, onExit: ctx.onExit });
            });
          } else {
            var best = App.Storage.get('best_higherlower', 0);
            var nb = score > best;
            if (nb) App.Storage.set('best_higherlower', score);
            var stats = 'Längste Serie ×' + bestStreak + ' · ' + correctCount + '/' + guesses + ' richtig';
            MG.endScreen(root, {
              score: score, best: best, newBest: nb,
              label: (nb ? 'Neuer Rekord! 🎉 · ' : 'Bestwert: ' + MG.fmt(best) + ' · ') + stats,
              onExit: ctx.onExit,
              onAgain: function () { play(Date.now()); }
            });
          }
        }
      }
    }
  };

  /* ===================== STYLES ===================== */
  function injectStyle() {
    UI.injectStyle('mg-higherlower-css', [
      '.hl-layout{display:flex;flex-direction:column;gap:14px;}',
      '.hl-head{display:flex;justify-content:space-between;align-items:center;padding:12px 18px;gap:12px;flex-wrap:wrap;}',
      '.hl-head-cell{display:flex;flex-direction:column;gap:2px;min-width:0;}',
      '.hl-head-mid{text-align:center;}',
      '.hl-head-timer{text-align:right;}',
      '.hl-head-l{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:1px;}',
      '.hl-score{font-size:clamp(24px,6vw,40px);font-weight:900;line-height:1;color:var(--gold);text-shadow:0 0 12px rgba(255,210,63,.45);font-variant-numeric:tabular-nums;}',
      '.hl-streak{font-size:clamp(16px,4.5vw,24px);font-weight:900;color:var(--muted);line-height:1;transition:color .2s;}',
      '.hl-streak.hot{color:var(--neon);text-shadow:0 0 14px rgba(57,255,20,.6);animation:hl-streakpulse .35s ease;}',
      '@keyframes hl-streakpulse{0%{transform:scale(1)}45%{transform:scale(1.22)}100%{transform:scale(1)}}',
      '.hl-timer{font-size:clamp(18px,5vw,26px);}',
      '.mg-timer.hl-urgent{color:var(--danger-2);animation:hl-blink 1s steps(2,start) infinite;}',
      '@keyframes hl-blink{50%{opacity:.4}}',
      /* Zwei-Spalten im Multiplayer */
      '.hl-cols{display:grid;grid-template-columns:1fr;gap:14px;}',
      '@media(min-width:760px){.hl-cols{grid-template-columns:1.6fr 1fr;align-items:start;}}',
      '.hl-stage{display:flex;flex-direction:column;align-items:center;gap:14px;}',
      /* Karte + 3D-Flip */
      '.hl-card-wrap{perspective:1100px;padding:6px;}',
      '.hl-card{position:relative;width:clamp(150px,42vw,210px);height:clamp(210px,58vw,290px);border-radius:20px;',
      'background:linear-gradient(160deg,#0f3020,#071a10 78%);border:2.5px solid var(--suit-c,var(--stroke-2));',
      'box-shadow:0 10px 30px rgba(0,0,0,.45),0 0 26px color-mix(in srgb,var(--suit-c,#39ff14) 30%,transparent),inset 0 0 40px rgba(0,0,0,.35);',
      'display:flex;align-items:center;justify-content:center;transform-style:preserve-3d;will-change:transform;',
      'user-select:none;-webkit-user-select:none;}',
      '.hl-center{display:flex;flex-direction:column;align-items:center;gap:2px;}',
      '.hl-card-rank{font-size:clamp(52px,15vw,82px);font-weight:900;line-height:1;color:var(--suit-c,var(--leaf));',
      'text-shadow:0 0 18px color-mix(in srgb,var(--suit-c,#39ff14) 55%,transparent);font-variant-numeric:tabular-nums;}',
      '.hl-card-suit{font-size:clamp(34px,10vw,54px);line-height:1;filter:drop-shadow(0 2px 8px rgba(0,0,0,.5));margin-top:4px;}',
      '.hl-corner{position:absolute;display:flex;flex-direction:column;align-items:center;line-height:1;}',
      '.hl-corner.tl{top:10px;left:12px;}',
      '.hl-corner.br{bottom:10px;right:12px;transform:rotate(180deg);}',
      '.hl-cn-rank{font-size:clamp(16px,4.4vw,22px);font-weight:900;color:var(--suit-c,var(--leaf));font-variant-numeric:tabular-nums;}',
      '.hl-cn-suit{font-size:clamp(13px,3.4vw,17px);}',
      '.hl-card.hl-flip{animation:hl-flip var(--flip,.44s) ease;}',
      '@keyframes hl-flip{0%{transform:rotateY(0deg)}50%{transform:rotateY(90deg) scale(.96)}100%{transform:rotateY(0deg)}}',
      '.hl-card.hl-deal{animation:hl-deal .45s cubic-bezier(.2,.9,.3,1.2);}',
      '@keyframes hl-deal{0%{transform:translateY(-24px) scale(.8);opacity:0}100%{transform:translateY(0) scale(1);opacity:1}}',
      '.hl-card.hl-correct{border-color:var(--neon);box-shadow:0 10px 30px rgba(0,0,0,.45),0 0 40px rgba(57,255,20,.6),inset 0 0 46px rgba(57,255,20,.14);}',
      '.hl-card.hl-wrong{border-color:var(--danger);box-shadow:0 10px 30px rgba(0,0,0,.45),0 0 40px rgba(255,77,109,.6),inset 0 0 46px rgba(255,77,109,.16);animation:hl-shake .34s ease;}',
      '@keyframes hl-shake{0%,100%{transform:translateX(0)}18%{transform:translateX(-10px)}54%{transform:translateX(10px)}80%{transform:translateX(-5px)}}',
      /* Nächster-Treffer-Anzeige */
      '.hl-gain-row{font-size:14px;color:var(--muted);text-align:center;}',
      '.hl-gain-l{opacity:.85;}',
      '.hl-btn-gain{font-weight:900;color:var(--gold);text-shadow:0 0 10px rgba(255,210,63,.4);font-variant-numeric:tabular-nums;}',
      /* Buttons */
      '.hl-controls{display:grid;grid-template-columns:1fr 1fr;gap:12px;width:100%;max-width:460px;}',
      '.hl-controls.busy{pointer-events:none;opacity:.85;}',
      '.hl-btn{font-family:inherit;cursor:pointer;border-radius:18px;padding:16px 12px;display:flex;flex-direction:column;',
      'align-items:center;gap:4px;min-height:clamp(96px,22vw,124px);color:#04160c;font-weight:900;',
      'border:2px solid transparent;transition:transform .08s,box-shadow .15s,filter .15s;',
      'user-select:none;-webkit-user-select:none;-webkit-tap-highlight-color:transparent;touch-action:manipulation;}',
      '.hl-up{background:radial-gradient(circle at 50% 25%,#7dff5e,var(--neon) 78%);box-shadow:0 6px 18px rgba(57,255,20,.35),inset 0 0 30px rgba(255,255,255,.18);}',
      '.hl-dn{background:radial-gradient(circle at 50% 25%,#7ff3e6,var(--aqua) 78%);box-shadow:0 6px 18px rgba(51,230,208,.32),inset 0 0 30px rgba(255,255,255,.18);}',
      '.hl-btn:hover{transform:translateY(-2px);filter:brightness(1.06);}',
      '.hl-btn:active{transform:scale(.96);}',
      '.hl-btn.press{animation:hl-press .18s ease;}',
      '@keyframes hl-press{0%{transform:scale(1)}45%{transform:scale(.92)}100%{transform:scale(1)}}',
      '.hl-btn.ok{border-color:#eaffe2;box-shadow:0 0 30px rgba(57,255,20,.7),inset 0 0 30px rgba(255,255,255,.28);}',
      '.hl-btn.bad{filter:grayscale(.4) brightness(.8);border-color:var(--danger);}',
      '.hl-btn-ico{font-size:clamp(26px,7vw,38px);line-height:1;filter:drop-shadow(0 2px 5px rgba(0,0,0,.3));}',
      '.hl-btn-lbl{font-size:clamp(16px,4.6vw,22px);letter-spacing:2px;}',
      '.hl-btn-hint{font-size:11px;font-weight:800;color:rgba(4,22,12,.7);text-transform:uppercase;letter-spacing:.5px;}',
      '.hl-hint{margin-top:2px;max-width:440px;}',
      /* Rangliste */
      '.hl-board-wrap{padding:14px;display:flex;flex-direction:column;gap:8px;}',
      '.hl-board-wrap .mg-scoreboard{max-height:320px;overflow-y:auto;}',
      /* schwebender Text */
      '.hl-float{position:fixed;pointer-events:none;z-index:85;font-weight:900;font-size:26px;transform:translate(-50%,0);transition:all .85s ease-out;opacity:1;text-shadow:0 2px 10px rgba(0,0,0,.6);}',
      '.hl-float.win{color:var(--neon);}',
      '.hl-float.lose{color:var(--danger-2);font-size:22px;}',
      '.hl-float.go{transform:translate(-50%,-70px);opacity:0;}'
    ].join(''));
  }
})();
