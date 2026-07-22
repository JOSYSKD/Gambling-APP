/* naehe-rtp.js — RTP von "Nähe" gegen zwei sehr unterschiedliche Spieler.
 *
 *   node tools/naehe-rtp.js [runden]
 *
 * "rechnend": führt die Menge aller noch möglichen Zielfelder mit und tippt auf
 *   das Feld, das diese Menge im Schnitt am stärksten zerlegt (bei Gleichstand
 *   auf ein Feld, das selbst noch Kandidat ist und damit treffen kann).
 *   Das ist die Obergrenze — mehr geht mit den Zonen-Angaben nicht heraus.
 * "intuitiv": spielt wie ein Mensch ohne Notizen — erst grob streuen, dann um
 *   das beste bisher gefundene Feld herum suchen.
 *
 * Beide Werte sind wichtig: der erste darf nicht über 100 % liegen (sonst wäre
 * das Spiel farmbar), der zweite soll nicht viel darunter liegen (sonst macht
 * es keinen Spaß).
 */
'use strict';
var fs = require('fs');
var path = require('path');
var ROOT = path.join(__dirname, '..');

global.window = global;
new Function(fs.readFileSync(path.join(ROOT, 'js/games/naehe.js'), 'utf8'))();

var G = global.App.Games.naehe;
var SIZE = G.size, PAY = G.payouts, MAX = G.maxTries, zoneOf = G.zoneOf;
var N = parseInt(process.argv[2], 10) || 5000;

function dist(ax, ay, bx, by) { return Math.max(Math.abs(ax - bx), Math.abs(ay - by)); }
function answer(x, y, tx, ty) { return zoneOf(dist(x, y, tx, ty)); }

/* ---------- Spieler 1: rechnend ---------- */
function moveSmart(cands, opened) {
  var bestScore = Infinity, best = null, bestIsCand = false;
  var candSet = {};
  cands.forEach(function (c) { candSet[c] = true; });

  for (var y = 0; y < SIZE; y++) {
    for (var x = 0; x < SIZE; x++) {
      if (opened[x + ':' + y]) continue;
      var buckets = {};
      for (var i = 0; i < cands.length; i++) {
        var p = cands[i];
        var z = answer(x, y, p % SIZE, (p / SIZE) | 0);
        buckets[z] = (buckets[z] || 0) + 1;
      }
      var score = 0;
      Object.keys(buckets).forEach(function (z) {
        if (z === '0') return;              // Treffer -> nichts bleibt übrig
        score += buckets[z] * buckets[z];
      });
      score /= cands.length;
      var isCand = !!candSet[y * SIZE + x];
      if (score < bestScore - 1e-9 || (Math.abs(score - bestScore) < 1e-9 && isCand && !bestIsCand)) {
        bestScore = score; best = [x, y]; bestIsCand = isCand;
      }
    }
  }
  return best;
}

/* ---------- Spieler 2: intuitiv ---------- */
function moveHuman(state, opened) {
  // Noch keine Rückmeldung: irgendwo hin (leicht Richtung Mitte).
  if (!state.best) return randomFree(opened);
  // Um das beste bisherige Feld herum suchen, im passenden Abstand.
  var z = state.bestZone;
  var lo = (z - 1) * G.zoneWidth + 1, hi = z * G.zoneWidth;
  for (var t = 0; t < 60; t++) {
    var r = lo + ((Math.random() * (hi - lo + 1)) | 0);
    var ang = Math.random() * Math.PI * 2;
    var x = state.best[0] + Math.round(Math.cos(ang) * r);
    var y = state.best[1] + Math.round(Math.sin(ang) * r);
    if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) continue;
    if (opened[x + ':' + y]) continue;
    return [x, y];
  }
  return randomFree(opened);
}
function randomFree(opened) {
  for (var t = 0; t < 500; t++) {
    var x = (Math.random() * SIZE) | 0, y = (Math.random() * SIZE) | 0;
    if (!opened[x + ':' + y]) return [x, y];
  }
  for (var yy = 0; yy < SIZE; yy++) for (var xx = 0; xx < SIZE; xx++) if (!opened[xx + ':' + yy]) return [xx, yy];
  return [0, 0];
}

