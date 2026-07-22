/* browser-test.js — fährt die Seite in Chrome headless hoch und spielt die
 * neuen Spiele wirklich durch (echtes DOM, echtes Layout, echte Timer).
 *
 *   node tools/browser-test.js
 *
 * Nutzt das DevTools-Protokoll direkt über den in Node eingebauten
 * WebSocket-Client — kein npm-Paket nötig. Chrome wird selbst gestartet und am
 * Ende wieder beendet.
 */
'use strict';
var cp = require('child_process');
var http = require('http');
var path = require('path');

var ROOT = path.join(__dirname, '..');
var PORT = 9333;
var chrome = cp.spawn('google-chrome', [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--mute-audio',
  '--remote-debugging-port=' + PORT,
  '--user-data-dir=/tmp/claude-chrome-slottest',
  '--window-size=900,1400',
  'file://' + path.join(ROOT, 'index.html')
], { stdio: 'ignore' });

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

function getJson(url) {
  return new Promise(function (resolve, reject) {
    http.get(url, function (res) {
      var body = '';
      res.on('data', function (c) { body += c; });
      res.on('end', function () { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

async function findTarget() {
  for (var i = 0; i < 40; i++) {
    try {
      var list = await getJson('http://127.0.0.1:' + PORT + '/json/list');
      var page = list.filter(function (t) { return t.type === 'page' && t.webSocketDebuggerUrl; })[0];
      if (page) return page;
    } catch (e) { /* Chrome noch nicht oben */ }
    await sleep(250);
  }
  throw new Error('Chrome-DevTools nicht erreichbar');
}

async function main() {
  var target = await findTarget();
  var ws = new WebSocket(target.webSocketDebuggerUrl);
  var nextId = 1, pending = {};
  var consoleErrors = [];

  await new Promise(function (r) { ws.onopen = r; });
  ws.onmessage = function (ev) {
    var msg = JSON.parse(ev.data);
    if (msg.id && pending[msg.id]) { pending[msg.id](msg); delete pending[msg.id]; return; }
    if (msg.method === 'Runtime.exceptionThrown') {
      var d = msg.params.exceptionDetails;
      consoleErrors.push('EXCEPTION: ' + (d.exception && d.exception.description || d.text));
    }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      consoleErrors.push('console.error: ' + msg.params.args.map(function (a) { return a.value || a.description; }).join(' '));
    }
  };

  function send(method, params) {
    var id = nextId++;
    return new Promise(function (resolve) {
      pending[id] = resolve;
      ws.send(JSON.stringify({ id: id, method: method, params: params || {} }));
    });
  }

  async function evaluate(expr) {
    var r = await send('Runtime.evaluate', {
      expression: expr, awaitPromise: true, returnByValue: true
    });
    if (r.result && r.result.exceptionDetails) {
      throw new Error(r.result.exceptionDetails.exception
        ? r.result.exceptionDetails.exception.description
        : r.result.exceptionDetails.text);
    }
    return r.result.result.value;
  }

  await send('Runtime.enable');
  await send('Page.enable');
  await sleep(2500);   // App laden lassen

  var out = [];
  function log(s) { out.push(s); console.log(s); }

  /* --- 1. sind alle Spiele registriert? --- */
  var ids = await evaluate('Object.keys(App.Games)');
  var want = ['naehe', 'slotfruit', 'slotegypt', 'slotspace', 'slotpirate', 'slotcandy', 'slothorror'];
  var missing = want.filter(function (w) { return ids.indexOf(w) < 0; });
  log(missing.length ? '❌ nicht registriert: ' + missing.join(', ') : '✅ alle 7 neuen Spiele registriert');

  /* --- 2. jede Slotmaschine rendern und 8 Runden drehen --- */
  for (var i = 0; i < 6; i++) {
    var id = want[i + 1];
    var res = await evaluate(`(async () => {
      const d = document.createElement('div');
      document.body.appendChild(d);
      App.Coins.set ? App.Coins.set(100000) : null;
      const api = App.Games['${id}'].render(d);
      const before = App.Coins.get();
      const spin = d.querySelector('.sm-spin');
      const cells = d.querySelectorAll('.sm-cell').length;
      const reels = d.querySelectorAll('.sm-reel').length;
      let rounds = 0;
      for (let r = 0; r < 8; r++) {
        const btn = d.querySelector('.sm-spin');
        if (btn && !btn.disabled) { btn.click(); rounds++; }
        await new Promise(x => setTimeout(x, 2200));
      }
      const readout = d.querySelector('.sm-readout').textContent;
      const paytable = d.querySelectorAll('.sm-paytable tr').length;
      const after = App.Coins.get();
      api.cleanup && api.cleanup();
      d.remove();
      return { reels, cells, rounds, readout, paytable, changed: before !== after };
    })()`);
    var ok = res.reels >= 3 && res.cells > 0 && res.rounds >= 6 && res.changed && res.paytable >= 7;
    log((ok ? '✅ ' : '❌ ') + id + ': ' + res.reels + ' Walzen, ' + res.rounds + ' Runden gedreht, ' +
      res.paytable + ' Paytable-Zeilen, Guthaben ' + (res.changed ? 'bewegt' : 'UNVERÄNDERT') +
      ', Anzeige "' + res.readout + '"');
  }

  /* --- 2b. Sonderfeatures gezielt auslösen ---
   * Die Trigger-Symbole werden im Test hochgewichtet, sonst müsste man hunderte
   * Runden drehen, bis Freispiele/Bonus überhaupt vorkommen. */
  async function forceFeature(id, symId, weight, checkSel, rounds, extra) {
    return await evaluate(`(async () => {
      const t = App.SlotThemes.find(x => x.id === '${id}');
      const backup = t.symbols.map(s => s.weight);
      t.symbols.forEach(s => { if (s.id === '${symId}') s.weight = ${weight}; });
      t._totalWeight = t.symbols.reduce((a, s) => a + s.weight, 0);

      const d = document.createElement('div');
      document.body.appendChild(d);
      const api = App.Games['${id}'].render(d);
      let seen = false, note = '';
      for (let r = 0; r < ${rounds}; r++) {
        const btn = d.querySelector('.sm-spin');
        if (btn && !btn.disabled) btn.click();
        await new Promise(x => setTimeout(x, 1600));
        ${extra || ''}
        const hit = d.querySelector('${checkSel}');
        if (hit && (hit.offsetParent !== null || hit.textContent)) {
          seen = true; note = (d.querySelector('.sm-feature')||{}).textContent || hit.textContent || '';
          if (note) break;
        }
      }
      // Freispiele/Respins zu Ende laufen lassen
      await new Promise(x => setTimeout(x, 9000));
      const readout = (d.querySelector('.sm-readout')||{}).textContent || '';
      api.cleanup && api.cleanup();
      d.remove();
      t.symbols.forEach((s, i) => { s.weight = backup[i]; });
      t._totalWeight = t.symbols.reduce((a, s) => a + s.weight, 0);
      return { seen, note, readout };
    })()`);
  }

  var f1 = await forceFeature('slotegypt', 'book', 40, '.sm-feature', 4);
  log((f1.seen ? '✅ ' : '❌ ') + 'Pharaos Buch — Freispiele: "' + f1.note.trim() + '" / Ende: "' + f1.readout.trim() + '"');

  var f2 = await forceFeature('slothorror', 'moon', 30, '.sm-feature', 4);
  log((f2.seen ? '✅ ' : '❌ ') + 'Blutmond — Sticky-Respin: "' + f2.note.trim() + '"');

  var f3 = await forceFeature('slotcandy', 'straw', 200, '.sm-feature', 4);
  log((f3.seen ? '✅ ' : '❌ ') + 'Candy Cascade — Kettenreaktion: "' + f3.note.trim() + '"');

  // Truhen-Bonus: Overlay erscheint, drei Truhen anklicken
  var f4 = await evaluate(`(async () => {
    const t = App.SlotThemes.find(x => x.id === 'slotpirate');
    const backup = t.symbols.map(s => s.weight);
    t.symbols.forEach(s => { if (s.id === 'map') s.weight = 40; });
    t._totalWeight = t.symbols.reduce((a, s) => a + s.weight, 0);

    const d = document.createElement('div');
    document.body.appendChild(d);
    const api = App.Games.slotpirate.render(d);
    let picked = 0, before = App.Coins.get(), overlay = false;
    for (let r = 0; r < 4; r++) {
      const btn = d.querySelector('.sm-spin');
      if (btn && !btn.disabled) btn.click();
      await new Promise(x => setTimeout(x, 1800));
      const boxes = d.querySelectorAll('.sm-pick');
      if (boxes.length) {
        overlay = true;
        for (const b of boxes) {
          if (!b.disabled && picked < 3) { b.click(); picked++; await new Promise(x => setTimeout(x, 120)); }
        }
        await new Promise(x => setTimeout(x, 1600));
        break;
      }
    }
    const readout = (d.querySelector('.sm-readout')||{}).textContent || '';
    const gone = d.querySelectorAll('.sm-pick').length === 0;
    api.cleanup && api.cleanup();
    d.remove();
    t.symbols.forEach((s, i) => { s.weight = backup[i]; });
    t._totalWeight = t.symbols.reduce((a, s) => a + s.weight, 0);
    return { overlay, picked, readout, gone };
  })()`);
  log((f4.overlay && f4.picked === 3 && f4.gone ? '✅ ' : '❌ ') + 'Piratenbucht — Truhen-Bonus: ' +
    f4.picked + ' Truhen geöffnet, Overlay schließt: ' + f4.gone + ', "' + f4.readout.trim() + '"');

  /* --- 3. Nähe: Sofort-Treffer, Zonen-Zahlen und Niederlage --- */
  var nh = await evaluate(`(async () => {
    const d = document.createElement('div');
    document.body.appendChild(d);
    const api = App.Games.naehe.render(d);
    const cells = [...d.querySelectorAll('.nh-cell')];
    const grid = cells.length;
    const legend = d.querySelectorAll('.nh-leg').length;
    const at = (x, y) => cells[y * 15 + x];

    // Ziel per fixiertem Zufall auf (0,0) legen, dann gezielt danebenklicken
    const orig = Math.random;
    Math.random = () => 0;
    d.querySelector('.nh-start').click();
    Math.random = orig;
    const bet = 50;

    at(2, 0).click();            // Entfernung 2 -> Zone 1
    const z1 = at(2, 0).textContent;
    at(5, 0).click();            // Entfernung 5 -> Zone 2
    const z2 = at(5, 0).textContent;
    at(9, 9).click();            // Entfernung 9 -> Zone 3
    const z3 = at(9, 9).textContent;

    const balBefore = App.Coins.get();
    at(0, 0).click();            // Treffer im 4. Versuch -> x1.4
    const readoutWin = d.querySelector('.nh-readout').textContent;
    const gain = App.Coins.get() - balBefore;
    const marked = at(0, 0).classList.contains('nh-target');

    // Zweite Runde: absichtlich verlieren (Ziel liegt auf (0,0), wir klicken weit weg)
    Math.random = () => 0;
    d.querySelector('.nh-start').click();
    Math.random = orig;
    for (let i = 0; i < 15; i++) at(14 - (i % 8), 14 - ((i / 8) | 0)).click();
    const readoutLose = d.querySelector('.nh-readout').textContent;
    const revealed = at(0, 0).classList.contains('nh-missed');

    api.cleanup && api.cleanup();
    d.remove();
    return { grid, legend, z1, z2, z3, readoutWin, gain, marked, readoutLose, revealed };
  })()`);
  var zonesOk = nh.z1 === '1' && nh.z2 === '2' && nh.z3 === '3';
  log((nh.grid === 225 && nh.legend === 5 ? '✅ ' : '❌ ') + 'Nähe: ' + nh.grid + ' Felder, ' + nh.legend + ' Legenden-Einträge');
  log((zonesOk ? '✅ ' : '❌ ') + '   Zonen: Abstand 2→"' + nh.z1 + '", 5→"' + nh.z2 + '", 9→"' + nh.z3 + '"');
  log((nh.marked && nh.gain > 0 ? '✅ ' : '❌ ') + '   Treffer: +' + nh.gain + ' Coins — "' + nh.readoutWin + '"');
  log((nh.revealed ? '✅ ' : '❌ ') + '   Niederlage: "' + nh.readoutLose + '" (Ziel aufgedeckt: ' + nh.revealed + ')');

  /* --- 4. Kategorie + Navigation --- */
  var nav = await evaluate(`(() => {
    location.hash = '#/category/slotmachines';
    return new Promise(r => setTimeout(() => {
      const tiles = document.querySelectorAll('#view .game-tile').length;
      const title = (document.querySelector('#view .page-title')||{}).textContent || '';
      location.hash = '#/game/slotegypt';
      setTimeout(() => {
        const back = (document.querySelector('#view .back')||{}).textContent || '';
        const t2 = (document.querySelector('#view .game-frame-title')||{}).textContent || '';
        location.hash = '#/';
        r({ tiles, title, back, t2 });
      }, 600);
    }, 600));
  })()`);
  log((nav.tiles === 7 ? '✅ ' : '❌ ') + 'Kategorie "' + nav.title.trim() + '": ' + nav.tiles + ' Kacheln; Spiel öffnet als "' + nav.t2.trim() + '"');

  /* --- 5. Fehler? --- */
  await sleep(300);
  if (consoleErrors.length) {
    log('❌ ' + consoleErrors.length + ' Fehler in der Konsole:');
    consoleErrors.slice(0, 8).forEach(function (e) { log('   ' + e.slice(0, 200)); });
  } else {
    log('✅ keine Konsolenfehler');
  }

  ws.close();
  chrome.kill();
  process.exit(0);
}

main().catch(function (e) {
  console.error('Testlauf fehlgeschlagen:', e.message);
  try { chrome.kill(); } catch (x) {}
  process.exit(1);
});
