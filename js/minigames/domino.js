/* domino.js — "Domino" (Doppel-Sechs) im Neon-Dschungel.
 *
 * IDEE      Jeder bekommt Steine auf die Hand (zu zweit 7, sonst 5), der Rest ist
 *           der Talon. In der Mitte waechst eine Kette. Angelegt wird an eines der
 *           beiden offenen Enden — die beruehrenden Haelften muessen dieselbe
 *           Augenzahl haben. Wer nichts Passendes hat, zieht aus dem Talon (so
 *           lange, bis es passt); ist der Talon leer, muss er passen. Wer zuerst
 *           alle Steine los ist, gewinnt die Runde. Passen alle reihum, ist die
 *           Kette blockiert — dann gewinnt der mit den wenigsten Restaugen.
 *
 * STEUERUNG Reine Tipp-/Klick-Steuerung (Touch + Maus): Stein in der Hand antippen
 *           = anlegen. Passt er an BEIDE Enden, erscheint die Seitenwahl (Links /
 *           Rechts) — auch die leuchtenden End-Plaketten selbst sind antippbar.
 *           "Ziehen" und "Passen" sind Knoepfe und nur aktiv, wenn sie erlaubt sind.
 *
 * PUNKTE    Der Rundensieger bekommt die Restaugen aller Gegner (bei blockierter
 *           Kette abzueglich der eigenen). Nach 3 Runden entscheidet die Gesamt-
 *           punktzahl -> Podest (Multi) bzw. Bestwert (Solo, 'best_domino').
 *
 * SOLO      Gegen 1-3 Bots (Leicht / Normal / Schwer) mit echter Ablage-Strategie:
 *           hohe Steine und Doppel zuerst abwerfen, Enden so waehlen, dass die
 *           eigenen Reststeine weiter passen ("Enden kontrollieren"), und ab Stufe
 *           "Schwer" merken sich die Bots, auf welche Augenzahlen ein Gegner schon
 *           gepasst hat, und legen genau diese Enden hin (besonders, wenn der
 *           Gegner kurz vor dem Ausgehen ist).
 *
 * SYNC      Rundenbasiert ueber room.shared. Der Host mischt pro Runde ein Deck aus
 *           einem Seed und legt es samt Startspieler in shared; jeder Client leitet
 *           daraus NUR SEINE EIGENE Hand ab (ueber den order-Index) und haelt sie
 *           danach lokal — gezogene Steine kennt ebenfalls nur der Zieher. Geteilt
 *           werden Kette, Steinzahlen, Zieh-Zeiger, Zug, Paesse und Log. Es
 *           schreibt immer nur der Spieler, der am Zug ist -> keine Kollisionen.
 *           Restaugen sind geheim, bis die Runde vorbei ist: dann schreibt jeder
 *           seine Summe in einen EIGENEN Schluessel ('pip_<id>', deshalb kein
 *           gemeinsames Objekt -> kein Ueberschreiben), und der Host wertet aus,
 *           mischt weiter und hat einen Watchdog fuer weggelaufene Spieler.
 */
