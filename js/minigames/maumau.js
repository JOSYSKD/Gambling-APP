/* maumau.js — "Mau-Mau": der deutsche Karten-Klassiker im Neon-Dschungel.
 *
 * IDEE      Jeder hat eine Hand, in der Mitte liegt der Ablagestapel. Erlaubt ist
 *           eine Karte mit gleicher FARBE oder gleichem WERT wie die oberste.
 *           Sonderkarten: 7 = nächster zieht 2 (stapelbar!), 8 = nächster setzt aus,
 *           Bube = Farbe wünschen (Bube darf immer). Nichts Passendes -> eine Karte
 *           ziehen (die gezogene darf man sofort legen, sonst passen).
 *           Wer zuerst keine Karten mehr hat, gewinnt die Runde. Bei der VORLETZTEN
 *           Karte muss man "MAU!" sagen — wer es innerhalb von 4 s vergisst, zieht
 *           2 Karten Strafe. Gespielt werden 3 Runden.
 *
 * STEUERUNG Reine Tipp-/Klick-Steuerung (Touch + Maus): Karte in der Hand antippen =
 *           legen, Stapel oder "Karte ziehen" antippen = ziehen, Bube -> Farbwahl-
 *           Overlay, MAU-Knopf antippen.
 *
 * PUNKTE    Pro Runde: Sieger 100 Punkte, alle anderen max(0, 60 - 10 x Restkarten).
 *           Nach 3 Runden entscheidet die Gesamtpunktzahl (Podest / Solo-Bestwert).
 *
 * SOLO      Gegen 1-3 Bots (Leicht / Normal / Schwer) mit echter Strategie:
 *           Sonderkarten gezielt gegen Spieler mit wenigen Karten, Buben werden
 *           aufgehoben, Wunschfarbe nach Mehrheit auf der Hand, und ab und zu
 *           vergisst ein Bot sein "Mau" (je nach Stufe).
 *
 * SYNC      Rundenbasiert über room.shared. Der Host mischt pro Runde ein Deck und
 *           legt es samt Startablage in shared; jeder Client leitet daraus NUR SEINE
 *           EIGENE Hand ab (order-Index) und hält sie danach LOKAL. Geteilt werden
 *           ausschließlich Ablagestapel, Zieh-Zeiger, Kartenzahlen, Wunschfarbe,
 *           7er-Strafe, Zug und Log — die Hände selbst nie. Es schreibt immer nur
 *           der Spieler, der am Zug ist (auch während des MAU-Fensters bleibt der
 *           Zug bei ihm) -> keine Schreib-Kollisionen. Der Host mischt die Runden
 *           weiter und hat einen Watchdog für weggelaufene Spieler.
 */
