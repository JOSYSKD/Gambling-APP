/* anagram.js — "Buchstabensalat": Wort-Wettbewerb im Neon-Dschungel.
 *
 * SPIELIDEE : Alle bekommen dieselben 8 Buchstaben (immer die Buchstaben eines
 *             echten 8-Buchstaben-Wortes, gut gemischt -> saubere Vokal-/
 *             Konsonanten-Mischung und garantiert lösbar). In 90 Sekunden so
 *             viele echte deutsche Wörter wie möglich legen (ab 3 Buchstaben).
 *             Jeder Buchstabe zählt nur so oft, wie er im Vorrat liegt.
 * STEUERUNG : Buchstaben anklicken/antippen oder einfach tippen. Enter legt das
 *             Wort, Rücktaste nimmt einen Buchstaben zurück, Leertaste mischt
 *             den Vorrat neu, Esc leert das Wortfeld. Dazu die Buttons
 *             "Mischen", "Rückgängig" und "Wort legen".
 * PUNKTE    : 3 Buchstaben 100, 4 -> 250, 5 -> 500, 6 -> 800, 7 -> 1200,
 *             8 -> 2000. Doppelte Wörter zählen nicht.
 * SOLO      : Jagd auf den eigenen Rekord, dazu 3 Bots in vier Stärken
 *             (Leicht/Mittel/Schwer/Profi). Jeder Bot kennt nur einen Teil der
 *             Lösungen (lange Wörter seltener) und findet sie in plausiblem
 *             Takt -> die Live-Rangliste bleibt spannend. Am Ende zeigt das
 *             Spiel die verpassten längsten Wörter.
 * MULTI     : Der Host würfelt den Seed und verteilt ihn per room.setShared
 *             ({seed}); alle leiten daraus dieselben Buchstaben ab. Punkte
 *             laufen über room.reportScore -> App.MG.liveBoard. Start/Timer
 *             immer über room.now() (Server-Zeit), damit alle synchron sind.
 *             Die room-Handler sind idempotent ("started"-Sperre), weil die
 *             Events (Heartbeat) sehr oft feuern.
 * Alle Timer laufen über Wall-Clock, nie über Frame-Zählung -> Tab-Wechsel
 * sicher. cleanup() stoppt Timer, Listener und meldet jeden room.on wieder ab.
 */
