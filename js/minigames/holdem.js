/* holdem.js — "Texas Hold'em": Mehrspieler-Poker im Neon-Dschungel-Look.
 *
 *  Host-autoritativ: NUR der Host (im Solo bist DU der Host) führt die komplette
 *  Engine — mischen, austeilen, Blinds, Setzrunden, Pot, Showdown. Der GESAMTE
 *  Zustand wird via room.setShared verteilt; alle Clients rendern nur daraus.
 *  Spieler-Aktionen kommen als Intent per room.reportState({seq, action, amount});
 *  der Host wendet jeden Intent GENAU EINMAL an (letzte seq je Spieler) und nur,
 *  wenn dieser Spieler am Zug ist.
 *
 *  SOLO   (ctx.mode==='single'): du + 3 Bots. Du agierst über die Aktionsleiste,
 *         die Bots per Heuristik.
 *  MULTI  (ctx.mode==='multi'):  2–6 echte Spieler über einen Raum-Code.
 *
 *  Verdeckte Karten liegen als shared.hands[playerId] vor; jeder Client zeigt nur
 *  die eigenen Hole-Cards offen, fremde als Rückseite — bis zum Showdown.
 *
 *  DOM wird EINMAL gebaut (ensure) und danach nur in-place aktualisiert
 *  (kein Flackern). cleanup() stoppt alle Timer und entfernt die Room-Listener. */
