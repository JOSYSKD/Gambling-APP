/* whackamole.js — "Maulwurf-Alarm": Whack-a-Mole im Neon-Dschungel.
 *
 * IDEE     : Aus 3x3 Löchern springen Maulwürfe (🐹 +100), goldene Maulwürfe
 *            (✨ +300, seltener und kürzer oben) und Bomben (💣 −200 plus 1 s
 *            Bildschirm-Rüttler — die bloß stehen lassen!). Runde = 45 Sekunden.
 *            Die Erscheinungsrate steigt im Rundenverlauf, gleichzeitig wird das
 *            Trefferfenster (Zeit oben) immer kürzer.
 * STEUERUNG: Maus oder Finger — einfach auf das Loch hauen. Ein Hammer folgt dem
 *            Zeiger und schlägt bei jedem Klick zu (auf dem Handy erscheint er
 *            dort, wo getippt wird).
 * PUNKTE   : Jeder Treffer zählt die Combo hoch: ab 5 Treffern ohne Fehlschlag
 *            gilt Multiplikator x2, ab 10 Treffern x3 (auf Maulwurf und Gold).
 *            Eine Bombe (−200, nie multipliziert) oder ein Schlag ins leere Loch
 *            setzt die Combo zurück. Punkte fallen nie unter 0.
 * SOLO     : Jagd auf den eigenen Rekord (App.Storage 'best_whackamole') und
 *            dazu ein Bot in vier Stärken, der auf einem eigenen, identisch
 *            getakteten Feld mitspielt: er sieht jeden Maulwurf mit einer
 *            Trefferquote, reagiert mit echter Reaktionszeit (zu langsam =
 *            entwischt), haut auch mal daneben oder auf eine Bombe und hat
 *            dieselbe Combo-Mechanik → plausible, schwankende Punktekurve.
 * MULTI    : Punkte-Rennen wie reflex.js — alle spielen gleichzeitig ihr eigenes
 *            Feld, die Punkte gehen gedrosselt (300 ms) per room.reportScore
 *            raus, daneben läuft die Live-Rangliste (App.MG.liveBoard). Start
 *            und Rundentimer laufen über room.now() → alle Geräte synchron.
 *            Es gibt keinen geteilten Spielzustand, damit funktioniert jede
 *            Spielerzahl von 2 bis 8 gleich gut.
 *
 * Alle Zeiten laufen über Wall-Clock (Date.now bzw. room.now), requestAnimation-
 * Frame zeichnet nur (Physik/Timing immer aus der Uhr) → Tab-Wechsel-sicher.
 * cleanup() stoppt rAF, alle Timer und meldet jeden Room-Listener wieder ab. */
