/* hangman.js — "Galgenraten": Wortraten-Rennen im Neon-Dschungel.
 *
 * SPIELIDEE
 *   3 Minuten Zeit, ein Wort nach dem anderen. Jedes Wort wird Buchstabe für
 *   Buchstabe erraten — 8 Fehlversuche sind erlaubt, dann ist der Galgen fertig
 *   gezeichnet und das Wort verloren. Gelöst oder verloren: sofort das nächste
 *   Wort. Wer in 3 Minuten die meisten Punkte sammelt, gewinnt.
 *
 * STEUERUNG
 *   Buchstaben per Bildschirmtastatur (Klick/Tipp) oder per echter Tastatur
 *   (A–Z sowie Ä, Ö, Ü). Jeder Buchstabe zählt nur einmal.
 *
 * PUNKTE
 *   Gelöst        : 1000 + Zeitbonus (max. 700, −25 pro Sekunde) + 50 je übriger Chance
 *   Nicht gelöst  : 40 pro selbst aufgedecktem Buchstaben
 *   Der Zwischenstand (40 je aufgedecktem Buchstaben) zählt schon live mit —
 *   die Rangliste kann dadurch nie fallen, nur steigen.
 *
 * SOLO (ctx.mode === 'single')
 *   Jagd gegen den eigenen Rekord (App.Storage 'best_hangman') — und gegen drei
 *   Dschungel-Bots in drei Schwierigkeitsstufen. Die Bot-KI ist ein echter
 *   Hangman-Löser: sie filtert die Wortliste nach Muster + Fehlbuchstaben und
 *   wählt den Buchstaben, der in den meisten Kandidaten steckt. Die Stufe regelt
 *   Denkzeit, wie weit unten im Ranking geraten wird und die Patzer-Rate.
 *
 * MULTI (ctx.mode === 'multi')
 *   Alle raten dieselben Wörter in derselben Reihenfolge: aus dem gemeinsamen
 *   Seed (room.snapshot().round.startAt bzw. createdAt) wird die Wortliste per
 *   Seeded-Shuffle gemischt — Wort Nr. n ist damit auf jedem Gerät dasselbe,
 *   ganz ohne Netz-Runde. Jeder rät auf seinem eigenen Brett um die Wette,
 *   der Punktestand geht per room.reportScore in die Live-Rangliste.
 *
 * TIMER/SYNC
 *   Alle Timer laufen über Wall-Clock (Date.now bzw. room.now, App.MG.roundTimer),
 *   die Bots ticken ebenfalls über echte Zeit → Tab-Wechsel-sicher. rAF wird nur
 *   zum Zeichnen der Galgen-Animation benutzt und stoppt, sobald sie fertig ist.
 *   cleanup() beendet Timer, rAF, Tastatur-Listener und Room-Listener. */
