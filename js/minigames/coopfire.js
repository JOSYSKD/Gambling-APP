/* coopfire.js — "Feuer-Alarm" (Koop-Feuerwehr).
 *
 * KOOP-Team-Minispiel: alle Spieler teilen sich EIN Gitter (6×6 Dschungel) und
 * halten die Brände GEMEINSAM unter Kontrolle. Kein Wettbewerb, kein Podest –
 * das Team gewinnt oder verliert zusammen.
 *
 * Prinzip:
 *   - Auf zufälligen Zellen entstehen Brände 🔥. Wird ein Brand nicht gelöscht,
 *     breitet er sich alle paar Sekunden auf freie Nachbarn aus und wird stärker.
 *   - Spieler tippen brennende Zellen an: kleiner Brand (schwelt) = 1 Tap,
 *     großer Brand = 2 Taps (erst schwelt, dann aus). Gelöschte Zelle wird grün.
 *   - Geteilte "Dschungel-Gesundheit" sinkt, solange viel brennt, und erholt sich,
 *     wenn wenig brennt. Gesundheit auf 0 → Team verliert.
 *   - Haltet den Dschungel LEVEL Sekunden am Leben → gewonnen. Über die Zeit
 *     steigen Brand-Rate & Ausbreitung (Wellen) → man muss sich das Feld aufteilen.
 *
 * Architektur (host-autoritativ + Intents, siehe COOP_SPEC.md):
 *   - Nur der HOST würfelt Zündstellen/Ausbreitung, hält den maßgeblichen Zustand
 *     in `G`, prüft Sieg/Niederlage und pusht ihn gedrosselt via room.setShared.
 *   - Gäste rendern aus room.on('shared', …) und schicken Lösch-Taps als INTENTS
 *     über room.reportState({ q:[{s,i},…] }) mit fortlaufender Sequenznummer.
 *   - Der Host wendet fremde Intents genau EINMAL an (lastSeq pro Spieler).
 *   - Solo: room=null, alles läuft lokal (Sim + Taps direkt auf G).
 *   - Host-Migration: wird ein Gast zum Host, übernimmt er G aus dem geteilten
 *     Zustand und treibt die Sim weiter.
 */
