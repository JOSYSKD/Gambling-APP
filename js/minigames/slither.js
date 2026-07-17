/* slither.js — "Neon-Schlange.io": Slither.io im Neon-Dschungel.
 *
 * IDEE: In einer grossen Arena steuerst du eine leuchtende Schlange. Die Kamera
 *   folgt deinem Kopf. Friss Leucht-Punkte -> du wirst laenger (= mehr Punkte).
 *   Faehrt DEIN Kopf in einen fremden Koerper, stirbst du und zerfaellst in
 *   Futter. Ziel: die laengste Schlange werden, Gegner einkreisen und schneiden.
 *
 * STEUERUNG:
 *   - Maus bewegen ODER Finger auf der Flaeche ziehen  -> Schlange lenkt dorthin.
 *   - Maustaste halten / Leertaste / TURBO-Knopf       -> Boost (schneller, kostet Laenge).
 *   - Pfeile / A D lenken, Leertaste boostet (Tastatur-Alternative).
 *
 * PUNKTE: Laenge der Schlange (Bestwert = groesste je erreichte Laenge der Runde).
 *   Runde dauert 2 Minuten ODER endet, sobald nur noch eine Schlange lebt.
 *
 * SYNC-MODELL (Multiplayer, rein Peer-basiert, keine Host-Autoritaet):
 *   Jeder simuliert NUR seine eigene Schlange und meldet ~12x/s per reportState
 *   { b: kompakte Koerperpunkte, a: Winkel, r: Radius, l: Laenge, d: tot?, dc: Todeszaehler }.
 *   Jeder liest die Zustaende der anderen aus room.players() und prueft die EIGENE
 *   Kollision gegen die empfangenen Koerper -> wer reinfaehrt, toetet sich selbst.
 *   Kopf-an-Kopf: die kuerzere Schlange stirbt (jeder Client entscheidet fair fuer sich).
 *   Beim Sterben wird ein Todeszaehler erhoeht -> jeder andere spawnt daraus lokal Futter.
 *   Alle Runden-Timer laufen ueber room.now() (synchron, Tab-sicher).
 *
 * SOLO: du gegen mehrere Bots mit echter KI (Futter suchen, Waenden/Koerpern
 *   ausweichen, dir manchmal den Weg abschneiden). Letzte lebende Schlange gewinnt.
 */
