/* emojiquiz.js — "Emoji-Rätsel": Eine Emoji-Kombination steht für einen Film,
 * ein Sprichwort, ein Tier oder einen Alltagsbegriff (👑🦁 → König der Löwen,
 * 🍎🌳 → Apfelbaum). Zu jedem Rätsel gibt es 4 Antworten; die drei falschen
 * stammen aus derselben Kategorie und klingen deshalb plausibel.
 *
 * ABLAUF   20 Rätsel, 12 s Antwortzeit pro Rätsel, danach ~2 s Auflösung, in
 *          der die Live-Rangliste aufleuchtet. Danach automatisch weiter.
 * STEUERUNG Antwort antippen/klicken oder Taste 1–4.
 * PUNKTE   100 Grundpunkte + bis zu 100 Tempo-Bonus (sofort geantwortet = 100,
 *          nach 12 s = 0) + Serien-Bonus ab 3 richtigen in Folge
 *          (3. = +25, 4. = +50 … gedeckelt bei +150). Falsch/zu spät = 0 und
 *          die Serie reißt.
 *
 * SOLO   (ctx.mode==='single'): Schwierigkeit wählen (Leicht/Mittel/Schwer),
 *        dann Punktejagd gegen den eigenen Rekord ('best_emojiquiz') — plus
 *        drei Bots mit eigener Trefferquote und eigenem Antwort-Tempo, die in
 *        derselben Rangliste mitlaufen. Falsch geratene Bots zögern länger und
 *        verpassen auf "Leicht" auch mal die Zeit.
 * MULTI  (ctx.mode==='multi'): Der Host verteilt EINEN Seed per room.setShared;
 *        daraus bauen alle Geräte dieselben 20 Rätsel inklusive derselben
 *        Antwort-Reihenfolge (deterministischer LCG). Welches Rätsel gerade
 *        dran ist, rechnet jedes Gerät selbst aus room.now() und dem
 *        gemeinsamen startAt aus — dadurch braucht es keine Host-Autorität und
 *        niemand kann verrutschen. Punkte laufen über room.reportScore().
 *
 * Alle Timer laufen über Wall-Clock (Date.now bzw. room.now) → Tab-Wechsel
 * verschiebt nichts. cleanup() beendet Loop, Timeouts, Key-Listener und
 * entfernt jeden room-Listener wieder. */
