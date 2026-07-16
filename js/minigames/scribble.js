/* scribble.js — "Montagsmaler": Zeichnen & Raten für 2–8 Spieler (nur online).
 *
 * SPIELIDEE  Reihum ist ein Spieler der Maler. Er bekommt drei Wortvorschläge,
 *            sucht sich eines aus und malt es in 75 s auf ein Canvas. Alle
 *            anderen tippen Rateversuche in ein Eingabefeld. Das Wort erscheint
 *            bei den Ratenden als Lücken-Muster (_ _ _ _) mit Buchstabenzahl;
 *            nach der halben Zeit klappt der erste Buchstabe auf, nach drei
 *            Vierteln noch einer. Jeder ist genau einmal Maler, danach Podest.
 *
 * STEUERUNG  Maler: zeichnen mit Maus/Finger (pointerdown/-move), 6 Farben,
 *            3 Pinselstärken, Radierer, "Alles löschen".
 *            Rater: Wort ins Eingabefeld tippen + Enter (oder Raten-Knopf).
 *
 * PUNKTE     Errater: 100 + bis zu 400 nach Restzeit (schnell = mehr).
 *            Maler: 40 % der Punkte jedes Erraters → klare Bilder lohnen sich.
 *
 * SYNC-MODELL  Alles läuft über room.setShared():
 *   { order:[ids], turn, painter, phase:'choose'|'draw'|'reveal'|'over',
 *     chooseEndAt, drawEndAt, revealAt, hash, len, mask, word, strokes, used }
 *   - Striche: [[farbe, stärke, x0,y0, x1,y1, …], …] — Punkte auf Ganzzahlen
 *     0–1000 quantisiert. Der Maler sammelt sie lokal und schickt sie gedrosselt
 *     (alle 170 ms ≈ 6×/s), alle anderen zeichnen sie nach. Farbe -1 = Radierer.
 *   - Das Wort steht während der Runde NIE im Klartext in shared, nur sein Hash.
 *     Rateversuche werden lokal gehasht und verglichen; der Klartext wandert
 *     erst beim Auflösen ins shared. (Kein echter Kopierschutz — die Wortliste
 *     liegt ja im Client — aber niemand liest das Wort aus Versehen mit.)
 *   - Rateversuche und Treffer laufen über room.reportState() (eigener Pfad je
 *     Spieler → keine Schreib-Kollisionen), Punkte über room.reportScore().
 *   - Der Host ist nur Schiedsrichter: Start, Rundenwechsel und Notbremse, wenn
 *     der Maler weg ist oder trödelt. Alle Zeiten über room.now() (Serverzeit),
 *     alle room.on()-Handler sind idempotent (Heartbeat feuert alle 4 s).
 *
 * cleanup() beendet Intervalle, Timeouts, requestAnimationFrame, alle Listener
 * und meldet jeden room.on()-Handler wieder ab (dead-Flag wie in reflex.js).
 */
