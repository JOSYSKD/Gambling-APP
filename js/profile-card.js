/* profile-card.js — anpassbare Profilkarte mit Level-Kosmetiks  (App.ProfileCard)
 *
 * Avatare, Rahmen, Banner und Titel schalten sich mit steigendem Level frei.
 * Auswahl in localStorage. Rendert (a) die Anzeige-Karte und (b) den Anpass-Editor;
 * beide werden auf der Profil-Seite eingehängt.
 */
(function () {
  'use strict';
  window.App = window.App || {};
  var UI = App.UI, el = UI.el;
  var KEY = 'gj_cosmetics';

  function lvl() { return (App.Progress && App.Progress.level) ? App.Progress.level() : 1; }
  // Maximales Level der Progression (jetzt 99999). App.Progress.MAX_LEVEL nutzen, falls
  // vorhanden — sonst der bekannte Deckel. So folgen die Top-Freischaltungen automatisch,
  // falls der Deckel später zentral geändert wird.
  var MAX = (App.Progress && App.Progress.MAX_LEVEL) || 99999;
  // Level lesbar formatieren (99999 -> 99.999), damit hohe Freischalt-Stufen sauber anzeigen.
  function fmtLv(n) { return (App.UI && App.UI.formatShort) ? App.UI.formatShort(n) : String(n); }

  /* ---------------- Kosmetik-Kataloge (unlock = benötigtes Level) ----------------
   * Die Freischalt-Level sind bewusst über die GESAMTE Spanne bis MAX (=99999) verteilt,
   * damit es auf jeder Progressions-Stufe noch etwas zu holen gibt. Bestehende Einträge
   * behalten ihr Level unverändert — Neues kommt oben drauf. */
  var AVATARS = [
    // Basis (unverändert)
    { id: 'monkey', e: '🐵', lv: 1 }, { id: 'parrot', e: '🦜', lv: 1 }, { id: 'clover', e: '🍀', lv: 1 }, { id: 'slot', e: '🎰', lv: 1 },
    { id: 'frog', e: '🐸', lv: 2 }, { id: 'gecko', e: '🦎', lv: 3 }, { id: 'tiger', e: '🐯', lv: 4 },
    { id: 'lion', e: '🦁', lv: 5 }, { id: 'snake', e: '🐍', lv: 6 }, { id: 'unicorn', e: '🦄', lv: 7 },
    { id: 'dragon', e: '🐉', lv: 8 }, { id: 'fire', e: '🔥', lv: 9 }, { id: 'crown', e: '👑', lv: 10 },
    { id: 'gem', e: '💎', lv: 11 }, { id: 'robot', e: '🤖', lv: 12 }, { id: 'alien', e: '👽', lv: 14 }, { id: 'goat', e: '🐐', lv: 16 },
    // Neu — über die ganze Spanne verteilt
    { id: 'wolf', e: '🐺', lv: 18 }, { id: 'eagle', e: '🦅', lv: 20 }, { id: 'shark', e: '🦈', lv: 22 },
    { id: 'octopus', e: '🐙', lv: 25 }, { id: 'gorilla', e: '🦍', lv: 30 }, { id: 'leopard', e: '🐆', lv: 40 },
    { id: 'peacock', e: '🦚', lv: 55 }, { id: 'trex', e: '🦖', lv: 75 }, { id: 'ninja', e: '🥷', lv: 100 },
    { id: 'wizard', e: '🧙', lv: 150 }, { id: 'joker', e: '🃏', lv: 250 }, { id: 'devil', e: '😈', lv: 400 },
    { id: 'ghost', e: '👻', lv: 650 }, { id: 'whale', e: '🐋', lv: 1000 }, { id: 'bolt', e: '⚡', lv: 1600 },
    { id: 'star', e: '🌟', lv: 2500 }, { id: 'comet', e: '☄️', lv: 4000 }, { id: 'planet', e: '🪐', lv: 6500 },
    { id: 'volcano', e: '🌋', lv: 10000 }, { id: 'trident', e: '🔱', lv: 16000 }, { id: 'moneybag', e: '💰', lv: 26000 },
    { id: 'trophy', e: '🏆', lv: 42000 }, { id: 'fleur', e: '⚜️', lv: 68000 }, { id: 'diamondblue', e: '💠', lv: MAX }
  ];
  var FRAMES = [
    // Basis (unverändert)
    { id: 'default', name: 'Standard', lv: 1 }, { id: 'neon', name: 'Neon', lv: 2 },
    { id: 'aqua', name: 'Aqua', lv: 3 }, { id: 'double', name: 'Doppellinie', lv: 4 },
    { id: 'gold', name: 'Gold', lv: 5 }, { id: 'grad', name: 'Verlauf', lv: 6 },
    { id: 'ice', name: 'Eis', lv: 7 }, { id: 'rainbow', name: 'Regenbogen', lv: 8 },
    { id: 'fire', name: 'Feuer', lv: 10 }, { id: 'royal', name: 'Königlich', lv: 12 },
    // Neu — 20 animierte Premium-Rahmen, verteilt bis MAX
    { id: 'emerald', name: 'Smaragd-Puls', lv: 14 }, { id: 'amber', name: 'Bernstein-Glut', lv: 18 },
    { id: 'sapphire', name: 'Saphir-Welle', lv: 25 }, { id: 'magma', name: 'Magma-Fluss', lv: 40 },
    { id: 'frost', name: 'Kristall-Frost', lv: 60 }, { id: 'pulse', name: 'Neon-Herzschlag', lv: 90 },
    { id: 'prism', name: 'Prisma-Lauf', lv: 140 }, { id: 'voltage', name: 'Blitzschlag', lv: 220 },
    { id: 'stardust', name: 'Sternenstaub', lv: 350 }, { id: 'aurora', name: 'Aurora', lv: 600 },
    { id: 'inferno', name: 'Inferno', lv: 1000 }, { id: 'cosmos', name: 'Kosmos', lv: 1800 },
    { id: 'goldrain', name: 'Goldregen', lv: 3200 }, { id: 'toxic', name: 'Toxisch', lv: 5500 },
    { id: 'royalaura', name: 'Königs-Aura', lv: 9000 }, { id: 'phoenix', name: 'Phönix', lv: 15000 },
    { id: 'obsidian', name: 'Obsidian-Blitz', lv: 25000 }, { id: 'spectrum', name: 'Prisma Maximum', lv: 42000 },
    { id: 'solar', name: 'Sonnenkorona', lv: 70000 }, { id: 'platinum', name: 'Platin-Diamant', lv: MAX }
  ];
  var BANNERS = [
    // Basis (unverändert)
    { id: 'jungle', name: 'Dschungel', lv: 1, css: 'linear-gradient(135deg,#0d3a22,#061a10)' },
    { id: 'aqua', name: 'Lagune', lv: 2, css: 'linear-gradient(135deg,#0d2a3a,#062028)' },
    { id: 'sunset', name: 'Sonnenuntergang', lv: 4, css: 'linear-gradient(135deg,#ff7a3c,#ff3d6d)' },
    { id: 'purple', name: 'Amethyst', lv: 6, css: 'linear-gradient(135deg,#a855f7,#6d28d9)' },
    { id: 'gold', name: 'Goldbarren', lv: 8, css: 'linear-gradient(135deg,#ffd23f,#e08a3c)' },
    { id: 'fire', name: 'Lava', lv: 10, css: 'linear-gradient(135deg,#ff2d55,#ff7a3c)' },
    { id: 'galaxy', name: 'Galaxie', lv: 12, css: 'linear-gradient(135deg,#22d3ff,#a855f7,#ff2fb9)' },
    { id: 'rainbow', name: 'Regenbogen', lv: 15, css: 'linear-gradient(90deg,#ff2d55,#ff9d3c,#ffd23f,#39ff14,#22d3ff,#a855f7)' },
    // Neu — verteilt bis MAX
    { id: 'emberglow', name: 'Glut', lv: 18, css: 'linear-gradient(135deg,#7a1f1f,#ff5a1f)' },
    { id: 'ocean', name: 'Tiefsee', lv: 25, css: 'linear-gradient(135deg,#012a4a,#2a6f97)' },
    { id: 'polar', name: 'Polarlicht', lv: 35, css: 'linear-gradient(135deg,#00f5a0,#00d9f5,#7a5cff)' },
    { id: 'candy', name: 'Bonbon', lv: 55, css: 'linear-gradient(135deg,#ff5fa2,#ff9a3c,#ffd23f)' },
    { id: 'toxic', name: 'Giftgrün', lv: 90, css: 'linear-gradient(135deg,#2bff88,#00b36b)' },
    { id: 'midnight', name: 'Mitternacht', lv: 160, css: 'linear-gradient(135deg,#0a0f2b,#3a1c71,#00d4ff)' },
    { id: 'inferno', name: 'Inferno', lv: 320, css: 'linear-gradient(135deg,#3a0000,#ff2d55,#ff9d3c)' },
    { id: 'nebula', name: 'Nebula', lv: 700, css: 'linear-gradient(135deg,#5f0f8b,#c31432,#22d3ff)' },
    { id: 'emeraldfield', name: 'Smaragdfeld', lv: 1500, css: 'linear-gradient(135deg,#004d40,#00e676,#b2ff59)' },
    { id: 'solarflare', name: 'Sonneneruption', lv: 4000, css: 'linear-gradient(135deg,#ff6a00,#ffd23f,#fff6b0)' },
    { id: 'obsidian', name: 'Obsidian', lv: 12000, css: 'linear-gradient(135deg,#0b0b0f,#2c2c3a,#00e5ff)' },
    { id: 'cosmos', name: 'Kosmos', lv: 40000, css: 'radial-gradient(circle at 30% 20%,#3a1c71,#0a0a1a 72%)' },
    { id: 'platinum', name: 'Platin', lv: MAX, css: 'linear-gradient(135deg,#8f9aa6,#e9eef5,#b9c4d0,#ffffff)' }
  ];
  var TITLES = [
    // Basis (unverändert)
    { id: 'auto', name: 'Level-Titel (automatisch)', lv: 1 },
    { id: 'rookie', name: 'Frischling', lv: 1 }, { id: 'lucky', name: 'Glückspilz', lv: 3 },
    { id: 'shark', name: 'Kartenhai', lv: 5 }, { id: 'highroller', name: 'High Roller', lv: 7 },
    { id: 'boss', name: 'Dschungel-Boss', lv: 9 }, { id: 'legend', name: 'Neon-Legende', lv: 12 },
    { id: 'god', name: 'Glücks-Gott', lv: 15 },
    // Neu — verteilt bis MAX
    { id: 'magician', name: 'Jackpot-Magier', lv: 20 }, { id: 'chipprince', name: 'Chip-Fürst', lv: 30 },
    { id: 'roulking', name: 'Roulette-König', lv: 45 }, { id: 'cardmage', name: 'Karten-Zauberer', lv: 70 },
    { id: 'diamondshark', name: 'Diamant-Hai', lv: 120 }, { id: 'neontitan', name: 'Neon-Titan', lv: 250 },
    { id: 'mogul', name: 'Millionen-Mogul', lv: 500 }, { id: 'overlord', name: 'Casino-Overlord', lv: 1200 },
    { id: 'emperor', name: 'Glücks-Imperator', lv: 3000 }, { id: 'whalelord', name: 'Legendärer Whale', lv: 8000 },
    { id: 'immortal', name: 'Unsterblicher Zocker', lv: 20000 }, { id: 'mythos', name: 'Lebende Legende', lv: 50000 },
    { id: 'platinlegend', name: 'Platin-Diamant-Legende', lv: MAX }
  ];

  /* ---------------- Namensfarben (ganz viele Töne + Verläufe/animiert) ----------------
   * Vollton = { color }, Verlauf = { grad, anim? }. Über die Level verteilt, die
   * meisten Töne früh frei, die animierten Regenbogen/Plasma-Varianten weiter oben. */
  var NC_SOLID = [
    ['white', 'Weiß', '#ffffff', 1], ['silver', 'Silber', '#d4dce6', 1], ['ash', 'Aschgrau', '#aab7c4', 1],
    ['neon', 'Neongrün', '#39ff14', 1], ['toxic', 'Giftgrün', '#b6ff00', 1], ['lime', 'Limette', '#7cfc00', 1],
    ['grass', 'Grasgrün', '#4caf50', 2], ['emerald', 'Smaragd', '#00e676', 3], ['mint', 'Minze', '#3dffa8', 2],
    ['jade', 'Jade', '#00d9a3', 3], ['pine', 'Tanne', '#2e8b57', 4], ['teal', 'Petrol', '#00e5d0', 3],
    ['cyan', 'Cyan', '#00fff2', 4], ['aqua', 'Aqua', '#22e6ff', 2], ['sky', 'Himmelblau', '#38bdf8', 2],
    ['azure', 'Azur', '#2d9bff', 3], ['ocean', 'Ozeanblau', '#1e6fff', 4], ['royalb', 'Königsblau', '#4d6dff', 2],
    ['cobalt', 'Kobalt', '#2c4bff', 5], ['navy', 'Marine', '#3f51b5', 4], ['indigo', 'Indigo', '#6a5cff', 3],
    ['violet', 'Violett', '#8b5cf6', 3], ['purple', 'Lila', '#a855f7', 2], ['amethyst', 'Amethyst', '#b06bff', 4],
    ['grape', 'Traube', '#7c3aed', 5], ['plum', 'Pflaume', '#9d4edd', 4], ['magenta', 'Magenta', '#ff2fb9', 3],
    ['fuchsia', 'Fuchsia', '#ff3df0', 5], ['pink', 'Pink', '#ff5fa2', 1], ['hotpink', 'Knallpink', '#ff2d78', 4],
    ['rose', 'Rosé', '#ff8fb0', 2], ['blush', 'Altrosa', '#e58aa0', 3], ['red', 'Rot', '#ff3b3b', 1],
    ['crimson', 'Karmin', '#ff1744', 3], ['fired', 'Feuerrot', '#ff2d00', 4], ['cherry', 'Kirsche', '#d90429', 5],
    ['coral', 'Koralle', '#ff6f5e', 2], ['salmon', 'Lachs', '#ff9a8a', 2], ['orange', 'Orange', '#ff8c2b', 1],
    ['tangerine', 'Mandarine', '#ff6a00', 3], ['amber', 'Bernstein', '#ffb300', 2], ['honey', 'Honig', '#ffc93c', 3],
    ['gold', 'Gold', '#ffd23f', 4], ['yellow', 'Gelb', '#ffe93f', 1], ['lemon', 'Zitrone', '#fff23f', 2],
    ['copper', 'Kupfer', '#c9743b', 4], ['bronze', 'Bronze', '#cd7f32', 3], ['sand', 'Sand', '#e0c48f', 2],
    ['slate', 'Schiefer', '#64748b', 2], ['steel', 'Stahl', '#b0bec5', 2]
  ].map(function (a) { return { id: a[0], name: a[1], color: a[2], lv: a[3] }; });
  var NC_FANCY = [
    { id: 'g-ocean', name: 'Ozean-Verlauf', lv: 4, grad: 'linear-gradient(90deg,#00d4ff,#4d6dff,#7a5cff)' },
    { id: 'g-fire', name: 'Feuer', lv: 5, grad: 'linear-gradient(90deg,#ff2d00,#ff9d3c,#ffd23f)', anim: true },
    { id: 'g-sunset', name: 'Sonnenuntergang', lv: 5, grad: 'linear-gradient(90deg,#ff7a3c,#ff3d6d,#a855f7)' },
    { id: 'g-emerald', name: 'Smaragd-Verlauf', lv: 6, grad: 'linear-gradient(90deg,#00e676,#00d9f5)' },
    { id: 'g-candy', name: 'Bonbon', lv: 6, grad: 'linear-gradient(90deg,#ff5fa2,#ff9a3c,#ffd23f)' },
    { id: 'g-rainbow', name: 'Regenbogen', lv: 7, grad: 'linear-gradient(90deg,#ff2d55,#ff9d3c,#ffd23f,#39ff14,#22d3ff,#a855f7)', anim: true },
    { id: 'g-flamingo', name: 'Flamingo', lv: 8, grad: 'linear-gradient(90deg,#ff2fb9,#ff8fb0,#ffd23f)' },
    { id: 'g-ice', name: 'Eiskristall', lv: 8, grad: 'linear-gradient(90deg,#a8ecff,#22d3ff,#e0f7ff)' },
    { id: 'g-gold', name: 'Goldbarren', lv: 9, grad: 'linear-gradient(90deg,#e08a3c,#ffd23f,#fff6b0,#ffd23f)', anim: true },
    { id: 'g-cyber', name: 'Cyberpunk', lv: 10, grad: 'linear-gradient(90deg,#00fff2,#ff00e6)', anim: true },
    { id: 'g-galaxy', name: 'Galaxie', lv: 12, grad: 'linear-gradient(90deg,#22d3ff,#a855f7,#ff2fb9)', anim: true },
    { id: 'g-royal', name: 'Königlich', lv: 13, grad: 'linear-gradient(90deg,#ffd23f,#a855f7,#ffd23f)', anim: true },
    { id: 'g-aurora', name: 'Aurora', lv: 15, grad: 'linear-gradient(90deg,#00f5a0,#00d9f5,#7a5cff)', anim: true },
    { id: 'g-lava', name: 'Lava', lv: 18, grad: 'linear-gradient(90deg,#3a0000,#ff2d55,#ff9d3c,#ffd23f)', anim: true },
    { id: 'g-matrix', name: 'Matrix', lv: 22, grad: 'linear-gradient(90deg,#003b00,#39ff14,#b6ff00,#39ff14)', anim: true },
    { id: 'g-plasma', name: 'Plasma', lv: 30, grad: 'linear-gradient(90deg,#ff2fb9,#22d3ff,#39ff14,#ffd23f,#ff2fb9)', anim: true }
  ];
  var NAME_COLORS = [{ id: 'default', name: 'Standard', lv: 1 }].concat(NC_SOLID, NC_FANCY);

  /* ---------------- Schriftarten: 30 coole Fonts (Google Fonts, siehe index.html) ----------------
   * family = kompletter font-family-Wert inkl. Fallback. Bei fehlendem Netz (file://
   * offline) greift automatisch der Fallback — die Auswahl bleibt trotzdem nutzbar. */
  var NAME_FONTS = [
    { id: 'default', name: 'Standard', lv: 1, family: '' },
    { id: 'orbitron', name: 'Orbitron', lv: 1, family: "'Orbitron',sans-serif" },
    { id: 'audiowide', name: 'Audiowide', lv: 1, family: "'Audiowide',sans-serif" },
    { id: 'russo', name: 'Russo One', lv: 1, family: "'Russo One',sans-serif" },
    { id: 'righteous', name: 'Righteous', lv: 1, family: "'Righteous',cursive" },
    { id: 'kanit', name: 'Kanit', lv: 1, family: "'Kanit',sans-serif" },
    { id: 'fredoka', name: 'Fredoka', lv: 1, family: "'Fredoka',sans-serif" },
    { id: 'bungee', name: 'Bungee', lv: 2, family: "'Bungee',cursive" },
    { id: 'pacifico', name: 'Pacifico', lv: 2, family: "'Pacifico',cursive" },
    { id: 'lobster', name: 'Lobster', lv: 2, family: "'Lobster',cursive" },
    { id: 'vt323', name: 'VT323', lv: 2, family: "'VT323',monospace" },
    { id: 'pixelify', name: 'Pixelify Sans', lv: 2, family: "'Pixelify Sans',sans-serif" },
    { id: 'bangers', name: 'Bangers', lv: 3, family: "'Bangers',cursive" },
    { id: 'marker', name: 'Permanent Marker', lv: 3, family: "'Permanent Marker',cursive" },
    { id: 'sriracha', name: 'Sriracha', lv: 3, family: "'Sriracha',cursive" },
    { id: 'silkscreen', name: 'Silkscreen', lv: 3, family: "'Silkscreen',cursive" },
    { id: 'titan', name: 'Titan One', lv: 4, family: "'Titan One',cursive" },
    { id: 'sigmar', name: 'Sigmar One', lv: 4, family: "'Sigmar One',cursive" },
    { id: 'monoton', name: 'Monoton', lv: 4, family: "'Monoton',cursive" },
    { id: 'wallpoet', name: 'Wallpoet', lv: 4, family: "'Wallpoet',sans-serif" },
    { id: 'pressstart', name: 'Press Start 2P', lv: 5, family: "'Press Start 2P',cursive" },
    { id: 'blackops', name: 'Black Ops One', lv: 5, family: "'Black Ops One',cursive" },
    { id: 'rubikmono', name: 'Rubik Mono One', lv: 5, family: "'Rubik Mono One',sans-serif" },
    { id: 'faster', name: 'Faster One', lv: 6, family: "'Faster One',cursive" },
    { id: 'bungeeshade', name: 'Bungee Shade', lv: 6, family: "'Bungee Shade',cursive" },
    { id: 'shrikhand', name: 'Shrikhand', lv: 7, family: "'Shrikhand',cursive" },
    { id: 'rye', name: 'Rye', lv: 7, family: "'Rye',cursive" },
    { id: 'metalmania', name: 'Metal Mania', lv: 8, family: "'Metal Mania',cursive" },
    { id: 'creepster', name: 'Creepster', lv: 9, family: "'Creepster',cursive" },
    { id: 'nosifer', name: 'Nosifer', lv: 12, family: "'Nosifer',cursive" },
    { id: 'nabla', name: 'Nabla (bunt)', lv: 15, family: "'Nabla',cursive" }
  ];

  /* Level-gated Suche: gibt das Item nur zurück, wenn es das Level erreicht. */
  function ncFor(id, level) { for (var i = 0; i < NAME_COLORS.length; i++) if (NAME_COLORS[i].id === id) return (level >= NAME_COLORS[i].lv) ? NAME_COLORS[i] : null; return null; }
  function nfFor(id, level) { for (var i = 0; i < NAME_FONTS.length; i++) if (NAME_FONTS[i].id === id) return (level >= NAME_FONTS[i].lv) ? NAME_FONTS[i] : null; return null; }

  /* Zentrale Anwendung von Namensfarbe + Schriftart auf ein Namens-Element.
   * `cos.nameColor`/`cos.nameFont` = gewählte Ids; `gold` = Höchstlevel-Goldname
   * (bleibt erhalten, solange keine eigene Farbe gewählt ist). Auch von app.js
   * (Bestenliste) und chat.js (Chat) aufgerufen, damit FREMDE Namen genauso
   * farbig/schriftlich erscheinen. */
  function styleName(node, cos, level, gold) {
    if (!node) return node;
    cos = cos || {}; level = Math.max(1, Number(level) || 1);
    node.classList.remove('pc-nc-grad', 'pc-nc-anim');
    node.style.color = ''; node.style.backgroundImage = '';
    node.style.webkitTextFillColor = ''; node.style.textShadow = '';
    var c = (cos.nameColor && cos.nameColor !== 'default') ? ncFor(cos.nameColor, level) : null;
    if (c) {
      if (c.grad) {
        node.classList.add('pc-nc-grad'); if (c.anim) node.classList.add('pc-nc-anim');
        node.style.backgroundImage = c.grad;
      } else {
        node.style.color = c.color; node.style.webkitTextFillColor = c.color;
      }
    }
    var f = (cos.nameFont && cos.nameFont !== 'default') ? nfFor(cos.nameFont, level) : null;
    node.style.fontFamily = f ? f.family : '';
    return node;
  }

  function firstOf(arr) { return arr[0].id; }
  var DEFAULT = { avatar: 'parrot', frame: 'default', banner: 'jungle', title: 'auto', nameColor: 'default', nameFont: 'default' };
  var sel = load();
  function load() {
    var s = App.Storage ? App.Storage.get(KEY, null) : null;
    if (!s || typeof s !== 'object') s = {};
    return Object.assign({}, DEFAULT, s);
  }
  function save() { if (App.Storage) App.Storage.set(KEY, sel); }

  function findById(arr, id) { for (var i = 0; i < arr.length; i++) if (arr[i].id === id) return arr[i]; return arr[0]; }
  function unlocked(item) { return lvl() >= item.lv; }

  function chosen(arr, id) { var it = findById(arr, id); return unlocked(it) ? it : arr[0]; }
  function titleText() {
    var t = chosen(TITLES, sel.title);
    if (t.id === 'auto') return (App.Progress && App.Progress.title) ? App.Progress.title() : 'Spieler';
    return t.name;
  }

  /* ---- Level-bewusste Varianten für FREMDE Spieler (deren Level, nicht meins) ---- */
  function chosenAt(arr, id, level) { var it = findById(arr, id); return (level >= it.lv) ? it : arr[0]; }
  function autoTitleFor(level) {
    // Spiegelt App.Progress.title() ohne Zugriff auf fremden Zustand.
    if (level >= (MAX || 99999)) return '👑 Platin-Legende';
    return TITLES_AUTO[Math.min(TITLES_AUTO.length - 1, Math.floor((level - 1) / 2))];
  }
  var TITLES_AUTO = ['Spielhallen-Neuling', 'Anfänger', 'Zocker', 'Stammgast', 'Kartenhai', 'Glücksritter',
    'High Roller', 'Casino-Profi', 'Roulette-König', 'Poker-Hai', 'Vegas-Veteran', 'Dschungel-Boss',
    'Neon-Legende', 'Casino-Magnat', 'Glücks-Gott'];
  function titleTextFor(cos, level) {
    var t = chosenAt(TITLES, (cos && cos.title) || 'auto', level);
    return t.id === 'auto' ? autoTitleFor(level) : t.name;
  }

  /* ---- Spiel-Name/Icon aus der Registry (Gambling + Minigames) ---- */
  function gameMeta(id) {
    var g = (App.Games && App.Games[id]) || (App.Minigames && App.Minigames[id]);
    if (g) return { icon: g.icon || '🎮', title: g.title || g.name || id };
    return { icon: '🎮', title: id };
  }

  /* ---------------- Ideen-Level: goldene Glühbirnen ----------------
   * Eigene Progression neben dem Spiel-Level: pro Ideen-Level (1–5, siehe
   * js/ideas.js) eine goldene Glühbirne oben auf der Karte. Ohne angenommene
   * Idee gibt es keine — dann bleibt der Banner leer wie bisher. */
  function ideaLevel() { return (App.Ideas && App.Ideas.level) ? App.Ideas.level() : 0; }
  function bulbsEl(ideaLv, tipText) {
    if (!ideaLv || ideaLv < 1) return null;
    var max = (App.Ideas && App.Ideas.MAX_LEVEL) || 5;
    var bulbs = [];
    for (var i = 0; i < ideaLv; i++) bulbs.push(el('span', { class: 'pc-bulb' }, ['💡']));
    var tip = tipText || ('Ideen-Level ' + ideaLv + '/' + max);
    return el('div', { class: 'pc-bulbs' + (ideaLv >= max ? ' pc-bulbs-max' : ''), title: tip }, bulbs);
  }

  /* ---------------- Daten-Modell ----------------
   * `viewOf()` baut aus dem lokalen Zustand (mich) bzw. aus einem Spieler-Datensatz
   * (andere, aus dem Präsenz-Register) ein einheitliches Objekt, das beide Renderer
   * (Karte + Bestenlisten-Zeile) verstehen. `data == null` => ich selbst. */
  function viewOf(data) {
    if (!data) {
      var s = App.Progress ? App.Progress.stats() : { wins: 0, rounds: 0, biggestWin: 0 };
      var il = ideaLevel();
      return {
        me: true,
        name: (App.Leaderboard && App.Leaderboard.getPlayerName && App.Leaderboard.getPlayerName()) || 'Spieler',
        cos: { avatar: sel.avatar, frame: sel.frame, banner: sel.banner, title: sel.title, nameColor: sel.nameColor, nameFont: sel.nameFont },
        level: lvl(),
        xpNow: App.Progress ? App.Progress.xpInLevel() : 0,
        xpMax: App.Progress ? App.Progress.xpForLevel() : 100,
        ideaLv: il,
        ideaTip: 'Ideen-Level ' + il + ((App.Ideas && App.Ideas.levelText) ? ' · ' + App.Ideas.levelText() : ''),
        gold: !!(App.Progress && App.Progress.isMaxLevel && App.Progress.isMaxLevel()),
        stats: { wins: s.wins, rounds: s.rounds, biggestWin: s.biggestWin, peak: App.Coins ? App.Coins.getPeak() : 0 },
        games: Object.keys((s && s.games) || {})
      };
    }
    var level = Math.max(1, Math.round(Number(data.level) || 1));
    var bulbs = Math.max(0, Math.round(Number(data.bulbs) || 0));
    var ideaLv = (App.Ideas && App.Ideas.levelForWins) ? App.Ideas.levelForWins(bulbs) : 0;
    var st = data.stats || {};
    return {
      me: false,
      name: data.name || 'Spieler',
      cos: data.cos || {},
      level: level,
      xpNow: null, xpMax: null,           // fremde XP-Feinheit tracken wir nicht
      ideaLv: ideaLv,
      ideaTip: 'Ideen-Level ' + ideaLv,
      gold: !!data.gold,
      stats: { wins: st.wins || 0, rounds: st.rounds || 0, biggestWin: st.biggestWin || 0, peak: Number(data.peak) || st.peak || 0 },
      games: (data.games && data.games.slice) ? data.games.slice() : []
    };
  }

  /* ---------------- Anzeige-Karte ---------------- */
  function renderCard() { return renderCardFor(null); }
  function renderCardFor(data) {
    injectCss();
    var v = viewOf(data);
    var av = chosenAt(AVATARS, v.cos.avatar, v.level),
        fr = chosenAt(FRAMES, v.cos.frame, v.level),
        bn = chosenAt(BANNERS, v.cos.banner, v.level);
    var title = v.me ? titleText() : titleTextFor(v.cos, v.level);
    var nameEl = styleName(el('div', { class: 'pc-name' + (v.gold ? ' name-gold' : '') }, [v.name]), v.cos, v.level, v.gold);
    var xpBar = (v.xpMax != null && v.xpMax > 0)
      ? [el('div', { class: 'pc-xp' }, [el('div', { class: 'pc-xp-fill', style: 'width:' + Math.max(0, Math.min(100, Math.round(v.xpNow / v.xpMax * 100))) + '%' })]),
         el('div', { class: 'pc-xp-l' }, [v.xpNow + ' / ' + v.xpMax + ' XP'])]
      : [];
    return el('div', { class: 'pc-card pc-frame-' + fr.id }, [
      el('div', { class: 'pc-banner', style: 'background:' + bn.css }),
      bulbsEl(v.ideaLv, v.ideaTip),
      el('div', { class: 'pc-body' }, [
        el('div', { class: 'pc-top' }, [
          el('div', { class: 'pc-avatar' }, [av.e]),
          el('div', { class: 'pc-id' }, [
            nameEl,
            el('div', { class: 'pc-title' }, ['⭐ ' + title])
          ]),
          el('div', { class: 'pc-lvl' }, [el('span', { class: 'pc-lvl-n' }, [fmtLv(v.level)]), el('span', { class: 'pc-lvl-t' }, ['LEVEL'])])
        ])
      ].concat(xpBar).concat([
        el('div', { class: 'pc-stats' }, [
          pcStat('🏆', UI.formatCoins(v.stats.wins), 'Siege'),
          pcStat('🎲', UI.formatCoins(v.stats.rounds), 'Runden'),
          pcStat('💥', UI.formatCoins(v.stats.biggestWin), 'Top-Gewinn'),
          pcStat('🪙', UI.formatCoins(v.stats.peak), 'Peak'),
          // Eigene Spielzeit (nur auf der eigenen Karte — App.Playtime kennt nur den lokalen Wert).
          v.me ? pcStat('⏱', (App.Playtime && App.Playtime.getFormatted) ? App.Playtime.getFormatted() : '—', 'Spielzeit') : null
        ])
      ]))
    ]);
  }
  function pcStat(ic, v, l) {
    return el('div', { class: 'pc-stat' }, [el('div', { class: 'pc-stat-ic' }, [ic]), el('div', { class: 'pc-stat-v' }, [v]), el('div', { class: 'pc-stat-l' }, [l])]);
  }

  /* ---------------- Bestenlisten-Zeile im Profilkarten-Look ----------------
   * Kompakte Zeile mit Banner-Hintergrund, Avatar im Rahmen, Level-Badge und
   * Glühbirnen — für die EIGENE Zeile in der Bestenliste (und optional andere). */
  function renderRow(data, extra) {
    injectCss();
    extra = extra || {};
    var v = viewOf(data);
    var av = chosenAt(AVATARS, v.cos.avatar, v.level),
        fr = chosenAt(FRAMES, v.cos.frame, v.level),
        bn = chosenAt(BANNERS, v.cos.banner, v.level);
    var right = [];
    if (extra.rankEl) right.push(el('div', { class: 'pcrow-rank' }, [extra.rankEl]));
    right.push(el('div', { class: 'pcrow-peak' }, [UI.formatCoins(extra.peak != null ? extra.peak : v.stats.peak) + ' 🪙']));
    if (extra.tag) right.push(extra.tag);
    return el('div', { class: 'pcrow pc-frame-' + fr.id + (v.me ? ' pcrow-me' : ''), style: '--pcrow-bn:' + bn.css.replace(/;/g, '') },
      [
        el('div', { class: 'pcrow-avatar' }, [av.e]),
        bulbsEl(v.ideaLv, v.ideaTip),
        el('div', { class: 'pcrow-id' }, [
          styleName(el('div', { class: 'pcrow-name' + (v.gold ? ' name-gold' : '') }, [v.name]), v.cos, v.level, v.gold),
          el('div', { class: 'pcrow-sub' }, ['Lv ' + fmtLv(v.level) + ' · ' + (v.me ? titleText() : titleTextFor(v.cos, v.level))])
        ]),
        el('div', { class: 'pcrow-right' }, right)
      ]);
  }

  /* ---------------- Liste der gespielten Spiele ---------------- */
  function gamesEl(gameIds) {
    var ids = (gameIds && gameIds.slice) ? gameIds.slice() : [];
    if (!ids.length) return el('p', { class: 'pcg-empty' }, ['Noch keine Spiele gespielt.']);
    return el('div', { class: 'pcg-grid' }, ids.map(function (id) {
      var m = gameMeta(id);
      return el('div', { class: 'pcg-chip', title: m.title }, [
        el('span', { class: 'pcg-ic' }, [m.icon]),
        el('span', { class: 'pcg-nm' }, [m.title])
      ]);
    }));
  }

  /* ---------------- Snapshot für den Präsenz-Heartbeat (siehe presence.js) ----------------
   * Klein halten: nur Auswahl-Ids + Zahlen, keine ganzen Kataloge. */
  function snapshot() {
    var s = App.Progress ? App.Progress.stats() : {};
    return {
      cos: { avatar: sel.avatar, frame: sel.frame, banner: sel.banner, title: sel.title, nameColor: sel.nameColor, nameFont: sel.nameFont },
      level: lvl(),
      bulbs: (App.Ideas && App.Ideas.wins) ? App.Ideas.wins() : 0,
      games: Object.keys((s && s.games) || {}),
      stats: { wins: s.wins || 0, rounds: s.rounds || 0, biggestWin: s.biggestWin || 0 }
    };
  }

  /* ---------------- Editor ---------------- */
  function renderCustomizer(onChange) {
    injectCss();
    var wrap = el('div', { class: 'glass pc-editor' });
    var tabsRow = el('div', { class: 'pc-tabs' });
    var body = el('div', { class: 'pc-tab-body' });
    var TABS = [
      { key: 'avatar', label: '🙂 Avatar', arr: AVATARS, render: avatarGrid },
      { key: 'frame', label: '🖼️ Rahmen', arr: FRAMES, render: frameGrid },
      { key: 'banner', label: '🎨 Banner', arr: BANNERS, render: bannerGrid },
      { key: 'nameColor', label: '🌈 Namensfarbe', arr: NAME_COLORS, render: colorGrid },
      { key: 'nameFont', label: '🔤 Schriftart', arr: NAME_FONTS, render: fontGrid },
      { key: 'title', label: '🏷️ Titel', arr: TITLES, render: titleGrid }
    ];
    var active = 'avatar';
    function drawTabs() {
      tabsRow.innerHTML = '';
      TABS.forEach(function (t) {
        tabsRow.appendChild(el('button', { class: 'pc-tab' + (t.key === active ? ' active' : ''), type: 'button', onclick: function () { active = t.key; drawTabs(); drawBody(); } }, [t.label]));
      });
    }
    function drawBody() { var t = TABS.filter(function (x) { return x.key === active; })[0]; body.innerHTML = ''; body.appendChild(t.render()); }

    function pick(kind, id, item) {
      if (!unlocked(item)) { UI.toast('Schaltet auf Level ' + fmtLv(item.lv) + ' frei', 'info'); if (App.Audio) App.Audio.sfx('error'); return; }
      sel[kind] = id; save(); if (App.Audio) App.Audio.sfx('select');
      drawBody(); if (onChange) onChange();
    }
    function lockTag(item) { return unlocked(item) ? null : el('span', { class: 'pc-lock' }, ['🔒 Lv ' + fmtLv(item.lv)]); }

    function avatarGrid() {
      return el('div', { class: 'pc-grid' }, AVATARS.map(function (a) {
        return el('button', { class: 'pc-opt' + (sel.avatar === a.id ? ' sel' : '') + (unlocked(a) ? '' : ' locked'), type: 'button', onclick: function () { pick('avatar', a.id, a); } }, [
          el('div', { class: 'pc-opt-em' }, [a.e]), lockTag(a)
        ]);
      }));
    }
    function frameGrid() {
      return el('div', { class: 'pc-grid' }, FRAMES.map(function (f) {
        return el('button', { class: 'pc-opt pc-frameprev pc-frame-' + f.id + (sel.frame === f.id ? ' sel' : '') + (unlocked(f) ? '' : ' locked'), type: 'button', onclick: function () { pick('frame', f.id, f); } }, [
          el('div', { class: 'pc-opt-lab' }, [f.name]), lockTag(f)
        ]);
      }));
    }
    function bannerGrid() {
      return el('div', { class: 'pc-grid pc-grid-wide' }, BANNERS.map(function (b) {
        return el('button', { class: 'pc-opt pc-banneropt' + (sel.banner === b.id ? ' sel' : '') + (unlocked(b) ? '' : ' locked'), type: 'button', onclick: function () { pick('banner', b.id, b); } }, [
          el('div', { class: 'pc-bannerprev', style: 'background:' + b.css }), el('div', { class: 'pc-opt-lab' }, [b.name]), lockTag(b)
        ]);
      }));
    }
    function colorGrid() {
      var name = (App.Leaderboard && App.Leaderboard.getPlayerName && App.Leaderboard.getPlayerName()) || 'Name';
      return el('div', { class: 'pc-colorgrid' }, NAME_COLORS.map(function (c) {
        var prev = el('div', { class: 'pc-colorname', style: 'font-family:' + fontFamilyOf() }, [name]);
        styleName(prev, { nameColor: c.id, nameFont: sel.nameFont }, 99999999, false);
        return el('button', { class: 'pc-coloropt' + (sel.nameColor === c.id ? ' sel' : '') + (unlocked(c) ? '' : ' locked'), type: 'button', onclick: function () { pick('nameColor', c.id, c); } }, [
          prev, el('div', { class: 'pc-opt-lab' }, [c.name]), lockTag(c)
        ]);
      }));
    }
    function fontGrid() {
      var name = (App.Leaderboard && App.Leaderboard.getPlayerName && App.Leaderboard.getPlayerName()) || 'Name';
      return el('div', { class: 'pc-fontgrid' }, NAME_FONTS.map(function (f) {
        var prev = el('div', { class: 'pc-fontname', style: 'font-family:' + (f.family || 'inherit') }, [name]);
        return el('button', { class: 'pc-fontopt' + (sel.nameFont === f.id ? ' sel' : '') + (unlocked(f) ? '' : ' locked'), type: 'button', onclick: function () { pick('nameFont', f.id, f); } }, [
          prev, el('div', { class: 'pc-opt-lab' }, [f.name]), lockTag(f)
        ]);
      }));
    }
    function fontFamilyOf() { var f = nfFor(sel.nameFont, 99999999); return (f && f.family) ? f.family : 'inherit'; }

    function titleGrid() {
      return el('div', { class: 'pc-titlelist' }, TITLES.map(function (t) {
        return el('button', { class: 'pc-titleopt' + (sel.title === t.id ? ' sel' : '') + (unlocked(t) ? '' : ' locked'), type: 'button', onclick: function () { pick('title', t.id, t); } }, [
          el('span', {}, ['⭐ ' + (t.id === 'auto' ? t.name : t.name)]), lockTag(t)
        ]);
      }));
    }

    drawTabs(); drawBody();
    wrap.appendChild(el('label', { class: 'field-label' }, ['🎨 Profilkarte anpassen']));
    wrap.appendChild(el('p', { class: 'lb-hint' }, ['Mehr Kosmetiks schalten sich mit steigendem Level frei. Dein aktuelles Level: ', el('b', {}, ['' + lvl()])]));
    wrap.appendChild(tabsRow);
    wrap.appendChild(body);
    return wrap;
  }

  /* ---------------- CSS ---------------- */
  var cssDone = false;
  function injectCss() {
    if (cssDone) return; cssDone = true;
    UI.injectStyle('profilecard-css', [
      /* ---- Namensfarbe: Verlaufs-/Animations-Namen (styleName) ---- */
      '.pc-nc-grad{-webkit-background-clip:text;background-clip:text;color:transparent!important;-webkit-text-fill-color:transparent!important;background-size:100% auto;}',
      '.pc-nc-anim{background-size:220% auto;animation:pc-nc-shift 3s linear infinite;}',
      '@keyframes pc-nc-shift{0%{background-position:0% 50%;}100%{background-position:220% 50%;}}',
      /* ---- Editor: Namensfarben-Raster ---- */
      '.pc-colorgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(96px,1fr));gap:8px;}',
      '.pc-coloropt{display:flex;flex-direction:column;align-items:center;gap:4px;padding:8px 6px;border-radius:12px;border:2px solid var(--stroke);background:rgba(4,16,10,.5);cursor:pointer;position:relative;}',
      '.pc-coloropt.sel{border-color:var(--neon);box-shadow:0 0 12px rgba(57,255,20,.5);}',
      '.pc-coloropt.locked{opacity:.5;}',
      '.pc-colorname{font-weight:900;font-size:16px;line-height:1.1;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      /* ---- Editor: Schriftarten-Raster ---- */
      '.pc-fontgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px;}',
      '.pc-fontopt{display:flex;flex-direction:column;align-items:center;gap:5px;padding:12px 8px;border-radius:12px;border:2px solid var(--stroke);background:rgba(4,16,10,.5);cursor:pointer;position:relative;min-height:70px;justify-content:center;}',
      '.pc-fontopt.sel{border-color:var(--neon);box-shadow:0 0 12px rgba(57,255,20,.5);}',
      '.pc-fontopt.locked{opacity:.5;}',
      '.pc-fontname{font-size:21px;color:var(--leaf);line-height:1.15;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.pc-card{position:relative;border-radius:20px;overflow:hidden;border:2px solid var(--stroke);background:rgba(9,32,21,.55);margin-bottom:16px;}',
      '.pc-banner{height:88px;}',
      '.pc-body{padding:0 18px 16px;}',
      /* ---- Bestenlisten-Zeile im Profilkarten-Look (renderRow) ---- */
      '.pcrow{position:relative;display:flex;align-items:center;gap:12px;padding:10px 14px;border-radius:16px;overflow:hidden;border:2px solid var(--stroke);background:rgba(9,32,21,.55);}',
      '.pcrow::before{content:"";position:absolute;inset:0;background:var(--pcrow-bn);opacity:.22;z-index:0;}',
      '.pcrow > *{position:relative;z-index:1;}',
      '.pcrow-me{box-shadow:0 0 0 2px var(--neon),0 0 18px var(--stroke-2);}',
      '.pcrow-avatar{width:46px;height:46px;flex:0 0 auto;border-radius:13px;background:rgba(4,16,10,.85);border:2px solid var(--neon);display:flex;align-items:center;justify-content:center;font-size:26px;}',
      '.pcrow .pc-bulbs{position:static;padding:3px 6px;}',
      '.pcrow .pc-bulb{font-size:14px;}',
      '.pcrow-id{flex:1;min-width:0;}',
      '.pcrow-name{font-size:16px;font-weight:900;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      '.pcrow-sub{font-size:12px;color:var(--gold);font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      '.pcrow-right{display:flex;align-items:center;gap:10px;flex:0 0 auto;}',
      '.pcrow-rank{font-size:15px;font-weight:900;color:var(--muted);min-width:34px;text-align:right;}',
      '.pcrow-peak{font-weight:900;color:var(--gold);font-variant-numeric:tabular-nums;white-space:nowrap;}',
      /* ---- gespielte Spiele (gamesEl) ---- */
      '.pcg-grid{display:flex;flex-wrap:wrap;gap:8px;}',
      '.pcg-chip{display:flex;align-items:center;gap:6px;padding:6px 10px;border-radius:999px;background:rgba(4,16,10,.6);border:1px solid var(--stroke);font-size:13px;font-weight:700;}',
      '.pcg-ic{font-size:15px;}',
      '.pcg-empty{opacity:.6;font-size:14px;}',
      '.pcp-open{cursor:pointer;transition:transform .12s;}',
      '.pcp-open:hover{transform:translateY(-1px);}',
      // Ideen-Level: goldene Glühbirnen oben rechts auf dem Banner (siehe js/ideas.js)
      '.pc-bulbs{position:absolute;top:8px;right:10px;display:flex;gap:1px;padding:4px 8px;border-radius:99px;',
      'background:rgba(4,16,10,.55);border:1px solid rgba(255,210,63,.55);backdrop-filter:blur(3px);cursor:help;}',
      '.pc-bulb{font-size:17px;line-height:1;filter:drop-shadow(0 0 5px rgba(255,210,63,.95)) saturate(1.5);}',
      // Höchstes Ideen-Level (5): die Reihe pulsiert golden
      '.pc-bulbs-max{border-color:var(--gold);box-shadow:0 0 12px rgba(255,210,63,.55);animation:pc-bulbpulse 1.8s ease-in-out infinite;}',
      '@keyframes pc-bulbpulse{0%,100%{box-shadow:0 0 10px rgba(255,210,63,.45);}50%{box-shadow:0 0 20px rgba(255,210,63,.9);}}',
      '.pc-top{display:flex;align-items:flex-end;gap:14px;margin-top:-38px;}',
      '.pc-avatar{width:78px;height:78px;flex:0 0 auto;border-radius:20px;background:rgba(4,16,10,.85);border:3px solid var(--neon);display:flex;align-items:center;justify-content:center;font-size:42px;box-shadow:0 6px 18px rgba(0,0,0,.4);}',
      '.pc-id{flex:1;min-width:0;padding-bottom:4px;}',
      '.pc-name{font-size:20px;font-weight:900;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-shadow:0 1px 6px rgba(0,0,0,.5);}',
      '.pc-title{color:var(--gold);font-weight:800;font-size:13px;}',
      '.pc-lvl{flex:0 0 auto;text-align:center;padding-bottom:4px;}',
      '.pc-lvl-n{display:block;font-size:26px;font-weight:900;color:var(--gold);line-height:1;text-shadow:0 0 12px rgba(255,210,63,.5);}',
      '.pc-lvl-t{font-size:10px;letter-spacing:2px;color:var(--muted);font-weight:800;}',
      '.pc-xp{height:8px;border-radius:99px;background:rgba(255,255,255,.1);overflow:hidden;margin:12px 0 4px;}',
      '.pc-xp-fill{height:100%;background:linear-gradient(90deg,var(--neon),var(--gold));box-shadow:0 0 8px var(--stroke-2);}',
      '.pc-xp-l{font-size:11px;color:var(--muted);text-align:right;font-variant-numeric:tabular-nums;}',
      '.pc-stats{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-top:12px;}',
      '.pc-stat{text-align:center;padding:8px 4px;border-radius:12px;background:rgba(4,16,10,.5);border:1px solid var(--stroke);}',
      '.pc-stat-ic{font-size:18px;}',
      '.pc-stat-v{font-weight:900;color:var(--gold);font-size:15px;font-variant-numeric:tabular-nums;}',
      '.pc-stat-l{font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;font-weight:800;}',
      // Rahmen-Varianten
      '.pc-frame-neon{border-color:var(--neon);box-shadow:0 0 18px var(--stroke-2),inset 0 0 12px var(--stroke);}',
      '.pc-frame-aqua{border-color:var(--aqua);box-shadow:0 0 16px rgba(51,230,208,.4);}',
      '.pc-frame-double{border-style:double;border-width:5px;border-color:var(--neon);}',
      '.pc-frame-gold{border-color:var(--gold);box-shadow:0 0 18px rgba(255,210,63,.5);}',
      '.pc-frame-grad{border:2px solid transparent;background-image:linear-gradient(rgba(9,32,21,.85),rgba(9,32,21,.85)),linear-gradient(135deg,var(--neon),var(--aqua),var(--gold));background-origin:border-box;background-clip:padding-box,border-box;}',
      '.pc-frame-ice{border-color:#7fdcff;box-shadow:0 0 18px rgba(127,220,255,.5);}',
      '.pc-frame-rainbow{border:3px solid transparent;background-image:linear-gradient(rgba(9,32,21,.85),rgba(9,32,21,.85)),linear-gradient(90deg,#ff2d55,#ff9d3c,#ffd23f,#39ff14,#22d3ff,#a855f7,#ff2d55);background-size:100% 100%,300% 100%;background-origin:border-box;background-clip:padding-box,border-box;animation:pc-rain 6s linear infinite;}',
      '@keyframes pc-rain{to{background-position:0 0,300% 0;}}',
      '.pc-frame-fire{border:3px solid transparent;background-image:linear-gradient(rgba(9,32,21,.85),rgba(9,32,21,.85)),linear-gradient(0deg,#ff2d55,#ff9d3c,#ffd23f);background-origin:border-box;background-clip:padding-box,border-box;box-shadow:0 0 22px rgba(255,90,40,.5);}',
      '.pc-frame-royal{border:4px double var(--gold);box-shadow:0 0 22px rgba(255,210,63,.5),inset 0 0 16px rgba(168,85,247,.3);}',
      // Editor
      '.pc-editor{padding:16px;display:flex;flex-direction:column;gap:12px;margin-bottom:16px;}',
      '.pc-tabs{display:flex;gap:8px;flex-wrap:wrap;}',
      '.pc-tab{padding:8px 12px;border-radius:99px;border:1px solid var(--stroke);background:rgba(4,16,10,.5);color:var(--muted);font-weight:800;cursor:pointer;font-size:13px;}',
      '.pc-tab.active{border-color:var(--neon);color:var(--text);box-shadow:0 0 0 1px var(--stroke-2);}',
      '.pc-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(66px,1fr));gap:10px;}',
      '.pc-grid-wide{grid-template-columns:repeat(auto-fill,minmax(120px,1fr));}',
      '.pc-opt{position:relative;padding:10px 6px;border-radius:14px;border:1px solid var(--stroke);background:rgba(4,16,10,.5);cursor:pointer;color:var(--text);display:flex;flex-direction:column;align-items:center;gap:4px;transition:.12s;}',
      '.pc-opt:hover{transform:translateY(-2px);}',
      '.pc-opt.sel{border-color:var(--neon);box-shadow:0 0 0 2px var(--neon);}',
      '.pc-opt.locked{opacity:.55;filter:grayscale(.5);}',
      '.pc-opt-em{font-size:30px;line-height:1;}',
      '.pc-opt-lab{font-size:12px;font-weight:800;}',
      '.pc-frameprev{min-height:52px;justify-content:center;}',
      '.pc-lock{font-size:10px;font-weight:800;color:var(--gold);}',
      '.pc-bannerprev{width:100%;height:30px;border-radius:8px;}',
      '.pc-titlelist{display:flex;flex-direction:column;gap:8px;}',
      '.pc-titleopt{display:flex;justify-content:space-between;align-items:center;padding:11px 14px;border-radius:12px;border:1px solid var(--stroke);background:rgba(4,16,10,.5);color:var(--text);font-weight:800;cursor:pointer;}',
      '.pc-titleopt.sel{border-color:var(--neon);box-shadow:0 0 0 1px var(--stroke-2);}',
      '.pc-titleopt.locked{opacity:.55;}',

      /* =============================================================================
       * PREMIUM-RAHMEN (neu) — bewusst NACH .pc-opt platziert, damit die Effekte
       * (gleiche Spezifität, spätere Quelle) auch in der Customizer-Vorschau
       * gewinnen und nicht vom Editor-Basis-Style überschrieben werden.
       * Reines CSS, keine externen Assets -> file://-tauglich.
       * ============================================================================= */
      // Gemeinsame Keyframes
      '@keyframes pc-flow{to{background-position:0 0,300% 0;}}',
      '@keyframes pc-flow4{to{background-position:0 0,400% 0;}}',
      '@keyframes pc-twinkle{0%,100%{opacity:.35;}50%{opacity:1;}}',
      '@keyframes pc-sheen{0%{left:-70%;}55%,100%{left:130%;}}',
      '@keyframes pc-diamond{0%,100%{opacity:.5;transform:scale(1);}50%{opacity:1;transform:scale(1.06);}}',
      // Fließende Farbverlaufs-Rahmen teilen sich eine Grund-Deko
      '.pc-frame-sapphire,.pc-frame-magma,.pc-frame-prism,.pc-frame-aurora,.pc-frame-inferno,.pc-frame-cosmos,.pc-frame-goldrain,.pc-frame-phoenix,.pc-frame-spectrum,.pc-frame-platinum{background-origin:border-box;background-clip:padding-box,border-box;background-size:100% 100%,300% 100%;background-position:0 0,0 0;}',

      // 1 Smaragd-Puls — grüner Neon-Puls
      '.pc-frame-emerald{border-color:#00ff9d;animation:pc-p-emerald 1.9s ease-in-out infinite;}',
      '@keyframes pc-p-emerald{0%,100%{box-shadow:0 0 8px rgba(0,255,157,.35),inset 0 0 6px rgba(0,255,157,.18);}50%{box-shadow:0 0 26px rgba(0,255,157,.9),inset 0 0 16px rgba(0,255,157,.4);}}',
      // 2 Bernstein-Glut — warmes Flackern
      '.pc-frame-amber{border-color:#ffb347;animation:pc-p-amber 1.5s ease-in-out infinite;}',
      '@keyframes pc-p-amber{0%,100%{box-shadow:0 0 8px rgba(255,140,0,.4),inset 0 0 8px rgba(255,90,0,.25);}45%{box-shadow:0 0 22px rgba(255,170,40,.9),inset 0 0 14px rgba(255,110,0,.5);}70%{box-shadow:0 0 12px rgba(255,120,0,.6);}}',
      // 3 Saphir-Welle — fließender blauer Verlauf
      '.pc-frame-sapphire{border:3px solid transparent;background-image:linear-gradient(rgba(9,32,21,.85),rgba(9,32,21,.85)),linear-gradient(90deg,#0a2a6b,#2a6ff2,#7ab8ff,#2a6ff2,#0a2a6b);box-shadow:0 0 16px rgba(60,140,255,.5);animation:pc-flow 5s linear infinite;}',
      // 4 Magma-Fluss — fließende Lava
      '.pc-frame-magma{border:3px solid transparent;background-image:linear-gradient(rgba(9,32,21,.85),rgba(9,32,21,.85)),linear-gradient(90deg,#7a0000,#ff2d00,#ff9d3c,#ff2d00,#7a0000);box-shadow:0 0 20px rgba(255,70,0,.55);animation:pc-flow 4s linear infinite;}',
      // 5 Kristall-Frost — eisiger Schimmer + Frost-Funkeln
      '.pc-frame-frost{border-color:#aee9ff;animation:pc-p-frost 3s ease-in-out infinite;}',
      '@keyframes pc-p-frost{0%,100%{box-shadow:0 0 14px rgba(174,233,255,.45),inset 0 0 10px rgba(174,233,255,.2);}50%{box-shadow:0 0 28px rgba(210,245,255,.9),inset 0 0 18px rgba(174,233,255,.45);}}',
      '.pc-frame-frost::after{content:"";position:absolute;inset:0;pointer-events:none;z-index:6;border-radius:inherit;background-image:radial-gradient(2px 2px at 8% 20%,#fff,transparent 60%),radial-gradient(1.5px 1.5px at 92% 30%,#e6f9ff,transparent 60%),radial-gradient(2px 2px at 20% 88%,#fff,transparent 60%),radial-gradient(1.5px 1.5px at 80% 82%,#cdefff,transparent 60%),radial-gradient(2px 2px at 50% 6%,#fff,transparent 60%);animation:pc-twinkle 2.6s ease-in-out infinite;}',
      // 6 Neon-Herzschlag — doppelter Puls
      '.pc-frame-pulse{border-color:#39ff14;animation:pc-heart 1.4s ease-in-out infinite;}',
      '@keyframes pc-heart{0%,100%{box-shadow:0 0 6px rgba(57,255,20,.4);}20%{box-shadow:0 0 22px rgba(57,255,20,.95),inset 0 0 12px rgba(57,255,20,.5);}35%{box-shadow:0 0 8px rgba(57,255,20,.4);}55%{box-shadow:0 0 22px rgba(57,255,20,.95);}}',
      // 7 Prisma-Lauf — schneller Regenbogen-Lauf
      '.pc-frame-prism{border:3px solid transparent;background-image:linear-gradient(rgba(9,32,21,.85),rgba(9,32,21,.85)),linear-gradient(90deg,#ff2d55,#ff9d3c,#ffd23f,#39ff14,#22d3ff,#a855f7,#ff2d55);box-shadow:0 0 16px rgba(120,200,255,.4);animation:pc-flow 3s linear infinite;}',
      // 8 Blitzschlag — elektrisches Flackern
      '.pc-frame-voltage{border-color:#7df9ff;animation:pc-volt 1.1s steps(1,end) infinite;}',
      '@keyframes pc-volt{0%,100%{box-shadow:0 0 10px rgba(125,249,255,.5),inset 0 0 8px rgba(125,249,255,.3);border-color:#7df9ff;}12%{box-shadow:0 0 30px rgba(220,255,255,1),inset 0 0 16px rgba(125,249,255,.6);border-color:#fff;}18%{box-shadow:0 0 6px rgba(125,249,255,.3);border-color:#3a86ff;}55%{box-shadow:0 0 26px rgba(180,240,255,.95);border-color:#fff;}62%{box-shadow:0 0 8px rgba(125,249,255,.4);}}',
      // 9 Sternenstaub — funkelnde Sterne auf Violett
      '.pc-frame-stardust{border-color:#b388ff;box-shadow:0 0 16px rgba(160,110,255,.5),inset 0 0 12px rgba(80,40,160,.4);}',
      '.pc-frame-stardust::after{content:"";position:absolute;inset:0;pointer-events:none;z-index:6;border-radius:inherit;background-image:radial-gradient(2px 2px at 10% 22%,#fff,transparent 60%),radial-gradient(1.5px 1.5px at 88% 18%,#d6bcff,transparent 60%),radial-gradient(2px 2px at 24% 82%,#fff,transparent 60%),radial-gradient(1.5px 1.5px at 78% 78%,#fff,transparent 60%),radial-gradient(2px 2px at 55% 40%,#c9a8ff,transparent 60%),radial-gradient(1.5px 1.5px at 40% 12%,#fff,transparent 60%);animation:pc-twinkle 2.2s ease-in-out infinite;}',
      // 10 Aurora — sanft fließendes Polarlicht
      '.pc-frame-aurora{border:3px solid transparent;background-image:linear-gradient(rgba(9,32,21,.85),rgba(9,32,21,.85)),linear-gradient(90deg,#00f5a0,#00d9f5,#7a5cff,#00f5a0);box-shadow:0 0 20px rgba(0,220,180,.5);animation:pc-flow 6s linear infinite;}',
      // 11 Inferno — intensiver Flammenlauf + Glut-Puls
      '.pc-frame-inferno{border:3px solid transparent;background-image:linear-gradient(rgba(9,32,21,.85),rgba(9,32,21,.85)),linear-gradient(90deg,#3a0000,#ff2d00,#ff6a00,#ffd23f,#ff2d00,#3a0000);animation:pc-flow 3s linear infinite,pc-p-inferno 1.6s ease-in-out infinite;}',
      '@keyframes pc-p-inferno{0%,100%{box-shadow:0 0 14px rgba(255,60,0,.5);}50%{box-shadow:0 0 30px rgba(255,120,0,.95),inset 0 0 16px rgba(255,60,0,.4);}}',
      // 12 Kosmos — Galaxie-Lauf + Sterne
      '.pc-frame-cosmos{border:3px solid transparent;background-image:linear-gradient(rgba(9,32,21,.85),rgba(9,32,21,.85)),linear-gradient(90deg,#3a1c71,#c31432,#22d3ff,#a855f7,#3a1c71);box-shadow:0 0 20px rgba(120,80,255,.55);animation:pc-flow 7s linear infinite;}',
      '.pc-frame-cosmos::after{content:"";position:absolute;inset:0;pointer-events:none;z-index:6;border-radius:inherit;background-image:radial-gradient(2px 2px at 14% 24%,#fff,transparent 60%),radial-gradient(1.5px 1.5px at 84% 20%,#bfe0ff,transparent 60%),radial-gradient(2px 2px at 30% 80%,#fff,transparent 60%),radial-gradient(1.5px 1.5px at 70% 84%,#fff,transparent 60%),radial-gradient(2px 2px at 52% 14%,#e0c8ff,transparent 60%);animation:pc-twinkle 2s ease-in-out infinite;}',
      // 13 Goldregen — Gold-Schimmer + Glitzer
      '.pc-frame-goldrain{border:3px solid transparent;background-image:linear-gradient(rgba(9,32,21,.85),rgba(9,32,21,.85)),linear-gradient(90deg,#8a5a00,#ffd23f,#fff3b0,#ffd23f,#8a5a00);box-shadow:0 0 20px rgba(255,210,63,.6);animation:pc-flow 4.5s linear infinite;}',
      '.pc-frame-goldrain::after{content:"";position:absolute;inset:0;pointer-events:none;z-index:6;border-radius:inherit;background-image:radial-gradient(2px 2px at 12% 20%,#fff6c0,transparent 60%),radial-gradient(1.5px 1.5px at 86% 26%,#ffe98a,transparent 60%),radial-gradient(2px 2px at 22% 84%,#fff,transparent 60%),radial-gradient(1.5px 1.5px at 78% 80%,#ffe98a,transparent 60%),radial-gradient(2px 2px at 50% 10%,#fff6c0,transparent 60%);animation:pc-twinkle 1.8s ease-in-out infinite;}',
      // 14 Toxisch — radioaktiver Säure-Puls
      '.pc-frame-toxic{border-color:#aaff00;animation:pc-p-toxic 1.7s ease-in-out infinite;}',
      '@keyframes pc-p-toxic{0%,100%{box-shadow:0 0 10px rgba(170,255,0,.45),inset 0 0 8px rgba(120,200,0,.3);}50%{box-shadow:0 0 30px rgba(170,255,0,1),inset 0 0 18px rgba(120,255,0,.5);}}',
      // 15 Königs-Aura — Lila/Gold-Aura
      '.pc-frame-royalaura{border:3px double #ffd23f;animation:pc-royalaura 3.5s ease-in-out infinite;}',
      '@keyframes pc-royalaura{0%,100%{box-shadow:0 0 16px rgba(255,210,63,.5),inset 0 0 14px rgba(168,85,247,.35);}50%{box-shadow:0 0 30px rgba(168,85,247,.85),inset 0 0 20px rgba(255,210,63,.5);}}',
      // 16 Phönix — Feuerlauf + Glut-Funken + Glut-Puls
      '.pc-frame-phoenix{border:4px solid transparent;background-image:linear-gradient(rgba(9,32,21,.9),rgba(9,32,21,.9)),linear-gradient(90deg,#ff2d00,#ff9d3c,#ffd23f,#fff3b0,#ff9d3c,#ff2d00);animation:pc-flow 3.5s linear infinite,pc-p-inferno 1.8s ease-in-out infinite;}',
      '.pc-frame-phoenix::after{content:"";position:absolute;inset:0;pointer-events:none;z-index:6;border-radius:inherit;background-image:radial-gradient(2px 2px at 16% 24%,#fff3b0,transparent 60%),radial-gradient(1.5px 1.5px at 82% 22%,#ffb060,transparent 60%),radial-gradient(2px 2px at 26% 82%,#fff,transparent 60%),radial-gradient(1.5px 1.5px at 74% 80%,#ff9d3c,transparent 60%);animation:pc-twinkle 1.6s ease-in-out infinite;}',
      // 17 Obsidian-Blitz — dunkles Metall + Cyan-Sheen + Funken
      '.pc-frame-obsidian{border:3px solid #2c2c3a;background:linear-gradient(160deg,rgba(10,10,16,.92),rgba(30,30,44,.92));box-shadow:0 0 18px rgba(0,229,255,.35),inset 0 0 14px rgba(0,0,0,.6);overflow:hidden;}',
      '.pc-frame-obsidian::before{content:"";position:absolute;top:0;left:-70%;width:55%;height:100%;pointer-events:none;z-index:5;background:linear-gradient(115deg,transparent 0%,rgba(120,240,255,.55) 50%,transparent 100%);transform:skewX(-18deg);animation:pc-sheen 3s ease-in-out infinite;}',
      '.pc-frame-obsidian::after{content:"";position:absolute;inset:0;pointer-events:none;z-index:6;border-radius:inherit;background-image:radial-gradient(1.5px 1.5px at 18% 26%,#aef6ff,transparent 60%),radial-gradient(2px 2px at 82% 24%,#fff,transparent 60%),radial-gradient(1.5px 1.5px at 30% 82%,#8fefff,transparent 60%),radial-gradient(1.5px 1.5px at 70% 80%,#fff,transparent 60%);animation:pc-twinkle 1.4s ease-in-out infinite;}',
      // 18 Prisma Maximum — volles Spektrum, sehr schnell + Sheen + Funkeln
      '.pc-frame-spectrum{border:4px solid transparent;background-image:linear-gradient(rgba(9,32,21,.85),rgba(9,32,21,.85)),linear-gradient(90deg,#ff2d55,#ff9d3c,#ffd23f,#39ff14,#22d3ff,#3a86ff,#a855f7,#ff2fb9,#ff2d55);background-size:100% 100%,400% 100%;box-shadow:0 0 24px rgba(160,120,255,.55);animation:pc-flow4 2.5s linear infinite;}',
      '.pc-frame-spectrum::before{content:"";position:absolute;top:0;left:-70%;width:55%;height:100%;pointer-events:none;z-index:5;background:linear-gradient(115deg,transparent 0%,rgba(255,255,255,.5) 50%,transparent 100%);transform:skewX(-18deg);animation:pc-sheen 3.2s ease-in-out infinite;}',
      '.pc-frame-spectrum::after{content:"";position:absolute;inset:0;pointer-events:none;z-index:6;border-radius:inherit;background-image:radial-gradient(2px 2px at 14% 22%,#fff,transparent 60%),radial-gradient(1.5px 1.5px at 86% 26%,#fff,transparent 60%),radial-gradient(2px 2px at 50% 12%,#fff,transparent 60%);animation:pc-twinkle 1.9s ease-in-out infinite;}',
      // 19 Sonnenkorona — strahlendes Gold/Weiss + Funkeln
      '.pc-frame-solar{border:4px solid transparent;background-image:linear-gradient(rgba(9,32,21,.9),rgba(9,32,21,.9)),radial-gradient(circle,#fff6b0,#ffd23f 40%,#ff9d3c 72%);background-origin:border-box;background-clip:padding-box,border-box;animation:pc-p-solar 2.4s ease-in-out infinite;}',
      '@keyframes pc-p-solar{0%,100%{box-shadow:0 0 18px rgba(255,210,63,.6),inset 0 0 14px rgba(255,180,40,.35);}50%{box-shadow:0 0 40px rgba(255,240,160,1),inset 0 0 22px rgba(255,200,60,.55);}}',
      '.pc-frame-solar::after{content:"";position:absolute;inset:0;pointer-events:none;z-index:6;border-radius:inherit;background-image:radial-gradient(2px 2px at 16% 22%,#fff,transparent 60%),radial-gradient(2px 2px at 84% 24%,#fff6c0,transparent 60%),radial-gradient(2px 2px at 30% 82%,#fff,transparent 60%),radial-gradient(2px 2px at 72% 78%,#fff,transparent 60%),radial-gradient(2.5px 2.5px at 50% 10%,#fff,transparent 60%);animation:pc-twinkle 1.5s ease-in-out infinite;}',

      // 20 PLATIN-DIAMANT — der edelste Rahmen (höchste Stufe, Richtung 99999).
      // Schimmerndes Platin (fließender Metall-Verlauf) + wandernder Sheen (::before)
      // + funkelnde Diamant-Facetten (::after). Deutlich aufwendiger als alle anderen.
      '.pc-frame-platinum{border:4px solid transparent;background-image:linear-gradient(rgba(9,32,21,.92),rgba(9,32,21,.92)),linear-gradient(120deg,#6e7885,#c7d2de,#ffffff,#9aa6b2,#eef3f9,#b9c4d0,#6e7885);box-shadow:0 0 30px rgba(220,235,255,.6),0 0 60px rgba(180,210,255,.25),inset 0 0 18px rgba(210,225,255,.28);animation:pc-flow 5s linear infinite;overflow:hidden;}',
      '.pc-frame-platinum::before{content:"";position:absolute;top:0;left:-70%;width:55%;height:100%;pointer-events:none;z-index:5;background:linear-gradient(115deg,transparent 0%,rgba(255,255,255,.15) 35%,rgba(255,255,255,.9) 50%,rgba(255,255,255,.15) 65%,transparent 100%);transform:skewX(-18deg);animation:pc-sheen 3.4s ease-in-out infinite;}',
      '.pc-frame-platinum::after{content:"";position:absolute;inset:0;pointer-events:none;z-index:6;border-radius:inherit;background-image:radial-gradient(2.5px 2.5px at 10% 18%,#fff,transparent 60%),radial-gradient(2px 2px at 90% 24%,#d8ecff,transparent 60%),radial-gradient(2.5px 2.5px at 16% 84%,#fff,transparent 60%),radial-gradient(2px 2px at 84% 80%,#eaf4ff,transparent 60%),radial-gradient(3px 3px at 50% 8%,#fff,transparent 60%),radial-gradient(2px 2px at 72% 54%,#fff,transparent 60%),radial-gradient(2px 2px at 30% 46%,#d8ecff,transparent 60%);animation:pc-diamond 1.9s ease-in-out infinite;}'
    ].join(''));
  }

  App.ProfileCard = {
    renderCard: renderCard,
    renderCardFor: renderCardFor,   // Karte für einen fremden Spieler (Daten aus dem Register)
    renderRow: renderRow,           // Bestenlisten-Zeile im Profilkarten-Look
    gamesEl: gamesEl,               // Liste der gespielten Spiele
    snapshot: snapshot,             // kompakter Stand für den Präsenz-Heartbeat
    renderCustomizer: renderCustomizer,
    styleName: styleName,           // Namensfarbe + Schriftart auf ein Element anwenden (auch app.js/chat.js)
    myNameCos: function () { return { nameColor: sel.nameColor, nameFont: sel.nameFont }; }
  };
})();
