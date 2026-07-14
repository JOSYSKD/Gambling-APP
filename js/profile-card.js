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

  /* ---------------- Kosmetik-Kataloge (unlock = benötigtes Level) ---------------- */
  var AVATARS = [
    { id: 'monkey', e: '🐵', lv: 1 }, { id: 'parrot', e: '🦜', lv: 1 }, { id: 'clover', e: '🍀', lv: 1 }, { id: 'slot', e: '🎰', lv: 1 },
    { id: 'frog', e: '🐸', lv: 2 }, { id: 'gecko', e: '🦎', lv: 3 }, { id: 'tiger', e: '🐯', lv: 4 },
    { id: 'lion', e: '🦁', lv: 5 }, { id: 'snake', e: '🐍', lv: 6 }, { id: 'unicorn', e: '🦄', lv: 7 },
    { id: 'dragon', e: '🐉', lv: 8 }, { id: 'fire', e: '🔥', lv: 9 }, { id: 'crown', e: '👑', lv: 10 },
    { id: 'gem', e: '💎', lv: 11 }, { id: 'robot', e: '🤖', lv: 12 }, { id: 'alien', e: '👽', lv: 14 }, { id: 'goat', e: '🐐', lv: 16 }
  ];
  var FRAMES = [
    { id: 'default', name: 'Standard', lv: 1 }, { id: 'neon', name: 'Neon', lv: 2 },
    { id: 'aqua', name: 'Aqua', lv: 3 }, { id: 'double', name: 'Doppellinie', lv: 4 },
    { id: 'gold', name: 'Gold', lv: 5 }, { id: 'grad', name: 'Verlauf', lv: 6 },
    { id: 'ice', name: 'Eis', lv: 7 }, { id: 'rainbow', name: 'Regenbogen', lv: 8 },
    { id: 'fire', name: 'Feuer', lv: 10 }, { id: 'royal', name: 'Königlich', lv: 12 }
  ];
  var BANNERS = [
    { id: 'jungle', name: 'Dschungel', lv: 1, css: 'linear-gradient(135deg,#0d3a22,#061a10)' },
    { id: 'aqua', name: 'Lagune', lv: 2, css: 'linear-gradient(135deg,#0d2a3a,#062028)' },
    { id: 'sunset', name: 'Sonnenuntergang', lv: 4, css: 'linear-gradient(135deg,#ff7a3c,#ff3d6d)' },
    { id: 'purple', name: 'Amethyst', lv: 6, css: 'linear-gradient(135deg,#a855f7,#6d28d9)' },
    { id: 'gold', name: 'Goldbarren', lv: 8, css: 'linear-gradient(135deg,#ffd23f,#e08a3c)' },
    { id: 'fire', name: 'Lava', lv: 10, css: 'linear-gradient(135deg,#ff2d55,#ff7a3c)' },
    { id: 'galaxy', name: 'Galaxie', lv: 12, css: 'linear-gradient(135deg,#22d3ff,#a855f7,#ff2fb9)' },
    { id: 'rainbow', name: 'Regenbogen', lv: 15, css: 'linear-gradient(90deg,#ff2d55,#ff9d3c,#ffd23f,#39ff14,#22d3ff,#a855f7)' }
  ];
  var TITLES = [
    { id: 'auto', name: 'Level-Titel (automatisch)', lv: 1 },
    { id: 'rookie', name: 'Frischling', lv: 1 }, { id: 'lucky', name: 'Glückspilz', lv: 3 },
    { id: 'shark', name: 'Kartenhai', lv: 5 }, { id: 'highroller', name: 'High Roller', lv: 7 },
    { id: 'boss', name: 'Dschungel-Boss', lv: 9 }, { id: 'legend', name: 'Neon-Legende', lv: 12 },
    { id: 'god', name: 'Glücks-Gott', lv: 15 }
  ];

  function firstOf(arr) { return arr[0].id; }
  var DEFAULT = { avatar: 'parrot', frame: 'default', banner: 'jungle', title: 'auto' };
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

  /* ---------------- Anzeige-Karte ---------------- */
  function renderCard() {
    injectCss();
    var av = chosen(AVATARS, sel.avatar), fr = chosen(FRAMES, sel.frame), bn = chosen(BANNERS, sel.banner);
    var name = (App.Leaderboard && App.Leaderboard.getPlayerName && App.Leaderboard.getPlayerName()) || 'Spieler';
    var L = lvl();
    var xpNow = App.Progress ? App.Progress.xpInLevel() : 0, xpMax = App.Progress ? App.Progress.xpForLevel() : 100;
    var pct = Math.max(0, Math.min(100, Math.round(xpNow / xpMax * 100)));
    var s = App.Progress ? App.Progress.stats() : { wins: 0, rounds: 0, biggestWin: 0 };

    return el('div', { class: 'pc-card pc-frame-' + fr.id }, [
      el('div', { class: 'pc-banner', style: 'background:' + bn.css }),
      el('div', { class: 'pc-body' }, [
        el('div', { class: 'pc-top' }, [
          el('div', { class: 'pc-avatar' }, [av.e]),
          el('div', { class: 'pc-id' }, [
            el('div', { class: 'pc-name' }, [name]),
            el('div', { class: 'pc-title' }, ['⭐ ' + titleText()])
          ]),
          el('div', { class: 'pc-lvl' }, [el('span', { class: 'pc-lvl-n' }, [String(L)]), el('span', { class: 'pc-lvl-t' }, ['LEVEL'])])
        ]),
        el('div', { class: 'pc-xp' }, [el('div', { class: 'pc-xp-fill', style: 'width:' + pct + '%' })]),
        el('div', { class: 'pc-xp-l' }, [xpNow + ' / ' + xpMax + ' XP']),
        el('div', { class: 'pc-stats' }, [
          pcStat('🏆', UI.formatCoins(s.wins), 'Siege'),
          pcStat('🎲', UI.formatCoins(s.rounds), 'Runden'),
          pcStat('💥', UI.formatCoins(s.biggestWin), 'Top-Gewinn'),
          pcStat('🪙', UI.formatCoins(App.Coins ? App.Coins.getPeak() : 0), 'Peak')
        ])
      ])
    ]);
  }
  function pcStat(ic, v, l) {
    return el('div', { class: 'pc-stat' }, [el('div', { class: 'pc-stat-ic' }, [ic]), el('div', { class: 'pc-stat-v' }, [v]), el('div', { class: 'pc-stat-l' }, [l])]);
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
      if (!unlocked(item)) { UI.toast('Schaltet auf Level ' + item.lv + ' frei', 'info'); if (App.Audio) App.Audio.sfx('error'); return; }
      sel[kind] = id; save(); if (App.Audio) App.Audio.sfx('select');
      drawBody(); if (onChange) onChange();
    }
    function lockTag(item) { return unlocked(item) ? null : el('span', { class: 'pc-lock' }, ['🔒 Lv ' + item.lv]); }

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
      '.pc-card{position:relative;border-radius:20px;overflow:hidden;border:2px solid var(--stroke);background:rgba(9,32,21,.55);margin-bottom:16px;}',
      '.pc-banner{height:88px;}',
      '.pc-body{padding:0 18px 16px;}',
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
      '.pc-titleopt.locked{opacity:.55;}'
    ].join(''));
  }

  App.ProfileCard = { renderCard: renderCard, renderCustomizer: renderCustomizer };
})();