(function () {
  'use strict';
  window.App = window.App || {}; App.Minigames = App.Minigames || {};
  var UI = App.UI, el = UI.el;

  injectStyle();

  /* ===================== Karten-Grundlagen ===================== */
  var SUITS = ['H', 'D', 'C', 'S'];
  var SUIT_SYM = { H: '♥', D: '♦', C: '♣', S: '♠' };
  var SUIT_NAME = { H: 'Herz', D: 'Karo', C: 'Kreuz', S: 'Pik' };
  var RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
  var RANK_LABEL = { '2': '2', '3': '3', '4': '4', '5': '5', '6': '6', '7': '7', '8': '8', '9': '9', T: '10', J: 'B', Q: 'D', K: 'K', A: 'A' };
  var HAND_SIZE = 5, ROUNDS = 3, MAU_MS = 4000;

  function suitOf(c) { return c.charAt(0); }
  function rankOf(c) { return c.charAt(1); }
  function isRed(c) { return suitOf(c) === 'H' || suitOf(c) === 'D'; }
  function cardLabel(c) { return RANK_LABEL[rankOf(c)] + SUIT_SYM[suitOf(c)]; }

  function buildDeck() {
    var d = [], i, j;
    for (i = 0; i < SUITS.length; i++) for (j = 0; j < RANKS.length; j++) d.push(SUITS[i] + RANKS[j]);
    return d;
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
  function sortHand(h) {
    return h.slice().sort(function (a, b) {
      var sa = SUITS.indexOf(suitOf(a)), sb = SUITS.indexOf(suitOf(b));
      return sa - sb || RANKS.indexOf(rankOf(a)) - RANKS.indexOf(rankOf(b));
    });
  }

  /* ===================== Regel-Logik (Solo + Multi gemeinsam) ===================== */
  function topCard(st) { var d = st.discard || []; return d[d.length - 1] || null; }
  function effSuit(st) { var t = topCard(st); return st.wish || (t ? suitOf(t) : null); }
  function canPlay(card, st) {
    if ((st.pending7 || 0) > 0) return rankOf(card) === '7';   // 7er-Strafe: nur mit 7 kontern
    var t = topCard(st);
    if (!t) return true;
    if (rankOf(card) === 'J') return true;                     // Bube geht immer
    if (suitOf(card) === effSuit(st)) return true;
    return rankOf(card) === rankOf(t);
  }
  function hasPlayable(hand, st) {
    for (var i = 0; i < hand.length; i++) if (canPlay(hand[i], st)) return true;
    return false;
  }
  /* nächster Index im Kreis, überspringt abwesende Spieler */
  function stepIdx(order, from, steps, alive) {
    var i = from, done = 0, guard = 0;
    while (done < steps && guard < 200) {
      i = (i + 1) % order.length; guard++;
      if (!alive || alive(order[i])) done++;
    }
    return i;
  }
  /* Karten vom Stapel nehmen — mischt den Ablagestapel (ohne oberste) neu, wenn leer */
  function takeCards(st, n) {
    var deck = (st.deck || []).slice(), di = st.drawIdx || 0, dis = (st.discard || []).slice();
    var out = [], i;
    for (i = 0; i < n; i++) {
      if (di >= deck.length) {
        if (dis.length <= 1) break;                            // wirklich nichts mehr da
        var top = dis[dis.length - 1];
        deck = shuffle(dis.slice(0, dis.length - 1), Math.random);
        di = 0; dis = [top];
      }
      out.push(deck[di]); di++;
    }
    return { cards: out, deck: deck, drawIdx: di, discard: dis };
  }
  function scoresAfter(st, counts, winnerId) {
    var sc = Object.assign({}, st.scores || {});
    st.order.forEach(function (id) {
      var add = id === winnerId ? 100 : Math.max(0, 60 - 10 * (counts[id] || 0));
      sc[id] = (sc[id] || 0) + add;
    });
    return sc;
  }

  /* Patch für "Karte legen" — identisch für Solo (lokal) und Multi (setShared). */
  function playPatch(st, pid, card, wishSuit, nameOf, alive) {
    var discard = (st.discard || []).slice(); discard.push(card);
    var counts = Object.assign({}, st.counts || {});
    counts[pid] = Math.max(0, (counts[pid] || 0) - 1);
    var r = rankOf(card), idx = st.order.indexOf(pid), steps = 1;
    var patch = { discard: discard, counts: counts, drew: false, wish: null, pending7: st.pending7 || 0 };
    if (r === '7') patch.pending7 = (st.pending7 || 0) + 2;
    if (r === '8') steps = 2;
    if (r === 'J') patch.wish = wishSuit || suitOf(card);
    var nextId = st.order[stepIdx(st.order, idx, steps, alive)];
    var log = nameOf(pid) + ' legt ' + cardLabel(card);
    if (r === '7') log += ' — ' + nameOf(nextId) + ' zieht ' + patch.pending7 + '!';
    else if (r === '8') log += ' — ' + nameOf(st.order[stepIdx(st.order, idx, 1, alive)]) + ' setzt aus!';
    else if (r === 'J') log += ' — Wunsch: ' + SUIT_NAME[patch.wish] + ' ' + SUIT_SYM[patch.wish];
    patch.log = log;
    patch.logSeq = (st.logSeq || 0) + 1;

    if (counts[pid] === 0) {
      patch.roundOver = true; patch.winner = pid; patch.turn = null; patch.mauWait = null;
      patch.scores = scoresAfter(st, counts, pid);
      patch.log = '🏆 ' + nameOf(pid) + ' hat die Runde gewonnen!';
    } else if (counts[pid] === 1) {
      patch.mauWait = pid; patch.nextTurn = nextId;             // Zug bleibt bis "MAU!"
    } else {
      patch.turn = nextId;
    }
    return patch;
  }
  /* Patch für "Karten ziehen". pass=true -> Zug geht danach weiter (7er-Strafe / Mau-Strafe). */
  function drawPatch(st, pid, n, nameOf, alive, pass, logText) {
    var t = takeCards(st, n);
    var counts = Object.assign({}, st.counts || {});
    counts[pid] = (counts[pid] || 0) + t.cards.length;
    var patch = {
      deck: t.deck, drawIdx: t.drawIdx, discard: t.discard, counts: counts,
      log: logText || (nameOf(pid) + ' zieht ' + (t.cards.length === 1 ? 'eine Karte' : t.cards.length + ' Karten')),
      logSeq: (st.logSeq || 0) + 1
    };
    if (pass) {
      patch.pending7 = 0; patch.drew = false;
      patch.turn = st.order[stepIdx(st.order, st.order.indexOf(pid), 1, alive)];
    } else {
      patch.drew = true;
    }
    return { patch: patch, cards: t.cards };
  }
  /* frische Runde: gemischtes Deck + Startablage (nie 7/8/Bube) */
  function dealPatch(order, round, scores, seed) {
    var deck = shuffle(buildDeck(), rng(seed));
    var start = order.length * HAND_SIZE, i, t;
    for (i = start; i < deck.length; i++) {
      var r = rankOf(deck[i]);
      if (r !== '7' && r !== '8' && r !== 'J') { t = deck[i]; deck[i] = deck[start]; deck[start] = t; break; }
    }
    var counts = {};
    order.forEach(function (id) { counts[id] = HAND_SIZE; });
    return {
      order: order, round: round, seed: seed, deck: deck, drawIdx: start + 1,
      discard: [deck[start]], wish: null, pending7: 0, counts: counts,
      scores: scores || {}, turn: order[(round - 1) % order.length], drew: false,
      mauWait: null, nextTurn: null, roundOver: false, winner: null, seriesOver: false,
      log: 'Runde ' + round + ' läuft — viel Glück!', logSeq: 0
    };
  }
  function handFromDeal(st, idx) { return sortHand((st.deck || []).slice(idx * HAND_SIZE, idx * HAND_SIZE + HAND_SIZE)); }

  /* ===================== Bot-Strategie ===================== */
  /* Wählt die beste spielbare Karte. level: 0=leicht, 1=normal, 2=schwer. */
  function botPick(hand, st, pid, level, alive) {
    var playable = hand.filter(function (c) { return canPlay(c, st); });
    if (!playable.length) return null;
    var rand = level === 0 ? 0.35 : level === 1 ? 0.12 : 0;
    if (Math.random() < rand) return playable[Math.floor(Math.random() * playable.length)];

    var idx = st.order.indexOf(pid);
    var nextId = st.order[stepIdx(st.order, idx, 1, alive)];
    var nextCount = (st.counts && st.counts[nextId]) || 5;
    var myCount = hand.length;
    var suitCount = {};
    hand.forEach(function (c) { suitCount[suitOf(c)] = (suitCount[suitOf(c)] || 0) + 1; });

    var best = null, bestVal = -Infinity;
    playable.forEach(function (c) {
      var r = rankOf(c), v = 0;
      if (myCount === 1) v += 500;                                   // letzte Karte: sofort raus
      if (r === 'J') {
        v -= 24;                                                     // Buben aufheben …
        if (myCount <= 2) v += 40;                                   // … außer es geht ums Ganze
        if (level >= 1 && suitCount[effSuit(st)] === undefined) v += 12; // oder wir sind farbblank
      } else if (r === '7') {
        v += nextCount <= 2 ? 30 : nextCount <= 3 ? 18 : 8;          // Druck auf knappe Gegner
        if ((st.pending7 || 0) > 0) v += 25;                         // Strafe weiterreichen!
      } else if (r === '8') {
        v += nextCount <= 2 ? 26 : 10;                               // Gegner ausbremsen
        if (st.order.length === 2) v += 6;                           // zu zweit = Extrazug
      } else {
        v += RANKS.indexOf(r) * 0.4;                                 // hohe Karten zuerst abwerfen
      }
      if (level >= 1) v += (suitCount[suitOf(c)] || 0) * 2.2;        // Farbe halten, in der man stark ist
      if (level >= 2 && nextCount <= 1 && r !== '7' && r !== '8') v -= 6;
      if (v > bestVal) { bestVal = v; best = c; }
    });
    return best;
  }
  /* Wunschfarbe: Mehrheit auf der Hand (ohne Buben), sonst Zufall. */
  function botWish(hand, played, level) {
    var cnt = {}, i, s, bestS = null, bestN = -1;
    for (i = 0; i < hand.length; i++) {
      if (hand[i] === played || rankOf(hand[i]) === 'J') continue;
      s = suitOf(hand[i]); cnt[s] = (cnt[s] || 0) + 1;
    }
    for (i = 0; i < SUITS.length; i++) {
      var n = (cnt[SUITS[i]] || 0) + (level === 0 ? Math.random() : Math.random() * 0.4);
      if (n > bestN) { bestN = n; bestS = SUITS[i]; }
    }
    return bestS || SUITS[Math.floor(Math.random() * 4)];
  }
  function botSaysMau(level) { return Math.random() < (level === 0 ? 0.6 : level === 1 ? 0.86 : 0.97); }

  /* ===================== Ansicht ===================== */
  function faceEl(card, extraCls) {
    return el('div', { class: 'mau-card mau-face ' + (isRed(card) ? 'mau-red' : 'mau-black') + (extraCls ? ' ' + extraCls : '') }, [
      el('span', { class: 'mau-c-r' }, [RANK_LABEL[rankOf(card)]]),
      el('span', { class: 'mau-c-s' }, [SUIT_SYM[suitOf(card)]]),
      el('span', { class: 'mau-c-r2' }, [RANK_LABEL[rankOf(card)]])
    ]);
  }
  function backEl(extraCls) {
    return el('div', { class: 'mau-card mau-back' + (extraCls ? ' ' + extraCls : '') }, [el('span', { class: 'mau-back-in' }, ['🌿'])]);
  }

  /* Baut das Spiel-Layout EINMAL; danach nur noch updateView() in-place. */
  function buildLayout(h) {
    var roundEl = el('div', { class: 'mau-round' }, ['Runde 1 / ' + ROUNDS]);
    var top = el('div', { class: 'mau-top' }, [el('div', { class: 'mau-brand neon' }, ['🃏 Mau-Mau']), roundEl]);
    var oppsEl = el('div', { class: 'mau-opps' });

    var deckCountEl = el('div', { class: 'mau-pile-lbl' }, ['0']);
    var deckEl = el('button', { class: 'mau-pile mau-deckpile', type: 'button', title: 'Karte ziehen', onclick: h.onDraw }, [
      backEl('mau-pile-card'), deckCountEl
    ]);
    var discSlot = el('div', { class: 'mau-disc-slot' });
    var wishBadge = el('div', { class: 'mau-wish-badge' }, ['']);
    var penBadge = el('div', { class: 'mau-pen-badge' }, ['']);
    var discardEl = el('div', { class: 'mau-pile mau-discpile' }, [discSlot, wishBadge, penBadge]);
    var table = el('div', { class: 'mau-table glass' }, [
      el('div', { class: 'mau-pile-wrap' }, [deckEl, el('div', { class: 'mau-pile-cap' }, ['Stapel'])]),
      el('div', { class: 'mau-pile-wrap' }, [discardEl, el('div', { class: 'mau-pile-cap' }, ['Ablage'])])
    ]);

    var statusEl = el('div', { class: 'mau-status you' }, ['']);
    var logEl = el('div', { class: 'mau-log hint-text' }, ['']);
    var drawBtn = el('button', { class: 'btn btn-aqua mau-btn', type: 'button', onclick: h.onDraw }, ['Karte ziehen']);
    var passBtn = el('button', { class: 'btn btn-ghost mau-btn', type: 'button', onclick: h.onPass }, ['Passen ➜']);
    var actionsEl = el('div', { class: 'controls-row mau-actions' }, [drawBtn, passBtn]);

    var handEl = el('div', { class: 'mau-hand' });
    var meNameEl = el('span', { class: 'mau-me-nm' }, ['Du']);
    var meScoreEl = el('span', { class: 'mau-me-sc' }, ['0']);
    var meBar = el('div', { class: 'mau-me-bar' }, [
      el('span', { class: 'mau-me-tag' }, ['🍃 Deine Hand']), meNameEl, el('span', { class: 'mau-me-spacer' }), meScoreEl
    ]);
    var handWrap = el('div', { class: 'mau-hand-wrap' }, [meBar, handEl]);

    var mauBtn = el('button', { class: 'mau-maubtn', type: 'button', onclick: h.onMau }, ['MAU!']);
    var mauOv = el('div', { class: 'mau-ov mau-mau-ov' }, [
      el('div', { class: 'mau-ov-hint' }, ['Nur noch eine Karte …']), mauBtn,
      el('div', { class: 'mau-ov-sub' }, ['Sonst 2 Karten Strafe!'])
    ]);

    var wishBtns = SUITS.map(function (s) {
      return el('button', {
        class: 'mau-wish-btn ' + (s === 'H' || s === 'D' ? 'mau-red' : 'mau-black'), type: 'button',
        onclick: function () { h.onWish(s); }
      }, [el('span', { class: 'mau-wish-sym' }, [SUIT_SYM[s]]), el('span', { class: 'mau-wish-nm' }, [SUIT_NAME[s]])]);
    });
    var wishOv = el('div', { class: 'mau-ov mau-wish-ov' }, [
      el('div', { class: 'mau-ov-hint' }, ['Bube gelegt — welche Farbe wünschst du dir?']),
      el('div', { class: 'mau-wish-grid' }, wishBtns)
    ]);

    var rules = el('p', { class: 'hint-text mau-rules' }, ['Farbe oder Wert legen · 7 = +2 (stapelbar) · 8 = aussetzen · B = Farbe wünschen · vorletzte Karte: MAU!']);

    var wrap = el('div', { class: 'mau-wrap' }, [top, oppsEl, table, statusEl, logEl, actionsEl, handWrap, rules, mauOv, wishOv]);
    return {
      root: wrap, roundEl: roundEl, oppsEl: oppsEl, deckEl: deckEl, deckCountEl: deckCountEl,
      discSlot: discSlot, wishBadge: wishBadge, penBadge: penBadge, statusEl: statusEl, logEl: logEl,
      drawBtn: drawBtn, passBtn: passBtn, handEl: handEl, meNameEl: meNameEl, meScoreEl: meScoreEl,
      mauOv: mauOv, wishOv: wishOv, oppSig: '', handSig: '', topSig: ''
    };
  }

  function updateView(refs, vm, onCard) {
    refs.roundEl.textContent = 'Runde ' + vm.round + ' / ' + ROUNDS;

    /* Gegner-Chips (nur bei echter Änderung neu bauen -> kein Flackern) */
    var oSig = vm.opponents.map(function (o) { return o.name + ':' + o.count + ':' + o.score + ':' + (o.active ? 1 : 0) + (o.gone ? 'x' : '') + (o.mau ? 'm' : ''); }).join('|');
    if (oSig !== refs.oppSig) {
      refs.oppSig = oSig;
      refs.oppsEl.innerHTML = '';
      vm.opponents.forEach(function (o) {
        var cls = 'mau-opp' + (o.active ? ' is-active' : '') + (o.gone ? ' is-gone' : '') + (o.mau ? ' is-mau' : '');
        /* Kartenfächer aus CSS-Mini-Karten (Emoji-Kartenglyphen fehlen auf vielen Geräten) */
        var fan = el('span', { class: 'mau-opp-fan' });
        var show = Math.min(o.count, 8), k;
        for (k = 0; k < show; k++) fan.appendChild(el('i', { class: 'mau-mini' }));
        if (o.count > show) fan.appendChild(el('i', { class: 'mau-mini-more' }, ['+']));
        refs.oppsEl.appendChild(el('div', { class: cls }, [
          el('div', { class: 'mau-opp-head' }, [
            el('span', { class: 'mau-opp-nm' }, [o.name]),
            el('span', { class: 'mau-opp-sc' }, [String(o.score) + ' P'])
          ]),
          el('div', { class: 'mau-opp-cards' }, [fan, el('span', { class: 'mau-opp-n' }, [String(o.count)])])
        ]));
      });
    }

    refs.deckCountEl.textContent = String(vm.deckLeft);
    refs.deckEl.classList.toggle('is-hot', !!vm.draw.show && !vm.draw.disabled);

    var tSig = (vm.top || '-') + '|' + (vm.wish || '-') + '|' + vm.pending7;
    if (tSig !== refs.topSig) {
      refs.topSig = tSig;
      refs.discSlot.innerHTML = '';
      if (vm.top) refs.discSlot.appendChild(faceEl(vm.top, 'mau-pile-card mau-drop'));
      refs.wishBadge.textContent = vm.wish ? SUIT_SYM[vm.wish] : '';
      refs.wishBadge.className = 'mau-wish-badge' + (vm.wish ? ' show ' + (vm.wish === 'H' || vm.wish === 'D' ? 'mau-red' : 'mau-black') : '');
      refs.penBadge.textContent = vm.pending7 > 0 ? '+' + vm.pending7 : '';
      refs.penBadge.className = 'mau-pen-badge' + (vm.pending7 > 0 ? ' show' : '');
    }

    refs.statusEl.textContent = vm.status.text;
    refs.statusEl.className = 'mau-status ' + vm.status.cls;
    refs.logEl.textContent = vm.log || '';

    refs.drawBtn.textContent = vm.draw.label;
    refs.drawBtn.className = 'btn mau-btn ' + (vm.draw.danger ? 'btn-danger' : 'btn-aqua');
    refs.drawBtn.disabled = !!vm.draw.disabled;
    refs.drawBtn.style.display = vm.draw.show ? '' : 'none';
    refs.passBtn.style.display = vm.pass ? '' : 'none';

    refs.meNameEl.textContent = vm.me.name;
    refs.meScoreEl.textContent = vm.me.score + ' P';

    var hSig = vm.hand.join(',') + '|' + (vm.clickable ? 1 : 0) + '|' + vm.hand.map(function (c) { return vm.playable[c] ? 1 : 0; }).join('');
    if (hSig !== refs.handSig) {
      refs.handSig = hSig;
      refs.handEl.innerHTML = '';
      if (!vm.hand.length) refs.handEl.appendChild(el('div', { class: 'mau-hand-empty' }, [vm.spectator ? 'Du schaust zu 👀' : 'Keine Karten mehr — geschafft! 🎉']));
      vm.hand.forEach(function (c, i) {
        var ok = !!vm.playable[c] && vm.clickable;
        var b = el('button', {
          class: 'mau-card mau-face mau-hcard ' + (isRed(c) ? 'mau-red' : 'mau-black') + (ok ? ' is-ok' : (vm.clickable ? ' is-dim' : '')),
          type: 'button', style: 'animation-delay:' + (i * 35) + 'ms',
          onclick: function () { onCard(c); }
        }, [
          el('span', { class: 'mau-c-r' }, [RANK_LABEL[rankOf(c)]]),
          el('span', { class: 'mau-c-s' }, [SUIT_SYM[suitOf(c)]]),
          el('span', { class: 'mau-c-r2' }, [RANK_LABEL[rankOf(c)]])
        ]);
        refs.handEl.appendChild(b);
      });
    }
    refs.mauOv.classList.toggle('show', !!vm.mauForMe);
  }

  /* ===================== Registrierung ===================== */
  App.Minigames.maumau = {
    id: 'maumau', title: 'Mau-Mau', icon: '🃏', order: 163,
    subtitle: '7 zieht, 8 setzt aus, Bube wünscht — MAU!',
    single: true, multi: true, minPlayers: 2, maxPlayers: 6,

    render: function (root, ctx) {
      var dead = false, timers = [], stops = [];
      function after(ms, fn) { var t = setTimeout(function () { if (!dead) fn(); }, ms); timers.push(t); return t; }
      function clearTimers() { timers.forEach(clearTimeout); timers = []; }
      function cleanup() {
        dead = true; clearTimers();
        stops.forEach(function (f) { try { f(); } catch (e) {} });
        stops = [];
      }
      function sfx(n) { if (App.Audio) App.Audio.sfx(n); }

      if (ctx.mode === 'multi' && ctx.room) {
        var snap = ctx.room.snapshot() || {};
        var startAt = (snap.round && snap.round.startAt) || (ctx.room.now() + 3000);
        stops.push(App.MG.countdown(root, startAt, function () { runMulti(); }, ctx.room.now));
      } else {
        soloMenu();
      }
      return { cleanup: cleanup };

      /* =========================================================
       *  SOLO — gegen 1-3 Bots, alles lokal
       * ========================================================= */
      function soloMenu() {
        var bots = App.Storage.get('maumau_bots', 2), level = App.Storage.get('maumau_level', 1);
        var botRow = el('div', { class: 'mau-opt-row' });
        var lvlRow = el('div', { class: 'mau-opt-row' });
        function paintOpts() {
          botRow.innerHTML = ''; lvlRow.innerHTML = '';
          [1, 2, 3].forEach(function (n) {
            botRow.appendChild(el('button', {
              class: 'mau-opt' + (bots === n ? ' is-on' : ''), type: 'button',
              onclick: function () { bots = n; sfx('click'); paintOpts(); }
            }, [n + ' Bot' + (n > 1 ? 's' : '')]));
          });
          ['Leicht', 'Normal', 'Schwer'].forEach(function (nm, i) {
            lvlRow.appendChild(el('button', {
              class: 'mau-opt' + (level === i ? ' is-on' : ''), type: 'button',
              onclick: function () { level = i; sfx('click'); paintOpts(); }
            }, [nm]));
          });
        }
        paintOpts();
        root.innerHTML = '';
        root.appendChild(el('div', { class: 'mau-panel glass' }, [
          el('div', { class: 'mau-panel-icon' }, ['🃏']),
          el('h2', { class: 'neon' }, ['Mau-Mau']),
          el('p', { class: 'hint-text' }, ['3 Runden — Farbe oder Wert legen. 7 = nächster zieht 2 (stapelbar), 8 = aussetzen, Bube = Farbe wünschen. Vorletzte Karte: MAU!']),
          el('div', { class: 'mau-opt-lbl' }, ['Gegner']), botRow,
          el('div', { class: 'mau-opt-lbl' }, ['Schwierigkeit']), lvlRow,
          el('div', { class: 'controls-row' }, [
            el('button', { class: 'btn btn-primary', type: 'button', onclick: function () {
              App.Storage.set('maumau_bots', bots); App.Storage.set('maumau_level', level);
              sfx('start'); startSolo(bots, level);
            } }, ['Los geht\'s']),
            el('button', { class: 'btn btn-ghost', type: 'button', onclick: ctx.onExit }, ['Zurück'])
          ])
        ]));
      }

      function startSolo(botCount, level) {
        var BOT_NAMES = ['🐍 Kobra', '🦜 Tukan', '🐒 Mango'];
        var order = ['me'], names = { me: (ctx.me && ctx.me.name) || 'Du' }, i;
        for (i = 0; i < botCount; i++) { order.push('b' + i); names['b' + i] = BOT_NAMES[i]; }
        function nameOf(id) { return names[id] || 'Spieler'; }

        var st = null, hands = {}, refs = null, scores = {}, wishCard = null, mauTimer = null;
        order.forEach(function (id) { scores[id] = 0; });

        newDeal(1);
        return;

        function newDeal(round) {
          clearTimers();
          st = dealPatch(order, round, scores, Math.floor(Math.random() * 1e9));
          hands = {};
          order.forEach(function (id, k) { hands[id] = handFromDeal(st, k); });
          if (!refs) {
            refs = buildLayout({ onDraw: onDraw, onPass: onPass, onMau: onMau, onWish: onWish });
            root.innerHTML = ''; root.appendChild(refs.root);
          }
          refs.wishOv.classList.remove('show');
          sfx('deal');
          paint();
          botTick();
        }

        function apply(patch) {
          Object.keys(patch).forEach(function (k) { st[k] = patch[k]; });
          if (patch.scores) scores = patch.scores;
        }

        /* ---- Zugende / Runden-Ende ---- */
        function afterPatch() {
          paint();
          if (st.roundOver) {
            sfx(st.winner === 'me' ? 'win' : 'lose');
            after(2600, function () {
              if (st.round >= ROUNDS) showEnd();
              else newDeal(st.round + 1);
            });
            return;
          }
          if (st.mauWait) { mauPhase(st.mauWait); return; }
          botTick();
        }

        /* ---- MAU-Fenster ---- */
        function mauPhase(pid) {
          if (mauTimer) { clearTimeout(mauTimer); mauTimer = null; }
          if (pid === 'me') {
            sfx('info');
            mauTimer = after(MAU_MS, function () { if (st.mauWait === 'me') mauMiss('me'); });
          } else {
            mauTimer = after(750 + Math.random() * 500, function () {
              if (st.mauWait !== pid) return;
              if (botSaysMau(level)) mauSaid(pid); else mauMiss(pid);
            });
          }
        }
        function mauSaid(pid) {
          if (mauTimer) { clearTimeout(mauTimer); mauTimer = null; }
          if (App.Audio) App.Audio.sweep(420, 900, 0.18);
          apply({ mauWait: null, turn: st.nextTurn, nextTurn: null, log: '📢 ' + nameOf(pid) + ' sagt MAU!', logSeq: (st.logSeq || 0) + 1 });
          paint(); botTick();
        }
        function mauMiss(pid) {
          if (mauTimer) { clearTimeout(mauTimer); mauTimer = null; }
          sfx('error');
          var next = st.nextTurn;
          var d = drawPatch(st, pid, 2, nameOf, null, false, '😬 ' + nameOf(pid) + ' hat MAU vergessen — 2 Karten Strafe!');
          hands[pid] = sortHand(hands[pid].concat(d.cards));
          d.patch.drew = false; d.patch.mauWait = null; d.patch.nextTurn = null; d.patch.turn = next;
          apply(d.patch);
          paint(); botTick();
        }

        /* ---- Aktionen des Menschen ---- */
        function onCard(card) {
          if (dead || st.roundOver || st.mauWait || st.turn !== 'me') { sfx('error'); return; }
          if (hands.me.indexOf(card) < 0) return;
          if (!canPlay(card, st)) {
            UI.toast((st.pending7 || 0) > 0 ? 'Nur eine 7 kontert die Strafe' : 'Passt nicht auf ' + cardLabel(topCard(st)), 'info');
            sfx('error'); return;
          }
          if (rankOf(card) === 'J') { wishCard = card; refs.wishOv.classList.add('show'); sfx('select'); return; }
          doPlay('me', card, null);
        }
        function onWish(s) {
          refs.wishOv.classList.remove('show');
          if (!wishCard) return;
          var c = wishCard; wishCard = null;
          doPlay('me', c, s);
        }
        function doPlay(pid, card, wish) {
          var h = hands[pid], k = h.indexOf(card);
          if (k >= 0) h.splice(k, 1);
          sfx('deal');
          apply(playPatch(st, pid, card, wish, nameOf, null));
          afterPatch();
        }
        function onDraw() {
          if (dead || st.roundOver || st.mauWait || st.turn !== 'me') return;
          if ((st.pending7 || 0) > 0) {
            var n = st.pending7;
            var d = drawPatch(st, 'me', n, nameOf, null, true, 'Du ziehst ' + n + ' Karten (7er-Strafe)');
            hands.me = sortHand(hands.me.concat(d.cards));
            sfx('bust'); apply(d.patch); afterPatch(); return;
          }
          if (st.drew) return;
          if (hasPlayable(hands.me, st)) { UI.toast('Du hast eine passende Karte!', 'info'); sfx('error'); return; }
          var d1 = drawPatch(st, 'me', 1, nameOf, null, false, 'Du ziehst eine Karte');
          if (!d1.cards.length) { onPass(); return; }
          hands.me = sortHand(hands.me.concat(d1.cards));
          sfx('pop'); apply(d1.patch); paint();
          var drawn = d1.cards[0];
          if (canPlay(drawn, st)) { UI.toast('Passt! ' + cardLabel(drawn) + ' kannst du legen', 'success'); }
          else after(900, function () { if (st.turn === 'me' && st.drew) onPass(); });
        }
        function onPass() {
          if (dead || st.roundOver || st.mauWait || st.turn !== 'me' || !st.drew) return;
          apply({
            drew: false, turn: st.order[stepIdx(st.order, st.order.indexOf('me'), 1, null)],
            log: 'Du passt', logSeq: (st.logSeq || 0) + 1
          });
          sfx('click'); afterPatch();
        }
        function onMau() {
          if (st.mauWait === 'me') mauSaid('me');
        }

        /* ---- Bot am Zug ---- */
        function botTick() {
          if (dead || st.roundOver || st.mauWait || st.turn === 'me' || !st.turn) return;
          var pid = st.turn;
          after(600 + Math.random() * 600, function () {
            if (st.roundOver || st.mauWait || st.turn !== pid) return;
            botMove(pid);
          });
        }
        function botMove(pid) {
          var h = hands[pid];
          if ((st.pending7 || 0) > 0) {
            var seven = botPick(h, st, pid, level, null);
            if (seven) { doPlay(pid, seven, null); return; }
            var dp = drawPatch(st, pid, st.pending7, nameOf, null, true, nameOf(pid) + ' zieht ' + st.pending7 + ' (7er-Strafe)');
            hands[pid] = h.concat(dp.cards);
            sfx('coin'); apply(dp.patch); afterPatch(); return;
          }
          var pick = botPick(h, st, pid, level, null);
          if (pick) { doPlay(pid, pick, rankOf(pick) === 'J' ? botWish(h, pick, level) : null); return; }
          var d = drawPatch(st, pid, 1, nameOf, null, false, nameOf(pid) + ' zieht eine Karte');
          if (!d.cards.length) {
            apply({ drew: false, turn: st.order[stepIdx(st.order, st.order.indexOf(pid), 1, null)], log: nameOf(pid) + ' passt', logSeq: (st.logSeq || 0) + 1 });
            afterPatch(); return;
          }
          hands[pid] = h.concat(d.cards);
          apply(d.patch); paint();
          after(500, function () {
            if (st.turn !== pid || !st.drew) return;
            var c2 = botPick(hands[pid], st, pid, level, null);
            if (c2) doPlay(pid, c2, rankOf(c2) === 'J' ? botWish(hands[pid], c2, level) : null);
            else {
              apply({ drew: false, turn: st.order[stepIdx(st.order, st.order.indexOf(pid), 1, null)], log: nameOf(pid) + ' passt', logSeq: (st.logSeq || 0) + 1 });
              afterPatch();
            }
          });
        }

        /* ---- Ansicht ---- */
        function paint() {
          updateView(refs, viewModel(st, 'me', hands.me, names, null, scores), onCard);
        }
        function showEnd() {
          var my = scores.me || 0;
          var best = App.Storage.get('best_maumau', 0);
          var nb = my > best;
          if (nb) App.Storage.set('best_maumau', my);
          var rank = 1, tied = 0;
          order.forEach(function (id) {
            if (id === 'me') return;
            if ((scores[id] || 0) > my) rank++;
            else if ((scores[id] || 0) === my) tied++;
          });
          if (rank === 1 && App.Scores) App.Scores.winCurrent();
          var lines = order.slice().sort(function (a, b) { return (scores[b] || 0) - (scores[a] || 0); })
            .map(function (id, i) { return (i + 1) + '. ' + nameOf(id) + ' — ' + (scores[id] || 0) + ' P'; }).join('   ·   ');
          App.MG.endScreen(root, {
            score: my, best: best, newBest: nb,
            title: rank === 1
              ? (tied ? '🤝 Geteilter Sieg — Platz 1' : '🏆 Du gewinnst die Partie!')
              : '🃏 Partie vorbei — Platz ' + rank,
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
        var refs = null, view = '', myHand = [], myDeal = -1, wishCard = null;
        var initDone = false, advRound = -1, mauSeen = 0, mauTimer = null, lastRep = -1, endShown = false;

        function onShared(s) { if (dead) return; sh = s; sync(); }
        function onPlayers() { if (dead) return; sync(); }
        room.on('shared', onShared);
        room.on('players', onPlayers);
        stops.push(function () { room.off('shared', onShared); room.off('players', onPlayers); });
        var wd = setInterval(function () { if (!dead) watchdog(); }, 2000);
        stops.push(function () { clearInterval(wd); });
        sync();

        function names() {
          var m = {};
          room.players().forEach(function (p) { m[p.id] = p.name; });
          return m;
        }
        function nameOf(id) { var n = names()[id]; return n || 'Spieler'; }
        function aliveFn() {
          var ids = {}, n = 0;
          room.players().forEach(function (p) { ids[p.id] = 1; n++; });
          if (n < 2) return null;                       // alleine übrig: niemanden überspringen
          return function (id) { return !!ids[id]; };
        }
        function myIdx() { return sh && sh.order ? sh.order.indexOf(me.id) : -1; }
        function write(patch) {
          Object.keys(patch).forEach(function (k) { sh[k] = patch[k]; });   // optimistisch: sofort sichtbar
          room.setShared(patch);
          sync();
        }

        function sync() {
          if (dead) return;
          var players = room.players();
          if (!sh || !sh.order || !sh.deck) {
            if (room.isHost() && !initDone && players.length >= 2) {
              initDone = true;
              var order = players.map(function (p) { return p.id; }).slice(0, 6);
              var sc = {}; order.forEach(function (id) { sc[id] = 0; });
              room.setShared(dealPatch(order, 1, sc, Math.floor(Math.random() * 1e9)));
              return;
            }
            showWait(players.length);
            return;
          }
          if (sh.seriesOver) { showEnd(); return; }

          /* Eigene Hand nur beim Austeilen einer neuen Runde ableiten */
          var idx = myIdx();
          if (idx >= 0 && sh.round !== myDeal) {
            myDeal = sh.round; myHand = handFromDeal(sh, idx);
            if (refs) refs.wishOv.classList.remove('show');
            sfx('deal');
          }
          ensureGame();
          updateView(refs, viewModel(sh, me.id, myHand, names(), aliveFn(), sh.scores || {}), onCard);
          reportScore();
          if (sh.mauWait === me.id) armMau();
          maybeAdvance();
        }

        function reportScore() {
          var s = (sh.scores && sh.scores[me.id]) || 0;
          if (s !== lastRep) { lastRep = s; room.reportScore(s); }
        }
        function ensureGame() {
          if (view === 'game') return;
          view = 'game';
          refs = buildLayout({ onDraw: onDraw, onPass: onPass, onMau: onMau, onWish: onWish });
          root.innerHTML = ''; root.appendChild(refs.root);
        }

        /* ---- MAU-Fenster (der Zug bleibt beim Spieler -> keine Kollision) ---- */
        function armMau() {
          if (mauTimer) return;
          sfx('info');
          mauTimer = after(MAU_MS, function () {
            mauTimer = null;
            if (dead || !sh || sh.mauWait !== me.id) return;
            sfx('error');
            var d = drawPatch(sh, me.id, 2, nameOf, aliveFn(), false, '😬 ' + nameOf(me.id) + ' hat MAU vergessen — 2 Karten Strafe!');
            myHand = sortHand(myHand.concat(d.cards));
            d.patch.drew = false; d.patch.mauWait = null;
            d.patch.turn = sh.nextTurn || sh.order[stepIdx(sh.order, myIdx(), 1, aliveFn())];
            d.patch.nextTurn = null;
            write(d.patch);
          });
        }
        function onMau() {
          if (!sh || sh.mauWait !== me.id) return;
          if (mauTimer) { clearTimeout(mauTimer); mauTimer = null; }
          if (App.Audio) App.Audio.sweep(420, 900, 0.18);
          write({
            mauWait: null, nextTurn: null,
            turn: sh.nextTurn || sh.order[stepIdx(sh.order, myIdx(), 1, aliveFn())],
            log: '📢 ' + nameOf(me.id) + ' sagt MAU!', logSeq: (sh.logSeq || 0) + 1
          });
        }

        /* ---- Aktionen ---- */
        function onCard(card) {
          if (dead || !sh || sh.roundOver || sh.mauWait || sh.turn !== me.id) { sfx('error'); return; }
          if (myHand.indexOf(card) < 0) return;
          if (!canPlay(card, sh)) {
            UI.toast((sh.pending7 || 0) > 0 ? 'Nur eine 7 kontert die Strafe' : 'Passt nicht auf ' + cardLabel(topCard(sh)), 'info');
            sfx('error'); return;
          }
          if (rankOf(card) === 'J') { wishCard = card; refs.wishOv.classList.add('show'); sfx('select'); return; }
          play(card, null);
        }
        function onWish(s) {
          refs.wishOv.classList.remove('show');
          if (!wishCard) return;
          var c = wishCard; wishCard = null;
          play(c, s);
        }
        function play(card, wish) {
          var k = myHand.indexOf(card);
          if (k >= 0) myHand.splice(k, 1);
          sfx('deal');
          var patch = playPatch(sh, me.id, card, wish, nameOf, aliveFn());
          write(patch);
          if (patch.roundOver) sfx('win');
        }
        function onDraw() {
          if (dead || !sh || sh.roundOver || sh.mauWait || sh.turn !== me.id) return;
          if ((sh.pending7 || 0) > 0) {
            var n = sh.pending7;
            var d = drawPatch(sh, me.id, n, nameOf, aliveFn(), true, nameOf(me.id) + ' zieht ' + n + ' Karten (7er-Strafe)');
            myHand = sortHand(myHand.concat(d.cards));
            sfx('bust'); write(d.patch); return;
          }
          if (sh.drew) return;
          if (hasPlayable(myHand, sh)) { UI.toast('Du hast eine passende Karte!', 'info'); sfx('error'); return; }
          var d1 = drawPatch(sh, me.id, 1, nameOf, aliveFn(), false, nameOf(me.id) + ' zieht eine Karte');
          if (!d1.cards.length) { passTurn(); return; }
          myHand = sortHand(myHand.concat(d1.cards));
          sfx('pop'); write(d1.patch);
          var drawn = d1.cards[0];
          if (canPlay(drawn, sh)) UI.toast('Passt! ' + cardLabel(drawn) + ' kannst du legen', 'success');
          else after(900, function () { if (sh && sh.turn === me.id && sh.drew && !sh.mauWait) passTurn(); });
        }
        function onPass() { if (sh && sh.drew && sh.turn === me.id && !sh.mauWait) { sfx('click'); passTurn(); } }
        function passTurn() {
          write({
            drew: false, turn: sh.order[stepIdx(sh.order, myIdx(), 1, aliveFn())],
            log: nameOf(me.id) + ' passt', logSeq: (sh.logSeq || 0) + 1
          });
        }

        /* ---- Host: nächste Runde / Serienende ---- */
        function maybeAdvance() {
          if (!room.isHost() || !sh || sh.seriesOver || !sh.roundOver) return;
          if (advRound === sh.round) return;
          advRound = sh.round;
          var r = sh.round;
          after(2800, function () {
            if (dead || !sh || sh.seriesOver || sh.round !== r || !sh.roundOver) return;
            if (r >= ROUNDS) room.setShared({ seriesOver: true, log: '🏁 Partie vorbei!' });
            else room.setShared(dealPatch(sh.order, r + 1, sh.scores || {}, Math.floor(Math.random() * 1e9)));
          });
        }
        /* Host-Watchdog: hängt der Zug bei jemandem, der weg ist (oder ein MAU-Fenster
           eines verschwundenen Spielers), geht es hier weiter. */
        function watchdog() {
          if (!sh || !sh.order || !room.isHost() || sh.roundOver || sh.seriesOver) return;
          var al = aliveFn();
          if (sh.mauWait) {
            if (al && !al(sh.mauWait)) {
              room.setShared({ mauWait: null, nextTurn: null, turn: sh.nextTurn || sh.order[0], log: nameOf(sh.mauWait) + ' ist weg — weiter geht\'s' });
              mauSeen = 0;
            } else {
              mauSeen++;
              if (mauSeen > 6 && sh.mauWait !== me.id) {   // 12 s: Client meldet sich nicht mehr
                room.setShared({ mauWait: null, nextTurn: null, turn: sh.nextTurn || sh.order[0] });
                mauSeen = 0;
              }
            }
            return;
          }
          mauSeen = 0;
          if (sh.turn && al && !al(sh.turn)) {
            room.setShared({
              drew: false, turn: sh.order[stepIdx(sh.order, sh.order.indexOf(sh.turn), 1, al)],
              log: nameOf(sh.turn) + ' ist weg — nächster ist dran'
            });
          }
        }

        function showWait(n) {
          if (view === 'wait') { root.querySelector('.mau-wait-n').textContent = n + ' / 2'; return; }
          view = 'wait';
          root.innerHTML = '';
          root.appendChild(el('div', { class: 'mau-panel glass' }, [
            el('div', { class: 'mau-panel-icon mau-spin' }, ['🃏']),
            el('h2', { class: 'neon' }, ['Mau-Mau']),
            el('div', { class: 'big-readout mau-wait-n' }, [n + ' / 2']),
            el('p', { class: 'hint-text' }, ['Warte auf Mitspieler — der Host mischt gleich …']),
            el('div', { class: 'controls-row' }, [el('button', { class: 'btn btn-ghost', type: 'button', onclick: ctx.onExit }, ['Zurück zur Lobby'])])
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

      /* ---------- gemeinsames View-Model (Solo + Multi) ---------- */
      function viewModel(st, meId, hand, names, alive, scores) {
        var opponents = st.order.filter(function (id) { return id !== meId; }).map(function (id) {
          return {
            name: names[id] || 'Spieler', count: (st.counts && st.counts[id]) || 0,
            score: (scores && scores[id]) || 0,
            active: st.turn === id && !st.roundOver, gone: !!(alive && !alive(id)),
            mau: st.mauWait === id
          };
        });
        var myTurn = st.turn === meId && !st.roundOver && !st.mauWait;
        var pend = st.pending7 || 0;
        var playable = {};
        hand.forEach(function (c) { if (canPlay(c, st)) playable[c] = true; });
        var canDrawNow = myTurn && !st.drew;
        var mine = hasPlayable(hand, st);

        var status;
        if (st.roundOver) {
          status = st.winner === meId
            ? { text: '🏆 Du gewinnst die Runde!', cls: 'win' }
            : { text: (names[st.winner] || 'Jemand') + ' gewinnt die Runde', cls: 'lose' };
        } else if (st.mauWait === meId) {
          status = { text: 'Sag MAU! 🃏', cls: 'mau' };
        } else if (st.mauWait) {
          status = { text: (names[st.mauWait] || 'Gegner') + ' muss MAU sagen …', cls: 'opp' };
        } else if (myTurn) {
          if (pend > 0) status = { text: 'Leg eine 7 — oder zieh ' + pend + ' Karten', cls: 'pen' };
          else if (st.drew) status = { text: 'Gezogen — legen oder passen', cls: 'you' };
          else status = { text: 'Du bist dran', cls: 'you' };
        } else if (st.turn) {
          status = { text: (names[st.turn] || 'Gegner') + ' ist dran …', cls: 'opp' };
        } else {
          status = { text: 'Runde wird gemischt …', cls: 'opp' };
        }

        var draw;
        if (myTurn && pend > 0) draw = { show: true, label: '💥 ' + pend + ' Karten ziehen', disabled: false, danger: true };
        else if (canDrawNow) draw = { show: true, label: '🂠 Karte ziehen', disabled: mine, danger: false };
        else draw = { show: !st.roundOver, label: '🂠 Karte ziehen', disabled: true, danger: false };

        var deckLeft = Math.max(0, (st.deck || []).length - (st.drawIdx || 0)) + Math.max(0, (st.discard || []).length - 1);
        return {
          round: st.round || 1, opponents: opponents, top: topCard(st), wish: st.wish || null,
          pending7: pend, deckLeft: deckLeft, hand: hand, playable: playable,
          clickable: myTurn, spectator: st.order.indexOf(meId) < 0,
          me: { name: names[meId] || 'Du', score: (scores && scores[meId]) || 0 },
          status: status, log: st.log || '', draw: draw,
          pass: myTurn && !!st.drew && pend === 0, mauForMe: st.mauWait === meId
        };
      }
    }
  };

  /* ===================== CSS ===================== */
  function injectStyle() {
    UI.injectStyle('mg-maumau-css', [
      '.mau-wrap{position:relative;display:flex;flex-direction:column;gap:10px;max-width:600px;margin:0 auto;}',
      '.mau-top{display:flex;justify-content:space-between;align-items:center;gap:10px;}',
      '.mau-brand{font-weight:900;font-size:18px;}',
      '.mau-round{font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;font-weight:800;}',
      /* Gegner */
      '.mau-opps{display:flex;gap:8px;flex-wrap:wrap;}',
      '.mau-opp{flex:1 1 110px;min-width:0;padding:7px 10px;border-radius:12px;background:rgba(9,32,21,.6);border:1px solid var(--stroke);transition:.18s;}',
      '.mau-opp.is-active{border-color:var(--neon);box-shadow:0 0 0 1px var(--neon),0 0 16px rgba(57,255,20,.3);}',
      '.mau-opp.is-mau{border-color:var(--gold);box-shadow:0 0 0 1px var(--gold),0 0 18px rgba(255,210,63,.45);animation:mau-blink .6s ease-in-out infinite;}',
      '.mau-opp.is-gone{opacity:.4;}',
      '.mau-opp-head{display:flex;justify-content:space-between;gap:6px;align-items:baseline;}',
      '.mau-opp-nm{font-weight:800;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      '.mau-opp-sc{font-size:10px;color:var(--gold);font-weight:800;flex:none;}',
      '.mau-opp-cards{display:flex;align-items:center;gap:5px;margin-top:2px;}',
      '.mau-opp-fan{display:flex;align-items:center;gap:2px;overflow:hidden;}',
      '.mau-mini{flex:0 0 auto;width:8px;height:12px;border-radius:2px;border:1px solid var(--stroke-2);background:repeating-linear-gradient(45deg,#0b3c22,#0b3c22 2px,#12a04d 2px,#12a04d 4px);}',
      '.mau-mini-more{font-size:9px;font-style:normal;font-weight:900;color:var(--muted);margin-left:1px;}',
      '.mau-opp-n{font-size:15px;font-weight:900;color:var(--leaf);font-variant-numeric:tabular-nums;margin-left:auto;}',
      /* Tisch */
      '.mau-table{display:flex;gap:22px;justify-content:center;align-items:center;padding:12px;}',
      '.mau-pile-wrap{display:flex;flex-direction:column;align-items:center;gap:5px;}',
      '.mau-pile-cap{font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;}',
      '.mau-pile{position:relative;width:clamp(66px,19vw,86px);height:clamp(96px,27vw,124px);padding:0;background:none;border:none;}',
      '.mau-deckpile{cursor:pointer;-webkit-tap-highlight-color:transparent;transition:transform .12s;}',
      '.mau-deckpile:active{transform:scale(.95);}',
      '.mau-deckpile.is-hot .mau-card{box-shadow:0 0 0 2px var(--aqua),0 0 22px rgba(51,230,208,.5);animation:mau-hot 1.3s ease-in-out infinite;}',
      '.mau-discpile{border-radius:12px;border:2px dashed var(--stroke);}',
      '.mau-disc-slot{position:absolute;inset:-2px;}',
      '.mau-pile-lbl{position:absolute;bottom:-6px;right:-6px;min-width:22px;padding:1px 5px;border-radius:8px;background:rgba(4,16,10,.92);border:1px solid var(--stroke-2);color:var(--aqua);font-size:11px;font-weight:900;text-align:center;}',
      '.mau-wish-badge,.mau-pen-badge{position:absolute;display:none;align-items:center;justify-content:center;font-weight:900;border-radius:50%;}',
      '.mau-wish-badge{top:-10px;left:-10px;width:30px;height:30px;font-size:17px;background:#f2fff0;border:2px solid var(--gold);box-shadow:0 0 14px rgba(255,210,63,.6);}',
      '.mau-wish-badge.show{display:flex;animation:mau-pop .25s ease;}',
      '.mau-wish-badge.mau-red{color:#d81e46;}',
      '.mau-wish-badge.mau-black{color:#12261a;}',
      '.mau-pen-badge{top:-10px;right:-12px;min-width:34px;height:30px;border-radius:11px;font-size:14px;color:#fff;background:var(--danger);border:1px solid #fff;box-shadow:0 0 16px rgba(255,77,109,.7);}',
      '.mau-pen-badge.show{display:flex;animation:mau-blink .7s ease-in-out infinite;}',
      /* Karten */
      '.mau-card{position:relative;width:100%;height:100%;border-radius:11px;display:flex;flex-direction:column;justify-content:space-between;align-items:center;padding:5px 4px;box-sizing:border-box;user-select:none;-webkit-user-select:none;}',
      '.mau-face{background:linear-gradient(160deg,#fbfff8,#dceadc 70%,#c3d6c6);border:1px solid rgba(0,0,0,.35);box-shadow:0 3px 10px rgba(0,0,0,.45);}',
      '.mau-face.mau-red{color:#d81e46;}',
      '.mau-face.mau-black{color:#12261a;}',
      '.mau-c-r{align-self:flex-start;font-size:clamp(12px,3.2vw,15px);font-weight:900;line-height:1;}',
      '.mau-c-r2{align-self:flex-end;font-size:clamp(12px,3.2vw,15px);font-weight:900;line-height:1;transform:rotate(180deg);}',
      '.mau-c-s{font-size:clamp(20px,6vw,30px);line-height:1;}',
      '.mau-back{background:repeating-linear-gradient(45deg,#0b3c22,#0b3c22 6px,#0f5c31 6px,#0f5c31 12px);border:1px solid var(--stroke-2);box-shadow:0 3px 10px rgba(0,0,0,.5);align-items:center;justify-content:center;}',
      '.mau-back-in{font-size:22px;filter:drop-shadow(0 0 6px rgba(57,255,20,.7));}',
      '.mau-pile-card{position:absolute;inset:0;width:100%;height:100%;}',
      '.mau-drop{animation:mau-drop .28s cubic-bezier(.2,.9,.3,1.2);}',
      /* Status / Log */
      '.mau-status{text-align:center;font-weight:900;font-size:clamp(15px,4.2vw,19px);min-height:24px;}',
      '.mau-status.you{color:var(--neon);text-shadow:0 0 10px rgba(57,255,20,.4);}',
      '.mau-status.opp{color:var(--aqua);}',
      '.mau-status.pen{color:var(--danger);text-shadow:0 0 10px rgba(255,77,109,.4);}',
      '.mau-status.win{color:var(--gold);text-shadow:0 0 12px rgba(255,210,63,.5);}',
      '.mau-status.lose{color:var(--silver);}',
      '.mau-status.mau{color:var(--gold);animation:mau-blink .5s ease-in-out infinite;}',
      '.mau-log{text-align:center;margin:0;min-height:16px;font-size:12px;}',
      '.mau-actions{margin:0;gap:8px;}',
      '.mau-btn{min-width:150px;}',
      /* Hand */
      '.mau-hand-wrap{display:flex;flex-direction:column;gap:6px;padding:9px 10px;border-radius:16px;background:rgba(6,24,16,.6);border:1px solid var(--stroke);}',
      '.mau-me-bar{display:flex;align-items:center;gap:8px;font-size:11px;}',
      '.mau-me-tag{color:var(--muted);text-transform:uppercase;letter-spacing:1px;font-weight:800;}',
      '.mau-me-nm{font-weight:900;color:var(--aqua);}',
      '.mau-me-spacer{flex:1;}',
      '.mau-me-sc{font-weight:900;color:var(--gold);}',
      '.mau-hand{display:flex;gap:6px;overflow-x:auto;overflow-y:hidden;padding:14px 2px 6px;-webkit-overflow-scrolling:touch;min-height:112px;align-items:flex-end;}',
      '.mau-hand-empty{color:var(--muted);font-size:13px;padding:32px 8px;width:100%;text-align:center;}',
      '.mau-hcard{flex:0 0 auto;width:clamp(50px,13.5vw,64px);height:clamp(74px,20vw,94px);cursor:default;transition:transform .14s,box-shadow .18s,filter .18s;animation:mau-in .28s ease backwards;}',
      '.mau-hcard.is-ok{cursor:pointer;box-shadow:0 0 0 2px var(--neon),0 0 18px rgba(57,255,20,.45);transform:translateY(-8px);}',
      '.mau-hcard.is-ok:hover{transform:translateY(-14px) scale(1.04);}',
      '.mau-hcard.is-ok:active{transform:translateY(-4px) scale(.97);}',
      '.mau-hcard.is-dim{filter:grayscale(.75) brightness(.62);}',
      '.mau-rules{text-align:center;margin:0;font-size:11px;opacity:.85;}',
      /* Overlays */
      '.mau-ov{position:absolute;inset:0;display:none;flex-direction:column;align-items:center;justify-content:center;gap:12px;border-radius:18px;background:rgba(3,12,8,.86);backdrop-filter:blur(4px);z-index:5;padding:16px;text-align:center;}',
      '.mau-ov.show{display:flex;animation:mau-fade .18s ease;}',
      '.mau-ov-hint{font-weight:800;color:var(--aqua-soft);font-size:14px;}',
      '.mau-ov-sub{font-size:12px;color:var(--muted);}',
      '.mau-maubtn{padding:20px 46px;border-radius:20px;border:2px solid var(--gold);background:linear-gradient(180deg,#ffe98a,var(--gold));color:#2b1c00;font-family:inherit;font-size:clamp(30px,9vw,46px);font-weight:900;letter-spacing:3px;cursor:pointer;box-shadow:0 0 34px rgba(255,210,63,.65);animation:mau-beat .55s ease-in-out infinite;-webkit-tap-highlight-color:transparent;}',
      '.mau-maubtn:active{transform:scale(.95);}',
      '.mau-wish-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:10px;}',
      '.mau-wish-btn{display:flex;flex-direction:column;align-items:center;gap:2px;padding:12px 22px;border-radius:14px;border:2px solid var(--stroke-2);background:linear-gradient(160deg,#fbfff8,#dceadc);font-family:inherit;cursor:pointer;transition:transform .12s,box-shadow .15s;-webkit-tap-highlight-color:transparent;}',
      '.mau-wish-btn:hover{transform:translateY(-3px);box-shadow:0 0 18px rgba(57,255,20,.4);}',
      '.mau-wish-btn:active{transform:scale(.96);}',
      '.mau-wish-btn.mau-red{color:#d81e46;}',
      '.mau-wish-btn.mau-black{color:#12261a;}',
      '.mau-wish-sym{font-size:30px;line-height:1;}',
      '.mau-wish-nm{font-size:11px;font-weight:900;text-transform:uppercase;letter-spacing:1px;}',
      /* Panels */
      '.mau-panel{padding:26px 22px;text-align:center;display:flex;flex-direction:column;gap:12px;align-items:center;max-width:460px;margin:0 auto;}',
      '.mau-panel-icon{font-size:52px;line-height:1;filter:drop-shadow(0 0 12px rgba(57,255,20,.5));}',
      '.mau-spin{animation:mau-spin 2.8s linear infinite;}',
      '.mau-opt-lbl{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;font-weight:800;}',
      '.mau-opt-row{display:flex;gap:8px;flex-wrap:wrap;justify-content:center;}',
      '.mau-opt{padding:9px 16px;border-radius:12px;border:1px solid var(--stroke);background:rgba(9,32,21,.6);color:var(--muted);font-family:inherit;font-weight:800;font-size:13px;cursor:pointer;transition:.15s;-webkit-tap-highlight-color:transparent;}',
      '.mau-opt.is-on{border-color:var(--neon);color:var(--neon);box-shadow:0 0 14px rgba(57,255,20,.3);}',
      /* Animationen */
      '@keyframes mau-in{from{opacity:0;transform:translateY(16px) rotate(-4deg);}to{opacity:1;transform:translateY(0);}}',
      '@keyframes mau-drop{from{opacity:.2;transform:translateY(-26px) rotate(-14deg) scale(1.15);}to{opacity:1;transform:none;}}',
      '@keyframes mau-pop{from{transform:scale(.3);}to{transform:scale(1);}}',
      '@keyframes mau-fade{from{opacity:0;}to{opacity:1;}}',
      '@keyframes mau-blink{0%,100%{opacity:1;}50%{opacity:.45;}}',
      '@keyframes mau-beat{0%,100%{transform:scale(1);}50%{transform:scale(1.07);}}',
      '@keyframes mau-hot{0%,100%{filter:brightness(1);}50%{filter:brightness(1.35);}}',
      '@keyframes mau-spin{to{transform:rotate(360deg);}}'
    ].join(''));
  }
})();
