/* settings.js — Einstellungen: Farb-Themes ("Styles") + Optionen  (App.Settings)
 *
 * Themes überschreiben die CSS-Variablen aus style.css (Akzente, Hintergrund, Glow)
 * live auf :root, plus ein injiziertes <style> für den Body-Hintergrund. Auswahl in
 * localStorage. Wird so früh wie möglich angewandt.
 */
(function () {
  'use strict';
  window.App = window.App || {};
  var UI = App.UI, el = UI.el;
  var KEY = 'gj_theme', KEY_RM = 'gj_reduce_motion';

  function hexRgb(hex) {
    hex = hex.replace('#', '');
    if (hex.length === 3) hex = hex.split('').map(function (c) { return c + c; }).join('');
    return [parseInt(hex.substr(0, 2), 16), parseInt(hex.substr(2, 2), 16), parseInt(hex.substr(4, 2), 16)];
  }
  function rgba(hex, a) { var c = hexRgb(hex); return 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + a + ')'; }

  // Jedes Theme: Akzent (a), Zweitakzent (a2), Blatt/hell (leaf), gold, Text, muted,
  // Hintergrund-Basis (bg,bg2) + 3 radiale Glow-Farben (r1,r2,r3).
  var THEMES = [
    { id: 'jungle', name: 'Neon-Dschungel', emoji: '🌿', a: '#39ff14', a2: '#33e6d0', leaf: '#9dff7a', gold: '#ffd23f', text: '#dcf7e7', muted: '#7ba692', bg: '#04100a', bg2: '#071c11', r1: '#0d3a22', r2: '#06281c', r3: '#0a2e1e' },
    { id: 'cyberpink', name: 'Cyber-Pink', emoji: '💖', a: '#ff2fb9', a2: '#22d3ff', leaf: '#ff9de0', gold: '#ffd23f', text: '#ffe3f6', muted: '#b58aa8', bg: '#12030c', bg2: '#1a0714', r1: '#3a0d2a', r2: '#2a0620', r3: '#1a0a2e' },
    { id: 'ocean', name: 'Ozean', emoji: '🌊', a: '#22a7ff', a2: '#22e0c8', leaf: '#8fd8ff', gold: '#ffd23f', text: '#dcefff', muted: '#7ba0b6', bg: '#04101a', bg2: '#07182a', r1: '#0d2a3a', r2: '#062028', r3: '#0a1e2e' },
    { id: 'sunset', name: 'Sonnenuntergang', emoji: '🌅', a: '#ff7a3c', a2: '#ff3d6d', leaf: '#ffb27a', gold: '#ffd23f', text: '#ffe9dc', muted: '#b6947b', bg: '#1a0a04', bg2: '#2a1207', r1: '#3a1f0d', r2: '#2a1206', r3: '#2e1a0a' },
    { id: 'royal', name: 'Royal-Lila', emoji: '👑', a: '#a855f7', a2: '#f0a5ff', leaf: '#c79dff', gold: '#ffd23f', text: '#efe3ff', muted: '#a08ab6', bg: '#0e0418', bg2: '#160726', r1: '#2a0d3a', r2: '#200628', r3: '#1e0a2e' },
    { id: 'ice', name: 'Eis', emoji: '❄️', a: '#7fdcff', a2: '#b6f0ff', leaf: '#cfeeff', gold: '#eaf6ff', text: '#eaf8ff', muted: '#8ea6b6', bg: '#04121a', bg2: '#08202a', r1: '#12384a', r2: '#0a2836', r3: '#0e2e3a' },
    { id: 'bloodmoon', name: 'Blutmond', emoji: '🌑', a: '#ff2d55', a2: '#ff7a3c', leaf: '#ff8ea0', gold: '#ffd23f', text: '#ffe0e4', muted: '#b68a90', bg: '#14040a', bg2: '#1e0710', r1: '#3a0d18', r2: '#2a0610', r3: '#2e0a14' },
    { id: 'matrix', name: 'Matrix', emoji: '🟩', a: '#00ff66', a2: '#00cc44', leaf: '#66ff99', gold: '#aaffaa', text: '#ccffdd', muted: '#5f9f72', bg: '#000a02', bg2: '#001406', r1: '#002a10', r2: '#001a0a', r3: '#002010' },
    { id: 'gold', name: 'Gold-Rausch', emoji: '🪙', a: '#ffcf33', a2: '#ff9d3c', leaf: '#ffe08a', gold: '#fff0a0', text: '#fff4d6', muted: '#b6a678', bg: '#140f04', bg2: '#1e1607', r1: '#3a2d0d', r2: '#2a1f06', r3: '#2e260a' },
    { id: 'candy', name: 'Candy', emoji: '🍬', a: '#ff6ac1', a2: '#7c83ff', leaf: '#ffb3e0', gold: '#ffe066', text: '#ffe9f6', muted: '#b591aa', bg: '#170618', bg2: '#210a26', r1: '#3a1440', r2: '#2a0e30', r3: '#2e123a' }
  ];
  function byId(id) { for (var i = 0; i < THEMES.length; i++) if (THEMES[i].id === id) return THEMES[i]; return THEMES[0]; }

  var current = 'jungle';
  try { current = (App.Storage ? App.Storage.get(KEY, null) : localStorage.getItem(KEY)) || 'jungle'; } catch (e) {}
  var reduceMotion = false;
  try { reduceMotion = App.Storage ? App.Storage.get(KEY_RM, false) : (localStorage.getItem(KEY_RM) === '1'); } catch (e) {}

  var listeners = [];
  function onChange(cb) { listeners.push(cb); return function () { var i = listeners.indexOf(cb); if (i >= 0) listeners.splice(i, 1); }; }
  function emit() { for (var i = 0; i < listeners.length; i++) { try { listeners[i](current); } catch (e) {} } }

  function apply(id, persist) {
    var t = byId(id); current = t.id;
    var r = document.documentElement.style;
    r.setProperty('--neon', t.a);
    r.setProperty('--neon-soft', t.leaf);
    r.setProperty('--leaf', t.leaf);
    r.setProperty('--aqua', t.a2);
    r.setProperty('--aqua-soft', t.leaf);
    r.setProperty('--gold', t.gold);
    r.setProperty('--text', t.text);
    r.setProperty('--muted', t.muted);
    r.setProperty('--bg', t.bg);
    r.setProperty('--bg-2', t.bg2);
    r.setProperty('--bg-3', t.bg2);
    r.setProperty('--stroke', rgba(t.a, 0.22));
    r.setProperty('--stroke-2', rgba(t.a, 0.4));
    r.setProperty('--panel', rgba(t.bg2, 0.55));
    r.setProperty('--glow', '0 0 18px ' + rgba(t.a, 0.45));
    r.setProperty('--glow-soft', '0 0 10px ' + rgba(t.a, 0.28));
    document.documentElement.setAttribute('data-theme', t.id);

    // Body-Hintergrund (in style.css hartkodiert) themen-gerecht überschreiben.
    var css =
      'body{background:' +
      'radial-gradient(1200px 700px at 15% -10%,' + t.r1 + ' 0%,transparent 55%),' +
      'radial-gradient(1000px 800px at 110% 10%,' + t.r2 + ' 0%,transparent 50%),' +
      'radial-gradient(900px 900px at 50% 120%,' + t.r3 + ' 0%,transparent 55%),' +
      'linear-gradient(160deg,' + t.bg + ' 0%,' + t.bg2 + ' 60%,' + t.bg + ' 100%) !important;background-attachment:fixed;}' +
      '.tile-glow{background:radial-gradient(circle,' + rgba(t.a, 0.18) + ',transparent 70%) !important;}' +
      '.game-stage{border-color:' + rgba(t.a, 0.22) + ' !important;}';
    var st = document.getElementById('gj-theme-style');
    if (!st) { st = document.createElement('style'); st.id = 'gj-theme-style'; document.head.appendChild(st); }
    st.textContent = css;

    if (persist !== false) { try { App.Storage ? App.Storage.set(KEY, t.id) : localStorage.setItem(KEY, t.id); } catch (e) {} }
    emit();
  }

  function setReduceMotion(v) {
    reduceMotion = !!v;
    document.documentElement.classList.toggle('reduce-motion', reduceMotion);
    try { App.Storage ? App.Storage.set(KEY_RM, reduceMotion) : localStorage.setItem(KEY_RM, reduceMotion ? '1' : '0'); } catch (e) {}
  }

  function injectCss() {
    UI.injectStyle('settings-css', [
      '.reduce-motion *{animation-duration:.001s !important;animation-iteration-count:1 !important;transition-duration:.05s !important;}',
      '.set-page{display:flex;flex-direction:column;gap:18px;max-width:760px;margin:0 auto;}',
      '.set-sec-h{margin:6px 0 -2px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;font-size:13px;font-weight:800;}',
      '.theme-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px;}',
      '.theme-card{position:relative;cursor:pointer;border-radius:16px;padding:14px;border:1px solid var(--stroke);background:rgba(9,32,21,.5);text-align:left;overflow:hidden;transition:.15s;color:var(--text);}',
      '.theme-card:hover{transform:translateY(-2px);border-color:var(--neon);}',
      '.theme-card.active{border-color:var(--neon);box-shadow:0 0 0 2px var(--neon),0 0 18px var(--stroke-2);}',
      '.theme-swatch{display:flex;gap:6px;margin-bottom:10px;}',
      '.theme-dot{width:22px;height:22px;border-radius:50%;box-shadow:0 0 8px rgba(0,0,0,.4);}',
      '.theme-preview{height:38px;border-radius:10px;margin-bottom:10px;}',
      '.theme-name{font-weight:900;display:flex;align-items:center;gap:6px;}',
      '.theme-tag{position:absolute;top:8px;right:10px;font-size:11px;font-weight:800;color:var(--neon);}',
      '.set-toggle{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:14px 16px;border-radius:14px;border:1px solid var(--stroke);background:rgba(9,32,21,.5);}',
      '.set-toggle .st-l{font-weight:800;}',
      '.set-toggle .st-d{font-size:12px;color:var(--muted);}',
      '.switch{position:relative;width:52px;height:30px;flex:0 0 auto;border-radius:99px;background:rgba(255,255,255,.14);border:1px solid var(--stroke);cursor:pointer;transition:.15s;}',
      '.switch.on{background:linear-gradient(90deg,var(--aqua),var(--neon));border-color:var(--neon);}',
      '.switch .knob{position:absolute;top:3px;left:3px;width:22px;height:22px;border-radius:50%;background:#fff;transition:.18s;}',
      '.switch.on .knob{left:27px;}'
    ].join(''));
  }

  function themePreviewBg(t) {
    return 'linear-gradient(135deg,' + t.bg2 + ',' + t.bg + ')';
  }
  function renderPage(root) {
    injectCss();
    var grid = el('div', { class: 'theme-grid' }, THEMES.map(function (t) {
      var card = el('button', {
        class: 'theme-card' + (t.id === current ? ' active' : ''), type: 'button',
        onclick: function () { apply(t.id); if (App.Audio) App.Audio.sfx('select'); rerender(); }
      }, [
        t.id === current ? el('span', { class: 'theme-tag' }, ['✓ aktiv']) : null,
        el('div', { class: 'theme-preview', style: 'background:' + themePreviewBg(t) + ';box-shadow:inset 0 0 24px ' + rgba(t.a, 0.4) }),
        el('div', { class: 'theme-swatch' }, [
          el('span', { class: 'theme-dot', style: 'background:' + t.a }),
          el('span', { class: 'theme-dot', style: 'background:' + t.a2 }),
          el('span', { class: 'theme-dot', style: 'background:' + t.gold }),
          el('span', { class: 'theme-dot', style: 'background:' + t.leaf })
        ]),
        el('div', { class: 'theme-name' }, [t.emoji + ' ' + t.name])
      ]);
      return card;
    }));

    var rmSwitch = el('div', { class: 'switch' + (reduceMotion ? ' on' : ''), onclick: function () { setReduceMotion(!reduceMotion); this.classList.toggle('on', reduceMotion); } }, [el('span', { class: 'knob' })]);
    var soundOn = !(App.Audio && App.Audio.isMuted && App.Audio.isMuted());
    var sndSwitch = el('div', { class: 'switch' + (soundOn ? ' on' : ''), onclick: function () { if (App.Audio) { App.Audio.start(); App.Audio.setMuted(!App.Audio.isMuted()); } this.classList.toggle('on', !(App.Audio && App.Audio.isMuted())); } }, [el('span', { class: 'knob' })]);

    var page = el('div', { class: 'set-page' }, [
      el('div', { class: 'page-head' }, [
        el('button', { class: 'btn btn-ghost back', type: 'button', onclick: function () { App.Router.go('/'); } }, ['← Menü']),
        el('h2', { class: 'page-title neon' }, ['⚙️ Einstellungen'])
      ]),
      el('div', { class: 'set-sec-h' }, ['Farb-Style']),
      grid,
      el('div', { class: 'set-sec-h' }, ['Optionen']),
      el('div', { class: 'set-toggle' }, [el('div', {}, [el('div', { class: 'st-l' }, ['🔊 Sound & Musik']), el('div', { class: 'st-d' }, ['Effekte + Menü-Musik'])]), sndSwitch]),
      el('div', { class: 'set-toggle' }, [el('div', {}, [el('div', { class: 'st-l' }, ['🎞️ Bewegung reduzieren']), el('div', { class: 'st-d' }, ['Weniger Animationen (schont schwache Geräte)'])]), rmSwitch])
    ]);
    root.innerHTML = ''; root.appendChild(page);
  }
  function rerender() {
    var host = document.getElementById('view');
    if (host && /\/settings/.test(location.hash)) renderPage(host);
  }

  function installNav() {
    var nav = document.querySelector('.topnav');
    if (!nav || nav.querySelector('.set-nav')) return;
    var a = el('a', { href: '#/settings', class: 'topnav-link set-nav', title: 'Einstellungen' }, ['⚙️']);
    nav.appendChild(a);
  }

  App.Settings = {
    apply: apply, current: function () { return current; }, themes: function () { return THEMES.slice(); },
    theme: function () { return byId(current); }, setReduceMotion: setReduceMotion, onChange: onChange, renderPage: renderPage
  };

  // Theme so früh wie möglich anwenden (kein Flackern), Nav wenn DOM bereit.
  apply(current, false);
  if (reduceMotion) document.documentElement.classList.add('reduce-motion');
  function boot() { apply(current, false); installNav(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
