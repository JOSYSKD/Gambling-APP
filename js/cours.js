/* cours.js — COURS  (App.Cours)
 *
 * EIN einziger Kurs, der ohne Pause steigt und fällt. Kein Aktienkorb wie im
 * Aktienmarkt (js/stocks.js), sondern eine einzelne wilde Kurve, in die man
 * jederzeit ein- und aussteigen kann.
 *
 * Regeln (vom Besteller):
 *   - 3 Ticks pro Sekunde (Standard-Geschwindigkeit, vom Admin einstellbar).
 *   - Jeder Tick bewegt den Kurs um 1 % bis 10 % nach oben ODER unten.
 *   - Der Kurs hört nie auf und läuft für ALLE Spieler exakt gleich.
 *   - Ein- und aussteigen geht immer.
 *
 * Kernidee (wie beim Aktienmarkt): der Kurs braucht KEINEN Server. Er ist eine
 * reine Funktion aus der Tick-Nummer  ( = floor((Zeit - EPOCH) / Tickdauer) ).
 * Jeder Client rechnet dieselbe Formel -> alle sehen zur selben Zeit denselben
 * Kurs, und er läuft auch weiter, wenn niemand zusieht.
 *
 * Warum er trotz „immer 1–10 % pro Tick" nie explodiert oder auf 0 fällt:
 * ein multiplikativer Random-Walk mit Rückstellkraft (mean reversion). Je weiter
 * der Kurs über/unter dem Mittelwert BASE liegt, desto wahrscheinlicher zieht es
 * ihn zurück — die Schrittgröße bleibt dabei immer volle 1–10 %.
 *
 * Damit man den Wert an Tick i nicht von Anbeginn der Zeit aufsummieren muss,
 * rechnen wir ihn aus einem festen Vorlauf-Fenster (WARMUP Ticks vor i, Start
 * bei BASE). Weil der Prozess mean-revertet, hat er den Startwert nach dem
 * Vorlauf „vergessen" — die Kurve ist dadurch über die Zeit praktisch stetig.
 *
 * Nur das Depot des Spielers wird gespeichert (Anteile + Einstand), pro Modus
 * getrennt (js/mode.js): im Casino mit Silber, im Survival-Modus mit Gold.
 */
