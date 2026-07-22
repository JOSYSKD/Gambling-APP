/* wheel.js — "Glücksrad"
 * Ein Dreh liefert Niete oder einen Multiplikator (1.5×–10×).
 * Fair: Segmentgröße = tatsächliche Trefferchance (kein verstecktes Rigging),
 * jede Gewinn-Stufe hat denselben Erwartungswert (0.19), insgesamt 5% House-Edge:
 *   EV = 0 * 0.658 + 1.5*0.126667 + 2*0.095 + 3*0.063333 + 5*0.038 + 10*0.019 = 0.95
 */
(function () {
  'use strict';
  window.App = window.App || {};
  App.Games = App.Games || {};
  var UI = App.UI, el = UI.el;

  // Segmente in Rad-Reihenfolge (im Uhrzeigersinn ab 12-Uhr-Position).
  // prob = tatsächliche Trefferchance = exakte Segmentgröße auf dem Rad.
  var SEGMENTS = [
    { key: 'lose', mult: 0,    prob: 0.658000, label: 'Niete', color: '#0c2418' },
    { key: 'x15',  mult: 1.5,  prob: 0.126667, label: '1.5×',  color: '#173a4d' },
    { key: 'x2',   mult: 2,    prob: 0.095000, label: '2×',    color: '#0c2418' },
    { key: 'x3',   mult: 3,    prob: 0.063333, label: '3×',    color: '#173a4d' },
    { key: 'x5',   mult: 5,    prob: 0.038000, label: '5×',    color: '#3a2a08' },
    { key: 'x10',  mult: 10,   prob: 0.019000, label: '10×',   color: '#4a0d1a' }
  ];

  (function () {
    var sum = 0;
    for (var i = 0; i < SEGMENTS.length; i++) sum += SEGMENTS[i].prob;
    if (Math.abs(sum - 1) > 1e-6) throw new Error('wheel.js: Segment-Wahrscheinlichkeiten summieren nicht zu 1');
  })();

  function boundaries() {
    var out = [], acc = 0;
    for (var i = 0; i < SEGMENTS.length; i++) {
      var start = acc * 360;
      acc += SEGMENTS[i].prob;
      out.push({ seg: SEGMENTS[i], start: start, end: acc * 360 });
    }
    return out;
  }

  function conicGradient() {
    var b = boundaries();
    var stops = b.map(function (s) {
      return s.seg.color + ' ' + s.start.toFixed(4) + 'deg ' + s.end.toFixed(4) + 'deg';
    });
    return 'conic-gradient(' + stops.join(',') + ')';
  }

  // Wählt gewichtet nach den echten Wahrscheinlichkeiten (= Segmentgrößen) einen Treffer.
  function pickResult() {
    var r = Math.random();
    var acc = 0;
    for (var i = 0; i < SEGMENTS.length; i++) {
      acc += SEGMENTS[i].prob;
      if (r < acc) return { seg: SEGMENTS[i], index: i };
    }
    return { seg: SEGMENTS[SEGMENTS.length - 1], index: SEGMENTS.length - 1 };
  }

  function injectCss() {
    UI.injectStyle('game-wheel-css', [
      '.wh-wrap{display:flex;flex-direction:column;gap:18px;}',
      '.wh-scene{display:flex;align-items:center;justify-content:center;width:100%;min-height:260px;position:relative;}',
      '.wh-pointer{position:absolute;top:6px;left:50%;transform:translateX(-50%);width:0;height:0;',
      'border-left:14px solid transparent;border-right:14px solid transparent;border-top:22px solid var(--gold);',
      'filter:drop-shadow(0 0 6px rgba(255,210,63,0.7));z-index:2;}',
      '.wh-wheel{position:relative;width:240px;height:240px;border-radius:50%;',
      'border:4px solid var(--stroke-2);box-shadow:inset 0 0 30px rgba(0,0,0,0.5),0 0 22px rgba(57,255,20,0.16);',
      'transform:rotate(0deg);will-change:transform;}',
      '.wh-hub{position:absolute;left:50%;top:50%;width:34px;height:34px;transform:translate(-50%,-50%);border-radius:50%;',
      'background:radial-gradient(circle at 35% 30%,var(--neon-soft),var(--neon));box-shadow:0 0 14px rgba(57,255,20,0.85);z-index:1;}',
      '.wh-label{position:absolute;left:50%;top:50%;font-size:13px;font-weight:900;color:#eaffe2;',
      'text-shadow:0 1px 3px rgba(0,0,0,0.8);transform-origin:0 0;pointer-events:none;}',
      '.wh-readout{text-align:center;display:flex;flex-direction:column;gap:2px;}',
      '.wh-status{font-weight:800;letter-spacing:1px;min-height:22px;color:var(--muted);}',
      '.wh-status.win{color:var(--neon);text-shadow:0 0 12px rgba(57,255,20,0.65);}',
      '.wh-status.lose{color:var(--danger-2);text-shadow:0 0 12px rgba(255,77,109,0.5);}',
      '.wh-section{display:flex;flex-direction:column;gap:10px;}',
      '.wh-section-title{text-align:center;color:var(--leaf);font-weight:800;font-size:12px;text-transform:uppercase;letter-spacing:1px;}',
      '.wh-paytable{display:flex;flex-wrap:wrap;gap:8px;justify-content:center;}',
      '.wh-payitem{border:1px solid var(--stroke);border-radius:10px;padding:6px 10px;text-align:center;background:rgba(9,32,21,0.55);}',
      '.wh-payitem b{display:block;color:var(--gold);font-size:15px;}',
      '.wh-payitem span{display:block;color:var(--muted);font-size:11px;}',
      '.wh-betrow{display:flex;flex-wrap:wrap;gap:16px;align-items:flex-end;justify-content:center;}',
      '.wh-betrow .bet-panel{flex:1 1 240px;}',
      '.wh-spin{flex:1 1 240px;}',
      '@media (max-width:520px){.wh-wheel{width:200px;height:200px;}.wh-scene{min-height:220px;}}',
      '@media (prefers-reduced-motion:reduce){.wh-wheel{transition:none !important;}}'
    ].join(''));
  }

  App.Games.wheel = {
    id: 'wheel',
    title: 'Glücksrad',
    icon: '🌀',
    subtitle: 'Dreh das Rad — Niete oder Multiplikator bis 10×',

    render: function (root) {
      injectCss();

      var spinning = false;
      var controlsDisabled = false;
      var totalDeg = 0; // aufsummierte Ziel-Rotation (immer vorwärts)
      var spinTimer = null;
      var tickTimers = [];   // Segment-Ticks (werden langsamer)
      function clearTicks() { tickTimers.forEach(function (id) { clearTimeout(id); }); tickTimers = []; }

      var wheelEl = el('div', { class: 'wh-wheel' });
      wheelEl.style.background = conicGradient();

      var b = boundaries();
      b.forEach(function (s) {
        var mid = (s.start + s.end) / 2;
        var lbl = el('span', { class: 'wh-label' }, [s.seg.label]);
        lbl.style.transform = 'rotate(' + mid + 'deg) translate(0,-92px) rotate(' + (-mid) + 'deg)';
        wheelEl.appendChild(lbl);
      });
      wheelEl.appendChild(el('div', { class: 'wh-hub' }));

      var pointer = el('div', { class: 'wh-pointer' });
      var scene = el('div', { class: 'wh-scene' }, [pointer, wheelEl]);
      var statusEl = el('div', { class: 'wh-status', text: 'Setze deinen Einsatz und dreh das Rad!' });
      var stage = el('div', { class: 'game-stage' }, [
        scene,
        el('div', { class: 'wh-readout' }, [statusEl])
      ]);

      var paytable = el('div', { class: 'wh-paytable' }, SEGMENTS.map(function (s) {
        return el('div', { class: 'wh-payitem' }, [
          el('b', {}, [s.mult === 0 ? '✕' : s.mult + '×']),
          el('span', {}, [Math.round(s.prob * 1000) / 10 + '%'])
        ]);
      }));

      var controlsPanel = el('div', { class: 'glass game-panel wh-section' }, [
        el('div', { class: 'wh-section-title' }, ['Auszahlungstabelle']),
        paytable
      ]);

      var betPanel = UI.createBetPanel({ initial: 50, onChange: updateSpinSub });
      var spinSub = el('span', { class: 'btn-sub' }, ['']);
      var spinBtn = el('button', {
        class: 'btn btn-primary btn-lg btn-block wh-spin btn-2l', type: 'button',
        onclick: doSpin
      }, [
        el('span', { class: 'btn-main' }, ['🌀 Drehen']),
        spinSub
      ]);
      var betRow = el('div', { class: 'wh-betrow' }, [betPanel.root, spinBtn]);

      root.appendChild(el('div', { class: 'wh-wrap' }, [stage, controlsPanel, betRow]));

      function updateSpinSub() {
        spinSub.textContent = 'Einsatz ' + UI.formatCoins(betPanel.getBet()) + ' 🪙';
      }
      updateSpinSub();

      function setControlsDisabled(d) {
        controlsDisabled = d;
        spinBtn.disabled = d;
        betPanel.setDisabled(d);
      }

      function setStatus(text, cls) {
        statusEl.className = 'wh-status' + (cls ? ' ' + cls : '');
        statusEl.textContent = text;
      }

      function doSpin() {
        if (spinning) return;
        var bet = betPanel.getBet();
        if (!App.Coins.canBet(bet)) { UI.toast('Nicht genug Coins', 'lose'); return; }

        spinning = true;
        setControlsDisabled(true);
        App.Coins.add(-bet);

        var picked = pickResult();
        var forced = (App.Rig && App.Rig.outcome) ? App.Rig.outcome() : null;
        if (forced === 'lose') {
          for (var li = 0; li < SEGMENTS.length; li++) {
            if (SEGMENTS[li].mult === 0) { picked = { seg: SEGMENTS[li], index: li }; break; }
          }
        } else if (forced === 'win') {
          // Gewinn-Segment gewichtet nach echter Wahrscheinlichkeit ziehen.
          var pool = [], tot = 0, w;
          for (w = 0; w < SEGMENTS.length; w++) { if (SEGMENTS[w].mult > 0) { pool.push(w); tot += SEGMENTS[w].prob; } }
          var rr = Math.random() * tot, acc = 0, chosen = pool[0];
          for (w = 0; w < pool.length; w++) { acc += SEGMENTS[pool[w]].prob; if (rr < acc) { chosen = pool[w]; break; } }
          picked = { seg: SEGMENTS[chosen], index: chosen };
        }
        var seg = picked.seg;
        var range = boundaries()[picked.index];
        // Zufälliger Punkt innerhalb des Segments (mit Sicherheitsabstand zum Rand).
        var pad = Math.min(3, (range.end - range.start) * 0.15);
        var landAngle = range.start + pad + Math.random() * Math.max(0, (range.end - range.start) - 2 * pad);

        var spins = 5 + Math.floor(Math.random() * 3); // 5..7 volle Umdrehungen
        var deltaToLand = (360 - landAngle) % 360;
        totalDeg += spins * 360 + ((deltaToLand - (totalDeg % 360)) % 360 + 360) % 360;

        var dur = 3200 + Math.floor(Math.random() * 401); // 3200..3600 ms
        setStatus('Das Rad dreht sich…', null);
        wheelEl.style.transition = 'transform ' + dur + 'ms cubic-bezier(0.12,0.66,0.12,1)';
        wheelEl.style.transform = 'rotate(' + totalDeg + 'deg)';

        // Zeiger-Ticks pro passiertem Segment — werden zum Ende hin langsamer.
        clearTicks();
        if (App.Audio) {
          var tt = 0, gap = 45;
          while (tt < dur - 150) {
            tickTimers.push(setTimeout(function () { App.Audio.sfx('tick'); }, tt));
            tt += gap; gap *= 1.09;
          }
        }

        spinTimer = setTimeout(function () {
          spinTimer = null;
          resolve(bet, seg);
        }, dur + 60);
      }

      function resolve(bet, seg) {
        clearTicks();
        // Zeiger rastet ein — großer Multiplikator = Jackpot-Fanfare, sonst ein Ding.
        if (App.Audio) App.Audio.sfx(seg.mult >= 5 ? 'jackpot' : 'ding');
        var won = seg.mult > 0;
        if (won) {
          var payout = Math.round(bet * seg.mult);
          App.Coins.add(payout);
          UI.flash(payout - bet);
          UI.toast('Gewonnen! ' + seg.label, 'win');
          setStatus('🎉 Gewonnen — ' + seg.label, 'win');
        } else {
          UI.flash(-bet);
          UI.toast('Niete — verloren', 'lose');
          setStatus('Niete — verloren', 'lose');
        }
        spinning = false;
        setControlsDisabled(false);
        betPanel.refresh();
        App.Coins.settle();
      }

      return {
        cleanup: function () {
          if (spinTimer) { clearTimeout(spinTimer); spinTimer = null; }
          clearTicks();
        }
      };
    }
  };
})();
