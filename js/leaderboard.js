/* leaderboard.js — Bestenliste: EIN Eintrag pro Spieler, und zwar für JEDEN.
 *
 * Früher wurde ein Eintrag NUR bei Game Over geschrieben (recordRun). Wer gut
 * spielte und nie pleite ging, stand deshalb nie auf der Liste — und wer oft
 * pleite ging, belegte mit mehreren Runs gleichzeitig die Top-Plätze und
 * verdrängte damit andere aus den Top 10. Genau deshalb war "nicht jeder drauf".
 *
 * Jetzt kommt die Liste zusätzlich aus dem Präsenz-Register (js/presence.js):
 * dort meldet sich JEDER Tab alle 8 Sekunden mit Name + Casino-Peak, auch Gäste
 * ohne Konto. getBoard() mischt drei Quellen:
 *   1. Präsenz-Register -> jeder, der die Seite offen hat/hatte (auch nie pleite)
 *   2. Run-Historie     -> alte Rekorde, auch von gerade offline-Spielern
 *   3. eigener Live-Run -> sofort sichtbar, ohne auf die Cloud zu warten
 * Pro Spieler zählt der höchste Peak — ein Spieler ist genau eine Zeile.
 *
 * Modular gehalten: die gesamte Persistenz läuft über den internen `driver`
 * (load/save/push/players). Standard ist localStorage; account.js setzt per
 * useDriver() das geteilte Backend (Firebase bzw. Cloud) ein.
 */
