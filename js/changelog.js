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
      date: '2026-07-24',
      title: 'Neues Spiel: Rubbellos 🎟️',
      items: [
        'Jungle-Rubbellos in der Gambling-Kategorie: Los kaufen und die 9 Felder mit dem Finger oder der Maus WIRKLICH freirubbeln (oder ⚡ alles aufdecken).',
        '3 gleiche Symbole gewinnen: 🌴×1.5, 🍌×2.5, 🍀×5, 🔔×10, 🏆×20, 💎×50 — Auszahlungsquote ~96 %, wie bei den anderen Klassikern.',
      ]
    },
    {
      date: '2026-07-24',
      title: 'Der große Reset: fairer Neustart für alle',
      items: [
        'KOMPLETTER RESET für alle Spieler: Guthaben, Bank, Aktien-Depots, Level, Quests, Tickets, Power-Ups und der Geld-Rekord (Peak) starten bei null bzw. 1.000 Coins. Deine SPIEL-Stats bleiben: Runden, Siege, Sieg-Serien, Spielzeit und gespielte Spiele.',
        'Es gibt kein „unendlich" mehr: Höchstlevel 99.999 (goldener Name), Guthaben- und Bank-Maximum 1 Billiarde, Tickets maximal 999. Alle Zahlen bleiben dadurch immer exakt.',
        'Busfahrer 🚌 war eine Geld-Druckmaschine (bis zu 142 % Auszahlung) — die Multiplikatoren sind jetzt fair kalibriert (×1.9/×2.6/×3.9/×16).',
        'Pferderennen 🐎: der Favorit gewann 73 % der Rennen (Dauergewinn), die Außenseiter NIE. Jetzt passen die Siegchancen zu neuen, fairen Quoten (2.3 bis 13).',
        'Plinko 🎯 zahlte real nur ~79 % aus — die mittleren Felder geben jetzt mehr (~96,6 % wie die anderen Spiele).',
        'Verschenken aufgeräumt: es gibt nur noch EINE Verschenken-Seite (💸). Ein Fehler, durch den beim Verschenken Coins aus dem Nichts entstehen konnten, ist behoben — und 💸-Geschenke zählen jetzt für die Schenker-Rangliste.',
        'Tagesbonus, Quest- und Level-Belohnungen verbrauchen keine Gewinn-Power-Ups mehr und werden nicht mehr vom Glücks-Rigging verändert.',
        'Wett-Kämpfe (1v1): kein doppeltes Auszahlen des Pots mehr, und wer sich ein beendetes Match nochmal ansieht, zahlt nicht nochmal den Einsatz.',
      ]
    },
    {
      date: '2026-07-22',
      title: 'Vier weitere Automaten: Drachen, Wikinger, Wilder Westen & Elfmeter',
      items: [
        'Drachen-Gold 🐉 — sechs Münzen starten den Sammel-Bonus: Münzen bleiben liegen, jede neue schenkt dir die Respins zurück, am Ende zahlt die Summe. Volles Bild = Hauptpreis.',
        'Walhalla ⚔️ — jede Gewinnrunde in Folge erhöht den Multiplikator: ×2, ×3, ab der vierten ×5. Eine Nullrunde reißt die Serie.',
        'Goldrausch 🤠 — jeder Sheriffstern macht seine ganze Walze wild, und danach gibt es ein Gratis-Nachdrehen.',
        'Elfmeter-Fieber ⚽ — drei Pfiffe und du stehst selbst am Punkt: Ecke wählen, jeder Treffer erhöht den Gewinn (bis ×25), nach jedem Tor darfst du mitnehmen oder weiterschießen.',
        'Damit stehen 11 Automaten in der Kategorie 🎰 Slot-Maschinen.',
      ]
    },
    {
      date: '2026-07-22',
      title: 'Sechs neue Slot-Maschinen & das Spiel „Nähe"',
      items: [
        'Neue Kategorie 🎰 Slot-Maschinen: sechs Automaten mit eigenem Thema — Fruit Fever 🍒, Pharaos Buch 🏺, Neon Nebula 🚀, Piratenbucht 🏴‍☠️, Candy Cascade 🍬 und Blutmond 🧛. Der alte Automat heißt jetzt Dschungel-Slots.',
        'Jeder Automat hat sein eigenes Sonderfeature: 10 Freispiele mit expandierendem Symbol, Wilds die den Gewinn verdoppeln, Truhen-Schatzsuche, Kettenreaktionen bis ×5 und Vollmonde, die kleben bleiben und Gratis-Respins geben.',
        'Autospin-Knopf (10 Runden) und eine ausklappbare Gewinntabelle in jedem Automaten.',
        'Neues Spiel: Nähe 🎯 — 15×15 Felder, jeder Klick verrät, wie weit das versteckte Ziel entfernt ist. Wer bis zum 4. Versuch trifft, gewinnt; ein Sofort-Treffer zahlt ×48.',
      ]
    },
    {
      date: '2026-07-22',
      title: 'Unendlich-Update: Level, Crash, Mods & mehr',
      items: [
        'Level ohne Ende: kein Maximum mehr — höhere Level dauern länger, und das Auffüll-Geld bei Pleite wächst mit dem Level bis ins Astronomische (neue Einheiten dx, fx … yx, SKD und weiter).',
        'COURS ist viel wilder und kann jetzt CRASHEN: selten stürzt der Kurs fast auf null — wer dann drin ist, verliert seinen ganzen Einsatz. Nach oben ist er unbegrenzt.',
        'Neu: Coins an andere Spieler verschenken (🎁) — mit eigener Bestenliste der größten Schenker.',
        'Neue Ranglisten (📊): höchste Level, längste Spielzeit und meistes Verschenken. Deine Spielzeit steht jetzt auch in deinen Stats.',
        'Neues Spiel: Busfahrer 🚌 — vier Stufen (Rot/Schwarz → Höher/Tiefer → Rein/Raus → Symbol) bis ×20.',
        'Moderatoren: der Admin kann Spielern eine Mod-Rolle geben. Mods können an alle shouten und Spielern live zuschauen — mehr nicht. Der Admin sieht alle Mods und ihren Aktions-Verlauf.',
        'Admin kann pro Spieler die Gewinnchancen erzwingen (z. B. Coinflip zu 80 % Verlust, Crash bei genau 1,01×) und Ideen jetzt auch mit Coin-Abzug bestrafen.',
        'Level sind jetzt WIRKLICH unendlich (kein „MAX" mehr) und werden wie Coins mit Einheiten angezeigt. Neuer Einheiten-Katalog (🔢) zeigt, welche Einheit nach welcher kommt.',
        'Du kannst jetzt mehrere eigene Hintergrundbilder sammeln und dazwischen wählen (statt den alten immer zu ersetzen).',
        'Wagern (1v1-Wetten) repariert: Runden starten jetzt zuverlässig und der Pot wird ausgezahlt.',
      ]
    },
    {
      date: '2026-07-18',
      title: 'Schneller leveln & Feinschliff',
      items: [
        'Leveln geht jetzt 5× so schnell — dieselbe Kurve, nur ein Fünftel der XP nötig.',
        'Aktienkurse ticken ruhiger: ein neuer Kurs alle 3 Sekunden (statt jede Sekunde).',
        'Wett-Spiele werden jetzt bequem im Admin-Panel freigegeben (Knopf „⚔️ Wett-Spiele").',
      ]
    },
    {
      date: '2026-07-18',
      title: 'Neu: Wagern — 1v1 um Coins',
      items: [
        'Neue Menü-Kachel ⚔️ Wagern: fordere einen Online-Spieler direkt heraus.',
        'Ihr setzt beide denselben Betrag — der Gewinner bekommt den ganzen Pot.',
        'Spiel, Anzahl Runden und Zeit pro Runde sucht ihr euch beim Herausfordern selbst aus (Best-of-N).',
        'Eine Herausforderung meldet sich mit Popup, egal wo du gerade bist — annehmen und los.',
        'Welche Spiele in einer Wette erlaubt sind, gibt der Admin frei.',
      ]
    },
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
        'Neu: COURS — ein einziger, wilder Kurs, der ohne Pause steigt und fällt (3 Ticks/Sekunde, jeder Tick 1–10 %). Für alle Spieler gleich, jederzeit ein- und aussteigen.',
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
