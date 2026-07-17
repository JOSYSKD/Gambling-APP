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
      desc: '16 Solo-Klassiker + Poker & Casino mit Freunden. Setze deine Coins und jage den Highscore.',
      games: ['blackjack', 'crash', 'cuberoll', 'slots', 'roulette', 'mines', 'coinflip', 'wheel',
        'baccarat', 'videopoker', 'casinowar', 'dragontiger', 'andarbahar', 'sicbo', 'keno', 'plinko',
        'jenga', 'doubleornothing'],
      // Aus dem Menü heraus wird immer im Casino (Silber) gezockt. In den
      // Survival-Modus kommt man ausschließlich über dessen eigene Kachel.
      mode: 'casino'
    },
    {
      id: 'survival',
      name: 'Survival',
      icon: '🥇',
      desc: 'Eigener Spielstand mit Gold-Coins: pleite heißt alles auf null — Level, Quests, Depot. Danach eine Stunde Pause. Live-Rangliste inklusive.',
      route: '/survival'
    },
    {
      id: 'stocks',
      name: 'Aktien',
      icon: '📈',
      desc: '20 Aktien von 100 bis 1.000 Coins. Alle 10 Sekunden ein neuer Kurs — kaufen, halten, im richtigen Moment verkaufen.',
      route: '/stocks',
      mode: 'casino'
    },
    {
      id: 'cours',
      name: 'COURS',
      icon: '🎢',
      desc: 'Ein einziger, wilder Kurs — 3 Ticks pro Sekunde, jeder Tick 1–10 % rauf oder runter. Läuft nie aus, für alle gleich. Steig ein und im richtigen Moment wieder aus.',
      route: '/cours',
      mode: 'casino'
    },
    {
      id: 'minigames',
      name: 'Online Minigames',
      icon: '🎮',
      desc: 'Über 50 Spiele – allein gegen Bots oder mit Freunden per Raum-Code, 2–8 Spieler.',
      route: '/minigames'
    },
    {
      id: 'coop',
      name: 'Koop-Team',
      icon: '🤝',
      desc: 'Zusammen im Team Level schaffen – kocht, löscht, entschärft und besiegt gemeinsam.',
      route: '/coop'
    },
    {
      id: 'tournament',
      name: 'Turnier',
      icon: '🏆',
      desc: 'Turniere über mehrere Runden — jeder kann selbst eins hosten. Der Einsatz des Hosts ist das Preisgeld: 50 / 30 / 20 % für die ersten drei.',
      route: '/tournament',
      // Turniere laufen immer im Casino: eine Gambling-Runde würde sonst mit
      // Gold gespielt und könnte einen Survival-Run beenden.
      mode: 'casino'
    }
  ];

  function categoryById(id) {
    for (var i = 0; i < CATEGORIES.length; i++) if (CATEGORIES[i].id === id) return CATEGORIES[i];
    return null;
  }

  /* ---------- Gratis-Coins-Knopf (Gambling-Seite) ---------- */
  var COIN_CLAIM_KEY = 'gj_coin_claim_last';
  var COIN_CLAIM_AMOUNT = 50;
  var COIN_CLAIM_COOLDOWN = 60000; // 60s zwischen zwei Claims
  function buildCoinClaimButton() {
    var btn = el('button', { class: 'btn btn-primary btn-lg coin-claim-btn', type: 'button', onclick: claim }, ['']);
    function remaining() {
      var last = App.Storage.get(COIN_CLAIM_KEY, 0) || 0;
      return Math.max(0, COIN_CLAIM_COOLDOWN - (Date.now() - last));
    }
    function claim() {
      if (remaining() > 0) return;
      App.Storage.set(COIN_CLAIM_KEY, Date.now());
      App.Coins.add(COIN_CLAIM_AMOUNT);
      UI.toast('+' + COIN_CLAIM_AMOUNT + ' 🪙 eingesammelt!', 'win');
      update();
    }
    function update() {
      var r = remaining();
      btn.disabled = r > 0;
      btn.textContent = r > 0 ? ('🪙 Nächste in ' + Math.ceil(r / 1000) + 's') : ('🪙 +' + COIN_CLAIM_AMOUNT + ' Coins einsammeln');
    }
    update();
    var timer = setInterval(update, 1000);
    return { root: el('div', { class: 'coin-claim-wrap' }, [btn]), cleanup: function () { clearInterval(timer); } };
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

  /* Status-Zeile der Survival-Kachel: läuft gerade ein Run, ist er gesperrt? */
  function survivalTeaser() {
    if (!App.Survival) return 'Spielen →';
    if (App.Survival.isActive()) return '● Run läuft · ' + UI.formatShort(App.Survival.assets()) + ' 🥇 →';
    if (App.Survival.isLocked()) return '⏳ Gesperrt — gleich wieder →';
    return 'Run starten →';
  }

  /* ---------- MENÜ ---------- */
  function renderMenu() {
    var cards = CATEGORIES.map(function (c) {
      var isSv = c.id === 'survival';
      return el('button', {
        class: 'cat-card glass' + (isSv ? ' cat-survival' : ''), type: 'button',
        onclick: function () {
          // Kachel bestimmt die Währung: Gambling/Aktien aus dem Menü = Silber.
          if (c.mode && App.Mode) App.Mode.set(c.mode);
          go(c.route || ('/category/' + c.id));
        }
      }, [
        el('div', { class: 'cat-icon' }, [c.icon]),
        el('div', { class: 'cat-name ' + (isSv ? 'sv-cat-name' : 'neon') }, [c.name]),
        el('div', { class: 'cat-desc' }, [c.desc]),
        el('span', { class: 'cat-go' + (isSv ? ' sv-cat-go' : '') }, [isSv ? survivalTeaser() : 'Spielen →'])
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
        el('button', { class: 'btn btn-ghost', type: 'button', onclick: function () { go('/quests'); } }, ['⭐ Level & Quests']),
        el('button', { class: 'btn btn-ghost', type: 'button', onclick: function () { go('/chat'); } }, ['💬 Gruppenchat']),
        el('button', { class: 'btn btn-ghost', type: 'button', onclick: function () { go('/send'); } }, ['💸 Coins verschenken']),
        el('button', { class: 'btn btn-ghost', type: 'button', onclick: function () { go('/bank'); } }, ['🏦 Bank']),
        el('button', { class: 'btn btn-ghost', type: 'button', onclick: function () { go('/leaderboard'); } }, ['🏆 Bestenliste']),
        el('button', { class: 'btn btn-ghost', type: 'button', onclick: function () { go('/profile'); } }, ['👤 Profil']),
        el('button', { class: 'btn btn-ghost', type: 'button', onclick: function () { go('/changelog'); } }, ['🆕 Update-News']),
        el('button', { class: 'btn btn-ghost', type: 'button', onclick: function () { go('/settings'); } }, ['⚙️ Einstellungen'])
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

    var survival = App.Mode && App.Mode.is('survival');
    var sections = [
      el('div', { class: 'page-head' }, [
        el('button', { class: 'btn btn-ghost back', type: 'button', onclick: function () { go(survival ? '/survival' : '/'); } },
          [survival ? '← Survival' : '← Menü']),
        el('h2', { class: 'page-title ' + (survival ? 'sv-cat-name' : 'neon') }, [c.icon + ' ' + c.name])
      ])
    ];

    // Im Survival-Modus wird mit Gold gespielt — das muss unübersehbar sein.
    if (survival) {
      sections.push(el('div', { class: 'sv-banner glass' }, [
        el('span', { class: 'sv-banner-ic' }, ['🥇']),
        el('div', {}, [
          el('div', { class: 'sv-banner-t' }, ['Survival — du spielst mit Gold']),
          el('div', { class: 'sv-banner-d' }, ['Pleite bedeutet: alles auf null und eine Stunde Pause. Kein Auffüllen, keine Gratis-Coins.'])
        ])
      ]));
    }

    // Gambling-Menü bekommt zusätzlich den Gratis-Coins-Knopf — im Survival-Modus
    // aber NICHT: eine Gratis-Coin-Quelle würde den ganzen Modus aushebeln
    // (man könnte sich unbegrenzt zurück ins Spiel klicken).
    var claim = null;
    if (c.id === 'gambling') {
      if (!survival) {
        claim = buildCoinClaimButton();
        sections.push(claim.root);
      }
      if (App.Admin && App.Admin.isAdmin()) {
        sections.push(el('button', {
          class: 'btn btn-primary btn-lg btn-block', type: 'button',
          style: 'margin-bottom:4px;', onclick: function () { go('/admin'); }
        }, ['🛠 Admin Panel öffnen']));
      }
    }
    sections.push(el('div', { class: 'tile-grid' }, tiles));

    // Gambling-Menü enthält zusätzlich die Poker- & Casino-Tische (Multiplayer per Raum-Code).
    if (c.id === 'gambling' && App.Minigames) {
      var live = Object.keys(App.Minigames).map(function (k) { return App.Minigames[k]; })
        .filter(function (g) { return g && g.group === 'live'; })
        .sort(function (a, b) { return (a.order || 0) - (b.order || 0); });
      if (live.length) {
        var liveTiles = live.map(function (g) {
          return el('button', { class: 'game-tile glass', type: 'button', onclick: (function (id) { return function () { go('/mini/' + id); }; })(g.id) }, [
            el('div', { class: 'tile-glow' }),
            el('div', { class: 'tile-icon' }, [g.icon || '🃏']),
            el('div', { class: 'tile-title' }, [g.title]),
            el('div', { class: 'tile-sub' }, [g.subtitle || '']),
            el('span', { class: 'tile-play' }, ['Spielen →'])
          ]);
        });
        sections.push(el('h3', { class: 'cat-subhead', style: 'margin:22px 2px 2px;font-weight:900;color:var(--gold);font-size:16px;' }, ['🃏 Poker & Casino · allein gegen Bots oder mit Freunden']));
        sections.push(el('div', { class: 'tile-grid' }, liveTiles));
      }
    }

    mount(el('div', { class: 'cat-page' }, sections));
    return claim ? claim.cleanup : null;
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
    var tab = 'coins';   // 'coins' | 'streak'

    var shared = App.Account.backendKind() === 'firebase' || App.Account.backendKind() === 'cloud';

    function coinsRows() {
      // Diese Bestenliste ist die des Casinos (Silber). Läuft gerade ein Survival-Run,
      // gehört dessen Gold-Peak NICHT hierher — Survival hat seine eigene Rangliste.
      var activePeak = (App.Mode && App.Mode.is('survival')) ? null : App.Coins.getPeak();
      // Kein Top-10-Deckel mehr: jeder Spieler soll sich selbst finden können.
      var board = App.Leaderboard.getBoard(activePeak, 200);
      return board.map(function (entry, i) {
        var rank = i + 1;
        var dateTxt = entry.active ? 'läuft gerade' : (entry.online ? 'online' : (entry.date || '—'));
        var rankTxt = wreath(rank) || ('#' + rank);

        // Eigene Zeile im Profilkarten-Look (Avatar/Rahmen/Banner/Level/Glühbirnen).
        if (entry.me && App.ProfileCard && App.ProfileCard.renderRow) {
          var meRow = App.ProfileCard.renderRow(null, {
            rankEl: rankTxt,
            tag: entry.active ? el('span', { class: 'lb-tag' }, ['aktiver Run'])
              : (entry.online ? el('span', { class: 'lb-tag lb-tag-on' }, ['🟢 online']) : null)
          });
          meRow.classList.add('pcp-open');
          meRow.onclick = function () { openPlayerModal(entry); };
          return meRow;
        }

        var row = el('div', { class: 'lb-row glass pcp-open ' + medalClass(rank) + (entry.active ? ' active' : '') }, [
          el('div', { class: 'lb-rank' }, [rankTxt]),
          el('div', { class: 'lb-name' }, [
            el('span', { class: entry.gold ? 'name-gold' : '' }, [entry.name || 'Anonym']),
            entry.active ? el('span', { class: 'lb-tag' }, ['aktiver Run'])
              : (entry.online ? el('span', { class: 'lb-tag lb-tag-on' }, ['🟢 online']) : null)
          ]),
          el('div', { class: 'lb-coins' }, [UI.formatCoins(entry.peak) + ' 🪙']),
          el('div', { class: 'lb-date' }, [dateTxt])
        ]);
        row.onclick = function () { openPlayerModal(entry); };
        return row;
      });
    }

    function streakRows() {
      // Längste Sieg-Serie (Siege in Folge über ALLE Gambling-Spiele) pro Spieler.
      // Immer die Casino-Serie (auch in Survival) — deckungsgleich mit presence.js.
      var mine = (App.Progress && App.Progress.maxStreakIn) ? App.Progress.maxStreakIn('casino') : 0;
      var board = App.Leaderboard.getStreakBoard(mine, 200);
      return board.map(function (entry, i) {
        var rank = i + 1;
        return el('div', { class: 'lb-row glass ' + medalClass(rank) + (entry.me ? ' active' : '') }, [
          el('div', { class: 'lb-rank' }, [wreath(rank) || ('#' + rank)]),
          el('div', { class: 'lb-name' }, [
            el('span', { class: entry.gold ? 'name-gold' : '' }, [entry.name || 'Anonym']),
            entry.me ? el('span', { class: 'lb-tag' }, ['du'])
              : (entry.online ? el('span', { class: 'lb-tag lb-tag-on' }, ['🟢 online']) : null)
          ]),
          el('div', { class: 'lb-coins' }, [UI.formatShort(entry.streak) + ' 🔥']),
          el('div', { class: 'lb-date' }, [entry.streak === 1 ? 'Sieg in Folge' : 'Siege in Folge'])
        ]);
      });
    }

    function draw() {
      var rows = tab === 'streak' ? streakRows() : coinsRows();
      var emptyMsg = tab === 'streak'
        ? 'Noch keine Siegesserie – gewinne ein paar Runden hintereinander!'
        : 'Noch keine Einträge – spiel eine Runde!';
      if (!rows.length) rows = [el('div', { class: 'lb-empty' }, [emptyMsg])];

      function tabBtn(id, label) {
        return el('button', {
          class: 'lb-tab' + (tab === id ? ' on' : ''), type: 'button',
          onclick: function () { if (tab !== id) { tab = id; draw(); } }
        }, [label]);
      }

      var hint;
      if (tab === 'streak') {
        hint = shared
          ? 'Längste Sieg-Serie (Siege in Folge) über ALLE Gambling-Spiele — eine Zeile pro Spieler. Die Serie reißt bei jedem Verlust; hier zählt der Allzeit-Rekord.'
          : 'Längste Sieg-Serie (Siege in Folge) über alle Gambling-Spiele. Kein Cloud-Backend erreichbar: aktuell nur Spieler aus diesem Browser sichtbar.';
      } else {
        hint = shared
          ? 'Höchster Silber-Stand (Peak) — eine Zeile pro Spieler. Jeder, der die Seite offen hat, steht automatisch drauf: man muss nicht erst pleitegehen. Neue Spieler tauchen nach ein paar Sekunden auf.'
          : 'Höchster Silber-Stand (Peak) — eine Zeile pro Spieler. Kein Cloud-Backend erreichbar: aktuell nur Spieler aus diesem Browser sichtbar.';
      }

      container.innerHTML = '';
      container.appendChild(el('div', { class: 'page-head' }, [
        el('button', { class: 'btn btn-ghost back', type: 'button', onclick: function () { go('/'); } }, ['← Menü']),
        el('h2', { class: 'page-title neon' }, ['🏆 Bestenliste'])
      ]));
      container.appendChild(el('div', { class: 'lb-tabs' }, [
        tabBtn('coins', '🪙 Coins'), tabBtn('streak', '🔥 Streak')
      ]));
      container.appendChild(el('p', { class: 'lb-hint' }, [hint]));
      container.appendChild(el('div', { class: 'lb-list' }, rows));
    }

    draw();
    var off1 = App.Coins.onChange(draw);
    var off2 = App.Leaderboard.onChange(draw);
    return function () { off1(); off2(); };
  }

  /** Profil eines Spielers aus der Bestenliste: Profilkarte + gespielte Spiele.
   *  Für sich selbst (entry.me) aus dem lokalen Zustand, für andere aus den
   *  Präsenz-Daten (siehe js/profile-card.js / js/presence.js). */
  function openPlayerModal(entry) {
    if (!App.ProfileCard || !App.ProfileCard.renderCardFor) return;
    var isMe = !!entry.me;
    var card = isMe ? App.ProfileCard.renderCard() : App.ProfileCard.renderCardFor(entry);
    var games = isMe
      ? App.ProfileCard.gamesEl(Object.keys((App.Progress && App.Progress.stats && App.Progress.stats().games) || {}))
      : App.ProfileCard.gamesEl(entry.games || []);
    var overlay = el('div', { class: 'modal-overlay' }, [
      el('div', { class: 'modal glass', style: 'max-width:520px;width:94%;text-align:left;' }, [
        card,
        el('h3', { class: 'neon', style: 'margin:14px 0 8px;font-size:16px;' }, ['🎮 Gespielte Spiele']),
        games,
        el('button', { class: 'btn btn-ghost', type: 'button', style: 'margin-top:14px;', onclick: close }, ['Schließen'])
      ])
    ]);
    function close() { if (overlay.parentNode) document.body.removeChild(overlay); }
    overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });
    document.body.appendChild(overlay);
  }

  /* ---------- PROFIL ---------- */
  function renderProfile() {
    var container = el('div', { class: 'profile-page' });
    mount(container);

    function draw() {
      container.innerHTML = '';
      container.appendChild(el('div', { class: 'page-head' }, [
        el('button', { class: 'btn btn-ghost back', type: 'button', onclick: function () { go('/'); } }, ['← Menü']),
        el('h2', { class: 'page-title neon' }, ['👤 Profil'])
      ]));
      // Anpassbare Profilkarte + Kosmetik-Editor (Level-Freischaltungen)
      if (App.ProfileCard) {
        var cardHolder = el('div');
        var refreshCard = function () { cardHolder.innerHTML = ''; cardHolder.appendChild(App.ProfileCard.renderCard()); };
        refreshCard();
        container.appendChild(cardHolder);
        container.appendChild(App.ProfileCard.renderCustomizer(refreshCard));
      }
      container.appendChild(nameCard());
      container.appendChild(accountCard());
    }

    function nameCard() {
      var name = App.Leaderboard.getPlayerName();
      var input = el('input', { class: 'text-input', type: 'text', maxlength: 18, value: name, placeholder: 'Dein Spielername' });
      function save() {
        var v = input.value.trim();
        if (!v) { UI.toast('Bitte einen Namen eingeben', 'lose'); return; }
        App.Leaderboard.setPlayerName(v);
        UI.toast('Gespeichert: ' + v, 'win');
      }
      return el('div', { class: 'glass profile-card' }, [
        el('label', { class: 'field-label' }, ['Spielername']),
        input,
        el('button', { class: 'btn btn-primary', type: 'button', onclick: save }, ['Speichern']),
        el('div', { class: 'profile-stats' }, [
          el('div', { class: 'pstat' }, [el('span', { class: 'pstat-l' }, ['Guthaben']), el('span', { class: 'pstat-v' }, [UI.formatCoins(App.Coins.get()) + ' 🪙'])]),
          el('div', { class: 'pstat' }, [el('span', { class: 'pstat-l' }, ['Aktueller Peak']), el('span', { class: 'pstat-v' }, [UI.formatCoins(App.Coins.getPeak()) + ' 🪙'])])
        ])
      ]);
    }

    function backendBanner() {
      var kind = App.Account.backendKind();
      if (kind === 'firebase') {
        return el('p', { class: 'lb-hint' }, ['☁️ Konten sind geräteübergreifend live (Firebase) — melde dich in jedem Browser mit deinem Kontonamen + Passwort an.']);
      }
      if (kind === 'cloud') {
        return el('p', { class: 'lb-hint' }, ['☁️ Konten sind geräteübergreifend live (Cloud-Speicher) — melde dich in jedem Browser mit deinem Kontonamen + Passwort an. Änderungen anderer Geräte können bis zu ~15 Sek. brauchen.']);
      }
      return el('p', { class: 'lb-hint' }, ['⚠️ Kein Cloud-Backend eingerichtet: Konten funktionieren aktuell nur in diesem Browser. Für geräteübergreifende Konten reicht entweder eine Cloud-Speicher-ID (js/cloud-config.js, kein Login nötig) oder eine echte Firebase-Konfiguration (js/firebase-config.js, siehe README).']);
    }

    function accountCard() {
      var cur = App.Account.current();
      if (cur) {
        var oldPw = el('input', { class: 'text-input', type: 'password', placeholder: 'Aktuelles Passwort' });
        var newPw = el('input', { class: 'text-input', type: 'password', placeholder: 'Neues Passwort (min. 4 Zeichen)' });
        return el('div', { class: 'glass profile-card' }, [
          el('label', { class: 'field-label' }, ['🔐 Konto']),
          backendBanner(),
          el('p', {}, ['Angemeldet als ', el('b', {}, [cur.name])]),
          el('button', { class: 'btn btn-ghost', type: 'button', onclick: function () {
            App.Account.logout();
            UI.toast('Abgemeldet', 'info');
            draw();
          } }, ['Abmelden']),
          el('label', { class: 'field-label' }, ['Neues Passwort vergeben']),
          oldPw, newPw,
          el('button', { class: 'btn btn-primary', type: 'button', onclick: function () {
            App.Account.changePassword(oldPw.value, newPw.value).then(function () {
              UI.toast('Passwort geändert', 'win');
              oldPw.value = ''; newPw.value = '';
            }).catch(function (e) { UI.toast(e.message, 'lose'); });
          } }, ['Passwort ändern'])
        ]);
      }

      var loginName = el('input', { class: 'text-input', type: 'text', maxlength: 24, placeholder: 'Kontoname' });
      var loginPw = el('input', { class: 'text-input', type: 'password', placeholder: 'Passwort' });
      var regName = el('input', { class: 'text-input', type: 'text', maxlength: 24, placeholder: 'Kontoname' });
      var regPw = el('input', { class: 'text-input', type: 'password', placeholder: 'Passwort (min. 4 Zeichen)' });
      var regPw2 = el('input', { class: 'text-input', type: 'password', placeholder: 'Passwort bestätigen' });

      var loginForm = el('div', { class: 'profile-account-form' }, [
        loginName, loginPw,
        el('button', { class: 'btn btn-primary', type: 'button', onclick: function () {
          var name = loginName.value, pw = loginPw.value;
          // Admin-Zugang schaltet nur die Admin-Rechte frei. Der Login LÄUFT TROTZDEM
          // WEITER als normales Konto — sonst wäre der Host ein Gast mit Admin-Rechten
          // und sein Level/Kontostand läge nur in diesem Browser (auf jedem anderen
          // Gerät wieder Level 1). Beim ersten Mal wird sein Konto dabei angelegt und
          // nimmt den aktuellen Spielstand mit.
          var isAdmin = !!(App.Admin && App.Admin.tryLogin(name, pw));
          if (isAdmin) UI.toast('🛠 Admin-Modus aktiviert', 'win');
          var go2 = function () { if (isAdmin) go('/category/gambling'); else draw(); };
          var doLogin = isAdmin ? App.Account.loginOrRegister(name, pw) : App.Account.login(name, pw);
          doLogin.then(function () {
            UI.toast('Angemeldet als ' + name, 'win');
            go2();
          }).catch(function (e) {
            UI.toast(e.message, 'lose');
            if (isAdmin) go2();   // Admin-Rechte gelten auch, wenn der Konto-Login klemmt
          });
        } }, ['Anmelden'])
      ]);
      var regForm = el('div', { class: 'profile-account-form', style: 'display:none' }, [
        regName, regPw, regPw2,
        el('button', { class: 'btn btn-primary', type: 'button', onclick: function () {
          if (regPw.value !== regPw2.value) { UI.toast('Passwörter stimmen nicht überein', 'lose'); return; }
          App.Account.register(regName.value, regPw.value).then(function () {
            UI.toast('Konto erstellt: ' + regName.value, 'win');
            draw();
          }).catch(function (e) { UI.toast(e.message, 'lose'); });
        } }, ['Konto erstellen'])
      ]);

      var tabLogin = el('button', { class: 'btn btn-ghost tab-active', type: 'button', onclick: function () {
        loginForm.style.display = ''; regForm.style.display = 'none';
        tabLogin.classList.add('tab-active'); tabReg.classList.remove('tab-active');
      } }, ['Anmelden']);
      var tabReg = el('button', { class: 'btn btn-ghost', type: 'button', onclick: function () {
        loginForm.style.display = 'none'; regForm.style.display = '';
        tabReg.classList.add('tab-active'); tabLogin.classList.remove('tab-active');
      } }, ['Neues Konto']);

      return el('div', { class: 'glass profile-card' }, [
        el('label', { class: 'field-label' }, ['🔐 Konto']),
        backendBanner(),
        el('div', { class: 'profile-account-tabs' }, [tabLogin, tabReg]),
        loginForm, regForm
      ]);
    }

    draw();
    var off = App.Account.onChange(draw);
    return function () { off(); };
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
    // Im Survival-Modus gibt es kein Auffüllen: dort übernimmt js/survival.js
    // (Alles auf null + eine Stunde Sperre statt Neustart-Knopf).
    if (App.Mode && App.Mode.is('survival')) { App.Survival.onBust(info); return; }
    var peak = info && info.peak != null ? info.peak : App.Coins.getPeak();
    var name = App.Leaderboard.getPlayerName() || 'Anonym';
    var date = new Date().toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
    App.Leaderboard.recordRun(name, peak, date);

    // Einstellung „Sofort weiterspielen" (js/settings.js): kein Overlay, sofort
    // das Einstiegsgeld zurück und die aktuelle Ansicht neu aufbauen.
    if (App.Settings && App.Settings.autoRestart && App.Settings.autoRestart()) {
      App.Coins.reset();
      var amt = App.Coins.startAmount ? App.Coins.startAmount() : 1000;
      if (App.UI && App.UI.toast) App.UI.toast('🌱 Automatisch aufgefüllt: ' + UI.formatCoins(amt) + ' 🪙', 'win');
      App.Router.render();
      return;
    }

    gameOverActive = true;
    document.getElementById('go-peak').textContent = UI.formatCoins(peak) + ' 🪙';
    var refill = App.Coins.startAmount ? App.Coins.startAmount() : 1000;
    var btn = document.getElementById('gameover-restart');
    if (btn) btn.textContent = '🌱 Neustart (' + UI.formatCoins(refill) + ' Coins)';
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
    .add('/live', function () { return App.MinigameHub.list({ group: 'live', title: '🃏 Poker & Casino', intro: 'Mit Freunden per Raum-Code – Poker-Varianten und Casino-Klassiker. Solo geht gegen Bots.' }); })
    .add('/mini/:id', function (p) { return App.MinigameHub.open(p.id); })
    .add('/leaderboard', renderLeaderboard)
    .add('/survival', function () { var d = el('div', { class: 'view-page' }); mount(d); return App.Survival.renderPage(d); })
    .add('/stocks', function () { var d = el('div', { class: 'view-page' }); mount(d); return App.Stocks.renderPage(d); })
    .add('/cours', function () { if (App.Mode) App.Mode.set('casino'); var d = el('div', { class: 'view-page' }); mount(d); return App.Cours.renderPage(d); })
    .add('/chat', function () { var d = el('div', { class: 'view-page' }); mount(d); return App.Chat.renderPage(d); })
    .add('/quests', function () { var d = el('div', { class: 'view-page' }); mount(d); App.Progress.renderPage(d); })
    .add('/bank', function () { var d = el('div', { class: 'view-page' }); mount(d); return App.Bank.renderPage(d); })
    .add('/settings', function () { var d = el('div', { class: 'view-page' }); mount(d); App.Settings.renderPage(d); })
    .add('/profile', renderProfile)
    .add('/changelog', function () { var d = el('div', { class: 'view-page' }); mount(d); App.Changelog.renderPage(d); })
    .add('/tournament', function () {
      // Auch beim direkten Aufruf über die Adresszeile: im Turnier wird mit
      // Silber gespielt, nie mit dem Survival-Gold.
      if (App.Mode) App.Mode.set('casino');
      var d = el('div', { class: 'view-page' }); mount(d);
      return App.TournamentUI.renderPage(d);
    })
    .add('/tournament/host', function () {
      // Gehostet wird mit Silber — der Einsatz kommt aus dem Casino-Stand.
      if (App.Mode) App.Mode.set('casino');
      var d = el('div', { class: 'view-page' }); mount(d);
      return App.TournamentHostUI.renderPage(d);
    })
    .add('/send', function () {
      var d = el('div', { class: 'view-page' }); mount(d);
      return App.Wallet.renderPage(d);
    })
    .add('/admin', function () {
      if (!App.Admin || !App.Admin.isAdmin()) { go('/'); return; }
      var d = el('div', { class: 'view-page' }); mount(d);
      return App.Admin.renderPage(d);
    })
    .add('/admin/tournament', function () {
      if (!App.Admin || !App.Admin.isAdmin()) { go('/'); return; }
      var d = el('div', { class: 'view-page' }); mount(d);
      return App.TournamentAdmin.renderPage(d);
    })
    .setNotFound(renderMenu);

  function boot() {
    syncBalance();
    askNameIfNeeded();
    App.Router.start();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
