/* minerace.js — "Minen-Rennen": Minesweeper als Wettrennen im Neon-Dschungel.
 *
 * SPIELIDEE
 *   Alle bekommen dasselbe 12x12-Feld mit 24 Minen und graben gleichzeitig um die
 *   Wette. Wer zuerst alle 120 sicheren Felder freilegt, holt sich den Bonus.
 *
 * STEUERUNG
 *   Klick / Tipp        -> Feld aufdecken (leere Felder öffnen per Flood-Fill die Umgebung)
 *   Rechtsklick         -> Flagge setzen / entfernen
 *   Langer Fingerdruck  -> Flagge setzen / entfernen (mobil)
 *   🚩-Schalter          -> Flaggen-Modus: jeder Tipp setzt eine Flagge
 *   Das mit 🌱 markierte Startfeld ist garantiert frei — ebenso der allererste
 *   Klick jedes Spielers (Anfänger-Schutz, kostet keine Sperre).
 *
 * PUNKTE
 *   20 pro sicher aufgedecktem Feld (max. 120 * 20 = 2400)
 *   +500 Bonus für den ersten Spieler, der komplett fertig ist
 *   💥 Mine getroffen -> 15 s gesperrt (Countdown über dem Feld), das Feld gilt ab
 *      dann als bekannte Mine. Der Fortschritt bleibt erhalten.
 *   Nach 4 Minuten (bzw. 20 s Endspurt nach dem ersten Fertigen) zählt der Fortschritt.
 *
 * SYNC-MODELL
 *   Kein Host-Server nötig: das Feld wird deterministisch aus einem gemeinsamen Seed
 *   erzeugt (eigener mulberry32 im File). Seed = room.snapshot().round.startAt — das
 *   ist bei allen Clients identisch. Fehlt round.startAt, legt der Host Seed + Startzeit
 *   per room.setShared({mrc:{...}}) fest und alle warten darauf.
 *   Jeder rechnet sein eigenes Brett lokal und meldet nur seine Punkte via reportScore()
 *   -> die Live-Rangliste rechnet daraus den Prozent-Fortschritt. Der erste Fertige
 *   trägt sich in shared.mrc ein (winId/winAt); erst das Echo vergibt den Bonus, damit
 *   bei gleichzeitigem Eintrag nur einer den Bonus bekommt.
 *
 * SOLO
 *   Zeitjagd gegen den eigenen Rekord — plus 3 Bots (Leicht/Mittel/Schwer) als
 *   Tempomacher. Die Bot-KI ist ein echter Minesweeper-Löser (Deduktion + Flaggen,
 *   bei Sackgassen Wahrscheinlichkeits-Rateschritt) mit Fehlerquote je Stufe.
 *
 * Alle Timer laufen über Wall-Clock (Date.now bzw. room.now) -> Tab-Wechsel-sicher.
 * cleanup() beendet Intervalle, Timeouts, Listener und meldet alle room.on() ab. */
