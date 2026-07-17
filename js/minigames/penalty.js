/* penalty.js — "Elfmeterschießen": Fussball-Elfmeter-Duell im Neon-Dschungel.
 *
 * IDEE
 *   Abwechselnd schiessen und halten – wie ein echtes Elfmeterschiessen.
 *   Je 5 Schuesse pro Team, bei Gleichstand K.o.-Sudden-Death.
 *
 * STEUERUNG
 *   SCHIESSEN: Ins Tor tippen/ziehen = Ecke + Hoehe zielen (oder eine Ecke antippen).
 *              Der Kraft-Balken pendelt 0→100→0; mit "SCHUSS" die Kraft festnageln.
 *              Der Ball fliegt mit leichter Kurve. Viel Kraft = schwerer haltbar,
 *              aber hoch gezielt + volle Kraft = Gefahr, drueber zu schiessen.
 *   HALTEN:    Der Torwart tippt eine der 6 Ecken zum Hechten – ohne zu wissen,
 *              wohin geschossen wird (kein Vorwissen). Richtige Ecke = grosse
 *              Chance zu halten; perfekt platzierte, harte Ecken sind trotzdem drin.
 *
 * PUNKTE   Jedes erzielte Tor als Schuetze zaehlt. Wer nach 5 (bzw. Sudden Death)
 *          mehr Tore hat, gewinnt. Frueher Abbruch, sobald rechnerisch entschieden.
 *
 * SYNC-MODELL (Multiplayer, rundenbasiert ueber room.shared)
 *   shared = { order:[id0,id1], kick, phase:'aim'|'resolve'|'over',
 *              shooter, keeper, shot:{tx,ty,power,curve,seed}|null,
 *              dive:0..5|null, resolveAt, result, land, goals{}, shots{}, hist{},
 *              seriesOver, winner }
 *   Der Schuetze legt shot ab, der Torwart legt dive ab (ohne shot zu sehen).
 *   Der Host rechnet das Ergebnis deterministisch (resolve) und setzt resolveAt
 *   (Serverzeit). Beide Clients animieren denselben Schuss synchron. Danach
 *   schaltet nur der Host auf die naechste Runde bzw. beendet die Serie.
 *
 * SOLO   Gegen einen Bot – mal Schuetze, mal Keeper. 3 Stufen steuern die
 *        Keeper-Reaktion (Ecke erraten) und die Bot-Schussqualitaet.
 *
 * cleanup() beendet rAF, alle Timer, Listener und room.off fuer jedes room.on. */
