/* tournament-host-ui.js — Oberfläche „Eigenes Turnier hosten" (Route /tournament/host).
 * Modell: js/tournament-host.js
 *
 * Drei Teile:
 *   1. Konfigurator  Name, Startzeit, Einsatz, Rundenplan mit eigener Zeit je Spiel.
 *   2. Preisgeld     Vorschau der Aufteilung 50 / 30 / 20 %.
 *   3. Zeitplan      Was schon angesetzt ist (eigene Turniere absagbar).
 *
 * Der Zeitplan (scheduleList) wird auch von js/tournament-ui.js eingebunden.
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
  var KIND_SHORT = { score: 'Wettbewerb', duel: 'Duell', live: 'Poker/Casino', coop: 'Koop', gamble: 'Gambling' };

  function injectCss() {
    UI.injectStyle('tournament-host-css', [
      '.th-sec{padding:16px;margin-bottom:14px;}',
      '.th-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:10px;}',
      '.th-field{display:flex;flex-direction:column;gap:4px;}',
      '.th-field label{font-size:12px;opacity:.75;}',
      '.th-hint-in{font-size:11px;opacity:.7;min-height:14px;}',
      '.th-hint-in.bad{color:#ff6b6b;opacity:1;}',
      '.th-pool{display:flex;flex-wrap:wrap;gap:6px;margin:6px 0 12px;}',
      '.th-pick{font-size:12px;padding:5px 9px;}',
      '.th-kind-head{font-size:12px;font-weight:700;opacity:.8;margin:10px 0 2px;}',
      '.th-plan{display:flex;flex-direction:column;gap:6px;margin:8px 0;}',
      '.th-plan-row{display:flex;align-items:center;gap:8px;padding:7px 10px;border-radius:9px;',
      'background:rgba(2,10,6,.5);border:1px solid var(--stroke);}',
      '.th-plan-row .th-num{font-weight:900;opacity:.6;width:22px;}',
      '.th-sec-wrap{margin-left:auto;display:flex;align-items:center;gap:5px;}',
      '.th-sec-in{width:64px;text-align:right;padding:5px 7px;font-size:13px;}',
      '.th-empty{opacity:.55;font-size:13px;padding:8px;}',
      /* Preisgeld-Vorschau */
      '.th-pot{display:flex;flex-wrap:wrap;gap:10px;margin-top:10px;}',
      '.th-pot-card{flex:1;min-width:120px;padding:12px;border-radius:12px;text-align:center;',
      'background:rgba(2,10,6,.55);border:1px solid var(--stroke);}',
      '.th-pot-card.p1{border-color:rgba(255,199,64,.7);background:radial-gradient(120% 120% at 50% 0,rgba(255,190,40,.18),rgba(2,10,6,.8) 70%);}',
      '.th-pot-medal{font-size:26px;}',
      '.th-pot-amt{font-size:20px;font-weight:900;color:#ffc740;font-variant-numeric:tabular-nums;}',
      '.th-pot-sub{font-size:11px;opacity:.7;}',
      /* Zeitplan */
      '.th-sched{display:flex;flex-direction:column;gap:8px;}',
      '.th-sched-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:10px 12px;border-radius:10px;',
      'background:rgba(2,10,6,.45);border:1px solid var(--stroke);}',
      '.th-sched-row.live{border-color:var(--neon);box-shadow:0 0 10px rgba(57,255,20,.25);}',
      '.th-sched-row.mine{border-color:rgba(255,199,64,.6);}',
      '.th-sched-time{font-size:20px;font-weight:900;color:var(--neon);font-variant-numeric:tabular-nums;min-width:64px;}',
      '.th-sched-meta{font-size:12px;opacity:.7;}',
      '.th-sched-right{margin-left:auto;display:flex;align-items:center;gap:8px;}',
      '.th-lock{padding:12px;border-radius:12px;background:rgba(255,107,107,.1);border:1px solid rgba(255,107,107,.4);font-size:13px;}'
    ].join(''));
  }

  /* Große Beträge tippbar machen: „750B" statt 750000000000. Deutsches Format
   * (Punkt = Tausender, Komma = Dezimal) plus die Suffixe aus UI.formatCoins. */
  var MULT = { K: 1e3, M: 1e6, B: 1e9, T: 1e12 };
  function parseAmount(s) {
    s = String(s == null ? '' : s).trim().toUpperCase().replace(/\s+/g, '').replace(/COINS?$/, '');
    if (!s) return NaN;
    var m = s.match(/^([0-9]+(?:\.[0-9]{3})*(?:,[0-9]+)?|[0-9]*(?:,[0-9]+)?)([KMBT])?$/);
    if (!m || m[1] === '' || m[1] === ',') return NaN;
    var v = Number(m[1].replace(/\./g, '').replace(',', '.'));
    if (!isFinite(v) || v < 0) return NaN;
    return Math.round(v * (MULT[m[2]] || 1));
  }

  /* ---------------- Zeitplan (auch von tournament-ui.js genutzt) ---------------- */
  function scheduleList(opts) {
    opts = opts || {};
    var H = App.TournamentHost, T = App.Tournament;
    var box = el('div', { class: 'th-sched' });

    function draw() {
      var rows = H.upcoming();
      var me = T.myPid();
      box.innerHTML = '';
      if (!rows.length) {
        box.appendChild(el('div', { class: 'th-empty' }, ['Gerade ist kein Turnier angesetzt.']));
        return;
      }
      rows.forEach(function (t) {
        var isMine = t.hostPid === me;
        var isLive = t.status === 'live';
        var right = el('div', { class: 'th-sched-right' }, [
          el('span', { style: 'font-weight:800;color:#ffc740;' }, ['💰 ' + UI.formatShort(t.pot || 0)])
        ]);
        // Absagen: nur der eigene Host (oder der Admin) und nur solange das
        // Turnier noch nicht im Slot steht — danach läuft es.
        if ((isMine || H.isAdmin()) && t.status === 'planned') {
          right.appendChild(el('button', {
            class: 'btn btn-ghost', type: 'button', title: 'Turnier absagen — Einsatz zurück',
            onclick: function () {
              H.cancel(t.id).then(function () {
                UI.toast('Turnier abgesagt — Einsatz kommt zurück.', 'info');
                draw();
              }).catch(function (e) { UI.toast(e.message, 'lose'); });
            }
          }, ['✕ Absagen']));
        }
        var games = (t.rounds || []).length;
        box.appendChild(el('div', { class: 'th-sched-row' + (isLive ? ' live' : '') + (isMine ? ' mine' : '') }, [
          el('span', { class: 'th-sched-time' }, [H.tsToTime(t.startAt)]),
          el('div', {}, [
            el('div', { style: 'font-weight:800;' }, [
              (isLive ? '🔴 ' : '') + (t.title || 'Turnier') + (isMine ? ' (deins)' : '')
            ]),
            el('div', { class: 'th-sched-meta' }, [
              'Host: ' + (t.hostName || '?') + ' · ' + games + ' Runde' + (games === 1 ? '' : 'n') +
              ' · Eintritt: ' + (t.ticketCost ? App.Tickets.label(t.ticketCost) : 'gratis') +
              (isLive ? ' · läuft' : '')
            ])
          ]),
          right
        ]));
      });
    }
    draw();
    return { root: box, refresh: draw };
  }

  /* ---------------- Seite ---------------- */
  function renderPage(root) {
    injectCss();
    var H = App.TournamentHost, T = App.Tournament;
    T.start(); H.start();

    var admin = H.isAdmin();
    var plan = [], planSecs = [];

    /* --- Eingabefelder --- */
    var titleIn = el('input', { class: 'text-input', type: 'text', maxlength: 40, value: (T.myName() || 'Spieler') + 's Cup' });
    var timeIn = el('input', { class: 'text-input', type: 'time', value: H.tsToTime(Date.now() + 20 * 60000) });
    var durIn = el('input', { class: 'text-input', type: 'number', min: 5, max: 900, value: 45 });
    var costIn = el('input', { class: 'text-input', type: 'number', min: 0, max: 20, value: 0 });
    var chatIn = el('input', { type: 'checkbox' });
    chatIn.checked = true;

    var feeIn = el('input', { class: 'text-input', type: 'text', value: shortAmount(H.minFee()) });
    var feeHint = el('div', { class: 'th-hint-in' }, ['']);
    // Nur der Admin darf Einsatz und Topf entkoppeln (gratis hosten, trotzdem
    // Preisgeld ausloben).
    var potIn = el('input', { class: 'text-input', type: 'text', value: shortAmount(H.minFee()) });
    var potHint = el('div', { class: 'th-hint-in' }, ['']);

    /* Vorbelegung des Eingabefelds: die Kurzform ist rundet ("1,2B"), deshalb
     * nur nehmen, wenn sie exakt zurückliest — sonst läge die Vorgabe unter dem
     * Mindesteinsatz und das eigene Formular würde meckern. */
    function shortAmount(n) {
      n = Math.round(Number(n) || 0);
      var s = UI.formatShort(n);
      return parseAmount(s) === n ? s : String(n);
    }
    function feeVal() { return parseAmount(feeIn.value); }
    function potVal() { return admin ? parseAmount(potIn.value) : feeVal(); }

    /* --- Preisgeld-Vorschau --- */
    var potBox = el('div', { class: 'th-pot' });
    function drawPot() {
      var pot = potVal();
      potBox.innerHTML = '';
      if (!isFinite(pot)) {
        potBox.appendChild(el('div', { class: 'th-empty' }, ['Trag einen gültigen Betrag ein.']));
        return;
      }
      var medals = ['🥇', '🥈', '🥉'];
      H.shareLines(pot).forEach(function (s, i) {
        potBox.appendChild(el('div', { class: 'th-pot-card' + (i === 0 ? ' p1' : '') }, [
          el('div', { class: 'th-pot-medal' }, [medals[i]]),
          el('div', { class: 'th-pot-amt' }, [UI.formatShort(s.amount)]),
          el('div', { class: 'th-pot-sub' }, [s.pct + ' % · Platz ' + s.place])
        ]));
      });
    }

    function syncAmounts() {
      var fee = feeVal();
      if (!isFinite(fee)) {
        feeHint.textContent = 'Betrag nicht lesbar — z. B. 750B, 1,5T oder 750000000000.';
        feeHint.classList.add('bad');
      } else if (!admin && fee < H.minFee()) {
        feeHint.textContent = 'Mindestens ' + UI.formatShort(H.minFee()) + ' Coins.';
        feeHint.classList.add('bad');
      } else if (!admin && fee > H.casinoBalance()) {
        feeHint.textContent = 'Mehr als dein Guthaben (' + UI.formatShort(H.casinoBalance()) + ').';
        feeHint.classList.add('bad');
      } else {
        feeHint.textContent = '= ' + UI.formatCoins(fee) + ' Coins' + (admin && !fee ? ' (gratis)' : '');
        feeHint.classList.remove('bad');
      }
      if (admin) {
        var pot = potVal();
        potHint.textContent = isFinite(pot) ? ('= ' + UI.formatCoins(pot) + ' Coins') : 'Betrag nicht lesbar.';
        potHint.classList.toggle('bad', !isFinite(pot));
      } else {
        // Für Spieler ist der Topf immer der Einsatz.
        potIn.value = feeIn.value;
      }
      drawPot();
    }
    feeIn.addEventListener('input', syncAmounts);
    potIn.addEventListener('input', syncAmounts);

    /* --- Rundenplan --- */
    var planBox = el('div', { class: 'th-plan' });
    function drawPlan() {
      planBox.innerHTML = '';
      if (!plan.length) {
        planBox.appendChild(el('div', { class: 'th-empty' }, ['Noch keine Runde gewählt — klick unten Spiele an. Ein Spiel darf mehrfach vorkommen.']));
        return;
      }
      plan.forEach(function (gid, i) {
        var g = T.gameDef(gid);
        var secIn = el('input', {
          class: 'text-input th-sec-in', type: 'number', min: 5, max: 900,
          value: planSecs[i], title: 'Rundendauer für dieses Spiel (Sekunden)'
        });
        secIn.addEventListener('input', function () {
          planSecs[i] = Math.max(5, Math.round(Number(secIn.value) || 45));
        });
        planBox.appendChild(el('div', { class: 'th-plan-row' }, [
          el('span', { class: 'th-num' }, [(i + 1) + '.']),
          el('span', {}, [(g && g.icon) || '🎮']),
          el('b', {}, [(g && g.title) || gid]),
          el('span', { class: 'cf-info-l' }, [KIND_SHORT[T.kindOf(gid)] || 'Wettbewerb']),
          el('span', { class: 'th-sec-wrap' }, [secIn, el('span', { class: 'cf-info-l' }, ['Sek.'])]),
          el('button', {
            class: 'btn btn-ghost', type: 'button', title: 'Runde entfernen',
            onclick: function () { plan.splice(i, 1); planSecs.splice(i, 1); drawPlan(); }
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
        pool.appendChild(el('div', { class: 'th-kind-head' }, [KIND_LABEL[kind] + ' (' + items.length + ')']));
        pool.appendChild(el('div', { class: 'th-pool' }, items.map(function (it) {
          return el('button', {
            class: 'btn btn-ghost th-pick', type: 'button', title: it.title,
            onclick: function () {
              if (plan.length >= H.MAX_ROUNDS) { UI.toast('Höchstens ' + H.MAX_ROUNDS + ' Runden.', 'lose'); return; }
              plan.push(it.id);
              planSecs.push(Math.max(5, Math.round(Number(durIn.value) || 45)));
              drawPlan();
            }
          }, [it.icon + ' ' + it.title]);
        })));
      });
    }

    function collect() {
      var def = Math.max(5, Math.round(Number(durIn.value) || 45));
      return {
        title: (titleIn.value || 'Turnier').slice(0, 40),
        startAt: H.timeToTs(timeIn.value),
        rounds: plan.slice(),
        roundSec: def,
        roundSecs: plan.map(function (gid, i) { return Math.max(5, Math.round(Number(planSecs[i]) || def)); }),
        ticketCost: Math.max(0, Math.round(Number(costIn.value) || 0)),
        chat: !!chatIn.checked,
        fee: feeVal(),
        pot: potVal()
      };
    }

    /* --- Sperr-Hinweise (Cooldown / belegte Zeiten) --- */
    var lockBox = el('div', {});
    function drawLock() {
      lockBox.innerHTML = '';
      var cd = H.cooldownLeft();
      if (cd > 0) {
        lockBox.appendChild(el('div', { class: 'th-lock' }, [
          '⏳ Du hast gerade erst ein Turnier angesetzt. Das nächste kannst du in ' + H.fmtLeft(cd) + ' hosten.'
        ]));
      }
      var taken = H.takenSlots();
      if (taken.length) {
        lockBox.appendChild(el('p', { class: 'lb-hint' }, [
          'Schon belegt: ' + taken.map(function (o) { return H.tsToTime(o.at); }).join(', ') +
          ' — deine Startzeit muss ' + Math.round(H.MIN_GAP_MS / 60000) + ' Minuten Abstand halten.'
        ]));
      }
    }

    /* --- Seitenaufbau --- */
    root.appendChild(el('div', { class: 'page-head' }, [
      el('button', { class: 'btn btn-ghost back', type: 'button', onclick: function () { App.Router.go('/tournament'); } }, ['← Turnier']),
      el('h2', { class: 'page-title neon' }, ['🏆 Eigenes Turnier hosten'])
    ]));

    var feeField = el('div', { class: 'th-field' }, [
      el('label', {}, [admin ? 'Dein Einsatz (Admin: 0 = gratis)' : 'Dein Einsatz (wird zum Preisgeld)']),
      feeIn, feeHint,
      el('div', { style: 'display:flex;gap:6px;' }, [
        el('button', {
          class: 'btn btn-ghost th-pick', type: 'button',
          onclick: function () { feeIn.value = shortAmount(H.minFee()); syncAmounts(); }
        }, ['Minimum']),
        admin ? el('button', {
          class: 'btn btn-ghost th-pick', type: 'button',
          onclick: function () { feeIn.value = '0'; syncAmounts(); }
        }, ['Gratis']) : null
      ].filter(Boolean))
    ]);

    var fields = [
      el('div', { class: 'th-field' }, [el('label', {}, ['Name des Turniers']), titleIn]),
      el('div', { class: 'th-field' }, [el('label', {}, ['Startzeit (heute, sonst morgen)']), timeIn]),
      feeField
    ];
    if (admin) {
      fields.push(el('div', { class: 'th-field' }, [
        el('label', {}, ['Preisgeld-Topf (frei wählbar)']), potIn, potHint
      ]));
    }
    fields.push(el('div', { class: 'th-field' }, [el('label', {}, ['Standard-Rundendauer (Sek.)']), durIn]));
    fields.push(el('div', { class: 'th-field' }, [el('label', {}, ['Tickets pro Teilnahme']), costIn]));
    fields.push(el('div', { class: 'th-field' }, [
      el('label', {}, ['Turnier-Chat']),
      el('label', { style: 'display:flex;align-items:center;gap:8px;font-size:14px;opacity:1;' }, [chatIn, 'Chat für alle Teilnehmer'])
    ]));

    root.appendChild(el('div', { class: 'glass th-sec' }, [
      el('h3', { style: 'margin-top:0;' }, ['1 · Turnier einrichten']),
      el('p', { class: 'lb-hint' }, [
        admin
          ? 'Als Admin hostest du gratis und setzt das Preisgeld trotzdem frei.'
          : ('Dein Einsatz ist das Preisgeld: Platz 1 bekommt 50 %, Platz 2 30 %, Platz 3 20 %. ' +
             'Was mangels Spielern nicht vergeben wird, kommt zu dir zurück. Dein Guthaben: ' +
             UI.formatShort(H.casinoBalance()) + ' Coins.')
      ]),
      el('div', { class: 'th-grid' }, fields),
      lockBox
    ]));

    root.appendChild(el('div', { class: 'glass th-sec' }, [
      el('h3', { style: 'margin-top:0;' }, ['2 · Preisgeld']),
      potBox
    ]));

    root.appendChild(el('div', { class: 'glass th-sec' }, [
      el('h3', { style: 'margin-top:0;' }, ['3 · Rundenplan']),
      planBox,
      el('h4', { style: 'margin:14px 0 0;' }, ['Spiele hinzufügen']),
      pool,
      el('div', { class: 'admin-row-actions' }, [
        el('button', {
          class: 'btn btn-primary btn-lg', type: 'button',
          onclick: function () {
            var conf = collect();
            if (!isFinite(conf.fee)) { UI.toast('Der Einsatz ist nicht lesbar — z. B. 750B.', 'lose'); return; }
            if (admin && !isFinite(conf.pot)) { UI.toast('Das Preisgeld ist nicht lesbar.', 'lose'); return; }
            H.create(conf).then(function (t) {
              UI.toast('🏆 „' + t.title + '" steht — Start um ' + H.tsToTime(t.startAt), 'win');
              App.Router.go('/tournament');
            }).catch(function (e) { UI.toast(e.message, 'lose'); });
          }
        }, ['🏆 Turnier ansetzen']),
        el('button', {
          class: 'btn btn-ghost', type: 'button',
          onclick: function () { plan = []; planSecs = []; drawPlan(); }
        }, ['Rundenplan leeren'])
      ]),
      el('p', { class: 'lb-hint' }, [
        'Der Wartebereich öffnet ' + Math.round(H.PRE_OPEN_MS / 60000) + ' Minuten vor dem Start. ' +
        'Die Seite hat keinen Server: Ein Turnier startet nur, wenn zur Startzeit wirklich jemand da ist — ' +
        'ist nach ' + Math.round(H.EXPIRE_MS / 60000) + ' Minuten niemand angetreten, verfällt es und du bekommst deinen Einsatz zurück.'
      ])
    ]));

    var sched = scheduleList();
    root.appendChild(el('div', { class: 'glass th-sec' }, [
      el('h3', { style: 'margin-top:0;' }, ['4 · Schon angesetzt']),
      sched.root
    ]));

    drawPlan(); drawPool(); syncAmounts(); drawLock();

    var timer = setInterval(function () { sched.refresh(); drawLock(); }, 4000);
    return { cleanup: function () { if (timer) clearInterval(timer); } };
  }

  App.TournamentHostUI = {
    renderPage: renderPage,
    scheduleList: scheduleList,
    parseAmount: parseAmount
  };
})();
