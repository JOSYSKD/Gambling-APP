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
    opts = opts || {};
    var coop = !!opts.coop;
    var group = opts.group || null;
    var ids = Object.keys(App.Minigames).filter(function (id) {
      var g = App.Minigames[id];
      if (group) return g.group === group;          // eigene Kategorie (z. B. Poker & Casino)
      if (coop) return !!g.coop && !g.group;         // Koop-Team
      return !g.coop && !g.group;                    // normale Online-Minigames
    });
    // stabile Reihenfolge nach optionalem .order, dann Titel
    ids.sort(function (a, b) {
      var A = App.Minigames[a], B = App.Minigames[b];
      return (A.order || 999) - (B.order || 999) || A.title.localeCompare(B.title);
    });
    var tiles = ids.map(function (id) {
      var g = App.Minigames[id];
      return el('button', { class: 'game-tile glass mg-tile', type: 'button', onclick: function () { go('/mini/' + id); } }, [
        el('div', { class: 'tile-glow' }),
        el('span', {
          class: 'mg-lb-btn', title: 'Bestenliste',
          style: 'position:absolute;top:8px;right:8px;z-index:2;width:30px;height:30px;display:flex;align-items:center;justify-content:center;border-radius:9px;background:rgba(4,16,10,.72);border:1px solid var(--stroke);font-size:15px;cursor:pointer;',
          onclick: function (e) { e.stopPropagation(); if (App.Scores) App.Scores.showBoard(id, g.title); }
        }, ['🏆']),
        el('div', { class: 'tile-icon' }, [g.icon || '🎮']),
        el('div', { class: 'tile-title' }, [g.title]),
        el('div', { class: 'tile-sub' }, [g.subtitle || '']),
        el('div', { class: 'mg-badges' }, [
          g.coop ? el('span', { class: 'mg-badge mg-badge-coop' }, ['🤝 Team']) : null,
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
        el('h2', { class: 'page-title neon' }, [opts.title || (coop ? '🤝 Koop-Team' : '🎮 Online Minigames')])
      ]),
      el('p', { class: 'hint-text mg-intro' }, [
        opts.intro || (coop ? 'Zusammen über das Internet ein Level schaffen – arbeitet als Team gegen die Zeit. (Solo geht auch zum Üben.)'
             : (online ? 'Online-Modus aktiv – spiel mit Freunden per Raum-Code.'
                       : 'Tipp: Ohne Firebase läuft der Mehrspieler-Modus lokal (mehrere Tabs). Sag Bescheid für echtes Online-Spiel.'))
      ]),
      el('div', { class: 'tile-grid' }, tiles)
    ]));
  }

  /* ============================ SPIEL ÖFFNEN ============================ */
  function open(id) {
    var g = App.Minigames[id];
    if (!g) { UI.toast('Minispiel nicht gefunden', 'lose'); go('/minigames'); return; }
    if (App.Scores) App.Scores.setContext(id);
    var backTo = g.coop ? '/coop' : (g.group === 'live' ? '/live' : '/minigames');

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
          g.single !== false ? el('button', { class: 'btn btn-primary btn-lg mg-mode btn-2l', type: 'button', onclick: startSingle }, [
            el('span', { class: 'btn-main' }, ['👤 Alleine spielen']),
            el('span', { class: 'btn-sub' }, [g.coop ? 'zum Üben' : 'gegen Bots · sofort los'])
          ]) : null,
          g.multi !== false ? el('button', { class: 'btn btn-aqua btn-lg mg-mode btn-2l', type: 'button', onclick: lobby }, [
            el('span', { class: 'btn-main' }, ['👥 Mit Freunden']),
            el('span', { class: 'btn-sub' }, ['per Raum-Code · ' + (g.minPlayers || 2) + '–' + (g.maxPlayers || 4) + ' Spieler'])
          ]) : null
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

      // WICHTIG: nur EINMAL ins Spiel wechseln. Das 'phase'-Event feuert bei
      // jeder Raum-Änderung (Heartbeat, Zug, Score) erneut mit 'playing' — ohne
      // diese Sperre würde startMulti() dauernd neu bauen (Flackern/alter Screen).
      var started = false;
      function onPhase(phase) {
        if (phase === 'playing' && !started) {
          started = true;
          room.off('phase', onPhase);
          room.off('players', renderPlayers);
          startMulti();
        }
      }
      room.on('players', renderPlayers);
      room.on('phase', onPhase);
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
      // --- Kacheln: lebendiger (schwebendes Icon, Akzentkante, weicher Hover) ---
      '.mg-tile{transition:transform .2s cubic-bezier(.2,.7,.3,1.35),box-shadow .25s,border-color .2s;}',
      '.mg-tile::before{content:"";position:absolute;top:0;left:14px;right:14px;height:3px;border-radius:3px;background:linear-gradient(90deg,transparent,var(--neon),var(--aqua),transparent);opacity:0;transition:opacity .25s;}',
      '.mg-tile:hover{transform:translateY(-6px) scale(1.015);}',
      '.mg-tile:hover::before{opacity:.95;}',
      '.mg-tile .tile-icon{font-size:44px;transition:transform .25s ease,filter .25s;animation:mg-float 3.6s ease-in-out infinite;will-change:transform;}',
      '.mg-tile:hover .tile-icon{transform:scale(1.16) rotate(-6deg);filter:drop-shadow(0 0 14px var(--stroke-2));}',
      '@keyframes mg-float{0%,100%{transform:translateY(0)}50%{transform:translateY(-5px)}}',
      '.mg-tile:hover .tile-glow{transform:scale(1.35);filter:brightness(1.35);}',
      '.tile-glow{transition:transform .3s,filter .3s;}',
      '.mg-tile .tile-title{letter-spacing:.2px;}',
      '.mg-tile .tile-play{opacity:0;transform:translateX(-6px);transition:.2s;margin-top:2px;}',
      '.mg-tile:hover .tile-play{opacity:1;transform:translateX(0);}',
      '.mg-lb-btn{transition:transform .15s,background .15s,border-color .15s;}',
      '.mg-lb-btn:hover{transform:scale(1.12);border-color:var(--gold)!important;background:rgba(40,32,6,.9)!important;}',
      '.mg-badges{display:flex;gap:6px;margin-top:6px;flex-wrap:wrap;}',
      '.mg-badge{font-size:11px;font-weight:700;padding:3px 8px;border-radius:999px;background:rgba(9,32,21,.8);border:1px solid var(--stroke);color:var(--muted);}',
      '.mg-badge-mp{color:var(--aqua-soft);border-color:rgba(51,230,208,.35);}',
      '.mg-badge-coop{color:var(--gold);border-color:rgba(255,210,63,.4);background:rgba(40,32,6,.7);}',
      '.mg-wrap{display:flex;flex-direction:column;}',
      // --- Modus-Wahl: großes pulsierendes Icon, zweizeilige Modus-Buttons ---
      '.mg-choose{display:flex;flex-direction:column;gap:20px;align-items:center;}',
      '.mg-hero{padding:30px 28px;text-align:center;width:100%;max-width:520px;display:flex;flex-direction:column;gap:8px;align-items:center;position:relative;overflow:hidden;}',
      '.mg-hero::after{content:"";position:absolute;top:-40%;left:50%;width:220px;height:220px;transform:translateX(-50%);background:radial-gradient(circle,var(--stroke-2),transparent 70%);opacity:.4;pointer-events:none;}',
      '.mg-hero-icon{font-size:60px;position:relative;z-index:1;animation:mg-hero-pulse 2.6s ease-in-out infinite;}',
      '@keyframes mg-hero-pulse{0%,100%{transform:scale(1);filter:drop-shadow(0 0 12px var(--stroke-2));}50%{transform:scale(1.08);filter:drop-shadow(0 0 22px var(--neon));}}',
      '.mg-hero h2{margin:0;position:relative;z-index:1;}',
      '.mg-mode-row{display:flex;gap:14px;flex-wrap:wrap;justify-content:center;width:100%;max-width:520px;}',
      '.mg-mode{flex:1;min-width:190px;min-height:66px;}',
      '.mg-lobby{display:flex;flex-direction:column;gap:16px;max-width:520px;margin:0 auto;width:100%;}',
      '.mg-lobby-card{padding:22px;display:flex;flex-direction:column;gap:10px;}',
      '.mg-lobby-card h3{margin:0;}',
      '.mg-or{text-align:center;color:var(--muted);font-weight:700;text-transform:uppercase;letter-spacing:2px;font-size:12px;position:relative;}',
      '.mg-or::before,.mg-or::after{content:"";position:absolute;top:50%;width:34%;height:1px;background:var(--stroke);}',
      '.mg-or::before{left:0;} .mg-or::after{right:0;}',
      '.mg-join-row{display:flex;gap:10px;}',
      '.mg-code-input{flex:1;text-transform:uppercase;letter-spacing:6px;text-align:center;font-size:22px;}',
      '.mg-room{padding:22px;display:flex;flex-direction:column;gap:14px;}',
      '.mg-code-box{display:flex;align-items:center;gap:12px;flex-wrap:wrap;justify-content:center;padding:16px;border-radius:16px;background:rgba(4,16,10,.7);border:1px solid var(--stroke-2);animation:mg-codeglow 2.6s ease-in-out infinite;}',
      '@keyframes mg-codeglow{0%,100%{box-shadow:0 0 0 1px var(--stroke),0 0 12px var(--stroke);}50%{box-shadow:0 0 0 1px var(--stroke-2),0 0 26px var(--stroke-2);}}',
      '.mg-code-l{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:1px;}',
      '.mg-code{font-size:40px;font-weight:900;letter-spacing:8px;background:linear-gradient(90deg,var(--neon),var(--gold));-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;color:transparent;}',
      '.mg-field-title{font-size:13px;font-weight:800;color:var(--leaf);text-transform:uppercase;letter-spacing:1px;}',
      '.mg-players{display:flex;flex-direction:column;gap:8px;}',
      '.mg-player{display:flex;align-items:center;gap:10px;padding:10px 14px;border-radius:12px;background:rgba(9,32,21,.6);border:1px solid var(--stroke);animation:mg-slidein .25s ease;}',
      '@keyframes mg-slidein{from{opacity:0;transform:translateY(6px);}to{opacity:1;transform:translateY(0);}}',
      '.mg-player.me{border-color:var(--stroke-2);box-shadow:var(--glow-soft);}',
      '.mg-player-dot{width:10px;height:10px;border-radius:50%;background:var(--muted);flex:0 0 auto;}',
      '.mg-player-dot.on{background:var(--neon);box-shadow:0 0 8px var(--neon);animation:mg-dotpulse 1.6s ease-in-out infinite;}',
      '@keyframes mg-dotpulse{0%,100%{box-shadow:0 0 6px var(--neon);}50%{box-shadow:0 0 12px var(--neon);}}',
      '.mg-player-name{flex:1;font-weight:700;}',
      '.mg-host-tag{font-size:11px;color:var(--gold);font-weight:800;}',
      '.mg-player-ready{color:var(--muted);}',
      '.mg-lobby-actions{display:flex;flex-direction:column;gap:10px;margin-top:4px;}',
      '.btn.is-ready{filter:brightness(1.1);}',
      '.mg-play{display:flex;flex-direction:column;gap:16px;}',
      // --- Gemeinsame Bausteine: Rangliste ---
      '.mg-scoreboard{display:flex;flex-direction:column;gap:6px;}',
      '.mg-sb-row{display:grid;grid-template-columns:34px 1fr auto;align-items:center;gap:10px;padding:9px 13px;border-radius:11px;background:rgba(9,32,21,.6);border:1px solid var(--stroke);transition:transform .18s,border-color .2s;}',
      '.mg-sb-row.me{border-color:var(--stroke-2);box-shadow:var(--glow-soft);}',
      '.mg-sb-row.p1{background:linear-gradient(90deg,rgba(255,210,63,.16),rgba(9,32,21,.6));border-color:rgba(255,210,63,.4);}',
      '.mg-sb-row.p2{background:linear-gradient(90deg,rgba(207,228,220,.12),rgba(9,32,21,.6));}',
      '.mg-sb-row.p3{background:linear-gradient(90deg,rgba(224,138,60,.12),rgba(9,32,21,.6));}',
      '.mg-sb-rank{font-weight:900;color:var(--muted);text-align:center;font-variant-numeric:tabular-nums;}',
      '.mg-sb-row.p1 .mg-sb-rank{color:var(--gold);} .mg-sb-row.p2 .mg-sb-rank{color:var(--silver);} .mg-sb-row.p3 .mg-sb-rank{color:var(--bronze);}',
      '.mg-sb-name{font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.mg-sb-score{font-weight:900;color:var(--leaf);font-variant-numeric:tabular-nums;}',
      '.mg-timer{font-size:15px;font-weight:800;color:var(--aqua-soft);text-align:center;}',
      // --- Podest ---
      '.mg-podium{display:flex;justify-content:center;align-items:flex-end;gap:12px;margin:20px 0;}',
      '.mg-pod{display:flex;flex-direction:column;align-items:center;gap:8px;animation:mg-podrise .5s cubic-bezier(.2,.8,.3,1) both;}',
      '.mg-pod-2{animation-delay:.1s;} .mg-pod-1{animation-delay:.2s;} .mg-pod-3{animation-delay:0s;}',
      '@keyframes mg-podrise{from{opacity:0;transform:translateY(20px);}to{opacity:1;transform:translateY(0);}}',
      '.mg-pod-name{font-weight:800;font-size:14px;}',
      '.mg-pod-bar{width:84px;border-radius:12px 12px 0 0;display:flex;align-items:flex-start;justify-content:center;padding-top:8px;font-size:26px;font-weight:900;color:#04160c;position:relative;overflow:hidden;}',
      '.mg-pod-bar::after{content:"";position:absolute;top:0;left:-60%;width:40%;height:100%;background:linear-gradient(90deg,transparent,rgba(255,255,255,.5),transparent);transform:skewX(-20deg);animation:mg-shine 3s ease-in-out infinite;}',
      '@keyframes mg-shine{0%{left:-60%;}55%,100%{left:120%;}}',
      '.mg-pod-1 .mg-pod-bar{height:150px;background:linear-gradient(180deg,#ffe07a,var(--gold));box-shadow:0 0 24px rgba(255,210,63,.5);}',
      '.mg-pod-2 .mg-pod-bar{height:110px;background:linear-gradient(180deg,#eef6f2,var(--silver));}',
      '.mg-pod-3 .mg-pod-bar{height:84px;background:linear-gradient(180deg,#f0b070,var(--bronze));}',
      '.mg-pod-score{font-weight:900;color:var(--leaf);}'
    ].join(''));
  }
})();
