/* lightsout.js — "Lights Out": Lampen-Rätsel als Wettrennen im Neon-Dschungel.
 *
 * SPIELIDEE: Ein 5x5-Gitter aus Lampen. Ein Klick schaltet die getroffene Lampe
 *   UND ihre vier direkten Nachbarn um. Ziel: alle Lampen aus. Ist ein Rätsel
 *   gelöst, kommt sofort das nächste — jedes eine Stufe schwerer (mehr
 *   Ausgangsklicks beim Mischen). Gesamtzeit: 3 Minuten.
 *
 * STEUERUNG: Klick / Tipp auf eine Lampe (pointerdown, Maus + Touch).
 *
 * PUNKTE pro gelöstem Rätsel:
 *   500 Grundpunkte
 * + 25 je Klick, den du unter dem Par (bekannte Mindestklickzahl) bleibst
 * + Tempobonus: 15 Punkte je Sekunde, die du unter der Zielzeit bleibst
 *   Das Par wird ehrlich berechnet: über Gauss-Elimination in GF(2) bestimmt das
 *   Spiel das echte Optimum (kürzeste mögliche Lösung) und gibt darauf etwas
 *   Luft. Das Optimum wird angezeigt — wer es trifft, holt den vollen Bonus.
 *
 * RÄTSEL-ERZEUGUNG: Immer aus dem GELÖSTEN Zustand heraus mit einer festen Zahl
 *   zufälliger Klicks → dadurch garantiert lösbar. Der Zufall kommt aus einem
 *   Seed (LCG), also erzeugen alle Geräte exakt dieselbe Rätselfolge.
 *
 * SYNC-MODELL (multi): Der Host würfelt EINEN Seed und verteilt ihn per
 *   room.setShared({ lgoSeed }). Jeder Client baut daraus lokal dieselben
 *   Rätsel und löst sie in seinem eigenen Tempo — ein reines Punkte-Rennen.
 *   Fortschritt geht nur über room.reportScore(); die Live-Rangliste kommt von
 *   App.MG.liveBoard. Alle Timer laufen über room.now() (Server-Zeit) bzw.
 *   Date.now() im Solo → Tab-Wechsel-sicher.
 *
 * SOLO: Punktejagd gegen den eigenen Rekord — ein "Rekord-Geist" läuft im
 *   Rekord-Tempo mit, damit man live sieht, ob man vorn oder hinten liegt.
 *
 * cleanup() setzt das dead-Flag, stoppt alle Timeouts/Timer und meldet jeden
 * room.on(...) wieder ab. */