(function () {
  'use strict';
  window.App = window.App || {}; App.Minigames = App.Minigames || {};
  var UI = App.UI, el = UI.el;

  injectStyle();

  /* ============================ Konstanten ============================ */
  var DURATION = 45;                       // s Rundenzeit
  var PTS_MOLE = 100, PTS_GOLD = 300, PTS_BOMB = -200;
  var RISE_MS = 120, SINK_MS = 140;        // Auftauch-/Abtauch-Animation
  var BONK_MS = 240;                       // Dauer der Treffer-Animation
  var SHAKE_MS = 1000;                     // Bildschirm-Rüttler nach einer Bombe
  var REPORT_MS = 300;                     // Multiplayer: reportScore-Drossel
  var GRACE_MS = 150;                      // Kulanz nach einem Treffer (Doppeltipp)

  /* Solo-Gegner: acc = Trefferquote, rMin/rMax = Reaktionszeit in ms,
     bomb = Wahrscheinlichkeit auf eine Bombe zu hauen, whiff = daneben hauen. */
  var DIFFS = [
    { icon: '🌱', name: 'Schnuffel', sub: 'Leicht', acc: 0.50, rMin: 420, rMax: 800, bomb: 0.26, whiff: 0.12 },
    { icon: '🍃', name: 'Bodo Buddel', sub: 'Normal', acc: 0.68, rMin: 320, rMax: 600, bomb: 0.16, whiff: 0.09 },
    { icon: '🔥', name: 'Hammer-Hanna', sub: 'Schwer', acc: 0.84, rMin: 250, rMax: 460, bomb: 0.09, whiff: 0.05 },
    { icon: '👑', name: 'Meister Maulwurf', sub: 'Profi', acc: 0.93, rMin: 210, rMax: 370, bomb: 0.05, whiff: 0.03 }
  ];

  /* ---------------- Kurven (p = 0..1 Rundenfortschritt) ---------------- */
  function lerp(a, b, p) { return a + (b - a) * p; }
  function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }
  function rnd(a, b) { return a + Math.random() * (b - a); }
  function spawnGap(p) { return lerp(760, 300, p); }                 // ms bis zum nächsten Auftauchen
  function maxUp(p) { return Math.round(lerp(2, 4, p)); }            // gleichzeitig oben
  function lifeMs(p, type) {                                          // Trefferfenster
    var base = lerp(1300, 640, p);
    if (type === 'gold') return base * 0.6;                           // Gold ist kürzer da
    if (type === 'bomb') return base * 0.95;
    return base;
  }
  function rollType(p) {
    var bomb = lerp(0.10, 0.24, p), gold = 0.10, r = Math.random();
    if (r < bomb) return 'bomb';
    if (r < bomb + gold) return 'gold';
    return 'mole';
  }
  function multOf(combo) { return combo >= 10 ? 3 : (combo >= 5 ? 2 : 1); }

  /* ============================ Spiel ============================ */
  App.Minigames.whackamole = {
    id: 'whackamole', title: 'Maulwurf-Alarm', icon: '🔨', order: 120,
    subtitle: 'Hau die Maulwürfe – aber nicht die Bomben!',
    single: true, multi: true, minPlayers: 2, maxPlayers: 8,

    render: function (root, ctx) {
      var isMulti = ctx.mode === 'multi';
      var nowFn = isMulti ? ctx.room.now : function () { return Date.now(); };

      var dead = false;
      var stops = [];                 // stop()-Funktionen (App.MG, Intervalle, room.off)
      var pending = [];               // laufende setTimeout-IDs
      var raf = null;

      /* Rundenzustand (in play() frisch gesetzt) */
      var score = 0, combo = 0, lastMult = 1, bestCombo = 0;
      var hits = 0, golds = 0, booms = 0;
      var startAt = 0, endAt = 0, nextSpawnAt = 0, lastTickSec = -1;
      var finished = false, dirty = false;
      var holes = [], bot = null, diff = DIFFS[1], soloBest = 0, soloSig = '';

      /* DOM der laufenden Ansicht */
      var layout = null, boardWrap = null, boardEl = null, hammer = null;
      var scoreEl = null, comboEl = null, multEl = null, timerEl = null;
      var hitsEl = null, goldEl = null, boomEl = null, bcEl = null, soloBoard = null;

      /* ---------------- Aufräum-Helfer ---------------- */
      function after(ms, fn) {
        var t = setTimeout(function () {
          var i = pending.indexOf(t); if (i >= 0) pending.splice(i, 1);
          if (!dead) fn();
        }, ms);
        pending.push(t); return t;
      }
      function clearPending() { pending.forEach(clearTimeout); pending = []; }
      function stopHelpers() { stops.forEach(function (f) { try { f(); } catch (e) {} }); stops = []; }
      function stopRaf() { if (raf) { cancelAnimationFrame(raf); raf = null; } }
      function cleanup() { dead = true; stopRaf(); clearPending(); stopHelpers(); }

      /* ---------------- Start ---------------- */
      if (isMulti) {
        var snap = ctx.room.snapshot() || {};
        var mStart = (snap.round && snap.round.startAt) || (ctx.room.now() + 3000);
        stops.push(App.MG.countdown(root, mStart, function () { play(mStart); }, ctx.room.now));
      } else {
        intro();
      }
      return { cleanup: cleanup };

      /* ===================== SOLO: Gegner wählen ===================== */
      function intro() {
        stopRaf(); clearPending(); stopHelpers();
        finished = true;
        soloBest = App.Storage.get('best_whackamole', 0);
        var sel = App.Storage.get('wkm_diff', 1);
        if (typeof sel !== 'number' || sel < 0 || sel > DIFFS.length - 1) sel = 1;

        var btns = DIFFS.map(function (d, i) {
          return el('button', {
            class: 'btn wkm-diff' + (i === sel ? ' btn-primary wkm-diff-last' : ' btn-ghost'),
            type: 'button',
            onclick: function () {
              App.Storage.set('wkm_diff', i);
              diff = d;
              if (App.Audio) App.Audio.sfx('select');
              var sa = Date.now() + 3000;
              stops.push(App.MG.countdown(root, sa, function () { play(sa); }));
            }
          }, [
            el('span', { class: 'wkm-diff-ico' }, [d.icon]),
            el('span', { class: 'wkm-diff-sub' }, [d.sub]),
            el('span', { class: 'wkm-diff-name' }, [d.name])
          ]);
        });

        root.innerHTML = '';
        root.appendChild(el('div', { class: 'glass wkm-intro' }, [
          el('div', { class: 'wkm-intro-ico' }, ['🔨']),
          el('h2', { class: 'neon' }, ['Maulwurf-Alarm']),
          el('p', { class: 'hint-text' }, ['45 Sekunden. Hau alles, was aus den Löchern kommt – außer den Bomben.']),
          el('div', { class: 'wkm-legend' }, [
            el('span', { class: 'chip wkm-lg' }, ['🐹 Maulwurf +100']),
            el('span', { class: 'chip wkm-lg wkm-lg-gold' }, ['✨ Gold +300']),
            el('span', { class: 'chip wkm-lg wkm-lg-bad' }, ['💣 Bombe −200']),
            el('span', { class: 'chip wkm-lg' }, ['🔥 5er-Combo x2 · 10er x3'])
          ]),
          el('div', { class: 'wkm-best-line' }, [
            el('span', { class: 'wkm-hc-l' }, ['Dein Rekord']),
            el('div', { class: 'big-readout', text: App.MG.fmt(soloBest) })
          ]),
          el('div', { class: 'mg-field-title' }, ['🤖 Gegner wählen und loshauen']),
          el('div', { class: 'wkm-diff-row' }, btns)
        ]));
      }

      /* ===================== RUNDE ===================== */
      function play(sAt) {
        stopRaf(); clearPending(); stopHelpers();
        score = 0; combo = 0; lastMult = 1; bestCombo = 0;
        hits = 0; golds = 0; booms = 0;
        finished = false; dirty = false; lastTickSec = -1; soloSig = '';
        startAt = sAt; endAt = sAt + DURATION * 1000;
        nextSpawnAt = sAt + 500;
        soloBest = App.Storage.get('best_whackamole', 0);
        if (!isMulti) bot = { score: 0, combo: 0, nextAt: sAt + rnd(350, 750), events: [] };

        /* --- Kopfzeile: Punkte / Combo / Zeit --- */
        scoreEl = el('div', { class: 'wkm-score' }, ['0']);
        comboEl = el('div', { class: 'wkm-combo' }, ['0']);
        multEl = el('div', { class: 'wkm-mult' }, ['x1']);
        timerEl = el('div', { class: 'mg-timer' }, [App.MG.mmss(DURATION)]);
        var head = el('div', { class: 'wkm-head glass' }, [
          el('div', { class: 'wkm-hc' }, [el('span', { class: 'wkm-hc-l' }, ['Punkte']), scoreEl]),
          el('div', { class: 'wkm-hc wkm-hc-mid' }, [
            el('span', { class: 'wkm-hc-l' }, ['Combo']),
            el('div', { class: 'wkm-combo-wrap' }, [comboEl, multEl])
          ]),
          el('div', { class: 'wkm-hc wkm-hc-right' }, [el('span', { class: 'wkm-hc-l' }, ['Zeit']), timerEl])
        ]);

        /* --- Spielfeld: 3x3 Löcher --- */
        holes = [];
        var cells = [];
        for (var i = 0; i < 9; i++) cells.push(makeHole(i));
        boardEl = el('div', { class: 'wkm-board' }, cells);
        hammer = el('div', { class: 'wkm-hammer' }, [el('span', { class: 'wkm-hammer-i' }, ['🔨'])]);
        boardWrap = el('div', { class: 'wkm-board-wrap glass' }, [
          boardEl, hammer,
          el('div', { class: 'hint-text wkm-rules' }, [
            '🔨 Loch antippen', '🐹 +100', '✨ Gold +300', '💣 Bombe −200', '🔥 5er-Combo x2', '10er x3'
          ].map(function (t) { return el('span', {}, [t]); }))
        ]);
        boardWrap.addEventListener('pointermove', function (e) { posHammer(e); });
        boardWrap.addEventListener('pointerleave', function () { if (hammer) hammer.classList.remove('wkm-on'); });

        /* --- Statistik-Streifen --- */
        hitsEl = el('div', { class: 'wkm-stat-v' }, ['0']);
        goldEl = el('div', { class: 'wkm-stat-v' }, ['0']);
        boomEl = el('div', { class: 'wkm-stat-v' }, ['0']);
        bcEl = el('div', { class: 'wkm-stat-v' }, ['0']);
        var stats = el('div', { class: 'wkm-stats glass' }, [
          el('div', { class: 'wkm-stat' }, [el('div', { class: 'wkm-stat-l' }, ['🐹 Treffer']), hitsEl]),
          el('div', { class: 'wkm-stat' }, [el('div', { class: 'wkm-stat-l' }, ['✨ Gold']), goldEl]),
          el('div', { class: 'wkm-stat' }, [el('div', { class: 'wkm-stat-l' }, ['💣 Bomben']), boomEl]),
          el('div', { class: 'wkm-stat' }, [el('div', { class: 'wkm-stat-l' }, ['🔥 Beste Combo']), bcEl])
        ]);

        /* --- Rangliste: live (multi) oder Bot + Rekord (solo) --- */
        var side;
        if (isMulti) {
          var board = App.MG.liveBoard(ctx.room, ctx.me.id);
          stops.push(board.stop);
          side = el('div', { class: 'wkm-side glass' }, [
            el('div', { class: 'mg-field-title' }, ['🏆 Rangliste']), board.root
          ]);
        } else {
          soloBoard = el('div', { class: 'mg-scoreboard' });
          side = el('div', { class: 'wkm-side glass' }, [
            el('div', { class: 'mg-field-title' }, ['🏆 Stand']), soloBoard,
            el('p', { class: 'hint-text wkm-side-hint' }, [diff.icon + ' ' + diff.name + ' buddelt auf seinem eigenen Feld mit.'])
          ]);
        }

        layout = el('div', { class: 'wkm-layout' }, [
          head, el('div', { class: 'wkm-main' }, [boardWrap, side]), stats
        ]);
        root.innerHTML = ''; root.appendChild(layout);
        updateHud(); updateSoloBoard();
        if (App.Audio) App.Audio.sfx('start');

        /* --- Rundentimer (Wall-Clock, Tab-sicher) --- */
        stops.push(App.MG.roundTimer(endAt, function (left) {
          timerEl.textContent = App.MG.mmss(left);
          if (left <= 5) {
            timerEl.classList.add('wkm-urgent');
            var s = Math.ceil(left);
            if (s !== lastTickSec && s > 0) { lastTickSec = s; if (App.Audio) App.Audio.sfx('tick'); }
          }
        }, finish, isMulti ? ctx.room.now : null));

        /* --- Multiplayer: Punkte gedrosselt melden --- */
        if (isMulti) {
          ctx.room.reportScore(0);
          var iv = setInterval(function () {
            if (dead || !dirty) return;
            dirty = false; ctx.room.reportScore(score);
          }, REPORT_MS);
          stops.push(function () { clearInterval(iv); });
        }

        raf = requestAnimationFrame(frame);
      }

      /* ---------------- Ein Loch bauen ---------------- */
      function makeHole(i) {
        var clip = el('div', { class: 'wkm-clip' });
        var fx = el('div', { class: 'wkm-fx' });
        var cell = el('button', {
          class: 'wkm-cell', type: 'button', 'aria-label': 'Loch ' + (i + 1)
        }, [el('div', { class: 'wkm-hole' }), clip, el('div', { class: 'wkm-lip' }), fx]);
        var h = { index: i, cell: cell, clip: clip, fx: fx, occ: null, graceUntil: 0 };
        cell.addEventListener('pointerdown', function (e) { onWhack(h, e); });
        cell.addEventListener('contextmenu', function (e) { e.preventDefault(); });
        holes.push(h);
        return cell;
      }

      /* ===================== Bild pro Frame ===================== */
      function frame() {
        raf = null;
        if (dead || finished) return;
        var now = nowFn();
        var p = clamp01((now - startAt) / (DURATION * 1000));

        /* Neue Maulwürfe (nach einem Tab-Wechsel nichts nachholen) */
        if (now < endAt) {
          if (nextSpawnAt < now - 1200) nextSpawnAt = now;
          while (now >= nextSpawnAt && nextSpawnAt < endAt) {
            trySpawn(p, now);
            nextSpawnAt += Math.max(90, spawnGap(p) * rnd(0.75, 1.25));
          }
        }

        /* Auftauchen / Abtauchen / Treffer-Animation */
        for (var i = 0; i < holes.length; i++) updateHole(holes[i], now);

        if (!isMulti) { botTick(now, p); updateSoloBoard(); }
        raf = requestAnimationFrame(frame);
      }

      function trySpawn(p, now) {
        var up = 0, free = [], i;
        for (i = 0; i < holes.length; i++) { if (holes[i].occ) up++; else free.push(i); }
        if (!free.length || up >= maxUp(p)) return;
        var h = holes[free[Math.floor(Math.random() * free.length)]];
        var type = rollType(p);
        var emo = el('span', { class: 'wkm-emo' }, [type === 'bomb' ? '💣' : '🐹']);
        var node = el('div', {
          class: 'wkm-mole' + (type === 'gold' ? ' wkm-gold' : (type === 'bomb' ? ' wkm-bomb' : ''))
        }, [emo]);
        node.style.transform = 'translateY(112%)';
        h.clip.appendChild(node);
        h.occ = { type: type, spawnAt: now, life: lifeMs(p, type), el: node, bonkAt: 0 };
        if (type === 'gold' && App.Audio) App.Audio.blip(1050, 0.07, { peak: 0.07 });
      }

      function updateHole(h, now) {
        var o = h.occ; if (!o) return;
        if (o.bonkAt) { if (now - o.bonkAt >= BONK_MS) clearHole(h); return; }
        var t = now - o.spawnAt;
        if (t >= o.life) { clearHole(h); return; }
        var y;
        if (t < RISE_MS) { var x = t / RISE_MS; y = (1 - x) * (1 - x); }        // rauf, abbremsend
        else if (t > o.life - SINK_MS) { var s = (t - (o.life - SINK_MS)) / SINK_MS; y = s * s; }
        else y = 0;
        var wob = y === 0 ? Math.sin(t / 130) * 3.5 : 0;
        o.el.style.transform = 'translateY(' + (y * 112).toFixed(1) + '%) rotate(' + wob.toFixed(2) + 'deg)';
      }

      function clearHole(h) {
        if (h.occ && h.occ.el && h.occ.el.parentNode) h.occ.el.parentNode.removeChild(h.occ.el);
        h.occ = null;
      }

      /* ===================== Eingabe ===================== */
      function onWhack(h, e) {
        if (e && e.preventDefault) e.preventDefault();
        swingHammer(e);
        if (dead || finished) return;
        var now = nowFn();
        if (now >= endAt) return;
        var o = h.occ;
        if (o && !o.bonkAt && (now - o.spawnAt) < o.life) applyHit(h, o, now);
        else if (!o && now >= h.graceUntil) whiff(h);
        /* schon getroffen oder gerade abgetaucht → wird ignoriert */
      }

      function applyHit(h, o, now) {
        var pulse = false;
        if (o.type === 'bomb') {
          booms++; combo = 0; lastMult = 1;
          score = Math.max(0, score + PTS_BOMB);
          floatText(h, '−200', 'bad');
          burst(h, '💥', 8, 'bad');
          fx(h.cell, 'wkm-fx-bad', 340);
          shake();
          if (App.Audio) App.Audio.sfx('explosion');
        } else {
          var gold = o.type === 'gold';
          combo++; hits++; if (gold) golds++;
          if (combo > bestCombo) bestCombo = combo;
          var m = multOf(combo);
          var pts = (gold ? PTS_GOLD : PTS_MOLE) * m;
          score += pts;
          floatText(h, '+' + pts, gold ? 'gold' : 'good');
          burst(h, gold ? '✨' : '⭐', gold ? 7 : 5, gold ? 'gold' : 'good');
          fx(h.cell, gold ? 'wkm-fx-gold' : 'wkm-fx-good', 340);
          if (App.Audio) App.Audio.sfx(gold ? 'coin' : 'pop');
          if (m !== lastMult) {
            lastMult = m;
            pulse = true;
            if (App.Audio) App.Audio.sfx(m === 3 ? 'levelup' : 'powerup');
          }
        }
        o.bonkAt = now;
        o.el.style.transform = '';
        o.el.classList.add('wkm-bonked');
        h.graceUntil = now + BONK_MS + GRACE_MS;
        dirty = true;
        updateHud();
        /* erst nach updateHud(), das setzt die Klassen von multEl neu */
        if (pulse) fx(multEl, 'wkm-mult-pulse', 460);
      }

      function whiff(h) {
        if (combo > 0) floatText(h, 'Combo weg!', 'miss');
        else floatText(h, 'daneben', 'miss');
        combo = 0; lastMult = 1;
        burst(h, '·', 5, 'miss');
        fx(h.cell, 'wkm-fx-whiff', 300);
        if (App.Audio) App.Audio.blip(150, 0.07, { type: 'sine', peak: 0.08 });
        updateHud();
      }

      /* ===================== Anzeige ===================== */
      function updateHud() {
        if (!scoreEl) return;
        scoreEl.textContent = App.MG.fmt(score);
        comboEl.textContent = String(combo);
        var m = multOf(combo);
        multEl.textContent = 'x' + m;
        multEl.className = 'wkm-mult' + (m === 3 ? ' wkm-m3' : (m === 2 ? ' wkm-m2' : ''));
        hitsEl.textContent = String(hits);
        goldEl.textContent = String(golds);
        boomEl.textContent = String(booms);
        bcEl.textContent = String(bestCombo);
      }

      function updateSoloBoard() {
        if (!soloBoard || !bot) return;
        var rows = [
          { name: 'Du', score: score, me: true },
          { name: diff.icon + ' ' + diff.name, score: Math.round(bot.score) }
        ];
        if (soloBest > 0) rows.push({ name: '🏆 Dein Rekord', score: soloBest, rec: true });
        rows.sort(function (a, b) { return b.score - a.score; });
        var sig = rows.map(function (r) { return r.name + ':' + r.score; }).join('|');
        if (sig === soloSig) return;
        soloSig = sig;
        soloBoard.innerHTML = '';
        rows.forEach(function (r, i) {
          soloBoard.appendChild(el('div', {
            class: 'mg-sb-row p' + (i + 1) + (r.me ? ' me' : '') + (r.rec ? ' wkm-rec' : '')
          }, [
            el('span', { class: 'mg-sb-rank' }, ['' + (i + 1)]),
            el('span', { class: 'mg-sb-name' }, [r.name]),
            el('span', { class: 'mg-sb-score' }, [App.MG.fmt(r.score)])
          ]));
        });
      }

      /* ===================== Effekte ===================== */
      function fx(node, cls, ms) {
        if (!node) return;
        node.classList.remove(cls); void node.offsetWidth; node.classList.add(cls);
        after(ms, function () { node.classList.remove(cls); });
      }
      function shake() { fx(layout, 'wkm-shake', SHAKE_MS); }

      function floatText(h, txt, cls) {
        var n = el('div', { class: 'wkm-float wkm-fl-' + cls }, [txt]);
        h.fx.appendChild(n);
        after(920, function () { if (n.parentNode) n.parentNode.removeChild(n); });
      }

      function burst(h, ch, count, cls) {
        for (var i = 0; i < count; i++) {
          var a = (Math.PI * 2 * i) / count + rnd(-0.4, 0.4);
          var d = rnd(24, 48);
          var s = el('span', {
            class: 'wkm-star wkm-st-' + cls,
            style: '--dx:' + Math.round(Math.cos(a) * d) + 'px;--dy:' + Math.round(Math.sin(a) * d - 10) +
                   'px;font-size:' + Math.round(rnd(11, 19)) + 'px;'
          }, [ch]);
          h.fx.appendChild(s);
          (function (node) {
            after(660, function () { if (node.parentNode) node.parentNode.removeChild(node); });
          })(s);
        }
      }

      function posHammer(e) {
        if (!hammer || !boardWrap || e.clientX == null) return;
        var r = boardWrap.getBoundingClientRect();
        hammer.style.transform = 'translate(' + (e.clientX - r.left) + 'px,' + (e.clientY - r.top) + 'px)';
        hammer.classList.add('wkm-on');
      }
      function swingHammer(e) {
        if (!hammer) return;
        posHammer(e);
        fx(hammer, 'wkm-swing', 250);
      }

      /* ===================== Ende ===================== */
      function finish() {
        if (finished || dead) return;
        finished = true;
        stopRaf(); clearPending(); stopHelpers();
        holes.forEach(clearHole);
        if (App.Audio) App.Audio.sfx('whoosh');

        if (boardWrap) {
          boardWrap.appendChild(el('div', { class: 'wkm-over' }, [
            el('div', { class: 'wkm-over-ico' }, ['🏁']),
            el('div', { class: 'wkm-over-t neon' }, ['Zeit um!']),
            el('div', { class: 'wkm-over-s' }, [App.MG.fmt(score) + ' Punkte'])
          ]));
        }

        if (isMulti) {
          ctx.room.reportScore(score);
          after(1300, function () {
            App.MG.endScreen(root, { players: ctx.room.players(), meId: ctx.me.id, onExit: ctx.onExit });
          });
        } else {
          var best = App.Storage.get('best_whackamole', 0);
          var nb = score > best;
          if (nb) App.Storage.set('best_whackamole', score);
          var bs = bot ? Math.round(bot.score) : 0;
          var duell = score > bs ? 'gewonnen! 🏆' : (score === bs ? 'unentschieden 🤝' : 'verloren 😤');
          var label = 'Du ' + App.MG.fmt(score) + ' : ' + App.MG.fmt(bs) + ' ' + diff.name + ' · ' + duell +
            ' · beste Combo ' + bestCombo + ' · ' + (nb ? 'neuer Rekord! 🎉' : 'Bestwert: ' + App.MG.fmt(best));
          if (App.Audio) App.Audio.sfx(score > bs ? 'win' : 'lose');
          after(1100, function () {
            App.MG.endScreen(root, {
              score: score, best: best, newBest: nb, label: label,
              onExit: ctx.onExit,
              onAgain: function () { intro(); }
            });
          });
        }
      }

      /* ===================== Solo-Bot ===================== */
      /* Der Bot bekommt seinen eigenen, gleich getakteten Strom an Maulwürfen und
         entscheidet pro Ziel: sieht er es (acc), wie schnell haut er (rMin/rMax,
         zu langsam = entwischt), haut er daneben (whiff) oder auf eine Bombe
         (bomb)? Die Punkte/Combo-Regeln sind exakt dieselben wie beim Spieler. */
      function botInsert(ev) {
        var i = bot.events.length;
        while (i > 0 && bot.events[i - 1].at > ev.at) i--;
        bot.events.splice(i, 0, ev);
      }
      function botPlan(spawnAt, p) {
        var type = rollType(p), life = lifeMs(p, type), r;
        if (type === 'bomb') {
          if (Math.random() < diff.bomb) botInsert({ at: spawnAt + rnd(diff.rMin, diff.rMax), kind: 'bomb' });
          return;
        }
        if (Math.random() < diff.whiff) botInsert({ at: spawnAt + rnd(diff.rMin, diff.rMax), kind: 'whiff' });
        if (Math.random() > diff.acc) return;            // gar nicht erst gesehen
        r = rnd(diff.rMin, diff.rMax);
        if (r >= life) return;                            // zu langsam → entwischt
        botInsert({ at: spawnAt + r, kind: type });
      }
      function botTick(now, p) {
        if (bot.nextAt < now - 1200) bot.nextAt = now;
        while (now >= bot.nextAt && bot.nextAt < endAt) {
          botPlan(bot.nextAt, p);
          bot.nextAt += Math.max(90, spawnGap(p) * rnd(0.75, 1.25));
        }
        while (bot.events.length && bot.events[0].at <= now) {
          var ev = bot.events.shift();
          if (ev.at >= endAt) continue;
          if (ev.kind === 'bomb') { bot.combo = 0; bot.score = Math.max(0, bot.score + PTS_BOMB); }
          else if (ev.kind === 'whiff') { bot.combo = 0; }
          else {
            bot.combo++;
            bot.score += (ev.kind === 'gold' ? PTS_GOLD : PTS_MOLE) * multOf(bot.combo);
          }
        }
      }
    }
  };

  /* ============================ Styles ============================ */
  function injectStyle() {
    UI.injectStyle('mg-whackamole-css', [
      '.wkm-layout{display:flex;flex-direction:column;gap:12px;max-width:760px;margin:0 auto;}',
      /* --- Kopfzeile --- */
      '.wkm-head{display:flex;justify-content:space-between;align-items:center;padding:12px 18px;gap:12px;flex-wrap:wrap;}',
      '.wkm-hc{display:flex;flex-direction:column;gap:2px;min-width:0;}',
      '.wkm-hc-mid{align-items:center;}',
      '.wkm-hc-right{text-align:right;}',
      '.wkm-hc-l{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:1px;}',
      '.wkm-score{font-size:clamp(24px,6vw,40px);font-weight:900;color:var(--gold);line-height:1;',
      'text-shadow:0 0 12px rgba(255,210,63,.45);font-variant-numeric:tabular-nums;}',
      '.wkm-combo-wrap{display:flex;align-items:center;gap:7px;}',
      '.wkm-combo{font-size:clamp(20px,5vw,32px);font-weight:900;color:var(--leaf);line-height:1;',
      'font-variant-numeric:tabular-nums;text-shadow:0 0 10px rgba(157,255,122,.35);}',
      '.wkm-mult{font-weight:900;font-size:13px;padding:3px 9px;border-radius:999px;line-height:1;',
      'border:1px solid var(--stroke);color:var(--muted);background:rgba(4,16,10,.6);transition:color .15s,background .15s;}',
      '.wkm-mult.wkm-m2{color:#04160c;background:var(--aqua);border-color:var(--aqua-soft);box-shadow:0 0 14px rgba(51,230,208,.55);}',
      '.wkm-mult.wkm-m3{color:#2a1a00;background:var(--gold);border-color:#fff0b8;box-shadow:0 0 20px rgba(255,210,63,.65);}',
      '.wkm-mult-pulse{animation:wkm-mult-pulse .45s cubic-bezier(.2,.9,.3,1);}',
      '@keyframes wkm-mult-pulse{0%{transform:scale(1)}35%{transform:scale(1.55)}100%{transform:scale(1)}}',
      '.wkm-head .mg-timer{font-size:clamp(18px,5vw,26px);}',
      '.mg-timer.wkm-urgent{color:var(--danger-2);animation:wkm-pulse .7s infinite;}',
      /* --- Aufbau --- */
      '.wkm-main{display:flex;gap:12px;align-items:flex-start;flex-wrap:wrap;justify-content:center;}',
      '.wkm-board-wrap{position:relative;flex:1 1 300px;min-width:0;max-width:372px;margin:0 auto;',
      'padding:14px;display:flex;flex-direction:column;gap:10px;}',
      '.wkm-side{flex:1 1 200px;min-width:0;max-width:340px;margin:0 auto;padding:14px;',
      'display:flex;flex-direction:column;gap:8px;}',
      '.wkm-side .mg-scoreboard{max-height:300px;overflow-y:auto;}',
      '.wkm-side-hint{margin:0;font-size:11px;}',
      /* Regelzeile: jede Regel bleibt am Stueck, Umbruch nur zwischen den Regeln */
      '.wkm-rules{margin:0;font-size:11px;line-height:1.5;display:flex;flex-wrap:wrap;',
      'justify-content:center;gap:2px 12px;}',
      '.wkm-rules span{white-space:nowrap;}',
      '.mg-sb-row.wkm-rec{opacity:.78;border-style:dashed;}',
      /* --- Brett + Löcher --- */
      '.wkm-board{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;width:100%;max-width:340px;',
      'margin:0 auto;touch-action:manipulation;}',
      '@media (pointer:fine){.wkm-board{cursor:none;}}',
      '.wkm-cell{position:relative;aspect-ratio:1/1;padding:0;border-radius:18px;cursor:inherit;',
      'border:1px solid var(--stroke);font-family:inherit;overflow:visible;',
      'background:radial-gradient(ellipse 130% 70% at 50% -8%,rgba(57,255,20,.09),transparent 62%),',
      'linear-gradient(180deg,#0a2213 0%,#04120a 100%);',
      'box-shadow:inset 0 1px 0 rgba(157,255,122,.1);user-select:none;-webkit-user-select:none;',
      '-webkit-tap-highlight-color:transparent;transition:border-color .12s,box-shadow .12s;}',
      '.wkm-cell:active{transform:scale(.985);}',
      /* Loch = schwarze Ellipse mit Neon-Rand; Lippe = Erdwall DAVOR (deckt die
         Beine ab). Oben ist die Lippe so dunkel wie das Loch -> Naht unsichtbar. */
      '.wkm-hole{position:absolute;left:9%;right:9%;bottom:8%;height:46%;border-radius:50%;',
      'background:radial-gradient(ellipse at 50% 26%,#020905 0%,#000 72%);',
      'box-shadow:inset 0 12px 24px rgba(0,0,0,.98),0 0 0 2px rgba(57,255,20,.18),0 0 12px rgba(57,255,20,.08);}',
      '.wkm-clip{position:absolute;left:0;right:0;top:0;bottom:31%;overflow:hidden;pointer-events:none;}',
      '.wkm-lip{position:absolute;left:9%;right:9%;bottom:8%;height:23%;pointer-events:none;',
      'border-radius:0 0 50% 50%/0 0 100% 100%;',
      'background:linear-gradient(180deg,#020905 0%,#0d2416 52%,#1b4429 100%);',
      'box-shadow:inset 0 -3px 7px rgba(157,255,122,.16),0 3px 9px rgba(0,0,0,.6);}',
      /* --- Maulwürfe --- */
      '.wkm-mole{position:absolute;left:0;right:0;bottom:0;text-align:center;line-height:1.05;',
      'font-size:clamp(30px,9.5vw,46px);will-change:transform;transform:translateY(112%);',
      'filter:drop-shadow(0 5px 9px rgba(0,0,0,.65));}',
      '.wkm-emo{display:inline-block;}',
      '.wkm-mole.wkm-gold{filter:drop-shadow(0 0 12px var(--gold)) saturate(1.6) hue-rotate(-16deg) brightness(1.2);}',
      '.wkm-mole.wkm-gold .wkm-emo{animation:wkm-shimmer .8s ease-in-out infinite alternate;}',
      '.wkm-mole.wkm-gold::after{content:"✨";position:absolute;top:-2px;right:14%;font-size:.5em;',
      'filter:none;animation:wkm-shimmer .55s ease-in-out infinite alternate;}',
      '.wkm-mole.wkm-bomb{filter:drop-shadow(0 0 10px rgba(255,77,109,.75));}',
      '.wkm-mole.wkm-bomb .wkm-emo{animation:wkm-fuse .42s ease-in-out infinite alternate;}',
      '.wkm-mole.wkm-bonked{animation:wkm-bonk 240ms cubic-bezier(.3,1.3,.4,1) forwards;}',
      '@keyframes wkm-bonk{0%{transform:translateY(0) scale(1,1);}30%{transform:translateY(10%) scale(1.28,.6);}',
      '100%{transform:translateY(125%) scale(1.05,.8);opacity:.5;}}',
      '@keyframes wkm-shimmer{from{transform:scale(1);filter:brightness(1);}to{transform:scale(1.06);filter:brightness(1.3);}}',
      '@keyframes wkm-fuse{from{transform:scale(1);}to{transform:scale(1.12);}}',
      /* --- Treffer-Rückmeldung an der Zelle --- */
      '.wkm-cell.wkm-fx-good{animation:wkm-fl-good .34s ease-out;}',
      '.wkm-cell.wkm-fx-gold{animation:wkm-fl-gold .34s ease-out;}',
      '.wkm-cell.wkm-fx-bad{animation:wkm-fl-bad .34s ease-out;}',
      '.wkm-cell.wkm-fx-whiff{animation:wkm-fl-whiff .3s ease-out;}',
      '@keyframes wkm-fl-good{0%{box-shadow:0 0 0 rgba(57,255,20,0);}',
      '28%{border-color:var(--neon);box-shadow:0 0 26px rgba(57,255,20,.75),inset 0 0 34px rgba(57,255,20,.32);}',
      '100%{box-shadow:0 0 0 rgba(57,255,20,0);}}',
      '@keyframes wkm-fl-gold{0%{box-shadow:0 0 0 rgba(255,210,63,0);}',
      '28%{border-color:var(--gold);box-shadow:0 0 30px rgba(255,210,63,.8),inset 0 0 38px rgba(255,210,63,.4);}',
      '100%{box-shadow:0 0 0 rgba(255,210,63,0);}}',
      '@keyframes wkm-fl-bad{0%{box-shadow:0 0 0 rgba(255,77,109,0);}',
      '28%{border-color:var(--danger);box-shadow:0 0 32px rgba(255,77,109,.85),inset 0 0 40px rgba(255,77,109,.45);}',
      '100%{box-shadow:0 0 0 rgba(255,77,109,0);}}',
      '@keyframes wkm-fl-whiff{0%{box-shadow:0 0 0 rgba(123,166,146,0);}',
      '30%{box-shadow:inset 0 0 26px rgba(123,166,146,.3);}100%{box-shadow:0 0 0 rgba(123,166,146,0);}}',
      /* --- Fliegende Zahlen + Sternchen --- */
      '.wkm-fx{position:absolute;inset:0;pointer-events:none;overflow:visible;z-index:3;}',
      '.wkm-float{position:absolute;left:50%;top:20%;font-weight:900;white-space:nowrap;',
      'font-size:clamp(14px,3.8vw,19px);text-shadow:0 2px 9px rgba(0,0,0,.85);',
      'animation:wkm-float 900ms cubic-bezier(.2,.8,.3,1) forwards;}',
      '@keyframes wkm-float{0%{opacity:0;transform:translate(-50%,12px) scale(.7);}',
      '22%{opacity:1;transform:translate(-50%,-6px) scale(1.18);}',
      '100%{opacity:0;transform:translate(-50%,-50px) scale(1);}}',
      '.wkm-fl-good{color:var(--neon);}',
      '.wkm-fl-gold{color:var(--gold);}',
      '.wkm-fl-bad{color:var(--danger);}',
      '.wkm-fl-miss{color:var(--muted);font-size:11px;font-weight:700;}',
      '.wkm-star{position:absolute;left:50%;top:42%;line-height:1;animation:wkm-star 620ms ease-out forwards;}',
      '@keyframes wkm-star{0%{opacity:1;transform:translate(-50%,-50%) scale(.4) rotate(0deg);}',
      '100%{opacity:0;transform:translate(calc(-50% + var(--dx)),calc(-50% + var(--dy))) scale(1.15) rotate(150deg);}}',
      '.wkm-st-miss{color:var(--muted);}',
      /* --- Hammer --- */
      '.wkm-hammer{position:absolute;left:0;top:0;z-index:6;pointer-events:none;opacity:0;transition:opacity .12s;}',
      '.wkm-hammer.wkm-on{opacity:1;}',
      '.wkm-hammer-i{display:block;font-size:38px;line-height:1;transform-origin:24% 76%;',
      'transform:translate(-24%,-60%) rotate(-30deg);filter:drop-shadow(0 4px 7px rgba(0,0,0,.65));}',
      '.wkm-hammer.wkm-swing .wkm-hammer-i{animation:wkm-swing 250ms cubic-bezier(.3,1.5,.4,1);}',
      '@keyframes wkm-swing{0%{transform:translate(-24%,-60%) rotate(-30deg);}',
      '38%{transform:translate(-24%,-60%) rotate(28deg);}100%{transform:translate(-24%,-60%) rotate(-30deg);}}',
      /* --- Statistik --- */
      '.wkm-stats{display:flex;gap:10px;padding:12px 14px;justify-content:space-around;flex-wrap:wrap;}',
      '.wkm-stat{display:flex;flex-direction:column;align-items:center;gap:2px;}',
      '.wkm-stat-l{font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.8px;white-space:nowrap;}',
      '.wkm-stat-v{font-size:clamp(16px,4vw,22px);font-weight:900;color:var(--leaf);font-variant-numeric:tabular-nums;}',
      /* --- Zeit-um-Schleier --- */
      '.wkm-over{position:absolute;inset:0;z-index:9;display:flex;flex-direction:column;align-items:center;',
      'justify-content:center;gap:4px;border-radius:18px;background:rgba(2,10,6,.86);',
      'backdrop-filter:blur(3px);animation:wkm-over-in .3s ease both;}',
      '.wkm-over-ico{font-size:52px;line-height:1;}',
      '.wkm-over-t{font-size:30px;font-weight:900;}',
      '.wkm-over-s{color:var(--gold);font-weight:900;font-size:19px;}',
      '@keyframes wkm-over-in{from{opacity:0;}to{opacity:1;}}',
      /* --- Solo-Startbild --- */
      '.wkm-intro{max-width:540px;margin:0 auto;padding:26px 22px;text-align:center;',
      'display:flex;flex-direction:column;gap:12px;align-items:center;}',
      '.wkm-intro h2{margin:0;}',
      '.wkm-intro-ico{font-size:56px;line-height:1;animation:wkm-tilt 1.6s ease-in-out infinite;}',
      '@keyframes wkm-tilt{0%,100%{transform:rotate(-16deg);}50%{transform:rotate(14deg);}}',
      '.wkm-legend{display:flex;flex-wrap:wrap;gap:6px;justify-content:center;}',
      '.wkm-lg{font-size:11px;}',
      '.wkm-lg-gold{color:var(--gold);border-color:rgba(255,210,63,.4);}',
      '.wkm-lg-bad{color:var(--danger);border-color:rgba(255,77,109,.4);}',
      '.wkm-best-line{display:flex;flex-direction:column;align-items:center;gap:2px;}',
      '.wkm-best-line .big-readout{color:var(--gold);}',
      '.wkm-diff-row{display:flex;flex-wrap:wrap;gap:8px;justify-content:center;width:100%;}',
      '.wkm-diff{display:flex;flex-direction:column;align-items:center;gap:2px;padding:10px 12px;',
      'flex:1 1 120px;max-width:160px;line-height:1.2;}',
      '.wkm-diff-ico{font-size:22px;line-height:1;}',
      '.wkm-diff-sub{font-size:12px;font-weight:900;letter-spacing:.5px;}',
      '.wkm-diff-name{font-size:10px;opacity:.72;font-weight:700;}',
      '.wkm-diff-last{box-shadow:0 0 16px var(--stroke-2);}',
      /* --- Rüttler + Puls --- */
      '.wkm-shake{animation:wkm-shake 1s cubic-bezier(.36,.07,.19,.97) both;}',
      '@keyframes wkm-shake{0%,100%{transform:translate(0,0) rotate(0deg);}',
      '8%{transform:translate(-9px,4px) rotate(-.7deg);}18%{transform:translate(8px,-5px) rotate(.6deg);}',
      '30%{transform:translate(-7px,3px) rotate(-.5deg);}42%{transform:translate(6px,-3px) rotate(.4deg);}',
      '55%{transform:translate(-4px,2px) rotate(-.3deg);}68%{transform:translate(3px,-2px) rotate(.2deg);}',
      '82%{transform:translate(-2px,1px) rotate(-.1deg);}}',
      '@keyframes wkm-pulse{0%,100%{opacity:1;}50%{opacity:.4;}}',
      '@media (prefers-reduced-motion:reduce){.wkm-shake{animation:none;}.wkm-intro-ico{animation:none;}}'
    ].join(''));
  }
})();
