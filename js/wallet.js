/* wallet.js — Coins an andere Spieler verschenken (App.Wallet, Route /send).
 *
 * Jeder Spieler kann anderen Spielern Casino-Silber schicken. KEIN XP dafür
 * (weder Sender noch Empfänger): abgebucht/gutgeschrieben wird über
 * App.TournamentHost.payCasino bzw. das Postfach (collectPay) — beide nutzen
 * App.Coins.addRaw, das die Quest-/Level-Erfassung in progress.js umgeht.
 *
 * ZUSTELLUNG ÜBER DAS POSTFACH: Der Empfänger ist oft nicht online. Statt sein
 * Guthaben direkt anzufassen (ginge gar nicht — jeder Client hält seinen Stand
 * lokal), legt der Sender einen Eintrag in `tournament/pay/<empfängerPid>` ab
 * (App.TournamentHost.mailCoins). Genau dieses Postfach leert der Empfänger beim
 * nächsten Laden über collectPay in js/tournament-host.js — mit Toast und
 * Seen-Guard, also genau einmal. Der Pfad liegt unter dem bereits offenen,
 * deployten `tournament`-Knoten -> KEIN neuer Firebase-Regel-Deploy nötig.
 *
 * Empfänger-pid folgt derselben Regel wie App.Tournament.myPid():
 *   Konto  -> 'a_' + Kontoschlüssel   (aus dem accountKey im Präsenz-Eintrag)
 *   Gast   -> 'g_' + Geräte-ID        (der Präsenz-Schlüssel selbst)
 *
 * Gesendet wird IMMER aus dem Casino-Stand (Silber) — Survival-Gold darf den
 * Modus nie verlassen (siehe js/mode.js). payCasino bucht auch dann vom Casino
 * ab, wenn gerade Survival aktiv ist.
 */
