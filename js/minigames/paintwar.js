/* paintwar.js — "Farb-Krieg": Splatoon-artiger Flächenkampf auf einem 20x20-Gitter.
 *
 * IDEE     : Jeder fährt als leuchtender Farbklecks über das Feld und färbt jede Kachel,
 *            die er berührt, in seine Neon-Farbe — auch schon fremd gefärbte. Nach 90 s
 *            gewinnt, wer die meisten Kacheln hält.
 * TEMPO    : Auf EIGENER Farbe fährt man 40 % schneller, auf FREMDER Farbe deutlich
 *            langsamer, auf leerem Boden normal → eigene Wege freihalten lohnt sich.
 * BOMBE    : Alle 15 s erscheint eine Farbbombe. Wer sie einsammelt, darf sie per Knopf
 *            (bzw. LEERTASTE) werfen: sie landet ein Stück in Blickrichtung und färbt
 *            einen 5x5-Bereich auf einen Schlag.
 * STEUERUNG: WASD / Pfeiltasten, am Handy virtueller Joystick + 💣-Knopf.
 * PUNKTE   : Punkte = gefärbte Kacheln (max. 400). Prozentbalken pro Spieler live oben.
 *
 * SOLO     : Gegen 3 Bots in drei Schwierigkeitsstufen. Die Bots bewerten das Gitter über
 *            ein Integralbild (5x5-Fenster, fremde Kacheln zählen doppelt, weil sie einen
 *            Punkt bringen UND einen wegnehmen), gewichten mit der Entfernung, meiden die
 *            Ziele der anderen Bots, jagen die Bombe und werfen sie auf dichte Nester.
 * MULTI    : Host-autoritativ. Der HOST rechnet die komplette Simulation und broadcastet
 *            ~12x/s per room.setShared({pw:{…}}) — das Gitter kompakt als 400-Zeichen-
 *            Ziffernkette (KEIN Objektbaum), dazu Positionen, Bomben-Flags und das letzte
 *            Explosions-Ereignis. Alle anderen senden nur ihre Eingabe per
 *            room.reportState({ix,iy,tq}). Gäste sagen ihre eigene Figur lokal voraus
 *            (weiche Korrektur zur Host-Position) und interpolieren die übrigen.
 *            Jeder Client zählt seine eigenen Kacheln und meldet sie per reportScore.
 *
 * Alle Zeiten laufen über Wall-Clock (Date.now bzw. room.now im Multi) → Tab-Wechsel-sicher;
 * rAF zeichnet nur. cleanup() beendet wirklich alles (rAF, Timer, Listener, room.off). */
