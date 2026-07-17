/* pianotiles.js — "Takt-Tap": Piano-Tiles im Neon-Dschungel-Look.
 *
 *  IDEE      4 Spalten, dunkle Kacheln fallen von oben herab. Jede Kachel muss
 *            GENAU dann getippt werden, wenn ihre Mitte in der Leuchtzone unten
 *            (goldene Linie) liegt. Leere Spalte tippen oder eine Kachel durch-
 *            rutschen lassen = Fehler. Nach 3 Fehlern ist Schluss. Das Tempo
 *            (Fallgeschwindigkeit + Kachel-Dichte) steigt mit der Zeit.
 *
 *  STEUERUNG Direkt auf die jeweilige Spalte tippen/klicken (Touch + Maus) oder
 *            per Tastatur D F J K (bzw. 1 2 3 4). Voll Multitouch-fähig.
 *
 *  PUNKTE    Perfekt (Mitte in der goldenen Zone) = 100, Gut = 50 Punkte, jeweils
 *            mal Combo-Multiplikator (×1 … ×8, alle 8 Treffer eine Stufe höher).
 *            Ein Fehler setzt die Combo auf 0. Zu jeder getroffenen Kachel klingt
 *            ein Ton einer kurzen, im File erzeugten Pentatonik-Melodie.
 *
 *  SYNC      SOLO  : endlos bis 3 Fehler, Punktejagd gegen best_pianotiles. Ein
 *                    Live-"Neuer Rekord"-Banner, sobald der eigene Bestwert fällt.
 *            MULTI : alle spielen 90 s dieselbe Kachel-Sequenz. Der Seed ergibt
 *                    sich deterministisch aus der geteilten Startzeit (room.now /
 *                    snapshot.round.startAt) -> identische Kacheln für alle, ohne
 *                    Extra-Sync. Jeder wertet seine Taps lokal, meldet nur seine
 *                    Punkte (reportScore) -> Live-Rangliste + Podest am Ende.
 *                    Wer vor Ablauf 3 Fehler macht, scheidet aus und wartet.
 *
 *  Alle Timer/Positionen laufen über Wall-Clock (Date.now bzw. room.now) und
 *  sind damit Tab-Wechsel-sicher. cleanup() beendet rAF, Timer und Listener. */
