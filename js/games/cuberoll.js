/* cuberoll.js — "Cube-Roll"
 * Wette auf einen Würfel (1–6): Über X, Unter X oder Exakt N.
 * Faire Auszahlung nach Wahrscheinlichkeit mit ~4% House-Edge:
 *   multiplier = (6 / gewinnendeAusgaenge) * 0.96
 * Echter CSS-3D-Würfel, der beim Wurf rollt und auf dem Ergebnis stehen bleibt.
 */
(function () {
  'use strict';
  window.App = window.App || {};
  App.Games = App.Games || {};
  var UI = App.UI, el = UI.el;

  var HOUSE = 0.96; // 4% House-Edge

  // Zielrotation der Würfels, damit die jeweilige Augenzahl nach vorne zeigt.
  var BASE = {
    1: { x: 0,   y: 0   },
    2: { x: 0,   y: -90 },
    3: { x: -90, y: 0   },
    4: { x: 90,  y: 0   },
    5: { x: 0,   y: 90  },
    6: { x: 0,   y: 180 }
  };

  // Punkte-Positionen (3x3-Raster, Zellen 1..9) je Augenzahl.
  var PIPS = {
    1: [5],
    2: [1, 9],
    3: [1, 5, 9],
    4: [1, 3, 7, 9],
    5: [1, 3, 5, 7, 9],
    6: [1, 4, 7, 3, 6, 9]
  };

  function injectCss() {
    UI.injectStyle('game-cuberoll-css', [
      '.cr-wrap{display:flex;flex-direction:column;gap:18px;}',
      '.cr-scene{perspective:760px;display:flex;align-items:center;justify-content:center;width:100%;min-height:190px;animation:cr-bob 3.6s ease-in-out infinite;}',
      '.cr-cube{position:relative;width:120px;height:120px;transform-style:preserve-3d;transform:rotateX(0deg) rotateY(0deg);will-change:transform;}',
      '.cr-face{position:absolute;left:0;top:0;width:120px;height:120px;border-radius:18px;',
      'background:radial-gradient(120% 120% at 30% 22%,#12472e,#05170e);border:1px solid var(--stroke-2);',
      'box-shadow:inset 0 0 24px rgba(57,255,20,0.16),0 0 16px rgba(57,255,20,0.14);',
      'display:grid;grid-template-columns:repeat(3,1fr);grid-template-rows:repeat(3,1fr);padding:15px;gap:3px;}',
      '.cr-face-1{transform:rotateY(0deg) translateZ(60px);}',
      '.cr-face-6{transform:rotateY(180deg) translateZ(60px);}',
      '.cr-face-2{transform:rotateY(90deg) translateZ(60px);}',
      '.cr-face-5{transform:rotateY(-90deg) translateZ(60px);}',
      '.cr-face-3{transform:rotateX(90deg) translateZ(60px);}',
      '.cr-face-4{transform:rotateX(-90deg) translateZ(60px);}',
      '.cr-cell{display:grid;place-items:center;}',
      '.cr-pip{width:19px;height:19px;border-radius:50%;background:radial-gradient(circle at 35% 30%,var(--leaf),var(--neon));',
      'box-shadow:0 0 8px rgba(57,255,20,0.85),inset 0 -2px 4px rgba(0,0,0,0.45);}',
      '.cr-readout{text-align:center;display:flex;flex-direction:column;gap:2px;}',
      '.cr-status{font-weight:800;letter-spacing:1px;min-height:22px;color:var(--muted);}',
      '.cr-status.win{color:var(--neon);text-shadow:0 0 12px rgba(57,255,20,0.65);}',
      '.cr-status.lose{color:var(--danger-2);text-shadow:0 0 12px rgba(255,77,109,0.5);}',
      '.cr-section{display:flex;flex-direction:column;gap:10px;}',
      '.cr-section-title{text-align:center;color:var(--leaf);font-weight:800;font-size:12px;text-transform:uppercase;letter-spacing:1px;}',
      '.cr-types{display:flex;gap:10px;flex-wrap:wrap;justify-content:center;}',
      '.cr-typebtn{flex:1 1 120px;min-width:110px;}',
      '.cr-typebtn.active{color:#04160c;background:linear-gradient(180deg,var(--neon-soft),var(--neon));border-color:var(--neon);box-shadow:var(--glow);}',
      '.cr-thresh-row{display:flex;gap:8px;flex-wrap:wrap;justify-content:center;}',
      '.cr-thresh{width:52px;height:52px;border-radius:14px;font-size:20px;font-weight:900;cursor:pointer;',
      'font-family:inherit;color:var(--text);border:1px solid var(--stroke);background:rgba(9,32,21,0.7);transition:.12s;}',
      '.cr-thresh:hover:not(:disabled){border-color:var(--stroke-2);box-shadow:var(--glow-soft);transform:translateY(-1px);}',
      '.cr-thresh.active{color:#04160c;background:linear-gradient(180deg,var(--neon-soft),var(--neon));border-color:var(--neon);box-shadow:var(--glow);}',
      '.cr-thresh:disabled{opacity:.4;cursor:not-allowed;}',
      '.cr-desc{text-align:center;color:var(--muted);font-size:13px;min-height:18px;}',
      '.cr-desc b{color:var(--leaf);}',
      '.cr-info{display:flex;flex-wrap:wrap;gap:10px 22px;justify-content:center;}',
      '.cr-info-item{text-align:center;}',
      '.cr-info-l{display:block;color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:1px;}',
      '.cr-info-v{font-size:22px;font-weight:900;color:var(--leaf);font-variant-numeric:tabular-nums;}',
      '.cr-info-v.aqua{color:var(--aqua-soft);}',
      '.cr-info-v.gold{color:var(--gold);}',
      '.cr-betrow{display:flex;flex-wrap:wrap;gap:16px;align-items:flex-end;justify-content:center;}',
      '.cr-betrow .bet-panel{flex:1 1 240px;}',
      '.cr-roll{flex:1 1 240px;}',
      '@keyframes cr-bob{0%,100%{transform:translateY(0);}50%{transform:translateY(-7px);}}',
      '@media (max-width:520px){.cr-scene{transform:scale(0.92);}}',
      '@media (prefers-reduced-motion:reduce){.cr-scene{animation:none;}}'
    ].join(''));
  }

  function buildFace(n) {
    var face = el('div', { class: 'cr-face cr-face-' + n });
    var set = PIPS[n];
    for (var i = 1; i <= 9; i++) {
      var cell = el('span', { class: 'cr-cell' });
      if (set.indexOf(i) >= 0) cell.appendChild(el('span', { class: 'cr-pip' }));
      face.appendChild(cell);
    }
    return face;
  }

  App.Games.cuberoll = {
    id: 'cuberoll',
    title: 'Cube-Roll',
    icon: '🎲',
    subtitle: 'Wette auf den Würfel — höher, niedriger, exakt',

    render: function (root) {
      injectCss();

      // ----- Zustand -----
      var state = { type: 'over', over: 3, under: 4, exact: 6 };
      var rolling = false;
      var controlsDisabled = false;
      var revX = 0, revY = 0;        // aufsummierte Umdrehungen (immer vorwärts)
      var rollTimer = null;

      // ----- 3D-Würfel -----
      var cube = el('div', { class: 'cr-cube' }, [
        buildFace(1), buildFace(2), buildFace(3), buildFace(4), buildFace(5), buildFace(6)
      ]);
      var scene = el('div', { class: 'cr-scene' }, [cube]);
      var statusEl = el('div', { class: 'cr-status', text: 'Wähle deine Wette und würfle!' });
      var stage = el('div', { class: 'game-stage' }, [
        scene,
        el('div', { class: 'cr-readout' }, [statusEl])
      ]);

      // ----- Wettart-Buttons -----
      var typeDefs = [
        { key: 'over',  label: 'Über X ▲' },
        { key: 'under', label: 'Unter X ▼' },
        { key: 'exact', label: 'Exakt N ◎' }
      ];
      var typeBtns = typeDefs.map(function (t) {
        return el('button', {
          class: 'btn cr-typebtn' + (state.type === t.key ? ' active' : ''),
          type: 'button',
          onclick: function () { if (!controlsDisabled) selectType(t.key); }
        }, [t.label]);
      });
      var typeRow = el('div', { class: 'cr-types' }, typeBtns);

      // ----- Schwellen-Buttons (dynamisch) -----
      var threshRow = el('div', { class: 'cr-thresh-row' });
      var descEl = el('div', { class: 'cr-desc' });

      // ----- Live-Info -----
      var multV   = el('div', { class: 'cr-info-v gold' });
      var chanceV = el('div', { class: 'cr-info-v aqua' });
      var winV    = el('div', { class: 'cr-info-v' });
      var infoRow = el('div', { class: 'cr-info' }, [
        el('div', { class: 'cr-info-item' }, [el('span', { class: 'cr-info-l' }, ['Auszahlung']), multV]),
        el('div', { class: 'cr-info-item' }, [el('span', { class: 'cr-info-l' }, ['Gewinnchance']), chanceV]),
        el('div', { class: 'cr-info-item' }, [el('span', { class: 'cr-info-l' }, ['Möglicher Gewinn']), winV])
      ]);

      var controlsPanel = el('div', { class: 'glass game-panel cr-section' }, [
        el('div', { class: 'cr-section-title' }, ['Wettart']),
        typeRow,
        el('div', { class: 'cr-section-title' }, ['Schwelle / Zahl']),
        threshRow,
        descEl,
        infoRow
      ]);

      // ----- Einsatz + Würfeln -----
      var betPanel = UI.createBetPanel({ initial: 50, onChange: updateInfo });
      var rollBtn = el('button', {
        class: 'btn btn-primary btn-lg btn-block cr-roll', type: 'button',
        onclick: doRoll
      }, ['🎲 Würfeln']);
      var betRow = el('div', { class: 'cr-betrow' }, [betPanel.root, rollBtn]);

      root.appendChild(el('div', { class: 'cr-wrap' }, [stage, controlsPanel, betRow]));

      // ----- Logik -----
      function threshold() { return state[state.type]; }

      function winningCount() {
        if (state.type === 'over')  return 6 - threshold();
        if (state.type === 'under') return threshold() - 1;
        return 1; // exact
      }
      function multiplier() { return (6 / winningCount()) * HOUSE; }
      function isWin(roll, snap) {
        if (snap.type === 'over')  return roll > snap.threshold;
        if (snap.type === 'under') return roll < snap.threshold;
        return roll === snap.threshold;
      }
      function winningFaces() {
        var t = threshold(), out = [], i;
        if (state.type === 'over')  { for (i = t + 1; i <= 6; i++) out.push(i); }
        else if (state.type === 'under') { for (i = 1; i < t; i++) out.push(i); }
        else out.push(t);
        return out;
      }

      // Gültige Schwellenwerte je Wettart.
      function thresholdRange() {
        if (state.type === 'over')  return [1, 2, 3, 4, 5];
        if (state.type === 'under') return [2, 3, 4, 5, 6];
        return [1, 2, 3, 4, 5, 6];
      }

      function renderThresh() {
        threshRow.innerHTML = '';
        thresholdRange().forEach(function (v) {
          var b = el('button', {
            class: 'cr-thresh' + (threshold() === v ? ' active' : ''),
            type: 'button',
            onclick: function () { if (!controlsDisabled) { state[state.type] = v; renderThresh(); updateInfo(); } }
          }, [String(v)]);
          b.disabled = controlsDisabled;
          threshRow.appendChild(b);
        });
      }

      function selectType(key) {
        state.type = key;
        typeBtns.forEach(function (b, i) { b.classList.toggle('active', typeDefs[i].key === key); });
        renderThresh();
        updateInfo();
      }

      function updateInfo() {
        var w = winningCount(), mult = multiplier(), t = threshold();
        multV.textContent = mult.toFixed(2) + '×';
        chanceV.textContent = Math.round(w / 6 * 100) + '% (' + w + '/6)';
        var bet = betPanel.getBet();
        winV.textContent = '+' + UI.formatCoins(Math.round(bet * mult) - bet);
        var relation = state.type === 'over' ? 'größer als' : state.type === 'under' ? 'kleiner als' : 'genau';
        descEl.innerHTML = '';
        descEl.appendChild(document.createTextNode('Der Wurf muss ' + relation + ' '));
        descEl.appendChild(el('b', {}, [String(t)]));
        descEl.appendChild(document.createTextNode(' sein — gewinnt bei '));
        descEl.appendChild(el('b', {}, [winningFaces().join(', ')]));
      }

      function setControlsDisabled(d) {
        controlsDisabled = d;
        rollBtn.disabled = d;
        betPanel.setDisabled(d);
        typeBtns.forEach(function (b) { b.disabled = d; });
        Array.prototype.forEach.call(threshRow.children, function (c) { c.disabled = d; });
      }

      function setStatus(text, cls) {
        statusEl.className = 'cr-status' + (cls ? ' ' + cls : '');
        statusEl.textContent = text;
      }

      function doRoll() {
        if (rolling) return;
        var bet = betPanel.getBet();
        if (!App.Coins.canBet(bet)) { UI.toast('Nicht genug Coins', 'lose'); return; }

        rolling = true;
        setControlsDisabled(true);
        App.Coins.add(-bet);

        // Snapshot der Wette (Controls sind gesperrt, aber sicher ist sicher).
        var snap = { type: state.type, threshold: threshold(), winning: winningCount(), mult: multiplier() };

        // Gleichverteilter Wurf 1..6.
        var result = 1 + Math.floor(Math.random() * 6);

        // Rollen: mehrere volle Umdrehungen + Ziel-Ausrichtung.
        var dur = 800 + Math.floor(Math.random() * 401); // 800..1200 ms
        revX += 4 + Math.floor(Math.random() * 3);        // 4..6 Umdrehungen
        revY += 4 + Math.floor(Math.random() * 3);
        var fx = revX * 360 + BASE[result].x;
        var fy = revY * 360 + BASE[result].y;

        setStatus('Der Würfel rollt…', null);
        if (App.Audio) App.Audio.sfx('roll');
        cube.style.transition = 'transform ' + dur + 'ms cubic-bezier(0.18,0.72,0.28,1)';
        cube.style.transform = 'rotateX(' + fx + 'deg) rotateY(' + fy + 'deg)';

        rollTimer = setTimeout(function () {
          rollTimer = null;
          resolve(bet, result, snap);
        }, dur + 40);
      }

      function resolve(bet, result, snap) {
        var won = isWin(result, snap);
        if (won) {
          var payout = Math.round(bet * snap.mult);
          App.Coins.add(payout);
          UI.flash(payout - bet);
          UI.toast('Gewonnen! Würfel zeigt ' + result, 'win');
          setStatus('🎉 Gewonnen — Würfel: ' + result, 'win');
        } else {
          UI.flash(-bet);
          UI.toast('Verloren — Würfel: ' + result, 'lose');
          setStatus('Verloren — Würfel: ' + result, 'lose');
        }
        rolling = false;
        setControlsDisabled(false);
        betPanel.refresh();
        App.Coins.settle();
        updateInfo();
      }

      // ----- Initialisierung -----
      renderThresh();
      updateInfo();

      return {
        cleanup: function () {
          if (rollTimer) { clearTimeout(rollTimer); rollTimer = null; }
        }
      };
    }
  };
})();
