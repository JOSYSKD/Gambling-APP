/* bowling.js — "Bowling": rundenbasiertes Kegeln im Neon-Dschungel.
 *
 * IDEE
 *   Schräge Sicht von hinten auf die Bahn, 10 Pins im Dreieck. Geworfen wird
 *   mit der klassischen Balken-Mechanik in drei Schritten — jeder Balken läuft
 *   hin und her und wird per Klick gestoppt:
 *     1) POSITION — wo auf der Bahn der Ball losrollt
 *     2) KRAFT    — Tempo (Volldampf ist ein FEHLER: der Ball drückt die Pins
 *                   dann gerade nach hinten statt sie zu mischen; ~75–85 % ist
 *                   die beste Zone)
 *     3) EFFET    — Drall; der Ball läuft eine Kurve, die zum Pindeck hin immer
 *                   stärker greift. Langsame Bälle haken mehr als schnelle.
 *   Danach rollt die Kugel, die Pins fallen mit einfacher Kreis-Physik und
 *   stoßen sich gegenseitig um (auch liegende Pins räumen noch ab).
 *
 * STEUERUNG
 *   Klick/Tipp auf STOPP, auf den Balken selbst oder Leertaste — dreimal.
 *   Der Ball auf der Bahn und die Ziel-Linie zeigen die Wahl live an.
 *
 * PUNKTE
 *   Echte Bowling-Wertung: 10 Frames. Strike (X) = 10 + die nächsten zwei
 *   Würfe, Spare (/) = 10 + der nächste Wurf, im 10. Frame bis zu drei Würfe.
 *   Maximum 300. Die Tabelle steht im üblichen Bowling-Layout darunter.
 *
 * SOLO   gegen 1–3 Bots (Leicht/Mittel/Legende). Die Bots werfen mit derselben
 *        Physik: feste, offline eingemessene Pocket-Linie (Rechts- bzw.
 *        Linkshänder) plus gaußsches Rauschen je nach Stufe; für Spares suchen
 *        sie ihre Linie per grober Gittersuche + Verfeinerung (~16 ms).
 *        Schnitt real: ~110 / ~140 / ~180 Punkte.
 *
 * MULTI  Reihum über room.shared. Der Werfer rechnet sein Ergebnis selbst aus
 *        und schickt NUR die Wurfparameter (pos/pow/spin/seed + Pin-Stand
 *        davor) sowie den neuen Spielstand per setShared. Die Physik ist
 *        deterministisch (seeded PRNG, fester Zeitschritt) -> alle Geräte
 *        animieren exakt denselben Wurf. Gewertet wird immer der mitgeschickte
 *        Stand, nie die lokale Animation -> keine Divergenz.
 *        'shared'-Events kommen im Heartbeat ständig: Animation läuft nur bei
 *        neuer seq, die Tabelle nur bei geänderter Signatur (idempotent).
 *
 * Alle Zeiten laufen über Wall-Clock (Date.now bzw. room.now), nie über
 * Frame-Zählung. cleanup() beendet rAF, Timer, Listener und room.on-Handler. */
