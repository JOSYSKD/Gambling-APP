/* slot-engine.js — gemeinsame Basis für alle Themen-Slotmaschinen.
 *
 * Ein Theme (siehe slot-themes.js) beschreibt nur noch Symbole, Gewichte,
 * Auszahlungen, Farben und welches Sonderfeature es hat. Diese Datei macht
 * daraus ein fertiges Spiel für App.Games — inklusive Walzen-Animation,
 * Linienauswertung, Freispielen, Cascades, Sticky-Wilds und Pick-Bonus.
 *
 * Die Mathematik (spinGrid/evalGrid) ist bewusst DOM-frei und wird über
 * App.SlotEngine.math exportiert: so lässt sich der RTP eines Themes mit einem
 * Node-Skript nachrechnen, ohne den Browser zu starten (tools/slot-rtp.js).
 *
 * Einsatz-Konvention: der Gesamteinsatz verteilt sich gleichmäßig auf alle
 * Gewinnlinien (betPerLine = bet / lines.length). Linien-Auszahlungen in der
 * Paytable gelten je Linie, Scatter-Auszahlungen auf den Gesamteinsatz.
 */
(function () {
  'use strict';
  window.App = window.App || {};
  App.Games = App.Games || {};

  /* ---------- Gewinnlinien ----------
   * Eine Linie ist ein Array mit der Reihen-Nummer je Walze (0 = oben). */
  var LINES_3x3 = [
    [1, 1, 1], [0, 0, 0], [2, 2, 2], [0, 1, 2], [2, 1, 0]
  ];
  var LINES_5x3 = [
    [1, 1, 1, 1, 1], [0, 0, 0, 0, 0], [2, 2, 2, 2, 2],
    [0, 1, 2, 1, 0], [2, 1, 0, 1, 2],
    [0, 0, 1, 0, 0], [2, 2, 1, 2, 2],
    [1, 0, 0, 0, 1], [1, 2, 2, 2, 1],
    [0, 1, 1, 1, 0]
  ];

  /* ================= Mathematik (DOM-frei) ================= */

  /* Gewichtete Ziehung eines Symbols. rnd() darf injiziert werden, damit die
   * RTP-Simulation mit einem eigenen Generator laufen kann. */
  function drawSymbol(theme, rnd) {
    var r = rnd() * theme._totalWeight;
    for (var i = 0; i < theme.symbols.length; i++) {
      r -= theme.symbols[i].weight;
      if (r < 0) return theme.symbols[i].id;
    }
    return theme.symbols[theme.symbols.length - 1].id;
  }

  /* Komplettes Walzenbild: grid[reel][row] */
  function spinGrid(theme, rnd) {
    rnd = rnd || Math.random;
    var grid = [];
    for (var r = 0; r < theme.reels; r++) {
      var col = [];
      for (var y = 0; y < theme.rows; y++) col.push(drawSymbol(theme, rnd));
      grid.push(col);
    }
    return grid;
  }

  function symbolOf(theme, id) { return theme._byId[id]; }

  /* Auswertung eines Bildes.
   * opts.expand: Symbol-ID, die (Ägypten-Freispiele) über die ganze Walze
   *              expandiert und dann unabhängig von der Position zahlt.
   * opts.globalMult: fester Multiplikator auf alle Liniengewinne (Cascades). */
  function evalGrid(theme, grid, bet, opts) {
    opts = opts || {};
    var lines = theme._lines;
    var perLine = bet / lines.length;
    var wild = theme.wild || null;
    var scatter = theme.scatter ? theme.scatter.id : null;
    var out = { lineWins: [], scatterCount: 0, scatterWin: 0, total: 0, wildHits: 0 };

    /* --- Scatter: zählt überall im Bild, unabhängig von Linien --- */
    if (scatter) {
      for (var r = 0; r < theme.reels; r++) {
        for (var y = 0; y < theme.rows; y++) if (grid[r][y] === scatter) out.scatterCount++;
      }
      var spay = theme.scatter.pay && theme.scatter.pay[out.scatterCount];
      if (spay) out.scatterWin = Math.round(bet * spay);
    }

    /* --- Expanding-Symbol (Freispiel-Feature): zahlt je Walze, egal wo --- */
    if (opts.expand) {
      var reelsWith = [];
      for (var er = 0; er < theme.reels; er++) {
        for (var ey = 0; ey < theme.rows; ey++) {
          if (grid[er][ey] === opts.expand || (wild && grid[er][ey] === wild)) { reelsWith.push(er); break; }
        }
      }
      // Nur zusammenhängend von links zählt (wie bei Linien).
      var run = 0;
      while (run < reelsWith.length && reelsWith[run] === run) run++;
      var sym = symbolOf(theme, opts.expand);
      var pay = sym && sym.pay ? sym.pay[run] : 0;
      if (pay) {
        // Expandiert = füllt alle Reihen -> zahlt für jede Linie durch diese Walzen.
        var amount = Math.round(perLine * pay * theme.rows);
        out.lineWins.push({ line: -1, sym: opts.expand, count: run, amount: amount, expanded: true, reels: run });
        out.total += amount;
      }
      out.total += out.scatterWin;
      return out;
    }

    /* --- Linien von links --- */
    for (var li = 0; li < lines.length; li++) {
      var line = lines[li];
      var first = null;
      // Basissymbol = erstes Nicht-Wild (alles Wild -> Wild selbst)
      for (var k = 0; k < theme.reels; k++) {
        var s = grid[k][line[k]];
        if (s === scatter) break;
        if (wild && s === wild) continue;
        first = s; break;
      }
      if (first === null && wild) first = wild;
      if (first === null || first === scatter) continue;

      var count = 0, wilds = 0;
      for (var c = 0; c < theme.reels; c++) {
        var cur = grid[c][line[c]];
        if (cur === first) { count++; }
        else if (wild && cur === wild) { count++; wilds++; }
        else break;
      }
      var symDef = symbolOf(theme, first);
      var mult = symDef && symDef.pay ? (symDef.pay[count] || 0) : 0;
      if (!mult) continue;

      var m = 1;
      // Wild-Multiplikator-Feature: jedes beteiligte Wild verdoppelt (o. ä.).
      if (theme.wildMult && wilds > 0 && first !== wild) m = Math.pow(theme.wildMult, Math.min(wilds, 2));
      if (opts.globalMult) m *= opts.globalMult;

      var amt = Math.round(perLine * mult * m);
      if (amt <= 0) continue;
      out.wildHits += wilds;
      out.lineWins.push({ line: li, sym: first, count: count, amount: amt, mult: m, positions: line.slice(0, count) });
      out.total += amt;
    }

    out.total += out.scatterWin;
    return out;
  }

  /* Theme einmalig vorbereiten (Gewichtssumme, Index, Linien). */
  function prepare(theme) {
    if (theme._ready) return theme;
    theme.rows = theme.rows || 3;
    theme._lines = theme.lines || (theme.reels === 3 ? LINES_3x3 : LINES_5x3);
    theme._totalWeight = 0;
    theme._byId = {};
    theme.symbols.forEach(function (s) {
      theme._totalWeight += s.weight;
      theme._byId[s.id] = s;
    });
    theme._ready = true;
    return theme;
  }

  /* ================= Darstellung ================= */

  function create(theme) {
    prepare(theme);

    return {
      id: theme.id, title: theme.title, icon: theme.icon, subtitle: theme.subtitle,
      theme: theme,

      render: function (root) {
        var UI = App.UI, el = UI.el;
        injectCss();

        /* ---------- Zustand ---------- */
        var timers = [], destroyed = false, busy = false;
        var freeLeft = 0, freeBet = 0, freeExpand = null, freeWon = 0;
        var stickies = {};          // "reel:row" -> true (Sticky-Wilds)
        var respinsUsed = 0;
        var MAX_RESPINS = 8;
        var auto = 0;               // verbleibende Autospins
        var spinHold = null;
        var lastGrid = null;

        function later(fn, ms) {
          var id = setTimeout(function () {
            if (destroyed) return;
            var k = timers.indexOf(id); if (k >= 0) timers.splice(k, 1);
            fn();
          }, ms);
          timers.push(id); return id;
        }
        function stopHold(f) { if (spinHold) { spinHold.stop(f || 0.05); spinHold = null; } }

        /* ---------- DOM-Gerüst ---------- */
        var readout = el('div', { class: 'sm-readout' }, ['Bereit']);
        var featureBar = el('div', { class: 'sm-feature' }, ['']);
        featureBar.style.display = 'none';

        var reelEls = [], stripEls = [], cellEls = [];
        var reelsRow = el('div', { class: 'sm-reels' });
        for (var i = 0; i < theme.reels; i++) {
          var strip = el('div', { class: 'sm-strip' });
          var reel = el('div', { class: 'sm-reel' }, [strip]);
          stripEls.push(strip); reelEls.push(reel); cellEls.push([]);
          reelsRow.appendChild(reel);
        }
        reelsRow.style.setProperty('--sm-cols', String(theme.reels));

        var stage = el('div', { class: 'sm-stage' }, [readout, reelsRow, featureBar]);

        var betPanel = UI.createBetPanel({ initial: 50, onChange: updateSpinSub });
        var spinSub = el('span', { class: 'btn-sub' }, ['']);
        var spinBtn = el('button', {
          class: 'btn btn-primary btn-lg btn-2l sm-spin', type: 'button', onclick: function () { startRound(); }
        }, [el('span', { class: 'btn-main' }, ['🎰 Drehen']), spinSub]);

        var autoBtn = el('button', {
          class: 'btn btn-ghost sm-auto', type: 'button', onclick: toggleAuto
        }, ['🔁 Auto 10']);

        function updateSpinSub() {
          spinSub.textContent = 'Einsatz ' + UI.formatCoins(betPanel.getBet()) + ' ' + UI.coinIcon();
        }
        updateSpinSub();

        var controls = el('div', { class: 'controls-row sm-controls' }, [betPanel.root, spinBtn, autoBtn]);

        var hint = el('p', { class: 'hint-text' }, [
          theme._lines.length + ' Gewinnlinien · Einsatz verteilt sich gleichmäßig darauf. ' +
          (theme.hint || '') + ' RTP ≈ ' + (theme.rtp || 94) + ' %.'
        ]);

        // Der Spielrahmen (app.js) zeigt Icon + Titel bereits — hier nur die
        // Kurzbeschreibung des Automaten, sonst stünde der Name doppelt da.
        root.appendChild(el('div', { class: 'sm-wrap', style: themeVars(theme) }, [
          el('div', { class: 'sm-title' }, [theme.subtitle || '']),
          stage, controls, hint, buildPaytable(theme, el)
        ]));

        /* ---------- Walzen füllen ---------- */
        var STRIP_N = 20;

        function randomId() {
          var s = theme.symbols[(Math.random() * theme.symbols.length) | 0];
          return s.id;
        }
        function emojiOf(id) { var s = theme._byId[id]; return s ? s.emoji : '❔'; }

        /* Ruhezustand: die obersten `rows` Zellen sind sichtbar. */
        function settleReel(idx, syms) {
          var strip = stripEls[idx];
          strip.style.transition = 'none';
          strip.style.transform = 'translateY(0)';
          strip.innerHTML = '';
          cellEls[idx] = [];
          for (var k = 0; k < STRIP_N; k++) {
            var id = (k < theme.rows && syms) ? syms[k] : randomId();
            var cell = el('div', { class: 'sm-cell' }, [emojiOf(id)]);
            cell.dataset.sym = id;
            strip.appendChild(cell);
            cellEls[idx].push(cell);
          }
        }
        for (var r0 = 0; r0 < theme.reels; r0++) settleReel(r0, null);

        function visibleCell(reel, row) { return cellEls[reel][row]; }

        function clearHighlights() {
          reelEls.forEach(function (re) { re.classList.remove('sm-reel-win'); });
          cellEls.forEach(function (col) {
            col.forEach(function (c) { c.classList.remove('sm-hit', 'sm-scatter-hit', 'sm-gone', 'sm-drop'); });
          });
        }

        function markSticky() {
          Object.keys(stickies).forEach(function (key) {
            var p = key.split(':');
            var c = visibleCell(+p[0], +p[1]);
            if (c) c.classList.add('sm-sticky');
          });
        }
        function clearSticky() {
          stickies = {};
          cellEls.forEach(function (col) { col.forEach(function (c) { c.classList.remove('sm-sticky'); }); });
        }

        /* ---------- Dreh-Animation ---------- */
        function animateSpin(grid, done) {
          var cellH = 0;
          var probe = cellEls[0][0];
          if (probe) cellH = probe.getBoundingClientRect().height;
          if (!cellH) cellH = 78;

          var IDX = STRIP_N - theme.rows - 1;   // Zielfenster-Start
          var dur = [];
          for (var i = 0; i < theme.reels; i++) dur.push(650 + i * 170);

          stopHold(0.02);
          if (App.Audio) {
            spinHold = App.Audio.hold(150, { type: 'sawtooth', peak: 0.028, filter: 1100 });
            if (spinHold.sweepTo) spinHold.sweepTo(280, 1.2);
          }

          for (var w = 0; w < theme.reels; w++) {
            (function (idx) {
              var strip = stripEls[idx];
              // Streifen neu aufbauen: Zielsymbole ans Fenster, Rest zufällig,
              // oberste Zellen = aktueller Stand (nahtloser Start).
              var old = [];
              for (var y = 0; y < theme.rows; y++) {
                var c = cellEls[idx][y];
                old.push(c ? c.dataset.sym : randomId());
              }
              strip.style.transition = 'none';
              strip.style.transform = 'translateY(0)';
              strip.innerHTML = '';
              cellEls[idx] = [];
              for (var k = 0; k < STRIP_N; k++) {
                var id;
                if (k < theme.rows) id = old[k];
                else if (k >= IDX && k < IDX + theme.rows) id = grid[idx][k - IDX];
                else id = randomId();
                var cell = el('div', { class: 'sm-cell' }, [emojiOf(id)]);
                cell.dataset.sym = id;
                strip.appendChild(cell);
                cellEls[idx].push(cell);
              }
              void strip.offsetHeight;
              strip.style.transition = 'transform ' + dur[idx] + 'ms cubic-bezier(0.16,0.84,0.20,1)';
              strip.style.transform = 'translateY(' + (-IDX * cellH) + 'px)';

              later(function () {
                reelEls[idx].classList.add('sm-landed');
                later(function () { reelEls[idx].classList.remove('sm-landed'); }, 280);
                if (App.Audio) App.Audio.sfx('pop');
                if (idx === theme.reels - 1) stopHold(0.05);
              }, dur[idx]);
            })(w);
          }

          later(function () {
            // Ruhezustand herstellen, damit Zellen wieder adressierbar sind
            for (var i = 0; i < theme.reels; i++) settleReel(i, grid[i]);
            markSticky();
            done();
          }, dur[theme.reels - 1] + 120);
        }

        /* ---------- Runde ---------- */
        function setBusy(b) {
          busy = b;
          spinBtn.disabled = b;
          betPanel.setDisabled(b || freeLeft > 0);
          autoBtn.classList.toggle('sm-auto-on', auto > 0);
          autoBtn.textContent = auto > 0 ? ('⏹ Auto ' + auto) : '🔁 Auto 10';
        }

        function toggleAuto() {
          if (auto > 0) { auto = 0; setBusy(busy); UI.toast('Autospin gestoppt', 'info'); return; }
          auto = 10;
          setBusy(busy);
          if (!busy) startRound();
        }

        function startRound() {
          if (busy || destroyed) return;

          var bet;
          if (freeLeft > 0) {
            bet = freeBet;                       // Freispiele kosten nichts
          } else {
            bet = betPanel.getBet();
            if (!App.Coins.canBet(bet)) {
              UI.toast('Nicht genug Coins für diesen Einsatz', 'lose');
              auto = 0; setBusy(false);
              return;
            }
            App.Coins.add(-bet);
          }

          setBusy(true);
          clearHighlights();
          readout.className = 'sm-readout sm-spinning';
          readout.textContent = freeLeft > 0 ? ('Freispiel ' + freeLeft + ' …') : 'Dreht …';

          var grid = spinGrid(theme);
          // Sticky-Wilds bleiben liegen
          Object.keys(stickies).forEach(function (key) {
            var p = key.split(':');
            grid[+p[0]][+p[1]] = theme.wild;
          });

          animateSpin(grid, function () {
            lastGrid = grid;
            resolve(grid, bet);
          });
        }

        function resolve(grid, bet) {
          var expand = freeLeft > 0 ? freeExpand : null;
          var res = evalGrid(theme, grid, bet, { expand: expand });
          var won = res.total;

          showWins(res);

          if (won > 0) {
            App.Coins.add(won);
            if (freeLeft > 0) freeWon += won;
          }

          // ---- Sonderfeatures ----
          if (theme.feature === 'cascade' && res.lineWins.length) {
            cascade(grid, bet, won, 2);
            return;
          }
          if (theme.feature === 'respin') {
            // Erster Auslöser braucht mehrere Wilds (sonst liefe fast jede Runde
            // in einen Gratis-Respin); danach verlängert jedes weitere Wild.
            var need = respinsUsed === 0 ? (theme.respinTrigger || 2) : 1;
            var newSticky = collectWilds(grid);
            if (newSticky >= need && respinsUsed < MAX_RESPINS) {
              respinsUsed++;
              feature('🌕 ' + newSticky + ' Vollmond' + (newSticky > 1 ? 'e bleiben' : ' bleibt') + ' kleben — Respin!');
              later(function () { respin(bet); }, 800);
              return;
            }
            clearSticky();
            respinsUsed = 0;
            feature('');
          }

          finishRound(res, bet, won);
        }

        /* Cascade: Gewinnsymbole fallen weg, neue rutschen nach, Multiplikator steigt. */
        function cascade(grid, bet, wonSoFar, mult) {
          // Positionen der zuletzt markierten Gewinnsymbole einsammeln
          var hits = {};
          cellEls.forEach(function (col, r) {
            col.slice(0, theme.rows).forEach(function (c, y) {
              if (c.classList.contains('sm-hit')) hits[r + ':' + y] = true;
            });
          });
          var keys = Object.keys(hits);
          if (!keys.length) { finishRound({ lineWins: [], total: wonSoFar }, bet, wonSoFar); return; }

          keys.forEach(function (k) {
            var p = k.split(':');
            var c = visibleCell(+p[0], +p[1]);
            if (c) c.classList.add('sm-gone');
          });
          if (App.Audio) App.Audio.sfx('pop');

          later(function () {
            // Nachrutschen: pro Walze die getroffenen Reihen durch neue ersetzen
            var g2 = [];
            for (var r = 0; r < theme.reels; r++) {
              var keep = [];
              for (var y = 0; y < theme.rows; y++) if (!hits[r + ':' + y]) keep.push(grid[r][y]);
              var fill = [];
              while (fill.length + keep.length < theme.rows) fill.push(randomId());
              g2.push(fill.concat(keep));
            }
            for (var i = 0; i < theme.reels; i++) settleReel(i, g2[i]);
            for (var rr = 0; rr < theme.reels; rr++) {
              for (var yy = 0; yy < theme.rows; yy++) {
                if (hits[rr + ':' + yy]) visibleCell(rr, yy).classList.add('sm-drop');
              }
            }
            var r2 = evalGrid(theme, g2, bet, { globalMult: mult });
            showWins(r2);
            if (r2.total > 0) {
              App.Coins.add(r2.total);
              if (freeLeft > 0) freeWon += r2.total;
              feature('🍬 Kettenreaktion ×' + mult + '  +' + UI.formatCoins(r2.total));
              later(function () { cascade(g2, bet, wonSoFar + r2.total, Math.min(mult + 1, 5)); }, 700);
            } else {
              finishRound({ lineWins: [], total: wonSoFar }, bet, wonSoFar);
            }
          }, 380);
        }

        function collectWilds(grid) {
          if (!theme.wild) return 0;
          var n = 0;
          for (var r = 0; r < theme.reels; r++) {
            for (var y = 0; y < theme.rows; y++) {
              if (grid[r][y] === theme.wild && !stickies[r + ':' + y]) { stickies[r + ':' + y] = true; n++; }
            }
          }
          markSticky();
          return n;
        }

        function respin(bet) {
          if (destroyed) return;
          clearHighlights();
          markSticky();
          var grid = spinGrid(theme);
          Object.keys(stickies).forEach(function (key) {
            var p = key.split(':');
            grid[+p[0]][+p[1]] = theme.wild;
          });
          animateSpin(grid, function () { resolve(grid, bet); });
        }

        /* Rundenabschluss: Freispiele/Bonus prüfen, Anzeige, nächster Autospin. */
        function finishRound(res, bet, won) {
          // Scatter-Feature auslösen?
          var sc = theme.scatter;
          if (sc && res.scatterCount >= (sc.trigger || 3) && freeLeft === 0 && theme.feature !== 'pick') {
            startFreeSpins(bet, res.scatterCount);
            return;
          }
          if (sc && res.scatterCount >= (sc.trigger || 3) && theme.feature === 'pick') {
            pickBonus(bet, res.scatterCount);
            return;
          }

          if (won > 0) {
            UI.flash(won - (freeLeft > 0 ? 0 : bet));
            readout.className = 'sm-readout sm-win';
            readout.textContent = '+' + UI.formatCoins(won) + ' ' + UI.coinIcon();
            if (won >= bet * 20) {
              if (App.Audio) App.Audio.sfx('jackpot');
              readout.className = 'sm-readout sm-big';
              readout.textContent = '🔥 GROSSER GEWINN  +' + UI.formatCoins(won);
              UI.toast('Großer Gewinn: ' + UI.formatCoins(won) + ' ' + UI.coinIcon(), 'win');
            }
          } else {
            if (freeLeft === 0) UI.flash(-bet);
            readout.className = 'sm-readout sm-lose';
            readout.textContent = 'Kein Gewinn';
          }

          if (freeLeft > 0) {
            freeLeft--;
            if (freeLeft > 0) {
              feature('🎟️ Noch ' + freeLeft + ' Freispiele · gesammelt ' + UI.formatCoins(freeWon));
              setBusy(false);
              later(function () { startRound(); }, 900);
              return;
            }
            // Freispiele vorbei
            feature('');
            featureBar.style.display = 'none';
            freeExpand = null;
            readout.className = 'sm-readout sm-big';
            readout.textContent = '🎟️ Freispiele beendet: +' + UI.formatCoins(freeWon);
            UI.toast('Freispiele: ' + UI.formatCoins(freeWon) + ' ' + UI.coinIcon(), 'win');
            freeWon = 0;
          }

          betPanel.refresh();
          App.Coins.settle();
          setBusy(false);

          if (auto > 0) {
            auto--;
            setBusy(false);
            if (auto > 0) later(function () { if (!destroyed && auto > 0) startRound(); }, 650);
            else { UI.toast('Autospin beendet', 'info'); setBusy(false); }
          }
        }

        function startFreeSpins(bet, scount) {
          var sc = theme.scatter;
          freeLeft = sc.freeSpins || 10;
          freeBet = bet;
          freeWon = 0;
          if (sc.expanding) {
            // Zufälliges Sondersymbol (nicht Scatter/Wild), gewichtet zu den Mittelklasse-Symbolen
            var pool = theme.symbols.filter(function (s) { return s.id !== sc.id && s.id !== theme.wild; });
            freeExpand = pool[(Math.random() * pool.length) | 0].id;
          }
          if (App.Audio) App.Audio.sfx('levelup');
          readout.className = 'sm-readout sm-big';
          readout.textContent = '🎟️ ' + scount + ' Scatter — ' + freeLeft + ' Freispiele!';
          feature(freeExpand
            ? ('🎟️ Freispiele · Sondersymbol ' + emojiOf(freeExpand) + ' expandiert')
            : ('🎟️ ' + freeLeft + ' Freispiele'));
          UI.toast(freeLeft + ' Freispiele gewonnen!', 'win');
          betPanel.setDisabled(true);
          later(function () { setBusy(false); startRound(); }, 1400);
        }

        /* Pick-Bonus (Piraten): 3 von 9 Truhen wählen. */
        function pickBonus(bet, scount) {
          if (App.Audio) App.Audio.sfx('levelup');
          readout.className = 'sm-readout sm-big';
          readout.textContent = '🗺️ ' + scount + ' Karten — Schatzsuche!';

          var picksLeft = theme.pickCount || 3, sum = 0;
          var values = [];
          // 9 Truhen: meist klein, selten fett (Werte kommen aus dem Theme)
          var pool = (theme.pickPool || [1, 1, 1, 2, 2, 3, 5, 8, 20]).slice();
          for (var i = pool.length - 1; i > 0; i--) {
            var j = (Math.random() * (i + 1)) | 0, t = pool[i]; pool[i] = pool[j]; pool[j] = t;
          }
          values = pool;

          var boxes = [];
          var grid = el('div', { class: 'sm-pickgrid' });
          for (var b = 0; b < 9; b++) {
            (function (idx) {
              var box = el('button', { class: 'sm-pick', type: 'button', onclick: function () { openBox(idx); } }, ['🎁']);
              boxes.push(box); grid.appendChild(box);
            })(b);
          }
          var info = el('div', { class: 'sm-pickinfo' }, ['Wähle ' + picksLeft + ' Truhen — die Multiplikatoren werden addiert.']);
          var overlay = el('div', { class: 'sm-overlay' }, [
            el('div', { class: 'sm-picktitle' }, ['🏴‍☠️ Schatzsuche']), info, grid
          ]);
          stage.appendChild(overlay);

          function openBox(idx) {
            if (boxes[idx].disabled || picksLeft <= 0) return;
            boxes[idx].disabled = true;
            boxes[idx].classList.add('sm-pick-open');
            boxes[idx].textContent = '×' + values[idx];
            sum += values[idx];
            picksLeft--;
            if (App.Audio) App.Audio.sfx('coin');
            info.textContent = picksLeft > 0
              ? ('Noch ' + picksLeft + ' Truhen · bisher ×' + sum)
              : ('Gesamt ×' + sum);
            if (picksLeft === 0) {
              boxes.forEach(function (bx, i) {
                if (!bx.disabled) { bx.disabled = true; bx.classList.add('sm-pick-dead'); bx.textContent = '×' + values[i]; }
              });
              var payout = Math.round(bet * sum);
              later(function () {
                if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
                App.Coins.add(payout);
                UI.flash(payout - bet);
                if (App.Audio) App.Audio.sfx('jackpot');
                readout.className = 'sm-readout sm-big';
                readout.textContent = '🏆 Schatz ×' + sum + '  +' + UI.formatCoins(payout);
                UI.toast('Schatzsuche: +' + UI.formatCoins(payout) + ' ' + UI.coinIcon(), 'win');
                betPanel.refresh();
                App.Coins.settle();
                setBusy(false);
                if (auto > 0) { auto--; if (auto > 0) later(startRound, 800); }
              }, 900);
            }
          }
        }

        function feature(text) {
          featureBar.textContent = text || '';
          featureBar.style.display = text ? '' : 'none';
        }

        function showWins(res) {
          if (!res.lineWins.length) return;
          res.lineWins.forEach(function (w) {
            if (w.expanded) {
              for (var r = 0; r < w.reels; r++) {
                reelEls[r].classList.add('sm-reel-win');
                for (var y = 0; y < theme.rows; y++) visibleCell(r, y).classList.add('sm-hit');
              }
              return;
            }
            var line = theme._lines[w.line];
            for (var c = 0; c < w.count; c++) {
              var cell = visibleCell(c, line[c]);
              if (cell) cell.classList.add('sm-hit');
            }
          });
          if (res.scatterCount >= 2 && theme.scatter) {
            for (var r2 = 0; r2 < theme.reels; r2++) {
              for (var y2 = 0; y2 < theme.rows; y2++) {
                if (cellEls[r2][y2].dataset.sym === theme.scatter.id) cellEls[r2][y2].classList.add('sm-scatter-hit');
              }
            }
          }
        }

        return {
          cleanup: function () {
            destroyed = true; auto = 0; busy = false;
            stopHold(0.02);
            for (var i = 0; i < timers.length; i++) clearTimeout(timers[i]);
            timers.length = 0;
          }
        };
      }
    };
  }

  function themeVars(theme) {
    var c = theme.colors || {};
    return '--sm-a:' + (c.a || '#39ff14') + ';--sm-b:' + (c.b || '#33e6d0') +
      ';--sm-bg1:' + (c.bg1 || 'rgba(4,16,10,.95)') + ';--sm-bg2:' + (c.bg2 || 'rgba(9,32,21,.85)') +
      ';--sm-glow:' + (c.glow || 'rgba(57,255,20,.55)') + ';';
  }

  /* ---------- Gewinntabelle ---------- */
  function buildPaytable(theme, el) {
    var rows = [];
    theme.symbols.slice().sort(function (a, b) {
      var am = a.pay ? (a.pay[theme.reels] || 0) : 0, bm = b.pay ? (b.pay[theme.reels] || 0) : 0;
      return bm - am;
    }).forEach(function (s) {
      if (!s.pay) return;
      var cols = [];
      for (var n = 3; n <= theme.reels; n++) cols.push(s.pay[n] ? ('×' + s.pay[n]) : '—');
      rows.push(el('tr', s.id === theme.wild ? { class: 'sm-pay-wild' } : null, [
        el('td', { class: 'sm-pay-sym' }, [s.emoji]),
        el('td', { class: 'sm-pay-name' }, [s.name + (s.id === theme.wild ? ' · Wild' : '')]),
        el('td', { class: 'sm-pay-mult' }, [cols.join('  ')])
      ]));
    });

    if (theme.scatter) {
      var sc = theme.scatter, scDef = theme._byId[sc.id];
      var txt = [];
      Object.keys(sc.pay || {}).forEach(function (k) { txt.push(k + '× → ×' + sc.pay[k]); });
      rows.push(el('tr', { class: 'sm-pay-scatter' }, [
        el('td', { class: 'sm-pay-sym' }, [scDef ? scDef.emoji : '⭐']),
        el('td', { class: 'sm-pay-name' }, [(scDef ? scDef.name : 'Scatter') + ' · ' + (sc.label || 'Scatter')]),
        el('td', { class: 'sm-pay-mult' }, [txt.join(' · ') || '—'])
      ]));
    }

    var head = ['3×'];
    for (var n2 = 4; n2 <= theme.reels; n2++) head.push(n2 + '×');

    return el('div', { class: 'glass sm-paycard' }, [
      el('div', { class: 'sm-paytitle' }, ['💰 Gewinntabelle · ' + head.join(' / ') + ' (× Linieneinsatz)']),
      el('table', { class: 'payout-table sm-paytable' }, [
        el('tbody', null, rows)
      ]),
      theme.featureText ? el('p', { class: 'sm-featuretext' }, [theme.featureText]) : null
    ]);
  }

  /* ---------- CSS (einmalig für alle Themen) ---------- */
  function injectCss() {
    App.UI.injectStyle('slot-engine-css', [
      '.sm-wrap{display:flex;flex-direction:column;gap:14px;max-width:760px;margin:0 auto;}',
      '.sm-title{text-align:center;font-weight:700;font-size:clamp(12px,3.2vw,15px);letter-spacing:.3px;',
        'color:var(--sm-b);opacity:.9;}',

      '.sm-stage{position:relative;display:flex;flex-direction:column;align-items:center;gap:12px;',
        'padding:14px 10px;border-radius:18px;border:1px solid var(--stroke-2);',
        'background:linear-gradient(180deg,var(--sm-bg1),var(--sm-bg2));overflow:hidden;}',

      '.sm-readout{font-size:clamp(16px,4vw,24px);font-weight:800;min-height:1.3em;text-align:center;color:var(--sm-b);}',
      '.sm-readout.sm-spinning{color:var(--muted);}',
      '.sm-readout.sm-win{color:var(--sm-a);text-shadow:0 0 14px var(--sm-glow);}',
      '.sm-readout.sm-lose{color:var(--muted);}',
      '.sm-readout.sm-big{color:var(--gold);text-shadow:0 0 18px rgba(255,210,63,.8);animation:smPulse .5s ease-in-out 3;}',
      '@keyframes smPulse{0%,100%{transform:scale(1)}50%{transform:scale(1.05)}}',

      '.sm-reels{--cell:clamp(42px,13vw,78px);display:flex;gap:6px;justify-content:center;width:100%;}',
      '.sm-reel{position:relative;flex:1 1 0;max-width:110px;height:calc(var(--cell)*3);overflow:hidden;',
        'border-radius:12px;border:1px solid var(--stroke-2);background:rgba(0,0,0,.35);',
        'box-shadow:inset 0 0 18px rgba(0,0,0,.65);transition:box-shadow .25s,border-color .25s;}',
      '.sm-reel.sm-reel-win{border-color:var(--sm-a);box-shadow:0 0 20px var(--sm-glow),inset 0 0 16px var(--sm-glow);}',
      '.sm-reel.sm-landed{animation:smPop .26s ease-out;}',
      '@keyframes smPop{0%{transform:translateY(0)}35%{transform:translateY(3px) scale(1.02)}100%{transform:translateY(0) scale(1)}}',

      '.sm-strip{display:flex;flex-direction:column;will-change:transform;}',
      '.sm-cell{height:var(--cell);display:flex;align-items:center;justify-content:center;',
        'font-size:calc(var(--cell)*.56);line-height:1;user-select:none;transition:transform .18s,filter .18s;',
        'filter:drop-shadow(0 2px 4px rgba(0,0,0,.5));}',
      '.sm-cell.sm-hit{transform:scale(1.14);filter:drop-shadow(0 0 10px var(--sm-a));animation:smHit .7s ease-in-out infinite alternate;}',
      '@keyframes smHit{from{transform:scale(1.08)}to{transform:scale(1.2)}}',
      '.sm-cell.sm-scatter-hit{filter:drop-shadow(0 0 12px var(--gold));transform:scale(1.12);}',
      '.sm-cell.sm-sticky{background:radial-gradient(circle,var(--sm-glow),transparent 70%);}',
      '.sm-cell.sm-gone{opacity:0;transform:scale(.4);transition:all .3s ease-in;}',
      '.sm-cell.sm-drop{animation:smDrop .32s ease-out;}',
      '@keyframes smDrop{from{transform:translateY(-60%);opacity:.2}to{transform:translateY(0);opacity:1}}',

      '.sm-feature{font-size:13px;font-weight:800;color:var(--gold);text-align:center;',
        'padding:5px 12px;border-radius:999px;background:rgba(255,210,63,.12);border:1px solid rgba(255,210,63,.35);}',

      '.sm-controls{margin-top:2px;}',
      '.sm-spin{min-width:160px;}',
      '.sm-auto.sm-auto-on{border-color:var(--gold);color:var(--gold);}',

      '.sm-paycard{padding:12px 14px;}',
      '.sm-paytitle{font-size:14px;font-weight:800;color:var(--sm-b);margin-bottom:6px;}',
      '.sm-paytable td{padding:3px 6px;}',
      '.sm-paytable td.sm-pay-sym{font-size:20px;width:1%;white-space:nowrap;}',
      '.sm-paytable td.sm-pay-name{color:var(--muted);font-size:13px;}',
      '.sm-paytable td.sm-pay-mult{text-align:right;font-weight:800;color:var(--sm-a);font-variant-numeric:tabular-nums;white-space:nowrap;font-size:13px;}',
      '.sm-paytable tr.sm-pay-wild td.sm-pay-name,.sm-paytable tr.sm-pay-wild td.sm-pay-mult{color:var(--gold);}',
      '.sm-paytable tr.sm-pay-scatter td{border-top:1px solid var(--stroke-2);}',
      '.sm-paytable tr.sm-pay-scatter td.sm-pay-mult{color:var(--gold);}',
      '.sm-featuretext{margin:8px 2px 0;font-size:13px;color:var(--muted);line-height:1.5;}',

      '.sm-overlay{position:absolute;inset:0;z-index:9;display:flex;flex-direction:column;align-items:center;',
        'justify-content:center;gap:10px;background:rgba(2,10,7,.93);backdrop-filter:blur(3px);padding:16px;}',
      '.sm-picktitle{font-size:20px;font-weight:900;color:var(--gold);}',
      '.sm-pickinfo{font-size:14px;color:var(--muted);text-align:center;}',
      '.sm-pickgrid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;}',
      '.sm-pick{width:clamp(56px,17vw,78px);height:clamp(56px,17vw,78px);border-radius:14px;font-size:26px;',
        'border:1px solid var(--stroke-2);background:rgba(255,255,255,.06);color:#fff;cursor:pointer;',
        'transition:transform .15s,box-shadow .15s;}',
      '.sm-pick:hover:not(:disabled){transform:translateY(-3px);box-shadow:0 0 18px var(--sm-glow);}',
      '.sm-pick-open{font-size:19px;font-weight:900;color:var(--gold);border-color:var(--gold);background:rgba(255,210,63,.15);}',
      '.sm-pick-dead{opacity:.35;font-size:16px;}',

      '@media(max-width:520px){.sm-reels{gap:4px;}.sm-spin{flex:1 1 100%;}}'
    ].join(''));
  }

  /* ---------- Export ---------- */
  App.SlotEngine = {
    create: create,
    prepare: prepare,
    LINES_3x3: LINES_3x3,
    LINES_5x3: LINES_5x3,
    math: { spinGrid: spinGrid, evalGrid: evalGrid, prepare: prepare }
  };
})();
