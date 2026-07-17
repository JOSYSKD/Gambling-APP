/* stadtlandfluss.js — "Stadt-Land-Fluss": der Klassiker im Neon-Dschungel.
 *
 * IDEE
 *   Pro Runde wird ein Buchstabe gezogen (für alle derselbe). In 40 Sekunden
 *   tippst du je einen Begriff mit diesem Buchstaben in die 6 Kategorien
 *   Stadt · Land · Fluss · Tier · Name · Beruf. Danach kommt die Auflösung,
 *   dann der nächste Buchstabe. 5 Runden, wer am meisten Punkte hat, gewinnt.
 *
 * STEUERUNG
 *   Tippen in die Felder (echte Text-Eingabe → funktioniert auf Handy/iPad
 *   mit der Bildschirm-Tastatur), Enter springt ins nächste Feld.
 *   Der große "Fertig!"-Knopf ist frei, sobald alle 6 Felder gefüllt sind —
 *   er stoppt die Runde (klassische Stopp-Regel), die anderen bekommen noch
 *   3 Sekunden. Sonst endet die Runde nach 40 s.
 *
 * PUNKTE (automatische Bewertung gegen eingebaute deutsche Wortlisten)
 *   Treffer aus der Liste, nur du hattest ihn        → 10 Punkte
 *   Treffer, aber jemand anderes hatte dasselbe Wort →  5 Punkte
 *   leer, falscher Buchstabe oder nicht in der Liste →  0 Punkte
 *   Umlaute sind tolerant: "München" = "Muenchen" = "Munchen".
 *
 * SOLO
 *   Gegen 3 KI-Mitspieler in drei Stärken (Leicht/Mittel/Profi). Die KI zieht
 *   Wörter aus denselben Listen, braucht pro Feld echte Zeit (Profis sind
 *   schnell und nehmen die naheliegenden Wörter → sie klauen dir die 10er)
 *   und ruft selbst "Fertig!", wenn sie zuerst alle 6 Felder hat. Nur deine
 *   Punkte zählen für den Rekord (App.Storage 'best_stadtlandfluss').
 *
 * SYNC-MODELL (Multiplayer)
 *   Host ist die Wahrheit. shared.slf    = { n, letter, startAt, endAt,
 *                                            stopAt, stopBy, used, over }
 *                          shared.slfres = { n, at, cats, tot, cum }
 *   Jeder Spieler meldet seine Eingaben per room.reportState({r,a,d}) (1×/s,
 *   nur wenn geändert). Der Host wertet nach Rundenende aus, veröffentlicht
 *   die Auflösung inkl. Gesamtstände (cum); jeder Client trägt daraus seinen
 *   eigenen Stand per room.reportScore() ein → Live-Rangliste + Podest.
 *   Alle Zeiten laufen über room.now() (Server-Zeit) → Tab-Wechsel-sicher.
 */
