/* towerhanoi.js — "Türme von Hanoi": Kopf-Wettrennen im Neon-Dschungel.
 *
 * IDEE     Drei Stäbe, ein Stapel unterschiedlich großer Scheiben. Es darf immer
 *          nur die oberste Scheibe eines Stabes bewegt werden und nie eine größere
 *          auf eine kleinere. Ziel: der ganze Turm auf den rechten Stab (🎯).
 *          Start mit 3 Scheiben — nach jedem gelösten Turm kommt eine dazu
 *          (4, 5, 6 …). 3 Minuten lang so viele Türme wie möglich.
 *
 * STEUERUNG  Stab antippen = oberste Scheibe aufnehmen, Ziel-Stab antippen = ablegen.
 *            Oder direkt ziehen (pointerdown/move/up → Maus + Touch identisch).
 *            Quell-Stab nochmal antippen = zurücklegen. Zusätzlich 💡 Tipp
 *            (zeigt den optimalen Zug, halbiert dafür die Punkte des Turms)
 *            und 🔄 Neu (aktuellen Turm zurücksetzen).
 *
 * PUNKTE   Jeder gelöste Turm zählt: Basis = (2^n − 1) × 12, multipliziert mit
 *          der Effizienz (Minimum/eigene Züge, mind. 45 %). Perfekt gelöst
 *          (genau 2^n − 1 Züge, ohne Tipp) gibt +40 % Bonus. Mit Tipp: halbe Punkte.
 *          Zugzähler + Minimum-Anzeige (2^n − 1) sind immer sichtbar.
 *
 * SYNC     Punkte-Rennen wie reflex.js: alle spielen gleichzeitig dieselbe
 *          Scheibenzahl-Progression (3, 4, 5 …, für jeden identisch), es gibt
 *          also keinen geteilten Zustand — nur room.reportScore + Live-Rangliste.
 *          Start über snapshot().round.startAt + App.MG.countdown(room.now),
 *          Rundenuhr über App.MG.roundTimer (Wall-Clock → Tab-Wechsel-sicher).
 *          SOLO: 3 Bot-Stufen als Geist-Gegner (plausible Zug-Taktung +
 *          Effizienz je Stufe) und Jagd auf best_towerhanoi.
 */