(function () {
  'use strict';
  window.App = window.App || {}; App.Minigames = App.Minigames || {};
  var UI = App.UI, el = UI.el;

  injectStyle();

  /* ===================== KONSTANTEN ===================== */
  var ROUNDS = 20;              // Rätsel pro Partie
  var ASK_MS = 12000;           // Antwortzeit pro Rätsel
  var REVEAL_MS = 2300;         // Auflösung + Rangliste zwischen den Rätseln
  var SLOT_MS = ASK_MS + REVEAL_MS;
  var BASE_POINTS = 100;        // Grundpunkte für richtig
  var SPEED_MAX = 100;          // maximaler Tempo-Bonus
  var STREAK_MIN = 3;           // ab so vielen richtigen in Folge gibt es Serien-Bonus
  var STREAK_STEP = 25;         // Bonus pro weiterem Treffer der Serie
  var STREAK_CAP = 150;         // maximaler Serien-Bonus

  var CATS = {
    film: { label: '🎬 Film', cls: 'emq-cat-film' },
    sprichwort: { label: '💬 Sprichwort', cls: 'emq-cat-spr' },
    tier: { label: '🐾 Tier', cls: 'emq-cat-tier' },
    alltag: { label: '🏠 Alltag', cls: 'emq-cat-all' }
  };

  /* ===================== RÄTSEL-POOL (146 Stück) =====================
   * e = Emojis als Array (ein Element = ein sichtbares Emoji; so bleiben
   *     zusammengesetzte Emojis wie 👨‍🍳 oder 🏴‍☠️ heil).
   * a = Lösung, k = Kategorie (liefert auch die falschen Antworten). */
  var RIDDLES = [
    /* ---------------- Filme ---------------- */
    { e: ['👑', '🦁'], a: 'König der Löwen', k: 'film' },
    { e: ['🧊', '👸'], a: 'Die Eiskönigin', k: 'film' },
    { e: ['🕷️', '🧑'], a: 'Spider-Man', k: 'film' },
    { e: ['🦇', '🧑'], a: 'Batman', k: 'film' },
    { e: ['🐠', '🔍'], a: 'Findet Nemo', k: 'film' },
    { e: ['🚢', '🧊'], a: 'Titanic', k: 'film' },
    { e: ['🦖', '🏝️'], a: 'Jurassic Park', k: 'film' },
    { e: ['👻', '🚫'], a: 'Ghostbusters', k: 'film' },
    { e: ['🧙', '💍', '🌋'], a: 'Der Herr der Ringe', k: 'film' },
    { e: ['⚡', '🧙‍♂️', '🏰'], a: 'Harry Potter', k: 'film' },
    { e: ['🐼', '🥋'], a: 'Kung Fu Panda', k: 'film' },
    { e: ['🤖', '🌱', '❤️'], a: 'WALL-E', k: 'film' },
    { e: ['🏎️', '⚡'], a: 'Cars', k: 'film' },
    { e: ['🐀', '👨‍🍳'], a: 'Ratatouille', k: 'film' },
    { e: ['🏠', '🎈', '🎈'], a: 'Oben', k: 'film' },
    { e: ['👹', '💚', '🧅'], a: 'Shrek', k: 'film' },
    { e: ['🦈', '🌊', '😱'], a: 'Der weiße Hai', k: 'film' },
    { e: ['👽', '📞', '🏠'], a: 'E.T.', k: 'film' },
    { e: ['🕰️', '🚗', '⚡'], a: 'Zurück in die Zukunft', k: 'film' },
    { e: ['🌪️', '👠', '🌈'], a: 'Der Zauberer von Oz', k: 'film' },
    { e: ['🎩', '🍫', '🏭'], a: 'Charlie und die Schokoladenfabrik', k: 'film' },
    { e: ['🧸', '🤠', '🚀'], a: 'Toy Story', k: 'film' },
    { e: ['🏴‍☠️', '💀', '⚓'], a: 'Fluch der Karibik', k: 'film' },
    { e: ['🔴', '💊', '🔵', '💊'], a: 'Matrix', k: 'film' },
    { e: ['🐘', '🎪', '👂'], a: 'Dumbo', k: 'film' },
    { e: ['🧜‍♀️', '🐚'], a: 'Arielle die Meerjungfrau', k: 'film' },
    { e: ['🦍', '🏙️', '✈️'], a: 'King Kong', k: 'film' },
    { e: ['🤡', '🎈', '🕳️'], a: 'Es', k: 'film' },
    { e: ['👸', '🍎', '7️⃣'], a: 'Schneewittchen', k: 'film' },
    { e: ['👟', '👸', '🕛'], a: 'Aschenputtel', k: 'film' },
    { e: ['🐸', '👑'], a: 'Der Froschkönig', k: 'film' },
    { e: ['🌹', '👹', '🏰'], a: 'Die Schöne und das Biest', k: 'film' },
    { e: ['🧞', '🪔'], a: 'Aladdin', k: 'film' },
    { e: ['🥊', '🏆', '🇺🇸'], a: 'Rocky', k: 'film' },
    { e: ['🐧', '🕺', '🎵'], a: 'Happy Feet', k: 'film' },
    { e: ['🦁', '🐻', '🐍', '🌴'], a: 'Das Dschungelbuch', k: 'film' },
    { e: ['🤖', '🔫', '🕶️'], a: 'Terminator', k: 'film' },
    { e: ['🌊', '🛶', '🌺'], a: 'Vaiana', k: 'film' },
    /* ---------------- Sprichwörter ---------------- */
    { e: ['🕐', '💰'], a: 'Zeit ist Geld', k: 'sprichwort' },
    { e: ['🦟', '🐘'], a: 'Aus einer Mücke einen Elefanten machen', k: 'sprichwort' },
    { e: ['🔨', '🎯'], a: 'Den Nagel auf den Kopf treffen', k: 'sprichwort' },
    { e: ['🐕', '🐈'], a: 'Wie Hund und Katze', k: 'sprichwort' },
    { e: ['🌰', '🔥'], a: 'Die Kastanien aus dem Feuer holen', k: 'sprichwort' },
    { e: ['🐟', '💧', '😊'], a: 'Wie ein Fisch im Wasser', k: 'sprichwort' },
    { e: ['⏰', '🐦', '🐛'], a: 'Der frühe Vogel fängt den Wurm', k: 'sprichwort' },
    { e: ['🐺', '🐑'], a: 'Ein Wolf im Schafspelz', k: 'sprichwort' },
    { e: ['💧', '🪨'], a: 'Steter Tropfen höhlt den Stein', k: 'sprichwort' },
    { e: ['🙈', '🙉', '🙊'], a: 'Nichts sehen, nichts hören, nichts sagen', k: 'sprichwort' },
    { e: ['🐘', '🧠'], a: 'Ein Gedächtnis wie ein Elefant', k: 'sprichwort' },
    { e: ['🐝', '💼'], a: 'Fleißig wie eine Biene', k: 'sprichwort' },
    { e: ['🦊', '🧠'], a: 'Schlau wie ein Fuchs', k: 'sprichwort' },
    { e: ['🎩', '🐇'], a: 'Etwas aus dem Hut zaubern', k: 'sprichwort' },
    { e: ['🎁', '🐴', '👄'], a: 'Einem geschenkten Gaul schaut man nicht ins Maul', k: 'sprichwort' },
    { e: ['🐔', '🥚', '❓'], a: 'Was war zuerst da: Huhn oder Ei?', k: 'sprichwort' },
    { e: ['🛢️', '🕳️'], a: 'Ein Fass ohne Boden', k: 'sprichwort' },
    { e: ['🐻', '🍽️'], a: 'Einen Bärenhunger haben', k: 'sprichwort' },
    { e: ['🌩️', '💡'], a: 'Ein Geistesblitz', k: 'sprichwort' },
    { e: ['🐦', '🤚'], a: 'Besser der Spatz in der Hand', k: 'sprichwort' },
    { e: ['🧊', '🔨'], a: 'Das Eis brechen', k: 'sprichwort' },
    { e: ['🐈', '🎒'], a: 'Die Katze im Sack kaufen', k: 'sprichwort' },
    { e: ['🗣️', '🥈', '🤐', '🥇'], a: 'Reden ist Silber, Schweigen ist Gold', k: 'sprichwort' },
    { e: ['🐷', '🍀'], a: 'Schwein haben', k: 'sprichwort' },
    { e: ['🎻', '1️⃣'], a: 'Die erste Geige spielen', k: 'sprichwort' },
    { e: ['🚂', '👋'], a: 'Der Zug ist abgefahren', k: 'sprichwort' },
    { e: ['😴', '🐑', '🔢'], a: 'Schäfchen zählen', k: 'sprichwort' },
    { e: ['🎯', '⚫'], a: 'Ins Schwarze treffen', k: 'sprichwort' },
    { e: ['👐', '🚿'], a: 'Seine Hände in Unschuld waschen', k: 'sprichwort' },
    /* ---------------- Tiere ---------------- */
    { e: ['🌊', '🐴'], a: 'Seepferdchen', k: 'tier' },
    { e: ['🐻', '❄️'], a: 'Eisbär', k: 'tier' },
    { e: ['🐦', '🕷️'], a: 'Vogelspinne', k: 'tier' },
    { e: ['🌊', '🐷'], a: 'Meerschweinchen', k: 'tier' },
    { e: ['🐟', '🦅'], a: 'Fischadler', k: 'tier' },
    { e: ['🌳', '🐸'], a: 'Laubfrosch', k: 'tier' },
    { e: ['🌊', '🐄'], a: 'Seekuh', k: 'tier' },
    { e: ['👑', '🐍'], a: 'Königskobra', k: 'tier' },
    { e: ['🐜', '🐻'], a: 'Ameisenbär', k: 'tier' },
    { e: ['🌙', '🦋'], a: 'Nachtfalter', k: 'tier' },
    { e: ['👑', '🐝'], a: 'Bienenkönigin', k: 'tier' },
    { e: ['⭐', '🐟'], a: 'Seestern', k: 'tier' },
    { e: ['🩸', '🦇'], a: 'Vampirfledermaus', k: 'tier' },
    { e: ['⚔️', '🐟'], a: 'Schwertfisch', k: 'tier' },
    { e: ['🔨', '🦈'], a: 'Hammerhai', k: 'tier' },
    { e: ['🌊', '🐕'], a: 'Seehund', k: 'tier' },
    { e: ['🌰', '🐿️'], a: 'Eichhörnchen', k: 'tier' },
    { e: ['🔵', '🐋'], a: 'Blauwal', k: 'tier' },
    { e: ['🌊', '🦁'], a: 'Seelöwe', k: 'tier' },
    { e: ['🌳', '🥁', '🐦'], a: 'Specht', k: 'tier' },
    { e: ['🌈', '🐟'], a: 'Regenbogenforelle', k: 'tier' },
    { e: ['🐅', '🦈'], a: 'Tigerhai', k: 'tier' },
    { e: ['🤡', '🐟'], a: 'Clownfisch', k: 'tier' },
    { e: ['🪚', '🐟'], a: 'Sägefisch', k: 'tier' },
    { e: ['🎣', '🐟'], a: 'Anglerfisch', k: 'tier' },
    { e: ['🌊', '🐢'], a: 'Meeresschildkröte', k: 'tier' },
    { e: ['🎵', '🐦'], a: 'Singvogel', k: 'tier' },
    { e: ['👓', '🐍'], a: 'Brillenschlange', k: 'tier' },
    /* ---------------- Alltag ---------------- */
    { e: ['🍎', '🌳'], a: 'Apfelbaum', k: 'alltag' },
    { e: ['🍎', '🧃'], a: 'Apfelsaft', k: 'alltag' },
    { e: ['🌞', '🌻'], a: 'Sonnenblume', k: 'alltag' },
    { e: ['🔥', '🚒'], a: 'Feuerwehr', k: 'alltag' },
    { e: ['🚗', '🅿️'], a: 'Parkplatz', k: 'alltag' },
    { e: ['🏠', '🔑'], a: 'Hausschlüssel', k: 'alltag' },
    { e: ['🦷', '🪥'], a: 'Zahnbürste', k: 'alltag' },
    { e: ['📚', '🐛'], a: 'Bücherwurm', k: 'alltag' },
    { e: ['⏰', '🔔'], a: 'Wecker', k: 'alltag' },
    { e: ['🎂', '🕯️'], a: 'Geburtstag', k: 'alltag' },
    { e: ['🌧️', '☂️'], a: 'Regenschirm', k: 'alltag' },
    { e: ['❄️', '👨'], a: 'Schneemann', k: 'alltag' },
    { e: ['🧈', '🍞'], a: 'Butterbrot', k: 'alltag' },
    { e: ['🐄', '🥛'], a: 'Kuhmilch', k: 'alltag' },
    { e: ['🚂', '🏢'], a: 'Bahnhof', k: 'alltag' },
    { e: ['✈️', '🏢'], a: 'Flughafen', k: 'alltag' },
    { e: ['💊', '🏪'], a: 'Apotheke', k: 'alltag' },
    { e: ['🦷', '👨‍⚕️'], a: 'Zahnarzt', k: 'alltag' },
    { e: ['🍞', '🏪'], a: 'Bäckerei', k: 'alltag' },
    { e: ['🎬', '🏢'], a: 'Kino', k: 'alltag' },
    { e: ['⚽', '🏟️'], a: 'Fußballstadion', k: 'alltag' },
    { e: ['🎄', '⭐'], a: 'Weihnachtsbaum', k: 'alltag' },
    { e: ['🍳', '🥚'], a: 'Spiegelei', k: 'alltag' },
    { e: ['🥔', '🥗'], a: 'Kartoffelsalat', k: 'alltag' },
    { e: ['🍅', '🍲'], a: 'Tomatensuppe', k: 'alltag' },
    { e: ['🍎', '🥧'], a: 'Apfelkuchen', k: 'alltag' },
    { e: ['⚡', '🌩️'], a: 'Gewitter', k: 'alltag' },
    { e: ['🚲', '🛞'], a: 'Fahrrad', k: 'alltag' },
    { e: ['🎧', '🎵'], a: 'Kopfhörer', k: 'alltag' },
    { e: ['✉️', '📮'], a: 'Briefkasten', k: 'alltag' },
    { e: ['🔦', '🌑'], a: 'Taschenlampe', k: 'alltag' },
    { e: ['⌚', '🕐'], a: 'Armbanduhr', k: 'alltag' },
    { e: ['🧤', '❄️'], a: 'Handschuhe', k: 'alltag' },
    { e: ['🛋️', '📺'], a: 'Wohnzimmer', k: 'alltag' },
    { e: ['🛏️', '😴'], a: 'Schlafzimmer', k: 'alltag' },
    { e: ['🌊', '🏖️'], a: 'Strand', k: 'alltag' },
    { e: ['🎃', '👻'], a: 'Halloween', k: 'alltag' },
    { e: ['🐰', '🥚'], a: 'Ostern', k: 'alltag' },
    { e: ['💍', '💒'], a: 'Hochzeit', k: 'alltag' },
    { e: ['💻', '🖱️'], a: 'Computer', k: 'alltag' },
    { e: ['🧭', '🗺️'], a: 'Kompass', k: 'alltag' },
    { e: ['👓', '👀'], a: 'Brille', k: 'alltag' },
    { e: ['🪟', '🏠'], a: 'Fenster', k: 'alltag' },
    { e: ['🍴', '🔪'], a: 'Besteck', k: 'alltag' },
    { e: ['🌡️', '🤒'], a: 'Fieber', k: 'alltag' },
    { e: ['🏔️', '⛷️'], a: 'Skifahren', k: 'alltag' },
    { e: ['💰', '🏦'], a: 'Bank', k: 'alltag' },
    { e: ['📖', '🏢'], a: 'Bibliothek', k: 'alltag' },
    { e: ['🥔', '🍟'], a: 'Pommes', k: 'alltag' },
    { e: ['🌈', '🌧️'], a: 'Regenbogen', k: 'alltag' }
  ];

  /* ===================== SOLO: Schwierigkeit + Bots ===================== */
  var DIFF_KEYS = ['leicht', 'mittel', 'schwer'];
  var DIFFS = {
    leicht: { label: 'Leicht', emoji: '🌱', desc: 'Gemütliche Rätselfreunde', acc: [0.42, 0.52, 0.60], min: 3800, max: 10000 },
    mittel: { label: 'Mittel', emoji: '🌿', desc: 'Solide Rätselfüchse', acc: [0.58, 0.68, 0.76], min: 2600, max: 8000 },
    schwer: { label: 'Schwer', emoji: '🔥', desc: 'Emoji-Profis mit Tempo', acc: [0.74, 0.83, 0.90], min: 1500, max: 5500 }
  };
  var BOT_CHARS = [
    { name: 'Koko', emoji: '🦜' }, { name: 'Mango', emoji: '🐒' }, { name: 'Kaa', emoji: '🐍' },
    { name: 'Rex', emoji: '🦎' }, { name: 'Nala', emoji: '🐆' }, { name: 'Lila', emoji: '🦋' },
    { name: 'Bongo', emoji: '🦧' }, { name: 'Zippy', emoji: '🐸' }
  ];

  /* ===================== HILFSFUNKTIONEN ===================== */
  /* Deterministischer Zufall (LCG) — gleicher Seed, gleiche Rätsel bei allen. */
  function makeRng(seed) {
    var s = (seed >>> 0) || 1;
    return function () {
      s = (s * 1664525 + 1013904223) % 4294967296;
      return s / 4294967296;
    };
  }
  function shuffleRng(a, rnd) {
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(rnd() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }
  function shuffle(a) { return shuffleRng(a, Math.random); }

  /* Baut die komplette Partie aus einem Seed: 20 Rätsel, je 4 gemischte
     Antworten (falsche aus derselben Kategorie). Rein deterministisch. */
  function buildDeck(seed) {
    var rnd = makeRng(seed);
    var idx = [], i;
    for (i = 0; i < RIDDLES.length; i++) idx.push(i);
    shuffleRng(idx, rnd);
    return idx.slice(0, ROUNDS).map(function (ri) {
      var q = RIDDLES[ri];
      var same = [], j;
      for (j = 0; j < RIDDLES.length; j++) if (j !== ri && RIDDLES[j].k === q.k) same.push(j);
      shuffleRng(same, rnd);
      var opts = [q.a], m;
      for (m = 0; m < same.length && opts.length < 4; m++) {
        var t = RIDDLES[same[m]].a;
        if (opts.indexOf(t) < 0) opts.push(t);
      }
      /* Sicherheitsnetz, falls eine Kategorie mal zu klein wird */
      for (m = 0; m < RIDDLES.length && opts.length < 4; m++) {
        if (opts.indexOf(RIDDLES[m].a) < 0) opts.push(RIDDLES[m].a);
      }
      shuffleRng(opts, rnd);
      return { e: q.e, a: q.a, k: q.k, opts: opts, correct: opts.indexOf(q.a) };
    });
  }

  function speedBonus(msLeft) { return Math.max(0, Math.min(SPEED_MAX, Math.round(SPEED_MAX * msLeft / ASK_MS))); }
  function streakBonus(streak) { return streak >= STREAK_MIN ? Math.min((streak - STREAK_MIN + 1) * STREAK_STEP, STREAK_CAP) : 0; }
  function gainFor(msLeft, streakAfter) { return BASE_POINTS + speedBonus(msLeft) + streakBonus(streakAfter); }

  /* ===================== REGISTRIERUNG ===================== */
  App.Minigames.emojiquiz = {
    id: 'emojiquiz', title: 'Emoji-Rätsel', icon: '🎬', order: 119,
    subtitle: '👑🦁 – errate den Begriff hinter den Emojis',
    single: true, multi: true, minPlayers: 2, maxPlayers: 8,

    render: function (root, ctx) {
      var isMulti = ctx.mode === 'multi';
      var nowFn = isMulti ? ctx.room.now : function () { return Date.now(); };

      var dead = false;
      var stops = [];        // stop()-Funktionen (App.MG-Bausteine, room.off, Listener)
      var pending = [];      // laufende setTimeout-IDs
      var floats = [];       // schwebende +Punkte-Elemente am document.body
      var started = false;   // Sperre: room-Events feuern sehr oft
      var finished = false;
      var loop = null;       // Master-Tick (100 ms, Wall-Clock)

      /* Partie-Zustand */
      var deck = [], score = 0, streak = 0, bestStreak = 0, correctCnt = 0;
      var curIdx = -1, curPhase = null, answered = false, startAtMs = 0;
      var bots = [], diffKey = 'mittel';

      /* DOM der laufenden Ansicht */
      var scoreEl, streakEl, progEl, timerEl, barEl, emojiEl, catEl, revealEl;
      var ansBtns = [], boardWrap, boardEl = null, onKey = null;

      function after(ms, fn) { var t = setTimeout(function () { if (!dead) fn(); }, ms); pending.push(t); return t; }
      function clearPending() { pending.forEach(clearTimeout); pending = []; }
      function stopHelpers() { stops.forEach(function (f) { try { f(); } catch (e) {} }); stops = []; }
      function stopLoop() { if (loop) { clearInterval(loop); loop = null; } }
      function stopKeys() { if (onKey) { document.removeEventListener('keydown', onKey); onKey = null; } }
      function clearFloats() { floats.slice().forEach(removeFloat); }
      function cleanup() {
        dead = true;
        stopLoop(); clearPending(); stopHelpers(); stopKeys(); clearFloats();
      }
      function sfx(n) { if (App.Audio) App.Audio.sfx(n); }

      if (isMulti) startMulti(); else chooseDifficulty();
      return { cleanup: cleanup };

      /* ===================== MULTIPLAYER-START ===================== */
      function startMulti() {
        var room = ctx.room;
        ensureSeed();

        var snap = room.snapshot() || {};
        var startAt = (snap.round && snap.round.startAt) || (room.now() + 3000);
        stops.push(App.MG.countdown(root, startAt, function () { tryStart(startAt); }, room.now));

        /* Der Seed kann kurz nach dem Countdown eintreffen → idempotent starten. */
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
          return (s && s.shared && typeof s.shared.emqSeed === 'number') ? s.shared.emqSeed : null;
        }
        function ensureSeed() {
          if (!room.isHost() && !ctx.isHost) return;
          if (getSeed() !== null) return;
          room.setShared({ emqSeed: Math.floor(Math.random() * 1000000000) });
        }
        function showWaiting() {
          root.innerHTML = '';
          root.appendChild(el('div', { class: 'glass emq-wait' }, [
            el('div', { class: 'emq-wait-icon' }, ['🎬']),
            el('h2', { class: 'neon' }, ['Rätsel werden gemischt …']),
            el('p', { class: 'hint-text' }, ['Der Gastgeber verteilt gleich die Emoji-Rätsel.'])
          ]));
        }
      }

      /* ===================== SOLO: Schwierigkeitswahl ===================== */
      function chooseDifficulty() {
        stopLoop(); clearPending(); stopHelpers(); stopKeys(); clearFloats();
        started = false; finished = false;

        var cur = App.Storage.get('emq_diff', 'mittel');
        if (DIFF_KEYS.indexOf(cur) < 0) cur = 'mittel';
        var best = App.Storage.get('best_emojiquiz', 0);

        var btns = DIFF_KEYS.map(function (k) {
          var d = DIFFS[k];
          return el('button', {
            class: 'emq-diff-btn' + (k === cur ? ' on' : ''), type: 'button',
            onclick: function () { sfx('select'); soloStart(k); }
          }, [
            el('span', { class: 'emq-diff-emoji' }, [d.emoji]),
            el('span', { class: 'emq-diff-name' }, [d.label]),
            el('span', { class: 'emq-diff-desc' }, [d.desc])
          ]);
        });

        root.innerHTML = '';
        root.appendChild(el('div', { class: 'emq-intro' }, [
          el('div', { class: 'glass emq-intro-card' }, [
            el('div', { class: 'emq-intro-emojis' }, [
              el('span', { class: 'emq-emoji' }, ['👑']),
              el('span', { class: 'emq-emoji' }, ['🦁'])
            ]),
            el('h2', { class: 'neon' }, ['Emoji-Rätsel']),
            el('p', { class: 'hint-text' }, [
              ROUNDS + ' Rätsel · 12 Sekunden pro Rätsel · 100 Punkte + bis zu 100 Tempo-Bonus · Serien-Bonus ab 3 richtigen in Folge'
            ]),
            el('div', { class: 'emq-best' }, ['🏆 Dein Rekord: ' + App.MG.fmt(best)]),
            el('div', { class: 'mg-field-title' }, ['Gegner wählen']),
            el('div', { class: 'emq-diff-row' }, btns)
          ])
        ]));
      }

      function soloStart(k) {
        diffKey = k;
        App.Storage.set('emq_diff', k);
        play(Date.now(), Math.floor(Math.random() * 1000000000));
      }

      /* ===================== PARTIE ===================== */
      function play(startAt, seed) {
        if (dead) return;
        stopLoop(); clearPending(); stopHelpers(); stopKeys(); clearFloats();
        started = true; finished = false;

        startAtMs = startAt;
        deck = buildDeck(seed);
        score = 0; streak = 0; bestStreak = 0; correctCnt = 0;
        curIdx = -1; curPhase = null; answered = false;

        buildUI();
        if (isMulti) ctx.room.reportScore(0);
        else { setupBots(); renderBoard(); }

        tick();                                   // sofort das erste Rätsel zeigen
        loop = setInterval(tick, 100);            // Wall-Clock-Loop → Tab-sicher
      }

      /* Master-Tick: leitet Rätsel-Index UND Phase allein aus der Uhr ab.
         Dadurch laufen alle Geräte ohne weitere Absprache synchron. */
      function tick() {
        if (dead || finished) return;
        var elapsed = nowFn() - startAtMs;
        if (elapsed < 0) elapsed = 0;
        var idx = Math.floor(elapsed / SLOT_MS);
        if (idx >= ROUNDS) { finish(); return; }

        var inSlot = elapsed - idx * SLOT_MS;
        var phase = inSlot < ASK_MS ? 'ask' : 'reveal';

        if (idx !== curIdx) showQuestion(idx);
        if (phase !== curPhase) {
          curPhase = phase;
          if (phase === 'reveal') doReveal();
        }
        if (phase === 'ask') {
          updateTimer(ASK_MS - inSlot);
          if (!isMulti) runBots(idx, nowFn());
        }
      }

      function slotStart(idx) { return startAtMs + idx * SLOT_MS; }
      function slotAskEnd(idx) { return slotStart(idx) + ASK_MS; }

      /* ---------- Rätsel anzeigen ---------- */
      function showQuestion(idx) {
        curIdx = idx;
        curPhase = null;          // erzwingt die Phasen-Prüfung im selben Tick
        answered = false;
        var q = deck[idx];

        catEl.className = 'chip emq-cat ' + CATS[q.k].cls;
        catEl.textContent = CATS[q.k].label;
        progEl.textContent = 'Rätsel ' + (idx + 1) + ' / ' + ROUNDS;
        renderEmojis(q.e);

        ansBtns.forEach(function (b, i) {
          b.className = 'emq-ans';
          b.disabled = false;
          b.querySelector('.emq-ans-txt').textContent = q.opts[i];
        });

        revealEl.className = 'emq-reveal';
        revealEl.innerHTML = '';
        boardWrap.classList.remove('emq-hot');
        if (!isMulti) planBots(idx);
        sfx('whoosh');
      }

      function renderEmojis(list) {
        emojiEl.innerHTML = '';
        list.forEach(function (ch, i) {
          var s = el('span', { class: 'emq-emoji' }, [ch]);
          s.style.animationDelay = (i * 0.17) + 's';
          emojiEl.appendChild(s);
        });
        emojiEl.classList.remove('emq-pop');
        void emojiEl.offsetWidth;
        emojiEl.classList.add('emq-pop');
      }

      function updateTimer(left) {
        var pct = Math.max(0, Math.min(100, (left / ASK_MS) * 100));
        barEl.style.width = pct + '%';
        barEl.classList.toggle('emq-bar-low', left <= 3500);
        timerEl.textContent = Math.max(0, Math.ceil(left / 1000)) + 's';
        timerEl.classList.toggle('emq-urgent', left <= 3500);
      }

      /* ---------- Antwort ---------- */
      function handleAnswer(i) {
        if (dead || finished || answered || curIdx < 0 || curPhase !== 'ask') return;
        var q = deck[curIdx];
        if (!q) return;
        answered = true;
        ansBtns.forEach(function (b) { b.disabled = true; });

        var left = Math.max(0, slotAskEnd(curIdx) - nowFn());
        if (i === q.correct) {
          streak++;
          if (streak > bestStreak) bestStreak = streak;
          correctCnt++;
          var sb = streakBonus(streak);
          var gain = gainFor(left, streak);
          score += gain;
          ansBtns[i].className = 'emq-ans emq-right';
          sfx(sb > 0 ? 'levelup' : 'point');
          popFloat(ansBtns[i], '+' + gain);
          showSolution('right', gain, sb);
        } else {
          streak = 0;
          ansBtns[i].className = 'emq-ans emq-wrong';
          ansBtns[q.correct].className = 'emq-ans emq-right';
          sfx('error');
          showSolution('wrong', 0, 0);
        }
        updateHud();
        if (isMulti) ctx.room.reportScore(score);
        else renderBoard();
      }

      /* ---------- Auflösung zwischen den Rätseln ---------- */
      function doReveal() {
        var q = deck[curIdx];
        if (!q) return;
        ansBtns.forEach(function (b) { b.disabled = true; });
        if (!answered) {
          streak = 0;
          ansBtns[q.correct].className = 'emq-ans emq-right';
          sfx('lose');
          showSolution('timeout', 0, 0);
          updateHud();
          if (isMulti) ctx.room.reportScore(score);
        }
        /* Offene Bot-Pläne einlösen — auch wenn der Tick-Takt im Hintergrund-Tab
           grob war, geht dadurch keine Bot-Antwort verloren. */
        if (!isMulti) {
          bots.forEach(function (b) {
            if (b.plan && !b.plan.applied) resolveBot(b, b.plan.idx);
          });
          renderBoard();
        }
        barEl.style.width = '0%';
        timerEl.textContent = '…';
        timerEl.classList.remove('emq-urgent');
        boardWrap.classList.add('emq-hot');       // Rangliste zwischen den Rätseln hervorheben
      }

      function showSolution(kind, gain, sb) {
        var q = deck[curIdx];
        var ico = kind === 'right' ? '✅' : (kind === 'wrong' ? '❌' : '⌛');
        var txt = kind === 'right' ? 'Richtig: ' + q.a
          : (kind === 'wrong' ? 'Leider falsch — richtig war: ' + q.a : 'Zeit um! Richtig war: ' + q.a);
        revealEl.className = 'emq-reveal on ' + (kind === 'right' ? 'ok' : 'no');
        revealEl.innerHTML = '';
        revealEl.appendChild(el('span', { class: 'emq-rev-ico' }, [ico]));
        revealEl.appendChild(el('span', { class: 'emq-rev-txt' }, [txt]));
        if (gain) revealEl.appendChild(el('span', { class: 'emq-rev-pts' }, ['+' + gain + (sb ? ' 🔥' : '')]));
      }

      function updateHud() {
        scoreEl.textContent = App.MG.fmt(score);
        scoreEl.classList.remove('emq-bump'); void scoreEl.offsetWidth; scoreEl.classList.add('emq-bump');
        if (streak >= 2) {
          var nb = streakBonus(streak);
          streakEl.textContent = '🔥 Serie ×' + streak + (nb ? ' · +' + nb : ' · gleich Bonus');
          streakEl.className = 'emq-streak on' + (nb ? ' hot' : '');
        } else {
          streakEl.textContent = '';
          streakEl.className = 'emq-streak';
        }
      }

      /* ===================== BOTS (nur Solo) ===================== */
      function setupBots() {
        var d = DIFFS[diffKey];
        var pool = shuffle(BOT_CHARS.slice());
        bots = [];
        for (var i = 0; i < 3; i++) {
          bots.push({
            id: 'bot' + i, name: pool[i].name, emoji: pool[i].emoji,
            score: 0, streak: 0, acc: d.acc[i], plan: null
          });
        }
      }

      /* Für jedes Rätsel würfelt jeder Bot Trefferquote + Antwortzeit aus.
         Wer die Lösung nicht weiß, zögert länger — und verpasst so auf
         "Leicht" auch mal die 12 Sekunden (hit = rechtzeitig UND richtig).
         Der Plan hängt nur an der Wall-Clock, nicht am Tick-Takt. */
      function planBots(idx) {
        var d = DIFFS[diffKey];
        var span = d.max - d.min;
        bots.forEach(function (b) {
          var correct = Math.random() < b.acc;
          var t = correct
            ? d.min + Math.random() * span
            : d.min + span * 0.5 + Math.random() * span * 0.9 + 700;
          b.plan = { at: slotStart(idx) + t, hit: correct && t < ASK_MS - 300, applied: false, idx: idx };
        });
      }

      /* Plan einlösen: Punkte nach derselben Formel wie beim Menschen. */
      function resolveBot(b, idx) {
        b.plan.applied = true;
        if (b.plan.hit) {
          b.streak++;
          b.score += gainFor(Math.max(0, slotAskEnd(idx) - b.plan.at), b.streak);
        } else {
          b.streak = 0;                           // falsch geraten oder Zeit verpasst
        }
      }

      function runBots(idx, now) {
        var changed = false;
        bots.forEach(function (b) {
          if (!b.plan || b.plan.idx !== idx || b.plan.applied || now < b.plan.at) return;
          resolveBot(b, idx);
          changed = true;
        });
        if (changed) renderBoard();
      }

      function soloRows() {
        var rows = [{ name: (ctx.me && ctx.me.name) || 'Du', emoji: '🙋', score: score, me: true }];
        bots.forEach(function (b) { rows.push({ name: b.name, emoji: b.emoji, score: b.score, me: false }); });
        rows.sort(function (a, b) { return b.score - a.score; });
        return rows;
      }

      function renderBoard() {
        if (!boardEl) return;
        var rows = soloRows();
        boardEl.innerHTML = '';
        rows.forEach(function (p, i) {
          boardEl.appendChild(el('div', { class: 'mg-sb-row p' + (i + 1) + (p.me ? ' me' : '') }, [
            el('span', { class: 'mg-sb-rank' }, ['' + (i + 1)]),
            el('span', { class: 'mg-sb-name' }, [p.emoji + ' ' + p.name + (p.me ? ' (du)' : '')]),
            el('span', { class: 'mg-sb-score' }, [App.MG.fmt(p.score)])
          ]));
        });
      }

      /* ===================== AUFBAU DER ANSICHT ===================== */
      function buildUI() {
        scoreEl = el('div', { class: 'emq-score' }, ['0']);
        streakEl = el('div', { class: 'emq-streak' }, ['']);
        progEl = el('div', { class: 'emq-prog' }, ['Rätsel 1 / ' + ROUNDS]);
        timerEl = el('div', { class: 'mg-timer emq-timer' }, [Math.round(ASK_MS / 1000) + 's']);

        var head = el('div', { class: 'emq-head glass' }, [
          el('div', { class: 'emq-head-cell' }, [el('span', { class: 'emq-head-l' }, ['Punkte']), scoreEl]),
          el('div', { class: 'emq-head-mid' }, [progEl, streakEl]),
          el('div', { class: 'emq-head-cell emq-head-right' }, [el('span', { class: 'emq-head-l' }, ['Zeit']), timerEl])
        ]);

        barEl = el('div', { class: 'emq-bar' });
        catEl = el('span', { class: 'chip emq-cat' }, ['—']);
        emojiEl = el('div', { class: 'emq-emojis' });
        var stage = el('div', { class: 'emq-stage glass' }, [
          el('div', { class: 'emq-stage-top' }, [catEl, el('span', { class: 'emq-stage-q' }, ['Was ist gemeint?'])]),
          emojiEl,
          el('div', { class: 'emq-track' }, [barEl])
        ]);

        ansBtns = [];
        for (var i = 0; i < 4; i++) {
          var b = el('button', { class: 'emq-ans', type: 'button' }, [
            el('span', { class: 'emq-ans-key' }, [String(i + 1)]),
            el('span', { class: 'emq-ans-txt' }, [''])
          ]);
          b.dataset.idx = String(i);
          b.addEventListener('click', function () { handleAnswer(Number(this.dataset.idx)); });
          ansBtns.push(b);
        }
        var answers = el('div', { class: 'emq-answers' }, ansBtns);
        revealEl = el('div', { class: 'emq-reveal' }, ['']);

        boardWrap = el('div', { class: 'emq-board-wrap glass' }, [
          el('div', { class: 'mg-field-title' }, ['🏆 Rangliste'])
        ]);
        if (isMulti) {
          var lb = App.MG.liveBoard(ctx.room, ctx.me.id);
          boardWrap.appendChild(lb.root);
          stops.push(lb.stop);
          boardEl = null;
        } else {
          boardEl = el('div', { class: 'mg-scoreboard' });
          boardWrap.appendChild(boardEl);
        }

        var main = el('div', { class: 'emq-main' }, [stage, answers, revealEl]);
        root.innerHTML = '';
        root.appendChild(el('div', { class: 'emq-layout' }, [
          head,
          el('div', { class: 'emq-cols' }, [main, boardWrap]),
          el('p', { class: 'hint-text emq-rules' }, [
            '🎯 Errate den Begriff hinter den Emojis · Antippen oder Taste 1–4 · schneller = mehr Tempo-Bonus · ab 3 richtigen in Folge gibt es Serien-Bonus'
          ])
        ]));

        onKey = function (e) {
          var k = '1234'.indexOf(e.key);
          if (k >= 0) { e.preventDefault(); handleAnswer(k); }
        };
        document.addEventListener('keydown', onKey);
      }

      /* Schwebende +Punkte über dem Antwort-Button. */
      function popFloat(anchor, txt) {
        var r = anchor.getBoundingClientRect();
        var f = el('div', { class: 'emq-float', text: txt });
        f.style.left = (r.left + r.width / 2) + 'px';
        f.style.top = (r.top + r.height / 2) + 'px';
        document.body.appendChild(f);
        floats.push(f);
        pending.push(setTimeout(function () { f.classList.add('go'); }, 10));
        pending.push(setTimeout(function () { removeFloat(f); }, 900));
      }
      function removeFloat(f) {
        if (f.parentNode) f.parentNode.removeChild(f);
        var i = floats.indexOf(f);
        if (i >= 0) floats.splice(i, 1);
      }

      /* ===================== ENDE ===================== */
      function finish() {
        if (finished || dead) return;
        finished = true;
        stopLoop(); clearPending(); stopKeys(); clearFloats();

        if (isMulti) {
          ctx.room.reportScore(score);
          var ps = ctx.room.players().slice().sort(function (a, b) { return (b.score || 0) - (a.score || 0); });
          sfx(ps[0] && ps[0].id === ctx.me.id ? 'win' : 'info');
          stopHelpers();
          after(1300, function () {
            App.MG.endScreen(root, { players: ctx.room.players(), meId: ctx.me.id, onExit: ctx.onExit });
          });
        } else {
          stopHelpers();
          var best = App.Storage.get('best_emojiquiz', 0);
          var nb = score > best;
          if (nb) App.Storage.set('best_emojiquiz', score);

          var rows = soloRows(), place = 1;
          for (var i = 0; i < rows.length; i++) if (rows[i].me) { place = i + 1; break; }
          sfx(nb || place === 1 ? 'win' : 'info');

          var label = correctCnt + ' von ' + ROUNDS + ' richtig · Top-Serie ×' + bestStreak
            + ' · Platz ' + place + ' von ' + rows.length + ' (' + DIFFS[diffKey].label + ')'
            + (nb ? ' · Neuer Rekord! 🎉' : ' · Bestwert: ' + App.MG.fmt(best));

          after(1300, function () {
            App.MG.endScreen(root, {
              score: score, best: best, newBest: nb, label: label,
              onExit: ctx.onExit,
              onAgain: function () { chooseDifficulty(); }
            });
          });
        }
      }
    }
  };

  /* ===================== STYLE ===================== */
  function injectStyle() {
    UI.injectStyle('mg-emojiquiz-css', [
      '.emq-layout{display:flex;flex-direction:column;gap:14px;}',
      /* Kopfzeile */
      '.emq-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 18px;flex-wrap:wrap;}',
      '.emq-head-cell{display:flex;flex-direction:column;gap:2px;min-width:0;}',
      '.emq-head-right{text-align:right;}',
      '.emq-head-l{font-size:11px;text-transform:uppercase;letter-spacing:1px;color:var(--muted);font-weight:800;}',
      '.emq-head-mid{display:flex;flex-direction:column;align-items:center;gap:3px;min-width:0;flex:1;}',
      '.emq-score{font-size:clamp(24px,6vw,38px);font-weight:900;line-height:1;color:var(--gold);',
      'text-shadow:0 0 12px rgba(255,210,63,.45);font-variant-numeric:tabular-nums;}',
      '.emq-score.emq-bump{animation:emq-bump .3s ease;}',
      '@keyframes emq-bump{0%{transform:scale(1)}40%{transform:scale(1.16)}100%{transform:scale(1)}}',
      '.emq-prog{font-size:12px;font-weight:800;letter-spacing:.5px;text-transform:uppercase;color:var(--aqua-soft);white-space:nowrap;}',
      '.emq-streak{font-size:13px;font-weight:900;color:var(--leaf);min-height:1em;opacity:0;text-align:center;}',
      '.emq-streak.on{opacity:1;animation:emq-streak-pop .3s ease;}',
      '.emq-streak.hot{color:var(--neon);text-shadow:0 0 10px rgba(57,255,20,.6);}',
      '@keyframes emq-streak-pop{0%{transform:scale(.7)}60%{transform:scale(1.16)}100%{transform:scale(1)}}',
      '.emq-timer{font-size:clamp(18px,5vw,26px);font-variant-numeric:tabular-nums;}',
      '.emq-timer.emq-urgent{color:var(--danger);animation:emq-blink 1s steps(2,start) infinite;}',
      '@keyframes emq-blink{50%{opacity:.4}}',
      /* Spalten */
      '.emq-cols{display:grid;grid-template-columns:1fr;gap:14px;}',
      '@media(min-width:760px){.emq-cols{grid-template-columns:1.7fr 1fr;align-items:start;}}',
      '.emq-main{display:flex;flex-direction:column;gap:12px;min-width:0;}',
      /* Bühne mit den Emojis */
      '.emq-stage{padding:16px 18px 14px;display:flex;flex-direction:column;gap:12px;overflow:hidden;',
      'background:radial-gradient(circle at 50% 20%,rgba(57,255,20,.09),transparent 70%);}',
      '.emq-stage-top{display:flex;align-items:center;justify-content:space-between;gap:10px;}',
      '.emq-stage-q{font-size:11px;font-weight:800;letter-spacing:1px;text-transform:uppercase;color:var(--muted);}',
      '.emq-cat{font-size:12px;font-weight:800;}',
      '.emq-cat-film{border-color:var(--stroke-2);color:var(--aqua);}',
      '.emq-cat-spr{border-color:rgba(255,210,63,.5);color:var(--gold);}',
      '.emq-cat-tier{border-color:rgba(57,255,20,.5);color:var(--neon);}',
      '.emq-cat-all{border-color:rgba(192,192,192,.45);color:var(--silver);}',
      '.emq-emojis{display:flex;flex-wrap:wrap;align-items:center;justify-content:center;gap:6px;',
      'min-height:clamp(96px,22vw,140px);padding:6px 0;text-align:center;}',
      '.emq-emojis.emq-pop{animation:emq-stage-pop .3s cubic-bezier(.2,.8,.3,1);}',
      '@keyframes emq-stage-pop{0%{transform:scale(.86);opacity:.2}100%{transform:scale(1);opacity:1}}',
      '.emq-emoji{display:inline-block;font-size:clamp(44px,12vw,84px);line-height:1.15;',
      'filter:drop-shadow(0 6px 16px rgba(0,0,0,.5));animation:emq-wobble 2.8s ease-in-out infinite;}',
      '@keyframes emq-wobble{0%,100%{transform:rotate(-5deg) translateY(2px) scale(1)}',
      '50%{transform:rotate(5deg) translateY(-6px) scale(1.05)}}',
      /* Zeitbalken */
      '.emq-track{height:9px;border-radius:99px;background:rgba(9,32,21,.8);border:1px solid var(--stroke);overflow:hidden;}',
      '.emq-bar{height:100%;width:100%;border-radius:99px;background:linear-gradient(90deg,var(--gold),var(--neon));',
      'box-shadow:0 0 12px rgba(57,255,20,.5);transition:width .1s linear;}',
      '.emq-bar.emq-bar-low{background:linear-gradient(90deg,var(--danger),#ff9f57);box-shadow:0 0 12px rgba(255,77,109,.6);}',
      /* Antworten */
      '.emq-answers{display:grid;grid-template-columns:1fr 1fr;gap:10px;}',
      '.emq-ans{position:relative;display:flex;align-items:center;gap:9px;font-family:inherit;',
      'font-size:clamp(13px,3.4vw,18px);font-weight:800;color:var(--text);cursor:pointer;text-align:left;',
      'min-height:clamp(60px,13vw,82px);padding:10px 12px;border-radius:16px;background:rgba(9,32,21,.75);',
      'border:1.5px solid var(--stroke-2);transition:transform .08s,box-shadow .15s,background .15s,border-color .15s;',
      'user-select:none;-webkit-user-select:none;-webkit-tap-highlight-color:transparent;touch-action:manipulation;}',
      '.emq-ans-key{flex:none;display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;',
      'border-radius:8px;background:rgba(57,255,20,.12);border:1px solid var(--stroke-2);color:var(--aqua-soft);font-size:12px;font-weight:900;}',
      '.emq-ans-txt{flex:1;line-height:1.2;word-break:break-word;}',
      '.emq-ans:hover:not(:disabled){box-shadow:var(--glow-soft);transform:translateY(-2px);border-color:var(--neon);}',
      '.emq-ans:active:not(:disabled){transform:scale(.97);}',
      '.emq-ans:disabled{cursor:default;}',
      '.emq-ans.emq-right{background:rgba(57,255,20,.22);border-color:var(--neon);color:var(--leaf);',
      'box-shadow:0 0 22px rgba(57,255,20,.55);animation:emq-right-pop .32s ease;}',
      '.emq-ans.emq-right .emq-ans-key{background:var(--neon);color:#04160c;}',
      '@keyframes emq-right-pop{0%{transform:scale(1)}40%{transform:scale(1.05)}100%{transform:scale(1)}}',
      '.emq-ans.emq-wrong{background:rgba(255,77,109,.22);border-color:var(--danger);color:#ffb3c1;animation:emq-shake .32s ease;}',
      '.emq-ans.emq-wrong .emq-ans-key{background:var(--danger);color:#fff;}',
      '@keyframes emq-shake{0%,100%{transform:translateX(0)}20%{transform:translateX(-7px)}60%{transform:translateX(7px)}}',
      /* Auflösung */
      '.emq-reveal{display:flex;align-items:center;justify-content:center;gap:10px;min-height:0;height:0;',
      'opacity:0;overflow:hidden;border-radius:14px;padding:0 14px;font-weight:800;',
      'transition:height .18s ease,opacity .18s ease,padding .18s ease;}',
      '.emq-reveal.on{height:auto;min-height:52px;opacity:1;padding:10px 14px;border:1px solid var(--stroke-2);}',
      '.emq-reveal.ok{background:rgba(57,255,20,.14);border-color:var(--stroke-2);}',
      '.emq-reveal.no{background:rgba(255,77,109,.14);border-color:rgba(255,77,109,.45);}',
      '.emq-rev-ico{font-size:22px;flex:none;}',
      '.emq-rev-txt{font-size:clamp(13px,3.4vw,17px);color:var(--text);text-align:center;}',
      '.emq-reveal.ok .emq-rev-txt{color:var(--leaf);}',
      '.emq-reveal.no .emq-rev-txt{color:#ffb3c1;}',
      '.emq-rev-pts{flex:none;font-size:16px;font-weight:900;color:var(--gold);text-shadow:0 0 10px rgba(255,210,63,.5);}',
      /* Rangliste */
      '.emq-board-wrap{padding:14px;display:flex;flex-direction:column;gap:8px;transition:box-shadow .25s,border-color .25s;}',
      '.emq-board-wrap .mg-scoreboard{max-height:300px;overflow-y:auto;}',
      '.emq-board-wrap.emq-hot{box-shadow:0 0 26px rgba(57,255,20,.4);border-color:var(--neon);}',
      /* Regelzeile */
      '.emq-rules{text-align:center;margin:0;}',
      /* Schwebende Punkte */
      '.emq-float{position:fixed;pointer-events:none;z-index:85;font-weight:900;font-size:26px;color:var(--neon);',
      'text-shadow:0 2px 10px rgba(0,0,0,.6);transform:translate(-50%,0);transition:all .85s ease-out;opacity:1;}',
      '.emq-float.go{transform:translate(-50%,-70px);opacity:0;}',
      /* Solo-Startbildschirm */
      '.emq-intro{display:flex;justify-content:center;}',
      '.emq-intro-card{padding:26px 22px;display:flex;flex-direction:column;gap:12px;align-items:center;',
      'text-align:center;max-width:540px;width:100%;}',
      '.emq-intro-emojis{display:flex;gap:6px;}',
      '.emq-best{font-weight:900;color:var(--gold);font-size:15px;}',
      '.emq-diff-row{display:grid;grid-template-columns:1fr;gap:10px;width:100%;}',
      '@media(min-width:520px){.emq-diff-row{grid-template-columns:1fr 1fr 1fr;}}',
      '.emq-diff-btn{display:flex;flex-direction:column;align-items:center;gap:3px;padding:14px 10px;border-radius:16px;',
      'background:rgba(9,32,21,.75);border:1.5px solid var(--stroke);cursor:pointer;font-family:inherit;color:var(--text);',
      'transition:transform .08s,box-shadow .15s,border-color .15s;-webkit-tap-highlight-color:transparent;}',
      '.emq-diff-btn:hover{border-color:var(--neon);box-shadow:var(--glow-soft);transform:translateY(-2px);}',
      '.emq-diff-btn:active{transform:scale(.97);}',
      '.emq-diff-btn.on{border-color:var(--neon);box-shadow:0 0 18px rgba(57,255,20,.35);}',
      '.emq-diff-emoji{font-size:26px;line-height:1;}',
      '.emq-diff-name{font-weight:900;font-size:15px;color:var(--leaf);}',
      '.emq-diff-desc{font-size:11px;color:var(--muted);line-height:1.25;}',
      /* Wartebildschirm (Multi) */
      '.emq-wait{padding:44px 26px;text-align:center;display:flex;flex-direction:column;gap:10px;',
      'align-items:center;max-width:440px;margin:0 auto;}',
      '.emq-wait-icon{font-size:60px;line-height:1;animation:emq-wobble 2.8s ease-in-out infinite;}'
    ].join(''));
  }
})();
