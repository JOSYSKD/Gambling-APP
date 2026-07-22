/* stocks.js — Aktienmarkt  (App.Stocks)
 *
 * 20 Aktien, Kurse zwischen 100 und 1.000. Alle 10 Sekunden ein neuer Tick:
 * der Kurs steigt, fällt oder bleibt gleich.
 *
 * Kernidee — der Markt braucht KEINEN Server: der Kurs ist eine reine Funktion
 * aus (Aktie, Tick-Nummer), wobei die Tick-Nummer = floor(Zeit / 10s) ist.
 * Daraus folgt alles Angenehme von selbst:
 *   - Alle Spieler sehen zur selben Zeit denselben Kurs (gleiche Formel).
 *   - Der Markt läuft weiter, während die Seite zu ist.
 *   - Die komplette Kurshistorie für den Chart ist jederzeit sofort berechenbar,
 *     ohne dass irgendetwas gespeichert werden müsste.
 * Gespeichert wird nur das Depot des Spielers (welche Aktie, wie viele, zu
 * welchem Einstand) — pro Modus getrennt, siehe js/mode.js: im Casino kauft man
 * mit Silber, im Survival-Modus mit Gold.
 *
 * Kursverlauf = überlagertes Wertrauschen (fbm) in mehreren Frequenzen: langsame
 * Trends + mittlere Wellen + kurzes Zappeln, durch eine Sigmoid-Kurve sauber in
 * das Kursband [lo, hi] der jeweiligen Aktie gedrückt (läuft also nie aus dem
 * Band heraus und klebt trotzdem nicht an den Rändern).
 */
