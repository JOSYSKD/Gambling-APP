/* wager.js — 1v1-Wetten (App.Wager).
 *
 * Ein Spieler fordert einen ANDEREN Online-Spieler heraus, beide setzen Coins,
 * der Gewinner bekommt den ganzen Pot. Herausforderer wählt Spiel, Rundenzahl und
 * Rundenzeit; welche Spiele überhaupt erlaubt sind, legt der Admin fest.
 *
 * Bausteine (alles schon vorhanden, siehe technische Recherche):
 *  · Gegner-Liste     App.Wallet.players()      (online, dedupliziert nach pid)
 *  · Geld             App.TournamentHost.payCasino(-/+)  (immer Casino-Silber, kein XP)
 *                     App.TournamentHost.mailCoins(pid, betrag, grund)  (offline-sicher)
 *  · Spiel-Anbindung  makeGameRoom() bildet die net.js-Raum-API über einem Store-
 *                     Zweig nach -> die bestehenden Minispiele laufen unverändert.
 *  · Sieger           App.Tournament.kindOf()   (duel -> shared.winner; score -> höchster score)
 *
 * Speicherorte (offene, bereits deployte scores-Unterknoten -> KEIN Firebase-Regel-
 * Deploy nötig; doppelter Unterstrich kollidiert mit keiner Spiel-Bestenliste):
 *  · scores/__wager_games          Liste der vom Admin erlaubten Spiel-IDs
 *  · scores/__wager_inv/<toPid>    eingehende Herausforderungen je Empfänger
 *  · scores/__wager_m/<matchId>    der laufende Kampf (inkl. /g = Spiel-Raum)
 * Der Pot läuft über das Turnier-Postfach tournament/pay/<pid> (mailCoins).
 */
