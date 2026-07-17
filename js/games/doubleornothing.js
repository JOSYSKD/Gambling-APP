/* doubleornothing.js — "Double or Nothing": lineare Risiko-Leiter.
 *
 * Ablauf:
 *   - Der Spieler setzt einen Einsatz (createBetPanel). Der Start zieht den Einsatz ab.
 *   - Er beginnt auf STUFE 0 (der Einsatz liegt komplett im Risiko).
 *   - Stufe k hat den Auszahlungs-Multiplikator 2*k → Cashout-Wert auf Stufe k
 *     = Einsatz * 2k  (Stufe 1 = 2×, Stufe 2 = 4×, Stufe 3 = 6×, …).
 *   - "🔀 Risiko": von Stufe L auf L+1 vorrücken. Gewinnchance p, sonst ist der
 *     gesamte Einsatz weg (Bust).
 *   - "💸 Cashout" (erst ab Stufe ≥ 1): sichert Einsatz * 2L.
 *
 * Fairness / Wahrscheinlichkeiten (Hausvorteil, FAIR gerechnet):
 *   Beim linearen Multiplikator 2k muss die Schritt-Chance = mult(L)/mult(L+1)
 *   = L/(L+1) sein, sonst hat das Spiel einen POSITIVEN Erwartungswert (der frühere
 *   Faktor (L+1)/(L+2) gab bis ~1,29× Spielervorteil → aus 1000 wurden Millionen).
 *   Schritt-Chance von Stufe L auf L+1:  p = 0.95 * (L<1 ? 0.5 : L/(L+1))
 *     Stufe 0→1: 0.95*0.5   = 0.475     (der harte erste Schritt, ×2)
 *     Stufe 1→2: 0.95*0.5   = 0.475     (×2 → ×4)
 *     Stufe 2→3: 0.95*0.667 ≈ 0.633 …
 *   Erwartungswert beim Cashen auf Stufe k = 0.95^k × Einsatz (immer < 1, sinkt mit k).
 *   Die Wahrscheinlichkeit, Stufe k zu erreichen, ist  0.95^k / (2k).
 *
 * Siegesserien-Rangliste (geteilt) unter dem freigegebenen Firebase-Knoten
 *   scores/don_streaks  (ein NEUER Top-Level-Knoten wäre "Permission denied").
 *   Eintrag: { key, name, streak, rate } — streak = beste je erreichte Stufe,
 *   rate = persönliche Schritt-Trefferquote. Treiber (firebase → cloud → lokal)
 *   nach dem Muster von js/survival.js.
 */
