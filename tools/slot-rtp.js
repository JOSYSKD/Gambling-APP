/* slot-rtp.js — rechnet den RTP jeder Themen-Slotmaschine per Monte-Carlo nach.
 *
 *   node tools/slot-rtp.js [runden]
 *
 * Lädt slot-engine.js/slot-themes.js in einen Node-Kontext (beide brauchen beim
 * Laden kein DOM); der Rundenablauf steckt in slot-sim-core.js.
 */
'use strict';
var fs = require('fs');
var path = require('path');
var ROOT = path.join(__dirname, '..');

global.window = global;
new Function(fs.readFileSync(path.join(ROOT, 'js/games/slot-engine.js'), 'utf8'))();
new Function(fs.readFileSync(path.join(ROOT, 'js/games/slot-themes.js'), 'utf8'))();

var sim = require('./slot-sim-core.js')(global.App.SlotEngine.math);
var THEMES = global.App.SlotThemes;
var N = parseInt(process.argv[2], 10) || 200000;

console.log('Runden je Automat: ' + N.toLocaleString('de-DE') + '\n');
console.log('Automat            RTP      Linien   Feature  Scatter  Treffer  max');
console.log('--------------------------------------------------------------------');
THEMES.forEach(function (theme) {
  var wag = 0, base = 0, feat = 0, scat = 0, hits = 0, max = 0;
  for (var i = 0; i < N; i++) {
    wag += sim.BET;
    var r = sim.playRoundSplit(theme);
    var w = r.base + r.feature;
    base += r.base; feat += r.feature; scat += r.scatterPay;
    if (w > 0) hits++;
    if (w > max) max = w;
  }
  console.log(
    pad(theme.title, 18) +
    pad(((base + feat) / wag * 100).toFixed(2) + ' %', 9) +
    pad((base / wag * 100).toFixed(1) + ' %', 9) +
    pad((feat / wag * 100).toFixed(1) + ' %', 9) +
    pad((scat / wag * 100).toFixed(1) + ' %', 9) +
    pad((hits / N * 100).toFixed(1) + ' %', 9) +
    '×' + (max / sim.BET).toFixed(0)
  );
});

function pad(s, n) { s = String(s); while (s.length < n) s += ' '; return s; }