(function () {
  'use strict';
  window.App = window.App || {}; App.Minigames = App.Minigames || {};
  var UI = App.UI, el = UI.el;

  injectStyle();

  /* ===================== Brett-Grundlagen ===================== */
  var SIZE = 5, N = 25;
  var FULL = 0x1FFFFFF;          // 25 gesetzte Bits
  var AUG = 1 << 25;             // Spalte der rechten Seite bei der Elimination
  var DURATION = 180;            // s Gesamtzeit (3 Minuten)
  var BASE_POINTS = 500;         // Punkte pro gelöstem Rätsel
  var PER_CLICK = 25;            // Punkte je Klick unter Par
  var PAR_SLACK = 2;             // Luft über dem echten Optimum
  var SPEED_PER_SEC = 15;        // Tempobonus je Sekunde unter der Zielzeit

  function bit(i) { return 1 << i; }
  function popcount(x) { var c = 0; while (x) { x &= x - 1; c++; } return c; }

  /* TOGGLE[i] = Maske aller Lampen, die ein Klick auf i umschaltet (i + 4 Nachbarn). */
  var TOGGLE = (function () {
    var t = [], i, r, c, m;
    for (i = 0; i < N; i++) {
      r = Math.floor(i / SIZE); c = i % SIZE;
      m = bit(i);
      if (r > 0) m |= bit(i - SIZE);
      if (r < SIZE - 1) m |= bit(i + SIZE);
      if (c > 0) m |= bit(i - 1);
      if (c < SIZE - 1) m |= bit(i + 1);
      t.push(m);
    }
    return t;
  })();

  /* Deterministischer Zufall (LCG) — gleicher Seed ergibt gleiche Rätsel auf allen Geräten. */
  function rng(seed) {
    var s = (seed >>> 0) || 1;
    return function () {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
  }

  /* Gauss-Elimination über GF(2): löst A*x = lights.
   * A ist symmetrisch (Zeile i = TOGGLE[i]). Rückgabe: eine Lösung x plus eine
   * Basis des Nullraums (die "stillen Muster"), sonst null wenn unlösbar. */
  function gauss(lights) {
    var rows = [], i, c, p, t;
    for (i = 0; i < N; i++) rows.push(TOGGLE[i] | (((lights >> i) & 1) ? AUG : 0));
    var pivotOfCol = [];
    for (i = 0; i < N; i++) pivotOfCol.push(-1);
    var r = 0;
    for (c = 0; c < N && r < N; c++) {
      p = -1;
      for (i = r; i < N; i++) { if (rows[i] & bit(c)) { p = i; break; } }
      if (p < 0) continue;
      t = rows[r]; rows[r] = rows[p]; rows[p] = t;
      for (i = 0; i < N; i++) { if (i !== r && (rows[i] & bit(c))) rows[i] ^= rows[r]; }
      pivotOfCol[c] = r;
      r++;
    }
    for (i = 0; i < N; i++) { if ((rows[i] & FULL) === 0 && (rows[i] & AUG)) return null; }
    var x = 0;
    for (c = 0; c < N; c++) { if (pivotOfCol[c] >= 0 && (rows[pivotOfCol[c]] & AUG)) x |= bit(c); }
    var basis = [], f, v;
    for (f = 0; f < N; f++) {
      if (pivotOfCol[f] >= 0) continue;
      v = bit(f);
      for (c = 0; c < N; c++) { if (pivotOfCol[c] >= 0 && (rows[pivotOfCol[c]] & bit(f))) v |= bit(c); }
      basis.push(v);
    }
    return { x: x, basis: basis };
  }

  /* Kürzeste mögliche Lösung: Grundlösung XOR jede Kombination der stillen Muster. */
  function optimumClicks(lights) {
    var g = gauss(lights);
    if (!g) return popcount(lights);
    var best = popcount(g.x), k = g.basis.length, combos = 1 << k, i, j, v, pc;
    for (i = 1; i < combos; i++) {
      v = g.x;
      for (j = 0; j < k; j++) { if (i & bit(j)) v ^= g.basis[j]; }
      pc = popcount(v);
      if (pc < best) best = pc;
    }
    return best;
  }

  /* Rätsel bauen: aus dem gelösten Zustand heraus `scramble` Zufallsklicks.
   * Dadurch garantiert lösbar. Ergibt das Mischen zufällig wieder "alles aus",
   * wird deterministisch weitergewürfelt (auf allen Geräten identisch). */
  function makePuzzle(seed, scramble) {
    var tries, rand, i, cellIdx, clickMask, lights, opt;
    for (tries = 0; tries < 60; tries++) {
      rand = rng((seed + tries * 7919) >>> 0);
      clickMask = 0; lights = 0;
      for (i = 0; i < scramble; i++) {
        cellIdx = Math.floor(rand() * N);
        if (cellIdx >= N) cellIdx = N - 1;
        clickMask ^= bit(cellIdx);
        lights ^= TOGGLE[cellIdx];
      }
      if (lights !== 0) {
        opt = optimumClicks(lights);
        return { lights: lights, optimum: opt, par: Math.max(opt + PAR_SLACK, popcount(clickMask)) };
      }
    }
    /* Deterministischer Notnagel — kann praktisch nie eintreten. */
    lights = TOGGLE[(seed >>> 3) % N];
    opt = optimumClicks(lights);
    return { lights: lights, optimum: opt, par: opt + PAR_SLACK };
  }

  function scrambleFor(level) { return Math.min(3 + level, 16); }   // Rätsel 1 = 4 Klicks, dann +1
  function targetSec(level) { return Math.min(14 + 4 * level, 46); } // Zielzeit für den Tempobonus

  /* ===================== Registrierung ===================== */
  App.Minigames.lightsout = {
    id: 'lightsout', title: 'Lights Out', icon: '💡', order: 121,
    subtitle: 'Schalte alle Lampen aus – wer schafft mehr?',
    single: true, multi: true, minPlayers: 2, maxPlayers: 8,

    render: function (root, ctx) {
      var isMulti = ctx.mode === 'multi';
      var nowFn = isMulti ? ctx.room.now : function () { return Date.now(); };

      var dead = false;
      var stops = [];        // stop()-Funktionen (App.MG-Bausteine, room.off, Listener)
      var pending = [];      // laufende setTimeout-IDs
      var started = false, finished = false;

      /* Laufender Spielzustand */
      var seed = 0, cdDone = false;
      var score = 0, solvedCount = 0, level = 1;
      var puz = null, lights = 0, clicks = 0, puzStartAt = 0, busy = false;
      var soloBest = 0;

      /* DOM-Referenzen */
      var cells = [], rings = [], puzEl, scoreEl, timerEl, clickEl, optEl, solvedEl, burstEl, gainEl;
      var paceMeEl, paceGhostEl, paceDiffEl, paceRow;

      function after(ms, fn) { var t = setTimeout(function () { if (!dead) fn(); }, ms); pending.push(t); return t; }
      function clearPending() { pending.forEach(clearTimeout); pending = []; }
      function stopHelpers() { stops.forEach(function (f) { try { f(); } catch (e) {} }); stops = []; }
      function cleanup() { dead = true; clearPending(); stopHelpers(); }

      /* ---------------- Start ---------------- */
      if (isMulti) {
        var snap = ctx.room.snapshot() || {};
        var startAt = (snap.round && snap.round.startAt) || (ctx.room.now() + 3000);
        var sh0 = snap.shared || {};
        seed = (sh0.lgoSeed || 0) >>> 0;
        /* Der Host würfelt den gemeinsamen Seed und verteilt ihn. */
        if (!seed && ctx.room.isHost()) {
          seed = (Math.floor(Math.random() * 2147483646) + 1) >>> 0;
          ctx.room.setShared({ lgoSeed: seed });
        }
        var onShared = function (sh) {
          if (dead || started) return;                 // idempotent: Heartbeat feuert oft
          if (sh && sh.lgoSeed) { seed = sh.lgoSeed >>> 0; maybeStart(startAt); }
        };
        ctx.room.on('shared', onShared);
        stops.push(function () { ctx.room.off('shared', onShared); });
        stops.push(App.MG.countdown(root, startAt, function () {
          cdDone = true; maybeStart(startAt);
        }, ctx.room.now));
      } else {
        seed = (Math.floor(Math.random() * 2147483646) + 1) >>> 0;
        cdDone = true;
        maybeStart(nowFn());
      }
      return { cleanup: cleanup };

      /* Startet erst, wenn Countdown durch IST und der Seed da ist. */
      function maybeStart(startAt) {
        if (dead || started) return;
        if (!cdDone) return;
        if (!seed) { showWaitSeed(); return; }
        started = true;
        play(startAt);
      }

      function showWaitSeed() {
        root.innerHTML = '';
        root.appendChild(el('div', { class: 'glass lgo-wait' }, [
          el('div', { class: 'lgo-wait-icon' }, ['💡']),
          el('h2', { class: 'neon' }, ['Lights Out']),
          el('p', { class: 'hint-text' }, ['Rätsel wird verteilt …'])
        ]));
      }

      /* ===================== SPIEL ===================== */
      function play(startAt) {
        clearPending(); stopHelpers();
        score = 0; solvedCount = 0; level = 1; clicks = 0; busy = false; finished = false;
        var endAt = startAt + DURATION * 1000;
        soloBest = isMulti ? 0 : App.Storage.get('best_lightsout', 0);

        /* --- Kopfzeile: Rätsel / Punkte / Zeit --- */
        puzEl = el('div', { class: 'lgo-hv' }, ['1']);
        scoreEl = el('div', { class: 'lgo-hv lgo-hv-gold' }, ['0']);
        timerEl = el('div', { class: 'mg-timer' }, [App.MG.mmss(DURATION)]);
        var head = el('div', { class: 'lgo-head glass' }, [
          el('div', { class: 'lgo-hcell' }, [el('span', { class: 'lgo-hl' }, ['Rätsel']), puzEl]),
          el('div', { class: 'lgo-hcell lgo-hmid' }, [el('span', { class: 'lgo-hl' }, ['Punkte']), scoreEl]),
          el('div', { class: 'lgo-hcell lgo-hright' }, [el('span', { class: 'lgo-hl' }, ['Zeit']), timerEl])
        ]);

        /* --- Regel-/Steuerungszeile --- */
        var rules = el('p', { class: 'hint-text lgo-rules' }, [
          '💡 Klick schaltet die Lampe + ihre 4 Nachbarn um · Ziel: alles AUS · 3 Minuten, dann kommt das nächste Rätsel'
        ]);

        /* --- 5x5-Gitter --- */
        var grid = el('div', { class: 'lgo-grid' });
        cells = []; rings = [];
        for (var i = 0; i < N; i++) buildCell(grid, i);
        gainEl = el('div', { class: 'lgo-gain' }, ['']);
        burstEl = el('div', { class: 'lgo-burst' }, [
          el('div', { class: 'lgo-burst-icon' }, ['✨']),
          el('div', { class: 'lgo-burst-txt neon-strong' }, ['GELÖST'])
        ]);
        var board = el('div', { class: 'lgo-board' }, [grid, burstEl]);

        /* --- Statuszeile: Klicks / Optimum / Gelöst --- */
        clickEl = el('div', { class: 'lgo-sv' }, ['0 / 0']);
        optEl = el('div', { class: 'lgo-sv' }, ['–']);
        solvedEl = el('div', { class: 'lgo-sv' }, ['0']);
        var stats = el('div', { class: 'lgo-stats glass' }, [
          el('div', { class: 'lgo-stat' }, [el('div', { class: 'lgo-sl' }, ['🖱️ Klicks / Par']), clickEl]),
          el('div', { class: 'lgo-stat' }, [el('div', { class: 'lgo-sl' }, ['🎯 Optimum']), optEl]),
          el('div', { class: 'lgo-stat' }, [el('div', { class: 'lgo-sl' }, ['✅ Gelöst']), solvedEl])
        ]);

        /* --- Rangliste (multi) bzw. Rekord-Geist (solo) --- */
        var sidePanel = null;
        if (isMulti) {
          var lb = App.MG.liveBoard(ctx.room, ctx.me.id);
          stops.push(lb.stop);
          sidePanel = el('div', { class: 'lgo-panel glass' }, [
            el('div', { class: 'mg-field-title' }, ['🏆 Rangliste']), lb.root
          ]);
        } else {
          sidePanel = buildPacePanel();
        }

        root.innerHTML = '';
        root.appendChild(el('div', { class: 'lgo-layout' }, [head, rules, board, gainEl, stats, sidePanel]));

        loadPuzzle(1);
        updateHud();

        /* --- Gesamttimer (Wall-Clock → Tab-sicher) --- */
        var lastSec = -1;
        stops.push(App.MG.roundTimer(endAt, function (left) {
          timerEl.textContent = App.MG.mmss(left);
          if (left <= 15) timerEl.classList.add('lgo-urgent');
          var s = Math.ceil(left);
          if (s !== lastSec) {
            lastSec = s;
            if (s <= 5 && s > 0 && App.Audio) App.Audio.sfx('tick');
            if (!isMulti) updatePace(left);
          }
        }, finish, isMulti ? ctx.room.now : null));

        if (isMulti) ctx.room.reportScore(0);
      }

      /* Eine Lampe bauen (pointerdown → Maus + Touch gleich schnell). */
      function buildCell(grid, i) {
        var ring = el('span', { class: 'lgo-ring' });
        var c = el('button', { class: 'lgo-cell', type: 'button', 'aria-label': 'Lampe ' + (i + 1) }, [ring]);
        c.addEventListener('pointerdown', function (e) {
          if (e && e.preventDefault) e.preventDefault();
          onCell(i);
        });
        c._on = false;
        cells.push(c); rings.push(ring); grid.appendChild(c);
      }

      /* Solo: Panel mit Rekord-Geist */
      function buildPacePanel() {
        paceMeEl = el('span', { class: 'lgo-pace-v' }, ['0']);
        paceGhostEl = el('span', { class: 'lgo-pace-v lgo-pace-ghost' }, ['0']);
        paceDiffEl = el('div', { class: 'lgo-pace-diff' }, ['']);
        paceRow = el('div', { class: 'lgo-pace-rows' }, [
          el('div', { class: 'lgo-pace-row lgo-pace-me' }, [
            el('span', { class: 'lgo-pace-n' }, ['🙋 Du']), paceMeEl
          ]),
          el('div', { class: 'lgo-pace-row' }, [
            el('span', { class: 'lgo-pace-n' }, ['👻 Rekord-Geist']), paceGhostEl
          ])
        ]);
        return el('div', { class: 'lgo-panel glass' }, [
          el('div', { class: 'mg-field-title' }, ['👻 Rekordjagd']),
          soloBest > 0 ? paceRow : el('p', { class: 'hint-text lgo-norec' }, ['Noch kein Rekord — leg jetzt einen vor!']),
          soloBest > 0 ? paceDiffEl : null
        ]);
      }

      /* Rekord-Geist: läuft linear im Tempo des Rekords mit. */
      function updatePace(left) {
        if (soloBest <= 0 || !paceMeEl) return;
        var frac = Math.min(1, Math.max(0, (DURATION - left) / DURATION));
        var ghost = Math.round(soloBest * frac);
        paceMeEl.textContent = App.MG.fmt(score);
        paceGhostEl.textContent = App.MG.fmt(ghost);
        var d = score - ghost;
        paceDiffEl.textContent = d >= 0 ? ('+' + App.MG.fmt(d) + ' vor dem Rekord 🔥') : (App.MG.fmt(-d) + ' zurück');
        paceDiffEl.className = 'lgo-pace-diff ' + (d >= 0 ? 'lgo-ahead' : 'lgo-behind');
      }

      /* ---------------- Rätsel laden ---------------- */
      function loadPuzzle(lvl) {
        if (dead || finished) return;
        level = lvl;
        puz = makePuzzle((seed + lvl * 2654435761) >>> 0, scrambleFor(lvl));
        lights = puz.lights;
        clicks = 0;
        puzStartAt = nowFn();
        paintCells(-1, true);
        updateHud();
        if (App.Audio) App.Audio.sfx('deal');
      }

      /* ---------------- Klick auf eine Lampe ---------------- */
      function onCell(i) {
        if (dead || finished || busy || !puz) return;
        lights ^= TOGGLE[i];
        clicks++;
        paintCells(i, false);
        updateHud();
        if (App.Audio) {
          /* Je weniger Lampen brennen, desto höher der Ton → hörbares Feedback. */
          var lit = popcount(lights);
          App.Audio.blip(320 + (N - lit) * 16, 0.05);
        }
        if (lights === 0) solvePuzzle();
      }

      /* Lampen zeichnen; nur geänderte bekommen die Umschalt-Animation. */
      function paintCells(origin, silent) {
        for (var i = 0; i < N; i++) {
          var on = !!(lights & bit(i));
          var c = cells[i];
          if (c._on !== on) {
            c._on = on;
            c.classList.toggle('lgo-on', on);
            if (!silent) {
              c.classList.remove('lgo-flip');
              void c.offsetWidth;              // Animation neu starten
              c.classList.add('lgo-flip');
            }
          }
        }
        if (origin >= 0) {
          var r = rings[origin];
          r.classList.remove('lgo-go');
          void r.offsetWidth;
          r.classList.add('lgo-go');
        }
      }

      function updateHud() {
        if (!puz) return;
        puzEl.textContent = String(level);
        scoreEl.textContent = App.MG.fmt(score);
        clickEl.textContent = clicks + ' / ' + puz.par;
        clickEl.classList.toggle('lgo-overpar', clicks > puz.par);
        clickEl.classList.toggle('lgo-perfect', clicks <= puz.optimum && clicks > 0);
        optEl.textContent = String(puz.optimum);
        solvedEl.textContent = String(solvedCount);
      }

      /* ---------------- Rätsel gelöst ---------------- */
      function solvePuzzle() {
        busy = true;
        solvedCount++;
        var elapsed = Math.max(0, (nowFn() - puzStartAt) / 1000);
        var eff = Math.max(0, puz.par - clicks) * PER_CLICK;
        var speed = Math.max(0, Math.round((targetSec(level) - elapsed) * SPEED_PER_SEC));
        var gained = BASE_POINTS + eff + speed;
        var perfect = clicks <= puz.optimum;
        score += gained;
        if (isMulti) ctx.room.reportScore(score);
        updateHud();
        if (App.Audio) App.Audio.sfx(perfect ? 'jackpot' : 'levelup');

        /* Sichtbare Rückmeldung: Burst über dem Brett + Punkte-Aufschlüsselung */
        burstEl.querySelector('.lgo-burst-icon').textContent = perfect ? '🏆' : '✨';
        burstEl.querySelector('.lgo-burst-txt').textContent = perfect ? 'PERFEKT!' : 'GELÖST';
        burstEl.classList.remove('lgo-go'); void burstEl.offsetWidth; burstEl.classList.add('lgo-go');

        var parts = ['+' + BASE_POINTS];
        if (eff > 0) parts.push('+' + eff + ' Effizienz');
        if (speed > 0) parts.push('+' + speed + ' Tempo');
        gainEl.textContent = parts.join('  ') + '  =  ' + App.MG.fmt(gained);
        gainEl.classList.remove('lgo-go'); void gainEl.offsetWidth; gainEl.classList.add('lgo-go');

        after(850, function () {
          if (dead || finished) return;
          busy = false;
          loadPuzzle(level + 1);
        });
      }

      /* ===================== ENDE ===================== */
      function finish() {
        if (finished || dead) return;
        finished = true;
        busy = true;
        clearPending();
        stopHelpers();
        if (App.Audio) App.Audio.sfx('win');

        if (isMulti) {
          ctx.room.reportScore(score);
          after(1000, function () {
            App.MG.endScreen(root, { players: ctx.room.players(), meId: ctx.me.id, onExit: ctx.onExit });
          });
        } else {
          var best = App.Storage.get('best_lightsout', 0);
          var nb = score > best;
          if (nb) App.Storage.set('best_lightsout', score);
          App.MG.endScreen(root, {
            score: score, best: best, newBest: nb,
            label: solvedCount + ' Rätsel gelöst'
              + (nb ? ' · neuer Rekord! 🎉' : ' · Bestwert: ' + App.MG.fmt(best)),
            onExit: ctx.onExit,
            onAgain: function () { finished = false; play(nowFn()); }
          });
        }
      }
    }
  };

  /* ===================== CSS ===================== */
  function injectStyle() {
    UI.injectStyle('mg-lightsout-css', [
      '.lgo-layout{display:flex;flex-direction:column;gap:12px;max-width:340px;margin:0 auto;}',
      /* Kopfzeile */
      '.lgo-head{display:flex;justify-content:space-between;align-items:center;padding:10px 14px;gap:10px;}',
      '.lgo-hcell{display:flex;flex-direction:column;gap:1px;min-width:0;}',
      '.lgo-hmid{text-align:center;}',
      '.lgo-hright{text-align:right;}',
      '.lgo-hl{color:var(--muted);font-size:10px;text-transform:uppercase;letter-spacing:1px;font-weight:800;}',
      '.lgo-hv{font-size:clamp(20px,6vw,28px);font-weight:900;line-height:1;color:var(--aqua);',
      'text-shadow:0 0 12px rgba(51,230,208,.45);font-variant-numeric:tabular-nums;}',
      '.lgo-hv-gold{color:var(--gold);text-shadow:0 0 12px rgba(255,210,63,.45);}',
      '.lgo-head .mg-timer{font-size:clamp(17px,5vw,24px);}',
      '.mg-timer.lgo-urgent{color:var(--danger);animation:lgo-pulse .7s infinite;}',
      '.lgo-rules{margin:0;text-align:center;font-size:11px;line-height:1.45;}',
      /* Brett */
      '.lgo-board{position:relative;}',
      '.lgo-grid{display:grid;grid-template-columns:repeat(5,1fr);gap:7px;width:100%;touch-action:manipulation;}',
      '.lgo-cell{position:relative;aspect-ratio:1/1;border-radius:13px;padding:0;overflow:hidden;cursor:pointer;',
      'border:2px solid var(--stroke);background:radial-gradient(circle at 50% 36%,#0a2417,#04110a 76%);',
      'user-select:none;-webkit-user-select:none;-webkit-tap-highlight-color:transparent;',
      'transition:transform .1s ease,box-shadow .22s ease,border-color .22s ease,background .22s ease;}',
      '.lgo-cell::after{content:"";position:absolute;left:27%;top:27%;right:27%;bottom:27%;border-radius:50%;',
      'background:rgba(120,200,160,.13);transition:background .22s ease,box-shadow .22s ease;}',
      '.lgo-cell:hover{border-color:var(--stroke-2);transform:translateY(-1px);}',
      '.lgo-cell:active{transform:scale(.94);}',
      /* Lampe AN — Neon-Glow */
      '.lgo-cell.lgo-on{border-color:var(--neon);background:radial-gradient(circle at 50% 34%,#b6ff93,var(--neon) 72%);',
      'box-shadow:0 0 20px rgba(57,255,20,.55),inset 0 0 24px rgba(255,255,255,.28);}',
      '.lgo-cell.lgo-on::after{background:rgba(255,255,255,.8);box-shadow:0 0 16px rgba(255,255,255,.85);}',
      '.lgo-cell.lgo-on:hover{box-shadow:0 0 28px rgba(57,255,20,.75),inset 0 0 24px rgba(255,255,255,.34);}',
      /* Weicher Umschalt-Glow */
      '.lgo-flip{animation:lgo-flip .3s cubic-bezier(.2,.8,.3,1);}',
      '@keyframes lgo-flip{0%{transform:scale(.78)}55%{transform:scale(1.11)}100%{transform:scale(1)}}',
      '.lgo-ring{position:absolute;left:0;top:0;right:0;bottom:0;border-radius:13px;pointer-events:none;',
      'border:2px solid var(--aqua);opacity:0;}',
      '.lgo-ring.lgo-go{animation:lgo-ring .45s ease-out;}',
      '@keyframes lgo-ring{0%{opacity:.95;transform:scale(.55)}100%{opacity:0;transform:scale(1.7)}}',
      /* Gelöst-Burst */
      '.lgo-burst{position:absolute;left:0;top:0;right:0;bottom:0;display:flex;flex-direction:column;gap:4px;',
      'align-items:center;justify-content:center;pointer-events:none;opacity:0;border-radius:16px;}',
      '.lgo-burst.lgo-go{animation:lgo-burst .85s ease-out;}',
      '.lgo-burst-icon{font-size:52px;line-height:1;filter:drop-shadow(0 0 14px rgba(255,210,63,.7));}',
      '.lgo-burst-txt{font-size:24px;font-weight:900;letter-spacing:2px;}',
      '@keyframes lgo-burst{0%{opacity:0;transform:scale(.5)}30%{opacity:1;transform:scale(1.08)}',
      '70%{opacity:1;transform:scale(1)}100%{opacity:0;transform:scale(1.14)}}',
      '.lgo-gain{text-align:center;min-height:18px;font-size:12px;font-weight:800;color:var(--gold);opacity:0;',
      'font-variant-numeric:tabular-nums;}',
      '.lgo-gain.lgo-go{animation:lgo-gain 1.6s ease-out;}',
      '@keyframes lgo-gain{0%{opacity:0;transform:translateY(6px)}18%{opacity:1;transform:translateY(0)}',
      '75%{opacity:1}100%{opacity:0}}',
      /* Statuszeile */
      '.lgo-stats{display:flex;gap:8px;padding:10px 12px;justify-content:space-around;}',
      '.lgo-stat{display:flex;flex-direction:column;align-items:center;gap:2px;min-width:0;}',
      '.lgo-sl{font-size:9px;color:var(--muted);text-transform:uppercase;letter-spacing:.8px;font-weight:800;white-space:nowrap;}',
      '.lgo-sv{font-size:17px;font-weight:900;color:var(--leaf);font-variant-numeric:tabular-nums;line-height:1.1;transition:color .2s;}',
      '.lgo-sv.lgo-overpar{color:var(--danger);}',
      '.lgo-sv.lgo-perfect{color:var(--gold);text-shadow:0 0 10px rgba(255,210,63,.5);}',
      /* Seiten-Panel (Rangliste / Rekord-Geist) */
      '.lgo-panel{padding:12px;display:flex;flex-direction:column;gap:8px;}',
      '.lgo-panel .mg-scoreboard{max-height:260px;overflow-y:auto;}',
      '.lgo-norec{margin:0;text-align:center;font-size:12px;}',
      '.lgo-pace-rows{display:flex;flex-direction:column;gap:6px;}',
      '.lgo-pace-row{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:7px 10px;',
      'border-radius:10px;background:rgba(9,32,21,.55);border:1px solid var(--stroke);}',
      '.lgo-pace-row.lgo-pace-me{border-color:var(--stroke-2);}',
      '.lgo-pace-n{font-size:12px;font-weight:800;color:var(--muted);}',
      '.lgo-pace-me .lgo-pace-n{color:var(--aqua);}',
      '.lgo-pace-v{font-size:18px;font-weight:900;color:var(--neon);font-variant-numeric:tabular-nums;}',
      '.lgo-pace-v.lgo-pace-ghost{color:var(--silver);}',
      '.lgo-pace-diff{text-align:center;font-size:12px;font-weight:800;min-height:16px;}',
      '.lgo-pace-diff.lgo-ahead{color:var(--neon);text-shadow:0 0 10px rgba(57,255,20,.4);}',
      '.lgo-pace-diff.lgo-behind{color:var(--bronze);}',
      /* Warte-Ansicht */
      '.lgo-wait{padding:40px 24px;text-align:center;display:flex;flex-direction:column;gap:10px;',
      'align-items:center;max-width:340px;margin:0 auto;}',
      '.lgo-wait-icon{font-size:52px;animation:lgo-blink 1.4s ease-in-out infinite;}',
      '@keyframes lgo-blink{0%,100%{opacity:.35;filter:drop-shadow(0 0 4px rgba(57,255,20,.2))}',
      '50%{opacity:1;filter:drop-shadow(0 0 18px rgba(57,255,20,.8))}}',
      '@keyframes lgo-pulse{0%,100%{opacity:1}50%{opacity:.4}}'
    ].join(''));
  }
})();
