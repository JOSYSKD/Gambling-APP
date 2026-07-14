/* progress.js — Gambling-Fortschritt: Level, XP, Quests, Stats  (App.Progress)
 *
 * Hängt sich GENERISCH an das bestehende Coin-System und die UI, damit JEDES
 * Gambling-Spiel automatisch mitzählt — kein Eingriff pro Spiel nötig:
 *   - App.Coins.add(delta<0)  -> Einsatz/Wager  (XP + Quest "gesetzt")
 *   - App.UI.flash(delta)     -> Rundenergebnis (delta>0 = Gewinn)  (XP + Quests)
 *   - hashchange /game/ /mini/-> welches Spiel gerade läuft (Quest "verschiedene Spiele")
 *
 * Level hebt den Wieder-Auffüll-Betrag: Level 1 startet mit 1000, hohe Level mit
 * bis zu 15.000+  (coins.js fragt App.Progress.startBalance() ab).
 *
 * Persistenz: App.Storage (lokal). Alles reine Anzeige-/Spaß-Progression.
 */
(function () {
  'use strict';
  window.App = window.App || {};
  var UI = App.UI, el = UI.el;
  var KEY = 'gj_progress';

  /* ---------------- Zustand ---------------- */
  var DEFAULT = {
    xp: 0,
    stats: { wagered: 0, won: 0, wins: 0, losses: 0, rounds: 0, biggestWin: 0, games: {} },
    quests: {},        // id -> { done:bool, claimed:bool }
    lastDaily: '',     // Datum der letzten Tages-Quests
    daily: []          // aktuelle Tages-Quest-IDs
  };
  var state = load();
  function load() {
    var s = App.Storage ? App.Storage.get(KEY, null) : null;
    if (!s || typeof s !== 'object') s = {};
    s.xp = Math.max(0, Math.round(Number(s.xp) || 0));
    s.stats = Object.assign({ wagered: 0, won: 0, wins: 0, losses: 0, rounds: 0, biggestWin: 0, games: {} }, s.stats || {});
    if (!s.stats.games || typeof s.stats.games !== 'object') s.stats.games = {};
    s.quests = s.quests || {};
    s.daily = s.daily || [];
    s.lastDaily = s.lastDaily || '';
    return s;
  }
  function save() { if (App.Storage) App.Storage.set(KEY, state); }

  var listeners = [];
  function onChange(cb) { listeners.push(cb); return function () { var i = listeners.indexOf(cb); if (i >= 0) listeners.splice(i, 1); }; }
  function emit() { for (var i = 0; i < listeners.length; i++) { try { listeners[i](); } catch (e) {} } }

  /* ---------------- Level-Kurve ---------------- */
  // XP, die von Level L nach L+1 nötig ist (steigt linear).
  function reqFor(level) { return 80 + (level - 1) * 60; }
  // kumulierte XP bis zum Beginn von Level L.
  function cumFor(level) { var t = 0; for (var l = 1; l < level; l++) t += reqFor(l); return t; }
  function levelFromXp(xp) {
    var l = 1;
    while (xp >= cumFor(l + 1) && l < 999) l++;
    return l;
  }
  function level() { return levelFromXp(state.xp); }
  function xpInLevel() { return state.xp - cumFor(level()); }
  function xpForLevel() { return reqFor(level()); }

  // Wieder-Auffüll-/Start-Betrag steigt mit dem Level: L1=1000 … ~L20=15000, dann weiter.
  function startBalance() {
    var L = level();
    var amt = 1000 + (L - 1) * 750;
    return Math.min(200000, Math.round(amt / 50) * 50);
  }

  var TITLES = ['Spielhallen-Neuling', 'Anfänger', 'Zocker', 'Stammgast', 'Kartenhai', 'Glücksritter',
    'High Roller', 'Casino-Profi', 'Roulette-König', 'Poker-Hai', 'Vegas-Veteran', 'Dschungel-Boss',
    'Neon-Legende', 'Casino-Magnat', 'Glücks-Gott'];
  function title() { var L = level(); return TITLES[Math.min(TITLES.length - 1, Math.floor((L - 1) / 2))]; }

  /* ---------------- XP / Level-Up ---------------- */
  function addXp(amount) {
    amount = Math.max(0, Math.round(amount || 0));
    if (!amount) return;
    var before = level();
    state.xp += amount;
    var after = level();
    if (after > before) onLevelUp(before, after);
    save(); emit();
  }
  function onLevelUp(from, to) {
    for (var L = from + 1; L <= to; L++) {
      var bonus = 500 + L * 250;           // Level-Up-Bonus aufs Guthaben
      if (App.Coins) App.Coins.add(bonus);
      celebrate('⭐ Level ' + L + '!', title() + ' · +' + UI.formatCoins(bonus) + ' 🪙 · Auffüllung jetzt ' + UI.formatCoins(1000 + (L - 1) * 750));
    }
    if (App.Audio) App.Audio.sfx('levelup');
  }
  // Konfetti-Regen (leichtgewichtig, DOM, selbst-aufräumend).
  function confetti(n) {
    injectCss();
    n = n || 34;
    var host = el('div', { class: 'gj-confetti' });
    var cols = ['#ff2d55', '#ff9d3c', '#ffd23f', '#39ff14', '#22d3ff', '#a855f7', '#ff6ac1'];
    for (var i = 0; i < n; i++) {
      var pieceStyle = 'left:' + (Math.round(i * 997 % 100)) + '%;' +
        'background:' + cols[i % cols.length] + ';' +
        'animation-delay:' + (i % 10 * 0.06).toFixed(2) + 's;' +
        'animation-duration:' + (1.6 + (i % 7) * 0.18).toFixed(2) + 's;' +
        'transform:rotate(' + (i * 47 % 360) + 'deg);';
      host.appendChild(el('span', { class: 'gj-conf-p', style: pieceStyle }));
    }
    document.body.appendChild(host);
    setTimeout(function () { if (host.parentNode) host.parentNode.removeChild(host); }, 3200);
  }

  function celebrate(title, sub) {
    confetti(46);
    injectCss();
    var card = el('div', { class: 'lvl-pop glass' }, [
      el('div', { class: 'lvl-pop-star' }, ['🎉']),
      el('div', { class: 'lvl-pop-title neon-strong' }, [title]),
      el('div', { class: 'lvl-pop-sub' }, [sub])
    ]);
    document.body.appendChild(card);
    setTimeout(function () { card.classList.add('show'); }, 20);
    setTimeout(function () { card.classList.remove('show'); setTimeout(function () { if (card.parentNode) card.parentNode.removeChild(card); }, 400); }, 3200);
  }

  /* ---------------- Quests ---------------- */
  // prog(s) -> aktueller Fortschritt (Zahl), target -> Ziel. reward {coins,xp}.
  var QUESTS = [
    { id: 'rounds10', icon: '🎰', title: 'Warmspielen', desc: 'Spiele 10 Runden', target: 10, prog: function (s) { return s.rounds; }, reward: { coins: 500, xp: 40 } },
    { id: 'wins10', icon: '🍀', title: 'Glückssträhne', desc: 'Gewinne 10 Runden', target: 10, prog: function (s) { return s.wins; }, reward: { coins: 1000, xp: 80 } },
    { id: 'wager20k', icon: '💸', title: 'High Roller', desc: 'Setze insgesamt 20.000 Coins', target: 20000, prog: function (s) { return s.wagered; }, reward: { coins: 2000, xp: 120 } },
    { id: 'bal10k', icon: '🤑', title: 'Reich werden', desc: 'Erreiche 10.000 Coins Guthaben', target: 10000, prog: function (s) { return s.peakBalance || 0; }, reward: { coins: 3000, xp: 150 } },
    { id: 'bigwin2k', icon: '💥', title: 'Großer Coup', desc: 'Gewinne 2.000+ in einer Runde', target: 2000, prog: function (s) { return s.biggestWin; }, reward: { coins: 2500, xp: 150 } },
    { id: 'games6', icon: '🕹️', title: 'Entdecker', desc: 'Spiele 6 verschiedene Spiele', target: 6, prog: function (s) { return Object.keys(s.games || {}).length; }, reward: { coins: 1500, xp: 100 } },
    { id: 'wins50', icon: '🏆', title: 'Seriensieger', desc: 'Gewinne 50 Runden', target: 50, prog: function (s) { return s.wins; }, reward: { coins: 5000, xp: 300 } },
    { id: 'wager100k', icon: '🐋', title: 'Whale', desc: 'Setze insgesamt 100.000 Coins', target: 100000, prog: function (s) { return s.wagered; }, reward: { coins: 8000, xp: 400 } },
    { id: 'bigwin10k', icon: '🚀', title: 'Jackpot-Jäger', desc: 'Gewinne 10.000+ in einer Runde', target: 10000, prog: function (s) { return s.biggestWin; }, reward: { coins: 10000, xp: 500 } },
    { id: 'bal50k', icon: '👑', title: 'Millionär in spe', desc: 'Erreiche 50.000 Coins Guthaben', target: 50000, prog: function (s) { return s.peakBalance || 0; }, reward: { coins: 12000, xp: 600 } }
  ];
  function questById(id) { for (var i = 0; i < QUESTS.length; i++) if (QUESTS[i].id === id) return QUESTS[i]; return null; }
  function questDone(q) { return q.prog(statsView()) >= q.target; }
  function statsView() {
    var s = state.stats;
    return { wagered: s.wagered, won: s.won, wins: s.wins, losses: s.losses, rounds: s.rounds, biggestWin: s.biggestWin, games: s.games, peakBalance: peakBalance };
  }
  var peakBalance = 0;

  // Fertige, noch nicht belohnte Quests automatisch einlösen.
  function checkQuests() {
    var changed = false;
    QUESTS.forEach(function (q) {
      var rec = state.quests[q.id] || (state.quests[q.id] = { done: false, claimed: false });
      if (!rec.done && questDone(q)) {
        rec.done = true; rec.claimed = true;
        if (App.Coins) App.Coins.add(q.reward.coins);
        state.xp += q.reward.xp;               // direkt (Level-Up-Check folgt via addXp(0)-Pfad unten)
        changed = true;
        toastQuest(q);
      }
    });
    if (changed) {
      // eventuelles Level-Up durch Quest-XP nachziehen
      var before = level(); save();
      // (Level-Up-Feier läuft über addXp; hier XP schon addiert -> kurzer Sync)
      var after = level();
      if (after > before) onLevelUp(before, after);
      emit();
    }
  }
  function toastQuest(q) {
    injectCss();
    var card = el('div', { class: 'quest-pop glass' }, [
      el('div', { class: 'quest-pop-ic' }, [q.icon]),
      el('div', {}, [
        el('div', { class: 'quest-pop-t' }, ['Quest geschafft: ' + q.title]),
        el('div', { class: 'quest-pop-r' }, ['+' + UI.formatCoins(q.reward.coins) + ' 🪙 · +' + q.reward.xp + ' XP'])
      ])
    ]);
    document.body.appendChild(card);
    setTimeout(function () { card.classList.add('show'); }, 20);
    setTimeout(function () { card.classList.remove('show'); setTimeout(function () { if (card.parentNode) card.parentNode.removeChild(card); }, 400); }, 3600);
    if (App.Audio) App.Audio.sfx('powerup');
  }

  /* ---------------- Event-Erfassung ---------------- */
  var curGame = null;
  function noteGame(id) {
    if (!id) return;
    curGame = id;
    if (!state.stats.games[id]) { state.stats.games[id] = 1; save(); checkQuests(); emit(); }
  }
  function hashGame() {
    var h = (location.hash || '').replace(/^#/, '');
    var m = h.match(/^\/(?:game|mini)\/([a-z0-9_-]+)/i);
    return m ? m[1] : null;
  }

  function onWager(amount) {
    amount = Math.round(Math.abs(amount));
    if (amount <= 0) return;
    state.stats.wagered += amount;
    state.stats.rounds += 1;
    addXp(Math.max(1, Math.round(amount / 40)));  // XP fürs Spielen (speichert+emit+levelcheck)
    checkQuests();
  }
  function onOutcome(delta) {
    delta = Math.round(delta);
    if (delta > 0) {
      state.stats.wins += 1;
      state.stats.won += delta;
      if (delta > state.stats.biggestWin) state.stats.biggestWin = delta;
      addXp(Math.max(2, Math.round(delta / 25)));  // Bonus-XP fürs Gewinnen
      if (delta >= 1000) confetti(Math.min(70, 24 + Math.round(delta / 400)));  // Konfetti bei großem Gewinn

    } else if (delta < 0) {
      state.stats.losses += 1;
      save(); emit();
    }
    checkQuests();
  }

  function hook() {
    // Wager: negative Coin-Deltas = Einsätze
    if (App.Coins && !App.Coins.__progHooked) {
      var _add = App.Coins.add.bind(App.Coins);
      App.Coins.add = function (delta) {
        var r = _add(delta);
        if (delta < 0) onWager(delta);
        if (App.Coins.get() > peakBalance) { peakBalance = App.Coins.get(); checkQuests(); }
        return r;
      };
      App.Coins.__progHooked = true;
      peakBalance = App.Coins.get();
    }
    // Rundenergebnis: UI.flash(delta) wird in Gambling-Spielen mit dem Netto-Gewinn/-Verlust aufgerufen
    if (App.UI && !App.UI.__progHooked) {
      var _flash = App.UI.flash;
      App.UI.flash = function (amount) { try { onOutcome(Number(amount) || 0); } catch (e) {} return _flash.apply(this, arguments); };
      App.UI.__progHooked = true;
    }
    window.addEventListener('hashchange', function () { noteGame(hashGame()); });
    noteGame(hashGame());
  }

  /* ---------------- Header-Chip ---------------- */
  var chip = null, chipFill = null, chipLvl = null;
  function installChip() {
    var host = document.querySelector('.topbar-right');
    if (!host || chip) return;
    chip = el('button', { class: 'level-chip', type: 'button', title: 'Level & Quests', onclick: function () { App.Router.go('/quests'); } }, [
      el('span', { class: 'level-chip-star' }, ['⭐']),
      el('span', { class: 'level-chip-lvl' }, ['1']),
      el('span', { class: 'level-chip-bar' }, [el('span', { class: 'level-chip-fill' })])
    ]);
    chipLvl = chip.querySelector('.level-chip-lvl');
    chipFill = chip.querySelector('.level-chip-fill');
    // vor die Navigation setzen
    var nav = host.querySelector('.topnav');
    if (nav) host.insertBefore(chip, nav); else host.appendChild(chip);
    updateChip();
  }
  function updateChip() {
    if (!chip) return;
    chipLvl.textContent = String(level());
    var pct = Math.max(0, Math.min(100, Math.round(xpInLevel() / xpForLevel() * 100)));
    chipFill.style.width = pct + '%';
  }

  /* ---------------- Quest-/Level-Seite ---------------- */
  function renderPage(root) {
    injectCss();
    var L = level();
    var pct = Math.round(xpInLevel() / xpForLevel() * 100);
    var head = el('div', { class: 'lvl-head glass' }, [
      el('div', { class: 'lvl-badge' }, ['⭐', el('span', { class: 'lvl-badge-n' }, [String(L)])]),
      el('div', { class: 'lvl-meta' }, [
        el('div', { class: 'lvl-title neon' }, [title()]),
        el('div', { class: 'lvl-sub' }, ['Level ' + L + ' · ' + xpInLevel() + ' / ' + xpForLevel() + ' XP']),
        el('div', { class: 'lvl-bar' }, [el('div', { class: 'lvl-bar-fill', style: 'width:' + pct + '%' })]),
        el('div', { class: 'lvl-start' }, ['Auffüllung bei Pleite: ', el('b', {}, [UI.formatCoins(startBalance()) + ' 🪙'])])
      ])
    ]);

    var s = statsView();
    var stats = el('div', { class: 'lvl-stats' }, [
      statCard('🎲', 'Runden', UI.formatCoins(s.rounds)),
      statCard('🏆', 'Siege', UI.formatCoins(s.wins)),
      statCard('💸', 'Gesetzt', UI.formatCoins(s.wagered)),
      statCard('💥', 'Größter Gewinn', UI.formatCoins(s.biggestWin))
    ]);

    var list = el('div', { class: 'quest-list' }, QUESTS.map(function (q) {
      var cur = Math.min(q.target, q.prog(s));
      var done = (state.quests[q.id] && state.quests[q.id].done) || cur >= q.target;
      var p = Math.round(cur / q.target * 100);
      return el('div', { class: 'quest-row glass' + (done ? ' done' : '') }, [
        el('div', { class: 'quest-ic' }, [done ? '✅' : q.icon]),
        el('div', { class: 'quest-main' }, [
          el('div', { class: 'quest-t' }, [q.title]),
          el('div', { class: 'quest-d' }, [q.desc]),
          el('div', { class: 'quest-bar' }, [el('div', { class: 'quest-bar-fill', style: 'width:' + p + '%' })]),
          el('div', { class: 'quest-p' }, [UI.formatCoins(cur) + ' / ' + UI.formatCoins(q.target)])
        ]),
        el('div', { class: 'quest-rw' }, [
          el('div', { class: 'quest-rw-c' }, ['+' + UI.formatCoins(q.reward.coins) + ' 🪙']),
          el('div', { class: 'quest-rw-x' }, ['+' + q.reward.xp + ' XP'])
        ])
      ]);
    }));

    root.appendChild(el('div', { class: 'quests-page' }, [
      el('div', { class: 'page-head' }, [
        el('button', { class: 'btn btn-ghost back', type: 'button', onclick: function () { App.Router.go('/'); } }, ['← Menü']),
        el('h2', { class: 'page-title neon' }, ['⭐ Level & Quests'])
      ]),
      head, stats,
      el('h3', { class: 'quest-h' }, ['Quests']),
      list
    ]));
  }
  function statCard(ic, label, val) {
    return el('div', { class: 'lvl-stat glass' }, [
      el('div', { class: 'lvl-stat-ic' }, [ic]),
      el('div', { class: 'lvl-stat-v' }, [val]),
      el('div', { class: 'lvl-stat-l' }, [label])
    ]);
  }

  /* ---------------- CSS ---------------- */
  var cssDone = false;
  function injectCss() {
    if (cssDone) return; cssDone = true;
    UI.injectStyle('progress-css', [
      '.level-chip{display:inline-flex;align-items:center;gap:5px;background:rgba(9,32,21,.7);border:1px solid var(--stroke);border-radius:999px;padding:5px 10px 5px 8px;cursor:pointer;color:var(--text);font-weight:800;font-size:13px;transition:.15s;}',
      '.level-chip:hover{border-color:var(--neon);box-shadow:0 0 0 1px rgba(57,255,20,.35);}',
      '.level-chip-star{filter:drop-shadow(0 0 5px rgba(255,210,63,.6));}',
      '.level-chip-lvl{color:var(--gold);font-variant-numeric:tabular-nums;}',
      '.level-chip-bar{width:34px;height:6px;border-radius:99px;background:rgba(255,255,255,.12);overflow:hidden;}',
      '.level-chip-fill{display:block;height:100%;width:0;background:linear-gradient(90deg,var(--neon),var(--gold));transition:width .4s ease;}',
      '@media(max-width:520px){.level-chip-bar{display:none;}}',
      '.lvl-pop,.quest-pop{position:fixed;left:50%;top:22%;transform:translate(-50%,-14px);z-index:300;padding:16px 22px;text-align:center;opacity:0;transition:.35s ease;pointer-events:none;max-width:88vw;}',
      '.lvl-pop.show,.quest-pop.show{opacity:1;transform:translate(-50%,0);}',
      '.lvl-pop-star{font-size:40px;line-height:1;}',
      '.lvl-pop-title{font-size:26px;font-weight:900;margin-top:4px;}',
      '.lvl-pop-sub{color:var(--muted);font-weight:700;margin-top:2px;}',
      '.quest-pop{display:flex;align-items:center;gap:12px;text-align:left;top:auto;bottom:26px;}',
      '.quest-pop-ic{font-size:30px;}',
      '.quest-pop-t{font-weight:900;color:var(--neon);}',
      '.quest-pop-r{color:var(--gold);font-weight:800;font-size:13px;}',
      '.quests-page{display:flex;flex-direction:column;gap:16px;max-width:760px;margin:0 auto;}',
      '.lvl-head{display:flex;gap:16px;align-items:center;padding:18px;}',
      '.lvl-badge{position:relative;width:64px;height:64px;flex:0 0 auto;display:flex;align-items:center;justify-content:center;font-size:34px;border-radius:16px;background:radial-gradient(circle at 50% 35%,rgba(255,210,63,.25),rgba(9,32,21,.6));border:1px solid var(--stroke-2,var(--stroke));}',
      '.lvl-badge-n{position:absolute;right:-6px;bottom:-6px;background:var(--gold);color:#1a1200;font-size:14px;font-weight:900;border-radius:99px;min-width:22px;height:22px;display:flex;align-items:center;justify-content:center;padding:0 5px;box-shadow:0 0 10px rgba(255,210,63,.6);}',
      '.lvl-meta{flex:1;min-width:0;}',
      '.lvl-title{font-size:20px;font-weight:900;}',
      '.lvl-sub{color:var(--muted);font-size:13px;font-weight:700;margin:2px 0 8px;}',
      '.lvl-bar,.quest-bar{height:9px;border-radius:99px;background:rgba(255,255,255,.1);overflow:hidden;}',
      '.lvl-bar-fill{height:100%;background:linear-gradient(90deg,var(--neon),var(--gold));box-shadow:0 0 10px rgba(57,255,20,.4);}',
      '.lvl-start{margin-top:8px;color:var(--muted);font-size:13px;}',
      '.lvl-start b{color:var(--gold);}',
      '.lvl-stats{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;}',
      '@media(max-width:560px){.lvl-stats{grid-template-columns:repeat(2,1fr);}}',
      '.lvl-stat{padding:12px;text-align:center;}',
      '.lvl-stat-ic{font-size:22px;}',
      '.lvl-stat-v{font-size:19px;font-weight:900;color:var(--gold);font-variant-numeric:tabular-nums;}',
      '.lvl-stat-l{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;font-weight:800;}',
      '.quest-h{margin:4px 0 -4px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;font-size:13px;}',
      '.quest-list{display:flex;flex-direction:column;gap:10px;}',
      '.quest-row{display:flex;gap:12px;align-items:center;padding:12px 14px;}',
      '.quest-row.done{border-color:var(--stroke-2,var(--stroke));box-shadow:0 0 0 1px rgba(57,255,20,.25);}',
      '.quest-ic{font-size:26px;flex:0 0 auto;width:34px;text-align:center;}',
      '.quest-main{flex:1;min-width:0;}',
      '.quest-t{font-weight:900;}',
      '.quest-d{color:var(--muted);font-size:12px;margin-bottom:6px;}',
      '.quest-bar-fill{height:100%;background:linear-gradient(90deg,var(--aqua),var(--neon));}',
      '.quest-p{font-size:11px;color:var(--muted);font-variant-numeric:tabular-nums;margin-top:3px;}',
      '.quest-rw{text-align:right;flex:0 0 auto;}',
      '.quest-rw-c{color:var(--gold);font-weight:900;font-size:13px;white-space:nowrap;}',
      '.quest-rw-x{color:var(--aqua);font-weight:800;font-size:11px;}',
      '.gj-confetti{position:fixed;inset:0;z-index:290;pointer-events:none;overflow:hidden;}',
      '.gj-conf-p{position:absolute;top:-14px;width:10px;height:14px;border-radius:2px;opacity:.95;animation:gj-fall linear forwards;}',
      '@keyframes gj-fall{0%{transform:translateY(-10px) rotate(0);opacity:1;}100%{transform:translateY(102vh) rotate(680deg);opacity:.9;}}'
    ].join(''));
  }

  /* ---------------- API + Boot ---------------- */
  App.Progress = {
    level: level, xpInLevel: xpInLevel, xpForLevel: xpForLevel, title: title,
    startBalance: startBalance, addXp: addXp,
    stats: function () { return statsView(); },
    quests: function () { return QUESTS.slice(); },
    onChange: onChange, renderPage: renderPage
  };
  // Chip live aktualisieren
  onChange(updateChip);

  function boot() {
    hook();
    installChip();
    updateChip();
    checkQuests();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
