/* changelog.js — Update-News. Zeigt kurz & knapp, was zuletzt neu dazukam.
 *
 * NEUEN EINTRAG HINZUFÜGEN:
 * Oben in ENTRIES ein neues Objekt einfügen (neuestes zuerst!):
 *   { date: '2026-07-18', title: 'Optionaler Titel', items: [
 *       'Kurz und knapp, was neu ist',
 *       'Noch eine Sache',
 *   ] }
 * Der oberste Eintrag wird automatisch als „NEU" markiert.
 * Tipp: Beim Deployen daran denken, auch version.json + js/version.js
 * auf einen neuen Wert zu setzen, damit alle das Update sehen.
 */
(function () {
  'use strict';
  window.App = window.App || {};
  var UI = App.UI, el = UI.el, go = function (p) { App.Router.go(p); };

  var ENTRIES = [
    {
      date: '2026-07-17',
      title: 'Aktien jetzt LIVE & extrem',
      items: [
        'Aktien laufen jetzt LIVE: jede Sekunde ein neuer Kurs (statt alle 10 s) — Preise, Charts und Depotwert aktualisieren sich flüssig.',
        'Extrem extrem: einzelne Kurssprünge bis zu 200 % pro Tick (vorher 150 %). Bleibt trotzdem im Kursband und für alle Spieler gleich.',
      ]
    },
    {
      date: '2026-07-17',
      title: 'Farbige Namen & 30 Schriftarten',
      items: [
        'Neu im Profil: färbe deinen Namen — über 60 Farben plus animierte Verläufe (Regenbogen, Feuer, Galaxie, Plasma …).',
        '30 richtig coole Schriftarten für deinen Namen zur Auswahl (Orbitron, Bungee, Press Start 2P, Nabla u. v. m.).',
        'Deine Farbe & Schrift sieht jeder — in der Bestenliste, im Chat und auf deiner Profilkarte.',
      ]
    },
    {
      date: '2026-07-17',
      title: 'COURS & Update-News',
      items: [
        'COURS deutlich steiler gemacht: jeder Tick bewegt den Kurs jetzt um 3–22 % (statt 1–10 %) — viel heftigere Ausschläge.',
        'Neu: COURS — ein einziger, wilder Kurs, der ohne Pause steigt und fällt (3 Ticks/Sekunde, jeder Tick 3–22 %). Für alle Spieler gleich, jederzeit ein- und aussteigen.',
        'Admin kann die COURS-Geschwindigkeit für alle live einstellen.',
        'Diese Update-News-Seite: hier steht ab jetzt kurz & knapp, was neu dazukommt.',
      ]
    },
    {
      date: '2026-07-17',
      title: 'Riesen-Spiele-Charge & Turniere für alle',
      items: [
        '40 neue Online-Spiele live: Tetris, Breakout, Space Invaders, Pac-Man, Slither, Paper.io, Elfmeter, Flipper, Ludo, Backgammon u. v. m.',
        'Jeder kann jetzt selbst Turniere hosten — der Einsatz des Hosts ist das Preisgeld (50 / 30 / 20 % für die ersten drei).',
        'Turnier-Host-Knopf aus jedem Ruhezustand & aus dem Wartebereich erreichbar.',
        'Ideen-Briefkasten: bestätigte Ideen bringen Belohnung + goldene Ideen-Glühbirnen, die für immer bleiben.',
        'Admin-Login bekommt ein echtes, geräteübergreifendes Konto (Level & Kontostand waren vorher nur lokal).',
        'Chip-Kasse: kein XP-Verlust mehr fürs Kaufen/Verkaufen von Chips.',
        'Neue Spiele Jenga & Double or Nothing; Crash-Cashout schon ab 1,1×.',
      ]
    },
    {
      date: '2026-07-16',
      title: 'Ideen, Aktien & 30 Multiplayer-Spiele',
      items: [
        '30 neue Online-Multiplayer-Minispiele.',
        'Spielideen-Briefkasten (💡-Knopf oben) — deine Ideen landen direkt beim Admin.',
        'Online-Hub mit Suchleiste + Favoriten (Stern pro Spiel).',
        'Turnier-Preise als Power-Up-Sammlung, 6 neue Belohnungen.',
        'Bestenliste zeigt jetzt jeden Spieler, nicht nur die Top 10.',
        'Admin-Panel neu gestaltet: Shoutout an alle + ausklappbare Spielerkarten.',
      ]
    },
    {
      date: '2026-07-15',
      title: 'Survival, Aktienmarkt & Turniermodus',
      items: [
        'Survival-Modus (Gold-Coins): pleite heißt alles auf null + eine Stunde Pause, mit eigener Live-Rangliste.',
        'Aktienmarkt: 20 Aktien, alle paar Sekunden ein neuer Kurs.',
        'Turniermodus mit angesetzten Turnieren, Tickets aus Quests & Power-Up für den Sieger.',
        'Quests & Level-System, Gratis-Coins-Knopf und Pokerchips-Kasse.',
        'Casino-Fortschritt hängt jetzt am Konto (geräteübergreifend).',
      ]
    },
    {
      date: '2026-07-14',
      title: 'Der Grundstein: Casino, Poker & Sound',
      items: [
        '16 Gambling-Klassiker + 4 Poker-Tische (Hold\'em / Omaha / Stud / Five-Draw) und Casino-Spiele mit Freunden.',
        'Level-, XP- & Quest-System mit anpassbarer Profilkarte (Avatar / Rahmen / Banner / Titel).',
        '10 Farb-Styles (Themes), spielspezifische Sounds & Menü-Musik.',
        'Täglicher Bonus (Streak) und Konfetti bei großen Gewinnen.',
        'Konten mit Passwort-Login, geräteübergreifend live.',
      ]
    }
  ];

  function renderPage(container) {
    container.appendChild(el('div', { class: 'page-head' }, [
      el('button', { class: 'btn btn-ghost back', type: 'button', onclick: function () { go('/'); } }, ['← Menü']),
      el('h2', { class: 'page-title neon' }, ['🆕 Update-News'])
    ]));
    container.appendChild(el('p', { class: 'lb-hint' }, ['Was zuletzt neu dazukam — das Neueste steht ganz oben.']));

    var list = ENTRIES.map(function (entry, i) {
      var head = [el('span', { class: 'cl-date' }, [formatDate(entry.date)])];
      if (i === 0) head.push(el('span', { class: 'cl-badge' }, ['NEU']));
      var rows = [el('div', { class: 'cl-head' }, head)];
      if (entry.title) rows.push(el('div', { class: 'cl-title' }, [entry.title]));
      rows.push(el('ul', { class: 'cl-items' }, entry.items.map(function (t) {
        return el('li', {}, [t]);
      })));
      return el('div', { class: 'glass cl-card' }, rows);
    });

    container.appendChild(el('div', { class: 'cl-list' }, list));
  }

  function formatDate(iso) {
    var p = (iso || '').split('-');
    if (p.length !== 3) return iso;
    return p[2] + '.' + p[1] + '.' + p[0];
  }

  App.Changelog = { renderPage: renderPage, entries: ENTRIES };
})();
