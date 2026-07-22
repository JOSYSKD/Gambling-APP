/* settings.js — Einstellungen: Farb-Themes ("Styles") + Stil/Hintergrund + Optionen  (App.Settings)
 *
 * Themes überschreiben die CSS-Variablen aus style.css (Akzente, Hintergrund, Glow)
 * live auf :root, plus ein injiziertes <style> für den Body-Hintergrund. Auswahl in
 * localStorage. Wird so früh wie möglich angewandt.
 *
 * ZUSÄTZLICH (unabhängig von den Farbpaletten): ein STIL-/HINTERGRUND-Wähler mit 7
 * aufwändigen, rein per CSS/JS erzeugten Szenen (jungle/water/fire/stone/ice/storm/
 * galaxy). Das komplette Hintergrundsystem lebt hier: CSS wird per
 * App.UI.injectStyle('bgstyle-css', ...) injiziert, ein fixierter Container
 * <div id="bg-scene" class="bg-scene"> hinter dem Inhalt (z-index unter dem Content,
 * pointer-events:none) wird per JS befüllt, und am <body> hängt eine Klasse
 * bgstyle-<id>. index.html/style.css bleiben unangetastet.
 */
(function () {
  'use strict';
  window.App = window.App || {};
  var UI = App.UI, el = UI.el;
  var KEY = 'gj_theme', KEY_RM = 'gj_reduce_motion', KEY_BG = 'gj_bgstyle';
  var KEY_BG_IMG = 'gj_bg_image';   // selbst hochgeladenes Hintergrundbild (Data-URL, nur lokal)
  // Schnelles-Weiterspielen-Optionen (siehe app.js Game-Over + ui.js createBetPanel):
  var KEY_AUTORESTART = 'gj_auto_restart';   // kein Game-Over-Overlay, sofort Einstiegsgeld
  var KEY_AUTOMAX = 'gj_auto_maxbet';        // Einsatz automatisch auf Max vorwählen

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

  // ==========================================================================
  //  STIL / HINTERGRUND — 7 aufwändige Szenen (unabhängig von den Farb-Themes)
  // ==========================================================================
  var BG_STYLES = [
    { id: 'jungle', name: 'Dschungel', emoji: '🌿', desc: 'Ranken, Blätter & Glühwürmchen' },
    { id: 'water',  name: 'Wasser',    emoji: '🌊', desc: 'Kaustik-Licht & Blasen' },
    { id: 'fire',   name: 'Feuer',     emoji: '🔥', desc: 'Glut, Funken & Rauch' },
    { id: 'stone',  name: 'Stein',     emoji: '🪨', desc: 'Höhle, Adern & Staub' },
    { id: 'ice',    name: 'Eis',       emoji: '❄️', desc: 'Frost, Schnee & Glitzer' },
    { id: 'storm',  name: 'Gewitter',  emoji: '⛈️', desc: 'Wolken, Blitze & Regen' },
    { id: 'galaxy', name: 'Galaxie',   emoji: '🌌', desc: 'Sterne, Nebel & Parallax' }
  ];
  function byBgId(id) { for (var i = 0; i < BG_STYLES.length; i++) if (BG_STYLES[i].id === id) return BG_STYLES[i]; return BG_STYLES[0]; }

  var current = 'jungle';
  try { current = (App.Storage ? App.Storage.get(KEY, null) : localStorage.getItem(KEY)) || 'jungle'; } catch (e) {}
  var reduceMotion = false;
  try { reduceMotion = App.Storage ? App.Storage.get(KEY_RM, false) : (localStorage.getItem(KEY_RM) === '1'); } catch (e) {}
  var currentBg = 'jungle';
  try { currentBg = (App.Storage ? App.Storage.get(KEY_BG, null) : localStorage.getItem(KEY_BG)) || 'jungle'; } catch (e) {}
  var customImg = null;   // Data-URL des eigenen Hintergrundbilds (falls hochgeladen)
  try { customImg = (App.Storage ? App.Storage.get(KEY_BG_IMG, null) : localStorage.getItem(KEY_BG_IMG)) || null; } catch (e) {}
  var autoRestart = false;
  try { autoRestart = App.Storage ? App.Storage.get(KEY_AUTORESTART, false) : (localStorage.getItem(KEY_AUTORESTART) === '1'); } catch (e) {}
  var autoMax = false;
  try { autoMax = App.Storage ? App.Storage.get(KEY_AUTOMAX, false) : (localStorage.getItem(KEY_AUTOMAX) === '1'); } catch (e) {}

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

  function setAutoRestart(v) {
    autoRestart = !!v;
    try { App.Storage ? App.Storage.set(KEY_AUTORESTART, autoRestart) : localStorage.setItem(KEY_AUTORESTART, autoRestart ? '1' : '0'); } catch (e) {}
  }
  function setAutoMax(v) {
    autoMax = !!v;
    try { App.Storage ? App.Storage.set(KEY_AUTOMAX, autoMax) : localStorage.setItem(KEY_AUTOMAX, autoMax ? '1' : '0'); } catch (e) {}
  }

  // ---------- Hintergrund-Bausteine (rein CSS/JS, keine externen Assets) ----------
  function rnd(a, b) { return a + Math.random() * (b - a); }
  function rndi(a, b) { return Math.floor(rnd(a, b + 1)); }
  // Weniger Partikel auf schmalen Geräten (Performance).
  function cnt(n) { var d = (window.innerWidth && window.innerWidth < 640) ? 0.55 : 1; return Math.max(1, Math.round(n * d)); }

  // box-shadow-„Sternenfeld": ein Punkt-Element, das per box-shadow N Kopien streut.
  function fieldShadow(n, w, h, colors) {
    var a = [];
    for (var i = 0; i < n; i++) {
      a.push(rndi(0, w) + 'px ' + rndi(0, h) + 'px ' + colors[i % colors.length]);
    }
    return a.join(',');
  }
  function L(cls) { return el('div', { class: 'full ' + cls }); }
  function F(n, colors, size, cls) {
    return el('div', { class: 'field ' + cls, style: 'width:' + size + 'px;height:' + size + 'px;box-shadow:' + fieldShadow(cnt(n), 1920, 1160, colors) + ';' });
  }
  // Aufsteigende/fallende Partikel (Blasen, Funken, Schnee, Blätter, Rauch, Regen).
  function particles(n, cls, o) {
    var arr = [];
    n = cnt(n);
    for (var i = 0; i < n; i++) {
      var size = rnd(o.min, o.max);
      var dur = rnd(o.durMin, o.durMax);
      var delay = -(Math.random() * dur);
      var dx = (Math.random() * 2 - 1) * (o.dx || 20);
      var s = 'left:' + rnd(0, 100).toFixed(2) + '%;width:' + size.toFixed(1) + 'px;height:' + size.toFixed(1) + 'px;' +
        'animation-duration:' + dur.toFixed(2) + 's;animation-delay:' + delay.toFixed(2) + 's;--dx:' + dx.toFixed(1) + 'px;';
      if (o.extra) s += o.extra(size, i);
      arr.push(el('span', { class: cls, style: s }));
    }
    return arr;
  }
  function svgUrl(svg) { return 'background-image:url("data:image/svg+xml,' + encodeURIComponent(svg) + '");'; }

  function vineSvg(stroke, leaf) {
    var pts = [[80, 120, 40], [120, 80, -50], [110, 160, 25], [160, 110, -65], [50, 60, 45], [95, 200, 20], [200, 95, -70], [60, 150, 35], [150, 60, -40], [130, 130, 10], [40, 100, 55], [100, 40, -35]];
    var leaves = '';
    for (var i = 0; i < pts.length; i++) { var p = pts[i]; leaves += "<ellipse cx='" + p[0] + "' cy='" + p[1] + "' rx='16' ry='8' transform='rotate(" + p[2] + " " + p[0] + " " + p[1] + ")'/>"; }
    return "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 260 260'>" +
      "<g fill='none' stroke='" + stroke + "' stroke-width='3' stroke-linecap='round' opacity='0.9'>" +
      "<path d='M-10 20 Q70 40 80 120 T150 250'/><path d='M20 -10 Q40 70 120 80 T250 150'/>" +
      "<path d='M-10 60 Q90 70 110 160 T170 260'/><path d='M60 -10 Q70 90 160 110 T260 170'/></g>" +
      "<g fill='" + leaf + "' opacity='0.9'>" + leaves + "</g></svg>";
  }
  function frostSvg(c) {
    var b = "<path d='M0 0 L120 120'/>";
    for (var i = 1; i <= 7; i++) { var t = i * 16; b += "<path d='M" + t + " " + t + " l14 -6'/><path d='M" + t + " " + t + " l-6 14'/>"; }
    b += "<path d='M0 40 L90 130'/><path d='M40 0 L130 90'/>";
    for (var j = 1; j <= 5; j++) { var u = j * 16; b += "<path d='M" + u + " " + (u + 40) + " l10 -4'/><path d='M" + (u + 40) + " " + u + " l-4 10'/>"; }
    return "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 160 160'><g fill='none' stroke='" + c + "' stroke-width='2' stroke-linecap='round' opacity='0.85'>" + b + "</g></svg>";
  }
  function veinSvg(c) {
    return "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 300 300'><g fill='none' stroke='" + c + "' stroke-width='1.5' opacity='0.8'>" +
      "<path d='M20 0 L60 90 L40 160 L90 250 L70 300'/><path d='M60 90 L120 120'/><path d='M40 160 L110 180'/><path d='M90 250 L150 240'/>" +
      "<path d='M300 40 L230 110 L250 190 L200 260'/><path d='M230 110 L170 140'/><path d='M250 190 L190 210'/><path d='M150 0 L160 70 L140 130'/>" +
      "</g></svg>";
  }
  function boltSvg() {
    return "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 200'><polyline points='55,0 40,80 60,80 30,200 50,95 32,95' fill='none' stroke='#eaf0ff' stroke-width='4' stroke-linejoin='round' opacity='0.95'/></svg>";
  }
  function vine(pos, flip, svg) {
    return el('div', { class: 'jgl-vine ' + pos, style: flip ? ('transform:' + flip + ';') : null }, [
      el('div', { class: 'jgl-vine-in', style: svgUrl(svg) })
    ]);
  }
  function frost(pos, svg) { return el('div', { class: 'ice-frost ' + pos, style: svgUrl(svg) }); }
  function rainDrops(n) {
    var arr = [];
    n = cnt(n);
    for (var i = 0; i < n; i++) {
      var dur = rnd(0.5, 1.1);
      var s = 'left:' + rnd(0, 100).toFixed(2) + '%;width:' + rnd(1, 2).toFixed(1) + 'px;height:' + rndi(30, 70) + 'px;' +
        'animation-duration:' + dur.toFixed(2) + 's;animation-delay:' + (-Math.random() * dur).toFixed(2) + 's;--dx:' + rndi(20, 60) + 'px;';
      arr.push(el('span', { class: 'p streak fall', style: s }));
    }
    return arr;
  }

  var SCENES = {
    jungle: function () {
      return [
        L('jgl-sky'), L('jgl-canopy'), L('jgl-rays'), L('jgl-fog'),
        vine('tl', '', vineSvg('#39ff14', '#9dff7a')),
        vine('tr', 'scaleX(-1)', vineSvg('#33e6d0', '#7ff3e6')),
        vine('bl', 'scaleY(-1)', vineSvg('#33e6d0', '#7ff3e6')),
        vine('br', 'scale(-1)', vineSvg('#39ff14', '#9dff7a')),
        F(70, ['rgba(157,255,122,.9)', 'rgba(57,255,20,.85)', 'rgba(127,243,230,.8)'], 2, 'jgl-flies'),
        F(40, ['rgba(157,255,122,.7)', 'rgba(51,230,208,.6)'], 3, 'jgl-flies2')
      ].concat(particles(14, 'p leaf', { min: 8, max: 18, durMin: 16, durMax: 30, dx: 70 }));
    },
    water: function () {
      return [
        L('wtr-deep'), L('wtr-caustic'), L('wtr-caustic2'), L('wtr-rays'),
        el('div', { class: 'wtr-surface' })
      ].concat(particles(26, 'p bub', { min: 4, max: 16, durMin: 7, durMax: 16, dx: 30 }));
    },
    fire: function () {
      return [L('fire-base'), L('fire-glow'), L('fire-flick')]
        .concat(particles(9, 'p smoke', { min: 60, max: 150, durMin: 9, durMax: 16, dx: 40 }))
        .concat(particles(34, 'p ember', { min: 2, max: 6, durMin: 3, durMax: 8, dx: 40 }));
    },
    stone: function () {
      return [
        L('stn-base'), L('stn-mottle'),
        el('div', { class: 'stn-vein', style: svgUrl(veinSvg('#7fe3ff')) }),
        L('stn-light'),
        F(60, ['rgba(200,190,170,.5)', 'rgba(170,160,140,.4)'], 2, 'stn-dust')
      ].concat(particles(16, 'p dust', { min: 2, max: 5, durMin: 18, durMax: 34, dx: 30 }));
    },
    ice: function () {
      return [
        L('ice-base'), L('ice-shimmer'),
        frost('tl', frostSvg('#bfe9ff')), frost('tr', frostSvg('#dff4ff')),
        frost('bl', frostSvg('#dff4ff')), frost('br', frostSvg('#bfe9ff')),
        F(80, ['rgba(210,240,255,.9)', 'rgba(255,255,255,.85)', 'rgba(150,220,255,.7)'], 2, 'ice-glint')
      ].concat(particles(34, 'p flake fall', { min: 3, max: 8, durMin: 7, durMax: 15, dx: 40 }));
    },
    storm: function () {
      return [
        L('stm-base'), L('stm-cloud'), L('stm-cloud2'), L('stm-flash'),
        el('div', { class: 'stm-bolt', style: svgUrl(boltSvg()) })
      ].concat(rainDrops(60));
    },
    galaxy: function () {
      return [
        L('gal-base'), L('gal-neb'), L('gal-neb2'),
        F(120, ['rgba(255,255,255,.9)', 'rgba(180,200,255,.8)', 'rgba(255,180,230,.7)', 'rgba(160,255,240,.7)'], 1.5, 'gal-far'),
        F(70, ['rgba(255,255,255,.95)', 'rgba(190,210,255,.85)'], 2, 'gal-mid'),
        F(30, ['rgba(255,255,255,1)', 'rgba(255,190,235,.9)', 'rgba(160,255,245,.9)'], 3, 'gal-near')
      ];
    }
  };

  function bgKeyframes() {
    return [
      '@keyframes bgk-rise{from{transform:translateY(0)}to{transform:translateY(-118vh)}}',
      '@keyframes bgk-bub{0%{transform:translateY(0) translateX(0);opacity:0}10%{opacity:.85}90%{opacity:.7}100%{transform:translateY(-118vh) translateX(var(--dx,0));opacity:0}}',
      '@keyframes bgk-ember{0%{transform:translateY(0) translateX(0);opacity:0}12%{opacity:1}80%{opacity:.8}100%{transform:translateY(-118vh) translateX(var(--dx,0));opacity:0}}',
      '@keyframes bgk-smoke{0%{transform:translateY(0) scale(.6);opacity:0}20%{opacity:.5}100%{transform:translateY(-110vh) scale(1.9);opacity:0}}',
      '@keyframes bgk-leaf{0%{transform:translateY(0) rotate(0);opacity:0}10%{opacity:.9}100%{transform:translateY(-118vh) rotate(360deg) translateX(var(--dx,0));opacity:0}}',
      '@keyframes bgk-flake{0%{transform:translateY(0) translateX(0)}50%{transform:translateY(59vh) translateX(var(--dx,12px))}100%{transform:translateY(118vh) translateX(0)}}',
      '@keyframes bgk-rainfall{from{transform:translateY(0) translateX(0)}to{transform:translateY(124vh) translateX(var(--dx,30px))}}',
      '@keyframes bgk-twinkle{0%,100%{opacity:.25}50%{opacity:1}}',
      '@keyframes bgk-twinkle2{0%,100%{opacity:1}50%{opacity:.35}}',
      '@keyframes bgk-driftx{from{transform:translate(0,0)}to{transform:translate(30px,-20px)}}',
      '@keyframes bgk-drifty{from{transform:translate(0,0)}to{transform:translate(-24px,18px)}}',
      '@keyframes bgk-sway{0%,100%{transform:rotate(-2deg)}50%{transform:rotate(2deg)}}',
      '@keyframes bgk-caustic{0%{transform:translate(-5%,-5%) scale(1)}50%{transform:translate(5%,5%) scale(1.15)}100%{transform:translate(-5%,-5%) scale(1)}}',
      '@keyframes bgk-flicker{0%,100%{opacity:.55}25%{opacity:.85}50%{opacity:.4}75%{opacity:.95}}',
      '@keyframes bgk-cloud{from{transform:translateX(-6%)}to{transform:translateX(6%)}}',
      '@keyframes bgk-nebula{0%,100%{opacity:.5;transform:scale(1)}50%{opacity:.85;transform:scale(1.1)}}',
      '@keyframes bgk-shimmer{0%,100%{opacity:.2}50%{opacity:.55}}',
      '@keyframes bgk-light{0%,92%,100%{opacity:0}93%{opacity:.9}94%{opacity:.15}95%{opacity:.85}96.5%{opacity:0}}'
    ].join('');
  }

  function bgCss() {
    var base = [
      '.bg-scene{position:fixed;inset:0;z-index:0;pointer-events:none;overflow:hidden;isolation:isolate;}',
      '.bg-scene>*{position:absolute;pointer-events:none;}',
      '.bg-scene .full{inset:0;}',
      '.bg-scene .field{top:0;left:0;border-radius:50%;background:transparent;will-change:transform,opacity;}',
      '.bg-scene .p{position:absolute;bottom:-6%;border-radius:50%;will-change:transform,opacity;animation-iteration-count:infinite;animation-timing-function:linear;}',
      '.bg-scene .p.fall{top:-6%;bottom:auto;}',
      // In JEDEM Stil ersetzt die neue Szene die alten Deko-Elemente aus index.html.
      'body[class*="bgstyle-"] .vines,body[class*="bgstyle-"] .fireflies{display:none !important;}',
      // Bewegung reduzieren: OS-Präferenz + App-Schalter (.reduce-motion am <html>).
      '@media (prefers-reduced-motion:reduce){.bg-scene *{animation:none !important;}.bg-scene .p{display:none;}}',
      '.reduce-motion .bg-scene *{animation:none !important;}',
      '.reduce-motion .bg-scene .p{display:none;}'
    ].join('');

    var jungle = [
      '.bgstyle-jungle .jgl-sky{background:radial-gradient(120% 90% at 50% -10%,rgba(20,80,40,.55),transparent 60%),linear-gradient(180deg,rgba(3,20,10,.2),rgba(2,12,7,.6));}',
      '.bgstyle-jungle .jgl-canopy{background:radial-gradient(60% 42% at 15% 0%,rgba(10,60,30,.7),transparent 70%),radial-gradient(60% 42% at 85% 0%,rgba(8,50,26,.7),transparent 70%);mix-blend-mode:screen;}',
      '.bgstyle-jungle .jgl-rays{background:repeating-linear-gradient(100deg,transparent 0 42px,rgba(157,255,122,.05) 42px 70px);mix-blend-mode:screen;transform-origin:50% 0;opacity:.7;animation:bgk-sway 16s ease-in-out infinite;}',
      '.bgstyle-jungle .jgl-fog{background:linear-gradient(0deg,rgba(4,18,10,.85),transparent 45%);}',
      '.jgl-vine{width:min(48vw,440px);height:min(48vw,440px);}',
      '.jgl-vine.tl{top:-2%;left:-2%;}.jgl-vine.tr{top:-2%;right:-2%;}.jgl-vine.bl{bottom:-2%;left:-2%;}.jgl-vine.br{bottom:-2%;right:-2%;}',
      '.jgl-vine-in{position:absolute;inset:0;background-repeat:no-repeat;background-size:contain;opacity:.6;}',
      '.jgl-vine.tl .jgl-vine-in{transform-origin:0 0;animation:bgk-sway 9s ease-in-out infinite;}',
      '.jgl-vine.tr .jgl-vine-in{transform-origin:100% 0;animation:bgk-sway 11s ease-in-out infinite reverse;}',
      '.jgl-vine.bl .jgl-vine-in{transform-origin:0 100%;animation:bgk-sway 12s ease-in-out infinite;}',
      '.jgl-vine.br .jgl-vine-in{transform-origin:100% 100%;animation:bgk-sway 10s ease-in-out infinite reverse;}',
      '.bgstyle-jungle .jgl-flies{animation:bgk-twinkle 3.5s ease-in-out infinite,bgk-driftx 26s ease-in-out infinite alternate;}',
      '.bgstyle-jungle .jgl-flies2{animation:bgk-twinkle2 5s ease-in-out infinite,bgk-drifty 34s ease-in-out infinite alternate;}',
      '.bgstyle-jungle .leaf{background:linear-gradient(135deg,rgba(120,220,90,.9),rgba(40,150,60,.7));border-radius:0 100% 0 100%;box-shadow:0 0 6px rgba(57,255,20,.4);animation-name:bgk-leaf;}'
    ].join('');

    var water = [
      '.bgstyle-water .wtr-deep{background:radial-gradient(120% 100% at 50% -20%,rgba(30,150,220,.5),transparent 55%),linear-gradient(180deg,rgba(8,60,100,.6) 0%,rgba(3,20,40,.85) 60%,rgba(1,8,20,.95) 100%);}',
      '.bgstyle-water .wtr-caustic{background:radial-gradient(40% 30% at 20% 20%,rgba(120,220,255,.16),transparent 60%),radial-gradient(35% 25% at 70% 40%,rgba(120,220,255,.14),transparent 60%),radial-gradient(30% 22% at 45% 70%,rgba(150,240,255,.14),transparent 60%),radial-gradient(30% 22% at 85% 75%,rgba(120,220,255,.12),transparent 60%);mix-blend-mode:screen;animation:bgk-caustic 18s ease-in-out infinite;}',
      '.bgstyle-water .wtr-caustic2{background:radial-gradient(45% 30% at 60% 15%,rgba(90,200,255,.12),transparent 60%),radial-gradient(30% 22% at 25% 55%,rgba(120,230,255,.12),transparent 60%),radial-gradient(35% 25% at 80% 60%,rgba(150,240,255,.1),transparent 60%);mix-blend-mode:screen;animation:bgk-caustic 26s ease-in-out infinite reverse;}',
      '.bgstyle-water .wtr-rays{background:repeating-linear-gradient(102deg,transparent 0 60px,rgba(150,235,255,.05) 60px 90px);mix-blend-mode:screen;opacity:.7;animation:bgk-cloud 20s ease-in-out infinite alternate;}',
      '.bgstyle-water .wtr-surface{top:0;left:0;right:0;height:22%;background:linear-gradient(180deg,rgba(120,220,255,.18),transparent);animation:bgk-shimmer 6s ease-in-out infinite;}',
      '.bgstyle-water .bub{background:radial-gradient(circle at 35% 30%,rgba(255,255,255,.55),rgba(150,220,255,.15) 60%,transparent 72%);border:1px solid rgba(190,235,255,.4);animation-name:bgk-bub;animation-timing-function:ease-in;}'
    ].join('');

    var fire = [
      '.bgstyle-fire .fire-base{background:radial-gradient(120% 80% at 50% 120%,rgba(255,120,20,.55),transparent 55%),linear-gradient(0deg,rgba(60,12,4,.9) 0%,rgba(30,8,6,.7) 45%,rgba(10,4,6,.4) 100%);}',
      '.bgstyle-fire .fire-glow{background:radial-gradient(80% 50% at 50% 108%,rgba(255,180,40,.55),rgba(255,90,20,.25) 40%,transparent 70%);mix-blend-mode:screen;animation:bgk-flicker 3s ease-in-out infinite;}',
      '.bgstyle-fire .fire-flick{background:radial-gradient(50% 40% at 30% 110%,rgba(255,140,30,.4),transparent 60%),radial-gradient(50% 40% at 72% 112%,rgba(255,90,20,.4),transparent 60%);mix-blend-mode:screen;animation:bgk-flicker 1.7s ease-in-out infinite reverse;}',
      '.bgstyle-fire .ember{background:radial-gradient(circle,rgba(255,230,150,1),rgba(255,120,20,.9) 55%,transparent 72%);box-shadow:0 0 6px rgba(255,140,30,.9);animation-name:bgk-ember;animation-timing-function:ease-out;}',
      '.bgstyle-fire .smoke{background:radial-gradient(circle,rgba(40,30,30,.5),transparent 70%);animation-name:bgk-smoke;animation-timing-function:ease-out;}'
    ].join('');

    var stone = [
      '.bgstyle-stone .stn-base{background:radial-gradient(120% 90% at 50% -10%,rgba(80,74,60,.5),transparent 55%),linear-gradient(160deg,rgba(28,26,22,.85),rgba(12,11,9,.95));}',
      '.bgstyle-stone .stn-mottle{background:radial-gradient(18% 14% at 20% 30%,rgba(90,84,70,.35),transparent 60%),radial-gradient(14% 12% at 65% 25%,rgba(70,66,56,.3),transparent 60%),radial-gradient(20% 16% at 40% 70%,rgba(80,74,62,.32),transparent 60%),radial-gradient(16% 12% at 82% 62%,rgba(60,56,48,.3),transparent 60%),radial-gradient(15% 12% at 12% 80%,rgba(74,70,58,.3),transparent 60%);}',
      '.bgstyle-stone .stn-vein{inset:0;background-repeat:no-repeat;background-size:cover;opacity:.55;filter:drop-shadow(0 0 5px rgba(90,200,230,.5));animation:bgk-shimmer 7s ease-in-out infinite;}',
      '.bgstyle-stone .stn-light{background:radial-gradient(45% 60% at 68% -5%,rgba(200,210,220,.14),transparent 55%);}',
      '.bgstyle-stone .stn-dust{animation:bgk-twinkle 6s ease-in-out infinite,bgk-drifty 40s ease-in-out infinite alternate;}',
      '.bgstyle-stone .dust{background:rgba(200,190,170,.5);opacity:.5;animation-name:bgk-rise;}'
    ].join('');

    var ice = [
      '.bgstyle-ice .ice-base{background:radial-gradient(120% 90% at 50% -10%,rgba(120,200,255,.4),transparent 55%),linear-gradient(160deg,rgba(12,44,66,.8),rgba(4,18,30,.92));}',
      '.bgstyle-ice .ice-shimmer{background:linear-gradient(115deg,transparent 30%,rgba(200,240,255,.1) 50%,transparent 70%);mix-blend-mode:screen;animation:bgk-cloud 12s ease-in-out infinite alternate;}',
      '.ice-frost{width:min(42vw,380px);height:min(42vw,380px);background-repeat:no-repeat;background-size:contain;opacity:.7;}',
      '.ice-frost.tl{top:-1%;left:-1%;}.ice-frost.tr{top:-1%;right:-1%;transform:scaleX(-1);}.ice-frost.bl{bottom:-1%;left:-1%;transform:scaleY(-1);}.ice-frost.br{bottom:-1%;right:-1%;transform:scale(-1);}',
      '.bgstyle-ice .ice-glint{animation:bgk-twinkle 2.6s ease-in-out infinite;}',
      '.bgstyle-ice .flake{background:radial-gradient(circle,rgba(255,255,255,.95),rgba(200,235,255,.5) 60%,transparent 72%);box-shadow:0 0 4px rgba(210,240,255,.7);animation-name:bgk-flake;}'
    ].join('');

    var storm = [
      '.bgstyle-storm .stm-base{background:radial-gradient(120% 90% at 50% -10%,rgba(60,66,84,.5),transparent 55%),linear-gradient(160deg,rgba(16,18,26,.9),rgba(4,5,10,.96));}',
      '.bgstyle-storm .stm-cloud{background:radial-gradient(50% 40% at 25% 15%,rgba(40,44,58,.9),transparent 60%),radial-gradient(45% 35% at 70% 10%,rgba(30,34,46,.85),transparent 60%),radial-gradient(55% 40% at 50% 0%,rgba(22,26,38,.9),transparent 65%);animation:bgk-cloud 26s ease-in-out infinite alternate;}',
      '.bgstyle-storm .stm-cloud2{background:radial-gradient(40% 30% at 15% 25%,rgba(48,52,66,.6),transparent 60%),radial-gradient(45% 32% at 80% 20%,rgba(36,40,54,.6),transparent 60%);opacity:.8;animation:bgk-cloud 38s ease-in-out infinite alternate-reverse;}',
      '.bgstyle-storm .stm-flash{background:radial-gradient(circle at 60% 22%,rgba(220,230,255,.9),rgba(180,200,255,.3) 30%,transparent 60%);mix-blend-mode:screen;opacity:0;animation:bgk-light 9s linear infinite;}',
      '.bgstyle-storm .stm-bolt{inset:0;background-repeat:no-repeat;background-position:60% 8%;background-size:auto 60%;opacity:0;animation:bgk-light 9s linear infinite;}',
      '.bgstyle-storm .streak{border-radius:2px;background:linear-gradient(180deg,transparent,rgba(180,200,235,.6));animation-name:bgk-rainfall;}'
    ].join('');

    var galaxy = [
      '.bgstyle-galaxy .gal-base{background:radial-gradient(120% 100% at 50% 20%,rgba(30,16,60,.5),transparent 60%),linear-gradient(160deg,rgba(10,6,26,.9),rgba(2,1,10,.98));}',
      '.bgstyle-galaxy .gal-neb{background:radial-gradient(40% 32% at 30% 40%,rgba(140,70,255,.35),transparent 60%),radial-gradient(35% 28% at 72% 62%,rgba(60,120,255,.3),transparent 60%);mix-blend-mode:screen;animation:bgk-nebula 22s ease-in-out infinite;}',
      '.bgstyle-galaxy .gal-neb2{background:radial-gradient(30% 24% at 60% 25%,rgba(255,90,200,.22),transparent 60%),radial-gradient(34% 26% at 20% 70%,rgba(80,220,220,.2),transparent 60%);mix-blend-mode:screen;animation:bgk-nebula 30s ease-in-out infinite reverse;}',
      '.bgstyle-galaxy .gal-far{animation:bgk-twinkle 5s ease-in-out infinite,bgk-drifty 60s linear infinite alternate;}',
      '.bgstyle-galaxy .gal-mid{animation:bgk-twinkle2 3.6s ease-in-out infinite,bgk-driftx 45s linear infinite alternate;}',
      '.bgstyle-galaxy .gal-near{animation:bgk-twinkle 2.4s ease-in-out infinite,bgk-driftx 32s linear infinite alternate;}'
    ].join('');

    return base + bgKeyframes() + jungle + water + fire + stone + ice + storm + galaxy;
  }

  function injectBgCss() { UI.injectStyle('bgstyle-css', bgCss()); }

  function ensureScene() {
    if (!document.body) return null;
    var s = document.getElementById('bg-scene');
    if (!s) { s = el('div', { id: 'bg-scene', class: 'bg-scene', 'aria-hidden': 'true' }); document.body.insertBefore(s, document.body.firstChild); }
    return s;
  }
  function buildScene(id) {
    var scene = ensureScene();
    if (!scene) return;
    while (scene.firstChild) scene.removeChild(scene.firstChild);
    var fn = SCENES[id] || SCENES.jungle;
    var kids = fn();
    for (var i = 0; i < kids.length; i++) if (kids[i]) scene.appendChild(kids[i]);
  }

  // ---------- Eigenes Hintergrundbild ----------
  // Das Bild lebt als Data-URL nur im localStorage (nicht in der Cloud). Es wird
  // per CSS-Regel auf `body.bgstyle-custom` gelegt; die höhere Spezifität (Klasse)
  // schlägt die Theme-Regel `body{background…}`, egal in welcher Reihenfolge.
  function injectBgImgCss(dataUrl) {
    var st = document.getElementById('gj-bgimg-style');
    if (!dataUrl) { if (st) st.textContent = ''; return; }
    if (!st) { st = document.createElement('style'); st.id = 'gj-bgimg-style'; document.head.appendChild(st); }
    st.textContent =
      'body.bgstyle-custom{background:#04140d url("' + dataUrl + '") center center / cover fixed !important;}' +
      // dezenter Abdunkler, damit Neon-Text lesbar bleibt:
      'body.bgstyle-custom #bg-scene{background:linear-gradient(180deg,rgba(0,0,0,.28),rgba(0,0,0,.5)) !important;}';
  }

  // Bild verkleinern (max. Kantenlänge), damit es sicher in den localStorage passt.
  function downscaleImage(dataUrl, maxSide, cb) {
    var img = new Image();
    img.onload = function () {
      var scale = Math.min(1, maxSide / Math.max(img.width, img.height));
      var w = Math.max(1, Math.round(img.width * scale));
      var h = Math.max(1, Math.round(img.height * scale));
      try {
        var cv = document.createElement('canvas'); cv.width = w; cv.height = h;
        cv.getContext('2d').drawImage(img, 0, 0, w, h);
        cb(cv.toDataURL('image/jpeg', 0.82));
      } catch (e) { cb(dataUrl); }
    };
    img.onerror = function () { cb(dataUrl); };
    img.src = dataUrl;
  }

  // Datei einlesen -> verkleinern -> speichern -> als Hintergrund aktivieren.
  function loadCustomFile(file, done) {
    if (!file || !/^image\//.test(file.type)) { if (done) done(false); return; }
    var reader = new FileReader();
    reader.onload = function () {
      downscaleImage(reader.result, 1600, function (small) {
        customImg = small;
        var ok = true;
        try { App.Storage ? App.Storage.set(KEY_BG_IMG, small) : localStorage.setItem(KEY_BG_IMG, small); }
        catch (e) { ok = false; } // z. B. Quota voll
        injectBgImgCss(customImg);
        applyBg('custom');
        if (done) done(ok);
      });
    };
    reader.onerror = function () { if (done) done(false); };
    reader.readAsDataURL(file);
  }

  function clearCustomImage() {
    customImg = null;
    try {
      if (App.Storage && App.Storage.remove) App.Storage.remove(KEY_BG_IMG);
      else if (App.Storage) App.Storage.set(KEY_BG_IMG, null);
      else localStorage.removeItem(KEY_BG_IMG);
    } catch (e) {}
    injectBgImgCss(null);
    if (currentBg === 'custom') applyBg('jungle');
  }

  function removeAllBgClasses() {
    for (var i = 0; i < BG_STYLES.length; i++) document.body.classList.remove('bgstyle-' + BG_STYLES[i].id);
    document.body.classList.remove('bgstyle-custom');
  }

  function applyBg(id, persist) {
    if (id === 'custom' && !customImg) id = 'jungle'; // nichts hochgeladen -> Standard
    injectBgCss();
    injectBgImgCss(customImg); // Regel bereithalten (greift nur bei .bgstyle-custom)
    if (id === 'custom') {
      currentBg = 'custom';
      if (document.body) {
        removeAllBgClasses();
        document.body.classList.add('bgstyle-custom');
        var scene = ensureScene(); // eigene Szene leeren (nur Abdunkler-Overlay)
        while (scene && scene.firstChild) scene.removeChild(scene.firstChild);
      }
    } else {
      var b = byBgId(id); currentBg = b.id;
      if (document.body) {
        removeAllBgClasses();
        document.body.classList.add('bgstyle-' + b.id);
        buildScene(b.id);
      }
    }
    if (persist !== false) { try { App.Storage ? App.Storage.set(KEY_BG, currentBg) : localStorage.setItem(KEY_BG, currentBg); } catch (e) {} }
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
      '.switch.on .knob{left:27px;}',
      // Stil-/Hintergrund-Vorschaukarten (nutzen dieselben theme-card-Klassen).
      '.bg-card .theme-preview{height:62px;border:1px solid var(--stroke);}',
      '.bg-card .theme-name{font-size:15px;}',
      '.bg-card .bg-desc{font-size:11px;color:var(--muted);margin-top:4px;}',
      '.bg-prev{background-size:cover;}',
      // Karte "Eigenes Bild"
      '.bg-custom-prev{background-size:cover;background-position:center;display:flex;align-items:center;justify-content:center;background-color:rgba(255,255,255,.05);}',
      '.bg-custom-plus{font-size:30px;font-weight:900;color:var(--muted);}',
      '.bg-actions{display:flex;gap:8px;margin-top:8px;flex-wrap:wrap;}',
      '.bg-mini{font:inherit;font-size:12px;font-weight:800;padding:6px 10px;border-radius:10px;border:1px solid var(--stroke);background:rgba(9,32,21,.7);color:var(--text);cursor:pointer;}',
      '.bg-mini:hover{border-color:var(--neon);}',
      '.bgprev-jungle{background:radial-gradient(circle at 25% 25%,rgba(57,255,20,.45),transparent 55%),radial-gradient(circle at 80% 70%,rgba(51,230,208,.35),transparent 55%),linear-gradient(160deg,#04170d,#0a2e1a);}',
      '.bgprev-water{background:radial-gradient(circle at 50% 0%,rgba(90,205,255,.5),transparent 60%),radial-gradient(circle at 30% 80%,rgba(60,150,230,.35),transparent 60%),linear-gradient(180deg,#083650,#02101f);}',
      '.bgprev-fire{background:radial-gradient(circle at 50% 105%,rgba(255,150,30,.8),rgba(255,80,20,.3) 45%,transparent 70%),linear-gradient(0deg,#2a0a04,#140406);}',
      '.bgprev-stone{background:radial-gradient(circle at 40% 20%,rgba(160,150,130,.4),transparent 60%),radial-gradient(circle at 70% 75%,rgba(120,200,230,.25),transparent 55%),linear-gradient(160deg,#232019,#0d0b08);}',
      '.bgprev-ice{background:radial-gradient(circle at 50% 15%,rgba(190,235,255,.6),transparent 60%),radial-gradient(circle at 20% 80%,rgba(255,255,255,.3),transparent 55%),linear-gradient(160deg,#0c3245,#04141f);}',
      '.bgprev-storm{background:radial-gradient(circle at 65% 20%,rgba(210,220,245,.35),transparent 55%),radial-gradient(circle at 30% 30%,rgba(50,55,72,.7),transparent 60%),linear-gradient(160deg,#12151d,#05070c);}',
      '.bgprev-galaxy{background:radial-gradient(circle at 30% 40%,rgba(150,90,255,.5),transparent 55%),radial-gradient(circle at 75% 62%,rgba(60,140,255,.45),transparent 55%),radial-gradient(circle at 55% 25%,rgba(255,90,200,.3),transparent 55%),linear-gradient(160deg,#0a0620,#02010a);}'
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

    var bgGrid = el('div', { class: 'theme-grid' }, BG_STYLES.map(function (b) {
      return el('button', {
        class: 'theme-card bg-card' + (b.id === currentBg ? ' active' : ''), type: 'button',
        onclick: function () { applyBg(b.id); if (App.Audio) App.Audio.sfx('select'); rerender(); }
      }, [
        b.id === currentBg ? el('span', { class: 'theme-tag' }, ['✓ aktiv']) : null,
        el('div', { class: 'theme-preview bg-prev bgprev-' + b.id }),
        el('div', { class: 'theme-name' }, [b.emoji + ' ' + b.name]),
        el('div', { class: 'bg-desc' }, [b.desc])
      ]);
    }));

    // Karte "Eigenes Bild" ans Ende des Hintergrund-Rasters hängen.
    var bgFileInput = el('input', {
      type: 'file', accept: 'image/*', style: 'display:none',
      onchange: function () {
        var f = this.files && this.files[0], self = this;
        loadCustomFile(f, function (ok) {
          if (!ok && App.UI && App.UI.toast) App.UI.toast('Bild zu groß — konnte nicht gespeichert werden.', 'lose');
          self.value = '';
          if (App.Audio) App.Audio.sfx('select');
          rerender();
        });
      }
    });
    var customActive = currentBg === 'custom';
    var customCard = el('div', {
      class: 'theme-card bg-card bg-custom' + (customActive ? ' active' : ''),
      onclick: function () {
        if (customImg) { applyBg('custom'); if (App.Audio) App.Audio.sfx('select'); rerender(); }
        else bgFileInput.click();
      }
    }, [
      customActive ? el('span', { class: 'theme-tag' }, ['✓ aktiv']) : null,
      el('div', {
        class: 'theme-preview bg-prev bg-custom-prev',
        style: customImg ? ('background-image:url("' + customImg + '")') : null
      }, [customImg ? null : el('span', { class: 'bg-custom-plus' }, ['＋'])]),
      el('div', { class: 'theme-name' }, ['🖼️ Eigenes Bild']),
      el('div', { class: 'bg-actions' }, [
        el('button', { class: 'bg-mini', type: 'button', onclick: function (e) { e.stopPropagation(); bgFileInput.click(); } },
          [customImg ? '🔄 Ändern' : '📁 Bild wählen']),
        customImg ? el('button', { class: 'bg-mini', type: 'button', onclick: function (e) { e.stopPropagation(); clearCustomImage(); if (App.Audio) App.Audio.sfx('select'); rerender(); } },
          ['✕ Entfernen']) : null
      ]),
      bgFileInput
    ]);
    bgGrid.appendChild(customCard);

    var rmSwitch = el('div', { class: 'switch' + (reduceMotion ? ' on' : ''), onclick: function () { setReduceMotion(!reduceMotion); this.classList.toggle('on', reduceMotion); } }, [el('span', { class: 'knob' })]);
    var soundOn = !(App.Audio && App.Audio.isMuted && App.Audio.isMuted());
    var sndSwitch = el('div', { class: 'switch' + (soundOn ? ' on' : ''), onclick: function () { if (App.Audio) { App.Audio.start(); App.Audio.setMuted(!App.Audio.isMuted()); } this.classList.toggle('on', !(App.Audio && App.Audio.isMuted())); } }, [el('span', { class: 'knob' })]);
    var arSwitch = el('div', { class: 'switch' + (autoRestart ? ' on' : ''), onclick: function () { setAutoRestart(!autoRestart); this.classList.toggle('on', autoRestart); } }, [el('span', { class: 'knob' })]);
    var amSwitch = el('div', { class: 'switch' + (autoMax ? ' on' : ''), onclick: function () { setAutoMax(!autoMax); this.classList.toggle('on', autoMax); } }, [el('span', { class: 'knob' })]);

    var page = el('div', { class: 'set-page' }, [
      el('div', { class: 'page-head' }, [
        el('button', { class: 'btn btn-ghost back', type: 'button', onclick: function () { App.Router.go('/'); } }, ['← Menü']),
        el('h2', { class: 'page-title neon' }, ['⚙️ Einstellungen'])
      ]),
      el('div', { class: 'set-sec-h' }, ['Farb-Style']),
      grid,
      el('div', { class: 'set-sec-h' }, ['Stil / Hintergrund']),
      bgGrid,
      el('div', { class: 'set-sec-h' }, ['Optionen']),
      el('div', { class: 'set-toggle' }, [el('div', {}, [el('div', { class: 'st-l' }, ['🔊 Sound & Musik']), el('div', { class: 'st-d' }, ['Effekte + Menü-Musik'])]), sndSwitch]),
      el('div', { class: 'set-toggle' }, [el('div', {}, [el('div', { class: 'st-l' }, ['🎞️ Bewegung reduzieren']), el('div', { class: 'st-d' }, ['Weniger Animationen (schont schwache Geräte)'])]), rmSwitch]),
      el('div', { class: 'set-sec-h' }, ['Nach Pleite']),
      el('div', { class: 'set-toggle' }, [el('div', {}, [el('div', { class: 'st-l' }, ['🌱 Sofort weiterspielen']), el('div', { class: 'st-d' }, ['Kein „Neustart"-Fenster mehr — bei Pleite gibt es sofort das Einstiegsgeld zurück.'])]), arSwitch]),
      el('div', { class: 'set-toggle' }, [el('div', {}, [el('div', { class: 'st-l' }, ['💰 Max-Einsatz vorwählen']), el('div', { class: 'st-d' }, ['Der Einsatz steht (auch nach der Pleite) automatisch auf Maximum.'])]), amSwitch])
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
    theme: function () { return byId(current); }, setReduceMotion: setReduceMotion, onChange: onChange, renderPage: renderPage,
    // Schnelles-Weiterspielen-Optionen (app.js Game-Over + ui.js Wett-Panel):
    autoRestart: function () { return autoRestart; }, setAutoRestart: setAutoRestart,
    autoMaxBet: function () { return autoMax; }, setAutoMaxBet: setAutoMax,
    // Stil-/Hintergrund-API (unabhängig von den Farb-Themes)
    applyBg: applyBg, currentBg: function () { return currentBg; }, bgStyles: function () { return BG_STYLES.slice(); },
    // Eigenes Hintergrundbild
    customImage: function () { return customImg; }, clearCustomImage: clearCustomImage,
    setCustomFile: loadCustomFile
  };

  // Theme + Hintergrund so früh wie möglich anwenden (kein Flackern), Nav wenn DOM bereit.
  apply(current, false);
  applyBg(currentBg, false);
  if (reduceMotion) document.documentElement.classList.add('reduce-motion');
  function boot() { apply(current, false); applyBg(currentBg, false); installNav(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