(function () {
  'use strict';
  window.App = window.App || {}; App.Minigames = App.Minigames || {};
  var UI = App.UI, el = UI.el;

  injectStyle();

  /* ===================== Konstanten ===================== */
  var CW = 960, CH = 720;              // Canvas-Pixel (virtuell, CSS skaliert)
  var Q = 1000;                        // Quantisierung der Übertragung: 0–1000
  var DRAW_TIME = 75;                  // s Malzeit pro Runde
  var CHOOSE_TIME = 15;                // s zum Wort aussuchen
  var REVEAL_TIME = 6;                 // s Auflösung
  var SEND_MS = 170;                   // ≈ 6 Strich-Updates pro Sekunde
  var MIN_DIST = 5;                    // min. Abstand zweier Punkte (0–1000)
  var MAX_STROKES = 140, MAX_POINTS = 2400;
  var PAINTER_SHARE = 0.4;             // Anteil, den der Maler pro Errater bekommt
  var BASE_PTS = 100, TIME_PTS = 400;  // Errater-Punkte: BASE + TIME * Restzeit
  var ERASER_MUL = 2.4;                // Radierer ist breiter als der Pinsel

  var COLORS = ['#39ff14', '#33e6d0', '#ffd23f', '#ff4d6d', '#b06bff', '#f2f7f4'];
  var COLOR_NAMES = ['Neongrün', 'Aqua', 'Gold', 'Pink', 'Lila', 'Weiß'];
  var WIDTHS = [7, 16, 34];            // Pinselstärken in 0–1000-Einheiten
  var WIDTH_NAMES = ['Dünn', 'Mittel', 'Dick'];
  var WIDTH_DOTS = [4, 7, 11];         // Vorschau-Punkt im Knopf (px)
  var ALPHA = 'abcdefghijklmnopqrstuvwxyz';

  /* 180 gut malbare deutsche Begriffe */
  var WORDS = [
    'Baum', 'Haus', 'Katze', 'Hund', 'Sonne', 'Mond', 'Stern', 'Blume', 'Auto', 'Fahrrad',
    'Flugzeug', 'Schiff', 'Zug', 'Rakete', 'Roboter', 'Pizza', 'Hamburger', 'Banane', 'Apfel', 'Ananas',
    'Erdbeere', 'Kirsche', 'Zitrone', 'Karotte', 'Brokkoli', 'Pilz', 'Kaktus', 'Palme', 'Tanne', 'Wolke',
    'Regenbogen', 'Blitz', 'Schneemann', 'Vulkan', 'Insel', 'Berg', 'Brücke', 'Leuchtturm', 'Windmühle', 'Burg',
    'Zelt', 'Iglu', 'Kirche', 'Hochhaus', 'Treppe', 'Fenster', 'Schlüssel', 'Uhr', 'Wecker', 'Brille',
    'Krone', 'Schuh', 'Socke', 'Pullover', 'Handschuh', 'Regenschirm', 'Koffer', 'Rucksack', 'Geschenk', 'Torte',
    'Kerze', 'Luftballon', 'Drache', 'Einhorn', 'Dinosaurier', 'Hexe', 'Gespenst', 'Zombie', 'Vampir', 'Pirat',
    'Ritter', 'Cowboy', 'Clown', 'Astronaut', 'Taucher', 'Meerjungfrau', 'Elefant', 'Giraffe', 'Löwe', 'Tiger',
    'Zebra', 'Affe', 'Pinguin', 'Eule', 'Adler', 'Papagei', 'Schmetterling', 'Biene', 'Spinne', 'Schnecke',
    'Frosch', 'Schlange', 'Schildkröte', 'Krokodil', 'Hai', 'Wal', 'Delfin', 'Krake', 'Krabbe', 'Seestern',
    'Muschel', 'Igel', 'Fuchs', 'Wolf', 'Hase', 'Maus', 'Kuh', 'Schwein', 'Schaf', 'Pferd',
    'Ente', 'Fledermaus', 'Kamel', 'Känguru', 'Faultier', 'Waschbär', 'Gitarre', 'Klavier', 'Trommel', 'Trompete',
    'Geige', 'Mikrofon', 'Kopfhörer', 'Handy', 'Fernseher', 'Kamera', 'Lampe', 'Buch', 'Bleistift', 'Pinsel',
    'Schere', 'Hammer', 'Säge', 'Leiter', 'Besen', 'Eimer', 'Gabel', 'Löffel', 'Teller', 'Tasse',
    'Flasche', 'Topf', 'Kühlschrank', 'Waschmaschine', 'Stuhl', 'Bett', 'Sofa', 'Spiegel', 'Vase', 'Fußball',
    'Basketball', 'Skateboard', 'Schlittschuh', 'Angel', 'Schaukel', 'Rutsche', 'Karussell', 'Riesenrad', 'Achterbahn', 'Ampel',
    'Feuerwehr', 'Krankenwagen', 'Traktor', 'Bagger', 'Hubschrauber', 'Anker', 'Kompass', 'Schatzkarte', 'Diamant', 'Zauberstab',
    'Herz', 'Schneeflocke', 'Sanduhr', 'Briefkasten', 'Gartenzwerg', 'Vogelnest', 'Zahnbürste', 'Seifenblase', 'Regenwurm', 'Gießkanne'
  ];

  /* ===================== reine Helfer ===================== */

  /* Vergleichsform: klein geschrieben, ohne Leerzeichen, Umlaute ausgeschrieben. */
  function norm(s) {
    s = String(s == null ? '' : s).toLowerCase();
    s = s.replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss');
    return s.replace(/[^a-z0-9]/g, '');
  }
  /* Kleiner djb2-Hash → das Wort steht nie im Klartext im geteilten Zustand. */
  function hashOf(s) {
    var h = 5381, i;
    for (i = 0; i < s.length; i++) h = (((h * 33) >>> 0) ^ s.charCodeAt(i)) >>> 0;
    return h.toString(36);
  }
  /* "Fast richtig?" ohne das Wort zu kennen: alle Varianten mit Abstand 1 hashen. */
  function isNear(n, hash) {
    if (!n || !hash || n.length < 3 || n.length > 20) return false;
    var i, j, v;
    for (i = 0; i < n.length; i++) {                                  // ein Buchstabe zu viel
      if (hashOf(n.slice(0, i) + n.slice(i + 1)) === hash) return true;
    }
    for (i = 0; i + 1 < n.length; i++) {                              // zwei vertauscht
      v = n.slice(0, i) + n.charAt(i + 1) + n.charAt(i) + n.slice(i + 2);
      if (hashOf(v) === hash) return true;
    }
    for (i = 0; i <= n.length; i++) {                                 // ersetzt / fehlt einer
      for (j = 0; j < ALPHA.length; j++) {
        if (i < n.length && hashOf(n.slice(0, i) + ALPHA.charAt(j) + n.slice(i + 1)) === hash) return true;
        if (hashOf(n.slice(0, i) + ALPHA.charAt(j) + n.slice(i)) === hash) return true;
      }
    }
    return false;
  }
  /* Firebase liefert Arrays gelegentlich als Objekt mit Zahl-Schlüsseln zurück. */
  function toArr(v) {
    if (!v) return [];
    if (Array.isArray(v)) return v;
    if (typeof v !== 'object') return [];
    return Object.keys(v).sort(function (a, b) { return a - b; }).map(function (k) { return v[k]; });
  }
  function toStrokes(v) {
    return toArr(v).map(function (s) { return toArr(s); })
      .filter(function (s) { return s.length >= 4 && s.length % 2 === 0; });
  }
  function maskOf(w, rev) {
    var out = '', i, c;
    for (i = 0; i < w.length; i++) {
      c = w.charAt(i);
      if (c === ' ' || c === '-') out += c;
      else out += (rev.indexOf(i) >= 0 ? c.toUpperCase() : '_');
    }
    return out;
  }
  function letterCount(w) {
    var n = 0, i;
    for (i = 0; i < w.length; i++) { var c = w.charAt(i); if (c !== ' ' && c !== '-') n++; }
    return n;
  }
  function pickWords(used, n) {
    var usedArr = toArr(used);
    var pool = WORDS.filter(function (w) { return usedArr.indexOf(hashOf(norm(w))) < 0; });
    if (pool.length < n) pool = WORDS.slice();
    var out = [], tries = 0, w;
    while (out.length < n && tries < 500) {
      tries++;
      w = pool[Math.floor(Math.random() * pool.length)];
      if (out.indexOf(w) < 0) out.push(w);
    }
    return out;
  }

  /* ===================== Registrierung ===================== */
  App.Minigames.scribble = {
    id: 'scribble', title: 'Montagsmaler', icon: '🎨', order: 108,
    subtitle: 'Einer malt, alle raten — wer errät es zuerst?',
    single: false, multi: true, minPlayers: 2, maxPlayers: 8,

    render: function (root, ctx) {
      var room = ctx.room, me = ctx.me;

      /* ---- Laufzeit ---- */
      var dead = false;
      var stops = [];        // Aufräumer für die ganze Sitzung (Intervalle, room.off …)
      var viewStops = [];    // Aufräumer der aktuellen Ansicht (Timer der Ansicht)
      var pending = [];      // laufende setTimeout-IDs
      var rafId = null, needRedraw = false;

      var lastShared = (room.snapshot() && room.snapshot().shared) || null;
      var initDone = false, actKey = '', curView = '';
      var myScore = 0, seqCounter = 0;
      var myState = { k: -1, sv: 0, pv: 0, ms: [] };
      var seen = {};                                  // playerId → zuletzt gezeigte Nachricht
      var netDirty = false;

      /* Zustand der laufenden Runde (frisch bei jedem Malerwechsel) */
      var T = newTurnState(-1);

      /* DOM der Bühne */
      var g = null, canvasEl = null, feedEl = null, maskEl = null, infoEl = null;
      var wordBar = null, timeEl = null, barFill = null, ovEl = null;
      var inputEl = null, sendBtn = null, toolsEl = null;
      var lastMask = '', lastPhase = '', stageTurn = -1;

      /* Werkzeuge des Malers */
      var colorIdx = 0, widthIdx = 1, eraser = false;

      /* Rangliste einmal bauen und in jede Ansicht hängen (kein Neuaufbau) */
      var board = App.MG.liveBoard(room, me.id);
      stops.push(board.stop);
      var boardWrap = el('div', { class: 'glass scb-boardwrap' }, [
        el('div', { class: 'mg-field-title' }, ['🏆 Punkte']), board.root
      ]);

      /* ---- kleine Helfer ---- */
      function after(ms, fn) { var t = setTimeout(function () { if (!dead) fn(); }, ms); pending.push(t); return t; }
      function every(ms, fn) {
        var t = setInterval(function () { if (dead) { clearInterval(t); return; } fn(); }, ms);
        stops.push(function () { clearInterval(t); });
        return t;
      }
      function clearViewStops() { viewStops.forEach(function (f) { try { f(); } catch (e) {} }); viewStops = []; }
      function cleanup() {
        dead = true;
        pending.forEach(clearTimeout); pending = [];
        if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
        clearViewStops();
        stops.forEach(function (f) { try { f(); } catch (e) {} }); stops = [];
      }
      function sfx(n) { if (App.Audio) App.Audio.sfx(n); }
      function nameOf(id, players) {
        for (var i = 0; i < players.length; i++) if (players[i].id === id) return players[i].name;
        return 'Spieler';
      }
      function isPresent(id, players) {
        for (var i = 0; i < players.length; i++) if (players[i].id === id) return true;
        return false;
      }
      function amPainter(sh) { return !!sh && sh.painter === me.id; }
      /* Schreiben in den geteilten Zustand — und die eigene Sicht sofort
       * nachziehen: der Local-Transport (mehrere Tabs) meldet dem Schreiber
       * seine eigene Änderung nicht zurück, Peer/Firebase erst nach dem
       * Rückweg. Deshalb den Merge (null = Schlüssel löschen) lokal vorwegnehmen
       * → keine Ansicht wartet je auf ihr eigenes Echo. */
      function share(patch, quiet) {
        var cur = lastShared || {}, next = {}, k;
        for (k in cur) if (Object.prototype.hasOwnProperty.call(cur, k)) next[k] = cur[k];
        Object.keys(patch).forEach(function (p) {
          if (patch[p] === null) delete next[p]; else next[p] = patch[p];
        });
        lastShared = next;
        room.setShared(patch);
        if (!quiet) sync();
      }
      function newTurnState(t) {
        return {
          turn: t, choices: null, word: null, chosen: false,
          revealed: [], hint1: false, hint2: false,
          solved: false, solvedIds: {}, solvedCount: 0,
          ended: false, endScheduled: false, warned: false,
          strokes: []
        };
      }

      /* ---- Start: erst der gemeinsame 3-2-1-Countdown ---- */
      var snap = room.snapshot() || {};
      var startAt = (snap.round && snap.round.startAt) || (room.now() + 3000);
      stops.push(App.MG.countdown(root, startAt, function () { play(); }, room.now));
      return { cleanup: cleanup };

      /* ===================================================================
       *  SPIEL
       * =================================================================== */
      function play() {
        if (dead) return;
        myScore = 0;
        room.reportScore(0);
        room.reportState(myState);

        var onShared = function (sh) { if (dead) return; lastShared = sh; sync(); };
        var onPlayers = function () { if (dead) return; sync(); };
        room.on('shared', onShared);
        room.on('players', onPlayers);
        stops.push(function () { room.off('shared', onShared); });
        stops.push(function () { room.off('players', onPlayers); });

        every(SEND_MS, pumpStrokes);   // Maler: Striche gedrosselt senden
        every(600, hostTick);          // Host: Schiedsrichter
        sync();
      }

      /* ---- Der Host hält den Ablauf am Laufen ---- */
      function hostTick() {
        if (!room.isHost()) return;
        var players = room.players(), sh = lastShared;
        if (!sh || !sh.order) {
          if (!initDone && players.length >= 2) { initDone = true; initShared(players); }
          return;
        }
        if (sh.phase === 'over') return;
        if (players.length < 2) { share({ phase: 'over' }); return; }

        var now = room.now(), here = isPresent(sh.painter, players);
        if (sh.phase === 'choose') {
          // Maler weg oder trödelt → Runde überspringen
          if (!here || now > (sh.chooseEndAt || 0) + 2500) act(sh, nextTurn);
        } else if (sh.phase === 'draw') {
          // Notbremse: normalerweise löst der Maler selbst auf
          if (!here || now > (sh.drawEndAt || 0) + 3500) {
            act(sh, function () { share({ phase: 'reveal', revealAt: room.now() + REVEAL_TIME * 1000 }); });
          }
        } else if (sh.phase === 'reveal') {
          if (now >= (sh.revealAt || 0)) act(sh, nextTurn);
        }
      }
      /* Jede Zwangs-Aktion höchstens einmal pro Runde+Phase (Events feuern oft). */
      function act(sh, fn) {
        var key = sh.turn + ':' + sh.phase;
        if (actKey === key) return;
        actKey = key;
        fn();
      }
      function initShared(players) {
        var order = players.map(function (p) { return p.id; });
        share({
          order: order, turn: 0, painter: order[0], phase: 'choose',
          chooseEndAt: room.now() + CHOOSE_TIME * 1000,
          used: null, strokes: null, hash: null, word: null, mask: null, len: null,
          drawEndAt: null, revealAt: null
        });
      }
      function nextTurn() {
        var sh = lastShared; if (!sh) return;
        var players = room.players();
        var order = toArr(sh.order), t = (sh.turn || 0) + 1;
        while (t < order.length && !isPresent(order[t], players)) t++;   // Ausgestiegene überspringen
        if (t >= order.length) { share({ phase: 'over' }); return; }
        share({
          turn: t, painter: order[t], phase: 'choose',
          chooseEndAt: room.now() + CHOOSE_TIME * 1000,
          strokes: null, hash: null, word: null, mask: null, len: null,
          drawEndAt: null, revealAt: null
        });
      }

      /* ---- Zentrale Ansicht-Weiche (idempotent, baut nichts doppelt) ---- */
      function sync() {
        if (dead) return;
        var sh = lastShared, players = room.players();
        if (!sh || !sh.order) { showWait(players, false); return; }
        ensureTurn(sh.turn || 0);
        if (sh.phase === 'over') { showOver(players); return; }
        if (players.length < 2) { showWait(players, true); return; }
        if (sh.phase === 'choose') { showChoose(sh, players); return; }
        showStage(sh, players);
      }
      function ensureTurn(t) {
        if (T.turn === t) return;
        T = newTurnState(t);
        eraser = false;
        myState = { k: t, sv: 0, pv: 0, ms: [] };
        room.reportState(myState);
      }

      /* ===================== Ansicht: Wort aussuchen ===================== */
      function showChoose(sh, players) {
        var key = 'choose:' + sh.turn;
        if (curView === key) return;
        curView = key;
        clearViewStops();

        var isP = amPainter(sh);
        var pname = nameOf(sh.painter, players);
        var cdEl = el('div', { class: 'scb-cd' }, [CHOOSE_TIME + 's']);
        var fill = el('div', { class: 'scb-bar-fill' });
        var body;

        if (isP) {
          if (!T.choices) T.choices = pickWords(sh.used, 3);
          var cards = T.choices.map(function (w) {
            return el('button', { class: 'scb-card', type: 'button', onclick: function () { chooseWord(w); } }, [
              el('span', { class: 'scb-card-w' }, [w]),
              el('span', { class: 'scb-card-h' }, [letterCount(w) + ' Buchstaben'])
            ]);
          });
          body = el('div', { class: 'glass scb-choose' }, [
            el('div', { class: 'scb-choose-icon' }, ['🎨']),
            el('h3', { class: 'neon' }, ['Du bist dran — such dir ein Wort aus!']),
            el('p', { class: 'hint-text' }, ['Danach hast du ' + DRAW_TIME + ' Sekunden zum Malen.']),
            el('div', { class: 'scb-cards' }, cards),
            el('div', { class: 'scb-cd-row' }, [cdEl, el('div', { class: 'scb-bar' }, [fill])])
          ]);
        } else {
          body = el('div', { class: 'glass scb-choose' }, [
            el('div', { class: 'scb-choose-icon scb-spin' }, ['🎨']),
            el('h3', { class: 'neon' }, [pname + ' sucht ein Wort aus …']),
            el('p', { class: 'hint-text' }, ['Finger locker machen — gleich wird geraten!']),
            el('div', { class: 'scb-cd-row' }, [cdEl, el('div', { class: 'scb-bar' }, [fill])])
          ]);
        }

        root.innerHTML = '';
        root.appendChild(el('div', { class: 'scb-wrap' }, [
          headRow(sh, players, null), body, rulesLine(sh), boardWrap
        ]));

        var endAt = sh.chooseEndAt || (room.now() + CHOOSE_TIME * 1000);
        viewStops.push(App.MG.roundTimer(endAt, function (left) {
          cdEl.textContent = Math.ceil(left) + 's';
          fill.style.width = Math.max(0, Math.min(100, (left / CHOOSE_TIME) * 100)) + '%';
        }, function () {
          // Nicht ausgesucht? Dann entscheidet der Zufall.
          if (!isP || T.chosen || !lastShared || lastShared.phase !== 'choose') return;
          chooseWord(T.choices[Math.floor(Math.random() * T.choices.length)]);
        }, room.now));
      }

      function chooseWord(w) {
        if (T.chosen || dead) return;
        T.chosen = true; T.word = w;
        var n = norm(w);
        var used = toArr(lastShared && lastShared.used).slice();
        used.push(hashOf(n));
        while (used.length > 80) used.shift();
        sfx('select');
        share({
          phase: 'draw', hash: hashOf(n), len: letterCount(w), mask: maskOf(w, []),
          word: null, strokes: null, used: used,
          drawEndAt: room.now() + DRAW_TIME * 1000, revealAt: null
        });
      }

      /* ===================== Ansicht: Bühne (malen + raten + auflösen) ===================== */
      function showStage(sh, players) {
        var key = 'stage:' + sh.turn;
        if (curView !== key) { buildStage(sh, players); curView = key; }
        updateStage(sh, players);
      }

      function buildStage(sh, players) {
        clearViewStops();
        stageTurn = sh.turn;
        lastMask = ''; lastPhase = '';
        var isP = amPainter(sh);

        /* Wort-Leiste: Maler sieht sein Wort, alle anderen das Lücken-Muster */
        maskEl = el('div', { class: 'scb-mask' });
        infoEl = el('div', { class: 'scb-wordinfo' }, ['']);
        wordBar = el('div', { class: 'glass scb-wordbar' }, [maskEl, infoEl]);

        /* Canvas + Auflösungs-Overlay */
        canvasEl = el('canvas', { class: 'scb-canvas' + (isP ? ' scb-draw' : ''), width: CW, height: CH });
        ovEl = el('div', { class: 'scb-ov scb-hide' });
        var stage = el('div', { class: 'scb-stage' }, [canvasEl, ovEl]);
        g = canvasEl.getContext('2d');

        /* Werkzeuge (nur Maler) bzw. Rate-Zeile (alle anderen) */
        toolsEl = isP ? buildTools() : null;
        var guessRow = null;
        if (!isP) {
          inputEl = el('input', {
            class: 'text-input scb-input', type: 'text', maxlength: 24,
            placeholder: 'Was ist das?', autocomplete: 'off', autocorrect: 'off', spellcheck: 'false'
          });
          inputEl.addEventListener('keydown', function (e) {
            if (e.key === 'Enter') { e.preventDefault(); submitGuess(); }
          });
          sendBtn = el('button', { class: 'btn btn-aqua scb-send', type: 'button', onclick: submitGuess }, ['Raten']);
          guessRow = el('div', { class: 'scb-guessrow' }, [inputEl, sendBtn]);
        } else {
          inputEl = null; sendBtn = null;
        }

        feedEl = el('div', { class: 'scb-feed' }, [el('div', { class: 'scb-msg scb-msg-sys' }, ['Los geht\'s!'])]);

        timeEl = el('div', { class: 'mg-timer scb-time' }, ['']);
        barFill = el('div', { class: 'scb-bar-fill' });
        var head = headRow(sh, players, timeEl);

        root.innerHTML = '';
        root.appendChild(el('div', { class: 'scb-wrap' }, [
          head, el('div', { class: 'scb-bar' }, [barFill]), wordBar, stage,
          toolsEl, guessRow, rulesLine(sh), feedEl, boardWrap
        ]));

        if (isP) attachDraw();
        T.strokes = isP ? T.strokes : toStrokes(sh.strokes);
        markDirty();

        /* Rundenuhr: Anzeige, Buchstaben-Tipps und (beim Maler) das Auflösen */
        var endAt = sh.drawEndAt || room.now();
        viewStops.push(App.MG.roundTimer(endAt, function (left) {
          if (stageTurn !== T.turn) return;
          timeEl.textContent = App.MG.mmss(left);
          var pct = Math.max(0, Math.min(100, (left / DRAW_TIME) * 100));
          barFill.style.width = pct + '%';
          var low = left <= 10 && left > 0;
          timeEl.classList.toggle('scb-urgent', low);
          barFill.classList.toggle('scb-low', left <= DRAW_TIME * 0.34);
          if (amPainter(lastShared) && lastShared && lastShared.phase === 'draw') {
            if (!T.hint1 && left <= DRAW_TIME / 2) giveHint(1);
            else if (!T.hint2 && left <= DRAW_TIME / 4) giveHint(2);
          }
        }, function () {
          if (amPainter(lastShared)) painterReveal();
        }, room.now));
      }

      function buildTools() {
        var swatches = COLORS.map(function (c, i) {
          var b = el('button', {
            class: 'scb-sw' + (i === colorIdx && !eraser ? ' on' : ''), type: 'button',
            title: COLOR_NAMES[i], style: 'background:' + c + ';',
            onclick: function () { colorIdx = i; eraser = false; refreshTools(); sfx('click'); }
          });
          b.dataset.sw = String(i);
          return b;
        });
        var widths = WIDTHS.map(function (w, i) {
          var b = el('button', {
            class: 'scb-wbtn' + (i === widthIdx ? ' on' : ''), type: 'button', title: WIDTH_NAMES[i],
            onclick: function () { widthIdx = i; refreshTools(); sfx('click'); }
          }, [el('span', { class: 'scb-dot', style: 'width:' + WIDTH_DOTS[i] + 'px;height:' + WIDTH_DOTS[i] + 'px;' })]);
          b.dataset.w = String(i);
          return b;
        });
        var eraseBtn = el('button', {
          class: 'chip scb-erase' + (eraser ? ' on' : ''), type: 'button',
          onclick: function () { eraser = !eraser; refreshTools(); sfx('click'); }
        }, ['🧽 Radierer']);
        eraseBtn.dataset.erase = '1';
        var clearBtn = el('button', {
          class: 'chip scb-clear', type: 'button',
          onclick: function () {
            if (!canDraw()) return;
            T.strokes = []; T.warned = false; netDirty = true; markDirty();
            sfx('whoosh');
          }
        }, ['🗑 Alles löschen']);
        return el('div', { class: 'scb-tools' },
          swatches.concat([el('span', { class: 'scb-sep' })], widths, [el('span', { class: 'scb-sep' }), eraseBtn, clearBtn]));
      }
      function refreshTools() {
        if (!toolsEl) return;
        var i, n, nodes = toolsEl.querySelectorAll('.scb-sw');
        for (i = 0; i < nodes.length; i++) { n = nodes[i]; n.classList.toggle('on', !eraser && Number(n.dataset.sw) === colorIdx); }
        nodes = toolsEl.querySelectorAll('.scb-wbtn');
        for (i = 0; i < nodes.length; i++) { n = nodes[i]; n.classList.toggle('on', Number(n.dataset.w) === widthIdx); }
        n = toolsEl.querySelector('.scb-erase');
        if (n) n.classList.toggle('on', eraser);
      }

      function headRow(sh, players, timerNode) {
        var order = toArr(sh.order);
        var isP = amPainter(sh);
        var pname = isP ? 'Du malst' : nameOf(sh.painter, players) + ' malt';
        return el('div', { class: 'glass scb-head' }, [
          el('div', { class: 'scb-turn' }, ['Runde ' + ((sh.turn || 0) + 1) + ' / ' + Math.max(1, order.length)]),
          el('div', { class: 'scb-painter' + (isP ? ' me' : '') }, [
            el('span', { class: 'scb-pal' }, ['🎨']), el('span', { class: 'scb-pname' }, [pname])
          ]),
          timerNode || el('div', { class: 'scb-turn' }, [''])
        ]);
      }
      function rulesLine(sh) {
        var isP = amPainter(sh);
        return el('p', { class: 'hint-text scb-rules' }, [isP
          ? '🖌 Malen mit Maus/Finger · Farben & Stärke unten · keine Buchstaben oder Zahlen malen!'
          : '⌨ Wort eintippen + Enter · je schneller, desto mehr Punkte · Maler bekommt 40 % davon']);
      }

      /* ---- Bühne aktualisieren (läuft bei jedem Event, muss billig sein) ---- */
      function updateStage(sh, players) {
        if (stageTurn !== sh.turn) return;

        /* Wort-Muster / eigenes Wort */
        var isP = amPainter(sh);
        var str = isP ? (T.word || sh.mask || '') : (sh.mask || '');
        if (str !== lastMask) {
          var hadOne = !!lastMask;
          lastMask = str;
          renderMask(str, isP);
          if (hadOne && !isP) {           // Buchstaben-Tipp ist aufgeklappt
            wordBar.classList.remove('scb-flash'); void wordBar.offsetWidth; wordBar.classList.add('scb-flash');
            sfx('ding');
          }
        }
        infoEl.textContent = isP ? 'Dein Wort' : ((sh.len || letterCount(str)) + ' Buchstaben' + (T.solved ? ' · erraten! 🎉' : ''));

        /* Striche der anderen übernehmen (der Maler ist selbst die Quelle) */
        if (!isP) { T.strokes = toStrokes(sh.strokes); markDirty(); }

        /* Rateversuche + Treffer aus den Spieler-Zuständen einsammeln */
        pumpFeed(sh, players);

        /* Rate-Feld sperren, sobald erraten oder aufgelöst */
        if (inputEl) {
          var locked = T.solved || sh.phase !== 'draw';
          inputEl.disabled = locked;
          if (sendBtn) sendBtn.disabled = locked;
          inputEl.placeholder = T.solved ? 'Erraten! 🎉' : (sh.phase === 'draw' ? 'Was ist das?' : 'Runde vorbei');
        }

        /* Auflösung */
        if (sh.phase !== lastPhase) {
          lastPhase = sh.phase;
          if (sh.phase === 'reveal') {
            if (toolsEl) toolsEl.classList.add('scb-off');
            showReveal(sh, players);
          }
        } else if (sh.phase === 'reveal') {
          updateRevealTimer(sh);
        }
      }

      function renderMask(str, isP) {
        maskEl.innerHTML = '';
        for (var i = 0; i < str.length; i++) {
          var ch = str.charAt(i);
          if (ch === ' ') { maskEl.appendChild(el('span', { class: 'scb-gap' })); continue; }
          var open = ch !== '_';
          maskEl.appendChild(el('span', { class: 'scb-ch' + (open ? ' on' : '') + (isP ? ' scb-mine' : '') },
            [open ? ch.toUpperCase() : '_']));
        }
      }

      /* ---- Auflösungs-Overlay ---- */
      var ovTimeEl = null;
      function showReveal(sh, players) {
        sfx(T.solved ? 'win' : 'info');
        var solvers = players.filter(function (p) { return p.state && p.state.k === sh.turn && p.state.sv; })
          .sort(function (a, b) { return (a.state.sv || 0) - (b.state.sv || 0); });
        var rows = solvers.map(function (p) {
          return el('div', { class: 'scb-ov-row' + (p.id === me.id ? ' me' : '') }, [
            el('span', { class: 'scb-ov-nm' }, ['✅ ' + p.name]),
            el('span', { class: 'scb-ov-pts' }, ['+' + App.MG.fmt(p.state.pv || 0)])
          ]);
        });
        if (!rows.length) rows = [el('div', { class: 'scb-ov-none' }, ['Niemand hat es erraten 😅'])];
        ovTimeEl = el('div', { class: 'scb-ov-time' }, ['']);
        ovEl.innerHTML = '';
        ovEl.appendChild(el('div', { class: 'scb-ov-in' }, [
          el('div', { class: 'scb-ov-l' }, ['Das Wort war']),
          el('div', { class: 'scb-ov-word neon-strong' }, [sh.word || '???']),
          el('div', { class: 'scb-ov-list' }, rows),
          ovTimeEl
        ]));
        ovEl.classList.remove('scb-hide');
        updateRevealTimer(sh);
      }
      function updateRevealTimer(sh) {
        if (!ovTimeEl) return;
        var left = Math.max(0, Math.ceil(((sh.revealAt || 0) - room.now()) / 1000));
        ovTimeEl.textContent = 'Weiter in ' + left + ' …';
      }

      /* ===================== Zeichnen ===================== */
      function canDraw() {
        return !!lastShared && lastShared.phase === 'draw' && amPainter(lastShared) && !T.ended;
      }
      function totalPoints() {
        var n = 0, i;
        for (i = 0; i < T.strokes.length; i++) n += (T.strokes[i].length - 2) / 2;
        return n;
      }
      function attachDraw() {
        var drawing = false, cur = null, lastX = 0, lastY = 0;
        function pos(e) {
          var r = canvasEl.getBoundingClientRect();
          var x = Math.round((e.clientX - r.left) / (r.width || 1) * Q);
          var y = Math.round((e.clientY - r.top) / (r.height || 1) * Q);
          return { x: Math.max(0, Math.min(Q, x)), y: Math.max(0, Math.min(Q, y)) };
        }
        function down(e) {
          if (!canDraw()) return;
          e.preventDefault();
          if (T.strokes.length >= MAX_STROKES || totalPoints() >= MAX_POINTS) { warnFull(); return; }
          try { canvasEl.setPointerCapture(e.pointerId); } catch (err) {}
          var p = pos(e);
          cur = [eraser ? -1 : colorIdx, widthIdx, p.x, p.y];
          T.strokes.push(cur);
          drawing = true; lastX = p.x; lastY = p.y;
          netDirty = true; markDirty();
        }
        function move(e) {
          if (!drawing || !cur) return;
          e.preventDefault();
          var p = pos(e), dx = p.x - lastX, dy = p.y - lastY;
          if (dx * dx + dy * dy < MIN_DIST * MIN_DIST) return;
          if (totalPoints() >= MAX_POINTS) { warnFull(); return; }
          cur.push(p.x, p.y); lastX = p.x; lastY = p.y;
          netDirty = true; markDirty();
        }
        function up() {
          if (!drawing) return;
          drawing = false; cur = null; netDirty = true;
        }
        canvasEl.addEventListener('pointerdown', down);
        canvasEl.addEventListener('pointermove', move);
        canvasEl.addEventListener('pointerup', up);
        canvasEl.addEventListener('pointercancel', up);
        window.addEventListener('pointerup', up);
        viewStops.push(function () {
          canvasEl.removeEventListener('pointerdown', down);
          canvasEl.removeEventListener('pointermove', move);
          canvasEl.removeEventListener('pointerup', up);
          canvasEl.removeEventListener('pointercancel', up);
          window.removeEventListener('pointerup', up);
        });
      }
      function warnFull() {
        if (T.warned) return;
        T.warned = true;
        UI.toast('Zeichenfläche voll — lösch mal was 🗑', 'info');
      }

      function markDirty() {
        needRedraw = true;
        if (!rafId) rafId = requestAnimationFrame(paintFrame);
      }
      function paintFrame() {
        rafId = null;
        if (dead || !g || !needRedraw) return;
        needRedraw = false;
        redraw();
      }
      function redraw() {
        var sx = CW / Q, sy = CH / Q;
        g.clearRect(0, 0, CW, CH);
        for (var i = 0; i < T.strokes.length; i++) {
          var s = T.strokes[i];
          var c = s[0], wi = s[1];
          var w = WIDTHS[Math.max(0, Math.min(WIDTHS.length - 1, wi | 0))] * sx;
          g.save();
          g.lineCap = 'round'; g.lineJoin = 'round';
          if (c < 0) { g.globalCompositeOperation = 'destination-out'; g.strokeStyle = '#000'; g.fillStyle = '#000'; g.lineWidth = w * ERASER_MUL; }
          else {
            var col = COLORS[Math.max(0, Math.min(COLORS.length - 1, c | 0))];
            g.globalCompositeOperation = 'source-over';
            g.strokeStyle = col; g.fillStyle = col; g.lineWidth = w;
            g.shadowColor = col; g.shadowBlur = 8;
          }
          if (s.length === 4) {
            g.beginPath(); g.arc(s[2] * sx, s[3] * sy, g.lineWidth / 2, 0, Math.PI * 2); g.fill();
          } else {
            g.beginPath(); g.moveTo(s[2] * sx, s[3] * sy);
            for (var j = 4; j < s.length; j += 2) g.lineTo(s[j] * sx, s[j + 1] * sy);
            g.stroke();
          }
          g.restore();
        }
      }
      /* Maler: gesammelte Striche gedrosselt verschicken (≈ 6×/s) */
      function pumpStrokes() {
        if (!netDirty) return;
        var sh = lastShared;
        if (!sh || sh.phase !== 'draw' || !amPainter(sh)) { netDirty = false; return; }
        netDirty = false;
        share({ strokes: T.strokes.length ? T.strokes : null }, true);   // Maler zeichnet selbst schon lokal
      }

      /* ===================== Tipps & Auflösen (Maler) ===================== */
      function giveHint(step) {
        var w = T.word; if (!w) return;
        if (step === 1) {
          if (T.hint1) return;
          T.hint1 = true;
          T.revealed = [firstLetterIdx(w)];
        } else {
          if (T.hint2) return;
          T.hint2 = true;
          var free = [];
          for (var i = 0; i < w.length; i++) {
            var c = w.charAt(i);
            if (c === ' ' || c === '-') continue;
            if (T.revealed.indexOf(i) < 0) free.push(i);
          }
          if (!free.length) return;
          T.revealed.push(free[Math.floor(Math.random() * free.length)]);
        }
        share({ mask: maskOf(w, T.revealed) });
      }
      function firstLetterIdx(w) {
        for (var i = 0; i < w.length; i++) { var c = w.charAt(i); if (c !== ' ' && c !== '-') return i; }
        return 0;
      }
      function painterReveal() {
        var sh = lastShared;
        if (dead || T.ended || !sh || sh.phase !== 'draw' || !amPainter(sh)) return;
        T.ended = true;
        netDirty = false;
        share({
          strokes: T.strokes.length ? T.strokes : null,
          phase: 'reveal', word: T.word || null, revealAt: room.now() + REVEAL_TIME * 1000
        });
      }

      /* ===================== Raten ===================== */
      function submitGuess() {
        var sh = lastShared;
        if (!inputEl || !sh || sh.phase !== 'draw' || T.solved || amPainter(sh)) return;
        var raw = String(inputEl.value || '').trim().slice(0, 24);
        inputEl.value = '';
        var n = norm(raw);
        if (!n) return;

        if (sh.hash && hashOf(n) === sh.hash) { solve(sh); return; }

        addMsg(me.name, raw, true);
        seqCounter++;
        myState.ms.push({ q: seqCounter, x: raw });
        while (myState.ms.length > 3) myState.ms.shift();
        room.reportState(myState);

        if (isNear(n, sh.hash)) {
          addMsg(null, '🔥 Ganz nah dran!', false, 'scb-msg-near');
          if (App.Audio) App.Audio.blip(880, 0.08);
        } else {
          if (App.Audio) App.Audio.blip(240, 0.05);
        }
      }
      function solve(sh) {
        if (T.solved) return;
        T.solved = true;
        var left = Math.max(0, Math.min(DRAW_TIME, ((sh.drawEndAt || 0) - room.now()) / 1000));
        var pts = BASE_PTS + Math.round(TIME_PTS * (left / DRAW_TIME));
        myScore += pts;
        T.solvedIds[me.id] = pts; T.solvedCount++;
        myState.sv = room.now(); myState.pv = pts;
        room.reportState(myState);
        room.reportScore(myScore);
        addSolved('Du', pts, true);
        sfx('win');
        if (UI.flash) { try { UI.flash(0); } catch (e) {} }
        UI.toast('Richtig! +' + pts + ' Punkte 🎉', 'win');
        if (inputEl) { inputEl.disabled = true; inputEl.placeholder = 'Erraten! 🎉'; }
        if (sendBtn) sendBtn.disabled = true;
      }

      /* ---- Rateversuche/Treffer der anderen aus deren Spieler-Zustand lesen ---- */
      function pumpFeed(sh, players) {
        players.forEach(function (p) {
          var s = p.state;
          if (!s || s.k !== sh.turn) return;
          if (p.id !== me.id) {
            toArr(s.ms).forEach(function (m) {
              if (!m || typeof m.q !== 'number') return;
              if (m.q <= (seen[p.id] || 0)) return;
              seen[p.id] = m.q;
              addMsg(p.name, String(m.x == null ? '' : m.x).slice(0, 24), false);
            });
          }
          /* Schlüssel-Prüfung statt Wahrheitswert: käme pv je als 0 an, würde
           * !T.solvedIds[p.id] bei JEDEM Event erneut zuschlagen (Verlauf-Spam,
           * falscher Zähler, doppelter Maler-Anteil). */
          if (s.sv && !Object.prototype.hasOwnProperty.call(T.solvedIds, p.id)) {
            T.solvedIds[p.id] = s.pv || 0;
            T.solvedCount++;
            if (p.id !== me.id) {
              addSolved(p.name, s.pv || 0, false);
              sfx('point');
              if (amPainter(sh)) {                       // Maler kassiert seinen Anteil
                var bonus = Math.round((s.pv || 0) * PAINTER_SHARE);
                myScore += bonus;
                room.reportScore(myScore);
                addMsg(null, '🎨 Dein Anteil: +' + bonus + ' Punkte', false, 'scb-msg-bonus');
              }
            }
            maybeAllSolved(sh, players);
          }
        });
      }
      /* Alle haben es? Dann muss der Maler nicht die vollen 75 s absitzen. */
      function maybeAllSolved(sh, players) {
        if (!amPainter(sh) || sh.phase !== 'draw' || T.ended || T.endScheduled) return;
        var guessers = players.length - 1;
        if (guessers > 0 && T.solvedCount >= guessers) {
          T.endScheduled = true;
          after(900, painterReveal);
        }
      }

      /* ---- Chat-Verlauf ---- */
      function addMsg(who, text, mine, extra) {
        if (!feedEl) return;
        var kids = who
          ? [el('span', { class: 'scb-msg-w' }, [who + ':']), el('span', { class: 'scb-msg-t' }, [text])]
          : [el('span', { class: 'scb-msg-t' }, [text])];
        push(el('div', { class: 'scb-msg' + (mine ? ' me' : '') + (extra ? ' ' + extra : '') }, kids));
      }
      function addSolved(who, pts, mine) {
        push(el('div', { class: 'scb-msg scb-msg-ok' + (mine ? ' me' : '') }, [
          el('span', { class: 'scb-msg-t' }, ['✅ ' + who + ' hat das Wort erraten!']),
          el('span', { class: 'scb-msg-p' }, ['+' + App.MG.fmt(pts)])
        ]));
      }
      function push(node) {
        if (!feedEl) return;
        var first = feedEl.firstChild;
        if (first && first.classList && first.classList.contains('scb-msg-sys')) feedEl.removeChild(first);
        feedEl.appendChild(node);
        while (feedEl.childNodes.length > 40) feedEl.removeChild(feedEl.firstChild);
        feedEl.scrollTop = feedEl.scrollHeight;
      }

      /* ===================== Warten / Ende ===================== */
      function showWait(players, starting) {
        if (curView === 'wait') return;
        curView = 'wait';
        clearViewStops();
        root.innerHTML = '';
        root.appendChild(el('div', { class: 'glass scb-panel' }, [
          el('div', { class: 'scb-choose-icon scb-spin' }, ['🎨']),
          el('h2', { class: 'neon' }, ['Montagsmaler']),
          el('p', { class: 'hint-text' }, [starting
            ? 'Warte auf Mitspieler … (mindestens 2)'
            : 'Spiel wird vorbereitet …']),
          el('div', { class: 'controls-row' }, [
            el('button', { class: 'btn btn-ghost', type: 'button', onclick: ctx.onExit }, ['Zurück zur Lobby'])
          ])
        ]));
      }
      function showOver(players) {
        if (curView === 'over') return;
        curView = 'over';
        clearViewStops();
        if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
        App.MG.endScreen(root, { players: players, meId: me.id, onExit: ctx.onExit });
      }
    }
  };

  /* ===================== STYLES ===================== */
  function injectStyle() {
    UI.injectStyle('mg-scribble-css', [
      '.scb-wrap{display:flex;flex-direction:column;gap:11px;width:100%;max-width:600px;margin:0 auto;}',
      /* Kopf */
      '.scb-head{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:9px 14px;}',
      '.scb-turn{font-size:11px;font-weight:800;color:var(--muted);text-transform:uppercase;letter-spacing:1px;min-width:64px;}',
      '.scb-painter{display:flex;align-items:center;gap:6px;min-width:0;font-weight:900;font-size:clamp(13px,3.6vw,16px);color:var(--aqua);text-shadow:0 0 12px rgba(51,230,208,.45);}',
      '.scb-painter.me{color:var(--gold);text-shadow:0 0 12px rgba(255,210,63,.5);}',
      '.scb-pname{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      '.scb-pal{font-size:17px;display:inline-block;animation:scb-wiggle 2.2s ease-in-out infinite;}',
      '@keyframes scb-wiggle{0%,100%{transform:rotate(-9deg)}50%{transform:rotate(9deg)}}',
      '.scb-time{min-width:64px;text-align:right;font-variant-numeric:tabular-nums;font-size:clamp(15px,4vw,20px);}',
      '.scb-time.scb-urgent{color:var(--danger);animation:scb-blink .7s ease-in-out infinite;}',
      '@keyframes scb-blink{0%,100%{opacity:1}50%{opacity:.35}}',
      /* Zeitbalken */
      '.scb-bar{height:6px;border-radius:99px;background:rgba(4,16,10,.85);border:1px solid var(--stroke);overflow:hidden;flex:1;}',
      '.scb-bar-fill{height:100%;width:100%;border-radius:99px;background:linear-gradient(90deg,var(--neon),var(--aqua));box-shadow:0 0 10px var(--stroke-2);transition:width .12s linear;}',
      '.scb-bar-fill.scb-low{background:linear-gradient(90deg,var(--danger),var(--gold));}',
      /* Wort-Leiste */
      '.scb-wordbar{padding:9px 14px;display:flex;flex-direction:column;gap:5px;align-items:center;}',
      '.scb-wordbar.scb-flash{animation:scb-flash .7s ease;}',
      '@keyframes scb-flash{0%,100%{box-shadow:none}40%{box-shadow:0 0 26px var(--stroke-2);}}',
      '.scb-mask{display:flex;gap:5px;flex-wrap:wrap;justify-content:center;}',
      '.scb-ch{width:17px;height:25px;display:flex;align-items:flex-end;justify-content:center;line-height:1;font-weight:900;font-size:19px;color:var(--muted);border-bottom:2px solid var(--stroke);}',
      '.scb-ch.on{color:var(--neon);border-bottom-color:var(--neon);text-shadow:0 0 10px rgba(57,255,20,.6);animation:scb-pop .35s cubic-bezier(.2,.8,.3,1.4);}',
      '.scb-ch.scb-mine.on{color:var(--gold);border-bottom-color:var(--gold);text-shadow:0 0 10px rgba(255,210,63,.55);}',
      '@keyframes scb-pop{0%{transform:translateY(6px) scale(.6);opacity:0}100%{transform:none;opacity:1}}',
      '.scb-gap{width:11px;}',
      '.scb-wordinfo{font-size:11px;font-weight:800;color:var(--muted);text-transform:uppercase;letter-spacing:1px;}',
      /* Bühne */
      '.scb-stage{position:relative;width:100%;max-width:560px;margin:0 auto;}',
      '.scb-canvas{display:block;width:100%;max-width:560px;height:auto;border-radius:16px;',
      'border:2px solid var(--stroke-2);background:linear-gradient(180deg,#07130d,#020905);',
      'box-shadow:0 0 34px rgba(57,255,20,.16),inset 0 0 44px rgba(57,255,20,.05);',
      'touch-action:none;user-select:none;-webkit-user-select:none;-webkit-tap-highlight-color:transparent;}',
      '.scb-canvas.scb-draw{cursor:crosshair;border-color:var(--neon);box-shadow:0 0 40px rgba(57,255,20,.3),inset 0 0 44px rgba(57,255,20,.06);}',
      /* Auflösung */
      '.scb-ov{position:absolute;inset:0;border-radius:16px;display:flex;align-items:center;justify-content:center;',
      'background:rgba(2,10,6,.88);border:2px solid var(--gold);box-shadow:0 0 40px rgba(255,210,63,.3);',
      'animation:scb-fade .3s ease;padding:14px;}',
      '.scb-ov.scb-hide{display:none;}',
      '@keyframes scb-fade{from{opacity:0}to{opacity:1}}',
      '.scb-ov-in{display:flex;flex-direction:column;align-items:center;gap:7px;max-height:100%;overflow-y:auto;width:100%;}',
      '.scb-ov-l{font-size:11px;font-weight:800;color:var(--muted);text-transform:uppercase;letter-spacing:2px;}',
      '.scb-ov-word{font-size:clamp(24px,7vw,38px);font-weight:900;line-height:1;}',
      '.scb-ov-list{display:flex;flex-direction:column;gap:4px;width:100%;max-width:280px;margin-top:4px;}',
      '.scb-ov-row{display:flex;justify-content:space-between;gap:10px;padding:5px 10px;border-radius:9px;background:rgba(9,32,21,.7);border:1px solid var(--stroke);font-size:13px;font-weight:700;}',
      '.scb-ov-row.me{border-color:var(--neon);box-shadow:0 0 10px var(--stroke-2);}',
      '.scb-ov-nm{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.scb-ov-pts{color:var(--gold);font-weight:900;font-variant-numeric:tabular-nums;}',
      '.scb-ov-none{font-size:13px;color:var(--muted);font-weight:700;}',
      '.scb-ov-time{font-size:12px;color:var(--aqua-soft);font-weight:800;margin-top:6px;}',
      /* Werkzeuge */
      '.scb-tools{display:flex;flex-wrap:wrap;gap:8px;justify-content:center;align-items:center;padding:9px 10px;border-radius:14px;background:rgba(9,32,21,.55);border:1px solid var(--stroke);}',
      '.scb-tools.scb-off{opacity:.35;pointer-events:none;}',
      '.scb-sw{width:30px;height:30px;border-radius:50%;border:2px solid rgba(255,255,255,.18);padding:0;cursor:pointer;',
      'transition:transform .15s cubic-bezier(.2,.7,.3,1.5),border-color .15s,box-shadow .15s;}',
      '.scb-sw:hover{transform:scale(1.15);}',
      '.scb-sw.on{border-color:#fff;transform:scale(1.2);box-shadow:0 0 12px rgba(255,255,255,.5);}',
      '.scb-wbtn{width:34px;height:30px;border-radius:9px;padding:0;cursor:pointer;display:flex;align-items:center;justify-content:center;',
      'background:rgba(4,16,10,.8);border:1px solid var(--stroke);color:var(--leaf);transition:.15s;}',
      '.scb-wbtn:hover{border-color:var(--stroke-2);}',
      '.scb-wbtn.on{border-color:var(--neon);color:var(--neon);box-shadow:0 0 12px var(--stroke-2);}',
      '.scb-dot{display:block;border-radius:50%;background:currentColor;}',
      '.scb-sep{width:1px;height:24px;background:var(--stroke);flex:0 0 auto;}',
      '.scb-erase.on{color:var(--aqua);border-color:var(--aqua);box-shadow:0 0 12px rgba(51,230,208,.4);}',
      /* Raten */
      '.scb-guessrow{display:flex;gap:8px;}',
      '.scb-input{flex:1;min-width:0;}',
      '.scb-send{flex:0 0 auto;}',
      '.scb-rules{margin:0;font-size:12px;}',
      /* Verlauf */
      '.scb-feed{display:flex;flex-direction:column;gap:4px;max-height:150px;overflow-y:auto;padding:8px 10px;',
      'border-radius:12px;background:rgba(4,16,10,.55);border:1px solid var(--stroke);}',
      '.scb-msg{display:flex;gap:6px;align-items:baseline;font-size:13px;line-height:1.3;animation:scb-slide .2s ease;}',
      '@keyframes scb-slide{from{opacity:0;transform:translateX(-6px)}to{opacity:1;transform:none}}',
      '.scb-msg-w{font-weight:900;color:var(--aqua-soft);flex:0 0 auto;max-width:38%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.scb-msg-t{color:var(--text);word-break:break-word;flex:1;min-width:0;}',
      '.scb-msg.me .scb-msg-w{color:var(--neon);}',
      '.scb-msg-sys .scb-msg-t,.scb-msg-near .scb-msg-t{color:var(--muted);font-style:italic;}',
      '.scb-msg-near .scb-msg-t{color:var(--gold);font-style:normal;font-weight:800;}',
      '.scb-msg-bonus .scb-msg-t{color:var(--gold);font-weight:800;}',
      '.scb-msg-ok .scb-msg-t{color:var(--neon);font-weight:800;text-shadow:0 0 8px rgba(57,255,20,.4);}',
      '.scb-msg-p{color:var(--gold);font-weight:900;font-variant-numeric:tabular-nums;flex:0 0 auto;}',
      /* Wort-Auswahl */
      '.scb-choose{padding:24px 20px;display:flex;flex-direction:column;gap:12px;align-items:center;text-align:center;}',
      '.scb-choose h3{margin:0;}',
      '.scb-choose-icon{font-size:48px;line-height:1;filter:drop-shadow(0 0 14px var(--stroke-2));}',
      '.scb-spin{animation:scb-bob 1.8s ease-in-out infinite;}',
      '@keyframes scb-bob{0%,100%{transform:translateY(0) rotate(-8deg)}50%{transform:translateY(-8px) rotate(8deg)}}',
      '.scb-cards{display:flex;gap:10px;flex-wrap:wrap;justify-content:center;width:100%;}',
      '.scb-card{flex:1;min-width:120px;display:flex;flex-direction:column;gap:3px;align-items:center;padding:14px 12px;',
      'border-radius:14px;background:rgba(9,32,21,.75);border:1.5px solid var(--stroke);color:var(--text);cursor:pointer;font-family:inherit;',
      'transition:transform .16s cubic-bezier(.2,.7,.3,1.4),border-color .16s,box-shadow .16s;}',
      '.scb-card:hover{transform:translateY(-4px);border-color:var(--neon);box-shadow:0 0 20px var(--stroke-2);}',
      '.scb-card:active{transform:scale(.97);}',
      '.scb-card-w{font-size:clamp(16px,4.4vw,21px);font-weight:900;color:var(--neon);text-shadow:0 0 10px rgba(57,255,20,.35);}',
      '.scb-card-h{font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;font-weight:800;}',
      '.scb-cd-row{display:flex;align-items:center;gap:10px;width:100%;max-width:320px;}',
      '.scb-cd{font-size:14px;font-weight:900;color:var(--aqua-soft);font-variant-numeric:tabular-nums;min-width:34px;}',
      /* Rangliste + Warte-Panel */
      '.scb-boardwrap{padding:12px 14px;display:flex;flex-direction:column;gap:7px;}',
      '.scb-boardwrap .mg-scoreboard{max-height:240px;overflow-y:auto;}',
      '.scb-panel{padding:34px 24px;text-align:center;display:flex;flex-direction:column;gap:12px;align-items:center;max-width:460px;margin:0 auto;}',
      '.scb-panel h2{margin:0;}'
    ].join(''));
  }
})();
