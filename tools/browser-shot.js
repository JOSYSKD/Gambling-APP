/* browser-shot.js — Screenshots der neuen Ansichten, damit man das Layout auch
 * wirklich sieht (Elementzähler allein verraten kein kaputtes CSS).
 *
 *   node tools/browser-shot.js [zielordner]
 */
'use strict';
var cp = require('child_process');
var http = require('http');
var fs = require('fs');
var path = require('path');

var ROOT = path.join(__dirname, '..');
var OUT = process.argv[2] || '/tmp/klett-shots';
var PORT = 9334;
fs.mkdirSync(OUT, { recursive: true });

var chrome = cp.spawn('google-chrome', [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--mute-audio',
  '--remote-debugging-port=' + PORT,
  '--user-data-dir=/tmp/claude-chrome-shots',
  '--window-size=520,1500', '--force-device-scale-factor=1',
  'file://' + path.join(ROOT, 'index.html')
], { stdio: 'ignore' });

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function getJson(url) {
  return new Promise(function (resolve, reject) {
    http.get(url, function (res) {
      var b = ''; res.on('data', function (c) { b += c; });
      res.on('end', function () { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

async function main() {
  var target = null;
  for (var i = 0; i < 40 && !target; i++) {
    try {
      var list = await getJson('http://127.0.0.1:' + PORT + '/json/list');
      target = list.filter(function (t) { return t.type === 'page' && t.webSocketDebuggerUrl; })[0];
    } catch (e) {}
    if (!target) await sleep(250);
  }
  var ws = new WebSocket(target.webSocketDebuggerUrl);
  var nextId = 1, pending = {};
  await new Promise(function (r) { ws.onopen = r; });
  ws.onmessage = function (ev) {
    var m = JSON.parse(ev.data);
    if (m.id && pending[m.id]) { pending[m.id](m); delete pending[m.id]; }
  };
  function send(method, params) {
    var id = nextId++;
    return new Promise(function (res) { pending[id] = res; ws.send(JSON.stringify({ id: id, method: method, params: params || {} })); });
  }
  async function evaluate(expr) {
    var r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    return r.result.result && r.result.result.value;
  }
  async function shot(name) {
    var r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(r.result.data, 'base64'));
    console.log('  ' + path.join(OUT, name + '.png'));
  }

  await send('Page.enable');
  await send('Runtime.enable');
  await sleep(2500);
  await send('Emulation.setDeviceMetricsOverride', { width: 520, height: 1500, deviceScaleFactor: 1, mobile: true });

  // Namensabfrage beim ersten Start wegklicken, sonst liegt sie über allem
  await evaluate(`(() => {
    const inp = [...document.querySelectorAll('input')].find(i => i.offsetParent !== null);
    if (inp) {
      inp.value = 'Testspieler';
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      inp.dispatchEvent(new Event('change', { bubbles: true }));
    }
    const btn = [...document.querySelectorAll('button')].find(b => /Los geht/i.test(b.textContent));
    if (btn) btn.click();
    return !!btn;
  })()`);
  await sleep(1200);

  // Kategorie-Übersicht
  await evaluate("location.hash = '#/category/slotmachines'");
  await sleep(900);
  await shot('01-kategorie');

  // Ein 5-Walzen-Automat, nach ein paar Drehungen
  await evaluate("location.hash = '#/game/slotegypt'");
  await sleep(900);
  await evaluate(`(async () => {
    for (let i = 0; i < 3; i++) {
      const b = document.querySelector('.sm-spin');
      if (b && !b.disabled) b.click();
      await new Promise(r => setTimeout(r, 2200));
    }
  })()`);
  await sleep(400);
  await shot('02-slot-egypt');

  // Klassiker mit 3 Walzen
  await evaluate("location.hash = '#/game/slotfruit'");
  await sleep(900);
  await evaluate(`(async () => {
    const b = document.querySelector('.sm-spin'); if (b) b.click();
    await new Promise(r => setTimeout(r, 2000));
  })()`);
  await shot('03-slot-fruit');

  // Nähe mitten in der Runde
  await evaluate("location.hash = '#/game/naehe'");
  await sleep(900);
  await evaluate(`(() => {
    document.querySelector('.nh-start').click();
    const cells = [...document.querySelectorAll('.nh-cell')];
    [7*15+7, 3*15+3, 11*15+11, 2*15+12, 13*15+4].forEach(i => cells[i] && cells[i].click());
  })()`);
  await sleep(500);
  await shot('04-naehe');

  ws.close(); chrome.kill(); process.exit(0);
}
main().catch(function (e) { console.error(e.message); try { chrome.kill(); } catch (x) {} process.exit(1); });
