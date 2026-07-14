/* quiz.js — "Quiz-Rausch": Beantworte in 90 Sekunden so viele Multiple-
 * Choice-Fragen wie möglich richtig. Große Frage oben, 4 Antwort-Buttons (2×2).
 * Richtig -> Punkte + Tempo-Bonus (schneller = mehr) + Combo, grüne Bestätigung,
 * sofort weiter. Falsch -> rote Markierung, richtige Antwort kurz grün, Combo-
 * Reset, kleine Sperre (~0.8s), dann weiter. Fragen & Antworten werden gemischt,
 * keine Frage doppelt bis der Pool durch ist. Parallel-Wettbewerb:
 * Singleplayer (Bestwert 'best_quiz') + Multiplayer (Live-Rangliste, synchroner
 * Countdown/Timer über App.MG, Podest). Alle Timer über Wall-Clock -> Tab-sicher. */
(function () {
  'use strict';
  window.App = window.App || {}; App.Minigames = App.Minigames || {};
  var UI = App.UI, el = UI.el, MG = App.MG;

  var DURATION = 90;          // Sekunden Rundenzeit
  var WRONG_LOCK = 800;       // ms Sperre nach falscher Antwort (richtige Lösung wird gezeigt)
  var RIGHT_LOCK = 380;       // ms grüne Bestätigung, dann nächste Frage
  var BASE_POINTS = 10;       // Grundpunkte für richtige Antwort
  var SPEED_MAX = 15;         // maximaler Tempo-Bonus (sofort geantwortet)
  var SPEED_WINDOW = 5000;    // ms bis der Tempo-Bonus auf 0 sinkt
  var COMBO_CAP = 20;         // maximaler Combo-Bonus

  function shuffle(a) { for (var i = a.length - 1; i > 0; i--) { var j = Math.floor(Math.random() * (i + 1)); var t = a[i]; a[i] = a[j]; a[j] = t; } return a; }

  /* ===================== FRAGEN-POOL (>= 40) =====================
   * Jede Frage: { q: Frage, a: [4 Antworten], c: Index der RICHTIGEN Antwort }.
   * Faktisch korrekt & eindeutig, leicht bis mittel. */
  var POOL = [
    // --- Geografie ---
    { q: 'Was ist die Hauptstadt von Frankreich?', a: ['Paris', 'Rom', 'Madrid', 'Berlin'], c: 0 },
    { q: 'Was ist die Hauptstadt von Italien?', a: ['Rom', 'Mailand', 'Neapel', 'Venedig'], c: 0 },
    { q: 'Was ist die Hauptstadt von Deutschland?', a: ['Berlin', 'Hamburg', 'München', 'Köln'], c: 0 },
    { q: 'Was ist die Hauptstadt von Spanien?', a: ['Madrid', 'Barcelona', 'Sevilla', 'Valencia'], c: 0 },
    { q: 'Was ist die Hauptstadt von Japan?', a: ['Tokio', 'Peking', 'Seoul', 'Bangkok'], c: 0 },
    { q: 'Welcher Fluss fließt durch Ägypten?', a: ['Nil', 'Amazonas', 'Rhein', 'Donau'], c: 0 },
    { q: 'Welcher ist der höchste Berg der Welt?', a: ['Mount Everest', 'K2', 'Mont Blanc', 'Kilimandscharo'], c: 0 },
    { q: 'Auf welchem Kontinent liegt Ägypten?', a: ['Afrika', 'Asien', 'Europa', 'Südamerika'], c: 0 },
    { q: 'Welches Land hat die Form eines Stiefels?', a: ['Italien', 'Griechenland', 'Portugal', 'Kroatien'], c: 0 },
    { q: 'Welcher ist der größte Ozean der Erde?', a: ['Pazifik', 'Atlantik', 'Indischer Ozean', 'Nordmeer'], c: 0 },
    { q: 'In welchem Land steht die Freiheitsstatue?', a: ['USA', 'Frankreich', 'England', 'Kanada'], c: 0 },
    { q: 'Welcher Kontinent ist der größte?', a: ['Asien', 'Afrika', 'Europa', 'Nordamerika'], c: 0 },
    { q: 'Welches ist das flächengrößte Land der Erde?', a: ['Russland', 'Kanada', 'China', 'USA'], c: 0 },
    { q: 'Wie viele Kontinente gibt es?', a: ['7', '5', '6', '8'], c: 0 },
    // --- Natur / Tiere / Dschungel ---
    { q: 'Welches ist das größte Landtier der Welt?', a: ['Elefant', 'Nashorn', 'Giraffe', 'Nilpferd'], c: 0 },
    { q: 'Welches Tier nennt man "König der Tiere"?', a: ['Löwe', 'Tiger', 'Bär', 'Wolf'], c: 0 },
    { q: 'Wie viele Beine hat eine Spinne?', a: ['8', '6', '10', '4'], c: 0 },
    { q: 'Welches ist das schnellste Landtier?', a: ['Gepard', 'Löwe', 'Pferd', 'Gazelle'], c: 0 },
    { q: 'Welches dieser Tiere ist ein Säugetier?', a: ['Wal', 'Hai', 'Krokodil', 'Thunfisch'], c: 0 },
    { q: 'Welcher Vogel kann nicht fliegen?', a: ['Pinguin', 'Adler', 'Spatz', 'Taube'], c: 0 },
    { q: 'Was fressen Pandas hauptsächlich?', a: ['Bambus', 'Fisch', 'Fleisch', 'Gras'], c: 0 },
    { q: 'Welches ist das größte Tier der Welt?', a: ['Blauwal', 'Elefant', 'Giraffe', 'Weißer Hai'], c: 0 },
    { q: 'Welches Insekt produziert Honig?', a: ['Biene', 'Wespe', 'Ameise', 'Fliege'], c: 0 },
    { q: 'Welcher Affe ist der größte?', a: ['Gorilla', 'Schimpanse', 'Orang-Utan', 'Gibbon'], c: 0 },
    { q: 'Welches Reptil kann seine Hautfarbe ändern?', a: ['Chamäleon', 'Schlange', 'Schildkröte', 'Echse'], c: 0 },
    { q: 'Wie viele Farben hat ein Regenbogen?', a: ['7', '5', '6', '8'], c: 0 },
    { q: 'Wo leben Tukane vor allem?', a: ['Regenwald', 'Wüste', 'Arktis', 'Meer'], c: 0 },
    { q: 'Wie nennt man ein Tier, das nur Pflanzen frisst?', a: ['Pflanzenfresser', 'Fleischfresser', 'Allesfresser', 'Aasfresser'], c: 0 },
    // --- Allgemeinwissen / Natur & Weltall ---
    { q: 'Wie viele Tage hat ein normales Jahr?', a: ['365', '364', '366', '360'], c: 0 },
    { q: 'Wie viele Minuten hat eine Stunde?', a: ['60', '30', '100', '90'], c: 0 },
    { q: 'Welche Farbe entsteht aus Blau und Gelb?', a: ['Grün', 'Orange', 'Lila', 'Braun'], c: 0 },
    { q: 'Wie viele Planeten hat unser Sonnensystem?', a: ['8', '9', '7', '10'], c: 0 },
    { q: 'Welcher Planet ist der Sonne am nächsten?', a: ['Merkur', 'Venus', 'Erde', 'Mars'], c: 0 },
    { q: 'Welcher Planet wird "Roter Planet" genannt?', a: ['Mars', 'Venus', 'Jupiter', 'Saturn'], c: 0 },
    { q: 'Wie viele Farben hat die deutsche Flagge?', a: ['3', '2', '4', '5'], c: 0 },
    { q: 'Was misst man mit einem Thermometer?', a: ['Temperatur', 'Gewicht', 'Länge', 'Zeit'], c: 0 },
    { q: 'Welches Organ pumpt Blut durch den Körper?', a: ['Herz', 'Lunge', 'Leber', 'Magen'], c: 0 },
    { q: 'Wie viele Zähne hat ein Erwachsener normalerweise?', a: ['32', '28', '30', '36'], c: 0 },
    { q: 'Welches Gas brauchen Menschen zum Atmen?', a: ['Sauerstoff', 'Kohlendioxid', 'Stickstoff', 'Helium'], c: 0 },
    { q: 'Wie viele Ecken hat ein Dreieck?', a: ['3', '4', '2', '5'], c: 0 },
    // --- Sport / Fußball ---
    { q: 'Wie viele Spieler stehen im Fußball pro Team auf dem Feld?', a: ['11', '10', '9', '12'], c: 0 },
    { q: 'Wie oft findet die Fußball-WM statt?', a: ['Alle 4 Jahre', 'Jedes Jahr', 'Alle 2 Jahre', 'Alle 5 Jahre'], c: 0 },
    { q: 'Welches Land gewann die Fußball-WM 2014?', a: ['Deutschland', 'Brasilien', 'Argentinien', 'Spanien'], c: 0 },
    { q: 'Wie lange dauert ein Fußballspiel regulär?', a: ['90 Minuten', '60 Minuten', '120 Minuten', '45 Minuten'], c: 0 },
    { q: 'Wie viele Ringe hat das olympische Symbol?', a: ['5', '4', '6', '3'], c: 0 },
    { q: 'In welcher Sportart gibt es einen "Homerun"?', a: ['Baseball', 'Basketball', 'Tennis', 'Golf'], c: 0 },
    { q: 'Wie viele Spieler hat ein Basketballteam auf dem Feld?', a: ['5', '6', '7', '4'], c: 0 },
    { q: 'Wer ist Fußball-Rekordweltmeister (meiste Titel)?', a: ['Brasilien', 'Deutschland', 'Italien', 'Argentinien'], c: 0 },
    // --- Games ---
    { q: 'In welchem Spiel baut man mit Blöcken eine eigene Welt?', a: ['Minecraft', 'Fortnite', 'Tetris', 'Pac-Man'], c: 0 },
    { q: 'Wie heißt der berühmte Klempner von Nintendo?', a: ['Mario', 'Sonic', 'Link', 'Kirby'], c: 0 },
    { q: 'Welche Farbe hat Sonic the Hedgehog?', a: ['Blau', 'Rot', 'Grün', 'Gelb'], c: 0 },
    { q: 'Wen sucht man in "Among Us"?', a: ['Den Betrüger', 'Den Schatz', 'Den Ausgang', 'Den Schlüssel'], c: 0 },
    { q: 'In welchem Spiel ordnet man fallende Blöcke an?', a: ['Tetris', 'Minecraft', 'Roblox', 'FIFA'], c: 0 },
    { q: 'Wie heißt Marios Bruder?', a: ['Luigi', 'Wario', 'Yoshi', 'Toad'], c: 0 },
    { q: 'Von welcher Firma stammt die PlayStation?', a: ['Sony', 'Microsoft', 'Nintendo', 'Sega'], c: 0 },
    { q: 'Welches Genre ist Fortnite?', a: ['Battle Royale', 'Rennspiel', 'Puzzle', 'Kartenspiel'], c: 0 },
    // --- Mathe / Logik ---
    { q: 'Was ist 7 × 8?', a: ['56', '54', '58', '64'], c: 0 },
    { q: 'Was ist 12 + 15?', a: ['27', '25', '28', '26'], c: 0 },
    { q: 'Was ist die Hälfte von 100?', a: ['50', '25', '75', '40'], c: 0 },
    { q: 'Was ist 9 × 9?', a: ['81', '72', '91', '99'], c: 0 },
    { q: 'Was kommt als Nächstes: 2, 4, 6, 8, …?', a: ['10', '9', '12', '11'], c: 0 },
    { q: 'Was ist 100 − 37?', a: ['63', '67', '73', '57'], c: 0 },
    { q: 'Was ist ein Viertel von 20?', a: ['5', '4', '10', '8'], c: 0 },
    // --- Musik ---
    { q: 'Wie viele Saiten hat eine normale Gitarre?', a: ['6', '4', '5', '7'], c: 0 },
    { q: 'Welches Instrument hat schwarze und weiße Tasten?', a: ['Klavier', 'Gitarre', 'Trompete', 'Geige'], c: 0 },
    { q: 'Wie nennt man eine große Gruppe klassischer Musiker?', a: ['Orchester', 'Chor', 'Band', 'Duett'], c: 0 },
    { q: 'Welches Instrument bläst man, um Töne zu erzeugen?', a: ['Trompete', 'Klavier', 'Geige', 'Harfe'], c: 0 }
  ];

  injectStyle();

  App.Minigames.quiz = {
    id: 'quiz', title: 'Quiz-Rausch', icon: '❓', order: 17,
    subtitle: 'Beantworte so viele Fragen wie möglich richtig',
    single: true, multi: true, minPlayers: 2, maxPlayers: 8,

    render: function (root, ctx) {
      var isMulti = ctx.mode === 'multi';
      var stops = [], timeouts = [], destroyed = false, onKey = null;
      function after(ms, fn) { var t = setTimeout(fn, ms); timeouts.push(t); return t; }
      function clearAll() {
        stops.forEach(function (f) { try { f(); } catch (e) {} }); stops = [];
        timeouts.forEach(clearTimeout); timeouts = [];
        if (onKey) { document.removeEventListener('keydown', onKey); onKey = null; }
      }
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
        var score = 0, combo = 0, maxCombo = 0;
        var asked = 0, correctCnt = 0;
        var deck = [], deckPos = 0;
        var current = null;         // { q, opts:[{text,correct}] }
        var shownAt = 0;            // Date.now() beim Anzeigen der Frage (Tempo)
        var locked = false, ended = false;

        function nextFromDeck() {
          if (deckPos >= deck.length) { deck = POOL.map(function (_, i) { return i; }); shuffle(deck); deckPos = 0; }
          return POOL[deck[deckPos++]];
        }

        /* ---- Kopf: Punkte · Combo · Timer ---- */
        var scoreEl = el('div', { class: 'quiz-score' }, ['0']);
        var comboEl = el('div', { class: 'quiz-combo' }, ['']);
        var timerEl = el('div', { class: 'quiz-timer mg-timer' }, ['⏱ ' + MG.mmss(DURATION)]);
        var head = el('div', { class: 'quiz-head glass' }, [
          el('div', { class: 'quiz-head-left' }, [el('span', { class: 'quiz-score-l' }, ['Punkte']), scoreEl]),
          comboEl,
          el('div', { class: 'quiz-head-right' }, [timerEl])
        ]);

        /* ---- Frage + Tempo-Balken ---- */
        var progressEl = el('div', { class: 'quiz-progress' }, ['Frage 1']);
        var questionEl = el('div', { class: 'quiz-question' }, ['…']);
        var tempoBar = el('div', { class: 'quiz-tempo-bar' });
        var tempoTrack = el('div', { class: 'quiz-tempo-track' }, [tempoBar]);
        var stage = el('div', { class: 'quiz-stage glass' }, [
          el('div', { class: 'quiz-stage-top' }, [progressEl, el('span', { class: 'quiz-tempo-l' }, ['⚡ Tempo'])]),
          questionEl, tempoTrack
        ]);

        /* ---- 4 Antwort-Buttons (2×2) ---- */
        var answerBtns = [];
        for (var i = 0; i < 4; i++) {
          var b = el('button', { class: 'quiz-ans', type: 'button' }, [
            el('span', { class: 'quiz-ans-key' }, [String(i + 1)]),
            el('span', { class: 'quiz-ans-txt' }, [''])
          ]);
          b.dataset.idx = String(i);
          b.addEventListener('click', function () { handleAnswer(Number(this.dataset.idx)); });
          answerBtns.push(b);
        }
        var answers = el('div', { class: 'quiz-answers' }, answerBtns);

        /* ---- Layout (+ Rangliste im Multi) ---- */
        var main = el('div', { class: 'quiz-main' }, [stage, answers]);
        var boardWrap = isMulti ? el('div', { class: 'quiz-board-wrap glass' }, [el('div', { class: 'mg-field-title' }, ['🏆 Rangliste'])]) : null;
        var layout = el('div', { class: 'quiz-layout' }, [
          head,
          isMulti ? el('div', { class: 'quiz-cols' }, [main, boardWrap]) : main
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
          timerEl.classList.toggle('quiz-urgent', left <= 10);
        }, finish, nowFn));

        /* ---- Tastatur 1–4 (Desktop-Komfort) ---- */
        onKey = function (e) {
          var idx = '1234'.indexOf(e.key);
          if (idx >= 0) { e.preventDefault(); handleAnswer(idx); }
        };
        document.addEventListener('keydown', onKey);

        nextQuestion();
        updateHud();

        /* ===================== ABLAUF ===================== */
        function nextQuestion() {
          if (destroyed || ended) return;
          locked = false;
          var q = nextFromDeck();
          var opts = q.a.map(function (t, i) { return { text: t, correct: i === q.c }; });
          shuffle(opts);
          current = { q: q.q, opts: opts };

          progressEl.textContent = 'Frage ' + (asked + 1) + ' · ' + correctCnt + ' richtig';
          questionEl.textContent = q.q;
          questionEl.classList.remove('quiz-pop'); void questionEl.offsetWidth; questionEl.classList.add('quiz-pop');

          answerBtns.forEach(function (btn, idx) {
            btn.classList.remove('correct', 'wrong');
            btn.disabled = false;
            btn.dataset.correct = opts[idx].correct ? '1' : '0';
            btn.querySelector('.quiz-ans-txt').textContent = opts[idx].text;
          });

          /* Tempo-Balken: von voll auf 0 über SPEED_WINDOW (zeigt sinkenden Bonus) */
          tempoBar.style.transition = 'none';
          tempoBar.style.width = '100%';
          void tempoBar.offsetWidth;
          tempoBar.style.transition = 'width ' + SPEED_WINDOW + 'ms linear';
          tempoBar.style.width = '0%';

          shownAt = Date.now();
        }

        function handleAnswer(idx) {
          if (locked || ended || destroyed || !current) return;
          var btn = answerBtns[idx];
          if (!btn) return;
          locked = true;
          asked++;
          answerBtns.forEach(function (x) { x.disabled = true; });
          tempoBar.style.transition = 'none';   // Balken einfrieren

          if (btn.dataset.correct === '1') {
            correctCnt++; combo++; if (combo > maxCombo) maxCombo = combo;
            var elapsed = Date.now() - shownAt;
            var speed = Math.max(0, Math.round(SPEED_MAX * (1 - elapsed / SPEED_WINDOW)));
            var comboBonus = Math.min(Math.max(0, combo - 1) * 2, COMBO_CAP);
            var gain = BASE_POINTS + speed + comboBonus;
            score += gain;
            btn.classList.add('correct');
            if (App.Audio) App.Audio.sfx('point');
            popFloat(btn, '+' + gain);
            updateHud();
            if (isMulti) ctx.room.reportScore(score);
            after(RIGHT_LOCK, nextQuestion);
          } else {
            combo = 0;
            btn.classList.add('wrong');
            if (App.Audio) App.Audio.sfx('error');
            answerBtns.forEach(function (x) { if (x.dataset.correct === '1') x.classList.add('correct'); });
            updateHud();
            if (isMulti) ctx.room.reportScore(score);
            after(WRONG_LOCK, nextQuestion);   // Sperre = Zeitverlust, richtige Lösung wird gezeigt
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
          var f = el('div', { class: 'quiz-float', text: txt });
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
            var best = App.Storage.get('best_quiz', 0);
            var nb = score > best;
            if (nb) App.Storage.set('best_quiz', score);
            var stats = correctCnt + ' von ' + asked + ' richtig · Top-Combo ×' + maxCombo;
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

  /* ============================ STYLE ============================ */
  function injectStyle() {
    UI.injectStyle('mg-quiz-css', [
      '.quiz-layout{display:flex;flex-direction:column;gap:14px;}',
      '.quiz-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 18px;flex-wrap:wrap;}',
      '.quiz-head-left{display:flex;flex-direction:column;}',
      '.quiz-score-l{font-size:11px;text-transform:uppercase;letter-spacing:1px;color:var(--muted);font-weight:800;}',
      '.quiz-score{font-size:clamp(24px,6vw,36px);font-weight:900;line-height:1;color:var(--gold);text-shadow:0 0 12px rgba(255,210,63,.45);font-variant-numeric:tabular-nums;}',
      '.quiz-combo{font-weight:900;color:var(--neon);font-size:15px;opacity:0;text-shadow:0 0 10px rgba(57,255,20,.6);}',
      '.quiz-combo.on{opacity:1;animation:quiz-combo-pop .3s ease;}',
      '@keyframes quiz-combo-pop{0%{transform:scale(.7)}60%{transform:scale(1.18)}100%{transform:scale(1)}}',
      '.quiz-timer{font-size:18px;}',
      '.quiz-timer.quiz-urgent{color:var(--danger);animation:quiz-blink 1s steps(2,start) infinite;}',
      '@keyframes quiz-blink{50%{opacity:.4}}',
      '.quiz-cols{display:grid;grid-template-columns:1fr;gap:14px;}',
      '@media(min-width:760px){.quiz-cols{grid-template-columns:1.7fr 1fr;align-items:start;}}',
      '.quiz-main{display:flex;flex-direction:column;gap:14px;}',
      '.quiz-stage{padding:22px 20px 18px;display:flex;flex-direction:column;gap:14px;overflow:hidden;}',
      '.quiz-stage-top{display:flex;align-items:center;justify-content:space-between;gap:10px;}',
      '.quiz-progress{font-size:12px;font-weight:800;color:var(--aqua-soft);letter-spacing:.5px;text-transform:uppercase;}',
      '.quiz-tempo-l{font-size:11px;font-weight:800;color:var(--muted);letter-spacing:1px;text-transform:uppercase;}',
      '.quiz-question{font-size:clamp(20px,5.2vw,32px);font-weight:900;line-height:1.22;color:var(--text);text-align:center;word-break:break-word;min-height:1.2em;}',
      '.quiz-question.quiz-pop{animation:quiz-qpop .24s ease;}',
      '@keyframes quiz-qpop{0%{transform:scale(.94);opacity:.25}100%{transform:scale(1);opacity:1}}',
      '.quiz-tempo-track{height:8px;border-radius:99px;background:rgba(9,32,21,.8);border:1px solid var(--stroke);overflow:hidden;}',
      '.quiz-tempo-bar{height:100%;width:100%;border-radius:99px;background:linear-gradient(90deg,var(--gold),var(--neon));box-shadow:0 0 12px rgba(57,255,20,.5);}',
      '.quiz-answers{display:grid;grid-template-columns:1fr 1fr;gap:12px;}',
      '.quiz-ans{position:relative;display:flex;align-items:center;gap:10px;font-family:inherit;font-size:clamp(15px,4vw,21px);font-weight:800;color:var(--text);cursor:pointer;text-align:left;',
      'min-height:clamp(64px,14vw,88px);padding:12px 14px;border-radius:16px;background:rgba(9,32,21,.75);border:1.5px solid var(--stroke-2);',
      'transition:transform .08s,box-shadow .15s,background .15s,border-color .15s;user-select:none;-webkit-user-select:none;touch-action:manipulation;}',
      '.quiz-ans-key{flex:none;display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;border-radius:8px;background:rgba(57,255,20,.12);border:1px solid var(--stroke-2);color:var(--aqua-soft);font-size:13px;font-weight:900;}',
      '.quiz-ans-txt{flex:1;line-height:1.15;}',
      '.quiz-ans:hover:not(:disabled){box-shadow:var(--glow-soft);transform:translateY(-2px);border-color:var(--neon);}',
      '.quiz-ans:active:not(:disabled){transform:scale(.97);}',
      '.quiz-ans:disabled{cursor:default;}',
      '.quiz-ans.correct{background:rgba(57,255,20,.22);border-color:var(--neon);color:var(--leaf);box-shadow:0 0 22px rgba(57,255,20,.55);animation:quiz-correct .3s ease;}',
      '.quiz-ans.correct .quiz-ans-key{background:var(--neon);color:#04160c;}',
      '@keyframes quiz-correct{0%{transform:scale(1)}40%{transform:scale(1.05)}100%{transform:scale(1)}}',
      '.quiz-ans.wrong{background:rgba(255,77,109,.22);border-color:var(--danger);color:#ffb3c1;animation:quiz-shake .32s ease;}',
      '.quiz-ans.wrong .quiz-ans-key{background:var(--danger);color:#fff;}',
      '@keyframes quiz-shake{0%,100%{transform:translateX(0)}20%{transform:translateX(-7px)}60%{transform:translateX(7px)}}',
      '.quiz-board-wrap{padding:16px;display:flex;flex-direction:column;gap:10px;}',
      '.quiz-float{position:fixed;pointer-events:none;z-index:85;font-weight:900;font-size:26px;color:var(--neon);text-shadow:0 2px 10px rgba(0,0,0,.6);transform:translate(-50%,0);transition:all .85s ease-out;opacity:1;}',
      '.quiz-float.go{transform:translate(-50%,-70px);opacity:0;}'
    ].join(''));
  }
})();
