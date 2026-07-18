/* wager-ui.js — Oberfläche für die 1v1-Wetten (App.WagerUI, Route /wager).
 *
 * Seite: Liste der Online-Gegner + „Herausfordern", eigene offene Herausforderungen,
 * eingehende Anfragen (annehmen/ablehnen). Ein globales Popup meldet eine Anfrage
 * auch, wenn man gerade woanders ist.
 *
 * Kampf-Ansicht: 5s-Countdown -> je Runde läuft das gewählte Minispiel für die
 * gewählte Zeit, danach wertet der HOST (App.Wager.roundWinner) und schaltet die
 * nächste Runde bzw. das Kampf-Ende. Der Nicht-Host folgt dem Match-Datensatz.
 */
(function () {
  'use strict';
  window.App = window.App || {};
  var UI = App.UI, el = UI.el;

  function injectCss() {
    UI.injectStyle('wager-css', [
      '.wg-sec{padding:16px;margin-bottom:14px;}',
      '.wg-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:9px 12px;border-radius:10px;background:rgba(2,10,6,.5);border:1px solid var(--stroke);margin-bottom:7px;}',
      '.wg-row .wg-nm{font-weight:800;}',
      '.wg-row .wg-meta{font-size:12px;opacity:.7;}',
      '.wg-row .wg-act{margin-left:auto;display:flex;gap:6px;flex-wrap:wrap;}',
      '.wg-dot{width:9px;height:9px;border-radius:50%;background:var(--neon);box-shadow:0 0 8px var(--neon);flex:0 0 auto;}',
      '.wg-empty{opacity:.6;font-size:13px;padding:10px 4px;}',
      '.wg-form .ta-grid,.wg-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px;}',
      '.wg-field{display:flex;flex-direction:column;gap:4px;}',
      '.wg-field label{font-size:12px;opacity:.75;}',
      '.wg-match{max-width:700px;margin:0 auto;}',
      '.wg-scorebar{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 16px;border-radius:12px;background:rgba(2,10,6,.6);border:1px solid var(--stroke);margin-bottom:12px;}',
      '.wg-side{text-align:center;flex:1 1 0;min-width:0;}',
      '.wg-side .wg-w{font-size:30px;font-weight:900;color:var(--neon);}',
      '.wg-side.b .wg-w{color:var(--aqua);}',
      '.wg-vs{font-size:13px;opacity:.6;}',
      '.wg-pot{text-align:center;color:#ffc740;font-weight:800;margin-bottom:10px;}',
      '.wg-count{text-align:center;font-size:64px;font-weight:900;color:var(--neon);padding:40px 0;}',
      '.wg-play{min-height:200px;}',
      '.wg-big{font-size:22px;font-weight:900;text-align:center;margin:8px 0;}',
      '.wg-badge{display:inline-block;font-size:11px;padding:2px 8px;border-radius:8px;background:rgba(57,255,20,.15);border:1px solid var(--stroke);}'
    ].join(''));
  }

  function gameTitle(id) { var g = App.Minigames && App.Minigames[id]; return g ? (g.icon + ' ' + g.title) : id; }
  function loggedIn() { return App.Account && App.Account.isLoggedIn && App.Account.isLoggedIn(); }

  /* ============================ Übersichtsseite ============================ */
  function renderPage(root) {
    injectCss();
    var W = App.Wager;

    root.appendChild(el('div', { class: 'page-head' }, [
      el('button', { class: 'btn btn-ghost back', type: 'button', onclick: function () { App.Router.go('/'); } }, ['← Menü']),
      el('h2', { class: 'page-title neon' }, ['⚔️ Wagern'])
    ]));
    root.appendChild(el('p', { class: 'lb-hint' }, [
      'Fordere einen Online-Spieler heraus: Ihr setzt beide Coins, spielt das gewählte Spiel, der Gewinner bekommt den ganzen Pot. Runden und Zeit bestimmst du beim Herausfordern.'
    ]));

    // Admin: welche Spiele für Wetten erlaubt sind
    if (App.Admin && App.Admin.isAdmin && App.Admin.isAdmin()) {
      var adminBox = el('div', {});
      root.appendChild(el('div', { class: 'glass wg-sec' }, [
        el('h3', { style: 'margin-top:0;' }, ['⚙️ Wett-Spiele freigeben (Admin)']),
        el('p', { class: 'lb-hint' }, ['Nur die hier angehakten Spiele können in einer Wette gespielt werden. Am besten Spiele mit klarer Punktzahl (Reaktion, Rechnen, Geschick).']),
        adminBox
      ]));
      drawAdmin(adminBox);
    }

    var incBox = el('div', {});
    var listBox = el('div', {});
    root.appendChild(el('div', { class: 'glass wg-sec' }, [el('h3', { style: 'margin-top:0;' }, ['📨 Anfragen an dich']), incBox]));
    root.appendChild(el('div', { class: 'glass wg-sec' }, [el('h3', { style: 'margin-top:0;' }, ['🎯 Gegner herausfordern']), listBox]));

    function drawIncoming() {
      W.incoming().then(function (arr) {
        incBox.innerHTML = '';
        if (!arr.length) { incBox.appendChild(el('div', { class: 'wg-empty' }, ['Keine offenen Anfragen.'])); return; }
        arr.forEach(function (inv) {
          incBox.appendChild(el('div', { class: 'wg-row' }, [
            el('div', {}, [
              el('div', { class: 'wg-nm' }, ['⚔️ ' + inv.fromName]),
              el('div', { class: 'wg-meta' }, [gameTitle(inv.game) + ' · ' + inv.rounds + ' Runden · ' + inv.seconds + 's · Einsatz ' + UI.formatShort(inv.stake) + ' 🪙'])
            ]),
            el('div', { class: 'wg-act' }, [
              el('button', { class: 'btn btn-primary', type: 'button', onclick: function () {
                W.accept(inv).then(function (m) { openMatch(m.id); }).catch(function (e) { UI.toast(e.message, 'lose'); });
              } }, ['✅ Annehmen']),
              el('button', { class: 'btn btn-ghost', type: 'button', onclick: function () { W.decline(inv).then(drawIncoming); } }, ['✕'])
            ])
          ]));
        });
      });
    }

    function drawPlayers() {
      Promise.all([W.players(), W.allowedGames()]).then(function (res) {
        var ps = res[0] || [], games = res[1] || [];
        listBox.innerHTML = '';
        if (!loggedIn()) {
          listBox.appendChild(el('div', { class: 'wg-empty' }, ['Melde dich mit einem Konto an, um andere herauszufordern (damit der Pot sicher ankommt).']));
          return;
        }
        if (!games.length) {
          listBox.appendChild(el('div', { class: 'wg-empty' }, ['Der Admin hat noch keine Spiele für Wetten freigegeben.']));
          return;
        }
        var others = ps.filter(function (p) { return p.pid !== W.myPid(); });
        if (!others.length) { listBox.appendChild(el('div', { class: 'wg-empty' }, ['Gerade ist niemand sonst online. Sobald jemand die Seite offen hat, taucht er hier auf.'])); return; }
        others.forEach(function (p) {
          var online = (Date.now() - (p.lastSeen || 0)) < 16000;
          listBox.appendChild(el('div', { class: 'wg-row' }, [
            online ? el('span', { class: 'wg-dot' }) : el('span', { class: 'wg-dot', style: 'background:#555;box-shadow:none;' }),
            el('div', {}, [el('div', { class: 'wg-nm' }, [p.name]), el('div', { class: 'wg-meta' }, [online ? 'online' : 'gerade weg'])]),
            el('div', { class: 'wg-act' }, [
              el('button', { class: 'btn btn-primary', type: 'button', onclick: function () { openChallenge(p, games); } }, ['⚔️ Herausfordern'])
            ])
          ]));
        });
      });
    }

    drawIncoming(); drawPlayers();
    var timer = setInterval(function () { drawIncoming(); drawPlayers(); }, 6000);
    return { cleanup: function () { clearInterval(timer); } };
  }

  /* Admin: Spiel-Auswahl (Checkboxen). Auswahl liegt in scores/__wager_games. */
  function drawAdmin(box) {
    var W = App.Wager;
    Promise.all([Promise.resolve(W.candidateGames()), W.allowedGames()]).then(function (res) {
      var cands = res[0] || [], allowed = res[1] || [];
      var sel = {}; allowed.forEach(function (id) { sel[id] = true; });
      box.innerHTML = '';
      var grid = el('div', { class: 'wg-grid' });
      cands.forEach(function (c) {
        var cb = el('input', { type: 'checkbox' }); cb.checked = !!sel[c.id];
        cb.addEventListener('change', function () { sel[c.id] = cb.checked; });
        grid.appendChild(el('label', { class: 'wg-row', style: 'cursor:pointer;margin:0;' }, [
          cb, el('span', {}, [c.icon + ' ' + c.title]),
          el('span', { class: 'wg-badge', style: 'margin-left:auto;' }, [c.kind === 'duel' ? 'Duell' : 'Punkte'])
        ]));
      });
      box.appendChild(grid);
      box.appendChild(el('div', { class: 'admin-row-actions', style: 'margin-top:10px;' }, [
        el('button', { class: 'btn btn-primary', type: 'button', onclick: function () {
          var ids = Object.keys(sel).filter(function (k) { return sel[k]; });
          W.setAllowedGames(ids).then(function () { UI.toast('Gespeichert: ' + ids.length + ' Spiele freigegeben.', 'win'); });
        } }, ['💾 Freigabe speichern']),
        el('button', { class: 'btn btn-ghost', type: 'button', onclick: function () {
          // schneller Vorschlag: alle Punkte-Spiele mit 2+ Spielern
          var ids = cands.filter(function (c) { return c.kind !== 'duel'; }).map(function (c) { return c.id; });
          W.setAllowedGames(ids).then(function () { UI.toast(ids.length + ' Punkte-Spiele freigegeben.', 'win'); drawAdmin(box); });
        } }, ['Alle Punkte-Spiele'])
      ]));
    });
  }

  /* ============================ Herausforderungs-Dialog ============================ */
  function openChallenge(player, games) {
    var W = App.Wager;
    var gameSel = el('select', { class: 'text-input' }, games.map(function (id) { return el('option', { value: id }, [gameTitle(id)]); }));
    var roundsSel = el('select', { class: 'text-input' }, ['1', '3', '5', '7'].map(function (n) { return el('option', { value: n }, [n + ' Runde' + (n === '1' ? '' : 'n')]); }));
    roundsSel.value = '3';
    var secSel = el('select', { class: 'text-input' }, ['20', '30', '45', '60', '90', '120'].map(function (n) { return el('option', { value: n }, [n + ' Sekunden']); }));
    secSel.value = '45';
    var stakeIn = el('input', { class: 'text-input', type: 'number', min: 10, value: 100 });

    var overlay = el('div', { class: 'modal-overlay' }, [
      el('div', { class: 'glass modal-card', style: 'max-width:460px;' }, [
        el('h3', { style: 'margin-top:0;' }, ['⚔️ ' + player.name + ' herausfordern']),
        el('div', { class: 'wg-grid', style: 'margin:12px 0;' }, [
          el('div', { class: 'wg-field' }, [el('label', {}, ['Spiel']), gameSel]),
          el('div', { class: 'wg-field' }, [el('label', {}, ['Runden']), roundsSel]),
          el('div', { class: 'wg-field' }, [el('label', {}, ['Zeit pro Runde']), secSel]),
          el('div', { class: 'wg-field' }, [el('label', {}, ['Dein Einsatz (Coins)']), stakeIn])
        ]),
        el('p', { class: 'lb-hint' }, ['Beide setzen denselben Betrag. Sieger bekommt den ganzen Pot. Der Einsatz wird erst abgebucht, wenn der Kampf startet.']),
        el('div', { class: 'admin-row-actions' }, [
          el('button', { class: 'btn btn-primary btn-lg', type: 'button', onclick: function () {
            var stake = Math.max(10, Math.round(Number(stakeIn.value) || 0));
            W.invite(player.pid, player.name, gameSel.value, Number(roundsSel.value), Number(secSel.value), stake)
              .then(function () { close(); UI.toast('Herausforderung an ' + player.name + ' gesendet!', 'win'); })
              .catch(function (e) { UI.toast(e.message, 'lose'); });
          } }, ['⚔️ Herausfordern']),
          el('button', { class: 'btn btn-ghost', type: 'button', onclick: function () { close(); } }, ['Abbrechen'])
        ])
      ])
    ]);
    function close() { if (overlay.parentNode) document.body.removeChild(overlay); }
    document.body.appendChild(overlay);
  }

  /* ============================ Kampf-Ansicht ============================ */
  function openMatch(matchId) {
    App.Router.go('/wager/match/' + matchId);
  }

  function renderMatch(root, matchId) {
    injectCss();
    var W = App.Wager;
    var frame = el('div', { class: 'wg-match' });
    root.appendChild(frame);

    var state = { match: null, offWatch: null, gameApi: null, roundHostTimer: null, dead: false, curRound: -1, playHost: null };

    function cleanup() {
      state.dead = true;
      if (state.roundHostTimer) clearTimeout(state.roundHostTimer);
      if (state.gameApi && state.gameApi.cleanup) { try { state.gameApi.cleanup(); } catch (e) {} }
      if (state.offWatch) { try { state.offWatch(); } catch (e) {} }
      if (state.curRoom) { try { state.curRoom.leave(); } catch (e) {} }
    }

    function iAmHost() { return state.match && state.match.host === W.myPid(); }
    function iAmA() { return state.match && state.match.a === W.myPid(); }

    function render() {
      var m = state.match;
      if (!m) { frame.innerHTML = ''; frame.appendChild(el('div', { class: 'wg-empty' }, ['Kampf wird geladen …'])); return; }
      // Einsatz genau einmal abbuchen, sobald wir hier sind
      if (!W.alreadyStaked(m.id)) W.stakeOnce(m.id, m.stake);

      frame.innerHTML = '';
      frame.appendChild(el('div', { class: 'page-head' }, [
        el('button', { class: 'btn btn-ghost back', type: 'button', onclick: function () { App.Router.go('/wager'); } }, ['← Zurück']),
        el('h2', { class: 'page-title neon' }, ['⚔️ ' + gameTitle(m.game)])
      ]));
      frame.appendChild(el('div', { class: 'wg-scorebar' }, [
        el('div', { class: 'wg-side a' }, [el('div', { class: 'wg-nm' }, [m.aName]), el('div', { class: 'wg-w' }, [String(m.winsA || 0)])]),
        el('div', { class: 'wg-vs' }, ['Best of ' + m.rounds + (m.phase !== 'done' ? ' · Runde ' + Math.min(m.round + 1, m.rounds) : '')]),
        el('div', { class: 'wg-side b' }, [el('div', { class: 'wg-nm' }, [m.bName]), el('div', { class: 'wg-w' }, [String(m.winsB || 0)])])
      ]));
      frame.appendChild(el('div', { class: 'wg-pot' }, ['💰 Pot: ' + UI.formatShort(m.stake * 2) + ' 🪙']));

      var body = el('div', { class: 'wg-play' });
      frame.appendChild(body);

      if (m.phase === 'done') {
        var win = m.winner;
        var mine = (win === W.myPid());
        var txt = !win ? '🤝 Unentschieden — Einsätze zurück'
          : (mine ? '🏆 Du gewinnst ' + UI.formatShort(m.stake * 2) + ' 🪙!' : '😔 ' + (win === m.a ? m.aName : m.bName) + ' gewinnt.');
        body.appendChild(el('div', { class: 'wg-big' }, [txt]));
        body.appendChild(el('div', { style: 'text-align:center;margin-top:14px;' }, [
          el('button', { class: 'btn btn-primary btn-lg', type: 'button', onclick: function () { App.Router.go('/wager'); } }, ['Zurück zur Übersicht'])
        ]));
        return;
      }

      if (m.phase === 'countdown') {
        var left = Math.max(0, Math.ceil((m.roundStartAt - Date.now()) / 1000));
        body.appendChild(el('div', { class: 'wg-count' }, [left > 0 ? String(left) : 'Los!']));
        body.appendChild(el('div', { style: 'text-align:center;opacity:.7;' }, ['Runde ' + (m.round + 1) + ' startet …']));
        return;
      }

      if (m.phase === 'playing') {
        mountGame(body, m);
        return;
      }
    }

    // Das Minispiel für die laufende Runde einbinden (nur einmal pro Runde).
    function mountGame(body, m) {
      if (state.curRound === m.round && state.gameApi) { body.appendChild(state.gameHost); return; }
      // neue Runde: altes Spiel abräumen
      if (state.gameApi && state.gameApi.cleanup) { try { state.gameApi.cleanup(); } catch (e) {} state.gameApi = null; }
      if (state.curRoom) { try { state.curRoom.leave(); } catch (e) {} state.curRoom = null; }
      state.curRound = m.round;
      state.gameHost = el('div', { class: 'mg-play' });
      body.appendChild(state.gameHost);

      W.roundRoom(m.id, m.round, m.host).then(function (room) {
        if (state.dead || state.curRound !== m.round) return;
        state.curRoom = room;
        var g = App.Minigames[m.game];
        state.gameApi = g.render(state.gameHost, {
          mode: 'multi', room: room, me: { id: W.myPid(), name: (App.Leaderboard.getPlayerName() || 'Du') },
          players: room.players(), isHost: room.isHost(),
          onExit: function () { App.Router.go('/wager'); }
        }) || {};
        // Der Host gibt dem Spiel den synchronen Start und wertet nach Ablauf.
        if (iAmHost()) hostDriveRound(m);
      });
    }

    // Host: Runde starten (round.startAt setzen), nach der Zeit werten, weiterschalten.
    function hostDriveRound(m) {
      if (state.dead) return;
      var path = W.MATCH_ROOT + '/' + m.id + '/g/r' + m.round;
      App.Net.store().then(function (b) {
        return b.update(path, { round: { startAt: Date.now() + 3000 } });
      });
      // Spielzeit = 3s Countdown (im Spiel) + gewählte Sekunden + 1,5s Puffer
      var ms = 3000 + m.seconds * 1000 + 1500;
      state.roundHostTimer = setTimeout(function () {
        if (state.dead) return;
        W.roundWinner(m.id, m.round, m.game).then(function (winnerId) {
          var patch = { round: m.round + 1, phase: 'countdown', roundStartAt: Date.now() + 4000 };
          var winsA = m.winsA || 0, winsB = m.winsB || 0;
          if (winnerId === m.a) winsA++; else if (winnerId === m.b) winsB++;
          patch.winsA = winsA; patch.winsB = winsB;
          var need = Math.floor(m.rounds / 2) + 1;
          var over = (winsA >= need || winsB >= need || (m.round + 1) >= m.rounds);
          if (over) {
            W.finish(Object.assign({}, m, { winsA: winsA, winsB: winsB }));
          } else {
            W.patchMatch(m.id, patch);
          }
        });
      }, ms);
    }

    // Match live verfolgen
    W.watchMatch(matchId, function (m) {
      if (state.dead || !m) return;
      var prevPhase = state.match && state.match.phase;
      var prevRound = state.match && state.match.round;
      state.match = m;
      // Beim Phasenwechsel countdown->playing bzw. neue Runde: neu rendern (Spiel neu mounten).
      if (m.phase !== prevPhase || m.round !== prevRound) { state.curRound = (m.phase === 'playing') ? state.curRound : -1; render(); }
      else if (m.phase === 'done') render();
    }).then(function (off) { state.offWatch = off; });

    // Countdown-Ticker (nur Anzeige)
    var tick = setInterval(function () { if (state.match && state.match.phase === 'countdown') render(); }, 500);
    var origCleanup = cleanup;
    cleanup = function () { clearInterval(tick); origCleanup(); };

    // Erststand laden
    W.getMatch(matchId).then(function (m) { if (!state.dead) { state.match = m; render(); } });

    return { cleanup: function () { cleanup(); } };
  }

  /* ============================ globales Anfrage-Popup ============================ */
  var seenInv = {};
  function pollInvites() {
    if (!App.Wager || !loggedIn()) return;
    App.Wager.incoming().then(function (arr) {
      arr.forEach(function (inv) {
        if (seenInv[inv.id]) return;
        seenInv[inv.id] = true;
        showInvitePopup(inv);
      });
    }).catch(function () {});
  }
  function showInvitePopup(inv) {
    injectCss();
    var overlay = el('div', { class: 'modal-overlay' }, [
      el('div', { class: 'glass modal-card', style: 'max-width:420px;' }, [
        el('h3', { style: 'margin-top:0;' }, ['⚔️ Herausforderung!']),
        el('p', {}, [el('b', {}, [inv.fromName]), ' fordert dich heraus: ', el('br'),
          gameTitle(inv.game) + ' · Best of ' + inv.rounds + ' · ' + inv.seconds + 's']),
        el('p', { class: 'wg-pot' }, ['Einsatz: ' + UI.formatShort(inv.stake) + ' 🪙 · Pot: ' + UI.formatShort(inv.stake * 2) + ' 🪙']),
        el('div', { class: 'admin-row-actions' }, [
          el('button', { class: 'btn btn-primary btn-lg', type: 'button', onclick: function () {
            App.Wager.accept(inv).then(function (m) { close(); App.Router.go('/wager/match/' + m.id); }).catch(function (e) { UI.toast(e.message, 'lose'); });
          } }, ['✅ Annehmen']),
          el('button', { class: 'btn btn-ghost', type: 'button', onclick: function () { App.Wager.decline(inv).then(close); } }, ['Ablehnen'])
        ])
      ])
    ]);
    function close() { if (overlay.parentNode) document.body.removeChild(overlay); }
    document.body.appendChild(overlay);
  }

  function boot() { setInterval(pollInvites, 8000); setTimeout(pollInvites, 3000); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  App.WagerUI = { renderPage: renderPage, renderMatch: renderMatch };
})();
