/* pong.js — "Neon-Pong": klassisches Pong als Echtzeit-Duell im Dschungel-Neon-Look.
 * Zwei Schläger (links/rechts), ein leuchtender Ball mit Spur, gestrichelte Mittellinie,
 * großer Punktestand oben. Erster auf 7 Punkte gewinnt (Zeitlimit als Fallback).
 *
 * SOLO  : Spieler links (Maus-Y / Touch / Pfeiltasten / W-S), rechts eine faire, schlagbare Bot-KI.
 * MULTI : Host-autoritativ. Host rechnet die komplette Physik + Punkte und broadcastet den
 *         Zustand gedrosselt (~50 ms) via room.setShared(). Jeder Spieler meldet nur seinen
 *         eigenen Schläger via room.reportState({paddle}) (~50 ms). Der Nicht-Host rendert den
 *         empfangenen Zustand und interpoliert den Ball lokal zwischen Updates.
 * Zeit im Multiplayer immer über room.now() (synchron). cleanup() stoppt wirklich alles. */
(function () {
  'use strict';
  window.App = window.App || {}; App.Minigames = App.Minigames || {};
  var UI = App.UI, el = UI.el;

  /* ---- Virtuelles Spielfeld (feste Koordinaten, Canvas skaliert per CSS) ---- */
  var W = 960, H = 560;           // Spielfeld in virtuellen px
  var PADX = 26;                  // Abstand Schläger-Außenkante zur Wand
  var PW = 16, PH = 96;           // Schläger-Maße
  var BR = 10;                    // Ball-Radius
  var START_SPEED = 360;          // px/s Anfangs-Ballgeschwindigkeit
  var SPEEDUP = 1.045;            // pro Schlägerkontakt
  var MAX_SPEED = 780;            // Deckel
  var MAX_BOUNCE = 0.92;          // rad max. Abprallwinkel (~53°)
  var SERVE_DELAY = 800;          // ms Pause in der Mitte nach einem Tor
  var WIN = 7;                    // Punkte zum Sieg
  var MATCH_TIME = 300;           // s Fallback-Zeitlimit
  var BOT_SPEED = 350;            // px/s Bot-Schläger (bewusst schlagbar)
  var KB_SPEED = 640;             // px/s Schläger per Tastatur
  var BROADCAST_MS = 50;          // Host: setShared-Drossel
  var REPORT_MS = 50;             // Spieler: reportState-Drossel

  injectStyle();

  App.Minigames.pong = {
    id: 'pong', title: 'Neon-Pong', icon: '🏓', order: 20,
    subtitle: 'Der Klassiker — erster mit 7 Punkten gewinnt',
    single: true, multi: true, minPlayers: 2, maxPlayers: 2,

    render: function (root, ctx) {
      var mode = ctx.mode;                 // 'single' | 'multi'
      var timeNow = (mode === 'multi') ? function () { return ctx.room.now(); } : function () { return Date.now(); };

      /* ---- Laufzeit-Zustand ---- */
      var raf = null, ended = false, last = 0;
      var st = null;                        // Physik-Zustand (Host/Solo maßgeblich)
      var ctx2d = null;
      var myPaddleY = H / 2, botPaddleY = H / 2, botErr = 0, prevVx = 0;
      var trail = [];
      var keys = { up: false, down: false };
      var listeners = [];                   // {t,ty,fn,opts}
      var stops = [];                       // Aufräum-Funktionen (Timer/room.off)
      var matchStartAt = 0;

      /* ---- Multiplayer-spezifisch ---- */
      var leftId = null, rightId = null, oppId = null, amLeft = true;
      var lastOppY = H / 2, lastReport = 0, lastBroadcast = 0;
      var netShared = null, netBall = null, sharedHandler = null;

      /* ================= Helfer: Listener & Aufräumen ================= */
      function addL(target, type, fn, opts) { target.addEventListener(type, fn, opts); listeners.push({ t: target, ty: type, fn: fn, opts: opts }); }
      function removeAllListeners() { listeners.forEach(function (l) { try { l.t.removeEventListener(l.ty, l.fn, l.opts); } catch (e) {} }); listeners = []; }
      function addStop(fn) { if (fn) stops.push(fn); }
      function cleanup() {
        ended = true;
        if (raf) { cancelAnimationFrame(raf); raf = null; }
        stops.forEach(function (f) { try { f(); } catch (e) {} }); stops = [];
        removeAllListeners();
      }

      /* ================= Start ================= */
      if (mode === 'single') startSolo(); else startMulti();
      return { cleanup: cleanup };

      /* ================= SOLO ================= */
      function startSolo() {
        ended = false;
        if (raf) { cancelAnimationFrame(raf); raf = null; }
        var refs = buildStage((ctx.me && ctx.me.name) ? ctx.me.name : 'Du', 'Bot 🤖');
        setupCanvas(refs.canvas);
        attachInput(refs.canvas, true);
        st = newState('L', 'R');
        st.nextDir = Math.random() < 0.5 ? -1 : 1;
        st.serveAt = Date.now() + 1200;    // kleine Orientierungspause zu Beginn
        myPaddleY = H / 2; botPaddleY = H / 2; botErr = 0; prevVx = 0; trail = [];
        matchStartAt = Date.now();
        last = Date.now();
        raf = requestAnimationFrame(frame);
      }

      function updateBot(dt) {
        // Fehler-Offset neu würfeln, sobald der Ball Richtung Bot startet -> fair schlagbar
        if (st.vx > 0 && prevVx <= 0) botErr = (Math.random() * 2 - 1) * PH * 0.55;
        prevVx = st.vx;
        var target = (st.vx > 0) ? (st.by + botErr) : (H / 2 + botErr * 0.3);
        var d = target - botPaddleY, step = BOT_SPEED * dt;
        if (Math.abs(d) <= step) botPaddleY = target;
        else botPaddleY += (d > 0 ? 1 : -1) * step;
        botPaddleY = clampPaddle(botPaddleY);
      }

      function soloWin() {
        if (ended) return;
        var iWon = st.winner === 'L';
        showEnd(iWon, st.scoreL + ' : ' + st.scoreR, { onAgain: startSolo, onExit: ctx.onExit, exitLabel: 'Zurück' });
      }

      /* ================= MULTI ================= */
      function startMulti() {
        var proceeded = false;
        function maybeStart() {
          if (proceeded || ended) return;
          var ps = ctx.room.players();
          if (ps.length >= 2) {
            proceeded = true;
            var snap = ctx.room.snapshot() || {};
            var startAt = (snap.round && snap.round.startAt) || (ctx.room.now() + 3000);
            addStop(App.MG.countdown(root, startAt, function () { playMulti(startAt); }, ctx.room.now));
          } else {
            showWaiting();
          }
        }
        var ph = function () { maybeStart(); };
        ctx.room.on('players', ph);
        addStop(function () { ctx.room.off('players', ph); });
        maybeStart();
      }

      function playMulti(startAt) {
        var ps = ctx.room.players();
        leftId = ps[0] ? ps[0].id : null;
        rightId = ps[1] ? ps[1].id : null;
        amLeft = (ctx.me.id === leftId);
        oppId = amLeft ? rightId : leftId;
        var lName = (ps[0] ? ps[0].name : 'Links') + (amLeft ? ' (du)' : '');
        var rName = (ps[1] ? ps[1].name : 'Rechts') + (!amLeft ? ' (du)' : '');
        var refs = buildStage(lName, rName);
        setupCanvas(refs.canvas);
        attachInput(refs.canvas, false);

        st = newState(leftId || 'L', rightId || 'R');
        st.nextDir = Math.random() < 0.5 ? -1 : 1;
        st.serveAt = ctx.room.now() + 900;
        myPaddleY = H / 2; trail = []; lastOppY = H / 2;
        lastReport = 0; lastBroadcast = 0;
        matchStartAt = startAt;

        var snap = ctx.room.snapshot();
        netShared = (snap && snap.shared) || null;
        sharedHandler = function (sh) { onShared(sh); };
        ctx.room.on('shared', sharedHandler);
        addStop(function () { ctx.room.off('shared', sharedHandler); });

        ended = false;
        last = ctx.room.now();
        raf = requestAnimationFrame(frame);
      }

      function onShared(sh) {
        if (!sh) return;
        netShared = sh;
        if (sh.ball) netBall = { x: sh.ball.x, y: sh.ball.y, vx: sh.ball.vx, vy: sh.ball.vy, t: (typeof sh.t === 'number' ? sh.t : ctx.room.now()) };
        if (!ctx.room.isHost() && st) {
          // Zustand mitführen -> falls ich unerwartet Host werde, kann ich weiterrechnen
          if (sh.ball) { st.bx = sh.ball.x; st.by = sh.ball.y; st.vx = sh.ball.vx; st.vy = sh.ball.vy; }
          if (typeof sh.scoreL === 'number') st.scoreL = sh.scoreL;
          if (typeof sh.scoreR === 'number') st.scoreR = sh.scoreR;
          if (typeof sh.paddleL === 'number') st.paddleL = sh.paddleL;
          if (typeof sh.paddleR === 'number') st.paddleR = sh.paddleR;
          if (sh.winner) st.winner = sh.winner;
        }
        if (sh.winner) multiWin(sh.winner);
      }

      function multiWin(winnerId) {
        if (ended) return;
        var iWon = (winnerId === ctx.me.id);
        var sub = (st ? st.scoreL : 0) + ' : ' + (st ? st.scoreR : 0);
        showEnd(iWon, sub, { onExit: ctx.onExit, exitLabel: 'Zurück zur Lobby' });
      }

      /* ================= Gemeinsamer Frame-Loop ================= */
      function frame() {
        if (ended) { raf = null; return; }
        var now = timeNow();
        var dt = (now - last) / 1000; if (dt < 0) dt = 0; if (dt > 0.05) dt = 0.05; last = now;

        // Eigenen Schläger per Tastatur bewegen (Maus/Touch setzen ihn direkt via Listener)
        var kd = (keys.down ? 1 : 0) - (keys.up ? 1 : 0);
        if (kd !== 0) myPaddleY = clampPaddle(myPaddleY + kd * KB_SPEED * dt);

        var dispPL, dispPR, dispBall, dispSL, dispSR;

        if (mode === 'single') {
          updateBot(dt);
          stepPhysics(st, dt, myPaddleY, botPaddleY, now);
          checkFallback(now);
          dispPL = myPaddleY; dispPR = botPaddleY; dispBall = { x: st.bx, y: st.by };
          dispSL = st.scoreL; dispSR = st.scoreR;
          if (st.winner) { drawScene(dispPL, dispPR, dispBall, dispSL, dispSR); return soloWin(); }

        } else {
          var isHostNow = !!ctx.room.isHost();
          // Eigenen Schläger melden (gedrosselt) — sowohl Host als auch Gast
          if (now - lastReport >= REPORT_MS) { lastReport = now; try { ctx.room.reportState({ paddle: myPaddleY }); } catch (e) {} }

          if (isHostNow) {
            var ps = ctx.room.players();
            if (ps.length < 2 && !st.winner) st.winner = ctx.me.id;   // Gegner weg -> Sieg
            var opp = null;
            for (var i = 0; i < ps.length; i++) { if (ps[i].id === oppId) { opp = ps[i]; break; } }
            var oppY = (opp && opp.state && typeof opp.state.paddle === 'number') ? opp.state.paddle : lastOppY;
            lastOppY = oppY;
            var plh = amLeft ? myPaddleY : oppY, prh = amLeft ? oppY : myPaddleY;
            stepPhysics(st, dt, plh, prh, now);
            checkFallback(now);
            st.paddleL = plh; st.paddleR = prh;
            if (now - lastBroadcast >= BROADCAST_MS || st.winner) {
              lastBroadcast = now;
              try {
                ctx.room.setShared({
                  ball: { x: st.bx, y: st.by, vx: st.vx, vy: st.vy },
                  scoreL: st.scoreL, scoreR: st.scoreR, paddleL: plh, paddleR: prh,
                  winner: st.winner || null, t: now
                });
              } catch (e) {}
            }
            dispPL = plh; dispPR = prh; dispBall = { x: st.bx, y: st.by };
            dispSL = st.scoreL; dispSR = st.scoreR;
            if (st.winner) { drawScene(dispPL, dispPR, dispBall, dispSL, dispSR); return multiWin(st.winner); }

          } else {
            var b = predictBall(now);
            dispBall = b;
            dispSL = (netShared && typeof netShared.scoreL === 'number') ? netShared.scoreL : 0;
            dispSR = (netShared && typeof netShared.scoreR === 'number') ? netShared.scoreR : 0;
            var shPL = (netShared && typeof netShared.paddleL === 'number') ? netShared.paddleL : H / 2;
            var shPR = (netShared && typeof netShared.paddleR === 'number') ? netShared.paddleR : H / 2;
            dispPL = amLeft ? myPaddleY : shPL;   // eigenen Schläger lokal (responsiv), Gegner vom Host
            dispPR = amLeft ? shPR : myPaddleY;
            if (netShared && netShared.winner) { drawScene(dispPL, dispPR, dispBall, dispSL, dispSR); return multiWin(netShared.winner); }
          }
        }

        trail.push({ x: dispBall.x, y: dispBall.y }); if (trail.length > 14) trail.shift();
        drawScene(dispPL, dispPR, dispBall, dispSL, dispSR);
        raf = requestAnimationFrame(frame);
      }

      /* ================= Physik ================= */
      function newState(l, r) {
        return { bx: W / 2, by: H / 2, vx: 0, vy: 0, scoreL: 0, scoreR: 0,
          serveAt: 0, nextDir: 1, leftId: l, rightId: r, winner: null,
          paddleL: H / 2, paddleR: H / 2 };
      }
      function launch(s) {
        var ang = (Math.random() * 2 - 1) * 0.45;
        s.vx = s.nextDir * START_SPEED * Math.cos(ang);
        s.vy = START_SPEED * Math.sin(ang);
      }
      function serve(s, offSide, now) {
        s.bx = W / 2; s.by = H / 2; s.vx = 0; s.vy = 0;
        s.serveAt = now + SERVE_DELAY;
        s.nextDir = (offSide === 'L') ? -1 : 1;   // Aufschlag zum Punktverlierer
      }
      function paddleBounce(s, py, dir) {
        var speed = Math.min(MAX_SPEED, Math.hypot(s.vx, s.vy) * SPEEDUP);
        var rel = (s.by - py) / (PH / 2 + BR);
        if (rel > 1) rel = 1; if (rel < -1) rel = -1;
        var ang = rel * MAX_BOUNCE;
        s.vx = dir * speed * Math.cos(ang);
        s.vy = speed * Math.sin(ang);
      }
      function stepPhysics(s, dt, pl, pr, now) {
        if (s.winner) return;
        if (s.vx === 0 && s.vy === 0) { if (now >= (s.serveAt || 0)) launch(s); return; }
        s.bx += s.vx * dt; s.by += s.vy * dt;
        if (s.by < BR) { s.by = BR; s.vy = Math.abs(s.vy); }
        else if (s.by > H - BR) { s.by = H - BR; s.vy = -Math.abs(s.vy); }
        var faceL = PADX + PW, faceR = W - PADX - PW;
        if (s.vx < 0 && (s.bx - BR) <= faceL && (s.bx - BR) >= faceL - 52) {
          if (s.by >= pl - PH / 2 - BR && s.by <= pl + PH / 2 + BR) { s.bx = faceL + BR; paddleBounce(s, pl, 1); }
        } else if (s.vx > 0 && (s.bx + BR) >= faceR && (s.bx + BR) <= faceR + 52) {
          if (s.by >= pr - PH / 2 - BR && s.by <= pr + PH / 2 + BR) { s.bx = faceR - BR; paddleBounce(s, pr, -1); }
        }
        if (s.bx < -BR * 3) { s.scoreR++; serve(s, 'L', now); }
        else if (s.bx > W + BR * 3) { s.scoreL++; serve(s, 'R', now); }
        if (s.scoreL >= WIN) s.winner = s.leftId;
        else if (s.scoreR >= WIN) s.winner = s.rightId;
      }
      function checkFallback(now) {
        if (st.winner) return;
        if ((now - matchStartAt) / 1000 > MATCH_TIME && st.scoreL !== st.scoreR) {
          st.winner = st.scoreL > st.scoreR ? st.leftId : st.rightId;
        }
      }
      // Nicht-Host: Ball zwischen Netz-Updates lokal weiterrechnen (mit Wand-Reflexion)
      function predictBall(now) {
        if (!netBall) return { x: W / 2, y: H / 2 };
        var e = (now - netBall.t) / 1000; if (e < 0) e = 0; if (e > 0.6) e = 0.6;
        var x = netBall.x + netBall.vx * e;
        var y = netBall.y + netBall.vy * e;
        var span = H - 2 * BR;
        if (span > 0) {
          var yy = ((((y - BR) % (2 * span)) + 2 * span) % (2 * span));
          if (yy > span) yy = 2 * span - yy;
          y = yy + BR;
        }
        if (x < -BR * 3) x = -BR * 3; if (x > W + BR * 3) x = W + BR * 3;
        return { x: x, y: y };
      }

      /* ================= Rendering ================= */
      function setupCanvas(canvas) { ctx2d = canvas.getContext('2d'); }
      function clampPaddle(y) { return Math.max(PH / 2, Math.min(H - PH / 2, y)); }
      function roundRect(g, x, y, w, h, r) {
        r = Math.min(r, w / 2, h / 2);
        g.beginPath();
        g.moveTo(x + r, y);
        g.arcTo(x + w, y, x + w, y + h, r);
        g.arcTo(x + w, y + h, x, y + h, r);
        g.arcTo(x, y + h, x, y, r);
        g.arcTo(x, y, x + w, y, r);
        g.closePath();
      }
      function drawScene(pl, pr, ball, sL, sR) {
        var g = ctx2d; if (!g) return;
        g.clearRect(0, 0, W, H);
        var grd = g.createLinearGradient(0, 0, 0, H);
        grd.addColorStop(0, '#06180e'); grd.addColorStop(1, '#020c07');
        g.fillStyle = grd; g.fillRect(0, 0, W, H);
        // Feldrahmen
        g.save(); g.strokeStyle = 'rgba(57,255,20,0.22)'; g.lineWidth = 4;
        roundRect(g, 6, 6, W - 12, H - 12, 18); g.stroke(); g.restore();
        // gestrichelte Mittellinie
        g.save(); g.strokeStyle = 'rgba(157,255,122,0.35)'; g.lineWidth = 4; g.setLineDash([16, 20]);
        g.beginPath(); g.moveTo(W / 2, 22); g.lineTo(W / 2, H - 22); g.stroke(); g.restore();
        // Punktestand (groß, oben)
        g.save(); g.font = '900 92px "Segoe UI",system-ui,Roboto,Arial,sans-serif';
        g.textAlign = 'center'; g.textBaseline = 'top'; g.shadowBlur = 24;
        g.fillStyle = 'rgba(57,255,20,0.92)'; g.shadowColor = 'rgba(57,255,20,0.55)';
        g.fillText(String(sL), W / 2 - 90, 26);
        g.fillStyle = 'rgba(51,230,208,0.92)'; g.shadowColor = 'rgba(51,230,208,0.55)';
        g.fillText(String(sR), W / 2 + 90, 26); g.restore();
        // Schläger
        drawPaddle(g, PADX, pl, '#39ff14', 'rgba(57,255,20,0.75)');
        drawPaddle(g, W - PADX - PW, pr, '#33e6d0', 'rgba(51,230,208,0.75)');
        // Ball-Spur
        g.save();
        for (var i = 0; i < trail.length; i++) {
          var tp = trail[i], a = (i + 1) / trail.length;
          g.fillStyle = 'rgba(180,255,150,' + (a * 0.30).toFixed(3) + ')';
          g.beginPath(); g.arc(tp.x, tp.y, BR * (0.4 + a * 0.7), 0, Math.PI * 2); g.fill();
        }
        g.restore();
        // Ball
        g.save(); g.shadowColor = 'rgba(57,255,20,0.95)'; g.shadowBlur = 28; g.fillStyle = '#eaffe0';
        g.beginPath(); g.arc(ball.x, ball.y, BR, 0, Math.PI * 2); g.fill(); g.restore();
      }
      function drawPaddle(g, x, cy, color, glow) {
        g.save(); g.shadowColor = glow; g.shadowBlur = 22; g.fillStyle = color;
        roundRect(g, x, clampPaddle(cy) - PH / 2, PW, PH, PW / 2); g.fill(); g.restore();
      }

      /* ================= UI-Aufbau ================= */
      function buildStage(lName, rName) {
        var head = el('div', { class: 'mgp-head glass' }, [
          el('div', { class: 'mgp-name mgp-name-l' }, [lName]),
          el('div', { class: 'mgp-goal' }, ['erster auf ' + WIN]),
          el('div', { class: 'mgp-name mgp-name-r' }, [rName])
        ]);
        var canvas = el('canvas', { class: 'mgp-canvas', width: W, height: H });
        var stage = el('div', { class: 'mgp-stage' }, [canvas]);
        var hint = el('div', { class: 'mgp-hint hint-text' },
          ['Maus · Pfeiltasten ↑ ↓ · W / S · am Handy: Finger auf deiner Hälfte ziehen']);
        var wrap = el('div', { class: 'mgp-wrap' }, [head, stage, hint]);
        root.innerHTML = ''; root.appendChild(wrap);
        return { canvas: canvas };
      }
      function showWaiting() {
        root.innerHTML = '';
        root.appendChild(el('div', { class: 'glass mgp-wait' }, [
          el('div', { class: 'mgp-wait-emoji' }, ['🏓']),
          el('h3', { class: 'neon' }, ['Neon-Pong']),
          el('p', { class: 'hint-text' }, ['Warte auf zweiten Spieler …'])
        ]));
      }
      function showEnd(iWon, subtitle, opts) {
        ended = true;
        if (raf) { cancelAnimationFrame(raf); raf = null; }
        var actions = [];
        if (opts.onAgain) actions.push(el('button', { class: 'btn btn-primary', type: 'button', onclick: opts.onAgain }, ['Nochmal']));
        actions.push(el('button', { class: 'btn btn-ghost', type: 'button', onclick: opts.onExit }, [opts.exitLabel || 'Zurück']));
        var h = el('h2', { class: iWon ? 'neon mgp-end-win' : 'mgp-end-lose' }, [iWon ? 'Gewonnen!' : 'Verloren']);
        root.innerHTML = '';
        root.appendChild(el('div', { class: 'glass mgp-end' }, [
          el('div', { class: 'mgp-end-emoji' }, [iWon ? '🏆' : '💥']),
          h,
          el('div', { class: 'mgp-end-score big-readout' }, [subtitle]),
          el('div', { class: 'controls-row' }, actions)
        ]));
      }

      /* ================= Eingabe ================= */
      function clientToVY(canvas, clientY) { var r = canvas.getBoundingClientRect(); return (clientY - r.top) / r.height * H; }
      function clientToVX(canvas, clientX) { var r = canvas.getBoundingClientRect(); return (clientX - r.left) / r.width * W; }
      function pickTouch(canvas, touches, single) {
        var mid = W / 2;
        for (var i = 0; i < touches.length; i++) {
          var t = touches[i], vx = clientToVX(canvas, t.clientX);
          var mine = single ? true : (amLeft ? vx < mid + 60 : vx > mid - 60);
          if (mine) return t;
        }
        return touches[0];
      }
      function attachInput(canvas, single) {
        removeAllListeners();
        keys.up = keys.down = false;
        var onMouse = function (e) { myPaddleY = clampPaddle(clientToVY(canvas, e.clientY)); };
        addL(canvas, 'mousemove', onMouse);
        var onTouch = function (e) {
          e.preventDefault();
          var t = pickTouch(canvas, e.touches, single);
          if (t) myPaddleY = clampPaddle(clientToVY(canvas, t.clientY));
        };
        addL(canvas, 'touchstart', onTouch, { passive: false });
        addL(canvas, 'touchmove', onTouch, { passive: false });
        var onKeyDown = function (e) {
          var k = e.key;
          if (k === 'ArrowUp' || k === 'w' || k === 'W') { keys.up = true; e.preventDefault(); }
          else if (k === 'ArrowDown' || k === 's' || k === 'S') { keys.down = true; e.preventDefault(); }
        };
        var onKeyUp = function (e) {
          var k = e.key;
          if (k === 'ArrowUp' || k === 'w' || k === 'W') keys.up = false;
          else if (k === 'ArrowDown' || k === 's' || k === 'S') keys.down = false;
        };
        addL(document, 'keydown', onKeyDown);
        addL(document, 'keyup', onKeyUp);
      }
    }
  };

  /* ============================ STYLES ============================ */
  function injectStyle() {
    UI.injectStyle('mg-pong-css', [
      '.mgp-wrap{display:flex;flex-direction:column;gap:12px;align-items:stretch;}',
      '.mgp-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 18px;}',
      '.mgp-name{font-weight:900;font-size:clamp(14px,3.6vw,20px);letter-spacing:.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:40%;}',
      '.mgp-name-l{color:var(--neon);text-shadow:0 0 12px rgba(57,255,20,.5);text-align:left;}',
      '.mgp-name-r{color:var(--aqua);text-shadow:0 0 12px rgba(51,230,208,.5);text-align:right;}',
      '.mgp-goal{flex:1;text-align:center;color:var(--muted);font-size:12px;font-weight:800;text-transform:uppercase;letter-spacing:2px;}',
      '.mgp-stage{width:100%;max-width:820px;margin:0 auto;aspect-ratio:960 / 560;position:relative;}',
      '.mgp-canvas{display:block;width:100%;height:100%;border-radius:16px;',
      'border:2px solid rgba(57,255,20,.35);background:#04140c;',
      'box-shadow:0 0 42px rgba(57,255,20,.22),inset 0 0 60px rgba(57,255,20,.06);',
      'touch-action:none;user-select:none;-webkit-user-select:none;-webkit-tap-highlight-color:transparent;cursor:none;}',
      '.mgp-hint{text-align:center;}',
      '.mgp-wait{padding:44px;text-align:center;display:flex;flex-direction:column;gap:10px;align-items:center;max-width:440px;margin:0 auto;}',
      '.mgp-wait-emoji{font-size:52px;filter:drop-shadow(0 0 14px rgba(57,255,20,.5));animation:mgp-bob 1.6s ease-in-out infinite;}',
      '@keyframes mgp-bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-8px)}}',
      '.mgp-end{padding:30px;text-align:center;display:flex;flex-direction:column;gap:14px;align-items:center;max-width:520px;margin:0 auto;}',
      '.mgp-end-emoji{font-size:56px;filter:drop-shadow(0 0 16px rgba(57,255,20,.5));}',
      '.mgp-end h2{font-size:clamp(28px,7vw,44px);margin:0;}',
      '.mgp-end-win{color:var(--neon);text-shadow:0 0 18px rgba(57,255,20,.55);}',
      '.mgp-end-lose{color:var(--danger);text-shadow:0 0 18px rgba(255,77,109,.5);}',
      '.mgp-end-score{color:var(--aqua-soft);font-variant-numeric:tabular-nums;letter-spacing:4px;}'
    ].join(''));
  }
})();
