/* audio.js — komplett synthetisierter Sound (Web Audio API, keine Dateien, file://-fähig).
 *
 * - Menü-Musik: chillige, tiefe, gedämpfte Ambient-Fläche (lange Töne, Lowpass = "dumpf").
 * - Spiel-Beat: chilliger, langsamer Beat mit weichem Kick/Hat/Bass + warmer Fläche.
 * - SFX: mellow Klicks/Gewinn/Verlust/Karten/Chips — zentral an App.UI angedockt,
 *   sodass JEDES Spiel automatisch Sound bekommt (kein Eingriff pro Spiel nötig).
 * - Mute-Knopf im Header, in localStorage gemerkt. Audio startet (Browser-Vorgabe)
 *   erst nach der ersten Nutzer-Interaktion.
 */
(function () {
  'use strict';
  window.App = window.App || {};

  var AC = window.AudioContext || window.webkitAudioContext;
  var ctx = null, master = null, musicGain = null, sfxGain = null, noiseBuf = null;
  var muted = false;
  try { muted = App.Storage ? App.Storage.get('gj_muted', false) : (localStorage.getItem('gj_muted') === '1'); } catch (e) {}
  var started = false, curMusic = null, musicTimers = [], musicNodes = [];

  function ensure() {
    if (ctx) return true;
    if (!AC) return false;
    ctx = new AC();
    master = ctx.createGain(); master.gain.value = muted ? 0 : 0.55; master.connect(ctx.destination);
    musicGain = ctx.createGain(); musicGain.gain.value = 0.6; musicGain.connect(master);
    sfxGain = ctx.createGain(); sfxGain.gain.value = 1.0; sfxGain.connect(master);
    // Rausch-Puffer für Hats/Karten
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 0.5, ctx.sampleRate);
    var d = noiseBuf.getChannelData(0);
    for (var i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return true;
  }

  function now() { return ctx ? ctx.currentTime : 0; }

  /* Ein Ton mit Hüllkurve. */
  function tone(freq, t, dur, opts) {
    opts = opts || {};
    var o = ctx.createOscillator(); o.type = opts.type || 'sine';
    o.frequency.value = freq;
    if (opts.detune) o.detune.value = opts.detune;
    var g = ctx.createGain();
    var peak = opts.peak != null ? opts.peak : 0.3;
    var atk = opts.atk != null ? opts.atk : 0.02;
    var rel = opts.rel != null ? opts.rel : 0.3;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + atk);
    g.gain.setValueAtTime(peak, t + Math.max(atk, dur - rel));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    var out = opts.dest || sfxGain;
    if (opts.filter) {
      var f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = opts.filter;
      o.connect(g); g.connect(f); f.connect(out);
    } else { o.connect(g); g.connect(out); }
    o.start(t); o.stop(t + dur + 0.05);
    return o;
  }
  function noise(t, dur, opts) {
    opts = opts || {};
    var s = ctx.createBufferSource(); s.buffer = noiseBuf;
    var g = ctx.createGain();
    var peak = opts.peak != null ? opts.peak : 0.15;
    g.gain.setValueAtTime(peak, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    var f = ctx.createBiquadFilter(); f.type = opts.type || 'highpass'; f.frequency.value = opts.freq || 6000;
    s.connect(f); f.connect(g); g.connect(opts.dest || sfxGain);
    s.start(t); s.stop(t + dur + 0.02);
    return s;
  }

  /* ---------------- SFX ---------------- */
  var SFX = {
    click: function () { tone(420, now(), 0.12, { type: 'sine', peak: 0.05, atk: 0.005, rel: 0.1, filter: 1200 }); },
    select: function () { tone(560, now(), 0.16, { type: 'triangle', peak: 0.09, rel: 0.14, filter: 1800 }); },
    win: function () { var t = now();[523.25, 659.25, 783.99, 1046.5].forEach(function (f, i) { tone(f, t + i * 0.11, 0.5, { type: 'triangle', peak: 0.12, atk: 0.01, rel: 0.45, filter: 2600 }); }); },
    lose: function () { var t = now();[392, 311.13].forEach(function (f, i) { tone(f, t + i * 0.16, 0.6, { type: 'sine', peak: 0.13, rel: 0.5, filter: 900 }); }); },
    deal: function () { noise(now(), 0.09, { peak: 0.12, freq: 3500, type: 'bandpass' }); tone(300, now(), 0.08, { peak: 0.05, rel: 0.07 }); },
    chip: function () { tone(880, now(), 0.14, { type: 'triangle', peak: 0.1, atk: 0.004, rel: 0.12, filter: 3000 }); },
    roll: function () { noise(now(), 0.22, { peak: 0.1, freq: 1600, type: 'bandpass' }); },
    info: function () { tone(494, now(), 0.16, { type: 'sine', peak: 0.06, rel: 0.14, filter: 1500 }); }
  };
  function sfx(name) {
    if (!started || muted || !ctx) return;
    try { (SFX[name] || SFX.click)(); } catch (e) {}
  }

  /* ---------------- Musik ---------------- */
  function clearMusic() {
    musicTimers.forEach(function (id) { clearTimeout(id); clearInterval(id); });
    musicTimers = [];
    musicNodes.forEach(function (n) { try { n.stop(); } catch (e) {} });
    musicNodes = [];
  }

  // Chillige, gedämpfte Menü-Fläche: langsame Akkorde durch ein Lowpass ("dumpf").
  var CHORDS = [
    [110.00, 130.81, 164.81], // Am
    [87.31, 110.00, 130.81],  // F
    [130.81, 164.81, 196.00], // C
    [98.00, 123.47, 146.83]   // G
  ];
  function menuLoop() {
    var pad = ctx.createGain(); pad.gain.value = 0.9; pad.connect(musicGain);
    var lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 620; lp.Q.value = 0.6; lp.connect(pad);
    var idx = 0;
    function step() {
      if (curMusic !== 'menu') return;
      var t = now(), dur = 5.2, ch = CHORDS[idx % CHORDS.length];
      ch.forEach(function (f) {
        musicNodes.push(tone(f, t, dur, { type: 'sawtooth', peak: 0.11, atk: 1.4, rel: 2.4, dest: lp, detune: -6 }));
        musicNodes.push(tone(f, t, dur, { type: 'triangle', peak: 0.08, atk: 1.6, rel: 2.4, dest: lp, detune: 6 }));
      });
      // tiefer Grundton
      musicNodes.push(tone(ch[0] / 2, t, dur, { type: 'sine', peak: 0.16, atk: 1.2, rel: 2.6, dest: lp }));
      if (musicNodes.length > 40) musicNodes = musicNodes.slice(-24);
      idx++;
      musicTimers.push(setTimeout(step, 4600));
    }
    step();
  }

  // Chilliger, langsamer Beat (~74 bpm) + warme Fläche.
  function gameLoop() {
    var beat = 0.81; // ~74 bpm
    var padF = ctx.createBiquadFilter(); padF.type = 'lowpass'; padF.frequency.value = 900; padF.connect(musicGain);
    var bassSeq = [55, 55, 73.42, 65.41];   // A1 A1 D2 C2
    var padSeq = [220, 220, 293.66, 261.63];
    var i = 0;
    function bar() {
      if (curMusic !== 'game') return;
      var t = now();
      // Kick auf 1 und 3
      [0, 2].forEach(function (b) { kick(t + b * beat); });
      // Hats auf den Offbeats
      [0.5, 1.5, 2.5, 3.5].forEach(function (b) { noise(t + b * beat, 0.05, { peak: 0.05, freq: 8000 }); });
      // Bass-Ton (lang) + Fläche (lang) pro Takt
      musicNodes.push(tone(bassSeq[i % bassSeq.length], t, beat * 3.6, { type: 'triangle', peak: 0.14, atk: 0.04, rel: 1.4, filter: 500 }));
      musicNodes.push(tone(padSeq[i % padSeq.length], t, beat * 3.8, { type: 'sawtooth', peak: 0.05, atk: 0.9, rel: 1.6, dest: padF, detune: 5 }));
      if (musicNodes.length > 40) musicNodes = musicNodes.slice(-24);
      i++;
      musicTimers.push(setTimeout(bar, beat * 4 * 1000));
    }
    function kick(t) {
      var o = ctx.createOscillator(); o.type = 'sine';
      var g = ctx.createGain();
      o.frequency.setValueAtTime(120, t); o.frequency.exponentialRampToValueAtTime(45, t + 0.12);
      g.gain.setValueAtTime(0.28, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);
      o.connect(g); g.connect(musicGain); o.start(t); o.stop(t + 0.3);
    }
    bar();
  }

  function setMusic(kind) {
    if (!ctx || curMusic === kind) return;
    clearMusic();
    curMusic = kind;
    if (muted) return;
    if (kind === 'menu') menuLoop();
    else if (kind === 'game') gameLoop();
  }
  function musicForHash() {
    var h = (location.hash || '').replace(/^#/, '');
    return (/^\/(game|mini)\//.test(h)) ? 'game' : 'menu';
  }
  function updateMusic() { if (started) setMusic(musicForHash()); }

  /* ---------------- Start / Mute ---------------- */
  function start() {
    if (started) return;
    if (!ensure()) return;
    started = true;
    if (ctx.state === 'suspended') ctx.resume();
    setMusic(musicForHash());
    updateMuteBtn();
  }
  function setMuted(m) {
    muted = !!m;
    try { App.Storage ? App.Storage.set('gj_muted', muted) : localStorage.setItem('gj_muted', muted ? '1' : '0'); } catch (e) {}
    if (master) master.gain.value = muted ? 0 : 0.55;
    if (muted) { curMusic = null; clearMusic(); }
    else if (started) setMusic(musicForHash());
    updateMuteBtn();
  }
  var muteBtn = null;
  function updateMuteBtn() { if (muteBtn) { muteBtn.textContent = muted ? '🔇' : '🔊'; muteBtn.title = muted ? 'Ton an' : 'Ton aus'; } }
  function installMuteBtn() {
    var nav = document.querySelector('.topnav');
    if (!nav || muteBtn) return;
    muteBtn = document.createElement('button');
    muteBtn.className = 'topnav-link audio-toggle'; muteBtn.type = 'button';
    muteBtn.addEventListener('click', function (e) { e.preventDefault(); start(); setMuted(!muted); });
    nav.insertBefore(muteBtn, nav.firstChild);
    updateMuteBtn();
  }

  /* ---------------- Zentrale SFX-Hooks (jedes Spiel bekommt Sound) ---------------- */
  function hookUI() {
    if (!App.UI) return;
    var _toast = App.UI.toast;
    App.UI.toast = function (msg, kind) { sfx(kind === 'win' ? 'win' : kind === 'lose' ? 'lose' : 'info'); return _toast.apply(this, arguments); };
    var _flash = App.UI.flash;
    App.UI.flash = function (amount) { sfx(amount >= 0 ? 'chip' : 'lose'); return _flash.apply(this, arguments); };
  }

  var CLICK_SEL = 'button,.chip,.mg-tile,.game-tile,.cat-card,.topnav-link,.mg-mode,.tt-cell,.ch-sq,.lb-row';
  function onFirstGesture() { start(); }

  function boot() {
    installMuteBtn();
    hookUI();
    // Erste Interaktion startet Audio (Browser-Autoplay-Sperre)
    ['pointerdown', 'keydown', 'touchstart'].forEach(function (ev) {
      window.addEventListener(ev, onFirstGesture, { once: false });
    });
    // Klick-SFX für Bedienelemente (dient auch als Start-Geste)
    document.addEventListener('pointerdown', function (e) {
      start();
      var t = e.target && e.target.closest ? e.target.closest(CLICK_SEL) : null;
      if (t && !t.classList.contains('audio-toggle')) sfx('click');
    }, true);
    window.addEventListener('hashchange', updateMusic);
  }

  App.Audio = {
    sfx: sfx, start: start, setMuted: setMuted,
    isMuted: function () { return muted; },
    music: function (kind) { start(); setMusic(kind); }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
