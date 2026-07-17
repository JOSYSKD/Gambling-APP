/* tournament-ui.js — Oberfläche des Turniermodus (Route /tournament).
 * Modell + Ablauf: js/tournament.js
 *
 * Eine Seite, fünf Zustände (folgen der Turnier-Phase):
 *   queue      Wartebereich: Countdown bis zur Startzeit, alle angemeldeten
 *              Spieler mit Profilbild, Beitreten/Verlassen, Chat, Rundenplan.
 *   countdown  3 Sekunden vor jeder Runde: das Spiel + alle Mitspieler.
 *   round      Das Spiel selbst (siehe mountGame).
 *   result     Zwischenstand nach der Runde.
 *   done       Sieger-Ehrung mit Power-Up.
 *
 * Neu gebaut wird nur bei Phasen-/Rundenwechsel (viewKey); innerhalb einer
 * Phase werden bloß Werte aktualisiert. Sonst würde jeder Heartbeat eines
 * Mitspielers die Ansicht neu zeichnen und alles flackern.
 */
(function () {
  'use strict';
  window.App = window.App || {};
  var UI = App.UI, el = UI.el;
  var T = null;   // App.Tournament, erst zur Laufzeit da

  function injectCss() {
    UI.injectStyle('tournament-css', [
      /* Wartebereich */
      '.tq-head{display:flex;flex-wrap:wrap;align-items:center;gap:10px 18px;margin-bottom:6px;}',
      '.tq-clock{font-size:34px;font-weight:900;color:var(--neon);font-variant-numeric:tabular-nums;',
      'text-shadow:0 0 14px rgba(57,255,20,.55);}',
      '.tq-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px;margin:14px 0;}',
      '.tq-player{padding:12px;display:flex;align-items:center;gap:10px;border-radius:12px;}',
      '.tq-player.me{border-color:var(--neon);box-shadow:0 0 10px rgba(57,255,20,.35);}',
      '.tq-ava{font-size:26px;line-height:1;}',
      '.tq-pname{font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.tq-psub{font-size:11px;opacity:.7;}',
      '.tq-off{opacity:.45;}',
      '.tq-plan{display:flex;flex-wrap:wrap;gap:6px;margin:10px 0;}',
      '.tq-chip{padding:5px 10px;border-radius:999px;border:1px solid var(--stroke);background:rgba(4,16,10,.6);font-size:12px;}',
      '.tq-chip.now{border-color:var(--neon);color:var(--neon);font-weight:800;}',
      '.tq-chip.past{opacity:.4;}',
      /* Chat */
      '.tc-wrap{display:flex;flex-direction:column;gap:8px;margin-top:14px;}',
      '.tc-log{max-height:190px;overflow-y:auto;display:flex;flex-direction:column;gap:6px;padding:10px;',
      'border-radius:12px;background:rgba(2,10,6,.5);border:1px solid var(--stroke);}',
      '.tc-msg{font-size:13px;line-height:1.4;word-break:break-word;}',
      '.tc-msg b{color:var(--neon);}',
      '.tc-msg.tc-admin b{color:#ffd34d;}',
      '.tc-row{display:flex;gap:8px;}',
      '.tc-row .text-input{flex:1;}',
      /* Countdown */
      '.tcd{display:flex;flex-direction:column;align-items:center;gap:6px;padding:26px 0;}',
      '.tcd-num{font-size:96px;font-weight:900;color:var(--neon);line-height:1;',
      'text-shadow:0 0 30px rgba(57,255,20,.8);animation:tcd-pop .9s ease-out infinite;}',
      '@keyframes tcd-pop{0%{transform:scale(.6);opacity:.2;}55%{transform:scale(1.08);opacity:1;}100%{transform:scale(1);opacity:.85;}}',
      '.tcd-game{font-size:22px;font-weight:800;}',
      '.reduce-motion .tcd-num{animation:none;}',
      /* Runde */
      '.tr-bar{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px;',
      'padding:8px 12px;border-radius:12px;background:rgba(2,10,6,.6);border:1px solid var(--stroke);margin-bottom:10px;}',
      '.tr-time{font-weight:800;color:var(--neon);font-variant-numeric:tabular-nums;}',
      '.tr-time.low{color:#ff6b6b;animation:tr-blink .6s steps(2) infinite;}',
      '@keyframes tr-blink{50%{opacity:.35;}}',
      '.tr-stage{position:relative;}',
      /* Zuschauermodus */
      '.tsp-head{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px;margin-bottom:10px;}',
      '.tsp-head .tsp-live{display:inline-flex;align-items:center;gap:6px;font-weight:800;color:#ff6b6b;}',
      '.tsp-head .tsp-dot{width:9px;height:9px;border-radius:50%;background:#ff3b3b;box-shadow:0 0 8px #ff3b3b;animation:tsp-pulse 1.2s infinite;}',
      '@keyframes tsp-pulse{50%{opacity:.3;}}',
      '.reduce-motion .tsp-dot{animation:none;}',
      '.tsp-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px;}',
      '.tsp-card{position:relative;padding:12px;border-radius:12px;cursor:pointer;text-align:center;',
      'background:rgba(2,10,6,.55);border:1px solid var(--stroke);transition:border-color .15s,transform .1s;}',
      '.tsp-card:hover{border-color:var(--neon);transform:translateY(-2px);}',
      '.tsp-card.focus{border-color:var(--neon);box-shadow:0 0 12px rgba(57,255,20,.4);}',
      '.tsp-card.off{opacity:.45;}',
      '.tsp-rank{position:absolute;top:6px;left:8px;font-size:12px;font-weight:900;opacity:.6;}',
      '.tsp-eye{position:absolute;top:6px;right:8px;font-size:12px;opacity:.5;}',
      '.tsp-ava{font-size:34px;line-height:1;margin:4px 0;}',
      '.tsp-name{font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.tsp-val{font-size:22px;font-weight:900;color:var(--neon);font-variant-numeric:tabular-nums;margin-top:4px;}',
      '.tsp-val.win{color:#ffc740;}',
      '.tsp-sub{font-size:11px;opacity:.65;}',
      /* Fokus-Ansicht */
      '.tsp-focus{margin-top:14px;padding:20px;border-radius:16px;position:relative;',
      'background:radial-gradient(120% 120% at 50% 0,rgba(57,255,20,.12),rgba(2,10,6,.85) 70%);border:1px solid var(--neon);}',
      '.tsp-focus-top{display:flex;align-items:center;gap:14px;flex-wrap:wrap;}',
      '.tsp-focus-ava{font-size:56px;line-height:1;}',
      '.tsp-focus-name{font-size:26px;font-weight:900;}',
      '.tsp-focus-big{font-size:52px;font-weight:900;color:var(--neon);font-variant-numeric:tabular-nums;line-height:1.1;}',
      '.tsp-focus-big.win{color:#ffc740;}',
      '.tsp-focus-meta{display:flex;flex-wrap:wrap;gap:8px 18px;margin-top:10px;font-size:14px;}',
      '.tsp-focus-meta b{color:var(--neon);}',
      '.tsp-close{position:absolute;top:12px;right:12px;}',
      '.tsp-state{margin-top:12px;padding:10px;border-radius:10px;background:rgba(2,10,6,.55);',
      'border:1px solid var(--stroke);font-size:13px;font-family:ui-monospace,monospace;word-break:break-word;}',
      /* Zwischenstand */
      '.ts-row{display:flex;align-items:center;gap:10px;padding:9px 12px;border-radius:10px;',
      'background:rgba(2,10,6,.45);border:1px solid var(--stroke);}',
      '.ts-row.me{border-color:var(--neon);}',
      '.ts-place{width:30px;font-weight:900;opacity:.8;}',
      '.ts-gain{margin-left:auto;font-weight:800;color:var(--neon);}',
      '.ts-pts{font-weight:900;min-width:52px;text-align:right;}',
      /* Sieger */
      '.tv-stage{position:relative;overflow:hidden;border-radius:18px;padding:40px 18px;text-align:center;',
      'background:radial-gradient(120% 90% at 50% 0%,rgba(255,190,40,.28),rgba(2,10,6,.9) 70%);',
      'border:1px solid rgba(255,199,64,.55);}',
      '.tv-crown{font-size:70px;animation:tv-bob 2.2s ease-in-out infinite;}',
      '@keyframes tv-bob{0%,100%{transform:translateY(0) rotate(-4deg);}50%{transform:translateY(-12px) rotate(4deg);}}',
      '.tv-name{font-size:40px;font-weight:900;margin:6px 0;',
      'background:linear-gradient(180deg,#fff6cc,#ffc740 45%,#ff8a00);-webkit-background-clip:text;background-clip:text;',
      '-webkit-text-fill-color:transparent;filter:drop-shadow(0 0 18px rgba(255,180,40,.85));}',
      '.tv-sub{font-size:15px;opacity:.9;}',
      '.tv-prize{display:inline-flex;align-items:center;gap:8px;margin-top:14px;padding:12px 20px;border-radius:999px;',
      'font-size:17px;font-weight:800;color:#2a1500;background:linear-gradient(180deg,#ffe9a3,#ffc740);',
      'box-shadow:0 0 26px rgba(255,190,50,.8);animation:tv-glow 1.5s ease-in-out infinite;}',
      '@keyframes tv-glow{50%{box-shadow:0 0 46px rgba(255,210,90,1);transform:scale(1.04);}}',
      '.tv-flame{position:absolute;bottom:-14px;width:14px;height:14px;border-radius:50%;pointer-events:none;',
      'background:radial-gradient(circle,#fff3b0,#ffb020 55%,rgba(255,90,0,0));animation:tv-rise linear infinite;}',
      '@keyframes tv-rise{0%{transform:translateY(0) scale(1);opacity:0;}',
      '12%{opacity:1;}100%{transform:translateY(-320px) scale(.25);opacity:0;}}',
      '.tv-spark{position:absolute;top:-12px;font-size:16px;pointer-events:none;animation:tv-fall linear infinite;}',
      '@keyframes tv-fall{0%{transform:translateY(0) rotate(0);opacity:0;}10%{opacity:1;}',
      '100%{transform:translateY(460px) rotate(420deg);opacity:0;}}',
      '.tv-ray{position:absolute;top:50%;left:50%;width:2px;height:150%;transform-origin:top center;pointer-events:none;',
      'background:linear-gradient(180deg,rgba(255,205,80,.5),rgba(255,205,80,0));animation:tv-spin 9s linear infinite;}',
      '@keyframes tv-spin{100%{transform:rotate(360deg);}}',
      '.reduce-motion .tv-flame,.reduce-motion .tv-spark,.reduce-motion .tv-ray,',
      '.reduce-motion .tv-crown,.reduce-motion .tv-prize{animation:none;}',
      '.tv-loser{font-size:19px;font-weight:800;margin:6px 0;}'
    ].join(''));
  }

  function fmtClock(ms) {
    var s = Math.max(0, Math.ceil(ms / 1000));
    var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    s = s % 60;
    if (h > 0) return h + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
    return m + ':' + String(s).padStart(2, '0');
  }
  function gameTitle(id) {
    var g = T.gameDef(id);
    return g ? ((g.icon || '🎮') + ' ' + g.title) : id;
  }
  function secFor(cfg, i) {
    var s = cfg.roundSecs && cfg.roundSecs[i];
    return Math.max(5, Math.round(Number(s != null ? s : cfg.roundSec) || 60));
  }
  /** "3 Runden · 45s" bei gleicher Dauer, sonst "3 Runden · 30–60s". */
  function roundsSummary(cfg) {
    var n = (cfg.rounds || []).length;
    var secs = (cfg.rounds || []).map(function (_, i) { return secFor(cfg, i); });
    var min = Math.min.apply(null, secs), max = Math.max.apply(null, secs);
    var t = (min === max) ? (min + 's je Runde') : (min + '–' + max + 's je Runde');
    return n + ' Runden · ' + t;
  }

  /* ---------------- Spielerkacheln ---------------- */
  function playerTiles() {
    var now = Date.now();
    var me = T.myPid();
    return el('div', { class: 'tq-grid' }, T.players().map(function (p) {
      var online = (now - p.lastSeen) < 16000;
      return el('div', {
        class: 'glass tq-player' + (p.pid === me ? ' me' : '') + (online ? '' : ' tq-off'),
        title: online ? 'online' : 'nicht mehr da'
      }, [
        el('span', { class: 'tq-ava' }, [p.avatar || '🐒']),
        el('div', {}, [
          el('div', { class: 'tq-pname' }, [p.name + (p.pid === me ? ' (du)' : '')]),
          el('div', { class: 'tq-psub' }, [(p.points || 0) + ' Punkte'])
        ])
      ]);
    }));
  }

  /* ---------------- Chat ---------------- */
  function buildChat() {
    var log = el('div', { class: 'tc-log' });
    var input = el('input', { class: 'text-input', type: 'text', maxlength: 160, placeholder: 'Nachricht an alle …' });
    var send = el('button', { class: 'btn btn-primary', type: 'button' }, ['Senden']);

    function submit() {
      var t = (input.value || '').trim();
      if (!t) return;
      input.value = '';
      T.chatSend(t);
    }
    send.addEventListener('click', submit);
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') submit(); });

    function refresh() {
      var msgs = T.chatList();
      var atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
      log.innerHTML = '';
      if (!msgs.length) log.appendChild(el('div', { class: 'tc-msg', style: 'opacity:.5;' }, ['Noch keine Nachrichten.']));
      msgs.forEach(function (m) {
        log.appendChild(el('div', { class: 'tc-msg' + (m.admin ? ' tc-admin' : '') }, [
          el('b', {}, [(m.avatar || '') + ' ' + (m.name || 'Spieler') + ': ']),
          document.createTextNode(m.text || '')
        ]));
      });
      if (atBottom) log.scrollTop = log.scrollHeight;
    }
    refresh();

    return {
      root: el('div', { class: 'tc-wrap' }, [
        el('h3', { style: 'margin:0;' }, ['💬 Turnier-Chat']),
        log,
        el('div', { class: 'tc-row' }, [input, send])
      ]),
      refresh: refresh
    };
  }

  /* ---------------- Wartebereich ---------------- */
  function viewQueue(root) {
    var cfg = T.config();
    var clock = el('div', { class: 'tq-clock' }, ['--:--']);
    var grid = el('div', {});
    var actions = el('div', { class: 'admin-row-actions', style: 'margin:10px 0;' });
    var chat = cfg.chat ? buildChat() : null;
    var hint = el('p', { class: 'lb-hint' }, ['']);

    function drawActions() {
      actions.innerHTML = '';
      var inQ = T.amIn();
      if (T.isBanned()) {
        actions.appendChild(el('span', { class: 'cf-status lose' }, ['🚫 Du bist für den Turniermodus gesperrt.']));
        return;
      }
      if (inQ) {
        actions.appendChild(el('span', { class: 'cf-status win' }, ['✅ Du bist angemeldet']));
        actions.appendChild(el('button', {
          class: 'btn btn-ghost', type: 'button',
          onclick: function () { T.leave().then(function () { UI.toast('Abgemeldet.', 'info'); drawActions(); }); }
        }, ['Doch nicht mitmachen']));
      } else {
        actions.appendChild(el('button', {
          class: 'btn btn-primary btn-lg', type: 'button',
          onclick: function () {
            T.join().then(function () {
              UI.toast('🏆 Du bist im Turnier!', 'win');
              drawActions();
            }).catch(function (e) { UI.toast(e.message, 'lose'); });
          }
        }, ['🏆 Am Turnier teilnehmen']));
      }
      actions.appendChild(el('span', { class: 'cf-info-l' }, [
        'Einsatz: ' + (cfg.ticketCost ? App.Tickets.label(cfg.ticketCost) : 'gratis') +
        ' · Du hast: ' + App.Tickets.label()
      ]));
    }

    /* Zum Hosten muss man auch dann kommen, wenn gerade ein Turnier im
     * Wartebereich steht — sonst wäre der Weg ausgerechnet immer dann versperrt,
     * wenn überhaupt eins angesetzt ist. */
    var H = App.TournamentHost;
    var sched = App.TournamentHostUI.scheduleList();
    var hostPanel = el('div', { class: 'glass', style: 'padding:16px;margin-top:14px;' }, [
      el('h3', { style: 'margin-top:0;' }, ['🗓 Weitere Turniere']),
      sched.root,
      el('div', { class: 'admin-row-actions', style: 'margin-top:10px;' }, [
        el('button', {
          class: 'btn btn-primary', type: 'button',
          onclick: function () { App.Router.go('/tournament/host'); }
        }, ['🏆 Eigenes Turnier hosten']),
        el('span', { class: 'cf-info-l' }, ['Dein Einsatz wird zum Preisgeld — ab ' + UI.formatShort(H.minFee()) + ' Coins.'])
      ])
    ]);

    var schedDraw = Date.now();
    function refresh() {
      var ms = T.untilStart();
      clock.textContent = ms > 0 ? fmtClock(ms) : 'Startet …';
      grid.innerHTML = '';
      grid.appendChild(playerTiles());
      var n = T.players().length;
      hint.textContent = n === 0
        ? 'Noch niemand angemeldet — sei der Erste.'
        : (n + ' Spieler' + (n === 1 ? '' : '') + ' in der Queue. Die Tickets werden erst abgebucht, wenn es losgeht.');
      if (chat) chat.refresh();
      // Der Zeitplan baut seine Zeilen neu — nicht im 500ms-Takt (Flackern).
      if (Date.now() - schedDraw > 4000) { schedDraw = Date.now(); sched.refresh(); }
    }

    var plan = el('div', { class: 'tq-plan' }, (cfg.rounds || []).map(function (gid, i) {
      return el('span', { class: 'tq-chip' }, [(i + 1) + '. ' + gameTitle(gid) + ' · ' + secFor(cfg, i) + 's']);
    }));

    root.appendChild(el('div', { class: 'page-head' }, [
      el('button', { class: 'btn btn-ghost back', type: 'button', onclick: function () { App.Router.go('/'); } }, ['← Zurück']),
      el('h2', { class: 'page-title neon' }, ['🏆 ' + (cfg.title || 'Turnier')]),
      cfg.hostName ? el('span', { class: 'cf-info-l' }, ['Gehostet von ' + cfg.hostName]) : null
    ].filter(Boolean)));
    root.appendChild(el('div', { class: 'glass', style: 'padding:16px;' }, [
      el('div', { class: 'tq-head' }, [
        el('div', {}, [
          el('div', { class: 'cf-info-l' }, ['Start in']),
          clock
        ]),
        el('div', {}, [
          el('div', { class: 'cf-info-l' }, [cfg.prizeKind === 'money' ? 'Preisgeld' : 'Preis für den Sieger']),
          el('div', { style: 'font-weight:800;color:#ffc740;' }, [App.TournamentHost.prizeLabel(cfg)]),
          cfg.prizeKind === 'money'
            ? el('div', { class: 'cf-info-l' }, [App.TournamentHost.shareLines(cfg.pot).map(function (s) {
                return ['🥇', '🥈', '🥉'][s.place - 1] + ' ' + UI.formatShort(s.amount);
              }).join(' · ')])
            : null
        ].filter(Boolean)),
        el('div', {}, [
          el('div', { class: 'cf-info-l' }, ['Ablauf']),
          el('div', { style: 'font-weight:700;' }, [roundsSummary(cfg)])
        ])
      ]),
      plan,
      actions,
      hint
    ]));
    root.appendChild(grid);
    root.appendChild(hostPanel);
    if (chat) root.appendChild(chat.root);

    drawActions();
    refresh();
    return { refresh: refresh };
  }

  /* ---------------- Countdown vor der Runde ---------------- */
  function viewCountdown(root) {
    var cfg = T.config(), idx = T.round();
    var num = el('div', { class: 'tcd-num' }, ['3']);
    var beeped = {};

    function refresh() {
      var left = Math.max(0, T.deadline() - Date.now());
      var s = Math.ceil(left / 1000) || 1;
      if (num.textContent !== String(s)) {
        num.textContent = String(s);
        if (!beeped[s] && App.Audio && App.Audio.blip) { beeped[s] = 1; App.Audio.blip(s === 1 ? 880 : 520, 0.12); }
      }
    }

    root.appendChild(el('div', { class: 'page-head' }, [
      el('h2', { class: 'page-title neon' }, ['Runde ' + (idx + 1) + ' von ' + cfg.rounds.length])
    ]));
    root.appendChild(el('div', { class: 'glass tcd' }, [
      el('div', { class: 'tcd-game' }, [gameTitle(cfg.rounds[idx])]),
      num,
      el('div', { class: 'cf-info-l' }, ['Gleich geht es los …'])
    ]));
    root.appendChild(el('h3', { style: 'margin:8px 0;' }, ['Diese Spieler sind dabei']));
    root.appendChild(playerTiles());

    refresh();
    return { refresh: refresh };
  }

  /* ---------------- Zuschauermodus (Runde) ---------------- */
  /* Wie ein einzelner Spielstand angezeigt wird, hängt von der Spielart ab. */
  function specValue(kind, gameId, score) {
    if (kind === 'gamble') return { text: (score >= 0 ? '+' : '') + UI.formatCoins(score || 0), win: false, sub: 'Coins in dieser Runde' };
    if (T.isWinBased(kind)) return (score >= 1)
      ? { text: '🏆', win: true, sub: 'hat gewonnen' }
      : { text: '⏳', win: false, sub: 'spielt noch' };
    return { text: String(score || 0), win: false, sub: T.lowerIsBetter(gameId) ? 'niedriger ist besser' : 'Punkte' };
  }

  function spectatorRound(root, stage, refreshTime, gameId, kind, idx) {
    var isAdm = T.isAdminHere();
    var lower = T.lowerIsBetter(gameId);
    var focusPid = null;

    // Kopfzeile: „LIVE"-Anzeige + (nur Admin) Weiter-Knopf.
    var head = el('div', { class: 'tsp-head' }, [
      el('span', { class: 'tsp-live' }, [el('span', { class: 'tsp-dot' }), 'LIVE']),
      el('span', { class: 'cf-info-l' }, ['👁 Zuschauermodus — tippe einen Spieler an, um ihm zuzuschauen.'])
    ]);
    if (isAdm) {
      head.appendChild(el('button', {
        class: 'btn btn-primary', type: 'button', style: 'margin-left:auto;',
        title: 'Runde sofort werten und weiter',
        onclick: function () {
          T.Admin.forceNext().then(function () { UI.toast('⏭ Weiter …', 'info'); });
        }
      }, ['⏭ Runde beenden']));
    }
    stage.appendChild(head);

    var grid = el('div', { class: 'tsp-grid' });
    var focusHost = el('div', {});
    stage.appendChild(grid);
    stage.appendChild(focusHost);

    // pid -> Turnierpunkte + Online-Status aus der Gesamt-Rangliste
    function metaByPid() {
      var m = {};
      T.players().forEach(function (p) { m[p.pid] = p; });
      return m;
    }

    function rows() {
      var rp = T.roundPlayers(idx);
      var meta = metaByPid();
      // Falls die g-Knoten noch leer sind (Runde eben erst gestartet), wenigstens
      // die Teilnehmer aus der Spielerliste zeigen.
      if (!rp.length) {
        rp = T.players().map(function (p) { return { pid: p.pid, name: p.name, avatar: p.avatar, score: 0, state: null, lastSeen: p.lastSeen }; });
      }
      rp.forEach(function (r) {
        var pm = meta[r.pid];
        r.points = pm ? (pm.points || 0) : 0;
        r.online = pm ? ((Date.now() - (pm.lastSeen || r.lastSeen || 0)) < 16000) : ((Date.now() - (r.lastSeen || 0)) < 16000);
      });
      // Sortierung: Sieger/Beste zuerst.
      rp.sort(function (a, b) {
        if (T.isWinBased(kind)) return (b.score || 0) - (a.score || 0) || a.name.localeCompare(b.name);
        var as = a.score || 0, bs = b.score || 0;
        // „niedriger ist besser": 0 heißt noch nicht gespielt -> nach hinten
        if (lower) {
          var ap = as > 0, bp = bs > 0;
          if (ap !== bp) return ap ? -1 : 1;
          return as - bs;
        }
        return bs - as;
      });
      return rp;
    }

    function drawFocus(r) {
      focusHost.innerHTML = '';
      if (!r) return;
      var v = specValue(kind, gameId, r.score);
      var rankList = rows();
      var place = rankList.findIndex(function (x) { return x.pid === r.pid; }) + 1;

      var meta = [
        el('span', {}, ['Turnierpunkte: ', el('b', {}, [String(r.points || 0)])]),
        el('span', {}, ['Platz in dieser Runde: ', el('b', {}, ['#' + place])]),
        el('span', {}, [r.online ? '🟢 online' : '⚪ nicht mehr da'])
      ];
      // Bei Duellen: Gegner im selben Paar-Zweig zeigen.
      if (kind === 'duel') {
        var opp = T.roundPlayers(idx).filter(function (x) { return x.roundKey === r.roundKey && x.pid !== r.pid; })[0];
        meta.push(el('span', {}, ['Gegner: ', el('b', {}, [opp ? (opp.avatar + ' ' + opp.name) : 'Freilos']) ]));
      }

      var focus = el('div', { class: 'tsp-focus' }, [
        el('button', { class: 'btn btn-ghost tsp-close', type: 'button', onclick: function () { focusPid = null; render(); } }, ['✕ Übersicht']),
        el('div', { class: 'tsp-focus-top' }, [
          el('span', { class: 'tsp-focus-ava' }, [r.avatar || '🐒']),
          el('div', {}, [
            el('div', { class: 'tsp-focus-name' }, [r.name]),
            el('div', { class: 'tsp-focus-big' + (v.win ? ' win' : '') }, [v.text]),
            el('div', { class: 'cf-info-l' }, [v.sub])
          ])
        ]),
        el('div', { class: 'tsp-focus-meta' }, meta)
      ]);

      // Falls das Spiel einen strukturierten Live-Status meldet, roh anzeigen —
      // manche Spiele tun das (reportState), viele nicht.
      if (r.state && typeof r.state === 'object') {
        var txt = '';
        try { txt = JSON.stringify(r.state); } catch (e) { txt = ''; }
        if (txt && txt !== '{}' && txt.length < 400) {
          focus.appendChild(el('div', { class: 'tsp-state' }, ['Live-Status: ' + txt]));
        }
      }
      focusHost.appendChild(focus);
    }

    function drawGrid() {
      var rp = rows();
      grid.innerHTML = '';
      if (!rp.length) {
        grid.appendChild(el('p', { class: 'lb-hint' }, ['Noch keine Spieler in dieser Runde.']));
        return;
      }
      rp.forEach(function (r, i) {
        var v = specValue(kind, gameId, r.score);
        grid.appendChild(el('div', {
          class: 'tsp-card' + (r.pid === focusPid ? ' focus' : '') + (r.online ? '' : ' off'),
          onclick: function () { focusPid = (focusPid === r.pid ? null : r.pid); render(); }
        }, [
          el('span', { class: 'tsp-rank' }, ['#' + (i + 1)]),
          el('span', { class: 'tsp-eye' }, ['👁']),
          el('div', { class: 'tsp-ava' }, [r.avatar || '🐒']),
          el('div', { class: 'tsp-name' }, [r.name]),
          el('div', { class: 'tsp-val' + (v.win ? ' win' : '') }, [v.text]),
          el('div', { class: 'tsp-sub' }, [(r.points || 0) + ' Turnierpunkte'])
        ]));
      });
    }

    function render() {
      drawGrid();
      var r = focusPid ? rows().filter(function (x) { return x.pid === focusPid; })[0] : null;
      drawFocus(r);
    }

    render();
    return {
      refresh: function () { refreshTime(); render(); },
      cleanup: function () {}
    };
  }

  /* ---------------- Die Runde selbst ---------------- */
  function viewRound(root) {
    var cfg = T.config(), idx = T.round();
    var gameId = cfg.rounds[idx];
    var kind = T.kindOf(gameId);
    var timeEl = el('span', { class: 'tr-time' }, ['--']);
    var stage = el('div', { class: 'tr-stage' });
    var inner = null;      // { cleanup } des laufenden Spiels
    var coinOff = null, coinStart = 0, gRoom = null;

    root.appendChild(el('div', { class: 'tr-bar' }, [
      el('span', {}, [el('b', {}, ['Runde ' + (idx + 1) + '/' + cfg.rounds.length]), ' · ', gameTitle(gameId)]),
      el('span', {}, ['⏱ ', timeEl])
    ]));
    root.appendChild(stage);

    function refresh() {
      var left = Math.max(0, T.deadline() - Date.now());
      // Steht die Uhr auf 0, ohne dass es weitergeht, ist gerade niemand da,
      // der die Runde beenden könnte (siehe Taktgeber in js/tournament.js).
      // Das ehrlich anzeigen statt stumm 0:00 — tick() räumt dann selbst auf.
      if (left <= 0 && !T.hostPid()) {
        timeEl.textContent = 'wartet …';
        timeEl.classList.remove('low');
        timeEl.title = 'Gerade ist niemand da, der die Runde weiterschaltet. Das Turnier wird gleich abgeschlossen.';
        return;
      }
      timeEl.textContent = fmtClock(left);
      timeEl.classList.toggle('low', left < 10000);
    }

    /* Zuschauermodus: wer nicht mitspielt (Admin oder ein nicht angemeldeter
     * Besucher) sieht jeden Spieler live — Punktestand der laufenden Runde,
     * Turnierpunkte, Online-Status. Ein Klick auf einen Spieler öffnet die
     * Fokus-Ansicht, in der man ihm „zuschaut". Admins haben zusätzlich einen
     * Weiter-Knopf. */
    if (!T.amIn()) {
      return spectatorRound(root, stage, refresh, gameId, kind, idx);
    }

    if (kind === 'gamble') {
      /* Gambling-Runde: jeder spielt für sich sein Spiel; gewertet wird, wie
       * viele Coins in der Rundenzeit dazukommen. Das Spiel selbst bleibt
       * unverändert — wir hören nur am Guthaben mit. */
      var g = App.Games[gameId];
      coinStart = App.Coins.get();
      var gainEl = el('span', { class: 'ts-gain' }, ['+0']);
      stage.appendChild(el('div', { class: 'tr-bar' }, [
        el('span', { class: 'cf-info-l' }, ['Gewertet wird dein Coin-Gewinn in dieser Runde:']),
        gainEl
      ]));
      var host = el('div', {});
      stage.appendChild(host);
      inner = g.render(host) || {};
      var report = function () {
        var delta = App.Coins.get() - coinStart;
        gainEl.textContent = (delta >= 0 ? '+' : '') + UI.formatCoins(delta);
        if (gRoom) gRoom.reportScore(delta);
      };
      coinOff = App.Coins.onChange(report);
      T.roundRoom(idx).then(function (r) { gRoom = r.room; report(); });

    } else {
      /* Alle anderen Spielarten laufen als ganz normales Multiplayer-Spiel —
       * nur dass der Raum aus dem Turnier kommt (siehe roundRoom). */
      var loading = el('p', { class: 'lb-hint' }, ['Runde wird vorbereitet …']);
      stage.appendChild(loading);
      T.roundRoom(idx).then(function (r) {
        if (loading.parentNode) loading.parentNode.removeChild(loading);
        gRoom = r.room;
        var def = App.Minigames[gameId];
        var host2 = el('div', {});
        stage.appendChild(host2);

        /* Duelle, Poker/Casino-Tische und Koop melden keinen Punktestand,
         * sondern tragen bei einem Sieg in ihre Bestenliste ein
         * (App.Scores.winCurrent, siehe js/scores.js). Für die Rundenwertung
         * hängen wir uns genau dort ein: wer gewinnt, meldet eine 1. */
        var restoreWin = null;
        if (T.isWinBased(kind)) {
          var orig = App.Scores.winCurrent;
          App.Scores.winCurrent = function () {
            try { if (gRoom) gRoom.reportScore(1); } catch (e) {}
            return orig.apply(App.Scores, arguments);
          };
          restoreWin = function () { App.Scores.winCurrent = orig; };
        }

        var ctx = {
          mode: 'multi',
          room: gRoom,
          me: { id: T.myPid(), name: T.myName() },
          players: gRoom.players(),
          isHost: gRoom.isHost(),
          tournament: true,
          onExit: function () { /* im Turnier führt kein Weg raus — die Uhr entscheidet */ }
        };
        var res = def.render(host2, ctx) || {};
        inner = {
          cleanup: function () {
            if (restoreWin) restoreWin();
            if (res.cleanup) { try { res.cleanup(); } catch (e) {} }
          }
        };
      }).catch(function (e) {
        stage.appendChild(el('p', { class: 'err' }, ['Runde konnte nicht gestartet werden: ' + e.message]));
      });
    }

    refresh();
    return {
      refresh: refresh,
      cleanup: function () {
        if (coinOff) coinOff();
        if (inner && inner.cleanup) { try { inner.cleanup(); } catch (e) {} }
        if (gRoom) gRoom.leave();
      }
    };
  }

  /* ---------------- Zwischenstand ---------------- */
  function viewResult(root) {
    var cfg = T.config(), idx = T.round();
    var live = T.live() || {};
    var scores = (live.scores && live.scores[idx]) || {};
    var me = T.myPid();
    var bar = el('div', { class: 'tq-clock', style: 'font-size:22px;' }, ['']);

    root.appendChild(el('div', { class: 'page-head' }, [
      el('h2', { class: 'page-title neon' }, ['Runde ' + (idx + 1) + ' vorbei'])
    ]));
    root.appendChild(el('p', { class: 'lb-hint' }, [gameTitle(cfg.rounds[idx]) + ' · Zwischenstand']));

    var list = el('div', { style: 'display:flex;flex-direction:column;gap:8px;' });
    T.ranking().forEach(function (p, i) {
      var s = scores[p.pid];
      list.appendChild(el('div', { class: 'ts-row' + (p.pid === me ? ' me' : '') }, [
        el('span', { class: 'ts-place' }, [i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : '#' + (i + 1)]),
        el('span', { class: 'tq-ava' }, [p.avatar || '🐒']),
        el('span', {}, [p.name + (p.pid === me ? ' (du)' : '')]),
        el('span', { class: 'ts-gain' }, [typeof s === 'number' ? ('Runde: ' + UI.formatCoins(s)) : '—']),
        el('span', { class: 'ts-pts' }, [(p.points || 0) + ' P'])
      ]));
    });
    root.appendChild(list);
    root.appendChild(el('p', { class: 'lb-hint' }, [bar]));

    // Admin kann den Zwischenstand überspringen und sofort weiterschalten.
    if (T.isAdminHere()) {
      var nextName = (idx + 1 >= cfg.rounds.length) ? 'zur Siegerehrung' : ('zu Runde ' + (idx + 2));
      root.appendChild(el('div', { class: 'admin-row-actions', style: 'margin-top:10px;' }, [
        el('button', {
          class: 'btn btn-primary', type: 'button',
          onclick: function () { T.Admin.forceNext().then(function () { UI.toast('⏭ Weiter …', 'info'); }); }
        }, ['⏭ Weiter ' + nextName])
      ]));
    }

    function refresh() {
      var left = Math.max(0, T.deadline() - Date.now());
      var next = idx + 1;
      bar.textContent = next >= cfg.rounds.length
        ? 'Siegerehrung in ' + Math.ceil(left / 1000) + 's …'
        : 'Nächste Runde (' + gameTitle(cfg.rounds[next]) + ') in ' + Math.ceil(left / 1000) + 's …';
    }
    refresh();
    return { refresh: refresh };
  }

  /* ---------------- Siegerehrung ---------------- */
  function viewDone(root) {
    var live = T.live() || {};
    var w = live.winner;
    var me = T.myPid();
    var iWon = w && w.pid === me;

    if (!w) {
      root.appendChild(el('p', { class: 'lb-empty' }, ['Kein Ergebnis.']));
      return { refresh: function () {} };
    }

    var cfg = T.config() || {};
    var isMoney = cfg.prizeKind === 'money';
    var payouts = live.payouts || {};
    var prizeText = isMoney
      ? ('💰 ' + UI.formatShort((payouts[w.pid] && payouts[w.pid].amount) || w.money || 0) + ' Coins')
      : ('⚡ ' + App.Powerups.describe(w.prize));
    // Die Ehrung muss auch dann stehen, wenn beim Einlösen etwas schiefgeht.
    // Preisgeld wird hier NICHT eingelöst: es liegt schon im Postfach und wird
    // gutgeschrieben, sobald der Gewinner die Seite offen hat — auch wenn er
    // beim Werten längst weg war (siehe js/tournament-host.js).
    var claimed = null;
    if (iWon && !isMoney) {
      try { claimed = T.claimPrizeIfWinner(); }
      catch (e) { UI.toast('Preis konnte nicht gutgeschrieben werden: ' + e.message, 'lose'); }
    }
    var myPay = payouts[me] ? payouts[me].amount : 0;

    var stage = el('div', { class: 'glass tv-stage' });

    // Rotierende Lichtstrahlen hinter allem
    for (var r = 0; r < 6; r++) {
      stage.appendChild(el('div', {
        class: 'tv-ray',
        style: 'transform:rotate(' + (r * 60) + 'deg);animation-delay:' + (-r * 1.5) + 's;'
      }));
    }
    // Goldene Flammen von unten
    for (var f = 0; f < 26; f++) {
      stage.appendChild(el('div', {
        class: 'tv-flame',
        style: 'left:' + (Math.random() * 100) + '%;animation-duration:' + (1.6 + Math.random() * 1.8) + 's;' +
          'animation-delay:' + (Math.random() * 2) + 's;width:' + (8 + Math.random() * 16) + 'px;' +
          'height:' + (8 + Math.random() * 16) + 'px;'
      }));
    }
    // Funkenregen von oben
    var sparks = ['✨', '⭐', '🌟', '💫', '🔥'];
    for (var s2 = 0; s2 < 22; s2++) {
      stage.appendChild(el('div', {
        class: 'tv-spark',
        style: 'left:' + (Math.random() * 100) + '%;animation-duration:' + (2.4 + Math.random() * 2.6) + 's;' +
          'animation-delay:' + (Math.random() * 3) + 's;font-size:' + (12 + Math.random() * 14) + 'px;'
      }, [sparks[Math.floor(Math.random() * sparks.length)]]));
    }

    stage.appendChild(el('div', { class: 'tv-crown' }, ['👑']));
    stage.appendChild(el('div', { class: 'tv-sub' }, ['Turniersieger']));
    stage.appendChild(el('div', { class: 'tv-name' }, [(w.avatar || '') + ' ' + w.name]));
    stage.appendChild(el('div', { class: 'tv-sub' }, [w.points + ' Punkte · ' + (T.config() ? T.config().title : 'Turnier')]));
    stage.appendChild(el('div', { class: 'tv-prize' }, [prizeText]));
    if (iWon) {
      stage.appendChild(el('div', { class: 'tv-sub', style: 'margin-top:12px;font-weight:800;color:#ffe9a3;' }, [
        isMoney ? '🎉 Das Preisgeld ist auf deinem Konto!'
          : (claimed ? '🎉 Power-Up in deiner Sammlung — oben auf ⚡ tippen zum Benutzen!' : '🎉 Glückwunsch!')
      ]));
    } else if (isMoney && myPay > 0) {
      // Auch Platz 2 und 3 bekommen Geld — das darf die Ehrung nicht verschlucken.
      stage.appendChild(el('div', { class: 'tv-sub', style: 'margin-top:12px;font-weight:800;color:#ffe9a3;' }, [
        '💰 Dein Preisgeld: ' + UI.formatShort(myPay) + ' Coins'
      ]));
    }

    root.appendChild(el('div', { class: 'page-head' }, [
      el('button', { class: 'btn btn-ghost back', type: 'button', onclick: function () { App.Router.go('/'); } }, ['← Zurück']),
      el('h2', { class: 'page-title neon' }, ['🏆 Siegerehrung'])
    ]));
    root.appendChild(stage);

    if (!iWon) {
      var mine = T.ranking().filter(function (p) { return p.pid === me; })[0];
      var place = T.ranking().findIndex(function (p) { return p.pid === me; }) + 1;
      if (mine) {
        root.appendChild(el('p', { class: 'tv-loser', style: 'text-align:center;' }, [
          'Du wurdest ' + place + '. mit ' + mine.points + ' Punkten.'
        ]));
      }
    }

    var list = el('div', { style: 'display:flex;flex-direction:column;gap:8px;margin-top:14px;' });
    T.ranking().forEach(function (p, i) {
      var pay = payouts[p.pid] ? payouts[p.pid].amount : 0;
      list.appendChild(el('div', { class: 'ts-row' + (p.pid === me ? ' me' : '') }, [
        el('span', { class: 'ts-place' }, [i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : '#' + (i + 1)]),
        el('span', { class: 'tq-ava' }, [p.avatar || '🐒']),
        el('span', {}, [p.name]),
        pay > 0 ? el('span', { class: 'ts-gain' }, ['💰 ' + UI.formatShort(pay)]) : null,
        el('span', { class: 'ts-pts' }, [(p.points || 0) + ' P'])
      ].filter(Boolean)));
    });
    root.appendChild(el('h3', { style: 'margin-top:14px;' }, ['Endstand']));
    root.appendChild(list);

    // Gefeiert wird auch für Platz 2 und 3 — die bekommen ebenfalls Geld.
    var celebrate = iWon || myPay > 0;
    if (celebrate && App.Audio && App.Audio.jackpot) { try { App.Audio.jackpot(); } catch (e) {} }
    if (App.Progress && App.Progress.confetti && celebrate) { try { App.Progress.confetti(); } catch (e) {} }

    return { refresh: function () {} };
  }

  /* ---------------- Seite ---------------- */
  function renderPage(root) {
    T = App.Tournament;
    injectCss();

    var cur = null, curKey = null, timer = null, offLive = null;

    function build() {
      var cfg = T.config();
      var phase = T.phase() || 'queue';
      var key;

      if (!cfg || cfg.status !== 'open') {
        // Ein beendetes Turnier zeigt noch seine Siegerehrung, danach ist Ruhe.
        key = (phase === 'done') ? 'done' : 'none';
      } else {
        key = phase + ':' + T.round();
      }
      if (key === curKey) { if (cur && cur.refresh) cur.refresh(); return; }

      if (cur && cur.cleanup) { try { cur.cleanup(); } catch (e) {} }
      curKey = key;
      root.innerHTML = '';

      if (key === 'none') {
        /* Kein Turnier im Slot — hier steht der Zeitplan: Angesetztes rückt
         * automatisch nach, sobald seine Startzeit nah genug ist (siehe
         * js/tournament-host.js). Und von hier aus hostet man selbst eins. */
        var H = App.TournamentHost;
        var sched = App.TournamentHostUI.scheduleList();
        var upcoming = H.upcoming();

        root.appendChild(el('div', { class: 'page-head' }, [
          el('button', { class: 'btn btn-ghost back', type: 'button', onclick: function () { App.Router.go('/'); } }, ['← Zurück']),
          el('h2', { class: 'page-title neon' }, ['🏆 Turnier'])
        ]));

        var cd = H.cooldownLeft();
        var hostBtn = el('button', {
          class: 'btn btn-primary btn-lg', type: 'button',
          onclick: function () { App.Router.go('/tournament/host'); }
        }, ['🏆 Eigenes Turnier hosten']);

        root.appendChild(el('div', { class: 'glass', style: 'padding:24px;text-align:center;' }, [
          el('div', { style: 'font-size:44px;' }, ['🏆']),
          el('h3', {}, [upcoming.length
            ? ('Gleich geht es los — ' + upcoming.length + ' Turnier' + (upcoming.length === 1 ? '' : 'e') + ' angesetzt')
            : 'Gerade läuft kein Turnier']),
          el('p', { class: 'lb-hint' }, [
            'Jeder kann selbst eins hosten: Du bestimmst Uhrzeit, Spiele und Rundenzeiten. ' +
            'Dein Einsatz wird zum Preisgeld — 50 % für Platz 1, 30 % für Platz 2, 20 % für Platz 3. ' +
            'Mindestens ' + UI.formatShort(H.minFee()) + ' Coins.'
          ]),
          hostBtn,
          cd > 0 ? el('p', { class: 'lb-hint' }, ['⏳ Du kannst in ' + H.fmtLeft(cd) + ' wieder eins hosten.']) : null,
          el('p', { class: 'lb-hint' }, ['Deine Tickets: ' + App.Tickets.label() + ' 🎟️ (gibt es für abgeschlossene Quests)']),
          el('button', { class: 'btn btn-ghost', type: 'button', onclick: function () { App.Router.go('/quests'); } }, ['⭐ Zu den Quests'])
        ].filter(Boolean)));

        root.appendChild(el('div', { class: 'glass', style: 'padding:16px;' }, [
          el('h3', { style: 'margin-top:0;' }, ['🗓 Zeitplan']),
          el('p', { class: 'lb-hint' }, [
            'Der Wartebereich öffnet ' + Math.round(H.PRE_OPEN_MS / 60000) + ' Minuten vor dem Start. ' +
            'Zwischen zwei Turnieren liegen mindestens ' + Math.round(H.MIN_GAP_MS / 60000) + ' Minuten.'
          ]),
          sched.root
        ]));
        // Der Zeitplan baut seine Zeilen neu auf — nicht im 500ms-Takt der
        // Seite, sonst flackert er und der Absagen-Knopf rutscht unter dem
        // Finger weg.
        var lastDraw = Date.now();
        cur = {
          refresh: function () {
            var now = Date.now();
            if (now - lastDraw < 4000) return;
            lastDraw = now;
            sched.refresh();
          }
        };
        return;
      }

      var phaseOnly = key.split(':')[0];
      if (phaseOnly === 'queue') cur = viewQueue(root);
      else if (phaseOnly === 'countdown') cur = viewCountdown(root);
      else if (phaseOnly === 'round') cur = viewRound(root);
      else if (phaseOnly === 'result') cur = viewResult(root);
      else if (phaseOnly === 'done') cur = viewDone(root);
      else cur = { refresh: function () {} };
    }

    T.start();
    build();
    offLive = T.on('live', build);
    T.on('config', build);
    timer = setInterval(function () { if (cur && cur.refresh) cur.refresh(); }, 500);

    return {
      cleanup: function () {
        if (timer) clearInterval(timer);
        if (offLive) offLive();
        if (cur && cur.cleanup) { try { cur.cleanup(); } catch (e) {} }
      }
    };
  }

  App.TournamentUI = { renderPage: renderPage };
})();
