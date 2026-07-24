/* gift.js — Coins an andere Spieler verschenken.
 *
 * Es gab bisher nur Admin->Spieler-Geschenke (Tickets/Gold). Dieses Modul erlaubt
 * echten Spieler->Spieler-Transfer: der Sender zieht den Betrag von sich ab und
 * legt ihn unter gifts/<empfaenger-geraete-id> in Firebase ab (push, atomar). Der
 * Empfänger lauscht auf seinen eigenen Knoten, schreibt sich das Geschenk gut und
 * löscht es. Wer wie viel verschenkt hat, wird lokal summiert (gj_gifted_total)
 * und per Präsenz geteilt -> Bestenliste "größte Schenker" (js/boards.js).
 *
 * Ohne Firebase (file://, Offline) ist Verschenken nicht möglich — es gibt dann
 * keine anderen Spieler zum Beschenken.
 */
(function () {
  'use strict';
  window.App = window.App || {};
  var UI = App.UI, el = UI.el;

  var KEY_TOTAL = 'gj_gifted_total';

  function fbReady() { return !!(App.Net && App.Net.firebaseConfigured && App.Net.firebaseConfigured()); }
  function myId() { return (App.Presence && App.Presence.deviceId) ? App.Presence.deviceId() : null; }
  function myName() { return (App.Leaderboard && App.Leaderboard.getPlayerName()) || 'Jemand'; }

  function total() { return Math.max(0, Number(App.Storage.get(KEY_TOTAL, 0)) || 0); }
  function addTotal(n) {
    App.Storage.set(KEY_TOTAL, total() + Math.max(0, n));
    if (App.Leaderboard) App.Leaderboard.refresh();
  }

  /** Coins an einen Empfänger (Präsenz-/Geräte-ID) schicken. */
  function send(recipientKey, amount) {
    amount = Math.floor(Number(amount) || 0);
    if (!recipientKey) return Promise.reject(new Error('Kein Empfänger gewählt.'));
    if (recipientKey === myId()) return Promise.reject(new Error('Dir selbst schenken bringt nichts 😄'));
    if (amount <= 0) return Promise.reject(new Error('Betrag muss größer als 0 sein.'));
    if (amount > App.Coins.get()) return Promise.reject(new Error('So viel hast du nicht.'));
    if (!fbReady()) return Promise.reject(new Error('Verschenken geht nur online (mit Cloud).'));
    // ERST abbuchen, DANN zustellen (wie js/wallet.js): so kann nie mehr ankommen,
    // als abgebucht wurde. Vorher wurde erst nach dem Netzwerk-Roundtrip abgebucht —
    // Tab zu im falschen Moment (oder Mehrfach-Klick) erzeugte Coins aus dem Nichts.
    App.Coins.addRaw(-amount);
    return App.Net.firebaseDb().then(function (db) {
      return db.ref('gifts/' + recipientKey).push({
        amount: amount, from: myName(), ts: Date.now()
      }).then(function () {
        addTotal(amount);
        return amount;
      });
    }).catch(function (e) {
      App.Coins.addRaw(amount);   // Zustellung fehlgeschlagen -> zurückbuchen
      throw new Error('Verschenken fehlgeschlagen — dein Geld ist wieder da.');
    });
  }

  /** Eingehende Geschenke gutschreiben (läuft dauerhaft, auf jeder Seite).
   *  Seen-Guard: schlägt das remove() fehl (offline, Regeln), würde dasselbe
   *  Geschenk sonst bei jedem Laden erneut gutgeschrieben. */
  var KEY_SEEN = 'gj_gift_seen';
  function listen() {
    if (!fbReady()) return;
    var id = myId();
    if (!id) { setTimeout(listen, 1500); return; }   // Geräte-ID evtl. noch nicht bereit
    App.Net.firebaseDb().then(function (db) {
      db.ref('gifts/' + id).on('child_added', function (snap) {
        var seen = App.Storage.get(KEY_SEEN, []) || [];
        if (seen.indexOf(snap.key) >= 0) { snap.ref.remove(); return; }
        seen.push(snap.key); if (seen.length > 80) seen = seen.slice(-80);
        App.Storage.set(KEY_SEEN, seen);
        var g = snap.val() || {};
        var amt = Math.round(Number(g.amount) || 0);
        if (amt > 0) {
          App.Coins.addRaw(amt);
          if (UI && UI.toast) UI.toast('🎁 ' + (g.from || 'Jemand') + ' schenkt dir ' + UI.formatCoins(amt) + ' ' + UI.coinIcon() + '!', 'win');
          if (App.Audio && App.Audio.sfx) App.Audio.sfx('coin');
        }
        snap.ref.remove();
      });
    }).catch(function () {});
  }

  /* ---------------- Seite ---------------- */
  function injectCss() {
    UI.injectStyle('gift-css', [
      '.gift-page{display:flex;flex-direction:column;gap:16px;max-width:640px;margin:0 auto;}',
      '.gift-total{padding:14px 16px;text-align:center;}',
      '.gift-total-v{font-size:30px;font-weight:900;color:var(--gold);font-variant-numeric:tabular-nums;text-shadow:0 0 18px rgba(255,210,63,.35);}',
      '.gift-total-l{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;font-weight:800;}',
      '.gift-box{padding:16px;display:flex;flex-direction:column;gap:12px;}',
      '.gift-recips{display:flex;flex-direction:column;gap:6px;max-height:38vh;overflow-y:auto;}',
      '.gift-recip{display:flex;align-items:center;gap:10px;padding:9px 12px;border-radius:11px;background:rgba(0,0,0,.22);border:1px solid var(--stroke);cursor:pointer;}',
      '.gift-recip.sel{border-color:var(--neon);box-shadow:0 0 12px rgba(57,255,20,.35);background:rgba(57,255,20,.08);}',
      '.gift-recip-name{font-weight:800;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.gift-recip-dot{font-size:10px;opacity:.4;}',
      '.gift-recip-dot.on{opacity:1;color:var(--neon);filter:drop-shadow(0 0 5px rgba(57,255,20,.85));}',
      '.gift-amtrow{display:flex;gap:8px;align-items:center;flex-wrap:wrap;}',
      '.gift-amtrow .text-input{flex:1 1 160px;font-size:16px;}',
      '.gift-quick{display:flex;gap:6px;flex-wrap:wrap;}',
      '.gift-quick .chip{font-weight:800;}',
      '.gift-status{min-height:18px;font-size:13px;color:var(--muted);text-align:center;}',
      '.gift-empty{opacity:.6;font-size:14px;text-align:center;padding:12px;}'
    ].join(''));
  }

  function renderPage(root) {
    injectCss();
    var page = el('div', { class: 'gift-page' });
    root.appendChild(page);

    page.appendChild(el('div', { class: 'page-head' }, [
      el('button', { class: 'btn btn-ghost back', type: 'button', onclick: function () { App.Router.go('/'); } }, ['← Menü']),
      el('h2', { class: 'page-title neon' }, ['🎁 Verschenken'])
    ]));

    page.appendChild(el('div', { class: 'glass gift-total' }, [
      el('div', { class: 'gift-total-v', id: 'gift-total-v', text: UI.formatCoins(total()) }),
      el('div', { class: 'gift-total-l' }, ['bisher verschenkt'])
    ]));

    if (!fbReady()) {
      page.appendChild(el('div', { class: 'glass gift-box' }, [
        el('div', { class: 'gift-empty' }, ['Verschenken funktioniert nur online (mit Cloud-Verbindung).'])
      ]));
      return;
    }

    var selected = null;
    var recipWrap = el('div', { class: 'gift-recips' }, [el('div', { class: 'gift-empty' }, ['Lade Spieler …'])]);
    var amtInput = el('input', { class: 'text-input', type: 'number', min: '1', placeholder: 'Betrag', inputmode: 'numeric' });
    var status = el('div', { class: 'gift-status' }, ['']);

    var quick = [100, 1000, 10000].map(function (v) {
      return el('button', { class: 'chip', type: 'button', onclick: function () { amtInput.value = v; } }, [UI.formatShort(v)]);
    });
    quick.push(el('button', { class: 'chip chip-alt', type: 'button', onclick: function () { amtInput.value = Math.floor(App.Coins.get()); } }, ['Alles']));

    var sendBtn = el('button', { class: 'btn btn-primary btn-lg btn-block', type: 'button', onclick: function () {
      status.className = 'gift-status';
      if (!selected) { status.textContent = 'Bitte zuerst einen Empfänger wählen.'; return; }
      var amt = Math.floor(Number(amtInput.value) || 0);
      sendBtn.disabled = true; status.textContent = 'Wird verschenkt …';
      send(selected.key, amt).then(function (a) {
        status.className = 'gift-status win';
        status.textContent = '✅ ' + UI.formatCoins(a) + ' an ' + selected.name + ' verschenkt!';
        amtInput.value = '';
        document.getElementById('gift-total-v').textContent = UI.formatCoins(total());
        sendBtn.disabled = false;
      }).catch(function (e) {
        status.className = 'gift-status lose';
        status.textContent = '⚠️ ' + (e && e.message ? e.message : 'Fehler');
        sendBtn.disabled = false;
      });
    } }, ['🎁 Verschenken']);

    page.appendChild(el('div', { class: 'glass gift-box' }, [
      el('div', { class: 'admin-section-l' }, ['An wen?']),
      recipWrap,
      el('div', { class: 'admin-section-l' }, ['Wie viel?']),
      el('div', { class: 'gift-amtrow' }, [amtInput]),
      el('div', { class: 'gift-quick' }, quick),
      sendBtn, status
    ]));

    function renderRecips() {
      var me = myId();
      var now = Date.now();
      var players = ((App.Leaderboard && App.Leaderboard.getPlayers && App.Leaderboard.getPlayers()) || [])
        .filter(function (p) { return p && p.key && p.key !== me && p.name && p.name !== 'Gast'; });
      // Online zuerst, dann alphabetisch.
      players.sort(function (a, b) {
        var ao = (now - (a.updatedAt || 0)) < 45000, bo = (now - (b.updatedAt || 0)) < 45000;
        if (ao !== bo) return ao ? -1 : 1;
        return String(a.name).localeCompare(String(b.name));
      });
      recipWrap.innerHTML = '';
      if (!players.length) { recipWrap.appendChild(el('div', { class: 'gift-empty' }, ['Gerade ist niemand anderes da.'])); return; }
      players.forEach(function (p) {
        var online = (now - (p.updatedAt || 0)) < 45000;
        var row = el('div', { class: 'gift-recip' + (selected && selected.key === p.key ? ' sel' : '') }, [
          el('span', { class: 'gift-recip-dot' + (online ? ' on' : '') }, ['●']),
          el('span', { class: 'gift-recip-name' }, [p.name]),
          el('span', { class: 'admin-badge', text: 'Lvl ' + (p.level || 1) })
        ]);
        row.addEventListener('click', function () {
          selected = { key: p.key, name: p.name };
          Array.prototype.forEach.call(recipWrap.children, function (c) { c.classList.remove('sel'); });
          row.classList.add('sel');
        });
        recipWrap.appendChild(row);
      });
    }

    renderRecips();
    var off = App.Leaderboard.onChange(renderRecips);
    return function () { off && off(); };
  }

  App.Gift = { send: send, total: total, renderPage: renderPage };

  function boot() { listen(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