(function () {
  'use strict';
  window.App = window.App || {}; App.Minigames = App.Minigames || {};
  var UI = App.UI, el = UI.el, MG = App.MG;

  injectStyle();

  var COLS = 6, ROWS = 6, N = COLS * ROWS;   // 6×6 = 36 Zellen
  var LEVEL = 75;                             // Sekunden Level-Dauer
  var COMFORT = 4;                            // so viele Brände verkraftet der Dschungel
  var PUSH_MS = 140;                          // Host-Loop / Netz-Push-Takt
  var HEARTBEAT_MS = 800;                     // spätestens so oft pushen

  App.Minigames.coopfire = {
    id: 'coopfire', title: 'Feuer-Alarm', icon: '🔥', order: 24,
    subtitle: 'Löscht die Brände zusammen, bevor der Dschungel abbrennt',
    coop: true, single: true, multi: true, minPlayers: 2, maxPlayers: 4,

    render: function (root, ctx) {
      var isMulti = ctx.mode === 'multi';
      var room = isMulti ? ctx.room : null;
      var myName = (ctx.me && ctx.me.name) || 'Spieler';
      var nowFn = isMulti ? room.now : Date.now;

      /* ---- Timer-/Timeout-Verwaltung (cleanup stoppt WIRKLICH alles) ---- */
      var stops = [];                 // App.MG-stop()-Funktionen + room.off-Closures
      var timeouts = [];              // setTimeout-IDs
      var loopTimer = null;           // Host-Loop (setInterval)
      var destroyed = false;
      function after(ms, fn) { var t = setTimeout(fn, ms); timeouts.push(t); return t; }
      function clearTimeouts() { timeouts.forEach(clearTimeout); timeouts = []; }
      function clearStops() { stops.forEach(function (f) { try { f(); } catch (e) {} }); stops = []; }
      function clearLoop() { if (loopTimer) { clearInterval(loopTimer); loopTimer = null; } }
      function clearAll() { clearStops(); clearTimeouts(); clearLoop(); }
      function cleanup() { destroyed = true; clearAll(); }

      function amHost() { return isMulti ? !!(room && room.isHost()) : true; }

      /* ---- geteilter Zustand (auf JEDEM Client eine lokale Spiegelung) ---- */
      var G = null;
      /* Host-Buchhaltung */
      var nextSpreadAt = 0, lastSeq = {}, extSeq = 0, dirty = false, lastPush = 0;
      var wasHost = amHost();
      /* Gast-Intents */
      var mySeq = 0, pending = [];
      /* Render-Merker */
      var lastExtSeen = 0, shownWave = 0, critWarned = false, finished = false;

      /* DOM-Referenzen (einmalig gebaut) */
      var cells = [], gridEl = null, barFill = null, healthNum = null,
          fireNum = null, extNum = null, waveNum = null, timerEl = null,
          teamNames = null, teamCount = null, lastExtCount = -1;

      /* ---- Start: Multi mit 3-2-1-Countdown (synchron), Solo sofort ---- */
      if (isMulti) {
        var snap = room.snapshot() || {};
        var startAt = (snap.round && snap.round.startAt) || (room.now() + (MG.MULTI_START_DELAY || 3000));
        stops.push(MG.countdown(root, startAt, function () { play(startAt); }, room.now));
      } else {
        play(Date.now());
      }
      return { cleanup: cleanup };

      /* ============================ SPIEL ============================ */
      function play(startAt) {
        clearAll();
        finished = false;
        lastSeq = {}; extSeq = 0; dirty = false; lastPush = 0;
        mySeq = 0; pending = [];
        lastExtSeen = 0; shownWave = 0; critWarned = false; lastExtCount = -1;
        wasHost = amHost();

        G = {
          grid: new Array(N), health: 100, wave: 1, ext: 0, peak: 0,
          lastExt: null, over: false, win: false,
          startAt: startAt, endAt: startAt + LEVEL * 1000
        };
        for (var k = 0; k < N; k++) G.grid[k] = 0;

        buildUI();

        /* Gäste: sofort den letzten geteilten Zustand übernehmen (kein leeres Feld) */
        if (isMulti && !amHost()) {
          var sh0 = (room.snapshot() || {}).shared;
          if (sh0) applyShared(sh0);
        }

        /* Netz-Listener */
        if (isMulti) {
          room.on('shared', onShared); stops.push(function () { room.off('shared', onShared); });
          room.on('players', onPlayers); stops.push(function () { room.off('players', onPlayers); });
        }
        renderTeam();
        renderFromG();

        /* Level-Timer (Wall-Clock, im Multi synchron über room.now) — läuft überall */
        stops.push(MG.roundTimer(G.endAt, function (left) {
          timerEl.textContent = '⏱ ' + MG.mmss(left);
          timerEl.classList.toggle('mg-cf-urgent', left <= 12);
        }, function () { if (amHost()) endHost(G.health > 0); }, isMulti ? room.now : null));

        /* Host-Sim + Push starten */
        var now0 = nowFn();
        nextSpreadAt = now0 + 1500;             // kurze Ruhe vor dem ersten Brand
        if (amHost() && isMulti) { pushShared(); lastPush = now0; }
        loopTimer = setInterval(hostTick, PUSH_MS);
      }

      /* ---- DOM einmal aufbauen (danach nur Klassen/Emoji/Positionen ändern) ---- */
      function buildUI() {
        barFill = el('div', { class: 'mg-cf-bar-fill ok' });
        healthNum = el('b', { class: 'mg-cf-hnum' }, ['100%']);
        var healthBox = el('div', { class: 'mg-cf-health' }, [
          el('div', { class: 'mg-cf-hrow' }, [
            el('span', { class: 'mg-cf-hlabel' }, ['🌳 Dschungel-Gesundheit']), healthNum
          ]),
          el('div', { class: 'mg-cf-bar' }, [barFill])
        ]);

        fireNum = el('b', {}, ['0']);
        extNum = el('b', {}, ['0']);
        waveNum = el('b', {}, ['1']);
        timerEl = el('div', { class: 'mg-timer mg-cf-timer' }, ['⏱ ' + MG.mmss(LEVEL)]);
        var stats = el('div', { class: 'mg-cf-stats' }, [
          statBox(timerEl, 'Zeit'),
          statBox(waveNum, 'Welle'),
          statBox(fireNum, '🔥 aktiv'),
          statBox(extNum, '💧 gelöscht')
        ]);

        var hud = el('div', { class: 'mg-cf-hud glass' }, [healthBox, stats]);

        /* Team-Zeile */
        teamCount = el('b', {}, ['1']);
        teamNames = el('div', { class: 'mg-cf-team-names' });
        var teamRow = el('div', { class: 'mg-cf-team glass' }, [
          el('span', { class: 'mg-cf-team-h' }, ['👨‍🚒 Team (', teamCount, ')']),
          teamNames
        ]);

        /* Gitter */
        gridEl = el('div', { class: 'mg-cf-grid' });
        cells = [];
        for (var i = 0; i < N; i++) {
          (function (idx) {
            var em = el('span', { class: 'mg-cf-em' }, ['🌳']);
            var cell = el('button', { class: 'mg-cf-cell', type: 'button', 'data-hp': '0', 'aria-label': 'Zelle' }, [em]);
            cell.__hp = -1; cell.__em = em;
            cell.addEventListener('click', function () { tap(idx); });
            gridEl.appendChild(cell);
            cells.push(cell);
          })(i);
        }
        var board = el('div', { class: 'mg-cf-board' }, [gridEl]);

        var hint = el('p', { class: 'hint-text mg-cf-hint' }, [
          '🔥 Tippt brennende Felder an, um sie zu löschen. Große Brände brauchen 2 Taps. Teilt euch das Feld auf!'
        ]);

        var wrap = el('div', { class: 'mg-cf-wrap' }, [hud, teamRow, board, hint]);
        root.innerHTML = ''; root.appendChild(wrap);
      }

      function statBox(valEl, label) {
        return el('div', { class: 'mg-cf-stat' }, [valEl, el('span', {}, [label])]);
      }

      /* ============================ HOST-LOOP ============================ */
      function hostTick() {
        if (destroyed || finished) return;
        var host = amHost();
        if (host && !wasHost) onBecomeHost();     // Host-Migration
        wasHost = host;
        if (!host) return;                        // Gäste treiben die Sim NICHT

        var now = nowFn();
        var elapsed = Math.max(0, (now - G.startAt) / 1000);
        G.wave = Math.min(5, 1 + Math.floor(elapsed / 15));

        if (now >= nextSpreadAt) {
          simStep();
          var spreadMs = Math.max(650, 1250 - G.wave * 120);
          nextSpreadAt = now + spreadMs;
        }

        if (G.health <= 0) { endHost(false); return; }
        if (elapsed >= LEVEL) { endHost(G.health > 0); return; }

        if (dirty || (now - lastPush) >= HEARTBEAT_MS) {
          if (isMulti) pushShared();
          dirty = false; lastPush = now;
        }
        renderFromG();
      }

      function onBecomeHost() {
        if (!isMulti) return;
        UI.toast('Du bist jetzt Host 🔧', 'info');
        var now = nowFn();
        nextSpreadAt = now + 900;
        /* Sequenzen der aktuellen Spieler merken, damit alte Taps nicht doppelt greifen */
        var ps = room.players();
        ps.forEach(function (p) {
          var st = p.state, mx = 0;
          if (st) {
            if (Array.isArray(st.q)) st.q.forEach(function (e) { if (e && e.s > mx) mx = e.s; });
            if (typeof st.seq === 'number' && st.seq > mx) mx = st.seq;
          }
          lastSeq[p.id] = mx;
        });
        var sn = room.snapshot() || {};
        if (sn.round && sn.round.startAt && !G.startAt) {
          G.startAt = sn.round.startAt; G.endAt = G.startAt + LEVEL * 1000;
        }
      }

      /* ---- Simulations-Tick (nur Host würfelt) ---- */
      function simStep() {
        var wave = G.wave;
        /* 1) Zünden: mehr Brände in höheren Wellen */
        var attempts = wave;
        for (var a = 0; a < attempts; a++) {
          if (Math.random() < 0.6) {
            var free = freeCells();
            if (free.length) {
              var idx = free[(Math.random() * free.length) | 0];
              G.grid[idx] = (Math.random() < (0.12 + wave * 0.05)) ? 2 : 1;
            }
          }
        }
        /* 2) Ausbreiten + Verstärken (Schnappschuss, damit keine Ketten-Explosion) */
        var burning = [];
        for (var i = 0; i < N; i++) if (G.grid[i] >= 1) burning.push(i);
        var spreadChance = 0.24 + wave * 0.06;
        var intensifyChance = 0.14 + wave * 0.04;
        for (var b = 0; b < burning.length; b++) {
          var bi = burning[b];
          if (G.grid[bi] === 1 && Math.random() < intensifyChance) G.grid[bi] = 2;
          if (Math.random() < spreadChance) {
            var nb = freeNeighbors(bi);
            if (nb.length) G.grid[nb[(Math.random() * nb.length) | 0]] = 1;
          }
        }
        /* 3) Gesundheit: sinkt bei viel Feuer, erholt sich bei wenig */
        var burn = countBurning();
        var delta = (burn > COMFORT)
          ? (COMFORT - burn) * (0.8 + wave * 0.35)
          : (COMFORT - burn) * 0.6;
        G.health = Math.max(0, Math.min(100, G.health + delta));
        if (burn > G.peak) G.peak = burn;
        dirty = true;
      }

      function freeCells() { var r = []; for (var i = 0; i < N; i++) if (G.grid[i] === 0) r.push(i); return r; }
      function freeNeighbors(i) {
        var r = [], row = (i / COLS) | 0, col = i % COLS;
        if (row > 0 && G.grid[i - COLS] === 0) r.push(i - COLS);
        if (row < ROWS - 1 && G.grid[i + COLS] === 0) r.push(i + COLS);
        if (col > 0 && G.grid[i - 1] === 0) r.push(i - 1);
        if (col < COLS - 1 && G.grid[i + 1] === 0) r.push(i + 1);
        return r;
      }
      function countBurning() { var c = 0; for (var i = 0; i < N; i++) if (G.grid[i] >= 1) c++; return c; }

      /* ---- Löschen (Host-autoritativ). Gibt true, wenn wirklich reduziert. ---- */
      function extinguish(i, byName) {
        var hp = G.grid[i] || 0;
        if (hp <= 0) return false;
        if (hp === 1) G.ext++;                 // Brand komplett aus → zählt als "gelöscht"
        G.grid[i] = hp - 1;
        G.lastExt = { n: byName || '', i: i, s: ++extSeq };
        dirty = true;
        return true;
      }

      /* ============================ AKTIONEN ============================ */
      function tap(i) {
        if (destroyed || finished || !G) return;
        if (nowFn() >= G.endAt) return;
        var hp = G.grid[i] || 0;
        if (hp <= 0) return;                   // nichts brennt hier

        if (isMulti && !amHost()) {
          /* Gast: optimistisch anzeigen + Intent senden */
          G.grid[i] = hp - 1;
          renderFromG();
          poof(i, null);
          mySeq++;
          pending.push({ s: mySeq, i: i });
          if (pending.length > 16) pending.shift();
          room.reportState({ q: pending, n: myName, t: nowFn() });
        } else {
          /* Host / Solo: direkt anwenden */
          if (extinguish(i, myName)) {
            renderFromG();
            poof(i, null);
            if (isMulti) { pushShared(); lastPush = nowFn(); dirty = false; }
          }
        }
      }

      /* ---- Host: fremde Intents anwenden + Team-HUD aktualisieren ---- */
      function onPlayers() {
        if (destroyed) return;
        renderTeam();
        if (!amHost()) return;
        var ps = room.players(), changed = false;
        for (var p = 0; p < ps.length; p++) {
          var pl = ps[p];
          if (pl.id === room.id) continue;     // eigener State läuft direkt
          var st = pl.state; if (!st) continue;
          var q = st.q;
          if (Array.isArray(q)) {
            for (var e = 0; e < q.length; e++) {
              var it = q[e];
              if (it && it.s > (lastSeq[pl.id] || 0)) {
                lastSeq[pl.id] = it.s;
                if (extinguish(it.i, pl.name || st.n || '')) { changed = true; poof(it.i, pl.name || st.n); }
              }
            }
          } else if (typeof st.seq === 'number' && st.seq > (lastSeq[pl.id] || 0)) {
            lastSeq[pl.id] = st.seq;
            if (st.act && st.act.type === 'ext' && extinguish(st.act.i, pl.name)) { changed = true; poof(st.act.i, pl.name); }
          }
        }
        if (changed) { renderFromG(); if (isMulti) { pushShared(); lastPush = nowFn(); dirty = false; } }
      }

      /* ---- Gäste: geteilten Zustand übernehmen ---- */
      function onShared(sh) { applyShared(sh); }
      function applyShared(sh) {
        if (destroyed || !G) return;
        if (isMulti && amHost()) return;       // Host ist die Quelle
        if (!sh) return;
        if (typeof sh.g === 'string' && sh.g.length >= N) {
          for (var i = 0; i < N; i++) G.grid[i] = (+sh.g.charAt(i)) || 0;
        }
        if (typeof sh.hp === 'number') G.health = sh.hp;
        if (typeof sh.wv === 'number') G.wave = sh.wv;
        if (typeof sh.ext === 'number') G.ext = sh.ext;
        if (typeof sh.peak === 'number') G.peak = sh.peak;
        if (sh.sa) G.startAt = sh.sa;
        if (sh.ea) G.endAt = sh.ea;
        /* "von <Name>"-Effekt für Löschungen anderer Spieler */
        if (sh.lx && sh.lx.s > lastExtSeen) {
          lastExtSeen = sh.lx.s;
          if (sh.lx.n && sh.lx.n !== myName) poof(sh.lx.i, sh.lx.n);
        }
        renderFromG();
        if (sh.over && !finished) endGame(!!sh.win);
      }

      /* ============================ RENDER ============================ */
      function renderFromG() {
        if (destroyed || !G || !cells.length) return;
        for (var i = 0; i < N; i++) {
          var hp = G.grid[i] || 0, cell = cells[i];
          if (cell.__hp !== hp) {
            var wasHp = cell.__hp;
            cell.__hp = hp;
            cell.setAttribute('data-hp', String(hp));
            cell.__em.textContent = hp >= 1 ? '🔥' : '🌳';
            if (wasHp === 0 && hp >= 1 && App.Audio) App.Audio.sfx('tick');  // neuer Brand
          }
        }
        var h = Math.max(0, Math.round(G.health));
        barFill.style.width = h + '%';
        var cls = h > 55 ? 'ok' : (h > 25 ? 'warn' : 'crit');
        barFill.className = 'mg-cf-bar-fill ' + cls;
        healthNum.textContent = h + '%';

        fireNum.textContent = String(countBurning());
        waveNum.textContent = String(G.wave);
        if (G.ext !== lastExtCount) {
          lastExtCount = G.ext;
          extNum.textContent = String(G.ext);
          extNum.classList.remove('mg-cf-bump'); void extNum.offsetWidth; extNum.classList.add('mg-cf-bump');
        }

        /* Wellen-/Gefahr-Hinweise (auf jedem Client aus dem geteilten Zustand) */
        if (G.wave !== shownWave) {
          if (shownWave !== 0 && G.wave > shownWave) UI.toast('🌊 Welle ' + G.wave + ' – es brennt heftiger!', 'info');
          shownWave = G.wave;
        }
        if (h <= 25 && !critWarned) {
          critWarned = true; gridEl.classList.add('mg-cf-danger');
          UI.toast('⚠️ Der Dschungel brennt aus – löscht schnell!', 'lose');
        } else if (h > 35 && critWarned) {
          critWarned = false; gridEl.classList.remove('mg-cf-danger');
        }
      }

      function renderTeam() {
        if (destroyed || !teamNames) return;
        var ps = isMulti ? room.players() : [{ id: 'solo', name: myName }];
        teamCount.textContent = String(ps.length);
        teamNames.innerHTML = '';
        ps.forEach(function (p) {
          var mine = isMulti ? (p.id === room.id) : true;
          teamNames.appendChild(el('span', { class: 'mg-cf-chip' + (mine ? ' me' : '') }, [
            '🧑‍🚒 ' + p.name + (mine ? ' (du)' : '')
          ]));
        });
      }

      /* Wasser-Spritzer + schwebendes "💧 Name" über der gelöschten Zelle. */
      function poof(i, label) {
        if (destroyed || !gridEl) return;
        var cell = cells[i]; if (!cell) return;
        if (App.Audio) App.Audio.sfx('whoosh');
        cell.classList.remove('mg-cf-splash'); void cell.offsetWidth; cell.classList.add('mg-cf-splash');
        after(620, function () { if (cell) cell.classList.remove('mg-cf-splash'); });
        var f = el('div', { class: 'mg-cf-float' + (label ? ' named' : '') }, [label ? ('💧 ' + label) : '💧']);
        f.style.left = (cell.offsetLeft + cell.offsetWidth / 2) + 'px';
        f.style.top = (cell.offsetTop + cell.offsetHeight / 2) + 'px';
        gridEl.appendChild(f);
        after(20, function () { if (f.parentNode) f.classList.add('go'); });
        after(780, function () { if (f.parentNode) f.parentNode.removeChild(f); });
      }

      /* ---- Netz-Push (nur Host, nur Multi) ---- */
      function pushShared() {
        if (!isMulti || !G) return;
        var s = '';
        for (var i = 0; i < N; i++) s += String(G.grid[i] || 0);
        room.setShared({
          g: s, hp: Math.round(G.health), wv: G.wave, ext: G.ext, peak: G.peak,
          lx: G.lastExt || null, over: !!G.over, win: !!G.win, sa: G.startAt, ea: G.endAt
        });
      }

      /* ============================ ENDE ============================ */
      function endHost(win) {
        if (finished || !G) return;
        G.over = true; G.win = !!win;
        if (isMulti) pushShared();             // over/win an alle
        endGame(!!win);
      }

      function endGame(win) {
        if (finished) return;
        finished = true;
        clearAll();
        // Bei Sieg: geschafftes Level in der Bestenliste hochzählen (genau einmal, Guard: finished)
        if (win && App.Scores) App.Scores.winCurrent();
        var survived = Math.round(Math.min(LEVEL, Math.max(0, (nowFn() - (G ? G.startAt : nowFn())) / 1000)));
        var ext = G ? G.ext : 0, wave = G ? G.wave : 1, peak = G ? G.peak : 0;
        MG.teamEnd(root, {
          win: win,
          title: win ? 'Dschungel gerettet!' : 'Alles abgebrannt',
          subtitle: win
            ? 'Ihr habt die Flammen im Griff behalten – starke Teamleistung! 🌳'
            : 'Die Flammen waren zu stark. Teilt euch beim nächsten Mal besser auf! 🔥',
          lines: [
            'Durchgehalten: ' + survived + ' s',
            'Brände gelöscht: ' + ext,
            'Höchste Welle: ' + wave,
            'Meiste Brände gleichzeitig: ' + peak
          ],
          onExit: ctx.onExit,
          exitLabel: isMulti ? 'Zurück zur Lobby' : 'Zurück',
          onAgain: isMulti ? null : function () { if (destroyed) return; finished = false; play(Date.now()); }
        });
      }
    }
  };

  /* ============================ STYLES ============================ */
  function injectStyle() {
    UI.injectStyle('mg-coopfire-css', [
      '.mg-cf-wrap{display:flex;flex-direction:column;gap:12px;}',
      /* HUD */
      '.mg-cf-hud{display:flex;flex-direction:column;gap:12px;padding:14px 16px;}',
      '.mg-cf-health{display:flex;flex-direction:column;gap:6px;}',
      '.mg-cf-hrow{display:flex;justify-content:space-between;align-items:baseline;gap:10px;}',
      '.mg-cf-hlabel{font-size:12px;font-weight:800;text-transform:uppercase;letter-spacing:1px;color:var(--leaf);}',
      '.mg-cf-hnum{font-size:clamp(18px,4.6vw,22px);color:var(--leaf);font-variant-numeric:tabular-nums;}',
      '.mg-cf-bar{height:16px;border-radius:999px;background:rgba(4,16,10,.8);border:1px solid var(--stroke);overflow:hidden;position:relative;}',
      '.mg-cf-bar-fill{height:100%;width:100%;border-radius:999px;transition:width .45s ease,background .45s ease,box-shadow .45s ease;}',
      '.mg-cf-bar-fill.ok{background:linear-gradient(90deg,#2aa54a,var(--neon));box-shadow:0 0 14px rgba(57,255,20,.5);}',
      '.mg-cf-bar-fill.warn{background:linear-gradient(90deg,#c79320,var(--gold));box-shadow:0 0 14px rgba(255,210,63,.5);}',
      '.mg-cf-bar-fill.crit{background:linear-gradient(90deg,#b02038,var(--danger));box-shadow:0 0 16px rgba(255,77,109,.65);animation:mg-cf-critbar .8s ease-in-out infinite;}',
      '@keyframes mg-cf-critbar{50%{filter:brightness(1.35);}}',
      '.mg-cf-stats{display:flex;gap:10px;flex-wrap:wrap;justify-content:space-between;}',
      '.mg-cf-stat{display:flex;flex-direction:column;align-items:center;line-height:1.05;flex:1;min-width:64px;}',
      '.mg-cf-stat b,.mg-cf-stat .mg-cf-timer{font-size:clamp(16px,4.4vw,22px);color:var(--gold);text-shadow:0 0 10px rgba(255,210,63,.4);font-variant-numeric:tabular-nums;}',
      '.mg-cf-stat span{font-size:10px;text-transform:uppercase;letter-spacing:1.2px;color:var(--muted);margin-top:3px;}',
      '.mg-cf-timer{color:var(--aqua-soft) !important;text-shadow:0 0 10px rgba(51,230,208,.4) !important;}',
      '.mg-cf-timer.mg-cf-urgent{color:var(--danger) !important;animation:mg-cf-blink .7s steps(2) infinite;}',
      '@keyframes mg-cf-blink{50%{opacity:.4;}}',
      '.mg-cf-bump{animation:mg-cf-bump .35s ease;}',
      '@keyframes mg-cf-bump{0%{transform:scale(1);}40%{transform:scale(1.4);color:var(--neon);}100%{transform:scale(1);}}',
      /* Team */
      '.mg-cf-team{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:10px 14px;}',
      '.mg-cf-team-h{font-size:12px;font-weight:800;text-transform:uppercase;letter-spacing:1px;color:var(--aqua-soft);}',
      '.mg-cf-team-names{display:flex;gap:6px;flex-wrap:wrap;}',
      '.mg-cf-chip{font-size:12px;font-weight:700;padding:4px 10px;border-radius:999px;background:rgba(9,32,21,.7);border:1px solid var(--stroke);color:var(--muted);}',
      '.mg-cf-chip.me{color:var(--leaf);border-color:var(--stroke-2);box-shadow:var(--glow-soft);}',
      /* Gitter */
      '.mg-cf-board{display:flex;justify-content:center;}',
      '.mg-cf-grid{position:relative;display:grid;grid-template-columns:repeat(6,1fr);gap:clamp(4px,1.6vw,8px);width:min(94vw,460px);padding:6px;border-radius:16px;background:radial-gradient(circle at 50% 20%,rgba(57,255,20,.06),transparent 70%);}',
      '.mg-cf-grid.mg-cf-danger{box-shadow:0 0 0 2px rgba(255,77,109,.5),0 0 26px rgba(255,77,109,.4);animation:mg-cf-dpulse 1s ease-in-out infinite;}',
      '@keyframes mg-cf-dpulse{50%{box-shadow:0 0 0 2px rgba(255,77,109,.9),0 0 34px rgba(255,77,109,.6);}}',
      '.mg-cf-cell{position:relative;aspect-ratio:1/1;display:flex;align-items:center;justify-content:center;border-radius:12px;cursor:pointer;padding:0;-webkit-tap-highlight-color:transparent;overflow:hidden;border:1px solid var(--stroke);transition:transform .12s ease,box-shadow .3s ease,background .3s ease;}',
      '.mg-cf-em{font-size:clamp(22px,7vw,40px);line-height:1;user-select:none;-webkit-user-select:none;pointer-events:none;filter:drop-shadow(0 1px 2px rgba(0,0,0,.5));}',
      /* frei = Baum */
      '.mg-cf-cell[data-hp="0"]{background:radial-gradient(circle at 50% 30%,rgba(57,255,20,.10),transparent 72%),linear-gradient(160deg,#0e3a24,#0a271a);}',
      '.mg-cf-cell[data-hp="0"] .mg-cf-em{animation:mg-cf-sway 3.4s ease-in-out infinite;}',
      '@keyframes mg-cf-sway{0%,100%{transform:rotate(-3deg);}50%{transform:rotate(3deg);}}',
      /* schwelt (1 Tap) */
      '.mg-cf-cell[data-hp="1"]{background:radial-gradient(circle at 50% 70%,rgba(255,150,40,.5),transparent 75%),linear-gradient(160deg,#3a2408,#241405);border-color:rgba(255,170,60,.5);box-shadow:inset 0 0 16px rgba(255,140,30,.35);}',
      '.mg-cf-cell[data-hp="1"] .mg-cf-em{font-size:clamp(17px,5.4vw,31px);filter:drop-shadow(0 0 6px rgba(255,150,40,.8)) saturate(.85) brightness(.95);animation:mg-cf-flick1 .5s ease-in-out infinite;}',
      '@keyframes mg-cf-flick1{0%,100%{opacity:.75;transform:scale(.9) translateY(1px);}50%{opacity:1;transform:scale(1) translateY(-1px);}}',
      /* brennt (2 Taps) */
      '.mg-cf-cell[data-hp="2"]{background:radial-gradient(circle at 50% 68%,rgba(255,90,30,.75),transparent 78%),linear-gradient(160deg,#5a1608,#2a0a04);border-color:rgba(255,90,40,.75);box-shadow:inset 0 0 22px rgba(255,70,20,.55),0 0 16px rgba(255,60,20,.45);}',
      '.mg-cf-cell[data-hp="2"] .mg-cf-em{filter:drop-shadow(0 0 10px rgba(255,80,20,.95)) brightness(1.1);animation:mg-cf-flick2 .28s ease-in-out infinite;}',
      '@keyframes mg-cf-flick2{0%{transform:scale(1) rotate(-4deg);}25%{transform:scale(1.12) rotate(3deg);}50%{transform:scale(.98) rotate(-2deg);}75%{transform:scale(1.14) rotate(4deg);}100%{transform:scale(1) rotate(-4deg);}}',
      '.mg-cf-cell:hover{transform:translateY(-2px);}',
      '.mg-cf-cell:active{transform:scale(.93);}',
      /* Lösch-Spritzer */
      '.mg-cf-cell.mg-cf-splash::after{content:"";position:absolute;inset:0;border-radius:12px;background:radial-gradient(circle,rgba(120,220,255,.85),rgba(80,180,255,.25) 45%,transparent 70%);animation:mg-cf-splash .6s ease-out forwards;pointer-events:none;}',
      '@keyframes mg-cf-splash{0%{opacity:.9;transform:scale(.4);}100%{opacity:0;transform:scale(1.3);}}',
      /* schwebender Lösch-Text */
      '.mg-cf-float{position:absolute;transform:translate(-50%,-50%);pointer-events:none;z-index:6;font-weight:900;font-size:15px;color:var(--aqua-soft);text-shadow:0 2px 6px rgba(0,0,0,.7);white-space:nowrap;transition:transform .75s ease-out,opacity .75s ease-out;opacity:1;}',
      '.mg-cf-float.named{font-size:12px;color:var(--leaf);background:rgba(4,16,10,.72);padding:2px 8px;border-radius:999px;border:1px solid var(--stroke-2);}',
      '.mg-cf-float.go{transform:translate(-50%,-150%);opacity:0;}',
      '.mg-cf-hint{margin:2px 0 0;text-align:center;}'
    ].join(''));
  }
})();
