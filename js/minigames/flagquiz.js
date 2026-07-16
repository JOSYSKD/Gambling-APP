/* flagquiz.js — "Flaggen-Quiz": 20 Flaggen, 10 Sekunden pro Frage.
 *
 * SPIELIDEE: Oben leuchtet eine große Flagge, darunter stehen 4 Antworten.
 *   Jede 4. Frage ist eine ⭐ Bonus-Frage: Flagge + Land sind zu sehen, gesucht
 *   ist die Hauptstadt. Die Länderliste (>90 Einträge) steckt fest im Code,
 *   die Flaggen entstehen aus dem ISO-Code (zwei Regional-Indicator-Emojis) —
 *   das ist weniger fehleranfällig als Flaggen-Emojis von Hand zu tippen.
 *
 * STEUERUNG: Antwort antippen/anklicken oder Taste 1–4.
 *
 * PUNKTE: richtig = 100 + Tempobonus (bis 100, linear über die 10 s; wer sofort
 *   antwortet, bekommt alles). Ab 3 richtigen Antworten in Folge zählt die
 *   Frage ×1,5 (max. 300). Falsch oder Zeit abgelaufen = 0 Punkte, die Serie
 *   reißt und die richtige Antwort leuchtet grün auf.
 *
 * SOLO: Startbildschirm mit 3 Schwierigkeiten. Es laufen 3 Bots mit
 *   Trefferquote + eigener Antwortzeit-Streuung mit (Bonusfragen sind auch für
 *   sie schwerer) und zusätzlich ein 👻 Rekord-Geist, der die Punkte des
 *   eigenen Rekords (best_flagquiz) gleichmäßig über die 20 Fragen verteilt —
 *   so sieht man live, ob man über oder unter dem eigenen Bestwert liegt.
 *
 * SYNC-MODELL (multi): Der Host würfelt EINEN Seed und legt ihn zusammen mit
 *   dem Fragen-Fahrplan in shared ab: { flqSeed, flqCur:{ i, startAt } }.
 *   Aus dem Seed baut JEDER Client per LCG dieselben 20 Fragen inkl. gleicher
 *   Antwort-Reihenfolge — es müssen also nie Fragen übertragen werden.
 *   flqCur.startAt ist Server-Zeit (room.now): daraus leitet jeder Client die
 *   Phase selbst ab (Frage offen → gesperrt → Auflösung → Zwischenstand).
 *   Nur der Host schaltet weiter — entweder wenn die 10 s um sind oder wenn
 *   ALLE geantwortet haben (room.reportState({q:i})). Nach der letzten Frage
 *   setzt er i = 20; sobald dessen startAt erreicht ist, endet das Spiel.
 *   Alle Timer laufen über Wall-Clock (room.now / Date.now) → Tab-sicher.
 *   Die room.on-Handler merken sich nur Daten; gezeichnet wird aus einem
 *   100-ms-Tick heraus in-place → Heartbeat-Events bauen nichts neu auf.
 */
