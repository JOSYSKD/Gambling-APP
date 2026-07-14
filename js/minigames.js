/* minigames.js — Hub für die Online-Minigames: Übersicht, Modus-Wahl
 * (Singleplayer / Multiplayer), Lobby mit Raum-Code, Spiel-Start.
 *
 * Ein Minispiel registriert sich in App.Minigames.<id> = {
 *   id, title, icon, subtitle, minPlayers, maxPlayers,
 *   single: true|false, multi: true|false,
 *   render: function (root, ctx) -> { cleanup }
 * }
 * ctx = {
 *   mode: 'single' | 'multi',
 *   room: <Room|null>,          // net.js-Room (nur multi)
 *   me: { id, name },
 *   players: [ {id,name,score,...} ],   // aktueller Snapshot (multi)
 *   isHost: bool,
 *   onExit: fn                  // zurück zur Übersicht
 * }
 */
(function () {
  'use strict';
  window.App = window.App || {};
  App.Minigames = App.Minigames || {};
  var UI = App.UI, el = UI.el, go = function (p) { App.Router.go(p); };

  injectHubStyle();

  function view() { return document.getElementById('view'); }
  function mount(node) { var v = view(); v.innerHTML = ''; v.appendChild(node); }
  function playerName() { return (App.Leaderboard && App.Leaderboard.getPlayerName()) || 'Spieler'; }

  /* ============================ ÜBERSICHT ============================ */
  function list(opts) {
    var coop = !!(opts && opts.coop);
    var ids = Object.keys(App.Minigames).filter(function (id) { return !!App.Minigames[id].coop === coop; });
    // stabile Reihenfolge nach optionalem .order, dann Titel
    ids.sort(function (a, b) {
      var A = App.Minigames[a], B = App.Minigames[b];
      return (A.order || 999) - (B.order || 999) || A.title.localeCompare(B.title);
    });
    var tiles = ids.map(function (id) {
      var g = App.Minigames[id];
      return el('button', { class: 'game-tile glass mg-tile', type: 'button', onclick: function () { go('/mini/' + id); } }, [
        el('div', { class: 'tile-glow' }),
        el('div', { class: 'tile-icon' }, [g.icon || '🎮']),
        el('div', { class: 'tile-title' }, [g.title]),
        el('div', { class: 'tile-sub' }, [g.subtitle || '']),
        el('div', { class: 'mg-badges' }, [
          coop ? el('span', { class: 'mg-badge mg-badge-coop' }, ['🤝 Team']) : null,
          g.single !== false ? el('span', { class: 'mg-badge' }, ['👤 Solo']) : null,
          g.multi !== false ? el('span', { class: 'mg-badge mg-badge-mp' }, ['👥 ' + (g.minPlayers || 2) + '–' + (g.maxPlayers || 4)]) : null
        ])
      ]);
    });
    if (!tiles.length) tiles = [el('p', { class: 'hint-text' }, ['Spiele werden geladen …'])];

    var online = App.Net.isOnline();
    mount(el('div', { class: 'cat-page' }, [
      el('div', { class: 'page-head' }, [
        el('button', { class: 'btn btn-ghost back', type: 'button', onclick: function () { go('/'); } }, ['← Menü']),
        el('h2', { class: 'page-title neon' }, [coop ? '🤝 Koop-Team' : '🎮 Online Minigames'])
      ]),
      el('p', { class: 'hint-text mg-intro' }, [
        coop ? 'Zusammen über das Internet ein Level schaffen – arbeitet als Team gegen die Zeit. (Solo geht auch zum Üben.)'
             : (online ? 'Online-Modus aktiv – spiel mit Freunden per Raum-Code.'
                       : 'Tipp: Ohne Firebase läuft der Mehrspieler-Modus lokal (mehrere Tabs). Sag Bescheid für echtes Online-Spiel.')
      ]),
      el('div', { class: 'tile-grid' }, tiles)
    ]));
  }

  /* ============================ SPIEL ÖFFNEN ============================ */
  function open(id) {
    var g = App.Minigames[id];
    if (!g) { UI.toast('Minispiel nicht gefunden', 'lose'); go('/minigames'); return; }
    var backTo = g.coop ? '/coop' : '/minigames';

    var container = el('div', { class: 'mg-wrap' });
    mount(container);

    var current = { cleanup: null };  // aktives Spiel/Screen zum Aufräumen
    var room = null;

    function cleanAll() {
      if (current.cleanup) { try { current.cleanup(); } catch (e) {} current.cleanup = null; }
    }
    function frame(title, body, onBack) {
      container.innerHTML = '';
      container.appendChild(el('div', { class: 'game-frame' }, [
        el('div', { class: 'game-topline' }, [
          el('button', { class: 'btn btn-ghost back', type: 'button', onclick: onBack }, ['← Zurück']),
          el('div', { class: 'game-frame-title' }, [(g.icon || '') + ' ' + g.title])
        ]),
        body
      ]));
    }

    /* ---- Modus-Wahl ---- */
    function chooseMode() {
      cleanAll();
      var body = el('div', { class: 'mg-choose' }, [
        el('div', { class: 'mg-hero glass' }, [
          el('div', { class: 'mg-hero-icon' }, [g.icon || '🎮']),
          el('h2', { class: 'neon' }, [g.title]),
          el('p', { class: 'hint-text' }, [g.subtitle || ''])
        ]),
        el('div', { class: 'mg-mode-row' }, [
          g.single !== false ? el('button', { class: 'btn btn-primary btn-lg mg-mode', type: 'button', onclick: startSingle }, ['👤 Alleine spielen']) : null,
          g.multi !== false ? el('button', { class: 'btn btn-aqua btn-lg mg-mode', type: 'button', onclick: lobby }, ['👥 Mit Freunden']) : null
        ])
      ]);
      frame(g.title, body, function () { go(backTo); });
    }

    /* ---- Singleplayer ---- */
    function startSingle() {
      cleanAll();
      var host = el('div', { class: 'mg-play' });
      frame(g.title, host, function () { cleanAll(); chooseMode(); });
      var api = g.render(host, {
        mode: 'single', room: null,
        me: { id: 'solo', name: playerName() },
        players: [{ id: 'solo', name: playerName(), score: 0 }],
        isHost: true,
        onExit: function () { cleanAll(); chooseMode(); }
      }) || {};
      current.cleanup = api.cleanup || null;
    }

    /* ---- Multiplayer-Lobby ---- */
    function lobby() {
      cleanAll();
      room = App.Net.createRoom();
      room.setName(playerName());

      var codeInput = el('input', { class: 'text-input mg-code-input', type: 'text', maxlength: 4, placeholder: 'CODE', autocapitalize: 'characters' });
      var body = el('div', { class: 'mg-lobby' }, [
        el('div', { class: 'glass mg-lobby-card' }, [
          el('h3', { class: 'neon' }, ['Raum erstellen']),
          el('p', { class: 'hint-text' }, ['Starte einen Raum und teile den Code mit deinen Freunden.']),
          el('button', { class: 'btn btn-primary btn-lg btn-block', type: 'button', onclick: doHost }, ['🚪 Raum erstellen'])
        ]),
        el('div', { class: 'mg-or' }, ['oder']),
        el('div', { class: 'glass mg-lobby-card' }, [
          el('h3', { class: 'neon' }, ['Raum beitreten']),
          el('p', { class: 'hint-text' }, ['Gib den 4-stelligen Code deines Freundes ein.']),
          el('div', { class: 'mg-join-row' }, [codeInput,
            el('button', { class: 'btn btn-aqua btn-lg', type: 'button', onclick: function () { doJoin(codeInput.value); } }, ['Beitreten'])])
        ])
      ]);
      frame(g.title, body, function () { leaveRoom(); chooseMode(); });

      function doHost() {
        room.host(id, { min: g.minPlayers || 2, max: g.maxPlayers || 4 })
          .then(function (code) { waitingRoom(code); })
          .catch(function (e) { UI.toast('Fehler: ' + e.message, 'lose'); });
      }
      function doJoin(code) {
        code = (code || '').toUpperCase().trim();
        if (code.length < 4) { UI.toast('Bitte 4-stelligen Code eingeben', 'info'); return; }
        room.join(code)
          .then(function () { waitingRoom(code); })
          .catch(function (e) { UI.toast(e.message === 'Raum nicht gefunden' ? 'Raum nicht gefunden' : ('Fehler: ' + e.message), 'lose'); });
      }
    }

    /* ---- Warteraum (Spielerliste, Ready, Start) ---- */
    function waitingRoom(code) {
      var listEl = el('div', { class: 'mg-players' });
      var startBtn = el('button', { class: 'btn btn-primary btn-lg btn-block', type: 'button', onclick: doStart, disabled: true }, ['Warten auf Spieler …']);
      var readyBtn = el('button', { class: 'btn btn-aqua btn-block', type: 'button', onclick: toggleReady }, ['✔ Bereit']);
      var statusEl = el('div', { class: 'hint-text', text: App.Net.isOnline() ? 'Online-Raum' : 'Lokaler Raum (mehrere Tabs)' });

      var body = el('div', { class: 'mg-lobby' }, [
        el('div', { class: 'glass mg-room' }, [
          el('div', { class: 'mg-code-box' }, [
            el('span', { class: 'mg-code-l' }, ['Raum-Code']),
            el('span', { class: 'mg-code neon-strong' }, [code]),
            el('button', { class: 'chip', type: 'button', onclick: function () {
              try { navigator.clipboard && navigator.clipboard.writeText(code); UI.toast('Code kopiert', 'win'); } catch (e) {}
            } }, ['📋 Kopieren'])
          ]),
          statusEl,
          el('div', { class: 'mg-field-title' }, ['Spieler']),
          listEl,
          el('div', { class: 'mg-lobby-actions' }, [readyBtn, startBtn])
        ])
      ]);
      frame(g.title, body, function () { leaveRoom(); chooseMode(); });

      var myReady = false;
      function toggleReady() {
        myReady = !myReady;
        room.setReady(myReady);
        readyBtn.textContent = myReady ? '✔ Bereit!' : '✔ Bereit';
        readyBtn.classList.toggle('is-ready', myReady);
      }
      function doStart() {
        var now = Date.now();
        room.setPhase('playing', { round: { startAt: now + 3000 } }); // 3s Countdown
      }

      function renderPlayers() {
        var ps = room.players();
        listEl.innerHTML = '';
        ps.forEach(function (p) {
          listEl.appendChild(el('div', { class: 'mg-player' + (p.id === room.id ? ' me' : '') }, [
            el('span', { class: 'mg-player-dot' + (p.ready ? ' on' : '') }),
            el('span', { class: 'mg-player-name' }, [p.name + (p.id === room.id ? ' (du)' : '')]),
            room.snapshot() && room.snapshot().host === p.id ? el('span', { class: 'mg-host-tag' }, ['Host']) : null,
            el('span', { class: 'mg-player-ready' }, [p.ready ? '✔' : '…'])
          ]));
        });
        // Start-Button nur für Host, wenn genug Spieler da sind
        var enough = ps.length >= (g.minPlayers || 2);
        if (room.isHost()) {
          startBtn.style.display = '';
          startBtn.disabled = !enough;
          startBtn.textContent = enough ? '▶ Spiel starten (' + ps.length + ')' : 'Warten auf Spieler … (' + ps.length + '/' + (g.minPlayers || 2) + ')';
        } else {
          startBtn.style.display = 'none';
        }
      }

      room.on('players', renderPlayers);
      room.on('phase', function (phase) {
        if (phase === 'playing') startMulti();
      });
      renderPlayers();
      current.cleanup = function () { /* leaveRoom übernimmt das Aufräumen */ };
    }

    /* ---- Multiplayer-Spiel starten ---- */
    function startMulti() {
      cleanAll();
      var host = el('div', { class: 'mg-play' });
      frame(g.title, host, function () { leaveRoom(); chooseMode(); });
      var api = g.render(host, {
        mode: 'multi', room: room,
        me: { id: room.id, name: room.name },
        players: room.players(),
        isHost: room.isHost(),
        onExit: function () { leaveRoom(); chooseMode(); }
      }) || {};
      current.cleanup = api.cleanup || null;
    }

    function leaveRoom() {
      cleanAll();
      if (room) { try { room.leave(); } catch (e) {} room = null; }
    }

    chooseMode();

    // Cleanup, wenn die Route verlassen wird (vom Router aufgerufen)
    return function () { leaveRoom(); };
  }

  App.MinigameHub = { list: list, open: open };

  /* ============================ STYLES ============================ */
  function injectHubStyle() {
    UI.injectStyle('minigames-hub-css', [
      '.mg-intro{margin:-8px 0 16px;}',
      '.mg-badges{display:flex;gap:6px;margin-top:6px;flex-wrap:wrap;}',
      '.mg-badge{font-size:11px;font-weight:700;padding:3px 8px;border-radius:999px;background:rgba(9,32,21,.8);border:1px solid var(--stroke);color:var(--muted);}',
      '.mg-badge-mp{color:var(--aqua-soft);border-color:rgba(51,230,208,.35);}',
      '.mg-badge-coop{color:var(--gold);border-color:rgba(255,210,63,.4);background:rgba(40,32,6,.7);}',
      '.mg-wrap{display:flex;flex-direction:column;}',
      '.mg-choose{display:flex;flex-direction:column;gap:20px;align-items:center;}',
      '.mg-hero{padding:28px;text-align:center;width:100%;max-width:520px;display:flex;flex-direction:column;gap:8px;align-items:center;}',
      '.mg-hero-icon{font-size:56px;filter:drop-shadow(0 0 12px rgba(57,255,20,.5));}',
      '.mg-hero h2{margin:0;}',
      '.mg-mode-row{display:flex;gap:14px;flex-wrap:wrap;justify-content:center;width:100%;max-width:520px;}',
      '.mg-mode{flex:1;min-width:180px;}',
      '.mg-lobby{display:flex;flex-direction:column;gap:16px;max-width:520px;margin:0 auto;width:100%;}',
      '.mg-lobby-card{padding:22px;display:flex;flex-direction:column;gap:10px;}',
      '.mg-lobby-card h3{margin:0;}',
      '.mg-or{text-align:center;color:var(--muted);font-weight:700;text-transform:uppercase;letter-spacing:2px;font-size:12px;}',
      '.mg-join-row{display:flex;gap:10px;}',
      '.mg-code-input{flex:1;text-transform:uppercase;letter-spacing:6px;text-align:center;font-size:22px;}',
      '.mg-room{padding:22px;display:flex;flex-direction:column;gap:14px;}',
      '.mg-code-box{display:flex;align-items:center;gap:12px;flex-wrap:wrap;justify-content:center;padding:14px;border-radius:14px;background:rgba(4,16,10,.7);border:1px solid var(--stroke-2);}',
      '.mg-code-l{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:1px;}',
      '.mg-code{font-size:38px;font-weight:900;letter-spacing:8px;}',
      '.mg-field-title{font-size:13px;font-weight:800;color:var(--leaf);text-transform:uppercase;letter-spacing:1px;}',
      '.mg-players{display:flex;flex-direction:column;gap:8px;}',
      '.mg-player{display:flex;align-items:center;gap:10px;padding:10px 14px;border-radius:12px;background:rgba(9,32,21,.6);border:1px solid var(--stroke);}',
      '.mg-player.me{border-color:var(--stroke-2);box-shadow:var(--glow-soft);}',
      '.mg-player-dot{width:10px;height:10px;border-radius:50%;background:var(--muted);flex:0 0 auto;}',
      '.mg-player-dot.on{background:var(--neon);box-shadow:0 0 8px var(--neon);}',
      '.mg-player-name{flex:1;font-weight:700;}',
      '.mg-host-tag{font-size:11px;color:var(--gold);font-weight:800;}',
      '.mg-player-ready{color:var(--muted);}',
      '.mg-lobby-actions{display:flex;flex-direction:column;gap:10px;margin-top:4px;}',
      '.btn.is-ready{filter:brightness(1.1);}',
      '.mg-play{display:flex;flex-direction:column;gap:16px;}',
      // Gemeinsame Bausteine für die Spiele
      '.mg-scoreboard{display:flex;flex-direction:column;gap:6px;}',
      '.mg-sb-row{display:grid;grid-template-columns:30px 1fr auto;align-items:center;gap:10px;padding:8px 12px;border-radius:10px;background:rgba(9,32,21,.6);border:1px solid var(--stroke);}',
      '.mg-sb-row.me{border-color:var(--stroke-2);}',
      '.mg-sb-rank{font-weight:900;color:var(--muted);text-align:center;}',
      '.mg-sb-row.p1 .mg-sb-rank{color:var(--gold);} .mg-sb-row.p2 .mg-sb-rank{color:var(--silver);} .mg-sb-row.p3 .mg-sb-rank{color:var(--bronze);}',
      '.mg-sb-name{font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.mg-sb-score{font-weight:900;color:var(--leaf);font-variant-numeric:tabular-nums;}',
      '.mg-timer{font-size:15px;font-weight:800;color:var(--aqua-soft);text-align:center;}',
      // Podest
      '.mg-podium{display:flex;justify-content:center;align-items:flex-end;gap:12px;margin:20px 0;}',
      '.mg-pod{display:flex;flex-direction:column;align-items:center;gap:8px;}',
      '.mg-pod-name{font-weight:800;font-size:14px;}',
      '.mg-pod-bar{width:84px;border-radius:12px 12px 0 0;display:flex;align-items:flex-start;justify-content:center;padding-top:8px;font-size:26px;font-weight:900;color:#04160c;}',
      '.mg-pod-1 .mg-pod-bar{height:150px;background:linear-gradient(180deg,#ffe07a,var(--gold));box-shadow:0 0 24px rgba(255,210,63,.5);}',
      '.mg-pod-2 .mg-pod-bar{height:110px;background:linear-gradient(180deg,#eef6f2,var(--silver));}',
      '.mg-pod-3 .mg-pod-bar{height:84px;background:linear-gradient(180deg,#f0b070,var(--bronze));}',
      '.mg-pod-score{font-weight:900;color:var(--leaf);}'
    ].join(''));
  }
})();
