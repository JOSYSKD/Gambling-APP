/* yahtzee.js — "Kniffel" (Yahtzee) im Neon-Dschungel-Look.
 *
 * SPIELIDEE: Klassisches Kniffel. Pro Zug bis zu 3 Würfe mit 5 Würfeln.
 *   Zwischen den Würfen einzelne Würfel per Klick/Tipp halten (🔒, deutlich
 *   markiert). Danach GENAU EIN Feld auf dem Block eintragen. 13 Runden ->
 *   jeder füllt seine 13 Felder, höchste Gesamtsumme gewinnt.
 *
 * STEUERUNG: "🎲 Würfeln" wirft die nicht gehaltenen Würfel neu (pointerdown =
 *   Maus + Touch). Würfel antippen hält/löst sie (nur zwischen den Würfen).
 *   Ein Feld in DEINER Spalte antippen trägt die eingeblendete Vorschau ein;
 *   ein Feld mit 0 Punkten wird dabei gestrichen (auch das ist ein gültiger Zug).
 *
 * BLOCK / PUNKTE:
 *   Oben  : Einser..Sechser (Summe der jeweiligen Augen). Bonus +35 ab 63 oben.
 *   Unten : Dreierpasch (Summe bei >=3 gleichen), Viererpasch (>=4 gleiche),
 *           Full House 25, Kleine Straße 30, Große Straße 40, Kniffel 50, Chance.
 *   Die möglichen Punkte pro offenem Feld werden dem aktiven Spieler als
 *   Vorschau eingeblendet. Punkte = Endsumme (inkl. Bonus).
 *
 * SOLO  : Gegen 1-3 Bots. Drei Stufen (Leicht/Mittel/Schwer). Die Bot-KI
 *   bewertet jedes Feld über einen erwartungswert-basierten Monte-Carlo-Blick
 *   (welche Würfel halten? welches Feld eintragen?) und fühlt sich nicht dumm an.
 *
 * MULTI : Rundenbasiert über room.shared. Der komplette Spielzustand (Reihen-
 *   folge, alle Blöcke, aktueller Zug, Würfel, gehaltene Würfel, Wurf-Zähler)
 *   liegt in shared. Nur der AKTIVE Spieler schreibt (würfeln/halten/eintragen)
 *   via room.setShared; alle rendern denselben Zustand. Ein wachsender "nonce"
 *   löst bei ALLEN dieselbe Würfel-Animation zum selben Ergebnis aus. Timer/
 *   Countdown über room.now() -> synchron & Tab-sicher. Fehlt der aktive Spieler
 *   (verlassen), spielt der Host seinen Zug automatisch weiter.
 *
 * cleanup() stoppt wirklich alles: Timer/Intervalle + alle room.on-Listener. */
