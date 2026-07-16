/* mastermind.js — "Code-Knacker": Mastermind als Rennen im Neon-Dschungel.
 *
 * SPIELIDEE
 *   Ein Geheimcode besteht aus 4 Positionen und 6 Neon-Farben (Farben duerfen
 *   sich wiederholen). Du legst eine Reihe und bekommst sofort die Auswertung:
 *     schwarzer Stift = richtige Farbe an der richtigen Stelle
 *     weisser Stift   = richtige Farbe, aber an der falschen Stelle
 *   Jeder Stein wird dabei nur EINMAL gezaehlt (siehe evaluate()).
 *   Pro Code hast du 10 Versuche. Geknackt -> sofort der naechste, schwerere
 *   Code; ab dem 3. Code hat er 5 Positionen. Insgesamt laeuft die Uhr 3 Minuten.
 *   Alle alten Reihen bleiben mit ihrer Auswertung sichtbar.
 *
 * STEUERUNG
 *   Farbe in der Palette antippen -> sie landet im aktiven Feld, das Feld rueckt
 *   weiter. Ein Feld antippen macht es aktiv (zum Ueberschreiben).
 *   Tastatur: 1-6 = Farbe, Pfeile = Feld wechseln, Backspace = loeschen,
 *   Enter = Reihe bestaetigen.
 *
 * PUNKTE  (pro geknacktem Code)
 *   1000 - 60 * benoetigte Versuche + Tempobonus
 *   Tempobonus = max(0, 500 - 10 * Sekunden fuer diesen Code)
 *   Nicht geknackt (10 Versuche verbraucht) = 0 Punkte, der Code wird
 *   aufgeloest und es geht mit dem naechsten weiter.
 *
 * SOLO   Jagd auf den eigenen Rekord — plus zwei echte Knacker-Bots in der
 *        Live-Rangliste (3 Schwierigkeitsstufen). Die Bots raten nicht dumm,
 *        sondern fuehren die Menge aller noch moeglichen Codes mit und waehlen
 *        daraus (Consistent-Guessing); je nach Stufe denken sie langsamer und
 *        verschenken auch mal einen Versuch. Sie knacken dieselben Codes wie du.
 *
 * MULTI  Alle knacken exakt dieselbe Code-Folge. Der Host verteilt per
 *        room.setShared({ mmSeed }) einen Startwert; daraus leitet jedes Geraet
 *        die Codes deterministisch ab (rngFrom/makeCode) — so muss waehrend des
 *        Rennens nichts synchronisiert werden, obwohl jeder unterschiedlich
 *        schnell vorankommt. Gemeldet wird nur der eigene Punktestand
 *        (room.reportScore) fuer die Live-Rangliste. Gestartet wird per
 *        Countdown auf snapshot().round.startAt mit room.now() als Uhr.
 *
 * Alle Timer laufen ueber Wall-Clock (Date.now bzw. room.now), nie ueber
 * Frame-Zaehlung -> Tab-Wechsel-sicher. cleanup() beendet wirklich alles. */
