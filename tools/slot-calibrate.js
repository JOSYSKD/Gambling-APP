/* slot-calibrate.js — sucht je Automat den Faktor auf die Auszahlungstabelle,
 * mit dem der RTP das Ziel trifft, und druckt die fertig gerundeten Werte.
 *
 *   node tools/slot-calibrate.js [ziel-rtp] [runden]
 *
 * Läuft mit festem Zufalls-Seed, damit die Bisektion nicht im Rauschen hängt.
 * Die Zahlen werden anschließend von Hand in slot-themes.js übernommen — so
 * bleibt die Tabelle im Spiel identisch mit der, die hier gerechnet wurde.
 */
'use strict';
var fs = require('fs');
var path = require('path');
var ROOT = path.join(__dirname, '..');

/* deterministischer RNG (mulberry32) statt Math.random */
function seeded(seed) {
  return function () {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    var t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

global.window = global;
new Function(fs.readFileSync(path.join(ROOT, 'js/games/slot-engine.js'), 'utf8'))();
new Function(fs.readFileSync(path.join(ROOT, 'js/games/slot-themes.js'), 'utf8'))();

var sim = require('./slot-sim-core.js')(global.App.SlotEngine.math);
var THEMES = global.App.SlotThemes;
var TARGET = parseFloat(process.argv[2]) || 94;
var N = parseInt(process.argv[3], 10) || 60000;

function scaled(theme, f) {
  var copy = JSON.parse(JSON.stringify({
    id: theme.id, title: theme.title, reels: theme.reels, rows: theme.rows,
    feature: theme.feature, wild: theme.wild, wildMult: theme.wildMult,
    scatter: theme.scatter, respinTrigger: theme.respinTrigger,
    pickCount: theme.pickCount, pickPool: theme.pickPool,
    coin: theme.coin, penaltySteps: theme.penaltySteps, penaltySave: theme.penaltySave,
    symbols: theme.symbols
  }));
  copy.symbols.forEach(function (s) {
    if (!s.pay) return;
    Object.keys(s.pay).forEach(function (k) {
      s.pay[k] = Math.max(1, Math.round(s.pay[k] * f));
    });
  });
  return global.App.SlotEngine.prepare(copy);
}

var SEEDS = [12345, 777, 31337];

/* Über mehrere feste Seeds mitteln: einzelne Seeds streuen bei den seltenen
 * Großgewinnen stark, die Bisektion würde sonst im Rauschen zappeln. */
function rtpOf(theme, f) {
  var t = scaled(theme, f);
  var wag = 0, won = 0;
  SEEDS.forEach(function (seed) {
    Math.random = seeded(seed);
    var carry = { streak: 1, step: 0 };
    for (var i = 0; i < N; i++) { wag += sim.BET; won += sim.playRound(t, carry); }
  });
  return won / wag * 100;
}

THEMES.forEach(function (theme) {
  var lo = 0.4, hi = 2.0, f = 1, rtp = 0;
  for (var it = 0; it < 12; it++) {
    f = (lo + hi) / 2;
    rtp = rtpOf(theme, f);
    if (rtp > TARGET) hi = f; else lo = f;
  }
  console.log('\n=== ' + theme.title + '  (Faktor ' + f.toFixed(3) + ' → RTP ' + rtp.toFixed(2) + ' %) ===');
  var t = scaled(theme, f);
  t.symbols.forEach(function (s) {
    if (!s.pay) return;
    var parts = [];
    Object.keys(s.pay).sort().forEach(function (k) { parts.push(k + ': ' + s.pay[k]); });
    console.log('  ' + pad(s.id, 9) + 'pay: { ' + parts.join(', ') + ' }');
  });
});

function pad(s, n) { s = String(s); while (s.length < n) s += ' '; return s; }
