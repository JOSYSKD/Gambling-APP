/* wheel.js — "Glücksrad"
 * Faires Multiplikator-Glücksrad: ein Dreh, ein Multiplikator (oder Niete).
 *
 * Fairness-Formel (~5% House-Edge, gleiche Konvention wie die anderen Spiele):
 *   Jede Gewinn-Stufe bekommt denselben Erwartungswert-Anteil
 *     c = HOUSE / Anzahl(Gewinn-Stufen)
 *   Ihre Trefferchance ergibt sich daraus als
 *     chance(mult) = c / mult
 *   Die verbleibende Wahrscheinlichkeit ist die Niete (0×).
 *   -> Erwartungswert über alle Segmente = HOUSE, unabhängig vom Ausgang.
 * Das Rad ist ein echter Kreis: jedes Segment ist exakt so groß (in Grad) wie
 * seine Trefferchance, der Dreh-Winkel wird gleichverteilt 0–360° gewürfelt.
 */
(function () {
  'use strict';
  window.App = window.App || {};
  App.Games = App.Games || {};
  var UI = App.UI, el = UI.el;

  var HOUSE = 0.95; // 5% House-Edge
  var WIN_TIERS = [1.5, 2, 3, 5, 10];
  var COLORS = { 0: '#14150f', 1.5: '#0e7b3a', 2: '#159947', 3: '#33e6d0', 5: '#ffd23f', 10: '#e0344c' };

  var SEGMENTS = (function () {
    var c = HOUSE / WIN_TIERS.length;
    var segs = WIN_TIERS.map(function (m) { return { mult: m, prob: c / m }; });
    var winSum = segs.reduce(function (s, x) { return s + x.prob; }, 0);
    segs.unshift({ mult: 0, prob: 1 - winSum });

    var cum = 0;
    segs.forEach(function (s, i) {
      s.color = COLORS[s.mult];
      s.startDeg = cum;
      cum += s.prob * 360;
      s.endDeg = i === segs.length - 1 ? 360 : cum;
    });
    return segs;
  })();

  function segAt(deg) {
    for (var i = 0; i < SEGMENTS.length; i++) {
      if (deg >= SEGMENTS[i].startDeg && deg < SEGMENTS[i].endDeg) return SEGMENTS[i];
    }
    return SEGMENTS[SEGMENTS.length - 1];
  }

  function segLabel(s) { return s.mult === 0 ? 'NIETE' : (s.mult + '×'); }

  App.Games.wheel = {
    id: 'wheel',
    title: 'Glücksrad',
    icon: '🌀',
    subtitle: 'Ein Dreh, ein fairer Multiplikator — von Niete bis 10×',

    render: function (root) {
      injectCSS();

      /* ---------------- Zustand ---------------- */
      var spinning = false;
      var spinTimer = null;
      var rotation = 0;    // aktueller Rad-Drehwinkel (wächst monoton)
      var history = [];    // letzte Ergebnisse

      /* ---------------- Rad + Zeiger ---------------- */
      var wheel = el('div', { class: 'wg-wheel' });
      wheel.style.background = buildWheelGradient();
      SEGMENTS.forEach(function (s) {
        var mid = (s.startDeg + s.endDeg) / 2;
        var lab = el('span', { class: 'wg-label', text: segLabel(s) });
        lab.style.color = s.mult === 0 ? '#7ba692' : '#04160c';
        lab.style.transform =
          'translate(-50%,-50%) rotate(' + mid + 'deg) translateY(calc(-1 * var(--r))) rotate(' + (-mid) + 'deg)';
        wheel.appendChild(lab);
      });
      wheel.appendChild(el('div', { class: 'wg-hub' }, ['🌀']));

      var wheelWrap = el('div', { class: 'wg-wheel-wrap' }, [
        el('div', { class: 'wg-pointer' }),
        wheel
      ]);

      /* ---------------- Ergebnis-Anzeige ---------------- */
      var resultBadge = el('div', { class: 'wg-result-badge', text: '–' });
      var resultText  = el('div', { class: 'wg-result-text hint-text', text: 'Setze deinen Einsatz und dreh das Rad.' });
      var resultBox   = el('div', { class: 'wg-result' }, [resultBadge, resultText]);

      /* ---------------- Historie ---------------- */
      var historyRow = el('div', { class: 'wg-history' });
      renderHistory();

      var stage = el('div', { class: 'game-stage wg-stage' }, [
        wheelWrap, resultBox, historyRow
      ]);

      /* ---------------- Einsatz + Drehen ---------------- */
      var betPanel = UI.createBetPanel({ initial: 50 });
      var spinBtn = el('button', {
        class: 'btn btn-primary btn-lg wg-spin', type: 'button', onclick: doSpin
      }, ['🌀 Drehen']);

      var controls = el('div', { class: 'game-panel glass wg-controls' }, [
        el('div', { class: 'controls-row' }, [betPanel.root, spinBtn])
      ]);

      /* ---------------- Auszahlungs-Tabelle ---------------- */
      var payTable = el('table', { class: 'payout-table wg-pay' }, [
        el('tbody', {}, SEGMENTS.map(function (s) {
          return payRow(segLabel(s), ((s.endDeg - s.startDeg) / 360 * 100).toFixed(2) + '%');
        }))
      ]);
      var payBox = el('div', { class: 'game-panel glass wg-paybox' }, [
        el('div', { class: 'wg-field-title' }, ['Auszahlungen & Chancen']),
        payTable,
        el('p', { class: 'hint-text' }, ['Jede Gewinn-Stufe hat denselben Erwartungswert · House-Edge ' + Math.round((1 - HOUSE) * 100) + '%'])
      ]);

      root.appendChild(el('div', { class: 'wg-wrap' }, [
        stage, controls, payBox
      ]));

      /* ---------------- Ablauf ---------------- */
      function setLocked(lock) {
        spinning = lock;
        spinBtn.disabled = lock;
        betPanel.setDisabled(lock);
      }

      function doSpin() {
        if (spinning) return;
        var bet = betPanel.getBet();
        if (!App.Coins.canBet(bet)) { UI.toast('Nicht genug Coins', 'lose'); return; }

        setLocked(true);
        App.Coins.add(-bet);
        resultText.textContent = 'Das Rad dreht …';

        // Landewinkel gleichverteilt 0–360° — bestimmt Segment UND Ziel-Ausrichtung zugleich.
        var landing = Math.random() * 360;
        var seg = segAt(landing);

        // Rad so drehen, dass der Landewinkel oben unter dem Zeiger landet.
        var desired = ((360 - landing) % 360 + 360) % 360;
        var curMod  = ((rotation % 360) + 360) % 360;
        var delta   = ((desired - curMod) % 360 + 360) % 360;
        var turns   = 4 + Math.floor(Math.random() * 3); // 4–6 volle Runden
        rotation += turns * 360 + delta;

        wheel.style.transition = 'transform 2.8s cubic-bezier(.15,.82,.24,1)';
        wheel.style.transform = 'rotate(' + rotation + 'deg)';

        spinTimer = setTimeout(function () { finish(seg, bet); }, 2950);
      }

      function finish(seg, bet) {
        spinTimer = null;
        var won = seg.mult > 0;
        var payout = won ? Math.round(bet * seg.mult) : 0;

        resultBadge.textContent = segLabel(seg);
        resultBadge.style.background = seg.color;
        resultBadge.style.color = seg.mult === 0 ? '#eafff0' : '#04160c';
        resultBadge.className = 'wg-result-badge pop';

        history.unshift(seg);
        if (history.length > 10) history.pop();
        renderHistory();

        if (won) {
          App.Coins.add(payout);
          UI.flash(payout - bet);
          UI.toast('Gewonnen! ' + segLabel(seg), 'win');
          resultText.innerHTML = '<b class="wg-won">GEWONNEN</b> · ' + segLabel(seg) + ' · +' + UI.formatCoins(payout - bet) + ' 🪙';
        } else {
          UI.flash(-bet);
          UI.toast('Verloren — Niete', 'lose');
          resultText.innerHTML = '<b class="wg-lost">VERLOREN</b> · Niete';
        }

        setLocked(false);
        betPanel.refresh();
        App.Coins.settle();
      }

      function renderHistory() {
        historyRow.textContent = '';
        historyRow.appendChild(el('span', { class: 'wg-hist-l' }, ['Letzte:']));
        if (!history.length) {
          historyRow.appendChild(el('span', { class: 'wg-hist-empty' }, ['—']));
          return;
        }
        history.forEach(function (s) {
          var chip = el('span', { class: 'wg-chip', text: segLabel(s) });
          chip.style.background = s.color;
          chip.style.color = s.mult === 0 ? '#eafff0' : '#04160c';
          historyRow.appendChild(chip);
        });
      }

      return {
        cleanup: function () {
          if (spinTimer) { clearTimeout(spinTimer); spinTimer = null; }
          spinning = false;
        }
      };
    }
  };

  /* ---------------- Helfer ---------------- */
  function payRow(what, odds) {
    return el('tr', {}, [
      el('td', {}, [what]),
      el('td', { class: 'wg-odds' }, [odds])
    ]);
  }

  function buildWheelGradient() {
    var stops = SEGMENTS.map(function (s) {
      return s.color + ' ' + s.startDeg.toFixed(3) + 'deg ' + s.endDeg.toFixed(3) + 'deg';
    });
    return 'conic-gradient(from 0deg, ' + stops.join(', ') + ')';
  }

  function injectCSS() {
    UI.injectStyle('game-wheel-css', [
      '.wg-wrap{display:flex;flex-direction:column;gap:16px;}',
      '.wg-stage{gap:16px;}',

      /* Rad */
      '.wg-wheel-wrap{position:relative;display:flex;align-items:center;justify-content:center;padding-top:14px;}',
      '.wg-wheel{--size:clamp(210px,60vw,280px);--r:calc(var(--size)/2 - 30px);',
      'position:relative;width:var(--size);height:var(--size);border-radius:50%;',
      'box-shadow:0 0 0 8px #06170f,0 0 0 11px rgba(57,255,20,.35),inset 0 0 26px rgba(0,0,0,.6),0 12px 34px rgba(0,0,0,.5);',
      'transition:transform 2.8s cubic-bezier(.15,.82,.24,1);will-change:transform;}',
      '.wg-label{position:absolute;left:50%;top:50%;transform-origin:50% 50%;font-size:13px;font-weight:900;',
      'text-shadow:0 1px 2px rgba(0,0,0,.35);font-variant-numeric:tabular-nums;pointer-events:none;line-height:1;}',
      '.wg-hub{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:30%;height:30%;border-radius:50%;',
      'display:grid;place-items:center;font-size:clamp(18px,6vw,26px);',
      'background:radial-gradient(circle at 40% 35%,#0e3521,#04120b);border:2px solid rgba(57,255,20,.5);',
      'box-shadow:inset 0 0 16px rgba(0,0,0,.7),0 0 14px rgba(57,255,20,.3);}',
      '.wg-pointer{position:absolute;top:0;left:50%;transform:translateX(-50%);z-index:5;',
      'width:0;height:0;border-left:13px solid transparent;border-right:13px solid transparent;',
      'border-top:22px solid var(--gold);filter:drop-shadow(0 2px 5px rgba(0,0,0,.6)) drop-shadow(0 0 8px rgba(255,210,63,.6));}',

      /* Ergebnis */
      '.wg-result{display:flex;align-items:center;gap:12px;flex-wrap:wrap;justify-content:center;}',
      '.wg-result-badge{min-width:64px;height:44px;padding:0 12px;border-radius:14px;display:grid;place-items:center;',
      'font-size:18px;font-weight:900;color:#eafff0;background:#14150f;text-shadow:0 1px 3px rgba(0,0,0,.7);border:2px solid rgba(255,255,255,.18);}',
      '.wg-result-badge.pop{animation:wg-pop .45s ease;}',
      '@keyframes wg-pop{0%{transform:scale(.4);opacity:0}60%{transform:scale(1.15)}100%{transform:scale(1)}}',
      '.wg-result-text{margin:0;}',
      '.wg-won{color:var(--neon);} .wg-lost{color:var(--danger-2);}',

      /* Historie */
      '.wg-history{display:flex;align-items:center;gap:6px;flex-wrap:wrap;justify-content:center;}',
      '.wg-hist-l{color:var(--muted);font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:1px;}',
      '.wg-hist-empty{color:var(--muted);}',
      '.wg-chip{min-width:34px;height:26px;padding:0 6px;border-radius:8px;display:grid;place-items:center;',
      'font-size:12px;font-weight:800;border:1px solid rgba(255,255,255,.18);}',

      '.wg-controls{display:flex;flex-direction:column;gap:12px;}',
      '.wg-spin{min-width:150px;}',
      '.wg-field-title{font-size:13px;font-weight:800;color:var(--leaf);text-transform:uppercase;letter-spacing:1px;}',
      '.wg-odds{color:var(--gold);font-weight:800;text-align:right;white-space:nowrap;}',
      '.wg-paybox{display:flex;flex-direction:column;gap:10px;}'
    ].join(''));
  }
})();
