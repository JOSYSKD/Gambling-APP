/* scratch.js — "Rubbellos"
 * Los kaufen, 9 Felder mit dem Finger/der Maus freirubbeln (Canvas-Kratzschicht).
 * 3 gleiche Symbole auf dem Los → Einsatz × Symbol-Multiplikator.
 *
 * Fairness: Erst wird die Gewinnklasse gezogen, dann werden die Symbole passend
 * aufs Los verteilt (Niete = kein Symbol 3×). RTP der Gewinntabelle: ~95,9 %,
 * Trefferquote ~27 % — gleiche House-Edge-Klasse wie Coinflip/Cube-Roll.
 */
(function () {
  'use strict';
  window.App = window.App || {};
  App.Games = App.Games || {};
  var UI = App.UI, el = UI.el;

  // Gewinntabelle: Wahrscheinlichkeit p, dass GENAU dieses Symbol 3× erscheint.
  // Summe p*mult = 0.959 → ~4% House-Edge. Rest (73,1%) ist eine Niete.
  var PRIZES = [
    { sym: '🌴', mult: 1.5, p: 0.126 },
    { sym: '🍌', mult: 2.5, p: 0.08 },
    { sym: '🍀', mult: 5,   p: 0.04 },
    { sym: '🔔', mult: 10,  p: 0.015 },
    { sym: '🏆', mult: 20,  p: 0.006 },
    { sym: '💎', mult: 50,  p: 0.002 }
  ];
  var CELLS = 9;          // 3×3-Los
  var REVEAL_AT = 0.55;   // Anteil freigerubbelter Fläche, ab dem das Feld aufspringt
  var CV = 96;            // interne Canvas-Auflösung der Kratzschicht

  function injectCss() {
    UI.injectStyle('game-scratch-css', [
      '.scr-wrap{display:flex;flex-direction:column;gap:18px;}',
      '.scr-card{margin:0 auto;padding:16px;border-radius:18px;max-width:360px;width:100%;',
      'background:linear-gradient(160deg,#123a26,#071a10);border:1px solid var(--stroke-2);',
      'box-shadow:inset 0 0 30px rgba(57,255,20,0.10),0 0 18px rgba(57,255,20,0.12);}',
      '.scr-card-title{text-align:center;font-weight:900;letter-spacing:2px;color:var(--gold);',
      'text-transform:uppercase;font-size:13px;margin-bottom:12px;}',
      '.scr-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;}',
      '.scr-cell{position:relative;aspect-ratio:1;border-radius:12px;overflow:hidden;',
      'background:radial-gradient(120% 120% at 30% 22%,#0d2f1d,#04120a);border:1px solid var(--stroke-2);}',
      '.scr-sym{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:34px;}',
      '.scr-cell.win .scr-sym{animation:scr-pop 0.5s ease;filter:drop-shadow(0 0 10px rgba(57,255,20,0.9));}',
      '.scr-foil{position:absolute;inset:0;width:100%;height:100%;touch-action:none;cursor:crosshair;',
      'transition:opacity 0.35s ease;}',
      '.scr-foil.gone{opacity:0;pointer-events:none;}',
      '.scr-status{text-align:center;font-weight:800;letter-spacing:1px;min-height:22px;color:var(--muted);}',
      '.scr-status.win{color:var(--neon);text-shadow:0 0 12px rgba(57,255,20,0.65);}',
      '.scr-status.lose{color:var(--danger-2);text-shadow:0 0 12px rgba(255,77,109,0.5);}',
      '.scr-pays{display:flex;flex-wrap:wrap;gap:6px 14px;justify-content:center;}',
      '.scr-pay{display:flex;align-items:center;gap:4px;font-weight:800;color:var(--leaf);',
      'font-variant-numeric:tabular-nums;font-size:13px;}',
      '.scr-pay b{color:var(--gold);font-weight:900;}',
      '.scr-betrow{display:flex;flex-wrap:wrap;gap:16px;align-items:flex-end;justify-content:center;}',
      '.scr-betrow .bet-panel{flex:1 1 240px;}',
      '.scr-buy{flex:1 1 240px;}',
      '@keyframes scr-pop{0%{transform:scale(1);}45%{transform:scale(1.45);}100%{transform:scale(1);}}',
      '@media (prefers-reduced-motion:reduce){.scr-cell.win .scr-sym{animation:none;}}'
    ].join(''));
  }

  // Fisher-Yates auf einer Kopie
  function shuffled(arr) {
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  /** Zieht die Gewinnklasse (oder null = Niete) und baut die 9 Los-Symbole.
   *  Füll-Symbole kommen höchstens 2× vor, damit nie ein zweiter Drilling entsteht. */
  function makeTicket() {
    var forced = (App.Rig && App.Rig.outcome) ? App.Rig.outcome() : null;
    var prize = null;
    if (forced === 'win') {
      // Unter den Gewinnklassen proportional zu ihren Wahrscheinlichkeiten ziehen
      var total = 0, i;
      for (i = 0; i < PRIZES.length; i++) total += PRIZES[i].p;
      var r = Math.random() * total;
      for (i = 0; i < PRIZES.length; i++) { r -= PRIZES[i].p; if (r <= 0) { prize = PRIZES[i]; break; } }
      if (!prize) prize = PRIZES[0];
    } else if (forced !== 'lose') {
      var roll = Math.random();
      for (var k = 0; k < PRIZES.length; k++) {
        roll -= PRIZES[k].p;
        if (roll <= 0) { prize = PRIZES[k]; break; }
      }
    }

    var fillPool = [];
    PRIZES.forEach(function (pr) {
      if (!prize || pr.sym !== prize.sym) fillPool.push(pr.sym, pr.sym);
    });
    var syms;
    if (prize) {
      syms = shuffled([prize.sym, prize.sym, prize.sym].concat(shuffled(fillPool).slice(0, CELLS - 3)));
    } else {
      syms = shuffled(fillPool).slice(0, CELLS);
    }
    return { prize: prize, syms: syms };
  }

  App.Games.scratch = {
    id: 'scratch',
    title: 'Rubbellos',
    icon: '🎟️',
    subtitle: 'Los kaufen, freirubbeln — 3 gleiche Symbole gewinnen',

    render: function (root) {
      injectCss();

      var ticket = null;       // aktuelles Los (null = keins aktiv)
      var bet = 0;             // bezahlter Einsatz des aktiven Loses
      var revealedCount = 0;
      var cleanups = [];       // Pointer-Listener der Kratzschichten

      // ----- Los-Karte -----
      var cells = [], foils = [], symEls = [];
      for (var i = 0; i < CELLS; i++) {
        var sym = el('div', { class: 'scr-sym' }, ['']);
        var foil = document.createElement('canvas');
        foil.className = 'scr-foil gone';
        foil.width = CV; foil.height = CV;
        symEls.push(sym); foils.push(foil);
        cells.push(el('div', { class: 'scr-cell' }, [sym, foil]));
      }
      var statusEl = el('div', { class: 'scr-status', text: 'Kauf ein Los und rubbel die Felder frei!' });
      var stage = el('div', { class: 'game-stage' }, [
        el('div', { class: 'scr-card' }, [
          el('div', { class: 'scr-card-title' }, ['🌴 Jungle-Rubbellos 🌴']),
          el('div', { class: 'scr-grid' }, cells)
        ]),
        statusEl
      ]);

      // ----- Gewinntabelle -----
      var payRow = el('div', { class: 'scr-pays' }, PRIZES.map(function (pr) {
        return el('span', { class: 'scr-pay' }, [pr.sym + '×3 ', el('b', {}, ['×' + pr.mult])]);
      }));
      var paysPanel = el('div', { class: 'glass game-panel' }, [payRow]);

      // ----- Einsatz + Kaufen / Aufdecken -----
      var betPanel = UI.createBetPanel({ initial: 50, onChange: updateBuyLabel });
      var buySub = el('span', { class: 'btn-sub' }, ['']);
      var buyBtn = el('button', {
        class: 'btn btn-primary btn-lg btn-block scr-buy btn-2l', type: 'button', onclick: buy
      }, [el('span', { class: 'btn-main' }, ['🎟️ Los kaufen']), buySub]);
      var revealBtn = el('button', {
        class: 'btn btn-ghost', type: 'button', disabled: true, onclick: revealAll
      }, ['⚡ Alles aufdecken']);
      var betRow = el('div', { class: 'scr-betrow' }, [betPanel.root, buyBtn]);

      root.appendChild(el('div', { class: 'scr-wrap' }, [stage, paysPanel, betRow, revealBtn]));

      // ----- Kratzschicht -----
      function paintFoil(cv) {
        var ctx = cv.getContext('2d');
        ctx.globalCompositeOperation = 'source-over';
        var g = ctx.createLinearGradient(0, 0, CV, CV);
        g.addColorStop(0, '#8f9aa8'); g.addColorStop(0.5, '#c9d2dc'); g.addColorStop(1, '#77828f');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, CV, CV);
        ctx.fillStyle = 'rgba(20,30,25,0.75)';
        ctx.font = '900 30px sans-serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText('?', CV / 2, CV / 2 + 2);
      }

      /** Anteil weggekratzter Pixel (Alpha-Sampling, jedes 8. Pixel reicht). */
      function clearedRatio(ctx) {
        var d = ctx.getImageData(0, 0, CV, CV).data;
        var gone = 0, n = 0;
        for (var p = 3; p < d.length; p += 32) { n++; if (d[p] < 40) gone++; }
        return gone / n;
      }

      function armFoil(cv, idx) {
        var ctx = cv.getContext('2d');
        var down = false, strokes = 0;
        function scratchAt(ev) {
          var r = cv.getBoundingClientRect();
          var x = (ev.clientX - r.left) / r.width * CV;
          var y = (ev.clientY - r.top) / r.height * CV;
          ctx.globalCompositeOperation = 'destination-out';
          ctx.beginPath();
          ctx.arc(x, y, 13, 0, Math.PI * 2);
          ctx.fill();
          if (++strokes % 6 === 0 && clearedRatio(ctx) > REVEAL_AT) reveal(idx);
        }
        function onDown(ev) { down = true; cv.setPointerCapture(ev.pointerId); scratchAt(ev); }
        function onMove(ev) { if (down) scratchAt(ev); }
        function onUp() {
          if (down && clearedRatio(ctx) > REVEAL_AT) reveal(idx);
          down = false;
        }
        cv.addEventListener('pointerdown', onDown);
        cv.addEventListener('pointermove', onMove);
        cv.addEventListener('pointerup', onUp);
        cv.addEventListener('pointercancel', onUp);
        cleanups.push(function () {
          cv.removeEventListener('pointerdown', onDown);
          cv.removeEventListener('pointermove', onMove);
          cv.removeEventListener('pointerup', onUp);
          cv.removeEventListener('pointercancel', onUp);
        });
      }

      function disarmFoils() {
        cleanups.forEach(function (fn) { fn(); });
        cleanups = [];
      }

      // ----- Logik -----
      function updateBuyLabel() {
        buySub.textContent = 'Einsatz ' + UI.formatCoins(betPanel.getBet()) + ' 🪙';
      }

      function setStatus(text, cls) {
        statusEl.className = 'scr-status' + (cls ? ' ' + cls : '');
        statusEl.textContent = text;
      }

      function buy() {
        if (ticket) return;
        var b = betPanel.getBet();
        if (!App.Coins.canBet(b)) { UI.toast('Nicht genug Coins', 'lose'); return; }
        App.Coins.add(-b);
        bet = b;
        ticket = makeTicket();
        revealedCount = 0;

        cells.forEach(function (c) { c.classList.remove('win'); });
        symEls.forEach(function (s, idx) { s.textContent = ticket.syms[idx]; });
        foils.forEach(function (cv, idx) {
          paintFoil(cv);
          cv.classList.remove('gone');
          armFoil(cv, idx);
        });
        buyBtn.disabled = true;
        betPanel.setDisabled(true);
        revealBtn.disabled = false;
        setStatus('Rubbel los! 3 gleiche Symbole gewinnen.', null);
        if (App.Audio) App.Audio.sfx('ding');
      }

      function reveal(idx) {
        var cv = foils[idx];
        if (cv.classList.contains('gone')) return;
        cv.classList.add('gone');
        revealedCount++;
        if (revealedCount >= CELLS) resolve();
      }

      function revealAll() {
        if (!ticket) return;
        // Kleine Kaskade statt alles auf einmal — fühlt sich nach Aufreißen an
        var order = [];
        for (var i = 0; i < CELLS; i++) if (!foils[i].classList.contains('gone')) order.push(i);
        order.forEach(function (idx, n) {
          setTimeout(function () { reveal(idx); }, n * 90);
        });
        revealBtn.disabled = true;
      }

      function resolve() {
        disarmFoils();
        var t = ticket;
        ticket = null;
        if (t.prize) {
          // Drilling hervorheben
          t.syms.forEach(function (s, idx) {
            if (s === t.prize.sym) cells[idx].classList.add('win');
          });
          var payout = Math.round(bet * t.prize.mult);
          App.Coins.add(payout);
          UI.flash(payout - bet);
          UI.toast('Drilling ' + t.prize.sym + ' — ×' + t.prize.mult + '!', 'win');
          setStatus('🎉 ' + t.prize.sym + '×3 — Gewinn ×' + t.prize.mult, 'win');
          if (App.Audio) App.Audio.sweep(400, 900, 0.4, { type: 'triangle', peak: 0.08, filter: 2600 });
        } else {
          UI.flash(-bet);
          UI.toast('Niete — kein Drilling', 'lose');
          setStatus('Niete — kein Drilling. Neues Los, neues Glück!', 'lose');
        }
        buyBtn.disabled = false;
        betPanel.setDisabled(false);
        revealBtn.disabled = true;
        betPanel.refresh();
        App.Coins.settle();
        updateBuyLabel();
      }

      // ----- Initialisierung -----
      updateBuyLabel();

      return {
        cleanup: function () { disarmFoils(); }
      };
    }
  };
})();