(function () {
  'use strict';
  window.App = window.App || {}; App.Minigames = App.Minigames || {};
  var UI = App.UI, el = UI.el;

  /* ===================== Konstanten ===================== */
  var TOTAL = 20;              // Fragen pro Runde
  var ANSWER_MS = 10000;       // Antwortfenster je Frage
  var REVEAL_MS = 1500;        // Auflösung (richtige Antwort leuchtet)
  var BOARD_MS = 2300;         // Zwischenstand/Rangliste
  var GAP = REVEAL_MS + BOARD_MS;
  var BASE = 100;              // Grundpunkte
  var SPEED_MAX = 100;         // maximaler Tempobonus
  var STREAK_AT = 3;           // ab so vielen richtigen in Folge …
  var STREAK_MULT = 1.5;       // … zählt die Frage ×1,5
  var BONUS_EVERY = 4;         // jede 4. Frage ist eine Hauptstadt-Bonusfrage

  /* ===================== Länder =====================
   * cc = ISO-Code (daraus entsteht das Flaggen-Emoji), n = deutscher Name,
   * h = Hauptstadt, k = Kontinent (für faire Antwort-Alternativen).
   * nc:1 = kommt als Hauptstadtfrage nicht dran (mehrere/strittige
   * Hauptstädte) — als falsche Antwort-Alternative taugt die Stadt trotzdem. */
  var C = [
    /* --- Europa --- */
    { cc: 'DE', n: 'Deutschland', h: 'Berlin', k: 'eu' },
    { cc: 'FR', n: 'Frankreich', h: 'Paris', k: 'eu' },
    { cc: 'IT', n: 'Italien', h: 'Rom', k: 'eu' },
    { cc: 'ES', n: 'Spanien', h: 'Madrid', k: 'eu' },
    { cc: 'PT', n: 'Portugal', h: 'Lissabon', k: 'eu' },
    { cc: 'GB', n: 'Vereinigtes Königreich', h: 'London', k: 'eu' },
    { cc: 'IE', n: 'Irland', h: 'Dublin', k: 'eu' },
    { cc: 'NL', n: 'Niederlande', h: 'Amsterdam', k: 'eu' },
    { cc: 'BE', n: 'Belgien', h: 'Brüssel', k: 'eu' },
    { cc: 'LU', n: 'Luxemburg', h: 'Luxemburg', k: 'eu', nc: 1 },
    { cc: 'CH', n: 'Schweiz', h: 'Bern', k: 'eu' },
    { cc: 'AT', n: 'Österreich', h: 'Wien', k: 'eu' },
    { cc: 'DK', n: 'Dänemark', h: 'Kopenhagen', k: 'eu' },
    { cc: 'SE', n: 'Schweden', h: 'Stockholm', k: 'eu' },
    { cc: 'NO', n: 'Norwegen', h: 'Oslo', k: 'eu' },
    { cc: 'FI', n: 'Finnland', h: 'Helsinki', k: 'eu' },
    { cc: 'IS', n: 'Island', h: 'Reykjavík', k: 'eu' },
    { cc: 'PL', n: 'Polen', h: 'Warschau', k: 'eu' },
    { cc: 'CZ', n: 'Tschechien', h: 'Prag', k: 'eu' },
    { cc: 'SK', n: 'Slowakei', h: 'Bratislava', k: 'eu' },
    { cc: 'HU', n: 'Ungarn', h: 'Budapest', k: 'eu' },
    { cc: 'RO', n: 'Rumänien', h: 'Bukarest', k: 'eu' },
    { cc: 'BG', n: 'Bulgarien', h: 'Sofia', k: 'eu' },
    { cc: 'GR', n: 'Griechenland', h: 'Athen', k: 'eu' },
    { cc: 'HR', n: 'Kroatien', h: 'Zagreb', k: 'eu' },
    { cc: 'SI', n: 'Slowenien', h: 'Ljubljana', k: 'eu' },
    { cc: 'RS', n: 'Serbien', h: 'Belgrad', k: 'eu' },
    { cc: 'BA', n: 'Bosnien und Herzegowina', h: 'Sarajevo', k: 'eu' },
    { cc: 'ME', n: 'Montenegro', h: 'Podgorica', k: 'eu' },
    { cc: 'AL', n: 'Albanien', h: 'Tirana', k: 'eu' },
    { cc: 'MK', n: 'Nordmazedonien', h: 'Skopje', k: 'eu' },
    { cc: 'UA', n: 'Ukraine', h: 'Kiew', k: 'eu' },
    { cc: 'BY', n: 'Belarus', h: 'Minsk', k: 'eu' },
    { cc: 'RU', n: 'Russland', h: 'Moskau', k: 'eu' },
    { cc: 'LT', n: 'Litauen', h: 'Vilnius', k: 'eu' },
    { cc: 'LV', n: 'Lettland', h: 'Riga', k: 'eu' },
    { cc: 'EE', n: 'Estland', h: 'Tallinn', k: 'eu' },
    { cc: 'MD', n: 'Moldau', h: 'Chisinau', k: 'eu' },
    { cc: 'CY', n: 'Zypern', h: 'Nikosia', k: 'eu' },
    { cc: 'MT', n: 'Malta', h: 'Valletta', k: 'eu' },
    /* --- Amerika --- */
    { cc: 'US', n: 'USA', h: 'Washington, D.C.', k: 'am' },
    { cc: 'CA', n: 'Kanada', h: 'Ottawa', k: 'am' },
    { cc: 'MX', n: 'Mexiko', h: 'Mexiko-Stadt', k: 'am' },
    { cc: 'BR', n: 'Brasilien', h: 'Brasília', k: 'am' },
    { cc: 'AR', n: 'Argentinien', h: 'Buenos Aires', k: 'am' },
    { cc: 'CL', n: 'Chile', h: 'Santiago de Chile', k: 'am' },
    { cc: 'PE', n: 'Peru', h: 'Lima', k: 'am' },
    { cc: 'CO', n: 'Kolumbien', h: 'Bogotá', k: 'am' },
    { cc: 'VE', n: 'Venezuela', h: 'Caracas', k: 'am' },
    { cc: 'EC', n: 'Ecuador', h: 'Quito', k: 'am' },
    { cc: 'BO', n: 'Bolivien', h: 'Sucre', k: 'am', nc: 1 },
    { cc: 'UY', n: 'Uruguay', h: 'Montevideo', k: 'am' },
    { cc: 'PY', n: 'Paraguay', h: 'Asunción', k: 'am' },
    { cc: 'CU', n: 'Kuba', h: 'Havanna', k: 'am' },
    { cc: 'JM', n: 'Jamaika', h: 'Kingston', k: 'am' },
    { cc: 'CR', n: 'Costa Rica', h: 'San José', k: 'am' },
    { cc: 'PA', n: 'Panama', h: 'Panama-Stadt', k: 'am' },
    { cc: 'GT', n: 'Guatemala', h: 'Guatemala-Stadt', k: 'am' },
    { cc: 'DO', n: 'Dominikanische Republik', h: 'Santo Domingo', k: 'am' },
    { cc: 'HT', n: 'Haiti', h: 'Port-au-Prince', k: 'am' },
    /* --- Asien --- */
    { cc: 'CN', n: 'China', h: 'Peking', k: 'as' },
    { cc: 'JP', n: 'Japan', h: 'Tokio', k: 'as' },
    { cc: 'KR', n: 'Südkorea', h: 'Seoul', k: 'as' },
    { cc: 'KP', n: 'Nordkorea', h: 'Pjöngjang', k: 'as' },
    { cc: 'IN', n: 'Indien', h: 'Neu-Delhi', k: 'as' },
    { cc: 'PK', n: 'Pakistan', h: 'Islamabad', k: 'as' },
    { cc: 'BD', n: 'Bangladesch', h: 'Dhaka', k: 'as' },
    { cc: 'TH', n: 'Thailand', h: 'Bangkok', k: 'as' },
    { cc: 'VN', n: 'Vietnam', h: 'Hanoi', k: 'as' },
    { cc: 'PH', n: 'Philippinen', h: 'Manila', k: 'as' },
    { cc: 'ID', n: 'Indonesien', h: 'Jakarta', k: 'as' },
    { cc: 'MY', n: 'Malaysia', h: 'Kuala Lumpur', k: 'as' },
    { cc: 'SG', n: 'Singapur', h: 'Singapur', k: 'as', nc: 1 },
    { cc: 'MM', n: 'Myanmar', h: 'Naypyidaw', k: 'as', nc: 1 },
    { cc: 'KH', n: 'Kambodscha', h: 'Phnom Penh', k: 'as' },
    { cc: 'LA', n: 'Laos', h: 'Vientiane', k: 'as' },
    { cc: 'NP', n: 'Nepal', h: 'Kathmandu', k: 'as' },
    { cc: 'LK', n: 'Sri Lanka', h: 'Colombo', k: 'as', nc: 1 },
    { cc: 'AF', n: 'Afghanistan', h: 'Kabul', k: 'as' },
    { cc: 'IR', n: 'Iran', h: 'Teheran', k: 'as' },
    { cc: 'IQ', n: 'Irak', h: 'Bagdad', k: 'as' },
    { cc: 'SA', n: 'Saudi-Arabien', h: 'Riad', k: 'as' },
    { cc: 'AE', n: 'Vereinigte Arabische Emirate', h: 'Abu Dhabi', k: 'as' },
    { cc: 'QA', n: 'Katar', h: 'Doha', k: 'as' },
    { cc: 'KW', n: 'Kuwait', h: 'Kuwait-Stadt', k: 'as' },
    { cc: 'IL', n: 'Israel', h: 'Jerusalem', k: 'as', nc: 1 },
    { cc: 'JO', n: 'Jordanien', h: 'Amman', k: 'as' },
    { cc: 'LB', n: 'Libanon', h: 'Beirut', k: 'as' },
    { cc: 'SY', n: 'Syrien', h: 'Damaskus', k: 'as' },
    { cc: 'KZ', n: 'Kasachstan', h: 'Astana', k: 'as' },
    { cc: 'UZ', n: 'Usbekistan', h: 'Taschkent', k: 'as' },
    { cc: 'MN', n: 'Mongolei', h: 'Ulaanbaatar', k: 'as' },
    { cc: 'GE', n: 'Georgien', h: 'Tiflis', k: 'as' },
    { cc: 'AM', n: 'Armenien', h: 'Eriwan', k: 'as' },
    { cc: 'AZ', n: 'Aserbaidschan', h: 'Baku', k: 'as' },
    { cc: 'TR', n: 'Türkei', h: 'Ankara', k: 'as' },
    /* --- Afrika --- */
    { cc: 'EG', n: 'Ägypten', h: 'Kairo', k: 'af' },
    { cc: 'MA', n: 'Marokko', h: 'Rabat', k: 'af' },
    { cc: 'DZ', n: 'Algerien', h: 'Algier', k: 'af' },
    { cc: 'TN', n: 'Tunesien', h: 'Tunis', k: 'af' },
    { cc: 'LY', n: 'Libyen', h: 'Tripolis', k: 'af' },
    { cc: 'SN', n: 'Senegal', h: 'Dakar', k: 'af' },
    { cc: 'GH', n: 'Ghana', h: 'Accra', k: 'af' },
    { cc: 'NG', n: 'Nigeria', h: 'Abuja', k: 'af' },
    { cc: 'CI', n: 'Elfenbeinküste', h: 'Yamoussoukro', k: 'af', nc: 1 },
    { cc: 'CM', n: 'Kamerun', h: 'Jaunde', k: 'af' },
    { cc: 'ET', n: 'Äthiopien', h: 'Addis Abeba', k: 'af' },
    { cc: 'KE', n: 'Kenia', h: 'Nairobi', k: 'af' },
    { cc: 'UG', n: 'Uganda', h: 'Kampala', k: 'af' },
    { cc: 'TZ', n: 'Tansania', h: 'Dodoma', k: 'af', nc: 1 },
    { cc: 'ZA', n: 'Südafrika', h: 'Pretoria', k: 'af', nc: 1 },
    { cc: 'ZW', n: 'Simbabwe', h: 'Harare', k: 'af' },
    { cc: 'ZM', n: 'Sambia', h: 'Lusaka', k: 'af' },
    { cc: 'MZ', n: 'Mosambik', h: 'Maputo', k: 'af' },
    { cc: 'AO', n: 'Angola', h: 'Luanda', k: 'af' },
    { cc: 'NA', n: 'Namibia', h: 'Windhuk', k: 'af' },
    { cc: 'BW', n: 'Botsuana', h: 'Gaborone', k: 'af' },
    { cc: 'MG', n: 'Madagaskar', h: 'Antananarivo', k: 'af' },
    { cc: 'SD', n: 'Sudan', h: 'Khartum', k: 'af' },
    { cc: 'RW', n: 'Ruanda', h: 'Kigali', k: 'af' },
    { cc: 'ML', n: 'Mali', h: 'Bamako', k: 'af' },
    /* --- Ozeanien --- */
    { cc: 'AU', n: 'Australien', h: 'Canberra', k: 'oz' },
    { cc: 'NZ', n: 'Neuseeland', h: 'Wellington', k: 'oz' },
    { cc: 'FJ', n: 'Fidschi', h: 'Suva', k: 'oz' },
    { cc: 'PG', n: 'Papua-Neuguinea', h: 'Port Moresby', k: 'oz' }
  ];

  /* Bot-Namen (Solo) und Schwierigkeitsstufen */
  var BOT_NAMES = ['Tukan Tobi', 'Liane Lina', 'Panther Pit', 'Gecko Gustav', 'Papagei Pia', 'Mambo Mia', 'Jaguar Jo'];
  var DIFFS = {
    leicht: { label: '🌱 Leicht', acc: 0.55, tmin: 3200, tmax: 9000 },
    normal: { label: '🔥 Normal', acc: 0.72, tmin: 2000, tmax: 6200 },
    schwer: { label: '💀 Schwer', acc: 0.88, tmin: 900, tmax: 3800 }
  };

  injectStyle();

  /* ===================== Hilfsfunktionen ===================== */

  /* Flaggen-Emoji aus dem ISO-Code: 'DE' -> 🇩🇪 */
  function flagOf(cc) {
    return String.fromCodePoint(0x1F1E6 + cc.charCodeAt(0) - 65, 0x1F1E6 + cc.charCodeAt(1) - 65);
  }

  /* Deterministischer Zufall (LCG) — gleicher Seed = gleiche Fragen für alle */
  function makeRng(seed) {
    var s = (seed >>> 0) || 1;
    return function () { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; };
  }
  function shuffleRng(a, rng) {
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(rng() * (i + 1)), t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  /* Punkte für eine richtige Antwort: 100 + Tempobonus, ab Serie 3 mal 1,5 */
  function pointsFor(msLeft, streakAfter) {
    var speed = Math.round(SPEED_MAX * clamp(msLeft / ANSWER_MS, 0, 1));
    var p = BASE + speed;
    if (streakAfter >= STREAK_AT) p = Math.round(p * STREAK_MULT);
    return p;
  }

  /* Baut die 20 Fragen aus dem Seed — auf jedem Gerät identisch. */
  function buildQuestions(seed) {
    var rng = makeRng(seed), all = [], i;
    for (i = 0; i < C.length; i++) all.push(i);
    shuffleRng(all, rng);
    var subjects = all.slice(0, TOTAL), qs = [];
    for (i = 0; i < TOTAL; i++) {
      var ci = subjects[i], land = C[ci];
      var cap = ((i + 1) % BONUS_EVERY === 0) && !land.nc;
      var others = pickOthers(ci, rng);
      var opts = [{ t: cap ? land.h : land.n, ok: true }];
      for (var j = 0; j < 3; j++) opts.push({ t: cap ? C[others[j]].h : C[others[j]].n, ok: false });
      shuffleRng(opts, rng);
      var correct = 0, texts = [];
      for (j = 0; j < 4; j++) { texts.push(opts[j].t); if (opts[j].ok) correct = j; }
      qs.push({ ci: ci, cap: cap, opts: texts, c: correct });
    }
    return qs;
  }

  /* 3 andere Länder als falsche Antworten — bevorzugt vom selben Kontinent
   * (macht es fairer und kniffliger). Kleine Kontinente werden aufgefüllt. */
  function pickOthers(ci, rng) {
    var mine = C[ci].k, same = [], i;
    for (i = 0; i < C.length; i++) if (i !== ci && C[i].k === mine) same.push(i);
    if (same.length < 6) { for (i = 0; i < C.length; i++) if (i !== ci && C[i].k !== mine) same.push(i); }
    shuffleRng(same, rng);
    return same.slice(0, 3);
  }

  /* ===================== Registrierung ===================== */
  App.Minigames.flagquiz = {
    id: 'flagquiz', title: 'Flaggen-Quiz', icon: '🌍', order: 118,
    subtitle: '20 Flaggen, 10 Sekunden — kennst du die Welt?',
    single: true, multi: true, minPlayers: 2, maxPlayers: 8,

    render: function (root, ctx) {
      var isMulti = ctx.mode === 'multi';
      var room = isMulti ? ctx.room : null;
      var nowFn = isMulti ? function () { return room.now(); } : function () { return Date.now(); };

      /* ---- Laufzeit-Zustand ---- */
      var dead = false, finished = false;
      var stops = [], timers = [];
      var QS = null, seed = 0;
      var cur = null;                 // Solo-Fahrplan { i, startAt }
      var lastShared = null;          // Multi: zuletzt empfangenes shared
      var answers = [];               // je Frage { pick, ok, pts }
      var score = 0, streak = 0, correctCount = 0;
      var soloAdvanceAt = 0, lastAdvanced = -1;
      var bots = [], diff = null, best = 0;
      var refs = null, board = null, view = '';
      var lastQi = -1, lastBoardSig = '';

      function after(ms, fn) { var t = setTimeout(function () { if (!dead) fn(); }, ms); timers.push(t); return t; }
      function stopAll() {
        stops.forEach(function (f) { try { f(); } catch (e) {} }); stops = [];
        timers.forEach(clearTimeout); timers = [];
      }
      function cleanup() { dead = true; stopAll(); }

      if (isMulti) startMulti(); else showStart();
      return { cleanup: cleanup };

      /* ===================== Start ===================== */

      /* SOLO: Startbildschirm mit Rekord + Schwierigkeitswahl */
      function showStart() {
        stopAll();
        view = 'start'; finished = false;
        best = App.Storage.get('best_flagquiz', 0);
        var demo = [];
        for (var i = 0; i < 5; i++) demo.push(flagOf(C[Math.floor(Math.random() * C.length)].cc));
        var btns = ['leicht', 'normal', 'schwer'].map(function (key) {
          var cls = key === 'leicht' ? 'btn btn-aqua' : (key === 'schwer' ? 'btn btn-danger' : 'btn btn-primary');
          return el('button', {
            class: cls, type: 'button',
            onclick: function () { if (App.Audio) App.Audio.sfx('select'); startSolo(key); }
          }, [DIFFS[key].label]);
        });
        root.innerHTML = '';
        root.appendChild(el('div', { class: 'flq-start glass' }, [
          el('div', { class: 'flq-start-flags' }, [demo.join(' ')]),
          el('h2', { class: 'neon' }, ['🌍 Flaggen-Quiz']),
          el('p', { class: 'hint-text' }, ['20 Flaggen · 10 Sekunden pro Frage · schneller antworten = mehr Punkte. Jede 4. Frage ist eine ⭐ Bonusfrage nach der Hauptstadt.']),
          el('div', { class: 'flq-best' }, ['🏆 Dein Rekord: ' + App.MG.fmt(best) + ' Punkte']),
          el('div', { class: 'mg-field-title' }, ['Gegner wählen']),
          el('div', { class: 'controls-row' }, btns),
          el('p', { class: 'hint-text' }, ['Drei Bots spielen mit — und dein 👻 Rekord-Geist läuft in der Rangliste mit.'])
        ]));
      }

      function startSolo(key) {
        stopAll();
        diff = DIFFS[key];
        seed = Math.floor(Math.random() * 1000000000) + 1;
        QS = buildQuestions(seed);
        bots = makeBots(diff);
        play(Date.now());
      }

      /* MULTI: Seed + Fahrplan vom Host, dann synchroner Countdown */
      function startMulti() {
        var onShared = function (sh) { if (!dead) lastShared = sh || null; };
        room.on('shared', onShared);
        stops.push(function () { room.off('shared', onShared); });
        var snap = room.snapshot() || {};
        lastShared = snap.shared || null;

        var startAt = (snap.round && snap.round.startAt) || (room.now() + 3000);
        if (room.isHost() && !(lastShared && lastShared.flqSeed)) {
          room.setShared({
            flqSeed: Math.floor(Math.random() * 1000000000) + 1,
            flqCur: { i: 0, startAt: startAt }
          });
        }
        room.reportScore(0);
        room.reportState({ q: -1 });
        stops.push(App.MG.countdown(root, startAt, function () { play(startAt); }, room.now));
      }

      /* ===================== Spiel ===================== */
      function play(startAt) {
        stopAll();
        answers = []; score = 0; streak = 0; correctCount = 0;
        soloAdvanceAt = 0; lastAdvanced = -1; lastQi = -1; lastBoardSig = '';
        finished = false;
        best = App.Storage.get('best_flagquiz', 0);
        if (!isMulti) cur = { i: 0, startAt: startAt };

        buildUI();

        /* Multi: Rangliste hängt sich selbst an die 'players'-Updates */
        if (isMulti) {
          board = App.MG.liveBoard(room, ctx.me.id);
          stops.push(board.stop);
          refs.boardBox.appendChild(board.root);
        } else {
          refs.boardBox.appendChild(refs.soloBoard);
          renderSoloBoard();
        }

        /* Tasten 1–4 */
        var onKey = function (e) {
          var n = -1;
          if (e.key === '1' || e.code === 'Digit1') n = 0;
          else if (e.key === '2' || e.code === 'Digit2') n = 1;
          else if (e.key === '3' || e.code === 'Digit3') n = 2;
          else if (e.key === '4' || e.code === 'Digit4') n = 3;
          if (n < 0) return;
          e.preventDefault();
          answer(n);
        };
        document.addEventListener('keydown', onKey);
        stops.push(function () { document.removeEventListener('keydown', onKey); });

        var t = setInterval(tick, 100);
        stops.push(function () { clearInterval(t); });
        tick();
      }

      /* ---- DOM einmalig aufbauen, danach nur noch in-place aktualisieren ---- */
      function buildUI() {
        refs = {};
        refs.qNum = el('div', { class: 'flq-hv' }, ['1 / ' + TOTAL]);
        refs.score = el('div', { class: 'flq-hv flq-hv-score' }, ['0']);
        refs.timer = el('div', { class: 'mg-timer flq-hv-timer' }, ['10']);
        var head = el('div', { class: 'flq-head glass' }, [
          el('div', { class: 'flq-hc' }, [el('span', { class: 'flq-hl' }, ['Frage']), refs.qNum]),
          el('div', { class: 'flq-hc flq-hc-mid' }, [el('span', { class: 'flq-hl' }, ['Punkte']), refs.score]),
          el('div', { class: 'flq-hc flq-hc-end' }, [el('span', { class: 'flq-hl' }, ['Zeit']), refs.timer])
        ]);

        refs.dots = el('div', { class: 'flq-dots' });
        refs.dot = [];
        for (var i = 0; i < TOTAL; i++) { var d = el('div', { class: 'flq-dot' }); refs.dot.push(d); refs.dots.appendChild(d); }

        refs.badge = el('div', { class: 'flq-badge' }, ['⭐ Bonus · Hauptstadt']);
        refs.flag = el('div', { class: 'flq-flag' }, ['🏳️']);
        refs.qText = el('div', { class: 'flq-q' }, ['Welches Land gehört zu dieser Flagge?']);
        refs.fill = el('div', { class: 'flq-timefill' });
        var stage = el('div', { class: 'flq-stage glass' }, [
          refs.badge, refs.flag, refs.qText,
          el('div', { class: 'flq-timebar' }, [refs.fill])
        ]);

        refs.ansWrap = el('div', { class: 'flq-answers' });
        refs.ans = []; refs.ansTxt = [];
        for (i = 0; i < 4; i++) {
          (function (idx) {
            var txt = el('span', { class: 'flq-ans-t' }, ['']);
            var b = el('button', { class: 'flq-ans', type: 'button', onclick: function () { answer(idx); } }, [
              el('span', { class: 'flq-ans-k' }, [String(idx + 1)]), txt
            ]);
            refs.ans.push(b); refs.ansTxt.push(txt); refs.ansWrap.appendChild(b);
          })(i);
        }

        refs.streak = el('span', { class: 'chip flq-chip flq-chip-off' }, ['🔥 Serie 0']);
        refs.meta = el('div', { class: 'flq-meta' }, [refs.streak]);
        refs.fb = el('div', { class: 'flq-fb' }, ['']);

        refs.soloBoard = el('div', { class: 'mg-scoreboard' });
        refs.boardBox = el('div', { class: 'flq-board-box' });
        refs.boardWrap = el('div', { class: 'flq-board-wrap glass' }, [
          el('div', { class: 'mg-field-title' }, ['🏆 Zwischenstand']), refs.boardBox
        ]);

        root.innerHTML = '';
        root.appendChild(el('div', { class: 'flq-wrap' }, [
          head, refs.dots, stage, refs.ansWrap, refs.meta, refs.fb, refs.boardWrap,
          el('p', { class: 'hint-text flq-rules' }, ['Antwort antippen oder Taste 1–4 · schneller = mehr Punkte · ab 3 richtigen in Folge ×1,5'])
        ]));
        view = 'game';
      }

      /* ===================== Takt (Logik + Zeichnen) ===================== */
      function tick() {
        if (dead || finished || view !== 'game') return;
        var now = nowFn();

        /* Fragen erst bauen, wenn der Seed da ist (Multi: kommt vom Host) */
        if (!QS) {
          var s = lastShared && lastShared.flqSeed;
          if (!s) { waitText('Warte auf die Fragen vom Host …'); return; }
          seed = s; QS = buildQuestions(seed);
        }
        var c = getCur();
        if (!c) { waitText('Warte auf den Start …'); return; }

        /* Ende: Host hat über die letzte Frage hinaus geschaltet */
        if (c.i >= TOTAL && now >= c.startAt) { finish(); return; }

        var inGap = now < c.startAt;
        var winOver = !inGap && now >= c.startAt + ANSWER_MS;

        /* Nicht geantwortet -> Frage verfällt (genau einmal) */
        if (winOver && c.i < TOTAL && !answers[c.i]) {
          answers[c.i] = { pick: -1, ok: false, pts: 0 };
          streak = 0;
          if (App.Audio) App.Audio.sfx('lose');
          if (isMulti) room.reportState({ q: c.i });
        }

        /* Weiterschalten */
        if (!inGap) {
          if (isMulti) { if (room.isHost()) hostAdvance(now, c); }
          else if (c.i < TOTAL) {
            if (winOver || (soloAdvanceAt && now >= soloAdvanceAt)) advanceSolo(now, c);
          }
        }
        paint(now, getCur());
      }

      function getCur() {
        if (!isMulti) return cur;
        var sh = lastShared;
        return (sh && sh.flqCur && typeof sh.flqCur.i === 'number') ? sh.flqCur : null;
      }

      /* Host: weiter, wenn die Zeit um ist ODER alle geantwortet haben */
      function hostAdvance(now, c) {
        if (c.i >= TOTAL || lastAdvanced === c.i) return;
        var winOver = now >= c.startAt + ANSWER_MS;
        if (!winOver && !allAnswered(c.i)) return;
        lastAdvanced = c.i;
        room.setShared({ flqCur: { i: c.i + 1, startAt: now + GAP } });
      }
      function allAnswered(i) {
        var ps = room.players();
        if (!ps.length) return false;
        for (var k = 0; k < ps.length; k++) if (!ps[k].state || ps[k].state.q !== i) return false;
        return true;
      }
      function answeredCount(i) {
        var ps = room.players(), n = 0;
        for (var k = 0; k < ps.length; k++) if (ps[k].state && ps[k].state.q === i) n++;
        return n;
      }

      function advanceSolo(now, c) {
        resolveBots(c.i);
        soloAdvanceAt = 0;
        cur = { i: c.i + 1, startAt: now + GAP };
        renderSoloBoard();
      }

      /* ===================== Antworten ===================== */
      function answer(pick) {
        if (dead || finished || !QS || view !== 'game') return;
        var c = getCur();
        if (!c || c.i < 0 || c.i >= TOTAL) return;
        var now = nowFn();
        if (now < c.startAt || now >= c.startAt + ANSWER_MS) return;  // außerhalb des Fensters
        if (answers[c.i]) return;                                     // schon geantwortet

        var q = QS[c.i], ok = pick === q.c;
        var left = (c.startAt + ANSWER_MS) - now, pts = 0;
        if (ok) {
          streak++; correctCount++;
          pts = pointsFor(left, streak);
          score += pts;
        } else {
          streak = 0;
        }
        answers[c.i] = { pick: pick, ok: ok, pts: pts };
        if (App.Audio) {
          App.Audio.sfx(ok ? 'point' : 'error');
          if (ok && streak >= STREAK_AT) App.Audio.blip(920, 0.12);
        }
        if (isMulti) { room.reportScore(score); room.reportState({ q: c.i }); }
        else { soloAdvanceAt = now + 550; }
        paint(now, c);
      }

      /* ===================== Zeichnen ===================== */
      function waitText(msg) {
        if (!refs) return;
        setText(refs.qText, msg);
        setText(refs.fb, '');
        refs.ansWrap.classList.remove('live');
        for (var i = 0; i < 4; i++) { refs.ans[i].className = 'flq-ans dim'; setText(refs.ansTxt[i], '…'); }
      }

      function paint(now, c) {
        if (!refs || !QS || !c) return;
        var inGap = now < c.startAt;
        var qi = inGap ? c.i - 1 : c.i;
        var phase;                                   // 'wait' | 'q' | 'locked' | 'reveal' | 'board'
        if (qi < 0) { qi = 0; phase = 'wait'; }
        else if (qi >= TOTAL) { qi = TOTAL - 1; phase = 'board'; }
        else if (inGap) phase = (c.startAt - now) <= BOARD_MS ? 'board' : 'reveal';
        else if (now < c.startAt + ANSWER_MS) phase = answers[qi] ? 'locked' : 'q';
        else phase = 'reveal';

        var q = QS[qi], a = answers[qi], shown = phase === 'reveal' || phase === 'board';

        /* Kopfzeile */
        setText(refs.qNum, (qi + 1) + ' / ' + TOTAL);
        setText(refs.score, App.MG.fmt(score));

        /* Timer + Balken */
        var pct, secs;
        if (inGap || phase === 'wait') {
          secs = Math.max(0, Math.ceil((c.startAt - now) / 1000));
          pct = clamp((c.startAt - now) / (phase === 'wait' ? Math.max(1, c.startAt - now) : GAP), 0, 1) * 100;
          setText(refs.timer, String(secs));
          setFill(refs.fill, pct, 'gap');
          refs.timer.classList.remove('flq-urgent');
        } else {
          var left = (c.startAt + ANSWER_MS) - now;
          secs = Math.max(0, Math.ceil(left / 1000));
          pct = clamp(left / ANSWER_MS, 0, 1) * 100;
          setText(refs.timer, String(secs));
          setFill(refs.fill, pct, pct > 55 ? '' : (pct > 25 ? 'warn' : 'hot'));
          refs.timer.classList.toggle('flq-urgent', secs <= 3 && phase === 'q');
        }

        /* Bühne */
        if (qi !== lastQi) {
          lastQi = qi;
          refs.flag.textContent = flagOf(C[q.ci].cc);
          refs.flag.classList.remove('flq-in'); void refs.flag.offsetWidth; refs.flag.classList.add('flq-in');
          for (var j = 0; j < 4; j++) setText(refs.ansTxt[j], q.opts[j]);
        }
        refs.badge.classList.toggle('on', !!q.cap);
        setText(refs.qText, q.cap
          ? ('⭐ Wie heißt die Hauptstadt von ' + C[q.ci].n + '?')
          : 'Zu welchem Land gehört diese Flagge?');

        /* Antwort-Buttons */
        refs.ansWrap.classList.toggle('live', phase === 'q');
        for (var i = 0; i < 4; i++) {
          var cls = 'flq-ans';
          if (shown) {
            if (i === q.c) cls += ' ok';
            else if (a && a.pick === i) cls += ' wrong';
            else cls += ' dim';
          } else if (phase === 'locked') {
            cls += (a && a.pick === i) ? ' picked' : ' dim';
          } else if (phase === 'wait') {
            cls += ' dim';
          }
          if (refs.ans[i].className !== cls) refs.ans[i].className = cls;
        }

        /* Serien-Chip */
        setText(refs.streak, streak >= STREAK_AT ? ('🔥 Serie ' + streak + ' · ×1,5') : ('🔥 Serie ' + streak));
        refs.streak.className = 'chip flq-chip' + (streak >= STREAK_AT ? ' flq-chip-hot' : (streak > 0 ? '' : ' flq-chip-off'));

        /* Rückmeldung */
        var fb = '', fbc = 'info';
        if (phase === 'wait') { fb = 'Gleich geht\'s los …'; fbc = 'wait'; }
        else if (phase === 'q') {
          if (isMulti) { fb = answeredCount(qi) + ' / ' + room.players().length + ' haben geantwortet'; fbc = 'wait'; }
          else { fb = 'Tippe die richtige Antwort — je schneller, desto mehr Punkte'; fbc = 'wait'; }
        } else if (phase === 'locked') {
          fb = isMulti ? 'Abgeschickt — warte auf die anderen …' : 'Abgeschickt!';
          fbc = 'info';
        } else if (a && a.ok) {
          fb = '✅ Richtig! +' + a.pts + ' Punkte'; fbc = 'good';
        } else if (a && a.pick >= 0) {
          fb = '❌ Falsch — richtig: ' + q.opts[q.c]; fbc = 'bad';
        } else {
          fb = '⏰ Zeit um — richtig: ' + q.opts[q.c]; fbc = 'bad';
        }
        setText(refs.fb, fb);
        var fbCls = 'flq-fb ' + fbc;
        if (refs.fb.className !== fbCls) refs.fb.className = fbCls;

        /* Punkte-Punkte-Leiste */
        for (i = 0; i < TOTAL; i++) {
          var dc = 'flq-dot';
          if (answers[i]) dc += answers[i].ok ? ' ok' : ' bad';
          else if (i === c.i && !inGap) dc += ' now';
          if (refs.dot[i].className !== dc) refs.dot[i].className = dc;
        }

        /* Rangliste nur zwischen den Fragen */
        refs.boardWrap.classList.toggle('on', phase === 'board');
      }

      function setText(node, txt) { if (node && node.textContent !== txt) node.textContent = txt; }
      function setFill(node, pct, cls) {
        var w = pct.toFixed(1) + '%';
        if (node.style.width !== w) node.style.width = w;
        var c2 = 'flq-timefill' + (cls ? ' ' + cls : '');
        if (node.className !== c2) node.className = c2;
      }

      /* ===================== Solo: Bots + Rangliste ===================== */
      function makeBots(d) {
        var names = BOT_NAMES.slice();
        shuffleRng(names, Math.random);
        var out = [];
        for (var i = 0; i < 3; i++) {
          var jitter = (Math.random() - 0.5) * 0.12;         // jeder Bot ein bisschen anders
          var speed = 0.8 + Math.random() * 0.45;
          out.push({
            name: '🤖 ' + names[i],
            acc: clamp(d.acc + jitter, 0.25, 0.96),
            tmin: d.tmin * speed, tmax: d.tmax * speed,
            score: 0, streak: 0
          });
        }
        return out;
      }

      /* Bots beantworten die Frage mit eigener Zeit + Trefferquote.
       * Bonusfragen (Hauptstadt) sind auch für sie schwerer. */
      function resolveBots(qi) {
        if (!QS || !QS[qi]) return;
        var cap = QS[qi].cap;
        bots.forEach(function (b) {
          var t = b.tmin + Math.random() * Math.max(1, b.tmax - b.tmin);
          if (t >= ANSWER_MS) { b.streak = 0; return; }        // zu langsam -> nichts
          var acc = clamp(b.acc - (cap ? 0.15 : 0), 0.1, 0.98);
          if (Math.random() < acc) {
            b.streak++;
            b.score += pointsFor(ANSWER_MS - t, b.streak);
          } else {
            b.streak = 0;
          }
        });
      }

      function ghostScore() {
        var c = getCur();
        if (!best || !c) return 0;
        var done = clamp(c.i, 0, TOTAL);
        return Math.round(best * done / TOTAL);
      }

      function renderSoloBoard() {
        if (!refs || isMulti) return;
        var rows = [{ name: (ctx.me && ctx.me.name ? ctx.me.name : 'Du') + ' (du)', score: score, me: true }];
        bots.forEach(function (b) { rows.push({ name: b.name, score: b.score }); });
        if (best > 0) rows.push({ name: '👻 Rekord-Geist', score: ghostScore(), ghost: true });
        rows.sort(function (x, y) { return y.score - x.score; });
        var sig = rows.map(function (r) { return r.name + r.score; }).join('|');
        if (sig === lastBoardSig) return;
        lastBoardSig = sig;
        refs.soloBoard.innerHTML = '';
        rows.forEach(function (r, i) {
          refs.soloBoard.appendChild(el('div', {
            class: 'mg-sb-row p' + (i + 1) + (r.me ? ' me' : '') + (r.ghost ? ' flq-ghost-row' : '')
          }, [
            el('span', { class: 'mg-sb-rank' }, ['' + (i + 1)]),
            el('span', { class: 'mg-sb-name' }, [r.name]),
            el('span', { class: 'mg-sb-score' }, [App.MG.fmt(r.score)])
          ]));
        });
      }

      /* ===================== Ende ===================== */
      function finish() {
        if (finished || dead) return;
        finished = true;
        stopAll();
        view = 'end';

        if (isMulti) {
          room.reportScore(score);
          var ps = room.players().slice().sort(function (a, b) { return (b.score || 0) - (a.score || 0); });
          if (App.Audio) App.Audio.sfx(ps[0] && ps[0].id === ctx.me.id ? 'win' : 'info');
          App.MG.endScreen(root, { players: room.players(), meId: ctx.me.id, onExit: ctx.onExit });
        } else {
          var b = App.Storage.get('best_flagquiz', 0);
          var nb = score > b;
          if (nb) App.Storage.set('best_flagquiz', score);
          var better = 0;
          bots.forEach(function (bot) { if (bot.score > score) better++; });
          if (App.Audio) App.Audio.sfx(better === 0 ? 'win' : 'info');
          App.MG.endScreen(root, {
            score: score, best: b, newBest: nb,
            label: correctCount + ' von ' + TOTAL + ' richtig · Platz ' + (better + 1) + ' von ' + (bots.length + 1)
              + ' · ' + (nb ? 'neuer Rekord! 🎉' : 'Bestwert: ' + App.MG.fmt(b)),
            onExit: ctx.onExit,
            onAgain: function () { showStart(); }
          });
        }
      }
    }
  };

  /* ===================== CSS ===================== */
  function injectStyle() {
    UI.injectStyle('mg-flagquiz-css', [
      '.flq-wrap{display:flex;flex-direction:column;gap:11px;max-width:560px;margin:0 auto;}',
      /* Kopfzeile */
      '.flq-head{display:flex;justify-content:space-between;align-items:center;padding:10px 16px;gap:10px;}',
      '.flq-hc{display:flex;flex-direction:column;gap:2px;min-width:0;}',
      '.flq-hc-mid{text-align:center;}',
      '.flq-hc-end{text-align:right;}',
      '.flq-hl{color:var(--muted);font-size:10px;text-transform:uppercase;letter-spacing:1px;font-weight:800;}',
      '.flq-hv{font-size:clamp(17px,4.4vw,22px);font-weight:900;line-height:1;color:var(--leaf);font-variant-numeric:tabular-nums;}',
      '.flq-hv-score{color:var(--gold);text-shadow:0 0 12px rgba(255,210,63,.45);font-size:clamp(21px,5.2vw,29px);}',
      '.mg-timer.flq-hv-timer{font-size:clamp(19px,4.8vw,26px);}',
      '.mg-timer.flq-urgent{color:var(--danger);animation:flq-pulse .6s infinite;}',
      /* Fortschritt (eine Marke je Frage) */
      '.flq-dots{display:flex;gap:3px;}',
      '.flq-dot{flex:1;height:5px;border-radius:3px;background:rgba(255,255,255,.09);transition:background .25s,box-shadow .25s;}',
      '.flq-dot.ok{background:var(--neon);box-shadow:0 0 8px rgba(57,255,20,.55);}',
      '.flq-dot.bad{background:var(--danger);box-shadow:0 0 8px rgba(255,77,109,.45);}',
      '.flq-dot.now{background:var(--aqua);box-shadow:0 0 10px rgba(51,230,208,.7);animation:flq-pulse 1s infinite;}',
      /* Bühne mit Flagge */
      '.flq-stage{position:relative;padding:16px 14px 12px;display:flex;flex-direction:column;align-items:center;gap:8px;overflow:hidden;}',
      '.flq-stage::before{content:"";position:absolute;inset:0;background:radial-gradient(circle at 50% 26%,rgba(57,255,20,.10),transparent 62%);pointer-events:none;}',
      '.flq-badge{position:absolute;top:9px;left:9px;z-index:2;font-size:9px;font-weight:900;letter-spacing:1px;text-transform:uppercase;color:var(--gold);border:1px solid rgba(255,210,63,.45);background:rgba(255,210,63,.1);padding:3px 8px;border-radius:999px;opacity:0;transition:opacity .25s;}',
      '.flq-badge.on{opacity:1;}',
      '.flq-flag{position:relative;font-size:clamp(66px,20vw,116px);line-height:1.2;user-select:none;-webkit-user-select:none;filter:drop-shadow(0 8px 20px rgba(0,0,0,.55));}',
      '.flq-flag.flq-in{animation:flq-flagin .45s cubic-bezier(.2,.8,.3,1);}',
      '.flq-q{position:relative;font-size:clamp(14px,3.7vw,19px);font-weight:800;text-align:center;line-height:1.25;min-height:2.4em;display:flex;align-items:center;justify-content:center;color:var(--text);}',
      '.flq-timebar{position:relative;width:100%;height:9px;border-radius:6px;background:rgba(0,0,0,.45);border:1px solid var(--stroke);overflow:hidden;}',
      '.flq-timefill{height:100%;width:100%;border-radius:5px;background:linear-gradient(90deg,var(--leaf),var(--neon));transition:width .1s linear,background .35s;}',
      '.flq-timefill.warn{background:linear-gradient(90deg,#c99a12,var(--gold));}',
      '.flq-timefill.hot{background:linear-gradient(90deg,#b3122f,var(--danger));}',
      '.flq-timefill.gap{background:linear-gradient(90deg,var(--aqua-soft),var(--aqua));}',
      /* Antworten */
      '.flq-answers{display:grid;grid-template-columns:repeat(2,1fr);gap:9px;}',
      '@media (max-width:400px){.flq-answers{grid-template-columns:1fr;}}',
      '.flq-ans{display:flex;align-items:center;gap:9px;padding:11px 12px;min-height:52px;border-radius:14px;',
      'background:rgba(6,24,16,.75);border:2px solid var(--stroke);color:var(--text);font-family:inherit;',
      'font-size:clamp(13px,3.3vw,16px);font-weight:800;text-align:left;cursor:default;touch-action:manipulation;',
      '-webkit-tap-highlight-color:transparent;transition:transform .1s,border-color .2s,box-shadow .2s,background .2s,opacity .25s;}',
      '.flq-ans-k{flex:none;width:22px;height:22px;border-radius:7px;background:rgba(255,255,255,.08);border:1px solid var(--stroke);display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:900;color:var(--muted);transition:.2s;}',
      '.flq-ans-t{flex:1;min-width:0;line-height:1.2;}',
      '.flq-answers.live .flq-ans{cursor:pointer;}',
      '.flq-answers.live .flq-ans:hover{border-color:var(--neon);box-shadow:inset 0 0 22px rgba(57,255,20,.16);transform:translateY(-2px);}',
      '.flq-answers.live .flq-ans:active{transform:scale(.97);}',
      '.flq-ans.picked{border-color:var(--aqua);box-shadow:0 0 0 1px var(--aqua),0 0 18px rgba(51,230,208,.28);}',
      '.flq-ans.picked .flq-ans-k{background:var(--aqua);border-color:var(--aqua);color:#04160c;}',
      '.flq-ans.ok{border-color:var(--neon);background:rgba(57,255,20,.16);box-shadow:0 0 24px rgba(57,255,20,.45);animation:flq-okpop .38s ease;}',
      '.flq-ans.ok .flq-ans-k{background:var(--neon);border-color:var(--neon);color:#04160c;}',
      '.flq-ans.wrong{border-color:var(--danger);background:rgba(255,77,109,.14);animation:flq-shake .32s ease;}',
      '.flq-ans.wrong .flq-ans-k{background:var(--danger);border-color:var(--danger);color:#2a0510;}',
      '.flq-ans.dim{opacity:.4;}',
      /* Serien-Chip + Rückmeldung */
      '.flq-meta{display:flex;justify-content:center;gap:8px;flex-wrap:wrap;}',
      '.flq-chip{font-weight:900;transition:.2s;}',
      '.flq-chip-off{opacity:.5;}',
      '.flq-chip-hot{color:var(--gold);border-color:rgba(255,210,63,.55);box-shadow:0 0 16px rgba(255,210,63,.3);animation:flq-glow 1.1s ease-in-out infinite;}',
      '.flq-fb{text-align:center;font-weight:900;font-size:clamp(13px,3.5vw,17px);min-height:22px;line-height:1.3;transition:color .2s;}',
      '.flq-fb.good{color:var(--neon);text-shadow:0 0 12px rgba(57,255,20,.45);}',
      '.flq-fb.bad{color:var(--danger);}',
      '.flq-fb.info{color:var(--aqua);}',
      '.flq-fb.wait{color:var(--muted);}',
      /* Zwischenstand */
      '.flq-board-wrap{display:none;}',
      '.flq-board-wrap.on{display:flex;flex-direction:column;gap:8px;padding:12px 14px;animation:flq-slide .3s cubic-bezier(.2,.8,.3,1);}',
      '.flq-board-wrap .mg-scoreboard{max-height:240px;overflow-y:auto;}',
      '.flq-ghost-row .mg-sb-name{color:var(--silver);opacity:.9;}',
      '.flq-rules{text-align:center;margin:0;}',
      /* Startbildschirm (Solo) */
      '.flq-start{padding:26px 22px;text-align:center;display:flex;flex-direction:column;gap:12px;align-items:center;max-width:470px;margin:0 auto;}',
      '.flq-start-flags{font-size:clamp(26px,8vw,38px);letter-spacing:3px;animation:flq-wave 3s ease-in-out infinite;filter:drop-shadow(0 6px 14px rgba(0,0,0,.5));}',
      '.flq-best{font-weight:900;font-size:clamp(15px,4vw,19px);color:var(--gold);text-shadow:0 0 14px rgba(255,210,63,.35);}',
      /* Animationen */
      '@keyframes flq-flagin{0%{transform:scale(.62) rotate(-7deg);opacity:0;}70%{transform:scale(1.08) rotate(2deg);opacity:1;}100%{transform:scale(1) rotate(0);opacity:1;}}',
      '@keyframes flq-okpop{0%{transform:scale(1);}45%{transform:scale(1.045);}100%{transform:scale(1);}}',
      '@keyframes flq-shake{0%,100%{transform:translateX(0);}25%{transform:translateX(-6px);}75%{transform:translateX(6px);}}',
      '@keyframes flq-pulse{0%,100%{opacity:1;}50%{opacity:.45;}}',
      '@keyframes flq-slide{from{opacity:0;transform:translateY(10px);}to{opacity:1;transform:none;}}',
      '@keyframes flq-wave{0%,100%{transform:translateY(0);}50%{transform:translateY(-6px);}}',
      '@keyframes flq-glow{0%,100%{box-shadow:0 0 12px rgba(255,210,63,.25);}50%{box-shadow:0 0 22px rgba(255,210,63,.55);}}'
    ].join(''));
  }
})();
