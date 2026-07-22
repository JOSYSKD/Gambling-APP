/* mods.js — Moderatoren.
 *
 * Der Admin kann einzelnen Spielern die MOD-Rolle geben (admin.mod = true, gesetzt
 * im Admin-Panel). Ein Mod bekommt ein eigenes Mod-Panel (Route /modpanel) und darf
 * dort NUR zwei Dinge: an alle shouten und einzelnen Spielern live zuschauen
 * (js/spectate.js). Riggen/Geld/Bann kann ein Mod NICHT — das bleibt dem Admin.
 *
 * Jede Mod-Aktion wird protokolliert (modlog/<mod-key> in Firebase). Der Admin
 * sieht in seinem Mods-Menü (Route /admin/mods) alle Mods und pro Mod den kompletten
 * Verlauf dessen, was sie im Mod-Modus gemacht haben — und kann Mods wieder entfernen.
 */
(function () {
  'use strict';
  window.App = window.App || {};
  var UI = App.UI, el = UI.el;

  function fbReady() { return !!(App.Net && App.Net.firebaseConfigured && App.Net.firebaseConfigured()); }
  function myName() { return (App.Leaderboard && App.Leaderboard.getPlayerName()) || 'Mod'; }
  function myLogKey() {
    if (App.Account && App.Account.isLoggedIn && App.Account.isLoggedIn()) return App.Account.currentKey();
    return (App.Presence && App.Presence.deviceId) ? App.Presence.deviceId() : null;
  }

  function isAdmin() { return !!(App.Admin && App.Admin.isAdmin && App.Admin.isAdmin()); }
  function isMod() {
    if (isAdmin()) return true;
    var meta = App.Account && App.Account.adminMeta && App.Account.adminMeta();
    if (meta && meta.mod) return true;
    return !!(App.Presence && App.Presence.isMod && App.Presence.isMod());
  }

  /** Eine Mod-Aktion protokollieren (für das Admin-Mods-Menü). */
  function log(action, detail) {
    if (!fbReady()) return;
    var key = myLogKey();
    if (!key) return;
    App.Net.firebaseDb().then(function (db) {
      db.ref('modlog/' + key).push({ action: action, detail: String(detail || '').slice(0, 200), name: myName(), ts: Date.now() });
    }).catch(function () {});
  }

  function tsFmt(ts) {
    var d = new Date(Number(ts) || 0);
    return d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' }) + ' ' +
      d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  }

  function injectCss() {
    UI.injectStyle('mods-css', [
      '.mod-page{display:flex;flex-direction:column;gap:14px;max-width:680px;margin:0 auto;}',
      '.mod-note{padding:12px 16px;font-size:13px;color:var(--muted);line-height:1.5;}',
      '.mod-box{padding:16px;display:flex;flex-direction:column;gap:10px;}',
      '.mod-list{display:flex;flex-direction:column;gap:6px;max-height:44vh;overflow-y:auto;}',
      '.mod-row{display:flex;align-items:center;gap:10px;padding:9px 12px;border-radius:11px;background:rgba(0,0,0,.22);border:1px solid var(--stroke);}',
      '.mod-row .nm{font-weight:800;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.mod-dot{font-size:10px;opacity:.35;}.mod-dot.on{opacity:1;color:var(--neon);filter:drop-shadow(0 0 5px rgba(57,255,20,.85));}',
      '.mod-empty{opacity:.6;font-size:14px;text-align:center;padding:10px;}',
      '.mod-badge{font-size:11px;font-weight:900;color:#04160c;background:var(--gold);padding:2px 8px;border-radius:99px;}',
      '.mod-log{display:flex;flex-direction:column;gap:5px;margin-top:8px;padding-top:8px;border-top:1px dashed var(--stroke);}',
      '.mod-log-item{font-size:12px;color:#dfeede;}',
      '.mod-log-when{color:var(--muted);font-variant-numeric:tabular-nums;}'
    ].join(''));
  }

  /* ---------------- Mod-Panel (für Mods) ---------------- */
  function renderPanel(root) {
    injectCss();
    var page = el('div', { class: 'mod-page' });
    root.appendChild(page);

    page.appendChild(el('div', { class: 'page-head' }, [
      el('button', { class: 'btn btn-ghost back', type: 'button', onclick: function () { App.Router.go('/'); } }, ['← Menü']),
      el('h2', { class: 'page-title neon' }, ['🛡 Mod-Panel'])
    ]));

    if (!isMod()) {
      page.appendChild(el('div', { class: 'glass mod-note' }, ['Du bist kein Moderator.']));
      return;
    }

    page.appendChild(el('div', { class: 'glass mod-note' }, [
      'Als Mod kannst du an alle shouten und Spielern live zuschauen. Riggen, Geld geben oder sperren kann nur der Admin. Alles, was du hier tust, sieht der Admin in seinem Mods-Menü.'
    ]));

    // Shoutout
    var scInput = el('input', { class: 'text-input', type: 'text', maxlength: 200, placeholder: 'Nachricht an alle Spieler …' });
    var scBtn = el('button', { class: 'btn btn-primary', type: 'button', onclick: function () {
      var text = (scInput.value || '').trim();
      if (!text) return;
      if (!App.Admin || !App.Admin.broadcast) { UI.toast('Shoutout gerade nicht möglich.', 'lose'); return; }
      scBtn.disabled = true;
      App.Admin.broadcast('🛡 ' + myName() + ': ' + text).then(function (n) {
        UI.toast('📢 An ' + n + ' Spieler gesendet', 'win');
        log('shoutout', text);
        scInput.value = ''; scBtn.disabled = false;
      }).catch(function (e) { UI.toast(e.message, 'lose'); scBtn.disabled = false; });
    } }, ['📢 Senden']);
    page.appendChild(el('div', { class: 'glass mod-box' }, [
      el('span', { class: 'admin-section-l' }, ['📢 Shoutout an alle']),
      el('div', { class: 'admin-controls' }, [scInput, scBtn])
    ]));

    // Zuschauen-Liste
    var listEl = el('div', { class: 'mod-list' }, [el('div', { class: 'mod-empty' }, ['Lade Spieler …'])]);
    page.appendChild(el('div', { class: 'glass mod-box' }, [
      el('span', { class: 'admin-section-l' }, ['👁 Spieler zuschauen']),
      listEl
    ]));

    function drawList() {
      var me = (App.Presence && App.Presence.deviceId) ? App.Presence.deviceId() : null;
      var now = Date.now();
      var players = ((App.Leaderboard && App.Leaderboard.getPlayers && App.Leaderboard.getPlayers()) || [])
        .filter(function (p) { return p && p.key && p.key !== me && p.name && p.name !== 'Gast'; });
      players.sort(function (a, b) {
        var ao = (now - (a.updatedAt || 0)) < 45000, bo = (now - (b.updatedAt || 0)) < 45000;
        if (ao !== bo) return ao ? -1 : 1;
        return String(a.name).localeCompare(String(b.name));
      });
      listEl.innerHTML = '';
      if (!players.length) { listEl.appendChild(el('div', { class: 'mod-empty' }, ['Niemand da.'])); return; }
      players.forEach(function (p) {
        var online = (now - (p.updatedAt || 0)) < 45000;
        listEl.appendChild(el('div', { class: 'mod-row' }, [
          el('span', { class: 'mod-dot' + (online ? ' on' : '') }, ['●']),
          el('span', { class: 'nm' }, [p.name]),
          el('span', { class: 'admin-badge', text: 'Lvl ' + (p.level || 1) }),
          el('button', { class: 'btn btn-primary admin-rig-btn', type: 'button', onclick: function () {
            App.Spectate && App.Spectate.watch(p.key, p.name);
          } }, ['👁 Zuschauen'])
        ]));
      });
    }
    drawList();
    var off = App.Leaderboard.onChange(drawList);
    return function () { off && off(); };
  }

  /* ---------------- Mods-Menü (nur Admin) ---------------- */
  function renderAdminMenu(root) {
    injectCss();
    var page = el('div', { class: 'mod-page' });
    root.appendChild(page);

    page.appendChild(el('div', { class: 'page-head' }, [
      el('button', { class: 'btn btn-ghost back', type: 'button', onclick: function () { App.Router.go('/admin'); } }, ['← Admin']),
      el('h2', { class: 'page-title neon' }, ['🛡 Moderatoren'])
    ]));

    if (!isAdmin()) { page.appendChild(el('div', { class: 'glass mod-note' }, ['Nur für den Admin.'])); return; }

    var listEl = el('div', { class: 'mod-list' }, [el('div', { class: 'mod-empty' }, ['Lade Mods …'])]);
    page.appendChild(el('div', { class: 'glass mod-box' }, [
      el('span', { class: 'admin-section-l' }, ['Aktuelle Moderatoren']),
      listEl
    ]));

    function load() {
      App.Admin.listPlayers().then(function (rows) {
        var mods = rows.filter(function (r) { return r.admin && r.admin.mod; });
        listEl.innerHTML = '';
        if (!mods.length) { listEl.appendChild(el('div', { class: 'mod-empty' }, ['Noch keine Mods. Im Admin-Panel bei einem Spieler „Mod machen" wählen.'])); return; }
        mods.forEach(function (r) {
          var logBox = el('div', { class: 'mod-log', style: 'display:none;' }, []);
          var toggleBtn = el('button', { class: 'btn btn-ghost admin-rig-btn', type: 'button', onclick: function () {
            if (logBox.style.display === 'none') { logBox.style.display = ''; loadLog(r.key, logBox); }
            else logBox.style.display = 'none';
          } }, ['📜 Verlauf']);
          var removeBtn = el('button', { class: 'btn btn-ghost admin-rig-btn', type: 'button', onclick: function () {
            App.Admin.setMod(r.kind, r.key, false).then(function () { UI.toast(r.displayName + ' ist kein Mod mehr.', 'lose'); load(); }).catch(function (e) { UI.toast(e.message, 'lose'); });
          } }, ['✖ Entfernen']);
          var card = el('div', { style: 'padding:10px 12px;border-radius:11px;background:rgba(255,210,63,.06);border:1px solid rgba(255,210,63,.4);' }, [
            el('div', { class: 'mod-row', style: 'background:none;border:0;padding:0;' }, [
              el('span', { class: 'mod-badge' }, ['MOD']),
              el('span', { class: 'nm' }, [r.displayName]),
              toggleBtn, removeBtn
            ]),
            logBox
          ]);
          listEl.appendChild(card);
        });
      }).catch(function () {
        listEl.innerHTML = '';
        listEl.appendChild(el('div', { class: 'mod-empty' }, ['Konnte Mods nicht laden.']));
      });
    }

    function loadLog(key, box) {
      box.innerHTML = '';
      box.appendChild(el('div', { class: 'mod-log-item' }, ['Lade Verlauf …']));
      if (!fbReady()) { box.innerHTML = ''; box.appendChild(el('div', { class: 'mod-log-item' }, ['Nur online verfügbar.'])); return; }
      App.Net.firebaseDb().then(function (db) {
        db.ref('modlog/' + key).limitToLast(60).once('value', function (snap) {
          var val = snap.val() || {};
          var items = Object.keys(val).map(function (k) { return val[k]; }).sort(function (a, b) { return (b.ts || 0) - (a.ts || 0); });
          box.innerHTML = '';
          if (!items.length) { box.appendChild(el('div', { class: 'mod-log-item' }, ['Noch nichts gemacht.'])); return; }
          items.forEach(function (it) {
            var verb = it.action === 'watch' ? '👁' : (it.action === 'shoutout' ? '📢' : '•');
            box.appendChild(el('div', { class: 'mod-log-item' }, [
              el('span', { class: 'mod-log-when' }, [tsFmt(it.ts) + ' ']),
              verb + ' ' + (it.detail || it.action)
            ]));
          });
        });
      }).catch(function () { box.innerHTML = ''; box.appendChild(el('div', { class: 'mod-log-item' }, ['Fehler beim Laden.'])); });
    }

    load();
  }

  App.Mods = { isMod: isMod, isAdmin: isAdmin, log: log, renderPanel: renderPanel, renderAdminMenu: renderAdminMenu };
})();