(function () {
  'use strict';
  window.App = window.App || {}; App.Minigames = App.Minigames || {};
  var UI = App.UI, el = UI.el;

  injectStyle();

  /* ---------- Zeichen-Geometrie (virtueller 720×340-Raum, wird skaliert) ---------- */
  var VW = 720, VH = 340;
  var PEGX = [120, 360, 600];       // Mittelpunkte der drei Stäbe
  var BASE_Y = 296;                 // Oberkante des Sockels = Boden der Scheiben
  var TOP_Y = 92;                   // Oberkante der Stäbe
  var DH = 24;                      // Scheibenhöhe
  var HOLD_Y = 50;                  // Schwebehöhe einer aufgenommenen Scheibe
  var MAXN = 9;                     // so viele Scheiben passen auf einen Stab
  var PEG_LABEL = ['Start', 'Mitte', 'Ziel 🎯'];

  var BOTS = [
    { id: 'easy', name: 'Ranke', icon: '🌱', moveMs: 1350, eff: 0.62, desc: 'gemütlich, verzettelt sich' },
    { id: 'mid', name: 'Jaguar', icon: '🐆', moveMs: 820, eff: 0.82, desc: 'flott und ordentlich' },
    { id: 'hard', name: 'Schamane', icon: '🧙', moveMs: 520, eff: 0.97, desc: 'kennt den perfekten Weg' }
  ];
  function botById(id) {
    for (var i = 0; i < BOTS.length; i++) if (BOTS[i].id === id) return BOTS[i];
    return BOTS[1];
  }

  /* ---------- reine Spiel-Logik ---------- */
  function minMoves(n) { return Math.pow(2, n) - 1; }

  /* Punkte für einen gelösten Turm. */
  function towerPoints(n, moves, hintUsed) {
    var min = minMoves(n);
    var base = min * 12;
    var eff = min / Math.max(min, moves);
    var pts = base * (0.45 + 0.55 * eff);
    if (moves === min && !hintUsed) pts += base * 0.4;   // Perfekt-Bonus
    if (hintUsed) pts *= 0.5;
    return Math.round(pts);
  }

  function freshPegs(n) {
    var a = [];
    for (var s = n; s >= 1; s--) a.push(s);              // größte unten, kleinste oben
    return [a, [], []];
  }
  function pegOf(pegs, size) {
    for (var i = 0; i < 3; i++) if (pegs[i].indexOf(size) >= 0) return i;
    return 0;
  }
  /* Optimaler nächster Zug aus JEDER erlaubten Stellung:
     „bringe Scheibe k nach to" — liegt k schon dort, kümmere dich um k−1;
     sonst müssen erst alle kleineren auf den freien Stab. */
  function nextOptimal(pegs, k, to) {
    if (k < 1) return null;
    var from = pegOf(pegs, k);
    if (from === to) return nextOptimal(pegs, k - 1, to);
    var spare = 3 - from - to;
    var sub = nextOptimal(pegs, k - 1, spare);
    if (sub) return sub;
    return { from: from, to: to };
  }

  /* ---------- Canvas-Helfer ---------- */
  function rr(g, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
  }
  function sfx(name) { if (App.Audio) App.Audio.sfx(name); }

  App.Minigames.towerhanoi = {
    id: 'towerhanoi', title: 'Türme von Hanoi', icon: '🗼', order: 161,
    subtitle: 'Stapel umbauen – nie Groß auf Klein!',
    single: true, multi: true, minPlayers: 2, maxPlayers: 8,

    render: function (root, ctx) {
      var isMulti = ctx.mode === 'multi';
      var DURATION = 180;                                  // 3 Minuten Rundenzeit
      var nowFn = isMulti ? ctx.room.now : function () { return Date.now(); };

      var dead = false;
      var stops = [];        // stop()-Funktionen (App.MG-Bausteine, Listener)
      var pending = [];      // laufende setTimeout-IDs
      var raf = 0;

      /* Spielzustand (in play() für jede Runde frisch gesetzt) */
      var pegs = freshPegs(3), n = 3, moves = 0, hintUsed = false, hintMove = null;
      var solved = 0, score = 0, held = null, anim = null, busy = false;
      var started = false, finished = false, endAt = 0;

      /* Solo-Geist */
      var bot = null, botScore = 0, botLevel = botById(App.Storage.get('hno_bot', 'mid'));

      /* DOM/Canvas */
      var canvas = null, g = null, scale = 1, lastW = 0;
      var scoreEl, movesEl, timerEl, discEl, solvedEl, hintBadge, flashEl, stage, soloBoard;

      function after(ms, fn) { var t = setTimeout(function () { if (!dead) fn(); }, ms); pending.push(t); return t; }
      function clearPending() { pending.forEach(clearTimeout); pending = []; }
      function stopHelpers() { stops.forEach(function (f) { try { f(); } catch (e) {} }); stops = []; }
      function stopRaf() { if (raf) cancelAnimationFrame(raf); raf = 0; }
      function cleanup() { dead = true; clearPending(); stopHelpers(); stopRaf(); }

      /* ---- Start ---- */
      if (isMulti) {
        var snap = ctx.room.snapshot() || {};
        var startAt = (snap.round && snap.round.startAt) || (ctx.room.now() + 3000);
        stops.push(App.MG.countdown(root, startAt, function () { play(startAt); }, ctx.room.now));
      } else {
        chooseScreen();
      }
      return { cleanup: cleanup };

      /* ===================== SOLO: Gegner wählen ===================== */
      function chooseScreen() {
        clearPending(); stopHelpers(); stopRaf();
        var cards = BOTS.map(function (b) {
          return el('button', {
            class: 'hno-lvl' + (b.id === botLevel.id ? ' is-on' : ''), type: 'button',
            onclick: function () {
              botLevel = b; App.Storage.set('hno_bot', b.id);
              sfx('select');
              play(Date.now());
            }
          }, [
            el('div', { class: 'hno-lvl-ico' }, [b.icon]),
            el('div', { class: 'hno-lvl-nm neon' }, [b.name]),
            el('div', { class: 'hno-lvl-d' }, [b.desc])
          ]);
        });
        root.innerHTML = '';
        root.appendChild(el('div', { class: 'glass hno-intro' }, [
          el('div', { class: 'hno-intro-ico' }, ['🗼']),
          el('h2', { class: 'neon-strong' }, ['Türme von Hanoi']),
          el('p', { class: 'hint-text' }, ['3 Minuten. Turm auf den rechten Stab bringen – dann kommt eine Scheibe dazu. Nie eine größere auf eine kleinere legen!']),
          el('div', { class: 'mg-field-title' }, ['Gegen welchen Geist trittst du an?']),
          el('div', { class: 'hno-lvls' }, cards),
          el('p', { class: 'hint-text' }, ['Bestwert: ' + App.MG.fmt(App.Storage.get('best_towerhanoi', 0)) + ' Punkte'])
        ]));
      }

      /* ===================== SPIEL ===================== */
      function play(startAt) {
        clearPending(); stopHelpers(); stopRaf();
        n = 3; moves = 0; hintUsed = false; hintMove = null;
        solved = 0; score = 0; held = null; anim = null; busy = false;
        started = false; finished = false;
        pegs = freshPegs(n);
        endAt = startAt + DURATION * 1000;

        /* --- Kopfzeile --- */
        scoreEl = el('div', { class: 'hno-big hno-gold' }, ['0']);
        movesEl = el('div', { class: 'hno-big hno-aqua' }, ['0 / 7']);
        timerEl = el('div', { class: 'mg-timer' }, ['3:00']);
        var head = el('div', { class: 'hno-head glass' }, [
          el('div', { class: 'hno-hcell' }, [el('span', { class: 'hno-hl' }, ['Punkte']), scoreEl]),
          el('div', { class: 'hno-hcell hno-hmid' }, [el('span', { class: 'hno-hl' }, ['Züge / Minimum']), movesEl]),
          el('div', { class: 'hno-hcell hno-hright' }, [el('span', { class: 'hno-hl' }, ['Zeit']), timerEl])
        ]);

        /* --- Spielfläche --- */
        canvas = el('canvas', { class: 'hno-canvas', 'aria-label': 'Türme von Hanoi Spielfläche' });
        g = canvas.getContext('2d');
        flashEl = el('div', { class: 'hno-flash' }, ['']);
        stage = el('div', { class: 'hno-stage' }, [canvas, flashEl]);

        /* --- Info + Knöpfe --- */
        discEl = el('span', { class: 'chip hno-chip' }, ['🗼 3 Scheiben']);
        solvedEl = el('span', { class: 'chip hno-chip' }, ['✅ 0 gelöst']);
        hintBadge = el('span', { class: 'chip hno-chip hno-chip-warn hno-hide' }, ['💡 halbe Punkte']);
        var chips = el('div', { class: 'hno-chips' }, [discEl, solvedEl, hintBadge]);

        var hintBtn = el('button', { class: 'btn btn-aqua', type: 'button', onclick: doHint }, ['💡 Tipp']);
        var resetBtn = el('button', { class: 'btn btn-ghost', type: 'button', onclick: resetTower }, ['🔄 Turm neu']);
        var buttons = el('div', { class: 'controls-row hno-btns' }, [hintBtn, resetBtn]);

        var rule = el('p', { class: 'hint-text hno-rule' }, ['Stab antippen = oberste Scheibe nehmen · Ziel-Stab antippen = ablegen (oder ziehen). Nie Groß auf Klein – alles auf den rechten Stab 🎯']);

        /* --- Rangliste --- */
        var board = null, boardWrap = null;
        if (isMulti) {
          board = App.MG.liveBoard(ctx.room, ctx.me.id);
          stops.push(board.stop);
          boardWrap = el('div', { class: 'hno-board glass' }, [
            el('div', { class: 'mg-field-title' }, ['🏆 Rangliste']), board.root
          ]);
        } else {
          soloBoard = el('div', { class: 'mg-scoreboard' });
          boardWrap = el('div', { class: 'hno-board glass' }, [
            el('div', { class: 'mg-field-title' }, ['🏆 Duell gegen ' + botLevel.icon + ' ' + botLevel.name]), soloBoard
          ]);
        }

        root.innerHTML = '';
        root.appendChild(el('div', { class: 'hno-layout' }, [head, stage, chips, buttons, rule, boardWrap]));

        resize();

        /* --- Eingabe: Maus + Touch über Pointer-Events --- */
        canvas.addEventListener('pointerdown', onDown);
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
        window.addEventListener('pointercancel', onCancel);
        window.addEventListener('resize', resize);
        stops.push(function () {
          if (canvas) canvas.removeEventListener('pointerdown', onDown);
          window.removeEventListener('pointermove', onMove);
          window.removeEventListener('pointerup', onUp);
          window.removeEventListener('pointercancel', onCancel);
          window.removeEventListener('resize', resize);
        });

        /* --- Solo-Geist vorbereiten --- */
        if (!isMulti) {
          botScore = 0;
          bot = { n: 3, done: 0, need: Math.round(minMoves(3) / botLevel.eff), nextAt: startAt + botLevel.moveMs };
          updateSoloBoard();
        } else {
          ctx.room.reportScore(0);
        }

        started = true;
        updateHud();
        sfx('start');
        stopRaf(); raf = requestAnimationFrame(draw);

        /* --- Rundenuhr (Wall-Clock, im Multi mit Server-Zeit) --- */
        stops.push(App.MG.roundTimer(endAt, function (left) {
          timerEl.textContent = App.MG.mmss(left);
          if (left <= 10) timerEl.classList.add('hno-urgent');
          if (!isMulti) { botTick(); updateSoloBoard(); }
        }, finish, isMulti ? ctx.room.now : null));
      }

      /* ===================== Eingabe ===================== */
      function toLocal(e) {
        var r = canvas.getBoundingClientRect();
        var s = r.width / VW;
        return { x: (e.clientX - r.left) / s, y: (e.clientY - r.top) / s };
      }
      function colAt(x) { return x < VW / 3 ? 0 : (x < (VW * 2) / 3 ? 1 : 2); }

      function onDown(e) {
        if (e && e.preventDefault) e.preventDefault();
        if (dead || finished || !started || busy || anim) return;
        var p = toLocal(e), peg = colAt(p.x);
        if (held) { tryDrop(peg); return; }
        var st = pegs[peg];
        if (!st.length) { sfx('click'); showFlash('Auf dem Stab liegt nichts.', 'warn'); return; }
        held = {
          size: st[st.length - 1], from: peg, dragging: true,
          px: p.x, py: p.y, downX: p.x, downY: p.y, downT: Date.now()
        };
        st.pop();
        sfx('pop');
      }
      function onMove(e) {
        if (dead || !held || !held.dragging || !canvas) return;
        var p = toLocal(e);
        held.px = p.x; held.py = p.y;
      }
      function onUp(e) {
        if (dead || !held || !canvas) return;
        if (!held.dragging) return;                 // Tipp-Modus: Scheibe bleibt in der Hand
        var p = toLocal(e);
        var dx = p.x - held.downX, dy = p.y - held.downY;
        var far = Math.sqrt(dx * dx + dy * dy) > 16 || (Date.now() - held.downT) > 260;
        if (!far) { held.dragging = false; held.px = PEGX[held.from]; held.py = HOLD_Y; return; }
        if (p.y < -60 || p.y > VH + 80) { returnHeld(); return; }   // weit weg losgelassen
        tryDrop(colAt(p.x));
      }
      function onCancel() { if (!dead && held && held.dragging) returnHeld(); }

      /* ===================== Züge ===================== */
      function heldPos() {
        if (!held) return { x: 0, y: 0 };
        return held.dragging ? { x: held.px, y: held.py } : { x: PEGX[held.from], y: HOLD_Y };
      }
      function slotPos(peg, idx) { return { x: PEGX[peg], y: BASE_Y - idx * DH - DH / 2 }; }

      function startAnim(size, from, peg, idx) {
        var to = slotPos(peg, idx);
        anim = { size: size, x0: from.x, y0: from.y, x1: to.x, y1: to.y, t0: Date.now(), dur: 190, peg: peg, idx: idx };
      }
      function returnHeld() {
        if (!held) return;
        var from = heldPos(), peg = held.from;
        pegs[peg].push(held.size);
        startAnim(held.size, from, peg, pegs[peg].length - 1);
        held = null;
        sfx('click');
      }
      function tryDrop(peg) {
        if (!held) return;
        if (peg === held.from) { returnHeld(); return; }
        var target = pegs[peg];
        if (target.length && target[target.length - 1] < held.size) {
          sfx('error');
          showFlash('🚫 Größer darf nicht auf Kleiner!', 'bad');
          shake();
          returnHeld();
          return;
        }
        var from = heldPos(), size = held.size;
        target.push(size);
        moves++;
        startAnim(size, from, peg, target.length - 1);
        held = null; hintMove = null;
        sfx('step');
        updateHud();
        if (pegs[2].length === n) solveTower();
      }

      function solveTower() {
        busy = true;
        var perfect = (moves === minMoves(n) && !hintUsed);
        var pts = towerPoints(n, moves, hintUsed);
        score += pts; solved++;
        if (isMulti) ctx.room.reportScore(score);
        updateHud();
        sfx(perfect ? 'jackpot' : 'levelup');
        if (App.Audio) App.Audio.sweep(420, 980, 0.25);
        showFlash('🗼 Turm gelöst! +' + App.MG.fmt(pts) + (perfect ? ' · PERFEKT ✨' : ''), 'good');
        after(950, function () {
          if (finished) return;
          n = Math.min(MAXN, n + 1);
          newTower();
          showFlash('➕ Jetzt ' + n + ' Scheiben', 'info');
        });
      }
      function newTower() {
        pegs = freshPegs(n);
        moves = 0; hintUsed = false; hintMove = null; held = null; anim = null; busy = false;
        updateHud();
        sfx('whoosh');
      }
      function resetTower() {
        if (dead || finished || !started || busy) return;
        newTower();
        showFlash('🔄 Turm zurückgesetzt', 'info');
      }
      function doHint() {
        if (dead || finished || !started || busy || held || anim) return;
        var mv = nextOptimal(pegs, n, 2);
        if (!mv) return;
        if (!hintUsed) { hintUsed = true; hintBadge.classList.remove('hno-hide'); }
        hintMove = mv;
        sfx('info');
        showFlash('💡 ' + PEG_LABEL[mv.from] + ' ➜ ' + PEG_LABEL[mv.to] + ' · halbe Punkte', 'warn');
      }

      /* ===================== HUD ===================== */
      function updateHud() {
        if (!scoreEl) return;
        scoreEl.textContent = App.MG.fmt(score);
        movesEl.textContent = moves + ' / ' + minMoves(n);
        movesEl.className = 'hno-big ' + (moves > minMoves(n) ? 'hno-warn' : 'hno-aqua');
        discEl.textContent = '🗼 ' + n + ' Scheiben';
        solvedEl.textContent = '✅ ' + solved + ' gelöst';
        if (!hintUsed) hintBadge.classList.add('hno-hide');
      }
      function showFlash(text, kind) {
        if (!flashEl) return;
        flashEl.textContent = text;
        flashEl.className = 'hno-flash hno-f-' + (kind || 'info');
        void flashEl.offsetWidth;
        flashEl.classList.add('hno-f-on');
        after(1250, function () { if (flashEl) flashEl.classList.remove('hno-f-on'); });
      }
      function shake() {
        if (!stage) return;
        stage.classList.remove('hno-shake'); void stage.offsetWidth; stage.classList.add('hno-shake');
        after(340, function () { if (stage) stage.classList.remove('hno-shake'); });
      }

      /* ===================== Solo-Geist ===================== */
      function botTick() {
        if (!bot || finished) return;
        var now = Date.now(), guard = 0;
        while (now >= bot.nextAt && guard < 400) {
          guard++;
          bot.done++;
          bot.nextAt += botLevel.moveMs * (0.75 + Math.random() * 0.5);
          if (bot.done >= bot.need) {
            botScore += towerPoints(bot.n, bot.need, false);
            bot.n = Math.min(MAXN, bot.n + 1);
            bot.done = 0;
            bot.need = Math.round(minMoves(bot.n) / botLevel.eff);
            bot.nextAt += 700;
          }
        }
      }
      function updateSoloBoard() {
        if (!soloBoard) return;
        var rows = [
          { name: 'Du', score: score, me: true, sub: n + ' Scheiben' },
          { name: botLevel.icon + ' ' + botLevel.name, score: botScore, me: false, sub: bot ? bot.n + ' Scheiben' : '' }
        ].sort(function (a, b) { return b.score - a.score; });
        soloBoard.innerHTML = '';
        rows.forEach(function (r, i) {
          soloBoard.appendChild(el('div', { class: 'mg-sb-row p' + (i + 1) + (r.me ? ' me' : '') }, [
            el('span', { class: 'mg-sb-rank' }, ['' + (i + 1)]),
            el('span', { class: 'mg-sb-name' }, [r.name + (r.me ? ' (du)' : '')]),
            el('span', { class: 'mg-sb-score' }, [App.MG.fmt(r.score)])
          ]));
        });
      }

      /* ===================== Zeichnen ===================== */
      function resize() {
        if (!canvas) return;
        var cssW = canvas.clientWidth || canvas.parentNode && canvas.parentNode.clientWidth || 320;
        var dpr = window.devicePixelRatio || 1;
        var cssH = Math.round(cssW * (VH / VW));
        canvas.style.height = cssH + 'px';
        canvas.width = Math.max(1, Math.round(cssW * dpr));
        canvas.height = Math.max(1, Math.round(cssH * dpr));
        scale = cssW / VW;
        lastW = cssW;
        g.setTransform(scale * dpr, 0, 0, scale * dpr, 0, 0);
      }

      function discW(size) {
        var span = Math.max(1, n - 1);
        return 64 + 136 * ((size - 1) / span);
      }
      function discColor(size) { return 90 + ((size - 1) % 9) * 30; }

      function drawDisc(size, cx, cy, glow) {
        var w = discW(size), h = DH - 4, hue = discColor(size);
        var x = cx - w / 2, y = cy - h / 2;
        if (glow) { g.shadowColor = 'hsla(' + hue + ',95%,60%,.9)'; g.shadowBlur = 22; }
        var grd = g.createLinearGradient(0, y, 0, y + h);
        grd.addColorStop(0, 'hsl(' + hue + ',92%,64%)');
        grd.addColorStop(0.5, 'hsl(' + hue + ',88%,48%)');
        grd.addColorStop(1, 'hsl(' + hue + ',80%,30%)');
        rr(g, x, y, w, h, h / 2);
        g.fillStyle = grd; g.fill();
        g.shadowBlur = 0;
        g.lineWidth = 1.5;
        g.strokeStyle = 'hsla(' + hue + ',100%,82%,.9)';
        g.stroke();
        rr(g, x + 5, y + 2.5, Math.max(6, w - 10), 4, 2);
        g.fillStyle = 'rgba(255,255,255,.28)'; g.fill();
        g.fillStyle = 'rgba(4,18,10,.85)';
        g.font = '800 12px system-ui, -apple-system, sans-serif';
        g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillText(String(size), cx, cy + 1);
      }

      function legalFor(size, peg) {
        var t = pegs[peg];
        return !t.length || t[t.length - 1] > size;
      }

      function draw() {
        raf = requestAnimationFrame(draw);
        if (dead || !canvas || !g) return;
        if (canvas.clientWidth && canvas.clientWidth !== lastW) resize();
        var now = Date.now();
        if (anim && now - anim.t0 >= anim.dur) anim = null;

        /* Hintergrund */
        var bg = g.createLinearGradient(0, 0, 0, VH);
        bg.addColorStop(0, '#071c12'); bg.addColorStop(1, '#03100a');
        g.fillStyle = bg; g.fillRect(0, 0, VW, VH);
        var glow = g.createRadialGradient(PEGX[2], 200, 20, PEGX[2], 200, 250);
        glow.addColorStop(0, 'rgba(255,210,63,.13)'); glow.addColorStop(1, 'rgba(255,210,63,0)');
        g.fillStyle = glow; g.fillRect(0, 0, VW, VH);

        /* Spalten-Markierung, wenn eine Scheibe in der Hand ist */
        if (held) {
          for (var c = 0; c < 3; c++) {
            if (c === held.from) continue;
            var ok = legalFor(held.size, c);
            g.fillStyle = ok ? 'rgba(57,255,20,.09)' : 'rgba(255,77,109,.09)';
            g.fillRect(PEGX[c] - 112, TOP_Y - 34, 224, BASE_Y - TOP_Y + 48);
            g.strokeStyle = ok ? 'rgba(57,255,20,.5)' : 'rgba(255,77,109,.45)';
            g.lineWidth = 2; g.setLineDash([8, 7]);
            g.strokeRect(PEGX[c] - 112, TOP_Y - 34, 224, BASE_Y - TOP_Y + 48);
            g.setLineDash([]);
          }
        }

        /* Stäbe */
        for (var i = 0; i < 3; i++) {
          var isGoal = i === 2;
          g.shadowColor = isGoal ? 'rgba(255,210,63,.55)' : 'rgba(51,230,208,.35)';
          g.shadowBlur = isGoal ? 16 : 8;
          rr(g, PEGX[i] - 6, TOP_Y, 12, BASE_Y - TOP_Y + 6, 6);
          g.fillStyle = isGoal ? 'rgba(255,210,63,.85)' : 'rgba(51,230,208,.7)';
          g.fill();
          g.shadowBlur = 0;
        }

        /* Sockel */
        var base = g.createLinearGradient(0, BASE_Y, 0, BASE_Y + 16);
        base.addColorStop(0, 'rgba(57,255,20,.6)'); base.addColorStop(1, 'rgba(12,60,30,.9)');
        rr(g, 36, BASE_Y, VW - 72, 16, 8);
        g.fillStyle = base; g.fill();
        g.strokeStyle = 'rgba(57,255,20,.45)'; g.lineWidth = 1.5; g.stroke();

        /* Beschriftung */
        g.font = '700 14px system-ui, -apple-system, sans-serif';
        g.textAlign = 'center'; g.textBaseline = 'top';
        for (var l = 0; l < 3; l++) {
          g.fillStyle = l === 2 ? 'rgba(255,210,63,.95)' : 'rgba(140,200,170,.75)';
          g.fillText(PEG_LABEL[l], PEGX[l], BASE_Y + 20);
        }

        /* Scheiben auf den Stäben */
        for (var p = 0; p < 3; p++) {
          for (var j = 0; j < pegs[p].length; j++) {
            if (anim && anim.peg === p && anim.idx === j) continue;   // die fliegt gerade
            var s = slotPos(p, j);
            drawDisc(pegs[p][j], s.x, s.y, false);
          }
        }

        /* Flug-Animation (Bogen über die Stäbe) */
        if (anim) {
          var t = Math.min(1, (now - anim.t0) / anim.dur);
          var e = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;          // ease-in-out
          var ax = anim.x0 + (anim.x1 - anim.x0) * e;
          var ay = anim.y0 + (anim.y1 - anim.y0) * e - Math.sin(Math.PI * e) * 34;
          drawDisc(anim.size, ax, ay, true);
        }

        /* Scheibe in der Hand */
        if (held) {
          var hp = heldPos();
          var hy = held.dragging ? hp.y : HOLD_Y + Math.sin(now / 260) * 5;
          g.save();
          g.globalAlpha = 0.25;
          g.fillStyle = '#000';
          g.beginPath(); g.ellipse(PEGX[colAt(hp.x)], BASE_Y + 2, discW(held.size) / 2.4, 5, 0, 0, Math.PI * 2); g.fill();
          g.restore();
          drawDisc(held.size, hp.x, hy, true);
        }

        /* Tipp-Anzeige */
        if (hintMove && !held) {
          var src = pegs[hintMove.from];
          if (src.length) {
            var sp = slotPos(hintMove.from, src.length - 1);
            var pulse = 0.55 + 0.45 * Math.sin(now / 180);
            g.strokeStyle = 'rgba(255,210,63,' + pulse.toFixed(2) + ')';
            g.lineWidth = 3;
            rr(g, sp.x - discW(src[src.length - 1]) / 2 - 4, sp.y - DH / 2 - 2, discW(src[src.length - 1]) + 8, DH, 12);
            g.stroke();
          }
          var tx = PEGX[hintMove.to];
          g.fillStyle = 'rgba(255,210,63,' + (0.5 + 0.5 * Math.sin(now / 180)).toFixed(2) + ')';
          g.beginPath();
          g.moveTo(tx, TOP_Y - 8); g.lineTo(tx - 13, TOP_Y - 30); g.lineTo(tx + 13, TOP_Y - 30);
          g.closePath(); g.fill();
        }
      }

      /* ===================== ENDE ===================== */
      function finish() {
        if (finished || dead) return;
        finished = true;
        started = false;
        held = null; anim = null;
        clearPending();
        stopHelpers();
        stopRaf();
        sfx('cashout');

        if (isMulti) {
          ctx.room.reportScore(score);
          var pl = el('div', { class: 'hno-wait glass' }, [
            el('div', { class: 'hno-intro-ico' }, ['🏁']),
            el('h2', { class: 'neon' }, ['Zeit um!']),
            el('p', { class: 'hint-text' }, [App.MG.fmt(score) + ' Punkte · ' + solved + ' Türme gelöst'])
          ]);
          root.innerHTML = ''; root.appendChild(pl);
          var t = setTimeout(function () {
            if (dead) return;
            App.MG.endScreen(root, { players: ctx.room.players(), meId: ctx.me.id, onExit: ctx.onExit });
          }, 1200);
          pending.push(t);
        } else {
          botTick();
          var best = App.Storage.get('best_towerhanoi', 0);
          var nb = score > best;
          if (nb) App.Storage.set('best_towerhanoi', score);
          var beat = score > botScore;
          App.MG.endScreen(root, {
            score: score, best: best, newBest: nb,
            title: beat ? '🏆 Geist geschlagen!' : '🏁 Zeit um!',
            label: solved + ' Türme gelöst · ' + botLevel.icon + ' ' + botLevel.name + ': ' + App.MG.fmt(botScore) + ' Punkte · '
              + (nb ? 'neuer Rekord! 🎉' : 'Bestwert: ' + App.MG.fmt(best)),
            onExit: ctx.onExit,
            onAgain: function () { finished = false; play(Date.now()); }
          });
        }
      }
    }
  };

  /* ===================== STYLES ===================== */
  function injectStyle() {
    UI.injectStyle('mg-towerhanoi-css', [
      '.hno-layout{display:flex;flex-direction:column;gap:10px;}',
      /* Kopfzeile */
      '.hno-head{display:flex;justify-content:space-between;align-items:center;padding:10px 16px;gap:10px;}',
      '.hno-hcell{display:flex;flex-direction:column;gap:1px;min-width:0;}',
      '.hno-hmid{text-align:center;}',
      '.hno-hright{text-align:right;}',
      '.hno-hl{color:var(--muted);font-size:10px;text-transform:uppercase;letter-spacing:1px;white-space:nowrap;}',
      '.hno-big{font-size:clamp(18px,4.6vw,30px);font-weight:900;line-height:1.1;font-variant-numeric:tabular-nums;}',
      '.hno-gold{color:var(--gold);text-shadow:0 0 12px rgba(255,210,63,.45);}',
      '.hno-aqua{color:var(--aqua);text-shadow:0 0 12px rgba(51,230,208,.4);}',
      '.hno-warn{color:var(--danger);text-shadow:0 0 12px rgba(255,77,109,.45);}',
      '.hno-head .mg-timer{font-size:clamp(16px,4.2vw,24px);}',
      '.mg-timer.hno-urgent{color:var(--danger);animation:hno-pulse .7s infinite;}',
      /* Spielfläche */
      '.hno-stage{position:relative;width:100%;max-width:720px;margin:0 auto;}',
      '.hno-canvas{display:block;width:100%;border-radius:18px;border:1px solid var(--stroke-2);',
      'background:#03100a;box-shadow:0 0 28px rgba(57,255,20,.12),inset 0 0 40px rgba(0,0,0,.5);',
      'touch-action:none;user-select:none;-webkit-user-select:none;-webkit-tap-highlight-color:transparent;cursor:pointer;}',
      '.hno-shake{animation:hno-shake .3s ease;}',
      /* Einblendung */
      '.hno-flash{position:absolute;left:50%;top:10px;transform:translate(-50%,-14px);opacity:0;pointer-events:none;',
      'padding:7px 16px;border-radius:999px;font-weight:900;font-size:clamp(12px,3vw,17px);white-space:nowrap;',
      'background:rgba(4,16,10,.92);border:1px solid var(--stroke-2);transition:opacity .18s,transform .18s;max-width:94%;overflow:hidden;text-overflow:ellipsis;}',
      '.hno-flash.hno-f-on{opacity:1;transform:translate(-50%,0);}',
      '.hno-f-good{color:var(--neon);border-color:var(--neon);box-shadow:0 0 22px rgba(57,255,20,.5);}',
      '.hno-f-bad{color:#fff;background:rgba(120,10,32,.95);border-color:var(--danger);box-shadow:0 0 22px rgba(255,77,109,.5);}',
      '.hno-f-warn{color:var(--gold);border-color:var(--gold);box-shadow:0 0 20px rgba(255,210,63,.4);}',
      '.hno-f-info{color:var(--aqua);border-color:var(--aqua);box-shadow:0 0 20px rgba(51,230,208,.35);}',
      /* Chips + Knöpfe */
      '.hno-chips{display:flex;gap:8px;justify-content:center;flex-wrap:wrap;}',
      '.hno-chip{font-size:12px;font-weight:800;}',
      '.hno-chip-warn{color:var(--gold);border-color:var(--gold);}',
      '.hno-hide{display:none;}',
      '.hno-btns{justify-content:center;gap:10px;}',
      '.hno-btns .btn{padding:8px 16px;font-size:14px;}',
      '.hno-rule{margin:0;text-align:center;font-size:12px;line-height:1.45;}',
      /* Rangliste */
      '.hno-board{padding:12px;display:flex;flex-direction:column;gap:8px;}',
      '.hno-board .mg-scoreboard{max-height:230px;overflow-y:auto;}',
      /* Startbildschirm (Solo) */
      '.hno-intro{padding:26px 22px;text-align:center;display:flex;flex-direction:column;gap:12px;align-items:center;max-width:560px;margin:0 auto;}',
      '.hno-intro-ico{font-size:56px;line-height:1;filter:drop-shadow(0 0 16px rgba(57,255,20,.5));}',
      '.hno-intro h2{margin:0;}',
      '.hno-lvls{display:flex;gap:10px;flex-wrap:wrap;justify-content:center;width:100%;}',
      '.hno-lvl{flex:1 1 140px;min-width:130px;background:rgba(4,20,12,.7);border:1px solid var(--stroke);',
      'border-radius:16px;padding:14px 10px;cursor:pointer;font-family:inherit;color:#fff;display:flex;',
      'flex-direction:column;gap:4px;align-items:center;transition:transform .12s,border-color .12s,box-shadow .12s;}',
      '.hno-lvl:hover{transform:translateY(-3px);border-color:var(--stroke-2);box-shadow:0 0 22px rgba(57,255,20,.25);}',
      '.hno-lvl.is-on{border-color:var(--neon);box-shadow:0 0 22px rgba(57,255,20,.35);}',
      '.hno-lvl-ico{font-size:34px;line-height:1;}',
      '.hno-lvl-nm{font-weight:900;font-size:16px;}',
      '.hno-lvl-d{font-size:11px;color:var(--muted);line-height:1.35;}',
      '.hno-wait{padding:34px 24px;text-align:center;display:flex;flex-direction:column;gap:8px;align-items:center;max-width:480px;margin:0 auto;}',
      /* Animationen */
      '@keyframes hno-pulse{0%,100%{opacity:1}50%{opacity:.4}}',
      '@keyframes hno-shake{0%,100%{transform:translateX(0)}20%{transform:translateX(-8px)}60%{transform:translateX(8px)}}'
    ].join(''));
  }
})();
