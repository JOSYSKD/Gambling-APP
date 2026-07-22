/* spectate.js — Live-Zuschauen: Mods und Admin sehen den aktuellen Bildschirm
 * eines Spielers.
 *
 * Echtes Pixel-Streaming gibt es hier nicht (serverlose Firebase-Seite). Statt
 * dessen veröffentlicht JEDER Client leichtgewichtig seinen aktuellen Zustand
 * (welche Seite / welches Spiel, Guthaben, Level, letzte Gewinn/Verlust-Bewegung)
 * unter spectate/<geräte-id> — gedrosselt und nur bei Änderung. Ein Zuschauer
 * abonniert diesen Knoten und sieht eine Live-Nachbildung des Spieler-Screens.
 */
(function () {
  'use strict';
  window.App = window.App || {};
  var UI = App.UI, el = UI.el;

  var THROTTLE_MS = 1800;
  var lastPublish = 0, pendingTimer = null, lastBalance = null;
  var lastDelta = 0, lastDeltaTs = 0;

  function fbReady() { return !!(App.Net && App.Net.firebaseConfigured && App.Net.firebaseConfigured()); }
  function myKey() { return (App.Presence && App.Presence.deviceId) ? App.Presence.deviceId() : null; }

  /** Aus dem aktuellen Hash einen lesbaren Bildschirm-Namen + evtl. Spiel-ID machen. */
  function screenInfo() {
    var h = (location.hash || '#/').replace(/^#/, '');
    var parts = h.split('/').filter(Boolean);   // ['game','coinflip']
    if (!parts.length) return { label: '🏠 Hauptmenü', game: null };
    var p0 = parts[0];
    if (p0 === 'game') {
      var g = App.Games && App.Games[parts[1]];
      return { label: '🎰 ' + (g ? g.title : 'Spiel'), game: parts[1] || null };
    }
    if (p0 === 'mini') return { label: '🕹 Minispiel', game: parts[1] || null };
    var MAP = {
      'category': '🎲 Spielhalle', 'minigames': '🕹 Minispiele', 'leaderboard': '🏆 Bestenliste',
      'boards': '🏆 Ranglisten', 'survival': '💀 Survival', 'stocks': '📈 Aktienmarkt',
      'cours': '🎢 COURS', 'gift': '🎁 Verschenken', 'chat': '💬 Chat', 'tournament': '🏆 Turnier',
      'profile': '👤 Profil', 'daily': '🎁 Täglicher Bonus', 'admin': '🛠 Admin', 'modpanel': '🛡 Mod-Panel'
    };
    return { label: MAP[p0] || ('· ' + p0), game: null };
  }

  function buildState() {
    var info = screenInfo();
    var recent = (Date.now() - lastDeltaTs) < 6000 ? lastDelta : 0;
    return {
      name: (App.Leaderboard && App.Leaderboard.getPlayerName()) || 'Spieler',
      level: (App.Progress && App.Progress.level) ? App.Progress.level() : 1,
      balance: (App.Coins && App.Coins.get) ? App.Coins.get() : 0,
      coin: (App.Mode && App.Mode.coinIcon) ? App.Mode.coinIcon() : '🪙',
      screen: info.label, game: info.game,
      lastDelta: recent,
      ts: Date.now()
    };
  }

  function publish(force) {
    if (!fbReady()) return;
    var now = Date.now();
    if (!force && now - lastPublish < THROTTLE_MS) {
      if (!pendingTimer) pendingTimer = setTimeout(function () { pendingTimer = null; publish(true); }, THROTTLE_MS);
      return;
    }
    lastPublish = now;
    var id = myKey();
    if (!id) return;
    App.Net.firebaseDb().then(function (db) {
      var ref = db.ref('spectate/' + id);
      ref.set(buildState());
      ref.onDisconnect().remove();
    }).catch(function () {});
  }

  /* ---------------- Zuschauer-Ansicht ---------------- */
  function injectCss() {
    UI.injectStyle('spectate-css', [
      '.spec-overlay{position:fixed;inset:0;z-index:120;background:rgba(2,8,5,.82);backdrop-filter:blur(6px);display:flex;align-items:center;justify-content:center;padding:16px;}',
      '.spec-tv{width:min(560px,96vw);border-radius:18px;overflow:hidden;border:1px solid var(--stroke-2);box-shadow:0 20px 60px rgba(0,0,0,.6);background:linear-gradient(180deg,#06170e,#03100a);}',
      '.spec-bar{display:flex;align-items:center;gap:10px;padding:12px 16px;background:rgba(0,0,0,.35);border-bottom:1px solid var(--stroke);}',
      '.spec-live{font-size:11px;font-weight:900;color:#fff;background:var(--danger-2,#ff4d6d);padding:2px 8px;border-radius:99px;box-shadow:0 0 10px rgba(255,77,109,.6);}',
      '.spec-who{font-weight:900;color:#eaffe2;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.spec-close{cursor:pointer;background:none;border:0;color:var(--muted);font-size:22px;line-height:1;}',
      '.spec-screen{padding:26px 20px;display:flex;flex-direction:column;gap:16px;align-items:center;text-align:center;min-height:210px;justify-content:center;}',
      '.spec-game{font-size:clamp(24px,7vw,36px);font-weight:900;color:var(--neon);text-shadow:0 0 20px rgba(57,255,20,.4);}',
      '.spec-stats{display:flex;gap:22px;flex-wrap:wrap;justify-content:center;}',
      '.spec-stat{display:flex;flex-direction:column;gap:2px;}',
      '.spec-stat-v{font-size:22px;font-weight:900;color:var(--gold);font-variant-numeric:tabular-nums;}',
      '.spec-stat-l{font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;font-weight:800;}',
      '.spec-delta{font-weight:900;font-size:18px;min-height:22px;}',
      '.spec-delta.up{color:var(--neon);}.spec-delta.down{color:var(--danger-2,#ff4d6d);}',
      '.spec-off{color:var(--muted);font-size:14px;}'
    ].join(''));
  }

  /** Overlay öffnen, das den Live-Screen von targetKey zeigt. */
  function watch(targetKey, targetName) {
    if (!fbReady()) { UI.toast('Zuschauen geht nur online.', 'lose'); return; }
    injectCss();
    if (App.Mods && App.Mods.log) App.Mods.log('watch', 'schaut ' + (targetName || targetKey) + ' zu');

    var gameEl = el('div', { class: 'spec-game' }, ['—']);
    var balV = el('div', { class: 'spec-stat-v' }, ['—']);
    var lvlV = el('div', { class: 'spec-stat-v' }, ['—']);
    var deltaEl = el('div', { class: 'spec-delta' }, ['']);
    var whoEl = el('div', { class: 'spec-who' }, [targetName || 'Spieler']);
    var screen = el('div', { class: 'spec-screen' }, [
      gameEl,
      el('div', { class: 'spec-stats' }, [
        el('div', { class: 'spec-stat' }, [balV, el('div', { class: 'spec-stat-l' }, ['Guthaben'])]),
        el('div', { class: 'spec-stat' }, [lvlV, el('div', { class: 'spec-stat-l' }, ['Level'])])
      ]),
      deltaEl
    ]);
    var closeBtn = el('button', { class: 'spec-close', type: 'button' }, ['✕']);
    var overlay = el('div', { class: 'spec-overlay' }, [
      el('div', { class: 'spec-tv' }, [
        el('div', { class: 'spec-bar' }, [el('span', { class: 'spec-live' }, ['● LIVE']), whoEl, closeBtn]),
        screen
      ])
    ]);
    document.body.appendChild(overlay);

    var ref = null, staleTimer = null;
    App.Net.firebaseDb().then(function (db) {
      ref = db.ref('spectate/' + targetKey);
      ref.on('value', function (snap) {
        var s = snap.val();
        if (!s) { gameEl.textContent = '💤 Nicht aktiv'; balV.textContent = '—'; lvlV.textContent = '—'; deltaEl.textContent = ''; return; }
        whoEl.textContent = s.name || targetName || 'Spieler';
        var stale = (Date.now() - (s.ts || 0)) > 30000;
        gameEl.textContent = (stale ? '💤 ' : '') + (s.screen || '—');
        balV.textContent = UI.formatShort(s.balance || 0) + ' ' + (s.coin || '🪙');
        lvlV.textContent = UI.formatShort(s.level || 1);
        var d = Number(s.lastDelta) || 0;
        deltaEl.className = 'spec-delta ' + (d > 0 ? 'up' : (d < 0 ? 'down' : ''));
        deltaEl.textContent = d ? (d > 0 ? '+' : '−') + UI.formatShort(Math.abs(d)) : '';
      });
    }).catch(function () {});

    function close() {
      if (ref) ref.off();
      if (staleTimer) clearInterval(staleTimer);
      if (overlay.parentNode) document.body.removeChild(overlay);
    }
    closeBtn.addEventListener('click', close);
    overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });
  }

  App.Spectate = { watch: watch };

  function boot() {
    if (!fbReady()) return;
    window.addEventListener('hashchange', function () { publish(true); });
    if (App.Coins && App.Coins.onChange) {
      App.Coins.onChange(function (bal) {
        if (lastBalance !== null && bal !== lastBalance) { lastDelta = bal - lastBalance; lastDeltaTs = Date.now(); }
        lastBalance = bal;
        publish(false);
      });
    }
    setInterval(function () { publish(false); }, 9000);
    publish(true);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
