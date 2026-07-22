/* tournament.js — Turnier-Modus: Modell, Ablauf-Steuerung, Spiel-Anbindung.
 * (Oberfläche: js/tournament-ui.js · Admin-Konfiguration: js/tournament-admin.js)
 *
 * Ablauf: Der Admin konfiguriert im Admin Panel ein Turnier (welche Spiele in
 * welcher Reihenfolge, Rundendauer, Ticketpreis, Startzeit, Chat ja/nein,
 * Preis-Power-Up). Spieler stellen sich bis zur Startzeit in die Queue. Zur
 * Startzeit werden die Tickets abgebucht und die Runden laufen nacheinander
 * durch, mit 3 Sekunden Countdown dazwischen. Am Ende bekommt der Sieger sein
 * Power-Up (js/powerups.js) und landet in der Turniersieger-Liste des Admins.
 *
 * KEIN SERVER: Es gibt niemanden, der die Uhr laufen lässt, wenn niemand da
 * ist. Deshalb treibt immer genau EIN anwesender Spieler den Ablauf voran —
 * der "Host": der am längsten wartende Spieler, der noch einen Heartbeat
 * sendet. Diese Wahl ist rein rechnerisch (kein geschriebenes host-Feld, also
 * auch kein Wettlauf um dieses Feld); fällt der Host aus, übernimmt der
 * nächste automatisch. Alle anderen Clients lesen nur mit. Praktische Folge:
 * Ein Turnier startet erst, wenn zur Startzeit auch wirklich jemand da ist.
 *
 * Datenmodell (geteilter Speicher, App.Net.store() -> Firebase):
 *   tournament/config   = { id, title, startAt, rounds:[gameId], roundSec, roundSecs:[sec],
 *                           ticketCost, chat, prize:{type,seconds,amount},
 *                           status:'open'|'done' }
 *   tournament/live     = { phase, round, deadline, winner,
 *                           players:{ <pid>:{name,joinedAt,lastSeen,points} },
 *                           g:{ <roundKey>:{ shared, players } },   // Spielstand
 *                           chat:{ <id>:{name,text,ts} } }
 *   tournament/banned   = { <pid>:true }              // gilt für den Turniermodus,
 *   tournament/warn     = { <pid>:{text,ts,id} }      // nicht nur fürs laufende
 *   tournament/winners  = { <id>:{ name, tournament, prize, ts, done } }
 *
 * Bann und Verwarnung liegen bewusst NEBEN `live`: ein neues Turnier setzt den
 * live-Zweig komplett zurück — ein gesperrter Spieler wäre sonst beim nächsten
 * Turnier wieder dabei.
 *
 * Spieler-ID (pid): stabil über Sitzungen — Kontoschlüssel wenn eingeloggt,
 * sonst die Geräte-ID aus js/presence.js. Damit überleben Bann, Verwarnung und
 * Siegerliste einen Reload.
 */
