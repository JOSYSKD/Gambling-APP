/* app.js — Menü, Navigation, Views, Game-Over. Startet die App. */
(function () {
  'use strict';
  window.App = window.App || {};
  App.Games = App.Games || {};
  var UI = App.UI, el = UI.el, go = function (p) { App.Router.go(p); };

  /* Kategorien — bewusst als Liste, damit später leicht erweiterbar
   * (einfach ein weiteres Objekt mit eigener games-Liste ergänzen). */
  var CATEGORIES = [
    {
      id: 'gambling',
      name: 'Gambling',
      icon: '🎰',
      desc: 'Sechs Neon-Klassiker. Setze deine Coins und jage den Highscore.',
      games: ['blackjack', 'crash', 'cuberoll', 'slots', 'roulette', 'mines']
    },
    {
      id: 'minigames',
      name: 'Online Minigames',
      icon: '🎮',
      desc: 'Über 20 Spiele – allein oder mit Freunden per Raum-Code, 2–4 Spieler.',
      route: '/minigames'
    },
    {
      id: 'coop',
      name: 'Koop-Team',
      icon: '🤝',
      desc: 'Zusammen im Team Level schaffen – kocht, löscht, entschärft und besiegt gemeinsam.',
      route: '/coop'
    }
  ];

  function categoryById(id) {
    for (var i = 0; i < CATEGORIES.length; i++) if (CATEGORIES[i].id === id) return CATEGORIES[i];
    return null;
  }

  var viewEl = function () { return document.getElementById('view'); };
  function mount(node) {
    var v = viewEl();
    v.innerHTML = '';
    v.appendChild(node);
  }

  /* ---------- Header-Guthaben synchron halten ---------- */
  function syncBalance() {
    var bv = document.getElementById('balance-value');
    if (bv) bv.textContent = UI.formatCoins(App.Coins.get());
    var bar = document.getElementById('balance');
    if (bar) {
      bar.classList.remove('bump');
      // Reflow erzwingen für Re-Trigger der Animation
      void bar.offsetWidth;
      bar.classList.add('bump');
    }
  }
  App.Coins.onChange(syncBalance);

  /* ---------- MENÜ ---------- */
  function renderMenu() {
    var cards = CATEGORIES.map(function (c) {
      return el('button', { class: 'cat-card glass', type: 'button', onclick: function () { go(c.route || ('/category/' + c.id)); } }, [
        el('div', { class: 'cat-icon' }, [c.icon]),
        el('div', { class: 'cat-name neon' }, [c.name]),
        el('div', { class: 'cat-desc' }, [c.desc]),
        el('span', { class: 'cat-go' }, ['Spielen →'])
      ]);
    });

    mount(el('div', { class: 'menu-wrap' }, [
      el('div', { class: 'hero' }, [
        el('div', { class: 'hero-badge' }, ['🌴 Nur zum Spaß · virtuelle Coins']),
        el('h1', { class: 'hero-title neon-strong' }, ['NEON JUNGLE CASINO']),
        el('p', { class: 'hero-sub' }, ['Willkommen im überwucherten Spielsalon. Wähle eine Kategorie.'])
      ]),
      el('div', { class: 'cat-grid' }, cards),
      el('div', { class: 'menu-links' }, [
        el('button', { class: 'btn btn-ghost', type: 'button', onclick: function () { go('/leaderboard'); } }, ['🏆 Bestenliste']),
        el('button', { class: 'btn btn-ghost', type: 'button', onclick: function () { go('/profile'); } }, ['👤 Profil'])
      ])
    ]));
  }

  /* ---------- KATEGORIE (Spielauswahl) ---------- */
  function renderCategory(params) {
    var c = categoryById(params.id);
    if (!c) { go('/'); return; }
    var tiles = c.games.map(function (gid) {
      var g = App.Games[gid];
      if (!g) return null;
      return el('button', { class: 'game-tile glass', type: 'button', onclick: function () { go('/game/' + gid); } }, [
        el('div', { class: 'tile-glow' }),
        el('div', { class: 'tile-icon' }, [g.icon || '🎲']),
        el('div', { class: 'tile-title' }, [g.title]),
        el('div', { class: 'tile-sub' }, [g.subtitle || '']),
        el('span', { class: 'tile-play' }, ['Los →'])
      ]);
    }).filter(Boolean);

    mount(el('div', { class: 'cat-page' }, [
      el('div', { class: 'page-head' }, [
        el('button', { class: 'btn btn-ghost back', type: 'button', onclick: function () { go('/'); } }, ['← Menü']),
        el('h2', { class: 'page-title neon' }, [c.icon + ' ' + c.name])
      ]),
      el('div', { class: 'tile-grid' }, tiles)
    ]));
  }

  /* ---------- SPIEL-ANSICHT ---------- */
  function renderGame(params) {
    var id = params.id, g = App.Games[id];
    if (!g) { UI.toast('Spiel nicht gefunden', 'lose'); go('/'); return; }

    var content = el('div', { class: 'game-content' });
    var frame = el('div', { class: 'game-frame' }, [
      el('div', { class: 'game-topline' }, [
        el('button', { class: 'btn btn-ghost back', type: 'button', onclick: function () { go('/category/gambling'); } }, ['← Spielauswahl']),
        el('div', { class: 'game-frame-title' }, [(g.icon || '') + ' ' + g.title])
      ]),
      content
    ]);
    mount(frame);

    var api = {};
    try {
      api = g.render(content) || {};
    } catch (e) {
      content.appendChild(el('p', { class: 'err' }, ['Fehler beim Laden des Spiels: ' + e.message]));
      if (window.console) console.error(e);
    }
    // cleanup zurückgeben (Router ruft es beim Verlassen auf)
    return function () { if (api && typeof api.cleanup === 'function') { try { api.cleanup(); } catch (e) {} } };
  }

  /* ---------- LEADERBOARD ---------- */
  function medalClass(rank) { return rank === 1 ? 'gold' : rank === 2 ? 'silver' : rank === 3 ? 'bronze' : ''; }
  function wreath(rank) { return rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : ''; }

  function renderLeaderboard() {
    var container = el('div', { class: 'lb-page' });
    mount(container);

    function draw() {
      var board = App.Leaderboard.getBoard(App.Coins.getPeak(), 10);
      var rows = board.map(function (entry, i) {
        var rank = i + 1;
        var dateTxt = entry.active ? 'läuft gerade' : (entry.date || '—');
        return el('div', { class: 'lb-row glass ' + medalClass(rank) + (entry.active ? ' active' : '') }, [
          el('div', { class: 'lb-rank' }, [wreath(rank) || ('#' + rank)]),
          el('div', { class: 'lb-name' }, [
            el('span', {}, [entry.name || 'Anonym']),
            entry.active ? el('span', { class: 'lb-tag' }, ['aktiver Run']) : null
          ]),
          el('div', { class: 'lb-coins' }, [UI.formatCoins(entry.peak) + ' 🪙']),
          el('div', { class: 'lb-date' }, [dateTxt])
        ]);
      });
      if (!rows.length) rows = [el('div', { class: 'lb-empty' }, ['Noch keine Einträge – spiel eine Runde!'])];

      container.innerHTML = '';
      container.appendChild(el('div', { class: 'page-head' }, [
        el('button', { class: 'btn btn-ghost back', type: 'button', onclick: function () { go('/'); } }, ['← Menü']),
        el('h2', { class: 'page-title neon' }, ['🏆 Bestenliste'])
      ]));
      container.appendChild(el('p', { class: 'lb-hint' }, ['Höchster Coin-Stand pro Run (Peak). ' +
        (App.Leaderboard.isOnline() ? 'Geteilte Bestenliste — alle Spieler dieser Seite.' : 'Lokal auf diesem Gerät gespeichert.')]));
      container.appendChild(el('div', { class: 'lb-list' }, rows));
      container.appendChild(el('div', { class: 'lb-actions' }, [
        el('button', { class: 'btn btn-danger', type: 'button', onclick: function () {
          if (window.confirm('Bestenliste wirklich komplett löschen? Das kann nicht rückgängig gemacht werden.')) {
            App.Leaderboard.reset();
            UI.toast('Bestenliste zurückgesetzt', 'info');
          }
        } }, ['🗑️ Leaderboard zurücksetzen'])
      ]));
    }

    draw();
    var off1 = App.Coins.onChange(draw);
    var off2 = App.Leaderboard.onChange(draw);
    return function () { off1(); off2(); };
  }

  /* ---------- PROFIL ---------- */
  function renderProfile() {
    var name = App.Leaderboard.getPlayerName();
    var input = el('input', { class: 'text-input', type: 'text', maxlength: 18, value: name, placeholder: 'Dein Spielername' });

    function save() {
      var v = input.value.trim();
      if (!v) { UI.toast('Bitte einen Namen eingeben', 'lose'); return; }
      App.Leaderboard.setPlayerName(v);
      UI.toast('Gespeichert: ' + v, 'win');
    }

    mount(el('div', { class: 'profile-page' }, [
      el('div', { class: 'page-head' }, [
        el('button', { class: 'btn btn-ghost back', type: 'button', onclick: function () { go('/'); } }, ['← Menü']),
        el('h2', { class: 'page-title neon' }, ['👤 Profil'])
      ]),
      el('div', { class: 'glass profile-card' }, [
        el('label', { class: 'field-label' }, ['Spielername']),
        input,
        el('button', { class: 'btn btn-primary', type: 'button', onclick: save }, ['Speichern']),
        el('div', { class: 'profile-stats' }, [
          el('div', { class: 'pstat' }, [el('span', { class: 'pstat-l' }, ['Guthaben']), el('span', { class: 'pstat-v' }, [UI.formatCoins(App.Coins.get()) + ' 🪙'])]),
          el('div', { class: 'pstat' }, [el('span', { class: 'pstat-l' }, ['Aktueller Peak']), el('span', { class: 'pstat-v' }, [UI.formatCoins(App.Coins.getPeak()) + ' 🪙'])])
        ])
      ])
    ]));
  }

  /* ---------- Namens-Abfrage beim ersten Besuch ---------- */
  function askNameIfNeeded() {
    if (App.Leaderboard.getPlayerName()) return;
    var input = el('input', { class: 'text-input', type: 'text', maxlength: 18, placeholder: 'z. B. JungleKing' });
    var overlay = el('div', { class: 'modal-overlay' }, [
      el('div', { class: 'modal glass' }, [
        el('div', { class: 'modal-leaf' }, ['🌿']),
        el('h2', { class: 'neon' }, ['Willkommen!']),
        el('p', {}, ['Wie sollen wir dich im Dschungel nennen?']),
        input,
        el('button', { class: 'btn btn-primary btn-lg', type: 'button', onclick: function () {
          var v = (input.value || '').trim() || 'JungleGuest';
          App.Leaderboard.setPlayerName(v);
          document.body.removeChild(overlay);
        } }, ['Los geht\'s 🍃'])
      ])
    ]);
    document.body.appendChild(overlay);
    setTimeout(function () { input.focus(); }, 100);
  }

  /* ---------- GAME OVER ---------- */
  var gameOverActive = false;
  App.Coins.onGameOver(function (info) {
    if (gameOverActive) return;
    gameOverActive = true;
    var peak = info && info.peak != null ? info.peak : App.Coins.getPeak();
    var name = App.Leaderboard.getPlayerName() || 'Anonym';
    var date = new Date().toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
    App.Leaderboard.recordRun(name, peak, date);

    document.getElementById('go-peak').textContent = UI.formatCoins(peak) + ' 🪙';
    var ov = document.getElementById('gameover');
    ov.hidden = false;
    setTimeout(function () { ov.classList.add('show'); }, 20);
  });

  document.getElementById('gameover-restart').addEventListener('click', function () {
    App.Coins.reset();
    var ov = document.getElementById('gameover');
    ov.classList.remove('show');
    setTimeout(function () { ov.hidden = true; }, 300);
    gameOverActive = false;
    // Aktuelle View neu rendern, damit Einsätze/Buttons wieder mit vollem Guthaben laufen.
    App.Router.render();
  });

  /* ---------- Routen + Start ---------- */
  App.Router
    .add('/', renderMenu)
    .add('/category/:id', renderCategory)
    .add('/game/:id', renderGame)
    .add('/minigames', function () { return App.MinigameHub.list(); })
    .add('/coop', function () { return App.MinigameHub.list({ coop: true }); })
    .add('/mini/:id', function (p) { return App.MinigameHub.open(p.id); })
    .add('/leaderboard', renderLeaderboard)
    .add('/profile', renderProfile)
    .setNotFound(renderMenu);

  function boot() {
    syncBalance();
    askNameIfNeeded();
    App.Router.start();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
