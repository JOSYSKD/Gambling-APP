/* audio.js — komplett synthetisierter Sound (Web Audio API, keine Dateien, file://-fähig).
 *
 * - Menü-Musik: chillige, tiefe, gedämpfte Ambient-Fläche (lange Töne, Lowpass = "dumpf").
 *   Läuft NUR im Menü/den Übersichten — IM SPIEL ist Musik aus (nur Soundeffekte).
 * - SFX: mellow Klicks/Gewinn/Verlust/Karten/Chips/Würfel/… — zentral an App.UI angedockt,
 *   sodass jedes Spiel eine Grund-Vertonung bekommt; Spiele können zusätzlich eigene,
 *   passende Effekte auslösen.
 * - Steuerbare Klänge für Spiele:
 *     App.Audio.sfx(name)              — benannte Einmal-Effekte (siehe SFX unten)
 *     App.Audio.blip(freq, dur, opts)  — ein einzelner Ton beliebiger Höhe
 *     App.Audio.sweep(f1, f2, dur, o)  — ein gleitender Ton (rauf/runter)
 *     App.Audio.hold(freq, opts)       — Dauerton mit Handle {setFreq,setGain,sweepTo,stop}
 *                                        (z. B. Crash: Ton steigt mit dem Multiplikator,
 *                                         bricht beim Absturz ab)
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
    // Rausch-Puffer für Hats/Karten/Würfel
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 0.5, ctx.sampleRate);
    var d = noiseBuf.getChannelData(0);
    for (var i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return true;
  }

  function now() { return ctx ? ctx.currentTime : 0; }
  var NOOP = function () {};
  var NOOP_HANDLE = { setFreq: NOOP, setGain: NOOP, sweepTo: NOOP, stop: NOOP };

  /* Ein Ton mit Hüllkurve. */
  function tone(freq, t, dur, opts) {
    opts = opts || {};
    var o = ctx.createOscillator(); o.type = opts.type || 'sine';
    o.frequency.value = freq;
    if (opts.detune) o.detune.value = opts.detune;
    if (opts.glideTo) o.frequency.exponentialRampToValueAtTime(Math.max(1, opts.glideTo), t + dur);
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
  function arp(freqs, step, dur, opts) {
    var t = now();
    freqs.forEach(function (f, i) { tone(f, t + i * step, dur, opts); });
  }
  var SFX = {
    click: function () { tone(420, now(), 0.12, { type: 'sine', peak: 0.05, atk: 0.005, rel: 0.1, filter: 1200 }); },
    select: function () { tone(560, now(), 0.16, { type: 'triangle', peak: 0.09, rel: 0.14, filter: 1800 }); },
    win: function () { arp([523.25, 659.25, 783.99, 1046.5], 0.11, 0.5, { type: 'triangle', peak: 0.12, atk: 0.01, rel: 0.45, filter: 2600 }); },
    lose: function () { var t = now();[392, 311.13].forEach(function (f, i) { tone(f, t + i * 0.16, 0.6, { type: 'sine', peak: 0.13, rel: 0.5, filter: 900 }); }); },
    deal: function () { noise(now(), 0.09, { peak: 0.12, freq: 3500, type: 'bandpass' }); tone(300, now(), 0.08, { peak: 0.05, rel: 0.07 }); },
    chip: function () { tone(880, now(), 0.14, { type: 'triangle', peak: 0.1, atk: 0.004, rel: 0.12, filter: 3000 }); },
    roll: function () { noise(now(), 0.24, { peak: 0.11, freq: 1600, type: 'bandpass' }); noise(now() + 0.12, 0.12, { peak: 0.08, freq: 2200, type: 'bandpass' }); },
    info: function () { tone(494, now(), 0.16, { type: 'sine', peak: 0.06, rel: 0.14, filter: 1500 }); },
    // erweitertes Palette für Spiele
    coin: function () { tone(1046.5, now(), 0.12, { type: 'triangle', peak: 0.12, atk: 0.003, rel: 0.1, filter: 4000 }); tone(1568, now() + 0.05, 0.12, { type: 'triangle', peak: 0.09, rel: 0.1, filter: 4000 }); },
    jackpot: function () { arp([523.25, 659.25, 783.99, 1046.5, 1318.5], 0.09, 0.55, { type: 'triangle', peak: 0.13, atk: 0.01, rel: 0.5, filter: 3200 }); },
    cashout: function () { arp([659.25, 987.77, 1318.5], 0.08, 0.42, { type: 'sine', peak: 0.12, rel: 0.38, filter: 3600 }); },
    bust: function () { var t = now(); tone(220, t, 0.5, { type: 'sawtooth', peak: 0.16, atk: 0.005, rel: 0.45, filter: 900, glideTo: 60 }); noise(t, 0.4, { peak: 0.18, freq: 900, type: 'lowpass' }); },
    explosion: function () { var t = now(); noise(t, 0.5, { peak: 0.22, freq: 700, type: 'lowpass' }); tone(90, t, 0.45, { type: 'sine', peak: 0.16, rel: 0.4, glideTo: 40 }); },
    tick: function () { tone(1200, now(), 0.05, { type: 'square', peak: 0.05, atk: 0.002, rel: 0.04, filter: 2600 }); },
    ding: function () { tone(1318.5, now(), 0.3, { type: 'sine', peak: 0.12, atk: 0.004, rel: 0.28, filter: 4000 }); },
    point: function () { tone(880, now(), 0.14, { type: 'triangle', peak: 0.1, rel: 0.12, filter: 3200 }); },
    powerup: function () { sweepOnce(330, 990, 0.3, { type: 'triangle', peak: 0.11, filter: 3000 }); },
    levelup: function () { arp([392, 523.25, 659.25, 880], 0.08, 0.4, { type: 'triangle', peak: 0.12, rel: 0.36, filter: 3200 }); },
    error: function () { var t = now();[200, 160].forEach(function (f, i) { tone(f, t + i * 0.1, 0.18, { type: 'square', peak: 0.1, rel: 0.14, filter: 1200 }); }); },
    hit: function () { tone(140, now(), 0.16, { type: 'sine', peak: 0.16, atk: 0.004, rel: 0.14, glideTo: 70 }); noise(now(), 0.08, { peak: 0.1, freq: 2000, type: 'bandpass' }); },
    pop: function () { tone(660, now(), 0.1, { type: 'triangle', peak: 0.12, atk: 0.002, rel: 0.09, filter: 3000, glideTo: 990 }); },
    whoosh: function () { noise(now(), 0.3, { peak: 0.1, freq: 1200, type: 'bandpass' }); },
    start: function () { sweepOnce(440, 880, 0.35, { type: 'sine', peak: 0.11, filter: 3000 }); },
    step: function () { tone(320, now(), 0.06, { type: 'sine', peak: 0.07, rel: 0.05, filter: 1400 }); }
  };
  function sfx(name) {
    if (!ensureStarted()) return;
    try { (SFX[name] || SFX.click)(); } catch (e) {}
  }

  /* Ein einzelner Ton beliebiger Höhe (für melodische Cues: Simon, Höher/Tiefer, …). */
  function blip(freq, dur, opts) {
    if (!ensureStarted()) return;
    opts = opts || {};
    try { tone(freq, now(), dur || 0.16, { type: opts.type || 'triangle', peak: opts.peak != null ? opts.peak : 0.11, atk: opts.atk || 0.005, rel: opts.rel != null ? opts.rel : (dur || 0.16) * 0.7, filter: opts.filter || 3000, dest: sfxGain }); } catch (e) {}
  }
  /* Einmaliger gleitender Ton (rauf oder runter). */
  function sweepOnce(f1, f2, dur, opts) {
    if (!ctx) return;
    opts = opts || {};
    tone(f1, now(), dur || 0.3, { type: opts.type || 'sine', peak: opts.peak != null ? opts.peak : 0.11, atk: opts.atk || 0.01, rel: opts.rel != null ? opts.rel : (dur || 0.3) * 0.6, filter: opts.filter, glideTo: f2, dest: opts.dest || sfxGain });
  }
  function sweep(f1, f2, dur, opts) { if (!ensureStarted()) return; try { sweepOnce(f1, f2, dur, opts); } catch (e) {} }

  /* Dauerton mit Handle — für Spiele, die einen Klang live steuern (Crash-Multiplikator,
     Slot-Walzen, aufziehende Spannung). Handle.stop() beendet ihn (mit kurzem Fade). */
  function hold(freq, opts) {
    if (!ensureStarted()) return NOOP_HANDLE;
    opts = opts || {};
    try {
      var o = ctx.createOscillator(); o.type = opts.type || 'sine';
      o.frequency.setValueAtTime(Math.max(1, freq), now());
      if (opts.detune) o.detune.value = opts.detune;
      var g = ctx.createGain();
      var peak = opts.peak != null ? opts.peak : 0.1;
      g.gain.setValueAtTime(0.0001, now());
      g.gain.exponentialRampToValueAtTime(peak, now() + (opts.atk || 0.06));
      var dest = sfxGain, chain = g;
      if (opts.filter) { var f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = opts.filter; o.connect(g); g.connect(f); f.connect(dest); }
      else { o.connect(g); g.connect(dest); }
      o.start(now());
      var stopped = false;
      return {
        setFreq: function (fr, glideS) { try { var t = now(); o.frequency.cancelScheduledValues(t); if (glideS) o.frequency.exponentialRampToValueAtTime(Math.max(1, fr), t + glideS); else o.frequency.setValueAtTime(Math.max(1, fr), t); } catch (e) {} },
        setGain: function (v) { try { g.gain.setTargetAtTime(Math.max(0.0001, v), now(), 0.05); } catch (e) {} },
        sweepTo: function (fr, durS) { try { o.frequency.exponentialRampToValueAtTime(Math.max(1, fr), now() + (durS || 0.2)); } catch (e) {} },
        stop: function (fadeS) { if (stopped) return; stopped = true; try { var t = now(); fadeS = fadeS != null ? fadeS : 0.07; g.gain.cancelScheduledValues(t); g.gain.setValueAtTime(Math.max(0.0001, g.gain.value), t); g.gain.exponentialRampToValueAtTime(0.0001, t + fadeS); o.stop(t + fadeS + 0.03); } catch (e) {} }
      };
    } catch (e) { return NOOP_HANDLE; }
  }

  function ensureStarted() { if (!started) start(); return started && !muted && !!ctx; }

  /* ---------------- Musik (nur im Menü) ---------------- */
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

  function setMusic(kind) {
    if (!ctx || curMusic === kind) return;
    clearMusic();
    curMusic = kind;
    if (muted) return;
    if (kind === 'menu') menuLoop();
    // 'none' (im Spiel) / sonstiges: keine Musik – nur Soundeffekte
  }
  function musicForHash() {
    var h = (location.hash || '').replace(/^#/, '');
    return (/^\/(game|mini)\//.test(h)) ? 'none' : 'menu';   // im Spiel keine Musik
  }
  function updateMusic() { if (started) setMusic(musicForHash()); }

  /* ---------------- Start / Mute ---------------- */
  function start() {
    if (started) { if (ctx && ctx.state === 'suspended') ctx.resume(); return; }
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

  /* ---------------- Zentrale SFX-Hooks (jedes Spiel bekommt Grund-Sound) ---------------- */
  function hookUI() {
    if (!App.UI) return;
    var _toast = App.UI.toast;
    App.UI.toast = function (msg, kind) { sfx(kind === 'win' ? 'win' : kind === 'lose' ? 'lose' : 'info'); return _toast.apply(this, arguments); };
    var _flash = App.UI.flash;
    App.UI.flash = function (amount) { sfx(amount >= 0 ? 'chip' : 'lose'); return _flash.apply(this, arguments); };
  }

  var CLICK_SEL = 'button,.chip,.mg-tile,.game-tile,.cat-card,.topnav-link,.mg-mode,.tt-cell,.ch-sq,.lb-row';

  function boot() {
    installMuteBtn();
    hookUI();
    // Erste Interaktion startet Audio (Browser-Autoplay-Sperre)
    ['pointerdown', 'keydown', 'touchstart'].forEach(function (ev) {
      window.addEventListener(ev, start, { once: false });
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
    sfx: sfx, blip: blip, sweep: sweep, hold: hold,
    start: start, setMuted: setMuted,
    isMuted: function () { return muted; },
    music: function (kind) { start(); setMusic(kind); }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
