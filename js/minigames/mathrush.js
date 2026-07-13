/* mathrush.js — "Kopf-Rechnen": Löse in 60 Sekunden so viele Rechenaufgaben
 * wie möglich. Multiple-Choice (4 Buttons), Schwierigkeit steigt mit dem
 * Fortschritt (erst kleine Zahlen, später größere / Multiplikation).
 * Richtig -> Punkte (+10/+20/+30) + Combo-Bonus, sofort weiter.
 * Falsch  -> rote Rückmeldung, kleine Punkt-/Zeitstrafe (kurze Sperre).
 * Singleplayer (Bestwert 'best_mathrush') + Multiplayer (Live-Rangliste,
 * synchroner Countdown/Timer über App.MG, Podest). Tab-Wechsel-sicher. */
(function () {
  'use strict';
  window.App = window.App || {}; App.Minigames = App.Minigames || {};
  var UI = App.UI, el = UI.el, MG = App.MG;

  var DURATION = 60;          // Sekunden Rundenzeit
  var WRONG_LOCK = 800;       // ms Sperre nach falscher Antwort (Zeitstrafe)
  var RIGHT_LOCK = 150;       // ms grüne Bestätigung, dann nächste Aufgabe
  var WRONG_PENALTY = 5;      // Punktabzug bei falscher Antwort

  injectStyle();

  function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
  function shuffle(a) { for (var i = a.length - 1; i > 0; i--) { var j = Math.floor(Math.random() * (i + 1)); var t = a[i]; a[i] = a[j]; a[j] = t; } return a; }

  /* Schwierigkeitsstufe nach Anzahl gelöster Aufgaben. */
  function levelFor(solved) {
    if (solved < 4) return 1;
    if (solved < 9) return 2;
    return 3;
  }

  /* Eine Aufgabe bauen: {text, answer, points, op}. */
  function makeQuestion(level) {
    var ops = level === 1 ? ['+', '−'] : ['+', '−', '×', '×'];
    var op = ops[randInt(0, ops.length - 1)];
    var a, b, answer;
    if (op === '+') {
      if (level === 1) { a = randInt(2, 20); b = randInt(2, 20); }
      else if (level === 2) { a = randInt(12, 60); b = randInt(12, 60); }
      else { a = randInt(30, 150); b = randInt(25, 150); }
      answer = a + b;
    } else if (op === '−') {
      if (level === 1) { a = randInt(6, 20); b = randInt(1, a); }
      else if (level === 2) { a = randInt(25, 80); b = randInt(5, a); }
      else { a = randInt(70, 190); b = randInt(15, a); }
      answer = a - b;
    } else { // ×
      if (level === 2) { a = randInt(2, 9); b = randInt(2, 9); }
      else if (Math.random() < 0.45) { a = randInt(6, 15); b = randInt(3, 9); }
      else { a = randInt(3, 12); b = randInt(3, 12); }
      answer = a * b;
    }
    var points = level === 1 ? 10 : level === 2 ? 20 : 30;
    return { text: a + ' ' + op + ' ' + b, answer: answer, points: points, op: op };
  }

  /* Drei plausible falsche Antworten nahe am richtigen Ergebnis. */
  function distractors(answer, op) {
    var used = {}; used[answer] = true;
    var big = op === '×' && answer > 30;
    var pool = [answer + 1, answer - 1, answer + 2, answer - 2, answer + 10, answer - 10,
      answer + (big ? 6 : 3), answer - (big ? 6 : 3), answer + (big ? 12 : 4), answer - (big ? 12 : 4)];
    shuffle(pool);
    var out = [];
    for (var i = 0; i < pool.length && out.length < 3; i++) {
      var v = pool[i];
      if (v < 0 || used[v]) continue;
      used[v] = true; out.push(v);
    }
    var d = 1;
    while (out.length < 3) { var w = answer + d; if (w >= 0 && !used[w]) { used[w] = true; out.push(w); } d++; }
    return out;
  }

  App.Minigames.mathrush = {
    id: 'mathrush', title: 'Kopf-Rechnen', icon: '🔢', order: 6,
    subtitle: 'Löse in 60 Sekunden so viele Aufgaben wie möglich',
    single: true, multi: true, minPlayers: 2, maxPlayers: 8,

    render: function (root, ctx) {
      var isMulti = ctx.mode === 'multi';
      var stops = [], timeouts = [], destroyed = false;
      function after(ms, fn) { var t = setTimeout(fn, ms); timeouts.push(t); return t; }
      function clearAll() { stops.forEach(function (f) { try { f(); } catch (e) {} }); stops = []; timeouts.forEach(clearTimeout); timeouts = []; }
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
        var nowFn = isMulti ? ctx.room.now : null;

        /* ---- Zustand ---- */
        var score = 0, combo = 0, maxCombo = 0, solved = 0;
        var current = null, locked = false, ended = false;

        /* ---- Kopf: Punkte · Combo · Timer ---- */
        var scoreEl = el('div', { class: 'mr-score' }, ['0']);
        var comboEl = el('div', { class: 'mr-combo' }, ['']);
        var timerEl = el('div', { class: 'mr-timer mg-timer' }, ['⏱ ' + MG.mmss(DURATION)]);
        var head = el('div', { class: 'mr-head glass' }, [
          el('div', { class: 'mr-head-left' }, [el('span', { class: 'mr-score-l' }, ['Punkte']), scoreEl]),
          comboEl,
          el('div', { class: 'mr-head-right' }, [timerEl])
        ]);

        /* ---- Aufgabe ---- */
        var worthEl = el('div', { class: 'mr-worth' }, ['+10']);
        var questionEl = el('div', { class: 'mr-question big-readout' }, ['…']);
        var stage = el('div', { class: 'mr-stage glass' }, [worthEl, questionEl]);

        /* ---- 4 Antwort-Buttons (2×2) ---- */
        var answerBtns = [];
        for (var i = 0; i < 4; i++) {
          var b = el('button', { class: 'mr-ans', type: 'button' }, ['']);
          b.addEventListener('click', function () { handleAnswer(Number(this.dataset.val), this); });
          answerBtns.push(b);
        }
        var answers = el('div', { class: 'mr-answers' }, answerBtns);

        /* ---- Layout (+ Rangliste im Multi) ---- */
        var main = el('div', { class: 'mr-main' }, [stage, answers]);
        var boardWrap = isMulti ? el('div', { class: 'mr-board-wrap glass' }, [el('div', { class: 'mg-field-title' }, ['🏆 Rangliste'])]) : null;
        var layout = el('div', { class: 'mr-layout' }, [
          head,
          isMulti ? el('div', { class: 'mr-cols' }, [main, boardWrap]) : main
        ]);
        root.innerHTML = ''; root.appendChild(layout);

        /* ---- Live-Rangliste ---- */
        if (isMulti) {
          var board = MG.liveBoard(ctx.room, ctx.me.id);
          boardWrap.appendChild(board.root);
          stops.push(board.stop);
          ctx.room.reportScore(0);
        }

        /* ---- Timer (Wall-Clock, Tab-sicher) ---- */
        stops.push(MG.roundTimer(endAt, function (left) {
          timerEl.textContent = '⏱ ' + MG.mmss(left);
          timerEl.classList.toggle('mr-urgent', left <= 10);
        }, finish, nowFn));

        nextQuestion();
        updateHud();

        /* ===================== ABLAUF ===================== */
        function nextQuestion() {
          if (destroyed || ended) return;
          locked = false;
          current = makeQuestion(levelFor(solved));
          var opts = shuffle([current.answer].concat(distractors(current.answer, current.op)));
          worthEl.textContent = '+' + current.points;
          worthEl.dataset.tier = String(current.points);
          questionEl.textContent = current.text + ' = ?';
          questionEl.classList.remove('mr-pop'); void questionEl.offsetWidth; questionEl.classList.add('mr-pop');
          answerBtns.forEach(function (btn, idx) {
            btn.classList.remove('correct', 'wrong');
            btn.disabled = false;
            btn.dataset.val = opts[idx];
            btn.textContent = String(opts[idx]);
          });
        }

        function handleAnswer(val, btn) {
          if (locked || ended || destroyed) return;
          locked = true;
          answerBtns.forEach(function (x) { x.disabled = true; });
          var q = current;
          if (val === q.answer) {
            solved++; combo++; if (combo > maxCombo) maxCombo = combo;
            var bonus = Math.min(Math.max(0, combo - 1) * 2, 20);   // Combo-Bonus
            var gain = q.points + bonus;
            score += gain;
            btn.classList.add('correct');
            popFloat(btn, '+' + gain);
            updateHud();
            if (isMulti) ctx.room.reportScore(score);
            after(RIGHT_LOCK, nextQuestion);
          } else {
            combo = 0;
            score = Math.max(0, score - WRONG_PENALTY);
            btn.classList.add('wrong');
            answerBtns.forEach(function (x) { if (Number(x.dataset.val) === q.answer) x.classList.add('correct'); });
            updateHud();
            if (isMulti) ctx.room.reportScore(score);
            after(WRONG_LOCK, nextQuestion);   // Sperre = kleine Zeitstrafe
          }
        }

        function updateHud() {
          scoreEl.textContent = String(score);
          if (combo >= 2) {
            comboEl.textContent = '🔥 Combo ×' + combo;
            comboEl.classList.remove('on'); void comboEl.offsetWidth; comboEl.classList.add('on');
          } else {
            comboEl.textContent = '';
            comboEl.classList.remove('on');
          }
        }

        function popFloat(anchor, txt) {
          var r = anchor.getBoundingClientRect();
          var f = el('div', { class: 'mr-float', text: txt });
          f.style.left = (r.left + r.width / 2 + (Math.random() * 30 - 15)) + 'px';
          f.style.top = (r.top + r.height / 2) + 'px';
          document.body.appendChild(f);
          setTimeout(function () { f.classList.add('go'); }, 10);
          setTimeout(function () { if (f.parentNode) f.parentNode.removeChild(f); }, 900);
        }

        function finish() {
          if (ended || destroyed) return;
          ended = true;
          clearAll();
          if (isMulti) {
            ctx.room.reportScore(score);
            after(1200, function () {
              if (destroyed) return;
              MG.endScreen(root, { players: ctx.room.players(), meId: ctx.me.id, onExit: ctx.onExit });
            });
          } else {
            var best = App.Storage.get('best_mathrush', 0);
            var nb = score > best;
            if (nb) App.Storage.set('best_mathrush', score);
            var stats = solved + ' gelöst · Max-Combo ×' + maxCombo;
            MG.endScreen(root, {
              score: score, best: best, newBest: nb,
              label: (nb ? 'Neuer Rekord! 🎉 · ' : 'Bestwert: ' + best + ' · ') + stats,
              onExit: ctx.onExit,
              onAgain: function () { play(Date.now()); }
            });
          }
        }
      }
    }
  };

  function injectStyle() {
    UI.injectStyle('mg-mathrush-css', [
      '.mr-layout{display:flex;flex-direction:column;gap:14px;}',
      '.mr-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 18px;flex-wrap:wrap;}',
      '.mr-head-left{display:flex;flex-direction:column;}',
      '.mr-score-l{font-size:11px;text-transform:uppercase;letter-spacing:1px;color:var(--muted);}',
      '.mr-score{font-size:clamp(24px,6vw,36px);font-weight:900;line-height:1;color:var(--gold);text-shadow:0 0 12px rgba(255,210,63,.45);font-variant-numeric:tabular-nums;}',
      '.mr-combo{font-weight:900;color:var(--neon);font-size:15px;opacity:0;text-shadow:0 0 10px rgba(57,255,20,.6);}',
      '.mr-combo.on{opacity:1;animation:mr-combo-pop .3s ease;}',
      '@keyframes mr-combo-pop{0%{transform:scale(.7)}60%{transform:scale(1.18)}100%{transform:scale(1)}}',
      '.mr-timer{font-size:18px;}',
      '.mr-timer.mr-urgent{color:var(--danger);animation:mr-blink 1s steps(2,start) infinite;}',
      '@keyframes mr-blink{50%{opacity:.4}}',
      '.mr-cols{display:grid;grid-template-columns:1fr;gap:14px;}',
      '@media(min-width:760px){.mr-cols{grid-template-columns:1.7fr 1fr;align-items:start;}}',
      '.mr-main{display:flex;flex-direction:column;gap:14px;}',
      '.mr-stage{padding:26px 18px;text-align:center;display:flex;flex-direction:column;align-items:center;gap:8px;overflow:hidden;}',
      '.mr-worth{font-size:13px;font-weight:800;color:var(--aqua-soft);letter-spacing:1px;}',
      '.mr-worth[data-tier="20"]{color:var(--neon);}',
      '.mr-worth[data-tier="30"]{color:var(--gold);}',
      '.mr-question{font-size:clamp(34px,10vw,58px);font-weight:900;line-height:1.1;color:var(--text);word-break:break-word;}',
      '.mr-question.mr-pop{animation:mr-qpop .22s ease;}',
      '@keyframes mr-qpop{0%{transform:scale(.9);opacity:.3}100%{transform:scale(1);opacity:1}}',
      '.mr-answers{display:grid;grid-template-columns:1fr 1fr;gap:12px;}',
      '.mr-ans{font-family:inherit;font-size:clamp(22px,6vw,30px);font-weight:900;color:var(--text);cursor:pointer;',
      'min-height:clamp(66px,15vw,92px);border-radius:16px;background:rgba(9,32,21,.75);border:1.5px solid var(--stroke-2);',
      'transition:transform .08s,box-shadow .15s,background .15s,border-color .15s;user-select:none;-webkit-user-select:none;',
      'font-variant-numeric:tabular-nums;touch-action:manipulation;}',
      '.mr-ans:hover:not(:disabled){box-shadow:var(--glow-soft);transform:translateY(-2px);border-color:var(--neon);}',
      '.mr-ans:active:not(:disabled){transform:scale(.96);}',
      '.mr-ans:disabled{cursor:default;}',
      '.mr-ans.correct{background:rgba(57,255,20,.22);border-color:var(--neon);color:var(--leaf);box-shadow:0 0 22px rgba(57,255,20,.55);animation:mr-correct .3s ease;}',
      '@keyframes mr-correct{0%{transform:scale(1)}40%{transform:scale(1.07)}100%{transform:scale(1)}}',
      '.mr-ans.wrong{background:rgba(255,77,109,.22);border-color:var(--danger);color:#ffb3c1;animation:mr-shake .32s ease;}',
      '@keyframes mr-shake{0%,100%{transform:translateX(0)}20%{transform:translateX(-7px)}60%{transform:translateX(7px)}}',
      '.mr-board-wrap{padding:16px;display:flex;flex-direction:column;gap:10px;}',
      '.mr-float{position:fixed;pointer-events:none;z-index:85;font-weight:900;font-size:26px;color:var(--neon);text-shadow:0 2px 10px rgba(0,0,0,.6);transform:translate(-50%,0);transition:all .85s ease-out;opacity:1;}',
      '.mr-float.go{transform:translate(-50%,-70px);opacity:0;}'
    ].join(''));
  }
})();