(function () {
  'use strict';
  window.App = window.App || {};

  var ROOT = 'tournament';
  var HB_MS = 5000;          // eigener Heartbeat in der Queue
  var ONLINE_MS = 16000;     // ohne Heartbeat gilt man als weg (3 verpasste Schläge)
  var COUNTDOWN_MS = 3000;   // Josls Vorgabe: 3 Sekunden zwischen den Spielen
  var RESULT_MS = 7000;      // Zwischenstand nach jeder Runde
  var STALE_MS = 180000;     // so lange darf eine Phase überfällig sein, bevor
                             // ein verwaistes Turnier abgeräumt wird (siehe tick)
  var CHAT_MAX = 60;
  var PODIUM_PTS = [10, 7, 5, 3, 2];   // Punkte nach Platz, danach 1
  var TAIL_PTS = 1;

  /* ---------------- Spielarten ----------------
   * Welche der ~51 Spiele wie gewertet werden. Ergibt sich aus der Art, wie ein
   * Spiel überhaupt ein Ergebnis produziert — deshalb hier abgeleitet statt
   * gepflegt: neue Spiele fallen automatisch in die richtige Schublade.
   *
   *  'score'  Wettbewerb: alle spielen gleichzeitig, room.reportScore() zählt.
   *  'duel'   1-gegen-1: Spieler werden gepaart, jedes Paar spielt für sich.
   *  'live'   Poker/Casino-Tisch: alle an einem Tisch, gewertet wird der Sieg.
   *  'coop'   Team: alle zusammen, Erfolg zählt für alle gleich.
   *  'gamble' Solo-Gambling: gewertet wird der Coin-Gewinn im Zeitfenster.
   *
   * 'duel', 'live' und 'coop' melden keinen Punktestand, sondern tragen bei
   * einem Sieg in ihre Bestenliste ein (App.Scores.winCurrent) — dort hängt sich
   * die Rundenwertung ein (siehe js/tournament-ui.js).
   */
  var DUEL_IDS = { tictactoe: 1, connect4: 1, chess: 1, pong: 1 };

  function kindOf(gameId) {
    var mg = App.Minigames && App.Minigames[gameId];
    if (mg) {
      if (DUEL_IDS[gameId] || mg.maxPlayers === 2) return 'duel';
      if (mg.coop) return 'coop';
      if (mg.group === 'live') return 'live';
      return 'score';
    }
    if (App.Games && App.Games[gameId]) return 'gamble';
    return null;
  }
  /** true, wenn die Runde über Siege statt über Punkte gewertet wird. */
  function isWinBased(kind) { return kind === 'duel' || kind === 'live' || kind === 'coop'; }

  function gameDef(gameId) {
    return (App.Minigames && App.Minigames[gameId]) || (App.Games && App.Games[gameId]) || null;
  }

  /** Alle turnierfähigen Spiele, gruppiert — Vorlage für das Admin-Menü. */
  function catalog() {
    var out = { score: [], duel: [], live: [], coop: [], gamble: [] };
    Object.keys(App.Minigames || {}).forEach(function (id) {
      var k = kindOf(id);
      if (k && out[k]) out[k].push({ id: id, title: App.Minigames[id].title, icon: App.Minigames[id].icon || '🎮', kind: k });
    });
    Object.keys(App.Games || {}).forEach(function (id) {
      out.gamble.push({ id: id, title: App.Games[id].title, icon: App.Games[id].icon || '🎲', kind: 'gamble' });
    });
    Object.keys(out).forEach(function (k) {
      out[k].sort(function (a, b) { return a.title.localeCompare(b.title); });
    });
    return out;
  }

  /* Wertungsrichtung: bei manchen Spielen ist weniger besser (Reflex = ms). */
  function lowerIsBetter(gameId) {
    return !!(App.Scores && App.Scores.meta && App.Scores.meta(gameId).lower);
  }

  /* ---------------- Speicher ---------------- */
  var be = null;
  function store() {
    if (be) return Promise.resolve(be);
    return App.Net.store().then(function (b) { be = b; return b; });
  }

  /* ---------------- Identität ---------------- */
  function myPid() {
    if (App.Account && App.Account.isLoggedIn && App.Account.isLoggedIn() && App.Account.currentKey) {
      return 'a_' + App.Account.currentKey();
    }
    var dev = App.Storage.get('gj_device_id', null);
    if (!dev) {
      // presence.js legt die Geräte-ID normalerweise beim Start an; falls dieses
      // Modul früher dran ist, erzeugen wir sie unter demselben Schlüssel.
      dev = 'g' + Math.random().toString(36).slice(2, 12);
      App.Storage.set('gj_device_id', dev);
    }
    return 'g_' + dev;
  }
  function myName() {
    return (App.Leaderboard && App.Leaderboard.getPlayerName && App.Leaderboard.getPlayerName()) || 'Spieler';
  }
  function myAvatar() {
    try {
      if (App.ProfileCard && App.ProfileCard.get) {
        var c = App.ProfileCard.get();
        return (c && c.avatar) || '🐒';
      }
    } catch (e) {}
    return '🐒';
  }

  /* ---------------- Zustand ---------------- */
  var cfg = null, live = null, bans = null, warns = null;
  var listeners = { config: [], live: [], phase: [] };
  var lastPhase = null;
  var hbTimer = null, tickTimer = null;
  var watching = false;
  var paidFor = null;   // für welche Turnier-ID wurde mein Ticket schon gezogen

  function emit(evt, data) {
    (listeners[evt] || []).forEach(function (cb) { try { cb(data); } catch (e) {} });
  }

  function players() {
    var p = (live && live.players) || {};
    return Object.keys(p).map(function (id) {
      var v = p[id] || {};
      return { pid: id, name: v.name || 'Spieler', avatar: v.avatar || '🐒', joinedAt: v.joinedAt || 0, lastSeen: v.lastSeen || 0, points: v.points || 0 };
    }).sort(function (a, b) { return (a.joinedAt || 0) - (b.joinedAt || 0); });
  }
  function onlinePlayers() {
    var now = Date.now();
    return players().filter(function (p) { return (now - p.lastSeen) < ONLINE_MS; });
  }
  function isBanned(pid) { return !!(bans && bans[pid || myPid()]); }
  function bannedList() { return Object.keys(bans || {}); }
  function isAdminHere() { return !!(App.Admin && App.Admin.isAdmin && App.Admin.isAdmin()); }
  function amIn() { return !!(live && live.players && live.players[myPid()]); }

  /** Host = am längsten wartender, noch anwesender Spieler. Rein rechnerisch,
   *  damit alle Clients dieselbe Antwort geben ohne sich abzustimmen. */
  function hostPid() {
    var on = onlinePlayers();
    return on.length ? on[0].pid : null;
  }
  function isHost() { return hostPid() === myPid(); }

  function ranking() {
    return players().slice().sort(function (a, b) {
      return (b.points || 0) - (a.points || 0) || (a.joinedAt || 0) - (b.joinedAt || 0);
    });
  }

  /* ---------------- Beobachten ---------------- */
  function startWatch() {
    if (watching) return Promise.resolve();
    watching = true;
    return store().then(function (b) {
      b.watch(ROOT + '/config', function (v) {
        cfg = v || null;
        emit('config', cfg);
      });
      b.watch(ROOT + '/live', function (v) {
        live = v || null;
        emit('live', live);
        var ph = live ? live.phase : null;
        if (ph !== lastPhase) {
          var prev = lastPhase;
          lastPhase = ph;
          onPhaseChange(prev, ph);
          emit('phase', ph);
        }
      });
      b.watch(ROOT + '/banned', function (v) { bans = v || null; checkBan(); emit('live', live); });
      b.watch(ROOT + '/warn', function (v) { warns = v || null; checkWarning(); });
      if (!tickTimer) tickTimer = setInterval(tick, 700);
    });
  }

  /* Beim Übergang Queue -> Start wird das Ticket fällig (Josls Vorgabe: erst
   * wenn es wirklich losgeht). Jeder Client bucht sein eigenes ab; wer keins
   * mehr hat, fliegt aus der Queue. */
  function onPhaseChange(prev, next) {
    if (prev === 'queue' && next === 'countdown' && amIn() && cfg) {
      if (paidFor === cfg.id) return;
      var cost = Math.max(0, cfg.ticketCost || 0);
      if (cost > 0 && !App.Tickets.spend(cost)) {
        leave();
        if (App.UI) App.UI.toast('🎟️ Zu wenige Tickets — du bist raus.', 'lose');
        return;
      }
      paidFor = cfg.id;
      if (cost > 0 && App.UI) App.UI.toast('🎟️ ' + cost + ' Ticket' + (cost === 1 ? '' : 's') + ' eingelöst — viel Glück!', 'win');
    }
  }

  /* ---------------- Heartbeat ---------------- */
  function beat() {
    if (!amIn()) return;
    store().then(function (b) {
      b.update(ROOT + '/live/players/' + myPid(), { lastSeen: Date.now() });
    });
  }
  function startHeartbeat() {
    stopHeartbeat();
    beat();
    hbTimer = setInterval(beat, HB_MS);
  }
  function stopHeartbeat() { if (hbTimer) clearInterval(hbTimer); hbTimer = null; }

  /* ---------------- Queue ---------------- */
  function join() {
    if (!cfg || cfg.status !== 'open') return Promise.reject(new Error('Gerade läuft kein Turnier.'));
    if (isBanned()) return Promise.reject(new Error('Du bist für den Turniermodus gesperrt.'));
    if (live && live.phase && live.phase !== 'queue') return Promise.reject(new Error('Das Turnier läuft schon.'));
    var cost = Math.max(0, cfg.ticketCost || 0);
    if (!App.Tickets.has(cost)) {
      return Promise.reject(new Error('Du brauchst ' + App.Tickets.label(cost) + '. Du hast ' + App.Tickets.label() + '. Tickets gibt es für abgeschlossene Quests.'));
    }
    return store().then(function (b) {
      var now = Date.now();
      return b.update(ROOT + '/live/players/' + myPid(), {
        name: myName(), avatar: myAvatar(), joinedAt: now, lastSeen: now, points: 0
      }).then(function () { startHeartbeat(); });
    });
  }

  function leave() {
    stopHeartbeat();
    return store().then(function (b) { return b.remove(ROOT + '/live/players/' + myPid()); });
  }

  /* ---------------- Ablauf (nur der Host schreibt) ---------------- */
  function setLive(patch) {
    return store().then(function (b) { return b.update(ROOT + '/live', patch); });
  }

  function roundKeyFor(idx, pid) {
    if (!cfg) return 'r' + idx;
    var gameId = cfg.rounds[idx];
    if (kindOf(gameId) !== 'duel') return 'r' + idx;
    var pair = pairIndexOf(pid || myPid(), idx);
    return pair == null ? 'r' + idx : ('r' + idx + '_p' + pair);
  }

  /* Paarungen für Duell-Runden: die anwesenden Spieler werden der Reihe nach
   * gepaart. Bei ungerader Anzahl bekommt der Letzte ein Freilos (spielt nicht,
   * bekommt aber Punkte für den Platz). Alle Clients rechnen dasselbe Ergebnis
   * aus derselben sortierten Liste aus. */
  function pairsFor(idx) {
    var ps = startersOf().map(function (p) { return p.pid; });
    var out = [];
    for (var i = 0; i < ps.length; i += 2) out.push(ps.slice(i, i + 2));
    return out;
  }
  function pairIndexOf(pid, idx) {
    var prs = pairsFor(idx);
    for (var i = 0; i < prs.length; i++) if (prs[i].indexOf(pid) >= 0) return i;
    return null;
  }

  /* Teilnehmer der laufenden Runden = wer beim Start dabei war. Wir frieren das
   * nicht ein, sondern nehmen die aktuelle Spielerliste — wer geht, verliert
   * seine Punkte nicht, spielt aber nicht mehr mit. */
  function startersOf() { return players(); }

  /* Verwaistes Turnier aufräumen. WICHTIG: NICHT mitten im Turnier einen Sieger
   * küren — ein Gesamtsieger darf erst NACH der allerletzten Runde feststehen
   * (siehe finish(), gekürt wird der mit den meisten Punkten). Ein hängengebliebenes
   * Turnier wird daher nur dann per finish() beendet, wenn es ohnehin schon in der
   * Ergebnis-Phase der LETZTEN Runde steckt; sonst geht es zurück in den Wartebereich
   * (kein Zufalls-/Teilsieger). */
  function abandon() {
    var isLastRound = cfg && ((live.round || 0) + 1) >= cfg.rounds.length;
    if (players().length && live.phase === 'result' && isLastRound) return finish();
    return setLive({ phase: 'queue', round: 0, deadline: 0 });
  }

  function tick() {
    /* Zeitplan: Steht gerade kein Turnier im Slot, rückt das nächste fällige
     * nach (siehe js/tournament-host.js). Das muss VOR dem Guard unten stehen —
     * ohne laufendes Turnier gibt es keinen Taktgeber, der es holen könnte. */
    if (App.TournamentHost) App.TournamentHost.promoteIfDue(cfg);

    if (!cfg || !live || cfg.status !== 'open') return;
    var now = Date.now();
    var phase = live.phase || 'queue';

    /* Zur Startzeit ist niemand angetreten: Das Turnier würde sonst für immer
     * den einen Slot belegen und alle nachfolgenden blockieren. Nach einer
     * Karenzzeit verfällt es, der Host bekommt sein Geld zurück. Wie beim
     * Aufräumen unten darf das JEDER Beobachter — ohne Spieler gibt es keinen
     * Taktgeber, der es täte. */
    if (App.TournamentHost && phase === 'queue' && cfg.startAt &&
        now > cfg.startAt + App.TournamentHost.EXPIRE_MS && !onlinePlayers().length) {
      return App.TournamentHost.expire(cfg);
    }

    /* Verwaistes Turnier: die Phase ist längst abgelaufen und es ist NIEMAND
     * mehr da, der sie weitertreiben könnte (der letzte Spieler hat den Tab
     * zugemacht). Ohne Server bliebe die Runde sonst für immer stehen — mit
     * 0:00 auf der Uhr und ohne Weg heraus. Deshalb darf hier ausnahmsweise
     * JEDER Beobachter aufräumen, auch ein Zuschauer, der nicht mitspielt.
     * Die Wartezeit ist großzügig, damit ein kurz weggetabbter Spieler (dessen
     * Heartbeat der Browser drosselt) sein Turnier nicht verliert. */
    if (!hostPid() && phase !== 'queue' && phase !== 'done' && (now - (live.deadline || 0)) > STALE_MS) {
      return abandon();
    }

    // Wer die Uhr laufen lässt: normalerweise der Taktgeber (host). Ist gerade
    // KEIN Spieler da (z. B. nur der Admin schaut zu), darf der Admin die Runden
    // weitertreiben — sonst bliebe ein Turnier ohne anwesende Spieler stehen.
    // Solange ein Taktgeber existiert, treibt NUR er, damit die Wertung (endRound)
    // nicht doppelt läuft.
    if (!isHost() && !(isAdminHere() && !hostPid())) return;

    if (phase === 'queue') {
      if (cfg.startAt && now >= cfg.startAt && onlinePlayers().length > 0) beginCountdown(0);
      return;
    }
    if (phase === 'countdown') {
      if (now >= (live.deadline || 0)) beginRound(live.round || 0);
      return;
    }
    if (phase === 'round') {
      if (now >= (live.deadline || 0)) endRound(live.round || 0);
      return;
    }
    if (phase === 'result') {
      if (now >= (live.deadline || 0)) {
        var next = (live.round || 0) + 1;
        if (next >= cfg.rounds.length) finish();
        else beginCountdown(next);
      }
    }
  }

  function beginCountdown(idx) {
    return setLive({ phase: 'countdown', round: idx, deadline: Date.now() + COUNTDOWN_MS });
  }

  /* Rundendauer je Runde: der Admin kann pro Spiel eine eigene Zeit setzen
   * (cfg.roundSecs[idx]); fehlt sie, gilt die Standarddauer cfg.roundSec. */
  function roundSecFor(idx) {
    if (!cfg) return 60;
    var s = cfg.roundSecs && cfg.roundSecs[idx];
    return Math.max(5, Math.round(Number(s != null ? s : cfg.roundSec) || 60));
  }

  function beginRound(idx) {
    // Spielstand der Runde frisch anlegen, damit nichts aus der Vorrunde
    // durchblutet (shared-State und Punkte des Spiels).
    return store().then(function (b) {
      return b.remove(ROOT + '/live/g/r' + idx).catch(function () {});
    }).then(function () {
      return setLive({ phase: 'round', round: idx, deadline: Date.now() + roundSecFor(idx) * 1000 });
    });
  }

  /* Live-Spielstand aller Teilnehmer der laufenden Runde — für den
   * Zuschauermodus (siehe js/tournament-ui.js). Liest aus dem schon vorhandenen
   * live.g (kein Extra-Request): bei Duellen liegen die Spieler in Paar-Zweigen
   * (r<idx>_p0, r<idx>_p1 …), sonst alle in r<idx>. */
  function roundPlayers(idx) {
    var g = (live && live.g) || {};
    var prefix = 'r' + idx;
    var out = [];
    Object.keys(g).forEach(function (key) {
      if (key !== prefix && key.indexOf(prefix + '_p') !== 0) return;
      var pl = (g[key] && g[key].players) || {};
      Object.keys(pl).forEach(function (pid) {
        var v = pl[pid] || {};
        out.push({
          pid: pid, roundKey: key,
          name: v.name || 'Spieler', avatar: v.avatar || '🐒',
          score: v.score || 0, state: v.state || null,
          lastSeen: v.lastSeen || 0
        });
      });
    });
    return out;
  }

  /** Rundenergebnisse einsammeln, in Punkte umrechnen, Zwischenstand zeigen. */
  function endRound(idx) {
    var gameId = cfg.rounds[idx];
    var kind = kindOf(gameId);
    return store().then(function (b) {
      return b.get(ROOT + '/live/g').then(function (g) {
        g = g || {};
        var scores = {};   // pid -> Rundenergebnis

        if (kind === 'duel') {
          // Jedes Paar spielt in seinem eigenen Zweig; Sieger = wer gewonnen
          // gemeldet hat (score 1). Freilos zählt als Sieg.
          pairsFor(idx).forEach(function (pair, pi) {
            var node = g['r' + idx + '_p' + pi] || {};
            var pl = node.players || {};
            if (pair.length === 1) { scores[pair[0]] = 1; return; }
            pair.forEach(function (pid) { scores[pid] = (pl[pid] && pl[pid].score) || 0; });
          });
        } else {
          var node = g['r' + idx] || {};
          var pl = node.players || {};
          startersOf().forEach(function (p) {
            scores[p.pid] = (pl[p.pid] && pl[p.pid].score) || 0;
          });
        }

        var lower = lowerIsBetter(gameId);
        // Wer gar nicht gespielt hat (0 bzw. kein Eintrag), landet hinten —
        // bei "weniger ist besser" darf die 0 sonst gewinnen.
        var arr = Object.keys(scores).map(function (pid) {
          var s = scores[pid];
          return { pid: pid, score: s, played: typeof s === 'number' && (lower ? s > 0 : true) };
        });
        arr.sort(function (a, b) {
          if (a.played !== b.played) return a.played ? -1 : 1;
          return lower ? (a.score - b.score) : (b.score - a.score);
        });

        var patch = {}, place = 0, prevScore = null, prevPts = 0;
        arr.forEach(function (row, i) {
          var pts;
          // Gleichstand -> gleiche Punkte
          if (prevScore !== null && row.score === prevScore) pts = prevPts;
          else { place = i; pts = row.played ? (PODIUM_PTS[place] != null ? PODIUM_PTS[place] : TAIL_PTS) : 0; }
          prevScore = row.score; prevPts = pts;
          var cur = (live.players && live.players[row.pid] && live.players[row.pid].points) || 0;
          patch['players/' + row.pid + '/points'] = cur + pts;
        });
        patch['scores/' + idx] = scores;
        patch.phase = 'result';
        patch.deadline = Date.now() + RESULT_MS;
        return b.update(ROOT + '/live', patch);
      });
    });
  }

  function finish() {
    var rank = ranking();
    var top = rank[0];
    if (!top) return setLive({ phase: 'queue', round: 0 });

    var H = App.TournamentHost;
    var isMoney = cfg.prizeKind === 'money';
    // Preisgeld-Aufteilung (50/30/20, Rest zurück an den Host) — hier nur
    // berechnet, ausgezahlt wird über die Postfächer in settleMoney().
    var plan = (isMoney && H) ? H.payoutPlan(cfg, rank) : [];
    var payouts = {};
    plan.forEach(function (p) { if (p.place) payouts[p.pid] = { amount: p.amount, place: p.place }; });

    var winner = { pid: top.pid, name: top.name, avatar: top.avatar, points: top.points, prize: cfg.prize || null };
    if (isMoney) winner.money = (payouts[top.pid] && payouts[top.pid].amount) || 0;

    return store().then(function (b) {
      var wid = 'w' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      return b.set(ROOT + '/winners/' + wid, {
        name: top.name,
        pid: top.pid,
        tournament: cfg.title || 'Turnier',
        prize: H ? H.prizeLabel(cfg) : App.Powerups.describe(cfg.prize),
        points: top.points,
        ts: Date.now(),
        done: false
      }).then(function () {
        return b.update(ROOT + '/live', { phase: 'done', winner: winner, payouts: payouts, deadline: 0 });
      }).then(function () {
        // Turnier ist gelaufen — der Slot ist frei fürs nächste (Zeitplan).
        return b.update(ROOT + '/config', { status: 'done' });
      }).then(function () {
        return (isMoney && H) ? H.settleMoney(cfg, rank) : (H ? H.markDone(cfg) : null);
      });
    });
  }

  /** Preis einlösen — jeder Client prüft für sich, ob er gewonnen hat.
   *  Nur für Power-Up-Turniere: Preisgeld kommt übers Postfach, weil der Sieger
   *  beim Werten nicht online sein muss (siehe js/tournament-host.js).
   *
   *  Der „schon geholt"-Merker liegt DAUERHAFT im Storage (nicht nur im
   *  Speicher): Die done-Phase mit dem Sieger bleibt in Firebase stehen, bis das
   *  nächste Turnier nachrückt. Ohne persistenten Merker würde ein Reload den
   *  In-Memory-Guard zurücksetzen und die Siegerehrung vergäbe den Power-Up bei
   *  jedem erneuten Laden aufs Neue. */
  var PRIZE_TAKEN_KEY = 'gj_tour_prize_taken';
  function prizeAlreadyTaken(id) {
    var l = App.Storage.get(PRIZE_TAKEN_KEY, null);
    return Array.isArray(l) && l.indexOf(id) >= 0;
  }
  function markPrizeTaken(id) {
    var l = App.Storage.get(PRIZE_TAKEN_KEY, null);
    if (!Array.isArray(l)) l = [];
    if (l.indexOf(id) < 0) l.push(id);
    if (l.length > 40) l = l.slice(-40);
    App.Storage.set(PRIZE_TAKEN_KEY, l);
  }
  function claimPrizeIfWinner() {
    if (!live || live.phase !== 'done' || !live.winner || !cfg) return null;
    if (cfg.prizeKind === 'money') return null;
    if (live.winner.pid !== myPid()) return null;
    if (prizeAlreadyTaken(cfg.id)) return null;
    // Erst merken, wenn die Vergabe wirklich geklappt hat — sonst würde ein
    // Fehler beim ersten Versuch den Preis für immer verschlucken.
    var text = App.Powerups.grant(cfg.prize);
    markPrizeTaken(cfg.id);
    return text;
  }

  /* ---------------- Spiel-Anbindung ----------------
   * Bildet die Raum-Schnittstelle aus js/net.js nach (dieselben Methoden), aber
   * auf dem Turnier-Zweig. Dadurch laufen alle vorhandenen Multiplayer-Spiele
   * unverändert im Turnier — sie merken nicht, dass sie nicht in einem
   * normalen Raum stecken.
   */
  function makeGameRoom(path, memberIds, hostId) {
    var id = myPid(), name = myName();
    var ls = {}, last = null, unsub = [];

    function fire(evt, data) { (ls[evt] || []).forEach(function (cb) { try { cb(data); } catch (e) {} }); }

    var R = {
      get id() { return id; },
      get code() { return 'TURNIER'; },
      get name() { return name; },
      backend: function () { return be ? be.kind : 'firebase'; },
      isHost: function () { return hostId === id; },
      snapshot: function () { return last; },
      players: function () {
        var p = (last && last.players) || {};
        return Object.keys(p)
          .filter(function (k) { return !memberIds || memberIds.indexOf(k) >= 0; })
          .map(function (k) { return Object.assign({ id: k }, p[k]); })
          .sort(function (a, b) { return (a.joinedAt || 0) - (b.joinedAt || 0); });
      },
      on: function (evt, cb) { (ls[evt] = ls[evt] || []).push(cb); return R; },
      off: function (evt, cb) { var a = ls[evt]; if (a) { var i = a.indexOf(cb); if (i >= 0) a.splice(i, 1); } },
      setName: function (n) { name = String(n || 'Spieler').slice(0, 16); },
      setReady: function (r) { return be.update(path + '/players/' + id, { ready: !!r }); },
      reportScore: function (s) { return be.update(path + '/players/' + id, { score: s }); },
      reportState: function (st) { return be.update(path + '/players/' + id, { state: st }); },
      setShared: function (patch) { return be.update(path + '/shared', patch); },
      setPhase: function (phase, extra) {
        var o = { phase: phase };
        if (extra) o = Object.assign(o, extra);
        return be.update(path, o);
      },
      now: function () { return Date.now(); },
      leave: function () {
        unsub.forEach(function (f) { try { f(); } catch (e) {} });
        unsub = [];
        return Promise.resolve();
      }
    };

    unsub.push(be.watch(path, function (v) {
      last = v;
      fire('room', v);
      fire('players', (v && v.players) || {});
      fire('shared', (v && v.shared) || null);
      // Die Spiele erwarten hier ihre eigene Spielphase, nicht die des Turniers.
      fire('phase', (v && v.phase) || 'play');
    }));

    return R;
  }

  /** Raum für die laufende Runde — meldet mich selbst an und liefert ctx.room. */
  function roundRoom(idx) {
    var gameId = cfg.rounds[idx];
    var kind = kindOf(gameId);
    var key = roundKeyFor(idx, myPid());
    var path = ROOT + '/live/g/' + key;
    var members = null, hid = hostPid();

    if (kind === 'duel') {
      var pi = pairIndexOf(myPid(), idx);
      var pair = pi != null ? pairsFor(idx)[pi] : [myPid()];
      members = pair;
      hid = pair[0];   // im Duell führt der erste des Paares
    }

    return store().then(function (b) {
      var now = Date.now();
      var mine = path + '/players/' + myPid();
      // Nur beim ERSTEN Betreten der Runde anmelden. Ein zweiter Aufruf (die
      // Ansicht wird neu gebaut, ein Spiel holt sich den Raum erneut) darf einen
      // bereits gemeldeten Punktestand nicht wieder auf 0 setzen — sonst wäre
      // die ganze Runde für den Spieler futsch.
      return b.get(mine).then(function (existing) {
        var patch = existing
          ? { name: myName(), avatar: myAvatar(), lastSeen: now }
          : { name: myName(), avatar: myAvatar(), joinedAt: now, lastSeen: now, score: 0, state: null, ready: false };
        return b.update(mine, patch);
      }).then(function () {
        return { room: makeGameRoom(path, members, hid), kind: kind, members: members, gameId: gameId };
      });
    });
  }

  /* ---------------- Chat ---------------- */
  function chatSend(text) {
    text = String(text || '').trim().slice(0, 160);
    if (!text || !cfg || !cfg.chat) return Promise.resolve();
    if (isBanned()) return Promise.resolve();
    var mid = 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    return store().then(function (b) {
      return b.set(ROOT + '/live/chat/' + mid, { name: myName(), avatar: myAvatar(), text: text, ts: Date.now(), pid: myPid() });
    });
  }
  function chatList() {
    var c = (live && live.chat) || {};
    return Object.keys(c).map(function (k) { return Object.assign({ id: k }, c[k]); })
      .sort(function (a, b) { return (a.ts || 0) - (b.ts || 0); })
      .slice(-CHAT_MAX);
  }

  /* ---------------- Admin ---------------- */
  var Admin = {
    /** Turnier anlegen/überschreiben. Setzt die Queue zurück.
     *  Verdrängt das ein bezahltes Spieler-Turnier aus dem Slot, bekommt dessen
     *  Host sein Geld zurück — er hat für etwas gezahlt, das nun nicht läuft. */
    save: function (conf) {
      var id = 't' + Date.now().toString(36);
      var prev = cfg;
      var full = Object.assign({ id: id, status: 'open', createdAt: Date.now() }, conf);
      return store().then(function (b) {
        return b.set(ROOT + '/config', full)
          .then(function () { return b.set(ROOT + '/live', { phase: 'queue', round: 0, deadline: 0 }); })
          .then(function () {
            if (prev && prev.status === 'open' && App.TournamentHost) {
              return App.TournamentHost.refundCfg(prev, 'Turnier „' + (prev.title || '') + '" wurde vom Admin ersetzt');
            }
          });
      });
    },
    cancel: function () {
      var prev = cfg;
      return store().then(function (b) {
        return b.update(ROOT + '/config', { status: 'done' })
          .then(function () { return b.set(ROOT + '/live', { phase: 'queue', round: 0, deadline: 0 }); })
          .then(function () {
            if (prev && App.TournamentHost) {
              return App.TournamentHost.refundCfg(prev, 'Turnier „' + (prev.title || '') + '" wurde abgesagt');
            }
          });
      });
    },
    /** Sofort starten, ohne auf die Uhrzeit zu warten. */
    startNow: function () {
      return store().then(function (b) { return b.update(ROOT + '/config', { startAt: Date.now() }); });
    },
    /** Sofort weiter (Admin-Knopf im Zuschauermodus): setzt die Deadline der
     *  aktuellen Phase auf jetzt — der Taktgeber (oder der Admin selbst, wenn
     *  kein Spieler da ist) schaltet dann weiter. In der Queue = sofort starten.
     *  Läuft bewusst über die Deadline statt direkt zu schreiben, damit die
     *  Wertung genau einmal durch den Taktgeber passiert (kein Doppelzählen). */
    forceNext: function () {
      return store().then(function (b) {
        if (!live || !live.phase || live.phase === 'queue') {
          return b.update(ROOT + '/config', { startAt: Date.now() });
        }
        return b.update(ROOT + '/live', { deadline: Date.now() });
      });
    },
    ban: function (pid) {
      return store().then(function (b) {
        return b.set(ROOT + '/banned/' + pid, true)
          .then(function () { return b.remove(ROOT + '/live/players/' + pid); });
      });
    },
    unban: function (pid) {
      return store().then(function (b) { return b.remove(ROOT + '/banned/' + pid); });
    },
    warn: function (pid, text) {
      return store().then(function (b) {
        return b.set(ROOT + '/warn/' + pid, {
          id: 'w' + Date.now().toString(36), text: String(text || '').slice(0, 200), ts: Date.now()
        });
      });
    },
    winners: function () {
      return store().then(function (b) { return b.get(ROOT + '/winners'); }).then(function (w) {
        w = w || {};
        return Object.keys(w).map(function (k) { return Object.assign({ id: k }, w[k]); })
          .sort(function (a, b) { return (b.ts || 0) - (a.ts || 0); });
      });
    },
    setWinnerDone: function (id, done) {
      return store().then(function (b) { return b.update(ROOT + '/winners/' + id, { done: !!done }); });
    },
    removeWinner: function (id) {
      return store().then(function (b) { return b.remove(ROOT + '/winners/' + id); });
    }
  };

  /* Admin-Verwarnungen anzeigen (genau einmal, wie die Admin-Nachrichten in
   * js/presence.js). */
  var warnSeen = App.Storage.get('gj_tour_warn_seen', null);
  function checkWarning() {
    if (!warns) return;
    var w = warns[myPid()];
    if (!w || !w.id || w.id === warnSeen) return;
    warnSeen = w.id;
    App.Storage.set('gj_tour_warn_seen', w.id);
    if (!App.UI || !App.UI.el) return;
    var el = App.UI.el;
    var overlay = el('div', { class: 'modal-overlay' }, [
      el('div', { class: 'modal glass' }, [
        el('div', { class: 'modal-leaf' }, ['⚠️']),
        el('h2', { class: 'neon' }, ['Verwarnung vom Turnier-Admin']),
        el('p', {}, [w.text]),
        el('button', {
          class: 'btn btn-primary btn-lg', type: 'button',
          onclick: function () { if (overlay.parentNode) document.body.removeChild(overlay); }
        }, ['Verstanden'])
      ])
    ]);
    document.body.appendChild(overlay);
  }

  /* Wer während der Queue gebannt wird, fliegt sofort raus. */
  function checkBan() {
    if (!isBanned() || !amIn()) return;
    leave();
    if (App.UI) App.UI.toast('🚫 Du wurdest aus dem Turniermodus gesperrt.', 'lose');
    if (App.Router && (location.hash || '').indexOf('/tournament') >= 0) App.Router.go('/');
  }

  var Tournament = {
    ROOT: ROOT,
    COUNTDOWN_MS: COUNTDOWN_MS,
    PODIUM_PTS: PODIUM_PTS,

    start: startWatch,
    config: function () { return cfg; },
    live: function () { return live; },
    phase: function () { return live ? live.phase : null; },
    round: function () { return live ? (live.round || 0) : 0; },
    deadline: function () { return live ? (live.deadline || 0) : 0; },

    players: players,
    onlinePlayers: onlinePlayers,
    ranking: ranking,
    roundPlayers: roundPlayers,
    roundSecFor: roundSecFor,
    myPid: myPid,
    myName: myName,
    isHost: isHost,
    hostPid: hostPid,
    amIn: amIn,
    isAdminHere: isAdminHere,
    isBanned: isBanned,
    bannedList: bannedList,

    join: join,
    leave: leave,
    roundRoom: roundRoom,
    claimPrizeIfWinner: claimPrizeIfWinner,

    kindOf: kindOf,
    isWinBased: isWinBased,
    gameDef: gameDef,
    catalog: catalog,
    lowerIsBetter: lowerIsBetter,

    chatSend: chatSend,
    chatList: chatList,

    Admin: Admin,

    /** Läuft gerade ein Turnier, für das man sich anmelden kann? */
    isOpen: function () { return !!(cfg && cfg.status === 'open'); },
    /** Millisekunden bis zum Start (0 = jetzt). */
    untilStart: function () { return cfg && cfg.startAt ? Math.max(0, cfg.startAt - Date.now()) : 0; },

    on: function (evt, cb) {
      (listeners[evt] = listeners[evt] || []).push(cb);
      return function () { var a = listeners[evt], i = a.indexOf(cb); if (i >= 0) a.splice(i, 1); };
    }
  };

  Tournament.on('live', function () { checkWarning(); checkBan(); });

  App.Tournament = Tournament;

  function boot() { startWatch(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
