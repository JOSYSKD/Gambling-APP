/* tournament-host.js — Spieler hosten eigene Turniere (Zeitplan + Preisgeld).
 * Modell/Ablauf: js/tournament.js · Spieler-Oberfläche: js/tournament-ui.js
 * Admin-Konfiguration: js/tournament-admin.js
 *
 * WARUM EIN ZEITPLAN: js/tournament.js kennt genau EINEN Turnier-Slot
 * (tournament/config + tournament/live) — daran hängt der gesamte Ablauf inkl.
 * aller ~65 Spiele. Statt das auf beliebig viele parallele Turniere umzubauen,
 * liegt hier ein Zeitplan DAVOR: Wer ein Turnier hostet, legt einen Eintrag in
 * tournament/schedule an. PRE_OPEN_MS vor seiner Startzeit rückt der Eintrag in
 * den einen Slot (promoteIfDue) und läuft dort als ganz normales Turnier. Der
 * Ablauf selbst musste dafür nicht angefasst werden.
 *
 * Deshalb müssen zwei Turniere MIN_GAP_MS auseinander liegen: es kann immer nur
 * eins gleichzeitig laufen. Zusätzlich darf ein Spieler nur alle
 * HOST_COOLDOWN_MS eins anlegen (Admin ausgenommen).
 *
 * GELD: Der Host zahlt beim Anlegen eine Gebühr (mindestens settings.minFee,
 * vom Admin einstellbar). Daraus wird der Preisgeld-Topf: 50 % / 30 % / 20 % an
 * Platz 1 / 2 / 3. Anteile, für die es keinen Spieler gibt, gehen an den Host
 * zurück. Der Admin darf gratis hosten und den Topf trotzdem frei setzen (das
 * Geld entsteht dann aus dem Nichts — es ist sein Casino).
 *
 * AUSZAHLUNG ÜBER EIN POSTFACH (tournament/pay/<pid>/<payId>): Wer gewinnt, ist
 * nicht unbedingt online, wenn gewertet wird — und Rückerstattungen (verfallenes
 * oder abgesagtes Turnier) treffen den Host meist gar nicht live. Deshalb legt
 * der Taktgeber nur einen Zahlungs-Eintrag ab; jeder Client holt beim nächsten
 * Besuch sein eigenes Geld ab und löscht den Eintrag. Die payId ist bewusst aus
 * (Turnier, Anlass) abgeleitet statt zufällig: schreiben mehrere Beobachter
 * gleichzeitig (z. B. beim Verfall), landet zweimal derselbe Eintrag statt zwei
 * Auszahlungen. Ein Seen-Guard im Storage fängt den Rest ab.
 *
 * Gezahlt wird IMMER in Silber (Casino-Stand) — Survival-Gold darf den Modus
 * niemals verlassen (siehe js/mode.js).
 */
