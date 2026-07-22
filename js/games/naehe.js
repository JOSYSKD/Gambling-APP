/* naehe.js — "Nähe": Zielsuche auf einem 15×15-Feld.
 *
 * Irgendwo im Raster liegt ein verstecktes Ziel. Jeder Klick deckt ein Feld auf
 * und verrät, in welchem Umkreis das Ziel liegt (0 = Treffer, 1 = 1-3 Felder,
 * 2 = 4-6 Felder …). Wer mit wenigen Versuchen trifft, kassiert; ein
 * Glückstreffer beim ersten Klick zahlt am fettesten. Ab dem 15. Versuch ist
 * der Einsatz weg.
 *
 * Entfernung = Chebyshev-Distanz (max(|dx|,|dy|)) — der quadratische "Ring" um
 * das aufgedeckte Feld. Angezeigt wird davon bewusst nur die Zone (je 3 Ringe):
 * mit dem exakten Radius kann ein rechnender Spieler das Ziel praktisch immer
 * im dritten Zug einkreisen (nachgemessen: RTP über 900 %). Die Zonen lassen
 * genug Spielraum, dass Glück und Gespür entscheiden.
 *
 * RTP-Auslegung: mit tools/naehe-rtp.js gegengerechnet — gegen einen rechnenden
 * Spieler ~94 %, gegen intuitives Spiel entsprechend weniger.
 */
