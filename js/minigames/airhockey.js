/* airhockey.js — "Airhockey": Neon-Lufttisch im Hochformat.
 *
 * SPIELIDEE: Zwei Schläger, ein Puck auf dem Luftkissen. Der eigene Schläger steht
 *   IMMER unten (Neon-Grün), der Gegner oben (Aqua). Wer zuerst 7 Tore schießt, gewinnt.
 * STEUERUNG: Finger/Maus über den Tisch ziehen — der Schläger folgt der Zeigerposition,
 *   darf aber die Mittellinie nicht überqueren. Der Puck bekommt Schwung aus der
 *   Schlägerbewegung (schnell zuschlagen = harter Schuss), Reibung bremst ihn langsam ab,
 *   Banden und Pfosten lassen ihn abprallen. Tempo-Deckel verhindert Überschall-Pucks.
 * PUNKTE: Tor -> Anstoß-Countdown in der Mitte, der Puck rollt zum Kassierer.
 *   Solo-Punkte = (Tore*100 + Siegbonus 600 + (7-Gegentore)*150 + Tempobonus) * Schwierigkeitsfaktor.
 *   Multiplayer: reportScore(eigene Tore) -> Podest im Endscreen.
 * SPIELZEIT: Schafft nach MATCH_TIME (5 min) niemand die 7, entscheidet der Vorsprung.
 *   Bei GLEICHSTAND läuft das Match sonst ewig -> Golden Goal: das nächste Tor gewinnt
 *   (Anzeige am Tisch). Trifft auch dann 90 s lang niemand, endet es als Unentschieden.
 *
 * SOLO : Bot-Schläger mit 4 Stufen (Leicht/Normal/Schwer/Profi). Der Bot verteidigt mit
 *   Flugbahn-Vorhersage (Bandenspiegelung), greift an, indem er sich hinter den Puck
 *   stellt und Richtung Tor durchzieht. Reaktionslag + Ziel-Fehler machen ihn schlagbar.
 * MULTI: Host-autoritativ. Der Host rechnet die komplette Puck-Physik und sendet
 *   Puck + Schläger + Tore ~20x/Sekunde per room.setShared(). Beide melden ihre eigene
 *   Schlägerposition per room.reportState({mx,my}) (~20x/s). Der Gast extrapoliert den Puck
 *   über die letzte bekannte Geschwindigkeit und zieht ihn per Lerp weich auf die Sollposition
 *   (Lag-Ausgleich); den eigenen Schläger rendert er lokal (sofortige Reaktion).
 *   Kanonische Koordinaten: Spieler[0] unten, Spieler[1] oben. Spieler[1] spiegelt die
 *   Darstellung um 180 Grad, damit auch er unten steht.
 * ZEIT: Solo Date.now(), Multi room.now() (Server-Zeit, synchron). Physik immer mit echtem dt
 *   in Sub-Schritten (kein Tunneln), rAF nur zum Zeichnen. cleanup() beendet wirklich alles. */