(function () {
  'use strict';
  window.App = window.App || {};

  var ROOT = 'tournament';

  var MIN_GAP_MS = 10 * 60 * 1000;      // Abstand zwischen zwei Startzeiten
  var HOST_COOLDOWN_MS = 60 * 60 * 1000; // Wartezeit pro Spieler (nicht für Admins)
  var PRE_OPEN_MS = 5 * 60 * 1000;      // so früh öffnet der Wartebereich
  var MIN_LEAD_MS = 5 * 60 * 1000;      // so weit muss die Startzeit weg sein
  var EXPIRE_MS = 10 * 60 * 1000;       // ohne Teilnehmer verfällt das Turnier
  var KEEP_MS = 3 * 60 * 60 * 1000;     // alte Zeitplan-Einträge aufräumen
  var DEFAULT_MIN_FEE = 750e9;          // 750B — vom Admin änderbar
  var SHARES = [0.5, 0.3, 0.2];         // Platz 1 / 2 / 3
  var MAX_ROUNDS = 12;

  var PAY_SEEN_KEY = 'gj_tour_pay_seen';

  /* ---------------- Speicher ---------------- */
  var be = null;
  function store() {
    if (be) return Promise.resolve(be);
    return App.Net.store().then(function (b) { be = b; return b; });
  }

  var settings = null, schedule = null, hosts = null;
  var watching = false;

  function isAdmin() { return !!(App.Admin && App.Admin.isAdmin && App.Admin.isAdmin()); }
  function myPid() { return App.Tournament.myPid(); }

  function minFee() {
    // Achtung: isFinite(null) ist true — ohne den expliziten settings-Test käme
    // hier null heraus und der Mindesteinsatz würde nirgends greifen.
    var v = settings ? Number(settings.minFee) : NaN;
    return (isFinite(v) && v >= 0) ? v : DEFAULT_MIN_FEE;
  }

  /* ---------------- Zeitplan ---------------- */
  function list() {
    var s = schedule || {};
    return Object.keys(s).map(function (k) { return Object.assign({ id: k }, s[k]); })
      .sort(function (a, b) { return (a.startAt || 0) - (b.startAt || 0); });
  }
  /** Was noch kommt: geplant oder gerade im Slot. */
  function upcoming() {
    var now = Date.now();
    return list().filter(function (t) {
      if (t.status === 'done') return false;
      return (t.startAt || 0) > now - EXPIRE_MS;
    });
  }
  function mine() {
    var me = myPid();
    return upcoming().filter(function (t) { return t.hostPid === me; });
  }

  /* Belegte Startzeiten: alles, was noch kommt, plus das Turnier im Slot (der
   * Admin setzt seine Turniere direkt dort an, ohne Zeitplan-Eintrag). */
  function takenSlots() {
    var out = upcoming().map(function (t) { return { at: t.startAt || 0, title: t.title, id: t.id }; });
    var cfg = App.Tournament.config();
    if (cfg && cfg.status === 'open' && cfg.startAt) {
      var known = out.some(function (o) { return o.id === cfg.scheduleId; });
      if (!known) out.push({ at: cfg.startAt, title: cfg.title, id: null });
    }
    return out;
  }
  /** Kollidierender Eintrag oder null. */
  function slotConflict(startAt, ignoreId) {
    var hit = null;
    takenSlots().forEach(function (o) {
      if (hit || (ignoreId && o.id === ignoreId)) return;
      if (Math.abs((o.at || 0) - startAt) < MIN_GAP_MS) hit = o;
    });
    return hit;
  }

  /** Wann darf ich frühestens wieder hosten? (0 = jetzt)
   *  Die Zeit kommt aus tournament/hosts/<pid> und NICHT aus dem Zeitplan: ein
   *  abgesagter Eintrag verschwindet, sonst wäre der Cooldown mit „anlegen →
   *  absagen → neu anlegen" umgangen. Der Zeitplan zählt trotzdem mit, falls der
   *  hosts-Eintrag mal fehlt. */
  function cooldownUntil() {
    if (isAdmin()) return 0;
    var me = myPid();
    var last = Number((hosts && hosts[me] && hosts[me].lastAt) || 0) || 0;
    list().forEach(function (t) {
      if (t.hostPid === me && (t.createdAt || 0) > last) last = t.createdAt || 0;
    });
    return last ? last + HOST_COOLDOWN_MS : 0;
  }
  function cooldownLeft() { return Math.max(0, cooldownUntil() - Date.now()); }

  /* ---------------- Geld ---------------- */
  /** Guthaben im Casino-Stand — im Survival zeigt App.Coins das Gold. */
  function casinoBalance() {
    if (!App.Mode || App.Mode.is('casino')) return App.Coins.get();
    return Number(App.Mode.readIn('casino', 'gj_balance', 0)) || 0;
  }
  /** Silber gutschreiben/abbuchen, egal welcher Modus gerade aktiv ist. */
  function payCasino(amount) {
    amount = Math.round(Number(amount) || 0);
    if (!amount) return;
    if (!App.Mode || App.Mode.is('casino')) { App.Coins.addRaw(amount); return; }
    var bal = Math.max(0, (Number(App.Mode.readIn('casino', 'gj_balance', 0)) || 0) + amount);
    App.Mode.writeIn('casino', 'gj_balance', bal);
    // Peak nachziehen, sonst fehlt der Gewinn in der Bestenliste.
    var peak = Number(App.Mode.readIn('casino', 'gj_run_peak', 0)) || 0;
    if (bal > peak) App.Mode.writeIn('casino', 'gj_run_peak', bal);
  }

  /** Wer bekommt wie viel? -> [{pid, name, place, amount}] (auch der Host-Rest). */
  function payoutPlan(cfg, ranking) {
    var pot = Math.max(0, Math.round(Number(cfg && cfg.pot) || 0));
    if (!pot) return [];
    var out = [], rest = pot;
    SHARES.forEach(function (share, i) {
      var amount = Math.floor(pot * share);
      var p = ranking[i];
      if (!p) return;                       // Platz unbesetzt -> Anteil bleibt im Rest
      out.push({ pid: p.pid, name: p.name, place: i + 1, amount: amount });
      rest -= amount;
    });
    // Nicht vergebene Anteile (zu wenige Spieler) + Rundungsrest zurück an den
    // Host — aber nur, wenn er den Topf auch bezahlt hat (Admin-Gratis-Turniere
    // erzeugen ihr Preisgeld aus dem Nichts, da gibt es nichts zurückzugeben).
    if (rest > 0 && cfg.hostPid && Math.round(Number(cfg.fee) || 0) > 0) {
      out.push({ pid: cfg.hostPid, name: cfg.hostName || 'Host', place: 0, amount: rest });
    }
    return out;
  }

  function payKey(tid, tag) { return String(tid || 't') + '_' + tag; }

  /** Zahlung ins Postfach legen (idempotent über payId). */
  function queuePay(pid, tid, tag, amount, reason) {
    amount = Math.round(Number(amount) || 0);
    if (!pid || amount <= 0) return Promise.resolve();
    var id = payKey(tid, tag);
    return store().then(function (b) {
      return b.set(ROOT + '/pay/' + pid + '/' + id, {
        amount: amount, reason: String(reason || ''), tid: tid || '', ts: Date.now()
      });
    }).catch(function () {});
  }

  /** Coins an das Postfach eines beliebigen Spielers schicken (Spieler-zu-Spieler-
   *  Überweisung, siehe js/wallet.js). Anders als queuePay wird die payId frisch
   *  erzeugt (jede Überweisung ist eigenständig) und Fehler werden NICHT
   *  verschluckt — der Aufrufer muss bei einem Schreibfehler die Abbuchung
   *  zurücknehmen. Das Postfach leert der Empfänger über collectPay (addRaw,
   *  also KEIN XP), egal ob er gerade online ist. */
  function mailCoins(toPid, amount, reason) {
    amount = Math.round(Number(amount) || 0);
    if (!toPid || amount <= 0) return Promise.reject(new Error('Ungültige Überweisung.'));
    var id = 'tr' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    return store().then(function (b) {
      return b.set(ROOT + '/pay/' + toPid + '/' + id, {
        amount: amount, reason: String(reason || ''), tid: '', ts: Date.now()
      });
    });
  }

  /* Eigenes Postfach leeren: gutschreiben, was noch nicht gesehen wurde, und den
   * Eintrag in jedem Fall entfernen (auch wenn schon kassiert — sonst bliebe er
   * für immer liegen). */
  var paySeen = null;
  function seenList() {
    if (paySeen) return paySeen;
    var v = App.Storage.get(PAY_SEEN_KEY, null);
    paySeen = Array.isArray(v) ? v : [];
    return paySeen;
  }
  function markSeen(id) {
    var l = seenList();
    l.push(id);
    if (l.length > 60) l = l.slice(-60);
    paySeen = l;
    App.Storage.set(PAY_SEEN_KEY, l);
  }

  function collectPay(entries) {
    if (!entries) return;
    var total = 0, reasons = [];
    Object.keys(entries).forEach(function (id) {
      var e = entries[id] || {};
      if (seenList().indexOf(id) < 0) {
        markSeen(id);
        var amt = Math.round(Number(e.amount) || 0);
        if (amt > 0) {
          payCasino(amt);
          total += amt;
          if (e.reason) reasons.push(e.reason);
        }
      }
      // Immer aufräumen — auch schon Kassiertes, sonst bliebe es ewig liegen.
      store().then(function (b) { b.remove(ROOT + '/pay/' + myPid() + '/' + id); }).catch(function () {});
    });
    if (total > 0 && App.UI) {
      // Den Grund nur nennen, wenn es genau einer ist: bei mehreren Zahlungen
      // (z. B. Platz 1 + nicht vergebene Anteile) gehörte er nur zu einem Teil
      // des Betrags und wäre schlicht falsch.
      var why = reasons.length === 1 ? (' — ' + reasons[0]) : '';
      App.UI.toast('💰 ' + App.UI.formatShort(total) + ' Coins gutgeschrieben' + why, 'win');
      if (App.Audio && App.Audio.jackpot) { try { App.Audio.jackpot(); } catch (e) {} }
    }
  }

  /* ---------------- Beobachten ---------------- */
  /* Alles einmal aktiv nachlesen. Sicherheitsnetz neben den watch()-Abos: Ein
   * Abo kann etwas verpassen (Verbindungsabbruch bei Firebase), und der
   * Local-Fallback benachrichtigt den eigenen Tab nach eigenem Schreiben gar
   * nicht (er meldet nur an ANDERE Tabs, siehe LocalBackend in js/net.js).
   * Beim Postfach darf das nicht passieren — da liegt echtes Preisgeld. */
  function refresh() {
    return store().then(function (b) {
      return Promise.all([
        b.get(ROOT + '/settings').then(function (v) { settings = v || null; }),
        b.get(ROOT + '/schedule').then(function (v) { schedule = v || null; }),
        b.get(ROOT + '/hosts').then(function (v) { hosts = v || null; }),
        b.get(ROOT + '/pay/' + myPid()).then(collectPay)
      ]);
    }).catch(function () {});
  }

  var pollTimer = null;
  function start() {
    if (watching) return Promise.resolve();
    watching = true;
    return store().then(function (b) {
      b.watch(ROOT + '/settings', function (v) { settings = v || null; });
      b.watch(ROOT + '/schedule', function (v) { schedule = v || null; });
      b.watch(ROOT + '/hosts', function (v) { hosts = v || null; });
      b.watch(ROOT + '/pay/' + myPid(), collectPay);
      if (!pollTimer) pollTimer = setInterval(refresh, 30000);
      return refresh();
    }).catch(function () { watching = false; });
  }

  /* ---------------- Turnier anlegen ---------------- */
  /** Prüft alles, was einem Turnier im Weg stehen kann. -> Fehlertext oder null. */
  function validate(conf) {
    if (!conf.rounds || !conf.rounds.length) return 'Wähle mindestens ein Spiel für den Rundenplan.';
    if (conf.rounds.length > MAX_ROUNDS) return 'Höchstens ' + MAX_ROUNDS + ' Runden pro Turnier.';
    if (App.Tournament.isBanned()) return 'Du bist für den Turniermodus gesperrt.';

    var lead = (conf.startAt || 0) - Date.now();
    if (lead < MIN_LEAD_MS) {
      return 'Die Startzeit muss mindestens ' + Math.round(MIN_LEAD_MS / 60000) + ' Minuten in der Zukunft liegen — sonst kann niemand beitreten.';
    }
    var hit = slotConflict(conf.startAt);
    if (hit) {
      return 'Um diese Zeit läuft schon „' + (hit.title || 'ein Turnier') + '" (' + tsToTime(hit.at) + '). ' +
        'Zwischen zwei Turnieren müssen ' + Math.round(MIN_GAP_MS / 60000) + ' Minuten liegen.';
    }
    var cd = cooldownLeft();
    if (cd > 0) return 'Du kannst erst in ' + fmtLeft(cd) + ' wieder ein Turnier hosten.';

    var fee = Math.round(Number(conf.fee) || 0);
    if (!isAdmin()) {
      if (fee < minFee()) return 'Der Einsatz muss mindestens ' + App.UI.formatShort(minFee()) + ' Coins betragen.';
      if (fee > casinoBalance()) return 'Dafür reicht dein Guthaben nicht (' + App.UI.formatShort(casinoBalance()) + ' Coins).';
    }
    return null;
  }

  /**
   * Turnier einplanen. Bucht die Gebühr sofort ab (nicht erst beim Start) —
   * sonst wäre nicht gedeckt, was am Ende ausgezahlt wird.
   */
  function create(conf) {
    var err = validate(conf);
    if (err) return Promise.reject(new Error(err));

    var admin = isAdmin();
    var fee = admin ? Math.max(0, Math.round(Number(conf.fee) || 0)) : Math.round(Number(conf.fee) || 0);
    // Der Topf ist normalerweise der Einsatz; nur der Admin darf ihn frei setzen
    // (kostenlos hosten und trotzdem Preisgeld ausloben).
    var pot = admin ? Math.max(0, Math.round(Number(conf.pot != null ? conf.pot : fee) || 0)) : fee;

    var tid = 'h' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    var entry = {
      id: tid,
      title: String(conf.title || 'Turnier').slice(0, 40),
      hostPid: myPid(),
      hostName: App.Tournament.myName(),
      hostAdmin: admin,
      startAt: conf.startAt,
      rounds: conf.rounds.slice(),
      roundSec: conf.roundSec,
      roundSecs: conf.roundSecs.slice(),
      ticketCost: Math.max(0, Math.round(Number(conf.ticketCost) || 0)),
      chat: !!conf.chat,
      prizeKind: 'money',
      fee: fee,
      pot: pot,
      status: 'planned',
      createdAt: Date.now()
    };

    return store().then(function (b) {
      return b.set(ROOT + '/schedule/' + tid, entry).then(function () {
        // Cooldown-Marke getrennt vom Eintrag (überlebt eine Absage).
        return b.update(ROOT + '/hosts/' + myPid(), { lastAt: entry.createdAt, name: entry.hostName });
      });
    }).then(function () {
      // Erst zahlen, wenn der Eintrag wirklich steht — sonst wäre das Geld weg
      // und das Turnier gäbe es nicht.
      if (fee > 0) payCasino(-fee);
      // Eigene Sicht sofort nachziehen: der watch() kommt erst gleich, bis dahin
      // würden Cooldown und Slot-Prüfung das eigene frische Turnier nicht sehen.
      hosts = hosts || {};
      hosts[myPid()] = { lastAt: entry.createdAt, name: entry.hostName };
      schedule = schedule || {};
      schedule[tid] = entry;
      return entry;
    });
  }

  /** Eigenes Turnier absagen, solange es noch nicht im Slot ist. Geld zurück. */
  function cancel(tid) {
    var t = (schedule || {})[tid];
    if (!t) return Promise.reject(new Error('Turnier nicht gefunden.'));
    if (t.hostPid !== myPid() && !isAdmin()) return Promise.reject(new Error('Das ist nicht dein Turnier.'));
    if (t.status !== 'planned') return Promise.reject(new Error('Das Turnier läuft schon — es lässt sich nicht mehr absagen.'));
    return store().then(function (b) {
      return b.remove(ROOT + '/schedule/' + tid);
    }).then(function () {
      // Rückerstattung übers Postfach, damit sie auch ankommt, wenn der Admin
      // ein fremdes Turnier absagt.
      return queuePay(t.hostPid, tid, 'cancel', t.fee, 'Turnier „' + (t.title || '') + '" abgesagt');
    });
  }

  /* ---------------- Slot-Vergabe ----------------
   * Wird aus dem tick() von js/tournament.js gerufen — von JEDEM Client, nicht
   * nur vom Taktgeber: solange kein Turnier läuft, gibt es keinen Taktgeber, der
   * das nächste holen könnte. Doppelläufe sind ungefährlich, weil nur promotet
   * wird, wenn im Slot ein ANDERES Turnier steht (cfg.id !== tid) — danach ist
   * die Bedingung für alle falsch.
   */
  var promoting = false;
  function promoteIfDue(cfg) {
    if (promoting || !schedule) return;
    if (cfg && cfg.status === 'open') return;   // Slot belegt: läuft noch was
    var now = Date.now();

    cleanupOld(now);

    var due = list().filter(function (t) {
      return t.status === 'planned' && (t.startAt || 0) - PRE_OPEN_MS <= now;
    })[0];
    if (!due) return;
    if (cfg && cfg.id === due.id) return;

    promoting = true;
    store().then(function (b) {
      return b.set(ROOT + '/config', {
        id: due.id,
        scheduleId: due.id,
        status: 'open',
        title: due.title,
        startAt: due.startAt,
        rounds: due.rounds,
        roundSec: due.roundSec,
        roundSecs: due.roundSecs,
        ticketCost: due.ticketCost,
        chat: due.chat,
        prizeKind: 'money',
        pot: due.pot,
        fee: due.fee,
        hostPid: due.hostPid,
        hostName: due.hostName,
        createdAt: due.createdAt
      }).then(function () {
        return b.set(ROOT + '/live', { phase: 'queue', round: 0, deadline: 0 });
      }).then(function () {
        return b.update(ROOT + '/schedule/' + due.id, { status: 'live' });
      });
    }).catch(function () {}).then(function () { promoting = false; });
  }

  function cleanupOld(now) {
    var s = schedule || {};
    Object.keys(s).forEach(function (k) {
      var t = s[k] || {};
      if ((t.startAt || t.createdAt || 0) < now - KEEP_MS) {
        store().then(function (b) { b.remove(ROOT + '/schedule/' + k); }).catch(function () {});
      }
    });
  }

  /* ---------------- Abrechnung ---------------- */
  /** Turnier zu Ende: Preisgeld in die Postfächer. Ruft js/tournament.js. */
  function settleMoney(cfg, ranking) {
    if (!cfg || cfg.prizeKind !== 'money') return Promise.resolve([]);
    var plan = payoutPlan(cfg, ranking || []);
    return Promise.all(plan.map(function (p) {
      var reason = p.place
        ? ('Platz ' + p.place + ' im Turnier „' + (cfg.title || '') + '"')
        : ('Nicht vergebenes Preisgeld aus „' + (cfg.title || '') + '"');
      return queuePay(p.pid, cfg.id, p.place ? ('p' + p.place) : 'rest', p.amount, reason);
    })).then(function () {
      return markDone(cfg).then(function () { return plan; });
    });
  }

  /** Turnier verfallen lassen: zur Startzeit war niemand da. Geld zurück.
   *  Darf jeder Beobachter — ohne Spieler gibt es keinen Taktgeber. */
  function expire(cfg) {
    if (!cfg) return Promise.resolve();
    return store().then(function (b) {
      return b.update(ROOT + '/config', { status: 'done' });
    }).then(function () {
      if (cfg.prizeKind !== 'money') return null;
      return queuePay(cfg.hostPid, cfg.id, 'expire', cfg.fee,
        'Turnier „' + (cfg.title || '') + '" ist verfallen — niemand war da');
    }).then(function () { return markDone(cfg); });
  }

  /** Ein bezahltes Turnier wird abgeräumt, bevor es zu Ende lief (der Admin sagt
   *  es ab oder setzt eins direkt in den Slot): Einsatz zurück an den Host.
   *  Schreibt bewusst KEINEN Status in config — das macht der Aufrufer, sonst
   *  würde ein frisch gesetztes Turnier gleich wieder auf 'done' gestellt.
   *  Nutzt denselben Anlass ('expire') wie der Verfall: sollten beide Wege
   *  greifen, ist es dieselbe Zahlung statt zwei. */
  function refundCfg(cfg, reason) {
    if (!cfg || cfg.prizeKind !== 'money') return Promise.resolve();
    return queuePay(cfg.hostPid, cfg.id, 'expire', cfg.fee,
      reason || ('Turnier „' + (cfg.title || '') + '" wurde abgebrochen'))
      .then(function () { return markDone(cfg); });
  }

  function markDone(cfg) {
    if (!cfg || !cfg.scheduleId) return Promise.resolve();
    return store().then(function (b) {
      return b.update(ROOT + '/schedule/' + cfg.scheduleId, { status: 'done' });
    }).catch(function () {});
  }

  /* ---------------- Anzeige-Helfer ---------------- */
  function fmtLeft(ms) {
    var s = Math.ceil(ms / 1000);
    if (s < 60) return s + ' Sek.';
    var m = Math.round(s / 60);
    if (m < 60) return m + ' Min.';
    var h = Math.floor(m / 60);
    return h + ' Std. ' + (m % 60) + ' Min.';
  }
  function tsToTime(ts) {
    var d = new Date(ts || Date.now());
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }
  function timeToTs(hhmm) {
    var parts = String(hhmm || '').split(':');
    var h = Number(parts[0]), m = Number(parts[1]);
    if (!isFinite(h) || !isFinite(m)) return Date.now() + 900000;
    var d = new Date();
    d.setHours(h, m, 0, 0);
    if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
    return d.getTime();
  }

  /** Preis eines Turniers als Text — Geld oder (Admin) Power-Up. */
  function prizeLabel(cfg) {
    if (!cfg) return '—';
    if (cfg.prizeKind === 'money') {
      var pot = Math.round(Number(cfg.pot) || 0);
      if (!pot) return 'Kein Preisgeld';
      return '💰 ' + App.UI.formatShort(pot) + ' Coins';
    }
    return '⚡ ' + App.Powerups.describe(cfg.prize);
  }
  /** "50 % = 1,2B · 30 % = …" für die Aufschlüsselung. */
  function shareLines(pot) {
    pot = Math.round(Number(pot) || 0);
    return SHARES.map(function (s, i) {
      return { place: i + 1, pct: Math.round(s * 100), amount: Math.floor(pot * s) };
    });
  }

  App.TournamentHost = {
    MIN_GAP_MS: MIN_GAP_MS,
    HOST_COOLDOWN_MS: HOST_COOLDOWN_MS,
    PRE_OPEN_MS: PRE_OPEN_MS,
    MIN_LEAD_MS: MIN_LEAD_MS,
    EXPIRE_MS: EXPIRE_MS,
    DEFAULT_MIN_FEE: DEFAULT_MIN_FEE,
    SHARES: SHARES,
    MAX_ROUNDS: MAX_ROUNDS,

    start: start,
    refresh: refresh,
    settings: function () { return { minFee: minFee() }; },
    minFee: minFee,
    setMinFee: function (v) {
      v = Math.max(0, Math.round(Number(v) || 0));
      return store().then(function (b) {
        return b.update(ROOT + '/settings', { minFee: v, updatedAt: Date.now() });
      });
    },

    list: list,
    upcoming: upcoming,
    mine: mine,
    slotConflict: slotConflict,
    takenSlots: takenSlots,
    cooldownLeft: cooldownLeft,
    canHost: function () { return !cooldownLeft() && !App.Tournament.isBanned(); },
    isAdmin: isAdmin,

    validate: validate,
    create: create,
    cancel: cancel,

    promoteIfDue: promoteIfDue,
    settleMoney: settleMoney,
    expire: expire,
    refundCfg: refundCfg,
    markDone: markDone,
    payoutPlan: payoutPlan,
    queuePay: queuePay,
    mailCoins: mailCoins,

    casinoBalance: casinoBalance,
    payCasino: payCasino,
    prizeLabel: prizeLabel,
    shareLines: shareLines,
    fmtLeft: fmtLeft,
    tsToTime: tsToTime,
    timeToTs: timeToTs
  };

  function boot() { start(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