(function () {
  'use strict';
  window.App = window.App || {};

  var KEY_ENTRIES = 'gj_leaderboard';
  var KEY_NAME = 'gj_player_name';
  var ONLINE_MS = 45000;   // so lange gilt ein Register-Eintrag als "online"

  // --- Standard-Driver: localStorage ------------------------------------
  var localDriver = {
    load: function () {
      return App.Storage.get(KEY_ENTRIES, []);
    },
    save: function (entries) {
      App.Storage.set(KEY_ENTRIES, entries);
    }
  };

  var driver = localDriver;
  var listeners = [];

  function emit() {
    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i](); } catch (e) {}
    }
  }

  function cleanName(n) {
    return String(n == null ? '' : n).replace(/\s+/g, ' ').trim().slice(0, 18) || 'Anonym';
  }
  /** Schlüssel zum Zusammenführen: "JungleKing", "jungleking " und "Jungle  King"
   *  sind derselbe Spieler und dürfen nicht als zwei Zeilen erscheinen. */
  function nameKey(n) {
    return cleanName(n).toLowerCase();
  }

  var Leaderboard = {
    /** Anderen Persistenz-Driver einsetzen (z. B. Firebase). */
    useDriver: function (d) {
      driver = d;
      emit();
    },

    /** Für asynchrone Driver (z. B. Firebase): Listener neu benachrichtigen, wenn sich der Cache ändert. */
    refresh: function () {
      emit();
    },

    onChange: function (cb) {
      listeners.push(cb);
      return function () {
        var i = listeners.indexOf(cb);
        if (i >= 0) listeners.splice(i, 1);
      };
    },

    getPlayerName: function () {
      return App.Storage.get(KEY_NAME, '');
    },
    setPlayerName: function (name) {
      App.Storage.set(KEY_NAME, String(name || '').slice(0, 18).trim());
      emit();
    },

    /** Alle gespeicherten (abgeschlossenen) Runs, sortiert absteigend. */
    getEntries: function () {
      var list = (driver.load() || []).slice();
      list.sort(function (a, b) { return b.peak - a.peak; });
      return list;
    },

    /** Alle bekannten Spieler aus dem Register des Drivers (siehe js/presence.js). */
    getPlayers: function () {
      return (driver.players && driver.players()) || [];
    },

    /**
     * Anzeige-Liste: ein Eintrag pro Spieler, absteigend nach bestem Peak.
     * Quellen: Spieler-Register + Run-Historie + eigener laufender Run.
     * `limit` deckelt nur die Anzeige (Standard großzügig — es sollen alle drauf).
     */
    getBoard: function (activePeak, limit) {
      limit = limit || 200;
      var now = Date.now();
      var map = {}, keys = [];

      function put(name, peak, opts) {
        peak = Math.round(Number(peak) || 0);
        if (!isFinite(peak)) return;
        opts = opts || {};
        var k = nameKey(name);
        var e = map[k];
        if (!e) {
          e = map[k] = { name: cleanName(name), peak: peak, date: opts.date || null, online: false, active: false, me: false, gold: false,
            cos: null, level: 1, bulbs: 0, games: [], stats: null };
          keys.push(k);
        } else if (peak > e.peak) {
          e.peak = peak;
          if (opts.date) e.date = opts.date;
        } else if (opts.date && !e.date) {
          e.date = opts.date;
        }
        if (opts.online) e.online = true;
        if (opts.active) e.active = true;
        if (opts.me) e.me = true;
        if (opts.gold) e.gold = true;   // Höchstlevel-Spieler -> goldener Name
        // Profil-Daten (Kosmetik/Level/Glühbirnen/Spiele) übernehmen, sobald vorhanden.
        if (opts.cos) e.cos = opts.cos;
        if (opts.level) e.level = opts.level;
        if (opts.bulbs != null) e.bulbs = opts.bulbs;
        if (opts.games && opts.games.length) e.games = opts.games;
        if (opts.stats) e.stats = opts.stats;
      }

      var meMax = !!(App.Progress && App.Progress.isMaxLevel && App.Progress.isMaxLevel());

      // 1) Register: jeder Spieler, der die Seite offen hat/hatte — auch ohne Game Over.
      this.getPlayers().forEach(function (p) {
        if (!p || !p.name) return;
        var best = Math.max(Number(p.peak) || 0, Number(p.balance) || 0);
        put(p.name, best, {
          date: p.date || null,
          online: !!p.updatedAt && (now - p.updatedAt) < ONLINE_MS,
          gold: !!p.maxLevel,
          cos: p.cos || null, level: p.level || 1, bulbs: p.bulbs || 0,
          games: p.games || [], stats: p.stats || null
        });
      });

      // 2) Run-Historie (auch von Spielern, die gerade offline sind).
      this.getEntries().forEach(function (e) {
        if (!e) return;
        put(e.name, e.peak, { date: e.date, gold: !!e.gold });
      });

      // 3) Eigener laufender Run — sofort sichtbar, auch wenn die Cloud hakt.
      if (typeof activePeak === 'number') {
        put(this.getPlayerName() || 'Du', activePeak, { active: true, online: true, me: true, gold: meMax });
      }

      var list = keys.map(function (k) { return map[k]; });
      list.sort(function (a, b) { return (b.peak - a.peak) || a.name.localeCompare(b.name); });
      return list.slice(0, limit);
    },

    /**
     * Streak-Bestenliste: längste Sieg-Serie (Siege in Folge über ALLE Gambling-
     * Spiele) pro Spieler, absteigend. Quelle = Präsenz-Register (js/presence.js
     * meldet `streak` = Casino-maxStreak) + eigene Live-Serie. Ein Eintrag pro
     * Spieler; wer noch keine Serie hat (0), erscheint nicht.
     */
    getStreakBoard: function (activeStreak, limit) {
      limit = limit || 200;
      var now = Date.now();
      var map = {}, keys = [];

      function put(name, streak, opts) {
        streak = Math.round(Number(streak) || 0);
        if (!isFinite(streak) || streak <= 0) return;
        opts = opts || {};
        var k = nameKey(name);
        var e = map[k];
        if (!e) {
          e = map[k] = { name: cleanName(name), streak: streak, online: false, me: false, gold: false };
          keys.push(k);
        } else if (streak > e.streak) {
          e.streak = streak;
        }
        if (opts.online) e.online = true;
        if (opts.me) e.me = true;
        if (opts.gold) e.gold = true;
      }

      var meMax = !!(App.Progress && App.Progress.isMaxLevel && App.Progress.isMaxLevel());

      // 1) Register: jeder Spieler, der die Seite offen hat/hatte.
      this.getPlayers().forEach(function (p) {
        if (!p || !p.name) return;
        put(p.name, p.streak, {
          online: !!p.updatedAt && (now - p.updatedAt) < ONLINE_MS,
          gold: !!p.maxLevel
        });
      });

      // 2) Eigene Live-Serie — sofort sichtbar, ohne auf die Cloud zu warten.
      if (typeof activeStreak === 'number') {
        put(this.getPlayerName() || 'Du', activeStreak, { online: true, me: true, gold: meMax });
      }

      var list = keys.map(function (k) { return map[k]; });
      list.sort(function (a, b) { return (b.streak - a.streak) || a.name.localeCompare(b.name); });
      return list.slice(0, limit);
    },

    /** Einen abgeschlossenen Run eintragen (bei Game Over). */
    recordRun: function (name, peak, dateStr) {
      var entry = {
        name: cleanName(name),
        peak: Math.round(peak),
        date: dateStr,
        active: false,
        gold: !!(App.Progress && App.Progress.isMaxLevel && App.Progress.isMaxLevel())
      };
      // Driver mit additivem push() (z. B. Firebase) vermeiden ein Read-Modify-Write
      // über die komplette Liste, damit gleichzeitige Runs anderer Spieler nicht
      // überschrieben werden.
      if (driver.push) {
        driver.push(entry);
      } else {
        var list = driver.load() || [];
        list.push(entry);
        list.sort(function (a, b) { return b.peak - a.peak; });
        // Wir bewahren mehr als 10 auf, damit alte Rekorde nicht verloren gehen,
        // aber deckeln großzügig, um localStorage nicht vollzumüllen.
        if (list.length > 100) list = list.slice(0, 100);
        driver.save(list);
      }
      emit();
    }
  };

  App.Leaderboard = Leaderboard;
})();
