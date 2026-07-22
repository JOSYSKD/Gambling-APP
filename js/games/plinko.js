/* plinko.js — "Plinko": Kugel fällt durch ein Peg-Dreieck in einen Slot.
 *
 * 12 Reihen Pegs, unten 13 Slots. Pro Reihe geht die Kugel mit je 50 %
 * nach links oder rechts. Der Slot-Index = Anzahl der "Rechts"-Schritte
 * (0..12) -> Binomialverteilung (Mitte wahrscheinlich, Rand selten), was
 * genau zur Multiplikator-Tabelle passt.
 *
 * Auszahlung: brutto = round(bet * slotMultiplikator) (inkl. Einsatz).
 *   Rand (0/12) = 15x, Mitte (6) = 0.4x.  Erwartungswert ~ 0.965 -> House-Edge.
 */
(function () {
  'use strict';
  window.App = window.App || {};
  App.Games = App.Games || {};
  var UI = App.UI, el = UI.el;

  var ROWS = 12;                 // Peg-Reihen / Entscheidungen
  var SLOTS = ROWS + 1;          // 13 Slots
  var MULTS = [15, 4, 2, 1.2, 1, 0.6, 0.4, 0.6, 1, 1.2, 2, 4, 15];

  var SEG_MS = 108;              // Dauer pro Fall-Segment
  var TOTAL_SEG = ROWS + 1;      // Intro-Drop + 12 Bounces

  function injectCss() {
    UI.injectStyle('game-plinko-css', [
      '.pk-wrap{display:flex;flex-direction:column;gap:16px;}',
      '.pk-stage{position:relative;padding:0;overflow:hidden;height:clamp(360px,60vh,560px);min-height:340px;}',
      '.pk-canvas{position:absolute;inset:0;width:100%;height:100%;display:block;}',
      '.pk-status{text-align:center;font-weight:800;letter-spacing:.3px;min-height:22px;color:var(--muted);}',
      '.pk-status.win{color:var(--neon);text-shadow:0 0 10px rgba(57,255,20,.5);}',
      '.pk-status.lose{color:var(--danger-2);text-shadow:0 0 10px rgba(255,77,109,.5);}',
      '.pk-status.even{color:var(--aqua-soft);}',
      '.pk-controls{display:flex;flex-wrap:wrap;gap:14px;align-items:flex-end;justify-content:center;}',
      '.pk-controls .bet-panel{flex:1 1 240px;}',
      '.pk-drop{flex:1 1 240px;}',
      '.pk-hist{display:flex;flex-wrap:wrap;gap:8px;justify-content:center;align-items:center;}',
      '.pk-hist-l{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:1px;font-weight:800;margin-right:2px;}',
      '.pk-chip{font-weight:800;font-size:13px;padding:5px 11px;border-radius:999px;border:1px solid var(--stroke);background:rgba(4,16,10,.7);color:var(--muted);font-variant-numeric:tabular-nums;}',
      '.pk-chip.win{color:var(--neon);border-color:var(--stroke-2);box-shadow:var(--glow-soft);}',
      '.pk-chip.big{color:var(--gold);border-color:rgba(255,210,63,.5);box-shadow:0 0 12px rgba(255,210,63,.35);}',
      '.pk-chip.even{color:var(--aqua-soft);border-color:rgba(51,230,208,.35);}',
      '.pk-chip.loss{color:var(--danger-2);border-color:rgba(255,77,109,.35);}',
      '.pk-chip.empty{color:var(--muted);border-style:dashed;}',
      '@media(max-width:560px){.pk-drop{flex:1 1 100%;}.pk-controls .bet-panel{flex:1 1 100%;}}'
    ].join('\n'));
  }

  App.Games.plinko = {
    id: 'plinko',
    title: 'Plinko',
    icon: '🎯',
    subtitle: 'Lass die Kugel fallen — je weiter außen, desto mehr',

    render: function (root) {
      injectCss();

      /* -------------------- Zustand -------------------- */
      var dropping = false;
      var rafId = null;
      var animStart = null;
      var lastSeg = -1;           // zuletzt beklungenes Fall-Segment (Peg-Kontakt-Throttle)
      var path = null;            // { cols:[13], slot:int }
      var ballPos = null;         // {x,y} in CSS-px, oder null
      var trail = [];             // letzte Positionen fuer die Spur
      var landedSlot = -1;        // fuer Highlight (auch im Ruhezustand)
      var pulse = 0;              // Highlight-Puls des Landeslots
      var history = [];           // {m, win}, neueste zuerst

      /* -------------------- DOM -------------------- */
      var canvas = el('canvas', { class: 'pk-canvas' });
      var ctx = canvas.getContext('2d');
      var stage = el('div', { class: 'game-stage pk-stage' }, [canvas]);

      var status = el('div', { class: 'pk-status' }, ['Wähle deinen Einsatz und lass die Kugel fallen 🎯']);

      var MULT_MIN = Math.min.apply(null, MULTS);
      var MULT_MAX = Math.max.apply(null, MULTS);
      function updateDropInfo() {
        dropSub.textContent = 'Einsatz ' + UI.formatCoins(betPanel.getBet()) + ' 🪙 · ' + MULT_MIN + '×–' + MULT_MAX + '×';
      }

      var betPanel = UI.createBetPanel({ initial: 50, onChange: updateDropInfo });
      var dropSub = el('span', { class: 'btn-sub' }, ['']);
      var dropBtn = el('button', {
        class: 'btn btn-primary btn-lg btn-block pk-drop btn-2l', type: 'button', onclick: doDrop
      }, [
        el('span', { class: 'btn-main' }, ['🎯 Fallen lassen']),
        dropSub
      ]);
      var controls = el('div', { class: 'pk-controls' }, [betPanel.root, dropBtn]);

      var histWrap = el('div', { class: 'pk-hist' });

      var hint = el('p', { class: 'hint-text' }, [
        'Die Kugel entscheidet sich an jedem Peg 50/50. Randfelder zahlen bis 15×, die Mitte nur 0.4× — Risiko liegt in der Streuung.'
      ]);

      root.appendChild(el('div', { class: 'pk-wrap' }, [stage, status, controls, histWrap, hint]));

      renderHistory();
      updateDropInfo();
      // Erst nach Layout zeichnen, damit die Canvas-Groesse steht.
      requestAnimationFrame(function () { drawIdle(); });

      /* -------------------- Layout-Metriken -------------------- */
      function metrics() {
        var rect = canvas.getBoundingClientRect();
        var W = Math.max(1, rect.width), H = Math.max(1, rect.height);
        var slotBandH = Math.min(52, Math.max(34, H * 0.11));
        var topY = 20;
        // 13 Slot-Spalten muessen quer passen: 12*gap Spannweite + halber Slot je Seite.
        var edgePad = 8;
        var gap = (W - 2 * edgePad) / (SLOTS);      // ergibt 12*gap < Breite
        var rowH = (H - slotBandH - topY - 12) / ROWS;
        return {
          W: W, H: H,
          cx: W / 2,
          topY: topY,
          rowH: rowH,
          gap: gap,
          slotsTopY: topY + ROWS * rowH + 8,
          slotBandH: slotBandH,
          pegR: Math.max(2.2, Math.min(gap * 0.15, 5)),
          ballR: Math.max(5, Math.min(gap * 0.3, 10))
        };
      }

      // Position der Kugel auf "Level" k (0..12) fuer die aktuelle Bahn.
      function pointAt(level, cols, M) {
        if (level >= ROWS) {
          return { x: M.cx + (cols[ROWS] - ROWS / 2) * M.gap, y: M.slotsTopY + M.slotBandH * 0.52 };
        }
        return { x: M.cx + (cols[level] - level / 2) * M.gap, y: M.topY + level * M.rowH };
      }

      // Wegpunkte P(0..13): P0 = Start ueber dem Board, P(i)=Level(i-1).
      function waypoint(i, cols, M) {
        if (i === 0) return { x: M.cx, y: M.topY - M.rowH * 0.7 };
        return pointAt(i - 1, cols, M);
      }

      function smooth(t) { return t * t * (3 - 2 * t); }

      function ballAt(e, M) {
        var seg = Math.floor(e / SEG_MS);
        if (seg >= TOTAL_SEG) return pointAt(ROWS, path.cols, M);
        var t = (e - seg * SEG_MS) / SEG_MS;
        if (t < 0) t = 0; else if (t > 1) t = 1;
        var A = waypoint(seg, path.cols, M);
        var B = waypoint(seg + 1, path.cols, M);
        var x = A.x + (B.x - A.x) * smooth(t);
        var y = A.y + (B.y - A.y) * t;
        // Kleiner Abpraller nach oben zwischen den Pegs.
        var hop = 0;
        if (seg === 0) hop = 0;                              // reiner Einfall
        else if (seg === TOTAL_SEG - 1) hop = Math.min(M.rowH * 0.28, 10);
        else hop = Math.min(M.rowH * 0.42, 16);
        y -= hop * Math.sin(Math.PI * t);
        return { x: x, y: y };
      }

      /* -------------------- Rundenlogik -------------------- */
      function doDrop() {
        if (dropping) return;
        var bet = betPanel.getBet();
        if (!App.Coins.canBet(bet)) { UI.toast('Nicht genug Coins', 'lose'); return; }

        App.Coins.add(-bet);

        // Bahn ziehen: 12x links/rechts -> Slot = Anzahl "Rechts".
        var cols = new Array(ROWS + 1);
        cols[0] = 0;
        for (var r = 0; r < ROWS; r++) {
          cols[r + 1] = cols[r] + (Math.random() < 0.5 ? 0 : 1);
        }
        var slot = cols[ROWS];

        // Rigging: Bahn neu ziehen, bis der Slot zum erzwungenen Ergebnis passt (Verteilung bleibt binomial).
        var forced = (App.Rig && App.Rig.outcome) ? App.Rig.outcome() : null;
        if (forced === 'win' || forced === 'lose') {
          for (var g = 0; g < 400; g++) {
            var good = (forced === 'win') ? (MULTS[slot] > 1) : (MULTS[slot] < 1);
            if (good) break;
            cols = new Array(ROWS + 1);
            cols[0] = 0;
            for (var rr = 0; rr < ROWS; rr++) cols[rr + 1] = cols[rr] + (Math.random() < 0.5 ? 0 : 1);
            slot = cols[ROWS];
          }
        }

        path = { cols: cols, slot: slot };
        path.bet = bet;
        dropping = true;
        landedSlot = -1;
        pulse = 0;
        trail = [];
        animStart = null;
        ballPos = null;
        lastSeg = -1;

        setControlsDisabled(true);
        setStatus('Die Kugel fällt … 🎯', null);
        rafId = requestAnimationFrame(loop);
      }

      function loop(ts) {
        if (animStart == null) animStart = ts;
        var e = ts - animStart;
        var M = metrics();

        if (e >= TOTAL_SEG * SEG_MS) {
          finishDrop(M);
          return;
        }

        // Pro Fall-Segment ein Peg-Kontakt-Tick (throttled: einmal je Reihe).
        var seg = Math.floor(e / SEG_MS);
        if (seg !== lastSeg) {
          if (seg >= 1 && seg <= ROWS && App.Audio) App.Audio.sfx('tick');
          lastSeg = seg;
        }

        ballPos = ballAt(e, M);
        trail.push({ x: ballPos.x, y: ballPos.y });
        if (trail.length > 10) trail.shift();

        draw(M);
        rafId = requestAnimationFrame(loop);
      }

      function finishDrop(M) {
        rafId = null;
        var slot = path.slot;
        var mult = MULTS[slot];
        var bet = path.bet;
        var brutto = Math.round(bet * mult);
        var delta = brutto - bet;

        ballPos = pointAt(ROWS, path.cols, M);
        trail = [];
        landedSlot = slot;
        pulse = 1;

        // Landung im Fach: großer Rand-Multiplikator = Jackpot, Gewinn = Münze, sonst dumpfer Aufprall.
        if (App.Audio) App.Audio.sfx(mult >= 4 ? 'jackpot' : (mult > 1 ? 'coin' : 'pop'));

        App.Coins.add(brutto);
        UI.flash(delta);

        var multStr = String(mult);
        if (delta > 0) {
          UI.toast('Slot ' + multStr + '× · +' + UI.formatCoins(delta) + ' 🪙', 'win');
          setStatus('🎉 ' + multStr + '× — +' + UI.formatCoins(delta) + ' 🪙', 'win');
        } else if (delta === 0) {
          UI.toast('Slot ' + multStr + '× · Einsatz zurück', 'info');
          setStatus('1.00× — Einsatz zurück', 'even');
        } else {
          UI.toast('Slot ' + multStr + '× · −' + UI.formatCoins(-delta) + ' 🪙', 'lose');
          setStatus(multStr + '× — −' + UI.formatCoins(-delta) + ' 🪙', 'lose');
        }

        history.unshift({ m: mult, win: mult >= 1 });
        if (history.length > 12) history.pop();
        renderHistory();

        draw(M);

        dropping = false;
        setControlsDisabled(false);
        betPanel.refresh();
        updateDropInfo();
        App.Coins.settle();
      }

      /* -------------------- Anzeige-Helfer -------------------- */
      function setStatus(text, cls) {
        status.className = 'pk-status' + (cls ? ' ' + cls : '');
        status.textContent = text;
      }

      function setControlsDisabled(d) {
        dropBtn.disabled = d;
        betPanel.setDisabled(d);
      }

      function slotTier(m) {
        if (m >= 15) return { key: 'max', c: '#ffd23f', fill: 'rgba(255,210,63,0.16)' };
        if (m >= 4)  return { key: 'high', c: '#39ff14', fill: 'rgba(57,255,20,0.15)' };
        if (m >= 1.2) return { key: 'mid', c: '#33e6d0', fill: 'rgba(51,230,208,0.13)' };
        if (m >= 1)  return { key: 'even', c: '#9dff7a', fill: 'rgba(157,255,122,0.12)' };
        return { key: 'low', c: '#ff4d6d', fill: 'rgba(255,77,109,0.13)' };
      }

      function renderHistory() {
        histWrap.innerHTML = '';
        histWrap.appendChild(el('span', { class: 'pk-hist-l' }, ['Letzte']));
        if (!history.length) {
          histWrap.appendChild(el('span', { class: 'pk-chip empty' }, ['—']));
          return;
        }
        history.slice(0, 8).forEach(function (h) {
          var cls = h.m >= 4 ? 'big' : (h.m > 1 ? 'win' : (h.m === 1 ? 'even' : 'loss'));
          histWrap.appendChild(el('span', { class: 'pk-chip ' + cls }, [String(h.m) + '×']));
        });
      }

      /* -------------------- Zeichnen -------------------- */
      function roundRect(x, y, w, h, r) {
        if (w < 2 * r) r = w / 2;
        if (h < 2 * r) r = h / 2;
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.arcTo(x + w, y, x + w, y + h, r);
        ctx.arcTo(x + w, y + h, x, y + h, r);
        ctx.arcTo(x, y + h, x, y, r);
        ctx.arcTo(x, y, x + w, y, r);
        ctx.closePath();
      }

      function drawIdle() { draw(metrics()); }

      function draw(M) {
        var dpr = window.devicePixelRatio || 1;
        var bw = Math.round(M.W * dpr), bh = Math.round(M.H * dpr);
        if (canvas.width !== bw || canvas.height !== bh) { canvas.width = bw; canvas.height = bh; }
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, M.W, M.H);

        // --- Pegs (Reihe r hat r+1 Pegs) ---
        for (var r = 0; r < ROWS; r++) {
          var py = M.topY + r * M.rowH;
          for (var j = 0; j <= r; j++) {
            var px = M.cx + (j - r / 2) * M.gap;
            ctx.beginPath();
            ctx.arc(px, py, M.pegR, 0, Math.PI * 2);
            ctx.fillStyle = 'rgba(157,255,122,0.55)';
            ctx.fill();
          }
        }

        // --- Slot-Band ---
        var sw = M.gap * 0.9;
        for (var i = 0; i < SLOTS; i++) {
          var scx = M.cx + (i - ROWS / 2) * M.gap;
          var tier = slotTier(MULTS[i]);
          var active = (i === landedSlot);
          var sx = scx - sw / 2;
          var lift = active ? 4 : 0;
          var sy = M.slotsTopY - lift;

          ctx.save();
          if (active) {
            ctx.shadowColor = tier.c;
            ctx.shadowBlur = 18 + pulse * 10;
          }
          roundRect(sx, sy, sw, M.slotBandH, Math.min(7, sw * 0.24));
          ctx.fillStyle = active ? tier.fill.replace(/[\d.]+\)$/, '0.34)') : tier.fill;
          ctx.fill();
          ctx.restore();

          ctx.lineWidth = active ? 2 : 1;
          roundRect(sx, sy, sw, M.slotBandH, Math.min(7, sw * 0.24));
          ctx.strokeStyle = active ? tier.c : 'rgba(57,255,20,0.18)';
          ctx.stroke();

          // Multiplikator-Text
          var fs = Math.max(8, Math.min(M.gap * 0.4, 13));
          ctx.font = '800 ' + fs + 'px -apple-system, Segoe UI, Roboto, sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillStyle = tier.c;
          if (active) { ctx.shadowColor = tier.c; ctx.shadowBlur = 8; }
          ctx.fillText(String(MULTS[i]) + '×', scx, sy + M.slotBandH / 2);
          ctx.shadowBlur = 0;
        }

        // --- Spur der Kugel ---
        for (var t = 0; t < trail.length; t++) {
          var a = (t + 1) / trail.length;
          ctx.beginPath();
          ctx.arc(trail[t].x, trail[t].y, M.ballR * (0.35 + a * 0.4), 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(255,210,63,' + (a * 0.22).toFixed(3) + ')';
          ctx.fill();
        }

        // --- Kugel ---
        if (ballPos) {
          ctx.save();
          ctx.shadowColor = 'rgba(255,210,63,0.9)';
          ctx.shadowBlur = 16;
          var grd = ctx.createRadialGradient(
            ballPos.x - M.ballR * 0.35, ballPos.y - M.ballR * 0.4, M.ballR * 0.2,
            ballPos.x, ballPos.y, M.ballR
          );
          grd.addColorStop(0, '#fff4c2');
          grd.addColorStop(1, '#ffd23f');
          ctx.beginPath();
          ctx.arc(ballPos.x, ballPos.y, M.ballR, 0, Math.PI * 2);
          ctx.fillStyle = grd;
          ctx.fill();
          ctx.restore();
        }

        if (pulse > 0) { pulse *= 0.9; if (pulse < 0.02) pulse = 0; }
      }

      // Bei Groessenaenderung neu zeichnen (auch im Ruhezustand).
      var onResize = function () { if (!dropping) drawIdle(); };
      window.addEventListener('resize', onResize);

      /* -------------------- Cleanup -------------------- */
      return {
        cleanup: function () {
          if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
          window.removeEventListener('resize', onResize);
        }
      };
    }
  };
})();