(function () {
  'use strict';
  window.App = window.App || {}; App.Minigames = App.Minigames || {};
  var UI = App.UI, el = UI.el;

  injectStyle();

  /* ===================== KONSTANTEN ===================== */
  var DURATION = 180;          // s Gesamtzeit
  var MAX_WRONG = 8;           // Fehlversuche pro Wort
  var SOLVE_BASE = 1000;       // Punkte fürs Lösen
  var BONUS_START = 700;       // maximaler Zeitbonus
  var BONUS_DROP = 25;         // Zeitbonus-Verlust pro Sekunde
  var CHANCE_BONUS = 50;       // Punkte je übriger Chance
  var LETTER_POINTS = 40;      // Punkte je aufgedecktem Buchstaben

  var ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÜ'.split('');
  var KEY_ROWS = [
    'ABCDEFGHIJ'.split(''),
    'KLMNOPQRST'.split(''),
    'UVWXYZÄÖÜ'.split('')
  ];
  /* Deutsche Buchstabenhäufigkeit (absteigend) — Fallback + Patzer der Bots. */
  var GER_FREQ = 'ENISRATDHULCGMOBWFKZPVJYXQÄÖÜ'.split('');

  /* ===================== WORTLISTE (183 Wörter, 5–12 Buchstaben) ===================== */
  var WORDS = [
    /* --- Dschungel & Natur --- */
    'DSCHUNGEL', 'REGENWALD', 'LIANE', 'PALME', 'ORCHIDEE', 'BAMBUS', 'FARNKRAUT',
    'WASSERFALL', 'FLUSSBETT', 'SUMPF', 'LICHTUNG', 'BAUMKRONE', 'WURZELWERK',
    'NEBELWALD', 'SCHLAMM', 'TROPEN', 'MONSUN', 'GEWITTER', 'BLÜTENSTAUB',
    'DORNBUSCH', 'KOKOSNUSS', 'BANANE', 'MANGOBAUM', 'ANANAS', 'PAPAYA',
    'KAKAOBOHNE', 'ZUCKERROHR', 'GEWÜRZ', 'TEICH', 'HÖHLE', 'GEBIRGE', 'VULKAN',
    'INSEL', 'STRAND', 'KÜSTE', 'TREIBSAND', 'SAVANNE', 'WÜSTE', 'MOOSTEPPICH',
    'URWALDRIESE',
    /* --- Tiere --- */
    'JAGUAR', 'TIGER', 'LEOPARD', 'PANTHER', 'GORILLA', 'SCHIMPANSE', 'ORANGUTAN',
    'MAKAKE', 'LEMUR', 'FAULTIER', 'AMEISENBÄR', 'GÜRTELTIER', 'TAPIR', 'NASHORN',
    'ELEFANT', 'FLUSSPFERD', 'KROKODIL', 'ALLIGATOR', 'LEGUAN', 'CHAMÄLEON',
    'GECKO', 'PYTHON', 'ANAKONDA', 'KOBRA', 'VIPER', 'SKORPION', 'TARANTEL',
    'MOSKITO', 'TERMITE', 'AMEISE', 'LIBELLE', 'KÄFER', 'HEUSCHRECKE', 'TUKAN',
    'PAPAGEI', 'KOLIBRI', 'FLAMINGO', 'PELIKAN', 'REIHER', 'ADLER', 'GEIER',
    'FLEDERMAUS', 'PIRANHA', 'ROCHEN', 'HAIFISCH', 'DELFIN', 'SCHILDKRÖTE',
    'KAULQUAPPE', 'SALAMANDER', 'MOLCH', 'OKAPI', 'ZEBRA', 'GIRAFFE', 'ANTILOPE',
    'BÜFFEL', 'WILDSCHWEIN', 'WASCHBÄR', 'OTTER', 'BIBER', 'MURMELTIER', 'LUCHS',
    'BRAUNBÄR', 'EISBÄR', 'PINGUIN', 'ROBBE', 'WALROSS', 'QUALLE', 'KRAKE',
    'TINTENFISCH', 'SEESTERN', 'KORALLE', 'MUSCHEL', 'KREBS', 'HUMMER', 'GARNELE',
    /* --- Alltag --- */
    'KAFFEETASSE', 'ZAHNBÜRSTE', 'SCHLÜSSEL', 'BRIEFKASTEN', 'FAHRRAD', 'RUCKSACK',
    'TURNSCHUH', 'REGENSCHIRM', 'SONNENBRILLE', 'HANDTUCH', 'KOPFKISSEN',
    'FERNSEHER', 'KÜHLSCHRANK', 'MIKROWELLE', 'TOASTER', 'PFANNE', 'MESSER',
    'GABEL', 'LÖFFEL', 'TELLER', 'BECHER', 'FLASCHE', 'TEEKANNE', 'BROTDOSE',
    'SUPERMARKT', 'BÄCKEREI', 'APOTHEKE', 'BAHNHOF', 'FLUGHAFEN', 'STRASSENBAHN',
    'AMPEL', 'BRÜCKE', 'TUNNEL', 'GARTEN', 'BALKON', 'FENSTER', 'TREPPE',
    'TÜRKLINKE', 'TEPPICH', 'SCHRANK', 'SPIEGEL', 'SCHREIBTISCH', 'BLEISTIFT',
    'RADIERER', 'NOTIZBUCH', 'TASCHENLAMPE', 'BATTERIE', 'LADEKABEL', 'KOPFHÖRER',
    'TASTATUR', 'BILDSCHIRM', 'GELDBEUTEL', 'MÜNZE', 'KALENDER', 'WECKER',
    'FRÜHSTÜCK', 'BUTTERBROT', 'MARMELADE', 'SCHOKOLADE', 'KARTOFFEL', 'ZWIEBEL',
    'KNOBLAUCH', 'ERDBEERE', 'KIRSCHE', 'ZITRONE', 'APFELSAFT', 'LIMONADE',
    'PFANNKUCHEN'
  ];

  /* ===================== GALGEN-ZEICHNUNG ===================== */
  var CW = 220, CH = 260;
  /* 8 Teile — je Fehlversuch eins. kind 'g' = Galgen (aqua), 'f' = Figur (grün). */
  var PARTS = [
    { kind: 'g', segs: [[16, 242, 204, 242]] },                                   // 1 Boden
    { kind: 'g', segs: [[54, 242, 54, 26]] },                                     // 2 Pfahl
    { kind: 'g', segs: [[54, 26, 152, 26]] },                                     // 3 Querbalken
    { kind: 'g', segs: [[54, 62, 90, 26]] },                                      // 4 Strebe
    { kind: 'g', segs: [[152, 26, 152, 54]] },                                    // 5 Seil
    { kind: 'f', arc: [152, 72, 18] },                                            // 6 Kopf
    { kind: 'f', segs: [[152, 90, 152, 152]] },                                   // 7 Rumpf
    { kind: 'f', segs: [[152, 104, 124, 132], [152, 104, 180, 132],               // 8 Arme + Beine
                        [152, 152, 128, 196], [152, 152, 176, 196]] }
  ];

  function strokePart(c, p, t) {
    if (t <= 0) return;
    if (p.arc) {
      c.beginPath();
      c.arc(p.arc[0], p.arc[1], p.arc[2], -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * t);
      c.stroke();
      return;
    }
    c.beginPath();
    for (var i = 0; i < p.segs.length; i++) {
      var s = p.segs[i];
      c.moveTo(s[0], s[1]);
      c.lineTo(s[0] + (s[2] - s[0]) * t, s[1] + (s[3] - s[1]) * t);
    }
    c.stroke();
  }

  /* Zeichnet die ersten `wrong` Teile; das letzte mit Fortschritt t (0..1). */
  function drawGallows(cnv, dpr, wrong, t, lost) {
    var c = cnv.getContext('2d');
    if (!c) return;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, CW, CH);
    c.lineCap = 'round'; c.lineJoin = 'round';
    /* Geister-Umriss, damit die Fläche nie leer wirkt */
    c.globalAlpha = 0.07; c.shadowBlur = 0; c.lineWidth = 6; c.strokeStyle = '#9dff7a';
    for (var j = 0; j < PARTS.length; j++) strokePart(c, PARTS[j], 1);
    c.globalAlpha = 1;
    for (var i = 0; i < wrong && i < PARTS.length; i++) {
      var p = PARTS[i];
      var prog = (i === wrong - 1) ? t : 1;
      c.strokeStyle = lost ? '#ff4d6d' : (p.kind === 'g' ? '#33e6d0' : '#9dff7a');
      c.shadowColor = c.strokeStyle;
      c.shadowBlur = lost ? 18 : 10;
      c.lineWidth = p.kind === 'g' ? 7 : 6;
      strokePart(c, p, prog);
    }
    c.shadowBlur = 0;
  }

  /* ===================== HELFER ===================== */
  /* Seeded-Zufall (mulberry32) — gleicher Seed = gleiche Wortfolge auf allen Geräten. */
  function rngFrom(seed) {
    var s = (Math.floor(Math.abs(seed)) % 2147483647) >>> 0;
    return function () {
      s = (s + 0x6D2B79F5) >>> 0;
      var t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t = t ^ (t + Math.imul(t ^ (t >>> 7), t | 61));
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function shuffledWords(seed) {
    var a = WORDS.slice(), rnd = rngFrom(seed), i, j, tmp;
    for (i = a.length - 1; i > 0; i--) {
      j = Math.floor(rnd() * (i + 1));
      tmp = a[i]; a[i] = a[j]; a[j] = tmp;
    }
    return a;
  }
  function timeBonus(ms) {
    var b = BONUS_START - Math.floor(Math.max(0, ms) / 1000) * BONUS_DROP;
    return b > 0 ? b : 0;
  }
  function distinctLetters(word) {
    var out = [];
    for (var i = 0; i < word.length; i++) if (out.indexOf(word[i]) < 0) out.push(word[i]);
    return out;
  }
  function freqPick(pool) {
    /* Häufigkeits-gewichteter Zufall über die noch freien Buchstaben. */
    var ranked = GER_FREQ.filter(function (ch) { return pool.indexOf(ch) >= 0; });
    if (!ranked.length) ranked = pool.slice();
    if (!ranked.length) return null;
    var total = 0, w = [], i;
    for (i = 0; i < ranked.length; i++) { w.push(ranked.length - i); total += ranked.length - i; }
    var r = Math.random() * total;
    for (i = 0; i < ranked.length; i++) { r -= w[i]; if (r <= 0) return ranked[i]; }
    return ranked[0];
  }

  /* ===================== BOT-KI ===================== */
  /* Stufen: Denkzeit, wie tief im Ranking geraten wird (topK), Patzer-Rate.
     Die Denkzeit gilt pro Buchstabe — ein Wort braucht ~9 Rateschritte. Die Werte
     sind gegen menschliches Tempo simuliert: Leicht ~3–5k, Normal ~8–13k,
     Schwer ~13–21k Punkte pro Lauf (ein guter Mensch schafft ~15–25 s pro Wort). */
  var LEVELS = {
    leicht: { id: 'leicht', label: '😌 Leicht', desc: 'Gemütliche Bots', think: [3400, 5400], topK: 6, blunder: 0.34 },
    normal: { id: 'normal', label: '🌿 Normal', desc: 'Ordentliche Rater', think: [2100, 3400], topK: 3, blunder: 0.17 },
    schwer: { id: 'schwer', label: '🔥 Schwer', desc: 'Bots mit Wortschatz', think: [1650, 2650], topK: 1, blunder: 0.05 }
  };
  var BOT_DEFS = [
    { id: 'bot1', name: '🦜 Rio', tMul: 1.18, bAdd: 0.07 },
    { id: 'bot2', name: '🐒 Koko', tMul: 1.0, bAdd: 0 },
    { id: 'bot3', name: '🐆 Zara', tMul: 0.87, bAdd: -0.02 }
  ];

  /* Kandidaten: alle Wörter, die zum bisherigen Wissen des Bots passen. */
  function botCandidates(bot) {
    return WORDS.filter(function (w) {
      if (w.length !== bot.word.length) return false;
      for (var i = 0; i < w.length; i++) {
        var ch = w[i], known = bot.pattern[i];
        if (known) { if (ch !== known) return false; }
        else if (bot.guessed.indexOf(ch) >= 0) return false;  // geratener Buchstabe kann nicht verdeckt sein
      }
      return true;
    });
  }
  /* Buchstabenwahl: der Buchstabe, der in den meisten Kandidaten vorkommt —
     je nach Stufe aus den Top-K gewürfelt, manchmal ein echter Patzer. */
  function botPickLetter(bot) {
    var pool = ALPHABET.filter(function (ch) { return bot.guessed.indexOf(ch) < 0; });
    if (!pool.length) return null;
    if (Math.random() < bot.blunder) return freqPick(pool);

    var cands = botCandidates(bot), counts = {}, i;
    for (i = 0; i < pool.length; i++) counts[pool[i]] = 0;
    cands.forEach(function (w) {
      var seen = {};
      for (var k = 0; k < w.length; k++) {
        var ch = w[k];
        if (counts[ch] === undefined || seen[ch]) continue;
        seen[ch] = 1; counts[ch]++;
      }
    });
    var ranked = pool.filter(function (ch) { return counts[ch] > 0; });
    ranked.sort(function (a, b) {
      return counts[b] - counts[a] || (GER_FREQ.indexOf(a) - GER_FREQ.indexOf(b));
    });
    if (!ranked.length) return freqPick(pool);
    var k2 = Math.min(bot.topK, ranked.length);
    return ranked[Math.floor(Math.random() * k2)];
  }

  /* ===================== REGISTRIERUNG ===================== */
  App.Minigames.hangman = {
    id: 'hangman', title: 'Galgenraten', icon: '🔤', order: 107,
    subtitle: 'Wortduell: rate schneller als der Galgen',
    single: true, multi: true, minPlayers: 2, maxPlayers: 8,

    render: function (root, ctx) {
      var isMulti = ctx.mode === 'multi';
      var nowFn = isMulti ? ctx.room.now : function () { return Date.now(); };

      var dead = false;
      var stops = [];            // stop()-Funktionen (App.MG-Bausteine, Listener)
      var pending = [];          // laufende setTimeout-IDs
      var rafId = 0;

      /* --- Rundenzustand --- */
      var words = [], wordIdx = 0, word = '', wordStart = 0;
      var pattern = [], guessed = [], wrongLetters = [], wrong = 0;
      var score = 0, solved = 0, failed = 0, endAt = 0;
      var phase = 'idle';        // 'guess' | 'solved' | 'lost' | 'over'
      var finished = false;
      var animStart = 0, animLost = false;
      var bots = [], level = LEVELS.normal;

      /* --- DOM --- */
      var cnv, dpr = 1, wordEl, statusEl, scoreEl, timerEl, idxEl, pipsEl, missEl, keyEls = {}, stageEl;
      var board = null;

      function after(ms, fn) { var t = setTimeout(function () { if (!dead) fn(); }, ms); pending.push(t); return t; }
      function clearPending() { pending.forEach(clearTimeout); pending = []; }
      function stopHelpers() { stops.forEach(function (f) { try { f(); } catch (e) {} }); stops = []; }
      function stopRaf() { if (rafId) { cancelAnimationFrame(rafId); rafId = 0; } }
      function cleanup() { dead = true; clearPending(); stopHelpers(); stopRaf(); }

      /* ---- Einstieg ---- */
      if (isMulti) {
        var snap = ctx.room.snapshot() || {};
        var seed = (snap.round && snap.round.startAt) || snap.createdAt || 20260715;
        var startAt = (snap.round && snap.round.startAt) || (ctx.room.now() + 3000);
        words = shuffledWords(seed);
        stops.push(App.MG.countdown(root, startAt, function () { play(startAt); }, ctx.room.now));
      } else {
        chooseLevel();
      }
      return { cleanup: cleanup };

      /* ===================== SOLO: STUFENWAHL ===================== */
      function chooseLevel() {
        clearPending(); stopHelpers(); stopRaf();
        var best = App.Storage.get('best_hangman', 0);
        var btns = ['leicht', 'normal', 'schwer'].map(function (id) {
          var L = LEVELS[id];
          return el('button', {
            class: 'btn ' + (id === 'normal' ? 'btn-primary' : 'btn-ghost') + ' hgm-lvl', type: 'button',
            onclick: function () {
              if (App.Audio) App.Audio.sfx('select');
              level = L;
              words = shuffledWords(Date.now());
              play(Date.now());
            }
          }, [
            el('span', { class: 'hgm-lvl-t' }, [L.label]),
            el('span', { class: 'hgm-lvl-d' }, [L.desc])
          ]);
        });
        root.innerHTML = '';
        root.appendChild(el('div', { class: 'glass hgm-intro' }, [
          el('div', { class: 'hgm-intro-icon' }, ['🔤']),
          el('h2', { class: 'neon' }, ['Galgenraten']),
          el('p', { class: 'hint-text' }, ['3 Minuten, ein Wort nach dem anderen. 8 Fehler pro Wort — dann steht der Galgen. Drei Dschungel-Bots raten gegen dich.']),
          el('div', { class: 'hgm-lvl-row' }, btns),
          el('p', { class: 'hint-text' }, ['🏅 Dein Rekord: ' + App.MG.fmt(best) + ' Punkte'])
        ]));
      }

      /* ===================== SPIEL ===================== */
      function play(startAt) {
        clearPending(); stopHelpers(); stopRaf();
        score = 0; solved = 0; failed = 0; wordIdx = 0; finished = false; phase = 'idle';
        endAt = startAt + DURATION * 1000;
        keyEls = {};

        /* --- Kopfzeile --- */
        idxEl = el('div', { class: 'hgm-hv hgm-hv-aqua' }, ['1']);
        scoreEl = el('div', { class: 'hgm-hv hgm-hv-gold' }, ['0']);
        timerEl = el('div', { class: 'mg-timer' }, [App.MG.mmss(DURATION)]);
        var head = el('div', { class: 'glass hgm-head' }, [
          el('div', { class: 'hgm-hc' }, [el('span', { class: 'hgm-hl' }, ['Wort']), idxEl]),
          el('div', { class: 'hgm-hc hgm-hc-mid' }, [el('span', { class: 'hgm-hl' }, ['Punkte']), scoreEl]),
          el('div', { class: 'hgm-hc hgm-hc-end' }, [el('span', { class: 'hgm-hl' }, ['Zeit']), timerEl])
        ]);

        /* --- Bühne: Galgen + Chancen + Fehlbuchstaben --- */
        dpr = Math.min(2, window.devicePixelRatio || 1);
        cnv = el('canvas', { class: 'hgm-canvas', width: Math.round(CW * dpr), height: Math.round(CH * dpr) });
        pipsEl = el('div', { class: 'hgm-pips' });
        missEl = el('div', { class: 'hgm-miss' });
        var side = el('div', { class: 'hgm-side' }, [
          el('div', { class: 'mg-field-title' }, ['💚 Chancen']),
          pipsEl,
          el('div', { class: 'mg-field-title' }, ['🚫 Daneben']),
          missEl
        ]);
        stageEl = el('div', { class: 'glass hgm-stage' }, [el('div', { class: 'hgm-canvas-wrap' }, [cnv]), side]);

        /* --- Wort + Status --- */
        wordEl = el('div', { class: 'hgm-word' });
        statusEl = el('div', { class: 'hgm-status' }, ['Rate los!']);

        /* --- Bildschirmtastatur --- */
        var kb = el('div', { class: 'hgm-kb' }, KEY_ROWS.map(function (row) {
          return el('div', { class: 'hgm-kb-row' }, row.map(function (ch) {
            var b = el('button', { class: 'hgm-key', type: 'button' }, [ch]);
            b.addEventListener('pointerdown', function (e) { e.preventDefault(); guess(ch); });
            keyEls[ch] = b;
            return b;
          }));
        }));

        var hint = el('p', { class: 'hint-text hgm-rules' }, [
          'Tastatur oder Klick · 8 Fehler = Wort weg · Gelöst = 1000 + Zeitbonus + 50 je übriger Chance · 40 pro aufgedecktem Buchstaben'
        ]);

        /* --- Rangliste --- */
        var boardTitle, boardRoot;
        if (isMulti) {
          board = App.MG.liveBoard(ctx.room, ctx.me.id);
          stops.push(board.stop);
          boardTitle = '🏆 Rangliste'; boardRoot = board.root;
        } else {
          bots = BOT_DEFS.map(function (d) { return makeBot(d, level, startAt); });
          board = soloBoard();
          boardTitle = '🏆 Rangliste (' + level.label + ')'; boardRoot = board.root;
        }
        var boardWrap = el('div', { class: 'glass hgm-board-wrap' }, [
          el('div', { class: 'mg-field-title' }, [boardTitle]), boardRoot
        ]);

        root.innerHTML = '';
        root.appendChild(el('div', { class: 'hgm-layout' }, [head, stageEl, wordEl, statusEl, kb, hint, boardWrap]));

        /* --- echte Tastatur --- */
        function keyHandler(e) {
          if (e.ctrlKey || e.metaKey || e.altKey) return;
          var k = String(e.key || '');
          if (k.length !== 1) return;
          var ch = k.toUpperCase();
          if (ALPHABET.indexOf(ch) < 0) return;
          e.preventDefault();
          guess(ch);
        }
        document.addEventListener('keydown', keyHandler);
        stops.push(function () { document.removeEventListener('keydown', keyHandler); });

        /* --- Rundentimer (Wall-Clock) --- */
        stops.push(App.MG.roundTimer(endAt, function (left) {
          timerEl.textContent = App.MG.mmss(left);
          if (left <= 15) timerEl.classList.add('hgm-urgent');
        }, finish, isMulti ? ctx.room.now : null));

        /* --- Bot-/Board-Takt (Wall-Clock, holt nach Tab-Wechsel auf) --- */
        var tick = setInterval(function () {
          if (dead || finished) return;
          if (!isMulti) botTick(Date.now());
          board.update();
        }, 150);
        stops.push(function () { clearInterval(tick); });

        if (isMulti) ctx.room.reportScore(0);
        nextWord(startAt);
      }

      /* ---- neues Wort vorbereiten ---- */
      function nextWord(atTime) {
        if (dead || finished) return;
        if (nowFn() >= endAt) { finish(); return; }
        word = words[wordIdx % words.length];
        wordIdx++;
        pattern = []; for (var i = 0; i < word.length; i++) pattern.push('');
        guessed = []; wrongLetters = []; wrong = 0;
        wordStart = atTime || nowFn();
        phase = 'guess'; animLost = false; animStart = 0;
        idxEl.textContent = String(wordIdx);
        setStatus(word.length + ' Buchstaben — leg los!', '');
        renderWord(); renderKeys(); renderPips(); renderMiss();
        drawNow();
      }

      /* ---- Buchstabe raten ---- */
      function guess(ch) {
        if (dead || finished || phase !== 'guess') return;
        if (ALPHABET.indexOf(ch) < 0) return;
        if (guessed.indexOf(ch) >= 0) {
          if (App.Audio) App.Audio.sfx('error');
          setStatus(ch + ' hattest du schon', 'is-warn');
          var kEl = keyEls[ch];
          if (kEl) { kEl.classList.remove('hgm-again'); void kEl.offsetWidth; kEl.classList.add('hgm-again'); }
          return;
        }
        guessed.push(ch);

        var hitCount = 0, i;
        for (i = 0; i < word.length; i++) if (word[i] === ch) { pattern[i] = ch; hitCount++; }

        if (hitCount > 0) {
          if (App.Audio) App.Audio.blip(520 + hitCount * 90, 0.12, { type: 'triangle', peak: 0.09 });
          setStatus(hitCount === 1 ? ('Treffer: ' + ch + ' 🎯') : (hitCount + '× ' + ch + ' — stark! 🎯'), 'is-hit');
          renderWord(true); renderKeys();
          if (isMulti) ctx.room.reportScore(liveScore());
          updateScoreEl();
          if (pattern.indexOf('') < 0) { winWord(); return; }
        } else {
          wrong++;
          wrongLetters.push(ch);
          if (App.Audio) App.Audio.sfx('hit');
          setStatus('Kein ' + ch + ' dabei — ' + (MAX_WRONG - wrong) + ' Chancen übrig', 'is-miss');
          renderKeys(); renderPips(); renderMiss();
          stageEl.classList.remove('hgm-shake'); void stageEl.offsetWidth; stageEl.classList.add('hgm-shake');
          after(360, function () { if (stageEl) stageEl.classList.remove('hgm-shake'); });
          animStart = Date.now(); requestDraw();
          if (wrong >= MAX_WRONG) loseWord();
        }
      }

      /* ---- Wort gelöst ---- */
      function winWord() {
        phase = 'solved';
        var el2 = nowFn() - wordStart;
        var bonus = timeBonus(el2), chances = MAX_WRONG - wrong;
        var pts = SOLVE_BASE + bonus + CHANCE_BONUS * chances;
        score += pts; solved++;
        updateScoreEl();
        if (isMulti) ctx.room.reportScore(score);
        if (App.Audio) { App.Audio.sfx('win'); App.Audio.sweep(660, 1320, 0.28); }
        setStatus('Gelöst! +' + App.MG.fmt(pts) + ' (Zeitbonus ' + bonus + ' · ' + chances + ' Chancen)', 'is-win');
        wordEl.classList.add('hgm-word-win');
        renderWord();
        after(1000, function () { wordEl.classList.remove('hgm-word-win'); nextWord(nowFn()); });
      }

      /* ---- Wort verloren ---- */
      function loseWord() {
        phase = 'lost';
        var revealed = guessed.filter(function (c) { return word.indexOf(c) >= 0; }).length;
        var pts = LETTER_POINTS * revealed;
        score += pts; failed++;
        updateScoreEl();
        if (isMulti) ctx.room.reportScore(score);
        if (App.Audio) App.Audio.sfx('lose');
        animLost = true; animStart = Date.now(); requestDraw();
        setStatus('Verloren — das Wort war ' + word + ' (+' + pts + ')', 'is-lose');
        for (var i = 0; i < word.length; i++) if (!pattern[i]) pattern[i] = word[i];
        wordEl.classList.add('hgm-word-lose');
        renderWord();
        after(1900, function () { wordEl.classList.remove('hgm-word-lose'); nextWord(nowFn()); });
      }

      /* Live-Punktestand: bestätigte Punkte + 40 je aufgedecktem Buchstaben.
         Kann nie fallen — auch beim Verlieren gibt es genau diese Punkte. */
      function liveScore() {
        if (phase !== 'guess') return score;
        var rev = guessed.filter(function (c) { return word.indexOf(c) >= 0; }).length;
        return score + LETTER_POINTS * rev;
      }
      function updateScoreEl() {
        if (!scoreEl) return;
        scoreEl.textContent = App.MG.fmt(liveScore());
        scoreEl.classList.remove('hgm-bump'); void scoreEl.offsetWidth; scoreEl.classList.add('hgm-bump');
      }

      /* ===================== ZEICHNEN ===================== */
      function requestDraw() {
        if (rafId || dead) return;
        rafId = requestAnimationFrame(function () {
          rafId = 0;
          if (dead || !cnv) return;
          var t = animStart ? Math.min(1, (Date.now() - animStart) / 380) : 1;
          drawGallows(cnv, dpr, wrong, t, animLost);
          if (t < 1) requestDraw();
        });
      }
      function drawNow() { animStart = 0; if (cnv) drawGallows(cnv, dpr, wrong, 1, animLost); }

      /* ===================== DOM-AUSGABE ===================== */
      function renderWord(pop) {
        wordEl.innerHTML = '';
        for (var i = 0; i < word.length; i++) {
          var ch = pattern[i];
          var cls = 'hgm-slot' + (ch ? ' filled' : '');
          if (pop && ch && guessed.length && ch === guessed[guessed.length - 1]) cls += ' hgm-pop';
          wordEl.appendChild(el('div', { class: cls }, [ch || '']));
        }
      }
      function renderKeys() {
        ALPHABET.forEach(function (ch) {
          var b = keyEls[ch]; if (!b) return;
          var used = guessed.indexOf(ch) >= 0;
          var hit = used && word.indexOf(ch) >= 0;
          b.className = 'hgm-key' + (used ? (hit ? ' is-hit' : ' is-miss') : '');
        });
      }
      function renderPips() {
        pipsEl.innerHTML = '';
        for (var i = 0; i < MAX_WRONG; i++) {
          pipsEl.appendChild(el('div', { class: 'hgm-pip' + (i < wrong ? ' gone' : '') }));
        }
      }
      function renderMiss() {
        missEl.innerHTML = '';
        if (!wrongLetters.length) { missEl.appendChild(el('span', { class: 'hgm-miss-none' }, ['—'])); return; }
        wrongLetters.forEach(function (ch) { missEl.appendChild(el('span', { class: 'hgm-miss-ch' }, [ch])); });
      }
      function setStatus(text, cls) {
        if (!statusEl) return;
        statusEl.textContent = text;
        statusEl.className = 'hgm-status ' + (cls || '');
        statusEl.classList.remove('hgm-fade'); void statusEl.offsetWidth; statusEl.classList.add('hgm-fade');
      }

      /* ===================== SOLO-BOTS ===================== */
      function makeBot(def, lv, startAt) {
        var b = {
          id: def.id, name: def.name, score: 0, idx: 0, done: false,
          topK: lv.topK,
          blunder: Math.max(0, Math.min(0.6, lv.blunder + def.bAdd)),
          thinkMin: lv.think[0] * def.tMul, thinkMax: lv.think[1] * def.tMul,
          word: '', pattern: [], guessed: [], wrong: 0, wordStart: startAt, nextAt: 0
        };
        botNewWord(b, startAt);
        return b;
      }
      function botThink(b) { return b.thinkMin + Math.random() * (b.thinkMax - b.thinkMin); }
      function botNewWord(b, atTime) {
        b.word = words[b.idx % words.length];
        b.idx++;
        b.pattern = []; for (var i = 0; i < b.word.length; i++) b.pattern.push('');
        b.guessed = []; b.wrong = 0; b.wordStart = atTime;
        b.nextAt = atTime + botThink(b) + 400;
      }
      function botRevealed(b) {
        return b.guessed.filter(function (c) { return b.word.indexOf(c) >= 0; }).length;
      }
      function botLiveScore(b) { return b.score + LETTER_POINTS * botRevealed(b); }
      /* Ein Rateschritt zum Zeitpunkt atTime (für sauberen Zeitbonus beim Aufholen). */
      function botStep(b, atTime) {
        if (atTime >= endAt) { b.done = true; return; }
        var ch = botPickLetter(b);
        if (!ch) { b.done = true; return; }
        b.guessed.push(ch);
        var hit = 0, i;
        for (i = 0; i < b.word.length; i++) if (b.word[i] === ch) { b.pattern[i] = ch; hit++; }
        if (hit > 0) {
          if (b.pattern.indexOf('') < 0) {
            b.score += SOLVE_BASE + timeBonus(atTime - b.wordStart) + CHANCE_BONUS * (MAX_WRONG - b.wrong);
            botNewWord(b, atTime + 900);
            return;
          }
        } else {
          b.wrong++;
          if (b.wrong >= MAX_WRONG) {
            b.score += LETTER_POINTS * botRevealed(b);
            botNewWord(b, atTime + 1400);
            return;
          }
        }
        b.nextAt = atTime + botThink(b);
      }
      function botTick(now) {
        for (var i = 0; i < bots.length; i++) {
          var b = bots[i], guard = 0;
          while (!b.done && b.nextAt <= now && guard++ < 60) botStep(b, b.nextAt);
          if (!b.done && b.nextAt <= now) b.nextAt = now + botThink(b);   // Notbremse
        }
      }
      /* Solo-Rangliste im Stil von App.MG.liveBoard (baut nur bei Änderung neu). */
      function soloBoard() {
        var rootEl = el('div', { class: 'mg-scoreboard' }), sig = '';
        function update() {
          var rows = [{ id: 'me', name: 'Du', score: liveScore(), me: true }];
          bots.forEach(function (b) { rows.push({ id: b.id, name: b.name, score: botLiveScore(b), me: false }); });
          rows.sort(function (a, b) { return b.score - a.score; });
          var s = rows.map(function (r) { return r.id + ':' + r.score; }).join('|');
          if (s === sig) return;
          sig = s;
          rootEl.innerHTML = '';
          rows.forEach(function (p, i) {
            rootEl.appendChild(el('div', { class: 'mg-sb-row p' + (i + 1) + (p.me ? ' me' : '') }, [
              el('span', { class: 'mg-sb-rank' }, ['' + (i + 1)]),
              el('span', { class: 'mg-sb-name' }, [p.name]),
              el('span', { class: 'mg-sb-score' }, [App.MG.fmt(p.score)])
            ]));
          });
        }
        update();
        return { root: rootEl, update: update };
      }

      /* ===================== ENDE ===================== */
      function finish() {
        if (finished || dead) return;
        finished = true;
        score = liveScore();          // laufendes Wort zählt mit den aufgedeckten Buchstaben
        phase = 'over';
        clearPending(); stopHelpers(); stopRaf();
        if (App.Audio) App.Audio.sfx('cashout');

        if (isMulti) {
          ctx.room.reportScore(score);
          setStatus('Zeit um! ' + App.MG.fmt(score) + ' Punkte', 'is-win');
          after(1200, function () {
            App.MG.endScreen(root, { players: ctx.room.players(), meId: ctx.me.id, onExit: ctx.onExit });
          });
        } else {
          var beaten = bots.filter(function (b) { return botLiveScore(b) < score; }).length;
          var best = App.Storage.get('best_hangman', 0);
          var nb = score > best;
          if (nb) App.Storage.set('best_hangman', score);
          App.MG.endScreen(root, {
            score: score, best: best, newBest: nb,
            label: solved + ' Wörter gelöst · ' + failed + ' verpasst · ' + beaten + '/3 Bots geschlagen'
              + (nb ? ' · neuer Rekord! 🎉' : ' · Bestwert: ' + App.MG.fmt(best)),
            onExit: ctx.onExit,
            onAgain: function () { finished = false; words = shuffledWords(Date.now()); play(Date.now()); }
          });
        }
      }
    }
  };

  /* ===================== STYLES ===================== */
  function injectStyle() {
    UI.injectStyle('mg-hangman-css', [
      '.hgm-layout{display:flex;flex-direction:column;gap:12px;max-width:520px;margin:0 auto;}',
      /* Kopfzeile */
      '.hgm-head{display:flex;justify-content:space-between;align-items:center;padding:10px 16px;gap:10px;}',
      '.hgm-hc{display:flex;flex-direction:column;gap:2px;min-width:0;}',
      '.hgm-hc-mid{text-align:center;}',
      '.hgm-hc-end{text-align:right;}',
      '.hgm-hl{color:var(--muted);font-size:10px;text-transform:uppercase;letter-spacing:1px;font-weight:800;}',
      '.hgm-hv{font-size:clamp(20px,5.5vw,32px);font-weight:900;line-height:1;font-variant-numeric:tabular-nums;}',
      '.hgm-hv-aqua{color:var(--aqua);text-shadow:0 0 12px rgba(51,230,208,.45);}',
      '.hgm-hv-gold{color:var(--gold);text-shadow:0 0 12px rgba(255,210,63,.45);}',
      '.hgm-head .mg-timer{font-size:clamp(18px,5vw,26px);}',
      '.mg-timer.hgm-urgent{color:var(--danger-2);animation:hgm-pulse .7s infinite;}',
      '.hgm-bump{animation:hgm-bump .28s ease;}',
      /* Bühne */
      '.hgm-stage{display:flex;gap:12px;align-items:center;padding:12px 14px;}',
      '.hgm-stage.hgm-shake{animation:hgm-shake .34s ease;}',
      '.hgm-canvas-wrap{flex:1 1 150px;min-width:0;display:flex;justify-content:center;}',
      '.hgm-canvas{width:100%;max-width:200px;height:auto;display:block;}',
      '.hgm-side{flex:1 1 120px;min-width:0;display:flex;flex-direction:column;gap:6px;}',
      '.hgm-side .mg-field-title{margin:0;}',
      '.hgm-pips{display:flex;gap:5px;flex-wrap:wrap;}',
      '.hgm-pip{width:13px;height:13px;border-radius:50%;background:linear-gradient(180deg,var(--leaf),var(--neon));',
      'box-shadow:0 0 8px rgba(57,255,20,.55);transition:background .25s,box-shadow .25s,transform .25s;}',
      '.hgm-pip.gone{background:rgba(255,77,109,.22);box-shadow:none;transform:scale(.78);}',
      '.hgm-miss{display:flex;gap:4px;flex-wrap:wrap;min-height:22px;align-items:center;}',
      '.hgm-miss-none{color:var(--muted);font-size:13px;}',
      '.hgm-miss-ch{display:inline-flex;align-items:center;justify-content:center;min-width:20px;height:22px;padding:0 4px;',
      'border-radius:6px;background:rgba(255,77,109,.14);border:1px solid rgba(255,77,109,.45);color:var(--danger-2);',
      'font-weight:900;font-size:12px;animation:hgm-pop .2s ease;}',
      /* Wort */
      '.hgm-word{display:flex;gap:5px;flex-wrap:wrap;justify-content:center;min-height:44px;}',
      '.hgm-slot{width:clamp(22px,6.4vw,32px);height:clamp(30px,8.4vw,42px);display:flex;align-items:center;justify-content:center;',
      'border-radius:8px;border:1px solid var(--stroke);border-bottom:3px solid var(--stroke-2);background:rgba(6,24,16,.7);',
      'font-size:clamp(15px,4.4vw,22px);font-weight:900;color:var(--leaf);transition:border-color .2s,background .2s;}',
      '.hgm-slot.filled{border-color:var(--stroke-2);background:rgba(12,44,28,.85);text-shadow:0 0 10px rgba(57,255,20,.5);}',
      '.hgm-slot.hgm-pop{animation:hgm-pop .24s ease;}',
      '.hgm-word-win .hgm-slot{border-color:var(--gold);color:var(--gold);text-shadow:0 0 14px rgba(255,210,63,.6);animation:hgm-win .5s ease;}',
      '.hgm-word-lose .hgm-slot{border-color:rgba(255,77,109,.55);color:var(--danger-2);text-shadow:0 0 12px rgba(255,77,109,.45);}',
      /* Status */
      '.hgm-status{text-align:center;font-weight:900;font-size:clamp(13px,3.6vw,17px);min-height:22px;color:var(--muted);}',
      '.hgm-status.is-hit{color:var(--neon);text-shadow:0 0 10px rgba(57,255,20,.45);}',
      '.hgm-status.is-miss{color:var(--danger-2);}',
      '.hgm-status.is-warn{color:var(--aqua);}',
      '.hgm-status.is-win{color:var(--gold);text-shadow:0 0 12px rgba(255,210,63,.5);}',
      '.hgm-status.is-lose{color:var(--danger);}',
      '.hgm-status.hgm-fade{animation:hgm-fade .28s ease;}',
      /* Tastatur */
      '.hgm-kb{display:flex;flex-direction:column;gap:5px;}',
      '.hgm-kb-row{display:flex;gap:5px;justify-content:center;}',
      '.hgm-key{flex:1 1 0;min-width:0;max-width:44px;height:clamp(34px,9vw,44px);border-radius:9px;padding:0;',
      'background:rgba(9,32,21,.75);border:1px solid var(--stroke);color:var(--leaf);font-family:inherit;',
      'font-size:clamp(13px,3.6vw,17px);font-weight:900;cursor:pointer;user-select:none;-webkit-user-select:none;',
      '-webkit-tap-highlight-color:transparent;touch-action:manipulation;transition:transform .08s,border-color .15s,background .15s,color .15s;}',
      '.hgm-key:hover{border-color:var(--neon);box-shadow:inset 0 0 14px rgba(57,255,20,.18);transform:translateY(-1px);}',
      '.hgm-key:active{transform:scale(.93);}',
      '.hgm-key.is-hit{background:linear-gradient(180deg,var(--neon-soft),var(--neon));border-color:var(--neon);color:#04160c;box-shadow:0 0 14px rgba(57,255,20,.45);}',
      '.hgm-key.is-miss{background:rgba(60,10,20,.6);border-color:rgba(255,77,109,.35);color:rgba(255,128,152,.5);cursor:default;transform:none;}',
      '.hgm-key.is-miss:hover{border-color:rgba(255,77,109,.35);box-shadow:none;transform:none;}',
      '.hgm-key.hgm-again{animation:hgm-shake .3s ease;}',
      '.hgm-rules{text-align:center;margin:0;font-size:11px;line-height:1.4;}',
      /* Rangliste */
      '.hgm-board-wrap{padding:12px 14px;display:flex;flex-direction:column;gap:8px;}',
      '.hgm-board-wrap .mg-scoreboard{max-height:260px;overflow-y:auto;}',
      /* Solo-Startbild */
      '.hgm-intro{padding:28px 22px;text-align:center;display:flex;flex-direction:column;gap:12px;align-items:center;max-width:460px;margin:0 auto;}',
      '.hgm-intro-icon{font-size:52px;line-height:1;filter:drop-shadow(0 0 14px rgba(57,255,20,.5));animation:hgm-bob 2.4s ease-in-out infinite;}',
      '.hgm-intro h2{margin:0;font-size:clamp(24px,7vw,34px);}',
      '.hgm-lvl-row{display:flex;gap:8px;flex-wrap:wrap;justify-content:center;width:100%;}',
      '.hgm-lvl{flex:1 1 120px;display:flex;flex-direction:column;gap:2px;align-items:center;padding:12px 10px;}',
      '.hgm-lvl-t{font-size:15px;font-weight:900;}',
      '.hgm-lvl-d{font-size:10px;opacity:.75;text-transform:uppercase;letter-spacing:.5px;}',
      /* Animationen */
      '@keyframes hgm-pop{0%{transform:scale(.5)}70%{transform:scale(1.16)}100%{transform:scale(1)}}',
      '@keyframes hgm-bump{0%{transform:scale(1)}40%{transform:scale(1.16)}100%{transform:scale(1)}}',
      '@keyframes hgm-win{0%{transform:translateY(0)}45%{transform:translateY(-6px)}100%{transform:translateY(0)}}',
      '@keyframes hgm-shake{0%,100%{transform:translateX(0)}20%{transform:translateX(-7px)}60%{transform:translateX(7px)}}',
      '@keyframes hgm-pulse{0%,100%{opacity:1}50%{opacity:.4}}',
      '@keyframes hgm-fade{from{opacity:.25}to{opacity:1}}',
      '@keyframes hgm-bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-6px)}}'
    ].join(''));
  }
})();
