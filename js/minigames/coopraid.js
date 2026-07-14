/* coopraid.js — "Drachen-Raid": KOOP-Bosskampf gegen den Dschungel-Drachen 🐉
 *
 * Alle Spieler teilen sich EINEN Zustand: eine dicke geteilte Boss-HP-Leiste und
 * eine geteilte TEAM-HP-Leiste. Zusammen tappt das Team den grossen ANGRIFF-Button
 * (Combo-Bonus bei schnellem Tappen), um die gemeinsame Boss-HP zu senken. Alle paar
 * Sekunden kuendigt der Boss einen Angriff an (⚠️ AUSWEICHEN!) — JEDER muss im Fenster
 * den AUSWEICHEN-Button tippen, sonst kostet es das Team HP. Bei 66 % / 33 % Boss-HP
 * wird der Drache wuetend (schneller, heftiger, roter Puls). Boss-HP 0 = Sieg,
 * Team-HP 0 (oder Zeit abgelaufen) = Niederlage.
 *
 * ARCHITEKTUR (host-autoritativ + Intents, siehe COOP_SPEC):
 *  - Nur der Host rechnet die Simulation (Boss-HP, Team-HP, Phase, Angriffs-Timer,
 *    Zufall) und pusht den Zustand gedrosselt (~140 ms) via room.setShared.
 *  - Spieler-Aktionen laufen als Intents ueber room.reportState:
 *      Angriff  -> kumulativer Schaden 'ad' (Combo lokal berechnet, gedrosselt gemeldet)
 *      Ausweichen -> 'dg' = Id des aktuellen Angriffs (sofort gemeldet)
 *    Der Host verrechnet die Deltas / registriert das Ausweichen genau einmal.
 *  - Der Host wendet seine EIGENEN Aktionen direkt auf G an (kein Umweg ueber Netz).
 *  - Gaeste rendern aus room.on('shared', …); der Host rendert aus seinem lokalen G.
 *  - Solo: ein Spieler, alles lokal, kleinere Boss-HP.
 *  - Host-Migration: wer host ist, treibt die Sim; ein neuer Host seedet G aus 'shared'.
 * Zeit ueber room.now()/Date.now(); Fenster/Phasen ueber Wall-Clock. */