(function () {
  'use strict';
  window.App = window.App || {};

  var GAMES_PATH = 'scores/__wager_games';
  var INV_ROOT = 'scores/__wager_inv';
  var MATCH_ROOT = 'scores/__wager_m';
  var KEY_STAKED = 'gj_wager_staked';   // matchIds, bei denen mein Einsatz schon abgebucht ist
  var KEY_SENT = 'gj_wager_sent';       // matchIds von mir verschickter Herausforderungen (Host-Outbox)

  function store() { return App.Net.store(); }
  function T() { return App.Tournament; }
  function TH() { return App.TournamentHost; }
  function myPid() { return T().myPid(); }
  function myName() { return (App.Leaderboard && App.Leaderboard.getPlayerName && App.Leaderboard.getPlayerName()) || 'Spieler'; }
  function newId() { return 'w' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

  /* ---------------- erlaubte Spiele (Admin) ---------------- */
  // Alle als 1v1 sinnvollen Multiplayer-Minispiele — Vorschlag für die Admin-Auswahl.
  function candidateGames() {
    var out = [];
    var MG = App.Minigames || {};
    Object.keys(MG).forEach(function (id) {
      var g = MG[id];
      if (!g || g.coop) return;                 // Koop passt nicht für 1v1
      if (g.multi === false) return;            // muss Mehrspieler können
      if ((g.maxPlayers || 2) < 2) return;
      out.push({ id: id, title: g.title || id, icon: g.icon || '🎮', kind: T().kindOf(id) });
    });
    out.sort(function (a, b) { return a.title.localeCompare(b.title); });
    return out;
  }
  function allowedGames() {
    return store().then(function (b) { return b.get(GAMES_PATH); }).then(function (o) {
      var arr = (o && o.list) || [];
      return arr.filter(function (id) { return App.Minigames && App.Minigames[id]; });
    }).catch(function () { return []; });
  }
  function setAllowedGames(ids) {
    return store().then(function (b) { return b.set(GAMES_PATH, { list: (ids || []).slice(0, 200) }); });
  }

  /* ---------------- Gegner ---------------- */
  function players() {
    return (App.Wallet && App.Wallet.players) ? App.Wallet.players() : Promise.resolve([]);
  }

  /* ---------------- Herausforderungen ---------------- */
  /** Herausforderung an einen Spieler schicken. Der Einsatz wird noch NICHT abgebucht
   *  (erst wenn beide im Kampf sind), damit eine abgelehnte Anfrage nichts kostet. */
  function invite(toPid, toName, gameId, rounds, seconds, stake) {
    stake = Math.max(10, Math.round(Number(stake) || 0));
    rounds = Math.max(1, Math.min(9, Math.round(Number(rounds) || 3)));
    seconds = Math.max(10, Math.min(300, Math.round(Number(seconds) || 45)));
    if (!App.Minigames || !App.Minigames[gameId]) return Promise.reject(new Error('Spiel unbekannt.'));
    if (TH().casinoBalance() < stake) return Promise.reject(new Error('Du hast nicht genug Coins für diesen Einsatz.'));
    var id = newId();
    var rec = {
      id: id, from: myPid(), fromName: myName(), to: toPid, toName: toName || 'Spieler',
      game: gameId, rounds: rounds, seconds: seconds, stake: stake, at: Date.now(), status: 'pending'
    };
    var patch = {}; patch[id] = rec;
    return store().then(function (b) { return b.update(INV_ROOT + '/' + toPid, patch); })
      .then(function () { rememberSent(id); return rec; });
  }
  /* Host-Outbox: matchIds (== Einladungs-ID) meiner offenen Herausforderungen,
   * damit der Herausforderer merkt, wenn der Gegner annimmt, und selbst in den
   * Kampf springt (er ist der Host und muss die Runden werten/auszahlen). */
  function rememberSent(matchId) {
    var a = App.Storage.get(KEY_SENT, []) || [];
    if (a.indexOf(matchId) < 0) a.push(matchId);
    if (a.length > 30) a = a.slice(-30);
    App.Storage.set(KEY_SENT, a);
  }
  function forgetSent(matchId) {
    var a = (App.Storage.get(KEY_SENT, []) || []).filter(function (x) { return x !== matchId; });
    App.Storage.set(KEY_SENT, a);
  }
  function sentMatchIds() { return App.Storage.get(KEY_SENT, []) || []; }
  /** Eingehende Herausforderungen an mich (noch offen). */
  function incoming() {
    return store().then(function (b) { return b.get(INV_ROOT + '/' + myPid()); }).then(function (o) {
      var arr = [];
      if (o) Object.keys(o).forEach(function (k) { var r = o[k]; if (r && r.status === 'pending' && (Date.now() - (r.at || 0)) < 600000) { r.id = k; arr.push(r); } });
      arr.sort(function (a, b2) { return (b2.at || 0) - (a.at || 0); });
      return arr;
    }).catch(function () { return []; });
  }
  function removeInvite(toPid, id) { return store().then(function (b) { return b.remove(INV_ROOT + '/' + toPid + '/' + id); }); }
  function decline(inv) { return removeInvite(myPid(), inv.id); }

  /** Herausforderung annehmen: Kampf-Datensatz anlegen, dann beide betreten den Kampf. */
  function accept(inv) {
    if (TH().casinoBalance() < inv.stake) return Promise.reject(new Error('Du hast nicht genug Coins für diesen Einsatz.'));
    var matchId = inv.id;   // Kampf-ID = Einladungs-ID (eindeutig)
    var now = Date.now();
    var match = {
      id: matchId, game: inv.game, rounds: inv.rounds, seconds: inv.seconds, stake: inv.stake,
      a: inv.from, aName: inv.fromName, b: myPid(), bName: myName(),
      host: inv.from,               // der Herausforderer wertet den Kampf
      phase: 'countdown', round: 0, winsA: 0, winsB: 0, roundStartAt: now + 5000,
      createdAt: now, done: false
    };
    return store().then(function (b) {
      return b.set(MATCH_ROOT + '/' + matchId, match)
        .then(function () { return removeInvite(myPid(), inv.id); })
        .then(function () { return match; });
    });
  }

  /** Einsatz genau einmal pro Kampf abbuchen (Guard über localStorage). */
  function stakeOnce(matchId, stake) {
    var seen = App.Storage.get(KEY_STAKED, []) || [];
    if (seen.indexOf(matchId) >= 0) return true;
    if (TH().casinoBalance() < stake) return false;
    TH().payCasino(-stake);
    seen.push(matchId); if (seen.length > 50) seen = seen.slice(-50);
    App.Storage.set(KEY_STAKED, seen);
    return true;
  }
  function alreadyStaked(matchId) { return (App.Storage.get(KEY_STAKED, []) || []).indexOf(matchId) >= 0; }

  function getMatch(matchId) { return store().then(function (b) { return b.get(MATCH_ROOT + '/' + matchId); }); }
  function watchMatch(matchId, cb) { return store().then(function (b) { return b.watch(MATCH_ROOT + '/' + matchId, cb); }); }
  function patchMatch(matchId, patch) { return store().then(function (b) { return b.update(MATCH_ROOT + '/' + matchId, patch); }); }

  /* ---------------- Spiel-Raum (net.js-API über dem Store nachgebaut) ---------------- */
  function makeGameRoom(path, hostId) {
    var id = myPid(), name = myName();
    var ls = {}, last = null, unsub = [], be = null;
    function fire(evt, data) { (ls[evt] || []).forEach(function (cb) { try { cb(data); } catch (e) {} }); }
    var R = {
      get id() { return id; }, get code() { return 'WETTE'; }, get name() { return name; },
      backend: function () { return 'store'; },
      isHost: function () { return hostId === id; },
      snapshot: function () { return last; },
      players: function () {
        var p = (last && last.players) || {};
        return Object.keys(p).map(function (k) { return Object.assign({ id: k }, p[k]); })
          .sort(function (a, b2) { return (a.joinedAt || 0) - (b2.joinedAt || 0); });
      },
      on: function (evt, cb) { (ls[evt] = ls[evt] || []).push(cb); return R; },
      off: function (evt, cb) { var a = ls[evt]; if (a) { var i = a.indexOf(cb); if (i >= 0) a.splice(i, 1); } },
      setName: function (n) { name = String(n || 'Spieler').slice(0, 16); },
      setReady: function (r) { return be ? be.update(path + '/players/' + id, { ready: !!r }) : Promise.resolve(); },
      reportScore: function (s) { return be ? be.update(path + '/players/' + id, { score: s }) : Promise.resolve(); },
      reportState: function (st) { return be ? be.update(path + '/players/' + id, { state: st }) : Promise.resolve(); },
      setShared: function (patch) { return be ? be.update(path + '/shared', patch) : Promise.resolve(); },
      setPhase: function (phase, extra) { var o = { phase: phase }; if (extra) o = Object.assign(o, extra); return be ? be.update(path, o) : Promise.resolve(); },
      now: function () { return Date.now(); },
      leave: function () { unsub.forEach(function (f) { try { f(); } catch (e) {} }); unsub = []; return Promise.resolve(); }
    };
    store().then(function (b) {
      be = b;
      unsub.push(b.watch(path, function (v) {
        last = v; fire('room', v);
        fire('players', (v && v.players) || {});
        fire('shared', (v && v.shared) || null);
        fire('phase', (v && v.phase) || 'play');
      }));
    });
    return R;
  }

  /** Mich in den Spiel-Raum EINER Runde eintragen und ctx.room zurückgeben.
   *  roundKey trennt die Runden, damit ein alter Punktestand nicht in die neue Runde leckt. */
  function roundRoom(matchId, round, hostId) {
    var path = MATCH_ROOT + '/' + matchId + '/g/r' + round;
    var mine = path + '/players/' + myPid();
    return store().then(function (b) {
      return b.get(mine).then(function (existing) {
        var now = Date.now();
        var patch = existing
          ? { name: myName(), lastSeen: now }
          : { name: myName(), joinedAt: now, lastSeen: now, score: 0, state: null, ready: false };
        return b.update(mine, patch);
      }).then(function () { return makeGameRoom(path, hostId); });
    });
  }

  /* ---------------- Runden-Wertung (Host) ---------------- */
  // Rundensieger genau wie tournament.js: duel -> shared.winner; sonst höchster score
  // (bzw. niedrigster bei lowerIsBetter). null = unentschieden/keiner.
  function roundWinner(matchId, round, gameId) {
    var path = MATCH_ROOT + '/' + matchId + '/g/r' + round;
    return store().then(function (b) { return b.get(path); }).then(function (g) {
      var kind = T().kindOf(gameId);
      if (kind === 'duel') {
        var w = (g && g.shared && (g.shared.winner || g.shared.seriesWinner)) || null;
        return w || null;
      }
      var pl = (g && g.players) || {};
      var ids = Object.keys(pl);
      if (!ids.length) return null;
      var lower = !!(App.Scores && App.Scores.meta && App.Scores.meta(gameId) && App.Scores.meta(gameId).lower);
      ids.sort(function (x, y) {
        var sx = Number(pl[x].score) || 0, sy = Number(pl[y].score) || 0;
        return lower ? (sx - sy) : (sy - sx);
      });
      var top = pl[ids[0]], second = ids[1] ? pl[ids[1]] : null;
      if (second && (Number(top.score) || 0) === (Number(second.score) || 0)) return null; // Gleichstand
      return ids[0];
    });
  }

  /** Kampf endgültig werten + Pot auszahlen (nur der Host, genau einmal). */
  function finish(match) {
    var pot = match.stake * 2;
    var winner = null;
    if (match.winsA > match.winsB) winner = match.a;
    else if (match.winsB > match.winsA) winner = match.b;
    var reason = '🏅 Wett-Sieg: ' + (App.Minigames[match.game] ? App.Minigames[match.game].title : match.game);
    var jobs = [];
    if (winner) {
      jobs.push(TH().mailCoins(winner, pot, reason));
    } else {
      // Unentschieden -> jeder bekommt seinen Einsatz zurück
      jobs.push(TH().mailCoins(match.a, match.stake, 'Wette unentschieden — Einsatz zurück'));
      jobs.push(TH().mailCoins(match.b, match.stake, 'Wette unentschieden — Einsatz zurück'));
    }
    return Promise.all(jobs).then(function () {
      return patchMatch(match.id, { phase: 'done', done: true, winner: winner || null });
    });
  }

  App.Wager = {
    myPid: myPid,
    candidateGames: candidateGames,
    allowedGames: allowedGames,
    setAllowedGames: setAllowedGames,
    players: players,
    invite: invite,
    incoming: incoming,
    decline: decline,
    accept: accept,
    getMatch: getMatch,
    watchMatch: watchMatch,
    patchMatch: patchMatch,
    stakeOnce: stakeOnce,
    alreadyStaked: alreadyStaked,
    sentMatchIds: sentMatchIds,
    forgetSent: forgetSent,
    roundRoom: roundRoom,
    roundWinner: roundWinner,
    finish: finish,
    MATCH_ROOT: MATCH_ROOT
  };
})();
