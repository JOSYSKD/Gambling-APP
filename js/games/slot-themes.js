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
      reels: 5, rows: 3, feature: 'freespins', rtp: 93,
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
      reels: 5, rows: 3, feature: 'multiplier', wildMult: 2, rtp: 92,
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
      reels: 5, rows: 3, feature: 'respin', rtp: 93,
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