(function () {
  'use strict';
  window.App = window.App || {};
  var UI = App.UI, el = UI.el;

  /* ---------------- Kennzahlen ---------------- */
  var EPOCH = 1767225600000;    // fester Nullpunkt: 2026-01-01T00:00:00Z (ms)
  var BASE = 1000;              // Mittelwert, um den der Kurs pendelt
  var DEFAULT_SPEED_MS = 333;   // ~3 Ticks/Sekunde (Standard)
  var MIN_SPEED_MS = 100;       // schnellstens 10 Ticks/s
  var MAX_SPEED_MS = 2000;      // langsamstens 1 Tick / 2 s
  var MIN_STEP = 0.01;          // 1 %  – kleinster Sprung pro Tick
  var MAX_STEP = 0.15;          // 15 % – größter Sprung pro Tick (wilder als früher)
  var REVERT = 0.20;            // schwache Rückstellung -> viel breiteres Band, Kurs
                                //   kann weit hoch UND tief laufen (früher 0.62 = eng um 1000)
  var WARMUP = 1200;            // Vorlauf-Ticks (Einschwingen der Kurve)
  var HISTORY = 90;             // Punkte im großen Chart
  var SEED_MAG = 0x1a2b3c;      // getrennte Seeds für Schrittgröße …
  var SEED_DIR = 0x9f8e7d;      // … und Richtung
  var SEED_CRASH = 0x7c3f21;    // … und für Crash-Ereignisse
  // CRASH: seltenes, für alle gleiches Ereignis, bei dem der Kurs schlagartig
  // fast auf 0 einbricht. Wer dann im Kurs steckt, verliert seinen kompletten
  // Einsatz (siehe crashWatch). Danach erholt sich der Kurs wieder Richtung 1000.
  var CRASH_CHANCE = 1 / 1200;  // ~1 Crash alle 1200 Ticks (bei 3/s ≈ alle 6-7 Min)
  var CRASH_DEPTH = 0.03;       // Kurs fällt auf ~3 % (praktisch alles weg)
  var KEY = 'gj_cours';         // Depot im Storage
  var SPEED_KEY = 'gj_cours_speed';
  var SPEED_PATH = 'cours/speedMs';

  /* ---------------- Kurs-Mathematik ---------------- */
  /** Deterministischer Hash zweier Zahlen -> 0..1 (immer dasselbe Ergebnis). */
  function hash(a, b) {
    var h = (2166136261 ^ a) >>> 0;
    h = Math.imul(h ^ (b & 0xffff), 16777619);
    h = Math.imul(h ^ (b >>> 16), 16777619);
    h ^= h >>> 13; h = Math.imul(h, 0x5bd1e995); h ^= h >>> 15;
    return (h >>> 0) / 4294967296;
  }

  /** Ist Tick k ein Crash-Tick? Deterministisch -> für alle Spieler gleich. */
  function isCrashTick(k) { return hash(SEED_CRASH, k) < CRASH_CHANCE; }

  /** Ein Kursschritt: multipliziert v mit (1 ± 1–15 %), Richtung schwach
   *  mean-revertend. An Crash-Ticks bricht der Kurs schlagartig auf ~3 % ein. */
  function step(v, k) {
    if (isCrashTick(k)) return v * CRASH_DEPTH;    // 💥 Crash: fast alles weg
    var mag = MIN_STEP + (MAX_STEP - MIN_STEP) * hash(SEED_MAG, k);   // 0.01 … 0.15
    var z = Math.log(v / BASE);                    // Abstand vom Mittel (logarithmisch)
    var pUp = 0.5 - REVERT * z;                     // teuer -> seltener hoch, billig -> öfter hoch
    if (pUp < 0.10) pUp = 0.10; else if (pUp > 0.90) pUp = 0.90;
    var dir = hash(SEED_DIR, k) < pUp ? 1 : -1;
    return v * (1 + dir * mag);
  }

  var speedMs = clampSpeed(App.Storage ? App.Storage.get(SPEED_KEY, DEFAULT_SPEED_MS) : DEFAULT_SPEED_MS);
  function clampSpeed(ms) {
    ms = Math.round(Number(ms) || DEFAULT_SPEED_MS);
    return Math.max(MIN_SPEED_MS, Math.min(MAX_SPEED_MS, ms));
  }

  function tickAt(t) { return Math.floor((t - EPOCH) / speedMs); }
  function tickNow() { return tickAt(Date.now()); }
  function msIntoTick() { return (Date.now() - EPOCH) % speedMs; }

  /** Die letzten n Kurswerte bis einschließlich Tick i (ältester zuerst).
   *  Ein einziger Vorlauf-Lauf liefert alle Punkte auf einmal. */
  function series(i, n) {
    var v = BASE, out = [];
    var from = i - WARMUP - n;
    for (var k = from + 1; k <= i; k++) {
      v = step(v, k);
      if (k > i - n) out.push(v);
    }
    return out;
  }

  /** Kurs an einem einzelnen Tick i. */
  function priceAtTick(i) {
    var v = BASE;
    for (var k = i - WARMUP + 1; k <= i; k++) v = step(v, k);
    return v;
  }

  function priceNow() { return priceAtTick(tickNow()); }

  /* ---------------- Depot (Position) ---------------- */
  var state = load();
  function load() {
    var s = App.Storage ? App.Storage.get(KEY, null) : null;
    if (!s || typeof s !== 'object') s = {};
    if (typeof s.shares !== 'number' || s.shares < 0) s.shares = 0;
    if (typeof s.cost !== 'number' || s.cost < 0) s.cost = 0;
    if (typeof s.seenTick !== 'number') s.seenTick = tickNow();
    return s;
  }
  function save() { if (App.Storage) App.Storage.set(KEY, state); }

  var listeners = [];
  function onChange(cb) {
    listeners.push(cb);
    return function () { var i = listeners.indexOf(cb); if (i >= 0) listeners.splice(i, 1); };
  }
  function emit() { for (var i = 0; i < listeners.length; i++) { try { listeners[i](); } catch (e) {} } }

  function shares() { return state.shares; }
  function positionValue() { return Math.round(state.shares * priceNow()); }
  function invested() { return Math.round(state.cost); }
  function profit() { return positionValue() - invested(); }

  /** Für so viele Coins einsteigen (Anteile kaufen). */
  function enter(coinAmount) {
    var spend = Math.floor(Number(coinAmount) || 0);
    spend = Math.min(spend, App.Coins.get());
    if (spend <= 0) return 0;
    var p = priceNow();
    if (p <= 0) return 0;
    App.Coins.addRaw(-spend);
    state.shares += spend / p;
    state.cost += spend;
    state.seenTick = tickNow();   // ab jetzt auf Crashs achten
    save(); emit();
    return { spend: spend };
  }

  /** Einen Bruchteil (0..1) der Position aussteigen (Anteile verkaufen). */
  function exit(fraction) {
    fraction = Math.max(0, Math.min(1, Number(fraction) || 0));
    if (state.shares <= 0 || fraction <= 0) return 0;
    var sellShares = state.shares * fraction;
    var proceeds = Math.round(sellShares * priceNow());
    var costPart = Math.round(state.cost * fraction);
    state.shares -= sellShares;
    state.cost -= costPart;
    if (state.shares < 1e-9) { state.shares = 0; state.cost = 0; }
    App.Coins.addRaw(proceeds);
    save(); emit();
    return { proceeds: proceeds, profit: proceeds - costPart };
  }

  /* ---------------- Crash-Wächter ----------------
   * Läuft dauerhaft (nicht nur auf der Kurs-Seite): sobald zwischen dem zuletzt
   * gesehenen Tick und jetzt ein Crash lag und der Spieler eine offene Position
   * hat, ist der komplette Einsatz weg. Weil der Kurs für alle identisch ist,
   * trifft es alle, die gerade drin sind, gleichzeitig. */
  var crashListeners = [];
  function onCrash(cb) { crashListeners.push(cb); return function () { var i = crashListeners.indexOf(cb); if (i >= 0) crashListeners.splice(i, 1); }; }
  function emitCrash(info) { for (var i = 0; i < crashListeners.length; i++) { try { crashListeners[i](info); } catch (e) {} } }

  function crashBetween(a, b) {
    var from = Math.max(a + 1, b - 6000);    // Sicherheitsbund gegen lange Abwesenheit
    for (var k = from; k <= b; k++) if (isCrashTick(k)) return true;
    return false;
  }
  function crashWatch() {
    var t = tickNow();
    var seen = (typeof state.seenTick === 'number') ? state.seenTick : t;
    if (t <= seen) return;
    if (state.shares > 1e-9 && crashBetween(seen, t)) {
      var lost = invested();
      state.shares = 0; state.cost = 0; state.seenTick = t;
      save(); emit();
      emitCrash({ lost: lost });
    } else {
      state.seenTick = t; save();
    }
  }
  setInterval(crashWatch, 1500);

  /* ---------------- Geschwindigkeit (Admin, geteilt) ---------------- */
  var speedListeners = [];
  function onSpeed(cb) { speedListeners.push(cb); return function () { var i = speedListeners.indexOf(cb); if (i >= 0) speedListeners.splice(i, 1); }; }
  function emitSpeed() { for (var i = 0; i < speedListeners.length; i++) { try { speedListeners[i](); } catch (e) {} } }

  function ticksPerSec() { return Math.round((1000 / speedMs) * 10) / 10; }

  /** Live auf den geteilten Firebase-Wert lauschen, damit alle dieselbe
   *  Geschwindigkeit sehen. Ohne Firebase bleibt es beim lokalen Wert. */
  function watchSharedSpeed() {
    if (!(App.Net && App.Net.firebaseConfigured && App.Net.firebaseConfigured())) return;
    App.Net.firebaseDb().then(function (db) {
      db.ref(SPEED_PATH).on('value', function (snap) {
        var v = snap.val();
        if (typeof v === 'number') {
          var c = clampSpeed(v);
          if (c !== speedMs) { speedMs = c; if (App.Storage) App.Storage.set(SPEED_KEY, c); emitSpeed(); }
        }
      });
    }).catch(function () {});
  }

  /** Geschwindigkeit setzen (nur Admin). Schreibt in Firebase, sodass es bei
   *  allen ankommt; lokal wirkt es sofort. */
  function setSpeed(ms) {
    var c = clampSpeed(ms);
    speedMs = c;
    if (App.Storage) App.Storage.set(SPEED_KEY, c);
    emitSpeed();
    if (App.Net && App.Net.firebaseConfigured && App.Net.firebaseConfigured()) {
      App.Net.firebaseDb().then(function (db) { db.ref(SPEED_PATH).set(c); }).catch(function () {});
    }
  }
  watchSharedSpeed();

  /* ---------------- Chart ---------------- */
  function drawChart(canvas, data, lastOverride, opts) {
    opts = opts || {};
    var dpr = window.devicePixelRatio || 1;
    var w = canvas.clientWidth || 300, h = canvas.clientHeight || 160;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    var c = canvas.getContext('2d');
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, w, h);
    if (!data.length) return;

    // Eine Kopie mit ggf. flüssig interpoliertem letzten Punkt (siehe RAF-Loop).
    var pts = data.slice();
    if (lastOverride != null) pts[pts.length - 1] = lastOverride;

    var pad = opts.pad || 6;
    var min = Math.min.apply(null, pts), max = Math.max.apply(null, pts);
    if (max - min < 0.5) { max += 0.5; min -= 0.5; }
    var span = max - min;
    var x = function (i) { return pad + (i / (pts.length - 1 || 1)) * (w - pad * 2); };
    var y = function (v) { return pad + (1 - (v - min) / span) * (h - pad * 2); };

    var up = pts[pts.length - 1] >= pts[0];
    var line = up ? '#39ff14' : '#ff4d6d';

    if (opts.grid) {
      c.strokeStyle = 'rgba(255,255,255,0.07)';
      c.lineWidth = 1;
      for (var g = 0; g <= 4; g++) {
        var gy = pad + (g / 4) * (h - pad * 2);
        c.beginPath(); c.moveTo(pad, gy); c.lineTo(w - pad, gy); c.stroke();
      }
    }

    var grad = c.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, up ? 'rgba(57,255,20,0.28)' : 'rgba(255,77,109,0.28)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    c.beginPath();
    c.moveTo(x(0), y(pts[0]));
    for (var i = 1; i < pts.length; i++) c.lineTo(x(i), y(pts[i]));
    c.lineTo(x(pts.length - 1), h - pad);
    c.lineTo(x(0), h - pad);
    c.closePath();
    c.fillStyle = grad;
    c.fill();

    c.beginPath();
    c.moveTo(x(0), y(pts[0]));
    for (var j = 1; j < pts.length; j++) c.lineTo(x(j), y(pts[j]));
    c.strokeStyle = line;
    c.lineWidth = 2.4;
    c.lineJoin = 'round';
    c.shadowColor = line;
    c.shadowBlur = 9;
    c.stroke();
    c.shadowBlur = 0;

    var lx = x(pts.length - 1), ly = y(pts[pts.length - 1]);
    c.beginPath(); c.arc(lx, ly, 3.8, 0, Math.PI * 2); c.fillStyle = line; c.fill();
    c.beginPath(); c.arc(lx, ly, 8, 0, Math.PI * 2);
    c.strokeStyle = line; c.globalAlpha = 0.4; c.lineWidth = 1.5; c.stroke();
    c.globalAlpha = 1;
  }

  /* ---------------- Anzeige-Helfer ---------------- */
  function money(n) { return UI.formatCoins(Math.round(n)) + ' ' + UI.coinIcon(); }
  function price2(n) { return Number(n).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function pctTxt(p) { return (p > 0 ? '+' : '') + p.toFixed(2).replace('.', ',') + ' %'; }
  function dirClass(d) { return d > 0 ? 'up' : (d < 0 ? 'down' : 'flat'); }
  function dirArrow(d) { return d > 0 ? '▲' : (d < 0 ? '▼' : '■'); }

  /* ---------------- Seite ---------------- */
  function renderPage(root) {
    injectCss();
    var page = el('div', { class: 'crs-page' });
    root.appendChild(page);

    /* --- Kopf --- */
    page.appendChild(el('div', { class: 'page-head' }, [
      el('button', { class: 'btn btn-ghost back', type: 'button', onclick: function () {
        App.Router.go(App.Mode.is('survival') ? '/survival' : '/');
      } }, ['← ' + (App.Mode.is('survival') ? 'Survival' : 'Menü')]),
      el('h2', { class: 'page-title neon' }, ['🎢 COURS'])
    ]));

    /* --- Kurs-Kachel (Chart + großer Preis) --- */
    var canvas = el('canvas', { class: 'crs-chart' });
    var bigPrice = el('div', { class: 'crs-big' });
    var bigChg = el('span', { class: 'crs-chg' });
    var tpsTag = el('span', { class: 'crs-tps' });
    var board = el('div', { class: 'crs-board glass' }, [
      el('div', { class: 'crs-board-top' }, [
        el('div', {}, [
          el('div', { class: 'crs-label' }, ['Aktueller Kurs']),
          bigPrice
        ]),
        el('div', { class: 'crs-board-right' }, [bigChg, tpsTag])
      ]),
      canvas
    ]);
    page.appendChild(board);

    /* --- Positions-/Handelskachel --- */
    var trade = el('div', { class: 'crs-trade glass' });
    page.appendChild(trade);

    /* --- Admin-Geschwindigkeit --- */
    var adminBox = el('div', { class: 'crs-admin glass' });
    page.appendChild(adminBox);

    page.appendChild(el('p', { class: 'crs-hint' }, [
      'Ein einziger Kurs, der ohne Pause steigt und fällt — für alle Spieler gleich und immer weiterlaufend. ' +
      'Jeder Tick bewegt ihn um 1 bis 15 %, und er kann weit hoch UND tief laufen. ' +
      '⚠️ Selten kommt ein CRASH: der Kurs stürzt fast auf null und wer dann drin ist, verliert seinen ganzen Einsatz. ' +
      'Steig ein, wenn du glaubst er steigt, und wieder aus, bevor er kippt. ' +
      'Gespielt wird mit ' + App.Mode.coinName() + '.'
    ]));

    /* --- Handel zeichnen --- */
    function drawTrade() {
      trade.innerHTML = '';
      var has = state.shares > 1e-9;
      var p = priceNow();
      trade.appendChild(el('div', { class: 'crs-pos' }, [
        posStat('Deine Anteile', has ? UI.formatCoins(Math.round(state.shares)) : '—'),
        posStat('Einsatz', has ? money(invested()) : '—'),
        posStat('Aktueller Wert', has ? money(positionValue()) : '—'),
        posStat('Gewinn/Verlust', has ? (profit() >= 0 ? '+' : '') + money(profit()) : '—', has ? dirClass(profit()) : '')
      ]));

      // Einsteigen
      var cash = App.Coins.get();
      var enterAmts = [
        { lab: '100', v: 100 },
        { lab: '1.000', v: 1000 },
        { lab: '10.000', v: 10000 },
        { lab: '¼', v: Math.floor(cash / 4) },
        { lab: 'MAX', v: cash }
      ];
      var enterBtns = enterAmts.map(function (a) {
        return el('button', { class: 'btn btn-primary crs-qty', type: 'button', disabled: (a.v <= 0 || a.v > cash) || null,
          onclick: function () { doEnter(a.v); } }, [a.lab]);
      });
      trade.appendChild(el('div', { class: 'crs-trade-row' }, [
        el('span', { class: 'crs-trade-l' }, ['📥 Einsteigen']),
        el('div', { class: 'crs-qtys' }, enterBtns)
      ]));

      // Aussteigen
      var exitDefs = [{ lab: '¼', f: 0.25 }, { lab: 'Hälfte', f: 0.5 }, { lab: 'ALLES', f: 1 }];
      var exitBtns = exitDefs.map(function (d) {
        return el('button', { class: 'btn btn-aqua crs-qty', type: 'button', disabled: !has || null,
          onclick: function () { doExit(d.f); } }, [d.lab]);
      });
      trade.appendChild(el('div', { class: 'crs-trade-row' }, [
        el('span', { class: 'crs-trade-l' }, ['📤 Aussteigen']),
        el('div', { class: 'crs-qtys' }, exitBtns)
      ]));
    }

    function posStat(label, val, cls) {
      return el('div', { class: 'crs-pos-stat' }, [
        el('span', { class: 'crs-pos-l' }, [label]),
        el('span', { class: 'crs-pos-v ' + (cls || '') }, [val])
      ]);
    }

    function doEnter(v) {
      var r = enter(v);
      if (!r || !r.spend) { UI.toast('Dafür reicht dein Guthaben nicht.', 'lose'); return; }
      UI.flashRaw(-r.spend);
      UI.toast('Für ' + money(r.spend) + ' eingestiegen', 'info');
      if (App.Audio) App.Audio.sfx('click');
      drawTrade();
    }
    function doExit(f) {
      var r = exit(f);
      if (!r || !r.proceeds) { UI.toast('Du bist gar nicht drin.', 'lose'); return; }
      UI.flashRaw(r.proceeds);
      UI.toast('Ausgestiegen · ' + (r.profit >= 0 ? 'Gewinn ' : 'Verlust ') + money(Math.abs(r.profit)),
        r.profit >= 0 ? 'win' : 'lose');
      if (App.Audio) App.Audio.sfx('coin');
      drawTrade();
    }

    /* --- Admin-Geschwindigkeit zeichnen --- */
    function drawAdmin() {
      adminBox.innerHTML = '';
      if (!(App.Admin && App.Admin.isAdmin())) { adminBox.style.display = 'none'; return; }
      adminBox.style.display = '';
      var presets = [
        { lab: '0,5×', ms: 2000 }, { lab: '1/s', ms: 1000 }, { lab: '2/s', ms: 500 },
        { lab: '3/s', ms: 333 }, { lab: '5/s', ms: 200 }, { lab: '10/s', ms: 100 }
      ];
      var btns = presets.map(function (pr) {
        var active = Math.abs(pr.ms - speedMs) < 6;
        return el('button', { class: 'btn crs-speed-btn' + (active ? ' active' : ''), type: 'button',
          onclick: function () { setSpeed(pr.ms); UI.toast('Geschwindigkeit: ' + ticksPerSec() + ' Ticks/s', 'win'); } }, [pr.lab]);
      });
      adminBox.appendChild(el('div', { class: 'crs-admin-head' }, ['🛠 Admin · Kurs-Geschwindigkeit']));
      adminBox.appendChild(el('div', { class: 'crs-admin-cur' }, ['Aktuell: ', el('b', {}, [ticksPerSec() + ' Ticks/s'])]));
      adminBox.appendChild(el('div', { class: 'crs-speed-row' }, btns));
      adminBox.appendChild(el('div', { class: 'crs-admin-note' }, [
        (App.Net && App.Net.firebaseConfigured && App.Net.firebaseConfigured())
          ? 'Gilt sofort für alle Spieler.'
          : 'Kein Cloud-Backend erreichbar — wirkt nur in diesem Browser.'
      ]));
    }

    /* --- Kopf-Werte + Chart aktualisieren --- */
    var lastTick = tickNow();
    var cache = series(lastTick, HISTORY);   // Kurve, nur bei Tickwechsel neu berechnet

    function updateBoard() {
      var cur = cache[cache.length - 1];
      var prev = cache.length > 1 ? cache[cache.length - 2] : cur;
      // Flüssiges Gleiten zwischen zwei Ticks: der neue Kurs wird über die
      // Tickdauer hinweg angefahren (rein optisch, der echte Wert ist `cur`).
      var frac = Math.min(1, msIntoTick() / speedMs);
      var shown = prev + (cur - prev) * frac;
      bigPrice.textContent = price2(shown);
      var abs = cur - prev, pct = prev ? (abs / prev) * 100 : 0, dir = abs > 0 ? 1 : (abs < 0 ? -1 : 0);
      bigChg.className = 'crs-chg ' + dirClass(dir);
      bigChg.textContent = dirArrow(dir) + ' ' + price2(Math.abs(abs)) + ' (' + pctTxt(pct) + ')';
      tpsTag.textContent = ticksPerSec() + ' Ticks/s';
      drawChart(canvas, cache, shown, { grid: true, pad: 8 });
    }

    /* --- Lauf --- */
    var raf = 0, alive = true;
    function frame() {
      if (!alive) return;
      var t = tickNow();
      if (t !== lastTick) {
        lastTick = t;
        cache = series(t, HISTORY);
        // Guthaben/Position können sich im Wert geändert haben:
        refreshPositionValues();
      }
      updateBoard();
      raf = window.requestAnimationFrame(frame);
    }

    // Nur die Wertfelder der Position frisch halten (ohne die ganze Kachel neu
    // zu bauen), damit man während des Tippens/Klickens nichts verliert.
    function refreshPositionValues() {
      var vals = trade.querySelectorAll('.crs-pos-v');
      if (!vals.length) return;
      var has = state.shares > 1e-9;
      if (vals[2]) vals[2].textContent = has ? money(positionValue()) : '—';
      if (vals[3]) {
        vals[3].textContent = has ? (profit() >= 0 ? '+' : '') + money(profit()) : '—';
        vals[3].className = 'crs-pos-v ' + (has ? dirClass(profit()) : '');
      }
    }

    drawTrade();
    drawAdmin();
    updateBoard();
    frame();

    var offCoins = App.Coins.onChange(drawTrade);
    var offSpeed = onSpeed(function () { lastTick = tickNow(); cache = series(lastTick, HISTORY); drawAdmin(); updateBoard(); });
    var offMine = onChange(drawTrade);

    return function () {
      alive = false;
      if (raf) window.cancelAnimationFrame(raf);
      offCoins(); offSpeed(); offMine();
    };
  }

  /* ---------------- CSS ---------------- */
  var cssDone = false;
  function injectCss() {
    if (cssDone) return; cssDone = true;
    UI.injectStyle('cours-css', [
      '.crs-page{display:flex;flex-direction:column;gap:14px;max-width:820px;margin:0 auto;}',
      '.crs-board{padding:16px;display:flex;flex-direction:column;gap:12px;}',
      '.crs-board-top{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap;}',
      '.crs-label{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;font-weight:800;}',
      '.crs-big{font-size:clamp(34px,9vw,52px);font-weight:900;color:var(--gold);font-variant-numeric:tabular-nums;line-height:1.05;text-shadow:0 0 22px rgba(255,210,63,.35);}',
      '.crs-board-right{text-align:right;display:flex;flex-direction:column;align-items:flex-end;gap:6px;}',
      '.crs-chg{font-size:15px;font-weight:900;font-variant-numeric:tabular-nums;white-space:nowrap;}',
      '.crs-chg.up{color:var(--neon,#39ff14);text-shadow:0 0 8px rgba(57,255,20,.6);}',
      '.crs-chg.down{color:var(--danger-2,#ff4d6d);text-shadow:0 0 8px rgba(255,77,109,.5);}',
      '.crs-chg.flat{color:var(--muted);}',
      '.crs-tps{font-size:11px;font-weight:800;color:var(--muted);background:rgba(0,0,0,.25);border-radius:99px;padding:3px 9px;}',
      '.crs-chart{width:100%;height:220px;display:block;border-radius:12px;background:rgba(0,0,0,.18);}',
      '.crs-trade{padding:16px;display:flex;flex-direction:column;gap:14px;}',
      '.crs-pos{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;}',
      '@media(max-width:560px){.crs-pos{grid-template-columns:repeat(2,1fr);}}',
      '.crs-pos-stat{display:flex;flex-direction:column;gap:2px;background:rgba(0,0,0,.2);border-radius:10px;padding:9px 11px;}',
      '.crs-pos-l{font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.7px;font-weight:800;}',
      '.crs-pos-v{font-weight:900;font-variant-numeric:tabular-nums;font-size:15px;}',
      '.crs-pos-v.up{color:var(--neon);}',
      '.crs-pos-v.down{color:var(--danger-2,#ff4d6d);}',
      '.crs-trade-row{display:flex;align-items:center;gap:12px;flex-wrap:wrap;}',
      '.crs-trade-l{font-weight:900;min-width:118px;}',
      '.crs-qtys{display:flex;gap:8px;flex:1;flex-wrap:wrap;}',
      '.crs-qty{flex:1;min-width:56px;font-variant-numeric:tabular-nums;font-weight:900;}',
      '@media(max-width:520px){.crs-trade-l{min-width:100%;}}',
      '.crs-admin{padding:14px 16px;display:flex;flex-direction:column;gap:9px;border-color:rgba(255,210,63,.4);}',
      '.crs-admin-head{font-weight:900;color:var(--gold);font-size:15px;}',
      '.crs-admin-cur{font-size:13px;color:var(--muted);}',
      '.crs-admin-cur b{color:var(--leaf);}',
      '.crs-speed-row{display:flex;gap:8px;flex-wrap:wrap;}',
      '.crs-speed-btn{flex:1;min-width:60px;font-weight:900;}',
      '.crs-speed-btn.active{color:#04160c;background:linear-gradient(180deg,var(--neon-soft),var(--neon));border-color:var(--neon);box-shadow:0 0 12px rgba(57,255,20,.5);}',
      '.crs-admin-note{font-size:11px;color:var(--muted);}',
      '.crs-hint{color:var(--muted);font-size:12px;text-align:center;line-height:1.5;margin:2px 0 0;}'
    ].join(''));
  }

  /* ---------------- API ---------------- */
  App.Cours = {
    priceNow: priceNow,
    series: series,
    shares: shares,
    positionValue: positionValue,
    profit: profit,
    enter: enter,
    exit: exit,
    onChange: onChange,
    renderPage: renderPage,
    ticksPerSec: ticksPerSec,
    setSpeed: setSpeed,
    onSpeed: onSpeed,
    onCrash: onCrash,
    /** Depot neu laden — nach Konto-Login oder Moduswechsel (js/mode.js). */
    reload: function () { state = load(); emit(); }
  };

  // Wer im Kurs steckt, ist nicht pleite — er muss nur aussteigen (siehe coins.js).
  if (App.Coins && App.Coins.addReserveSource) App.Coins.addReserveSource(positionValue);

  // Globaler Crash-Hinweis (auch außerhalb der Kurs-Seite sichtbar).
  onCrash(function (info) {
    if (App.UI && App.UI.toast) {
      App.UI.toast('💥 COURS-CRASH! Dein Einsatz (' + UI.formatCoins(info.lost) + ' ' + UI.coinIcon() + ') ist weg.', 'lose');
    }
    if (App.Audio && App.Audio.sfx) App.Audio.sfx('lose');
  });
  crashWatch();   // direkt einmal prüfen (fängt Crashs während kurzer Abwesenheit)
})();