(function () {
  'use strict';
  window.App = window.App || {}; App.Minigames = App.Minigames || {};
  var UI = App.UI, el = UI.el;

  injectStyle();

  /* ---------- virtuelles Spielfeld (Canvas skaliert per CSS) ---------- */
  var W = 640, H = 480;
  var GX = 100, GY = 70, GW = 440, GH = 200;   // Tor-Oeffnung
  var CX = GX + GW / 2;                          // 320
  var GROUND = GY + GH;                          // Torlinie y=270
  var SPOT = { x: CX, y: 452 };                  // Elfmeterpunkt (nah an der Kamera)
  var FLY = 760, HOLD = 1050;                    // ms Flugzeit + Nachspiel
  var REG = 5;                                   // regulaere Schuesse je Team

  /* 6 Hecht-/Zielzonen (tx in [-1,1] = Pfosten, ty in [0,1] = Boden→Latte) */
  var ZONES = [
    { tx: -0.64, ty: 0.74 }, { tx: 0, ty: 0.74 }, { tx: 0.64, ty: 0.74 },  // oben L/M/R
    { tx: -0.64, ty: 0.30 }, { tx: 0, ty: 0.30 }, { tx: 0.64, ty: 0.30 }   // unten L/M/R
  ];
  var ZLABEL = ['↖', '↑', '↗', '↙', '↓', '↘'];

  /* Farben fuer Canvas (Theme-nah) */
  var C_NEON = '#39ff14', C_AQUA = '#33e6d0', C_GOLD = '#ffd23f',
      C_WHITE = '#eaffe0', C_DANGER = '#ff4d6d', C_LEAF = '#9dff7a';

  /* ---------- reine Mathe-Helfer ---------- */
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function sq(x) { return x * x; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function easeOut(x) { return 1 - (1 - x) * (1 - x); }
  function rnd(seed) { var x = Math.sin(seed * 12.9898) * 43758.5453; return x - Math.floor(x); }
  function randSeed() { return Math.floor(Math.random() * 1e9); }
  function aimToCanvas(tx, ty) { return { x: CX + tx * (GW / 2), y: GROUND - ty * GH }; }
  function nearestZone(tx, ty) {
    var best = 0, bd = 1e9;
    for (var i = 0; i < ZONES.length; i++) {
      var d = sq(tx - ZONES[i].tx) + sq((ty - ZONES[i].ty) * 1.1);
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  }

  /* Deterministische Aufloesung eines Schusses gegen eine Hecht-Zone. */
  function resolve(shot, dive) {
    var ex = shot.tx + (rnd(shot.seed) * 2 - 1) * 0.03;
    var lift = Math.max(0, shot.power - 0.78) * 1.1;          // viel Kraft hebt den Ball
    var ey = shot.ty + lift + (rnd(shot.seed + 7) * 2 - 1) * 0.02;
    var res;
    if (Math.abs(ex) > 1.0 || ey > 1.0 || ey < 0.02) res = 'miss';   // drueber / daneben
    else {
      var reach = 1.15 - shot.power * 0.55;                  // harte Schuesse = weniger Reichweite
      reach = clamp(reach, 0.62, 1.12);
      var Rx = 0.5 * reach, Ry = 0.46 * reach;
      var z = ZONES[dive];
      var d2 = sq((ex - z.tx) / Rx) + sq((ey - z.ty) / Ry);
      res = d2 < 1 ? 'save' : 'goal';
    }
    return { result: res, land: { tx: ex, ty: ey } };
  }

  /* Bot-Keeper: erraet mit Wahrscheinlichkeit read die richtige Ecke. */
  function botDive(shot, read) {
    if (Math.random() < read) return nearestZone(shot.tx, shot.ty);
    return Math.floor(Math.random() * 6);
  }
  /* Bot-Schuetze: je hoeher skill, desto haeufiger platzierte, harte Ecken. */
  function botShot(skill, powerBias) {
    var z;
    if (Math.random() < skill) { var cor = [0, 2, 3, 5]; z = cor[Math.floor(Math.random() * 4)]; }
    else z = Math.floor(Math.random() * 6);
    var base = ZONES[z], jit = (1 - skill) * 0.28;
    var tx = clamp(base.tx + (Math.random() * 2 - 1) * (jit + 0.06), -0.98, 0.98);
    var ty = clamp(base.ty + (Math.random() * 2 - 1) * (jit * 0.6 + 0.04), 0.08, 0.95);
    var power = clamp(powerBias + (Math.random() * 2 - 1) * 0.14, 0.45, 0.98);
    if (Math.random() < (1 - skill) * 0.12) ty = 1.06;       // schwacher Bot ballert drueber
    return { tx: tx, ty: ty, power: power, curve: tx * 0.5, seed: randSeed() };
  }

  /* Wer hat (rechnerisch) gewonnen? null = weiterspielen. order=[a,b] Ids. */
  function decided(goals, shots, order) {
    var a = order[0], b = order[1];
    var ga = goals[a] || 0, gb = goals[b] || 0, sa = shots[a] || 0, sb = shots[b] || 0;
    if (sa < REG || sb < REG) {
      var ra = REG - sa, rb = REG - sb;
      if (ga > gb + rb) return a;
      if (gb > ga + ra) return b;
      return null;
    }
    if (sa === sb && ga !== gb) return ga > gb ? a : b;      // Gleichstand-Runde entschieden
    return null;
  }

  var DIFFS = [
    { id: 'easy', name: 'Anfänger', emoji: '🐣', desc: 'Torwart rät selten – du triffst leicht', read: 0.18, skill: 0.35, power: 0.55 },
    { id: 'med', name: 'Profi', emoji: '⚽', desc: 'Solider Keeper, platzierte Bot-Schüsse', read: 0.40, skill: 0.62, power: 0.68 },
    { id: 'hard', name: 'Weltklasse', emoji: '🧤', desc: 'Liest die Ecke oft – nur perfekte Schüsse zählen', read: 0.62, skill: 0.85, power: 0.80 }
  ];

  /* ============================================================
   *  SZENE – Canvas, Zeichnen, Animation, Steuer-UI (Solo + Multi)
   * ============================================================ */
  function buildScene(root, ctx) {
    var refs = {};
    var canvas, g2d, stage, zoneBtns = [], banner, ctrlWrap, powerFill, shootBtn;
    var raf = null, deadScene = false, listeners = [], timers = [], lastFrame = 0;

    /* Laufzeit-Zustand der Szene */
    var S = {
      mode: 'idle',              // 'idle'|'aim'|'keeper'|'anim'
      aim: { tx: 0, ty: 0.55 }, aimActive: false, pressing: false,
      powerRunning: false, power: 0,
      anim: null, particles: [], shakeUntil: 0, netBulge: null
    };

    function addL(t, ty, fn, o) { t.addEventListener(ty, fn, o); listeners.push({ t: t, ty: ty, fn: fn, o: o }); }
    function after(ms, fn) { var t = setTimeout(function () { if (!deadScene) fn(); }, ms); timers.push(t); return t; }

    mount();
    lastFrame = Date.now();
    raf = requestAnimationFrame(frame);

    /* ---------------------- DOM-Aufbau ---------------------- */
    function mount() {
      /* Kopfzeile: zwei Spieler-Chips + Runden-/Rollen-Badge */
      refs.lName = el('div', { class: 'pen-name' }, ['—']);
      refs.lGoal = el('div', { class: 'pen-goalnum' }, ['0']);
      refs.lDots = el('div', { class: 'pen-dots' });
      refs.lChip = el('div', { class: 'pen-chip pen-chip-l' }, [
        el('div', { class: 'pen-chip-top' }, [refs.lName, refs.lGoal]), refs.lDots
      ]);
      refs.rName = el('div', { class: 'pen-name' }, ['—']);
      refs.rGoal = el('div', { class: 'pen-goalnum' }, ['0']);
      refs.rDots = el('div', { class: 'pen-dots' });
      refs.rChip = el('div', { class: 'pen-chip pen-chip-r' }, [
        el('div', { class: 'pen-chip-top' }, [refs.rGoal, refs.rName]), refs.rDots
      ]);
      refs.badge = el('div', { class: 'pen-badge' }, ['⚽']);
      var head = el('div', { class: 'pen-head glass' }, [refs.lChip, refs.badge, refs.rChip]);

      /* Buehne mit Canvas + Keeper-Zonen-Overlay + Ergebnis-Banner */
      canvas = el('canvas', { class: 'pen-canvas', width: W, height: H });
      var overlay = el('div', { class: 'pen-overlay' });
      for (var i = 0; i < 6; i++) {
        (function (idx) {
          var b = el('button', { class: 'pen-zone', type: 'button' }, [ZLABEL[idx]]);
          b.addEventListener('click', function () { onZone(idx); });
          zoneBtns.push(b); overlay.appendChild(b);
        })(i);
      }
      refs.overlay = overlay;
      banner = el('div', { class: 'pen-banner' }, ['']);
      stage = el('div', { class: 'pen-stage' }, [canvas, overlay, banner]);

      /* Steuer-Bereich (wechselt je nach Rolle) */
      ctrlWrap = el('div', { class: 'pen-ctrl glass' });

      var hint = el('div', { class: 'pen-hint hint-text' }, [
        '⚽ Ins Tor tippen/ziehen = zielen · Balken = Kraft · Torwart: Ecke antippen · 5 Schüsse, dann Sudden Death'
      ]);

      root.innerHTML = '';
      root.appendChild(el('div', { class: 'pen-wrap' }, [head, stage, ctrlWrap, hint]));

      /* Zielen per Zeiger (Maus + Touch) – nur im Schuss-Modus aktiv */
      addL(stage, 'pointerdown', onAimDown);
      addL(stage, 'pointermove', onAimMove);
      addL(window, 'pointerup', onAimUp);
    }

    function onAimDown(e) { if (S.mode !== 'aim') return; S.pressing = true; setAimFromEvent(e); }
    function onAimMove(e) { if (S.mode !== 'aim' || !S.pressing) return; setAimFromEvent(e); }
    function onAimUp() { S.pressing = false; }
    function setAimFromEvent(e) {
      var r = canvas.getBoundingClientRect();
      var cxp = (e.clientX - r.left) / r.width * W;
      var cyp = (e.clientY - r.top) / r.height * H;
      S.aim.tx = clamp((cxp - CX) / (GW / 2), -0.98, 0.98);
      S.aim.ty = clamp((GROUND - cyp) / GH, 0.05, 0.98);
    }

    /* ---------------------- Steuer-Modi ---------------------- */
    function setControls(node) { ctrlWrap.innerHTML = ''; ctrlWrap.appendChild(node); }

    /* Schuetze: zielen + Kraft-Balken + SCHUSS */
    function showAim(onShoot) {
      S.mode = 'aim'; S.aimActive = true; S.anim = null; S.powerRunning = true; hideZones();
      powerFill = el('div', { class: 'pen-pw-fill' });
      var track = el('div', { class: 'pen-pw-track' }, [
        el('div', { class: 'pen-pw-sweet' }), powerFill
      ]);
      shootBtn = el('button', { class: 'btn btn-primary pen-shoot', type: 'button' }, ['⚽ SCHUSS']);
      var fired = false;
      shootBtn.addEventListener('click', function () {
        if (fired || !S.powerRunning) return;
        fired = true;
        var power = S.power;
        S.powerRunning = false; S.aimActive = false; S.mode = 'idle';
        shootBtn.disabled = true;
        if (App.Audio) App.Audio.sfx('whoosh');
        onShoot({ tx: S.aim.tx, ty: S.aim.ty, power: power, curve: S.aim.tx * 0.5, seed: randSeed() });
      });
      setControls(el('div', { class: 'pen-aim-box' }, [
        el('div', { class: 'pen-ctrl-title' }, ['🎯 Zielen & schießen']),
        el('div', { class: 'pen-ctrl-sub' }, ['Ziel im Tor setzen, dann bei guter Kraft „SCHUSS" tippen']),
        el('div', { class: 'pen-pw-row' }, [el('span', { class: 'pen-pw-lbl' }, ['KRAFT']), track]),
        shootBtn
      ]));
    }

    /* Torwart: 6 Ecken antippen (ohne den Schuss zu kennen) */
    function showKeeper(onDive) {
      S.mode = 'keeper'; S.aimActive = false; S.anim = null; S.powerRunning = false; showZones();
      keeperCb = onDive; keeperDone = false;
      setControls(el('div', { class: 'pen-keep-box' }, [
        el('div', { class: 'pen-ctrl-title pen-keep-title' }, ['🧤 Halten!']),
        el('div', { class: 'pen-ctrl-sub' }, ['Tippe eine Ecke im Tor zum Hechten – schnell entscheiden!'])
      ]));
    }
    var keeperCb = null, keeperDone = false;
    function onZone(idx) {
      if (S.mode !== 'keeper' || keeperDone || !keeperCb) return;
      keeperDone = true;
      zoneBtns[idx].classList.add('pen-picked');
      S.mode = 'idle';
      if (App.Audio) App.Audio.sfx('whoosh');
      var cb = keeperCb; keeperCb = null;
      hideZones();
      cb(idx);
    }

    function showWait(msg) {
      S.mode = 'idle'; S.aimActive = false; S.powerRunning = false; hideZones();
      setControls(el('div', { class: 'pen-wait-box' }, [
        el('div', { class: 'pen-spin' }, ['⚽']),
        el('div', { class: 'pen-wait-txt' }, [msg || 'Warte …'])
      ]));
    }
    function showZones() { refs.overlay.classList.add('pen-on'); }
    function hideZones() { refs.overlay.classList.remove('pen-on'); zoneBtns.forEach(function (b) { b.classList.remove('pen-picked'); }); }

    /* ---------------------- Kopf aktualisieren ---------------------- */
    function setHeader(info) {
      refs.lName.textContent = info.lName; refs.rName.textContent = info.rName;
      refs.lGoal.textContent = info.lGoals; refs.rGoal.textContent = info.rGoals;
      refs.lChip.classList.toggle('pen-me', !!info.lMe);
      refs.rChip.classList.toggle('pen-me', !!info.rMe);
      refs.lChip.classList.toggle('pen-shooting', info.shootSide === 'l');
      refs.rChip.classList.toggle('pen-shooting', info.shootSide === 'r');
      dots(refs.lDots, info.lHist); dots(refs.rDots, info.rHist);
      refs.badge.textContent = info.badge;
      refs.badge.className = 'pen-badge' + (info.sudden ? ' pen-sd' : '');
    }
    function dots(cont, hist) {
      cont.innerHTML = '';
      var n = Math.max(REG, hist.length);
      for (var i = 0; i < n; i++) {
        var cls = 'pen-dot';
        if (i < hist.length) cls += hist[i] ? ' pen-scored' : ' pen-missed';
        else cls += ' pen-pending';
        cont.appendChild(el('span', { class: cls }));
      }
    }

    /* ---------------------- Kick-Animation ---------------------- */
    function playKick(shot, dive, result, land, startAt, nowFn, onDone) {
      hideZones(); S.mode = 'anim'; S.aimActive = false; S.powerRunning = false; keeperCb = null;
      var pe = aimToCanvas(land.tx, land.ty);
      var pc = { x: (SPOT.x + pe.x) / 2 + shot.curve * 46, y: Math.min(SPOT.y, pe.y) - (Math.max(0, SPOT.y - pe.y) * 0.22 + 22) };
      var kt = aimToCanvas(ZONES[dive].tx, ZONES[dive].ty);
      S.anim = {
        shot: shot, dive: dive, result: result, land: land,
        startAt: startAt, nowFn: nowFn, onDone: onDone,
        ps: SPOT, pc: pc, pe: pe,
        keeperIdle: { x: CX, y: GROUND - 70 }, keeperTarget: kt,
        reboundDir: (land.tx > 0 ? 1 : land.tx < 0 ? -1 : (Math.random() < 0.5 ? 1 : -1)),
        celebrated: false, doneCalled: false
      };
      S.particles = []; S.netBulge = null;
    }

    function doImpact(a) {
      var pe = a.pe;
      if (a.result === 'goal') {
        S.netBulge = { x: pe.x, y: pe.y, t: Date.now() };
        S.shakeUntil = Date.now() + 260;
        spawnConfetti(pe.x, pe.y);
        setBanner('⚽ TOR!', 'goal');
        if (App.Audio) { App.Audio.sfx('win'); App.Audio.sweep(500, 900, 0.35, { type: 'sawtooth', peak: 0.08 }); }
      } else if (a.result === 'save') {
        setBanner('🧤 GEHALTEN!', 'save');
        if (App.Audio) { App.Audio.sfx('pop'); App.Audio.sfx('ding'); }
      } else {
        setBanner('😵 DANEBEN!', 'miss');
        if (App.Audio) App.Audio.sfx('lose');
      }
    }
    function setBanner(txt, kind) {
      banner.textContent = txt;
      banner.className = 'pen-banner pen-bn-' + kind + ' pen-bn-show';
      after(1150, function () { banner.className = 'pen-banner'; });
    }
    function spawnConfetti(x, y) {
      var cols = [C_NEON, C_AQUA, C_GOLD, C_LEAF, C_WHITE];
      for (var i = 0; i < 30; i++) {
        var ang = Math.random() * Math.PI * 2, sp = 80 + Math.random() * 260;
        S.particles.push({
          x: x, y: y, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp - 120,
          life: 0.9 + Math.random() * 0.6, age: 0, col: cols[Math.floor(Math.random() * cols.length)],
          r: 2 + Math.random() * 3
        });
      }
    }

    /* ---------------------- Render-Schleife ---------------------- */
    function frame() {
      if (deadScene) { raf = null; return; }
      var now = Date.now();
      var dt = (now - lastFrame) / 1000; if (dt < 0) dt = 0; if (dt > 0.05) dt = 0.05; lastFrame = now;
      updateParticles(dt);
      if (S.powerRunning) updatePower();
      draw(now, dt);
      raf = requestAnimationFrame(frame);
    }
    function updatePower() {
      var per = 1100, t = (Date.now() % per) / per;
      S.power = t < 0.5 ? t * 2 : 2 - t * 2;
      if (powerFill) {
        powerFill.style.width = (S.power * 100).toFixed(1) + '%';
        var sweet = S.power >= 0.55 && S.power <= 0.82;
        powerFill.classList.toggle('pen-pw-hot', sweet);
      }
    }
    function updateParticles(dt) {
      for (var i = S.particles.length - 1; i >= 0; i--) {
        var p = S.particles[i]; p.age += dt;
        if (p.age >= p.life) { S.particles.splice(i, 1); continue; }
        p.vy += 520 * dt; p.x += p.vx * dt; p.y += p.vy * dt;
      }
    }

    function draw(now, dt) {
      var g = g2d || (g2d = canvas.getContext('2d'));
      g.save();
      if (now < S.shakeUntil) { var m = (S.shakeUntil - now) / 260 * 6; g.translate((Math.random() * 2 - 1) * m, (Math.random() * 2 - 1) * m); }
      g.clearRect(-20, -20, W + 40, H + 40);
      drawPitch(g);
      drawGoal(g, now);
      /* Keeper- & Ball-Position bestimmen */
      var hx = CX + Math.sin(now / 520) * 8, hy = GROUND - 70;   // Idle-Keeper wippt
      var ball = null;
      if (S.anim) {
        var a = S.anim;
        var tt = a.nowFn() - a.startAt; if (tt < 0) tt = 0;
        var p = tt / FLY, flying = p < 1; if (p > 1) p = 1;
        var kp = easeOut(clamp((p - 0.04) / 0.5, 0, 1));
        hx = lerp(a.keeperIdle.x, a.keeperTarget.x, kp);
        hy = lerp(a.keeperIdle.y, a.keeperTarget.y, kp);
        if (flying) {
          var bp = bez(a, p); ball = { x: bp.x, y: bp.y, r: lerp(15, 7, p) };
        } else {
          var h = clamp((tt - FLY) / HOLD, 0, 1);
          if (a.result === 'goal') ball = { x: a.pe.x, y: a.pe.y + Math.sin(h * 22) * 2 * (1 - h), r: 8 };
          else if (a.result === 'save') { hx = a.keeperTarget.x; hy = a.keeperTarget.y; ball = { x: a.pe.x + a.reboundDir * 300 * h, y: a.pe.y + 30 + 320 * h * h, r: lerp(8, 11, h) }; }
          else { var vx = a.pe.x - a.pc.x, vy = a.pe.y - a.pc.y, mm = Math.hypot(vx, vy) || 1; ball = { x: a.pe.x + vx / mm * 440 * h, y: a.pe.y + vy / mm * 440 * h, r: lerp(8, 6, h) }; }
        }
        if (p >= 1 && !a.celebrated) { a.celebrated = true; doImpact(a); }
        if (tt >= FLY + HOLD && !a.doneCalled) { a.doneCalled = true; if (a.onDone) a.onDone(); }
      } else {
        ball = { x: SPOT.x, y: SPOT.y + Math.sin(now / 400) * 2, r: 15 };
      }
      drawNetBulge(g);
      drawKeeper(g, hx, hy, S.anim && !((S.anim.nowFn() - S.anim.startAt) < FLY) && S.anim.result === 'save');
      drawBall(g, ball.x, ball.y, ball.r);
      if (S.aimActive) drawReticle(g);
      drawParticles(g);
      g.restore();
    }
    function bez(a, p) {
      var u = 1 - p;
      return {
        x: u * u * a.ps.x + 2 * u * p * a.pc.x + p * p * a.pe.x,
        y: u * u * a.ps.y + 2 * u * p * a.pc.y + p * p * a.pe.y
      };
    }

    /* ---- Zeichnen: Rasen ---- */
    function drawPitch(g) {
      var grd = g.createLinearGradient(0, 0, 0, H);
      grd.addColorStop(0, '#05170d'); grd.addColorStop(0.55, '#082a17'); grd.addColorStop(1, '#0a3a1f');
      g.fillStyle = grd; g.fillRect(0, 0, W, H);
      /* Rasenstreifen (perspektivisch heller/dunkler) */
      for (var i = 0; i < 7; i++) {
        var y0 = GROUND + i * ((H - GROUND) / 7);
        g.fillStyle = i % 2 ? 'rgba(57,255,20,0.05)' : 'rgba(57,255,20,0.10)';
        g.fillRect(0, y0, W, (H - GROUND) / 7 + 1);
      }
      /* Elfmeterpunkt + Bogen */
      g.save();
      g.strokeStyle = 'rgba(157,255,122,0.35)'; g.lineWidth = 3;
      g.beginPath(); g.arc(CX, GROUND + 8, 150, Math.PI * 1.15, Math.PI * 1.85); g.stroke();
      g.fillStyle = 'rgba(234,255,224,0.85)';
      g.beginPath(); g.arc(SPOT.x, SPOT.y, 4, 0, Math.PI * 2); g.fill();
      g.restore();
    }

    /* ---- Zeichnen: Tor mit Tiefe + Netz ---- */
    function drawGoal(g, now) {
      var dY = 22, inX = 22, dB = 14;
      var fL = GX, fR = GX + GW, fT = GY, fB = GROUND;
      var bL = GX + inX, bR = GX + GW - inX, bT = GY - dY, bB = GROUND - dB;
      /* Netz (Rueckwand + Seiten) */
      g.save();
      g.strokeStyle = 'rgba(180,255,190,0.13)'; g.lineWidth = 1;
      var cols = 11, rows = 6, i, x, y;
      for (i = 0; i <= cols; i++) {
        x = lerp(bL, bR, i / cols);
        g.beginPath(); g.moveTo(x, bT); g.lineTo(x, bB); g.stroke();
      }
      for (i = 0; i <= rows; i++) {
        y = lerp(bT, bB, i / rows);
        g.beginPath(); g.moveTo(bL, y); g.lineTo(bR, y); g.stroke();
      }
      /* Seiten-/Dach-Netz (Verbindung Front→Rueckwand) */
      g.strokeStyle = 'rgba(180,255,190,0.09)';
      for (i = 0; i <= 5; i++) {
        var tt = i / 5;
        g.beginPath(); g.moveTo(lerp(fL, bL, 1), lerp(fT, bT, tt)); // Platzhalter, echte Linien unten
        g.stroke();
      }
      g.beginPath();
      g.moveTo(fL, fT); g.lineTo(bL, bT); g.moveTo(fR, fT); g.lineTo(bR, bT);
      g.moveTo(fL, fB); g.lineTo(bL, bB); g.moveTo(fR, fB); g.lineTo(bR, bB);
      g.stroke();
      g.restore();
      /* Pfosten + Latte (leuchtend) */
      g.save();
      g.lineCap = 'round'; g.strokeStyle = C_WHITE; g.lineWidth = 8;
      g.shadowColor = 'rgba(57,255,20,0.65)'; g.shadowBlur = 16;
      g.beginPath();
      g.moveTo(fL, fB); g.lineTo(fL, fT); g.lineTo(fR, fT); g.lineTo(fR, fB);
      g.stroke();
      g.restore();
    }
    function drawNetBulge(g) {
      if (!S.netBulge) return;
      var e = (Date.now() - S.netBulge.t) / 700; if (e > 1) { S.netBulge = null; return; }
      var r = 8 + e * 46, a = (1 - e) * 0.5;
      g.save();
      g.strokeStyle = 'rgba(57,255,20,' + a.toFixed(3) + ')'; g.lineWidth = 3;
      g.beginPath(); g.arc(S.netBulge.x, S.netBulge.y, r, 0, Math.PI * 2); g.stroke();
      var grd = g.createRadialGradient(S.netBulge.x, S.netBulge.y, 0, S.netBulge.x, S.netBulge.y, r);
      grd.addColorStop(0, 'rgba(57,255,20,' + (a * 0.5).toFixed(3) + ')'); grd.addColorStop(1, 'rgba(57,255,20,0)');
      g.fillStyle = grd; g.beginPath(); g.arc(S.netBulge.x, S.netBulge.y, r, 0, Math.PI * 2); g.fill();
      g.restore();
    }

    /* ---- Zeichnen: Torwart (Hecht-Figur) ---- */
    function drawKeeper(g, hx, hy, saving) {
      var base = { x: CX, y: GROUND };
      var sh = { x: lerp(base.x, hx, 0.5), y: lerp(base.y, hy, 0.5) };
      g.save(); g.lineCap = 'round';
      /* Koerper */
      g.strokeStyle = '#0c3a22'; g.lineWidth = 20;
      g.shadowColor = 'rgba(0,0,0,0.5)'; g.shadowBlur = 8;
      g.beginPath(); g.moveTo(base.x, base.y); g.lineTo(sh.x, sh.y); g.stroke();
      g.shadowBlur = 0;
      g.strokeStyle = C_LEAF; g.lineWidth = 6;
      g.beginPath(); g.moveTo(base.x, base.y); g.lineTo(sh.x, sh.y); g.stroke();
      /* Arme zum Ball/zur Ecke */
      g.strokeStyle = '#0c3a22'; g.lineWidth = 12;
      g.beginPath(); g.moveTo(sh.x, sh.y); g.lineTo(hx, hy); g.stroke();
      /* Kopf */
      g.fillStyle = '#f2d9b8';
      g.beginPath(); g.arc(sh.x + (hx - sh.x) * 0.12, sh.y - 14 + (hy - sh.y) * 0.12, 11, 0, Math.PI * 2); g.fill();
      /* Handschuhe */
      var gc = saving ? C_GOLD : C_AQUA;
      g.fillStyle = gc; g.shadowColor = gc; g.shadowBlur = saving ? 20 : 10;
      var perp = Math.atan2(hy - sh.y, hx - sh.x) + Math.PI / 2, sp = 9;
      g.beginPath(); g.arc(hx + Math.cos(perp) * sp, hy + Math.sin(perp) * sp, 8, 0, Math.PI * 2); g.fill();
      g.beginPath(); g.arc(hx - Math.cos(perp) * sp, hy - Math.sin(perp) * sp, 8, 0, Math.PI * 2); g.fill();
      g.restore();
    }

    /* ---- Zeichnen: Ball ---- */
    function drawBall(g, x, y, r) {
      g.save();
      g.shadowColor = 'rgba(0,0,0,0.4)'; g.shadowBlur = 6;
      var grd = g.createRadialGradient(x - r * 0.3, y - r * 0.3, r * 0.2, x, y, r);
      grd.addColorStop(0, '#ffffff'); grd.addColorStop(1, '#c9d6cc');
      g.fillStyle = grd; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
      g.shadowBlur = 0; g.fillStyle = 'rgba(10,30,18,0.85)';
      g.beginPath(); g.arc(x, y, r * 0.28, 0, Math.PI * 2); g.fill();
      g.strokeStyle = 'rgba(10,30,18,0.4)'; g.lineWidth = Math.max(1, r * 0.09);
      g.beginPath(); g.arc(x, y, r * 0.7, 0.6, 2.1); g.stroke();
      g.restore();
    }

    /* ---- Zeichnen: Zielkreuz ---- */
    function drawReticle(g) {
      var pt = aimToCanvas(S.aim.tx, S.aim.ty);
      g.save();
      /* Flug-Vorschau (gestrichelter Bogen) */
      var pc = { x: (SPOT.x + pt.x) / 2 + S.aim.tx * 46, y: Math.min(SPOT.y, pt.y) - (Math.max(0, SPOT.y - pt.y) * 0.22 + 22) };
      g.strokeStyle = 'rgba(255,210,63,0.5)'; g.lineWidth = 2; g.setLineDash([6, 8]);
      g.beginPath(); g.moveTo(SPOT.x, SPOT.y);
      g.quadraticCurveTo(pc.x, pc.y, pt.x, pt.y); g.stroke();
      g.setLineDash([]);
      /* Fadenkreuz */
      g.strokeStyle = C_GOLD; g.lineWidth = 2.5; g.shadowColor = C_GOLD; g.shadowBlur = 12;
      g.beginPath(); g.arc(pt.x, pt.y, 15, 0, Math.PI * 2); g.stroke();
      g.beginPath();
      g.moveTo(pt.x - 22, pt.y); g.lineTo(pt.x - 8, pt.y);
      g.moveTo(pt.x + 8, pt.y); g.lineTo(pt.x + 22, pt.y);
      g.moveTo(pt.x, pt.y - 22); g.lineTo(pt.x, pt.y - 8);
      g.moveTo(pt.x, pt.y + 8); g.lineTo(pt.x, pt.y + 22);
      g.stroke();
      g.restore();
    }
    function drawParticles(g) {
      g.save();
      for (var i = 0; i < S.particles.length; i++) {
        var p = S.particles[i], a = 1 - p.age / p.life;
        g.globalAlpha = a; g.fillStyle = p.col;
        g.fillRect(p.x - p.r, p.y - p.r, p.r * 2, p.r * 2);
      }
      g.restore();
    }

    function destroy() {
      deadScene = true;
      if (raf) { cancelAnimationFrame(raf); raf = null; }
      timers.forEach(clearTimeout); timers = [];
      listeners.forEach(function (l) { try { l.t.removeEventListener(l.ty, l.fn, l.o); } catch (e) {} }); listeners = [];
    }

    return {
      setHeader: setHeader, showAim: showAim, showKeeper: showKeeper,
      showWait: showWait, playKick: playKick, destroy: destroy
    };
  }

  /* ============================================================
   *  Registrierung + Modus-Weichen
   * ============================================================ */
  App.Minigames.penalty = {
    id: 'penalty', title: 'Elfmeterschießen', icon: '⚽', order: 149,
    subtitle: 'Schießen & Halten – wer hält die Nerven?',
    single: true, multi: true, minPlayers: 2, maxPlayers: 2,

    render: function (root, ctx) {
      var isMulti = ctx.mode === 'multi';
      var dead = false, timers = [], sceneH = { s: null }, roomOff = [];
      function after(ms, fn) { var t = setTimeout(function () { if (!dead) fn(); }, ms); timers.push(t); return t; }
      function clearTimers() { timers.forEach(clearTimeout); timers = []; }
      function offAll() { roomOff.forEach(function (o) { try { ctx.room.off(o.evt, o.cb); } catch (e) {} }); roomOff = []; }
      function cleanup() { dead = true; clearTimers(); if (sceneH.s) { sceneH.s.destroy(); sceneH.s = null; } if (isMulti) offAll(); }

      if (isMulti) startMulti(); else chooseDifficulty();
      return { cleanup: cleanup };

      /* =========================================================
       *  SOLO
       * ========================================================= */
      function chooseDifficulty() {
        if (sceneH.s) { sceneH.s.destroy(); sceneH.s = null; }
        var btns = DIFFS.map(function (d) {
          return el('button', { class: 'pen-diff-btn glass', type: 'button', onclick: function () { if (App.Audio) App.Audio.sfx('select'); startSolo(d); } }, [
            el('div', { class: 'pen-diff-emoji' }, [d.emoji]),
            el('div', { class: 'pen-diff-name neon' }, [d.name]),
            el('div', { class: 'pen-diff-desc hint-text' }, [d.desc])
          ]);
        });
        root.innerHTML = '';
        root.appendChild(el('div', { class: 'pen-diffscreen glass' }, [
          el('div', { class: 'pen-ds-icon' }, ['⚽']),
          el('h2', { class: 'neon' }, ['Elfmeterschießen']),
          el('p', { class: 'hint-text' }, ['Je 5 Schüsse gegen den Torwart-Bot – bei Gleichstand Sudden Death. Wähle die Schwierigkeit:']),
          el('div', { class: 'pen-diff-grid' }, btns),
          el('div', { class: 'controls-row' }, [
            el('button', { class: 'btn btn-ghost', type: 'button', onclick: ctx.onExit }, ['Zurück'])
          ])
        ]));
      }

      function startSolo(diff) {
        clearTimers();
        if (sceneH.s) sceneH.s.destroy();
        var scene = sceneH.s = buildScene(root, ctx);
        var order = ['you', 'bot'];
        var goals = { you: 0, bot: 0 }, shots = { you: 0, bot: 0 }, hist = { you: [], bot: [] };
        var kick = 0;
        nextKick();

        function nextKick() {
          if (dead) return;
          var shooter = order[kick % 2], keeper = order[(kick + 1) % 2];
          header(shooter);
          if (shooter === 'you') {
            scene.showAim(function (shot) {
              var dive = botDive(shot, diff.read);
              go(shot, dive, shooter);
            });
          } else {
            var shot = botShot(diff.skill, diff.power);
            scene.showKeeper(function (dive) {
              go(shot, dive, shooter);
            });
          }
        }
        function go(shot, dive, shooter) {
          var r = resolve(shot, dive);
          scene.playKick(shot, dive, r.result, r.land, Date.now(), function () { return Date.now(); }, function () {
            if (dead) return;
            if (r.result === 'goal') goals[shooter]++;
            shots[shooter]++;
            hist[shooter].push(r.result === 'goal');
            header(order[kick % 2]);
            after(650, function () {
              var w = decided(goals, shots, order);
              if (w) return end(w);
              kick++; nextKick();
            });
          });
        }
        function header(shooter) {
          var sudden = shots.you >= REG && shots.bot >= REG;
          scene.setHeader({
            lName: 'Du', rName: 'Bot', lGoals: goals.you, rGoals: goals.bot,
            lHist: hist.you, rHist: hist.bot, lMe: true, rMe: false,
            shootSide: shooter === 'you' ? 'l' : 'r', sudden: sudden,
            badge: sudden ? 'SUDDEN DEATH' : (shooter === 'you' ? '🎯 Du schießt' : '🧤 Du hältst')
          });
        }
        function end(winner) {
          if (sceneH.s) { sceneH.s.destroy(); sceneH.s = null; }
          var win = winner === 'you';
          if (win && App.Scores) App.Scores.winCurrent();
          var best = App.Storage.get('best_penalty', 0);
          var nb = goals.you > best; if (nb) App.Storage.set('best_penalty', goals.you);
          App.MG.endScreen(root, {
            score: goals.you, best: best, newBest: nb,
            title: win ? '🏆 Gewonnen!' : '😞 Verloren',
            label: (win ? 'Sieg ' : 'Niederlage ') + goals.you + ' : ' + goals.bot + ' gegen ' + diff.name +
              (nb ? ' · neuer Tore-Rekord! 🎉' : ' · beste Tore: ' + best),
            onExit: ctx.onExit,
            onAgain: function () { chooseDifficulty(); }
          });
        }
      }

      /* =========================================================
       *  MULTIPLAYER (rundenbasiert, Host-autoritativ)
       * ========================================================= */
      function startMulti() {
        var room = ctx.room, me = ctx.me;
        var lastShared = (room.snapshot() && room.snapshot().shared) || null;
        var curTop = null;                 // 'wait' | 'game' | 'end'
        var uiKey = '', animKey = '';
        var initDone = false, resolvedFor = -1, advanceKey = -1, lastRep = -1;

        function onShared(sh) { if (dead) return; lastShared = sh; sync(); }
        function onPlayers() { if (dead) return; sync(); }
        room.on('shared', onShared); roomOff.push({ evt: 'shared', cb: onShared });
        room.on('players', onPlayers); roomOff.push({ evt: 'players', cb: onPlayers });
        sync();

        function ensureScene() { if (!sceneH.s) { sceneH.s = buildScene(root, ctx); } return sceneH.s; }
        function dropScene() { if (sceneH.s) { sceneH.s.destroy(); sceneH.s = null; } }

        function sync() {
          var players = room.players();
          if (players.length < 2) { showWait(players); return; }
          var sh = lastShared;
          if (!sh || !sh.order) {
            if (room.isHost() && !initDone) { initDone = true; initShared(players); return; }
            showWait(players, true); return;
          }
          if (sh.seriesOver) { showEnd(sh); return; }
          curTop = 'game'; uiKeyReset(); var scene = ensureScene();

          /* Punkte live melden (fuer Podest) */
          var myG = (sh.goals && sh.goals[me.id]) || 0;
          if (myG !== lastRep) { lastRep = myG; try { room.reportScore(myG); } catch (e) {} }

          /* Kopf */
          scene.setHeader(headerInfo(sh, players));

          if (sh.phase === 'resolve' && sh.resolveAt) {
            var k = sh.kick + '|' + sh.resolveAt;
            if (animKey !== k) {
              animKey = k;
              scene.playKick(sh.shot, sh.dive, sh.result, sh.land, sh.resolveAt, room.now, function () {
                if (room.isHost()) hostAdvance(sh);
              });
            }
            return;
          }

          /* phase 'aim' – Rolle-abhaengige Steuerung, nur bei Wechsel neu bauen */
          var want;
          var hasShot = sh.shot && typeof sh.shot.tx === 'number';
          var hasDive = typeof sh.dive === 'number';
          if (me.id === sh.shooter) want = hasShot ? 'wait-s' : 'aim';
          else if (me.id === sh.keeper) want = hasDive ? 'wait-k' : 'keeper';
          else want = 'wait';
          var key = sh.kick + '|' + want;
          if (uiKey !== key) {
            uiKey = key; animKey = '';
            if (want === 'aim') scene.showAim(function (shot) { room.setShared({ shot: shot }); });
            else if (want === 'keeper') scene.showKeeper(function (dive) { room.setShared({ dive: dive }); });
            else if (want === 'wait-s') scene.showWait('Warte auf den Torwart …');
            else if (want === 'wait-k') scene.showWait('Warte auf den Schützen …');
            else scene.showWait('Warte …');
          }

          /* Host loest auf, sobald beide abgegeben haben */
          if (room.isHost() && hasShot && hasDive && !sh.resolveAt && resolvedFor !== sh.kick) {
            resolvedFor = sh.kick;
            var r = resolve(sh.shot, sh.dive);
            room.setShared({ phase: 'resolve', result: r.result, land: r.land, resolveAt: room.now() + 450 });
          }
        }

        function uiKeyReset() { if (curTop !== 'game') { curTop = 'game'; } }

        function initShared(players) {
          var order = [players[0].id, players[1].id];
          var goals = {}, shots = {}, hist = {};
          goals[order[0]] = 0; goals[order[1]] = 0;
          shots[order[0]] = 0; shots[order[1]] = 0;
          hist[order[0]] = []; hist[order[1]] = [];
          room.setShared({
            order: order, kick: 0, phase: 'aim', shooter: order[0], keeper: order[1],
            shot: null, dive: null, resolveAt: null, result: null, land: null,
            goals: goals, shots: shots, hist: hist, seriesOver: false, winner: null
          });
        }

        function hostAdvance(sh) {
          if (advanceKey === sh.kick) return;
          advanceKey = sh.kick;
          after(700, function () {
            var c = lastShared;
            if (dead || !c || c.phase !== 'resolve' || c.kick !== sh.kick) return;
            var goals = Object.assign({}, c.goals), shots = Object.assign({}, c.shots);
            var hist = { }; hist[c.order[0]] = (c.hist[c.order[0]] || []).slice(); hist[c.order[1]] = (c.hist[c.order[1]] || []).slice();
            var shooter = c.shooter;
            if (c.result === 'goal') goals[shooter] = (goals[shooter] || 0) + 1;
            shots[shooter] = (shots[shooter] || 0) + 1;
            hist[shooter].push(c.result === 'goal');
            var w = decided(goals, shots, c.order);
            if (w) {
              room.setShared({ goals: goals, shots: shots, hist: hist, phase: 'over', seriesOver: true, winner: w });
            } else {
              var nk = c.kick + 1;
              room.setShared({
                goals: goals, shots: shots, hist: hist, kick: nk, phase: 'aim',
                shooter: c.order[nk % 2], keeper: c.order[(nk + 1) % 2],
                shot: null, dive: null, resolveAt: null, result: null, land: null
              });
              resolvedFor = -1;
            }
          });
        }

        function headerInfo(sh, players) {
          var a = sh.order[0], b = sh.order[1];
          var pa = byId(players, a), pb = byId(players, b);
          var sudden = (sh.shots[a] || 0) >= REG && (sh.shots[b] || 0) >= REG;
          var iShoot = sh.shooter === me.id;
          var badge = sudden ? 'SUDDEN DEATH' : (iShoot ? '🎯 Du schießt' : (sh.keeper === me.id ? '🧤 Du hältst' : '⚽'));
          return {
            lName: (pa ? pa.name : 'Spieler 1') + (a === me.id ? ' (du)' : ''),
            rName: (pb ? pb.name : 'Spieler 2') + (b === me.id ? ' (du)' : ''),
            lGoals: sh.goals[a] || 0, rGoals: sh.goals[b] || 0,
            lHist: (sh.hist && sh.hist[a]) || [], rHist: (sh.hist && sh.hist[b]) || [],
            lMe: a === me.id, rMe: b === me.id,
            shootSide: sh.shooter === a ? 'l' : 'r', sudden: sudden, badge: badge
          };
        }
        function byId(players, id) { for (var i = 0; i < players.length; i++) if (players[i].id === id) return players[i]; return null; }

        function showWait(players, starting) {
          if (curTop !== 'wait') { curTop = 'wait'; dropScene(); }
          root.innerHTML = '';
          root.appendChild(el('div', { class: 'glass pen-waitscreen' }, [
            el('div', { class: 'pen-ds-icon' }, ['⚽']),
            el('h2', { class: 'neon' }, ['Elfmeterschießen']),
            el('div', { class: 'pen-wait-count neon-strong' }, [(players ? players.length : 1) + ' / 2']),
            el('p', { class: 'hint-text' }, [starting ? 'Spiel startet gleich …' : 'Warte auf den zweiten Spieler …']),
            el('div', { class: 'controls-row' }, [
              el('button', { class: 'btn btn-ghost', type: 'button', onclick: ctx.onExit }, ['Zurück zur Lobby'])
            ])
          ]));
        }

        function showEnd(sh) {
          if (curTop === 'end') return;
          curTop = 'end'; dropScene();
          try { room.reportScore((sh.goals && sh.goals[me.id]) || 0); } catch (e) {}
          if (sh.winner === me.id && App.Scores) App.Scores.winCurrent();
          after(200, function () {
            if (dead) return;
            App.MG.endScreen(root, { players: room.players(), meId: me.id, onExit: ctx.onExit });
          });
        }
      }
    }
  };

  /* ============================================================
   *  STYLES
   * ============================================================ */
  function injectStyle() {
    UI.injectStyle('mg-penalty-css', [
      '.pen-wrap{display:flex;flex-direction:column;gap:12px;max-width:680px;margin:0 auto;}',
      /* Kopf */
      '.pen-head{display:flex;align-items:stretch;gap:10px;padding:10px 12px;}',
      '.pen-chip{flex:1;min-width:0;display:flex;flex-direction:column;gap:6px;padding:8px 12px;border-radius:14px;background:rgba(9,32,21,.55);border:1px solid var(--stroke);transition:.18s;}',
      '.pen-chip-r{align-items:flex-end;}',
      '.pen-chip.pen-me{border-color:var(--stroke-2);}',
      '.pen-chip.pen-shooting{border-color:var(--gold);box-shadow:0 0 0 1px var(--gold),0 0 16px rgba(255,210,63,.3);}',
      '.pen-chip-top{display:flex;align-items:center;gap:10px;}',
      '.pen-chip-r .pen-chip-top{flex-direction:row;}',
      '.pen-name{font-weight:800;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:120px;color:var(--text);}',
      '.pen-chip.pen-me .pen-name{color:var(--aqua);}',
      '.pen-goalnum{font-size:26px;font-weight:900;line-height:1;color:var(--leaf);font-variant-numeric:tabular-nums;text-shadow:0 0 10px rgba(57,255,20,.3);}',
      '.pen-dots{display:flex;gap:4px;}',
      '.pen-dot{width:11px;height:11px;border-radius:50%;border:1px solid var(--stroke);background:transparent;}',
      '.pen-dot.pen-scored{background:var(--neon);border-color:var(--neon);box-shadow:0 0 6px rgba(57,255,20,.6);}',
      '.pen-dot.pen-missed{background:var(--danger);border-color:var(--danger);}',
      '.pen-dot.pen-pending{background:rgba(255,255,255,.05);}',
      '.pen-badge{align-self:center;text-align:center;min-width:96px;font-size:12px;font-weight:900;letter-spacing:.5px;color:var(--aqua);text-transform:uppercase;padding:6px 8px;border-radius:12px;background:rgba(4,16,10,.6);border:1px solid var(--stroke);line-height:1.2;}',
      '.pen-badge.pen-sd{color:var(--danger);border-color:var(--danger);animation:pen-sdpulse 1s infinite;}',
      '@keyframes pen-sdpulse{0%,100%{box-shadow:0 0 0 rgba(255,77,109,0);}50%{box-shadow:0 0 16px rgba(255,77,109,.6);}}',
      /* Buehne */
      '.pen-stage{position:relative;width:100%;max-width:680px;margin:0 auto;aspect-ratio:640 / 480;}',
      '.pen-canvas{display:block;width:100%;height:100%;border-radius:16px;border:2px solid rgba(57,255,20,.32);background:#05170d;box-shadow:0 0 40px rgba(57,255,20,.2),inset 0 0 50px rgba(0,0,0,.35);touch-action:none;user-select:none;-webkit-user-select:none;-webkit-tap-highlight-color:transparent;}',
      /* Keeper-Zonen-Overlay (exakt ueber der Tor-Oeffnung) */
      '.pen-overlay{position:absolute;left:15.625%;top:14.583%;width:68.75%;height:41.667%;display:none;grid-template-columns:1fr 1fr 1fr;grid-template-rows:1fr 1fr;gap:4px;}',
      '.pen-overlay.pen-on{display:grid;}',
      '.pen-zone{border:2px dashed rgba(255,210,63,.35);background:rgba(255,210,63,.05);border-radius:10px;color:rgba(255,210,63,.7);font-size:clamp(20px,5vw,30px);font-weight:900;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:.12s;-webkit-tap-highlight-color:transparent;padding:0;}',
      '.pen-zone:hover{background:rgba(255,210,63,.18);border-color:var(--gold);color:var(--gold);transform:scale(1.03);}',
      '.pen-zone:active{transform:scale(.97);}',
      '.pen-zone.pen-picked{background:rgba(255,210,63,.35);border-style:solid;border-color:var(--gold);color:#04160c;box-shadow:0 0 18px rgba(255,210,63,.6);}',
      /* Ergebnis-Banner */
      '.pen-banner{position:absolute;left:50%;top:34%;transform:translate(-50%,-50%) scale(.6);opacity:0;pointer-events:none;font-size:clamp(30px,9vw,60px);font-weight:900;letter-spacing:1px;white-space:nowrap;text-align:center;}',
      '.pen-bn-show{animation:pen-bn .35s cubic-bezier(.2,1.3,.4,1) forwards;}',
      '@keyframes pen-bn{0%{opacity:0;transform:translate(-50%,-50%) scale(.5);}100%{opacity:1;transform:translate(-50%,-50%) scale(1);}}',
      '.pen-bn-goal{color:var(--neon);text-shadow:0 0 24px rgba(57,255,20,.8),0 2px 6px rgba(0,0,0,.6);}',
      '.pen-bn-save{color:var(--gold);text-shadow:0 0 24px rgba(255,210,63,.8),0 2px 6px rgba(0,0,0,.6);}',
      '.pen-bn-miss{color:var(--danger);text-shadow:0 0 20px rgba(255,77,109,.7),0 2px 6px rgba(0,0,0,.6);}',
      /* Steuer-Bereich */
      '.pen-ctrl{padding:12px 16px;min-height:96px;display:flex;align-items:center;justify-content:center;}',
      '.pen-ctrl-title{font-weight:900;font-size:clamp(16px,4.5vw,20px);color:var(--neon);text-align:center;}',
      '.pen-keep-title{color:var(--gold);}',
      '.pen-ctrl-sub{font-size:12px;color:var(--muted);text-align:center;margin-top:2px;}',
      '.pen-aim-box{width:100%;display:flex;flex-direction:column;gap:10px;align-items:center;}',
      '.pen-pw-row{width:100%;max-width:420px;display:flex;align-items:center;gap:10px;}',
      '.pen-pw-lbl{font-size:11px;font-weight:900;color:var(--muted);letter-spacing:1px;}',
      '.pen-pw-track{position:relative;flex:1;height:20px;border-radius:11px;background:rgba(4,16,10,.8);border:1px solid var(--stroke);overflow:hidden;}',
      '.pen-pw-sweet{position:absolute;left:55%;width:27%;top:0;bottom:0;background:rgba(255,210,63,.16);border-left:1px dashed rgba(255,210,63,.5);border-right:1px dashed rgba(255,210,63,.5);}',
      '.pen-pw-fill{position:absolute;left:0;top:0;bottom:0;width:0;background:linear-gradient(90deg,var(--aqua),var(--neon));box-shadow:0 0 12px rgba(57,255,20,.5);transition:background .1s;}',
      '.pen-pw-fill.pen-pw-hot{background:linear-gradient(90deg,var(--neon),var(--gold));}',
      '.pen-shoot{width:100%;max-width:300px;font-size:18px;font-weight:900;letter-spacing:1px;}',
      '.pen-keep-box,.pen-wait-box{display:flex;flex-direction:column;gap:6px;align-items:center;}',
      '.pen-spin{font-size:34px;animation:pen-spin 1.4s linear infinite;filter:drop-shadow(0 0 10px rgba(57,255,20,.4));}',
      '@keyframes pen-spin{to{transform:rotate(360deg);}}',
      '.pen-wait-txt{font-size:14px;color:var(--muted);font-weight:700;}',
      '.pen-hint{text-align:center;}',
      /* Auswahl-/Warte-Screens */
      '.pen-diffscreen,.pen-waitscreen{padding:26px 22px;text-align:center;display:flex;flex-direction:column;gap:14px;align-items:center;max-width:560px;margin:0 auto;}',
      '.pen-ds-icon{font-size:52px;filter:drop-shadow(0 0 14px rgba(57,255,20,.5));animation:pen-bob 1.8s ease-in-out infinite;}',
      '@keyframes pen-bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-8px)}}',
      '.pen-diff-grid{display:flex;gap:10px;flex-wrap:wrap;justify-content:center;width:100%;}',
      '.pen-diff-btn{flex:1;min-width:150px;max-width:180px;padding:16px 12px;display:flex;flex-direction:column;gap:6px;align-items:center;cursor:pointer;border:1px solid var(--stroke);transition:.15s;}',
      '.pen-diff-btn:hover{border-color:var(--neon);box-shadow:0 0 18px rgba(57,255,20,.3);transform:translateY(-3px);}',
      '.pen-diff-emoji{font-size:38px;line-height:1;}',
      '.pen-diff-name{font-weight:900;font-size:17px;}',
      '.pen-diff-desc{font-size:11px;line-height:1.3;margin:0;}',
      '.pen-wait-count{font-size:40px;font-weight:900;line-height:1;}'
    ].join(''));
  }
})();