(function () {
  'use strict';
  window.App = window.App || {}; App.Minigames = App.Minigames || {};
  var UI = App.UI, el = UI.el;

  /* ---------------- Tuning / Weltmasse ---------------- */
  var WORLD = 2600;          // quadratische Arena (Weltkoordinaten)
  var CW = 880, CH = 620;    // virtuelle Canvas-Aufloesung (CSS skaliert)
  var PATH_STEP = 5;         // px zwischen gespeicherten Pfadpunkten
  var MAXPATH = 1400;        // max. gespeicherte Pfadpunkte pro Schlange
  var BASE_R = 9;            // Koerperradius bei Laenge 0
  var MAX_R = 26;            // maximaler Koerperradius
  var BASE_SPEED = 138;      // px/s normal
  var BOOST_SPEED = 258;     // px/s im Boost
  var TURN_RATE = 4.7;       // rad/s maximale Drehrate
  var START_LEN = 14;        // Start-Laenge
  var BOOST_MIN_LEN = 12;    // ab hier ist kein Boost mehr moeglich
  var BOOST_DRAIN = 7.5;     // Laenge/s Verbrauch im Boost
  var ROUND_SEC = 120;       // Rundenlaenge (2 Minuten)
  var NET_MS = 80;           // reportState-Intervall (~12,5x/s)
  var SCORE_MS = 500;        // reportScore-Intervall
  var NET_BODY_PTS = 18;     // Koerperpunkte pro Netz-Paket
  var AMBIENT_FOOD = 300;    // Grund-Futter in der Arena
  var SPAWN_R = 760;         // Spawn-Ring-Radius um die Mitte
  var MAXP = 190;            // max. Partikel

  /* Neon-Dschungel-Farben je Schlange (Index 0 = du). */
  var COLORS = [
    { body: '#39ff14', glow: 'rgba(57,255,20,',   eye: '#eafff0' },
    { body: '#33e6d0', glow: 'rgba(51,230,208,',  eye: '#eafffb' },
    { body: '#ffd23f', glow: 'rgba(255,210,63,',  eye: '#fff6d6' },
    { body: '#ff4d6d', glow: 'rgba(255,77,109,',  eye: '#ffe1e7' },
    { body: '#b26bff', glow: 'rgba(178,107,255,', eye: '#f1e6ff' },
    { body: '#ff9f43', glow: 'rgba(255,159,67,',  eye: '#ffeede' }
  ];
  var BOT_NAMES = ['Kobra', 'Viper', 'Mamba', 'Natter', 'Boa', 'Python', 'Anakonda'];
  var FOOD_COLS = ['#8dff6b', '#39ff14', '#33e6d0', '#7ff3e6', '#ffd23f'];

  injectStyle();

  App.Minigames.slither = {
    id: 'slither', title: 'Neon-Schlange.io', icon: '🐍', order: 145,
    subtitle: 'Wachse, kreise Gegner ein, werde die Laengste',
    single: true, multi: true, minPlayers: 2, maxPlayers: 6,

    render: function (root, ctx) {
      var isMulti = ctx.mode === 'multi';
      var meId = ctx.me.id;
      var nowFn = isMulti ? ctx.room.now : function () { return Date.now(); };
      var perf = (window.performance && performance.now)
        ? function () { return performance.now(); } : function () { return Date.now(); };

      /* ---- Laufzeit ---- */
      var dead = false;              // Komponente entfernt -> nichts mehr tun
      var ended = false;             // Runde beendet (Endscreen)
      var raf = null, lastT = 0;
      var stops = [];                // stop()-Funktionen (App.MG-Bausteine)
      var listeners = [];            // {t,ty,fn,opts}

      var me = null;                 // meine Schlange
      var meDead = false;
      var bots = [];                 // Solo-Gegner
      var enemies = {};              // Multi-Gegner (id -> obj)
      var food = [];                 // Futter (ambient + Todes-Futter)
      var parts = [];                // Partikel
      var g = null, canvasEl = null;
      var startAt = 0, endAt = 0;
      var spectId = null;            // im Spectator-Modus verfolgte Schlange (multi)

      /* Kamera / Zoom (pro Frame gesetzt) */
      var camX = WORLD / 2, camY = WORLD / 2, ZOOM = 0.72;

      /* Eingabe */
      var aim = { x: CW / 2, y: CH * 0.18 }, aiming = false, steerPid = null;
      var mouseBoost = false, keyBoost = false, btnBoost = false;
      var turnL = false, turnR = false;

      /* Throttle-Akkus */
      var netAcc = 0, scoreAcc = 0, hudAcc = 0, boardAcc = 0, eatSndAt = 0;

      /* DOM-Referenzen */
      var lenEl, timeEl, rankEl, boardEl, bannerEl, boostBtn;

      /* ---- Helfer: Aufraeumen ---- */
      function addL(t, ty, fn, opts) { t.addEventListener(ty, fn, opts); listeners.push({ t: t, ty: ty, fn: fn, opts: opts }); }
      function stopAll() { stops.forEach(function (f) { try { f(); } catch (e) {} }); stops = []; }
      function cleanup() {
        dead = true; ended = true;
        if (raf) { cancelAnimationFrame(raf); raf = null; }
        stopAll();
        listeners.forEach(function (l) { try { l.t.removeEventListener(l.ty, l.fn, l.opts); } catch (e) {} });
        listeners = [];
      }

      /* ================= START ================= */
      startGame();
      return { cleanup: cleanup };

      function startGame() {
        ended = false; meDead = false; spectId = null;
        if (isMulti) {
          var snap = ctx.room.snapshot() || {};
          startAt = (snap.round && snap.round.startAt) || (ctx.room.now() + 3000);
          stops.push(App.MG.countdown(root, startAt, function () { play(startAt); }, ctx.room.now));
        } else {
          startAt = Date.now() + 3000;
          stops.push(App.MG.countdown(root, startAt, function () { play(startAt); }, function () { return Date.now(); }));
        }
      }

      /* ================= SPIEL-AUFBAU ================= */
      function play(sAt) {
        stopAll();
        startAt = sAt; endAt = sAt + ROUND_SEC * 1000;
        ended = false; meDead = false; spectId = null;
        bots = []; enemies = {}; food = []; parts = [];
        netAcc = scoreAcc = hudAcc = boardAcc = 0;

        buildStage();

        /* Wer ist wo? Spawn deterministisch auf einem Ring (fair fuer alle). */
        var total, myIdx;
        if (isMulti) {
          var ps = ctx.room.players();
          total = Math.max(2, ps.length);
          myIdx = 0;
          for (var i = 0; i < ps.length; i++) { if (ps[i].id === meId) { myIdx = i; break; } }
        } else {
          total = 6; myIdx = 0;          // du + 5 Bots
        }
        me = newSnake(spawnAt(myIdx, total), spawnAng(myIdx, total), myIdx, (ctx.me && ctx.me.name) || 'Du');

        if (!isMulti) {
          for (var b = 1; b < total; b++) {
            var bs = newSnake(spawnAt(b, total), spawnAng(b, total), b, BOT_NAMES[(b - 1) % BOT_NAMES.length]);
            bs.brain = { wander: Math.random() * Math.PI * 2, retargetAt: 0, boostUntil: 0, skill: 0.55 + Math.random() * 0.4 };
            bots.push(bs);
          }
        }

        /* Grund-Futter deterministisch verteilen (gleicher Seed = faires Bild). */
        seedFood(Math.floor(startAt / 100) || 1);

        /* Rundentimer (Wall-Clock, synchron im Multi). */
        stops.push(App.MG.roundTimer(endAt, function (left) {
          if (timeEl) { timeEl.textContent = App.MG.mmss(left); timeEl.classList.toggle('slt-urgent', left <= 10); }
        }, function () { finish(); }, isMulti ? ctx.room.now : function () { return Date.now(); }));

        /* Sofort einmal melden, damit die anderen mich gleich sehen. */
        if (isMulti) { try { ctx.room.reportState(myPacket()); ctx.room.reportScore(Math.round(me.peak)); } catch (e) {} }

        updateBoard(); updateHud();
        lastT = perf();
        raf = requestAnimationFrame(frame);
      }

      function spawnAt(idx, total) {
        var a = (idx / total) * Math.PI * 2;
        return { x: WORLD / 2 + Math.cos(a) * SPAWN_R, y: WORLD / 2 + Math.sin(a) * SPAWN_R };
      }
      function spawnAng(idx, total) { return (idx / total) * Math.PI * 2; } // nach aussen -> etwas Luft

      function newSnake(pos, ang, colIdx, name) {
        var s = {
          x: pos.x, y: pos.y, ang: ang, len: START_LEN, peak: START_LEN,
          r: radiusFor(START_LEN), path: [], pathAcc: 0, dead: false, dc: 0,
          colIdx: colIdx, name: name
        };
        for (var i = 0; i < 30; i++) s.path.push({ x: pos.x - Math.cos(ang) * i * PATH_STEP, y: pos.y - Math.sin(ang) * i * PATH_STEP });
        return s;
      }

      /* ================= FRAME-SCHLEIFE ================= */
      function frame() {
        if (dead || ended) { raf = null; return; }
        var t = perf();
        var dt = (t - lastT) / 1000; if (dt < 0) dt = 0; if (dt > 0.05) dt = 0.05; lastT = t;
        step(dt);
        draw();
        if (!dead && !ended) raf = requestAnimationFrame(frame);
        else raf = null;
      }

      /* ================= LOGIK-SCHRITT ================= */
      function step(dt) {
        /* --- Gegner beschaffen --- */
        if (isMulti) refreshEnemies();

        /* --- eigene Schlange --- */
        if (!meDead) {
          var desired = desiredAng(dt);
          var boost = boostActive() && me.len > BOOST_MIN_LEN;
          advance(me, dt, desired, boost);
          keepInWorldSoft();
          eatFood(me);
          if (checkDeathAgainstEnemies(me)) onMyDeath();
        }

        /* --- Solo-Bots --- */
        if (!isMulti) stepBots(dt);

        /* --- Partikel --- */
        stepParts(dt);

        /* --- Netz melden --- */
        if (isMulti) reportMulti(dt);

        /* --- HUD/Board --- */
        hudAcc += dt; boardAcc += dt;
        if (hudAcc >= 0.14) { hudAcc = 0; updateHud(); }
        if (boardAcc >= 0.3) { boardAcc = 0; updateBoard(); }

        /* --- Rundenende: letzte lebende Schlange --- */
        checkLastSurvivor();
      }

      /* ---- Lenkwinkel aus Eingabe ---- */
      function desiredAng(dt) {
        if (turnL || turnR) {
          var d = (turnR ? 1 : 0) - (turnL ? 1 : 0);
          return me.ang + d * TURN_RATE * dt * 2.2; // wird von advance() auf max. Drehrate begrenzt
        }
        if (aiming) return Math.atan2(aim.y - CH / 2, aim.x - CW / 2);
        return me.ang;
      }

      /* ---- Bewegungs-Integrator (fuer mich + Bots) ---- */
      function advance(s, dt, desired, boost) {
        var da = norm(desired - s.ang), md = TURN_RATE * dt;
        if (da > md) da = md; else if (da < -md) da = -md;
        s.ang += da;
        var sp = boost ? BOOST_SPEED : BASE_SPEED;
        var nx = s.x + Math.cos(s.ang) * sp * dt, ny = s.y + Math.sin(s.ang) * sp * dt;
        var moved = Math.hypot(nx - s.x, ny - s.y);
        s.x = nx; s.y = ny;
        s.pathAcc += moved;
        while (s.pathAcc >= PATH_STEP) { s.path.unshift({ x: s.x, y: s.y }); s.pathAcc -= PATH_STEP; }
        if (s.path.length > MAXPATH) s.path.length = MAXPATH;
        if (boost) {
          s.len -= BOOST_DRAIN * dt; if (s.len < BOOST_MIN_LEN) s.len = BOOST_MIN_LEN;
          if (Math.random() < 0.6) spawnBoostSpark(s);
        }
        s.r = radiusFor(s.len);
        if (s.len > s.peak) s.peak = s.len;
      }

      /* Weiche Weltgrenze: nicht sofort tot, aber toedlich beim echten Ueberschreiten. */
      function keepInWorldSoft() {
        var m = 8;
        if (me.x < -m || me.x > WORLD + m || me.y < -m || me.y > WORLD + m) { onMyDeath(); return; }
      }

      /* ---- Futter fressen ---- */
      function eatFood(s) {
        for (var i = food.length - 1; i >= 0; i--) {
          var f = food[i];
          var rr = s.r + f.r + 4;
          if (Math.abs(f.x - s.x) > rr || Math.abs(f.y - s.y) > rr) continue;
          if ((f.x - s.x) * (f.x - s.x) + (f.y - s.y) * (f.y - s.y) <= rr * rr) {
            s.len += f.val; if (s.len > s.peak) s.peak = s.len; s.r = radiusFor(s.len);
            spawnPop(f.x, f.y, f.col);
            if (s === me) {
              var tn = perf();
              if (tn - eatSndAt > 110) { eatSndAt = tn; if (App.Audio) App.Audio.sfx(f.val >= 3 ? 'coin' : 'point'); }
            }
            if (f.amb) { f.x = randWorld(); f.y = randWorld(); }
            else food.splice(i, 1);
          }
        }
      }

      /* ================= KOLLISION ================= */
      /* Mein Kopf gegen alle fremden Koerper. Rueckgabe true = ich sterbe. */
      function checkDeathAgainstEnemies(s) {
        var hx = s.x, hy = s.y, list = enemyList();
        for (var i = 0; i < list.length; i++) {
          var e = list[i];
          if (!e.alive || e.pts.length < 2) continue;
          /* Kopf-an-Kopf: die kuerzere (oder gleich lange) stirbt. */
          var hh = (s.r + e.r) * 0.78;
          if (Math.abs(e.hx - hx) < hh && Math.abs(e.hy - hy) < hh &&
            (e.hx - hx) * (e.hx - hx) + (e.hy - hy) * (e.hy - hy) < hh * hh) {
            if (s.len <= e.len + 0.01) return true; else continue;
          }
          /* Kopf gegen Koerper-Segmente (die ersten Punkte am Kopf ueberspringen). */
          var thr = s.r + e.r * 0.7, thr2 = thr * thr;
          var p = e.pts;
          for (var k = 2; k < p.length; k++) {
            if (segDist2(hx, hy, p[k - 1].x, p[k - 1].y, p[k].x, p[k].y) <= thr2) return true;
          }
        }
        return false;
      }

      /* Einheitliche Gegnerliste fuer die Kollision (Multi = Remote, Solo = Bots). */
      function enemyList() {
        var out = [];
        if (isMulti) {
          for (var id in enemies) {
            var e = enemies[id];
            if (!e.has) continue;
            out.push({ alive: !e.dead, hx: e.hx, hy: e.hy, r: e.r, len: e.len, pts: e.pts });
          }
        } else {
          for (var i = 0; i < bots.length; i++) {
            var b = bots[i];
            out.push({ alive: !b.dead, hx: b.x, hy: b.y, r: b.r, len: b.len, pts: colPts(b) });
          }
        }
        return out;
      }

      /* ================= SOLO-BOTS ================= */
      function stepBots(dt) {
        var now = perf();
        /* Bewegung + KI */
        for (var i = 0; i < bots.length; i++) {
          var b = bots[i]; if (b.dead) continue;
          var brain = b.brain;
          var desired = b.ang, boost = false;

          /* 1) Wandausweichen (hoechste Prioritaet) */
          var toCx = WORLD / 2 - b.x, toCy = WORLD / 2 - b.y;
          var edge = Math.min(b.x, b.y, WORLD - b.x, WORLD - b.y);
          if (edge < 240) { desired = Math.atan2(toCy, toCx); }
          else {
            /* 2) Gefahr voraus? (fremder Koerper im Lookahead) -> ausweichen */
            var lookX = b.x + Math.cos(b.ang) * (60 + b.r * 4);
            var lookY = b.y + Math.sin(b.ang) * (60 + b.r * 4);
            var danger = nearestBodyPoint(b, lookX, lookY, 120);
            if (danger) {
              var away = Math.atan2(b.y - danger.y, b.x - danger.x);
              desired = away; boost = (b.len > 18 && Math.random() < 0.4);
            } else {
              /* 3) Aggression: gelegentlich dem Spieler den Weg abschneiden */
              var aggro = !meDead && brain.skill > 0.72 && b.len > me.len * 0.85 &&
                dist2(b.x, b.y, me.x, me.y) < 430 * 430;
              if (aggro) {
                var cutX = me.x + Math.cos(me.ang) * 150, cutY = me.y + Math.sin(me.ang) * 150;
                desired = Math.atan2(cutY - b.y, cutX - b.x);
                boost = b.len > 16 && Math.random() < 0.5;
              } else {
                /* 4) Naechstes Futter suchen */
                var tgt = nearestFood(b.x, b.y, 520);
                if (tgt) desired = Math.atan2(tgt.y - b.y, tgt.x - b.x);
                else {
                  if (now >= brain.retargetAt) { brain.wander += (Math.random() - 0.5) * 1.4; brain.retargetAt = now + 500 + Math.random() * 900; }
                  desired = brain.wander;
                }
              }
            }
          }
          if (b.len <= BOOST_MIN_LEN) boost = false;
          advance(b, dt, desired, boost);
          eatFood(b);
        }

        /* Kollisionen aller Bots gleichzeitig (Kopf gegen fremde Koerper). */
        var myPts = meDead ? null : colPts(me);
        var toDie = [];
        for (var j = 0; j < bots.length; j++) {
          var bb = bots[j]; if (bb.dead) continue;
          if (botHits(bb, j, myPts)) toDie.push(bb);
        }
        for (var d = 0; d < toDie.length; d++) killBot(toDie[d]);
      }

      function botHits(b, selfIdx, myPts) {
        /* gegen Spieler */
        if (myPts && !meDead) { if (headHitsBody(b, me.x, me.y, me.r, me.len, myPts)) return true; }
        /* gegen andere Bots */
        for (var i = 0; i < bots.length; i++) {
          if (i === selfIdx) continue; var o = bots[i]; if (o.dead) continue;
          if (headHitsBody(b, o.x, o.y, o.r, o.len, colPts(o))) return true;
        }
        /* Wand */
        if (b.x < 0 || b.x > WORLD || b.y < 0 || b.y > WORLD) return true;
        return false;
      }
      function headHitsBody(b, ohx, ohy, or, olen, pts) {
        var hh = (b.r + or) * 0.78;
        if (Math.abs(ohx - b.x) < hh && Math.abs(ohy - b.y) < hh && dist2(b.x, b.y, ohx, ohy) < hh * hh) {
          return b.len <= olen + 0.01;
        }
        var thr = b.r + or * 0.7, thr2 = thr * thr;
        for (var k = 2; k < pts.length; k++) {
          if (segDist2(b.x, b.y, pts[k - 1].x, pts[k - 1].y, pts[k].x, pts[k].y) <= thr2) return true;
        }
        return false;
      }
      function killBot(b) {
        if (b.dead) return; b.dead = true; b.dc++;
        spawnDeathFood(colPts(b), b.len, b.r);
        deathFx(b.x, b.y, b.colIdx);
        if (App.Audio && dist2(b.x, b.y, camX, camY) < 700 * 700) App.Audio.sfx('explosion');
      }

      /* KI-Helfer */
      function nearestFood(x, y, rad) {
        var best = null, bd = rad * rad;
        for (var i = 0; i < food.length; i++) {
          var f = food[i], dd = dist2(x, y, f.x, f.y);
          if (dd < bd) { bd = dd; best = f; }
        }
        return best;
      }
      function nearestBodyPoint(self, x, y, rad) {
        var best = null, bd = rad * rad;
        /* Spieler */
        if (!meDead) { var pm = scanBody(colPts(me), x, y, bd); if (pm) { best = pm.p; bd = pm.d; } }
        /* andere Bots */
        for (var i = 0; i < bots.length; i++) {
          var o = bots[i]; if (o === self || o.dead) continue;
          var pb = scanBody(colPts(o), x, y, bd); if (pb) { best = pb.p; bd = pb.d; }
        }
        return best;
      }
      function scanBody(pts, x, y, bd) {
        var best = null;
        for (var k = 0; k < pts.length; k += 1) { var dd = dist2(x, y, pts[k].x, pts[k].y); if (dd < bd) { bd = dd; best = pts[k]; } }
        return best ? { p: best, d: bd } : null;
      }

      /* ================= MULTIPLAYER-NETZ ================= */
      function myPacket() {
        return { b: encodeBody(), a: Math.round(me.ang * 1000) / 1000, r: Math.round(me.r), l: Math.round(me.len), d: meDead ? 1 : 0, dc: me.dc };
      }
      function reportMulti(dt) {
        netAcc += dt; scoreAcc += dt;
        if (netAcc >= NET_MS / 1000) { netAcc = 0; try { ctx.room.reportState(myPacket()); } catch (e) {} }
        if (scoreAcc >= SCORE_MS / 1000) { scoreAcc = 0; try { ctx.room.reportScore(Math.round(me.peak)); } catch (e) {} }
      }
      function encodeBody() {
        var tail = tailCount(me.len);
        var n = Math.min(NET_BODY_PTS, 2 + Math.floor(tail / 2)); if (n < 2) n = 2;
        var out = [Math.round(me.x), Math.round(me.y)];
        for (var k = 1; k < n; k++) {
          var idx = Math.round((k / (n - 1)) * (tail - 1));
          var pt = me.path[Math.min(idx, me.path.length - 1)] || { x: me.x, y: me.y };
          out.push(Math.round(pt.x)); out.push(Math.round(pt.y));
        }
        return out;
      }
      function decodeBody(arr) {
        var pts = [];
        for (var i = 0; i + 1 < arr.length; i += 2) pts.push({ x: arr[i], y: arr[i + 1] });
        return pts;
      }
      function refreshEnemies() {
        var ps = ctx.room.players();
        var present = {};
        for (var i = 0; i < ps.length; i++) {
          var p = ps[i]; if (p.id === meId) continue;
          present[p.id] = true;
          var e = enemies[p.id] || (enemies[p.id] = { id: p.id, disp: [], seenDc: -1, has: false });
          e.name = p.name; e.colIdx = i % COLORS.length;
          var s = p.state;
          if (s && s.b && s.b.length >= 4) {
            e.pts = decodeBody(s.b);
            e.hx = e.pts[0].x; e.hy = e.pts[0].y;
            e.ang = (typeof s.a === 'number') ? s.a : (e.ang || 0);
            e.r = s.r || 10; e.len = s.l || 0; e.dead = !!s.d; e.has = true;
            var dc = s.dc || 0;
            if (s.d && dc > e.seenDc) { spawnDeathFood(e.pts, e.len, e.r); deathFx(e.hx, e.hy, e.colIdx); if (App.Audio && dist2(e.hx, e.hy, camX, camY) < 700 * 700) App.Audio.sfx('explosion'); }
            if (dc > e.seenDc) e.seenDc = dc;
            smoothDisp(e);
          } else { e.has = false; }
        }
        for (var id in enemies) { if (!present[id]) delete enemies[id]; }
      }
      function smoothDisp(e) {
        if (e.disp.length !== e.pts.length) { e.disp = []; for (var i = 0; i < e.pts.length; i++) e.disp.push({ x: e.pts[i].x, y: e.pts[i].y }); return; }
        var f = 0.35;
        for (var k = 0; k < e.pts.length; k++) { e.disp[k].x += (e.pts[k].x - e.disp[k].x) * f; e.disp[k].y += (e.pts[k].y - e.disp[k].y) * f; }
      }

      /* ================= TOD / ENDE ================= */
      function onMyDeath() {
        if (meDead) return; meDead = true; me.dead = true; me.dc++;
        spawnDeathFood(colPts(me), me.len, me.r);
        deathFx(me.x, me.y, me.colIdx);
        if (App.Audio) App.Audio.sfx('explosion');
        if (isMulti) { try { ctx.room.reportState(myPacket()); ctx.room.reportScore(Math.round(me.peak)); } catch (e) {} showBanner('💀 Erwischt! Du schaust jetzt zu …', 'lose'); }
        else { var to = setTimeout(function () { if (!dead) finish(); }, 950); stops.push(function () { clearTimeout(to); }); }
      }

      function checkLastSurvivor() {
        if (ended) return;
        if (nowFn() < startAt + 1500) return; // Anfangs-Schonfrist
        if (isMulti) {
          var ps = ctx.room.players(); if (ps.length < 2) return;
          var alive = 0;
          for (var i = 0; i < ps.length; i++) {
            var p = ps[i];
            var isDead = (p.id === meId) ? meDead : (enemies[p.id] && enemies[p.id].dead);
            if (!isDead) alive++;
          }
          if (alive <= 1) finish();
        } else {
          var aliveBots = 0; for (var b = 0; b < bots.length; b++) if (!bots[b].dead) aliveBots++;
          if (!meDead && aliveBots === 0) finish();
        }
      }

      function finish() {
        if (ended || dead) return; ended = true;
        if (raf) { cancelAnimationFrame(raf); raf = null; }
        stopAll();
        if (isMulti) {
          try { ctx.room.reportScore(Math.round(me.peak)); } catch (e) {}
          var ps = ctx.room.players().slice().sort(function (a, b) { return (b.score || 0) - (a.score || 0); });
          var iWon = ps[0] && ps[0].id === meId;
          if (iWon && App.Scores) App.Scores.winCurrent();
          var to = setTimeout(function () {
            if (dead) return;
            App.MG.endScreen(root, { players: ctx.room.players(), meId: meId, onExit: ctx.onExit });
          }, 900);
          stops.push(function () { clearTimeout(to); });
        } else {
          var best = App.Storage.get('best_slither', 0);
          var sc = Math.round(me.peak);
          var nb = sc > best; if (nb) App.Storage.set('best_slither', sc);
          var aliveBots = 0; for (var i = 0; i < bots.length; i++) if (!bots[i].dead) aliveBots++;
          var won = !meDead && aliveBots === 0;
          if (won && App.Scores) App.Scores.winCurrent();
          var label = won ? 'Letzte Schlange – Sieg! 🏆'
            : (meDead ? 'Erwischt · Laenge ' : 'Zeit um · Laenge ') + App.MG.fmt(sc) + (nb ? ' · neuer Rekord! 🎉' : ' · Best ' + App.MG.fmt(best));
          App.MG.endScreen(root, {
            score: sc, best: best, newBest: nb, label: label,
            onExit: ctx.onExit, onAgain: function () { startGame(); }
          });
        }
      }

      /* ================= FUTTER / PARTIKEL ================= */
      function seedFood(seed) {
        var rnd = mulberry(seed);
        for (var i = 0; i < AMBIENT_FOOD; i++) {
          var big = rnd() < 0.08;
          food.push({
            x: 40 + rnd() * (WORLD - 80), y: 40 + rnd() * (WORLD - 80),
            r: big ? 7 : 4.5, val: big ? 2 : 1, amb: true, big: big,
            col: FOOD_COLS[Math.floor(rnd() * FOOD_COLS.length)]
          });
        }
      }
      function spawnDeathFood(pts, len, r) {
        if (!pts || pts.length < 2) return;
        var K = clamp(Math.round(len / 3), 6, 36);
        var val = clamp(Math.round((len / K) * 0.7) + 1, 1, 6);
        for (var k = 0; k < K; k++) {
          var idx = Math.floor((k / K) * pts.length), p = pts[Math.min(idx, pts.length - 1)];
          food.push({
            x: p.x + (Math.random() - 0.5) * r * 2.2, y: p.y + (Math.random() - 0.5) * r * 2.2,
            r: 6 + val, val: val, amb: false, big: true, col: val >= 3 ? '#ffd23f' : '#7ff3e6'
          });
        }
      }
      function spawnBoostSpark(s) {
        if (parts.length > MAXP) return;
        var a = s.ang + Math.PI + (Math.random() - 0.5) * 0.9;
        parts.push({ x: s.x, y: s.y, vx: Math.cos(a) * 60, vy: Math.sin(a) * 60, life: 0.4, max: 0.4, r: s.r * 0.5, col: COLORS[s.colIdx % COLORS.length].glow });
      }
      function spawnPop(x, y, col) {
        if (parts.length > MAXP) return;
        for (var i = 0; i < 4; i++) {
          var a = Math.random() * Math.PI * 2, sp = 30 + Math.random() * 70;
          parts.push({ x: x, y: y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 0.35, max: 0.35, r: 3, solid: col });
        }
      }
      function deathFx(x, y, colIdx) {
        var glow = COLORS[colIdx % COLORS.length].glow;
        for (var i = 0; i < 24; i++) {
          var a = Math.random() * Math.PI * 2, sp = 80 + Math.random() * 220;
          parts.push({ x: x, y: y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 0.7, max: 0.7, r: 3 + Math.random() * 5, col: glow });
        }
      }
      function stepParts(dt) {
        for (var i = parts.length - 1; i >= 0; i--) {
          var p = parts[i]; p.life -= dt; if (p.life <= 0) { parts.splice(i, 1); continue; }
          p.x += p.vx * dt; p.y += p.vy * dt; p.vx *= 0.92; p.vy *= 0.92;
        }
      }

      /* ================= ZEICHNEN ================= */
      function follow() {
        if (!meDead) return { x: me.x, y: me.y, r: me.r };
        if (isMulti) {
          var best = null;
          for (var id in enemies) { var e = enemies[id]; if (e.has && !e.dead && (!best || e.len > best.len)) best = e; }
          if (best) { spectId = best.id; return { x: best.hx, y: best.hy, r: best.r }; }
        }
        return { x: camX, y: camY, r: 12 };
      }
      function w2s(x, y) { return { x: (x - camX) * ZOOM + CW / 2, y: (y - camY) * ZOOM + CH / 2 }; }

      function draw() {
        var f = follow();
        camX = f.x; camY = f.y;
        ZOOM = clamp(0.72 * 11 / Math.max(f.r, 10), 0.42, 0.82);

        g.clearRect(0, 0, CW, CH);
        /* Hintergrund */
        var grd = g.createRadialGradient(CW / 2, CH / 2, 40, CW / 2, CH / 2, CH);
        grd.addColorStop(0, '#06180e'); grd.addColorStop(1, '#020a06');
        g.fillStyle = grd; g.fillRect(0, 0, CW, CH);
        drawGrid();
        drawArena();

        /* Futter (nur sichtbares) */
        for (var i = 0; i < food.length; i++) {
          var fo = food[i], sp = w2s(fo.x, fo.y);
          if (sp.x < -20 || sp.x > CW + 20 || sp.y < -20 || sp.y > CH + 20) continue;
          var rr = fo.r * ZOOM;
          g.beginPath(); g.fillStyle = 'rgba(140,255,120,0.16)'; g.arc(sp.x, sp.y, rr * 2.4, 0, Math.PI * 2); g.fill();
          g.beginPath(); g.fillStyle = fo.col; g.arc(sp.x, sp.y, rr, 0, Math.PI * 2); g.fill();
        }

        /* Gegner */
        if (isMulti) {
          for (var id in enemies) { var e = enemies[id]; if (e.has && !e.dead) drawEnemy(e); }
        } else {
          for (var b = 0; b < bots.length; b++) { if (!bots[b].dead) drawSnake(bots[b], false); }
        }

        /* eigene Schlange */
        if (!meDead) drawSnake(me, true);

        /* Partikel */
        drawParts();
        /* Minikarte */
        drawMinimap();
      }

      function drawGrid() {
        g.save(); g.strokeStyle = 'rgba(57,255,20,0.05)'; g.lineWidth = 1;
        var step = 130 * ZOOM;
        var ox = ((-camX * ZOOM + CW / 2) % step + step) % step;
        var oy = ((-camY * ZOOM + CH / 2) % step + step) % step;
        for (var x = ox; x < CW; x += step) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, CH); g.stroke(); }
        for (var y = oy; y < CH; y += step) { g.beginPath(); g.moveTo(0, y); g.lineTo(CW, y); g.stroke(); }
        g.restore();
      }
      function drawArena() {
        var a = w2s(0, 0), c = w2s(WORLD, WORLD);
        g.save(); g.lineWidth = 6; g.strokeStyle = 'rgba(255,77,109,0.55)'; g.shadowColor = 'rgba(255,77,109,0.7)'; g.shadowBlur = 18;
        g.strokeRect(a.x, a.y, c.x - a.x, c.y - a.y); g.restore();
      }

      function drawSnake(s, isMe) {
        var pts = drawPts(s);
        var col = COLORS[s.colIdx % COLORS.length];
        drawTube(pts, s.r, col, isMe);
        drawHead(s.x, s.y, s.ang, s.r, col, s.name, isMe);
      }
      function drawEnemy(e) {
        var col = COLORS[e.colIdx % COLORS.length];
        var pts = e.disp && e.disp.length ? e.disp : e.pts;
        drawTube(pts, e.r, col, false);
        drawHead(e.hx, e.hy, e.ang, e.r, col, e.name, false);
      }
      function drawTube(worldPts, r, col, isMe) {
        if (!worldPts || worldPts.length < 2) return;
        var scr = [];
        for (var i = 0; i < worldPts.length; i++) scr.push(w2s(worldPts[i].x, worldPts[i].y));
        var w = Math.max(2, r * 2 * ZOOM);
        g.save(); g.lineJoin = 'round'; g.lineCap = 'round';
        g.strokeStyle = col.glow + '0.22)'; g.lineWidth = w + 9; strokeSmooth(scr);
        g.strokeStyle = col.body; g.lineWidth = w; strokeSmooth(scr);
        g.strokeStyle = 'rgba(255,255,255,' + (isMe ? 0.22 : 0.14) + ')'; g.lineWidth = Math.max(1, w * 0.32); strokeSmooth(scr);
        g.restore();
      }
      function strokeSmooth(scr) {
        g.beginPath(); g.moveTo(scr[0].x, scr[0].y);
        for (var i = 1; i < scr.length - 1; i++) {
          var mx = (scr[i].x + scr[i + 1].x) / 2, my = (scr[i].y + scr[i + 1].y) / 2;
          g.quadraticCurveTo(scr[i].x, scr[i].y, mx, my);
        }
        var last = scr[scr.length - 1]; g.lineTo(last.x, last.y); g.stroke();
      }
      function drawHead(x, y, ang, r, col, name, isMe) {
        var h = w2s(x, y), hr = r * ZOOM * 1.12;
        g.save();
        g.shadowColor = col.glow + '0.9)'; g.shadowBlur = 16;
        g.fillStyle = col.body; g.beginPath(); g.arc(h.x, h.y, hr, 0, Math.PI * 2); g.fill();
        g.restore();
        /* Augen */
        var ex = Math.cos(ang), ey = Math.sin(ang), px = -ey, py = ex, off = hr * 0.5;
        for (var s = -1; s <= 1; s += 2) {
          var eox = h.x + ex * hr * 0.35 + px * off * s, eoy = h.y + ey * hr * 0.35 + py * off * s;
          g.fillStyle = col.eye; g.beginPath(); g.arc(eox, eoy, hr * 0.34, 0, Math.PI * 2); g.fill();
          g.fillStyle = '#04160c'; g.beginPath(); g.arc(eox + ex * hr * 0.16, eoy + ey * hr * 0.16, hr * 0.17, 0, Math.PI * 2); g.fill();
        }
        /* Name */
        g.save(); g.font = '700 12px system-ui,Segoe UI,Roboto,Arial,sans-serif'; g.textAlign = 'center';
        g.fillStyle = isMe ? '#eafff0' : 'rgba(230,255,240,0.72)'; g.shadowColor = 'rgba(0,0,0,0.8)'; g.shadowBlur = 6;
        g.fillText((name || '') + (isMe ? ' (du)' : ''), h.x, h.y - hr - 8); g.restore();
      }
      function drawParts() {
        g.save();
        for (var i = 0; i < parts.length; i++) {
          var p = parts[i], sp = w2s(p.x, p.y), a = p.life / p.max;
          if (p.solid) { g.fillStyle = p.solid; g.globalAlpha = a; }
          else { g.fillStyle = p.col + (0.6 * a).toFixed(3) + ')'; g.globalAlpha = 1; }
          g.beginPath(); g.arc(sp.x, sp.y, Math.max(1, p.r * ZOOM * (0.5 + a * 0.6)), 0, Math.PI * 2); g.fill();
        }
        g.globalAlpha = 1; g.restore();
      }
      function drawMinimap() {
        var S = 86, pad = 10, ox = CW - S - pad, oy = pad, sc = S / WORLD;
        g.save();
        g.fillStyle = 'rgba(3,14,9,0.72)'; g.strokeStyle = 'rgba(57,255,20,0.4)'; g.lineWidth = 1;
        g.fillRect(ox, oy, S, S); g.strokeRect(ox, oy, S, S);
        function dot(x, y, col, rad) { g.fillStyle = col; g.beginPath(); g.arc(ox + x * sc, oy + y * sc, rad, 0, Math.PI * 2); g.fill(); }
        if (isMulti) { for (var id in enemies) { var e = enemies[id]; if (e.has && !e.dead) dot(e.hx, e.hy, COLORS[e.colIdx % COLORS.length].body, 2); } }
        else { for (var b = 0; b < bots.length; b++) { if (!bots[b].dead) dot(bots[b].x, bots[b].y, COLORS[bots[b].colIdx % COLORS.length].body, 2); } }
        if (!meDead) dot(me.x, me.y, '#eafff0', 3);
        g.restore();
      }

      /* Punkte fuers Zeichnen (Kopf + ausgeduennter Pfad, max. ~120 Punkte). */
      function drawPts(s) {
        var tail = tailCount(s.len);
        var stride = Math.max(1, Math.floor(tail / 120));
        var out = [{ x: s.x, y: s.y }];
        for (var i = stride; i < tail && i < s.path.length; i += stride) out.push(s.path[i]);
        return out;
      }
      /* Punkte fuer die Kollision (groeber, Segment-Abstand deckt Luecken). */
      function colPts(s) {
        var tail = tailCount(s.len);
        var stride = Math.max(2, Math.floor(tail / 70));
        var out = [{ x: s.x, y: s.y }];
        for (var i = stride; i < tail && i < s.path.length; i += stride) out.push(s.path[i]);
        return out;
      }

      /* ================= EINGABE ================= */
      function boostActive() { return mouseBoost || keyBoost || btnBoost; }
      function toVirt(cx, cy) { var r = canvasEl.getBoundingClientRect(); return { x: (cx - r.left) / r.width * CW, y: (cy - r.top) / r.height * CH }; }

      function attachInput() {
        function pd(e) {
          if (e.pointerType === 'mouse') mouseBoost = true;
          aim = toVirt(e.clientX, e.clientY); aiming = true; steerPid = e.pointerId;
          turnL = turnR = false;
          if (e.cancelable) e.preventDefault();
        }
        function pm(e) {
          if (e.pointerType === 'mouse') { aim = toVirt(e.clientX, e.clientY); aiming = true; }
          else if (e.pointerId === steerPid) { aim = toVirt(e.clientX, e.clientY); }
          if (e.cancelable) e.preventDefault();
        }
        function pu(e) {
          if (e.pointerType === 'mouse') mouseBoost = false;
          else if (e.pointerId === steerPid) { steerPid = null; aiming = false; }
        }
        addL(canvasEl, 'pointerdown', pd);
        addL(canvasEl, 'pointermove', pm);
        addL(canvasEl, 'pointerup', pu);
        addL(canvasEl, 'pointercancel', pu);

        function kd(e) {
          var k = e.key;
          if (k === 'ArrowLeft' || k === 'a' || k === 'A') { turnL = true; e.preventDefault(); }
          else if (k === 'ArrowRight' || k === 'd' || k === 'D') { turnR = true; e.preventDefault(); }
          else if (k === ' ' || k === 'Shift' || k === 'ArrowUp' || k === 'w' || k === 'W') { keyBoost = true; e.preventDefault(); }
        }
        function ku(e) {
          var k = e.key;
          if (k === 'ArrowLeft' || k === 'a' || k === 'A') turnL = false;
          else if (k === 'ArrowRight' || k === 'd' || k === 'D') turnR = false;
          else if (k === ' ' || k === 'Shift' || k === 'ArrowUp' || k === 'w' || k === 'W') keyBoost = false;
        }
        addL(document, 'keydown', kd);
        addL(document, 'keyup', ku);

        function bStart(e) { btnBoost = true; boostBtn.classList.add('slt-on'); if (e.cancelable) e.preventDefault(); }
        function bEnd(e) { btnBoost = false; boostBtn.classList.remove('slt-on'); if (e && e.cancelable) e.preventDefault(); }
        addL(boostBtn, 'pointerdown', bStart);
        addL(boostBtn, 'pointerup', bEnd);
        addL(boostBtn, 'pointerleave', bEnd);
        addL(boostBtn, 'pointercancel', bEnd);
      }

      /* ================= DOM-AUFBAU ================= */
      function buildStage() {
        lenEl = el('div', { class: 'slt-len' }, ['14']);
        timeEl = el('div', { class: 'mg-timer slt-time' }, [App.MG.mmss(ROUND_SEC)]);
        rankEl = el('div', { class: 'slt-rank' }, ['#1']);
        var topbar = el('div', { class: 'slt-topbar glass' }, [
          el('div', { class: 'slt-tb-cell' }, [el('span', { class: 'slt-tb-l' }, ['🐍 Laenge']), lenEl]),
          el('div', { class: 'slt-tb-cell slt-mid' }, [el('span', { class: 'slt-tb-l' }, ['⏱ Zeit']), timeEl]),
          el('div', { class: 'slt-tb-cell slt-right' }, [el('span', { class: 'slt-tb-l' }, ['🏆 Rang']), rankEl])
        ]);

        canvasEl = el('canvas', { class: 'slt-canvas', width: CW, height: CH });
        boardEl = el('div', { class: 'slt-board glass' }, []);
        bannerEl = el('div', { class: 'slt-banner' }, []);
        boostBtn = el('button', { class: 'slt-boost', type: 'button', 'aria-label': 'Boost' }, [
          el('span', { class: 'slt-boost-ic' }, ['🚀']), el('span', { class: 'slt-boost-t' }, ['TURBO'])
        ]);
        var stage = el('div', { class: 'slt-stage' }, [canvasEl, boardEl, bannerEl, boostBtn]);

        var hint = el('div', { class: 'slt-hint hint-text' }, [
          'Finger ziehen / Maus bewegen = lenken · 🚀 halten oder Leertaste = Boost · friss Punkte, schneide Gegner ab!'
        ]);

        var wrap = el('div', { class: 'slt-wrap' }, [topbar, stage, hint]);
        root.innerHTML = ''; root.appendChild(wrap);
        g = canvasEl.getContext('2d');
        attachInput();
      }

      function showBanner(text, cls) {
        if (!bannerEl) return;
        bannerEl.textContent = text;
        bannerEl.className = 'slt-banner slt-show ' + (cls || '');
      }

      /* ---- HUD ---- */
      function updateHud() {
        if (!lenEl) return;
        lenEl.textContent = meDead ? '—' : App.MG.fmt(Math.round(me.len));
        var st = standings();
        var r = 1; for (var i = 0; i < st.length; i++) { if (st[i].me) { r = i + 1; break; } }
        rankEl.textContent = '#' + r + '/' + st.length;
      }

      /* ---- Live-Rangliste (Solo + Multi, eigener kompakter Renderer) ---- */
      function standings() {
        var list = [];
        if (isMulti) {
          var ps = ctx.room.players();
          for (var i = 0; i < ps.length; i++) {
            var p = ps[i];
            var isDead = (p.id === meId) ? meDead : (enemies[p.id] && enemies[p.id].dead);
            list.push({ name: p.name, score: p.score || 0, me: p.id === meId, dead: !!isDead });
          }
        } else {
          list.push({ name: 'Du', score: Math.round(me.peak), me: true, dead: meDead });
          for (var b = 0; b < bots.length; b++) list.push({ name: bots[b].name, score: Math.round(bots[b].peak), me: false, dead: bots[b].dead });
        }
        list.sort(function (a, b) { return b.score - a.score; });
        return list;
      }
      function updateBoard() {
        if (!boardEl) return;
        var st = standings();
        boardEl.innerHTML = '';
        boardEl.appendChild(el('div', { class: 'slt-board-t' }, ['🏆 Rangliste']));
        for (var i = 0; i < st.length && i < 6; i++) {
          var p = st[i];
          boardEl.appendChild(el('div', { class: 'slt-row' + (p.me ? ' slt-me' : '') + (p.dead ? ' slt-dead' : '') }, [
            el('span', { class: 'slt-rk' }, ['' + (i + 1)]),
            el('span', { class: 'slt-nm' }, [p.name + (p.me ? ' (du)' : '') + (p.dead ? ' 💀' : '')]),
            el('span', { class: 'slt-sc' }, [App.MG.fmt(p.score)])
          ]));
        }
      }

      /* ================= kleine Mathe-Helfer ================= */
      function radiusFor(len) { return clamp(BASE_R + Math.sqrt(Math.max(0, len)) * 0.95, BASE_R, MAX_R); }
      function tailCount(len) { return clamp(Math.round((len * 6 + 60) / PATH_STEP), 12, MAXPATH); }
      function norm(a) { while (a > Math.PI) a -= Math.PI * 2; while (a < -Math.PI) a += Math.PI * 2; return a; }
      function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
      function dist2(ax, ay, bx, by) { var dx = ax - bx, dy = ay - by; return dx * dx + dy * dy; }
      function randWorld() { return 40 + Math.random() * (WORLD - 80); }
      function segDist2(px, py, ax, ay, bx, by) {
        var vx = bx - ax, vy = by - ay, wx = px - ax, wy = py - ay;
        var c1 = vx * wx + vy * wy;
        if (c1 <= 0) return dist2(px, py, ax, ay);
        var c2 = vx * vx + vy * vy;
        if (c2 <= c1) return dist2(px, py, bx, by);
        var t = c1 / c2, qx = ax + t * vx, qy = ay + t * vy;
        return dist2(px, py, qx, qy);
      }
      function mulberry(a) {
        return function () {
          a |= 0; a = (a + 0x6D2B79F5) | 0;
          var t = Math.imul(a ^ (a >>> 15), 1 | a);
          t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
          return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
      }
    }
  };

  /* ============================ STYLES ============================ */
  function injectStyle() {
    UI.injectStyle('mg-slither-css', [
      '.slt-wrap{display:flex;flex-direction:column;gap:12px;align-items:stretch;}',
      '.slt-topbar{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:10px 18px;}',
      '.slt-tb-cell{display:flex;flex-direction:column;gap:2px;min-width:0;}',
      '.slt-mid{text-align:center;}',
      '.slt-right{text-align:right;}',
      '.slt-tb-l{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:1px;font-weight:800;}',
      '.slt-len{font-size:clamp(22px,6vw,36px);font-weight:900;color:var(--neon);text-shadow:0 0 12px rgba(57,255,20,.5);line-height:1;font-variant-numeric:tabular-nums;}',
      '.slt-time{font-size:clamp(18px,5vw,26px)!important;}',
      '.slt-time.slt-urgent{color:var(--danger);animation:slt-pulse .7s infinite;}',
      '.slt-rank{font-size:clamp(20px,5.5vw,32px);font-weight:900;color:var(--gold);text-shadow:0 0 12px rgba(255,210,63,.45);line-height:1;font-variant-numeric:tabular-nums;}',
      '.slt-stage{position:relative;width:100%;max-width:760px;margin:0 auto;aspect-ratio:880 / 620;}',
      '.slt-canvas{position:absolute;inset:0;width:100%;height:100%;display:block;border-radius:16px;',
      'border:2px solid rgba(57,255,20,.35);background:#04140c;',
      'box-shadow:0 0 42px rgba(57,255,20,.22),inset 0 0 60px rgba(57,255,20,.06);',
      'touch-action:none;user-select:none;-webkit-user-select:none;-webkit-tap-highlight-color:transparent;cursor:crosshair;}',
      /* Overlay-Rangliste oben links */
      '.slt-board{position:absolute;top:10px;left:10px;padding:8px 10px;min-width:118px;max-width:46%;',
      'display:flex;flex-direction:column;gap:3px;background:rgba(3,14,9,.72)!important;border-radius:12px;pointer-events:none;}',
      '.slt-board-t{font-size:10px;font-weight:800;color:var(--muted);text-transform:uppercase;letter-spacing:1px;margin-bottom:2px;}',
      '.slt-row{display:grid;grid-template-columns:16px 1fr auto;align-items:center;gap:6px;font-size:12px;line-height:1.3;}',
      '.slt-rk{color:var(--muted);font-weight:800;text-align:center;}',
      '.slt-nm{color:var(--leaf);font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      '.slt-sc{color:var(--aqua);font-weight:900;font-variant-numeric:tabular-nums;}',
      '.slt-me .slt-nm{color:#eafff0;}',
      '.slt-me .slt-rk{color:var(--gold);}',
      '.slt-dead{opacity:.5;}',
      '.slt-dead .slt-nm{color:var(--muted);}',
      /* Banner (Tod / Zuschauen) */
      '.slt-banner{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%) scale(.9);opacity:0;pointer-events:none;',
      'padding:12px 20px;border-radius:14px;background:rgba(3,14,9,.82);border:1px solid var(--stroke-2);',
      'font-weight:900;font-size:clamp(16px,4vw,22px);text-align:center;color:#fff;transition:opacity .25s,transform .25s;max-width:80%;}',
      '.slt-banner.slt-show{opacity:1;transform:translate(-50%,-50%) scale(1);}',
      '.slt-banner.lose{color:var(--danger);text-shadow:0 0 14px rgba(255,77,109,.5);border-color:var(--danger);}',
      /* Boost-Knopf */
      '.slt-boost{position:absolute;right:14px;bottom:14px;width:clamp(58px,15vw,76px);height:clamp(58px,15vw,76px);',
      'border-radius:50%;border:2px solid var(--stroke-2);background:radial-gradient(circle at 50% 38%,rgba(57,255,20,.28),rgba(4,20,12,.9));',
      'color:#eafff0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1px;cursor:pointer;',
      'touch-action:none;-webkit-tap-highlight-color:transparent;user-select:none;-webkit-user-select:none;',
      'box-shadow:0 0 18px rgba(57,255,20,.28);transition:transform .08s,box-shadow .12s,background .12s;}',
      '.slt-boost:active,.slt-boost.slt-on{transform:scale(.92);background:radial-gradient(circle at 50% 38%,rgba(57,255,20,.55),rgba(9,40,20,.95));box-shadow:0 0 30px rgba(57,255,20,.6);}',
      '.slt-boost-ic{font-size:clamp(20px,5vw,26px);line-height:1;}',
      '.slt-boost-t{font-size:9px;font-weight:900;letter-spacing:1px;color:var(--leaf);}',
      '.slt-hint{text-align:center;}',
      '@keyframes slt-pulse{0%,100%{opacity:1}50%{opacity:.4}}'
    ].join(''));
  }
})();
