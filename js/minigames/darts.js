/* darts.js — "501 Dart": klassisches Steeldart 501 im Neon-Dschungel-Look.
 *
 * SPIELIDEE
 *   Jeder Spieler startet bei 501 Punkten und wirft reihum je 3 Darts pro
 *   Aufnahme. Der Wert jedes Darts wird abgezogen. Ziel: exakt auf 0 — und
 *   der letzte Dart MUSS ein Doppel sein (Double-Out; die Bull 50 zaehlt als
 *   Doppel). Wer unter 0 faellt, genau 1 uebrig laesst oder ohne Doppel auf 0
 *   kommt, hat "ueberworfen" (Bust): die ganze Aufnahme verfaellt, es geht mit
 *   dem Stand vom Beginn der Aufnahme weiter. Bei Rest <= 170 wird ein
 *   Checkout-Vorschlag eingeblendet.
 *
 * STEUERUNG
 *   Ein Fadenkreuz zittert ueber der echten Dartscheibe. Mit der Maus
 *   (Hover) oder am Handy (ziehen) zielen, per Klick / Loslassen werfen. Je
 *   weiter das Spiel fortgeschritten ist (mehr Darts geworfen), desto ruhiger
 *   wird die Hand. Getroffene Darts bleiben als Dart-Symbole stecken.
 *
 * PUNKTE / SCHEIBE
 *   20 Segmente in echter Reihenfolge (20,1,18,4,13,6,10,15,2,17,3,19,7,16,8,
 *   11,14,9,12,5), Triple- und Double-Ring, Aussen-Bull 25, Bull 50 mit
 *   korrekter geometrischer Trefferauswertung.
 *
 * SOLO   (ctx.mode==='single'): gegen einen Bot mit vier Treffsicherheits-
 *         Stufen (Leicht/Mittel/Profi/Weltklasse). Der Bot zielt strategisch
 *         (T20 zum Punkten, gezieltes Setup + Double-Checkout).
 * MULTI  (ctx.mode==='multi', 2–6 Spieler): rundenbasiert ueber room.shared.
 *         Der aktuelle Werfer schreibt jedes Wurfergebnis via setShared; alle
 *         Clients rendern daraus und animieren den Dart gleich. Der Werfer
 *         schaltet nach seiner Aufnahme selbst weiter; ein Host-Watchdog
 *         springt ein, falls der Werfer die Runde verlaesst.
 *
 * Alle Animationen laufen ueber Wall-Clock (Date.now); Zug-/Countdown-Timing
 * im Multiplayer ueber room.now (synchron). cleanup() beendet rAF, alle
 * Timer, DOM/Window-Listener und entfernt jeden room.on-Handler. */