(function () {
  'use strict';
  window.App = window.App || {}; App.Minigames = App.Minigames || {};
  var UI = App.UI, el = UI.el;

  injectStyle();

  /* ===================== Spielfeld (virtuelle Einheiten) =====================
   * Maßstab an echtem Bowling: Pinabstand 64 = 12 Zoll, Bahnbreite 224 = 41,5
   * Zoll, Ball 44 Ø = 21,8 cm, Pin 24 Ø = 12 cm. Die Bahnlänge ist bewusst
   * gestaucht (echte 18 m wären als Bild unbrauchbar). */
  var VH = 900;
  var LANE_L = 68, LANE_R = 292, LANE_CX = 180;
  var BALL_R = 22, PIN_R = 12;
  var SP = 64, ROW = 55, HEAD_Y = 250, START_Y = 826, FOUL_Y = 838;
  var POS_RANGE = 90;                       // max. seitlicher Startversatz
  var SPEED_MIN = 260, SPEED_MAX = 470;     // px/s
  var HOOK_K = 260;                         // Stärke des Effets
  var MB = 6.4, MP = 1.5;                   // Masse Ball / Pin (kg)
  var DT = 1 / 120;                         // fester Physik-Schritt
  var FULL = '1111111111';

  /* Pin 1..10 in Standard-Aufstellung (Index 0 = Pin 1 = Kopfpin) */
  var PIN_HOME = [
    { x: LANE_CX, y: HEAD_Y },
    { x: LANE_CX - SP / 2, y: HEAD_Y - ROW },
    { x: LANE_CX + SP / 2, y: HEAD_Y - ROW },
    { x: LANE_CX - SP, y: HEAD_Y - 2 * ROW },
    { x: LANE_CX, y: HEAD_Y - 2 * ROW },
    { x: LANE_CX + SP, y: HEAD_Y - 2 * ROW },
    { x: LANE_CX - 1.5 * SP, y: HEAD_Y - 3 * ROW },
    { x: LANE_CX - 0.5 * SP, y: HEAD_Y - 3 * ROW },
    { x: LANE_CX + 0.5 * SP, y: HEAD_Y - 3 * ROW },
    { x: LANE_CX + 1.5 * SP, y: HEAD_Y - 3 * ROW }
  ];

  /* ===================== Leinwand + Perspektive ===================== */
  var CW = 420, CH = 620;
  var PSP = 1.0, FAR_Y = 78, NEAR_Y = 590, XK = 1.45, CX = 210;
  var SMIN = 1 / (1 + PSP);

  function sOf(vy) { return 1 / (1 + PSP * ((VH - vy) / VH)); }
  function pY(vy) { return FAR_Y + (NEAR_Y - FAR_Y) * (sOf(vy) - SMIN) / (1 - SMIN); }
  function pX(vx, vy) { return CX + (vx - LANE_CX) * sOf(vy) * XK; }

  /* ===================== Deterministischer Zufall ===================== */
  function rng(seed) {
    var s = seed >>> 0;
    return function () {
      s = (s + 0x6D2B79F5) >>> 0;
      var t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function gauss(rnd) { var u = 1 - rnd(), v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

  /* ===================== Physik =====================
   * Rein und deterministisch: gleiche Parameter + gleicher Seed = gleicher
   * Ablauf auf jedem Gerät. record=true zeichnet jeden Schritt für die
   * Animation auf (Wiedergabe per Wall-Clock-Index, kein Drift möglich). */
  function simulate(p, standing, record) {
    var rnd = rng(p.seed | 0), i, j;
    var pins = [];
    for (i = 0; i < 10; i++) {
      var live = standing.charAt(i) === '1';
      pins.push({
        x: PIN_HOME[i].x + (rnd() * 2 - 1) * 0.9,   // minimaler Versatz -> keine
        y: PIN_HOME[i].y + (rnd() * 2 - 1) * 0.9,   // sterile Symmetrie
        vx: 0, vy: 0, live: live, down: false, tilt: 0, fs: 1, gone: !live
      });
    }
    var ball = {
      x: LANE_CX + p.pos * POS_RANGE, y: START_Y,
      vx: (rnd() * 2 - 1) * 1.5,
      vy: -(SPEED_MIN + p.pow * (SPEED_MAX - SPEED_MIN)),
      gutter: false, gone: false
    };
    /* Kurze Kontaktzeit bei hohem Tempo: der Ball schiebt die Pins eher gerade
       nach hinten, statt sie breit zu mischen -> Volldampf verschenkt Eckpins. */
    var eBall = 0.92 - 0.32 * p.pow;
    var frames = record ? [] : null;
    var t = 0, MAXT = 6.5, travelLen = START_Y - HEAD_Y;
    var firstHit = -1, step = 0;

    while (t < MAXT) {
      /* --- Ball --- */
      if (!ball.gone) {
        if (!ball.gutter) {
          var tr = clamp((START_Y - ball.y) / travelLen, 0, 1.3);
          ball.vx += p.spin * HOOK_K * Math.pow(tr, 1.7) * DT;
        }
        ball.x += ball.vx * DT; ball.y += ball.vy * DT;
        if (!ball.gutter && ball.y > HEAD_Y + 70) {      // Rinne nur vor dem Pindeck
          if (ball.x < LANE_L + 12) { ball.gutter = true; ball.vx = 0; ball.x = LANE_L - 13; }
          else if (ball.x > LANE_R - 12) { ball.gutter = true; ball.vx = 0; ball.x = LANE_R + 13; }
        }
        if (ball.y < 30) ball.gone = true;
      }
      /* --- Ball gegen Pins --- */
      if (!ball.gone && !ball.gutter) {
        for (i = 0; i < 10; i++) {
          var pn = pins[i]; if (pn.gone) continue;
          var dx = pn.x - ball.x, dy = pn.y - ball.y;
          var d = Math.sqrt(dx * dx + dy * dy), rr = BALL_R + PIN_R;
          if (d > 0 && d < rr) {
            var nx = dx / d, ny = dy / d;
            var vn = (pn.vx - ball.vx) * nx + (pn.vy - ball.vy) * ny;
            if (vn < 0) {
              var jj = -(1 + eBall) * vn / (1 / MB + 1 / MP);
              ball.vx -= jj * nx / MB; ball.vy -= jj * ny / MB;
              pn.vx += jj * nx / MP; pn.vy += jj * ny / MP;
            }
            var ov = rr - d;
            ball.x -= nx * ov * 0.12; ball.y -= ny * ov * 0.12;
            pn.x += nx * ov * 0.88; pn.y += ny * ov * 0.88;
            if (!pn.down && Math.sqrt(pn.vx * pn.vx + pn.vy * pn.vy) > 18) {
              pn.down = true; pn.fs = pn.vx >= 0 ? 1 : -1;
              if (firstHit < 0) firstHit = step;
            }
          }
        }
      }
      /* --- Pins untereinander (liegende räumen mit größerem Radius mit) --- */
      for (i = 0; i < 10; i++) {
        var a = pins[i]; if (a.gone) continue;
        for (j = i + 1; j < 10; j++) {
          var b = pins[j]; if (b.gone) continue;
          if (a.vx === 0 && a.vy === 0 && b.vx === 0 && b.vy === 0) continue;
          var ddx = b.x - a.x, ddy = b.y - a.y;
          var dd = Math.sqrt(ddx * ddx + ddy * ddy);
          var r2 = PIN_R * ((a.down ? 1.35 : 1) + (b.down ? 1.35 : 1));
          if (dd > 0 && dd < r2) {
            var mx = ddx / dd, my = ddy / dd;
            var qn = (b.vx - a.vx) * mx + (b.vy - a.vy) * my;
            if (qn < 0) {
              var j2 = -(1 + 0.85) * qn / (2 / MP);
              a.vx -= j2 * mx / MP; a.vy -= j2 * my / MP;
              b.vx += j2 * mx / MP; b.vy += j2 * my / MP;
            }
            var ov2 = (r2 - dd) * 0.5;
            a.x -= mx * ov2; a.y -= my * ov2;
            b.x += mx * ov2; b.y += my * ov2;
            if (!a.down && Math.sqrt(a.vx * a.vx + a.vy * a.vy) > 18) { a.down = true; a.fs = a.vx >= 0 ? 1 : -1; }
            if (!b.down && Math.sqrt(b.vx * b.vx + b.vy * b.vy) > 18) { b.down = true; b.fs = b.vx >= 0 ? 1 : -1; }
          }
        }
      }
      /* --- Pin-Bewegung + Umfall-Animation --- */
      var moving = false;
      for (i = 0; i < 10; i++) {
        var q = pins[i]; if (q.gone) continue;
        if (q.vx !== 0 || q.vy !== 0) {
          q.x += q.vx * DT; q.y += q.vy * DT;
          var f = Math.exp(-(q.down ? 1.8 : 1.2) * DT);
          q.vx *= f; q.vy *= f;
          if (Math.abs(q.vx) < 2 && Math.abs(q.vy) < 2) { q.vx = 0; q.vy = 0; }
          else moving = true;
        }
        if (q.down && q.tilt < 1) { q.tilt = Math.min(1, q.tilt + DT / 0.22); moving = true; }
        if (q.y < 26 || q.x < 18 || q.x > 342) { q.gone = true; q.down = true; }
      }
      if (record) {
        var snap = { bx: ball.x, by: ball.y, bg: ball.gutter ? 1 : 0, bo: ball.gone ? 1 : 0, p: [] };
        for (i = 0; i < 10; i++) {
          snap.p.push({ x: pins[i].x, y: pins[i].y, t: pins[i].tilt, d: pins[i].down ? 1 : 0, g: pins[i].gone ? 1 : 0, f: pins[i].fs });
        }
        frames.push(snap);
      }
      t += DT; step++;
      if (ball.gone && !moving) break;
    }
    var rest = '', cnt = 0;
    for (i = 0; i < 10; i++) {
      if (pins[i].live && pins[i].down) cnt++;
      rest += (pins[i].live && !pins[i].down) ? '1' : '0';
    }
    return { standing: rest, count: cnt, frames: frames, gutter: ball.gutter, firstHit: firstHit };
  }

  /* Ziel-Linie für die Vorschau (ohne Pins), bis Anteil "upto" der Bahn. */
  function previewPath(p, upto) {
    var pts = [], x = LANE_CX + p.pos * POS_RANGE, y = START_Y, vx = 0;
    var vy = -(SPEED_MIN + p.pow * (SPEED_MAX - SPEED_MIN));
    var travelLen = START_Y - HEAD_Y, n = 0;
    while (y > START_Y - travelLen * upto && n < 1200) {
      vx += p.spin * HOOK_K * Math.pow(clamp((START_Y - y) / travelLen, 0, 1.3), 1.7) * DT;
      x += vx * DT; y += vy * DT;
      if (n % 6 === 0) pts.push({ x: x, y: y });
      n++;
    }
    return pts;
  }

  /* ===================== Bowling-Wertung ===================== */
  /* Würfe als String: '0'–'9' = Pins, 'X' = 10. Vermeidet leere Arrays
     (Firebase löscht die) und hält shared winzig. */
  function rollsToStr(a) {
    var s = '', i;
    for (i = 0; i < a.length; i++) s += (a[i] === 10 ? 'X' : String(a[i]));
    return s;
  }
  function strToRolls(s) {
    var a = [], i, c;
    s = s || '';
    for (i = 0; i < s.length; i++) { c = s.charAt(i); a.push(c === 'X' ? 10 : parseInt(c, 10)); }
    return a;
  }
  /* Kumulative Frame-Punkte + Gesamtstand (klassischer Algorithmus über die
     flache Wurfliste; unvollständige Frames bleiben ohne Zahl). */
  function scoreOf(rolls) {
    var res = { frames: [], total: 0 }, i = 0, total = 0, f, a, b, c;
    for (f = 0; f < 10; f++) {
      a = rolls[i];
      if (a === undefined) break;
      if (a === 10) {
        b = rolls[i + 1]; c = rolls[i + 2];
        if (b === undefined || c === undefined) break;
        total += 10 + b + c; i += 1;
      } else {
        b = rolls[i + 1];
        if (b === undefined) break;
        if (a + b === 10) {
          c = rolls[i + 2];
          if (c === undefined) break;
          total += 10 + c; i += 2;
        } else { total += a + b; i += 2; }
      }
      res.frames[f] = total;
    }
    res.total = total;
    return res;
  }
  function framesFromRolls(rolls) {
    var frames = [], i = 0, f;
    for (f = 0; f < 10 && i < rolls.length; f++) {
      if (f === 9) { frames.push(rolls.slice(i)); break; }
      if (rolls[i] === 10) { frames.push([10]); i += 1; }
      else { frames.push(rolls.slice(i, i + 2)); i += 2; }
    }
    return frames;
  }
  function completedFrames(rolls) {
    var i = 0, f, rest;
    for (f = 0; f < 10; f++) {
      if (f === 9) {
        rest = rolls.slice(i);
        if (rest.length >= 3) return 10;
        if (rest.length === 2 && rest[0] + rest[1] < 10) return 10;
        return 9;
      }
      if (rolls[i] === 10) i += 1;
      else if (rolls[i] !== undefined && rolls[i + 1] !== undefined) i += 2;
      else return f;
    }
    return 10;
  }
  function isDone(rolls) { return completedFrames(rolls) === 10; }
  /* Welche Pins stehen beim NÄCHSTEN Wurf? Neues Rack nach jedem fertigen
     Frame, im 10. Frame zusätzlich nach Strike und nach Spare. */
  function nextStanding(rolls, afterStanding) {
    var cf = completedFrames(rolls);
    if (cf === 10) return FULL;
    var cur = framesFromRolls(rolls)[cf] || [];
    if (cur.length === 0) return FULL;
    if (cf === 9) {
      if (cur.length === 1) return cur[0] === 10 ? FULL : afterStanding;
      if (cur.length === 2) {
        if (cur[0] === 10) return cur[1] === 10 ? FULL : afterStanding;
        return FULL;                              // Spare -> frisches Rack
      }
    }
    return afterStanding;
  }
  /* X / - / Ziffern für die Tabelle. Frames 1–9: Strike steht im rechten Kasten. */
  function marksFor(fr, tenth) {
    var m = [], i, v;
    for (i = 0; i < fr.length; i++) {
      v = fr[i];
      if (v === 10) m.push('X');
      else if (i > 0 && fr[i - 1] !== 10 && fr[i - 1] + v === 10) m.push('/');
      else m.push(v === 0 ? '-' : String(v));
    }
    if (!tenth) {
      if (fr.length === 1 && fr[0] === 10) return ['', 'X'];
      while (m.length < 2) m.push('');
      return m.slice(0, 2);
    }
    while (m.length < 3) m.push('');
    return m.slice(0, 3);
  }
  /* Wer wirft als Nächstes? Derselbe Spieler, solange sein Frame läuft; sonst
     reihum der nächste anwesende, der noch nicht durch ist. null = Spiel aus. */
  function nextTurnId(order, rollsMap, curId, present) {
    var curRolls = strToRolls(rollsMap[curId] || '');
    var cf = completedFrames(curRolls);
    var frs = framesFromRolls(curRolls);
    if (cf < 10 && frs[cf] && frs[cf].length > 0 && present.indexOf(curId) >= 0) return curId;
    var i = order.indexOf(curId), k, id;
    if (i < 0) i = 0;
    for (k = 1; k <= order.length; k++) {
      id = order[(i + k) % order.length];
      if (present.indexOf(id) < 0) continue;
      if (!isDone(strToRolls(rollsMap[id] || ''))) return id;
    }
    return null;
  }
  function throwLabel(count, before, rolls) {
    var frs = framesFromRolls(rolls), cf = completedFrames(rolls);
    var idx = Math.min(9, cf < 10 && frs[cf] && frs[cf].length ? cf : Math.max(0, frs.length - 1));
    var fr = frs[idx] || [];
    var last = fr.length - 1;
    if (count === 10 && before === FULL) return { t: 'STRIKE!', c: 'strike' };
    if (last > 0 && fr[last - 1] !== 10 && fr[last - 1] + fr[last] === 10) return { t: 'SPARE!', c: 'spare' };
    if (count === 0) return { t: 'Nichts getroffen', c: 'miss' };
    return { t: count + (count === 1 ? ' Pin' : ' Pins'), c: 'ok' };
  }

  /* ===================== Bots =====================
   * Erstball: offline eingemessene, gegen Rauschen robuste Pocket-Linie
   * (Rechts- bzw. Linkshänder gespiegelt). Spare: grobe Gittersuche + zwei
   * Verfeinerungsrunden (~140 Sims, ~16 ms). Danach kommt das Rauschen der
   * Spielstärke drauf -> die Bots verfehlen realistisch statt dumm. */
  var LINE_R = { pos: 0.50, spin: -0.625, pow: 0.85 };
  var LINE_L = { pos: -0.50, spin: 0.625, pow: 0.85 };
  var SKILL = {
    leicht: { pos: 0.34, spin: 0.30, pow: 0.17, think: [700, 1100] },
    mittel: { pos: 0.17, spin: 0.15, pow: 0.09, think: [650, 1000] },
    schwer: { pos: 0.075, spin: 0.065, pow: 0.04, think: [550, 900] }
  };
  var SKILL_LABEL = { leicht: 'Leicht', mittel: 'Mittel', schwer: 'Legende' };

  function evalAim(pos, spin, pow, standing, seeds) {
    var sum = 0, k;
    for (k = 0; k < seeds.length; k++) sum += simulate({ pos: pos, pow: pow, spin: spin, seed: seeds[k] }, standing, false).count;
    return sum / seeds.length;
  }
  function searchBest(standing, seeds) {
    var best = null, pows = [0.6, 0.75], pi, si, wi, pos, spin, avg, round, cur;
    for (pi = -8; pi <= 8; pi += 2) {
      for (si = -6; si <= 6; si += 2) {
        for (wi = 0; wi < pows.length; wi++) {
          pos = pi / 10; spin = si / 6;
          avg = evalAim(pos, spin, pows[wi], standing, seeds);
          if (!best || avg > best.avg) best = { pos: pos, spin: spin, pow: pows[wi], avg: avg };
        }
      }
    }
    var stepP = 0.1, stepS = 0.11;
    for (round = 0; round < 2; round++) {
      cur = best;
      for (pi = -1; pi <= 1; pi++) {
        for (si = -1; si <= 1; si++) {
          if (pi === 0 && si === 0) continue;
          pos = clamp(cur.pos + pi * stepP, -1, 1);
          spin = clamp(cur.spin + si * stepS, -1, 1);
          avg = evalAim(pos, spin, cur.pow, standing, seeds);
          if (avg > best.avg) best = { pos: pos, spin: spin, pow: cur.pow, avg: avg };
        }
      }
      stepP *= 0.5; stepS *= 0.5;
    }
    return best;
  }
  function botThrow(standing, level, lefty) {
    var aim = (standing === FULL) ? (lefty ? LINE_L : LINE_R) : searchBest(standing, [7]);
    var s = SKILL[level] || SKILL.mittel;
    var rnd = rng((Math.random() * 1e9) | 0);
    return {
      pos: clamp(aim.pos + gauss(rnd) * s.pos, -1, 1),
      spin: clamp(aim.spin + gauss(rnd) * s.spin, -1, 1),
      pow: clamp(aim.pow + gauss(rnd) * s.pow, 0, 1),
      seed: (Math.random() * 1e9) | 0
    };
  }

  /* ===================== Balken-Mechanik ===================== */
  var STEPS = [
    { key: 'pos', label: '1 · Position', period: 1250 },
    { key: 'pow', label: '2 · Kraft', period: 950 },
    { key: 'spin', label: '3 · Effet', period: 1150 }
  ];
  function barValue(now, startAt, period) {
    var t = ((now - startAt) % period) / period;
    return t < 0.5 ? t * 2 : 2 - t * 2;          // Dreieck 0->1->0
  }
  function stepText(key, v) {
    if (key === 'pos') {
      var d = Math.round(Math.abs(v * 2 - 1) * 100);
      if (d < 6) return 'Mitte';
      return (v < 0.5 ? 'Links ' : 'Rechts ') + d + ' %';
    }
    if (key === 'pow') return Math.round(v * 100) + ' %';
    var s = Math.round(Math.abs(v * 2 - 1) * 100);
    if (s < 6) return 'gerade';
    return (v < 0.5 ? '◀ ' + s + ' %' : s + ' % ▶');
  }
  function paramsOf(vals) {
    return { pos: vals[0] * 2 - 1, pow: vals[1], spin: vals[2] * 2 - 1 };
  }

  App.Minigames.bowling = {
    id: 'bowling', title: 'Bowling', icon: '🎳', order: 125,
    subtitle: 'Ziel, Kraft, Effet — alle zehn auf einmal!',
    single: true, multi: true, minPlayers: 2, maxPlayers: 6,

    render: function (root, ctx) {
      var isMulti = ctx.mode === 'multi';
      var dead = false, stops = [], timers = [], raf = null;

      function after(ms, fn) { var t = setTimeout(function () { if (!dead) fn(); }, ms); timers.push(t); return t; }
      function clearTimers() { timers.forEach(clearTimeout); timers = []; }
      function stopAll() { stops.forEach(function (f) { try { f(); } catch (e) {} }); stops = []; }
      function cleanup() {
        dead = true;
        if (raf) { cancelAnimationFrame(raf); raf = null; }
        clearTimers(); stopAll();
      }
      function sfx(n) { if (App.Audio) App.Audio.sfx(n); }

      if (isMulti) startMulti(); else showSetup();
      return { cleanup: cleanup };

      /* =========================================================
       *  Bühne (für Solo und Multi identisch)
       * ========================================================= */
      function buildStage(onStop) {
        var canvas = el('canvas', { class: 'bwl-canvas', width: CW, height: CH });
        var flash = el('div', { class: 'bwl-flash' });
        var stage = el('div', { class: 'bwl-stage' }, [canvas, flash]);

        var whoEl = el('div', { class: 'bwl-who' }, ['—']);
        var frameEl = el('div', { class: 'bwl-frameno' }, ['Frame 1']);
        var top = el('div', { class: 'bwl-top glass' }, [whoEl, frameEl]);

        var statusEl = el('div', { class: 'bwl-status' }, ['']);

        var stepEls = [];
        var stepsWrap = el('div', { class: 'bwl-steps' }, STEPS.map(function (s, i) {
          var vEl = el('span', { class: 'bwl-step-v' }, ['–']);
          var marker = el('div', { class: 'bwl-marker' });
          var lockEl = el('div', { class: 'bwl-lockmark' });
          var bar = el('div', { class: 'bwl-bar bwl-bar-' + s.key, onpointerdown: function (e) { e.preventDefault(); onStop(); } }, [
            el('div', { class: 'bwl-bar-mid' }), lockEl, marker
          ]);
          var box = el('div', { class: 'bwl-step' }, [
            el('div', { class: 'bwl-step-l' }, [el('span', {}, [s.label]), vEl]), bar
          ]);
          stepEls.push({ box: box, marker: marker, lock: lockEl, v: vEl });
          return box;
        }));

        var stopBtn = el('button', { class: 'btn btn-primary bwl-stop', type: 'button', onclick: function () { onStop(); } }, ['STOPP']);
        var panel = el('div', { class: 'bwl-panel glass' }, [stepsWrap, stopBtn]);

        var sheet = el('div', { class: 'bwl-sheet glass' });
        var hint = el('p', { class: 'hint-text bwl-hint' }, [
          'Dreimal STOPP (oder Leertaste): Position → Kraft → Effet. Volle Kraft rauscht durch — ~80 % mit Effet räumt ab. 10 Frames, Strike/Spare zählen doppelt.'
        ]);

        var wrap = el('div', { class: 'bwl-wrap' }, [top, stage, statusEl, panel, sheet, hint]);
        root.innerHTML = ''; root.appendChild(wrap);

        return {
          canvas: canvas, g: canvas.getContext('2d'), flash: flash, who: whoEl,
          frame: frameEl, status: statusEl, steps: stepEls, panel: panel,
          stopBtn: stopBtn, sheet: sheet
        };
      }

      /* =========================================================
       *  Spiel-Engine: Zeichnen, Balken, Wurf-Animation
       * ========================================================= */
      function makeEngine(refs, hooks) {
        /* view: 'aim' | 'wait' | 'roll' | 'over' */
        var view = 'wait';
        var standing = FULL;                 // aktuell stehende Pins
        var vals = [0, 0, 0], stepIdx = 0, barStart = 0, locked = [false, false, false];
        var anim = null, trail = [];
        var flashT = null;

        function setStanding(s) { standing = s; }
        function getView() { return view; }

        /* ---- Balken ---- */
        function arm() {
          view = 'aim';
          stepIdx = 0; locked = [false, false, false]; vals = [0.5, 0, 0.5];
          barStart = Date.now();
          refs.panel.classList.add('is-live');
          refs.stopBtn.disabled = false;
          refs.stopBtn.textContent = 'STOPP';
          refs.steps.forEach(function (s, i) {
            s.box.classList.toggle('is-active', i === 0);
            s.box.classList.remove('is-locked');
            s.lock.style.display = 'none';
            s.v.textContent = '–';
          });
        }
        function disarm() {
          refs.panel.classList.remove('is-live');
          refs.stopBtn.disabled = true;
          refs.steps.forEach(function (s) { s.box.classList.remove('is-active'); });
        }
        function stopStep() {
          if (view !== 'aim' || dead) return;
          var s = STEPS[stepIdx];
          var v = barValue(Date.now(), barStart, s.period);
          vals[stepIdx] = v;
          locked[stepIdx] = true;
          var r = refs.steps[stepIdx];
          r.box.classList.remove('is-active');
          r.box.classList.add('is-locked');
          r.lock.style.display = 'block';
          r.lock.style.left = (v * 100) + '%';
          r.v.textContent = stepText(s.key, v);
          sfx(stepIdx === 2 ? 'select' : 'click');
          stepIdx++;
          if (stepIdx < 3) {
            barStart = Date.now();
            refs.steps[stepIdx].box.classList.add('is-active');
          } else {
            disarm();
            view = 'wait';
            var p = paramsOf(vals);
            p.seed = (Math.random() * 1e9) | 0;
            sfx('whoosh');
            hooks.onThrow(p);
          }
        }

        /* ---- Wurf abspielen ---- */
        function playThrow(params, before, onDone) {
          var sim = simulate(params, before, true);
          anim = {
            frames: sim.frames, startAt: Date.now(), sim: sim, before: before,
            hitDone: sim.firstHit < 0, onDone: onDone, endAt: 0
          };
          trail = [];
          view = 'roll';
          disarm();
          sfx('roll');
          return sim;
        }

        function showFlash(text, cls) {
          refs.flash.textContent = text;
          refs.flash.className = 'bwl-flash is-on bwl-flash-' + cls;
          if (flashT) clearTimeout(flashT);
          flashT = setTimeout(function () { if (!dead) refs.flash.className = 'bwl-flash'; }, 1400);
          timers.push(flashT);
        }

        /* ---- Bild ---- */
        function draw() {
          var g = refs.g, i;
          g.clearRect(0, 0, CW, CH);

          /* Hintergrund + Grube */
          g.fillStyle = '#03100a'; g.fillRect(0, 0, CW, CH);
          var pit = pY(HEAD_Y - 3.6 * ROW);
          var pg = g.createLinearGradient(0, 0, 0, pit);
          pg.addColorStop(0, '#020a06'); pg.addColorStop(1, '#07231a');
          g.fillStyle = pg; g.fillRect(0, 0, CW, pit);

          /* Rinnen */
          drawStrip(g, LANE_L - 26, LANE_L, '#04170f', '#0a2f20');
          drawStrip(g, LANE_R, LANE_R + 26, '#04170f', '#0a2f20');

          /* Bahn */
          g.beginPath();
          g.moveTo(pX(LANE_L, 0), pY(0));
          g.lineTo(pX(LANE_R, 0), pY(0));
          g.lineTo(pX(LANE_R, VH), pY(VH));
          g.lineTo(pX(LANE_L, VH), pY(VH));
          g.closePath();
          var lg = g.createLinearGradient(0, pY(VH), 0, pY(0));
          lg.addColorStop(0, '#123b28'); lg.addColorStop(0.6, '#0c2c1d'); lg.addColorStop(1, '#092316');
          g.fillStyle = lg; g.fill();
          g.strokeStyle = 'rgba(57,255,20,.4)'; g.lineWidth = 1.5; g.stroke();

          /* Bahn-Bretter */
          g.save(); g.clip();
          g.strokeStyle = 'rgba(157,255,122,.07)'; g.lineWidth = 1;
          for (i = 1; i < 8; i++) {
            var bx = LANE_L + (LANE_R - LANE_L) * i / 8;
            g.beginPath(); g.moveTo(pX(bx, 0), pY(0)); g.lineTo(pX(bx, VH), pY(VH)); g.stroke();
          }
          g.restore();

          /* Ziel-Pfeile */
          g.fillStyle = 'rgba(255,210,63,.5)';
          for (i = -3; i <= 3; i++) {
            var ax = LANE_CX + i * 26, ay = 560 + Math.abs(i) * 26;
            var s = sOf(ay) * XK;
            g.beginPath();
            g.moveTo(pX(ax, ay), pY(ay) - 7 * s);
            g.lineTo(pX(ax, ay) + 4 * s, pY(ay) + 4 * s);
            g.lineTo(pX(ax, ay) - 4 * s, pY(ay) + 4 * s);
            g.closePath(); g.fill();
          }
          /* Foul-Linie */
          g.strokeStyle = 'rgba(255,77,109,.55)'; g.lineWidth = 2;
          g.beginPath(); g.moveTo(pX(LANE_L, FOUL_Y), pY(FOUL_Y)); g.lineTo(pX(LANE_R, FOUL_Y), pY(FOUL_Y)); g.stroke();

          /* Ziel-Vorschau beim Zielen */
          if (view === 'aim') {
            var live = vals.slice();
            var now = Date.now();
            if (!locked[stepIdx]) live[stepIdx] = barValue(now, barStart, STEPS[stepIdx].period);
            var pp = paramsOf(live);
            var upto = stepIdx === 0 ? 0.34 : (stepIdx === 1 ? 0.42 : 0.56);
            drawGuide(g, previewPath(pp, upto));
            drawBall(g, LANE_CX + pp.pos * POS_RANGE, START_Y, false);
          }

          /* Pins + Ball nach Tiefe sortiert (fern zuerst) */
          var items = [];
          var fr = anim ? anim.frames[Math.min(anim.idx || 0, anim.frames.length - 1)] : null;
          for (i = 0; i < 10; i++) {
            if (fr) {
              var q = fr.p[i];
              if (q.g) continue;
              items.push({ y: q.y, kind: 'pin', x: q.x, tilt: q.t, down: q.d, fs: q.f });
            } else if (standing.charAt(i) === '1') {
              items.push({ y: PIN_HOME[i].y, kind: 'pin', x: PIN_HOME[i].x, tilt: 0, down: 0, fs: 1 });
            }
          }
          if (fr && !fr.bo) items.push({ y: fr.by, kind: 'ball', x: fr.bx, gutter: fr.bg });
          items.sort(function (a, b) { return a.y - b.y; });

          if (trail.length > 1) {
            g.strokeStyle = 'rgba(51,230,208,.28)'; g.lineWidth = 3; g.lineCap = 'round';
            g.beginPath();
            for (i = 0; i < trail.length; i++) {
              var tp = trail[i];
              if (i === 0) g.moveTo(pX(tp.x, tp.y), pY(tp.y)); else g.lineTo(pX(tp.x, tp.y), pY(tp.y));
            }
            g.stroke();
          }
          for (i = 0; i < items.length; i++) {
            if (items[i].kind === 'pin') drawPin(g, items[i]);
            else drawBall(g, items[i].x, items[i].y, items[i].gutter);
          }
        }

        function drawStrip(g, x0, x1, c0, c1) {
          g.beginPath();
          g.moveTo(pX(x0, 0), pY(0)); g.lineTo(pX(x1, 0), pY(0));
          g.lineTo(pX(x1, VH), pY(VH)); g.lineTo(pX(x0, VH), pY(VH));
          g.closePath();
          var sg = g.createLinearGradient(0, pY(VH), 0, pY(0));
          sg.addColorStop(0, c1); sg.addColorStop(1, c0);
          g.fillStyle = sg; g.fill();
        }
        function drawGuide(g, pts) {
          if (!pts.length) return;
          g.save();
          g.setLineDash([6, 6]); g.lineWidth = 2;
          var grd = g.createLinearGradient(0, pY(START_Y), 0, pY(pts[pts.length - 1].y));
          grd.addColorStop(0, 'rgba(255,210,63,.75)'); grd.addColorStop(1, 'rgba(255,210,63,0)');
          g.strokeStyle = grd;
          g.beginPath();
          for (var i = 0; i < pts.length; i++) {
            if (i === 0) g.moveTo(pX(pts[i].x, pts[i].y), pY(pts[i].y));
            else g.lineTo(pX(pts[i].x, pts[i].y), pY(pts[i].y));
          }
          g.stroke(); g.restore();
        }
        function drawBall(g, x, y, gutter) {
          var s = sOf(y) * XK, r = BALL_R * s;
          var sx = pX(x, y), sy = pY(y);
          g.save();
          g.beginPath(); g.ellipse(sx, sy + r * 0.5, r * 1.05, r * 0.42, 0, 0, Math.PI * 2);
          g.fillStyle = 'rgba(0,0,0,.42)'; g.fill();
          var rg = g.createRadialGradient(sx - r * 0.33, sy - r * 0.36, r * 0.12, sx, sy, r);
          if (gutter) { rg.addColorStop(0, '#7ba692'); rg.addColorStop(1, '#233b31'); }
          else { rg.addColorStop(0, '#7ff3e6'); rg.addColorStop(0.55, '#33e6d0'); rg.addColorStop(1, '#0b5f57'); }
          g.beginPath(); g.arc(sx, sy, r, 0, Math.PI * 2);
          g.fillStyle = rg; g.fill();
          if (!gutter) {
            g.strokeStyle = 'rgba(127,243,230,.85)'; g.lineWidth = 1.4; g.stroke();
            g.beginPath(); g.arc(sx - r * 0.3, sy - r * 0.34, r * 0.2, 0, Math.PI * 2);
            g.fillStyle = 'rgba(255,255,255,.6)'; g.fill();
          }
          g.restore();
        }
        function drawPin(g, it) {
          var s = sOf(it.y) * XK;
          var sx = pX(it.x, it.y), sy = pY(it.y);
          var w = PIN_R * 2 * s, h = PIN_R * 2.3 * s;
          g.save();
          g.beginPath(); g.ellipse(sx, sy, w * 0.6, w * 0.26, 0, 0, Math.PI * 2);
          g.fillStyle = 'rgba(0,0,0,.4)'; g.fill();
          g.translate(sx, sy);
          g.rotate(it.fs * 1.35 * it.tilt);
          g.scale(1, 1 - 0.45 * it.tilt);          // Verkürzung beim Kippen
          g.beginPath();
          g.moveTo(-w * 0.42, 0);
          g.bezierCurveTo(-w * 0.5, -h * 0.34, -w * 0.2, -h * 0.4, -w * 0.19, -h * 0.56);
          g.bezierCurveTo(-w * 0.19, -h * 0.78, -w * 0.34, -h * 0.8, 0, -h);
          g.bezierCurveTo(w * 0.34, -h * 0.8, w * 0.19, -h * 0.78, w * 0.19, -h * 0.56);
          g.bezierCurveTo(w * 0.2, -h * 0.4, w * 0.5, -h * 0.34, w * 0.42, 0);
          g.closePath();
          var pgd = g.createLinearGradient(-w * 0.42, 0, w * 0.42, 0);
          pgd.addColorStop(0, it.down ? '#8fa79c' : '#cfe4dc');
          pgd.addColorStop(0.45, it.down ? '#dcefe6' : '#ffffff');
          pgd.addColorStop(1, it.down ? '#6d8579' : '#9dbcae');
          g.fillStyle = pgd; g.fill();
          g.strokeStyle = it.down ? 'rgba(120,150,135,.8)' : 'rgba(57,255,20,.55)';
          g.lineWidth = 1; g.stroke();
          g.fillStyle = it.down ? 'rgba(255,77,109,.35)' : 'rgba(255,77,109,.85)';
          g.fillRect(-w * 0.2, -h * 0.66, w * 0.4, h * 0.07);
          g.fillRect(-w * 0.21, -h * 0.54, w * 0.42, h * 0.06);
          g.restore();
        }

        /* ---- Schleife (Wall-Clock, tab-sicher) ---- */
        function loop() {
          if (dead) { raf = null; return; }
          if (anim) {
            var elp = Date.now() - anim.startAt;
            var idx = Math.floor(elp / (DT * 1000));
            if (idx >= anim.frames.length) {
              anim.idx = anim.frames.length - 1;
              if (!anim.endAt) anim.endAt = Date.now();
              if (Date.now() - anim.endAt > 850) {
                var done = anim.onDone, sim = anim.sim;
                anim = null; trail = [];
                view = 'wait';
                done(sim);
              }
            } else {
              anim.idx = idx;
              if (!anim.hitDone && idx >= anim.sim.firstHit) { anim.hitDone = true; sfx('hit'); }
              var f = anim.frames[idx];
              if (!f.bo) {
                trail.push({ x: f.bx, y: f.by });
                if (trail.length > 26) trail.shift();
              } else if (trail.length) trail.shift();
            }
          }
          draw();
          raf = requestAnimationFrame(loop);
        }
        raf = requestAnimationFrame(loop);

        function keyHandler(e) {
          if (e.code === 'Space' || e.key === ' ') { e.preventDefault(); stopStep(); }
        }
        document.addEventListener('keydown', keyHandler);
        stops.push(function () { document.removeEventListener('keydown', keyHandler); });

        return {
          arm: arm, disarm: disarm, stopStep: stopStep, playThrow: playThrow,
          setStanding: setStanding, getView: getView, showFlash: showFlash
        };
      }

      /* =========================================================
       *  Spielstandtabelle im Bowling-Layout
       * ========================================================= */
      function renderSheet(host, plist, rollsMap, turnId) {
        var head = [el('div', { class: 'bwl-cell-name bwl-h' }, ['Frame'])];
        for (var f = 1; f <= 10; f++) head.push(el('div', { class: 'bwl-fr bwl-h' + (f === 10 ? ' bwl-fr10' : '') }, [String(f)]));
        head.push(el('div', { class: 'bwl-tot bwl-h' }, ['Ges']));
        var rows = [el('div', { class: 'bwl-row' }, head)];

        plist.forEach(function (p) {
          var rolls = strToRolls(rollsMap[p.id] || '');
          var sc = scoreOf(rolls), frs = framesFromRolls(rolls), cf = completedFrames(rolls);
          var cells = [el('div', { class: 'bwl-cell-name' }, [p.name])];
          for (var i = 0; i < 10; i++) {
            var fr = frs[i] || [];
            var marks = marksFor(fr, i === 9);
            var boxes = marks.map(function (m) {
              return el('span', { class: 'bwl-bx' + (m === 'X' ? ' is-x' : m === '/' ? ' is-sp' : '') }, [m]);
            });
            var isCur = p.id === turnId && i === Math.min(9, cf);
            cells.push(el('div', { class: 'bwl-fr' + (i === 9 ? ' bwl-fr10' : '') + (isCur ? ' is-cur' : '') }, [
              el('div', { class: 'bwl-boxes' }, boxes),
              el('div', { class: 'bwl-fscore' }, [sc.frames[i] !== undefined ? String(sc.frames[i]) : ''])
            ]));
          }
          cells.push(el('div', { class: 'bwl-tot' }, [String(sc.total)]));
          rows.push(el('div', { class: 'bwl-row' + (p.id === turnId ? ' is-turn' : '') + (p.me ? ' is-me' : '') }, cells));
        });
        host.innerHTML = '';
        host.appendChild(el('div', { class: 'bwl-sheet-scroll' }, rows));
      }

      /* =========================================================
       *  SOLO — Auswahl, dann gegen Bots
       * ========================================================= */
      function showSetup() {
        var botCount = 1, level = 'mittel';
        var countRow = el('div', { class: 'bwl-chips' });
        var lvlRow = el('div', { class: 'bwl-chips' });

        function build() {
          countRow.innerHTML = ''; lvlRow.innerHTML = '';
          [1, 2, 3].forEach(function (n) {
            countRow.appendChild(el('button', {
              class: 'chip bwl-chip' + (n === botCount ? ' is-on' : ''), type: 'button',
              onclick: function () { botCount = n; sfx('click'); build(); }
            }, [n + (n === 1 ? ' Bot' : ' Bots')]));
          });
          ['leicht', 'mittel', 'schwer'].forEach(function (k) {
            lvlRow.appendChild(el('button', {
              class: 'chip bwl-chip' + (k === level ? ' is-on' : ''), type: 'button',
              onclick: function () { level = k; sfx('click'); build(); }
            }, [SKILL_LABEL[k]]));
          });
        }
        build();

        root.innerHTML = '';
        root.appendChild(el('div', { class: 'bwl-setup glass' }, [
          el('div', { class: 'bwl-setup-icon' }, ['🎳']),
          el('h2', { class: 'neon' }, ['Bowling']),
          el('p', { class: 'hint-text' }, ['Zehn Frames, echte Wertung, maximal 300. Stopp die drei Balken — Position, Kraft, Effet.']),
          el('div', { class: 'mg-field-title' }, ['Gegner']), countRow,
          el('div', { class: 'mg-field-title' }, ['Spielstärke']), lvlRow,
          el('div', { class: 'controls-row' }, [
            el('button', { class: 'btn btn-primary btn-lg', type: 'button', onclick: function () { sfx('start'); startSolo(botCount, level); } }, ['Los geht\'s']),
            el('button', { class: 'btn btn-ghost', type: 'button', onclick: ctx.onExit }, ['Zurück'])
          ])
        ]));
      }

      function startSolo(botCount, level) {
        clearTimers();
        if (raf) { cancelAnimationFrame(raf); raf = null; }
        stopAll();

        var NAMES = ['Bot Kiwi', 'Bot Mango', 'Bot Papaya'];
        var plist = [{ id: 'me', name: (ctx.me && ctx.me.name) || 'Du', bot: false, me: true }];
        for (var i = 0; i < botCount; i++) {
          plist.push({ id: 'b' + i, name: NAMES[i], bot: true, lefty: i % 2 === 1, me: false });
        }
        var order = plist.map(function (p) { return p.id; });
        var present = order.slice();
        var rollsMap = {};
        order.forEach(function (id) { rollsMap[id] = ''; });
        var standing = FULL, turn = order[0], over = false;

        var refs = buildStage(function () { eng.stopStep(); });
        var eng = makeEngine(refs, { onThrow: onThrow });

        paint(); nextUp();

        function pOf(id) { for (var k = 0; k < plist.length; k++) if (plist[k].id === id) return plist[k]; return null; }

        function paint() {
          var p = pOf(turn);
          var cf = completedFrames(strToRolls(rollsMap[turn] || ''));
          refs.who.textContent = over ? 'Spiel vorbei' : (p ? (p.me ? 'Du bist dran' : p.name + ' wirft') : '');
          refs.who.className = 'bwl-who' + (p && p.me && !over ? ' is-me' : '');
          refs.frame.textContent = 'Frame ' + Math.min(10, cf + 1) + ' / 10';
          eng.setStanding(standing);
          renderSheet(refs.sheet, plist, rollsMap, over ? null : turn);
        }

        function nextUp() {
          if (dead || over) return;
          var p = pOf(turn);
          if (!p) return;
          if (p.bot) {
            var th = SKILL[level].think;
            refs.status.textContent = p.name + ' zielt …';
            refs.status.className = 'bwl-status is-wait';
            after(th[0] + Math.random() * (th[1] - th[0]), function () {
              if (dead || over) return;
              onThrow(botThrow(standing, level, p.lefty));
            });
          } else {
            refs.status.textContent = 'Stopp die Balken: Position → Kraft → Effet';
            refs.status.className = 'bwl-status is-me';
            eng.arm();
          }
        }

        function onThrow(params) {
          if (dead || over) return;
          var before = standing;
          var sim = eng.playThrow(params, before, function (s) { finishThrow(params, before, s); });
          refs.status.textContent = sim.gutter ? 'In die Rinne …' : 'Der Ball rollt …';
          refs.status.className = 'bwl-status is-wait';
        }

        function finishThrow(params, before, sim) {
          if (dead) return;
          var thrower = turn;
          var rolls = strToRolls(rollsMap[thrower] || '');
          rolls.push(sim.count);
          rollsMap[thrower] = rollsToStr(rolls);
          standing = nextStanding(rolls, sim.standing);
          var lab = throwLabel(sim.count, before, rolls);
          if (sim.gutter && sim.count === 0) { lab = { t: 'RINNE!', c: 'miss' }; }
          eng.showFlash(lab.t, lab.c);
          refs.status.textContent = (pOf(thrower).me ? 'Du' : pOf(thrower).name) + ': ' + lab.t;
          refs.status.className = 'bwl-status is-' + lab.c;
          sfx(lab.c === 'strike' ? 'jackpot' : lab.c === 'spare' ? 'ding' : lab.c === 'miss' ? 'error' : 'point');

          var next = nextTurnId(order, rollsMap, thrower, present);
          if (next === null) { over = true; paint(); after(1200, soloEnd); return; }
          turn = next;
          paint();
          after(900, nextUp);
        }

        function soloEnd() {
          if (dead) return;
          if (raf) { cancelAnimationFrame(raf); raf = null; }   // Zeichen-Schleife stoppen (wie im Multi-finish)
          var myTotal = scoreOf(strToRolls(rollsMap.me || '')).total;
          var ranked = plist.slice().sort(function (a, b) {
            return scoreOf(strToRolls(rollsMap[b.id] || '')).total - scoreOf(strToRolls(rollsMap[a.id] || '')).total;
          });
          if (ranked[0] && ranked[0].id === 'me' && App.Scores) App.Scores.winCurrent();
          var best = App.Storage.get('best_bowling', 0);
          var nb = myTotal > best;
          if (nb) App.Storage.set('best_bowling', myTotal);
          var lines = ranked.map(function (p, i) {
            return (i + 1) + '. ' + p.name + ' — ' + scoreOf(strToRolls(rollsMap[p.id] || '')).total;
          }).join('   ·   ');
          App.MG.endScreen(root, {
            score: myTotal, best: best, newBest: nb,
            title: ranked[0] && ranked[0].id === 'me' ? '🏆 Gewonnen!' : '🎳 Spiel vorbei',
            label: lines + (nb ? ' · neuer Rekord! 🎉' : ' · Bestwert: ' + best),
            onExit: ctx.onExit,
            onAgain: function () { showSetup(); }
          });
        }
      }

      /* =========================================================
       *  MULTI — reihum über room.shared
       * ========================================================= */
      function startMulti() {
        var room = ctx.room, me = ctx.me;
        var started = false;

        function maybeStart() {
          if (started || dead) return;
          if (room.players().length < (App.Minigames.bowling.minPlayers || 2)) { showWaiting(); return; }
          started = true;
          var snap = room.snapshot() || {};
          var startAt = (snap.round && snap.round.startAt) || (room.now() + 3000);
          stops.push(App.MG.countdown(root, startAt, function () { playMulti(); }, room.now));
        }
        var ph = function () { maybeStart(); };
        room.on('players', ph);
        stops.push(function () { room.off('players', ph); });
        maybeStart();

        function showWaiting() {
          root.innerHTML = '';
          root.appendChild(el('div', { class: 'bwl-setup glass' }, [
            el('div', { class: 'bwl-setup-icon' }, ['🎳']),
            el('h2', { class: 'neon' }, ['Bowling']),
            el('p', { class: 'hint-text' }, ['Warte auf Mitspieler …']),
            el('div', { class: 'controls-row' }, [
              el('button', { class: 'btn btn-ghost', type: 'button', onclick: ctx.onExit }, ['Zurück zur Lobby'])
            ])
          ]));
        }

        function playMulti() {
          var refs = buildStage(function () { eng.stopStep(); });
          var eng = makeEngine(refs, { onThrow: onThrow });

          var lastShared = (room.snapshot() && room.snapshot().shared) || null;
          var lastSeq = -1, firstSync = true, sig = '', armedSeq = -1, ended = false;

          function present() { return room.players().map(function (p) { return p.id; }); }
          function orderOf(sh) { return (sh && sh.order ? String(sh.order).split(',') : []).filter(function (x) { return !!x; }); }
          function nameOf(id) {
            var ps = room.players();
            for (var i = 0; i < ps.length; i++) if (ps[i].id === id) return ps[i].name;
            return 'Spieler';
          }

          function initShared() {
            var ids = present();
            var rl = {};
            ids.forEach(function (id) { rl[id] = ''; });
            room.setShared({
              order: ids.join(','), turn: ids[0], rolls: rl, standing: FULL,
              seq: 0, thr: null, over: false
            });
          }

          var onSharedH = function (sh) {
            if (dead || ended) return;
            lastShared = sh;
            if (!sh || !sh.order) {
              if (room.isHost()) initShared();
              return;
            }
            /* Neuer Wurf -> bei allen identisch animieren (idempotent über seq) */
            var seq = sh.seq || 0;
            if (firstSync) { firstSync = false; lastSeq = seq; sync(); return; }
            if (sh.thr && seq > lastSeq) {
              lastSeq = seq;
              var t = sh.thr;
              eng.playThrow({ pos: t.pos, pow: t.pow, spin: t.spin, seed: t.seed }, t.st, function (sim) {
                if (dead || ended) return;
                showResult(t, sim);
                sync();
              });
              refs.status.textContent = (t.by === me.id ? 'Dein Ball rollt …' : nameOf(t.by) + ' wirft …');
              refs.status.className = 'bwl-status is-wait';
              return;
            }
            if (eng.getView() !== 'roll') sync();
          };
          var onPlayersH = function () {
            if (dead || ended || !lastShared || !lastShared.order) return;
            /* Host: hängengebliebenen Zug eines weggegangenen Spielers weiterschalten */
            if (room.isHost() && !lastShared.over && eng.getView() !== 'roll') {
              var pr = present();
              if (pr.indexOf(lastShared.turn) < 0) {
                var nx = nextTurnId(orderOf(lastShared), lastShared.rolls || {}, lastShared.turn, pr);
                if (nx) room.setShared({ turn: nx, standing: FULL });
                else room.setShared({ over: true });
                return;
              }
            }
            if (eng.getView() !== 'roll') sync();
          };
          room.on('shared', onSharedH);
          room.on('players', onPlayersH);
          stops.push(function () { room.off('shared', onSharedH); room.off('players', onPlayersH); });

          if (room.isHost() && (!lastShared || !lastShared.order)) initShared();
          room.reportScore(0);
          sync();

          function showResult(t, sim) {
            var rolls = strToRolls((lastShared.rolls && lastShared.rolls[t.by]) || '');
            var lab = throwLabel(sim.count, t.st, rolls);
            if (sim.gutter && sim.count === 0) lab = { t: 'RINNE!', c: 'miss' };
            eng.showFlash(lab.t, lab.c);
            refs.status.textContent = (t.by === me.id ? 'Du' : nameOf(t.by)) + ': ' + lab.t;
            refs.status.className = 'bwl-status is-' + lab.c;
            sfx(lab.c === 'strike' ? 'jackpot' : lab.c === 'spare' ? 'ding' : lab.c === 'miss' ? 'error' : 'point');
          }

          /* Aus shared rendern. Läuft bei JEDEM Heartbeat -> Signatur-Vergleich,
             damit die Tabelle nicht ständig neu gebaut wird. */
          function sync() {
            if (dead || ended) return;
            var sh = lastShared;
            if (!sh || !sh.order) return;
            var order = orderOf(sh);
            var rl = sh.rolls || {};
            var ps = room.players();
            var plist = order.map(function (id) {
              var nm = 'Weg', on = false, i;
              for (i = 0; i < ps.length; i++) if (ps[i].id === id) { nm = ps[i].name; on = true; }
              return { id: id, name: nm + (id === me.id ? ' (du)' : '') + (on ? '' : ' ⚠'), me: id === me.id };
            });

            var ns = '';
            order.forEach(function (id) { ns += (rl[id] || '') + '|'; });
            var newSig = ns + '#' + sh.turn + '#' + (sh.over ? 1 : 0) + '#' + plist.length;
            if (newSig !== sig) {
              sig = newSig;
              renderSheet(refs.sheet, plist, rl, sh.over ? null : sh.turn);
            }
            eng.setStanding(sh.standing || FULL);

            var cf = completedFrames(strToRolls(rl[sh.turn] || ''));
            refs.frame.textContent = 'Frame ' + Math.min(10, cf + 1) + ' / 10';
            var mine = sh.turn === me.id;
            refs.who.textContent = sh.over ? 'Spiel vorbei' : (mine ? 'Du bist dran' : nameOf(sh.turn) + ' wirft');
            refs.who.className = 'bwl-who' + (mine && !sh.over ? ' is-me' : '');

            if (sh.over) { finish(); return; }
            if (mine && eng.getView() !== 'roll' && armedSeq !== (sh.seq || 0)) {
              armedSeq = sh.seq || 0;
              refs.status.textContent = 'Stopp die Balken: Position → Kraft → Effet';
              refs.status.className = 'bwl-status is-me';
              eng.arm();
            } else if (!mine && eng.getView() === 'aim') {
              eng.disarm();
            }
          }

          /* Werfer rechnet selbst und verteilt Parameter + neuen Stand. */
          function onThrow(params) {
            var sh = lastShared;
            if (!sh || sh.turn !== me.id || sh.over || dead) return;
            var before = sh.standing || FULL;
            var sim = simulate(params, before, false);
            var rolls = strToRolls((sh.rolls || {})[me.id] || '');
            rolls.push(sim.count);
            var rl = Object.assign({}, sh.rolls || {});
            rl[me.id] = rollsToStr(rolls);
            var st = nextStanding(rolls, sim.standing);
            var nx = nextTurnId(orderOf(sh), rl, me.id, present());
            room.reportScore(scoreOf(rolls).total);
            room.setShared({
              thr: { by: me.id, pos: params.pos, pow: params.pow, spin: params.spin, seed: params.seed, st: before },
              seq: (sh.seq || 0) + 1, rolls: rl, standing: st,
              turn: nx || me.id, over: nx === null
            });
          }

          function finish() {
            if (ended || dead) return;
            ended = true;
            var mine = scoreOf(strToRolls((lastShared.rolls || {})[me.id] || '')).total;
            room.reportScore(mine);
            after(1400, function () {
              if (dead) return;
              if (raf) { cancelAnimationFrame(raf); raf = null; }
              App.MG.endScreen(root, { players: room.players(), meId: me.id, onExit: ctx.onExit });
            });
          }
        }
      }
    }
  };

  /* ===================== CSS ===================== */
  function injectStyle() {
    UI.injectStyle('mg-bowling-css', [
      '.bwl-wrap{display:flex;flex-direction:column;gap:11px;max-width:460px;margin:0 auto;}',
      /* Kopf */
      '.bwl-top{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:9px 14px;}',
      '.bwl-who{font-weight:900;font-size:clamp(14px,4vw,17px);color:var(--aqua);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      '.bwl-who.is-me{color:var(--neon);text-shadow:0 0 10px rgba(57,255,20,.45);}',
      '.bwl-frameno{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;font-weight:800;white-space:nowrap;}',
      /* Bahn */
      '.bwl-stage{position:relative;width:100%;max-width:420px;margin:0 auto;aspect-ratio:420 / 620;}',
      '.bwl-canvas{display:block;width:100%;height:100%;border-radius:16px;border:2px solid var(--stroke);',
      'background:#03100a;box-shadow:0 10px 34px rgba(0,0,0,.5),0 0 26px rgba(57,255,20,.1);touch-action:none;}',
      /* Einblendung Strike/Spare */
      '.bwl-flash{position:absolute;left:50%;top:38%;transform:translate(-50%,-50%) scale(.6);opacity:0;pointer-events:none;',
      'font-size:clamp(26px,8vw,44px);font-weight:900;letter-spacing:2px;white-space:nowrap;}',
      '.bwl-flash.is-on{animation:bwl-flash 1.4s cubic-bezier(.2,.9,.3,1) both;}',
      '@keyframes bwl-flash{0%{opacity:0;transform:translate(-50%,-50%) scale(.5);}18%{opacity:1;transform:translate(-50%,-50%) scale(1.14);}',
      '32%{transform:translate(-50%,-50%) scale(1);}78%{opacity:1;}100%{opacity:0;transform:translate(-50%,-50%) scale(1.05);}}',
      '.bwl-flash-strike{color:var(--gold);text-shadow:0 0 22px rgba(255,210,63,.85),0 0 46px rgba(255,210,63,.5);}',
      '.bwl-flash-spare{color:var(--neon);text-shadow:0 0 20px rgba(57,255,20,.8);}',
      '.bwl-flash-ok{color:var(--aqua-soft);text-shadow:0 0 16px rgba(51,230,208,.6);}',
      '.bwl-flash-miss{color:var(--danger);text-shadow:0 0 18px rgba(255,77,109,.7);}',
      /* Statuszeile */
      '.bwl-status{text-align:center;font-weight:900;font-size:clamp(13px,3.7vw,16px);min-height:20px;transition:color .15s;}',
      '.bwl-status.is-me{color:var(--neon);}',
      '.bwl-status.is-wait{color:var(--muted);}',
      '.bwl-status.is-strike{color:var(--gold);text-shadow:0 0 12px rgba(255,210,63,.5);}',
      '.bwl-status.is-spare{color:var(--neon);}',
      '.bwl-status.is-ok{color:var(--aqua);}',
      '.bwl-status.is-miss{color:var(--danger);}',
      /* Balken-Panel */
      '.bwl-panel{padding:11px 14px;display:flex;flex-direction:column;gap:9px;opacity:.5;transition:opacity .2s;}',
      '.bwl-panel.is-live{opacity:1;}',
      '.bwl-steps{display:flex;flex-direction:column;gap:7px;}',
      '.bwl-step{display:flex;flex-direction:column;gap:3px;opacity:.42;transition:opacity .18s;}',
      '.bwl-step.is-active,.bwl-step.is-locked{opacity:1;}',
      '.bwl-step-l{display:flex;justify-content:space-between;align-items:baseline;gap:8px;font-size:10px;',
      'text-transform:uppercase;letter-spacing:1px;font-weight:800;color:var(--muted);}',
      '.bwl-step-v{color:var(--leaf);font-size:12px;letter-spacing:0;font-variant-numeric:tabular-nums;}',
      '.bwl-step.is-active .bwl-step-v{color:var(--gold);}',
      '.bwl-bar{position:relative;height:16px;border-radius:9px;border:1px solid var(--stroke);',
      'background:rgba(4,18,11,.85);overflow:hidden;cursor:pointer;touch-action:none;}',
      '.bwl-step.is-active .bwl-bar{border-color:var(--stroke-2);box-shadow:0 0 14px rgba(57,255,20,.22);}',
      '.bwl-bar-pos{background:linear-gradient(90deg,rgba(51,230,208,.22),rgba(4,18,11,.9) 42%,rgba(4,18,11,.9) 58%,rgba(51,230,208,.22));}',
      '.bwl-bar-pow{background:linear-gradient(90deg,rgba(4,18,11,.9),rgba(57,255,20,.18) 62%,rgba(255,210,63,.4) 82%,rgba(255,77,109,.45));}',
      '.bwl-bar-spin{background:linear-gradient(90deg,rgba(255,210,63,.3),rgba(4,18,11,.9) 46%,rgba(4,18,11,.9) 54%,rgba(255,210,63,.3));}',
      '.bwl-bar-mid{position:absolute;left:50%;top:2px;bottom:2px;width:1px;background:rgba(157,255,122,.35);}',
      '.bwl-marker{position:absolute;top:-1px;bottom:-1px;width:4px;margin-left:-2px;border-radius:3px;',
      'background:#fff;box-shadow:0 0 10px rgba(255,255,255,.9),0 0 18px var(--neon);}',
      '.bwl-step:not(.is-active) .bwl-marker{display:none;}',
      '.bwl-lockmark{position:absolute;top:-1px;bottom:-1px;width:4px;margin-left:-2px;border-radius:3px;display:none;',
      'background:var(--gold);box-shadow:0 0 10px rgba(255,210,63,.9);}',
      '.bwl-stop{width:100%;letter-spacing:2px;font-weight:900;}',
      '.bwl-stop:disabled{opacity:.35;cursor:default;}',
      /* Tabelle */
      '.bwl-sheet{padding:8px;overflow-x:auto;}',
      '.bwl-sheet-scroll{min-width:326px;display:flex;flex-direction:column;gap:3px;}',
      '.bwl-row{display:grid;grid-template-columns:52px repeat(9,1fr) 1.5fr 32px;gap:2px;align-items:stretch;}',
      '.bwl-row.is-turn .bwl-cell-name{color:var(--neon);}',
      '.bwl-row.is-me .bwl-cell-name{font-weight:900;}',
      '.bwl-cell-name{display:flex;align-items:center;font-size:10px;font-weight:800;color:var(--text);',
      'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding-right:2px;}',
      '.bwl-h{font-size:9px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;text-align:center;',
      'display:flex;align-items:center;justify-content:center;background:none;border:0;min-height:0;padding:0;}',
      '.bwl-fr{position:relative;border:1px solid var(--stroke);border-radius:5px;background:rgba(6,24,16,.6);',
      'display:flex;flex-direction:column;min-height:30px;overflow:hidden;}',
      '.bwl-fr.is-cur{border-color:var(--neon);box-shadow:0 0 0 1px var(--neon),0 0 12px rgba(57,255,20,.3);}',
      '.bwl-boxes{display:flex;justify-content:flex-end;gap:1px;padding:1px 1px 0 0;min-height:11px;}',
      '.bwl-bx{min-width:9px;height:10px;line-height:10px;text-align:center;font-size:8px;font-weight:900;',
      'color:var(--leaf);border-radius:2px;}',
      '.bwl-bx.is-x{background:rgba(255,210,63,.22);color:var(--gold);}',
      '.bwl-bx.is-sp{background:rgba(57,255,20,.2);color:var(--neon);}',
      '.bwl-fscore{flex:1;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:900;',
      'color:var(--text);font-variant-numeric:tabular-nums;}',
      '.bwl-tot{display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:900;',
      'color:var(--gold);font-variant-numeric:tabular-nums;}',
      /* Auswahl / Warten */
      '.bwl-setup{padding:26px 22px;text-align:center;display:flex;flex-direction:column;gap:10px;align-items:center;max-width:420px;margin:0 auto;}',
      '.bwl-setup-icon{font-size:52px;line-height:1;filter:drop-shadow(0 0 14px rgba(57,255,20,.45));animation:bwl-roll 3.2s ease-in-out infinite;}',
      '@keyframes bwl-roll{0%,100%{transform:translateX(-8px) rotate(-12deg);}50%{transform:translateX(8px) rotate(12deg);}}',
      '.bwl-setup h2{margin:0;}',
      '.bwl-setup .mg-field-title{margin-top:4px;}',
      '.bwl-chips{display:flex;gap:8px;justify-content:center;flex-wrap:wrap;}',
      '.bwl-chip{cursor:pointer;border:1px solid var(--stroke);background:rgba(9,32,21,.6);color:var(--text);',
      'font-weight:800;font-size:13px;padding:7px 14px;border-radius:11px;transition:.15s;font-family:inherit;}',
      '.bwl-chip:hover{border-color:var(--stroke-2);}',
      '.bwl-chip.is-on{border-color:var(--neon);background:rgba(57,255,20,.14);color:var(--neon);box-shadow:0 0 14px rgba(57,255,20,.28);}',
      '.bwl-hint{text-align:center;font-size:11px;margin:0;line-height:1.5;}'
    ].join(''));
  }
})();