(function () {
  'use strict';
  window.App = window.App || {}; App.Minigames = App.Minigames || {};
  var UI = App.UI, el = UI.el;

  injectStyle();

  /* ---------- feste (virtuelle) Spielfeld-Maße; Canvas skaliert per CSS ---------- */
  var COLS = 4;
  var VW = 480, VH = 620;
  var COLW = VW / COLS;            // 120
  var HITY = 520;                  // y der Treffer-Linie (Zonenmitte)
  var REACH_UP = 170;              // wie weit oberhalb der Linie eine Kachel tippbar ist
  var REACH_DOWN = 64;             // Nachsicht unterhalb der Linie
  var MISSLINE = HITY + REACH_DOWN;
  var PERFECT_ERR = 34;            // Abstand zur Linie für "Perfekt"
  var TH = 124;                    // Kachelhöhe

  /* Fallgeschwindigkeit v(A) in px/s abhängig von der Ankunftszeit A (steigt) */
  var V_BASE = 340, V_RAMP = 3.0, V_ADD_MAX = 320;
  /* Ankunfts-Fahrplan: erster Ton nach 2,2 s, Abstand schrumpft 0,60 -> 0,30 s */
  var FIRST_ARRIVAL = 2.2, INT_START = 0.60, INT_END = 0.30, RAMP_SECONDS = 80;

  var TAP_LOCK = 70;               // ms Sperre pro Spalte gegen Doppel-Feuer
  var MULTI_SECONDS = 90;

  var ACCENT = ['#39ff14', '#33e6d0', '#ffd23f', '#9dff7a'];
  var GLOW   = ['rgba(57,255,20,', 'rgba(51,230,208,', 'rgba(255,210,63,', 'rgba(157,255,122,'];
  var KEYS_LABEL = ['D', 'F', 'J', 'K'];
  var FONT = '"Segoe UI",system-ui,Roboto,Arial,sans-serif';

  /* kleine Pentatonik-Melodie (Hz) — ein Ton pro Kachel, wiederholt sich */
  var NOTES = [261.63, 293.66, 329.63, 392.00, 440.00, 523.25, 587.33, 659.25, 523.25, 440.00, 392.00, 329.63];

  /* deterministischer RNG (mulberry32) */
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* Kachel-Fahrplan (lazy erweiterbar für den endlosen Solo-Modus).
     Parallele Arrays: A=Ankunftszeit(s), C=Spalte, N=Note(Hz), J=schon gewertet? */
  function newSchedule(seed) {
    var rng = mulberry32(seed >>> 0);
    var A = [], C = [], N = [], J = [];
    var t = FIRST_ARRIVAL, idx = 0, prev = -1;
    function ensure(upTo) {
      while (t <= upTo) {
        var col = Math.floor(rng() * 4); if (col > 3) col = 3;
        if (col === prev) col = (col + 1 + Math.floor(rng() * 3)) % 4;  // nie zweimal dieselbe Spalte
        prev = col;
        A.push(t); C.push(col); N.push(NOTES[idx % NOTES.length]); J.push(false);
        var prog = t / RAMP_SECONDS; if (prog > 1) prog = 1;
        t += INT_START - (INT_START - INT_END) * prog;
        idx++;
      }
    }
    return { A: A, C: C, N: N, J: J, ensure: ensure };
  }

  function vAt(A) { return V_BASE + Math.min(V_ADD_MAX, A * V_RAMP); }

  function roundRect(g, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
  }

  App.Minigames.pianotiles = {
    id: 'pianotiles', title: 'Takt-Tap', icon: '🎹', order: 141,
    subtitle: 'Triff die Kacheln im Takt – Combo-Jagd!',
    single: true, multi: true, minPlayers: 2, maxPlayers: 8,

    render: function (root, ctx) {
      var isMulti = ctx.mode === 'multi';
      var nowFn = isMulti ? ctx.room.now : function () { return Date.now(); };

      /* Laufzeit */
      var dead = false, ended = false, finished = false, eliminated = false;
      var raf = null;
      var stops = [];            // stop()-Funktionen (Countdown, Board, Timer)
      var pending = [];          // setTimeout-IDs
      var listeners = [];        // {t,ty,fn,opts}

      /* Spielzustand */
      var startAt = 0, sch = null, lo = 0;
      var score = 0, combo = 0, misses = 0, perfects = 0;
      var best = 0, recordAt = 0, recordBeaten = false, lastReport = 0;
      var lastTap = [0, 0, 0, 0], presses = [0, 0, 0, 0], flashes = [];

      /* DOM */
      var scoreEl, comboEl, multEl, timerEl, bestEl, livesEl, canvas, stageEl, g2d;

      function after(ms, fn) { var t = setTimeout(function () { if (!dead) fn(); }, ms); pending.push(t); return t; }
      function clearPending() { pending.forEach(clearTimeout); pending = []; }
      function stopHelpers() { stops.forEach(function (f) { try { f(); } catch (e) {} }); stops = []; }
      function addL(target, type, fn, opts) { target.addEventListener(type, fn, opts); listeners.push({ t: target, ty: type, fn: fn, opts: opts }); }
      function removeListeners() { listeners.forEach(function (l) { try { l.t.removeEventListener(l.ty, l.fn, l.opts); } catch (e) {} }); listeners = []; }
      function cleanup() {
        dead = true; ended = true;
        if (raf) { cancelAnimationFrame(raf); raf = null; }
        clearPending(); stopHelpers(); removeListeners();
      }

      /* ---------- Start (Multi wie in reflex.js: Countdown aus startAt) ---------- */
      if (isMulti) {
        var snap = ctx.room.snapshot() || {};
        var startMs = (snap.round && snap.round.startAt) || (ctx.room.now() + 3000);
        stops.push(App.MG.countdown(root, startMs, function () { play(startMs); }, ctx.room.now));
      } else {
        play(nowFn());
      }
      return { cleanup: cleanup };

      /* ============================ SPIEL ============================ */
      function play(startTime) {
        clearPending(); stopHelpers(); removeListeners();
        startAt = startTime;
        score = 0; combo = 0; misses = 0; perfects = 0; lo = 0;
        ended = false; finished = false; eliminated = false;
        recordAt = 0; recordBeaten = false; lastReport = 0;
        lastTap = [0, 0, 0, 0]; presses = [0, 0, 0, 0]; flashes = [];

        best = isMulti ? 0 : App.Storage.get('best_pianotiles', 0);
        var seed = isMulti
          ? (startAt >>> 0)
          : (((Date.now() >>> 0) ^ (Math.floor(Math.random() * 0xffffffff) >>> 0)) >>> 0);
        sch = newSchedule(seed);
        if (isMulti) sch.ensure(MULTI_SECONDS + 8);

        buildLayout();
        attachInput();

        if (isMulti) {
          ctx.room.reportScore(0);
          var endAt = startAt + MULTI_SECONDS * 1000;
          stops.push(App.MG.roundTimer(endAt, function (left) {
            timerEl.textContent = App.MG.mmss(left);
            if (left <= 10) timerEl.classList.add('pia-urgent');
          }, finish, ctx.room.now));
        }

        updateHud();
        raf = requestAnimationFrame(frame);
      }

      /* ---------- Fallposition einer Kachel zur (elapsed=e) Sekunde ---------- */
      function yOf(i, e) { return HITY + vAt(sch.A[i]) * (e - sch.A[i]); }

      /* ---------- Frame-Loop (Positionen rein aus Wall-Clock-Elapsed) ---------- */
      function frame() {
        if (dead || ended) { raf = null; return; }
        var now = nowFn();
        var e = (now - startAt) / 1000;
        if (!isMulti) sch.ensure(e + 4);          // im Solo laufend nachfüllen

        while (lo < sch.A.length && (sch.J[lo] || yOf(lo, e) > VH + TH)) lo++;

        var draw = [];
        for (var i = lo; i < sch.A.length; i++) {
          var y = yOf(i, e);
          if (y < -TH) break;                     // ab hier alles oberhalb des Bildes
          if (sch.J[i]) continue;
          if (y > MISSLINE) { registerMiss(i, now); if (ended) break; continue; }
          draw.push({ col: sch.C[i], y: y, zone: (y >= HITY - REACH_UP) });
        }
        if (dead || ended) { raf = null; return; }

        render(draw, e, now);
        raf = requestAnimationFrame(frame);
      }

      /* ---------- Eingabe ---------- */
      function colFromX(clientX) {
        var r = canvas.getBoundingClientRect();
        var xr = (clientX - r.left) / r.width * VW;
        var c = Math.floor(xr / COLW);
        return c < 0 ? 0 : c > 3 ? 3 : c;
      }
      function attachInput() {
        var onPointer = function (ev) {
          if (ev.preventDefault) ev.preventDefault();
          tapColumn(colFromX(ev.clientX), nowFn());
        };
        addL(canvas, 'pointerdown', onPointer, { passive: false });
        var map = { d: 0, f: 1, j: 2, k: 3, '1': 0, '2': 1, '3': 2, '4': 3 };
        var onKey = function (ev) {
          if (ev.repeat) return;
          var c = map[(ev.key || '').toLowerCase()];
          if (c === undefined) return;
          ev.preventDefault();
          tapColumn(c, nowFn());
        };
        addL(document, 'keydown', onKey);
      }

      function tapColumn(col, now) {
        if (dead || ended || eliminated) return;
        if (now - lastTap[col] < TAP_LOCK) return;
        lastTap[col] = now;
        presses[col] = now;
        var e = (now - startAt) / 1000;

        var target = -1;
        for (var i = lo; i < sch.A.length; i++) {
          var y = yOf(i, e);
          if (y < -TH) break;
          if (sch.J[i]) continue;
          if (sch.C[i] !== col) continue;
          target = i; break;                      // unterste noch offene Kachel dieser Spalte
        }
        if (target < 0) { penalize(col, now, 'DANEBEN'); return; }
        var ty = yOf(target, e);
        if (ty > MISSLINE) { registerMiss(target, now); return; }   // gerade durchgerutscht: die Kachel verbrauchen (kein Doppel-Fehler)
        if (ty < HITY - REACH_UP) { penalize(col, now, 'ZU FRÜH'); return; }
        hitTile(target, ty, now);
      }

      function hitTile(i, ty, now) {
        sch.J[i] = true;
        var perfect = Math.abs(ty - HITY) <= PERFECT_ERR;
        combo++;
        var mult = comboMult();
        var pts = (perfect ? 100 : 50) * mult;
        score += pts;
        if (perfect) perfects++;
        addFlash(sch.C[i], perfect ? 'PERFEKT' : 'GUT', perfect ? '#ffd23f' : '#7ff3e6', now, '+' + pts);
        if (App.Audio) {
          App.Audio.blip(sch.N[i], perfect ? 0.16 : 0.13, { type: 'triangle', peak: perfect ? 0.14 : 0.10 });
          if (perfect) App.Audio.blip(sch.N[i] * 2, 0.10, { type: 'sine', peak: 0.06 });
        }
        if (combo % 10 === 0 && App.Audio) App.Audio.sfx('powerup');
        updateHud();
        maybeRecord(now);
        reportMaybe(now);
      }

      function penalize(col, now, txt) {
        combo = 0;
        misses++;
        addFlash(col, txt || 'DANEBEN', '#ff8098', now, null);
        if (App.Audio) App.Audio.sfx('error');
        updateHud();
        reportMaybe(now);
        if (misses >= 3) gameOver(now);
      }
      function registerMiss(i, now) { if (sch.J[i]) return; sch.J[i] = true; penalize(sch.C[i], now, 'VERPASST'); }

      function comboMult() { return Math.min(8, 1 + Math.floor(combo / 8)); }
      function maybeRecord(now) {
        if (isMulti || recordBeaten || best <= 0) return;
        if (score > best) { recordBeaten = true; recordAt = now; if (App.Audio) App.Audio.sfx('levelup'); }
      }
      function reportMaybe(now) {
        if (!isMulti) return;
        if (now - lastReport >= 140) { lastReport = now; try { ctx.room.reportScore(score); } catch (e) {} }
      }

      function addFlash(col, txt, color, now, extra) {
        flashes.push({ col: col, txt: txt, color: color, t0: now, extra: extra || null });
        if (flashes.length > 24) flashes.shift();
      }

      /* ---------- HUD ---------- */
      function updateHud() {
        scoreEl.textContent = App.MG.fmt(score);
        comboEl.textContent = String(combo);
        multEl.textContent = '×' + comboMult();
        comboEl.classList.remove('pia-bump'); void comboEl.offsetWidth; comboEl.classList.add('pia-bump');
        renderLives();
      }
      function renderLives() {
        livesEl.innerHTML = '';
        var alive = 3 - misses;
        for (var i = 0; i < 3; i++) {
          livesEl.appendChild(el('span', { class: 'pia-heart' + (i < alive ? '' : ' dead') }, [i < alive ? '♥' : '🖤']));
        }
      }

      /* ---------- Rendering ---------- */
      function render(draw, e, now) {
        var g = g2d; if (!g) return;
        g.clearRect(0, 0, VW, VH);

        var bg = g.createLinearGradient(0, 0, 0, VH);
        bg.addColorStop(0, '#06180e'); bg.addColorStop(1, '#020c07');
        g.fillStyle = bg; g.fillRect(0, 0, VW, VH);

        /* Spalten-Trennlinien */
        g.save(); g.strokeStyle = 'rgba(57,255,20,0.13)'; g.lineWidth = 2;
        for (var c = 1; c < COLS; c++) { g.beginPath(); g.moveTo(c * COLW, 0); g.lineTo(c * COLW, VH); g.stroke(); }
        g.restore();

        /* Tipp-Fenster (dezent) + Perfekt-Band + goldene Treffer-Linie */
        g.save();
        g.fillStyle = 'rgba(57,255,20,0.05)'; g.fillRect(0, HITY - REACH_UP, VW, REACH_UP + REACH_DOWN);
        g.fillStyle = 'rgba(255,210,63,0.10)'; g.fillRect(0, HITY - PERFECT_ERR, VW, PERFECT_ERR * 2);
        g.strokeStyle = 'rgba(255,210,63,0.92)'; g.lineWidth = 3;
        g.shadowColor = 'rgba(255,210,63,0.7)'; g.shadowBlur = 16;
        g.beginPath(); g.moveTo(0, HITY); g.lineTo(VW, HITY); g.stroke();
        g.restore();

        /* Kacheln */
        for (var d = 0; d < draw.length; d++) drawTile(g, draw[d].col, draw[d].y, draw[d].zone);

        /* Druck-Feedback pro Spalte (heller Balken unten) */
        for (c = 0; c < COLS; c++) {
          var pt = presses[c]; if (!pt) continue;
          var a = 1 - (now - pt) / 180; if (a <= 0) continue;
          var pg = g.createLinearGradient(0, VH, 0, VH - 130);
          pg.addColorStop(0, ACCENT[c]); pg.addColorStop(1, 'rgba(0,0,0,0)');
          g.save(); g.globalAlpha = a * 0.55; g.fillStyle = pg; g.fillRect(c * COLW, VH - 130, COLW, 130); g.restore();
        }

        /* Tasten-Hinweise unten */
        g.save(); g.font = '800 20px ' + FONT; g.textAlign = 'center'; g.textBaseline = 'alphabetic';
        g.fillStyle = 'rgba(157,255,122,0.32)';
        for (c = 0; c < COLS; c++) g.fillText(KEYS_LABEL[c], c * COLW + COLW / 2, VH - 14);
        g.restore();

        /* Wertungs-Flashes (steigen auf, blenden aus) */
        for (var f = 0; f < flashes.length; f++) {
          var fl = flashes[f], k = (now - fl.t0) / 650; if (k < 0) k = 0; if (k > 1) continue;
          var fy = HITY - 34 - 74 * k, cx = fl.col * COLW + COLW / 2;
          g.save(); g.globalAlpha = 1 - k; g.textAlign = 'center';
          g.shadowColor = fl.color; g.shadowBlur = 12; g.fillStyle = fl.color;
          g.font = '900 23px ' + FONT; g.fillText(fl.txt, cx, fy);
          if (fl.extra) { g.font = '800 15px ' + FONT; g.fillText(fl.extra, cx, fy + 21); }
          g.restore();
        }
        flashes = flashes.filter(function (x) { return now - x.t0 < 650; });

        /* Solo: "Neuer Rekord"-Banner */
        if (!isMulti && recordAt && now - recordAt < 1600) {
          var rk = (now - recordAt) / 1600;
          var ra = rk < 0.15 ? rk / 0.15 : (1 - (rk - 0.15) / 0.85);
          g.save(); g.globalAlpha = Math.max(0, ra); g.textAlign = 'center';
          g.fillStyle = '#ffd23f'; g.shadowColor = 'rgba(255,210,63,0.85)'; g.shadowBlur = 22;
          g.font = '900 30px ' + FONT; g.fillText('★ NEUER REKORD ★', VW / 2, VH * 0.32);
          g.restore();
        }
      }

      function drawTile(g, col, y, zone) {
        var x = col * COLW + 7, w = COLW - 14, top = y - TH / 2;
        roundRect(g, x, top, w, TH, 16);
        var lg = g.createLinearGradient(0, top, 0, top + TH);
        lg.addColorStop(0, '#0d3a24'); lg.addColorStop(1, '#04170d');
        g.fillStyle = lg; g.fill();
        g.save();
        g.lineWidth = zone ? 3 : 2; g.strokeStyle = ACCENT[col];
        g.shadowColor = GLOW[col] + (zone ? '0.85)' : '0.35)'); g.shadowBlur = zone ? 22 : 10;
        g.stroke(); g.restore();
        /* Glanz oben */
        g.save(); g.globalAlpha = 0.22; g.fillStyle = ACCENT[col];
        roundRect(g, x + 9, top + 9, w - 18, 9, 5); g.fill(); g.restore();
      }

      /* ---------- Layout ---------- */
      function buildLayout() {
        scoreEl = el('div', { class: 'pia-score' }, ['0']);
        comboEl = el('div', { class: 'pia-combo' }, ['0']);
        multEl = el('div', { class: 'pia-mult' }, ['×1']);
        var thirdLabel, thirdVal;
        if (isMulti) {
          timerEl = el('div', { class: 'mg-timer pia-time' }, [App.MG.mmss(MULTI_SECONDS)]);
          thirdLabel = 'Zeit'; thirdVal = timerEl;
        } else {
          bestEl = el('div', { class: 'pia-best' }, [best > 0 ? App.MG.fmt(best) : '—']);
          thirdLabel = 'Rekord'; thirdVal = bestEl;
        }
        var head = el('div', { class: 'pia-head glass' }, [
          el('div', { class: 'pia-cell' }, [el('span', { class: 'pia-lab' }, ['Punkte']), scoreEl]),
          el('div', { class: 'pia-cell pia-cell-mid' }, [
            el('span', { class: 'pia-lab' }, ['Combo']),
            el('div', { class: 'pia-comborow' }, [comboEl, multEl])
          ]),
          el('div', { class: 'pia-cell pia-cell-r' }, [el('span', { class: 'pia-lab' }, [thirdLabel]), thirdVal])
        ]);

        livesEl = el('div', { class: 'pia-lives' });

        canvas = el('canvas', { class: 'pia-canvas', width: VW, height: VH });
        stageEl = el('div', { class: 'pia-stage' }, [canvas]);
        g2d = canvas.getContext('2d');

        var hint = el('div', { class: 'pia-hint hint-text' },
          ['🎹 Kachel in der goldenen Zone tippen (Spalte antippen · D F J K) · perfekt = Combo-Bonus · 3 Fehler = Aus']);

        var kids = [head, livesEl, stageEl, hint];

        if (isMulti) {
          var board = App.MG.liveBoard(ctx.room, ctx.me.id);
          stops.push(board.stop);
          kids.push(el('div', { class: 'pia-board-wrap glass' }, [
            el('div', { class: 'mg-field-title' }, ['🏆 Rangliste']), board.root
          ]));
        }

        root.innerHTML = '';
        root.appendChild(el('div', { class: 'pia-wrap' }, kids));
        renderLives();
      }

      /* ---------- Ende ---------- */
      function gameOver(now) {
        if (ended || dead) return;
        ended = true;
        if (raf) { cancelAnimationFrame(raf); raf = null; }
        if (App.Audio) App.Audio.sfx('lose');

        if (isMulti) {
          eliminated = true;
          ctx.room.reportScore(score);
          if (stageEl) {
            stageEl.appendChild(el('div', { class: 'pia-elim' }, [
              el('div', { class: 'pia-elim-emoji' }, ['💥']),
              el('h3', { class: 'pia-elim-h' }, ['Ausgeschieden!']),
              el('div', { class: 'pia-elim-score' }, [App.MG.fmt(score) + ' Punkte']),
              el('p', { class: 'hint-text' }, ['Warte auf die anderen …'])
            ]));
          }
        } else {
          showEndSolo();
        }
      }

      function finish() {
        if (finished || dead) return;
        finished = true; ended = true;
        if (raf) { cancelAnimationFrame(raf); raf = null; }
        clearPending();
        try { ctx.room.reportScore(score); } catch (e) {}
        after(900, function () {
          App.MG.endScreen(root, { players: ctx.room.players(), meId: ctx.me.id, onExit: ctx.onExit });
        });
      }

      function showEndSolo() {
        var nb = score > best;
        if (nb) App.Storage.set('best_pianotiles', score);
        App.MG.endScreen(root, {
          score: score, best: best, newBest: nb,
          label: 'Takt-Punkte · ' + perfects + ' perfekte Treffer' + (nb ? ' · neuer Rekord! 🎉' : ' · Bestwert: ' + App.MG.fmt(best)),
          onExit: ctx.onExit,
          onAgain: function () { play(nowFn()); }
        });
      }
    }
  };

  /* ============================ STYLES ============================ */
  function injectStyle() {
    UI.injectStyle('mg-pianotiles-css', [
      '.pia-wrap{display:flex;flex-direction:column;gap:11px;max-width:420px;margin:0 auto;}',
      '.pia-head{display:flex;justify-content:space-between;align-items:center;padding:10px 16px;gap:10px;}',
      '.pia-cell{display:flex;flex-direction:column;gap:2px;min-width:0;}',
      '.pia-cell-mid{text-align:center;align-items:center;}',
      '.pia-cell-r{text-align:right;align-items:flex-end;}',
      '.pia-lab{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:1px;font-weight:800;}',
      '.pia-score{font-size:clamp(24px,6.4vw,38px);font-weight:900;color:var(--gold);text-shadow:0 0 12px rgba(255,210,63,.45);line-height:1;font-variant-numeric:tabular-nums;}',
      '.pia-comborow{display:flex;align-items:baseline;gap:6px;}',
      '.pia-combo{font-size:clamp(22px,5.8vw,34px);font-weight:900;color:var(--neon);text-shadow:0 0 12px rgba(57,255,20,.5);line-height:1;font-variant-numeric:tabular-nums;}',
      '.pia-mult{font-size:clamp(13px,3.4vw,17px);font-weight:900;color:var(--aqua);text-shadow:0 0 8px rgba(51,230,208,.5);}',
      '.pia-best{font-size:clamp(20px,5.4vw,30px);font-weight:900;color:var(--leaf);line-height:1;font-variant-numeric:tabular-nums;}',
      '.pia-time{font-size:clamp(20px,5.4vw,30px);}',
      '.pia-time.pia-urgent{color:var(--danger-2);animation:pia-pulse .7s infinite;}',
      '.pia-bump{animation:pia-bump .28s ease;}',
      '.pia-lives{display:flex;justify-content:center;gap:8px;font-size:20px;line-height:1;}',
      '.pia-heart{color:var(--danger);text-shadow:0 0 10px rgba(255,77,109,.55);transition:transform .15s;}',
      '.pia-heart.dead{filter:grayscale(1);opacity:.55;text-shadow:none;}',
      '.pia-stage{position:relative;width:100%;max-width:380px;margin:0 auto;aspect-ratio:480 / 620;}',
      '.pia-canvas{display:block;width:100%;height:100%;border-radius:16px;border:2px solid rgba(57,255,20,.35);',
      'background:#04140c;box-shadow:0 0 40px rgba(57,255,20,.2),inset 0 0 60px rgba(57,255,20,.06);',
      'touch-action:none;user-select:none;-webkit-user-select:none;-webkit-tap-highlight-color:transparent;cursor:pointer;}',
      '.pia-hint{text-align:center;}',
      '.pia-board-wrap{padding:12px 14px;display:flex;flex-direction:column;gap:8px;}',
      '.pia-board-wrap .mg-scoreboard{max-height:240px;overflow-y:auto;}',
      /* Ausschied-Overlay im Multiplayer */
      '.pia-elim{position:absolute;inset:0;border-radius:16px;background:radial-gradient(circle at 50% 40%,rgba(11,10,10,.86),rgba(4,12,7,.94));',
      'display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;text-align:center;padding:20px;animation:pia-fade .3s ease both;}',
      '.pia-elim-emoji{font-size:52px;filter:drop-shadow(0 0 14px rgba(255,77,109,.5));}',
      '.pia-elim-h{margin:0;color:var(--danger);text-shadow:0 0 12px rgba(255,77,109,.5);font-size:24px;}',
      '.pia-elim-score{font-size:26px;font-weight:900;color:var(--gold);font-variant-numeric:tabular-nums;}',
      /* Animationen */
      '@keyframes pia-bump{0%{transform:scale(1)}40%{transform:scale(1.22)}100%{transform:scale(1)}}',
      '@keyframes pia-pulse{0%,100%{opacity:1}50%{opacity:.4}}',
      '@keyframes pia-fade{from{opacity:0}to{opacity:1}}'
    ].join(''));
  }
})();
