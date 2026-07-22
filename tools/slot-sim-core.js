/* slot-sim-core.js — Rundenablauf der Slot-Automaten als reine Rechnung.
 *
 * Bildet nach, was slot-engine.js im Browser tut (Linien, Freispiele, Cascade,
 * Sticky-Respins, Truhen-Bonus) — nur ohne DOM und Animation. Wird von
 * slot-rtp.js und slot-calibrate.js benutzt. Ändert sich ein Feature in der
 * Engine, muss es hier mitgezogen werden.
 */
'use strict';

module.exports = function (math) {
  var BET = 1000;

  function randomSym(theme) {
    var r = Math.random() * theme._totalWeight;
    for (var i = 0; i < theme.symbols.length; i++) {
      r -= theme.symbols[i].weight;
      if (r < 0) return theme.symbols[i].id;
    }
    return theme.symbols[theme.symbols.length - 1].id;
  }

  function pickExpand(theme) {
    var sc = theme.scatter;
    var pool = theme.symbols.filter(function (s) { return s.id !== sc.id && s.id !== theme.wild; });
    return pool[(Math.random() * pool.length) | 0].id;
  }

  /* Kettenreaktion: Gewinnsymbole raus, nachfüllen, Multiplikator hoch. */
  function cascade(theme, grid, res, mult) {
    var hits = {};
    res.lineWins.forEach(function (w) {
      var line = theme._lines[w.line];
      for (var c = 0; c < w.count; c++) hits[c + ':' + line[c]] = true;
    });
    if (!Object.keys(hits).length) return 0;

    var g2 = [];
    for (var r = 0; r < theme.reels; r++) {
      var keep = [];
      for (var y = 0; y < theme.rows; y++) if (!hits[r + ':' + y]) keep.push(grid[r][y]);
      var fill = [];
      while (fill.length + keep.length < theme.rows) fill.push(randomSym(theme));
      g2.push(fill.concat(keep));
    }
    var r2 = math.evalGrid(theme, g2, BET, { globalMult: mult });
    if (r2.total <= 0) return 0;
    return r2.total + cascade(theme, g2, r2, Math.min(mult + 1, 5));
  }

  /* Sticky-Wild-Respins: erster Auslöser braucht respinTrigger Wilds. */
  function respinSeries(theme, grid) {
    var MAX = 8, used = 0, extra = 0;
    var sticky = {};
    function collect(g) {
      var n = 0;
      for (var r = 0; r < theme.reels; r++) {
        for (var y = 0; y < theme.rows; y++) {
          if (g[r][y] === theme.wild && !sticky[r + ':' + y]) { sticky[r + ':' + y] = true; n++; }
        }
      }
      return n;
    }
    var fresh = collect(grid);
    while (used < MAX && fresh >= (used === 0 ? (theme.respinTrigger || 2) : 1)) {
      used++;
      var g = math.spinGrid(theme);
      Object.keys(sticky).forEach(function (k) {
        var p = k.split(':');
        g[+p[0]][+p[1]] = theme.wild;
      });
      extra += math.evalGrid(theme, g, BET).total;
      fresh = collect(g);
    }
    return extra;
  }

  /* Truhen-Bonus: pickCount aus 9 ohne Zurücklegen. */
  function pickBonus(theme) {
    var pool = (theme.pickPool || [1, 1, 1, 2, 2, 3, 5, 8, 20]).slice();
    for (var i = pool.length - 1; i > 0; i--) {
      var j = (Math.random() * (i + 1)) | 0, t = pool[i]; pool[i] = pool[j]; pool[j] = t;
    }
    var sum = 0;
    for (var k = 0; k < (theme.pickCount || 3); k++) sum += pool[k];
    return Math.round(BET * sum);
  }

  /* Eine Runde. Rückgabe getrennt nach Linien- und Feature-Anteil. */
  function playRoundSplit(theme) {
    var grid = math.spinGrid(theme);
    var res = math.evalGrid(theme, grid, BET);
    var base = res.total, feat = 0;
    var sc = theme.scatter;

    if (theme.feature === 'cascade' && res.lineWins.length) feat += cascade(theme, grid, res, 2);
    if (theme.feature === 'respin') feat += respinSeries(theme, grid);

    if (sc && res.scatterCount >= (sc.trigger || 3)) {
      if (theme.feature === 'pick') {
        feat += pickBonus(theme);
      } else {
        var expand = sc.expanding ? pickExpand(theme) : null;
        for (var i = 0; i < (sc.freeSpins || 10); i++) {
          feat += math.evalGrid(theme, math.spinGrid(theme), BET, { expand: expand }).total;
        }
      }
    }
    return { base: base, feature: feat, scatterPay: res.scatterWin };
  }

  function playRound(theme) {
    var r = playRoundSplit(theme);
    return r.base + r.feature;
  }

  return { BET: BET, playRound: playRound, playRoundSplit: playRoundSplit };
};
