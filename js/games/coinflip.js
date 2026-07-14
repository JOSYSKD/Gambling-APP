/* coinflip.js — "Coinflip"
 * Klassischer Münzwurf: Kopf oder Zahl, 50/50-Chance.
 * Faire Auszahlung mit ~4% House-Edge (gleiche Konvention wie Cube-Roll):
 *   multiplier = 2 * HOUSE
 * Echte CSS-3D-Münze, die sich beim Wurf dreht und auf der getroffenen Seite stehen bleibt.
 */
(function () {
  'use strict';
  window.App = window.App || {};
  App.Games = App.Games || {};
  var UI = App.UI, el = UI.el;

  var HOUSE = 0.96;          // 4% House-Edge
  var MULT = 2 * HOUSE;      // 1.92×

  var SIDES = {
    kopf: { label: 'Kopf', icon: '🦁' },
    zahl: { label: 'Zahl', icon: '🍃' }
  };

  function injectCss() {
    UI.injectStyle('game-coinflip-css', [
      '.cf-wrap{display:flex;flex-direction:column;gap:18px;}',
      '.cf-scene{perspective:760px;display:flex;align-items:center;justify-content:center;width:100%;min-height:190px;animation:cf-bob 3.6s ease-in-out infinite;}',
      '.cf-coin{position:relative;width:140px;height:140px;transform-style:preserve-3d;transform:rotateY(0deg);will-change:transform;}',
      '.cf-face{position:absolute;left:0;top:0;width:140px;height:140px;border-radius:50%;backface-visibility:hidden;',
      'display:grid;place-items:center;font-size:60px;border:3px solid rgba(255,255,255,.18);',
      'box-shadow:inset 0 0 24px rgba(0,0,0,.35),0 0 18px rgba(57,255,20,0.16);}',
      '.cf-face-front{transform:rotateY(0deg) translateZ(1px);background:radial-gradient(120% 120% at 30% 22%,#ffe58a,#c8971f);}',
      '.cf-face-back{transform:rotateY(180deg) translateZ(1px);background:radial-gradient(120% 120% at 30% 22%,#7ff3e6,#0e7b6f);}',
      '.cf-readout{text-align:center;display:flex;flex-direction:column;gap:2px;}',
      '.cf-status{font-weight:800;letter-spacing:1px;min-height:22px;color:var(--muted);}',
      '.cf-status.win{color:var(--neon);text-shadow:0 0 12px rgba(57,255,20,0.65);}',
      '.cf-status.lose{color:var(--danger-2);text-shadow:0 0 12px rgba(255,77,109,0.5);}',
      '.cf-section{display:flex;flex-direction:column;gap:10px;}',
      '.cf-section-title{text-align:center;color:var(--leaf);font-weight:800;font-size:12px;text-transform:uppercase;letter-spacing:1px;}',
      '.cf-sides{display:flex;gap:10px;flex-wrap:wrap;justify-content:center;}',
      '.cf-sidebtn{flex:1 1 130px;min-width:120px;}',
      '.cf-sidebtn.active{color:#04160c;background:linear-gradient(180deg,var(--neon-soft),var(--neon));border-color:var(--neon);box-shadow:var(--glow);}',
      '.cf-info{display:flex;flex-wrap:wrap;gap:10px 22px;justify-content:center;}',
      '.cf-info-item{text-align:center;}',
      '.cf-info-l{display:block;color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:1px;}',
      '.cf-info-v{font-size:22px;font-weight:900;color:var(--leaf);font-variant-numeric:tabular-nums;}',
      '.cf-info-v.aqua{color:var(--aqua-soft);}',
      '.cf-info-v.gold{color:var(--gold);}',
      '.cf-betrow{display:flex;flex-wrap:wrap;gap:16px;align-items:flex-end;justify-content:center;}',
      '.cf-betrow .bet-panel{flex:1 1 240px;}',
      '.cf-flip{flex:1 1 240px;}',
      '@keyframes cf-bob{0%,100%{transform:translateY(0);}50%{transform:translateY(-7px);}}',
      '@media (max-width:520px){.cf-scene{transform:scale(0.92);}}',
      '@media (prefers-reduced-motion:reduce){.cf-scene{animation:none;}}'
    ].join(''));
  }

  App.Games.coinflip = {
    id: 'coinflip',
    title: 'Coinflip',
    icon: '🪙',
    subtitle: 'Kopf oder Zahl — 50/50 auf den Wurf',

    render: function (root) {
      injectCss();

      // ----- Zustand -----
      var state = { side: 'kopf' };
      var flipping = false;
      var controlsDisabled = false;
      var revY = 0;              // aufsummierte Umdrehungen (immer vorwärts)
      var flipTimer = null;

      // ----- Münze -----
      var coin = el('div', { class: 'cf-coin' }, [
        el('div', { class: 'cf-face cf-face-front' }, [SIDES.kopf.icon]),
        el('div', { class: 'cf-face cf-face-back' }, [SIDES.zahl.icon])
      ]);
      var scene = el('div', { class: 'cf-scene' }, [coin]);
      var statusEl = el('div', { class: 'cf-status', text: 'Wähle Kopf oder Zahl und wirf!' });
      var stage = el('div', { class: 'game-stage' }, [
        scene,
        el('div', { class: 'cf-readout' }, [statusEl])
      ]);

      // ----- Seiten-Buttons -----
      var sideBtns = Object.keys(SIDES).map(function (key) {
        var s = SIDES[key];
        return el('button', {
          class: 'btn cf-sidebtn' + (state.side === key ? ' active' : ''),
          type: 'button',
          onclick: function () { if (!controlsDisabled) selectSide(key); }
        }, [s.icon + ' ' + s.label]);
      });
      var sideKeys = Object.keys(SIDES);
      var sideRow = el('div', { class: 'cf-sides' }, sideBtns);

      // ----- Live-Info -----
      var multV   = el('div', { class: 'cf-info-v gold', text: MULT.toFixed(2) + '×' });
      var chanceV = el('div', { class: 'cf-info-v aqua', text: '50%' });
      var winV    = el('div', { class: 'cf-info-v' });
      var infoRow = el('div', { class: 'cf-info' }, [
        el('div', { class: 'cf-info-item' }, [el('span', { class: 'cf-info-l' }, ['Auszahlung']), multV]),
        el('div', { class: 'cf-info-item' }, [el('span', { class: 'cf-info-l' }, ['Gewinnchance']), chanceV]),
        el('div', { class: 'cf-info-item' }, [el('span', { class: 'cf-info-l' }, ['Möglicher Gewinn']), winV])
      ]);

      var controlsPanel = el('div', { class: 'glass game-panel cf-section' }, [
        el('div', { class: 'cf-section-title' }, ['Deine Seite']),
        sideRow,
        infoRow
      ]);

      // ----- Einsatz + Werfen -----
      var betPanel = UI.createBetPanel({ initial: 50, onChange: updateInfo });
      var flipBtn = el('button', {
        class: 'btn btn-primary btn-lg btn-block cf-flip', type: 'button',
        onclick: doFlip
      }, ['🪙 Werfen']);
      var betRow = el('div', { class: 'cf-betrow' }, [betPanel.root, flipBtn]);

      root.appendChild(el('div', { class: 'cf-wrap' }, [stage, controlsPanel, betRow]));

      // ----- Logik -----
      function selectSide(key) {
        state.side = key;
        sideBtns.forEach(function (b, i) { b.classList.toggle('active', sideKeys[i] === key); });
        updateInfo();
      }

      function updateInfo() {
        var bet = betPanel.getBet();
        winV.textContent = '+' + UI.formatCoins(Math.round(bet * MULT) - bet);
      }

      function setControlsDisabled(d) {
        controlsDisabled = d;
        flipBtn.disabled = d;
        betPanel.setDisabled(d);
        sideBtns.forEach(function (b) { b.disabled = d; });
      }

      function setStatus(text, cls) {
        statusEl.className = 'cf-status' + (cls ? ' ' + cls : '');
        statusEl.textContent = text;
      }

      function doFlip() {
        if (flipping) return;
        var bet = betPanel.getBet();
        if (!App.Coins.canBet(bet)) { UI.toast('Nicht genug Coins', 'lose'); return; }

        flipping = true;
        setControlsDisabled(true);
        App.Coins.add(-bet);

        // Snapshot der Wette (Controls sind gesperrt, aber sicher ist sicher).
        var snap = { side: state.side, mult: MULT };

        // Gleichverteilter Wurf 50/50.
        var result = Math.random() < 0.5 ? 'kopf' : 'zahl';

        // Drehen: mehrere volle Umdrehungen + Ziel-Ausrichtung (0° = Kopf, 180° = Zahl).
        var dur = 800 + Math.floor(Math.random() * 401); // 800..1200 ms
        revY += 4 + Math.floor(Math.random() * 3);        // 4..6 Umdrehungen
        var target = revY * 360 + (result === 'zahl' ? 180 : 0);

        setStatus('Die Münze dreht sich…', null);
        coin.style.transition = 'transform ' + dur + 'ms cubic-bezier(0.18,0.72,0.28,1)';
        coin.style.transform = 'rotateY(' + target + 'deg)';

        flipTimer = setTimeout(function () {
          flipTimer = null;
          resolve(bet, result, snap);
        }, dur + 40);
      }

      function resolve(bet, result, snap) {
        var won = result === snap.side;
        var resultLabel = SIDES[result].icon + ' ' + SIDES[result].label;
        if (won) {
          var payout = Math.round(bet * snap.mult);
          App.Coins.add(payout);
          UI.flash(payout - bet);
          UI.toast('Gewonnen! ' + resultLabel, 'win');
          setStatus('🎉 Gewonnen — ' + resultLabel, 'win');
        } else {
          UI.flash(-bet);
          UI.toast('Verloren — ' + resultLabel, 'lose');
          setStatus('Verloren — ' + resultLabel, 'lose');
        }
        flipping = false;
        setControlsDisabled(false);
        betPanel.refresh();
        App.Coins.settle();
        updateInfo();
      }

      // ----- Initialisierung -----
      updateInfo();

      return {
        cleanup: function () {
          if (flipTimer) { clearTimeout(flipTimer); flipTimer = null; }
        }
      };
    }
  };
})();