(function () {
  'use strict';
  window.App = window.App || {}; App.Minigames = App.Minigames || {};
  var UI = App.UI, el = UI.el;

  injectStyle();

  /* ============================ GEOMETRIE ============================ */
  var SEG_ORDER = [20, 1, 18, 4, 13, 6, 10, 15, 2, 17, 3, 19, 7, 16, 8, 11, 14, 9, 12, 5];
  var CV = 460, CX = 230, CY = 230, R = 196;   // Canvas + aeusserer Double-Radius (virtuell)
  var K = R / 170;                             // Skala echte mm -> virtuelle px
  var R_BULL = 6.35 * K, R_25 = 15.9 * K, R_TIN = 99 * K, R_TOUT = 107 * K, R_DIN = 162 * K, R_DOUT = 170 * K;
  var FLIGHT_MS = 360;                          // Dauer der Dart-Fluganimation
  var PCOL = ['#39ff14', '#33e6d0', '#ffd23f', '#ff4d6d', '#9dff7a', '#e08a3c'];

  /* Trefferauswertung fuer einen Punkt (x,y) in Canvas-Koordinaten. */
  function evaluate(x, y) {
    var dx = x - CX, dy = y - CY, dist = Math.sqrt(dx * dx + dy * dy);
    if (dist <= R_BULL) return { value: 50, mult: 2 };      // Bull zaehlt als Doppel
    if (dist <= R_25) return { value: 25, mult: 1 };
    if (dist > R_DOUT) return { value: 0, mult: 0 };        // daneben
    var deg = Math.atan2(dx, -dy) * 180 / Math.PI;         // 0 oben, im Uhrzeigersinn
    var idx = Math.floor(((((deg + 9) % 360) + 360) % 360) / 18);
    var base = SEG_ORDER[idx];
    if (dist >= R_TIN && dist <= R_TOUT) return { value: base * 3, mult: 3 };
    if (dist >= R_DIN && dist <= R_DOUT) return { value: base * 2, mult: 2 };
    return { value: base, mult: 1 };
  }

  /* Zielpunkt fuer einen Segmentwert + Multiplikator (fuer die Bot-KI). */
  function pointFor(value, mult) {
    if (value === 50) return { x: CX, y: CY };
    if (value === 25) return { x: CX, y: CY - (R_BULL + R_25) / 2 };
    var base = value / (mult || 1);
    var idx = SEG_ORDER.indexOf(base);
    if (idx < 0) idx = 0;
    var th = idx * 18 * Math.PI / 180;
    var rad = mult === 3 ? (R_TIN + R_TOUT) / 2 : mult === 2 ? (R_DIN + R_DOUT) / 2 : (R_TOUT + R_DIN) / 2;
    return { x: CX + rad * Math.sin(th), y: CY - rad * Math.cos(th) };
  }

  /* ======================== CHECKOUT / KI-PLAN ======================== */
  function A(t, v, m) { return { text: t, value: v, mult: m }; }
  var FIRSTS = [];
  (function () {
    var n;
    for (n = 20; n >= 1; n--) FIRSTS.push(A('T' + n, n * 3, 3));   // Triples zuerst (zum Punkten)
    for (n = 20; n >= 1; n--) FIRSTS.push(A('' + n, n, 1));        // dann einfache Felder
    FIRSTS.push(A('25', 25, 1));
  })();
  function isDoubleScore(s) { return s === 50 || (s > 0 && s <= 40 && s % 2 === 0); }
  function doubleAim(s) { return s === 50 ? A('Bull', 50, 2) : A('D' + (s / 2), s, 2); }

  /* Kuerzester Weg von rem auf 0, der mit einem Doppel endet (oder null). */
  function checkout(rem, dartsLeft) {
    if (rem <= 1) return null;
    if (dartsLeft >= 1 && isDoubleScore(rem)) return [doubleAim(rem)];
    var i, j, r2;
    if (dartsLeft >= 2) {
      for (i = 0; i < FIRSTS.length; i++) { r2 = rem - FIRSTS[i].value; if (r2 > 1 && isDoubleScore(r2)) return [FIRSTS[i], doubleAim(r2)]; }
    }
    if (dartsLeft >= 3) {
      for (i = 0; i < FIRSTS.length; i++) { for (j = 0; j < FIRSTS.length; j++) { r2 = rem - FIRSTS[i].value - FIRSTS[j].value; if (r2 > 1 && isDoubleScore(r2)) return [FIRSTS[i], FIRSTS[j], doubleAim(r2)]; } }
    }
    return null;
  }
  function checkoutText(co) { return co.map(function (a) { return a.text; }).join(' → '); }

  /* Was der Bot mit dem naechsten Dart anpeilt. */
  function planFirst(rem, dartsLeft) {
    var co = checkout(rem, dartsLeft);
    if (co) return co[0];
    var pref = [40, 32, 24, 20, 16, 8, 4, 50, 36, 28, 12, 10, 6, 2];
    var s;
    for (s = 20; s >= 1; s--) { if (pref.indexOf(rem - s) >= 0 && rem - s > 1) return A('' + s, s, 1); }
    if (rem > 60) return A('T20', 60, 3);
    for (s = 20; s >= 1; s--) { var lv = rem - s; if (lv > 1 && lv % 2 === 0) return A('' + s, s, 1); }
    return A('T20', 60, 3);
  }
  function gauss() { return (Math.random() + Math.random() + Math.random() - 1.5) * 0.92; }
  function botTargetPoint(rem, dartsLeft, sigma) {
    var plan = planFirst(rem, dartsLeft);
    var p = pointFor(plan.value, plan.mult);
    return { x: p.x + gauss() * sigma, y: p.y + gauss() * sigma };
  }

  /* ============================ HELFER ============================ */
  function labelFor(v, m) {
    if (v === 0) return 'Aus';
    if (v === 50) return 'Bull';
    if (v === 25) return '25';
    if (m === 3) return 'T' + (v / 3);
    if (m === 2) return 'D' + (v / 2);
    return '' + v;
  }
  /* Aufnahme auswerten: darts = [{v,m}], liefert {tentative,status}. */
  function evalVisit(startRem, darts) {
    var t = startRem, lastDart = null, i;
    for (i = 0; i < darts.length; i++) { t -= darts[i].v; lastDart = darts[i]; }
    var status = 'ok';
    if (t < 0) status = 'bust';
    else if (t === 0) status = (lastDart && lastDart.m === 2) ? 'win' : 'bust';
    else if (t === 1) status = 'bust';
    return { tentative: t, status: status };
  }
  function steadyAmp(n) { var f = Math.max(0.3, 1 - n * 0.028); return 7 + 23 * f; }
  function sumDarts(darts) { var s = 0, i; for (i = 0; i < darts.length; i++) s += darts[i].v; return s; }

  /* ============================ SCHEIBE ZEICHNEN ============================ */
  var _boardCv = null;
  function getBoardCv() {
    if (_boardCv) return _boardCv;
    var c = document.createElement('canvas'); c.width = CV; c.height = CV;
    drawBoard(c.getContext('2d')); _boardCv = c; return _boardCv;
  }
  function wedge(g, ri, ro, a1, a2, color) {
    g.beginPath();
    g.arc(CX, CY, ro, a1, a2, false);
    g.arc(CX, CY, ri, a2, a1, true);
    g.closePath(); g.fillStyle = color; g.fill();
  }
  function drawBoard(g) {
    g.clearRect(0, 0, CV, CV);
    var grd = g.createRadialGradient(CX, CY, R, CX, CY, R + 30);
    grd.addColorStop(0, '#05140c'); grd.addColorStop(1, '#020a06');
    g.beginPath(); g.arc(CX, CY, R + 30, 0, Math.PI * 2); g.closePath(); g.fillStyle = grd; g.fill();
    var i;
    for (i = 0; i < 20; i++) {
      var a1 = (i * 18 - 9) * Math.PI / 180 - Math.PI / 2;
      var a2 = (i * 18 + 9) * Math.PI / 180 - Math.PI / 2;
      var darkA = (i % 2 === 0);
      var single = darkA ? '#0c2417' : '#08180f';
      var ring = darkA ? '#d8324e' : '#2fca57';
      wedge(g, R_25, R_TIN, a1, a2, single);
      wedge(g, R_TIN, R_TOUT, a1, a2, ring);
      wedge(g, R_TOUT, R_DIN, a1, a2, single);
      wedge(g, R_DIN, R_DOUT, a1, a2, ring);
    }
    g.save();
    g.strokeStyle = 'rgba(2,9,5,0.85)'; g.lineWidth = 1.4;
    for (i = 0; i < 20; i++) {
      var tb = (i * 18 + 9) * Math.PI / 180 - Math.PI / 2;
      g.beginPath();
      g.moveTo(CX + R_25 * Math.cos(tb), CY + R_25 * Math.sin(tb));
      g.lineTo(CX + R_DOUT * Math.cos(tb), CY + R_DOUT * Math.sin(tb));
      g.stroke();
    }
    [R_25, R_TIN, R_TOUT, R_DIN, R_DOUT].forEach(function (r) { g.beginPath(); g.arc(CX, CY, r, 0, Math.PI * 2); g.stroke(); });
    g.restore();
    g.save();
    g.strokeStyle = 'rgba(57,255,20,0.55)'; g.lineWidth = 3; g.shadowColor = 'rgba(57,255,20,0.5)'; g.shadowBlur = 16;
    g.beginPath(); g.arc(CX, CY, R_DOUT + 1.5, 0, Math.PI * 2); g.stroke();
    g.restore();
    g.save();
    g.fillStyle = '#2fca57'; g.beginPath(); g.arc(CX, CY, R_25, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#d8324e'; g.beginPath(); g.arc(CX, CY, R_BULL, 0, Math.PI * 2); g.fill();
    g.strokeStyle = 'rgba(2,9,5,0.7)'; g.lineWidth = 1.4;
    g.beginPath(); g.arc(CX, CY, R_25, 0, Math.PI * 2); g.stroke();
    g.beginPath(); g.arc(CX, CY, R_BULL, 0, Math.PI * 2); g.stroke();
    g.restore();
    g.save();
    g.fillStyle = '#dfeee6'; g.font = '700 20px system-ui,"Segoe UI",Roboto,Arial,sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle'; g.shadowColor = 'rgba(0,0,0,0.6)'; g.shadowBlur = 4;
    for (i = 0; i < 20; i++) {
      var th = i * 18 * Math.PI / 180;
      g.fillText('' + SEG_ORDER[i], CX + (R_DOUT + 16) * Math.sin(th), CY - (R_DOUT + 16) * Math.cos(th));
    }
    g.restore();
  }

  /* Einen gesteckten/fliegenden Dart zeichnen. */
  function drawDart(g, x, y, color, scale, alpha) {
    scale = scale || 1; alpha = (alpha == null) ? 1 : alpha;
    var ex = x - 14 * scale, ey = y - 21 * scale;   // Flugende (nach oben-links)
    g.save(); g.globalAlpha = alpha;
    g.strokeStyle = '#e7f4ee'; g.lineWidth = 2.3 * scale; g.lineCap = 'round';
    g.beginPath(); g.moveTo(x, y); g.lineTo(ex, ey); g.stroke();
    g.strokeStyle = color; g.lineWidth = 3.6 * scale;
    g.beginPath(); g.moveTo(x, y); g.lineTo(x - 6 * scale, y - 9 * scale); g.stroke();
    g.fillStyle = color;
    g.beginPath(); g.moveTo(ex, ey); g.lineTo(ex - 6 * scale, ey - 3 * scale); g.lineTo(ex - 3 * scale, ey + 4 * scale); g.closePath(); g.fill();
    g.beginPath(); g.moveTo(ex, ey); g.lineTo(ex + 3 * scale, ey - 6 * scale); g.lineTo(ex + 5 * scale, ey - 1 * scale); g.closePath(); g.fill();
    g.fillStyle = '#fff'; g.shadowColor = color; g.shadowBlur = 8 * scale;
    g.beginPath(); g.arc(x, y, 2.3 * scale, 0, Math.PI * 2); g.fill();
    g.restore();
  }

  /* ============================ REGISTRIERUNG ============================ */
  App.Minigames.darts = {
    id: 'darts', title: '501 Dart', icon: '🎯', order: 126,
    subtitle: 'Wirf 501 auf null – Doppel-Finish gewinnt',
    single: true, multi: true, minPlayers: 2, maxPlayers: 6,

    render: function (root, ctx) {
      var mode = ctx.mode;
      var room = ctx.room;
      var me = { id: (ctx.me && ctx.me.id) || 'me', name: (ctx.me && ctx.me.name) || 'Du' };

      /* ---- Aufraeum-Infrastruktur ---- */
      var dead = false, raf = null, last = 0;
      var timers = [], listeners = [], roomOffs = [], stopsFns = [];
      function timer(ms, fn) { var id = setTimeout(function () { if (!dead) fn(); }, ms); timers.push(id); return id; }
      function addL(t, ty, fn, opts) { t.addEventListener(ty, fn, opts); listeners.push({ t: t, ty: ty, fn: fn, opts: opts }); }
      function onRoom(evt, fn) { room.on(evt, fn); roomOffs.push(function () { room.off(evt, fn); }); }
      function addStop(fn) { if (fn) stopsFns.push(fn); }
      function cleanup() {
        dead = true;
        if (raf) { cancelAnimationFrame(raf); raf = null; }
        timers.forEach(clearTimeout); timers = [];
        listeners.forEach(function (l) { try { l.t.removeEventListener(l.ty, l.fn, l.opts); } catch (e) {} }); listeners = [];
        roomOffs.forEach(function (f) { try { f(); } catch (e) {} }); roomOffs = [];
        stopsFns.forEach(function (f) { try { f(); } catch (e) {} }); stopsFns = [];
      }

      /* ---- Laufzeit / Ansicht ---- */
      var canvas = null, ctx2d = null, refs = null;
      var busy = false, touchAiming = false, keyAttached = false, onThrow = null;
      var view = { stuck: [], flyQueue: [], flying: null, aim: { x: CX, y: CY - 95 }, chX: CX, chY: CY - 95, canAim: false, amp: 30 };

      /* Solo-Spielstand */
      var game = null, visitCounter = 0;
      /* Multiplayer-Spiegel */
      var lastShared = null, localVisitId = -1, animatedCount = 0, lastReported = -1;
      var multiEndShown = false, multiEndTimer = null, wdTimer = null;

      /* ===================== START ===================== */
      if (mode === 'multi' && room) startMultiFlow(); else soloIntro();
      return { cleanup: cleanup };

      /* ===================== ZEICHNEN ===================== */
      function startDrawLoop() { if (raf) return; last = Date.now(); loop(); }
      function stopDrawLoop() { if (raf) { cancelAnimationFrame(raf); raf = null; } }
      function loop() { if (dead) return; drawFrame(); raf = requestAnimationFrame(loop); }
      function drawFrame() {
        var g = ctx2d; if (!g) return;
        var now = Date.now();
        g.clearRect(0, 0, CV, CV);
        g.drawImage(getBoardCv(), 0, 0);
        var i;
        for (i = 0; i < view.stuck.length; i++) { var d = view.stuck[i]; drawDart(g, d.x, d.y, d.color, 1, 1); }
        advanceFlying(now, g);
        if (view.canAim && !busy && !view.flying) drawCrosshair(g, now);
      }
      function advanceFlying(now, g) {
        if (!view.flying) return;
        var fl = view.flying, p = (now - fl.t0) / FLIGHT_MS;
        if (p >= 1) {
          view.stuck.push({ x: fl.x, y: fl.y, color: fl.color });
          if (App.Audio) App.Audio.sfx('hit');
          var cb = fl.cb; view.flying = null;
          if (cb) cb();
          startNextFly();
          return;
        }
        var ease = 1 - Math.pow(1 - p, 2);
        var x = fl.sx + (fl.x - fl.sx) * ease;
        var y = fl.sy + (fl.y - fl.sy) * ease - Math.sin(p * Math.PI) * 26;
        drawDart(g, x, y, fl.color, 1.8 - 0.8 * ease, 0.5 + 0.5 * p);
      }
      function animateDart(x, y, color, cb) {
        view.flyQueue.push({ x: x, y: y, color: color, cb: cb || null });
        if (App.Audio) App.Audio.sfx('whoosh');
        if (!view.flying) startNextFly();
      }
      function startNextFly() {
        if (view.flying || !view.flyQueue.length) return;
        var d = view.flyQueue.shift();
        view.flying = { x: d.x, y: d.y, color: d.color, cb: d.cb, t0: Date.now(), sx: CX + (Math.random() * 40 - 20), sy: CY + R_DOUT + 70 };
      }
      function drawCrosshair(g, now) {
        var amp = view.amp;
        var wx = amp * (0.62 * Math.sin(now * 0.006) + 0.38 * Math.sin(now * 0.017 + 1.3));
        var wy = amp * (0.62 * Math.cos(now * 0.005 + 0.5) + 0.38 * Math.sin(now * 0.013 + 2.1));
        var cx = view.aim.x + wx, cy = view.aim.y + wy;
        view.chX = cx; view.chY = cy;
        g.save();
        g.strokeStyle = 'rgba(255,255,255,0.92)'; g.lineWidth = 1.6; g.shadowColor = 'rgba(57,255,20,0.9)'; g.shadowBlur = 10;
        g.beginPath(); g.arc(cx, cy, 11, 0, Math.PI * 2); g.stroke();
        g.beginPath();
        g.moveTo(cx - 16, cy); g.lineTo(cx - 5, cy); g.moveTo(cx + 5, cy); g.lineTo(cx + 16, cy);
        g.moveTo(cx, cy - 16); g.lineTo(cx, cy - 5); g.moveTo(cx, cy + 5); g.lineTo(cx, cy + 16);
        g.stroke();
        g.fillStyle = 'rgba(57,255,20,0.95)'; g.beginPath(); g.arc(cx, cy, 2, 0, Math.PI * 2); g.fill();
        g.restore();
      }
      function resetVisitBoard() { view.stuck = []; view.flyQueue = []; view.flying = null; }

      /* ===================== EINGABE ===================== */
      function toCanvas(e) { var r = canvas.getBoundingClientRect(); return { x: (e.clientX - r.left) / r.width * CV, y: (e.clientY - r.top) / r.height * CV }; }
      function setAim(x, y) {
        var dx = x - CX, dy = y - CY, d = Math.sqrt(dx * dx + dy * dy);
        if (d > R_DOUT) { dx = dx / d * R_DOUT; dy = dy / d * R_DOUT; }
        view.aim.x = CX + dx; view.aim.y = CY + dy;
      }
      function inputAllowed() { return view.canAim && !busy && !view.flying && !dead; }
      function currentThrowPoint() {
        var s = Math.max(2, view.amp * 0.16);
        return { x: (view.chX == null ? view.aim.x : view.chX) + gauss() * s, y: (view.chY == null ? view.aim.y : view.chY) + gauss() * s };
      }
      function doThrow() { if (!inputAllowed() || !onThrow) return; onThrow(currentThrowPoint()); }
      function attachPointer(cv) {
        addL(cv, 'pointermove', function (e) { if (!view.canAim) return; if (e.pointerType === 'touch' && !touchAiming) return; var p = toCanvas(e); setAim(p.x, p.y); });
        addL(cv, 'pointerdown', function (e) { if (!inputAllowed()) return; e.preventDefault(); var p = toCanvas(e); setAim(p.x, p.y); if (e.pointerType === 'touch') touchAiming = true; else doThrow(); });
        addL(cv, 'pointerup', function (e) { if (e.pointerType === 'touch' && touchAiming) { touchAiming = false; doThrow(); } });
        addL(cv, 'pointercancel', function () { touchAiming = false; });
      }
      function attachKey() {
        if (keyAttached) return; keyAttached = true;
        addL(document, 'keydown', function (e) { if ((e.key === ' ' || e.key === 'Enter') && inputAllowed()) { e.preventDefault(); doThrow(); } });
      }

      /* ===================== BUEHNE / HUD ===================== */
      function buildStage() {
        var canvasEl = el('canvas', { class: 'drt-canvas', width: CV, height: CV, 'aria-label': 'Dartscheibe' });
        canvas = canvasEl; ctx2d = canvasEl.getContext('2d');
        var chipsWrap = el('div', { class: 'drt-chips' });
        var statusEl = el('div', { class: 'drt-status' }, ['']);
        var pipEls = [], pipsWrap = el('div', { class: 'drt-pips' });
        for (var i = 0; i < 3; i++) { var pe = el('div', { class: 'drt-pip' }, ['·']); pipEls.push(pe); pipsWrap.appendChild(pe); }
        var totalEl = el('div', { class: 'drt-vn-v' }, ['0']);
        var restEl = el('div', { class: 'drt-vn-v drt-rest' }, ['501']);
        var visitRow = el('div', { class: 'drt-visit glass' }, [
          el('div', { class: 'drt-visit-head' }, [el('span', { class: 'drt-visit-l' }, ['Aufnahme']), pipsWrap]),
          el('div', { class: 'drt-visit-nums' }, [
            el('div', { class: 'drt-vn' }, [el('span', { class: 'drt-vn-l' }, ['Wurf']), totalEl]),
            el('div', { class: 'drt-vn' }, [el('span', { class: 'drt-vn-l' }, ['Rest']), restEl])
          ])
        ]);
        var checkoutEl = el('div', { class: 'drt-checkout' }, ['']);
        var hintEl = el('div', { class: 'drt-hint hint-text' }, ['Ziehen & loslassen (oder klicken) zum Werfen · 3 Darts · Finish nur mit Doppel · Bull = 50']);
        var wrap = el('div', { class: 'drt-wrap' }, [
          el('div', { class: 'drt-top' }, [el('div', { class: 'drt-brand neon' }, ['🎯 501 Dart']), el('div', { class: 'drt-leginfo' }, ['Double-Out'])]),
          chipsWrap, statusEl, el('div', { class: 'drt-stage' }, [canvasEl]), visitRow, checkoutEl, hintEl
        ]);
        root.innerHTML = ''; root.appendChild(wrap);
        refs = { chipsWrap: chipsWrap, statusEl: statusEl, pipEls: pipEls, totalEl: totalEl, restEl: restEl, checkoutEl: checkoutEl, chipEls: [] };
        attachPointer(canvasEl);
      }
      function ensureChips(n) {
        if (refs.chipEls.length === n) return;
        refs.chipsWrap.innerHTML = ''; refs.chipEls = [];
        for (var i = 0; i < n; i++) {
          var nameEl = el('div', { class: 'drt-chip-name' }, ['—']);
          var remEl = el('div', { class: 'drt-chip-rem' }, ['501']);
          var tagEl = el('div', { class: 'drt-chip-tag' }, ['']);
          var chip = el('div', { class: 'drt-chip' }, [nameEl, remEl, tagEl]);
          refs.chipsWrap.appendChild(chip);
          refs.chipEls.push({ chip: chip, name: nameEl, rem: remEl, tag: tagEl });
        }
      }
      function pipCls(d) { return d.v === 0 ? 'miss' : d.m === 3 ? 'triple' : d.m === 2 ? 'double' : 'single'; }
      function updateHud(state) {
        if (!refs) return;
        ensureChips(state.players.length);
        state.players.forEach(function (p, i) {
          var c = refs.chipEls[i]; if (!c) return;
          c.name.textContent = p.name + (p.isMe ? ' (du)' : '');
          c.rem.textContent = String(p.rem);
          c.rem.style.color = p.color;
          c.chip.className = 'drt-chip' + (p.current ? ' active' : '') + (p.isMe ? ' me' : '') + (p.win ? ' win' : '');
          c.chip.style.borderColor = p.current ? p.color : '';
          c.tag.textContent = p.win ? '🏆 Sieger' : (p.current ? '● am Wurf' : '');
        });
        refs.statusEl.textContent = state.statusText;
        refs.statusEl.className = 'drt-status ' + state.statusCls;
        for (var i = 0; i < 3; i++) {
          var pe = refs.pipEls[i], d = state.visit[i];
          if (d) { pe.textContent = labelFor(d.v, d.m); pe.className = 'drt-pip filled ' + pipCls(d); }
          else { pe.textContent = '·'; pe.className = 'drt-pip'; }
        }
        refs.totalEl.textContent = String(state.visitTotal);
        refs.restEl.textContent = state.restText;
        refs.restEl.className = 'drt-vn-v drt-rest' + (state.bust ? ' bust' : '');
        refs.checkoutEl.textContent = state.checkout ? ('🎯 Finish: ' + state.checkout) : '';
        refs.checkoutEl.style.display = state.checkout ? '' : 'none';
      }

      /* ===================== SOLO ===================== */
      function soloIntro() {
        stopDrawLoop();
        var diffs = [
          { name: 'Leicht', sigma: 44, idx: 0 },
          { name: 'Mittel', sigma: 26, idx: 1 },
          { name: 'Profi', sigma: 14, idx: 2 },
          { name: 'Weltklasse', sigma: 7, idx: 3 }
        ];
        root.innerHTML = '';
        root.appendChild(el('div', { class: 'drt-intro glass' }, [
          el('div', { class: 'drt-intro-icon' }, ['🎯']),
          el('h2', { class: 'neon' }, ['501 Dart']),
          el('p', { class: 'hint-text' }, ['Wirf von 501 genau auf 0 – und beende mit einem Doppel (Bull zaehlt). Wie stark soll der Bot sein?']),
          el('div', { class: 'drt-diffs' }, diffs.map(function (d) {
            return el('button', { class: 'btn btn-primary drt-diff', type: 'button', onclick: function () { startSolo(d); } }, [
              el('span', { class: 'drt-diff-name' }, [d.name]),
              el('span', { class: 'drt-diff-sub' }, [d.idx === 0 ? 'wackelt oft' : d.idx === 1 ? 'solide' : d.idx === 2 ? 'trifft Doppel' : 'fast perfekt'])
            ]);
          })),
          el('p', { class: 'drt-rules hint-text' }, ['Ziehen & loslassen zum Werfen · je weiter das Spiel, desto ruhiger die Hand'])
        ]));
      }

      function startSolo(diff) {
        game = {
          players: [
            { id: me.id, name: me.name, rem: 501, color: PCOL[0], bot: false },
            { id: 'bot', name: 'Bot · ' + diff.name, rem: 501, color: PCOL[3], bot: true, sigma: diff.sigma }
          ],
          turnIdx: 0, over: false, winnerIdx: -1, thrown: 0, myDarts: 0, diffIndex: diff.idx, visit: null
        };
        game.visit = newVisit(0, 501);
        busy = false; touchAiming = false; onThrow = humanThrow;
        buildStage(); attachKey(); startDrawLoop();
        refreshSolo();
        maybeBotTurn();
      }
      function newVisit(idx, startRem) { visitCounter++; return { id: visitCounter, thrower: idx, startRem: startRem, darts: [] }; }

      function humanThrow(landing) {
        var G = game; if (!G || G.over) return;
        var pl = G.players[G.turnIdx]; if (pl.bot) return;
        var ev = evalVisit(G.visit.startRem, G.visit.darts);
        if (ev.status !== 'ok' || G.visit.darts.length >= 3) return;
        G.myDarts++; G.thrown++;
        processSoloDart(G, landing, pl);
      }
      function processSoloDart(G, landing, thrower) {
        var res = evaluate(landing.x, landing.y);
        G.visit.darts.push({ v: res.value, m: res.mult, x: landing.x, y: landing.y });
        busy = true; view.canAim = false;
        refreshSolo();
        animateDart(landing.x, landing.y, thrower.color, function () { afterSoloDart(G); });
      }
      function afterSoloDart(G) {
        if (dead || G.over) return;
        var ev = evalVisit(G.visit.startRem, G.visit.darts);
        if (ev.status === 'win') {
          G.players[G.turnIdx].rem = 0; G.over = true; G.winnerIdx = G.turnIdx;
          if (App.Audio) App.Audio.sfx('jackpot');
          refreshSolo(); timer(1200, showSoloEnd); return;
        }
        if (ev.status === 'bust' || G.visit.darts.length >= 3) {
          if (ev.status === 'bust' && App.Audio) App.Audio.sfx('error');
          timer(1100, function () { endSoloVisit(G); }); return;
        }
        var pl = G.players[G.turnIdx];
        if (pl.bot) { timer(650, function () { botTurnStep(G); }); }
        else { busy = false; refreshSolo(); }
      }
      function endSoloVisit(G) {
        if (dead || G.over) return;
        var ev = evalVisit(G.visit.startRem, G.visit.darts);
        if (ev.status === 'ok') G.players[G.turnIdx].rem = ev.tentative;
        G.turnIdx = (G.turnIdx + 1) % G.players.length;
        resetVisitBoard();
        G.visit = newVisit(G.turnIdx, G.players[G.turnIdx].rem);
        busy = false;
        refreshSolo();
        maybeBotTurn();
      }
      function maybeBotTurn() {
        var G = game; if (!G || G.over) return;
        if (G.players[G.turnIdx].bot) timer(750, function () { botTurnStep(G); });
      }
      function botTurnStep(G) {
        if (dead || G.over) return;
        var pl = G.players[G.turnIdx]; if (!pl.bot) return;
        var ev = evalVisit(G.visit.startRem, G.visit.darts);
        if (ev.status !== 'ok' || G.visit.darts.length >= 3) { endSoloVisit(G); return; }
        G.thrown++;
        var lp = botTargetPoint(ev.tentative, 3 - G.visit.darts.length, pl.sigma);
        processSoloDart(G, lp, pl);
      }
      function refreshSolo() {
        var G = game; if (!G) return;
        var pl = G.players[G.turnIdx];
        var ev = evalVisit(G.visit.startRem, G.visit.darts);
        view.canAim = !pl.bot && !G.over && ev.status === 'ok' && G.visit.darts.length < 3;
        view.amp = steadyAmp(G.thrown);
        var players = G.players.map(function (p, i) {
          var rem;
          if (G.over && i === G.winnerIdx) rem = 0;
          else if (i === G.turnIdx && !G.over) rem = ev.status === 'bust' ? G.visit.startRem : Math.max(0, ev.tentative);
          else rem = p.rem;
          return { name: p.name, rem: rem, color: p.color, isMe: i === 0, current: i === G.turnIdx && !G.over, win: G.over && i === G.winnerIdx };
        });
        var st = soloStatus(G, ev, pl);
        updateHud({
          players: players, statusText: st.text, statusCls: st.cls,
          visit: G.visit.darts, visitTotal: sumDarts(G.visit.darts),
          restText: ev.status === 'bust' ? 'BUST' : String(Math.max(0, ev.tentative)),
          bust: ev.status === 'bust',
          checkout: checkoutHint(ev, G.visit.darts.length, G.over)
        });
      }
      function soloStatus(G, ev, pl) {
        if (G.over) return G.winnerIdx === 0 ? { text: '🎉 Checkout! Du gewinnst!', cls: 'win' } : { text: '💀 Bot checkt aus – verloren', cls: 'lose' };
        if (ev.status === 'bust') return { text: '💥 Bust! Aufnahme verfällt', cls: 'bust' };
        if (pl.bot) return { text: '🤖 ' + pl.name + ' zielt …', cls: 'opp' };
        return { text: '🎯 Du bist dran · Dart ' + (G.visit.darts.length + 1) + '/3', cls: 'you' };
      }
      function showSoloEnd() {
        stopDrawLoop();
        var G = game, won = G.winnerIdx === 0;
        if (won && App.Scores) App.Scores.winCurrent();
        var pointsScored = 501 - G.players[0].rem;
        var score = won ? (501 + Math.max(0, 90 - G.myDarts) * 3 + G.diffIndex * 40) : pointsScored;
        var best = App.Storage.get('best_darts', 0);
        var nb = score > best; if (nb) App.Storage.set('best_darts', score);
        view.canAim = false;
        App.MG.endScreen(root, {
          score: score, best: best, newBest: nb,
          label: won ? ('Gewonnen mit ' + G.myDarts + ' Darts' + (nb ? ' · neuer Rekord! 🎉' : ' · Bestwert: ' + App.MG.fmt(best))) : ('Verloren · ' + pointsScored + ' Punkte geworfen'),
          onExit: ctx.onExit,
          onAgain: function () { soloIntro(); }
        });
      }

      /* ===================== MULTIPLAYER ===================== */
      function startMultiFlow() {
        onThrow = myThrow;
        var snap = room.snapshot() || {};
        var startAt = (snap.round && snap.round.startAt) || (room.now() + 3000);
        addStop(App.MG.countdown(root, startAt, function () { if (!dead) beginMulti(); }, room.now));
      }
      function beginMulti() {
        buildStage(); attachKey(); startDrawLoop();
        lastShared = (room.snapshot() && room.snapshot().shared) || null;
        onRoom('shared', function (sh) { lastShared = sh; syncMulti(); });
        onRoom('players', function () { syncMulti(); });
        if (room.isHost() && !(lastShared && lastShared.order)) initShared(room.players());
        syncMulti();
      }
      function initShared(ps) {
        var order = ps.map(function (p) { return p.id; });
        var rem = {}; order.forEach(function (id) { rem[id] = 501; });
        room.setShared({ order: order, rem: rem, turnIdx: 0, leg: 1, legWinner: null, thrown: 0, visit: { id: 1, thrower: order[0], startRem: 501, darts: [] }, ts: room.now() });
      }
      function findP(ps, id) { for (var i = 0; i < ps.length; i++) if (ps[i].id === id) return ps[i]; return null; }
      function presentSet(ps) { var m = {}; ps.forEach(function (p) { m[p.id] = true; }); return m; }
      function nextPresentIdx(order, cur, ps) {
        var pres = presentSet(ps), n = order.length, i, k;
        for (i = 1; i <= n; i++) { k = (cur + i) % n; if (pres[order[k]]) return k; }
        return (cur + 1) % n;
      }
      function syncMulti() {
        if (dead || !refs) return;
        var sh = lastShared, ps = room.players();
        if (!sh || !sh.order) {
          if (room.isHost() && ps.length >= 2) initShared(ps);
          refs.statusEl.textContent = 'Bereite Spiel vor …'; refs.statusEl.className = 'drt-status opp';
          view.canAim = false; return;
        }
        // Eigene Punktzahl (501 - Rest) fuer Live-Rangliste / Endscreen melden
        var myR = (sh.rem && sh.rem[me.id] != null) ? sh.rem[me.id] : 501;
        if (sh.legWinner === me.id) myR = 0;
        var sc = 501 - myR;
        if (sc !== lastReported) { lastReported = sc; try { room.reportScore(sc); } catch (e) {} }

        var v = sh.visit;
        if (v && v.id !== localVisitId) { localVisitId = v.id; animatedCount = 0; resetVisitBoard(); busy = false; touchAiming = false; }
        if (v) {
          var col = PCOL[Math.max(0, sh.order.indexOf(v.thrower)) % PCOL.length];
          while (animatedCount < v.darts.length) { var dd = v.darts[animatedCount]; animateDart(dd.x, dd.y, col); animatedCount++; }
        }
        // Eingabe / Fadenkreuz
        if (!sh.legWinner && v && v.thrower === me.id) {
          var evM = evalVisit(v.startRem, v.darts);
          view.canAim = evM.status === 'ok' && v.darts.length < 3;
          busy = false;
        } else { view.canAim = false; }
        view.amp = steadyAmp(sh.thrown || 0);

        updateHud(buildHudMulti(sh, ps));
        if (sh.legWinner) scheduleMultiEnd(sh);
        if (room.isHost()) watchdog(sh, ps);
      }
      function buildHudMulti(sh, ps) {
        var order = sh.order, v = sh.visit;
        var ev = evalVisit(v.startRem, v.darts);
        var players = order.map(function (id, i) {
          var p = findP(ps, id), rem;
          if (sh.legWinner === id) rem = 0;
          else if (id === v.thrower) rem = ev.status === 'bust' ? v.startRem : Math.max(0, ev.tentative);
          else rem = (sh.rem && sh.rem[id] != null) ? sh.rem[id] : 501;
          return { name: p ? p.name : 'Spieler', rem: rem, color: PCOL[i % PCOL.length], isMe: id === me.id, current: id === v.thrower && !sh.legWinner, win: sh.legWinner === id };
        });
        var st = multiStatus(sh, ps, v, ev);
        return {
          players: players, statusText: st.text, statusCls: st.cls,
          visit: v.darts, visitTotal: sumDarts(v.darts),
          restText: ev.status === 'bust' ? 'BUST' : String(Math.max(0, ev.tentative)),
          bust: ev.status === 'bust' && !sh.legWinner,
          checkout: sh.legWinner ? null : checkoutHint(ev, v.darts.length, false)
        };
      }
      function multiStatus(sh, ps, v, ev) {
        if (sh.legWinner) {
          if (sh.legWinner === me.id) return { text: '🎉 Checkout! Du gewinnst!', cls: 'win' };
          var wn = findP(ps, sh.legWinner);
          return { text: '🏁 ' + (wn ? wn.name : 'Spieler') + ' checkt aus', cls: 'lose' };
        }
        if (ev.status === 'bust') return { text: '💥 Bust! Aufnahme verfällt', cls: 'bust' };
        if (v.thrower === me.id) return { text: '🎯 Du bist dran · Dart ' + (v.darts.length + 1) + '/3', cls: 'you' };
        var tp = findP(ps, v.thrower);
        return { text: (tp ? tp.name : 'Spieler') + ' wirft … (' + (v.darts.length + 1) + '/3)', cls: 'opp' };
      }
      function myThrow(landing) {
        var sh = lastShared; if (!sh || sh.legWinner) return;
        var v = sh.visit; if (!v || v.thrower !== me.id) return;
        var evNow = evalVisit(v.startRem, v.darts);
        if (evNow.status !== 'ok' || v.darts.length >= 3 || busy) return;
        busy = true; view.canAim = false;
        var res = evaluate(landing.x, landing.y);
        var darts = v.darts.slice();
        darts.push({ v: res.value, m: res.mult, x: Math.round(landing.x), y: Math.round(landing.y) });
        var ev = evalVisit(v.startRem, darts);
        var patch = { visit: { id: v.id, thrower: v.thrower, startRem: v.startRem, darts: darts }, thrown: (sh.thrown || 0) + 1, ts: room.now() };
        if (ev.status === 'win') { var rem = Object.assign({}, sh.rem || {}); rem[me.id] = 0; patch.rem = rem; patch.legWinner = me.id; }
        try { room.setShared(patch); } catch (e) {}
        if (ev.status !== 'win' && (ev.status === 'bust' || darts.length >= 3)) scheduleAdvance(v.id);
      }
      function scheduleAdvance(vid) {
        timer(1350, function () {
          var sh = lastShared; if (!sh || sh.legWinner) return;
          var v = sh.visit; if (!v || v.id !== vid || v.thrower !== me.id) return;
          advanceMulti(sh);
        });
      }
      function advanceMulti(sh) {
        var v = sh.visit, ev = evalVisit(v.startRem, v.darts);
        var rem = Object.assign({}, sh.rem || {});
        if (ev.status === 'ok') rem[v.thrower] = ev.tentative;   // Bust: Stand bleibt
        var ni = nextPresentIdx(sh.order, sh.turnIdx, room.players());
        var nid = sh.order[ni], startRem = (rem[nid] != null) ? rem[nid] : 501;
        try { room.setShared({ rem: rem, turnIdx: ni, visit: { id: v.id + 1, thrower: nid, startRem: startRem, darts: [] }, ts: room.now() }); } catch (e) {}
      }
      function watchdog(sh, ps) {
        if (sh.legWinner) { if (wdTimer) { clearTimeout(wdTimer); wdTimer = null; } return; }
        var pres = presentSet(ps);
        if (pres[sh.visit.thrower]) { if (wdTimer) { clearTimeout(wdTimer); wdTimer = null; } return; }
        if (wdTimer) return;
        wdTimer = timer(1900, function () {
          wdTimer = null;
          var s = lastShared; if (!s || s.legWinner) return;
          if (presentSet(room.players())[s.visit.thrower]) return;   // wieder da
          var rem = Object.assign({}, s.rem || {});                  // Werfer weg -> als Bust behandeln
          var ni = nextPresentIdx(s.order, s.turnIdx, room.players());
          var nid = s.order[ni], startRem = (rem[nid] != null) ? rem[nid] : 501;
          try { room.setShared({ rem: rem, turnIdx: ni, visit: { id: s.visit.id + 1, thrower: nid, startRem: startRem, darts: [] }, ts: room.now() }); } catch (e) {}
        });
      }
      function scheduleMultiEnd(sh) {
        if (multiEndShown || multiEndTimer) return;
        if (sh.legWinner === me.id && App.Audio) App.Audio.sfx('jackpot');
        multiEndTimer = timer(1700, function () { multiEndTimer = null; showMultiEnd(); });
      }
      function showMultiEnd() {
        if (multiEndShown) return; multiEndShown = true;
        stopDrawLoop();
        var sh = lastShared;
        if (sh && sh.legWinner === me.id && App.Scores) App.Scores.winCurrent();
        App.MG.endScreen(root, { players: room.players(), meId: me.id, onExit: ctx.onExit });
      }

      /* ---- gemeinsame kleine Helfer ---- */
      function checkoutHint(ev, dartsThrown, over) {
        if (over || ev.status !== 'ok') return null;
        var rem = ev.tentative;
        if (rem < 2 || rem > 170) return null;
        var co = checkout(rem, 3 - dartsThrown);
        return co ? checkoutText(co) : null;
      }
    }
  };

  /* ============================ STYLES ============================ */
  function injectStyle() {
    UI.injectStyle('mg-darts-css', [
      '.drt-wrap{display:flex;flex-direction:column;gap:12px;max-width:520px;margin:0 auto;}',
      '.drt-top{display:flex;justify-content:space-between;align-items:center;gap:10px;}',
      '.drt-brand{font-weight:900;font-size:18px;}',
      '.drt-leginfo{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:2px;font-weight:800;}',
      /* Spieler-Chips */
      '.drt-chips{display:flex;gap:8px;overflow-x:auto;padding-bottom:2px;}',
      '.drt-chip{flex:1 0 auto;min-width:96px;display:flex;flex-direction:column;gap:1px;padding:8px 11px;border-radius:13px;background:rgba(9,32,21,.6);border:1px solid var(--stroke);transition:border-color .15s,box-shadow .2s,transform .15s;}',
      '.drt-chip-name{font-weight:800;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--silver);}',
      '.drt-chip.me .drt-chip-name{color:var(--aqua);}',
      '.drt-chip-rem{font-size:26px;font-weight:900;line-height:1;font-variant-numeric:tabular-nums;color:var(--leaf);}',
      '.drt-chip-tag{font-size:10px;font-weight:800;letter-spacing:.5px;color:var(--muted);min-height:13px;text-transform:uppercase;}',
      '.drt-chip.active{box-shadow:0 0 0 1px currentColor,0 0 16px rgba(57,255,20,.28);transform:translateY(-2px);}',
      '.drt-chip.active .drt-chip-tag{color:var(--neon);}',
      '.drt-chip.win{border-color:var(--gold)!important;box-shadow:0 0 0 1px var(--gold),0 0 20px rgba(255,210,63,.45);}',
      '.drt-chip.win .drt-chip-tag{color:var(--gold);}',
      /* Status */
      '.drt-status{text-align:center;font-weight:900;font-size:clamp(15px,4.4vw,20px);min-height:26px;transition:color .15s;}',
      '.drt-status.you{color:var(--neon);text-shadow:0 0 10px rgba(57,255,20,.4);}',
      '.drt-status.opp{color:var(--aqua);}',
      '.drt-status.win{color:var(--gold);text-shadow:0 0 12px rgba(255,210,63,.5);}',
      '.drt-status.lose{color:var(--danger);}',
      '.drt-status.bust{color:var(--danger-2);animation:drt-shake .3s ease;}',
      /* Scheibe */
      '.drt-stage{width:100%;max-width:360px;margin:0 auto;}',
      '.drt-canvas{display:block;width:100%;height:auto;border-radius:50%;background:#04120b;',
      'box-shadow:0 0 40px rgba(57,255,20,.2),inset 0 0 40px rgba(0,0,0,.5);',
      'touch-action:none;user-select:none;-webkit-user-select:none;-webkit-tap-highlight-color:transparent;cursor:crosshair;}',
      /* Aufnahme-Zeile */
      '.drt-visit{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 16px;flex-wrap:wrap;}',
      '.drt-visit-head{display:flex;align-items:center;gap:10px;min-width:0;}',
      '.drt-visit-l{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;font-weight:800;}',
      '.drt-pips{display:flex;gap:7px;}',
      '.drt-pip{min-width:38px;text-align:center;padding:5px 8px;border-radius:9px;background:rgba(4,16,10,.7);border:1px solid var(--stroke);font-weight:900;font-size:14px;color:var(--muted);font-variant-numeric:tabular-nums;transition:.15s;}',
      '.drt-pip.filled{animation:drt-pop .2s ease;}',
      '.drt-pip.single{color:var(--leaf);border-color:var(--stroke-2);}',
      '.drt-pip.double{color:var(--aqua);border-color:rgba(51,230,208,.5);text-shadow:0 0 8px rgba(51,230,208,.4);}',
      '.drt-pip.triple{color:var(--gold);border-color:rgba(255,210,63,.5);text-shadow:0 0 8px rgba(255,210,63,.45);}',
      '.drt-pip.miss{color:var(--danger);border-color:rgba(255,77,109,.4);}',
      '.drt-visit-nums{display:flex;gap:16px;}',
      '.drt-vn{display:flex;flex-direction:column;align-items:center;gap:1px;}',
      '.drt-vn-l{font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;}',
      '.drt-vn-v{font-size:22px;font-weight:900;line-height:1;color:var(--leaf);font-variant-numeric:tabular-nums;}',
      '.drt-rest{color:var(--aqua-soft);}',
      '.drt-rest.bust{color:var(--danger);text-shadow:0 0 10px rgba(255,77,109,.5);}',
      /* Checkout */
      '.drt-checkout{text-align:center;font-weight:800;font-size:14px;color:var(--gold);min-height:18px;text-shadow:0 0 10px rgba(255,210,63,.35);}',
      '.drt-hint{text-align:center;}',
      /* Intro */
      '.drt-intro{padding:30px 24px;text-align:center;display:flex;flex-direction:column;gap:14px;align-items:center;max-width:460px;margin:0 auto;}',
      '.drt-intro-icon{font-size:56px;filter:drop-shadow(0 0 16px rgba(57,255,20,.5));animation:drt-bob 2.2s ease-in-out infinite;}',
      '.drt-diffs{display:grid;grid-template-columns:1fr 1fr;gap:10px;width:100%;}',
      '.drt-diff{display:flex;flex-direction:column;gap:2px;padding:14px 10px;height:auto;}',
      '.drt-diff-name{font-weight:900;font-size:16px;}',
      '.drt-diff-sub{font-size:11px;font-weight:700;opacity:.85;}',
      '.drt-rules{margin:0;}',
      /* Animationen */
      '@keyframes drt-pop{0%{transform:scale(.5)}70%{transform:scale(1.18)}100%{transform:scale(1)}}',
      '@keyframes drt-shake{0%,100%{transform:translateX(0)}25%{transform:translateX(-6px)}75%{transform:translateX(6px)}}',
      '@keyframes drt-bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-7px)}}'
    ].join(''));
  }
})();