(function () {
  'use strict';
  window.App = window.App || {}; App.Minigames = App.Minigames || {};
  var UI = App.UI, el = UI.el, P = App.Poker;

  injectStyle();

  var START = 1000, SMALL_BLIND = 10, BIG_BLIND = 20;
  var TURN_MS = 25000, HANDOVER_MS = 4500, BOT_MIN_MS = 800, MIN = 2;

  /* ============================================================
   *  REINE POKER-ENGINE (arbeitet auf einem Game-Objekt G)
   * ============================================================ */
  function needAction(G, id) {
    if (G.folded[id] || G.allin[id]) return false;
    if ((G.chips[id] || 0) <= 0) return false;
    if (!G.acted[id]) return true;
    if ((G.bets[id] || 0) < G.currentBet) return true;
    return false;
  }
  function ableToBet(G) {
    return G.participants.filter(function (id) { return !G.folded[id] && !G.allin[id] && (G.chips[id] || 0) > 0; });
  }
  function nextNeeding(G, fromId) {
    var Q = G.participants, n = Q.length, s = Q.indexOf(fromId);
    if (s < 0) s = 0;
    for (var k = 1; k <= n; k++) { var id = Q[(s + k) % n]; if (needAction(G, id)) return id; }
    return null;
  }
  function firstNeedingFrom(G, startIdx) {
    var Q = G.participants, n = Q.length;
    for (var k = 0; k < n; k++) { var id = Q[(startIdx + k) % n]; if (needAction(G, id)) return id; }
    return null;
  }
  function payIn(G, id, amt) {
    amt = Math.max(0, Math.min(amt, G.chips[id] || 0));
    G.chips[id] -= amt; G.bets[id] = (G.bets[id] || 0) + amt;
    G.committed[id] = (G.committed[id] || 0) + amt; G.pot += amt;
    return amt;
  }
  function postBlind(G, id, amt) {
    payIn(G, id, Math.min(amt, G.chips[id] || 0));
    if ((G.chips[id] || 0) === 0) G.allin[id] = true;
  }
  function setToAct(G, id, now) {
    G.toAct = id; G.toActAt = now; G.deadline = now + TURN_MS;
    G.botMs = BOT_MIN_MS + Math.floor(Math.random() * 500);
  }
  function dealCommunity(G, k) { for (var i = 0; i < k; i++) G.community.push(G.deck.pop()); }

  function applyAction(G, id, action, amount) {
    if (G.phase !== 'playing' || id !== G.toAct) return null;
    if (G.folded[id] || G.allin[id]) return null;
    var myBet = G.bets[id] || 0, stack = G.chips[id] || 0;
    var toCall = G.currentBet - myBet;
    if (action === 'check' && toCall > 0) action = 'call';
    if (action === 'call' && toCall <= 0) action = 'check';
    var info = { action: action, to: myBet, allin: false };
    G.acted[id] = true;
    if (action === 'fold') {
      G.folded[id] = true;
    } else if (action === 'check') {
      /* nichts zu tun */
    } else if (action === 'call') {
      payIn(G, id, Math.min(Math.max(0, toCall), stack));
      info.to = G.bets[id];
      if ((G.chips[id] || 0) === 0) { G.allin[id] = true; info.allin = true; }
    } else if (action === 'raise' || action === 'allin') {
      var maxTo = myBet + stack, target;
      if (action === 'allin') target = maxTo;
      else {
        target = Math.floor(amount || 0);
        var minTo = G.currentBet + G.minRaise;
        if (target > maxTo) target = maxTo;
        if (target < minTo) target = Math.min(minTo, maxTo);
      }
      payIn(G, id, target - myBet);
      var newBet = G.bets[id]; info.to = newBet;
      if (newBet > G.currentBet) {
        var raiseSize = newBet - G.currentBet;
        if (raiseSize >= G.minRaise) G.minRaise = raiseSize;
        G.currentBet = newBet;
        G.participants.forEach(function (pid) { if (pid !== id && !G.folded[pid] && !G.allin[pid]) G.acted[pid] = false; });
      }
      if ((G.chips[id] || 0) === 0) { G.allin[id] = true; info.allin = true; }
      info.action = (action === 'allin') ? 'allin' : 'raise';
    } else return null;
    return info;
  }

  function progress(G, now) {
    if (G.phase !== 'playing') return;
    var live = G.participants.filter(function (id) { return !G.folded[id]; });
    if (live.length <= 1) { endHandByFold(G, live[0], now); return; }
    var nxt = nextNeeding(G, G.toAct);
    if (nxt !== null) { setToAct(G, nxt, now); return; }
    toNextStreet(G, now);
  }
  function toNextStreet(G, now) {
    if (G.street === 'preflop') { G.street = 'flop'; dealCommunity(G, 3); startBettingRound(G, now); }
    else if (G.street === 'flop') { G.street = 'turn'; dealCommunity(G, 1); startBettingRound(G, now); }
    else if (G.street === 'turn') { G.street = 'river'; dealCommunity(G, 1); startBettingRound(G, now); }
    else if (G.street === 'river') { doShowdown(G, now); }
  }
  function startBettingRound(G, now) {
    G.participants.forEach(function (id) { G.bets[id] = 0; G.acted[id] = false; });
    G.currentBet = 0; G.minRaise = BIG_BLIND;
    if (ableToBet(G).length < 2) { toNextStreet(G, now); return; }
    var first = firstNeedingFrom(G, (G.buttonIdx + 1) % G.participants.length);
    if (first === null) { toNextStreet(G, now); return; }
    setToAct(G, first, now);
  }
  function doShowdown(G, now) {
    G.street = 'showdown';
    var cont = G.participants.filter(function (id) { return !G.folded[id]; });
    var evals = cont.map(function (id) { return { id: id, ev: P.evalBest(G.hands[id].concat(G.community)) }; });
    var best = null;
    evals.forEach(function (e) { if (!best || P.compare(e.ev, best) > 0) best = e.ev; });
    var winners = evals.filter(function (e) { return P.compare(e.ev, best) === 0; }).map(function (e) { return e.id; });
    var potWon = G.pot;
    awardPot(G, winners);
    G.result = {
      winners: winners, reveal: true, potWon: potWon,
      evals: evals.map(function (e) { return { id: e.id, name: P.handName(e.ev), cat: e.ev.cat }; })
    };
    finishHand(G, now);
  }
  function endHandByFold(G, id, now) {
    var potWon = G.pot;
    awardPot(G, id ? [id] : []);
    G.result = { winners: id ? [id] : [], reveal: false, potWon: potWon };
    finishHand(G, now);
  }
  function awardPot(G, winners) {
    if (!winners || !winners.length) { G.pot = 0; return; }
    var pot = G.pot, share = Math.floor(pot / winners.length), rem = pot - share * winners.length;
    winners.forEach(function (id, i) { G.chips[id] = (G.chips[id] || 0) + share + (i < rem ? 1 : 0); });
    G.pot = 0;
  }
  function finishHand(G, now) { G.phase = 'handover'; G.handOverAt = now; G.toAct = null; G.deadline = 0; }

  function nextButton(prev, pool) {
    if (prev == null) return pool[0];
    var i = pool.indexOf(prev);
    if (i < 0) return pool[0];
    return pool[(i + 1) % pool.length];
  }
  /* Startet eine neue Hand: Button rotieren, austeilen, Blinds, erste Setzrunde. */
  function beginHand(G, pool, meta, now) {
    G.handNo = (G.handNo || 0) + 1;
    G.buttonId = nextButton(G.buttonId, pool);
    G.participants = pool.slice();
    G.buttonIdx = pool.indexOf(G.buttonId); if (G.buttonIdx < 0) G.buttonIdx = 0;
    G.seatOrder = pool.map(function (id) { var m = meta[id] || {}; return { id: id, name: m.name || 'Spieler', bot: !!m.bot }; });
    G.botSet = {}; pool.forEach(function (id) { if (meta[id] && meta[id].bot) G.botSet[id] = true; });
    G.hands = {}; G.community = []; G.pot = 0; G.currentBet = 0; G.minRaise = BIG_BLIND;
    G.bets = {}; G.committed = {}; G.folded = {}; G.allin = {}; G.acted = {};
    pool.forEach(function (id) { G.bets[id] = 0; G.committed[id] = 0; G.folded[id] = false; G.allin[id] = false; G.acted[id] = false; });
    G.deck = P.shuffle(P.makeDeck());
    pool.forEach(function (id) { G.hands[id] = [G.deck.pop(), G.deck.pop()]; });
    var n = pool.length, sbIdx, bbIdx, firstIdx;
    if (n === 2) { sbIdx = G.buttonIdx; bbIdx = (G.buttonIdx + 1) % 2; firstIdx = G.buttonIdx; }
    else { sbIdx = (G.buttonIdx + 1) % n; bbIdx = (G.buttonIdx + 2) % n; firstIdx = (G.buttonIdx + 3) % n; }
    postBlind(G, pool[sbIdx], SMALL_BLIND);
    postBlind(G, pool[bbIdx], BIG_BLIND);
    G.currentBet = BIG_BLIND; G.minRaise = BIG_BLIND;
    pool.forEach(function (id) { G.acted[id] = false; });   // Blinds behalten die Option
    G.street = 'preflop'; G.phase = 'playing'; G.result = null; G.lastAction = null;
    if (ableToBet(G).length < 2) { toNextStreet(G, now); }
    else {
      var first = firstNeedingFrom(G, firstIdx);
      if (first === null) toNextStreet(G, now); else setToAct(G, first, now);
    }
  }

  /* ============================================================
   *  BOT-HEURISTIK
   * ============================================================ */
  function preflopStrength(hole) {
    var a = P.rankVal(hole[0]), b = P.rankVal(hole[1]);
    var hi = Math.max(a, b), lo = Math.min(a, b), suited = P.suitOf(hole[0]) === P.suitOf(hole[1]);
    var s;
    if (a === b) s = 0.5 + (a - 2) / 12 * 0.5;                 // Paar
    else { s = (hi - 2) / 12 * 0.5 + (lo - 2) / 12 * 0.22; if (hi - lo === 1) s += 0.06; if (hi >= 13) s += 0.05; }
    if (suited) s += 0.08;
    return Math.max(0, Math.min(1, s));
  }
  function botStrength(G, id) {
    var hole = G.hands[id], comm = G.community;
    if (comm.length < 3) return preflopStrength(hole);
    var ev = P.evalBest(hole.concat(comm));
    var base = [0.18, 0.42, 0.6, 0.72, 0.82, 0.88, 0.93, 0.97, 1][ev.cat];
    if (ev.cat === 0) base = 0.10 + (ev.tie[0] - 2) / 12 * 0.28;
    else if (ev.cat === 1) base = 0.36 + (ev.tie[0] - 2) / 12 * 0.18;
    return base;
  }
  function botDecide(G, id) {
    var s = botStrength(G, id) + (Math.random() * 0.16 - 0.08);
    var toCall = G.currentBet - (G.bets[id] || 0), stack = G.chips[id] || 0, pot = G.pot;
    var r = Math.random(), bluff = r < 0.06;
    if (toCall <= 0) {
      if (s > 0.62 || bluff) return { action: 'raise', amount: G.currentBet + Math.max(BIG_BLIND, Math.round(pot * 0.6)) };
      return { action: 'check' };
    }
    if (s < 0.30 && !bluff) {
      if (toCall <= BIG_BLIND && s > 0.20 && r < 0.5) return { action: 'call' };
      return { action: 'fold' };
    }
    if (s > 0.78 || (bluff && r < 0.03)) return { action: 'raise', amount: G.currentBet + Math.max(G.minRaise, Math.round((pot + toCall) * 0.7)) };
    if (toCall > stack * 0.6 && s < 0.55) return { action: 'fold' };
    return { action: 'call' };
  }

  /* ============================================================
   *  ANSICHT — Normalisierung (G ODER shared -> View)
   * ============================================================ */
  function toView(s) {
    return {
      handNo: s.handNo || 0, seatOrder: s.seatOrder || [], chips: s.chips || {}, bets: s.bets || {},
      folded: s.folded || {}, allin: s.allin || {}, hands: s.hands || {}, community: s.community || [],
      pot: s.pot || 0, currentBet: s.currentBet || 0, minRaise: s.minRaise || BIG_BLIND,
      button: (s.button != null ? s.button : s.buttonId), toAct: (s.toAct != null ? s.toAct : null),
      deadline: s.deadline || 0, street: s.street || 'preflop', phase: s.phase || 'playing',
      result: s.result || null, lastAction: s.lastAction || null
    };
  }
  function seatById(V, id) { for (var i = 0; i < V.seatOrder.length; i++) if (V.seatOrder[i].id === id) return V.seatOrder[i]; return null; }
  function nameOf(V, id) { var s = seatById(V, id); return s ? s.name : 'Spieler'; }
  function rankLabel(card) { return card[0] === 'T' ? '10' : card[0]; }
  function cardText(card) { return rankLabel(card) + P.SUIT_SYM[P.suitOf(card)]; }
  function streetLabel(st) { return { preflop: 'Preflop', flop: 'Flop', turn: 'Turn', river: 'River', showdown: 'Showdown' }[st] || ''; }
  function actionDe(a) {
    if (a.action === 'raise') return 'Raise auf ' + a.to;
    if (a.action === 'allin') return 'All-in (' + a.to + ')';
    if (a.action === 'call') return 'Call';
    if (a.action === 'check') return 'Check';
    return 'Fold';
  }

  /* Karte in einen Slot rendern (in-place, überspringt unveränderte). */
  function setCard(slot, card, mode, lg) {
    var key = (mode === 'up' ? 'u:' + card : mode) + (lg ? 'L' : '');
    if (slot._key === key) return;
    slot._key = key; slot.innerHTML = '';
    var base = 'hd-card' + (lg ? ' hd-card-lg' : '');
    if (mode === 'empty') { slot.className = base + ' hd-empty'; return; }
    if (mode === 'back') { slot.className = base + ' hd-back'; return; }
    var suit = P.suitOf(card), red = (suit === 'h' || suit === 'd');
    slot.className = base + ' hd-up ' + (red ? 'hd-red' : 'hd-black');
    slot.appendChild(el('span', { class: 'hd-r' }, [rankLabel(card)]));
    slot.appendChild(el('span', { class: 'hd-s' }, [P.SUIT_SYM[suit]]));
  }

  /* ---------- gemeinsames Tisch-Layout (EINMAL bauen) ---------- */
  function buildLayout(onExit) {
    var brand = el('div', { class: 'hd-brand neon' }, ['♠ Texas Hold’em']);
    var streetEl = el('div', { class: 'hd-street' }, ['']);
    var timerNum = el('span', { class: 'hd-timer-num' }, ['']);
    var timerBar = el('div', { class: 'hd-timer-fill' });
    var timerWrap = el('div', { class: 'hd-timer' }, [
      el('span', { class: 'hd-timer-ico' }, ['⏱']), timerNum, el('div', { class: 'hd-timer-bar' }, [timerBar])
    ]);
    var backBtn = el('button', { class: 'btn btn-ghost hd-back-btn', type: 'button', onclick: onExit }, ['← Zurück']);
    var top = el('div', { class: 'hd-top' }, [brand, el('div', { class: 'hd-top-right' }, [streetEl, timerWrap])]);

    var potEl = el('div', { class: 'hd-pot' }, ['🪙 0']);
    var comm = [], commRow = el('div', { class: 'hd-community' });
    for (var i = 0; i < 5; i++) { var c = el('div', { class: 'hd-card hd-card-lg hd-empty' }); comm.push(c); commRow.appendChild(c); }
    var table = el('div', { class: 'hd-table glass' }, [
      el('div', { class: 'hd-pot-wrap' }, [el('span', { class: 'hd-pot-l' }, ['Pot']), potEl]), commRow
    ]);

    var seatsEl = el('div', { class: 'hd-seats' });
    var myHandEl = el('div', { class: 'hd-myhand' }, ['']);
    var lastActEl = el('div', { class: 'hd-lastact' }, ['']);
    var statusEl = el('div', { class: 'hd-status' }, ['']);

    var foldBtn = el('button', { class: 'btn hd-abtn hd-fold', type: 'button' }, ['Fold']);
    var ccBtn = el('button', { class: 'btn hd-abtn hd-call', type: 'button' }, ['Check']);
    var allinBtn = el('button', { class: 'btn btn-aqua hd-abtn hd-allin', type: 'button' }, ['All-in']);
    var raiseVal = el('span', { class: 'hd-raise-val' }, ['0']);
    var raiseInput = el('input', { class: 'hd-raise-range', type: 'range', min: 0, max: 100, step: BIG_BLIND, value: 0 });
    var raiseBtn = el('button', { class: 'btn btn-primary hd-abtn hd-raise', type: 'button' }, ['Raise']);
    var raiseWrap = el('div', { class: 'hd-raise-wrap' }, [
      el('div', { class: 'hd-raise-top' }, [el('span', { class: 'hd-raise-l' }, ['Erhöhen auf']), raiseVal]),
      el('div', { class: 'hd-raise-row' }, [raiseInput, raiseBtn])
    ]);
    var actionBar = el('div', { class: 'hd-actionbar' }, [el('div', { class: 'hd-abtns' }, [foldBtn, ccBtn, allinBtn]), raiseWrap]);

    var root = el('div', { class: 'hd-wrap' }, [
      el('div', { class: 'hd-headrow' }, [backBtn, top]),
      table, myHandEl, seatsEl, lastActEl, statusEl, actionBar
    ]);

    var refs = {
      root: root, streetEl: streetEl, potEl: potEl, timerWrap: timerWrap, timerNum: timerNum, timerBar: timerBar,
      comm: comm, seatsEl: seatsEl, myHandEl: myHandEl, lastActEl: lastActEl, statusEl: statusEl,
      actionBar: actionBar, foldBtn: foldBtn, ccBtn: ccBtn, allinBtn: allinBtn,
      raiseInput: raiseInput, raiseVal: raiseVal, raiseBtn: raiseBtn, raiseWrap: raiseWrap,
      _seats: {}, _seatSig: null, _actSig: null, _h: null, _checkAction: 'check', _lastV: null
    };
    foldBtn.addEventListener('click', function () { if (refs._h) refs._h.fold(); });
    ccBtn.addEventListener('click', function () { if (refs._h) refs._h.checkcall(refs._checkAction); });
    allinBtn.addEventListener('click', function () { if (refs._h) refs._h.allin(); });
    raiseBtn.addEventListener('click', function () { if (refs._h) refs._h.raise(parseInt(refs.raiseInput.value, 10)); });
    raiseInput.addEventListener('input', function () { refs.raiseVal.textContent = refs.raiseInput.value; });
    return refs;
  }

  /* ---------- View -> DOM (in-place) ---------- */
  function renderTable(refs, V, meId, handlers) {
    refs._h = handlers;
    refs.potEl.textContent = '🪙 ' + V.pot;
    refs.streetEl.textContent = streetLabel(V.street) + (V.handNo ? ' · Hand ' + V.handNo : '');
    for (var i = 0; i < 5; i++) { var card = V.community[i]; setCard(refs.comm[i], card || null, card ? 'up' : 'empty', true); }
    updateSeats(refs, V, meId);
    updateMyHand(refs, V, meId);
    updateLastAct(refs, V);
    updateStatus(refs, V, meId);
    configureActionBar(refs, V, meId);
    refs._lastV = V;
  }

  function updateSeats(refs, V, meId) {
    var sig = V.seatOrder.map(function (s) { return s.id; }).join(',');
    if (refs._seatSig !== sig) {
      refs._seatSig = sig; refs._seats = {}; refs.seatsEl.innerHTML = '';
      V.seatOrder.forEach(function (s) {
        var c0 = el('div', { class: 'hd-card' }), c1 = el('div', { class: 'hd-card' });
        var nameEl = el('div', { class: 'hd-seat-name' }, [s.name]);
        var chipsEl = el('div', { class: 'hd-seat-chips' }, ['']);
        var tagEl = el('div', { class: 'hd-seat-tag' }, ['']);
        var betEl = el('div', { class: 'hd-seat-bet' }, ['']);
        var badgeEl = el('div', { class: 'hd-seat-badge' }, ['']);
        var dealerEl = el('div', { class: 'hd-dealer' }, ['D']);
        var seat = el('div', { class: 'hd-seat' }, [
          el('div', { class: 'hd-seat-top' }, [dealerEl, el('div', { class: 'hd-seat-cards' }, [c0, c1]), badgeEl]),
          el('div', { class: 'hd-seat-info' }, [nameEl, chipsEl]), tagEl, betEl
        ]);
        refs._seats[s.id] = { seat: seat, c0: c0, c1: c1, nameEl: nameEl, chipsEl: chipsEl, tagEl: tagEl, betEl: betEl, badgeEl: badgeEl, dealerEl: dealerEl };
        refs.seatsEl.appendChild(seat);
      });
    }
    var contenders = V.seatOrder.filter(function (s) { return !V.folded[s.id]; }).map(function (s) { return s.id; });
    var reveal = !!(V.result && V.result.reveal);
    V.seatOrder.forEach(function (s) {
      var r = refs._seats[s.id], id = s.id, hand = V.hands[id];
      var faceUp = id === meId || (reveal && contenders.indexOf(id) >= 0);
      setCard(r.c0, hand ? hand[0] : null, hand ? (faceUp ? 'up' : 'back') : 'empty');
      setCard(r.c1, hand ? hand[1] : null, hand ? (faceUp ? 'up' : 'back') : 'empty');
      r.nameEl.textContent = s.name + (id === meId ? ' (du)' : '');
      r.chipsEl.textContent = '🪙 ' + (V.chips[id] || 0);
      var bet = V.bets[id] || 0;
      r.betEl.textContent = bet > 0 ? String(bet) : '';
      r.betEl.classList.toggle('show', bet > 0);
      var badge = '';
      if (V.folded[id]) badge = 'Fold'; else if (V.allin[id]) badge = 'ALL-IN';
      r.badgeEl.textContent = badge;
      r.badgeEl.className = 'hd-seat-badge' + (V.allin[id] ? ' allin' : '') + (V.folded[id] ? ' fold' : '');
      r.dealerEl.style.visibility = (id === V.button) ? 'visible' : 'hidden';
      var tag = '';
      if (reveal && V.result.evals && contenders.indexOf(id) >= 0) {
        for (var k = 0; k < V.result.evals.length; k++) if (V.result.evals[k].id === id) tag = V.result.evals[k].name;
      }
      r.tagEl.textContent = tag; r.tagEl.classList.toggle('show', !!tag);
      var isWinner = V.result && V.result.winners && V.result.winners.indexOf(id) >= 0;
      r.seat.classList.toggle('me', id === meId);
      r.seat.classList.toggle('active', V.phase === 'playing' && V.toAct === id);
      r.seat.classList.toggle('folded', !!V.folded[id]);
      r.seat.classList.toggle('allin', !!V.allin[id]);
      r.seat.classList.toggle('winner', !!isWinner);
    });
  }

  function updateMyHand(refs, V, meId) {
    var hole = V.hands[meId], t = '';
    if (hole) {
      if (V.folded[meId]) t = 'Du hast gefoldet';
      else if (V.community.length >= 3) t = 'Dein Blatt: ' + P.handName(P.evalBest(hole.concat(V.community)));
      else t = 'Deine Karten: ' + cardText(hole[0]) + ' ' + cardText(hole[1]);
    }
    refs.myHandEl.textContent = t;
  }
  function updateLastAct(refs, V) {
    var a = V.lastAction;
    refs.lastActEl.textContent = (a && V.phase === 'playing') ? (nameOf(V, a.id) + ': ' + actionDe(a)) : '';
  }
  function resultText(V) {
    var w = (V.result && V.result.winners) || []; if (!w.length) return '';
    var names = w.map(function (id) { return nameOf(V, id); }).join(' & ');
    var amt = V.result.potWon || 0, extra = '';
    if (V.result.reveal && V.result.evals) {
      for (var i = 0; i < V.result.evals.length; i++) if (V.result.evals[i].id === w[0]) extra = ' mit ' + V.result.evals[i].name;
    }
    return names + ' gewinnt ' + amt + ' 🪙' + extra;
  }
  function updateStatus(refs, V, meId) {
    var cls = 'opp', text = '';
    if (V.phase === 'handover' && V.result) { text = resultText(V); cls = 'win'; }
    else if (V.phase === 'playing') {
      var seat = seatById(V, meId);
      if (!seat) { text = 'Du schaust zu'; }
      else if (V.folded[meId]) { text = 'Du hast gefoldet — warte auf die Runde'; }
      else if (V.toAct === meId) { text = 'Du bist am Zug'; cls = 'you'; }
      else { text = nameOf(V, V.toAct) + ' ist am Zug'; }
    }
    refs.statusEl.textContent = text; refs.statusEl.className = 'hd-status ' + cls;
  }

  function configureActionBar(refs, V, meId) {
    var seat = seatById(V, meId);
    var myTurn = V.phase === 'playing' && V.toAct === meId && seat && !V.folded[meId] && !V.allin[meId];
    if (!myTurn) {
      if (refs._actSig !== 'off') { refs._actSig = 'off'; refs.actionBar.classList.remove('show'); }
      return;
    }
    var myBet = V.bets[meId] || 0, myChips = V.chips[meId] || 0;
    var toCall = Math.max(0, V.currentBet - myBet), callAmt = Math.min(toCall, myChips), canCheck = toCall <= 0;
    var maxTo = myBet + myChips, minTo = Math.min(maxTo, V.currentBet + V.minRaise);
    var showRaise = myChips > 0 && maxTo > V.currentBet && maxTo >= minTo;
    var sig = [canCheck, callAmt, minTo, maxTo, myChips, showRaise].join('|');
    if (refs._actSig === sig) return;
    refs._actSig = sig;
    refs.actionBar.classList.add('show');
    refs.ccBtn.textContent = canCheck ? 'Check' : ('Call ' + callAmt + (callAmt === myChips && callAmt > 0 ? ' (All-in)' : ''));
    refs._checkAction = canCheck ? 'check' : 'call';
    if (showRaise) {
      refs.raiseWrap.style.display = '';
      refs.raiseInput.min = minTo; refs.raiseInput.max = maxTo; refs.raiseInput.step = BIG_BLIND;
      refs.raiseInput.value = minTo; refs.raiseVal.textContent = minTo;
    } else refs.raiseWrap.style.display = 'none';
    refs.allinBtn.style.display = myChips > 0 ? '' : 'none';
    refs.allinBtn.textContent = 'All-in ' + maxTo;
  }

  function updateTimerUI(refs, V) {
    if (!V || V.phase !== 'playing' || V.toAct == null || !V.deadline) { refs.timerWrap.style.visibility = 'hidden'; return; }
    refs.timerWrap.style.visibility = 'visible';
    var rem = Math.max(0, V.deadline - Date.now());
    refs.timerNum.textContent = Math.ceil(rem / 1000) + 's';
    refs.timerBar.style.width = Math.max(0, Math.min(100, rem / TURN_MS * 100)) + '%';
    refs.timerWrap.classList.toggle('low', rem < 6000);
  }

  /* Wartescreen (Multi, < MIN Spieler / vor Init) */
  function buildWaiting(present, onExit) {
    var count = el('div', { class: 'hd-big neon' }, [present + ' / ' + MIN]);
    var msg = el('p', { class: 'hd-sub' }, ['']);
    var root = el('div', { class: 'hd-panel glass' }, [
      el('div', { class: 'hd-wait-icon' }, ['♠']),
      el('h2', { class: 'neon' }, ['Texas Hold’em']), count, msg,
      el('div', { class: 'hd-actions' }, [el('button', { class: 'btn btn-ghost', type: 'button', onclick: onExit }, ['Zurück zur Lobby'])])
    ]);
    return { root: root, count: count, msg: msg };
  }

  /* Game-Over-Overlay (auf den Tisch gelegt) */
  function overlayEnd(refs, title, sub, actions) {
    var old = refs.root.querySelector('.hd-over'); if (old) old.parentNode.removeChild(old);
    var ov = el('div', { class: 'hd-over' }, [
      el('div', { class: 'hd-over-card glass' }, [
        el('div', { class: 'hd-over-emoji' }, ['🏆']),
        el('h2', { class: 'hd-big neon' }, [title]),
        el('p', { class: 'hd-sub' }, [sub]),
        el('div', { class: 'hd-actions' }, actions)
      ])
    ]);
    refs.root.appendChild(ov);
    return ov;
  }
  function removeOverlay(refs) { var old = refs.root.querySelector('.hd-over'); if (old) old.parentNode.removeChild(old); }

  /* ============================================================
   *  SPIEL-MODUL
   * ============================================================ */
  App.Minigames.holdem = {
    id: 'holdem', title: 'Texas Hold’em', icon: '♠️', order: 22,
    subtitle: 'Der Poker-Klassiker — 2 Hole-Cards, 5 Gemeinschaftskarten',
    single: true, multi: true, minPlayers: 2, maxPlayers: 6, group: 'live',

    render: function (root, ctx) {
      var destroyed = false;
      if (ctx.mode === 'multi' && ctx.room) return renderMulti();
      return renderSingle();

      /* ======================= SOLO ======================= */
      function renderSingle() {
        var meId = ctx.me.id, myName = ctx.me.name || 'Du';
        var G = null, refs = null, loop = null, uiT = null, goShown = false;
        var lastCountedHand = -1;   // Bestenliste: je Hand höchstens 1× für MEINEN Sieg

        function poolIds() { return G.allSeats.map(function (s) { return s.id; }).filter(function (id) { return G.chips[id] > 0; }); }
        function meta() { var m = {}; G.allSeats.forEach(function (s) { m[s.id] = { name: s.name, bot: s.bot }; }); return m; }
        var handlers = {
          fold: function () { myAction('fold', 0); },
          checkcall: function (a) { myAction(a, 0); },
          raise: function (v) { myAction('raise', v); },
          allin: function () { myAction('allin', 0); }
        };

        startGame();
        loop = setInterval(tick, 250);
        uiT = setInterval(function () { if (refs && refs._lastV) updateTimerUI(refs, refs._lastV); }, 250);
        return { cleanup: function () { destroyed = true; if (loop) clearInterval(loop); if (uiT) clearInterval(uiT); } };

        function startGame() {
          var all = [{ id: meId, name: myName, bot: false }];
          for (var i = 1; i <= 3; i++) all.push({ id: 'b' + i, name: 'Bot ' + i, bot: true });
          G = { chips: {}, allSeats: all, buttonId: null, handNo: 0 };
          all.forEach(function (s) { G.chips[s.id] = START; });
          refs = buildLayout(ctx.onExit);
          root.innerHTML = ''; root.appendChild(refs.root);
          goShown = false;
          beginHand(G, poolIds(), meta(), Date.now());
          paint();
        }
        function tick() {
          if (destroyed || !G) return;
          var now = Date.now();
          if (G.phase === 'gameover') { if (!goShown) { goShown = true; paint(); showGameOver(); } return; }
          if (G.phase === 'handover') { if (now >= G.handOverAt + HANDOVER_MS) { nextHand(now); paint(); } return; }
          if (G.phase === 'playing') {
            var id = G.toAct; if (id == null) return;
            if (G.botSet[id]) { if (now >= G.toActAt + G.botMs) { var d = botDecide(G, id); doAction(id, d.action, d.amount, now); } }
            else if (now >= G.deadline) { var tc = G.currentBet - (G.bets[id] || 0); doAction(id, tc > 0 ? 'fold' : 'check', 0, now); }
          }
        }
        function nextHand(now) {
          if ((G.chips[meId] || 0) <= 0) { G.phase = 'gameover'; G.result = { winners: [chipLeader()], potWon: 0, reveal: false }; return; }
          var pool = poolIds();
          if (pool.length < 2) { G.phase = 'gameover'; G.result = { winners: [meId], potWon: 0, reveal: false }; return; }
          beginHand(G, pool, meta(), now);
        }
        function chipLeader() { var best = null, bv = -1; G.allSeats.forEach(function (s) { if ((G.chips[s.id] || 0) > bv) { bv = G.chips[s.id] || 0; best = s.id; } }); return best; }
        function doAction(id, action, amount, now) {
          var info = applyAction(G, id, action, amount);
          if (!info) return;
          G.lastAction = { id: id, action: info.action, to: info.to, at: now };
          progress(G, now); paint();
        }
        function myAction(action, amount) {
          if (!G || G.phase !== 'playing' || G.toAct !== meId) return;
          doAction(meId, action, amount, Date.now());
        }
        function paint() { var V = toView(G); renderTable(refs, V, meId, handlers); countMyWin(V); }
        /* Client-seitig aus dem gerenderten Ergebnis zählen: genau 1× pro Hand, nur eigener Sieg. */
        function countMyWin(V) {
          if (V.result && V.result.winners && V.result.winners.indexOf(meId) >= 0 && V.handNo !== lastCountedHand) {
            lastCountedHand = V.handNo;
            if (App.Scores && App.Scores.winCurrent) App.Scores.winCurrent();
          }
        }
        function showGameOver() {
          var iWon = G.result && G.result.winners && G.result.winners.indexOf(meId) >= 0;
          overlayEnd(refs, iWon ? '🏆 Du gewinnst den Tisch!' : '💀 Alle Chips verloren',
            iWon ? 'Du hast alle Gegner ausgenommen!' : 'Der Dschungel war stärker — nächstes Mal!', [
              el('button', { class: 'btn btn-primary btn-lg', type: 'button', onclick: function () { removeOverlay(refs); startGame(); } }, ['Nochmal']),
              el('button', { class: 'btn btn-ghost btn-lg', type: 'button', onclick: ctx.onExit }, ['Zurück'])
            ]);
        }
      }

      /* ======================= MULTI ======================= */
      function renderMulti() {
        var room = ctx.room, me = ctx.me, meId = me.id;
        var lastShared = (room.snapshot() && room.snapshot().shared) || null;
        var refs = null, curView = null, waitRefs = null, uiT = null, loop = null;
        var G = null, appliedSeq = {}, mySeq = 0, overShown = false;
        var lastCountedHand = -1;   // Bestenliste: je Hand höchstens 1× für MEINEN Sieg (dieser Client)

        var handlers = {
          fold: function () { submit('fold', 0); },
          checkcall: function (a) { submit(a, 0); },
          raise: function (v) { submit('raise', v); },
          allin: function () { submit('allin', 0); }
        };
        function submit(action, amount) {
          var sh = lastShared; if (!sh || sh.phase !== 'playing' || sh.toAct !== meId) return;
          if (room.isHost()) { if (G) doHostAction(meId, action, amount, Date.now()); }
          else { mySeq++; room.reportState({ seq: mySeq, action: action, amount: amount || 0 }); if (refs) { refs.actionBar.classList.remove('show'); refs._actSig = 'wait'; } }
        }

        function onShared(sh) { if (destroyed) return; lastShared = sh; sync(); }
        function onPlayers() { if (destroyed) return; sync(); }
        room.on('shared', onShared); room.on('players', onPlayers);
        uiT = setInterval(function () { if (refs && refs._lastV) updateTimerUI(refs, refs._lastV); }, 250);
        loop = setInterval(hostTick, 300);
        sync();

        return {
          cleanup: function () {
            destroyed = true; if (uiT) clearInterval(uiT); if (loop) clearInterval(loop);
            room.off('shared', onShared); room.off('players', onPlayers);
          }
        };

        function pushShared() {
          room.setShared({
            v: (G.v = (G.v || 0) + 1), handNo: G.handNo, seatOrder: G.seatOrder || [], chips: G.chips || {},
            bets: G.bets || {}, committed: G.committed || {}, folded: G.folded || {}, allin: G.allin || {},
            hands: G.hands || {}, community: G.community || [], pot: G.pot || 0, currentBet: G.currentBet || 0,
            minRaise: G.minRaise || BIG_BLIND, button: (G.buttonId != null ? G.buttonId : null),
            toAct: (G.toAct != null ? G.toAct : null), deadline: G.deadline || 0, street: G.street || 'preflop',
            phase: G.phase || 'playing', result: G.result || null, lastAction: G.lastAction || null
          });
        }
        function doHostAction(id, action, amount, now) {
          var info = applyAction(G, id, action, amount); if (!info) return;
          G.lastAction = { id: id, action: info.action, to: info.to, at: now };
          progress(G, now); pushShared();
        }
        function hostStartHandOrOver(now) {
          var players = room.players();
          players.forEach(function (p) { if (G.chips[p.id] == null) G.chips[p.id] = START; });
          if (players.length < MIN) { G.phase = 'waiting'; pushShared(); return; }
          var pool = players.map(function (p) { return p.id; }).filter(function (id) { return G.chips[id] > 0; });
          if (pool.length < 2) {
            G.phase = 'gameover'; G.result = { winners: pool.slice(), potWon: 0, reveal: false };
            if (!G.seatOrder) G.seatOrder = players.map(function (p) { return { id: p.id, name: p.name, bot: false }; });
            pushShared(); return;
          }
          var meta = {}; players.forEach(function (p) { meta[p.id] = { name: p.name, bot: false }; });
          beginHand(G, pool, meta, now);
          players.forEach(function (p) { appliedSeq[p.id] = (p.state && typeof p.state.seq === 'number') ? p.state.seq : 0; });
          pushShared();
        }
        function reconcile(now) {
          if (!G || G.phase !== 'playing') return;
          var present = {}; room.players().forEach(function (p) { present[p.id] = true; });
          var changed = false;
          G.participants.forEach(function (id) { if (!G.folded[id] && !present[id]) { G.folded[id] = true; changed = true; } });
          if (!changed) return;
          var live = G.participants.filter(function (id) { return !G.folded[id]; });
          if (live.length <= 1) { endHandByFold(G, live[0], now); pushShared(); }
          else if (G.folded[G.toAct]) { progress(G, now); pushShared(); }
          else pushShared();
        }
        function processIntents(now) {
          if (!G || G.phase !== 'playing') return;
          room.players().forEach(function (p) {
            var st = p.state; if (!st || typeof st.seq !== 'number') return;
            var base = (appliedSeq[p.id] == null) ? -Infinity : appliedSeq[p.id];
            if (st.seq > base) { appliedSeq[p.id] = st.seq; if (p.id === G.toAct) doHostAction(p.id, st.action, st.amount, now); }
          });
        }
        function hostTick() {
          if (destroyed || !room.isHost() || !G) return;
          var now = Date.now();
          if (G.phase === 'handover') { if (now >= G.handOverAt + HANDOVER_MS) hostStartHandOrOver(now); return; }
          if (G.phase === 'playing') {
            var id = G.toAct; if (id == null) return;
            if (G.botSet[id]) { if (now >= G.toActAt + G.botMs) { var d = botDecide(G, id); doHostAction(id, d.action, d.amount, now); } }
            else if (now >= G.deadline) { var tc = G.currentBet - (G.bets[id] || 0); doHostAction(id, tc > 0 ? 'fold' : 'check', 0, now); }
          }
        }
        function newGame() {
          var players = room.players(); G.chips = {}; players.forEach(function (p) { G.chips[p.id] = START; });
          G.buttonId = null; overShown = false; hostStartHandOrOver(Date.now());
        }

        function sync() {
          var players = room.players(), present = players.length, now = Date.now();
          if (room.isHost()) {
            if (!G && present >= MIN) { G = { chips: {}, buttonId: null, handNo: 0 }; hostStartHandOrOver(now); }
            else if (G) { reconcile(now); processIntents(now); if (G.phase === 'waiting' && present >= MIN) hostStartHandOrOver(now); }
          }
          if (present < MIN) { showWaiting(present); return; }
          var sh = lastShared;
          if (!sh || !sh.seatOrder || !sh.phase || sh.phase === 'waiting') { showWaiting(present, true); return; }
          ensureTable();
          var V = toView(sh);
          renderTable(refs, V, meId, handlers);
          if (V.result && V.result.winners && V.result.winners.indexOf(meId) >= 0 && V.handNo !== lastCountedHand) {
            lastCountedHand = V.handNo;   // client-seitig, genau 1× pro gewonnener Hand
            if (App.Scores && App.Scores.winCurrent) App.Scores.winCurrent();
          }
          if (sh.phase === 'gameover') showGameOverMulti(sh); else if (overShown) { overShown = false; removeOverlay(refs); }
        }
        function ensureTable() {
          if (curView === 'table' && refs) return;
          curView = 'table'; overShown = false;
          refs = buildLayout(ctx.onExit);
          root.innerHTML = ''; root.appendChild(refs.root);
        }
        function showWaiting(present, starting) {
          if (curView !== 'waiting') {
            curView = 'waiting';
            waitRefs = buildWaiting(present, ctx.onExit);
            root.innerHTML = ''; root.appendChild(waitRefs.root);
          }
          waitRefs.count.textContent = present + ' / ' + MIN;
          waitRefs.msg.textContent = starting ? 'Spiel startet gleich …' : 'Warte auf Mitspieler …';
        }
        function showGameOverMulti(sh) {
          if (overShown) return; overShown = true;
          var V = toView(sh), w = (sh.result && sh.result.winners) || [];
          var iWon = w.indexOf(meId) >= 0;
          var actions = room.isHost()
            ? [el('button', { class: 'btn btn-primary btn-lg', type: 'button', onclick: newGame }, ['Neues Spiel']),
               el('button', { class: 'btn btn-ghost btn-lg', type: 'button', onclick: ctx.onExit }, ['Zurück zur Lobby'])]
            : [el('button', { class: 'btn btn-primary btn-lg', type: 'button', onclick: ctx.onExit }, ['Zurück zur Lobby'])];
          var ov = overlayEnd(refs, iWon ? '🏆 Du gewinnst den Tisch!' : ('🏆 ' + (w.length ? nameOf(V, w[0]) : 'Ein Spieler') + ' gewinnt'),
            iWon ? 'Alle Chips gehören dir!' : 'Nächstes Mal bist du dran!', actions);
          if (!room.isHost()) ov.querySelector('.hd-over-card').appendChild(el('p', { class: 'hd-hint' }, ['Der Host kann ein neues Spiel starten.']));
        }
      }
    }
  };

  /* ===================== CSS ===================== */
  function injectStyle() {
    UI.injectStyle('mg-holdem-css', [
      '.hd-wrap{display:flex;flex-direction:column;gap:12px;max-width:720px;margin:0 auto;position:relative;}',
      '.hd-headrow{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}',
      '.hd-back-btn{flex:0 0 auto;}',
      '.hd-top{flex:1;min-width:200px;display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;}',
      '.hd-brand{font-weight:900;font-size:clamp(16px,4.6vw,21px);}',
      '.hd-top-right{display:flex;align-items:center;gap:12px;flex-wrap:wrap;}',
      '.hd-street{font-size:12px;font-weight:800;color:var(--leaf);text-transform:uppercase;letter-spacing:1px;}',
      '.hd-timer{display:flex;align-items:center;gap:6px;font-weight:800;font-size:13px;color:var(--aqua);}',
      '.hd-timer.low{color:var(--danger);}',
      '.hd-timer-bar{width:56px;height:6px;border-radius:999px;background:rgba(6,24,16,.8);border:1px solid var(--stroke);overflow:hidden;}',
      '.hd-timer-fill{height:100%;width:100%;background:linear-gradient(90deg,var(--neon),var(--aqua));transition:width .25s linear;}',
      '.hd-timer.low .hd-timer-fill{background:var(--danger);}',
      '.hd-table{padding:16px;display:flex;flex-direction:column;gap:12px;align-items:center;background:radial-gradient(ellipse at 50% 40%,rgba(9,54,33,.9),rgba(4,16,10,.92));border:1px solid var(--stroke-2);box-shadow:inset 0 0 40px rgba(0,0,0,.45),var(--glow-soft);}',
      '.hd-pot-wrap{display:flex;flex-direction:column;align-items:center;gap:2px;}',
      '.hd-pot-l{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;font-weight:800;}',
      '.hd-pot{font-size:clamp(18px,5vw,26px);font-weight:900;color:var(--gold);text-shadow:0 0 14px rgba(255,210,63,.45);font-variant-numeric:tabular-nums;}',
      '.hd-community{display:flex;gap:8px;justify-content:center;}',
      '.hd-card{width:clamp(30px,8.6vw,44px);height:clamp(42px,12vw,62px);border-radius:7px;display:flex;flex-direction:column;align-items:center;justify-content:center;font-weight:900;line-height:1.05;background:#f6fff9;box-shadow:0 2px 6px rgba(0,0,0,.4);border:1px solid rgba(0,0,0,.25);position:relative;flex:0 0 auto;}',
      '.hd-card-lg{width:clamp(38px,10vw,54px);height:clamp(54px,14vw,76px);border-radius:9px;}',
      '.hd-up.hd-red{color:#d81f4a;}',
      '.hd-up.hd-black{color:#0c1a12;}',
      '.hd-r{font-size:clamp(14px,3.8vw,20px);}',
      '.hd-s{font-size:clamp(12px,3.2vw,17px);}',
      '.hd-back{background:repeating-linear-gradient(45deg,#0a2a1b,#0a2a1b 5px,#0e3a25 5px,#0e3a25 10px);border:1px solid var(--stroke-2);box-shadow:inset 0 0 8px rgba(57,255,20,.25),0 2px 6px rgba(0,0,0,.4);}',
      '.hd-back::after{content:"♠";position:absolute;color:rgba(57,255,20,.3);font-size:16px;}',
      '.hd-empty{background:rgba(6,24,16,.5);border:1.5px dashed var(--stroke);box-shadow:none;}',
      '.hd-myhand{text-align:center;font-weight:800;font-size:14px;color:var(--aqua-soft);min-height:18px;}',
      '.hd-seats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;}',
      '.hd-seat{position:relative;padding:10px;border-radius:14px;background:rgba(9,32,21,.6);border:1px solid var(--stroke);display:flex;flex-direction:column;gap:6px;transition:border-color .2s,box-shadow .2s,opacity .2s;}',
      '.hd-seat.me{border-color:var(--stroke-2);box-shadow:var(--glow-soft);}',
      '.hd-seat.active{border-color:var(--neon);box-shadow:0 0 0 1px var(--neon),0 0 18px rgba(57,255,20,.4);}',
      '.hd-seat.folded{opacity:.45;}',
      '.hd-seat.allin{border-color:var(--gold);}',
      '.hd-seat.winner{border-color:var(--gold);box-shadow:0 0 22px rgba(255,210,63,.55);animation:hd-win 1s ease-in-out infinite;}',
      '@keyframes hd-win{0%,100%{box-shadow:0 0 16px rgba(255,210,63,.4);}50%{box-shadow:0 0 30px rgba(255,210,63,.85);}}',
      '.hd-seat-top{display:flex;align-items:center;gap:8px;}',
      '.hd-seat-cards{display:flex;gap:5px;flex:1;}',
      '.hd-dealer{width:22px;height:22px;flex:0 0 auto;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:900;color:#04160c;background:linear-gradient(180deg,#fff,var(--gold));box-shadow:0 0 10px rgba(255,210,63,.5);}',
      '.hd-seat-badge{font-size:10px;font-weight:900;text-transform:uppercase;letter-spacing:1px;color:var(--muted);min-width:34px;text-align:right;}',
      '.hd-seat-badge.allin{color:var(--gold);}',
      '.hd-seat-badge.fold{color:var(--danger);}',
      '.hd-seat-info{display:flex;justify-content:space-between;align-items:baseline;gap:8px;}',
      '.hd-seat-name{font-weight:800;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.hd-seat-chips{font-weight:900;color:var(--leaf);font-size:13px;font-variant-numeric:tabular-nums;flex:0 0 auto;}',
      '.hd-seat-tag{display:none;font-size:11px;font-weight:800;color:var(--gold);}',
      '.hd-seat-tag.show{display:block;}',
      '.hd-seat-bet{display:none;align-self:flex-start;font-size:11px;font-weight:800;color:var(--aqua);padding:2px 8px;border-radius:999px;background:rgba(4,16,10,.7);border:1px solid var(--stroke);font-variant-numeric:tabular-nums;}',
      '.hd-seat-bet.show{display:inline-block;}',
      '.hd-lastact{text-align:center;font-size:12px;color:var(--muted);font-weight:700;min-height:15px;}',
      '.hd-status{text-align:center;font-weight:900;font-size:clamp(15px,4.2vw,19px);min-height:24px;}',
      '.hd-status.you{color:var(--neon);text-shadow:0 0 10px rgba(57,255,20,.4);}',
      '.hd-status.opp{color:var(--aqua);}',
      '.hd-status.win{color:var(--gold);text-shadow:0 0 12px rgba(255,210,63,.5);}',
      '.hd-actionbar{display:none;flex-direction:column;gap:10px;padding:12px;border-radius:14px;background:rgba(6,24,16,.85);border:1px solid var(--stroke-2);box-shadow:var(--glow-soft);position:sticky;bottom:8px;}',
      '.hd-actionbar.show{display:flex;}',
      '.hd-abtns{display:flex;gap:8px;flex-wrap:wrap;}',
      '.hd-abtn{flex:1;min-width:88px;font-weight:900;}',
      '.hd-fold{background:rgba(40,10,16,.7);border-color:rgba(255,77,109,.4);color:var(--danger-2);}',
      '.hd-raise-wrap{display:flex;flex-direction:column;gap:6px;}',
      '.hd-raise-top{display:flex;justify-content:space-between;align-items:center;font-size:12px;font-weight:800;color:var(--leaf);text-transform:uppercase;letter-spacing:1px;}',
      '.hd-raise-val{color:var(--gold);font-size:16px;font-variant-numeric:tabular-nums;}',
      '.hd-raise-row{display:flex;gap:8px;align-items:center;}',
      '.hd-raise-range{flex:1;accent-color:var(--neon);height:26px;}',
      '.hd-raise-row .hd-raise{flex:0 0 auto;min-width:96px;}',
      '.hd-panel{padding:28px 22px;text-align:center;display:flex;flex-direction:column;gap:14px;align-items:center;max-width:460px;margin:0 auto;}',
      '.hd-wait-icon{font-size:48px;animation:hd-bob 2.2s ease-in-out infinite;filter:drop-shadow(0 0 10px rgba(57,255,20,.4));}',
      '@keyframes hd-bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-6px)}}',
      '.hd-big{font-size:clamp(22px,7vw,34px);font-weight:900;line-height:1.15;margin:0;}',
      '.hd-sub{color:var(--muted);margin:0;}',
      '.hd-actions{display:flex;gap:10px;justify-content:center;flex-wrap:wrap;margin-top:4px;}',
      '.hd-hint{color:var(--muted);font-size:12px;margin:6px 0 0;}',
      '.hd-over{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(2,10,6,.78);backdrop-filter:blur(3px);border-radius:14px;z-index:20;animation:hd-fade .2s ease;}',
      '@keyframes hd-fade{from{opacity:0}to{opacity:1}}',
      '.hd-over-card{padding:26px 22px;text-align:center;display:flex;flex-direction:column;gap:12px;align-items:center;max-width:88%;}',
      '.hd-over-emoji{font-size:52px;filter:drop-shadow(0 0 14px rgba(255,210,63,.5));}'
    ].join(''));
  }
})();
