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

  /* Münz-Sammelbonus (Hold & Win): Münzen bleiben liegen, Respins werden von
   * jeder neuen Münze zurückgesetzt; am Ende zahlt die Summe der Münzwerte. */
  function holdWin(theme, grid) {
    var cfg = theme.coin;
    var cells = theme.reels * theme.rows;
    var held = {}, sum = 0;
    function value() {
      var v = cfg.values || [1, 1, 2, 3, 5];
      return v[(Math.random() * v.length) | 0];
    }
    for (var r = 0; r < theme.reels; r++) {
      for (var y = 0; y < theme.rows; y++) {
        if (grid[r][y] === cfg.id) { held[r + ':' + y] = 1; sum += value(); }
      }
    }
    var respins = cfg.respins || 3;
    while (respins > 0 && Object.keys(held).length < cells) {
      var fresh = 0;
      for (var r2 = 0; r2 < theme.reels; r2++) {
        for (var y2 = 0; y2 < theme.rows; y2++) {
          if (held[r2 + ':' + y2]) continue;
          if (Math.random() < (cfg.chance || 0.09)) { held[r2 + ':' + y2] = 1; sum += value(); fresh++; }
        }
      }
      if (fresh > 0) respins = cfg.respins || 3; else respins--;
    }
    if (Object.keys(held).length >= cells) sum += (cfg.grand || 200);
    return Math.round(BET * sum);
  }

  /* Wild-Expansion: Walzen mit Wild werden ganz wild, danach ein Gratis-Respin. */
  function expandWild(theme, grid) {
    var any = false;
    for (var r = 0; r < theme.reels; r++) {
      var has = false;
      for (var y = 0; y < theme.rows; y++) if (grid[r][y] === theme.wild) has = true;
      if (!has) continue;
      any = true;
      for (var y2 = 0; y2 < theme.rows; y2++) grid[r][y2] = theme.wild;
    }
    return any;
  }

  /* Elfmeterschießen: der simulierte Spieler schießt alle fünf (maximaler
   * Erwartungswert, weil die Leiter steiler steigt als die Halte-Quote). */
  function penalty(theme) {
    var steps = theme.penaltySteps || [2, 4, 7, 12, 25];
    var banked = 0;
    for (var i = 0; i < steps.length; i++) {
      // Engine: Torwart trifft die Ecke zu 1/3 und hält davon 85 %, dazu eine
      // kleine Restchance auf einen Fangreflex.
      var saved = (Math.random() < 1 / 3 && Math.random() < 0.85) ||
        (Math.random() < (theme.penaltySave || 0.42) * 0.35);
      if (saved) return 0;
      banked = steps[i];
    }
    return Math.round(BET * banked);
  }

  /* Eine Runde. Rückgabe getrennt nach Linien- und Feature-Anteil. */
  function playRoundSplit(theme, carry) {
    var grid = math.spinGrid(theme);

    // Hold & Win greift vor der Linienauswertung
    if (theme.coin) {
      var coins = 0;
      for (var r = 0; r < theme.reels; r++) {
        for (var y = 0; y < theme.rows; y++) if (grid[r][y] === theme.coin.id) coins++;
      }
      if (coins >= (theme.coin.trigger || 6)) {
        return { base: 0, feature: holdWin(theme, grid), scatterPay: 0, streak: 0 };
      }
    }

    var expanded = theme.feature === 'expandwild' && expandWild(theme, grid);
    var mult = (carry && carry.streak > 1) ? carry.streak : 0;
    var res = math.evalGrid(theme, grid, BET, { globalMult: mult });
    var base = res.total, feat = 0;
    var sc = theme.scatter;

    if (expanded) {
      // Gratis-Nachdrehen mit demselben Einsatz
      var g2 = math.spinGrid(theme);
      if (theme.feature === 'expandwild') expandWild(theme, g2);
      feat += math.evalGrid(theme, g2, BET).total;
    }
    if (theme.feature === 'cascade' && res.lineWins.length) feat += cascade(theme, grid, res, 2);
    if (theme.feature === 'respin') feat += respinSeries(theme, grid);

    var out = { base: base, feature: feat, scatterPay: res.scatterWin, streak: 1 };
    if (theme.feature === 'streak') {
      var STEPS = [1, 2, 3, 5];
      var step = (carry && carry.step) || 0;
      out.step = (base + feat) > 0 ? Math.min(step + 1, STEPS.length - 1) : 0;
      out.streak = STEPS[out.step];
    }

    if (sc && res.scatterCount >= (sc.trigger || 3)) {
      if (theme.feature === 'penalty') {
        out.feature += penalty(theme);
        return out;
      }
      if (theme.feature === 'pick') {
        feat += pickBonus(theme);
        out.feature = feat;
      } else {
        var expand = sc.expanding ? pickExpand(theme) : null;
        for (var i = 0; i < (sc.freeSpins || 10); i++) {
          feat += math.evalGrid(theme, math.spinGrid(theme), BET, { expand: expand }).total;
        }
        out.feature = feat;
      }
    }
    return out;
  }

  /* Eine Runde ohne Serien-Gedächtnis (fuer Kalibrierung/Einzelmessung).
   * `carry` traegt den Serien-Multiplikator von Runde zu Runde weiter. */
  function playRound(theme, carry) {
    var r = playRoundSplit(theme, carry);
    if (carry) { carry.streak = r.streak || 1; carry.step = r.step || 0; }
    return r.base + r.feature;
  }

  return { BET: BET, playRound: playRound, playRoundSplit: playRoundSplit };
};