(function () {
  'use strict';
  window.App = window.App || {}; App.Minigames = App.Minigames || {};
  var UI = App.UI, el = UI.el;

  injectStyle();

  var ROUND_SEC = 90;                 // Rundenzeit in Sekunden
  var MIN_LEN = 3;                    // kürzestes erlaubtes Wort
  var POINTS = { 3: 100, 4: 250, 5: 500, 6: 800, 7: 1200, 8: 2000 };

  /* Grundwörter: aus einem davon werden die 8 Buchstaben gemischt. Alle sind
   * mit dem Wörterbuch unten geprüft und liefern je 23–40 legbare Wörter. */
  var BASE_WORDS = [
    'MEISTERN', 'BERATUNG', 'ARBEITEN', 'STRAHLEN', 'GARDINEN', 'LEISTUNG',
    'SCHRAUBE', 'FREUNDIN', 'WEINGLAS', 'SCHNEIDE', 'SCHATTEN', 'KLEIDUNG',
    'FLASCHEN'
  ];

  /* Wörterbuch: 767 deutsche Wörter (3–8 Buchstaben, ohne Umlaute/ß). */
  var WORDS = (
    'AAL ABEND ABER ACHSE ACHT ACHTE ACHTEN ADEL ADER ADLER AKTE AKTEN ALLE ALLEIN ALT ALTE ALTER AMT ANDERE ANGEL ANGST ANKER ANTEIL APFEL ARBEIT ARBEITE ARBEITEN ARM ARME ART ARZT ASCHE AST ATEM AUCH AUGE AUS AUTO ' +
    'BAD BAHN BALD BALL BAND BANK BAR BART BAU BAUCH BAUER BAUM BEICHTE BEIDE BEIL BEIN BEINE BEISPIEL BERATUNG BEREIT BERG BERICHT BERICHTE BERUF BESEN BESTE BETEN BETRUG BETT BEUTEL BIENE BIER BILD BINDE BINDEN BIRNE BIS BLATT BLAU BLEI BLICK BLUME BODEN BOGEN BOHNE BOOT BRATEN BRAUN BREIT BRIEF BRILLE BROT BRUDER BUCH BUND BUNT BURG BUS BUSCH BUTTER ' +
    'DACH DAME DANK DANKE DARM DAUER DEIN DEINE DENKEN DENN DICHT DICK DIENER DIENST DING DINGE DORF DORT DRAHT DREI DRIN DUFT DUNKEL DURST ' +
    'ECHT ECKE EDEL EHRE EIER EIGEN EILE EIMER EIN EINE EINS EIS EISEN ELCH ELF ENDE ENGEL ENKEL ENTE ERBE ERDE ERNST ERNTE ESEL ESSEN EULE ' +
    'FADEN FAHNE FAHRT FALL FALLE FALSCH FARBE FASS FEDER FEHLER FEIER FEIERTAG FEIND FELD FELS FENSTER FERN FEST FETT FEUER FILM FINDEN FINGER FISCH FLACH FLASCHE FLASCHEN FLUSS FOLGE FRAGE FRAGEN FRAU FREI FREITAG FREUND FREUNDIN FRIEDEN FRISCH FROH FRUCHT FUCHS FUND FUNKE ' +
    'GABEL GANG GANZ GARDINE GARDINEN GARN GARTEN GAST GEBET GEBURT GEDANKE GEDANKEN GEDICHT GEHEN GEIGE GEIST GELD GENAU GERADE GERN GESANG GESICHT GEWINN GEWINNE GEWINNER GIER GIFT GLANZ GLAS GLEICH GOLD GRAD GRAS GRAU GRUND GRUPPE GUT GUTE ' +
    'HAAR HAFEN HAKEN HALB HALLE HALS HALT HALTE HALTEN HAND HANDEL HANDTUCH HASE HAST HAUCH HAUS HAUT HEBEL HEFT HEIDE HEIL HEIM HELD HELDEN HELFEN HELL HEMD HERD HERR HERREN HERZ HEUTE HIER HILFE HIMMEL HIRSCH HITZE HOCH HOLZ HONIG HUND HUNGER HUT ' +
    'IDEE IGEL IHM IHN IHR IMKER INSEL ' +
    'JAGD JAHR JEDE JEDER JETZT JUNGE ' +
    'KABEL KAFFEE KALT KAMM KARTE KASTEN KATZE KAUF KAUFEN KEGEL KEIL KEIN KEINE KELLER KERN KERZE KETTE KIND KINDER KINN KISTE KLANG KLAR KLEID KLEIDUNG KLEIN KLUG KNIE KNOPF KOCH KOPF KORB KORN KRAFT KRANK KRAUT KREIS KREUZ KRIEG KUGEL KUH KURS KURZ KUSS ' +
    'LACHEN LADEN LAGE LAGER LAMM LAMPE LAND LANG LANGE LAST LAUB LAUF LAUFEN LAUT LEBEN LEDER LEER LEGEN LEHRE LEHRER LEHRERIN LEIB LEICHT LEID LEIM LEINE LEISE LEISTUNG LEITER LERNEN LESEN LEUTE LICHT LIEBE LIED LIEGEN LINIE LINKS LIST LISTE LOCH LOHN LOS LUFT LUNGE LUST ' +
    'MACHT MAGEN MAHL MAL MALER MANN MANTEL MARKT MAUER MAUS MEER MEHL MEHR MEIN MEINE MEINEN MEISTE MEISTER MEISTERN MENGE MENSCH MESSER METER MIETE MIETEN MILCH MINUTE MIST MITTE MONAT MOND MORD MORGEN MOTOR MUND MUSIK MUT MUTTER ' +
    'NABEL NACH NACHT NADEL NAGEL NAHE NAME NARR NASE NASS NATUR NEBEL NEBEN NEIN NEST NETT NETZ NEUN NICHT NICHTS NIEDER NIERE NORDEN NOT NUDEL NULL NUR NUSS ' +
    'OBEN OBST OFEN OFT OHNE OHR ONKEL OPER ORDNUNG ORGEL ORT OSTEN ' +
    'PAAR PAKET PAPIER PARK PAUSE PECH PEDAL PERLE PFAD PFEIL PFERD PILS PILZ PLAN PLATZ PREIS PROBE PUNKT PUPPE PUTZ ' +
    'QUELLE ' +
    'RABE RABEN RAD RAND RANG RASEN RAST RAT RATEN RATTE RAUB RAUCH RAUM RECHT REDE REDEN REDNER REGAL REGEL REGEN REICH REIF REIHE REIM REIN REIS REISE REISEN REITEN RENNEN REST RICHTER RIESE RIND RINDE RING RINGE RIPPE RITTER ROCK ROHR ROSE ROST ROT RUDER RUHE RUND RUNDE RUNDEN ' +
    'SAAL SACHE SACK SAFT SAGE SAGEN SAHNE SALAT SALZ SAND SATT SATZ SAUBER SCHAF SCHAL SCHATTEN SCHATZ SCHEIBE SCHEIDE SCHEIDEN SCHEIN SCHERE SCHICHT SCHIENE SCHIFF SCHILD SCHLAF SCHLAG SCHNEE SCHNEIDE SCHNELL SCHRANK SCHRAUBE SCHRIFT SCHUH SCHULD SCHULE SCHUSS SCHUTZ SCHWEIN SEE SEELE SEGEL SEHEN SEIDE SEIL SEIN SEINE SEITE SENDEN SETZEN SIEB SIEG SIEGEN SILBE SINGEN SINN SITZ SOHN SOMMER SONNE SPATEN SPIEGEL SPIEL SPIELE SPIELEN SPITZE SPORT SPRACHE STADT STAHL STALL STAND STARK START STATT STAUB STEG STEIN STEINE STELLE STERN STIEL STIER STIFT STIL STIMME STOCK STOFF STOLZ STRAHL STRAHLEN STRAND STREIT STROM STUFE STUHL STUNDE STURM SUCHE SUCHEN SUPPE ' +
    'TAFEL TAG TAL TANNE TANZ TANZEN TASCHE TASSE TAT TAU TAUBE TEIL TEILE TEILEN TELLER TEMPEL TEPPICH TEUER TEXT THEATER TIEF TIER TIERE TIGER TINTE TISCH TITEL TOCHTER TOD TON TOPF TOR TRAGE TRAUBE TRAUM TREIBEN TREPPE TRETEN TRINKEN TROMMEL TROPFEN TUCH TUN TURM ' +
    'UHR ULME UMWELT UND UNTEN UNTER URLAUB ' +
    'VATER VIEL VIER VOGEL VOLK VOLL VORNE ' +
    'WACHE WAGEN WAHL WALD WAND WANDERER WANDERN WANGE WARE WAREN WARM WARTEN WASSER WEDER WEG WEIDE WEIN WEINE WEINGLAS WEISE WEIT WELT WENIG WENIGER WERDEN WERK WERT WESEN WESTEN WETTER WIESE WIND WINTER WIRT WISSEN WITZ WOCHE WOLF WOLKE WOLLE WORT WUNDE WUNDER WURM WURST ' +
    'ZAHL ZAHLEN ZAHN ZAUN ZEIGEN ZEILE ZEIT ZELT ZEUG ZIEGEL ZIEL ZIMMER ZINN ZITRONE ZOPF ZUG ZWEI ZWERG ZWIEBEL ' +
    'ADERN BRAUCHE DRANG EICHE FINDER GLEIS HATTE KUNDE LACHS LAWINE LEDIG LEITUNG NAGER NAHT RAUSCH RINDEN SCHAUER SEHNE TATEN TEILUNG'
  ).split(' ');

  var DICT = {};
  WORDS.forEach(function (w) { DICT[w] = true; });

  /* Bot-Stufen für den Solo-Modus. skills = "Wortschatz-Anteil" der 3 Bots,
   * delay = mittlerer Abstand zwischen zwei gefundenen Wörtern in ms. */
  var DIFFS = {
    leicht: { label: 'Leicht', emoji: '🌱', hint: 'gemütliche Gegner', delay: 9000, skills: [0.30, 0.24, 0.18] },
    mittel: { label: 'Mittel', emoji: '🌴', hint: 'solide Wortjäger', delay: 6400, skills: [0.52, 0.44, 0.36] },
    schwer: { label: 'Schwer', emoji: '🔥', hint: 'die legen vor', delay: 4800, skills: [0.74, 0.64, 0.55] },
    profi: { label: 'Profi', emoji: '👑', hint: 'nur für Wortakrobaten', delay: 3600, skills: [0.92, 0.84, 0.74] }
  };
  var DIFF_KEYS = ['leicht', 'mittel', 'schwer', 'profi'];
  var BOT_NAMES = [
    { name: 'Ara Ada', emoji: '🦜' },
    { name: 'Kuno Kapuziner', emoji: '🐒' },
    { name: 'Sissi Schlange', emoji: '🐍' }
  ];
  /* Wie wahrscheinlich kennt ein Bot ein Wort dieser Länge? (lang = seltener) */
  var LEN_FACTOR = [0, 0, 0, 1, 1, 0.88, 0.7, 0.5, 0.34];
  /* Sicherheitsnetz: so viele Wörter kennt auch der schwächste Bot mindestens,
   * damit nie einer eine ganze Runde lang stumm auf 0 Punkten sitzt. */
  var MIN_POOL = 4;

  /* ---------- reine Helfer ---------- */
  function scoreOf(w) { return POINTS[w.length] || 0; }
  function countsOf(list) {
    var c = {};
    list.forEach(function (ch) { c[ch] = (c[ch] || 0) + 1; });
    return c;
  }
  function canBuild(w, avail) {
    var used = {};
    for (var i = 0; i < w.length; i++) {
      var ch = w.charAt(i);
      used[ch] = (used[ch] || 0) + 1;
      if (used[ch] > (avail[ch] || 0)) return false;
    }
    return true;
  }
  function solutionsFor(letterArr) {
    var avail = countsOf(letterArr);
    return WORDS.filter(function (w) { return canBuild(w, avail); });
  }
  /* Kleiner deterministischer Zufall (LCG) — gleicher Seed, gleiche Buchstaben. */
  function makeRng(seed) {
    var s = (seed >>> 0) || 1;
    return function () {
      s = (s * 1664525 + 1013904223) % 4294967296;
      return s / 4294967296;
    };
  }
  function lettersFromSeed(seed) {
    var rnd = makeRng(seed);
    var base = BASE_WORDS[Math.floor(rnd() * BASE_WORDS.length) % BASE_WORDS.length];
    var arr = base.split('');
    for (var i = arr.length - 1; i > 0; i--) {          // Fisher-Yates
      var j = Math.floor(rnd() * (i + 1));
      var t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }
  function byLenDesc(a, b) { return b.length - a.length || a.localeCompare(b); }

  App.Minigames.anagram = {
    id: 'anagram', title: 'Buchstabensalat', icon: '🔡', order: 117,
    subtitle: '8 Buchstaben, 90 Sekunden – finde die Wörter',
    single: true, multi: true, minPlayers: 2, maxPlayers: 8,

    render: function (root, ctx) {
      var isMulti = ctx.mode === 'multi';
      var nowFn = isMulti ? ctx.room.now : function () { return Date.now(); };

      var dead = false;
      var stops = [];        // stop()-Funktionen (App.MG-Bausteine, room.off, Listener)
      var pending = [];      // laufende setTimeout-IDs
      var started = false;   // Sperre: room-Events feuern sehr oft
      var finished = false;

      /* Rundenzustand */
      var rack = [], order = [], sel = [], avail = {};
      var found = {}, foundList = [], solutions = [], score = 0;
      var bots = [], botTimer = null, roundEndAt = 0, diff = 'mittel';

      /* DOM der laufenden Ansicht */
      var scoreEl, timerEl, wordsEl, recordEl, fieldEl, rackEl, chipsEl, msgEl, boardEl, boardWrap;

      function after(ms, fn) { var t = setTimeout(function () { if (!dead) fn(); }, ms); pending.push(t); return t; }
      function clearPending() { pending.forEach(clearTimeout); pending = []; }
      function stopHelpers() { stops.forEach(function (f) { try { f(); } catch (e) {} }); stops = []; }
      function cleanup() {
        dead = true;
        clearPending();
        stopHelpers();
        if (botTimer) { clearInterval(botTimer); botTimer = null; }
      }
      function sfx(n) { if (App.Audio) App.Audio.sfx(n); }

      if (isMulti) startMulti(); else chooseDifficulty();
      return { cleanup: cleanup };

      /* ===================== MULTIPLAYER-START ===================== */
      function startMulti() {
        var room = ctx.room;
        ensureSeed();

        var snap = ctx.room.snapshot() || {};
        var startAt = (snap.round && snap.round.startAt) || (ctx.room.now() + 3000);
        stops.push(App.MG.countdown(root, startAt, function () { tryStart(startAt); }, ctx.room.now));

        /* Der Seed kann kurz nach dem Countdown eintreffen -> idempotent starten. */
        var cdDone = false;
        function onShared() {
          if (dead || started) return;
          ensureSeed();
          if (cdDone) tryStart(startAt);
        }
        room.on('shared', onShared);
        stops.push(function () { room.off('shared', onShared); });

        function tryStart(sAt) {
          cdDone = true;
          if (dead || started) return;
          var seed = getSeed();
          if (seed === null) { showWaiting(); return; }
          play(sAt, seed);
        }
        function getSeed() {
          var s = room.snapshot();
          return (s && s.shared && typeof s.shared.seed === 'number') ? s.shared.seed : null;
        }
        function ensureSeed() {
          if (!room.isHost() && !ctx.isHost) return;
          if (getSeed() !== null) return;
          room.setShared({ seed: Math.floor(Math.random() * 1000000000) });
        }
        function showWaiting() {
          root.innerHTML = '';
          root.appendChild(el('div', { class: 'glass ang-wait' }, [
            el('div', { class: 'ang-wait-icon' }, ['🔡']),
            el('h2', { class: 'neon' }, ['Buchstaben werden gemischt …']),
            el('p', { class: 'hint-text' }, ['Der Gastgeber verteilt gleich den Buchstabensalat.'])
          ]));
        }
      }

      /* ===================== SOLO-START ===================== */
      function chooseDifficulty() {
        clearPending(); stopHelpers();
        if (botTimer) { clearInterval(botTimer); botTimer = null; }
        started = false; finished = false;

        var cur = App.Storage.get('ang_diff', 'mittel');
        if (DIFF_KEYS.indexOf(cur) < 0) cur = 'mittel';
        var best = App.Storage.get('best_anagram', 0);

        var btns = DIFF_KEYS.map(function (k) {
          var d = DIFFS[k];
          return el('button', {
            class: 'ang-diff-btn' + (k === cur ? ' on' : ''), type: 'button',
            onclick: function () { sfx('select'); soloStart(k); }
          }, [
            el('span', { class: 'ang-diff-emoji' }, [d.emoji]),
            el('span', { class: 'ang-diff-name' }, [d.label]),
            el('span', { class: 'ang-diff-hint' }, [d.hint])
          ]);
        });

        root.innerHTML = '';
        root.appendChild(el('div', { class: 'glass ang-intro' }, [
          el('div', { class: 'ang-intro-icon' }, ['🔡']),
          el('h2', { class: 'neon' }, ['Buchstabensalat']),
          el('p', { class: 'hint-text' }, ['Aus 8 Buchstaben in 90 Sekunden so viele deutsche Wörter wie möglich legen. Drei Bots suchen mit — wie stark sollen sie sein?']),
          el('div', { class: 'ang-record' }, ['🏆 Dein Rekord: ' + App.MG.fmt(best)]),
          el('div', { class: 'ang-diff-row' }, btns)
        ]));
      }

      function soloStart(k) {
        diff = k;
        App.Storage.set('ang_diff', k);
        clearPending(); stopHelpers();
        var startAt = Date.now() + 3000;
        stops.push(App.MG.countdown(root, startAt, function () {
          play(startAt, Math.floor(Math.random() * 1000000000));
        }));
      }

      /* ===================== RUNDE ===================== */
      function play(startAt, seed) {
        if (dead || started) return;
        started = true;
        clearPending(); stopHelpers();

        roundEndAt = startAt + ROUND_SEC * 1000;
        setupLetters(seed);
        buildUI();
        sfx('start');

        stops.push(App.MG.roundTimer(roundEndAt, onTick, finish, isMulti ? ctx.room.now : null));

        if (isMulti) {
          var board = App.MG.liveBoard(ctx.room, ctx.me.id);
          stops.push(board.stop);
          boardWrap.appendChild(board.root);
          ctx.room.reportScore(0);
        } else {
          boardWrap.appendChild(boardEl);
          startBots(startAt);
          renderSoloBoard();
        }
      }

      function setupLetters(seed) {
        var arr = lettersFromSeed(seed);
        rack = arr.map(function (ch, i) { return { id: i, ch: ch }; });
        order = rack.map(function (t) { return t.id; });
        avail = countsOf(arr);
        solutions = solutionsFor(arr);
        sel = []; found = {}; foundList = []; score = 0; bots = [];
      }

      function onTick(left) {
        if (!timerEl) return;
        timerEl.textContent = App.MG.mmss(left);
        if (left <= 10) timerEl.classList.add('ang-urgent');
      }

      /* ===================== AUFBAU DER ANSICHT ===================== */
      function buildUI() {
        scoreEl = el('div', { class: 'ang-score' }, ['0']);
        timerEl = el('div', { class: 'mg-timer ang-timer' }, [App.MG.mmss(ROUND_SEC)]);
        wordsEl = el('div', { class: 'ang-head-v' }, ['0']);

        var headCells = [
          el('div', { class: 'ang-head-cell' }, [el('span', { class: 'ang-head-l' }, ['Punkte']), scoreEl]),
          el('div', { class: 'ang-head-cell ang-head-mid' }, [el('span', { class: 'ang-head-l' }, ['Wörter']), wordsEl])
        ];
        if (!isMulti) {
          recordEl = el('div', { class: 'ang-head-v ang-head-rec' }, [App.MG.fmt(App.Storage.get('best_anagram', 0))]);
          headCells.push(el('div', { class: 'ang-head-cell ang-head-mid' }, [el('span', { class: 'ang-head-l' }, ['🏆 Rekord']), recordEl]));
        }
        headCells.push(el('div', { class: 'ang-head-cell ang-head-right' }, [el('span', { class: 'ang-head-l' }, ['Zeit']), timerEl]));
        var head = el('div', { class: 'ang-head glass' }, headCells);

        fieldEl = el('div', { class: 'ang-field' });
        msgEl = el('div', { class: 'ang-msg' }, ['Los geht\'s – bau dein erstes Wort!']);
        rackEl = el('div', { class: 'ang-rack' });

        var ctrls = el('div', { class: 'controls-row ang-ctrls' }, [
          el('button', { class: 'btn btn-ghost', type: 'button', onclick: function () { shuffleRack(); } }, ['🔀 Mischen']),
          el('button', { class: 'btn btn-ghost', type: 'button', onclick: function () { undo(); } }, ['↩ Rückgängig']),
          el('button', { class: 'btn btn-primary', type: 'button', onclick: function () { submit(); } }, ['✔ Wort legen'])
        ]);

        var rules = el('p', { class: 'hint-text ang-rules' }, [
          'Ab 3 Buchstaben · jeder Buchstabe nur so oft, wie er daliegt · Enter = legen · Rücktaste = zurück · Leertaste = mischen'
        ]);

        chipsEl = el('div', { class: 'ang-chips' });
        var chipsWrap = el('div', { class: 'glass ang-panel' }, [
          el('div', { class: 'mg-field-title' }, ['📜 Deine Wörter']),
          chipsEl
        ]);

        boardEl = el('div', { class: 'mg-scoreboard' });
        boardWrap = el('div', { class: 'glass ang-panel ang-board-wrap' }, [
          el('div', { class: 'mg-field-title' }, ['🏆 Rangliste'])
        ]);

        root.innerHTML = '';
        root.appendChild(el('div', { class: 'ang-wrap' }, [
          head, fieldEl, msgEl, rackEl, ctrls, rules, chipsWrap, boardWrap
        ]));

        renderField(); renderRack(); renderChips();

        document.addEventListener('keydown', onKey);
        stops.push(function () { document.removeEventListener('keydown', onKey); });
      }

      /* ===================== DARSTELLUNG ===================== */
      function currentWord() {
        return sel.map(function (id) { return rack[id].ch; }).join('');
      }
      function renderField() {
        if (!fieldEl) return;
        fieldEl.innerHTML = '';
        if (!sel.length) {
          fieldEl.appendChild(el('div', { class: 'ang-ph' }, ['Buchstaben antippen oder tippen …']));
          return;
        }
        sel.forEach(function (id, i) {
          var t = el('span', { class: 'ang-tile' }, [rack[id].ch]);
          t.style.animationDelay = (i * 18) + 'ms';
          fieldEl.appendChild(t);
        });
      }
      function renderRack() {
        if (!rackEl) return;
        rackEl.innerHTML = '';
        order.forEach(function (id, i) {
          var used = sel.indexOf(id) >= 0;
          var b = el('button', {
            class: 'ang-key' + (used ? ' used' : ''), type: 'button',
            'aria-label': 'Buchstabe ' + rack[id].ch
          }, [rack[id].ch]);
          b.style.animationDelay = (i * 26) + 'ms';
          b.addEventListener('pointerdown', function (e) {
            e.preventDefault();
            pushLetter(id);
          });
          rackEl.appendChild(b);
        });
      }
      function renderChips() {
        if (!chipsEl) return;
        chipsEl.innerHTML = '';
        if (!foundList.length) {
          chipsEl.appendChild(el('span', { class: 'ang-none' }, ['Noch kein Wort gefunden.']));
          return;
        }
        foundList.slice().reverse().forEach(function (w) {
          chipsEl.appendChild(el('span', { class: 'ang-word len' + w.length }, [
            el('b', {}, [w]),
            el('i', {}, ['+' + scoreOf(w)])
          ]));
        });
      }
      function renderSoloBoard() {
        if (!boardEl) return;
        var rows = [{ name: (ctx.me && ctx.me.name) || 'Du', score: score, me: true }];
        bots.forEach(function (b) { rows.push({ name: b.emoji + ' ' + b.name, score: b.score, me: false }); });
        rows.sort(function (a, b) { return b.score - a.score; });
        boardEl.innerHTML = '';
        rows.forEach(function (r, i) {
          boardEl.appendChild(el('div', { class: 'mg-sb-row p' + (i + 1) + (r.me ? ' me' : '') }, [
            el('span', { class: 'mg-sb-rank' }, ['' + (i + 1)]),
            el('span', { class: 'mg-sb-name' }, [r.name + (r.me ? ' (du)' : '')]),
            el('span', { class: 'mg-sb-score' }, [App.MG.fmt(r.score)])
          ]));
        });
      }
      function say(text, kind) {
        if (!msgEl) return;
        msgEl.textContent = text;
        msgEl.className = 'ang-msg ' + (kind || '');
        void msgEl.offsetWidth;
        msgEl.classList.add('ang-msg-in');
      }
      function shakeField() {
        if (!fieldEl) return;
        fieldEl.classList.remove('ang-shake');
        void fieldEl.offsetWidth;
        fieldEl.classList.add('ang-shake');
      }
      function popup(text, cls) {
        if (!fieldEl) return;
        var p = el('div', { class: 'ang-pop ' + (cls || '') }, [text]);
        fieldEl.appendChild(p);
        after(1100, function () { if (p.parentNode) p.parentNode.removeChild(p); });
      }

      /* ===================== EINGABE ===================== */
      function pushLetter(id) {
        if (dead || finished || !started) return;
        if (sel.indexOf(id) >= 0 || sel.length >= rack.length) return;
        sel.push(id);
        sfx('click');
        renderField(); renderRack();
      }
      function typeLetter(ch) {
        for (var i = 0; i < order.length; i++) {
          var id = order[i];
          if (rack[id].ch === ch && sel.indexOf(id) < 0) { pushLetter(id); return; }
        }
        shakeField();
        say('„' + ch + '" liegt nicht (mehr) im Vorrat', 'bad');
      }
      function undo() {
        if (dead || finished || !sel.length) return;
        sel.pop();
        sfx('pop');
        renderField(); renderRack();
      }
      function clearField() {
        if (dead || finished || !sel.length) return;
        sel = [];
        sfx('whoosh');
        renderField(); renderRack();
      }
      function shuffleRack() {
        if (dead || finished) return;
        for (var i = order.length - 1; i > 0; i--) {
          var j = Math.floor(Math.random() * (i + 1));
          var t = order[i]; order[i] = order[j]; order[j] = t;
        }
        sfx('whoosh');
        renderRack();
      }
      function submit() {
        if (dead || finished || !started) return;
        var w = currentWord();
        if (w.length < MIN_LEN) {
          sfx('error'); shakeField();
          say('Mindestens ' + MIN_LEN + ' Buchstaben', 'bad');
          return;
        }
        if (found[w]) {
          sfx('info'); shakeField();
          say('„' + w + '" hast du schon – doppelt zählt nicht', 'warn');
          return;
        }
        if (!DICT[w]) {
          sfx('error'); shakeField();
          say('„' + w + '" steht nicht im Wörterbuch', 'bad');
          return;
        }
        /* gültig */
        var pts = scoreOf(w);
        found[w] = true; foundList.push(w); score += pts;
        popup('+' + pts, w.length >= 6 ? 'big' : '');
        say('„' + w + '" · +' + pts + ' Punkte' + (w.length >= 6 ? ' – stark!' : ''), 'ok');
        sfx(w.length >= 6 ? 'levelup' : 'point');
        if (scoreEl) {
          scoreEl.textContent = App.MG.fmt(score);
          scoreEl.classList.remove('ang-bump'); void scoreEl.offsetWidth; scoreEl.classList.add('ang-bump');
        }
        if (wordsEl) wordsEl.textContent = String(foundList.length);
        sel = [];
        renderField(); renderRack(); renderChips();
        if (isMulti) ctx.room.reportScore(score); else renderSoloBoard();
      }
      function onKey(e) {
        if (dead || finished || !started) return;
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        var k = e.key;
        if (k === 'Enter') { e.preventDefault(); submit(); return; }
        if (k === 'Backspace') { e.preventDefault(); undo(); return; }
        if (k === 'Escape') { e.preventDefault(); clearField(); return; }
        if (k === ' ' || e.code === 'Space') { e.preventDefault(); shuffleRack(); return; }
        if (k && k.length === 1) {
          var ch = k.toUpperCase();
          if (ch >= 'A' && ch <= 'Z') { e.preventDefault(); typeLetter(ch); }
        }
      }

      /* ===================== BOTS (nur Solo) ===================== */
      function startBots(startAt) {
        var cfg = DIFFS[diff] || DIFFS.mittel;
        bots = cfg.skills.map(function (skill, i) {
          /* Wortschatz des Bots: lange Wörter kennt er deutlich seltener. */
          var pool = solutions.filter(function (w) {
            return Math.random() < skill * (LEN_FACTOR[w.length] || 0.3);
          });
          /* Zu kleiner Wortschatz? Mit den kürzesten Lösungen auffüllen. */
          if (pool.length < MIN_POOL) {
            var extra = solutions.filter(function (w) { return pool.indexOf(w) < 0; })
              .sort(function (a, b) { return a.length - b.length; });
            while (pool.length < MIN_POOL && extra.length) pool.push(extra.shift());
          }
          /* Reihenfolge: kurze/mittlere Wörter zuerst, aber mit Rauschen. */
          var keyed = pool.map(function (w) { return { w: w, k: w.length * 0.6 + Math.random() * 3 }; });
          keyed.sort(function (a, b) { return a.k - b.k; });
          return {
            name: BOT_NAMES[i].name, emoji: BOT_NAMES[i].emoji,
            score: 0, words: 0, idx: 0,
            pool: keyed.map(function (it) { return it.w; }),
            delay: cfg.delay,
            nextAt: startAt + cfg.delay * (0.45 + Math.random() * 0.8)
          };
        });
        botTimer = setInterval(botTick, 250);
        stops.push(function () { if (botTimer) { clearInterval(botTimer); botTimer = null; } });
      }
      function botTick() {
        if (dead || finished) return;
        var now = Math.min(Date.now(), roundEndAt);   // nach Rundenende nichts mehr
        var changed = false;
        bots.forEach(function (b) {
          while (b.idx < b.pool.length && b.nextAt <= now) {
            var w = b.pool[b.idx++];
            b.score += scoreOf(w); b.words++;
            /* längere Wörter kosten den Bot mehr Zeit */
            b.nextAt += b.delay * (0.55 + Math.random() * 0.9) * (1 + (w.length - 3) * 0.12);
            changed = true;
          }
        });
        if (changed) renderSoloBoard();
      }

      /* ===================== ENDE ===================== */
      function finish() {
        if (finished || dead) return;
        finished = true;
        clearPending();
        stopHelpers();
        if (botTimer) { clearInterval(botTimer); botTimer = null; }
        sfx('win');

        if (isMulti) {
          ctx.room.reportScore(score);
          after(1000, function () {
            App.MG.endScreen(root, { players: ctx.room.players(), meId: ctx.me.id, onExit: ctx.onExit });
            root.appendChild(solutionPanel());
          });
        } else {
          var best = App.Storage.get('best_anagram', 0);
          var nb = score > best;
          if (nb) App.Storage.set('best_anagram', score);
          App.MG.endScreen(root, {
            score: score, best: best, newBest: nb,
            label: foundList.length + ' Wörter · ' + soloPlace() + (nb ? ' · neuer Rekord! 🎉' : ' · Rekord: ' + App.MG.fmt(best)),
            onExit: ctx.onExit,
            onAgain: function () { chooseDifficulty(); }
          });
          root.appendChild(soloBoardPanel());
          root.appendChild(solutionPanel());
        }
      }

      /* Platzierung gegen die Bots (Solo) als Text. */
      function soloPlace() {
        var better = bots.filter(function (b) { return b.score > score; }).length;
        var place = better + 1;
        return 'Platz ' + place + ' von ' + (bots.length + 1);
      }

      /* Endstand gegen die Bots (Solo). */
      function soloBoardPanel() {
        var rows = [{ name: (ctx.me && ctx.me.name) || 'Du', score: score, me: true }];
        bots.forEach(function (b) { rows.push({ name: b.emoji + ' ' + b.name, score: b.score, me: false }); });
        rows.sort(function (a, b) { return b.score - a.score; });
        var box = el('div', { class: 'mg-scoreboard' });
        rows.forEach(function (r, i) {
          box.appendChild(el('div', { class: 'mg-sb-row p' + (i + 1) + (r.me ? ' me' : '') }, [
            el('span', { class: 'mg-sb-rank' }, ['' + (i + 1)]),
            el('span', { class: 'mg-sb-name' }, [r.name + (r.me ? ' (du)' : '')]),
            el('span', { class: 'mg-sb-score' }, [App.MG.fmt(r.score)])
          ]));
        });
        return el('div', { class: 'glass ang-panel ang-endpanel' }, [
          el('div', { class: 'mg-field-title' }, ['🏁 Endstand (' + (DIFFS[diff] || DIFFS.mittel).label + ')']),
          box
        ]);
      }

      /* Die längsten Lösungen: gefundene grün, verpasste grau. */
      function solutionPanel() {
        var all = solutions.slice().sort(byLenDesc);
        var missed = all.filter(function (w) { return !found[w]; });
        var show = missed.slice(0, 12);
        var kids = [
          el('div', { class: 'mg-field-title' }, ['🧠 Das war drin: ' + rack.map(function (t) { return t.ch; }).join('')]),
          el('p', { class: 'hint-text' }, [
            'Du hast ' + foundList.length + ' von ' + all.length + ' möglichen Wörtern gefunden.'
          ])
        ];
        if (show.length) {
          kids.push(el('p', { class: 'ang-sol-title' }, ['Verpasste längste Wörter:']));
          kids.push(el('div', { class: 'ang-sols' }, show.map(function (w) {
            return el('span', { class: 'ang-sol' }, [
              el('b', {}, [w]), el('i', {}, ['+' + scoreOf(w)])
            ]);
          })));
        } else {
          kids.push(el('p', { class: 'ang-sol-title ang-perfect' }, ['🌟 Wahnsinn – du hast jedes mögliche Wort gefunden!']));
        }
        var best = foundList.slice().sort(byLenDesc)[0];
        if (best) kids.push(el('p', { class: 'hint-text' }, ['Dein längstes Wort: ' + best + ' (+' + scoreOf(best) + ')']));
        return el('div', { class: 'glass ang-panel ang-endpanel' }, kids);
      }
    }
  };

  /* ===================== STYLES ===================== */
  function injectStyle() {
    UI.injectStyle('mg-anagram-css', [
      '.ang-wrap{display:flex;flex-direction:column;gap:12px;}',
      /* Kopfzeile */
      '.ang-head{display:flex;justify-content:space-between;align-items:center;padding:12px 18px;gap:12px;flex-wrap:wrap;}',
      '.ang-head-cell{display:flex;flex-direction:column;gap:2px;min-width:0;}',
      '.ang-head-mid{text-align:center;}',
      '.ang-head-right{text-align:right;margin-left:auto;}',
      '.ang-head-l{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:1px;white-space:nowrap;}',
      '.ang-score{font-size:clamp(24px,6vw,40px);font-weight:900;color:var(--gold);text-shadow:0 0 12px rgba(255,210,63,.45);line-height:1;font-variant-numeric:tabular-nums;}',
      '.ang-head-v{font-size:clamp(18px,4.5vw,26px);font-weight:900;color:var(--leaf);line-height:1;font-variant-numeric:tabular-nums;}',
      '.ang-head-rec{color:var(--aqua);}',
      '.ang-head .mg-timer{font-size:clamp(18px,5vw,26px);}',
      '.mg-timer.ang-urgent{color:var(--danger);animation:ang-pulse .7s infinite;}',
      '.ang-bump{animation:ang-bump .3s ease;}',
      /* Wortfeld */
      '.ang-field{position:relative;display:flex;flex-wrap:wrap;gap:6px;justify-content:center;align-items:center;',
      'min-height:74px;padding:12px;border-radius:18px;border:2px dashed var(--stroke);',
      'background:radial-gradient(circle at 50% 0%,rgba(57,255,20,.08),rgba(4,16,10,.75) 72%);overflow:hidden;}',
      '.ang-ph{color:var(--muted);font-size:14px;font-weight:600;}',
      '.ang-tile{display:flex;align-items:center;justify-content:center;width:42px;height:50px;border-radius:11px;',
      'font-size:24px;font-weight:900;color:#04160c;background:linear-gradient(180deg,#a8ff8e,var(--neon));',
      'border:1px solid #eaffe2;box-shadow:0 0 14px rgba(57,255,20,.45);animation:ang-pop .22s cubic-bezier(.2,.9,.3,1.3) both;}',
      '.ang-shake{animation:ang-shake .3s ease;}',
      '.ang-pop{position:absolute;left:50%;top:6px;transform:translateX(-50%);font-weight:900;font-size:22px;',
      'color:var(--gold);text-shadow:0 0 12px rgba(255,210,63,.7);pointer-events:none;animation:ang-float 1.1s ease-out forwards;}',
      '.ang-pop.big{font-size:30px;color:var(--aqua);text-shadow:0 0 16px rgba(51,230,208,.8);}',
      /* Meldungszeile */
      '.ang-msg{text-align:center;font-size:14px;font-weight:700;color:var(--muted);min-height:20px;}',
      '.ang-msg.ok{color:var(--neon);text-shadow:0 0 10px rgba(57,255,20,.45);}',
      '.ang-msg.bad{color:var(--danger);}',
      '.ang-msg.warn{color:var(--gold);}',
      '.ang-msg-in{animation:ang-msgin .25s ease;}',
      /* Buchstaben-Vorrat */
      '.ang-rack{display:flex;flex-wrap:wrap;gap:8px;justify-content:center;}',
      '.ang-key{width:52px;height:60px;border-radius:13px;font-family:inherit;font-size:26px;font-weight:900;',
      'color:var(--leaf);background:linear-gradient(180deg,rgba(16,52,34,.95),rgba(6,26,17,.95));',
      'border:1px solid var(--stroke-2);cursor:pointer;touch-action:manipulation;-webkit-tap-highlight-color:transparent;',
      'user-select:none;-webkit-user-select:none;box-shadow:0 3px 0 rgba(0,0,0,.45),inset 0 0 14px rgba(57,255,20,.1);',
      'transition:transform .1s,box-shadow .15s,border-color .15s,opacity .15s;animation:ang-keyin .3s ease both;}',
      '.ang-key:hover:not(.used){border-color:var(--neon);box-shadow:0 3px 0 rgba(0,0,0,.45),0 0 16px rgba(57,255,20,.4);transform:translateY(-2px);}',
      '.ang-key:active:not(.used){transform:translateY(2px);box-shadow:0 1px 0 rgba(0,0,0,.45);}',
      '.ang-key.used{opacity:.26;color:var(--muted);border-color:var(--stroke);cursor:default;box-shadow:none;transform:none;}',
      '.ang-ctrls{flex-wrap:wrap;}',
      '.ang-rules{font-size:12px;line-height:1.5;}',
      /* Panels */
      '.ang-panel{padding:14px;display:flex;flex-direction:column;gap:9px;}',
      '.ang-board-wrap .mg-scoreboard{max-height:290px;overflow-y:auto;}',
      '.ang-chips{display:flex;flex-wrap:wrap;gap:6px;max-height:170px;overflow-y:auto;}',
      '.ang-none{color:var(--muted);font-size:13px;}',
      '.ang-word{display:inline-flex;align-items:center;gap:6px;padding:5px 10px;border-radius:999px;',
      'background:rgba(9,32,21,.8);border:1px solid var(--stroke-2);animation:ang-chipin .3s cubic-bezier(.2,.9,.3,1.3) both;}',
      '.ang-word b{font-size:13px;font-weight:800;color:var(--leaf);letter-spacing:.5px;}',
      '.ang-word i{font-size:11px;font-style:normal;font-weight:800;color:var(--muted);font-variant-numeric:tabular-nums;}',
      '.ang-word.len6,.ang-word.len7{border-color:var(--aqua);box-shadow:0 0 12px rgba(51,230,208,.3);}',
      '.ang-word.len6 i,.ang-word.len7 i{color:var(--aqua);}',
      '.ang-word.len8{border-color:var(--gold);box-shadow:0 0 16px rgba(255,210,63,.45);}',
      '.ang-word.len8 b{color:var(--gold);}',
      '.ang-word.len8 i{color:var(--gold);}',
      /* Endscreen-Zusatz */
      '.ang-endpanel{max-width:540px;margin:12px auto 0;}',
      '.ang-sol-title{margin:0;font-size:13px;font-weight:700;color:var(--muted);}',
      '.ang-perfect{color:var(--gold);}',
      '.ang-sols{display:flex;flex-wrap:wrap;gap:6px;}',
      '.ang-sol{display:inline-flex;align-items:center;gap:6px;padding:5px 10px;border-radius:999px;',
      'background:rgba(4,16,10,.7);border:1px solid var(--stroke);}',
      '.ang-sol b{font-size:13px;font-weight:800;color:var(--silver);letter-spacing:.5px;}',
      '.ang-sol i{font-size:11px;font-style:normal;font-weight:800;color:var(--bronze);}',
      /* Solo-Startbildschirm */
      '.ang-intro{padding:26px 22px;text-align:center;display:flex;flex-direction:column;gap:12px;align-items:center;max-width:540px;margin:0 auto;}',
      '.ang-intro-icon{font-size:56px;line-height:1;filter:drop-shadow(0 0 16px var(--stroke-2));animation:ang-bob 2.6s ease-in-out infinite;}',
      '.ang-intro h2{margin:0;}',
      '.ang-record{font-weight:800;color:var(--gold);font-size:15px;padding:6px 14px;border-radius:999px;',
      'background:rgba(40,32,6,.6);border:1px solid rgba(255,210,63,.4);}',
      '.ang-diff-row{display:flex;flex-wrap:wrap;gap:9px;justify-content:center;width:100%;}',
      '.ang-diff-btn{display:flex;flex-direction:column;align-items:center;gap:3px;padding:12px 10px;min-width:112px;flex:1 1 112px;',
      'max-width:150px;border-radius:14px;font-family:inherit;cursor:pointer;background:rgba(9,32,21,.7);',
      'border:1px solid var(--stroke);transition:transform .15s,border-color .15s,box-shadow .15s;}',
      '.ang-diff-btn:hover{transform:translateY(-3px);border-color:var(--neon);box-shadow:0 0 18px rgba(57,255,20,.35);}',
      '.ang-diff-btn.on{border-color:var(--aqua);box-shadow:0 0 16px rgba(51,230,208,.35);}',
      '.ang-diff-emoji{font-size:26px;line-height:1;}',
      '.ang-diff-name{font-size:15px;font-weight:900;color:var(--leaf);}',
      '.ang-diff-hint{font-size:11px;color:var(--muted);}',
      /* Warten auf den Seed (Multi) */
      '.ang-wait{padding:44px 24px;text-align:center;display:flex;flex-direction:column;gap:10px;align-items:center;max-width:440px;margin:0 auto;}',
      '.ang-wait-icon{font-size:56px;line-height:1;animation:ang-bob 1.8s ease-in-out infinite;}',
      '.ang-wait h2{margin:0;}',
      /* Animationen */
      '@keyframes ang-pop{from{opacity:0;transform:translateY(10px) scale(.7);}to{opacity:1;transform:translateY(0) scale(1);}}',
      '@keyframes ang-keyin{from{opacity:0;transform:translateY(-8px) scale(.86);}to{opacity:1;transform:none;}}',
      '@keyframes ang-chipin{from{opacity:0;transform:scale(.6);}to{opacity:1;transform:scale(1);}}',
      '@keyframes ang-shake{0%,100%{transform:translateX(0)}20%{transform:translateX(-8px)}60%{transform:translateX(8px)}}',
      '@keyframes ang-float{0%{opacity:0;transform:translate(-50%,6px) scale(.8);}25%{opacity:1;transform:translate(-50%,0) scale(1.1);}100%{opacity:0;transform:translate(-50%,-42px) scale(1);}}',
      '@keyframes ang-msgin{from{opacity:0;transform:translateY(-4px);}to{opacity:1;transform:none;}}',
      '@keyframes ang-bump{0%{transform:scale(1)}40%{transform:scale(1.22)}100%{transform:scale(1)}}',
      '@keyframes ang-pulse{0%,100%{opacity:1}50%{opacity:.4}}',
      '@keyframes ang-bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-7px)}}'
    ].join(''));
  }
})();