(function () {
  'use strict';
  window.App = window.App || {}; App.Minigames = App.Minigames || {};
  var UI = App.UI, el = UI.el;

  /* ---- Balance / Timing ---- */
  var TIME_LIMIT = 120;            // s Fallback-Zeitlimit
  var PER_PLAYER = 480;            // Boss-HP pro Spieler (skaliert -> Teamwork)
  var TEAM_MAX = 100;              // geteilte Team-HP (Prozent)
  var FIRST_ATK_DELAY = 5000;      // ms Ruhe vor dem ersten Boss-Angriff
  var PUSH_MS = 140;               // Drossel fuer setShared
  var REPORT_MS = 140;             // Drossel fuer Angriffs-Intents (Gaeste)
  var COMBO_MS = 560;              // ms-Fenster fuer Combo-Kette
  var COMBO_CAP = 25, DMG_BASE = 1, DMG_COMBO = 0.06;

  function atkInterval(ph) { return ph >= 3 ? 4800 : ph >= 2 ? 6500 : 8500; }
  function dodgeWin(ph)    { return ph >= 3 ? 1500 : ph >= 2 ? 1700 : 1900; }
  function missFrac(ph)    { return ph >= 3 ? 0.40 : ph >= 2 ? 0.30 : 0.22; }
  function phaseFor(r)     { return r <= 0.33 ? 3 : r <= 0.66 ? 2 : 1; }
  function tapDamage(combo){ return DMG_BASE + Math.min(COMBO_CAP, combo) * DMG_COMBO; }

  injectStyle();

  App.Minigames.coopraid = {
    id: 'coopraid', title: 'Drachen-Raid', icon: '🐉', order: 22,
    subtitle: 'Besiegt den Dschungel-Drachen gemeinsam',
    coop: true, single: true, multi: true, minPlayers: 2, maxPlayers: 6,

    render: function (root, ctx) {
      var isMulti = ctx.mode === 'multi';
      var room = isMulti ? ctx.room : null;
      var me = ctx.me || { id: 'solo', name: 'Spieler' };
      var nowFn = isMulti ? room.now : Date.now;

      var destroyed = false;
      var ended = false;            // Spielende (Endscreen gezeigt)
      var stops = [];               // Aufraeum-Funktionen

      function addStop(fn) { if (fn) stops.push(fn); }
      function clearAll() {
        stops.forEach(function (f) { try { f(); } catch (e) {} });
        stops = [];
      }
      function cleanup() { destroyed = true; clearAll(); }

      /* Start: Multi wartet auf synchronen Countdown, Solo legt sofort los. */
      if (isMulti) {
        var snap = room.snapshot() || {};
        var startAt = (snap.round && snap.round.startAt) || (room.now() + 3000);
        addStop(App.MG.countdown(root, startAt, function () { play(startAt); }, room.now));
      } else {
        play(Date.now());
      }
      return { cleanup: cleanup };

      /* ============================ RUNDE ============================ */
      function play(playStart) {
        clearAll();                 // evtl. Countdown-Timer stoppen
        ended = false;

        var playEnd = playStart + TIME_LIMIT * 1000;

        /* ---- Host-Zustand (nur beim Host massgeblich) ---- */
        var G = null, hostReady = false, seenDmg = {}, lastPush = 0, lastShared = {};

        /* ---- Lokaler Spieler-Zustand (Intents) ---- */
        var myDmg = 0, myDodgeId = -1, dirty = false;
        var combo = 0, lastTap = 0, punch = 0, myDodgedLocal = false;

        /* ---- Render-Merker ---- */
        var prevBossHp = null, prevTeamHp = null, lastMsgId = -1;
        var curAtk = { active: false }, overlayAtkId = null, lastRosterKey = '';

        function amHost() { return room ? room.isHost() : true; }
        function rosterPlayers() { return room ? room.players() : [{ id: me.id, name: me.name }]; }

        /* ===================== STAGE (einmal aufbauen) ===================== */
        var timerEl = el('div', { class: 'cr-timer' }, ['⏱ ' + App.MG.mmss(TIME_LIMIT)]);
        var teamCountEl = el('span', { class: 'cr-team-count' }, ['']);
        var teamFill = el('div', { class: 'cr-hpfill team' });
        var teamHpText = el('span', { class: 'cr-hp-num' }, [TEAM_MAX + ' %']);
        var teamBar = el('div', { class: 'cr-hpbar team' }, [teamFill,
          el('div', { class: 'cr-hp-cap' }, [el('span', { class: 'cr-hp-lbl' }, ['🛡️ Team-HP']), teamHpText])]);
        var rosterEl = el('div', { class: 'cr-roster' });
        var hud = el('div', { class: 'cr-hud glass' }, [
          el('div', { class: 'cr-hud-top' }, [timerEl, teamCountEl]),
          teamBar, rosterEl
        ]);

        var boss = el('div', { class: 'cr-boss' }, ['🐉']);
        var bossFill = el('div', { class: 'cr-hpfill boss' });
        var bossHpText = el('span', { class: 'cr-hp-num' }, ['…']);
        var bossBar = el('div', { class: 'cr-hpbar boss big' }, [bossFill,
          el('div', { class: 'cr-hp-cap' }, [el('span', { class: 'cr-hp-lbl' }, ['🐉 Drachen-HP']), bossHpText])]);
        var bannerEl = el('div', { class: 'cr-banner' });
        var bossWrap = el('div', { class: 'cr-boss-wrap' }, [bannerEl, boss, bossBar]);

        var comboEl = el('div', { class: 'cr-combo' });
        var attackBtn = el('button', { class: 'cr-attack', type: 'button', 'aria-label': 'Angreifen' }, [
          el('div', { class: 'cr-attack-ico' }, ['⚔️']),
          el('div', { class: 'cr-attack-lbl' }, ['ANGRIFF']),
          comboEl
        ]);

        /* Ausweichen-Overlay */
        var ringFill = el('div', { class: 'cr-ring-fill' });
        var dodgeBtn = el('button', { class: 'cr-dodge-btn', type: 'button' }, ['AUSWEICHEN!']);
        var dodgeTeam = el('div', { class: 'cr-dodge-team' });
        var overlayEl = el('div', { class: 'cr-dodge' }, [
          el('div', { class: 'cr-dodge-warn' }, ['⚠️ AUSWEICHEN!']),
          el('div', { class: 'cr-ring' }, [ringFill]),
          dodgeBtn,
          dodgeTeam
        ]);

        var stageEl = el('div', { class: 'cr-stage' }, [hud, bossWrap, attackBtn, overlayEl]);
        root.innerHTML = ''; root.appendChild(stageEl);

        /* ===================== INPUT ===================== */
        function registerAttack() {
          if (destroyed || ended) return;
          if (curAtk && curAtk.active) return;      // waehrend Ausweichen kein Angriff
          var now = Date.now();
          combo = (now - lastTap < COMBO_MS) ? combo + 1 : 1;
          lastTap = now;
          punch = Math.min(1.7, punch + 0.9);
          var dmg = tapDamage(combo);
          if (amHost()) { if (G && G.init) applyDamage(dmg); }
          else { myDmg += dmg; dirty = true; }
        }
        function registerDodge() {
          if (destroyed || ended) return;
          if (!curAtk || !curAtk.active) return;
          if (myDodgedLocal) return;
          myDodgedLocal = true;
          if (amHost()) { if (G) G.dodgers[me.id] = true; }
          else { myDodgeId = curAtk.id; sendState(); }
          dodgeBtn.disabled = true; dodgeBtn.classList.add('done'); dodgeBtn.textContent = '✔ AUSGEWICHEN';
        }
        function sendState() {
          if (!room) return;
          try { room.reportState({ ad: Math.round(myDmg * 100) / 100, dg: myDodgeId }); } catch (e) {}
        }

        bindPress(attackBtn, registerAttack, addStop);
        bindPress(dodgeBtn, registerDodge, addStop);
        function onKey(e) {
          if (e.repeat) return;
          if (e.code === 'Space' || e.key === ' ' || e.key === 'Enter') {
            e.preventDefault();
            if (curAtk && curAtk.active) registerDodge(); else registerAttack();
          }
        }
        document.addEventListener('keydown', onKey);
        addStop(function () { document.removeEventListener('keydown', onKey); });

        /* ===================== SIM-HELFER (Host) ===================== */
        function applyDamage(d) { if (!G) return; G.bossHp = Math.max(0, G.bossHp - d); G.totalDmg += d; }

        function setupFreshHost() {
          var n = Math.max(1, Math.min(6, rosterPlayers().length));
          var max = Math.round(PER_PLAYER * n);
          G = {
            init: true, bossMax: max, bossHp: max, teamMax: TEAM_MAX, teamHp: TEAM_MAX,
            ph: 1, atk: { active: false, id: 0, startAt: 0, endAt: 0 }, dodgers: {},
            nextAtkAt: playStart + FIRST_ATK_DELAY, totalDmg: 0, over: false, win: false,
            endAt: playEnd, atkCount: 0, msgCount: 0, msg: null
          };
          seenDmg = {}; hostReady = true;
          pushShared(true);
        }
        function seedHostFromShared() {
          var s = lastShared;
          if (s && typeof s.bh === 'number') {
            var id = (s.atk && s.atk.id) || 0;
            G = {
              init: true, bossMax: s.bm || PER_PLAYER, bossHp: s.bh,
              teamMax: s.tm || TEAM_MAX, teamHp: (typeof s.th === 'number' ? s.th : TEAM_MAX),
              ph: s.ph || 1, atk: { active: false, id: id, startAt: 0, endAt: 0 }, dodgers: {},
              nextAtkAt: nowFn() + atkInterval(s.ph || 1), totalDmg: s.td || 0,
              over: !!s.over, win: !!s.win, endAt: playEnd, atkCount: id, msgCount: 0, msg: null
            };
            seenDmg = {};
            rosterPlayers().forEach(function (p) { if (p.id !== me.id) seenDmg[p.id] = (p.state && +p.state.ad) || 0; });
            hostReady = true;
          } else {
            setupFreshHost();
          }
        }

        function startAttack(now) {
          G.atk = { active: true, id: ++G.atkCount, startAt: now, endAt: now + dodgeWin(G.ph) };
          G.dodgers = {};
          G.msg = { id: ++G.msgCount, kind: 'warn', text: '⚠️ Angriff! Weicht aus!' };
          pushShared(true);
        }
        function resolveAttack(now) {
          var roster = rosterPlayers(), n = Math.max(1, roster.length), missed = 0;
          for (var i = 0; i < roster.length; i++) if (!G.dodgers[roster[i].id]) missed++;
          if (missed > 0) {
            var dmg = Math.max(1, Math.round(missFrac(G.ph) * G.teamMax * missed / n));
            G.teamHp = Math.max(0, G.teamHp - dmg);
            G.msg = { id: ++G.msgCount, kind: 'hit', text: missed + '× getroffen! −' + dmg + ' Team-HP' };
          } else {
            G.msg = { id: ++G.msgCount, kind: 'perfect', text: 'Perfekt abgewehrt! 🛡️' };
          }
          G.atk = { active: false, id: G.atk.id, startAt: 0, endAt: 0 };
          G.nextAtkAt = now + atkInterval(G.ph);
          pushShared(true);
        }
        function endGame(win) {
          if (G.over) return;
          G.over = true; G.win = win;
          G.atk = { active: false, id: G.atk.id, startAt: 0, endAt: 0 };
          pushShared(true);
        }

        function simStep(now) {
          if (G.over) return;
          /* Intents der Gaeste verrechnen */
          if (room) {
            var ps = room.players();
            for (var i = 0; i < ps.length; i++) {
              var p = ps[i]; if (p.id === me.id) continue;
              var st = p.state || {};
              var ad = +st.ad || 0, seen = seenDmg[p.id] || 0;
              if (ad > seen) { applyDamage(ad - seen); seenDmg[p.id] = ad; }
              if (G.atk.active && st.dg === G.atk.id) G.dodgers[p.id] = true;
            }
          }
          /* Phase / Wut */
          var ratio = G.bossMax > 0 ? G.bossHp / G.bossMax : 0;
          var np = phaseFor(ratio);
          if (np > G.ph) { G.ph = np; pushShared(true); }
          /* Angriffs-Lebenszyklus */
          if (G.atk.active) { if (now >= G.atk.endAt) resolveAttack(now); }
          else if (now >= G.nextAtkAt) startAttack(now);
          /* Sieg / Niederlage */
          if (G.bossHp <= 0) { G.bossHp = 0; endGame(true); return; }
          if (G.teamHp <= 0) { G.teamHp = 0; endGame(false); return; }
          if (now >= G.endAt) { endGame(G.bossHp <= 0); return; }
        }

        function pushShared(force) {
          if (!room || !G) return;
          var now = nowFn();
          if (!force && now - lastPush < PUSH_MS) return;
          lastPush = now;
          try {
            room.setShared({
              bh: G.bossHp, bm: G.bossMax, th: G.teamHp, tm: G.teamMax, ph: G.ph,
              atk: { active: G.atk.active, id: G.atk.id, startAt: G.atk.startAt, endAt: G.atk.endAt },
              dg: Object.assign({}, G.dodgers), td: Math.round(G.totalDmg),
              msg: G.msg || null, over: G.over, win: G.win
            });
          } catch (e) {}
        }

        /* ===================== RENDER ===================== */
        function renderView(v) {
          if (destroyed || ended) return;
          var bp = v.bossMax > 0 ? Math.max(0, v.bossHp) / v.bossMax : 0;
          bossFill.style.width = (bp * 100).toFixed(2) + '%';
          bossHpText.textContent = Math.ceil(Math.max(0, v.bossHp)) + ' / ' + Math.round(v.bossMax);
          bossFill.classList.toggle('low', bp <= 0.33);
          boss.classList.toggle('rage', v.ph >= 2);
          boss.classList.toggle('rage2', v.ph >= 3);
          stageEl.classList.toggle('enraged', v.ph >= 2);
          stageEl.classList.toggle('enraged2', v.ph >= 3);
          if (prevBossHp != null && v.bossHp < prevBossHp - 0.01) { flashBoss(); spawnDmg(prevBossHp - v.bossHp); }
          prevBossHp = v.bossHp;

          var tp = v.teamMax > 0 ? Math.max(0, v.teamHp) / v.teamMax : 0;
          teamFill.style.width = (tp * 100).toFixed(2) + '%';
          teamHpText.textContent = Math.max(0, Math.ceil(v.teamHp)) + ' %';
          teamFill.classList.toggle('low', tp <= 0.3);
          if (prevTeamHp != null && v.teamHp < prevTeamHp - 0.01) hurtFlash();
          prevTeamHp = v.teamHp;

          var a = v.atk || { active: false };
          curAtk = a;
          if (a.active) showOverlay(a, v.dodgers || {}); else hideOverlay();
          attackBtn.classList.toggle('dim', a.active);

          if (v.msg && v.msg.id !== lastMsgId) { lastMsgId = v.msg.id; showBanner(v.msg); }
          updateRosterChecks(a, v.dodgers || {});

          if (v.over) finishGame(!!v.win, v.totalDmg, v.teamHp);
        }

        function buildRoster() {
          var ps = rosterPlayers();
          rosterEl.innerHTML = '';
          ps.forEach(function (p) {
            var status = el('span', { class: 'cr-mate-st' }, ['●']);
            var row = el('div', { class: 'cr-mate' + (p.id === me.id ? ' me' : ''), dataset: { id: p.id } }, [
              status,
              el('span', { class: 'cr-mate-name' }, [p.name + (p.id === me.id ? ' (du)' : '')])
            ]);
            rosterEl.appendChild(row);
          });
          teamCountEl.textContent = '🤝 ' + ps.length + (ps.length === 1 ? ' Spieler' : ' Spieler');
        }
        function updateRosterChecks(a, dodgers) {
          var rows = rosterEl.children;
          for (var i = 0; i < rows.length; i++) {
            var id = rows[i].dataset.id, st = rows[i].querySelector('.cr-mate-st');
            var ok = !!dodgers[id] || (id === me.id && myDodgedLocal);
            if (a.active) {
              rows[i].classList.toggle('ok', ok);
              rows[i].classList.toggle('wait', !ok);
              st.textContent = ok ? '✔' : '…';
            } else {
              rows[i].classList.remove('ok', 'wait');
              st.textContent = '●';
            }
          }
        }

        function showOverlay(a, dodgers) {
          if (overlayAtkId !== a.id) {
            overlayAtkId = a.id;
            myDodgedLocal = !!dodgers[me.id];
            buildDodgeTeam();
          }
          overlayEl.classList.add('show');
          var iDodged = myDodgedLocal || !!dodgers[me.id];
          dodgeBtn.disabled = iDodged;
          dodgeBtn.classList.toggle('done', iDodged);
          dodgeBtn.textContent = iDodged ? '✔ AUSGEWICHEN' : 'AUSWEICHEN!';
          updateDodgeTeam(dodgers);
        }
        function hideOverlay() {
          if (overlayAtkId !== null) { overlayEl.classList.remove('show'); overlayAtkId = null; }
        }
        function buildDodgeTeam() {
          var ps = rosterPlayers();
          dodgeTeam.innerHTML = '';
          ps.forEach(function (p) {
            dodgeTeam.appendChild(el('div', { class: 'cr-dt-chip wait', dataset: { id: p.id } }, [
              el('span', { class: 'cr-dt-ic' }, ['…']),
              el('span', {}, [p.id === me.id ? 'Du' : p.name])
            ]));
          });
        }
        function updateDodgeTeam(dodgers) {
          var chips = dodgeTeam.children;
          for (var i = 0; i < chips.length; i++) {
            var id = chips[i].dataset.id;
            var ok = !!dodgers[id] || (id === me.id && myDodgedLocal);
            chips[i].classList.toggle('ok', ok);
            chips[i].classList.toggle('wait', !ok);
            chips[i].querySelector('.cr-dt-ic').textContent = ok ? '✔' : '…';
          }
        }

        function showBanner(msg) {
          bannerEl.textContent = msg.text;
          bannerEl.className = 'cr-banner ' + (msg.kind || '');
          void bannerEl.offsetWidth;
          bannerEl.classList.add('show');
        }
        function flashBoss() { boss.classList.remove('hit'); void boss.offsetWidth; boss.classList.add('hit'); }
        function hurtFlash() { stageEl.classList.remove('hurt'); void stageEl.offsetWidth; stageEl.classList.add('hurt'); }
        function spawnDmg(d) {
          if (bossWrap.querySelectorAll('.cr-dmg').length > 14) return;
          var f = el('div', { class: 'cr-dmg' }, ['-' + Math.max(1, Math.round(d))]);
          f.style.left = (34 + Math.random() * 32) + '%';
          bossWrap.appendChild(f);
          requestAnimationFrame(function () { f.classList.add('go'); });
          setTimeout(function () { if (f.parentNode) f.parentNode.removeChild(f); }, 760);
        }

        /* ===================== ENDE ===================== */
        function finishGame(win, totalDmg, teamLeft) {
          if (ended) return; ended = true;
          clearAll();
          // Bei Sieg: besiegtes Level (Drache down) in der Bestenliste hochzählen (genau einmal, Guard: ended)
          if (win && App.Scores) App.Scores.winCurrent();
          var reason = win ? 'Ihr habt den Drachen gemeinsam bezwungen!'
            : (teamLeft <= 0 ? 'Das Team wurde vom Drachen ueberwaeltigt.'
                             : 'Die Zeit lief ab – der Drache lebt noch.');
          App.MG.teamEnd(root, {
            win: win,
            title: win ? 'Drache besiegt! 🐉' : 'Das Team ist gefallen',
            subtitle: reason,
            lines: [
              'Schaden gesamt: ' + App.MG.fmt(Math.round(totalDmg || 0)),
              'Team-HP uebrig: ' + Math.max(0, Math.ceil(teamLeft || 0)) + ' %'
            ],
            onExit: ctx.onExit,
            exitLabel: isMulti ? 'Zurueck zur Lobby' : 'Zurueck',
            onAgain: isMulti ? null : function () { ended = false; play(Date.now()); }
          });
        }

        /* ===================== TIMER (nur Anzeige) ===================== */
        addStop(App.MG.roundTimer(playEnd, function (left) {
          var secs = Math.ceil(left);
          timerEl.textContent = '⏱ ' + App.MG.mmss(secs);
          timerEl.classList.toggle('urgent', secs <= 15);
        }, function () {}, isMulti ? room.now : null));

        /* ===================== LOOPS + NETZ ===================== */
        // Host initial aufsetzen (Gaeste warten auf 'shared').
        if (amHost()) setupFreshHost();
        buildRoster();

        var mainIv = setInterval(function () {
          if (destroyed || ended) return;
          if (!amHost()) { hostReady = false; return; }
          if (!hostReady) seedHostFromShared();
          simStep(nowFn());
          renderView(G);
          pushShared(false);
        }, 100);
        addStop(function () { clearInterval(mainIv); });

        var visIv = setInterval(function () {
          if (destroyed || ended) return;
          punch *= 0.82; if (punch < 0.003) punch = 0;
          attackBtn.style.transform = 'scale(' + (1 + punch * 0.08).toFixed(3) + ')';
          if (combo > 0 && Date.now() - lastTap > COMBO_MS) combo = 0;
          comboEl.textContent = combo >= 3 ? ('COMBO x' + combo) : '';
          comboEl.style.opacity = combo >= 3 ? '1' : '0';
          attackBtn.classList.toggle('hot', combo >= 8);
          attackBtn.classList.toggle('fire', combo >= 16);
          if (curAtk && curAtk.active) {
            var dur = (curAtk.endAt - curAtk.startAt) || 1;
            var rem = Math.max(0, Math.min(1, (curAtk.endAt - nowFn()) / dur));
            ringFill.style.width = (rem * 100).toFixed(1) + '%';
            ringFill.classList.toggle('crit', rem < 0.34);
          }
        }, 70);
        addStop(function () { clearInterval(visIv); });

        if (room) {
          var repIv = setInterval(function () {
            if (destroyed || ended) return;
            if (!room.isHost() && dirty) { sendState(); dirty = false; }
          }, REPORT_MS);
          addStop(function () { clearInterval(repIv); });

          var onShared = function (s) {
            if (destroyed || ended) return;
            if (s && typeof s.bh === 'number') lastShared = s;
            if (room.isHost()) return;                 // Host rendert aus G
            var sh = s || {};
            if (typeof sh.bh !== 'number') return;
            renderView({
              bossHp: sh.bh, bossMax: sh.bm || 1,
              teamHp: (typeof sh.th === 'number' ? sh.th : TEAM_MAX), teamMax: sh.tm || TEAM_MAX,
              ph: sh.ph || 1, atk: sh.atk || { active: false }, dodgers: sh.dg || {},
              totalDmg: sh.td || 0, msg: sh.msg || null, over: !!sh.over, win: !!sh.win
            });
          };
          var onPlayers = function () {
            if (destroyed || ended) return;
            var key = room.players().map(function (p) { return p.id; }).join(',');
            if (key !== lastRosterKey) { lastRosterKey = key; buildRoster(); }
          };
          lastRosterKey = room.players().map(function (p) { return p.id; }).join(',');
          room.on('shared', onShared);
          room.on('players', onPlayers);
          addStop(function () { room.off('shared', onShared); room.off('players', onPlayers); });
        }
      }
    }
  };

  /* ===================== INPUT-HELFER ===================== */
  function bindPress(node, handler, addStop) {
    if ('PointerEvent' in window) {
      var onP = function (e) { e.preventDefault(); handler(); };
      node.addEventListener('pointerdown', onP);
      addStop(function () { node.removeEventListener('pointerdown', onP); });
    } else {
      var onT = function (e) { e.preventDefault(); handler(); };
      var onM = function (e) { e.preventDefault(); handler(); };
      node.addEventListener('touchstart', onT, { passive: false });
      node.addEventListener('mousedown', onM);
      addStop(function () { node.removeEventListener('touchstart', onT); node.removeEventListener('mousedown', onM); });
    }
  }

  /* ============================ STYLES ============================ */
  function injectStyle() {
    UI.injectStyle('mg-coopraid-css', [
      '.cr-stage{position:relative;display:flex;flex-direction:column;gap:16px;align-items:stretch;}',
      '.cr-stage.hurt{animation:cr-hurt .5s ease;}',
      '@keyframes cr-hurt{0%,100%{filter:none;}25%{filter:brightness(1.05) saturate(1.4);}50%{transform:translateX(-4px);}75%{transform:translateX(4px);}}',
      '.cr-stage.enraged2{animation:cr-rage-vig 1.5s ease-in-out infinite;}',
      '@keyframes cr-rage-vig{0%,100%{box-shadow:inset 0 0 0 rgba(255,77,109,0);}50%{box-shadow:inset 0 0 120px rgba(255,77,109,.22);border-radius:var(--radius,16px);}}',
      /* HUD */
      '.cr-hud{padding:14px 18px;display:flex;flex-direction:column;gap:12px;}',
      '.cr-hud-top{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;}',
      '.cr-timer{font-size:clamp(22px,6vw,34px);font-weight:900;line-height:1;color:var(--aqua-soft);text-shadow:0 0 14px rgba(51,230,208,.4);font-variant-numeric:tabular-nums;}',
      '.cr-timer.urgent{color:var(--danger);text-shadow:0 0 16px rgba(255,77,109,.6);animation:cr-blink .6s steps(2,end) infinite;}',
      '@keyframes cr-blink{50%{opacity:.5;}}',
      '.cr-team-count{font-weight:800;color:var(--gold);font-size:14px;}',
      /* HP-Balken */
      '.cr-hpbar{position:relative;height:22px;border-radius:999px;background:rgba(4,16,10,.85);border:1px solid var(--stroke-2);overflow:hidden;}',
      '.cr-hpbar.big{height:34px;}',
      '.cr-hpfill{height:100%;width:100%;border-radius:999px;transition:width .18s ease;}',
      '.cr-hpfill.team{background:linear-gradient(90deg,var(--aqua),var(--neon));box-shadow:0 0 14px rgba(57,255,20,.45) inset;}',
      '.cr-hpfill.team.low{background:linear-gradient(90deg,#ff8a5c,var(--danger));}',
      '.cr-hpfill.boss{background:linear-gradient(90deg,#ff3b6b,var(--gold));box-shadow:0 0 16px rgba(255,210,63,.4) inset;}',
      '.cr-hpfill.boss.low{background:linear-gradient(90deg,#b81030,var(--danger));}',
      '.cr-hp-cap{position:absolute;inset:0;display:flex;align-items:center;justify-content:space-between;padding:0 12px;font-weight:900;font-size:12px;text-shadow:0 1px 3px rgba(0,0,0,.7);pointer-events:none;}',
      '.cr-hpbar.big .cr-hp-cap{font-size:14px;}',
      '.cr-hp-lbl{letter-spacing:.5px;color:#eafff0;}',
      '.cr-hp-num{color:#fff;font-variant-numeric:tabular-nums;}',
      /* Roster */
      '.cr-roster{display:flex;flex-wrap:wrap;gap:6px;}',
      '.cr-mate{display:flex;align-items:center;gap:6px;padding:4px 10px;border-radius:999px;background:rgba(9,32,21,.6);border:1px solid var(--stroke);font-size:12px;font-weight:700;}',
      '.cr-mate.me{border-color:var(--stroke-2);color:var(--leaf);}',
      '.cr-mate-st{font-size:12px;color:var(--muted);}',
      '.cr-mate.ok{border-color:var(--neon);color:var(--leaf);}.cr-mate.ok .cr-mate-st{color:var(--neon);}',
      '.cr-mate.wait{border-color:var(--danger);}.cr-mate.wait .cr-mate-st{color:var(--danger);animation:cr-blink .6s steps(2,end) infinite;}',
      /* Boss */
      '.cr-boss-wrap{position:relative;display:flex;flex-direction:column;align-items:center;gap:14px;padding:10px 0 4px;}',
      '.cr-boss{font-size:clamp(90px,26vw,168px);line-height:1;filter:drop-shadow(0 10px 22px rgba(0,0,0,.55));animation:cr-float 3.2s ease-in-out infinite;user-select:none;}',
      '@keyframes cr-float{0%,100%{transform:translateY(0) rotate(-2deg);}50%{transform:translateY(-16px) rotate(2deg);}}',
      '.cr-boss.rage{filter:drop-shadow(0 0 26px rgba(255,150,40,.6));animation:cr-float 2.2s ease-in-out infinite;}',
      '.cr-boss.rage2{filter:drop-shadow(0 0 30px rgba(255,60,90,.75));animation:cr-shake .28s ease-in-out infinite;}',
      '@keyframes cr-shake{0%,100%{transform:translate(0,0) rotate(0);}25%{transform:translate(-6px,-4px) rotate(-3deg);}75%{transform:translate(6px,-4px) rotate(3deg);}}',
      '.cr-boss.hit{animation:cr-hit .18s ease;}',
      '@keyframes cr-hit{0%{filter:brightness(2.4) drop-shadow(0 0 30px #fff);transform:scale(.94);}100%{filter:none;transform:scale(1);}}',
      '.cr-boss-wrap .cr-hpbar{width:min(94%,560px);}',
      '.cr-dmg{position:absolute;top:34%;font-weight:900;font-size:clamp(18px,5vw,30px);color:var(--gold);text-shadow:0 2px 8px rgba(0,0,0,.7);pointer-events:none;transform:translate(-50%,0);transition:transform .75s cubic-bezier(.2,.7,.3,1),opacity .75s ease-out;opacity:1;}',
      '.cr-dmg.go{transform:translate(-50%,-70px) scale(1.15);opacity:0;}',
      /* Banner */
      '.cr-banner{position:absolute;top:-2px;left:50%;transform:translate(-50%,-6px);padding:7px 16px;border-radius:999px;font-weight:900;font-size:14px;background:rgba(4,16,10,.9);border:1px solid var(--stroke-2);color:var(--text);opacity:0;pointer-events:none;z-index:4;white-space:nowrap;}',
      '.cr-banner.show{animation:cr-banner 1.6s ease forwards;}',
      '@keyframes cr-banner{0%{opacity:0;transform:translate(-50%,4px) scale(.9);}15%{opacity:1;transform:translate(-50%,-6px) scale(1);}80%{opacity:1;}100%{opacity:0;transform:translate(-50%,-14px);}}',
      '.cr-banner.hit{color:var(--danger);border-color:var(--danger);}',
      '.cr-banner.perfect{color:var(--neon);border-color:var(--neon);}',
      '.cr-banner.warn{color:var(--gold);border-color:var(--gold);}',
      /* Angriff-Button */
      '.cr-attack{position:relative;width:100%;min-height:clamp(96px,20vh,150px);border-radius:22px;border:3px solid var(--neon);cursor:pointer;font-family:inherit;color:var(--text);',
      'display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;',
      'background:radial-gradient(circle at 50% 30%,rgba(57,255,20,.34),rgba(9,32,21,.95) 72%);',
      'box-shadow:0 0 40px rgba(57,255,20,.3),inset 0 0 40px rgba(57,255,20,.14);',
      'touch-action:manipulation;user-select:none;-webkit-user-select:none;-webkit-tap-highlight-color:transparent;will-change:transform;}',
      '.cr-attack.hot{border-color:var(--gold);box-shadow:0 0 46px rgba(255,210,63,.4),inset 0 0 44px rgba(255,210,63,.18);}',
      '.cr-attack.fire{border-color:var(--danger);box-shadow:0 0 50px rgba(255,77,109,.45),inset 0 0 46px rgba(255,77,109,.2);}',
      '.cr-attack.dim{opacity:.35;filter:saturate(.6);pointer-events:none;}',
      '.cr-attack-ico{font-size:clamp(30px,8vw,44px);line-height:1;}',
      '.cr-attack-lbl{font-size:clamp(18px,5vw,26px);font-weight:900;letter-spacing:3px;color:var(--leaf);text-shadow:0 0 16px rgba(57,255,20,.5);}',
      '.cr-combo{position:absolute;top:8px;right:14px;font-weight:900;font-size:13px;color:var(--gold);opacity:0;transition:opacity .15s ease;text-shadow:0 0 10px rgba(255,210,63,.6);}',
      /* Ausweichen-Overlay */
      '.cr-dodge{position:absolute;inset:0;display:none;flex-direction:column;align-items:center;justify-content:center;gap:18px;z-index:6;border-radius:var(--radius,16px);',
      'background:radial-gradient(circle at 50% 40%,rgba(60,6,14,.72),rgba(4,10,8,.86));backdrop-filter:blur(2px);padding:20px;text-align:center;}',
      '.cr-dodge.show{display:flex;animation:cr-dodge-in .18s ease;}',
      '@keyframes cr-dodge-in{from{opacity:0;}to{opacity:1;}}',
      '.cr-dodge-warn{font-size:clamp(26px,8vw,52px);font-weight:900;color:var(--danger);letter-spacing:2px;text-shadow:0 0 22px rgba(255,77,109,.7);animation:cr-warn 0.5s ease-in-out infinite alternate;}',
      '@keyframes cr-warn{from{transform:scale(1);}to{transform:scale(1.06);}}',
      '.cr-ring{width:min(80%,420px);height:12px;border-radius:999px;background:rgba(4,16,10,.85);border:1px solid var(--stroke-2);overflow:hidden;}',
      '.cr-ring-fill{height:100%;width:100%;border-radius:999px;background:linear-gradient(90deg,var(--gold),var(--danger));transition:width .08s linear;}',
      '.cr-ring-fill.crit{background:var(--danger);box-shadow:0 0 14px rgba(255,77,109,.7);}',
      '.cr-dodge-btn{width:min(88%,460px);min-height:clamp(90px,18vh,140px);border-radius:22px;border:3px solid var(--gold);cursor:pointer;font-family:inherit;',
      'font-size:clamp(22px,6.5vw,34px);font-weight:900;letter-spacing:2px;color:#20140a;',
      'background:radial-gradient(circle at 50% 30%,#ffe680,var(--gold) 78%);box-shadow:0 0 50px rgba(255,210,63,.55);',
      'touch-action:manipulation;user-select:none;-webkit-user-select:none;-webkit-tap-highlight-color:transparent;animation:cr-pulse .55s ease-in-out infinite;}',
      '@keyframes cr-pulse{0%,100%{box-shadow:0 0 40px rgba(255,210,63,.5);}50%{box-shadow:0 0 70px rgba(255,210,63,.85);}}',
      '.cr-dodge-btn.done{border-color:var(--neon);background:radial-gradient(circle at 50% 30%,#9dff7a,#1f8a2c 80%);color:#eafff0;animation:none;box-shadow:0 0 34px rgba(57,255,20,.5);cursor:default;}',
      '.cr-dodge-team{display:flex;flex-wrap:wrap;gap:8px;justify-content:center;max-width:520px;}',
      '.cr-dt-chip{display:flex;align-items:center;gap:6px;padding:5px 12px;border-radius:999px;background:rgba(9,32,21,.7);border:1px solid var(--stroke);font-weight:800;font-size:13px;color:var(--text);}',
      '.cr-dt-chip.ok{border-color:var(--neon);color:var(--leaf);}.cr-dt-chip.ok .cr-dt-ic{color:var(--neon);}',
      '.cr-dt-chip.wait{border-color:var(--danger);}.cr-dt-chip.wait .cr-dt-ic{color:var(--danger);}'
    ].join(''));
  }
})();
