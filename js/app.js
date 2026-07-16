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
        'baccarat', 'videopoker', 'casinowar', 'dragontiger', 'andarbahar', 'sicbo', 'keno', 'plinko'],
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
      desc: '20 Aktien von 100 bis 1.000 Coins. Alle 25 Sekunden ein neuer Kurs — kaufen, halten, im richtigen Moment verkaufen.',
      route: '/stocks',
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
      desc: 'Angesetzte Turniere über mehrere Runden. Eintritt kostet Tickets, der Sieger holt sich ein Power-Up.',
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
        el('button', { class: 'btn btn-ghost', type: 'button', onclick: function () { go('/chips'); } }, ['🎟️ Pokerchips-Kasse']),
        el('button', { class: 'btn btn-ghost', type: 'button', onclick: function () { go('/leaderboard'); } }, ['🏆 Bestenliste']),
        el('button', { class: 'btn btn-ghost', type: 'button', onclick: function () { go('/profile'); } }, ['👤 Profil']),
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

    function draw() {
      // Diese Bestenliste ist die des Casinos (Silber). Läuft gerade ein Survival-Run,
      // gehört dessen Gold-Peak NICHT hierher — Survival hat seine eigene Rangliste.
      var activePeak = (App.Mode && App.Mode.is('survival')) ? null : App.Coins.getPeak();
      // Kein Top-10-Deckel mehr: jeder Spieler soll sich selbst finden können.
      var board = App.Leaderboard.getBoard(activePeak, 200);
      var rows = board.map(function (entry, i) {
        var rank = i + 1;
        var dateTxt = entry.active ? 'läuft gerade' : (entry.online ? 'online' : (entry.date || '—'));
        return el('div', { class: 'lb-row glass ' + medalClass(rank) + (entry.active ? ' active' : '') }, [
          el('div', { class: 'lb-rank' }, [wreath(rank) || ('#' + rank)]),
          el('div', { class: 'lb-name' }, [
            el('span', {}, [entry.name || 'Anonym']),
            entry.active ? el('span', { class: 'lb-tag' }, ['aktiver Run'])
              : (entry.online ? el('span', { class: 'lb-tag lb-tag-on' }, ['🟢 online']) : null)
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
      var shared = App.Account.backendKind() === 'firebase' || App.Account.backendKind() === 'cloud';
      var hint = shared
        ? 'Höchster Silber-Stand (Peak) — eine Zeile pro Spieler. Jeder, der die Seite offen hat, steht automatisch drauf: man muss nicht erst pleitegehen. Neue Spieler tauchen nach ein paar Sekunden auf.'
        : 'Höchster Silber-Stand (Peak) — eine Zeile pro Spieler. Kein Cloud-Backend erreichbar: aktuell nur Spieler aus diesem Browser sichtbar.';
      container.appendChild(el('p', { class: 'lb-hint' }, [hint]));
      container.appendChild(el('div', { class: 'lb-list' }, rows));
    }

    draw();
    var off1 = App.Coins.onChange(draw);
    var off2 = App.Leaderboard.onChange(draw);
    return function () { off1(); off2(); };
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
          if (App.Admin && App.Admin.tryLogin(loginName.value, loginPw.value)) {
            UI.toast('🛠 Admin-Modus aktiviert', 'win');
            go('/category/gambling');
            return;
          }
          App.Account.login(loginName.value, loginPw.value).then(function () {
            UI.toast('Angemeldet als ' + loginName.value, 'win');
            draw();
          }).catch(function (e) { UI.toast(e.message, 'lose'); });
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
    gameOverActive = true;
    var peak = info && info.peak != null ? info.peak : App.Coins.getPeak();
    var name = App.Leaderboard.getPlayerName() || 'Anonym';
    var date = new Date().toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
    App.Leaderboard.recordRun(name, peak, date);

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
    .add('/quests', function () { var d = el('div', { class: 'view-page' }); mount(d); App.Progress.renderPage(d); })
    .add('/chips', function () { var d = el('div', { class: 'view-page' }); mount(d); return App.Chips.renderPage(d); })
    .add('/settings', function () { var d = el('div', { class: 'view-page' }); mount(d); App.Settings.renderPage(d); })
    .add('/profile', renderProfile)
    .add('/tournament', function () {
      // Auch beim direkten Aufruf über die Adresszeile: im Turnier wird mit
      // Silber gespielt, nie mit dem Survival-Gold.
      if (App.Mode) App.Mode.set('casino');
      var d = el('div', { class: 'view-page' }); mount(d);
      return App.TournamentUI.renderPage(d);
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