(function () {
  'use strict';
  window.App = window.App || {}; App.Minigames = App.Minigames || {};
  var UI = App.UI, el = UI.el;

  injectStyle();

  /* ===================== Konstanten ===================== */
  var NCOL = 6;                 // Anzahl Farben
  var MAX_TRIES = 10;           // Versuche pro Code
  var TOTAL_TIME = 180;         // s Gesamtzeit (3 Minuten)
  var BASE_POINTS = 1000;       // Grundpunkte pro geknacktem Code
  var TRY_COST = 60;            // Abzug pro benoetigtem Versuch
  var SPEED_BASE = 500;         // maximaler Tempobonus
  var SPEED_DECAY = 10;         // Bonus-Abzug pro Sekunde

  var COLOR_NAMES = ['Gruen', 'Aqua', 'Gold', 'Rot', 'Lila', 'Orange'];

  /* Schwierigkeitsstufen fuer die Solo-Bots.
   * think = mittlere Denkzeit pro Versuch in ms, err = Anteil verschenkter
   * (nicht deduzierter) Versuche. */
  var DIFFS = [
    { key: 'leicht', icon: '🌱', title: 'Leicht', sub: 'Gemuetliche Gegner, viel Luft nach oben', think: 13000, err: 0.35 },
    { key: 'normal', icon: '🌿', title: 'Normal', sub: 'Zwei ordentliche Knacker', think: 9000, err: 0.15 },
    { key: 'schwer', icon: '🔥', title: 'Schwer', sub: 'Profis mit voller Deduktion', think: 7000, err: 0.03 }
  ];
  var BOT_DEFS = [
    { icon: '🐍', name: 'Viper', pace: 0.92 },
    { icon: '🦜', name: 'Ara', pace: 1.1 }
  ];

  /* ===================== Reine Logik ===================== */

  /* Codelaenge: die ersten beiden Codes 4 Felder, ab dem 3. Code 5 Felder. */
  function lenForCode(idx) { return idx >= 2 ? 5 : 4; }

  /* Kleiner deterministischer Zufallsgenerator (LCG) — gleicher Seed =
   * gleiche Codes auf jedem Geraet. */
  function rngFrom(seed) {
    var s = (seed >>> 0) || 1;
    return function () {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
  }
  function randSeed() { return Math.floor(Math.random() * 2147483647) >>> 0; }

  /* Code Nr. idx aus dem Renn-Seed ableiten (ueberall identisch). */
  function makeCode(seed, idx) {
    var r = rngFrom((seed + idx * 7919 + 1) >>> 0);
    r(); r(); r();                              // Aufwaermen: benachbarte Seeds entkoppeln
    var len = lenForCode(idx), out = [], i;
    for (i = 0; i < len; i++) out.push(Math.floor(r() * NCOL) % NCOL);
    return out;
  }

  /* Auswertung: b = richtige Farbe an richtiger Stelle (schwarz),
   * w = richtige Farbe an falscher Stelle (weiss).
   * Exakte Treffer werden zuerst herausgenommen, der Rest ueber
   * min(Haeufigkeit im Code, Haeufigkeit im Tipp) -> jeder Stein zaehlt genau
   * einmal, auch bei Wiederholungen. */
  function evaluate(secret, guess) {
    var len = secret.length, i, black = 0, white = 0;
    var sc = [0, 0, 0, 0, 0, 0], gc = [0, 0, 0, 0, 0, 0];
    for (i = 0; i < len; i++) {
      if (guess[i] === secret[i]) black++;
      else { sc[secret[i]]++; gc[guess[i]]++; }
    }
    for (i = 0; i < NCOL; i++) white += Math.min(sc[i], gc[i]);
    return { b: black, w: white };
  }

  /* Punkte fuer einen geknackten Code. */
  function pointsFor(tries, ms) {
    var base = BASE_POINTS - TRY_COST * tries;
    var bonus = Math.max(0, SPEED_BASE - Math.floor(ms / 1000) * SPEED_DECAY);
    return { base: base, bonus: bonus, total: base + bonus };
  }

  /* Alle moeglichen Codes einer Laenge (Bot-Deduktion). Wird gecacht und nie
   * veraendert — filter() liefert immer neue Arrays. */
  var CODE_CACHE = {};
  function allCodes(len) {
    if (CODE_CACHE[len]) return CODE_CACHE[len];
    var out = [], total = Math.pow(NCOL, len), i, k, n, arr;
    for (i = 0; i < total; i++) {
      arr = []; n = i;
      for (k = 0; k < len; k++) { arr.push(n % NCOL); n = Math.floor(n / NCOL); }
      out.push(arr);
    }
    CODE_CACHE[len] = out;
    return out;
  }
  function randomCode(len) { var a = [], i; for (i = 0; i < len; i++) a.push(Math.floor(Math.random() * NCOL)); return a; }
  function opener(len) { return len === 5 ? [0, 0, 1, 1, 2] : [0, 0, 1, 1]; }
  function sameRes(a, b) { return a.b === b.b && a.w === b.w; }

  /* ===================== Registrierung ===================== */
  App.Minigames.mastermind = {
    id: 'mastermind', title: 'Code-Knacker', icon: '🧩', order: 128,
    subtitle: 'Knack den Geheimcode schneller als alle',
    single: true, multi: true, minPlayers: 2, maxPlayers: 8,

    render: function (root, ctx) {
      var isMulti = ctx.mode === 'multi';
      var nowFn = isMulti ? ctx.room.now : function () { return Date.now(); };

      var dead = false;
      var stops = [];              // stop()-Funktionen (App.MG-Bausteine, Listener, room.off)
      var pending = [];            // laufende setTimeout-IDs

      /* --- Renn-Zustand --- */
      var seed = 0, sharedSeed = null, seedLocked = false;
      var score = 0, codeIdx = 0, secret = null, cur = [], activeSlot = 0;
      var rows = [], codeStartAt = 0, locked = false, finished = false;
      var diff = DIFFS[1], bots = [];

      /* --- DOM-Referenzen --- */
      var scoreEl, codeEl, tryEl, timerEl, rowsEl, curRow, curPegs, curNumEl;
      var confirmBtn, delBtn, boardEl, boardHost, flashHost;

      function after(ms, fn) { var t = setTimeout(function () { if (!dead) fn(); }, ms); pending.push(t); return t; }
      function clearPending() { pending.forEach(clearTimeout); pending = []; }
      function stopHelpers() { stops.forEach(function (f) { try { f(); } catch (e) {} }); stops = []; }
      function cleanup() { dead = true; clearPending(); stopHelpers(); }

      /* ===================== Start ===================== */
      if (isMulti) {
        /* Host verteilt den Seed, alle anderen lesen ihn aus 'shared'. */
        var snap = ctx.room.snapshot() || {};
        if (snap.shared && typeof snap.shared.mmSeed === 'number') sharedSeed = snap.shared.mmSeed >>> 0;
        else if (ctx.room.isHost ? ctx.room.isHost() : !!ctx.isHost) {
          sharedSeed = randSeed();
          ctx.room.setShared({ mmSeed: sharedSeed });
        }
        var onShared = function (sh) {                 // feuert oft -> idempotent
          if (dead || seedLocked) return;
          if (sh && typeof sh.mmSeed === 'number') sharedSeed = sh.mmSeed >>> 0;
        };
        ctx.room.on('shared', onShared);
        stops.push(function () { ctx.room.off('shared', onShared); });

        var startAt = (snap.round && snap.round.startAt) || (ctx.room.now() + 3000);
        stops.push(App.MG.countdown(root, startAt, function () { play(startAt); }, ctx.room.now));
      } else {
        chooseDifficulty();
      }
      return { cleanup: cleanup };

      /* ===================== Solo: Stufenwahl ===================== */
      function chooseDifficulty() {
        clearPending(); stopHelpers();
        var best = App.Storage.get('best_mastermind', 0);
        var saved = App.Storage.get('mastermind_diff', 'normal');
        var tiles = DIFFS.map(function (d) {
          return el('button', {
            class: 'mmd-diff' + (d.key === saved ? ' is-sel' : ''), type: 'button',
            onclick: function () {
              if (App.Audio) App.Audio.sfx('select');
              App.Storage.set('mastermind_diff', d.key);
              diff = d;
              play(Date.now());
            }
          }, [
            el('span', { class: 'mmd-diff-i' }, [d.icon]),
            el('span', { class: 'mmd-diff-t' }, [d.title]),
            el('span', { class: 'mmd-diff-s' }, [d.sub])
          ]);
        });
        root.innerHTML = '';
        root.appendChild(el('div', { class: 'glass mmd-intro' }, [
          el('div', { class: 'mmd-intro-i' }, ['🧩']),
          el('h2', { class: 'neon' }, ['Code-Knacker']),
          el('p', { class: 'hint-text' }, ['Knack in 3 Minuten so viele Geheimcodes wie moeglich — 4 Felder, 6 Farben, 10 Versuche pro Code. Ab dem 3. Code wird es auf 5 Felder verlaengert.']),
          el('div', { class: 'mmd-diffs' }, tiles),
          el('p', { class: 'hint-text' }, ['Dein Rekord: ', el('b', { class: 'mmd-rec' }, [App.MG.fmt(best)]), ' Punkte']),
          el('div', { class: 'controls-row' }, [
            el('button', { class: 'btn btn-ghost', type: 'button', onclick: ctx.onExit }, ['Zurueck'])
          ])
        ]));
      }

      /* ===================== Spiel ===================== */
      function play(startAt) {
        clearPending();
        /* Nur die Spiel-Helfer stoppen — im Multi bleibt der 'shared'-Listener
         * ueber stops erhalten, deshalb hier nichts pauschal abraeumen. */
        score = 0; codeIdx = 0; rows = []; locked = false; finished = false;
        seed = (sharedSeed !== null) ? sharedSeed : (Math.floor(startAt / 1000) >>> 0);
        seedLocked = true;

        var endAt = startAt + TOTAL_TIME * 1000;

        /* --- Kopfzeile --- */
        scoreEl = el('div', { class: 'mmd-hv mmd-hv-score' }, ['0']);
        codeEl = el('div', { class: 'mmd-hv' }, ['1']);
        tryEl = el('div', { class: 'mmd-hv' }, ['0/10']);
        timerEl = el('div', { class: 'mg-timer' }, [App.MG.mmss(TOTAL_TIME)]);
        var head = el('div', { class: 'mmd-head glass' }, [
          el('div', { class: 'mmd-hc' }, [el('span', { class: 'mmd-hl' }, ['Punkte']), scoreEl]),
          el('div', { class: 'mmd-hc' }, [el('span', { class: 'mmd-hl' }, ['Code']), codeEl]),
          el('div', { class: 'mmd-hc' }, [el('span', { class: 'mmd-hl' }, ['Versuch']), tryEl]),
          el('div', { class: 'mmd-hc mmd-hc-r' }, [el('span', { class: 'mmd-hl' }, ['Zeit']), timerEl])
        ]);

        /* --- Regel-/Legendenzeile --- */
        var legend = el('div', { class: 'mmd-legend hint-text' }, [
          el('span', { class: 'mmd-lg' }, [el('i', { class: 'mmd-dot mmd-dot-b' }), 'richtige Farbe, richtige Stelle']),
          el('span', { class: 'mmd-lg' }, [el('i', { class: 'mmd-dot mmd-dot-w' }), 'Farbe richtig, Stelle falsch']),
          el('span', { class: 'mmd-lg' }, ['Farbe tippen → Reihe fuellen → Bestaetigen · Tasten 1–6, ⌫, Enter'])
        ]);

        /* --- Brett --- */
        rowsEl = el('div', { class: 'mmd-rows' });
        curPegs = el('div', { class: 'mmd-pegs' });
        curNumEl = el('div', { class: 'mmd-rnum' }, ['1']);
        curRow = el('div', { class: 'mmd-row mmd-row-cur' }, [
          curNumEl, curPegs, el('div', { class: 'mmd-res mmd-res-q' }, ['?'])
        ]);
        flashHost = el('div', { class: 'mmd-flash-host' });
        boardHost = el('div', { class: 'mmd-boardcol glass' }, [
          el('div', { class: 'mg-field-title' }, ['🔒 Geheimcode']),
          rowsEl, curRow, flashHost, palette(), actions()
        ]);

        /* --- Rangliste --- */
        var side;
        if (isMulti) {
          var lb = App.MG.liveBoard(ctx.room, ctx.me.id);
          stops.push(lb.stop);
          boardEl = lb.root;
          side = el('div', { class: 'mmd-side glass' }, [
            el('div', { class: 'mg-field-title' }, ['🏆 Rangliste']), boardEl
          ]);
        } else {
          boardEl = el('div', { class: 'mg-scoreboard' });
          side = el('div', { class: 'mmd-side glass' }, [
            el('div', { class: 'mg-field-title' }, ['🏆 Rangliste']), boardEl,
            el('p', { class: 'hint-text mmd-side-hint' }, ['Stufe: ' + diff.icon + ' ' + diff.title + ' · Rekord: ' + App.MG.fmt(App.Storage.get('best_mastermind', 0))])
          ]);
        }

        root.innerHTML = '';
        root.appendChild(el('div', { class: 'mmd-wrap' }, [
          head, legend, el('div', { class: 'mmd-main' }, [boardHost, side])
        ]));

        /* --- Tastatur --- */
        var keyHandler = function (e) {
          if (dead || finished) return;
          var k = e.key;
          if (k >= '1' && k <= '6') { e.preventDefault(); setColor(parseInt(k, 10) - 1); }
          else if (k === 'Backspace' || k === 'Delete') { e.preventDefault(); delColor(); }
          else if (k === 'Enter') { e.preventDefault(); confirmRow(); }
          else if (k === 'ArrowLeft') { e.preventDefault(); moveSlot(-1); }
          else if (k === 'ArrowRight') { e.preventDefault(); moveSlot(1); }
        };
        document.addEventListener('keydown', keyHandler);
        stops.push(function () { document.removeEventListener('keydown', keyHandler); });

        /* --- Bots (nur Solo) --- */
        bots = [];
        if (!isMulti) {
          BOT_DEFS.forEach(function (bd) {
            var bot = { icon: bd.icon, name: bd.name, pace: bd.pace, score: 0, codeIdx: 0, tries: 0, nextAt: 0, secret: null, cands: null, codeStart: 0 };
            botNewCode(bot, startAt);
            bots.push(bot);
          });
          var botT = setInterval(function () {
            if (dead || finished) return;
            var now = Date.now(), guard = 0, changed = false;
            bots.forEach(function (bot) {
              /* Wall-Clock-getrieben: nach einem Tab-Wechsel wird aufgeholt. */
              while (now >= bot.nextAt && guard++ < 60) { botStep(bot, now); changed = true; }
            });
            if (changed) renderBoard();
          }, 150);
          stops.push(function () { clearInterval(botT); });
        }

        /* --- Rundentimer (Wall-Clock) --- */
        stops.push(App.MG.roundTimer(endAt, function (left) {
          timerEl.textContent = App.MG.mmss(left);
          if (left <= 15) timerEl.classList.add('mmd-urgent');
        }, finish, isMulti ? ctx.room.now : null));

        if (isMulti) ctx.room.reportScore(0);
        newCode();
        renderBoard();
      }

      /* --- Palette + Aktionen --- */
      function palette() {
        var btns = [], i;
        for (i = 0; i < NCOL; i++) {
          (function (c) {
            btns.push(el('button', {
              class: 'mmd-pal mmd-c' + (c + 1), type: 'button', title: COLOR_NAMES[c],
              onclick: function () { setColor(c); }
            }, [
              el('span', { class: 'mmd-peg mmd-filled' }, [String(c + 1)]),
              el('span', { class: 'mmd-pal-l' }, [COLOR_NAMES[c]])
            ]));
          })(i);
        }
        return el('div', { class: 'mmd-palette' }, btns);
      }
      function actions() {
        delBtn = el('button', { class: 'btn btn-ghost', type: 'button', onclick: delColor }, ['⌫ Loeschen']);
        confirmBtn = el('button', { class: 'btn btn-primary', type: 'button', onclick: confirmRow }, ['✅ Bestaetigen']);
        return el('div', { class: 'controls-row mmd-actions' }, [delBtn, confirmBtn]);
      }

      /* --- Neuer Code --- */
      function newCode() {
        if (dead || finished) return;
        secret = makeCode(seed, codeIdx);
        rows = [];
        cur = []; for (var i = 0; i < secret.length; i++) cur.push(-1);
        activeSlot = 0;
        codeStartAt = nowFn();
        locked = false;
        rowsEl.innerHTML = '';
        codeEl.textContent = String(codeIdx + 1);
        codeEl.classList.remove('mmd-bump'); void codeEl.offsetWidth; codeEl.classList.add('mmd-bump');
        buildCurRow();
        paintCur();
        curRow.classList.remove('mmd-row-new'); void curRow.offsetWidth; curRow.classList.add('mmd-row-new');
      }

      function buildCurRow() {
        curPegs.innerHTML = '';
        for (var i = 0; i < secret.length; i++) {
          (function (idx) {
            curPegs.appendChild(el('button', {
              class: 'mmd-peg mmd-slot', type: 'button', 'aria-label': 'Feld ' + (idx + 1),
              onclick: function () {
                if (locked || finished) return;
                activeSlot = idx;
                if (App.Audio) App.Audio.sfx('click');
                paintCur();
              }
            }));
          })(i);
        }
      }

      /* --- Eingabe --- */
      function setColor(c) {
        if (dead || locked || finished || !secret) return;
        cur[activeSlot] = c;
        var peg = curPegs.children[activeSlot];
        if (peg) { peg.classList.remove('mmd-pop'); void peg.offsetWidth; peg.classList.add('mmd-pop'); }
        if (App.Audio) App.Audio.blip(420 + c * 70, 0.07, { type: 'triangle', peak: 0.07 });
        var next = nextEmpty(activeSlot + 1);
        activeSlot = next >= 0 ? next : Math.min(activeSlot + 1, cur.length - 1);
        paintCur();
      }
      function nextEmpty(from) {
        var i;
        for (i = from; i < cur.length; i++) if (cur[i] < 0) return i;
        for (i = 0; i < from && i < cur.length; i++) if (cur[i] < 0) return i;
        return -1;
      }
      function delColor() {
        if (dead || locked || finished || !secret) return;
        var i = activeSlot;
        if (cur[i] < 0) { while (i > 0 && cur[i] < 0) i--; }
        if (cur[i] < 0) { if (App.Audio) App.Audio.sfx('error'); return; }
        cur[i] = -1; activeSlot = i;
        if (App.Audio) App.Audio.sfx('click');
        paintCur();
      }
      function moveSlot(d) {
        if (dead || locked || finished || !secret) return;
        activeSlot = (activeSlot + d + cur.length) % cur.length;
        paintCur();
      }
      function paintCur() {
        curNumEl.textContent = String(rows.length + 1);
        var full = true, i;
        for (i = 0; i < cur.length; i++) {
          var peg = curPegs.children[i]; if (!peg) continue;
          var c = cur[i];
          peg.className = 'mmd-peg mmd-slot' + (c >= 0 ? ' mmd-filled mmd-c' + (c + 1) : '') + (i === activeSlot && !locked ? ' is-active' : '');
          peg.textContent = c >= 0 ? String(c + 1) : '';
          if (c < 0) full = false;
        }
        confirmBtn.classList.toggle('mmd-off', !full || locked);
        tryEl.textContent = rows.length + '/' + MAX_TRIES;
      }

      /* --- Reihe bestaetigen --- */
      function confirmRow() {
        if (dead || locked || finished || !secret) return;
        var i;
        for (i = 0; i < cur.length; i++) {
          if (cur[i] < 0) {
            curRow.classList.remove('mmd-shake'); void curRow.offsetWidth; curRow.classList.add('mmd-shake');
            if (App.Audio) App.Audio.sfx('error');
            activeSlot = nextEmpty(0); paintCur();
            return;
          }
        }
        var guess = cur.slice();
        var res = evaluate(secret, guess);
        rows.push({ guess: guess, res: res });
        var won = res.b === secret.length;
        rowsEl.appendChild(doneRow(guess, res, rows.length, won));
        rowsEl.scrollTop = rowsEl.scrollHeight;
        if (App.Audio) App.Audio.sfx(res.b > 0 ? 'ding' : 'pop');

        if (won) return cracked();
        if (rows.length >= MAX_TRIES) return failedCode();

        cur = []; for (i = 0; i < secret.length; i++) cur.push(-1);
        activeSlot = 0;
        paintCur();
      }

      function doneRow(guess, res, num, won) {
        var pegs = guess.map(function (c) {
          return el('div', { class: 'mmd-peg mmd-filled mmd-c' + (c + 1) }, [String(c + 1)]);
        });
        return el('div', { class: 'mmd-row mmd-row-done' + (won ? ' mmd-row-win' : '') }, [
          el('div', { class: 'mmd-rnum' }, [String(num)]),
          el('div', { class: 'mmd-pegs' }, pegs),
          resEl(res, guess.length)
        ]);
      }
      function resEl(res, len) {
        var dots = [], i;
        for (i = 0; i < len; i++) {
          var cls = i < res.b ? 'mmd-dot mmd-dot-b' : (i < res.b + res.w ? 'mmd-dot mmd-dot-w' : 'mmd-dot');
          dots.push(el('i', { class: cls + ' mmd-dot-in', style: 'animation-delay:' + (i * 70) + 'ms' }));
        }
        return el('div', { class: 'mmd-res mmd-res-' + len }, dots);
      }

      /* --- Code geknackt --- */
      function cracked() {
        locked = true;
        var p = pointsFor(rows.length, nowFn() - codeStartAt);
        score += p.total;
        scoreEl.textContent = App.MG.fmt(score);
        scoreEl.classList.remove('mmd-bump'); void scoreEl.offsetWidth; scoreEl.classList.add('mmd-bump');
        if (isMulti) ctx.room.reportScore(score);
        else renderBoard();
        if (App.Audio) { App.Audio.sfx('levelup'); App.Audio.sweep(520, 1180, 0.3); }
        flash('win', '🎉 Geknackt! +' + p.total,
          '1000 − ' + rows.length + '×60 Versuche' + (p.bonus > 0 ? ' + ' + p.bonus + ' Tempo' : ' · kein Tempobonus'));
        paintCur();
        codeIdx++;
        after(1500, function () { if (!finished) { newCode(); } });
      }

      /* --- Code nicht geknackt --- */
      function failedCode() {
        locked = true;
        if (App.Audio) App.Audio.sfx('lose');
        var sol = secret.map(function (c) {
          return el('div', { class: 'mmd-peg mmd-filled mmd-c' + (c + 1) }, [String(c + 1)]);
        });
        rowsEl.appendChild(el('div', { class: 'mmd-row mmd-row-sol' }, [
          el('div', { class: 'mmd-rnum' }, ['🔓']),
          el('div', { class: 'mmd-pegs' }, sol),
          el('div', { class: 'mmd-res mmd-res-q' }, ['!'])
        ]));
        rowsEl.scrollTop = rowsEl.scrollHeight;
        flash('lose', '💥 10 Versuche weg', 'Das war der Code — nächster kommt!');
        paintCur();
        codeIdx++;
        after(2300, function () { if (!finished) { newCode(); } });
      }

      /* --- Einblendung ueber dem Brett --- */
      function flash(kind, title, sub) {
        if (!flashHost) return;
        var node = el('div', { class: 'mmd-flash mmd-flash-' + kind }, [
          el('div', { class: 'mmd-flash-t' }, [title]),
          el('div', { class: 'mmd-flash-s' }, [sub])
        ]);
        flashHost.innerHTML = '';
        flashHost.appendChild(node);
        after(2100, function () { if (node.parentNode) node.parentNode.removeChild(node); });
      }

      /* ===================== Solo-Rangliste ===================== */
      function renderBoard() {
        if (isMulti || !boardEl) return;                 // Multi macht App.MG.liveBoard
        var list = [{ name: 'Du', score: score, code: codeIdx + 1, me: true }];
        bots.forEach(function (b) { list.push({ name: b.icon + ' ' + b.name, score: b.score, code: b.codeIdx + 1, me: false }); });
        list.sort(function (a, b) { return b.score - a.score; });
        boardEl.innerHTML = '';
        list.forEach(function (p, i) {
          boardEl.appendChild(el('div', { class: 'mg-sb-row p' + (i + 1) + (p.me ? ' me' : '') }, [
            el('span', { class: 'mg-sb-rank' }, [String(i + 1)]),
            el('span', { class: 'mg-sb-name' }, [p.name + ' · Code ' + p.code]),
            el('span', { class: 'mg-sb-score' }, [App.MG.fmt(p.score)])
          ]));
        });
      }

      /* ===================== Bot-KI ===================== */
      function botNewCode(bot, now) {
        bot.secret = makeCode(seed, bot.codeIdx);
        bot.cands = allCodes(bot.secret.length);
        bot.tries = 0;
        bot.codeStart = now;
        bot.nextAt = now + botDelay(bot);
      }
      function botDelay(bot) {
        return diff.think * bot.pace * (0.75 + Math.random() * 0.6);
      }
      function botStep(bot, now) {
        var len = bot.secret.length, guess;
        if (bot.tries === 0) guess = opener(len);
        else if (Math.random() < diff.err || !bot.cands.length) guess = randomCode(len);   // verschenkter Versuch
        else guess = bot.cands[Math.floor(Math.random() * bot.cands.length)];              // konsistenter Tipp
        bot.tries++;
        var r = evaluate(bot.secret, guess);
        /* Nur noch Codes behalten, die zu dieser Antwort passen. */
        bot.cands = bot.cands.filter(function (c) { return sameRes(evaluate(c, guess), r); });
        if (r.b === len) {
          bot.score += pointsFor(bot.tries, now - bot.codeStart).total;
          bot.codeIdx++;
          botNewCode(bot, now);
        } else if (bot.tries >= MAX_TRIES) {
          bot.codeIdx++;
          botNewCode(bot, now);
        } else {
          bot.nextAt = now + botDelay(bot);
        }
      }

      /* ===================== Ende ===================== */
      function finish() {
        if (finished || dead) return;
        finished = true;
        locked = true;
        clearPending();
        stopHelpers();
        if (App.Audio) App.Audio.sfx('whoosh');

        if (isMulti) {
          ctx.room.reportScore(score);
          after(900, function () {
            App.MG.endScreen(root, { players: ctx.room.players(), meId: ctx.me.id, onExit: ctx.onExit });
          });
        } else {
          var best = App.Storage.get('best_mastermind', 0);
          var nb = score > best;
          if (nb) App.Storage.set('best_mastermind', score);
          var beat = bots.filter(function (b) { return b.score < score; }).length;
          after(600, function () {
            App.MG.endScreen(root, {
              score: score, best: best, newBest: nb,
              label: 'Knacker-Punkte · ' + beat + '/' + bots.length + ' Bots geschlagen'
                + (nb ? ' · neuer Rekord! 🎉' : ' · Bestwert: ' + App.MG.fmt(best)),
              onExit: ctx.onExit,
              onAgain: function () { finished = false; chooseDifficulty(); }
            });
          });
        }
      }
    }
  };

  /* ===================== Styles ===================== */
  function injectStyle() {
    UI.injectStyle('mg-mastermind-css', [
      '.mmd-wrap{display:flex;flex-direction:column;gap:12px;}',
      /* Farbtoene */
      '.mmd-c1{--pc:#39ff14;--pc2:#0d5a06;}',
      '.mmd-c2{--pc:#33e6d0;--pc2:#0a4d46;}',
      '.mmd-c3{--pc:#ffd23f;--pc2:#6b4e00;}',
      '.mmd-c4{--pc:#ff4d6d;--pc2:#6b0a1c;}',
      '.mmd-c5{--pc:#b06dff;--pc2:#360d6b;}',
      '.mmd-c6{--pc:#ff9d3c;--pc2:#6b3600;}',
      /* Kopf */
      '.mmd-head{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:10px 16px;flex-wrap:wrap;}',
      '.mmd-hc{display:flex;flex-direction:column;gap:1px;min-width:0;}',
      '.mmd-hc-r{text-align:right;margin-left:auto;}',
      '.mmd-hl{color:var(--muted);font-size:10px;text-transform:uppercase;letter-spacing:1px;}',
      '.mmd-hv{font-size:clamp(17px,4.4vw,26px);font-weight:900;color:var(--leaf);line-height:1.1;font-variant-numeric:tabular-nums;}',
      '.mmd-hv-score{color:var(--gold);text-shadow:0 0 12px rgba(255,210,63,.45);}',
      '.mmd-head .mg-timer{font-size:clamp(17px,4.4vw,26px);}',
      '.mg-timer.mmd-urgent{color:var(--danger);animation:mmd-pulse .7s infinite;}',
      '.mmd-bump{animation:mmd-bump .32s ease;}',
      /* Legende */
      '.mmd-legend{display:flex;flex-wrap:wrap;gap:6px 16px;margin:0;align-items:center;font-size:11.5px;line-height:1.5;}',
      '.mmd-lg{display:inline-flex;align-items:center;gap:6px;}',
      /* Layout */
      '.mmd-main{display:grid;grid-template-columns:1fr;gap:12px;align-items:start;}',
      '@media(min-width:760px){.mmd-main{grid-template-columns:minmax(0,1fr) minmax(190px,250px);}}',
      '.mmd-boardcol{position:relative;padding:14px;display:flex;flex-direction:column;gap:8px;overflow:hidden;}',
      '.mmd-side{padding:14px;display:flex;flex-direction:column;gap:8px;}',
      '.mmd-side .mg-scoreboard{max-height:280px;overflow-y:auto;}',
      '.mmd-side-hint{margin:0;font-size:11px;}',
      /* Reihen */
      '.mmd-rows{display:flex;flex-direction:column;gap:5px;max-height:min(42vh,360px);overflow-y:auto;padding-right:2px;}',
      '.mmd-row{display:flex;align-items:center;gap:8px;padding:4px 6px;border-radius:12px;border:1px solid transparent;}',
      '.mmd-row-done{background:rgba(4,16,10,.5);border-color:var(--stroke);animation:mmd-row-in .26s cubic-bezier(.2,.8,.3,1) both;}',
      '.mmd-row-win{border-color:var(--neon);box-shadow:0 0 18px rgba(57,255,20,.4);background:rgba(13,63,38,.6);animation:mmd-row-in .26s cubic-bezier(.2,.8,.3,1) both,mmd-glow 1.1s ease-in-out 2;}',
      '.mmd-row-sol{border-color:var(--danger);background:rgba(74,10,26,.5);animation:mmd-row-in .26s ease both;}',
      '.mmd-row-cur{background:rgba(4,16,10,.72);border-color:var(--stroke-2);box-shadow:inset 0 0 24px rgba(57,255,20,.09);}',
      '.mmd-row-new{animation:mmd-new .4s cubic-bezier(.2,.8,.3,1);}',
      '.mmd-shake{animation:mmd-shake .3s ease;}',
      '.mmd-rnum{width:20px;flex:0 0 20px;text-align:center;font-size:11px;font-weight:800;color:var(--muted);font-variant-numeric:tabular-nums;}',
      '.mmd-pegs{display:flex;gap:5px;flex:1;min-width:0;}',
      /* Steine */
      '.mmd-peg{width:clamp(26px,7.2vw,36px);height:clamp(26px,7.2vw,36px);flex:0 0 auto;border-radius:50%;',
      'border:1px solid var(--stroke);background:rgba(2,10,6,.7);display:flex;align-items:center;justify-content:center;',
      'font-family:inherit;font-size:10px;font-weight:900;color:transparent;padding:0;',
      '-webkit-tap-highlight-color:transparent;touch-action:manipulation;transition:transform .12s,box-shadow .15s,border-color .15s;}',
      '.mmd-slot{cursor:pointer;}',
      '.mmd-slot.is-active{border-color:var(--neon);box-shadow:0 0 0 2px rgba(57,255,20,.35),0 0 14px rgba(57,255,20,.5);}',
      '.mmd-peg.mmd-filled{background:radial-gradient(circle at 34% 28%,rgba(255,255,255,.6),var(--pc) 58%,var(--pc2));',
      'border-color:var(--pc);box-shadow:0 0 9px var(--pc),inset 0 -3px 7px rgba(0,0,0,.45);color:rgba(0,0,0,.55);}',
      '.mmd-pop{animation:mmd-pop .24s cubic-bezier(.2,1.4,.4,1);}',
      /* Auswertungs-Stifte */
      '.mmd-res{display:grid;gap:3px;flex:0 0 auto;align-content:center;justify-content:center;min-width:26px;}',
      '.mmd-res-4{grid-template-columns:repeat(2,9px);}',
      '.mmd-res-5{grid-template-columns:repeat(3,9px);}',
      '.mmd-dot{width:9px;height:9px;border-radius:50%;background:rgba(255,255,255,.07);border:1px solid var(--stroke);display:block;}',
      '.mmd-dot-b{background:radial-gradient(circle at 35% 30%,#d8ffcb,var(--neon) 70%);border-color:#eaffe2;box-shadow:0 0 7px var(--neon);}',
      '.mmd-dot-w{background:radial-gradient(circle at 35% 30%,#fff,var(--silver) 70%);border-color:#fff;box-shadow:0 0 6px rgba(207,228,220,.75);}',
      '.mmd-dot-in{animation:mmd-dot-in .3s cubic-bezier(.2,1.4,.4,1) both;}',
      '.mmd-res-q{display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:900;color:var(--muted);min-width:26px;}',
      /* Palette */
      '.mmd-palette{display:grid;grid-template-columns:repeat(6,1fr);gap:6px;margin-top:2px;}',
      '@media(max-width:420px){.mmd-palette{grid-template-columns:repeat(3,1fr);}}',
      '.mmd-pal{display:flex;flex-direction:column;align-items:center;gap:3px;padding:7px 2px;border-radius:12px;',
      'border:1px solid var(--stroke);background:rgba(4,16,10,.55);cursor:pointer;font-family:inherit;',
      '-webkit-tap-highlight-color:transparent;touch-action:manipulation;transition:transform .1s,border-color .15s,background .15s;}',
      '.mmd-pal:hover{border-color:var(--pc);background:rgba(4,16,10,.85);}',
      '.mmd-pal:active{transform:scale(.93);}',
      '.mmd-pal-l{font-size:9px;font-weight:700;color:var(--muted);letter-spacing:.4px;}',
      '.mmd-actions{margin-top:2px;}',
      '.mmd-off{opacity:.4;pointer-events:none;filter:grayscale(.6);}',
      /* Einblendung */
      '.mmd-flash-host{position:absolute;left:0;right:0;top:44%;display:flex;justify-content:center;pointer-events:none;z-index:3;}',
      '.mmd-flash{padding:10px 18px;border-radius:14px;text-align:center;animation:mmd-flash .4s cubic-bezier(.2,.9,.3,1) both;',
      'background:rgba(2,10,6,.94);backdrop-filter:blur(3px);}',
      '.mmd-flash-win{border:1px solid var(--neon);box-shadow:0 0 30px rgba(57,255,20,.5);}',
      '.mmd-flash-lose{border:1px solid var(--danger);box-shadow:0 0 30px rgba(255,77,109,.45);}',
      '.mmd-flash-t{font-size:clamp(17px,4.6vw,25px);font-weight:900;line-height:1.15;}',
      '.mmd-flash-win .mmd-flash-t{color:var(--neon);text-shadow:0 0 16px rgba(57,255,20,.6);}',
      '.mmd-flash-lose .mmd-flash-t{color:var(--danger);}',
      '.mmd-flash-s{font-size:11.5px;color:var(--muted);margin-top:2px;}',
      /* Solo-Intro */
      '.mmd-intro{padding:26px 22px;max-width:560px;margin:0 auto;display:flex;flex-direction:column;gap:12px;align-items:center;text-align:center;}',
      '.mmd-intro-i{font-size:52px;line-height:1;filter:drop-shadow(0 0 16px var(--stroke-2));}',
      '.mmd-intro h2{margin:0;}',
      '.mmd-diffs{display:grid;grid-template-columns:1fr;gap:8px;width:100%;}',
      '@media(min-width:560px){.mmd-diffs{grid-template-columns:repeat(3,1fr);}}',
      '.mmd-diff{display:flex;flex-direction:column;align-items:center;gap:2px;padding:13px 10px;border-radius:14px;',
      'border:1px solid var(--stroke);background:rgba(4,16,10,.6);cursor:pointer;font-family:inherit;',
      'transition:transform .1s,border-color .15s,box-shadow .15s;}',
      '.mmd-diff:hover,.mmd-diff.is-sel{border-color:var(--neon);box-shadow:0 0 20px rgba(57,255,20,.28);}',
      '.mmd-diff:active{transform:scale(.97);}',
      '.mmd-diff-i{font-size:26px;line-height:1;}',
      '.mmd-diff-t{font-size:15px;font-weight:900;color:var(--leaf);}',
      '.mmd-diff-s{font-size:10.5px;color:var(--muted);line-height:1.35;}',
      '.mmd-rec{color:var(--gold);}',
      /* Animationen */
      '@keyframes mmd-row-in{from{opacity:0;transform:translateY(-9px) scale(.97);}to{opacity:1;transform:none;}}',
      '@keyframes mmd-dot-in{from{opacity:0;transform:scale(.2);}to{opacity:1;transform:scale(1);}}',
      '@keyframes mmd-pop{0%{transform:scale(.6);}60%{transform:scale(1.18);}100%{transform:scale(1);}}',
      '@keyframes mmd-bump{0%{transform:scale(1);}40%{transform:scale(1.22);}100%{transform:scale(1);}}',
      '@keyframes mmd-shake{0%,100%{transform:translateX(0);}20%{transform:translateX(-7px);}60%{transform:translateX(7px);}}',
      '@keyframes mmd-glow{0%,100%{box-shadow:0 0 14px rgba(57,255,20,.3);}50%{box-shadow:0 0 34px rgba(57,255,20,.75);}}',
      '@keyframes mmd-new{from{opacity:0;transform:translateY(10px);}to{opacity:1;transform:none;}}',
      '@keyframes mmd-flash{from{opacity:0;transform:translateY(10px) scale(.9);}to{opacity:1;transform:none;}}',
      '@keyframes mmd-pulse{0%,100%{opacity:1;}50%{opacity:.4;}}'
    ].join(''));
  }
})();
