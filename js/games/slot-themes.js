/* slot-themes.js — die einzelnen Themen-Slotmaschinen.
 *
 * Jedes Theme ist reine Konfiguration; die Spiellogik liegt in slot-engine.js.
 * Die Gewichte/Auszahlungen sind mit tools/slot-rtp.js gegengerechnet
 * (Ziel: RTP je Automat ~93-95 %, wie beim alten Dschungel-Slot).
 *
 * feature:
 *   'classic'    — nur Linien (3 Walzen)
 *   'freespins'  — Scatter -> Freispiele (optional mit Expanding-Symbol)
 *   'multiplier' — jedes Wild in der Gewinnlinie verdoppelt
 *   'pick'       — Scatter -> Truhen-Bonus (3 aus 9)
 *   'cascade'    — Gewinnsymbole fallen weg, Kettenmultiplikator
 *   'respin'     — Wilds bleiben kleben, Gratis-Respins
 *   'holdwin'    — Münzen sammeln (theme.coin), Respins bis nichts Neues kommt
 *   'streak'     — Multiplikator steigt mit jeder Gewinnrunde in Folge
 *   'expandwild' — Wild füllt seine Walze, danach ein Gratis-Nachdrehen
 *   'penalty'    — Scatter -> Elfmeterschießen mit Mitnehmen-Entscheidung
 */