(function () {
  'use strict';
  window.App = window.App || {}; App.Minigames = App.Minigames || {};
  var UI = App.UI, el = UI.el;

  /* ---- Virtuelles Spielfeld (Canvas skaliert per CSS) ---- */
  var N = 20, CELL = 30, W = N * CELL, H = N * CELL;   // 20x20 Kacheln = 600x600
  var R = 11;                       // Radius des Farbklecks
  var SPAWN_R = 195;                // Startkreis um die Feldmitte
  var BASE_SPEED = 132;             // px/s auf leerem Boden
  var MUL_OWN = 1.4;                // eigene Farbe: +40 %
  var MUL_FOREIGN = 0.7;            // fremde Farbe: langsam
  var MUL_EMPTY = 1.0;
  var ACCEL = 14;                   // Lenk-Trägheit (1/s)
  var DURATION = 90;                // s Rundenzeit
  var BOMB_EVERY = 15000;           // ms zwischen Farbbomben
  var BOMB_R = 2;                   // 5x5 = Radius 2 Kacheln
  var THROW_DIST = 108;             // px Wurfweite in Blickrichtung
  var PICK_R = 18;                  // px Aufsammel-Radius der Bombe
  var FX_MS = 620;                  // ms Explosions-Animation
  var SCAN_R = 3;                   // Bot-Suchfenster: 7x7 Kacheln
  var MIN_TRIP = 3;                 // Kacheln: so weit muss ein Bot-Ziel mindestens weg sein
  var DIST_W = 0.18;                // Entfernungs-Abschlag pro Kachel bei der Zielwahl
  var BROADCAST_MS = 80;            // Host: ~12 Zustände/s
  var REPORT_MS = 80;               // Gast: Eingabe-Takt
  var COUNT_MS = 100;               // Takt für Kachel-Zählung/Balken
  var SCORE_MS = 500;               // Takt für reportScore
  var BLOOM = 150;                  // Auflösung der Glüh-Hilfsfläche
  var FONT = '"Segoe UI",system-ui,Roboto,Arial,sans-serif';

  var COLORS = ['#39ff14', '#33e6d0', '#ffd23f', '#ff4d6d', '#b47dff', '#ff9a3c'];
  var BOT_NAMES = ['Klecks', 'Pinsel', 'Sprüher'];
  var TOUCH = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);

  /* Bot-Stufen: speed = Tempo-Faktor, retarget = ms bis Neubewertung,
     noise = Zufall auf die Zielbewertung, bombChase = px Jagd-Radius auf die
     Bombe, bombDelay = ms "Nachdenken" bis zum Wurf. */
  var DIFFS = {
    leicht: { speed: 0.80, retarget: 1500, noise: 0.60, bombChase: 120, bombDelay: 900 },
    mittel: { speed: 0.94, retarget: 950, noise: 0.30, bombChase: 260, bombDelay: 550 },
    schwer: { speed: 1.04, retarget: 550, noise: 0.10, bombChase: 460, bombDelay: 260 }
  };

  injectStyle();

  App.Minigames.paintwar = {
    id: 'paintwar', title: 'Farb-Krieg', icon: '🖌️', order: 124,
    subtitle: 'Färb das Feld – wer am meisten hat, gewinnt',
    single: true, multi: true, minPlayers: 2, maxPlayers: 6,

    render: function (root, ctx) {
      var isMulti = ctx.mode === 'multi';
      var nowFn = isMulti ? function () { return ctx.room.now(); } : function () { return Date.now(); };

      /* ---- Aufräum-Register ---- */
      var dead = false, raf = null, stops = [], pending = [], listeners = [];

      /* ---- Laufzeit-Zustand ---- */
      var players = [], meIdx = 0, grid = null, tmpG = new Array(N * N);
      var gridCanvas = null, gctx = null, ctx2d = null, bloomC = null, bctx = null, bloomAt = 0;
      var bomb = null, effects = [], lastExp = null;
      var startAt = 0, endAt = 0, finished = false, last = 0;
      var nextBombAt = 0, diff = DIFFS.mittel;
      var keys = { u: false, d: false, l: false, r: false };
      var joy = { on: false, x: 0, y: 0, id: -1 };
      var throwSeq = 0;
      var lastReport = 0, lastBroadcast = 0, lastCount = 0, lastScoreReport = 0;
      var lastSec = -1, lastLeader = -1, myHadBomb = false;
      var netP = [], lastExpT = 0, firstApply = true, sharedHandler = null;
      var refs = null;
      var II = new Array((N + 1) * (N + 1));

      /* ================= Helfer: Listener / Timer / Aufräumen ================= */
      function addL(t, ty, fn, opts) { t.addEventListener(ty, fn, opts); listeners.push({ t: t, ty: ty, fn: fn, opts: opts }); }
      function removeAllL() { listeners.forEach(function (l) { try { l.t.removeEventListener(l.ty, l.fn, l.opts); } catch (e) {} }); listeners = []; }
      function after(ms, fn) { var t = setTimeout(function () { if (!dead) fn(); }, ms); pending.push(t); return t; }
      function clearPending() { pending.forEach(clearTimeout); pending = []; }
      function stopHelpers() { stops.forEach(function (f) { try { f(); } catch (e) {} }); stops = []; }
      function cleanup() {
        dead = true;
        if (raf) { cancelAnimationFrame(raf); raf = null; }
        clearPending(); stopHelpers(); removeAllL();
      }

      /* ================= Start ================= */
      if (isMulti) {
        var snap0 = ctx.room.snapshot() || {};
        var startAt0 = (snap0.round && snap0.round.startAt) || (ctx.room.now() + 3000);
        stops.push(App.MG.countdown(root, startAt0, function () { play(startAt0); }, ctx.room.now));
      } else {
        chooseDifficulty();
      }
      return { cleanup: cleanup };

      /* ================= Solo: Schwierigkeit ================= */
      function chooseDifficulty() {
        clearPending(); stopHelpers(); removeAllL();
        if (raf) { cancelAnimationFrame(raf); raf = null; }
        function mk(key, label, icon, txt) {
          return el('button', {
            class: 'btn btn-ghost pwr-diff-btn', type: 'button',
            onclick: function () { if (App.Audio) App.Audio.sfx('select'); diff = DIFFS[key]; startSolo(); }
          }, [
            el('span', { class: 'pwr-diff-ico' }, [icon]),
            el('span', { class: 'pwr-diff-t' }, [label]),
            el('span', { class: 'pwr-diff-s' }, [txt])
          ]);
        }
        root.innerHTML = '';
        root.appendChild(el('div', { class: 'glass pwr-diffbox' }, [
          el('div', { class: 'pwr-diff-hero' }, ['🖌️']),
          el('h2', { class: 'neon' }, ['Farb-Krieg']),
          el('p', { class: 'hint-text' }, ['Du gegen 3 Bots — 90 Sekunden lang färben. Auf eigener Farbe bist du 40 % schneller, auf fremder zäh wie Kaugummi.']),
          el('div', { class: 'pwr-diff-row' }, [
            mk('leicht', 'Leicht', '🌱', 'Gemütliche Bots'),
            mk('mittel', 'Mittel', '🔥', 'Gute Bots'),
            mk('schwer', 'Schwer', '💀', 'Gnadenlose Bots')
          ])
        ]));
      }
      function startSolo() {
        clearPending(); stopHelpers(); removeAllL();
        if (raf) { cancelAnimationFrame(raf); raf = null; }
        finished = false;
        var st0 = Date.now() + 3200;
        stops.push(App.MG.countdown(root, st0, function () { play(st0); }));
      }

      /* ================= Runde aufbauen ================= */
      function play(startAtMs) {
        clearPending(); stopHelpers(); removeAllL();
        if (raf) { cancelAnimationFrame(raf); raf = null; }
        finished = false;
        effects = []; bomb = null; lastExp = null; lastExpT = 0; firstApply = true;
        throwSeq = 0; lastReport = 0; lastBroadcast = 0; lastCount = 0; lastScoreReport = 0;
        lastSec = -1; lastLeader = -1; myHadBomb = false;
        startAt = startAtMs; endAt = startAt + DURATION * 1000;
        nextBombAt = startAt + BOMB_EVERY;

        buildRoster();
        initGrid();
        buildStage();
        attachInput();

        if (isMulti) {
          sharedHandler = function (sh) { applyShared(sh); };
          ctx.room.on('shared', sharedHandler);
          stops.push(function () { ctx.room.off('shared', sharedHandler); });
          var snap = ctx.room.snapshot();
          if (snap && snap.shared) applyShared(snap.shared);
          try { ctx.room.reportScore(0); } catch (e) {}
        }

        stops.push(App.MG.roundTimer(endAt, tickTimer, finish, isMulti ? ctx.room.now : null));
        if (App.Audio) App.Audio.sfx('start');
        last = nowFn();
        raf = requestAnimationFrame(frame);
      }

      function makePlayer(id, name, ci, isBot) {
        return {
          id: id, name: name, ci: ci, bot: !!isBot, speedMul: 1,
          x: 0, y: 0, vx: 0, vy: 0, fx: 0, fy: 1, dx: 0, dy: 0,
          bomb: false, tx: W / 2, ty: H / 2, retargetAt: 0, bombAt: 0, tq: 0
        };
      }

      function buildRoster() {
        players = []; netP = []; meIdx = 0;
        var i;
        if (isMulti) {
          var ps = ctx.room.players().slice(0, 6);
          for (i = 0; i < ps.length; i++) players.push(makePlayer(ps[i].id, ps[i].name || ('Spieler ' + (i + 1)), i, false));
          if (!players.length) players.push(makePlayer(ctx.me.id, ctx.me.name || 'Du', 0, false));
          for (i = 0; i < players.length; i++) if (players[i].id === ctx.me.id) meIdx = i;
        } else {
          players.push(makePlayer('me', (ctx.me && ctx.me.name) || 'Du', 0, false));
          for (i = 0; i < 3; i++) {
            var b = makePlayer('bot' + i, BOT_NAMES[i], i + 1, true);
            b.speedMul = diff.speed;
            players.push(b);
          }
          meIdx = 0;
        }
        var n = players.length;
        for (i = 0; i < n; i++) {
          var a = -Math.PI / 2 + i * 2 * Math.PI / n;
          var p = players[i];
          p.x = W / 2 + Math.cos(a) * SPAWN_R;
          p.y = H / 2 + Math.sin(a) * SPAWN_R;
          p.fx = -Math.cos(a); p.fy = -Math.sin(a);       // Blick zur Mitte
          p.tx = W / 2; p.ty = H / 2;
          netP.push(null);
        }
      }

      /* ================= Gitter ================= */
      function initGrid() {
        grid = new Array(N * N);
        var i;
        for (i = 0; i < N * N; i++) grid[i] = 0;
        gridCanvas = document.createElement('canvas');
        gridCanvas.width = W; gridCanvas.height = H;
        gctx = gridCanvas.getContext('2d');
        for (i = 0; i < N * N; i++) drawCell(i, 0);
        bloomC = document.createElement('canvas');
        bloomC.width = BLOOM; bloomC.height = BLOOM;
        bctx = bloomC.getContext('2d');
        bloomAt = 0;
        // Jeder startet auf einem kleinen eigenen Fleck
        for (i = 0; i < players.length; i++) stampBlob(players[i].x, players[i].y, players[i].ci + 1);
      }
      function stampBlob(x, y, v) {
        var c0 = Math.floor(x / CELL), r0 = Math.floor(y / CELL), r, c;
        for (r = r0 - 1; r <= r0 + 1; r++) {
          for (c = c0 - 1; c <= c0 + 1; c++) {
            if (r >= 0 && r < N && c >= 0 && c < N) setCell(r * N + c, v);
          }
        }
      }
      function setCell(i, v) { if (grid[i] === v) return; grid[i] = v; drawCell(i, v); }
      function cellAt(x, y) {
        var c = Math.floor(x / CELL), r = Math.floor(y / CELL);
        if (c < 0 || c >= N || r < 0 || r >= N) return 0;
        return grid[r * N + c];
      }
      function drawCell(i, v) {
        var c = i % N, r = (i - c) / N;
        var x = c * CELL, y = r * CELL;
        gctx.clearRect(x, y, CELL, CELL);
        if (v === 0) {
          gctx.fillStyle = ((r + c) % 2 === 0) ? '#06180e' : '#051309';
          gctx.fillRect(x, y, CELL, CELL);
          gctx.strokeStyle = 'rgba(57,255,20,0.09)';
          gctx.lineWidth = 1;
          gctx.strokeRect(x + 0.5, y + 0.5, CELL - 1, CELL - 1);
        } else {
          var col = COLORS[(v - 1) % COLORS.length];
          gctx.fillStyle = '#051309';
          gctx.fillRect(x, y, CELL, CELL);
          gctx.globalAlpha = 0.85; gctx.fillStyle = col;
          rr(gctx, x + 1.5, y + 1.5, CELL - 3, CELL - 3, 7); gctx.fill();
          gctx.globalAlpha = 0.20; gctx.fillStyle = '#ffffff';
          rr(gctx, x + 4.5, y + 4.5, CELL - 9, CELL - 9, 5); gctx.fill();
          gctx.globalAlpha = 1;
        }
      }
      /* Alle Kacheln färben, die der Klecks berührt (Kreis/Rechteck-Überlappung). */
      function paintAt(x, y, v) {
        var c0 = Math.floor((x - R) / CELL), c1 = Math.floor((x + R) / CELL);
        var r0 = Math.floor((y - R) / CELL), r1 = Math.floor((y + R) / CELL);
        if (c0 < 0) c0 = 0; if (r0 < 0) r0 = 0;
        if (c1 > N - 1) c1 = N - 1; if (r1 > N - 1) r1 = N - 1;
        for (var r = r0; r <= r1; r++) {
          for (var c = c0; c <= c1; c++) {
            var cx = c * CELL + CELL / 2, cy = r * CELL + CELL / 2;
            var ddx = Math.abs(x - cx) - CELL / 2, ddy = Math.abs(y - cy) - CELL / 2;
            if (ddx < 0) ddx = 0; if (ddy < 0) ddy = 0;
            if (ddx * ddx + ddy * ddy <= R * R) setCell(r * N + c, v);
          }
        }
      }
      function gridStr() {
        for (var i = 0; i < N * N; i++) tmpG[i] = grid[i];
        return tmpG.join('');
      }
      function countTiles() {
        var c = [], i;
        for (i = 0; i < players.length; i++) c.push(0);
        for (i = 0; i < N * N; i++) { var v = grid[i]; if (v > 0 && v <= c.length) c[v - 1]++; }
        return c;
      }

      /* ================= Bombe ================= */
      function spawnBomb(now) {
        nextBombAt += BOMB_EVERY;
        var best = null, tries, i;
        for (tries = 0; tries < 60; tries++) {
          var c = 2 + Math.floor(Math.random() * (N - 4)), r = 2 + Math.floor(Math.random() * (N - 4));
          var x = (c + 0.5) * CELL, y = (r + 0.5) * CELL, minD = 1e9;
          for (i = 0; i < players.length; i++) {
            var d = dist(players[i].x, players[i].y, x, y);
            if (d < minD) minD = d;
          }
          if (minD >= CELL * 3) { best = { x: x, y: y }; break; }
        }
        bomb = best || { x: W / 2, y: H / 2 };
        effects.push({ x: bomb.x, y: bomb.y, col: '#ffd23f', t: now });
        if (App.Audio) App.Audio.sfx('info');
      }
      function pickup(p, now) {
        if (!bomb || p.bomb) return;
        if (dist(p.x, p.y, bomb.x, bomb.y) > PICK_R + R) return;
        p.bomb = true; p.bombAt = 0; bomb = null;
        effects.push({ x: p.x, y: p.y, col: '#ffd23f', t: now });
        if (!isMulti && p !== players[meIdx] && App.Audio) App.Audio.sfx('pop');
      }
      function doThrow(p, now) {
        if (!p.bomb) return;
        p.bomb = false; p.bombAt = 0;
        var tx = p.x + p.fx * THROW_DIST, ty = p.y + p.fy * THROW_DIST;
        if (tx < CELL / 2) tx = CELL / 2; if (tx > W - CELL / 2) tx = W - CELL / 2;
        if (ty < CELL / 2) ty = CELL / 2; if (ty > H - CELL / 2) ty = H - CELL / 2;
        explode(tx, ty, p.ci + 1, now);
      }
      function explode(x, y, v, now) {
        var c0 = Math.floor(x / CELL), r0 = Math.floor(y / CELL), r, c;
        for (r = r0 - BOMB_R; r <= r0 + BOMB_R; r++) {
          for (c = c0 - BOMB_R; c <= c0 + BOMB_R; c++) {
            if (r >= 0 && r < N && c >= 0 && c < N) setCell(r * N + c, v);
          }
        }
        var col = COLORS[(v - 1) % COLORS.length];
        var ex = (c0 + 0.5) * CELL, ey = (r0 + 0.5) * CELL;
        effects.push({ x: ex, y: ey, col: col, t: now });
        lastExp = { x: Math.round(ex), y: Math.round(ey), ci: v - 1, t: now };
        if (App.Audio) App.Audio.sfx('explosion');
      }

      /* ================= Bot-KI ================= */
      /* Integralbild über den "Wert" jeder Kachel aus Sicht einer Farbe: alles, was
         mir nicht gehört, zählt 1 — eigenes 0. Damit findet boxSum() in O(1) die
         größte fremde Fläche. (Fremde Kacheln höher zu gewichten als leere klingt
         klug — bringt aber weniger Fläche, weil man auf fremder Farbe nur 0,7x so
         schnell fährt: gemessen 48 % statt 70 % Deckung. Also bewusst gleich.) */
      function buildIntegral(own) {
        var r, c, w1 = N + 1;
        for (c = 0; c <= N; c++) II[c] = 0;
        for (r = 0; r < N; r++) {
          II[(r + 1) * w1] = 0;
          var rowSum = 0;
          for (c = 0; c < N; c++) {
            rowSum += (grid[r * N + c] === own) ? 0 : 1;
            II[(r + 1) * w1 + (c + 1)] = II[r * w1 + (c + 1)] + rowSum;
          }
        }
      }
      function boxSum(x0, y0, x1, y1) {
        var w1 = N + 1;
        if (x0 < 0) x0 = 0; if (y0 < 0) y0 = 0;
        if (x1 > N - 1) x1 = N - 1; if (y1 > N - 1) y1 = N - 1;
        return II[(y1 + 1) * w1 + (x1 + 1)] - II[y0 * w1 + (x1 + 1)] - II[(y1 + 1) * w1 + x0] + II[y0 * w1 + x0];
      }
      function pickTarget(p, now) {
        buildIntegral(p.ci + 1);
        var best = -1, bx = W / 2, by = H / 2, r, c, i;
        for (r = 0; r < N; r++) {
          for (c = 0; c < N; c++) {
            // 7x7-Fenster: sucht wirklich die GROSSEN fremden Flächen, nicht den Fleck nebenan
            var s = boxSum(c - SCAN_R, r - SCAN_R, c + SCAN_R, r + SCAN_R);
            if (s <= 0) continue;
            var cx = (c + 0.5) * CELL, cy = (r + 0.5) * CELL;
            var d = dist(p.x, p.y, cx, cy) / CELL;
            if (d < MIN_TRIP) continue;          // keine Mini-Ziele -> kein Zappeln auf der Stelle
            var sc = s / (1 + d * DIST_W);
            // Nicht dorthin, wo schon ein anderer Bot hinfährt
            for (i = 0; i < players.length; i++) {
              var o = players[i];
              if (o === p || !o.bot) continue;
              if (dist(cx, cy, o.tx, o.ty) / CELL < 4) sc *= 0.55;
            }
            sc *= 1 + (Math.random() * 2 - 1) * diff.noise;
            if (sc > best) { best = sc; bx = cx; by = cy; }
          }
        }
        p.tx = bx; p.ty = by;
        p.retargetAt = now + diff.retarget;
      }
      function botThink(p, now) {
        // 1) Bombe holen, wenn sie in Reichweite liegt
        if (bomb && !p.bomb && dist(p.x, p.y, bomb.x, bomb.y) < diff.bombChase) {
          p.tx = bomb.x; p.ty = bomb.y;
          p.retargetAt = now + 300;
        } else if (now >= p.retargetAt || dist(p.x, p.y, p.tx, p.ty) < 20) {
          pickTarget(p, now);
        }
        // 2) Lenken
        var dx = p.tx - p.x, dy = p.ty - p.y, m = Math.sqrt(dx * dx + dy * dy);
        if (m > 1) { p.dx = dx / m; p.dy = dy / m; } else { p.dx = 0; p.dy = 0; }
        // 3) Bombe werfen, sobald das Ziel ungefähr auf Wurfweite vor mir liegt
        if (p.bomb) {
          if (!p.bombAt) p.bombAt = now + diff.bombDelay;
          if (now >= p.bombAt) {
            var d = dist(p.x, p.y, p.tx, p.ty);
            if ((d > 70 && d < 170) || now > p.bombAt + 3000) doThrow(p, now);
          }
        }
      }

      /* ================= Physik ================= */
      function stepPlayer(p, dt) {
        var dx = p.dx, dy = p.dy;
        var m = Math.sqrt(dx * dx + dy * dy);
        if (m > 1) { dx /= m; dy /= m; m = 1; }
        if (m > 0.05) { p.fx = dx / m; p.fy = dy / m; }
        var tile = cellAt(p.x, p.y);
        var mul = (tile === 0) ? MUL_EMPTY : (tile === p.ci + 1 ? MUL_OWN : MUL_FOREIGN);
        var sp = BASE_SPEED * mul * (p.speedMul || 1);
        var k = 1 - Math.exp(-dt * ACCEL);
        p.vx += (dx * sp - p.vx) * k;
        p.vy += (dy * sp - p.vy) * k;
        p.x += p.vx * dt; p.y += p.vy * dt;
        if (p.x < R) { p.x = R; p.vx = 0; }
        if (p.x > W - R) { p.x = W - R; p.vx = 0; }
        if (p.y < R) { p.y = R; p.vy = 0; }
        if (p.y > H - R) { p.y = H - R; p.vy = 0; }
        paintAt(p.x, p.y, p.ci + 1);
      }
      function simulate(now, dt) {
        var i;
        if (!isMulti) for (i = 0; i < players.length; i++) if (players[i].bot) botThink(players[i], now);
        var rest = dt;
        while (rest > 0) {
          var s = rest > 0.02 ? 0.02 : rest;
          rest -= s;
          for (i = 0; i < players.length; i++) stepPlayer(players[i], s);
        }
        if (now >= nextBombAt && now < endAt - 2000) spawnBomb(now);
        for (i = 0; i < players.length; i++) pickup(players[i], now);
      }

      /* ================= Netz ================= */
      function gatherInputs(myInp, now) {
        var ps = ctx.room.players(), map = {}, i;
        for (i = 0; i < ps.length; i++) map[ps[i].id] = ps[i];
        for (i = 0; i < players.length; i++) {
          var p = players[i];
          if (i === meIdx) {
            p.dx = myInp.x; p.dy = myInp.y;
            if (throwSeq > p.tq) { p.tq = throwSeq; doThrow(p, now); }
            continue;
          }
          var rp = map[p.id], s = rp && rp.state;
          if (s && typeof s.ix === 'number' && typeof s.iy === 'number') { p.dx = s.ix; p.dy = s.iy; }
          else { p.dx = 0; p.dy = 0; }
          if (s && typeof s.tq === 'number' && s.tq > p.tq) { p.tq = s.tq; doThrow(p, now); }
        }
      }
      function broadcast(now, over) {
        var pos = [], bstr = '', i;
        for (i = 0; i < players.length; i++) {
          pos.push(Math.round(players[i].x));
          pos.push(Math.round(players[i].y));
          bstr += players[i].bomb ? '1' : '0';
        }
        var d = {
          g: gridStr(), x: pos, b: bstr,
          bx: bomb ? Math.round(bomb.x) : -1, by: bomb ? Math.round(bomb.y) : -1,
          t: now, o: !!over
        };
        if (lastExp) { d.ex = lastExp.x; d.ey = lastExp.y; d.ec = lastExp.ci; d.et = lastExp.t; }
        try { ctx.room.setShared({ pw: d }); } catch (e) {}
      }
      /* Idempotent: darf beliebig oft mit demselben Zustand kommen (Heartbeat!). */
      function applyShared(sh) {
        if (dead || !grid || !sh || !sh.pw) return;
        if (isMulti && ctx.room.isHost()) return;        // Host ist selbst die Quelle
        var d = sh.pw, i;
        if (typeof d.g === 'string' && d.g.length === N * N) {
          for (i = 0; i < N * N; i++) {
            var v = d.g.charCodeAt(i) - 48;
            if (v >= 0 && v <= 9) setCell(i, v);
          }
        }
        if (d.x && d.x.length) {
          for (i = 0; i < players.length; i++) {
            var px = d.x[i * 2], py = d.x[i * 2 + 1];
            if (typeof px === 'number' && typeof py === 'number') netP[i] = { x: px, y: py };
          }
        }
        if (typeof d.b === 'string') {
          for (i = 0; i < players.length; i++) players[i].bomb = d.b.charAt(i) === '1';
        }
        bomb = (typeof d.bx === 'number' && d.bx >= 0) ? { x: d.bx, y: d.by } : null;
        if (typeof d.et === 'number' && d.et > lastExpT) {
          if (!firstApply) {
            effects.push({ x: d.ex, y: d.ey, col: COLORS[(d.ec || 0) % COLORS.length], t: nowFn() });
            if (App.Audio) App.Audio.sfx('explosion');
          }
          lastExpT = d.et;
        }
        firstApply = false;
      }
      /* Gast: eigene Figur lokal vorhersagen, fremde weich interpolieren. */
      function clientStep(inp, now, dt) {
        var me = players[meIdx], i;
        me.dx = inp.x; me.dy = inp.y;
        var rest = dt;
        while (rest > 0) { var s = rest > 0.02 ? 0.02 : rest; rest -= s; stepPlayer(me, s); }
        var t = netP[meIdx];
        if (t) {
          var ddx = t.x - me.x, ddy = t.y - me.y, d = Math.sqrt(ddx * ddx + ddy * ddy);
          if (d > 80) { me.x = t.x; me.y = t.y; me.vx = 0; me.vy = 0; }
          else { var kc = 1 - Math.exp(-dt * 3.2); me.x += ddx * kc; me.y += ddy * kc; }
        }
        var k2 = 1 - Math.exp(-dt * 13);
        for (i = 0; i < players.length; i++) {
          if (i === meIdx) continue;
          var p = players[i], q = netP[i];
          if (!q) continue;
          var odx = q.x - p.x, ody = q.y - p.y;
          var od = Math.sqrt(odx * odx + ody * ody);
          if (od > 140) { p.x = q.x; p.y = q.y; }
          else { p.x += odx * k2; p.y += ody * k2; }
          if (od > 1) { p.fx = odx / od; p.fy = ody / od; }
          paintAt(p.x, p.y, p.ci + 1);
        }
      }

      /* ================= Frame-Schleife ================= */
      function frame() {
        if (dead || finished) { raf = null; return; }
        var now = nowFn();
        var dt = (now - last) / 1000;
        if (dt < 0) dt = 0; if (dt > 0.05) dt = 0.05;
        last = now;

        if (now < startAt) { draw(now); raf = requestAnimationFrame(frame); return; }

        var amHost = isMulti ? !!ctx.room.isHost() : true;
        var inp = readInput();
        var me = players[meIdx];

        if (isMulti && now - lastReport >= REPORT_MS) {
          lastReport = now;
          try { ctx.room.reportState({ ix: rnd3(inp.x), iy: rnd3(inp.y), tq: throwSeq }); } catch (e) {}
        }

        if (amHost) {
          if (isMulti) {
            gatherInputs(inp, now);
          } else {
            me.dx = inp.x; me.dy = inp.y;
            if (throwSeq > me.tq) { me.tq = throwSeq; doThrow(me, now); }
          }
          simulate(now, dt);
          if (isMulti && now - lastBroadcast >= BROADCAST_MS) { lastBroadcast = now; broadcast(now, false); }
        } else {
          clientStep(inp, now, dt);
        }

        syncBombUI();

        if (now - lastCount >= COUNT_MS) {
          lastCount = now;
          var counts = countTiles();
          updateBars(counts);
          if (isMulti && now - lastScoreReport >= SCORE_MS) {
            lastScoreReport = now;
            try { ctx.room.reportScore(counts[me.ci] || 0); } catch (e) {}
          }
        }

        draw(now);
        raf = requestAnimationFrame(frame);
      }

      /* ================= Eingabe ================= */
      function readInput() {
        var x, y;
        if (joy.on && (joy.x !== 0 || joy.y !== 0)) { x = joy.x; y = joy.y; }
        else {
          x = (keys.r ? 1 : 0) - (keys.l ? 1 : 0);
          y = (keys.d ? 1 : 0) - (keys.u ? 1 : 0);
        }
        var m = Math.sqrt(x * x + y * y);
        if (m > 1) { x /= m; y /= m; }
        return { x: x, y: y };
      }
      function tryThrow() {
        if (dead || finished || !players.length) return;
        var me = players[meIdx];
        if (!me || !me.bomb) { if (App.Audio) App.Audio.sfx('error'); return; }
        throwSeq++;
        if (App.Audio) App.Audio.sfx('whoosh');
        if (isMulti && !ctx.room.isHost()) {
          me.bomb = false;                                  // sofortige Rückmeldung, Host bestätigt
          var inp = readInput();
          lastReport = nowFn();
          try { ctx.room.reportState({ ix: rnd3(inp.x), iy: rnd3(inp.y), tq: throwSeq }); } catch (e) {}
        }
        syncBombUI();
      }
      function attachInput() {
        keys.u = keys.d = keys.l = keys.r = false;
        joy.on = false; joy.x = 0; joy.y = 0; joy.id = -1;
        var down = function (e) {
          var k = e.key;
          if (k === 'ArrowUp' || k === 'w' || k === 'W') { keys.u = true; e.preventDefault(); }
          else if (k === 'ArrowDown' || k === 's' || k === 'S') { keys.d = true; e.preventDefault(); }
          else if (k === 'ArrowLeft' || k === 'a' || k === 'A') { keys.l = true; e.preventDefault(); }
          else if (k === 'ArrowRight' || k === 'd' || k === 'D') { keys.r = true; e.preventDefault(); }
          else if (k === ' ' || k === 'Spacebar' || e.code === 'Space' || k === 'Enter') {
            e.preventDefault();
            if (!e.repeat) tryThrow();
          }
        };
        var up = function (e) {
          var k = e.key;
          if (k === 'ArrowUp' || k === 'w' || k === 'W') keys.u = false;
          else if (k === 'ArrowDown' || k === 's' || k === 'S') keys.d = false;
          else if (k === 'ArrowLeft' || k === 'a' || k === 'A') keys.l = false;
          else if (k === 'ArrowRight' || k === 'd' || k === 'D') keys.r = false;
        };
        var blur = function () { keys.u = keys.d = keys.l = keys.r = false; };
        addL(document, 'keydown', down);
        addL(document, 'keyup', up);
        addL(window, 'blur', blur);
      }
      function bindStick(base, knob) {
        var RAD = 42, SIZE = 116;
        function set(e) {
          var r = base.getBoundingClientRect();
          var sc = (r.width / SIZE) || 1;
          var dx = (e.clientX - (r.left + r.width / 2)) / sc;
          var dy = (e.clientY - (r.top + r.height / 2)) / sc;
          var m = Math.sqrt(dx * dx + dy * dy);
          if (m > RAD) { dx = dx / m * RAD; dy = dy / m * RAD; }
          joy.x = dx / RAD; joy.y = dy / RAD;
          knob.style.transform = 'translate(' + (dx * sc).toFixed(1) + 'px,' + (dy * sc).toFixed(1) + 'px)';
        }
        function end() {
          joy.on = false; joy.x = 0; joy.y = 0; joy.id = -1;
          knob.style.transform = 'translate(0px,0px)';
          base.classList.remove('is-on');
        }
        addL(base, 'pointerdown', function (e) {
          e.preventDefault(); joy.on = true; joy.id = e.pointerId;
          base.classList.add('is-on');
          try { base.setPointerCapture(e.pointerId); } catch (er) {}
          set(e);
        });
        addL(base, 'pointermove', function (e) { if (joy.on && e.pointerId === joy.id) { e.preventDefault(); set(e); } });
        addL(base, 'pointerup', function (e) { if (e.pointerId === joy.id) { e.preventDefault(); end(); } });
        addL(base, 'pointercancel', function () { end(); });
        addL(base, 'lostpointercapture', function () { end(); });
      }

      /* ================= Ansicht ================= */
      function buildStage() {
        var timerEl = el('div', { class: 'mg-timer pwr-timer' }, [App.MG.mmss(DURATION)]);
        var myPctEl = el('div', { class: 'pwr-mypct' }, ['0,0 %']);
        var head = el('div', { class: 'pwr-head glass' }, [
          el('div', { class: 'pwr-head-cell' }, [el('span', { class: 'pwr-head-l' }, ['Dein Anteil']), myPctEl]),
          el('div', { class: 'pwr-head-cell pwr-head-r' }, [el('span', { class: 'pwr-head-l' }, ['Zeit']), timerEl])
        ]);

        var barsWrap = el('div', { class: 'pwr-bars glass' });
        var bars = [];
        players.forEach(function (p, i) {
          var col = COLORS[p.ci];
          var fill = el('div', { class: 'pwr-bar-fill' });
          fill.style.background = col;
          fill.style.boxShadow = '0 0 10px ' + col;
          var dot = el('span', { class: 'pwr-dot' });
          dot.style.background = col;
          dot.style.boxShadow = '0 0 8px ' + col;
          var numEl = el('div', { class: 'pwr-bar-num' }, ['0']);
          var pctEl = el('div', { class: 'pwr-bar-pct' }, ['0,0 %']);
          var row = el('div', { class: 'pwr-bar' + (i === meIdx ? ' is-me' : '') }, [
            el('div', { class: 'pwr-bar-head' }, [
              dot,
              el('div', { class: 'pwr-bar-name' }, [p.name + (i === meIdx ? ' (du)' : '') + (p.bot ? ' 🤖' : '')]),
              numEl, pctEl
            ]),
            el('div', { class: 'pwr-bar-track' }, [fill])
          ]);
          barsWrap.appendChild(row);
          bars.push({ row: row, fill: fill, numEl: numEl, pctEl: pctEl, lastC: -1 });
        });

        var canvas = el('canvas', { class: 'pwr-canvas', width: W, height: H });
        var overlay = el('div', { class: 'pwr-over' });
        var stage = el('div', { class: 'pwr-stage' }, [canvas, overlay]);

        var bombBtn = el('button', {
          class: 'btn btn-ghost pwr-bomb', type: 'button', disabled: true,
          onclick: function () { tryThrow(); }
        }, ['💣 keine Bombe']);

        var padKids = [], stick = null, knob = null;
        if (TOUCH) {
          knob = el('div', { class: 'pwr-knob' });
          stick = el('div', { class: 'pwr-stick' }, [el('div', { class: 'pwr-stick-ring' }), knob]);
          padKids.push(stick);
        }
        padKids.push(bombBtn);
        var pad = el('div', { class: 'pwr-pad' + (TOUCH ? ' is-touch' : '') }, padKids);

        var hint = el('p', { class: 'hint-text pwr-hint' }, [
          TOUCH
            ? 'Joystick = fahren · 💣 = Farbbombe werfen (5×5) · auf eigener Farbe 40 % schneller, auf fremder langsam · alle 15 s neue Bombe · 90 s'
            : 'WASD / Pfeile = fahren · LEERTASTE = 💣 Farbbombe werfen (5×5) · auf eigener Farbe 40 % schneller, auf fremder langsam · alle 15 s neue Bombe · 90 s'
        ]);

        root.innerHTML = '';
        root.appendChild(el('div', { class: 'pwr-wrap' }, [head, barsWrap, stage, pad, hint]));
        ctx2d = canvas.getContext('2d');
        refs = { canvas: canvas, timer: timerEl, myPct: myPctEl, bars: bars, bombBtn: bombBtn, overlay: overlay };
        if (TOUCH && stick) bindStick(stick, knob);
      }

      function updateBars(counts) {
        if (!refs) return;
        var total = N * N, i, lead = -1, leadC = 0;
        for (i = 0; i < counts.length; i++) if (counts[i] > leadC) { leadC = counts[i]; lead = i; }
        for (i = 0; i < refs.bars.length; i++) {
          var b = refs.bars[i], c = counts[i] || 0;
          if (b.lastC !== c) {
            b.lastC = c;
            b.fill.style.width = (c / total * 100).toFixed(1) + '%';
            b.numEl.textContent = String(c);
            b.pctEl.textContent = (c / total * 100).toFixed(1).replace('.', ',') + ' %';
          }
          b.row.classList.toggle('is-lead', i === lead && leadC > 0);
        }
        var mine = counts[meIdx] || 0;
        refs.myPct.textContent = (mine / total * 100).toFixed(1).replace('.', ',') + ' %';
        if (lead !== lastLeader) {
          if (lead === meIdx && lastLeader >= 0 && App.Audio) App.Audio.sfx('ding');
          lastLeader = lead;
        }
      }
      function syncBombUI() {
        if (!refs || !players.length) return;
        var me = players[meIdx];
        if (!me) return;
        var has = !!me.bomb;
        if (has === myHadBomb) return;
        if (has && App.Audio) App.Audio.sfx('powerup');
        myHadBomb = has;
        refs.bombBtn.disabled = !has;
        refs.bombBtn.className = 'btn pwr-bomb ' + (has ? 'btn-primary is-ready' : 'btn-ghost');
        refs.bombBtn.textContent = has ? '💣 Bombe werfen' : '💣 keine Bombe';
      }
      function tickTimer(left) {
        if (!refs) return;
        refs.timer.textContent = App.MG.mmss(left);
        if (left <= 10) refs.timer.classList.add('pwr-urgent');
        var s = Math.ceil(left);
        if (s !== lastSec) {
          lastSec = s;
          if (s > 0 && s <= 5 && App.Audio) App.Audio.sfx('tick');
        }
      }

      /* ================= Zeichnen ================= */
      function draw(now) {
        var g = ctx2d;
        if (!g || !gridCanvas) return;
        g.clearRect(0, 0, W, H);
        g.fillStyle = '#03100a';
        g.fillRect(0, 0, W, H);
        g.drawImage(gridCanvas, 0, 0);

        // Neon-Schimmer: Gitter klein rendern und weich wieder groß draufaddieren
        if (bctx && now - bloomAt > 60) {
          bloomAt = now;
          bctx.clearRect(0, 0, BLOOM, BLOOM);
          bctx.drawImage(gridCanvas, 0, 0, BLOOM, BLOOM);
        }
        if (bloomC) {
          g.save();
          g.globalCompositeOperation = 'lighter';
          g.globalAlpha = 0.32;
          g.drawImage(bloomC, 0, 0, W, H);
          g.restore();
        }

        // Feldrahmen
        g.save();
        g.strokeStyle = 'rgba(57,255,20,0.25)';
        g.lineWidth = 4;
        rr(g, 4, 4, W - 8, H - 8, 16);
        g.stroke();
        g.restore();

        // Bombe auf dem Feld
        if (bomb) {
          var pulse = 1 + Math.sin(now / 160) * 0.12;
          g.save();
          g.translate(bomb.x, bomb.y);
          g.scale(pulse, pulse);
          g.shadowColor = 'rgba(255,210,63,.9)';
          g.shadowBlur = 22;
          g.fillStyle = 'rgba(255,210,63,.18)';
          g.beginPath(); g.arc(0, 0, 17, 0, Math.PI * 2); g.fill();
          g.strokeStyle = '#ffd23f'; g.lineWidth = 2.5;
          g.beginPath(); g.arc(0, 0, 17, 0, Math.PI * 2); g.stroke();
          g.shadowBlur = 0;
          g.font = '900 19px ' + FONT;
          g.textAlign = 'center'; g.textBaseline = 'middle';
          g.fillText('💣', 0, 1);
          g.restore();
        }

        // Explosions-/Aufsammel-Ringe (Wall-Clock)
        var keep = [];
        for (var i = 0; i < effects.length; i++) {
          var e = effects[i], k = (now - e.t) / FX_MS;
          if (k < 0) k = 0;
          if (k >= 1) continue;
          keep.push(e);
          g.save();
          g.globalAlpha = (1 - k) * 0.85;
          g.strokeStyle = e.col;
          g.shadowColor = e.col;
          g.shadowBlur = 24;
          g.lineWidth = 8 * (1 - k) + 1.5;
          g.beginPath(); g.arc(e.x, e.y, 12 + k * 88, 0, Math.PI * 2); g.stroke();
          g.globalAlpha = (1 - k) * 0.45;
          g.lineWidth = 3;
          g.beginPath(); g.arc(e.x, e.y, 6 + k * 46, 0, Math.PI * 2); g.stroke();
          g.restore();
        }
        effects = keep;

        // Spieler
        for (i = 0; i < players.length; i++) drawPlayer(g, players[i], i === meIdx, now);
      }
      function drawPlayer(g, p, isMe, now) {
        var col = COLORS[p.ci];
        g.save();
        // Blickrichtung als kurzer Pinselstrich
        g.globalAlpha = 0.65;
        g.strokeStyle = col; g.lineWidth = 3.5; g.lineCap = 'round';
        g.beginPath(); g.moveTo(p.x, p.y); g.lineTo(p.x + p.fx * (R + 8), p.y + p.fy * (R + 8)); g.stroke();
        g.globalAlpha = 1;
        // Klecks
        g.shadowColor = col; g.shadowBlur = 18;
        g.fillStyle = col;
        g.beginPath(); g.arc(p.x, p.y, R, 0, Math.PI * 2); g.fill();
        g.shadowBlur = 0;
        g.globalAlpha = 0.5; g.fillStyle = '#ffffff';
        g.beginPath(); g.arc(p.x - 3, p.y - 3.5, R * 0.4, 0, Math.PI * 2); g.fill();
        g.globalAlpha = 1;
        if (isMe) {
          var k = 0.5 + 0.5 * Math.sin(now / 220);
          g.strokeStyle = 'rgba(255,255,255,' + (0.35 + 0.4 * k).toFixed(2) + ')';
          g.lineWidth = 2.5;
          g.beginPath(); g.arc(p.x, p.y, R + 4 + k * 2, 0, Math.PI * 2); g.stroke();
        }
        g.textAlign = 'center';
        if (p.bomb) {
          g.font = '15px ' + FONT;
          g.textBaseline = 'middle';
          g.fillText('💣', p.x, p.y - R - 11);
        }
        g.font = '900 11px ' + FONT;
        g.textBaseline = 'alphabetic';
        g.globalAlpha = 0.92;
        g.fillStyle = col;
        g.shadowColor = 'rgba(0,0,0,.95)';
        g.shadowBlur = 4;
        g.fillText(shortName(p.name), p.x, p.y - R - (p.bomb ? 22 : 8));
        g.restore();
      }

      /* ================= Ende ================= */
      function finish() {
        if (finished || dead) return;
        finished = true;
        if (raf) { cancelAnimationFrame(raf); raf = null; }
        clearPending();

        var amHost = isMulti ? !!ctx.room.isHost() : true;
        if (isMulti && amHost) broadcast(nowFn(), true);   // letzter, verbindlicher Zustand

        var counts = countTiles();
        updateBars(counts);
        var myScore = counts[meIdx] || 0;
        var total = N * N;
        var rank = 1, i;
        for (i = 0; i < counts.length; i++) if (i !== meIdx && counts[i] > myScore) rank++;

        if (refs) {
          refs.overlay.innerHTML = '';
          refs.overlay.appendChild(el('div', { class: 'pwr-over-t' }, ['Zeit um!']));
          refs.overlay.appendChild(el('div', { class: 'pwr-over-s' }, [
            myScore + ' Kacheln · ' + (myScore / total * 100).toFixed(1).replace('.', ',') + ' % · Platz ' + rank + ' von ' + players.length
          ]));
          refs.overlay.className = 'pwr-over is-on';
        }
        if (App.Audio) App.Audio.sfx(rank === 1 ? 'win' : 'lose');

        stopHelpers(); removeAllL();

        if (isMulti) {
          try { ctx.room.reportScore(myScore); } catch (e) {}
          after(1500, function () {
            App.MG.endScreen(root, { players: ctx.room.players(), meId: ctx.me.id, onExit: ctx.onExit });
          });
        } else {
          var best = App.Storage.get('best_paintwar', 0);
          var nb = myScore > best;
          if (nb) App.Storage.set('best_paintwar', myScore);
          after(1500, function () {
            App.MG.endScreen(root, {
              score: myScore, best: best, newBest: nb,
              label: 'Kacheln gefärbt · Platz ' + rank + ' von ' + players.length +
                (nb ? ' · neuer Rekord! 🎉' : ' · Bestwert: ' + App.MG.fmt(best)),
              onExit: ctx.onExit,
              onAgain: function () { startSolo(); }
            });
          });
        }
      }

      /* ================= Kleinkram ================= */
      function dist(x1, y1, x2, y2) { var a = x1 - x2, b = y1 - y2; return Math.sqrt(a * a + b * b); }
      function rnd3(v) { return Math.round(v * 1000) / 1000; }
      function shortName(n) {
        n = String(n || '');
        return n.length > 9 ? n.slice(0, 8) + '…' : n;
      }
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
    }
  };

  /* ============================ STYLES ============================ */
  function injectStyle() {
    UI.injectStyle('mg-paintwar-css', [
      '.pwr-wrap{display:flex;flex-direction:column;gap:10px;}',
      /* Kopf */
      '.pwr-head{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:10px 16px;}',
      '.pwr-head-cell{display:flex;flex-direction:column;gap:2px;min-width:0;}',
      '.pwr-head-r{text-align:right;}',
      '.pwr-head-l{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:1px;}',
      '.pwr-mypct{font-size:clamp(22px,5.5vw,34px);font-weight:900;line-height:1;color:var(--neon);',
      'text-shadow:0 0 14px rgba(57,255,20,.5);font-variant-numeric:tabular-nums;}',
      '.pwr-timer{font-size:clamp(20px,5vw,30px);}',
      '.pwr-timer.pwr-urgent{color:var(--danger-2);animation:pwr-pulse .7s infinite;}',
      /* Prozentbalken */
      '.pwr-bars{display:flex;flex-direction:column;gap:7px;padding:10px 14px;}',
      '.pwr-bar{display:flex;flex-direction:column;gap:3px;}',
      '.pwr-bar-head{display:flex;align-items:center;gap:7px;font-size:12px;font-weight:800;}',
      '.pwr-dot{width:10px;height:10px;border-radius:50%;flex:none;}',
      '.pwr-bar-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--silver);}',
      '.pwr-bar.is-me .pwr-bar-name{color:#fff;}',
      '.pwr-bar-num{color:var(--muted);font-variant-numeric:tabular-nums;}',
      '.pwr-bar-pct{min-width:54px;text-align:right;color:var(--leaf);font-variant-numeric:tabular-nums;}',
      '.pwr-bar-track{height:9px;border-radius:6px;background:rgba(4,20,12,.85);border:1px solid var(--stroke);overflow:hidden;}',
      '.pwr-bar-fill{height:100%;width:0%;border-radius:6px;transition:width .18s linear;}',
      '.pwr-bar.is-lead .pwr-bar-track{border-color:var(--gold);box-shadow:0 0 10px rgba(255,210,63,.35);}',
      /* Spielfeld */
      '.pwr-stage{position:relative;width:100%;max-width:560px;margin:0 auto;aspect-ratio:1 / 1;}',
      '.pwr-canvas{display:block;width:100%;height:100%;border-radius:16px;border:2px solid rgba(57,255,20,.35);',
      'background:#03100a;box-shadow:0 0 42px rgba(57,255,20,.2),inset 0 0 60px rgba(57,255,20,.06);',
      'touch-action:none;user-select:none;-webkit-user-select:none;-webkit-tap-highlight-color:transparent;}',
      '.pwr-over{position:absolute;inset:0;display:none;flex-direction:column;align-items:center;justify-content:center;',
      'gap:6px;padding:18px;text-align:center;border-radius:16px;background:rgba(3,14,9,.74);}',
      '.pwr-over.is-on{display:flex;animation:pwr-fade .3s ease both;}',
      '.pwr-over-t{font-size:clamp(24px,6vw,40px);font-weight:900;color:var(--neon);text-shadow:0 0 18px rgba(57,255,20,.6);}',
      '.pwr-over-s{color:var(--leaf);font-weight:800;}',
      /* Steuerung */
      '.pwr-pad{display:flex;align-items:center;justify-content:center;gap:16px;}',
      '.pwr-pad.is-touch{justify-content:space-between;padding:0 6px;}',
      '.pwr-stick{position:relative;width:116px;height:116px;border-radius:50%;flex:none;touch-action:none;',
      'background:radial-gradient(circle,rgba(9,32,21,.9),rgba(4,16,10,.9));border:1px solid var(--stroke);}',
      '.pwr-stick.is-on{border-color:var(--neon);box-shadow:0 0 20px rgba(57,255,20,.35),inset 0 0 26px rgba(57,255,20,.18);}',
      '.pwr-stick-ring{position:absolute;inset:14px;border-radius:50%;border:1px dashed rgba(157,255,122,.25);}',
      '.pwr-knob{position:absolute;left:50%;top:50%;width:44px;height:44px;margin:-22px 0 0 -22px;border-radius:50%;',
      'background:linear-gradient(180deg,var(--neon-soft),var(--neon));box-shadow:0 0 16px rgba(57,255,20,.6);}',
      '.pwr-bomb{min-width:158px;}',
      '.pwr-bomb.is-ready{animation:pwr-bomb-pulse 1s ease-in-out infinite;}',
      '.pwr-bomb:disabled{opacity:.45;cursor:default;}',
      '.pwr-hint{text-align:center;}',
      /* Schwierigkeits-Wahl (Solo) */
      '.pwr-diffbox{padding:28px 22px;text-align:center;display:flex;flex-direction:column;gap:12px;',
      'align-items:center;max-width:520px;margin:0 auto;}',
      '.pwr-diff-hero{font-size:54px;line-height:1;filter:drop-shadow(0 0 16px rgba(57,255,20,.5));animation:pwr-bob 1.8s ease-in-out infinite;}',
      '.pwr-diff-row{display:flex;gap:10px;flex-wrap:wrap;justify-content:center;}',
      '.pwr-diff-btn{display:flex;flex-direction:column;gap:2px;padding:12px 16px;min-width:118px;}',
      '.pwr-diff-ico{font-size:24px;line-height:1;}',
      '.pwr-diff-t{font-weight:900;color:var(--leaf);}',
      '.pwr-diff-s{font-size:11px;color:var(--muted);}',
      /* Animationen */
      '@keyframes pwr-pulse{0%,100%{opacity:1}50%{opacity:.4}}',
      '@keyframes pwr-fade{from{opacity:0}to{opacity:1}}',
      '@keyframes pwr-bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-7px)}}',
      '@keyframes pwr-bomb-pulse{0%,100%{box-shadow:0 0 12px rgba(255,210,63,.45);}50%{box-shadow:0 0 26px rgba(255,210,63,.9);}}'
    ].join(''));
  }
})();
