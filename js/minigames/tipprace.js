/* tipprace.js — "Wort-Rausch": Schnell-Tipp-Rennen. In 60 Sekunden so viele
 * Wörter wie möglich fehlerfrei tippen. Angezeigtes Wort ins Feld tippen –
 * bei exakter Übereinstimmung (oder Leertaste/Enter) geht es sofort weiter.
 * Punkte = Wortlänge + Tempo-Bonus + Combo für fehlerfreies Tippen; falsche
 * Zeichen werden rot markiert. Schwierigkeit steigt mit der Zeit (längere
 * Wörter, später kurze Wortgruppen).
 * Parallel-Wettbewerb: alle tippen gleichzeitig, wer am meisten Punkte hat,
 * gewinnt. Singleplayer (Bestwert 'best_tipprace') + Multiplayer (Live-
 * Rangliste, synchroner Countdown/Timer über App.MG, Podest).
 * Touch: das Eingabefeld bekommt sofort Fokus (öffnet die Handy-Tastatur),
 * autocorrect/autocapitalize/spellcheck sind AUS; Tippen auf die Bühne fokussiert.
 * Timer/Countdown laufen über Wall-Clock (App.MG) -> Tab-Wechsel-sicher. */
(function () {
  'use strict';
  window.App = window.App || {}; App.Minigames = App.Minigames || {};
  var UI = App.UI, el = UI.el, MG = App.MG;

  var DURATION = 60;   // s Rundenzeit (fest)
  var WPM_WIN = 8000;  // ms Fenster für die gleitende WPM-Anzeige

  injectStyle();

  /* ---- Wortliste (Dschungel / Abenteuer / Alltag, gemischte Länge, Umlaute/ß) ---- */
  var WORDS = [
    'Aal', 'Ast', 'Baum', 'Blatt', 'Boot', 'Echse', 'Efeu', 'Erde', 'Farn', 'Frosch',
    'Gecko', 'Gras', 'Grün', 'Höhle', 'Käfer', 'Laub', 'Löwe', 'Moos', 'Nebel', 'Nest',
    'Otter', 'Palme', 'Pfad', 'Pilz', 'Ranke', 'Regen', 'Reh', 'Schatz', 'Tapir', 'Tiger',
    'Tukan', 'Vogel', 'Wald', 'Wurm', 'Zecke', 'Zelt', 'Zweig', 'heiß', 'weiß', 'mutig',
    'Ameise', 'Adler', 'Blüte', 'Brücke', 'Busch', 'Fackel', 'Feder', 'Fährte', 'Gefahr', 'Gorilla',
    'Insekt', 'Jaguar', 'Karte', 'Kompass', 'Kolibri', 'Leopard', 'Liane', 'Machete', 'Moskito', 'Nashorn',
    'Nektar', 'Ozelot', 'Panther', 'Papagei', 'Python', 'Rucksack', 'Ruine', 'Schlange', 'Schwarm', 'Specht',
    'Spinne', 'Storch', 'Sumpf', 'Tempel', 'Tümpel', 'Wolke', 'Wurzel', 'Wächter', 'beißen', 'leise',
    'Abenteuer', 'Bambuswald', 'Baumkrone', 'Chamäleon', 'Dschungel', 'Entdecker', 'Faultier', 'Feuchtigkeit', 'Freiheit', 'Fußspur',
    'Krokodil', 'Lagerfeuer', 'Regenwald', 'Schmetterling', 'Sonnenlicht', 'Urwald', 'Wasserfall', 'Farbenpracht', 'Baumstamm', 'Blätterdach'
  ];

  /* ---- Bausteine für Wortgruppen (Spätphase) ---- */
  var ADJ = ['wilder', 'grüner', 'tiefer', 'dunkler', 'alter', 'nasser', 'lauter', 'stiller', 'goldener', 'schneller'];
  var NOUN = ['Fluss', 'Wald', 'Baum', 'Pfad', 'Nebel', 'Sumpf', 'Berg', 'See', 'Tümpel', 'Dschungel'];

  /* Wörter nach reiner Buchstabenzahl in Schwierigkeits-Buckets sortieren. */
  var EASY = [], MID = [], HARD = [];
  WORDS.forEach(function (w) {
    var n = w.length;
    if (n <= 6) EASY.push(w);
    else if (n <= 10) MID.push(w);
    else HARD.push(w);
  });
  function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
  function makeGroup() { return pick(ADJ) + ' ' + pick(NOUN); }

  /* Wortwahl abhängig vom Rundenfortschritt frac (0..1). */
  function pickWord(frac) {
    var r = Math.random();
    if (frac < 0.22) return pick(EASY);
    if (frac < 0.45) return r < 0.6 ? pick(MID) : pick(EASY);
    if (frac < 0.68) return r < 0.5 ? pick(MID) : (r < 0.82 ? pick(HARD) : makeGroup());
    if (frac < 0.85) return r < 0.4 ? pick(HARD) : (r < 0.7 ? pick(MID) : makeGroup());
    return r < 0.55 ? makeGroup() : pick(HARD);
  }

  App.Minigames.tipprace = {
    id: 'tipprace', title: 'Wort-Rausch', icon: '⌨️', order: 14,
    subtitle: 'Tippe die Wörter, so schnell und fehlerfrei du kannst',
    single: true, multi: true, minPlayers: 2, maxPlayers: 8,

    render: function (root, ctx) {
      var isMulti = ctx.mode === 'multi';
      var stops = [], timeouts = [], floaters = [], destroyed = false;

      function after(ms, fn) { var t = setTimeout(fn, ms); timeouts.push(t); return t; }
      function addStop(fn) { if (fn) stops.push(fn); }
      function killFloaters() {
        floaters.forEach(function (n) { if (n && n.parentNode) n.parentNode.removeChild(n); });
        floaters = [];
      }
      function clearAll() {
        stops.forEach(function (f) { try { f(); } catch (e) {} }); stops = [];
        timeouts.forEach(clearTimeout); timeouts = [];
      }
      function cleanup() { destroyed = true; clearAll(); killFloaters(); }

      /* ---- Start: Multi mit synchronem Countdown, Single sofort ---- */
      if (isMulti) {
        var snap = ctx.room.snapshot() || {};
        var startAt = (snap.round && snap.round.startAt) || (ctx.room.now() + 3000);
        addStop(MG.countdown(root, startAt, function () { play(startAt); }, ctx.room.now));
      } else {
        play(Date.now());
      }
      return { cleanup: cleanup };

      /* ===================== RUNDE ===================== */
      function play(startAt) {
        if (destroyed) return;
        clearAll();
        var nowFn = isMulti ? ctx.room.now : null;
        var endAt = startAt + DURATION * 1000;

        /* ---- Zustand ---- */
        var score = 0, combo = 0, maxCombo = 0, wordsDone = 0, cleanRun = 0, maxClean = 0;
        var target = '', hadError = false, firstKeyAt = 0, prevLen = 0, ended = false;
        var charTimes = [];               // Zeitstempel korrekt getippter Zeichen (WPM)
        var roundStart = Date.now();

        /* ---- Kopf: Punkte · Combo · Timer ---- */
        var scoreEl = el('div', { class: 'tp-score' }, ['0']);
        var comboEl = el('div', { class: 'tp-combo' }, ['']);
        var timerEl = el('div', { class: 'tp-timer mg-timer' }, ['⏱ ' + MG.mmss(DURATION)]);
        var head = el('div', { class: 'tp-head glass' }, [
          el('div', { class: 'tp-head-left' }, [el('span', { class: 'tp-score-l' }, ['Punkte']), scoreEl]),
          comboEl,
          el('div', { class: 'tp-head-right' }, [timerEl])
        ]);

        /* ---- WPM-Tempo-Leiste ---- */
        var wpmNum = el('span', { class: 'tp-wpm-num' }, ['0']);
        var wpmFill = el('div', { class: 'tp-wpm-fill' });
        var wpmBox = el('div', { class: 'tp-wpm glass' }, [
          el('div', { class: 'tp-wpm-head' }, [
            el('span', { class: 'tp-wpm-lbl' }, ['⚡ Tempo']),
            el('span', {}, [wpmNum, el('span', { class: 'tp-wpm-unit' }, [' WPM'])])
          ]),
          el('div', { class: 'tp-wpm-track' }, [wpmFill])
        ]);

        /* ---- Bühne: großes Zielwort + Eingabefeld ---- */
        var wordEl = el('div', { class: 'tp-word' });
        var inputEl = el('input', {
          class: 'tp-input', type: 'text', inputmode: 'text',
          autocomplete: 'off', autocorrect: 'off', autocapitalize: 'none',
          spellcheck: 'false', autofocus: true, enterkeyhint: 'go',
          'aria-label': 'Tippfeld', placeholder: 'Hier tippen …'
        });
        var hintEl = el('div', { class: 'tp-hint hint-text' }, ['⌨️ Tippe das Wort oben ab']);
        var stage = el('div', { class: 'tp-stage glass' }, [wordEl, inputEl, hintEl]);

        /* ---- Layout (+ Rangliste im Multi) ---- */
        var main = el('div', { class: 'tp-main' }, [wpmBox, stage]);
        var boardWrap = isMulti ? el('div', { class: 'tp-board-wrap glass' }, [el('div', { class: 'mg-field-title' }, ['🏆 Rangliste'])]) : null;
        var layout = el('div', { class: 'tp-layout' }, [
          head,
          isMulti ? el('div', { class: 'tp-cols' }, [main, boardWrap]) : main
        ]);
        root.innerHTML = ''; root.appendChild(layout);

        /* ---- Live-Rangliste (multi) ---- */
        if (isMulti) {
          var board = MG.liveBoard(ctx.room, ctx.me.id);
          boardWrap.appendChild(board.root);
          addStop(board.stop);
          ctx.room.reportScore(0);
        }

        /* ---- Fokus / Handy-Tastatur öffnen ---- */
        function focusInput() { if (!ended && !destroyed) { try { inputEl.focus({ preventScroll: true }); } catch (e) { inputEl.focus(); } } }
        // Tippen irgendwo auf die Bühne holt den Fokus zurück (öffnet auf dem Handy die Tastatur per Geste).
        function onStageTap() { focusInput(); }
        layout.addEventListener('pointerdown', onStageTap);
        addStop(function () { layout.removeEventListener('pointerdown', onStageTap); });
        focusInput();
        after(60, focusInput);   // zweiter Versuch nach dem Render

        /* ---- Timer (Wall-Clock, im Multi synchron) ---- */
        addStop(MG.roundTimer(endAt, function (left) {
          var secs = Math.ceil(left);
          timerEl.textContent = '⏱ ' + MG.mmss(secs);
          timerEl.classList.toggle('tp-urgent', secs <= 10);
        }, finish, nowFn));

        /* ---- WPM-Anzeige (gleitender Schnitt, decayt bei Nichtstun) ---- */
        var wpmIv = setInterval(function () {
          var now = Date.now();
          var cut = now - WPM_WIN;
          while (charTimes.length && charTimes[0] < cut) charTimes.shift();
          var win = Math.min(WPM_WIN, now - roundStart) / 1000;
          var wpm = win > 0.3 ? (charTimes.length / 5) / (win / 60) : 0;
          wpm = Math.round(wpm);
          wpmNum.textContent = String(wpm);
          wpmFill.style.width = Math.min(100, wpm * 0.9) + '%';
          stage.classList.toggle('tp-hot', wpm >= 60);
          stage.classList.toggle('tp-fire', wpm >= 90);
        }, 200);
        addStop(function () { clearInterval(wpmIv); });

        /* ---- Eingabe-Logik ---- */
        function newWord() {
          if (ended || destroyed) return;
          var frac = Math.min(1, (Date.now() - roundStart) / (DURATION * 1000));
          var next = pickWord(frac);
          if (next === target) next = pickWord(frac);   // nicht zweimal dasselbe direkt hintereinander
          target = next;
          hadError = false; firstKeyAt = 0; prevLen = 0;
          inputEl.value = '';
          renderHighlight('');
          wordEl.classList.remove('tp-done'); void wordEl.offsetWidth; wordEl.classList.add('tp-enter');
          focusInput();
        }

        function renderHighlight(val) {
          var frag = document.createDocumentFragment();
          var prefixWrong = false;
          for (var i = 0; i < target.length; i++) {
            var ch = target[i];
            var span = el('span', { class: 'tp-ch' }, [ch === ' ' ? ' ' : ch]);
            if (i < val.length) {
              if (val[i] === ch) span.classList.add('ok');
              else { span.classList.add('err'); prefixWrong = true; hadError = true; }
            } else if (i === val.length) {
              span.classList.add('cur');
            }
            frag.appendChild(span);
          }
          if (val.length > target.length) { prefixWrong = true; hadError = true; }
          wordEl.innerHTML = '';
          wordEl.appendChild(frag);
          inputEl.classList.toggle('tp-bad', prefixWrong && val.length > 0);
        }

        function completeWord() {
          if (ended || destroyed) return;
          var chars = target.replace(/\s/g, '').length;
          var clean = !hadError;
          if (clean) { combo++; cleanRun++; if (cleanRun > maxClean) maxClean = cleanRun; }
          else { combo = 0; cleanRun = 0; }
          if (combo > maxCombo) maxCombo = combo;

          var secs = firstKeyAt ? Math.max(0.3, (Date.now() - firstKeyAt) / 1000) : 1;
          var cps = chars / secs;
          var base = chars * 8;
          var tempoBonus = Math.round(Math.min(cps, 12) * 4);
          var comboBonus = clean ? Math.min(combo, 15) * 4 : 0;
          var gain = base + tempoBonus + comboBonus;

          score += gain;
          wordsDone++;
          scoreEl.textContent = String(score);
          updateCombo();
          popFloat(wordEl, '+' + gain + (comboBonus ? ' 🔥' : ''));
          wordEl.classList.add('tp-done');
          if (isMulti) ctx.room.reportScore(score);
          newWord();
        }

        function onInput() {
          if (ended || destroyed) return;
          var val = inputEl.value;
          // Leertaste am Ende eines fertigen Wortes zählt als Bestätigung (auch für Gruppen).
          if (val === target + ' ') { val = target; inputEl.value = target; }
          // WPM: neu hinzugekommene, korrekte Zeichen protokollieren.
          if (val.length > prevLen && val === target.slice(0, val.length)) {
            var addN = val.length - prevLen, t = Date.now();
            for (var k = 0; k < addN; k++) charTimes.push(t);
            if (App.Audio) App.Audio.blip(860, 0.02, { type: 'square', peak: 0.025 });
          } else if (val.length > prevLen) {
            // neu getipptes Zeichen passt nicht -> Tippfehler
            if (App.Audio) App.Audio.sfx('error');
          }
          if (firstKeyAt === 0 && val.length > 0) firstKeyAt = Date.now();
          prevLen = val.length;
          renderHighlight(val);
          if (val === target) completeWord();
        }
        inputEl.addEventListener('input', onInput);
        addStop(function () { inputEl.removeEventListener('input', onInput); });

        function onKey(e) {
          if (e.key === 'Enter') {
            e.preventDefault();
            if (inputEl.value.trim() === target) completeWord();
            else { // nicht fertig -> kurzes Wackeln, keine Strafe
              stage.classList.remove('tp-shake'); void stage.offsetWidth; stage.classList.add('tp-shake');
            }
          }
        }
        inputEl.addEventListener('keydown', onKey);
        addStop(function () { inputEl.removeEventListener('keydown', onKey); });

        function updateCombo() {
          if (combo >= 2) {
            comboEl.textContent = '🔥 Combo ×' + combo;
            comboEl.classList.remove('on'); void comboEl.offsetWidth; comboEl.classList.add('on');
          } else {
            comboEl.textContent = '';
            comboEl.classList.remove('on');
          }
        }

        function popFloat(anchor, txt) {
          if (floaters.length > 16) return;
          var r = anchor.getBoundingClientRect();
          var f = el('div', { class: 'tp-float', text: txt });
          f.style.left = (r.left + r.width / 2 + (Math.random() * 40 - 20)) + 'px';
          f.style.top = (r.top + r.height * 0.3) + 'px';
          document.body.appendChild(f);
          floaters.push(f);
          requestAnimationFrame(function () { f.classList.add('go'); });
          after(820, function () {
            var i = floaters.indexOf(f); if (i >= 0) floaters.splice(i, 1);
            if (f.parentNode) f.parentNode.removeChild(f);
          });
        }

        /* Erstes Wort setzen */
        newWord();

        /* ---- Ende ---- */
        function finish() {
          if (ended || destroyed) return;
          ended = true;
          clearAll();
          try { inputEl.blur(); } catch (e) {}   // Handy-Tastatur schließen
          if (isMulti) {
            ctx.room.reportScore(score);
            after(1200, function () {
              if (destroyed) return;
              MG.endScreen(root, { players: ctx.room.players(), meId: ctx.me.id, onExit: ctx.onExit });
            });
          } else {
            var best = App.Storage.get('best_tipprace', 0);
            var nb = score > best;
            if (nb) App.Storage.set('best_tipprace', score);
            var stats = wordsDone + ' Wörter · Max-Combo ×' + maxCombo;
            MG.endScreen(root, {
              title: 'Zeit um! ⌨️',
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

  /* ============================ STYLES ============================ */
  function injectStyle() {
    UI.injectStyle('mg-tipprace-css', [
      '.tp-layout{display:flex;flex-direction:column;gap:14px;}',
      '.tp-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 18px;flex-wrap:wrap;}',
      '.tp-head-left{display:flex;flex-direction:column;}',
      '.tp-score-l{font-size:11px;text-transform:uppercase;letter-spacing:1px;color:var(--muted);}',
      '.tp-score{font-size:clamp(24px,6vw,36px);font-weight:900;line-height:1;color:var(--gold);text-shadow:0 0 12px rgba(255,210,63,.45);font-variant-numeric:tabular-nums;}',
      '.tp-combo{font-weight:900;color:var(--neon);font-size:15px;opacity:0;text-shadow:0 0 10px rgba(57,255,20,.6);}',
      '.tp-combo.on{opacity:1;animation:tp-combo-pop .3s ease;}',
      '@keyframes tp-combo-pop{0%{transform:scale(.7)}60%{transform:scale(1.18)}100%{transform:scale(1)}}',
      '.tp-timer{font-size:18px;}',
      '.tp-timer.tp-urgent{color:var(--danger);animation:tp-blink 1s steps(2,start) infinite;}',
      '@keyframes tp-blink{50%{opacity:.4}}',
      '.tp-cols{display:grid;grid-template-columns:1fr;gap:14px;}',
      '@media(min-width:760px){.tp-cols{grid-template-columns:1.7fr 1fr;align-items:start;}}',
      '.tp-main{display:flex;flex-direction:column;gap:14px;}',
      /* WPM-Leiste */
      '.tp-wpm{padding:12px 16px;display:flex;flex-direction:column;gap:7px;}',
      '.tp-wpm-head{display:flex;justify-content:space-between;align-items:baseline;font-size:13px;}',
      '.tp-wpm-lbl{color:var(--muted);font-weight:800;text-transform:uppercase;letter-spacing:1px;font-size:11px;}',
      '.tp-wpm-num{font-weight:900;color:var(--neon);font-size:18px;font-variant-numeric:tabular-nums;}',
      '.tp-wpm-unit{color:var(--muted);font-size:11px;font-weight:700;}',
      '.tp-wpm-track{height:9px;border-radius:999px;background:rgba(4,16,10,.8);border:1px solid var(--stroke);overflow:hidden;}',
      '.tp-wpm-fill{height:100%;width:0;border-radius:999px;background:linear-gradient(90deg,var(--aqua),var(--neon));box-shadow:0 0 10px rgba(57,255,20,.5);transition:width .18s ease;}',
      /* Bühne */
      '.tp-stage{padding:24px 18px;text-align:center;display:flex;flex-direction:column;align-items:center;gap:16px;overflow:hidden;transition:box-shadow .25s;}',
      '.tp-stage.tp-hot{box-shadow:0 0 30px rgba(57,255,20,.22),inset 0 0 40px rgba(57,255,20,.05);}',
      '.tp-stage.tp-fire{box-shadow:0 0 40px rgba(255,210,63,.32),inset 0 0 46px rgba(255,210,63,.07);}',
      '.tp-stage.tp-shake{animation:tp-shake .32s ease;}',
      '@keyframes tp-shake{0%,100%{transform:translateX(0)}20%{transform:translateX(-8px)}60%{transform:translateX(8px)}}',
      '.tp-word{font-size:clamp(30px,8.5vw,54px);font-weight:900;line-height:1.15;letter-spacing:1px;word-break:break-word;min-height:1.2em;font-family:inherit;}',
      '.tp-word.tp-enter{animation:tp-word-in .22s ease;}',
      '@keyframes tp-word-in{0%{transform:translateY(8px) scale(.96);opacity:.2}100%{transform:none;opacity:1}}',
      '.tp-word.tp-done{animation:tp-word-done .28s ease;}',
      '@keyframes tp-word-done{0%{transform:scale(1)}45%{transform:scale(1.06);filter:brightness(1.4)}100%{transform:scale(1)}}',
      '.tp-ch{color:var(--muted);transition:color .05s;position:relative;}',
      '.tp-ch.ok{color:var(--leaf);text-shadow:0 0 10px rgba(57,255,20,.45);}',
      '.tp-ch.err{color:var(--danger);text-shadow:0 0 10px rgba(255,77,109,.5);background:rgba(255,77,109,.14);border-radius:4px;}',
      '.tp-ch.cur{color:var(--text);border-bottom:3px solid var(--aqua);animation:tp-caret .9s steps(2,start) infinite;}',
      '@keyframes tp-caret{50%{border-color:transparent}}',
      /* Eingabefeld */
      '.tp-input{width:min(92%,520px);font-family:inherit;font-size:clamp(20px,5.5vw,28px);font-weight:800;text-align:center;',
      'color:var(--text);background:rgba(4,16,10,.72);border:2px solid var(--stroke-2);border-radius:14px;',
      'padding:12px 16px;outline:none;caret-color:var(--neon);transition:border-color .12s,box-shadow .12s;',
      '-webkit-tap-highlight-color:transparent;}',
      '.tp-input::placeholder{color:var(--muted);font-weight:600;}',
      '.tp-input:focus{border-color:var(--neon);box-shadow:0 0 0 3px rgba(57,255,20,.16),var(--glow-soft);}',
      '.tp-input.tp-bad{border-color:var(--danger);box-shadow:0 0 0 3px rgba(255,77,109,.18);}',
      '.tp-hint{margin-top:-4px;}',
      /* Rangliste */
      '.tp-board-wrap{padding:16px;display:flex;flex-direction:column;gap:10px;}',
      /* schwebende Punkte */
      '.tp-float{position:fixed;pointer-events:none;z-index:90;font-weight:900;font-size:24px;color:var(--neon);',
      'text-shadow:0 2px 10px rgba(0,0,0,.6);transform:translate(-50%,0);transition:transform .8s cubic-bezier(.2,.7,.3,1),opacity .8s ease-out;opacity:1;}',
      '.tp-float.go{transform:translate(-50%,-74px) scale(1.1);opacity:0;}'
    ].join(''));
  }
})();
