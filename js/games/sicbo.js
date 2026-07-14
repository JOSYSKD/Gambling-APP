/* sicbo.js — "Sic Bo"
 * Klassisches Drei-Würfel-Spiel. Der Spieler wählt VOR dem Wurf genau eine
 * Wette (Groß/Klein, Einzelzahl 1–6, Summe 4–17, Pasch) und die drei Würfel
 * fallen gleichverteilt (Math.random 1–6). Auszahlungen als BRUTTO-Faktoren
 * inkl. Einsatz (Standard-Sic-Bo-Quoten):
 *   Klein (4–10) / Groß (11–17): 2×  (verlieren bei jedem Dreierpasch)
 *   Einzelzahl:  1× vorhanden 2×, 2× vorhanden 3×, 3× vorhanden 4×
 *   Beliebiger Pasch: 31×   |   Bestimmter Pasch: 181×
 *   Summe: 4/17 61×, 5/16 31×, 6/15 18×, 7/14 13×, 8/13 9×, 9–12 7×
 */
(function () {
  'use strict';
  window.App = window.App || {};
  App.Games = App.Games || {};
  var UI = App.UI, el = UI.el;

  // Punkte-Positionen (3x3-Raster, Zellen 1..9) je Augenzahl.
  var PIPS = {
    1: [5],
    2: [1, 9],
    3: [1, 5, 9],
    4: [1, 3, 7, 9],
    5: [1, 3, 5, 7, 9],
    6: [1, 4, 7, 3, 6, 9]
  };

  // Anzahl der Kombinationen (von 216) je Summe – für die Gewinnchance-Anzeige.
  var WAYS = { 4:3, 5:6, 6:10, 7:15, 8:21, 9:25, 10:27, 11:27, 12:25, 13:21, 14:15, 15:10, 16:6, 17:3 };
  // Brutto-Faktoren je Summe.
  var TOTAL_MULT = { 4:61, 5:31, 6:18, 7:13, 8:9, 9:7, 10:7, 11:7, 12:7, 13:9, 14:13, 15:18, 16:31, 17:61 };
  // Gewinnende Kombinationen für Klein/Groß (107 Summen − 2 Pasch = 105 von 216).
  var BIGSMALL_WIN = 105;

  function rand6() { return 1 + Math.floor(Math.random() * 6); }

  function injectCss() {
    UI.injectStyle('game-sicbo-css', [
      '.sb-wrap{display:flex;flex-direction:column;gap:18px;}',
      '.sb-scene{display:flex;align-items:center;justify-content:center;width:100%;min-height:150px;animation:sb-bob 3.6s ease-in-out infinite;}',
      '.sb-dice{display:flex;gap:16px;align-items:center;justify-content:center;flex-wrap:wrap;}',
      '.sb-die{width:64px;height:64px;border-radius:13px;background:linear-gradient(150deg,#ffffff,#d9e6dd);',
      'border:1px solid rgba(0,0,0,0.18);box-shadow:0 7px 16px rgba(0,0,0,0.45),inset 0 0 10px rgba(0,0,0,0.08);',
      'display:grid;grid-template-columns:repeat(3,1fr);grid-template-rows:repeat(3,1fr);padding:9px;gap:2px;transition:box-shadow .2s,border-color .2s;}',
      '.sb-die.hit{border-color:var(--neon);box-shadow:0 0 18px rgba(57,255,20,0.8),0 7px 16px rgba(0,0,0,0.45);}',
      '.sb-die.rolling{animation:sb-shake .3s linear infinite;}',
      '.sb-die.rolling:nth-child(2){animation-delay:.08s;}',
      '.sb-die.rolling:nth-child(3){animation-delay:.16s;}',
      '.sb-cell{display:grid;place-items:center;}',
      '.sb-pip{width:11px;height:11px;border-radius:50%;background:radial-gradient(circle at 35% 30%,#2c3d33,#0a120d);box-shadow:inset 0 -1px 2px rgba(0,0,0,0.55);}',
      '.sb-readout{text-align:center;display:flex;flex-direction:column;gap:4px;}',
      '.sb-sum{font-weight:900;letter-spacing:1px;color:var(--gold);font-variant-numeric:tabular-nums;min-height:20px;}',
      '.sb-status{font-weight:800;letter-spacing:1px;min-height:22px;color:var(--muted);}',
      '.sb-status.win{color:var(--neon);text-shadow:0 0 12px rgba(57,255,20,0.65);}',
      '.sb-status.lose{color:var(--danger-2);text-shadow:0 0 12px rgba(255,77,109,0.5);}',
      '.sb-controls{display:flex;flex-direction:column;gap:16px;}',
      '.sb-section{display:flex;flex-direction:column;gap:9px;}',
      '.sb-section-title{color:var(--leaf);font-weight:800;font-size:12px;text-transform:uppercase;letter-spacing:1px;}',
      '.sb-row{display:flex;gap:8px;flex-wrap:wrap;}',
      '.sb-row.center{justify-content:center;}',
      // Grund-Style aller Wett-Buttons
      '.sb-betbtn{cursor:pointer;font-family:inherit;color:var(--text);border:1px solid var(--stroke);',
      'background:rgba(9,32,21,0.7);border-radius:12px;transition:.12s;font-weight:800;}',
      '.sb-betbtn:hover:not(:disabled){border-color:var(--stroke-2);box-shadow:var(--glow-soft);transform:translateY(-1px);}',
      '.sb-betbtn:disabled{opacity:.4;cursor:not-allowed;}',
      '.sb-betbtn.active{color:#04160c;background:linear-gradient(180deg,var(--neon-soft),var(--neon));border-color:var(--neon);box-shadow:var(--glow);}',
      '.sb-betbtn.active .sb-b-x,.sb-betbtn.active .sb-b-sub{color:#0a2b12;}',
      // Groß/Klein
      '.sb-bigsmall{flex:1 1 150px;min-width:130px;display:flex;flex-direction:column;align-items:center;gap:2px;padding:12px 10px;}',
      '.sb-b-t{font-size:16px;font-weight:900;}',
      '.sb-b-sub{font-size:11px;color:var(--muted);letter-spacing:.5px;}',
      '.sb-b-x{font-size:12px;color:var(--gold);font-weight:900;}',
      // Einzelzahl / bestimmter Pasch (Mini-Würfel)
      '.sb-numbtn{padding:7px;display:flex;align-items:center;justify-content:center;}',
      '.sb-numbtn.active{background:linear-gradient(180deg,rgba(57,255,20,0.22),rgba(57,255,20,0.05));}',
      '.sb-mini{width:42px;height:42px;border-radius:9px;padding:6px;gap:1px;box-shadow:0 3px 8px rgba(0,0,0,0.4),inset 0 0 6px rgba(0,0,0,0.08);}',
      '.sb-mini .sb-pip{width:8px;height:8px;}',
      // Summe
      '.sb-totalbtn{width:54px;padding:6px 0;display:flex;flex-direction:column;align-items:center;gap:1px;}',
      '.sb-total-n{font-size:17px;font-weight:900;line-height:1;}',
      '.sb-total-x{font-size:10px;color:var(--gold);font-weight:900;}',
      // Pasch
      '.sb-paschbtn{flex:1 1 100%;padding:11px;display:flex;justify-content:center;gap:8px;align-items:baseline;}',
      // Info
      '.sb-desc{text-align:center;color:var(--muted);font-size:13px;min-height:18px;}',
      '.sb-desc b{color:var(--leaf);}',
      '.sb-info{display:flex;flex-wrap:wrap;gap:10px 22px;justify-content:center;padding-top:4px;border-top:1px dashed var(--stroke);}',
      '.sb-info-item{text-align:center;}',
      '.sb-info-l{display:block;color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:1px;}',
      '.sb-info-v{font-size:20px;font-weight:900;color:var(--leaf);font-variant-numeric:tabular-nums;}',
      '.sb-info-v.aqua{color:var(--aqua-soft);}',
      '.sb-info-v.gold{color:var(--gold);}',
      // Einsatz + Würfeln
      '.sb-betrow{display:flex;flex-wrap:wrap;gap:16px;align-items:flex-end;justify-content:center;}',
      '.sb-betrow .bet-panel{flex:1 1 240px;}',
      '.sb-roll{flex:1 1 240px;}',
      '@keyframes sb-bob{0%,100%{transform:translateY(0);}50%{transform:translateY(-6px);}}',
      '@keyframes sb-shake{0%,100%{transform:translateY(0) rotate(0);}25%{transform:translateY(-7px) rotate(-9deg);}50%{transform:translateY(1px) rotate(7deg);}75%{transform:translateY(-4px) rotate(-4deg);}}',
      '@media (max-width:520px){.sb-die{width:56px;height:56px;}}',
      '@media (prefers-reduced-motion:reduce){.sb-scene{animation:none;}.sb-die.rolling{animation:none;}}'
    ].join(''));
  }

  // Baut die 9 Zellen eines Würfels für Augenzahl n neu auf.
  function setDie(dieEl, n) {
    dieEl.innerHTML = '';
    var set = PIPS[n];
    for (var i = 1; i <= 9; i++) {
      var cell = el('span', { class: 'sb-cell' });
      if (set.indexOf(i) >= 0) cell.appendChild(el('span', { class: 'sb-pip' }));
      dieEl.appendChild(cell);
    }
  }

  // Mini-Würfel für die Auswahl-Buttons.
  function miniDie(n) {
    var d = el('div', { class: 'sb-die sb-mini' });
    setDie(d, n);
    return d;
  }

  App.Games.sicbo = {
    id: 'sicbo',
    title: 'Sic Bo',
    icon: '🎲',
    subtitle: 'Drei Würfel — wette auf Groß/Klein, Zahlen, Summen & Pasch',

    render: function (root) {
      injectCss();

      // ----- Zustand -----
      // type: 'small'|'big'|'single'|'total'|'anytriple'|'spectriple'
      // value: Zahl bei single/spectriple/total, sonst null
      var state = { type: 'small', value: null };
      var rolling = false;
      var controlsDisabled = false;
      var spinTimer = null, rollTimer = null;
      var allBets = []; // { btn, type, value }

      // ----- Würfel-Bühne -----
      var dieEls = [el('div', { class: 'sb-die' }), el('div', { class: 'sb-die' }), el('div', { class: 'sb-die' })];
      dieEls.forEach(function (d) { setDie(d, 1); });
      var scene = el('div', { class: 'sb-scene' }, [el('div', { class: 'sb-dice' }, dieEls)]);
      var sumEl = el('div', { class: 'sb-sum' });
      var statusEl = el('div', { class: 'sb-status', text: 'Wähle deine Wette und würfle!' });
      var stage = el('div', { class: 'game-stage' }, [
        scene,
        el('div', { class: 'sb-readout' }, [sumEl, statusEl])
      ]);

      // ----- Wett-Button-Fabrik -----
      function betButton(extraClass, children, type, value) {
        var b = el('button', {
          class: 'btn sb-betbtn ' + extraClass,
          type: 'button',
          onclick: function () { if (!controlsDisabled) selectBet(type, value); }
        }, children);
        allBets.push({ btn: b, type: type, value: (value == null ? null : value) });
        return b;
      }

      // Gruppe: Groß / Klein
      var kleinBtn = betButton('sb-bigsmall', [
        el('span', { class: 'sb-b-t' }, ['Klein']),
        el('span', { class: 'sb-b-sub' }, ['Summe 4–10']),
        el('span', { class: 'sb-b-x' }, ['2×'])
      ], 'small', null);
      var grossBtn = betButton('sb-bigsmall', [
        el('span', { class: 'sb-b-t' }, ['Groß']),
        el('span', { class: 'sb-b-sub' }, ['Summe 11–17']),
        el('span', { class: 'sb-b-x' }, ['2×'])
      ], 'big', null);
      var bigSmallSection = el('div', { class: 'sb-section' }, [
        el('div', { class: 'sb-section-title' }, ['Groß / Klein  ·  verliert bei jedem Pasch']),
        el('div', { class: 'sb-row' }, [kleinBtn, grossBtn])
      ]);

      // Gruppe: Einzelzahl 1–6
      var singleRow = el('div', { class: 'sb-row center' });
      for (var n = 1; n <= 6; n++) {
        singleRow.appendChild(betButton('sb-numbtn', [miniDie(n)], 'single', n));
      }
      var singleSection = el('div', { class: 'sb-section' }, [
        el('div', { class: 'sb-section-title' }, ['Einzelzahl  ·  2× / 3× / 4× je Vorkommen']),
        singleRow
      ]);

      // Gruppe: Summe 4–17
      var totalRow = el('div', { class: 'sb-row center' });
      for (var t = 4; t <= 17; t++) {
        totalRow.appendChild(betButton('sb-totalbtn', [
          el('span', { class: 'sb-total-n' }, [String(t)]),
          el('span', { class: 'sb-total-x' }, [TOTAL_MULT[t] + '×'])
        ], 'total', t));
      }
      var totalSection = el('div', { class: 'sb-section' }, [
        el('div', { class: 'sb-section-title' }, ['Summe (Total)']),
        totalRow
      ]);

      // Gruppe: Pasch
      var anyBtn = betButton('sb-paschbtn', [
        el('span', { class: 'sb-b-t' }, ['Beliebiger Pasch']),
        el('span', { class: 'sb-b-x' }, ['31×'])
      ], 'anytriple', null);
      var specRow = el('div', { class: 'sb-row center' });
      for (var p = 1; p <= 6; p++) {
        specRow.appendChild(betButton('sb-numbtn', [miniDie(p)], 'spectriple', p));
      }
      var paschSection = el('div', { class: 'sb-section' }, [
        el('div', { class: 'sb-section-title' }, ['Pasch']),
        el('div', { class: 'sb-row' }, [anyBtn]),
        el('div', { class: 'sb-section-title' }, ['Bestimmter Pasch  ·  181×']),
        specRow
      ]);

      var controlsPanel = el('div', { class: 'glass game-panel sb-controls' }, [
        bigSmallSection, singleSection, totalSection, paschSection
      ]);

      // ----- Info / Beschreibung -----
      var descEl = el('div', { class: 'sb-desc' });
      var multV = el('div', { class: 'sb-info-v gold' });
      var chanceV = el('div', { class: 'sb-info-v aqua' });
      var winV = el('div', { class: 'sb-info-v' });
      var infoRow = el('div', { class: 'sb-info' }, [
        el('div', { class: 'sb-info-item' }, [el('span', { class: 'sb-info-l' }, ['Auszahlung']), multV]),
        el('div', { class: 'sb-info-item' }, [el('span', { class: 'sb-info-l' }, ['Gewinnchance']), chanceV]),
        el('div', { class: 'sb-info-item' }, [el('span', { class: 'sb-info-l' }, ['Max. Gewinn']), winV])
      ]);
      var infoPanel = el('div', { class: 'glass game-panel sb-section' }, [descEl, infoRow]);

      // ----- Einsatz + Würfeln -----
      var betPanel = UI.createBetPanel({ initial: 50, onChange: updateInfo });
      var rollBtn = el('button', {
        class: 'btn btn-primary btn-lg btn-block sb-roll', type: 'button', onclick: doRoll
      }, ['🎲 Würfeln']);
      var betRow = el('div', { class: 'sb-betrow' }, [betPanel.root, rollBtn]);

      root.appendChild(el('div', { class: 'sb-wrap' }, [stage, controlsPanel, infoPanel, betRow]));

      // ----- Auswahl-Logik -----
      function selectBet(type, value) {
        state.type = type;
        state.value = (value == null ? null : value);
        updateActive();
        updateInfo();
      }
      function updateActive() {
        allBets.forEach(function (o) {
          var on = o.type === state.type && ((o.value == null && state.value == null) || o.value === state.value);
          o.btn.classList.toggle('active', on);
        });
      }

      // Kennzahlen der aktuellen Wette: Brutto-Faktor-Label, Chance, Max-Faktor.
      function betInfo() {
        var t = state.type, v = state.value;
        if (t === 'small' || t === 'big') return { mult: '2×', chance: BIGSMALL_WIN / 216, maxMult: 2 };
        if (t === 'single')     return { mult: '2× / 3× / 4×', chance: (216 - 125) / 216, maxMult: 4 };
        if (t === 'anytriple')  return { mult: '31×', chance: 6 / 216, maxMult: 31 };
        if (t === 'spectriple') return { mult: '181×', chance: 1 / 216, maxMult: 181 };
        /* total */             return { mult: TOTAL_MULT[v] + '×', chance: WAYS[v] / 216, maxMult: TOTAL_MULT[v] };
      }

      function updateInfo() {
        var info = betInfo(), v = state.value;
        multV.textContent = info.mult;
        chanceV.textContent = (Math.round(info.chance * 1000) / 10) + '%';
        var bet = betPanel.getBet();
        winV.textContent = '+' + UI.formatCoins(Math.round(bet * info.maxMult) - bet);

        var d = { };
        d.small = 'Klein — Gesamtsumme 4 bis 10 (verliert bei jedem Dreierpasch)';
        d.big = 'Groß — Gesamtsumme 11 bis 17 (verliert bei jedem Dreierpasch)';
        d.single = 'Einzelzahl — mindestens eine ' + v + ' unter den drei Würfeln';
        d.anytriple = 'Beliebiger Pasch — alle drei Würfel zeigen dieselbe Zahl';
        d.spectriple = 'Bestimmter Pasch — dreimal die ' + v;
        d.total = 'Summe — die drei Würfel ergeben genau ' + v;
        descEl.innerHTML = '';
        descEl.appendChild(document.createTextNode(d[state.type]));
      }

      function setControlsDisabled(dis) {
        controlsDisabled = dis;
        rollBtn.disabled = dis;
        betPanel.setDisabled(dis);
        allBets.forEach(function (o) { o.btn.disabled = dis; });
      }

      function setStatus(text, cls) {
        statusEl.className = 'sb-status' + (cls ? ' ' + cls : '');
        statusEl.textContent = text;
      }

      // ----- Auswertung -----
      // Gibt { won, mult } zurück (mult = Brutto-Faktor).
      function evaluate(dice, snap) {
        var sum = dice[0] + dice[1] + dice[2];
        var triple = dice[0] === dice[1] && dice[1] === dice[2];
        var t = snap.type, v = snap.value;
        if (t === 'small')  return (!triple && sum >= 4 && sum <= 10) ? { won: true, mult: 2 } : { won: false, mult: 0 };
        if (t === 'big')    return (!triple && sum >= 11 && sum <= 17) ? { won: true, mult: 2 } : { won: false, mult: 0 };
        if (t === 'single') {
          var c = 0;
          for (var i = 0; i < 3; i++) if (dice[i] === v) c++;
          return c > 0 ? { won: true, mult: c + 1 } : { won: false, mult: 0 };
        }
        if (t === 'anytriple')  return triple ? { won: true, mult: 31 } : { won: false, mult: 0 };
        if (t === 'spectriple') return (triple && dice[0] === v) ? { won: true, mult: 181 } : { won: false, mult: 0 };
        /* total */             return sum === v ? { won: true, mult: TOTAL_MULT[v] } : { won: false, mult: 0 };
      }

      // Hebt die Würfel hervor, die zum Gewinn beitragen.
      function highlightDice(dice, snap, won) {
        dieEls.forEach(function (de, i) {
          de.classList.remove('hit');
          if (!won) return;
          var mark = snap.type === 'single' ? (dice[i] === snap.value) : true;
          if (mark) de.classList.add('hit');
        });
      }

      // ----- Rundenablauf -----
      function doRoll() {
        if (rolling) return;
        var bet = betPanel.getBet();
        if (!App.Coins.canBet(bet)) { UI.toast('Nicht genug Coins', 'lose'); return; }

        rolling = true;
        setControlsDisabled(true);
        App.Coins.add(-bet);

        var snap = { type: state.type, value: state.value };
        var dice = [rand6(), rand6(), rand6()];

        sumEl.textContent = '';
        setStatus('Die Würfel rollen…', null);
        dieEls.forEach(function (de) { de.classList.remove('hit'); de.classList.add('rolling'); });

        // Schnelle Zufalls-Faces während des Rollens.
        spinTimer = setInterval(function () {
          dieEls.forEach(function (de) { setDie(de, rand6()); });
        }, 70);

        rollTimer = setTimeout(function () {
          clearInterval(spinTimer); spinTimer = null; rollTimer = null;
          dieEls.forEach(function (de, i) { de.classList.remove('rolling'); setDie(de, dice[i]); });
          resolve(bet, dice, snap);
        }, 900);
      }

      function resolve(bet, dice, snap) {
        var sum = dice[0] + dice[1] + dice[2];
        var triple = dice[0] === dice[1] && dice[1] === dice[2];
        var ev = evaluate(dice, snap);

        sumEl.textContent = 'Würfel ' + dice.join(' · ') + '  →  Summe ' + sum + (triple ? '  (Pasch!)' : '');
        highlightDice(dice, snap, ev.won);

        if (ev.won) {
          var payout = Math.round(bet * ev.mult);
          App.Coins.add(payout);
          UI.flash(payout - bet);
          UI.toast('Gewonnen! ' + ev.mult + '× — Summe ' + sum, 'win');
          setStatus('🎉 Gewonnen mit ' + ev.mult + '×', 'win');
        } else {
          UI.flash(-bet);
          UI.toast('Verloren — Summe ' + sum, 'lose');
          setStatus('Verloren — Summe ' + sum, 'lose');
        }

        rolling = false;
        setControlsDisabled(false);
        betPanel.refresh();
        App.Coins.settle();
        updateInfo();
      }

      // ----- Initialisierung -----
      updateActive();
      updateInfo();

      return {
        cleanup: function () {
          if (spinTimer) { clearInterval(spinTimer); spinTimer = null; }
          if (rollTimer) { clearTimeout(rollTimer); rollTimer = null; }
        }
      };
    }
  };
})();