(function () {
  'use strict';
  window.App = window.App || {}; App.Minigames = App.Minigames || {};
  var UI = App.UI, el = UI.el;

  injectStyle();

  /* ===================== Konstanten & Daten ===================== */
  var ROUNDS = 13, MAX_ROLLS = 3, ROLL_MS = 620;
  var UPPER = ['ones', 'twos', 'threes', 'fours', 'fives', 'sixes'];
  var LOWER = ['three', 'four', 'fullhouse', 'smallstraight', 'largestraight', 'kniffel', 'chance'];
  var ALL = UPPER.concat(LOWER);
  var UPPER_VAL = { ones: 1, twos: 2, threes: 3, fours: 4, fives: 5, sixes: 6 };

  var CATLIST = [
    { key: 'ones', label: 'Einser', hint: 'Summe aller Einser', sec: 'up' },
    { key: 'twos', label: 'Zweier', hint: 'Summe aller Zweier', sec: 'up' },
    { key: 'threes', label: 'Dreier', hint: 'Summe aller Dreier', sec: 'up' },
    { key: 'fours', label: 'Vierer', hint: 'Summe aller Vierer', sec: 'up' },
    { key: 'fives', label: 'Fünfer', hint: 'Summe aller Fünfer', sec: 'up' },
    { key: 'sixes', label: 'Sechser', hint: 'Summe aller Sechser', sec: 'up' },
    { key: 'three', label: 'Dreierpasch', hint: 'Summe aller Würfel bei 3 gleichen', sec: 'low' },
    { key: 'four', label: 'Viererpasch', hint: 'Summe aller Würfel bei 4 gleichen', sec: 'low' },
    { key: 'fullhouse', label: 'Full House', fixed: '25', hint: 'Drilling + Paar = 25 Punkte', sec: 'low' },
    { key: 'smallstraight', label: 'Kl. Straße', fixed: '30', hint: '4 in Folge = 30 Punkte', sec: 'low' },
    { key: 'largestraight', label: 'Gr. Straße', fixed: '40', hint: '5 in Folge = 40 Punkte', sec: 'low' },
    { key: 'kniffel', label: 'Kniffel', fixed: '50', hint: '5 gleiche = 50 Punkte', sec: 'low' },
    { key: 'chance', label: 'Chance', hint: 'Summe aller Würfel', sec: 'low' }
  ];

  var PIP = { 1: [4], 2: [0, 8], 3: [0, 4, 8], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8] };

  var BOT_NAMES = ['Tiger 🐯', 'Panda 🐼', 'Kaiman 🐊', 'Tukan 🦜', 'Faultier 🦥', 'Gecko 🦎', 'Jaguar 🐆'];

  /* KI-Feld-Bewertung: ungefährer "üblicher" Ertrag eines Feldes. Ein Feld unter
     seinem üblichen Wert zu füllen kostet Potenzial -> so streicht die KI von
     selbst zuerst billige Felder (Einser) und schützt teure länger. */
  var TYPICAL = {
    ones: 2, twos: 4, threes: 6, fours: 8, fives: 10, sixes: 12,
    three: 19, four: 16, fullhouse: 22, smallstraight: 26, largestraight: 22, kniffel: 14, chance: 21
  };
  var CFG = {
    leicht: { samples: 6, dumpW: 0.35, bonusAware: false, chaos: 0.28, keepChaos: 0.30, margin: 2.6 },
    mittel: { samples: 24, dumpW: 0.50, bonusAware: false, chaos: 0.06, keepChaos: 0.00, margin: 1.2 },
    schwer: { samples: 64, dumpW: 0.55, bonusAware: true, chaos: 0.00, keepChaos: 0.00, margin: 0.6 }
  };

  /* ===================== reine Würfel-/Punkte-Logik ===================== */
  function randInt(n) { return Math.floor(Math.random() * n); }
  function die() { return 1 + randInt(6); }
  function tally(dice) { var c = [0, 0, 0, 0, 0, 0, 0], i; for (i = 0; i < dice.length; i++) c[dice[i]]++; return c; }
  function sumDice(dice) { var s = 0, i; for (i = 0; i < dice.length; i++) s += dice[i]; return s; }
  function hasRun(dice, len) {
    var seen = {}, i, v, run = 0, best = 0;
    for (i = 0; i < dice.length; i++) seen[dice[i]] = true;
    for (v = 1; v <= 6; v++) { if (seen[v]) { run++; if (run > best) best = run; } else run = 0; }
    return best >= len;
  }
  function scoreFor(key, dice) {
    var c = tally(dice), s = sumDice(dice), v;
    switch (key) {
      case 'ones': return c[1] * 1;
      case 'twos': return c[2] * 2;
      case 'threes': return c[3] * 3;
      case 'fours': return c[4] * 4;
      case 'fives': return c[5] * 5;
      case 'sixes': return c[6] * 6;
      case 'three': for (v = 1; v <= 6; v++) if (c[v] >= 3) return s; return 0;
      case 'four': for (v = 1; v <= 6; v++) if (c[v] >= 4) return s; return 0;
      case 'fullhouse': {
        var has3 = false, has2 = false;
        for (v = 1; v <= 6; v++) { if (c[v] === 3) has3 = true; else if (c[v] === 2) has2 = true; }
        return (has3 && has2) ? 25 : 0;
      }
      case 'smallstraight': return hasRun(dice, 4) ? 30 : 0;
      case 'largestraight': return hasRun(dice, 5) ? 40 : 0;
      case 'kniffel': for (v = 1; v <= 6; v++) if (c[v] === 5) return 50; return 0;
      case 'chance': return s;
    }
    return 0;
  }
  function emptyBlock() { var b = {}, i; for (i = 0; i < ALL.length; i++) b[ALL[i]] = null; return b; }
  function cloneBlocks(bs) { var o = {}; Object.keys(bs).forEach(function (id) { o[id] = Object.assign({}, bs[id]); }); return o; }
  function upperSum(block) { var s = 0, i; for (i = 0; i < UPPER.length; i++) if (block[UPPER[i]] != null) s += block[UPPER[i]]; return s; }
  function grandTotal(block) {
    var s = 0, i;
    for (i = 0; i < ALL.length; i++) if (block[ALL[i]] != null) s += block[ALL[i]];
    if (upperSum(block) >= 63) s += 35;
    return s;
  }
  function openKeys(block) { var r = [], i; for (i = 0; i < ALL.length; i++) if (block[ALL[i]] == null) r.push(ALL[i]); return r; }
  function isBig(v) { return v >= 25; }

  /* ===================== KI ===================== */
  function util(key, dice, block, cfg) {
    var raw = scoreFor(key, dice), u = raw, typ = TYPICAL[key] || 0, uv = UPPER_VAL[key];
    if (raw < typ) u -= cfg.dumpW * (typ - raw);
    if (cfg.bonusAware && uv) { if (raw >= uv * 3) u += 4; else if (raw >= uv * 2) u += 1; }
    return u;
  }
  function handValue(dice, block, cfg) {
    var open = openKeys(block), best = -1e9, i, u;
    for (i = 0; i < open.length; i++) { u = util(open[i], dice, block, cfg); if (u > best) best = u; }
    return best === -1e9 ? 0 : best;
  }
  function chooseCategory(dice, block, cfg) {
    var open = openKeys(block);
    if (!open.length) return null;
    if (cfg.chaos && Math.random() < cfg.chaos) return open[randInt(open.length)];
    var best = open[0], bu = -1e9, i, u;
    for (i = 0; i < open.length; i++) { u = util(open[i], dice, block, cfg); if (u > bu) { bu = u; best = open[i]; } }
    return best;
  }
  function evKeep(dice, held, block, cfg, samples) {
    var free = [], i;
    for (i = 0; i < 5; i++) if (!held[i]) free.push(i);
    if (!free.length) return handValue(dice, block, cfg);
    var sum = 0, s, k, d;
    for (s = 0; s < samples; s++) {
      d = dice.slice();
      for (k = 0; k < free.length; k++) d[free[k]] = die();
      sum += handValue(d, block, cfg);
    }
    return sum / samples;
  }
  /* Entscheidet, welche Würfel gehalten werden und ob überhaupt neu gewürfelt
     wird (1-Schritt-Erwartungswert über alle 32 Halte-Masken). */
  function planKeep(dice, block, cfg, rollsLeft) {
    var keepAll = [true, true, true, true, true];
    if (rollsLeft <= 0) return { held: keepAll, reroll: false };
    if (cfg.keepChaos && Math.random() < cfg.keepChaos) {
      var rnd = [], j;
      for (j = 0; j < 5; j++) rnd.push(Math.random() < 0.5);
      return { held: rnd, reroll: true };
    }
    var nowVal = handValue(dice, block, cfg);
    var bestEv = nowVal, bestMask = 31, m, ev, i, held;
    for (m = 0; m < 32; m++) {
      held = [];
      for (i = 0; i < 5; i++) held.push(((m >> i) & 1) === 1);
      ev = evKeep(dice, held, block, cfg, cfg.samples);
      if (ev > bestEv + 0.0001) { bestEv = ev; bestMask = m; }
    }
    if (bestEv <= nowVal + cfg.margin) return { held: keepAll, reroll: false };
    var out = [];
    for (i = 0; i < 5; i++) out.push(((bestMask >> i) & 1) === 1);
    return { held: out, reroll: true };
  }

  function shuffle(a) { var r = a.slice(), i, j, t; for (i = r.length - 1; i > 0; i--) { j = randInt(i + 1); t = r[i]; r[i] = r[j]; r[j] = t; } return r; }
  function soundEnter(key, pts) {
    if (!App.Audio) return;
    if (key === 'kniffel' && pts === 50) App.Audio.sfx('jackpot');
    else if (pts > 0) App.Audio.sfx('point');
    else App.Audio.sfx('info');
  }

  /* ===================== Würfel-DOM ===================== */
  function makeDie(idx, onToggle) {
    var pips = [], grid = el('div', { class: 'yzt-pipgrid' }), k;
    for (k = 0; k < 9; k++) { var sp = el('span', { class: 'yzt-pip' }); pips.push(sp); grid.appendChild(sp); }
    var d = el('button', { class: 'yzt-die empty', type: 'button', 'aria-label': 'Würfel ' + (idx + 1) }, [grid, el('span', { class: 'yzt-q' }, ['?'])]);
    d.addEventListener('pointerdown', function (e) { e.preventDefault(); onToggle(idx); });
    return { el: d, pips: pips };
  }
  function setDieFace(dref, v) { var map = PIP[v], k; for (k = 0; k < 9; k++) dref.pips[k].classList.toggle('on', !!(map && map.indexOf(k) >= 0)); }
  function renderDice(diceEls, dice, held) {
    var i;
    for (i = 0; i < 5; i++) {
      var dref = diceEls[i], v = dice ? dice[i] : 0;
      if (v) { dref.el.classList.remove('empty'); setDieFace(dref, v); } else { dref.el.classList.add('empty'); }
      dref.el.classList.toggle('held', !!(held && held[i]));
    }
  }

  /* ===================== Block-DOM ===================== */
  function buildBlock(order, names, meId, onCell) {
    var cellRefs = {}, headTot = {}, headTh = {}, subRefs = {}, bonusRefs = {}, totRefs = {};
    var htr = el('tr', {}, [el('th', { class: 'yzt-cat-h' }, ['Block'])]);
    order.forEach(function (id) {
      var t = el('div', { class: 'yzt-col-tot' }, ['0']);
      headTot[id] = t;
      var th = el('th', { class: 'yzt-col-h' + (id === meId ? ' me' : '') }, [
        el('div', { class: 'yzt-col-nm' }, [names[id] || '—']), t
      ]);
      headTh[id] = th; htr.appendChild(th); cellRefs[id] = {};
    });
    var tbody = el('tbody', {});
    function catRow(cat) {
      var lab = el('td', { class: 'yzt-cat', title: cat.hint }, [
        el('span', { class: 'yzt-cat-l' }, [cat.label]),
        cat.fixed ? el('span', { class: 'yzt-cat-fx' }, [cat.fixed]) : null
      ]);
      var tr = el('tr', { class: 'yzt-row' }, [lab]);
      order.forEach(function (id) {
        var td = el('td', { class: 'yzt-cell open' });
        (function (pid, key) { td.addEventListener('pointerdown', function (e) { e.preventDefault(); onCell(pid, key); }); })(id, cat.key);
        cellRefs[id][cat.key] = td; tr.appendChild(td);
      });
      tbody.appendChild(tr);
    }
    function specialRow(label, store, cls) {
      var tr = el('tr', { class: 'yzt-srow ' + (cls || '') }, [el('td', { class: 'yzt-cat yzt-cat-sp' }, [label])]);
      order.forEach(function (id) { var td = el('td', { class: 'yzt-scell' }, ['0']); store[id] = td; tr.appendChild(td); });
      tbody.appendChild(tr);
    }
    var i;
    for (i = 0; i < CATLIST.length; i++) {
      catRow(CATLIST[i]);
      if (CATLIST[i].key === 'sixes') { specialRow('Σ oben', subRefs, 'yzt-sub'); specialRow('Bonus 63+', bonusRefs, 'yzt-bonus'); }
    }
    specialRow('GESAMT', totRefs, 'yzt-grand');
    var table = el('table', { class: 'yzt-block' }, [el('thead', {}, [htr]), tbody]);
    return { table: table, cellRefs: cellRefs, headTot: headTot, headTh: headTh, subRefs: subRefs, bonusRefs: bonusRefs, totRefs: totRefs };
  }
  function updateBlock(refs, p) {
    p.order.forEach(function (id) {
      var block = p.blocks[id], isActive = id === p.activeTurnId, i;
      refs.headTh[id].classList.toggle('active', isActive);
      for (i = 0; i < CATLIST.length; i++) {
        var key = CATLIST[i].key, td = refs.cellRefs[id][key], v = block[key], cls = 'yzt-cell';
        if (isActive) cls += ' col-active';
        if (id === p.meId) cls += ' col-me';
        if (v != null) {
          td.textContent = String(v);
          cls += ' filled' + (v === 0 ? ' crossed' : '') + (isBig(v) ? ' big' : '');
          var prev = td.getAttribute('data-fv');
          td.className = cls;
          if (prev === null || prev === '') { void td.offsetWidth; td.classList.add('pop'); }
          td.setAttribute('data-fv', String(v));
        } else if (id === p.previewId && p.dice) {
          var pv = scoreFor(key, p.dice);
          td.textContent = String(pv);
          cls += ' preview' + (pv === 0 ? ' zero' : '');
          td.className = cls;
          td.setAttribute('data-fv', '');
        } else {
          td.textContent = '';
          cls += ' open';
          td.className = cls;
          td.setAttribute('data-fv', '');
        }
      }
      var us = upperSum(block), bonus = us >= 63 ? 35 : 0;
      refs.subRefs[id].textContent = String(us);
      if (bonus) { refs.bonusRefs[id].textContent = '+35'; refs.bonusRefs[id].className = 'yzt-scell got'; }
      else { refs.bonusRefs[id].textContent = us + '/63'; refs.bonusRefs[id].className = 'yzt-scell'; }
      var gt = grandTotal(block);
      refs.totRefs[id].textContent = String(gt);
      refs.headTot[id].textContent = String(gt);
    });
  }

  /* ===================== Gesamt-Layout (Solo & Multi teilen es) ===================== */
  function buildLayout(order, names, meId, handlers) {
    var roundEl = el('div', { class: 'yzt-round' }, ['Runde 1 / ' + ROUNDS]);
    var top = el('div', { class: 'yzt-top' }, [el('div', { class: 'yzt-title neon' }, ['🎲 Kniffel']), roundEl]);
    var statusEl = el('div', { class: 'yzt-status' }, ['']);
    var diceEls = [], diceRow = el('div', { class: 'yzt-dice-row' }), i;
    for (i = 0; i < 5; i++) { var dd = makeDie(i, handlers.onHold); diceEls.push(dd); diceRow.appendChild(dd.el); }
    var rollSub = el('span', { class: 'yzt-roll-sub' }, ['3 Würfe']);
    var rollBtn = el('button', { class: 'btn btn-primary yzt-roll', type: 'button' }, [el('span', { class: 'yzt-roll-main' }, ['🎲 Würfeln']), rollSub]);
    rollBtn.addEventListener('click', function () { handlers.onRoll(); });
    var ctrl = el('div', { class: 'yzt-ctrl' }, [rollBtn]);
    var block = buildBlock(order, names, meId, handlers.onCell);
    var scroll = el('div', { class: 'yzt-block-scroll' }, [block.table]);
    var hint = el('div', { class: 'yzt-hint hint-text' }, ['Bis zu 3× würfeln · Würfel tippen = halten (🔒) · dann ein Feld in deiner Spalte eintragen · 13 Runden']);
    var wrap = el('div', { class: 'yzt-wrap' }, [top, statusEl, diceRow, ctrl, scroll, hint]);
    return {
      root: wrap, diceEls: diceEls, block: block,
      setRound: function (r) { roundEl.textContent = 'Runde ' + r + ' / ' + ROUNDS; },
      setStatus: function (s) { statusEl.textContent = s.t; statusEl.className = 'yzt-status ' + (s.c || ''); },
      setRoll: function (enabled, left, first) {
        rollBtn.disabled = !enabled;
        rollBtn.classList.toggle('is-off', !enabled);
        if (typeof left === 'number') rollSub.textContent = first ? '3 Würfe' : (left > 0 ? ('noch ' + left) : 'kein Wurf mehr');
      },
      setDiceLive: function (live) { diceRow.classList.toggle('live', !!live); }
    };
  }

  /* ============================================================= */
  App.Minigames.yahtzee = {
    id: 'yahtzee', title: 'Kniffel', icon: '🎲', order: 130,
    subtitle: 'Würfle clever – der Block-Klassiker im Neon-Dschungel',
    single: true, multi: true, minPlayers: 2, maxPlayers: 6,

    render: function (root, ctx) {
      var dead = false, timers = [], stops = [];
      var nowFn = (ctx.mode === 'multi') ? function () { return ctx.room.now(); } : function () { return Date.now(); };

      function trackT(id) { timers.push({ t: 'to', id: id }); return id; }
      function after(ms, fn) { return trackT(setTimeout(function () { if (!dead) fn(); }, ms)); }
      function clearAllTimers() { timers.forEach(function (x) { if (x.t === 'to') clearTimeout(x.id); else clearInterval(x.id); }); timers = []; }
      function cleanup() { dead = true; clearAllTimers(); stops.forEach(function (f) { try { f(); } catch (e) {} }); stops = []; }

      /* Würfel-Animation: nicht gehaltene Würfel tanzen ROLL_MS lang (Wall-Clock),
         dann fallen alle auf finalDice. Gemeinsam für Solo & Multi. */
      function startTumble(diceEls, finalDice, held, onEnd) {
        var endAt = nowFn() + ROLL_MS, k, iv;
        for (k = 0; k < 5; k++) diceEls[k].el.classList.add('rolling');
        if (App.Audio) App.Audio.sfx('roll');
        function frame(force) {
          if (dead) { clearInterval(iv); return; }
          if (!force && nowFn() >= endAt) {
            clearInterval(iv);
            for (var j = 0; j < 5; j++) diceEls[j].el.classList.remove('rolling');
            renderDice(diceEls, finalDice, held);
            if (App.Audio) App.Audio.sfx('tick');
            if (onEnd) onEnd();
            return;
          }
          var f = [], i;
          for (i = 0; i < 5; i++) f.push(held[i] ? finalDice[i] : die());
          renderDice(diceEls, f, held);
        }
        iv = setInterval(frame, 70); timers.push({ t: 'iv', id: iv });
        frame(true);
      }

      if (ctx.mode === 'multi') startMulti(); else startSingle();
      return { cleanup: cleanup };

      /* ========================================================= */
      /*  SOLO — Mensch gegen 1-3 Bots                             */
      /* ========================================================= */
      function startSingle() {
        var cfg = null, order, names, isBot, blocks, st, refs;
        var lastBots = 2, lastDiff = 'mittel';
        showSetup();

        function showSetup() {
          var sel = { bots: lastBots, diff: lastDiff };
          var botChips = [], diffChips = [];
          var botRow = el('div', { class: 'yzt-opt-row' });
          [1, 2, 3].forEach(function (n) {
            var c = el('button', { class: 'chip yzt-chip' + (n === sel.bots ? ' on' : ''), type: 'button' }, [n + ' Bot' + (n > 1 ? 's' : '')]);
            c.addEventListener('click', function () {
              sel.bots = n;
              botChips.forEach(function (x, ix) { x.classList.toggle('on', [1, 2, 3][ix] === n); });
              if (App.Audio) App.Audio.sfx('click');
            });
            botChips.push(c); botRow.appendChild(c);
          });
          var diffs = [['leicht', 'Leicht'], ['mittel', 'Mittel'], ['schwer', 'Schwer']];
          var diffRow = el('div', { class: 'yzt-opt-row' });
          diffs.forEach(function (d) {
            var c = el('button', { class: 'chip yzt-chip' + (d[0] === sel.diff ? ' on' : ''), type: 'button' }, [d[1]]);
            c.addEventListener('click', function () {
              sel.diff = d[0];
              diffChips.forEach(function (x, ix) { x.classList.toggle('on', diffs[ix][0] === d[0]); });
              if (App.Audio) App.Audio.sfx('click');
            });
            diffChips.push(c); diffRow.appendChild(c);
          });
          var startBtn = el('button', { class: 'btn btn-primary btn-lg btn-block', type: 'button' }, ['🎲 Los geht\'s']);
          startBtn.addEventListener('click', function () { if (App.Audio) App.Audio.sfx('start'); startGame(sel.bots, sel.diff); });
          root.innerHTML = '';
          root.appendChild(el('div', { class: 'glass yzt-setup' }, [
            el('div', { class: 'yzt-setup-icon' }, ['🎲']),
            el('h2', { class: 'neon' }, ['Kniffel']),
            el('p', { class: 'hint-text' }, ['Fülle den Block mit klugen Würfen. Höchste Summe nach 13 Runden gewinnt.']),
            el('div', { class: 'yzt-opt' }, [el('div', { class: 'mg-field-title' }, ['Gegner']), botRow]),
            el('div', { class: 'yzt-opt' }, [el('div', { class: 'mg-field-title' }, ['Schwierigkeit']), diffRow]),
            startBtn
          ]));
        }

        function startGame(nBots, diff) {
          lastBots = nBots; lastDiff = diff;
          cfg = CFG[diff];
          order = ['you']; names = { you: (ctx.me && ctx.me.name) || 'Du' }; isBot = { you: false };
          var pool = shuffle(BOT_NAMES), i;
          for (i = 0; i < nBots; i++) { var id = 'bot' + (i + 1); order.push(id); names[id] = pool[i]; isBot[id] = true; }
          blocks = {}; order.forEach(function (id) { blocks[id] = emptyBlock(); });
          st = { turn: 0, round: 1, dice: null, held: [false, false, false, false, false], rolls: 0, over: false, animating: false };
          refs = buildLayout(order, names, 'you', { onRoll: onRoll, onHold: onHold, onCell: onCell });
          root.innerHTML = ''; root.appendChild(refs.root);
          paint();
          if (isBot[order[st.turn]]) after(650, botStart);
        }

        function paint() {
          if (!refs) return;
          var activeId = order[st.turn], mine = activeId === 'you' && !st.over;
          var canEnter = mine && st.rolls >= 1 && !st.animating;
          refs.setRound(st.round);
          refs.setStatus(soloStatus(activeId));
          renderDice(refs.diceEls, st.dice, st.held);
          refs.setRoll(mine && st.rolls < MAX_ROLLS && !st.animating, MAX_ROLLS - st.rolls, st.rolls === 0);
          refs.setDiceLive(mine && st.rolls >= 1 && st.rolls < MAX_ROLLS && !st.animating);
          updateBlock(refs.block, { blocks: blocks, order: order, activeTurnId: activeId, previewId: canEnter ? 'you' : null, dice: st.dice, meId: 'you' });
        }
        function soloStatus(activeId) {
          if (st.over) return { t: 'Spiel vorbei', c: 'info' };
          if (activeId === 'you') {
            if (st.animating) return { t: 'Würfeln …', c: 'you' };
            if (st.rolls === 0) return { t: 'Du bist dran – würfle!', c: 'you' };
            if (st.rolls >= MAX_ROLLS) return { t: 'Letzter Wurf – trage jetzt ein Feld ein', c: 'you' };
            return { t: 'Halten & nochmal – oder ein Feld eintragen', c: 'you' };
          }
          return { t: '🤖 ' + names[activeId] + ' ist am Zug …', c: 'opp' };
        }

        function onRoll() {
          if (dead || st.over || st.animating) return;
          if (order[st.turn] !== 'you' || st.rolls >= MAX_ROLLS) return;
          doRoll(null);
        }
        function doRoll(onDone) {
          var first = st.rolls === 0;
          var held = first ? [false, false, false, false, false] : st.held.slice();
          st.held = held;
          var nd = [], i;
          for (i = 0; i < 5; i++) nd.push((!first && held[i] && st.dice) ? st.dice[i] : die());
          st.rolls++; st.animating = true; paint();
          startTumble(refs.diceEls, nd, held, function () {
            if (dead) return;
            st.dice = nd; st.animating = false; paint();
            if (onDone) onDone();
          });
        }
        function onHold(i) {
          if (dead || st.over || st.animating) return;
          if (order[st.turn] !== 'you' || st.rolls < 1 || st.rolls >= MAX_ROLLS || !st.dice) return;
          st.held[i] = !st.held[i];
          if (App.Audio) App.Audio.sfx('select');
          paint();
        }
        function onCell(pid, key) {
          if (dead || st.over || st.animating) return;
          if (pid !== 'you' || order[st.turn] !== 'you') return;
          if (st.rolls < 1) { UI.toast('Erst würfeln', 'info'); return; }
          if (blocks.you[key] != null) return;
          enter('you', key);
        }
        function enter(id, key) {
          var pts = scoreFor(key, st.dice);
          blocks[id][key] = pts;
          soundEnter(key, pts);
          st.animating = true; paint();
          after(700, function () { if (!dead) advanceTurn(); });
        }
        function advanceTurn() {
          var lastTurn = st.turn === order.length - 1;
          if (lastTurn && st.round >= ROUNDS) { st.over = true; paint(); after(900, showEnd); return; }
          st.turn = lastTurn ? 0 : st.turn + 1;
          if (lastTurn) st.round++;
          st.dice = null; st.held = [false, false, false, false, false]; st.rolls = 0; st.animating = false;
          paint();
          if (isBot[order[st.turn]]) after(650, botStart);
        }

        /* --- Bot-Zug --- */
        function botStart() { if (!dead && !st.over && isBot[order[st.turn]]) botRoll(); }
        function botRoll() {
          if (dead || st.over) return;
          var id = order[st.turn], first = st.rolls === 0;
          var held = first ? [false, false, false, false, false] : st.held.slice();
          st.held = held;
          var nd = [], i;
          for (i = 0; i < 5; i++) nd.push((!first && held[i] && st.dice) ? st.dice[i] : die());
          st.rolls++; st.animating = true; paint();
          startTumble(refs.diceEls, nd, held, function () {
            if (dead) return;
            st.dice = nd; st.animating = false; paint();
            after(430, function () { if (!dead) botDecide(id); });
          });
        }
        function botDecide(id) {
          if (dead || st.over || order[st.turn] !== id) return;
          var rollsLeft = MAX_ROLLS - st.rolls;
          if (rollsLeft > 0) {
            var plan = planKeep(st.dice, blocks[id], cfg, rollsLeft);
            if (plan.reroll) { st.held = plan.held; paint(); after(560, botRoll); return; }
          }
          var cat = chooseCategory(st.dice, blocks[id], cfg);
          after(480, function () { if (!dead && !st.over && order[st.turn] === id) enter(id, cat); });
        }

        function showEnd() {
          var arr = order.map(function (id) { return { id: id, name: names[id], score: grandTotal(blocks[id]) }; });
          arr.sort(function (a, b) { return b.score - a.score; });
          var myScore = grandTotal(blocks.you), place = 1, i;
          for (i = 0; i < arr.length; i++) if (arr[i].id === 'you') { place = i + 1; break; }
          var best = App.Storage.get('best_yahtzee', 0), nb = myScore > best;
          if (nb) App.Storage.set('best_yahtzee', myScore);
          if (App.Audio) App.Audio.sfx(place === 1 ? 'win' : 'lose');
          var opp = arr.filter(function (x) { return x.id !== 'you'; }).map(function (x) { return x.name + ' ' + x.score; }).join(' · ');
          var label = (place === 1 ? '🏆 1. Platz von ' + order.length + '!' : place + '. Platz von ' + order.length) +
            (opp ? ' · ' + opp : '') + (nb ? ' · neuer Rekord!' : ' · Bestwert: ' + best);
          App.MG.endScreen(root, {
            score: myScore, best: best, newBest: nb, label: label,
            onExit: ctx.onExit, onAgain: function () { startGame(lastBots, lastDiff); }
          });
        }
      }

      /* ========================================================= */
      /*  MULTI — rundenbasiert über room.shared                   */
      /* ========================================================= */
      function startMulti() {
        var room = ctx.room, me = ctx.me;
        var refs = null, curScreen = '', waitCount = null;
        var sh = (room.snapshot() && room.snapshot().shared) || null;
        var lastNonce = -1, animating = false, myReported = null, autoKey = '';

        var snap = room.snapshot() || {};
        var startAt = (snap.round && snap.round.startAt) || (room.now() + 3000);
        stops.push(App.MG.countdown(root, startAt, begin, room.now));

        function begin() {
          if (dead) return;
          var onShared = function (s) { if (dead) return; sh = s; sync(); };
          var onPlayers = function () { if (dead) return; sync(); };
          room.on('shared', onShared); room.on('players', onPlayers);
          stops.push(function () { room.off('shared', onShared); room.off('players', onPlayers); });
          maybeInit();
          sync();
        }

        function maybeInit() {
          if (!room.isHost() || (sh && sh.order)) return;
          var ps = room.players(); if (!ps.length) return;
          var order = [], names = {}, blocks = {};
          ps.forEach(function (p) { order.push(p.id); names[p.id] = p.name; blocks[p.id] = emptyBlock(); });
          room.setShared({
            order: order, names: names, blocks: blocks, turn: 0, round: 1,
            dice: null, held: [false, false, false, false, false], rolls: 0, nonce: 0, last: null, over: false
          });
        }

        function myTurn() { return !!(sh && sh.order && sh.order[sh.turn] === me.id); }

        function sync() {
          if (dead) return;
          if (!sh || !sh.order) { if (room.isHost()) maybeInit(); showWaiting(); return; }
          if (sh.over) { showEnd(); return; }
          if (curScreen !== 'game') buildGame();
          hostAuto();
          var newRoll = (sh.nonce !== lastNonce) && !!sh.dice;
          if (newRoll) { lastNonce = sh.nonce; animating = true; }
          paint();
          if (newRoll) tumble();
          else if (!animating) renderDice(refs.diceEls, sh.dice, sh.held);
          report();
        }

        function buildGame() {
          curScreen = 'game';
          refs = buildLayout(sh.order, sh.names || {}, me.id, { onRoll: onRoll, onHold: onHold, onCell: onCell });
          root.innerHTML = ''; root.appendChild(refs.root);
          lastNonce = -1; animating = false;
        }

        function paint() {
          if (!refs || curScreen !== 'game') return;
          var activeId = sh.order[sh.turn], mine = myTurn();
          var canEnter = mine && sh.rolls >= 1 && !animating && !sh.over;
          refs.setRound(sh.round);
          refs.setStatus(multiStatus(activeId, mine));
          refs.setRoll(mine && sh.rolls < MAX_ROLLS && !animating && !sh.over, MAX_ROLLS - sh.rolls, sh.rolls === 0);
          refs.setDiceLive(mine && sh.rolls >= 1 && sh.rolls < MAX_ROLLS && !animating);
          updateBlock(refs.block, { blocks: sh.blocks, order: sh.order, activeTurnId: activeId, previewId: canEnter ? me.id : null, dice: sh.dice, meId: me.id });
        }
        function multiStatus(activeId, mine) {
          if (mine) {
            if (animating) return { t: 'Würfeln …', c: 'you' };
            if (sh.rolls === 0) return { t: 'Du bist dran – würfle!', c: 'you' };
            if (sh.rolls >= MAX_ROLLS) return { t: 'Letzter Wurf – trage jetzt ein Feld ein', c: 'you' };
            return { t: 'Halten & nochmal – oder ein Feld eintragen', c: 'you' };
          }
          return { t: '🎲 ' + ((sh.names && sh.names[activeId]) || 'Spieler') + ' ist am Zug …', c: 'opp' };
        }
        function tumble() {
          startTumble(refs.diceEls, sh.dice.slice(), sh.held.slice(), function () {
            if (dead) return;
            animating = false; paint(); renderDice(refs.diceEls, sh.dice, sh.held);
          });
        }
        function report() {
          var t = grandTotal(sh.blocks[me.id] || emptyBlock());
          if (t !== myReported) { myReported = t; try { room.reportScore(t); } catch (e) {} }
        }

        function onRoll() {
          if (dead || animating || !sh || sh.over || !myTurn() || sh.rolls >= MAX_ROLLS) return;
          var first = sh.rolls === 0;
          var held = first ? [false, false, false, false, false] : sh.held.slice();
          var nd = [], i;
          for (i = 0; i < 5; i++) nd.push((!first && held[i] && sh.dice) ? sh.dice[i] : die());
          room.setShared({ dice: nd, held: held, rolls: sh.rolls + 1, nonce: (sh.nonce || 0) + 1 });
        }
        function onHold(i) {
          if (dead || animating || !sh || sh.over || !myTurn()) return;
          if (sh.rolls < 1 || sh.rolls >= MAX_ROLLS || !sh.dice) return;
          var held = sh.held.slice(); held[i] = !held[i];
          room.setShared({ held: held });
          if (App.Audio) App.Audio.sfx('select');
        }
        function onCell(pid, key) {
          if (dead || animating || !sh || sh.over) return;
          if (pid !== me.id) return;
          if (!myTurn()) { UI.toast('Warte – du bist nicht dran', 'info'); return; }
          if (sh.rolls < 1) { UI.toast('Erst würfeln', 'info'); return; }
          if (sh.blocks[me.id][key] != null) return;
          applyEnter(me.id, key, scoreFor(key, sh.dice), false);
          soundEnter(key, scoreFor(key, sh.dice));
        }
        function applyEnter(id, key, pts, auto) {
          var blocks = cloneBlocks(sh.blocks); blocks[id][key] = pts;
          var lastTurn = sh.turn === sh.order.length - 1, over = lastTurn && sh.round >= ROUNDS;
          room.setShared({
            blocks: blocks,
            turn: over ? sh.turn : (lastTurn ? 0 : sh.turn + 1),
            round: over ? sh.round : (lastTurn ? sh.round + 1 : sh.round),
            dice: null, held: [false, false, false, false, false], rolls: 0,
            last: { id: id, cat: key, pts: pts, auto: !!auto }, over: over
          });
        }

        /* Fehlt der aktive Spieler (verlassen), spielt der Host seinen Zug. */
        function hostAuto() {
          if (!room.isHost() || sh.over) return;
          var activeId = sh.order[sh.turn], ps = room.players(), i;
          for (i = 0; i < ps.length; i++) if (ps[i].id === activeId) return;
          var key = sh.round + ':' + sh.turn;
          if (autoKey === key) return;
          autoKey = key;
          after(850, function () {
            if (dead || !sh || sh.over || sh.order[sh.turn] !== activeId) return;
            var now = room.players(), j;
            for (j = 0; j < now.length; j++) if (now[j].id === activeId) return;
            var d = [die(), die(), die(), die(), die()];
            var cat = chooseCategory(d, sh.blocks[activeId], CFG.mittel);
            applyEnter(activeId, cat, scoreFor(cat, d), true);
          });
        }

        function showWaiting() {
          if (curScreen === 'wait') { if (waitCount) waitCount.textContent = room.players().length + ' Spieler'; return; }
          curScreen = 'wait';
          waitCount = el('div', { class: 'yzt-big neon' }, [room.players().length + ' Spieler']);
          root.innerHTML = '';
          root.appendChild(el('div', { class: 'glass yzt-setup' }, [
            el('div', { class: 'yzt-setup-icon' }, ['🎲']),
            el('h2', { class: 'neon' }, ['Kniffel']),
            waitCount,
            el('p', { class: 'hint-text' }, ['Warte auf Mitspieler …']),
            el('div', { class: 'controls-row' }, [el('button', { class: 'btn btn-ghost', type: 'button', onclick: ctx.onExit }, ['Zurück zur Lobby'])])
          ]));
        }

        function showEnd() {
          if (curScreen === 'end') return;
          curScreen = 'end';
          var players = sh.order.map(function (id) {
            return { id: id, name: (sh.names && sh.names[id]) || 'Spieler', score: grandTotal(sh.blocks[id] || emptyBlock()) };
          });
          try { room.reportScore(grandTotal(sh.blocks[me.id] || emptyBlock())); } catch (e) {}
          var top = players.slice().sort(function (a, b) { return b.score - a.score; })[0];
          if (App.Audio) App.Audio.sfx(top && top.id === me.id ? 'win' : 'lose');
          after(220, function () {
            if (dead) return;
            App.MG.endScreen(root, { players: players, meId: me.id, onExit: ctx.onExit });
          });
        }
      }
    }
  };

  /* ===================== STYLES ===================== */
  function injectStyle() {
    UI.injectStyle('mg-yahtzee-css', [
      '.yzt-wrap{display:flex;flex-direction:column;gap:12px;max-width:640px;margin:0 auto;width:100%;}',
      '.yzt-top{display:flex;justify-content:space-between;align-items:center;gap:10px;}',
      '.yzt-title{font-weight:900;font-size:18px;}',
      '.yzt-round{font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;font-weight:800;}',
      '.yzt-status{text-align:center;font-weight:800;font-size:clamp(14px,4vw,18px);min-height:24px;transition:color .15s;}',
      '.yzt-status.you{color:var(--neon);text-shadow:0 0 10px rgba(57,255,20,.4);}',
      '.yzt-status.opp{color:var(--aqua);}',
      '.yzt-status.info{color:var(--muted);}',
      /* --- Würfel --- */
      '.yzt-dice-row{display:flex;gap:clamp(6px,2.4vw,12px);justify-content:center;align-items:center;padding:4px 0;touch-action:none;}',
      '.yzt-die{position:relative;width:clamp(44px,12.5vw,58px);aspect-ratio:1/1;border-radius:12px;padding:0;',
      'background:linear-gradient(160deg,#0d3320,#061a10);border:2px solid var(--stroke);cursor:default;',
      'display:flex;align-items:center;justify-content:center;-webkit-tap-highlight-color:transparent;',
      'touch-action:none;user-select:none;-webkit-user-select:none;transition:transform .12s,border-color .15s,box-shadow .15s;}',
      '.yzt-dice-row.live .yzt-die{cursor:pointer;}',
      '.yzt-dice-row.live .yzt-die:hover{border-color:var(--gold);transform:translateY(-2px);box-shadow:0 0 14px rgba(255,210,63,.35);}',
      '.yzt-die:active{transform:scale(.95);}',
      '.yzt-pipgrid{display:grid;grid-template-columns:repeat(3,1fr);grid-template-rows:repeat(3,1fr);width:74%;height:74%;gap:2px;}',
      '.yzt-pip{border-radius:50%;background:transparent;}',
      '.yzt-pip.on{background:radial-gradient(circle at 40% 35%,#eafff0,var(--neon));box-shadow:0 0 6px rgba(57,255,20,.7);}',
      '.yzt-q{display:none;font-size:26px;font-weight:900;color:var(--muted);}',
      '.yzt-die.empty .yzt-pipgrid{display:none;}',
      '.yzt-die.empty .yzt-q{display:block;}',
      '.yzt-die.held{border-color:var(--gold);background:linear-gradient(160deg,#2a2408,#120d02);box-shadow:0 0 0 1px var(--gold),0 0 16px rgba(255,210,63,.5);}',
      '.yzt-die.held .yzt-pip.on{background:radial-gradient(circle at 40% 35%,#fff6d8,var(--gold));box-shadow:0 0 6px rgba(255,210,63,.7);}',
      '.yzt-die.held::after{content:"🔒";position:absolute;top:-9px;right:-9px;font-size:13px;filter:drop-shadow(0 0 3px #000);}',
      '.yzt-die.rolling{animation:yzt-shake .18s linear infinite;}',
      '@keyframes yzt-shake{0%{transform:translateY(0) rotate(-5deg)}25%{transform:translateY(-3px) rotate(4deg)}50%{transform:translateY(0) rotate(-2deg)}75%{transform:translateY(-2px) rotate(5deg)}100%{transform:translateY(0) rotate(0)}}',
      /* --- Wurf-Button --- */
      '.yzt-ctrl{display:flex;justify-content:center;}',
      '.yzt-roll{display:inline-flex;flex-direction:column;align-items:center;line-height:1.15;min-width:160px;padding:9px 24px;}',
      '.yzt-roll-main{font-weight:900;font-size:17px;}',
      '.yzt-roll-sub{font-size:11px;opacity:.85;text-transform:uppercase;letter-spacing:1px;}',
      '.yzt-roll.is-off{opacity:.45;cursor:default;box-shadow:none;}',
      /* --- Block-Tabelle --- */
      '.yzt-block-scroll{width:100%;overflow-x:auto;-webkit-overflow-scrolling:touch;border-radius:14px;border:1px solid var(--stroke);}',
      '.yzt-block{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums;}',
      '.yzt-block th,.yzt-block td{border:1px solid var(--stroke);padding:5px 7px;text-align:center;}',
      '.yzt-cat-h{background:rgba(4,16,10,.92);text-align:left;font-size:11px;color:var(--leaf);text-transform:uppercase;letter-spacing:1px;position:sticky;left:0;z-index:3;}',
      '.yzt-cat{text-align:left;background:rgba(6,22,14,.94);white-space:nowrap;position:sticky;left:0;z-index:2;}',
      '.yzt-cat-l{font-weight:700;font-size:13px;color:var(--text);}',
      '.yzt-cat-fx{font-size:10px;color:var(--muted);margin-left:5px;}',
      '.yzt-col-h{min-width:52px;background:rgba(9,32,21,.75);}',
      '.yzt-col-h.me .yzt-col-nm{color:var(--aqua);}',
      '.yzt-col-h.active{border-color:var(--neon);box-shadow:inset 0 0 12px rgba(57,255,20,.28);}',
      '.yzt-col-nm{font-size:12px;font-weight:800;max-width:72px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin:0 auto;}',
      '.yzt-col-tot{font-size:15px;font-weight:900;color:var(--gold);}',
      '.yzt-cell{min-width:52px;height:30px;font-size:14px;font-weight:800;color:var(--text);cursor:default;transition:background .3s;}',
      '.yzt-cell.col-active{background:rgba(57,255,20,.05);}',
      '.yzt-cell.filled{color:var(--leaf);}',
      '.yzt-cell.filled.big{color:var(--gold);text-shadow:0 0 8px rgba(255,210,63,.5);}',
      '.yzt-cell.crossed{color:var(--danger);opacity:.7;}',
      '.yzt-cell.open{color:transparent;}',
      '.yzt-cell.preview{color:var(--neon);cursor:pointer;background:rgba(57,255,20,.10);border-color:var(--stroke-2);}',
      '.yzt-cell.preview.zero{color:var(--muted);}',
      '.yzt-cell.preview:hover{background:rgba(57,255,20,.24);box-shadow:inset 0 0 10px rgba(57,255,20,.35);}',
      '.yzt-cell.preview:active{transform:none;background:rgba(57,255,20,.34);}',
      '.yzt-cell.pop{animation:yzt-pop .5s ease;}',
      '@keyframes yzt-pop{0%{background:rgba(255,210,63,.55);}100%{background:transparent;}}',
      '.yzt-srow .yzt-cat-sp{font-size:11px;text-transform:uppercase;letter-spacing:1px;color:var(--muted);text-align:left;background:rgba(4,16,10,.92);}',
      '.yzt-scell{font-size:12px;font-weight:800;color:var(--aqua-soft);background:rgba(4,16,10,.55);}',
      '.yzt-scell.got{color:var(--gold);text-shadow:0 0 8px rgba(255,210,63,.5);}',
      '.yzt-sub .yzt-scell{color:var(--leaf);}',
      '.yzt-grand .yzt-cat-sp{color:var(--gold);font-weight:900;}',
      '.yzt-grand .yzt-scell{color:var(--gold);font-weight:900;font-size:14px;}',
      '.yzt-hint{text-align:center;}',
      /* --- Setup / Warten --- */
      '.yzt-setup{padding:26px 22px;text-align:center;display:flex;flex-direction:column;gap:14px;align-items:center;max-width:440px;margin:0 auto;}',
      '.yzt-setup-icon{font-size:52px;filter:drop-shadow(0 0 14px var(--stroke-2));animation:yzt-float 3s ease-in-out infinite;}',
      '@keyframes yzt-float{0%,100%{transform:translateY(0) rotate(-4deg)}50%{transform:translateY(-8px) rotate(6deg)}}',
      '.yzt-setup h2{margin:0;}',
      '.yzt-opt{width:100%;display:flex;flex-direction:column;gap:8px;align-items:center;}',
      '.yzt-opt-row{display:flex;gap:8px;flex-wrap:wrap;justify-content:center;}',
      '.yzt-chip{cursor:pointer;}',
      '.yzt-chip.on{color:#052012;background:linear-gradient(180deg,var(--neon-soft),var(--neon));border-color:var(--neon);box-shadow:0 0 14px rgba(57,255,20,.4);}',
      '.yzt-big{font-size:clamp(22px,7vw,34px);font-weight:900;}'
    ].join(''));
  }
})();
