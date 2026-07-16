/* wordduel.js — "Wortduell": Wordle als Rennen im Neon-Dschungel.
 *
 * SPIELIDEE: Alle jagen 3 Minuten lang dieselbe Wortfolge. Jedes Wort hat 5
 *   Buchstaben und 6 Versuche. Wer ein Wort löst, bekommt sofort das nächste —
 *   wer am Ende die meisten Punkte hat, gewinnt.
 * STEUERUNG: Bildschirmtastatur (Maus/Touch) oder echte Tastatur (A–Z,
 *   Enter = raten, Backspace = löschen). Wörter ohne Umlaute/ß.
 * FARBEN: 🟩 richtiger Buchstabe an richtiger Stelle, 🟨 Buchstabe kommt vor
 *   (andere Stelle), ⬛ kommt nicht (mehr) vor. Doppelte Buchstaben nach
 *   Original-Wordle-Regel: erst alle Grünen binden ihren Slot, danach werden
 *   Gelbe nur so oft vergeben, wie der Buchstabe im Lösungswort übrig ist.
 * PUNKTE pro gelöstem Wort: 1000 − 100 × Versuche + Zeitbonus
 *   (500 − 10 pro Sekunde, min. 0). Nicht geschafft = 0 Punkte, Wort wird
 *   aufgedeckt, es geht sofort weiter.
 *
 * SOLO (ctx.mode==='single'): Auswahl der Bot-Stufe (Leicht/Normal/Schwer),
 *   danach dieselbe 3-Minuten-Jagd gegen 3 Bots UND den eigenen Rekord
 *   ('best_wordduel'). Die Bots raten echt: sie führen eine Kandidatenliste,
 *   filtern sie nach jedem Farb-Muster und wählen den Zug, der die Liste im
 *   Schnitt am stärksten schrumpft (Stufe steuert Denkzeit, Top-K und Patzer).
 * MULTI (ctx.mode==='multi'): Der Host würfelt die Wortfolge und verteilt sie
 *   per room.setShared({ wdlWords: [...] }); alle anderen warten darauf (mit
 *   deterministischem Notfall-Seed aus dem Raum-Code). Jeder spielt seine
 *   eigene Reihe durch dieselbe Folge, meldet Punkte per room.reportScore und
 *   die gelösten Wörter per room.reportState({ s: n }) — die Live-Rangliste
 *   liest beides aus room.players().
 *
 * SYNC/ZEIT: Start + Rundenzeit laufen über Wall-Clock (App.MG.countdown /
 *   App.MG.roundTimer, im Multi mit room.now) -> Tab-Wechsel-sicher.
 * cleanup() setzt das dead-Flag, stoppt alle Timeouts, entfernt den
 * document-keydown-Listener und meldet jeden room.on(...) wieder ab. */
