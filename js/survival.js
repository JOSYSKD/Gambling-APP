/* survival.js — Survival-Modus  (App.Survival)
 *
 * Zweiter, komplett eigener Spielstand neben dem Casino:
 *   - Gezockt wird mit GOLD-Coins (🥇) statt Silber (🪙). Beide Währungen sind
 *     strikt getrennt — Casino-Silber bleibt im Casino, Gold nur hier.
 *   - Pleite heißt wirklich pleite: Level, XP, Quests, Stats und Depot fallen auf
 *     null zurück (nur der Survival-Stand, das Casino bleibt unberührt).
 *   - Danach ist eine Stunde Pause. Erst dann darf ein neuer Run starten — wieder
 *     mit 1.000 Gold und ganz von vorn.
 *   - Live-Rangliste über alle Spieler: wer hat gerade das meiste Gold?
 *
 * Die Trennung der Spielstände macht js/mode.js (Storage-Präfix). Hier liegt nur
 * die Survival-Logik: Run-Zustand, Sperre, Reset, Rangliste, Ansicht.
 */
(function () {
  'use strict';
  window.App = window.App || {};
  var UI = App.UI, el = UI.el;

  var LOCK_MS = 60 * 60 * 1000;    // eine Stunde Sperre nach dem Pleitegehen
  var START_GOLD = 1000;

  // Diese Schlüssel sind NICHT modus-gebunden (sie beschreiben den Survival-Modus
  // selbst und müssen auch vom Casino aus lesbar sein).
  var KEY_RUN = 'gj_sv_run';         // läuft gerade ein Run?
  var KEY_NEXT = 'gj_sv_next_try';   // ab wann ist der nächste Versuch erlaubt?
  var KEY_PEAK = 'gj_sv_peak_ever';  // bestes Vermögen aller Zeiten (Rekord)
  var KEY_ID = 'gj_sv_id';           // eigene Ranglisten-ID (falls kein Konto)
  var KEY_GOLD_SEEN = 'gj_sv_gold_seen'; // zuletzt eingelöstes Admin-Gold-Geschenk (siehe applyGoldGrant)

  function now() { return Date.now(); }
  function runActive() { return App.Storage.get(KEY_RUN, false) === true; }
  function nextTry() { return Number(App.Storage.get(KEY_NEXT, 0)) || 0; }
  function lockedFor() { return Math.max(0, nextTry() - now()); }
  function isLocked() { return lockedFor() > 0; }
  function peakEver() { return Number(App.Storage.get(KEY_PEAK, 0)) || 0; }

  /** Vermögen im Survival-Modus: Gold + Depotwert. Auch vom Casino aus korrekt,
   *  weil beide Werte gezielt aus dem Survival-Spielstand gelesen werden. */
  function assets() {
    var cash = App.Mode.readIn('survival', 'gj_balance', 0);
    var depot = App.Stocks ? App.Stocks.valueOf(App.Mode.readIn('survival', 'gj_stocks', null)) : 0;
    return Math.round((typeof cash === 'number' ? cash : 0) + depot);
  }

  function fmtDur(ms) {
    var s = Math.max(0, Math.ceil(ms / 1000));
    var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    var pad = function (n) { return (n < 10 ? '0' : '') + n; };
    return (h > 0 ? h + ':' + pad(m) : m) + ':' + pad(sec);
  }

  /* ================= Rangliste (live, für alle Spieler) ================= */
  /* Aufbau wie in js/account.js: echtes Firebase wenn konfiguriert, sonst der
   * keylose Cloud-Speicher, sonst lokal — die Seite funktioniert immer. */
  var board = [];          // [{ key, name, gold, peak, alive, at }]
  var boardListeners = [];
  var driver = null;

  function boardEmit() { boardListeners.forEach(function (cb) { try { cb(); } catch (e) {} }); }

  function myKey() {
    var acct = App.Account && App.Account.current();
    if (acct && acct.name) return 'a_' + String(acct.name).toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 24);
    var id = App.Storage.get(KEY_ID, null);
    if (!id) {
      id = 'd_' + Math.random().toString(36).slice(2, 10) + now().toString(36).slice(-4);
      App.Storage.set(KEY_ID, id);
    }
    return id;
  }

  function localDriver() {
    var KEY = 'gj_sv_board_local';
    return {
      kind: 'local',
      list: function () { return App.Storage.get(KEY, []); },
      put: function (entry) {
        var all = App.Storage.get(KEY, []).filter(function (e) { return e.key !== entry.key; });
        all.push(entry);
        App.Storage.set(KEY, all);
        board = all; boardEmit();
      }
    };
  }

  function firebaseDriver(db, path) {
    var ref = db.ref(path);
    ref.on('value', function (snap) {
      var val = snap.val() || {};
      board = Object.keys(val).map(function (k) {
        var e = val[k] || {};
        return { key: k, name: e.name, gold: e.gold || 0, peak: e.peak || 0, alive: !!e.alive, at: e.at || 0 };
      });
      boardEmit();
    });
    return {
      kind: 'firebase',
      path: path,
      list: function () { return board; },
      put: function (entry) { ref.child(entry.key).set(entry); }
    };
  }

  function cloudDriver() {
    // Der freie Cloud-Speicher kann nicht pushen — regelmäßig neu laden, damit die
    // Stände der anderen Spieler ankommen (idempotent, falls account.js schon pollt).
    App.Cloud.startPolling(10000);
    function sync(state) {
      var m = (state && state.survival) || {};
      board = Object.keys(m).map(function (k) { return Object.assign({ key: k }, m[k]); });
      boardEmit();
    }
    App.Cloud.onChange(sync);
    App.Cloud.load().then(sync).catch(function () {});
    return {
      kind: 'cloud',
      list: function () { return board; },
      put: function (entry) {
        return App.Cloud.mutate(function (state) {
          state.survival = state.survival || {};
          state.survival[entry.key] = entry;
        }).then(sync).catch(function () {});
      }
    };
  }

  /* Ein Firebase-Pfad wird nur benutzt, wenn er dort auch WIRKLICH freigegeben ist:
   * Regeln aus database.rules.json wirken erst nach `firebase deploy --only database`.
   * Ohne das lehnt die Datenbank still ab (ohne Fehlermeldung!) und die Rangliste bliebe
   * für immer leer — deshalb vor der Wahl ein echter Lesetest. Reihenfolge:
   *   1. 'survival'                 — der saubere eigene Pfad; seit 15.07.2026 deployt
   *                                   und der aktiv genutzte
   *   2. 'scores/__survival_board'  — Sicherheitsnetz: 'scores' ist ebenfalls freigegeben;
   *                                   scores.js liest immer nur scores/<spielId>, der
   *                                   Unterschlüssel stört dort also nicht
   *   3. Cloud-Speicher / lokal     — letzte Rückfallebenen
   * Sollte die Regel je verlorengehen (neu aufgesetzte DB, vergessener Deploy), läuft die
   * Rangliste damit weiter, statt kommentarlos leer zu bleiben. */
  var FB_PATHS = ['survival', 'scores/__survival_board'];
  function tryFirebasePath(db, i) {
    if (i >= FB_PATHS.length) return Promise.reject(new Error('kein freigegebener Firebase-Pfad'));
    return db.ref(FB_PATHS[i]).limitToFirst(1).once('value')
      .then(function () { return firebaseDriver(db, FB_PATHS[i]); })
      .catch(function () { return tryFirebasePath(db, i + 1); });
  }
  function initDriver() {
    if (App.Net && App.Net.firebaseConfigured()) {
      return App.Net.firebaseDb()
        .then(function (db) { return tryFirebasePath(db, 0); })
        .catch(function () { return cloudOrLocal(); });
    }
    return cloudOrLocal();
  }
  function cloudOrLocal() {
    if (App.Cloud && App.Cloud.configured()) {
      return App.Cloud.load().then(function () { return cloudDriver(); }).catch(function () { return localDriver(); });
    }
    return Promise.resolve(localDriver());
  }

  /** Eigenen Stand in die Rangliste schreiben (gedrosselt, damit jeder Coin-
   *  Wechsel nicht sofort ins Netz geht).
   *  Beim Cloud-Speicher deutlich seltener: dort ist jeder Schreibvorgang ein
   *  Read-Modify-Write des GESAMTEN Datensatzes (inkl. Konten) — häufiges
   *  Schreiben würde das Risiko erhöhen, parallele Änderungen zu überschreiben. */
  var pubTimer = null;
  function pubDelay() { return (driver && driver.kind === 'cloud') ? 15000 : 2000; }
  function publish(immediate) {
    if (!driver) return;
    if (pubTimer) { if (!immediate) return; clearTimeout(pubTimer); pubTimer = null; }
    var doIt = function () {
      pubTimer = null;
      var gold = assets();
      var peak = Math.max(peakEver(), gold);
      if (peak > peakEver()) App.Storage.set(KEY_PEAK, peak);
      // Wer noch nie gespielt hat, taucht auch nicht in der Rangliste auf.
      if (!runActive() && !peak) return;
      driver.put({
        key: myKey(),
        name: (App.Leaderboard.getPlayerName() || 'Anonym').slice(0, 18),
        gold: gold, peak: peak, alive: runActive(), at: now()
      });
    };
    if (immediate) doIt(); else pubTimer = setTimeout(doIt, pubDelay());
  }

  function getBoard(limit) {
    var list = (driver ? driver.list() : board).slice();
    list.sort(function (a, b) { return (b.gold - a.gold) || (b.peak - a.peak); });
    return list.slice(0, limit || 20);
  }

  /* ================= Run-Steuerung ================= */
  /** Neuen Run starten: alles auf null, 1.000 Gold, Survival-Modus an. */
  function startRun() {
    if (isLocked()) { UI.toast('Noch gesperrt — warte die Stunde ab.', 'lose'); return false; }
    App.Mode.wipe('survival');            // Guthaben, Peak, Level/Quests, Depot, Chips
    App.Storage.set(KEY_RUN, true);
    App.Mode.set('survival');             // lädt die (jetzt leeren) Stände neu
    App.Coins.reset();                    // Level 1 -> genau 1.000 Gold
    publish(true);
    if (App.Audio) App.Audio.sfx('powerup');
    return true;
  }

  /** Pleite: Run beenden, Sperre setzen, zurück ins Casino. */
  var bustShown = false;
  function onBust(info) {
    if (bustShown) return;
    bustShown = true;
    var peak = (info && info.peak != null) ? info.peak : App.Coins.getPeak();
    App.Storage.set(KEY_RUN, false);
    App.Storage.set(KEY_NEXT, now() + LOCK_MS);
    if (peak > peakEver()) App.Storage.set(KEY_PEAK, peak);
    publish(true);
    showBustOverlay(peak);
    if (App.Audio) App.Audio.sfx('lose');
  }

  function showBustOverlay(peak) {
    injectCss();
    var countdown = el('div', { class: 'sv-bust-time' }, ['1:00:00']);
    var overlay = el('div', { class: 'sv-bust' }, [
      el('div', { class: 'sv-bust-card glass' }, [
        el('div', { class: 'sv-bust-skull' }, ['💀']),
        el('h1', { class: 'sv-bust-title' }, ['PLEITE']),
        el('p', { class: 'sv-bust-sub' }, ['Dein Survival-Run ist vorbei. Level, Quests und Depot sind weg.']),
        el('div', { class: 'sv-bust-stats' }, [
          el('div', {}, [el('span', { class: 'sv-bl' }, ['Höchster Stand']), el('span', { class: 'sv-bv' }, [UI.formatCoins(peak) + ' 🥇'])]),
          el('div', {}, [el('span', { class: 'sv-bl' }, ['Dein Rekord']), el('span', { class: 'sv-bv' }, [UI.formatCoins(peakEver()) + ' 🥇'])])
        ]),
        el('p', { class: 'sv-bust-lock' }, ['Nächster Versuch in']),
        countdown,
        el('div', { class: 'sv-bust-btns' }, [
          el('button', { class: 'btn btn-primary btn-lg', type: 'button', onclick: close }, ['🏆 Zur Rangliste'])
        ])
      ])
    ]);
    function tick() { countdown.textContent = fmtDur(lockedFor()); }
    tick();
    var timer = setInterval(tick, 1000);
    function close() {
      clearInterval(timer);
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      bustShown = false;
      App.Mode.set('casino');       // Gold-Anzeige aus, Silber zurück
      App.Router.go('/survival');
    }
    document.body.appendChild(overlay);
    setTimeout(function () { overlay.classList.add('show'); }, 20);
  }

  /* ================= Kopfzeilen-Abzeichen ================= */
  var badge = null;
  function installBadge() {
    var host = document.querySelector('.topbar-right');
    if (!host || badge) return;
    badge = el('button', {
      class: 'sv-badge', type: 'button', title: 'Survival-Modus verlassen',
      onclick: function () { App.Router.go('/survival'); }
    }, ['🥇 SURVIVAL']);
    host.insertBefore(badge, host.firstChild);
    syncBadge();
  }
  function syncBadge() {
    if (!badge) return;
    badge.style.display = App.Mode.is('survival') ? '' : 'none';
    var bal = document.getElementById('balance');
    if (bal) bal.title = 'Dein Guthaben · ' + App.Mode.coinName();
    var ic = document.querySelector('#balance .coin-icon');
    if (ic) ic.textContent = App.Mode.coinIcon();
  }

  /* ================= Ansicht ================= */
  function renderPage(root) {
    injectCss();
    var wrap = el('div', { class: 'sv-page' });
    root.appendChild(wrap);
    var timer = null;

    function draw() {
      wrap.innerHTML = '';
      wrap.appendChild(el('div', { class: 'page-head' }, [
        el('button', { class: 'btn btn-ghost back', type: 'button', onclick: function () { App.Router.go('/'); } }, ['← Menü']),
        el('h2', { class: 'page-title sv-title' }, ['🥇 Survival'])
      ]));
      wrap.appendChild(runActive() ? activeCard() : (isLocked() ? lockedCard() : startCard()));
      wrap.appendChild(boardCard());
      wrap.appendChild(rulesCard());
    }

    /* --- kein Run: Start --- */
    function startCard() {
      return el('div', { class: 'glass sv-hero' }, [
        el('div', { class: 'sv-hero-ic' }, ['🥇']),
        el('h3', { class: 'sv-hero-t' }, [peakEver() ? 'Bereit für den nächsten Versuch?' : 'Ein Leben. Ein Konto. Kein Netz.']),
        el('p', { class: 'sv-hero-s' }, [
          'Du startest mit ' + UI.formatCoins(START_GOLD) + ' Gold, Level 1 und null Quests. ' +
          'Gehst du pleite, ist alles weg — und du musst eine Stunde warten.'
        ]),
        peakEver() ? el('div', { class: 'sv-rec' }, ['Dein Rekord: ', el('b', {}, [UI.formatCoins(peakEver()) + ' 🥇'])]) : null,
        el('button', { class: 'btn btn-primary btn-lg', type: 'button', onclick: function () {
          if (startRun()) draw();
        } }, ['🚀 Run starten · ' + UI.formatCoins(START_GOLD) + ' 🥇'])
      ]);
    }

    /* --- gesperrt: Countdown --- */
    function lockedCard() {
      var time = el('div', { class: 'sv-lock-time' }, [fmtDur(lockedFor())]);
      var card = el('div', { class: 'glass sv-hero sv-locked' }, [
        el('div', { class: 'sv-hero-ic' }, ['⏳']),
        el('h3', { class: 'sv-hero-t' }, ['Du bist pleite gegangen']),
        el('p', { class: 'sv-hero-s' }, ['Ein Versuch pro Stunde. Danach geht es wieder bei null los — mit ' + UI.formatCoins(START_GOLD) + ' Gold.']),
        el('div', { class: 'sv-lock-l' }, ['Nächster Versuch in']),
        time,
        el('div', { class: 'sv-rec' }, ['Dein Rekord: ', el('b', {}, [UI.formatCoins(peakEver()) + ' 🥇'])]),
        el('p', { class: 'sv-hero-s' }, ['Im Casino kannst du in der Zwischenzeit ganz normal mit Silber weiterspielen.'])
      ]);
      if (timer) clearInterval(timer);
      timer = setInterval(function () {
        if (!isLocked()) { clearInterval(timer); timer = null; draw(); return; }
        time.textContent = fmtDur(lockedFor());
      }, 1000);
      return card;
    }

    /* Seite im Survival-Modus öffnen: erst die Währung umschalten, dann navigieren —
     * sonst würde dort noch mit Silber gespielt. */
    function enter(route) {
      App.Mode.set('survival');
      App.Router.go(route);
    }

    /* --- Run läuft --- */
    function activeCard() {
      var depot = App.Stocks ? App.Stocks.portfolioValue() : 0;
      var gold = App.Coins.get();
      return el('div', { class: 'glass sv-hero sv-active' }, [
        el('div', { class: 'sv-live' }, ['● RUN LÄUFT']),
        el('div', { class: 'sv-gold' }, [UI.formatCoins(gold) + ' 🥇']),
        el('div', { class: 'sv-stats' }, [
          svStat('Depot', UI.formatCoins(depot) + ' 🥇'),
          svStat('Vermögen', UI.formatCoins(gold + depot) + ' 🥇'),
          svStat('Level', String(App.Progress.level())),
          svStat('Rekord', UI.formatCoins(Math.max(peakEver(), gold + depot)) + ' 🥇')
        ]),
        el('div', { class: 'sv-actions' }, [
          el('button', { class: 'btn btn-primary btn-lg', type: 'button', onclick: function () { enter('/category/gambling'); } }, ['🎰 Zocken']),
          el('button', { class: 'btn btn-aqua btn-lg', type: 'button', onclick: function () { enter('/stocks'); } }, ['📈 Aktien']),
          el('button', { class: 'btn btn-ghost', type: 'button', onclick: function () { enter('/quests'); } }, ['⭐ Quests']),
          el('button', { class: 'btn btn-ghost', type: 'button', onclick: function () {
            App.Mode.set('casino');
            UI.toast('Zurück im Casino — dein Survival-Run wartet auf dich.', 'info');
            draw();
          } }, ['🪙 Ins Casino'])
        ])
      ]);
    }
    function svStat(l, v) {
      return el('div', { class: 'sv-stat' }, [el('span', { class: 'sv-stat-l' }, [l]), el('span', { class: 'sv-stat-v' }, [v])]);
    }

    /* --- Live-Rangliste --- */
    function boardCard() {
      var list = getBoard(20);
      var rows = list.map(function (e, i) {
        var rank = i + 1;
        var mine = e.key === myKey();
        return el('div', { class: 'sv-row' + (mine ? ' mine' : '') + (rank <= 3 ? ' top' + rank : '') }, [
          el('span', { class: 'sv-rank' }, [rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : '#' + rank]),
          el('span', { class: 'sv-pname' }, [
            e.name || 'Anonym',
            e.alive ? el('span', { class: 'sv-tag alive' }, ['läuft']) : el('span', { class: 'sv-tag dead' }, ['pleite'])
          ]),
          el('span', { class: 'sv-pgold' }, [UI.formatShort(e.gold) + ' 🥇']),
          el('span', { class: 'sv-ppeak' }, ['Rekord ' + UI.formatShort(e.peak)])
        ]);
      });
      if (!rows.length) rows = [el('div', { class: 'sv-empty' }, ['Noch niemand hat Survival gespielt — sei der Erste!'])];
      return el('div', { class: 'glass sv-board' }, [
        el('h3', { class: 'sv-board-t' }, ['🏆 Live-Rangliste · wer hat das meiste Gold?']),
        el('div', { class: 'sv-rows' }, rows),
        el('p', { class: 'sv-board-h' }, [
          driver && (driver.kind === 'firebase' || driver.kind === 'cloud')
            ? 'Live über alle Spieler — gezählt wird Gold + Depotwert, in Echtzeit.'
            : 'Kein Cloud-Backend erreichbar — aktuell nur Runs aus diesem Browser sichtbar.'
        ])
      ]);
    }

    function rulesCard() {
      var rules = [
        ['🥇', 'Eigene Währung', 'Gold-Coins. Dein Casino-Silber bleibt komplett davon getrennt — hier zählt nur, was du dir hier erspielst.'],
        ['💀', 'Pleite = alles weg', 'Kein Auffüllen. Level, XP, Quests, Stats und Aktien-Depot fallen auf null zurück.'],
        ['⏳', 'Ein Versuch pro Stunde', 'Nach dem Pleitegehen ist eine Stunde Pause. Danach startest du wieder mit ' + UI.formatCoins(START_GOLD) + ' Gold bei null.'],
        ['📈', 'Aktien inklusive', 'Der Aktienmarkt läuft auch hier — mit Gold statt Silber. Wer Aktien hält, ist übrigens nicht pleite.'],
        ['🏆', 'Live-Rangliste', 'Alle Spieler in einer Liste, sortiert nach Gold. Nur dein Casino-Spielstand bleibt beim Reset unangetastet.']
      ];
      return el('div', { class: 'glass sv-rules' }, [
        el('h3', { class: 'sv-board-t' }, ['📜 So läuft Survival']),
        el('div', { class: 'sv-rules-list' }, rules.map(function (r) {
          return el('div', { class: 'sv-rule' }, [
            el('span', { class: 'sv-rule-ic' }, [r[0]]),
            el('div', {}, [el('div', { class: 'sv-rule-t' }, [r[1]]), el('div', { class: 'sv-rule-d' }, [r[2]])])
          ]);
        }))
      ]);
    }

    draw();
    var off1 = onBoardChange(draw);
    var off2 = App.Coins.onChange(function () { if (runActive()) draw(); });
    return function () { if (timer) clearInterval(timer); off1(); off2(); };
  }

  function onBoardChange(cb) {
    boardListeners.push(cb);
    return function () { var i = boardListeners.indexOf(cb); if (i >= 0) boardListeners.splice(i, 1); };
  }

  /* ================= CSS ================= */
  var cssDone = false;
  function injectCss() {
    if (cssDone) return; cssDone = true;
    UI.injectStyle('survival-css', [
      // Kopfzeile: im Survival-Modus wird das Guthaben golden statt grün.
      '.sv-badge{display:inline-flex;align-items:center;gap:4px;background:linear-gradient(180deg,#ffe680,var(--gold));color:#241a00;',
      'border:1px solid #fff3b0;border-radius:999px;padding:5px 11px;font-weight:900;font-size:12px;letter-spacing:1px;cursor:pointer;',
      'box-shadow:0 0 14px rgba(255,210,63,.5);}',
      'body.mode-survival .balance{border-color:var(--gold);box-shadow:inset 0 0 12px rgba(255,210,63,.2),0 0 16px rgba(255,210,63,.35);}',
      'body.mode-survival .balance-value{color:var(--gold);}',
      '@media(max-width:520px){.sv-badge{font-size:0;padding:5px 8px;gap:0;}}',
      // Menü-Kachel + Gold-Banner auf der Spielauswahl (gerendert in js/app.js)
      '.cat-card.cat-survival{border-color:rgba(255,210,63,.45);background-image:radial-gradient(120% 120% at 50% 0,rgba(255,210,63,.13),transparent 60%);}',
      '.cat-card.cat-survival:hover{border-color:var(--gold);box-shadow:0 0 0 1px rgba(255,210,63,.4),0 0 22px rgba(255,210,63,.25);}',
      '.sv-cat-name{color:var(--gold);text-shadow:0 0 10px rgba(255,210,63,.55);}',
      '.sv-cat-go{color:var(--gold);}',
      '.sv-banner{display:flex;gap:12px;align-items:center;padding:12px 14px;border-color:rgba(255,210,63,.4);',
      'background-image:linear-gradient(90deg,rgba(255,210,63,.12),transparent);}',
      '.sv-banner-ic{font-size:26px;filter:drop-shadow(0 0 8px rgba(255,210,63,.6));}',
      '.sv-banner-t{font-weight:900;color:var(--gold);font-size:14px;}',
      '.sv-banner-d{color:var(--muted);font-size:12px;line-height:1.45;}',
      // Seite
      '.sv-page{display:flex;flex-direction:column;gap:14px;max-width:820px;margin:0 auto;}',
      '.sv-title{color:var(--gold);text-shadow:0 0 10px rgba(255,210,63,.55);}',
      '.sv-hero{padding:22px;text-align:center;display:flex;flex-direction:column;gap:10px;align-items:center;',
      'border-color:rgba(255,210,63,.35);}',
      '.sv-hero-ic{font-size:46px;line-height:1;filter:drop-shadow(0 0 12px rgba(255,210,63,.6));}',
      '.sv-hero-t{font-size:22px;font-weight:900;color:#fff6d5;margin:0;}',
      '.sv-hero-s{color:var(--muted);font-size:13px;max-width:520px;margin:0;line-height:1.55;}',
      '.sv-rec{color:var(--muted);font-size:13px;}.sv-rec b{color:var(--gold);}',
      '.sv-lock-l,.sv-bust-lock{font-size:11px;text-transform:uppercase;letter-spacing:1.4px;color:var(--muted);font-weight:800;margin:0;}',
      '.sv-lock-time,.sv-bust-time{font-size:44px;font-weight:900;color:var(--gold);font-variant-numeric:tabular-nums;',
      'text-shadow:0 0 18px rgba(255,210,63,.5);line-height:1.1;}',
      '.sv-locked .sv-hero-ic{filter:drop-shadow(0 0 12px rgba(255,77,109,.5));}',
      '.sv-live{font-size:11px;font-weight:900;letter-spacing:1.6px;color:var(--neon);text-shadow:0 0 10px rgba(57,255,20,.6);}',
      '.sv-gold{font-size:40px;font-weight:900;color:var(--gold);font-variant-numeric:tabular-nums;text-shadow:0 0 20px rgba(255,210,63,.45);}',
      '.sv-stats{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;width:100%;}',
      '@media(max-width:560px){.sv-stats{grid-template-columns:repeat(2,1fr);}}',
      '.sv-stat{background:rgba(0,0,0,.22);border-radius:10px;padding:8px;display:flex;flex-direction:column;gap:2px;}',
      '.sv-stat-l{font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.7px;font-weight:800;}',
      '.sv-stat-v{font-weight:900;font-variant-numeric:tabular-nums;font-size:14px;color:#fff6d5;}',
      '.sv-actions{display:flex;gap:8px;flex-wrap:wrap;justify-content:center;width:100%;}',
      '.sv-actions .btn{flex:1 1 130px;}',
      // Rangliste
      '.sv-board,.sv-rules{padding:16px;}',
      '.sv-board-t{margin:0 0 10px;font-size:15px;font-weight:900;color:var(--gold);}',
      '.sv-rows{display:flex;flex-direction:column;gap:6px;}',
      '.sv-row{display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:10px;background:rgba(0,0,0,.2);',
      'border:1px solid transparent;}',
      '.sv-row.mine{border-color:var(--gold);background:rgba(255,210,63,.09);}',
      '.sv-row.top1{background:linear-gradient(90deg,rgba(255,210,63,.16),rgba(0,0,0,.2));}',
      '.sv-rank{width:34px;font-weight:900;color:var(--muted);font-size:13px;flex:0 0 auto;}',
      '.sv-pname{flex:1;min-width:0;font-weight:800;display:flex;align-items:center;gap:6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.sv-tag{font-size:9px;font-weight:900;padding:2px 5px;border-radius:99px;letter-spacing:.5px;text-transform:uppercase;flex:0 0 auto;}',
      '.sv-tag.alive{background:rgba(57,255,20,.18);color:var(--neon);}',
      '.sv-tag.dead{background:rgba(255,77,109,.15);color:var(--danger-2,#ff4d6d);}',
      '.sv-pgold{font-weight:900;color:var(--gold);font-variant-numeric:tabular-nums;flex:0 0 auto;}',
      '.sv-ppeak{font-size:10px;color:var(--muted);font-variant-numeric:tabular-nums;flex:0 0 auto;min-width:78px;text-align:right;}',
      '@media(max-width:520px){.sv-ppeak{display:none;}}',
      '.sv-empty{color:var(--muted);text-align:center;padding:14px;font-size:13px;}',
      '.sv-board-h{color:var(--muted);font-size:11px;margin:10px 0 0;text-align:center;}',
      // Regeln
      '.sv-rules-list{display:flex;flex-direction:column;gap:10px;}',
      '.sv-rule{display:flex;gap:10px;align-items:flex-start;}',
      '.sv-rule-ic{font-size:20px;flex:0 0 26px;text-align:center;}',
      '.sv-rule-t{font-weight:900;font-size:13px;}',
      '.sv-rule-d{color:var(--muted);font-size:12px;line-height:1.5;}',
      // Pleite-Overlay
      '.sv-bust{position:fixed;inset:0;z-index:400;display:flex;align-items:center;justify-content:center;padding:20px;',
      'background:radial-gradient(circle at 50% 40%,rgba(60,0,10,.85),rgba(2,8,5,.96));opacity:0;transition:.35s;}',
      '.sv-bust.show{opacity:1;}',
      '.sv-bust-card{padding:28px 26px;text-align:center;max-width:420px;display:flex;flex-direction:column;gap:8px;align-items:center;',
      'border-color:rgba(255,77,109,.4);}',
      '.sv-bust-skull{font-size:56px;line-height:1;}',
      '.sv-bust-title{font-size:38px;font-weight:900;margin:0;color:#fff;letter-spacing:3px;',
      'text-shadow:0 0 18px rgba(255,77,109,.8);}',
      '.sv-bust-sub{color:var(--muted);font-size:13px;margin:0;}',
      '.sv-bust-stats{display:flex;gap:18px;justify-content:center;margin:6px 0;}',
      '.sv-bust-stats>div{display:flex;flex-direction:column;gap:2px;}',
      '.sv-bl{font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.8px;font-weight:800;}',
      '.sv-bv{font-weight:900;color:var(--gold);font-variant-numeric:tabular-nums;}',
      '.sv-bust-btns{margin-top:8px;width:100%;}',
      '.sv-bust-btns .btn{width:100%;}'
    ].join(''));
  }

  /* ================= API + Boot ================= */
  App.Survival = {
    LOCK_MS: LOCK_MS,
    START_GOLD: START_GOLD,
    isActive: runActive,
    isLocked: isLocked,
    /** Welches Backend die Rangliste gerade nutzt: 'firebase' | 'cloud' | 'local'. */
    backendKind: function () { return driver ? driver.kind : 'none'; },
    lockedFor: lockedFor,
    peakEver: peakEver,
    assets: assets,
    startRun: startRun,
    onBust: onBust,
    getBoard: getBoard,
    onBoardChange: onBoardChange,
    renderPage: renderPage,

    /** Vom Admin geschenktes Survival-Gold genau einmal einlösen (siehe js/admin.js
     *  giftGold + der Heartbeat in account.js/presence.js). Wirkt IMMER auf den
     *  Survival-Stand (Gold), egal in welchem Modus der Spieler gerade ist — daher
     *  App.Mode.writeIn('survival', …) statt App.Coins.add (das ginge in den aktiven
     *  Modus, also evtl. ins Casino-Silber). Der Seen-Guard verhindert Doppel-
     *  Gutschrift auf demselben Gerät; der Heartbeat entfernt das Geschenk zusätzlich
     *  aus dem Konto, sobald es angekommen ist. */
    applyGoldGrant: function (grant) {
      if (!grant || !grant.id || !App.Mode) return false;
      if (App.Storage.get(KEY_GOLD_SEEN, null) === grant.id) return false;
      App.Storage.set(KEY_GOLD_SEEN, grant.id);
      var amt = Math.max(0, Math.round(Number(grant.amount) || 0));
      if (!amt) return false;
      var next = App.Mode.readIn('survival', 'gj_balance', 0) + amt;
      App.Mode.writeIn('survival', 'gj_balance', next);
      if (peakEver() < next) App.Storage.set(KEY_PEAK, next);   // Rekord/Bestenliste nachziehen
      if (App.Mode.is('survival')) App.Mode.refresh();          // läuft gerade Survival -> sofort sichtbar
      if (UI && UI.toast) UI.toast('🥇 Vom Admin geschenkt: ' + UI.formatCoins(amt) + ' Gold (Survival)', 'win');
      return true;
    }
  };

  function boot() {
    injectCss();
    installBadge();
    syncBadge();
    App.Mode.onChange(syncBadge);
    // Gold-Stand live in die Rangliste spiegeln (gedrosselt).
    App.Coins.onChange(function () { if (App.Mode.is('survival')) publish(); });
    if (App.Stocks) App.Stocks.onChange(function () { if (App.Mode.is('survival')) publish(); });
    initDriver().then(function (d) {
      driver = d;
      boardEmit();
      publish(true);
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