(function () {
  'use strict';
  window.App = window.App || {}; App.Minigames = App.Minigames || {};
  var UI = App.UI, el = UI.el;

  /* ---- Virtueller Tisch (feste Koordinaten, Canvas skaliert per CSS) ---- */
  var W = 480, H = 760;          // Spielfeld in virtuellen px (hochkant)
  var PR = 15;                   // Puck-Radius
  var MR = 32;                   // Schläger-Radius
  var GOAL_HALF = 84;            // halbe Torbreite
  var POST_R = 7;                // Pfosten-Radius
  var WIN_GOALS = 7;             // Tore zum Sieg
  var FRICTION = 0.72;           // Rest-Tempo pro Sekunde (Luftkissen = wenig Reibung)
  var MAX_PUCK = 1250;           // px/s Tempo-Deckel
  var MIN_HIT = 240;             // px/s Mindesttempo nach einem Schlägerkontakt
  var WALL_E = 0.9;              // Bande/Pfosten-Restitution
  var PUCK_E = 0.94;             // Schläger-Restitution
  var MAX_MALLET_V = 1700;       // px/s Deckel für den Schlägerimpuls (kein Teleport-Smash)
  var FACEOFF_MS = 2200;         // ms Anstoß-Pause nach Tor / vor dem ersten Bully
  var SERVE_SPEED = 230;         // px/s Anstoß-Schub zum Kassierer
  var SUB = 0.006;               // s max. Physik-Teilschritt
  var MATCH_TIME = 300;          // s Notbremse, falls niemand 7 Tore schafft
  var GOLDEN_MAX = 90;           // s Golden Goal danach; trifft niemand -> Unentschieden
  var DRAW = '__draw__';         // Sentinel-"Sieger" für Unentschieden
  var BROADCAST_MS = 50;         // Host: setShared-Drossel (~20x/s)
  var REPORT_MS = 50;            // Spieler: reportState-Drossel (~20x/s)

  /* ---- Bot-Stufen: speed=px/s, err=Ziel-Streuung, lag=Reaktionszeit, defY=Verteidigungslinie ---- */
  var DIFFS = [
    { key: 'leicht', name: 'Leicht', icon: '🌱', sub: 'gemütlich', speed: 300, err: 60, lag: 0.26, defY: 150, mul: 1 },
    { key: 'normal', name: 'Normal', icon: '🌿', sub: 'fair', speed: 430, err: 34, lag: 0.16, defY: 138, mul: 1.6 },
    { key: 'schwer', name: 'Schwer', icon: '🔥', sub: 'flink', speed: 585, err: 18, lag: 0.09, defY: 128, mul: 2.4 },
    { key: 'profi', name: 'Profi', icon: '👑', sub: 'gnadenlos', speed: 740, err: 8, lag: 0.04, defY: 120, mul: 3.4 }
  ];
  function diffByKey(k) {
    for (var i = 0; i < DIFFS.length; i++) if (DIFFS[i].key === k) return DIFFS[i];
    return DIFFS[1];
  }

  injectStyle();

  App.Minigames.airhockey = {
    id: 'airhockey', title: 'Airhockey', icon: '🏒', order: 113,
    subtitle: 'Neon-Lufttisch: 7 Tore gewinnen das Duell',
    single: true, multi: true, minPlayers: 2, maxPlayers: 2,

    render: function (root, ctx) {
      var isMulti = (ctx.mode === 'multi');
      var timeNow = isMulti ? function () { return ctx.room.now(); } : function () { return Date.now(); };

      /* ---- Laufzeit ---- */
      var dead = false, ended = false, raf = null, last = 0;
      var listeners = [], stops = [], pending = [];
      var g = null;                                  // 2D-Kontext
      var st = null;                                 // Physik-Zustand (Host/Solo maßgeblich)
      var mTop = null, mBot = null, mine = null, foe = null;
      var myIsBottom = true, flip = false;           // flip: Ansicht um 180 Grad drehen
      var myTx = W / 2, myTy = H - 120;              // Zielposition meines Schlägers (Zeiger)
      var trail = [];

      /* ---- Solo ---- */
      var diff = diffByKey(App.Storage ? App.Storage.get('ahk_diff', 'normal') : 'normal');
      var botThinkAt = 0, botErr = 0, botAim = 0, prevVy = 0, botTgt = null;

      /* ---- Multi ---- */
      var netPuck = null, netShared = null, sharedHandler = null;
      var oppTgt = { x: W / 2, y: 120 }, oppShown = { x: W / 2, y: 120 };
      var rPuck = { x: W / 2, y: H / 2 };            // weich interpolierter Gast-Puck
      var lastReport = 0, lastBroadcast = 0, reportedGoals = -1;
      var matchStartAt = 0;

      /* ---- Anzeige ---- */
      var myScEl = null, opScEl = null, myScShown = -1, opScShown = -1;
      var cue = { sb: 0, sTop: 0, vx: 0, vy: 0, ready: false };
      var lastHitSnd = 0, lastCd = -1;
      var flashAt = -9999, flashMine = false, banner = '';

      /* ================= Aufräumen ================= */
      function addL(t, ty, fn, opts) { t.addEventListener(ty, fn, opts); listeners.push({ t: t, ty: ty, fn: fn, opts: opts }); }
      function removeAllListeners() {
        listeners.forEach(function (l) { try { l.t.removeEventListener(l.ty, l.fn, l.opts); } catch (e) {} });
        listeners = [];
      }
      function addStop(fn) { if (fn) stops.push(fn); }
      function stopHelpers() { stops.forEach(function (f) { try { f(); } catch (e) {} }); stops = []; }
      function after(ms, fn) { var t = setTimeout(function () { if (!dead) fn(); }, ms); pending.push(t); return t; }
      function clearPending() { pending.forEach(clearTimeout); pending = []; }
      function stopLoop() { if (raf) { cancelAnimationFrame(raf); raf = null; } }
      function cleanup() {
        dead = true; ended = true;
        stopLoop(); clearPending(); stopHelpers(); removeAllListeners();
      }

      /* ================= Start ================= */
      if (isMulti) startMulti(); else chooseDiff();
      return { cleanup: cleanup };

      /* ================= SOLO: Schwierigkeit wählen ================= */
      function chooseDiff() {
        stopLoop(); clearPending(); removeAllListeners();
        ended = false;
        var cards = DIFFS.map(function (d) {
          var sel = (d.key === diff.key);
          return el('button', {
            class: 'btn ' + (sel ? 'btn-primary' : 'btn-ghost') + ' ahk-diff', type: 'button',
            onclick: function () {
              diff = d;
              if (App.Storage) App.Storage.set('ahk_diff', d.key);
              if (App.Audio) App.Audio.sfx('select');
              playSolo();
            }
          }, [
            el('span', { class: 'ahk-diff-ic' }, [d.icon]),
            el('span', { class: 'ahk-diff-nm' }, [d.name]),
            el('span', { class: 'ahk-diff-sub' }, [d.sub])
          ]);
        });
        root.innerHTML = '';
        root.appendChild(el('div', { class: 'glass ahk-pick' }, [
          el('div', { class: 'ahk-pick-emoji' }, ['🏒']),
          el('h3', { class: 'neon' }, ['Gegen den Bot']),
          el('p', { class: 'hint-text' }, ['Wie stark soll dein Gegner sein? Erster mit 7 Toren gewinnt.']),
          el('div', { class: 'ahk-pick-grid' }, cards),
          el('p', { class: 'hint-text ahk-pick-foot' }, ['Je härter die Stufe, desto mehr Punkte gibt es.'])
        ]));
      }

      /* ================= SOLO: Match ================= */
      function playSolo() {
        stopLoop(); clearPending(); removeAllListeners();
        ended = false;
        myIsBottom = true; flip = false;
        var refs = buildStage('Bot ' + diff.icon, (ctx.me && ctx.me.name) ? ctx.me.name : 'Du', diff.name);
        setupCanvas(refs.canvas);
        attachInput(refs.canvas);

        mBot = newMallet(W / 2, H - 120); mTop = newMallet(W / 2, diff.defY);
        mine = mBot; foe = mTop;
        myTx = mBot.x; myTy = mBot.y;
        st = newState(ctx.me.id, 'bot');
        matchStartAt = Date.now();
        resetView();
        faceoff(st, Math.random() < 0.5 ? 1 : -1, Date.now(), 'ANSTOSS');
        botThinkAt = 0; botErr = 0; botAim = 0; prevVy = 0; botTgt = null;
        last = Date.now();
        raf = requestAnimationFrame(frame);
      }

      /* ================= MULTI ================= */
      function startMulti() {
        var proceeded = false;
        function maybeStart() {
          if (proceeded || dead) return;
          if (ctx.room.players().length >= 2) {
            proceeded = true;
            var snap = ctx.room.snapshot() || {};
            var startAt = (snap.round && snap.round.startAt) || (ctx.room.now() + 3000);
            addStop(App.MG.countdown(root, startAt, function () { playMulti(startAt); }, ctx.room.now));
          } else showWaiting();
        }
        var ph = function () { maybeStart(); };
        ctx.room.on('players', ph);
        addStop(function () { ctx.room.off('players', ph); });
        maybeStart();
      }

      function playMulti(startAt) {
        var ps = ctx.room.players();
        var botId = ps[0] ? ps[0].id : 'p0';        // kanonisch unten
        var topId = ps[1] ? ps[1].id : 'p1';        // kanonisch oben
        myIsBottom = (ctx.me.id === botId);
        flip = !myIsBottom;
        var oppName = (myIsBottom ? (ps[1] ? ps[1].name : 'Gegner') : (ps[0] ? ps[0].name : 'Gegner'));
        var myName = (ctx.me && ctx.me.name) ? ctx.me.name : 'Du';
        var refs = buildStage(oppName, myName, null);
        setupCanvas(refs.canvas);
        attachInput(refs.canvas);

        mBot = newMallet(W / 2, H - 120); mTop = newMallet(W / 2, 120);
        mine = myIsBottom ? mBot : mTop;
        foe = myIsBottom ? mTop : mBot;
        myTx = mine.x; myTy = mine.y;
        oppTgt = { x: foe.x, y: foe.y }; oppShown = { x: foe.x, y: foe.y };

        st = newState(botId, topId);
        matchStartAt = startAt;
        resetView();
        /* Erster Anstoß: beide rechnen dieselbe Startzeit aus (startAt ist synchron). */
        st.px = W / 2; st.py = H / 2; st.vx = 0; st.vy = 0;
        st.frozen = true; st.faceAt = startAt + 1200; st.serveDir = 1;
        banner = 'ANSTOSS';
        rPuck.x = st.px; rPuck.y = st.py;

        var snap = ctx.room.snapshot();
        netShared = (snap && snap.shared) || null;
        sharedHandler = function (sh) { onShared(sh); };
        ctx.room.on('shared', sharedHandler);
        addStop(function () { ctx.room.off('shared', sharedHandler); });

        lastReport = 0; lastBroadcast = 0; reportedGoals = -1;
        try { ctx.room.reportScore(0); } catch (e) {}
        last = ctx.room.now();
        raf = requestAnimationFrame(frame);
      }

      /* Netz-Zustand übernehmen. Läuft sehr oft (Heartbeat) -> rein idempotent, baut nichts neu auf. */
      function onShared(sh) {
        if (!sh || dead || !st) return;
        netShared = sh;
        if (sh.pk) netPuck = { x: sh.pk.x, y: sh.pk.y, vx: sh.pk.vx, vy: sh.pk.vy, t: (typeof sh.t === 'number' ? sh.t : ctx.room.now()) };
        if (!ctx.room.isHost()) {
          /* Zustand mitführen, damit ich nahtlos weiterrechnen kann, falls ich Host werde. */
          if (sh.pk) { st.px = sh.pk.x; st.py = sh.pk.y; st.vx = sh.pk.vx; st.vy = sh.pk.vy; }
          if (typeof sh.sb === 'number') st.sBot = sh.sb;
          if (typeof sh.stp === 'number') st.sTop = sh.stp;
          if (typeof sh.fa === 'number') st.faceAt = sh.fa;
          st.frozen = !!sh.fz;
          st.golden = !!sh.gd;
          if (sh.w) st.winner = sh.w;
          var om = myIsBottom ? sh.mt : sh.mb;      // Schläger des Gegners
          if (om && typeof om.x === 'number') { oppTgt.x = om.x; oppTgt.y = om.y; }
        }
      }

      /* ================= Frame-Loop ================= */
      function frame() {
        if (dead || ended) { raf = null; return; }
        var now = timeNow();
        var dt = (now - last) / 1000;
        if (dt < 0) dt = 0;
        if (dt > 0.05) dt = 0.05;                    // Tab-Wechsel: kein Riesensprung
        last = now;

        /* Eigener Schläger folgt dem Zeiger (in meiner Hälfte). */
        setMalletPos(mine, clampX(myTx), clampHalfY(myTy, mine === mBot), dt);

        var hostSide = !isMulti || !!ctx.room.isHost();

        if (isMulti) {
          if (now - lastReport >= REPORT_MS) {
            lastReport = now;
            try { ctx.room.reportState({ mx: Math.round(mine.x), my: Math.round(mine.y) }); } catch (e) {}
          }
        }

        if (hostSide) {
          if (isMulti) {
            var ps = ctx.room.players();
            if (ps.length < 2 && !st.winner) st.winner = ctx.me.id;   // Gegner weg -> Sieg
            var opp = null, oid = myIsBottom ? st.topId : st.botId;
            for (var i = 0; i < ps.length; i++) if (ps[i].id === oid) { opp = ps[i]; break; }
            if (opp && opp.state && typeof opp.state.mx === 'number') { oppTgt.x = opp.state.mx; oppTgt.y = opp.state.my; }
            /* Gegner weich nachziehen -> Physik und Bild sehen dasselbe. */
            var a = 1 - Math.exp(-18 * dt);
            oppShown.x += (oppTgt.x - oppShown.x) * a;
            oppShown.y += (oppTgt.y - oppShown.y) * a;
            setMalletPos(foe, clampX(oppShown.x), clampHalfY(oppShown.y, foe === mBot), dt);
          } else {
            updateBot(dt, now);
          }
          stepPhysics(st, dt, now);
          checkFallback(now);
          if (isMulti && (now - lastBroadcast >= BROADCAST_MS || st.winner)) {
            lastBroadcast = now;
            try {
              ctx.room.setShared({
                pk: { x: Math.round(st.px * 10) / 10, y: Math.round(st.py * 10) / 10, vx: Math.round(st.vx), vy: Math.round(st.vy) },
                mb: { x: Math.round(mBot.x), y: Math.round(mBot.y) },
                mt: { x: Math.round(mTop.x), y: Math.round(mTop.y) },
                sb: st.sBot, stp: st.sTop, fa: st.faceAt, fz: !!st.frozen, gd: !!st.golden,
                w: st.winner || null, t: now
              });
            } catch (e) {}
          }
          rPuck.x = st.px; rPuck.y = st.py;
        } else {
          /* Gast: Puck aus dem Netz extrapolieren + weich hinziehen (Lag-Ausgleich). */
          var tgt = predictPuck(now);
          var d = Math.abs(tgt.x - rPuck.x) + Math.abs(tgt.y - rPuck.y);
          if (d > 220) { rPuck.x = tgt.x; rPuck.y = tgt.y; }        // großer Sprung (Tor/Anstoß) -> hart setzen
          else {
            var k = 1 - Math.exp(-14 * dt);
            rPuck.x += (tgt.x - rPuck.x) * k;
            rPuck.y += (tgt.y - rPuck.y) * k;
          }
          var b = 1 - Math.exp(-16 * dt);
          oppShown.x += (oppTgt.x - oppShown.x) * b;
          oppShown.y += (oppTgt.y - oppShown.y) * b;
          setMalletPos(foe, clampX(oppShown.x), clampHalfY(oppShown.y, foe === mBot), dt);
        }

        var myScore = myIsBottom ? st.sBot : st.sTop;
        var opScore = myIsBottom ? st.sTop : st.sBot;
        emitCues(now, hostSide);
        updateHead(myScore, opScore);

        trail.push({ x: dispX(rPuck.x), y: dispY(rPuck.y) });
        if (trail.length > 13) trail.shift();
        drawScene(now, myScore, opScore);

        if (st.winner) return finishMatch(st.winner);
        raf = requestAnimationFrame(frame);
      }

      /* ================= Physik ================= */
      function newState(botId, topId) {
        return {
          px: W / 2, py: H / 2, vx: 0, vy: 0,
          sBot: 0, sTop: 0, frozen: true, faceAt: 0, serveDir: 1,
          botId: botId, topId: topId, winner: null, golden: false
        };
      }
      function newMallet(x, y) { return { x: x, y: y, vx: 0, vy: 0 }; }
      function clampX(x) { return Math.max(MR, Math.min(W - MR, x)); }
      function clampHalfY(y, bottom) {
        return bottom ? Math.max(H / 2 + MR, Math.min(H - MR, y))
                      : Math.max(MR, Math.min(H / 2 - MR, y));
      }
      /* Position setzen + Geschwindigkeit aus dem echten Zeitschritt ableiten (geglättet, gedeckelt). */
      function setMalletPos(m, x, y, dt) {
        if (dt > 0.0005) {
          var rvx = (x - m.x) / dt, rvy = (y - m.y) / dt;
          var sp = Math.sqrt(rvx * rvx + rvy * rvy);
          if (sp > MAX_MALLET_V) { rvx = rvx / sp * MAX_MALLET_V; rvy = rvy / sp * MAX_MALLET_V; }
          m.vx = m.vx * 0.35 + rvx * 0.65;
          m.vy = m.vy * 0.35 + rvy * 0.65;
        }
        m.x = x; m.y = y;
      }
      function faceoff(s, dir, now, text) {
        s.px = W / 2; s.py = H / 2; s.vx = 0; s.vy = 0;
        s.frozen = true; s.faceAt = now + FACEOFF_MS; s.serveDir = dir;
        banner = text || banner;
        rPuck.x = s.px; rPuck.y = s.py; trail = [];
      }
      function parkPuck(s) { s.px = W / 2; s.py = H / 2; s.vx = 0; s.vy = 0; s.frozen = true; s.faceAt = 0; }
      function clampSpeed(s) {
        var sp = Math.sqrt(s.vx * s.vx + s.vy * s.vy);
        if (sp > MAX_PUCK) { s.vx = s.vx / sp * MAX_PUCK; s.vy = s.vy / sp * MAX_PUCK; }
      }
      function stepPhysics(s, dt, now) {
        if (s.winner) return;
        if (s.frozen) {
          if (now < s.faceAt) return;
          s.frozen = false;
          s.vy = s.serveDir * SERVE_SPEED;
          s.vx = (Math.random() * 2 - 1) * 70;
          banner = '';
        }
        var rest = dt;
        while (rest > 0.00001) {
          var h = rest > SUB ? SUB : rest;
          rest -= h;
          if (substep(s, h, now)) break;             // Tor -> Rest des Frames verwerfen
        }
      }
      /* Ein Teilschritt. Gibt true zurück, wenn ein Tor gefallen ist. */
      function substep(s, h, now) {
        s.px += s.vx * h; s.py += s.vy * h;
        var f = Math.pow(FRICTION, h);
        s.vx *= f; s.vy *= f;
        if (Math.abs(s.vx) < 3) s.vx = 0;
        if (Math.abs(s.vy) < 3) s.vy = 0;

        collideMallet(s, mTop, now);
        collideMallet(s, mBot, now);

        /* Seitenbanden */
        if (s.px < PR) { s.px = PR; s.vx = Math.abs(s.vx) * WALL_E; wallSnd(now); }
        else if (s.px > W - PR) { s.px = W - PR; s.vx = -Math.abs(s.vx) * WALL_E; wallSnd(now); }

        /* Pfosten */
        collidePost(s, W / 2 - GOAL_HALF, 0, now); collidePost(s, W / 2 + GOAL_HALF, 0, now);
        collidePost(s, W / 2 - GOAL_HALF, H, now); collidePost(s, W / 2 + GOAL_HALF, H, now);

        /* Grundlinien: außerhalb des Tormauls ist Bande */
        var inMouth = Math.abs(s.px - W / 2) <= GOAL_HALF - 2;
        if (s.py < PR && !inMouth) { s.py = PR; s.vy = Math.abs(s.vy) * WALL_E; wallSnd(now); }
        else if (s.py > H - PR && !inMouth) { s.py = H - PR; s.vy = -Math.abs(s.vy) * WALL_E; wallSnd(now); }

        /* Tore */
        if (s.py < 0) { s.sBot++; scored(s, true, now); return true; }
        if (s.py > H) { s.sTop++; scored(s, false, now); return true; }
        return false;
      }
      function scored(s, byBottom, now) {
        if (byBottom) {
          if (s.golden || s.sBot >= WIN_GOALS) { s.winner = s.botId; parkPuck(s); return; }
          faceoff(s, -1, now, '');                   // Anstoß rollt zum Kassierer (oben)
        } else {
          if (s.golden || s.sTop >= WIN_GOALS) { s.winner = s.topId; parkPuck(s); return; }
          faceoff(s, 1, now, '');
        }
      }
      function collidePost(s, cx, cy, now) {
        var dx = s.px - cx, dy = s.py - cy;
        var d = Math.sqrt(dx * dx + dy * dy), min = POST_R + PR;
        if (d >= min || d < 0.0001) return;
        var nx = dx / d, ny = dy / d;
        s.px = cx + nx * min; s.py = cy + ny * min;
        var vn = s.vx * nx + s.vy * ny;
        if (vn < 0) {
          s.vx -= (1 + WALL_E) * vn * nx; s.vy -= (1 + WALL_E) * vn * ny;
          if (App.Audio && now - lastHitSnd > 60) { lastHitSnd = now; App.Audio.blip(1150, 0.05, { type: 'square', peak: 0.05 }); }
        }
      }
      function collideMallet(s, m, now) {
        var dx = s.px - m.x, dy = s.py - m.y;
        var d = Math.sqrt(dx * dx + dy * dy), min = PR + MR;
        if (d >= min) return;
        if (d < 0.0001) { dx = 0; dy = (m.y > H / 2 ? -1 : 1); d = 1; }
        var nx = dx / d, ny = dy / d;
        s.px = m.x + nx * min; s.py = m.y + ny * min;   // aus dem Schläger herausdrücken
        var hit = false;
        var vn = (s.vx - m.vx) * nx + (s.vy - m.vy) * ny;   // Annäherung entlang der Normalen
        if (vn < 0) { s.vx -= (1 + PUCK_E) * vn * nx; s.vy -= (1 + PUCK_E) * vn * ny; hit = true; }
        var mn = m.vx * nx + m.vy * ny;                     // Impuls aus der Schlägerbewegung
        if (mn > 0) { s.vx += nx * mn * 0.45; s.vy += ny * mn * 0.45; hit = true; }
        if (!hit) return;
        var sp = Math.sqrt(s.vx * s.vx + s.vy * s.vy);
        if (sp < MIN_HIT) {
          if (sp < 1) { s.vx = nx * MIN_HIT; s.vy = ny * MIN_HIT; }
          else { s.vx = s.vx / sp * MIN_HIT; s.vy = s.vy / sp * MIN_HIT; }
        }
        clampSpeed(s);
        if (App.Audio && now - lastHitSnd > 55) {
          lastHitSnd = now;
          var hard = Math.sqrt(s.vx * s.vx + s.vy * s.vy) > 700;
          if (hard) App.Audio.sfx('hit'); else App.Audio.blip(420, 0.05, { type: 'square', peak: 0.05 });
        }
      }
      /* Notbremse nach MATCH_TIME. Wichtig: bei Gleichstand darf das Match nicht
         einfach weiterlaufen (sonst endet es nie) -> Golden Goal, das nächste Tor
         entscheidet. Trifft auch dann niemand, endet es als Unentschieden. */
      function checkFallback(now) {
        if (st.winner) return;
        var t = (now - matchStartAt) / 1000;
        if (t <= MATCH_TIME) return;
        if (st.sBot !== st.sTop) {                   // Vorsprung -> sofort entschieden
          st.winner = st.sBot > st.sTop ? st.botId : st.topId;
          parkPuck(st); return;
        }
        st.golden = true;                            // Gleichstand -> nächstes Tor gewinnt
        if (t > MATCH_TIME + GOLDEN_MAX) { st.winner = DRAW; parkPuck(st); }
      }
      /* Gast: letzte bekannte Puck-Bewegung geradlinig fortschreiben (x an den Banden gespiegelt). */
      function predictPuck(now) {
        if (!netPuck) return { x: st.px, y: st.py };
        var e = (now - netPuck.t) / 1000;
        if (e < 0) e = 0; if (e > 0.5) e = 0.5;
        if (st.frozen) return { x: netPuck.x, y: netPuck.y };
        var x = netPuck.x + netPuck.vx * e, y = netPuck.y + netPuck.vy * e;
        var span = W - 2 * PR;
        if (span > 0) {
          var xx = ((((x - PR) % (2 * span)) + 2 * span) % (2 * span));
          if (xx > span) xx = 2 * span - xx;
          x = xx + PR;
        }
        if (y < -PR) y = -PR; if (y > H + PR) y = H + PR;
        return { x: x, y: y };
      }

      /* ================= Bot-KI ================= */
      function updateBot(dt, now) {
        /* Fehler-Offset neu würfeln, sobald der Puck Richtung Bot startet -> schlagbar bleiben. */
        if (st.vy < -15 && prevVy >= -15) {
          botErr = (Math.random() * 2 - 1) * diff.err;
          botAim = (Math.random() * 2 - 1) * (GOAL_HALF * 0.7);
        }
        prevVy = st.vy;
        if (!botTgt || now - botThinkAt >= diff.lag * 1000) { botThinkAt = now; botTgt = botTarget(); }
        var dx = botTgt.x - mTop.x, dy = botTgt.y - mTop.y;
        var dist = Math.sqrt(dx * dx + dy * dy), step = diff.speed * dt;
        var nx = mTop.x, ny = mTop.y;
        if (dist <= step || dist < 0.001) { nx = botTgt.x; ny = botTgt.y; }
        else { nx += dx / dist * step; ny += dy / dist * step; }
        setMalletPos(mTop, clampX(nx), clampHalfY(ny, false), dt);
      }
      function botTarget() {
        var toward = st.vy < -15;                       // Puck kommt zum Bot
        var inMyHalf = st.py < H / 2 - 6;
        var slow = (Math.abs(st.vx) + Math.abs(st.vy)) < 300;

        /* Angriff: hinter den Puck stellen und Richtung gegnerisches Tor (unten) durchziehen. */
        if (inMyHalf && (slow || !toward)) {
          var ax = W / 2 + botAim, ay = H + 40;         // Zielpunkt im Tor unten
          var gx = st.px - ax, gy = st.py - ay;
          var gl = Math.sqrt(gx * gx + gy * gy) || 1;
          var bx = st.px + gx / gl * (PR + MR) * 0.92;
          var by = st.py + gy / gl * (PR + MR) * 0.92;
          if (by <= H / 2 - MR) {                       // Schlagpunkt erreichbar?
            var behind = Math.abs(bx - mTop.x) + Math.abs(by - mTop.y);
            if (behind < 16) return { x: st.px - gx / gl * 40, y: Math.min(H / 2 - MR, st.py - gy / gl * 40) };
            return { x: clampX(bx), y: clampHalfY(by, false) };
          }
        }
        /* Verteidigung: Flugbahn vorhersagen (Bandenspiegelung) und die Linie halten. */
        if (toward) {
          if (st.py < diff.defY + 40) return { x: clampX(st.px + botErr * 0.3), y: clampHalfY(st.py - 4, false) };
          return { x: clampX(predictX(diff.defY) + botErr), y: diff.defY };
        }
        /* Ruhestellung: leicht mit dem Puck mitwandern. */
        return { x: clampX(W / 2 + (st.px - W / 2) * 0.35), y: diff.defY + 8 };
      }
      /* x-Position, an der der Puck die Linie lineY erreicht (Reibung ändert die Bahn nicht, nur das Tempo). */
      function predictX(lineY) {
        if (st.vy >= -1) return st.px;
        var t = (lineY - st.py) / st.vy;
        if (t < 0) return st.px;
        var x = st.px + st.vx * t;
        var span = W - 2 * PR;
        if (span <= 0) return st.px;
        var xx = ((((x - PR) % (2 * span)) + 2 * span) % (2 * span));
        if (xx > span) xx = 2 * span - xx;
        return xx + PR;
      }

      /* ================= Ton & Kopfzeile ================= */
      function wallSnd(now) {
        if (App.Audio && now - lastHitSnd > 70) { lastHitSnd = now; App.Audio.blip(230, 0.04, { type: 'triangle', peak: 0.04 }); }
      }
      /* Tor-Sound/Blitz für alle aus dem Punktestand ableiten; beim Gast zusätzlich
         Abpraller aus Vorzeichenwechseln der Puck-Geschwindigkeit. Alles idempotent. */
      function emitCues(now, hostSide) {
        var pvx = netPuck && !hostSide ? netPuck.vx : st.vx;
        var pvy = netPuck && !hostSide ? netPuck.vy : st.vy;
        if (!cue.ready) { cue.sb = st.sBot; cue.sTop = st.sTop; cue.vx = pvx; cue.vy = pvy; cue.ready = true; return; }
        if (st.sBot !== cue.sb || st.sTop !== cue.sTop) {
          var mineGoal = myIsBottom ? (st.sBot !== cue.sb) : (st.sTop !== cue.sTop);
          flashAt = now; flashMine = mineGoal; banner = mineGoal ? 'TOR!' : 'GEGENTOR';
          if (App.Audio) App.Audio.sfx(mineGoal ? 'point' : 'error');
          lastCd = -1;
        } else if (!hostSide) {
          var flipX = (pvx !== 0 && cue.vx !== 0 && (pvx < 0) !== (cue.vx < 0));
          var flipY = (pvy !== 0 && cue.vy !== 0 && (pvy < 0) !== (cue.vy < 0));
          if ((flipX || flipY) && App.Audio && now - lastHitSnd > 60) {
            lastHitSnd = now; App.Audio.blip(420, 0.05, { type: 'square', peak: 0.05 });
          }
        }
        cue.sb = st.sBot; cue.sTop = st.sTop; cue.vx = pvx; cue.vy = pvy;
      }
      function updateHead(my, op) {
        if (my !== myScShown && myScEl) { myScEl.textContent = String(my); bump(myScEl); myScShown = my; }
        if (op !== opScShown && opScEl) { opScEl.textContent = String(op); bump(opScEl); opScShown = op; }
        if (isMulti && my !== reportedGoals) { reportedGoals = my; try { ctx.room.reportScore(my); } catch (e) {} }
      }
      function bump(node) { node.classList.remove('ahk-bump'); void node.offsetWidth; node.classList.add('ahk-bump'); }
      function resetView() {
        trail = []; myScShown = -1; opScShown = -1; lastCd = -1;
        cue = { sb: 0, sTop: 0, vx: 0, vy: 0, ready: false };
        flashAt = -9999; banner = 'ANSTOSS';
        rPuck.x = W / 2; rPuck.y = H / 2;
      }

      /* ================= Zeichnen ================= */
      function setupCanvas(canvas) { g = canvas.getContext('2d'); }
      function dispX(x) { return flip ? W - x : x; }
      function dispY(y) { return flip ? H - y : y; }
      function roundRect(c, x, y, w, h, r) {
        r = Math.min(r, w / 2, h / 2);
        c.beginPath(); c.moveTo(x + r, y);
        c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r);
        c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r);
        c.closePath();
      }
      function drawScene(now, myScore, opScore) {
        if (!g) return;
        g.clearRect(0, 0, W, H);
        var grd = g.createLinearGradient(0, 0, 0, H);
        grd.addColorStop(0, '#06170e'); grd.addColorStop(0.5, '#04120a'); grd.addColorStop(1, '#06170e');
        g.fillStyle = grd; g.fillRect(0, 0, W, H);

        /* Große, blasse Torzahlen in den Hälften */
        g.save();
        g.font = '900 190px "Segoe UI",system-ui,Roboto,Arial,sans-serif';
        g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillStyle = 'rgba(51,230,208,0.07)'; g.fillText(String(opScore), W / 2, H * 0.27);
        g.fillStyle = 'rgba(57,255,20,0.07)'; g.fillText(String(myScore), W / 2, H * 0.73);
        g.restore();

        /* Mittellinie + Kreis */
        g.save();
        g.strokeStyle = 'rgba(157,255,122,0.32)'; g.lineWidth = 3; g.setLineDash([14, 16]);
        g.beginPath(); g.moveTo(10, H / 2); g.lineTo(W - 10, H / 2); g.stroke();
        g.setLineDash([]);
        g.strokeStyle = 'rgba(157,255,122,0.22)'; g.lineWidth = 2;
        g.beginPath(); g.arc(W / 2, H / 2, 64, 0, Math.PI * 2); g.stroke();
        g.beginPath(); g.arc(W / 2, H / 2, 5, 0, Math.PI * 2);
        g.fillStyle = 'rgba(157,255,122,0.35)'; g.fill();
        g.restore();

        /* Torraum-Bögen */
        drawCrease(0, 'rgba(51,230,208,0.20)');
        drawCrease(H, 'rgba(57,255,20,0.20)');

        /* Tore (oben = Gegner/Aqua, unten = ich/Neon) */
        drawGoal(0, '#33e6d0', 'rgba(51,230,208,');
        drawGoal(H, '#39ff14', 'rgba(57,255,20,');

        /* Rahmen */
        g.save(); g.strokeStyle = 'rgba(57,255,20,0.22)'; g.lineWidth = 4;
        roundRect(g, 5, 5, W - 10, H - 10, 20); g.stroke(); g.restore();

        /* Puck-Spur */
        g.save();
        for (var i = 0; i < trail.length; i++) {
          var tp = trail[i], a = (i + 1) / trail.length;
          g.fillStyle = 'rgba(190,255,160,' + (a * 0.22).toFixed(3) + ')';
          g.beginPath(); g.arc(tp.x, tp.y, PR * (0.35 + a * 0.62), 0, Math.PI * 2); g.fill();
        }
        g.restore();

        drawPuck(dispX(rPuck.x), dispY(rPuck.y));
        drawMallet(dispX(foe.x), dispY(foe.y), '#33e6d0', 'rgba(51,230,208,');
        drawMallet(dispX(mine.x), dispY(mine.y), '#39ff14', 'rgba(57,255,20,');

        /* Tor-Blitz */
        var fe = (now - flashAt) / 420;
        if (fe >= 0 && fe < 1) {
          g.save();
          var fg = g.createRadialGradient(W / 2, H / 2, 40, W / 2, H / 2, H * 0.62);
          var col = flashMine ? '57,255,20' : '255,77,109';
          fg.addColorStop(0, 'rgba(' + col + ',' + (0.34 * (1 - fe)).toFixed(3) + ')');
          fg.addColorStop(1, 'rgba(' + col + ',0)');
          g.fillStyle = fg; g.fillRect(0, 0, W, H); g.restore();
        }

        /* Golden Goal (nach Ablauf der Spielzeit bei Gleichstand): das nächste Tor gewinnt */
        if (st.golden && !st.winner && !st.frozen) {
          g.save();
          g.textAlign = 'center'; g.textBaseline = 'middle';
          g.font = '900 20px "Segoe UI",system-ui,Roboto,Arial,sans-serif';
          var pulse = 0.55 + 0.45 * Math.abs(Math.sin(now / 380));
          g.shadowColor = 'rgba(255,210,63,0.85)'; g.shadowBlur = 18;
          g.fillStyle = 'rgba(255,210,63,' + pulse.toFixed(2) + ')';
          g.fillText('⚡ GOLDENES TOR', W / 2, H / 2 - 34);
          g.restore();
        }

        /* Anstoß-Countdown + Banner */
        if (st.frozen && !st.winner) {
          var leftMs = st.faceAt - now;
          var cd = Math.ceil(leftMs / 1000);
          if (cd > 0) {
            if (cd !== lastCd) { lastCd = cd; if (App.Audio) App.Audio.sfx('tick'); }
            g.save();
            g.textAlign = 'center'; g.textBaseline = 'middle';
            if (banner) {
              g.font = '900 40px "Segoe UI",system-ui,Roboto,Arial,sans-serif';
              g.shadowBlur = 18;
              var bc = (banner === 'GEGENTOR') ? '#ff4d6d' : '#39ff14';
              g.shadowColor = bc; g.fillStyle = bc;
              g.fillText(banner, W / 2, H / 2 - 86);
            }
            g.font = '900 110px "Segoe UI",system-ui,Roboto,Arial,sans-serif';
            g.shadowColor = 'rgba(51,230,208,0.75)'; g.shadowBlur = 26;
            g.fillStyle = 'rgba(234,255,224,0.95)';
            g.fillText(String(cd), W / 2, H / 2 + 8);
            g.restore();
          }
        }
      }
      function drawCrease(lineY, color) {
        g.save();
        g.strokeStyle = color; g.lineWidth = 2;
        g.beginPath();
        g.arc(W / 2, lineY, 118, lineY === 0 ? 0 : Math.PI, lineY === 0 ? Math.PI : Math.PI * 2);
        g.stroke(); g.restore();
      }
      function drawGoal(lineY, color, rgb) {
        var top = (lineY === 0);
        g.save();
        /* Netz-Tasche */
        var gy = top ? 0 : H - 26;
        var gg = g.createLinearGradient(0, top ? 0 : H, 0, top ? 26 : H - 26);
        gg.addColorStop(0, rgb + '0.30)'); gg.addColorStop(1, rgb + '0.02)');
        g.fillStyle = gg;
        g.fillRect(W / 2 - GOAL_HALF, gy, GOAL_HALF * 2, 26);
        /* Netz-Streben */
        g.strokeStyle = rgb + '0.30)'; g.lineWidth = 1;
        for (var x = W / 2 - GOAL_HALF + 8; x < W / 2 + GOAL_HALF; x += 14) {
          g.beginPath(); g.moveTo(x, gy); g.lineTo(x, gy + 26); g.stroke();
        }
        /* Torlinie */
        g.strokeStyle = color; g.lineWidth = 4;
        g.shadowColor = rgb + '0.9)'; g.shadowBlur = 16;
        g.beginPath();
        g.moveTo(W / 2 - GOAL_HALF, lineY === 0 ? 2 : H - 2);
        g.lineTo(W / 2 + GOAL_HALF, lineY === 0 ? 2 : H - 2);
        g.stroke();
        /* Pfosten */
        g.fillStyle = '#eaffe0'; g.shadowBlur = 14;
        g.beginPath(); g.arc(W / 2 - GOAL_HALF, lineY, POST_R, 0, Math.PI * 2); g.fill();
        g.beginPath(); g.arc(W / 2 + GOAL_HALF, lineY, POST_R, 0, Math.PI * 2); g.fill();
        g.restore();
      }
      function drawPuck(x, y) {
        g.save();
        g.shadowColor = 'rgba(234,255,224,0.9)'; g.shadowBlur = 22;
        g.fillStyle = '#0b1f13';
        g.beginPath(); g.arc(x, y, PR, 0, Math.PI * 2); g.fill();
        g.shadowBlur = 0;
        g.strokeStyle = '#eaffe0'; g.lineWidth = 3;
        g.beginPath(); g.arc(x, y, PR - 1.5, 0, Math.PI * 2); g.stroke();
        g.strokeStyle = 'rgba(234,255,224,0.45)'; g.lineWidth = 1.5;
        g.beginPath(); g.arc(x, y, PR - 6, 0, Math.PI * 2); g.stroke();
        g.restore();
      }
      function drawMallet(x, y, color, rgb) {
        g.save();
        g.shadowColor = rgb + '0.75)'; g.shadowBlur = 20;
        g.fillStyle = rgb + '0.16)';
        g.beginPath(); g.arc(x, y, MR, 0, Math.PI * 2); g.fill();
        g.shadowBlur = 10;
        g.strokeStyle = color; g.lineWidth = 4;
        g.beginPath(); g.arc(x, y, MR - 2, 0, Math.PI * 2); g.stroke();
        g.shadowBlur = 0;
        g.strokeStyle = rgb + '0.5)'; g.lineWidth = 2;
        g.beginPath(); g.arc(x, y, MR - 11, 0, Math.PI * 2); g.stroke();
        g.fillStyle = color;
        g.beginPath(); g.arc(x, y, MR - 22, 0, Math.PI * 2); g.fill();
        g.restore();
      }

      /* ================= Eingabe ================= */
      function attachInput(canvas) {
        removeAllListeners();
        var onMove = function (e) {
          var r = canvas.getBoundingClientRect();
          if (!r.width || !r.height) return;
          var x = (e.clientX - r.left) / r.width * W;
          var y = (e.clientY - r.top) / r.height * H;
          if (flip) { x = W - x; y = H - y; }          // Ansicht ist gedreht -> zurückrechnen
          myTx = x; myTy = y;
        };
        var onDown = function (e) {
          if (e.preventDefault) e.preventDefault();
          if (canvas.setPointerCapture && e.pointerId !== undefined) {
            try { canvas.setPointerCapture(e.pointerId); } catch (err) {}
          }
          if (App.Audio) App.Audio.sfx('tick');
          onMove(e);
        };
        addL(canvas, 'pointerdown', onDown);
        addL(canvas, 'pointermove', onMove);
      }

      /* ================= UI ================= */
      function buildStage(oppName, myName, diffName) {
        opScEl = el('div', { class: 'ahk-sc ahk-sc-opp' }, ['0']);
        myScEl = el('div', { class: 'ahk-sc ahk-sc-me' }, ['0']);
        var head = el('div', { class: 'ahk-head glass' }, [
          el('div', { class: 'ahk-side' }, [el('div', { class: 'ahk-nm ahk-nm-opp' }, [oppName]), opScEl]),
          el('div', { class: 'ahk-vs' }, [
            el('div', { class: 'ahk-vs-l' }, ['Tore']),
            el('div', { class: 'ahk-vs-n' }, ['bis ' + WIN_GOALS])
          ]),
          el('div', { class: 'ahk-side ahk-side-me' }, [el('div', { class: 'ahk-nm ahk-nm-me' }, [myName + ' (du)']), myScEl])
        ]);
        var canvas = el('canvas', { class: 'ahk-canvas', width: W, height: H });
        var hint = el('div', { class: 'ahk-hint hint-text' }, [
          'Schläger mit Finger/Maus in deiner Hälfte ziehen · schnell zuschlagen = harter Schuss · Puck ins obere Tor'
        ]);
        var kids = [head, el('div', { class: 'ahk-stage' }, [canvas]), hint];
        if (diffName) kids.push(el('div', { class: 'ahk-diffrow' }, [el('span', { class: 'chip' }, ['🤖 Bot: ' + diffName])]));
        root.innerHTML = '';
        root.appendChild(el('div', { class: 'ahk-wrap' }, kids));
        return { canvas: canvas };
      }
      function showWaiting() {
        root.innerHTML = '';
        root.appendChild(el('div', { class: 'glass ahk-wait' }, [
          el('div', { class: 'ahk-wait-emoji' }, ['🏒']),
          el('h3', { class: 'neon' }, ['Airhockey']),
          el('p', { class: 'hint-text' }, ['Warte auf den zweiten Spieler …'])
        ]));
      }

      /* ================= Ende ================= */
      function finishMatch(winnerId) {
        if (ended || dead) return;
        ended = true;
        stopLoop(); removeAllListeners();
        var isDraw = (winnerId === DRAW);
        var iWon = !isDraw && (winnerId === ctx.me.id);
        if (App.Audio) App.Audio.sfx(isDraw ? 'info' : (iWon ? 'win' : 'lose'));
        if (iWon && App.Scores) { try { App.Scores.winCurrent(); } catch (e) {} }
        var myGoals = myIsBottom ? st.sBot : st.sTop;
        var opGoals = myIsBottom ? st.sTop : st.sBot;

        if (isMulti) {
          try { ctx.room.reportScore(myGoals); } catch (e) {}
          after(1100, function () {
            stopHelpers();
            App.MG.endScreen(root, { players: ctx.room.players(), meId: ctx.me.id, onExit: ctx.onExit });
          });
        } else {
          var secs = Math.max(1, Math.round((Date.now() - matchStartAt) / 1000));
          var pts = myGoals * 100
            + (iWon ? 600 : (isDraw ? 200 : 0))
            + (WIN_GOALS - opGoals) * 150
            + (iWon ? Math.max(0, 240 - secs) * 3 : 0);
          var score = Math.round(pts * diff.mul);
          var best = App.Storage.get('best_airhockey', 0);
          var nb = score > best;
          if (nb) App.Storage.set('best_airhockey', score);
          after(900, function () {
            App.MG.endScreen(root, {
              score: score, best: best, newBest: nb,
              title: iWon ? '🏆 Gewonnen!' : (isDraw ? '🤝 Unentschieden' : '💥 Verloren'),
              label: diff.icon + ' ' + diff.name + ' · ' + myGoals + ':' + opGoals + ' in ' + App.MG.mmss(secs)
                + (nb ? ' · neuer Rekord! 🎉' : ' · Bestwert: ' + App.MG.fmt(best)),
              onExit: ctx.onExit,
              onAgain: function () { chooseDiff(); }
            });
          });
        }
      }
    }
  };

  /* ============================ STYLES ============================ */
  function injectStyle() {
    UI.injectStyle('mg-airhockey-css', [
      '.ahk-wrap{display:flex;flex-direction:column;gap:10px;align-items:stretch;}',
      '.ahk-head{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 16px;}',
      '.ahk-side{display:flex;flex-direction:column;align-items:flex-start;gap:0;min-width:0;flex:1;}',
      '.ahk-side-me{align-items:flex-end;}',
      '.ahk-nm{font-weight:800;font-size:11px;letter-spacing:1px;text-transform:uppercase;white-space:nowrap;',
      'overflow:hidden;text-overflow:ellipsis;max-width:100%;}',
      '.ahk-nm-opp{color:var(--aqua);text-shadow:0 0 10px rgba(51,230,208,.45);}',
      '.ahk-nm-me{color:var(--neon);text-shadow:0 0 10px rgba(57,255,20,.45);}',
      '.ahk-sc{font-size:clamp(26px,7vw,38px);font-weight:900;line-height:1.05;font-variant-numeric:tabular-nums;}',
      '.ahk-sc-opp{color:var(--aqua);text-shadow:0 0 14px rgba(51,230,208,.5);}',
      '.ahk-sc-me{color:var(--neon);text-shadow:0 0 14px rgba(57,255,20,.5);}',
      '.ahk-vs{display:flex;flex-direction:column;align-items:center;gap:1px;}',
      '.ahk-vs-l{color:var(--muted);font-size:10px;text-transform:uppercase;letter-spacing:2px;}',
      '.ahk-vs-n{color:var(--gold);font-size:12px;font-weight:900;letter-spacing:1px;}',
      '.ahk-bump{animation:ahk-bump .32s ease;}',
      '@keyframes ahk-bump{0%{transform:scale(1)}40%{transform:scale(1.32)}100%{transform:scale(1)}}',
      /* Tisch */
      '.ahk-stage{width:100%;max-width:340px;margin:0 auto;}',
      '.ahk-canvas{display:block;width:100%;height:auto;border-radius:18px;',
      'border:2px solid rgba(57,255,20,.35);background:#04120a;',
      'box-shadow:0 0 40px rgba(57,255,20,.20),inset 0 0 60px rgba(57,255,20,.06);',
      'touch-action:none;user-select:none;-webkit-user-select:none;-webkit-tap-highlight-color:transparent;cursor:none;}',
      '.ahk-hint{text-align:center;line-height:1.5;}',
      '.ahk-diffrow{display:flex;justify-content:center;}',
      /* Warten */
      '.ahk-wait{padding:44px;text-align:center;display:flex;flex-direction:column;gap:10px;align-items:center;max-width:440px;margin:0 auto;}',
      '.ahk-wait-emoji{font-size:52px;filter:drop-shadow(0 0 14px rgba(57,255,20,.5));animation:ahk-bob 1.6s ease-in-out infinite;}',
      '@keyframes ahk-bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-8px)}}',
      /* Schwierigkeitswahl */
      '.ahk-pick{padding:28px 22px;text-align:center;display:flex;flex-direction:column;gap:12px;align-items:center;max-width:460px;margin:0 auto;}',
      '.ahk-pick-emoji{font-size:50px;filter:drop-shadow(0 0 14px rgba(57,255,20,.5));}',
      '.ahk-pick h3{margin:0;font-size:26px;}',
      '.ahk-pick-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:10px;width:100%;max-width:340px;}',
      '.ahk-diff{display:flex;flex-direction:column;align-items:center;gap:2px;padding:12px 6px;height:auto;line-height:1.2;}',
      '.ahk-diff-ic{font-size:24px;line-height:1;}',
      '.ahk-diff-nm{font-weight:900;font-size:14px;letter-spacing:.5px;}',
      '.ahk-diff-sub{font-size:10px;opacity:.75;text-transform:uppercase;letter-spacing:1px;}',
      '.ahk-pick-foot{margin:0;}'
    ].join(''));
  }
})();