(function () {
  'use strict';
  window.App = window.App || {};
  var UI = App.UI, el = UI.el;

  var TICK_MS = 10000;          // 10 Sekunden pro Tick
  var KEY = 'gj_stocks';
  var FLAT_CHANCE = 0.14;       // ~14% der Ticks bleiben unverändert
  var MAX_FLAT_RUN = 6;         // …aber höchstens 6 Ticks am Stück
  var HISTORY = 70;             // Ticks im großen Chart (~12 Minuten)
  var SPARK = 24;               // Ticks in der Mini-Kurve

  /* ---------------- Markt-Definition ---------------- */
  // lo/hi = Kursband der Aktie (immer innerhalb 100–1.000). Ein breites Band
  // bedeutet eine volatile Aktie, ein schmales eine ruhige.
  var STOCKS = [
    { id: 'NEON', name: 'Neon Jungle Corp', icon: '🌴', lo: 180, hi: 920 },
    { id: 'BNNA', name: 'Banana Bank', icon: '🍌', lo: 100, hi: 260 },
    { id: 'VINE', name: 'VineTech', icon: '🌿', lo: 300, hi: 620 },
    { id: 'GLOW', name: 'Glowworm Energy', icon: '✨', lo: 420, hi: 780 },
    { id: 'TIGR', name: 'Tiger Motors', icon: '🐯', lo: 600, hi: 990 },
    { id: 'PALM', name: 'Palm Öl AG', icon: '🌴', lo: 130, hi: 340 },
    { id: 'MNKY', name: 'Monkey Media', icon: '🐒', lo: 200, hi: 560 },
    { id: 'CRCO', name: 'Croco Steel', icon: '🐊', lo: 480, hi: 700 },
    { id: 'TOUC', name: 'Toucan Airlines', icon: '🦜', lo: 150, hi: 430 },
    { id: 'ORCH', name: 'Orchid Pharma', icon: '🌺', lo: 640, hi: 980 },
    { id: 'AMBR', name: 'Amber Mining', icon: '🟠', lo: 110, hi: 900 },
    { id: 'RIVR', name: 'River Logistics', icon: '🚤', lo: 350, hi: 520 },
    { id: 'THND', name: 'Thunder Power', icon: '⚡', lo: 500, hi: 860 },
    { id: 'JAGR', name: 'Jaguar Systems', icon: '🐆', lo: 700, hi: 1000 },
    { id: 'FERN', name: 'Fern Foods', icon: '🍃', lo: 240, hi: 390 },
    { id: 'COBR', name: 'Cobra Security', icon: '🐍', lo: 400, hi: 660 },
    { id: 'LOTO', name: 'Lotus Robotics', icon: '🤖', lo: 560, hi: 940 },
    { id: 'MOSS', name: 'Moss Materials', icon: '🪨', lo: 120, hi: 230 },
    { id: 'PRRT', name: 'Parrot Telecom', icon: '🦩', lo: 280, hi: 740 },
    { id: 'LIAN', name: 'Liane Baustoffe', icon: '🪵', lo: 460, hi: 610 }
  ];
  STOCKS.forEach(function (s, i) { s.seed = (i + 1) * 7919 + 13; });

  function byId(id) {
    for (var i = 0; i < STOCKS.length; i++) if (STOCKS[i].id === id) return STOCKS[i];
    return null;
  }

  /* ---------------- Kurs-Mathematik ---------------- */
  function tickNow() { return Math.floor(Date.now() / TICK_MS); }
  function msIntoTick() { return Date.now() % TICK_MS; }

  /** Deterministischer Hash zweier Zahlen -> 0..1 (immer dasselbe Ergebnis). */
  function hash(a, b) {
    var h = (2166136261 ^ a) >>> 0;
    h = Math.imul(h ^ (b & 0xffff), 16777619);
    h = Math.imul(h ^ (b >>> 16), 16777619);
    h ^= h >>> 13; h = Math.imul(h, 0x5bd1e995); h ^= h >>> 15;
    return (h >>> 0) / 4294967296;
  }

  /** Wertrauschen: weich interpoliert zwischen zwei Stützstellen im Abstand `scale`. */
  function noise(seed, t, scale) {
    var x = t / scale, i = Math.floor(x), f = x - i;
    var a = hash(seed, i), b = hash(seed, i + 1);
    var u = f * f * (3 - 2 * f);          // Smoothstep -> keine Knicke im Chart
    return a + (b - a) * u;
  }

  /** Mehrere Frequenzen übereinander: Trend + Welle + Zappeln.
   *  Bewusst HOCHVOLATIL abgestimmt — kräftigere schnelle Oktaven + eine
   *  zusätzliche ganz schnelle (Skala 2,2) lassen die Kurse pro Tick viel
   *  extremer steigen/fallen (Ø ~2,5 % statt 0,5 %, Einzelsprünge bis ~120 %).
   *  Bleibt trotzdem durch die Sigmoid (rawPrice) IMMER im Band [lo,hi]. */
  function fbm(seed, t) {
    return (noise(seed, t, 240) - 0.5) * 1.0
      + (noise(seed + 1, t, 50) - 0.5) * 0.9
      + (noise(seed + 2, t, 13) - 0.5) * 0.6
      + (noise(seed + 3, t, 4.5) - 0.5) * 0.38
      + (noise(seed + 4, t, 2.2) - 0.5) * 0.2;
  }

  function rawPrice(st, t) {
    // Steilere Sigmoid (5,0 statt 3,2) drückt den Kurs härter an die Bandränder,
    // damit die Ausschläge extrem, aber nie außerhalb [lo,hi] sind.
    var u = 1 / (1 + Math.exp(-5.0 * fbm(st.seed, t)));   // 0..1, ohne harte Grenzen
    return st.lo + (st.hi - st.lo) * u;
  }

  /** Kurs der Aktie beim Tick t. Manche Ticks bleiben bewusst unverändert. */
  function priceAt(st, t) {
    var runs = 0;
    while (runs < MAX_FLAT_RUN && hash(st.seed + 991, t) < FLAT_CHANCE) { t -= 1; runs++; }
    return Math.round(rawPrice(st, t) * 100) / 100;
  }

  function priceOf(id, t) {
    var st = typeof id === 'string' ? byId(id) : id;
    if (!st) return 0;
    return priceAt(st, t == null ? tickNow() : t);
  }

  /** Kurse der letzten `n` Ticks (ältester zuerst), inklusive aktuellem. */
  function history(id, n) {
    var st = typeof id === 'string' ? byId(id) : id;
    var t = tickNow(), out = [];
    for (var i = n - 1; i >= 0; i--) out.push(priceAt(st, t - i));
    return out;
  }

  /** Veränderung zum vorherigen Tick: { abs, pct, dir: 1|0|-1 } */
  function change(id) {
    var t = tickNow(), st = typeof id === 'string' ? byId(id) : id;
    var now = priceAt(st, t), prev = priceAt(st, t - 1);
    var abs = Math.round((now - prev) * 100) / 100;
    return { abs: abs, pct: prev ? (abs / prev) * 100 : 0, dir: abs > 0 ? 1 : (abs < 0 ? -1 : 0) };
  }

  /* ---------------- Depot ---------------- */
  var state = load();
  function load() {
    var s = App.Storage ? App.Storage.get(KEY, null) : null;
    if (!s || typeof s !== 'object') s = {};
    if (!s.holdings || typeof s.holdings !== 'object') s.holdings = {};
    return s;
  }
  function save() { if (App.Storage) App.Storage.set(KEY, state); }

  var listeners = [];
  function onChange(cb) {
    listeners.push(cb);
    return function () { var i = listeners.indexOf(cb); if (i >= 0) listeners.splice(i, 1); };
  }
  function emit() { for (var i = 0; i < listeners.length; i++) { try { listeners[i](); } catch (e) {} } }

  function sharesOf(id) { var h = state.holdings[id]; return h ? h.shares : 0; }

  /** Depotwert eines beliebigen (auch fremden) Depot-Zustands — für den Survival-Score. */
  function valueOf(s) {
    if (!s || !s.holdings) return 0;
    var t = tickNow(), total = 0;
    Object.keys(s.holdings).forEach(function (id) {
      var st = byId(id), h = s.holdings[id];
      if (st && h && h.shares > 0) total += priceAt(st, t) * h.shares;
    });
    return Math.round(total);
  }
  function portfolioValue() { return valueOf(state); }
  function investedTotal() {
    var total = 0;
    Object.keys(state.holdings).forEach(function (id) { total += state.holdings[id].cost || 0; });
    return total;
  }

  /** Wie viele Aktien man sich vom aktuellen Guthaben leisten kann. */
  function maxBuyable(id) {
    var p = priceOf(id);
    return p > 0 ? Math.floor(App.Coins.get() / p) : 0;
  }

  function buy(id, qty) {
    var st = byId(id);
    if (!st) return 0;
    var p = priceOf(id);
    qty = Math.min(Math.floor(Number(qty) || 0), maxBuyable(id));
    if (qty <= 0) return 0;
    var cost = Math.round(p * qty);
    if (cost > App.Coins.get()) return 0;
    App.Coins.addRaw(-cost);
    var h = state.holdings[id] || (state.holdings[id] = { shares: 0, cost: 0 });
    h.shares += qty;
    h.cost += cost;
    save(); emit();
    return { qty: qty, cost: cost };
  }

  function sell(id, qty) {
    var h = state.holdings[id];
    if (!h || h.shares <= 0) return 0;
    qty = Math.min(Math.floor(Number(qty) || 0), h.shares);
    if (qty <= 0) return 0;
    var proceeds = Math.round(priceOf(id) * qty);
    var costPart = Math.round(h.cost * (qty / h.shares));
    h.shares -= qty;
    h.cost -= costPart;
    if (h.shares <= 0) delete state.holdings[id];
    App.Coins.addRaw(proceeds);
    save(); emit();
    return { qty: qty, proceeds: proceeds, profit: proceeds - costPart };
  }

  /* ---------------- Chart-Zeichnung ---------------- */
  function drawChart(canvas, data, opts) {
    opts = opts || {};
    var dpr = window.devicePixelRatio || 1;
    var w = canvas.clientWidth || 300, h = canvas.clientHeight || 120;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    var c = canvas.getContext('2d');
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, w, h);
    if (!data.length) return;

    var pad = opts.pad || 0;
    var min = Math.min.apply(null, data), max = Math.max.apply(null, data);
    if (max - min < 0.5) { max += 0.5; min -= 0.5; }   // waagerechte Linie mittig halten
    var span = max - min;
    var x = function (i) { return pad + (i / (data.length - 1 || 1)) * (w - pad * 2); };
    var y = function (v) { return pad + (1 - (v - min) / span) * (h - pad * 2); };

    var up = data[data.length - 1] >= data[0];
    var line = up ? '#39ff14' : '#ff4d6d';

    if (opts.grid) {
      c.strokeStyle = 'rgba(255,255,255,0.07)';
      c.lineWidth = 1;
      for (var g = 0; g <= 4; g++) {
        var gy = pad + (g / 4) * (h - pad * 2);
        c.beginPath(); c.moveTo(pad, gy); c.lineTo(w - pad, gy); c.stroke();
      }
    }

    // Fläche unter der Kurve
    var grad = c.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, up ? 'rgba(57,255,20,0.28)' : 'rgba(255,77,109,0.28)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    c.beginPath();
    c.moveTo(x(0), y(data[0]));
    for (var i = 1; i < data.length; i++) c.lineTo(x(i), y(data[i]));
    c.lineTo(x(data.length - 1), h - pad);
    c.lineTo(x(0), h - pad);
    c.closePath();
    c.fillStyle = grad;
    c.fill();

    // Kurve
    c.beginPath();
    c.moveTo(x(0), y(data[0]));
    for (var j = 1; j < data.length; j++) c.lineTo(x(j), y(data[j]));
    c.strokeStyle = line;
    c.lineWidth = opts.thin ? 1.5 : 2.2;
    c.lineJoin = 'round';
    c.shadowColor = line;
    c.shadowBlur = opts.thin ? 4 : 8;
    c.stroke();
    c.shadowBlur = 0;

    // Punkt auf dem aktuellen Kurs
    if (!opts.thin) {
      var lx = x(data.length - 1), ly = y(data[data.length - 1]);
      c.beginPath(); c.arc(lx, ly, 3.5, 0, Math.PI * 2);
      c.fillStyle = line; c.fill();
      c.beginPath(); c.arc(lx, ly, 7, 0, Math.PI * 2);
      c.strokeStyle = line; c.globalAlpha = 0.4; c.lineWidth = 1.5; c.stroke();
      c.globalAlpha = 1;
    }
  }

  /* ---------------- Ansicht ---------------- */
  var QTYS = [1, 10, 100, 1000];

  function money(n) { return UI.formatCoins(Math.round(n)) + ' ' + UI.coinIcon(); }
  function price2(n) { return Number(n).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function pctTxt(p) { return (p > 0 ? '+' : '') + p.toFixed(2).replace('.', ',') + ' %'; }
  function dirClass(d) { return d > 0 ? 'up' : (d < 0 ? 'down' : 'flat'); }
  function dirArrow(d) { return d > 0 ? '▲' : (d < 0 ? '▼' : '■'); }

  function renderPage(root) {
    injectCss();
    var selected = null;                 // null = Marktübersicht, sonst Aktien-ID
    var lastTick = tickNow();
    var body = el('div', { class: 'stk-body' });

    var head = el('div', { class: 'page-head' }, [
      el('button', { class: 'btn btn-ghost back', type: 'button', onclick: function () {
        App.Router.go(App.Mode.is('survival') ? '/survival' : '/');
      } }, ['← ' + (App.Mode.is('survival') ? 'Survival' : 'Menü')]),
      el('h2', { class: 'page-title neon' }, ['📈 Aktien'])
    ]);

    /* --- Kopfzeile: Bargeld, Depot, Gewinn/Verlust, nächster Tick --- */
    var sumCash = el('span', { class: 'stk-sum-v' }),
      sumDepot = el('span', { class: 'stk-sum-v' }),
      sumTotal = el('span', { class: 'stk-sum-v gold' }),
      sumPl = el('span', { class: 'stk-sum-v' }),
      tickFill = el('div', { class: 'stk-tick-fill' }),
      tickTxt = el('span', { class: 'stk-tick-txt' });

    var summary = el('div', { class: 'stk-summary glass' }, [
      el('div', { class: 'stk-sum' }, [el('span', { class: 'stk-sum-l' }, ['Bargeld']), sumCash]),
      el('div', { class: 'stk-sum' }, [el('span', { class: 'stk-sum-l' }, ['Depotwert']), sumDepot]),
      el('div', { class: 'stk-sum' }, [el('span', { class: 'stk-sum-l' }, ['Gesamt']), sumTotal]),
      el('div', { class: 'stk-sum' }, [el('span', { class: 'stk-sum-l' }, ['Gewinn/Verlust']), sumPl]),
      el('div', { class: 'stk-tick' }, [
        el('div', { class: 'stk-tick-bar' }, [tickFill]), tickTxt
      ])
    ]);

    function updateSummary() {
      var depot = portfolioValue(), invested = investedTotal();
      var pl = depot - invested;
      sumCash.textContent = money(App.Coins.get());
      sumDepot.textContent = money(depot);
      sumTotal.textContent = money(App.Coins.get() + depot);
      sumPl.textContent = (pl > 0 ? '+' : '') + money(pl);
      sumPl.className = 'stk-sum-v ' + dirClass(pl);
    }
    function updateTick() {
      var into = msIntoTick();
      tickFill.style.width = Math.round((into / TICK_MS) * 100) + '%';
      tickTxt.textContent = 'Nächster Kurs in ' + Math.max(0, Math.ceil((TICK_MS - into) / 1000)) + 's';
    }

    /* --- Marktübersicht: alle 20 Aktien --- */
    function renderMarket() {
      body.innerHTML = '';
      var grid = el('div', { class: 'stk-grid' });
      STOCKS.forEach(function (st) {
        var ch = change(st.id), p = priceOf(st.id), owned = sharesOf(st.id);
        var canvas = el('canvas', { class: 'stk-spark' });
        var card = el('button', { class: 'stk-card glass', type: 'button', onclick: function () { selected = st.id; render(); } }, [
          el('div', { class: 'stk-card-top' }, [
            el('span', { class: 'stk-ic' }, [st.icon]),
            el('span', { class: 'stk-sym' }, [st.id]),
            owned ? el('span', { class: 'stk-owned' }, [owned + '×']) : null
          ]),
          el('div', { class: 'stk-name' }, [st.name]),
          canvas,
          el('div', { class: 'stk-card-bot' }, [
            el('span', { class: 'stk-price' }, [price2(p)]),
            el('span', { class: 'stk-chg ' + dirClass(ch.dir) }, [dirArrow(ch.dir) + ' ' + pctTxt(ch.pct)])
          ])
        ]);
        grid.appendChild(card);
        // Canvas braucht seine Layout-Größe, daher erst nach dem Einhängen zeichnen.
        setTimeout(function () { drawChart(canvas, history(st.id, SPARK), { thin: true, pad: 2 }); }, 0);
      });
      body.appendChild(grid);
      body.appendChild(el('p', { class: 'stk-hint' }, [
        'Alle 10 Sekunden ein neuer Kurs — er steigt, fällt oder bleibt gleich. ' +
        'Die Kurse laufen für alle Spieler gleich und auch dann weiter, wenn du nicht da bist. ' +
        'Bezahlt wird mit ' + App.Mode.coinName() + '.'
      ]));
    }

    /* --- Detail: großer Chart + Kaufen/Verkaufen --- */
    function renderDetail() {
      var st = byId(selected);
      if (!st) { selected = null; renderMarket(); return; }
      body.innerHTML = '';

      var canvas = el('canvas', { class: 'stk-chart' });
      var ch = change(st.id), p = priceOf(st.id);
      var hold = state.holdings[st.id];
      var avg = hold && hold.shares ? hold.cost / hold.shares : 0;
      var plNow = hold ? Math.round(p * hold.shares) - hold.cost : 0;

      var priceEl = el('span', { class: 'stk-d-price' }, [price2(p)]);
      var chgEl = el('span', { class: 'stk-chg big ' + dirClass(ch.dir) }, [
        dirArrow(ch.dir) + ' ' + price2(Math.abs(ch.abs)) + ' (' + pctTxt(ch.pct) + ')'
      ]);

      var maxBuy = maxBuyable(st.id);
      var infoTxt = el('div', { class: 'stk-trade-info' }, [
        '1 Aktie = ' + price2(p) + ' ' + UI.coinIcon() + ' · du kannst max. ' + UI.formatCoins(maxBuy) + ' kaufen'
      ]);

      function tradeRow(kind) {
        var isBuy = kind === 'buy';
        var btns = QTYS.map(function (q) {
          var affordable = isBuy ? q <= maxBuy : q <= sharesOf(st.id);
          return el('button', {
            class: 'btn ' + (isBuy ? 'btn-primary' : 'btn-aqua') + ' stk-qty',
            type: 'button', disabled: !affordable || null,
            onclick: function () { doTrade(kind, q); }
          }, [String(q)]);
        });
        var maxN = isBuy ? maxBuy : sharesOf(st.id);
        var quarterN = Math.floor(maxN / 4);   // ¼ der maximal möglichen Menge
        btns.push(el('button', {
          class: 'btn ' + (isBuy ? 'btn-primary' : 'btn-aqua') + ' stk-qty stk-qty-max',
          type: 'button', disabled: quarterN <= 0 || null,
          onclick: function () { doTrade(kind, quarterN); }
        }, ['¼']));
        btns.push(el('button', {
          class: 'btn ' + (isBuy ? 'btn-primary' : 'btn-aqua') + ' stk-qty stk-qty-max',
          type: 'button', disabled: maxN <= 0 || null,
          onclick: function () { doTrade(kind, maxN); }
        }, ['MAX']));
        return el('div', { class: 'stk-trade-row' }, [
          el('span', { class: 'stk-trade-l' }, [isBuy ? '🛒 Kaufen' : '💰 Verkaufen']),
          el('div', { class: 'stk-qtys' }, btns)
        ]);
      }

      function doTrade(kind, qty) {
        var r = kind === 'buy' ? buy(st.id, qty) : sell(st.id, qty);
        if (!r || !r.qty) {
          UI.toast(kind === 'buy' ? 'Dafür reicht dein Guthaben nicht.' : 'Du hast keine Aktien davon.', 'lose');
          return;
        }
        if (kind === 'buy') {
          UI.flashRaw(-r.cost);
          UI.toast(r.qty + '× ' + st.id + ' gekauft für ' + money(r.cost), 'info');
        } else {
          UI.flashRaw(r.proceeds);
          UI.toast(r.qty + '× ' + st.id + ' verkauft · ' + (r.profit >= 0 ? 'Gewinn ' : 'Verlust ') + money(Math.abs(r.profit)),
            r.profit >= 0 ? 'win' : 'lose');
        }
        if (App.Audio) App.Audio.sfx(kind === 'buy' ? 'click' : 'coin');
        renderDetail();
        updateSummary();
      }

      body.appendChild(el('div', { class: 'stk-detail glass' }, [
        el('div', { class: 'stk-d-head' }, [
          el('button', { class: 'btn btn-ghost', type: 'button', onclick: function () { selected = null; render(); } }, ['← Markt']),
          el('span', { class: 'stk-ic big' }, [st.icon]),
          el('div', { class: 'stk-d-title' }, [
            el('div', { class: 'stk-d-sym neon' }, [st.id]),
            el('div', { class: 'stk-d-name' }, [st.name])
          ]),
          el('div', { class: 'stk-d-right' }, [priceEl, chgEl])
        ]),
        canvas,
        el('div', { class: 'stk-d-stats' }, [
          dStat('Im Depot', hold ? UI.formatCoins(hold.shares) + ' Aktien' : '—'),
          dStat('Einstand ⌀', avg ? price2(avg) + ' ' + UI.coinIcon() : '—'),
          dStat('Depotwert', hold ? money(p * hold.shares) : '—'),
          dStat('G/V', hold ? (plNow >= 0 ? '+' : '') + money(plNow) : '—', hold ? dirClass(plNow) : '')
        ]),
        infoTxt,
        tradeRow('buy'),
        tradeRow('sell'),
        el('div', { class: 'stk-band' }, ['Kursband dieser Aktie: ' + st.lo + ' – ' + st.hi + ' ' + UI.coinIcon()])
      ]));
      setTimeout(function () { drawChart(canvas, history(st.id, HISTORY), { grid: true, pad: 6 }); }, 0);
    }

    function dStat(label, val, cls) {
      return el('div', { class: 'stk-d-stat' }, [
        el('span', { class: 'stk-d-stat-l' }, [label]),
        el('span', { class: 'stk-d-stat-v ' + (cls || '') }, [val])
      ]);
    }

    function render() {
      if (selected) renderDetail(); else renderMarket();
      updateSummary();
    }

    root.appendChild(el('div', { class: 'stk-page' }, [head, summary, body]));
    render();
    updateTick();

    // Sekundentakt für den Countdown; beim Tickwechsel Kurse neu zeichnen.
    var timer = setInterval(function () {
      updateTick();
      var t = tickNow();
      if (t !== lastTick) { lastTick = t; render(); }
    }, 500);
    var offCoins = App.Coins.onChange(updateSummary);
    return function () { clearInterval(timer); offCoins(); };
  }

  /* ---------------- CSS ---------------- */
  var cssDone = false;
  function injectCss() {
    if (cssDone) return; cssDone = true;
    UI.injectStyle('stocks-css', [
      '.stk-page{display:flex;flex-direction:column;gap:14px;max-width:1000px;margin:0 auto;}',
      '.stk-summary{display:flex;flex-wrap:wrap;gap:10px 26px;align-items:center;padding:14px 16px;}',
      '.stk-sum{display:flex;flex-direction:column;gap:2px;}',
      '.stk-sum-l{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.8px;font-weight:800;}',
      '.stk-sum-v{font-size:18px;font-weight:900;font-variant-numeric:tabular-nums;}',
      '.stk-sum-v.gold{color:var(--gold);}',
      '.stk-sum-v.up{color:var(--neon);}',
      '.stk-sum-v.down{color:var(--danger-2,#ff4d6d);}',
      '.stk-tick{margin-left:auto;display:flex;flex-direction:column;gap:4px;min-width:150px;}',
      '.stk-tick-bar{height:7px;border-radius:99px;background:rgba(255,255,255,.12);overflow:hidden;}',
      '.stk-tick-fill{height:100%;width:0;background:linear-gradient(90deg,var(--aqua),var(--neon));transition:width .5s linear;}',
      '.stk-tick-txt{font-size:11px;color:var(--muted);font-weight:800;text-align:right;font-variant-numeric:tabular-nums;}',
      '.stk-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:10px;}',
      '.stk-card{padding:12px;display:flex;flex-direction:column;gap:6px;cursor:pointer;text-align:left;border-radius:14px;transition:.15s;}',
      '.stk-card:hover{transform:translateY(-2px);border-color:var(--neon);box-shadow:0 0 0 1px rgba(57,255,20,.3);}',
      '.stk-card-top{display:flex;align-items:center;gap:7px;}',
      '.stk-ic{font-size:20px;}',
      '.stk-ic.big{font-size:34px;}',
      '.stk-sym{font-weight:900;letter-spacing:1px;color:var(--text);}',
      '.stk-owned{margin-left:auto;font-size:11px;font-weight:900;color:#04160c;background:var(--gold);border-radius:99px;padding:2px 7px;}',
      '.stk-name{font-size:11px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      '.stk-spark{width:100%;height:46px;display:block;}',
      '.stk-card-bot{display:flex;align-items:baseline;justify-content:space-between;gap:6px;}',
      '.stk-price{font-size:17px;font-weight:900;font-variant-numeric:tabular-nums;}',
      '.stk-chg{font-size:11px;font-weight:900;font-variant-numeric:tabular-nums;white-space:nowrap;}',
      '.stk-chg.big{font-size:14px;}',
      '.stk-chg.up,.stk-d-stat-v.up{color:var(--neon,#39ff14);text-shadow:0 0 8px rgba(57,255,20,.6);}',
      '.stk-chg.down,.stk-d-stat-v.down{color:var(--danger-2,#ff4d6d);text-shadow:0 0 8px rgba(255,77,109,.5);}',
      '.stk-chg.flat{color:var(--muted);}',
      '.stk-hint{color:var(--muted);font-size:12px;text-align:center;line-height:1.5;margin:2px 0 0;}',
      '.stk-detail{padding:16px;display:flex;flex-direction:column;gap:14px;}',
      '.stk-d-head{display:flex;align-items:center;gap:12px;flex-wrap:wrap;}',
      '.stk-d-title{flex:1;min-width:80px;}',
      '.stk-d-sym{font-size:20px;font-weight:900;letter-spacing:1px;}',
      '.stk-d-name{font-size:12px;color:var(--muted);}',
      '.stk-d-right{text-align:right;display:flex;flex-direction:column;gap:2px;}',
      '.stk-d-price{font-size:26px;font-weight:900;color:var(--gold);font-variant-numeric:tabular-nums;}',
      '.stk-chart{width:100%;height:200px;display:block;border-radius:12px;background:rgba(0,0,0,.18);}',
      '.stk-d-stats{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;}',
      '@media(max-width:560px){.stk-d-stats{grid-template-columns:repeat(2,1fr);}}',
      '.stk-d-stat{display:flex;flex-direction:column;gap:2px;background:rgba(0,0,0,.2);border-radius:10px;padding:8px 10px;}',
      '.stk-d-stat-l{font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.7px;font-weight:800;}',
      '.stk-d-stat-v{font-weight:900;font-variant-numeric:tabular-nums;font-size:14px;}',
      '.stk-trade-info{font-size:12px;color:var(--muted);text-align:center;font-weight:700;}',
      '.stk-trade-row{display:flex;align-items:center;gap:12px;flex-wrap:wrap;}',
      '.stk-trade-l{font-weight:900;min-width:110px;}',
      '.stk-qtys{display:flex;gap:8px;flex:1;flex-wrap:wrap;}',
      '.stk-qty{flex:1;min-width:58px;font-variant-numeric:tabular-nums;}',
      '.stk-qty-max{font-weight:900;letter-spacing:1px;}',
      '.stk-band{font-size:11px;color:var(--muted);text-align:center;}',
      '@media(max-width:520px){.stk-trade-l{min-width:100%;}.stk-tick{margin-left:0;width:100%;}}'
    ].join(''));
  }

  /* ---------------- API ---------------- */
  App.Stocks = {
    TICK_MS: TICK_MS,
    list: function () { return STOCKS.slice(); },
    priceOf: priceOf,
    history: history,
    change: change,
    sharesOf: sharesOf,
    maxBuyable: maxBuyable,
    buy: buy,
    sell: sell,
    portfolioValue: portfolioValue,
    valueOf: valueOf,
    onChange: onChange,
    renderPage: renderPage,
    /** Depot neu laden — nach Konto-Login oder Moduswechsel (js/mode.js). */
    reload: function () { state = load(); emit(); }
  };

  // Wer Aktien hält, ist nicht pleite — er muss nur verkaufen (siehe coins.js).
  if (App.Coins && App.Coins.addReserveSource) App.Coins.addReserveSource(portfolioValue);
})();