(function () {
  'use strict';
  window.App = window.App || {}; App.Minigames = App.Minigames || {};
  var UI = App.UI, el = UI.el;

  injectStyle();

  var ROUNDS = 3;
  var BOT_NAMES = ['🦜 Tukan', '🐍 Kobra', '🐒 Mango'];
  var LEVELS = ['Leicht', 'Normal', 'Schwer'];
  var PIP_TIMEOUT = 4500;                       // ms, bis der Host ohne alle Meldungen wertet

  function sfx(n) { if (App.Audio) App.Audio.sfx(n); }

  /* ===================== Stein-Grundlagen =====================
   * Ein Stein ist ein 2-Zeichen-String "ab" mit den Augenzahlen a und b.
   * Auf der Hand ist er kanonisch (a <= b), in der Kette ORIENTIERT:
   * links liegende Haelfte = a, rechts liegende = b. */
  function aOf(t) { return Number(t.charAt(0)); }
  function bOf(t) { return Number(t.charAt(1)); }
  function pipsOf(t) { return aOf(t) + bOf(t); }
  function isDouble(t) { return t.charAt(0) === t.charAt(1); }
  function tileLabel(t) { return aOf(t) + '|' + bOf(t); }
  function flip(t) { return t.charAt(1) + t.charAt(0); }

  function buildDeck() {
    var d = [], a, b;
    for (a = 0; a <= 6; a++) for (b = a; b <= 6; b++) d.push('' + a + b);
    return d;                                   // 28 Steine (Doppel-Sechs)
  }
  function handSize(n) { return n === 2 ? 7 : 5; }
  function handPips(h) { var s = 0, i; for (i = 0; i < h.length; i++) s += pipsOf(h[i]); return s; }
  function sortHand(h) {
    return h.slice().sort(function (x, y) { return aOf(x) - aOf(y) || bOf(x) - bOf(y); });
  }

  /* deterministischer Zufall (mulberry32) — Host mischt, alle sehen dasselbe Deck */
  function rng(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t = t ^ (t + Math.imul(t ^ (t >>> 7), t | 61));
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function shuffle(arr, rnd) {
    var a = arr.slice(), i, j, t;
    for (i = a.length - 1; i > 0; i--) { j = Math.floor(rnd() * (i + 1)); t = a[i]; a[i] = a[j]; a[j] = t; }
    return a;
  }

  /* ===================== Ketten-Logik (Solo + Multi gemeinsam) ===================== */
  function leftEnd(chain) { return chain && chain.length ? aOf(chain[0]) : -1; }
  function rightEnd(chain) { return chain && chain.length ? bOf(chain[chain.length - 1]) : -1; }
  function fitsLeft(t, chain) {
    if (!chain || !chain.length) return true;
    var L = leftEnd(chain); return aOf(t) === L || bOf(t) === L;
  }
  function fitsRight(t, chain) {
    if (!chain || !chain.length) return true;
    var R = rightEnd(chain); return aOf(t) === R || bOf(t) === R;
  }
  function canPlay(t, chain) { return fitsLeft(t, chain) || fitsRight(t, chain); }
  function hasPlayable(hand, chain) {
    var i; for (i = 0; i < hand.length; i++) if (canPlay(hand[i], chain)) return true;
    return false;
  }
  /* Ausrichtung beim Anlegen: links muss die RECHTE Haelfte ans offene Ende passen … */
  function orientLeft(t, chain) { return bOf(t) === leftEnd(chain) ? t : flip(t); }
  /* … rechts die LINKE. */
  function orientRight(t, chain) { return aOf(t) === rightEnd(chain) ? t : flip(t); }
  function chainAfter(chain, tile, side) {
    if (!chain.length) return [tile];
    if (side === 'L') return [orientLeft(tile, chain)].concat(chain);
    return chain.concat([orientRight(tile, chain)]);
  }
  function boneyardLeft(st) { return Math.max(0, (st.deck || []).length - (st.drawIdx || 0)); }
  function pipKey(id) { return 'pip_' + id; }

  /* naechster Index im Kreis, ueberspringt abwesende Spieler */
  function stepIdx(order, from, alive) {
    var i = from, guard = 0;
    while (guard < 200) {
      i = (i + 1) % order.length; guard++;
      if (!alive || alive(order[i])) return i;
    }
    return (from + 1) % order.length;
  }
  function nextOf(st, pid, alive) { return st.order[stepIdx(st.order, st.order.indexOf(pid), alive)]; }
  function aliveCount(order, alive) {
    if (!alive) return order.length;
    var n = 0, i;
    for (i = 0; i < order.length; i++) if (alive(order[i])) n++;
    return Math.max(1, n);
  }

  /* Patch fuers Anlegen — identisch fuer Solo (lokal) und Multi (setShared). */
  function playPatch(st, pid, tile, side, nameOf, alive) {
    var chain = chainAfter((st.chain || []).slice(), tile, side);
    var counts = Object.assign({}, st.counts || {});
    counts[pid] = Math.max(0, (counts[pid] || 0) - 1);
    var patch = {
      chain: chain, counts: counts, passes: 0,
      log: nameOf(pid) + ' legt ' + tileLabel(tile) + ' an',
      logSeq: (st.logSeq || 0) + 1
    };
    if (counts[pid] === 0) {
      patch.roundOver = true; patch.winner = pid; patch.blocked = false; patch.turn = null;
      patch.log = '🏆 ' + nameOf(pid) + ' ist alle Steine los!';
    } else {
      patch.turn = nextOf(st, pid, alive);
    }
    return patch;
  }
  /* Patch fuers Ziehen — liefert zusaetzlich den gezogenen Stein (nur fuer den Zieher). */
  function drawPatch(st, pid, nameOf) {
    var di = st.drawIdx || 0, deck = st.deck || [];
    if (di >= deck.length) return null;
    var counts = Object.assign({}, st.counts || {});
    counts[pid] = (counts[pid] || 0) + 1;
    return {
      tile: deck[di],
      patch: {
        drawIdx: di + 1, counts: counts,
        log: nameOf(pid) + ' zieht einen Stein',
        logSeq: (st.logSeq || 0) + 1
      }
    };
  }
  /* Patch fuers Passen. Passen alle reihum -> Kette blockiert. */
  function passPatch(st, pid, nameOf, alive) {
    var passes = (st.passes || 0) + 1;
    var patch = {
      passes: passes, log: nameOf(pid) + ' passt',
      logSeq: (st.logSeq || 0) + 1
    };
    if (passes >= aliveCount(st.order, alive)) {
      patch.roundOver = true; patch.blocked = true; patch.winner = null; patch.turn = null;
      patch.log = '🚧 Kette blockiert — die Restaugen entscheiden!';
    } else {
      patch.turn = nextOf(st, pid, alive);
    }
    return patch;
  }
  /* frische Runde: gemischtes Deck; es beginnt, wer den hoechsten Doppel haelt
     (sonst den hoechsten Stein) — wie am echten Tisch. */
  function dealPatch(order, round, scores, seed, nameOf) {
    var H = handSize(order.length);
    var deck = shuffle(buildDeck(), rng(seed));
    var counts = {}, startId = order[0], bestV = -1;
    order.forEach(function (id, k) {
      counts[id] = H;
      deck.slice(k * H, k * H + H).forEach(function (t) {
        var v = (isDouble(t) ? 100 : 0) + pipsOf(t);
        if (v > bestV) { bestV = v; startId = id; }
      });
    });
    var patch = {
      order: order, round: round, seed: seed, deck: deck, drawIdx: order.length * H,
      chain: [], counts: counts, turn: startId, passes: 0,
      scores: scores || {}, roundOver: false, winner: null, blocked: false,
      resultReady: false, seriesOver: false,
      log: 'Runde ' + round + ' — ' + nameOf(startId) + ' beginnt',
      logSeq: 0
    };
    order.forEach(function (id) { patch[pipKey(id)] = null; });   // alte Meldungen loeschen
    return patch;
  }
  function handFromDeal(st, idx) {
    var H = handSize(st.order.length);
    return sortHand((st.deck || []).slice(idx * H, idx * H + H));
  }
  /* Rundenabrechnung: Sieger bekommt die Restaugen der Gegner (blockiert: minus eigene). */
  function settle(st, pips) {
    var winner = st.winner, order = st.order;
    if (!winner) {                                    // blockiert -> wenigste Restaugen
      var bv = Infinity;
      order.forEach(function (id) {
        var p = pips[id];
        if (typeof p !== 'number') return;
        if (p < bv) { bv = p; winner = id; }
      });
      if (!winner) winner = order[0];
    }
    var add = 0;
    order.forEach(function (id) { if (id !== winner) add += (pips[id] || 0); });
    add = Math.max(0, add - (pips[winner] || 0));
    var scores = Object.assign({}, st.scores || {});
    scores[winner] = (scores[winner] || 0) + add;
    return { winner: winner, add: add, scores: scores };
  }

  /* ===================== Bot-Strategie =====================
   * level: 0 = leicht, 1 = normal, 2 = schwer.
   * mem[pid] = { pip: true } — worauf dieser Gegner schon gepasst hat. */
  function botOptions(hand, chain) {
    var opts = [];
    hand.forEach(function (t) {
      if (!chain.length) { opts.push({ tile: t, side: 'R' }); return; }
      if (fitsLeft(t, chain)) opts.push({ tile: t, side: 'L' });
      if (fitsRight(t, chain) && !(leftEnd(chain) === rightEnd(chain) && fitsLeft(t, chain))) {
        opts.push({ tile: t, side: 'R' });       // bei gleichen Enden reicht eine Variante
      }
    });
    return opts;
  }
  function optionValue(o, hand, st, pid, level, mem, alive) {
    var v = pipsOf(o.tile) * 1.4;                          // hohe Steine zuerst abwerfen
    if (isDouble(o.tile)) v += 4;                          // Doppel sind spaeter schwer loszuwerden
    if (level === 0) return v;

    var nc = chainAfter(st.chain.slice(), o.tile, o.side);
    var L = leftEnd(nc), R = rightEnd(nc);
    var rest = hand.filter(function (t) { return t !== o.tile; });

    /* Enden kontrollieren: wie viele eigene Reststeine passen danach noch? */
    var match = 0;
    rest.forEach(function (t) {
      if (aOf(t) === L || bOf(t) === L || aOf(t) === R || bOf(t) === R) match++;
    });
    v += match * 2.2;
    if (!rest.length) v += 50;                             // Ausgehen schlaegt alles
    if (level < 2) return v;

    /* Schwer: gezielt Enden hinlegen, die der naechste Gegner nicht bedienen kann. */
    var nxt = nextOf(st, pid, alive);
    var lack = (mem && mem[nxt]) || {};
    if (lack[L]) v += 5;
    if (lack[R]) v += 5;
    if (L === R) v += 2.5;                                 // beide Enden gleich = eng
    if ((st.counts[nxt] || 0) <= 2) {                      // Gegner kurz vorm Ausgehen
      if (lack[L]) v += 4;
      if (lack[R]) v += 4;
      v += pipsOf(o.tile) * 0.4;
    }
    return v;
  }
  function botChoose(hand, st, pid, level, mem, alive) {
    var opts = botOptions(hand, st.chain || []);
    if (!opts.length) return null;
    if (level === 0 && Math.random() < 0.6) return opts[Math.floor(Math.random() * opts.length)];
    var best = null, bestV = -Infinity;
    opts.forEach(function (o) {
      var v = optionValue(o, hand, st, pid, level, mem, alive);
      v += Math.random() * (level === 2 ? 0.6 : 2.4);      // etwas Rauschen -> nicht berechenbar
      if (v > bestV) { bestV = v; best = o; }
    });
    return best;
  }

  /* ===================== DOM-Bausteine ===================== */
  var DOTS = {
    0: [], 1: [4], 2: [0, 8], 3: [0, 4, 8],
    4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8]
  };
  function faceEl(n) {
    var f = el('div', { class: 'dmo-face' }), on = DOTS[n] || [], i;
    for (i = 0; i < 9; i++) f.appendChild(el('div', { class: 'dmo-dot' + (on.indexOf(i) >= 0 ? ' on' : '') }));
    return f;
  }
  /* orient: 'h' = liegend (links|rechts), 'v' = stehend (oben/unten) */
  function tileEl(t, orient, cls) {
    return el('div', { class: 'dmo-tile dmo-tile-' + orient + (cls ? ' ' + cls : '') }, [
      faceEl(aOf(t)), el('div', { class: 'dmo-bar' }), faceEl(bOf(t))
    ]);
  }
  /* Deko-Stein statt Unicode-Zeichen: die Domino-Glyphen (U+1F0xx) fehlen auf
     iOS/iPadOS komplett und werden dort zu leeren Kaesten — der CSS-Stein
     sieht ueberall gleich aus. */
  function icoTile(cls) { return tileEl('63', 'h', 'dmo-ico' + (cls ? ' ' + cls : '')); }

  function buildLayout(h) {
    var roundEl = el('div', { class: 'dmo-round' }, ['Runde 1 / ' + ROUNDS]);
    var top = el('div', { class: 'dmo-top' }, [
      el('div', { class: 'dmo-brand neon' }, [icoTile(), el('span', {}, ['Domino'])]), roundEl
    ]);
    var oppsEl = el('div', { class: 'dmo-opps' });
    var statusEl = el('div', { class: 'dmo-status you' }, ['']);

    var endL = el('button', {
      class: 'dmo-end dmo-end-l', type: 'button', title: 'Links anlegen',
      onclick: function () { h.onSide('L'); }
    }, ['–']);
    var endR = el('button', {
      class: 'dmo-end dmo-end-r', type: 'button', title: 'Rechts anlegen',
      onclick: function () { h.onSide('R'); }
    }, ['–']);
    var chainEl = el('div', { class: 'dmo-chain' });
    var scrollEl = el('div', { class: 'dmo-scroll' }, [chainEl]);
    var table = el('div', { class: 'dmo-table' }, [endL, scrollEl, endR]);

    var sideRow = el('div', { class: 'dmo-side-row' }, [
      el('span', { class: 'dmo-side-q' }, ['An welches Ende?']),
      el('button', { class: 'btn btn-aqua dmo-side-b', type: 'button', onclick: function () { h.onSide('L'); } }, ['◀ Links']),
      el('button', { class: 'btn btn-aqua dmo-side-b', type: 'button', onclick: function () { h.onSide('R'); } }, ['Rechts ▶']),
      el('button', { class: 'btn btn-ghost dmo-side-b', type: 'button', onclick: function () { h.onSide(null); } }, ['Abbrechen'])
    ]);

    var boneEl = el('span', { class: 'dmo-bone-n' }, ['0']);
    var drawBtn = el('button', { class: 'btn btn-primary dmo-act', type: 'button', onclick: h.onDraw }, ['➕ Ziehen']);
    var passBtn = el('button', { class: 'btn btn-ghost dmo-act', type: 'button', onclick: h.onPass }, ['Passen']);
    var actions = el('div', { class: 'dmo-actions' }, [
      el('div', { class: 'dmo-bone' }, [el('span', { class: 'dmo-bone-l' }, ['Talon']), boneEl]),
      drawBtn, passBtn
    ]);

    var myNameEl = el('span', { class: 'dmo-my-nm' }, ['Du']);
    var myScoreEl = el('span', { class: 'dmo-my-sc' }, ['★ 0']);
    var myPipsEl = el('span', { class: 'dmo-my-pips' }, ['']);
    var handEl = el('div', { class: 'dmo-hand' });
    var handWrap = el('div', { class: 'dmo-hand-wrap' }, [
      el('div', { class: 'dmo-my-bar' }, [myNameEl, myPipsEl, myScoreEl]),
      handEl
    ]);

    var hint = el('p', { class: 'hint-text dmo-hint' }, [
      'Stein antippen = anlegen · gleiche Augenzahl ans offene Ende · nichts passend? ziehen · alle Steine weg = Runde gewonnen'
    ]);

    var wrap = el('div', { class: 'dmo-wrap' }, [top, oppsEl, statusEl, table, sideRow, actions, handWrap, hint]);
    return {
      root: wrap, roundEl: roundEl, oppsEl: oppsEl, statusEl: statusEl,
      endL: endL, endR: endR, chainEl: chainEl, scrollEl: scrollEl,
      sideRow: sideRow, boneEl: boneEl, drawBtn: drawBtn, passBtn: passBtn,
      myNameEl: myNameEl, myScoreEl: myScoreEl, myPipsEl: myPipsEl, handEl: handEl,
      oppKey: '', oppNodes: {}, chainKey: null, chainArr: [], handKey: null, handNodes: {}
    };
  }

  /* ---------- view-model -> DOM (in-place, kein Neuaufbau -> kein Flackern) ---------- */
  function syncOpps(refs, vm) {
    var key = vm.opponents.map(function (o) { return o.id; }).join('|');
    if (refs.oppKey !== key) {
      refs.oppKey = key; refs.oppsEl.innerHTML = ''; refs.oppNodes = {};
      vm.opponents.forEach(function (o) {
        var nm = el('span', { class: 'dmo-opp-nm' }, [o.name]);
        var cnt = el('span', { class: 'dmo-opp-cnt' }, ['0']);
        var sc = el('span', { class: 'dmo-opp-sc' }, ['0']);
        var node = el('div', { class: 'dmo-opp' }, [
          icoTile('dmo-opp-ico'),
          el('div', { class: 'dmo-opp-info' }, [nm, el('div', { class: 'dmo-opp-sub' }, [cnt, sc])])
        ]);
        refs.oppNodes[o.id] = { root: node, nm: nm, cnt: cnt, sc: sc };
        refs.oppsEl.appendChild(node);
      });
    }
    vm.opponents.forEach(function (o) {
      var n = refs.oppNodes[o.id]; if (!n) return;
      n.nm.textContent = o.name;
      n.cnt.textContent = (vm.roundOver && typeof o.pips === 'number')
        ? (o.pips + ' Augen') : (o.count + (o.count === 1 ? ' Stein' : ' Steine'));
      n.sc.textContent = '★ ' + o.score;
      n.root.classList.toggle('active', !!o.active);
      n.root.classList.toggle('gone', !!o.gone);
      n.root.classList.toggle('win', !!o.isWinner && vm.roundOver);
      n.root.classList.toggle('danger', !vm.roundOver && o.count > 0 && o.count <= 2);
    });
  }

  function syncChain(refs, vm) {
    var key = vm.chain.join(',');
    if (refs.chainKey !== key) {
      var grew = null;
      if (refs.chainArr && vm.chain.length === refs.chainArr.length + 1 && refs.chainArr.length) {
        grew = (vm.chain[0] !== refs.chainArr[0]) ? 'L' : 'R';
      }
      refs.chainKey = key; refs.chainArr = vm.chain.slice();
      refs.chainEl.innerHTML = '';
      if (!vm.chain.length) {
        refs.chainEl.appendChild(el('div', { class: 'dmo-empty' }, ['Die Kette ist leer — leg den ersten Stein']));
      } else {
        vm.chain.forEach(function (t, i) {
          var isNew = grew === 'L' ? i === 0 : grew === 'R' ? i === vm.chain.length - 1 : false;
          refs.chainEl.appendChild(tileEl(t, isDouble(t) ? 'v' : 'h', 'dmo-ct' + (isNew ? ' is-new' : '')));
        });
      }
      /* immer das zuletzt bespielte Ende zeigen */
      if (grew === 'L') refs.scrollEl.scrollLeft = 0;
      else if (grew === 'R') refs.scrollEl.scrollLeft = refs.scrollEl.scrollWidth;
    }
    refs.endL.textContent = vm.chain.length ? String(vm.leftEnd) : '–';
    refs.endR.textContent = vm.chain.length ? String(vm.rightEnd) : '–';
    refs.endL.classList.toggle('pick', !!vm.pickBoth);
    refs.endR.classList.toggle('pick', !!vm.pickBoth);
    refs.endL.disabled = !vm.pickBoth;
    refs.endR.disabled = !vm.pickBoth;
  }

  function syncHand(refs, vm, h) {
    var key = vm.hand.join(',');
    if (refs.handKey !== key) {
      refs.handKey = key; refs.handEl.innerHTML = ''; refs.handNodes = {};
      if (!vm.hand.length) {
        refs.handEl.appendChild(el('div', { class: 'dmo-empty dmo-hand-empty' }, ['Keine Steine mehr 🎉']));
      }
      vm.hand.forEach(function (t) {
        var node = tileEl(t, 'v', 'dmo-ht');
        node.addEventListener('click', function () { h.onTile(t); });
        refs.handNodes[t] = node;
        refs.handEl.appendChild(node);
      });
    }
    vm.hand.forEach(function (t) {
      var n = refs.handNodes[t]; if (!n) return;
      var p = vm.playable[t];
      n.classList.toggle('ok', !!p && vm.myTurn && !vm.roundOver);
      n.classList.toggle('no', (!p || !vm.myTurn) && !vm.roundOver);
      n.classList.toggle('sel', vm.selected === t);
    });
  }

  function updateView(refs, vm, h) {
    refs.roundEl.textContent = 'Runde ' + vm.round + ' / ' + ROUNDS;
    refs.statusEl.textContent = vm.status.text;
    refs.statusEl.className = 'dmo-status ' + vm.status.cls;
    syncOpps(refs, vm);
    syncChain(refs, vm);
    syncHand(refs, vm, h);

    refs.sideRow.classList.toggle('show', !!vm.pickBoth);
    refs.boneEl.textContent = String(vm.boneyard);
    refs.drawBtn.disabled = !vm.canDraw;
    refs.drawBtn.classList.toggle('is-hot', !!vm.canDraw);
    refs.passBtn.disabled = !vm.canPass;
    refs.passBtn.classList.toggle('is-hot', !!vm.canPass);
    refs.myNameEl.textContent = vm.myName;
    refs.myScoreEl.textContent = '★ ' + vm.myScore;
    refs.myPipsEl.textContent = vm.hand.length ? (handPips(vm.hand) + ' Augen') : '';
  }

  /* Baut das view-model aus einem Zustand — fuer Solo und Multi identisch.
     pips: Map id->Restaugen (nur wenn die Runde vorbei ist, sonst {}). */
  function viewModel(st, meId, hand, names, alive, selected, pips) {
    var chain = st.chain || [];
    var playable = {}, pickBoth = false;
    hand.forEach(function (t) {
      if (!chain.length) { playable[t] = { L: false, R: true, both: false }; return; }
      var L = fitsLeft(t, chain), R = fitsRight(t, chain);
      if (!L && !R) return;
      playable[t] = { L: L, R: R, both: L && R && leftEnd(chain) !== rightEnd(chain) };
    });
    if (selected && playable[selected] && playable[selected].both) pickBoth = true;

    var myTurn = st.turn === meId && !st.roundOver;
    var mine = hasPlayable(hand, chain);
    var bone = boneyardLeft(st);

    var opponents = (st.order || []).filter(function (id) { return id !== meId; }).map(function (id) {
      return {
        id: id, name: names[id] || 'Spieler',
        count: (st.counts && st.counts[id]) || 0,
        score: (st.scores && st.scores[id]) || 0,
        pips: pips ? pips[id] : undefined,
        active: st.turn === id && !st.roundOver,
        gone: !!(alive && !alive(id)),
        isWinner: st.winner === id
      };
    });

    var status;
    if (st.roundOver) {
      if (!st.resultReady) {
        status = st.blocked
          ? { text: '🚧 Blockiert — die Restaugen werden gezählt …', cls: 'pen' }
          : { text: '🏁 Runde vorbei — wird abgerechnet …', cls: 'opp' };
      } else if (st.winner === meId) {
        status = { text: '🏆 Du gewinnst die Runde! +' + (st.lastAdd || 0), cls: 'win' };
      } else {
        status = { text: (names[st.winner] || 'Jemand') + ' gewinnt die Runde (+' + (st.lastAdd || 0) + ')', cls: 'lose' };
      }
    } else if (myTurn) {
      if (mine) status = { text: selected ? 'Wähle ein Ende' : 'Du bist dran — leg einen Stein an', cls: 'you' };
      else if (bone > 0) status = { text: 'Nichts passt — zieh einen Stein', cls: 'pen' };
      else status = { text: 'Nichts passt und der Talon ist leer — du musst passen', cls: 'pen' };
    } else {
      status = { text: (names[st.turn] || 'Gegner') + ' ist dran …', cls: 'opp' };
    }

    return {
      round: st.round || 1, opponents: opponents, status: status,
      chain: chain, leftEnd: leftEnd(chain), rightEnd: rightEnd(chain),
      hand: hand, playable: playable, selected: selected, pickBoth: pickBoth,
      myTurn: myTurn, roundOver: !!st.roundOver, boneyard: bone,
      canDraw: myTurn && !mine && bone > 0,
      canPass: myTurn && !mine && bone === 0,
      myName: (names[meId] || 'Du'), myScore: (st.scores && st.scores[meId]) || 0
    };
  }

  /* ===================== Registrierung ===================== */
  App.Minigames.domino = {
    id: 'domino', title: 'Domino', icon: '🁫', order: 167,
    subtitle: 'Leg an, geh raus — der Klassiker im Dschungel',
    single: true, multi: true, minPlayers: 2, maxPlayers: 4,

    render: function (root, ctx) {
      var dead = false, stops = [], pending = [];
      function after(ms, fn) { var t = setTimeout(function () { if (!dead) fn(); }, ms); pending.push(t); return t; }
      function clearTimers() { pending.forEach(clearTimeout); pending = []; }
      function cleanup() {
        dead = true; clearTimers();
        stops.forEach(function (f) { try { f(); } catch (e) {} });
        stops = [];
      }

      if (ctx.mode === 'multi' && ctx.room) runMulti(); else soloMenu();
      return { cleanup: cleanup };

      /* =========================================================
       *  SOLO — gegen 1-3 Bots, kein Netz
       * ========================================================= */
      function soloMenu() {
        var bots = App.Storage.get('dmo_bots', 2);
        var lvl = App.Storage.get('dmo_lvl', 1);
        if ([1, 2, 3].indexOf(bots) < 0) bots = 2;
        if ([0, 1, 2].indexOf(lvl) < 0) lvl = 1;

        var botRow = el('div', { class: 'dmo-pick' });
        var lvlRow = el('div', { class: 'dmo-pick' });
        function paintPicks() {
          botRow.innerHTML = ''; lvlRow.innerHTML = '';
          [1, 2, 3].forEach(function (n) {
            botRow.appendChild(el('button', {
              class: 'chip dmo-chip' + (bots === n ? ' on' : ''), type: 'button',
              onclick: function () { bots = n; sfx('click'); paintPicks(); }
            }, [n + (n === 1 ? ' Bot' : ' Bots')]));
          });
          LEVELS.forEach(function (name, i) {
            lvlRow.appendChild(el('button', {
              class: 'chip dmo-chip' + (lvl === i ? ' on' : ''), type: 'button',
              onclick: function () { lvl = i; sfx('click'); paintPicks(); }
            }, [name]));
          });
        }
        paintPicks();

        root.innerHTML = '';
        root.appendChild(el('div', { class: 'dmo-panel glass' }, [
          el('div', { class: 'dmo-panel-icon' }, [icoTile('dmo-ico-big')]),
          el('h2', { class: 'neon' }, ['Domino']),
          el('p', { class: 'hint-text' }, [
            'Doppel-Sechs · ' + ROUNDS + ' Runden · wer zuerst alle Steine los ist, ' +
            'kassiert die Restaugen der anderen.'
          ]),
          el('div', { class: 'mg-field-title' }, ['Gegner']), botRow,
          el('div', { class: 'mg-field-title' }, ['Schwierigkeit']), lvlRow,
          el('div', { class: 'controls-row' }, [
            el('button', {
              class: 'btn btn-primary btn-lg', type: 'button',
              onclick: function () {
                App.Storage.set('dmo_bots', bots); App.Storage.set('dmo_lvl', lvl);
                sfx('start'); runSolo(bots, lvl);
              }
            }, ['Los geht\'s']),
            el('button', { class: 'btn btn-ghost', type: 'button', onclick: ctx.onExit }, ['Zurück'])
          ])
        ]));
      }

      function runSolo(botCount, level) {
        var order = ['me'], names = { me: (ctx.me && ctx.me.name) || 'Du' }, i;
        for (i = 0; i < botCount; i++) { order.push('b' + i); names['b' + i] = BOT_NAMES[i]; }
        function nameOf(id) { return names[id] || 'Spieler'; }

        var st = null, hands = {}, refs = null, scores = {}, selected = null;
        var mem = {}, lastPips = null, round = 1;
        order.forEach(function (id) { scores[id] = 0; mem[id] = {}; });

        newRound(1);

        function newRound(r) {
          clearTimers();
          round = r; selected = null; lastPips = null;
          st = dealPatch(order, r, scores, Math.floor(Math.random() * 1e9), nameOf);
          hands = {};
          order.forEach(function (id, k) { hands[id] = handFromDeal(st, k); });
          if (!refs) {
            refs = buildLayout({ onTile: onTile, onSide: onSide, onDraw: onDraw, onPass: onPass });
            root.innerHTML = ''; root.appendChild(refs.root);
          }
          refs.chainKey = null; refs.chainArr = [];
          sfx('deal');
          paint();
          scheduleTurn();
        }
        function merge(patch) { Object.keys(patch).forEach(function (k) { st[k] = patch[k]; }); }

        /* --- Was die Bots sich merken (gilt auch fuer den Menschen!) ---
         * Wer zieht oder passt, kann die aktuellen Enden nicht bedienen — das ist
         * der klassische Domino-Tell. Legt jemand spaeter einen Stein mit dieser
         * Augenzahl, ist die Notiz veraltet und fliegt wieder raus. */
        function noteLack(pid) {
          if (!st.chain.length) return;
          mem[pid][leftEnd(st.chain)] = true;
          mem[pid][rightEnd(st.chain)] = true;
        }
        function noteHas(pid, tile) {
          delete mem[pid][aOf(tile)];
          delete mem[pid][bOf(tile)];
        }
        function paint() {
          updateView(refs, viewModel(st, 'me', hands.me, names, null, selected, lastPips),
            { onTile: onTile });
        }
        function scheduleTurn() {
          if (dead || st.roundOver || !st.turn || st.turn === 'me') return;
          var who = st.turn;
          after(680 + Math.random() * 460, function () { botAct(who); });
        }

        /* ---- Zuege ---- */
        function doPlay(pid, tile, side) {
          var h = hands[pid], k = h.indexOf(tile);
          if (k >= 0) h.splice(k, 1);
          noteHas(pid, tile);
          selected = null;
          merge(playPatch(st, pid, tile, side, nameOf, null));
          sfx('deal');
          paint();
          if (st.roundOver) { sfx(st.winner === 'me' ? 'win' : 'lose'); after(1100, finishRound); return; }
          scheduleTurn();
        }
        function doPass(pid) {
          noteLack(pid);
          merge(passPatch(st, pid, nameOf, null));
          sfx('click');
          paint();
          if (st.roundOver) { after(1100, finishRound); return; }
          scheduleTurn();
        }
        function botAct(pid) {
          if (dead || !st || st.roundOver || st.turn !== pid) return;
          var choice = botChoose(hands[pid], st, pid, level, mem, null);
          if (choice) { doPlay(pid, choice.tile, choice.side); return; }
          if (boneyardLeft(st) > 0) {
            var d = drawPatch(st, pid, nameOf);
            if (d) {
              noteLack(pid);                       // zieht = kann die Enden nicht bedienen
              hands[pid] = sortHand(hands[pid].concat([d.tile]));
              merge(d.patch); sfx('pop'); paint();
              after(480, function () { botAct(pid); });
              return;
            }
          }
          doPass(pid);
        }

        /* ---- Eingaben ---- */
        function onTile(t) {
          if (dead || st.roundOver) return;
          if (st.turn !== 'me') { UI.toast('Warte — du bist nicht dran', 'info'); sfx('error'); return; }
          if (hands.me.indexOf(t) < 0) return;
          var chain = st.chain;
          if (chain.length && !canPlay(t, chain)) {
            UI.toast('Passt nicht an ' + leftEnd(chain) + ' oder ' + rightEnd(chain), 'info');
            sfx('error'); return;
          }
          if (!chain.length) { doPlay('me', t, 'R'); return; }
          var L = fitsLeft(t, chain), R = fitsRight(t, chain);
          if (L && R && leftEnd(chain) !== rightEnd(chain)) {
            selected = (selected === t) ? null : t; sfx('select'); paint(); return;
          }
          doPlay('me', t, L ? 'L' : 'R');
        }
        function onSide(side) {
          if (dead || !selected) return;
          if (!side) { selected = null; sfx('click'); paint(); return; }
          var t = selected;
          if (!fitsLeft(t, st.chain) && side === 'L') return;
          if (!fitsRight(t, st.chain) && side === 'R') return;
          doPlay('me', t, side);
        }
        function onDraw() {
          if (dead || st.roundOver || st.turn !== 'me') return;
          if (hasPlayable(hands.me, st.chain)) { UI.toast('Du hast einen passenden Stein!', 'info'); sfx('error'); return; }
          var d = drawPatch(st, 'me', nameOf);
          if (!d) return;
          noteLack('me');                          // auch der Mensch verraet sich beim Ziehen
          hands.me = sortHand(hands.me.concat([d.tile]));
          merge(d.patch); sfx('pop'); paint();
          if (canPlay(d.tile, st.chain)) UI.toast('Passt! ' + tileLabel(d.tile) + ' kannst du legen', 'success');
        }
        function onPass() {
          if (dead || st.roundOver || st.turn !== 'me') return;
          if (hasPlayable(hands.me, st.chain)) { UI.toast('Du hast einen passenden Stein!', 'info'); sfx('error'); return; }
          if (boneyardLeft(st) > 0) { UI.toast('Zieh erst den Talon leer', 'info'); sfx('error'); return; }
          doPass('me');
        }

        /* ---- Rundenende ---- */
        function finishRound() {
          if (dead) return;
          var pips = {};
          order.forEach(function (id) { pips[id] = handPips(hands[id]); });
          var res = settle(st, pips);
          scores = res.scores;
          st.winner = res.winner; st.scores = scores; st.resultReady = true; st.lastAdd = res.add;
          lastPips = pips;
          paint();
          sfx(res.winner === 'me' ? 'jackpot' : 'lose');
          after(3200, function () {
            if (round >= ROUNDS) soloEnd(); else newRound(round + 1);
          });
        }
        function soloEnd() {
          var my = scores.me || 0;
          var best = App.Storage.get('best_domino', 0);
          var nb = my > best;
          if (nb) App.Storage.set('best_domino', my);
          var rank = 1;
          order.forEach(function (id) { if (id !== 'me' && (scores[id] || 0) > my) rank++; });
          if (rank === 1 && App.Scores) App.Scores.winCurrent();
          var lines = order.slice().sort(function (a, b) { return (scores[b] || 0) - (scores[a] || 0); })
            .map(function (id, i) { return (i + 1) + '. ' + nameOf(id) + ' — ' + (scores[id] || 0) + ' P'; })
            .join('   ·   ');
          App.MG.endScreen(root, {
            score: my, best: best, newBest: nb,
            title: rank === 1 ? '🏆 Du gewinnst die Partie!' : '🏁 Partie vorbei — Platz ' + rank,
            label: lines + (nb ? '  ·  Neuer Rekord! 🎉' : '  ·  Bestwert: ' + App.MG.fmt(best)),
            onExit: ctx.onExit,
            onAgain: function () { clearTimers(); soloMenu(); }
          });
        }
      }

      /* =========================================================
       *  MULTI — Zustand in room.shared, Hand bleibt lokal
       * ========================================================= */
      function runMulti() {
        var room = ctx.room, me = ctx.me;
        var sh = (room.snapshot() && room.snapshot().shared) || null;
        var refs = null, view = '', myHand = [], myDeal = -1, selected = null;
        var initDone = false, advRound = -1, lastRep = -1, endShown = false;
        var overSince = 0, pipSent = -1;

        function onShared(s) { if (dead) return; sh = s; sync(); }
        function onPlayers() { if (dead) return; sync(); }
        room.on('shared', onShared);
        room.on('players', onPlayers);
        stops.push(function () { room.off('shared', onShared); room.off('players', onPlayers); });
        var wd = setInterval(function () { if (!dead) { watchdog(); maybeAdvance(); } }, 1200);
        stops.push(function () { clearInterval(wd); });
        sync();

        function names() {
          var m = {};
          room.players().forEach(function (p) { m[p.id] = p.name; });
          return m;
        }
        function nameOf(id) { return names()[id] || 'Spieler'; }
        function aliveFn() {
          var ids = {}, n = 0;
          room.players().forEach(function (p) { ids[p.id] = 1; n++; });
          if (n < 2) return null;                    // alleine uebrig: niemanden ueberspringen
          return function (id) { return !!ids[id]; };
        }
        function myIdx() { return sh && sh.order ? sh.order.indexOf(me.id) : -1; }
        function write(patch) {
          Object.keys(patch).forEach(function (k) { sh[k] = patch[k]; });   // optimistisch: sofort sichtbar
          room.setShared(patch);
          sync();
        }
        function pipsMap() {
          if (!sh || !sh.order || !sh.roundOver) return null;
          var m = {};
          sh.order.forEach(function (id) {
            var v = sh[pipKey(id)];
            if (typeof v === 'number') m[id] = v;
          });
          return m;
        }

        function sync() {
          if (dead) return;
          var players = room.players();
          if (!sh || !sh.order || !sh.deck) {
            if (room.isHost() && !initDone && players.length >= 2) {
              initDone = true;
              var order = players.map(function (p) { return p.id; }).slice(0, 4);
              var scores = {};
              order.forEach(function (id) { scores[id] = 0; });
              room.setShared(dealPatch(order, 1, scores, Math.floor(Math.random() * 1e9), nameOf));
            }
            showWait(players.length);
            return;
          }
          if (sh.seriesOver) { showEnd(); return; }

          var idx = myIdx();
          if (idx >= 0 && sh.round !== myDeal) {     // neue Runde -> eigene Hand ableiten
            myDeal = sh.round; myHand = handFromDeal(sh, idx);
            selected = null; overSince = 0; pipSent = -1;
            if (refs) { refs.chainKey = null; refs.chainArr = []; }
            sfx('deal');
          }
          ensureGame();
          updateView(refs, viewModel(sh, me.id, myHand, names(), aliveFn(), selected, pipsMap()),
            { onTile: onTile });
          reportScore();
          reportPips();
          maybeAdvance();
        }

        function reportScore() {
          var s = (sh.scores && sh.scores[me.id]) || 0;
          if (s !== lastRep) { lastRep = s; room.reportScore(s); }
        }
        /* Restaugen erst am Rundenende melden — und nur den EIGENEN Schluessel
           schreiben, damit sich gleichzeitige Meldungen nicht ueberschreiben. */
        function reportPips() {
          if (!sh.roundOver || sh.resultReady || myIdx() < 0) return;
          if (pipSent === sh.round) return;
          pipSent = sh.round;
          var patch = {};
          patch[pipKey(me.id)] = handPips(myHand);
          write(patch);
        }
        function ensureGame() {
          if (view === 'game') return;
          view = 'game';
          refs = buildLayout({ onTile: onTile, onSide: onSide, onDraw: onDraw, onPass: onPass });
          root.innerHTML = ''; root.appendChild(refs.root);
        }

        /* ---- Eingaben (es schreibt immer nur, wer am Zug ist) ---- */
        function onTile(t) {
          if (dead || !sh || sh.roundOver) return;
          if (sh.turn !== me.id) { UI.toast('Warte — du bist nicht dran', 'info'); sfx('error'); return; }
          if (myHand.indexOf(t) < 0) return;
          var chain = sh.chain || [];
          if (chain.length && !canPlay(t, chain)) {
            UI.toast('Passt nicht an ' + leftEnd(chain) + ' oder ' + rightEnd(chain), 'info');
            sfx('error'); return;
          }
          if (!chain.length) { play(t, 'R'); return; }
          var L = fitsLeft(t, chain), R = fitsRight(t, chain);
          if (L && R && leftEnd(chain) !== rightEnd(chain)) {
            selected = (selected === t) ? null : t; sfx('select'); sync(); return;
          }
          play(t, L ? 'L' : 'R');
        }
        function onSide(side) {
          if (dead || !selected || !sh) return;
          if (!side) { selected = null; sfx('click'); sync(); return; }
          var t = selected;
          if (side === 'L' && !fitsLeft(t, sh.chain)) return;
          if (side === 'R' && !fitsRight(t, sh.chain)) return;
          play(t, side);
        }
        function play(t, side) {
          var k = myHand.indexOf(t);
          if (k >= 0) myHand.splice(k, 1);
          selected = null;
          var patch = playPatch(sh, me.id, t, side, nameOf, aliveFn());
          sfx('deal');
          write(patch);
          if (patch.roundOver) sfx('win');
        }
        function onDraw() {
          if (dead || !sh || sh.roundOver || sh.turn !== me.id) return;
          if (hasPlayable(myHand, sh.chain)) { UI.toast('Du hast einen passenden Stein!', 'info'); sfx('error'); return; }
          var d = drawPatch(sh, me.id, nameOf);
          if (!d) return;
          myHand = sortHand(myHand.concat([d.tile]));
          sfx('pop');
          write(d.patch);
          if (canPlay(d.tile, sh.chain)) UI.toast('Passt! ' + tileLabel(d.tile) + ' kannst du legen', 'success');
        }
        function onPass() {
          if (dead || !sh || sh.roundOver || sh.turn !== me.id) return;
          if (hasPlayable(myHand, sh.chain)) { UI.toast('Du hast einen passenden Stein!', 'info'); sfx('error'); return; }
          if (boneyardLeft(sh) > 0) { UI.toast('Zieh erst den Talon leer', 'info'); sfx('error'); return; }
          sfx('click');
          write(passPatch(sh, me.id, nameOf, aliveFn()));
        }

        /* ---- Host: abrechnen, naechste Runde, Serienende ---- */
        function maybeAdvance() {
          if (dead || !room.isHost() || !sh || !sh.order || sh.seriesOver || !sh.roundOver) return;
          if (!sh.resultReady) {
            if (!overSince) overSince = Date.now();
            var pips = pipsMap() || {}, al = aliveFn(), ready = true;
            sh.order.forEach(function (id) {
              if (al && !al(id)) return;                       // Weggelaufene warten wir nicht ab
              if (typeof pips[id] !== 'number') ready = false;
            });
            if (!ready && (Date.now() - overSince) < PIP_TIMEOUT) return;
            var res = settle(sh, pips);
            room.setShared({
              resultReady: true, winner: res.winner, scores: res.scores, lastAdd: res.add,
              log: (sh.blocked ? '🚧 Blockiert! ' : '🏆 ') + nameOf(res.winner) +
                ' gewinnt die Runde (+' + res.add + ')'
            });
            return;
          }
          if (advRound === sh.round) return;
          advRound = sh.round;
          var r = sh.round;
          after(3400, function () {
            if (dead || !sh || sh.seriesOver || sh.round !== r || !sh.roundOver) return;
            if (r >= ROUNDS) { room.setShared({ seriesOver: true, log: '🏁 Partie vorbei!' }); return; }
            var order = sh.order.filter(function (id) { var al = aliveFn(); return !al || al(id); });
            if (order.length < 2) order = sh.order;
            room.setShared(dealPatch(order, r + 1, sh.scores || {}, Math.floor(Math.random() * 1e9), nameOf));
          });
        }
        /* Host-Watchdog: haengt der Zug bei jemandem, der weg ist, geht es hier weiter. */
        function watchdog() {
          if (!sh || !sh.order || !room.isHost() || sh.roundOver || sh.seriesOver) return;
          var al = aliveFn();
          if (sh.turn && al && !al(sh.turn)) {
            room.setShared({
              passes: 0, turn: nextOf(sh, sh.turn, al),
              log: nameOf(sh.turn) + ' ist weg — der Nächste ist dran'
            });
          }
        }

        function showWait(n) {
          if (view === 'wait') { root.querySelector('.dmo-wait-n').textContent = n + ' / 2'; return; }
          view = 'wait';
          root.innerHTML = '';
          root.appendChild(el('div', { class: 'dmo-panel glass' }, [
            el('div', { class: 'dmo-panel-icon dmo-spin' }, [icoTile('dmo-ico-big')]),
            el('h2', { class: 'neon' }, ['Domino']),
            el('div', { class: 'big-readout dmo-wait-n' }, [n + ' / 2']),
            el('p', { class: 'hint-text' }, ['Warte auf Mitspieler — der Host mischt gleich …']),
            el('div', { class: 'controls-row' }, [
              el('button', { class: 'btn btn-ghost', type: 'button', onclick: ctx.onExit }, ['Zurück zur Lobby'])
            ])
          ]));
        }
        function showEnd() {
          if (endShown) return;
          endShown = true; view = 'end';
          clearTimers();
          var ps = room.players();
          var top = ps.slice().sort(function (a, b) { return (b.score || 0) - (a.score || 0); })[0];
          if (top && top.id === me.id && App.Scores) App.Scores.winCurrent();
          App.MG.endScreen(root, { players: ps, meId: me.id, onExit: ctx.onExit });
        }
      }
    }
  };

  /* ===================== CSS ===================== */
  function injectStyle() {
    UI.injectStyle('mg-domino-css', [
      '.dmo-wrap{display:flex;flex-direction:column;gap:9px;max-width:560px;margin:0 auto;}',
      '.dmo-top{display:flex;justify-content:space-between;align-items:center;gap:10px;}',
      '.dmo-brand{font-weight:900;font-size:18px;display:flex;align-items:center;gap:7px;}',
      /* Deko-Steine (statt der auf iOS fehlenden Unicode-Domino-Zeichen) */
      '.dmo-ico{--u:13px;box-shadow:0 1px 3px rgba(0,0,0,.5),inset 0 1px 0 rgba(255,255,255,.6);transform:rotate(-6deg);}',
      '.dmo-ico-big{--u:34px;transform:rotate(-8deg);box-shadow:0 4px 14px rgba(0,0,0,.55),0 0 22px rgba(57,255,20,.35),inset 0 1px 0 rgba(255,255,255,.7);}',
      '.dmo-round{font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;font-weight:800;}',

      /* ---- Gegner ---- */
      '.dmo-opps{display:flex;gap:8px;flex-wrap:wrap;}',
      '.dmo-opp{flex:1;min-width:118px;display:flex;align-items:center;gap:8px;padding:7px 10px;border-radius:12px;background:rgba(9,32,21,.6);border:1px solid var(--stroke);transition:border-color .18s,box-shadow .18s,opacity .18s;}',
      '.dmo-opp-ico{flex:0 0 auto;opacity:.9;}',
      '.dmo-opp-info{flex:1;min-width:0;display:flex;flex-direction:column;line-height:1.2;}',
      '.dmo-opp-nm{font-weight:800;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      '.dmo-opp-sub{display:flex;gap:8px;font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;}',
      '.dmo-opp-sc{color:var(--gold);font-weight:800;}',
      '.dmo-opp.active{border-color:var(--neon);box-shadow:0 0 0 1px var(--neon),0 0 16px rgba(57,255,20,.3);}',
      '.dmo-opp.active .dmo-opp-ico{animation:dmo-bob .9s ease-in-out infinite;}',
      '.dmo-opp.danger .dmo-opp-cnt{color:var(--danger);font-weight:900;}',
      '.dmo-opp.win{border-color:var(--gold);box-shadow:0 0 18px rgba(255,210,63,.45);}',
      '.dmo-opp.gone{opacity:.42;filter:grayscale(.7);}',
      '@keyframes dmo-bob{0%,100%{transform:rotate(-6deg) translateY(0)}50%{transform:rotate(-6deg) translateY(-4px)}}',

      /* ---- Status ---- */
      '.dmo-status{text-align:center;font-weight:900;font-size:clamp(14px,4vw,18px);min-height:24px;}',
      '.dmo-status.you{color:var(--neon);text-shadow:0 0 10px rgba(57,255,20,.4);}',
      '.dmo-status.opp{color:var(--aqua);}',
      '.dmo-status.pen{color:var(--gold);}',
      '.dmo-status.win{color:var(--gold);text-shadow:0 0 12px rgba(255,210,63,.5);}',
      '.dmo-status.lose{color:var(--danger);}',

      /* ---- Tisch / Kette ---- */
      '.dmo-table{display:flex;align-items:center;gap:6px;padding:8px;border-radius:16px;background:radial-gradient(120% 140% at 50% 0%,rgba(11,46,29,.9),rgba(4,16,10,.92));border:1px solid var(--stroke);box-shadow:inset 0 0 30px rgba(0,0,0,.5);}',
      '.dmo-scroll{flex:1;min-width:0;overflow-x:auto;overflow-y:hidden;scroll-behavior:smooth;-webkit-overflow-scrolling:touch;padding:4px 2px;}',
      '.dmo-scroll::-webkit-scrollbar{height:5px;}',
      '.dmo-scroll::-webkit-scrollbar-thumb{background:var(--stroke-2);border-radius:3px;}',
      '.dmo-chain{display:flex;align-items:center;gap:3px;min-height:64px;width:max-content;margin:0 auto;padding:0 4px;}',
      '.dmo-empty{color:var(--muted);font-size:12px;font-style:italic;white-space:nowrap;padding:0 8px;}',
      '.dmo-end{flex:0 0 auto;width:34px;height:52px;border-radius:11px;display:flex;align-items:center;justify-content:center;font-size:20px;font-weight:900;color:var(--muted);background:rgba(4,16,10,.7);border:1px dashed var(--stroke);cursor:default;padding:0;transition:.18s;}',
      '.dmo-end.pick{color:#04160a;background:linear-gradient(180deg,var(--aqua),var(--aqua-soft));border:1px solid var(--aqua);cursor:pointer;animation:dmo-pick 1s ease-in-out infinite;}',
      '@keyframes dmo-pick{0%,100%{box-shadow:0 0 8px rgba(0,229,255,.5);}50%{box-shadow:0 0 22px rgba(0,229,255,.95);}}',

      /* ---- Steine ---- */
      '.dmo-tile{--u:30px;display:flex;background:linear-gradient(160deg,#f4fff7,#c9dfd0);border-radius:6px;border:1px solid rgba(0,0,0,.35);box-shadow:0 2px 5px rgba(0,0,0,.5),inset 0 1px 0 rgba(255,255,255,.7);flex:0 0 auto;overflow:hidden;}',
      '.dmo-tile-h{flex-direction:row;width:calc(var(--u)*2);height:var(--u);}',
      '.dmo-tile-v{flex-direction:column;width:var(--u);height:calc(var(--u)*2);}',
      '.dmo-face{flex:1;display:grid;grid-template-columns:repeat(3,1fr);grid-template-rows:repeat(3,1fr);gap:8%;padding:11%;}',
      '.dmo-bar{flex:0 0 2px;background:rgba(6,26,15,.55);}',
      '.dmo-dot{border-radius:50%;}',
      '.dmo-dot.on{background:radial-gradient(circle at 34% 32%,#0d3a1f,#04160a);box-shadow:inset 0 0 2px rgba(255,255,255,.25);}',
      '.dmo-ct{--u:30px;}',
      '.dmo-ct.is-new{animation:dmo-drop .34s cubic-bezier(.2,1.5,.4,1) both;}',
      '@keyframes dmo-drop{0%{transform:translateY(-16px) scale(.75) rotate(-7deg);opacity:0;}70%{transform:translateY(2px) scale(1.06) rotate(1deg);opacity:1;}100%{transform:none;opacity:1;}}',

      /* ---- Seitenwahl ---- */
      '.dmo-side-row{display:none;align-items:center;justify-content:center;gap:8px;flex-wrap:wrap;padding:7px 10px;border-radius:12px;background:rgba(0,229,255,.09);border:1px solid var(--aqua);animation:dmo-slide .2s ease both;}',
      '.dmo-side-row.show{display:flex;}',
      '.dmo-side-q{font-size:12px;font-weight:800;color:var(--aqua);text-transform:uppercase;letter-spacing:1px;}',
      '.dmo-side-b{padding:6px 12px;font-size:13px;}',
      '@keyframes dmo-slide{from{opacity:0;transform:translateY(-6px);}to{opacity:1;transform:none;}}',

      /* ---- Aktionen ---- */
      '.dmo-actions{display:flex;align-items:center;justify-content:center;gap:9px;flex-wrap:wrap;}',
      '.dmo-bone{display:flex;align-items:center;gap:6px;padding:6px 11px;border-radius:11px;background:rgba(9,32,21,.6);border:1px solid var(--stroke);}',
      '.dmo-bone-l{font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;font-weight:800;}',
      '.dmo-bone-n{font-size:16px;font-weight:900;color:var(--leaf);}',
      '.dmo-act{padding:7px 15px;font-size:13px;}',
      '.dmo-act:disabled{opacity:.35;cursor:not-allowed;filter:grayscale(.6);}',
      '.dmo-act.is-hot{animation:dmo-hot 1.1s ease-in-out infinite;}',
      '@keyframes dmo-hot{0%,100%{box-shadow:0 0 6px var(--stroke-2);}50%{box-shadow:0 0 20px var(--neon);}}',

      /* ---- eigene Hand ---- */
      '.dmo-hand-wrap{display:flex;flex-direction:column;gap:5px;padding:8px;border-radius:14px;background:rgba(9,32,21,.5);border:1px solid var(--stroke);}',
      '.dmo-my-bar{display:flex;align-items:center;gap:8px;font-size:11px;}',
      '.dmo-my-nm{font-weight:900;color:var(--aqua);}',
      '.dmo-my-pips{flex:1;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;font-weight:700;}',
      '.dmo-my-sc{color:var(--gold);font-weight:900;}',
      '.dmo-hand{display:flex;gap:6px;overflow-x:auto;overflow-y:hidden;padding:4px 2px 6px;min-height:74px;align-items:center;-webkit-overflow-scrolling:touch;}',
      '.dmo-hand::-webkit-scrollbar{height:5px;}',
      '.dmo-hand::-webkit-scrollbar-thumb{background:var(--stroke-2);border-radius:3px;}',
      '.dmo-hand-empty{margin:auto;}',
      '.dmo-ht{--u:32px;touch-action:manipulation;transition:transform .14s,box-shadow .18s,filter .18s;}',
      '.dmo-ht.ok{cursor:pointer;box-shadow:0 0 0 1px var(--neon),0 0 14px rgba(57,255,20,.4),inset 0 1px 0 rgba(255,255,255,.7);}',
      '.dmo-ht.ok:hover{transform:translateY(-5px);box-shadow:0 0 0 1px var(--neon),0 0 22px rgba(57,255,20,.7);}',
      '.dmo-ht.ok:active{transform:translateY(-2px) scale(.96);}',
      '.dmo-ht.no{filter:grayscale(.55) brightness(.7);cursor:default;}',
      '.dmo-ht.sel{transform:translateY(-7px);box-shadow:0 0 0 2px var(--aqua),0 0 24px rgba(0,229,255,.8);}',

      '.dmo-hint{margin:0;text-align:center;font-size:11px;line-height:1.4;}',

      /* ---- Panels (Solo-Menü / Warten) ---- */
      '.dmo-panel{padding:26px 22px;text-align:center;display:flex;flex-direction:column;gap:11px;align-items:center;max-width:460px;margin:0 auto;}',
      '.dmo-panel-icon{line-height:1;display:flex;justify-content:center;}',
      '.dmo-spin{animation:dmo-spin 2.6s linear infinite;}',
      '@keyframes dmo-spin{to{transform:rotate(360deg);}}',
      '.dmo-pick{display:flex;gap:7px;justify-content:center;flex-wrap:wrap;}',
      '.dmo-chip{cursor:pointer;transition:.15s;border:1px solid var(--stroke);}',
      '.dmo-chip.on{border-color:var(--neon);color:var(--neon);box-shadow:0 0 12px rgba(57,255,20,.35);}',

      '@media(max-width:420px){.dmo-tile{--u:26px;}.dmo-ht{--u:29px;}.dmo-hint{font-size:10px;}}'
    ].join(''));
  }
})();