(function () {
  'use strict';
  window.App = window.App || {};
  App.Games = App.Games || {};

  var SIZE = 15;
  var ZONE_WIDTH = 3;   // wie viele Ringe eine angezeigte Zone zusammenfasst

  /* Angezeigte Zone einer Entfernung: 0 = Treffer, sonst 1, 2, 3 … */
  function zoneOf(d) { return d === 0 ? 0 : Math.ceil(d / ZONE_WIDTH); }

  /* Auszahlung × Einsatz nach Anzahl der Versuche bis zum Treffer.
   * Die Kurve ist gegen einen rechnenden Spieler kalibriert (tools/naehe-rtp.js):
   * wer die Zonen konsequent auswertet, trifft fast immer im 5. bis 7. Versuch —
   * dort MUSS die Auszahlung unter dem Einsatz liegen, sonst wäre das Spiel
   * systematisch farmbar. Gewinn gibt es also für Treffer bis zum 4. Versuch. */
  var PAYOUTS = { 1: 48, 2: 14, 3: 5.5, 4: 1.4, 5: 0.55, 6: 0.28, 7: 0.18, 8: 0.11, 9: 0.07, 10: 0.05, 11: 0.03, 12: 0.02 };
  var MAX_TRIES = 15;   // ab hier ist die Runde verloren

  function payoutFor(tries) { return PAYOUTS[tries] || 0; }

  App.Games.naehe = {
    id: 'naehe', title: 'Nähe', icon: '🎯',
    subtitle: '15×15 Felder — jeder Klick verrät den Umkreis zum Ziel',
    // nach außen sichtbar, damit tools/naehe-rtp.js mit genau diesen Werten rechnet
    size: SIZE, payouts: PAYOUTS, maxTries: MAX_TRIES, zoneOf: zoneOf, zoneWidth: ZONE_WIDTH,

    render: function (root) {
      var UI = App.UI, el = UI.el;
      injectCss();

      var timers = [], destroyed = false;
      var running = false;
      var bet = 0, tries = 0;
      var targetX = 0, targetY = 0;
      var cells = [];      // cells[y][x]
      var opened = {};

      function later(fn, ms) {
        var id = setTimeout(function () {
          if (destroyed) return;
          var k = timers.indexOf(id); if (k >= 0) timers.splice(k, 1);
          fn();
        }, ms);
        timers.push(id); return id;
      }

      /* ---------- DOM ---------- */
      var readout = el('div', { class: 'nh-readout' }, ['Einsatz wählen und starten']);
      var triesEl = el('span', { class: 'nh-stat-val' }, ['0']);
      var nextEl = el('span', { class: 'nh-stat-val nh-next' }, ['×' + payoutFor(1)]);
      var statRow = el('div', { class: 'nh-stats' }, [
        el('div', { class: 'nh-stat' }, [el('span', { class: 'nh-stat-lb' }, ['Versuche']), triesEl]),
        el('div', { class: 'nh-stat' }, [el('span', { class: 'nh-stat-lb' }, ['Treffer zahlt jetzt']), nextEl])
      ]);

      var board = el('div', { class: 'nh-board' });
      for (var y = 0; y < SIZE; y++) {
        var row = [];
        for (var x = 0; x < SIZE; x++) {
          (function (cx, cy) {
            var c = el('button', {
              class: 'nh-cell', type: 'button',
              onclick: function () { dig(cx, cy); }
            }, ['']);
            c.disabled = true;
            row.push(c);
            board.appendChild(c);
          })(x, y);
        }
        cells.push(row);
      }

      var betPanel = UI.createBetPanel({ initial: 50, onChange: updateStartSub });
      var startSub = el('span', { class: 'btn-sub' }, ['']);
      var startBtn = el('button', {
        class: 'btn btn-primary btn-lg btn-2l nh-start', type: 'button', onclick: startRound
      }, [el('span', { class: 'btn-main' }, ['🎯 Suche starten']), startSub]);

      function updateStartSub() {
        startSub.textContent = 'Einsatz ' + UI.formatCoins(betPanel.getBet()) + ' ' + UI.coinIcon();
      }
      updateStartSub();

      var controls = el('div', { class: 'controls-row nh-controls' }, [betPanel.root, startBtn]);

      // Legende: welche Zahl welchen Umkreis bedeutet
      var legend = el('div', { class: 'nh-legend' }, (function () {
        var items = [];
        for (var z = 1; z <= zoneOf(SIZE - 1); z++) {
          items.push(el('span', { class: 'nh-leg ' + heatClass(z) }, [z + ' = ' + zoneRange(z)]));
        }
        return items;
      })());

      var hint = el('p', { class: 'hint-text' }, [
        'Die Zahl sagt, wie weit das Ziel entfernt ist — 0 heißt Treffer. Gezählt wird im Quadrat um das Feld ' +
        '(diagonal zählt wie gerade). Gewinn gibt es bis zum 4. Versuch, danach zahlt der Treffer weniger als der ' +
        'Einsatz. Nach ' + MAX_TRIES + ' Versuchen ist die Runde vorbei. RTP ≈ 92 %.'
      ]);

      root.appendChild(el('div', { class: 'nh-wrap' }, [
        el('div', { class: 'nh-stage' }, [readout, statRow, board, legend]),
        controls, hint, buildPayTable(el)
      ]));

      /* ---------- Ablauf ---------- */
      function setCellsEnabled(on) {
        for (var y = 0; y < SIZE; y++) {
          for (var x = 0; x < SIZE; x++) {
            cells[y][x].disabled = !on || !!opened[x + ':' + y];
          }
        }
      }

      function resetBoard() {
        opened = {};
        for (var y = 0; y < SIZE; y++) {
          for (var x = 0; x < SIZE; x++) {
            var c = cells[y][x];
            c.textContent = '';
            c.className = 'nh-cell';
            c.disabled = true;
          }
        }
      }

      function startRound() {
        if (running || destroyed) return;
        bet = betPanel.getBet();
        if (!App.Coins.canBet(bet)) {
          UI.toast('Nicht genug Coins für diesen Einsatz', 'lose');
          return;
        }
        App.Coins.add(-bet);

        running = true;
        tries = 0;
        targetX = (Math.random() * SIZE) | 0;
        targetY = (Math.random() * SIZE) | 0;
        resetBoard();
        setCellsEnabled(true);
        betPanel.setDisabled(true);
        startBtn.disabled = true;
        triesEl.textContent = '0';
        nextEl.textContent = '×' + payoutFor(1);
        readout.className = 'nh-readout';
        readout.textContent = 'Wo liegt das Ziel? Sofort-Treffer zahlt ×' + payoutFor(1);
        if (App.Audio) App.Audio.sfx('start');
      }

      function dig(x, y) {
        if (!running || destroyed || opened[x + ':' + y]) return;
        opened[x + ':' + y] = true;
        tries++;

        var d = Math.max(Math.abs(x - targetX), Math.abs(y - targetY));
        var z = zoneOf(d);
        var c = cells[y][x];
        c.disabled = true;
        c.textContent = String(z);
        c.classList.add('nh-open', heatClass(z));
        triesEl.textContent = String(tries);

        if (d === 0) { win(x, y); return; }

        if (App.Audio) App.Audio.sfx(z === 1 ? 'ding' : z === 2 ? 'tick' : 'step');

        if (tries >= MAX_TRIES) { lose(); return; }

        var next = payoutFor(tries + 1);
        nextEl.textContent = next > 0 ? ('×' + next) : '—';
        nextEl.classList.toggle('nh-next-dead', next <= 0);
        readout.className = 'nh-readout';
        readout.textContent = 'Zone ' + z + ' — Ziel ' + zoneRange(z) + ' Felder entfernt.';
      }

      function win(x, y) {
        running = false;
        var mult = payoutFor(tries);
        var payout = Math.round(bet * mult);
        cells[y][x].classList.add('nh-target');
        cells[y][x].textContent = '🎯';
        setCellsEnabled(false);

        if (payout > 0) {
          App.Coins.add(payout);
          UI.flash(payout - bet);
          readout.className = 'nh-readout nh-win';
          readout.textContent = '🎯 Treffer im ' + tries + '. Versuch — ×' + mult + ' = ' + UI.formatCoins(payout) + ' ' + UI.coinIcon();
          if (App.Audio) App.Audio.sfx(tries <= 2 ? 'jackpot' : 'win');
          UI.toast(tries === 1 ? ('VOLLTREFFER beim ersten Klick! ×' + mult) : ('Treffer — ×' + mult), 'win');
        } else {
          UI.flash(-bet);
          readout.className = 'nh-readout nh-lose';
          readout.textContent = '🎯 Gefunden — aber zu spät, der Einsatz ist weg.';
        }
        endRound();
      }

      function lose() {
        running = false;
        setCellsEnabled(false);
        var t = cells[targetY][targetX];
        t.classList.add('nh-target', 'nh-missed');
        t.textContent = '🎯';
        UI.flash(-bet);
        readout.className = 'nh-readout nh-lose';
        readout.textContent = 'Vorbei — das Ziel lag hier.';
        if (App.Audio) App.Audio.sfx('lose');
        endRound();
      }

      function endRound() {
        betPanel.setDisabled(false);
        betPanel.refresh();
        startBtn.disabled = false;
        updateStartSub();
        App.Coins.settle();
      }

      return {
        cleanup: function () {
          destroyed = true; running = false;
          for (var i = 0; i < timers.length; i++) clearTimeout(timers[i]);
          timers.length = 0;
        }
      };
    }
  };

  /* Farbcode nach Zone — heiß/kalt auf einen Blick. */
  function heatClass(z) {
    return 'nh-h' + Math.min(z, 5);
  }

  /* "1–3", "4–6", … — was eine Zone in Feldern bedeutet. */
  function zoneRange(z) {
    var lo = (z - 1) * ZONE_WIDTH + 1;
    var hi = Math.min(z * ZONE_WIDTH, SIZE - 1);
    return lo === hi ? String(lo) : (lo + '–' + hi);
  }

  function buildPayTable(el) {
    var rows = [];
    Object.keys(PAYOUTS).map(Number).sort(function (a, b) { return a - b; }).forEach(function (t) {
      rows.push(el('tr', t === 1 ? { class: 'nh-pay-top' } : null, [
        el('td', null, [t + '. Versuch']),
        el('td', { class: 'nh-pay-mult' }, ['×' + PAYOUTS[t]])
      ]));
    });
    var firstDead = Math.max.apply(null, Object.keys(PAYOUTS).map(Number)) + 1;
    rows.push(el('tr', { class: 'nh-pay-dead' }, [
      el('td', null, [firstDead + '. bis ' + MAX_TRIES + '. Versuch']),
      el('td', { class: 'nh-pay-mult' }, ['—'])
    ]));
    return el('div', { class: 'glass nh-paycard' }, [
      el('div', { class: 'nh-paytitle' }, ['💰 Auszahlung (× Einsatz)']),
      el('table', { class: 'payout-table nh-paytable' }, [el('tbody', null, rows)]),
      el('p', { class: 'nh-paynote' }, [
        'Tipp: Jede Zahl grenzt das Ziel auf einen Ringbereich ein. Zwei Bereiche überschneiden sich nur in wenigen Feldern — wer die Treffer geschickt verteilt, ist meist in 5 bis 8 Zügen am Ziel.'
      ])
    ]);
  }

  function injectCss() {
    App.UI.injectStyle('game-naehe-css', [
      '.nh-wrap{display:flex;flex-direction:column;gap:14px;max-width:640px;margin:0 auto;}',
      '.nh-stage{display:flex;flex-direction:column;align-items:center;gap:10px;padding:14px 10px;',
        'border-radius:18px;border:1px solid var(--stroke-2);background:linear-gradient(180deg,rgba(4,16,10,.95),rgba(9,32,21,.85));}',

      '.nh-readout{font-size:clamp(14px,3.6vw,19px);font-weight:800;min-height:1.4em;text-align:center;color:var(--aqua-soft,#33e6d0);}',
      '.nh-readout.nh-win{color:var(--neon);text-shadow:0 0 14px rgba(57,255,20,.6);}',
      '.nh-readout.nh-lose{color:var(--muted);}',

      '.nh-stats{display:flex;gap:18px;flex-wrap:wrap;justify-content:center;}',
      '.nh-stat{display:flex;align-items:baseline;gap:6px;}',
      '.nh-stat-lb{font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;}',
      '.nh-stat-val{font-size:17px;font-weight:900;font-variant-numeric:tabular-nums;color:var(--leaf);}',
      '.nh-next{color:var(--gold);}',
      '.nh-next.nh-next-dead{color:var(--muted);}',

      '.nh-board{display:grid;grid-template-columns:repeat(15,1fr);gap:2px;width:100%;max-width:460px;}',
      '.nh-cell{aspect-ratio:1/1;border-radius:4px;border:1px solid var(--stroke-2);background:rgba(255,255,255,.05);',
        'color:#fff;font-size:clamp(8px,2.1vw,12px);font-weight:800;padding:0;cursor:pointer;',
        'display:flex;align-items:center;justify-content:center;transition:transform .12s,background .15s,box-shadow .15s;}',
      '.nh-cell:disabled{cursor:default;}',
      '.nh-cell:not(:disabled):hover{transform:scale(1.14);background:rgba(57,255,20,.22);box-shadow:0 0 10px rgba(57,255,20,.4);z-index:2;}',
      '.nh-cell.nh-open{border-color:transparent;animation:nhOpen .2s ease-out;}',
      '@keyframes nhOpen{from{transform:scale(.6);opacity:.4}to{transform:scale(1);opacity:1}}',

      // heiß -> kalt; gilt für die Felder UND die Legende darunter (gleiche
      // Spezifität nötig, sonst färbt sich die Legende nicht)
      '.nh-cell.nh-h0,.nh-leg.nh-h0{background:#ffd23f;color:#111;}',
      '.nh-cell.nh-h1,.nh-leg.nh-h1{background:#ff3b30;color:#fff;}',
      '.nh-cell.nh-h2,.nh-leg.nh-h2{background:#ff8c1a;color:#111;}',
      '.nh-cell.nh-h3,.nh-leg.nh-h3{background:#ffd23f;color:#111;}',
      '.nh-cell.nh-h4,.nh-leg.nh-h4{background:#2f9e6b;color:#fff;}',
      '.nh-cell.nh-h5,.nh-leg.nh-h5{background:#1f4fa8;color:#fff;}',
      '.nh-cell.nh-target{background:var(--neon,#39ff14);color:#062;font-size:clamp(10px,2.6vw,15px);',
        'box-shadow:0 0 18px rgba(57,255,20,.85);animation:nhHit .5s ease-in-out 3;}',
      '.nh-cell.nh-missed{background:#ff3b30;box-shadow:0 0 18px rgba(255,59,48,.8);}',
      '@keyframes nhHit{0%,100%{transform:scale(1)}50%{transform:scale(1.3)}}',

      // Legende unter dem Feld: welche Zahl welchen Umkreis bedeutet
      '.nh-legend{display:flex;flex-wrap:wrap;gap:6px;justify-content:center;margin-top:2px;}',
      '.nh-leg{font-size:11px;font-weight:800;padding:3px 9px;border-radius:999px;white-space:nowrap;',
        'border:1px solid rgba(255,255,255,.15);}',

      '.nh-controls{margin-top:2px;}',
      '.nh-start{min-width:180px;}',
      '.nh-paycard{padding:12px 14px;}',
      '.nh-paytitle{font-size:14px;font-weight:800;color:var(--aqua-soft,#33e6d0);margin-bottom:6px;}',
      '.nh-paytable td{padding:3px 6px;color:var(--muted);}',
      '.nh-paytable td.nh-pay-mult{text-align:right;font-weight:800;color:var(--leaf);font-variant-numeric:tabular-nums;}',
      '.nh-paytable tr.nh-pay-top td{color:var(--gold);font-weight:800;}',
      '.nh-paytable tr.nh-pay-top td.nh-pay-mult{color:var(--gold);text-shadow:0 0 10px rgba(255,210,63,.5);}',
      '.nh-paytable tr.nh-pay-dead td,.nh-paytable tr.nh-pay-dead td.nh-pay-mult{color:var(--muted);opacity:.7;}',
      '.nh-paynote{margin:8px 2px 0;font-size:13px;color:var(--muted);line-height:1.5;}',

      '@media(max-width:420px){.nh-start{width:100%;}.nh-board{gap:1px;}}'
    ].join(''));
  }
})();
