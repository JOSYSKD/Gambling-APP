/* progress.js — Gambling-Fortschritt: Level, XP, Quests, Stats  (App.Progress)
 *
 * Hängt sich GENERISCH an das bestehende Coin-System und die UI, damit JEDES
 * Gambling-Spiel automatisch mitzählt — kein Eingriff pro Spiel nötig:
 *   - App.Coins.add(delta<0)  -> Einsatz/Wager  (XP + Quest "gesetzt")
 *   - App.UI.flash(delta)     -> Rundenergebnis (delta>0 = Gewinn)  (XP + Quests)
 *   - hashchange /game/ /mini/-> welches Spiel gerade läuft (Quest "verschiedene Spiele")
 *
 * Level UND erledigte Quests heben den Wieder-Auffüll-Betrag: Level 1 startet mit
 * 1000, wächst mit dem Level weiter und zusätzlich mit jeder fertigen Quest — ohne
 * Deckel (coins.js fragt App.Progress.startBalance() ab).
 *
 * Persistenz: App.Storage (lokal). Alles reine Anzeige-/Spaß-Progression.
 */
(function () {
  'use strict';
  window.App = window.App || {};
  var UI = App.UI, el = UI.el;
  var KEY = 'gj_progress';

  // RESET-GENERATION: Diese Zahl hochzählen, um bei ALLEN Spielern Level, XP und
  // Quests EINMALIG zurückzusetzen. Beim nächsten Laden erkennt jeder Client eine
  // ältere Generation im Storage und setzt seinen Stand auf null — für Casino UND
  // Survival getrennt (mode.js präfixt gj_progress). Über den Konto-Heartbeat
  // (account.js snapshotToAccount) landet der Reset danach auch in den Cloud-Konten,
  // sodass ein späterer Login den alten Stand NICHT zurückholt.
  var RESET_GEN = 8;

  function freshStats() {
    return {
      wagered: 0, won: 0, wins: 0, losses: 0, rounds: 0, biggestWin: 0,
      games: {},      // id -> 1 (welche Spiele schon gespielt)
      gameWins: {},   // id -> Anzahl Siege in genau diesem Spiel (für Meister-Quests)
      streak: 0,      // aktuelle Sieg-Serie
      maxStreak: 0    // längste Sieg-Serie überhaupt
    };
  }

  /* ---------------- Zustand ---------------- */
  var DEFAULT = { xp: 0, stats: freshStats(), quests: {}, lastDaily: '', daily: [], resetGen: RESET_GEN };
  var state = load();
  function load() {
    var s = App.Storage ? App.Storage.get(KEY, null) : null;
    if (!s || typeof s !== 'object') s = {};
    // Globaler Reset (siehe RESET_GEN): Level/XP, Quests UND Stats komplett auf null.
    // Die Stats werden bewusst mit zurückgesetzt: die Quests hängen an ihnen, und das
    // durch den alten Geld-Bug astronomisch verfälschte `wagered` (10^21) hielt die
    // Risiko-Quests dauerhaft erfüllt. Nur ein voller Reset macht ALLE Quests wieder
    // offen. Der checkQuests-Backfill (unten) bleibt als Schutz gegen Rest-Stände.
    if ((Number(s.resetGen) || 0) < RESET_GEN) {
      s = { xp: 0, stats: freshStats(), quests: {}, lastDaily: s.lastDaily || '', daily: s.daily || [], resetGen: RESET_GEN };
      if (App.Storage) App.Storage.set(KEY, s);
      return s;
    }
    s.xp = Math.max(0, Math.round(Number(s.xp) || 0));
    s.stats = Object.assign(freshStats(), s.stats || {});
    if (!s.stats.games || typeof s.stats.games !== 'object') s.stats.games = {};
    if (!s.stats.gameWins || typeof s.stats.gameWins !== 'object') s.stats.gameWins = {};
    s.quests = s.quests || {};
    s.daily = s.daily || [];
    s.lastDaily = s.lastDaily || '';
    s.resetGen = RESET_GEN;
    return s;
  }
  function save() { if (App.Storage) App.Storage.set(KEY, state); }

  var listeners = [];
  function onChange(cb) { listeners.push(cb); return function () { var i = listeners.indexOf(cb); if (i >= 0) listeners.splice(i, 1); }; }
  function emit() { for (var i = 0; i < listeners.length; i++) { try { listeners[i](); } catch (e) {} } }

  /* ---------------- Level-Kurve ---------------- */
  // Höchstlevel. Wer es erreicht, bekommt einen goldenen Namen (siehe isMaxLevel()).
  var MAX_LEVEL = 99999;

  // XP von Level L nach L+1 — BRUTAL STEIL und mit dem Level immer steiler: ein
  // quadratischer PLUS ein kubischer Term, damit jedes weitere Level spürbar
  // länger dauert als das vorige. AB HARD_AT (3000) legt ein zusätzlicher, eigener
  // kubischer Term obendrauf -> ab dort wird es extrem. Auf Josls Wunsch um Faktor 5
  // gesenkt (alle Koeffizienten /5): man levelt jetzt 5× so schnell wie zuvor, die
  // Form der Kurve (mit dem Level immer steiler) bleibt gleich.
  var LC_BASE = 100, LC_Q = 40, LC_K = 0.6, LC_XTRA = 10, HARD_AT = 3000;
  function reqFor(level) {
    var d = level - 1;
    var r = LC_BASE + LC_Q * d * d + LC_K * d * d * d;
    if (level > HARD_AT) r += LC_XTRA * Math.pow(level - HARD_AT, 3);
    return Math.round(r);
  }

  // Kumulierte XP bis zum Beginn von Level L — GESCHLOSSENE FORMEL statt Schleife
  // (bei Höchstlevel 99999 wäre eine O(L)-Summe in der O(L)-Level-Suche = O(L²) ein
  // Browser-Freeze). cumFor(L) = Summe reqFor(1..L-1). Mit n = L-1:
  //   500·n + 200·Σk² + 3·Σk³ (k=0..n-1)  [+ 50·Σk³ (k=0..n-3000) ab HARD_AT].
  function sumSq(m) { return m < 0 ? 0 : m * (m + 1) * (2 * m + 1) / 6; }   // Σ_{k=0..m} k²
  function sumCu(m) { if (m < 0) return 0; var t = m * (m + 1) / 2; return t * t; }  // Σ_{k=0..m} k³
  function cumFor(level) {
    var n = level - 1;
    if (n <= 0) return 0;
    var c = LC_BASE * n + LC_Q * sumSq(n - 1) + LC_K * sumCu(n - 1);
    if (n > HARD_AT) c += LC_XTRA * sumCu(n - HARD_AT);
    return c;
  }
  // Level aus XP per Binärsuche über [1, MAX_LEVEL] (O(log) statt O(L)).
  function levelFromXp(xp) {
    var lo = 1, hi = MAX_LEVEL;
    while (lo < hi) {
      var mid = Math.floor((lo + hi + 1) / 2);
      if (cumFor(mid) <= xp) lo = mid; else hi = mid - 1;
    }
    return lo;
  }
  function level() { return levelFromXp(state.xp); }
  function xpInLevel() { return state.xp - cumFor(level()); }
  function xpForLevel() { return level() >= MAX_LEVEL ? 0 : reqFor(level()); }
  function isMaxLevel() { return level() >= MAX_LEVEL; }

  // Wie stark Level und Quests das Wieder-Auffüll-Guthaben heben. Auf Josls Wunsch
  // gibt das LEVEL jetzt viel mehr fürs Wiedereinstiegsguthaben (100 -> 1000 je Level):
  // wer hoch levelt, startet nach einer Pleite mit spürbar mehr Coins.
  var LEVEL_START_STEP = 1000;   // Guthaben-Zuwachs pro Level
  var QUEST_START_SHARE = 0.02;  // Anteil der Quest-Belohnung im Startguthaben (früher 0.4)

  // Bonus aus SELBST erledigten Quests: jede hebt den Wieder-Auffüll-Betrag um einen
  // Teil ihrer Belohnung. Vor einem Reset erfüllte Quests (bf=true) zählen NICHT mit,
  // und der Bonus ist bei QUEST_START_CAP gedeckelt — sonst startet man nach dem Reset
  // mit hunderttausenden statt ~1000.
  var QUEST_START_CAP = 25000;
  function questBonusOf(st) {
    var total = 0, quests = (st && st.quests) || {};
    for (var i = 0; i < QUESTS.length; i++) {
      var q = QUESTS[i], rec = quests[q.id];
      if (rec && rec.done && !rec.bf) total += Math.round(q.reward.coins * QUEST_START_SHARE);
    }
    return Math.min(QUEST_START_CAP, total);
  }
  function questBonus() { return questBonusOf(state); }

  // Wieder-Auffüll-/Start-Betrag steigt mit dem Level (L1=1000, +3000 je Level)
  // UND mit der Anzahl/Schwere bereits erledigter Quests — kein Deckel,
  // der Betrag wächst mit dem Fortschritt unbegrenzt weiter.
  function startBalanceOf(st) {
    var L = levelFromXp(Math.max(0, Math.round(Number(st && st.xp) || 0)));
    var amt = 1000 + (L - 1) * LEVEL_START_STEP + questBonusOf(st);
    return Math.round(amt / 50) * 50;
  }
  function startBalance() { return startBalanceOf(state); }

  /* Level des Spielers auf ein Ziel setzen bzw. um N senken (Admin-Werkzeug,
   * siehe js/admin.js). XP werden auf den Beginn des Ziellevels gesetzt — das
   * Level sinkt, XP/Quests darüber hinaus gehen dabei bewusst verloren. Nie
   * unter Level 1. */
  function setLevelTo(target) {
    target = Math.max(1, Math.min(MAX_LEVEL, Math.round(Number(target) || 1)));
    state.xp = cumFor(target);
    save(); updateChip(); emit();
    return level();
  }
  function subtractLevels(n) { return setLevelTo(level() - Math.max(0, Math.round(Number(n) || 0))); }

  /* Admin-Level-Abzug einlösen (genau einmal, Muster wie applyGoldGrant in
   * survival.js): Der Admin setzt admin.levelAdjust = {id, delta}; der Client
   * senkt sein eigenes Level einmalig und merkt sich die id. */
  var KEY_LVL_SEEN = 'gj_level_adjust_seen';
  function applyLevelAdjust(grant) {
    if (!grant || !grant.id) return false;
    if (App.Storage.get(KEY_LVL_SEEN, null) === grant.id) return false;
    App.Storage.set(KEY_LVL_SEEN, grant.id);
    if (typeof grant.setTo === 'number') setLevelTo(grant.setTo);
    else subtractLevels(grant.delta || 0);
    if (App.UI) App.UI.toast('⬇️ Ein Admin hat dein Level angepasst — jetzt Level ' + level() + '.', 'lose');
    return true;
  }

  /* Einstiegsguthaben eines BESTIMMTEN Modus — auch wenn gerade der andere aktiv
   * ist. Nötig für die Ideen-Belohnung (js/ideas.js), die immer in Casino-Silber
   * ausgezahlt wird, egal ob der Spieler gerade Survival spielt. */
  function startBalanceIn(m) {
    if (!App.Mode || !App.Mode.readIn) return startBalance();
    var st = App.Mode.readIn(m, KEY, null);
    if (!st || typeof st !== 'object') return 1000;
    return startBalanceOf(st);
  }

  /* Längste Sieg-Serie (Siege in Folge über ALLE Gambling-Spiele; reißt bei jedem
   * Verlust). state.stats.maxStreak wird in onOutcome geführt — Quelle für die
   * Serien-Quests UND die Streak-Bestenliste (js/leaderboard.js getStreakBoard). */
  function maxStreak() { return Math.max(0, Math.round(Number(state.stats.maxStreak) || 0)); }
  function curStreak() { return Math.max(0, Math.round(Number(state.stats.streak) || 0)); }
  /* Wie maxStreak(), aber für einen BESTIMMTEN Modus — auch wenn gerade der andere
   * aktiv ist. Die Bestenliste soll immer die Casino-Serie zeigen (wie der
   * Casino-Peak in js/presence.js), egal ob der Spieler gerade Survival spielt. */
  function maxStreakIn(m) {
    if (!App.Mode || !App.Mode.readIn) return maxStreak();
    var st = App.Mode.readIn(m, KEY, null);
    return Math.max(0, Math.round(Number(st && st.stats && st.stats.maxStreak) || 0));
  }

  var TITLES = ['Spielhallen-Neuling', 'Anfänger', 'Zocker', 'Stammgast', 'Kartenhai', 'Glücksritter',
    'High Roller', 'Casino-Profi', 'Roulette-König', 'Poker-Hai', 'Vegas-Veteran', 'Dschungel-Boss',
    'Neon-Legende', 'Casino-Magnat', 'Glücks-Gott'];
  function title() {
    if (isMaxLevel()) return '👑 Platin-Legende';   // Höchstlevel-Titel
    var L = level();
    return TITLES[Math.min(TITLES.length - 1, Math.floor((L - 1) / 2))];
  }

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
    // Bei einem sehr großen Sprung (z. B. riesige Quest-XP) nicht pro Level eine
    // eigene Feier zeigen — das wären sonst Tausende Popups. Dann Bonus als Summe
    // gutschreiben und nur EINE Feier zeigen.
    if (to - from > 25) {
      var lump = 0;
      for (var k = from + 1; k <= to; k++) lump += 500 + k * 250;
      if (App.Coins) App.Coins.add(lump);
      celebrate('⭐ Level ' + from + ' → ' + to + '!', title() + ' · +' + UI.formatCoins(lump) + ' 🪙');
    } else {
      for (var L = from + 1; L <= to; L++) {
        var bonus = 500 + L * 250;           // Level-Up-Bonus aufs Guthaben
        if (App.Coins) App.Coins.add(bonus);
        celebrate('⭐ Level ' + L + '!', title() + ' · +' + UI.formatCoins(bonus) + ' 🪙 · Auffüllung jetzt ' + UI.formatShort(1000 + (L - 1) * LEVEL_START_STEP));
      }
    }
    // Höchstlevel erreicht -> große Feier + goldener Name freigeschaltet.
    if (to >= MAX_LEVEL && from < MAX_LEVEL) {
      confetti(90);
      celebrate('👑 LEVEL 99.999 — MAXIMUM!', 'Dein Name glänzt ab jetzt überall golden.');
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
  // Basis-Quests — bewusst deutlich schwerer als früher (Ziele grob verdoppelt/verdreifacht).
  var BASE_QUESTS = [
    { id: 'rounds10', icon: '🎰', title: 'Warmspielen', desc: 'Spiele 25 Runden', target: 25, prog: function (s) { return s.rounds; }, reward: { coins: 400, xp: 30 } },
    { id: 'wins10', icon: '🍀', title: 'Glückssträhne', desc: 'Gewinne 25 Runden', target: 25, prog: function (s) { return s.wins; }, reward: { coins: 1000, xp: 60 } },
    { id: 'wager20k', icon: '💸', title: 'High Roller', desc: 'Setze insgesamt 40.000 Coins', target: 40000, prog: function (s) { return s.wagered; }, reward: { coins: 2000, xp: 90 } },
    { id: 'bal10k', icon: '🤑', title: 'Reich werden', desc: 'Erreiche 20.000 Coins Guthaben', target: 20000, prog: function (s) { return s.peakBalance || 0; }, reward: { coins: 3000, xp: 110 } },
    { id: 'bigwin2k', icon: '💥', title: 'Großer Coup', desc: 'Gewinne 4.000+ in einer Runde', target: 4000, prog: function (s) { return s.biggestWin; }, reward: { coins: 3000, xp: 120 } },
    { id: 'games6', icon: '🕹️', title: 'Entdecker', desc: 'Spiele 8 verschiedene Spiele', target: 8, prog: function (s) { return Object.keys(s.games || {}).length; }, reward: { coins: 1500, xp: 90 } },
    { id: 'streakstart', icon: '🔥', title: 'Heiß gelaufen', desc: 'Gewinne 5 Runden hintereinander', target: 5, prog: function (s) { return s.maxStreak || 0; }, reward: { coins: 2000, xp: 100 } },
    { id: 'wins50', icon: '🏆', title: 'Seriensieger', desc: 'Gewinne 75 Runden', target: 75, prog: function (s) { return s.wins; }, reward: { coins: 6000, xp: 220 } },
    { id: 'wager100k', icon: '🐋', title: 'Whale', desc: 'Setze insgesamt 250.000 Coins', target: 250000, prog: function (s) { return s.wagered; }, reward: { coins: 10000, xp: 320 } },
    { id: 'bigwin10k', icon: '🚀', title: 'Jackpot-Jäger', desc: 'Gewinne 25.000+ in einer Runde', target: 25000, prog: function (s) { return s.biggestWin; }, reward: { coins: 12000, xp: 420 } },
    { id: 'bal50k', icon: '👑', title: 'Millionär in spe', desc: 'Erreiche 120.000 Coins Guthaben', target: 120000, prog: function (s) { return s.peakBalance || 0; }, reward: { coins: 15000, xp: 520 } }
  ];

  // FAIRE Belohnung: Coins wachsen mit der Schwierigkeit (Ziel), aber STARK sublinear
  // (≈ dritte Wurzel) und gedeckelt. Früher war es 0,6× des Ziels — dadurch gab eine
  // einzige große Quest fast so viel wie ihr Ziel und hebelte jeden Reset sofort aus.
  // Jetzt: kleine Quests lohnen sich spürbar, riesige Ziele sprengen das Geld nicht mehr.
  // `weight` = wie schwer der Quest-TYP pro Ziel-Einheit ist: Coins setzen ist leicht
  // (0,35), eine Sieg-Serie schwer (2,0). So spiegelt die Belohnung die echte Mühe
  // wider und nicht nur die nackte Zielzahl.
  var QR_K = 60, QR_P = 0.34, QR_MIN = 150, QR_MAX = 300000;
  function questReward(target, weight) {
    var t = Math.max(1, Number(target) || 1);
    var w = (weight == null) ? 1 : weight;
    var coins = Math.round(QR_K * Math.pow(t, QR_P) * w);
    return {
      coins: Math.max(QR_MIN, Math.min(QR_MAX, coins)),
      xp: Math.max(20, Math.round(30 * Math.log10(t + 10)))
    };
  }
  function tierQuests(prefix, icon, targets, titleFn, descFn, progFn, weight) {
    return targets.map(function (t) {
      return { id: prefix + t, icon: icon, title: titleFn(t), desc: descFn(t), target: t, prog: progFn, reward: questReward(t, weight) };
    });
  }
  var fmt = function (n) { return UI.formatShort(n); };

  /* ---------------- Risiko-Mega-Quests ---------------- */
  // 150 Quests, bei denen man ASTRONOMISCHE Summen setzt (riskiert) — von 1 Billion
  // (10^12) bis zu 1 Trilliarde (10^21). Gemessen am gesamten Einsatz (s.wagered),
  // nahtlose Fortsetzung der normalen 'wager'-Quests (die bei 10^11 enden).
  //
  // Auch die Mega-Quests bekommen die faire, gedeckelte Belohnung (früher Ziel/2 =
  // astronomisch und spielbrechend). Sie sind reine Prestige-Ziele; die Belohnung
  // ist wie bei allen Quests gedeckelt, nur die XP etwas höher.
  function megaReward(target) {
    var r = questReward(target);
    return { coins: r.coins, xp: Math.max(300, r.xp) };
  }
  function megaRiskQuests() {
    var LO = 1e12, HI = 1e21, N = 150;
    var span = Math.log10(HI / LO);   // = 9 Größenordnungen
    var out = [];
    for (var i = 0; i < N; i++) {
      // Geometrisch gestaffelt, auf 3 signifikante Stellen gerundet -> streng steigend.
      var raw = LO * Math.pow(10, span * i / (N - 1));
      var mag = Math.pow(10, Math.floor(Math.log10(raw)) - 2);
      var t = Math.round(raw / mag) * mag;
      out.push({
        id: 'risk' + i,
        icon: (i >= 130 ? '💎' : i >= 90 ? '👑' : i >= 45 ? '🐋' : '🎲'),
        title: 'Risiko ' + fmt(t),
        desc: 'Setze (riskiere) insgesamt ' + fmt(t) + ' Coins' + (i === N - 1 ? ' — der absolute Wahnsinn!' : ''),
        target: t,
        prog: function (s) { return s.wagered; },
        reward: megaReward(t)
      });
    }
    return out;
  }

  // 16 Solo-Gambling-Spiele + 4 Poker-Tische (Multiplayer per Raum-Code) — je einmal antreten.
  var PLAY_GAMES = [
    { id: 'blackjack', icon: '🃏', name: 'Blackjack' }, { id: 'crash', icon: '🚀', name: 'Crash' },
    { id: 'cuberoll', icon: '🎲', name: 'Cube-Roll' }, { id: 'slots', icon: '🎰', name: 'Slots' },
    { id: 'roulette', icon: '🎡', name: 'Roulette' }, { id: 'mines', icon: '💣', name: 'Mines' },
    { id: 'coinflip', icon: '🪙', name: 'Coinflip' }, { id: 'wheel', icon: '🌀', name: 'Glücksrad' },
    { id: 'baccarat', icon: '🎴', name: 'Baccarat' }, { id: 'videopoker', icon: '🃏', name: 'Video Poker' },
    { id: 'casinowar', icon: '⚔️', name: 'Casino War' }, { id: 'dragontiger', icon: '🐲', name: 'Dragon Tiger' },
    { id: 'andarbahar', icon: '🪔', name: 'Andar Bahar' }, { id: 'sicbo', icon: '🎲', name: 'Sic Bo' },
    { id: 'keno', icon: '🔢', name: 'Keno' }, { id: 'plinko', icon: '🎯', name: 'Plinko' },
    { id: 'holdem', icon: '♠️', name: 'Texas Hold’em' }, { id: 'omaha', icon: '🃏', name: 'Omaha' },
    { id: 'stud', icon: '🂭', name: 'Seven-Card Stud' }, { id: 'fivedraw', icon: '🎴', name: 'Five-Card Draw' }
  ];

  // NEUE Quest-Art: Sieg-Serien (Siege in Folge, ohne Verlust dazwischen).
  var STREAK_QUESTS = tierQuests('streak', '🔥', [3, 5, 8, 12, 20, 30, 50, 75],
    function (t) { return t + 'er-Serie'; },
    function (t) { return 'Gewinne ' + t + ' Runden HINTEREINANDER (ohne Verlust dazwischen)'; },
    function (s) { return s.maxStreak || 0; }, 2.0);

  // NEUE Quest-Art: Spiel-Meisterschaft — an EINEM bestimmten Spiel oft gewinnen.
  var MASTERY_GAMES = [
    { id: 'blackjack', icon: '🃏', name: 'Blackjack' }, { id: 'crash', icon: '🚀', name: 'Crash' },
    { id: 'slots', icon: '🎰', name: 'Slots' }, { id: 'roulette', icon: '🎡', name: 'Roulette' },
    { id: 'mines', icon: '💣', name: 'Mines' }, { id: 'plinko', icon: '🎯', name: 'Plinko' },
    { id: 'coinflip', icon: '🪙', name: 'Coinflip' }, { id: 'cuberoll', icon: '🎲', name: 'Cube-Roll' },
    { id: 'wheel', icon: '🌀', name: 'Glücksrad' }, { id: 'baccarat', icon: '🎴', name: 'Baccarat' }
  ];
  var MASTERY_QUESTS = [];
  MASTERY_GAMES.forEach(function (g) {
    [25, 100, 300].forEach(function (t) {
      MASTERY_QUESTS.push({
        id: 'gwin_' + g.id + '_' + t, icon: g.icon,
        title: g.name + '-Meister ' + t, desc: 'Gewinne ' + t + ' Runden ' + g.name,
        target: t, prog: (function (id) { return function (s) { return (s.gameWins && s.gameWins[id]) || 0; }; })(g.id),
        reward: questReward(t * 40)
      });
    });
  });

  var EXTRA_QUESTS = []
    .concat(STREAK_QUESTS)
    .concat(MASTERY_QUESTS)
    .concat(tierQuests('rounds', '🎰', [50, 150, 400, 1000, 2500, 6000, 15000, 40000, 100000],
      function (t) { return 'Marathon ' + fmt(t); }, function (t) { return 'Spiele ' + fmt(t) + ' Runden'; },
      function (s) { return s.rounds; }))
    .concat(tierQuests('wins', '🍀', [150, 400, 1000, 2500, 6000, 15000, 40000, 100000],
      function (t) { return 'Siegesserie ' + fmt(t); }, function (t) { return 'Gewinne ' + fmt(t) + ' Runden'; },
      function (s) { return s.wins; }, 1.3))
    .concat(tierQuests('wager', '💸', [500000, 2000000, 10000000, 50000000, 250000000, 1000000000, 10000000000, 100000000000],
      function (t) { return 'Kapitaleinsatz ' + fmt(t); }, function (t) { return 'Setze insgesamt ' + fmt(t) + ' Coins'; },
      function (s) { return s.wagered; }, 0.35))
    .concat(tierQuests('bigwin', '💥', [50000, 250000, 1000000, 5000000, 25000000, 100000000, 500000000, 2000000000],
      function (t) { return 'Mega-Coup ' + fmt(t); }, function (t) { return 'Gewinne ' + fmt(t) + '+ in einer Runde'; },
      function (s) { return s.biggestWin; }, 0.7))
    .concat(tierQuests('bal', '👑', [250000, 1000000, 5000000, 25000000, 100000000, 500000000, 2500000000, 10000000000, 50000000000, 250000000000, 1000000000000],
      function (t) { return t >= 1000000000000 ? 'Trillionär' : 'Vermögen ' + fmt(t); },
      function (t) { return 'Erreiche ' + fmt(t) + ' Coins Guthaben' + (t >= 1000000000000 ? ' — die schwerste Quest überhaupt!' : ''); },
      function (s) { return s.peakBalance || 0; }, 0.6))
    .concat(tierQuests('games', '🕹️', [10, 15, 20, 25],
      function (t) { return 'Vielspieler ' + t; }, function (t) { return 'Spiele ' + t + ' verschiedene Spiele'; },
      function (s) { return Object.keys(s.games || {}).length; }, 1.5))
    .concat(tierQuests('losses', '🛡️', [10, 50, 150, 400, 1000],
      function (t) { return 'Durchhalten ' + fmt(t); }, function (t) { return 'Verliere ' + fmt(t) + ' Runden — Kopf hoch!'; },
      function (s) { return s.losses; }, 0.4))
    .concat(tierQuests('level', '⭐',
      [5, 10, 15, 20, 25, 30, 40, 50, 75, 100, 150, 200, 300, 500, 750, 1000,
       1500, 2500, 5000, 7500, 10000, 15000, 25000, 40000, 60000, 80000, 99999],
      function (t) { return t >= MAX_LEVEL ? '👑 Höchstlevel 99.999' : 'Level ' + fmt(t) + ' erreicht'; },
      function (t) { return t >= MAX_LEVEL ? 'Erreiche das Maximallevel 99.999 — goldener Name!' : 'Erreiche Level ' + fmt(t); },
      function () { return level(); }))
    .concat(PLAY_GAMES.map(function (g) {
      return {
        id: 'play_' + g.id, icon: g.icon, title: 'Erstmal ' + g.name, desc: 'Spiele einmal ' + g.name,
        target: 1, prog: function (s) { return (s.games && s.games[g.id]) ? 1 : 0; }, reward: questReward(1)
      };
    }))
    // (Chip-Quests entfernt — Pokerchips wurden durch die Bank ersetzt.)
    .concat(megaRiskQuests());   // 150 Risiko-Mega-Quests (10^12 … 10^21)

  var QUESTS = BASE_QUESTS.concat(EXTRA_QUESTS);
  function questById(id) { for (var i = 0; i < QUESTS.length; i++) if (QUESTS[i].id === id) return QUESTS[i]; return null; }
  function questDone(q) { return q.prog(statsView()) >= q.target; }
  function statsView() {
    var s = state.stats;
    return { wagered: s.wagered, won: s.won, wins: s.wins, losses: s.losses, rounds: s.rounds,
      biggestWin: s.biggestWin, games: s.games, gameWins: s.gameWins || {},
      streak: s.streak || 0, maxStreak: s.maxStreak || 0, peakBalance: peakBalance };
  }
  var peakBalance = 0;
  // Wird bei jedem (Re)Load auf false gesetzt (siehe reloadFromStorage). Der ERSTE
  // checkQuests danach markiert schon erfüllte Quests nur als abgeholt (bf), statt sie
  // auszuzahlen — SO wird verhindert, dass nach einem Stats-erhaltenden Reset die
  // durch die behaltenen Stats erfüllten Quests (inkl. Mega-Quests à 300k) rückwirkend
  // Millionen auszahlen. Auch nach einem Konto-Login (der neue Stats bringt) greift das.
  var questScanDone = false;

  // Fertige Quests: beim ersten Scan nach dem Laden NUR markieren (bf, kein Geld),
  // danach im Spiel frisch erreichte normal belohnen.
  function checkQuests() {
    var changed = false;
    var backfill = !questScanDone;
    questScanDone = true;
    QUESTS.forEach(function (q) {
      var rec = state.quests[q.id];
      if (rec && rec.done) return;
      if (!questDone(q)) return;
      if (backfill) {
        // Schon beim Laden erfüllt -> als abgeholt markieren, NICHT auszahlen und NICHT
        // zum Startguthaben zählen (bf).
        state.quests[q.id] = { done: true, claimed: true, bf: true };
        changed = true;
      } else {
        // Frisch im Spiel erreicht -> normal belohnen.
        rec = state.quests[q.id] = { done: true, claimed: true };
        if (App.Coins) App.Coins.add(q.reward.coins);
        state.xp += q.reward.xp;
        if (App.Tickets) rec.tickets = App.Tickets.grantForQuest(q.reward);
        changed = true;
        toastQuest(q);
      }
    });
    if (changed) {
      var before = level(); save();
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
        el('div', { class: 'quest-pop-r' }, [
          '+' + UI.formatShort(q.reward.coins) + ' 🪙 · +' + q.reward.xp + ' XP' +
          (App.Tickets ? (' · +' + App.Tickets.ticketsFor(q.reward) + ' 🎟️') : '')
        ])
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

  /** true, wenn die aktuelle Coin-Runde durch ein Verlust-Erstattungs-Power-Up
   *  risikofrei ist (Freispiel/Schild/Goldene Hand). Dann gibt es weder Wager-
   *  noch Gewinn-XP und die Runde zählt nicht für Quests — sonst wäre die
   *  garantierte Erstattung ein XP-Automat (Einsatz raus, Verlust zurück). */
  function riskFreeRound() {
    return !!(App.Powerups && App.Powerups.roundProtected && App.Powerups.roundProtected());
  }

  function onWager(amount) {
    amount = Math.round(Math.abs(amount));
    if (amount <= 0) return;
    state.stats.wagered += amount;
    state.stats.rounds += 1;
    addXp(Math.max(1, Math.round(amount / 70)));  // XP fürs Spielen — bewusst wenig (Leveln ist zäh)
    checkQuests();
  }
  function onOutcome(delta) {
    delta = Math.round(delta);
    if (delta > 0) {
      state.stats.wins += 1;
      state.stats.won += delta;
      // Sieg-Serie (Siege in Folge, reißt bei jedem Verlust) — Quelle für Serien-Quests.
      state.stats.streak = (state.stats.streak || 0) + 1;
      if (state.stats.streak > (state.stats.maxStreak || 0)) state.stats.maxStreak = state.stats.streak;
      // Siege je Spiel (für Meister-Quests) — curGame kommt aus dem Hash.
      if (curGame) state.stats.gameWins[curGame] = (state.stats.gameWins[curGame] || 0) + 1;
      if (delta > state.stats.biggestWin) state.stats.biggestWin = delta;
      addXp(Math.max(1, Math.round(delta / 50)));  // Bonus-XP fürs Gewinnen — ebenfalls reduziert
      if (delta >= 2000) confetti(Math.min(70, 20 + Math.round(delta / 600)));  // Konfetti nur bei größeren Gewinnen

    } else if (delta < 0) {
      state.stats.losses += 1;
      state.stats.streak = 0;   // Serie reißt
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
        if (delta < 0 && !riskFreeRound()) onWager(delta);
        if (App.Coins.get() > peakBalance) { peakBalance = App.Coins.get(); checkQuests(); }
        return r;
      };
      App.Coins.__progHooked = true;
      peakBalance = App.Coins.get();
    }
    // Rundenergebnis: UI.flash(delta) wird in Gambling-Spielen mit dem Netto-Gewinn/-Verlust aufgerufen
    if (App.UI && !App.UI.__progHooked) {
      var _flash = App.UI.flash;
      App.UI.flash = function (amount) { try { if (!riskFreeRound()) onOutcome(Number(amount) || 0); } catch (e) {} return _flash.apply(this, arguments); };
      App.UI.__progHooked = true;
    }
    // (Pokerchips abgeschafft — Video Poker läuft jetzt über App.Coins/UI.flash.)
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
  // Fortschritt 0..100 im aktuellen Level; bei Maxlevel (xpForLevel=0) volle 100 %.
  function levelPct() {
    var need = xpForLevel();
    if (need <= 0) return 100;
    return Math.max(0, Math.min(100, Math.round(xpInLevel() / need * 100)));
  }
  function updateChip() {
    if (!chip) return;
    chipLvl.textContent = isMaxLevel() ? 'MAX' : String(level());
    chip.classList.toggle('chip-max', isMaxLevel());
    chipFill.style.width = levelPct() + '%';
  }

  /* ---------------- Quest-/Level-Seite ---------------- */
  // Such-/Sortier-Zustand der Quest-Liste — modulweit, damit die Auswahl beim
  // Verlassen und Zurückkehren auf die Seite erhalten bleibt.
  var questQuery = '', questSort = 'default';
  function renderPage(root) {
    injectCss();
    var L = level();
    var maxed = isMaxLevel();
    var pct = levelPct();
    var head = el('div', { class: 'lvl-head glass' }, [
      el('div', { class: 'lvl-badge' }, ['⭐', el('span', { class: 'lvl-badge-n' }, [maxed ? 'MAX' : String(L)])]),
      el('div', { class: 'lvl-meta' }, [
        el('div', { class: 'lvl-title neon' + (maxed ? ' name-gold' : '') }, [title()]),
        el('div', { class: 'lvl-sub' }, [maxed ? ('Level ' + UI.formatCoins(L) + ' · HÖCHSTLEVEL erreicht 👑') : ('Level ' + L + ' · ' + xpInLevel() + ' / ' + xpForLevel() + ' XP')]),
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

    // Fortschritt 0..1 einer Quest (für Sortierung "Fast fertig").
    function questPct(q) { return Math.min(1, q.prog(s) / q.target); }
    function isDone(q) { return (state.quests[q.id] && state.quests[q.id].done) || q.prog(s) >= q.target; }

    // Eine einzelne Quest-Zeile bauen.
    function questRow(q) {
      var cur = Math.min(q.target, q.prog(s));
      var done = isDone(q);
      var p = Math.round(cur / q.target * 100);
      return el('div', { class: 'quest-row glass' + (done ? ' done' : '') }, [
        el('div', { class: 'quest-ic' }, [done ? '✅' : q.icon]),
        el('div', { class: 'quest-main' }, [
          el('div', { class: 'quest-t' }, [q.title]),
          el('div', { class: 'quest-d' }, [q.desc]),
          el('div', { class: 'quest-bar' }, [el('div', { class: 'quest-bar-fill', style: 'width:' + p + '%' })]),
          el('div', { class: 'quest-p' }, [UI.formatShort(cur) + ' / ' + UI.formatShort(q.target)])
        ]),
        el('div', { class: 'quest-rw' }, [
          el('div', { class: 'quest-rw-c' }, ['+' + UI.formatShort(q.reward.coins) + ' 🪙']),
          el('div', { class: 'quest-rw-x' }, ['+' + q.reward.xp + ' XP']),
          App.Tickets ? el('div', { class: 'quest-rw-x', style: 'color:#ffc740;' }, ['+' + App.Tickets.ticketsFor(q.reward) + ' 🎟️']) : null
        ].filter(Boolean))
      ]);
    }

    // Sortier-Varianten. `null` = Original-Reihenfolge (wie definiert). Bei
    // Gleichstand fällt jeder Vergleicher auf die Definition-Reihenfolge zurück.
    var idx = function (q) { return QUESTS.indexOf(q); };
    // Für A–Z: führende Emojis/Symbole abschneiden, damit z. B. "👑 Höchstlevel"
    // unter H statt ganz oben einsortiert wird.
    var azKey = function (q) { return q.title.replace(/^[^\p{L}\p{N}]+/u, '').trim() || q.title; };
    var SORTERS = {
      default:  null,
      progress: function (a, b) { return (questPct(b) - questPct(a)) || (idx(a) - idx(b)); },
      reward:   function (a, b) { return (b.reward.coins - a.reward.coins) || (idx(a) - idx(b)); },
      open:     function (a, b) { return (isDone(a) - isDone(b)) || (idx(a) - idx(b)); },
      done:     function (a, b) { return (isDone(b) - isDone(a)) || (idx(a) - idx(b)); },
      az:       function (a, b) { return azKey(a).localeCompare(azKey(b), 'de'); }
    };

    var list = el('div', { class: 'quest-list' });
    var count = el('span', { class: 'quest-count' });

    // Liste nach aktuellem Suchtext + Sortierung neu aufbauen.
    function rebuild() {
      var qy = questQuery.trim().toLowerCase();
      var rows = QUESTS.filter(function (q) {
        return !qy || (q.title + ' ' + q.desc).toLowerCase().indexOf(qy) >= 0;
      });
      var sorter = SORTERS[questSort];
      if (sorter) rows = rows.slice().sort(sorter);
      list.innerHTML = '';
      if (!rows.length) {
        list.appendChild(el('div', { class: 'quest-empty glass' }, ['Keine Quest gefunden 🔍']));
      } else {
        rows.forEach(function (q) { list.appendChild(questRow(q)); });
      }
      count.textContent = rows.length === QUESTS.length
        ? (QUESTS.length + ' Quests')
        : (rows.length + ' / ' + QUESTS.length);
    }

    var searchInput = el('input', {
      class: 'text-input quest-search', type: 'search', placeholder: '🔍 Quest suchen …', value: questQuery,
      oninput: function () { questQuery = this.value; rebuild(); }
    });
    var sortSelect = el('select', {
      class: 'text-input quest-sort',
      onchange: function () { questSort = this.value; rebuild(); }
    }, [
      el('option', { value: 'default'  }, ['Standard']),
      el('option', { value: 'progress' }, ['Fast fertig']),
      el('option', { value: 'reward'   }, ['Höchste Belohnung']),
      el('option', { value: 'open'     }, ['Offen zuerst']),
      el('option', { value: 'done'     }, ['Erledigt zuerst']),
      el('option', { value: 'az'       }, ['A – Z'])
    ]);
    sortSelect.value = questSort;

    rebuild();

    root.appendChild(el('div', { class: 'quests-page' }, [
      el('div', { class: 'page-head' }, [
        el('button', { class: 'btn btn-ghost back', type: 'button', onclick: function () { App.Router.go('/'); } }, ['← Menü']),
        el('h2', { class: 'page-title neon' }, ['⭐ Level & Quests'])
      ]),
      head, stats,
      el('div', { class: 'quest-h-row' }, [
        el('h3', { class: 'quest-h' }, ['Quests']),
        count
      ]),
      el('div', { class: 'quest-tools' }, [searchInput, sortSelect]),
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
      // Goldener Name für Höchstlevel-Spieler (Level 99999) — überall verwendbar
      // via Klasse `name-gold` (Bestenliste, Survival-Rangliste, Profil, Chat …).
      '.name-gold{background:linear-gradient(90deg,#fff6c0,#ffd23f,#ffb700,#fff6c0,#ffd23f);background-size:200% auto;-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;color:#ffd23f;font-weight:900;text-shadow:0 0 10px rgba(255,210,63,.5);animation:gj-goldshine 3s linear infinite;}',
      '.name-gold::after{content:"👑";-webkit-text-fill-color:initial;margin-left:4px;font-size:.82em;filter:drop-shadow(0 0 4px rgba(255,210,63,.8));}',
      '@keyframes gj-goldshine{to{background-position:200% center;}}',
      '@media(prefers-reduced-motion:reduce){.name-gold{animation:none;}}',
      '.level-chip{display:inline-flex;align-items:center;gap:5px;background:rgba(9,32,21,.7);border:1px solid var(--stroke);border-radius:999px;padding:5px 10px 5px 8px;cursor:pointer;color:var(--text);font-weight:800;font-size:13px;transition:.15s;}',
      '.level-chip:hover{border-color:var(--neon);box-shadow:0 0 0 1px rgba(57,255,20,.35);}',
      '.level-chip-star{filter:drop-shadow(0 0 5px rgba(255,210,63,.6));}',
      '.level-chip-lvl{color:var(--gold);font-variant-numeric:tabular-nums;}',
      '.level-chip.chip-max{border-color:var(--gold);box-shadow:0 0 0 1px rgba(255,210,63,.5),0 0 12px rgba(255,210,63,.35);}',
      '.level-chip.chip-max .level-chip-lvl{font-weight:900;}',
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
      '.quest-h{margin:0;color:var(--muted);text-transform:uppercase;letter-spacing:1px;font-size:13px;}',
      '.quest-h-row{display:flex;align-items:baseline;justify-content:space-between;gap:10px;margin:4px 0 -4px;}',
      '.quest-count{color:var(--gold);font-weight:800;font-size:12px;font-variant-numeric:tabular-nums;white-space:nowrap;}',
      '.quest-tools{display:flex;gap:10px;}',
      '.quest-search{flex:1;min-width:0;}',
      '.quest-sort{flex:0 0 auto;width:auto;cursor:pointer;}',
      '@media(max-width:480px){.quest-tools{flex-direction:column;}.quest-sort{width:100%;}}',
      '.quest-empty{padding:22px;text-align:center;color:var(--muted);font-weight:700;}',
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
    MAX_LEVEL: MAX_LEVEL,
    level: level, xpInLevel: xpInLevel, xpForLevel: xpForLevel, title: title,
    startBalance: startBalance, startBalanceIn: startBalanceIn, addXp: addXp,
    /** true, sobald der Spieler das Höchstlevel (99999) erreicht hat -> goldener Name. */
    isMaxLevel: isMaxLevel,
    /** Baut einen Namens-Span; ist gold=true (oder der Spieler selbst Maxlevel),
     *  bekommt er die global definierte Klasse `name-gold` (goldener, glänzender Name). */
    nameEl: function (name, gold) {
      var isGold = gold === undefined ? isMaxLevel() : !!gold;
      return el('span', { class: 'gj-name' + (isGold ? ' name-gold' : '') }, [String(name == null ? '' : name)]);
    },
    stats: function () { return statsView(); },
    setLevelTo: setLevelTo, subtractLevels: subtractLevels, applyLevelAdjust: applyLevelAdjust,
    /** Level bzw. Start-Guthaben aus einem fremden Fortschritts-Objekt (Admin-Panel). */
    levelForXp: function (xp) { return levelFromXp(Math.max(0, Math.round(Number(xp) || 0))); },
    startBalanceForProgress: function (prog) { return startBalanceOf(prog || { xp: 0 }); },
    /** Längste Sieg-Serie (aktiver Modus) bzw. für einen bestimmten Modus. */
    maxStreak: maxStreak, maxStreakIn: maxStreakIn, curStreak: curStreak,
    quests: function () { return QUESTS.slice(); },
    onChange: onChange, renderPage: renderPage,

    /** Fortschritt neu aus dem Storage laden — nach Konto-Login oder beim Wechsel
     *  zwischen Casino und Survival, die getrennte Stände haben (siehe js/mode.js). */
    reloadFromStorage: function () {
      // Neuer Stand (z.B. nach Konto-Login): der nächste Quest-Scan ist wieder ein
      // Backfill-Pass -> schon erfüllte Quests werden nur markiert, nicht ausgezahlt.
      questScanDone = false;
      state = load();
      peakBalance = App.Coins ? App.Coins.get() : 0;
      checkQuests();
      updateChip();
      emit();
    }
  };
  // Chip live aktualisieren
  onChange(updateChip);

  function boot() {
    injectCss();            // `.name-gold` global bereitstellen (auch ohne /quests-Besuch)
    hook();
    installChip();
    updateChip();
    checkQuests();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
