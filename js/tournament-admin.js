/* tournament-admin.js — Turnier-Menü im Admin Panel (Route /admin/tournament).
 * Modell: js/tournament.js · Spieler-Oberfläche: js/tournament-ui.js
 *
 * Drei Bereiche:
 *   1. Konfiguration  Rundenplan aus allen vorhandenen Spielen zusammenklicken,
 *                     Dauer, Ticketpreis, Startzeit, Chat, Sieger-Power-Up.
 *   2. Live           Wer ist in der Queue — mit Verwarnen und Bannen, auch
 *                     während das Turnier schon läuft (Admin = Zuschauer).
 *   3. Turniersieger  Liste der Sieger zum Abhaken.
 */
(function () {
  'use strict';
  window.App = window.App || {};
  var UI = App.UI, el = UI.el;

  var KIND_LABEL = {
    score: '🏁 Wettbewerb — alle gleichzeitig, Punkte entscheiden',
    duel: '⚔️ Duell — Spieler werden paarweise gegeneinander gesetzt',
    live: '🃏 Poker & Casino — alle an einem Tisch, gewertet wird der Sieg',
    coop: '🤝 Koop — alle im Team, Erfolg zählt für alle',
    gamble: '🎰 Gambling — gewertet wird der Coin-Gewinn in der Rundenzeit'
  };
  // Kurzform für die Zeilen im Rundenplan
  var KIND_SHORT = { score: 'Wettbewerb', duel: 'Duell', live: 'Poker/Casino', coop: 'Koop', gamble: 'Gambling' };

  function injectCss() {
    UI.injectStyle('tournament-admin-css', [
      '.ta-sec{padding:16px;margin-bottom:14px;}',
      '.ta-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:10px;}',
      '.ta-field{display:flex;flex-direction:column;gap:4px;}',
      '.ta-field label{font-size:12px;opacity:.75;}',
      '.ta-pool{display:flex;flex-wrap:wrap;gap:6px;margin:6px 0 12px;}',
      '.ta-pick{font-size:12px;padding:5px 9px;}',
      '.ta-kind-head{font-size:12px;font-weight:700;opacity:.8;margin:10px 0 2px;}',
      '.ta-plan{display:flex;flex-direction:column;gap:6px;margin:8px 0;}',
      '.ta-plan-row{display:flex;align-items:center;gap:8px;padding:7px 10px;border-radius:9px;',
      'background:rgba(2,10,6,.5);border:1px solid var(--stroke);}',
      '.ta-plan-row .ta-num{font-weight:900;opacity:.6;width:22px;}',
      '.ta-plan-row .ta-x{margin-left:auto;}',
      '.ta-empty{opacity:.55;font-size:13px;padding:8px;}',
      '.ta-win-row{display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:10px;',
      'background:rgba(2,10,6,.45);border:1px solid var(--stroke);}',
      '.ta-win-row.done{opacity:.45;}',
      '.ta-win-row.done .ta-win-name{text-decoration:line-through;}',
      '.ta-win-name{font-weight:800;}',
      '.ta-win-prize{color:#ffc740;font-size:13px;}',
      '.ta-win-meta{margin-left:auto;font-size:12px;opacity:.7;}'
    ].join(''));
  }

  /** Uhrzeit "HH:MM" -> nächster Zeitpunkt (heute, sonst morgen). */
  function timeToTs(hhmm) {
    var parts = String(hhmm || '').split(':');
    var h = Number(parts[0]), m = Number(parts[1]);
    if (!isFinite(h) || !isFinite(m)) return Date.now() + 600000;
    var d = new Date();
    d.setHours(h, m, 0, 0);
    if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);   // Zeit schon vorbei -> morgen
    return d.getTime();
  }
  function tsToTime(ts) {
    var d = new Date(ts || Date.now());
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }

  function renderPage(root) {
    injectCss();
    var T = App.Tournament;
    T.start();

    // Rundenplan im Aufbau (Liste von Spiel-IDs, Reihenfolge = Spielreihenfolge)
    var plan = [];
    var existing = T.config();
    if (existing && existing.status === 'open' && existing.rounds) plan = existing.rounds.slice();

    var planBox = el('div', { class: 'ta-plan' });

    var titleIn = el('input', { class: 'text-input', type: 'text', maxlength: 40, value: (existing && existing.status === 'open' && existing.title) || 'Dschungel-Cup' });
    var timeIn = el('input', { class: 'text-input', type: 'time', value: existing && existing.status === 'open' ? tsToTime(existing.startAt) : tsToTime(Date.now() + 900000) });
    var durIn = el('input', { class: 'text-input', type: 'number', min: 15, max: 900, value: (existing && existing.status === 'open' && existing.roundSec) || 60 });
    var costIn = el('input', { class: 'text-input', type: 'number', min: 0, max: 20, value: existing && existing.status === 'open' && typeof existing.ticketCost === 'number' ? existing.ticketCost : 1 });
    var chatIn = el('input', { type: 'checkbox' });
    chatIn.checked = existing && existing.status === 'open' ? !!existing.chat : true;

    var prizeSel = el('select', { class: 'text-input' }, App.Powerups.TYPES.map(function (t) {
      return el('option', { value: t.id }, [t.icon + ' ' + t.label + ' (' + t.hint + ')']);
    }));
    var prizeMin = el('input', { class: 'text-input', type: 'number', min: 1, max: 120, value: 1 });
    var prizeAmt = el('input', { class: 'text-input', type: 'number', min: 1, max: 100000, value: 5000 });
    if (existing && existing.status === 'open' && existing.prize) {
      prizeSel.value = existing.prize.type || 'luck2';
      if (existing.prize.minutes) prizeMin.value = existing.prize.minutes;
      if (existing.prize.amount) prizeAmt.value = existing.prize.amount;
    } else {
      prizeSel.value = 'luck2';
    }

    var prizeMinField = el('div', { class: 'ta-field' }, [el('label', {}, ['Dauer (Minuten)']), prizeMin]);
    var prizeAmtField = el('div', { class: 'ta-field' }, [el('label', {}, ['Menge']), prizeAmt]);
    function syncPrizeFields() {
      var t = App.Powerups.typeById(prizeSel.value);
      var instant = !!(t && t.instant);
      prizeMinField.style.display = instant ? 'none' : '';
      prizeAmtField.style.display = instant ? '' : 'none';
    }
    prizeSel.addEventListener('change', syncPrizeFields);
    syncPrizeFields();

    function drawPlan() {
      planBox.innerHTML = '';
      if (!plan.length) {
        planBox.appendChild(el('div', { class: 'ta-empty' }, ['Noch keine Runde gewählt — klick unten Spiele an. Ein Spiel darf mehrfach vorkommen.']));
        return;
      }
      plan.forEach(function (gid, i) {
        var g = T.gameDef(gid);
        planBox.appendChild(el('div', { class: 'ta-plan-row' }, [
          el('span', { class: 'ta-num' }, [(i + 1) + '.']),
          el('span', {}, [(g && g.icon) || '🎮']),
          el('b', {}, [(g && g.title) || gid]),
          el('span', { class: 'cf-info-l' }, [KIND_SHORT[T.kindOf(gid)] || 'Wettbewerb']),
          el('button', {
            class: 'btn btn-ghost ta-x', type: 'button', title: 'Runde entfernen',
            onclick: function () { plan.splice(i, 1); drawPlan(); }
          }, ['✕'])
        ]));
      });
    }

    var pool = el('div', {});
    function drawPool() {
      pool.innerHTML = '';
      var cat = T.catalog();
      ['score', 'duel', 'live', 'gamble', 'coop'].forEach(function (kind) {
        var items = cat[kind] || [];
        if (!items.length) return;
        pool.appendChild(el('div', { class: 'ta-kind-head' }, [KIND_LABEL[kind] + ' (' + items.length + ')']));
        pool.appendChild(el('div', { class: 'ta-pool' }, items.map(function (it) {
          return el('button', {
            class: 'btn btn-ghost ta-pick', type: 'button', title: it.title,
            onclick: function () { plan.push(it.id); drawPlan(); }
          }, [it.icon + ' ' + it.title]);
        })));
      });
    }

    function collect() {
      var t = App.Powerups.typeById(prizeSel.value);
      var prize = { type: prizeSel.value };
      if (t && t.instant) prize.amount = Math.max(1, Math.round(Number(prizeAmt.value) || 1));
      else prize.minutes = Math.max(1, Math.round(Number(prizeMin.value) || 1));
      return {
        title: (titleIn.value || 'Turnier').slice(0, 40),
        startAt: timeToTs(timeIn.value),
        rounds: plan.slice(),
        roundSec: Math.max(15, Math.round(Number(durIn.value) || 60)),
        ticketCost: Math.max(0, Math.round(Number(costIn.value) || 0)),
        chat: !!chatIn.checked,
        prize: prize
      };
    }

    /* ---------------- Live-Bereich ---------------- */
    var liveBox = el('div', {});
    var warnDrafts = {};

    function drawLive() {
      var cfg = T.config();
      liveBox.innerHTML = '';
      if (!cfg || cfg.status !== 'open') {
        liveBox.appendChild(el('div', { class: 'ta-empty' }, ['Kein aktives Turnier.']));
        return;
      }
      var ps = T.players();
      var phase = T.phase() || 'queue';
      var phaseLabel = { queue: '🕒 Wartebereich', countdown: '3 · 2 · 1 …', round: '▶️ Runde ' + (T.round() + 1) + ' läuft', result: '📊 Zwischenstand', done: '🏆 Beendet' }[phase] || phase;

      liveBox.appendChild(el('p', { class: 'lb-hint' }, [
        phaseLabel + ' · ' + ps.length + ' Spieler angemeldet · ' +
        (phase === 'queue' ? ('Start um ' + tsToTime(cfg.startAt)) : ('Runde ' + (T.round() + 1) + '/' + cfg.rounds.length)) +
        (T.hostPid() ? '' : ' · niemand da, der die Uhr laufen lässt')
      ]));

      if (phase !== 'done') {
        liveBox.appendChild(el('div', { class: 'admin-row-actions', style: 'margin-bottom:10px;' }, [
          el('button', {
            class: 'btn btn-primary', type: 'button',
            onclick: function () { T.Admin.startNow().then(function () { UI.toast('Turnier startet jetzt!', 'win'); }); }
          }, ['▶️ Sofort starten']),
          el('button', {
            class: 'btn btn-ghost', type: 'button',
            onclick: function () {
              T.Admin.cancel().then(function () { UI.toast('Turnier abgesagt.', 'info'); drawLive(); });
            }
          }, ['✖️ Turnier absagen']),
          el('button', {
            class: 'btn btn-ghost', type: 'button',
            onclick: function () { App.Router.go('/tournament'); }
          }, ['👁 Als Zuschauer ansehen'])
        ]));
      }

      if (!ps.length) {
        liveBox.appendChild(el('div', { class: 'ta-empty' }, ['Noch niemand in der Queue.']));
        return;
      }

      var now = Date.now();
      var list = el('div', { class: 'admin-list' });
      T.ranking().forEach(function (p, i) {
        var online = (now - p.lastSeen) < 16000;
        var warnIn = el('input', {
          class: 'text-input', type: 'text', maxlength: 200,
          placeholder: 'Verwarnung an ' + p.name + ' …', value: warnDrafts[p.pid] || ''
        });
        warnIn.addEventListener('input', function () { warnDrafts[p.pid] = warnIn.value; });

        list.appendChild(el('div', { class: 'glass admin-row' + (online ? ' admin-online' : '') }, [
          el('div', { class: 'admin-row-head' }, [
            el('span', { class: 'admin-dot' + (online ? ' online' : '') }, [online ? '🟢' : '⚪']),
            el('span', { style: 'font-size:22px;' }, [p.avatar || '🐒']),
            el('b', {}, [p.name]),
            el('span', { class: 'cf-info-l' }, ['#' + (i + 1) + ' · ' + (p.points || 0) + ' Punkte']),
            T.hostPid() === p.pid ? el('span', { class: 'cf-info-l', title: 'Lässt gerade die Turnier-Uhr laufen' }, ['⏱ Taktgeber']) : null
          ].filter(Boolean)),
          el('div', { class: 'admin-row-actions' }, [
            warnIn,
            el('button', {
              class: 'btn btn-ghost', type: 'button',
              onclick: function () {
                var t = (warnIn.value || '').trim();
                if (!t) return;
                T.Admin.warn(p.pid, t).then(function () {
                  UI.toast('Verwarnung an ' + p.name + ' gesendet.', 'info');
                  warnIn.value = ''; warnDrafts[p.pid] = '';
                });
              }
            }, ['⚠️ Verwarnen']),
            el('button', {
              class: 'btn btn-ghost', type: 'button',
              onclick: function () {
                T.Admin.ban(p.pid).then(function () { UI.toast(p.name + ' aus dem Turniermodus gebannt.', 'lose'); drawLive(); });
              }
            }, ['🚫 Aus Turnier bannen'])
          ])
        ]));
      });
      liveBox.appendChild(list);

    }

    /* Gesperrte stehen bewusst außerhalb des Live-Bereichs: die Sperre gilt für
     * den Turniermodus insgesamt, auch wenn gerade kein Turnier angesetzt ist. */
    var banBox = el('div', {});
    function drawBanned() {
      var banned = T.bannedList();
      banBox.innerHTML = '';
      if (!banned.length) {
        banBox.appendChild(el('div', { class: 'ta-empty' }, ['Niemand gesperrt.']));
        return;
      }
      // Namen sind nur bekannt, solange jemand in der Queue steht — sonst
      // bleibt die technische ID als Anhaltspunkt.
      var names = {};
      T.players().forEach(function (p) { names[p.pid] = p.name; });
      banBox.appendChild(el('div', { class: 'admin-list' }, banned.map(function (pid) {
        return el('div', { class: 'glass admin-row' }, [
          el('div', { class: 'admin-row-actions' }, [
            el('span', {}, ['🚫 ' + (names[pid] || pid)]),
            el('button', {
              class: 'btn btn-ghost', type: 'button',
              onclick: function () {
                T.Admin.unban(pid).then(function () { UI.toast('Entsperrt.', 'win'); drawBanned(); });
              }
            }, ['Entsperren'])
          ])
        ]);
      })));
    }

    /* ---------------- Turniersieger ---------------- */
    var winBox = el('div', {});
    function drawWinners() {
      T.Admin.winners().then(function (ws) {
        winBox.innerHTML = '';
        if (!ws.length) {
          winBox.appendChild(el('div', { class: 'ta-empty' }, ['Noch keine Turniersieger.']));
          return;
        }
        ws.forEach(function (w) {
          var cb = el('input', { type: 'checkbox' });
          cb.checked = !!w.done;
          cb.addEventListener('change', function () {
            T.Admin.setWinnerDone(w.id, cb.checked).then(drawWinners);
          });
          winBox.appendChild(el('div', { class: 'ta-win-row' + (w.done ? ' done' : '') }, [
            cb,
            el('span', { class: 'ta-win-name' }, ['👑 ' + w.name]),
            el('span', { class: 'ta-win-prize' }, ['⚡ ' + w.prize]),
            el('span', { class: 'ta-win-meta' }, [
              (w.tournament || 'Turnier') + ' · ' + w.points + ' P · ' +
              new Date(w.ts).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
            ]),
            el('button', {
              class: 'btn btn-ghost', type: 'button', title: 'Eintrag löschen',
              onclick: function () { T.Admin.removeWinner(w.id).then(drawWinners); }
            }, ['✕'])
          ]));
        });
      });
    }

    /* ---------------- Seite ---------------- */
    root.appendChild(el('div', { class: 'page-head' }, [
      el('button', { class: 'btn btn-ghost back', type: 'button', onclick: function () { App.Router.go('/admin'); } }, ['← Admin Panel']),
      el('h2', { class: 'page-title neon' }, ['🏆 Turniere'])
    ]));

    root.appendChild(el('div', { class: 'glass ta-sec' }, [
      el('h3', { style: 'margin-top:0;' }, ['1 · Turnier konfigurieren']),
      el('div', { class: 'ta-grid' }, [
        el('div', { class: 'ta-field' }, [el('label', {}, ['Name des Turniers']), titleIn]),
        el('div', { class: 'ta-field' }, [el('label', {}, ['Startzeit (heute, sonst morgen)']), timeIn]),
        el('div', { class: 'ta-field' }, [el('label', {}, ['Dauer pro Runde (Sekunden)']), durIn]),
        el('div', { class: 'ta-field' }, [el('label', {}, ['Tickets pro Teilnahme']), costIn]),
        el('div', { class: 'ta-field' }, [el('label', {}, ['Preis für den Sieger']), prizeSel]),
        prizeMinField,
        prizeAmtField,
        el('div', { class: 'ta-field' }, [
          el('label', {}, ['Turnier-Chat']),
          el('label', { style: 'display:flex;align-items:center;gap:8px;font-size:14px;opacity:1;' }, [chatIn, 'Chat für alle Teilnehmer'])
        ])
      ]),
      el('h4', { style: 'margin:14px 0 0;' }, ['Rundenplan']),
      planBox,
      el('h4', { style: 'margin:14px 0 0;' }, ['Spiele hinzufügen']),
      pool,
      el('div', { class: 'admin-row-actions' }, [
        el('button', {
          class: 'btn btn-primary btn-lg', type: 'button',
          onclick: function () {
            var conf = collect();
            if (!conf.rounds.length) { UI.toast('Wähle mindestens ein Spiel für den Rundenplan.', 'lose'); return; }
            T.Admin.save(conf).then(function () {
              UI.toast('🏆 Turnier steht — Start um ' + tsToTime(conf.startAt), 'win');
              drawLive();
            }).catch(function (e) { UI.toast(e.message, 'lose'); });
          }
        }, ['🏆 Turnier ansetzen']),
        el('button', {
          class: 'btn btn-ghost', type: 'button',
          onclick: function () { plan = []; drawPlan(); }
        }, ['Rundenplan leeren'])
      ]),
      el('p', { class: 'lb-hint' }, [
        'Hinweis: Die Seite hat keinen Server — ein Turnier startet erst, wenn zur Startzeit ' +
        'auch wirklich jemand die Seite offen hat. Die Tickets werden erst beim Start abgebucht.'
      ])
    ]));

    root.appendChild(el('div', { class: 'glass ta-sec' }, [
      el('h3', { style: 'margin-top:0;' }, ['2 · Live: wer ist dabei']),
      liveBox,
      el('h4', { style: 'margin:14px 0 6px;' }, ['Für den Turniermodus gesperrt']),
      banBox
    ]));

    root.appendChild(el('div', { class: 'glass ta-sec' }, [
      el('h3', { style: 'margin-top:0;' }, ['3 · Turniersieger']),
      el('p', { class: 'lb-hint' }, ['Abhaken, wenn erledigt.']),
      winBox
    ]));

    drawPlan();
    drawPool();
    drawLive();
    drawBanned();
    drawWinners();

    function refreshLive() { drawLive(); drawBanned(); }
    var offLive = T.on('live', refreshLive);
    var offCfg = T.on('config', refreshLive);
    var timer = setInterval(refreshLive, 5000);

    return {
      cleanup: function () {
        if (timer) clearInterval(timer);
        offLive(); offCfg();
      }
    };
  }

  App.TournamentAdmin = { renderPage: renderPage };
})();