(function () {
  'use strict';
  window.App = window.App || {};
  App.Games = App.Games || {};

  var THEMES = [

    /* ---------------- 1. Klassiker: Früchte ---------------- */
    {
      id: 'slotfruit', title: 'Fruit Fever', icon: '🍒',
      subtitle: '3 Walzen, 5 Linien — der Klassiker mit vielen kleinen Treffern',
      reels: 3, rows: 3, feature: 'classic', rtp: 94,
      hint: 'Viele kleine Gewinne, kleines Risiko.',
      featureText: '⭐ Stern ist Wild und ersetzt jedes Symbol. Drei Sterne zahlen den Höchstgewinn.',
      colors: { a: '#ff5c8a', b: '#ffd23f', bg1: 'rgba(30,6,16,.95)', bg2: 'rgba(52,12,28,.85)', glow: 'rgba(255,92,138,.55)' },
      wild: 'star',
      symbols: [
        { id: 'cherry', emoji: '🍒', name: 'Kirsche', weight: 30, pay: { 3: 13 } },
        { id: 'lemon',  emoji: '🍋', name: 'Zitrone', weight: 26, pay: { 3: 16 } },
        { id: 'orange', emoji: '🍊', name: 'Orange',  weight: 22, pay: { 3: 23 } },
        { id: 'grape',  emoji: '🍇', name: 'Traube',  weight: 16, pay: { 3: 35 } },
        { id: 'melon',  emoji: '🍉', name: 'Melone',  weight: 11, pay: { 3: 52 } },
        { id: 'bell',   emoji: '🔔', name: 'Glocke',  weight: 7,  pay: { 3: 105 } },
        { id: 'seven',  emoji: '7️⃣', name: 'Sieben',  weight: 4,  pay: { 3: 260 } },
        { id: 'star',   emoji: '⭐', name: 'Stern',   weight: 2,  pay: { 3: 701 } }
      ]
    },

    /* ---------------- 2. Ägypten: Freispiele + Expanding ---------------- */
    {
      id: 'slotegypt', title: 'Pharaos Buch', icon: '🏺',
      subtitle: '5 Walzen — 3 Bücher bringen 10 Freispiele mit Sondersymbol',
      reels: 5, rows: 3, feature: 'freespins', rtp: 94,
      hint: 'Hohe Schwankung, dafür fette Freispiele.',
      featureText: '📕 Das Buch ist Wild UND Scatter. Drei Bücher irgendwo starten 10 Freispiele: dabei wird ein Zufallssymbol gezogen, das über die ganze Walze expandiert und egal wo zahlt.',
      colors: { a: '#ffd23f', b: '#e8b04b', bg1: 'rgba(28,20,4,.95)', bg2: 'rgba(48,34,8,.85)', glow: 'rgba(255,210,63,.55)' },
      wild: 'book',
      // Scatter-Auszahlung gilt auf den GESAMTeinsatz (nicht je Linie).
      scatter: { id: 'book', trigger: 3, freeSpins: 10, expanding: true, label: 'Freispiele', pay: { 3: 2, 4: 20, 5: 200 } },
      symbols: [
        { id: 'vase',   emoji: '🏺', name: 'Vase',       weight: 30, pay: { 3: 2,  4: 9,   5: 37 } },
        { id: 'cat',    emoji: '🐈', name: 'Katze',      weight: 26, pay: { 3: 2,  4: 12,  5: 46 } },
        { id: 'scarab', emoji: '🪲', name: 'Skarabäus',  weight: 20, pay: { 3: 3,  4: 15,  5: 66 } },
        { id: 'falcon', emoji: '🦅', name: 'Falke',      weight: 15, pay: { 3: 4,  4: 20,  5: 92 } },
        { id: 'camel',  emoji: '🐫', name: 'Kamel',      weight: 10, pay: { 3: 6,  4: 34,  5: 167 } },
        { id: 'crown',  emoji: '👑', name: 'Pharao',     weight: 6,  pay: { 3: 9,  4: 52,  5: 335 } },
        { id: 'book',   emoji: '📕', name: 'Buch',       weight: 5,  pay: { 3: 9,  4: 52,  5: 335 } }
      ]
    },

    /* ---------------- 3. Weltraum: Wild-Multiplikator ---------------- */
    {
      id: 'slotspace', title: 'Neon Nebula', icon: '🚀',
      subtitle: '5 Walzen — jedes Wild in der Linie verdoppelt den Gewinn',
      reels: 5, rows: 3, feature: 'multiplier', wildMult: 2, rtp: 91,
      hint: 'Zwei Wilds in einer Linie = vierfacher Gewinn.',
      featureText: '🌌 Der Nebel ist Wild: er ersetzt jedes Symbol und verdoppelt den Liniengewinn. Zwei Nebel in derselben Linie zahlen vierfach.',
      colors: { a: '#7c5cff', b: '#33e6d0', bg1: 'rgba(6,6,26,.95)', bg2: 'rgba(14,10,44,.85)', glow: 'rgba(124,92,255,.6)' },
      wild: 'nebula',
      symbols: [
        { id: 'scope',  emoji: '🔭', name: 'Teleskop',  weight: 30, pay: { 3: 2,  4: 10,  5: 37 } },
        { id: 'sat',    emoji: '🛰️', name: 'Satellit',  weight: 25, pay: { 3: 3,  4: 11,  5: 48 } },
        { id: 'comet',  emoji: '☄️', name: 'Komet',     weight: 20, pay: { 3: 4,  4: 16,  5: 71 } },
        { id: 'planet', emoji: '🪐', name: 'Planet',    weight: 15, pay: { 3: 4,  4: 22,  5: 104 } },
        { id: 'alien',  emoji: '👽', name: 'Alien',     weight: 10, pay: { 3: 7,  4: 36,  5: 174 } },
        { id: 'rocket', emoji: '🚀', name: 'Rakete',    weight: 6,  pay: { 3: 11, 4: 61,  5: 326 } },
        { id: 'nebula', emoji: '🌌', name: 'Nebel',     weight: 4,  pay: { 3: 13, 4: 77,  5: 434 } }
      ]
    },

    /* ---------------- 4. Piraten: Truhen-Bonus ---------------- */
    {
      id: 'slotpirate', title: 'Piratenbucht', icon: '🏴‍☠️',
      subtitle: '5 Walzen — 3 Schatzkarten öffnen die Truhen-Suche',
      reels: 5, rows: 3, feature: 'pick', rtp: 94,
      hint: 'Der Bonus zahlt bis zum 33-fachen Einsatz.',
      featureText: '🗺️ Drei Schatzkarten starten die Schatzsuche: du öffnest 3 von 9 Truhen, die Multiplikatoren werden addiert (bis ×33 Gesamteinsatz). 🏴‍☠️ Die Flagge ist Wild.',
      pickCount: 3, pickPool: [1, 1, 1, 2, 2, 3, 5, 8, 20],
      colors: { a: '#ffb020', b: '#39ff14', bg1: 'rgba(6,20,26,.95)', bg2: 'rgba(10,36,44,.85)', glow: 'rgba(255,176,32,.55)' },
      wild: 'flag',
      scatter: { id: 'map', trigger: 3, label: 'Schatzsuche', pay: { 3: 1, 4: 5, 5: 25 } },
      symbols: [
        { id: 'beer',   emoji: '🍺', name: 'Rum',        weight: 30, pay: { 3: 3,  4: 15,  5: 61 } },
        { id: 'compass',emoji: '🧭', name: 'Kompass',    weight: 25, pay: { 3: 4,  4: 18,  5: 78 } },
        { id: 'sword',  emoji: '🗡️', name: 'Säbel',      weight: 19, pay: { 3: 7,  4: 29,  5: 123 } },
        { id: 'parrot', emoji: '🦜', name: 'Papagei',    weight: 14, pay: { 3: 8,  4: 42,  5: 184 } },
        { id: 'anchor', emoji: '⚓', name: 'Anker',      weight: 10, pay: { 3: 13, 4: 63,  5: 307 } },
        { id: 'skull',  emoji: '💀', name: 'Totenkopf',  weight: 6,  pay: { 3: 22, 4: 108, 5: 567 } },
        { id: 'flag',   emoji: '🏴‍☠️', name: 'Flagge',    weight: 3,  pay: { 3: 31, 4: 167, 5: 869 } },
        { id: 'map',    emoji: '🗺️', name: 'Schatzkarte', weight: 4 }
      ]
    },

    /* ---------------- 5. Süßigkeiten: Kettenreaktion ---------------- */
    {
      id: 'slotcandy', title: 'Candy Cascade', icon: '🍬',
      subtitle: '5 Walzen — Gewinne fallen weg, neue rutschen nach',
      reels: 5, rows: 3, feature: 'cascade', rtp: 94,
      hint: 'Jede Kette zahlt mehr: ×2, ×3, ×4, ×5.',
      featureText: '🍬 Nach jedem Gewinn verschwinden die Symbole und neue rutschen nach. Zahlt die Kette erneut, steigt der Multiplikator auf ×2, ×3, ×4 und ×5. 🌈 Der Regenbogen ist Wild.',
      colors: { a: '#ff6ec7', b: '#ffd23f', bg1: 'rgba(34,8,30,.95)', bg2: 'rgba(58,14,52,.85)', glow: 'rgba(255,110,199,.6)' },
      wild: 'rainbow',
      symbols: [
        { id: 'straw',  emoji: '🍓', name: 'Erdbeere',  weight: 28, pay: { 3: 2,  4: 10,  5: 38 } },
        { id: 'cream',  emoji: '🍦', name: 'Eis',       weight: 24, pay: { 3: 3,  4: 13,  5: 51 } },
        { id: 'choco',  emoji: '🍫', name: 'Schoko',    weight: 19, pay: { 3: 4,  4: 19,  5: 80 } },
        { id: 'donut',  emoji: '🍩', name: 'Donut',     weight: 14, pay: { 3: 6,  4: 28,  5: 127 } },
        { id: 'cake',   emoji: '🧁', name: 'Cupcake',   weight: 10, pay: { 3: 9,  4: 44,  5: 204 } },
        { id: 'lolly',  emoji: '🍭', name: 'Lolli',     weight: 6,  pay: { 3: 15, 4: 75,  5: 381 } },
        { id: 'rainbow',emoji: '🌈', name: 'Regenbogen',weight: 3,  pay: { 3: 22, 4: 119, 5: 592 } }
      ]
    },

    /* ---------------- 6. Horror: Sticky-Wilds ---------------- */
    {
      id: 'slothorror', title: 'Blutmond', icon: '🧛',
      subtitle: '5 Walzen — Vollmonde bleiben kleben und geben Gratis-Respins',
      reels: 5, rows: 3, feature: 'respin', rtp: 92,
      hint: 'Selten, aber wenn, dann richtig.',
      featureText: '🌕 Jeder Vollmond ist Wild, bleibt kleben und löst einen Gratis-Respin aus. Landen dabei weitere Monde, geht es weiter — bis zu 8 Respins.',
      colors: { a: '#ff2e4d', b: '#b06cff', bg1: 'rgba(14,2,6,.96)', bg2: 'rgba(30,4,14,.88)', glow: 'rgba(255,46,77,.6)' },
      wild: 'moon',
      symbols: [
        { id: 'candle', emoji: '🕯️', name: 'Kerze',     weight: 30, pay: { 3: 2,  4: 11,  5: 50 } },
        { id: 'spider', emoji: '🕷️', name: 'Spinne',    weight: 25, pay: { 3: 3,  4: 15,  5: 69 } },
        { id: 'bat',    emoji: '🦇', name: 'Fledermaus',weight: 19, pay: { 3: 4,  4: 24,  5: 108 } },
        { id: 'coffin', emoji: '⚰️', name: 'Sarg',      weight: 14, pay: { 3: 6,  4: 34,  5: 164 } },
        { id: 'ghost',  emoji: '👻', name: 'Geist',     weight: 9,  pay: { 3: 10, 4: 54,  5: 272 } },
        { id: 'zombie', emoji: '🧟', name: 'Zombie',    weight: 6,  pay: { 3: 16, 4: 88,  5: 476 } },
        { id: 'vamp',   emoji: '🧛', name: 'Vampir',    weight: 3,  pay: { 3: 27, 4: 157, 5: 1019 } },
        { id: 'moon',   emoji: '🌕', name: 'Vollmond',  weight: 3,  pay: { 3: 22, 4: 125, 5: 680 } }
      ]
    },

    /* ---------------- 7. Asien: Münzen sammeln (Hold & Win) ---------------- */
    {
      id: 'slotdragon', title: 'Drachen-Gold', icon: '🐉',
      subtitle: '5 Walzen — sechs Münzen starten den Sammel-Bonus',
      reels: 5, rows: 3, feature: 'holdwin', rtp: 93,
      hint: 'Jede neue Münze schenkt dir die Respins zurück.',
      featureText: '🪙 Sechs oder mehr Münzen starten den Sammel-Bonus: die Münzen bleiben liegen, du bekommst 3 Respins, und jede neue Münze setzt die Respins wieder auf 3. Am Ende zahlt die Summe aller Münzwerte — ein volles Bild bringt zusätzlich den Hauptpreis.',
      colors: { a: '#ff3b30', b: '#ffd23f', bg1: 'rgba(28,4,6,.95)', bg2: 'rgba(52,10,12,.85)', glow: 'rgba(255,59,48,.55)' },
      wild: 'dragon',
      coin: { id: 'coin', trigger: 6, respins: 3, chance: 0.075, grand: 150, values: [1, 1, 1, 2, 2, 3, 5, 10] },
      symbols: [
        { id: 'fan',    emoji: '🪭', name: 'Fächer',    weight: 28, pay: { 3: 2,  4: 11,  5: 41 } },
        { id: 'lamp',   emoji: '🏮', name: 'Laterne',   weight: 24, pay: { 3: 3,  4: 14,  5: 55 } },
        { id: 'fish',   emoji: '🐟', name: 'Koi',       weight: 19, pay: { 3: 4,  4: 20,  5: 81 } },
        { id: 'tiger',  emoji: '🐯', name: 'Tiger',     weight: 14, pay: { 3: 7,  4: 29,  5: 122 } },
        { id: 'ingot',  emoji: '💰', name: 'Goldbarren',weight: 9,  pay: { 3: 11, 4: 50,  5: 224 } },
        { id: 'dragon', emoji: '🐉', name: 'Drache',    weight: 4,  pay: { 3: 24, 4: 120, 5: 611 } },
        { id: 'coin',   emoji: '🪙', name: 'Münze',     weight: 17 }
      ]
    },

    /* ---------------- 8. Wikinger: Siegesserie ---------------- */
    {
      id: 'slotviking', title: 'Walhalla', icon: '⚔️',
      subtitle: '5 Walzen — jede Gewinnrunde in Folge erhöht den Multiplikator',
      reels: 5, rows: 3, feature: 'streak', rtp: 91,
      hint: 'Zwei Gewinne hintereinander zahlen doppelt, drei dreifach, ab vier fünffach.',
      featureText: '⚔️ Nach jeder Gewinnrunde steigt der Multiplikator für die NÄCHSTE Runde: ×2, ×3 und ab der vierten ×5. Eine Runde ohne Gewinn reißt die Serie und setzt zurück auf ×1.',
      colors: { a: '#5ac8fa', b: '#c0c8d0', bg1: 'rgba(6,14,24,.95)', bg2: 'rgba(12,26,42,.85)', glow: 'rgba(90,200,250,.55)' },
      wild: 'thor',
      symbols: [
        { id: 'horn',   emoji: '🥂', name: 'Methorn',   weight: 30, pay: { 3: 2,  4: 6,   5: 24 } },
        { id: 'shield', emoji: '🛡️', name: 'Schild',    weight: 25, pay: { 3: 2,  4: 8,   5: 31 } },
        { id: 'boat',   emoji: '⛵', name: 'Drachenboot',weight: 20, pay: { 3: 2,  4: 11,  5: 45 } },
        { id: 'axe',    emoji: '🪓', name: 'Streitaxt', weight: 14, pay: { 3: 4,  4: 16,  5: 68 } },
        { id: 'raven',  emoji: '🐦‍⬛', name: 'Rabe',     weight: 9,  pay: { 3: 6,  4: 28,  5: 122 } },
        { id: 'thor',   emoji: '🔨', name: 'Hammer',    weight: 4,  pay: { 3: 13, 4: 65,  5: 325 } }
      ]
    },

    /* ---------------- 9. Wilder Westen: Wild füllt die Walze ---------------- */
    {
      id: 'slotwest', title: 'Goldrausch', icon: '🤠',
      subtitle: '5 Walzen — jeder Sheriffstern füllt seine Walze und dreht gratis nach',
      reels: 5, rows: 3, feature: 'expandwild', rtp: 94,
      hint: 'Ein Stern macht die ganze Walze wild — und das Nachdrehen ist umsonst.',
      featureText: '⭐ Landet ein Sheriffstern, wird seine komplette Walze zu Wild und die Runde wird sofort neu bewertet. Danach gibt es ein Gratis-Nachdrehen mit demselben Einsatz.',
      colors: { a: '#e8a33d', b: '#d96c2c', bg1: 'rgba(28,16,6,.95)', bg2: 'rgba(48,28,12,.85)', glow: 'rgba(232,163,61,.55)' },
      wild: 'star',
      symbols: [
        { id: 'boot',   emoji: '👢', name: 'Stiefel',   weight: 30, pay: { 3: 2,  4: 10,  5: 36 } },
        { id: 'hat',    emoji: '🤠', name: 'Hut',       weight: 25, pay: { 3: 3,  4: 13,  5: 46 } },
        { id: 'horse',  emoji: '🐎', name: 'Pferd',     weight: 20, pay: { 3: 4,  4: 17,  5: 68 } },
        { id: 'cactus', emoji: '🌵', name: 'Kaktus',    weight: 14, pay: { 3: 6,  4: 25,  5: 101 } },
        { id: 'gun',    emoji: '🔫', name: 'Revolver',  weight: 9,  pay: { 3: 10, 4: 42,  5: 179 } },
        { id: 'nugget', emoji: '💎', name: 'Goldnugget',weight: 5,  pay: { 3: 19, 4: 90,  5: 443 } },
        { id: 'star',   emoji: '⭐', name: 'Sheriffstern', weight: 2, pay: { 3: 26, 4: 127, 5: 634 } }
      ]
    },

    /* ---------------- 10. Fußball: Elfmeterschießen ---------------- */
    {
      id: 'slotsoccer', title: 'Elfmeter-Fieber', icon: '⚽',
      subtitle: '5 Walzen — 3 Pfiffe und du stehst selbst am Punkt',
      reels: 5, rows: 3, feature: 'penalty', rtp: 92,
      hint: 'Im Bonus entscheidest du: weiterschießen oder Gewinn mitnehmen.',
      featureText: '⚽ Drei Schiedsrichter-Pfiffe starten das Elfmeterschießen: du wählst pro Schuss die Ecke, jeder Treffer hebt den Gewinn (×2 · ×4 · ×7 · ×12 · ×25). Nach jedem Tor darfst du mitnehmen oder weiterschießen — hält der Torwart, ist alles weg.',
      penaltySteps: [2, 4, 7, 12, 25], penaltySave: 0.42,
      colors: { a: '#39ff14', b: '#ffffff', bg1: 'rgba(4,20,8,.95)', bg2: 'rgba(8,40,16,.85)', glow: 'rgba(57,255,20,.5)' },
      wild: 'ball',
      scatter: { id: 'whistle', trigger: 3, label: 'Elfmeterschießen', pay: { 3: 1, 4: 4, 5: 20 } },
      symbols: [
        { id: 'sock',   emoji: '🧦', name: 'Stutzen',   weight: 29, pay: { 3: 3,  4: 17,  5: 66 } },
        { id: 'card',   emoji: '🟨', name: 'Gelbe Karte',weight: 24, pay: { 3: 5,  4: 23,  5: 87 } },
        { id: 'shoe',   emoji: '👟', name: 'Schuh',     weight: 19, pay: { 3: 7,  4: 31,  5: 126 } },
        { id: 'shirt',  emoji: '👕', name: 'Trikot',    weight: 14, pay: { 3: 10, 4: 47,  5: 192 } },
        { id: 'goal',   emoji: '🥅', name: 'Tor',       weight: 9,  pay: { 3: 17, 4: 79,  5: 341 } },
        { id: 'cup',    emoji: '🏆', name: 'Pokal',     weight: 5,  pay: { 3: 31, 4: 154, 5: 770 } },
        { id: 'ball',   emoji: '⚽', name: 'Ball',      weight: 3,  pay: { 3: 45, 4: 227, 5: 1155 } },
        { id: 'whistle',emoji: '📣', name: 'Pfiff',     weight: 6 }
      ]
    }
  ];

  App.SlotThemes = THEMES;

  // Als Spiele registrieren (Engine muss vorher geladen sein).
  if (App.SlotEngine) {
    THEMES.forEach(function (t) {
      App.Games[t.id] = App.SlotEngine.create(t);
    });
  }
})();