(function () {
  'use strict';
  window.App = window.App || {}; App.Minigames = App.Minigames || {};
  var UI = App.UI, el = UI.el;

  injectStyle();

  var LEN = 5;             // Buchstaben pro Wort
  var ROWS = 6;            // Versuche pro Wort
  var DURATION = 180;      // s Gesamtzeit (3 Minuten)
  var WORD_POOL = 25;      // so viele Wörter verteilt der Host pro Runde
  var BONUS_START = 500;   // Zeitbonus zu Beginn eines Wortes
  var BONUS_DROP = 10;     // Abzug pro Sekunde

  /* ===================== WORTLISTE =====================
   * Lösungswörter UND erlaubte Rateworte in einem: alles echte deutsche
   * 5-Buchstaben-Wörter in Großschrift, ohne Umlaute und ohne ß (so bleibt die
   * Tastatur bei 26 Tasten und Handy-Eingaben können nicht danebengehen). */
  var WORDS = [
    'ABEND', 'ABTEI', 'ACKER', 'ADLER', 'AKTIE', 'ALARM', 'ALBUM', 'ALGEN', 'ALLEE', 'ALPEN',
    'AMSEL', 'ANKER', 'ANTIK', 'APFEL', 'ARENA', 'ARMEE', 'ASSEL', 'ASTER', 'ATLAS', 'AUGEN',
    'AUTOR', 'BADEN', 'BANAL', 'BANDE', 'BANJO', 'BARDE', 'BASIS', 'BAUCH', 'BAUER', 'BEBEN',
    'BEERE', 'BEINE', 'BERGE', 'BERUF', 'BESEN', 'BEUTE', 'BIBEL', 'BIENE', 'BIEST', 'BINDE',
    'BIRKE', 'BIRNE', 'BISON', 'BLATT', 'BLECH', 'BLICK', 'BLITZ', 'BLOCK', 'BLUME', 'BLUSE',
    'BODEN', 'BOGEN', 'BOHNE', 'BOMBE', 'BONUS', 'BOOTE', 'BORKE', 'BOXEN', 'BRAND', 'BRAUN',
    'BREIT', 'BRIEF', 'BRUCH', 'BUCHE', 'BUSCH', 'CHAOS', 'CHROM', 'CIRCA', 'CLOWN', 'COUCH',
    'CREME', 'CURRY', 'DACHS', 'DAMEN', 'DAMPF', 'DANKE', 'DATEN', 'DATUM', 'DAUER', 'DECKE',
    'DEGEN', 'DEICH', 'DELLE', 'DEPOT', 'DICHT', 'DIELE', 'DINGE', 'DIODE', 'DOGGE', 'DOHLE',
    'DOSEN', 'DRAHT', 'DRAMA', 'DRANG', 'DRUCK', 'DUELL', 'DUNST', 'DURST', 'EBENE', 'ECHSE',
    'ECKEN', 'EIMER', 'EINER', 'EISEN', 'EISIG', 'EKLIG', 'ELCHE', 'ELEND', 'ELFEN', 'ELITE',
    'EMAIL', 'ENGEL', 'ENTEN', 'ERBSE', 'ERNTE', 'ESSEN', 'ESSIG', 'ETAGE', 'EULEN', 'EXTRA',
    'FABEL', 'FADEN', 'FAHNE', 'FAKIR', 'FALKE', 'FALLE', 'FARBE', 'FASAN', 'FASER', 'FAUST',
    'FEDER', 'FEGEN', 'FEIER', 'FEIGE', 'FEILE', 'FERNE', 'FESTE', 'FEUER', 'FILME', 'FINKE',
    'FIRMA', 'FISCH', 'FLACH', 'FLINK', 'FLUCH', 'FLUSS', 'FOLIE', 'FORST', 'FOTOS', 'FRAGE',
    'FRECH', 'FRIST', 'FROST', 'FUCHS', 'FUNKE', 'GABEL', 'GALLE', 'GANZE', 'GARBE', 'GASSE',
    'GEBET', 'GEBOT', 'GEIER', 'GEIGE', 'GEIST', 'GELBE', 'GEMSE', 'GENIE', 'GESTE', 'GLANZ',
    'GLATT', 'GLEIS', 'GLIED', 'GNOME', 'GREIF', 'GRIFF', 'GROSS', 'GRUBE', 'GRUND', 'GUNST',
    'GURKE', 'HAFEN', 'HAFER', 'HAKEN', 'HALLE', 'HALME', 'HANDY', 'HARFE', 'HASEN', 'HAUCH',
    'HAUPT', 'HEBEL', 'HECKE', 'HEFTE', 'HEIDE', 'HENNE', 'HERDE', 'HEUTE', 'HEXEN', 'HITZE',
    'HOBEL', 'HONIG', 'HORDE', 'HOSEN', 'HOTEL', 'HUMOR', 'HUMUS', 'HUNDE', 'HUPEN', 'IDEAL',
    'IDEEN', 'IGLUS', 'IMKER', 'INDEX', 'INSEL', 'INTIM', 'JACKE', 'JAGEN', 'JAHRE', 'JOKER',
    'JUBEL', 'JUNGE', 'JUWEL', 'KABEL', 'KAKAO', 'KAMEL', 'KAMIN', 'KANAL', 'KANTE', 'KAPPE',
    'KARTE', 'KASSE', 'KATER', 'KATZE', 'KAUEN', 'KEGEL', 'KEHLE', 'KELCH', 'KERBE', 'KERZE',
    'KETTE', 'KEULE', 'KIOSK', 'KIPPE', 'KISTE', 'KLANG', 'KLEID', 'KLEIN', 'KLIMA', 'KLOTZ',
    'KLUFT', 'KNOPF', 'KOALA', 'KOBRA', 'KOHLE', 'KOKOS', 'KOMET', 'KONTO', 'KOPIE', 'KRAFT',
    'KRANZ', 'KRAUT', 'KREBS', 'KREIS', 'KREUZ', 'KRIEG', 'KRISE', 'KRONE', 'KRUME', 'KUGEL',
    'KUNDE', 'KUNST', 'KUPPE', 'KURVE', 'LADEN', 'LAGER', 'LAMPE', 'LANZE', 'LASER', 'LASSO',
    'LATTE', 'LAUBE', 'LAUCH', 'LAUNE', 'LAUTE', 'LEBEN', 'LEDER', 'LEERE', 'LEGAL', 'LEIER',
    'LEINE', 'LESEN', 'LEUTE', 'LIANE', 'LICHT', 'LIEBE', 'LIEGE', 'LILIE', 'LIMIT', 'LINDE',
    'LINIE', 'LINKS', 'LINSE', 'LIPPE', 'LISTE', 'LITER', 'LOBBY', 'LOCKE', 'LOGIK', 'LOKAL',
    'LOTSE', 'LUCHS', 'LUXUS', 'MACHT', 'MADEN', 'MAGEN', 'MAGIE', 'MAKEL', 'MALER', 'MANGO',
    'MARKE', 'MARKT', 'MASSE', 'MATTE', 'MAUER', 'MEILE', 'MEISE', 'MENGE', 'MESSE', 'METER',
    'MIETE', 'MILBE', 'MILCH', 'MINUS', 'MITTE', 'MODUS', 'MOLCH', 'MONAT', 'MOPED', 'MORAL',
    'MOTIV', 'MOTOR', 'MOTTE', 'MULDE', 'MUMIE', 'MUSIK', 'MUTIG', 'NABEL', 'NACHT', 'NADEL',
    'NAGEL', 'NARBE', 'NASEN', 'NEBEL', 'NEFFE', 'NETZE', 'NIERE', 'NOTEN', 'NUDEL', 'OASEN',
    'OCHSE', 'OFFEN', 'OHREN', 'OKAPI', 'OLIVE', 'ONKEL', 'OPERN', 'OPFER', 'ORDEN', 'ORGEL',
    'ORKAN', 'OSTEN', 'OTTER', 'OVALE', 'OZEAN', 'PAKET', 'PALME', 'PANIK', 'PARKA', 'PARTY',
    'PASTA', 'PAUSE', 'PEDAL', 'PERLE', 'PFAHL', 'PFAND', 'PFEIL', 'PFERD', 'PFLUG', 'PFOTE',
    'PFUND', 'PHASE', 'PIANO', 'PILOT', 'PILZE', 'PINIE', 'PIRAT', 'PISTE', 'PIZZA', 'PLANE',
    'PLATZ', 'PLUMP', 'POKAL', 'POKER', 'PONYS', 'PREIS', 'PRIMA', 'PRINZ', 'PRISE', 'PROBE',
    'PROFI', 'PROSA', 'PRUNK', 'PUDEL', 'PULLI', 'PUMPE', 'PUNKT', 'PUPPE', 'PUTER', 'QUALM',
    'QUARK', 'QUARZ', 'QUOTE', 'RABEN', 'RADAR', 'RADIO', 'RAMPE', 'RANKE', 'RASEN', 'RASSE',
    'RATTE', 'RAUCH', 'RAUPE', 'RECHT', 'REDEN', 'REGAL', 'REGEL', 'REGEN', 'REICH', 'REIFE',
    'REIHE', 'REISE', 'RESTE', 'RIESE', 'RINDE', 'RINGE', 'RINNE', 'RIPPE', 'ROBBE', 'ROLLE',
    'ROMAN', 'ROSEN', 'ROTOR', 'ROUTE', 'RUBIN', 'RUDEL', 'RUDER', 'RUHIG', 'RUINE', 'RUMPF',
    'RUNDE', 'SAGEN', 'SAHNE', 'SAITE', 'SALAT', 'SALBE', 'SALON', 'SALZE', 'SAMEN', 'SANFT',
    'SAUNA', 'SCHAF', 'SCHAL', 'SCHAU', 'SCHUH', 'SEELE', 'SEGEL', 'SEIDE', 'SEIFE', 'SEILE',
    'SENSE', 'SERIE', 'SIEBE', 'SIEGE', 'SILBE', 'SIRUP', 'SITZE', 'SKALA', 'SOCKE', 'SOFAS',
    'SOHLE', 'SONNE', 'SORTE', 'SOSSE', 'SPALT', 'SPECK', 'SPEER', 'SPIEL', 'SPION', 'SPORT',
    'STAAT', 'STADT', 'STAHL', 'STAMM', 'STAND', 'STAUB', 'STEIN', 'STERN', 'STIEL', 'STIER',
    'STIFT', 'STILL', 'STOCK', 'STOFF', 'STOLZ', 'STROM', 'STUBE', 'STUFE', 'STUHL', 'STURM',
    'STURZ', 'SUCHE', 'SUMPF', 'SUPPE', 'TABAK', 'TAFEL', 'TALER', 'TANNE', 'TANTE', 'TAPIR',
    'TASSE', 'TASTE', 'TAUBE', 'TEICH', 'TEILE', 'TEMPO', 'TEUER', 'THEMA', 'THRON', 'TIEFE',
    'TIGER', 'TINTE', 'TISCH', 'TITEL', 'TOAST', 'TONNE', 'TORTE', 'TRAUM', 'TREUE', 'TRICK',
    'TRIEB', 'TROLL', 'TRUHE', 'TULPE', 'TURBO', 'TYPEN', 'UHREN', 'ULMEN', 'UMBAU', 'UMWEG',
    'UNION', 'UNTEN', 'UNTER', 'VASEN', 'VATER', 'VIDEO', 'VILLA', 'VIREN', 'VIRUS', 'VOGEL',
    'VORNE', 'VOTUM', 'WAAGE', 'WACHE', 'WAFFE', 'WAGEN', 'WALZE', 'WANNE', 'WANZE', 'WAREN',
    'WARZE', 'WATTE', 'WEGEN', 'WEHEN', 'WEIDE', 'WEISE', 'WELLE', 'WELPE', 'WENDE', 'WERFT',
    'WERKE', 'WERTE', 'WESEN', 'WESPE', 'WESTE', 'WETTE', 'WIESE', 'WINDE', 'WITZE', 'WOCHE',
    'WOLKE', 'WOLLE', 'WONNE', 'WORTE', 'WUNDE', 'WURST', 'YACHT', 'ZANGE', 'ZEBRA', 'ZECKE',
    'ZEHEN', 'ZEILE', 'ZELLE', 'ZELTE', 'ZIEGE', 'ZIELE', 'ZITAT', 'ZONEN', 'ZUNGE', 'ZWEIG',
    'ZWERG'
  ];

  /* Schnelles Nachschlagen für die Wörterbuch-Prüfung (Großschrift -> nie Kollision
     mit Object-Prototyp-Namen wie 'constructor'). */
  var WORD_SET = (function () {
    var m = {}, i;
    for (i = 0; i < WORDS.length; i++) m[WORDS[i]] = true;
    return m;
  })();

  /* Startwörter der Bots: viele häufige Buchstaben, keine Doppelten. */
  var OPENERS = ['RASEN', 'LASER', 'TALER', 'NADEL', 'REGAL', 'SALBE'];

  /* Bildschirmtastatur (QWERTZ). */
  var KB_ROWS = [
    ['Q', 'W', 'E', 'R', 'T', 'Z', 'U', 'I', 'O', 'P'],
    ['A', 'S', 'D', 'F', 'G', 'H', 'J', 'K', 'L'],
    ['ENTER', 'Y', 'X', 'C', 'V', 'B', 'N', 'M', 'BACK']
  ];

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
  function hashStr(str) {
    var h = 2166136261, i;
    str = String(str || 'wdl');
    for (i = 0; i < str.length; i++) { h = h ^ str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  /* WORD_POOL Wörter aus der gemischten Liste — reicht für 3 Minuten locker. */
  function pickWords(seed) {
    var a = WORDS.slice(), rnd = rngFrom(seed), i, j, tmp;
    for (i = a.length - 1; i > 0; i--) {
      j = Math.floor(rnd() * (i + 1));
      tmp = a[i]; a[i] = a[j]; a[j] = tmp;
    }
    return a.slice(0, WORD_POOL);
  }
  function timeBonus(ms) {
    var b = BONUS_START - Math.floor(Math.max(0, ms) / 1000) * BONUS_DROP;
    return b > 0 ? b : 0;
  }
  function wordPoints(tries, ms) { return 1000 - 100 * tries + timeBonus(ms); }

  /* Wordle-Bewertung mit korrekter Behandlung doppelter Buchstaben:
     1. Durchgang bindet alle Grünen, erst danach werden Gelbe aus den noch
     freien Lösungs-Buchstaben vergeben. -> 'g' | 'y' | 'b' pro Position. */
  function scoreGuess(guess, sol) {
    var res = [], used = [], i, j;
    for (i = 0; i < LEN; i++) { res.push('b'); used.push(false); }
    for (i = 0; i < LEN; i++) {
      if (guess.charAt(i) === sol.charAt(i)) { res[i] = 'g'; used[i] = true; }
    }
    for (i = 0; i < LEN; i++) {
      if (res[i] === 'g') continue;
      for (j = 0; j < LEN; j++) {
        if (!used[j] && sol.charAt(j) === guess.charAt(i)) { res[i] = 'y'; used[j] = true; break; }
      }
    }
    return res;
  }
  function patKey(res) { return res.join(''); }
  function rankOf(state) { return state === 'g' ? 3 : state === 'y' ? 2 : state === 'b' ? 1 : 0; }

  /* ===================== BOT-KI =====================
   * Echter Wordle-Solver: Kandidatenliste (Start = ganze Wortliste), nach jedem
   * Zug bleiben nur Wörter übrig, die dasselbe Farbmuster erzeugt hätten.
   * Der Zug wird danach gewählt, welcher Kandidat die Liste im Schnitt am
   * stärksten schrumpfen lässt (erwartete Restgröße, Standard-Heuristik).
   * Die Stufe steuert Denkzeit pro Zug, wie weit unten im Ranking gewürfelt
   * wird (topK) und wie oft ein echter Patzer passiert (blunder).
   * Kalibrierung gegen menschliches Tempo (ein guter Mensch braucht 20–40 s pro
   * Wort, schafft also ~4–8 Wörter -> ~3.000–8.000 Punkte). Über je 120
   * simulierte 3-Minuten-Läufe pro Stufe gemessener Median (Wörter/Lauf):
   *   Leicht ~2.100 (2.9) · Normal ~5.400 (5.7) · Schwer ~9.300 (8.8) Punkte. */
  var LEVELS = {
    leicht: { id: 'leicht', label: '😌 Leicht', desc: 'Gemütliche Rate-Bots', think: [11000, 15500], topK: 8, blunder: 0.30 },
    normal: { id: 'normal', label: '🌿 Normal', desc: 'Solide Wort-Jäger', think: [6000, 9000], topK: 4, blunder: 0.10 },
    schwer: { id: 'schwer', label: '🔥 Schwer', desc: 'Bots mit Wörterbuch im Kopf', think: [4300, 6100], topK: 1, blunder: 0.03 }
  };
  var BOT_DEFS = [
    { id: 'wdlbot1', name: '🦜 Rio', tMul: 1.16, bAdd: 0.06 },
    { id: 'wdlbot2', name: '🐒 Koko', tMul: 1.0, bAdd: 0 },
    { id: 'wdlbot3', name: '🐆 Zara', tMul: 0.86, bAdd: -0.02 }
  ];

  function filterCands(cands, guess, key) {
    return cands.filter(function (w) { return patKey(scoreGuess(guess, w)) === key; });
  }
  /* Kandidaten nach erwarteter Restgröße sortieren (kleiner = besser).
     Bei großen Listen wird die Auswahl gestichprobt, damit es flott bleibt. */
  function rankGuesses(cands) {
    var pool = cands, i;
    if (pool.length > 40) {
      pool = [];
      var step = cands.length / 40;
      for (i = 0; i < 40; i++) pool.push(cands[Math.floor(i * step)]);
    }
    var scored = pool.map(function (g) {
      var buckets = {}, k, n;
      for (n = 0; n < cands.length; n++) {
        k = patKey(scoreGuess(g, cands[n]));
        buckets[k] = (buckets[k] || 0) + 1;
      }
      var sum = 0;
      Object.keys(buckets).forEach(function (kk) { sum += buckets[kk] * buckets[kk]; });
      return { w: g, e: sum / cands.length };
    });
    scored.sort(function (a, b) { return a.e - b.e; });
    return scored.map(function (s) { return s.w; });
  }

  /* ===================== REGISTRIERUNG ===================== */
  App.Minigames.wordduel = {
    id: 'wordduel', title: 'Wortduell', icon: '🟩', order: 116,
    subtitle: 'Wordle als Rennen – wer knackt mehr Wörter?',
    single: true, multi: true, minPlayers: 2, maxPlayers: 8,

    render: function (root, ctx) {
      var isMulti = ctx.mode === 'multi';
      var nowFn = isMulti ? ctx.room.now : function () { return Date.now(); };

      var dead = false;
      var stops = [];        // stop()/off()-Funktionen (App.MG-Bausteine, Listener)
      var pending = [];      // laufende setTimeout-IDs

      /* Laufender Zustand (in play() für jede Runde frisch gesetzt) */
      var score = 0, solved = 0, wordIdx = 0, word = '', wordStart = 0;
      var tries = 0, cur = '', locked = true, finished = false;
      var keyState = {}, flipToken = 0, endAt = 0, words = null;
      var bots = [], level = LEVELS.normal;

      /* DOM-Referenzen */
      var scoreEl, wordsEl, timerEl, flashEl, grid = null, kb = null, boardEl = null;

      function after(ms, fn) { var t = setTimeout(function () { if (!dead) fn(); }, ms); pending.push(t); return t; }
      function clearPending() { pending.forEach(clearTimeout); pending = []; }
      function stopHelpers() { stops.forEach(function (f) { try { f(); } catch (e) {} }); stops = []; }
      function cleanup() { dead = true; clearPending(); stopHelpers(); }
      function sfx(n) { if (App.Audio) App.Audio.sfx(n); }

      /* ---- Einstieg ---- */
      if (isMulti) startMulti(); else chooseLevel();
      return { cleanup: cleanup };

      /* =========================================================
       *  MULTI — Host verteilt die Wortfolge, alle rennen parallel
       * ========================================================= */
      function startMulti() {
        var snap = ctx.room.snapshot() || {};
        var sh = snap.shared || {};
        /* Der Host würfelt die Wortfolge sofort, damit sie noch während des
           3-Sekunden-Countdowns bei allen ankommt. */
        if ((ctx.isHost || ctx.room.isHost()) && !(sh.wdlWords && sh.wdlWords.length)) {
          ctx.room.setShared({ wdlWords: pickWords(Date.now() + Math.floor(Math.random() * 1e6)) });
        }
        var startAt = (snap.round && snap.round.startAt) || (ctx.room.now() + 3000);
        stops.push(App.MG.countdown(root, startAt, function () {
          waitForWords(function (list) { play(startAt, list); });
        }, ctx.room.now));
      }

      /* Wartet auf shared.wdlWords. Notfall nach 4 s: Wortfolge deterministisch
         aus dem Raum-Code ableiten — dann rechnen alle Geräte dieselbe Folge. */
      function waitForWords(cb) {
        var sh = (ctx.room.snapshot() && ctx.room.snapshot().shared) || {};
        if (sh.wdlWords && sh.wdlWords.length) { cb(sh.wdlWords); return; }

        root.innerHTML = '';
        root.appendChild(el('div', { class: 'glass wdl-wait' }, [
          el('div', { class: 'wdl-wait-icon' }, ['🟩']),
          el('h3', { class: 'neon' }, ['Wörter werden verteilt …']),
          el('p', { class: 'hint-text' }, ['Der Host mischt gerade den Wort-Stapel.'])
        ]));

        var done = false;
        function tryGo() {
          if (done || dead) return;
          var s = (ctx.room.snapshot() && ctx.room.snapshot().shared) || {};
          if (s.wdlWords && s.wdlWords.length) {
            done = true; ctx.room.off('shared', tryGo);
            cb(s.wdlWords);
          }
        }
        ctx.room.on('shared', tryGo);
        stops.push(function () { ctx.room.off('shared', tryGo); });
        after(4000, function () {
          if (done) return;
          done = true; ctx.room.off('shared', tryGo);
          cb(pickWords(hashStr(ctx.room.code || ctx.room.id)));
        });
      }

      /* =========================================================
       *  SOLO — Stufenwahl, dann Countdown und Jagd gegen 3 Bots
       * ========================================================= */
      function chooseLevel() {
        clearPending(); stopHelpers();
        finished = false;
        var best = App.Storage.get('best_wordduel', 0);
        var btns = ['leicht', 'normal', 'schwer'].map(function (id) {
          var L = LEVELS[id];
          return el('button', { class: 'wdl-lvl-b', type: 'button', onclick: function () { level = L; startSolo(); } }, [
            el('span', { class: 'wdl-lvl-t' }, [L.label]),
            el('span', { class: 'wdl-lvl-d' }, [L.desc])
          ]);
        });
        root.innerHTML = '';
        root.appendChild(el('div', { class: 'glass wdl-lvl' }, [
          el('div', { class: 'wdl-lvl-icon' }, ['🟩']),
          el('h2', { class: 'neon' }, ['Wortduell']),
          el('p', { class: 'hint-text' }, [
            '3 Minuten, 5 Buchstaben, 6 Versuche pro Wort. Gelöst? Sofort das nächste! ' +
            'Du rennst gegen 3 Bots – und gegen deinen Rekord.'
          ]),
          el('div', { class: 'wdl-legend' }, [
            el('span', { class: 'wdl-lg' }, ['🟩 richtig']),
            el('span', { class: 'wdl-lg' }, ['🟨 falsche Stelle']),
            el('span', { class: 'wdl-lg' }, ['⬛ nicht im Wort'])
          ]),
          el('div', { class: 'mg-field-title' }, ['Bot-Stufe wählen']),
          el('div', { class: 'wdl-lvl-row' }, btns),
          el('p', { class: 'hint-text' }, ['🏅 Dein Rekord: ' + App.MG.fmt(best) + ' Punkte'])
        ]));
      }

      function startSolo() {
        sfx('select');
        var list = pickWords(Date.now() + Math.floor(Math.random() * 1e6));
        var startAt = Date.now() + 3000;
        stops.push(App.MG.countdown(root, startAt, function () { play(startAt, list); }));
      }

      /* =========================================================
       *  SPIEL
       * ========================================================= */
      function play(startAt, list) {
        clearPending(); stopHelpers();
        words = (list && list.length) ? list : pickWords(Date.now());
        score = 0; solved = 0; wordIdx = 0; tries = 0; cur = '';
        keyState = {}; flipToken = 0; finished = false; locked = false;
        endAt = startAt + DURATION * 1000;

        buildLayout();
        newWord();

        /* Echte Tastatur zusätzlich zur Bildschirmtastatur */
        function onKeyDown(e) {
          if (dead || finished) return;
          if (e.ctrlKey || e.metaKey || e.altKey) return;
          var k = e.key || '';
          if (k === 'Enter') { e.preventDefault(); onKey('ENTER'); return; }
          if (k === 'Backspace') { e.preventDefault(); onKey('BACK'); return; }
          if (k.length === 1) {
            var ch = k.toUpperCase();
            if (ch >= 'A' && ch <= 'Z') { e.preventDefault(); onKey(ch); }
          }
        }
        document.addEventListener('keydown', onKeyDown);
        stops.push(function () { document.removeEventListener('keydown', onKeyDown); });

        /* Rundentimer (Wall-Clock -> Tab-sicher) */
        stops.push(App.MG.roundTimer(endAt, function (left) {
          timerEl.textContent = App.MG.mmss(left);
          timerEl.classList.toggle('wdl-urgent', left <= 15);
        }, finish, isMulti ? ctx.room.now : null));

        if (isMulti) {
          ctx.room.reportScore(0);
          ctx.room.reportState({ s: 0 });
          var onPlayers = function () { if (!dead) paintBoard(); };
          ctx.room.on('players', onPlayers);
          stops.push(function () { ctx.room.off('players', onPlayers); });
        } else {
          startBots();
        }
        paintBoard();
      }

      /* ---- Aufbau der Spiel-Ansicht (einmal pro Runde) ---- */
      function buildLayout() {
        scoreEl = el('div', { class: 'wdl-hv wdl-hv-score' }, ['0']);
        wordsEl = el('div', { class: 'wdl-hv wdl-hv-words' }, ['0']);
        timerEl = el('div', { class: 'wdl-hv mg-timer' }, [App.MG.mmss(DURATION)]);
        var head = el('div', { class: 'wdl-head glass' }, [
          el('div', { class: 'wdl-hc' }, [el('span', { class: 'wdl-hl' }, ['Punkte']), scoreEl]),
          el('div', { class: 'wdl-hc wdl-hc-mid' }, [el('span', { class: 'wdl-hl' }, ['Wörter']), wordsEl]),
          el('div', { class: 'wdl-hc wdl-hc-end' }, [el('span', { class: 'wdl-hl' }, ['Zeit']), timerEl])
        ]);

        flashEl = el('div', { class: 'wdl-flash' }, ['Los geht\'s – rate das erste Wort!']);
        grid = buildGrid();
        kb = buildKeyboard();

        var rules = el('p', { class: 'hint-text wdl-rules' }, [
          '🟩 richtig · 🟨 falsche Stelle · ⬛ nicht im Wort · Enter = raten · ⌫ = löschen'
        ]);

        boardEl = el('div', { class: 'wdl-board' });
        var side = el('div', { class: 'wdl-side glass' }, [
          el('div', { class: 'mg-field-title' }, ['🏆 Rangliste']),
          boardEl,
          el('p', { class: 'hint-text wdl-side-hint' }, [
            isMulti ? 'Alle jagen dieselbe Wortfolge.' : ('Bot-Stufe: ' + level.label)
          ])
        ]);

        var main = el('div', { class: 'wdl-main' }, [head, flashEl, grid.root, kb.root, rules]);
        root.innerHTML = '';
        root.appendChild(el('div', { class: 'wdl-layout' }, [main, side]));
      }

      function buildGrid() {
        var rows = [], cells = [], r, c, rowCells;
        for (r = 0; r < ROWS; r++) {
          rowCells = [];
          for (c = 0; c < LEN; c++) rowCells.push(el('div', { class: 'wdl-cell' }));
          cells.push(rowCells);
          rows.push(el('div', { class: 'wdl-row' }, rowCells));
        }
        return { root: el('div', { class: 'wdl-grid' }, rows), rows: rows, cells: cells };
      }

      function buildKeyboard() {
        var keys = {};
        var rows = KB_ROWS.map(function (rowDef) {
          var btns = rowDef.map(function (k) {
            var wide = (k === 'ENTER' || k === 'BACK');
            var label = k === 'ENTER' ? '↵ Raten' : k === 'BACK' ? '⌫' : k;
            var b = el('button', {
              class: 'wdl-key' + (wide ? ' wdl-key-wide' : ''), type: 'button', 'aria-label': label
            }, [label]);
            b.addEventListener('pointerdown', function (e) { e.preventDefault(); onKey(k); });
            if (!wide) keys[k] = b;
            return b;
          });
          return el('div', { class: 'wdl-kb-row' }, btns);
        });
        return { root: el('div', { class: 'wdl-kb' }, rows), keys: keys };
      }

      /* ---- Eingabe ---- */
      function onKey(k) {
        if (dead || finished) return;
        if (k === 'ENTER') { submit(); return; }
        if (k === 'BACK') {
          if (locked || !cur.length) return;
          cur = cur.slice(0, cur.length - 1);
          paintCurrent();
          if (App.Audio) App.Audio.blip(240, 0.05, { type: 'square', peak: 0.05 });
          return;
        }
        if (locked || cur.length >= LEN) return;
        cur += k;
        paintCurrent();
        if (App.Audio) App.Audio.blip(420 + cur.length * 40, 0.05, { type: 'triangle', peak: 0.05 });
      }

      function paintCurrent() {
        var row = grid.cells[tries], i, ch;
        if (!row) return;
        for (i = 0; i < LEN; i++) {
          ch = cur.charAt(i) || '';
          row[i].textContent = ch;
          row[i].classList.toggle('wdl-filled', !!ch);
        }
      }

      function submit() {
        if (locked) return;
        if (cur.length < LEN) { reject('Zu kurz – es braucht 5 Buchstaben.'); return; }
        if (WORD_SET[cur] !== true) { reject('„' + cur + '“ steht nicht im Wörterbuch.'); return; }

        locked = true;
        var guess = cur, row = tries;
        var res = scoreGuess(guess, word);
        reveal(row, guess, res, function () {
          tries++;
          if (guess === word) { solveWord(); return; }
          if (tries >= ROWS) { failWord(); return; }
          cur = '';
          locked = false;
          flash(hintFor(res), 'info');
        });
      }

      /* Kurze Rückmeldung nach jedem Versuch */
      function hintFor(res) {
        var g = 0, y = 0, i;
        for (i = 0; i < LEN; i++) { if (res[i] === 'g') g++; else if (res[i] === 'y') y++; }
        var left = ROWS - tries;
        if (g >= 4) return '🔥 Ganz nah dran! Noch ' + left + ' Versuche.';
        if (g + y >= 3) return '👀 Guter Riecher – noch ' + left + ' Versuche.';
        if (g + y === 0) return '🧊 Alles kalt – noch ' + left + ' Versuche.';
        return 'Noch ' + left + ' Versuche.';
      }

      function reject(msg) {
        flash(msg, 'bad');
        sfx('error');
        var rowEl = grid.rows[tries];
        if (!rowEl) return;
        rowEl.classList.remove('wdl-shake');
        void rowEl.offsetWidth;              /* Reflow -> Animation startet neu */
        rowEl.classList.add('wdl-shake');
        after(420, function () { rowEl.classList.remove('wdl-shake'); });
      }

      /* Flip-Animation: Kachel für Kachel umdrehen, Farbe in der Mitte des
         Drehens setzen; danach färbt sich die Tastatur mit ein. */
      function reveal(rowIdx, guess, res, cb) {
        var token = ++flipToken, i;
        for (i = 0; i < LEN; i++) {
          (function (idx) {
            after(idx * 95, function () {
              if (token !== flipToken) return;
              var cell = grid.cells[rowIdx][idx];
              cell.classList.add('wdl-flip');
              after(190, function () {
                if (token !== flipToken) return;
                cell.classList.remove('wdl-filled');
                cell.classList.add('wdl-' + res[idx]);
                paintKey(guess.charAt(idx), res[idx]);
                if (App.Audio) App.Audio.blip(res[idx] === 'g' ? 760 : res[idx] === 'y' ? 540 : 300, 0.06, { type: 'triangle', peak: 0.05 });
              });
            });
          })(i);
        }
        after((LEN - 1) * 95 + 300, function () { if (token === flipToken) cb(); });
      }

      function paintKey(ch, state) {
        if (rankOf(state) <= rankOf(keyState[ch])) return;   // nie zurückstufen
        keyState[ch] = state;
        var b = kb.keys[ch];
        if (!b) return;
        b.classList.remove('wdl-k-g', 'wdl-k-y', 'wdl-k-b');
        b.classList.add('wdl-k-' + state);
      }

      /* ---- Wortwechsel ---- */
      function newWord() {
        word = words[wordIdx % words.length];
        wordStart = nowFn();
        tries = 0; cur = ''; keyState = {}; flipToken++;
        var fresh = buildGrid();
        grid.root.parentNode.replaceChild(fresh.root, grid.root);
        grid = fresh;
        Object.keys(kb.keys).forEach(function (k) {
          kb.keys[k].classList.remove('wdl-k-g', 'wdl-k-y', 'wdl-k-b');
        });
        locked = false;
      }

      function solveWord() {
        var pts = wordPoints(tries, nowFn() - wordStart);
        score += pts; solved++;
        scoreEl.textContent = App.MG.fmt(score);
        wordsEl.textContent = String(solved);
        scoreEl.classList.remove('wdl-bump'); void scoreEl.offsetWidth; scoreEl.classList.add('wdl-bump');
        flash('🟩 ' + word + ' geknackt! +' + pts + ' Punkte', 'good');
        sfx(tries <= 2 ? 'jackpot' : 'win');
        if (isMulti) { ctx.room.reportScore(score); ctx.room.reportState({ s: solved }); }
        paintBoard();
        after(1000, nextWord);
      }

      function failWord() {
        flash('❌ Verpasst – das Wort war ' + word, 'bad');
        sfx('lose');
        after(1900, nextWord);
      }

      function nextWord() {
        if (finished || nowFn() >= endAt) return;
        wordIdx++;
        newWord();
        flash('Neues Wort – 6 Versuche!', 'info');
      }

      function flash(msg, kind) {
        if (!flashEl) return;
        flashEl.textContent = msg;
        flashEl.className = 'wdl-flash wdl-flash-' + (kind || 'info');
        void flashEl.offsetWidth;
        flashEl.classList.add('wdl-flash-in');
      }

      /* =========================================================
       *  BOTS (nur Solo)
       * ========================================================= */
      function startBots() {
        bots = BOT_DEFS.map(function (d) {
          var b = {
            id: d.id, name: d.name, tMul: d.tMul,
            blunder: Math.max(0, level.blunder + d.bAdd), topK: level.topK,
            idx: 0, score: 0, solved: 0, tries: 0, word: '', cands: null, wordStart: 0
          };
          botNewWord(b);
          return b;
        });
        bots.forEach(function (b) { scheduleBot(b, thinkTime(b)); });
      }
      function thinkTime(b) {
        var t = level.think;
        return (t[0] + Math.random() * (t[1] - t[0])) * b.tMul;
      }
      function botNewWord(b) {
        b.word = words[b.idx % words.length];
        b.cands = WORDS.slice();
        b.tries = 0;
        b.wordStart = nowFn();
      }
      function scheduleBot(b, ms) {
        after(ms, function () { botStep(b); });
      }
      function botStep(b) {
        if (finished || nowFn() >= endAt) return;
        var guess;
        if (b.tries === 0) {
          guess = OPENERS[Math.floor(Math.random() * OPENERS.length)];
        } else if (b.cands.length <= 1) {
          guess = b.cands[0] || b.word;
        } else if (b.tries < 4 && Math.random() < b.blunder) {
          guess = WORDS[Math.floor(Math.random() * WORDS.length)];   // Patzer: Zug außerhalb der Kandidaten
        } else {
          var ranked = rankGuesses(b.cands);
          var k = Math.min(b.topK, ranked.length);
          guess = ranked[Math.floor(Math.random() * k)];
        }
        b.cands = filterCands(b.cands, guess, patKey(scoreGuess(guess, b.word)));
        b.tries++;

        if (guess === b.word) {
          b.score += wordPoints(b.tries, nowFn() - b.wordStart);
          b.solved++; b.idx++;
          botNewWord(b);
          paintBoard();
          scheduleBot(b, 900 + thinkTime(b) * 0.5);
        } else if (b.tries >= ROWS) {
          b.idx++;
          botNewWord(b);
          scheduleBot(b, 1200 + thinkTime(b) * 0.5);
        } else {
          scheduleBot(b, thinkTime(b));
        }
      }

      /* =========================================================
       *  RANGLISTE
       * ========================================================= */
      function boardRows() {
        var rows;
        if (isMulti) {
          rows = ctx.room.players().map(function (p) {
            return {
              id: p.id, name: p.name, score: p.score || 0,
              solved: (p.state && p.state.s) || 0, me: p.id === ctx.me.id
            };
          });
        } else {
          rows = [{ id: ctx.me.id, name: ctx.me.name || 'Du', score: score, solved: solved, me: true }];
          bots.forEach(function (b) {
            rows.push({ id: b.id, name: b.name, score: b.score, solved: b.solved, me: false });
          });
        }
        rows.sort(function (a, b) { return (b.score - a.score) || (b.solved - a.solved); });
        return rows;
      }

      function paintBoard() {
        if (!boardEl) return;
        var rows = boardRows();
        boardEl.innerHTML = '';
        rows.forEach(function (r, i) {
          boardEl.appendChild(el('div', {
            class: 'wdl-r wdl-p' + (i + 1) + (r.me ? ' wdl-me' : '')
          }, [
            el('span', { class: 'wdl-rk' }, ['' + (i + 1)]),
            el('span', { class: 'wdl-nm' }, [r.name + (r.me ? ' (du)' : '')]),
            el('span', { class: 'wdl-wc' }, [r.solved + '🟩']),
            el('span', { class: 'wdl-sc' }, [App.MG.fmt(r.score)])
          ]));
        });
      }

      /* =========================================================
       *  ENDE
       * ========================================================= */
      function finish() {
        if (finished || dead) return;
        finished = true;
        locked = true;
        clearPending();
        stopHelpers();
        sfx('cashout');

        if (isMulti) {
          ctx.room.reportScore(score);
          ctx.room.reportState({ s: solved });
          after(1200, function () {
            App.MG.endScreen(root, { players: ctx.room.players(), meId: ctx.me.id, onExit: ctx.onExit });
          });
          return;
        }

        var rows = boardRows(), place = 1, i;
        for (i = 0; i < rows.length; i++) if (rows[i].id === ctx.me.id) { place = i + 1; break; }
        var best = App.Storage.get('best_wordduel', 0);
        var nb = score > best;
        if (nb) App.Storage.set('best_wordduel', score);

        App.MG.endScreen(root, {
          score: score, best: best, newBest: nb,
          label: solved + ' Wörter geknackt · Platz ' + place + ' von ' + rows.length + ' (' + level.label + ') · ' +
                 (nb ? 'neuer Rekord! 🎉' : 'Bestwert: ' + App.MG.fmt(best)),
          onExit: ctx.onExit,
          onAgain: function () { chooseLevel(); }
        });
        /* Podest der Bot-Jagd zusätzlich in den Endscreen hängen */
        var box = root.querySelector('.mg-endscreen');
        if (box) {
          var ctrl = box.querySelector('.controls-row');
          var pod = App.MG.podiumEl(rows, ctx.me.id);
          if (ctrl) box.insertBefore(pod, ctrl); else box.appendChild(pod);
        }
      }
    }
  };

  /* ===================== STYLES ===================== */
  function injectStyle() {
    UI.injectStyle('mg-wordduel-css', [
      /* Layout */
      '.wdl-layout{display:flex;flex-direction:column;gap:14px;align-items:center;width:100%;}',
      '.wdl-main{display:flex;flex-direction:column;gap:10px;width:100%;max-width:340px;}',
      '.wdl-side{padding:14px;display:flex;flex-direction:column;gap:8px;width:100%;max-width:340px;}',
      '.wdl-side-hint{margin:2px 0 0;font-size:11px;}',
      '@media(min-width:840px){.wdl-layout{flex-direction:row;align-items:flex-start;justify-content:center;gap:20px;}',
      '.wdl-side{width:290px;max-width:290px;position:sticky;top:12px;}}',
      /* Kopfzeile */
      '.wdl-head{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:10px 14px;}',
      '.wdl-hc{display:flex;flex-direction:column;gap:2px;min-width:0;}',
      '.wdl-hc-mid{text-align:center;}',
      '.wdl-hc-end{text-align:right;}',
      '.wdl-hl{font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;}',
      '.wdl-hv{font-size:clamp(19px,5.4vw,26px);font-weight:900;line-height:1;font-variant-numeric:tabular-nums;}',
      '.wdl-hv-score{color:var(--gold);text-shadow:0 0 12px rgba(255,210,63,.45);}',
      '.wdl-hv-words{color:var(--neon);text-shadow:0 0 12px rgba(57,255,20,.45);}',
      '.wdl-head .mg-timer{font-size:clamp(19px,5.4vw,26px);}',
      '.mg-timer.wdl-urgent{color:var(--danger-2);animation:wdl-pulse .7s infinite;}',
      '.wdl-bump{animation:wdl-bump .32s ease;}',
      /* Melde-Zeile */
      '.wdl-flash{min-height:34px;display:flex;align-items:center;justify-content:center;text-align:center;',
      'padding:6px 10px;border-radius:11px;font-weight:800;font-size:13px;line-height:1.25;',
      'border:1px solid var(--stroke);background:rgba(9,32,21,.6);color:var(--leaf);}',
      '.wdl-flash-good{border-color:var(--stroke-2);color:var(--neon);box-shadow:0 0 18px rgba(57,255,20,.3);}',
      '.wdl-flash-bad{border-color:rgba(255,77,109,.55);color:var(--danger-2);box-shadow:0 0 18px rgba(255,77,109,.25);}',
      '.wdl-flash-in{animation:wdl-flash-in .3s ease;}',
      /* Raster */
      '.wdl-grid{display:flex;flex-direction:column;gap:6px;width:100%;max-width:330px;margin:0 auto;}',
      '.wdl-row{display:grid;grid-template-columns:repeat(5,1fr);gap:6px;}',
      '.wdl-cell{aspect-ratio:1/1;display:flex;align-items:center;justify-content:center;',
      'font-size:clamp(20px,7vw,30px);font-weight:900;border-radius:10px;color:var(--text);',
      'border:2px solid var(--stroke);background:rgba(4,16,10,.5);user-select:none;-webkit-user-select:none;',
      'text-transform:uppercase;transition:border-color .15s,transform .1s;}',
      '.wdl-cell.wdl-filled{border-color:var(--stroke-2);animation:wdl-pop .13s ease;}',
      '.wdl-cell.wdl-g{background:linear-gradient(180deg,#5cff3c,#199c08);border-color:#a6ff8d;color:#04160c;box-shadow:0 0 16px rgba(57,255,20,.5);}',
      '.wdl-cell.wdl-y{background:linear-gradient(180deg,#ffe273,#dfa000);border-color:#fff0b3;color:#2a1c00;box-shadow:0 0 16px rgba(255,210,63,.4);}',
      '.wdl-cell.wdl-b{background:rgba(10,26,19,.92);border-color:rgba(123,166,146,.3);color:var(--muted);}',
      '.wdl-flip{animation:wdl-flip .42s ease;}',
      '.wdl-shake{animation:wdl-shake .4s ease;}',
      /* Bildschirmtastatur */
      '.wdl-kb{display:flex;flex-direction:column;gap:6px;width:100%;max-width:400px;margin:0 auto;touch-action:manipulation;}',
      '.wdl-kb-row{display:flex;gap:5px;justify-content:center;}',
      '.wdl-key{flex:1 1 0;min-width:0;height:44px;border-radius:9px;font-family:inherit;font-weight:800;',
      'font-size:15px;color:var(--text);cursor:pointer;border:1px solid var(--stroke);',
      'background:linear-gradient(180deg,rgba(16,54,35,.9),rgba(6,24,15,.9));',
      'touch-action:manipulation;transition:transform .07s ease,background .25s,border-color .25s,color .25s;}',
      '.wdl-key:hover{border-color:var(--stroke-2);}',
      '.wdl-key:active{transform:translateY(2px) scale(.95);}',
      '.wdl-key-wide{flex:1.7 1 0;font-size:12px;color:var(--aqua-soft);border-color:rgba(51,230,208,.35);}',
      '.wdl-key.wdl-k-g{background:linear-gradient(180deg,#4cf02e,#158a06);border-color:#a6ff8d;color:#04160c;box-shadow:0 0 12px rgba(57,255,20,.4);}',
      '.wdl-key.wdl-k-y{background:linear-gradient(180deg,#f5d763,#c98f00);border-color:#fff0b3;color:#2a1c00;box-shadow:0 0 12px rgba(255,210,63,.3);}',
      '.wdl-key.wdl-k-b{background:rgba(8,20,14,.95);border-color:rgba(123,166,146,.18);color:#4d6b5c;}',
      '.wdl-rules{margin:0;text-align:center;font-size:11px;line-height:1.5;}',
      /* Rangliste */
      '.wdl-board{display:flex;flex-direction:column;gap:6px;max-height:320px;overflow-y:auto;}',
      '.wdl-r{display:grid;grid-template-columns:22px 1fr auto auto;align-items:center;gap:8px;padding:8px 11px;',
      'border-radius:11px;background:rgba(9,32,21,.6);border:1px solid var(--stroke);transition:border-color .2s;}',
      '.wdl-r.wdl-me{border-color:var(--stroke-2);box-shadow:var(--glow-soft);}',
      '.wdl-r.wdl-p1{background:linear-gradient(90deg,rgba(255,210,63,.16),rgba(9,32,21,.6));border-color:rgba(255,210,63,.4);}',
      '.wdl-r.wdl-p2{background:linear-gradient(90deg,rgba(207,228,220,.12),rgba(9,32,21,.6));}',
      '.wdl-r.wdl-p3{background:linear-gradient(90deg,rgba(224,138,60,.12),rgba(9,32,21,.6));}',
      '.wdl-rk{font-weight:900;color:var(--muted);font-size:12px;}',
      '.wdl-r.wdl-p1 .wdl-rk{color:var(--gold);}.wdl-r.wdl-p2 .wdl-rk{color:var(--silver);}.wdl-r.wdl-p3 .wdl-rk{color:var(--bronze);}',
      '.wdl-nm{font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;}',
      '.wdl-wc{font-size:11px;font-weight:800;color:var(--leaf);}',
      '.wdl-sc{font-weight:900;color:var(--gold);font-variant-numeric:tabular-nums;font-size:14px;}',
      /* Stufenwahl */
      '.wdl-lvl{padding:26px 22px;display:flex;flex-direction:column;gap:12px;align-items:center;text-align:center;max-width:460px;margin:0 auto;}',
      '.wdl-lvl h2{margin:0;}',
      '.wdl-lvl-icon{font-size:56px;line-height:1;filter:drop-shadow(0 0 16px rgba(57,255,20,.5));}',
      '.wdl-legend{display:flex;gap:8px;flex-wrap:wrap;justify-content:center;}',
      '.wdl-lg{font-size:11px;font-weight:800;color:var(--leaf);background:rgba(9,32,21,.7);',
      'border:1px solid var(--stroke);border-radius:999px;padding:4px 10px;}',
      '.wdl-lvl-row{display:flex;flex-direction:column;gap:8px;width:100%;}',
      '.wdl-lvl-b{display:flex;flex-direction:column;gap:2px;align-items:center;padding:11px 14px;border-radius:13px;',
      'font-family:inherit;cursor:pointer;color:var(--text);border:1px solid var(--stroke);',
      'background:linear-gradient(180deg,rgba(16,54,35,.85),rgba(6,24,15,.85));transition:transform .12s,border-color .2s,box-shadow .2s;}',
      '.wdl-lvl-b:hover{border-color:var(--stroke-2);box-shadow:var(--glow-soft);transform:translateY(-1px);}',
      '.wdl-lvl-b:active{transform:translateY(1px) scale(.99);}',
      '.wdl-lvl-t{font-size:16px;font-weight:900;color:var(--leaf);}',
      '.wdl-lvl-d{font-size:11px;color:var(--muted);}',
      /* Warten auf die Wortverteilung */
      '.wdl-wait{padding:44px 24px;text-align:center;display:flex;flex-direction:column;gap:8px;align-items:center;max-width:440px;margin:0 auto;}',
      '.wdl-wait h3{margin:0;}',
      '.wdl-wait-icon{font-size:52px;line-height:1;animation:wdl-bob 1.3s ease-in-out infinite;}',
      /* Animationen */
      '@keyframes wdl-flip{0%{transform:rotateX(0)}50%{transform:rotateX(90deg)}100%{transform:rotateX(0)}}',
      '@keyframes wdl-pop{0%{transform:scale(.85)}60%{transform:scale(1.07)}100%{transform:scale(1)}}',
      '@keyframes wdl-shake{0%,100%{transform:translateX(0)}15%{transform:translateX(-9px)}35%{transform:translateX(8px)}',
      '55%{transform:translateX(-6px)}80%{transform:translateX(4px)}}',
      '@keyframes wdl-bump{0%{transform:scale(1)}40%{transform:scale(1.22)}100%{transform:scale(1)}}',
      '@keyframes wdl-pulse{0%,100%{opacity:1}50%{opacity:.4}}',
      '@keyframes wdl-flash-in{from{opacity:.2;transform:translateY(-4px)}to{opacity:1;transform:translateY(0)}}',
      '@keyframes wdl-bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-8px)}}'
    ].join(''));
  }
})();