(function () {
  'use strict';
  window.App = window.App || {};
  var UI = App.UI, el = UI.el;

  var ONLINE_MS = 16000;

  function H() { return App.TournamentHost; }
  function myPid() { return App.Tournament.myPid(); }
  function myName() { return App.Tournament.myName(); }
  function parseAmount(s) { return App.TournamentHostUI.parseAmount(s); }

  /** Empfänger-pid aus einem Präsenz-Eintrag (Schlüssel = Geräte-ID). */
  function pidOf(deviceId, rec) {
    return (rec && rec.accountKey) ? ('a_' + rec.accountKey) : ('g_' + deviceId);
  }

  /** Liste möglicher Empfänger (alle bekannten Spieler außer mir selbst).
   *  Quelle ist der offene Präsenz-Knoten, gelesen über denselben Store wie das
   *  Postfach (App.Net.store()) — live derselbe Firebase-Knoten `presence`, in
   *  den js/presence.js schreibt. Kein Zugriff auf Konto-Objekte, also bleiben
   *  Passwort-Hashes unangetastet. */
  function players() {
    return App.Net.store().then(function (b) { return b.get('presence'); }).then(function (presence) {
      presence = presence || {};
      var me = myPid();
      var byPid = {};
      Object.keys(presence).forEach(function (devId) {
        var rec = presence[devId] || {};
        var name = rec.name;
        if (!name || name === 'Gast') return;
        var pid = pidOf(devId, rec);
        if (pid === me) return;
        var seen = Number(rec.lastSeen) || 0;
        // Ein Konto auf mehreren Geräten -> mehrere Einträge, gleiche pid.
        // Den jüngsten behalten.
        if (!byPid[pid] || seen > byPid[pid].lastSeen) {
          byPid[pid] = { pid: pid, name: name, lastSeen: seen, peak: Number(rec.casinoPeak) || 0, maxLevel: !!rec.maxLevel };
        }
      });
      return Object.keys(byPid).map(function (k) { return byPid[k]; })
        .sort(function (a, b) { return b.lastSeen - a.lastSeen; });
    }).catch(function () { return []; });
  }

  function casinoBalance() { return H().casinoBalance(); }

  /**
   * amount Casino-Silber an toPid schicken. Bucht sofort ab und legt das Geld
   * ins Postfach des Empfängers; schlägt das Schreiben fehl, wird die Abbuchung
   * zurückgenommen (kein Geld darf verschwinden). Absichtlich in dieser
   * Reihenfolge: erst abbuchen, dann zustellen — so kann nie mehr ankommen als
   * abgebucht wurde (kein Geld aus dem Nichts).
   */
  function send(toPid, toName, amount) {
    amount = Math.round(Number(amount) || 0);
    if (!toPid) return Promise.reject(new Error('Wähle einen Empfänger.'));
    if (toPid === myPid()) return Promise.reject(new Error('Du kannst dir nicht selbst Coins schicken.'));
    if (!(amount > 0)) return Promise.reject(new Error('Der Betrag muss größer als 0 sein.'));
    if (amount > casinoBalance()) {
      return Promise.reject(new Error('Dafür reicht dein Guthaben nicht (' + UI.formatShort(casinoBalance()) + ' Coins).'));
    }
    H().payCasino(-amount);   // sofort abbuchen (addRaw -> kein XP)
    return H().mailCoins(toPid, amount, myName() + ' hat dir ' + UI.formatShort(amount) + ' Coins geschenkt 🎁')
      .then(function () { return { amount: amount, toName: toName }; })
      .catch(function (e) {
        H().payCasino(amount);   // Zustellung fehlgeschlagen -> zurückbuchen
        throw new Error('Überweisung fehlgeschlagen — dein Geld ist wieder da.');
      });
  }

  /* ---------------- Oberfläche ---------------- */
  function injectCss() {
    UI.injectStyle('wallet-css', [
      '.wl-sec{padding:16px;margin-bottom:14px;}',
      '.wl-bal{font-size:14px;opacity:.85;margin-bottom:10px;}',
      '.wl-bal b{color:var(--neon);}',
      '.wl-search{margin-bottom:10px;}',
      '.wl-list{display:flex;flex-direction:column;gap:6px;max-height:320px;overflow-y:auto;}',
      '.wl-row{display:flex;align-items:center;gap:10px;padding:9px 12px;border-radius:10px;cursor:pointer;',
      'background:rgba(2,10,6,.45);border:1px solid var(--stroke);transition:border-color .12s;}',
      '.wl-row:hover{border-color:var(--neon);}',
      '.wl-row.sel{border-color:var(--neon);box-shadow:0 0 10px rgba(57,255,20,.3);}',
      '.wl-dot{width:9px;height:9px;border-radius:50%;background:#555;flex:0 0 auto;}',
      '.wl-dot.on{background:var(--neon);box-shadow:0 0 8px var(--neon);}',
      '.wl-name{font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.wl-sub{margin-left:auto;font-size:11px;opacity:.6;white-space:nowrap;}',
      '.wl-amt-row{display:flex;flex-wrap:wrap;gap:8px;align-items:flex-end;margin-top:6px;}',
      '.wl-amt-field{display:flex;flex-direction:column;gap:4px;}',
      '.wl-amt-field label{font-size:12px;opacity:.75;}',
      '.wl-amt-field .text-input{width:180px;max-width:60vw;}',
      '.wl-quick{display:flex;gap:6px;flex-wrap:wrap;margin-top:6px;}',
      '.wl-quick .btn{font-size:12px;padding:5px 9px;}',
      '.wl-hint-in{font-size:11px;opacity:.7;min-height:14px;}',
      '.wl-hint-in.bad{color:#ff6b6b;opacity:1;}',
      '.wl-empty{opacity:.55;font-size:13px;padding:10px;}'
    ].join(''));
  }

  function renderPage(root) {
    injectCss();
    if (App.Mode) App.Mode.set('casino');   // gesendet wird Silber
    App.Tournament.start(); H().start();

    var sel = null;                 // gewählter Empfänger {pid,name}
    var allPlayers = [];

    var balLine = el('div', { class: 'wl-bal' }, ['']);
    function drawBal() {
      balLine.innerHTML = '';
      balLine.appendChild(document.createTextNode('Dein Guthaben: '));
      balLine.appendChild(el('b', {}, [UI.formatCoins(casinoBalance()) + ' 🪙']));
    }

    var search = el('input', { class: 'text-input wl-search', type: 'text', placeholder: '🔎 Spieler suchen …' });
    var listBox = el('div', { class: 'wl-list' });

    function drawList() {
      var q = (search.value || '').trim().toLowerCase();
      var rows = allPlayers.filter(function (p) { return !q || p.name.toLowerCase().indexOf(q) >= 0; });
      listBox.innerHTML = '';
      if (!allPlayers.length) {
        listBox.appendChild(el('div', { class: 'wl-empty' }, ['Noch keine anderen Spieler gefunden. Sobald jemand die Seite offen hatte, taucht er hier auf.']));
        return;
      }
      if (!rows.length) {
        listBox.appendChild(el('div', { class: 'wl-empty' }, ['Kein Spieler passt zu „' + q + '".']));
        return;
      }
      var now = Date.now();
      rows.slice(0, 100).forEach(function (p) {
        var online = (now - p.lastSeen) < ONLINE_MS;
        listBox.appendChild(el('div', {
          class: 'wl-row' + (sel && sel.pid === p.pid ? ' sel' : ''),
          onclick: function () { sel = p; drawList(); syncSend(); }
        }, [
          el('span', { class: 'wl-dot' + (online ? ' on' : '') }),
          el('span', { class: 'wl-name' }, [(p.maxLevel ? '👑 ' : '') + p.name]),
          el('span', { class: 'wl-sub' }, [online ? 'online' : 'zuletzt gesehen'])
        ]));
      });
    }

    var amtIn = el('input', { class: 'text-input', type: 'text', placeholder: 'z. B. 1M, 500K, 750B' });
    var amtHint = el('div', { class: 'wl-hint-in' }, ['']);
    var sendBtn = el('button', { class: 'btn btn-primary btn-lg', type: 'button' }, ['💸 Coins senden']);

    function syncSend() {
      var v = parseAmount(amtIn.value);
      var okAmt = isFinite(v) && v > 0 && v <= casinoBalance();
      if (!amtIn.value) { amtHint.textContent = ''; amtHint.classList.remove('bad'); }
      else if (!isFinite(v) || v <= 0) { amtHint.textContent = 'Betrag nicht lesbar — z. B. 1M oder 500000.'; amtHint.classList.add('bad'); }
      else if (v > casinoBalance()) { amtHint.textContent = 'Mehr als dein Guthaben (' + UI.formatShort(casinoBalance()) + ').'; amtHint.classList.add('bad'); }
      else { amtHint.textContent = '= ' + UI.formatCoins(v) + ' Coins an ' + (sel ? sel.name : '…'); amtHint.classList.remove('bad'); }
      sendBtn.disabled = !(sel && okAmt);
    }
    amtIn.addEventListener('input', syncSend);

    var quick = el('div', { class: 'wl-quick' }, [
      mkQuick('¼', function () { return Math.floor(casinoBalance() / 4); }),
      mkQuick('½', function () { return Math.floor(casinoBalance() / 2); }),
      mkQuick('Alles', function () { return Math.floor(casinoBalance()); })
    ]);
    function mkQuick(label, fn) {
      return el('button', { class: 'btn btn-ghost', type: 'button', onclick: function () {
        var v = fn();
        amtIn.value = v > 0 ? shortField(v) : '';
        syncSend();
      } }, [label]);
    }
    function shortField(n) {
      n = Math.round(Number(n) || 0);
      var s = UI.formatShort(n);
      return parseAmount(s) === n ? s : String(n);
    }

    sendBtn.addEventListener('click', function () {
      if (sendBtn.disabled) return;
      var v = parseAmount(amtIn.value);
      var target = sel;
      sendBtn.disabled = true;   // Doppelklick sperren
      send(target.pid, target.name, v).then(function (r) {
        UI.toast('💸 ' + UI.formatShort(r.amount) + ' Coins an ' + r.toName + ' geschickt!', 'win');
        if (App.Audio && App.Audio.coin) { try { App.Audio.coin(); } catch (e) {} }
        amtIn.value = ''; sel = null;
        drawBal(); drawList(); syncSend();
      }).catch(function (e) {
        UI.toast(e.message, 'lose');
        drawBal(); syncSend();
      });
    });

    root.appendChild(el('div', { class: 'page-head' }, [
      el('button', { class: 'btn btn-ghost back', type: 'button', onclick: function () { App.Router.go('/'); } }, ['← Zurück']),
      el('h2', { class: 'page-title neon' }, ['💸 Coins verschenken'])
    ]));

    root.appendChild(el('div', { class: 'glass wl-sec' }, [
      balLine,
      el('p', { class: 'lb-hint' }, [
        'Schick anderen Spielern Coins aus deinem Casino-Guthaben. Es wird nichts dafür verrechnet (kein XP), ' +
        'und der Empfänger bekommt es beim nächsten Öffnen der Seite gutgeschrieben — auch wenn er gerade nicht online ist.'
      ]),
      el('h4', { style: 'margin:8px 0 6px;' }, ['1 · Empfänger wählen']),
      search,
      listBox,
      el('h4', { style: 'margin:14px 0 6px;' }, ['2 · Betrag']),
      el('div', { class: 'wl-amt-row' }, [
        el('div', { class: 'wl-amt-field' }, [el('label', {}, ['Wie viele Coins?']), amtIn]),
      ]),
      quick,
      amtHint,
      el('div', { style: 'margin-top:12px;' }, [sendBtn])
    ]));

    drawBal(); drawList(); syncSend();

    // Spielerliste laden + im Takt auffrischen (Online-Status ändert sich).
    var loading = true;
    function load() {
      players().then(function (list) {
        loading = false;
        allPlayers = list;
        // gewählten Empfänger behalten, aber Namen aktualisieren
        if (sel) { var s = list.filter(function (p) { return p.pid === sel.pid; })[0]; if (s) sel = s; }
        drawList(); syncSend();
      });
    }
    load();
    var timer = setInterval(function () { drawBal(); load(); }, 8000);
    return { cleanup: function () { if (timer) clearInterval(timer); } };
  }

  /* Knopf in der oberen Leiste (Muster wie js/ideas.js). */
  function mountButton() {
    var nav = document.querySelector('.topnav');
    if (!nav || document.getElementById('wl-nav-btn')) return;
    var a = el('a', { id: 'wl-nav-btn', href: '#/send', class: 'topnav-link', title: 'Coins verschenken' }, ['💸']);
    nav.appendChild(a);
  }

  App.Wallet = {
    players: players,
    send: send,
    casinoBalance: casinoBalance,
    renderPage: renderPage
  };

  function boot() { mountButton(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