(function () {
  'use strict';
  window.App = window.App || {};
  App.Games = App.Games || {};

  var UI = App.UI, el = UI.el, Coins = App.Coins;

  /* Lebenslange Statistik — NICHT modus-gebunden (bewusst direkt in App.Storage). */
  var K_STEPS = 'gj_don_steps';        // Summe aller Risiko-Versuche
  var K_WINS  = 'gj_don_wins';         // Summe der erfolgreichen Vorstöße
  var K_BEST  = 'gj_don_best';         // beste Serie (höchste je erreichte Stufe)
  var K_ID    = 'gj_don_id';           // eigene Ranglisten-ID (Gast ohne Konto)
  var K_LOCAL = 'gj_don_board_local';  // lokaler Ranglisten-Fallback

  var HOUSE = 0.95;                    // 5 % Hausvorteil-Faktor
  var THEORY_RATE = 0.6;               // theoretischer Schnitt der Schritt-Trefferquote
  var MIN_ATTEMPTS = 10;               // ab so vielen Versuchen zählt die echte Quote
  var FB_PATH = 'scores/don_streaks';  // einziger freigegebener Rangliste-Pfad

  /* ---- Wahrscheinlichkeiten ---- */
  // Chance, von Stufe L auf L+1 vorzurücken. = HOUSE * mult(L)/mult(L+1) = HOUSE*L/(L+1)
  // (erster Schritt L=0: HOUSE*0.5). Nur so ist der Erwartungswert fair (< 1); die
  // frühere Formel (L+1)/(L+2) machte das Spiel zugunsten des Spielers kaputt.
  function stepProb(L) { return HOUSE * (L < 1 ? 0.5 : L / (L + 1)); }
  // Auszahlungs-Multiplikator auf Stufe k = 2k.
  function multFor(k) { return 2 * k; }
  // Theoretische Chance, Stufe k von Grund auf zu erreichen = Produkt der Schritt-Chancen.
  function theoryReach(k) {
    var p = 1;
    for (var L = 0; L < k; L++) p *= stepProb(L);
    return p;   // == 0.95^k / (2k)
  }
  // Chance eines Spielers, so eine Serie zu schaffen — aus seiner Trefferquote (rate^streak).
  // Ohne bekannte Quote: theoretische Schätzung.
  function streakChance(rate, streak) {
    if (streak <= 0) return 1;
    var r = (typeof rate === 'number' && isFinite(rate) && rate > 0 && rate <= 1) ? rate : null;
    return r == null ? theoryReach(streak) : Math.pow(r, streak);
  }

  /* ---- Prozent-Formatierung (Bruch 0..1 → "47.5%") ---- */
  function fmtPct(frac) {
    var p = frac * 100;
    if (!isFinite(p) || p <= 0) return '0%';
    if (p >= 100) return '100%';
    if (p >= 1) return p.toFixed(1) + '%';
    if (p >= 0.01) return p.toFixed(2) + '%';
    return p.toPrecision(2) + '%';
  }

  /* ---- Lebenslange Statistik / persönliche Quote ---- */
  function num(k) { return Number(App.Storage.get(k, 0)) || 0; }
  function bestStreak() { return num(K_BEST); }
  function personalRate() {
    var steps = num(K_STEPS), wins = num(K_WINS);
    if (steps < MIN_ATTEMPTS) return THEORY_RATE;   // zu wenig Daten → Schätzwert
    return steps > 0 ? wins / steps : THEORY_RATE;
  }
  function rateKnown() { return num(K_STEPS) >= MIN_ATTEMPTS; }
  function recordAttempt(won) {
    App.Storage.set(K_STEPS, num(K_STEPS) + 1);
    if (won) App.Storage.set(K_WINS, num(K_WINS) + 1);
  }

  function getPlayerName() {
    return (App.Leaderboard && App.Leaderboard.getPlayerName && App.Leaderboard.getPlayerName()) || 'Anonym';
  }
  function myKey() {
    var acct = App.Account && App.Account.current && App.Account.current();
    if (acct && acct.name) return 'a_' + String(acct.name).toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 24);
    var id = App.Storage.get(K_ID, null);
    if (!id) {
      id = 'd_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
      App.Storage.set(K_ID, id);
    }
    return id;
  }

  /* ================= Rangliste (geteilt, wie js/survival.js) ================= */
  var board = [];              // [{ key, name, streak, rate, at }]
  var boardListeners = [];
  var driver = null;
  var driverInit = false;

  function boardEmit() { boardListeners.forEach(function (cb) { try { cb(); } catch (e) {} }); }
  function onBoardChange(cb) {
    boardListeners.push(cb);
    return function () { var i = boardListeners.indexOf(cb); if (i >= 0) boardListeners.splice(i, 1); };
  }
  function normEntry(k, e) {
    e = e || {};
    return { key: k, name: e.name, streak: e.streak || 0, rate: e.rate, at: e.at || 0 };
  }

  function localDriver() {
    return {
      kind: 'local',
      list: function () { return App.Storage.get(K_LOCAL, []); },
      put: function (entry) {
        var all = App.Storage.get(K_LOCAL, []).filter(function (e) { return e.key !== entry.key; });
        all.push(entry);
        App.Storage.set(K_LOCAL, all);
        board = all; boardEmit();
      }
    };
  }
  function firebaseDriver(db, path) {
    var ref = db.ref(path);
    ref.on('value', function (snap) {
      var val = snap.val() || {};
      board = Object.keys(val).map(function (k) { return normEntry(k, val[k]); });
      boardEmit();
    });
    return {
      kind: 'firebase',
      path: path,
      list: function () { return board; },
      put: function (entry) { try { ref.child(entry.key).set(entry); } catch (e) {} }
    };
  }
  function cloudDriver() {
    App.Cloud.startPolling(15000);
    function sync(state) {
      var m = (state && state.don_streaks) || {};
      board = Object.keys(m).map(function (k) { return normEntry(k, m[k]); });
      boardEmit();
    }
    App.Cloud.onChange(sync);
    App.Cloud.load().then(sync).catch(function () {});
    return {
      kind: 'cloud',
      list: function () { return board; },
      put: function (entry) {
        return App.Cloud.mutate(function (state) {
          state.don_streaks = state.don_streaks || {};
          state.don_streaks[entry.key] = entry;
        }).then(sync).catch(function () {});
      }
    };
  }
  function cloudOrLocal() {
    if (App.Cloud && App.Cloud.configured && App.Cloud.configured()) {
      return App.Cloud.load().then(function () { return cloudDriver(); }).catch(function () { return localDriver(); });
    }
    return Promise.resolve(localDriver());
  }
  function initDriver() {
    if (App.Net && App.Net.firebaseConfigured && App.Net.firebaseConfigured()) {
      return App.Net.firebaseDb().then(function (db) {
        // Erst prüfen, ob der Pfad wirklich lesbar ist (Regeln evtl. nicht deployt) —
        // sonst still auf Cloud/lokal ausweichen statt für immer leer zu bleiben.
        return db.ref(FB_PATH).limitToFirst(1).once('value')
          .then(function () { return firebaseDriver(db, FB_PATH); });
      }).catch(function () { return cloudOrLocal(); });
    }
    return cloudOrLocal();
  }
  function ensureDriver() {
    if (driverInit) return;
    driverInit = true;
    try {
      initDriver().then(function (d) { driver = d; boardEmit(); maybePublish(); })
        .catch(function () { driver = localDriver(); boardEmit(); });
    } catch (e) { driver = localDriver(); boardEmit(); }
  }
  function getBoard(limit) {
    var list = (driver ? driver.list() : board).slice();
    list.sort(function (a, b) { return (b.streak - a.streak) || ((b.rate || 0) - (a.rate || 0)); });
    return list.slice(0, limit || 20);
  }
  // Eintrag NUR schreiben, wenn die neue Bestserie die gespeicherte schlägt.
  function maybePublish() {
    if (!driver) return;
    var best = bestStreak();
    if (best <= 0) return;
    var list = driver.list(), mine = null;
    for (var i = 0; i < list.length; i++) { if (list[i].key === myKey()) { mine = list[i]; break; } }
    if (mine && mine.streak >= best) return;
    driver.put({
      key: myKey(),
      name: (getPlayerName() || 'Anonym').slice(0, 18),
      streak: best,
      rate: Math.round(personalRate() * 1000) / 1000,
      at: Date.now()
    });
  }

  /* ================= Spiel-CSS ================= */
  UI.injectStyle('game-don-css', [
    '.don-stage{display:flex;flex-direction:column;gap:14px;align-items:center;text-align:center;}',
    '.don-readout{display:flex;flex-direction:column;align-items:center;gap:4px;}',
    '.don-lvl-l{font-size:11px;letter-spacing:2px;text-transform:uppercase;color:var(--muted);font-weight:800;}',
    '.don-cash{color:var(--gold);text-shadow:0 0 18px rgba(255,210,63,.5);line-height:1;transition:color .2s;font-variant-numeric:tabular-nums;}',
    '.don-cash.muted{color:var(--muted);text-shadow:none;}',
    '.don-cash.bust{color:var(--danger);text-shadow:0 0 16px rgba(255,77,109,.5);}',
    '.don-sub{font-weight:800;font-size:14px;color:var(--aqua-soft);min-height:18px;}',
    '.don-next{font-size:13px;color:var(--muted);font-weight:700;min-height:16px;}',
    '.don-next b{color:var(--neon);}',
    '.don-ladder{display:flex;gap:6px;overflow-x:auto;max-width:100%;padding:4px 2px;scrollbar-width:thin;}',
    '.don-rung{flex:0 0 auto;min-width:58px;padding:7px 8px;border-radius:10px;border:1px solid var(--stroke);',
    '  background:rgba(4,16,10,.7);display:flex;flex-direction:column;gap:2px;align-items:center;transition:.15s;}',
    '.don-rung .rm{font-weight:900;font-size:14px;color:var(--text);font-variant-numeric:tabular-nums;}',
    '.don-rung .rc{font-size:10px;color:var(--muted);font-weight:700;}',
    '.don-rung.reached{border-color:var(--neon);background:radial-gradient(120% 120% at 50% 0,rgba(57,255,20,.22),rgba(4,16,10,.7));}',
    '.don-rung.reached .rm{color:var(--neon);}',
    '.don-rung.next{border-color:var(--gold);box-shadow:0 0 12px rgba(255,210,63,.35);}',
    '.don-rung.next .rm{color:var(--gold);}',
    '.don-controls{display:flex;flex-wrap:wrap;gap:14px;align-items:flex-end;justify-content:center;width:100%;}',
    '.don-actions{display:flex;flex-direction:column;gap:10px;flex:1;min-width:220px;}',
    '.don-actions .btn{white-space:nowrap;}',
    '.don-stats{display:flex;flex-wrap:wrap;gap:10px;justify-content:center;width:100%;}',
    '.don-stat{flex:1 1 150px;background:rgba(0,0,0,.22);border:1px solid var(--stroke);border-radius:12px;padding:9px 12px;',
    '  display:flex;flex-direction:column;gap:2px;min-width:0;}',
    '.don-stat-l{font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.7px;font-weight:800;}',
    '.don-stat-v{font-weight:900;font-size:15px;color:var(--text);font-variant-numeric:tabular-nums;}',
    '.don-stat-v.gold{color:var(--gold);}.don-stat-v.aqua{color:var(--aqua-soft);}',
    '.don-board{padding:16px;}',
    '.don-board-t{margin:0 0 10px;font-size:15px;font-weight:900;color:var(--gold);}',
    '.don-rows{display:flex;flex-direction:column;gap:6px;}',
    '.don-row{display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:10px;background:rgba(0,0,0,.2);border:1px solid transparent;}',
    '.don-row.mine{border-color:var(--gold);background:rgba(255,210,63,.09);}',
    '.don-row.top1{background:linear-gradient(90deg,rgba(255,210,63,.16),rgba(0,0,0,.2));}',
    '.don-rank{width:34px;font-weight:900;color:var(--muted);font-size:13px;flex:0 0 auto;}',
    '.don-pname{flex:1;min-width:0;font-weight:800;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
    '.don-pstreak{font-weight:900;color:var(--neon);font-variant-numeric:tabular-nums;flex:0 0 auto;}',
    '.don-pchance{font-size:11px;color:var(--muted);font-variant-numeric:tabular-nums;flex:0 0 auto;min-width:86px;text-align:right;}',
    '@media(max-width:520px){.don-pchance{min-width:70px;}}',
    '.don-empty{color:var(--muted);text-align:center;padding:14px;font-size:13px;}',
    '.don-board-h{color:var(--muted);font-size:11px;margin:10px 0 0;text-align:center;}',
    '@media(max-width:560px){.don-actions{min-width:100%;}}'
  ].join('\n'));

  App.Games.doubleornothing = {
    id: 'doubleornothing',
    title: 'Double or Nothing',
    icon: '🔀',
    subtitle: 'Alles riskieren für die nächste Stufe — 2×, 4×, 6× …',

    render: function (root) {
      ensureDriver();

      /* -------------------- Zustand -------------------- */
      var phase = 'idle';   // 'idle' | 'running' | 'ended'
      var bet = 0;
      var level = 0;        // aktuelle Stufe L

      /* -------------------- Anzeige-Bausteine -------------------- */
      var cashEl = el('div', { class: 'big-readout don-cash muted' }, ['0 🪙']);
      var subEl = el('div', { class: 'don-sub' }, ['']);
      var nextEl = el('div', { class: 'don-next' }, ['']);
      var ladderEl = el('div', { class: 'don-ladder' });
      var readout = el('div', { class: 'don-readout' }, [
        el('div', { class: 'don-lvl-l' }, ['Aktuelle Auszahlung']),
        cashEl, subEl, nextEl
      ]);
      var stage = el('div', { class: 'game-stage don-stage' }, [readout, ladderEl]);

      var betPanel = UI.createBetPanel({ initial: 50, onChange: function () { if (phase === 'idle') updateView(); } });

      var startSub = el('span', { class: 'btn-sub' }, ['']);
      var startBtn = el('button', { class: 'btn btn-primary btn-lg btn-block btn-2l', type: 'button', onclick: startRound }, [
        el('span', { class: 'btn-main' }, ['🆙 Start']), startSub
      ]);
      var riskBtn = el('button', { class: 'btn btn-primary btn-lg btn-block', type: 'button', onclick: doRisk }, ['🔀 Risiko']);
      var cashBtn = el('button', { class: 'btn btn-aqua btn-lg btn-block', type: 'button', onclick: doCashout }, ['💸 Cashout']);
      var newBtn = el('button', { class: 'btn btn-primary btn-lg btn-block', type: 'button', onclick: resetToIdle }, ['🔁 Neue Runde']);
      var actions = el('div', { class: 'don-actions' }, [startBtn, riskBtn, cashBtn, newBtn]);
      var controls = el('div', { class: 'don-controls' }, [betPanel.root, actions]);

      var rateStat = el('div', { class: 'don-stat-v aqua' }, ['—']);
      var chanceStat = el('div', { class: 'don-stat-v' }, ['—']);
      var bestStat = el('div', { class: 'don-stat-v gold' }, ['0']);
      var statsEl = el('div', { class: 'don-stats' }, [
        el('div', { class: 'don-stat' }, [el('div', { class: 'don-stat-l' }, ['Deine Trefferquote']), rateStat]),
        el('div', { class: 'don-stat' }, [el('div', { class: 'don-stat-l' }, [chanceLabel()]), chanceStat]),
        el('div', { class: 'don-stat' }, [el('div', { class: 'don-stat-l' }, ['Dein Rekord (Serie)']), bestStat])
      ]);

      var hint = el('p', { class: 'hint-text' }, [
        'Auf Stufe k ist der Einsatz 2k× wert. Jeder Risiko-Wurf verdoppelt … oder er kostet alles. ' +
        'Der erste Schritt ist mit 47,5 % der härteste (5 % Hausvorteil).'
      ]);

      var rowsEl = el('div', { class: 'don-rows' });
      var boardHint = el('p', { class: 'don-board-h' }, ['']);
      var boardEl = el('div', { class: 'glass don-board' }, [
        el('h3', { class: 'don-board-t' }, ['🏆 Beste Siegesserien']),
        rowsEl, boardHint
      ]);

      root.appendChild(el('div', { class: 'game-panel glass', style: 'display:flex;flex-direction:column;gap:16px;' }, [
        stage, controls, statsEl, hint
      ]));
      root.appendChild(boardEl);

      /* -------------------- Rundenlogik -------------------- */
      function startRound() {
        if (phase !== 'idle') return;
        var b = betPanel.getBet();
        if (!Coins.canBet(b)) { UI.toast('Nicht genug Coins', 'lose'); return; }
        Coins.add(-b);            // Einsatz abziehen
        bet = b; level = 0; phase = 'running';
        cashEl.className = 'big-readout don-cash muted';
        updateView();
      }

      function doRisk() {
        if (phase !== 'running') return;
        var p = stepProb(level);
        var won = Math.random() < p;
        recordAttempt(won);
        if (won) {
          level += 1;
          if (level > bestStreak()) { App.Storage.set(K_BEST, level); maybePublish(); }
          if (App.Audio) App.Audio.sfx('chip');
          cashEl.className = 'big-readout don-cash';
          updateView();
        } else {
          bust();
        }
      }

      function doCashout() {
        if (phase !== 'running' || level < 1) return;
        var payout = Math.round(bet * multFor(level));   // Einsatz * 2L (brutto)
        Coins.add(payout);
        phase = 'ended';
        if (App.Audio) App.Audio.sfx(level >= 3 ? 'jackpot' : 'cashout');
        cashEl.className = 'big-readout don-cash';
        subEl.textContent = 'Gesichert auf Stufe ' + level + ' (×' + multFor(level) + ')';
        UI.flash(payout - bet);
        UI.toast('Ausgecasht: +' + UI.formatCoins(payout - bet) + ' 🪙', 'win');
        endRound();
      }

      function bust() {
        phase = 'ended';
        if (App.Audio) App.Audio.sfx('explosion');
        cashEl.className = 'big-readout don-cash bust';
        cashEl.textContent = '0 🪙';
        subEl.textContent = 'Geplatzt auf Stufe ' + level + ' → ' + (level + 1) + ' — Einsatz weg';
        UI.flash(-bet);
        UI.toast('Verloren auf dem Weg zu ×' + multFor(level + 1) + ' 💥', 'lose');
        endRound();
      }

      // Abrechnung nach vollständig beendeter Runde.
      function endRound() {
        betPanel.refresh();
        updateView();
        Coins.settle();
      }

      function resetToIdle() {
        phase = 'idle'; level = 0; bet = 0;
        cashEl.className = 'big-readout don-cash muted';
        updateView();
      }

      /* -------------------- Ansicht -------------------- */
      function chanceLabel() { return phase === 'running' ? 'Chance nächste Stufe' : 'Chance auf Rekord+1'; }

      function updateButtons() {
        startBtn.hidden = phase !== 'idle';
        riskBtn.hidden = phase !== 'running';
        cashBtn.hidden = phase !== 'running';
        newBtn.hidden = phase !== 'ended';
        betPanel.setDisabled(phase !== 'idle');
        startSub.textContent = 'Einsatz ' + UI.formatCoins(betPanel.getBet()) + ' 🪙';

        if (phase === 'running') {
          var p = stepProb(level);
          riskBtn.textContent = '🔀 Risiko → ×' + multFor(level + 1) + ' · ' + fmtPct(p);
          if (level < 1) {
            cashBtn.disabled = true;
            cashBtn.textContent = '💸 Cashout (ab Stufe 1)';
          } else {
            cashBtn.disabled = false;
            cashBtn.textContent = '💸 Cashout · ' + UI.formatCoins(Math.round(bet * multFor(level))) + ' 🪙';
          }
        }
      }

      function updateReadout() {
        var stake = phase === 'idle' ? betPanel.getBet() : bet;
        if (phase === 'idle') {
          cashEl.textContent = '0 🪙';
          cashEl.className = 'big-readout don-cash muted';
          subEl.textContent = 'Setze deinen Einsatz und riskiere ihn 🔀';
          nextEl.innerHTML = '';
          nextEl.appendChild(document.createTextNode('Erster Schritt zu '));
          nextEl.appendChild(el('b', {}, ['×2']));
          nextEl.appendChild(document.createTextNode(' · Chance ' + fmtPct(stepProb(0))));
        } else if (phase === 'running') {
          var cur = level < 1 ? 0 : Math.round(stake * multFor(level));
          cashEl.textContent = UI.formatCoins(cur) + ' 🪙';
          cashEl.classList.toggle('muted', level < 1);
          subEl.textContent = 'Stufe ' + level + (level >= 1 ? ' · ×' + multFor(level) + ' gesichert-bereit' : ' · noch nichts gesichert');
          var np = stepProb(level);
          nextEl.innerHTML = '';
          nextEl.appendChild(document.createTextNode('Nächste Stufe '));
          nextEl.appendChild(el('b', {}, ['×' + multFor(level + 1)]));
          nextEl.appendChild(document.createTextNode(' (' + UI.formatCoins(Math.round(stake * multFor(level + 1))) + ' 🪙) · Chance ' + fmtPct(np)));
        }
        // Bei 'ended' bleibt der von cashout()/bust() gesetzte Text stehen.
      }

      function updateLadder() {
        ladderEl.innerHTML = '';
        var top = Math.max(8, level + 4);
        for (var k = 1; k <= top; k++) {
          var cls = 'don-rung' + (k <= level ? ' reached' : '') + (k === level + 1 && phase === 'running' ? ' next' : '');
          ladderEl.appendChild(el('div', { class: cls }, [
            el('div', { class: 'rm' }, ['×' + multFor(k)]),
            el('div', { class: 'rc' }, [fmtPct(stepProb(k - 1))])
          ]));
        }
        // Aktive Stufe ins Sichtfeld scrollen.
        var nextRung = ladderEl.children[Math.min(level, top - 1)];
        if (nextRung && nextRung.scrollIntoView) { try { nextRung.scrollIntoView({ block: 'nearest', inline: 'center' }); } catch (e) {} }
      }

      function updateStats() {
        var rate = personalRate();
        rateStat.textContent = fmtPct(rate) + (rateKnown() ? ' (' + num(K_STEPS) + ' Versuche)' : ' · Schätzwert');
        // Chance auf die relevante nächste Serie (laufend: nächste Stufe; sonst: Rekord+1).
        var targetStreak = phase === 'running' ? (level + 1) : (bestStreak() + 1);
        chanceStat.textContent = fmtPct(streakChance(rate, targetStreak)) + ' → Serie ' + targetStreak;
        bestStat.textContent = String(bestStreak());
        var lbl = statsEl.querySelectorAll('.don-stat-l')[1];
        if (lbl) lbl.textContent = chanceLabel();
      }

      function renderBoard() {
        rowsEl.innerHTML = '';
        var list = getBoard(20);
        if (!list.length) {
          rowsEl.appendChild(el('div', { class: 'don-empty' }, ['Noch keine Serie geschafft — sei der Erste! 🔀']));
        } else {
          var mk = myKey();
          list.forEach(function (e, i) {
            var rank = i + 1;
            rowsEl.appendChild(el('div', { class: 'don-row' + (e.key === mk ? ' mine' : '') + (rank <= 3 ? ' top' + rank : '') }, [
              el('span', { class: 'don-rank' }, [rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : '#' + rank]),
              el('span', { class: 'don-pname' }, [e.name || 'Anonym']),
              el('span', { class: 'don-pstreak' }, ['Serie ' + (e.streak || 0)]),
              el('span', { class: 'don-pchance' }, ['Chance: ' + fmtPct(streakChance(e.rate, e.streak || 0))])
            ]));
          });
        }
        var kind = driver ? driver.kind : 'none';
        boardHint.textContent = (kind === 'firebase' || kind === 'cloud')
          ? 'Über alle Spieler — „Chance“ = wie wahrscheinlich diese Serie bei der bisherigen Trefferquote des Spielers ist.'
          : 'Kein Cloud-Backend erreichbar — aktuell nur Serien aus diesem Browser sichtbar.';
      }

      function updateView() {
        updateButtons();
        updateReadout();
        updateLadder();
        updateStats();
      }

      /* -------------------- Start -------------------- */
      updateView();
      renderBoard();
      var offBoard = onBoardChange(renderBoard);

      return {
        cleanup: function () { offBoard(); }
      };
    }
  };
})();