(function () {
  'use strict';
  window.App = window.App || {}; App.Minigames = App.Minigames || {};
  var UI = App.UI, el = UI.el;

  injectStyle();

  /* ===================== Konstanten ===================== */
  var ROUNDS = 5;              // Runden pro Spiel
  var ROUND_SEC = 40;          // Sekunden pro Runde
  var REVEAL_MS = 8000;        // Dauer der Auflösung
  var STOP_MS = 3000;          // Gnadenfrist nach "Fertig!" eines anderen
  var PTS_HIT = 10, PTS_DUP = 5;

  var CATS = [
    { key: 'stadt', label: 'Stadt', icon: '🏙️' },
    { key: 'land', label: 'Land', icon: '🌍' },
    { key: 'fluss', label: 'Fluss', icon: '🌊' },
    { key: 'tier', label: 'Tier', icon: '🐆' },
    { key: 'name', label: 'Name', icon: '🙋' },
    { key: 'beruf', label: 'Beruf', icon: '🛠️' }
  ];

  /* ===================== Wortlisten =====================
   * Pro Kategorie und Buchstabe stehen die naheliegendsten Wörter vorn —
   * die KI greift bevorzugt vorne zu (so entstehen echte Doppel-Treffer). */
  var WORDS = {
    stadt: ('Augsburg,Aachen,Amsterdam,Ankara,Athen,Aalen,Amberg,Ansbach,Aschaffenburg,Alicante,' +
      'Berlin,Bremen,Bonn,Bochum,Bielefeld,Braunschweig,Bamberg,Bayreuth,Barcelona,Budapest,Bruessel,Bern,Basel,Bagdad,Boston,Brasilia,Bogota,' +
      'Chemnitz,Coburg,Cottbus,Celle,Cuxhaven,Chicago,Cambridge,Cordoba,' +
      'Dortmund,Dresden,Duesseldorf,Duisburg,Darmstadt,Dessau,Dublin,Dakar,Damaskus,Delhi,Detroit,Dubai,' +
      'Essen,Erfurt,Erlangen,Emden,Eisenach,Esslingen,Eindhoven,Edinburgh,' +
      'Frankfurt,Freiburg,Flensburg,Fulda,Fuerth,Florenz,Faro,' +
      'Gera,Goerlitz,Goettingen,Gelsenkirchen,Giessen,Genf,Glasgow,Graz,Granada,Gdansk,' +
      'Hamburg,Hannover,Heidelberg,Halle,Hagen,Heilbronn,Herne,Hof,Helsinki,Havanna,Hongkong,' +
      'Ingolstadt,Iserlohn,Istanbul,Innsbruck,Izmir,Indianapolis,' +
      'Jena,Jakarta,Jerusalem,Johannesburg,Jonkoping,' +
      'Koeln,Kiel,Kassel,Karlsruhe,Koblenz,Konstanz,Krefeld,Kairo,Kapstadt,Kopenhagen,Kiew,Krakau,' +
      'Leipzig,Luebeck,Ludwigshafen,Landshut,Lueneburg,London,Lissabon,Lima,Luxemburg,Linz,Lyon,' +
      'Muenchen,Mainz,Mannheim,Magdeburg,Marburg,Moenchengladbach,Moskau,Madrid,Mailand,Manila,Melbourne,Montreal,' +
      'Nuernberg,Neuss,Neubrandenburg,Nordhausen,Neapel,Nizza,Nairobi,Nantes,' +
      'Oldenburg,Osnabrueck,Offenbach,Oberhausen,Oslo,Ottawa,Odessa,Osaka,' +
      'Potsdam,Passau,Paderborn,Pforzheim,Plauen,Paris,Prag,Peking,Porto,Palermo,' +
      'Rostock,Regensburg,Recklinghausen,Remscheid,Reutlingen,Rom,Riga,Riad,Rotterdam,' +
      'Stuttgart,Schwerin,Siegen,Solingen,Speyer,Salzburg,Stockholm,Sofia,Seoul,Sydney,Sevilla,Singapur,' +
      'Trier,Tuebingen,Tokio,Turin,Teheran,Toronto,Tunis,Toulouse,' +
      'Ulm,Uelzen,Unna,Utrecht,Uppsala,Udine,' +
      'Villingen,Viersen,Venedig,Valencia,Vancouver,Verona,' +
      'Wuerzburg,Wuppertal,Weimar,Wiesbaden,Wolfsburg,Worms,Wien,Warschau,Washington,Wellington,' +
      'Zwickau,Zeitz,Zuerich,Zagreb,Zaragoza').split(','),

    land: ('Aegypten,Argentinien,Australien,Albanien,Algerien,Angola,Armenien,Aethiopien,Afghanistan,Andorra,' +
      'Brasilien,Belgien,Bulgarien,Bolivien,Bangladesch,Botswana,Belize,Benin,Bhutan,Bahrain,' +
      'China,Chile,Costa Rica,Curacao,' +
      'Deutschland,Daenemark,Dominica,Dschibuti,' +
      'England,Ecuador,Estland,Eritrea,El Salvador,Elfenbeinkueste,' +
      'Frankreich,Finnland,Fidschi,Faeroer,' +
      'Griechenland,Georgien,Ghana,Guatemala,Guinea,Gabun,Grenada,Gambia,' +
      'Haiti,Honduras,Hongkong,Hawaii,' +
      'Italien,Indien,Irland,Island,Israel,Indonesien,Irak,Iran,' +
      'Japan,Jamaika,Jemen,Jordanien,' +
      'Kanada,Kroatien,Kuba,Kenia,Kolumbien,Kambodscha,Kamerun,Kasachstan,Katar,Kongo,Kuwait,Kirgisistan,' +
      'Luxemburg,Lettland,Litauen,Libanon,Liberia,Libyen,Liechtenstein,Laos,Lesotho,' +
      'Mexiko,Marokko,Malta,Mongolei,Malaysia,Malediven,Mali,Madagaskar,Malawi,Mauritius,Moldawien,Monaco,Mosambik,Myanmar,' +
      'Niederlande,Norwegen,Neuseeland,Namibia,Nepal,Nicaragua,Niger,Nigeria,Nordkorea,' +
      'Oesterreich,Oman,Ostafrika,' +
      'Polen,Portugal,Peru,Pakistan,Panama,Paraguay,Philippinen,Palau,' +
      'Russland,Rumaenien,Ruanda,' +
      'Spanien,Schweiz,Schweden,Serbien,Slowakei,Slowenien,Somalia,Senegal,Simbabwe,Singapur,Sudan,Suedafrika,Suedkorea,Syrien,Sambia,Sri Lanka,' +
      'Tuerkei,Tschechien,Thailand,Tunesien,Tansania,Taiwan,Togo,Tonga,Tschad,Tadschikistan,Turkmenistan,' +
      'Ungarn,Ukraine,Uruguay,Uganda,Usbekistan,USA,' +
      'Vietnam,Venezuela,Vatikan,Vanuatu,' +
      'Weissrussland,Wales,Westsahara,' +
      'Zypern,Zaire,Zentralafrika').split(','),

    fluss: ('Amazonas,Aare,Alster,Amper,Ahr,Altmuehl,Argen,Aller,' +
      'Bode,Bug,Brahmaputra,Bille,Bober,Blies,' +
      'Donau,Drau,Dnjepr,Dordogne,Douro,Dwina,Diemel,' +
      'Elbe,Ems,Eider,Erft,Enns,Euphrat,Ebro,Eger,' +
      'Fulda,Fils,Fuhse,Fecht,' +
      'Ganges,Garonne,Guadalquivir,Gera,Glan,Guenz,' +
      'Havel,Hase,Hunte,Helme,Hudson,Haune,' +
      'Isar,Inn,Iller,Ilm,Ilz,Indus,Isere,' +
      'Jagst,Jangtse,Jordan,Jenissei,' +
      'Kinzig,Kocher,Kongo,Kyll,Kolyma,Kama,' +
      'Lahn,Leine,Lech,Lippe,Loire,Limmat,Lena,' +
      'Main,Mosel,Mulde,Maas,Mississippi,Missouri,Murg,Memel,Mur,' +
      'Neckar,Nil,Nahe,Naab,Neisse,Nidda,Niger,' +
      'Oder,Ohre,Oker,Orinoco,Ob,Oise,Ohm,' +
      'Peene,Pegnitz,Po,Parana,Pleisse,Prims,' +
      'Rhein,Ruhr,Regen,Rur,Rhone,Rems,Rott,' +
      'Saale,Spree,Saar,Sieg,Seine,Sambesi,Salzach,Schwarza,' +
      'Themse,Tauber,Theiss,Tiber,Tigris,Trave,Traun,' +
      'Unstrut,Ural,Uecker,Urft,' +
      'Vils,Vecht,Volga,Var,' +
      'Weser,Werra,Wupper,Wolga,Warnow,Weichsel,Wied,Wutach,' +
      'Zschopau,Zusam,Zenne').split(','),

    tier: ('Affe,Adler,Ameise,Antilope,Alligator,Ara,Ameisenbaer,Auerhahn,Axolotl,Alpaka,' +
      'Baer,Biber,Biene,Blauwal,Bueffel,Bussard,Boa,Buntspecht,Blindschleiche,' +
      'Chamaeleon,Chinchilla,Chihuahua,Clownfisch,' +
      'Dachs,Delfin,Dromedar,Drossel,Dorsch,Distelfink,' +
      'Elefant,Ente,Esel,Eule,Elch,Eichhoernchen,Eisbaer,Emu,Eidechse,Elster,' +
      'Fuchs,Frosch,Fasan,Falke,Fledermaus,Flamingo,Forelle,Fliege,Floh,' +
      'Giraffe,Gepard,Gans,Gorilla,Grille,Gnu,Goldfisch,Gecko,Geier,' +
      'Hund,Hase,Hamster,Hai,Hirsch,Huhn,Hummel,Hummer,Hyaene,Habicht,' +
      'Igel,Iltis,Ibis,Impala,Iguana,' +
      'Jaguar,Junikaefer,Jak,Jungfernkranich,' +
      'Katze,Kuh,Kaenguru,Krokodil,Krebs,Kamel,Koala,Kobra,Kraehe,Karpfen,' +
      'Loewe,Lama,Luchs,Lachs,Leopard,Lerche,Libelle,Laus,' +
      'Maus,Marder,Maulwurf,Moewe,Muecke,Muschel,Mufflon,Meise,Manta,' +
      'Nashorn,Nilpferd,Nerz,Natter,Nachtigall,Nacktschnecke,' +
      'Otter,Ochse,Orang-Utan,Oktopus,Ozelot,Ohrwurm,' +
      'Pferd,Panda,Papagei,Pinguin,Puma,Pelikan,Pony,Python,Pfau,' +
      'Ratte,Reh,Rabe,Robbe,Rotkehlchen,Regenwurm,Rentier,Ringelnatter,' +
      'Schwein,Schaf,Storch,Specht,Seehund,Schlange,Schildkroete,Spinne,Schnecke,Skorpion,' +
      'Tiger,Taube,Tintenfisch,Termite,Tapir,Truthahn,Tukan,Thunfisch,' +
      'Uhu,Unke,Uakari,Urzeitkrebs,' +
      'Vogel,Viper,Vielfrass,Vogelspinne,' +
      'Wolf,Wal,Waschbaer,Wildschwein,Wiesel,Wespe,Wurm,Wachtel,Widder,' +
      'Ziege,Zebra,Zecke,Zander,Zaunkoenig,Zikade').split(','),

    name: ('Anna,Alex,Andreas,Anton,Alexander,Amelie,Annika,Arthur,Angelika,Anja,' +
      'Ben,Bernd,Bettina,Boris,Britta,Benjamin,Barbara,Bianca,Bruno,Beate,' +
      'Christian,Claudia,Carolin,Clara,Cornelia,Carl,Christoph,Chiara,' +
      'David,Daniel,Daniela,Dennis,Dirk,Doris,Dominik,Diana,' +
      'Emma,Erik,Elena,Eva,Emil,Elias,Elke,Ernst,Emily,' +
      'Felix,Frank,Franziska,Finn,Fabian,Florian,Friedrich,Frieda,' +
      'Georg,Gabi,Gerd,Greta,Gustav,Guenter,Gabriel,Gisela,' +
      'Hannah,Hans,Heike,Helmut,Henrik,Heinz,Hugo,Helena,' +
      'Ines,Ingo,Isabel,Irina,Ida,Ilona,Ingrid,Iris,' +
      'Jan,Julia,Jonas,Jana,Jens,Jessica,Jakob,Johanna,Josef,Joerg,' +
      'Karl,Katrin,Kevin,Klaus,Kerstin,Konstantin,Kira,Kurt,' +
      'Lisa,Lukas,Leon,Laura,Lena,Lars,Luis,Linda,Ludwig,Lea,' +
      'Max,Maria,Michael,Martina,Marco,Mia,Moritz,Melanie,Manfred,Mathilda,' +
      'Nina,Nico,Nadine,Noah,Norbert,Nele,Natalie,Niklas,' +
      'Olaf,Oliver,Otto,Olga,Oskar,Ole,' +
      'Paul,Petra,Peter,Patrick,Pia,Philipp,Paula,' +
      'Robert,Rainer,Rita,Rosa,Ralf,Rebecca,Rolf,Romy,' +
      'Sarah,Stefan,Susanne,Sven,Sophie,Simon,Sabine,Sebastian,Sandra,' +
      'Tim,Tina,Thomas,Tobias,Theo,Tanja,Torsten,Tamara,' +
      'Ulrich,Ursula,Uwe,Ute,Udo,Ulrike,' +
      'Volker,Vera,Viktor,Vanessa,Valentin,Verena,' +
      'Werner,Wolfgang,Walter,Wilhelm,Wanda,Wiebke,' +
      'Zoe,Zacharias,Zita,Zeynep').split(','),

    beruf: ('Arzt,Anwalt,Apotheker,Architekt,Astronaut,Automechaniker,Altenpfleger,Anlageberater,' +
      'Baecker,Bauer,Barkeeper,Busfahrer,Bankkaufmann,Bibliothekar,Buchhalter,Bauarbeiter,Biologe,' +
      'Chemiker,Chirurg,Chefkoch,Choreograf,Controller,' +
      'Dachdecker,Designer,Dolmetscher,Detektiv,Drogist,Dozent,Dirigent,' +
      'Elektriker,Erzieher,Entwickler,Ergotherapeut,Ernaehrungsberater,Ermittler,' +
      'Friseur,Fotograf,Fahrlehrer,Feuerwehrmann,Fleischer,Fliesenleger,Florist,Foerster,Fischer,' +
      'Gaertner,Goldschmied,Glaser,Grafiker,Geologe,Gastwirt,Germanist,' +
      'Hebamme,Historiker,Hausmeister,Hufschmied,Handwerker,Heizungsbauer,' +
      'Ingenieur,Imker,Informatiker,Illustrator,Installateur,' +
      'Journalist,Jurist,Jaeger,Justizbeamter,' +
      'Koch,Kellner,Krankenpfleger,Kaufmann,Kuenstler,Kosmetikerin,Klempner,Kapitaen,Kranfuehrer,' +
      'Lehrer,Lokfuehrer,Landwirt,Logopaede,Lagerist,Laborant,' +
      'Maler,Maurer,Mechaniker,Metzger,Moderator,Musiker,Model,Masseur,Mathematiker,' +
      'Notar,Nachrichtensprecher,Naeherin,Naturwissenschaftler,Netzwerktechniker,' +
      'Optiker,Orthopaede,Opernsaenger,Organist,Ozeanograf,' +
      'Pilot,Polizist,Pfarrer,Physiker,Programmierer,Psychologe,Politiker,Postbote,' +
      'Richter,Rechtsanwalt,Reporter,Reiseleiter,Rettungssanitaeter,Redakteur,' +
      'Schreiner,Schneider,Saenger,Schauspieler,Sekretaerin,Soldat,Steuerberater,Schlosser,Statiker,' +
      'Tischler,Tierarzt,Taxifahrer,Trainer,Techniker,Therapeut,Taenzer,' +
      'Uhrmacher,Unternehmer,Uebersetzer,Umweltschuetzer,Unternehmensberater,' +
      'Verkaeufer,Verleger,Versicherungsmakler,Veterinaer,Vermesser,' +
      'Winzer,Werbetexter,Wirt,Wissenschaftler,Webdesigner,' +
      'Zahnarzt,Zimmermann,Zugbegleiter,Zoellner,Zauberer').split(',')
  };

  /* ===================== Normalisierung ===================== */
  /* Umlaut-Variante "ae": München -> muenchen, Muenchen -> muenchen */
  function canonAe(s) {
    return String(s || '').toLowerCase()
      .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
      .replace(/[^a-z]/g, '');
  }
  /* Umlaut-Variante "a": München -> munchen, Munchen -> munchen */
  function canonA(s) {
    return String(s || '').toLowerCase()
      .replace(/ä/g, 'a').replace(/ö/g, 'o').replace(/ü/g, 'u').replace(/ß/g, 'ss')
      .replace(/ae/g, 'a').replace(/oe/g, 'o').replace(/ue/g, 'u')
      .replace(/[^a-z]/g, '');
  }
  /* Anfangsbuchstabe (A–Z), Umlaute zählen als Grundbuchstabe. */
  function firstLetter(s) {
    var t = String(s || '').replace(/^[^a-zA-ZäöüÄÖÜß]+/, '');
    if (!t) return '';
    var c = t.charAt(0).toLowerCase();
    if (c === 'ä') c = 'a'; else if (c === 'ö') c = 'o'; else if (c === 'ü') c = 'u'; else if (c === 'ß') c = 's';
    if (c < 'a' || c > 'z') return '';
    return c.toUpperCase();
  }

  /* ===================== Index + Buchstaben-Pool ===================== */
  var BY_LETTER = {}, LOOKUP = {}, POOL = [];
  (function buildIndex() {
    CATS.forEach(function (c) {
      BY_LETTER[c.key] = {}; LOOKUP[c.key] = {};
      WORDS[c.key].forEach(function (w) {
        var L = firstLetter(w);
        if (!L) return;
        if (!BY_LETTER[c.key][L]) BY_LETTER[c.key][L] = [];
        BY_LETTER[c.key][L].push(w);
        LOOKUP[c.key][canonAe(w)] = w;
        LOOKUP[c.key][canonA(w)] = w;
      });
    });
    var AZ = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
    AZ.forEach(function (L) {
      var ok = true;
      CATS.forEach(function (c) {
        var list = BY_LETTER[c.key][L];
        if (!list || list.length < 3) ok = false;      // mind. 3 Wörter je Kategorie
      });
      if (ok) POOL.push(L);
    });
  })();

  function pickLetter(used) {
    used = used || [];
    var free = POOL.filter(function (L) { return used.indexOf(L) < 0; });
    if (!free.length) free = POOL;
    return free[Math.floor(Math.random() * free.length)];
  }

  /* ===================== Bewertung ===================== */
  /* Prüft eine Eingabe: Buchstabe + Wortliste. */
  function judge(cat, letter, raw) {
    var t = String(raw || '').trim();
    if (!t) return { word: '', ok: false, why: 'leer', key: '' };
    if (firstLetter(t) !== letter) return { word: t, ok: false, why: 'falscher Buchstabe', key: '' };
    var hit = LOOKUP[cat][canonAe(t)] || LOOKUP[cat][canonA(t)];
    if (!hit) return { word: t, ok: false, why: 'nicht in der Liste', key: '' };
    return { word: hit, ok: true, why: '', key: canonAe(hit) };
  }

  /* Wertet eine ganze Runde aus.
     entries: [{ id, name, ans:{catKey:string} }]
     -> { cats: { catKey: [ {id,name,word,ok,dup,pts,why} ] }, tot: {id:pts} } */
  function scoreRound(letter, entries) {
    var out = { cats: {}, tot: {} };
    entries.forEach(function (e) { out.tot[e.id] = 0; });
    CATS.forEach(function (c) {
      var rows = [], count = {};
      entries.forEach(function (e) {
        var j = judge(c.key, letter, (e.ans || {})[c.key]);
        rows.push({ id: e.id, name: e.name, word: j.word, ok: j.ok, why: j.why, key: j.key, dup: false, pts: 0 });
        if (j.ok) count[j.key] = (count[j.key] || 0) + 1;
      });
      rows.forEach(function (r) {
        if (!r.ok) { r.pts = 0; return; }
        r.dup = count[r.key] > 1;
        r.pts = r.dup ? PTS_DUP : PTS_HIT;
        out.tot[r.id] += r.pts;
      });
      out.cats[c.key] = rows;
    });
    return out;
  }

  /* ===================== KI ===================== */
  var BOT_NAMES = ['Robo-Rita', 'KI-Klaus', 'Bit-Bea', 'Neon-Nils', 'Byte-Bjoern', 'Pixel-Paula', 'Chip-Chantal'];
  var LEVELS = {
    leicht: { label: 'Leicht', icon: '🌱', skill: 0.50, per: 7000, lag: 3000, bias: 1.2 },
    mittel: { label: 'Mittel', icon: '🔥', skill: 0.75, per: 4800, lag: 1800, bias: 2.0 },
    profi: { label: 'Profi', icon: '💀', skill: 0.95, per: 4000, lag: 1400, bias: 2.6 }
  };

  /* Wort ziehen — bias > 1 bevorzugt die naheliegenden (vorderen) Einträge. */
  function pickWord(cat, letter, bias) {
    var list = BY_LETTER[cat][letter];
    if (!list || !list.length) return '';
    var i = Math.floor(Math.pow(Math.random(), bias) * list.length);
    if (i >= list.length) i = list.length - 1;
    return list[i];
  }

  /* Baut den Rundenplan eines Bots: welches Wort wann im Feld steht. */
  function botPlan(bot, letter, startAt) {
    var plan = [], t = startAt + bot.lvl.lag * (0.7 + Math.random() * 0.6), full = true;
    CATS.forEach(function (c) {
      t += bot.lvl.per * (0.65 + Math.random() * 0.7);
      if (Math.random() > bot.lvl.skill) { full = false; plan.push({ cat: c.key, word: '', at: t }); return; }
      var w = pickWord(c.key, letter, bot.lvl.bias);
      if (!w) full = false;
      plan.push({ cat: c.key, word: w, at: t });
    });
    var done = 0;
    plan.forEach(function (p) { if (p.word) done = Math.max(done, p.at); });
    return { plan: plan, fullAt: full ? done : 0 };
  }

  /* Antworten eines Bots zum Zeitpunkt "until". */
  function botAnswers(planObj, until) {
    var a = {};
    planObj.plan.forEach(function (p) { if (p.word && p.at <= until) a[p.cat] = p.word; });
    return a;
  }

  /* ===================== gemeinsame Ansichten ===================== */

  /* Kopf mit Buchstabe, Runde, Timer + Balken. */
  function buildHead(letter, round, total) {
    var letterEl = el('div', { class: 'slf-letter' }, [letter]);
    var timerEl = el('div', { class: 'mg-timer slf-timer' }, ['0:40']);
    var ptsEl = el('div', { class: 'slf-pts' }, [App.MG.fmt(total || 0)]);
    var fill = el('div', { class: 'slf-barfill' });
    var head = el('div', { class: 'slf-head glass' }, [
      el('div', { class: 'slf-head-row' }, [
        el('div', { class: 'slf-letterbox' }, [
          el('span', { class: 'slf-letter-l' }, ['Buchstabe']), letterEl
        ]),
        el('div', { class: 'slf-head-mid' }, [
          el('span', { class: 'slf-head-l' }, ['Runde']),
          el('div', { class: 'slf-round' }, [round + ' / ' + ROUNDS]),
          el('span', { class: 'slf-head-l' }, ['Deine Punkte']),
          el('div', { class: 'slf-pts-wrap' }, [ptsEl])
        ]),
        el('div', { class: 'slf-head-right' }, [
          el('span', { class: 'slf-head-l' }, ['Zeit']), timerEl
        ])
      ]),
      el('div', { class: 'slf-bar' }, [fill])
    ]);
    return { root: head, letterEl: letterEl, timerEl: timerEl, ptsEl: ptsEl, fill: fill };
  }

  /* Eingabe-Ansicht (Solo + Multi identisch).
     o: { letter, round, total, onDone, onInput, boardEl } */
  function buildPlayView(o) {
    var head = buildHead(o.letter, o.round, o.total);
    var inputs = {}, flags = {};

    var rows = CATS.map(function (c) {
      var flag = el('span', { class: 'slf-flag' }, ['']);
      var inp = el('input', {
        class: 'text-input slf-inp', type: 'text', autocomplete: 'off', autocorrect: 'off',
        autocapitalize: 'words', spellcheck: 'false', maxlength: '28',
        placeholder: c.label + ' mit ' + o.letter + ' …'
      });
      inputs[c.key] = inp; flags[c.key] = flag;
      return el('label', { class: 'slf-row' }, [
        el('span', { class: 'slf-cat' }, [
          el('span', { class: 'slf-cat-ico' }, [c.icon]),
          el('span', { class: 'slf-cat-lbl' }, [c.label])
        ]),
        el('span', { class: 'slf-inp-wrap' }, [inp, flag])
      ]);
    });

    var doneBtn = el('button', { class: 'btn btn-primary slf-done', type: 'button', disabled: true }, ['Fertig!']);
    var stopEl = el('div', { class: 'slf-stop' }, ['']);

    var form = el('div', { class: 'slf-form glass' }, rows);
    var wrap = el('div', { class: 'slf-wrap' }, [
      head.root,
      el('p', { class: 'hint-text slf-rules' }, [
        '✏️ Je ein Begriff mit „' + o.letter + '“ pro Kategorie · Enter = nächstes Feld · Treffer 10 Punkte, doppelt nur 5 · „Fertig!“ stoppt die Runde'
      ]),
      form,
      stopEl,
      el('div', { class: 'controls-row slf-actions' }, [doneBtn]),
      o.boardEl ? el('div', { class: 'slf-boardwrap glass' }, [
        el('div', { class: 'mg-field-title' }, ['🏆 Rangliste']), o.boardEl
      ]) : null
    ]);

    /* Feld-Rückmeldung: nur der Anfangsbuchstabe wird live geprüft
       (die Wortliste bleibt bis zur Auflösung geheim). */
    function refresh() {
      var filled = 0;
      CATS.forEach(function (c) {
        var v = inputs[c.key].value.trim();
        var f = flags[c.key];
        if (!v) { f.textContent = ''; f.className = 'slf-flag'; return; }
        if (firstLetter(v) === o.letter) { f.textContent = '✓'; f.className = 'slf-flag ok'; filled++; }
        else { f.textContent = '✗'; f.className = 'slf-flag bad'; }
      });
      var missing = CATS.length - filled;
      doneBtn.disabled = missing > 0;
      doneBtn.textContent = missing > 0 ? ('Fertig! (noch ' + missing + ')') : '🏁 Fertig!';
      return filled;
    }

    CATS.forEach(function (c, i) {
      inputs[c.key].addEventListener('input', function () { refresh(); if (o.onInput) o.onInput(); });
      inputs[c.key].addEventListener('keydown', function (e) {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        if (i + 1 < CATS.length) inputs[CATS[i + 1].key].focus();
        else if (!doneBtn.disabled) doneBtn.focus();
      });
    });
    doneBtn.addEventListener('click', function () { if (!doneBtn.disabled && o.onDone) o.onDone(); });

    refresh();

    return {
      root: wrap, head: head, inputs: inputs, doneBtn: doneBtn, stopEl: stopEl, refresh: refresh,
      answers: function () { var a = {}; CATS.forEach(function (c) { a[c.key] = inputs[c.key].value.trim(); }); return a; },
      lock: function () { CATS.forEach(function (c) { inputs[c.key].disabled = true; }); doneBtn.disabled = true; },
      showStop: function (who, secLeft) {
        stopEl.classList.add('on');
        stopEl.textContent = '✋ ' + who + ' hat „Fertig!“ gerufen — noch ' + Math.max(0, Math.ceil(secLeft)) + ' s!';
      }
    };
  }

  /* Auflösungs-Ansicht.
     o: { letter, round, res, meId, nextLabel, onSkip, boardEl } */
  function buildRevealView(o) {
    var myPts = o.res.tot[o.meId] || 0;
    var blocks = CATS.map(function (c) {
      var rows = (o.res.cats[c.key] || []).slice().sort(function (a, b) { return b.pts - a.pts; });
      return el('div', { class: 'slf-rev-cat' }, [
        el('div', { class: 'slf-rev-head' }, [
          el('span', { class: 'slf-cat-ico' }, [c.icon]),
          el('span', { class: 'slf-rev-lbl' }, [c.label])
        ]),
        el('div', { class: 'slf-rev-list' }, rows.map(function (r) {
          var cls = 'slf-chip ' + (r.ok ? (r.dup ? 'dup' : 'ok') : 'bad') + (r.id === o.meId ? ' me' : '');
          return el('div', { class: cls }, [
            el('span', { class: 'slf-chip-n' }, [r.name + (r.id === o.meId ? ' (du)' : '')]),
            el('span', { class: 'slf-chip-w' }, [r.word || '—']),
            el('span', { class: 'slf-chip-p' }, ['+' + r.pts]),
            el('span', { class: 'slf-chip-t' }, [r.ok ? (r.dup ? 'doppelt' : 'Treffer') : r.why])
          ]);
        }))
      ]);
    });

    var nextEl = el('div', { class: 'slf-next hint-text' }, [o.nextLabel || '']);
    var acts = [];
    if (o.onSkip) acts.push(el('button', { class: 'btn btn-aqua', type: 'button', onclick: o.onSkip }, ['Weiter ▶']));

    return {
      root: el('div', { class: 'slf-wrap' }, [
        el('div', { class: 'slf-rev-top glass' }, [
          el('div', { class: 'slf-rev-letter' }, [o.letter]),
          el('div', { class: 'slf-rev-sum' }, [
            el('div', { class: 'slf-head-l' }, ['Auflösung Runde ' + o.round + ' / ' + ROUNDS]),
            el('div', { class: 'big-readout slf-rev-pts' }, ['+' + myPts]),
            el('div', { class: 'hint-text' }, ['deine Rundenpunkte'])
          ])
        ]),
        el('div', { class: 'slf-rev-grid' }, blocks),
        nextEl,
        acts.length ? el('div', { class: 'controls-row' }, acts) : null,
        o.boardEl ? el('div', { class: 'slf-boardwrap glass' }, [
          el('div', { class: 'mg-field-title' }, ['🏆 Gesamt']), o.boardEl
        ]) : null
      ]),
      nextEl: nextEl
    };
  }

  /* Einfache Rangliste für Solo (gleiche Optik wie App.MG.liveBoard). */
  function soloBoard(list, meId) {
    var root = el('div', { class: 'mg-scoreboard' });
    function update() {
      var ps = list.slice().sort(function (a, b) { return (b.score || 0) - (a.score || 0); });
      root.innerHTML = '';
      ps.forEach(function (p, i) {
        root.appendChild(el('div', { class: 'mg-sb-row p' + (i + 1) + (p.id === meId ? ' me' : '') }, [
          el('span', { class: 'mg-sb-rank' }, ['' + (i + 1)]),
          el('span', { class: 'mg-sb-name' }, [p.name + (p.id === meId ? ' (du)' : '')]),
          el('span', { class: 'mg-sb-score' }, [App.MG.fmt(p.score || 0)])
        ]));
      });
    }
    update();
    return { root: root, update: update };
  }

  /* ===================== Registrierung ===================== */
  App.Minigames.stadtlandfluss = {
    id: 'stadtlandfluss', title: 'Stadt-Land-Fluss', icon: '✏️', order: 168,
    subtitle: 'Ein Buchstabe, 40 Sekunden, 6 Kategorien',
    single: true, multi: true, minPlayers: 2, maxPlayers: 8,

    render: function (root, ctx) {
      var dead = false;
      var pending = [], stops = [];

      function after(ms, fn) { var t = setTimeout(function () { if (!dead) fn(); }, ms); pending.push(t); return t; }
      function clearPending() { pending.forEach(clearTimeout); pending = []; }
      function stopHelpers() { stops.forEach(function (f) { try { f(); } catch (e) {} }); stops = []; }
      function cleanup() { dead = true; clearPending(); stopHelpers(); if (offAll) offAll(); }
      var offAll = null;

      if (ctx.mode === 'multi' && ctx.room) runMulti(); else runSolo();
      return { cleanup: cleanup };

      /* ============================================================
       *  SOLO — gegen 3 KI-Mitspieler, nur eigene Punkte zählen
       * ============================================================ */
      function runSolo() {
        var level = LEVELS.mittel, bots = [], myTotal = 0, used = [], roundNo = 0;
        var timerStop = null, view = null;

        chooser();

        function chooser() {
          clearPending(); if (timerStop) { timerStop(); timerStop = null; }
          var btns = ['leicht', 'mittel', 'profi'].map(function (k) {
            var L = LEVELS[k];
            return el('button', {
              class: 'chip slf-diff', type: 'button',
              onclick: function () { if (App.Audio) App.Audio.sfx('select'); level = L; start(); }
            }, [L.icon + ' ' + L.label]);
          });
          root.innerHTML = '';
          root.appendChild(el('div', { class: 'glass slf-hero' }, [
            el('div', { class: 'slf-hero-ico' }, ['✏️']),
            el('h2', { class: 'neon' }, ['Stadt-Land-Fluss']),
            el('p', { class: 'hint-text' }, [
              ROUNDS + ' Runden · je ' + ROUND_SEC + ' s · 6 Kategorien. Treffer aus der Wortliste geben 10 Punkte — ' +
              'hatte eine KI dasselbe Wort, nur 5. Wer zuerst alle 6 Felder hat, ruft „Fertig!“.'
            ]),
            el('div', { class: 'slf-hero-l' }, ['Wie stark sollen die KI-Mitspieler sein?']),
            el('div', { class: 'controls-row' }, btns),
            el('p', { class: 'hint-text' }, ['Bestwert: ' + App.MG.fmt(App.Storage.get('best_stadtlandfluss', 0)) + ' Punkte']),
            el('div', { class: 'controls-row' }, [
              el('button', { class: 'btn btn-ghost', type: 'button', onclick: ctx.onExit }, ['Zurück'])
            ])
          ]));
        }

        function start() {
          myTotal = 0; used = []; roundNo = 0;
          var pool = BOT_NAMES.slice();
          bots = [];
          for (var i = 0; i < 3; i++) {
            var n = pool.splice(Math.floor(Math.random() * pool.length), 1)[0];
            bots.push({ id: 'bot' + i, name: n, lvl: level, score: 0 });
          }
          nextRound();
        }

        function nextRound() {
          if (dead) return;
          roundNo++;
          var letter = pickLetter(used); used.push(letter);
          var startAt = Date.now(), timeEnd = startAt + ROUND_SEC * 1000;
          var plans = bots.map(function (b) { return botPlan(b, letter, startAt); });
          var ended = false, effEnd = timeEnd, stopBy = null;

          if (App.Audio) App.Audio.sfx('start');

          var board = soloBoard([{ id: 'me', name: ctx.me.name || 'Du', score: myTotal }].concat(bots), 'me');
          view = buildPlayView({
            letter: letter, round: roundNo, total: myTotal, boardEl: board.root,
            onDone: function () { finishRound(Date.now()); }
          });
          root.innerHTML = ''; root.appendChild(view.root);
          if (!('ontouchstart' in window)) view.inputs.stadt.focus();

          /* Ruft ein Bot zuerst „Fertig!“, bleiben dem Spieler noch 3 s. */
          var botStop = 0;
          plans.forEach(function (p, i) {
            if (p.fullAt && p.fullAt < timeEnd && (!botStop || p.fullAt < botStop)) { botStop = p.fullAt; stopBy = bots[i].name; }
          });
          if (botStop) {
            after(Math.max(0, botStop - Date.now()), function () {
              if (ended) return;
              effEnd = Math.min(timeEnd, botStop + STOP_MS);
              if (App.Audio) App.Audio.sfx('whoosh');
              arm();
            });
          }

          arm();
          function arm() {
            if (timerStop) timerStop();
            timerStop = App.MG.roundTimer(effEnd, function (left) {
              view.head.timerEl.textContent = App.MG.mmss(left);
              view.head.fill.style.width = Math.max(0, Math.min(100, (left / ROUND_SEC) * 100)) + '%';
              if (left <= 5) view.head.timerEl.classList.add('slf-urgent');
              if (stopBy && effEnd < timeEnd) view.showStop(stopBy, left);
            }, function () { finishRound(effEnd); }, null);
            stops.push(timerStop);
          }

          function finishRound(at) {
            if (ended || dead) return;
            ended = true;
            if (timerStop) { timerStop(); timerStop = null; }
            clearPending();
            view.lock();
            var entries = [{ id: 'me', name: ctx.me.name || 'Du', ans: view.answers() }];
            bots.forEach(function (b, i) { entries.push({ id: b.id, name: b.name, ans: botAnswers(plans[i], at) }); });
            var res = scoreRound(letter, entries);
            myTotal += res.tot.me || 0;
            bots.forEach(function (b) { b.score += res.tot[b.id] || 0; });
            if (App.Audio) App.Audio.sfx((res.tot.me || 0) >= 40 ? 'jackpot' : 'point');
            after(500, function () { reveal(letter, res); });
          }
        }

        function reveal(letter, res) {
          var board = soloBoard([{ id: 'me', name: ctx.me.name || 'Du', score: myTotal }].concat(bots), 'me');
          var last = roundNo >= ROUNDS;
          var rv = buildRevealView({
            letter: letter, round: roundNo, res: res, meId: 'me', boardEl: board.root,
            nextLabel: last ? 'Spiel vorbei …' : 'Nächster Buchstabe …',
            onSkip: function () { go(); }
          });
          root.innerHTML = ''; root.appendChild(rv.root);
          var t = after(REVEAL_MS, go);
          var gone = false;
          function go() {
            if (gone || dead) return; gone = true;
            clearTimeout(t);
            if (last) finishGame(); else nextRound();
          }
        }

        function finishGame() {
          var best = App.Storage.get('best_stadtlandfluss', 0);
          var nb = myTotal > best;
          if (nb) App.Storage.set('best_stadtlandfluss', myTotal);
          if (App.Audio) App.Audio.sfx(nb ? 'win' : 'cashout');
          var beaten = bots.filter(function (b) { return b.score < myTotal; }).length;
          App.MG.endScreen(root, {
            score: myTotal, best: best, newBest: nb,
            label: 'Punkte in ' + ROUNDS + ' Runden · ' + beaten + '/' + bots.length + ' KI geschlagen' +
              (nb ? ' · neuer Rekord! 🎉' : ' · Bestwert: ' + App.MG.fmt(best)),
            onExit: ctx.onExit,
            onAgain: function () { clearPending(); stopHelpers(); chooser(); }
          });
        }
      }

      /* ============================================================
       *  MULTI — Host hält Runde + Auflösung in shared
       * ============================================================ */
      function runMulti() {
        var room = ctx.room, me = ctx.me;
        var lastShared = (room.snapshot() && room.snapshot().shared) || null;
        var curKey = '', view = null, timerStop = null, board = null, revealTick = null;
        var myAns = {}, dirty = false, iAmDone = false, reportedFor = -1;
        var armedEnd = 0, started = false, initStart = 0;
        var hostBusy = false;

        function onShared(sh) { if (dead) return; lastShared = sh; if (started) sync(); }
        function onPlayers() { if (dead) return; if (started) sync(); }
        room.on('shared', onShared);
        room.on('players', onPlayers);
        offAll = function () {
          room.off('shared', onShared); room.off('players', onPlayers);
          if (timerStop) timerStop();
          if (revealTick) clearInterval(revealTick);
        };

        var snap = room.snapshot() || {};
        initStart = (snap.round && snap.round.startAt) || (room.now() + 3000);
        stops.push(App.MG.countdown(root, initStart, function () { started = true; play(); }, room.now));

        /* Meldet die eigenen Eingaben regelmäßig an den Host. */
        var repTimer = setInterval(function () {
          if (dead || !started) return;
          if (!dirty) return;
          dirty = false;
          var sh = slf();
          if (!sh || sh.over) return;
          room.reportState({ r: sh.n, a: myAns, d: iAmDone });
        }, 1000);
        stops.push(function () { clearInterval(repTimer); });

        /* Host-Schleife: Stopp-Regel, Auswertung, Rundenwechsel. */
        var hostTimer = setInterval(function () { if (!dead && started) hostTick(); }, 400);
        stops.push(function () { clearInterval(hostTimer); });

        function slf() { return lastShared && lastShared.slf ? lastShared.slf : null; }
        function res() { return lastShared && lastShared.slfres ? lastShared.slfres : null; }
        function effEnd(sh) { return sh.stopAt ? Math.min(sh.endAt, sh.stopAt) : sh.endAt; }
        function nameOf(id) {
          var ps = room.players();
          for (var i = 0; i < ps.length; i++) if (ps[i].id === id) return ps[i].name;
          return 'Jemand';
        }

        function play() {
          if (!slf() && room.isHost()) publishRound(1, initStart, []);
          sync();
        }

        function publishRound(n, startAt, used) {
          var L = pickLetter(used);
          room.setShared({
            slf: { n: n, letter: L, startAt: startAt, endAt: startAt + ROUND_SEC * 1000, stopAt: 0, stopBy: '', used: used.concat([L]), over: false, cum: (slf() && slf().cum) || {} },
            slfres: { n: 0 }
          });
        }

        /* ---- Host-Logik ---- */
        function hostTick() {
          if (!room.isHost() || hostBusy) return;
          var sh = slf();
          if (!sh) { publishRound(1, room.now(), []); return; }
          if (sh.over) return;
          var r = res();
          if (r && r.n === sh.n) {
            if (room.now() >= r.at + REVEAL_MS) advance(sh, r);
            return;
          }
          var eff = effEnd(sh);
          if (room.now() >= eff + 700) { publishResult(sh, eff); return; }
          if (!sh.stopAt) {
            var ps = room.players(), doneId = null;
            ps.forEach(function (p) { if (!doneId && p.state && p.state.r === sh.n && p.state.d) doneId = p.id; });
            if (doneId) {
              hostBusy = true;
              room.setShared({ slf: Object.assign({}, sh, { stopAt: room.now() + STOP_MS, stopBy: nameOf(doneId) }) });
              after(500, function () { hostBusy = false; });
            }
          }
        }

        function publishResult(sh, eff) {
          hostBusy = true;
          var entries = room.players().map(function (p) {
            var st = (p.state && p.state.r === sh.n) ? p.state : null;
            return { id: p.id, name: p.name, ans: (st && st.a) || {} };
          });
          var r = scoreRound(sh.letter, entries);
          var cum = Object.assign({}, sh.cum || {});
          entries.forEach(function (e) { cum[e.id] = (cum[e.id] || 0) + (r.tot[e.id] || 0); });
          room.setShared({
            slf: Object.assign({}, sh, { cum: cum }),
            slfres: { n: sh.n, at: room.now(), cats: r.cats, tot: r.tot, cum: cum }
          });
          after(600, function () { hostBusy = false; });
        }

        function advance(sh, r) {
          hostBusy = true;
          if (sh.n >= ROUNDS) {
            room.setShared({ slf: Object.assign({}, sh, { over: true, cum: r.cum }) });
          } else {
            var startAt = room.now() + 400;
            var L = pickLetter(sh.used || []);
            room.setShared({
              slf: {
                n: sh.n + 1, letter: L, startAt: startAt, endAt: startAt + ROUND_SEC * 1000,
                stopAt: 0, stopBy: '', used: (sh.used || []).concat([L]), over: false, cum: r.cum
              },
              slfres: { n: 0 }
            });
          }
          after(800, function () { hostBusy = false; });
        }

        /* ---- Ansicht aus shared ableiten (idempotent!) ---- */
        function sync() {
          if (dead || !started) return;
          var sh = slf();
          if (!sh) { showKey('wait', buildWait); return; }
          if (sh.over) { showKey('over', showEnd); return; }
          var r = res();
          if (r && r.n === sh.n) {
            reportMine(r);
            showKey('reveal:' + sh.n, function () { buildReveal(sh, r); });
            return;
          }
          showKey('play:' + sh.n, function () { buildPlay(sh); });
          updatePlay(sh);
        }

        function showKey(key, build) {
          if (curKey === key) return;
          curKey = key;
          if (timerStop) { timerStop(); timerStop = null; }
          if (revealTick) { clearInterval(revealTick); revealTick = null; }
          if (board) { board.stop(); board = null; }
          build();
        }

        function reportMine(r) {
          if (reportedFor === r.n) return;
          reportedFor = r.n;
          room.reportScore((r.cum && r.cum[me.id]) || 0);
        }

        function buildWait() {
          root.innerHTML = '';
          root.appendChild(el('div', { class: 'glass slf-hero' }, [
            el('div', { class: 'slf-hero-ico' }, ['🎲']),
            el('h2', { class: 'neon' }, ['Buchstabe wird gezogen …']),
            el('p', { class: 'hint-text' }, ['Gleich geht es los — halte die Finger bereit.'])
          ]));
        }

        function buildPlay(sh) {
          myAns = {}; iAmDone = false; dirty = true; armedEnd = 0;
          board = App.MG.liveBoard(room, me.id);
          view = buildPlayView({
            letter: sh.letter, round: sh.n, total: (sh.cum && sh.cum[me.id]) || 0, boardEl: board.root,
            onInput: function () { myAns = view.answers(); dirty = true; },
            onDone: function () {
              if (iAmDone) return;
              iAmDone = true; myAns = view.answers();
              view.lock();
              view.doneBtn.textContent = '✅ Fertig — warte …';
              if (App.Audio) App.Audio.sfx('ding');
              room.reportState({ r: sh.n, a: myAns, d: true });
            }
          });
          root.innerHTML = ''; root.appendChild(view.root);
          if (!('ontouchstart' in window)) view.inputs.stadt.focus();
          if (App.Audio) App.Audio.sfx('start');
          room.reportState({ r: sh.n, a: {}, d: false });
        }

        /* Timer neu spannen, wenn jemand „Fertig!“ ruft (Ende rückt vor). */
        function updatePlay(sh) {
          if (!view || curKey !== 'play:' + sh.n) return;
          var eff = effEnd(sh);
          if (eff === armedEnd) return;
          armedEnd = eff;
          if (timerStop) timerStop();
          timerStop = App.MG.roundTimer(eff, function (left) {
            view.head.timerEl.textContent = App.MG.mmss(left);
            view.head.fill.style.width = Math.max(0, Math.min(100, (left / ROUND_SEC) * 100)) + '%';
            if (left <= 5) view.head.timerEl.classList.add('slf-urgent');
            var s = slf();
            if (s && s.stopAt && s.stopBy && !iAmDone) view.showStop(s.stopBy, left);
          }, function () {
            if (view && curKey === 'play:' + sh.n) {
              view.lock();
              myAns = view.answers();
              room.reportState({ r: sh.n, a: myAns, d: true });
            }
          }, room.now);
        }

        function buildReveal(sh, r) {
          board = App.MG.liveBoard(room, me.id);
          if (App.Audio) App.Audio.sfx((r.tot[me.id] || 0) >= 40 ? 'jackpot' : 'point');
          var rv = buildRevealView({
            letter: sh.letter, round: sh.n, res: r, meId: me.id, boardEl: board.root,
            nextLabel: sh.n >= ROUNDS ? 'Gleich kommt das Ergebnis …' : 'Nächster Buchstabe in Kürze …'
          });
          root.innerHTML = ''; root.appendChild(rv.root);
          revealTick = setInterval(function () {
            if (dead) { clearInterval(revealTick); return; }
            var left = Math.max(0, Math.ceil((r.at + REVEAL_MS - room.now()) / 1000));
            rv.nextEl.textContent = (sh.n >= ROUNDS ? 'Ergebnis in ' : 'Nächster Buchstabe in ') + left + ' s …';
          }, 200);
        }

        function showEnd() {
          if (timerStop) { timerStop(); timerStop = null; }
          var sh = slf();
          if (sh && sh.cum) room.reportScore(sh.cum[me.id] || 0);
          after(400, function () {
            App.MG.endScreen(root, { players: room.players(), meId: me.id, onExit: ctx.onExit });
          });
        }
      }
    }
  };

  /* ===================== STYLES ===================== */
  function injectStyle() {
    UI.injectStyle('mg-stadtlandfluss-css', [
      '.slf-wrap{display:flex;flex-direction:column;gap:12px;}',
      /* Kopf */
      '.slf-head{padding:12px 16px 10px;display:flex;flex-direction:column;gap:9px;}',
      '.slf-head-row{display:flex;align-items:center;justify-content:space-between;gap:12px;}',
      '.slf-letterbox{display:flex;flex-direction:column;align-items:center;gap:2px;min-width:78px;}',
      '.slf-letter-l,.slf-head-l{font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:1.4px;}',
      '.slf-letter{font-size:clamp(46px,13vw,74px);font-weight:900;line-height:1;padding:0 12px;border-radius:16px;',
      'background:linear-gradient(180deg,var(--neon),var(--aqua));-webkit-background-clip:text;background-clip:text;',
      '-webkit-text-fill-color:transparent;color:transparent;animation:slf-glow 2.4s ease-in-out infinite;}',
      '@keyframes slf-glow{0%,100%{filter:drop-shadow(0 0 8px var(--stroke-2));transform:scale(1);}50%{filter:drop-shadow(0 0 20px var(--neon));transform:scale(1.05);}}',
      '.slf-head-mid{display:flex;flex-direction:column;align-items:center;gap:1px;flex:1;min-width:0;}',
      '.slf-round{font-size:15px;font-weight:900;color:var(--leaf);}',
      '.slf-pts-wrap{display:flex;align-items:baseline;gap:3px;}',
      '.slf-pts{font-size:clamp(16px,4vw,22px);font-weight:900;color:var(--gold);text-shadow:0 0 10px rgba(255,210,63,.4);font-variant-numeric:tabular-nums;}',
      '.slf-head-right{display:flex;flex-direction:column;align-items:flex-end;gap:2px;min-width:64px;}',
      '.slf-timer{font-size:clamp(18px,5vw,26px);font-variant-numeric:tabular-nums;}',
      '.mg-timer.slf-urgent{color:var(--danger);animation:slf-pulse .7s infinite;}',
      '@keyframes slf-pulse{0%,100%{opacity:1}50%{opacity:.35}}',
      '.slf-bar{height:7px;border-radius:99px;background:rgba(4,16,10,.8);border:1px solid var(--stroke);overflow:hidden;}',
      '.slf-barfill{height:100%;width:100%;border-radius:99px;background:linear-gradient(90deg,var(--aqua),var(--neon));',
      'box-shadow:0 0 12px var(--stroke-2);transition:width .12s linear;}',
      '.slf-rules{margin:0;text-align:center;font-size:12px;line-height:1.5;}',
      /* Eingabe */
      '.slf-form{padding:12px;display:flex;flex-direction:column;gap:9px;}',
      '.slf-row{display:grid;grid-template-columns:118px 1fr;align-items:center;gap:10px;}',
      '.slf-cat{display:flex;align-items:center;gap:7px;min-width:0;}',
      '.slf-cat-ico{font-size:19px;line-height:1;filter:drop-shadow(0 0 6px var(--stroke-2));}',
      '.slf-cat-lbl{font-weight:800;color:var(--leaf);font-size:14px;letter-spacing:.4px;}',
      '.slf-inp-wrap{position:relative;display:block;min-width:0;}',
      '.slf-inp{width:100%;padding-right:34px;font-size:16px;}',
      '.slf-inp:disabled{opacity:.65;}',
      '.slf-flag{position:absolute;right:10px;top:50%;transform:translateY(-50%);font-size:15px;font-weight:900;pointer-events:none;opacity:0;transition:opacity .15s;}',
      '.slf-flag.ok{opacity:1;color:var(--neon);text-shadow:0 0 8px rgba(57,255,20,.6);}',
      '.slf-flag.bad{opacity:1;color:var(--danger);text-shadow:0 0 8px rgba(255,77,109,.6);}',
      '.slf-actions{margin:0;}',
      '.slf-done{min-width:200px;font-size:16px;}',
      '.slf-stop{display:none;}',
      '.slf-stop.on{display:block;text-align:center;font-weight:900;color:var(--gold);padding:8px 12px;border-radius:12px;',
      'background:rgba(40,32,6,.7);border:1px solid rgba(255,210,63,.5);animation:slf-stopin .25s ease, slf-blink 1s ease-in-out infinite;}',
      '@keyframes slf-stopin{from{transform:translateY(-6px);opacity:0;}to{transform:none;opacity:1;}}',
      '@keyframes slf-blink{0%,100%{box-shadow:0 0 0 rgba(255,210,63,0);}50%{box-shadow:0 0 18px rgba(255,210,63,.5);}}',
      /* Auflösung */
      '.slf-rev-top{display:flex;align-items:center;gap:16px;padding:12px 18px;justify-content:center;}',
      '.slf-rev-letter{font-size:clamp(44px,12vw,68px);font-weight:900;line-height:1;color:var(--aqua);text-shadow:0 0 18px rgba(51,230,208,.5);}',
      '.slf-rev-sum{display:flex;flex-direction:column;align-items:center;gap:1px;}',
      '.slf-rev-pts{font-size:clamp(28px,7vw,44px)!important;color:var(--gold)!important;animation:slf-pop .4s cubic-bezier(.2,.9,.3,1.4) both;}',
      '@keyframes slf-pop{from{transform:scale(.6);opacity:0;}to{transform:scale(1);opacity:1;}}',
      '.slf-rev-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:10px;}',
      '.slf-rev-cat{padding:10px 12px;border-radius:14px;background:rgba(9,32,21,.6);border:1px solid var(--stroke);',
      'display:flex;flex-direction:column;gap:7px;animation:slf-rise .35s ease both;}',
      '@keyframes slf-rise{from{opacity:0;transform:translateY(10px);}to{opacity:1;transform:none;}}',
      '.slf-rev-head{display:flex;align-items:center;gap:7px;}',
      '.slf-rev-lbl{font-weight:900;color:var(--aqua-soft);letter-spacing:.5px;font-size:14px;}',
      '.slf-rev-list{display:flex;flex-direction:column;gap:5px;}',
      '.slf-chip{display:grid;grid-template-columns:1fr auto auto;align-items:center;gap:8px;padding:6px 10px;border-radius:10px;',
      'background:rgba(4,16,10,.7);border:1px solid var(--stroke);font-size:13px;}',
      '.slf-chip.me{border-color:var(--stroke-2);box-shadow:inset 0 0 14px rgba(57,255,20,.1);}',
      '.slf-chip-n{color:var(--muted);font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      '.slf-chip-w{font-weight:900;color:#fff;justify-self:end;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:130px;}',
      '.slf-chip-p{font-weight:900;font-variant-numeric:tabular-nums;min-width:30px;text-align:right;}',
      '.slf-chip-t{grid-column:1 / -1;font-size:10px;text-transform:uppercase;letter-spacing:1px;color:var(--muted);}',
      '.slf-chip.ok{border-color:rgba(57,255,20,.45);background:linear-gradient(90deg,rgba(57,255,20,.12),rgba(4,16,10,.7));}',
      '.slf-chip.ok .slf-chip-p,.slf-chip.ok .slf-chip-t{color:var(--neon);}',
      '.slf-chip.dup{border-color:rgba(255,210,63,.45);background:linear-gradient(90deg,rgba(255,210,63,.12),rgba(4,16,10,.7));}',
      '.slf-chip.dup .slf-chip-p,.slf-chip.dup .slf-chip-t{color:var(--gold);}',
      '.slf-chip.bad{opacity:.72;}',
      '.slf-chip.bad .slf-chip-w{color:var(--muted);text-decoration:line-through;}',
      '.slf-chip.bad .slf-chip-p{color:var(--muted);}',
      '.slf-chip.bad .slf-chip-t{color:var(--danger);}',
      '.slf-next{margin:0;text-align:center;font-weight:700;}',
      /* Rangliste + Startbild */
      '.slf-boardwrap{padding:12px;display:flex;flex-direction:column;gap:8px;}',
      '.slf-boardwrap .mg-scoreboard{max-height:250px;overflow-y:auto;}',
      '.slf-hero{padding:28px 24px;text-align:center;display:flex;flex-direction:column;gap:12px;align-items:center;max-width:560px;margin:0 auto;}',
      '.slf-hero-ico{font-size:56px;line-height:1;filter:drop-shadow(0 0 16px var(--stroke-2));animation:slf-float 3s ease-in-out infinite;}',
      '@keyframes slf-float{0%,100%{transform:translateY(0) rotate(-4deg);}50%{transform:translateY(-8px) rotate(4deg);}}',
      '.slf-hero-l{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:1.4px;}',
      '.slf-diff{font-size:15px;padding:10px 16px;font-weight:800;}',
      '@media(max-width:560px){',
      '.slf-row{grid-template-columns:96px 1fr;gap:8px;}',
      '.slf-cat-lbl{font-size:13px;}',
      '.slf-rev-grid{grid-template-columns:1fr;}',
      '.slf-done{width:100%;}',
      '}'
    ].join(''));
  }
})();