/* ---------- Läufe ---------- */
function run(kind) {
  var totalMult = 0, hits = {}, lost = 0;
  for (var r = 0; r < N; r++) {
    var tx = (Math.random() * SIZE) | 0, ty = (Math.random() * SIZE) | 0;
    var cands = [];
    for (var i = 0; i < SIZE * SIZE; i++) cands.push(i);
    var opened = {}, tries = 0, done = false;
    var state = { best: null, bestZone: 99 };

    while (tries < MAX && !done) {
      var mv = kind === 'smart' ? moveSmart(cands, opened) : moveHuman(state, opened);
      var x = mv[0], y = mv[1];
      opened[x + ':' + y] = true;
      tries++;
      var d = dist(x, y, tx, ty), z = zoneOf(d);
      if (d === 0) {
        totalMult += PAY[tries] || 0;
        hits[tries] = (hits[tries] || 0) + 1;
        done = true;
        break;
      }
      if (z < state.bestZone) { state.bestZone = z; state.best = [x, y]; }
      if (kind === 'smart') {
        cands = cands.filter(function (p) {
          return answer(x, y, p % SIZE, (p / SIZE) | 0) === z;
        });
      }
    }
    if (!done) lost++;
  }
  return { rtp: totalMult / N * 100, hits: hits, lost: lost / N * 100 };
}

var results = {};
['smart', 'human'].forEach(function (kind) {
  var r = run(kind);
  results[kind] = r;
  console.log('\n=== ' + (kind === 'smart' ? 'rechnender Spieler' : 'intuitiver Spieler') +
    '  —  RTP ' + r.rtp.toFixed(2) + ' %   (nie gefunden: ' + r.lost.toFixed(1) + ' %)');
  Object.keys(r.hits).map(Number).sort(function (a, b) { return a - b; }).forEach(function (t) {
    var share = r.hits[t] / N * 100;
    if (share < 0.05) return;
    console.log('  ' + String(t).padStart(2) + '. Versuch ' + share.toFixed(1).padStart(5) + ' %  ×' +
      (PAY[t] || 0) + '  → ' + (share * (PAY[t] || 0)).toFixed(1) + ' % RTP-Anteil');
  });
});

/* Vorschlag für eine Auszahlungskurve: die Wunschform bleibt, ein Faktor bringt
 * den rechnenden Spieler auf das Ziel. Bewusst mit Sicherheitsabstand unter
 * 100 % — ein Spieler, der zwischen Einkreisen und Raten optimal wechselt, holt
 * etwas mehr heraus als der hier simulierte reine Einkreiser. */
var TARGET = parseFloat(process.env.TARGET || '92');
var SHAPE = { 1: 200, 2: 60, 3: 25, 4: 6, 5: 2.2, 6: 1.2, 7: 0.7, 8: 0.45, 9: 0.3, 10: 0.2, 11: 0.15, 12: 0.1 };
var dist2 = results.smart.hits;
var raw = 0;
Object.keys(SHAPE).forEach(function (t) { raw += ((dist2[t] || 0) / N) * SHAPE[t]; });
var f = (TARGET / 100) / raw;
console.log('\n=== Kurven-Vorschlag für RTP ' + TARGET + ' % (rechnender Spieler), Faktor ' + f.toFixed(4) + ':');
var line = [];
Object.keys(SHAPE).forEach(function (t) {
  var v = SHAPE[t] * f;
  v = v >= 10 ? Math.round(v) : v >= 1 ? Math.round(v * 10) / 10 : Math.round(v * 100) / 100;
  line.push(t + ': ' + v);
});
console.log('  { ' + line.join(', ') + ' }');