(function () {
  'use strict';
  window.App = window.App || {}; App.Minigames = App.Minigames || {};
  var UI = App.UI, el = UI.el;

  injectStyle();

  /* ===================== Konstanten ===================== */
  var COLS = 12, ROWS = 12, CELLS = COLS * ROWS;   // 144 Felder
  var MINES = 24, SAFE = CELLS - MINES;            // 120 sichere Felder
  var PER_CELL = 20, FINISH_BONUS = 500;           // max. 120 * 20 = 2400 (+500 Bonus)
  var ROUND_SEC = 240;                             // 4 Minuten
  var LOCK_MS = 15000;                             // Sperre nach Minentreffer
  var ENDSPURT_MS = 20000;                         // Restzeit, sobald einer fertig ist
  var LONGPRESS_MS = 450, MOVE_TOL = 12;           // langer Druck / Wackel-Toleranz
  var REPORT_MS = 250;                             // Drossel für reportScore

  /* Nachbar-Tabelle einmalig vorberechnen */
  var NEI = (function () {
    var t = [], i, x, y, dx, dy, nx, ny, a;
    for (i = 0; i < CELLS; i++) {
      x = i % COLS; y = (i / COLS) | 0; a = [];
      for (dy = -1; dy <= 1; dy++) {
        for (dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          nx = x + dx; ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= COLS || ny >= ROWS) continue;
          a.push(ny * COLS + nx);
        }
      }
      t.push(a);
    }
    return t;
  })();

  /* Schwierigkeitsstufen der Solo-Bots: ms pro Aktion + Fehlerquote (ignoriert die
   * eigene Deduktion und rät blind) + ob beim Raten Wahrscheinlichkeiten zählen.
   * Die Werte sind ausgemessen (Simulation über 60 Felder): ein Bot braucht rund
   * 48 Aktionen fürs ganze Feld, dazu 15 s je Minentreffer. Damit räumt "Leicht"
   * das Feld in ~144 s, "Mittel" in ~102 s, "Schwer" in ~67 s — alle drei also im
   * menschlichen Bereich statt unschlagbar schnell. */
  var DIFFS = {
    easy: { key: 'easy', label: 'Leicht', icon: '🌱', ms: 2000, err: 0.26, smart: false, hint: 'Gemütliche Buddler, raten viel' },
    mid: { key: 'mid', label: 'Mittel', icon: '⛏️', ms: 1500, err: 0.12, smart: true, hint: 'Solide Gräber mit Verstand' },
    hard: { key: 'hard', label: 'Schwer', icon: '🔥', ms: 1050, err: 0.04, smart: true, hint: 'Profis — hier musst du fliegen' }
  };
  /* Drei Charaktere: Tempo-Faktor + Fehler-Faktor, damit die Bots nicht wie
   * Klone wirken und das Rennen jedes Mal anders ausgeht. */
  var BOT_CHARS = [
    { name: 'Buddel-Bot 🤖', pace: 1.00, slip: 1.00 },
    { name: 'Späh-Sepp 🔎', pace: 1.18, slip: 0.65 },   // langsam, aber vorsichtig
    { name: 'Dynamit-Dana 🧨', pace: 0.85, slip: 1.45 }  // schnell, aber übermütig
  ];

  /* ===================== Seeded Zufall (mulberry32) ===================== */
  function makeRng(seed) {
    var s = seed >>> 0;
    return function () {
      s = (s + 0x6D2B79F5) >>> 0;
      var t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  /* Große ms-Zahl -> stabiler 32-Bit-Seed */
  function hashSeed(v) {
    var s = String(v), h = 2166136261, i;
    for (i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }

  /* Feld deterministisch bauen. Das Startfeld (und seine 8 Nachbarn) bleibt minenfrei,
   * damit es garantiert eine 0 ist und sich beim ersten Klick eine Fläche öffnet. */
  function buildField(seed) {
    var rnd = makeRng(hashSeed(seed));
    var sx = 2 + Math.floor(rnd() * (COLS - 4));
    var sy = 2 + Math.floor(rnd() * (ROWS - 4));
    var start = sy * COLS + sx;
    var mine = [], num = [], i, k;
    for (i = 0; i < CELLS; i++) { mine.push(0); num.push(0); }

    var blocked = {};
    blocked[start] = 1;
    for (k = 0; k < NEI[start].length; k++) blocked[NEI[start][k]] = 1;

    var placed = 0, guard = 0;
    while (placed < MINES && guard++ < 100000) {
      i = Math.floor(rnd() * CELLS);
      if (mine[i] || blocked[i]) continue;
      mine[i] = 1; placed++;
    }
    for (i = 0; i < CELLS; i++) {
      if (mine[i]) { num[i] = -1; continue; }
      var c = 0;
      for (k = 0; k < NEI[i].length; k++) if (mine[NEI[i][k]]) c++;
      num[i] = c;
    }
    return { mine: mine, num: num, start: start };
  }

  /* ===================== Spieler-/Bot-Brettzustand ===================== */
  function newPS() {
    var rev = [], flag = [], known = [], i;
    for (i = 0; i < CELLS; i++) { rev.push(0); flag.push(0); known.push(0); }
    return { rev: rev, flag: flag, known: known, safe: 0, flags: 0, lockUntil: 0, done: false };
  }

  /* Aufdecken inkl. Flood-Fill. out (optional) sammelt {i, d} je geöffnetem Feld
   * (d = Abstand zum Klick, für die gestaffelte Animation).
   * Rückgabe: Anzahl neu geöffneter Felder, oder -1 bei Minentreffer. */
  function revealAt(fld, ps, i, out) {
    if (ps.rev[i] || ps.flag[i] || ps.known[i]) return 0;
    if (fld.mine[i]) { ps.known[i] = 1; return -1; }
    var queue = [i], depth = [0], head = 0, n = 0;
    while (head < queue.length) {
      var c = queue[head], d = depth[head]; head++;
      if (ps.rev[c] || ps.flag[c] || ps.known[c]) continue;
      ps.rev[c] = 1; ps.safe++; n++;
      if (out) out.push({ i: c, d: d });
      if (fld.num[c] === 0) {
        var nb = NEI[c];
        for (var k = 0; k < nb.length; k++) {
          var t = nb[k];
          if (!ps.rev[t] && !ps.flag[t] && !ps.known[t] && !fld.mine[t]) { queue.push(t); depth.push(d + 1); }
        }
      }
    }
    return n;
  }

  /* ===================== Bot-KI ===================== */
  /* Klassische Minesweeper-Deduktion. Sichere Minen werden intern sofort geflaggt
   * (kostet den Bot keine Aktion), zurück kommen die garantiert sicheren Felder. */
  function botDeduce(fld, ps) {
    var safe = [], seen = {}, changed = true, guard = 0, i, k;
    while (changed && guard++ < 30) {
      changed = false;
      for (i = 0; i < CELLS; i++) {
        if (!ps.rev[i] || fld.num[i] <= 0) continue;
        var nb = NEI[i], hid = [], fl = 0;
        for (k = 0; k < nb.length; k++) {
          var c = nb[k];
          if (ps.flag[c] || ps.known[c]) fl++;
          else if (!ps.rev[c]) hid.push(c);
        }
        if (!hid.length) continue;
        if (fl === fld.num[i]) {
          for (k = 0; k < hid.length; k++) if (!seen[hid[k]]) { seen[hid[k]] = 1; safe.push(hid[k]); }
        } else if (fl + hid.length === fld.num[i]) {
          for (k = 0; k < hid.length; k++) { ps.flag[hid[k]] = 1; ps.flags++; changed = true; }
        }
      }
    }
    return safe.filter(function (c) { return !ps.rev[c] && !ps.flag[c] && !ps.known[c]; });
  }

  /* Rateschritt. smart=true schätzt je verstecktem Feld die Minen-Wahrscheinlichkeit
   * (schlimmster angrenzender Hinweis) und nimmt das ungefährlichste; ist die globale
   * Restdichte kleiner, wird lieber im offenen Gelände gegraben. */
  function botGuess(fld, ps, rnd, smart) {
    var hidden = [], i, k;
    for (i = 0; i < CELLS; i++) if (!ps.rev[i] && !ps.flag[i] && !ps.known[i]) hidden.push(i);
    if (!hidden.length) return -1;
    if (!smart) return hidden[Math.floor(rnd() * hidden.length)];

    var best = -1, bestP = 2, far = [];
    for (var h = 0; h < hidden.length; h++) {
      var c = hidden[h], p = -1, nb = NEI[c];
      for (k = 0; k < nb.length; k++) {
        var r = nb[k];
        if (!ps.rev[r] || fld.num[r] <= 0) continue;
        var fl = 0, hid = 0, nb2 = NEI[r];
        for (var m = 0; m < nb2.length; m++) {
          var d = nb2[m];
          if (ps.flag[d] || ps.known[d]) fl++;
          else if (!ps.rev[d]) hid++;
        }
        if (hid > 0) { var q = (fld.num[r] - fl) / hid; if (q > p) p = q; }
      }
      if (p < 0) far.push(c);
      else if (p < bestP) { bestP = p; best = c; }
    }
    var remain = MINES;
    for (i = 0; i < CELLS; i++) if (ps.flag[i] || ps.known[i]) remain--;
    var dens = Math.max(0, remain) / hidden.length;
    if (best < 0 || (far.length && dens < bestP)) {
      if (far.length) return far[Math.floor(rnd() * far.length)];
    }
    return best >= 0 ? best : hidden[Math.floor(rnd() * hidden.length)];
  }

  /* Prozent-Fortschritt aus der gemeldeten Punktzahl (Bonus wird abgefangen). */
  function pctOf(score) { return Math.max(0, Math.min(100, Math.round((score / PER_CELL) / SAFE * 100))); }
  function pctFmt(score) { return pctOf(score) + ' %'; }

  /* Ranglisten-Zeilen im Look von App.MG.liveBoard (für den Solo-Modus). */
  function paintRows(host, entries, meId) {
    var ps = entries.slice().sort(function (a, b) { return (b.score || 0) - (a.score || 0); });
    host.innerHTML = '';
    ps.forEach(function (p, i) {
      host.appendChild(el('div', { class: 'mg-sb-row p' + (i + 1) + (p.id === meId ? ' me' : '') }, [
        el('span', { class: 'mg-sb-rank' }, ['' + (i + 1)]),
        el('span', { class: 'mg-sb-name' }, [p.name + (p.id === meId ? ' (du)' : '')]),
        el('span', { class: 'mg-sb-score' }, [pctFmt(p.score || 0)])
      ]));
    });
  }

  /* ===================== Spiel ===================== */
  App.Minigames.minerace = {
    id: 'minerace', title: 'Minen-Rennen', icon: '💣', order: 114,
    subtitle: 'Minesweeper-Wettlauf — grab schneller!',
    single: true, multi: true, minPlayers: 2, maxPlayers: 8,

    render: function (root, ctx) {
      var isMulti = ctx.mode === 'multi';
      var nowFn = isMulti ? function () { return ctx.room.now(); } : function () { return Date.now(); };

      var dead = false;
      var stops = [];          // room.off / Timer-Stopper
      var pending = [];        // laufende setTimeout-IDs
      var listeners = [];      // {t, ty, fn}

      /* Laufzeit-Zustand einer Partie */
      var fld = null, me = null, bots = [], diff = DIFFS.mid;
      var score = 0, finished = false, booted = false, bonusGiven = false;
      var seedVal = 0, startAtVal = 0, baseEndAt = 0, endAtVal = 0;
      var firstDoneId = null, firstDoneName = '';
      var flagMode = false, firstClickUsed = false;
      var loopT = null, timerStop = null, lastReport = 0, reportT = null, lastRankSig = '';
      var mySharedH = null;

      /* DOM-Referenzen */
      var gridEl, cellEls = [], pctEl, scoreEl, timerEl, barEl, flagsEl, flagBtn,
        lockEl, lockNumEl, bannerEl, rankHost;

      function after(ms, fn) { var t = setTimeout(function () { if (!dead) fn(); }, ms); pending.push(t); return t; }
      function clearPending() { pending.forEach(clearTimeout); pending = []; }
      function stopHelpers() { stops.forEach(function (f) { try { f(); } catch (e) {} }); stops = []; timerStop = null; }
      function addL(t, ty, fn, opts) { t.addEventListener(ty, fn, opts); listeners.push({ t: t, ty: ty, fn: fn, opts: opts }); }
      function dropL() { listeners.forEach(function (l) { try { l.t.removeEventListener(l.ty, l.fn, l.opts); } catch (e) {} }); listeners = []; }
      function stopLoop() { if (loopT) { clearInterval(loopT); loopT = null; } }
      function cleanup() {
        dead = true;
        stopLoop(); clearPending(); stopHelpers(); dropL();
        if (isMulti && mySharedH) { ctx.room.off('shared', mySharedH); mySharedH = null; }
      }

      if (isMulti) startMulti(); else chooseDiff();
      return { cleanup: cleanup };

      /* ============ Solo: Schwierigkeit wählen ============ */
      function chooseDiff() {
        stopLoop(); clearPending(); stopHelpers(); dropL();
        finished = false; booted = false;
        var best = App.Storage.get('best_minerace', 0);
        var btns = ['easy', 'mid', 'hard'].map(function (k) {
          var d = DIFFS[k];
          return el('button', { class: 'mrc-diff', type: 'button', onclick: function () {
            if (App.Audio) App.Audio.sfx('select');
            diff = d;
            play(Date.now(), Date.now());
          } }, [
            el('span', { class: 'mrc-diff-ico' }, [d.icon]),
            el('span', { class: 'mrc-diff-l' }, [d.label]),
            el('span', { class: 'mrc-diff-h' }, [d.hint])
          ]);
        });
        root.innerHTML = '';
        root.appendChild(el('div', { class: 'mrc-intro glass' }, [
          el('div', { class: 'mrc-intro-ico' }, ['💣']),
          el('h2', { class: 'neon' }, ['Minen-Rennen']),
          el('p', { class: 'hint-text' }, ['12 × 12 Felder, 24 Minen, 4 Minuten. Du gräbst gegen drei Bots — wer zuerst alle sicheren Felder frei hat, kassiert 500 Bonus.']),
          el('div', { class: 'mrc-diff-row' }, btns),
          el('p', { class: 'mrc-best' }, ['🏆 Dein Rekord: ' + App.MG.fmt(best) + ' Punkte'])
        ]));
      }

      /* ============ Multi: Seed + Startzeit besorgen ============ */
      function startMulti() {
        var snap = ctx.room.snapshot() || {};
        var startAt = (snap.round && snap.round.startAt) || (ctx.room.now() + 3000);
        if (snap.round && snap.round.startAt) { boot(startAt, startAt); return; }

        /* Ohne round.startAt legt der Host Seed + Startzeit fest, alle warten darauf. */
        var m = (snap.shared && snap.shared.mrc) || null;
        if (m && m.seed && m.startAt) { boot(m.seed, m.startAt); return; }
        if (ctx.room.isHost()) ctx.room.setShared({ mrc: { seed: startAt, startAt: startAt, winId: '', winName: '', winAt: 0 } });
        showWait();
        var h = function (sh) {
          var s = sh && sh.mrc;
          if (dead || booted || !s || !s.seed || !s.startAt) return;
          ctx.room.off('shared', h);
          boot(s.seed, s.startAt);
        };
        ctx.room.on('shared', h);
        stops.push(function () { ctx.room.off('shared', h); });
      }
      function boot(seed, startAt) {
        if (booted || dead) return;
        booted = true;
        stops.push(App.MG.countdown(root, startAt, function () { play(seed, startAt); }, ctx.room.now));
      }
      function showWait() {
        root.innerHTML = '';
        root.appendChild(el('div', { class: 'mrc-intro glass' }, [
          el('div', { class: 'mrc-intro-ico' }, ['💣']),
          el('h2', { class: 'neon' }, ['Minen-Rennen']),
          el('p', { class: 'hint-text' }, ['Das Minenfeld wird ausgelost …'])
        ]));
      }

      /* ============ Partie aufbauen ============ */
      function play(seed, startAt) {
        stopLoop(); clearPending(); dropL();
        seedVal = seed; startAtVal = startAt;
        fld = buildField(seed);
        me = newPS();
        score = 0; finished = false; bonusGiven = false; flagMode = false; firstClickUsed = false;
        firstDoneId = null; firstDoneName = ''; lastRankSig = '';
        baseEndAt = startAt + ROUND_SEC * 1000;
        endAtVal = baseEndAt;
        bots = [];

        if (!isMulti) {
          var rnd = makeRng(hashSeed(seed) ^ 0x9e3779b9);
          BOT_CHARS.forEach(function (b, i) {
            bots.push({
              id: 'bot' + i, name: b.name, ps: newPS(), score: 0,
              ms: diff.ms * b.pace, err: Math.min(0.6, diff.err * b.slip), smart: diff.smart,
              nextAt: Date.now() + 700 + i * 220 + rnd() * 400
            });
          });
        }

        buildLayout();
        armTimer(endAtVal);
        paintAll();
        updateHud();
        paintRanks();          // sofort füllen, nicht erst beim ersten Takt (100 ms)

        if (isMulti) {
          ctx.room.reportScore(0);
          mySharedH = function (sh) { onShared(sh); };
          ctx.room.on('shared', mySharedH);
          onShared((ctx.room.snapshot() || {}).shared);   // evtl. schon vorhandener Sieger
        }

        loopT = setInterval(tick, 100);
      }

      function buildLayout() {
        pctEl = el('div', { class: 'mrc-pct' }, ['0 %']);
        scoreEl = el('div', { class: 'mrc-score' }, ['0']);
        timerEl = el('div', { class: 'mg-timer' }, [App.MG.mmss(ROUND_SEC)]);
        var head = el('div', { class: 'mrc-head glass' }, [
          el('div', { class: 'mrc-hc' }, [el('span', { class: 'mrc-hl' }, ['Fortschritt']), pctEl]),
          el('div', { class: 'mrc-hc mrc-hc-mid' }, [el('span', { class: 'mrc-hl' }, ['Punkte']), scoreEl]),
          el('div', { class: 'mrc-hc mrc-hc-right' }, [el('span', { class: 'mrc-hl' }, ['Zeit']), timerEl])
        ]);
        barEl = el('div', { class: 'mrc-bar-fill' });
        var bar = el('div', { class: 'mrc-bar' }, [barEl]);

        bannerEl = el('div', { class: 'mrc-banner' });

        /* Sperr-Anzeige + Flaggen-Zähler teilen sich eine feste Zeile ÜBER dem Raster:
         * so verdeckt der Countdown keine Felder (während der 15 s will man das Brett
         * ja studieren) und es gibt trotzdem keinen Layout-Sprung. */
        lockNumEl = el('span', { class: 'mrc-lock-num' }, ['15']);
        lockEl = el('div', { class: 'mrc-lock' }, [
          el('span', { class: 'mrc-lock-ico' }, ['💥']),
          el('span', {}, ['Gesperrt: ']), lockNumEl, el('span', {}, [' s'])
        ]);
        flagsEl = el('span', { class: 'mrc-flags-n' }, ['0']);
        var flagsChip = el('div', { class: 'chip mrc-chip' }, ['🚩 ', flagsEl, ' / ' + MINES]);
        var statusRow = el('div', { class: 'mrc-status' }, [lockEl, flagsChip]);

        gridEl = el('div', { class: 'mrc-grid' });
        cellEls = [];
        for (var i = 0; i < CELLS; i++) {
          var c = el('button', { class: 'mrc-cell', type: 'button', 'data-i': i, tabindex: '-1' });
          cellEls.push(c); gridEl.appendChild(c);
        }
        var stage = el('div', { class: 'mrc-stage' }, [statusRow, gridEl]);

        flagBtn = el('button', { class: 'btn btn-ghost mrc-flagbtn', type: 'button', onclick: toggleFlagMode }, ['🚩 Flaggen-Modus: aus']);
        var tools = el('div', { class: 'controls-row mrc-tools' }, [flagBtn]);

        rankHost = null;
        var rankBody;
        if (isMulti) {
          var board = App.MG.liveBoard(ctx.room, ctx.me.id, { format: pctFmt });
          stops.push(board.stop);
          rankBody = board.root;
        } else {
          rankHost = el('div', { class: 'mg-scoreboard' });
          rankBody = rankHost;
        }
        var rank = el('div', { class: 'mrc-rank glass' }, [
          el('div', { class: 'mg-field-title' }, ['🏆 Rangliste (Fortschritt)']), rankBody
        ]);

        root.innerHTML = '';
        root.appendChild(el('div', { class: 'mrc-wrap' }, [
          head, bar, bannerEl, stage, tools,
          el('p', { class: 'hint-text mrc-rules' }, ['Klick = aufdecken · Rechtsklick oder langer Druck = 🚩 · 20 Punkte je sicherem Feld · 💥 Mine = 15 s Sperre · +500 für den ersten Fertigen']),
          rank
        ]));

        bindGrid();
      }

      /* ============ Eingabe ============ */
      function toggleFlagMode() {
        flagMode = !flagMode;
        flagBtn.textContent = '🚩 Flaggen-Modus: ' + (flagMode ? 'an' : 'aus');
        flagBtn.classList.toggle('is-on', flagMode);
        gridEl.classList.toggle('mrc-flagging', flagMode);
        if (App.Audio) App.Audio.sfx('click');
      }

      function cellIndexFrom(e) {
        var t = e.target;
        while (t && t !== gridEl && !(t.classList && t.classList.contains('mrc-cell'))) t = t.parentNode;
        if (!t || t === gridEl) return -1;
        var v = parseInt(t.getAttribute('data-i'), 10);
        return isNaN(v) ? -1 : v;
      }

      function bindGrid() {
        var press = null;   // {i, x, y, t, handled}

        addL(gridEl, 'contextmenu', function (e) { e.preventDefault(); });

        addL(gridEl, 'pointerdown', function (e) {
          if (dead || finished) return;
          var i = cellIndexFrom(e);
          if (i < 0) return;
          if (e.button === 2) {                       // Rechtsklick -> Flagge
            e.preventDefault();
            doFlag(i);
            press = { i: i, x: e.clientX, y: e.clientY, handled: true };
            return;
          }
          if (e.button !== 0 && e.pointerType === 'mouse') return;
          press = { i: i, x: e.clientX, y: e.clientY, handled: false };
          var pi = i;
          press.timer = after(LONGPRESS_MS, function () {   // langer Druck -> Flagge
            if (!press || press.i !== pi || press.handled) return;
            press.handled = true;
            doFlag(pi);
          });
        });

        addL(gridEl, 'pointermove', function (e) {
          if (!press || press.handled) return;
          if (Math.abs(e.clientX - press.x) > MOVE_TOL || Math.abs(e.clientY - press.y) > MOVE_TOL) {
            if (press.timer) clearTimeout(press.timer);
            press = null;                              // Wischen -> kein Klick
          }
        });

        addL(gridEl, 'pointerup', function (e) {
          if (!press) return;
          var p = press; press = null;
          if (p.timer) clearTimeout(p.timer);
          if (p.handled) return;
          var i = cellIndexFrom(e);
          if (i !== p.i) return;
          if (flagMode) doFlag(i); else doReveal(i);
        });

        addL(gridEl, 'pointercancel', function () {
          if (press && press.timer) clearTimeout(press.timer);
          press = null;
        });
        addL(gridEl, 'pointerleave', function () {
          if (press && press.timer) clearTimeout(press.timer);
          press = null;
        });
      }

      function locked() { return nowFn() < me.lockUntil; }

      function doFlag(i) {
        if (dead || finished || locked()) return;
        if (me.rev[i] || me.known[i]) return;
        me.flag[i] = me.flag[i] ? 0 : 1;
        me.flags += me.flag[i] ? 1 : -1;
        paintCell(i);
        flagsEl.textContent = String(me.flags);
        if (App.Audio) App.Audio.sfx(me.flag[i] ? 'select' : 'click');
      }

      function doReveal(i) {
        if (dead || finished) return;
        if (locked()) { UI.toast('Noch gesperrt — der Schreck sitzt tief 💥', 'info'); return; }
        if (me.rev[i] || me.flag[i] || me.known[i]) return;

        /* Anfänger-Schutz: der allererste Klick kostet nie eine Sperre. */
        if (!firstClickUsed) {
          firstClickUsed = true;
          hideStartHint();
          if (fld.mine[i]) {
            me.known[i] = 1; me.flag[i] = 1; me.flags++;
            paintCell(i);
            flagsEl.textContent = String(me.flags);
            if (App.Audio) App.Audio.sfx('info');
            UI.toast('Glück gehabt! Der erste Klick ist gratis — Mine markiert 🚩', 'info');
            return;
          }
        }

        var out = [];
        var n = revealAt(fld, me, i, out);
        if (n < 0) { boom(i); return; }
        if (n === 0) return;

        out.forEach(function (o) {
          paintCell(o.i);
          var e2 = cellEls[o.i];
          e2.style.animationDelay = Math.min(o.d * 14, 180) + 'ms';
          e2.classList.remove('mrc-pop'); void e2.offsetWidth; e2.classList.add('mrc-pop');
        });
        score += n * PER_CELL;
        if (App.Audio) {
          if (n > 3) App.Audio.sweep(420, 420 + Math.min(n, 24) * 22, 0.16, { type: 'triangle', peak: 0.07 });
          else App.Audio.blip(560 + Math.min(fld.num[i], 6) * 45, 0.06, { type: 'square', peak: 0.05 });
        }
        report();
        updateHud();
        if (me.safe >= SAFE) meDone();
      }

      function boom(i) {
        me.lockUntil = nowFn() + LOCK_MS;
        paintCell(i);
        var c = cellEls[i];
        c.classList.add('mrc-boom');
        gridEl.classList.add('mrc-shake');
        after(420, function () { if (gridEl) gridEl.classList.remove('mrc-shake'); });
        after(700, function () { if (cellEls[i]) cellEls[i].classList.remove('mrc-boom'); });
        if (App.Audio) App.Audio.sfx('explosion');
        UI.toast('💥 Mine! 15 Sekunden Zwangspause', 'lose');
        updateHud();
      }

      function meDone() {
        if (me.done) return;
        me.done = true;
        if (App.Audio) App.Audio.sfx('jackpot');
        if (isMulti) {
          var m = curMrc();
          if (!m.winId) {                              // Sieg anmelden — Bonus erst per Echo
            ctx.room.setShared({ mrc: Object.assign({}, m, { winId: ctx.me.id, winName: ctx.room.name, winAt: ctx.room.now() }) });
          }
          setBanner('🏁 Feld geräumt! Warten auf die anderen …', 'ok');
        } else {
          onFirstDone({ id: 'me', name: 'Du' });
          if (firstDoneId !== 'me') setBanner('🏁 Feld geräumt — der Bonus ist leider schon weg', 'warn');
        }
        report();
        updateHud();
      }

      /* ============ Multiplayer-Sync ============ */
      function curMrc() {
        var snap = ctx.room.snapshot() || {};
        var m = (snap.shared && snap.shared.mrc) || {};
        return { seed: m.seed || seedVal, startAt: m.startAt || startAtVal, winId: m.winId || '', winName: m.winName || '', winAt: m.winAt || 0 };
      }
      /* Idempotent — feuert bei jedem Heartbeat mit. */
      function onShared(sh) {
        if (dead || finished || !isMulti) return;
        var m = (sh && sh.mrc) || null;
        if (!m || !m.winId) return;
        if (m.seed && seedVal && m.seed !== seedVal) return;      // Daten einer alten Runde
        if (firstDoneId === m.winId) return;
        firstDoneId = m.winId; firstDoneName = m.winName || 'Jemand';
        var winAt = m.winAt || ctx.room.now();
        if (m.winId === ctx.me.id && !bonusGiven) {
          bonusGiven = true;
          score += FINISH_BONUS;
          report(); updateHud();
          setBanner('🥇 Zuerst fertig! +' + FINISH_BONUS + ' Bonus', 'ok');
          if (App.Audio) App.Audio.sfx('levelup');
        } else {
          setBanner('🏁 ' + firstDoneName + ' ist fertig — Endspurt!', 'warn');
          if (App.Audio) App.Audio.sfx('info');
        }
        armTimer(Math.min(baseEndAt, winAt + ENDSPURT_MS));
      }

      /* Solo: erster Fertiger (ich oder ein Bot) startet den Endspurt. */
      function onFirstDone(who) {
        if (firstDoneId) return;
        firstDoneId = who.id; firstDoneName = who.name;
        if (who.id === 'me') {
          bonusGiven = true;
          score += FINISH_BONUS;
          setBanner('🥇 Zuerst fertig! +' + FINISH_BONUS + ' Bonus', 'ok');
          if (App.Audio) App.Audio.sfx('levelup');
        } else {
          setBanner('🏁 ' + who.name + ' ist fertig — Endspurt!', 'warn');
          if (App.Audio) App.Audio.sfx('info');
        }
        armTimer(Math.min(baseEndAt, Date.now() + ENDSPURT_MS));
      }

      function report() {
        if (!isMulti || dead) return;
        var t = Date.now();
        if (t - lastReport >= REPORT_MS) { lastReport = t; ctx.room.reportScore(score); return; }
        if (reportT) return;
        reportT = after(REPORT_MS - (t - lastReport), function () {
          reportT = null; lastReport = Date.now();
          if (!dead) ctx.room.reportScore(score);
        });
      }

      function armTimer(endAt) {
        if (endAt === endAtVal && timerStop) return;
        endAtVal = endAt;
        if (timerStop) {
          try { timerStop(); } catch (e) {}
          var ix = stops.indexOf(timerStop); if (ix >= 0) stops.splice(ix, 1);
          timerStop = null;
        }
        timerStop = App.MG.roundTimer(endAt, function (left) {
          if (!timerEl) return;
          timerEl.textContent = App.MG.mmss(left);
          timerEl.classList.toggle('mrc-urgent', left <= 15);
        }, finish, isMulti ? ctx.room.now : null);
        stops.push(timerStop);
      }

      /* ============ Haupt-Takt (Sperre, Bots, Rangliste) ============ */
      function tick() {
        if (dead || finished) return;
        var t = nowFn();
        var lock = Math.max(0, me.lockUntil - t);
        if (lock > 0) {
          lockEl.classList.add('is-on');
          gridEl.classList.add('mrc-locked');
          lockNumEl.textContent = String(Math.ceil(lock / 1000));
        } else if (lockEl.classList.contains('is-on')) {
          lockEl.classList.remove('is-on');
          gridEl.classList.remove('mrc-locked');
          if (App.Audio) App.Audio.sfx('ding');
        }
        if (!isMulti) { stepBots(Date.now()); paintRanks(); }
      }

      function stepBots(t) {
        for (var b = 0; b < bots.length; b++) {
          var bot = bots[b];
          if (bot.ps.done || t < bot.ps.lockUntil || t < bot.nextAt) continue;
          bot.nextAt = t + bot.ms * (0.75 + Math.random() * 0.5);
          var target = -1;
          var slip = Math.random() < bot.err;           // Flüchtigkeitsfehler
          if (!slip) {
            var s = botDeduce(fld, bot.ps);
            if (s.length) target = s[Math.floor(Math.random() * s.length)];
          }
          if (target < 0) target = botGuess(fld, bot.ps, Math.random, !slip && bot.smart);
          if (target < 0) continue;
          var n = revealAt(fld, bot.ps, target, null);
          if (n < 0) { bot.ps.lockUntil = t + LOCK_MS; continue; }
          bot.score = bot.ps.safe * PER_CELL;
          if (bot.ps.safe >= SAFE) {
            bot.ps.done = true;
            if (!firstDoneId) { bot.score += FINISH_BONUS; onFirstDone(bot); }
          }
        }
      }

      /* Nur neu zeichnen, wenn sich wirklich etwas geändert hat — der Takt läuft
       * 10x/s, ein Neuaufbau je Tick wäre unnötig teuer und würde flackern. */
      function paintRanks() {
        if (!rankHost) return;
        var list = [{ id: 'me', name: 'Du', score: score }];
        bots.forEach(function (b) { list.push({ id: b.id, name: b.name, score: b.score }); });
        var sig = list.map(function (p) { return p.id + ':' + p.score; }).join('|');
        if (sig === lastRankSig) return;
        lastRankSig = sig;
        paintRows(rankHost, list, 'me');
      }

      /* ============ Zeichnen ============ */
      function paintAll() {
        for (var i = 0; i < CELLS; i++) paintCell(i);
        cellEls[fld.start].classList.add('mrc-start');
        cellEls[fld.start].textContent = '🌱';
      }
      function hideStartHint() {
        var c = cellEls[fld.start];
        if (c && c.classList.contains('mrc-start')) { c.classList.remove('mrc-start'); if (!me.rev[fld.start]) c.textContent = ''; }
      }
      function paintCell(i) {
        var c = cellEls[i];
        if (!c) return;
        var cls = 'mrc-cell';
        var txt = '';
        if (me.known[i]) { cls += ' is-mine'; txt = '💣'; }
        else if (me.rev[i]) {
          cls += ' is-open';
          if (fld.num[i] > 0) { cls += ' n' + fld.num[i]; txt = String(fld.num[i]); }
        } else if (me.flag[i]) { cls += ' is-flag'; txt = '🚩'; }
        c.className = cls;
        if (c.textContent !== txt) c.textContent = txt;
      }
      function updateHud() {
        var p = Math.round(me.safe / SAFE * 100);
        pctEl.textContent = p + ' %';
        barEl.style.width = p + '%';
        scoreEl.textContent = App.MG.fmt(score);
        scoreEl.classList.remove('mrc-bump'); void scoreEl.offsetWidth; scoreEl.classList.add('mrc-bump');
        flagsEl.textContent = String(me.flags);
      }
      function setBanner(text, kind) {
        if (!bannerEl) return;
        bannerEl.textContent = text;
        bannerEl.className = 'mrc-banner is-on ' + (kind === 'ok' ? 'is-ok' : 'is-warn');
      }

      /* ============ Ende ============ */
      function finish() {
        if (finished || dead) return;
        finished = true;
        stopLoop(); clearPending(); stopHelpers();

        /* Restliche Minen aufdecken — zeigt, wie nah man dran war. */
        if (fld && cellEls.length) {
          gridEl.classList.add('mrc-locked');
          for (var i = 0; i < CELLS; i++) {
            if (fld.mine[i] && !me.known[i]) {
              cellEls[i].className = 'mrc-cell is-mine is-rest';
              cellEls[i].textContent = '💣';
            }
          }
        }
        if (App.Audio) App.Audio.sfx('whoosh');

        if (isMulti) {
          ctx.room.reportScore(score);
          if (mySharedH) { ctx.room.off('shared', mySharedH); mySharedH = null; }
          after(1400, function () {
            App.MG.endScreen(root, { players: ctx.room.players(), meId: ctx.me.id, onExit: ctx.onExit });
          });
          return;
        }

        var list = [{ id: 'me', name: 'Du', score: score }];
        bots.forEach(function (b) { list.push({ id: b.id, name: b.name, score: b.score }); });
        list.sort(function (a, b) { return b.score - a.score; });
        var place = 1;
        for (var k = 0; k < list.length; k++) if (list[k].id === 'me') { place = k + 1; break; }
        var best = App.Storage.get('best_minerace', 0);
        var nb = score > best;
        if (nb) App.Storage.set('best_minerace', score);
        var pct = Math.round(me.safe / SAFE * 100);
        after(1200, function () {
          App.MG.endScreen(root, {
            score: score, best: best, newBest: nb,
            label: pct + ' % geräumt · Platz ' + place + ' von ' + list.length + ' (' + diff.label + ')'
              + (nb ? ' · neuer Rekord! 🎉' : ' · Bestwert: ' + App.MG.fmt(best)),
            onExit: ctx.onExit,
            onAgain: function () { chooseDiff(); }
          });
        });
      }
    }
  };

  /* ===================== STYLES ===================== */
  function injectStyle() {
    UI.injectStyle('mg-minerace-css', [
      '.mrc-wrap{display:flex;flex-direction:column;gap:12px;max-width:460px;margin:0 auto;}',
      /* Kopf */
      '.mrc-head{display:flex;justify-content:space-between;align-items:center;padding:10px 16px;gap:10px;}',
      '.mrc-hc{display:flex;flex-direction:column;gap:2px;min-width:0;}',
      '.mrc-hc-mid{text-align:center;}',
      '.mrc-hc-right{text-align:right;}',
      '.mrc-hl{color:var(--muted);font-size:10px;text-transform:uppercase;letter-spacing:1px;}',
      '.mrc-pct{font-size:clamp(20px,5.4vw,30px);font-weight:900;line-height:1;color:var(--aqua);text-shadow:0 0 12px rgba(51,230,208,.45);font-variant-numeric:tabular-nums;}',
      '.mrc-score{font-size:clamp(20px,5.4vw,30px);font-weight:900;line-height:1;color:var(--gold);text-shadow:0 0 12px rgba(255,210,63,.4);font-variant-numeric:tabular-nums;}',
      '.mrc-head .mg-timer{font-size:clamp(16px,4.4vw,24px);}',
      '.mrc-head .mg-timer.mrc-urgent{color:var(--danger-2);animation:mrc-pulse .7s infinite;}',
      '.mrc-bump{animation:mrc-bump .26s ease;}',
      /* Fortschrittsbalken */
      '.mrc-bar{height:8px;border-radius:99px;background:rgba(4,16,10,.8);border:1px solid var(--stroke);overflow:hidden;}',
      '.mrc-bar-fill{height:100%;width:0%;border-radius:99px;background:linear-gradient(90deg,var(--aqua),var(--neon));box-shadow:0 0 12px var(--stroke-2);transition:width .25s ease;}',
      /* Banner */
      '.mrc-banner{display:none;text-align:center;font-weight:900;font-size:14px;padding:7px 10px;border-radius:12px;border:1px solid var(--stroke);}',
      '.mrc-banner.is-on{display:block;animation:mrc-slide .3s ease both;}',
      '.mrc-banner.is-ok{color:var(--gold);border-color:var(--gold);background:rgba(255,210,63,.1);box-shadow:0 0 18px rgba(255,210,63,.25);}',
      '.mrc-banner.is-warn{color:var(--aqua);border-color:var(--stroke-2);background:rgba(51,230,208,.08);}',
      /* Spielfläche + Statuszeile (feste Höhe -> kein Sprung beim Ein-/Ausblenden) */
      '.mrc-stage{position:relative;display:flex;flex-direction:column;gap:6px;}',
      '.mrc-status{min-height:34px;display:flex;align-items:center;justify-content:center;}',
      '.mrc-lock{display:none;align-items:center;gap:6px;padding:7px 14px;border-radius:14px;font-weight:900;',
      'font-size:15px;color:#fff;background:rgba(60,4,14,.94);border:1px solid var(--danger);',
      'box-shadow:0 0 26px rgba(255,77,109,.55);white-space:nowrap;}',
      '.mrc-lock.is-on{display:flex;animation:mrc-slide .25s ease both;}',
      /* während der Sperre weicht der Flaggen-Zähler dem Countdown */
      '.mrc-lock.is-on ~ .mrc-chip{display:none;}',
      '.mrc-lock-ico{font-size:18px;animation:mrc-pulse .8s infinite;}',
      '.mrc-lock-num{color:var(--danger-2);font-variant-numeric:tabular-nums;min-width:20px;text-align:right;}',
      /* Raster */
      '.mrc-grid{display:grid;grid-template-columns:repeat(12,1fr);gap:2px;width:100%;max-width:340px;margin:0 auto;',
      'aspect-ratio:1/1;padding:6px;border-radius:16px;background:rgba(4,16,10,.72);border:1px solid var(--stroke);',
      'box-shadow:inset 0 0 40px rgba(57,255,20,.06);touch-action:manipulation;user-select:none;-webkit-user-select:none;',
      '-webkit-touch-callout:none;-webkit-tap-highlight-color:transparent;transition:filter .2s;}',
      '.mrc-grid.mrc-locked{filter:grayscale(.7) brightness(.55);pointer-events:none;}',
      '.mrc-grid.mrc-shake{animation:mrc-shake .4s ease;}',
      '.mrc-cell{padding:0;margin:0;border-radius:4px;font-family:inherit;font-weight:900;line-height:1;',
      'font-size:clamp(11px,3.6vw,17px);display:flex;align-items:center;justify-content:center;cursor:pointer;',
      'background:linear-gradient(180deg,rgba(20,64,42,.95),rgba(9,38,24,.95));border:1px solid var(--stroke);',
      'color:var(--text);transition:background .12s,border-color .12s,transform .08s;overflow:hidden;}',
      '.mrc-cell:hover{border-color:var(--neon);background:linear-gradient(180deg,rgba(30,88,56,.95),rgba(14,52,32,.95));}',
      '.mrc-cell:active{transform:scale(.9);}',
      '.mrc-grid.mrc-flagging .mrc-cell:hover{border-color:var(--gold);}',
      '.mrc-cell.is-open{background:rgba(3,12,8,.9);border-color:rgba(57,255,20,.1);cursor:default;transform:none;',
      'text-shadow:0 0 7px currentColor;}',
      '.mrc-cell.is-open:hover{background:rgba(3,12,8,.9);border-color:rgba(57,255,20,.1);}',
      '.mrc-cell.is-flag{background:linear-gradient(180deg,rgba(72,58,10,.95),rgba(40,30,4,.95));border-color:var(--gold);}',
      '.mrc-cell.is-mine{background:radial-gradient(circle,rgba(140,12,36,.95),rgba(50,4,14,.95));border-color:var(--danger);cursor:default;}',
      '.mrc-cell.is-rest{opacity:.6;}',
      '.mrc-cell.mrc-start{border-color:var(--neon);box-shadow:0 0 0 1px var(--neon),0 0 14px rgba(57,255,20,.6);animation:mrc-glow 1.3s ease-in-out infinite;}',
      '.mrc-cell.mrc-pop{animation:mrc-pop .22s ease both;}',
      '.mrc-cell.mrc-boom{animation:mrc-boom .45s ease;z-index:2;}',
      /* Zahlen in den üblichen Farben (Neon-Variante) */
      '.mrc-cell.n1{color:#5aa9ff;}',
      '.mrc-cell.n2{color:var(--neon);}',
      '.mrc-cell.n3{color:var(--danger);}',
      '.mrc-cell.n4{color:#b48cff;}',
      '.mrc-cell.n5{color:var(--bronze);}',
      '.mrc-cell.n6{color:var(--aqua);}',
      '.mrc-cell.n7{color:var(--silver);}',
      '.mrc-cell.n8{color:var(--muted);}',
      /* Werkzeugleiste */
      '.mrc-tools{gap:8px;}',
      '.mrc-flagbtn{font-weight:800;}',
      '.mrc-flagbtn.is-on{color:#2a1e02;background:linear-gradient(180deg,var(--gold),#e0b02a);border-color:var(--gold);box-shadow:0 0 16px rgba(255,210,63,.4);}',
      '.mrc-chip{font-variant-numeric:tabular-nums;}',
      '.mrc-rules{text-align:center;font-size:11px;margin:0;line-height:1.5;}',
      /* Rangliste */
      '.mrc-rank{padding:12px 14px;display:flex;flex-direction:column;gap:8px;}',
      '.mrc-rank .mg-scoreboard{max-height:220px;overflow-y:auto;}',
      '.mrc-rank .mg-sb-score{font-variant-numeric:tabular-nums;white-space:nowrap;}',
      /* Startbildschirm (Solo) */
      '.mrc-intro{padding:26px 22px;text-align:center;display:flex;flex-direction:column;gap:12px;align-items:center;max-width:460px;margin:0 auto;}',
      '.mrc-intro-ico{font-size:52px;line-height:1;filter:drop-shadow(0 0 14px rgba(255,77,109,.5));animation:mrc-bob 2.4s ease-in-out infinite;}',
      '.mrc-intro h2{margin:0;}',
      '.mrc-diff-row{display:flex;flex-direction:column;gap:8px;width:100%;max-width:320px;}',
      '.mrc-diff{display:flex;align-items:center;gap:12px;padding:11px 14px;border-radius:14px;cursor:pointer;',
      'background:rgba(9,32,21,.6);border:1px solid var(--stroke);color:var(--text);font-family:inherit;text-align:left;transition:.15s;}',
      '.mrc-diff:hover{border-color:var(--neon);box-shadow:0 0 18px rgba(57,255,20,.3);transform:translateY(-2px);}',
      '.mrc-diff:active{transform:scale(.98);}',
      '.mrc-diff-ico{font-size:22px;line-height:1;}',
      '.mrc-diff-l{font-weight:900;font-size:15px;color:var(--leaf);min-width:56px;}',
      '.mrc-diff-h{font-size:11px;color:var(--muted);flex:1;min-width:0;}',
      '.mrc-best{margin:0;font-size:12px;color:var(--gold);font-weight:800;}',
      /* Animationen */
      '@keyframes mrc-pop{0%{transform:scale(.4);opacity:.2}70%{transform:scale(1.1)}100%{transform:scale(1);opacity:1}}',
      '@keyframes mrc-boom{0%{transform:scale(1);filter:brightness(3)}40%{transform:scale(1.5);filter:brightness(2)}100%{transform:scale(1);filter:brightness(1)}}',
      '@keyframes mrc-shake{0%,100%{transform:translateX(0)}20%{transform:translateX(-6px)}45%{transform:translateX(6px)}70%{transform:translateX(-3px)}}',
      '@keyframes mrc-pulse{0%,100%{opacity:1}50%{opacity:.35}}',
      '@keyframes mrc-bump{0%{transform:scale(1)}45%{transform:scale(1.16)}100%{transform:scale(1)}}',
      '@keyframes mrc-glow{0%,100%{box-shadow:0 0 0 1px var(--neon),0 0 8px rgba(57,255,20,.4)}50%{box-shadow:0 0 0 1px var(--neon),0 0 20px rgba(57,255,20,.9)}}',
      '@keyframes mrc-slide{from{opacity:0;transform:translateY(-6px)}to{opacity:1;transform:translateY(0)}}',
      '@keyframes mrc-bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-6px)}}'
    ].join(''));
  }
})();
